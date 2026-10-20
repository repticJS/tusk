import {
  ChevronRight,
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
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ConnectionConfig, SshHost } from "../lib/api";
import * as meta from "../lib/meta";
import { qualified } from "../lib/sql";
import { cacheKey, metaSession, useApp } from "../store";
import { Modal, Spinner, useMenu, type MenuEntry } from "./ui";

function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`;
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`;
  return `${(n / 1e9).toFixed(1)}B`;
}

export function Sidebar() {
  const connections = useApp((s) => s.connections);
  const sshHosts = useApp((s) => s.sshHosts);
  const openConnectionDialog = useApp((s) => s.openConnectionDialog);
  const openSshDialog = useApp((s) => s.openSshDialog);
  const [filter, setFilter] = useState("");
  const q = filter.trim().toLowerCase();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [menu, openMenu] = useMenu();

  const toggle = (key: string, force?: boolean) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      const on = force ?? !next.has(key);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  return (
    <div className="flex h-full flex-col bg-panel">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <img src="/icon.svg" alt="" className="h-5 w-5" />
        <span className="text-[13.5px] font-semibold tracking-tight">Tusk</span>
        <div className="flex-1" />
        <button className="btn-ghost h-7 px-1.5" title="New connection" onClick={() => openConnectionDialog()}>
          <Plus size={15} />
        </button>
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
      <div className="min-h-0 flex-1 overflow-auto px-1.5 pb-3">
        {connections.length === 0 && sshHosts.length === 0 && (
          <div className="px-3 py-8 text-center text-[12.5px] text-faint">
            No connections yet.
            <br />
            <button className="mt-3 btn-outline" onClick={() => openConnectionDialog()}>
              <Plus size={13} /> Add connection
            </button>
          </div>
        )}
        {(sshHosts.length > 0 || connections.length > 0) && (
          <>
            <SectionHeader
              label="SSH"
              count={sshHosts.length}
              open={!expanded.has("#ssh-closed")}
              onToggle={() => toggle("#ssh-closed")}
              onAdd={() => openSshDialog()}
            />
            {!expanded.has("#ssh-closed") &&
              sshHosts
                .filter((h) => !q || h.name.toLowerCase().includes(q) || h.host.toLowerCase().includes(q))
                .map((h) => <SshNode key={h.id} host={h} openMenu={openMenu} />)}
            <SectionHeader
              label="PostgreSQL"
              count={connections.length}
              open={!expanded.has("#pg-closed")}
              onToggle={() => toggle("#pg-closed")}
              onAdd={() => openConnectionDialog()}
            />
            {!expanded.has("#pg-closed") &&
              connections.map((c) => (
                <ConnectionNode key={c.id} conn={c} filter={q} expanded={expanded} toggle={toggle} openMenu={openMenu} />
              ))}
          </>
        )}
      </div>
      {menu}
    </div>
  );
}

function SectionHeader(props: { label: string; count: number; open: boolean; onToggle: () => void; onAdd: () => void }) {
  return (
    <div
      className="group mt-2 flex h-7 cursor-default items-center gap-1 px-1 text-[11px] font-semibold tracking-wider text-faint uppercase first:mt-0 hover:text-muted"
      onClick={props.onToggle}
    >
      <ChevronRight size={11} className={`transition-transform ${props.open ? "rotate-90" : ""}`} />
      <span className="flex-1">{props.label}</span>
      <span className="font-normal group-hover:hidden">{props.count || ""}</span>
      <button
        className="hidden rounded p-0.5 text-muted group-hover:block hover:bg-hover hover:text-text"
        title={`New ${props.label} connection`}
        onClick={(e) => {
          e.stopPropagation();
          props.onAdd();
        }}
      >
        <Plus size={13} />
      </button>
    </div>
  );
}

function SshNode({ host, openMenu }: { host: SshHost; openMenu: NodeProps["openMenu"] }) {
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
  return (
    <>
      <Row
        depth={0}
        active={isActive}
        icon={
          <span className="relative">
            <TerminalSquare size={14} style={{ color: host.color ?? undefined }} />
            {openTabs > 0 && (
              <span className="absolute -right-0.5 -bottom-0.5 h-1.5 w-1.5 rounded-full bg-ok ring-2 ring-panel" />
            )}
          </span>
        }
        label={<span className="font-medium">{host.name}</span>}
        right={<span className="font-mono">{host.host}</span>}
        title={`${target}\nClick to open a terminal`}
        onClick={() => openTerminalTab(host.id)}
        onContextMenu={(e) =>
          openMenu(e, [
            { label: "Open terminal", icon: <TerminalSquare size={13} />, onClick: () => openTerminalTab(host.id) },
            "separator",
            { label: "Edit…", icon: <Pencil size={13} />, onClick: () => openSshDialog(host) },
            {
              label: "Duplicate",
              icon: <Copy size={13} />,
              onClick: () => openSshDialog({ ...host, id: "", name: `${host.name} copy` }),
            },
            { label: "Copy ssh command", icon: <Copy size={13} />, onClick: () => void navigator.clipboard.writeText(`ssh ${host.port === 22 ? "" : `-p ${host.port} `}${host.user}@${host.host}`) },
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

interface NodeProps {
  expanded: Set<string>;
  toggle: (key: string, force?: boolean) => void;
  openMenu: (at: { clientX: number; clientY: number }, items: MenuEntry[]) => void;
  filter: string;
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
    { label: "Delete…", icon: <Trash2 size={13} />, danger: true, onClick: () => setConfirmDelete(true) },
  ];

  return (
    <div className="mt-0.5">
      <Row
        depth={0}
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
        label={<span className="font-medium">{conn.name}</span>}
        right={
          status?.state === "connecting" ? (
            <Spinner size={11} />
          ) : status?.state === "error" ? (
            <span className="text-danger" title={status.error}>
              error
            </span>
          ) : undefined
        }
        title={`${conn.user}@${conn.host}:${conn.port}/${conn.database}`}
        onClick={() => void activate()}
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
        depth={1}
        expandable
        open={open}
        icon={<Layers size={13} className={isDefault ? "text-accent" : ""} />}
        label={database}
        right={loading ? <Spinner size={10} /> : undefined}
        onClick={() => void expand()}
        onContextMenu={(e) =>
          p.openMenu(e, [
            { label: "New query", icon: <SquareTerminal size={13} />, onClick: () => openQueryTab(conn.id, database) },
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
        depth={2}
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
        depth={3}
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
            <FunctionLeaf key={item.oid} conn={conn} database={database} fn={item} openMenu={p.openMenu} />
          ) : (
            <ObjectLeaf key={item.name} conn={conn} database={database} obj={item} openMenu={p.openMenu} />
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
      depth={4}
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
      depth={4}
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
