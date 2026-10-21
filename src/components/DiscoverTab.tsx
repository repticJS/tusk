import {
  Box,
  Database,
  FileText,
  Monitor,
  Play,
  Plus,
  Radar,
  RotateCw,
  Square,
  SquareTerminal,
  TerminalSquare,
  Waypoints,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ContainerInfo, FoundDb, ScanResult, SshHost } from "../lib/api";
import { blankConnection, blankTunnel } from "../lib/defaults";
import { useApp, type DiscoverTab as DiscoverTabModel, type ScanState } from "../store";
import { Pm2Section } from "./Pm2Section";
import { Spinner } from "./ui";

export const DB_LABELS: Record<string, string> = {
  postgresql: "PostgreSQL",
  mysql: "MySQL",
  mariadb: "MariaDB",
  redis: "Redis",
  mongodb: "MongoDB",
  sqlserver: "SQL Server",
  elasticsearch: "Elasticsearch",
  memcached: "Memcached",
  cockroachdb: "CockroachDB",
  clickhouse: "ClickHouse",
  influxdb: "InfluxDB",
  cassandra: "Cassandra",
  rabbitmq: "RabbitMQ",
};

const label = (kind: string) => DB_LABELS[kind] ?? kind;

/** How to reach a database from where Tusk runs (through the host's SSH for remote targets). */
interface Endpoint {
  host: string;
  port: number;
}

const loopback = (a: string) => !a || a === "127.0.0.1" || a === "::1" || a === "localhost" || a === "0.0.0.0";

function serviceEndpoint(db: FoundDb): Endpoint {
  return { host: loopback(db.address) ? "localhost" : db.address, port: db.port };
}

/** A published port if there is one; otherwise the container's own address (reachable from its host). */
function containerEndpoint(c: ContainerInfo, local: boolean): Endpoint | null {
  const published = c.ports.find((p) => p.containerPort === c.dbPort) ?? c.ports[0];
  if (published) return { host: loopback(published.hostIp) ? "localhost" : published.hostIp, port: published.hostPort };
  // Container addresses only work from the host itself, i.e. over SSH.
  if (!local && c.ip && c.dbPort) return { host: c.ip, port: c.dbPort };
  return null;
}

function ago(at?: number) {
  if (!at) return "";
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}

export function DiscoverTab({ active }: { tab: DiscoverTabModel; active: boolean }) {
  const hosts = useApp((s) => s.sshHosts);
  const scans = useApp((s) => s.scans);
  const focus = useApp((s) => s.discoverFocus);
  const { scan, scanAll } = useApp.getState();
  const anyScanning = Object.values(scans).some((x) => x?.state === "scanning");
  const refs = useRef<Record<string, HTMLDivElement | null>>({});

  // Scan this PC the first time the tab opens.
  useEffect(() => {
    if (!useApp.getState().scans.local) void scan("local");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep PM2 numbers (CPU, memory, uptime, status) current while visible.
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      const s = useApp.getState();
      for (const [target, sc] of Object.entries(s.scans)) {
        if (sc?.state === "done" && sc.result?.pm2.status === "ok") void s.pm2Refresh(target);
      }
    }, 4000);
    return () => clearInterval(t);
  }, [active]);

  // Bring the requested host into view (and scan it if it never was).
  useEffect(() => {
    if (!active || !focus) return;
    refs.current[focus]?.scrollIntoView({ block: "start", behavior: "smooth" });
    if (!useApp.getState().scans[focus]) void scan(focus);
    useApp.setState({ discoverFocus: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, focus]);

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto flex max-w-[1000px] flex-col gap-4 p-6">
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <div className="text-[17px] font-semibold tracking-tight">Discover</div>
            <div className="text-[12.5px] text-muted">
              Databases, Docker containers and PM2 apps on this PC and your SSH servers. SSH servers are scanned when you open
              a terminal to them.
            </div>
          </div>
          <button className="btn-primary" onClick={() => void scanAll()} disabled={anyScanning}>
            {anyScanning ? <Spinner size={12} /> : <Radar size={14} />} Scan all
          </button>
        </div>
        <div ref={(el) => void (refs.current.local = el)}>
          <TargetCard target="local" name="This PC" subtitle={scans.local?.result?.os} scan={scans.local} />
        </div>
        {hosts.map((h) => (
          <div key={h.id} ref={(el) => void (refs.current[h.id] = el)}>
            <TargetCard
              target={h.id}
              host={h}
              name={h.name}
              subtitle={`${h.user}@${h.host}${h.port === 22 ? "" : `:${h.port}`}${scans[h.id]?.result?.os ? ` · ${scans[h.id]!.result!.os}` : ""}`}
              scan={scans[h.id]}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function TargetCard(props: { target: string; host?: SshHost; name: string; subtitle?: string; scan?: ScanState }) {
  const { target, host, scan } = props;
  const result = scan?.result;
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-panel" data-scan-target={props.name}>
      <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
        {host ? (
          <TerminalSquare size={16} style={{ color: host.color ?? undefined }} />
        ) : (
          <Monitor size={16} className="text-muted" />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-medium">{props.name}</div>
          {props.subtitle && <div className="truncate text-[11.5px] text-muted">{props.subtitle}</div>}
        </div>
        {scan?.at && scan.state !== "scanning" && <span className="text-[11.5px] text-faint">{ago(scan.at)}</span>}
        <button
          className="btn-outline"
          onClick={() => void useApp.getState().scan(target)}
          disabled={scan?.state === "scanning"}
          aria-label={`Scan ${props.name}`}
        >
          {scan?.state === "scanning" ? <Spinner size={11} /> : <Radar size={13} />} {scan ? "Rescan" : "Scan"}
        </button>
      </div>
      {!scan && <div className="px-4 py-3 text-[12.5px] text-faint">Not scanned yet.</div>}
      {scan?.state === "scanning" && !result && <div className="px-4 py-3 text-[12.5px] text-faint">Scanning…</div>}
      {scan?.state === "error" && (
        <div className="selectable px-4 py-3 text-[12.5px] text-danger">{scan.error}</div>
      )}
      {result && <Findings target={target} host={host} result={result} />}
    </div>
  );
}

function Findings({ target, host, result }: { target: string; host?: SshHost; result: ScanResult }) {
  const local = target === "local";
  const docker = result.docker;
  const dbContainers = docker.containers.filter((c) => c.dbKind);
  return (
    <div className="flex flex-col">
      <div className="px-4 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-faint uppercase">Databases</div>
      {result.databases.length === 0 && dbContainers.length === 0 && (
        <div className="px-4 pb-2 text-[12.5px] text-faint">No databases found.</div>
      )}
      {result.databases.map((db) => (
        <DbRow
          key={`svc-${db.port}`}
          target={target}
          host={host}
          kind={db.kind}
          title={`${label(db.kind)}${db.version ? ` ${db.version}` : ""}`}
          where={db.address ? `${db.address.includes(":") ? `[${db.address}]` : db.address}:${db.port}` : `port ${db.port}, all addresses`}
          detail={db.detail ?? db.process ?? undefined}
          endpoint={serviceEndpoint(db)}
        />
      ))}
      {dbContainers.map((c) => (
        <DbRow
          key={`ctr-${c.id}`}
          target={target}
          host={host}
          kind={c.dbKind!}
          title={`${label(c.dbKind!)} in container ${c.name}`}
          where={c.ports.length ? c.ports.map((p) => `${p.hostPort} → ${p.containerPort}`).join(", ") : c.ip ? `${c.ip}:${c.dbPort}` : "not published"}
          detail={c.state === "running" ? c.image : `${c.image} · ${c.state}`}
          endpoint={c.state === "running" ? containerEndpoint(c, local) : null}
          container={c}
        />
      ))}

      <div className="flex items-center gap-2 px-4 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-faint uppercase">
        {docker.command === "podman" ? "Podman" : "Docker"} containers
        {docker.version && <span className="font-normal normal-case">· {docker.version}</span>}
      </div>
      {docker.status === "missing" && <div className="px-4 pb-3 text-[12.5px] text-faint">Docker isn't installed.</div>}
      {docker.status !== "ok" && docker.status !== "missing" && (
        <div className="selectable px-4 pb-3 text-[12.5px] text-warn">{docker.message}</div>
      )}
      {docker.status === "ok" && docker.containers.length === 0 && (
        <div className="px-4 pb-3 text-[12.5px] text-faint">No containers.</div>
      )}
      {docker.status === "ok" && docker.containers.length > 0 && (
        <div className="pb-2">
          {docker.containers.map((c) => (
            <ContainerRow key={c.id} target={target} host={host} c={c} command={docker.command} />
          ))}
        </div>
      )}
      <Pm2Section target={target} pm2={result.pm2} windows={local && result.os === "Windows"} />
    </div>
  );
}

function DbRow(props: {
  target: string;
  host?: SshHost;
  kind: string;
  title: string;
  where: string;
  detail?: string;
  endpoint: Endpoint | null;
  container?: ContainerInfo;
}) {
  const { target, host, kind, endpoint, container } = props;
  const local = target === "local";
  const hostId = local ? null : target;
  const existing = useApp((s) =>
    endpoint
      ? s.connections.find(
          (c) =>
            (c.sshHostId ?? null) === hostId &&
            c.port === endpoint.port &&
            (c.host === endpoint.host || (loopback(c.host) && loopback(endpoint.host))),
        )
      : undefined,
  );

  const addConnection = () => {
    if (!endpoint) return;
    const env = container?.env;
    const user = env?.user || "postgres";
    const where = host?.name ?? "this PC";
    useApp.getState().openConnectionDialog(
      {
        ...blankConnection(),
        name: container ? `${container.name} (${where})` : `${props.title} on ${where}`,
        host: endpoint.host,
        port: endpoint.port,
        user,
        database: env?.database || env?.user || "postgres",
        sshHostId: hostId,
        folderId: host?.folderId ?? null,
      },
      env?.password ?? undefined,
    );
  };

  const connect = async () => {
    if (!existing) return;
    const s = useApp.getState();
    if (s.status[existing.id]?.state === "connected" || (await s.connect(existing.id))) s.openQueryTab(existing.id, existing.database);
  };

  const forward = () => {
    if (!endpoint || !host) return;
    const s = useApp.getState();
    s.openTunnelsTab();
    s.openTunnelDialog({
      ...blankTunnel(host.id),
      name: `${label(kind)} on ${host.name}`,
      bindPort: endpoint.port,
      targetHost: endpoint.host,
      targetPort: endpoint.port,
    });
  };

  return (
    <div className="flex items-center gap-3 px-4 py-1.5 hover:bg-hover/50" data-db-row={props.title}>
      <Database size={14} className={kind === "postgresql" ? "text-accent" : "text-muted"} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px]">
          {props.title}
          <span className="ml-2 font-mono text-[11.5px] text-muted">{props.where}</span>
        </div>
        {props.detail && <div className="truncate text-[11.5px] text-faint">{props.detail}</div>}
      </div>
      {kind === "postgresql" && existing && (
        <button className="btn-outline" onClick={() => void connect()} title={`Saved as ${existing.name}`}>
          <SquareTerminal size={13} /> Open {existing.name}
        </button>
      )}
      {kind === "postgresql" && !existing && (
        <button
          className="btn-outline"
          onClick={addConnection}
          disabled={!endpoint}
          title={endpoint ? `Connect to ${endpoint.host}:${endpoint.port}${host ? ` through ${host.name}` : ""}` : "Start the container or publish its port first"}
        >
          <Plus size={13} /> Add connection
        </button>
      )}
      {kind !== "postgresql" && host && endpoint && (
        <button className="btn-ghost" onClick={forward} title="Make it reachable on this PC through an SSH tunnel">
          <Waypoints size={13} /> Forward to this PC
        </button>
      )}
    </div>
  );
}

const SHELL_IN_CONTAINER = "command -v bash >/dev/null && exec bash || exec sh";

function ContainerRow({ target, host, c, command }: { target: string; host?: SshHost; c: ContainerInfo; command: string }) {
  const [busy, setBusy] = useState(false);
  const running = c.state === "running";
  const act = async (action: "start" | "stop" | "restart") => {
    setBusy(true);
    await useApp.getState().containerAction(target, c, action);
    setBusy(false);
  };
  const openTerminal = (kind: "logs" | "shell") => {
    const title = `${kind === "logs" ? "logs" : "shell"}: ${c.name}`;
    const args = kind === "logs" ? ["logs", "-f", "--tail", "300", c.id] : ["exec", "-it", c.id, "sh", "-c", SHELL_IN_CONTAINER];
    const s = useApp.getState();
    if (host) {
      const quoted = args.map((a) => (/^[\w.-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`));
      s.openTerminalTab(host.id, { title, command: [command, ...quoted].join(" ") });
    } else {
      s.openLocalTerminal(undefined, { title, command: [...command.split(" "), ...args] });
    }
  };
  const tone =
    c.state === "running" ? "bg-ok" : c.state === "paused" || c.state === "restarting" ? "bg-warn" : "bg-faint/60";
  return (
    <div className="group flex items-center gap-3 px-4 py-1.5 hover:bg-hover/50" data-container={c.name}>
      <span className={`h-2 w-2 shrink-0 rounded-full ${tone}`} title={c.state} />
      <Box size={14} className="shrink-0 text-muted" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px]">
          {c.name}
          <span className="ml-2 text-[11.5px] text-muted">{c.image}</span>
          {c.dbKind && (
            <span className="ml-2 rounded border border-border px-1 text-[10.5px] text-accent">{label(c.dbKind)}</span>
          )}
        </div>
        <div className="truncate text-[11.5px] text-faint">
          {c.status}
          {c.ports.length > 0 && ` · ${c.ports.map((p) => `${p.hostPort}→${p.containerPort}`).join(", ")}`}
        </div>
      </div>
      {busy && <Spinner size={12} />}
      {running ? (
        <>
          <button className="btn-ghost h-7 px-1.5" title="Logs" aria-label={`Logs of ${c.name}`} onClick={() => openTerminal("logs")}>
            <FileText size={13} />
          </button>
          <button className="btn-ghost h-7 px-1.5" title="Shell inside the container" aria-label={`Shell in ${c.name}`} onClick={() => openTerminal("shell")}>
            <SquareTerminal size={13} />
          </button>
          <button className="btn-ghost h-7 px-1.5" title="Restart" aria-label={`Restart ${c.name}`} disabled={busy} onClick={() => void act("restart")}>
            <RotateCw size={13} />
          </button>
          <button className="btn-ghost h-7 px-1.5" title="Stop" aria-label={`Stop ${c.name}`} disabled={busy} onClick={() => void act("stop")}>
            <Square size={12} />
          </button>
        </>
      ) : (
        <>
          <button className="btn-ghost h-7 px-1.5" title="Logs" aria-label={`Logs of ${c.name}`} onClick={() => openTerminal("logs")}>
            <FileText size={13} />
          </button>
          <button className="btn-ghost h-7 px-1.5" title="Start" aria-label={`Start ${c.name}`} disabled={busy} onClick={() => void act("start")}>
            <Play size={13} />
          </button>
        </>
      )}
    </div>
  );
}
