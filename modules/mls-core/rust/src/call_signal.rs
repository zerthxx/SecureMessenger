//! Sealing for 1:1 call signaling — SDP offers/answers and ICE candidates.
//!
//! The server relays call signaling (see the server's realtime protocol) but
//! must not be able to read it or tamper with it: SDP carries the DTLS
//! certificate fingerprints that authenticate the media connection, so a
//! server able to rewrite them could insert itself into the call. Candidates
//! also reveal each phone's network addresses.
//!
//! The key comes from the conversation's MLS group through the MLS exporter
//! (RFC 9420 §8.5): every member of the group derives the same secret for a
//! given call id, and nobody outside the group can. Deriving it is read-only
//! — no MLS message is created or consumed and no ratchet advances — so call
//! signaling can never disturb the ordering-sensitive decryption of chat
//! messages in the same group.

use aes_gcm::{
    aead::{generic_array::GenericArray, Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use openmls::prelude::{GroupId, MlsGroup};
use openmls_traits::OpenMlsProvider;
use rand::RngCore;
use zeroize::Zeroizing;

use crate::error::MlsCoreError;
use crate::group_storage::GroupProvider;

/// Exporter label; versioned so a future format can't be confused with this one.
const EXPORTER_LABEL: &str = "SecureMessenger call signaling v1";
const FORMAT_VERSION: u8 = 1;
const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;
const HEADER_LEN: usize = 1 + 8 + NONCE_LEN;

fn load_group(provider: &GroupProvider, group_id_bytes: &[u8]) -> Result<MlsGroup, MlsCoreError> {
    MlsGroup::load(provider.storage(), &GroupId::from_slice(group_id_bytes))
        .map_err(|_| MlsCoreError::GroupOperationFailed)?
        .ok_or(MlsCoreError::GroupNotFound)
}

/// Binds a sealed payload to its call and to the epoch whose secret keyed it.
fn associated_data(call_id: &str, epoch: u64) -> Vec<u8> {
    let mut aad = Vec::with_capacity(7 + 8 + call_id.len());
    aad.extend_from_slice(b"SMCALL1");
    aad.extend_from_slice(&epoch.to_be_bytes());
    aad.extend_from_slice(call_id.as_bytes());
    aad
}

fn cipher_for(provider: &GroupProvider, group: &MlsGroup, call_id: &str) -> Result<Aes256Gcm, MlsCoreError> {
    let key = Zeroizing::new(
        group
            .export_secret(provider.crypto(), EXPORTER_LABEL, call_id.as_bytes(), KEY_LEN)
            .map_err(|_| MlsCoreError::GroupOperationFailed)?,
    );
    Ok(Aes256Gcm::new(GenericArray::from_slice(&key)))
}

/// Seals `plaintext` for the other members of the group.
/// Output: version (1) ‖ epoch (u64, big-endian) ‖ nonce (12) ‖ AES-256-GCM ciphertext and tag.
pub fn seal_call_signal(
    provider: &GroupProvider,
    group_id_bytes: &[u8],
    call_id: &str,
    plaintext: &str,
) -> Result<Vec<u8>, MlsCoreError> {
    if call_id.is_empty() {
        return Err(MlsCoreError::InvalidInput);
    }
    let group = load_group(provider, group_id_bytes)?;
    let epoch = group.epoch().as_u64();
    let cipher = cipher_for(provider, &group, call_id)?;

    let mut nonce = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce);
    let aad = associated_data(call_id, epoch);
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: plaintext.as_bytes(), aad: &aad })
        .map_err(|_| MlsCoreError::GroupOperationFailed)?;

    let mut sealed = Vec::with_capacity(HEADER_LEN + ciphertext.len());
    sealed.push(FORMAT_VERSION);
    sealed.extend_from_slice(&epoch.to_be_bytes());
    sealed.extend_from_slice(&nonce);
    sealed.extend_from_slice(&ciphertext);
    Ok(sealed)
}

/// Opens a payload sealed by another member of the group for the same call.
/// Returns `InvalidCiphertext` for anything tampered with, sealed for a
/// different call or group, or sealed in an epoch this device isn't in.
pub fn open_call_signal(
    provider: &GroupProvider,
    group_id_bytes: &[u8],
    call_id: &str,
    sealed: &[u8],
) -> Result<String, MlsCoreError> {
    if call_id.is_empty() || sealed.len() <= HEADER_LEN || sealed[0] != FORMAT_VERSION {
        return Err(MlsCoreError::InvalidCiphertext);
    }
    let mut epoch_bytes = [0u8; 8];
    epoch_bytes.copy_from_slice(&sealed[1..9]);
    let epoch = u64::from_be_bytes(epoch_bytes);

    let group = load_group(provider, group_id_bytes)?;
    // The exporter only covers the current epoch; a different one can't be opened here.
    if group.epoch().as_u64() != epoch {
        return Err(MlsCoreError::InvalidCiphertext);
    }
    let cipher = cipher_for(provider, &group, call_id)?;
    let aad = associated_data(call_id, epoch);
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&sealed[9..HEADER_LEN]), Payload { msg: &sealed[HEADER_LEN..], aad: &aad })
        .map_err(|_| MlsCoreError::InvalidCiphertext)?;
    String::from_utf8(plaintext).map_err(|_| MlsCoreError::InvalidCiphertext)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::group;
    use openmls::prelude::{BasicCredential, Ciphersuite, CredentialWithKey};
    use openmls_basic_credential::SignatureKeyPair;
    use tls_codec::Serialize as _;

    const CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
    const GROUP_ID: &[u8] = b"22222222-2222-2222-2222-222222222222";
    const CALL_ID: &str = "33333333-3333-4333-8333-333333333333";

    struct Device {
        provider: GroupProvider,
        key: SignatureKeyPair,
    }

    fn device(name: &str) -> Device {
        let dir = tempfile::tempdir().unwrap().keep();
        let provider = GroupProvider::open(&dir.join(format!("{name}-group.sqlite")), &[9u8; 32]).unwrap();
        let key = SignatureKeyPair::new(openmls_traits::types::SignatureScheme::ED25519).unwrap();
        Device { provider, key }
    }

    /// Two devices sharing one group, set up the way a 1:1 conversation is.
    fn joined_pair() -> (Device, Device) {
        let caller = device("caller");
        let callee = device("callee");
        group::create_group(&caller.provider, &caller.key, GROUP_ID).unwrap();
        let credential_with_key = CredentialWithKey {
            credential: BasicCredential::new(callee.key.public().to_vec()).into(),
            signature_key: callee.key.public().into(),
        };
        let bundle = openmls::key_packages::KeyPackage::builder()
            .build(CIPHERSUITE, &callee.provider, &callee.key, credential_with_key)
            .unwrap();
        group::register_key_package_for_group_join(&callee.provider, &bundle).unwrap();
        let key_package = bundle.key_package().tls_serialize_detached().unwrap();
        let welcome = group::add_member_and_get_welcome(&caller.provider, &caller.key, GROUP_ID, &key_package).unwrap();
        group::join_group_from_welcome(&callee.provider, &welcome).unwrap();
        (caller, callee)
    }

    #[test]
    fn each_member_opens_what_the_other_sealed() {
        let (caller, callee) = joined_pair();
        let offer = r#"{"type":"offer","sdp":"v=0 a=fingerprint:sha-256 AB:CD:EF"}"#;
        let sealed = seal_call_signal(&caller.provider, GROUP_ID, CALL_ID, offer).unwrap();
        assert!(!sealed.windows(offer.len()).any(|window| window == offer.as_bytes()));
        assert_eq!(open_call_signal(&callee.provider, GROUP_ID, CALL_ID, &sealed).unwrap(), offer);

        let answer = r#"{"type":"answer","sdp":"v=0"}"#;
        let sealed_answer = seal_call_signal(&callee.provider, GROUP_ID, CALL_ID, answer).unwrap();
        assert_eq!(open_call_signal(&caller.provider, GROUP_ID, CALL_ID, &sealed_answer).unwrap(), answer);

        // A fresh nonce every time: the same signal never produces the same bytes.
        assert_ne!(seal_call_signal(&caller.provider, GROUP_ID, CALL_ID, offer).unwrap(), sealed);
    }

    #[test]
    fn rejects_tampering_other_calls_other_epochs_and_non_members() {
        let (caller, callee) = joined_pair();
        let sealed = seal_call_signal(&caller.provider, GROUP_ID, CALL_ID, "candidate:1 1 udp").unwrap();
        let invalid = |bytes: &[u8], call_id: &str| {
            matches!(open_call_signal(&callee.provider, GROUP_ID, call_id, bytes), Err(MlsCoreError::InvalidCiphertext))
        };

        let mut tampered = sealed.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 0x01;
        assert!(invalid(&tampered, CALL_ID));
        assert!(invalid(&sealed, "44444444-4444-4444-8444-444444444444"));

        let mut other_epoch = sealed.clone();
        other_epoch[8] ^= 0x01;
        assert!(invalid(&other_epoch, CALL_ID));
        assert!(invalid(&sealed[..HEADER_LEN], CALL_ID));

        let outsider = device("outsider");
        assert!(matches!(
            open_call_signal(&outsider.provider, GROUP_ID, CALL_ID, &sealed),
            Err(MlsCoreError::GroupNotFound)
        ));
    }

    #[test]
    fn call_signaling_does_not_disturb_chat_message_decryption() {
        let (caller, callee) = joined_pair();
        let before = group::encrypt_message(&caller.provider, &caller.key, GROUP_ID, "before the call").unwrap();
        for index in 0..20 {
            let sealed = seal_call_signal(&caller.provider, GROUP_ID, CALL_ID, &format!("candidate {index}")).unwrap();
            open_call_signal(&callee.provider, GROUP_ID, CALL_ID, &sealed).unwrap();
        }
        let after = group::encrypt_message(&caller.provider, &caller.key, GROUP_ID, "after the call").unwrap();
        assert_eq!(group::decrypt_message(&callee.provider, GROUP_ID, &before).unwrap(), "before the call");
        assert_eq!(group::decrypt_message(&callee.provider, GROUP_ID, &after).unwrap(), "after the call");
    }
}
