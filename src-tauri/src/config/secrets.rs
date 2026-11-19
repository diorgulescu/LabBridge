use std::sync::Mutex;

use crate::error::{AppError, AppResult};

const KEYRING_SERVICE: &str = "LabBridge";

#[derive(Debug, Clone, Copy)]
pub enum SecretSlot {
    Target,
    ProxyJump,
}

impl SecretSlot {
    fn account_key(self, profile_id: &str) -> String {
        match self {
            SecretSlot::Target => format!("profile:{}:target", profile_id),
            SecretSlot::ProxyJump => format!("profile:{}:proxy_jump", profile_id),
        }
    }
}

/// Manages zero-admin secret persistence via Windows Credential Manager (`windows-native`).
/// Serializes OS keyring operations with an internal mutex to avoid concurrent store contention.
pub struct SecretStore {
    lock: Mutex<()>,
}

impl Default for SecretStore {
    fn default() -> Self {
        Self::new()
    }
}

impl SecretStore {
    pub fn new() -> Self {
        Self {
            lock: Mutex::new(()),
        }
    }

    pub fn set_secret(&self, profile_id: &str, slot: SecretSlot, secret: &str) -> AppResult<()> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| AppError::Keyring("Credential store lock poisoned".into()))?;
        let account = slot.account_key(profile_id);
        let entry = keyring::Entry::new(KEYRING_SERVICE, &account)
            .map_err(|e| AppError::Keyring(format!("Failed to open keyring entry: {}", e)))?;
        entry
            .set_password(secret)
            .map_err(|e| AppError::Keyring(format!("Failed to store secret in keyring: {}", e)))
    }

    pub fn get_secret(&self, profile_id: &str, slot: SecretSlot) -> AppResult<Option<String>> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| AppError::Keyring("Credential store lock poisoned".into()))?;
        let account = slot.account_key(profile_id);
        let entry = keyring::Entry::new(KEYRING_SERVICE, &account)
            .map_err(|e| AppError::Keyring(format!("Failed to open keyring entry: {}", e)))?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(AppError::Keyring(format!(
                "Failed to read secret from keyring: {}",
                e
            ))),
        }
    }

    pub fn has_secret(&self, profile_id: &str, slot: SecretSlot) -> bool {
        matches!(self.get_secret(profile_id, slot), Ok(Some(ref s)) if !s.is_empty())
    }

    pub fn delete_secret(&self, profile_id: &str, slot: SecretSlot) -> AppResult<()> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| AppError::Keyring("Credential store lock poisoned".into()))?;
        let account = slot.account_key(profile_id);
        let entry = keyring::Entry::new(KEYRING_SERVICE, &account)
            .map_err(|e| AppError::Keyring(format!("Failed to open keyring entry: {}", e)))?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(AppError::Keyring(format!(
                "Failed to delete secret from keyring: {}",
                e
            ))),
        }
    }

    pub fn delete_all_for_profile(&self, profile_id: &str) -> AppResult<()> {
        self.delete_secret(profile_id, SecretSlot::Target)?;
        self.delete_secret(profile_id, SecretSlot::ProxyJump)?;
        Ok(())
    }

    pub fn copy_secrets(&self, from_profile_id: &str, to_profile_id: &str) -> AppResult<()> {
        if let Some(target_secret) = self.get_secret(from_profile_id, SecretSlot::Target)? {
            self.set_secret(to_profile_id, SecretSlot::Target, &target_secret)?;
        }
        if let Some(proxy_secret) = self.get_secret(from_profile_id, SecretSlot::ProxyJump)? {
            self.set_secret(to_profile_id, SecretSlot::ProxyJump, &proxy_secret)?;
        }
        Ok(())
    }
}
