use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use russh::keys::{HashAlg, PublicKey};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status")]
pub enum KnownHostCheck {
    Trusted,
    Unknown,
    Changed { previous_fingerprint: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnownHostEntry {
    pub host_id: String,
    pub algorithm: String,
    pub fingerprint_sha256: String,
}

#[derive(Debug, Clone)]
struct StoredHostRecord {
    host_id: String,
    public_key: PublicKey,
}

pub struct KnownHostsStore {
    file_path: PathBuf,
    lock: Mutex<()>,
}

impl KnownHostsStore {
    pub fn new(file_path: PathBuf) -> AppResult<Self> {
        if let Some(parent) = file_path.parent() {
            fs::create_dir_all(parent)?;
        }
        if !file_path.exists() {
            fs::write(
                &file_path,
                "# LabBridge known_hosts — OpenSSH compatible format\n",
            )?;
        }
        Ok(Self {
            file_path,
            lock: Mutex::new(()),
        })
    }

    pub fn path(&self) -> &Path {
        &self.file_path
    }

    pub fn format_host_id(host: &str, port: u16) -> String {
        let normalized = host.trim().to_ascii_lowercase();
        if port == 22 {
            normalized
        } else {
            format!("[{}]:{}", normalized, port)
        }
    }

    pub fn fingerprint_sha256(key: &PublicKey) -> String {
        key.fingerprint(HashAlg::Sha256).to_string()
    }

    pub fn verify_key(
        &self,
        host: &str,
        port: u16,
        candidate: &PublicKey,
    ) -> AppResult<KnownHostCheck> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| AppError::KnownHosts("Known hosts lock poisoned".into()))?;
        let host_id = Self::format_host_id(host, port);
        let records = self.read_records_unlocked()?;

        let candidate_alg = candidate.algorithm();
        for rec in &records {
            if rec.host_id == host_id && rec.public_key.algorithm() == candidate_alg {
                if rec.public_key.key_data() == candidate.key_data() {
                    return Ok(KnownHostCheck::Trusted);
                } else {
                    return Ok(KnownHostCheck::Changed {
                        previous_fingerprint: Self::fingerprint_sha256(&rec.public_key),
                    });
                }
            }
        }

        // Also check if the host exists under another key algorithm and warn if desired,
        // or treat a new host/algorithm pair as Unknown (standard OpenSSH behavior when no matching alg exists,
        // unless a host entry exists with a different key and user should verify).
        for rec in &records {
            if rec.host_id == host_id && rec.public_key.key_data() != candidate.key_data() {
                return Ok(KnownHostCheck::Changed {
                    previous_fingerprint: format!(
                        "{} ({})",
                        Self::fingerprint_sha256(&rec.public_key),
                        rec.public_key.algorithm().as_str()
                    ),
                });
            }
        }

        Ok(KnownHostCheck::Unknown)
    }

    pub fn trust_key(&self, host: &str, port: u16, public_key: &PublicKey) -> AppResult<()> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| AppError::KnownHosts("Known hosts lock poisoned".into()))?;
        let host_id = Self::format_host_id(host, port);
        let mut records = self.read_records_unlocked()?;

        let clean_key = PublicKey::new(public_key.key_data().clone(), "");
        let candidate_alg = clean_key.algorithm();

        // Replace existing entry for this host (either matching algorithm or replacing rotated host key)
        records.retain(|rec| {
            !(rec.host_id == host_id
                && (rec.public_key.algorithm() == candidate_alg
                    || rec.public_key.key_data() != clean_key.key_data()))
        });
        records.push(StoredHostRecord {
            host_id,
            public_key: clean_key,
        });

        self.write_records_unlocked(&records)
    }

    pub fn list_entries(&self) -> AppResult<Vec<KnownHostEntry>> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| AppError::KnownHosts("Known hosts lock poisoned".into()))?;
        let records = self.read_records_unlocked()?;
        Ok(records
            .into_iter()
            .map(|r| KnownHostEntry {
                host_id: r.host_id,
                algorithm: r.public_key.algorithm().as_str().to_string(),
                fingerprint_sha256: Self::fingerprint_sha256(&r.public_key),
            })
            .collect())
    }

    pub fn remove_entry(&self, host_id: &str, algorithm: &str) -> AppResult<()> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| AppError::KnownHosts("Known hosts lock poisoned".into()))?;
        let mut records = self.read_records_unlocked()?;
        records.retain(|r| {
            !(r.host_id == host_id && r.public_key.algorithm().as_str() == algorithm)
        });
        self.write_records_unlocked(&records)
    }

    fn read_records_unlocked(&self) -> AppResult<Vec<StoredHostRecord>> {
        if !self.file_path.exists() {
            return Ok(Vec::new());
        }
        let raw = fs::read_to_string(&self.file_path)?;
        let mut out = Vec::new();
        for line in raw.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            let mut parts = trimmed.splitn(2, char::is_whitespace);
            let Some(host_part) = parts.next() else {
                continue;
            };
            let Some(key_part) = parts.next() else {
                continue;
            };
            let key_part = key_part.trim();
            if let Ok(pubkey) = PublicKey::from_openssh(key_part) {
                out.push(StoredHostRecord {
                    host_id: host_part.to_string(),
                    public_key: pubkey,
                });
            }
        }
        Ok(out)
    }

    fn write_records_unlocked(&self, records: &[StoredHostRecord]) -> AppResult<()> {
        let mut buf = String::from("# LabBridge known_hosts — OpenSSH compatible format\n");
        for rec in records {
            let openssh_key = rec
                .public_key
                .to_openssh()
                .map_err(|e| AppError::KnownHosts(format!("Failed to encode host key: {}", e)))?;
            buf.push_str(&rec.host_id);
            buf.push(' ');
            buf.push_str(&openssh_key);
            buf.push('\n');
        }

        let tmp_path = self.file_path.with_extension("tmp");
        fs::write(&tmp_path, buf.as_bytes())?;
        fs::rename(&tmp_path, &self.file_path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::keys::{Algorithm, PrivateKey};

    #[test]
    fn tofu_verify_trust_change_and_revoke() {
        let tmp_file = std::env::temp_dir().join(format!(
            "labbridge_known_hosts_test_{}",
            uuid::Uuid::new_v4()
        ));
        let store = KnownHostsStore::new(tmp_file.clone()).expect("init store");

        let mut rng = russh::keys::key::safe_rng();
        let key1 = PrivateKey::random(&mut rng, Algorithm::Ed25519)
            .expect("gen key1")
            .public_key()
            .clone();
        let key2 = PrivateKey::random(&mut rng, Algorithm::Ed25519)
            .expect("gen key2")
            .public_key()
            .clone();

        // 1. Unknown on first contact
        assert_eq!(
            store.verify_key("10.1.2.3", 2222, &key1).unwrap(),
            KnownHostCheck::Unknown
        );

        // 2. Trust key -> Trusted
        store.trust_key("10.1.2.3", 2222, &key1).unwrap();
        assert_eq!(
            store.verify_key("10.1.2.3", 2222, &key1).unwrap(),
            KnownHostCheck::Trusted
        );

        // 3. Rotated key -> Changed with previous fingerprint
        match store.verify_key("10.1.2.3", 2222, &key2).unwrap() {
            KnownHostCheck::Changed {
                previous_fingerprint,
            } => {
                assert!(previous_fingerprint.starts_with("SHA256:"));
            }
            other => panic!("Expected Changed, got {:?}", other),
        }

        // 4. Revoke -> back to Unknown
        store
            .remove_entry("[10.1.2.3]:2222", "ssh-ed25519")
            .unwrap();
        assert_eq!(
            store.verify_key("10.1.2.3", 2222, &key1).unwrap(),
            KnownHostCheck::Unknown
        );

        let _ = fs::remove_file(tmp_file);
    }
}
