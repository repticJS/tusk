import { Channel, invoke } from "@tauri-apps/api/core";

export type SslMode = "disable" | "prefer" | "require" | "verify-full";

export interface ConnectionConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  database: string;
  sslMode: SslMode;
  color?: string | null;
  savePassword: boolean;
  showSystemSchemas: boolean;
  /** Sidebar folder; null/undefined is the top level. */
  folderId?: string | null;
  /** Connect through this saved SSH host; host/port are then as seen from it. */
  sshHostId?: string | null;
}

export interface Folder {
  id: string;
  name: string;
  parentId?: string | null;
}

export type ItemKind = "connection" | "ssh" | "folder";

export const folderApi = {
  list: () => call<Folder[]>("list_folders"),
  save: (folder: Folder) => call<void>("save_folder", { folder }),
  remove: (id: string) => call<void>("delete_folder", { id }),
  move: (items: { kind: ItemKind; id: string }[], folderId: string | null) =>
    call<void>("move_to_folder", { items, folderId }),
};

// ---- sharing folders ----

export interface ShareCounts {
  folders: number;
  connections: number;
  sshHosts: number;
  tunnels: number;
  commands?: number;
}

export interface ShareInfo {
  name: string;
  counts: ShareCounts;
  /** SSH hosts from outside the folder that its connections go through. */
  extraHosts: string[];
  passwords: number;
  sshSecrets: number;
  keyFiles: number;
}

export interface SharePreview {
  name: string;
  counts: ShareCounts;
  /** Has passwords/keys; needs the passphrase. */
  encrypted: boolean;
}

export const shareApi = {
  info: (folderId: string) => call<ShareInfo>("share_info", { folderId }),
  export: (folderId: string, includeSecrets: boolean, passphrase: string | null) =>
    call<string>("share_export", { folderId, includeSecrets, passphrase }),
  preview: (text: string) => call<SharePreview>("share_preview", { text }),
  import: (text: string, passphrase: string | null, parentId: string | null) =>
    call<{ folderId: string; name: string; counts: ShareCounts }>("share_import", { text, passphrase, parentId }),
};

export interface SessionRef {
  connId: string;
  database: string;
  /** "meta" for browsing; "tab:<id>" for a query tab's own connection. */
  purpose: string;
}

export interface ColumnInfo {
  name: string;
  typeName?: string | null;
  typeOid?: number | null;
}

export interface AppErrorInfo {
  message: string;
  code?: string | null;
  detail?: string | null;
  hint?: string | null;
  position?: number | null;
  kind?: string | null;
  /** The saved SSH host an SSH_* error is about. */
  sshHost?: string | null;
}

export interface StatementResult {
  statement: number;
  columns?: ColumnInfo[] | null;
  rows: (string | null)[][];
  rowCount: number;
  truncated: boolean;
  affected?: number | null;
  durationMs: number;
  notices: string[];
  error?: AppErrorInfo | null;
}

export interface SessionInfo {
  serverVersion: string;
}

export class DbError extends Error {
  info: AppErrorInfo;
  constructor(info: AppErrorInfo) {
    super(info.message);
    this.info = info;
  }
}

function toError(e: unknown): DbError {
  if (e instanceof DbError) return e;
  if (e && typeof e === "object" && "message" in e) return new DbError(e as AppErrorInfo);
  return new DbError({ message: String(e) });
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toError(e);
  }
}

/** Errors that mean "ask the user for a password and try again". */
export function needsPassword(e: unknown): boolean {
  const info = e instanceof DbError ? e.info : null;
  return !!info && (info.kind === "PASSWORD_REQUIRED" || info.code === "28P01");
}

/** SSH login problems (from tunnels and database connections through SSH)
 * the user can fix at a prompt: unknown host key, missing or wrong password. */
export function sshProblem(e: unknown): AppErrorInfo | null {
  const info = e instanceof DbError ? e.info : null;
  return info?.sshHost && info.kind?.startsWith("SSH_") ? info : null;
}

type PasswordPrompter = (connId: string, failed: boolean) => Promise<string | null>;
let prompter: PasswordPrompter | null = null;
export function setPasswordPrompter(p: PasswordPrompter) {
  prompter = p;
}

/** Asks the user about an SSH problem; resolves true when it's worth retrying. */
type SshPrompter = (info: AppErrorInfo) => Promise<boolean>;
let sshPrompter: SshPrompter | null = null;
export function setSshPrompter(p: SshPrompter) {
  sshPrompter = p;
}

/** Retries `fn` while the user fixes SSH problems at a prompt. */
export async function withSshPrompts<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const info = sshProblem(e);
      if (!info || !sshPrompter || attempt > 4 || !(await sshPrompter(info))) throw e;
    }
  }
}

/** Runs a session call, prompting for a password when the server wants one. */
async function withPassword<T>(connId: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await withSshPrompts(fn);
    } catch (e) {
      if (!needsPassword(e) || !prompter || attempt > 4) throw e;
      const failed = e instanceof DbError && e.info.code === "28P01";
      const pw = await prompter(connId, failed);
      if (pw === null) throw e;
      await call("set_session_password", { id: connId, password: pw });
    }
  }
}

export const api = {
  listConnections: () => call<ConnectionConfig[]>("list_connections"),
  saveConnection: (config: ConnectionConfig, password: string | null) =>
    call<void>("save_connection", { config, password }),
  deleteConnection: (id: string) => call<void>("delete_connection", { id }),
  reorderConnections: (ids: string[]) => call<void>("reorder_connections", { ids }),
  testConnection: (config: ConnectionConfig, password: string | null) =>
    withSshPrompts(() => call<SessionInfo>("test_connection", { config, password })),
  openSession: (session: SessionRef) =>
    withPassword(session.connId, () => call<SessionInfo>("open_session", { session })),
  closeSession: (session: SessionRef) => call<void>("close_session", { session }),
  disconnect: (connId: string) => call<void>("disconnect", { connId }),
  run: (session: SessionRef, statements: string[], maxRows?: number) =>
    withPassword(session.connId, () =>
      call<StatementResult[]>("run_statements", { session, statements, maxRows }),
    ),
  executeAtomic: (session: SessionRef, sql: string) =>
    withPassword(session.connId, () => call<number[]>("execute_atomic", { session, sql })),
  cancel: (session: SessionRef) => call<void>("cancel_query", { session }),
  writeTextFile: (path: string, contents: string) => call<void>("write_text_file", { path, contents }),
  readTextFile: (path: string) => call<string>("read_text_file", { path }),
};

// ---- SSH ----

export type SshAuth = "password" | "key" | "agent";

export interface SshHost {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  auth: SshAuth;
  keyPath?: string | null;
  color?: string | null;
  saveSecret: boolean;
  /** Folder the shell starts in, e.g. "/home/New Webapp" or "~/apps". */
  startDir?: string | null;
  /** Sidebar folder; null/undefined is the top level. */
  folderId?: string | null;
}

export type TermEvent =
  | { type: "connected"; banner?: string | null }
  | { type: "exit"; status: number }
  | { type: "closed"; reason?: string | null };

export const sshApi = {
  list: () => call<SshHost[]>("list_ssh_hosts"),
  save: (config: SshHost, secret: string | null) => call<void>("save_ssh_host", { config, secret }),
  remove: (id: string) => call<void>("delete_ssh_host", { id }),
  setSecret: (id: string, secret: string, save: boolean) => call<void>("set_ssh_secret", { id, secret, save }),
  /** Trusts a host key for the next tunnel or database connection through the host. */
  acceptHostKey: (hostId: string, fingerprint: string) => call<void>("ssh_accept_host_key", { hostId, fingerprint }),
  /**
   * Opens a shell. Output arrives as ArrayBuffers on `onData`; lifecycle
   * events as objects on `onEvent`. Rejects with DbError for host-key and
   * auth problems (see `info.kind`).
   */
  open(
    termId: string,
    hostId: string,
    cols: number,
    rows: number,
    acceptFingerprint: string | null,
    onData: (bytes: Uint8Array) => void,
    onEvent: (e: TermEvent) => void,
    /** Run this instead of the login shell. */
    command?: string,
  ) {
    const events = new Channel<ArrayBuffer | TermEvent>();
    events.onmessage = (m) => {
      if (m instanceof ArrayBuffer) onData(new Uint8Array(m));
      else if (ArrayBuffer.isView(m)) onData(new Uint8Array(m.buffer, m.byteOffset, m.byteLength));
      else if (Array.isArray(m)) onData(new Uint8Array(m as number[]));
      else onEvent(m);
    };
    return call<void>("ssh_open", { termId, hostId, cols, rows, acceptFingerprint, command: command ?? null, events });
  },
  write: (termId: string, data: string) => call<void>("ssh_write", { termId, data }),
  resize: (termId: string, cols: number, rows: number) => call<void>("ssh_resize", { termId, cols, rows }),
  close: (termId: string) => call<void>("ssh_close", { termId }),
};

// ---- server stats ----

export interface ServerDisk {
  mount: string;
  filesystem: string;
  size: number;
  used: number;
}

/** Raw counters from a Linux server; rates come from comparing two samples. */
export interface ServerStats {
  cpuBusy: number;
  cpuTotal: number;
  cores: number;
  memTotal: number;
  memAvailable: number;
  swapTotal: number;
  swapFree: number;
  load: [number, number, number];
  uptime: number;
  netRx: number;
  netTx: number;
  disks: ServerDisk[];
  users: number;
  hostname: string;
  os: string;
}

export interface ServerProcess {
  pid: number;
  user: string;
  /** CPU time used since start, in jiffies. */
  ticks: number;
  rss: number;
  command: string;
}

export const statsApi = {
  snapshot: (termId: string) => call<ServerStats>("ssh_stats", { termId }),
  processes: (termId: string) => call<{ cpuTotal: number; list: ServerProcess[] }>("ssh_processes", { termId }),
};

// ---- saved commands ----

export interface SavedCommand {
  id: string;
  name: string;
  script: string;
  hostIds: string[];
  /** Stop at the first failing line (set -e). */
  stopOnError: boolean;
  /** Ask before running. */
  confirm: boolean;
}

export type RunEvent =
  | { type: "output"; hostId: string; data: string }
  | { type: "exit"; hostId: string; status?: number | null; error?: AppErrorInfo | null; cancelled: boolean };

export const commandsApi = {
  list: () => call<SavedCommand[]>("list_commands"),
  save: (command: SavedCommand) => call<void>("save_command", { command }),
  remove: (id: string) => call<void>("delete_command", { id }),
  /** Resolves when every host has finished; output and exits arrive on `onEvent`. */
  run(runId: string, hostIds: string[], script: string, stopOnError: boolean, onEvent: (e: RunEvent) => void) {
    const events = new Channel<RunEvent>();
    events.onmessage = onEvent;
    return call<void>("run_command", { runId, hostIds, script, stopOnError, events });
  },
  cancel: (runId: string) => call<void>("cancel_run", { runId }),
};

// ---- monitoring ----

export interface MonitorSettings {
  hosts: string[];
  intervalSecs: number;
  diskThreshold: number;
  notify: boolean;
}

export interface MonitorProblem {
  key: string;
  severity: "warning" | "critical";
  message: string;
  since: number;
}

export interface MonitorHost {
  hostId: string;
  checkedAt?: number | null;
  checking: boolean;
  reachable?: boolean | null;
  error?: string | null;
  problems: MonitorProblem[];
  disks: { mount: string; percent: number }[];
  memPercent?: number | null;
  /** [online, total] */
  pm2?: [number, number] | null;
  /** [running, total] */
  containers?: [number, number] | null;
  certs: { domain: string; daysLeft: number }[];
}

export interface MonitorAlert {
  id: number;
  at: number;
  hostId: string;
  hostName: string;
  severity: "warning" | "critical" | "ok";
  message: string;
  resolved: boolean;
}

export interface MonitorView {
  settings: MonitorSettings;
  hosts: MonitorHost[];
  alerts: MonitorAlert[];
}

export const monitorApi = {
  state: () => call<MonitorView>("monitor_state"),
  save: (settings: MonitorSettings) => call<void>("monitor_save", { settings }),
  check: (hostId: string) => call<void>("monitor_check", { hostId }),
  clearAlerts: () => call<void>("monitor_clear_alerts"),
};

// ---- discovery ----

export interface FoundDb {
  kind: string;
  port: number;
  /** "" when listening on every interface. */
  address: string;
  process?: string | null;
  version?: string | null;
  detail?: string | null;
}

export interface PortMap {
  hostIp: string;
  hostPort: number;
  containerPort: number;
  proto: string;
}

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: PortMap[];
  dbKind?: string | null;
  dbPort?: number | null;
  ip?: string | null;
  env: { user?: string | null; database?: string | null; password?: string | null };
}

export interface DockerInfo {
  status: "ok" | "missing" | "denied" | "stopped" | "error";
  message?: string | null;
  /** "docker", "sudo -n docker" or "podman". */
  command: string;
  version?: string | null;
  containers: ContainerInfo[];
}

export interface Pm2Process {
  id: number;
  name: string;
  /** online | stopped | stopping | errored | launching | waiting restart */
  status: string;
  pid?: number | null;
  cpu: number;
  memory: number;
  /** Seconds since the last (re)start, when online. */
  uptime?: number | null;
  restarts: number;
  unstableRestarts: number;
  /** fork | cluster */
  mode: string;
  script: string;
  cwd: string;
  interpreter: string;
  nodeVersion?: string | null;
  appVersion?: string | null;
  namespace?: string | null;
  outLog?: string | null;
  errLog?: string | null;
  watch: boolean;
}

export interface Pm2Info {
  /** ok | stopped (installed, no daemon) | missing | error */
  status: "ok" | "stopped" | "missing" | "error";
  version?: string | null;
  message?: string | null;
  processes: Pm2Process[];
  /** Other users running their own PM2. */
  otherUsers: string[];
}

export type Pm2Action = "start" | "stop" | "restart" | "reload" | "delete" | "flush" | "reset" | "save" | "resurrect";

export interface Service {
  /** Without ".service". */
  name: string;
  description: string;
  /** active | inactive | failed | activating | deactivating */
  active: string;
  /** running | exited | dead | failed | … */
  sub: string;
  /** enabled | disabled | static | masked | … */
  enabled?: string | null;
}

export interface ServicesInfo {
  /** How actions can run: root | sudo (no password) | none */
  privilege: "root" | "sudo" | "none";
  units: Service[];
}

export type ServiceAction = "start" | "stop" | "restart" | "reload" | "enable" | "disable";

export interface ScanResult {
  os: string;
  databases: FoundDb[];
  docker: DockerInfo;
  pm2: Pm2Info;
  /** null when the machine doesn't run systemd. */
  services?: ServicesInfo | null;
}

export type ContainerAction = "start" | "stop" | "restart";

export const discoverApi = {
  local: () => call<ScanResult>("discover_local"),
  host: (hostId: string) => withSshPrompts(() => call<ScanResult>("discover_host", { hostId })),
  terminal: (termId: string) => call<ScanResult>("discover_terminal", { termId }),
  /** hostId null means this PC. */
  docker: (hostId: string | null, command: string, action: ContainerAction, id: string) =>
    withSshPrompts(() => call<void>("docker_action", { hostId, command, action, id })),
};

/** systemd on an SSH host, or this PC when hostId is null. */
export const systemdApi = {
  action: (hostId: string | null, action: ServiceAction, unit: string) =>
    withSshPrompts(() => call<void>("systemd_action", { hostId, action, unit })),
  /** Command for a terminal: the service's journal, or an action with interactive sudo. */
  terminal: (kind: "logs" | "action", unit: string, action?: ServiceAction) =>
    call<string>("systemd_terminal", { kind, unit, action: action ?? null }),
};

/** PM2 on an SSH host, or this PC when hostId is null. */
export const pm2Api = {
  list: (hostId: string | null) => withSshPrompts(() => call<Pm2Info>("pm2_list", { hostId })),
  action: (hostId: string | null, action: Pm2Action, target?: string) =>
    withSshPrompts(() => call<void>("pm2_action", { hostId, action, target: target ?? null })),
  start: (hostId: string | null, script: string, name: string, cwd: string, instances: number) =>
    withSshPrompts(() => call<void>("pm2_start", { hostId, script, name, cwd, instances })),
  /** The command a terminal runs for `pm2 logs` / `pm2 monit`. */
  terminal: (kind: "logs" | "monit", target?: string) =>
    call<{ remote: string; local: string[] }>("pm2_terminal", { kind, target: target ?? null }),
};

// ---- local terminals ----

export interface Shell {
  id: string;
  name: string;
  program: string;
  args: string[];
  kind: "powershell" | "cmd" | "bash" | "wsl" | "other";
}

/** Same calling convention as sshApi, for shells on this PC. */
export const localApi = {
  listShells: () => call<Shell[]>("list_shells"),
  open(
    termId: string,
    shellId: string,
    cols: number,
    rows: number,
    onData: (bytes: Uint8Array) => void,
    onEvent: (e: TermEvent) => void,
    /** A program and its arguments to run instead of the shell. */
    command?: string[],
  ) {
    const events = new Channel<ArrayBuffer | TermEvent>();
    events.onmessage = (m) => {
      if (m instanceof ArrayBuffer) onData(new Uint8Array(m));
      else if (ArrayBuffer.isView(m)) onData(new Uint8Array(m.buffer, m.byteOffset, m.byteLength));
      else if (Array.isArray(m)) onData(new Uint8Array(m as number[]));
      else onEvent(m);
    };
    return call<void>("local_open", { termId, shellId, cols, rows, command: command ?? null, events });
  },
  write: (termId: string, data: string) => call<void>("local_write", { termId, data }),
  resize: (termId: string, cols: number, rows: number) => call<void>("local_resize", { termId, cols, rows }),
  close: (termId: string) => call<void>("local_close", { termId }),
};

// ---- tunnels ----

export type TunnelKind = "local" | "remote" | "dynamic";

export interface TunnelConfig {
  id: string;
  name: string;
  hostId: string;
  kind: TunnelKind;
  /** Listen address: on this PC for local/dynamic, on the server for remote. */
  bindHost: string;
  bindPort: number;
  /** Destination: reached from the server (local) or from this PC (remote). */
  targetHost: string;
  targetPort: number;
  autoStart: boolean;
}

export interface TunnelStatus {
  /** A saved tunnel's id, or "db:<connection id>" for a database connection's tunnel. */
  id: string;
  port: number;
  active: number;
  total: number;
  bytesUp: number;
  bytesDown: number;
  error?: string | null;
}

export const tunnelApi = {
  list: () => call<TunnelConfig[]>("list_tunnels"),
  save: (tunnel: TunnelConfig) => call<void>("save_tunnel", { tunnel }),
  remove: (id: string) => call<void>("delete_tunnel", { id }),
  start: (id: string) => call<number>("start_tunnel", { id }),
  stop: (id: string) => call<void>("stop_tunnel", { id }),
  status: () => call<TunnelStatus[]>("tunnel_status"),
};

// ---- SFTP ----

export interface SftpEntry {
  name: string;
  kind: "dir" | "file" | "link";
  linkToDir: boolean;
  size: number;
  mtime?: number | null;
  mode: string;
  owner?: string | null;
}

export interface SftpListing {
  path: string;
  entries: SftpEntry[];
}

export interface TransferProgress {
  type: "progress";
  done: number;
  total: number;
  file: string;
}

export const sftpApi = {
  list: (termId: string, path: string) => call<SftpListing>("sftp_list", { termId, path }),
  cwd: (termId: string) => call<string | null>("sftp_cwd", { termId }),
  mkdir: (termId: string, path: string) => call<void>("sftp_mkdir", { termId, path }),
  rename: (termId: string, from: string, to: string) => call<void>("sftp_rename", { termId, from, to }),
  remove: (termId: string, paths: string[]) => call<void>("sftp_delete", { termId, paths }),
  readText: (termId: string, path: string) =>
    call<{ content?: string | null; size: number; reason?: string | null }>("sftp_read_text", { termId, path }),
  writeText: (termId: string, path: string, content: string) => call<void>("sftp_write_text", { termId, path, content }),
  download(termId: string, transferId: string, remote: string[], localDir: string, onProgress: (p: TransferProgress) => void) {
    const events = new Channel<TransferProgress>();
    events.onmessage = onProgress;
    return call<void>("sftp_download", { termId, transferId, remote, localDir, events });
  },
  upload(termId: string, transferId: string, local: string[], remoteDir: string, onProgress: (p: TransferProgress) => void) {
    const events = new Channel<TransferProgress>();
    events.onmessage = onProgress;
    return call<void>("sftp_upload", { termId, transferId, local, remoteDir, events });
  },
  cancel: (transferId: string) => call<void>("sftp_cancel", { transferId }),
};

/** Joins a remote POSIX directory and name. */
export const remoteJoin = (dir: string, name: string) => (dir.endsWith("/") ? dir + name : `${dir}/${name}`);
export const remoteParent = (path: string) => {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i <= 0 ? "/" : trimmed.slice(0, i);
};

/** Runs one query and returns its rows as objects; throws on SQL errors. */
export async function query<T = Record<string, string | null>>(
  session: SessionRef,
  sql: string,
): Promise<T[]> {
  const [res] = await api.run(session, [sql], 1_000_000);
  if (!res) return [];
  if (res.error) throw new DbError(res.error);
  const cols = res.columns ?? [];
  return res.rows.map((r) => {
    const o: Record<string, string | null> = {};
    cols.forEach((c, i) => (o[c.name] = r[i]));
    return o as T;
  });
}
