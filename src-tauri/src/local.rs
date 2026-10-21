//! Local terminals: shells on this PC (PowerShell, Command Prompt, Git Bash,
//! WSL distros) running in a pseudo-terminal (ConPTY on Windows).
//!
//! Output is streamed to the UI as raw bytes over a Tauri channel, the same
//! way as SSH terminals, so the frontend treats both alike.

use crate::error::{AppError, AppResult};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::ipc::{Channel, InvokeResponseBody};

/// A shell Tusk can start.
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Shell {
    pub id: String,
    pub name: String,
    pub program: String,
    pub args: Vec<String>,
    /// powershell | cmd | bash | wsl | other (picks the icon)
    pub kind: String,
}

impl Shell {
    fn new(id: &str, name: &str, program: impl Into<String>, args: &[&str], kind: &str) -> Self {
        Shell {
            id: id.into(),
            name: name.into(),
            program: program.into(),
            args: args.iter().map(|a| a.to_string()).collect(),
            kind: kind.into(),
        }
    }
}

#[cfg(windows)]
pub fn detect_shells() -> Vec<Shell> {
    let mut out = Vec::new();
    let program_files = std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into());
    let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());

    let pwsh = which("pwsh.exe").or_else(|| existing(Path::new(&program_files).join(r"PowerShell\7\pwsh.exe")));
    if let Some(p) = pwsh {
        out.push(Shell::new("pwsh", "PowerShell", p.to_string_lossy(), &["-NoLogo"], "powershell"));
    }
    let winps = Path::new(&system_root).join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    if winps.exists() {
        let name = if out.is_empty() { "PowerShell" } else { "Windows PowerShell" };
        out.push(Shell::new("powershell", name, winps.to_string_lossy(), &["-NoLogo"], "powershell"));
    }
    let cmd = std::env::var("ComSpec").unwrap_or_else(|_| format!(r"{system_root}\System32\cmd.exe"));
    out.push(Shell::new("cmd", "Command Prompt", cmd, &[], "cmd"));

    let git_bash = [Path::new(&program_files).join(r"Git\bin\bash.exe")]
        .into_iter()
        .chain(std::env::var("LOCALAPPDATA").ok().map(|l| Path::new(&l).join(r"Programs\Git\bin\bash.exe")))
        .find(|p| p.exists());
    if let Some(p) = git_bash {
        out.push(Shell::new("git-bash", "Git Bash", p.to_string_lossy(), &["--login", "-i"], "bash"));
    }

    for distro in wsl_distros() {
        out.push(Shell::new(
            &format!("wsl:{distro}"),
            &format!("WSL: {distro}"),
            "wsl.exe",
            &["-d", &distro, "--cd", "~"],
            "wsl",
        ));
    }
    out
}

/// Installed WSL distributions, default first.
#[cfg(windows)]
fn wsl_distros() -> Vec<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let Ok(output) = std::process::Command::new("wsl.exe")
        .args(["-l", "-q"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    parse_wsl_list(&output.stdout)
}

#[cfg(not(windows))]
pub fn detect_shells() -> Vec<Shell> {
    let mut out = Vec::new();
    if let Ok(sh) = std::env::var("SHELL") {
        if Path::new(&sh).exists() {
            let name = Path::new(&sh).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| sh.clone());
            out.push(Shell::new("login", &name, sh.clone(), &["-l"], "bash"));
        }
    }
    for (id, path) in [("bash", "/bin/bash"), ("zsh", "/bin/zsh"), ("fish", "/usr/bin/fish"), ("sh", "/bin/sh")] {
        if Path::new(path).exists() && !out.iter().any(|s: &Shell| s.program == path) {
            out.push(Shell::new(id, id, path, &["-l"], "bash"));
        }
    }
    out
}

/// `wsl -l -q` prints UTF-16LE, one distro per line.
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_wsl_list(bytes: &[u8]) -> Vec<String> {
    let units: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
    String::from_utf16_lossy(&units)
        .lines()
        .map(|l| l.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}' || c == '\0').to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

#[cfg(windows)]
fn which(exe: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?).map(|d| d.join(exe)).find(|p| p.is_file())
}

#[cfg_attr(not(windows), allow(dead_code))]
fn existing(p: PathBuf) -> Option<PathBuf> {
    p.exists().then_some(p)
}

// ---- running terminals ----

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum TermEvent {
    Connected { banner: Option<String> },
    Exit { status: u32 },
    Closed { reason: Option<String> },
}

fn json<T: Serialize>(v: &T) -> InvokeResponseBody {
    InvokeResponseBody::Json(serde_json::to_string(v).unwrap_or_else(|_| "null".into()))
}

struct LocalTerm {
    writer: Mutex<Box<dyn Write + Send>>,
    /// Dropped when the shell exits or the tab closes, which also ends the
    /// output reader on Windows (ConPTY keeps the pipe open until then).
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

#[derive(Default)]
pub struct LocalTerms {
    terms: Mutex<HashMap<String, Arc<LocalTerm>>>,
}

fn pty_err(e: impl std::fmt::Display) -> AppError {
    AppError::msg(e.to_string())
}

impl LocalTerms {
    pub fn open(&self, term_id: &str, shell: &Shell, cols: u16, rows: u16, events: Channel<InvokeResponseBody>) -> AppResult<()> {
        let size = PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 };
        let pair = native_pty_system().openpty(size).map_err(pty_err)?;
        let mut cmd = CommandBuilder::new(&shell.program);
        cmd.args(&shell.args);
        if let Some(home) = dirs::home_dir() {
            cmd.cwd(home);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "Tusk");
        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| AppError::msg(format!("Could not start {}: {e}", shell.name)))?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(pty_err)?;
        let writer = pair.master.take_writer().map_err(pty_err)?;
        let term = Arc::new(LocalTerm {
            writer: Mutex::new(writer),
            master: Mutex::new(Some(pair.master)),
            killer: Mutex::new(child.clone_killer()),
        });
        self.terms.lock().unwrap().insert(term_id.to_string(), term.clone());
        let _ = events.send(json(&TermEvent::Connected { banner: None }));

        let output = events.clone();
        let reading = std::thread::spawn(move || {
            let mut buf = vec![0u8; 16 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let _ = output.send(InvokeResponseBody::Raw(buf[..n].to_vec()));
                    }
                }
            }
        });
        std::thread::spawn(move || {
            let status = child.wait().map(|s| s.exit_code()).unwrap_or(1);
            term.master.lock().unwrap().take();
            let _ = reading.join();
            let _ = events.send(json(&TermEvent::Exit { status }));
            let _ = events.send(json(&TermEvent::Closed { reason: None }));
        });
        Ok(())
    }

    fn get(&self, term_id: &str) -> Option<Arc<LocalTerm>> {
        self.terms.lock().unwrap().get(term_id).cloned()
    }

    pub fn write(&self, term_id: &str, data: &[u8]) -> AppResult<()> {
        let Some(t) = self.get(term_id) else { return Ok(()) };
        let mut w = t.writer.lock().unwrap();
        w.write_all(data)?;
        w.flush()?;
        Ok(())
    }

    pub fn resize(&self, term_id: &str, cols: u16, rows: u16) {
        if let Some(t) = self.get(term_id) {
            if let Some(m) = t.master.lock().unwrap().as_ref() {
                let _ = m.resize(PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 });
            }
        }
    }

    pub fn close(&self, term_id: &str) {
        if let Some(t) = self.terms.lock().unwrap().remove(term_id) {
            let _ = t.killer.lock().unwrap().kill();
            t.master.lock().unwrap().take();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_wsl_distro_list() {
        let text = "\u{feff}Ubuntu-22.04\r\ndocker-desktop\r\n\r\n";
        let bytes: Vec<u8> = text.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        assert_eq!(parse_wsl_list(&bytes), ["Ubuntu-22.04", "docker-desktop"]);
        assert!(parse_wsl_list(&[]).is_empty());
    }

    #[test]
    fn finds_a_shell() {
        assert!(!detect_shells().is_empty());
    }
}
