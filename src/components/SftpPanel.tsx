import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  ArrowUp,
  Copy,
  Download,
  Eye,
  EyeOff,
  File,
  FileSymlink,
  Folder,
  FolderPlus,
  FolderSymlink,
  FolderUp,
  Home,
  Link2,
  Link2Off,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { remoteJoin, remoteParent, sftpApi, type SftpEntry } from "../lib/api";
import { formatBytes } from "../lib/sql";
import { useApp } from "../store";
import { Modal, Spinner, useMenu, type MenuEntry } from "./ui";

interface Transfer {
  id: string;
  direction: "up" | "down";
  label: string;
  done: number;
  total: number;
  file: string;
  state: "running" | "done" | "error" | "cancelled";
  error?: string;
}

const uid = () => Math.random().toString(36).slice(2, 10);

function formatTime(mtime?: number | null): string {
  if (!mtime) return "";
  const d = new Date(mtime * 1000);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  if (d.getFullYear() === now.getFullYear()) return `${months[d.getMonth()]} ${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const isDirLike = (e: SftpEntry) => e.kind === "dir" || (e.kind === "link" && e.linkToDir);

export function SftpPanel(props: {
  termId: string;
  hostId: string;
  connected: boolean;
  /** Bumped by the terminal whenever the user presses Enter. */
  followSignal: number;
  visible: boolean;
}) {
  const { termId, hostId, connected, followSignal, visible } = props;
  const prefs = useApp((s) => s.filePanel);
  const setFilePanel = useApp((s) => s.setFilePanel);
  const showToast = useApp((s) => s.showToast);
  const openRemoteFile = useApp((s) => s.openRemoteFile);

  const [path, setPath] = useState("");
  const [pathDraft, setPathDraft] = useState("");
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ name: string; value: string } | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [menu, openMenu] = useMenu();
  const rootRef = useRef<HTMLDivElement>(null);
  const pathRef = useRef(path);
  pathRef.current = path;

  const load = useCallback(
    async (target: string, keepSelection = false) => {
      setLoading(true);
      try {
        const listing = await sftpApi.list(termId, target);
        setPath(listing.path);
        setPathDraft(listing.path);
        setEntries(listing.entries);
        setError(null);
        if (!keepSelection) setSelected(new Set());
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [termId],
  );

  const goToShellFolder = useCallback(
    async (quiet: boolean) => {
      try {
        const cwd = await sftpApi.cwd(termId);
        if (cwd && cwd !== pathRef.current) await load(cwd);
        else if (!cwd && !quiet) showToast("Couldn't detect the terminal's folder on this server", "info");
      } catch {
        // Following is best-effort.
      }
    },
    [termId, load, showToast],
  );

  // First load once the terminal connects: the shell's folder, or home.
  useEffect(() => {
    if (!connected) return;
    void (async () => {
      const cwd = prefs.follow ? await sftpApi.cwd(termId).catch(() => null) : null;
      await load(cwd ?? pathRef.current ?? "");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  // Follow the terminal: after each Enter, check where the shell is now.
  useEffect(() => {
    if (!followSignal || !connected || !prefs.follow) return;
    const t = setTimeout(() => void goToShellFolder(true), 350);
    return () => clearTimeout(t);
  }, [followSignal, connected, prefs.follow, goToShellFolder]);

  const shown = useMemo(() => {
    const list = prefs.showHidden ? entries : entries.filter((e) => !e.name.startsWith("."));
    return [...list].sort((a, b) => {
      const da = isDirLike(a) ? 0 : 1;
      const db = isDirLike(b) ? 0 : 1;
      return da - db || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    });
  }, [entries, prefs.showHidden]);

  // ---- transfers ----

  const runTransfer = async (direction: "up" | "down", items: string[], target: string) => {
    const id = uid();
    const label =
      items.length === 1
        ? (direction === "up" ? items[0].split(/[\\/]/).pop() : items[0].split("/").pop()) ?? "item"
        : `${items.length} items`;
    setTransfers((t) => [...t, { id, direction, label, done: 0, total: 0, file: "", state: "running" }]);
    const onProgress = (p: { done: number; total: number; file: string }) =>
      setTransfers((t) => t.map((x) => (x.id === id ? { ...x, done: p.done, total: p.total, file: p.file } : x)));
    try {
      if (direction === "up") await sftpApi.upload(termId, id, items, target, onProgress);
      else await sftpApi.download(termId, id, items, target, onProgress);
      setTransfers((t) => t.map((x) => (x.id === id ? { ...x, state: "done", done: x.total } : x)));
      if (direction === "up" && target === pathRef.current) void load(pathRef.current, true);
      if (direction === "down") showToast(`Downloaded ${label} to ${target}`, "ok");
      // Finished transfers fade out of the list.
      setTimeout(() => setTransfers((t) => t.filter((x) => x.id !== id)), 4000);
    } catch (e) {
      const info = e as { info?: { kind?: string; message?: string }; message?: string };
      const cancelled = info.info?.kind === "CANCELLED";
      setTransfers((t) =>
        t.map((x) =>
          x.id === id ? { ...x, state: cancelled ? "cancelled" : "error", error: info.info?.message ?? info.message } : x,
        ),
      );
      if (direction === "up") void load(pathRef.current, true);
    }
  };

  const uploadPicked = async (folder: boolean) => {
    const picked = await openDialog({ multiple: !folder, directory: folder, title: folder ? "Upload folder" : "Upload files" });
    if (!picked) return;
    const list = Array.isArray(picked) ? picked : [picked];
    if (list.length) void runTransfer("up", list, path);
  };

  const downloadItems = async (names: string[]) => {
    const dir = await openDialog({ directory: true, title: "Download to folder" });
    if (typeof dir !== "string") return;
    void runTransfer(
      "down",
      names.map((n) => remoteJoin(path, n)),
      dir,
    );
  };

  // Drag files from Explorer onto the panel to upload them.
  useEffect(() => {
    if (!visible) return;
    let unlisten: (() => void) | undefined;
    const inside = (pos: { x: number; y: number }) => {
      const r = rootRef.current?.getBoundingClientRect();
      if (!r) return false;
      const x = pos.x / window.devicePixelRatio;
      const y = pos.y / window.devicePixelRatio;
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "over") setDragOver(inside(p.position));
        else if (p.type === "leave") setDragOver(false);
        else if (p.type === "drop") {
          setDragOver(false);
          if (inside(p.position) && p.paths.length && pathRef.current) void runTransfer("up", p.paths, pathRef.current);
        }
      })
      .then((u) => (unlisten = u));
    return () => unlisten?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, termId]);

  // ---- actions ----

  const open = (e: SftpEntry) => {
    if (isDirLike(e)) void load(remoteJoin(path, e.name));
    else openRemoteFile(termId, hostId, remoteJoin(path, e.name));
  };

  const commitRename = async () => {
    if (!renaming) return;
    const { name, value } = renaming;
    setRenaming(null);
    if (!value.trim() || value === name) return;
    try {
      await sftpApi.rename(termId, remoteJoin(path, name), remoteJoin(path, value.trim()));
      await load(path, true);
      setSelected(new Set([value.trim()]));
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  const commitCreate = async () => {
    const name = creating?.trim();
    setCreating(null);
    if (!name) return;
    try {
      await sftpApi.mkdir(termId, remoteJoin(path, name));
      await load(path, true);
      setSelected(new Set([name]));
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  const doDelete = async (names: string[]) => {
    setConfirmDelete(null);
    try {
      await sftpApi.remove(
        termId,
        names.map((n) => remoteJoin(path, n)),
      );
      showToast(`Deleted ${names.length === 1 ? names[0] : `${names.length} items`}`, "ok");
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), "error");
    }
    await load(path);
  };

  const clickRow = (e: React.MouseEvent, name: string) => {
    if (e.shiftKey && anchor) {
      const names = shown.map((x) => x.name);
      const [a, b] = [names.indexOf(anchor), names.indexOf(name)].sort((x, y) => x - y);
      setSelected(new Set(names.slice(a, b + 1)));
    } else if (e.ctrlKey || e.metaKey) {
      setSelected((s) => {
        const n = new Set(s);
        if (n.has(name)) n.delete(name);
        else n.add(name);
        return n;
      });
      setAnchor(name);
    } else {
      setSelected(new Set([name]));
      setAnchor(name);
    }
  };

  const rowMenu = (e: React.MouseEvent, entry: SftpEntry) => {
    e.preventDefault();
    e.stopPropagation();
    const names = selected.has(entry.name) ? [...selected] : [entry.name];
    if (!selected.has(entry.name)) setSelected(new Set([entry.name]));
    const items: MenuEntry[] = [
      {
        label: isDirLike(entry) ? "Open" : "Edit",
        icon: isDirLike(entry) ? <Folder size={13} /> : <Pencil size={13} />,
        disabled: names.length > 1,
        onClick: () => open(entry),
      },
      { label: "Download…", icon: <Download size={13} />, onClick: () => void downloadItems(names) },
      "separator",
      {
        label: "Rename",
        icon: <Pencil size={13} />,
        hint: "F2",
        disabled: names.length > 1,
        onClick: () => setRenaming({ name: entry.name, value: entry.name }),
      },
      {
        label: "Copy path",
        icon: <Copy size={13} />,
        onClick: () => void navigator.clipboard.writeText(names.map((n) => remoteJoin(path, n)).join("\n")),
      },
      { label: "Delete…", icon: <Trash2 size={13} />, hint: "Del", danger: true, onClick: () => setConfirmDelete(names) },
    ];
    openMenu(e, items);
  };

  const backgroundMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    openMenu(e, [
      { label: "New folder", icon: <FolderPlus size={13} />, onClick: () => setCreating("") },
      { label: "Upload files…", icon: <Upload size={13} />, onClick: () => void uploadPicked(false) },
      { label: "Upload folder…", icon: <FolderUp size={13} />, onClick: () => void uploadPicked(true) },
      "separator",
      { label: "Refresh", icon: <RefreshCw size={13} />, onClick: () => void load(path, true) },
      { label: "Copy folder path", icon: <Copy size={13} />, onClick: () => void navigator.clipboard.writeText(path) },
    ]);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const names = [...selected];
    if (e.key === "Delete" && names.length) setConfirmDelete(names);
    else if (e.key === "F2" && names.length === 1) setRenaming({ name: names[0], value: names[0] });
    else if (e.key === "Backspace") void load(remoteParent(path));
    else if (e.key === "Enter" && names.length === 1) {
      const entry = entries.find((x) => x.name === names[0]);
      if (entry) open(entry);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setSelected(new Set(shown.map((x) => x.name)));
    } else return;
    e.preventDefault();
  };

  const iconFor = (e: SftpEntry) =>
    e.kind === "link" ? (
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

  return (
    <div
      ref={rootRef}
      className="@container relative flex h-full flex-col bg-panel outline-none"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      data-sftp-panel
    >
      <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border px-1.5">
        <button className={tool} title="Parent folder (Backspace)" disabled={!path || path === "/"} onClick={() => void load(remoteParent(path))}>
          <ArrowUp size={14} />
        </button>
        <button className={tool} title="Home folder" onClick={() => void load("")} disabled={!connected}>
          <Home size={13} />
        </button>
        <button className={tool} title="Refresh" onClick={() => void load(path, true)} disabled={!connected}>
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
        </button>
        <button
          className={`${tool} ${prefs.follow ? "text-accent" : ""}`}
          title={prefs.follow ? "Following the terminal's folder (click to stop)" : "Follow the terminal's folder"}
          onClick={() => {
            setFilePanel({ follow: !prefs.follow });
            if (!prefs.follow) void goToShellFolder(false);
          }}
        >
          {prefs.follow ? <Link2 size={14} /> : <Link2Off size={14} />}
        </button>
        <div className="flex-1" />
        <button className={tool} title="New folder" onClick={() => setCreating("")} disabled={!connected}>
          <FolderPlus size={14} />
        </button>
        <button className={tool} title="Upload files (or drop them here)" onClick={() => void uploadPicked(false)} disabled={!connected}>
          <Upload size={14} />
        </button>
        <button
          className={`${tool} ${prefs.showHidden ? "text-accent" : ""}`}
          title={prefs.showHidden ? "Hide hidden files" : "Show hidden files"}
          onClick={() => setFilePanel({ showHidden: !prefs.showHidden })}
        >
          {prefs.showHidden ? <Eye size={14} /> : <EyeOff size={14} />}
        </button>
      </div>
      <form
        className="shrink-0 border-b border-border p-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          void load(pathDraft.trim() || "/");
        }}
      >
        <input
          className="h-7 w-full rounded-md border border-border bg-bg px-2 font-mono text-[12px] outline-none focus:border-accent"
          value={pathDraft}
          onChange={(e) => setPathDraft(e.target.value)}
          placeholder={connected ? "/" : "Not connected"}
          spellCheck={false}
          aria-label="Remote path"
        />
      </form>

      <div className="min-h-0 flex-1 overflow-auto py-1" onContextMenu={backgroundMenu} onClick={(e) => e.target === e.currentTarget && setSelected(new Set())}>
        {!connected && <div className="p-4 text-center text-[12px] text-faint">Files appear once the terminal is connected.</div>}
        {connected && error && (
          <div className="m-2 rounded-md bg-danger-soft p-2.5 text-[12px] text-danger">
            {error}
            <button className="mt-1.5 block text-accent hover:underline" onClick={() => void load("")}>
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
                if (e.key === "Enter") void commitCreate();
                if (e.key === "Escape") setCreating(null);
              }}
              onBlur={() => void commitCreate()}
            />
          </div>
        )}
        {connected &&
          !error &&
          shown.map((e) => (
            <div
              key={e.name}
              className={`group flex h-[24px] cursor-default items-center gap-2 px-2.5 text-[12.5px] ${
                selected.has(e.name) ? "bg-accent-soft" : "hover:bg-hover"
              }`}
              onClick={(ev) => clickRow(ev, e.name)}
              onDoubleClick={() => open(e)}
              onContextMenu={(ev) => rowMenu(ev, e)}
              title={`${e.name}\n${e.mode}${e.owner ? ` ${e.owner}` : ""}${e.kind === "file" ? `\n${formatBytes(e.size)}` : ""}`}
              data-name={e.name}
            >
              <span className="shrink-0">{iconFor(e)}</span>
              {renaming?.name === e.name ? (
                <input
                  autoFocus
                  className="h-5 min-w-0 flex-1 rounded border border-accent bg-bg px-1 text-[12.5px] outline-none"
                  value={renaming.value}
                  onChange={(ev) => setRenaming({ name: e.name, value: ev.target.value })}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter") void commitRename();
                    if (ev.key === "Escape") setRenaming(null);
                  }}
                  onBlur={() => void commitRename()}
                  onFocus={(ev) => {
                    const dot = e.name.lastIndexOf(".");
                    ev.target.setSelectionRange(0, dot > 0 && !isDirLike(e) ? dot : e.name.length);
                  }}
                />
              ) : (
                <span className={`min-w-0 flex-1 truncate ${e.name.startsWith(".") ? "text-muted" : ""}`}>{e.name}</span>
              )}
              <span className="w-14 shrink-0 text-right text-[11px] text-faint tabular-nums">
                {e.kind === "file" ? formatBytes(e.size) : ""}
              </span>
              <span className="hidden w-[78px] shrink-0 text-right text-[11px] text-faint tabular-nums @[340px]:inline">
                {formatTime(e.mtime)}
              </span>
            </div>
          ))}
        {connected && !error && !loading && shown.length === 0 && creating === null && (
          <div className="p-4 text-center text-[12px] text-faint">Empty folder</div>
        )}
      </div>

      {transfers.length > 0 && (
        <div className="max-h-[40%] shrink-0 overflow-auto border-t border-border p-1.5">
          {transfers.map((t) => {
            const pct = t.total ? Math.min(100, (t.done / t.total) * 100) : t.state === "done" ? 100 : 0;
            return (
              <div key={t.id} className="rounded-md px-2 py-1.5 text-[11.5px]">
                <div className="flex items-center gap-1.5">
                  {t.direction === "up" ? <Upload size={12} className="text-muted" /> : <Download size={12} className="text-muted" />}
                  <span className="min-w-0 flex-1 truncate" title={t.file}>
                    {t.label}
                  </span>
                  <span
                    className={`shrink-0 ${t.state === "error" ? "text-danger" : t.state === "done" ? "text-ok" : "text-faint"}`}
                  >
                    {t.state === "running"
                      ? t.total
                        ? `${formatBytes(t.done)} / ${formatBytes(t.total)}`
                        : "starting…"
                      : t.state === "done"
                        ? "done"
                        : t.state === "cancelled"
                          ? "cancelled"
                          : "failed"}
                  </span>
                  <button
                    className="shrink-0 rounded p-0.5 text-faint hover:bg-hover hover:text-text"
                    title={t.state === "running" ? "Cancel" : "Dismiss"}
                    onClick={() =>
                      t.state === "running"
                        ? void sftpApi.cancel(t.id)
                        : setTransfers((all) => all.filter((x) => x.id !== t.id))
                    }
                  >
                    <X size={12} />
                  </button>
                </div>
                {t.state === "error" ? (
                  <div className="mt-0.5 text-danger">{t.error}</div>
                ) : (
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-hover">
                    <div
                      className={`h-full rounded-full transition-[width] ${t.state === "done" ? "bg-ok" : "bg-accent"}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {dragOver && (
        <div className="pointer-events-none absolute inset-1 flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-accent-soft text-[12.5px] font-medium text-accent">
          Drop to upload to {path}
        </div>
      )}
      {loading && entries.length === 0 && connected && (
        <div className="absolute inset-x-0 top-24 flex justify-center text-muted">
          <Spinner />
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
              <button className="btn-danger" onClick={() => void doDelete(confirmDelete)}>
                Delete
              </button>
            </>
          }
        >
          <div className="p-4 text-[13px]">
            Permanently delete{" "}
            {confirmDelete.length === 1 ? <b className="break-all">{confirmDelete[0]}</b> : <b>{confirmDelete.length} items</b>} from{" "}
            <span className="font-mono text-[12px]">{path}</span>? Folders are deleted with everything inside them. This can't be
            undone.
          </div>
        </Modal>
      )}
      {menu}
    </div>
  );
}
