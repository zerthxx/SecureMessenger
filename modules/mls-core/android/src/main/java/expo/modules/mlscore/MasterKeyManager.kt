package expo.modules.mlscore

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import java.io.File
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.spec.GCMParameterSpec

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

        if (file.exists()) {
            val wrappingKey = getOrCreateWrappingKey(alias)
            return unwrap(wrappingKey, file.readBytes())
        }

        val oldFile = File(context.filesDir, WRAPPED_FILE_NAME)
        val oldWrappingKey = if (oldFile.exists()) getWrappingKeyIfExists(KEYSTORE_ALIAS) else null
        if (oldWrappingKey != null) {
            val masterKey = unwrap(oldWrappingKey, oldFile.readBytes())
            val wrappingKey = getOrCreateWrappingKey(alias)
            file.writeBytes(wrap(wrappingKey, masterKey))
            oldFile.delete()
            return masterKey
        }

        val masterKey = ByteArray(MASTER_KEY_LENGTH_BYTES)
        SecureRandom().nextBytes(masterKey)

        val wrappingKey = getOrCreateWrappingKey(alias)
        file.writeBytes(wrap(wrappingKey, masterKey))
        return masterKey
    }

    private fun getWrappingKeyIfExists(alias: String): javax.crypto.SecretKey? {
        val keyStore = KeyStore.getInstance("AndroidKeyStore")
        keyStore.load(null)
        return keyStore.getKey(alias, null) as? javax.crypto.SecretKey
    }

    private fun getOrCreateWrappingKey(alias: String): javax.crypto.SecretKey {
        getWrappingKeyIfExists(alias)?.let { return it }

        // StrongBox (a separate, tamper-resistant secure element, not
        // just the TEE) is only an API surface from Android 9 (API 28)
        // onward — guard rather than reference the flag/exception type on
        // older OS versions.
        val preferStrongBox = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
        return generateWrappingKey(alias, strongBoxBacked = preferStrongBox)
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
    private fun generateWrappingKey(alias: String, strongBoxBacked: Boolean): javax.crypto.SecretKey {
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
            generator.generateKey()
        } catch (e: StrongBoxUnavailableException) {
            generateWrappingKey(alias, strongBoxBacked = false)
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
