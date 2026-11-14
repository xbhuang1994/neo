//! Stable content-derived identifiers; equal inputs always produce the same id.

use sha2::{Digest, Sha256};

/// The first 32 hex characters of the SHA-256 of the JSON array of `values`.
pub fn key(values: &[&str]) -> String {
    let json = serde_json::to_string(values).expect("strings serialize");
    let digest = Sha256::digest(json.as_bytes());
    let mut out = String::with_capacity(32);
    for byte in &digest[..16] {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::key;

    #[test]
    fn is_stable_and_separates_parts() {
        assert_eq!(key(&["a", "b"]), key(&["a", "b"]));
        assert_ne!(key(&["a", "b"]), key(&["ab"]));
        assert_eq!(key(&["trigger", "chat", "m1"]).len(), 32);
        assert!(key(&["a"]).bytes().all(|b| b.is_ascii_hexdigit()));
    }
}
