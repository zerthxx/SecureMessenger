package expo.modules.mlscore

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Log
import java.io.File
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.spec.GCMParameterSpec

// TEMPORARY diagnostic instrumentation — added to trace the exact
// Honor-device-only "StorageNotInitialized" failure reported after the
// ensureE2eeSetup reentrancy fix did not resolve it there (the emulator,
// which has no real StrongBox hardware, does not reproduce this). Never
// logs key bytes or any derived secret material — only booleans, file
// existence, exception types, and a non-reversible Arrays.hashCode()
// checksum of the master key (to detect "this call returned a DIFFERENT
// key than expected" without ever exposing the key itself). Remove once
// the root cause is confirmed from real device logcat output.
//
// Audit fix: this previously logged unconditionally, including in
// release builds — a checksum of the literal master key plus the app's
// private filesDir path and device manufacturer/model landing in logcat
// on every real user's device, readable via `adb logcat` (USB
// debugging) or by any app holding READ_LOGS on affected OEMs. Gated
// behind FLAG_DEBUGGABLE (false for any release-signed build) so it
// keeps working for on-device Honor debugging but can never ship.
private const val DIAG_TAG = "MlsCoreDiag"

private fun isDebugBuild(context: Context): Boolean =
    (context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0

private fun diagLog(context: Context, message: String) {
    if (isDebugBuild(context)) Log.d(DIAG_TAG, message)
}

private fun diagWarn(context: Context, message: String) {
    if (isDebugBuild(context)) Log.w(DIAG_TAG, message)
}

private fun diagLogError(context: Context, message: String) {
    if (isDebugBuild(context)) Log.e(DIAG_TAG, message)
}

/**
 * Envelope encryption for the 32-byte master key mls-core uses to
 * encrypt its local E2EE store — see rust/src/storage.rs module docs.
 *
 * Android Keystore keys cannot be exported as raw bytes (by design, and
 * more strongly enforced when hardware-backed), but the Rust AEAD layer
 * needs actual key bytes. So: a random 32-byte value is generated once
 * with `SecureRandom`, wrapped (encrypted) by a Keystore-resident
 * AES-256-GCM key that never leaves the Keystore, and the wrapped bytes
 * are the only thing written to disk. On every launch the wrapped bytes
 * are unwrapped via the Keystore key and the raw 32 bytes are held only
 * in process memory for the life of the process — the same pattern
 * EncryptedSharedPreferences/expo-secure-store use under the hood, not
 * a custom construction.
 */
internal object MasterKeyManager {
    private const val KEYSTORE_ALIAS = "mls_core_wrapping_key"
    private const val WRAPPED_FILE_NAME = "mls_core_wrapped_master_key.bin"
    private const val GCM_TAG_LENGTH_BITS = 128
    private const val IV_LENGTH_BYTES = 12
    private const val MASTER_KEY_LENGTH_BYTES = 32

    /**
     * Phase 6 account-isolation fix: the wrapping key alias and wrapped
     * blob are now namespaced per account (`namespace` is the same
     * sanitized value `MlsCoreModule.namespacedStoragePaths` uses) —
     * previously both were fixed per-install constants, so a second
     * account authenticating on the same install silently unwrapped and
     * reused the first account's master key (and therefore every key it
     * protects). See the Phase 6 verification report.
     *
     * Migration: if this namespace's own wrapped file doesn't exist yet
     * but the old, pre-Phase-6 fixed-name wrapped file (and its
     * Keystore-resident wrapping key) do, this is the first account to
     * authenticate after the update — unwrap the pre-existing master key
     * once via the old alias, re-wrap the *same bytes* under this
     * namespace's own new alias, and delete the old wrapped file so it
     * can never be claimed by (and never appear available to) any other
     * account afterward. Any other account finds no old file left and
     * falls through to generating a fresh, independent master key.
     */
    fun getOrCreateMasterKey(context: Context, namespace: String): ByteArray {
        val file = File(context.filesDir, "$WRAPPED_FILE_NAME.$namespace")
        val alias = "$KEYSTORE_ALIAS.$namespace"
        diagLog(
            context,
            "getOrCreateMasterKey-start namespace=$namespace filesDir=${context.filesDir.absolutePath} " +
                "wrappedFile=${file.absolutePath} wrappedFileExists=${file.exists()} wrappedFileLength=${if (file.exists()) file.length() else -1}",
        )

        if (file.exists()) {
            val wrappingKey = getOrCreateWrappingKey(context, alias)
            val result = try {
                unwrap(wrappingKey, file.readBytes())
            } catch (e: Exception) {
                diagLogError(context, "getOrCreateMasterKey unwrap-failure namespace=$namespace exceptionType=${e::class.qualifiedName} message=${e.message}")
                throw e
            }
            diagLog(context, "getOrCreateMasterKey unwrap-success namespace=$namespace masterKeyLen=${result.size} masterKeyChecksum=${result.contentHashCode()}")
            return result
        }

        val oldFile = File(context.filesDir, WRAPPED_FILE_NAME)
        val oldWrappingKey = if (oldFile.exists()) getWrappingKeyIfExists(KEYSTORE_ALIAS) else null
        if (oldWrappingKey != null) {
            diagLog(context, "getOrCreateMasterKey migrating-old-key namespace=$namespace")
            val masterKey = unwrap(oldWrappingKey, oldFile.readBytes())
            val wrappingKey = getOrCreateWrappingKey(context, alias)
            file.writeBytes(wrap(wrappingKey, masterKey))
            oldFile.delete()
            diagLog(context, "getOrCreateMasterKey migration-complete namespace=$namespace masterKeyChecksum=${masterKey.contentHashCode()}")
            return masterKey
        }

        diagLog(context, "getOrCreateMasterKey generating-fresh-key namespace=$namespace (no wrapped file found for this namespace or the legacy pre-namespaced one)")
        val masterKey = ByteArray(MASTER_KEY_LENGTH_BYTES)
        SecureRandom().nextBytes(masterKey)

        val wrappingKey = getOrCreateWrappingKey(context, alias)
        file.writeBytes(wrap(wrappingKey, masterKey))
        diagLog(context, "getOrCreateMasterKey fresh-key-persisted namespace=$namespace masterKeyChecksum=${masterKey.contentHashCode()} wroteBytes=${file.length()}")
        return masterKey
    }

    private fun getWrappingKeyIfExists(alias: String): javax.crypto.SecretKey? {
        val keyStore = KeyStore.getInstance("AndroidKeyStore")
        keyStore.load(null)
        return keyStore.getKey(alias, null) as? javax.crypto.SecretKey
    }

    private fun getOrCreateWrappingKey(context: Context, alias: String): javax.crypto.SecretKey {
        getWrappingKeyIfExists(alias)?.let {
            diagLog(context, "getOrCreateWrappingKey found-existing alias=$alias sdkInt=${Build.VERSION.SDK_INT} manufacturer=${Build.MANUFACTURER} model=${Build.MODEL}")
            return it
        }

        // StrongBox (a separate, tamper-resistant secure element, not
        // just the TEE) is only an API surface from Android 9 (API 28)
        // onward — guard rather than reference the flag/exception type on
        // older OS versions.
        val preferStrongBox = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
        diagLog(context, "getOrCreateWrappingKey generating-new alias=$alias preferStrongBox=$preferStrongBox sdkInt=${Build.VERSION.SDK_INT} manufacturer=${Build.MANUFACTURER} model=${Build.MODEL}")
        return generateWrappingKey(context, alias, strongBoxBacked = preferStrongBox)
    }

    /**
     * Generates the Keystore-resident wrapping key, preferring a
     * StrongBox-backed key (a separate, tamper-resistant secure element
     * on supporting devices, rather than just the TEE) when available.
     * Not every device with API 28+ has StrongBox hardware —
     * `StrongBoxUnavailableException` is the documented way the platform
     * signals that, so on that specific failure this falls back to a
     * normal (TEE-backed, still hardware-isolated) Keystore key rather
     * than failing E2EE setup entirely.
     */
    private fun generateWrappingKey(context: Context, alias: String, strongBoxBacked: Boolean): javax.crypto.SecretKey {
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        val specBuilder = KeyGenParameterSpec.Builder(
            alias,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            // Not gated on biometric/device-credential auth: this key
            // wraps a local storage key, not a user-facing secret like a
            // password, and the app needs to reach it on ordinary
            // background app-launch, not only while unlocked by biometrics.
            .setUserAuthenticationRequired(false)

        if (strongBoxBacked) {
            specBuilder.setIsStrongBoxBacked(true)
        }

        return try {
            generator.init(specBuilder.build())
            val key = generator.generateKey()
            diagLog(context, "generateWrappingKey success alias=$alias strongBoxBacked=$strongBoxBacked")
            key
        } catch (e: StrongBoxUnavailableException) {
            diagWarn(context, "generateWrappingKey StrongBoxUnavailableException alias=$alias — falling back to non-StrongBox, message=${e.message}")
            generateWrappingKey(context, alias, strongBoxBacked = false)
        } catch (e: Exception) {
            // Diagnostic-only: every other exception type is rethrown
            // unchanged (no behavior change) — this just makes sure the
            // exact exception class reaches logcat before that happens,
            // since only StrongBoxUnavailableException gets a fallback
            // today and anything else (a real possibility on some Honor
            // StrongBox HAL implementations, which are documented to throw
            // undocumented exception types beyond the one Android's own
            // API contract promises) would otherwise surface only as a
            // generic rejected-promise message with no native-side trace.
            diagLogError(context, "generateWrappingKey UNEXPECTED exceptionType=${e::class.qualifiedName} alias=$alias strongBoxBacked=$strongBoxBacked message=${e.message}")
            throw e
        }
    }

    private fun wrap(wrappingKey: javax.crypto.SecretKey, plaintext: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, wrappingKey)
        val iv = cipher.iv
        val ciphertext = cipher.doFinal(plaintext)
        return iv + ciphertext
    }

    private fun unwrap(wrappingKey: javax.crypto.SecretKey, blob: ByteArray): ByteArray {
        val iv = blob.copyOfRange(0, IV_LENGTH_BYTES)
        val ciphertext = blob.copyOfRange(IV_LENGTH_BYTES, blob.size)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, wrappingKey, GCMParameterSpec(GCM_TAG_LENGTH_BITS, iv))
        return cipher.doFinal(ciphertext)
    }
}
