import { NativeModule, requireNativeModule } from 'expo';

import type { DeviceCredentialInfo, IdentityKeyInfo } from './MlsCore.types';

declare class MlsCoreModule extends NativeModule<{}> {
  /** `userId`: the authenticated account's own stable id — see mlsCore.ts's `ensureMlsCoreInitialized` for why this must be the account id, not the per-login device id. */
  initialize(userId: string): Promise<void>;
  generateIdentityKey(): Promise<IdentityKeyInfo>;
  generateDeviceCredential(): Promise<DeviceCredentialInfo>;
  generateKeyPackages(count: number): Promise<Uint8Array[]>;

  createGroup(groupId: Uint8Array): Promise<void>;
  addMemberToGroup(groupId: Uint8Array, keyPackageBytes: Uint8Array): Promise<Uint8Array>;
  joinGroupFromWelcome(welcomeBytes: Uint8Array): Promise<Uint8Array>;
  encryptMessage(groupId: Uint8Array, plaintext: string): Promise<Uint8Array>;
  decryptMessage(groupId: Uint8Array, ciphertext: Uint8Array): Promise<string>;
}

export default requireNativeModule<MlsCoreModule>('MlsCore');
