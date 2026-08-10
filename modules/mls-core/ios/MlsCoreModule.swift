import ExpoModulesCore

private let storeFileName = "mls_core_store.bin"

/// Expo native module surface for the E2EE crypto foundation (Phase
/// 5B) — mirrors android/.../MlsCoreModule.kt exactly, calling the same
/// UniFFI-generated interface (see ios/generated/mls_core.swift, real
/// output from `uniffi-bindgen generate --language swift` against the
/// compiled Rust library, not hand-written FFI glue).
///
/// NOTE: this file has not been compiled or run. No Xcode/macOS
/// toolchain is available in this environment — see the Phase 5B report
/// for exactly what was and wasn't verified on this platform.
public class MlsCoreModule: Module {
  private var initialized = false

  public func definition() -> ModuleDefinition {
    Name("MlsCore")

    AsyncFunction("initialize") {
      if self.initialized { return }

      let masterKey = try MasterKeyManager.getOrCreateMasterKey()
      let storeDir = try FileManager.default.url(
        for: .applicationSupportDirectory,
        in: .userDomainMask,
        appropriateFor: nil,
        create: true
      )
      let storePath = storeDir.appendingPathComponent(storeFileName).path

      try initialize(storagePath: storePath, masterKey: masterKey)
      self.initialized = true
    }

    AsyncFunction("generateIdentityKey") { () -> [String: Data] in
      try self.requireInitialized()
      let info = try generateIdentityKey()
      return ["publicKey": info.publicKey]
    }

    AsyncFunction("generateDeviceCredential") { () -> [String: Data] in
      try self.requireInitialized()
      let info = try generateDeviceCredential()
      return [
        "credentialPublicKey": info.credentialPublicKey,
        "crossSignature": info.crossSignature,
      ]
    }

    AsyncFunction("generateKeyPackages") { (count: Int) -> [Data] in
      try self.requireInitialized()
      return try generateKeyPackages(count: UInt32(count))
    }
  }

  private func requireInitialized() throws {
    if !initialized {
      throw NSError(
        domain: "MlsCore",
        code: -1,
        userInfo: [NSLocalizedDescriptionKey: "MlsCore.initialize() must be called first"]
      )
    }
  }
}
