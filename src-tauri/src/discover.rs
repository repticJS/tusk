//! Finds databases and Docker containers on an SSH host or on this PC.
//!
//! One shell script gathers listening TCP ports (ss, netstat or
//! /proc/net/tcp), database processes, PostgreSQL clusters and Docker (or
//! Podman) containers, in "@section" blocks parsed here. On Windows the same
//! sections are assembled from netstat, tasklist and the docker CLI.

use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};

#[derive(Serialize, Debug, Default, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FoundDb {
    /// postgresql | mysql | mariadb | redis | mongodb | sqlserver | …
    pub kind: String,
    pub port: u16,
    /// Address it listens on; "" when on every interface.
    pub address: String,
    pub process: Option<String>,
    pub version: Option<String>,
    /// e.g. "cluster main · /var/lib/postgresql/16/main"
    pub detail: Option<String>,
}

#[derive(Serialize, Debug, Default, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PortMap {
    pub host_ip: String,
    pub host_port: u16,
    pub container_port: u16,
    pub proto: String,
}

/// Database settings from a container's environment (POSTGRES_USER etc.).
#[derive(Serialize, Debug, Default, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DbEnv {
    pub user: Option<String>,
    pub database: Option<String>,
    pub password: Option<String>,
}

#[derive(Serialize, Debug, Default, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Container {
    pub id: String,
    pub name: String,
    pub image: String,
    /// running | exited | paused | created | restarting | dead
    pub state: String,
    /// e.g. "Up 3 hours (healthy)"
    pub status: String,
    pub ports: Vec<PortMap>,
    pub db_kind: Option<String>,
    /// The database port inside the container (5432 for postgres…).
    pub db_port: Option<u16>,
    pub ip: Option<String>,
    pub env: DbEnv,
}

#[derive(Serialize, Debug, Default, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Docker {
    /// ok | missing | denied | stopped | error
    pub status: String,
    pub message: Option<String>,
    /// The command prefix that worked: "docker", "sudo -n docker", "podman".
    pub command: String,
    pub version: Option<String>,
    pub containers: Vec<Container>,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub os: String,
    pub databases: Vec<FoundDb>,
    pub docker: Docker,
}

pub const SCAN_SCRIPT: &str = r#"export LC_ALL=C
echo @os; (. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") || uname -sr
if command -v ss >/dev/null 2>&1; then echo @ss; ss -H -ltnp 2>/dev/null
elif command -v netstat >/dev/null 2>&1; then echo @netstat; netstat -ltnp 2>/dev/null
else echo @proctcp; cat /proc/net/tcp /proc/net/tcp6 2>/dev/null; fi
echo @procs; ps -eo args= 2>/dev/null | grep -E '(^|/)(postgres|postmaster|mysqld|mariadbd|redis-server|mongod|sqlservr|memcached|clickhouse-server)( |$)' | grep -v grep | cut -c1-400
echo @pgclusters; pg_lsclusters --no-header 2>/dev/null
D=
for c in docker podman; do
  if command -v $c >/dev/null 2>&1; then
    if $c ps -q >/dev/null 2>&1; then D=$c
    elif [ "$c" = docker ] && sudo -n docker ps -q >/dev/null 2>&1; then D="sudo -n docker"
    else echo @docker_error; $c ps -q 2>&1 | head -n 3; fi
    break
  fi
done
if [ -n "$D" ]; then
  echo @docker_cmd; echo "$D"
  echo @docker_version; $D version --format '{{.Server.Version}}' 2>/dev/null
  echo @docker_ps; $D ps -a --no-trunc --format '{{json .}}' 2>/dev/null
  ids=$($D ps -aq 2>/dev/null)
  if [ -n "$ids" ]; then echo @docker_inspect; $D inspect $ids 2>/dev/null; fi
elif ! command -v docker >/dev/null 2>&1 && ! command -v podman >/dev/null 2>&1; then echo @docker_missing; fi
exit 0"#;

/// Splits "@name" sections; content lines keep their text.
fn sections(text: &str) -> HashMap<String, Vec<&str>> {
    let mut out: HashMap<String, Vec<&str>> = HashMap::new();
    let mut current = String::new();
    for line in text.lines() {
        if let Some(name) = line.strip_prefix('@').filter(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')) {
            current = name.to_string();
            out.entry(current.clone()).or_default();
        } else if !current.is_empty() {
            out.entry(current.clone()).or_default().push(line);
        }
    }
    out
}

// ---- what is what ----

/// Database kind from a process name (with or without path or ".exe").
fn kind_of_process(name: &str) -> Option<&'static str> {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name).trim_end_matches(".exe").to_ascii_lowercase();
    Some(match base.as_str() {
        "postgres" | "postmaster" => "postgresql",
        "mysqld" => "mysql",
        "mariadbd" => "mariadb",
        "redis-server" => "redis",
        "mongod" => "mongodb",
        "sqlservr" => "sqlserver",
        "memcached" => "memcached",
        "clickhouse-server" => "clickhouse",
        "cockroach" => "cockroachdb",
        "influxd" => "influxdb",
        _ => return None,
    })
}

fn kind_of_port(port: u16) -> Option<&'static str> {
    Some(match port {
        5432 => "postgresql",
        3306 => "mysql",
        6379 => "redis",
        27017 => "mongodb",
        1433 => "sqlserver",
        9200 => "elasticsearch",
        11211 => "memcached",
        26257 => "cockroachdb",
        8086 => "influxdb",
        9042 => "cassandra",
        5672 => "rabbitmq",
        _ => return None,
    })
}

/// Database kind and its usual port from a container image name.
fn kind_of_image(image: &str) -> Option<(&'static str, u16)> {
    let i = image.to_ascii_lowercase();
    let name = i.rsplit('/').next().unwrap_or(&i).split(':').next().unwrap_or("");
    let has = |s: &str| name.contains(s) || i.contains(&format!("/{s}"));
    Some(if has("postgres") || has("postgis") || has("timescale") || has("pgvector") {
        ("postgresql", 5432)
    } else if has("mariadb") {
        ("mariadb", 3306)
    } else if has("mysql") {
        ("mysql", 3306)
    } else if has("redis") || has("valkey") {
        ("redis", 6379)
    } else if has("mongo") {
        ("mongodb", 27017)
    } else if has("mssql") {
        ("sqlserver", 1433)
    } else if has("elasticsearch") || has("opensearch") {
        ("elasticsearch", 9200)
    } else if has("memcached") {
        ("memcached", 11211)
    } else if has("cockroach") {
        ("cockroachdb", 26257)
    } else if has("clickhouse") {
        ("clickhouse", 9000)
    } else if has("influxdb") {
        ("influxdb", 8086)
    } else if has("cassandra") {
        ("cassandra", 9042)
    } else if has("rabbitmq") {
        ("rabbitmq", 5672)
    } else {
        return None;
    })
}

/// Processes that listen on behalf of containers.
fn is_container_proxy(process: &str) -> bool {
    matches!(process, "docker-proxy" | "rootlesskit" | "rootlessport" | "conmon" | "com.docker.backend" | "wslrelay" | "vpnkit")
        || process.starts_with("com.docker")
}

// ---- listening ports ----

#[derive(Debug, PartialEq)]
struct Listen {
    address: String,
    port: u16,
    process: Option<String>,
}

/// "127.0.0.1:5432", "[::]:5432", "*:5432", ":::5432" → (address, port).
fn split_addr(s: &str) -> Option<(String, u16)> {
    let (addr, port) = s.rsplit_once(':')?;
    let port = port.parse().ok()?;
    let addr = addr.trim_start_matches('[').trim_end_matches(']').split('%').next().unwrap_or("");
    let addr = match addr {
        "*" | "0.0.0.0" | "::" | "" | ":" => "",
        a => a,
    };
    Some((addr.to_string(), port))
}

fn parse_ss(lines: &[&str]) -> Vec<Listen> {
    lines
        .iter()
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            // State Recv-Q Send-Q Local Peer [users:(("name",pid=1,fd=3))]
            let local = f.iter().position(|x| *x == "LISTEN").map(|i| i + 3).unwrap_or(3);
            let (address, port) = split_addr(f.get(local)?)?;
            let process = l.split("((\"").nth(1).and_then(|r| r.split('"').next()).map(str::to_string);
            Some(Listen { address, port, process })
        })
        .collect()
}

fn parse_netstat(lines: &[&str]) -> Vec<Listen> {
    lines
        .iter()
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            if !f.first()?.starts_with("tcp") || !f.contains(&"LISTEN") {
                return None;
            }
            let (address, port) = split_addr(f.get(3)?)?;
            // "1234/postgres" or "-"
            let process = f.last().and_then(|p| p.split_once('/')).map(|(_, n)| n.trim_end_matches(':').to_string());
            Some(Listen { address, port, process })
        })
        .collect()
}

/// /proc/net/tcp{,6}: "0: 0100007F:1538 00000000:0000 0A …" (0A = LISTEN).
fn parse_proc_tcp(lines: &[&str]) -> Vec<Listen> {
    lines
        .iter()
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            if f.get(3) != Some(&"0A") {
                return None;
            }
            let (ip, port) = f.get(1)?.split_once(':')?;
            let port = u16::from_str_radix(port, 16).ok()?;
            let address = match ip.len() {
                8 => {
                    let n = u32::from_str_radix(ip, 16).ok()?;
                    std::net::Ipv4Addr::from(n.swap_bytes()).to_string()
                }
                32 => {
                    let mut b = [0u8; 16];
                    for (i, chunk) in ip.as_bytes().chunks(8).enumerate() {
                        let word = u32::from_str_radix(std::str::from_utf8(chunk).ok()?, 16).ok()?;
                        b[i * 4..i * 4 + 4].copy_from_slice(&word.swap_bytes().to_be_bytes());
                    }
                    std::net::Ipv6Addr::from(b).to_string()
                }
                _ => return None,
            };
            let address = if address == "0.0.0.0" || address == "::" { String::new() } else { address };
            Some(Listen { address, port, process: None })
        })
        .collect()
}

/// Windows `netstat -ano -p TCP` (and TCPv6) plus `tasklist /FO CSV /NH`.
fn parse_netstat_windows(lines: &[&str], tasks: &[&str]) -> Vec<Listen> {
    let names: HashMap<&str, &str> = tasks
        .iter()
        .filter_map(|l| {
            let mut f = l.split("\",\"");
            let name = f.next()?.trim_start_matches('"');
            let pid = f.next()?;
            Some((pid, name))
        })
        .collect();
    lines
        .iter()
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            if f.first() != Some(&"TCP") || f.get(3) != Some(&"LISTENING") {
                return None;
            }
            let (address, port) = split_addr(f.get(1)?)?;
            let process = f.get(4).and_then(|pid| names.get(pid)).map(|n| n.to_string());
            Some(Listen { address, port, process })
        })
        .collect()
}

// ---- assembling ----

/// "/usr/lib/postgresql/16/bin/postgres -D /var/lib/… -p 5433" → (version, data dir, port).
fn postgres_args(args: &str) -> (Option<String>, Option<String>, Option<u16>) {
    let version = args
        .split("postgresql/")
        .nth(1)
        .and_then(|r| r.split('/').next())
        .filter(|v| v.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .map(str::to_string);
    let words: Vec<&str> = args.split_whitespace().collect();
    let after = |flag: &str| words.iter().position(|w| *w == flag).and_then(|i| words.get(i + 1)).map(|s| s.to_string());
    let port = after("-p").and_then(|p| p.parse().ok());
    (version, after("-D"), port)
}

fn parse_docker(s: &HashMap<String, Vec<&str>>) -> Docker {
    if s.contains_key("docker_missing") {
        return Docker { status: "missing".into(), ..Default::default() };
    }
    if let Some(err) = s.get("docker_error") {
        let text = err.join("\n");
        let lower = text.to_lowercase();
        let (status, message) = if lower.contains("permission denied") {
            ("denied", "This user isn't allowed to use Docker. Add it to the docker group (sudo usermod -aG docker $USER), then reconnect.")
        } else if ["cannot connect", "failed to connect", "daemon running", "daemon is running", "not running"]
            .iter()
            .any(|p| lower.contains(p))
        {
            ("stopped", "Docker is installed but its service isn't running.")
        } else {
            ("error", "")
        };
        let message = if message.is_empty() { text.trim().to_string() } else { message.to_string() };
        return Docker { status: status.into(), message: Some(message), ..Default::default() };
    }
    let Some(cmd) = s.get("docker_cmd").and_then(|l| l.first()) else {
        return Docker { status: "missing".into(), ..Default::default() };
    };

    // Details that `docker ps` doesn't show: environment and container IP.
    let inspect: Vec<serde_json::Value> = s
        .get("docker_inspect")
        .and_then(|l| serde_json::from_str(&l.join("\n")).ok())
        .unwrap_or_default();
    let by_id: HashMap<&str, &serde_json::Value> =
        inspect.iter().filter_map(|v| Some((v.get("Id")?.as_str()?, v))).collect();

    let mut containers = Vec::new();
    for line in s.get("docker_ps").into_iter().flatten() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let get = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
        let id = get("ID");
        let image = get("Image");
        let state = match get("State") {
            s if !s.is_empty() => s.to_lowercase(),
            // Older Docker has no State field; derive it from Status.
            _ => if get("Status").starts_with("Up") { "running".into() } else { "exited".into() },
        };
        let detail = by_id.iter().find(|(k, _)| k.starts_with(&id) || id.starts_with(*k)).map(|(_, v)| *v);
        let env: Vec<&str> = detail
            .and_then(|d| d.pointer("/Config/Env"))
            .and_then(|e| e.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str()).collect())
            .unwrap_or_default();
        let env_get = |keys: &[&str]| {
            keys.iter().find_map(|k| env.iter().find_map(|e| e.strip_prefix(&format!("{k}=")).map(str::to_string)))
        };
        let ip = detail.and_then(|d| {
            let direct = d.pointer("/NetworkSettings/IPAddress").and_then(|x| x.as_str()).filter(|x| !x.is_empty());
            direct.map(str::to_string).or_else(|| {
                d.pointer("/NetworkSettings/Networks")?
                    .as_object()?
                    .values()
                    .find_map(|n| n.get("IPAddress")?.as_str().filter(|x| !x.is_empty()).map(str::to_string))
            })
        });
        let kind = kind_of_image(&image);
        let db_env = match kind.map(|k| k.0) {
            Some("postgresql") => DbEnv {
                user: env_get(&["POSTGRES_USER"]),
                database: env_get(&["POSTGRES_DB"]),
                password: env_get(&["POSTGRES_PASSWORD"]),
            },
            Some("mysql") | Some("mariadb") => DbEnv {
                user: env_get(&["MYSQL_USER", "MARIADB_USER"]),
                database: env_get(&["MYSQL_DATABASE", "MARIADB_DATABASE"]),
                password: env_get(&["MYSQL_PASSWORD", "MARIADB_PASSWORD", "MYSQL_ROOT_PASSWORD", "MARIADB_ROOT_PASSWORD"]),
            },
            Some("mongodb") => DbEnv {
                user: env_get(&["MONGO_INITDB_ROOT_USERNAME"]),
                database: env_get(&["MONGO_INITDB_DATABASE"]),
                password: env_get(&["MONGO_INITDB_ROOT_PASSWORD"]),
            },
            _ => DbEnv::default(),
        };
        containers.push(Container {
            id: id.chars().take(12).collect(),
            name: get("Names").split(',').next().unwrap_or("").to_string(),
            image,
            state,
            status: get("Status"),
            ports: parse_ports(&get("Ports")),
            db_kind: kind.map(|k| k.0.to_string()),
            db_port: kind.map(|k| k.1),
            ip,
            env: db_env,
        });
    }
    // Running first, then by name.
    containers.sort_by(|a, b| (a.state != "running", &a.name).cmp(&(b.state != "running", &b.name)));
    Docker {
        status: "ok".into(),
        message: None,
        command: cmd.trim().to_string(),
        version: s.get("docker_version").and_then(|l| l.first()).map(|v| v.trim().to_string()).filter(|v| !v.is_empty()),
        containers,
    }
}

/// "0.0.0.0:5433->5432/tcp, :::5433->5432/tcp, 6379/tcp" → published ports
/// (IPv4 and IPv6 duplicates merged; unpublished ones dropped).
fn parse_ports(s: &str) -> Vec<PortMap> {
    let mut out: Vec<PortMap> = Vec::new();
    for part in s.split(',').map(str::trim) {
        let Some((host, inner)) = part.split_once("->") else { continue };
        let (cport, proto) = inner.split_once('/').unwrap_or((inner, "tcp"));
        let Some((host_ip, host_port)) = split_addr(host) else { continue };
        let Ok(container_port) = cport.split('-').next().unwrap_or("").parse() else { continue };
        let m = PortMap { host_ip, host_port, container_port, proto: proto.to_string() };
        if !out.iter().any(|o| o.host_port == m.host_port && o.proto == m.proto) {
            out.push(m);
        }
    }
    out
}

pub fn parse_scan(text: &str) -> ScanResult {
    let s = sections(text);
    let docker = parse_docker(&s);

    let listens = if let Some(l) = s.get("ss") {
        parse_ss(l)
    } else if let Some(l) = s.get("netstat") {
        parse_netstat(l)
    } else if let Some(l) = s.get("netstat_win") {
        parse_netstat_windows(l, s.get("tasklist").map(Vec::as_slice).unwrap_or_default())
    } else {
        parse_proc_tcp(s.get("proctcp").map(Vec::as_slice).unwrap_or_default())
    };

    let published: Vec<u16> = docker.containers.iter().flat_map(|c| c.ports.iter().map(|p| p.host_port)).collect();
    let pg_procs: Vec<(Option<String>, Option<String>, Option<u16>)> = s
        .get("procs")
        .into_iter()
        .flatten()
        .filter(|a| a.split_whitespace().next().and_then(kind_of_process) == Some("postgresql"))
        .map(|a| postgres_args(a))
        .collect();
    // pg_lsclusters: "16 main 5432 online postgres /var/lib/postgresql/16/main /var/log/…"
    let clusters: HashMap<u16, (String, String, String)> = s
        .get("pgclusters")
        .into_iter()
        .flatten()
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            // A stopped cluster may share its port with whatever runs now.
            if !f.get(3)?.starts_with("online") {
                return None;
            }
            Some((f.get(2)?.parse().ok()?, (f[0].to_string(), f[1].to_string(), f.get(5).unwrap_or(&"").to_string())))
        })
        .collect();

    // One entry per port; an address on every interface wins.
    let mut found: BTreeMap<u16, FoundDb> = BTreeMap::new();
    for l in listens {
        if l.process.as_deref().is_some_and(is_container_proxy) || published.contains(&l.port) {
            continue;
        }
        let kind = l.process.as_deref().and_then(kind_of_process).or_else(|| kind_of_port(l.port));
        let Some(kind) = kind else { continue };
        let entry = found.entry(l.port).or_insert_with(|| FoundDb {
            kind: kind.to_string(),
            port: l.port,
            address: l.address.clone(),
            process: l.process.clone(),
            ..Default::default()
        });
        if l.address.is_empty() || (entry.address.contains(':') && !l.address.contains(':')) {
            entry.address = l.address;
        }
    }

    let pg_ports: Vec<u16> = found.values().filter(|d| d.kind == "postgresql").map(|d| d.port).collect();
    for db in found.values_mut().filter(|d| d.kind == "postgresql") {
        if let Some((version, name, dir)) = clusters.get(&db.port) {
            db.version = Some(version.clone());
            db.detail = Some(format!("cluster {name} · {dir}").trim_end_matches(" · ").to_string());
            continue;
        }
        // Match a postgres process by its -p flag, or the only one there is.
        let proc_match = pg_procs
            .iter()
            .find(|p| p.2 == Some(db.port))
            .or_else(|| (pg_procs.len() == 1 && pg_ports.len() == 1).then(|| &pg_procs[0]));
        if let Some((version, dir, _)) = proc_match {
            db.version = version.clone();
            db.detail = dir.clone();
        }
    }

    ScanResult {
        os: s.get("os").and_then(|l| l.first()).map(|v| v.trim().to_string()).unwrap_or_default(),
        databases: found.into_values().collect(),
        docker,
    }
}

// ---- running scans and container actions ----

/// A container action as a shell command; the id is checked so nothing else
/// can be slipped in.
pub fn docker_command(prefix: &str, action: &str, id: &str) -> AppResult<String> {
    if !matches!(action, "start" | "stop" | "restart" | "pause" | "unpause") {
        return Err(AppError::msg(format!("Unknown container action {action}")));
    }
    if !valid_id(id) {
        return Err(AppError::msg("Invalid container id"));
    }
    if !matches!(prefix, "docker" | "podman" | "sudo -n docker") {
        return Err(AppError::msg("Unknown container tool"));
    }
    Ok(format!("{prefix} {action} {id} 2>&1"))
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

/// Scans this PC.
pub async fn scan_local() -> AppResult<ScanResult> {
    let text = tokio::task::spawn_blocking(local_scan_text).await.map_err(|e| AppError::msg(e.to_string()))??;
    Ok(parse_scan(&text))
}

#[cfg(not(windows))]
fn local_scan_text() -> AppResult<String> {
    let out = std::process::Command::new("sh").arg("-c").arg(SCAN_SCRIPT).output()?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(windows)]
fn hidden(program: &str) -> std::process::Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut c = std::process::Command::new(program);
    c.creation_flags(CREATE_NO_WINDOW);
    c
}

#[cfg(windows)]
fn run_text(program: &str, args: &[&str]) -> Option<(bool, String)> {
    let out = hidden(program).args(args).output().ok()?;
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    if !out.status.success() {
        text.push_str(&String::from_utf8_lossy(&out.stderr));
    }
    Some((out.status.success(), text))
}

/// The same sections as SCAN_SCRIPT, from Windows tools.
#[cfg(windows)]
fn local_scan_text() -> AppResult<String> {
    let mut t = String::from("@os\nWindows\n@netstat_win\n");
    for proto in ["TCP", "TCPv6"] {
        if let Some((_, out)) = run_text("netstat", &["-ano", "-p", proto]) {
            // TCPv6 rows say "TCP" too.
            t.push_str(&out);
            t.push('\n');
        }
    }
    t.push_str("@tasklist\n");
    if let Some((_, out)) = run_text("tasklist", &["/FO", "CSV", "/NH"]) {
        t.push_str(&out);
        t.push('\n');
    }
    match run_text("docker", &["ps", "-q"]) {
        None => t.push_str("@docker_missing\n"),
        Some((false, err)) => {
            t.push_str("@docker_error\n");
            t.push_str(&err);
            t.push('\n');
        }
        Some((true, ids)) => {
            t.push_str("@docker_cmd\ndocker\n@docker_version\n");
            if let Some((_, v)) = run_text("docker", &["version", "--format", "{{.Server.Version}}"]) {
                t.push_str(&v);
            }
            t.push_str("\n@docker_ps\n");
            if let Some((_, out)) = run_text("docker", &["ps", "-a", "--no-trunc", "--format", "{{json .}}"]) {
                t.push_str(&out);
            }
            let _ = ids;
            if let Some((_, all)) = run_text("docker", &["ps", "-aq"]) {
                let ids: Vec<&str> = all.split_whitespace().filter(|i| valid_id(i)).collect();
                if !ids.is_empty() {
                    let mut args = vec!["inspect"];
                    args.extend(ids);
                    if let Some((_, out)) = run_text("docker", &args) {
                        t.push_str("\n@docker_inspect\n");
                        t.push_str(&out);
                    }
                }
            }
            t.push('\n');
        }
    }
    Ok(t)
}

/// Runs a container action on this PC.
pub async fn docker_local(prefix: &str, action: &str, id: &str) -> AppResult<()> {
    let cmd = docker_command(prefix, action, id)?;
    let (ok, out) = tokio::task::spawn_blocking(move || run_local(&cmd)).await.map_err(|e| AppError::msg(e.to_string()))??;
    if ok {
        Ok(())
    } else {
        Err(AppError::msg(out.trim().to_string()))
    }
}

#[cfg(not(windows))]
fn run_local(cmd: &str) -> AppResult<(bool, String)> {
    let out = std::process::Command::new("sh").arg("-c").arg(cmd).output()?;
    Ok((out.status.success(), String::from_utf8_lossy(&out.stdout).into_owned()))
}

#[cfg(windows)]
fn run_local(cmd: &str) -> AppResult<(bool, String)> {
    let words: Vec<&str> = cmd.trim_end_matches(" 2>&1").split_whitespace().collect();
    let (program, args) = words.split_first().ok_or_else(|| AppError::msg("Empty command"))?;
    run_text(program, args).ok_or_else(|| AppError::msg("Docker isn't installed"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ss_netstat_and_proc() {
        let ss = [
            "LISTEN 0      244        127.0.0.1:5432       0.0.0.0:*    users:((\"postgres\",pid=812,fd=6))",
            "LISTEN 0      4096       0.0.0.0:5433       0.0.0.0:*    users:((\"docker-proxy\",pid=9,fd=4))",
            "LISTEN 0      511           [::]:6380          [::]:*",
        ];
        let l = parse_ss(&ss);
        assert_eq!(l[0], Listen { address: "127.0.0.1".into(), port: 5432, process: Some("postgres".into()) });
        assert_eq!(l[2], Listen { address: "".into(), port: 6380, process: None });

        let netstat = [
            "Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name",
            "tcp        0      0 0.0.0.0:3306            0.0.0.0:*               LISTEN      901/mysqld",
            "tcp6       0      0 :::27017                :::*                    LISTEN      -",
        ];
        let l = parse_netstat(&netstat);
        assert_eq!(l[0], Listen { address: "".into(), port: 3306, process: Some("mysqld".into()) });
        assert_eq!(l[1], Listen { address: "".into(), port: 27017, process: None });

        let proc = [
            "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
            "   0: 0100007F:1538 00000000:0000 0A 00000000:00000000 00:00000000 00000000   111        0 1",
            "   1: 00000000:18EB 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2",
            "   2: 0100007F:1538 0100007F:9C40 01 00000000:00000000 00:00000000 00000000   111        0 3",
            "   0: 00000000000000000000000001000000:1538 00000000000000000000000000000000:0000 0A 0",
        ];
        let l = parse_proc_tcp(&proc);
        assert_eq!(l.len(), 3);
        assert_eq!(l[0], Listen { address: "127.0.0.1".into(), port: 5432, process: None });
        assert_eq!(l[1].port, 6379);
        assert_eq!(l[2].address, "::1");
    }

    #[test]
    fn parses_windows_netstat() {
        let ns = [
            "  Proto  Local Address          Foreign Address        State           PID",
            "  TCP    0.0.0.0:5432           0.0.0.0:0              LISTENING       4120",
            "  TCP    [::]:5432              [::]:0                 LISTENING       4120",
            "  TCP    127.0.0.1:5433         127.0.0.1:50000        ESTABLISHED     11",
        ];
        let tl = ["\"postgres.exe\",\"4120\",\"Services\",\"0\",\"12,000 K\""];
        let l = parse_netstat_windows(&ns, &tl);
        assert_eq!(l.len(), 2);
        assert_eq!(l[0].process.as_deref(), Some("postgres.exe"));
        assert_eq!(kind_of_process("postgres.exe"), Some("postgresql"));
    }

    const DOCKER: &str = r#"@docker_cmd
docker
@docker_version
27.3.1
@docker_ps
{"ID":"aaaaaaaaaaaa1111","Image":"postgres:16-alpine","Names":"shop-db","Ports":"0.0.0.0:5433->5432/tcp, :::5433->5432/tcp","State":"running","Status":"Up 3 hours (healthy)"}
{"ID":"bbbbbbbbbbbb2222","Image":"redis:7","Names":"cache","Ports":"6379/tcp","State":"running","Status":"Up 3 hours"}
{"ID":"cccccccccccc3333","Image":"nginx:latest","Names":"web","Ports":"","State":"exited","Status":"Exited (0) 2 days ago"}
@docker_inspect
[
  {"Id": "aaaaaaaaaaaa1111", "Config": {"Env": ["POSTGRES_USER=shop", "POSTGRES_PASSWORD=s3cret", "PATH=/usr/bin"]},
   "NetworkSettings": {"IPAddress": "", "Networks": {"app_default": {"IPAddress": "172.18.0.2"}}}},
  {"Id": "bbbbbbbbbbbb2222", "Config": {"Env": []}, "NetworkSettings": {"IPAddress": "172.17.0.3"}}
]
"#;

    #[test]
    fn parses_docker_containers() {
        let s = sections(DOCKER);
        let d = parse_docker(&s);
        assert_eq!(d.status, "ok");
        assert_eq!(d.version.as_deref(), Some("27.3.1"));
        assert_eq!(d.containers.len(), 3);
        let pg = &d.containers[1];
        assert_eq!(pg.name, "shop-db");
        assert_eq!(pg.db_kind.as_deref(), Some("postgresql"));
        assert_eq!(pg.ports, [PortMap { host_ip: "".into(), host_port: 5433, container_port: 5432, proto: "tcp".into() }]);
        assert_eq!(pg.ip.as_deref(), Some("172.18.0.2"));
        assert_eq!(pg.env, DbEnv { user: Some("shop".into()), database: None, password: Some("s3cret".into()) });
        assert_eq!(d.containers[0].name, "cache");
        assert!(d.containers[0].ports.is_empty());
        assert_eq!(d.containers[2].state, "exited");
        assert_eq!(d.containers[2].db_kind, None);
    }

    #[test]
    fn reports_docker_problems() {
        let denied = sections("@docker_error\npermission denied while trying to connect to the Docker daemon socket\n");
        assert_eq!(parse_docker(&denied).status, "denied");
        assert_eq!(parse_docker(&sections("@docker_missing\n")).status, "missing");
        let stopped = sections("@docker_error\nCannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n");
        assert_eq!(parse_docker(&stopped).status, "stopped");
        let stopped_29 = sections("@docker_error\nfailed to connect to the docker API at unix:///var/run/docker.sock; check if the path is correct and if the daemon is running: dial unix /var/run/docker.sock: connect: no such file or directory\n");
        assert_eq!(parse_docker(&stopped_29).status, "stopped");
    }

    #[test]
    fn puts_a_scan_together() {
        let text = format!(
            "@os\nUbuntu 24.04 LTS\n@ss\n{}\n{}\n{}\n@procs\n/usr/lib/postgresql/16/bin/postgres -D /var/lib/postgresql/16/main -c config_file=/etc/postgresql/16/main/postgresql.conf\n@pgclusters\n16  main    5432 online postgres /var/lib/postgresql/16/main /var/log/postgresql/postgresql-16-main.log\n{DOCKER}",
            "LISTEN 0 244 127.0.0.1:5432 0.0.0.0:*",
            "LISTEN 0 244 [::1]:5432 [::]:*",
            "LISTEN 0 4096 0.0.0.0:5433 0.0.0.0:*",
        );
        let r = parse_scan(&text);
        assert_eq!(r.os, "Ubuntu 24.04 LTS");
        // 5433 belongs to the container, so only the host's own server is listed.
        assert_eq!(r.databases.len(), 1);
        let pg = &r.databases[0];
        assert_eq!((pg.kind.as_str(), pg.port, pg.address.as_str()), ("postgresql", 5432, "127.0.0.1"));
        assert_eq!(pg.version.as_deref(), Some("16"));
        assert_eq!(pg.detail.as_deref(), Some("cluster main · /var/lib/postgresql/16/main"));
        assert_eq!(r.docker.containers.len(), 3);
    }

    #[test]
    fn version_from_postgres_process_without_clusters() {
        let text = "@proctcp\n   0: 00000000:1538 00000000:0000 0A 0\n@procs\n/usr/lib/postgresql/16/bin/postgres -D /home/user/.pgdata -p 5432\n@pgclusters\n16 main 5432 down postgres /var/lib/postgresql/16/main /var/log/x.log\n";
        let r = parse_scan(text);
        assert_eq!(r.databases[0].version.as_deref(), Some("16"));
        assert_eq!(r.databases[0].detail.as_deref(), Some("/home/user/.pgdata"));
        assert_eq!(r.databases[0].address, "");
    }

    #[test]
    fn container_actions_are_checked() {
        assert_eq!(docker_command("docker", "stop", "shop-db").unwrap(), "docker stop shop-db 2>&1");
        assert!(docker_command("docker", "rm", "x").is_err());
        assert!(docker_command("docker", "stop", "x; rm -rf /").is_err());
        assert!(docker_command("bash -c", "stop", "x").is_err());
    }

    #[test]
    fn image_kinds() {
        assert_eq!(kind_of_image("timescale/timescaledb-ha:pg16").unwrap().0, "postgresql");
        assert_eq!(kind_of_image("mcr.microsoft.com/mssql/server:2022-latest").unwrap().0, "sqlserver");
        assert_eq!(kind_of_image("bitnami/mariadb").unwrap().0, "mariadb");
        assert!(kind_of_image("nginx").is_none());
    }
}
