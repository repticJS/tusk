import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  ArrowRightLeft,
  Copy,
  Database,
  Globe,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Square,
  Trash2,
  Waypoints,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { SshHost, TunnelConfig, TunnelKind, TunnelStatus } from "../lib/api";
import { blankTunnel } from "../lib/defaults";
import { useApp, type TunnelsTab as TunnelsTabModel } from "../store";
import { Field, Modal, Spinner, useMenu } from "./ui";

const KINDS: { kind: TunnelKind; label: string; short: string; explain: string }[] = [
  {
    kind: "local",
    label: "Local",
    short: "Local",
    explain: "Reach a service on the server's side (a database, an admin page) from a port on this PC.",
  },
  {
    kind: "remote",
    label: "Remote",
    short: "Remote",
    explain: "Open a port on the server that leads back to a service on this PC or your network.",
  },
  {
    kind: "dynamic",
    label: "Dynamic (SOCKS)",
    short: "SOCKS",
    explain: "A SOCKS proxy on this PC: point a browser or app at it to browse from the server's network.",
  },
];

const LOOPBACK = "127.0.0.1";
const ALL = "0.0.0.0";

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** Where a client connects for a local or dynamic tunnel. */
const localAddress = (t: TunnelConfig, port: number) => `${t.bindHost === ALL ? "localhost" : t.bindHost || "localhost"}:${port}`;

/** One-line description of the route a tunnel sets up. */
function route(t: TunnelConfig, host: SshHost | undefined, port?: number) {
  const via = host?.name ?? "missing host";
  const listen = port || t.bindPort || "auto";
  if (t.kind === "local") return `localhost:${listen} → ${t.targetHost}:${t.targetPort}, via ${via}`;
  if (t.kind === "remote") return `${via} port ${listen} → ${t.targetHost}:${t.targetPort} on this PC`;
  return `SOCKS proxy on localhost:${listen}, via ${via}`;
}

function Counters({ st }: { st: TunnelStatus }) {
  return (
    <span className="text-[11.5px] text-faint tabular-nums">
      {st.active} open · {st.total} total · ↑ {fmtBytes(st.bytesUp)} ↓ {fmtBytes(st.bytesDown)}
    </span>
  );
}

export function TunnelsTab({ active }: { tab: TunnelsTabModel; active: boolean }) {
  const tunnels = useApp((s) => s.tunnels);
  const hosts = useApp((s) => s.sshHosts);
  const connections = useApp((s) => s.connections);
  const status = useApp((s) => s.tunnelStatus);
  const openTunnelDialog = useApp((s) => s.openTunnelDialog);

  // Counters change constantly; poll only while the tab is visible.
  useEffect(() => {
    if (!active) return;
    const refresh = () => void useApp.getState().refreshTunnelStatus().catch(() => {});
    refresh();
    const t = setInterval(refresh, 1000);
    return () => clearInterval(t);
  }, [active]);

  const viaSsh = connections.filter((c) => c.sshHostId);

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto flex max-w-[900px] flex-col gap-5 p-6">
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <div className="text-[17px] font-semibold tracking-tight">SSH tunnels</div>
            <div className="text-[12.5px] text-muted">
              Forward ports through your saved SSH hosts. Tunnels keep running while you work in other tabs.
            </div>
          </div>
          <button className="btn-primary" onClick={() => openTunnelDialog(blankTunnel(hosts[0]?.id))} disabled={!hosts.length}>
            <Plus size={14} /> New tunnel
          </button>
        </div>

        {!hosts.length && (
          <div className="rounded-lg border border-dashed border-border p-5 text-[13px] text-muted">
            Tunnels go through a saved SSH host. Add one first with the + button in the sidebar.
          </div>
        )}

        {hosts.length > 0 && tunnels.length === 0 && (
          <div className="grid gap-3 sm:grid-cols-3">
            {KINDS.map((k) => (
              <button
                key={k.kind}
                className="flex flex-col gap-1.5 rounded-lg border border-border bg-panel p-4 text-left hover:border-accent"
                onClick={() => openTunnelDialog({ ...blankTunnel(hosts[0].id), kind: k.kind })}
              >
                <span className="flex items-center gap-2 text-[13px] font-medium">
                  <KindIcon kind={k.kind} /> {k.label}
                </span>
                <span className="text-[12px] text-muted">{k.explain}</span>
              </button>
            ))}
          </div>
        )}

        {tunnels.length > 0 && (
          <div className="overflow-hidden rounded-lg border border-border bg-panel">
            {tunnels.map((t) => (
              <TunnelRow key={t.id} t={t} host={hosts.find((h) => h.id === t.hostId)} st={status[t.id]} />
            ))}
          </div>
        )}

        {viaSsh.length > 0 && (
          <div className="flex flex-col gap-2">
            <div className="text-[11.5px] font-semibold tracking-wide text-faint uppercase">
              Database connections through SSH
            </div>
            <div className="overflow-hidden rounded-lg border border-border bg-panel">
              {viaSsh.map((c) => {
                const st = status[`db:${c.id}`];
                const host = hosts.find((h) => h.id === c.sshHostId);
                return (
                  <div key={c.id} className="flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-0">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${st ? "bg-ok" : "bg-faint/50"}`} />
                    <Database size={14} style={{ color: c.color ?? undefined }} className="shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium">{c.name}</div>
                      <div className="truncate text-[12px] text-muted">
                        {c.host}:{c.port}, via {host?.name ?? "missing host"}
                        {st ? ` (local port ${st.port})` : ""}
                      </div>
                    </div>
                    {st ? <Counters st={st} /> : <span className="text-[11.5px] text-faint">Opens when you connect</span>}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function KindIcon({ kind }: { kind: TunnelKind }) {
  if (kind === "dynamic") return <Globe size={14} className="text-accent" />;
  if (kind === "remote") return <ArrowRightLeft size={14} className="text-warn" />;
  return <Waypoints size={14} className="text-ok" />;
}

function TunnelRow({ t, host, st }: { t: TunnelConfig; host: SshHost | undefined; st: TunnelStatus | undefined }) {
  const busy = useApp((s) => !!s.tunnelBusy[t.id]);
  const startError = useApp((s) => s.tunnelErrors[t.id]);
  const { startTunnel, stopTunnel, openTunnelDialog, showToast } = useApp.getState();
  const [menu, openMenu] = useMenu();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const running = !!st;
  const kind = KINDS.find((k) => k.kind === t.kind)!;

  const copyAddress = async () => {
    await writeText(localAddress(t, st?.port || t.bindPort));
    showToast(`Copied ${localAddress(t, st?.port || t.bindPort)}`, "ok");
  };

  return (
    <div
      className="flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-0"
      data-tunnel-row={t.name}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e, items());
      }}
    >
      <button
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md border ${
          running ? "border-ok/50 bg-ok-soft text-ok" : "border-border text-muted hover:text-text"
        }`}
        title={running ? "Stop" : "Start"}
        aria-label={running ? `Stop ${t.name}` : `Start ${t.name}`}
        disabled={busy}
        onClick={() => void (running ? stopTunnel(t.id) : startTunnel(t.id))}
      >
        {busy ? <Spinner size={11} /> : running ? <Square size={11} fill="currentColor" /> : <Play size={12} fill="currentColor" />}
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium">{t.name}</span>
          <span className="flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-px text-[10.5px] text-muted">
            <KindIcon kind={t.kind} /> {kind.short}
          </span>
          {t.autoStart && <span className="shrink-0 text-[10.5px] text-faint">auto-start</span>}
        </div>
        <div className="truncate font-mono text-[11.5px] text-muted">{route(t, host, st?.port)}</div>
        {(startError || st?.error) && (
          <div className="selectable truncate text-[11.5px] text-danger" title={startError || st?.error || ""}>
            {startError || st?.error}
          </div>
        )}
      </div>
      {st && <Counters st={st} />}
      <button className="btn-ghost h-7 w-7 justify-center px-0" aria-label="Tunnel actions" onClick={(e) => openMenu(e, items())}>
        <MoreHorizontal size={15} />
      </button>
      {menu}
      {confirmDelete && (
        <Modal
          title="Delete tunnel"
          width={400}
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
                  void useApp.getState().deleteTunnel(t.id);
                }}
              >
                Delete
              </button>
            </>
          }
        >
          <div className="p-4 text-[13px]">
            Delete <b>{t.name}</b>?{running ? " It will be stopped." : ""}
          </div>
        </Modal>
      )}
    </div>
  );

  function items() {
    return [
      running
        ? { label: "Stop", icon: <Square size={12} />, onClick: () => void stopTunnel(t.id) }
        : { label: "Start", icon: <Play size={12} />, onClick: () => void startTunnel(t.id) },
      ...(t.kind !== "remote"
        ? [{ label: "Copy address", icon: <Copy size={13} />, onClick: () => void copyAddress() }]
        : []),
      "separator" as const,
      { label: "Edit…", icon: <Pencil size={13} />, onClick: () => openTunnelDialog(t) },
      {
        label: "Duplicate",
        icon: <Copy size={13} />,
        onClick: () => openTunnelDialog({ ...t, id: "", name: `${t.name} copy`, autoStart: false }),
      },
      { label: "Delete…", icon: <Trash2 size={13} />, danger: true, onClick: () => setConfirmDelete(true) },
    ];
  }
}

const portValue = (v: string) => Math.min(65535, Number(v.replace(/\D/g, "")) || 0);

export function TunnelDialog() {
  const { editing } = useApp((s) => s.tunnelDialog);
  const close = useApp((s) => s.closeTunnelDialog);
  const hosts = useApp((s) => s.sshHosts);
  const saveTunnel = useApp((s) => s.saveTunnel);
  const [t, setT] = useState<TunnelConfig>(() => ({ ...blankTunnel(hosts[0]?.id), ...editing }));
  const [saving, setSaving] = useState(false);
  const isNew = !editing?.id;
  const set = <K extends keyof TunnelConfig>(k: K, v: TunnelConfig[K]) => setT((x) => ({ ...x, [k]: v }));
  const host = hosts.find((h) => h.id === t.hostId);

  const setKind = (kind: TunnelKind) =>
    setT((x) => ({
      ...x,
      kind,
      // Remote ports listen on the server's loopback unless asked otherwise.
      bindHost: kind === "remote" ? (x.bindHost === ALL ? ALL : "") : x.bindHost === ALL ? ALL : LOOPBACK,
    }));

  const defaultName = () => {
    if (t.kind === "dynamic") return `SOCKS ${t.bindPort || ""}`.trim();
    if (t.kind === "remote") return `${host?.name ?? "server"}:${t.bindPort} → ${t.targetPort}`;
    return `${t.targetHost}:${t.targetPort}`;
  };

  const valid = !!host && t.bindPort > 0 && (t.kind === "dynamic" || (!!t.targetHost.trim() && t.targetPort > 0));

  const save = async (start: boolean) => {
    setSaving(true);
    const out: TunnelConfig = { ...t, id: t.id || crypto.randomUUID(), name: t.name.trim() || defaultName() };
    const ok = await saveTunnel(out);
    setSaving(false);
    if (!ok) return;
    close();
    const s = useApp.getState();
    s.openTunnelsTab();
    if (start && !s.tunnelStatus[out.id]) void s.startTunnel(out.id);
  };

  const explain = KINDS.find((k) => k.kind === t.kind)!.explain;
  const shareLabel = t.kind === "remote" ? "Listen on all of the server's addresses" : "Allow other computers to connect";
  const shareHint =
    t.kind === "remote"
      ? "Needs GatewayPorts enabled on the server. Otherwise only the server itself can use the port."
      : "Others on your network can then use this tunnel through your PC.";

  return (
    <Modal
      title={isNew ? "New tunnel" : `Edit ${editing?.name}`}
      onClose={close}
      width={540}
      footer={
        <>
          <button className="btn-outline" onClick={close}>
            Cancel
          </button>
          <button className="btn-outline" onClick={() => void save(false)} disabled={saving || !valid}>
            Save
          </button>
          <button className="btn-primary" onClick={() => void save(true)} disabled={saving || !valid}>
            {saving && <Spinner size={12} />} Save & start
          </button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3.5 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) void save(true);
        }}
      >
        <div className="flex flex-col gap-1.5">
          <div className="flex rounded-md border border-border p-0.5">
            {KINDS.map((k) => (
              <button
                type="button"
                key={k.kind}
                onClick={() => setKind(k.kind)}
                className={`flex h-7 flex-1 items-center justify-center gap-1.5 rounded px-3 text-[12.5px] ${
                  t.kind === k.kind ? "bg-hover font-medium text-text" : "text-muted hover:text-text"
                }`}
              >
                {k.label}
              </button>
            ))}
          </div>
          <div className="text-[12px] text-muted">{explain}</div>
        </div>
        <div className="flex gap-3">
          <Field label="Name" className="flex-1">
            <input className="field" value={t.name} placeholder={defaultName()} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <Field label="Through SSH host" className="flex-1">
            <select className="field" value={t.hostId} onChange={(e) => set("hostId", e.target.value)}>
              {!host && <option value="">Choose a host…</option>}
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="flex items-end gap-3">
          <Field
            label={t.kind === "remote" ? "Port to open on the server" : "Port on this PC"}
            className="w-44"
          >
            <input
              className="field"
              inputMode="numeric"
              aria-label="Listen port"
              value={t.bindPort || ""}
              placeholder={t.kind === "dynamic" ? "1080" : "8080"}
              onChange={(e) => set("bindPort", portValue(e.target.value))}
            />
          </Field>
          {t.kind !== "dynamic" && (
            <>
              <Field label={t.kind === "remote" ? "Goes to (from this PC)" : "Goes to (from the server)"} className="flex-1">
                <input
                  className="field"
                  aria-label="Destination host"
                  value={t.targetHost}
                  spellCheck={false}
                  placeholder="localhost"
                  onChange={(e) => set("targetHost", e.target.value)}
                />
              </Field>
              <Field label="Port" className="w-24">
                <input
                  className="field"
                  inputMode="numeric"
                  aria-label="Destination port"
                  value={t.targetPort || ""}
                  placeholder="5432"
                  onChange={(e) => set("targetPort", portValue(e.target.value))}
                />
              </Field>
            </>
          )}
        </div>
        <div className="rounded-md bg-bg px-3 py-2 font-mono text-[12px] text-muted">
          {host ? route(t, host) : "Choose an SSH host"}
        </div>
        <div className="flex flex-col gap-2">
          <label className="flex items-start gap-2 text-[12.5px]">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={t.bindHost === ALL}
              onChange={(e) => set("bindHost", e.target.checked ? ALL : t.kind === "remote" ? "" : LOOPBACK)}
            />
            <span>
              {shareLabel}
              <span className="block text-[11.5px] text-faint">{shareHint}</span>
            </span>
          </label>
          <label className="flex items-center gap-2 text-[12.5px]">
            <input type="checkbox" checked={t.autoStart} onChange={(e) => set("autoStart", e.target.checked)} />
            Start automatically when Tusk opens
          </label>
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
