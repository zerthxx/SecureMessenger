import { NativeModule, requireNativeModule } from 'expo';

import type { DeviceCredentialInfo, IdentityKeyInfo, RebuiltGroupInfo } from './MlsCore.types';

declare class MlsCoreModule extends NativeModule<{}> {
  /** `userId`: the authenticated account's own stable id — see mlsCore.ts's `ensureMlsCoreInitialized` for why this must be the account id, not the per-login device id. */
  initialize(userId: string): Promise<void>;
  generateIdentityKey(): Promise<IdentityKeyInfo>;
  generateDeviceCredential(): Promise<DeviceCredentialInfo>;
  generateKeyPackages(count: number): Promise<Uint8Array[]>;

  createGroup(groupId: Uint8Array): Promise<void>;
  addMemberToGroup(groupId: Uint8Array, keyPackageBytes: Uint8Array): Promise<Uint8Array>;
  joinGroupFromWelcome(welcomeBytes: Uint8Array): Promise<Uint8Array>;
  /** (Re)creates the group with every KeyPackage's device added in one commit; see rust/src/group.rs `rebuild_group`. */
  rebuildGroup(groupId: Uint8Array, keyPackages: Uint8Array[]): Promise<RebuiltGroupInfo>;
  /** Joins from a Welcome, replacing a stale local copy of the group only after the Welcome is verified to be for this device. */
  joinGroupReplacing(welcomeBytes: Uint8Array): Promise<Uint8Array>;
  deleteGroup(groupId: Uint8Array): Promise<void>;
  /** Public signature keys of the group's current members; empty if this device has no copy of the group. */
  groupMemberSignatureKeys(groupId: Uint8Array): Promise<Uint8Array[]>;
  encryptMessage(groupId: Uint8Array, plaintext: string): Promise<Uint8Array>;
  decryptMessage(groupId: Uint8Array, ciphertext: Uint8Array): Promise<string>;
  /**
   * Crash-safe decrypt of server row `messageId`: the same row decrypted again
   * (the app was killed before storing it) returns the same plaintext. See
   * rust/src/group.rs `decrypt_message_once`; acknowledge with `ackDecrypted`.
   */
  decryptMessageOnce(groupId: Uint8Array, messageId: string, ciphertext: Uint8Array): Promise<string>;
  /** The app has stored these rows; their kept plaintext is dropped. */
  ackDecrypted(messageIds: string[]): Promise<void>;
  /** Rows decrypted but not yet acknowledged. */
  pendingDecryptedIds(): Promise<string[]>;
  /** Seals call signaling for the other member(s) of the group, keyed per call via the MLS exporter. Read-only on group state. */
  sealCallSignal(groupId: Uint8Array, callId: string, plaintext: string): Promise<Uint8Array>;
  /** Opens call signaling sealed by another group member; rejects anything tampered with or sealed for another call, group, or epoch. */
  openCallSignal(groupId: Uint8Array, callId: string, sealed: Uint8Array): Promise<string>;
  /** A fresh random 32-byte content key for one media blob (voice clip) — see rust/src/blob.rs. */
  generateBlobKey(): Promise<Uint8Array>;
  /** Seals a media blob under a content key (AES-256-GCM, fresh nonce); only the sealed bytes go to the server. */
  sealBlob(key: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array>;
  /** Opens a sealed media blob; rejects anything tampered with or sealed under another key, never partial output. */
  openBlob(key: Uint8Array, sealed: Uint8Array): Promise<Uint8Array>;
}

export default requireNativeModule<MlsCoreModule>('MlsCore');
