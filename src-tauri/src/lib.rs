mod db;
mod error;
mod sftp;
mod ssh;
mod store;
mod tunnel;

use db::{SessionInfo, SessionRef, Sessions, StatementResult};
use ssh::{SshConfig, SshSessions};
use tauri::ipc::{Channel, InvokeResponseBody};
use error::{AppError, AppResult};
use std::sync::Mutex;
use store::{ConnectionConfig, Folder, ItemRef, Store, TunnelConfig};
use tauri::{Manager, State};

struct AppState {
    store: Mutex<Store>,
    sessions: Sessions,
    ssh: SshSessions,
    transfers: sftp::Transfers,
    tunnels: tunnel::Tunnels,
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
    events: Channel<InvokeResponseBody>,
) -> AppResult<()> {
    let (config, stored, known_hosts) = {
        let store = state.store.lock().unwrap();
        (store.get_ssh(&host_id)?, store.get_ssh_secret(&host_id), store.known_hosts_path())
    };
    let secret = state.ssh.transient_secrets.lock().unwrap().get(&host_id).cloned().or(stored);
    let req = ssh::OpenRequest { term_id, config, secret, accept_fingerprint, cols, rows, known_hosts };
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            app.manage(AppState {
                store: Mutex::new(Store::load(dir)),
                sessions: Sessions::new(),
                ssh: SshSessions::new(),
                transfers: sftp::Transfers::default(),
                tunnels: tunnel::Tunnels::default(),
            });
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tusk");
}
