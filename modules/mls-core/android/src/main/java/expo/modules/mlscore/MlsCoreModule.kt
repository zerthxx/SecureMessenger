package expo.modules.mlscore

import android.util.Log
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import uniffi.mls_core.DeviceCredentialInfo
import uniffi.mls_core.IdentityKeyInfo
import uniffi.mls_core.MlsCoreException
import uniffi.mls_core.addMemberToGroup
import uniffi.mls_core.createGroup
import uniffi.mls_core.decryptMessage
// TEMPORARY diagnostic import — see diagStoresState() call sites below.
import uniffi.mls_core.diagStoresState
import uniffi.mls_core.encryptMessage
import uniffi.mls_core.generateDeviceCredential
import uniffi.mls_core.generateIdentityKey
import uniffi.mls_core.generateKeyPackages
import uniffi.mls_core.initialize as mlsCoreInitialize
import uniffi.mls_core.joinGroupFromWelcome
import uniffi.mls_core.openCallSignal
import uniffi.mls_core.sealCallSignal

// TEMPORARY diagnostic instrumentation — see MasterKeyManager.kt's
// DIAG_TAG comment for full context. Same tag string (file-private
// consts can't be shared across files) so a logcat filter on this one
// tag captures both files' checkpoints in order.
//
// Audit fix: gated behind FLAG_DEBUGGABLE like MasterKeyManager.kt — this
// file doesn't log key material, but it does log per-account userId on
// every call, which has no place in a release build's logcat either.
private const val DIAG_TAG = "MlsCoreDiag"

private fun isDebugBuild(context: android.content.Context?): Boolean =
    context != null && (context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0

private fun diagLog(context: android.content.Context?, message: String) {
    if (isDebugBuild(context)) Log.d(DIAG_TAG, message)
}

private fun diagLogError(context: android.content.Context?, message: String) {
    if (isDebugBuild(context)) Log.e(DIAG_TAG, message)
}

private const val STORE_FILE_NAME = "mls_core_store.bin"

// Phase 5D: this now holds an AES-256-GCM-encrypted snapshot of the group
// database, not a live SQLite file directly — see group_storage.rs. Name
// kept without a ".sqlite" extension so it isn't mistaken for one.
private const val GROUP_STORE_FILE_NAME = "mls_core_group_state.enc"

/**
 * Phase 6 account-isolation fix: `userId` becomes part of a filesystem
 * path (see [namespacedStoragePaths]) and a Keystore alias (see
 * `MasterKeyManager`), so it's sanitized defensively even though every
 * real caller only ever passes a server-issued UUID (already made of
 * `[0-9a-f-]`) — this is a security-relevant boundary now, not just a
 * label, so it shouldn't silently trust its input's shape.
 */
internal fun sanitizeNamespace(userId: String): String {
  val cleaned = userId.filter { it.isLetterOrDigit() || it == '-' || it == '_' }
  require(cleaned.isNotEmpty()) { "userId must contain at least one alphanumeric/-/_ character" }
  return cleaned
}

/**
 * Where one account's local E2EE stores live. If neither namespaced
 * file exists yet but the *old*, pre-Phase-6 fixed-name files do,
 * renames them into this namespace — a same-filesystem `renameTo` is
 * atomic and removes the source, so this can only ever successfully
 * migrate the old shared identity into the *first* account that
 * authenticates after the update; every other account finds no old
 * files left and generates its own fresh, independent identity. See
 * the Phase 6 verification report for why this migration heuristic
 * (rather than trying to determine the "true" original owner, which
 * isn't knowable) is the correct, safe default.
 */
private fun namespacedStoragePaths(context: android.content.Context, safeUserId: String): Pair<File, File> {
  val storePath = File(context.filesDir, "$STORE_FILE_NAME.$safeUserId")
  val groupStorePath = File(context.filesDir, "$GROUP_STORE_FILE_NAME.$safeUserId")

  if (!storePath.exists() && !groupStorePath.exists()) {
    val oldStore = File(context.filesDir, STORE_FILE_NAME)
    val oldGroupStore = File(context.filesDir, GROUP_STORE_FILE_NAME)
    if (oldStore.exists() && oldGroupStore.exists()) {
      oldStore.renameTo(storePath)
      oldGroupStore.renameTo(groupStorePath)
    }
  }

  return storePath to groupStorePath
}

// Every UniFFI-generated MlsCoreException variant's `.message` getter
// returns "" (the fieldless Rust error enum carries no display string),
// so `cause.message ?: "..."` never falls back — `?:` only catches
// null, not blank. Using the variant's own class name (e.g.
// "GroupNotFound", "InvalidInput") gives real signal for diagnosing a
// thrown error instead of an empty string reaching the JS side.
class MlsCoreRuntimeError(cause: MlsCoreException) :
    CodedException("MlsCoreError", (cause.message ?: "").ifBlank { cause::class.simpleName ?: "mls-core operation failed" }, cause)

/**
 * Expo native module surface for the app's E2EE crypto foundation.
 * Phase 5B: identity/device key generation, KeyPackage generation.
 * Phase 5C: persistent MLS group creation/join and application-message
 * encrypt/decrypt — the smallest secure device-to-device proof. Phase 5D:
 * security hardening only (encrypted-at-rest group storage, StrongBox
 * Keystore key) — no new surface added here. See modules/mls-core/rust
 * for the full scope boundary (still no group UI, media, voice, push —
 * this is exactly the proof surface, nothing more).
 * Every method here returns only public keys/signatures/ciphertext/
 * plaintext the caller itself just supplied or decrypted for its own
 * use — never a private key.
 */
class MlsCoreModule : Module() {
  // Which account's namespace is currently open — not a boolean. A
  // mobile app process routinely outlives a single logged-in account
  // (sign-out/sign-in, switching accounts, does not restart the OS
  // process), so "have we ever initialized" is the wrong question; the
  // right one is "is the account we're about to act on the one that's
  // actually open right now". See the Phase 6 account-isolation fix
  // report — this mirrors the same fix in lib.rs's `STORES`.
  private var initializedForUserId: String? = null

  override fun definition() = ModuleDefinition {
    Name("MlsCore")

    AsyncFunction("initialize") { userId: String ->
      val safeUserId = sanitizeNamespace(userId)
      // TEMPORARY diagnostic instrumentation — see MasterKeyManager.kt's
      // DIAG_TAG comment. instanceId/threadId let a future logcat capture
      // prove or rule out "different instance"/"different thread" theories
      // directly, rather than relying on code-level reasoning about Expo
      // Modules' AsyncFunction dispatch (which is proven single-threaded
      // per module in expo-modules-core's own source, but this makes that
      // provable from real device output too, not just source reading).
      val instanceId = System.identityHashCode(this@MlsCoreModule)
      val threadId = Thread.currentThread().id
      val diagContext = appContext.reactContext
      diagLog(
        diagContext,
        "initialize-start userId=$safeUserId instanceId=$instanceId threadId=$threadId cachedFlag=$initializedForUserId",
      )
      if (initializedForUserId != safeUserId) {
        val context = appContext.reactContext
          ?: throw CodedException("MlsCoreError", "No Android context available", null)

        // `getOrCreateMasterKey` and `namespacedStoragePaths` used to run
        // outside this try/catch, so any failure there (Android Keystore/
        // StrongBox errors are the concrete case — some OEM devices throw
        // exceptions other than the documented StrongBoxUnavailableException
        // from key generation/wrap/unwrap) propagated as a raw, uncaught
        // exception instead of a well-formed rejection, and — critically —
        // left `initializedForUserId` unset either way, so that specific
        // failure mode was always safe against a *false* "initialized"
        // state. This change doesn't alter that safety; it only makes the
        // resulting JS-visible error clear and consistently shaped instead
        // of whatever the platform exception's default formatting happens
        // to be.
        try {
          val masterKey = MasterKeyManager.getOrCreateMasterKey(context, safeUserId)
          val (storeFile, groupStoreFile) = namespacedStoragePaths(context, safeUserId)
          diagLog(
            diagContext,
            "storage-open-start userId=$safeUserId storeFile=${storeFile.absolutePath} storeFileExists=${storeFile.exists()} " +
              "groupStoreFile=${groupStoreFile.absolutePath} groupStoreFileExists=${groupStoreFile.exists()} instanceId=$instanceId",
          )
          mlsCoreInitialize(safeUserId, storeFile.absolutePath, groupStoreFile.absolutePath, masterKey)
          diagLog(diagContext, "storage-open-success userId=$safeUserId instanceId=$instanceId")
          // TEMPORARY diagnostic — reads STORES's own address/state
          // directly from Rust, immediately after initialize() returned
          // Ok. Compare diag-after-initialize's storesAddress against
          // diag-before-generateIdentityKey's below: if they differ,
          // that's direct proof the two calls aren't sharing one loaded
          // copy of this library's global state.
          val diagAfterInit = diagStoresState()
          diagLog(
            diagContext,
            "diag-after-initialize userId=$safeUserId storesAddress=0x${diagAfterInit.storesAddress.toString(16)} " +
              "isSome=${diagAfterInit.isSome} instanceId=$instanceId",
          )
          initializedForUserId = safeUserId
        } catch (e: MlsCoreException) {
          diagLogError(diagContext, "storage-open-failure userId=$safeUserId instanceId=$instanceId type=MlsCoreException variant=${e::class.simpleName}")
          throw MlsCoreRuntimeError(e)
        } catch (e: Exception) {
          diagLogError(diagContext, "storage-open-failure userId=$safeUserId instanceId=$instanceId type=${e::class.qualifiedName} message=${e.message}")
          throw CodedException(
            "MlsCoreError",
            "Failed to prepare local encrypted storage: ${(e.message ?: e::class.simpleName ?: "unknown error")}",
            e,
          )
        }
      } else {
        diagLog(diagContext, "initialize-skip-already-cached userId=$safeUserId instanceId=$instanceId")
      }
      diagLog(diagContext, "initialize-resolved userId=$safeUserId cachedFlagNow=$initializedForUserId instanceId=$instanceId")
      null
    }

    AsyncFunction("generateIdentityKey") {
      val instanceId = System.identityHashCode(this@MlsCoreModule)
      val threadId = Thread.currentThread().id
      val diagContext = appContext.reactContext
      diagLog(diagContext, "generateIdentityKey-start instanceId=$instanceId threadId=$threadId cachedFlag=$initializedForUserId")
      // TEMPORARY diagnostic — same probe as diag-after-initialize, but
      // read immediately before the real generateIdentityKey() call.
      // This is the decisive comparison: same address+isSome=true here
      // as diag-after-initialize reported → the duplicate-library
      // hypothesis is disproven, investigate Rust state mutation
      // instead. Different address, or same address but isSome=false →
      // duplicate-library/state-loss hypothesis is proven.
      val diagBeforeGenerate = diagStoresState()
      diagLog(
        diagContext,
        "diag-before-generateIdentityKey storesAddress=0x${diagBeforeGenerate.storesAddress.toString(16)} " +
          "isSome=${diagBeforeGenerate.isSome} instanceId=$instanceId",
      )
      requireInitialized()
      try {
        val info: IdentityKeyInfo = generateIdentityKey()
        diagLog(diagContext, "generateIdentityKey-success instanceId=$instanceId")
        mapOf("publicKey" to info.publicKey)
      } catch (e: MlsCoreException) {
        diagLogError(diagContext, "generateIdentityKey-failure instanceId=$instanceId variant=${e::class.simpleName}")
        throw MlsCoreRuntimeError(e)
      }
    }

    AsyncFunction("generateDeviceCredential") {
      requireInitialized()
      try {
        val info: DeviceCredentialInfo = generateDeviceCredential()
        mapOf(
          "credentialPublicKey" to info.credentialPublicKey,
          "crossSignature" to info.crossSignature,
        )
      } catch (e: MlsCoreException) {
        throw MlsCoreRuntimeError(e)
      }
    }

    AsyncFunction("generateKeyPackages") { count: Int ->
      requireInitialized()
      try {
        generateKeyPackages(count.toUInt())
      } catch (e: MlsCoreException) {
        throw MlsCoreRuntimeError(e)
      }
    }

    AsyncFunction("createGroup") { groupId: ByteArray ->
      requireInitialized()
      try {
        createGroup(groupId)
        null
      } catch (e: MlsCoreException) {
        throw MlsCoreRuntimeError(e)
      }
    }

    AsyncFunction("addMemberToGroup") { groupId: ByteArray, keyPackageBytes: ByteArray ->
      requireInitialized()
      try {
        addMemberToGroup(groupId, keyPackageBytes)
      } catch (e: MlsCoreException) {
        throw MlsCoreRuntimeError(e)
      }
    }

    AsyncFunction("joinGroupFromWelcome") { welcomeBytes: ByteArray ->
      requireInitialized()
      try {
        joinGroupFromWelcome(welcomeBytes)
      } catch (e: MlsCoreException) {
        throw MlsCoreRuntimeError(e)
      }
    }

    AsyncFunction("encryptMessage") { groupId: ByteArray, plaintext: String ->
      requireInitialized()
      try {
        encryptMessage(groupId, plaintext)
      } catch (e: MlsCoreException) {
        throw MlsCoreRuntimeError(e)
      }
    }

    AsyncFunction("decryptMessage") { groupId: ByteArray, ciphertext: ByteArray ->
      requireInitialized()
      try {
        decryptMessage(groupId, ciphertext)
      } catch (e: MlsCoreException) {
        throw MlsCoreRuntimeError(e)
      }
    }

    // Call signaling (SDP, ICE candidates), sealed with a key derived from the
    // conversation's MLS group — read-only on group state; see call_signal.rs.
    AsyncFunction("sealCallSignal") { groupId: ByteArray, callId: String, plaintext: String ->
      requireInitialized()
      try {
        sealCallSignal(groupId, callId, plaintext)
      } catch (e: MlsCoreException) {
        throw MlsCoreRuntimeError(e)
      }
    }

    AsyncFunction("openCallSignal") { groupId: ByteArray, callId: String, sealed: ByteArray ->
      requireInitialized()
      try {
        openCallSignal(groupId, callId, sealed)
      } catch (e: MlsCoreException) {
        throw MlsCoreRuntimeError(e)
      }
    }
  }

  private fun requireInitialized() {
    if (initializedForUserId == null) {
      throw CodedException("MlsCoreError", "MlsCore.initialize() must be called first", null)
    }
  }
}
