use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use russh::client::{DisconnectReason, Handler};
use russh::keys::PublicKey;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::{oneshot, Mutex};
use uuid::Uuid;

use crate::config::{KnownHostCheck, KnownHostsStore};
use crate::error::AppError;

pub const EVENT_HOST_KEY_VERIFY: &str = "ssh:host-key-verify";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostKeyPromptPayload {
    pub request_id: String,
    pub profile_id: String,
    pub host: String,
    pub port: u16,
    pub host_id: String,
    pub is_jump_host: bool,
    pub key_algorithm: String,
    pub fingerprint_sha256: String,
    pub check_status: KnownHostCheck,
}

pub type PendingHostKeyPrompts = Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>;

pub struct SshClientHandler {
    pub profile_id: String,
    pub host: String,
    pub port: u16,
    pub is_jump_host: bool,
    pub known_hosts: Arc<KnownHostsStore>,
    pub app_handle: AppHandle,
    pub pending_prompts: PendingHostKeyPrompts,
    pub disconnect_tx: Option<oneshot::Sender<String>>,
}

#[async_trait]
impl Handler for SshClientHandler {
    type Error = AppError;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let check = self
            .known_hosts
            .verify_key(&self.host, self.port, server_public_key)?;

        if matches!(check, KnownHostCheck::Trusted) {
            return Ok(true);
        }

        let request_id = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel::<bool>();

        {
            let mut map = self.pending_prompts.lock().await;
            map.insert(request_id.clone(), tx);
        }

        let payload = HostKeyPromptPayload {
            request_id: request_id.clone(),
            profile_id: self.profile_id.clone(),
            host: self.host.clone(),
            port: self.port,
            host_id: KnownHostsStore::format_host_id(&self.host, self.port),
            is_jump_host: self.is_jump_host,
            key_algorithm: server_public_key.algorithm().as_str().to_string(),
            fingerprint_sha256: KnownHostsStore::fingerprint_sha256(server_public_key),
            check_status: check,
        };

        if let Err(e) = self.app_handle.emit(EVENT_HOST_KEY_VERIFY, &payload) {
            let mut map = self.pending_prompts.lock().await;
            map.remove(&request_id);
            return Err(AppError::Ssh(format!(
                "Failed to emit host key verification prompt: {}",
                e
            )));
        }

        let decision = tokio::time::timeout(Duration::from_secs(120), rx).await;

        {
            let mut map = self.pending_prompts.lock().await;
            map.remove(&request_id);
        }

        match decision {
            Ok(Ok(true)) => {
                self.known_hosts
                    .trust_key(&self.host, self.port, server_public_key)?;
                Ok(true)
            }
            Ok(Ok(false)) => Err(AppError::HostKeyRejected(format!(
                "{}:{}",
                self.host, self.port
            ))),
            Ok(Err(_)) => Err(AppError::HostKeyRejected(format!(
                "{}:{} (verification cancelled)",
                self.host, self.port
            ))),
            Err(_) => Err(AppError::HostKeyRejected(format!(
                "{}:{} (verification timed out)",
                self.host, self.port
            ))),
        }
    }

    async fn disconnected(
        &mut self,
        reason: DisconnectReason<Self::Error>,
    ) -> Result<(), Self::Error> {
        let desc = match &reason {
            DisconnectReason::ReceivedDisconnect(info) => {
                if info.message.is_empty() {
                    format!("Remote disconnected ({:?})", info.reason_code)
                } else {
                    format!("Remote disconnected: {}", info.message)
                }
            }
            DisconnectReason::Error(err) => format!("Transport disconnected: {}", err),
        };

        if let Some(tx) = self.disconnect_tx.take() {
            let _ = tx.send(desc);
        }

        match reason {
            DisconnectReason::ReceivedDisconnect(_) => Ok(()),
            DisconnectReason::Error(e) => Err(e),
        }
    }
}
