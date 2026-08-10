import { registerWebModule, NativeModule } from 'expo';

// This app is Android-first (per the project's stated scope); E2EE has
// no web target. Throwing clearly here is safer than silently returning
// fake keys if this ever gets bundled for web by mistake.
class MlsCoreModule extends NativeModule<{}> {
  initialize(): Promise<void> {
    throw new Error('MlsCore is not supported on web.');
  }
  generateIdentityKey(): Promise<never> {
    throw new Error('MlsCore is not supported on web.');
  }
  generateDeviceCredential(): Promise<never> {
    throw new Error('MlsCore is not supported on web.');
  }
  generateKeyPackages(): Promise<never> {
    throw new Error('MlsCore is not supported on web.');
  }
  createGroup(): Promise<never> {
    throw new Error('MlsCore is not supported on web.');
  }
  addMemberToGroup(): Promise<never> {
    throw new Error('MlsCore is not supported on web.');
  }
  joinGroupFromWelcome(): Promise<never> {
    throw new Error('MlsCore is not supported on web.');
  }
  encryptMessage(): Promise<never> {
    throw new Error('MlsCore is not supported on web.');
  }
  decryptMessage(): Promise<never> {
    throw new Error('MlsCore is not supported on web.');
  }
}

export default registerWebModule(MlsCoreModule, 'MlsCoreModule');
