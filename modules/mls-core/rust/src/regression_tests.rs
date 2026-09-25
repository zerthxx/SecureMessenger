//! Regression tests for the "Unable to decrypt this message" failures.
//!
//! Each device here is a fully independent `GroupProvider` + signing key
//! talking to the others only through serialized bytes, like lib.rs's
//! `two_device_end_to_end_proof`. The failure modes they pin down:
//!
//! 1. A peer with several devices: adding them one commit at a time (and
//!    never delivering those commits) stranded every device but the last.
//! 2. Both members creating the conversation's group concurrently: two
//!    groups with one id, each side's Welcome rejected as "already exists".
//! 3. A retry after a failed Welcome delivery re-adding the same device:
//!    rejected forever as a duplicate signature key.
//! 4. Devices already stuck in states 1–3 had no way back.
//! 5. Every decrypt failure looked identical, so "this device is behind"
//!    couldn't be told apart from tampering.

use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use tls_codec::Serialize as _;

use crate::error::MlsCoreError;
use crate::group;
use crate::group_storage::GroupProvider;

const CS: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

struct Dev {
    provider: GroupProvider,
    key: SignatureKeyPair,
    path: std::path::PathBuf,
}

impl Dev {
    fn new(name: &str) -> Self {
        let dir = tempfile::tempdir().unwrap().keep();
        let path = dir.join(format!("{name}.enc"));
        Dev {
            provider: GroupProvider::open(&path, &[9u8; 32]).unwrap(),
            key: SignatureKeyPair::new(openmls_traits::types::SignatureScheme::ED25519).unwrap(),
            path,
        }
    }

    /// A fresh KeyPackage for this device. Calling it twice models two
    /// server device rows for one install (signed out and in again, or an
    /// old session that never expired): same signing key, new KeyPackage.
    fn key_package(&self) -> Vec<u8> {
        let cwk = CredentialWithKey {
            credential: BasicCredential::new(self.key.public().to_vec()).into(),
            signature_key: self.key.public().into(),
        };
        let bundle = KeyPackage::builder().build(CS, &self.provider, &self.key, cwk).unwrap();
        group::register_key_package_for_group_join(&self.provider, &bundle).unwrap();
        self.provider.checkpoint().unwrap();
        bundle.key_package().tls_serialize_detached().unwrap()
    }

    fn rebuild(&self, gid: &[u8], kps: &[Vec<u8>]) -> group::RebuiltGroup {
        let rebuilt = group::rebuild_group(&self.provider, &self.key, gid, kps).unwrap();
        self.provider.checkpoint().unwrap();
        rebuilt
    }

    fn join(&self, welcome: &[u8]) {
        group::join_group_replacing(&self.provider, welcome).unwrap();
        self.provider.checkpoint().unwrap();
    }

    fn send(&self, gid: &[u8], text: &str) -> Vec<u8> {
        group::encrypt_message(&self.provider, &self.key, gid, text).unwrap()
    }

    fn read(&self, gid: &[u8], ct: &[u8]) -> Result<String, MlsCoreError> {
        // openmls debug_asserts on AEAD failure in debug builds (see lib.rs's
        // tamper test); that panic is reported as InvalidCiphertext, which is
        // exactly what release builds return.
        let hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| group::decrypt_message(&self.provider, gid, ct)));
        std::panic::set_hook(hook);
        outcome.unwrap_or(Err(MlsCoreError::InvalidCiphertext))
    }
}

fn assert_all_talk(devs: &[&Dev], gid: &[u8]) {
    for (i, sender) in devs.iter().enumerate() {
        let text = format!("from device {i}");
        let ct = sender.send(gid, &text);
        for (j, receiver) in devs.iter().enumerate() {
            if i == j {
                continue;
            }
            assert_eq!(receiver.read(gid, &ct).ok().as_deref(), Some(text.as_str()), "device {j} must read device {i}");
        }
    }
}

#[test]
fn every_device_of_a_multi_device_peer_can_read_and_write() {
    let (a, b1, b2, a2) = (Dev::new("a"), Dev::new("b1"), Dev::new("b2"), Dev::new("a2"));
    let gid = b"conv-multi-device".to_vec();
    // The peer's two devices AND the creator's own second device, one commit.
    let rebuilt = a.rebuild(&gid, &[b1.key_package(), b2.key_package(), a2.key_package()]);
    assert_eq!(rebuilt.included, vec![0, 1, 2]);
    for d in [&b1, &b2, &a2] {
        d.join(&rebuilt.welcome);
    }
    // Several consecutive messages in every direction.
    for _ in 0..3 {
        assert_all_talk(&[&a, &b1, &b2, &a2], &gid);
    }
}

#[test]
fn concurrent_creation_converges_on_the_group_the_server_accepted() {
    let (a, b) = (Dev::new("fa"), Dev::new("fb"));
    let gid = b"conv-concurrent".to_vec();
    // Both sides build a group for the same conversation before seeing the other's.
    let from_a = a.rebuild(&gid, &[b.key_package()]);
    let _from_b = b.rebuild(&gid, &[a.key_package()]);
    // The server accepts A's (first) and rejects B's; B joins A's, replacing its own.
    b.join(&from_a.welcome);
    assert_all_talk(&[&a, &b], &gid);
}

#[test]
fn rebuilding_after_an_undelivered_welcome_succeeds() {
    let (a, b) = (Dev::new("ra"), Dev::new("rb"));
    let gid = b"conv-retry".to_vec();
    let _lost = a.rebuild(&gid, &[b.key_package()]);
    // The Welcome never reached the server. The retry starts over with a
    // fresh KeyPackage instead of adding B a second time.
    let retry = a.rebuild(&gid, &[b.key_package()]);
    b.join(&retry.welcome);
    assert_all_talk(&[&a, &b], &gid);
}

#[test]
fn a_device_stranded_by_the_old_sequential_adds_recovers_by_rebuilding() {
    let (a, b1, b2) = (Dev::new("sa"), Dev::new("sb1"), Dev::new("sb2"));
    let gid = b"conv-stranded".to_vec();
    // Pre-fix state: B1 joined at epoch 1, A and B2 are at epoch 2.
    group::create_group(&a.provider, &a.key, &gid).unwrap();
    let w1 = group::add_member_and_get_welcome(&a.provider, &a.key, &gid, &b1.key_package()).unwrap();
    let w2 = group::add_member_and_get_welcome(&a.provider, &a.key, &gid, &b2.key_package()).unwrap();
    group::join_group_from_welcome(&b1.provider, &w1).unwrap();
    group::join_group_from_welcome(&b2.provider, &w2).unwrap();

    // B1 can tell it is behind rather than seeing a generic failure...
    let from_a = a.send(&gid, "you missed a commit");
    assert!(matches!(b1.read(&gid, &from_a), Err(MlsCoreError::MessageFromFutureEpoch)));
    // ...and A can tell B1's message is from an epoch it has left.
    let from_b1 = b1.send(&gid, "stale");
    assert!(matches!(a.read(&gid, &from_b1), Err(MlsCoreError::MessageFromPastEpoch)));

    // B1 rebuilds the group for everyone; A and B2 replace their copies.
    let rebuilt = b1.rebuild(&gid, &[a.key_package(), b2.key_package()]);
    a.join(&rebuilt.welcome);
    b2.join(&rebuilt.welcome);
    assert_all_talk(&[&a, &b1, &b2], &gid);
}

#[test]
fn forked_groups_from_before_the_fix_recover_by_rebuilding() {
    let (a, b) = (Dev::new("xa"), Dev::new("xb"));
    let gid = b"conv-legacy-fork".to_vec();
    group::create_group(&a.provider, &a.key, &gid).unwrap();
    group::create_group(&b.provider, &b.key, &gid).unwrap();
    let wa = group::add_member_and_get_welcome(&a.provider, &a.key, &gid, &b.key_package()).unwrap();
    let _ = group::add_member_and_get_welcome(&b.provider, &b.key, &gid, &a.key_package()).unwrap();
    // The old join refused the Welcome; this is what left both sides stuck.
    assert!(group::join_group_from_welcome(&b.provider, &wa).is_err());
    let ct = a.send(&gid, "unreadable before the fix");
    assert!(b.read(&gid, &ct).is_err());

    let rebuilt = b.rebuild(&gid, &[a.key_package()]);
    a.join(&rebuilt.welcome);
    assert_all_talk(&[&a, &b], &gid);
}

#[test]
fn duplicate_own_and_invalid_key_packages_are_skipped_not_fatal() {
    let (a, b) = (Dev::new("da"), Dev::new("db"));
    let gid = b"conv-dedupe".to_vec();
    // Two server device rows for B's one install, A's own KeyPackage, and garbage.
    let kps = vec![b.key_package(), b.key_package(), a.key_package(), vec![1, 2, 3]];
    let rebuilt = a.rebuild(&gid, &kps);
    assert_eq!(rebuilt.included, vec![0]);
    b.join(&rebuilt.welcome);
    assert_all_talk(&[&a, &b], &gid);
}

#[test]
fn no_usable_key_package_leaves_the_existing_group_untouched() {
    let (a, b) = (Dev::new("na"), Dev::new("nb"));
    let gid = b"conv-no-kp".to_vec();
    let rebuilt = a.rebuild(&gid, &[b.key_package()]);
    b.join(&rebuilt.welcome);

    let err = group::rebuild_group(&a.provider, &a.key, &gid, &[vec![0u8; 4], a.key_package()]);
    assert!(matches!(err, Err(MlsCoreError::InvalidInput)));
    assert_all_talk(&[&a, &b], &gid);
}

#[test]
fn a_welcome_for_someone_else_cannot_replace_a_group() {
    let (a, b, c) = (Dev::new("wa"), Dev::new("wb"), Dev::new("wc"));
    let gid = b"conv-foreign-welcome".to_vec();
    let rebuilt = a.rebuild(&gid, &[b.key_package()]);
    b.join(&rebuilt.welcome);

    // C holds a group with the same id; a Welcome not addressed to C must be
    // rejected without deleting C's copy.
    c.rebuild(&gid, &[a.key_package()]);
    assert!(group::join_group_replacing(&c.provider, &rebuilt.welcome).is_err());
    assert!(group::join_group_replacing(&c.provider, b"not a welcome").is_err());
    assert_eq!(group::member_signature_keys(&c.provider, &gid).unwrap().len(), 2);
}

#[test]
fn own_messages_are_reported_as_such() {
    let (a, b) = (Dev::new("oa"), Dev::new("ob"));
    let gid = b"conv-own".to_vec();
    let rebuilt = a.rebuild(&gid, &[b.key_package()]);
    b.join(&rebuilt.welcome);
    let mine = a.send(&gid, "mine");
    assert!(matches!(a.read(&gid, &mine), Err(MlsCoreError::OwnMessage)));
}

#[test]
fn tampered_ciphertext_is_still_rejected() {
    let (a, b) = (Dev::new("ta"), Dev::new("tb"));
    let gid = b"conv-tamper".to_vec();
    let rebuilt = a.rebuild(&gid, &[b.key_package()]);
    b.join(&rebuilt.welcome);
    let mut ct = a.send(&gid, "tamper me");
    let last = ct.len() - 1;
    ct[last] ^= 0xFF;
    assert!(matches!(b.read(&gid, &ct), Err(MlsCoreError::InvalidCiphertext)));
}

#[test]
fn a_replayed_welcome_cannot_be_joined_twice() {
    let (a, b) = (Dev::new("ya"), Dev::new("yb"));
    let gid = b"conv-replay".to_vec();
    let first = a.rebuild(&gid, &[b.key_package()]);
    b.join(&first.welcome);
    // A later rebuild moves everyone on; replaying the first Welcome must
    // not roll B back onto the retired group (its KeyPackage is spent).
    let second = a.rebuild(&gid, &[b.key_package()]);
    b.join(&second.welcome);
    assert!(group::join_group_replacing(&b.provider, &first.welcome).is_err());
    assert_all_talk(&[&a, &b], &gid);
}

#[test]
fn member_keys_list_every_device_in_the_group() {
    let (a, b1, b2) = (Dev::new("ma"), Dev::new("mb1"), Dev::new("mb2"));
    let gid = b"conv-members".to_vec();
    a.rebuild(&gid, &[b1.key_package(), b2.key_package()]);
    let mut keys = group::member_signature_keys(&a.provider, &gid).unwrap();
    keys.sort();
    let mut expected = vec![a.key.public().to_vec(), b1.key.public().to_vec(), b2.key.public().to_vec()];
    expected.sort();
    assert_eq!(keys, expected);
    assert!(group::member_signature_keys(&a.provider, b"no-such-group").unwrap().is_empty());
}

#[test]
fn a_rebuilt_and_joined_group_survives_an_app_restart() {
    let (a, b) = (Dev::new("pa"), Dev::new("pb"));
    let gid = b"conv-restart".to_vec();
    let rebuilt = a.rebuild(&gid, &[b.key_package()]);
    b.join(&rebuilt.welcome);
    let before_restart = a.send(&gid, "before restart");

    // Kill and relaunch B: only the encrypted blob on disk survives.
    let Dev { provider, key, path } = b;
    drop(provider);
    let b = Dev { provider: GroupProvider::open(&path, &[9u8; 32]).unwrap(), key, path };
    assert_eq!(b.read(&gid, &before_restart).unwrap(), "before restart");
    assert_all_talk(&[&a, &b], &gid);

    // Deleting is idempotent and really removes it.
    group::delete_group(&b.provider, &gid).unwrap();
    group::delete_group(&b.provider, &gid).unwrap();
    assert!(group::member_signature_keys(&b.provider, &gid).unwrap().is_empty());
}

/// A send that reached the server twice (a network-level retry of the same
/// request) stores one ciphertext twice. The second copy must be reported as
/// a duplicate — not as an authentication failure, which showed "Unable to
/// decrypt this message" and made devices rebuild the group.
#[test]
fn a_replayed_ciphertext_is_a_duplicate_not_a_failure() {
    let (a, b) = (Dev::new("dupa"), Dev::new("dupb"));
    let gid = b"conv-duplicate".to_vec();
    let rebuilt = a.rebuild(&gid, &[b.key_package()]);
    b.join(&rebuilt.welcome);
    let ct = a.send(&gid, "sent once, stored twice");
    assert_eq!(b.read(&gid, &ct).unwrap(), "sent once, stored twice");
    assert!(matches!(b.read(&gid, &ct), Err(MlsCoreError::DuplicateMessage)));
    // And the conversation carries on normally.
    assert_all_talk(&[&a, &b], &gid);
}
