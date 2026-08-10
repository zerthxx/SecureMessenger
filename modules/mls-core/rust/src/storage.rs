//! Encrypted-at-rest local storage for E2EE state.
//!
//! # Storage boundary (Phase 5B scope)
//!
//! This crate never implements OpenMLS's `StorageProvider` trait itself.
//! It uses OpenMLS's own official, unmodified [`OpenMlsRustCrypto`]
//! provider (crypto + randomness + an in-memory `MemoryStorage`) for
//! every call into OpenMLS — that's the already-correct, already-used-
//! in-production default the OpenMLS project ships.
//!
//! What this file adds is a persistence layer *around* that: after
//! generating the account identity key, the device credential key, or a
//! KeyPackage, the caller hands the resulting typed value to
//! [`SecretsStore`], which serializes it (`bincode`), encrypts it
//! (AES-256-GCM, RustCrypto `aes-gcm` — an established AEAD primitive,
//! not a custom construction) with a caller-supplied master key, and
//! writes it to a single small file. On the next launch, [`SecretsStore::open`]
//! decrypts that file and re-inserts each value into a fresh
//! `OpenMlsRustCrypto`'s `MemoryStorage` via OpenMLS's own real
//! `write_signature_key_pair`/`write_key_package` methods, so OpenMLS's
//! internal bookkeeping (e.g. looking up a KeyPackage by hash reference
//! when processing a future Welcome) sees exactly what it would have
//! seen if the process had never restarted.
//!
//! Scope: this covers exactly the three secrets Phase 5B defines a
//! boundary for — the account identity key, the device credential key,
//! and KeyPackage private bundles. MLS group state and epoch secrets
//! don't exist yet (no group APIs are called in this phase) and aren't
//! persisted here; Phase 5C is expected to extend this same
//! encrypt-on-write pattern once real group material exists to protect.
//!
//! The master key itself is never generated or persisted by this crate —
//! it is generated and held in the OS keystore (Android Keystore / iOS
//! Keychain) by the native module layer and passed in once per process
//! via [`crate::initialize`]. Nothing here ever writes it to disk.

use std::{fs, path::PathBuf, sync::RwLock};

use aes_gcm::{
    aead::{generic_array::GenericArray, Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::{types::SignatureScheme, OpenMlsProvider};
use rand::RngCore;
use serde::{Deserialize, Serialize};

const NONCE_LEN: usize = 12;

#[derive(Debug, thiserror::Error)]
pub enum SecretsStoreError {
    #[error("encryption error")]
    Crypto,
    #[error("serialization error")]
    Serde,
    #[error("io error")]
    Io,
    #[error("openmls storage error")]
    OpenMlsStorage,
}

#[derive(Clone, Serialize, Deserialize)]
struct EncryptedRecord {
    nonce: [u8; NONCE_LEN],
    ciphertext: Vec<u8>,
}

#[derive(Default, Serialize, Deserialize)]
struct PersistedSnapshot {
    identity_key: Option<EncryptedRecord>,
    device_credential_key: Option<EncryptedRecord>,
    key_packages: Vec<EncryptedRecord>,
}

/// Owns the live OpenMLS provider for this process plus the encrypted
/// on-disk snapshot that survives restarts. See module docs for exactly
/// what is and isn't persisted here.
pub struct SecretsStore {
    pub provider: OpenMlsRustCrypto,
    cipher: Aes256Gcm,
    file_path: PathBuf,
    identity_key: RwLock<Option<SignatureKeyPair>>,
    device_credential_key: RwLock<Option<SignatureKeyPair>>,
}

impl SecretsStore {
    pub fn open(file_path: PathBuf, master_key: &[u8; 32]) -> Result<Self, SecretsStoreError> {
        let cipher = Aes256Gcm::new(GenericArray::from_slice(master_key));

        let snapshot: PersistedSnapshot = if file_path.exists() {
            let bytes = fs::read(&file_path).map_err(|_| SecretsStoreError::Io)?;
            bincode::deserialize(&bytes).map_err(|_| SecretsStoreError::Serde)?
        } else {
            PersistedSnapshot::default()
        };

        let provider = OpenMlsRustCrypto::default();

        let identity_key = match &snapshot.identity_key {
            Some(record) => {
                let bytes = decrypt(&cipher, record)?;
                let key: SignatureKeyPair =
                    bincode::deserialize(&bytes).map_err(|_| SecretsStoreError::Serde)?;
                key.store(provider.storage())
                    .map_err(|_| SecretsStoreError::OpenMlsStorage)?;
                Some(key)
            }
            None => None,
        };

        let device_credential_key = match &snapshot.device_credential_key {
            Some(record) => {
                let bytes = decrypt(&cipher, record)?;
                let key: SignatureKeyPair =
                    bincode::deserialize(&bytes).map_err(|_| SecretsStoreError::Serde)?;
                key.store(provider.storage())
                    .map_err(|_| SecretsStoreError::OpenMlsStorage)?;
                Some(key)
            }
            None => None,
        };

        for record in &snapshot.key_packages {
            let bytes = decrypt(&cipher, record)?;
            let bundle: openmls::key_packages::KeyPackageBundle =
                bincode::deserialize(&bytes).map_err(|_| SecretsStoreError::Serde)?;
            use openmls_traits::storage::StorageProvider;
            let hash_ref = bundle
                .key_package()
                .hash_ref(provider.crypto())
                .map_err(|_| SecretsStoreError::OpenMlsStorage)?;
            provider
                .storage()
                .write_key_package(&hash_ref, &bundle)
                .map_err(|_| SecretsStoreError::OpenMlsStorage)?;
        }

        Ok(Self {
            provider,
            cipher,
            file_path,
            identity_key: RwLock::new(identity_key),
            device_credential_key: RwLock::new(device_credential_key),
        })
    }

    pub fn identity_key(&self) -> Option<SignatureKeyPair> {
        self.identity_key.read().ok().and_then(|g| g.clone())
    }

    pub fn device_credential_key(&self) -> Option<SignatureKeyPair> {
        self.device_credential_key.read().ok().and_then(|g| g.clone())
    }

    /// Generates and persists the account identity signing key. No-ops
    /// (returns the existing key) if one already exists on this device —
    /// this key is meant to be generated once, on first E2EE setup.
    pub fn get_or_create_identity_key(&self) -> Result<SignatureKeyPair, SecretsStoreError> {
        if let Some(existing) = self.identity_key() {
            return Ok(existing);
        }
        let key = SignatureKeyPair::new(SignatureScheme::ED25519)
            .map_err(|_| SecretsStoreError::Crypto)?;
        self.persist_identity_key(&key)?;
        *self.identity_key.write().map_err(|_| SecretsStoreError::Io)? = Some(key.clone());
        Ok(key)
    }

    /// Generates and persists this device's credential signing key.
    /// No-ops (returns the existing key) if one already exists.
    pub fn get_or_create_device_credential_key(&self) -> Result<SignatureKeyPair, SecretsStoreError> {
        if let Some(existing) = self.device_credential_key() {
            return Ok(existing);
        }
        let key = SignatureKeyPair::new(SignatureScheme::ED25519)
            .map_err(|_| SecretsStoreError::Crypto)?;
        self.persist_device_credential_key(&key)?;
        *self
            .device_credential_key
            .write()
            .map_err(|_| SecretsStoreError::Io)? = Some(key.clone());
        Ok(key)
    }

    pub fn persist_key_package(
        &self,
        bundle: &openmls::key_packages::KeyPackageBundle,
    ) -> Result<(), SecretsStoreError> {
        let bytes = bincode::serialize(bundle).map_err(|_| SecretsStoreError::Serde)?;
        let record = encrypt(&self.cipher, &bytes)?;
        self.with_snapshot_mut(|s| s.key_packages.push(record))
    }

    fn persist_identity_key(&self, key: &SignatureKeyPair) -> Result<(), SecretsStoreError> {
        let bytes = bincode::serialize(key).map_err(|_| SecretsStoreError::Serde)?;
        let record = encrypt(&self.cipher, &bytes)?;
        self.with_snapshot_mut(|s| s.identity_key = Some(record))
    }

    fn persist_device_credential_key(&self, key: &SignatureKeyPair) -> Result<(), SecretsStoreError> {
        let bytes = bincode::serialize(key).map_err(|_| SecretsStoreError::Serde)?;
        let record = encrypt(&self.cipher, &bytes)?;
        self.with_snapshot_mut(|s| s.device_credential_key = Some(record))
    }

    /// Read-modify-write the on-disk snapshot. The snapshot is small
    /// (identity key, device key, a handful of KeyPackages) and updated
    /// infrequently, so a read-decode-mutate-encode-write cycle per call
    /// is simple and correct rather than a performance concern.
    fn with_snapshot_mut(
        &self,
        f: impl FnOnce(&mut PersistedSnapshot),
    ) -> Result<(), SecretsStoreError> {
        let mut snapshot: PersistedSnapshot = if self.file_path.exists() {
            let bytes = fs::read(&self.file_path).map_err(|_| SecretsStoreError::Io)?;
            bincode::deserialize(&bytes).map_err(|_| SecretsStoreError::Serde)?
        } else {
            PersistedSnapshot::default()
        };
        f(&mut snapshot);
        let bytes = bincode::serialize(&snapshot).map_err(|_| SecretsStoreError::Serde)?;
        fs::write(&self.file_path, bytes).map_err(|_| SecretsStoreError::Io)
    }
}

fn encrypt(cipher: &Aes256Gcm, plaintext: &[u8]) -> Result<EncryptedRecord, SecretsStoreError> {
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|_| SecretsStoreError::Crypto)?;
    Ok(EncryptedRecord {
        nonce: nonce_bytes,
        ciphertext,
    })
}

fn decrypt(cipher: &Aes256Gcm, record: &EncryptedRecord) -> Result<Vec<u8>, SecretsStoreError> {
    let nonce = Nonce::from_slice(&record.nonce);
    cipher
        .decrypt(nonce, record.ciphertext.as_ref())
        .map_err(|_| SecretsStoreError::Crypto)
}
