use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use russh::client::{Config as RusshConfig, Handle};
use russh::keys::key::PrivateKeyWithHashAlg;
use russh::keys::{load_secret_key, HashAlg};
use russh::Disconnect;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::net::TcpStream;
use tokio::sync::{oneshot, watch, Mutex, RwLock};

use crate::config::{AuthMethod, ConfigStore, SecretSlot, WorkspaceProfile};
use crate::error::{AppError, AppResult};
use crate::ssh::agent::authenticate_with_windows_agent;
use crate::ssh::handler::{PendingHostKeyPrompts, SshClientHandler};

pub const EVENT_SSH_STATE_CHANGED: &str = "ssh:state-changed";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "state")]
pub enum ConnectionState {
    Disconnected,
    Connecting,
    Connected { rtt_ms: u64 },
    Reconnecting,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionStatusPayload {
    pub profile_id: String,
    pub connection_state: ConnectionState,
    pub message: Option<String>,
    pub reconnect_attempt: Option<u32>,
}

struct ActiveSession {
    generation: u64,
    handle: Arc<Handle<SshClientHandler>>,
    jump_handle: Option<Arc<Handle<SshClientHandler>>>,
    cancel_tx: watch::Sender<bool>,
}

struct EstablishedHandles {
    target_handle: Arc<Handle<SshClientHandler>>,
    jump_handle: Option<Arc<Handle<SshClientHandler>>>,
    disconnect_rx: oneshot::Receiver<String>,
    initial_rtt_ms: u64,
}

pub struct SshManager {
    config_store: Arc<ConfigStore>,
    sessions: RwLock<HashMap<String, ActiveSession>>,
    states: RwLock<HashMap<String, ConnectionStatusPayload>>,
    connect_cancels: Mutex<HashMap<String, (u64, watch::Sender<bool>)>>,
    pending_prompts: PendingHostKeyPrompts,
    reconnected_tx: Mutex<Option<tokio::sync::mpsc::UnboundedSender<(AppHandle, String)>>>,
    generation_seq: AtomicU64,
}

impl SshManager {
    pub fn new(config_store: Arc<ConfigStore>) -> Arc<Self> {
        Arc::new(Self {
            config_store,
            sessions: RwLock::new(HashMap::new()),
            states: RwLock::new(HashMap::new()),
            connect_cancels: Mutex::new(HashMap::new()),
            pending_prompts: Arc::new(Mutex::new(HashMap::new())),
            reconnected_tx: Mutex::new(None),
            generation_seq: AtomicU64::new(1),
        })
    }

    pub async fn set_reconnect_notifier(
        &self,
        tx: tokio::sync::mpsc::UnboundedSender<(AppHandle, String)>,
    ) {
        *self.reconnected_tx.lock().await = Some(tx);
    }

    pub async fn respond_host_key(&self, request_id: &str, accept: bool) -> AppResult<()> {
        let mut prompts = self.pending_prompts.lock().await;
        if let Some(tx) = prompts.remove(request_id) {
            let _ = tx.send(accept);
            Ok(())
        } else {
            Err(AppError::Ssh(
                "Host key verification request expired or already handled".into(),
            ))
        }
    }

    pub async fn get_state(&self, profile_id: &str) -> ConnectionStatusPayload {
        let guard = self.states.read().await;
        guard
            .get(profile_id)
            .cloned()
            .unwrap_or(ConnectionStatusPayload {
                profile_id: profile_id.to_string(),
                connection_state: ConnectionState::Disconnected,
                message: None,
                reconnect_attempt: None,
            })
    }

    pub async fn list_states(&self) -> HashMap<String, ConnectionStatusPayload> {
        self.states.read().await.clone()
    }

    pub async fn get_handle(
        &self,
        profile_id: &str,
    ) -> AppResult<Arc<Handle<SshClientHandler>>> {
        let guard = self.sessions.read().await;
        let session = guard.get(profile_id).ok_or_else(|| {
            AppError::Ssh("Profile is not connected. Connect to the host first.".into())
        })?;
        if session.handle.is_closed() {
            return Err(AppError::Ssh(
                "SSH transport is currently closed or reconnecting.".into(),
            ));
        }
        Ok(Arc::clone(&session.handle))
    }

    pub async fn connect(
        self: &Arc<Self>,
        app_handle: AppHandle,
        profile_id: &str,
    ) -> AppResult<ConnectionStatusPayload> {
        let profile = self.config_store.get_profile(profile_id)?;

        // Tear down any existing session/in-flight attempt for this profile cleanly
        self.cancel_and_remove_internal(profile_id).await;

        let generation = self.generation_seq.fetch_add(1, Ordering::SeqCst);
        let (cancel_tx, mut cancel_rx) = watch::channel(false);
        {
            let mut map = self.connect_cancels.lock().await;
            map.insert(profile.id.clone(), (generation, cancel_tx.clone()));
        }

        self.set_state(
            &app_handle,
            ConnectionStatusPayload {
                profile_id: profile.id.clone(),
                connection_state: ConnectionState::Connecting,
                message: Some(if let Some(ref jump) = profile.proxy_jump {
                    format!(
                        "Connecting via {}@{} -> {}:{}...",
                        jump.user, jump.host, profile.host, profile.port
                    )
                } else {
                    format!("Connecting to {}@{}:{}...", profile.username, profile.host, profile.port)
                }),
                reconnect_attempt: None,
            },
        )
        .await;

        let connect_res = tokio::select! {
            res = self.establish_session(&app_handle, &profile) => res,
            _ = wait_cancelled(&mut cancel_rx) => {
                Err(AppError::Ssh("Connection cancelled by user".into()))
            }
        };

        match connect_res {
            Ok(established) => {
                if *cancel_rx.borrow() {
                    let _ = established
                        .target_handle
                        .disconnect(Disconnect::ByApplication, "Cancelled", "en")
                        .await;
                    return Err(AppError::Ssh("Connection cancelled".into()));
                }

                let rtt_ms = established.initial_rtt_ms;
                {
                    let mut sessions = self.sessions.write().await;
                    sessions.insert(
                        profile.id.clone(),
                        ActiveSession {
                            generation,
                            handle: Arc::clone(&established.target_handle),
                            jump_handle: established.jump_handle.clone(),
                            cancel_tx: cancel_tx.clone(),
                        },
                    );
                }

                let connected_payload = ConnectionStatusPayload {
                    profile_id: profile.id.clone(),
                    connection_state: ConnectionState::Connected { rtt_ms },
                    message: Some(format!("Multiplexed SSH2 active ({} ms)", rtt_ms)),
                    reconnect_attempt: None,
                };
                self.set_state(&app_handle, connected_payload.clone()).await;

                // Spawn keepalive, RTT telemetry, and automatic reconnect supervisor
                let manager_clone = Arc::clone(self);
                let app_clone = app_handle.clone();
                let profile_id_owned = profile.id.clone();
                let keepalive_secs = profile.keepalive_secs.max(5);
                tokio::spawn(async move {
                    manager_clone
                        .supervise_session(
                            app_clone,
                            profile_id_owned,
                            generation,
                            keepalive_secs,
                            established.target_handle,
                            established.disconnect_rx,
                            cancel_rx,
                        )
                        .await;
                });

                Ok(connected_payload)
            }
            Err(err) => {
                let is_still_current = {
                    let mut map = self.connect_cancels.lock().await;
                    if matches!(map.get(&profile.id), Some((g, _)) if *g == generation) {
                        map.remove(&profile.id);
                        true
                    } else {
                        false
                    }
                };

                if is_still_current {
                    self.set_state(
                        &app_handle,
                        ConnectionStatusPayload {
                            profile_id: profile.id.clone(),
                            connection_state: ConnectionState::Disconnected,
                            message: Some(err.to_string()),
                            reconnect_attempt: None,
                        },
                    )
                    .await;
                }
                Err(err)
            }
        }
    }

    pub async fn disconnect(
        &self,
        app_handle: &AppHandle,
        profile_id: &str,
    ) -> AppResult<ConnectionStatusPayload> {
        self.cancel_and_remove_internal(profile_id).await;

        let payload = ConnectionStatusPayload {
            profile_id: profile_id.to_string(),
            connection_state: ConnectionState::Disconnected,
            message: Some("Disconnected".into()),
            reconnect_attempt: None,
        };
        self.set_state(app_handle, payload.clone()).await;
        Ok(payload)
    }

    pub async fn disconnect_all(&self) {
        let profile_ids: Vec<String> = {
            let sessions = self.sessions.read().await;
            sessions.keys().cloned().collect()
        };
        for id in profile_ids {
            self.cancel_and_remove_internal(&id).await;
        }
    }

    async fn cancel_and_remove_internal(&self, profile_id: &str) {
        if let Some((_, cancel_tx)) = self.connect_cancels.lock().await.remove(profile_id) {
            let _ = cancel_tx.send(true);
        }

        let removed = self.sessions.write().await.remove(profile_id);
        if let Some(active) = removed {
            let _ = active.cancel_tx.send(true);
            let _ = active
                .handle
                .disconnect(Disconnect::ByApplication, "LabBridge session closed", "en")
                .await;
            if let Some(jump) = active.jump_handle {
                let _ = jump
                    .disconnect(Disconnect::ByApplication, "LabBridge jump closed", "en")
                    .await;
            }
        }
    }

    async fn supervise_session(
        self: Arc<Self>,
        app_handle: AppHandle,
        profile_id: String,
        generation: u64,
        keepalive_secs: u64,
        mut current_handle: Arc<Handle<SshClientHandler>>,
        mut current_disconnect_rx: oneshot::Receiver<String>,
        mut cancel_rx: watch::Receiver<bool>,
    ) {
        let probe_interval = Duration::from_secs(keepalive_secs.clamp(5, 60));

        'outer: loop {
            let drop_reason: String = loop {
                tokio::select! {
                    _ = wait_cancelled(&mut cancel_rx) => {
                        return;
                    }
                    res = &mut current_disconnect_rx => {
                        break res.unwrap_or_else(|_| "Connection closed by remote peer".into());
                    }
                    _ = tokio::time::sleep(probe_interval) => {
                        if *cancel_rx.borrow() {
                            return;
                        }
                        if current_handle.is_closed() {
                            break "SSH session closed unexpectedly".into();
                        }
                        match Self::probe_rtt(&current_handle).await {
                            Ok(rtt_ms) => {
                                if self.is_generation_active(&profile_id, generation).await {
                                    self.set_state(
                                        &app_handle,
                                        ConnectionStatusPayload {
                                            profile_id: profile_id.clone(),
                                            connection_state: ConnectionState::Connected { rtt_ms },
                                            message: Some(format!("Multiplexed SSH2 active ({} ms)", rtt_ms)),
                                            reconnect_attempt: None,
                                        },
                                    ).await;
                                } else {
                                    return;
                                }
                            }
                            Err(e) => {
                                break format!("Keepalive probe failed: {}", e);
                            }
                        }
                    }
                }
            };

            if *cancel_rx.borrow() || !self.is_generation_active(&profile_id, generation).await {
                return;
            }

            tracing::warn!(
                "Profile {} dropped ({}); starting automatic reconnect...",
                profile_id,
                drop_reason
            );

            // Exponential backoff reconnect loop (1s, 2s, 5s, 10s...)
            const RECONNECT_BACKOFF_SECS: &[u64] = &[1, 2, 5, 10, 10, 10, 10, 10];
            const MAX_ATTEMPTS: u32 = 8;
            for attempt in 1..=MAX_ATTEMPTS {
                if *cancel_rx.borrow() || !self.is_generation_active(&profile_id, generation).await
                {
                    return;
                }

                self.set_state(
                    &app_handle,
                    ConnectionStatusPayload {
                        profile_id: profile_id.clone(),
                        connection_state: ConnectionState::Reconnecting,
                        message: Some(format!(
                            "Reconnecting (attempt {}/{}) — {}",
                            attempt, MAX_ATTEMPTS, drop_reason
                        )),
                        reconnect_attempt: Some(attempt),
                    },
                )
                .await;

                let backoff_secs =
                    RECONNECT_BACKOFF_SECS[(attempt as usize - 1).min(RECONNECT_BACKOFF_SECS.len() - 1)];
                tokio::select! {
                    _ = wait_cancelled(&mut cancel_rx) => return,
                    _ = tokio::time::sleep(Duration::from_secs(backoff_secs)) => {}
                }

                let Ok(profile) = self.config_store.get_profile(&profile_id) else {
                    break;
                };

                let reconnect_res = tokio::select! {
                    res = self.establish_session(&app_handle, &profile) => res,
                    _ = wait_cancelled(&mut cancel_rx) => return,
                };

                match reconnect_res {
                    Ok(established) => {
                        let rtt_ms = established.initial_rtt_ms;
                        {
                            let mut sessions = self.sessions.write().await;
                            if let Some(slot) = sessions.get_mut(&profile_id) {
                                if slot.generation != generation {
                                    let _ = established
                                        .target_handle
                                        .disconnect(Disconnect::ByApplication, "Superseded", "en")
                                        .await;
                                    return;
                                }
                                slot.handle = Arc::clone(&established.target_handle);
                                slot.jump_handle = established.jump_handle;
                            } else {
                                return;
                            }
                        }

                        current_handle = established.target_handle;
                        current_disconnect_rx = established.disconnect_rx;

                        self.set_state(
                            &app_handle,
                            ConnectionStatusPayload {
                                profile_id: profile_id.clone(),
                                connection_state: ConnectionState::Connected { rtt_ms },
                                message: Some(format!(
                                    "Reconnected multiplexed SSH2 ({} ms)",
                                    rtt_ms
                                )),
                                reconnect_attempt: None,
                            },
                        )
                        .await;

                        if let Some(ref tx) = *self.reconnected_tx.lock().await {
                            let _ = tx.send((app_handle.clone(), profile_id.clone()));
                        }

                        continue 'outer;
                    }
                    Err(AppError::Auth(msg)) => {
                        self.finish_failed_reconnect(&app_handle, &profile_id, generation, msg)
                            .await;
                        return;
                    }
                    Err(AppError::HostKeyRejected(msg)) => {
                        self.finish_failed_reconnect(&app_handle, &profile_id, generation, msg)
                            .await;
                        return;
                    }
                    Err(err) => {
                        tracing::warn!(
                            "Reconnect attempt {}/{} for {} failed: {}",
                            attempt,
                            MAX_ATTEMPTS,
                            profile_id,
                            err
                        );
                    }
                }
            }

            self.finish_failed_reconnect(
                &app_handle,
                &profile_id,
                generation,
                format!("Connection lost: {}", drop_reason),
            )
            .await;
            return;
        }
    }

    async fn finish_failed_reconnect(
        &self,
        app_handle: &AppHandle,
        profile_id: &str,
        generation: u64,
        reason: String,
    ) {
        let mut sessions = self.sessions.write().await;
        if matches!(sessions.get(profile_id), Some(s) if s.generation == generation) {
            sessions.remove(profile_id);
            drop(sessions);
            self.set_state(
                app_handle,
                ConnectionStatusPayload {
                    profile_id: profile_id.to_string(),
                    connection_state: ConnectionState::Disconnected,
                    message: Some(reason),
                    reconnect_attempt: None,
                },
            )
            .await;
        }
    }

    async fn is_generation_active(&self, profile_id: &str, generation: u64) -> bool {
        let sessions = self.sessions.read().await;
        matches!(sessions.get(profile_id), Some(s) if s.generation == generation)
    }

    async fn set_state(&self, app_handle: &AppHandle, payload: ConnectionStatusPayload) {
        {
            let mut guard = self.states.write().await;
            guard.insert(payload.profile_id.clone(), payload.clone());
        }
        let _ = app_handle.emit(EVENT_SSH_STATE_CHANGED, &payload);
    }

    async fn establish_session(
        &self,
        app_handle: &AppHandle,
        profile: &WorkspaceProfile,
    ) -> AppResult<EstablishedHandles> {
        let keepalive_interval = if profile.keepalive_secs > 0 {
            Some(Duration::from_secs(profile.keepalive_secs))
        } else {
            None
        };

        let make_russh_config = || {
            Arc::new(RusshConfig {
                keepalive_interval,
                keepalive_max: 3,
                window_size: 4 * 1024 * 1024, // 4 MiB window for high-throughput terminal/SFTP
                maximum_packet_size: 32768,
                ..RusshConfig::default()
            })
        };

        let (disconnect_tx, disconnect_rx) = oneshot::channel::<String>();

        if let Some(ref jump) = profile.proxy_jump {
            // 1. Connect TCP to ProxyJump host with TCP_NODELAY
            let jump_addr = format!("{}:{}", jump.host, jump.port);
            let jump_tcp =
                tokio::time::timeout(Duration::from_secs(12), TcpStream::connect(&jump_addr))
                    .await
                    .map_err(|_| {
                        AppError::Ssh(format!(
                            "Timed out connecting to ProxyJump host {}",
                            jump_addr
                        ))
                    })?
                    .map_err(|e| {
                        AppError::Ssh(format!(
                            "Failed to reach ProxyJump host {}: {}",
                            jump_addr, e
                        ))
                    })?;
            let _ = jump_tcp.set_nodelay(true);

            let jump_handler = SshClientHandler {
                profile_id: profile.id.clone(),
                host: jump.host.clone(),
                port: jump.port,
                is_jump_host: true,
                known_hosts: Arc::clone(&self.config_store.known_hosts),
                app_handle: app_handle.clone(),
                pending_prompts: Arc::clone(&self.pending_prompts),
                disconnect_tx: None,
            };

            let mut jump_handle =
                russh::client::connect_stream(make_russh_config(), jump_tcp, jump_handler).await?;

            self.authenticate_handle(
                &mut jump_handle,
                &jump.user,
                &jump.auth,
                &profile.id,
                SecretSlot::ProxyJump,
                &format!("ProxyJump ({}@{})", jump.user, jump.host),
            )
            .await?;

            // 2. Open direct-tcpip tunnel through ProxyJump to Lab Target
            let tunnel_channel = tokio::time::timeout(
                Duration::from_secs(15),
                jump_handle.channel_open_direct_tcpip(
                    &profile.host,
                    profile.port as u32,
                    "127.0.0.1",
                    0,
                ),
            )
            .await
            .map_err(|_| {
                AppError::Ssh(format!(
                    "Timed out opening direct-tcpip tunnel to {}:{} via {}",
                    profile.host, profile.port, jump.host
                ))
            })?
            .map_err(|e| {
                AppError::Ssh(format!(
                    "ProxyJump host {} rejected tunnel to {}:{}: {}",
                    jump.host, profile.host, profile.port, e
                ))
            })?;

            // 3. Handshake target russh session directly over the tunneled stream
            let target_handler = SshClientHandler {
                profile_id: profile.id.clone(),
                host: profile.host.clone(),
                port: profile.port,
                is_jump_host: false,
                known_hosts: Arc::clone(&self.config_store.known_hosts),
                app_handle: app_handle.clone(),
                pending_prompts: Arc::clone(&self.pending_prompts),
                disconnect_tx: Some(disconnect_tx),
            };

            let mut target_handle = russh::client::connect_stream(
                make_russh_config(),
                tunnel_channel.into_stream(),
                target_handler,
            )
            .await?;

            self.authenticate_handle(
                &mut target_handle,
                &profile.username,
                &profile.auth_method,
                &profile.id,
                SecretSlot::Target,
                &format!("{}@{}:{}", profile.username, profile.host, profile.port),
            )
            .await?;

            let target_arc = Arc::new(target_handle);
            let initial_rtt_ms = Self::probe_rtt(&target_arc).await.unwrap_or(1);

            Ok(EstablishedHandles {
                target_handle: target_arc,
                jump_handle: Some(Arc::new(jump_handle)),
                disconnect_rx,
                initial_rtt_ms,
            })
        } else {
            // Direct connection with TCP_NODELAY
            let target_addr = format!("{}:{}", profile.host, profile.port);
            let tcp =
                tokio::time::timeout(Duration::from_secs(12), TcpStream::connect(&target_addr))
                    .await
                    .map_err(|_| {
                        AppError::Ssh(format!("Timed out connecting to {}", target_addr))
                    })?
                    .map_err(|e| {
                        AppError::Ssh(format!("Failed to connect to {}: {}", target_addr, e))
                    })?;
            let _ = tcp.set_nodelay(true);

            let target_handler = SshClientHandler {
                profile_id: profile.id.clone(),
                host: profile.host.clone(),
                port: profile.port,
                is_jump_host: false,
                known_hosts: Arc::clone(&self.config_store.known_hosts),
                app_handle: app_handle.clone(),
                pending_prompts: Arc::clone(&self.pending_prompts),
                disconnect_tx: Some(disconnect_tx),
            };

            let mut target_handle =
                russh::client::connect_stream(make_russh_config(), tcp, target_handler).await?;

            self.authenticate_handle(
                &mut target_handle,
                &profile.username,
                &profile.auth_method,
                &profile.id,
                SecretSlot::Target,
                &format!("{}@{}:{}", profile.username, profile.host, profile.port),
            )
            .await?;

            let target_arc = Arc::new(target_handle);
            let initial_rtt_ms = Self::probe_rtt(&target_arc).await.unwrap_or(1);

            Ok(EstablishedHandles {
                target_handle: target_arc,
                jump_handle: None,
                disconnect_rx,
                initial_rtt_ms,
            })
        }
    }

    async fn authenticate_handle(
        &self,
        handle: &mut Handle<SshClientHandler>,
        username: &str,
        auth_method: &AuthMethod,
        profile_id: &str,
        secret_slot: SecretSlot,
        label: &str,
    ) -> AppResult<()> {
        let accepted = match auth_method {
            AuthMethod::PasswordInKeyring => {
                let password = self
                    .config_store
                    .secrets
                    .get_secret(profile_id, secret_slot)?
                    .ok_or_else(|| {
                        AppError::Auth(format!(
                            "No password stored in Windows Credential Manager for {}. Edit the profile to set a password.",
                            label
                        ))
                    })?;
                handle.authenticate_password(username, password).await?
            }
            AuthMethod::PrivateKeyFile {
                path,
                passphrase_in_keyring,
            } => {
                let expanded_path = expand_home_path(path);
                let passphrase = if *passphrase_in_keyring {
                    self.config_store
                        .secrets
                        .get_secret(profile_id, secret_slot)?
                } else {
                    None
                };

                let private_key =
                    load_secret_key(&expanded_path, passphrase.as_deref()).map_err(|e| {
                        AppError::Auth(format!(
                            "Failed to load SSH key '{}' for {}: {}",
                            expanded_path.display(),
                            label,
                            e
                        ))
                    })?;

                let key_arc = Arc::new(private_key);
                if key_arc.algorithm().is_rsa() {
                    let mut ok = false;
                    for alg in [Some(HashAlg::Sha512), Some(HashAlg::Sha256), None] {
                        let key_with_alg = PrivateKeyWithHashAlg::new(Arc::clone(&key_arc), alg)?;
                        if handle.authenticate_publickey(username, key_with_alg).await? {
                            ok = true;
                            break;
                        }
                    }
                    ok
                } else {
                    let key_with_alg = PrivateKeyWithHashAlg::new(key_arc, None)?;
                    handle.authenticate_publickey(username, key_with_alg).await?
                }
            }
            AuthMethod::WindowsSshAgent => {
                authenticate_with_windows_agent(handle, username).await?
            }
        };

        if !accepted {
            return Err(AppError::Auth(format!(
                "Server rejected SSH credentials for {}",
                label
            )));
        }
        Ok(())
    }

    async fn probe_rtt(handle: &Handle<SshClientHandler>) -> AppResult<u64> {
        let start = Instant::now();
        let ch = tokio::time::timeout(Duration::from_secs(10), handle.channel_open_session())
            .await
            .map_err(|_| AppError::Ssh("SSH RTT keepalive probe timed out".into()))??;
        let elapsed_ms = start.elapsed().as_millis() as u64;
        let _ = ch.close().await;
        Ok(elapsed_ms)
    }
}

async fn wait_cancelled(rx: &mut watch::Receiver<bool>) {
    if *rx.borrow() {
        return;
    }
    while rx.changed().await.is_ok() {
        if *rx.borrow() {
            return;
        }
    }
    std::future::pending::<()>().await;
}

fn expand_home_path(raw: &str) -> PathBuf {
    let trimmed = raw.trim();
    if let Some(rest) = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
    {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(trimmed)
}
