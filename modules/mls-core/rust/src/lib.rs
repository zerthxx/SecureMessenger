//! # mls-core
//!
//! The Rust foundation for the app's end-to-end encryption, per the
//! approved Phase 5A architecture (MLS / RFC 9420, via OpenMLS).
//!
//! Phase 5B: identity/device key generation, KeyPackage generation, and
//! encrypted local storage for that material (storage.rs).
//!
//! Phase 5C: persistent MLS group state, group creation/join, and
//! application-message encrypt/decrypt (group.rs, group_storage.rs) —
//! the smallest secure proof of real device-to-device E2EE messaging.
//! Still explicitly out of scope: media, voice, push, group UI beyond
//! this proof, iOS testing (Android only per the phase instructions).
//!
//! Exposed to Kotlin/Swift via UniFFI (`uniffi::setup_scaffolding!()`
//! below). Every exported function returns only public keys, signatures,
//! ciphertext, or plaintext the *caller itself* just supplied/decrypted
//! for its own use — never a private key. See each function's doc
//! comment for exactly what crosses the boundary.

mod error;
mod group;
mod group_storage;
mod storage;

use std::sync::Mutex;

pub use error::MlsCoreError;
use group_storage::GroupProvider;
use openmls::{
    key_packages::KeyPackage,
    prelude::{BasicCredential, CredentialWithKey, Ciphersuite},
};
use openmls_traits::signatures::Signer;
use storage::SecretsStore;
use tls_codec::Serialize as TlsSerializeTrait;

uniffi::setup_scaffolding!();

/// The single MLS ciphersuite this app supports for now, per the Phase
/// 5A architecture doc: X25519 key agreement, AES-128-GCM, SHA-256,
/// Ed25519 signatures. Fixed rather than negotiated — introducing a
/// second ciphersuite is a deliberate future decision, not a default.
const CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

/// The open local E2EE stores for one account, plus the namespace they
/// were opened under — see [`initialize`] for what "namespace" means
/// and why this needs to be swappable rather than the previous
/// `OnceLock`-per-process design (Phase 6 account-isolation fix).
struct OpenStores {
    namespace: String,
    store: SecretsStore,
    group_provider: GroupProvider,
}

/// Replaces the two previous `OnceLock<Mutex<_>>` statics (one store,
/// fixed for the life of the process, no matter which account is
/// logged in). A mobile app process routinely outlives a single logged-
/// in account — sign-out/sign-in, or switching accounts, does not
/// restart the OS process — so a process-lifetime-scoped store silently
/// let a second account inherit the first account's already-open E2EE
/// identity. This is `None` until [`initialize`] is first called, and
/// gets *replaced* (not just written once) whenever a different
/// account's namespace is requested.
static STORES: Mutex<Option<OpenStores>> = Mutex::new(None);

fn with_store<T>(f: impl FnOnce(&SecretsStore) -> Result<T, MlsCoreError>) -> Result<T, MlsCoreError> {
    let guard = STORES.lock().map_err(|_| MlsCoreError::Storage)?;
    let open = guard.as_ref().ok_or(MlsCoreError::StorageNotInitialized)?;
    f(&open.store)
}

/// Locks the store for the duration of `f` — every group operation
/// needs the device signing key (from `SecretsStore`) *and* the group
/// storage backend (`GroupProvider`) together, so this is the one
/// choke point group.rs's callers go through.
///
/// Phase 5D: also the one choke point that checkpoints the encrypted
/// group-state blob (see group_storage.rs) after every call, regardless
/// of whether `f` succeeded — some OpenMLS operations can write partial
/// storage state before returning an error, so persisting unconditionally
/// keeps the on-disk blob from silently diverging from what's actually
/// true in memory. A checkpoint failure is surfaced even if `f` itself
/// succeeded, since a group op whose resulting state can't be persisted
/// isn't safely "done" yet.
fn with_group_store<T>(
    f: impl FnOnce(&SecretsStore, &GroupProvider) -> Result<T, MlsCoreError>,
) -> Result<T, MlsCoreError> {
    let guard = STORES.lock().map_err(|_| MlsCoreError::Storage)?;
    let open = guard.as_ref().ok_or(MlsCoreError::StorageNotInitialized)?;
    let result = f(&open.store, &open.group_provider);
    open.group_provider.checkpoint().map_err(|_| MlsCoreError::Storage)?;
    result
}

#[derive(uniffi::Record)]
pub struct IdentityKeyInfo {
    /// Ed25519 public key, raw bytes. Safe to publish to the server and
    /// to display for out-of-band verification (Phase 5A §5/§9).
    pub public_key: Vec<u8>,
}

#[derive(uniffi::Record)]
pub struct DeviceCredentialInfo {
    /// This device's Ed25519 credential public key.
    pub credential_public_key: Vec<u8>,
    /// Signature over `credential_public_key`, produced by the account
    /// identity key — proves this device belongs to the account that
    /// generated the identity key (Phase 5A §4/§5 cross-signing).
    pub cross_signature: Vec<u8>,
}

/// Opens (or creates) the local E2EE stores for one account.
///
/// `namespace`: identifies *which account* these stores belong to —
/// callers pass the authenticated account's own stable id (never a
/// device id, which is minted fresh on every login and would wrongly
/// discard group state on a plain sign-out/sign-in; see the Phase 6
/// account-isolation fix report). `storage_path`/`group_storage_path`
/// must already be unique per namespace — this function doesn't derive
/// or validate that itself, it just opens whatever paths it's given.
///
/// `storage_path`: the Phase 5B encrypted secrets store — identity key,
/// device credential key, KeyPackage bundles. `master_key` must be
/// exactly 32 bytes from the platform keystore (Android Keystore / iOS
/// Keychain); this function never generates or persists it. See
/// storage.rs.
///
/// `group_storage_path`: a *separate* SQLite database, deliberately not
/// sharing a file or format with `storage_path` — persistent MLS group
/// state (ratchet tree, epoch secrets, …), backed by OpenMLS's own
/// official `openmls_sqlite_storage` crate. See group_storage.rs for why
/// this is a different store rather than an extension of the Phase 5B
/// snapshot format.
///
/// Must be called before any other function in this module, and again
/// any time the logged-in account changes — a call for a namespace
/// that's already open is a no-op (same idempotency the previous
/// process-wide-only design had); a call for a *different* namespace
/// replaces the open stores, so a second account can never observe or
/// reuse the first account's in-memory or on-disk E2EE identity.
#[uniffi::export]
pub fn initialize(
    namespace: String,
    storage_path: String,
    group_storage_path: String,
    master_key: Vec<u8>,
) -> Result<(), MlsCoreError> {
    let key_array: [u8; 32] = master_key
        .try_into()
        .map_err(|_| MlsCoreError::InvalidInput)?;

    let mut guard = STORES.lock().map_err(|_| MlsCoreError::Storage)?;
    if let Some(existing) = guard.as_ref() {
        if existing.namespace == namespace {
            return Ok(());
        }
    }

    let store = SecretsStore::open(storage_path.into(), &key_array)
        .map_err(|_| MlsCoreError::Storage)?;
    let group_provider = GroupProvider::open(std::path::Path::new(&group_storage_path), &key_array)
        .map_err(|_| MlsCoreError::Storage)?;

    *guard = Some(OpenStores { namespace, store, group_provider });
    Ok(())
}

/// Generates the account's identity signing key if one doesn't already
/// exist on this device, or returns the existing one. This key is meant
/// to exist exactly once per account and is cross-signed onto every
/// device the account adds (Phase 5A §4).
///
/// Returns only the public key. The private half never leaves this
/// module — it's held in the encrypted store opened by [`initialize`].
#[uniffi::export]
pub fn generate_identity_key() -> Result<IdentityKeyInfo, MlsCoreError> {
    with_store(|store| {
        let key = store
            .get_or_create_identity_key()
            .map_err(|_| MlsCoreError::KeyGeneration)?;
        Ok(IdentityKeyInfo {
            public_key: key.public().to_vec(),
        })
    })
}

/// Generates this device's MLS credential key if one doesn't already
/// exist, cross-signed by the account identity key from
/// [`generate_identity_key`] (which must have been called first, even
/// if in an earlier process — it's read back from encrypted storage).
///
/// Returns only the device's public credential key and the cross-
/// signature. The private half never leaves this module.
#[uniffi::export]
pub fn generate_device_credential() -> Result<DeviceCredentialInfo, MlsCoreError> {
    with_store(|store| {
        let identity_key = store.identity_key().ok_or(MlsCoreError::NoIdentityKey)?;

        let device_key = if let Some(existing) = store.device_credential_key() {
            existing
        } else {
            store
                .get_or_create_device_credential_key()
                .map_err(|_| MlsCoreError::KeyGeneration)?
        };

        let cross_signature = identity_key
            .sign(device_key.public())
            .map_err(|_| MlsCoreError::KeyGeneration)?;

        Ok(DeviceCredentialInfo {
            credential_public_key: device_key.public().to_vec(),
            cross_signature,
        })
    })
}

/// Generates `count` fresh KeyPackages for this device and returns their
/// TLS-serialized *public* bytes, ready to publish to the server (Phase
/// 5A §3/§9 — the KeyPackage pool other devices consume to add this
/// device to a group). The corresponding private key material is
/// persisted to encrypted local storage automatically and never
/// returned here.
///
/// Requires [`generate_device_credential`] to have been called first (in
/// this process or an earlier one).
#[uniffi::export]
pub fn generate_key_packages(count: u32) -> Result<Vec<Vec<u8>>, MlsCoreError> {
    with_group_store(|store, group_provider| {
        let device_key = store
            .device_credential_key()
            .ok_or(MlsCoreError::NoDeviceCredential)?;

        let credential = BasicCredential::new(device_key.public().to_vec());
        let credential_with_key = CredentialWithKey {
            credential: credential.into(),
            signature_key: device_key.public().into(),
        };

        let mut published = Vec::with_capacity(count as usize);
        for _ in 0..count {
            let bundle = KeyPackage::builder()
                .build(CIPHERSUITE, &store.provider, &device_key, credential_with_key.clone())
                .map_err(|_| MlsCoreError::KeyGeneration)?;

            store
                .persist_key_package(&bundle)
                .map_err(|_| MlsCoreError::Storage)?;

            // Also register with the group-storage backend (see
            // group_storage.rs docs) so a future join-by-Welcome can
            // find this KeyPackage's private material — OpenMLS's own
            // join logic looks it up through whichever provider is
            // passed to `StagedWelcome::new_from_welcome`, which for
            // group operations is always `GroupProvider`, not the
            // `SecretsStore`-internal provider this bundle was minted
            // through.
            group::register_key_package_for_group_join(group_provider, &bundle)
                .map_err(|_| MlsCoreError::Storage)?;

            let public_bytes = bundle
                .key_package()
                .tls_serialize_detached()
                .map_err(|_| MlsCoreError::KeyGeneration)?;
            published.push(public_bytes);
        }
        Ok(published)
    })
}

/// Creates a brand-new persistent MLS group whose ID is `group_id` —
/// the app is expected to pass its own (server-issued, already random)
/// conversation ID here; see group.rs module docs for why that's safe.
/// This device is the group's only member until [`add_member_to_group`]
/// adds someone.
#[uniffi::export]
pub fn create_group(group_id: Vec<u8>) -> Result<(), MlsCoreError> {
    with_group_store(|store, group_provider| {
        let device_key = store.device_credential_key().ok_or(MlsCoreError::NoDeviceCredential)?;
        group::create_group(group_provider, &device_key, &group_id)
    })
}

/// Adds a peer device (identified by its public KeyPackage bytes,
/// fetched from the server) to a group this device belongs to. Returns
/// the TLS-serialized Welcome message — the only thing that needs to be
/// delivered to that device (e.g. via the server, as opaque bytes) for
/// it to join.
#[uniffi::export]
pub fn add_member_to_group(group_id: Vec<u8>, key_package_bytes: Vec<u8>) -> Result<Vec<u8>, MlsCoreError> {
    with_group_store(|store, group_provider| {
        let device_key = store.device_credential_key().ok_or(MlsCoreError::NoDeviceCredential)?;
        group::add_member_and_get_welcome(group_provider, &device_key, &group_id, &key_package_bytes)
    })
}

/// Joins a group from a Welcome message received from another device
/// (via the server). Returns the group ID.
#[uniffi::export]
pub fn join_group_from_welcome(welcome_bytes: Vec<u8>) -> Result<Vec<u8>, MlsCoreError> {
    with_group_store(|_store, group_provider| group::join_group_from_welcome(group_provider, &welcome_bytes))
}

/// Encrypts a plaintext application message for the given group. Returns
/// TLS-serialized ciphertext — this is the only representation of the
/// message that is ever handed to the server (see the Phase 5C report
/// for exactly what the server can and can't see).
#[uniffi::export]
pub fn encrypt_message(group_id: Vec<u8>, plaintext: String) -> Result<Vec<u8>, MlsCoreError> {
    with_group_store(|store, group_provider| {
        let device_key = store.device_credential_key().ok_or(MlsCoreError::NoDeviceCredential)?;
        group::encrypt_message(group_provider, &device_key, &group_id, &plaintext)
    })
}

/// Decrypts and authenticates a ciphertext for the given group. Returns
/// `MlsCoreError::InvalidCiphertext` — never corrupted output — for
/// tampered bytes or anything that fails MLS's own AEAD/membership
/// authentication.
#[uniffi::export]
pub fn decrypt_message(group_id: Vec<u8>, ciphertext: Vec<u8>) -> Result<String, MlsCoreError> {
    with_group_store(|_store, group_provider| group::decrypt_message(group_provider, &group_id, &ciphertext))
}

#[cfg(test)]
mod tests {
    use super::*;
    use openmls_traits::OpenMlsProvider;
    use std::sync::Once;

    // `STORES` is one process-wide static and `cargo test` runs tests in
    // parallel by default — every test below that touches it (directly,
    // or via `ensure_initialized`) holds this for its *entire* body, not
    // just around individual calls, so two tests can never interleave
    // `initialize()`/`generate_*`/`create_group` calls against each
    // other's namespace. `two_device_end_to_end_proof` and
    // `group_state_survives_restart` don't need it — they use
    // `TestDevice`/direct `SecretsStore::open`, bypassing the static
    // entirely, to genuinely simulate two independent devices.
    static TEST_STORES_LOCK: Mutex<()> = Mutex::new(());

    // Tests against the single shared "test-shared" namespace run
    // against one store, seeded once via `Once` (which blocks concurrent
    // callers until the first completes, unlike a raw atomic flag).
    fn ensure_initialized() {
        static INIT: Once = Once::new();
        INIT.call_once(|| {
            let dir = tempfile::tempdir().unwrap();
            let secrets_path = dir.path().join("mls-core-test.bin");
            let group_path = dir.keep().join("mls-core-group-test.sqlite");
            initialize(
                "test-shared".to_string(),
                secrets_path.to_string_lossy().into_owned(),
                group_path.to_string_lossy().into_owned(),
                vec![7u8; 32],
            )
            .unwrap();
        });
    }

    #[test]
    fn identity_key_is_stable_across_calls() {
        let _guard = TEST_STORES_LOCK.lock().unwrap();
        ensure_initialized();
        let first = generate_identity_key().unwrap();
        let second = generate_identity_key().unwrap();
        assert_eq!(first.public_key, second.public_key);
    }

    #[test]
    fn device_credential_requires_identity_key_first() {
        // Uses the same shared store as the other tests in this module,
        // so by this point an identity key already exists — this test
        // documents the ordering requirement rather than re-proving the
        // "no identity key yet" error path in isolation.
        let _guard = TEST_STORES_LOCK.lock().unwrap();
        ensure_initialized();
        generate_identity_key().unwrap();
        let device = generate_device_credential().unwrap();
        assert_eq!(device.cross_signature.is_empty(), false);
    }

    #[test]
    fn key_packages_are_generated_and_public_only() {
        let _guard = TEST_STORES_LOCK.lock().unwrap();
        ensure_initialized();
        generate_identity_key().unwrap();
        generate_device_credential().unwrap();
        let packages = generate_key_packages(3).unwrap();
        assert_eq!(packages.len(), 3);
        // Every returned entry must be a TLS-serialized public
        // KeyPackage — spot check it's non-empty and each is unique
        // (KeyPackages must not be reused).
        for p in &packages {
            assert!(!p.is_empty());
        }
        assert_ne!(packages[0], packages[1]);
    }

    /// A "device" for this test is a fully independent `GroupProvider`
    /// (own temp SQLite file) plus its own freshly-generated
    /// `SignatureKeyPair` — genuinely separate objects sharing no Rust
    /// state, calling the exact same `group::*` functions the UniFFI
    /// layer calls, communicating only through serialized bytes
    /// (KeyPackages, Welcome messages, ciphertext), exactly as two real
    /// devices would over the network. This deliberately bypasses the
    /// process-wide `STORE`/`GROUP_STORE` statics (which are correctly
    /// one-per-process for the real app, and so cannot represent two
    /// independent devices within a single test process) and calls
    /// group.rs's lower-level functions directly instead. This is the
    /// two-device simulation method documented in the Phase 5C report.
    struct TestDevice {
        provider: GroupProvider,
        device_key: openmls_basic_credential::SignatureKeyPair,
    }

    impl TestDevice {
        fn new(name: &str) -> Self {
            let dir = tempfile::tempdir().unwrap().keep();
            let provider =
                GroupProvider::open(&dir.join(format!("{name}-group.sqlite")), &[5u8; 32]).unwrap();
            let device_key = openmls_basic_credential::SignatureKeyPair::new(
                openmls_traits::types::SignatureScheme::ED25519,
            )
            .unwrap();
            Self { provider, device_key }
        }
    }

    #[test]
    fn two_device_end_to_end_proof() {
        let device_a = TestDevice::new("device-a");
        let device_b = TestDevice::new("device-b");

        // group_id stands in for a server-issued conversation UUID.
        let group_id = b"11111111-1111-1111-1111-111111111111".to_vec();
        group::create_group(&device_a.provider, &device_a.device_key, &group_id).unwrap();

        // Device B generates its own KeyPackage independently (own
        // provider, own key) and registers its private half with its
        // own group storage — mirroring what generate_key_packages does
        // through the real UniFFI surface.
        let credential = openmls::prelude::BasicCredential::new(device_b.device_key.public().to_vec());
        let credential_with_key = openmls::prelude::CredentialWithKey {
            credential: credential.into(),
            signature_key: device_b.device_key.public().into(),
        };
        let bundle = openmls::key_packages::KeyPackage::builder()
            .build(CIPHERSUITE, &device_b.provider, &device_b.device_key, credential_with_key)
            .unwrap();
        group::register_key_package_for_group_join(&device_b.provider, &bundle).unwrap();
        let key_package_bytes: Vec<u8> = {
            use tls_codec::Serialize;
            bundle.key_package().tls_serialize_detached().unwrap()
        };

        // A adds B to the group using ONLY B's public KeyPackage bytes.
        let welcome_bytes = group::add_member_and_get_welcome(
            &device_a.provider,
            &device_a.device_key,
            &group_id,
            &key_package_bytes,
        )
        .unwrap();
        assert!(!welcome_bytes.is_empty());

        // B joins using ONLY the Welcome bytes.
        let joined_group_id = group::join_group_from_welcome(&device_b.provider, &welcome_bytes).unwrap();
        assert_eq!(joined_group_id, group_id);

        // 1) A -> B
        let plaintext_ab = "hello";
        let ciphertext_ab =
            group::encrypt_message(&device_a.provider, &device_a.device_key, &group_id, plaintext_ab).unwrap();
        assert_ne!(ciphertext_ab, plaintext_ab.as_bytes()); // 3) ciphertext differs from plaintext
        let decrypted_ab = group::decrypt_message(&device_b.provider, &group_id, &ciphertext_ab).unwrap();
        assert_eq!(decrypted_ab, plaintext_ab);

        // 2) B -> A
        let plaintext_ba = "hello back";
        let ciphertext_ba =
            group::encrypt_message(&device_b.provider, &device_b.device_key, &group_id, plaintext_ba).unwrap();
        let decrypted_ba = group::decrypt_message(&device_a.provider, &group_id, &ciphertext_ba).unwrap();
        assert_eq!(decrypted_ba, plaintext_ba);

        // 7) tampered ciphertext must be rejected, not silently corrupted.
        //
        // Phase 5D-FIX diagnosis: openmls 0.8.1's own AEAD-failure path
        // (`private_message_in.rs`'s `decrypt()`) contains
        // `debug_assert!(false, "Ciphertext decryption failed")`, which
        // fires on *any* AEAD authentication failure — including this
        // deliberately-tampered one — and is compiled in for debug/test
        // builds only (a no-op in `--release`, where the function
        // returns a normal `Err` as intended). So under `cargo test`,
        // the only observable outcome of a correctly-rejected tampered
        // ciphertext is a panic, not a `Result::Err`; catching it here
        // is the correct way to assert rejection under this specific,
        // external, debug-only OpenMLS behavior — not a weakening of
        // the check. Both outcomes (a caught panic in debug, or a
        // returned `Err` in release) are treated as "rejected"; an
        // `Ok(_)` (tampered ciphertext successfully decrypted) is not,
        // and still fails the test either way. This is a test-harness-
        // only change — `group::decrypt_message` and everything it
        // calls are untouched.
        let mut tampered =
            group::encrypt_message(&device_a.provider, &device_a.device_key, &group_id, "tamper me").unwrap();
        let last = tampered.len() - 1;
        tampered[last] ^= 0xFF;

        let previous_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {})); // silence the expected panic's default stderr output
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            group::decrypt_message(&device_b.provider, &group_id, &tampered)
        }));
        std::panic::set_hook(previous_hook);

        let rejected = match outcome {
            Ok(Ok(_)) => false,  // decrypted successfully: NOT rejected, a real bug
            Ok(Err(_)) => true,  // release-build behavior: graceful Err
            Err(_) => true,      // debug-build behavior: debug_assert! panic
        };
        assert!(rejected, "tampered ciphertext must not decrypt successfully");
    }

    #[test]
    fn group_state_survives_restart() {
        // Uses the same export_secret-comparison technique OpenMLS's own
        // `test_mls_group_persistence` test uses — a lone member trying
        // to decrypt its own just-sent application message isn't
        // guaranteed to work (MLS erases a sent generation's key
        // material for forward secrecy right after use), so that's not
        // a valid way to prove *storage* persistence specifically. The
        // group's own exported secret being identical before and after
        // a full provider teardown/reopen is: it can only match if the
        // ratchet tree, epoch secrets, and every other piece of group
        // state were correctly written to and read back from disk.
        let dir = tempfile::tempdir().unwrap().keep();
        let group_path = dir.join("restart-group.sqlite");
        let device_key = openmls_basic_credential::SignatureKeyPair::new(
            openmls_traits::types::SignatureScheme::ED25519,
        )
        .unwrap();
        let group_id = b"22222222-2222-2222-2222-222222222222".to_vec();
        let openmls_group_id = openmls::prelude::GroupId::from_slice(&group_id);

        let master_key = [3u8; 32];
        let secret_before = {
            let provider = GroupProvider::open(&group_path, &master_key).unwrap();
            group::create_group(&provider, &device_key, &group_id).unwrap();
            // Phase 5D: group state now lives in a process-local in-memory
            // database and is only durably persisted (as an encrypted
            // blob) on an explicit checkpoint — the real app does this
            // automatically after every group.rs call via
            // lib.rs::with_group_store, but this test calls group::*
            // directly, so it checkpoints explicitly to simulate that.
            provider.checkpoint().unwrap();
            let group = openmls::prelude::MlsGroup::load(provider.storage(), &openmls_group_id)
                .unwrap()
                .unwrap();
            group
                .export_secret(provider.crypto(), "phase5c-restart-test", &[], 32)
                .unwrap()
            // provider dropped here — simulates the process (and thus
            // any in-memory-only state) going away, the same way an
            // Android app process is killed and relaunched. Only what's
            // on disk in group_path (the encrypted blob) survives.
        };

        // 6) group state survives app restart — reopen from the SAME
        // file as a brand-new provider and confirm the exported secret
        // (which is derived from the persisted epoch/tree state) matches.
        let secret_after = {
            let reopened_provider = GroupProvider::open(&group_path, &master_key).unwrap();
            let group = openmls::prelude::MlsGroup::load(reopened_provider.storage(), &openmls_group_id)
                .unwrap()
                .unwrap();
            group
                .export_secret(reopened_provider.crypto(), "phase5c-restart-test", &[], 32)
                .unwrap()
        };

        assert_eq!(secret_before, secret_after);
    }

    /// Phase 6 account-isolation fix regression test. Reproduces the
    /// exact real-world scenario that produced
    /// `CreateCommitError(ProposalValidationError(DuplicateSignatureKey))`:
    /// two different accounts authenticating in the *same process*
    /// (a normal mobile sign-out/sign-in, no process restart) must never
    /// receive the same device credential key. Calls the real public
    /// `initialize`/`generate_identity_key`/`generate_device_credential`
    /// — not the lower-level `group::*`/`storage::SecretsStore` direct
    /// construction `TestDevice` uses — specifically to exercise the
    /// `STORES` swap path other tests in this file don't touch.
    #[test]
    fn switching_namespace_gives_independent_identities() {
        let _guard = TEST_STORES_LOCK.lock().unwrap();
        let dir = tempfile::tempdir().unwrap().keep();

        initialize(
            "account-alice".to_string(),
            dir.join("alice-secrets.bin").to_string_lossy().into_owned(),
            dir.join("alice-group.sqlite").to_string_lossy().into_owned(),
            vec![21u8; 32],
        )
        .unwrap();
        generate_identity_key().unwrap();
        let alice_credential = generate_device_credential().unwrap();

        initialize(
            "account-bob".to_string(),
            dir.join("bob-secrets.bin").to_string_lossy().into_owned(),
            dir.join("bob-group.sqlite").to_string_lossy().into_owned(),
            vec![22u8; 32],
        )
        .unwrap();
        generate_identity_key().unwrap();
        let bob_credential = generate_device_credential().unwrap();

        assert_ne!(
            alice_credential.credential_public_key, bob_credential.credential_public_key,
            "two different accounts initialized in the same process must never share a device credential key"
        );

        // Switching back to Alice's already-open namespace must be a
        // no-op that returns her *same* identity, not regenerate one —
        // this is the "logout must not destroy keys" requirement: the
        // same account re-authenticating (even after another account
        // used this process in between) must see continuity.
        initialize(
            "account-alice".to_string(),
            dir.join("alice-secrets.bin").to_string_lossy().into_owned(),
            dir.join("alice-group.sqlite").to_string_lossy().into_owned(),
            vec![21u8; 32],
        )
        .unwrap();
        let alice_credential_again = generate_device_credential().unwrap();
        assert_eq!(
            alice_credential.credential_public_key, alice_credential_again.credential_public_key,
            "re-initializing an already-open namespace must return the same identity, not a fresh one"
        );
    }

    /// The actual bug this fix closes: with two independently-namespaced
    /// accounts' identities (as `switching_namespace_gives_independent_identities`
    /// establishes), Alice adding "Bob" to a group must succeed — before
    /// the fix, both accounts silently shared one device credential key
    /// and OpenMLS correctly rejected the add as a duplicate signature
    /// key. Reopening a fresh Bob-namespaced store confirms his identity
    /// is truly independent (this is not just "does add succeed", but
    /// "does it succeed *because* the keys are genuinely different").
    #[test]
    fn add_member_succeeds_across_two_namespaces_in_one_process() {
        let _guard = TEST_STORES_LOCK.lock().unwrap();
        let dir = tempfile::tempdir().unwrap().keep();

        initialize(
            "isolation-alice".to_string(),
            dir.join("iso-alice-secrets.bin").to_string_lossy().into_owned(),
            dir.join("iso-alice-group.sqlite").to_string_lossy().into_owned(),
            vec![31u8; 32],
        )
        .unwrap();
        generate_identity_key().unwrap();
        generate_device_credential().unwrap();
        let group_id = b"55555555-5555-5555-5555-555555555555".to_vec();
        create_group(group_id.clone()).unwrap();

        initialize(
            "isolation-bob".to_string(),
            dir.join("iso-bob-secrets.bin").to_string_lossy().into_owned(),
            dir.join("iso-bob-group.sqlite").to_string_lossy().into_owned(),
            vec![32u8; 32],
        )
        .unwrap();
        generate_identity_key().unwrap();
        generate_device_credential().unwrap();
        let bob_key_package = generate_key_packages(1).unwrap().remove(0);

        initialize(
            "isolation-alice".to_string(),
            dir.join("iso-alice-secrets.bin").to_string_lossy().into_owned(),
            dir.join("iso-alice-group.sqlite").to_string_lossy().into_owned(),
            vec![31u8; 32],
        )
        .unwrap();
        let welcome_bytes = add_member_to_group(group_id, bob_key_package)
            .expect("adding a genuinely independent account's KeyPackage must succeed");
        assert!(!welcome_bytes.is_empty());
    }
}
