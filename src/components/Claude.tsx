import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Database,
  FolderClosed,
  FolderOpen,
  Server,
  Settings,
  ShieldAlert,
  Square,
  SquareTerminal,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { claudeApi, type ClaudeAccess, type ClaudeActivity, type ClaudeLevel, type Folder } from "../lib/api";
import { fmtDuration } from "../lib/format";
import { useApp, type ClaudeTab as ClaudeTabModel } from "../store";
import { Modal, Spinner } from "./ui";

const NONE: never[] = [];

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** What Claude may do with an item: its own setting, else its folder's, else off. */
export function effectiveAccess(
  access: Record<string, ClaudeAccess>,
  id: string,
  folderId: string | null | undefined,
  folders: Folder[],
): { access: ClaudeAccess; from: string | null } {
  if (access[id]) return { access: access[id], from: null };
  let cur = folderId ?? null;
  for (let i = 0; cur && i <= folders.length; i++) {
    const f = folders.find((x) => x.id === cur);
    if (!f) break;
    if (access[f.id]) return { access: access[f.id], from: f.name };
    cur = f.parentId ?? null;
  }
  return { access: { level: "off", ask: true }, from: null };
}

export function accessLabel(a: ClaudeAccess) {
  if (a.level === "off") return "No access";
  if (a.level === "read") return "Read only";
  return a.ask ? "Read & write, asks first" : "Read & write";
}

/** Level picker plus "ask before changes". Without a setting of its own an item follows its folder. */
function AccessEditor(props: { id: string; name: string; folderId: string | null }) {
  const claude = useApp((s) => s.claude);
  const folders = useApp((s) => s.folders);
  const setAccess = useApp((s) => s.setClaudeAccess);
  const own = claude?.access[props.id];
  const parent = effectiveAccess(claude?.access ?? {}, "\u0000", props.folderId, folders);
  const value = own ? own.level : "inherit";
  const shown = own ?? parent.access;
  return (
    <div className="flex items-center gap-2">
      <select
        className="field h-7 w-auto py-0 text-[12px]"
        value={value}
        aria-label={`Claude access for ${props.name}`}
        onChange={(e) => {
          const v = e.target.value;
          void setAccess(props.id, v === "inherit" ? null : { level: v as ClaudeLevel, ask: own?.ask ?? true });
        }}
      >
        <option value="inherit">
          {parent.from ? `Same as ${parent.from} (${accessLabel(parent.access).toLowerCase()})` : "No access"}
        </option>
        {(parent.from || own?.level === "off") && <option value="off">No access</option>}
        <option value="read">Read only</option>
        <option value="write">Read & write</option>
      </select>
      {shown.level === "write" && (
        <label className={`flex items-center gap-1.5 text-[12px] ${own ? "" : "text-faint"}`}>
          <input
            type="checkbox"
            checked={shown.ask}
            disabled={!own}
            onChange={(e) => void setAccess(props.id, { level: "write", ask: e.target.checked })}
            aria-label={`Ask before changes on ${props.name}`}
          />
          Ask before changes
        </label>
      )}
    </div>
  );
}

function ago(at: number) {
  const d = Date.now() / 1000 - at;
  return d < 45 ? "just now" : `${fmtDuration(d)} ago`;
}

/** What each tool does, while running and once done. */
const TOOL_WORDS: Record<string, [string, string]> = {
  list_connections: ["Looking at what it may use", "Looked at what it may use"],
  db_tables: ["Listing tables", "Listed tables"],
  db_describe: ["Looking at a table", "Looked at a table"],
  db_query: ["Running a query", "Ran a query"],
  db_execute: ["Changing data", "Changed data"],
  db_activity: ["Checking database activity", "Checked database activity"],
  server_status: ["Checking the server", "Checked the server"],
  server_logs: ["Reading logs", "Read logs"],
  server_run: ["Running a command", "Ran a command"],
  files_list: ["Listing files", "Listed files"],
  files_read: ["Reading a file", "Read a file"],
  files_write: ["Writing a file", "Wrote a file"],
  run_saved_command: ["Running a saved command", "Ran a saved command"],
};

const busy = (a: ClaudeActivity) => a.outcome === "running" || a.outcome === "waiting";

function toolWords(a: ClaudeActivity) {
  const w = TOOL_WORDS[a.tool];
  if (!w) return a.tool;
  return busy(a) ? `${w[0]}…` : w[1];
}

function took(ms: number) {
  return ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : fmtDuration(ms / 1000);
}

/** Re-renders every second while `on`. */
function useTicker(on: boolean) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [on]);
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn-ghost h-5 px-1 text-[11px]"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        void writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? <Check size={11} /> : <Copy size={11} />}
    </button>
  );
}

function Block(props: { title: string; text: string; live?: boolean; tall?: boolean; tone?: string }) {
  const ref = useRef<HTMLPreElement>(null);
  // Live output follows the end, like a terminal.
  useLayoutEffect(() => {
    if (props.live && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [props.live, props.text]);
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1 text-[10.5px] font-semibold tracking-wide text-faint uppercase">
        {props.title}
        {props.live && <Spinner size={9} />}
        <div className="flex-1" />
        <CopyButton text={props.text} label={`Copy ${props.title.toLowerCase()}`} />
      </div>
      <pre
        ref={ref}
        className={`selectable overflow-auto rounded border border-border bg-bg px-2 py-1.5 font-mono text-[11px] leading-snug whitespace-pre-wrap break-words ${
          props.tall ? "max-h-72" : "max-h-40"
        } ${props.tone ?? ""}`}
        data-block={props.title}
      >
        {props.text}
      </pre>
    </div>
  );
}

/** Jump from something Claude did to the same place in Tusk. */
function OpenInTusk({ a }: { a: ClaudeActivity }) {
  const exists = useApp((s) =>
    a.targetKind === "database"
      ? s.connections.some((c) => c.id === a.targetId)
      : a.targetKind === "server"
        ? s.sshHosts.some((h) => h.id === a.targetId)
        : a.targetKind === "ftp"
          ? s.ftpSites.some((f) => f.id === a.targetId)
          : false,
  );
  if (!exists) return null;
  const st = useApp.getState();
  const buttons: { label: string; icon: React.ReactNode; run: () => void }[] = [];
  if (a.targetKind === "database") {
    const conn = st.connections.find((c) => c.id === a.targetId);
    const sql = a.tool === "db_query" || a.tool === "db_execute" ? a.input : "";
    buttons.push({
      label: sql ? "Open in query editor" : "Open a query",
      icon: <Database size={11} />,
      run: () => void st.openQueryTab(a.targetId, a.database || conn?.database || "postgres", sql || undefined),
    });
  }
  if (a.targetKind) {
    buttons.push({ label: "Watch in terminal", icon: <Bot size={11} />, run: () => st.openClaudeTerm(a.targetKind as "server", a.targetId) });
  }
  if (a.targetKind === "server") {
    buttons.push({ label: "Open terminal", icon: <SquareTerminal size={11} />, run: () => st.openTerminalTab(a.targetId) });
  }
  if (a.targetKind === "ftp" || (a.targetKind === "server" && a.tool.startsWith("files_"))) {
    buttons.push({
      label: "Browse files",
      icon: <FolderOpen size={11} />,
      run: () => st.openFilesTab({ kind: a.targetKind === "ftp" ? "ftp" : "ssh", id: a.targetId }),
    });
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {buttons.map((b) => (
        <button key={b.label} className="btn h-6 px-2 text-[11.5px]" onClick={b.run}>
          {b.icon} {b.label}
        </button>
      ))}
    </div>
  );
}

/** One thing Claude did, with what it asked for and what it got back. */
function ActivityRow({ a, autoOpen = false }: { a: ClaudeActivity; autoOpen?: boolean }) {
  // Follows `autoOpen` (the newest in the panel) until the user opens or closes it.
  const [chosen, setOpen] = useState<boolean | null>(null);
  const open = chosen ?? autoOpen;
  const running = busy(a);
  useTicker(running);
  const elapsed = Math.max(0, Date.now() / 1000 - a.at);
  const state =
    a.outcome === "waiting"
      ? { text: "needs OK", cls: "text-warn" }
      : a.outcome === "running"
        ? { text: "running", cls: "text-accent" }
        : a.outcome === "ok"
          ? { text: "done", cls: "text-ok" }
          : a.outcome === "denied"
            ? { text: "declined", cls: "text-warn" }
            : a.outcome === "stopped"
              ? { text: "stopped", cls: "text-warn" }
              : { text: "failed", cls: "text-danger" };
  return (
    <div className="border-b border-border last:border-0" data-activity={a.tool} data-outcome={a.outcome}>
      <button
        className="flex w-full items-start gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-hover"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className="mt-0.5 shrink-0 text-faint">{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
        <span className={`mt-0.5 flex w-16 shrink-0 items-center gap-1 text-[11px] font-medium ${state.cls}`}>
          {running && <Spinner size={9} />}
          <span>{state.text}</span>
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate">
            <span title={a.tool}>{toolWords(a)}</span>
            {a.target && <span className="text-muted"> · {a.target}</span>}
          </div>
          {a.detail && <div className="truncate font-mono text-[11px] text-faint">{a.detail}</div>}
          {!open && (a.outcome === "error" || a.outcome === "denied") && <div className="truncate text-[11px] text-muted">{a.summary}</div>}
        </div>
        {running && (
          <span
            role="button"
            tabIndex={0}
            className="btn mt-px h-5 shrink-0 px-1.5 text-[11px] text-danger"
            title="Stop what Claude is running"
            onClick={(e) => {
              e.stopPropagation();
              void claudeApi.stop(a.id);
            }}
          >
            <Square size={9} /> Stop
          </span>
        )}
        <span className="shrink-0 text-right text-[11px] text-faint">
          {a.client} · {running ? took(elapsed * 1000) : ago(a.at)}
          {!running && a.ms > 0 && <div>took {took(a.ms)}</div>}
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-2 px-3 pt-0.5 pb-2.5 pl-[30px]" data-activity-detail>
          {a.input && <Block title={a.tool === "files_write" ? "Path and content" : "Claude asked for"} text={a.input} />}
          {a.outcome === "waiting" && (
            <div className="flex items-center gap-1.5 text-[12px] text-warn">
              <ShieldAlert size={12} /> Waiting for your OK in Tusk.
            </div>
          )}
          {running && a.output && <Block title="Output so far" text={a.output} live tall />}
          {a.outcome === "running" && !a.output && <div className="text-[12px] text-faint">Working on it…</div>}
          {!running && a.result && (
            <Block title="What Claude got back" text={a.result} tall tone={a.outcome === "error" ? "text-danger" : ""} />
          )}
          <OpenInTusk a={a} />
        </div>
      )}
    </div>
  );
}

/** A side panel to watch Claude work while using the rest of Tusk. */
export function ClaudeLivePanel() {
  const open = useApp((s) => s.claudeLive);
  const c = useApp(
    useShallow((s) => ({
      enabled: !!s.claude?.enabled,
      clients: s.claude?.clients.join(", ") ?? "",
      activity: s.claude?.activity,
      follow: s.claudeFollow,
      term: s.claudeTerm,
    })),
  );
  if (!open) return null;
  const st = useApp.getState();
  const items = c.activity ?? NONE;
  const working = items.filter(busy).length;
  return (
    <aside className="flex w-[400px] min-w-[300px] shrink-0 flex-col border-l border-border bg-panel" aria-label="What Claude is doing" data-claude-live>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Bot size={14} className={c.clients ? "text-ok" : "text-muted"} />
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-medium">What Claude is doing</div>
          <div className="truncate text-[11px] text-muted">
            {!c.enabled
              ? "Claude access is off"
              : c.clients
                ? working
                  ? `${c.clients} · working on ${working === 1 ? "one thing" : `${working} things`}`
                  : `${c.clients} connected`
                : "Waiting for Claude to connect"}
          </div>
        </div>
        <button className="btn-ghost h-6 w-6 justify-center p-0" title="Claude settings" aria-label="Claude settings" onClick={() => st.openClaudeTab()}>
          <Settings size={13} />
        </button>
        <button className="btn-ghost h-6 w-6 justify-center p-0" title="Close" aria-label="Close Claude panel" onClick={() => st.setClaudeLive(false)}>
          <X size={13} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {!c.enabled ? (
          <div className="flex flex-col items-start gap-2 p-4 text-[12.5px] text-muted">
            Claude can't use Tusk right now.
            <button className="btn h-7 px-2.5 text-[12px]" onClick={() => st.openClaudeTab()}>
              Set up Claude access
            </button>
          </div>
        ) : items.length === 0 ? (
          <div className="p-4 text-[12.5px] text-faint">Nothing yet. Each thing Claude does in Tusk shows up here as it happens.</div>
        ) : (
          items.slice(0, 100).map((a, i) => <ActivityRow key={a.id} a={a} autoOpen={i === 0} />)
        )}
      </div>
      <div className="flex flex-col gap-1 border-t border-border px-3 py-1.5 text-[11.5px] text-muted">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={c.follow} onChange={(e) => st.setClaudeFollow(e.target.checked)} />
          Open this panel when Claude starts something
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={c.term} onChange={(e) => st.setClaudeTerm(e.target.checked)} />
          Show Claude's commands in a terminal tab
        </label>
      </div>
    </aside>
  );
}

export function ClaudeTab({ active }: { tab: ClaudeTabModel; active: boolean }) {
  const claude = useApp((s) => s.claude);
  const connections = useApp((s) => s.connections);
  const sshHosts = useApp((s) => s.sshHosts);
  const ftpSites = useApp((s) => s.ftpSites);
  const folders = useApp((s) => s.folders);
  const { loadClaude, showToast } = useApp.getState();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [, tick] = useState(0);

  useEffect(() => {
    if (!active) return;
    void loadClaude();
    const t = setInterval(() => tick((n) => n + 1), 20_000);
    return () => clearInterval(t);
  }, [active, loadClaude]);

  if (!claude) {
    return (
      <div className="flex items-center gap-2 p-6 text-[13px] text-muted">
        <Spinner size={12} /> Loading…
      </div>
    );
  }

  const toggle = async () => {
    setBusy(true);
    try {
      await claudeApi.setEnabled(!claude.enabled);
      await loadClaude();
    } catch (e) {
      showToast(errText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const install = async () => {
    try {
      await claudeApi.installDesktop();
      await loadClaude();
      showToast("Added Tusk to the Claude app. Restart Claude to load it.", "ok");
    } catch (e) {
      showToast(errText(e), "error");
    }
  };

  const status = !claude.enabled
    ? "Off: Claude can't reach Tusk."
    : claude.clients.length
      ? `On · ${claude.clients.join(", ")} connected`
      : "On · waiting for Claude to connect";

  const folderPath = (id?: string | null) => {
    const names: string[] = [];
    let cur = id ?? null;
    for (let i = 0; cur && i <= folders.length; i++) {
      const f = folders.find((x) => x.id === cur);
      if (!f) break;
      names.unshift(f.name);
      cur = f.parentId ?? null;
    }
    return names.join(" / ");
  };

  const groups: { title: string; icon: React.ReactNode; items: { id: string; name: string; folderId?: string | null; detail: string }[] }[] = [
    {
      title: "Folders",
      icon: <FolderClosed size={13} className="text-warn" />,
      items: folders.map((f) => ({ id: f.id, name: f.name, folderId: f.parentId ?? null, detail: "Everything inside, unless set below" })),
    },
    {
      title: "Databases",
      icon: <Database size={13} className="text-accent" />,
      items: connections.map((c) => ({ id: c.id, name: c.name, folderId: c.folderId ?? null, detail: `${c.host}/${c.database}` })),
    },
    {
      title: "SSH servers",
      icon: <TerminalSquare size={13} className="text-ok" />,
      items: sshHosts.map((h) => ({ id: h.id, name: h.name, folderId: h.folderId ?? null, detail: `${h.user}@${h.host}` })),
    },
    {
      title: "FTP sites",
      icon: <Server size={13} className="text-muted" />,
      items: ftpSites.map((f) => ({ id: f.id, name: f.name, folderId: f.folderId ?? null, detail: f.host })),
    },
  ].filter((g) => g.items.length);

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto flex max-w-[1000px] flex-col gap-4 p-6">
        <div>
          <div className="flex items-center gap-2 text-[17px] font-semibold tracking-tight">
            <Bot size={18} className="text-accent" /> Claude
          </div>
          <div className="text-[12.5px] text-muted">
            Let Claude (the desktop app or Claude Code) use the databases and servers you choose, through Tusk. Your passwords and keys stay
            in Tusk; Claude only sees results.
          </div>
        </div>

        <div className="flex items-center gap-3 rounded-lg border border-border bg-panel px-4 py-3">
          <button
            role="switch"
            aria-checked={claude.enabled}
            aria-label="Let Claude use Tusk"
            disabled={busy}
            onClick={() => void toggle()}
            className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${claude.enabled ? "bg-accent" : "bg-hover"}`}
          >
            <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${claude.enabled ? "left-[18px]" : "left-0.5"}`} />
          </button>
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] font-medium">Let Claude use Tusk</div>
            <div className="text-[12px] text-muted" data-claude-status>
              {status}
            </div>
          </div>
          {claude.enabled && <span className={`h-2 w-2 rounded-full ${claude.clients.length ? "bg-ok" : "bg-warn"}`} />}
        </div>

        <div className="rounded-lg border border-border bg-panel">
          <div className="border-b border-border px-4 py-2.5 text-[11px] font-semibold tracking-wide text-faint uppercase">Connect Claude</div>
          <div className="flex flex-col gap-3 p-4 text-[12.5px]">
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="font-medium">Claude desktop app</div>
                <div className="text-muted">
                  {claude.setup.desktopInstalled
                    ? "Tusk is in Claude's settings. If Claude was open, restart it."
                    : "Adds Tusk to Claude's settings; restart Claude afterwards."}
                </div>
              </div>
              <button className="btn-outline" onClick={() => void install()}>
                {claude.setup.desktopInstalled ? (
                  <>
                    <Check size={13} className="text-ok" /> Added (add again)
                  </>
                ) : (
                  "Add Tusk to Claude"
                )}
              </button>
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="font-medium">Claude Code</div>
              <div className="text-muted">Run this once in a terminal:</div>
              <div className="flex items-center gap-2">
                <code className="selectable min-w-0 flex-1 truncate rounded-md bg-bg px-2.5 py-1.5 font-mono text-[11.5px]" data-claude-code-command>
                  {claude.setup.codeCommand}
                </code>
                <button
                  className="btn-outline"
                  onClick={() => {
                    void writeText(claude.setup.codeCommand);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                >
                  {copied ? <Check size={13} className="text-ok" /> : <Copy size={13} />} Copy
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-panel">
          <div className="border-b border-border px-4 py-2.5">
            <div className="text-[11px] font-semibold tracking-wide text-faint uppercase">What Claude may use</div>
            <div className="mt-0.5 text-[12px] text-muted">
              Everything starts with no access. Read only can look but not change anything (database queries run in a read-only
              transaction). Read & write can also change data, run commands and write files, and asks you first unless you untick it.
            </div>
          </div>
          {groups.length === 0 && <div className="px-4 py-3 text-[12.5px] text-faint">Add connections in the sidebar first.</div>}
          {groups.map((g) => (
            <div key={g.title} className="border-b border-border last:border-0">
              <div className="flex items-center gap-1.5 px-4 pt-2.5 pb-1 text-[11.5px] font-medium text-muted">
                {g.icon} {g.title}
              </div>
              {g.items.map((it) => (
                <div key={it.id} className="flex items-center gap-3 px-4 py-1.5 text-[12.5px] hover:bg-hover/40" data-claude-item={it.name}>
                  <div className="min-w-0 flex-1">
                    <span className="font-medium">{it.name}</span>
                    <span className="ml-2 text-[11.5px] text-faint">
                      {[folderPath(it.folderId), it.detail].filter(Boolean).join(" · ")}
                    </span>
                  </div>
                  <AccessEditor id={it.id} name={it.name} folderId={it.folderId ?? null} />
                </div>
              ))}
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold tracking-wide text-faint uppercase">What Claude did</span>
            <div className="flex-1" />
            {claude.activity.length > 0 && (
              <button
                className="btn-ghost h-6 px-1.5 text-[11.5px]"
                onClick={() => void claudeApi.clearActivity().then(() => loadClaude())}
              >
                <Trash2 size={11} /> Clear
              </button>
            )}
          </div>
          <div className="overflow-hidden rounded-lg border border-border bg-panel" data-claude-activity>
            {claude.activity.length === 0 && <div className="px-4 py-3 text-[12.5px] text-faint">Nothing yet.</div>}
            {claude.activity.slice(0, 200).map((a) => (
              <ActivityRow key={a.id} a={a} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Claude asking to change something: shown over everything. */

export function ClaudeApprovalDialog() {
  const pending = useApp((s) => s.claude?.pending ?? NONE);
  const [sending, setSending] = useState(false);
  const req = [...pending].sort((a, b) => a.at - b.at)[0];
  if (!req) return null;
  const decide = async (d: "allow" | "session" | "deny") => {
    setSending(true);
    try {
      await claudeApi.decide(req.id, d);
    } finally {
      setSending(false);
      void useApp.getState().loadClaude();
    }
  };
  return (
    <Modal
      title={`${req.client} wants to ${req.title.charAt(0).toLowerCase()}${req.title.slice(1)}`}
      width={620}
      closeOnBackdrop={false}
      onClose={() => void decide("deny")}
      footer={
        <>
          {pending.length > 1 && <span className="mr-auto text-[12px] text-faint">{pending.length - 1} more waiting</span>}
          <button className="btn-outline" disabled={sending} onClick={() => void decide("deny")}>
            Deny
          </button>
          <button className="btn-outline" disabled={sending} onClick={() => void decide("session")} title={`Don't ask again for ${req.tool} on ${req.target} while ${req.client} stays connected`}>
            Allow for this session
          </button>
          <button className="btn-primary" disabled={sending} onClick={() => void decide("allow")}>
            Allow once
          </button>
        </>
      }
    >
      <div className="flex gap-3 p-4" data-claude-approval={req.tool}>
        <ShieldAlert size={22} className="mt-0.5 shrink-0 text-warn" />
        <div className="min-w-0 flex-1 text-[13px]">
          <div>
            On <b>{req.target}</b> <span className="text-faint">({req.tool})</span>
          </div>
          <pre className="selectable mt-2 max-h-[45vh] overflow-auto rounded-md bg-bg px-3 py-2 font-mono text-[12px] whitespace-pre-wrap">
            {req.detail}
          </pre>
          <div className="mt-2 text-[12px] text-faint">Nothing happens until you allow it. Claude is told if you deny.</div>
        </div>
      </div>
    </Modal>
  );
}

/** Claude access for one sidebar item. */
export function ClaudeAccessDialog() {
  const item = useApp((s) => s.claudeAccessItem);
  const claude = useApp((s) => s.claude);
  const close = () => useApp.getState().editClaudeAccess(null);
  useEffect(() => {
    if (item && !claude) void useApp.getState().loadClaude();
  }, [item, claude]);
  if (!item) return null;
  return (
    <Modal
      title={`Claude access: ${item.name}`}
      width={480}
      onClose={close}
      footer={
        <>
          <button
            className="btn-ghost mr-auto"
            onClick={() => {
              close();
              useApp.getState().openClaudeTab();
            }}
          >
            <Bot size={13} /> Open Claude tab
          </button>
          <button className="btn-primary" onClick={close}>
            Done
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3 p-4 text-[12.5px]">
        <div className="text-muted">
          {item.isFolder ? "Applies to everything in this folder that has no setting of its own." : "What Claude may do with this one."}
        </div>
        {claude ? <AccessEditor id={item.id} name={item.name} folderId={item.folderId ?? null} /> : <Spinner size={12} />}
        {claude && !claude.enabled && (
          <div className="rounded-md bg-warn/10 px-3 py-2 text-[12px] text-warn">
            Claude access is turned off overall. Turn it on in the Claude tab.
          </div>
        )}
      </div>
    </Modal>
  );
}
