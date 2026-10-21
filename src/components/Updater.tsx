import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { ArrowUpCircle, RefreshCw } from "lucide-react";
import { useEffect } from "react";
import { create } from "zustand";
import { formatBytes } from "../lib/sql";
import { useApp } from "../store";
import { Modal, Spinner } from "./ui";

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

type Status = "idle" | "checking" | "available" | "downloading" | "installing" | "error";

interface UpdaterState {
  version: string;
  status: Status;
  update: Update | null;
  done: number;
  total: number;
  error: string | null;
  dialogOpen: boolean;
  checkNow(manual: boolean): Promise<void>;
  install(): Promise<void>;
  setDialogOpen(open: boolean): void;
}

export const useUpdater = create<UpdaterState>()((set, get) => ({
  version: "",
  status: "idle",
  update: null,
  done: 0,
  total: 0,
  error: null,
  dialogOpen: false,

  async checkNow(manual) {
    if (["checking", "downloading", "installing"].includes(get().status)) return;
    set({ status: "checking", error: null });
    try {
      const update = await check();
      if (update) {
        set({ status: "available", update, dialogOpen: manual || get().dialogOpen });
      } else {
        set({ status: "idle", update: null });
        if (manual) useApp.getState().showToast(`You're on the latest version (${get().version})`, "ok");
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      set({ status: get().update ? "available" : "idle", error: message });
      if (manual) useApp.getState().showToast(`Couldn't check for updates: ${message}`, "error");
    }
  },

  async install() {
    const update = get().update;
    if (!update) return;
    set({ status: "downloading", done: 0, total: 0, error: null });
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") set({ total: event.data.contentLength ?? 0 });
        else if (event.event === "Progress") set((s) => ({ done: s.done + event.data.chunkLength }));
        else if (event.event === "Finished") set({ status: "installing" });
      });
      // On Windows the installer has already closed the app; elsewhere restart it.
      await relaunch();
    } catch (e) {
      set({ status: "available", error: e instanceof Error ? e.message : String(e) });
    }
  },

  setDialogOpen: (dialogOpen) => set({ dialogOpen }),
}));

/** Checks for updates shortly after launch and then periodically. */
export function useUpdateChecks() {
  useEffect(() => {
    void getVersion()
      .then((version) => useUpdater.setState({ version }))
      .catch(() => {});
    const first = setTimeout(() => void useUpdater.getState().checkNow(false), 5000);
    const every = setInterval(() => void useUpdater.getState().checkNow(false), CHECK_EVERY_MS);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, []);
}

/** Status-bar chip: current version, or a prompt when an update is ready. */
export function UpdateChip() {
  const { version, status, update, setDialogOpen } = useUpdater();
  if (update && status !== "idle") {
    return (
      <button
        className="flex items-center gap-1 rounded bg-accent-soft px-1.5 text-accent hover:brightness-125"
        onClick={() => setDialogOpen(true)}
        title="Install the update"
      >
        <ArrowUpCircle size={11} /> Update {update.version} available
      </button>
    );
  }
  return (
    <button
      className="flex items-center gap-1 hover:text-text"
      title="Check for updates"
      onClick={() => void useUpdater.getState().checkNow(true)}
    >
      {status === "checking" ? <RefreshCw size={10} className="animate-spin" /> : null}
      {version ? `v${version}` : ""}
    </button>
  );
}

export function UpdateDialog() {
  const { dialogOpen, update, status, done, total, error, version, setDialogOpen, install } = useUpdater();
  const unsaved = useApp((s) => Object.values(s.dirty).filter(Boolean).length);
  const terminals = useApp((s) => s.tabs.filter((t) => t.kind === "terminal").length);
  if (!dialogOpen || !update) return null;
  const busy = status === "downloading" || status === "installing";
  const pct = total ? Math.min(100, (done / total) * 100) : 0;
  return (
    <Modal
      title={`Update to Tusk ${update.version}`}
      width={540}
      onClose={() => !busy && setDialogOpen(false)}
      closeOnBackdrop={!busy}
      footer={
        <>
          <button className="btn-outline" onClick={() => setDialogOpen(false)} disabled={busy}>
            Later
          </button>
          <button className="btn-primary" onClick={() => void install()} disabled={busy}>
            {busy && <Spinner size={12} />} {status === "installing" ? "Restarting…" : "Install and restart"}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3 p-4 text-[13px]">
        <div className="text-muted">
          You have {version || "an older version"}.
          {update.date && <> Released {new Date(update.date).toLocaleDateString()}.</>}
        </div>
        {update.body && (
          <div className="selectable max-h-[260px] overflow-auto rounded-md border border-border bg-bg p-3 text-[12.5px] leading-relaxed whitespace-pre-wrap">
            {update.body.trim()}
          </div>
        )}
        {(unsaved > 0 || terminals > 0) && !busy && (
          <div className="rounded-md bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
            Tusk will restart.
            {terminals > 0 && ` ${terminals} open terminal${terminals === 1 ? "" : "s"} will disconnect.`}
            {unsaved > 0 && ` ${unsaved} remote file${unsaved === 1 ? " has" : "s have"} unsaved changes that will be lost.`}
          </div>
        )}
        {busy && (
          <div>
            <div className="mb-1.5 flex justify-between text-[12px] text-muted">
              <span>{status === "installing" ? "Installing…" : "Downloading…"}</span>
              <span className="tabular-nums">{total ? `${formatBytes(done)} / ${formatBytes(total)}` : ""}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-hover">
              <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${status === "installing" ? 100 : pct}%` }} />
            </div>
          </div>
        )}
        {error && <div className="rounded-md bg-danger-soft px-3 py-2 text-[12.5px] text-danger">{error}</div>}
      </div>
    </Modal>
  );
}
