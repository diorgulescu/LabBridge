use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type")]
pub enum AuthMethod {
    PrivateKeyFile {
        path: String,
        passphrase_in_keyring: bool,
    },
    PasswordInKeyring,
    WindowsSshAgent,
}

impl AuthMethod {
    pub fn uses_keyring(&self) -> bool {
        match self {
            AuthMethod::PrivateKeyFile {
                passphrase_in_keyring,
                ..
            } => *passphrase_in_keyring,
            AuthMethod::PasswordInKeyring => true,
            AuthMethod::WindowsSshAgent => false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProxyJumpConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: AuthMethod,
}

fn default_true() -> bool {
    true
}

pub fn default_excluded_dirs() -> Vec<String> {
    vec![
        "build".to_string(),
        "out".to_string(),
        "target".to_string(),
        ".vscode".to_string(),
    ]
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MacroTargetMode {
    ActiveTerminal,
    DedicatedTab,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MacroAccent {
    Emerald,
    Cyan,
    Amber,
    Indigo,
    Rose,
    Zinc,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProfileMacro {
    pub id: String,
    pub label: String,
    pub command: String,
    pub accent: MacroAccent,
    pub target_mode: MacroTargetMode,
    #[serde(default = "default_true")]
    pub flush_sync_before_run: bool,
}

pub fn default_profile_macros() -> Vec<ProfileMacro> {
    vec![
        ProfileMacro {
            id: "macro-build".to_string(),
            label: "Build (make -j)".to_string(),
            command: "make -j$(nproc)".to_string(),
            accent: MacroAccent::Emerald,
            target_mode: MacroTargetMode::ActiveTerminal,
            flush_sync_before_run: true,
        },
        ProfileMacro {
            id: "macro-ctest".to_string(),
            label: "Run CTest".to_string(),
            command: "ctest --output-on-failure".to_string(),
            accent: MacroAccent::Cyan,
            target_mode: MacroTargetMode::DedicatedTab,
            flush_sync_before_run: true,
        },
        ProfileMacro {
            id: "macro-flash".to_string(),
            label: "Flash Target".to_string(),
            command: "./scripts/flash.sh".to_string(),
            accent: MacroAccent::Amber,
            target_mode: MacroTargetMode::DedicatedTab,
            flush_sync_before_run: true,
        },
        ProfileMacro {
            id: "macro-dmesg".to_string(),
            label: "Serial / dmesg".to_string(),
            command: "sudo dmesg -wH".to_string(),
            accent: MacroAccent::Indigo,
            target_mode: MacroTargetMode::DedicatedTab,
            flush_sync_before_run: false,
        },
        ProfileMacro {
            id: "macro-clean".to_string(),
            label: "Clean".to_string(),
            command: "make clean".to_string(),
            accent: MacroAccent::Rose,
            target_mode: MacroTargetMode::ActiveTerminal,
            flush_sync_before_run: false,
        },
    ]
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceProfile {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: AuthMethod,
    pub proxy_jump: Option<ProxyJumpConfig>,
    pub local_root_path: String,
    pub remote_root_path: String,
    pub keepalive_secs: u64,
    #[serde(default = "default_true")]
    pub auto_sync_enabled: bool,
    #[serde(default = "default_true")]
    pub crlf_guard_enabled: bool,
    #[serde(default)]
    pub sync_deletions: bool,
    #[serde(default = "default_excluded_dirs")]
    pub excluded_dirs: Vec<String>,
    #[serde(default = "default_profile_macros")]
    pub macros: Vec<ProfileMacro>,
}

impl WorkspaceProfile {
    pub fn sanitized(mut self) -> Self {
        self.name = self.name.trim().to_string();
        self.host = self.host.trim().to_string();
        self.username = self.username.trim().to_string();
        if self.port == 0 {
            self.port = 22;
        }
        if self.keepalive_secs == 0 {
            self.keepalive_secs = 15;
        }
        self.remote_root_path = normalize_posix_path(self.remote_root_path.trim());
        self.excluded_dirs = self
            .excluded_dirs
            .into_iter()
            .map(|d| d.trim().trim_matches(|c| c == '/' || c == '\\').to_string())
            .filter(|d| !d.is_empty() && d != ".git")
            .collect();
        if let Some(ref mut jump) = self.proxy_jump {
            jump.host = jump.host.trim().to_string();
            jump.user = jump.user.trim().to_string();
            if jump.port == 0 {
                jump.port = 22;
            }
        }
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecretStatus {
    pub has_target_secret: bool,
    pub has_proxy_secret: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageInfo {
    pub data_dir: String,
    pub is_portable: bool,
    pub profiles_file: String,
    pub known_hosts_file: String,
    pub logs_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowGeometry {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

fn default_left_ratio() -> f64 {
    0.5
}

fn default_dock_height() -> u32 {
    360
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceUiState {
    pub last_active_profile_id: Option<String>,
    #[serde(default = "default_left_ratio")]
    pub explorer_left_ratio: f64,
    #[serde(default = "default_dock_height")]
    pub terminal_dock_height: u32,
    #[serde(default)]
    pub terminal_dock_maximized: bool,
    #[serde(default)]
    pub follow_terminal_cwd: bool,
    #[serde(default)]
    pub window: Option<WindowGeometry>,
}

impl Default for WorkspaceUiState {
    fn default() -> Self {
        Self {
            last_active_profile_id: None,
            explorer_left_ratio: 0.5,
            terminal_dock_height: 360,
            terminal_dock_maximized: false,
            follow_terminal_cwd: false,
            window: None,
        }
    }
}

/// Normalizes any Windows `\` separators into strict POSIX `/` paths for remote Linux targets.
pub fn normalize_posix_path(input: &str) -> String {
    if input.is_empty() {
        return String::new();
    }
    let replaced = input.replace('\\', "/");
    // Collapse duplicate consecutive slashes except leading slash
    let mut out = String::with_capacity(replaced.len());
    let mut prev_slash = false;
    for ch in replaced.chars() {
        if ch == '/' {
            if !prev_slash {
                out.push('/');
            }
            prev_slash = true;
        } else {
            out.push(ch);
            prev_slash = false;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_windows_backslashes_to_posix() {
        assert_eq!(
            normalize_posix_path(r"\home\ubuntu\\workspace\build\"),
            "/home/ubuntu/workspace/build/"
        );
        assert_eq!(normalize_posix_path(""), "");
    }

    #[test]
    fn roundtrips_workspace_profile_with_proxy_jump() {
        let profile = WorkspaceProfile {
            id: "prof-1".into(),
            name: "Lab GPU".into(),
            host: "10.0.4.12".into(),
            port: 22,
            username: "engineer".into(),
            auth_method: AuthMethod::PrivateKeyFile {
                path: r"C:\Users\eng\.ssh\id_ed25519".into(),
                passphrase_in_keyring: true,
            },
            proxy_jump: Some(ProxyJumpConfig {
                host: "bastion.lab.local".into(),
                port: 2222,
                user: "jump".into(),
                auth: AuthMethod::WindowsSshAgent,
            }),
            local_root_path: r"C:\work\fpga".into(),
            remote_root_path: r"\home\engineer\fpga".into(),
            keepalive_secs: 15,
            auto_sync_enabled: true,
            crlf_guard_enabled: true,
            sync_deletions: false,
            excluded_dirs: default_excluded_dirs(),
            macros: default_profile_macros(),
        }
        .sanitized();

        assert_eq!(profile.remote_root_path, "/home/engineer/fpga");
        let json = serde_json::to_string(&profile).expect("serialize");
        let decoded: WorkspaceProfile = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(decoded, profile);
        assert_eq!(decoded.macros.len(), 5);
    }

    #[test]
    fn roundtrips_workspace_ui_state_and_window_geometry() {
        let ui = WorkspaceUiState {
            last_active_profile_id: Some("prof-1".into()),
            explorer_left_ratio: 0.42,
            terminal_dock_height: 410,
            terminal_dock_maximized: false,
            follow_terminal_cwd: true,
            window: Some(WindowGeometry {
                x: 120,
                y: 80,
                width: 1440,
                height: 900,
                maximized: false,
            }),
        };
        let encoded = serde_json::to_string(&ui).expect("encode ui state");
        let decoded: WorkspaceUiState = serde_json::from_str(&encoded).expect("decode ui state");
        assert_eq!(decoded.last_active_profile_id.as_deref(), Some("prof-1"));
        assert!((decoded.explorer_left_ratio - 0.42).abs() < f64::EPSILON);
        assert_eq!(decoded.terminal_dock_height, 410);
        assert!(decoded.follow_terminal_cwd);
        assert_eq!(decoded.window.unwrap().width, 1440);
    }
}
