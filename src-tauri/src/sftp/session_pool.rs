use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;

use russh_sftp::client::error::Error as SftpError;
use russh_sftp::client::{Config as SftpConfig, SftpSession};
use tokio::sync::Mutex;

use crate::error::{AppError, AppResult};
use crate::ssh::SshManager;

struct CachedSftpEntry {
    ssh_handle_id: usize,
    session: Arc<SftpSession>,
}

/// Multiplexes `russh_sftp::client::SftpSession` channels over the active `russh` handle
/// per profile, automatically recreating dropped SFTP channels whenever the SFTP stream closes
/// or the parent SSH session recovers onto a new handle.
pub struct SftpManager {
    ssh_manager: Arc<SshManager>,
    sessions: Mutex<HashMap<String, CachedSftpEntry>>,
}

impl SftpManager {
    pub fn new(ssh_manager: Arc<SshManager>) -> Arc<Self> {
        Arc::new(Self {
            ssh_manager,
            sessions: Mutex::new(HashMap::new()),
        })
    }

    pub fn ssh_manager(&self) -> &Arc<SshManager> {
        &self.ssh_manager
    }

    /// Opens a brand-new SSH session channel, requests the `"sftp"` subsystem,
    /// and initializes `russh_sftp::client::SftpSession`.
    pub async fn create_sftp_channel(
        &self,
        profile_id: &str,
    ) -> AppResult<(usize, Arc<SftpSession>)> {
        let handle = self.ssh_manager.get_handle(profile_id).await?;
        let handle_id = Arc::as_ptr(&handle) as usize;

        let channel = handle.channel_open_session().await.map_err(|e| {
            AppError::Sftp(format!("Failed to open SSH channel for SFTP: {}", e))
        })?;

        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| AppError::Sftp(format!("Failed to request 'sftp' subsystem: {}", e)))?;

        let cfg = SftpConfig {
            max_packet_len: 262_144,
            max_concurrent_writes: 16,
            request_timeout_secs: 25,
        };

        let sftp = SftpSession::new_with_config(channel.into_stream(), cfg)
            .await
            .map_err(|e| AppError::Sftp(format!("Failed to initialize SFTP protocol: {}", e)))?;

        Ok((handle_id, Arc::new(sftp)))
    }

    /// Returns the active SFTP session for `profile_id`, creating or recreating it if
    /// missing or if the parent SSH handle has reconnected.
    pub async fn get_or_create(&self, profile_id: &str) -> AppResult<Arc<SftpSession>> {
        let current_handle = self.ssh_manager.get_handle(profile_id).await?;
        let current_handle_id = Arc::as_ptr(&current_handle) as usize;

        {
            let guard = self.sessions.lock().await;
            if let Some(cached) = guard.get(profile_id) {
                if cached.ssh_handle_id == current_handle_id {
                    return Ok(Arc::clone(&cached.session));
                }
            }
        }

        let (new_handle_id, session) = self.create_sftp_channel(profile_id).await?;
        let mut guard = self.sessions.lock().await;
        guard.insert(
            profile_id.to_string(),
            CachedSftpEntry {
                ssh_handle_id: new_handle_id,
                session: Arc::clone(&session),
            },
        );
        Ok(session)
    }

    /// Invalidates any cached SFTP channel for `profile_id`.
    pub async fn invalidate(&self, profile_id: &str) {
        if let Some(removed) = self.sessions.lock().await.remove(profile_id) {
            let _ = removed.session.close().await;
        }
    }

    /// Executes an SFTP operation, automatically recreating the SFTP channel and retrying once
    /// if the SFTP subsystem stream was dropped while the parent SSH session is alive or recovered.
    pub async fn with_sftp<T, F, Fut>(&self, profile_id: &str, mut op: F) -> AppResult<T>
    where
        F: FnMut(Arc<SftpSession>) -> Fut,
        Fut: Future<Output = Result<T, SftpError>>,
    {
        let sftp = self.get_or_create(profile_id).await?;
        match op(sftp).await {
            Ok(val) => Ok(val),
            Err(err) if is_channel_dropped_error(&err) => {
                tracing::warn!(
                    "SFTP channel for profile '{}' dropped ({}); recreating subsystem channel...",
                    profile_id,
                    err
                );
                self.invalidate(profile_id).await;
                let fresh_sftp = self.get_or_create(profile_id).await?;
                op(fresh_sftp).await.map_err(AppError::from)
            }
            Err(err) => {
                // Log protocol-level errors at warn so they're visible in logs
                // without triggering an unnecessary channel recreation.
                if is_protocol_level_error(&err) {
                    tracing::warn!(
                        "SFTP protocol error for profile '{}' (not a channel drop): {}",
                        profile_id,
                        err
                    );
                }
                Err(AppError::from(err))
            }
        }
    }
}

/// Returns true only for errors that genuinely indicate the SFTP channel/stream
/// was dropped (I/O failure or timeout). Protocol-level errors like
/// `UnexpectedPacket` or `UnexpectedBehavior` are NOT treated as channel drops
/// because they may indicate a real protocol bug that should surface, not be
/// silently retried.
pub fn is_channel_dropped_error(err: &SftpError) -> bool {
    matches!(err, SftpError::IO(_) | SftpError::Timeout)
}

/// Returns true for protocol-level SFTP errors that should be logged at warn
/// but should NOT trigger automatic channel recreation.
pub fn is_protocol_level_error(err: &SftpError) -> bool {
    matches!(
        err,
        SftpError::UnexpectedPacket | SftpError::UnexpectedBehavior(_)
    )
}
