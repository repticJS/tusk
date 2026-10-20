mod db;
mod error;
mod store;

use db::{SessionInfo, SessionRef, Sessions, StatementResult};
use error::{AppError, AppResult};
use std::sync::Mutex;
use store::{ConnectionConfig, Store};
use tauri::{Manager, State};

struct AppState {
    store: Mutex<Store>,
    sessions: Sessions,
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
        self.sessions.get_or_open(sref, &config, password).await
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
    state.sessions.close_connection(&id).await;
    Ok(())
}

#[tauri::command]
async fn delete_connection(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.sessions.close_connection(&id).await;
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
    let session = db::connect(&config, &config.database, password).await?;
    Ok(session.info())
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
    state.sessions.close_connection(&conn_id).await;
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
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            app.manage(AppState { store: Mutex::new(Store::load(dir)), sessions: Sessions::new() });
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tusk");
}
