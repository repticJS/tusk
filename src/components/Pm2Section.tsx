import {
  Activity,
  ChevronRight,
  Eraser,
  FileText,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Save,
  Square,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import type { Pm2Info, Pm2Process } from "../lib/api";
import { fmtBytes, fmtUptime } from "../lib/format";
import { useApp } from "../store";
import { Field, Modal, Spinner } from "./ui";

const STATUS_TONE: Record<string, string> = {
  online: "bg-ok",
  stopped: "bg-faint/60",
  stopping: "bg-warn",
  launching: "bg-warn",
  "waiting restart": "bg-warn",
  errored: "bg-danger",
};

/** PM2 apps on one target, with actions. Lives in a Discover card. */
export function Pm2Section({ target, pm2, windows }: { target: string; pm2: Pm2Info; windows: boolean }) {
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const { pm2Action, pm2Terminal } = useApp.getState();

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col" data-pm2-section>
      <div className="flex items-center gap-2 px-4 pt-3 pb-1">
        <span className="text-[11px] font-semibold tracking-wide text-faint uppercase">PM2</span>
        {pm2.version && <span className="text-[11px] text-faint">· {pm2.version}</span>}
        <div className="flex-1" />
        {pm2.status === "ok" && (
          <>
            <button className="btn-ghost h-6 px-1.5 text-[11.5px]" onClick={() => void pm2Terminal(target, "monit")} title="pm2 monit in a terminal">
              <Activity size={12} /> Monitor
            </button>
            <button className="btn-ghost h-6 px-1.5 text-[11.5px]" onClick={() => void pm2Terminal(target, "logs")} title="Logs of every app">
              <FileText size={12} /> All logs
            </button>
            <button
              className="btn-ghost h-6 px-1.5 text-[11.5px]"
              disabled={busy !== null}
              onClick={() => void run("save", () => pm2Action(target, "save"))}
              title="pm2 save: restore these apps after a reboot (with pm2 startup)"
            >
              {busy === "save" ? <Spinner size={10} /> : <Save size={12} />} Save list
            </button>
          </>
        )}
        {pm2.status !== "missing" && !windows && (
          <button className="btn-outline h-6 text-[11.5px]" onClick={() => setStarting(true)}>
            <Plus size={12} /> Start app
          </button>
        )}
      </div>

      {pm2.status === "missing" && <div className="px-4 pb-3 text-[12.5px] text-faint">PM2 isn't installed for this user.</div>}
      {pm2.status === "stopped" && (
        <div className="flex items-center gap-3 px-4 pb-3 text-[12.5px] text-muted">
          PM2 is installed but isn't running for this user.
          <button
            className="btn-outline h-6 text-[11.5px]"
            disabled={busy !== null}
            onClick={() => void run("resurrect", () => pm2Action(target, "resurrect"))}
            title="pm2 resurrect: start the apps from the last saved list"
          >
            {busy === "resurrect" ? <Spinner size={10} /> : <Play size={11} />} Start saved apps
          </button>
        </div>
      )}
      {pm2.status === "error" && <div className="selectable px-4 pb-3 text-[12.5px] text-warn">{pm2.message}</div>}
      {pm2.status === "ok" && pm2.processes.length === 0 && (
        <div className="px-4 pb-3 text-[12.5px] text-faint">No apps in PM2.</div>
      )}
      {pm2.status === "ok" && pm2.processes.length > 0 && (
        <table className="mb-2 w-full table-fixed text-[12px] tabular-nums">
          <thead className="text-left text-[11px] text-faint">
            <tr>
              <th className="w-[34%] py-1 pl-4 font-normal">App</th>
              <th className="w-[13%] font-normal">Status</th>
              <th className="w-[8%] text-right font-normal">CPU</th>
              <th className="w-[10%] text-right font-normal">Memory</th>
              <th className="w-[10%] pl-3 font-normal">Uptime</th>
              <th className="w-[7%] font-normal">↺</th>
              <th className="pr-4 font-normal" />
            </tr>
          </thead>
          <tbody>
            {pm2.processes.map((p) => (
              <AppRow key={p.id} target={target} p={p} />
            ))}
          </tbody>
        </table>
      )}
      {pm2.otherUsers.length > 0 && (
        <div className="px-4 pb-3 text-[11.5px] text-faint">
          PM2 also runs for {pm2.otherUsers.join(", ")}. Connect as that user to manage those apps.
        </div>
      )}
      {starting && <StartAppDialog target={target} onClose={() => setStarting(false)} />}
    </div>
  );
}

function AppRow({ target, p }: { target: string; p: Pm2Process }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { pm2Action, pm2Terminal } = useApp.getState();
  const label = `${p.name} (${p.id})`;
  const online = p.status === "online";

  const act = async (action: "start" | "stop" | "restart" | "reload" | "delete" | "flush" | "reset") => {
    setBusy(action);
    await pm2Action(target, action, String(p.id), label);
    setBusy(null);
  };

  const iconButton = (action: Parameters<typeof act>[0], title: string, icon: React.ReactNode) => (
    <button
      className="btn-ghost h-6 px-1.5"
      title={title}
      aria-label={`${title} ${p.name} ${p.id}`}
      disabled={busy !== null}
      onClick={() => void act(action)}
    >
      {busy === action ? <Spinner size={10} /> : icon}
    </button>
  );

  return (
    <>
      <tr className="group hover:bg-hover/50" data-pm2-app={`${p.name}:${p.id}`}>
        <td className="truncate py-1 pl-4">
          <button className="flex max-w-full items-center gap-1.5 text-left" onClick={() => setOpen((o) => !o)}>
            <ChevronRight size={11} className={`shrink-0 text-faint transition-transform ${open ? "rotate-90" : ""}`} />
            <span className="truncate font-medium">{p.name}</span>
            <span className="shrink-0 text-[11px] text-faint">#{p.id}</span>
            {p.mode === "cluster" && <span className="shrink-0 rounded border border-border px-1 text-[10px] text-muted">cluster</span>}
            {p.watch && <span className="shrink-0 rounded border border-border px-1 text-[10px] text-muted">watch</span>}
          </button>
        </td>
        <td>
          <span className="flex items-center gap-1.5" data-pm2-status>
            <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_TONE[p.status] ?? "bg-faint"}`} />
            {p.status}
          </span>
        </td>
        <td className="text-right">{online ? `${Math.round(p.cpu)}%` : "–"}</td>
        <td className="text-right">{online ? fmtBytes(p.memory) : "–"}</td>
        <td className="pl-3 text-muted">{p.uptime != null ? fmtUptime(p.uptime) : "–"}</td>
        <td className={p.unstableRestarts > 0 ? "text-warn" : "text-muted"} title={p.unstableRestarts ? `${p.unstableRestarts} unstable restarts` : "Restarts"} data-pm2-restarts>
          {p.restarts}
        </td>
        <td className="pr-4">
          <div className="flex justify-end gap-0.5">
            <button
              className="btn-ghost h-6 px-1.5"
              title="Logs"
              aria-label={`Logs ${p.name} ${p.id}`}
              onClick={() => void pm2Terminal(target, "logs", { id: p.id, name: p.name })}
            >
              <FileText size={12} />
            </button>
            {online ? (
              <>
                {iconButton("restart", "Restart", <RotateCw size={12} />)}
                {p.mode === "cluster" && iconButton("reload", "Reload (no downtime)", <RefreshCw size={12} />)}
                {iconButton("stop", "Stop", <Square size={11} />)}
              </>
            ) : (
              iconButton("start", "Start", <Play size={12} />)
            )}
            <button
              className="btn-ghost h-6 px-1.5 hover:text-danger"
              title="Delete from PM2"
              aria-label={`Delete ${p.name} ${p.id}`}
              disabled={busy !== null}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 size={12} />
            </button>
          </div>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={7} className="px-4 pb-2">
            <div className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-0.5 rounded-md bg-bg px-3 py-2 text-[11.5px]">
              <Detail k="Script" v={p.script} mono />
              <Detail k="Folder" v={p.cwd} mono />
              <Detail k="Interpreter" v={[p.interpreter, p.nodeVersion && `node ${p.nodeVersion}`].filter(Boolean).join(" · ")} />
              {p.pid && <Detail k="PID" v={String(p.pid)} />}
              {p.appVersion && <Detail k="App version" v={p.appVersion} />}
              {p.namespace && <Detail k="Namespace" v={p.namespace} />}
              {p.outLog && <Detail k="Output log" v={p.outLog} mono />}
              {p.errLog && <Detail k="Error log" v={p.errLog} mono />}
              <Detail k="Restarts" v={`${p.restarts} (${p.unstableRestarts} unstable)`} />
              <div className="col-span-2 mt-1 flex gap-1">
                <button className="btn-outline h-6 text-[11.5px]" disabled={busy !== null} onClick={() => void act("flush")}>
                  <Eraser size={11} /> Clear logs
                </button>
                <button className="btn-outline h-6 text-[11.5px]" disabled={busy !== null} onClick={() => void act("reset")}>
                  <RotateCw size={11} /> Reset counters
                </button>
              </div>
            </div>
          </td>
        </tr>
      )}
      {confirmDelete && (
        <Modal
          title="Delete from PM2"
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
                  void act("delete");
                }}
              >
                Delete
              </button>
            </>
          }
        >
          <div className="p-4 text-[13px]">
            Stop <b>{label}</b> and remove it from PM2? Its files stay on the server. Use <b>Save list</b> afterwards so it
            doesn't come back after a reboot.
          </div>
        </Modal>
      )}
    </>
  );
}

function Detail({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <>
      <span className="text-faint">{k}</span>
      <span className={`selectable truncate ${mono ? "font-mono text-[11px]" : ""}`} title={v}>
        {v || "–"}
      </span>
    </>
  );
}

function StartAppDialog({ target, onClose }: { target: string; onClose: () => void }) {
  const [script, setScript] = useState("");
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState("");
  const [instances, setInstances] = useState(1);
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    setSaving(true);
    const ok = await useApp.getState().pm2Start(target, { script, name, cwd, instances });
    setSaving(false);
    if (ok) onClose();
  };
  return (
    <Modal
      title="Start an app with PM2"
      width={480}
      onClose={onClose}
      footer={
        <>
          <button className="btn-outline" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={!script.trim() || saving} onClick={() => void submit()}>
            {saving && <Spinner size={12} />} Start
          </button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (script.trim()) void submit();
        }}
      >
        <Field label="Script" hint="A file such as server.js or dist/main.js, or a program on the PATH.">
          <input className="field font-mono" autoFocus value={script} onChange={(e) => setScript(e.target.value)} placeholder="server.js" spellCheck={false} />
        </Field>
        <Field label="Folder" hint="Where the app runs; the script path is relative to it.">
          <input className="field font-mono" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="~/apps/my-api" spellCheck={false} />
        </Field>
        <div className="flex gap-3">
          <Field label="Name" className="flex-1">
            <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="my-api" spellCheck={false} />
          </Field>
          <Field label="Instances" className="w-32" hint={instances > 1 ? "Cluster mode" : "Fork mode"}>
            <input
              className="field"
              inputMode="numeric"
              aria-label="Instances"
              value={instances}
              onChange={(e) => setInstances(Math.max(1, Math.min(64, Number(e.target.value.replace(/\D/g, "")) || 1)))}
            />
          </Field>
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
