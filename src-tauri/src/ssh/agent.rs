use russh::keys::agent::client::AgentClient;
use tokio::io::{AsyncRead, AsyncWrite};

use crate::error::{AppError, AppResult};

#[cfg(windows)]
const WINDOWS_OPENSSH_AGENT_PIPE: &str = r"\\.\pipe\openssh-ssh-agent";

#[cfg(windows)]
const ERROR_PIPE_BUSY: i32 = 231;

/// Authenticates an SSH session against any `AsyncRead + AsyncWrite` OpenSSH agent stream.
pub async fn authenticate_with_agent_stream<H, S>(
    handle: &mut russh::client::Handle<H>,
    username: &str,
    stream: S,
) -> AppResult<bool>
where
    H: russh::client::Handler,
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let mut agent = AgentClient::connect(stream);
    let identities = agent.request_identities().await.map_err(|e| {
        AppError::Auth(format!(
            "Failed to query identities from OpenSSH Agent: {}",
            e
        ))
    })?;

    if identities.is_empty() {
        return Err(AppError::Auth(
            "OpenSSH Agent is running but holds no keys. Add a key with `ssh-add`.".into(),
        ));
    }

    for pubkey in identities {
        match handle
            .authenticate_publickey_with(username, pubkey, &mut agent)
            .await
        {
            Ok(true) => return Ok(true),
            Ok(false) => continue,
            Err(e) => {
                tracing::warn!("SSH agent sign attempt failed for identity: {}", e);
                continue;
            }
        }
    }

    Ok(false)
}

/// Connects to the native Windows OpenSSH Authentication Agent via named pipe
/// (`\\.\pipe\openssh-ssh-agent`) and attempts public-key authentication with each identity.
#[cfg(windows)]
pub async fn authenticate_with_windows_agent<H>(
    handle: &mut russh::client::Handle<H>,
    username: &str,
) -> AppResult<bool>
where
    H: russh::client::Handler,
{
    use std::time::Duration;
    use tokio::net::windows::named_pipe::ClientOptions;

    let mut attempts = 0u8;
    let pipe = loop {
        match ClientOptions::new().open(WINDOWS_OPENSSH_AGENT_PIPE) {
            Ok(client) => break client,
            Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) && attempts < 10 => {
                attempts += 1;
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Err(e) => {
                return Err(AppError::Auth(format!(
                    "Cannot open Windows OpenSSH Agent pipe ({}): {}. Ensure the 'OpenSSH Authentication Agent' service is running.",
                    WINDOWS_OPENSSH_AGENT_PIPE, e
                )));
            }
        }
    };

    authenticate_with_agent_stream(handle, username, pipe).await
}

#[cfg(not(windows))]
pub async fn authenticate_with_windows_agent<H>(
    _handle: &mut russh::client::Handle<H>,
    _username: &str,
) -> AppResult<bool>
where
    H: russh::client::Handler,
{
    Err(AppError::Auth(
        r"Windows OpenSSH Agent (\\.\pipe\openssh-ssh-agent) requires a Windows host.".into(),
    ))
}
