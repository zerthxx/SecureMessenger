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
import type { DeviceCredentialInfo, IdentityKeyInfo, RebuiltGroupInfo } from '../../../modules/mls-core/src/MlsCore.types';

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

/**
 * Group operations run against whichever account's stores are open, and a
 * sync or send that began before a sign-out/sign-in could otherwise reach
 * the native module after the switch and use (and advance) the other
 * account's group state. Checked synchronously right before each call is
 * dispatched; the native module runs calls in dispatch order, so a call
 * dispatched while `owner`'s stores are open runs against them.
 * "StorageNotInitialized" makes groupSync.classifyMlsError treat it as
 * retryable.
 */
function assertOpenFor(owner: string): void {
  if (initializedForUserId !== owner) {
    throw new Error('StorageNotInitialized: E2EE storage is not open for this account');
  }
}

/**
 * (Re)creates the conversation's group with every device behind
 * `keyPackages` added in one commit. `included` lists which KeyPackages (by
 * index) were used; only those devices may be sent `welcome`. See
 * groupSync.ts for why a group is only ever built this way.
 */
export async function rebuildGroup(owner: string, groupId: Uint8Array, keyPackages: Uint8Array[]): Promise<RebuiltGroupInfo> {
  assertOpenFor(owner);
  return MlsCoreModuleNative.rebuildGroup(groupId, keyPackages);
}

/** Joins from a Welcome, replacing any stale local copy of that group once the Welcome is verified to be for this device. */
export async function joinGroupReplacing(owner: string, welcomeBytes: Uint8Array): Promise<Uint8Array> {
  assertOpenFor(owner);
  return MlsCoreModuleNative.joinGroupReplacing(welcomeBytes);
}

export async function deleteGroup(owner: string, groupId: Uint8Array): Promise<void> {
  assertOpenFor(owner);
  await MlsCoreModuleNative.deleteGroup(groupId);
}

/** Public signature keys of the group's members; empty if this device has no copy of it. */
export async function groupMemberSignatureKeys(owner: string, groupId: Uint8Array): Promise<Uint8Array[]> {
  assertOpenFor(owner);
  return MlsCoreModuleNative.groupMemberSignatureKeys(groupId);
}

export async function encryptMessage(owner: string, groupId: Uint8Array, plaintext: string): Promise<Uint8Array> {
  assertOpenFor(owner);
  return MlsCoreModuleNative.encryptMessage(groupId, plaintext);
}

/**
 * Throws on any authentication/decryption failure (tampered ciphertext,
 * wrong group, replay, etc.) — callers must treat a thrown error as "not
 * displayable" and never fall back to showing the raw ciphertext or any
 * guessed content. See the Phase 5D-FIX report for why this specific
 * failure mode is a hard error, not a soft one, by design.
 */
export async function decryptMessage(owner: string, groupId: Uint8Array, ciphertext: Uint8Array): Promise<string> {
  assertOpenFor(owner);
  return MlsCoreModuleNative.decryptMessage(groupId, ciphertext);
}

/**
 * Decrypts server row `rowId` so that a crash before the result is stored
 * loses nothing: decrypting the same row again returns the same plaintext
 * (MLS itself would refuse it, the key being already used). Call
 * `ackDecrypted` once the result is stored. See rust/src/group.rs
 * `decrypt_message_once`.
 */
export async function decryptMessageOnce(owner: string, groupId: Uint8Array, rowId: string, ciphertext: Uint8Array): Promise<string> {
  assertOpenFor(owner);
  return MlsCoreModuleNative.decryptMessageOnce(groupId, rowId, ciphertext);
}

/** These rows' results are stored; the native side forgets their plaintext. */
export async function ackDecrypted(owner: string, rowIds: string[]): Promise<void> {
  if (rowIds.length === 0) return;
  assertOpenFor(owner);
  await MlsCoreModuleNative.ackDecrypted(rowIds);
}

/** Rows decrypted but never acknowledged — what a crash left behind. */
export async function pendingDecryptedIds(owner: string): Promise<string[]> {
  assertOpenFor(owner);
  return MlsCoreModuleNative.pendingDecryptedIds();
}

/**
 * Seals call signaling (an SDP offer/answer or ICE candidate) for the other
 * member of a 1:1 conversation, with a key derived from the conversation's
 * MLS group for this call (the MLS exporter). The server relaying it can't
 * read or alter it. Read-only on group state: unlike encryptMessage it
 * creates no MLS message, so it never affects chat message decryption.
 */
export async function sealCallSignal(groupId: Uint8Array, callId: string, plaintext: string): Promise<Uint8Array> {
  return MlsCoreModuleNative.sealCallSignal(groupId, callId, plaintext);
}

/** Throws for anything tampered with or sealed for a different call, group, or epoch — never returns partial output. */
export async function openCallSignal(groupId: Uint8Array, callId: string, sealed: Uint8Array): Promise<string> {
  return MlsCoreModuleNative.openCallSignal(groupId, callId, sealed);
}
