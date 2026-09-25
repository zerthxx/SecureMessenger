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

    /// The message was encrypted in an epoch newer than this device's copy
    /// of the group: this device missed a membership change and its group
    /// state is stale. Retrying cannot help; only rejoining can.
    #[error("message is from a newer epoch than this device's group state")]
    MessageFromFutureEpoch,

    /// The message was encrypted in an epoch older than this device's copy
    /// of the group — e.g. sent before this device joined. MLS gives a new
    /// member no keys for epochs before it joined, by design.
    #[error("message is from an epoch this device has no keys for")]
    MessageFromPastEpoch,

    /// MLS never lets a member decrypt its own messages (the key material
    /// is erased right after sending).
    #[error("message was sent by this device")]
    OwnMessage,

    /// A second copy of a message this device already decrypted (its key is
    /// single-use and already gone). Happens when a send reaches the server
    /// twice — a network-level retry of the same request. Nothing to show:
    /// the first copy was delivered.
    #[error("message was already decrypted on this device")]
    DuplicateMessage,
}
