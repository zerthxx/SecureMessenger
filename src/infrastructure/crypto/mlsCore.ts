// The one file in `src/` that imports the mls-core native module by
// relative path — it isn't an npm package (no package.json, autolinked
// purely by living under `./modules`, see modules/mls-core/expo-module.config.json),
// so there's no `@mls-core/*`-style alias for it. Every other file
// reaches the native E2EE module only through this wrapper.
//
// Trust boundary reminder (unchanged since Phase 5B/5C): every method
// below returns only public keys, signatures, KeyPackage bytes, Welcome
// bytes, ciphertext, or plaintext the caller itself just supplied or
// decrypted for its own use. Private key material never crosses this
// boundary into JavaScript — see modules/mls-core/rust's module docs.
import MlsCoreModuleNative from '../../../modules/mls-core/src/MlsCoreModule';
import type { DeviceCredentialInfo, IdentityKeyInfo } from '../../../modules/mls-core/src/MlsCore.types';

// Tracks *which account's* stores are open, not just whether initialize()
// has ever run — a signed-in session can switch accounts (sign out, sign
// back in as someone else) without the JS engine restarting, and a plain
// boolean here would silently skip re-initializing for the new account,
// leaving it operating on the previous account's native E2EE identity.
// See the Phase 6 account-isolation fix report.
let initializedForUserId: string | null = null;

/**
 * Idempotent for the same account — a call for the account that's
 * already open is a no-op. `userId` must be the authenticated account's
 * own stable id, not the per-login device id (which is minted fresh on
 * every login and would wrongly discard local E2EE identity/group state
 * on a plain sign-out/sign-in of the *same* account).
 */
export async function ensureMlsCoreInitialized(userId: string): Promise<void> {
  if (initializedForUserId === userId) return;
  await MlsCoreModuleNative.initialize(userId);
  initializedForUserId = userId;
}

export async function generateIdentityKey(): Promise<IdentityKeyInfo> {
  return MlsCoreModuleNative.generateIdentityKey();
}

export async function generateDeviceCredential(): Promise<DeviceCredentialInfo> {
  return MlsCoreModuleNative.generateDeviceCredential();
}

export async function generateKeyPackages(count: number): Promise<Uint8Array[]> {
  return MlsCoreModuleNative.generateKeyPackages(count);
}

export async function createGroup(groupId: Uint8Array): Promise<void> {
  await MlsCoreModuleNative.createGroup(groupId);
}

/** Returns the Welcome message bytes to deliver to the newly-added device. */
export async function addMemberToGroup(groupId: Uint8Array, keyPackageBytes: Uint8Array): Promise<Uint8Array> {
  return MlsCoreModuleNative.addMemberToGroup(groupId, keyPackageBytes);
}

/** Returns the joined group's id (equal to `groupId` on success). */
export async function joinGroupFromWelcome(welcomeBytes: Uint8Array): Promise<Uint8Array> {
  return MlsCoreModuleNative.joinGroupFromWelcome(welcomeBytes);
}

export async function encryptMessage(groupId: Uint8Array, plaintext: string): Promise<Uint8Array> {
  return MlsCoreModuleNative.encryptMessage(groupId, plaintext);
}

/**
 * Throws on any authentication/decryption failure (tampered ciphertext,
 * wrong group, replay, etc.) — callers must treat a thrown error as "not
 * displayable" and never fall back to showing the raw ciphertext or any
 * guessed content. See the Phase 5D-FIX report for why this specific
 * failure mode is a hard error, not a soft one, by design.
 */
export async function decryptMessage(groupId: Uint8Array, ciphertext: Uint8Array): Promise<string> {
  return MlsCoreModuleNative.decryptMessage(groupId, ciphertext);
}
