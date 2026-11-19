pub mod known_hosts;
pub mod profile;
pub mod secrets;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
pub use known_hosts::{KnownHostCheck, KnownHostEntry, KnownHostsStore};
pub use profile::{
    normalize_posix_path, AuthMethod, MacroAccent, MacroTargetMode, ProfileMacro, ProxyJumpConfig,
    SecretStatus, StorageInfo, WindowGeometry, WorkspaceProfile, WorkspaceUiState,
};
pub use secrets::{SecretSlot, SecretStore};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct ProfilesDocument {
    pub version: u32,
    pub profiles: Vec<WorkspaceProfile>,
}

#[derive(Debug, Clone)]
pub struct ResolvedPaths {
    pub data_dir: PathBuf,
    pub is_portable: bool,
    pub profiles_file: PathBuf,
    pub known_hosts_file: PathBuf,
    pub ui_state_file: PathBuf,
    pub logs_dir: PathBuf,
}

/// Resolves zero-admin data storage directory:
/// - If `portable.mode` exists next to the executable (`LabBridge.exe`), uses `./data/` next to the exe.
/// - Otherwise uses `%APPDATA%\LabBridge` (with cross-platform `dirs::config_dir()/LabBridge` fallback).
pub fn resolve_storage_paths() -> AppResult<ResolvedPaths> {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf));

    let (data_dir, is_portable) = match exe_dir {
        Some(ref dir) if dir.join("portable.mode").exists() => (dir.join("data"), true),
        _ => {
            let base = if let Some(appdata) = std::env::var_os("APPDATA") {
                PathBuf::from(appdata).join("LabBridge")
            } else if let Some(cfg) = dirs::config_dir() {
                cfg.join("LabBridge")
            } else {
                PathBuf::from("data")
            };
            (base, false)
        }
    };

    let logs_dir = data_dir.join("logs");
    fs::create_dir_all(&data_dir)?;
    fs::create_dir_all(&logs_dir)?;

    let profiles_file = data_dir.join("profiles.json");
    let known_hosts_file = data_dir.join("known_hosts");
    let ui_state_file = data_dir.join("ui_state.json");

    Ok(ResolvedPaths {
        data_dir,
        is_portable,
        profiles_file,
        known_hosts_file,
        ui_state_file,
        logs_dir,
    })
}

pub struct ConfigStore {
    paths: ResolvedPaths,
    profiles: RwLock<Vec<WorkspaceProfile>>,
    ui_state: RwLock<WorkspaceUiState>,
    pub secrets: Arc<SecretStore>,
    pub known_hosts: Arc<KnownHostsStore>,
}

impl ConfigStore {
    pub fn initialize() -> AppResult<Arc<Self>> {
        let paths = resolve_storage_paths()?;
        let initial_profiles = Self::load_profiles_from_disk(&paths.profiles_file)?;
        let initial_ui = Self::load_ui_state_from_disk(&paths.ui_state_file);
        let secrets = Arc::new(SecretStore::new());
        let known_hosts = Arc::new(KnownHostsStore::new(paths.known_hosts_file.clone())?);

        Ok(Arc::new(Self {
            paths,
            profiles: RwLock::new(initial_profiles),
            ui_state: RwLock::new(initial_ui),
            secrets,
            known_hosts,
        }))
    }

    pub fn storage_info(&self) -> StorageInfo {
        StorageInfo {
            data_dir: self.paths.data_dir.to_string_lossy().into_owned(),
            is_portable: self.paths.is_portable,
            profiles_file: self.paths.profiles_file.to_string_lossy().into_owned(),
            known_hosts_file: self.paths.known_hosts_file.to_string_lossy().into_owned(),
            logs_dir: self.paths.logs_dir.to_string_lossy().into_owned(),
        }
    }

    pub fn logs_dir(&self) -> &Path {
        &self.paths.logs_dir
    }

    pub fn list_profiles(&self) -> AppResult<Vec<WorkspaceProfile>> {
        let guard = self
            .profiles
            .read()
            .map_err(|_| AppError::Config("Profiles lock poisoned".into()))?;
        Ok(guard.clone())
    }

    pub fn get_profile(&self, profile_id: &str) -> AppResult<WorkspaceProfile> {
        let guard = self
            .profiles
            .read()
            .map_err(|_| AppError::Config("Profiles lock poisoned".into()))?;
        guard
            .iter()
            .find(|p| p.id == profile_id)
            .cloned()
            .ok_or_else(|| AppError::Config(format!("Profile '{}' not found", profile_id)))
    }

    pub fn save_profile(
        &self,
        mut profile: WorkspaceProfile,
        target_secret: Option<String>,
        proxy_secret: Option<String>,
    ) -> AppResult<WorkspaceProfile> {
        if profile.id.trim().is_empty() {
            profile.id = Uuid::new_v4().to_string();
        }
        profile = profile.sanitized();

        if profile.name.is_empty() {
            return Err(AppError::Config("Profile name is required".into()));
        }
        if profile.host.is_empty() {
            return Err(AppError::Config("Target host is required".into()));
        }
        if profile.username.is_empty() {
            return Err(AppError::Config("SSH username is required".into()));
        }
        if let Some(ref jump) = profile.proxy_jump {
            if jump.host.is_empty() || jump.user.is_empty() {
                return Err(AppError::Config(
                    "ProxyJump requires both jump host and jump user".into(),
                ));
            }
        }

        // Persist or clean up secrets in Windows Credential Manager (never on disk)
        if profile.auth_method.uses_keyring() {
            if let Some(secret) = target_secret {
                if !secret.is_empty() {
                    self.secrets
                        .set_secret(&profile.id, SecretSlot::Target, &secret)?;
                }
            }
        } else {
            self.secrets.delete_secret(&profile.id, SecretSlot::Target)?;
        }

        match profile.proxy_jump {
            Some(ref jump) if jump.auth.uses_keyring() => {
                if let Some(secret) = proxy_secret {
                    if !secret.is_empty() {
                        self.secrets
                            .set_secret(&profile.id, SecretSlot::ProxyJump, &secret)?;
                    }
                }
            }
            _ => {
                self.secrets
                    .delete_secret(&profile.id, SecretSlot::ProxyJump)?;
            }
        }

        let mut guard = self
            .profiles
            .write()
            .map_err(|_| AppError::Config("Profiles lock poisoned".into()))?;
        if let Some(existing) = guard.iter_mut().find(|p| p.id == profile.id) {
            *existing = profile.clone();
        } else {
            guard.push(profile.clone());
        }
        Self::write_profiles_to_disk(&self.paths.profiles_file, &guard)?;

        Ok(profile)
    }

    pub fn duplicate_profile(&self, source_profile_id: &str) -> AppResult<WorkspaceProfile> {
        let mut copy = self.get_profile(source_profile_id)?;
        let new_id = Uuid::new_v4().to_string();
        copy.id = new_id.clone();
        copy.name = format!("{} (Copy)", copy.name);

        // Copy keyring credentials if present
        let _ = self.secrets.copy_secrets(source_profile_id, &new_id);

        let mut guard = self
            .profiles
            .write()
            .map_err(|_| AppError::Config("Profiles lock poisoned".into()))?;
        guard.push(copy.clone());
        Self::write_profiles_to_disk(&self.paths.profiles_file, &guard)?;
        Ok(copy)
    }

    pub fn delete_profile(&self, profile_id: &str) -> AppResult<()> {
        let mut guard = self
            .profiles
            .write()
            .map_err(|_| AppError::Config("Profiles lock poisoned".into()))?;
        let before = guard.len();
        guard.retain(|p| p.id != profile_id);
        if guard.len() == before {
            return Err(AppError::Config(format!(
                "Profile '{}' not found",
                profile_id
            )));
        }
        Self::write_profiles_to_disk(&self.paths.profiles_file, &guard)?;
        let _ = self.secrets.delete_all_for_profile(profile_id);
        Ok(())
    }

    pub fn secret_status(&self, profile_id: &str) -> SecretStatus {
        SecretStatus {
            has_target_secret: self.secrets.has_secret(profile_id, SecretSlot::Target),
            has_proxy_secret: self.secrets.has_secret(profile_id, SecretSlot::ProxyJump),
        }
    }

    pub fn update_sync_policy(
        &self,
        profile_id: &str,
        auto_sync_enabled: bool,
        crlf_guard_enabled: bool,
        sync_deletions: bool,
    ) -> AppResult<WorkspaceProfile> {
        let mut guard = self
            .profiles
            .write()
            .map_err(|_| AppError::Config("Profiles lock poisoned".into()))?;
        let profile = guard
            .iter_mut()
            .find(|p| p.id == profile_id)
            .ok_or_else(|| AppError::Config(format!("Profile '{}' not found", profile_id)))?;
        profile.auto_sync_enabled = auto_sync_enabled;
        profile.crlf_guard_enabled = crlf_guard_enabled;
        profile.sync_deletions = sync_deletions;
        let updated = profile.clone();
        Self::write_profiles_to_disk(&self.paths.profiles_file, &guard)?;
        Ok(updated)
    }

    pub fn update_profile_macros(
        &self,
        profile_id: &str,
        macros: Vec<ProfileMacro>,
    ) -> AppResult<WorkspaceProfile> {
        let mut guard = self
            .profiles
            .write()
            .map_err(|_| AppError::Config("Profiles lock poisoned".into()))?;
        let profile = guard
            .iter_mut()
            .find(|p| p.id == profile_id)
            .ok_or_else(|| AppError::Config(format!("Profile '{}' not found", profile_id)))?;
        profile.macros = macros
            .into_iter()
            .map(|mut m| {
                if m.id.trim().is_empty() {
                    m.id = Uuid::new_v4().to_string();
                }
                m.label = m.label.trim().to_string();
                m
            })
            .filter(|m| !m.label.is_empty() && !m.command.trim().is_empty())
            .collect();
        let updated = profile.clone();
        Self::write_profiles_to_disk(&self.paths.profiles_file, &guard)?;
        Ok(updated)
    }

    pub fn get_ui_state(&self) -> AppResult<WorkspaceUiState> {
        let guard = self
            .ui_state
            .read()
            .map_err(|_| AppError::Config("UI state lock poisoned".into()))?;
        Ok(guard.clone())
    }

    pub fn save_ui_state(&self, mut next: WorkspaceUiState) -> AppResult<WorkspaceUiState> {
        next.explorer_left_ratio = next.explorer_left_ratio.clamp(0.2, 0.8);
        next.terminal_dock_height = next.terminal_dock_height.clamp(140, 1600);

        let mut guard = self
            .ui_state
            .write()
            .map_err(|_| AppError::Config("UI state lock poisoned".into()))?;
        if next.window.is_none() {
            next.window = guard.window.clone();
        }
        *guard = next.clone();
        Self::write_ui_state_to_disk(&self.paths.ui_state_file, &guard)?;
        Ok(next)
    }

    pub fn save_window_geometry(&self, geom: WindowGeometry) -> AppResult<()> {
        let mut guard = self
            .ui_state
            .write()
            .map_err(|_| AppError::Config("UI state lock poisoned".into()))?;
        guard.window = Some(geom);
        Self::write_ui_state_to_disk(&self.paths.ui_state_file, &guard)
    }

    fn load_ui_state_from_disk(path: &Path) -> WorkspaceUiState {
        if let Ok(raw) = fs::read_to_string(path) {
            if let Ok(parsed) = serde_json::from_str::<WorkspaceUiState>(&raw) {
                return parsed;
            }
        }
        WorkspaceUiState::default()
    }

    fn write_ui_state_to_disk(path: &Path, state: &WorkspaceUiState) -> AppResult<()> {
        let serialized = serde_json::to_string_pretty(state)?;
        let tmp_path = path.with_extension("json.tmp");
        fs::write(&tmp_path, serialized.as_bytes())?;
        fs::rename(&tmp_path, path)?;
        Ok(())
    }

    fn load_profiles_from_disk(path: &Path) -> AppResult<Vec<WorkspaceProfile>> {
        if !path.exists() {
            return Ok(Vec::new());
        }
        let raw = fs::read_to_string(path)?;
        if raw.trim().is_empty() {
            return Ok(Vec::new());
        }
        if let Ok(doc) = serde_json::from_str::<ProfilesDocument>(&raw) {
            return Ok(doc.profiles);
        }
        let list: Vec<WorkspaceProfile> = serde_json::from_str(&raw)?;
        Ok(list)
    }

    fn write_profiles_to_disk(path: &Path, profiles: &[WorkspaceProfile]) -> AppResult<()> {
        let doc = ProfilesDocument {
            version: 1,
            profiles: profiles.to_vec(),
        };
        let serialized = serde_json::to_string_pretty(&doc)?;
        let tmp_path = path.with_extension("json.tmp");
        fs::write(&tmp_path, serialized.as_bytes())?;
        fs::rename(&tmp_path, path)?;
        Ok(())
    }
}
