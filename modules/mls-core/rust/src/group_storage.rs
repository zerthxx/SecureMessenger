//! Persistent MLS group state — Phase 5C, encrypted at rest — Phase 5D.
//!
//! # Why this is a separate store from storage.rs (Phase 5B)
//!
//! Phase 5B's `SecretsStore` persists three small, infrequently-written
//! things (the account identity key, this device's credential key, and
//! KeyPackage bundles) via a hand-rolled encrypted snapshot file. That
//! was a deliberate, narrow choice for those specific secrets — it was
//! never meant to grow into a general MLS storage backend, and Phase 5C
//! is explicit that it shouldn't.
//!
//! MLS group state (the ratchet tree, epoch secrets, message secrets,
//! proposal queue, own leaf index, …) is a different kind of data
//! entirely: it's large relative to a signing key, it's written on
//! nearly every group operation (not just at setup), and OpenMLS's own
//! `StorageProvider` trait models it as ~50 distinct read/write/delete
//! methods spanning the full group lifecycle. Reimplementing that trait
//! by hand — as Phase 5B considered and rejected for the same reason —
//! would mean a large amount of new, untested code sitting directly in
//! the path of every message send/receive.
//!
//! Instead this file wires in `openmls_sqlite_storage::SqliteStorageProvider`
//! — the storage backend the OpenMLS project itself ships and maintains
//! (`openmls`'s own `sqlite-provider` feature) — as the `StorageProvider`
//! half of a small local `OpenMlsProvider` that pairs it with the same
//! `openmls_rust_crypto::RustCrypto` crypto/randomness backend already
//! used elsewhere in this crate. `SqliteStorageProvider`'s own method
//! surface (`run_migrations`, and the ~50 `StorageProvider` trait methods
//! OpenMLS itself calls) is completely untouched by Phase 5D — nothing
//! below reimplements or wraps it.
//!
//! # Phase 5D: encryption at rest
//!
//! Phase 5C deliberately left the SQLite file unencrypted at the
//! application layer (protected only by Android's private-app-sandbox
//! permissions) — a judged, explicitly-documented tradeoff for that
//! phase's proportionate scope. Phase 5D closes that gap.
//!
//! Full page-level encryption (SQLCipher) was considered and rejected for
//! this phase: `openmls_sqlite_storage` hard-requires rusqlite's
//! `"bundled"` feature, which is mutually exclusive with SQLCipher's
//! `"bundled-sqlcipher*"` features at the Cargo level. Using SQLCipher
//! here would mean forking/patching `openmls_sqlite_storage`'s own
//! manifest and vendoring OpenSSL for Android cross-compilation — a much
//! larger, riskier architectural change than "harden the existing
//! foundation" calls for, and it forks an OpenMLS-maintained crate's
//! build configuration rather than just using it. See the Phase 5D report
//! for the full option comparison.
//!
//! Instead, this file:
//!
//! 1. Backs `SqliteStorageProvider` with a **named, shared-cache SQLite
//!    in-memory database** (`file:mls_core_group_mem?mode=memory&cache=shared`)
//!    instead of a plain on-disk file. Nothing OpenMLS writes ever touches
//!    disk directly — the live database only ever exists in process
//!    memory. This is standard SQLite functionality (not custom crypto),
//!    scoped to this process only (in-memory shared-cache databases are
//!    never visible across processes or devices).
//! 2. After every group-mutating operation (see `lib.rs::with_group_store`,
//!    the single choke point all group.rs calls go through), the live
//!    in-memory database is snapshotted via SQLite's own online backup
//!    API (`rusqlite::backup`) to a short-lived on-disk temp file, read
//!    back into memory, encrypted with the same AES-256-GCM/Keystore
//!    master-key pattern `storage.rs`'s `SecretsStore` already uses (not
//!    a new primitive), and written to the permanent encrypted blob path
//!    (atomically, via write-to-temp + rename, so a mid-write crash can
//!    never corrupt the previously-good blob). The on-disk temp file used
//!    for the backup step is zeroed and deleted immediately after.
//! 3. On open, the reverse: the encrypted blob (if any) is decrypted to a
//!    short-lived on-disk temp file, restored into the in-memory database
//!    via the same backup API, and the temp file is zeroed and deleted.
//!
//! Net effect: the on-disk footprint of group state is, at all times
//! except for the brief duration of a single backup/restore call, exactly
//! one AES-256-GCM-encrypted blob — never a live, directly-readable
//! SQLite file. The remaining residual risk (a temp plaintext file
//! existing on disk for the duration of one backup call, and an
//! in-memory-only window of at most one operation's worth of state if the
//! process is killed between two checkpoints) is documented in the Phase
//! 5D report's "remaining risks".
//!
//! Application message *plaintext* is never written to this database or
//! anywhere else on disk — see group.rs: it exists only as a function
//! argument/return value, in process memory, for the duration of a
//! single encrypt/decrypt call.

use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    path::PathBuf,
    time::Duration,
};

use aes_gcm::{
    aead::{generic_array::GenericArray, Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use openmls_rust_crypto::RustCrypto;
use openmls_sqlite_storage::{Codec, Connection, SqliteStorageProvider};
use openmls_traits::OpenMlsProvider;
use rand::RngCore;
use rusqlite::{backup::Backup, OpenFlags};
use serde::{de::DeserializeOwned, Serialize};
use zeroize::Zeroize;

const NONCE_LEN: usize = 12;

/// Builds this store's named shared-cache in-memory database URI, derived
/// from its blob path so that two independent `GroupProvider`s open in
/// the same process (as the app itself only ever needs one at a time,
/// but the test suite's two-device simulation deliberately opens several
/// concurrently — see lib.rs tests) never collide on the same in-memory
/// pages. Every `Connection::open_with_flags` call using the same URI
/// (with `SQLITE_OPEN_URI` set) within this process sees the same
/// underlying pages — that's what lets `checkpoint`/restore open a
/// second, independent connection to back up from or restore into, while
/// `SqliteStorageProvider` keeps exclusive ownership of the primary one.
/// SQLite scopes shared-cache in-memory databases to the process; this
/// name has no meaning across processes or devices.
fn shared_memory_uri(blob_path: &std::path::Path) -> String {
    let mut hasher = DefaultHasher::new();
    blob_path.hash(&mut hasher);
    format!("file:mls_core_group_mem_{:x}?mode=memory&cache=shared", hasher.finish())
}

#[derive(Default)]
pub struct BincodeCodec;

impl Codec for BincodeCodec {
    type Error = bincode::Error;

    fn to_vec<T: Serialize>(value: &T) -> Result<Vec<u8>, Self::Error> {
        bincode::serialize(value)
    }

    fn from_slice<T: DeserializeOwned>(slice: &[u8]) -> Result<T, Self::Error> {
        bincode::deserialize(slice)
    }
}

type GroupStorageProvider = SqliteStorageProvider<BincodeCodec, Connection>;

pub struct GroupProvider {
    crypto: RustCrypto,
    storage: GroupStorageProvider,
    cipher: Aes256Gcm,
    /// This store's unique shared-cache in-memory database URI (see
    /// `shared_memory_uri`) — needed again at `checkpoint()` time to open
    /// a second connection to the same live in-memory pages.
    memory_uri: String,
    /// Path to the permanent AES-256-GCM-encrypted snapshot on disk.
    blob_path: PathBuf,
    /// Sibling path used only transiently, for the plaintext SQLite bytes
    /// during a backup/restore call — never holds anything longer than
    /// one `checkpoint()`/`open()` call.
    tmp_path: PathBuf,
}

fn open_shared_memory_connection(memory_uri: &str) -> Result<Connection, String> {
    Connection::open_with_flags(
        memory_uri,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|e| e.to_string())
}

/// Overwrites the file's bytes with zeros, then removes it. Best-effort —
/// filesystem-level guarantees about overwrite-in-place vary, but this is
/// strictly better than a bare delete for a file that briefly held
/// plaintext group state, and costs nothing meaningful given how small
/// this proof's databases are.
fn wipe_and_remove(path: &std::path::Path) {
    if let Ok(metadata) = fs::metadata(path) {
        let zeros = vec![0u8; metadata.len() as usize];
        let _ = fs::write(path, &zeros);
    }
    let _ = fs::remove_file(path);
}

fn encrypt_blob(cipher: &Aes256Gcm, mut plaintext: Vec<u8>) -> Result<Vec<u8>, String> {
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher.encrypt(nonce, plaintext.as_slice()).map_err(|_| "encrypt failed".to_string());
    plaintext.zeroize();
    let ciphertext = ciphertext?;

    let mut out = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

fn decrypt_blob(cipher: &Aes256Gcm, blob: &[u8]) -> Result<Vec<u8>, String> {
    if blob.len() < NONCE_LEN {
        return Err("corrupt group storage blob".to_string());
    }
    let (nonce_bytes, ciphertext) = blob.split_at(NONCE_LEN);
    let nonce = Nonce::from_slice(nonce_bytes);
    cipher.decrypt(nonce, ciphertext).map_err(|_| "decrypt failed".to_string())
}

/// Snapshots the live shared-memory database to an on-disk temp file via
/// SQLite's online backup API, reads the bytes back, and immediately
/// wipes the temp file. Returns the plaintext SQLite file bytes.
fn snapshot_memory_db_to_bytes(memory_uri: &str, tmp_path: &std::path::Path) -> Result<Vec<u8>, String> {
    let source = open_shared_memory_connection(memory_uri)?;
    if tmp_path.exists() {
        wipe_and_remove(tmp_path);
    }
    let mut dest = Connection::open(tmp_path).map_err(|e| e.to_string())?;
    {
        let backup = Backup::new(&source, &mut dest).map_err(|e| e.to_string())?;
        backup.run_to_completion(i32::MAX, Duration::from_millis(0), None).map_err(|e| e.to_string())?;
    }
    drop(dest);
    drop(source);

    let bytes = fs::read(tmp_path).map_err(|e| e.to_string())?;
    wipe_and_remove(tmp_path);
    Ok(bytes)
}

/// Reverse of `snapshot_memory_db_to_bytes`: writes `plaintext` to an
/// on-disk temp file, restores it into the live shared-memory database
/// via the backup API, then wipes the temp file.
fn restore_bytes_into_memory_db(memory_uri: &str, tmp_path: &std::path::Path, mut plaintext: Vec<u8>) -> Result<(), String> {
    if tmp_path.exists() {
        wipe_and_remove(tmp_path);
    }
    let write_result = fs::write(tmp_path, &plaintext);
    plaintext.zeroize();
    write_result.map_err(|e| e.to_string())?;

    let restore_result = (|| {
        let source = Connection::open(tmp_path).map_err(|e| e.to_string())?;
        let mut dest = open_shared_memory_connection(memory_uri)?;
        let backup = Backup::new(&source, &mut dest).map_err(|e| e.to_string())?;
        backup.run_to_completion(i32::MAX, Duration::from_millis(0), None).map_err(|e| e.to_string())
    })();

    wipe_and_remove(tmp_path);
    restore_result
}

impl GroupProvider {
    /// Opens (or creates) the encrypted group-state store at `blob_path`,
    /// decrypting and restoring any existing snapshot into a fresh
    /// process-local in-memory database. `master_key` is the same
    /// 32-byte Keystore-protected key used to open `storage.rs`'s
    /// `SecretsStore` — never generated or persisted by this module.
    pub fn open(blob_path: &std::path::Path, master_key: &[u8; 32]) -> Result<Self, String> {
        let cipher = Aes256Gcm::new(GenericArray::from_slice(master_key));
        let tmp_path = blob_path.with_extension("tmp");
        let memory_uri = shared_memory_uri(blob_path);

        // Hold one shared-cache connection open for the duration of this
        // function so the named in-memory database isn't torn down
        // between the restore step and handing a fresh connection to
        // SqliteStorageProvider below (SQLite drops a shared-cache
        // in-memory database once its last connection closes).
        let anchor = open_shared_memory_connection(&memory_uri)?;

        if blob_path.exists() {
            let blob = fs::read(blob_path).map_err(|e| e.to_string())?;
            let plaintext = decrypt_blob(&cipher, &blob)?;
            restore_bytes_into_memory_db(&memory_uri, &tmp_path, plaintext)?;
        }

        let primary = open_shared_memory_connection(&memory_uri)?;
        drop(anchor);

        let mut storage = SqliteStorageProvider::<BincodeCodec, Connection>::new(primary);
        storage.run_migrations().map_err(|e| e.to_string())?;

        Ok(Self {
            crypto: RustCrypto::default(),
            storage,
            cipher,
            memory_uri,
            blob_path: blob_path.to_path_buf(),
            tmp_path,
        })
    }

    /// Persists the current state of the live in-memory group database to
    /// the encrypted on-disk blob. Called once after every group-storage
    /// mutation (see `lib.rs::with_group_store`) — not something callers
    /// in `group.rs` need to think about individually.
    pub fn checkpoint(&self) -> Result<(), String> {
        let plaintext = snapshot_memory_db_to_bytes(&self.memory_uri, &self.tmp_path)?;
        let encrypted = encrypt_blob(&self.cipher, plaintext)?;

        // Write-to-temp-then-rename so a crash mid-write can never leave
        // a truncated/corrupt blob in place of a previously-good one.
        let write_tmp = self.blob_path.with_extension("blob.tmp");
        fs::write(&write_tmp, &encrypted).map_err(|e| e.to_string())?;
        fs::rename(&write_tmp, &self.blob_path).map_err(|e| e.to_string())?;
        Ok(())
    }
}

impl OpenMlsProvider for GroupProvider {
    type CryptoProvider = RustCrypto;
    type RandProvider = RustCrypto;
    type StorageProvider = GroupStorageProvider;

    fn storage(&self) -> &Self::StorageProvider {
        &self.storage
    }

    fn crypto(&self) -> &Self::CryptoProvider {
        &self.crypto
    }

    fn rand(&self) -> &Self::RandProvider {
        &self.crypto
    }
}
