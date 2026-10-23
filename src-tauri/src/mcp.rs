//! Claude's access to Tusk through MCP (the Model Context Protocol).
//!
//! Claude (the desktop app or Claude Code) starts `tusk --mcp`: a small
//! bridge that relays MCP messages (JSON-RPC, one per line) between Claude
//! and the running Tusk over a local socket. Tusk does the work with the
//! user's saved connections; passwords and keys never reach Claude.
//!
//! Nothing is reachable unless the user turns Claude access on, and then
//! only the connections, hosts and sites (or folders) they allow: read-only
//! or read and write. Changes ask for the user's OK in Tusk unless they
//! said not to, and everything Claude does is listed in the Claude tab.

use crate::db::{SessionRef, StatementResult};
use crate::error::{AppError, AppResult};
use crate::store::ClaudeAccess;
use crate::AppState;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, watch};

const PROTOCOL_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
/// Longest tool result handed to Claude.
const MAX_OUTPUT: usize = 60_000;
/// Most of a request or result kept for the activity list.
const MAX_SHOWN: usize = 20_000;
const MAX_LIVE_OUTPUT: usize = 200_000;
const MAX_ACTIVITY: usize = 200;
/// How long an approval waits for the user.
const APPROVAL_WAIT: Duration = Duration::from_secs(600);

const INSTRUCTIONS: &str = "Tusk is the user's database and server manager. Through it you can use the PostgreSQL \
databases, SSH servers and FTP sites the user has allowed. Start with list_connections. db_query always runs in a \
read-only transaction. Tools that change something (db_execute, server_run, files_write, run_saved_command) need \
write access and usually the user's OK in Tusk, so say what you are about to do and why before calling them.";

const OFF_MESSAGE: &str = "Tusk isn't letting Claude in right now. Ask the user to open Tusk, go to the Claude tab \
(Ctrl+P → Claude) and turn on \"Let Claude use Tusk\", and allow the connections Claude should use.";

/// Where the running Tusk says how to reach it: port and token.
fn info_path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("dev.tusk.app").join("mcp.json"))
}

#[derive(Serialize, Deserialize)]
struct ServerInfo {
    port: u16,
    token: String,
}

fn initialize_result(requested: Option<&str>) -> Value {
    let version = requested.filter(|v| PROTOCOL_VERSIONS.contains(v)).unwrap_or(PROTOCOL_VERSIONS[1]);
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": { "listChanged": true } },
        "serverInfo": { "name": "tusk", "title": "Tusk", "version": env!("CARGO_PKG_VERSION") },
        "instructions": INSTRUCTIONS,
    })
}

fn reply(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_error(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn text_result(text: String, is_error: bool) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

// ---- the bridge Claude starts ----

/// What the bridge answers itself while Tusk isn't reachable.
fn stub_reply(msg: &Value) -> Option<Value> {
    let id = msg.get("id")?;
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    Some(match method {
        "initialize" => reply(id, initialize_result(msg["params"]["protocolVersion"].as_str())),
        "ping" => reply(id, json!({})),
        "tools/list" => reply(
            id,
            json!({ "tools": [{
                "name": "tusk_status",
                "description": "Explains how the user can let Claude use Tusk (it is closed or Claude access is off).",
                "inputSchema": { "type": "object", "properties": {} },
            }] }),
        ),
        "tools/call" => reply(id, text_result(OFF_MESSAGE.into(), true)),
        _ => rpc_error(id, -32601, "Method not found"),
    })
}

/// `tusk --mcp`: relays stdin/stdout to the running Tusk, connecting (again)
/// whenever a message arrives, so turning access on works without
/// restarting Claude.
pub fn bridge() {
    use std::io::{BufRead, Write};
    type Shared<T> = Arc<Mutex<T>>;
    let stdout: Shared<std::io::Stdout> = Arc::new(Mutex::new(std::io::stdout()));
    let live: Shared<Option<std::net::TcpStream>> = Arc::new(Mutex::new(None));
    let mut client = String::new();
    let mut initialized = false;

    let send = |out: &Shared<std::io::Stdout>, v: &Value| {
        let mut o = out.lock().unwrap();
        let _ = writeln!(o, "{v}");
        let _ = o.flush();
    };

    let connect = |client: &str| -> Option<std::net::TcpStream> {
        let info: ServerInfo = serde_json::from_slice(&std::fs::read(info_path()?).ok()?).ok()?;
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], info.port));
        let mut s = std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(2)).ok()?;
        writeln!(s, "{}", json!({ "token": info.token, "client": client })).ok()?;
        let reader = s.try_clone().ok()?;
        let (out, live) = (stdout.clone(), live.clone());
        std::thread::spawn(move || {
            for line in std::io::BufReader::new(reader).lines() {
                let Ok(line) = line else { break };
                let mut o = out.lock().unwrap();
                let _ = writeln!(o, "{line}");
                let _ = o.flush();
            }
            // Tusk closed or turned access off: answer from the stub again.
            *live.lock().unwrap() = None;
        });
        Some(s)
    };

    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let msg: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
        if msg["method"] == "initialize" {
            client = msg["params"]["clientInfo"]["name"].as_str().unwrap_or("").to_string();
        }
        {
            let mut guard = live.lock().unwrap();
            if guard.is_none() {
                *guard = connect(&client);
                // Tools appeared since Claude last asked.
                if guard.is_some() && initialized {
                    send(&stdout, &json!({ "jsonrpc": "2.0", "method": "notifications/tools/list_changed" }));
                }
            }
            if let Some(sock) = guard.as_mut() {
                if writeln!(sock, "{line}").is_ok() {
                    initialized |= msg["method"] == "initialize";
                    continue;
                }
                *guard = None;
            }
        }
        initialized |= msg["method"] == "initialize";
        if let Some(r) = stub_reply(&msg) {
            send(&stdout, &r);
        }
    }
}

// ---- state inside Tusk ----

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    pub id: String,
    pub client: String,
    pub tool: String,
    pub target: String,
    pub title: String,
    pub detail: String,
    pub at: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub id: u64,
    pub at: u64,
    pub client: String,
    pub tool: String,
    pub target: String,
    /// database | server | ftp, when the target is known.
    pub target_kind: String,
    pub target_id: String,
    pub database: String,
    pub detail: String,
    /// running | waiting | ok | error | denied
    pub outcome: String,
    pub summary: String,
    /// The whole request: SQL, command, path and so on.
    pub input: String,
    /// What Claude got back.
    pub result: String,
    /// Output of a command while it runs.
    pub output: String,
    /// How long it took, once done.
    pub ms: u64,
}

#[derive(Serialize, Clone)]
struct OutputChunk {
    id: u64,
    text: String,
    /// Output length after this chunk, so a stale view can tell it missed some.
    len: usize,
}

#[derive(Default)]
pub struct Mcp {
    server: Mutex<Option<tokio::task::JoinHandle<()>>>,
    approvals: Mutex<HashMap<String, (ApprovalRequest, oneshot::Sender<String>)>>,
    activity: Mutex<VecDeque<Activity>>,
    /// Connected Claude clients by connection number.
    clients: Mutex<HashMap<u64, String>>,
    /// Stop switches for tool calls that are running, by activity id.
    stops: Mutex<HashMap<u64, watch::Sender<bool>>>,
    /// "connection|tool|target" the user allowed for the rest of a session.
    allowed: Mutex<HashSet<String>>,
    seq: AtomicU64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpView {
    pub running: bool,
    pub clients: Vec<String>,
    pub pending: Vec<ApprovalRequest>,
    pub activity: Vec<Activity>,
}

impl Mcp {
    pub fn view(&self) -> McpView {
        let mut clients: Vec<String> = self.clients.lock().unwrap().values().cloned().collect();
        clients.sort();
        McpView {
            running: self.server.lock().unwrap().is_some(),
            clients,
            pending: self.approvals.lock().unwrap().values().map(|(r, _)| r.clone()).collect(),
            activity: self.activity.lock().unwrap().iter().cloned().collect(),
        }
    }

    pub fn clear_activity(&self) {
        self.activity.lock().unwrap().retain(|e| e.outcome == "running" || e.outcome == "waiting");
    }

    /// The user stopped a tool call in Tusk.
    pub fn stop_call(&self, id: u64) {
        if let Some(tx) = self.stops.lock().unwrap().get(&id) {
            let _ = tx.send(true);
        }
    }

    /// The user's answer to an approval: allow | session | deny.
    pub fn decide(&self, id: &str, decision: &str) {
        if let Some((_, tx)) = self.approvals.lock().unwrap().remove(id) {
            let _ = tx.send(decision.to_string());
        }
    }

    /// Adds a running entry to the activity list and returns its id.
    fn begin(&self, app: &tauri::AppHandle, mut entry: Activity) -> u64 {
        entry.id = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        entry.at = crate::monitor::now();
        let id = entry.id;
        let _ = app.emit("claude-activity", &entry);
        let mut a = self.activity.lock().unwrap();
        a.push_front(entry);
        a.truncate(MAX_ACTIVITY);
        id
    }

    fn update(&self, app: &tauri::AppHandle, id: u64, f: impl FnOnce(&mut Activity)) {
        let mut a = self.activity.lock().unwrap();
        if let Some(e) = a.iter_mut().find(|e| e.id == id) {
            f(e);
            let _ = app.emit("claude-activity", &*e);
        }
    }

    /// Live output of a command Claude is running.
    fn output(&self, app: &tauri::AppHandle, id: u64, text: &str) {
        let mut a = self.activity.lock().unwrap();
        if let Some(e) = a.iter_mut().find(|e| e.id == id) {
            if e.output.len() >= MAX_LIVE_OUTPUT {
                return;
            }
            e.output.push_str(text);
            let _ = app.emit("claude-output", OutputChunk { id, text: text.to_string(), len: e.output.len() });
        }
    }

    pub fn stop(&self) {
        if let Some(h) = self.server.lock().unwrap().take() {
            h.abort();
        }
        self.clients.lock().unwrap().clear();
        for (_, (_, tx)) in self.approvals.lock().unwrap().drain() {
            let _ = tx.send("deny".into());
        }
        if let Some(p) = info_path() {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// Starts the local server (if not running) and tells the bridge how to reach it.
pub async fn start(app: tauri::AppHandle) -> AppResult<()> {
    let mcp = &app.state::<AppState>().mcp;
    if mcp.server.lock().unwrap().is_some() {
        return Ok(());
    }
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let token: String = {
        use rand::RngCore;
        let mut b = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut b);
        b.iter().map(|x| format!("{x:02x}")).collect()
    };
    let path = info_path().ok_or_else(|| AppError::msg("No config folder"))?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    write_private(&path, &serde_json::to_vec(&ServerInfo { port, token: token.clone() })?)?;
    let handle = {
        let app = app.clone();
        tokio::spawn(async move {
            let mut n = 0u64;
            while let Ok((stream, _)) = listener.accept().await {
                n += 1;
                tokio::spawn(serve(app.clone(), stream, token.clone(), n));
            }
        })
    };
    *mcp.server.lock().unwrap() = Some(handle);
    let _ = app.emit("claude-changed", ());
    Ok(())
}

fn write_private(path: &std::path::Path, data: &[u8]) -> AppResult<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path)?;
        f.write_all(data)?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, data).map_err(AppError::from)
    }
}

/// Compares without leaking where the difference is.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// One connected Claude: a handshake line, then MCP messages.
async fn serve(app: tauri::AppHandle, stream: tokio::net::TcpStream, token: String, conn: u64) {
    let (read, mut write) = stream.into_split();
    let mut lines = BufReader::new(read).lines();
    let Ok(Some(first)) = lines.next_line().await else { return };
    let hello: Value = serde_json::from_str(&first).unwrap_or(Value::Null);
    if !same(hello["token"].as_str().unwrap_or(""), &token) {
        return;
    }
    let client = client_label(hello["client"].as_str().unwrap_or(""));
    let mcp = &app.state::<AppState>().mcp;
    mcp.clients.lock().unwrap().insert(conn, client.clone());
    let _ = app.emit("claude-changed", ());

    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            if write.write_all(format!("{line}\n").as_bytes()).await.is_err() {
                break;
            }
        }
    });
    let client = Arc::new(Mutex::new(client));
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        // Access was turned off: answer like the bridge does, then hang up.
        if mcp.server.lock().unwrap().is_none() {
            if let Some(r) = stub_reply(&msg) {
                let _ = tx.send(r.to_string());
            }
            break;
        }
        if msg["method"] == "initialize" {
            let name = client_label(msg["params"]["clientInfo"]["name"].as_str().unwrap_or(""));
            *client.lock().unwrap() = name.clone();
            mcp.clients.lock().unwrap().insert(conn, name);
            let _ = app.emit("claude-changed", ());
        }
        if msg.get("id").is_none() {
            continue; // a notification
        }
        let (app, tx, client) = (app.clone(), tx.clone(), client.lock().unwrap().clone());
        tokio::spawn(async move {
            let response = handle(&app, conn, &client, &msg).await;
            let _ = tx.send(response.to_string());
        });
    }
    drop(tx);
    let _ = writer.await;
    let mcp = &app.state::<AppState>().mcp;
    mcp.clients.lock().unwrap().remove(&conn);
    mcp.allowed.lock().unwrap().retain(|k| !k.starts_with(&format!("{conn}|")));
    let _ = app.emit("claude-changed", ());
}

fn client_label(name: &str) -> String {
    let n = name.to_lowercase();
    if n.contains("claude-code") || n == "claude code" {
        "Claude Code".into()
    } else if n.contains("claude") {
        "Claude".into()
    } else if name.is_empty() {
        "Claude".into()
    } else {
        name.to_string()
    }
}

async fn handle(app: &tauri::AppHandle, conn: u64, client: &str, msg: &Value) -> Value {
    let id = &msg["id"];
    match msg["method"].as_str().unwrap_or("") {
        "initialize" => reply(id, initialize_result(msg["params"]["protocolVersion"].as_str())),
        "ping" => reply(id, json!({})),
        "tools/list" => reply(id, json!({ "tools": tool_defs() })),
        "tools/call" => {
            let name = msg["params"]["name"].as_str().unwrap_or("").to_string();
            let args = msg["params"]["arguments"].clone();
            let ctx = Ctx { app: app.clone(), conn, client: client.to_string(), act: 0, stop: watch::channel(false).1 };
            let (text, is_error) = match call(&ctx, &name, &args).await {
                Ok(t) => (t, false),
                Err(e) => (e, true),
            };
            reply(id, text_result(cap(text), is_error))
        }
        _ => rpc_error(id, -32601, "Method not found"),
    }
}

fn cap(mut s: String) -> String {
    if s.len() > MAX_OUTPUT {
        let mut end = MAX_OUTPUT;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        s.truncate(end);
        s.push_str("\n… (output cut short)");
    }
    s
}

// ---- tools ----

fn tool(name: &str, description: &str, props: Value, required: &[&str], read_only: bool) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": { "type": "object", "properties": props, "required": required },
        "annotations": { "readOnlyHint": read_only, "destructiveHint": !read_only, "openWorldHint": true },
    })
}

fn tool_defs() -> Vec<Value> {
    let conn = json!({ "type": "string", "description": "Database connection name (from list_connections)" });
    let database = json!({ "type": "string", "description": "Database to use instead of the connection's default" });
    let host = json!({ "type": "string", "description": "SSH server name (from list_connections)" });
    let target = json!({ "type": "string", "description": "SSH server or FTP site name (from list_connections)" });
    vec![
        tool(
            "list_connections",
            "Lists the databases, SSH servers, FTP sites and saved commands the user lets Claude use, with what each allows (read, or read and write).",
            json!({}),
            &[],
            true,
        ),
        tool(
            "db_tables",
            "Lists schemas, tables and views of a PostgreSQL database with estimated row counts and sizes.",
            json!({ "connection": conn, "database": database, "schema": { "type": "string", "description": "Only this schema" } }),
            &["connection"],
            true,
        ),
        tool(
            "db_describe",
            "Columns, indexes, constraints and foreign keys of one table or view.",
            json!({ "connection": conn, "database": database, "table": { "type": "string", "description": "Table name, optionally schema.table" } }),
            &["connection", "table"],
            true,
        ),
        tool(
            "db_query",
            "Runs one SQL statement in a READ ONLY transaction that is always rolled back, so nothing changes. Use for SELECT, EXPLAIN, SHOW and the like.",
            json!({ "connection": conn, "database": database, "sql": { "type": "string" }, "max_rows": { "type": "integer", "description": "Rows to return (default 200, at most 2000)" } }),
            &["connection", "sql"],
            true,
        ),
        tool(
            "db_execute",
            "Runs one SQL statement that changes data or schema (INSERT, UPDATE, DELETE, CREATE…) and commits it. Needs write access; the user is usually asked first.",
            json!({ "connection": conn, "database": database, "sql": { "type": "string" } }),
            &["connection", "sql"],
            false,
        ),
        tool(
            "db_activity",
            "Current sessions of a PostgreSQL server: who is connected, running queries and for how long, and which sessions block others.",
            json!({ "connection": conn }),
            &["connection"],
            true,
        ),
        tool(
            "server_status",
            "Health of an SSH server: OS, uptime and load, memory, disks, failed systemd services, PM2 apps and Docker containers.",
            json!({ "host": host }),
            &["host"],
            true,
        ),
        tool(
            "server_logs",
            "Recent log lines from a server: a systemd service's journal, a PM2 app, a Docker container or a log file.",
            json!({
                "host": host,
                "source": { "type": "string", "enum": ["journal", "pm2", "docker", "file"] },
                "name": { "type": "string", "description": "Service, PM2 app, container name, or the file's path" },
                "lines": { "type": "integer", "description": "How many lines (default 200, at most 2000)" },
            }),
            &["host", "source", "name"],
            true,
        ),
        tool(
            "server_run",
            "Runs a shell command on an SSH server and returns its output and exit status. Needs write access; the user is usually asked first.",
            json!({ "host": host, "command": { "type": "string" }, "timeout_secs": { "type": "integer", "description": "Default 60, at most 600" } }),
            &["host", "command"],
            false,
        ),
        tool(
            "files_list",
            "Lists a folder on an SSH server (SFTP) or FTP site. An empty path is the start folder.",
            json!({ "target": target, "path": { "type": "string" } }),
            &["target"],
            true,
        ),
        tool(
            "files_read",
            "Reads a text file from an SSH server (SFTP) or FTP site.",
            json!({ "target": target, "path": { "type": "string" } }),
            &["target", "path"],
            true,
        ),
        tool(
            "files_write",
            "Writes (creates or replaces) a text file on an SSH server or FTP site. Needs write access; the user is usually asked first.",
            json!({ "target": target, "path": { "type": "string" }, "content": { "type": "string" } }),
            &["target", "path", "content"],
            false,
        ),
        tool(
            "run_saved_command",
            "Runs one of the user's saved commands (deploys, restarts…) on its servers and returns each server's output. Needs write access to all of them; the user is usually asked first.",
            json!({ "name": { "type": "string", "description": "Saved command name (from list_connections)" } }),
            &["name"],
            false,
        ),
    ]
}

#[derive(Clone)]
struct Ctx {
    app: tauri::AppHandle,
    conn: u64,
    client: String,
    /// The activity entry of the tool call being run (0 when none).
    act: u64,
    /// Turns true when the user stops this call in Tusk.
    stop: watch::Receiver<bool>,
}

impl Ctx {
    fn stopped(&self) -> bool {
        *self.stop.borrow()
    }
}

/// Resolves once the user stops the call (never, if it can't be stopped any more).
async fn stop_signal(mut rx: watch::Receiver<bool>) {
    if rx.wait_for(|s| *s).await.is_err() {
        std::future::pending::<()>().await;
    }
}

const STOPPED: &str = "The user stopped this in Tusk. Don't run it again unless they ask.";

impl Ctx {
    fn state(&self) -> tauri::State<'_, AppState> {
        self.app.state::<AppState>()
    }
}

/// Something Claude may use.
#[derive(Clone)]
struct Target {
    /// database | server | ftp
    kind: &'static str,
    id: String,
    name: String,
    access: ClaudeAccess,
    detail: String,
}

fn targets(state: &AppState) -> Vec<Target> {
    let store = state.store.lock().unwrap();
    let mut out = Vec::new();
    for c in store.list() {
        let access = store.claude_access(&c.id, c.folder_id.as_deref());
        let detail = format!("PostgreSQL {}@{}:{}/{}{}", c.user, c.host, c.port, c.database, if c.ssh_host_id.is_some() { " (through SSH)" } else { "" });
        out.push(Target { kind: "database", id: c.id, name: c.name, access, detail });
    }
    for h in store.list_ssh() {
        let access = store.claude_access(&h.id, h.folder_id.as_deref());
        out.push(Target { kind: "server", detail: format!("{}@{}:{}", h.user, h.host, h.port), id: h.id, name: h.name, access });
    }
    for f in store.list_ftp() {
        let access = store.claude_access(&f.id, f.folder_id.as_deref());
        out.push(Target { kind: "ftp", detail: format!("{}://{}@{}:{}", f.protocol, f.user, f.host, f.port), id: f.id, name: f.name, access });
    }
    out.retain(|t| t.access.level != "off");
    out
}

fn find(state: &AppState, kinds: &[&str], name: &str) -> Result<Target, String> {
    let all: Vec<Target> = targets(state).into_iter().filter(|t| kinds.contains(&t.kind)).collect();
    let n = name.trim();
    let hits: Vec<&Target> = all.iter().filter(|t| t.id == n || t.name.eq_ignore_ascii_case(n)).collect();
    match hits.as_slice() {
        [t] => Ok((*t).clone()),
        [] => Err(format!(
            "There's no {} named \"{n}\" that Claude may use. Call list_connections to see them; the user can allow more in Tusk → Claude.",
            kinds.join(" or ").replace("server", "SSH server").replace("ftp", "FTP site")
        )),
        _ => Err(format!("Several are named \"{n}\"; use one of these ids: {}", hits.iter().map(|t| t.id.as_str()).collect::<Vec<_>>().join(", "))),
    }
}

fn need_write(t: &Target) -> Result<(), String> {
    if t.access.level == "write" {
        Ok(())
    } else {
        Err(format!("Claude may only read {}. The user can allow changes in Tusk → Claude.", t.name))
    }
}

fn arg<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args[key].as_str().filter(|s| !s.trim().is_empty()).ok_or_else(|| format!("Missing \"{key}\""))
}

fn opt<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args[key].as_str().filter(|s| !s.trim().is_empty())
}

fn short(s: &str, n: usize) -> String {
    let one: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() > n {
        format!("{}…", one.chars().take(n).collect::<String>())
    } else {
        one
    }
}

/// Runs a tool and records it in the activity list as it happens.
async fn call(ctx: &Ctx, name: &str, args: &Value) -> Result<String, String> {
    let named = ["connection", "host", "target"].iter().find_map(|k| opt(args, k)).unwrap_or("");
    let found = if named.is_empty() { None } else { resolve(&ctx.state(), named) };
    let target = found.as_ref().map(|t| t.name.clone()).unwrap_or_else(|| opt(args, "name").unwrap_or(named).to_string());
    let detail = ["sql", "command", "path", "table", "source"].iter().find_map(|k| opt(args, k)).map(|s| short(s, 300)).unwrap_or_default();
    let input = match name {
        "files_write" => format!("{}\n\n{}", opt(args, "path").unwrap_or(""), args["content"].as_str().unwrap_or("")),
        "server_logs" => [opt(args, "source"), opt(args, "name")].into_iter().flatten().collect::<Vec<_>>().join(" "),
        _ => ["sql", "command", "path", "table", "name"].iter().find_map(|k| opt(args, k)).unwrap_or("").to_string(),
    };
    let mcp = &ctx.state().mcp;
    let act = mcp.begin(
        &ctx.app,
        Activity {
            id: 0,
            at: 0,
            client: ctx.client.clone(),
            tool: name.into(),
            target,
            target_kind: found.as_ref().map(|t| t.kind.to_string()).unwrap_or_default(),
            target_id: found.map(|t| t.id).unwrap_or_default(),
            database: opt(args, "database").unwrap_or("").to_string(),
            detail,
            outcome: "running".into(),
            summary: String::new(),
            input: clip(input, MAX_SHOWN),
            result: String::new(),
            output: String::new(),
            ms: 0,
        },
    );
    let (stop_tx, stop_rx) = watch::channel(false);
    mcp.stops.lock().unwrap().insert(act, stop_tx);
    let ctx = Ctx { act, stop: stop_rx.clone(), ..ctx.clone() };
    let started = std::time::Instant::now();
    let result = tokio::select! {
        r = run_tool(&ctx, name, args) => r,
        // Commands and queries end themselves when stopped; anything else gets a moment, then is dropped.
        _ = async {
            stop_signal(stop_rx).await;
            tokio::time::sleep(Duration::from_secs(3)).await;
        } => Err(STOPPED.into()),
    };
    let mcp = &ctx.state().mcp;
    mcp.stops.lock().unwrap().remove(&act);
    let result = if ctx.stopped() && result.is_err() { Err(STOPPED.to_string()) } else { result };
    let (outcome, summary) = match &result {
        Err(e) if e == STOPPED => ("stopped", "Stopped in Tusk".to_string()),
        Ok(text) => ("ok", short(text.lines().last().unwrap_or(""), 160)),
        Err(e) if e.starts_with(DECLINED) => ("denied", "Declined in Tusk".to_string()),
        Err(e) => ("error", short(e, 200)),
    };
    let shown = clip(match &result {
        Ok(t) | Err(t) => t.clone(),
    }, MAX_SHOWN);
    ctx.state().mcp.update(&ctx.app, act, |e| {
        e.outcome = outcome.into();
        e.summary = summary;
        e.result = shown;
        e.output.clear();
        e.ms = started.elapsed().as_millis() as u64;
    });
    result
}

/// The item Claude named, if exactly one matches.
fn resolve(state: &AppState, name: &str) -> Option<Target> {
    let n = name.trim();
    let mut hits = targets(state).into_iter().filter(|t| t.id == n || t.name.eq_ignore_ascii_case(n));
    let first = hits.next()?;
    hits.next().is_none().then_some(first)
}

fn clip(mut s: String, max: usize) -> String {
    if s.len() > max {
        let mut end = max;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        s.truncate(end);
        s.push_str("\n… (cut short here; Claude saw more)");
    }
    s
}

const DECLINED: &str = "The user declined this in Tusk.";

/// Asks the user in Tusk unless they said this target needn't ask.
async fn approve(ctx: &Ctx, t: &Target, tool: &str, title: String, detail: String) -> Result<(), String> {
    if !t.access.ask {
        return Ok(());
    }
    let key = format!("{}|{tool}|{}", ctx.conn, t.id);
    let mcp = &ctx.state().mcp;
    if mcp.allowed.lock().unwrap().contains(&key) {
        return Ok(());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let req = ApprovalRequest {
        id: id.clone(),
        client: ctx.client.clone(),
        tool: tool.into(),
        target: t.name.clone(),
        title,
        detail,
        at: crate::monitor::now(),
    };
    let (tx, rx) = oneshot::channel();
    mcp.update(&ctx.app, ctx.act, |e| e.outcome = "waiting".into());
    mcp.approvals.lock().unwrap().insert(id.clone(), (req.clone(), tx));
    let _ = ctx.app.emit("claude-approval", &req);
    let _ = ctx.app.emit("claude-changed", ());
    get_attention(&ctx.app, &req);
    let decision = tokio::select! {
        d = tokio::time::timeout(APPROVAL_WAIT, rx) => d,
        _ = stop_signal(ctx.stop.clone()) => Ok(Ok("deny".to_string())),
    };
    mcp.approvals.lock().unwrap().remove(&id);
    mcp.update(&ctx.app, ctx.act, |e| e.outcome = "running".into());
    let _ = ctx.app.emit("claude-changed", ());
    match decision {
        Ok(Ok(d)) if d == "session" => {
            mcp.allowed.lock().unwrap().insert(key);
            Ok(())
        }
        Ok(Ok(d)) if d == "allow" => Ok(()),
        Ok(_) => Err(DECLINED.into()),
        Err(_) => Err(format!("{DECLINED} (Nobody answered within 10 minutes.)")),
    }
}

/// Brings the user to Tusk when Claude is waiting for them.
fn get_attention(app: &tauri::AppHandle, req: &ApprovalRequest) {
    let Some(w) = app.get_webview_window("main") else { return };
    if w.is_focused().unwrap_or(false) {
        return;
    }
    let _ = w.request_user_attention(Some(tauri::UserAttentionType::Critical));
    use tauri_plugin_notification::NotificationExt;
    let _ = app
        .notification()
        .builder()
        .title(format!("{} is waiting for your OK", req.client))
        .body(format!("{} on {}", req.title, req.target))
        .show();
}

async fn run_tool(ctx: &Ctx, name: &str, args: &Value) -> Result<String, String> {
    match name {
        "list_connections" => Ok(list_connections(&ctx.state())),
        "db_tables" => db_tables(ctx, args).await,
        "db_describe" => db_describe(ctx, args).await,
        "db_query" => db_query(ctx, args).await,
        "db_execute" => db_execute(ctx, args).await,
        "db_activity" => db_activity(ctx, args).await,
        "server_status" => server_status(ctx, args).await,
        "server_logs" => server_logs(ctx, args).await,
        "server_run" => server_run(ctx, args).await,
        "files_list" => files_list(ctx, args).await,
        "files_read" => files_read(ctx, args).await,
        "files_write" => files_write(ctx, args).await,
        "run_saved_command" => run_saved_command(ctx, args).await,
        other => Err(format!("Unknown tool {other}")),
    }
}

fn access_text(a: &ClaudeAccess) -> &'static str {
    match (a.level.as_str(), a.ask) {
        ("write", true) => "read and write (changes need the user's OK)",
        ("write", false) => "read and write",
        _ => "read only",
    }
}

fn list_connections(state: &AppState) -> String {
    let all = targets(state);
    if all.is_empty() {
        return "The user hasn't allowed Claude to use any connections yet. They can do it in Tusk → Claude.".into();
    }
    let mut out = String::new();
    for (kind, title) in [("database", "Databases"), ("server", "SSH servers"), ("ftp", "FTP sites")] {
        let list: Vec<&Target> = all.iter().filter(|t| t.kind == kind).collect();
        if list.is_empty() {
            continue;
        }
        out.push_str(&format!("{title}:\n"));
        for t in list {
            out.push_str(&format!("- {} — {} — {}\n", t.name, t.detail, access_text(&t.access)));
        }
        out.push('\n');
    }
    let writable: HashSet<String> = all.iter().filter(|t| t.kind == "server" && t.access.level == "write").map(|t| t.id.clone()).collect();
    let commands: Vec<String> = state
        .store
        .lock()
        .unwrap()
        .list_commands()
        .into_iter()
        .filter(|c| c.host_ids.iter().all(|h| writable.contains(h)))
        .map(|c| format!("- {}", c.name))
        .collect();
    if !commands.is_empty() {
        out.push_str("Saved commands (run_saved_command):\n");
        out.push_str(&commands.join("\n"));
        out.push('\n');
    }
    out.trim_end().to_string()
}

// ---- databases ----

/// Functions that act outside the transaction, so a read-only one can't undo them.
const SIDE_EFFECTS: &[&str] = &[
    "pg_terminate_backend",
    "pg_cancel_backend",
    "pg_reload_conf",
    "pg_rotate_logfile",
    "pg_switch_wal",
    "pg_promote",
    "pg_create_restore_point",
    "pg_create_physical_replication_slot",
    "pg_create_logical_replication_slot",
    "pg_drop_replication_slot",
    "lo_import",
    "lo_export",
    "dblink",
    "pg_file_write",
    "pg_advisory_lock",
    "pg_advisory_xact_lock",
];

fn side_effect(sql: &str) -> Option<&'static str> {
    let lower = sql.to_lowercase();
    SIDE_EFFECTS.iter().copied().find(|f| lower.contains(f))
}

fn friendly(e: AppError, name: &str) -> String {
    match e.kind.as_deref() {
        Some("PASSWORD_REQUIRED") | Some("SSH_PASSWORD_REQUIRED") | Some("PASSPHRASE_REQUIRED") | Some("SSH_PASSPHRASE_REQUIRED") => {
            format!("Tusk has no saved password for {name}. Ask the user to connect to it in Tusk once and save the password.")
        }
        Some(k) if k.contains("HOSTKEY") => {
            format!("Tusk hasn't trusted {name}'s host key yet. Ask the user to connect to it in Tusk once.")
        }
        _ if e.code.as_deref() == Some("28P01") => {
            format!("The saved password for {name} was rejected. Ask the user to update it in Tusk.")
        }
        _ => {
            let mut m = e.message;
            if let Some(h) = e.hint {
                m.push_str(&format!("\nHint: {h}"));
            }
            m
        }
    }
}

async fn db_session(ctx: &Ctx, t: &Target, database: Option<&str>) -> Result<Arc<crate::db::Session>, String> {
    let state = ctx.state();
    let config = state.config(&t.id).map_err(|e| e.message)?;
    let sref = SessionRef {
        conn_id: t.id.clone(),
        database: database.map(str::to_string).unwrap_or(config.database),
        purpose: "claude".into(),
    };
    state.session(&sref).await.map_err(|e| friendly(e, &t.name))
}

fn table_text(r: &StatementResult) -> String {
    let Some(cols) = &r.columns else {
        return format!("OK{}", r.affected.map(|n| format!(", {n} rows affected")).unwrap_or_default());
    };
    let cell = |v: &Option<String>| match v {
        None => "NULL".to_string(),
        Some(s) => {
            let s = s.replace('\n', "\\n").replace('|', "\\|");
            if s.chars().count() > 300 { format!("{}…", s.chars().take(300).collect::<String>()) } else { s }
        }
    };
    let mut out = cols.iter().map(|c| c.name.as_str()).collect::<Vec<_>>().join(" | ");
    out.push('\n');
    for row in &r.rows {
        out.push_str(&row.iter().map(cell).collect::<Vec<_>>().join(" | "));
        out.push('\n');
    }
    if r.truncated {
        out.push_str(&format!("({} of {} rows shown)", r.rows.len(), r.row_count));
    } else {
        out.push_str(&format!("({} row{})", r.row_count, if r.row_count == 1 { "" } else { "s" }));
    }
    out
}

fn lit(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

async fn read_query(ctx: &Ctx, t: &Target, database: Option<&str>, sql: &str, max_rows: usize) -> Result<String, String> {
    let session = db_session(ctx, t, database).await?;
    guarded(ctx, t, &session, sql, max_rows, true, 60).await
}

/// Runs one statement, cancelling it on the server if the user stops it.
async fn guarded(
    ctx: &Ctx,
    t: &Target,
    session: &Arc<crate::db::Session>,
    sql: &str,
    max_rows: usize,
    read_only: bool,
    timeout_secs: u32,
) -> Result<String, String> {
    let forward = {
        let (stop, session) = (ctx.stop.clone(), session.clone());
        tokio::spawn(async move {
            stop_signal(stop).await;
            let _ = session.cancel().await;
        })
    };
    let r = session.run_guarded(sql, max_rows, read_only, timeout_secs).await;
    forward.abort();
    if ctx.stopped() {
        return Err(STOPPED.into());
    }
    r.map(|r| table_text(&r)).map_err(|e| friendly(e, &t.name))
}

async fn db_tables(ctx: &Ctx, args: &Value) -> Result<String, String> {
    let t = find(&ctx.state(), &["database"], arg(args, "connection")?)?;
    let filter = match opt(args, "schema") {
        Some(s) => format!("and n.nspname = {}", lit(s)),
        None => String::new(),
    };
    let sql = format!(
        "select n.nspname as schema, c.relname as name, \
         case c.relkind when 'r' then 'table' when 'p' then 'partitioned table' when 'v' then 'view' \
           when 'm' then 'materialized view' when 'f' then 'foreign table' end as kind, \
         greatest(c.reltuples, 0)::bigint as est_rows, pg_size_pretty(pg_total_relation_size(c.oid)) as size \
         from pg_class c join pg_namespace n on n.oid = c.relnamespace \
         where c.relkind in ('r','p','v','m','f') and n.nspname not in ('pg_catalog','information_schema') \
         and n.nspname not like 'pg_toast%' {filter} order by 1, 2"
    );
    read_query(ctx, &t, opt(args, "database"), &sql, 2000).await
}

async fn db_describe(ctx: &Ctx, args: &Value) -> Result<String, String> {
    let t = find(&ctx.state(), &["database"], arg(args, "connection")?)?;
    let table = lit(arg(args, "table")?);
    let db = opt(args, "database");
    let columns = format!(
        "select a.attname as column, format_type(a.atttypid, a.atttypmod) as type, \
         case when a.attnotnull then 'not null' else '' end as nullable, \
         pg_get_expr(d.adbin, d.adrelid) as default, col_description(a.attrelid, a.attnum) as comment \
         from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum \
         where a.attrelid = to_regclass({table}) and a.attnum > 0 and not a.attisdropped order by a.attnum"
    );
    let cols = read_query(ctx, &t, db, &columns, 2000).await?;
    if cols.ends_with("(0 rows)") {
        return Err(format!("No table or view named {table} (try schema.table, or db_tables)"));
    }
    let indexes = format!("select indexrelid::regclass as index, pg_get_indexdef(indexrelid) as definition from pg_index where indrelid = to_regclass({table})");
    let constraints = format!(
        "select conname as constraint, pg_get_constraintdef(oid) as definition from pg_constraint where conrelid = to_regclass({table}) order by contype, conname"
    );
    let estimate = format!("select greatest(reltuples, 0)::bigint as est_rows, pg_size_pretty(pg_total_relation_size(oid)) as size from pg_class where oid = to_regclass({table})");
    Ok(format!(
        "Columns:\n{cols}\n\nIndexes:\n{}\n\nConstraints:\n{}\n\nSize:\n{}",
        read_query(ctx, &t, db, &indexes, 500).await?,
        read_query(ctx, &t, db, &constraints, 500).await?,
        read_query(ctx, &t, db, &estimate, 1).await?
    ))
}

async fn db_query(ctx: &Ctx, args: &Value) -> Result<String, String> {
    let t = find(&ctx.state(), &["database"], arg(args, "connection")?)?;
    let sql = arg(args, "sql")?;
    if let Some(f) = side_effect(sql) {
        return Err(format!("{f}() acts outside the transaction, so it needs db_execute (write access)."));
    }
    let max = args["max_rows"].as_u64().unwrap_or(200).clamp(1, 2000) as usize;
    read_query(ctx, &t, opt(args, "database"), sql, max).await
}

async fn db_execute(ctx: &Ctx, args: &Value) -> Result<String, String> {
    let t = find(&ctx.state(), &["database"], arg(args, "connection")?)?;
    need_write(&t)?;
    let sql = arg(args, "sql")?;
    let db = opt(args, "database");
    let title = match db {
        Some(d) => format!("Change the database {d}"),
        None => "Change the database".into(),
    };
    approve(ctx, &t, "db_execute", title, sql.to_string()).await?;
    let session = db_session(ctx, &t, db).await?;
    guarded(ctx, &t, &session, sql, 200, false, 300).await
}

async fn db_activity(ctx: &Ctx, args: &Value) -> Result<String, String> {
    let t = find(&ctx.state(), &["database"], arg(args, "connection")?)?;
    let sql = "select pid, usename as user, datname as database, application_name as app, client_addr as client, state, \
               wait_event_type || coalesce(':' || wait_event, '') as waiting_on, \
               to_char(now() - coalesce(xact_start, query_start), 'HH24:MI:SS') as running_for, \
               nullif(array_to_string(pg_blocking_pids(pid), ','), '') as blocked_by, left(query, 300) as query \
               from pg_stat_activity where backend_type = 'client backend' and pid <> pg_backend_pid() \
               order by (state = 'idle'), coalesce(xact_start, query_start)";
    read_query(ctx, &t, None, sql, 500).await
}

// ---- servers ----

/// Runs a script on a server. With `live`, its output shows in Tusk as it comes.
async fn exec(ctx: &Ctx, t: &Target, script: &str, timeout: Duration, live: bool) -> Result<(String, Option<u32>), String> {
    let state = ctx.state();
    let creds = state.ssh_creds(&t.id).map_err(|e| e.message)?;
    let cancel = Arc::new(tokio::sync::Notify::new());
    let mut out = Vec::new();
    let mut pending = Vec::new();
    let cmd = crate::ssh::posix(&format!("{}\n{script}", crate::pm2::PATH_PRELUDE));
    let run = state.tunnels.exec_stream(creds, &cmd, cancel.clone(), |b| {
        out.extend_from_slice(b);
        if live && ctx.act != 0 {
            pending.extend_from_slice(b);
            // Hold back a character split across chunks.
            let cut = match std::str::from_utf8(&pending) {
                Ok(_) => pending.len(),
                Err(e) if e.error_len().is_none() => e.valid_up_to(),
                Err(_) => pending.len(),
            };
            if cut > 0 {
                let text = String::from_utf8_lossy(&pending[..cut]).replace("\r\n", "\n");
                state.mcp.output(&ctx.app, ctx.act, &text);
                pending.drain(..cut);
            }
        }
    });
    let forward = {
        let (stop, cancel) = (ctx.stop.clone(), cancel.clone());
        tokio::spawn(async move {
            stop_signal(stop).await;
            cancel.notify_one();
        })
    };
    let finished = tokio::time::timeout(timeout, run).await;
    forward.abort();
    if ctx.stopped() {
        return Err(STOPPED.into());
    }
    let status = match finished {
        Ok(r) => r.map_err(|e| friendly(e, &t.name))?,
        Err(_) => {
            cancel.notify_one();
            return Err(format!("Stopped after {} seconds without finishing", timeout.as_secs()));
        }
    };
    Ok((String::from_utf8_lossy(&out).replace("\r\n", "\n"), status))
}

async fn server_status(ctx: &Ctx, args: &Value) -> Result<String, String> {
    let t = find(&ctx.state(), &["server"], arg(args, "host")?)?;
    let script = format!(
        "echo @os; (. /etc/os-release 2>/dev/null && echo \"$PRETTY_NAME\") || uname -sr\necho @uptime; uptime\n{}",
        crate::monitor::script(false)
    );
    let (out, _) = exec(ctx, &t, &script, Duration::from_secs(60), false).await?;
    let s = crate::discover::sections(&out);
    let check = crate::monitor::parse(&out);
    let line = |k: &str| s.get(k).and_then(|l| l.first()).map(|x| x.trim().to_string()).unwrap_or_default();
    let mut text = format!("{} ({})\nOS: {}\nUptime: {}\n", t.name, t.detail, line("os"), line("uptime"));
    if let Some(m) = check.mem_percent {
        text.push_str(&format!("Memory used: {m}%\n"));
    }
    text.push_str("Disks:\n");
    for d in &check.disks {
        text.push_str(&format!("- {} {}% full\n", d.mount, d.percent));
    }
    if check.failed_units.is_empty() {
        text.push_str("Failed services: none\n");
    } else {
        text.push_str(&format!("Failed services: {}\n", check.failed_units.join(", ")));
    }
    match &check.pm2 {
        Some(apps) => {
            text.push_str("PM2 apps:\n");
            for (name, status) in apps {
                text.push_str(&format!("- {name}: {status}\n"));
            }
        }
        None => text.push_str("PM2: not running for this user\n"),
    }
    match &check.containers {
        Some(list) => {
            text.push_str("Docker containers:\n");
            for (name, state) in list {
                text.push_str(&format!("- {name}: {state}\n"));
            }
        }
        None => text.push_str("Docker: not available\n"),
    }
    Ok(text.trim_end().to_string())
}

async fn server_logs(ctx: &Ctx, args: &Value) -> Result<String, String> {
    let t = find(&ctx.state(), &["server"], arg(args, "host")?)?;
    let name = arg(args, "name")?;
    let lines = args["lines"].as_u64().unwrap_or(200).clamp(1, 2000);
    let q = crate::ssh::sh_quote(name);
    let script = match arg(args, "source")? {
        "journal" => format!("journalctl -u {q} -n {lines} --no-pager 2>&1"),
        "pm2" => format!("pm2 logs {q} --lines {lines} --nostream --raw 2>&1"),
        "docker" => format!("(docker logs --tail {lines} {q} || sudo -n docker logs --tail {lines} {q}) 2>&1"),
        "file" => format!("tail -n {lines} -- {q} 2>&1"),
        other => return Err(format!("Unknown log source {other}")),
    };
    let (out, _) = exec(ctx, &t, &script, Duration::from_secs(45), false).await?;
    Ok(if out.trim().is_empty() { "(no log lines)".into() } else { out })
}

async fn server_run(ctx: &Ctx, args: &Value) -> Result<String, String> {
    let t = find(&ctx.state(), &["server"], arg(args, "host")?)?;
    need_write(&t)?;
    let command = arg(args, "command")?;
    let secs = args["timeout_secs"].as_u64().unwrap_or(60).clamp(1, 600);
    approve(ctx, &t, "server_run", "Run a command".into(), command.to_string()).await?;
    let (out, status) = exec(ctx, &t, command, Duration::from_secs(secs), true).await?;
    Ok(format!("{}\n(exit status {})", out.trim_end(), status.map(|s| s.to_string()).unwrap_or_else(|| "unknown".into())))
}

async fn run_saved_command(ctx: &Ctx, args: &Value) -> Result<String, String> {
    let name = arg(args, "name")?;
    let cmd = ctx
        .state()
        .store
        .lock()
        .unwrap()
        .list_commands()
        .into_iter()
        .find(|c| c.name.eq_ignore_ascii_case(name.trim()))
        .ok_or_else(|| format!("No saved command named \"{name}\""))?;
    let mut hosts = Vec::new();
    for id in &cmd.host_ids {
        let t = find(&ctx.state(), &["server"], id).map_err(|_| format!("Claude can't use every server \"{}\" runs on", cmd.name))?;
        need_write(&t)?;
        hosts.push(t);
    }
    // One OK covers all its servers.
    if let Some(asking) = hosts.iter().find(|h| h.access.ask) {
        let names = hosts.iter().map(|h| h.name.as_str()).collect::<Vec<_>>().join(", ");
        let mut first = asking.clone();
        first.name = names.clone();
        approve(ctx, &first, "run_saved_command", format!("Run the saved command \"{}\"", cmd.name), cmd.script.clone()).await?;
    }
    let script = format!("{}{}", if cmd.stop_on_error { "set -e\n" } else { "" }, cmd.script);
    let runs = hosts.iter().map(|h| exec(ctx, h, &script, Duration::from_secs(600), hosts.len() == 1));
    let results = futures_util::future::join_all(runs).await;
    let mut out = String::new();
    for (h, r) in hosts.iter().zip(results) {
        match r {
            Ok((text, status)) => out.push_str(&format!(
                "== {} (exit status {})\n{}\n",
                h.name,
                status.map(|s| s.to_string()).unwrap_or_else(|| "unknown".into()),
                text.trim_end()
            )),
            Err(e) => out.push_str(&format!("== {} failed: {e}\n", h.name)),
        }
    }
    Ok(out.trim_end().to_string())
}

// ---- files ----

/// The file session Claude uses for a server or site (opened on first use).
async fn remote(ctx: &Ctx, t: &Target) -> Result<Arc<crate::files::Remote>, String> {
    let state = ctx.state();
    let sid = format!("claude:{}", t.id);
    if let Ok(r) = state.files.get(&sid).await {
        return Ok(r);
    }
    let kind = if t.kind == "ftp" { "ftp" } else { "ssh" };
    let (r, _) = state.open_remote(kind, &t.id).await.map_err(|e| friendly(e, &t.name))?;
    state.files.insert(sid.clone(), r).await;
    state.files.get(&sid).await.map_err(|e| e.message)
}

async fn files_list(ctx: &Ctx, args: &Value) -> Result<String, String> {
    let t = find(&ctx.state(), &["server", "ftp"], arg(args, "target")?)?;
    let r = remote(ctx, &t).await?;
    let l = r.list(opt(args, "path").unwrap_or("")).await.map_err(|e| e.message)?;
    let mut entries = l.entries;
    entries.sort_by(|a, b| (a.kind != "dir").cmp(&(b.kind != "dir")).then(a.name.cmp(&b.name)));
    let mut out = format!("{}:\n", l.path);
    for e in &entries {
        let size = if e.kind == "dir" { String::new() } else { format!(" {} bytes", e.size) };
        out.push_str(&format!("{}{}{}\n", e.name, if e.kind == "dir" || e.link_to_dir { "/" } else { "" }, size));
    }
    Ok(out.trim_end().to_string())
}

async fn files_read(ctx: &Ctx, args: &Value) -> Result<String, String> {
    let t = find(&ctx.state(), &["server", "ftp"], arg(args, "target")?)?;
    let r = remote(ctx, &t).await?;
    let f = r.read_text(arg(args, "path")?).await.map_err(|e| e.message)?;
    match f.content {
        Some(c) => Ok(c),
        None => Err(format!("Can't read it as text: {}", f.reason.unwrap_or_default())),
    }
}

async fn files_write(ctx: &Ctx, args: &Value) -> Result<String, String> {
    let t = find(&ctx.state(), &["server", "ftp"], arg(args, "target")?)?;
    need_write(&t)?;
    let path = arg(args, "path")?;
    let content = args["content"].as_str().ok_or("Missing \"content\"")?;
    let preview: String = content.lines().take(40).collect::<Vec<_>>().join("\n");
    approve(ctx, &t, "files_write", format!("Write {path} ({} bytes)", content.len()), preview).await?;
    let r = remote(ctx, &t).await?;
    r.write_text(path, content).await.map_err(|e| e.message)?;
    Ok(format!("Wrote {} bytes to {path}", content.len()))
}

// ---- setting up Claude ----

/// The program Claude should start.
fn exe() -> String {
    // An AppImage runs from a temporary mount; the file itself stays put.
    std::env::var("APPIMAGE")
        .ok()
        .or_else(|| std::env::current_exe().ok().map(|p| p.to_string_lossy().into_owned()))
        .unwrap_or_else(|| "tusk".into())
}

/// Claude desktop app config files: the usual one, plus the Microsoft
/// Store version's own copy when it's installed.
fn desktop_configs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    #[cfg(windows)]
    {
        if let Some(d) = dirs::config_dir() {
            out.push(d.join("Claude").join("claude_desktop_config.json"));
        }
        if let Some(local) = dirs::data_local_dir() {
            if let Ok(rd) = std::fs::read_dir(local.join("Packages")) {
                for e in rd.flatten() {
                    if e.file_name().to_string_lossy().starts_with("Claude_") {
                        let dir = e.path().join("LocalCache").join("Roaming").join("Claude");
                        if dir.exists() {
                            out.push(dir.join("claude_desktop_config.json"));
                        }
                    }
                }
            }
        }
    }
    #[cfg(not(windows))]
    {
        if let Some(d) = dirs::config_dir() {
            out.push(d.join("Claude").join("claude_desktop_config.json"));
        }
    }
    out
}

/// Adds (or updates) Tusk in a Claude desktop config, keeping everything else.
fn with_tusk(existing: &str, exe: &str) -> AppResult<String> {
    let mut v: Value = if existing.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(existing).map_err(|e| AppError::msg(format!("Claude's settings file isn't valid JSON ({e}); fix or remove it first")))?
    };
    if !v.is_object() {
        v = json!({});
    }
    if !v["mcpServers"].is_object() {
        v["mcpServers"] = json!({});
    }
    v["mcpServers"]["tusk"] = json!({ "command": exe, "args": ["--mcp"] });
    Ok(serde_json::to_string_pretty(&v)?)
}

pub fn install_desktop() -> AppResult<Vec<String>> {
    let exe = exe();
    let mut written = Vec::new();
    for (i, path) in desktop_configs().into_iter().enumerate() {
        let existing = std::fs::read_to_string(&path).unwrap_or_default();
        if i == 0 {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
        }
        std::fs::write(&path, with_tusk(&existing, &exe)?)?;
        written.push(path.to_string_lossy().into_owned());
    }
    if written.is_empty() {
        return Err(AppError::msg("Couldn't find where the Claude app keeps its settings"));
    }
    Ok(written)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Setup {
    pub desktop_installed: bool,
    pub code_command: String,
    pub exe: String,
}

pub fn setup() -> Setup {
    let exe = exe();
    let desktop_installed = desktop_configs().iter().any(|p| {
        std::fs::read_to_string(p)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .is_some_and(|v| v["mcpServers"]["tusk"]["command"] == exe.as_str())
    });
    let code_command = format!("claude mcp add --scope user tusk -- \"{exe}\" --mcp");
    Setup { desktop_installed, code_command, exe }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stub_answers_while_tusk_is_away() {
        let init = stub_reply(&json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18" } })).unwrap();
        assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(init["result"]["serverInfo"]["name"], "tusk");
        let odd = stub_reply(&json!({ "id": 2, "method": "initialize", "params": { "protocolVersion": "1999-01-01" } })).unwrap();
        assert_eq!(odd["result"]["protocolVersion"], PROTOCOL_VERSIONS[1]);
        let call = stub_reply(&json!({ "id": 3, "method": "tools/call", "params": { "name": "db_query" } })).unwrap();
        assert_eq!(call["result"]["isError"], true);
        assert!(stub_reply(&json!({ "method": "notifications/initialized" })).is_none());
        assert_eq!(stub_reply(&json!({ "id": 4, "method": "nope" })).unwrap()["error"]["code"], -32601);
    }

    #[test]
    fn tools_are_well_formed() {
        let defs = tool_defs();
        let names: HashSet<&str> = defs.iter().map(|d| d["name"].as_str().unwrap()).collect();
        assert_eq!(names.len(), defs.len());
        for d in &defs {
            assert_eq!(d["inputSchema"]["type"], "object");
            for r in d["inputSchema"]["required"].as_array().unwrap() {
                assert!(d["inputSchema"]["properties"][r.as_str().unwrap()].is_object(), "{}", d["name"]);
            }
        }
        let writes: Vec<&str> = defs.iter().filter(|d| d["annotations"]["readOnlyHint"] == false).map(|d| d["name"].as_str().unwrap()).collect();
        assert_eq!(writes, ["db_execute", "server_run", "files_write", "run_saved_command"]);
    }

    #[test]
    fn read_only_queries_refuse_side_effects() {
        assert_eq!(side_effect("select pg_terminate_backend(123)"), Some("pg_terminate_backend"));
        assert_eq!(side_effect("SELECT * FROM users"), None);
    }

    #[test]
    fn desktop_config_keeps_other_servers() {
        let before = r#"{"mcpServers":{"other":{"command":"x"}},"theme":"dark"}"#;
        let after: Value = serde_json::from_str(&with_tusk(before, "C:\\Tusk\\tusk.exe").unwrap()).unwrap();
        assert_eq!(after["mcpServers"]["other"]["command"], "x");
        assert_eq!(after["theme"], "dark");
        assert_eq!(after["mcpServers"]["tusk"]["args"][0], "--mcp");
        assert!(with_tusk("", "tusk").unwrap().contains("--mcp"));
        assert!(with_tusk("{oops", "tusk").is_err());
    }

    #[test]
    fn results_read_like_tables() {
        let r = StatementResult {
            columns: Some(vec![crate::db::ColumnInfo { name: "id".into(), type_name: None, type_oid: None }, crate::db::ColumnInfo { name: "note".into(), type_name: None, type_oid: None }]),
            rows: vec![vec![Some("1".into()), None], vec![Some("2".into()), Some("a|b\nc".into())]],
            row_count: 2,
            ..Default::default()
        };
        assert_eq!(table_text(&r), "id | note\n1 | NULL\n2 | a\\|b\\nc\n(2 rows)");
        assert_eq!(table_text(&StatementResult { affected: Some(3), ..Default::default() }), "OK, 3 rows affected");
    }

    #[test]
    fn tokens_compare_fully() {
        assert!(same("abc", "abc"));
        assert!(!same("abc", "abd"));
        assert!(!same("abc", "ab"));
    }
}
