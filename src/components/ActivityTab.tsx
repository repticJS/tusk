import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Ban, ChevronRight, Copy, Pause, Play, Search, SquareTerminal, XCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { query, type SessionRef } from "../lib/api";
import { fmtBytes, fmtDuration, fmtUptime } from "../lib/format";
import { tabSession, useApp, type ActivityTab as ActivityTabModel } from "../store";
import { HISTORY, Sparkline } from "./ServerStats";
import { Modal, Spinner } from "./ui";

// All queries work on PostgreSQL 9.6+. Columns that newer versions added are
// read through to_json(row) so older servers just return NULL for them.

const OVERVIEW_SQL = `select
  (select count(*) from pg_stat_activity)::int as connections,
  current_setting('max_connections')::int as max_connections,
  (select count(*) from pg_stat_activity where state = 'active' and pid <> pg_backend_pid())::int as active,
  (select count(*) from pg_stat_activity where state like 'idle in transaction%')::int as idle_in_tx,
  (select count(*) from pg_stat_activity where cardinality(pg_blocking_pids(pid)) > 0)::int as blocked,
  sum(xact_commit + xact_rollback)::bigint as xacts,
  sum(blks_hit)::bigint as hits,
  sum(blks_read)::bigint as reads,
  sum(deadlocks)::bigint as deadlocks,
  extract(epoch from now() - pg_postmaster_start_time())::bigint as uptime,
  pg_database_size(current_database()) as db_size,
  extract(epoch from clock_timestamp())::float8 as at
from pg_stat_database`;

const SESSIONS_SQL = `select a.pid, a.usename as user, a.datname as database, a.application_name as app,
  coalesce(host(a.client_addr), case when a.client_port = -1 then 'local socket' end) as client,
  a.state, a.wait_event_type, a.wait_event,
  extract(epoch from now() - a.query_start)::float8 as query_secs,
  extract(epoch from now() - a.xact_start)::float8 as xact_secs,
  extract(epoch from now() - a.backend_start)::float8 as conn_secs,
  pg_blocking_pids(a.pid) as blocked_by,
  to_json(a)->>'backend_type' as backend_type,
  a.query
from pg_stat_activity a
where a.pid <> pg_backend_pid()
order by (a.state = 'active') desc, a.query_start nulls last`;

const REPLICATION_SQL = `select r.pid, r.application_name as app, host(r.client_addr) as client, r.state, r.sync_state,
  to_json(r)->>'replay_lag' as replay_lag
from pg_stat_replication r`;

const TABLES_SQL = `select schemaname as schema, relname as name, n_live_tup::bigint as live, n_dead_tup::bigint as dead,
  seq_scan::bigint as seq, coalesce(idx_scan, 0)::bigint as idx,
  extract(epoch from now() - greatest(last_vacuum, last_autovacuum))::float8 as vacuumed,
  extract(epoch from now() - greatest(last_analyze, last_autoanalyze))::float8 as analyzed,
  pg_total_relation_size(relid) as size
from pg_stat_user_tables
order by n_dead_tup desc, seq_scan desc
limit 12`;

interface Overview {
  connections: number;
  maxConnections: number;
  active: number;
  idleInTx: number;
  blocked: number;
  xacts: number;
  hits: number;
  reads: number;
  deadlocks: number;
  uptime: number;
  dbSize: number;
  at: number;
}

interface SessionRow {
  pid: number;
  user: string;
  database: string;
  app: string;
  client: string;
  state: string;
  wait: string;
  querySecs: number | null;
  xactSecs: number | null;
  connSecs: number | null;
  blockedBy: number[];
  backendType: string | null;
  query: string;
}

const num = (v: string | null | undefined) => (v == null ? 0 : Number(v));
const opt = (v: string | null | undefined) => (v == null ? null : Number(v));
/** "{12,34}" → [12, 34] */
const pids = (v: string | null) => (v ? v.replace(/[{}]/g, "").split(",").filter(Boolean).map(Number) : []);

type Filter = "busy" | "all" | "locks";

export function ActivityTab({ tab, active }: { tab: ActivityTabModel; active: boolean }) {
  const session: SessionRef = useMemo(() => tabSession(tab), [tab]);
  const conn = useApp((s) => s.connections.find((c) => c.id === tab.connId));
  const [paused, setPaused] = useState(false);
  const [interval, setIntervalMs] = useState(2000);
  const [error, setError] = useState<string | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [rates, setRates] = useState<{ tps: number | null; hit: number | null }>({ tps: null, hit: null });
  const [history, setHistory] = useState<{ tps: number[]; conns: number[] }>({ tps: [], conns: [] });
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [replication, setReplication] = useState<Record<string, string | null>[]>([]);
  const [tables, setTables] = useState<Record<string, string | null>[] | null>(null);
  const [filter, setFilter] = useState<Filter>("busy");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const prev = useRef<Overview | null>(null);
  const lastTables = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const [o] = await query(session, OVERVIEW_SQL);
      const next: Overview = {
        connections: num(o.connections),
        maxConnections: num(o.max_connections),
        active: num(o.active),
        idleInTx: num(o.idle_in_tx),
        blocked: num(o.blocked),
        xacts: num(o.xacts),
        hits: num(o.hits),
        reads: num(o.reads),
        deadlocks: num(o.deadlocks),
        uptime: num(o.uptime),
        dbSize: num(o.db_size),
        at: num(o.at),
      };
      const p = prev.current;
      const dt = p ? next.at - p.at : 0;
      const tps = p && dt > 0 && next.xacts >= p.xacts ? (next.xacts - p.xacts) / dt : null;
      const dHits = p ? next.hits - p.hits : 0;
      const dReads = p ? next.reads - p.reads : 0;
      // Over the last interval when there was any I/O, else since the stats reset.
      const hit =
        dHits + dReads > 0
          ? (dHits / (dHits + dReads)) * 100
          : next.hits + next.reads > 0
            ? (next.hits / (next.hits + next.reads)) * 100
            : null;
      prev.current = next;
      setOverview(next);
      setRates({ tps, hit });
      setHistory((h) => ({
        tps: tps === null ? h.tps : [...h.tps, tps].slice(-HISTORY),
        conns: [...h.conns, next.connections].slice(-HISTORY),
      }));

      const rows = await query(session, SESSIONS_SQL);
      setSessions(
        rows
          .map((r) => ({
            pid: num(r.pid),
            user: r.user ?? "",
            database: r.database ?? "",
            app: r.app ?? "",
            client: r.client ?? "",
            state: r.state ?? "",
            wait: [r.wait_event_type, r.wait_event].filter(Boolean).join(": "),
            querySecs: opt(r.query_secs),
            xactSecs: opt(r.xact_secs),
            connSecs: opt(r.conn_secs),
            blockedBy: pids(r.blocked_by),
            backendType: r.backend_type,
            query: r.query ?? "",
          }))
          // Background workers (autovacuum, WAL writer…) aren't sessions.
          .filter((r) => r.backendType == null || r.backendType === "client backend"),
      );
      setReplication(await query(session, REPLICATION_SQL).catch(() => []));
      if (Date.now() - lastTables.current > 15_000) {
        lastTables.current = Date.now();
        setTables(await query(session, TABLES_SQL));
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [session]);

  useEffect(() => {
    if (!active || paused) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await refresh();
      if (!stopped) timer = setTimeout(() => void tick(), interval);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [active, paused, interval, refresh]);

  // Who is holding up whom.
  const blocking = useMemo(() => {
    const m = new Map<number, number>();
    for (const s of sessions) for (const b of s.blockedBy) m.set(b, (m.get(b) ?? 0) + 1);
    return m;
  }, [sessions]);

  const shown = sessions.filter((s) => {
    if (filter === "busy" && s.state === "idle") return false;
    if (filter === "locks" && !s.blockedBy.length && !blocking.has(s.pid)) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return [s.query, s.user, s.app, s.client, String(s.pid), s.database].some((x) => x.toLowerCase().includes(q));
  });

  const o = overview;
  return (
    <div className="flex h-full flex-col overflow-auto" data-activity>
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold">
            {conn?.name ?? "Database"} <span className="font-normal text-muted">/ {tab.database}</span>
          </div>
          <div className="text-[11.5px] text-muted">Live sessions, locks and health</div>
        </div>
        {error && (
          <span className="selectable max-w-[40%] truncate text-[12px] text-danger" title={error}>
            {error}
          </span>
        )}
        <select
          className="field h-7 w-auto py-0 text-[12px]"
          value={interval}
          onChange={(e) => setIntervalMs(Number(e.target.value))}
          aria-label="Refresh every"
        >
          {[1000, 2000, 5000, 10000].map((ms) => (
            <option key={ms} value={ms}>
              Every {ms / 1000}s
            </option>
          ))}
        </select>
        <button className="btn-outline" onClick={() => setPaused((p) => !p)}>
          {paused ? <Play size={12} /> : <Pause size={12} />} {paused ? "Resume" : "Pause"}
        </button>
      </div>

      {!o && !error && (
        <div className="flex items-center gap-2 p-6 text-[13px] text-muted">
          <Spinner size={12} /> Loading…
        </div>
      )}

      {o && (
        <div className="grid grid-cols-2 gap-2 p-4 pb-2 sm:grid-cols-4 xl:grid-cols-8">
          <Card label="Connections" value={`${o.connections} / ${o.maxConnections}`} tone={o.connections / o.maxConnections > 0.85 ? "danger" : undefined}>
            <Sparkline values={history.conns} max={o.maxConnections} color="var(--accent)" height={24} />
          </Card>
          <Card label="Running now" value={String(o.active)} />
          <Card label="Transactions/s" value={rates.tps === null ? "…" : rates.tps < 10 ? rates.tps.toFixed(1) : String(Math.round(rates.tps))}>
            <Sparkline values={history.tps} color="var(--ok)" height={24} />
          </Card>
          <Card
            label="Cache hit"
            value={rates.hit === null ? "–" : `${rates.hit.toFixed(rates.hit > 99 ? 2 : 1)}%`}
            tone={rates.hit !== null && rates.hit < 90 ? "warn" : undefined}
          />
          <Card label="Idle in transaction" value={String(o.idleInTx)} tone={o.idleInTx ? "warn" : undefined} />
          <Card label="Waiting on locks" value={String(o.blocked)} tone={o.blocked ? "danger" : undefined} />
          <Card label="Database size" value={fmtBytes(o.dbSize)} />
          <Card label="Server up" value={fmtUptime(o.uptime)} hint={o.deadlocks ? `${o.deadlocks} deadlocks since stats reset` : undefined} />
        </div>
      )}

      {o && (
        <div className="flex flex-col px-4 pb-4">
          <div className="flex items-center gap-2 py-2">
            <div className="flex rounded-md border border-border p-0.5">
              {(
                [
                  ["busy", "Not idle"],
                  ["all", "All"],
                  ["locks", "Locks"],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  className={`h-6 rounded px-2.5 text-[12px] ${filter === v ? "bg-hover font-medium text-text" : "text-muted hover:text-text"}`}
                  onClick={() => setFilter(v)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="flex h-7 flex-1 items-center gap-1.5 rounded-md border border-border bg-bg px-2 focus-within:border-accent">
              <Search size={12} className="text-faint" />
              <input
                className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-faint"
                placeholder="Filter by query, user, app, client or PID"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <span className="text-[11.5px] text-faint">
              {shown.length} of {sessions.length} sessions
            </span>
          </div>
          <div className="overflow-hidden rounded-lg border border-border bg-panel">
            <table className="w-full table-fixed text-[12px] tabular-nums" data-sessions>
              <thead className="border-b border-border text-left text-[11px] text-faint">
                <tr>
                  <th className="w-[72px] py-1.5 pl-3 font-normal">PID</th>
                  <th className="w-[11%] font-normal">User</th>
                  <th className="w-[12%] font-normal">App / client</th>
                  <th className="w-[15%] font-normal">State</th>
                  <th className="w-[80px] font-normal">Running</th>
                  <th className="font-normal">Query</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((s) => (
                  <SessionLine
                    key={s.pid}
                    s={s}
                    blocking={blocking.get(s.pid) ?? 0}
                    open={open === s.pid}
                    onToggle={() => setOpen((x) => (x === s.pid ? null : s.pid))}
                    session={session}
                    tab={tab}
                    refresh={refresh}
                  />
                ))}
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-4 text-center text-[12.5px] text-faint">
                      {filter === "locks" ? "Nothing is waiting on a lock." : filter === "busy" ? "Every session is idle." : "No sessions."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {replication.length > 0 && (
            <>
              <div className="pt-4 pb-1.5 text-[11px] font-semibold tracking-wide text-faint uppercase">Replicas</div>
              <div className="overflow-hidden rounded-lg border border-border bg-panel">
                {replication.map((r) => (
                  <div key={r.pid} className="flex items-center gap-3 border-b border-border px-3 py-1.5 text-[12px] last:border-0">
                    <span className="font-medium">{r.app || r.client}</span>
                    <span className="text-muted">{r.client}</span>
                    <span className="text-muted">
                      {r.state} · {r.sync_state}
                    </span>
                    <span className="ml-auto text-muted">{r.replay_lag ? `lag ${r.replay_lag}` : ""}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {tables && tables.length > 0 && (
            <>
              <div className="pt-4 pb-1.5 text-[11px] font-semibold tracking-wide text-faint uppercase">
                Table health <span className="font-normal normal-case">· most dead rows first</span>
              </div>
              <div className="overflow-hidden rounded-lg border border-border bg-panel">
                <table className="w-full table-fixed text-[12px] tabular-nums" data-table-health>
                  <thead className="border-b border-border text-left text-[11px] text-faint">
                    <tr>
                      <th className="py-1.5 pl-3 font-normal">Table</th>
                      <th className="w-[10%] text-right font-normal">Rows</th>
                      <th className="w-[13%] text-right font-normal">Dead rows</th>
                      <th className="w-[16%] text-right font-normal">Seq / index scans</th>
                      <th className="w-[12%] pl-4 font-normal">Vacuumed</th>
                      <th className="w-[12%] font-normal">Analyzed</th>
                      <th className="w-[9%] pr-3 text-right font-normal">Size</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tables.map((t) => {
                      const live = num(t.live);
                      const dead = num(t.dead);
                      const bloated = dead > 1000 && dead > live * 0.2;
                      const seq = num(t.seq);
                      const idx = num(t.idx);
                      // Many full scans of a big table usually means a missing index.
                      const scanny = live > 10_000 && seq > idx * 10 && seq > 100;
                      return (
                        <tr key={`${t.schema}.${t.name}`} className="border-b border-border last:border-0">
                          <td className="truncate py-1 pl-3">
                            <span className="text-faint">{t.schema === "public" ? "" : `${t.schema}.`}</span>
                            {t.name}
                          </td>
                          <td className="text-right">{live.toLocaleString()}</td>
                          <td className={`text-right ${bloated ? "text-warn" : ""}`} title={bloated ? "Lots of dead rows: VACUUM may be falling behind" : undefined}>
                            {dead.toLocaleString()}
                            {live + dead > 0 && dead > 0 && <span className="text-faint"> ({Math.round((dead / (live + dead)) * 100)}%)</span>}
                          </td>
                          <td className={`text-right ${scanny ? "text-warn" : ""}`} title={scanny ? "Mostly full table scans: an index might help" : undefined}>
                            {seq.toLocaleString()} / {idx.toLocaleString()}
                          </td>
                          <td className="pl-4 text-muted">{t.vacuumed == null ? "never" : `${fmtDuration(num(t.vacuumed))} ago`}</td>
                          <td className="text-muted">{t.analyzed == null ? "never" : `${fmtDuration(num(t.analyzed))} ago`}</td>
                          <td className="pr-3 text-right text-muted">{fmtBytes(num(t.size))}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Card({ label, value, tone, hint, children }: { label: string; value: string; tone?: "warn" | "danger"; hint?: string; children?: React.ReactNode }) {
  const color = tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn" : "text-text";
  return (
    <div className="flex min-h-[64px] flex-col rounded-lg border border-border bg-panel px-3 py-2" title={hint} data-card={label}>
      <span className="truncate text-[11px] text-muted">{label}</span>
      <span className={`text-[17px] font-semibold tabular-nums ${color}`}>{value}</span>
      {children && <div className="mt-auto">{children}</div>}
    </div>
  );
}

const STATE_TONE: Record<string, string> = {
  active: "text-ok",
  "idle in transaction": "text-warn",
  "idle in transaction (aborted)": "text-danger",
  idle: "text-faint",
};

function SessionLine(props: {
  s: SessionRow;
  blocking: number;
  open: boolean;
  onToggle: () => void;
  session: SessionRef;
  tab: ActivityTabModel;
  refresh: () => Promise<void>;
}) {
  const { s, blocking, open } = props;
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState<"cancel" | "terminate" | null>(null);
  const running = s.state === "active" ? s.querySecs : s.state.startsWith("idle in") ? s.xactSecs : null;
  const slow = running !== null && running > 60;

  const signal = async (kind: "cancel" | "terminate") => {
    setBusy(kind);
    const app = useApp.getState();
    try {
      const fn = kind === "cancel" ? "pg_cancel_backend" : "pg_terminate_backend";
      const [r] = await query(props.session, `select ${fn}(${s.pid}) as ok`);
      if (r?.ok === "t") app.showToast(kind === "cancel" ? `Cancelled the query of ${s.pid}` : `Ended session ${s.pid}`, "ok");
      else app.showToast(`Session ${s.pid} had already ended`, "info");
    } catch (e) {
      app.showToast(e instanceof Error ? e.message : String(e), "error");
    }
    setBusy(null);
    await props.refresh();
  };

  return (
    <>
      <tr
        className={`cursor-default border-b border-border last:border-0 hover:bg-hover/50 ${s.blockedBy.length ? "bg-danger-soft" : ""}`}
        onClick={props.onToggle}
        data-session={s.pid}
      >
        <td className="py-1 pl-3">
          <span className="flex items-center gap-1">
            <ChevronRight size={11} className={`shrink-0 text-faint transition-transform ${open ? "rotate-90" : ""}`} />
            {s.pid}
          </span>
        </td>
        <td className="truncate">{s.user}</td>
        <td className="truncate text-muted" title={`${s.app} ${s.client}`}>
          {s.app || s.client}
        </td>
        <td className="truncate">
          <span className={STATE_TONE[s.state] ?? "text-muted"}>{s.state || "–"}</span>
          {s.blockedBy.length > 0 && (
            <span className="ml-1.5 rounded bg-danger px-1 text-[10.5px] text-white" data-blocked-by={s.blockedBy.join(",")}>
              blocked by {s.blockedBy.join(", ")}
            </span>
          )}
          {blocking > 0 && (
            <span className="ml-1.5 rounded bg-warn px-1 text-[10.5px] text-black" data-blocking={blocking}>
              blocking {blocking}
            </span>
          )}
        </td>
        <td className={slow ? "text-warn" : "text-muted"}>{running === null ? "" : fmtDuration(running)}</td>
        <td className="truncate pr-3 font-mono text-[11px]" title={s.query}>
          {s.query.replace(/\s+/g, " ")}
        </td>
      </tr>
      {open && (
        <tr className="border-b border-border">
          <td colSpan={6} className="bg-bg px-3 py-2.5">
            <pre className="selectable mb-2 max-h-48 overflow-auto rounded border border-border bg-panel p-2 font-mono text-[11.5px] whitespace-pre-wrap">
              {s.query || "(no query)"}
            </pre>
            <div className="mb-2 flex flex-wrap gap-x-4 gap-y-0.5 text-[11.5px] text-muted">
              <span>Database {s.database}</span>
              {s.client && <span>Client {s.client}</span>}
              {s.wait && <span>Waiting on {s.wait}</span>}
              {s.xactSecs !== null && <span>Transaction open {fmtDuration(s.xactSecs)}</span>}
              {s.connSecs !== null && <span>Connected {fmtDuration(s.connSecs)}</span>}
            </div>
            <div className="flex gap-1.5" onClick={(e) => e.stopPropagation()}>
              <button className="btn-outline h-6 text-[11.5px]" onClick={() => useApp.getState().openQueryTab(props.tab.connId, props.tab.database, s.query)} disabled={!s.query}>
                <SquareTerminal size={11} /> Open in editor
              </button>
              <button
                className="btn-outline h-6 text-[11.5px]"
                onClick={() => void writeText(s.query).then(() => useApp.getState().showToast("Query copied", "ok"))}
                disabled={!s.query}
              >
                <Copy size={11} /> Copy
              </button>
              <div className="flex-1" />
              <button
                className="btn-outline h-6 text-[11.5px]"
                disabled={busy !== null || s.state !== "active"}
                onClick={() => void signal("cancel")}
                title="Stop the running query; the session stays connected"
                aria-label={`Cancel query ${s.pid}`}
              >
                {busy === "cancel" ? <Spinner size={10} /> : <Ban size={11} />} Cancel query
              </button>
              <button
                className="btn-outline h-6 text-[11.5px] text-danger"
                disabled={busy !== null}
                onClick={() => setConfirm(true)}
                title="Disconnect the session, rolling back its open transaction"
                aria-label={`Terminate ${s.pid}`}
              >
                {busy === "terminate" ? <Spinner size={10} /> : <XCircle size={11} />} Terminate session
              </button>
            </div>
          </td>
        </tr>
      )}
      {confirm && (
        <Modal
          title={`Terminate session ${s.pid}?`}
          width={440}
          onClose={() => setConfirm(false)}
          footer={
            <>
              <button className="btn-outline" onClick={() => setConfirm(false)}>
                Keep it
              </button>
              <button
                className="btn-danger"
                onClick={() => {
                  setConfirm(false);
                  void signal("terminate");
                }}
              >
                Terminate
              </button>
            </>
          }
        >
          <div className="p-4 text-[13px]">
            <b>{s.user}</b>
            {s.app ? ` (${s.app})` : ""} will be disconnected and any open transaction rolled back.
          </div>
        </Modal>
      )}
    </>
  );
}
