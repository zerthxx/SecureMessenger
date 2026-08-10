import CryptoKit
import Foundation
import Security

/// Envelope encryption for the 32-byte master key mls-core uses to
/// encrypt its local E2EE store — mirrors android/.../MasterKeyManager.kt.
///
/// iOS Keychain items backed by the Secure Enclave (`kSecAttrTokenID`)
/// can't be exported as raw bytes either, so the same pattern applies: a
/// random 32-byte value is generated once, wrapped with a
/// Keychain-resident AES-256-GCM key (via CryptoKit's `SymmetricKey`
/// stored as a `kSecClassKey` Keychain item), and only the wrapped bytes
/// touch disk. Unwrapped bytes live only in process memory.
///
/// NOTE: written to match the Android implementation's design and the
/// real, verified Swift bindings UniFFI generated from the compiled
/// Rust library — but this file has not been compiled or run. No
/// Xcode/macOS toolchain is available in this environment. See the
/// Phase 5B report for exactly what was and wasn't verified.
enum MasterKeyManager {
    private static let keychainKeyTag = "com.securemessenger.app.mlscore.wrappingkey"
    private static let wrappedFileName = "mls_core_wrapped_master_key.bin"
    private static let masterKeyLength = 32

    static func getOrCreateMasterKey() throws -> Data {
        let wrappingKey = try getOrCreateWrappingKey()
        let fileURL = try storeDirectory().appendingPathComponent(wrappedFileName)

        if FileManager.default.fileExists(atPath: fileURL.path) {
            let blob = try Data(contentsOf: fileURL)
            return try unwrap(wrappingKey: wrappingKey, blob: blob)
        }

        var masterKey = Data(count: masterKeyLength)
        let result = masterKey.withUnsafeMutableBytes {
            SecRandomCopyBytes(kSecRandomDefault, masterKeyLength, $0.baseAddress!)
        }
        guard result == errSecSuccess else {
            throw NSError(domain: "MlsCore", code: -1, userInfo: [NSLocalizedDescriptionKey: "SecRandomCopyBytes failed"])
        }

        let blob = try wrap(wrappingKey: wrappingKey, plaintext: masterKey)
        try blob.write(to: fileURL, options: .atomic)
        return masterKey
    }

    private static func storeDirectory() throws -> URL {
        try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
    }

    private static func getOrCreateWrappingKey() throws -> SymmetricKey {
        if let existing = try readWrappingKeyFromKeychain() {
            return existing
        }
        let key = SymmetricKey(size: .bits256)
        try storeWrappingKeyInKeychain(key)
        return key
    }

    private static func readWrappingKeyFromKeychain() throws -> SymmetricKey? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: keychainKeyTag,
            kSecReturnData as String: true,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess, let data = item as? Data else {
            throw NSError(domain: "MlsCore", code: Int(status), userInfo: nil)
        }
        return SymmetricKey(data: data)
    }

    private static func storeWrappingKeyInKeychain(_ key: SymmetricKey) throws {
        let keyData = key.withUnsafeBytes { Data($0) }
        let query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: keychainKeyTag,
            kSecValueData as String: keyData,
            // Device-only, and only after first unlock — consistent with
            // the "no biometric gate on ordinary background launch"
            // stance in the Android implementation's comment.
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw NSError(domain: "MlsCore", code: Int(status), userInfo: nil)
        }
    }

    private static func wrap(wrappingKey: SymmetricKey, plaintext: Data) throws -> Data {
        let sealed = try AES.GCM.seal(plaintext, using: wrappingKey)
        guard let combined = sealed.combined else {
            throw NSError(domain: "MlsCore", code: -1, userInfo: [NSLocalizedDescriptionKey: "AES-GCM seal produced no combined representation"])
        }
        return combined
    }

    private static func unwrap(wrappingKey: SymmetricKey, blob: Data) throws -> Data {
        let sealedBox = try AES.GCM.SealedBox(combined: blob)
        return try AES.GCM.open(sealedBox, using: wrappingKey)
    }
}
