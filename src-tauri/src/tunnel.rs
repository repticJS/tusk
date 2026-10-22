//! SSH port forwarding: local (-L), remote (-R) and dynamic SOCKS (-D)
//! tunnels, plus the private local forwards that database connections use to
//! reach a server through an SSH host.
//!
//! Tunnels through the same SSH host share one connection (a "link"). A link
//! reconnects on demand with the credentials it was opened with, and is closed
//! when the last tunnel using it stops.

use crate::error::{AppError, AppResult};
use crate::ssh::{self, Client, SshConfig};
use russh::client::{Handle, Msg};
use russh::Disconnect;
use serde::Serialize;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

/// Live counters for one tunnel.
#[derive(Default)]
pub struct Stats {
    active: AtomicU64,
    total: AtomicU64,
    /// Bytes sent through the SSH server / received from it.
    up: AtomicU64,
    down: AtomicU64,
    last_error: StdMutex<Option<String>>,
}

impl Stats {
    fn error(&self, message: impl Into<String>) {
        *self.last_error.lock().unwrap() = Some(message.into());
    }
}

/// Where a remote forward's connections go on this PC.
#[derive(Clone)]
pub struct Forward {
    pub host: String,
    pub port: u16,
    pub stats: Arc<Stats>,
}

/// Remote forwards on one SSH connection, by the port opened on the server.
pub type RemoteForwards = Arc<StdMutex<HashMap<u32, Forward>>>;

/// How long a link used only for commands stays open after the last one.
const LINGER: Duration = Duration::from_secs(60);

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// What a link needs to (re)connect.
#[derive(Clone)]
pub struct Creds {
    pub config: SshConfig,
    pub secret: Option<String>,
    pub known_hosts: PathBuf,
}

struct Link {
    creds: StdMutex<Creds>,
    conn: tokio::sync::Mutex<Option<Arc<Handle<Client>>>>,
    forwards: RemoteForwards,
    /// Commands running on the link (see `Tunnels::exec`); keeps it open.
    busy: AtomicU64,
    /// When the last command finished (ms since the epoch); the link stays
    /// up a little while after, so repeated refreshes reuse it.
    last_used: AtomicU64,
}

impl Link {
    /// The live connection, connecting (again) if needed.
    async fn handle(&self, accept: Option<String>) -> AppResult<Arc<Handle<Client>>> {
        let mut conn = self.conn.lock().await;
        if let Some(h) = conn.as_ref().filter(|h| !h.is_closed()) {
            return Ok(h.clone());
        }
        let creds = self.creds.lock().unwrap().clone();
        let (handle, _) = ssh::connect(
            &creds.config,
            creds.secret.as_deref(),
            accept,
            &creds.known_hosts,
            self.forwards.clone(),
        )
        .await
        .map_err(|e| ssh_error(e, &creds.config))?;
        let handle = Arc::new(handle);
        *conn = Some(handle.clone());
        Ok(handle)
    }

    async fn close(&self) {
        if let Some(h) = self.conn.lock().await.take() {
            let _ = h.disconnect(Disconnect::ByApplication, "", "en").await;
        }
    }
}

/// Marks an SSH error so the UI can tell it apart from a database error and
/// knows which host to ask about.
fn ssh_error(mut e: AppError, host: &SshConfig) -> AppError {
    if let Some(kind) = e.kind.take() {
        e.kind = Some(format!("SSH_{kind}"));
    }
    e.message = format!("SSH {}: {}", host.name, e.message);
    e.ssh_host = Some(host.id.clone());
    e
}

pub struct StartRequest {
    pub id: String,
    pub kind: String,
    pub bind_host: String,
    pub bind_port: u16,
    pub target_host: String,
    pub target_port: u16,
    pub creds: Creds,
}

struct Running {
    host_id: String,
    kind: String,
    port: u16,
    stats: Arc<Stats>,
    task: JoinHandle<()>,
    bind_host: String,
    target: (String, u16),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatus {
    pub id: String,
    /// The port actually listened on (useful when 0 was asked for).
    pub port: u16,
    pub active: u64,
    pub total: u64,
    pub bytes_up: u64,
    pub bytes_down: u64,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct Tunnels {
    links: tokio::sync::Mutex<HashMap<String, Arc<Link>>>,
    running: tokio::sync::Mutex<HashMap<String, Running>>,
    /// Host keys the user approved at a prompt, used by the next connect.
    accepted: StdMutex<HashMap<String, String>>,
}

impl Tunnels {
    pub fn accept_host_key(&self, host_id: &str, fingerprint: String) {
        self.accepted.lock().unwrap().insert(host_id.to_string(), fingerprint);
    }

    /// Updates the credentials a link reconnects with (after the host is edited
    /// or a password is typed).
    pub async fn update_creds(&self, creds: Creds) {
        if let Some(link) = self.links.lock().await.get(&creds.config.id) {
            *link.creds.lock().unwrap() = creds;
        }
    }

    async fn link(&self, creds: Creds) -> Arc<Link> {
        self.link_marked(creds, false).await
    }

    /// The host's link; `busy` marks it in use before the map lock is
    /// released, so `release_link` can't close it in between.
    async fn link_marked(&self, creds: Creds, busy: bool) -> Arc<Link> {
        let mut links = self.links.lock().await;
        let link = links.entry(creds.config.id.clone()).or_insert_with(|| {
            Arc::new(Link {
                creds: StdMutex::new(creds.clone()),
                conn: Default::default(),
                forwards: Default::default(),
                busy: AtomicU64::new(0),
                last_used: AtomicU64::new(0),
            })
        });
        *link.creds.lock().unwrap() = creds;
        if busy {
            link.busy.fetch_add(1, Ordering::SeqCst);
        }
        link.clone()
    }

    /// Starts a tunnel and returns the port it listens on. Starting a tunnel
    /// that is already running just returns its port.
    pub async fn start(&self, req: StartRequest) -> AppResult<u16> {
        if let Some(r) = self.running.lock().await.get(&req.id) {
            return Ok(r.port);
        }
        let host_id = req.creds.config.id.clone();
        let req = StartRequest { bind_host: default_bind(&req.bind_host, &req.kind), ..req };
        let link = self.link(req.creds.clone()).await;
        let accept = self.accepted.lock().unwrap().remove(&host_id);
        let started = self.start_on(&link, &req.id, &req.kind, &req.bind_host, req.bind_port, &req.target_host, req.target_port, accept).await;
        let (port, stats, task) = match started {
            Ok(r) => r,
            Err(e) => {
                self.release_link(&host_id).await;
                return Err(e);
            }
        };
        let mut running = self.running.lock().await;
        // Lost a race with a concurrent start of the same tunnel: keep theirs.
        if let Some(r) = running.get(&req.id) {
            task.abort();
            return Ok(r.port);
        }
        let target = (req.target_host, req.target_port);
        let bind_host = req.bind_host;
        running.insert(req.id, Running { host_id, kind: req.kind, port, stats, task, bind_host, target });
        Ok(port)
    }

    #[allow(clippy::too_many_arguments)]
    async fn start_on(
        &self,
        link: &Arc<Link>,
        id: &str,
        kind: &str,
        bind_host: &str,
        bind_port: u16,
        target_host: &str,
        target_port: u16,
        accept: Option<String>,
    ) -> AppResult<(u16, Arc<Stats>, JoinHandle<()>)> {
        // Connect first so login problems surface before anything listens.
        let handle = link.handle(accept).await?;
        let stats = Arc::new(Stats::default());
        match kind {
            "local" | "dynamic" => {
                let listener = TcpListener::bind((bind_host, bind_port)).await.map_err(|e| {
                    if e.kind() == std::io::ErrorKind::AddrInUse {
                        AppError::msg(format!("Port {bind_port} on this PC is already in use"))
                    } else {
                        AppError::msg(format!("Could not listen on {bind_host}:{bind_port}: {e}"))
                    }
                })?;
                let port = listener.local_addr()?.port();
                let task = tokio::spawn(accept_loop(
                    listener,
                    link.clone(),
                    stats.clone(),
                    (kind == "local").then(|| (target_host.to_string(), target_port)),
                ));
                Ok((port, stats, task))
            }
            "remote" => {
                let forward = Forward { host: target_host.to_string(), port: target_port, stats: stats.clone() };
                let port = request_remote(&handle, link, bind_host, bind_port, forward.clone()).await?;
                let task = tokio::spawn(keep_remote(link.clone(), bind_host.to_string(), port, forward));
                Ok((port, stats, task))
            }
            other => Err(AppError::msg(format!("Unknown tunnel type {other} ({id})"))),
        }
    }

    pub async fn stop(&self, id: &str) {
        let Some(r) = self.running.lock().await.remove(id) else { return };
        r.task.abort();
        if r.kind == "remote" {
            if let Some(link) = self.links.lock().await.get(&r.host_id).cloned() {
                link.forwards.lock().unwrap().remove(&(r.port as u32));
                if let Some(h) = link.conn.lock().await.clone() {
                    let _ = h.cancel_tcpip_forward(r.bind_host.as_str(), r.port as u32).await;
                }
            }
        }
        self.release_link(&r.host_id).await;
    }

    /// Closes a host's link once no tunnel or command uses it.
    async fn release_link(&self, host_id: &str) {
        if self.running.lock().await.values().any(|r| r.host_id == host_id) {
            return;
        }
        let link = {
            let mut links = self.links.lock().await;
            match links.get(host_id) {
                Some(l) if l.busy.load(Ordering::SeqCst) == 0 && now_ms().saturating_sub(l.last_used.load(Ordering::SeqCst)) >= LINGER.as_millis() as u64 => {
                    links.remove(host_id)
                }
                _ => None,
            }
        };
        if let Some(link) = link {
            link.close().await;
        }
    }

    /// Runs a long command on a host, passing output to `on_output` as it
    /// arrives, until it ends or `cancel` fires. Returns the exit status.
    pub async fn exec_stream(
        self: &Arc<Self>,
        creds: Creds,
        cmd: &str,
        cancel: Arc<tokio::sync::Notify>,
        mut on_output: impl FnMut(&[u8]) + Send,
    ) -> AppResult<Option<u32>> {
        let host_id = creds.config.id.clone();
        let link = self.link_marked(creds, true).await;
        let accept = self.accepted.lock().unwrap().remove(&host_id);
        let result = async {
            let handle = link.handle(accept).await?;
            let mut ch = handle.channel_open_session().await.map_err(|e| AppError::msg(e.to_string()))?;
            // A terminal makes closing the channel hang up the command (and
            // stops tools from buffering); "dumb" keeps colours and progress
            // bars out of the output.
            ch.request_pty(false, "dumb", 160, 50, 0, 0, &[]).await.map_err(|e| AppError::msg(e.to_string()))?;
            ch.exec(true, cmd).await.map_err(|e| AppError::msg(e.to_string()))?;
            let mut status = None;
            loop {
                tokio::select! {
                    msg = ch.wait() => match msg {
                        Some(russh::ChannelMsg::Data { data }) => on_output(&data),
                        Some(russh::ChannelMsg::ExtendedData { data, .. }) => on_output(&data),
                        Some(russh::ChannelMsg::ExitStatus { exit_status }) => status = Some(exit_status),
                        Some(russh::ChannelMsg::Close) | None => break,
                        Some(_) => {}
                    },
                    _ = cancel.notified() => {
                        // Closing the channel hangs up the command on the server.
                        let _ = ch.close().await;
                        return Err(AppError::kind("CANCELLED", "Cancelled"));
                    }
                }
            }
            Ok(status)
        }
        .await;
        link.last_used.store(now_ms(), Ordering::SeqCst);
        link.busy.fetch_sub(1, Ordering::SeqCst);
        let this = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(LINGER).await;
            this.release_link(&host_id).await;
        });
        result
    }

    /// Runs a command on a host over its shared link (connecting if needed),
    /// for scans and quick actions that don't belong to a terminal.
    pub async fn exec(self: &Arc<Self>, creds: Creds, cmd: &str, timeout: Duration) -> AppResult<(String, Option<u32>)> {
        let host_id = creds.config.id.clone();
        let link = self.link_marked(creds, true).await;
        let accept = self.accepted.lock().unwrap().remove(&host_id);
        let result = async {
            let handle = link.handle(accept).await?;
            crate::sftp::exec_on(&handle, cmd, timeout).await
        }
        .await;
        link.last_used.store(now_ms(), Ordering::SeqCst);
        link.busy.fetch_sub(1, Ordering::SeqCst);
        // Close it later if nothing else comes along.
        let this = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(LINGER).await;
            this.release_link(&host_id).await;
        });
        result
    }

    /// The local port of a database connection's private tunnel, starting it
    /// if needed. A running tunnel to a different destination is replaced.
    pub async fn db_port(&self, id: &str, target_host: &str, target_port: u16, creds: Creds) -> AppResult<u16> {
        let stale = match self.running.lock().await.get(id) {
            Some(r) if r.host_id == creds.config.id && r.target == (target_host.to_string(), target_port) => {
                return Ok(r.port)
            }
            Some(_) => true,
            None => false,
        };
        if stale {
            self.stop(id).await;
        }
        self.start(StartRequest {
            id: id.to_string(),
            kind: "local".into(),
            bind_host: "127.0.0.1".into(),
            bind_port: 0,
            target_host: target_host.to_string(),
            target_port,
            creds,
        })
        .await
    }

    pub async fn status(&self) -> Vec<TunnelStatus> {
        self.running
            .lock()
            .await
            .iter()
            .map(|(id, r)| TunnelStatus {
                id: id.clone(),
                port: r.port,
                active: r.stats.active.load(Ordering::Relaxed),
                total: r.stats.total.load(Ordering::Relaxed),
                bytes_up: r.stats.up.load(Ordering::Relaxed),
                bytes_down: r.stats.down.load(Ordering::Relaxed),
                error: r.stats.last_error.lock().unwrap().clone(),
            })
            .collect()
    }
}

/// Tunnels listen on loopback only unless told otherwise. For remote
/// forwards that's "localhost": an empty address asks the server for all of
/// its addresses (when its GatewayPorts setting allows it).
fn default_bind(bind_host: &str, kind: &str) -> String {
    match bind_host.trim() {
        "" if kind == "remote" => "localhost".into(),
        "" => "127.0.0.1".into(),
        h => h.to_string(),
    }
}

// ---- local and dynamic forwards ----

/// Accepts connections on this PC. `target` is the fixed destination of a
/// local forward; None means each client names it over SOCKS.
async fn accept_loop(listener: TcpListener, link: Arc<Link>, stats: Arc<Stats>, target: Option<(String, u16)>) {
    loop {
        let Ok((socket, peer)) = listener.accept().await else {
            tokio::time::sleep(Duration::from_millis(200)).await;
            continue;
        };
        let _ = socket.set_nodelay(true);
        let (link, stats, target) = (link.clone(), stats.clone(), target.clone());
        tokio::spawn(async move {
            match target {
                Some((host, port)) => {
                    if let Some(ch) = open_direct(&link, &stats, &host, port, peer).await {
                        pipe(socket, ch.into_stream(), &stats).await;
                    }
                }
                None => socks(socket, peer, &link, &stats).await,
            }
        });
    }
}

async fn open_direct(
    link: &Link,
    stats: &Stats,
    host: &str,
    port: u16,
    peer: SocketAddr,
) -> Option<russh::Channel<Msg>> {
    let handle = match link.handle(None).await {
        Ok(h) => h,
        Err(e) => {
            stats.error(e.message);
            return None;
        }
    };
    match handle.channel_open_direct_tcpip(host, port as u32, peer.ip().to_string(), peer.port() as u32).await {
        Ok(ch) => Some(ch),
        Err(e) => {
            stats.error(format!("The server could not reach {host}:{port} ({e})"));
            None
        }
    }
}

/// Serves one SOCKS4/4a/5 client (CONNECT only, no authentication).
async fn socks(mut socket: TcpStream, peer: SocketAddr, link: &Link, stats: &Stats) {
    let Ok(Some((host, port, version))) = socks_request(&mut socket).await else { return };
    match open_direct(link, stats, &host, port, peer).await {
        Some(ch) => {
            let ok: &[u8] = if version == 5 { &[5, 0, 0, 1, 0, 0, 0, 0, 0, 0] } else { &[0, 0x5a, 0, 0, 0, 0, 0, 0] };
            if socket.write_all(ok).await.is_ok() {
                pipe(socket, ch.into_stream(), stats).await;
            }
        }
        None => {
            let failed: &[u8] = if version == 5 { &[5, 5, 0, 1, 0, 0, 0, 0, 0, 0] } else { &[0, 0x5b, 0, 0, 0, 0, 0, 0] };
            let _ = socket.write_all(failed).await;
        }
    }
}

/// Reads a SOCKS handshake up to the CONNECT request and returns the
/// destination and protocol version. Unsupported requests get an error reply
/// and Ok(None).
async fn socks_request<S: AsyncRead + AsyncWrite + Unpin>(s: &mut S) -> std::io::Result<Option<(String, u16, u8)>> {
    match s.read_u8().await? {
        5 => {
            let n = s.read_u8().await? as usize;
            let mut methods = vec![0u8; n];
            s.read_exact(&mut methods).await?;
            if !methods.contains(&0) {
                s.write_all(&[5, 0xff]).await?;
                return Ok(None);
            }
            s.write_all(&[5, 0]).await?;
            let mut head = [0u8; 4];
            s.read_exact(&mut head).await?;
            let host = match head[3] {
                1 => {
                    let mut a = [0u8; 4];
                    s.read_exact(&mut a).await?;
                    std::net::Ipv4Addr::from(a).to_string()
                }
                3 => {
                    let len = s.read_u8().await? as usize;
                    let mut name = vec![0u8; len];
                    s.read_exact(&mut name).await?;
                    String::from_utf8_lossy(&name).into_owned()
                }
                4 => {
                    let mut a = [0u8; 16];
                    s.read_exact(&mut a).await?;
                    std::net::Ipv6Addr::from(a).to_string()
                }
                _ => {
                    s.write_all(&[5, 8, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
                    return Ok(None);
                }
            };
            let port = s.read_u16().await?;
            if head[1] != 1 {
                // Only CONNECT; BIND and UDP ASSOCIATE aren't supported.
                s.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
                return Ok(None);
            }
            Ok(Some((host, port, 5)))
        }
        4 => {
            let cmd = s.read_u8().await?;
            let port = s.read_u16().await?;
            let mut ip = [0u8; 4];
            s.read_exact(&mut ip).await?;
            read_cstr(s).await?; // user id
            // SOCKS4a: 0.0.0.x (x != 0) means a host name follows.
            let host = if ip[..3] == [0, 0, 0] && ip[3] != 0 {
                read_cstr(s).await?
            } else {
                std::net::Ipv4Addr::from(ip).to_string()
            };
            if cmd != 1 {
                s.write_all(&[0, 0x5b, 0, 0, 0, 0, 0, 0]).await?;
                return Ok(None);
            }
            Ok(Some((host, port, 4)))
        }
        _ => Ok(None),
    }
}

async fn read_cstr<S: AsyncRead + Unpin>(s: &mut S) -> std::io::Result<String> {
    let mut out = Vec::new();
    loop {
        match s.read_u8().await? {
            0 => return Ok(String::from_utf8_lossy(&out).into_owned()),
            b if out.len() < 255 => out.push(b),
            _ => return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "SOCKS field too long")),
        }
    }
}

// ---- remote forwards ----

/// Asks the server to listen on `bind_host:bind_port` and returns the port it
/// opened (the server picks one when 0 is asked for).
async fn request_remote(
    handle: &Handle<Client>,
    link: &Link,
    bind_host: &str,
    bind_port: u16,
    forward: Forward,
) -> AppResult<u16> {
    // Register first so a connection arriving right away has somewhere to go.
    if bind_port != 0 {
        link.forwards.lock().unwrap().insert(bind_port as u32, forward.clone());
    }
    match handle.tcpip_forward(bind_host, bind_port as u32).await {
        Ok(given) => {
            let port = if bind_port == 0 { given as u16 } else { bind_port };
            link.forwards.lock().unwrap().insert(port as u32, forward);
            Ok(port)
        }
        Err(e) => {
            link.forwards.lock().unwrap().remove(&(bind_port as u32));
            Err(AppError::msg(format!(
                "The server refused to open port {bind_port}. It may already be in use, or the server doesn't allow port forwarding ({e})."
            )))
        }
    }
}

/// Watches a remote forward's connection and sets the forward up again after
/// the connection drops.
async fn keep_remote(link: Arc<Link>, bind_host: String, port: u16, forward: Forward) {
    let mut handle = link.conn.lock().await.clone();
    let mut wait = Duration::from_secs(2);
    loop {
        tokio::time::sleep(wait).await;
        if handle.as_ref().is_some_and(|h| !h.is_closed()) {
            continue;
        }
        let result = match link.handle(None).await {
            Ok(h) => {
                let r = request_remote(&h, &link, &bind_host, port, forward.clone()).await;
                handle = Some(h);
                r
            }
            Err(e) => Err(e),
        };
        match result {
            Ok(_) => {
                *forward.stats.last_error.lock().unwrap() = None;
                wait = Duration::from_secs(2);
            }
            Err(e) => {
                forward.stats.error(format!("Reconnecting: {}", e.message));
                handle = None;
                wait = (wait * 2).min(Duration::from_secs(60));
            }
        }
    }
}

/// Connects a channel the server opened for a remote forward to its
/// destination on this PC.
pub async fn serve_remote(channel: russh::Channel<Msg>, forward: Forward) {
    match TcpStream::connect((forward.host.as_str(), forward.port)).await {
        Ok(socket) => {
            let _ = socket.set_nodelay(true);
            pipe(socket, channel.into_stream(), &forward.stats).await;
        }
        Err(e) => {
            forward.stats.error(format!("Could not connect to {}:{} on this PC ({e})", forward.host, forward.port));
            let _ = channel.close().await;
        }
    }
}

// ---- copying ----

/// Copies both ways until both sides finish, or either fails. `local` is the
/// socket on this PC, `remote` the SSH channel.
async fn pipe<A, B>(local: A, remote: B, stats: &Stats)
where
    A: AsyncRead + AsyncWrite + Unpin,
    B: AsyncRead + AsyncWrite + Unpin,
{
    stats.active.fetch_add(1, Ordering::Relaxed);
    stats.total.fetch_add(1, Ordering::Relaxed);
    let (lr, lw) = tokio::io::split(local);
    let (rr, rw) = tokio::io::split(remote);
    let _ = tokio::try_join!(copy_counted(lr, rw, &stats.up), copy_counted(rr, lw, &stats.down));
    stats.active.fetch_sub(1, Ordering::Relaxed);
}

async fn copy_counted<R, W>(mut from: R, mut to: W, counter: &AtomicU64) -> std::io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut buf = vec![0u8; 32 * 1024];
    loop {
        let n = from.read(&mut buf).await?;
        if n == 0 {
            let _ = to.shutdown().await;
            return Ok(());
        }
        to.write_all(&buf[..n]).await?;
        counter.fetch_add(n as u64, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tunnels_listen_on_loopback_by_default() {
        assert_eq!(default_bind("", "local"), "127.0.0.1");
        assert_eq!(default_bind(" ", "dynamic"), "127.0.0.1");
        assert_eq!(default_bind("", "remote"), "localhost");
        assert_eq!(default_bind("0.0.0.0", "remote"), "0.0.0.0");
    }

    async fn run(input: &[u8]) -> (Option<(String, u16, u8)>, Vec<u8>) {
        let (mut client, mut server) = tokio::io::duplex(1024);
        client.write_all(input).await.unwrap();
        let req = socks_request(&mut server).await.unwrap();
        drop(server);
        let mut reply = Vec::new();
        client.read_to_end(&mut reply).await.unwrap();
        (req, reply)
    }

    #[tokio::test]
    async fn parses_socks_requests() {
        // SOCKS5, no auth, CONNECT example.com:443
        let mut v5 = vec![5, 1, 0, 5, 1, 0, 3, 11];
        v5.extend_from_slice(b"example.com");
        v5.extend_from_slice(&443u16.to_be_bytes());
        let (req, reply) = run(&v5).await;
        assert_eq!(req, Some(("example.com".into(), 443, 5)));
        assert_eq!(reply, [5, 0]);

        // SOCKS5 IPv4
        let (req, _) = run(&[5, 1, 0, 5, 1, 0, 1, 10, 0, 0, 7, 0, 80]).await;
        assert_eq!(req, Some(("10.0.0.7".into(), 80, 5)));

        // SOCKS5 asking only for username/password auth is turned away.
        let (req, reply) = run(&[5, 1, 2]).await;
        assert_eq!(req, None);
        assert_eq!(reply, [5, 0xff]);

        // SOCKS4a with a host name
        let mut v4a = vec![4, 1, 0x1f, 0x90, 0, 0, 0, 1, b'u', 0];
        v4a.extend_from_slice(b"db.internal\0");
        let (req, _) = run(&v4a).await;
        assert_eq!(req, Some(("db.internal".into(), 8080, 4)));

        // SOCKS5 BIND is refused.
        let (req, reply) = run(&[5, 1, 0, 5, 2, 0, 1, 1, 2, 3, 4, 0, 80]).await;
        assert_eq!(req, None);
        assert_eq!(reply[..4], [5, 0, 5, 7]);
    }
}
