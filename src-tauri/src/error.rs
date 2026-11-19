use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("Configuration error: {0}")]
    Config(String),

    #[error("Credential storage error: {0}")]
    Keyring(String),

    #[error("Known hosts error: {0}")]
    KnownHosts(String),

    #[error("SSH transport error: {0}")]
    Ssh(String),

    #[error("Authentication failed: {0}")]
    Auth(String),

    #[error("Host key verification rejected for {0}")]
    HostKeyRejected(String),

    #[error("PTY error: {0}")]
    Pty(String),

    #[error("SFTP error: {0}")]
    Sftp(String),

    #[error("Sync engine error: {0}")]
    Sync(String),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Serialization error: {0}")]
    Json(#[from] serde_json::Error),
}

impl From<russh::Error> for AppError {
    fn from(err: russh::Error) -> Self {
        AppError::Ssh(err.to_string())
    }
}

impl From<russh::keys::Error> for AppError {
    fn from(err: russh::keys::Error) -> Self {
        AppError::Ssh(err.to_string())
    }
}

impl From<russh_sftp::client::error::Error> for AppError {
    fn from(err: russh_sftp::client::error::Error) -> Self {
        AppError::Sftp(err.to_string())
    }
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
