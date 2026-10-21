//! Server performance stats for SSH terminals, read over the terminal's own
//! connection on a separate exec channel (Linux servers: /proc, df, who).
//!
//! Counters are returned raw (CPU jiffies, network byte totals); the UI turns
//! consecutive samples into percentages and rates.

use crate::error::{AppError, AppResult};
use crate::sftp::exec_capture;
use crate::ssh::Connection;
use serde::Serialize;
use std::collections::HashMap;

#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Disk {
    pub mount: String,
    pub filesystem: String,
    pub size: u64,
    pub used: u64,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// Busy and total CPU time over all cores since boot, in jiffies.
    pub cpu_busy: u64,
    pub cpu_total: u64,
    pub cores: u32,
    pub mem_total: u64,
    pub mem_available: u64,
    pub swap_total: u64,
    pub swap_free: u64,
    pub load: [f64; 3],
    pub uptime: f64,
    /// Bytes received / sent on all interfaces but loopback, since boot.
    pub net_rx: u64,
    pub net_tx: u64,
    pub disks: Vec<Disk>,
    pub users: u32,
    pub hostname: String,
    pub os: String,
}

const SNAPSHOT_CMD: &str = r#"export LC_ALL=C
[ -r /proc/stat ] || exit 3
echo @cpu; head -n 1 /proc/stat
echo @mem; cat /proc/meminfo
echo @load; cat /proc/loadavg
echo @up; cat /proc/uptime
echo @net; cat /proc/net/dev
echo @df; df -P -k 2>/dev/null
echo @users; who 2>/dev/null | wc -l
echo @cores; nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo
echo @host; hostname 2>/dev/null || cat /proc/sys/kernel/hostname
echo @os; (. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") || uname -sr"#;

fn unsupported() -> AppError {
    AppError::kind("STATS_UNSUPPORTED", "Performance stats need a Linux server")
}

pub async fn snapshot(conn: &Connection) -> AppResult<Snapshot> {
    let (out, status) = exec_capture(conn, &crate::ssh::posix(SNAPSHOT_CMD)).await?;
    if status == Some(3) {
        return Err(unsupported());
    }
    parse_snapshot(&out).ok_or_else(unsupported)
}

/// Splits "@name" sections.
fn sections(text: &str) -> HashMap<&str, Vec<&str>> {
    let mut out: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut current = "";
    for line in text.lines() {
        if let Some(name) = line.strip_prefix('@') {
            current = name.trim();
            out.entry(current).or_default();
        } else if !current.is_empty() {
            out.entry(current).or_default().push(line);
        }
    }
    out
}

fn parse_snapshot(text: &str) -> Option<Snapshot> {
    let s = sections(text);
    let mut snap = Snapshot::default();

    // cpu  user nice system idle iowait irq softirq steal guest guest_nice
    let cpu: Vec<u64> = s.get("cpu")?.first()?.split_whitespace().skip(1).filter_map(|v| v.parse().ok()).collect();
    if cpu.len() < 4 {
        return None;
    }
    // guest time is already counted in user; idle + iowait is not busy.
    let total: u64 = cpu.iter().take(8).sum();
    let idle = cpu[3] + cpu.get(4).copied().unwrap_or(0);
    snap.cpu_total = total;
    snap.cpu_busy = total.saturating_sub(idle);

    let mut mem: HashMap<&str, u64> = HashMap::new();
    for line in s.get("mem").into_iter().flatten() {
        if let Some((k, v)) = line.split_once(':') {
            if let Some(n) = v.split_whitespace().next().and_then(|n| n.parse::<u64>().ok()) {
                mem.insert(k.trim(), n * 1024);
            }
        }
    }
    snap.mem_total = *mem.get("MemTotal")?;
    // Kernels before 3.14 have no MemAvailable.
    snap.mem_available = mem.get("MemAvailable").copied().unwrap_or_else(|| {
        ["MemFree", "Buffers", "Cached"].iter().filter_map(|k| mem.get(k)).sum()
    });
    snap.swap_total = mem.get("SwapTotal").copied().unwrap_or(0);
    snap.swap_free = mem.get("SwapFree").copied().unwrap_or(0);

    if let Some(line) = s.get("load").and_then(|l| l.first()) {
        let v: Vec<f64> = line.split_whitespace().take(3).filter_map(|x| x.parse().ok()).collect();
        if v.len() == 3 {
            snap.load = [v[0], v[1], v[2]];
        }
    }
    snap.uptime = s
        .get("up")
        .and_then(|l| l.first())
        .and_then(|l| l.split_whitespace().next())
        .and_then(|v| v.parse().ok())
        .unwrap_or(0.0);

    // "  eth0: rx_bytes packets ... (8 fields) tx_bytes ..."
    for line in s.get("net").into_iter().flatten() {
        let Some((iface, rest)) = line.split_once(':') else { continue };
        if iface.trim() == "lo" {
            continue;
        }
        let f: Vec<u64> = rest.split_whitespace().filter_map(|v| v.parse().ok()).collect();
        if f.len() >= 9 {
            snap.net_rx += f[0];
            snap.net_tx += f[8];
        }
    }

    snap.disks = parse_df(s.get("df").map(Vec::as_slice).unwrap_or_default());
    snap.users = s.get("users").and_then(|l| l.first()).and_then(|v| v.trim().parse().ok()).unwrap_or(0);
    snap.cores = s.get("cores").and_then(|l| l.first()).and_then(|v| v.trim().parse().ok()).unwrap_or(1).max(1);
    snap.hostname = s.get("host").and_then(|l| l.first()).map(|h| h.trim().to_string()).unwrap_or_default();
    snap.os = s.get("os").and_then(|l| l.first()).map(|h| h.trim().to_string()).unwrap_or_default();
    Some(snap)
}

/// Real disks from `df -P -k`: block devices plus the root filesystem, each
/// device once (bind mounts repeat it).
fn parse_df(lines: &[&str]) -> Vec<Disk> {
    let mut disks: Vec<Disk> = Vec::new();
    for line in lines.iter().skip(1) {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 6 {
            continue;
        }
        let (fs, mount) = (f[0], f[5..].join(" "));
        let real = fs.starts_with("/dev/") && !fs.starts_with("/dev/loop");
        if !(real || mount == "/") {
            continue;
        }
        let (Ok(size), Ok(used)) = (f[1].parse::<u64>(), f[2].parse::<u64>()) else { continue };
        if size == 0 {
            continue;
        }
        let disk = Disk { mount, filesystem: fs.to_string(), size: size * 1024, used: used * 1024 };
        match disks.iter_mut().find(|d| d.filesystem == disk.filesystem && fs != "overlay") {
            Some(existing) if disk.mount.len() < existing.mount.len() => *existing = disk,
            Some(_) => {}
            None => disks.push(disk),
        }
    }
    // Root first, then by mount point.
    disks.sort_by(|a, b| (a.mount != "/", &a.mount).cmp(&(b.mount != "/", &b.mount)));
    disks
}

// ---- processes ----

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Process {
    pub pid: u32,
    pub user: String,
    /// CPU time used since the process started, in jiffies.
    pub ticks: u64,
    pub rss: u64,
    pub command: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Processes {
    pub cpu_total: u64,
    pub list: Vec<Process>,
}

const PROCESSES_CMD: &str = r#"export LC_ALL=C
[ -r /proc/stat ] || exit 3
echo @cpu; head -n 1 /proc/stat
echo @stat; cat /proc/[0-9]*/stat 2>/dev/null
echo @ps; ps -eo pid=,user=,rss=,args= 2>/dev/null | cut -c1-300"#;

pub async fn processes(conn: &Connection) -> AppResult<Processes> {
    let (out, status) = exec_capture(conn, &crate::ssh::posix(PROCESSES_CMD)).await?;
    if status == Some(3) {
        return Err(unsupported());
    }
    parse_processes(&out).ok_or_else(unsupported)
}

fn parse_processes(text: &str) -> Option<Processes> {
    let s = sections(text);
    let cpu_total = s
        .get("cpu")?
        .first()?
        .split_whitespace()
        .skip(1)
        .take(8)
        .filter_map(|v| v.parse::<u64>().ok())
        .sum();

    // pid (comm) state ppid ... utime(14) stime(15); comm may hold spaces and ')'.
    let mut ticks: HashMap<u32, (u64, String)> = HashMap::new();
    for line in s.get("stat").into_iter().flatten() {
        let (Some(open), Some(close)) = (line.find('('), line.rfind(')')) else { continue };
        let Ok(pid) = line[..open].trim().parse::<u32>() else { continue };
        let comm = line[open + 1..close].to_string();
        let rest: Vec<&str> = line[close + 1..].split_whitespace().collect();
        // rest[0] is field 3 (state), so utime/stime are rest[11] and rest[12].
        let (Some(u), Some(st)) = (rest.get(11), rest.get(12)) else { continue };
        let t = u.parse::<u64>().unwrap_or(0) + st.parse::<u64>().unwrap_or(0);
        ticks.insert(pid, (t, comm));
    }

    let mut list = Vec::new();
    for line in s.get("ps").into_iter().flatten() {
        let mut f = line.split_whitespace();
        let (Some(pid), Some(user), Some(rss)) = (f.next(), f.next(), f.next()) else { continue };
        let Ok(pid) = pid.parse::<u32>() else { continue };
        let args = f.collect::<Vec<_>>().join(" ");
        let (t, comm) = ticks.remove(&pid).unwrap_or_default();
        list.push(Process {
            pid,
            user: user.to_string(),
            ticks: t,
            rss: rss.parse::<u64>().unwrap_or(0) * 1024,
            command: if args.is_empty() { comm } else { args },
        });
    }
    Some(Processes { cpu_total, list })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "@cpu
cpu  4705 356 584 3699176 23060 0 277 0 0 0
@mem
MemTotal:        8037888 kB
MemFree:          512000 kB
MemAvailable:    4018944 kB
SwapTotal:       2097148 kB
SwapFree:        2097148 kB
@load
0.52 0.40 0.31 1/245 12345
@up
1036800.55 2000000.00
@net
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 9999999   100    0    0    0     0          0         0  9999999   100    0    0    0     0       0          0
  eth0: 1000000   200    0    0    0     0          0         0   500000   150    0    0    0     0       0          0
  eth1:     2000     2    0    0    0     0          0         0     1000     1    0    0    0     0       0          0
@df
Filesystem     1024-blocks     Used Available Capacity Mounted on
/dev/sda1         51474912 20971520  28000000      43% /
tmpfs              4018944        0   4018944       0% /dev/shm
/dev/sdb1        103081248 10485760  87000000      11% /mnt/data disk
/dev/sdb1        103081248 10485760  87000000      11% /mnt/data disk/bind
/dev/loop0           65536    65536         0     100% /snap/core/1
@users
2
@cores
4
@host
web-01
@os
Ubuntu 24.04 LTS
";

    #[test]
    fn parses_a_snapshot() {
        let s = parse_snapshot(SAMPLE).unwrap();
        assert_eq!(s.cpu_total, 4705 + 356 + 584 + 3699176 + 23060 + 277);
        assert_eq!(s.cpu_busy, 4705 + 356 + 584 + 277);
        assert_eq!(s.mem_total, 8037888 * 1024);
        assert_eq!(s.mem_available, 4018944 * 1024);
        assert_eq!(s.swap_total, s.swap_free);
        assert_eq!(s.load, [0.52, 0.40, 0.31]);
        assert_eq!(s.uptime, 1036800.55);
        assert_eq!((s.net_rx, s.net_tx), (1002000, 501000));
        assert_eq!(s.users, 2);
        assert_eq!(s.cores, 4);
        assert_eq!(s.hostname, "web-01");
        assert_eq!(s.os, "Ubuntu 24.04 LTS");
        let mounts: Vec<&str> = s.disks.iter().map(|d| d.mount.as_str()).collect();
        assert_eq!(mounts, ["/", "/mnt/data disk"]);
        assert_eq!(s.disks[0].used, 20971520 * 1024);
    }

    #[test]
    fn overlay_root_counts_as_a_disk() {
        let df = ["Filesystem 1024-blocks Used Available Capacity Mounted on", "overlay 1000 500 500 50% /"];
        assert_eq!(parse_df(&df).len(), 1);
    }

    #[test]
    fn rejects_non_linux_output() {
        assert!(parse_snapshot("").is_none());
        assert!(parse_snapshot("@cpu\n@mem\n").is_none());
    }

    #[test]
    fn parses_processes() {
        let text = "@cpu
cpu  100 0 100 800 0 0 0 0 0 0
@stat
1 (systemd) S 0 1 1 0 -1 4194560 1 1 0 0 120 80 0 0 20 0 1 0 1 1 1
42 (my (odd) prog) R 1 42 42 0 -1 0 0 0 0 0 7 3 0 0 20 0 1 0 1 1 1
@ps
      1 root      9000 /sbin/init splash
     42 tester    2048 ./my (odd) prog --flag
";
        let p = parse_processes(text).unwrap();
        assert_eq!(p.cpu_total, 1000);
        assert_eq!(p.list[0], Process { pid: 1, user: "root".into(), ticks: 200, rss: 9000 * 1024, command: "/sbin/init splash".into() });
        assert_eq!(p.list[1].ticks, 10);
        assert_eq!(p.list[1].command, "./my (odd) prog --flag");
    }
}
