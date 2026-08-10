/// Errors surfaced across the UniFFI boundary to Kotlin/Swift.
///
/// Deliberately coarse-grained and free of any secret material or internal
/// state — error messages here can end up in device logs, so nothing about
/// key bytes, storage paths, or cryptographic internals belongs in them.
#[derive(uniffi::Error, thiserror::Error, Debug)]
pub enum MlsCoreError {
    #[error("local secure storage is not initialized")]
    StorageNotInitialized,

    #[error("local secure storage error")]
    Storage,

    #[error("key generation failed")]
    KeyGeneration,

    #[error("no identity key exists on this device yet")]
    NoIdentityKey,

    #[error("no device credential exists on this device yet")]
    NoDeviceCredential,

    #[error("invalid input")]
    InvalidInput,

    #[error("no group with that ID exists on this device")]
    GroupNotFound,

    #[error("MLS group operation failed")]
    GroupOperationFailed,

    /// Deliberately distinct from `GroupOperationFailed`: this is the
    /// error path for tampered/invalid/unauthenticated ciphertext (MLS's
    /// own AEAD/membership authentication rejecting it), not a generic
    /// failure — see the Phase 5C report's tamper-rejection verification.
    #[error("ciphertext failed authentication or is not valid for this group")]
    InvalidCiphertext,
}
