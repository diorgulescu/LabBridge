use std::collections::HashMap;
use std::sync::Arc;

use russh::ChannelMsg;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel as IpcChannel;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;
use tokio::sync::{mpsc, RwLock};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::ssh::SshManager;

pub const EVENT_PTY_CLOSED: &str = "pty:closed";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtyClosedPayload {
    pub tab_id: String,
    pub profile_id: String,
    pub exit_code: Option<u32>,
}

enum PtyControl {
    Resize { cols: u32, rows: u32 },
    Close,
}

struct ActivePtyTab {
    pub profile_id: String,
    pub write_tx: mpsc::Sender<Vec<u8>>,
    pub ctrl_tx: mpsc::Sender<PtyControl>,
}

pub struct PtyManager {
    ssh_manager: Arc<SshManager>,
    tabs: Arc<RwLock<HashMap<String, ActivePtyTab>>>,
}

impl PtyManager {
    pub fn new(ssh_manager: Arc<SshManager>) -> Arc<Self> {
        Arc::new(Self {
            ssh_manager,
            tabs: Arc::new(RwLock::new(HashMap::new())),
        })
    }

    pub async fn open_pty(
        &self,
        app_handle: AppHandle,
        profile_id: &str,
        cols: u32,
        rows: u32,
        on_data: IpcChannel<Vec<u8>>,
    ) -> AppResult<String> {
        let cols = cols.clamp(10, 1000);
        let rows = rows.clamp(4, 500);

        let handle = self.ssh_manager.get_handle(profile_id).await?;
        let mut channel = handle.channel_open_session().await.map_err(|e| {
            AppError::Pty(format!("Failed to open multiplexed SSH channel: {}", e))
        })?;

        channel
            .request_pty(false, "xterm-256color", cols, rows, 0, 0, &[])
            .await
            .map_err(|e| AppError::Pty(format!("Failed to allocate xterm-256color PTY: {}", e)))?;

        channel
            .request_shell(true)
            .await
            .map_err(|e| AppError::Pty(format!("Failed to start remote shell: {}", e)))?;

        let tab_id = Uuid::new_v4().to_string();
        let (write_tx, mut write_rx) = mpsc::channel::<Vec<u8>>(512);
        let (ctrl_tx, mut ctrl_rx) = mpsc::channel::<PtyControl>(64);

        let mut ssh_writer = channel.make_writer();
        let writer_task = tokio::spawn(async move {
            while let Some(chunk) = write_rx.recv().await {
                if chunk.is_empty() {
                    continue;
                }
                if ssh_writer.write_all(&chunk).await.is_err() {
                    break;
                }
                if ssh_writer.flush().await.is_err() {
                    break;
                }
            }
        });

        {
            let mut map = self.tabs.write().await;
            map.insert(
                tab_id.clone(),
                ActivePtyTab {
                    profile_id: profile_id.to_string(),
                    write_tx,
                    ctrl_tx,
                },
            );
        }

        let tabs_ref = Arc::clone(&self.tabs);
        let tab_id_bg = tab_id.clone();
        let profile_id_bg = profile_id.to_string();

        tokio::spawn(async move {
            let mut exit_code: Option<u32> = None;
            let mut closed_by_client = false;

            loop {
                tokio::select! {
                    biased;
                    ctrl = ctrl_rx.recv() => {
                        match ctrl {
                            Some(PtyControl::Resize { cols, rows }) => {
                                let _ = channel.window_change(cols, rows, 0, 0).await;
                            }
                            Some(PtyControl::Close) | None => {
                                closed_by_client = true;
                                let _ = channel.eof().await;
                                let _ = channel.close().await;
                                break;
                            }
                        }
                    }
                    msg = channel.wait() => {
                        match msg {
                            Some(ChannelMsg::Data { ref data }) => {
                                if on_data.send(data.to_vec()).is_err() {
                                    let _ = channel.eof().await;
                                    let _ = channel.close().await;
                                    break;
                                }
                            }
                            Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                                if on_data.send(data.to_vec()).is_err() {
                                    let _ = channel.eof().await;
                                    let _ = channel.close().await;
                                    break;
                                }
                            }
                            Some(ChannelMsg::ExitStatus { exit_status }) => {
                                exit_code = Some(exit_status);
                            }
                            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                                break;
                            }
                            _ => {}
                        }
                    }
                }
            }

            writer_task.abort();
            tabs_ref.write().await.remove(&tab_id_bg);

            if !closed_by_client {
                let _ = app_handle.emit(
                    EVENT_PTY_CLOSED,
                    PtyClosedPayload {
                        tab_id: tab_id_bg,
                        profile_id: profile_id_bg,
                        exit_code,
                    },
                );
            }
        });

        Ok(tab_id)
    }

    pub async fn write_pty(&self, tab_id: &str, data: Vec<u8>) -> AppResult<()> {
        if data.is_empty() {
            return Ok(());
        }
        let sender = {
            let map = self.tabs.read().await;
            map.get(tab_id)
                .map(|t| t.write_tx.clone())
                .ok_or_else(|| AppError::Pty(format!("PTY tab '{}' is not active", tab_id)))?
        };
        sender
            .send(data)
            .await
            .map_err(|_| AppError::Pty(format!("PTY tab '{}' write stream closed", tab_id)))
    }

    pub async fn resize_pty(&self, tab_id: &str, cols: u32, rows: u32) -> AppResult<()> {
        if cols == 0 || rows == 0 {
            return Ok(());
        }
        let cols = cols.clamp(10, 1000);
        let rows = rows.clamp(4, 500);
        let sender = {
            let map = self.tabs.read().await;
            let Some(tab) = map.get(tab_id) else {
                return Ok(());
            };
            tab.ctrl_tx.clone()
        };
        let _ = sender.send(PtyControl::Resize { cols, rows }).await;
        Ok(())
    }

    pub async fn close_pty(&self, tab_id: &str) -> AppResult<()> {
        let removed = self.tabs.write().await.remove(tab_id);
        if let Some(tab) = removed {
            let _ = tab.ctrl_tx.send(PtyControl::Close).await;
        }
        Ok(())
    }

    pub async fn close_all_for_profile(&self, profile_id: &str) {
        let matching_ids: Vec<String> = {
            let map = self.tabs.read().await;
            map.iter()
                .filter(|(_, tab)| tab.profile_id == profile_id)
                .map(|(id, _)| id.clone())
                .collect()
        };
        for tab_id in matching_ids {
            let _ = self.close_pty(&tab_id).await;
        }
    }

    pub async fn active_count_for_profile(&self, profile_id: &str) -> usize {
        let map = self.tabs.read().await;
        map.values()
            .filter(|tab| tab.profile_id == profile_id)
            .count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use russh::keys::{Algorithm, PrivateKey, PublicKey};
    use russh::server::{Auth, Config as ServerConfig, Handler as ServerHandler, Msg, Session};
    use russh::{Channel, ChannelId, CryptoVec, Pty};
    use std::sync::Mutex as StdMutex;
    use std::time::Duration;

    #[derive(Default)]
    struct ServerObservedState {
        pty_dims: HashMap<ChannelId, (String, u32, u32)>,
        closed_channels: Vec<ChannelId>,
    }

    struct MockSshServerHandler {
        state: Arc<StdMutex<ServerObservedState>>,
    }

    #[async_trait]
    impl ServerHandler for MockSshServerHandler {
        type Error = russh::Error;

        async fn auth_password(
            &mut self,
            _user: &str,
            password: &str,
        ) -> Result<Auth, Self::Error> {
            if password == "lab-secret" {
                Ok(Auth::Accept)
            } else {
                Ok(Auth::Reject {
                    proceed_with_methods: None,
                })
            }
        }

        async fn channel_open_session(
            &mut self,
            _channel: Channel<Msg>,
            _session: &mut Session,
        ) -> Result<bool, Self::Error> {
            Ok(true)
        }

        async fn pty_request(
            &mut self,
            channel: ChannelId,
            term: &str,
            col_width: u32,
            row_height: u32,
            _pix_width: u32,
            _pix_height: u32,
            _modes: &[(Pty, u32)],
            session: &mut Session,
        ) -> Result<(), Self::Error> {
            self.state
                .lock()
                .unwrap()
                .pty_dims
                .insert(channel, (term.to_string(), col_width, row_height));
            session.channel_success(channel)?;
            Ok(())
        }

        async fn shell_request(
            &mut self,
            channel: ChannelId,
            session: &mut Session,
        ) -> Result<(), Self::Error> {
            session.channel_success(channel)?;
            Ok(())
        }

        async fn window_change_request(
            &mut self,
            channel: ChannelId,
            col_width: u32,
            row_height: u32,
            _pix_width: u32,
            _pix_height: u32,
            _session: &mut Session,
        ) -> Result<(), Self::Error> {
            let mut guard = self.state.lock().unwrap();
            if let Some(entry) = guard.pty_dims.get_mut(&channel) {
                entry.1 = col_width;
                entry.2 = row_height;
            }
            Ok(())
        }

        async fn data(
            &mut self,
            channel: ChannelId,
            data: &[u8],
            session: &mut Session,
        ) -> Result<(), Self::Error> {
            let mut reply = format!("[ch:{:?}] ", channel).into_bytes();
            reply.extend_from_slice(data);
            session.data(channel, CryptoVec::from_slice(&reply))?;
            Ok(())
        }

        async fn channel_close(
            &mut self,
            channel: ChannelId,
            _session: &mut Session,
        ) -> Result<(), Self::Error> {
            self.state.lock().unwrap().closed_channels.push(channel);
            Ok(())
        }
    }

    struct AcceptAllClientHandler;

    #[async_trait]
    impl russh::client::Handler for AcceptAllClientHandler {
        type Error = russh::Error;

        async fn check_server_key(
            &mut self,
            _server_public_key: &PublicKey,
        ) -> Result<bool, Self::Error> {
            Ok(true)
        }
    }

    #[tokio::test]
    async fn multiplexed_multi_tab_isolation_resize_and_clean_teardown() {
        let mut rng = russh::keys::key::safe_rng();
        let host_key = PrivateKey::random(&mut rng, Algorithm::Ed25519).expect("host key");

        let server_cfg = Arc::new(ServerConfig {
            keys: vec![host_key],
            ..ServerConfig::default()
        });
        let client_cfg = Arc::new(russh::client::Config::default());

        let (client_io, server_io) = tokio::io::duplex(65536);
        let observed = Arc::new(StdMutex::new(ServerObservedState::default()));
        let observed_server = Arc::clone(&observed);

        tokio::spawn(async move {
            let session = russh::server::run_stream(
                server_cfg,
                server_io,
                MockSshServerHandler {
                    state: observed_server,
                },
            )
            .await
            .expect("server start");
            let _ = session.await;
        });

        let mut handle =
            russh::client::connect_stream(client_cfg, client_io, AcceptAllClientHandler)
                .await
                .expect("client connect");
        assert!(handle
            .authenticate_password("engineer", "lab-secret")
            .await
            .expect("auth"));
        let shared_handle = Arc::new(handle);

        // Open two independent PTY shells over the single multiplexed handle
        let mut ch1 = shared_handle.channel_open_session().await.expect("open ch1");
        ch1.request_pty(true, "xterm-256color", 80, 24, 0, 0, &[])
            .await
            .expect("pty1");
        ch1.request_shell(true).await.expect("shell1");

        let mut ch2 = shared_handle.channel_open_session().await.expect("open ch2");
        ch2.request_pty(true, "xterm-256color", 120, 40, 0, 0, &[])
            .await
            .expect("pty2");
        ch2.request_shell(true).await.expect("shell2");

        // Write isolated payloads concurrently using make_writer()
        let mut w1 = ch1.make_writer();
        let mut w2 = ch2.make_writer();
        w1.write_all(b"alpha").await.unwrap();
        w1.flush().await.unwrap();
        w2.write_all(b"beta").await.unwrap();
        w2.flush().await.unwrap();

        async fn read_data(ch: &mut Channel<russh::client::Msg>) -> String {
            tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    if let Some(ChannelMsg::Data { data }) = ch.wait().await {
                        return String::from_utf8_lossy(&data).into_owned();
                    }
                }
            })
            .await
            .expect("channel data within timeout")
        }

        let out1 = read_data(&mut ch1).await;
        let out2 = read_data(&mut ch2).await;
        assert!(out1.ends_with("alpha"));
        assert!(out2.ends_with("beta"));
        assert_ne!(out1, out2);

        // Resize Tab 1 to 132x50 and verify Tab 2 stays 120x40
        ch1.window_change(132, 50, 0, 0).await.unwrap();
        tokio::time::sleep(Duration::from_millis(40)).await;
        {
            let guard = observed.lock().unwrap();
            let dims: Vec<(String, u32, u32)> = guard.pty_dims.values().cloned().collect();
            assert!(dims.contains(&("xterm-256color".into(), 132, 50)));
            assert!(dims.contains(&("xterm-256color".into(), 120, 40)));
        }

        // Close Tab 1 cleanly and verify Tab 2 still streams without interruption
        ch1.eof().await.unwrap();
        ch1.close().await.unwrap();
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert_eq!(observed.lock().unwrap().closed_channels.len(), 1);

        w2.write_all(b"still-alive").await.unwrap();
        w2.flush().await.unwrap();
        let out2_after = read_data(&mut ch2).await;
        assert!(out2_after.ends_with("still-alive"));
    }
}
