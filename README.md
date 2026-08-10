# Secure Messenger

Phase 0 scaffold: Expo + React Native + TypeScript, Expo Router, Development
Build (not Expo Go). See `src/ARCHITECTURE.md` for the layer boundaries.

## Requirements

- Node 20+
- Android SDK (platform 36, build-tools 36.0.0, NDK 27.1.12297006) —
  `ANDROID_HOME` must point at it.
- **JDK 17**, not newer. The Android Gradle Plugin's native CMake configure
  step fails on JDK 22+ ("A restricted method in java.lang.System has been
  called") — this is a known AGP/JDK incompatibility, not a project bug.
  `JAVA_HOME` must point at a JDK 17 install when running Gradle directly.

## Commands

- `npm run start` — Metro for a Development Build (not Expo Go)
- `npm run android` — build + install + launch on a connected device/emulator
- `npm run prebuild` — regenerate `android/` (gitignored — do not hand-edit)
- `npm run typecheck` — `tsc --noEmit`
- `npm run doctor` — `expo-doctor` config sanity check

## Status

Phase 0 (this scaffold) only: architecture + mock-data-ready structure, no
UI, no auth, no backend, no encryption. Verified: `tsc --noEmit`,
`expo-doctor` (20/20), `expo prebuild --platform android`, and a real
`gradlew assembleDebug` (BUILD SUCCESSFUL).
