import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Bot, Check, Copy, Database, FolderClosed, Server, ShieldAlert, TerminalSquare, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { claudeApi, type ClaudeAccess, type ClaudeLevel, type Folder } from "../lib/api";
import { fmtDuration } from "../lib/format";
import { useApp, type ClaudeTab as ClaudeTabModel } from "../store";
import { Modal, Spinner } from "./ui";

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
              <div key={a.id} className="flex items-start gap-3 border-b border-border px-4 py-1.5 text-[12px] last:border-0" data-activity={a.tool}>
                <span
                  className={`mt-0.5 w-14 shrink-0 text-[11px] font-medium ${
                    a.outcome === "ok" ? "text-ok" : a.outcome === "denied" ? "text-warn" : "text-danger"
                  }`}
                >
                  {a.outcome === "ok" ? "done" : a.outcome === "denied" ? "declined" : "failed"}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate">
                    <span className="font-mono">{a.tool}</span>
                    {a.target && <span className="text-muted"> · {a.target}</span>}
                  </div>
                  {a.detail && <div className="truncate font-mono text-[11px] text-faint">{a.detail}</div>}
                  {a.outcome !== "ok" && <div className="truncate text-[11px] text-muted">{a.summary}</div>}
                </div>
                <span className="shrink-0 text-[11px] text-faint">
                  {a.client} · {ago(a.at)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Claude asking to change something: shown over everything. */
const NONE: never[] = [];

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
