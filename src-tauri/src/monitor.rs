//! Background monitoring of SSH hosts: every few minutes one short command
//! reads disks, memory, failed systemd units, containers, PM2 apps and (less
//! often) the TLS certificates the server serves. Problems that appear raise
//! alerts (and desktop notifications); problems that go away are noted too.
//!
//! This file holds the check script, its parsing and the rules that turn a
//! check into problems; lib.rs runs the checks on a timer.

use crate::discover::sections;
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

/// How often certificates are looked at (they change slowly and the check
/// makes TLS connections).
pub const CERT_EVERY_SECS: u64 = 6 * 3600;

const CHECK_SCRIPT: &str = r#"export LC_ALL=C
echo @now; date +%s
echo @df; df -P -k 2>/dev/null
echo @mem; grep -E '^(MemTotal|MemAvailable):' /proc/meminfo 2>/dev/null
echo @failed; systemctl --failed --no-legend --plain 2>/dev/null | awk '{print $1}'
D=
for c in docker podman; do command -v $c >/dev/null 2>&1 && $c ps -q >/dev/null 2>&1 && { D=$c; break; }; done
[ -z "$D" ] && command -v docker >/dev/null 2>&1 && sudo -n docker ps -q >/dev/null 2>&1 && D="sudo -n docker"
if [ -n "$D" ]; then echo @containers; $D ps -a --format '{{.Names}}|{{.State}}|{{.Status}}' 2>/dev/null; fi"#;

/// Domains from nginx/Caddy configs, and the expiry of the certificate this
/// server presents for each (asked on 127.0.0.1:443, so DNS doesn't matter).
const CERT_SCRIPT: &str = r#"echo @certs
for d in $( (sed -n 's/^[[:space:]]*server_name[[:space:]]\{1,\}\([^;]*\);.*/\1/p' /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf 2>/dev/null; sed -n 's/^\([A-Za-z0-9.,: -]*\)[[:space:]]*{[[:space:]]*$/\1/p' /etc/caddy/Caddyfile 2>/dev/null) | tr ' ,' '\n\n' | sed 's/:.*//' | grep -E '^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$' | sort -u | head -n 20); do
  e=$(echo | timeout 5 openssl s_client -servername "$d" -connect 127.0.0.1:443 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
  [ -n "$e" ] && echo "$d|$(date -d "$e" +%s 2>/dev/null)"
done"#;

pub fn script(with_certs: bool) -> String {
    let mut s = format!("{CHECK_SCRIPT}\n{}", crate::pm2::list_script());
    if with_certs {
        s.push('\n');
        s.push_str(CERT_SCRIPT);
    }
    s.push_str("\nexit 0");
    s
}

// ---- what a check finds ----

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiskUse {
    pub mount: String,
    pub percent: u8,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Cert {
    pub domain: String,
    pub days_left: i64,
}

#[derive(Debug, Default, Clone)]
pub struct Check {
    pub now: u64,
    pub disks: Vec<DiskUse>,
    pub mem_percent: Option<u8>,
    pub failed_units: Vec<String>,
    /// name → state, None when Docker isn't usable.
    pub containers: Option<Vec<(String, String)>>,
    /// "name:id" → status, None when PM2 isn't running for the user.
    pub pm2: Option<Vec<(String, String)>>,
    /// None when certificates weren't looked at this time.
    pub certs: Option<Vec<Cert>>,
}

pub fn parse(text: &str) -> Check {
    let s = sections(text);
    let now = s.get("now").and_then(|l| l.first()).and_then(|v| v.trim().parse().ok()).unwrap_or(0);
    let disks = crate::stats::parse_df(s.get("df").map(Vec::as_slice).unwrap_or_default())
        .into_iter()
        .map(|d| DiskUse { percent: ((d.used as f64 / d.size as f64) * 100.0).round().min(100.0) as u8, mount: d.mount })
        .collect();
    let mut mem: HashMap<&str, u64> = HashMap::new();
    for l in s.get("mem").into_iter().flatten() {
        if let Some((k, v)) = l.split_once(':') {
            if let Some(n) = v.split_whitespace().next().and_then(|n| n.parse().ok()) {
                mem.insert(k.trim(), n);
            }
        }
    }
    let mem_percent = match (mem.get("MemTotal"), mem.get("MemAvailable")) {
        (Some(&t), Some(&a)) if t > 0 => Some((((t - a.min(t)) as f64 / t as f64) * 100.0).round() as u8),
        _ => None,
    };
    let failed_units = s
        .get("failed")
        .into_iter()
        .flatten()
        .map(|u| u.trim().trim_start_matches('●').trim().to_string())
        .filter(|u| !u.is_empty())
        .collect();
    let containers = s.get("containers").map(|l| {
        l.iter()
            .filter_map(|x| {
                let mut f = x.split('|');
                Some((f.next()?.to_string(), f.next()?.to_lowercase()))
            })
            .collect()
    });
    let pm2 = crate::pm2::parse(&s);
    let pm2 = (pm2.status == "ok")
        .then(|| pm2.processes.iter().map(|p| (format!("{}:{}", p.name, p.id), p.status.clone())).collect());
    let certs = s.get("certs").map(|l| {
        l.iter()
            .filter_map(|x| {
                let (d, t) = x.split_once('|')?;
                let t: i64 = t.trim().parse().ok()?;
                Some(Cert { domain: d.to_string(), days_left: (t - now as i64).div_euclid(86_400) })
            })
            .collect()
    });
    Check { now, disks, mem_percent, failed_units, containers, pm2, certs }
}

// ---- problems ----

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    /// Stable id, e.g. "disk:/" or "pm2:api:0".
    pub key: String,
    /// warning | critical
    pub severity: String,
    pub message: String,
    /// When it was first seen (seconds since the epoch).
    pub since: u64,
}

/// What earlier checks of a host remember.
#[derive(Default, Debug)]
pub struct Memory {
    /// PM2 apps and containers seen running, so stopping one is noticed.
    pub pm2_up: HashSet<String>,
    pub containers_up: HashSet<String>,
    pub certs: Vec<Cert>,
    pub certs_at: u64,
}

fn problem(key: String, severity: &str, message: String) -> Problem {
    Problem { key, severity: severity.into(), message, since: 0 }
}

/// Turns a check into the host's current problems.
pub fn evaluate(c: &Check, mem: &mut Memory, disk_threshold: u8) -> Vec<Problem> {
    let mut out = Vec::new();
    for d in &c.disks {
        if d.percent >= disk_threshold {
            let sev = if d.percent >= 97.max(disk_threshold) { "critical" } else { "warning" };
            out.push(problem(format!("disk:{}", d.mount), sev, format!("Disk {} is {}% full", d.mount, d.percent)));
        }
    }
    if let Some(m) = c.mem_percent.filter(|&m| m >= 95) {
        out.push(problem("mem".into(), "warning", format!("Memory is {m}% used")));
    }
    for u in &c.failed_units {
        out.push(problem(format!("unit:{u}"), "warning", format!("Service {u} has failed")));
    }
    if let Some(list) = &c.containers {
        let names: HashSet<&str> = list.iter().map(|(n, _)| n.as_str()).collect();
        mem.containers_up.retain(|n| names.contains(n.as_str()));
        for (name, state) in list {
            match state.as_str() {
                "running" => {
                    mem.containers_up.insert(name.clone());
                }
                "restarting" => out.push(problem(format!("container:{name}"), "critical", format!("Container {name} keeps restarting"))),
                _ if mem.containers_up.contains(name) => {
                    out.push(problem(format!("container:{name}"), "critical", format!("Container {name} stopped ({state})")))
                }
                _ => {}
            }
        }
    }
    if let Some(list) = &c.pm2 {
        let keys: HashSet<&str> = list.iter().map(|(k, _)| k.as_str()).collect();
        // Deleted apps are no longer expected to run.
        mem.pm2_up.retain(|k| keys.contains(k.as_str()));
        for (key, status) in list {
            let name = key.rsplit_once(':').map(|(n, _)| n).unwrap_or(key);
            match status.as_str() {
                "online" => {
                    mem.pm2_up.insert(key.clone());
                }
                "errored" => out.push(problem(format!("pm2:{key}"), "critical", format!("PM2 app {name} has crashed (errored)"))),
                _ if mem.pm2_up.contains(key) => {
                    out.push(problem(format!("pm2:{key}"), "critical", format!("PM2 app {name} is {status}")))
                }
                _ => {}
            }
        }
    }
    if let Some(certs) = &c.certs {
        mem.certs = certs.clone();
        mem.certs_at = c.now;
    }
    for cert in &mem.certs {
        let msg = match cert.days_left {
            d if d < 0 => Some(("critical", format!("Certificate for {} has expired", cert.domain))),
            d if d < 3 => Some(("critical", format!("Certificate for {} expires in {} day{}", cert.domain, d, if d == 1 { "" } else { "s" }))),
            d if d < 14 => Some(("warning", format!("Certificate for {} expires in {d} days", cert.domain))),
            _ => None,
        };
        if let Some((sev, m)) = msg {
            out.push(problem(format!("cert:{}", cert.domain), sev, m));
        }
    }
    out
}

// ---- host status and alerts ----

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct HostStatus {
    pub host_id: String,
    pub checked_at: Option<u64>,
    pub checking: bool,
    /// None until the first check.
    pub reachable: Option<bool>,
    pub error: Option<String>,
    pub problems: Vec<Problem>,
    pub disks: Vec<DiskUse>,
    pub mem_percent: Option<u8>,
    /// (online, total) when PM2 runs; (running, total) when Docker is usable.
    pub pm2: Option<(usize, usize)>,
    pub containers: Option<(usize, usize)>,
    pub certs: Vec<Cert>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Alert {
    pub id: u64,
    pub at: u64,
    pub host_id: String,
    pub host_name: String,
    pub severity: String,
    pub message: String,
    /// A problem that went away.
    pub resolved: bool,
}

#[derive(Default)]
struct Host {
    status: HostStatus,
    memory: Memory,
    failures: u32,
}

#[derive(Default)]
pub struct Monitor {
    hosts: Mutex<HashMap<String, Host>>,
    alerts: Mutex<VecDeque<Alert>>,
    next_id: AtomicU64,
    pub wake: tokio::sync::Notify,
}

pub fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

impl Monitor {
    pub fn statuses(&self) -> Vec<HostStatus> {
        self.hosts.lock().unwrap().values().map(|h| h.status.clone()).collect()
    }

    pub fn alerts(&self) -> Vec<Alert> {
        self.alerts.lock().unwrap().iter().cloned().collect()
    }

    pub fn clear_alerts(&self) {
        self.alerts.lock().unwrap().clear();
    }

    pub fn forget(&self, host_id: &str) {
        self.hosts.lock().unwrap().remove(host_id);
    }

    /// Hosts whose last check is older than `interval` (or never ran).
    pub fn due(&self, hosts: &[String], interval: u64) -> Vec<String> {
        let map = self.hosts.lock().unwrap();
        let t = now();
        hosts
            .iter()
            .filter(|id| match map.get(*id) {
                Some(h) => !h.status.checking && h.status.checked_at.is_none_or(|c| t.saturating_sub(c) + 5 >= interval),
                None => true,
            })
            .cloned()
            .collect()
    }

    /// Marks a host as being checked; returns whether certificates are due.
    pub fn begin(&self, host_id: &str) -> bool {
        let mut map = self.hosts.lock().unwrap();
        let h = map.entry(host_id.to_string()).or_default();
        h.status.host_id = host_id.to_string();
        h.status.checking = true;
        now().saturating_sub(h.memory.certs_at) >= CERT_EVERY_SECS
    }

    /// Records a check (or the error that stopped it) and returns the alerts
    /// it raised: new problems, and problems that went away.
    pub fn finish(&self, host_id: &str, host_name: &str, result: Result<Check, String>, disk_threshold: u8) -> Vec<Alert> {
        let mut map = self.hosts.lock().unwrap();
        let h = map.entry(host_id.to_string()).or_default();
        let before = h.status.problems.clone();
        h.status.checking = false;
        h.status.checked_at = Some(now());
        let mut problems = match result {
            Ok(check) => {
                h.failures = 0;
                h.status.reachable = Some(true);
                h.status.error = None;
                h.status.disks = check.disks.clone();
                h.status.mem_percent = check.mem_percent;
                h.status.pm2 = check.pm2.as_ref().map(|l| (l.iter().filter(|(_, s)| s == "online").count(), l.len()));
                h.status.containers =
                    check.containers.as_ref().map(|l| (l.iter().filter(|(_, s)| s == "running").count(), l.len()));
                let p = evaluate(&check, &mut h.memory, disk_threshold);
                h.status.certs = h.memory.certs.clone();
                p
            }
            Err(e) => {
                h.failures += 1;
                h.status.error = Some(e.clone());
                // One failed check can be a blip; two in a row is an outage.
                if h.failures >= 2 {
                    h.status.reachable = Some(false);
                    let mut p: Vec<Problem> = before.iter().filter(|p| p.key != "unreachable").cloned().collect();
                    p.push(problem("unreachable".into(), "critical", format!("Can't reach the server: {e}")));
                    p
                } else {
                    before.clone()
                }
            }
        };
        // Keep when each problem started.
        for p in &mut problems {
            p.since = before.iter().find(|b| b.key == p.key).map(|b| b.since).unwrap_or_else(now);
        }
        let mut alerts = Vec::new();
        let mut push = |p: &Problem, resolved: bool| {
            alerts.push(Alert {
                id: self.next_id.fetch_add(1, Ordering::Relaxed) + 1,
                at: now(),
                host_id: host_id.to_string(),
                host_name: host_name.to_string(),
                severity: if resolved { "ok".into() } else { p.severity.clone() },
                message: if resolved {
                    match p.key.as_str() {
                        "unreachable" => "Reachable again".to_string(),
                        _ => format!("Resolved: {}", p.message),
                    }
                } else {
                    p.message.clone()
                },
                resolved,
            });
        };
        for p in problems.iter().filter(|p| !before.iter().any(|b| b.key == p.key)) {
            push(p, false);
        }
        for b in before.iter().filter(|b| !problems.iter().any(|p| p.key == b.key)) {
            push(b, true);
        }
        h.status.problems = problems;
        drop(map);
        let mut list = self.alerts.lock().unwrap();
        for a in &alerts {
            list.push_front(a.clone());
        }
        list.truncate(300);
        alerts
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(text: &str) -> Check {
        parse(text)
    }

    const SAMPLE: &str = "@now
1800000000
@df
Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/sda1 1000 930 70 93% /
/dev/sdb1 1000 400 600 40% /data
@mem
MemTotal:  1000000 kB
MemAvailable: 30000 kB
@failed
nginx.service
@containers
web|running|Up 2 hours
db|exited|Exited (1) 3 seconds ago
@pm2_now
1800000000
@pm2_jlist
[{\"name\":\"api\",\"pm_id\":0,\"pm2_env\":{\"status\":\"online\"}},{\"name\":\"worker\",\"pm_id\":1,\"pm2_env\":{\"status\":\"errored\"}}]
@certs
example.com|1800432000
old.example.com|1799900000
fine.example.com|1810000000
";

    #[test]
    fn parses_a_check() {
        let c = check(SAMPLE);
        assert_eq!(c.now, 1800000000);
        assert_eq!(c.disks, [DiskUse { mount: "/".into(), percent: 93 }, DiskUse { mount: "/data".into(), percent: 40 }]);
        assert_eq!(c.mem_percent, Some(97));
        assert_eq!(c.failed_units, ["nginx.service"]);
        assert_eq!(c.containers.as_ref().unwrap().len(), 2);
        assert_eq!(c.pm2.as_ref().unwrap(), &[("api:0".to_string(), "online".to_string()), ("worker:1".to_string(), "errored".to_string())]);
        let certs = c.certs.unwrap();
        assert_eq!(certs[0], Cert { domain: "example.com".into(), days_left: 5 });
        assert_eq!(certs[1].days_left, -2);
    }

    #[test]
    fn turns_a_check_into_problems() {
        let mut mem = Memory::default();
        let p = evaluate(&check(SAMPLE), &mut mem, 90);
        let keys: Vec<&str> = p.iter().map(|p| p.key.as_str()).collect();
        assert_eq!(
            keys,
            ["disk:/", "mem", "unit:nginx.service", "pm2:worker:1", "cert:example.com", "cert:old.example.com"]
        );
        // db was never seen running, so its being stopped isn't news.
        assert!(!keys.contains(&"container:db"));
        assert_eq!(p[0].severity, "warning");
        assert_eq!(p[5].message, "Certificate for old.example.com has expired");
    }

    #[test]
    fn notices_things_that_stop() {
        let mut mem = Memory::default();
        let up = "@now\n1\n@containers\nweb|running|Up\n@pm2_jlist\n[{\"name\":\"api\",\"pm_id\":0,\"pm2_env\":{\"status\":\"online\"}}]\n";
        assert!(evaluate(&check(up), &mut mem, 90).is_empty());
        let down = "@now\n2\n@containers\nweb|exited|Exited (137)\n@pm2_jlist\n[{\"name\":\"api\",\"pm_id\":0,\"pm2_env\":{\"status\":\"stopped\"}}]\n";
        let p = evaluate(&check(down), &mut mem, 90);
        assert_eq!(p.iter().map(|p| p.message.as_str()).collect::<Vec<_>>(), ["Container web stopped (exited)", "PM2 app api is stopped"]);
        // Deleting the app clears the expectation.
        let gone = "@now\n3\n@containers\nweb|running|Up\n@pm2_jlist\n[]\n";
        assert!(evaluate(&check(gone), &mut mem, 90).is_empty());
    }

    #[test]
    fn alerts_on_changes_and_outages() {
        let m = Monitor::default();
        m.begin("h");
        let a = m.finish("h", "web-01", Ok(check(SAMPLE)), 90);
        assert_eq!(a.len(), 6);
        assert!(a.iter().all(|a| !a.resolved));
        // Same problems again: nothing new.
        m.begin("h");
        assert!(m.finish("h", "web-01", Ok(check(SAMPLE)), 90).is_empty());
        // One failed check is tolerated; the second is an outage.
        m.begin("h");
        assert!(m.finish("h", "web-01", Err("timed out".into()), 90).is_empty());
        m.begin("h");
        let a = m.finish("h", "web-01", Err("timed out".into()), 90);
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].message, "Can't reach the server: timed out");
        // Back, and the disk got cleaned up.
        let fixed = SAMPLE.replace("/dev/sda1 1000 930 70 93% /", "/dev/sda1 1000 500 500 50% /");
        m.begin("h");
        let a = m.finish("h", "web-01", Ok(check(&fixed)), 90);
        let msgs: Vec<&str> = a.iter().map(|a| a.message.as_str()).collect();
        assert!(msgs.contains(&"Reachable again"), "{msgs:?}");
        assert!(msgs.contains(&"Resolved: Disk / is 93% full"), "{msgs:?}");
        assert_eq!(m.alerts().len(), 6 + 1 + 2);
    }

    #[test]
    fn due_respects_the_interval() {
        let m = Monitor::default();
        let hosts = vec!["a".to_string()];
        assert_eq!(m.due(&hosts, 300), hosts);
        m.begin("a");
        assert!(m.due(&hosts, 300).is_empty(), "a check is already running");
        m.finish("a", "a", Ok(Check::default()), 90);
        assert!(m.due(&hosts, 300).is_empty());
    }
}
