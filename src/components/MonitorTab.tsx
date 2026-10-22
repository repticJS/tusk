import { AlertTriangle, BellRing, CheckCircle2, CircleAlert, RefreshCw, TerminalSquare, Trash2, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { monitorApi, type MonitorHost, type MonitorProblem, type SshHost } from "../lib/api";
import { fmtDuration } from "../lib/format";
import { useApp, type MonitorTab as MonitorTabModel } from "../store";
import { Meter } from "./ServerStats";
import { Spinner } from "./ui";

const INTERVALS = [60, 120, 300, 600, 900, 1800, 3600];

function ago(secs?: number | null) {
  if (!secs) return "never";
  const d = Date.now() / 1000 - secs;
  return d < 45 ? "just now" : `${fmtDuration(d)} ago`;
}

export function SeverityIcon({ severity, size = 13 }: { severity: string; size?: number }) {
  if (severity === "critical") return <XCircle size={size} className="shrink-0 text-danger" />;
  if (severity === "warning") return <AlertTriangle size={size} className="shrink-0 text-warn" />;
  return <CheckCircle2 size={size} className="shrink-0 text-ok" />;
}

export function MonitorTab({ active }: { tab: MonitorTabModel; active: boolean }) {
  const monitor = useApp((s) => s.monitor);
  const hosts = useApp((s) => s.sshHosts);
  const { saveMonitor, setMonitored } = useApp.getState();
  // Relative times ("2 min ago") tick along while visible.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, [active]);

  if (!monitor) {
    return (
      <div className="flex items-center gap-2 p-6 text-[13px] text-muted">
        <Spinner size={12} /> Loading…
      </div>
    );
  }
  const { settings } = monitor;
  const watched = hosts.filter((h) => settings.hosts.includes(h.id));
  const others = hosts.filter((h) => !settings.hosts.includes(h.id));

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto flex max-w-[1000px] flex-col gap-4 p-6">
        <div>
          <div className="text-[17px] font-semibold tracking-tight">Monitoring</div>
          <div className="text-[12.5px] text-muted">
            Tusk checks the servers you pick while it's open: full disks, memory, failed services, crashed PM2 apps and
            containers, expiring certificates, and servers that stop answering.
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-border bg-panel px-4 py-2.5 text-[12.5px]">
          <label className="flex items-center gap-2">
            Check every
            <select
              className="field h-7 w-auto py-0"
              value={settings.intervalSecs}
              aria-label="Check every"
              onChange={(e) => void saveMonitor({ intervalSecs: Number(e.target.value) })}
            >
              {INTERVALS.map((s) => (
                <option key={s} value={s}>
                  {s < 3600 ? `${s / 60} min` : "1 hour"}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2">
            Warn when a disk is
            <select
              className="field h-7 w-auto py-0"
              value={settings.diskThreshold}
              aria-label="Disk threshold"
              onChange={(e) => void saveMonitor({ diskThreshold: Number(e.target.value) })}
            >
              {[75, 80, 85, 90, 95].map((p) => (
                <option key={p} value={p}>
                  {p}% full
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={settings.notify} onChange={(e) => void saveMonitor({ notify: e.target.checked })} />
            Windows notifications
          </label>
        </div>

        {hosts.length === 0 && (
          <div className="rounded-lg border border-dashed border-border p-5 text-[13px] text-muted">
            Add an SSH host first, then turn monitoring on for it here.
          </div>
        )}

        {watched.map((h) => (
          <HostCard key={h.id} host={h} status={monitor.hosts.find((x) => x.hostId === h.id)} onStop={() => void setMonitored(h.id, false)} />
        ))}

        {others.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <div className="text-[11px] font-semibold tracking-wide text-faint uppercase">Not monitored</div>
            <div className="flex flex-wrap gap-2">
              {others.map((h) => (
                <button key={h.id} className="btn-outline" onClick={() => void setMonitored(h.id, true)} aria-label={`Monitor ${h.name}`}>
                  <TerminalSquare size={12} style={{ color: h.color ?? undefined }} /> Monitor {h.name}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold tracking-wide text-faint uppercase">Recent alerts</span>
            <div className="flex-1" />
            {monitor.alerts.length > 0 && (
              <button className="btn-ghost h-6 px-1.5 text-[11.5px]" onClick={() => void monitorApi.clearAlerts()}>
                <Trash2 size={11} /> Clear
              </button>
            )}
          </div>
          <div className="overflow-hidden rounded-lg border border-border bg-panel" data-alerts>
            {monitor.alerts.length === 0 && <div className="px-4 py-3 text-[12.5px] text-faint">No alerts yet.</div>}
            {monitor.alerts.slice(0, 100).map((a) => (
              <div key={a.id} className="flex items-center gap-2.5 border-b border-border px-4 py-1.5 text-[12.5px] last:border-0" data-alert={a.message}>
                <SeverityIcon severity={a.severity} />
                <span className="w-24 shrink-0 truncate font-medium">{a.hostName}</span>
                <span className={`min-w-0 flex-1 truncate ${a.resolved ? "text-muted" : ""}`}>{a.message}</span>
                <span className="shrink-0 text-[11.5px] text-faint">{ago(a.at)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function HostCard({ host, status, onStop }: { host: SshHost; status?: MonitorHost; onStop: () => void }) {
  const [checking, setChecking] = useState(false);
  const problems = status?.problems ?? [];
  const worst = problems.some((p) => p.severity === "critical") ? "critical" : problems.length ? "warning" : "ok";
  const check = async () => {
    setChecking(true);
    await monitorApi.check(host.id).catch(() => {});
    setChecking(false);
  };
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-panel" data-monitor-host={host.name}>
      <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
        {!status?.checkedAt ? (
          <Spinner size={13} />
        ) : status.reachable === false ? (
          <XCircle size={15} className="text-danger" />
        ) : (
          <SeverityIcon severity={worst} size={15} />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-medium">{host.name}</div>
          <div className="truncate text-[11.5px] text-muted">
            {host.user}@{host.host} · checked {ago(status?.checkedAt)}
            {status?.memPercent != null && ` · memory ${status.memPercent}%`}
            {status?.pm2 && ` · PM2 ${status.pm2[0]}/${status.pm2[1]} online`}
            {status?.containers && ` · containers ${status.containers[0]}/${status.containers[1]} running`}
          </div>
        </div>
        <button className="btn-outline" onClick={() => void check()} disabled={checking || status?.checking} aria-label={`Check ${host.name} now`}>
          {checking || status?.checking ? <Spinner size={11} /> : <RefreshCw size={12} />} Check now
        </button>
        <button className="btn-ghost" onClick={onStop} title="Stop monitoring this host">
          Stop
        </button>
      </div>
      {status?.error && status.reachable !== false && (
        <div className="selectable border-b border-border px-4 py-1.5 text-[12px] text-warn">Last check failed: {status.error}</div>
      )}
      {problems.length > 0 ? (
        <div className="flex flex-col py-1" data-problems>
          {problems.map((p) => (
            <ProblemLine key={p.key} p={p} />
          ))}
        </div>
      ) : (
        status?.checkedAt && (
          <div className="flex items-center gap-2 px-4 py-2 text-[12.5px] text-ok">
            <CheckCircle2 size={13} /> All good
          </div>
        )
      )}
      {status && status.disks.length > 0 && (
        <div className="flex flex-wrap gap-x-5 gap-y-1 border-t border-border px-4 py-2 text-[11.5px] text-muted">
          {status.disks.map((d) => (
            <span key={d.mount} className="flex items-center gap-1.5">
              <span className="font-mono">{d.mount}</span> <Meter value={d.percent} width={60} /> {d.percent}%
            </span>
          ))}
          {status.certs.map((c) => (
            <span key={c.domain} className={c.daysLeft < 14 ? "text-warn" : ""}>
              🔒 {c.domain} · {c.daysLeft < 0 ? "expired" : `${c.daysLeft} days`}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function ProblemLine({ p }: { p: MonitorProblem }) {
  return (
    <div className="flex items-center gap-2.5 px-4 py-1 text-[12.5px]" data-problem={p.key}>
      <SeverityIcon severity={p.severity} />
      <span className="min-w-0 flex-1 truncate">{p.message}</span>
      <span className="shrink-0 text-[11.5px] text-faint">since {ago(p.since)}</span>
    </div>
  );
}

/** Status bar bell: how many problems the monitored hosts have. */
export function MonitorBell() {
  const counts = useApp(
    useShallow((s) => {
      const problems = (s.monitor?.hosts ?? []).flatMap((h) => h.problems);
      return {
        n: problems.length,
        critical: problems.some((p) => p.severity === "critical"),
        watching: (s.monitor?.settings.hosts.length ?? 0) > 0,
      };
    }),
  );
  if (!counts.watching) return null;
  return (
    <button
      className={`flex items-center gap-1 hover:text-text ${counts.n ? (counts.critical ? "text-danger" : "text-warn") : ""}`}
      title="Monitoring"
      aria-label="Monitoring"
      onClick={() => useApp.getState().openMonitorTab()}
      data-monitor-bell={counts.n}
    >
      {counts.n ? <CircleAlert size={11} /> : <BellRing size={11} className="text-ok" />}
      {counts.n ? `${counts.n} problem${counts.n === 1 ? "" : "s"}` : "All good"}
    </button>
  );
}
