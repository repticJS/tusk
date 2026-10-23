import {
  Activity,
  ChevronRight,
  FolderClosed,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Copy,
  Database,
  Eye,
  FileCode2,
  FolderTree,
  Layers,
  Pencil,
  Plug,
  PlugZap,
  Plus,
  RefreshCw,
  Search,
  SquareTerminal,
  Table2,
  TerminalSquare,
  Monitor,
  Zap,
  AlertTriangle,
  BellOff,
  BellRing,
  Download,
  Share2,
  Radar,
  Trash2,
  Waypoints,
  X,
  FolderSync,
  Server,
  ScreenShare,
  Bot,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ConnectionConfig, Folder, FtpSite, ItemKind, RdpConfig, SshHost } from "../lib/api";
import { blankConnection, blankFtpSite, blankRdp, blankSshHost, blankTunnel } from "../lib/defaults";
import * as meta from "../lib/meta";
import { qualified } from "../lib/sql";
import { clickSuppressed, startTreeDrag, useTreeDrag, type DragItem } from "../lib/treeDrag";
import { cacheKey, metaSession, useApp } from "../store";
import { DropdownButton, Modal, Spinner, useMenu, type MenuEntry } from "./ui";
import { accessLabel, effectiveAccess } from "./Claude";

/** "Claude access…" for an item's menu. */
function claudeEntry(id: string, name: string, folderId: string | null | undefined, isFolder = false): MenuEntry {
  return {
    label: "Claude access…",
    icon: <Bot size={13} />,
    onClick: () => useApp.getState().editClaudeAccess({ id, name, folderId: folderId ?? null, isFolder }),
  };
}

/** A small mark on items Claude may use. */
function ClaudeMark({ id, folderId }: { id: string; folderId?: string | null }) {
  // A string, so the selector's result is stable between renders.
  const key = useApp((s) => {
    if (!s.claude?.enabled) return "off";
    const a = effectiveAccess(s.claude.access, id, folderId, s.folders).access;
    return a.level === "write" ? (a.ask ? "write-ask" : "write") : a.level;
  });
  if (key === "off") return null;
  const a = { level: key.startsWith("write") ? ("write" as const) : ("read" as const), ask: key === "write-ask" };
  return (
    <span title={`Claude: ${accessLabel(a).toLowerCase()}`} data-claude-mark={a.level} className="ml-1 inline-flex align-middle">
      <Bot size={11} className={a.level === "write" ? "text-warn" : "text-accent"} />
    </span>
  );
}

function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`;
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`;
  return `${(n / 1e9).toFixed(1)}B`;
}

export function Sidebar() {
  const connections = useApp((s) => s.connections);
  const sshHosts = useApp((s) => s.sshHosts);
  const ftpSites = useApp((s) => s.ftpSites);
  const rdpConnections = useApp((s) => s.rdpConnections);
  const folders = useApp((s) => s.folders);
  const shells = useApp((s) => s.shells);
  const status = useApp((s) => s.status);
  const openConnectionDialog = useApp((s) => s.openConnectionDialog);
  const openSshDialog = useApp((s) => s.openSshDialog);
  const createFolder = useApp((s) => s.createFolder);
  const moveItems = useApp((s) => s.moveItems);
  const dragOver = useTreeDrag((s) => (s.item ? s.over : null));
  const [filter, setFilter] = useState("");
  const q = filter.trim().toLowerCase();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [menu, openMenu] = useMenu();
  const [moving, setMoving] = useState<{ kind: ItemKind; id: string; label: string } | null>(null);

  const toggle = (key: string, force?: boolean) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      const on = force ?? !next.has(key);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  // While filtering, show only matching hosts/connections (and connected
  // databases, whose tables are filtered inside), plus the folders on their path.
  const visible = useMemo(() => {
    if (!q) return null;
    const keep = new Set<string>();
    const parentOf = new Map(folders.map((f) => [f.id, f.parentId ?? null]));
    const addPath = (folderId: string | null | undefined) => {
      let cur = folderId ?? null;
      for (let i = 0; cur && i <= folders.length; i++) {
        keep.add(cur);
        cur = parentOf.get(cur) ?? null;
      }
    };
    for (const h of sshHosts)
      if (h.name.toLowerCase().includes(q) || h.host.toLowerCase().includes(q)) {
        keep.add(h.id);
        addPath(h.folderId);
      }
    for (const f of [...ftpSites, ...rdpConnections])
      if (f.name.toLowerCase().includes(q) || f.host.toLowerCase().includes(q)) {
        keep.add(f.id);
        addPath(f.folderId);
      }
    for (const c of connections)
      if (c.name.toLowerCase().includes(q) || c.host.toLowerCase().includes(q) || status[c.id]?.state === "connected") {
        keep.add(c.id);
        addPath(c.folderId);
      }
    for (const f of folders) if (f.name.toLowerCase().includes(q)) addPath(f.id);
    return keep;
  }, [q, folders, sshHosts, ftpSites, rdpConnections, connections, status]);

  const onDrop = (item: DragItem, folderId: string | null) => {
    if (item.kind === "folder" && item.id === folderId) return;
    void moveItems([{ kind: item.kind, id: item.id }], folderId);
  };

  const tree: TreeCtx = { q, visible, expanded, toggle, openMenu, onDrop, onMove: setMoving };
  const empty =
    connections.length === 0 && sshHosts.length === 0 && ftpSites.length === 0 && rdpConnections.length === 0 && folders.length === 0;

  return (
    <div className="flex h-full flex-col bg-panel">
      {/* The name gives way to the buttons when the sidebar is narrow. */}
      <div className="@container flex h-11 shrink-0 items-center gap-0.5 overflow-hidden border-b border-border px-2.5">
        <img src="/icon.svg" alt="" className="mr-1.5 h-5 w-5 shrink-0" />
        <span className="hidden text-[13.5px] font-semibold tracking-tight @[270px]:inline">Tusk</span>
        <div className="flex-1" />
        <DropdownButton
          className="btn-ghost h-7 px-1.5"
          title="Local terminal"
          label={<Monitor size={15} />}
          items={
            shells.length
              ? shells.map((sh) => ({
                  label: sh.name,
                  icon: <Monitor size={13} />,
                  onClick: () => useApp.getState().openLocalTerminal(sh.id),
                }))
              : [{ label: "No shells found", disabled: true, onClick: () => {} }]
          }
        />
        <button
          className="btn-ghost h-7 px-1.5"
          title="Discover databases and containers"
          onClick={() => useApp.getState().openDiscoverTab()}
        >
          <Radar size={15} />
        </button>
        <button className="btn-ghost h-7 px-1.5" title="File manager" onClick={() => useApp.getState().openFilesTab()}>
          <FolderSync size={15} />
        </button>
        <button className="btn-ghost h-7 px-1.5" title="SSH tunnels" onClick={() => useApp.getState().openTunnelsTab()}>
          <Waypoints size={15} />
        </button>
        <DropdownButton
          className="btn-ghost h-7 px-1.5"
          title="New connection or folder"
          label={<Plus size={15} />}
          items={[
            { label: "New PostgreSQL connection", icon: <Database size={13} />, onClick: () => openConnectionDialog() },
            { label: "New SSH host", icon: <TerminalSquare size={13} />, onClick: () => openSshDialog() },
            { label: "New FTP site", icon: <Server size={13} />, onClick: () => useApp.getState().openFtpDialog() },
            { label: "New remote desktop", icon: <ScreenShare size={13} />, onClick: () => useApp.getState().openRdpDialog() },
            "separator",
            { label: "New folder", icon: <FolderPlus size={13} />, onClick: () => void createFolder(null) },
            { label: "New command…", icon: <Zap size={13} />, onClick: () => useApp.getState().openCommandDialog() },
            {
              label: "Import shared folder…",
              icon: <Download size={13} />,
              onClick: () => useApp.getState().openImportDialog(null),
            },
          ]}
        />
      </div>
      <div className="shrink-0 p-2">
        <div className="flex h-7 items-center gap-1.5 rounded-md border border-border bg-bg px-2 focus-within:border-accent">
          <Search size={13} className="text-faint" />
          <input
            className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-faint"
            placeholder="Filter hosts and tables…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setFilter("")}
          />
          {filter && (
            <button className="text-faint hover:text-text" onClick={() => setFilter("")}>
              <X size={12} />
            </button>
          )}
        </div>
      </div>
      <div
        className={`min-h-0 flex-1 overflow-auto px-1.5 pb-3 ${dragOver === "" ? "bg-accent-soft/40" : ""}`}
        data-drop=""
        onContextMenu={(e) => {
          if (e.target !== e.currentTarget) return;
          e.preventDefault();
          openMenu(e, [
            { label: "New PostgreSQL connection", icon: <Database size={13} />, onClick: () => openConnectionDialog() },
            { label: "New SSH host", icon: <TerminalSquare size={13} />, onClick: () => openSshDialog() },
            { label: "New FTP site", icon: <Server size={13} />, onClick: () => useApp.getState().openFtpDialog() },
            { label: "New remote desktop", icon: <ScreenShare size={13} />, onClick: () => useApp.getState().openRdpDialog() },
            { label: "New folder", icon: <FolderPlus size={13} />, onClick: () => void createFolder(null) },
          ]);
        }}
      >
        {empty && (
          <div className="px-3 py-8 text-center text-[12.5px] text-faint">
            No connections yet.
            <br />
            <button className="mt-3 btn-outline" onClick={() => openConnectionDialog()}>
              <Plus size={13} /> Add connection
            </button>
          </div>
        )}
        <FolderContents parentId={null} depth={0} tree={tree} />
        {/* Spare space below the tree is a drop target for the top level. */}
        <div className="h-8" />
      </div>
      <DragGhost />
      {moving && <MoveDialog item={moving} onClose={() => setMoving(null)} />}
      {menu}
    </div>
  );
}

interface TreeCtx {
  q: string;
  /** Ids to show while filtering; null when not filtering. */
  visible: Set<string> | null;
  expanded: Set<string>;
  toggle: (key: string, force?: boolean) => void;
  openMenu: (at: { clientX: number; clientY: number }, items: MenuEntry[]) => void;
  onDrop: (item: DragItem, folderId: string | null) => void;
  onMove: (item: { kind: ItemKind; id: string; label: string }) => void;
}

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

/** A folder's children: subfolders first, then hosts and connections, by name. */
function FolderContents({ parentId, depth, tree }: { parentId: string | null; depth: number; tree: TreeCtx }) {
  const folders = useApp((s) => s.folders);
  const connections = useApp((s) => s.connections);
  const sshHosts = useApp((s) => s.sshHosts);
  const ftpSites = useApp((s) => s.ftpSites);
  const rdpConnections = useApp((s) => s.rdpConnections);
  const inHere = (f?: string | null) => (f ?? null) === parentId;
  const show = (id: string) => !tree.visible || tree.visible.has(id);
  const subfolders = folders.filter((f) => inHere(f.parentId) && show(f.id)).sort(byName);
  const items = [
    ...connections.filter((c) => inHere(c.folderId) && show(c.id)).map((c) => ({ name: c.name, conn: c })),
    ...sshHosts.filter((h) => inHere(h.folderId) && show(h.id)).map((h) => ({ name: h.name, host: h })),
    ...ftpSites.filter((f) => inHere(f.folderId) && show(f.id)).map((f) => ({ name: f.name, site: f })),
    ...rdpConnections.filter((r) => inHere(r.folderId) && show(r.id)).map((r) => ({ name: r.name, rdp: r })),
  ].sort(byName);
  return (
    <>
      {subfolders.map((f) => (
        <FolderNode key={f.id} folder={f} depth={depth} tree={tree} />
      ))}
      {items.map((it) =>
        "conn" in it && it.conn ? (
          <div key={it.conn.id} data-drop={parentId ?? ""}>
            <ConnectionNode
              conn={it.conn}
              base={depth}
              filter={tree.q}
              expanded={tree.expanded}
              toggle={tree.toggle}
              openMenu={tree.openMenu}
              onDrop={tree.onDrop}
              onMove={tree.onMove}
            />
          </div>
        ) : "host" in it && it.host ? (
          <div key={it.host.id} data-drop={parentId ?? ""}>
            <SshNode host={it.host} depth={depth} openMenu={tree.openMenu} onDrop={tree.onDrop} onMove={tree.onMove} />
          </div>
        ) : "site" in it && it.site ? (
          <div key={it.site.id} data-drop={parentId ?? ""}>
            <FtpNode site={it.site} depth={depth} openMenu={tree.openMenu} onDrop={tree.onDrop} onMove={tree.onMove} />
          </div>
        ) : "rdp" in it && it.rdp ? (
          <div key={it.rdp.id} data-drop={parentId ?? ""}>
            <RdpNode conn={it.rdp} depth={depth} openMenu={tree.openMenu} onDrop={tree.onDrop} onMove={tree.onMove} />
          </div>
        ) : null,
      )}
    </>
  );
}

function FolderNode({ folder, depth, tree }: { folder: Folder; depth: number; tree: TreeCtx }) {
  const collapsed = useApp((s) => s.collapsedFolders.includes(folder.id));
  const renaming = useApp((s) => s.renamingFolderId === folder.id);
  const count = useApp(
    (s) =>
      s.folders.filter((f) => f.parentId === folder.id).length +
      s.connections.filter((c) => c.folderId === folder.id).length +
      s.sshHosts.filter((h) => h.folderId === folder.id).length +
      s.ftpSites.filter((f) => f.folderId === folder.id).length +
      s.rdpConnections.filter((r) => r.folderId === folder.id).length,
  );
  const toggleFolder = useApp((s) => s.toggleFolder);
  const renameFolder = useApp((s) => s.renameFolder);
  const setRenamingFolder = useApp((s) => s.setRenamingFolder);
  const createFolder = useApp((s) => s.createFolder);
  const deleteFolder = useApp((s) => s.deleteFolder);
  const openConnectionDialog = useApp((s) => s.openConnectionDialog);
  const openSshDialog = useApp((s) => s.openSshDialog);
  const isDropTarget = useTreeDrag((s) => !!s.item && s.over === folder.id);
  const [draft, setDraft] = useState(folder.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Filtering opens every folder on the way to a match.
  const open = !!tree.visible || !collapsed;

  useEffect(() => {
    if (renaming) setDraft(folder.name);
  }, [renaming, folder.name]);

  return (
    <div data-drop={folder.id}>
      <div
        className={`group flex h-[26px] cursor-default items-center gap-1 rounded-md pr-1.5 text-[12.5px] ${
          isDropTarget ? "bg-accent-soft ring-1 ring-accent" : "text-text/90 hover:bg-hover"
        }`}
        style={{ paddingLeft: 4 + depth * 14 }}
        onClick={() => !clickSuppressed() && !renaming && toggleFolder(folder.id)}
        onPointerDown={(e) => !renaming && startTreeDrag(e, { kind: "folder", id: folder.id, label: folder.name }, tree.onDrop)}
        onKeyDown={(e) => e.key === "F2" && setRenamingFolder(folder.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          tree.openMenu(e, [
            { label: "New folder inside", icon: <FolderPlus size={13} />, onClick: () => void createFolder(folder.id) },
            {
              label: "New SSH host here",
              icon: <TerminalSquare size={13} />,
              onClick: () => openSshDialog({ ...blankSshHost(), folderId: folder.id }),
            },
            {
              label: "New PostgreSQL connection here",
              icon: <Database size={13} />,
              onClick: () => openConnectionDialog({ ...blankConnection(), folderId: folder.id }),
            },
            {
              label: "New FTP site here",
              icon: <Server size={13} />,
              onClick: () => useApp.getState().openFtpDialog({ ...blankFtpSite(), folderId: folder.id }),
            },
            {
              label: "New remote desktop here",
              icon: <ScreenShare size={13} />,
              onClick: () => useApp.getState().openRdpDialog({ ...blankRdp(), folderId: folder.id }),
            },
            "separator",
            { label: "Share folder…", icon: <Share2 size={13} />, onClick: () => useApp.getState().openShareDialog(folder.id) },
            {
              label: "New command for this folder…",
              icon: <Zap size={13} />,
              onClick: () => {
                const s = useApp.getState();
                // Every SSH host in the folder and its subfolders.
                const ids = new Set([folder.id]);
                let grew = true;
                while (grew) {
                  grew = false;
                  for (const f of s.folders) {
                    if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) {
                      ids.add(f.id);
                      grew = true;
                    }
                  }
                }
                s.openCommandDialog({ hostIds: s.sshHosts.filter((h) => h.folderId && ids.has(h.folderId)).map((h) => h.id) });
              },
            },
            {
              label: "Import into this folder…",
              icon: <Download size={13} />,
              onClick: () => useApp.getState().openImportDialog(folder.id),
            },
            "separator",
            { label: "Rename", icon: <Pencil size={13} />, hint: "F2", onClick: () => setRenamingFolder(folder.id) },
            claudeEntry(folder.id, folder.name, folder.parentId, true),
            {
              label: "Move to…",
              icon: <FolderInput size={13} />,
              onClick: () => tree.onMove({ kind: "folder", id: folder.id, label: folder.name }),
            },
            { label: "Delete folder…", icon: <Trash2 size={13} />, danger: true, onClick: () => setConfirmDelete(true) },
          ]);
        }}
        title={folder.name}
        tabIndex={-1}
        data-folder-row={folder.name}
      >
        <span className="flex w-3.5 shrink-0 justify-center text-faint">
          <ChevronRight size={12} className={`transition-transform ${open ? "rotate-90" : ""}`} />
        </span>
        <span className="flex shrink-0 items-center text-muted">
          {open ? <FolderOpen size={14} className="text-warn" /> : <FolderClosed size={14} className="text-warn" />}
        </span>
        {renaming ? (
          <input
            autoFocus
            className="h-5 min-w-0 flex-1 rounded border border-accent bg-bg px-1 text-[12.5px] outline-none"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.target.select()}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") void renameFolder(folder.id, draft);
              if (e.key === "Escape") setRenamingFolder(null);
            }}
            onBlur={() => void renameFolder(folder.id, draft)}
            aria-label="Folder name"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate font-medium">
            {folder.name}
            <ClaudeMark id={folder.id} folderId={folder.parentId} />
          </span>
        )}
        {!renaming && <span className="shrink-0 text-[11px] text-faint">{count || ""}</span>}
      </div>
      {open && (
        <>
          <FolderContents parentId={folder.id} depth={depth + 1} tree={tree} />
          {count === 0 && !tree.visible && (
            <div className="flex h-[24px] items-center text-[11.5px] text-faint italic" style={{ paddingLeft: 4 + (depth + 1) * 14 + 18 }}>
              Empty: drag connections here
            </div>
          )}
        </>
      )}
      {confirmDelete && (
        <Modal
          title="Delete folder"
          width={420}
          onClose={() => setConfirmDelete(false)}
          footer={
            <>
              <button className="btn-outline" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
              <button
                className="btn-danger"
                onClick={() => {
                  setConfirmDelete(false);
                  void deleteFolder(folder.id);
                }}
              >
                Delete folder
              </button>
            </>
          }
        >
          <div className="p-4 text-[13px]">
            Delete the folder <b>{folder.name}</b>?{" "}
            {count > 0 ? "Its contents aren't deleted: they move up one level." : "It's empty."}
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Label that follows the pointer while dragging a tree item. */
function DragGhost() {
  const { item, x, y } = useTreeDrag();
  if (!item) return null;
  return (
    <div
      className="pointer-events-none fixed z-[3000] rounded-md border border-border bg-panel px-2 py-1 text-[12px] shadow-lg"
      style={{ left: x + 12, top: y + 8 }}
    >
      {item.label}
    </div>
  );
}

/** Picks a destination folder: the keyboard-friendly alternative to dragging. */
function MoveDialog({ item, onClose }: { item: { kind: ItemKind; id: string; label: string }; onClose: () => void }) {
  const folders = useApp((s) => s.folders);
  const moveItems = useApp((s) => s.moveItems);
  // A folder can't move into itself or anything inside it.
  const blocked = useMemo(() => {
    const out = new Set<string>();
    if (item.kind !== "folder") return out;
    const walk = (id: string) => {
      out.add(id);
      folders.filter((f) => f.parentId === id).forEach((f) => walk(f.id));
    };
    walk(item.id);
    return out;
  }, [folders, item]);
  const rows: { id: string | null; name: string; depth: number }[] = [{ id: null, name: "Top level", depth: 0 }];
  const add = (parent: string | null, depth: number) => {
    for (const f of folders.filter((x) => (x.parentId ?? null) === parent && !blocked.has(x.id)).sort(byName)) {
      rows.push({ id: f.id, name: f.name, depth });
      add(f.id, depth + 1);
    }
  };
  add(null, 1);
  return (
    <Modal title={`Move ${item.label}`} width={400} onClose={onClose}>
      <div className="max-h-[50vh] overflow-auto p-2">
        {rows.map((r) => (
          <button
            key={r.id ?? "__top"}
            className="flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-[12.5px] hover:bg-hover"
            style={{ paddingLeft: 8 + r.depth * 16 }}
            onClick={() => {
              onClose();
              void moveItems([{ kind: item.kind, id: item.id }], r.id);
            }}
          >
            {r.id ? <FolderClosed size={14} className="text-warn" /> : <Layers size={14} className="text-muted" />}
            {r.name}
          </button>
        ))}
      </div>
    </Modal>
  );
}

function SshNode({
  host,
  depth,
  openMenu,
  onDrop,
  onMove,
}: {
  host: SshHost;
  depth: number;
  openMenu: NodeProps["openMenu"];
  onDrop: NodeProps["onDrop"];
  onMove: NodeProps["onMove"];
}) {
  const openTerminalTab = useApp((s) => s.openTerminalTab);
  const openSshDialog = useApp((s) => s.openSshDialog);
  const deleteSshHost = useApp((s) => s.deleteSshHost);
  const openTabs = useApp((s) => s.tabs.filter((t) => t.kind === "terminal" && t.hostId === host.id).length);
  const isActive = useApp((s) => {
    const t = s.tabs.find((x) => x.id === s.activeTabId);
    return t?.kind === "terminal" && t.hostId === host.id;
  });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const target = `${host.user}@${host.host}${host.port === 22 ? "" : `:${host.port}`}`;
  const monitored = useApp((s) => !!s.monitor?.settings.hosts.includes(host.id));
  const allCommands = useApp((s) => s.commands);
  const hostCommands = allCommands.filter((c) => c.hostIds.includes(host.id));
  // Worst problem the monitor found: shown on the row.
  const health = useApp((s) => {
    const p = s.monitor?.hosts.find((h) => h.hostId === host.id)?.problems ?? [];
    return p.some((x) => x.severity === "critical") ? "critical" : p.length ? "warning" : null;
  });
  return (
    <>
      <Row
        depth={depth}
        onPointerDown={(e) => startTreeDrag(e, { kind: "ssh", id: host.id, label: host.name }, onDrop)}
        active={isActive}
        icon={
          <span className="relative">
            <TerminalSquare size={14} style={{ color: host.color ?? undefined }} />
            {openTabs > 0 && (
              <span className="absolute -right-0.5 -bottom-0.5 h-1.5 w-1.5 rounded-full bg-ok ring-2 ring-panel" />
            )}
          </span>
        }
        label={
          <>
            <span className="font-medium">{host.name}</span>
            <ClaudeMark id={host.id} folderId={host.folderId} />
          </>
        }
        right={
          health ? (
            <button
              className="flex items-center"
              title="Monitoring found problems"
              onClick={(e) => {
                e.stopPropagation();
                useApp.getState().openMonitorTab();
              }}
            >
              <AlertTriangle size={12} className={health === "critical" ? "text-danger" : "text-warn"} />
            </button>
          ) : (
            <span className="font-mono">{host.host}</span>
          )
        }
        title={`${target}\nClick to open a terminal`}
        onClick={() => !clickSuppressed() && openTerminalTab(host.id)}
        onContextMenu={(e) =>
          openMenu(e, [
            { label: "Open terminal", icon: <TerminalSquare size={13} />, onClick: () => openTerminalTab(host.id) },
            {
              label: "Open file manager",
              icon: <FolderSync size={13} />,
              onClick: () => useApp.getState().openFilesTab({ kind: "ssh", id: host.id }),
            },
            monitored
              ? { label: "Stop monitoring", icon: <BellOff size={13} />, onClick: () => void useApp.getState().setMonitored(host.id, false) }
              : { label: "Monitor this host", icon: <BellRing size={13} />, onClick: () => void useApp.getState().setMonitored(host.id, true) },
            ...hostCommands.slice(0, 6).map((c) => ({
              label: `Run: ${c.name}`,
              icon: <Zap size={13} />,
              onClick: () => useApp.getState().runCommand(c),
            })),
            {
              label: "New command…",
              icon: <Zap size={13} />,
              onClick: () => useApp.getState().openCommandDialog({ hostIds: [host.id] }),
            },
            "separator",
            {
              label: "Scan for databases & containers",
              icon: <Radar size={13} />,
              onClick: () => useApp.getState().openDiscoverTab(host.id),
            },
            {
              label: "New tunnel…",
              icon: <Waypoints size={13} />,
              onClick: () => {
                const s = useApp.getState();
                s.openTunnelsTab();
                s.openTunnelDialog(blankTunnel(host.id));
              },
            },
            "separator",
            { label: "Edit…", icon: <Pencil size={13} />, onClick: () => openSshDialog(host) },
            {
              label: "Duplicate",
              icon: <Copy size={13} />,
              onClick: () => openSshDialog({ ...host, id: "", name: `${host.name} copy` }),
            },
            { label: "Copy ssh command", icon: <Copy size={13} />, onClick: () => void navigator.clipboard.writeText(`ssh ${host.port === 22 ? "" : `-p ${host.port} `}${host.user}@${host.host}`) },
            claudeEntry(host.id, host.name, host.folderId),
            {
              label: "Move to…",
              icon: <FolderInput size={13} />,
              onClick: () => onMove({ kind: "ssh", id: host.id, label: host.name }),
            },
            { label: "Delete…", icon: <Trash2 size={13} />, danger: true, onClick: () => setConfirmDelete(true) },
          ])
        }
      />
      {confirmDelete && (
        <Modal
          title="Delete SSH host"
          width={420}
          onClose={() => setConfirmDelete(false)}
          footer={
            <>
              <button className="btn-outline" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
              <button
                className="btn-danger"
                onClick={() => {
                  setConfirmDelete(false);
                  void deleteSshHost(host.id);
                }}
              >
                Delete
              </button>
            </>
          }
        >
          <div className="p-4 text-[13px]">
            Remove <b>{host.name}</b> ({target}) and its saved credentials from Tusk? Open terminals to it will close.
          </div>
        </Modal>
      )}
    </>
  );
}

function FtpNode({
  site,
  depth,
  openMenu,
  onDrop,
  onMove,
}: {
  site: FtpSite;
  depth: number;
  openMenu: NodeProps["openMenu"];
  onDrop: NodeProps["onDrop"];
  onMove: NodeProps["onMove"];
}) {
  const open = () => useApp.getState().openFilesTab({ kind: "ftp", id: site.id });
  const openTabs = useApp((s) => s.tabs.some((t) => t.kind === "files" && t.target?.kind === "ftp" && t.target.id === site.id));
  const isActive = useApp((s) => {
    const t = s.tabs.find((x) => x.id === s.activeTabId);
    return t?.kind === "files" && t.target?.kind === "ftp" && t.target.id === site.id;
  });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const target = `${site.protocol}://${site.user ? `${site.user}@` : ""}${site.host}${site.port === 21 ? "" : `:${site.port}`}`;
  return (
    <>
      <Row
        depth={depth}
        onPointerDown={(e) => startTreeDrag(e, { kind: "ftp", id: site.id, label: site.name }, onDrop)}
        active={isActive}
        icon={
          <span className="relative">
            <Server size={14} style={{ color: site.color ?? undefined }} />
            {openTabs && <span className="absolute -right-0.5 -bottom-0.5 h-1.5 w-1.5 rounded-full bg-ok ring-2 ring-panel" />}
          </span>
        }
        label={
          <>
            <span className="font-medium">{site.name}</span>
            <ClaudeMark id={site.id} folderId={site.folderId} />
          </>
        }
        right={<span className="font-mono">{site.protocol.toUpperCase()}</span>}
        title={`${target}\nClick to open the file manager`}
        onClick={() => !clickSuppressed() && open()}
        onContextMenu={(e) =>
          openMenu(e, [
            { label: "Open file manager", icon: <FolderSync size={13} />, onClick: open },
            "separator",
            { label: "Edit…", icon: <Pencil size={13} />, onClick: () => useApp.getState().openFtpDialog(site) },
            {
              label: "Duplicate",
              icon: <Copy size={13} />,
              onClick: () => useApp.getState().openFtpDialog({ ...site, id: "", name: `${site.name} copy` }),
            },
            { label: "Copy address", icon: <Copy size={13} />, onClick: () => void navigator.clipboard.writeText(target) },
            claudeEntry(site.id, site.name, site.folderId),
            {
              label: "Move to…",
              icon: <FolderInput size={13} />,
              onClick: () => onMove({ kind: "ftp", id: site.id, label: site.name }),
            },
            { label: "Delete…", icon: <Trash2 size={13} />, danger: true, onClick: () => setConfirmDelete(true) },
          ])
        }
      />
      {confirmDelete && (
        <Modal
          title="Delete FTP site"
          width={420}
          onClose={() => setConfirmDelete(false)}
          footer={
            <>
              <button className="btn-outline" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
              <button
                className="btn-danger"
                onClick={() => {
                  setConfirmDelete(false);
                  void useApp.getState().deleteFtpSite(site.id);
                }}
              >
                Delete
              </button>
            </>
          }
        >
          <div className="p-4 text-[13px]">
            Remove <b>{site.name}</b> ({target}) and its saved password from Tusk? Files tabs open on it will close.
          </div>
        </Modal>
      )}
    </>
  );
}

function RdpNode({
  conn,
  depth,
  openMenu,
  onDrop,
  onMove,
}: {
  conn: RdpConfig;
  depth: number;
  openMenu: NodeProps["openMenu"];
  onDrop: NodeProps["onDrop"];
  onMove: NodeProps["onMove"];
}) {
  const open = () => useApp.getState().openRdpTab(conn.id);
  const isOpen = useApp((s) => s.tabs.some((t) => t.kind === "rdp" && t.connId === conn.id));
  const isActive = useApp((s) => {
    const t = s.tabs.find((x) => x.id === s.activeTabId);
    return t?.kind === "rdp" && t.connId === conn.id;
  });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const target = `${conn.domain ? `${conn.domain}\\` : ""}${conn.user ? `${conn.user}@` : ""}${conn.host}${conn.port === 3389 ? "" : `:${conn.port}`}`;
  return (
    <>
      <Row
        depth={depth}
        onPointerDown={(e) => startTreeDrag(e, { kind: "rdp", id: conn.id, label: conn.name }, onDrop)}
        active={isActive}
        icon={
          <span className="relative">
            <ScreenShare size={14} style={{ color: conn.color ?? undefined }} />
            {isOpen && <span className="absolute -right-0.5 -bottom-0.5 h-1.5 w-1.5 rounded-full bg-ok ring-2 ring-panel" />}
          </span>
        }
        label={<span className="font-medium">{conn.name}</span>}
        right={<span className="font-mono">RDP</span>}
        title={`${target}\nClick to connect`}
        onClick={() => !clickSuppressed() && open()}
        onContextMenu={(e) =>
          openMenu(e, [
            { label: "Connect", icon: <ScreenShare size={13} />, onClick: open },
            "separator",
            { label: "Edit…", icon: <Pencil size={13} />, onClick: () => useApp.getState().openRdpDialog(conn) },
            {
              label: "Duplicate",
              icon: <Copy size={13} />,
              onClick: () => useApp.getState().openRdpDialog({ ...conn, id: "", name: `${conn.name} copy` }),
            },
            { label: "Copy address", icon: <Copy size={13} />, onClick: () => void navigator.clipboard.writeText(`${conn.host}:${conn.port}`) },
            {
              label: "Move to…",
              icon: <FolderInput size={13} />,
              onClick: () => onMove({ kind: "rdp", id: conn.id, label: conn.name }),
            },
            { label: "Delete…", icon: <Trash2 size={13} />, danger: true, onClick: () => setConfirmDelete(true) },
          ])
        }
      />
      {confirmDelete && (
        <Modal
          title="Delete remote desktop"
          width={420}
          onClose={() => setConfirmDelete(false)}
          footer={
            <>
              <button className="btn-outline" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
              <button
                className="btn-danger"
                onClick={() => {
                  setConfirmDelete(false);
                  void useApp.getState().deleteRdp(conn.id);
                }}
              >
                Delete
              </button>
            </>
          }
        >
          <div className="p-4 text-[13px]">
            Remove <b>{conn.name}</b> ({target}) and its saved password from Tusk? An open session to it will close.
          </div>
        </Modal>
      )}
    </>
  );
}

interface NodeProps {
  /** Indent level of the connection row; its databases, schemas and tables nest below. */
  base: number;
  expanded: Set<string>;
  toggle: (key: string, force?: boolean) => void;
  openMenu: (at: { clientX: number; clientY: number }, items: MenuEntry[]) => void;
  filter: string;
  onDrop: (item: DragItem, folderId: string | null) => void;
  onMove: (item: { kind: ItemKind; id: string; label: string }) => void;
}

function Row(props: {
  depth: number;
  icon: ReactNode;
  label: ReactNode;
  right?: ReactNode;
  expandable?: boolean;
  open?: boolean;
  active?: boolean;
  onClick?: () => void;
  onDoubleClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onPointerDown?: (e: React.PointerEvent) => void;
  title?: string;
  actions?: ReactNode;
}) {
  return (
    <div
      className={`group flex h-[26px] cursor-default items-center gap-1 rounded-md pr-1.5 text-[12.5px] ${
        props.active ? "bg-accent-soft text-text" : "text-text/90 hover:bg-hover"
      }`}
      style={{ paddingLeft: 4 + props.depth * 14 }}
      onClick={props.onClick}
      onDoubleClick={props.onDoubleClick}
      onPointerDown={props.onPointerDown}
      onContextMenu={(e) => {
        if (!props.onContextMenu) return;
        e.preventDefault();
        props.onContextMenu(e);
      }}
      title={props.title}
    >
      <span className="flex w-3.5 shrink-0 justify-center text-faint">
        {props.expandable && (
          <ChevronRight size={12} className={`transition-transform ${props.open ? "rotate-90" : ""}`} />
        )}
      </span>
      <span className="flex shrink-0 items-center text-muted">{props.icon}</span>
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      {props.actions && <span className="hidden shrink-0 items-center group-hover:flex">{props.actions}</span>}
      {props.right && <span className="shrink-0 text-[11px] text-faint group-hover:hidden">{props.right}</span>}
    </div>
  );
}

function ConnectionNode({ conn, ...p }: NodeProps & { conn: ConnectionConfig }) {
  const status = useApp((s) => s.status[conn.id]);
  const databases = useApp((s) => s.databases[conn.id]);
  const connect = useApp((s) => s.connect);
  const disconnect = useApp((s) => s.disconnect);
  const deleteConnection = useApp((s) => s.deleteConnection);
  const openConnectionDialog = useApp((s) => s.openConnectionDialog);
  const openQueryTab = useApp((s) => s.openQueryTab);
  const refresh = useApp((s) => s.refresh);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const via = useApp((s) => (conn.sshHostId ? s.sshHosts.find((h) => h.id === conn.sshHostId) : undefined));
  const key = conn.id;
  const open = p.expanded.has(key) && status?.state === "connected";

  // Expand the connection and its default database whenever it connects,
  // however the connect was triggered (tree, dialog, palette, a tab).
  const wasConnected = useRef(false);
  useEffect(() => {
    const connected = status?.state === "connected";
    if (connected && !wasConnected.current) {
      p.toggle(key, true);
      p.toggle(`${key}/${conn.database}`, true);
    }
    wasConnected.current = connected;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.state]);

  const activate = async () => {
    if (status?.state === "connected") return p.toggle(key);
    if (status?.state === "connecting") return;
    await connect(conn.id);
  };

  const items: MenuEntry[] = [
    status?.state === "connected"
      ? { label: "Disconnect", icon: <PlugZap size={13} />, onClick: () => void disconnect(conn.id) }
      : { label: "Connect", icon: <Plug size={13} />, onClick: () => void activate() },
    { label: "New query", icon: <SquareTerminal size={13} />, hint: "Ctrl+T", onClick: () => openQueryTab(conn.id, conn.database) },
    {
      label: "Activity & sessions",
      icon: <Activity size={13} />,
      onClick: () => useApp.getState().openActivityTab(conn.id, conn.database),
    },
    {
      label: "Refresh",
      icon: <RefreshCw size={13} />,
      disabled: status?.state !== "connected",
      onClick: () => void refresh(conn.id, conn.database),
    },
    "separator",
    { label: "Edit connection…", icon: <Pencil size={13} />, onClick: () => openConnectionDialog(conn) },
    {
      label: "Duplicate",
      icon: <Copy size={13} />,
      onClick: () => openConnectionDialog({ ...conn, id: "", name: `${conn.name} copy` }),
    },
    claudeEntry(conn.id, conn.name, conn.folderId),
    {
      label: "Move to…",
      icon: <FolderInput size={13} />,
      onClick: () => p.onMove({ kind: "connection", id: conn.id, label: conn.name }),
    },
    { label: "Delete…", icon: <Trash2 size={13} />, danger: true, onClick: () => setConfirmDelete(true) },
  ];

  return (
    <div className="mt-0.5">
      <Row
        depth={p.base}
        onPointerDown={(e) => startTreeDrag(e, { kind: "connection", id: conn.id, label: conn.name }, p.onDrop)}
        expandable
        open={open}
        icon={
          <span className="relative">
            <Database size={14} style={{ color: conn.color ?? undefined }} />
            {status?.state === "connected" && (
              <span className="absolute -right-0.5 -bottom-0.5 h-1.5 w-1.5 rounded-full bg-ok ring-2 ring-panel" />
            )}
          </span>
        }
        label={
          <>
            <span className="font-medium">{conn.name}</span>
            <ClaudeMark id={conn.id} folderId={conn.folderId} />
          </>
        }
        right={
          status?.state === "connecting" ? (
            <Spinner size={11} />
          ) : status?.state === "error" ? (
            <span className="text-danger" title={status.error}>
              error
            </span>
          ) : undefined
        }
        title={`${conn.user}@${conn.host}:${conn.port}/${conn.database}${via ? `\nThrough SSH host ${via.name}` : ""}`}
        onClick={() => !clickSuppressed() && void activate()}
        onContextMenu={(e) => p.openMenu(e, items)}
        actions={
          <button
            className="rounded p-0.5 text-muted hover:bg-panel hover:text-text"
            title="New query"
            onClick={(e) => {
              e.stopPropagation();
              openQueryTab(conn.id, conn.database);
            }}
          >
            <SquareTerminal size={13} />
          </button>
        }
      />
      {open &&
        (databases ?? []).map((db) => <DatabaseNode key={db} conn={conn} database={db} {...p} />)}
      {confirmDelete && (
        <Modal
          title="Delete connection"
          width={420}
          onClose={() => setConfirmDelete(false)}
          footer={
            <>
              <button className="btn-outline" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
              <button
                className="btn-danger"
                onClick={() => {
                  setConfirmDelete(false);
                  void deleteConnection(conn.id);
                }}
              >
                Delete
              </button>
            </>
          }
        >
          <div className="p-4 text-[13px]">
            Remove <b>{conn.name}</b> and its saved password from Tusk? The database itself is not touched.
          </div>
        </Modal>
      )}
    </div>
  );
}

function DatabaseNode({ conn, database, ...p }: NodeProps & { conn: ConnectionConfig; database: string }) {
  const cache = useApp((s) => s.cache[cacheKey(conn.id, database)]);
  const loadSchemas = useApp((s) => s.loadSchemas);
  const openQueryTab = useApp((s) => s.openQueryTab);
  const refresh = useApp((s) => s.refresh);
  const showToast = useApp((s) => s.showToast);
  const [loading, setLoading] = useState(false);
  const key = `${conn.id}/${database}`;
  const open = p.expanded.has(key);

  const expand = async () => {
    p.toggle(key);
    if (!open && !cache?.schemas) {
      setLoading(true);
      try {
        await loadSchemas(conn.id, database);
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e), "error");
        p.toggle(key, false);
      } finally {
        setLoading(false);
      }
    }
  };

  const isDefault = database === conn.database;
  return (
    <>
      <Row
        depth={p.base + 1}
        expandable
        open={open}
        icon={<Layers size={13} className={isDefault ? "text-accent" : ""} />}
        label={database}
        right={loading ? <Spinner size={10} /> : undefined}
        onClick={() => void expand()}
        onContextMenu={(e) =>
          p.openMenu(e, [
            { label: "New query", icon: <SquareTerminal size={13} />, onClick: () => openQueryTab(conn.id, database) },
            {
              label: "Activity & sessions",
              icon: <Activity size={13} />,
              onClick: () => useApp.getState().openActivityTab(conn.id, database),
            },
            { label: "Refresh", icon: <RefreshCw size={13} />, onClick: () => void refresh(conn.id, database) },
          ])
        }
      />
      {open &&
        (cache?.schemas ?? []).map((schema) => (
          <SchemaNode key={schema} conn={conn} database={database} schema={schema} {...p} />
        ))}
    </>
  );
}

function SchemaNode({
  conn,
  database,
  schema,
  ...p
}: NodeProps & { conn: ConnectionConfig; database: string; schema: string }) {
  const contents = useApp((s) => s.cache[cacheKey(conn.id, database)]?.contents[schema]);
  const loadSchema = useApp((s) => s.loadSchema);
  const openQueryTab = useApp((s) => s.openQueryTab);
  const showToast = useApp((s) => s.showToast);
  const [loading, setLoading] = useState(false);
  const key = `${conn.id}/${database}/${schema}`;
  // public is open by default; everything else starts collapsed.
  const open = p.expanded.has(key) !== (schema === "public") || (!!p.filter && !!contents);

  const groups = useMemo(() => {
    if (!contents) return [];
    const match = (n: string) => !p.filter || n.toLowerCase().includes(p.filter);
    const objs = contents.objects.filter((o) => match(o.name));
    return [
      { id: "tables", label: "Tables", items: objs.filter((o) => o.kind === "r" || o.kind === "p" || o.kind === "f") },
      { id: "views", label: "Views", items: objs.filter((o) => o.kind === "v") },
      { id: "mviews", label: "Materialized views", items: objs.filter((o) => o.kind === "m") },
      { id: "functions", label: "Functions", items: contents.functions.filter((f) => match(f.name)) },
    ].filter((g) => g.items.length > 0);
  }, [contents, p.filter]);

  if (p.filter && contents && groups.length === 0) return null;

  const expand = async () => {
    p.toggle(key);
    if (!contents) {
      setLoading(true);
      try {
        await loadSchema(conn.id, database, schema);
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e), "error");
      } finally {
        setLoading(false);
      }
    }
  };

  return (
    <>
      <Row
        depth={p.base + 2}
        expandable
        open={open}
        icon={<FolderTree size={13} />}
        label={schema}
        right={loading ? <Spinner size={10} /> : contents ? contents.objects.length || undefined : undefined}
        onClick={() => void expand()}
        onContextMenu={(e) =>
          p.openMenu(e, [
            {
              label: "New query",
              icon: <SquareTerminal size={13} />,
              onClick: () => openQueryTab(conn.id, database, `SET search_path TO ${schema};\n\n`),
            },
            { label: "Refresh", icon: <RefreshCw size={13} />, onClick: () => void loadSchema(conn.id, database, schema, true) },
          ])
        }
      />
      {open &&
        groups.map((g) => (
          <GroupNode key={g.id} id={g.id} label={g.label} conn={conn} database={database} schema={schema} items={g.items} {...p} />
        ))}
    </>
  );
}

function GroupNode(
  props: NodeProps & {
    id: string;
    label: string;
    conn: ConnectionConfig;
    database: string;
    schema: string;
    items: (meta.DbObject | meta.DbFunction)[];
  },
) {
  const { conn, database, schema, items, ...p } = props;
  const key = `${conn.id}/${database}/${schema}/#${props.id}`;
  // Tables start open; other groups start closed. Filtering opens everything.
  const open = p.expanded.has(key) !== (props.id === "tables") || !!p.filter;
  return (
    <>
      <Row
        depth={p.base + 3}
        expandable
        open={open}
        icon={null}
        label={<span className="text-[11.5px] font-semibold tracking-wide text-muted uppercase">{props.label}</span>}
        right={items.length}
        onClick={() => p.toggle(key)}
      />
      {open &&
        items.map((item) =>
          "oid" in item ? (
            <FunctionLeaf key={item.oid} conn={conn} database={database} fn={item} openMenu={p.openMenu} depth={p.base + 4} />
          ) : (
            <ObjectLeaf key={item.name} conn={conn} database={database} obj={item} openMenu={p.openMenu} depth={p.base + 4} />
          ),
        )}
    </>
  );
}

function ObjectLeaf(props: {
  conn: ConnectionConfig;
  database: string;
  obj: meta.DbObject;
  openMenu: NodeProps["openMenu"];
  depth: number;
}) {
  const { conn, database, obj } = props;
  const openTableTab = useApp((s) => s.openTableTab);
  const openQueryTab = useApp((s) => s.openQueryTab);
  const isActive = useApp((s) => {
    const t = s.tabs.find((x) => x.id === s.activeTabId);
    return t?.kind === "table" && t.connId === conn.id && t.database === database && t.schema === obj.schema && t.name === obj.name;
  });
  const name = qualified(obj.schema, obj.name);
  const icon =
    obj.kind === "v" ? <Eye size={13} /> : obj.kind === "m" ? <Eye size={13} className="text-accent" /> : <Table2 size={13} />;
  return (
    <Row
      depth={props.depth}
      icon={icon}
      label={obj.name}
      active={isActive}
      right={obj.kind !== "v" && obj.estimate > 0 ? compact(obj.estimate) : undefined}
      title={`${meta.KIND_LABEL[obj.kind]} ${name}${obj.comment ? `\n${obj.comment}` : ""}`}
      onClick={() => openTableTab(conn.id, database, obj.schema, obj.name, obj.kind)}
      onContextMenu={(e) =>
        props.openMenu(e, [
          {
            label: "Open data",
            icon: <Table2 size={13} />,
            onClick: () => openTableTab(conn.id, database, obj.schema, obj.name, obj.kind),
          },
          {
            label: "New query: SELECT",
            icon: <SquareTerminal size={13} />,
            onClick: () => openQueryTab(conn.id, database, `SELECT *\nFROM ${name}\nLIMIT 100;\n`),
          },
          "separator",
          { label: "Copy name", icon: <Copy size={13} />, onClick: () => void navigator.clipboard.writeText(name) },
        ])
      }
    />
  );
}

function FunctionLeaf(props: {
  conn: ConnectionConfig;
  database: string;
  fn: meta.DbFunction;
  openMenu: NodeProps["openMenu"];
  depth: number;
}) {
  const { conn, database, fn } = props;
  const openQueryTab = useApp((s) => s.openQueryTab);
  const showToast = useApp((s) => s.showToast);
  const openDef = async () => {
    try {
      const def = await meta.functionDefinition(metaSession(conn.id, database), fn.oid);
      openQueryTab(conn.id, database, def, `${fn.name}()`);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), "error");
    }
  };
  return (
    <Row
      depth={props.depth}
      icon={<FileCode2 size={13} />}
      label={
        <>
          {fn.name}
          <span className="text-faint">({fn.args})</span>
        </>
      }
      title={`${fn.kind === "p" ? "procedure" : "function"} ${fn.schema}.${fn.name}(${fn.args})${fn.result ? ` → ${fn.result}` : ""}`}
      onClick={() => void openDef()}
      onContextMenu={(e) =>
        props.openMenu(e, [{ label: "Open definition", icon: <FileCode2 size={13} />, onClick: () => void openDef() }])
      }
    />
  );
}
