import { Ban, CheckCircle2, Copy, KeyRound, Pencil, Play, Plus, RotateCw, TerminalSquare, Trash2, XCircle, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SavedCommand } from "../lib/api";
import { fmtDuration } from "../lib/format";
import { useApp, type CommandsTab as CommandsTabModel, type RunHost, type RunTab as RunTabModel } from "../store";
import { Field, Modal, Spinner } from "./ui";

export const blankCommand = (hostIds: string[] = []): SavedCommand => ({
  id: "",
  name: "",
  script: "",
  hostIds,
  stopOnError: true,
  confirm: true,
});

const hostNames = (ids: string[]) => {
  const hosts = useApp.getState().sshHosts;
  return ids.map((id) => hosts.find((h) => h.id === id)?.name ?? "missing host");
};

export function CommandsTab(_: { tab: CommandsTabModel; active: boolean }) {
  const commands = useApp((s) => s.commands);
  const hosts = useApp((s) => s.sshHosts);
  const { openCommandDialog, runCommand, deleteCommand } = useApp.getState();
  const [deleting, setDeleting] = useState<SavedCommand | null>(null);
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto flex max-w-[900px] flex-col gap-4 p-6">
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <div className="text-[17px] font-semibold tracking-tight">Commands</div>
            <div className="text-[12.5px] text-muted">
              Save the commands you run all the time (deploys, restarts, cleanups) and run them on one server or several at
              once, with live output from each.
            </div>
          </div>
          <button className="btn-primary" disabled={!hosts.length} onClick={() => openCommandDialog()}>
            <Plus size={14} /> New command
          </button>
        </div>
        {!hosts.length && (
          <div className="rounded-lg border border-dashed border-border p-5 text-[13px] text-muted">
            Commands run on saved SSH hosts. Add one first.
          </div>
        )}
        {hosts.length > 0 && commands.length === 0 && (
          <div className="rounded-lg border border-dashed border-border p-5 text-[13px] text-muted">
            No commands yet. A deploy could be:
            <pre className="mt-2 rounded bg-bg p-2 font-mono text-[12px] text-text">
              cd ~/apps/api{"\n"}git pull{"\n"}npm ci{"\n"}pm2 reload api
            </pre>
          </div>
        )}
        {commands.length > 0 && (
          <div className="overflow-hidden rounded-lg border border-border bg-panel">
            {commands.map((c) => (
              <div key={c.id} className="flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-0" data-command={c.name}>
                <Zap size={14} className="shrink-0 text-warn" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-medium">{c.name}</span>
                    <span className="truncate text-[11.5px] text-muted">on {hostNames(c.hostIds).join(", ")}</span>
                  </div>
                  <div className="truncate font-mono text-[11.5px] text-faint">{c.script.split("\n").filter(Boolean).join(" ; ")}</div>
                </div>
                <button className="btn-primary h-7" onClick={() => runCommand(c)} aria-label={`Run ${c.name}`}>
                  <Play size={12} /> Run
                </button>
                <button className="btn-ghost h-7 px-1.5" title="Edit" onClick={() => openCommandDialog(c)}>
                  <Pencil size={13} />
                </button>
                <button className="btn-ghost h-7 px-1.5" title="Duplicate" onClick={() => openCommandDialog({ ...c, id: "", name: `${c.name} copy` })}>
                  <Copy size={13} />
                </button>
                <button className="btn-ghost h-7 px-1.5 hover:text-danger" title="Delete" onClick={() => setDeleting(c)}>
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      {deleting && (
        <Modal
          title="Delete command"
          width={400}
          onClose={() => setDeleting(null)}
          footer={
            <>
              <button className="btn-outline" onClick={() => setDeleting(null)}>
                Cancel
              </button>
              <button
                className="btn-danger"
                onClick={() => {
                  void deleteCommand(deleting.id);
                  setDeleting(null);
                }}
              >
                Delete
              </button>
            </>
          }
        >
          <div className="p-4 text-[13px]">
            Delete <b>{deleting.name}</b>?
          </div>
        </Modal>
      )}
    </div>
  );
}

export function CommandDialog() {
  const dialog = useApp((s) => s.commandDialog);
  const hosts = useApp((s) => s.sshHosts);
  const { closeCommandDialog, saveCommand, runCommand } = useApp.getState();
  const [c, setC] = useState<SavedCommand>(blankCommand());
  const [filter, setFilter] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (dialog) setC({ ...blankCommand(), ...dialog.editing });
    setFilter("");
  }, [dialog]);

  if (!dialog) return null;
  const isNew = !dialog.editing.id;
  const set = <K extends keyof SavedCommand>(k: K, v: SavedCommand[K]) => setC((x) => ({ ...x, [k]: v }));
  const toggle = (id: string) => set("hostIds", c.hostIds.includes(id) ? c.hostIds.filter((h) => h !== id) : [...c.hostIds, id]);
  const shown = hosts.filter((h) => !filter || `${h.name} ${h.host}`.toLowerCase().includes(filter.toLowerCase()));
  const valid = c.name.trim() && c.script.trim() && c.hostIds.length > 0;

  const save = async (run: boolean) => {
    setSaving(true);
    const out = { ...c, id: c.id || crypto.randomUUID(), name: c.name.trim() };
    const ok = await saveCommand(out);
    setSaving(false);
    if (!ok) return;
    closeCommandDialog();
    // Pressing "Save & run" is the go-ahead; no second question.
    if (run) runCommand(out, true);
    else useApp.getState().openCommandsTab();
  };

  return (
    <Modal
      title={isNew ? "New command" : `Edit ${dialog.editing.name}`}
      width={600}
      onClose={closeCommandDialog}
      footer={
        <>
          <button className="btn-outline mr-auto" onClick={closeCommandDialog}>
            Cancel
          </button>
          <button className="btn-outline" disabled={!valid || saving} onClick={() => void save(false)}>
            Save
          </button>
          <button className="btn-primary" disabled={!valid || saving} onClick={() => void save(true)}>
            {saving ? <Spinner size={12} /> : <Play size={12} />} Save & run
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5 p-4">
        <Field label="Name">
          <input className="field" autoFocus value={c.name} onChange={(e) => set("name", e.target.value)} placeholder="Deploy API" />
        </Field>
        <Field label="Commands" hint="Runs with sh in your home folder. Node tools installed with nvm are found. sudo only works without a password prompt.">
          <textarea
            className="field h-36 resize-y font-mono text-[12.5px]"
            value={c.script}
            onChange={(e) => set("script", e.target.value)}
            placeholder={"cd ~/apps/api\ngit pull\nnpm ci\npm2 reload api"}
            spellCheck={false}
            aria-label="Commands"
          />
        </Field>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-medium text-muted">Run on</span>
            <span className="text-[11.5px] text-faint">{c.hostIds.length} selected</span>
            <div className="flex-1" />
            {hosts.length > 6 && (
              <input className="field h-6 w-40 py-0 text-[12px]" placeholder="Filter servers" value={filter} onChange={(e) => setFilter(e.target.value)} />
            )}
          </div>
          <div className="grid max-h-40 grid-cols-2 gap-1 overflow-auto rounded-md border border-border p-1.5">
            {shown.map((h) => (
              <label key={h.id} className="flex items-center gap-2 rounded px-1.5 py-1 text-[12.5px] hover:bg-hover">
                <input type="checkbox" checked={c.hostIds.includes(h.id)} onChange={() => toggle(h.id)} />
                <TerminalSquare size={12} style={{ color: h.color ?? undefined }} />
                <span className="truncate">{h.name}</span>
                <span className="truncate text-[11px] text-faint">{h.host}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="flex gap-5 text-[12.5px]">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={c.stopOnError} onChange={(e) => set("stopOnError", e.target.checked)} />
            Stop at the first failing line
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={c.confirm} onChange={(e) => set("confirm", e.target.checked)} />
            Ask before running
          </label>
        </div>
      </div>
    </Modal>
  );
}

/** "Run Deploy on web-01 and web-02?" */
export function RunConfirm() {
  const c = useApp((s) => s.pendingRun);
  if (!c) return null;
  const close = () => useApp.setState({ pendingRun: null });
  return (
    <Modal
      title={`Run ${c.name}?`}
      width={520}
      onClose={close}
      footer={
        <>
          <button className="btn-outline" onClick={close}>
            Cancel
          </button>
          <button className="btn-primary" onClick={() => useApp.getState().runCommand(c, true)}>
            <Play size={12} /> Run
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-2.5 p-4 text-[13px]">
        <div>
          On <b>{hostNames(c.hostIds).join(", ")}</b>:
        </div>
        <pre className="max-h-48 overflow-auto rounded-md bg-bg p-2.5 font-mono text-[12px]">{c.script}</pre>
      </div>
    </Modal>
  );
}

/** Terminal-ish text: colour codes dropped, carriage-return progress lines collapsed. */
function clean(text: string) {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .split("\n")
    .map((l) => {
      const t = l.replace(/\r$/, "");
      const i = t.lastIndexOf("\r");
      return i >= 0 ? t.slice(i + 1) : t;
    })
    .join("\n");
}

export function RunTab({ tab }: { tab: RunTabModel; active: boolean }) {
  const run = useApp((s) => s.runs[tab.runId]);
  const { rerun, cancelRun } = useApp.getState();
  const [, setTick] = useState(0);
  const running = !!run?.hosts.some((h) => h.status === "running");
  // Running time ticks along.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running]);
  if (!run) return <div className="p-6 text-[13px] text-muted">This run is gone.</div>;
  const ok = run.hosts.filter((h) => h.status === "ok").length;
  const failed = run.hosts.filter((h) => h.status === "failed").length;
  const cols = run.hosts.length === 1 ? "grid-cols-1" : run.hosts.length <= 4 ? "grid-cols-2" : "grid-cols-3";
  return (
    <div className="flex h-full flex-col" data-run={run.title}>
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5">
        <Zap size={15} className="text-warn" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold">{run.title}</div>
          <div className="text-[11.5px] text-muted" data-run-summary>
            {running
              ? `Running on ${run.hosts.length} server${run.hosts.length === 1 ? "" : "s"}…`
              : `Finished: ${ok} succeeded${failed ? `, ${failed} failed` : ""}`}
          </div>
        </div>
        {running ? (
          <button className="btn-outline" onClick={() => cancelRun(tab.runId)}>
            <Ban size={12} /> Cancel
          </button>
        ) : (
          <>
            {failed > 0 && (
              <button
                className="btn-outline"
                onClick={() => rerun(tab.runId, run.hosts.filter((h) => h.status === "failed").map((h) => h.hostId))}
              >
                <RotateCw size={12} /> Run again where it failed
              </button>
            )}
            <button className="btn-primary" onClick={() => rerun(tab.runId)}>
              <RotateCw size={12} /> Run again
            </button>
          </>
        )}
      </div>
      <div className={`grid min-h-0 flex-1 gap-px bg-border ${cols}`} style={{ gridAutoRows: "minmax(0, 1fr)" }}>
        {run.hosts.map((h) => (
          <HostOutput key={h.hostId} h={h} runId={tab.runId} />
        ))}
      </div>
    </div>
  );
}

function HostOutput({ h, runId }: { h: RunHost; runId: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const text = useMemo(() => clean(h.output), [h.output]);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [text]);
  const elapsed = ((h.ended ?? Date.now()) - h.started) / 1000;
  const login = h.loginProblem;
  return (
    <div className="flex min-h-0 flex-col bg-bg" data-run-host={h.name} data-status={h.status}>
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-panel px-3 py-1.5 text-[12px]">
        {h.status === "running" ? (
          <Spinner size={11} />
        ) : h.status === "ok" ? (
          <CheckCircle2 size={13} className="text-ok" />
        ) : h.status === "cancelled" ? (
          <Ban size={13} className="text-muted" />
        ) : (
          <XCircle size={13} className="text-danger" />
        )}
        <span className="font-medium">{h.name}</span>
        <span className="text-faint">
          {h.status === "running"
            ? fmtDuration(elapsed)
            : h.status === "cancelled"
              ? "cancelled"
              : `${h.exit != null ? `exit ${h.exit} · ` : ""}${fmtDuration(elapsed)}`}
        </span>
        <div className="flex-1" />
        {login && (
          <button
            className="btn-outline h-6 text-[11.5px]"
            onClick={async () => {
              if (await useApp.getState().resolveSshProblem(login)) useApp.getState().rerun(runId, [h.hostId]);
            }}
          >
            <KeyRound size={11} /> Log in and retry
          </button>
        )}
      </div>
      <pre
        ref={ref}
        className="selectable min-h-0 flex-1 overflow-auto p-2.5 font-mono text-[12px] leading-[1.45] whitespace-pre-wrap"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
        }}
      >
        {text}
        {h.error && <span className="text-danger">{(text ? "\n" : "") + h.error}</span>}
        {!text && !h.error && h.status === "running" && <span className="text-faint">Connecting…</span>}
      </pre>
    </div>
  );
}
