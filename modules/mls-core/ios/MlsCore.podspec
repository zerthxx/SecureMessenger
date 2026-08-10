Pod::Spec.new do |s|
  s.name           = 'MlsCore'
  s.version        = '1.0.0'
  s.summary        = 'E2EE crypto foundation (OpenMLS via UniFFI) — Phase 5B'
  s.description    = 'Identity/device key generation, KeyPackage generation, and encrypted local storage for the app\'s end-to-end encryption.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4',
    :tvos => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"

  # NOT YET PRESENT: the compiled Rust static library / .xcframework
  # (built via `cargo lipo` or per-target `cargo build --target
  # aarch64-apple-ios` etc., then `xcodebuild -create-xcframework`).
  # generated/mls_coreFFI.h declares symbols that only exist once that
  # artifact is added here (e.g. via `s.vendored_frameworks` or
  # `s.vendored_libraries`). This environment has no macOS/Xcode
  # toolchain to produce or link it — see the Phase 5B report. Building
  # this pod will fail with undefined symbols until a real Mac build
  # adds the missing binary and wires it in below.
  # s.vendored_frameworks = 'MlsCoreFFI.xcframework'
end
