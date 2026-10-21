import { Activity, ArrowDown, ArrowUp, Cpu, HardDrive, MemoryStick, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { DbError, statsApi, type ServerProcess, type ServerStats } from "../lib/api";
import { fmtBytes, fmtUptime } from "../lib/format";

const POLL_MS = 2000;
/** Samples kept for the graphs: three minutes. */
const HISTORY = 90;

interface Live {
  stats: ServerStats;
  /** Percent of all cores, null until a second sample arrives. */
  cpu: number | null;
  /** Bytes per second. */
  down: number | null;
  up: number | null;
  history: { cpu: number[]; mem: number[]; down: number[]; up: number[] };
}

const pct = (used: number, total: number) => (total > 0 ? (used / total) * 100 : 0);
const tone = (p: number) => (p >= 90 ? "var(--danger)" : p >= 70 ? "var(--warn)" : "var(--ok)");
const push = (arr: number[], v: number) => [...arr, v].slice(-HISTORY);

/** Polls a terminal's server while `active`, turning counters into rates. */
function useServerStats(termId: string, active: boolean) {
  const [live, setLive] = useState<Live | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const prev = useRef<Live | null>(null);

  useEffect(() => {
    if (!active || unsupported) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const s = await statsApi.snapshot(termId);
        const p = prev.current;
        // A reboot resets the counters; start over.
        const fresh = !p || s.cpuTotal < p.stats.cpuTotal || s.uptime < p.stats.uptime;
        const dCpu = fresh ? 0 : s.cpuTotal - p.stats.cpuTotal;
        const cpu = fresh || dCpu <= 0 ? null : Math.min(100, ((s.cpuBusy - p.stats.cpuBusy) / dCpu) * 100);
        const dt = fresh ? 0 : s.uptime - p.stats.uptime;
        const down = dt > 0 ? Math.max(0, (s.netRx - p!.stats.netRx) / dt) : null;
        const up = dt > 0 ? Math.max(0, (s.netTx - p!.stats.netTx) / dt) : null;
        const h = fresh || !p ? { cpu: [], mem: [], down: [], up: [] } : p.history;
        const next: Live = {
          stats: s,
          cpu,
          down,
          up,
          history: {
            cpu: cpu === null ? h.cpu : push(h.cpu, cpu),
            mem: push(h.mem, pct(s.memTotal - s.memAvailable, s.memTotal)),
            down: down === null ? h.down : push(h.down, down),
            up: up === null ? h.up : push(h.up, up),
          },
        };
        prev.current = next;
        if (!stopped) setLive(next);
      } catch (e) {
        if (e instanceof DbError && e.info.kind === "STATS_UNSUPPORTED") {
          setUnsupported(true);
          return;
        }
        // Connection hiccup: try again on the next tick.
      }
      if (!stopped) timer = setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [termId, active, unsupported]);

  return { live, unsupported };
}

function Meter({ value, width = 44 }: { value: number; width?: number }) {
  return (
    <span className="inline-block h-1.5 overflow-hidden rounded-full bg-border align-middle" style={{ width }}>
      <span
        className="block h-full rounded-full transition-[width] duration-500"
        style={{ width: `${Math.max(2, Math.min(100, value))}%`, background: tone(value) }}
      />
    </span>
  );
}

/** The strip under an SSH terminal. Click it for details. */
export function StatsBar({ termId, active }: { termId: string; active: boolean }) {
  const { live, unsupported } = useServerStats(termId, active);
  const [open, setOpen] = useState(false);

  if (unsupported) {
    return (
      <div className="flex h-6 shrink-0 items-center gap-1.5 border-t border-border bg-panel px-3 text-[11.5px] text-faint">
        <Activity size={11} /> Performance stats need a Linux server
      </div>
    );
  }
  const s = live?.stats;
  const memUsed = s ? s.memTotal - s.memAvailable : 0;
  const root = s?.disks[0];

  return (
    <div className="relative shrink-0">
      {open && live && <StatsPanel termId={termId} live={live} onClose={() => setOpen(false)} />}
      <button
        className="flex h-6 w-full items-center gap-3.5 overflow-hidden border-t border-border bg-panel px-3 text-left text-[11.5px] whitespace-nowrap text-muted tabular-nums hover:bg-hover/60"
        onClick={() => setOpen((o) => !o)}
        // Keep keyboard focus in the terminal.
        onMouseDown={(e) => e.preventDefault()}
        tabIndex={-1}
        title="Server performance: click for details"
        aria-label="Server stats"
        data-server-stats
      >
        <Activity size={11} className={live ? "text-accent" : "text-faint"} />
        {!s ? (
          <span className="text-faint">Reading server stats…</span>
        ) : (
          <>
            <Item label="CPU">
              <Meter value={live.cpu ?? 0} /> <span data-stat="cpu">{live.cpu === null ? "…" : `${Math.round(live.cpu)}%`}</span>
            </Item>
            <Item label="RAM">
              <Meter value={pct(memUsed, s.memTotal)} />{" "}
              <span data-stat="mem">
                {fmtBytes(memUsed)} / {fmtBytes(s.memTotal)}
              </span>
            </Item>
            {root && (
              <Item label={`Disk ${root.mount}`}>
                <Meter value={pct(root.used, root.size)} />{" "}
                <span data-stat="disk">{Math.round(pct(root.used, root.size))}%</span>
              </Item>
            )}
            <Item label="Net">
              <span data-stat="net">
                <ArrowDown size={10} className="inline text-ok" />
                {live.down === null ? "…" : `${fmtBytes(live.down)}/s`}{" "}
                <ArrowUp size={10} className="inline text-accent" />
                {live.up === null ? "…" : `${fmtBytes(live.up)}/s`}
              </span>
            </Item>
            <Item label="Load">{s.load[0].toFixed(2)}</Item>
            <Item label="Up">{fmtUptime(s.uptime)}</Item>
            <Item label="Users">{s.users}</Item>
            <span className="min-w-0 flex-1 truncate text-right text-faint">
              {s.hostname}
              {s.os ? ` · ${s.os}` : ""}
            </span>
          </>
        )}
      </button>
    </div>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <span className="text-faint">{label}</span>
      {children}
    </span>
  );
}

/** A small area chart. `max` fixes the scale (100 for percentages). */
function Sparkline({ values, max, color, height = 40 }: { values: number[]; max?: number; color: string; height?: number }) {
  const w = HISTORY - 1;
  const top = Math.max(max ?? 0, ...values, 1e-9);
  const pts = values.map((v, i) => `${w - (values.length - 1 - i)},${height - (v / top) * (height - 2) - 1}`);
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className="h-10 w-full" aria-hidden>
      {pts.length > 1 && (
        <>
          <polygon
            points={`${pts[0].split(",")[0]},${height} ${pts.join(" ")} ${w},${height}`}
            fill={color}
            opacity={0.15}
          />
          <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
        </>
      )}
    </svg>
  );
}

function Section({ icon, title, right, children }: { icon: ReactNode; title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 border-b border-border px-4 py-3 last:border-0">
      <div className="flex items-center gap-1.5 text-[12px] font-medium">
        <span className="text-muted">{icon}</span>
        {title}
        <span className="ml-auto text-[12px] font-normal text-muted tabular-nums">{right}</span>
      </div>
      {children}
    </div>
  );
}

interface ProcRow extends ServerProcess {
  cpu: number | null;
}

/** Top processes, with CPU from the change in each process's CPU time. */
function useProcesses(termId: string, cores: number) {
  const [rows, setRows] = useState<ProcRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let prev: { cpuTotal: number; ticks: Map<number, number> } | null = null;
    const tick = async () => {
      try {
        const p = await statsApi.processes(termId);
        const dTotal = prev ? p.cpuTotal - prev.cpuTotal : 0;
        const list = p.list.map((x) => {
          const before = prev?.ticks.get(x.pid);
          // Percent of one core, like top.
          const cpu = prev && dTotal > 0 && before !== undefined ? ((x.ticks - before) / dTotal) * 100 * cores : null;
          return { ...x, cpu };
        });
        prev = { cpuTotal: p.cpuTotal, ticks: new Map(p.list.map((x) => [x.pid, x.ticks])) };
        list.sort((a, b) => (b.cpu ?? -1) - (a.cpu ?? -1) || b.rss - a.rss);
        if (!stopped) setRows(list.slice(0, 12));
      } catch (e) {
        if (!stopped) setError(e instanceof Error ? e.message : String(e));
      }
      if (!stopped) timer = setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [termId, cores]);
  return { rows, error };
}

function StatsPanel({ termId, live, onClose }: { termId: string; live: Live; onClose: () => void }) {
  const s = live.stats;
  const memUsed = s.memTotal - s.memAvailable;
  const swapUsed = s.swapTotal - s.swapFree;
  const { rows, error } = useProcesses(termId, s.cores);
  const netMax = Math.max(...live.history.down, ...live.history.up, 1);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current?.contains(t) || t.closest("[data-server-stats]")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute right-2 bottom-7 z-20 flex max-h-[calc(100vh-140px)] w-[460px] max-w-[calc(100%-16px)] flex-col overflow-hidden rounded-lg border border-border bg-panel shadow-2xl"
      role="dialog"
      aria-label="Server performance"
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold">{s.hostname || "Server"}</div>
          <div className="truncate text-[11.5px] text-muted">
            {s.os} · {s.cores} core{s.cores === 1 ? "" : "s"} · up {fmtUptime(s.uptime)} · {s.users} user
            {s.users === 1 ? "" : "s"} logged in
          </div>
        </div>
        <button className="btn-ghost h-7 w-7 justify-center px-0" onClick={onClose} aria-label="Close">
          <X size={14} />
        </button>
      </div>
      <div className="min-h-0 overflow-auto">
        <Section
          icon={<Cpu size={13} />}
          title="CPU"
          right={`${live.cpu === null ? "…" : `${Math.round(live.cpu)}%`} · load ${s.load.map((l) => l.toFixed(2)).join(" ")}`}
        >
          <Sparkline values={live.history.cpu} max={100} color="var(--accent)" />
        </Section>
        <Section
          icon={<MemoryStick size={13} />}
          title="Memory"
          right={`${fmtBytes(memUsed)} of ${fmtBytes(s.memTotal)} (${Math.round(pct(memUsed, s.memTotal))}%)`}
        >
          <Sparkline values={live.history.mem} max={100} color="var(--ok)" />
          {s.swapTotal > 0 && (
            <div className="flex items-center gap-2 text-[11.5px] text-muted">
              Swap <Meter value={pct(swapUsed, s.swapTotal)} width={120} /> {fmtBytes(swapUsed)} of {fmtBytes(s.swapTotal)}
            </div>
          )}
        </Section>
        <Section
          icon={<ArrowDown size={13} />}
          title="Network"
          right={
            <>
              ↓ {live.down === null ? "…" : `${fmtBytes(live.down)}/s`} · ↑ {live.up === null ? "…" : `${fmtBytes(live.up)}/s`}
            </>
          }
        >
          {/* Both directions on one scale, received drawn under sent. */}
          <div className="relative">
            <Sparkline values={live.history.down} max={netMax} color="var(--ok)" />
            <div className="absolute inset-0">
              <Sparkline values={live.history.up} max={netMax} color="var(--accent)" />
            </div>
          </div>
          <div className="text-[11px] text-faint">
            Received {fmtBytes(s.netRx)} · sent {fmtBytes(s.netTx)} since boot
          </div>
        </Section>
        <Section icon={<HardDrive size={13} />} title="Disks">
          {s.disks.map((d) => (
            <div key={d.mount} className="flex items-center gap-2 text-[12px] tabular-nums" title={d.filesystem}>
              <span className="w-28 truncate font-mono text-[11.5px]">{d.mount}</span>
              <Meter value={pct(d.used, d.size)} width={140} />
              <span className="text-muted">
                {fmtBytes(d.used)} of {fmtBytes(d.size)}
              </span>
              <span className="ml-auto text-muted">{Math.round(pct(d.used, d.size))}%</span>
            </div>
          ))}
          {s.disks.length === 0 && <div className="text-[12px] text-faint">No disks reported</div>}
        </Section>
        <Section icon={<Activity size={13} />} title="Top processes" right={rows && rows[0]?.cpu === null ? "measuring…" : undefined}>
          {error && <div className="text-[12px] text-danger">{error}</div>}
          {!rows && !error && <div className="text-[12px] text-faint">Loading…</div>}
          {rows && (
            <table className="w-full table-fixed text-[11.5px] tabular-nums" data-top-processes>
              <thead className="text-left text-faint">
                <tr>
                  <th className="w-14 font-normal">PID</th>
                  <th className="w-20 font-normal">User</th>
                  <th className="w-14 text-right font-normal">CPU</th>
                  <th className="w-16 pr-2 text-right font-normal">Memory</th>
                  <th className="font-normal">Command</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.pid} className="hover:bg-hover">
                    <td className="text-muted">{p.pid}</td>
                    <td className="truncate">{p.user}</td>
                    <td className="text-right">{p.cpu === null ? "–" : `${p.cpu.toFixed(1)}%`}</td>
                    <td className="pr-2 text-right">{fmtBytes(p.rss)}</td>
                    <td className="selectable truncate font-mono text-[11px]" title={p.command}>
                      {p.command}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      </div>
    </div>
  );
}
