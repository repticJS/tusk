import { listen } from "@tauri-apps/api/event";
import {
  Activity,
  BellRing,
  Database,
  FileCode2,
  FolderSync,
  LayoutGrid,
  Monitor,
  Moon,
  Plus,
  Radar,
  Radio,
  Search,
  SquareTerminal,
  Sun,
  Table2,
  TerminalSquare,
  Waypoints,
  X,
  Zap,
} from "lucide-react";
import { useEffect } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { useShallow } from "zustand/react/shallow";
import { ConnectionDialog, PasswordPrompt } from "./components/ConnectionDialog";
import { CommandPalette, HistoryDialog } from "./components/Palette";
import { QueryTab } from "./components/QueryTab";
import { Sidebar } from "./components/Sidebar";
import { HostKeyPrompt, SshDialog, SshSecretPrompt } from "./components/SshDialogs";
import { TableTab } from "./components/TableTab";
import { RemoteFileTab } from "./components/RemoteFileTab";
import { FilesTab } from "./components/FilesTab";
import { FtpDialog } from "./components/FtpDialog";
import { TerminalTab } from "./components/TerminalTab";
import { TunnelDialog, TunnelsTab } from "./components/TunnelsTab";
import { DiscoverTab } from "./components/DiscoverTab";
import { ActivityTab } from "./components/ActivityTab";
import { MonitorBell, MonitorTab } from "./components/MonitorTab";
import { CommandDialog, CommandsTab, RunConfirm, RunTab } from "./components/Commands";
import { ImportDialog, ShareDialog } from "./components/ShareDialogs";
import { UpdateChip, UpdateDialog, useUpdateChecks } from "./components/Updater";
import { Modal, useMenu } from "./components/ui";
import { setPasswordPrompter, setSshPrompter } from "./lib/api";
import { activeConnectionOf, isTermTab, useApp, type Tab } from "./store";

/** Ctrl+T / "+": another terminal to the same host, or a query tab on the active database. */
function newTabLikeActive() {
  const s = useApp.getState();
  const tab = s.tabs.find((t) => t.id === s.activeTabId);
  if (tab?.kind === "terminal") return s.openTerminalTab(tab.hostId);
  if (tab?.kind === "local") return s.openLocalTerminal(tab.shellId);
  const a = activeConnectionOf(s);
  if (a) s.openQueryTab(a.connId, a.database);
  else s.openConnectionDialog();
}

export default function App() {
  useUpdateChecks();
  const tabs = useApp((s) => s.tabs);
  const activeTabId = useApp((s) => s.activeTabId);
  const connectionDialog = useApp((s) => s.connectionDialog);
  const sshDialog = useApp((s) => s.sshDialog);
  const ftpDialog = useApp((s) => s.ftpDialog);
  const tunnelDialog = useApp((s) => s.tunnelDialog);
  const paletteOpen = useApp((s) => s.paletteOpen);
  const historyOpen = useApp((s) => s.historyOpen);
  const multiExec = useApp((s) => s.multiExec);
  const setActiveTab = useApp((s) => s.setActiveTab);
  // Tiled multi-exec: its terminals share the tab area in a grid.
  const tiles = multiExec.on && multiExec.tiled ? tabs.filter((t) => multiExec.targets.includes(t.id)) : [];
  const tiled = tiles.length > 0;
  const cols = Math.ceil(Math.sqrt(tiles.length));
  const rows = Math.ceil(tiles.length / Math.max(cols, 1));

  useEffect(() => {
    setPasswordPrompter((connId, failed) => useApp.getState().requestPassword(connId, failed));
    setSshPrompter((info) => useApp.getState().resolveSshProblem(info));
    void useApp
      .getState()
      .loadConnections()
      .then(() => useApp.getState().startAutoTunnels());
    void useApp.getState().loadShells();
    void useApp.getState().loadMonitor();
    // The backend checks hosts in the background and says when anything changed.
    const unlisten = listen("monitor-changed", () => void useApp.getState().loadMonitor());
    return () => void unlisten.then((f) => f());
  }, []);

  // Global shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useApp.getState();
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const inTerminal = !!(e.target as HTMLElement | null)?.closest?.(".xterm");
      // WebView2 keeps browser shortcuts: reload, find bar, print, view source,
      // downloads. Components handle the ones they use before this runs.
      if (e.key === "F5" || (mod && ["r", "f", "g", "u", "j"].includes(key))) {
        e.preventDefault();
        return;
      }
      // In a terminal, Ctrl+W/T/P/K belong to the shell; only the Ctrl+Shift
      // variants (and Ctrl+Tab) reach the app.
      if (inTerminal && !e.shiftKey && e.key !== "Tab") return;
      if (mod && (key === "p" || key === "k")) {
        e.preventDefault();
        s.setPaletteOpen(!s.paletteOpen);
      } else if (mod && key === "t") {
        e.preventDefault();
        newTabLikeActive();
      } else if (mod && key === "w") {
        e.preventDefault();
        if (s.activeTabId) s.askCloseTab(s.activeTabId);
      } else if (mod && e.key === "Tab") {
        e.preventDefault();
        const i = s.tabs.findIndex((t) => t.id === s.activeTabId);
        if (s.tabs.length) {
          const next = (i + (e.shiftKey ? -1 : 1) + s.tabs.length) % s.tabs.length;
          s.setActiveTab(s.tabs[next].id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Block the webview's default context menu except in text fields.
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest("input, textarea, .cm-editor, .selectable")) e.preventDefault();
    };
    window.addEventListener("contextmenu", onCtx);
    return () => window.removeEventListener("contextmenu", onCtx);
  }, []);

  return (
    <div className="flex h-full flex-col">
      <Group orientation="horizontal" className="min-h-0 flex-1">
        <Panel defaultSize="260px" minSize="180px" maxSize="50%">
          <Sidebar />
        </Panel>
        <Separator className="w-px" />
        <Panel minSize="300px">
          <div className="flex h-full flex-col">
            <TabBar />
            {multiExec.on && <MultiExecBar />}
            <div className="relative min-h-0 flex-1">
              {tabs.length === 0 && <Welcome />}
              {tabs.map((t) => {
                const tile = tiles.indexOf(t);
                // Tabs stay mounted so results and scroll position survive switching.
                const style: React.CSSProperties = tiled
                  ? tile < 0
                    ? { display: "none" }
                    : {
                        left: `${((tile % cols) / cols) * 100}%`,
                        top: `${(Math.floor(tile / cols) / rows) * 100}%`,
                        width: `${100 / cols}%`,
                        height: `${100 / rows}%`,
                      }
                  : { display: t.id === activeTabId ? "block" : "none" };
                return (
                <div
                  key={t.id}
                  className={tiled ? "absolute p-px" : "absolute inset-0"}
                  style={style}
                  data-tile={tiled && tile >= 0 ? t.title : undefined}
                  onMouseDownCapture={tiled && t.id !== activeTabId ? () => setActiveTab(t.id) : undefined}
                >
                  <div
                    className={`h-full ${tiled ? `overflow-hidden rounded-sm border ${t.id === activeTabId ? "border-warn" : "border-border"}` : ""}`}
                  >
                  {t.kind === "query" ? (
                    <QueryTab tab={t} active={t.id === activeTabId} />
                  ) : t.kind === "table" ? (
                    <TableTab tab={t} active={t.id === activeTabId} />
                  ) : t.kind === "activity" ? (
                    <ActivityTab tab={t} active={t.id === activeTabId} />
                  ) : isTermTab(t) ? (
                    <TerminalTab tab={t} active={t.id === activeTabId} tiled={tiled} />
                  ) : t.kind === "tunnels" ? (
                    <TunnelsTab tab={t} active={t.id === activeTabId} />
                  ) : t.kind === "discover" ? (
                    <DiscoverTab tab={t} active={t.id === activeTabId} />
                  ) : t.kind === "monitor" ? (
                    <MonitorTab tab={t} active={t.id === activeTabId} />
                  ) : t.kind === "commands" ? (
                    <CommandsTab tab={t} active={t.id === activeTabId} />
                  ) : t.kind === "run" ? (
                    <RunTab tab={t} active={t.id === activeTabId} />
                  ) : t.kind === "files" ? (
                    <FilesTab tab={t} active={t.id === activeTabId} />
                  ) : (
                    <RemoteFileTab tab={t} active={t.id === activeTabId} />
                  )}
                  </div>
                </div>
                );
              })}
            </div>
          </div>
        </Panel>
      </Group>
      <StatusBar />
      {connectionDialog.open && <ConnectionDialog key={connectionDialog.editing?.id ?? "new"} />}
      {sshDialog.open && <SshDialog key={sshDialog.editing?.id ?? "new"} />}
      {ftpDialog.open && <FtpDialog key={ftpDialog.editing?.id || "new"} />}
      {tunnelDialog.open && <TunnelDialog key={tunnelDialog.editing?.id || "new"} />}
      <ShareDialog />
      <CommandDialog />
      <RunConfirm />
      <ImportDialog />
      <PasswordPrompt />
      <SshSecretPrompt />
      <HostKeyPrompt />
      <UnsavedCloseDialog />
      <UpdateDialog />
      {paletteOpen && <CommandPalette />}
      {historyOpen && <HistoryDialog />}
      <Toast />
    </div>
  );
}

function TabBar() {
  const tabs = useApp((s) => s.tabs);
  const activeTabId = useApp((s) => s.activeTabId);
  const setActiveTab = useApp((s) => s.setActiveTab);
  const closeTab = useApp((s) => s.askCloseTab);
  const closeTabs = useApp((s) => s.closeTabs);
  const connections = useApp((s) => s.connections);
  const sshHosts = useApp((s) => s.sshHosts);
  const ftpSites = useApp((s) => s.ftpSites);
  const dirty = useApp((s) => s.dirty);
  const multiExec = useApp((s) => s.multiExec);
  const [menu, openMenu] = useMenu();

  const closeOthers = (keep: Tab) => closeTabs(tabs.filter((t) => t.id !== keep.id).map((t) => t.id));

  return (
    <div className="flex h-10 shrink-0 items-end border-b border-border bg-panel">
      <div className="flex min-w-0 flex-1 items-end overflow-x-auto [scrollbar-width:none]">
        {tabs.map((t) => {
          const conn =
            t.kind === "tunnels" ||
            t.kind === "local" ||
            t.kind === "discover" ||
            t.kind === "monitor" ||
            t.kind === "commands" ||
            t.kind === "run"
              ? undefined
              : t.kind === "files"
                ? t.target && (t.target.kind === "ssh" ? sshHosts : ftpSites).find((h) => h.id === t.target!.id)
                : t.kind === "terminal" || t.kind === "remote"
                  ? (sshHosts.find((h) => h.id === t.hostId) ?? ftpSites.find((f) => f.id === t.hostId))
                  : connections.find((c) => c.id === t.connId);
          const active = t.id === activeTabId;
          return (
            <div
              key={t.id}
              className={`group relative flex h-10 max-w-[220px] min-w-[110px] shrink-0 cursor-default items-center gap-2 border-r border-border pr-1.5 pl-3 text-[12.5px] ${
                active ? "bg-bg text-text" : "text-muted hover:bg-hover/60 hover:text-text"
              }`}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  closeTab(t.id);
                } else if (e.button === 0) setActiveTab(t.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                openMenu(e, [
                  { label: "Close", hint: "Ctrl+W", onClick: () => closeTab(t.id) },
                  { label: "Close others", onClick: () => closeOthers(t) },
                  { label: "Close all", onClick: () => closeTabs(tabs.map((x) => x.id)) },
                ]);
              }}
              title={
                t.kind === "tunnels"
                  ? "SSH tunnels"
                  : t.kind === "discover"
                    ? "Databases and containers"
                    : t.kind === "monitor"
                      ? "Monitoring"
                      : t.kind === "files"
                        ? `Files${conn ? `: ${conn.name}` : ""}`
                      : t.kind === "commands" || t.kind === "run"
                        ? t.title
                  : t.kind === "local"
                    ? `Local terminal: ${t.title}`
                  : t.kind === "terminal"
                    ? `SSH: ${conn?.name ?? ""}`
                    : t.kind === "remote"
                      ? `${conn?.name ?? ""}:${t.path}`
                      : `${conn?.name ?? ""} / ${t.database}`
              }
            >
              {/* Connection color strip: red for production makes mistakes harder. */}
              <span
                className="absolute inset-x-0 top-0 h-[2px]"
                style={{ background: active ? (conn?.color ?? "var(--accent)") : "transparent" }}
              />
              <span className="shrink-0" style={{ color: conn?.color ?? undefined }}>
                {t.kind === "query" ? (
                  <SquareTerminal size={13} />
                ) : t.kind === "table" ? (
                  <Table2 size={13} />
                ) : t.kind === "activity" ? (
                  <Activity size={13} />
                ) : t.kind === "terminal" ? (
                  <TerminalSquare size={13} />
                ) : t.kind === "tunnels" ? (
                  <Waypoints size={13} />
                ) : t.kind === "local" ? (
                  <Monitor size={13} />
                ) : t.kind === "discover" ? (
                  <Radar size={13} />
                ) : t.kind === "monitor" ? (
                  <BellRing size={13} />
                ) : t.kind === "commands" || t.kind === "run" ? (
                  <Zap size={13} />
                ) : t.kind === "files" ? (
                  <FolderSync size={13} />
                ) : (
                  <FileCode2 size={13} />
                )}
              </span>
              <span className="min-w-0 flex-1 truncate">{t.title}</span>
              {multiExec.on && multiExec.targets.includes(t.id) && (
                <Radio size={11} className="shrink-0 text-warn" aria-label="In multi-exec" />
              )}
              {dirty[t.id] && <span className="h-2 w-2 shrink-0 rounded-full bg-warn" title="Unsaved changes" />}
              <button
                className={`shrink-0 rounded p-0.5 hover:bg-hover ${active ? "text-muted" : "opacity-0 group-hover:opacity-100"}`}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => closeTab(t.id)}
                title="Close (Ctrl+W)"
              >
                <X size={13} />
              </button>
            </div>
          );
        })}
      </div>
      <button
        className="btn-ghost mx-1 mb-1.5 h-7 px-1.5"
        title="New query (Ctrl+T)"
        onClick={newTabLikeActive}
      >
        <Plus size={15} />
      </button>
      {menu}
    </div>
  );
}

/** Which terminals multi-exec types into, and the tiled view switch. */
function MultiExecBar() {
  const tabs = useApp((s) => s.tabs);
  const multiExec = useApp((s) => s.multiExec);
  const { toggleMultiExecTarget, setMultiExec, toggleMultiExec } = useApp.getState();
  const terms = tabs.filter(isTermTab);
  return (
    <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-warn/40 bg-warn-soft px-3 py-1 text-[12px]">
      <span className="flex items-center gap-1.5 font-medium text-warn">
        <Radio size={13} /> Multi-exec
      </span>
      <span className="text-muted">Typing goes to:</span>
      {terms.map((t) => (
        <label key={t.id} className="flex items-center gap-1 rounded border border-border bg-panel px-1.5 py-0.5">
          <input type="checkbox" checked={multiExec.targets.includes(t.id)} onChange={() => toggleMultiExecTarget(t.id)} />
          {t.kind === "local" ? <Monitor size={11} className="text-muted" /> : <TerminalSquare size={11} className="text-muted" />}
          {t.title}
        </label>
      ))}
      {terms.length === 0 && <span className="text-faint">no terminals open</span>}
      <div className="flex-1" />
      <button
        className={`btn-ghost h-6 px-1.5 ${multiExec.tiled ? "text-text" : ""}`}
        title={multiExec.tiled ? "Show one terminal at a time" : "Show these terminals side by side"}
        onClick={() => {
          setMultiExec({ tiled: !multiExec.tiled });
          // Keep the focused terminal among the visible tiles.
          const s = useApp.getState();
          if (!multiExec.tiled && !s.multiExec.targets.includes(s.activeTabId ?? "") && s.multiExec.targets[0]) {
            s.setActiveTab(s.multiExec.targets[0]);
          }
        }}
      >
        <LayoutGrid size={13} /> {multiExec.tiled ? "Untile" : "Tile"}
      </button>
      <button className="btn-outline h-6" onClick={toggleMultiExec}>
        Stop
      </button>
    </div>
  );
}

function UnsavedCloseDialog() {
  const id = useApp((s) => s.pendingCloseTab);
  const tab = useApp((s) => s.tabs.find((t) => t.id === s.pendingCloseTab));
  if (!id || !tab) return null;
  const cancel = () => useApp.setState({ pendingCloseTab: null });
  return (
    <Modal
      title="Unsaved changes"
      width={420}
      onClose={cancel}
      footer={
        <>
          <button className="btn-outline" onClick={cancel}>
            Keep editing
          </button>
          <button className="btn-danger" onClick={() => useApp.getState().closeTab(id)}>
            Discard changes
          </button>
        </>
      }
    >
      <div className="p-4 text-[13px]">
        <b>{tab.title}</b> has changes that haven't been saved to the server. Close it anyway?
      </div>
    </Modal>
  );
}

function Welcome() {
  const connections = useApp((s) => s.connections);
  const sshHosts = useApp((s) => s.sshHosts);
  const openTerminalTab = useApp((s) => s.openTerminalTab);
  const status = useApp((s) => s.status);
  const connect = useApp((s) => s.connect);
  const openConnectionDialog = useApp((s) => s.openConnectionDialog);
  const openQueryTab = useApp((s) => s.openQueryTab);
  const shells = useApp((s) => s.shells);
  const openLocalTerminal = useApp((s) => s.openLocalTerminal);
  const shortcuts: [string, string][] = [
    ["Ctrl+P", "Jump to table / command"],
    ["Ctrl+T", "New query tab"],
    ["Ctrl+Enter", "Run statement at cursor"],
    ["Ctrl+Shift+Enter", "Run whole script"],
    ["Ctrl+S", "Save changes / file"],
    ["Ctrl+W", "Close tab"],
  ];
  return (
    <div className="flex h-full items-center justify-center overflow-auto p-8">
      <div className="w-full max-w-[560px]">
        <div className="mb-8 flex items-center gap-3">
          <img src="/icon.svg" alt="" className="h-11 w-11" />
          <div>
            <div className="text-[20px] font-semibold tracking-tight">Tusk</div>
            <div className="text-[13px] text-muted">A fast PostgreSQL client</div>
          </div>
        </div>
        <div className="mb-2 text-[11.5px] font-semibold tracking-wide text-faint uppercase">Connections</div>
        <div className="mb-8 overflow-hidden rounded-lg border border-border bg-panel">
          {sshHosts.map((h) => (
            <button
              key={h.id}
              className="flex w-full items-center gap-3 border-b border-border px-4 py-2.5 text-left hover:bg-hover"
              onClick={() => openTerminalTab(h.id)}
            >
              <TerminalSquare size={15} style={{ color: h.color ?? undefined }} />
              <span className="flex-1">
                <span className="font-medium">{h.name}</span>
                <span className="ml-2 text-[12px] text-faint">
                  ssh {h.user}@{h.host}
                  {h.port === 22 ? "" : `:${h.port}`}
                </span>
              </span>
            </button>
          ))}
          {connections.map((c) => (
            <button
              key={c.id}
              className="flex w-full items-center gap-3 border-b border-border px-4 py-2.5 text-left last:border-0 hover:bg-hover"
              onClick={async () => {
                if (status[c.id]?.state === "connected" || (await connect(c.id))) openQueryTab(c.id, c.database);
              }}
            >
              <Database size={15} style={{ color: c.color ?? undefined }} />
              <span className="flex-1">
                <span className="font-medium">{c.name}</span>
                <span className="ml-2 text-[12px] text-faint">
                  {c.user}@{c.host}:{c.port}/{c.database}
                </span>
              </span>
              {status[c.id]?.state === "connected" && <span className="h-2 w-2 rounded-full bg-ok" />}
            </button>
          ))}
          <button
            className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-accent hover:bg-hover"
            onClick={() => openConnectionDialog()}
          >
            <Plus size={15} /> New connection
          </button>
        </div>
        {shells.length > 0 && (
          <>
            <div className="mb-2 text-[11.5px] font-semibold tracking-wide text-faint uppercase">Local terminals</div>
            <div className="mb-8 flex flex-wrap gap-2">
              {shells.map((sh) => (
                <button key={sh.id} className="btn-outline h-8" onClick={() => openLocalTerminal(sh.id)}>
                  <Monitor size={13} className="text-muted" /> {sh.name}
                </button>
              ))}
            </div>
          </>
        )}
        <div className="mb-2 text-[11.5px] font-semibold tracking-wide text-faint uppercase">Shortcuts</div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-[12.5px]">
          {shortcuts.map(([k, label]) => (
            <div key={k} className="flex items-center justify-between gap-3">
              <span className="text-muted">{label}</span>
              <span className="kbd">{k}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StatusBar() {
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  const setPaletteOpen = useApp((s) => s.setPaletteOpen);
  const ssh = useApp(
    useShallow((s) => {
      const t = s.tabs.find((x) => x.id === s.activeTabId);
      const h = t?.kind === "terminal" || t?.kind === "remote" ? s.sshHosts.find((x) => x.id === t.hostId) : undefined;
      if (t?.kind === "local") return { name: t.title, color: undefined, target: "", local: true };
      return {
        name: h?.name,
        color: h?.color,
        target: h ? `${h.user}@${h.host}${h.port === 22 ? "" : `:${h.port}`}` : "",
        local: false,
      };
    }),
  );
  const active = useApp(
    useShallow((s) => {
      const a = activeConnectionOf(s);
      const c = a && s.connections.find((x) => x.id === a.connId);
      return { name: c?.name, color: c?.color, database: a?.database, status: c ? s.status[c.id] : undefined };
    }),
  );
  const tunnelCount = useApp((s) => Object.keys(s.tunnelStatus).filter((id) => !id.startsWith("test:")).length);
  return (
    <div className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-panel px-3 text-[11.5px] text-muted">
      {ssh.name ? (
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: ssh.color ?? "var(--ok)" }} />
          {ssh.local ? "Local" : "SSH"} · {ssh.name}
          {ssh.target && <span className="text-faint">· {ssh.target}</span>}
        </span>
      ) : active.name ? (
        <span className="flex items-center gap-1.5">
          <span
            className="h-2 w-2 rounded-full"
            style={{ background: active.status?.state === "connected" ? (active.color ?? "var(--ok)") : "var(--faint)" }}
          />
          {active.name} / {active.database}
          {active.status?.serverVersion && <span className="text-faint">· PostgreSQL {active.status.serverVersion}</span>}
        </span>
      ) : (
        <span className="text-faint">Not connected</span>
      )}
      <div className="flex-1" />
      {tunnelCount > 0 && (
        <button
          className="flex items-center gap-1 hover:text-text"
          title="SSH tunnels"
          onClick={() => useApp.getState().openTunnelsTab()}
        >
          <Waypoints size={11} className="text-ok" /> {tunnelCount} tunnel{tunnelCount === 1 ? "" : "s"}
        </button>
      )}
      <MonitorBell />
      <UpdateChip />
      <button className="flex items-center gap-1 hover:text-text" onClick={() => setPaletteOpen(true)}>
        <Search size={11} /> Ctrl+P
      </button>
      <button
        className="hover:text-text"
        title="Toggle theme"
        onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      >
        {theme === "dark" ? <Sun size={12} /> : <Moon size={12} />}
      </button>
    </div>
  );
}

function Toast() {
  const toast = useApp((s) => s.toast);
  if (!toast) return null;
  const tone =
    toast.tone === "error"
      ? "border-danger/40 bg-panel text-text"
      : toast.tone === "ok"
        ? "border-ok/40 bg-panel text-text"
        : "border-border bg-panel text-text";
  return (
    <div className="pointer-events-none fixed right-4 bottom-10 z-[3000] flex justify-end">
      <div className={`pointer-events-auto max-w-[520px] rounded-lg border px-3.5 py-2.5 text-[12.5px] shadow-xl ${tone}`}>
        <span
          className={`mr-2 inline-block h-2 w-2 rounded-full ${
            toast.tone === "error" ? "bg-danger" : toast.tone === "ok" ? "bg-ok" : "bg-accent"
          }`}
        />
        <span className="selectable">{toast.text}</span>
      </div>
    </div>
  );
}
