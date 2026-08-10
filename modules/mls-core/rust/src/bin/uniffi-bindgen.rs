//! Dev-only entry point for generating Kotlin/Swift bindings from this
//! crate's compiled library. Not shipped — this binary target exists
//! purely so `cargo run --bin uniffi-bindgen -- generate ...` works.

fn main() {
    uniffi::uniffi_bindgen_main()
}
