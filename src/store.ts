import { create } from "zustand";
import { persist } from "zustand/middleware";
import { api, sshApi, type ConnectionConfig, type SessionRef, type SshHost } from "./lib/api";
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

export interface TerminalTab {
  id: string;
  kind: "terminal";
  title: string;
  hostId: string;
}

/** Tabs bound to a database connection. */
export type DbTab = QueryTab | TableTab;
export type Tab = DbTab | TerminalTab;

export const isDbTab = (t: Tab | undefined): t is DbTab => !!t && t.kind !== "terminal";

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
  resolve: (accept: boolean) => void;
}

interface State {
  theme: "dark" | "light";
  rowLimit: number;
  connections: ConnectionConfig[];
  sshHosts: SshHost[];
  status: Record<string, ConnStatus | undefined>;
  databases: Record<string, string[] | undefined>;
  cache: Record<string, DbCache | undefined>;
  tabs: Tab[];
  activeTabId: string | null;
  history: HistoryEntry[];

  connectionDialog: { open: boolean; editing?: ConnectionConfig };
  sshDialog: { open: boolean; editing?: SshHost };
  passwordRequest: PasswordRequest | null;
  sshSecretRequest: SshSecretRequest | null;
  hostKeyRequest: HostKeyRequest | null;
  paletteOpen: boolean;
  historyOpen: boolean;
  toast: { id: number; text: string; tone: "ok" | "error" | "info" } | null;

  setTheme(t: "dark" | "light"): void;
  setRowLimit(n: number): void;
  loadConnections(): Promise<void>;
  openConnectionDialog(editing?: ConnectionConfig): void;
  closeConnectionDialog(): void;
  openSshDialog(editing?: SshHost): void;
  closeSshDialog(): void;
  deleteSshHost(id: string): Promise<void>;
  openTerminalTab(hostId: string): void;
  requestSshSecret(r: Omit<SshSecretRequest, "resolve">): Promise<{ secret: string; save: boolean } | null>;
  resolveSshSecret(r: { secret: string; save: boolean } | null): void;
  requestHostKey(r: Omit<HostKeyRequest, "resolve">): Promise<boolean>;
  resolveHostKey(accept: boolean): void;
  connect(connId: string): Promise<boolean>;
  disconnect(connId: string): Promise<void>;
  deleteConnection(connId: string): Promise<void>;
  loadSchemas(connId: string, database: string, force?: boolean): Promise<void>;
  loadSchema(connId: string, database: string, schema: string, force?: boolean): Promise<void>;
  loadCompletion(connId: string, database: string, force?: boolean): Promise<void>;
  refresh(connId: string, database: string): Promise<void>;

  openQueryTab(connId: string, database: string, sql?: string, title?: string): string;
  openTableTab(connId: string, database: string, schema: string, name: string, kind: meta.RelKind): void;
  updateTab(id: string, patch: Partial<QueryTab>): void;
  closeTab(id: string): void;
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
  purpose: tab.kind === "query" ? `tab:${tab.id}` : "meta",
});

export const cacheKey = (connId: string, database: string) => `${connId}\u001f${database}`;

const uid = () => Math.random().toString(36).slice(2, 10);

let toastSeq = 0;

export const useApp = create<State>()(
  persist(
    (set, get) => ({
      theme: "dark",
      rowLimit: 10000,
      connections: [],
      sshHosts: [],
      status: {},
      databases: {},
      cache: {},
      tabs: [],
      activeTabId: null,
      history: [],
      connectionDialog: { open: false },
      sshDialog: { open: false },
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
        const [connections, sshHosts] = await Promise.all([api.listConnections(), sshApi.list()]);
        // Drop tabs whose connection or host no longer exists.
        const ids = new Set([...connections.map((c) => c.id), ...sshHosts.map((h) => h.id)]);
        const tabs = get().tabs.filter((t) => ids.has(t.kind === "terminal" ? t.hostId : t.connId));
        const activeTabId = tabs.some((t) => t.id === get().activeTabId)
          ? get().activeTabId
          : (tabs[0]?.id ?? null);
        set({ connections, sshHosts, tabs, activeTabId });
      },

      openConnectionDialog: (editing) => set({ connectionDialog: { open: true, editing } }),
      closeConnectionDialog: () => set({ connectionDialog: { open: false } }),
      openSshDialog: (editing) => set({ sshDialog: { open: true, editing } }),
      closeSshDialog: () => set({ sshDialog: { open: false } }),

      async deleteSshHost(id) {
        await sshApi.remove(id);
        set((s) => {
          const tabs = s.tabs.filter((t) => !(t.kind === "terminal" && t.hostId === id));
          return {
            tabs,
            activeTabId: tabs.some((t) => t.id === s.activeTabId) ? s.activeTabId : (tabs[0]?.id ?? null),
          };
        });
        await get().loadConnections();
      },

      openTerminalTab(hostId) {
        const host = get().sshHosts.find((h) => h.id === hostId);
        if (!host) return;
        const same = get().tabs.filter((t) => t.kind === "terminal" && t.hostId === hostId).length;
        const id = uid();
        const tab: TerminalTab = { id, kind: "terminal", hostId, title: same ? `${host.name} (${same + 1})` : host.name };
        set((s) => ({ tabs: [...s.tabs, tab], activeTabId: id }));
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
        if (tab?.kind === "query") void api.closeSession(tabSession(tab)).catch(() => {});
        if (tab?.kind === "terminal") void sshApi.close(tab.id).catch(() => {});
        set((s) => {
          const idx = s.tabs.findIndex((t) => t.id === id);
          const tabs = s.tabs.filter((t) => t.id !== id);
          let activeTabId = s.activeTabId;
          if (activeTabId === id) activeTabId = tabs[Math.min(idx, tabs.length - 1)]?.id ?? null;
          return { tabs, activeTabId };
        });
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
        // Terminal sessions don't survive a restart, so their tabs aren't restored.
        tabs: s.tabs.filter((t) => t.kind !== "terminal"),
        activeTabId: s.tabs.find((t) => t.id === s.activeTabId)?.kind === "terminal" ? null : s.activeTabId,
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
