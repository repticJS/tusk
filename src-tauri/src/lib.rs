mod db;
mod discover;
mod error;
mod files;
mod local;
mod mcp;
mod monitor;
mod pm2;
mod rdp;
mod share;
mod sftp;
mod ssh;
mod stats;
mod store;
mod tunnel;

use db::{SessionInfo, SessionRef, Sessions, StatementResult};
use ssh::{SshConfig, SshSessions};
use tauri::ipc::{Channel, InvokeResponseBody};
use error::{AppError, AppResult};
use std::sync::Mutex;
use store::{ConnectionConfig, Folder, FtpSite, ItemRef, RdpConfig, Store, TunnelConfig};
use tauri::{Emitter, Manager, State};

struct AppState {
    store: Mutex<Store>,
    sessions: Sessions,
    ssh: SshSessions,
    transfers: sftp::Transfers,
    files: files::FileSessions,
    rdp: std::sync::Arc<rdp::RdpSessions>,
    mcp: mcp::Mcp,
    tunnels: std::sync::Arc<tunnel::Tunnels>,
    local: local::LocalTerms,
    /// Shells found on this PC, detected once.
    shells: Mutex<Option<Vec<local::Shell>>>,
    monitor: monitor::Monitor,
    /// Running saved commands: one cancel signal per host.
    runs: Mutex<std::collections::HashMap<String, Vec<std::sync::Arc<tokio::sync::Notify>>>>,
}

impl AppState {
    fn config(&self, conn_id: &str) -> AppResult<ConnectionConfig> {
        self.store.lock().unwrap().get(conn_id)
    }

    fn password(&self, conn_id: &str) -> Option<String> {
        if let Some(p) = self.sessions.transient_passwords.lock().unwrap().get(conn_id) {
            return Some(p.clone());
        }
        self.store.lock().unwrap().get_password(conn_id)
    }

    async fn session(&self, sref: &SessionRef) -> AppResult<std::sync::Arc<db::Session>> {
        let config = self.config(&sref.conn_id)?;
        let password = self.password(&sref.conn_id);
        let via = self.db_tunnel(&format!("db:{}", config.id), &config).await?;
        self.sessions.get_or_open(sref, &config, password, via).await
    }

    fn ssh_creds(&self, host_id: &str) -> AppResult<tunnel::Creds> {
        let store = self.store.lock().unwrap();
        let config = store.get_ssh(host_id)?;
        let stored = store.get_ssh_secret(host_id);
        let secret = self.ssh.transient_secrets.lock().unwrap().get(host_id).cloned().or(stored);
        Ok(tunnel::Creds { config, secret, known_hosts: store.known_hosts_path() })
    }

    /// Starts (or finds) the SSH tunnel a database connection goes through and
    /// returns its local port; None for direct connections.
    async fn db_tunnel(&self, tunnel_id: &str, config: &ConnectionConfig) -> AppResult<Option<u16>> {
        let Some(host_id) = config.ssh_host_id.as_deref().filter(|h| !h.is_empty()) else {
            return Ok(None);
        };
        let creds = self.ssh_creds(host_id)?;
        Ok(Some(self.tunnels.db_port(tunnel_id, &config.host, config.port, creds).await?))
    }

    /// Connects to an SSH host (SFTP) or FTP site for file access; also
    /// returns its start folder.
    async fn open_remote(&self, kind: &str, id: &str) -> AppResult<(files::Remote, Option<String>)> {
        Ok(match kind {
            "ssh" => {
                let creds = self.ssh_creds(id)?;
                let accept = self.tunnels.take_accepted(id);
                let (handle, _) = ssh::connect(&creds.config, creds.secret.as_deref(), accept, &creds.known_hosts, Default::default())
                    .await
                    .map_err(|e| tunnel::ssh_error(e, &creds.config))?;
                let conn = std::sync::Arc::new(ssh::Connection { handle, sftp: Default::default() });
                (files::Remote::Sftp(conn), creds.config.start_dir)
            }
            "ftp" => {
                let site = self.store.lock().unwrap().get_ftp(id)?;
                let password = match self.ftp_password(id) {
                    Some(p) => p,
                    None if files::is_anonymous(&site) => "anonymous@".into(),
                    None => return Err(AppError::kind("FTP_PASSWORD_REQUIRED", format!("Password for {}", site.name))),
                };
                let ftp = files::ftp_connect(&site, &password).await?;
                let start = site.start_dir.clone();
                (files::Remote::ftp(site, password, ftp), start)
            }
            other => return Err(AppError::msg(format!("Unknown server type {other}"))),
        })
    }

    fn rdp_password(&self, id: &str) -> Option<String> {
        if let Some(p) = self.rdp.passwords.lock().unwrap().get(id) {
            return Some(p.clone());
        }
        self.store.lock().unwrap().get_rdp_password(id)
    }

    fn ftp_password(&self, site_id: &str) -> Option<String> {
        if let Some(p) = self.files.ftp_passwords.lock().unwrap().get(site_id) {
            return Some(p.clone());
        }
        self.store.lock().unwrap().get_ftp_password(site_id)
    }

    async fn shells(&self) -> Vec<local::Shell> {
        if let Some(s) = self.shells.lock().unwrap().clone() {
            return s;
        }
        // Detection may run `wsl -l`; keep it off the async runtime's threads.
        let found = tokio::task::spawn_blocking(local::detect_shells).await.unwrap_or_default();
        *self.shells.lock().unwrap() = Some(found.clone());
        found
    }

    async fn close_db(&self, conn_id: &str) {
        self.sessions.close_connection(conn_id).await;
        self.tunnels.stop(&format!("db:{conn_id}")).await;
    }

    /// Lets running tunnels reconnect with a host's latest settings.
    async fn refresh_tunnel_creds(&self, host_id: &str) {
        if let Ok(creds) = self.ssh_creds(host_id) {
            self.tunnels.update_creds(creds).await;
        }
    }
}

#[tauri::command]
fn list_connections(state: State<'_, AppState>) -> Vec<ConnectionConfig> {
    state.store.lock().unwrap().list()
}

/// Saves a connection. `password` of None leaves any stored password alone;
/// Some("") with save_password=false removes it.
#[tauri::command]
async fn save_connection(
    state: State<'_, AppState>,
    config: ConnectionConfig,
    password: Option<String>,
) -> AppResult<()> {
    let id = config.id.clone();
    let save_password = config.save_password;
    {
        let mut store = state.store.lock().unwrap();
        store.upsert(config)?;
        if !save_password {
            store.set_password(&id, None)?;
        } else if let Some(p) = password.as_deref() {
            store.set_password(&id, Some(p))?;
        }
    }
    if let Some(p) = password.filter(|_| !save_password) {
        state.sessions.transient_passwords.lock().unwrap().insert(id.clone(), p);
    }
    // Settings may have changed; reconnect lazily on next use.
    state.close_db(&id).await;
    Ok(())
}

#[tauri::command]
async fn delete_connection(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.close_db(&id).await;
    state.sessions.transient_passwords.lock().unwrap().remove(&id);
    state.store.lock().unwrap().delete(&id)
}

#[tauri::command]
fn reorder_connections(state: State<'_, AppState>, ids: Vec<String>) -> AppResult<()> {
    state.store.lock().unwrap().reorder(&ids)
}

#[tauri::command]
fn has_password(state: State<'_, AppState>, id: String) -> bool {
    state.password(&id).is_some()
}

/// Remembers a password typed at a prompt for the rest of this app run.
#[tauri::command]
fn set_session_password(state: State<'_, AppState>, id: String, password: String) {
    state.sessions.transient_passwords.lock().unwrap().insert(id, password);
}

#[tauri::command]
async fn test_connection(
    state: State<'_, AppState>,
    config: ConnectionConfig,
    password: Option<String>,
) -> AppResult<SessionInfo> {
    // No typed password: test an existing connection with what's stored.
    let password = password.or_else(|| state.password(&config.id));
    let tunnel_id = format!("test:{}", uuid::Uuid::new_v4());
    let result = async {
        let via = state.db_tunnel(&tunnel_id, &config).await?;
        Ok(db::connect(&config, &config.database, password, via).await?.info())
    }
    .await;
    state.tunnels.stop(&tunnel_id).await;
    result
}

#[tauri::command]
async fn open_session(state: State<'_, AppState>, session: SessionRef) -> AppResult<SessionInfo> {
    Ok(state.session(&session).await?.info())
}

#[tauri::command]
async fn close_session(state: State<'_, AppState>, session: SessionRef) -> AppResult<()> {
    state.sessions.close(&session).await;
    Ok(())
}

#[tauri::command]
async fn disconnect(state: State<'_, AppState>, conn_id: String) -> AppResult<()> {
    state.close_db(&conn_id).await;
    Ok(())
}

#[tauri::command]
async fn run_statements(
    state: State<'_, AppState>,
    session: SessionRef,
    statements: Vec<String>,
    max_rows: Option<usize>,
) -> AppResult<Vec<StatementResult>> {
    let s = state.session(&session).await?;
    Ok(s.run(&statements, max_rows.unwrap_or(10_000)).await)
}

#[tauri::command]
async fn execute_atomic(
    state: State<'_, AppState>,
    session: SessionRef,
    sql: String,
) -> AppResult<Vec<u64>> {
    state.session(&session).await?.execute_atomic(&sql).await
}

#[tauri::command]
async fn cancel_query(state: State<'_, AppState>, session: SessionRef) -> AppResult<()> {
    match state.sessions.existing(&session).await {
        Some(s) => s.cancel().await,
        None => Ok(()),
    }
}

// ---- folders ----

#[tauri::command]
fn list_folders(state: State<'_, AppState>) -> Vec<Folder> {
    state.store.lock().unwrap().list_folders()
}

/// Creates or renames a folder (also used to move it, via parent_id).
#[tauri::command]
fn save_folder(state: State<'_, AppState>, folder: Folder) -> AppResult<()> {
    state.store.lock().unwrap().save_folder(folder)
}

#[tauri::command]
fn delete_folder(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.store.lock().unwrap().delete_folder(&id)
}

#[tauri::command]
fn move_to_folder(state: State<'_, AppState>, items: Vec<ItemRef>, folder_id: Option<String>) -> AppResult<()> {
    state.store.lock().unwrap().move_items(&items, folder_id)
}

// ---- saved commands ----

#[tauri::command]
fn list_commands(state: State<'_, AppState>) -> Vec<store::SavedCommand> {
    state.store.lock().unwrap().list_commands()
}

#[tauri::command]
fn save_command(state: State<'_, AppState>, command: store::SavedCommand) -> AppResult<()> {
    state.store.lock().unwrap().save_command(command)
}

#[tauri::command]
fn delete_command(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.store.lock().unwrap().delete_command(&id)
}

#[derive(serde::Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
enum RunEvent {
    #[serde(rename_all = "camelCase")]
    Output { host_id: String, data: String },
    #[serde(rename_all = "camelCase")]
    Exit { host_id: String, status: Option<u32>, error: Option<AppError>, cancelled: bool },
}

/// Runs a script on several hosts at once, streaming each one's output.
/// Resolves when every host has finished.
#[tauri::command]
async fn run_command(
    state: State<'_, AppState>,
    run_id: String,
    host_ids: Vec<String>,
    script: String,
    stop_on_error: bool,
    events: Channel<RunEvent>,
) -> AppResult<()> {
    // Node tools installed through nvm & co. should be found, as in a login shell.
    let full = format!("{}\n{}{}", pm2::PATH_PRELUDE, if stop_on_error { "set -e\n" } else { "" }, script);
    let cmd = ssh::posix(&full);
    let mut cancels = Vec::new();
    let mut tasks = Vec::new();
    for host_id in host_ids {
        let cancel = std::sync::Arc::new(tokio::sync::Notify::new());
        cancels.push(cancel.clone());
        let creds = state.ssh_creds(&host_id);
        let tunnels = state.tunnels.clone();
        let (events, cmd) = (events.clone(), cmd.clone());
        tasks.push(async move {
            let out = events.clone();
            let id = host_id.clone();
            let result = match creds {
                Err(e) => Err(e),
                Ok(creds) => {
                    tunnels
                        .exec_stream(creds, &cmd, cancel, move |bytes| {
                            let data = String::from_utf8_lossy(bytes).into_owned();
                            let _ = out.send(RunEvent::Output { host_id: id.clone(), data });
                        })
                        .await
                }
            };
            let exit = match result {
                Ok(status) => RunEvent::Exit { host_id, status, error: None, cancelled: false },
                Err(e) => {
                    let cancelled = e.kind.as_deref() == Some("CANCELLED");
                    RunEvent::Exit { host_id, status: None, error: (!cancelled).then_some(e), cancelled }
                }
            };
            let _ = events.send(exit);
        });
    }
    state.runs.lock().unwrap().insert(run_id.clone(), cancels);
    futures_util::future::join_all(tasks).await;
    state.runs.lock().unwrap().remove(&run_id);
    Ok(())
}

#[tauri::command]
fn cancel_run(state: State<'_, AppState>, run_id: String) {
    if let Some(cancels) = state.runs.lock().unwrap().get(&run_id) {
        for c in cancels {
            c.notify_one();
        }
    }
}

// ---- monitoring ----

/// Checks one host now: records the result, raises alerts and tells the UI.
async fn check_host(app: tauri::AppHandle, host_id: String) {
    let state = app.state::<AppState>();
    let (settings, name) = {
        let store = state.store.lock().unwrap();
        (store.monitor(), store.get_ssh(&host_id).map(|h| h.name).unwrap_or_default())
    };
    let certs = state.monitor.begin(&host_id);
    let _ = app.emit("monitor-changed", ());
    let result = match state.ssh_creds(&host_id) {
        Err(e) => Err(e.message),
        // Monitoring never prompts: missing passwords or unknown host keys
        // show up as the host's error.
        Ok(creds) => state
            .tunnels
            .exec(creds, &ssh::posix(&monitor::script(certs)), std::time::Duration::from_secs(45))
            .await
            .map(|(out, _)| monitor::parse(&out))
            .map_err(|e| e.message),
    };
    let alerts = state.monitor.finish(&host_id, &name, result, settings.disk_threshold);
    if settings.notify && !alerts.is_empty() {
        notify(&app, &alerts);
    }
    let _ = app.emit("monitor-changed", ());
}

fn notify(app: &tauri::AppHandle, alerts: &[monitor::Alert]) {
    use tauri_plugin_notification::NotificationExt;
    let show = |title: &str, body: &str| {
        let _ = app.notification().builder().title(title).body(body).show();
    };
    let host = &alerts[0].host_name;
    if alerts.len() > 3 {
        let body: Vec<&str> = alerts.iter().take(3).map(|a| a.message.as_str()).collect();
        show(&format!("{host}: {} changes", alerts.len()), &format!("{}…", body.join("\n")));
    } else {
        for a in alerts {
            show(host, &a.message);
        }
    }
}

/// Checks monitored hosts when they're due; settings changes wake it early.
fn start_monitor(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Let the window come up first.
        tokio::time::sleep(std::time::Duration::from_secs(8)).await;
        loop {
            let state = app.state::<AppState>();
            let settings = state.store.lock().unwrap().monitor();
            for id in state.monitor.due(&settings.hosts, settings.interval_secs as u64) {
                tauri::async_runtime::spawn(check_host(app.clone(), id));
            }
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_secs(20)) => {}
                _ = state.monitor.wake.notified() => {}
            }
        }
    });
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MonitorView {
    settings: store::MonitorSettings,
    hosts: Vec<monitor::HostStatus>,
    alerts: Vec<monitor::Alert>,
}

#[tauri::command]
fn monitor_state(state: State<'_, AppState>) -> MonitorView {
    let settings = state.store.lock().unwrap().monitor();
    let hosts = state.monitor.statuses().into_iter().filter(|h| settings.hosts.contains(&h.host_id)).collect();
    MonitorView { settings, hosts, alerts: state.monitor.alerts() }
}

#[tauri::command]
fn monitor_save(state: State<'_, AppState>, settings: store::MonitorSettings) -> AppResult<()> {
    let before = state.store.lock().unwrap().monitor();
    for h in before.hosts.iter().filter(|h| !settings.hosts.contains(h)) {
        state.monitor.forget(h);
    }
    state.store.lock().unwrap().set_monitor(settings)?;
    state.monitor.wake.notify_one();
    Ok(())
}

/// Checks a host right away.
#[tauri::command]
async fn monitor_check(app: tauri::AppHandle, host_id: String) -> AppResult<()> {
    check_host(app, host_id).await;
    Ok(())
}

#[tauri::command]
fn monitor_clear_alerts(app: tauri::AppHandle, state: State<'_, AppState>) {
    state.monitor.clear_alerts();
    let _ = app.emit("monitor-changed", ());
}

// ---- sharing folders ----

impl AppState {
    fn ssh_secret(&self, host_id: &str) -> Option<String> {
        let stored = self.store.lock().unwrap().get_ssh_secret(host_id);
        self.ssh.transient_secrets.lock().unwrap().get(host_id).cloned().or(stored)
    }

    /// The passwords, SSH secrets and key files Tusk has for a bundle's items.
    fn share_secrets(&self, b: &share::Bundle) -> share::Secrets {
        let mut s = share::Secrets::default();
        for c in &b.connections {
            if let Some(p) = self.password(&c.id) {
                s.passwords.insert(c.id.clone(), p);
            }
        }
        for h in &b.ssh_hosts {
            if let Some(p) = self.ssh_secret(&h.id) {
                s.ssh.insert(h.id.clone(), p);
            }
            if h.auth == "key" {
                if let Some(k) = h.key_path.as_deref().and_then(share::read_key_file) {
                    s.keys.insert(h.id.clone(), k);
                }
            }
        }
        for f in &b.ftp_sites {
            if let Some(p) = self.ftp_password(&f.id) {
                s.ftp.insert(f.id.clone(), p);
            }
        }
        for r in &b.remote_desktops {
            if let Some(p) = self.rdp_password(&r.id) {
                s.rdp.insert(r.id.clone(), p);
            }
        }
        s
    }
}

/// What sharing a folder would include.
#[tauri::command]
fn share_info(state: State<'_, AppState>, folder_id: String) -> AppResult<share::ExportInfo> {
    let (bundle, extra) = share::collect(&state.store.lock().unwrap(), &folder_id)?;
    let secrets = state.share_secrets(&bundle);
    Ok(share::ExportInfo {
        name: bundle.folders[0].name.clone(),
        counts: share::counts(&bundle),
        extra_hosts: extra,
        passwords: secrets.passwords.len(),
        ftp_passwords: secrets.ftp.len(),
        rdp_passwords: secrets.rdp.len(),
        ssh_secrets: secrets.ssh.len(),
        key_files: secrets.keys.len(),
    })
}

/// A share code for a folder; with `include_secrets`, encrypted with `passphrase`.
#[tauri::command]
fn share_export(
    state: State<'_, AppState>,
    folder_id: String,
    include_secrets: bool,
    passphrase: Option<String>,
) -> AppResult<String> {
    let (mut bundle, _) = share::collect(&state.store.lock().unwrap(), &folder_id)?;
    if include_secrets {
        bundle.secrets = Some(state.share_secrets(&bundle));
    }
    let name = bundle.folders[0].name.clone();
    share::encode(&name, &bundle, if include_secrets { passphrase.as_deref() } else { None })
}

#[tauri::command]
fn share_preview(text: String) -> AppResult<share::Preview> {
    share::preview(&text)
}

/// Imports a share into `parent_id` (None: top level).
#[tauri::command]
async fn share_import(
    state: State<'_, AppState>,
    text: String,
    passphrase: Option<String>,
    parent_id: Option<String>,
) -> AppResult<share::ImportResult> {
    // Key derivation takes a moment; keep it off the async runtime.
    let bundle = tokio::task::spawn_blocking(move || share::decode(&text, passphrase.as_deref()))
        .await
        .map_err(|e| AppError::msg(e.to_string()))??;
    let mut store = state.store.lock().unwrap();
    let keys = store.keys_dir();
    share::import(&mut store, bundle, parent_id, &keys)
}

// ---- SSH ----

#[tauri::command]
fn list_ssh_hosts(state: State<'_, AppState>) -> Vec<SshConfig> {
    state.store.lock().unwrap().list_ssh()
}

/// Saves an SSH host. `secret` (password or key passphrase) of None leaves a
/// stored one alone.
#[tauri::command]
async fn save_ssh_host(state: State<'_, AppState>, config: SshConfig, secret: Option<String>) -> AppResult<()> {
    let id = config.id.clone();
    let save = config.save_secret;
    {
        let store = &mut state.store.lock().unwrap();
        store.upsert_ssh(config)?;
        if !save {
            store.set_ssh_secret(&id, None)?;
            if let Some(s) = secret {
                state.ssh.transient_secrets.lock().unwrap().insert(id.clone(), s);
            }
        } else if let Some(s) = secret.as_deref() {
            store.set_ssh_secret(&id, Some(s))?;
        }
    }
    state.refresh_tunnel_creds(&id).await;
    Ok(())
}

#[tauri::command]
async fn delete_ssh_host(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let tunnels: Vec<String> = {
        let store = &mut state.store.lock().unwrap();
        let ids = store.list_tunnels().into_iter().filter(|t| t.host_id == id).map(|t| t.id).collect();
        store.delete_ssh(&id)?;
        ids
    };
    for t in tunnels {
        state.tunnels.stop(&t).await;
    }
    state.ssh.transient_secrets.lock().unwrap().remove(&id);
    Ok(())
}

/// Remembers a password/passphrase typed at a prompt; `save` also stores it.
#[tauri::command]
async fn set_ssh_secret(state: State<'_, AppState>, id: String, secret: String, save: bool) -> AppResult<()> {
    if save {
        state.store.lock().unwrap().set_ssh_secret(&id, Some(&secret))?;
    }
    state.ssh.transient_secrets.lock().unwrap().insert(id.clone(), secret);
    state.refresh_tunnel_creds(&id).await;
    Ok(())
}

/// Trusts a host key the user approved, for the next tunnel or database
/// connection through that host.
#[tauri::command]
fn ssh_accept_host_key(state: State<'_, AppState>, host_id: String, fingerprint: String) {
    state.tunnels.accept_host_key(&host_id, fingerprint);
}

// ---- tunnels ----

#[tauri::command]
fn list_tunnels(state: State<'_, AppState>) -> Vec<TunnelConfig> {
    state.store.lock().unwrap().list_tunnels()
}

/// Saves a tunnel. A running tunnel is stopped so the new settings take
/// effect on its next start.
#[tauri::command]
async fn save_tunnel(state: State<'_, AppState>, tunnel: TunnelConfig) -> AppResult<()> {
    let id = tunnel.id.clone();
    state.store.lock().unwrap().save_tunnel(tunnel)?;
    state.tunnels.stop(&id).await;
    Ok(())
}

#[tauri::command]
async fn delete_tunnel(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.tunnels.stop(&id).await;
    state.store.lock().unwrap().delete_tunnel(&id)
}

/// Starts a saved tunnel and returns the port it listens on.
#[tauri::command]
async fn start_tunnel(state: State<'_, AppState>, id: String) -> AppResult<u16> {
    let t = state.store.lock().unwrap().get_tunnel(&id)?;
    let creds = state.ssh_creds(&t.host_id)?;
    let req = tunnel::StartRequest {
        id: t.id,
        kind: t.kind,
        bind_host: t.bind_host,
        bind_port: t.bind_port,
        target_host: t.target_host,
        target_port: t.target_port,
        creds,
    };
    state.tunnels.start(req).await
}

#[tauri::command]
async fn stop_tunnel(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.tunnels.stop(&id).await;
    Ok(())
}

/// Every running tunnel, including the private ones of database connections
/// (ids "db:<connection id>").
#[tauri::command]
async fn tunnel_status(state: State<'_, AppState>) -> AppResult<Vec<tunnel::TunnelStatus>> {
    Ok(state.tunnels.status().await)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn ssh_open(
    state: State<'_, AppState>,
    term_id: String,
    host_id: String,
    cols: u32,
    rows: u32,
    accept_fingerprint: Option<String>,
    command: Option<String>,
    events: Channel<InvokeResponseBody>,
) -> AppResult<()> {
    let (config, stored, known_hosts) = {
        let store = state.store.lock().unwrap();
        (store.get_ssh(&host_id)?, store.get_ssh_secret(&host_id), store.known_hosts_path())
    };
    let secret = state.ssh.transient_secrets.lock().unwrap().get(&host_id).cloned().or(stored);
    let req = ssh::OpenRequest { term_id, config, secret, accept_fingerprint, cols, rows, known_hosts, command };
    ssh::open(&state.ssh, req, events).await
}

#[tauri::command]
async fn ssh_write(state: State<'_, AppState>, term_id: String, data: String) -> AppResult<()> {
    state.ssh.write(&term_id, data.into_bytes()).await;
    Ok(())
}

#[tauri::command]
async fn ssh_resize(state: State<'_, AppState>, term_id: String, cols: u32, rows: u32) -> AppResult<()> {
    state.ssh.resize(&term_id, cols, rows).await;
    Ok(())
}

#[tauri::command]
async fn ssh_close(state: State<'_, AppState>, term_id: String) -> AppResult<()> {
    state.ssh.close(&term_id).await;
    Ok(())
}

// ---- local terminals ----

#[tauri::command]
async fn list_shells(state: State<'_, AppState>) -> AppResult<Vec<local::Shell>> {
    Ok(state.shells().await)
}

#[tauri::command]
async fn local_open(
    state: State<'_, AppState>,
    term_id: String,
    shell_id: String,
    cols: u16,
    rows: u16,
    command: Option<Vec<String>>,
    events: Channel<InvokeResponseBody>,
) -> AppResult<()> {
    let shell = match command.as_deref() {
        // A program to run directly, e.g. ["docker", "logs", "-f", "web"].
        Some([program, args @ ..]) => local::Shell {
            id: "command".into(),
            name: program.clone(),
            program: program.clone(),
            args: args.to_vec(),
            kind: "other".into(),
        },
        _ => state
            .shells()
            .await
            .into_iter()
            .find(|s| s.id == shell_id)
            .ok_or_else(|| AppError::msg("That shell isn't available on this PC"))?,
    };
    state.local.open(&term_id, &shell, cols, rows, events)
}

#[tauri::command]
async fn local_write(app: tauri::AppHandle, term_id: String, data: String) -> AppResult<()> {
    // A shell that isn't reading can block the write; keep it off the runtime.
    tokio::task::spawn_blocking(move || app.state::<AppState>().local.write(&term_id, data.as_bytes()))
        .await
        .map_err(|e| AppError::msg(e.to_string()))?
}

#[tauri::command]
fn local_resize(state: State<'_, AppState>, term_id: String, cols: u16, rows: u16) {
    state.local.resize(&term_id, cols, rows);
}

#[tauri::command]
fn local_close(state: State<'_, AppState>, term_id: String) {
    state.local.close(&term_id);
}

// ---- SFTP (over a terminal's connection) ----

#[tauri::command]
async fn sftp_list(state: State<'_, AppState>, term_id: String, path: String) -> AppResult<sftp::Listing> {
    sftp::list(&*state.ssh.connection(&term_id).await?, &path).await
}

/// The terminal shell's current directory, if the server lets us find it.
#[tauri::command]
async fn sftp_cwd(state: State<'_, AppState>, term_id: String) -> AppResult<Option<String>> {
    sftp::shell_cwd(&*state.ssh.connection(&term_id).await?).await
}

#[tauri::command]
async fn sftp_mkdir(state: State<'_, AppState>, term_id: String, path: String) -> AppResult<()> {
    sftp::mkdir(&*state.ssh.connection(&term_id).await?, &path).await
}

#[tauri::command]
async fn sftp_rename(state: State<'_, AppState>, term_id: String, from: String, to: String) -> AppResult<()> {
    sftp::rename(&*state.ssh.connection(&term_id).await?, &from, &to).await
}

#[tauri::command]
async fn sftp_delete(state: State<'_, AppState>, term_id: String, paths: Vec<String>) -> AppResult<()> {
    sftp::delete(&*state.ssh.connection(&term_id).await?, &paths).await
}

#[tauri::command]
async fn sftp_read_text(state: State<'_, AppState>, term_id: String, path: String) -> AppResult<sftp::TextFile> {
    sftp::read_text(&*state.ssh.connection(&term_id).await?, &path).await
}

#[tauri::command]
async fn sftp_write_text(state: State<'_, AppState>, term_id: String, path: String, content: String) -> AppResult<()> {
    sftp::write_text(&*state.ssh.connection(&term_id).await?, &path, &content).await
}

#[tauri::command]
async fn sftp_download(
    state: State<'_, AppState>,
    term_id: String,
    transfer_id: String,
    remote: Vec<String>,
    local_dir: String,
    events: Channel<sftp::Progress>,
) -> AppResult<()> {
    let conn = state.ssh.connection(&term_id).await?;
    sftp::download(&conn, &state.transfers, &transfer_id, &remote, &local_dir, events).await
}

#[tauri::command]
async fn sftp_upload(
    state: State<'_, AppState>,
    term_id: String,
    transfer_id: String,
    local: Vec<String>,
    remote_dir: String,
    events: Channel<sftp::Progress>,
) -> AppResult<()> {
    let conn = state.ssh.connection(&term_id).await?;
    sftp::upload(&conn, &state.transfers, &transfer_id, &local, &remote_dir, events).await
}

// ---- file manager ----

#[tauri::command]
fn list_ftp_sites(state: State<'_, AppState>) -> Vec<FtpSite> {
    state.store.lock().unwrap().list_ftp()
}

/// Saves an FTP site. `password` of None leaves a stored one alone.
#[tauri::command]
fn save_ftp_site(state: State<'_, AppState>, site: FtpSite, password: Option<String>) -> AppResult<()> {
    let id = site.id.clone();
    let save = site.save_password;
    let store = &mut state.store.lock().unwrap();
    store.upsert_ftp(site)?;
    if !save {
        store.set_ftp_password(&id, None)?;
        if let Some(p) = password {
            state.files.ftp_passwords.lock().unwrap().insert(id, p);
        }
    } else if let Some(p) = password.as_deref() {
        store.set_ftp_password(&id, Some(p))?;
        state.files.ftp_passwords.lock().unwrap().remove(&id);
    }
    Ok(())
}

#[tauri::command]
fn delete_ftp_site(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.files.ftp_passwords.lock().unwrap().remove(&id);
    state.store.lock().unwrap().delete_ftp(&id)
}

/// Remembers a password typed at a prompt; `save` also stores it.
#[tauri::command]
fn set_ftp_password(state: State<'_, AppState>, id: String, password: String, save: bool) -> AppResult<()> {
    if save {
        let store = &mut state.store.lock().unwrap();
        let site = store.get_ftp(&id)?;
        store.upsert_ftp(FtpSite { save_password: true, ..site })?;
        store.set_ftp_password(&id, Some(&password))?;
    }
    state.files.ftp_passwords.lock().unwrap().insert(id, password);
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FilesOpened {
    path: String,
    home: String,
}

/// Connects a Files tab to an SSH host (SFTP) or FTP site. Fails with the
/// SSH_* prompt kinds, FTP_PASSWORD_REQUIRED, FTP_AUTH_FAILED or FTP_TLS
/// when the user needs to be asked something.
#[tauri::command]
async fn files_open(state: State<'_, AppState>, session_id: String, kind: String, id: String) -> AppResult<FilesOpened> {
    let (remote, start_dir) = state.open_remote(&kind, &id).await?;
    let (path, home) = remote.start_paths(start_dir.as_deref()).await?;
    state.files.insert(session_id, remote).await;
    Ok(FilesOpened { path, home })
}

#[tauri::command]
async fn files_close(state: State<'_, AppState>, session_id: String) -> AppResult<()> {
    state.files.close(&session_id).await;
    Ok(())
}

#[tauri::command]
async fn files_list(state: State<'_, AppState>, session_id: String, path: String) -> AppResult<sftp::Listing> {
    state.files.get(&session_id).await?.list(&path).await
}

#[tauri::command]
async fn files_mkdir(state: State<'_, AppState>, session_id: String, path: String) -> AppResult<()> {
    state.files.get(&session_id).await?.mkdir(&path).await
}

#[tauri::command]
async fn files_rename(state: State<'_, AppState>, session_id: String, from: String, to: String) -> AppResult<()> {
    state.files.get(&session_id).await?.rename(&from, &to).await
}

#[tauri::command]
async fn files_delete(state: State<'_, AppState>, session_id: String, paths: Vec<String>) -> AppResult<()> {
    state.files.get(&session_id).await?.delete(&paths).await
}

#[tauri::command]
async fn files_read_text(state: State<'_, AppState>, session_id: String, path: String) -> AppResult<files::TextFile> {
    state.files.get(&session_id).await?.read_text(&path).await
}

#[tauri::command]
async fn files_write_text(state: State<'_, AppState>, session_id: String, path: String, content: String) -> AppResult<()> {
    state.files.get(&session_id).await?.write_text(&path, &content).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn files_download(
    state: State<'_, AppState>,
    session_id: String,
    transfer_id: String,
    sources: Vec<files::RemoteSource>,
    local_dir: String,
    policy: files::Policy,
    events: Channel<sftp::Progress>,
) -> AppResult<files::TransferResult> {
    let remote = state.files.get(&session_id).await?;
    files::download(&remote, &state.transfers, &transfer_id, &sources, &local_dir, policy, events).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn files_upload(
    state: State<'_, AppState>,
    session_id: String,
    transfer_id: String,
    local: Vec<String>,
    remote_dir: String,
    policy: files::Policy,
    events: Channel<sftp::Progress>,
) -> AppResult<files::TransferResult> {
    let remote = state.files.get(&session_id).await?;
    files::upload(&remote, &state.transfers, &transfer_id, &local, &remote_dir, policy, events).await
}

/// File system calls block; keep them off the async runtime.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| AppError::msg(e.to_string()))?
}

#[tauri::command]
async fn local_list(path: String) -> AppResult<files::LocalListing> {
    blocking(move || files::local_list(&path)).await
}

#[tauri::command]
async fn local_mkdir(path: String) -> AppResult<()> {
    blocking(move || files::local_mkdir(&path)).await
}

#[tauri::command]
async fn local_rename(from: String, to: String) -> AppResult<()> {
    blocking(move || files::local_rename(&from, &to)).await
}

#[tauri::command]
async fn local_delete(paths: Vec<String>) -> AppResult<()> {
    blocking(move || files::local_delete(&paths)).await
}

// ---- remote desktop ----

#[tauri::command]
fn list_rdp(state: State<'_, AppState>) -> Vec<RdpConfig> {
    state.store.lock().unwrap().list_rdp()
}

/// Saves a remote desktop. `password` of None leaves a stored one alone.
#[tauri::command]
fn save_rdp(state: State<'_, AppState>, config: RdpConfig, password: Option<String>) -> AppResult<()> {
    let id = config.id.clone();
    let save = config.save_password;
    let store = &mut state.store.lock().unwrap();
    store.upsert_rdp(config)?;
    if !save {
        store.set_rdp_password(&id, None)?;
        if let Some(p) = password {
            state.rdp.passwords.lock().unwrap().insert(id, p);
        }
    } else if let Some(p) = password.as_deref() {
        store.set_rdp_password(&id, Some(p))?;
        state.rdp.passwords.lock().unwrap().remove(&id);
    }
    Ok(())
}

#[tauri::command]
fn delete_rdp(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.rdp.passwords.lock().unwrap().remove(&id);
    state.store.lock().unwrap().delete_rdp(&id)
}

/// Remembers a password typed at a prompt; `save` also stores it.
#[tauri::command]
fn set_rdp_password(state: State<'_, AppState>, id: String, password: String, save: bool) -> AppResult<()> {
    if save {
        let store = &mut state.store.lock().unwrap();
        let config = store.get_rdp(&id)?;
        store.upsert_rdp(RdpConfig { save_password: true, ..config })?;
        store.set_rdp_password(&id, Some(&password))?;
    }
    state.rdp.passwords.lock().unwrap().insert(id, password);
    Ok(())
}

/// Connects a remote desktop tab. Fails with RDP_PASSWORD_REQUIRED,
/// RDP_AUTH_FAILED, RDP_CERT_UNKNOWN or RDP_CERT_CHANGED when the user
/// needs to be asked something.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn rdp_open(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    conn_id: String,
    width: u16,
    height: u16,
    scale: u32,
    accept_fingerprint: Option<String>,
    events: Channel<InvokeResponseBody>,
) -> AppResult<()> {
    let (config, known_hosts) = {
        let store = state.store.lock().unwrap();
        (store.get_rdp(&conn_id)?, store.rdp_known_path())
    };
    let password = state.rdp_password(&conn_id);
    let req = rdp::OpenRequest { session_id, config, password, accept_fingerprint, width, height, scale, known_hosts };
    rdp::open(app, state.rdp.clone(), req, events).await
}

#[tauri::command]
fn rdp_input(state: State<'_, AppState>, session_id: String, events: Vec<rdp::InputEvent>) {
    state.rdp.input(&session_id, events);
}

#[tauri::command]
fn rdp_resize(state: State<'_, AppState>, session_id: String, width: u16, height: u16, scale: u32) {
    state.rdp.resize(&session_id, width, height, scale);
}

/// Lets go of all keys and buttons (the tab lost focus).
#[tauri::command]
fn rdp_release(state: State<'_, AppState>, session_id: String) {
    state.rdp.release_all(&session_id);
}

#[tauri::command]
fn rdp_close(state: State<'_, AppState>, session_id: String) {
    state.rdp.close(&session_id);
}

// ---- Claude (MCP) ----

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeState {
    enabled: bool,
    access: std::collections::HashMap<String, store::ClaudeAccess>,
    #[serde(flatten)]
    view: mcp::McpView,
    setup: mcp::Setup,
}

#[tauri::command]
fn claude_state(state: State<'_, AppState>) -> ClaudeState {
    let settings = state.store.lock().unwrap().claude();
    ClaudeState { enabled: settings.enabled, access: settings.access, view: state.mcp.view(), setup: mcp::setup() }
}

/// Turns Claude's access to Tusk on or off (the local server runs only while on).
#[tauri::command]
async fn claude_set_enabled(app: tauri::AppHandle, state: State<'_, AppState>, on: bool) -> AppResult<()> {
    state.store.lock().unwrap().set_claude_enabled(on)?;
    if on {
        mcp::start(app).await
    } else {
        state.mcp.stop();
        let _ = app.emit("claude-changed", ());
        Ok(())
    }
}

/// What Claude may do with an item; None follows its folder again.
#[tauri::command]
fn claude_set_access(app: tauri::AppHandle, state: State<'_, AppState>, id: String, access: Option<store::ClaudeAccess>) -> AppResult<()> {
    state.store.lock().unwrap().set_claude_access(&id, access)?;
    let _ = app.emit("claude-changed", ());
    Ok(())
}

/// The user's answer to a request: allow | session | deny.
#[tauri::command]
fn claude_decide(state: State<'_, AppState>, id: String, decision: String) {
    state.mcp.decide(&id, &decision);
}

#[tauri::command]
fn claude_clear_activity(app: tauri::AppHandle, state: State<'_, AppState>) {
    state.mcp.clear_activity();
    let _ = app.emit("claude-changed", ());
}

/// Adds Tusk to the Claude desktop app's settings; returns the files changed.
#[tauri::command]
fn claude_install_desktop() -> AppResult<Vec<String>> {
    mcp::install_desktop()
}

// ---- discovery ----

const SCAN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Databases and containers on this PC.
#[tauri::command]
async fn discover_local() -> AppResult<discover::ScanResult> {
    discover::scan_local().await
}

/// Databases and containers on a saved SSH host (its own connection).
#[tauri::command]
async fn discover_host(state: State<'_, AppState>, host_id: String) -> AppResult<discover::ScanResult> {
    let creds = state.ssh_creds(&host_id)?;
    let (out, _) = state.tunnels.exec(creds, &ssh::posix(&discover::scan_script()), SCAN_TIMEOUT).await?;
    Ok(discover::parse_scan(&out))
}

/// Same as discover_host, over an open terminal's connection.
#[tauri::command]
async fn discover_terminal(state: State<'_, AppState>, term_id: String) -> AppResult<discover::ScanResult> {
    let conn = state.ssh.connection(&term_id).await?;
    let (out, _) = sftp::exec_on(&conn.handle, &ssh::posix(&discover::scan_script()), SCAN_TIMEOUT).await?;
    Ok(discover::parse_scan(&out))
}

/// start / stop / restart a container on this PC (host_id None) or a host.
#[tauri::command]
async fn docker_action(
    state: State<'_, AppState>,
    host_id: Option<String>,
    command: String,
    action: String,
    id: String,
) -> AppResult<()> {
    let Some(host_id) = host_id else {
        return discover::docker_local(&command, &action, &id).await;
    };
    let cmd = discover::docker_command(&command, &action, &id)?;
    let creds = state.ssh_creds(&host_id)?;
    match state.tunnels.exec(creds, &ssh::posix(&cmd), SCAN_TIMEOUT).await? {
        (_, Some(0)) => Ok(()),
        (out, _) => Err(AppError::msg(out.trim().to_string())),
    }
}

// ---- systemd ----

/// start / stop / restart / reload / enable / disable a service on a host
/// (or this PC when host_id is None). Fails with kind SUDO_REQUIRED when it
/// needs a password, so the UI can offer a terminal instead.
#[tauri::command]
async fn systemd_action(
    state: State<'_, AppState>,
    host_id: Option<String>,
    action: String,
    unit: String,
) -> AppResult<()> {
    let script = discover::systemd_script(&action, &unit)?;
    let (ok, out) = match host_id {
        Some(h) => {
            let creds = state.ssh_creds(&h)?;
            let (out, status) = state.tunnels.exec(creds, &ssh::posix(&script), SCAN_TIMEOUT).await?;
            (status == Some(0), out)
        }
        None => {
            let out = tokio::task::spawn_blocking(move || std::process::Command::new("sh").arg("-c").arg(script).output())
                .await
                .map_err(|e| AppError::msg(e.to_string()))??;
            let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
            text.push_str(&String::from_utf8_lossy(&out.stderr));
            (out.status.success(), text)
        }
    };
    if ok {
        return Ok(());
    }
    let lower = out.to_lowercase();
    if ["password is required", "interactive authentication required", "access denied", "not in the sudoers", "sudo:"]
        .iter()
        .any(|p| lower.contains(p))
    {
        return Err(AppError::kind("SUDO_REQUIRED", "This needs root. Run it in a terminal to enter your sudo password."));
    }
    Err(AppError::msg(out.trim().lines().last().unwrap_or("systemctl failed").to_string()))
}

/// The command a terminal tab runs: the journal of a service ("logs"), or an
/// action done with interactive sudo.
#[tauri::command]
fn systemd_terminal(kind: String, unit: String, action: Option<String>) -> AppResult<String> {
    match kind.as_str() {
        "logs" => discover::journal_command(&unit),
        _ => discover::systemd_terminal_command(action.as_deref().unwrap_or(""), &unit),
    }
}

// ---- PM2 ----

/// Runs a PM2 script on a host (or this PC when host_id is None) and returns
/// its output, failing with PM2's own error line.
async fn run_pm2(state: &AppState, host_id: Option<String>, script: String) -> AppResult<String> {
    let Some(host_id) = host_id else {
        return pm2::run_local(script).await;
    };
    let creds = state.ssh_creds(&host_id)?;
    match state.tunnels.exec(creds, &ssh::posix(&script), SCAN_TIMEOUT).await? {
        (out, Some(0)) => Ok(out),
        (out, _) => Err(AppError::msg(pm2::last_error(&out))),
    }
}

/// PM2 apps on a host or this PC (refreshed often while shown).
#[tauri::command]
async fn pm2_list(state: State<'_, AppState>, host_id: Option<String>) -> AppResult<pm2::Pm2> {
    let text = match host_id {
        None => tokio::task::spawn_blocking(pm2::local_list_text).await.map_err(|e| AppError::msg(e.to_string()))?,
        Some(h) => {
            let creds = state.ssh_creds(&h)?;
            state.tunnels.exec(creds, &ssh::posix(&pm2::list_script()), SCAN_TIMEOUT).await?.0
        }
    };
    Ok(pm2::parse(&discover::sections(&text)))
}

/// start / stop / restart / reload / delete / flush / reset an app (id,
/// name or "all"), or save / resurrect the process list.
#[tauri::command]
async fn pm2_action(
    state: State<'_, AppState>,
    host_id: Option<String>,
    action: String,
    target: Option<String>,
) -> AppResult<()> {
    let script = pm2::action_script(&action, target.as_deref())?;
    run_pm2(&state, host_id, script).await.map(|_| ())
}

#[tauri::command]
async fn pm2_start(
    state: State<'_, AppState>,
    host_id: Option<String>,
    script: String,
    name: String,
    cwd: String,
    instances: u32,
) -> AppResult<()> {
    let script = pm2::start_script(&script, &name, &cwd, instances)?;
    run_pm2(&state, host_id, script).await.map(|_| ())
}

/// The command a terminal tab runs for `pm2 logs` or `pm2 monit`.
#[tauri::command]
fn pm2_terminal(kind: String, target: Option<String>) -> AppResult<pm2::TerminalCommand> {
    pm2::terminal_command(&kind, target.as_deref())
}

/// CPU, memory, disk and network counters of a terminal's server.
#[tauri::command]
async fn ssh_stats(state: State<'_, AppState>, term_id: String) -> AppResult<stats::Snapshot> {
    stats::snapshot(&*state.ssh.connection(&term_id).await?).await
}

#[tauri::command]
async fn ssh_processes(state: State<'_, AppState>, term_id: String) -> AppResult<stats::Processes> {
    stats::processes(&*state.ssh.connection(&term_id).await?).await
}

#[tauri::command]
fn sftp_cancel(state: State<'_, AppState>, transfer_id: String) {
    state.transfers.cancel(&transfer_id);
}

#[tauri::command]
fn write_text_file(path: String, contents: String) -> AppResult<()> {
    std::fs::write(path, contents).map_err(AppError::from)
}

#[tauri::command]
fn read_text_file(path: String) -> AppResult<String> {
    std::fs::read_to_string(path).map_err(AppError::from)
}

/// `tusk --mcp`: the bridge Claude starts (no window).
pub fn mcp_bridge() {
    mcp::bridge()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            app.manage(AppState {
                store: Mutex::new(Store::load(dir)),
                sessions: Sessions::new(),
                ssh: SshSessions::new(),
                transfers: sftp::Transfers::default(),
                files: Default::default(),
                rdp: Default::default(),
                mcp: Default::default(),
                tunnels: Default::default(),
                local: local::LocalTerms::default(),
                shells: Mutex::new(None),
                monitor: Default::default(),
                runs: Default::default(),
            });
            start_monitor(app.handle().clone());
            if app.state::<AppState>().store.lock().unwrap().claude().enabled {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let _ = mcp::start(handle).await;
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_connections,
            save_connection,
            delete_connection,
            reorder_connections,
            has_password,
            set_session_password,
            test_connection,
            open_session,
            close_session,
            disconnect,
            run_statements,
            execute_atomic,
            cancel_query,
            write_text_file,
            read_text_file,
            list_folders,
            save_folder,
            delete_folder,
            move_to_folder,
            share_info,
            monitor_state,
            list_commands,
            save_command,
            delete_command,
            run_command,
            cancel_run,
            monitor_save,
            monitor_check,
            monitor_clear_alerts,
            share_export,
            share_preview,
            share_import,
            list_ssh_hosts,
            save_ssh_host,
            delete_ssh_host,
            set_ssh_secret,
            ssh_accept_host_key,
            list_tunnels,
            save_tunnel,
            delete_tunnel,
            start_tunnel,
            stop_tunnel,
            tunnel_status,
            ssh_open,
            ssh_write,
            ssh_resize,
            ssh_close,
            list_shells,
            local_open,
            local_write,
            local_resize,
            local_close,
            sftp_list,
            sftp_cwd,
            sftp_mkdir,
            sftp_rename,
            sftp_delete,
            sftp_read_text,
            sftp_write_text,
            sftp_download,
            sftp_upload,
            sftp_cancel,
            list_ftp_sites,
            list_rdp,
            claude_state,
            claude_set_enabled,
            claude_set_access,
            claude_decide,
            claude_clear_activity,
            claude_install_desktop,
            save_rdp,
            delete_rdp,
            set_rdp_password,
            rdp_open,
            rdp_input,
            rdp_resize,
            rdp_release,
            rdp_close,
            save_ftp_site,
            delete_ftp_site,
            set_ftp_password,
            files_open,
            files_close,
            files_list,
            files_mkdir,
            files_rename,
            files_delete,
            files_read_text,
            files_write_text,
            files_download,
            files_upload,
            local_list,
            local_mkdir,
            local_rename,
            local_delete,
            ssh_stats,
            discover_local,
            discover_host,
            discover_terminal,
            docker_action,
            pm2_list,
            systemd_action,
            systemd_terminal,
            pm2_action,
            pm2_start,
            pm2_terminal,
            ssh_processes,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tusk");
}
