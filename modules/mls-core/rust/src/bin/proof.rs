//! Phase 5C consolidated proof driver.
//!
//! Calls the exact same public functions the real Kotlin/UniFFI layer
//! calls (`mls_core::initialize`, `generate_identity_key`, …) — not a
//! separate crypto path — with each "device" being one process
//! invocation pointed at its own on-disk storage files via CLI args, so
//! state genuinely persists across invocations exactly as it would
//! across separate app launches on separate phones. See the Phase 5C
//! report for how this is combined with real `curl` calls against the
//! live server to prove the full device -> server -> device path.
//!
//! Usage (see the Phase 5C report for the exact invocations used):
//!   proof setup-device <secrets-path> <group-path>
//!       -> initializes a device's stores, generates identity/device
//!          keys, prints DEVICE_PUBLIC_KEY_B64
//!   proof create-group <secrets-path> <group-path> <group-id-b64>
//!       -> creates a persistent MLS group
//!   proof generate-key-package <secrets-path> <group-path>
//!       -> prints KEY_PACKAGE_B64
//!   proof add-member <secrets-path> <group-path> <group-id-b64> <key-package-b64>
//!       -> prints WELCOME_B64
//!   proof join-welcome <secrets-path> <group-path> <welcome-b64>
//!       -> prints GROUP_ID_B64
//!   proof encrypt <secrets-path> <group-path> <group-id-b64> <plaintext>
//!       -> prints CIPHERTEXT_B64
//!   proof decrypt <secrets-path> <group-path> <group-id-b64> <ciphertext-b64>
//!       -> prints PLAINTEXT

use base64::Engine;
use mls_core::*;

fn b64_encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn b64_decode(s: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD.decode(s).expect("invalid base64 input")
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let command = args.get(1).expect("missing command").as_str();

    match command {
        "setup-device" => {
            let secrets_path = args[2].clone();
            let group_path = args[3].clone();
            // Deterministic-for-this-proof master key: fine for a CLI
            // verification tool exercising the exact same storage/crypto
            // code paths as the real app, which always sources this from
            // the platform Keystore/Keychain instead — see storage.rs.
            initialize(secrets_path.clone(), secrets_path, group_path, vec![0x42u8; 32]).expect("initialize failed");
            generate_identity_key().expect("identity key failed");
            let device = generate_device_credential().expect("device credential failed");
            println!("DEVICE_PUBLIC_KEY_B64={}", b64_encode(&device.credential_public_key));
        }
        "create-group" => {
            let secrets_path = args[2].clone();
            let group_path = args[3].clone();
            let group_id = b64_decode(&args[4]);
            initialize(secrets_path.clone(), secrets_path, group_path, vec![0x42u8; 32]).expect("initialize failed");
            create_group(group_id).expect("create_group failed");
            println!("GROUP_CREATED=true");
        }
        "generate-key-package" => {
            let secrets_path = args[2].clone();
            let group_path = args[3].clone();
            initialize(secrets_path.clone(), secrets_path, group_path, vec![0x42u8; 32]).expect("initialize failed");
            let packages = generate_key_packages(1).expect("generate_key_packages failed");
            println!("KEY_PACKAGE_B64={}", b64_encode(&packages[0]));
        }
        "add-member" => {
            let secrets_path = args[2].clone();
            let group_path = args[3].clone();
            let group_id = b64_decode(&args[4]);
            let key_package = b64_decode(&args[5]);
            initialize(secrets_path.clone(), secrets_path, group_path, vec![0x42u8; 32]).expect("initialize failed");
            let welcome = add_member_to_group(group_id, key_package).expect("add_member_to_group failed");
            println!("WELCOME_B64={}", b64_encode(&welcome));
        }
        "join-welcome" => {
            let secrets_path = args[2].clone();
            let group_path = args[3].clone();
            let welcome = b64_decode(&args[4]);
            initialize(secrets_path.clone(), secrets_path, group_path, vec![0x42u8; 32]).expect("initialize failed");
            let group_id = join_group_from_welcome(welcome).expect("join_group_from_welcome failed");
            println!("GROUP_ID_B64={}", b64_encode(&group_id));
        }
        "encrypt" => {
            let secrets_path = args[2].clone();
            let group_path = args[3].clone();
            let group_id = b64_decode(&args[4]);
            let plaintext = args[5].clone();
            initialize(secrets_path.clone(), secrets_path, group_path, vec![0x42u8; 32]).expect("initialize failed");
            let ciphertext = encrypt_message(group_id, plaintext).expect("encrypt_message failed");
            println!("CIPHERTEXT_B64={}", b64_encode(&ciphertext));
        }
        "decrypt" => {
            let secrets_path = args[2].clone();
            let group_path = args[3].clone();
            let group_id = b64_decode(&args[4]);
            let ciphertext = b64_decode(&args[5]);
            initialize(secrets_path.clone(), secrets_path, group_path, vec![0x42u8; 32]).expect("initialize failed");
            match decrypt_message(group_id, ciphertext) {
                Ok(plaintext) => println!("PLAINTEXT={plaintext}"),
                Err(e) => println!("DECRYPT_ERROR={e:?}"),
            }
        }
        other => panic!("unknown command: {other}"),
    }
}
