import { getCurrentWebview } from "@tauri-apps/api/webview";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  Copy,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  File,
  FileSymlink,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderSymlink,
  HardDrive,
  Home,
  Monitor,
  Pencil,
  Plus,
  RefreshCw,
  RotateCw,
  Server,
  ShieldAlert,
  TerminalSquare,
  Trash2,
  Unplug,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { create } from "zustand";
import {
  DbError,
  filesApi,
  ftpApi,
  localFsApi,
  remoteJoin,
  remoteParent,
  type FilesTarget,
  type OverwritePolicy,
  type RemoteSource,
  type SftpEntry,
  type TransferProgress,
  type TransferResult,
} from "../lib/api";
import { fmtBytes, fmtDuration } from "../lib/format";
import { useApp, type FilesTab as FilesTabModel } from "../store";
import { DropdownButton, Modal, Spinner, useMenu, type MenuEntry } from "./ui";

type Side = "local" | "remote";

interface Listing {
  path: string;
  /** null at the top (/, or the drive list on Windows). */
  parent: string | null;
  sep: string;
  entries: SftpEntry[];
}

/** The file system calls one pane makes. */
interface PaneFs {
  list(path: string): Promise<Listing>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(paths: string[]): Promise<void>;
}

/** Windows' list of drives, from the backend. */
const DRIVES = "This PC";
const MAX_RUNNING = 2;
const LOCAL_DIR_KEY = "tusk.files.localDir";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const uid = () => Math.random().toString(36).slice(2, 10);
const isDir = (e: SftpEntry) => e.kind === "dir" || (e.kind === "link" && e.linkToDir);

function joinPath(l: { path: string; sep: string }, name: string) {
  if (l.path === DRIVES) return `${name}\\`;
  return l.path.endsWith(l.sep) ? l.path + name : l.path + l.sep + name;
}

function formatTime(mtime?: number | null): string {
  if (!mtime) return "";
  const d = new Date(mtime * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function readLocalDir(): string {
  try {
    return localStorage.getItem(LOCAL_DIR_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeLocalDir(path: string) {
  try {
    localStorage.setItem(LOCAL_DIR_KEY, path);
  } catch {
    // Remembering the folder is a convenience.
  }
}

// ---- panes ----

type SortKey = "name" | "size" | "mtime";

interface PaneState {
  listing: Listing | null;
  loading: boolean;
  error: string | null;
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
  load: (path: string, keepSelection?: boolean) => Promise<boolean>;
  refresh: () => Promise<boolean>;
  reset: () => void;
  fs: PaneFs;
}

function usePane(fs: PaneFs, onLoaded?: (path: string) => void): PaneState {
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const pathRef = useRef<string | null>(null);
  const seq = useRef(0);
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  const load = useCallback(
    async (path: string, keepSelection = false) => {
      const mine = ++seq.current;
      setLoading(true);
      try {
        const l = await fs.list(path);
        if (mine !== seq.current) return false;
        pathRef.current = l.path;
        setListing(l);
        setError(null);
        if (!keepSelection) setSelected(new Set());
        else setSelected((s) => new Set([...s].filter((n) => l.entries.some((e) => e.name === n))));
        onLoadedRef.current?.(l.path);
        return true;
      } catch (e) {
        if (mine === seq.current) setError(errText(e));
        return false;
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [fs],
  );

  const refresh = useCallback(() => load(pathRef.current ?? "", true), [load]);
  const reset = useCallback(() => {
    seq.current++;
    pathRef.current = null;
    setListing(null);
    setError(null);
    setLoading(false);
    setSelected(new Set());
  }, []);
  return { listing, loading, error, selected, setSelected, load, refresh, reset, fs };
}

interface PaneProps {
  side: Side;
  pane: PaneState;
  /** Shown above the path: "This PC" or the server's name. */
  header: ReactNode;
  showHidden: boolean;
  /** The other side can take files (connected). */
  canTransfer: boolean;
  homePath: string;
  /** Send these entries to the other side (into its folder, or `destDir`). */
  onTransfer: (names: string[], destDir?: string) => void;
  /** Double-click / Enter on a file. */
  onOpenFile: (e: SftpEntry) => void;
  extraMenu: (entries: SftpEntry[]) => MenuEntry[];
  /** FTP doesn't say whether a link is a folder; try opening it. */
  probeLinks?: boolean;
  /** Shown instead of the listing (not connected yet). */
  placeholder?: ReactNode;
  dragOver: boolean;
  active: boolean;
}

let suppressClickUntil = 0;

function FilePane(props: PaneProps) {
  const { side, pane, showHidden, canTransfer } = props;
  const { listing, selected, setSelected } = pane;
  const showToast = useApp((s) => s.showToast);
  const [draft, setDraft] = useState("");
  const [anchor, setAnchor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ name: string; value: string } | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "name", desc: false });
  const [menu, openMenu] = useMenu();
  const listRef = useRef<HTMLDivElement>(null);
  const dropDir = useFileDrag((s) => (s.from && s.from !== side && s.over?.side === side ? s.over.dir ?? "" : null));

  useEffect(() => {
    if (listing) setDraft(listing.path);
  }, [listing]);

  const shown = useMemo(() => {
    if (!listing) return [];
    const q = filter.trim().toLowerCase();
    const list = listing.entries.filter((e) => (showHidden || !e.hidden) && (!q || e.name.toLowerCase().includes(q)));
    const dir = sort.desc ? -1 : 1;
    return list.sort((a, b) => {
      const da = isDir(a) ? 0 : 1;
      const db = isDir(b) ? 0 : 1;
      if (da !== db) return da - db;
      const byName = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
      if (sort.key === "size") return (a.size - b.size) * dir || byName;
      if (sort.key === "mtime") return ((a.mtime ?? 0) - (b.mtime ?? 0)) * dir || byName;
      return byName * dir;
    });
  }, [listing, showHidden, filter, sort]);

  const selectedEntries = shown.filter((e) => selected.has(e.name));
  const selectedBytes = selectedEntries.reduce((n, e) => n + (isDir(e) ? 0 : e.size), 0);
  const fullPath = (name: string) => (listing ? joinPath(listing, name) : name);

  const open = async (e: SftpEntry) => {
    if (!listing) return;
    if (isDir(e)) {
      void pane.load(fullPath(e.name));
      return;
    }
    // A link that may be a folder: open it if it lists.
    if (e.kind === "link" && props.probeLinks && (await pane.load(fullPath(e.name)))) return;
    props.onOpenFile(e);
  };

  const run = async (what: () => Promise<void>, after?: () => void) => {
    try {
      await what();
      await pane.refresh();
      after?.();
    } catch (e) {
      showToast(errText(e), "error");
    }
  };

  const commitRename = () => {
    if (!renaming || !listing) return;
    const { name, value } = renaming;
    setRenaming(null);
    const to = value.trim();
    if (!to || to === name) return;
    void run(() => pane.fs.rename(fullPath(name), fullPath(to)), () => setSelected(new Set([to])));
  };

  const commitCreate = () => {
    const name = creating?.trim();
    setCreating(null);
    if (!name || !listing) return;
    void run(() => pane.fs.mkdir(fullPath(name)), () => setSelected(new Set([name])));
  };

  const doDelete = (names: string[]) => {
    setConfirmDelete(null);
    void run(() => pane.fs.remove(names.map(fullPath)));
  };

  const clickRow = (e: React.MouseEvent, name: string) => {
    if (Date.now() < suppressClickUntil) return;
    if (e.shiftKey && anchor) {
      const names = shown.map((x) => x.name);
      const [a, b] = [names.indexOf(anchor), names.indexOf(name)].sort((x, y) => x - y);
      setSelected(new Set(names.slice(a, b + 1)));
    } else if (e.ctrlKey || e.metaKey) {
      const n = new Set(selected);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      setSelected(n);
      setAnchor(name);
    } else {
      setSelected(new Set([name]));
      setAnchor(name);
    }
  };

  const rowMenu = (ev: React.MouseEvent, entry: SftpEntry) => {
    ev.preventDefault();
    ev.stopPropagation();
    const names = selected.has(entry.name) ? [...selected] : [entry.name];
    if (!selected.has(entry.name)) setSelected(new Set([entry.name]));
    const entries = names.map((n) => listing?.entries.find((e) => e.name === n)).filter((e): e is SftpEntry => !!e);
    const transferLabel = side === "local" ? "Upload" : "Download";
    openMenu(ev, [
      {
        label: transferLabel,
        icon: side === "local" ? <Upload size={13} /> : <Download size={13} />,
        disabled: !canTransfer || listing?.path === DRIVES,
        onClick: () => props.onTransfer(names),
      },
      ...(isDir(entry) && names.length === 1
        ? [{ label: "Open folder", icon: <FolderOpen size={13} />, onClick: () => void open(entry) }]
        : []),
      ...props.extraMenu(entries),
      "separator",
      {
        label: "Rename",
        icon: <Pencil size={13} />,
        hint: "F2",
        disabled: names.length > 1 || listing?.path === DRIVES,
        onClick: () => setRenaming({ name: entry.name, value: entry.name }),
      },
      {
        label: "Copy path",
        icon: <Copy size={13} />,
        onClick: () => void navigator.clipboard.writeText(names.map(fullPath).join("\n")),
      },
      {
        label: "Delete…",
        icon: <Trash2 size={13} />,
        hint: "Del",
        danger: true,
        disabled: listing?.path === DRIVES,
        onClick: () => setConfirmDelete(names),
      },
    ]);
  };

  const backgroundMenu = (ev: React.MouseEvent) => {
    ev.preventDefault();
    if (!listing) return;
    openMenu(ev, [
      { label: "New folder", icon: <FolderPlus size={13} />, disabled: listing.path === DRIVES, onClick: () => setCreating("") },
      { label: "Refresh", icon: <RefreshCw size={13} />, hint: "F5", onClick: () => void pane.refresh() },
      { label: "Copy folder path", icon: <Copy size={13} />, onClick: () => void navigator.clipboard.writeText(listing.path) },
      ...(side === "local" && listing.path !== DRIVES
        ? [{ label: "Open in Explorer", icon: <ExternalLink size={13} />, onClick: () => void openPath(listing.path).catch(() => {}) }]
        : []),
    ]);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const names = shown.filter((x) => selected.has(x.name)).map((x) => x.name);
    if (e.key === "Delete" && names.length) setConfirmDelete(names);
    else if (e.key === "F2" && names.length === 1) setRenaming({ name: names[0], value: names[0] });
    else if (e.key === "F5") void pane.refresh();
    else if (e.key === "Backspace" && listing?.parent) void pane.load(listing.parent);
    else if (e.key === "Enter" && names.length === 1) {
      const entry = shown.find((x) => x.name === names[0]);
      if (entry) void open(entry);
    } else if (e.key === "Enter" && names.length > 1 && canTransfer) props.onTransfer(names);
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") setSelected(new Set(shown.map((x) => x.name)));
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const i = shown.findIndex((x) => x.name === (anchor ?? names[0]));
      const next = shown[Math.max(0, Math.min(shown.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next) {
        setSelected(new Set([next.name]));
        setAnchor(next.name);
        listRef.current?.querySelector(`[data-files-row="${CSS.escape(next.name)}"]`)?.scrollIntoView({ block: "nearest" });
      }
    } else return;
    e.preventDefault();
  };

  // Rows drag to the other pane (or onto a folder in it).
  const rowPointerDown = (e: React.PointerEvent, entry: SftpEntry) => {
    if (e.button !== 0 || renaming || e.shiftKey || e.ctrlKey || e.metaKey) return;
    const names = selected.has(entry.name) ? [...selected] : [entry.name];
    startFileDrag(e, side, names, (over) => {
      if (over.side !== side && canTransfer) props.onTransfer(names, over.dir ?? undefined);
    });
  };

  const iconFor = (e: SftpEntry) =>
    listing?.path === DRIVES ? (
      <HardDrive size={14} className="text-muted" />
    ) : e.kind === "link" ? (
      e.linkToDir ? (
        <FolderSymlink size={14} className="text-accent" />
      ) : (
        <FileSymlink size={14} className="text-muted" />
      )
    ) : e.kind === "dir" ? (
      <Folder size={14} className="text-accent" fill="currentColor" fillOpacity={0.18} />
    ) : (
      <File size={14} className="text-muted" />
    );

  const tool = "btn-ghost h-6 w-6 justify-center px-0";
  const sortHead = (key: SortKey, label: string, cls: string) => (
    <button
      className={`${cls} flex items-center gap-0.5 hover:text-text ${sort.key === key ? "text-text" : ""}`}
      onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : false }))}
    >
      {label}
      {sort.key === key && (sort.desc ? <ArrowDown size={10} /> : <ArrowUp size={10} />)}
    </button>
  );

  return (
    <div
      className="@container relative flex h-full flex-col outline-none"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      data-files-pane={side}
      data-files-dir=""
      data-path={listing?.path ?? ""}
    >
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border bg-panel px-2 text-[12px] font-medium">
        {props.header}
      </div>
      <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border px-1.5">
        <button
          className={tool}
          title="Parent folder (Backspace)"
          aria-label={`${side} parent folder`}
          disabled={!listing?.parent}
          onClick={() => listing?.parent && void pane.load(listing.parent)}
        >
          <ArrowUp size={14} />
        </button>
        <button className={tool} title="Home folder" aria-label={`${side} home`} disabled={!listing} onClick={() => void pane.load(props.homePath)}>
          <Home size={13} />
        </button>
        <button className={tool} title="Refresh (F5)" aria-label={`${side} refresh`} disabled={!listing} onClick={() => void pane.refresh()}>
          <RefreshCw size={13} className={pane.loading ? "animate-spin" : ""} />
        </button>
        <form
          className="min-w-0 flex-1 px-1"
          onSubmit={(e) => {
            e.preventDefault();
            void pane.load(draft.trim());
          }}
        >
          <input
            className="h-6 w-full rounded-md border border-border bg-bg px-2 font-mono text-[11.5px] outline-none focus:border-accent"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            disabled={!listing && !pane.error}
            aria-label={side === "local" ? "Local path" : "Remote path"}
          />
        </form>
        <button
          className={tool}
          title="New folder"
          aria-label={`${side} new folder`}
          disabled={!listing || listing.path === DRIVES}
          onClick={() => setCreating("")}
        >
          <FolderPlus size={14} />
        </button>
        <button
          className={tool}
          title={side === "local" ? "Upload selected" : "Download selected"}
          aria-label={side === "local" ? "Upload selected" : "Download selected"}
          disabled={!canTransfer || selected.size === 0 || listing?.path === DRIVES}
          onClick={() => props.onTransfer(shown.filter((x) => selected.has(x.name)).map((x) => x.name))}
        >
          {side === "local" ? <ArrowRight size={14} /> : <ArrowLeft size={14} />}
        </button>
      </div>

      {props.placeholder ?? (
        <>
          <div className="flex h-6 shrink-0 items-center gap-2 border-b border-border px-2.5 text-[11px] text-faint select-none">
            {sortHead("name", "Name", "min-w-0 flex-1")}
            {sortHead("size", "Size", "w-16 justify-end")}
            {sortHead("mtime", "Modified", "hidden w-[108px] justify-end @[420px]:flex")}
            {side === "remote" && <span className="hidden w-[78px] @[560px]:inline">Permissions</span>}
          </div>
          <div
            ref={listRef}
            className={`min-h-0 flex-1 overflow-auto py-0.5 ${dropDir === "" ? "bg-accent-soft/50 ring-1 ring-accent ring-inset" : ""}`}
            onContextMenu={backgroundMenu}
            onClick={(e) => e.target === e.currentTarget && setSelected(new Set())}
          >
            {pane.error && (
              <div className="m-2 rounded-md bg-danger-soft p-2.5 text-[12px] text-danger" data-pane-error>
                {pane.error}
                <button className="mt-1.5 block text-accent hover:underline" onClick={() => void pane.load(props.homePath)}>
                  Go to home folder
                </button>
              </div>
            )}
            {creating !== null && (
              <div className="flex h-[24px] items-center gap-2 px-2.5">
                <Folder size={14} className="text-accent" />
                <input
                  autoFocus
                  className="h-5 min-w-0 flex-1 rounded border border-accent bg-bg px-1 text-[12.5px] outline-none"
                  placeholder="New folder name"
                  value={creating}
                  onChange={(e) => setCreating(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitCreate();
                    if (e.key === "Escape") setCreating(null);
                  }}
                  onBlur={commitCreate}
                  aria-label="New folder name"
                />
              </div>
            )}
            {!pane.error &&
              shown.map((e) => (
                <div
                  key={e.name}
                  className={`flex h-[24px] cursor-default items-center gap-2 px-2.5 text-[12.5px] ${
                    selected.has(e.name)
                      ? "bg-accent-soft"
                      : dropDir === e.name && isDir(e)
                        ? "bg-accent-soft/60 ring-1 ring-accent ring-inset"
                        : "hover:bg-hover"
                  }`}
                  onClick={(ev) => clickRow(ev, e.name)}
                  onDoubleClick={() => void open(e)}
                  onContextMenu={(ev) => rowMenu(ev, e)}
                  onPointerDown={(ev) => rowPointerDown(ev, e)}
                  data-files-row={e.name}
                  data-files-dir={isDir(e) ? e.name : undefined}
                  title={e.name}
                >
                  <span className="shrink-0">{iconFor(e)}</span>
                  {renaming?.name === e.name ? (
                    <input
                      autoFocus
                      className="h-5 min-w-0 flex-1 rounded border border-accent bg-bg px-1 text-[12.5px] outline-none"
                      value={renaming.value}
                      onChange={(ev) => setRenaming({ name: e.name, value: ev.target.value })}
                      onPointerDown={(ev) => ev.stopPropagation()}
                      onKeyDown={(ev) => {
                        if (ev.key === "Enter") commitRename();
                        if (ev.key === "Escape") setRenaming(null);
                      }}
                      onBlur={commitRename}
                      onFocus={(ev) => {
                        const dot = e.name.lastIndexOf(".");
                        ev.target.setSelectionRange(0, dot > 0 && !isDir(e) ? dot : e.name.length);
                      }}
                      aria-label="New name"
                    />
                  ) : (
                    <span className={`min-w-0 flex-1 truncate ${e.hidden ? "text-muted" : ""}`}>{e.name}</span>
                  )}
                  <span className="w-16 shrink-0 text-right text-[11px] text-faint tabular-nums">{isDir(e) ? "" : fmtBytes(e.size)}</span>
                  <span className="hidden w-[108px] shrink-0 text-right text-[11px] text-faint tabular-nums @[420px]:inline">
                    {formatTime(e.mtime)}
                  </span>
                  {side === "remote" && (
                    <span className="hidden w-[78px] shrink-0 font-mono text-[10.5px] text-faint @[560px]:inline">{e.mode}</span>
                  )}
                </div>
              ))}
            {listing && !pane.error && shown.length === 0 && creating === null && (
              <div className="p-4 text-center text-[12px] text-faint">{filter ? "Nothing matches" : "Empty folder"}</div>
            )}
            {!listing && pane.loading && (
              <div className="flex justify-center p-6 text-muted">
                <Spinner />
              </div>
            )}
          </div>
          <div className="flex h-7 shrink-0 items-center gap-2 border-t border-border px-2.5 text-[11px] text-faint">
            <span className="min-w-0 flex-1 truncate" data-pane-status>
              {listing
                ? selected.size
                  ? `${selected.size} of ${shown.length} selected${selectedBytes ? ` (${fmtBytes(selectedBytes)})` : ""}`
                  : `${shown.length} item${shown.length === 1 ? "" : "s"}`
                : ""}
            </span>
            <input
              className="h-5 w-28 rounded border border-border bg-bg px-1.5 text-[11px] outline-none placeholder:text-faint focus:border-accent"
              placeholder="Filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setFilter("")}
              aria-label={`Filter ${side} files`}
            />
          </div>
        </>
      )}

      {props.dragOver && (
        <div className="pointer-events-none absolute inset-1 flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-accent-soft text-[12.5px] font-medium text-accent">
          Drop to upload to {listing?.path}
        </div>
      )}
      {confirmDelete && (
        <Modal
          title="Delete"
          width={440}
          onClose={() => setConfirmDelete(null)}
          footer={
            <>
              <button className="btn-outline" onClick={() => setConfirmDelete(null)}>
                Cancel
              </button>
              <button className="btn-danger" onClick={() => doDelete(confirmDelete)}>
                Delete
              </button>
            </>
          }
        >
          <div className="p-4 text-[13px]">
            Permanently delete{" "}
            {confirmDelete.length === 1 ? <b className="break-all">{confirmDelete[0]}</b> : <b>{confirmDelete.length} items</b>} from{" "}
            <span className="font-mono text-[12px]">{listing?.path}</span>
            {side === "local" ? " on this PC" : ""}? Folders are deleted with everything inside them. This can't be undone.
          </div>
        </Modal>
      )}
      {menu}
    </div>
  );
}

// ---- dragging between panes ----

interface DragOver {
  side: Side;
  /** A folder row under the pointer, or null for the pane's own folder. */
  dir: string | null;
}


const useFileDrag = create<{ from: Side | null; label: string; x: number; y: number; over: DragOver | null }>(() => ({
  from: null,
  label: "",
  x: 0,
  y: 0,
  over: null,
}));

function dragTargetAt(x: number, y: number): DragOver | null {
  const el = document.elementFromPoint(x, y);
  const pane = el?.closest("[data-files-pane]");
  if (!pane) return null;
  const row = el?.closest("[data-files-dir]");
  const dir = row && row !== pane ? row.getAttribute("data-files-dir") : null;
  return { side: pane.getAttribute("data-files-pane") as Side, dir: dir || null };
}

function startFileDrag(e: React.PointerEvent, from: Side, names: string[], onDrop: (over: DragOver) => void) {
  const startX = e.clientX;
  const startY = e.clientY;
  let dragging = false;
  const label = names.length === 1 ? names[0] : `${names.length} items`;
  const finish = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("keydown", key, true);
    useFileDrag.setState({ from: null, over: null });
  };
  const move = (ev: PointerEvent) => {
    if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
    dragging = true;
    useFileDrag.setState({ from, label, x: ev.clientX, y: ev.clientY, over: dragTargetAt(ev.clientX, ev.clientY) });
  };
  const up = (ev: PointerEvent) => {
    const over = dragging ? dragTargetAt(ev.clientX, ev.clientY) : null;
    if (dragging) suppressClickUntil = Date.now() + 300;
    finish();
    if (over) onDrop(over);
  };
  const key = (ev: KeyboardEvent) => {
    if (ev.key === "Escape" && dragging) {
      ev.stopPropagation();
      suppressClickUntil = Date.now() + 300;
      finish();
    }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("keydown", key, true);
}

function FileDragGhost() {
  const { from, label, x, y, over } = useFileDrag();
  if (!from) return null;
  const ok = over && over.side !== from;
  return (
    <div
      className="pointer-events-none fixed z-[3000] flex items-center gap-1.5 rounded-md border border-border bg-panel px-2 py-1 text-[12px] shadow-lg"
      style={{ left: x + 12, top: y + 8 }}
    >
      {from === "local" ? <Upload size={12} className={ok ? "text-accent" : "text-faint"} /> : <Download size={12} className={ok ? "text-accent" : "text-faint"} />}
      {label}
    </div>
  );
}

// ---- transfer queue ----

interface QueueItem {
  id: string;
  direction: "up" | "down";
  label: string;
  /** Upload: local paths. */
  local?: string[];
  /** Download: what to fetch. */
  remote?: RemoteSource[];
  dest: string;
  policy: OverwritePolicy;
  state: "queued" | "running" | "done" | "error" | "cancelled";
  done: number;
  total: number;
  file: string;
  /** Bytes per second, smoothed. */
  speed: number;
  started?: number;
  ended?: number;
  error?: string;
  result?: TransferResult;
}

function QueueRow({ q, onCancel, onRetry, onRemove }: { q: QueueItem; onCancel: () => void; onRetry: () => void; onRemove: () => void }) {
  const pct = q.total ? Math.min(100, (q.done / q.total) * 100) : q.state === "done" ? 100 : 0;
  const left = q.state === "running" && q.speed > 0 && q.total > q.done ? (q.total - q.done) / q.speed : null;
  const status =
    q.state === "queued"
      ? "Waiting"
      : q.state === "running"
        ? q.total
          ? `${fmtBytes(q.done)} of ${fmtBytes(q.total)}${q.speed ? ` · ${fmtBytes(q.speed)}/s` : ""}${left != null ? ` · ${fmtDuration(left)} left` : ""}`
          : "Starting…"
        : q.state === "done"
          ? `Done${q.total ? ` · ${fmtBytes(q.total)}` : ""}${q.started && q.ended ? ` in ${fmtDuration((q.ended - q.started) / 1000)}` : ""}${
              q.result?.skipped ? ` · ${q.result.skipped} skipped (already there)` : ""
            }`
          : q.state === "cancelled"
            ? "Cancelled"
            : q.error ?? "Failed";
  return (
    <div className="flex items-center gap-2.5 border-b border-border px-3 py-1.5 text-[12px] last:border-0" data-queue-item={q.label} data-state={q.state}>
      {q.direction === "up" ? <Upload size={13} className="shrink-0 text-muted" /> : <Download size={13} className="shrink-0 text-muted" />}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{q.label}</span>
          <span className="truncate text-[11px] text-faint">→ {q.dest}</span>
        </div>
        <div className="mt-1 flex items-center gap-2">
          <div className="h-1 w-40 shrink-0 overflow-hidden rounded-full bg-hover">
            <div
              className={`h-full rounded-full transition-[width] ${
                q.state === "done" ? "bg-ok" : q.state === "error" ? "bg-danger" : q.state === "cancelled" ? "bg-faint" : "bg-accent"
              }`}
              style={{ width: `${q.state === "error" ? 100 : pct}%` }}
            />
          </div>
          <span
            className={`min-w-0 truncate text-[11px] ${q.state === "error" ? "text-danger" : q.state === "done" ? "text-ok" : "text-faint"}`}
            title={q.state === "running" ? q.file : q.error}
            data-queue-status
          >
            {status}
          </span>
        </div>
      </div>
      {q.state === "running" || q.state === "queued" ? (
        <button className="btn-ghost h-6 px-1.5" title="Cancel" aria-label={`Cancel ${q.label}`} onClick={onCancel}>
          <X size={13} />
        </button>
      ) : (
        <>
          {(q.state === "error" || q.state === "cancelled") && (
            <button className="btn-ghost h-6 px-1.5" title="Retry" aria-label={`Retry ${q.label}`} onClick={onRetry}>
              <RotateCw size={12} />
            </button>
          )}
          <button className="btn-ghost h-6 px-1.5" title="Remove from list" aria-label={`Remove ${q.label}`} onClick={onRemove}>
            <X size={13} />
          </button>
        </>
      )}
    </div>
  );
}

// ---- the tab ----

type ConnState =
  | { state: "idle" }
  | { state: "connecting" }
  | { state: "connected"; home: string }
  | { state: "error"; error: string; kind?: string | null };

export function FilesTab({ tab, active }: { tab: FilesTabModel; active: boolean }) {
  const target = tab.target;
  const sshHosts = useApp((s) => s.sshHosts);
  const ftpSites = useApp((s) => s.ftpSites);
  const { showToast, setFilesTarget, connectFiles, openRemoteFile, openFtpDialog, loadConnections } = useApp.getState();
  const host = target?.kind === "ssh" ? sshHosts.find((h) => h.id === target.id) : undefined;
  const site = target?.kind === "ftp" ? ftpSites.find((f) => f.id === target.id) : undefined;
  const server = host ?? site;
  const [conn, setConn] = useState<ConnState>({ state: "idle" });
  const [policy, setPolicy] = useState<OverwritePolicy | "ask">("ask");
  const [showHidden, setShowHidden] = useState(false);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [conflict, setConflict] = useState<{
    names: string[];
    dest: string;
    hasFolder: boolean;
    resolve: (p: OverwritePolicy | null) => void;
  } | null>(null);
  const [osDragOver, setOsDragOver] = useState(false);
  const speeds = useRef(new Map<string, { t: number; done: number; speed: number }>());

  // Reconnects once when the server dropped the session, then retries.
  const targetRef = useRef(target);
  targetRef.current = target;
  const remoteCall = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (e) {
        const t = targetRef.current;
        if (!(e instanceof DbError && e.info.kind === "FILES_CLOSED") || !t) throw e;
        await connectFiles(tab.id, t);
        return await fn();
      }
    },
    [tab.id, connectFiles],
  );

  const localFs = useMemo<PaneFs>(
    () => ({
      list: async (path) => {
        const l = await localFsApi.list(path);
        return { path: l.path, parent: l.parent ?? null, sep: l.sep, entries: l.entries };
      },
      mkdir: localFsApi.mkdir,
      rename: localFsApi.rename,
      remove: localFsApi.remove,
    }),
    [],
  );
  const remoteFs = useMemo<PaneFs>(
    () => ({
      list: async (path) => {
        const l = await remoteCall(() => filesApi.list(tab.id, path));
        return { path: l.path, parent: l.path === "/" ? null : remoteParent(l.path), sep: "/", entries: l.entries };
      },
      mkdir: (path) => remoteCall(() => filesApi.mkdir(tab.id, path)),
      rename: (from, to) => remoteCall(() => filesApi.rename(tab.id, from, to)),
      remove: (paths) => remoteCall(() => filesApi.remove(tab.id, paths)),
    }),
    [tab.id, remoteCall],
  );
  const local = usePane(localFs, writeLocalDir);
  const remote = usePane(remoteFs);
  const localRef = useRef(local);
  localRef.current = local;
  const remoteRef = useRef(remote);
  remoteRef.current = remote;

  useEffect(() => {
    void (async () => {
      if (!(await local.load(readLocalDir()))) await local.load("");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = useCallback(async () => {
    const t = targetRef.current;
    if (!t) return;
    setConn({ state: "connecting" });
    remoteRef.current.reset();
    try {
      const r = await connectFiles(tab.id, t);
      setConn({ state: "connected", home: r.home });
      if (!(await remoteRef.current.load(r.path))) await remoteRef.current.load(r.home);
    } catch (e) {
      setConn({ state: "error", error: errText(e), kind: e instanceof DbError ? e.info.kind : null });
    }
  }, [tab.id, connectFiles]);

  useEffect(() => {
    if (target) void connect();
    else {
      setConn({ state: "idle" });
      remoteRef.current.reset();
      void filesApi.close(tab.id).catch(() => {});
    }
  }, [target?.kind, target?.id, connect, tab.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const connected = conn.state === "connected";

  // ---- queueing ----

  const update = (id: string, f: (q: QueueItem) => QueueItem) => setQueue((all) => all.map((q) => (q.id === id ? f(q) : q)));

  /** The overwrite policy for a transfer into `dest`, asking when needed. */
  const choosePolicy = async (names: string[], dest: string, destPane: PaneState): Promise<OverwritePolicy | null> => {
    if (policy !== "ask") return policy;
    let existing: SftpEntry[];
    try {
      const listing = destPane.listing?.path === dest ? destPane.listing : await destPane.fs.list(dest);
      existing = listing.entries.filter((e) => names.includes(e.name));
    } catch {
      existing = [];
    }
    if (!existing.length) return "overwrite";
    return new Promise((resolve) =>
      setConflict({ names: existing.map((e) => e.name), dest, hasFolder: existing.some(isDir), resolve }),
    );
  };

  const enqueue = (items: Omit<QueueItem, "id" | "state" | "done" | "total" | "file" | "speed">[]) =>
    setQueue((all) => [...all, ...items.map((i) => ({ ...i, id: uid(), state: "queued" as const, done: 0, total: 0, file: "", speed: 0 }))]);

  const upload = async (names: string[], destDir?: string) => {
    const l = local.listing;
    const r = remote.listing;
    if (!l || !r || !connected || l.path === DRIVES) return;
    const dest = destDir ? remoteJoin(r.path, destDir) : r.path;
    const p = await choosePolicy(names, dest, remote);
    if (!p) return;
    enqueue(names.map((n) => ({ direction: "up", label: n, local: [joinPath(l, n)], dest, policy: p })));
  };

  const download = async (names: string[], destDir?: string) => {
    const l = local.listing;
    const r = remote.listing;
    if (!l || !r || !connected) return;
    if (l.path === DRIVES && !destDir) {
      showToast("Open a folder on this PC first", "info");
      return;
    }
    const dest = destDir ? joinPath(l, destDir) : l.path;
    const p = await choosePolicy(names, dest, local);
    if (!p) return;
    const entries = names.map((n) => r.entries.find((e) => e.name === n)).filter((e): e is SftpEntry => !!e);
    enqueue(
      entries.map((e) => ({
        direction: "down",
        label: e.name,
        remote: [{ path: remoteJoin(r.path, e.name), dir: isDir(e), size: e.size, mtime: e.mtime }],
        dest,
        policy: p,
      })),
    );
  };

  const runItem = useCallback(
    async (q: QueueItem) => {
      speeds.current.set(q.id, { t: Date.now(), done: 0, speed: 0 });
      const onProgress = (p: TransferProgress) => {
        const s = speeds.current.get(q.id)!;
        const now = Date.now();
        const dt = (now - s.t) / 1000;
        if (dt >= 0.5) {
          const inst = Math.max(0, p.done - s.done) / dt;
          s.speed = s.speed ? s.speed * 0.6 + inst * 0.4 : inst;
          s.t = now;
          s.done = p.done;
        }
        update(q.id, (x) => ({ ...x, done: p.done, total: p.total, file: p.file, speed: s.speed }));
      };
      try {
        const result = await remoteCall(() =>
          q.direction === "up"
            ? filesApi.upload(tab.id, q.id, q.local ?? [], q.dest, q.policy, onProgress)
            : filesApi.download(tab.id, q.id, q.remote ?? [], q.dest, q.policy, onProgress),
        );
        update(q.id, (x) => ({ ...x, state: "done", done: x.total, ended: Date.now(), result }));
        const dest = q.direction === "up" ? remoteRef.current : localRef.current;
        if (dest.listing && (dest.listing.path === q.dest || q.dest.startsWith(dest.listing.path))) void dest.refresh();
      } catch (e) {
        const cancelled = e instanceof DbError && e.info.kind === "CANCELLED";
        update(q.id, (x) => ({ ...x, state: cancelled ? "cancelled" : "error", error: errText(e), ended: Date.now() }));
        const dest = q.direction === "up" ? remoteRef.current : localRef.current;
        void dest.refresh();
      } finally {
        speeds.current.delete(q.id);
      }
    },
    [tab.id, remoteCall],
  );

  // Start queued transfers, a couple at a time.
  useEffect(() => {
    const running = queue.filter((q) => q.state === "running").length;
    const next = queue.filter((q) => q.state === "queued").slice(0, Math.max(0, MAX_RUNNING - running));
    if (!next.length) return;
    const ids = new Set(next.map((q) => q.id));
    setQueue((all) => all.map((q) => (ids.has(q.id) ? { ...q, state: "running", started: Date.now() } : q)));
    next.forEach((q) => void runItem(q));
  }, [queue, runItem]);

  const cancel = (q: QueueItem) => {
    if (q.state === "running") void filesApi.cancel(q.id);
    else update(q.id, (x) => ({ ...x, state: "cancelled" }));
  };
  const retry = (q: QueueItem) =>
    update(q.id, (x) => ({ ...x, id: uid(), state: "queued", done: 0, total: 0, file: "", speed: 0, error: undefined, result: undefined }));

  // Files dropped from Explorer onto the server pane are uploaded.
  useEffect(() => {
    if (!active) return;
    let unlisten: (() => void) | undefined;
    const at = (pos: { x: number; y: number }) => dragTargetAt(pos.x / window.devicePixelRatio, pos.y / window.devicePixelRatio);
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "over") setOsDragOver(at(p.position)?.side === "remote");
        else if (p.type === "leave") setOsDragOver(false);
        else if (p.type === "drop") {
          setOsDragOver(false);
          const over = at(p.position);
          const r = remoteRef.current.listing;
          if (over?.side !== "remote" || !r || !p.paths.length) return;
          const dest = over.dir ? remoteJoin(r.path, over.dir) : r.path;
          void (async () => {
            const names = p.paths.map((x) => x.split(/[\\/]/).pop() ?? x);
            const pol = await choosePolicy(names, dest, remoteRef.current);
            if (!pol) return;
            enqueue(p.paths.map((x, i) => ({ direction: "up", label: names[i], local: [x], dest, policy: pol })));
          })();
        }
      })
      .then((u) => (unlisten = u));
    return () => unlisten?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, policy]);

  const trustCertificate = async () => {
    if (!site) return;
    try {
      await ftpApi.save({ ...site, acceptInvalidCerts: true }, null);
      await loadConnections();
      void connect();
    } catch (e) {
      showToast(errText(e), "error");
    }
  };

  // ---- rendering ----

  const pick = (t: FilesTarget | null) => setFilesTarget(tab.id, t);
  const serverItems: MenuEntry[] = [
    ...sshHosts.map((h) => ({ label: h.name, icon: <TerminalSquare size={13} />, onClick: () => pick({ kind: "ssh", id: h.id }) })),
    ...ftpSites.map((f) => ({ label: f.name, icon: <Server size={13} />, onClick: () => pick({ kind: "ftp", id: f.id }) })),
    ...(sshHosts.length || ftpSites.length ? (["separator"] as MenuEntry[]) : []),
    { label: "New FTP site…", icon: <Plus size={13} />, onClick: () => openFtpDialog() },
    ...(target ? [{ label: "Disconnect", icon: <Unplug size={13} />, onClick: () => pick(null) }] : []),
  ];

  const remotePlaceholder = !target ? (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-auto p-6 text-center">
      <div className="text-[13px] font-medium">Connect to a server</div>
      <div className="max-w-[340px] text-[12px] text-muted">SFTP through one of your SSH hosts, or an FTP / FTPS site.</div>
      <div className="flex w-full max-w-[320px] flex-col gap-1">
        {sshHosts.map((h) => (
          <button key={h.id} className="btn-outline justify-start" onClick={() => pick({ kind: "ssh", id: h.id })} data-pick-server={h.name}>
            <TerminalSquare size={13} style={{ color: h.color ?? undefined }} /> {h.name}
            <span className="ml-auto text-[11px] text-faint">SFTP</span>
          </button>
        ))}
        {ftpSites.map((f) => (
          <button key={f.id} className="btn-outline justify-start" onClick={() => pick({ kind: "ftp", id: f.id })} data-pick-server={f.name}>
            <Server size={13} style={{ color: f.color ?? undefined }} /> {f.name}
            <span className="ml-auto text-[11px] text-faint">{f.protocol.toUpperCase()}</span>
          </button>
        ))}
        <button className="btn-ghost justify-center" onClick={() => openFtpDialog()}>
          <Plus size={13} /> New FTP site
        </button>
      </div>
    </div>
  ) : conn.state === "connecting" || conn.state === "idle" ? (
    <div className="flex flex-1 items-center justify-center gap-2 text-[12.5px] text-muted">
      <Spinner size={12} /> Connecting to {server?.name ?? "server"}…
    </div>
  ) : conn.state === "error" ? (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="max-w-[420px] rounded-md bg-danger-soft px-3 py-2 text-[12.5px] text-danger" data-connect-error>
        {conn.error}
      </div>
      <div className="flex gap-2">
        <button className="btn-outline" onClick={() => void connect()}>
          <RotateCw size={12} /> Retry
        </button>
        {conn.kind === "FTP_TLS" && site && !site.acceptInvalidCerts && (
          <button className="btn-outline" onClick={() => void trustCertificate()} title="Encrypted, but the certificate isn't verified">
            <ShieldAlert size={13} /> Trust this server's certificate
          </button>
        )}
        {site && (
          <button className="btn-ghost" onClick={() => openFtpDialog(site)}>
            <Pencil size={12} /> Edit site
          </button>
        )}
      </div>
    </div>
  ) : undefined;

  const running = queue.filter((q) => q.state === "running" || q.state === "queued").length;
  const finished = queue.filter((q) => q.state === "done" || q.state === "cancelled").length;

  const panes = (
    <Group orientation="horizontal" className="h-full">
      <Panel minSize="240px">
        <FilePane
          side="local"
          pane={local}
          header={
            <>
              <Monitor size={13} className="text-muted" /> This PC
            </>
          }
          showHidden={showHidden}
          canTransfer={connected && !!remote.listing}
          homePath=""
          onTransfer={(names, dir) => void upload(names, dir)}
          onOpenFile={(e) => local.listing && void openPath(joinPath(local.listing, e.name)).catch((x) => showToast(errText(x), "error"))}
          extraMenu={(entries) =>
            entries.length === 1 && local.listing && local.listing.path !== DRIVES
              ? [
                  ...(isDir(entries[0])
                    ? []
                    : [
                        {
                          label: "Open",
                          icon: <ExternalLink size={13} />,
                          onClick: () => void openPath(joinPath(local.listing!, entries[0].name)).catch((x) => showToast(errText(x), "error")),
                        },
                      ]),
                  {
                    label: "Show in Explorer",
                    icon: <FolderOpen size={13} />,
                    onClick: () => void revealItemInDir(joinPath(local.listing!, entries[0].name)).catch(() => {}),
                  },
                ]
              : []
          }
          dragOver={false}
          active={active}
        />
      </Panel>
      <Separator className="w-px" />
      <Panel minSize="240px">
        <FilePane
          side="remote"
          pane={remote}
          header={
            <DropdownButton
              className="flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 hover:bg-hover"
              title="Choose a server"
              label={
                <>
                  {target?.kind === "ftp" ? (
                    <Server size={13} style={{ color: server?.color ?? undefined }} />
                  ) : (
                    <TerminalSquare size={13} style={{ color: server?.color ?? undefined }} />
                  )}
                  <span className="truncate" data-files-server>
                    {server ? server.name : "No server"}
                  </span>
                  {server && (
                    <span className="text-[11px] font-normal text-faint">
                      {target?.kind === "ftp" ? site?.protocol.toUpperCase() : "SFTP"} · {server.user ? `${server.user}@` : ""}
                      {server.host}
                    </span>
                  )}
                  <ChevronDown size={12} className="text-faint" />
                </>
              }
              items={serverItems}
            />
          }
          showHidden={showHidden}
          canTransfer={!!local.listing}
          homePath={conn.state === "connected" ? conn.home : ""}
          onTransfer={(names, dir) => void download(names, dir)}
          onOpenFile={(e) => {
            if (!target || !remote.listing) return;
            const path = remoteJoin(remote.listing.path, e.name);
            if (e.size > 10 * 1024 * 1024) void download([e.name]);
            else openRemoteFile("", target.id, path, tab.id);
          }}
          extraMenu={(entries) =>
            entries.length === 1 && !isDir(entries[0]) && target && remote.listing
              ? [
                  {
                    label: "Edit",
                    icon: <Pencil size={13} />,
                    onClick: () => openRemoteFile("", target.id, remoteJoin(remote.listing!.path, entries[0].name), tab.id),
                  },
                ]
              : []
          }
          probeLinks={target?.kind === "ftp"}
          placeholder={remotePlaceholder}
          dragOver={osDragOver}
          active={active}
        />
      </Panel>
    </Group>
  );

  return (
    <div className="flex h-full flex-col" data-files-tab={tab.title}>
      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-border bg-panel px-3 text-[12px]">
        <span className="text-[13px] font-semibold">Files</span>
        <span className="text-faint">Drag files between the sides, or double-click to transfer.</span>
        <div className="flex-1" />
        <label className="flex items-center gap-1.5 text-muted">
          If a file exists
          <select
            className="field h-7 w-auto py-0 text-[12px]"
            value={policy}
            onChange={(e) => setPolicy(e.target.value as OverwritePolicy | "ask")}
            aria-label="If a file exists"
          >
            <option value="ask">Ask</option>
            <option value="overwrite">Overwrite</option>
            <option value="newer">Overwrite if newer</option>
            <option value="skip">Skip</option>
          </select>
        </label>
        <button
          className={`btn-ghost h-7 px-1.5 ${showHidden ? "text-accent" : ""}`}
          title={showHidden ? "Hide hidden files" : "Show hidden files"}
          aria-label="Toggle hidden files"
          onClick={() => setShowHidden((v) => !v)}
        >
          {showHidden ? <Eye size={14} /> : <EyeOff size={14} />}
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <Group orientation="vertical" className="h-full">
          <Panel id="panes" minSize="200px">
            {panes}
          </Panel>
          {queue.length > 0 && <Separator className="h-px" />}
          {queue.length > 0 && (
            <Panel id="queue" defaultSize="170px" minSize="70px">
              <div className="flex h-full flex-col bg-panel" data-queue>
                <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3 text-[11.5px]">
                  <span className="font-semibold tracking-wide text-faint uppercase">Transfers</span>
                  <span className="text-faint">{running ? `${running} active` : "All finished"}</span>
                  <div className="flex-1" />
                  {finished > 0 && (
                    <button
                      className="btn-ghost h-6 px-1.5 text-[11.5px]"
                      onClick={() => setQueue((all) => all.filter((q) => q.state !== "done" && q.state !== "cancelled"))}
                    >
                      Clear finished
                    </button>
                  )}
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                  {queue.map((q) => (
                    <QueueRow
                      key={q.id}
                      q={q}
                      onCancel={() => cancel(q)}
                      onRetry={() => retry(q)}
                      onRemove={() => setQueue((all) => all.filter((x) => x.id !== q.id))}
                    />
                  ))}
                </div>
              </div>
            </Panel>
          )}
        </Group>
      </div>
      <FileDragGhost />
      {conflict && (
        <Modal
          title="Files already exist"
          width={460}
          closeOnBackdrop={false}
          onClose={() => {
            conflict.resolve(null);
            setConflict(null);
          }}
          footer={
            <>
              <button
                className="btn-outline"
                onClick={() => {
                  conflict.resolve(null);
                  setConflict(null);
                }}
              >
                Cancel
              </button>
              {(["skip", "newer", "overwrite"] as OverwritePolicy[]).map((p) => (
                <button
                  key={p}
                  className={p === "overwrite" ? "btn-primary" : "btn-outline"}
                  onClick={() => {
                    conflict.resolve(p);
                    setConflict(null);
                  }}
                >
                  {p === "skip" ? "Skip" : p === "newer" ? "Overwrite if newer" : "Overwrite"}
                </button>
              ))}
            </>
          }
        >
          <div className="flex flex-col gap-2 p-4 text-[13px]">
            <div>
              {conflict.names.length === 1 ? (
                <>
                  <b className="break-all">{conflict.names[0]}</b> already exists
                </>
              ) : (
                <>
                  <b>{conflict.names.length} items</b> already exist
                </>
              )}{" "}
              in <span className="font-mono text-[12px] break-all">{conflict.dest}</span>.
            </div>
            {conflict.names.length > 1 && (
              <div className="max-h-28 overflow-auto rounded-md bg-panel-2 px-2.5 py-1.5 font-mono text-[11.5px] text-muted">
                {conflict.names.map((n) => (
                  <div key={n} className="truncate">
                    {n}
                  </div>
                ))}
              </div>
            )}
            {conflict.hasFolder && (
              <div className="text-[12px] text-muted">For folders, this applies to each file inside them.</div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
