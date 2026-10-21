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

type PasswordPrompter = (connId: string, failed: boolean) => Promise<string | null>;
let prompter: PasswordPrompter | null = null;
export function setPasswordPrompter(p: PasswordPrompter) {
  prompter = p;
}

/** Runs a session call, prompting for a password when the server wants one. */
async function withPassword<T>(connId: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
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
    call<SessionInfo>("test_connection", { config, password }),
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
  ) {
    const events = new Channel<ArrayBuffer | TermEvent>();
    events.onmessage = (m) => {
      if (m instanceof ArrayBuffer) onData(new Uint8Array(m));
      else if (ArrayBuffer.isView(m)) onData(new Uint8Array(m.buffer, m.byteOffset, m.byteLength));
      else if (Array.isArray(m)) onData(new Uint8Array(m as number[]));
      else onEvent(m);
    };
    return call<void>("ssh_open", { termId, hostId, cols, rows, acceptFingerprint, events });
  },
  write: (termId: string, data: string) => call<void>("ssh_write", { termId, data }),
  resize: (termId: string, cols: number, rows: number) => call<void>("ssh_resize", { termId, cols, rows }),
  close: (termId: string) => call<void>("ssh_close", { termId }),
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
