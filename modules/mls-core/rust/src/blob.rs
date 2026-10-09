//! Per-message content encryption for large media (voice clips).
//!
//! A clip used to be encrypted as an ordinary MLS application message and
//! fetched lazily, after the small envelope message that references it.
//! MLS application keys are single-use and a receiver keeps only a short
//! window of past keys per sender (OpenMLS `out_of_order_tolerance`, 5), so
//! a clip whose download was delayed past five later messages from the same
//! sender — a failed download, a device offline for a while — could never
//! be decrypted again; a group rebuild (which deletes the old group) lost
//! every clip not yet fetched. See regression_tests.rs `voice_blobs`.
//!
//! Instead the clip is sealed with its own random 256-bit key, and that key
//! travels inside the envelope — which is an MLS application message, so it
//! has exactly the MLS guarantees any chat message has. The sealed clip can
//! be opened by anyone holding the key at any later time, and by nobody
//! else: the server stores and serves it without being able to read it,
//! exactly as before.
//!
//! The key is message-scoped content, not device key material: it is
//! returned to the app (which puts it in the envelope and caches it next to
//! the decrypted message), the same trust tier as the message plaintext
//! itself. No long-lived secret is involved.
//!
//! Format: version (1) ‖ nonce (12) ‖ AES-256-GCM ciphertext and tag, with
//! the version string as associated data so a different format can never
//! be opened as this one.

use aes_gcm::{
    aead::{generic_array::GenericArray, Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use rand::RngCore;
use zeroize::Zeroizing;

use crate::error::MlsCoreError;

const FORMAT_VERSION: u8 = 1;
const ASSOCIATED_DATA: &[u8] = b"SMBLOB1";
pub const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;
const HEADER_LEN: usize = 1 + NONCE_LEN;

/// A fresh random content key for one clip.
pub fn generate_blob_key() -> Vec<u8> {
    let mut key = vec![0u8; KEY_LEN];
    rand::thread_rng().fill_bytes(&mut key);
    key
}

fn cipher_for(key: &[u8]) -> Result<Aes256Gcm, MlsCoreError> {
    if key.len() != KEY_LEN {
        return Err(MlsCoreError::InvalidInput);
    }
    let key = Zeroizing::new(key.to_vec());
    Ok(Aes256Gcm::new(GenericArray::from_slice(&key)))
}

/// Seals `plaintext` under `key`. A fresh nonce every call.
pub fn seal_blob(key: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, MlsCoreError> {
    let cipher = cipher_for(key)?;
    let mut nonce = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: plaintext, aad: ASSOCIATED_DATA })
        .map_err(|_| MlsCoreError::GroupOperationFailed)?;

    let mut out = Vec::with_capacity(HEADER_LEN + ciphertext.len());
    out.push(FORMAT_VERSION);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Opens a blob from [`seal_blob`]. `InvalidCiphertext` — never partial
/// output — for anything tampered with, sealed under another key, or not in
/// this format.
pub fn open_blob(key: &[u8], sealed: &[u8]) -> Result<Vec<u8>, MlsCoreError> {
    let cipher = cipher_for(key)?;
    if sealed.len() < HEADER_LEN || sealed[0] != FORMAT_VERSION {
        return Err(MlsCoreError::InvalidCiphertext);
    }
    let nonce = Nonce::from_slice(&sealed[1..HEADER_LEN]);
    cipher
        .decrypt(nonce, Payload { msg: &sealed[HEADER_LEN..], aad: ASSOCIATED_DATA })
        .map_err(|_| MlsCoreError::InvalidCiphertext)
}
