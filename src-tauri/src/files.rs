//! The file manager: this PC and a server side by side, with transfers
//! between them. The server side is SFTP over a saved SSH host (on its own
//! connection, not a terminal's) or an FTP / FTPS site.

use crate::error::{AppError, AppResult};
use crate::sftp::{self, Entry, Listing, Progress, Reporter, Transfers, CHUNK};
use crate::ssh::Connection;
use crate::store::FtpSite;
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, UNIX_EPOCH};
use suppaftp::list::{File as FtpFile, ListParser, PosixPexQuery};
use suppaftp::tokio::{AsyncRustlsConnector, AsyncRustlsFtpStream};
use suppaftp::tokio_rustls::rustls;
use suppaftp::types::FileType;
use suppaftp::{FtpError, Status};
use tauri::ipc::Channel;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

type Ftp = AsyncRustlsFtpStream;

const FTP_TIMEOUT: Duration = Duration::from_secs(20);
/// Files larger than this open as "download instead" rather than in the editor.
const MAX_EDIT_BYTES: u64 = 10 * 1024 * 1024;

// ---- FTP ----

fn ftp_err(e: FtpError) -> AppError {
    match e {
        FtpError::UnexpectedResponse(r) => {
            let text = String::from_utf8_lossy(&r.body).trim().to_string();
            if r.status == Status::NotLoggedIn {
                AppError::kind("FTP_AUTH_FAILED", format!("Login failed: {text}"))
            } else {
                AppError::msg(text)
            }
        }
        FtpError::SecureError(m) => AppError::kind("FTP_TLS", format!("Secure connection failed: {}", m.trim_start_matches("Secure error: "))),
        FtpError::ConnectionError(e) => AppError::msg(format!("Connection error: {e}")),
        other => AppError::msg(other.to_string()),
    }
}

/// Accepts any certificate (for sites the user chose to trust), while still
/// checking that the server holds its key.
#[derive(Debug)]
struct AcceptAnyCert(Arc<rustls::crypto::CryptoProvider>);

impl rustls::client::danger::ServerCertVerifier for AcceptAnyCert {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

/// TLS settings for one FTPS connection. Its data connections use the same
/// config, so they resume the control connection's TLS session, which most
/// servers (vsftpd, ProFTPD, FileZilla Server) require.
fn tls_connector(accept_invalid_certs: bool) -> AppResult<AsyncRustlsConnector> {
    use rustls_platform_verifier::BuilderVerifierExt;
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| AppError::msg(e.to_string()))?;
    let config = if accept_invalid_certs {
        builder.dangerous().with_custom_certificate_verifier(Arc::new(AcceptAnyCert(provider))).with_no_client_auth()
    } else {
        builder.with_platform_verifier().map_err(|e| AppError::msg(e.to_string()))?.with_no_client_auth()
    };
    Ok(AsyncRustlsConnector::from(suppaftp::tokio_rustls::TlsConnector::from(Arc::new(config))))
}

/// Connects, logs in and switches to binary transfers.
pub async fn ftp_connect(site: &FtpSite, password: &str) -> AppResult<Ftp> {
    let run = async {
        let mut ftp = Ftp::connect((site.host.as_str(), site.port))
            .await
            .map_err(|e| AppError::msg(format!("Could not connect to {}:{}: {}", site.host, site.port, ftp_err(e).message)))?;
        if site.protocol == "ftps" {
            ftp = ftp.into_secure(tls_connector(site.accept_invalid_certs)?, &site.host).await.map_err(ftp_err)?;
        }
        // Servers behind NAT often announce a private address for passive
        // mode; connect to the address we already reached instead.
        ftp.set_passive_nat_workaround(true);
        let user = match site.user.trim() {
            "" => "anonymous",
            u => u,
        };
        ftp.login(user, password).await.map_err(ftp_err)?;
        ftp.transfer_type(FileType::Binary).await.map_err(ftp_err)?;
        Ok(ftp)
    };
    tokio::time::timeout(FTP_TIMEOUT, run)
        .await
        .map_err(|_| AppError::msg(format!("Timed out connecting to {}:{}", site.host, site.port)))?
}

/// Whether a site can log in without a password.
pub fn is_anonymous(site: &FtpSite) -> bool {
    matches!(site.user.trim(), "" | "anonymous" | "ftp")
}

fn ftp_entry(f: &FtpFile) -> Entry {
    let kind = if f.is_symlink() {
        "link"
    } else if f.is_directory() {
        "dir"
    } else {
        "file"
    };
    let mut perm = 0;
    for (i, who) in [PosixPexQuery::Owner, PosixPexQuery::Group, PosixPexQuery::Others].into_iter().enumerate() {
        let shift = 6 - 3 * i;
        if f.can_read(who) {
            perm |= 4 << shift;
        }
        if f.can_write(who) {
            perm |= 2 << shift;
        }
        if f.can_execute(who) {
            perm |= 1 << shift;
        }
    }
    let mtime = f.modified().duration_since(UNIX_EPOCH).ok().map(|d| d.as_secs() as u32).filter(|t| *t > 0);
    Entry {
        name: f.name().to_string(),
        kind,
        link_to_dir: false,
        size: f.size() as u64,
        mtime,
        mode: sftp::mode_string(perm, kind),
        owner: f.uid().map(|u| u.to_string()),
        hidden: f.name().starts_with('.'),
    }
}

/// Lists a folder, preferring MLSD (exact times) over LIST.
async fn ftp_list(ftp: &mut Ftp, path: &str) -> AppResult<Listing> {
    if !path.is_empty() {
        ftp.cwd(path).await.map_err(ftp_err)?;
    }
    let path = ftp.pwd().await.map_err(ftp_err)?;
    let files: Vec<FtpFile> = match ftp.mlsd(None).await {
        Ok(lines) => lines.iter().filter_map(|l| ListParser::parse_mlsd(l).ok()).collect(),
        Err(_) => ftp.list(None).await.map_err(ftp_err)?.iter().filter_map(|l| l.parse::<FtpFile>().ok()).collect(),
    };
    let entries = files.iter().filter(|f| !matches!(f.name(), "." | "..")).map(ftp_entry).collect();
    Ok(Listing { path, entries })
}

/// "YYYYMMDDhhmmss" in UTC, for MFMT.
fn ftp_time(secs: u32) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}{m:02}{d:02}{:02}{:02}{:02}", rem / 3600, rem % 3600 / 60, rem % 60)
}

pub struct FtpRemote {
    site: FtpSite,
    password: String,
    /// The browsing connection; transfers open their own.
    ctl: tokio::sync::Mutex<Option<Ftp>>,
}

impl FtpRemote {
    /// The browsing connection, reconnecting if the server dropped it (FTP
    /// servers close idle connections after a few minutes).
    async fn ctl(&self) -> AppResult<tokio::sync::MutexGuard<'_, Option<Ftp>>> {
        let mut guard = self.ctl.lock().await;
        let alive = match guard.as_mut() {
            Some(f) => matches!(tokio::time::timeout(Duration::from_secs(10), f.noop()).await, Ok(Ok(()))),
            None => false,
        };
        if !alive {
            *guard = Some(ftp_connect(&self.site, &self.password).await?);
        }
        Ok(guard)
    }
}

// ---- sessions ----

pub enum Remote {
    Sftp(Arc<Connection>),
    Ftp(FtpRemote),
}

impl Remote {
    pub fn ftp(site: FtpSite, password: String, ftp: Ftp) -> Self {
        Remote::Ftp(FtpRemote { site, password, ctl: tokio::sync::Mutex::new(Some(ftp)) })
    }

    async fn close(&self) {
        match self {
            Remote::Sftp(conn) => {
                let _ = conn.handle.disconnect(russh::Disconnect::ByApplication, "", "en").await;
            }
            Remote::Ftp(r) => {
                if let Some(mut f) = r.ctl.lock().await.take() {
                    let _ = tokio::time::timeout(Duration::from_secs(3), f.quit()).await;
                }
            }
        }
    }

    /// The folder a session starts in, and the home folder.
    pub async fn start_paths(&self, start_dir: Option<&str>) -> AppResult<(String, String)> {
        let home = match self {
            Remote::Sftp(conn) => sftp::session(conn).await?.canonicalize(".").await.map_err(sftp::sftp_err)?,
            Remote::Ftp(r) => r.ctl().await?.as_mut().unwrap().pwd().await.map_err(ftp_err)?,
        };
        let start = match start_dir.map(str::trim).filter(|s| !s.is_empty()) {
            None => home.clone(),
            Some("~") => home.clone(),
            Some(s) => match s.strip_prefix("~/") {
                Some(rest) => sftp::join(&home, rest),
                None => s.to_string(),
            },
        };
        Ok((start, home))
    }

    pub async fn list(&self, path: &str) -> AppResult<Listing> {
        match self {
            Remote::Sftp(conn) => sftp::list(conn, path).await,
            Remote::Ftp(r) => ftp_list(r.ctl().await?.as_mut().unwrap(), path).await,
        }
    }

    pub async fn mkdir(&self, path: &str) -> AppResult<()> {
        match self {
            Remote::Sftp(conn) => sftp::mkdir(conn, path).await,
            Remote::Ftp(r) => r.ctl().await?.as_mut().unwrap().mkdir(path).await.map_err(ftp_err),
        }
    }

    pub async fn rename(&self, from: &str, to: &str) -> AppResult<()> {
        match self {
            Remote::Sftp(conn) => sftp::rename(conn, from, to).await,
            Remote::Ftp(r) => r.ctl().await?.as_mut().unwrap().rename(from, to).await.map_err(ftp_err),
        }
    }

    pub async fn delete(&self, paths: &[String]) -> AppResult<()> {
        let r = match self {
            Remote::Sftp(conn) => return sftp::delete(conn, paths).await,
            Remote::Ftp(r) => r,
        };
        let mut guard = r.ctl().await?;
        let f = guard.as_mut().unwrap();
        for p in paths {
            // A file (or link) goes in one command; a folder is emptied first.
            if f.rm(p).await.is_ok() {
                continue;
            }
            let mut items = Vec::new();
            Link::Ftp(&mut *f).walk(p, "", true, &mut items).await?;
            for it in items.iter().rev() {
                if it.dir { f.rmdir(&it.path).await } else { f.rm(&it.path).await }.map_err(ftp_err)?;
            }
            f.rmdir(p).await.map_err(ftp_err)?;
        }
        Ok(())
    }

    pub async fn read_text(&self, path: &str) -> AppResult<TextFile> {
        let bytes = match self {
            Remote::Sftp(conn) => {
                let sftp = sftp::session(conn).await?;
                let size = sftp.metadata(path).await.map_err(sftp::sftp_err)?.size.unwrap_or(0);
                if size > MAX_EDIT_BYTES {
                    return Ok(TextFile { content: None, size, reason: Some("too large to edit".into()) });
                }
                sftp.read(path).await.map_err(sftp::sftp_err)?
            }
            Remote::Ftp(r) => {
                let mut guard = r.ctl().await?;
                let f = guard.as_mut().unwrap();
                let size = f.size(path).await.map_err(ftp_err)? as u64;
                if size > MAX_EDIT_BYTES {
                    return Ok(TextFile { content: None, size, reason: Some("too large to edit".into()) });
                }
                let mut s = f.retr_as_stream(path).await.map_err(ftp_err)?;
                let mut buf = Vec::new();
                s.read_to_end(&mut buf).await?;
                s.finish().await.map_err(ftp_err)?;
                buf
            }
        };
        let size = bytes.len() as u64;
        Ok(match String::from_utf8(bytes) {
            Ok(text) if !text.contains('\0') => TextFile { content: Some(text), size, reason: None },
            _ => TextFile { content: None, size, reason: Some("not a text file".into()) },
        })
    }

    pub async fn write_text(&self, path: &str, content: &str) -> AppResult<()> {
        match self {
            Remote::Sftp(conn) => sftp::write_text(conn, path, content).await,
            Remote::Ftp(r) => {
                let mut guard = r.ctl().await?;
                let mut s = guard.as_mut().unwrap().put_with_stream(path).await.map_err(ftp_err)?;
                s.write_all(content.as_bytes()).await?;
                s.finish().await.map_err(ftp_err)
            }
        }
    }

    /// A connection for one transfer: the shared SFTP session, or a new FTP
    /// connection (FTP can only move one file at a time per connection).
    async fn transfer_link<'a>(&self, slot: &'a mut Option<Ftp>) -> AppResult<Link<'a>> {
        Ok(match self {
            Remote::Sftp(conn) => Link::Sftp(sftp::session(conn).await?),
            Remote::Ftp(r) => {
                *slot = Some(ftp_connect(&r.site, &r.password).await?);
                Link::Ftp(slot.as_mut().unwrap())
            }
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    pub content: Option<String>,
    size: u64,
    pub reason: Option<String>,
}

/// Open file manager sessions by id (one per Files tab).
#[derive(Default)]
pub struct FileSessions {
    map: tokio::sync::Mutex<HashMap<String, Arc<Remote>>>,
    /// FTP passwords typed at a prompt, kept for this run of the app only.
    pub ftp_passwords: StdMutex<HashMap<String, String>>,
}

impl FileSessions {
    pub async fn get(&self, id: &str) -> AppResult<Arc<Remote>> {
        match self.map.lock().await.get(id) {
            Some(r) if !matches!(&**r, Remote::Sftp(c) if c.handle.is_closed()) => Ok(r.clone()),
            _ => Err(AppError::kind("FILES_CLOSED", "Disconnected from the server")),
        }
    }

    pub async fn insert(&self, id: String, remote: Remote) {
        if let Some(old) = self.map.lock().await.insert(id, Arc::new(remote)) {
            old.close().await;
        }
    }

    pub async fn close(&self, id: &str) {
        let removed = self.map.lock().await.remove(id);
        if let Some(r) = removed {
            r.close().await;
        }
    }
}

// ---- transfers ----

/// What to do when a file already exists at the destination.
#[derive(Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Policy {
    Overwrite,
    Skip,
    /// Overwrite only when the source is newer.
    Newer,
}

fn skip(policy: Policy, src: Option<u32>, dst: Option<u32>) -> bool {
    match policy {
        Policy::Overwrite => false,
        Policy::Skip => true,
        Policy::Newer => matches!((src, dst), (Some(s), Some(d)) if s <= d),
    }
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TransferResult {
    pub files: u32,
    pub skipped: u32,
}

/// A remote file or folder to download, as listed.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSource {
    pub path: String,
    pub dir: bool,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub mtime: Option<u32>,
}

struct Item {
    path: String,
    /// Path below the destination folder, "/"-separated.
    rel: String,
    size: u64,
    mtime: Option<u32>,
    dir: bool,
}

enum Link<'a> {
    Sftp(Arc<SftpSession>),
    Ftp(&'a mut Ftp),
}

async fn pump<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(src: &mut R, dst: &mut W, rep: &mut Reporter, rel: &str) -> AppResult<()> {
    let mut buf = vec![0u8; CHUNK];
    loop {
        let n = src.read(&mut buf).await?;
        if n == 0 {
            return Ok(());
        }
        dst.write_all(&buf[..n]).await?;
        rep.tick(n as u64, rel, false)?;
    }
}

impl Link<'_> {
    async fn list(&mut self, path: &str) -> AppResult<Vec<Entry>> {
        Ok(match self {
            Link::Sftp(s) => sftp::list_with(s, path).await?.entries,
            Link::Ftp(f) => ftp_list(f, path).await?.entries,
        })
    }

    /// Everything below folder `root` (not following linked folders, which
    /// could loop). For deleting, links are listed as files.
    async fn walk(&mut self, root: &str, rel: &str, for_delete: bool, out: &mut Vec<Item>) -> AppResult<()> {
        let mut stack = vec![(root.to_string(), rel.to_string())];
        while let Some((dir, rel)) = stack.pop() {
            for e in self.list(&dir).await? {
                let path = sftp::join(&dir, &e.name);
                let rel = if rel.is_empty() { e.name.clone() } else { format!("{rel}/{}", e.name) };
                let is_dir = e.kind == "dir";
                if e.kind == "link" && !for_delete {
                    let linked_dir = match self {
                        Link::Sftp(_) => e.link_to_dir,
                        // FTP doesn't say where a link points; see if it opens as a folder.
                        Link::Ftp(f) => f.cwd(&path).await.is_ok(),
                    };
                    if linked_dir {
                        continue;
                    }
                }
                out.push(Item { path: path.clone(), rel: rel.clone(), size: if is_dir { 0 } else { e.size }, mtime: e.mtime, dir: is_dir });
                if is_dir {
                    stack.push((path, rel));
                }
            }
        }
        Ok(())
    }

    async fn download_file(&mut self, path: &str, dst: &mut tokio::fs::File, rep: &mut Reporter, rel: &str) -> AppResult<()> {
        match self {
            Link::Sftp(s) => {
                let mut src = s.open(path).await.map_err(sftp::sftp_err)?;
                pump(&mut src, dst, rep, rel).await
            }
            Link::Ftp(f) => {
                let mut src = f.retr_as_stream(path).await.map_err(ftp_err)?;
                pump(&mut src, dst, rep, rel).await?;
                src.finish().await.map_err(ftp_err)
            }
        }
    }

    async fn upload_file(&mut self, src: &mut tokio::fs::File, path: &str, rep: &mut Reporter, rel: &str) -> AppResult<()> {
        match self {
            Link::Sftp(s) => {
                let mut dst = s.create(path).await.map_err(sftp::sftp_err)?;
                pump(src, &mut dst, rep, rel).await?;
                dst.shutdown().await.map_err(sftp::sftp_err)
            }
            Link::Ftp(f) => {
                let mut dst = f.put_with_stream(path).await.map_err(ftp_err)?;
                pump(src, &mut dst, rep, rel).await?;
                dst.finish().await.map_err(ftp_err)
            }
        }
    }

    async fn mkdir(&mut self, path: &str) -> AppResult<()> {
        match self {
            Link::Sftp(s) => s.create_dir(path).await.map_err(sftp::sftp_err),
            Link::Ftp(f) => f.mkdir(path).await.map_err(ftp_err),
        }
    }

    /// Keeps the source's modification time (best effort), so "only if
    /// newer" works on the next transfer.
    async fn set_mtime(&mut self, path: &str, mtime: u32) {
        match self {
            Link::Sftp(s) => {
                let attrs = russh_sftp::protocol::FileAttributes { atime: Some(mtime), mtime: Some(mtime), ..Default::default() };
                let _ = s.set_metadata(path, attrs).await;
            }
            Link::Ftp(f) => {
                let _ = f.custom_command(format!("MFMT {} {path}", ftp_time(mtime)), &[Status::File]).await;
            }
        }
    }

    async fn remove_file(&mut self, path: &str) {
        let _ = match self {
            Link::Sftp(s) => s.remove_file(path).await.map_err(sftp::sftp_err),
            Link::Ftp(f) => f.rm(path).await.map_err(ftp_err),
        };
    }
}

fn basename(path: &str) -> String {
    path.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().filter(|n| !n.is_empty()).unwrap_or("download").to_string()
}

fn mtime_of(meta: &std::fs::Metadata) -> Option<u32> {
    meta.modified().ok()?.duration_since(UNIX_EPOCH).ok().map(|d| d.as_secs() as u32)
}

pub async fn download(
    remote: &Remote,
    transfers: &Transfers,
    id: &str,
    sources: &[RemoteSource],
    local_dir: &str,
    policy: Policy,
    events: Channel<Progress>,
) -> AppResult<TransferResult> {
    let cancel = transfers.start(id);
    let result = async {
        let mut slot = None;
        let mut link = remote.transfer_link(&mut slot).await?;
        let mut items = Vec::new();
        for s in sources {
            let name = basename(&s.path);
            items.push(Item { path: s.path.clone(), rel: name.clone(), size: if s.dir { 0 } else { s.size }, mtime: s.mtime, dir: s.dir });
            if s.dir {
                link.walk(&s.path, &name, false, &mut items).await?;
            }
        }
        let mut rep = Reporter::new(events, cancel.clone(), items.iter().map(|i| i.size).sum());
        let mut stats = TransferResult::default();
        let base = PathBuf::from(local_dir);
        for it in items {
            let target = base.join(it.rel.replace('/', std::path::MAIN_SEPARATOR_STR));
            if it.dir {
                tokio::fs::create_dir_all(&target).await?;
                continue;
            }
            if let Ok(meta) = tokio::fs::metadata(&target).await {
                if skip(policy, it.mtime, mtime_of(&meta)) {
                    stats.skipped += 1;
                    rep.tick(it.size, &it.rel, true)?;
                    continue;
                }
            }
            if let Some(parent) = target.parent() {
                tokio::fs::create_dir_all(parent).await?;
            }
            let mut dst = tokio::fs::File::create(&target).await?;
            if let Err(e) = link.download_file(&it.path, &mut dst, &mut rep, &it.rel).await {
                drop(dst);
                let _ = tokio::fs::remove_file(&target).await;
                return Err(e);
            }
            dst.flush().await?;
            if let Some(m) = it.mtime {
                let file = dst.into_std().await;
                let _ = file.set_modified(UNIX_EPOCH + Duration::from_secs(m as u64));
            }
            stats.files += 1;
            rep.tick(0, &it.rel, true)?;
        }
        if let Link::Ftp(f) = link {
            let _ = f.quit().await;
        }
        Ok(stats)
    }
    .await;
    transfers.finish(id);
    result
}

/// Local files under `path` as items; folders before their contents.
fn walk_local(path: &Path, rel: String, out: &mut Vec<(PathBuf, Item)>) -> AppResult<()> {
    let meta = std::fs::metadata(path)?;
    let dir = meta.is_dir();
    out.push((path.to_path_buf(), Item { path: String::new(), rel: rel.clone(), size: if dir { 0 } else { meta.len() }, mtime: mtime_of(&meta), dir }));
    if dir {
        let mut entries: Vec<_> = std::fs::read_dir(path)?.filter_map(|e| e.ok()).collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let name = e.file_name().to_string_lossy().into_owned();
            walk_local(&e.path(), format!("{rel}/{name}"), out)?;
        }
    }
    Ok(())
}

pub async fn upload(
    remote: &Remote,
    transfers: &Transfers,
    id: &str,
    local: &[String],
    remote_dir: &str,
    policy: Policy,
    events: Channel<Progress>,
) -> AppResult<TransferResult> {
    let cancel = transfers.start(id);
    let result = async {
        let mut items = Vec::new();
        for l in local {
            let p = PathBuf::from(l);
            walk_local(&p, basename(l), &mut items)?;
        }
        let mut slot = None;
        let mut link = remote.transfer_link(&mut slot).await?;
        let mut rep = Reporter::new(events, cancel.clone(), items.iter().map(|i| i.1.size).sum());
        let mut stats = TransferResult::default();
        // What each destination folder already holds: name → (is dir, mtime).
        let mut existing: HashMap<String, HashMap<String, (bool, Option<u32>)>> = HashMap::new();
        for (local_path, it) in items {
            let target = sftp::join(remote_dir, &it.rel);
            let (parent, name) = match target.rsplit_once('/') {
                Some(("", n)) => ("/".to_string(), n.to_string()),
                Some((p, n)) => (p.to_string(), n.to_string()),
                None => (remote_dir.to_string(), target.clone()),
            };
            if !existing.contains_key(&parent) {
                let listed = link.list(&parent).await?.into_iter().map(|e| (e.name, (e.kind == "dir" || e.link_to_dir, e.mtime))).collect();
                existing.insert(parent.clone(), listed);
            }
            let found = existing[&parent].get(&name).copied();
            if it.dir {
                if found.is_none() {
                    link.mkdir(&target).await?;
                    existing.insert(target, HashMap::new());
                }
                continue;
            }
            if let Some((_, mtime)) = found {
                if skip(policy, it.mtime, mtime) {
                    stats.skipped += 1;
                    rep.tick(it.size, &it.rel, true)?;
                    continue;
                }
            }
            let mut src = tokio::fs::File::open(&local_path).await?;
            if let Err(e) = link.upload_file(&mut src, &target, &mut rep, &it.rel).await {
                link.remove_file(&target).await;
                return Err(e);
            }
            if let Some(m) = it.mtime {
                link.set_mtime(&target, m).await;
            }
            stats.files += 1;
            rep.tick(0, &it.rel, true)?;
        }
        if let Link::Ftp(f) = link {
            let _ = f.quit().await;
        }
        Ok(stats)
    }
    .await;
    transfers.finish(id);
    result
}

// ---- this PC ----

/// On Windows, the pseudo-folder listing the drives.
#[cfg_attr(not(windows), allow(dead_code))]
pub const DRIVES: &str = "This PC";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalListing {
    pub path: String,
    pub parent: Option<String>,
    /// Path separator to join names with.
    pub sep: String,
    pub entries: Vec<Entry>,
}

/// "\\?\C:\x" → "C:\x" (canonicalize adds the prefix on Windows).
fn plain_path(p: PathBuf) -> String {
    let s = p.to_string_lossy().into_owned();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s)
}

fn local_entry(name: String, path: &Path) -> Option<Entry> {
    let lmeta = std::fs::symlink_metadata(path).ok()?;
    let is_link = lmeta.file_type().is_symlink();
    // A link's target decides whether it opens as a folder.
    let meta = if is_link { std::fs::metadata(path).unwrap_or(lmeta.clone()) } else { lmeta.clone() };
    let kind = if is_link {
        "link"
    } else if meta.is_dir() {
        "dir"
    } else {
        "file"
    };
    #[cfg(unix)]
    let (mode, hidden) = {
        use std::os::unix::fs::PermissionsExt;
        (sftp::mode_string(lmeta.permissions().mode() & 0o777, kind), name.starts_with('.'))
    };
    #[cfg(windows)]
    let (mode, hidden) = {
        use std::os::windows::fs::MetadataExt;
        const HIDDEN: u32 = 0x2;
        const SYSTEM: u32 = 0x4;
        let attrs = lmeta.file_attributes();
        let mode = if meta.permissions().readonly() { "read-only".to_string() } else { String::new() };
        (mode, attrs & (HIDDEN | SYSTEM) != 0 || name.starts_with('.'))
    };
    Some(Entry {
        kind,
        link_to_dir: is_link && meta.is_dir(),
        size: if meta.is_dir() { 0 } else { meta.len() },
        mtime: mtime_of(&meta),
        mode,
        owner: None,
        hidden,
        name,
    })
}

#[cfg(windows)]
fn list_drives() -> LocalListing {
    let entries = (b'C'..=b'Z')
        .map(|l| format!("{}:", l as char))
        .filter(|d| std::fs::metadata(format!(r"{d}\")).is_ok())
        .map(|name| Entry {
            name,
            kind: "dir",
            link_to_dir: false,
            size: 0,
            mtime: None,
            mode: String::new(),
            owner: None,
            hidden: false,
        })
        .collect();
    LocalListing { path: DRIVES.into(), parent: None, sep: r"\".into(), entries }
}

/// A folder on this PC; "" is the home folder.
pub fn local_list(path: &str) -> AppResult<LocalListing> {
    #[cfg(windows)]
    if path == DRIVES {
        return Ok(list_drives());
    }
    let dir = if path.trim().is_empty() {
        dirs::home_dir().ok_or_else(|| AppError::msg("No home folder"))?
    } else {
        let p = crate::ssh::expand_home(path.trim());
        // "C:" alone means the drive's current folder; use its root.
        if cfg!(windows) && p.as_os_str().len() == 2 { p.join(r"\") } else { p }
    };
    let dir = std::fs::canonicalize(&dir).map_err(|e| AppError::msg(format!("{}: {e}", dir.display())))?;
    let mut entries = Vec::new();
    for e in std::fs::read_dir(&dir).map_err(|e| AppError::msg(format!("{}: {e}", dir.display())))?.flatten() {
        if let Some(entry) = local_entry(e.file_name().to_string_lossy().into_owned(), &e.path()) {
            entries.push(entry);
        }
    }
    let parent = dir.parent().map(|p| plain_path(p.to_path_buf()));
    #[cfg(windows)]
    let parent = parent.or_else(|| Some(DRIVES.to_string()));
    Ok(LocalListing { path: plain_path(dir), parent, sep: std::path::MAIN_SEPARATOR_STR.into(), entries })
}

pub fn local_mkdir(path: &str) -> AppResult<()> {
    std::fs::create_dir(path).map_err(AppError::from)
}

pub fn local_rename(from: &str, to: &str) -> AppResult<()> {
    if Path::new(to).exists() {
        return Err(AppError::msg("Something with that name already exists"));
    }
    std::fs::rename(from, to).map_err(AppError::from)
}

pub fn local_delete(paths: &[String]) -> AppResult<()> {
    for p in paths {
        let meta = std::fs::symlink_metadata(p)?;
        if meta.is_dir() {
            std::fs::remove_dir_all(p)?;
        } else {
            std::fs::remove_file(p)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn existing_files_follow_the_policy() {
        assert!(!skip(Policy::Overwrite, Some(1), Some(2)));
        assert!(skip(Policy::Skip, Some(5), Some(2)));
        assert!(skip(Policy::Newer, Some(2), Some(2)));
        assert!(!skip(Policy::Newer, Some(3), Some(2)));
        assert!(!skip(Policy::Newer, None, Some(2)));
    }

    #[test]
    fn formats_ftp_times() {
        assert_eq!(ftp_time(0), "19700101000000");
        assert_eq!(ftp_time(1_700_000_000), "20231114221320");
        assert_eq!(ftp_time(951_782_400), "20000229000000");
    }

    #[test]
    fn names_from_paths() {
        assert_eq!(basename("/var/www/"), "www");
        assert_eq!(basename(r"C:\Users\me\file.txt"), "file.txt");
    }

    #[test]
    fn lists_local_folders() {
        let dir = std::env::temp_dir().join(format!("tusk-files-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("a.txt"), "hello").unwrap();
        let l = local_list(&dir.to_string_lossy()).unwrap();
        let a = l.entries.iter().find(|e| e.name == "a.txt").unwrap();
        assert_eq!((a.kind, a.size), ("file", 5));
        assert_eq!(l.entries.iter().find(|e| e.name == "sub").unwrap().kind, "dir");
        assert!(l.parent.is_some());
        local_delete(&[dir.to_string_lossy().into_owned()]).unwrap();
        assert!(!dir.exists());
    }
}
