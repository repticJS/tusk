import { Database, Moon, Plus, Search, SquareTerminal, Sun, Table2, X } from "lucide-react";
import { useEffect } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { useShallow } from "zustand/react/shallow";
import { ConnectionDialog, PasswordPrompt } from "./components/ConnectionDialog";
import { CommandPalette, HistoryDialog } from "./components/Palette";
import { QueryTab } from "./components/QueryTab";
import { Sidebar } from "./components/Sidebar";
import { TableTab } from "./components/TableTab";
import { useMenu } from "./components/ui";
import { setPasswordPrompter } from "./lib/api";
import { activeConnectionOf, useApp, type Tab } from "./store";

export default function App() {
  const tabs = useApp((s) => s.tabs);
  const activeTabId = useApp((s) => s.activeTabId);
  const connectionDialog = useApp((s) => s.connectionDialog);
  const paletteOpen = useApp((s) => s.paletteOpen);
  const historyOpen = useApp((s) => s.historyOpen);

  useEffect(() => {
    setPasswordPrompter((connId, failed) => useApp.getState().requestPassword(connId, failed));
    void useApp.getState().loadConnections();
  }, []);

  // Global shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useApp.getState();
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      // WebView2 keeps browser shortcuts: reload, find bar, print, view source,
      // downloads. Components handle the ones they use before this runs.
      if (e.key === "F5" || (mod && ["r", "f", "g", "u", "j"].includes(key))) {
        e.preventDefault();
        return;
      }
      if (mod && (key === "p" || key === "k")) {
        e.preventDefault();
        s.setPaletteOpen(!s.paletteOpen);
      } else if (mod && key === "t") {
        e.preventDefault();
        const a = activeConnectionOf(s);
        if (a) s.openQueryTab(a.connId, a.database);
        else s.openConnectionDialog();
      } else if (mod && key === "w") {
        e.preventDefault();
        if (s.activeTabId) s.closeTab(s.activeTabId);
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
            <div className="relative min-h-0 flex-1">
              {tabs.length === 0 && <Welcome />}
              {tabs.map((t) => (
                // Tabs stay mounted so results and scroll position survive switching.
                <div key={t.id} className="absolute inset-0" style={{ display: t.id === activeTabId ? "block" : "none" }}>
                  {t.kind === "query" ? (
                    <QueryTab tab={t} active={t.id === activeTabId} />
                  ) : (
                    <TableTab tab={t} active={t.id === activeTabId} />
                  )}
                </div>
              ))}
            </div>
          </div>
        </Panel>
      </Group>
      <StatusBar />
      {connectionDialog.open && <ConnectionDialog key={connectionDialog.editing?.id ?? "new"} />}
      <PasswordPrompt />
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
  const closeTab = useApp((s) => s.closeTab);
  const connections = useApp((s) => s.connections);
  const openQueryTab = useApp((s) => s.openQueryTab);
  const [menu, openMenu] = useMenu();

  const closeOthers = (keep: Tab) => tabs.filter((t) => t.id !== keep.id).forEach((t) => closeTab(t.id));

  return (
    <div className="flex h-10 shrink-0 items-end border-b border-border bg-panel">
      <div className="flex min-w-0 flex-1 items-end overflow-x-auto [scrollbar-width:none]">
        {tabs.map((t) => {
          const conn = connections.find((c) => c.id === t.connId);
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
                  { label: "Close all", onClick: () => tabs.forEach((x) => closeTab(x.id)) },
                ]);
              }}
              title={`${conn?.name ?? ""} / ${t.database}`}
            >
              {/* Connection color strip: red for production makes mistakes harder. */}
              <span
                className="absolute inset-x-0 top-0 h-[2px]"
                style={{ background: active ? (conn?.color ?? "var(--accent)") : "transparent" }}
              />
              <span className="shrink-0" style={{ color: conn?.color ?? undefined }}>
                {t.kind === "query" ? <SquareTerminal size={13} /> : <Table2 size={13} />}
              </span>
              <span className="min-w-0 flex-1 truncate">{t.title}</span>
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
        onClick={() => {
          const a = activeConnectionOf(useApp.getState());
          if (a) openQueryTab(a.connId, a.database);
          else useApp.getState().openConnectionDialog();
        }}
      >
        <Plus size={15} />
      </button>
      {menu}
    </div>
  );
}

function Welcome() {
  const connections = useApp((s) => s.connections);
  const status = useApp((s) => s.status);
  const connect = useApp((s) => s.connect);
  const openConnectionDialog = useApp((s) => s.openConnectionDialog);
  const openQueryTab = useApp((s) => s.openQueryTab);
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
  const active = useApp(
    useShallow((s) => {
      const a = activeConnectionOf(s);
      const c = a && s.connections.find((x) => x.id === a.connId);
      return { name: c?.name, color: c?.color, database: a?.database, status: c ? s.status[c.id] : undefined };
    }),
  );
  return (
    <div className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-panel px-3 text-[11.5px] text-muted">
      {active.name ? (
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
