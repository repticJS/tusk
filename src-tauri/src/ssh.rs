//! SSH terminals.
//!
//! Each terminal tab owns one SSH connection with a PTY shell channel. Output
//! is streamed to the UI as raw bytes over a Tauri channel; input, resizes and
//! close requests arrive through an mpsc queue handled by the session's task.
//!
//! Host keys are trusted on first use (after the user confirms the
//! fingerprint) and remembered in Tusk's own known_hosts file. Keys already in
//! the user's ~/.ssh/known_hosts are trusted too.

use crate::error::{AppError, AppResult};
use russh::client::{self, AuthResult, Handle, KeyboardInteractiveAuthResponse};
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate};
use russh::{ChannelMsg, ChannelOpenFailure, Disconnect};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::sync::mpsc;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    /// password | key | agent
    pub auth: String,
    #[serde(default)]
    pub key_path: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    /// Save the password (or key passphrase) in the credential store.
    #[serde(default)]
    pub save_secret: bool,
    /// Folder the shell starts in, e.g. "/home/New Webapp" or "~/apps".
    #[serde(default)]
    pub start_dir: Option<String>,
    /// Sidebar folder; None is the top level.
    #[serde(default)]
    pub folder_id: Option<String>,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum TermEvent {
    Connected { banner: Option<String> },
    Exit { status: u32 },
    Closed { reason: Option<String> },
}

enum Cmd {
    Write(Vec<u8>),
    Resize(u32, u32),
    Close,
}

struct Terminal {
    tx: mpsc::UnboundedSender<Cmd>,
    /// The connection, shared with SFTP and helper exec channels.
    conn: Arc<Connection>,
}

/// One authenticated SSH connection. SFTP is opened on it lazily.
pub struct Connection {
    pub handle: Handle<Client>,
    pub sftp: tokio::sync::Mutex<Option<Arc<russh_sftp::client::SftpSession>>>,
}

pub struct SshSessions {
    terms: tokio::sync::Mutex<HashMap<String, Terminal>>,
    /// Secrets typed at a prompt, kept for this run of the app only.
    pub transient_secrets: StdMutex<HashMap<String, String>>,
}

impl SshSessions {
    pub fn new() -> Self {
        SshSessions { terms: Default::default(), transient_secrets: Default::default() }
    }

    pub async fn write(&self, id: &str, data: Vec<u8>) {
        if let Some(t) = self.terms.lock().await.get(id) {
            let _ = t.tx.send(Cmd::Write(data));
        }
    }

    pub async fn resize(&self, id: &str, cols: u32, rows: u32) {
        if let Some(t) = self.terms.lock().await.get(id) {
            let _ = t.tx.send(Cmd::Resize(cols, rows));
        }
    }

    pub async fn connection(&self, id: &str) -> AppResult<Arc<Connection>> {
        match self.terms.lock().await.get(id) {
            Some(t) if !t.conn.handle.is_closed() => Ok(t.conn.clone()),
            _ => Err(AppError::kind("SSH_CLOSED", "The SSH connection for this terminal is closed. Reconnect it first.")),
        }
    }

    pub async fn close(&self, id: &str) {
        if let Some(t) = self.terms.lock().await.remove(id) {
            let _ = t.tx.send(Cmd::Close);
        }
    }
}

// ---- host keys ----

#[derive(Clone)]
enum HostKeyIssue {
    Unknown { fingerprint: String, algorithm: String },
    Changed { fingerprint: String, algorithm: String, line: usize },
}

pub struct Client {
    host: String,
    port: u16,
    known_hosts: PathBuf,
    /// Fingerprint the user has approved for this connection attempt.
    accept: Option<String>,
    issue: Arc<StdMutex<Option<HostKeyIssue>>>,
    banner: Arc<StdMutex<Option<String>>>,
    /// Remote (-R) forwards opened on this connection, by server port.
    forwards: crate::tunnel::RemoteForwards,
}

fn fingerprint(key: &PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

/// Removes line `line` (1-based) from a known_hosts file.
fn forget_line(path: &PathBuf, line: usize) -> std::io::Result<()> {
    let text = std::fs::read_to_string(path)?;
    let kept: Vec<&str> = text.lines().enumerate().filter(|(i, _)| i + 1 != line).map(|(_, l)| l).collect();
    std::fs::write(path, kept.join("\n") + "\n")
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(&mut self, server_key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let owned;
        let key = match server_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key,
            PublicKeyOrCertificate::Certificate(cert) => {
                owned = PublicKey::new(cert.public_key().clone(), "");
                &owned
            }
        };
        let fp = fingerprint(key);
        let algorithm = key.algorithm().to_string();
        match russh::keys::check_known_hosts_path(&self.host, self.port, key, &self.known_hosts) {
            Ok(true) => return Ok(true),
            Ok(false) => {}
            Err(russh::keys::Error::KeyChanged { line }) => {
                if self.accept.as_deref() == Some(fp.as_str()) {
                    let _ = forget_line(&self.known_hosts, line);
                    let _ = russh::keys::known_hosts::learn_known_hosts_path(&self.host, self.port, key, &self.known_hosts);
                    return Ok(true);
                }
                *self.issue.lock().unwrap() = Some(HostKeyIssue::Changed { fingerprint: fp, algorithm, line });
                return Ok(false);
            }
            Err(_) => {}
        }
        // Trust what the user's own OpenSSH already trusts.
        if let Ok(true) = russh::keys::check_known_hosts(&self.host, self.port, key) {
            return Ok(true);
        }
        if self.accept.as_deref() == Some(fp.as_str()) {
            if let Some(dir) = self.known_hosts.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = russh::keys::known_hosts::learn_known_hosts_path(&self.host, self.port, key, &self.known_hosts);
            return Ok(true);
        }
        *self.issue.lock().unwrap() = Some(HostKeyIssue::Unknown { fingerprint: fp, algorithm });
        Ok(false)
    }

    async fn auth_banner(
        &mut self,
        banner: &str,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        *self.banner.lock().unwrap() = Some(banner.to_string());
        Ok(())
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<client::Msg>,
        _connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let forward = self.forwards.lock().unwrap().get(&connected_port).cloned();
        match forward {
            Some(f) => {
                reply.accept().await;
                tokio::spawn(crate::tunnel::serve_remote(channel, f));
            }
            None => reply.reject(ChannelOpenFailure::AdministrativelyProhibited).await,
        }
        Ok(())
    }
}

fn host_key_error(issue: HostKeyIssue, host: &str, port: u16) -> AppError {
    let target = if port == 22 { host.to_string() } else { format!("{host}:{port}") };
    match issue {
        HostKeyIssue::Unknown { fingerprint, algorithm } => AppError {
            message: format!("The authenticity of {target} can't be established."),
            detail: Some(format!("{algorithm} {fingerprint}")),
            hint: Some(fingerprint),
            kind: Some("HOSTKEY_UNKNOWN".into()),
            ..Default::default()
        },
        HostKeyIssue::Changed { fingerprint, algorithm, line } => AppError {
            message: format!(
                "The host key for {target} has CHANGED (known_hosts line {line}). Someone could be intercepting the connection, or the server was reinstalled."
            ),
            detail: Some(format!("{algorithm} {fingerprint}")),
            hint: Some(fingerprint),
            kind: Some("HOSTKEY_CHANGED".into()),
            ..Default::default()
        },
    }
}

// ---- authentication ----

fn ssh_err(e: impl std::fmt::Display) -> AppError {
    AppError::msg(e.to_string())
}

async fn auth_password(h: &mut Handle<Client>, user: &str, password: &str) -> AppResult<bool> {
    match h.authenticate_password(user, password).await.map_err(ssh_err)? {
        AuthResult::Success => return Ok(true),
        AuthResult::Failure { remaining_methods, .. } => {
            if !remaining_methods.contains(&russh::MethodKind::KeyboardInteractive) {
                return Ok(false);
            }
        }
    }
    // Many servers (PAM) only offer keyboard-interactive; answer its prompts
    // with the password.
    let mut resp = h.authenticate_keyboard_interactive_start(user, None).await.map_err(ssh_err)?;
    for _ in 0..5 {
        match resp {
            KeyboardInteractiveAuthResponse::Success => return Ok(true),
            KeyboardInteractiveAuthResponse::Failure { .. } => return Ok(false),
            KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                let answers = prompts.iter().map(|_| password.to_string()).collect();
                resp = h.authenticate_keyboard_interactive_respond(answers).await.map_err(ssh_err)?;
            }
        }
    }
    Ok(false)
}

async fn auth_key(h: &mut Handle<Client>, user: &str, path: &str, passphrase: Option<&str>) -> AppResult<bool> {
    let expanded = expand_home(path);
    let key = match russh::keys::load_secret_key(&expanded, passphrase.filter(|p| !p.is_empty())) {
        Ok(k) => k,
        Err(russh::keys::Error::KeyIsEncrypted) => {
            return Err(AppError::kind("PASSPHRASE_REQUIRED", "This private key is protected by a passphrase"))
        }
        Err(e) if passphrase.is_some() && e.to_string().to_lowercase().contains("decrypt") => {
            return Err(AppError::kind("PASSPHRASE_REQUIRED", "Wrong passphrase for this private key"))
        }
        Err(e) => return Err(AppError::msg(format!("Could not read key {}: {e}", expanded.display()))),
    };
    let hash = h.best_supported_rsa_hash().await.map_err(ssh_err)?.flatten();
    let key = PrivateKeyWithHashAlg::new(Arc::new(key), hash);
    Ok(h.authenticate_publickey(user, key).await.map_err(ssh_err)?.success())
}

async fn auth_with_agent<S>(h: &mut Handle<Client>, user: &str, mut agent: russh::keys::agent::client::AgentClient<S>) -> AppResult<bool>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let identities = agent.request_identities().await.map_err(ssh_err)?;
    if identities.is_empty() {
        return Err(AppError::msg("The SSH agent has no keys loaded"));
    }
    let hash = h.best_supported_rsa_hash().await.map_err(ssh_err)?.flatten();
    for id in identities {
        let key = id.public_key().into_owned();
        if let Ok(r) = h.authenticate_publickey_with(user, key, hash, &mut agent).await {
            if r.success() {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

#[cfg(windows)]
async fn auth_agent(h: &mut Handle<Client>, user: &str) -> AppResult<bool> {
    use russh::keys::agent::client::AgentClient;
    // Windows' built-in OpenSSH agent first, then PuTTY's Pageant.
    if let Ok(agent) = AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
        if auth_with_agent(h, user, agent).await? {
            return Ok(true);
        }
    }
    match AgentClient::connect_pageant().await {
        Ok(agent) => auth_with_agent(h, user, agent).await,
        Err(_) => Err(AppError::msg(
            "No SSH agent found. Start the \"OpenSSH Authentication Agent\" service or Pageant, and add your key.",
        )),
    }
}

#[cfg(not(windows))]
async fn auth_agent(h: &mut Handle<Client>, user: &str) -> AppResult<bool> {
    let agent = russh::keys::agent::client::AgentClient::connect_env()
        .await
        .map_err(|e| AppError::msg(format!("No SSH agent available: {e}")))?;
    auth_with_agent(h, user, agent).await
}

fn expand_home(path: &str) -> PathBuf {
    match path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        Some(rest) => dirs::home_dir().map(|h| h.join(rest)).unwrap_or_else(|| PathBuf::from(path)),
        None => PathBuf::from(path),
    }
}

// ---- connecting ----

/// Connects and authenticates. `accept_fingerprint` is a host key the user
/// has just approved. Fails with kind HOSTKEY_UNKNOWN / HOSTKEY_CHANGED,
/// PASSWORD_REQUIRED, PASSPHRASE_REQUIRED, AUTH_FAILED or AUTH_REJECTED when
/// the user needs to be asked something.
pub async fn connect(
    cfg: &SshConfig,
    secret: Option<&str>,
    accept_fingerprint: Option<String>,
    known_hosts: &std::path::Path,
    forwards: crate::tunnel::RemoteForwards,
) -> AppResult<(Handle<Client>, Option<String>)> {
    let issue = Arc::new(StdMutex::new(None));
    let banner = Arc::new(StdMutex::new(None));
    let handler = Client {
        host: cfg.host.clone(),
        port: cfg.port,
        known_hosts: known_hosts.to_path_buf(),
        accept: accept_fingerprint,
        issue: issue.clone(),
        banner: banner.clone(),
        forwards,
    };
    let config = Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 4,
        ..Default::default()
    });

    let connecting = client::connect(config, (cfg.host.as_str(), cfg.port), handler);
    let mut handle = match tokio::time::timeout(Duration::from_secs(15), connecting).await {
        Err(_) => return Err(AppError::msg(format!("Timed out connecting to {}:{}", cfg.host, cfg.port))),
        Ok(Err(e)) => {
            if let Some(i) = issue.lock().unwrap().take() {
                return Err(host_key_error(i, &cfg.host, cfg.port));
            }
            return Err(AppError::msg(format!("Could not connect to {}:{}: {e}", cfg.host, cfg.port)));
        }
        Ok(Ok(h)) => h,
    };

    let ok = match cfg.auth.as_str() {
        "key" => {
            let path = cfg.key_path.as_deref().filter(|p| !p.is_empty()).ok_or_else(|| AppError::msg("No private key file chosen"))?;
            auth_key(&mut handle, &cfg.user, path, secret).await?
        }
        "agent" => auth_agent(&mut handle, &cfg.user).await?,
        _ => match secret {
            None => return Err(AppError::kind("PASSWORD_REQUIRED", "A password is required")),
            Some(pw) => auth_password(&mut handle, &cfg.user, pw).await?,
        },
    };
    if !ok {
        let kind = if cfg.auth == "password" { "AUTH_FAILED" } else { "AUTH_REJECTED" };
        return Err(AppError::kind(kind, format!("Authentication failed for {}@{}", cfg.user, cfg.host)));
    }
    let banner = banner.lock().unwrap().take();
    Ok((handle, banner))
}

// ---- opening a terminal ----

pub struct OpenRequest {
    pub term_id: String,
    pub config: SshConfig,
    pub secret: Option<String>,
    pub accept_fingerprint: Option<String>,
    pub cols: u32,
    pub rows: u32,
    pub known_hosts: PathBuf,
    /// Run this instead of the login shell (e.g. `docker logs -f web`).
    pub command: Option<String>,
}

pub async fn open(sessions: &SshSessions, req: OpenRequest, events: Channel<InvokeResponseBody>) -> AppResult<()> {
    let cfg = &req.config;
    let (handle, banner) =
        connect(cfg, req.secret.as_deref(), req.accept_fingerprint.clone(), &req.known_hosts, Default::default()).await?;

    let mut channel = handle.channel_open_session().await.map_err(ssh_err)?;
    channel
        .request_pty(false, "xterm-256color", req.cols.max(1), req.rows.max(1), 0, 0, &[])
        .await
        .map_err(ssh_err)?;
    if let Some(cmd) = req.command.as_deref().filter(|c| !c.trim().is_empty()) {
        channel.exec(false, cmd).await.map_err(ssh_err)?;
    } else {
        match cfg.start_dir.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
        // Start the login shell inside the folder rather than typing a `cd`
        // into it, so nothing shows on screen or in the shell history.
            Some(dir) => channel.exec(false, posix(&start_in_dir_command(dir))).await.map_err(ssh_err)?,
            None => channel.request_shell(false).await.map_err(ssh_err)?,
        }
    }

    let (tx, mut rx) = mpsc::unbounded_channel::<Cmd>();
    let conn = Arc::new(Connection { handle, sftp: Default::default() });
    sessions.terms.lock().await.insert(req.term_id.clone(), Terminal { tx, conn: conn.clone() });

    let _ = events.send(json(&TermEvent::Connected { banner }));

    tokio::spawn(async move {
        let mut reason: Option<String> = None;
        loop {
            tokio::select! {
                msg = channel.wait() => match msg {
                    Some(ChannelMsg::Data { data }) => {
                        let _ = events.send(InvokeResponseBody::Raw(data.to_vec()));
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        let _ = events.send(InvokeResponseBody::Raw(data.to_vec()));
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        let _ = events.send(json(&TermEvent::Exit { status: exit_status }));
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    Some(_) => {}
                },
                cmd = rx.recv() => match cmd {
                    Some(Cmd::Write(bytes)) => {
                        if let Err(e) = channel.data_bytes(bytes).await {
                            reason = Some(e.to_string());
                            break;
                        }
                    }
                    Some(Cmd::Resize(c, r)) => {
                        let _ = channel.window_change(c.max(1), r.max(1), 0, 0).await;
                    }
                    Some(Cmd::Close) | None => {
                        let _ = channel.close().await;
                        break;
                    }
                },
            }
        }
        let _ = conn.handle.disconnect(Disconnect::ByApplication, "", "en").await;
        let _ = events.send(json(&TermEvent::Closed { reason }));
    });
    Ok(())
}

/// Quotes a string for a POSIX shell.
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Runs a POSIX script through `sh`, whatever the user's login shell is
/// (fish and tcsh can't run sh syntax directly).
pub fn posix(script: &str) -> String {
    format!("sh -c {}", sh_quote(script))
}

/// A command that changes to `dir` (keeping `~` meaning home) and then
/// replaces itself with the user's login shell.
fn start_in_dir_command(dir: &str) -> String {
    let target = if dir == "~" {
        "~".to_string()
    } else if let Some(rest) = dir.strip_prefix("~/") {
        format!("~/{}", sh_quote(rest))
    } else {
        sh_quote(dir)
    };
    format!(
        "cd {target} 2>/dev/null || printf '%s\\n' {msg} >&2; exec \"${{SHELL:-/bin/sh}}\" -l",
        msg = sh_quote(&format!("Tusk: start folder {dir} not found, staying in your home folder")),
    )
}

fn json<T: Serialize>(v: &T) -> InvokeResponseBody {
    InvokeResponseBody::Json(serde_json::to_string(v).unwrap_or_else(|_| "null".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_start_folder_commands() {
        assert_eq!(sh_quote("it's"), r"'it'\''s'");
        let cmd = start_in_dir_command("/home/New Webapp");
        assert!(cmd.starts_with("cd '/home/New Webapp' 2>/dev/null ||"), "{cmd}");
        assert!(cmd.ends_with(r#"exec "${SHELL:-/bin/sh}" -l"#), "{cmd}");
        assert!(start_in_dir_command("~/apps/my app").starts_with("cd ~/'apps/my app' "));
        assert!(start_in_dir_command("~").starts_with("cd ~ "));
        assert_eq!(posix("echo 'hi'; exit 0"), r"sh -c 'echo '\''hi'\''; exit 0'");
    }
}
