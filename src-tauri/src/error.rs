use serde::Serialize;

/// Error shape sent to the frontend. Postgres errors carry the extra fields
/// (code, detail, hint, position) so the UI can underline the failing spot.
#[derive(Debug, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub message: String,
    pub code: Option<String>,
    pub detail: Option<String>,
    pub hint: Option<String>,
    /// 1-based character position inside the statement, as reported by Postgres.
    pub position: Option<u32>,
    /// Set for errors the UI handles specially, e.g. "PASSWORD_REQUIRED".
    pub kind: Option<String>,
    /// The saved SSH host an SSH_* error is about.
    pub ssh_host: Option<String>,
}

impl AppError {
    pub fn msg(message: impl Into<String>) -> Self {
        Self { message: message.into(), ..Default::default() }
    }

    pub fn kind(kind: &str, message: impl Into<String>) -> Self {
        Self { message: message.into(), kind: Some(kind.to_string()), ..Default::default() }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<tokio_postgres::Error> for AppError {
    fn from(e: tokio_postgres::Error) -> Self {
        if let Some(db) = e.as_db_error() {
            let position = match db.position() {
                Some(tokio_postgres::error::ErrorPosition::Original(p)) => Some(*p),
                _ => None,
            };
            return AppError {
                message: db.message().to_string(),
                code: Some(db.code().code().to_string()),
                detail: db.detail().map(str::to_string),
                hint: db.hint().map(str::to_string),
                position,
                kind: None,
                ssh_host: None,
            };
        }
        let text = e.to_string();
        let mut source = std::error::Error::source(&e);
        let mut full = text.clone();
        while let Some(s) = source {
            full = format!("{full}: {s}");
            source = s.source();
        }
        if full.contains("password missing") {
            return AppError::kind("PASSWORD_REQUIRED", "A password is required for this connection");
        }
        AppError::msg(full)
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::msg(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::msg(e.to_string())
    }
}

impl From<native_tls::Error> for AppError {
    fn from(e: native_tls::Error) -> Self {
        AppError::msg(format!("TLS error: {e}"))
    }
}

pub type AppResult<T> = Result<T, AppError>;
