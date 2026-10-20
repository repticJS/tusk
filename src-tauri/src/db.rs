//! Live database sessions and query execution.
//!
//! A session is one Postgres connection, keyed by (connection, database,
//! purpose). The UI uses one "meta" session per database for browsing and a
//! dedicated session per query tab, so a long query or an open transaction in
//! one tab never blocks the rest of the app.
//!
//! Results use the simple query protocol, which returns every value in
//! Postgres's own text format. That keeps numeric precision, and handles
//! jsonb, arrays, ranges, PostGIS and custom types without any decoding code.

use crate::error::{AppError, AppResult};
use crate::store::ConnectionConfig;
use futures_util::{pin_mut, StreamExt};
use postgres_native_tls::MakeTlsConnector;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};
use tokio_postgres::{AsyncMessage, CancelToken, Client, SimpleQueryMessage};

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionRef {
    pub conn_id: String,
    pub database: String,
    pub purpose: String,
}

impl SessionRef {
    fn key(&self) -> String {
        format!("{}\u{1f}{}\u{1f}{}", self.conn_id, self.database, self.purpose)
    }
}

pub struct Session {
    client: Client,
    cancel: CancelToken,
    tls: MakeTlsConnector,
    notices: Arc<StdMutex<Vec<String>>>,
    server_version: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub server_version: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub type_name: Option<String>,
    pub type_oid: Option<u32>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StatementResult {
    /// Index of the statement in the request this result belongs to.
    pub statement: usize,
    /// None for statements that return no rows (UPDATE without RETURNING etc).
    pub columns: Option<Vec<ColumnInfo>>,
    pub rows: Vec<Vec<Option<String>>>,
    /// Total rows the server returned; may exceed rows.len() when truncated.
    pub row_count: u64,
    pub truncated: bool,
    /// Rows affected / returned as reported by CommandComplete.
    pub affected: Option<u64>,
    pub duration_ms: f64,
    pub notices: Vec<String>,
    pub error: Option<AppError>,
}

pub struct Sessions {
    map: tokio::sync::Mutex<HashMap<String, Arc<Session>>>,
    /// Passwords typed at a prompt, kept for this run of the app only.
    pub transient_passwords: StdMutex<HashMap<String, String>>,
}

impl Sessions {
    pub fn new() -> Self {
        Sessions {
            map: tokio::sync::Mutex::new(HashMap::new()),
            transient_passwords: StdMutex::new(HashMap::new()),
        }
    }

    pub async fn get_or_open(
        &self,
        sref: &SessionRef,
        config: &ConnectionConfig,
        password: Option<String>,
    ) -> AppResult<Arc<Session>> {
        let key = sref.key();
        if let Some(s) = self.map.lock().await.get(&key) {
            if !s.client.is_closed() {
                return Ok(s.clone());
            }
        }
        // Connect without holding the lock so a slow server doesn't stall others.
        let session = Arc::new(connect(config, &sref.database, password).await?);
        let mut map = self.map.lock().await;
        match map.get(&key) {
            Some(existing) if !existing.client.is_closed() => Ok(existing.clone()),
            _ => {
                map.insert(key, session.clone());
                Ok(session)
            }
        }
    }

    pub async fn existing(&self, sref: &SessionRef) -> Option<Arc<Session>> {
        self.map.lock().await.get(&sref.key()).cloned()
    }

    pub async fn close(&self, sref: &SessionRef) {
        self.map.lock().await.remove(&sref.key());
    }

    pub async fn close_connection(&self, conn_id: &str) {
        let prefix = format!("{conn_id}\u{1f}");
        self.map.lock().await.retain(|k, _| !k.starts_with(&prefix));
    }
}

fn make_tls(ssl_mode: &str) -> AppResult<MakeTlsConnector> {
    let mut builder = native_tls::TlsConnector::builder();
    // libpq semantics: only verify-full checks the certificate and host name.
    if ssl_mode != "verify-full" {
        builder.danger_accept_invalid_certs(true);
        builder.danger_accept_invalid_hostnames(true);
    }
    Ok(MakeTlsConnector::new(builder.build()?))
}

pub async fn connect(
    config: &ConnectionConfig,
    database: &str,
    password: Option<String>,
) -> AppResult<Session> {
    let mut pg = tokio_postgres::Config::new();
    pg.host(&config.host)
        .port(config.port)
        .user(&config.user)
        .dbname(database)
        .application_name("Tusk")
        .connect_timeout(Duration::from_secs(10))
        .keepalives(true)
        .keepalives_idle(Duration::from_secs(60));
    if let Some(p) = password.as_deref().filter(|p| !p.is_empty()) {
        pg.password(p);
    }
    pg.ssl_mode(match config.ssl_mode.as_str() {
        "disable" => tokio_postgres::config::SslMode::Disable,
        "require" | "verify-full" => tokio_postgres::config::SslMode::Require,
        _ => tokio_postgres::config::SslMode::Prefer,
    });

    let tls = make_tls(&config.ssl_mode)?;
    let (client, mut connection) = pg.connect(tls.clone()).await?;

    let notices = Arc::new(StdMutex::new(Vec::new()));
    let sink = notices.clone();
    tokio::spawn(async move {
        let messages = futures_util::stream::poll_fn(move |cx| connection.poll_message(cx));
        pin_mut!(messages);
        while let Some(message) = messages.next().await {
            match message {
                Ok(AsyncMessage::Notice(n)) => {
                    sink.lock().unwrap().push(format!("{}: {}", n.severity(), n.message()))
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
    });

    let server_version = match client.simple_query("SHOW server_version").await {
        Ok(msgs) => msgs
            .iter()
            .find_map(|m| match m {
                SimpleQueryMessage::Row(r) => r.get(0).map(str::to_string),
                _ => None,
            })
            .unwrap_or_default(),
        Err(_) => String::new(),
    };

    Ok(Session { cancel: client.cancel_token(), client, tls, notices, server_version })
}

impl Session {
    pub fn info(&self) -> SessionInfo {
        SessionInfo { server_version: self.server_version.clone() }
    }

    pub async fn cancel(&self) -> AppResult<()> {
        self.cancel.cancel_query(self.tls.clone()).await?;
        Ok(())
    }

    fn take_notices(&self) -> Vec<String> {
        std::mem::take(&mut *self.notices.lock().unwrap())
    }

    /// Runs statements one at a time (like psql), stopping at the first error.
    pub async fn run(&self, statements: &[String], max_rows: usize) -> Vec<StatementResult> {
        let mut results = Vec::new();
        for (index, sql) in statements.iter().enumerate() {
            let failed = self.run_one(index, sql, max_rows, &mut results).await;
            if failed {
                break;
            }
        }
        results
    }

    /// Returns true if the statement failed.
    async fn run_one(
        &self,
        index: usize,
        sql: &str,
        max_rows: usize,
        out: &mut Vec<StatementResult>,
    ) -> bool {
        let started = Instant::now();

        // The simple protocol only reports column names, so for statements
        // that return rows we Describe them first to learn the column types.
        let typed: Option<Vec<ColumnInfo>> = if returns_rows(sql) {
            self.client.prepare(sql).await.ok().map(|stmt| {
                stmt.columns()
                    .iter()
                    .map(|c| ColumnInfo {
                        name: c.name().to_string(),
                        type_name: Some(c.type_().name().to_string()),
                        type_oid: Some(c.type_().oid()),
                    })
                    .collect()
            })
        } else {
            None
        };

        let first = out.len();
        let mut current: Option<StatementResult> = None;
        let mut error: Option<AppError> = None;

        match self.client.simple_query_raw(sql).await {
            Err(e) => error = Some(e.into()),
            Ok(stream) => {
                pin_mut!(stream);
                while let Some(message) = stream.next().await {
                    match message {
                        Err(e) => {
                            error = Some(e.into());
                            break;
                        }
                        Ok(SimpleQueryMessage::RowDescription(cols)) => {
                            let columns = match &typed {
                                Some(t) if t.len() == cols.len() => t.clone(),
                                _ => cols
                                    .iter()
                                    .map(|c| ColumnInfo {
                                        name: c.name().to_string(),
                                        type_name: None,
                                        type_oid: None,
                                    })
                                    .collect(),
                            };
                            current = Some(StatementResult {
                                statement: index,
                                columns: Some(columns),
                                ..Default::default()
                            });
                        }
                        Ok(SimpleQueryMessage::Row(row)) => {
                            let r = current.get_or_insert_with(|| StatementResult {
                                statement: index,
                                ..Default::default()
                            });
                            r.row_count += 1;
                            if r.rows.len() < max_rows {
                                r.rows.push((0..row.len()).map(|i| row.get(i).map(str::to_string)).collect());
                            } else {
                                r.truncated = true;
                            }
                        }
                        Ok(SimpleQueryMessage::CommandComplete(n)) => {
                            let mut r = current.take().unwrap_or_else(|| StatementResult {
                                statement: index,
                                ..Default::default()
                            });
                            r.affected = Some(n);
                            out.push(r);
                        }
                        Ok(_) => {}
                    }
                }
            }
        }

        if let Some(r) = current.take() {
            out.push(r);
        }
        if let Some(e) = error {
            out.push(StatementResult { statement: index, error: Some(e), ..Default::default() });
        }
        if out.len() == first {
            // Empty query (e.g. only a comment).
            out.push(StatementResult { statement: index, ..Default::default() });
        }
        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
        let notices = self.take_notices();
        if let Some(last) = out.last_mut() {
            last.duration_ms = elapsed;
            last.notices = notices;
        }
        out.last().map(|r| r.error.is_some()).unwrap_or(false)
    }

    /// Runs a multi-statement script as one simple-protocol message. Postgres
    /// runs such a message in a single implicit transaction, so either every
    /// statement applies or none do. Returns the affected-row count of each.
    pub async fn execute_atomic(&self, sql: &str) -> AppResult<Vec<u64>> {
        let messages = self.client.simple_query(sql).await?;
        Ok(messages
            .into_iter()
            .filter_map(|m| match m {
                SimpleQueryMessage::CommandComplete(n) => Some(n),
                _ => None,
            })
            .collect())
    }
}

/// Whether a statement can produce rows, judged by its first keyword.
fn returns_rows(sql: &str) -> bool {
    let first = first_keyword(sql);
    matches!(first.as_str(), "select" | "with" | "values" | "table" | "show" | "explain")
        || sql.to_ascii_lowercase().contains("returning")
}

fn first_keyword(sql: &str) -> String {
    let mut s = sql.trim_start();
    loop {
        if let Some(rest) = s.strip_prefix("--") {
            s = rest.split_once('\n').map(|(_, r)| r).unwrap_or("").trim_start();
        } else if let Some(rest) = s.strip_prefix("/*") {
            s = rest.split_once("*/").map(|(_, r)| r).unwrap_or("").trim_start();
        } else if let Some(rest) = s.strip_prefix('(') {
            s = rest.trim_start();
        } else {
            break;
        }
    }
    s.chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect::<String>()
        .to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_row_returning_statements() {
        assert!(returns_rows("select 1"));
        assert!(returns_rows("  -- hi\n/* x */ (SELECT 1)"));
        assert!(returns_rows("WITH a AS (select 1) select * from a"));
        assert!(returns_rows("insert into t values (1) returning id"));
        assert!(!returns_rows("update t set a = 1"));
        assert!(!returns_rows("create table x (id int)"));
    }
}
