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
use openmls::framing::errors::{MessageDecryptionError, SecretTreeError};
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

/// The result of [`rebuild_group`]: one Welcome that every included device
/// can join from, and which of the caller's KeyPackages (by index) made it
/// into the group.
pub struct RebuiltGroup {
    pub welcome: Vec<u8>,
    pub included: Vec<u32>,
}

/// (Re)creates this device's copy of `group_id` from scratch and adds every
/// device behind `key_packages` in ONE commit, so all of them join the same
/// epoch from the same Welcome.
///
/// This replaces the old "create, then add each peer device with its own
/// commit" flow, which never delivered those commits to the devices added
/// earlier: with two or more peer devices, every device but the last was
/// left on an epoch nobody else used, and could decrypt nothing.
///
/// Every KeyPackage is validated before any existing state is touched;
/// ones that fail validation, use another ciphersuite, or repeat a
/// signature key already present (two server device rows for one physical
/// install, or this device itself) are skipped rather than failing the
/// whole group. Errors with `InvalidInput` if none is usable — the caller's
/// existing group, if any, is left untouched in that case.
pub fn rebuild_group(
    provider: &GroupProvider,
    device_key: &SignatureKeyPair,
    group_id_bytes: &[u8],
    key_packages: &[Vec<u8>],
) -> Result<RebuiltGroup, MlsCoreError> {
    ensure_signer_registered(provider, device_key)?;

    let mut seen_signature_keys = std::collections::HashSet::new();
    seen_signature_keys.insert(device_key.public().to_vec());
    let mut members = Vec::new();
    let mut included = Vec::new();
    for (index, bytes) in key_packages.iter().enumerate() {
        let mut cursor = bytes.as_slice();
        let Ok(key_package_in) = KeyPackageIn::tls_deserialize(&mut cursor) else { continue };
        let Ok(key_package) = key_package_in.validate(provider.crypto(), ProtocolVersion::Mls10) else { continue };
        if key_package.ciphersuite() != CIPHERSUITE {
            continue;
        }
        if !seen_signature_keys.insert(key_package.leaf_node().signature_key().as_slice().to_vec()) {
            continue;
        }
        members.push(key_package);
        included.push(index as u32);
    }
    if members.is_empty() {
        return Err(MlsCoreError::InvalidInput);
    }

    delete_group(provider, group_id_bytes)?;

    let group_id = GroupId::from_slice(group_id_bytes);
    let mut group = MlsGroup::new_with_group_id(
        provider,
        device_key,
        &create_config(),
        group_id,
        credential_with_key(device_key),
    )
    .map_err(|_| MlsCoreError::GroupOperationFailed)?;

    let welcome = (|| {
        let (_commit, welcome, _group_info) = group
            .add_members(provider, device_key, &members)
            .map_err(|_| MlsCoreError::GroupOperationFailed)?;
        // Nobody but this device is in the group before this commit, so
        // there is no one the commit itself would need delivering to.
        group.merge_pending_commit(provider).map_err(|_| MlsCoreError::GroupOperationFailed)?;
        welcome.tls_serialize_detached().map_err(|_| MlsCoreError::GroupOperationFailed)
    })();

    match welcome {
        Ok(welcome) => Ok(RebuiltGroup { welcome, included }),
        Err(err) => {
            // Never leave a half-built group behind to be mistaken for a real one.
            let _ = group.delete(provider.storage());
            Err(err)
        }
    }
}

/// Joins a group from a Welcome, replacing this device's existing copy of
/// that group if it has one.
///
/// A device whose copy is stale (it missed a membership change, or two
/// members created the group concurrently before this fix) can only
/// recover by joining the group everyone else is in. The old join refused
/// whenever a group with the same id existed locally, and the app swallowed
/// that error, which left such a device unable to decrypt anything, forever.
///
/// The existing copy is only removed after the Welcome has been verified
/// to be addressed to one of this device's own KeyPackages and its group
/// secrets decrypted with it, so an arbitrary blob can't wipe a group.
pub fn join_group_replacing(provider: &GroupProvider, welcome_bytes: &[u8]) -> Result<Vec<u8>, MlsCoreError> {
    let mut welcome_cursor = welcome_bytes;
    let message_in = MlsMessageIn::tls_deserialize(&mut welcome_cursor).map_err(|_| MlsCoreError::InvalidInput)?;
    let welcome = match message_in.extract() {
        MlsMessageBodyIn::Welcome(w) => w,
        _ => return Err(MlsCoreError::InvalidInput),
    };

    let processed = ProcessedWelcome::new_from_welcome(provider, create_config().join_config(), welcome)
        .map_err(|_| MlsCoreError::GroupOperationFailed)?;
    let group_id = processed.unverified_group_info().group_id().clone();
    delete_group(provider, group_id.as_slice())?;

    let group = processed
        .into_staged_welcome(provider, None)
        .map_err(|_| MlsCoreError::GroupOperationFailed)?
        .into_group(provider)
        .map_err(|_| MlsCoreError::GroupOperationFailed)?;
    Ok(group.group_id().as_slice().to_vec())
}

/// Removes this device's copy of a group, if it has one. Idempotent.
pub fn delete_group(provider: &GroupProvider, group_id_bytes: &[u8]) -> Result<(), MlsCoreError> {
    let group_id = GroupId::from_slice(group_id_bytes);
    if let Some(mut group) = MlsGroup::load(provider.storage(), &group_id).map_err(|_| MlsCoreError::Storage)? {
        group.delete(provider.storage()).map_err(|_| MlsCoreError::Storage)?;
    }
    Ok(())
}

/// The signature (credential) public keys of every current member of the
/// group — what the app compares against the server's list of active
/// devices to notice a signed-out device that is still a member. Empty if
/// this device has no copy of the group.
pub fn member_signature_keys(provider: &GroupProvider, group_id_bytes: &[u8]) -> Result<Vec<Vec<u8>>, MlsCoreError> {
    let group_id = GroupId::from_slice(group_id_bytes);
    let Some(group) = MlsGroup::load(provider.storage(), &group_id).map_err(|_| MlsCoreError::Storage)? else {
        return Ok(Vec::new());
    };
    Ok(group.members().map(|member| member.signature_key).collect())
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

    // The epoch is part of the message's cleartext framing, so a message
    // this device can't possibly have keys for is reported as such instead
    // of as a generic authentication failure: "this device is behind" and
    // "sent before this device joined" need different handling from
    // tampering. Nothing is decrypted or trusted on the strength of it.
    let message_epoch = protocol_message.epoch();
    let own_epoch = group.epoch();
    if message_epoch > own_epoch {
        return Err(MlsCoreError::MessageFromFutureEpoch);
    }

    let processed = group.process_message(provider, protocol_message).map_err(|err| match err {
        ProcessMessageError::ValidationError(ValidationError::CannotDecryptOwnMessage) => MlsCoreError::OwnMessage,
        ProcessMessageError::ValidationError(ValidationError::UnableToDecrypt(MessageDecryptionError::SecretTreeError(
            SecretTreeError::SecretReuseError,
        ))) => MlsCoreError::DuplicateMessage,
        // The key was dropped because too many later messages from the same
        // sender were processed first: gone for good, but not tampering.
        ProcessMessageError::ValidationError(ValidationError::UnableToDecrypt(MessageDecryptionError::SecretTreeError(
            SecretTreeError::TooDistantInThePast,
        ))) => MlsCoreError::MessageFromPastEpoch,
        // Only a label on a failure that already happened — OpenMLS reports
        // "no secrets kept for that epoch" through more than one variant.
        _ if message_epoch < own_epoch => MlsCoreError::MessageFromPastEpoch,
        _ => MlsCoreError::InvalidCiphertext,
    })?;

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
