package expo.modules.mlscore

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
import uniffi.mls_core.encryptMessage
import uniffi.mls_core.generateDeviceCredential
import uniffi.mls_core.generateIdentityKey
import uniffi.mls_core.generateKeyPackages
import uniffi.mls_core.initialize as mlsCoreInitialize
import uniffi.mls_core.joinGroupFromWelcome

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
      if (initializedForUserId != safeUserId) {
        val context = appContext.reactContext
          ?: throw CodedException("MlsCoreError", "No Android context available", null)

        val masterKey = MasterKeyManager.getOrCreateMasterKey(context, safeUserId)
        val (storeFile, groupStoreFile) = namespacedStoragePaths(context, safeUserId)

        try {
          mlsCoreInitialize(safeUserId, storeFile.absolutePath, groupStoreFile.absolutePath, masterKey)
          initializedForUserId = safeUserId
        } catch (e: MlsCoreException) {
          throw MlsCoreRuntimeError(e)
        }
      }
      null
    }

    AsyncFunction("generateIdentityKey") {
      requireInitialized()
      try {
        val info: IdentityKeyInfo = generateIdentityKey()
        mapOf("publicKey" to info.publicKey)
      } catch (e: MlsCoreException) {
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
  }

  private fun requireInitialized() {
    if (initializedForUserId == null) {
      throw CodedException("MlsCoreError", "MlsCore.initialize() must be called first", null)
    }
  }
}
