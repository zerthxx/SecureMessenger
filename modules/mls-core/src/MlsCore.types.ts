/**
 * Minimal typed surface for Phase 5B: identity/device key generation and
 * KeyPackage generation only. No group creation, no message encryption —
 * see modules/mls-core/rust for the full scope boundary. Every shape
 * here carries public keys/signatures/counts only; nothing private
 * crosses the native bridge (verified by the Phase 5B consolidated
 * check — see the phase report).
 */

export interface IdentityKeyInfo {
  /** Ed25519 public key bytes, as bridged from Kotlin ByteArray. */
  publicKey: Uint8Array;
}

export interface DeviceCredentialInfo {
  /** This device's Ed25519 credential public key. */
  credentialPublicKey: Uint8Array;
  /** Signature over credentialPublicKey by the account identity key. */
  crossSignature: Uint8Array;
}
