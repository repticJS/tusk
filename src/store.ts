import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  api,
  DbError,
  filesApi,
  folderApi,
  ftpApi,
  localApi,
  rdpApi,
  claudeApi,
  sshApi,
  tunnelApi,
  withSshPrompts,
  commandsApi,
  discoverApi,
  monitorApi,
  pm2Api,
  systemdApi,
  type AppErrorInfo,
  type ContainerAction,
  type ContainerInfo,
  type ConnectionConfig,
  type FilesTarget,
  type Folder,
  type FtpSite,
  type ItemKind,
  type RdpConfig,
  type ClaudeAccess,
  type ClaudeState,
  type MonitorSettings,
  type MonitorView,
  type Pm2Action,
  type ServiceAction,
  type SavedCommand,
  type ScanResult,
  type SessionRef,
  type Shell,
  type SshHost,
  type TunnelConfig,
  type TunnelStatus,
} from "./lib/api";
import * as meta from "./lib/meta";

export interface QueryTab {
  id: string;
  kind: "query";
  title: string;
  connId: string;
  database: string;
  sql: string;
  filePath?: string;
}

export interface TableTab {
  id: string;
  kind: "table";
  title: string;
  connId: string;
  database: string;
  schema: string;
  name: string;
  objKind: meta.RelKind;
}

/** Live sessions, locks and health of one database (pg_stat_activity…). */
export interface ActivityTab {
  id: string;
  kind: "activity";
  title: string;
  connId: string;
  database: string;
}

export interface TerminalTab {
  id: string;
  kind: "terminal";
  title: string;
  hostId: string;
  /** Run this instead of the login shell (container logs, a shell inside a container). */
  command?: string;
}

/** A shell on this PC (PowerShell, cmd, WSL…). */
export interface LocalTab {
  id: string;
  kind: "local";
  title: string;
  shellId: string;
  /** Program and arguments to run instead of the shell. */
  command?: string[];
}

/** Saved commands (deploy scripts and the like). */
export interface CommandsTab {
  id: string;
  kind: "commands";
  title: string;
}

/** Output of one run of a command on its hosts. */
export interface RunTab {
  id: string;
  kind: "run";
  title: string;
  runId: string;
}

export interface RunHost {
  hostId: string;
  name: string;
  output: string;
  status: "running" | "ok" | "failed" | "cancelled";
  exit?: number | null;
  error?: string;
  /** The error was a login problem the user can fix and retry. */
  loginProblem?: AppErrorInfo;
  started: number;
  ended?: number;
}

export interface RunState {
  title: string;
  script: string;
  stopOnError: boolean;
  hosts: RunHost[];
  /** The backend run in progress, for cancelling. */
  backendId?: string;
}

/** Background monitoring: hosts, problems, alert history. */
export interface MonitorTab {
  id: string;
  kind: "monitor";
  title: string;
}

/** Databases and containers found on this PC and the SSH hosts. */
export interface DiscoverTab {
  id: string;
  kind: "discover";
  title: string;
}

/** A scan of "local" (this PC) or an SSH host id. */
export interface ScanState {
  state: "scanning" | "done" | "error";
  result?: ScanResult;
  error?: string;
  at?: number;
}

export interface TerminalOptions {
  command?: string;
  title?: string;
}

/** A remote file opened for editing over a terminal's SFTP connection, or a
 * Files tab's connection (`filesId`). */
export interface RemoteFileTab {
  id: string;
  kind: "remote";
  title: string;
  termId: string;
  /** SSH host, or FTP site for a Files tab on one. */
  hostId: string;
  path: string;
  filesId?: string;
}

/** Claude's access to Tusk: switch, setup, permissions, activity. */
export interface ClaudeTab {
  id: string;
  kind: "claude";
  title: string;
}

/** A remote desktop (RDP) session. */
export interface RdpTab {
  id: string;
  kind: "rdp";
  title: string;
  connId: string;
}

/** File manager: this PC on one side, a server (SFTP or FTP) on the other. */
export interface FilesTab {
  id: string;
  kind: "files";
  title: string;
  /** null until a server is picked. */
  target: FilesTarget | null;
}

/** The SSH tunnel manager (one at most). */
export interface TunnelsTab {
  id: string;
  kind: "tunnels";
  title: string;
}

/** Tabs bound to a database connection. */
export type DbTab = QueryTab | TableTab | ActivityTab;
export type Tab =
  | DbTab
  | TerminalTab
  | LocalTab
  | RemoteFileTab
  | FilesTab
  | RdpTab
  | ClaudeTab
  | TunnelsTab
  | DiscoverTab
  | MonitorTab
  | CommandsTab
  | RunTab;

/** Tabs with a terminal in them. */
export const isTermTab = (t: Tab | undefined): t is TerminalTab | LocalTab =>
  !!t && (t.kind === "terminal" || t.kind === "local");

export interface MultiExec {
  /** Typing in one target terminal goes to all of them. */
  on: boolean;
  targets: string[];
  /** Show the targets side by side. */
  tiled: boolean;
}

export const isDbTab = (t: Tab | undefined): t is DbTab =>
  !!t && (t.kind === "query" || t.kind === "table" || t.kind === "activity");

export interface FilePanelPrefs {
  open: boolean;
  follow: boolean;
  showHidden: boolean;
}

export interface HistoryEntry {
  sql: string;
  connId: string;
  database: string;
  at: number;
  durationMs: number;
  ok: boolean;
}

export interface DbCache {
  schemas?: string[];
  contents: Record<string, meta.SchemaContents | undefined>;
  completion?: Record<string, Record<string, string[]>>;
  relations?: meta.Relation[];
}

export type ConnStatus = { state: "connecting" | "connected" | "error"; serverVersion?: string; error?: string };

interface PasswordRequest {
  connId: string;
  failed: boolean;
  resolve: (pw: string | null) => void;
}

export interface SshSecretRequest {
  hostId: string;
  what: "password" | "passphrase";
  message?: string;
  resolve: (r: { secret: string; save: boolean } | null) => void;
}

export interface HostKeyRequest {
  hostId: string;
  message: string;
  key: string;
  changed: boolean;
  /** A remote desktop's TLS certificate rather than an SSH host key. */
  certificate?: boolean;
  resolve: (accept: boolean) => void;
}

interface State {
  theme: "dark" | "light";
  rowLimit: number;
  filePanel: FilePanelPrefs;
  /** Show the server stats strip under SSH terminals. */
  statsBar: boolean;
  connections: ConnectionConfig[];
  sshHosts: SshHost[];
  ftpSites: FtpSite[];
  rdpConnections: RdpConfig[];
  folders: Folder[];
  /** Folder ids the user has collapsed (folders start open). */
  collapsedFolders: string[];
  /** A folder whose name is being edited inline in the sidebar. */
  renamingFolderId: string | null;
  status: Record<string, ConnStatus | undefined>;
  databases: Record<string, string[] | undefined>;
  cache: Record<string, DbCache | undefined>;
  tabs: Tab[];
  activeTabId: string | null;
  /** Tabs with unsaved edits (remote files). */
  dirty: Record<string, boolean | undefined>;
  /** A tab with unsaved edits the user asked to close. */
  pendingCloseTab: string | null;
  history: HistoryEntry[];
  tunnels: TunnelConfig[];
  /** Running tunnels by id, including database connections' ("db:<id>"). */
  tunnelStatus: Record<string, TunnelStatus | undefined>;
  /** Tunnels being started, and why the last start failed. */
  tunnelBusy: Record<string, boolean | undefined>;
  tunnelErrors: Record<string, string | undefined>;
  shells: Shell[];
  multiExec: MultiExec;
  scans: Record<string, ScanState | undefined>;
  monitor: MonitorView | null;
  commands: SavedCommand[];
  runs: Record<string, RunState | undefined>;
  /** Command dialog: open with these starting values. */
  commandDialog: { editing: Partial<SavedCommand> } | null;
  /** A command waiting for "Run" in the confirmation dialog. */
  pendingRun: SavedCommand | null;
  /** Target to bring into view when the Discover tab opens. */
  discoverFocus: string | null;

  /** `password` prefills the password field (from a scanned container). */
  connectionDialog: { open: boolean; editing?: ConnectionConfig; password?: string };
  sshDialog: { open: boolean; editing?: SshHost };
  ftpDialog: { open: boolean; editing?: FtpSite };
  rdpDialog: { open: boolean; editing?: RdpConfig };
  claude: ClaudeState | null;
  /** Item whose Claude access is being edited from the sidebar. */
  claudeAccessItem: { id: string; name: string; folderId?: string | null; isFolder?: boolean } | null;
  /** A remote desktop tab shown full screen (the rest of Tusk hidden). */
  fullScreenTab: string | null;
  tunnelDialog: { open: boolean; editing?: Partial<TunnelConfig> };
  /** Folder being shared. */
  shareFolderId: string | null;
  /** Import dialog: open, and the folder to import into (null: top level). */
  importDialog: { parentId: string | null } | null;
  passwordRequest: PasswordRequest | null;
  sshSecretRequest: SshSecretRequest | null;
  hostKeyRequest: HostKeyRequest | null;
  paletteOpen: boolean;
  historyOpen: boolean;
  toast: { id: number; text: string; tone: "ok" | "error" | "info" } | null;

  setTheme(t: "dark" | "light"): void;
  setRowLimit(n: number): void;
  loadConnections(): Promise<void>;
  openConnectionDialog(editing?: ConnectionConfig, password?: string): void;
  closeConnectionDialog(): void;
  openSshDialog(editing?: SshHost): void;
  closeSshDialog(): void;
  deleteSshHost(id: string): Promise<void>;
  openTerminalTab(hostId: string, opts?: TerminalOptions): void;
  openRemoteFile(termId: string, hostId: string, path: string, filesId?: string): void;
  loadClaude(): Promise<void>;
  openClaudeTab(): void;
  setClaudeAccess(id: string, access: ClaudeAccess | null): Promise<void>;
  editClaudeAccess(item: State["claudeAccessItem"]): void;
  openRdpDialog(editing?: RdpConfig): void;
  closeRdpDialog(): void;
  deleteRdp(id: string): Promise<void>;
  /** Opens a remote desktop tab (or switches to the open one). */
  openRdpTab(connId: string): void;
  setFullScreenTab(id: string | null): void;
  openFtpDialog(editing?: FtpSite): void;
  closeFtpDialog(): void;
  deleteFtpSite(id: string): Promise<void>;
  /** Opens a Files tab, connected to `target` when given (reusing an open one). */
  openFilesTab(target?: FilesTarget | null): void;
  setFilesTarget(tabId: string, target: FilesTarget | null): void;
  /** Connects a Files tab's session, prompting for passwords, host keys and certificates. */
  connectFiles(sessionId: string, target: FilesTarget): Promise<{ path: string; home: string }>;
  setFilePanel(patch: Partial<FilePanelPrefs>): void;
  setStatsBar(on: boolean): void;
  setDirty(id: string, dirty: boolean): void;
  createFolder(parentId: string | null): Promise<void>;
  renameFolder(id: string, name: string): Promise<void>;
  deleteFolder(id: string): Promise<void>;
  moveItems(items: { kind: ItemKind; id: string }[], folderId: string | null): Promise<void>;
  toggleFolder(id: string, open?: boolean): void;
  setRenamingFolder(id: string | null): void;
  requestSshSecret(r: Omit<SshSecretRequest, "resolve">): Promise<{ secret: string; save: boolean } | null>;
  resolveSshSecret(r: { secret: string; save: boolean } | null): void;
  requestHostKey(r: Omit<HostKeyRequest, "resolve">): Promise<boolean>;
  resolveHostKey(accept: boolean): void;
  /** Prompts about an SSH login problem; true when the caller should retry. */
  resolveSshProblem(info: AppErrorInfo): Promise<boolean>;
  loadTunnels(): Promise<void>;
  refreshTunnelStatus(): Promise<void>;
  startTunnel(id: string): Promise<boolean>;
  stopTunnel(id: string): Promise<void>;
  saveTunnel(t: TunnelConfig): Promise<boolean>;
  deleteTunnel(id: string): Promise<void>;
  startAutoTunnels(): Promise<void>;
  openTunnelDialog(editing?: Partial<TunnelConfig>): void;
  closeTunnelDialog(): void;
  openShareDialog(folderId: string | null): void;
  openImportDialog(parentId?: string | null): void;
  closeImportDialog(): void;
  openTunnelsTab(): void;
  loadShells(): Promise<void>;
  /** Opens a local terminal; the first detected shell when none is given. */
  openLocalTerminal(shellId?: string, opts?: { command?: string[]; title?: string }): void;
  /** Scans "local" or an SSH host id; `viaTerminal` reuses that terminal's connection. */
  scan(target: string, viaTerminal?: string): Promise<void>;
  scanAll(): Promise<void>;
  containerAction(target: string, c: ContainerInfo, action: ContainerAction): Promise<void>;
  /** Re-reads just the PM2 apps of a scanned target. */
  pm2Refresh(target: string): Promise<void>;
  /** Runs a PM2 action; `app` is an id, a name or "all". Resolves true on success. */
  pm2Action(target: string, action: Pm2Action, app?: string, label?: string): Promise<boolean>;
  pm2Start(target: string, app: { script: string; name: string; cwd: string; instances: number }): Promise<boolean>;
  pm2Terminal(target: string, kind: "logs" | "monit", app?: { id: number; name: string }): Promise<void>;
  /** Runs a systemd action; when it needs a sudo password, offers a terminal instead. */
  serviceAction(target: string, unit: string, action: ServiceAction): Promise<void>;
  serviceTerminal(target: string, unit: string, kind: "logs" | "action", action?: ServiceAction): Promise<void>;
  openDiscoverTab(focus?: string): void;
  loadMonitor(): Promise<void>;
  saveMonitor(patch: Partial<MonitorSettings>): Promise<void>;
  setMonitored(hostId: string, on: boolean): Promise<void>;
  openMonitorTab(): void;
  loadCommands(): Promise<void>;
  saveCommand(c: SavedCommand): Promise<boolean>;
  deleteCommand(id: string): Promise<void>;
  openCommandDialog(editing?: Partial<SavedCommand>): void;
  closeCommandDialog(): void;
  openCommandsTab(): void;
  /** Runs a command, asking first when it says so (unless `confirmed`). */
  runCommand(c: SavedCommand, confirmed?: boolean): void;
  /** Runs again on some hosts of an earlier run (all when omitted). */
  rerun(runId: string, hostIds?: string[]): void;
  cancelRun(runId: string): void;
  setMultiExec(patch: Partial<MultiExec>): void;
  /** Turns multi-exec on (for every open terminal) or off. */
  toggleMultiExec(): void;
  toggleMultiExecTarget(id: string): void;
  connect(connId: string): Promise<boolean>;
  disconnect(connId: string): Promise<void>;
  deleteConnection(connId: string): Promise<void>;
  loadSchemas(connId: string, database: string, force?: boolean): Promise<void>;
  loadSchema(connId: string, database: string, schema: string, force?: boolean): Promise<void>;
  loadCompletion(connId: string, database: string, force?: boolean): Promise<void>;
  refresh(connId: string, database: string): Promise<void>;

  openQueryTab(connId: string, database: string, sql?: string, title?: string): string;
  openTableTab(connId: string, database: string, schema: string, name: string, kind: meta.RelKind): void;
  openActivityTab(connId: string, database: string): void;
  updateTab(id: string, patch: Partial<QueryTab>): void;
  closeTab(id: string): void;
  /** Closes a tab, asking first if it has unsaved edits. */
  askCloseTab(id: string): void;
  /** Closes several tabs, keeping (and reporting) ones with unsaved edits. */
  closeTabs(ids: string[]): void;
  setActiveTab(id: string): void;
  addHistory(e: HistoryEntry): void;
  clearHistory(): void;
  showToast(text: string, tone?: "ok" | "error" | "info"): void;
  requestPassword(connId: string, failed: boolean): Promise<string | null>;
  resolvePassword(pw: string | null): void;
  setPaletteOpen(o: boolean): void;
  setHistoryOpen(o: boolean): void;
}

export const metaSession = (connId: string, database: string): SessionRef => ({
  connId,
  database,
  purpose: "meta",
});

export const tabSession = (tab: DbTab): SessionRef => ({
  connId: tab.connId,
  database: tab.database,
  // Query and activity tabs get their own connection; table tabs share "meta".
  purpose: tab.kind === "query" ? `tab:${tab.id}` : tab.kind === "activity" ? `activity:${tab.id}` : "meta",
});

export const cacheKey = (connId: string, database: string) => `${connId}\u001f${database}`;

const uid = () => Math.random().toString(36).slice(2, 10);

let toastSeq = 0;

export const useApp = create<State>()(
  persist(
    (set, get) => ({
      theme: "dark",
      rowLimit: 10000,
      filePanel: { open: true, follow: true, showHidden: false },
      statsBar: true,
      connections: [],
      sshHosts: [],
      ftpSites: [],
      rdpConnections: [],
      folders: [],
      collapsedFolders: [],
      renamingFolderId: null,
      status: {},
      databases: {},
      cache: {},
      tabs: [],
      activeTabId: null,
      dirty: {},
      pendingCloseTab: null,
      history: [],
      tunnels: [],
      tunnelStatus: {},
      tunnelBusy: {},
      tunnelErrors: {},
      shells: [],
      multiExec: { on: false, targets: [], tiled: false },
      scans: {},
      monitor: null,
      commands: [],
      runs: {},
      commandDialog: null,
      pendingRun: null,
      discoverFocus: null,
      connectionDialog: { open: false },
      sshDialog: { open: false },
      ftpDialog: { open: false },
      rdpDialog: { open: false },
      claude: null,
      claudeAccessItem: null,
      fullScreenTab: null,
      tunnelDialog: { open: false },
      shareFolderId: null,
      importDialog: null,
      passwordRequest: null,
      sshSecretRequest: null,
      hostKeyRequest: null,
      paletteOpen: false,
      historyOpen: false,
      toast: null,

      setTheme(theme) {
        // Set before React re-renders so canvas-drawn parts read the new CSS variables.
        document.documentElement.dataset.theme = theme;
        set({ theme });
      },
      setRowLimit: (rowLimit) => set({ rowLimit }),

      async loadConnections() {
        const [connections, sshHosts, folders, tunnels, commands, ftpSites, rdpConnections] = await Promise.all([
          api.listConnections(),
          sshApi.list(),
          folderApi.list(),
          tunnelApi.list(),
          commandsApi.list(),
          ftpApi.list(),
          rdpApi.list(),
        ]);
        // Drop tabs whose connection or host no longer exists.
        const ids = new Set([
          ...connections.map((c) => c.id),
          ...sshHosts.map((h) => h.id),
          ...ftpSites.map((f) => f.id),
          ...rdpConnections.map((r) => r.id),
        ]);
        const tabs = get().tabs.filter(
          (t) =>
            t.kind === "files"
              ? !t.target || ids.has(t.target.id)
              : t.kind === "rdp"
                ? ids.has(t.connId)
                : t.kind === "claude" ||
                  t.kind === "tunnels" ||
                t.kind === "discover" ||
                t.kind === "monitor" ||
                t.kind === "commands" ||
                t.kind === "run" ||
                t.kind === "local" ||
                ids.has(t.kind === "terminal" || t.kind === "remote" ? t.hostId : t.connId),
        );
        const activeTabId = tabs.some((t) => t.id === get().activeTabId)
          ? get().activeTabId
          : (tabs[0]?.id ?? null);
        set({ connections, sshHosts, ftpSites, rdpConnections, folders, tunnels, commands, tabs, activeTabId });
      },

      openConnectionDialog: (editing, password) => set({ connectionDialog: { open: true, editing, password } }),
      closeConnectionDialog: () => set({ connectionDialog: { open: false } }),
      openSshDialog: (editing) => set({ sshDialog: { open: true, editing } }),
      closeSshDialog: () => set({ sshDialog: { open: false } }),

      async deleteSshHost(id) {
        try {
          await sshApi.remove(id);
        } catch (e) {
          get().showToast(e instanceof Error ? e.message : String(e), "error");
          return;
        }
        set((s) => {
          const tabs = s.tabs.filter((t) => !((t.kind === "terminal" || t.kind === "remote") && t.hostId === id));
          return {
            tabs,
            activeTabId: tabs.some((t) => t.id === s.activeTabId) ? s.activeTabId : (tabs[0]?.id ?? null),
          };
        });
        await get().loadConnections();
        await get().refreshTunnelStatus();
      },

      openTerminalTab(hostId, opts) {
        const host = get().sshHosts.find((h) => h.id === hostId);
        if (!host) return;
        const same = get().tabs.filter((t) => t.kind === "terminal" && t.hostId === hostId && !t.command).length;
        const id = uid();
        const title = opts?.title ?? (same ? `${host.name} (${same + 1})` : host.name);
        const tab: TerminalTab = { id, kind: "terminal", hostId, title, command: opts?.command };
        set((s) => ({
          tabs: [...s.tabs, tab],
          activeTabId: id,
          multiExec: s.multiExec.on ? { ...s.multiExec, targets: [...s.multiExec.targets, id] } : s.multiExec,
        }));
      },

      openRemoteFile(termId, hostId, path, filesId) {
        const existing = get().tabs.find(
          (t) => t.kind === "remote" && t.termId === termId && t.filesId === filesId && t.path === path,
        );
        if (existing) return set({ activeTabId: existing.id });
        const id = uid();
        const tab: RemoteFileTab = { id, kind: "remote", termId, hostId, path, filesId, title: path.split("/").pop() || path };
        set((s) => ({ tabs: [...s.tabs, tab], activeTabId: id }));
      },

      async loadClaude() {
        try {
          set({ claude: await claudeApi.state() });
        } catch {
          // Shown as loading in the Claude tab.
        }
      },

      openClaudeTab() {
        const existing = get().tabs.find((t) => t.kind === "claude");
        if (existing) return set({ activeTabId: existing.id });
        const tab: ClaudeTab = { id: uid(), kind: "claude", title: "Claude" };
        set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
        void get().loadClaude();
      },

      async setClaudeAccess(id, access) {
        try {
          await claudeApi.setAccess(id, access);
        } catch (e) {
          get().showToast(e instanceof Error ? e.message : String(e), "error");
        }
        await get().loadClaude();
      },

      editClaudeAccess: (claudeAccessItem) => set({ claudeAccessItem }),

      openRdpDialog: (editing) => set({ rdpDialog: { open: true, editing } }),
      closeRdpDialog: () => set({ rdpDialog: { open: false } }),

      async deleteRdp(id) {
        try {
          await rdpApi.remove(id);
        } catch (e) {
          get().showToast(e instanceof Error ? e.message : String(e), "error");
          return;
        }
        await get().loadConnections();
      },

      openRdpTab(connId) {
        const conn = get().rdpConnections.find((r) => r.id === connId);
        if (!conn) return;
        const existing = get().tabs.find((t) => t.kind === "rdp" && t.connId === connId);
        if (existing) return set({ activeTabId: existing.id });
        const tab: RdpTab = { id: uid(), kind: "rdp", title: conn.name, connId };
        set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
      },

      setFullScreenTab: (fullScreenTab) => set({ fullScreenTab }),

      openFtpDialog: (editing) => set({ ftpDialog: { open: true, editing } }),
      closeFtpDialog: () => set({ ftpDialog: { open: false } }),

      async deleteFtpSite(id) {
        try {
          await ftpApi.remove(id);
        } catch (e) {
          get().showToast(e instanceof Error ? e.message : String(e), "error");
          return;
        }
        await get().loadConnections();
      },

      openFilesTab(target = null) {
        const name = (t: FilesTarget) =>
          (t.kind === "ssh" ? get().sshHosts.find((h) => h.id === t.id) : get().ftpSites.find((f) => f.id === t.id))?.name ?? "Files";
        if (target) {
          const existing = get().tabs.find((t) => t.kind === "files" && t.target?.kind === target.kind && t.target.id === target.id);
          if (existing) return set({ activeTabId: existing.id });
        }
        const tab: FilesTab = { id: uid(), kind: "files", title: target ? name(target) : "Files", target };
        set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
      },

      setFilesTarget(tabId, target) {
        const name = target
          ? ((target.kind === "ssh" ? get().sshHosts : get().ftpSites).find((h) => h.id === target.id)?.name ?? "Files")
          : "Files";
        set((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId && t.kind === "files" ? { ...t, target, title: name } : t)) }));
      },

      async connectFiles(sessionId, target) {
        for (let attempt = 0; ; attempt++) {
          try {
            return await withSshPrompts(() => filesApi.open(sessionId, target));
          } catch (e) {
            const kind = e instanceof DbError ? e.info.kind : null;
            const site = get().ftpSites.find((f) => f.id === target.id);
            if (target.kind !== "ftp" || !site || attempt > 4) throw e;
            if (kind === "FTP_PASSWORD_REQUIRED" || kind === "FTP_AUTH_FAILED") {
              const r = await get().requestSshSecret({
                hostId: site.id,
                what: "password",
                message: kind === "FTP_AUTH_FAILED" ? (e as DbError).message : undefined,
              });
              if (!r) throw e;
              await ftpApi.setPassword(site.id, r.secret, r.save);
              continue;
            }
            throw e;
          }
        }
      },

      setFilePanel: (patch) => set((s) => ({ filePanel: { ...s.filePanel, ...patch } })),
      setStatsBar: (statsBar) => set({ statsBar }),
      async createFolder(parentId) {
        const id = crypto.randomUUID();
        try {
          await folderApi.save({ id, name: "New folder", parentId });
          if (parentId) get().toggleFolder(parentId, true);
          await get().loadConnections();
          set({ renamingFolderId: id });
        } catch (e) {
          get().showToast(e instanceof Error ? e.message : String(e), "error");
        }
      },

      async renameFolder(id, name) {
        const folder = get().folders.find((f) => f.id === id);
        set({ renamingFolderId: null });
        if (!folder || !name.trim() || name.trim() === folder.name) return;
        try {
          await folderApi.save({ ...folder, name: name.trim() });
          await get().loadConnections();
        } catch (e) {
          get().showToast(e instanceof Error ? e.message : String(e), "error");
        }
      },

      async deleteFolder(id) {
        try {
          await folderApi.remove(id);
          set((s) => ({ collapsedFolders: s.collapsedFolders.filter((f) => f !== id) }));
          await get().loadConnections();
        } catch (e) {
          get().showToast(e instanceof Error ? e.message : String(e), "error");
        }
      },

      async moveItems(items, folderId) {
        try {
          await folderApi.move(items, folderId);
          if (folderId) get().toggleFolder(folderId, true);
          await get().loadConnections();
        } catch (e) {
          get().showToast(e instanceof Error ? e.message : String(e), "error");
        }
      },

      toggleFolder(id, open) {
        set((s) => {
          const isOpen = !s.collapsedFolders.includes(id);
          const want = open ?? !isOpen;
          if (want === isOpen) return {};
          return {
            collapsedFolders: want ? s.collapsedFolders.filter((f) => f !== id) : [...s.collapsedFolders, id],
          };
        });
      },

      setRenamingFolder: (renamingFolderId) => set({ renamingFolderId }),

      setDirty: (id, dirty) => {
        if (!!get().dirty[id] !== dirty) set((s) => ({ dirty: { ...s.dirty, [id]: dirty } }));
      },

      requestSshSecret(r) {
        return new Promise((resolve) => {
          get().sshSecretRequest?.resolve(null);
          set({ sshSecretRequest: { ...r, resolve } });
        });
      },
      resolveSshSecret(r) {
        get().sshSecretRequest?.resolve(r);
        set({ sshSecretRequest: null });
      },
      requestHostKey(r) {
        return new Promise((resolve) => {
          get().hostKeyRequest?.resolve(false);
          set({ hostKeyRequest: { ...r, resolve } });
        });
      },
      resolveHostKey(accept) {
        get().hostKeyRequest?.resolve(accept);
        set({ hostKeyRequest: null });
      },

      async resolveSshProblem(info) {
        const hostId = info.sshHost;
        const kind = info.kind?.replace(/^SSH_/, "");
        if (!hostId) return false;
        if (kind === "HOSTKEY_UNKNOWN" || kind === "HOSTKEY_CHANGED") {
          const ok = await get().requestHostKey({
            hostId,
            message: info.message.replace(/^SSH [^:]*: /, ""),
            key: info.detail ?? "",
            changed: kind === "HOSTKEY_CHANGED",
          });
          if (ok && info.hint) await sshApi.acceptHostKey(hostId, info.hint);
          return ok;
        }
        if (kind === "PASSWORD_REQUIRED" || kind === "AUTH_FAILED" || kind === "PASSPHRASE_REQUIRED") {
          const r = await get().requestSshSecret({
            hostId,
            what: kind === "PASSPHRASE_REQUIRED" ? "passphrase" : "password",
            message: kind === "PASSWORD_REQUIRED" ? undefined : info.message,
          });
          if (r) await sshApi.setSecret(hostId, r.secret, r.save);
          return !!r;
        }
        return false;
      },

      async loadTunnels() {
        set({ tunnels: await tunnelApi.list() });
      },

      async refreshTunnelStatus() {
        const list = await tunnelApi.status();
        set({ tunnelStatus: Object.fromEntries(list.map((t) => [t.id, t])) });
      },

      async startTunnel(id) {
        if (get().tunnelBusy[id]) return false;
        set((s) => ({ tunnelBusy: { ...s.tunnelBusy, [id]: true }, tunnelErrors: { ...s.tunnelErrors, [id]: undefined } }));
        try {
          await withSshPrompts(() => tunnelApi.start(id));
          return true;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          set((s) => ({ tunnelErrors: { ...s.tunnelErrors, [id]: msg } }));
          return false;
        } finally {
          set((s) => ({ tunnelBusy: { ...s.tunnelBusy, [id]: false } }));
          await get().refreshTunnelStatus();
        }
      },

      async stopTunnel(id) {
        await tunnelApi.stop(id);
        set((s) => ({ tunnelErrors: { ...s.tunnelErrors, [id]: undefined } }));
        await get().refreshTunnelStatus();
      },

      async saveTunnel(t) {
        const wasRunning = !!get().tunnelStatus[t.id];
        try {
          await tunnelApi.save(t);
        } catch (e) {
          get().showToast(e instanceof Error ? e.message : String(e), "error");
          return false;
        }
        await get().loadTunnels();
        // Saving stops a running tunnel; bring it back with the new settings.
        if (wasRunning) await get().startTunnel(t.id);
        else await get().refreshTunnelStatus();
        return true;
      },

      async deleteTunnel(id) {
        await tunnelApi.remove(id);
        await get().loadTunnels();
        await get().refreshTunnelStatus();
      },

      async startAutoTunnels() {
        await get().loadTunnels();
        for (const t of get().tunnels.filter((x) => x.autoStart)) {
          if (!(await get().startTunnel(t.id))) {
            get().showToast(`Tunnel ${t.name} didn't start: ${get().tunnelErrors[t.id] ?? "cancelled"}`, "error");
          }
        }
      },

      openTunnelDialog: (editing) => set({ tunnelDialog: { open: true, editing } }),
      closeTunnelDialog: () => set({ tunnelDialog: { open: false } }),
      openShareDialog: (shareFolderId) => set({ shareFolderId }),
      openImportDialog: (parentId = null) => set({ importDialog: { parentId } }),
      closeImportDialog: () => set({ importDialog: null }),

      openTunnelsTab() {
        const existing = get().tabs.find((t) => t.kind === "tunnels");
        if (existing) return set({ activeTabId: existing.id });
        const tab: TunnelsTab = { id: uid(), kind: "tunnels", title: "Tunnels" };
        set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
      },

      async loadShells() {
        try {
          set({ shells: await localApi.listShells() });
        } catch {
          // No local terminals then.
        }
      },

      openLocalTerminal(shellId, opts) {
        let tab: LocalTab;
        if (opts?.command?.length) {
          tab = { id: uid(), kind: "local", shellId: "", title: opts.title ?? opts.command[0], command: opts.command };
        } else {
          const shell = get().shells.find((x) => x.id === shellId) ?? get().shells[0];
          if (!shell) return get().showToast("No shells found on this PC", "error");
          const same = get().tabs.filter((t) => t.kind === "local" && t.shellId === shell.id).length;
          tab = { id: uid(), kind: "local", shellId: shell.id, title: same ? `${shell.name} (${same + 1})` : shell.name };
        }
        set((s) => ({
          tabs: [...s.tabs, tab],
          activeTabId: tab.id,
          // A terminal opened during multi-exec joins in.
          multiExec: s.multiExec.on ? { ...s.multiExec, targets: [...s.multiExec.targets, tab.id] } : s.multiExec,
        }));
      },

      async scan(target, viaTerminal) {
        if (get().scans[target]?.state === "scanning") return;
        set((s) => ({ scans: { ...s.scans, [target]: { ...s.scans[target], state: "scanning" } } }));
        try {
          const result =
            target === "local"
              ? await discoverApi.local()
              : viaTerminal
                ? await discoverApi.terminal(viaTerminal)
                : await discoverApi.host(target);
          set((s) => ({ scans: { ...s.scans, [target]: { state: "done", result, at: Date.now() } } }));
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          set((s) => ({ scans: { ...s.scans, [target]: { ...s.scans[target], state: "error", error, at: Date.now() } } }));
        }
      },

      async scanAll() {
        // One at a time, so login prompts don't pile up.
        await get().scan("local");
        for (const h of get().sshHosts) await get().scan(h.id);
      },

      async containerAction(target, c, action) {
        const docker = get().scans[target]?.result?.docker;
        try {
          await discoverApi.docker(target === "local" ? null : target, docker?.command || "docker", action, c.id);
          get().showToast(`${c.name}: ${action === "stop" ? "stopped" : action === "start" ? "started" : "restarted"}`, "ok");
        } catch (e) {
          get().showToast(`${c.name}: ${e instanceof Error ? e.message : String(e)}`, "error");
        }
        await get().scan(target);
      },

      async pm2Refresh(target) {
        const current = get().scans[target]?.result;
        if (!current) return;
        try {
          const pm2 = await pm2Api.list(target === "local" ? null : target);
          set((s) => {
            const scan = s.scans[target];
            if (!scan?.result) return {};
            return { scans: { ...s.scans, [target]: { ...scan, result: { ...scan.result, pm2 } } } };
          });
        } catch {
          // Keep the last list; a full rescan reports problems.
        }
      },

      async pm2Action(target, action, app, label) {
        const past: Record<Pm2Action, string> = {
          start: "started",
          stop: "stopped",
          restart: "restarted",
          reload: "reloaded",
          delete: "deleted",
          flush: "logs cleared",
          reset: "counters reset",
          save: "process list saved",
          resurrect: "saved apps started",
        };
        let ok = true;
        try {
          await pm2Api.action(target === "local" ? null : target, action, app);
          get().showToast(label ? `${label}: ${past[action]}` : `PM2: ${past[action]}`, "ok");
        } catch (e) {
          ok = false;
          get().showToast(`${label ?? "PM2"}: ${e instanceof Error ? e.message : String(e)}`, "error");
        }
        await get().pm2Refresh(target);
        return ok;
      },

      async pm2Start(target, app) {
        try {
          await pm2Api.start(target === "local" ? null : target, app.script, app.name, app.cwd, app.instances);
          get().showToast(`Started ${app.name || app.script}`, "ok");
          await get().pm2Refresh(target);
          return true;
        } catch (e) {
          get().showToast(e instanceof Error ? e.message : String(e), "error");
          return false;
        }
      },

      async pm2Terminal(target, kind, app) {
        const cmd = await pm2Api.terminal(kind, app ? String(app.id) : undefined);
        const title = kind === "monit" ? "pm2 monit" : app ? `logs: ${app.name}` : "pm2 logs";
        if (target === "local") get().openLocalTerminal(undefined, { title, command: cmd.local });
        else get().openTerminalTab(target, { title, command: cmd.remote });
      },

      async loadMonitor() {
        try {
          set({ monitor: await monitorApi.state() });
        } catch {
          // Shown as "not loaded"; the next change event retries.
        }
      },

      async saveMonitor(patch) {
        const current = get().monitor?.settings ?? (await monitorApi.state()).settings;
        await monitorApi.save({ ...current, ...patch });
        await get().loadMonitor();
      },

      async setMonitored(hostId, on) {
        const hosts = get().monitor?.settings.hosts ?? [];
        await get().saveMonitor({ hosts: on ? [...new Set([...hosts, hostId])] : hosts.filter((h) => h !== hostId) });
        if (on) void monitorApi.check(hostId);
      },

      async loadCommands() {
        set({ commands: await commandsApi.list() });
      },

      async saveCommand(c) {
        try {
          await commandsApi.save(c);
          await get().loadCommands();
          return true;
        } catch (e) {
          get().showToast(e instanceof Error ? e.message : String(e), "error");
          return false;
        }
      },

      async deleteCommand(id) {
        await commandsApi.remove(id);
        await get().loadCommands();
      },

      openCommandDialog: (editing = {}) => set({ commandDialog: { editing } }),
      closeCommandDialog: () => set({ commandDialog: null }),

      openCommandsTab() {
        const existing = get().tabs.find((t) => t.kind === "commands");
        if (existing) return set({ activeTabId: existing.id });
        const tab: CommandsTab = { id: uid(), kind: "commands", title: "Commands" };
        set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
      },

      runCommand(c, confirmed) {
        if (c.confirm && !confirmed) return set({ pendingRun: c });
        set({ pendingRun: null });
        const runId = uid();
        const names = new Map(get().sshHosts.map((h) => [h.id, h.name]));
        const run: RunState = {
          title: c.name,
          script: c.script,
          stopOnError: c.stopOnError,
          hosts: c.hostIds.map((hostId) => ({ hostId, name: names.get(hostId) ?? "?", output: "", status: "running", started: Date.now() })),
        };
        const tab: RunTab = { id: uid(), kind: "run", title: `Run: ${c.name}`, runId };
        set((s) => ({ runs: { ...s.runs, [runId]: run }, tabs: [...s.tabs, tab], activeTabId: tab.id }));
        get().rerun(runId);
      },

      rerun(runId, hostIds) {
        const run = get().runs[runId];
        if (!run) return;
        const targets = hostIds ?? run.hosts.map((h) => h.hostId);
        const patchHost = (hostId: string, f: (h: RunHost) => RunHost) =>
          set((s) => {
            const r = s.runs[runId];
            if (!r) return {};
            return { runs: { ...s.runs, [runId]: { ...r, hosts: r.hosts.map((h) => (h.hostId === hostId ? f(h) : h)) } } };
          });
        for (const id of targets) {
          patchHost(id, (h) => ({ ...h, output: "", status: "running", exit: undefined, error: undefined, loginProblem: undefined, started: Date.now(), ended: undefined }));
        }
        // Each run of the backend gets its own id so it can be cancelled on its own.
        const backendId = `${runId}:${uid()}`;
        set((s) => ({ runs: { ...s.runs, [runId]: { ...s.runs[runId]!, backendId } } }));
        void commandsApi
          .run(backendId, targets, run.script, run.stopOnError, (e) => {
            if (e.type === "output") {
              // Keep the last 300 KB per host.
              patchHost(e.hostId, (h) => ({ ...h, output: (h.output + e.data).slice(-300_000) }));
            } else {
              const login = e.error?.sshHost && e.error.kind?.startsWith("SSH_") ? e.error : undefined;
              patchHost(e.hostId, (h) => ({
                ...h,
                ended: Date.now(),
                exit: e.status,
                status: e.cancelled ? "cancelled" : !e.error && e.status === 0 ? "ok" : "failed",
                error: e.error?.message,
                loginProblem: login ?? undefined,
              }));
            }
          })
          .catch((err) => get().showToast(err instanceof Error ? err.message : String(err), "error"));
      },

      cancelRun(runId) {
        const id = get().runs[runId]?.backendId;
        if (id) void commandsApi.cancel(id);
      },

      openMonitorTab() {
        const existing = get().tabs.find((t) => t.kind === "monitor");
        if (existing) return set({ activeTabId: existing.id });
        const tab: MonitorTab = { id: uid(), kind: "monitor", title: "Monitoring" };
        set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
      },

      async serviceAction(target, unit, action) {
        const done: Record<ServiceAction, string> = {
          start: "started",
          stop: "stopped",
          restart: "restarted",
          reload: "reloaded",
          enable: "enabled",
          disable: "disabled",
        };
        try {
          await systemdApi.action(target === "local" ? null : target, action, unit);
          get().showToast(`${unit}: ${done[action]}`, "ok");
        } catch (e) {
          if (e instanceof DbError && e.info.kind === "SUDO_REQUIRED" && target !== "local") {
            // Let sudo ask for the password in a terminal.
            get().showToast(`${unit} needs your sudo password: opening a terminal`, "info");
            await get().serviceTerminal(target, unit, "action", action);
            return;
          }
          get().showToast(`${unit}: ${e instanceof Error ? e.message : String(e)}`, "error");
        }
        await get().scan(target);
      },

      async serviceTerminal(target, unit, kind, action) {
        const cmd = await systemdApi.terminal(kind, unit, action);
        const title = kind === "logs" ? `journal: ${unit}` : `${action} ${unit}`;
        if (target === "local") get().openLocalTerminal(undefined, { title, command: ["sh", "-c", cmd] });
        else get().openTerminalTab(target, { title, command: cmd });
      },

      openDiscoverTab(focus) {
        set({ discoverFocus: focus ?? null });
        const existing = get().tabs.find((t) => t.kind === "discover");
        if (existing) return set({ activeTabId: existing.id });
        const tab: DiscoverTab = { id: uid(), kind: "discover", title: "Discover" };
        set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
      },

      setMultiExec: (patch) => set((s) => ({ multiExec: { ...s.multiExec, ...patch } })),

      toggleMultiExec() {
        const me = get().multiExec;
        if (me.on) return set({ multiExec: { ...me, on: false } });
        set({ multiExec: { on: true, tiled: me.tiled, targets: get().tabs.filter(isTermTab).map((t) => t.id) } });
      },

      toggleMultiExecTarget(id) {
        set((s) => {
          const targets = s.multiExec.targets.includes(id)
            ? s.multiExec.targets.filter((t) => t !== id)
            : [...s.multiExec.targets, id];
          return { multiExec: { ...s.multiExec, targets } };
        });
      },

      async connect(connId) {
        const conn = get().connections.find((c) => c.id === connId);
        if (!conn) return false;
        set((s) => ({ status: { ...s.status, [connId]: { state: "connecting" } } }));
        try {
          const info = await api.openSession(metaSession(connId, conn.database));
          const dbs = await meta.listDatabases(metaSession(connId, conn.database));
          set((s) => ({
            status: { ...s.status, [connId]: { state: "connected", serverVersion: info.serverVersion.split(" ")[0] } },
            databases: { ...s.databases, [connId]: dbs },
          }));
          void get().loadSchemas(connId, conn.database);
          void get().loadCompletion(connId, conn.database);
          if (conn.sshHostId) void get().refreshTunnelStatus();
          return true;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          set((s) => ({ status: { ...s.status, [connId]: { state: "error", error: msg } } }));
          get().showToast(`Could not connect to ${conn.name}: ${msg}`, "error");
          return false;
        }
      },

      async disconnect(connId) {
        await api.disconnect(connId);
        void get().refreshTunnelStatus();
        set((s) => {
          const cache = { ...s.cache };
          for (const k of Object.keys(cache)) if (k.startsWith(connId + "\u001f")) delete cache[k];
          return {
            status: { ...s.status, [connId]: undefined },
            databases: { ...s.databases, [connId]: undefined },
            cache,
          };
        });
      },

      async deleteConnection(connId) {
        await api.deleteConnection(connId);
        set((s) => {
          const tabs = s.tabs.filter((t) => !(isDbTab(t) && t.connId === connId));
          return {
            tabs,
            activeTabId: tabs.some((t) => t.id === s.activeTabId) ? s.activeTabId : (tabs[0]?.id ?? null),
          };
        });
        await get().loadConnections();
      },

      async loadSchemas(connId, database, force) {
        const key = cacheKey(connId, database);
        if (!force && get().cache[key]?.schemas) return;
        const conn = get().connections.find((c) => c.id === connId);
        const schemas = await meta.listSchemas(metaSession(connId, database), !!conn?.showSystemSchemas);
        set((s) => ({
          cache: {
            ...s.cache,
            [key]: { ...(s.cache[key] ?? { contents: {} }), schemas, contents: force ? {} : (s.cache[key]?.contents ?? {}) },
          },
        }));
        // Open the most likely schema straight away.
        const first = schemas.includes("public") ? "public" : schemas[0];
        if (first) void get().loadSchema(connId, database, first);
      },

      async loadSchema(connId, database, schema, force) {
        const key = cacheKey(connId, database);
        if (!force && get().cache[key]?.contents[schema]) return;
        const contents = await meta.schemaContents(metaSession(connId, database), schema);
        set((s) => {
          const c = s.cache[key] ?? { contents: {} };
          return { cache: { ...s.cache, [key]: { ...c, contents: { ...c.contents, [schema]: contents } } } };
        });
      },

      async loadCompletion(connId, database, force) {
        const key = cacheKey(connId, database);
        if (!force && get().cache[key]?.completion) return;
        try {
          const { schema: completion, relations } = await meta.completionSchema(metaSession(connId, database));
          set((s) => {
            const c = s.cache[key] ?? { contents: {} };
            return { cache: { ...s.cache, [key]: { ...c, completion, relations } } };
          });
        } catch {
          // Autocomplete is a nicety; ignore failures.
        }
      },

      async refresh(connId, database) {
        const loaded = Object.keys(get().cache[cacheKey(connId, database)]?.contents ?? {});
        await get().loadSchemas(connId, database, true);
        await Promise.all(loaded.map((s) => get().loadSchema(connId, database, s, true).catch(() => {})));
        void get().loadCompletion(connId, database, true);
      },

      openQueryTab(connId, database, sql = "", title) {
        const id = uid();
        const n = get().tabs.filter((t) => t.kind === "query").length + 1;
        const tab: QueryTab = { id, kind: "query", title: title ?? `Query ${n}`, connId, database, sql };
        set((s) => ({ tabs: [...s.tabs, tab], activeTabId: id }));
        return id;
      },

      openActivityTab(connId, database) {
        const existing = get().tabs.find((t) => t.kind === "activity" && t.connId === connId && t.database === database);
        if (existing) return set({ activeTabId: existing.id });
        const conn = get().connections.find((c) => c.id === connId);
        const title = `Activity: ${database === conn?.database ? (conn?.name ?? database) : database}`;
        const tab: ActivityTab = { id: uid(), kind: "activity", title, connId, database };
        set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
      },

      openTableTab(connId, database, schema, name, objKind) {
        const existing = get().tabs.find(
          (t) =>
            t.kind === "table" && t.connId === connId && t.database === database && t.schema === schema && t.name === name,
        );
        if (existing) return set({ activeTabId: existing.id });
        const id = uid();
        const title = schema === "public" ? name : `${schema}.${name}`;
        const tab: TableTab = { id, kind: "table", title, connId, database, schema, name, objKind };
        set((s) => ({ tabs: [...s.tabs, tab], activeTabId: id }));
      },

      updateTab(id, patch) {
        // Only query tabs are edited in place.
        set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? ({ ...t, ...patch } as Tab) : t)) }));
      },

      closeTab(id) {
        const tab = get().tabs.find((t) => t.id === id);
        if (tab?.kind === "query" || tab?.kind === "activity") void api.closeSession(tabSession(tab)).catch(() => {});
        if (tab?.kind === "terminal") void sshApi.close(tab.id).catch(() => {});
        if (tab?.kind === "local") void localApi.close(tab.id).catch(() => {});
        if (tab?.kind === "files") void filesApi.close(tab.id).catch(() => {});
        if (tab?.kind === "rdp") void rdpApi.close(tab.id);
        if (get().fullScreenTab === id) set({ fullScreenTab: null });
        set((s) => {
          const idx = s.tabs.findIndex((t) => t.id === id);
          const tabs = s.tabs.filter((t) => t.id !== id);
          let activeTabId = s.activeTabId;
          if (activeTabId === id) activeTabId = tabs[Math.min(idx, tabs.length - 1)]?.id ?? null;
          const { [id]: _, ...dirty } = s.dirty;
          const targets = s.multiExec.targets.filter((t) => t !== id);
          return {
            tabs,
            activeTabId,
            dirty,
            pendingCloseTab: s.pendingCloseTab === id ? null : s.pendingCloseTab,
            multiExec: { ...s.multiExec, targets, on: s.multiExec.on && targets.length > 0 },
          };
        });
      },

      askCloseTab(id) {
        if (get().dirty[id]) set({ pendingCloseTab: id, activeTabId: id });
        else get().closeTab(id);
      },

      closeTabs(ids) {
        const kept = ids.filter((id) => get().dirty[id]);
        ids.filter((id) => !get().dirty[id]).forEach((id) => get().closeTab(id));
        if (kept.length) get().showToast(`Kept ${kept.length} tab(s) with unsaved changes open`, "info");
      },

      setActiveTab: (id) => set({ activeTabId: id }),

      addHistory(e) {
        set((s) => {
          const history = [e, ...s.history.filter((h) => h.sql !== e.sql)].slice(0, 300);
          return { history };
        });
      },
      clearHistory: () => set({ history: [] }),

      showToast(text, tone = "info") {
        const id = ++toastSeq;
        set({ toast: { id, text, tone } });
        setTimeout(() => {
          if (get().toast?.id === id) set({ toast: null });
        }, tone === "error" ? 7000 : 3500);
      },

      requestPassword(connId, failed) {
        return new Promise((resolve) => {
          get().passwordRequest?.resolve(null);
          set({ passwordRequest: { connId, failed, resolve } });
        });
      },
      resolvePassword(pw) {
        get().passwordRequest?.resolve(pw);
        set({ passwordRequest: null });
      },

      setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
      setHistoryOpen: (historyOpen) => set({ historyOpen }),
    }),
    {
      name: "tusk-state",
      version: 1,
      partialize: (s) => ({
        theme: s.theme,
        rowLimit: s.rowLimit,
        filePanel: s.filePanel,
        statsBar: s.statsBar,
        collapsedFolders: s.collapsedFolders,
        // SSH sessions don't survive a restart, so their tabs aren't restored.
        tabs: s.tabs.filter((t) => isDbTab(t)),
        activeTabId: isDbTab(s.tabs.find((t) => t.id === s.activeTabId)) ? s.activeTabId : null,
        history: s.history,
      }),
    },
  ),
);

export const activeConnectionOf = (s: State): { connId: string; database: string } | null => {
  const tab = s.tabs.find((t) => t.id === s.activeTabId);
  if (isDbTab(tab)) return { connId: tab.connId, database: tab.database };
  const connected = s.connections.find((c) => s.status[c.id]?.state === "connected");
  return connected ? { connId: connected.id, database: connected.database } : null;
};
