//! SFTP file browsing and transfers over a terminal's SSH connection.

use crate::error::{AppError, AppResult};
use crate::ssh::Connection;
use futures_util::future::BoxFuture;
use futures_util::FutureExt;
use russh::ChannelMsg;
use russh_sftp::client::SftpSession;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const CHUNK: usize = 256 * 1024;
/// Files larger than this open as "download instead" rather than in the editor.
const MAX_EDIT_BYTES: u64 = 10 * 1024 * 1024;

fn sftp_err(e: impl std::fmt::Display) -> AppError {
    AppError::msg(e.to_string())
}

pub async fn session(conn: &Connection) -> AppResult<Arc<SftpSession>> {
    let mut slot = conn.sftp.lock().await;
    if let Some(s) = slot.as_ref() {
        return Ok(s.clone());
    }
    let channel = conn.handle.channel_open_session().await.map_err(sftp_err)?;
    channel.request_subsystem(true, "sftp").await.map_err(sftp_err)?;
    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| AppError::msg(format!("This server doesn't offer SFTP: {e}")))?;
    let sftp = Arc::new(sftp);
    *slot = Some(sftp.clone());
    Ok(sftp)
}

/// Runs a command on a separate exec channel of the same connection and
/// returns its stdout. Used for small helper queries, never the user's shell.
pub async fn exec_capture(conn: &Connection, cmd: &str) -> AppResult<(String, Option<u32>)> {
    let run = async {
        let mut ch = conn.handle.channel_open_session().await.map_err(sftp_err)?;
        ch.exec(true, cmd).await.map_err(sftp_err)?;
        let mut out = Vec::new();
        let mut status = None;
        while let Some(msg) = ch.wait().await {
            match msg {
                ChannelMsg::Data { data } => out.extend_from_slice(&data),
                ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        Ok::<_, AppError>((String::from_utf8_lossy(&out).into_owned(), status))
    };
    tokio::time::timeout(Duration::from_secs(8), run)
        .await
        .map_err(|_| AppError::msg("The server took too long to answer"))?
}

/// The working directory of the terminal's interactive shell. The helper
/// command and the shell are both children of the connection's sshd process,
/// so the shell is the sibling of this command that isn't itself.
pub async fn shell_cwd(conn: &Connection) -> AppResult<Option<String>> {
    const CMD: &str = r#"pids=$(pgrep -P "$PPID" 2>/dev/null || ps -o pid= --ppid "$PPID" 2>/dev/null); for p in $pids; do if [ "$p" != "$$" ]; then d=$(readlink "/proc/$p/cwd" 2>/dev/null) && { printf '%s\n' "$d"; exit 0; }; fi; done; exit 1"#;
    let (out, status) = exec_capture(conn, CMD).await?;
    let dir = out.lines().next().unwrap_or("").trim().to_string();
    Ok(if status == Some(0) && dir.starts_with('/') { Some(dir) } else { None })
}

// ---- listing ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    name: String,
    /// dir | file | link
    kind: &'static str,
    /// For symlinks: whether the target is a directory.
    link_to_dir: bool,
    size: u64,
    mtime: Option<u32>,
    mode: String,
    owner: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    path: String,
    entries: Vec<Entry>,
}

fn mode_string(perm: u32, kind: &str) -> String {
    let t = match kind {
        "dir" => 'd',
        "link" => 'l',
        _ => '-',
    };
    let bits = ['r', 'w', 'x'];
    let mut s = String::with_capacity(10);
    s.push(t);
    for i in (0..9).rev() {
        s.push(if perm & (1 << i) != 0 { bits[(8 - i) % 3] } else { '-' });
    }
    s
}

pub fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

pub async fn list(conn: &Connection, path: &str) -> AppResult<Listing> {
    let sftp = session(conn).await?;
    let path = sftp.canonicalize(if path.is_empty() { "." } else { path }).await.map_err(sftp_err)?;
    let dir = sftp.read_dir(path.clone()).await.map_err(sftp_err)?;
    let mut entries = Vec::new();
    for e in dir {
        let name = e.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let meta = e.metadata();
        let ft = e.file_type();
        let kind = if ft.is_symlink() {
            "link"
        } else if ft.is_dir() {
            "dir"
        } else {
            "file"
        };
        let link_to_dir = kind == "link"
            && sftp.metadata(join(&path, &name)).await.map(|m| m.file_type().is_dir()).unwrap_or(false);
        entries.push(Entry {
            mode: mode_string(meta.permissions.unwrap_or(0), kind),
            name,
            kind,
            link_to_dir,
            size: meta.size.unwrap_or(0),
            mtime: meta.mtime,
            owner: meta.user.clone().or(meta.uid.map(|u| u.to_string())),
        });
    }
    Ok(Listing { path, entries })
}

// ---- simple operations ----

pub async fn mkdir(conn: &Connection, path: &str) -> AppResult<()> {
    session(conn).await?.create_dir(path).await.map_err(sftp_err)
}

pub async fn rename(conn: &Connection, from: &str, to: &str) -> AppResult<()> {
    session(conn).await?.rename(from, to).await.map_err(sftp_err)
}

fn remove_tree(sftp: Arc<SftpSession>, path: String) -> BoxFuture<'static, AppResult<()>> {
    async move {
        let meta = sftp.symlink_metadata(path.clone()).await.map_err(sftp_err)?;
        if meta.file_type().is_dir() {
            let entries: Vec<_> = sftp.read_dir(path.clone()).await.map_err(sftp_err)?.collect();
            for e in entries {
                let name = e.file_name();
                if name != "." && name != ".." {
                    remove_tree(sftp.clone(), join(&path, &name)).await?;
                }
            }
            sftp.remove_dir(path).await.map_err(sftp_err)
        } else {
            sftp.remove_file(path).await.map_err(sftp_err)
        }
    }
    .boxed()
}

pub async fn delete(conn: &Connection, paths: &[String]) -> AppResult<()> {
    let sftp = session(conn).await?;
    for p in paths {
        remove_tree(sftp.clone(), p.clone()).await?;
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    content: Option<String>,
    size: u64,
    /// Why the file can't be edited as text (too big, binary).
    reason: Option<String>,
}

pub async fn read_text(conn: &Connection, path: &str) -> AppResult<TextFile> {
    let sftp = session(conn).await?;
    let size = sftp.metadata(path).await.map_err(sftp_err)?.size.unwrap_or(0);
    if size > MAX_EDIT_BYTES {
        return Ok(TextFile { content: None, size, reason: Some("too large to edit".into()) });
    }
    let bytes = sftp.read(path).await.map_err(sftp_err)?;
    match String::from_utf8(bytes) {
        Ok(text) if !text.contains('\0') => Ok(TextFile { content: Some(text), size, reason: None }),
        _ => Ok(TextFile { content: None, size, reason: Some("not a text file".into()) }),
    }
}

pub async fn write_text(conn: &Connection, path: &str, content: &str) -> AppResult<()> {
    let sftp = session(conn).await?;
    let mut f = sftp.create(path).await.map_err(sftp_err)?;
    f.write_all(content.as_bytes()).await.map_err(sftp_err)?;
    f.shutdown().await.map_err(sftp_err)?;
    Ok(())
}

// ---- transfers ----

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Progress {
    Progress { done: u64, total: u64, file: String },
}

#[derive(Default)]
pub struct Transfers {
    cancel: StdMutex<HashMap<String, Arc<AtomicBool>>>,
}

impl Transfers {
    fn start(&self, id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.cancel.lock().unwrap().insert(id.to_string(), flag.clone());
        flag
    }
    fn finish(&self, id: &str) {
        self.cancel.lock().unwrap().remove(id);
    }
    pub fn cancel(&self, id: &str) {
        if let Some(f) = self.cancel.lock().unwrap().get(id) {
            f.store(true, Ordering::Relaxed);
        }
    }
}

struct Reporter {
    events: Channel<Progress>,
    cancel: Arc<AtomicBool>,
    done: u64,
    total: u64,
    last: Instant,
}

impl Reporter {
    fn tick(&mut self, n: u64, file: &str, force: bool) -> AppResult<()> {
        self.done += n;
        if self.cancel.load(Ordering::Relaxed) {
            return Err(AppError::kind("CANCELLED", "Transfer cancelled"));
        }
        if force || self.last.elapsed() > Duration::from_millis(120) {
            self.last = Instant::now();
            let _ = self.events.send(Progress::Progress { done: self.done, total: self.total, file: file.to_string() });
        }
        Ok(())
    }
}

/// Remote files under `path` (recursively) as (remote path, relative path, size).
fn walk_remote(sftp: Arc<SftpSession>, path: String, rel: String) -> BoxFuture<'static, AppResult<Vec<(String, String, u64, bool)>>> {
    async move {
        let meta = sftp.metadata(path.clone()).await.map_err(sftp_err)?;
        if !meta.file_type().is_dir() {
            return Ok(vec![(path, rel, meta.size.unwrap_or(0), false)]);
        }
        let mut out = vec![(path.clone(), rel.clone(), 0, true)];
        let entries: Vec<_> = sftp.read_dir(path.clone()).await.map_err(sftp_err)?.collect();
        for e in entries {
            let name = e.file_name();
            if name == "." || name == ".." {
                continue;
            }
            // Don't follow symlinked directories (avoids loops); copy links to files.
            if e.file_type().is_symlink() {
                if let Ok(m) = sftp.metadata(join(&path, &name)).await {
                    if !m.file_type().is_dir() {
                        out.push((join(&path, &name), format!("{rel}/{name}"), m.size.unwrap_or(0), false));
                    }
                }
                continue;
            }
            out.extend(walk_remote(sftp.clone(), join(&path, &name), format!("{rel}/{name}")).await?);
        }
        Ok(out)
    }
    .boxed()
}

pub async fn download(
    conn: &Connection,
    transfers: &Transfers,
    id: &str,
    remote: &[String],
    local_dir: &str,
    events: Channel<Progress>,
) -> AppResult<()> {
    let sftp = session(conn).await?;
    let cancel = transfers.start(id);
    let result = async {
        let mut items = Vec::new();
        for r in remote {
            let name = r.trim_end_matches('/').rsplit('/').next().unwrap_or("download").to_string();
            items.extend(walk_remote(sftp.clone(), r.clone(), name).await?);
        }
        let total = items.iter().map(|i| i.2).sum();
        let mut rep = Reporter { events, cancel: cancel.clone(), done: 0, total, last: Instant::now() };
        let base = PathBuf::from(local_dir);
        for (remote_path, rel, _, is_dir) in items {
            let target = base.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
            if is_dir {
                tokio::fs::create_dir_all(&target).await?;
                continue;
            }
            if let Some(parent) = target.parent() {
                tokio::fs::create_dir_all(parent).await?;
            }
            let mut src = sftp.open(remote_path.clone()).await.map_err(sftp_err)?;
            let mut dst = tokio::fs::File::create(&target).await?;
            let mut buf = vec![0u8; CHUNK];
            loop {
                let n = src.read(&mut buf).await.map_err(sftp_err)?;
                if n == 0 {
                    break;
                }
                dst.write_all(&buf[..n]).await?;
                if let Err(e) = rep.tick(n as u64, &rel, false) {
                    drop(dst);
                    let _ = tokio::fs::remove_file(&target).await;
                    return Err(e);
                }
            }
            dst.flush().await?;
            rep.tick(0, &rel, true)?;
        }
        Ok(())
    }
    .await;
    transfers.finish(id);
    result
}

fn walk_local(path: &Path, rel: String, out: &mut Vec<(PathBuf, String, u64, bool)>) -> AppResult<()> {
    let meta = std::fs::metadata(path)?;
    if meta.is_dir() {
        out.push((path.to_path_buf(), rel.clone(), 0, true));
        let mut entries: Vec<_> = std::fs::read_dir(path)?.filter_map(|e| e.ok()).collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let name = e.file_name().to_string_lossy().into_owned();
            walk_local(&e.path(), format!("{rel}/{name}"), out)?;
        }
    } else {
        out.push((path.to_path_buf(), rel, meta.len(), false));
    }
    Ok(())
}

pub async fn upload(
    conn: &Connection,
    transfers: &Transfers,
    id: &str,
    local: &[String],
    remote_dir: &str,
    events: Channel<Progress>,
) -> AppResult<()> {
    let sftp = session(conn).await?;
    let cancel = transfers.start(id);
    let result = async {
        let mut items = Vec::new();
        for l in local {
            let p = PathBuf::from(l);
            let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "upload".into());
            walk_local(&p, name, &mut items)?;
        }
        let total = items.iter().map(|i| i.2).sum();
        let mut rep = Reporter { events, cancel: cancel.clone(), done: 0, total, last: Instant::now() };
        for (local_path, rel, _, is_dir) in items {
            let target = join(remote_dir, &rel);
            if is_dir {
                if !sftp.try_exists(target.clone()).await.unwrap_or(false) {
                    sftp.create_dir(target).await.map_err(sftp_err)?;
                }
                continue;
            }
            let mut src = tokio::fs::File::open(&local_path).await?;
            let mut dst = sftp.create(target.clone()).await.map_err(sftp_err)?;
            let mut buf = vec![0u8; CHUNK];
            loop {
                let n = src.read(&mut buf).await?;
                if n == 0 {
                    break;
                }
                dst.write_all(&buf[..n]).await.map_err(sftp_err)?;
                if let Err(e) = rep.tick(n as u64, &rel, false) {
                    let _ = dst.shutdown().await;
                    let _ = sftp.remove_file(target).await;
                    return Err(e);
                }
            }
            dst.shutdown().await.map_err(sftp_err)?;
            rep.tick(0, &rel, true)?;
        }
        Ok(())
    }
    .await;
    transfers.finish(id);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_modes() {
        assert_eq!(mode_string(0o755, "dir"), "drwxr-xr-x");
        assert_eq!(mode_string(0o644, "file"), "-rw-r--r--");
        assert_eq!(mode_string(0o777, "link"), "lrwxrwxrwx");
    }

    #[test]
    fn joins_paths() {
        assert_eq!(join("/", "etc"), "/etc");
        assert_eq!(join("/home/a", "b"), "/home/a/b");
    }
}
