import { Clock, Database, Eye, Moon, Plus, Search, SquareTerminal, Sun, Table2, TerminalSquare } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { formatDuration } from "../lib/sql";
import { activeConnectionOf, cacheKey, useApp } from "../store";
import { Modal } from "./ui";

interface Item {
  id: string;
  icon: ReactNode;
  label: string;
  detail?: string;
  run: () => void;
}

/** Fuzzy-ish match: all characters in order; prefers contiguous matches. */
function score(text: string, q: string): number {
  if (!q) return 1;
  const t = text.toLowerCase();
  const idx = t.indexOf(q);
  if (idx >= 0) return 1000 - idx - t.length * 0.1;
  let i = 0;
  for (const ch of t) if (ch === q[i]) i++;
  return i === q.length ? 100 - t.length * 0.1 : -1;
}

export function CommandPalette() {
  const close = () => useApp.getState().setPaletteOpen(false);
  const state = useApp();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo(() => {
    const out: Item[] = [];
    const active = activeConnectionOf(state);
    if (active) {
      out.push({
        id: "new-query",
        icon: <SquareTerminal size={14} />,
        label: "New query",
        detail: "Ctrl+T",
        run: () => state.openQueryTab(active.connId, active.database),
      });
    }
    out.push({ id: "new-conn", icon: <Plus size={14} />, label: "New connection", run: () => state.openConnectionDialog() });
    out.push({
      id: "theme",
      icon: state.theme === "dark" ? <Sun size={14} /> : <Moon size={14} />,
      label: `Switch to ${state.theme === "dark" ? "light" : "dark"} theme`,
      run: () => state.setTheme(state.theme === "dark" ? "light" : "dark"),
    });
    out.push({ id: "history", icon: <Clock size={14} />, label: "Query history", run: () => state.setHistoryOpen(true) });
    for (const h of state.sshHosts) {
      out.push({
        id: `ssh-${h.id}`,
        icon: <TerminalSquare size={14} />,
        label: `SSH: ${h.name}`,
        detail: `${h.user}@${h.host}`,
        run: () => state.openTerminalTab(h.id),
      });
    }
    for (const c of state.connections) {
      if (state.status[c.id]?.state !== "connected") {
        out.push({ id: `connect-${c.id}`, icon: <Database size={14} />, label: `Connect: ${c.name}`, run: () => void state.connect(c.id) });
        continue;
      }
      for (const db of state.databases[c.id] ?? []) {
        for (const o of state.cache[cacheKey(c.id, db)]?.relations ?? []) {
          out.push({
            id: `${c.id}/${db}/${o.schema}/${o.name}`,
            icon: o.kind === "v" || o.kind === "m" ? <Eye size={14} /> : <Table2 size={14} />,
            label: o.schema === "public" ? o.name : `${o.schema}.${o.name}`,
            detail: `${c.name} / ${db}`,
            run: () => state.openTableTab(c.id, db, o.schema, o.name, o.kind),
          });
        }
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.connections, state.sshHosts, state.status, state.databases, state.cache, state.theme, state.activeTabId]);

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    return items
      .map((it) => ({ it, s: score(it.label, query) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 60)
      .map((x) => x.it);
  }, [items, q]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const run = (it?: Item) => {
    if (!it) return;
    close();
    it.run();
  };

  return createPortal(
    <div className="fixed inset-0 z-[1500] flex justify-center bg-black/30 pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="flex h-fit max-h-[60vh] w-[600px] flex-col overflow-hidden rounded-xl border border-border bg-panel shadow-2xl">
        <div className="flex items-center gap-2.5 border-b border-border px-4">
          <Search size={15} className="text-faint" />
          <input
            autoFocus
            className="h-12 flex-1 bg-transparent text-[14px] outline-none placeholder:text-faint focus-visible:outline-none"
            placeholder="Jump to a table, or run a command…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") close();
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => Math.min(s + 1, filtered.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => Math.max(s - 1, 0));
              } else if (e.key === "Enter") run(filtered[sel]);
            }}
          />
        </div>
        <div ref={listRef} className="min-h-0 flex-1 overflow-auto p-1.5">
          {filtered.length === 0 && <div className="p-4 text-center text-[12.5px] text-faint">No matches</div>}
          {filtered.map((it, i) => (
            <div
              key={it.id}
              data-idx={i}
              className={`flex h-9 cursor-default items-center gap-3 rounded-md px-3 text-[13px] ${
                i === sel ? "bg-accent text-accent-fg" : "text-text"
              }`}
              onMouseMove={() => setSel(i)}
              onClick={() => run(it)}
            >
              <span className={i === sel ? "" : "text-muted"}>{it.icon}</span>
              <span className="flex-1 truncate">{it.label}</span>
              {it.detail && <span className={`text-[11.5px] ${i === sel ? "opacity-80" : "text-faint"}`}>{it.detail}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function HistoryDialog() {
  const history = useApp((s) => s.history);
  const connections = useApp((s) => s.connections);
  const close = () => useApp.getState().setHistoryOpen(false);
  const clear = useApp((s) => s.clearHistory);
  const openQueryTab = useApp((s) => s.openQueryTab);
  const [q, setQ] = useState("");
  const shown = history.filter((h) => !q || h.sql.toLowerCase().includes(q.toLowerCase()));
  return (
    <Modal
      title="Query history"
      width={820}
      onClose={close}
      footer={
        <>
          <span className="mr-auto text-[12px] text-faint">{history.length} queries · stored on this PC</span>
          <button className="btn-ghost" onClick={clear} disabled={!history.length}>
            Clear
          </button>
          <button className="btn-outline" onClick={close}>
            Close
          </button>
        </>
      }
    >
      <div className="border-b border-border p-3">
        <input className="field" placeholder="Search history…" autoFocus value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="max-h-[55vh] overflow-auto">
        {shown.length === 0 && <div className="p-6 text-center text-[12.5px] text-faint">Nothing here yet.</div>}
        {shown.map((h, i) => {
          const conn = connections.find((c) => c.id === h.connId);
          return (
            <button
              key={i}
              className="block w-full border-b border-border/60 px-4 py-2.5 text-left hover:bg-hover"
              onClick={() => {
                close();
                if (conn) openQueryTab(h.connId, h.database, h.sql + "\n");
              }}
            >
              <div className="mb-1 flex items-center gap-2 text-[11.5px] text-faint">
                <span className={`h-1.5 w-1.5 rounded-full ${h.ok ? "bg-ok" : "bg-danger"}`} />
                {new Date(h.at).toLocaleString()} · {conn?.name ?? "deleted connection"} / {h.database} · {formatDuration(h.durationMs)}
              </div>
              <div className="line-clamp-3 font-mono text-[12px] whitespace-pre-wrap text-text">{h.sql}</div>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}
