//! PM2 (Node.js process manager) on SSH hosts and this PC: list apps with
//! their status and resource use, run actions on them, start new ones.
//!
//! PM2 is often installed through nvm, which only puts it on PATH in
//! interactive shells, so scripts first add the usual Node install folders.
//! Listing never starts a PM2 daemon: `pm2 jlist` only runs when one is
//! already running for the user.

use crate::error::{AppError, AppResult};
use crate::ssh::sh_quote;
use serde::Serialize;
use std::collections::HashMap;

/// Makes `pm2` (and its `node`) findable in a non-interactive shell.
pub const PATH_PRELUDE: &str = r#"for d in "$HOME"/.nvm/versions/node/*/bin "$HOME/.volta/bin" "$HOME/.npm-global/bin" "$HOME/.local/bin" "$HOME/.bun/bin" "$HOME/n/bin" "$HOME/.local/share/pnpm" "$HOME/.fnm/aliases/default/bin" /usr/local/bin /opt/homebrew/bin; do [ -d "$d" ] && PATH="$PATH:$d"; done; export PATH"#;

/// Sections: @pm2_version, @pm2_now, then @pm2_jlist (JSON) or
/// @pm2_stopped / @pm2_missing, and @pm2_others (users with a PM2 daemon).
pub const LIST_SCRIPT: &str = r#"H=${PM2_HOME:-$HOME/.pm2}
if command -v pm2 >/dev/null 2>&1; then
  b=$(command -v pm2); r=$(readlink -f "$b" 2>/dev/null || echo "$b")
  echo @pm2_version; sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$(dirname "$r")/../package.json" 2>/dev/null | head -n 1
  echo @pm2_now; date +%s
  if [ -f "$H/pm2.pid" ] && kill -0 "$(cat "$H/pm2.pid")" 2>/dev/null; then echo @pm2_jlist; pm2 jlist 2>/dev/null; echo; else echo @pm2_stopped; fi
else echo @pm2_missing; fi
echo @pm2_user; id -un 2>/dev/null
echo @pm2_others; ps -eo user=,args= 2>/dev/null | grep 'God Daemon' | grep -v grep | awk '{print $1}' | sort -u"#;

pub fn list_script() -> String {
    format!("{PATH_PRELUDE}\n{LIST_SCRIPT}")
}

#[derive(Serialize, Debug, Default, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Pm2Process {
    pub id: u32,
    pub name: String,
    /// online | stopped | stopping | errored | launching | waiting restart | one-launch-status
    pub status: String,
    pub pid: Option<u32>,
    pub cpu: f64,
    pub memory: u64,
    /// Seconds since the last (re)start, when online.
    pub uptime: Option<u64>,
    pub restarts: u32,
    pub unstable_restarts: u32,
    /// fork | cluster
    pub mode: String,
    pub script: String,
    pub cwd: String,
    pub interpreter: String,
    pub node_version: Option<String>,
    pub app_version: Option<String>,
    pub namespace: Option<String>,
    pub out_log: Option<String>,
    pub err_log: Option<String>,
    pub watch: bool,
}

#[derive(Serialize, Debug, Default, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Pm2 {
    /// ok | stopped (installed, no daemon) | missing | error
    pub status: String,
    pub version: Option<String>,
    pub message: Option<String>,
    pub processes: Vec<Pm2Process>,
    /// Other users running their own PM2 daemon.
    pub other_users: Vec<String>,
}

pub fn parse(s: &HashMap<String, Vec<&str>>) -> Pm2 {
    let current_user = s.get("pm2_user").and_then(|l| l.first()).map(|u| u.trim());
    let others = s
        .get("pm2_others")
        .into_iter()
        .flatten()
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty() && Some(u.as_str()) != current_user)
        .collect();
    let version = s.get("pm2_version").and_then(|l| l.first()).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    let mut pm2 = Pm2 { version, other_users: others, ..Default::default() };
    if s.contains_key("pm2_missing") || !(s.contains_key("pm2_jlist") || s.contains_key("pm2_stopped")) {
        pm2.status = "missing".into();
        return pm2;
    }
    if s.contains_key("pm2_stopped") {
        pm2.status = "stopped".into();
        return pm2;
    }
    let now = s.get("pm2_now").and_then(|l| l.first()).and_then(|v| v.trim().parse::<u64>().ok());
    let text = s.get("pm2_jlist").map(|l| l.join("\n")).unwrap_or_default();
    // PM2 may print notices (e.g. an update warning) before the JSON.
    let json = text.find("[{").or_else(|| text.find("[]")).map(|i| &text[i..]).unwrap_or("");
    match serde_json::from_str::<Vec<serde_json::Value>>(json.trim()) {
        Ok(list) => {
            pm2.status = "ok".into();
            pm2.processes = list.iter().filter_map(|p| process(p, now)).collect();
            pm2.processes.sort_by_key(|p| p.id);
        }
        Err(_) => {
            pm2.status = "error".into();
            pm2.message = Some(text.lines().find(|l| !l.trim().is_empty()).unwrap_or("PM2 didn't answer").trim().to_string());
        }
    }
    pm2
}

fn process(p: &serde_json::Value, now: Option<u64>) -> Option<Pm2Process> {
    let env = p.get("pm2_env")?;
    let s = |v: &serde_json::Value, k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
    let n = |v: &serde_json::Value, k: &str| v.get(k).and_then(|x| x.as_u64());
    let status = s(env, "status").unwrap_or_default();
    let started_ms = n(env, "pm_uptime");
    let uptime = match (status.as_str(), now, started_ms) {
        ("online", Some(now), Some(ms)) => Some(now.saturating_sub(ms / 1000)),
        _ => None,
    };
    let mode = s(env, "exec_mode").unwrap_or_default();
    Some(Pm2Process {
        id: n(p, "pm_id").or_else(|| n(env, "pm_id"))? as u32,
        name: s(p, "name").or_else(|| s(env, "name")).unwrap_or_default(),
        pid: n(p, "pid").filter(|&x| x > 0).map(|x| x as u32),
        cpu: p.pointer("/monit/cpu").and_then(|x| x.as_f64()).unwrap_or(0.0),
        memory: p.pointer("/monit/memory").and_then(|x| x.as_u64()).unwrap_or(0),
        uptime,
        restarts: n(env, "restart_time").unwrap_or(0) as u32,
        unstable_restarts: n(env, "unstable_restarts").unwrap_or(0) as u32,
        mode: mode.trim_end_matches("_mode").to_string(),
        script: s(env, "pm_exec_path").unwrap_or_default(),
        cwd: s(env, "pm_cwd").unwrap_or_default(),
        interpreter: s(env, "exec_interpreter").unwrap_or_default(),
        node_version: s(env, "node_version"),
        app_version: s(env, "version").filter(|v| v != "N/A"),
        namespace: s(env, "namespace").filter(|v| v != "default"),
        out_log: s(env, "pm_out_log_path"),
        err_log: s(env, "pm_err_log_path"),
        watch: env.get("watch").and_then(|w| w.as_bool()).unwrap_or(false),
        status,
    })
}

// ---- commands ----

/// An app selector: a PM2 id, an app name, or "all".
fn valid_target(t: &str) -> bool {
    !t.is_empty() && t.len() <= 100 && t.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-' | '@' | ':'))
}

/// `pm2 <action> <target>` as a POSIX script (prelude included).
pub fn action_script(action: &str, target: Option<&str>) -> AppResult<String> {
    let needs_target = !matches!(action, "save" | "resurrect");
    if !matches!(action, "start" | "stop" | "restart" | "reload" | "delete" | "flush" | "reset" | "save" | "resurrect") {
        return Err(AppError::msg(format!("Unknown PM2 action {action}")));
    }
    let target = match (needs_target, target) {
        (true, Some(t)) if valid_target(t) => format!(" {t}"),
        (true, _) => return Err(AppError::msg("Pick an app")),
        (false, _) => String::new(),
    };
    Ok(format!("{PATH_PRELUDE}\npm2 {action}{target} 2>&1"))
}

/// Starts a new app: `pm2 start <script> --name <name> [--cwd <dir>] [-i N]`.
pub fn start_script(script: &str, name: &str, cwd: &str, instances: u32) -> AppResult<String> {
    if script.trim().is_empty() {
        return Err(AppError::msg("Enter the script or command to run"));
    }
    let mut cmd = format!("pm2 start {}", sh_quote(script.trim()));
    if !name.trim().is_empty() {
        cmd += &format!(" --name {}", sh_quote(name.trim()));
    }
    let cwd = cwd.trim();
    if !cwd.is_empty() {
        // "~/app" should mean the home folder, which a quoted ~ wouldn't.
        let dir = match cwd.strip_prefix("~/") {
            Some(rest) => format!("\"$HOME\"/{}", sh_quote(rest)),
            None => sh_quote(cwd),
        };
        cmd = format!("cd {dir} && {cmd} --cwd \"$(pwd)\"");
    }
    if instances > 1 {
        cmd += &format!(" -i {instances}");
    }
    Ok(format!("{PATH_PRELUDE}\n{cmd} 2>&1"))
}

/// What a terminal tab runs to follow logs or open `pm2 monit`: a command
/// line for SSH hosts and a program with arguments for this PC.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCommand {
    pub remote: String,
    pub local: Vec<String>,
}

pub fn terminal_command(kind: &str, target: Option<&str>) -> AppResult<TerminalCommand> {
    let args = match (kind, target) {
        ("logs", Some(t)) if valid_target(t) => format!("logs {t} --lines 200"),
        ("logs", None) => "logs --lines 100".to_string(),
        ("monit", _) => "monit".to_string(),
        _ => return Err(AppError::msg("Unknown PM2 view")),
    };
    let script = format!("{PATH_PRELUDE}\nexec pm2 {args}");
    let local = if cfg!(windows) {
        ["cmd", "/C"].iter().map(|s| s.to_string()).chain([format!("pm2 {args}")]).collect()
    } else {
        vec!["sh".into(), "-c".into(), script.clone()]
    };
    Ok(TerminalCommand { remote: crate::ssh::posix(&script), local })
}

// ---- this PC ----

#[cfg(not(windows))]
fn run_local_script(script: &str) -> AppResult<(bool, String)> {
    let out = std::process::Command::new("sh").arg("-c").arg(script).output()?;
    Ok((out.status.success(), String::from_utf8_lossy(&out.stdout).into_owned()))
}

/// PM2 on Windows is a .cmd shim, so it goes through cmd.exe.
#[cfg(windows)]
fn run_local_script(script: &str) -> AppResult<(bool, String)> {
    use std::os::windows::process::CommandExt;
    // Scripts are POSIX; on Windows only the pm2 command line itself is used.
    let line = script.lines().last().unwrap_or("").trim_end_matches(" 2>&1");
    let out = std::process::Command::new("cmd")
        .args(["/C", line])
        .creation_flags(0x0800_0000)
        .output()?;
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    Ok((out.status.success(), text))
}

/// Sections like LIST_SCRIPT's for this PC.
#[cfg(not(windows))]
pub fn local_list_text() -> String {
    run_local_script(&list_script()).map(|(_, t)| t).unwrap_or_default()
}

#[cfg(windows)]
pub fn local_list_text() -> String {
    use std::os::windows::process::CommandExt;
    let quiet = |args: &[&str]| {
        std::process::Command::new("cmd").args(args).creation_flags(0x0800_0000).output().ok()
    };
    let installed = quiet(&["/C", "where", "pm2"]).is_some_and(|o| o.status.success());
    if !installed {
        return "@pm2_missing\n".into();
    }
    let home = std::env::var("PM2_HOME")
        .map(std::path::PathBuf::from)
        .ok()
        .or_else(|| dirs::home_dir().map(|h| h.join(".pm2")));
    let pid = home.and_then(|h| std::fs::read_to_string(h.join("pm2.pid")).ok()).map(|p| p.trim().to_string());
    // Only ask PM2 when its daemon is alive, so listing never starts one.
    let alive = pid.as_deref().filter(|p| p.chars().all(|c| c.is_ascii_digit())).is_some_and(|p| {
        quiet(&["/C", "tasklist", "/FI", &format!("PID eq {p}"), "/NH"])
            .is_some_and(|o| String::from_utf8_lossy(&o.stdout).contains(p))
    });
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    if !alive {
        return format!("@pm2_now\n{now}\n@pm2_stopped\n");
    }
    let list = quiet(&["/C", "pm2", "jlist"]).map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default();
    format!("@pm2_now\n{now}\n@pm2_jlist\n{list}\n")
}

/// Runs an action/start script on this PC.
pub async fn run_local(script: String) -> AppResult<String> {
    let (ok, out) = tokio::task::spawn_blocking(move || run_local_script(&script))
        .await
        .map_err(|e| AppError::msg(e.to_string()))??;
    if ok {
        Ok(out)
    } else {
        Err(AppError::msg(last_error(&out)))
    }
}

/// The useful line of PM2's output for an error message.
pub fn last_error(out: &str) -> String {
    let lines: Vec<&str> = out.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    lines
        .iter()
        .rev()
        .find(|l| l.contains("[PM2][ERROR]") || l.to_lowercase().contains("error"))
        .or(lines.last())
        .map(|l| l.trim_start_matches("[PM2][ERROR]").trim().to_string())
        .unwrap_or_else(|| "PM2 failed".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sections(text: &str) -> HashMap<String, Vec<&str>> {
        let mut out: HashMap<String, Vec<&str>> = HashMap::new();
        let mut cur = String::new();
        for l in text.lines() {
            if let Some(n) = l.strip_prefix('@') {
                cur = n.to_string();
                out.entry(cur.clone()).or_default();
            } else if !cur.is_empty() {
                out.entry(cur.clone()).or_default().push(l);
            }
        }
        out
    }

    const JLIST: &str = r#"@pm2_version
5.4.2
@pm2_now
1800000100
@pm2_jlist
>>>> In-memory PM2 is out-of-date, do:
[{"pid":4321,"name":"api","pm_id":0,"monit":{"memory":52428800,"cpu":3.5},"pm2_env":{"status":"online","pm_uptime":1800000000000,"restart_time":2,"unstable_restarts":0,"exec_mode":"cluster_mode","pm_exec_path":"/srv/api/server.js","pm_cwd":"/srv/api","exec_interpreter":"node","node_version":"20.11.1","version":"1.4.0","namespace":"default","pm_out_log_path":"/home/deploy/.pm2/logs/api-out.log","pm_err_log_path":"/home/deploy/.pm2/logs/api-error.log","watch":false,"env":{"SECRET":"x"}}},{"pid":0,"name":"worker","pm_id":1,"monit":{"memory":0,"cpu":0},"pm2_env":{"status":"stopped","pm_uptime":1700000000000,"restart_time":0,"unstable_restarts":0,"exec_mode":"fork_mode","pm_exec_path":"/srv/worker/index.js","pm_cwd":"/srv/worker","exec_interpreter":"node","version":"N/A","watch":true}}]
@pm2_user
deploy
@pm2_others
deploy
root
"#;

    #[test]
    fn parses_jlist() {
        let p = parse(&sections(JLIST));
        assert_eq!(p.status, "ok");
        assert_eq!(p.version.as_deref(), Some("5.4.2"));
        assert_eq!(p.other_users, ["root"]);
        assert_eq!(p.processes.len(), 2);
        let api = &p.processes[0];
        assert_eq!((api.id, api.name.as_str(), api.status.as_str()), (0, "api", "online"));
        assert_eq!(api.pid, Some(4321));
        assert_eq!(api.uptime, Some(100));
        assert_eq!(api.memory, 52428800);
        assert_eq!(api.mode, "cluster");
        assert_eq!(api.namespace, None);
        assert_eq!(api.app_version.as_deref(), Some("1.4.0"));
        let worker = &p.processes[1];
        assert_eq!((worker.pid, worker.uptime, worker.mode.as_str()), (None, None, "fork"));
        assert!(worker.watch);
        assert_eq!(worker.app_version, None);
    }

    #[test]
    fn reports_missing_and_stopped() {
        assert_eq!(parse(&sections("@pm2_missing\n@pm2_others\n")).status, "missing");
        let stopped = parse(&sections("@pm2_version\n5.3.0\n@pm2_stopped\n@pm2_others\n"));
        assert_eq!((stopped.status.as_str(), stopped.version.as_deref()), ("stopped", Some("5.3.0")));
        assert_eq!(parse(&sections("@pm2_jlist\n[]\n")).processes.len(), 0);
        assert_eq!(parse(&sections("@pm2_jlist\nconnect EACCES\n")).status, "error");
    }

    #[test]
    fn builds_commands_safely() {
        assert!(action_script("restart", Some("3")).unwrap().ends_with("pm2 restart 3 2>&1"));
        assert!(action_script("save", None).unwrap().ends_with("pm2 save 2>&1"));
        assert!(action_script("restart", Some("api; rm -rf /")).is_err());
        assert!(action_script("kill", Some("1")).is_err());
        assert!(action_script("stop", None).is_err());
        let s = start_script("server.js", "my app", "~/srv/it's here", 2).unwrap();
        assert!(s.ends_with(r#"cd "$HOME"/'srv/it'\''s here' && pm2 start 'server.js' --name 'my app' --cwd "$(pwd)" -i 2 2>&1"#), "{s}");
        assert!(start_script(" ", "", "", 1).is_err());
        let t = terminal_command("logs", Some("api")).unwrap();
        assert!(t.remote.starts_with("sh -c '") && t.remote.contains("exec pm2 logs api --lines 200"));
        assert!(terminal_command("logs", Some("a b")).is_err());
    }

    #[test]
    fn script_ends_the_json_line() {
        // jlist prints no trailing newline; the next section must start on its own line.
        assert!(LIST_SCRIPT.contains("pm2 jlist 2>/dev/null; echo;"));
    }

    #[test]
    fn picks_the_error_line() {
        assert_eq!(last_error("[PM2] Applying action\n[PM2][ERROR] Process or Namespace nope not found\n"), "Process or Namespace nope not found");
    }
}
