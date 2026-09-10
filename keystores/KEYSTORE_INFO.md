# Production signing key — NEW KEY, generated 2026-08-12

**This is a brand-new production signing keystore.** The original production keystore
used for v0.1.0–v0.4.0 (published to GitHub Releases and referenced by
`server/src/config/updateManifest.ts`) was confirmed unrecoverable. All builds from
v0.5.0 onward are signed with this new key instead.

## Consequence: no in-place update from the old production APK

Android refuses to install an "update" whose APK is signed with a different
certificate than the one already installed. Any device that has a pre-v0.5.0
production APK installed (signed with the lost key) **cannot** upgrade in place to
an APK signed with this new key — Android's package installer will reject it with
`INSTALL_FAILED_UPDATE_INCOMPATIBLE`. Those users must uninstall the old app (losing
local-only app data — see `allowBackup: false` in `app.json`) and install the new
APK as a fresh install. The migration/reinstall messaging for existing users is
being handled separately, per instruction — this file only documents the key change
itself.

Devices that already have a debug-keystore or dev-client build installed are
unaffected by this note (different signing lineage already).

## Key material

| Field | Value |
|---|---|
| File | `keystores/secure-messenger-release.keystore` (PKCS12, gitignored, **not** in git) |
| Alias | `secure-messenger-release` |
| Algorithm | RSA 2048, SHA384withRSA |
| Validity | 10000 days from 2026-08-12 (until ~2053-12-28) |
| Certificate SHA-256 | `4F:90:8D:90:7A:F1:B5:F0:66:0B:88:2D:2E:77:EA:1E:86:A3:D6:31:64:BE:1F:45:13:9A:11:FC:00:CA:B5:98` |
| Certificate SHA-1 | `75:40:3F:7F:1D:FB:5C:CA:F9:86:9A:BD:15:08:42:3C:10:6A:98:81` |
| DN | `CN=Secure Messenger, OU=Engineering, O=zerthxx, L=Unknown, ST=Unknown, C=US` |

`storePassword` / `keyPassword` (PKCS12 requires them to match) live only in
`keystores/keystore.properties`, which is gitignored alongside the `.keystore` file
itself (see root `.gitignore`: `*.keystore`, `keystore.properties`).

## Back this up now

This exact scenario — an unrecoverable production keystore — is why this file exists.
Copy `keystores/secure-messenger-release.keystore` and `keystores/keystore.properties`
to at least one durable, offline location (password manager attachment, encrypted
external drive, etc.) before relying on this key for any published release. Losing
this file means repeating this entire migration again.

## How the build uses it

`android/app/build.gradle` loads `keystores/keystore.properties` (relative to the
project root, outside the gitignored/regenerated `android/` folder) and wires it as
the `release` signing config, falling back to the debug key only if that properties
file is absent. See the comment block above `signingConfigs` in that file.
