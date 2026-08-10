//! MLS group creation, join, and application-message encrypt/decrypt —
//! Phase 5C, the smallest secure end-to-end proof: two devices, one
//! group, "hello" round-tripped through the server as opaque ciphertext.
//!
//! Every group here is created with an explicit `GroupId` equal to the
//! app's own conversation UUID (see lib.rs's `create_group`) — that ID
//! is already server-issued, already random (Postgres `gen_random_uuid`,
//! not a human-chosen name, satisfying OpenMLS's own "group IDs should
//! be random" guidance), and reusing it means the server never needs a
//! separate column correlating conversations to MLS groups.
//!
//! Uses `use_ratchet_tree_extension(true)` so the ratchet tree travels
//! embedded inside the Welcome message itself — the joiner needs nothing
//! beyond the Welcome bytes, no separate tree transport.

// Matches the import pattern used throughout OpenMLS's own examples and
// test suite (`use openmls::prelude::*`) — MlsGroup, MlsGroupCreateConfig,
// StagedWelcome, GroupId, KeyPackage, KeyPackageIn, KeyPackageBundle,
// MlsMessageIn/Out, ProtocolMessage, ProcessedMessageContent, and the
// tls_codec Serialize/Deserialize traits all come from this one glob.
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_traits::{storage::StorageProvider as _, OpenMlsProvider};
// `openmls::prelude::*` re-exports `tls_codec::*`, but its Serialize
// ambiguity with tls_codec::Serialize (both glob-imported) means the
// trait methods aren't resolved without naming them explicitly here.
use tls_codec::{Deserialize as _, Serialize as _};

use crate::error::MlsCoreError;
use crate::group_storage::GroupProvider;

const CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

fn create_config() -> MlsGroupCreateConfig {
    MlsGroupCreateConfig::builder()
        .ciphersuite(CIPHERSUITE)
        .use_ratchet_tree_extension(true)
        .build()
}

fn credential_with_key(device_key: &SignatureKeyPair) -> CredentialWithKey {
    let credential = BasicCredential::new(device_key.public().to_vec());
    CredentialWithKey {
        credential: credential.into(),
        signature_key: device_key.public().into(),
    }
}

/// OpenMLS's own client-setup pattern always registers a freshly-made
/// `SignatureKeyPair` with the provider's storage before using it (see
/// `credentials::test_utils::new_credential` in the crate itself) —
/// some internal operations look the signer up by public key via
/// storage rather than relying solely on the `&signer` parameter passed
/// to a given call. Idempotent and cheap, so every group.rs entry point
/// that has both a provider and a device key calls this first.
fn ensure_signer_registered(provider: &GroupProvider, device_key: &SignatureKeyPair) -> Result<(), MlsCoreError> {
    device_key.store(provider.storage()).map_err(|_| MlsCoreError::Storage)
}

/// Creates a brand-new persistent MLS group with this device as its only
/// member. `group_id_bytes` is the caller-supplied conversation ID (see
/// module docs for why reusing it is safe and deliberate).
pub fn create_group(
    provider: &GroupProvider,
    device_key: &SignatureKeyPair,
    group_id_bytes: &[u8],
) -> Result<(), MlsCoreError> {
    ensure_signer_registered(provider, device_key)?;
    let group_id = GroupId::from_slice(group_id_bytes);
    MlsGroup::new_with_group_id(
        provider,
        device_key,
        &create_config(),
        group_id,
        credential_with_key(device_key),
    )
    .map_err(|_| MlsCoreError::GroupOperationFailed)?;
    Ok(())
}

/// Adds a peer device (identified by its public KeyPackage bytes) to an
/// existing group this device already belongs to, and returns the
/// TLS-serialized Welcome message to deliver to that device — the only
/// thing that needs to travel out-of-band; everything else the peer
/// needs (the ratchet tree) is embedded in it.
pub fn add_member_and_get_welcome(
    provider: &GroupProvider,
    device_key: &SignatureKeyPair,
    group_id_bytes: &[u8],
    key_package_bytes: &[u8],
) -> Result<Vec<u8>, MlsCoreError> {
    ensure_signer_registered(provider, device_key)?;
    let group_id = GroupId::from_slice(group_id_bytes);
    let mut group = MlsGroup::load(provider.storage(), &group_id)
        .map_err(|_| MlsCoreError::GroupOperationFailed)?
        .ok_or(MlsCoreError::GroupNotFound)?;

    let mut key_package_cursor = key_package_bytes;
    let key_package_in = KeyPackageIn::tls_deserialize(&mut key_package_cursor)
        .map_err(|_| MlsCoreError::InvalidInput)?;
    let key_package: KeyPackage = key_package_in
        .validate(provider.crypto(), ProtocolVersion::Mls10)
        .map_err(|_| MlsCoreError::InvalidInput)?;

    let (_commit, welcome, _group_info) = group
        .add_members(provider, device_key, &[key_package])
        .map_err(|_| MlsCoreError::GroupOperationFailed)?;

    group
        .merge_pending_commit(provider)
        .map_err(|_| MlsCoreError::GroupOperationFailed)?;

    welcome
        .tls_serialize_detached()
        .map_err(|_| MlsCoreError::GroupOperationFailed)
}

/// Joins a group from a Welcome message received from another device,
/// persisting the resulting group state. Returns the group ID (equal to
/// the conversation ID the Welcome was created for).
pub fn join_group_from_welcome(
    provider: &GroupProvider,
    welcome_bytes: &[u8],
) -> Result<Vec<u8>, MlsCoreError> {
    let mut welcome_cursor = welcome_bytes;
    let message_in = MlsMessageIn::tls_deserialize(&mut welcome_cursor)
        .map_err(|_| MlsCoreError::InvalidInput)?;
    // MlsMessageIn::into_welcome() is test-only (cfg(test, "test-utils"))
    // — extracting the body and matching it directly is the production
    // path, and also lets us reject anything that isn't actually a
    // Welcome (a peer sending the wrong message type) as InvalidInput
    // rather than a panic or a wrong-variant unwrap.
    let welcome = match message_in.extract() {
        MlsMessageBodyIn::Welcome(w) => w,
        _ => return Err(MlsCoreError::InvalidInput),
    };

    let group = StagedWelcome::new_from_welcome(provider, create_config().join_config(), welcome, None)
        .map_err(|_| MlsCoreError::GroupOperationFailed)?
        .into_group(provider)
        .map_err(|_| MlsCoreError::GroupOperationFailed)?;

    Ok(group.group_id().as_slice().to_vec())
}

/// Encrypts an application message in the given group. Returns the
/// TLS-serialized ciphertext — this is the only thing that ever reaches
/// the server (see lib.rs / the Phase 5C report for what the server can
/// and can't see).
pub fn encrypt_message(
    provider: &GroupProvider,
    device_key: &SignatureKeyPair,
    group_id_bytes: &[u8],
    plaintext: &str,
) -> Result<Vec<u8>, MlsCoreError> {
    ensure_signer_registered(provider, device_key)?;
    let group_id = GroupId::from_slice(group_id_bytes);
    let mut group = MlsGroup::load(provider.storage(), &group_id)
        .map_err(|_| MlsCoreError::GroupOperationFailed)?
        .ok_or(MlsCoreError::GroupNotFound)?;

    let out: MlsMessageOut = group
        .create_message(provider, device_key, plaintext.as_bytes())
        .map_err(|_| MlsCoreError::GroupOperationFailed)?;

    out.tls_serialize_detached().map_err(|_| MlsCoreError::GroupOperationFailed)
}

/// Decrypts and authenticates an application message ciphertext.
/// Returns `MlsCoreError::InvalidCiphertext` for anything that fails MLS's
/// own AEAD/membership authentication — tampered bytes, wrong group,
/// replayed/out-of-order generation, etc. — never silently returns
/// corrupted plaintext.
pub fn decrypt_message(
    provider: &GroupProvider,
    group_id_bytes: &[u8],
    ciphertext_bytes: &[u8],
) -> Result<String, MlsCoreError> {
    let group_id = GroupId::from_slice(group_id_bytes);
    let mut group = MlsGroup::load(provider.storage(), &group_id)
        .map_err(|_| MlsCoreError::GroupOperationFailed)?
        .ok_or(MlsCoreError::GroupNotFound)?;

    let mut ciphertext_cursor = ciphertext_bytes;
    let message_in = MlsMessageIn::tls_deserialize(&mut ciphertext_cursor)
        .map_err(|_| MlsCoreError::InvalidCiphertext)?;
    let protocol_message: ProtocolMessage = message_in
        .try_into_protocol_message()
        .map_err(|_| MlsCoreError::InvalidCiphertext)?;

    let processed = group
        .process_message(provider, protocol_message)
        .map_err(|_| MlsCoreError::InvalidCiphertext)?;

    match processed.into_content() {
        ProcessedMessageContent::ApplicationMessage(app_msg) => {
            String::from_utf8(app_msg.into_bytes()).map_err(|_| MlsCoreError::InvalidCiphertext)
        }
        _ => Err(MlsCoreError::InvalidCiphertext),
    }
}

/// Copies a just-generated KeyPackage's private material into the group
/// storage backend so a future `join_group_from_welcome` call can find
/// it — see group_storage.rs module docs for why this bridge exists
/// (KeyPackages are generated/persisted through the Phase 5B
/// `SecretsStore`, but group joins operate through this phase's
/// separate, OpenMLS-official SQLite-backed provider).
pub fn register_key_package_for_group_join(
    provider: &GroupProvider,
    bundle: &openmls::key_packages::KeyPackageBundle,
) -> Result<(), MlsCoreError> {
    let hash_ref = bundle
        .key_package()
        .hash_ref(provider.crypto())
        .map_err(|_| MlsCoreError::GroupOperationFailed)?;
    provider
        .storage()
        .write_key_package(&hash_ref, bundle)
        .map_err(|_| MlsCoreError::Storage)
}
