import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { AlertCircle, Copy, Download, FolderOpen, FolderSymlink, KeyRound, Lock, Upload } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, DbError, shareApi, type ShareCounts, type ShareInfo, type SharePreview } from "../lib/api";
import { useApp } from "../store";
import { Field, Modal, Spinner } from "./ui";

function describe(c: ShareCounts) {
  const part = (n: number, one: string, many: string) => (n ? `${n} ${n === 1 ? one : many}` : null);
  return (
    [
      part(c.connections, "database connection", "database connections"),
      part(c.sshHosts, "SSH host", "SSH hosts"),
      part(c.ftpSites ?? 0, "FTP site", "FTP sites"),
      part(c.tunnels, "tunnel", "tunnels"),
      part(c.commands ?? 0, "saved command", "saved commands"),
      part(c.folders - 1, "subfolder", "subfolders"),
    ]
      .filter(Boolean)
      .join(", ") || "an empty folder"
  );
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Share a folder: share code or .tusk file, optionally with passwords and keys. */
export function ShareDialog() {
  const folderId = useApp((s) => s.shareFolderId);
  const close = () => useApp.getState().openShareDialog(null);
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [withSecrets, setWithSecrets] = useState(false);
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [busy, setBusy] = useState<"copy" | "file" | null>(null);

  useEffect(() => {
    if (!folderId) return;
    setInfo(null);
    setError(null);
    setWithSecrets(false);
    setPass("");
    setPass2("");
    shareApi.info(folderId).then(setInfo, (e) => setError(errText(e)));
  }, [folderId]);

  if (!folderId) return null;
  const secretCount = info ? info.passwords + info.ftpPasswords + info.sshSecrets + info.keyFiles : 0;
  const passProblem = !withSecrets
    ? null
    : pass.length < 8
      ? "Use at least 8 characters"
      : pass !== pass2
        ? "The passphrases don't match"
        : null;
  const ready = !!info && !passProblem;

  const make = () => shareApi.export(folderId, withSecrets, withSecrets ? pass : null);

  const copy = async () => {
    setBusy("copy");
    try {
      await writeText(await make());
      useApp.getState().showToast(`Share code for ${info?.name} copied`, "ok");
      close();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const toFile = async () => {
    const path = await saveDialog({
      defaultPath: `${(info?.name ?? "folder").replace(/[\\/:*?"<>|]/g, "_")}.tusk`,
      filters: [{ name: "Tusk share", extensions: ["tusk"] }],
    });
    if (!path) return;
    setBusy("file");
    try {
      await api.writeTextFile(path, (await make()) + "\n");
      useApp.getState().showToast(`Saved ${path}`, "ok");
      close();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      title={`Share ${info?.name ?? "folder"}`}
      width={500}
      onClose={close}
      footer={
        <>
          <button className="btn-outline mr-auto" onClick={close}>
            Cancel
          </button>
          <button className="btn-outline" disabled={!ready || busy !== null} onClick={() => void toFile()}>
            {busy === "file" ? <Spinner size={12} /> : <Download size={13} />} Save as file…
          </button>
          <button className="btn-primary" disabled={!ready || busy !== null} onClick={() => void copy()}>
            {busy === "copy" ? <Spinner size={12} /> : <Copy size={13} />} Copy share code
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5 p-4 text-[13px]">
        {!info && !error && (
          <div className="flex items-center gap-2 text-muted">
            <Spinner size={12} /> Gathering…
          </div>
        )}
        {info && (
          <>
            <div className="text-muted">
              Includes <span className="text-text">{describe(info.counts)}</span>, with their settings. Whoever imports it gets
              a copy in their own sidebar.
            </div>
            {info.extraHosts.length > 0 && (
              <div className="rounded-md bg-bg px-3 py-2 text-[12px] text-muted">
                Also includes {info.extraHosts.join(", ")}, which connections in this folder go through.
              </div>
            )}
            <label className={`flex items-start gap-2 ${secretCount ? "" : "opacity-50"}`}>
              <input
                type="checkbox"
                className="mt-0.5"
                checked={withSecrets}
                disabled={!secretCount}
                onChange={(e) => setWithSecrets(e.target.checked)}
              />
              <span>
                Include passwords and keys
                <span className="block text-[12px] text-faint">
                  {secretCount
                    ? [
                        info.passwords && `${info.passwords} database password${info.passwords === 1 ? "" : "s"}`,
                        info.ftpPasswords && `${info.ftpPasswords} FTP password${info.ftpPasswords === 1 ? "" : "s"}`,
                        info.sshSecrets && `${info.sshSecrets} SSH password${info.sshSecrets === 1 ? "" : "s"} or passphrase${info.sshSecrets === 1 ? "" : "s"}`,
                        info.keyFiles && `${info.keyFiles} private key file${info.keyFiles === 1 ? "" : "s"}`,
                      ]
                        .filter(Boolean)
                        .join(", ") + ", encrypted with a passphrase"
                    : "No saved passwords or keys in this folder"}
                </span>
              </span>
            </label>
            {withSecrets && (
              <div className="flex flex-col gap-2.5 rounded-md border border-border p-3">
                <div className="flex gap-3">
                  <Field label="Passphrase" className="flex-1">
                    <input className="field" type="password" autoFocus value={pass} onChange={(e) => setPass(e.target.value)} />
                  </Field>
                  <Field label="Repeat it" className="flex-1">
                    <input className="field" type="password" value={pass2} onChange={(e) => setPass2(e.target.value)} />
                  </Field>
                </div>
                {pass && passProblem && <div className="text-[12px] text-warn">{passProblem}</div>}
                <div className="flex items-start gap-1.5 text-[12px] text-muted">
                  <KeyRound size={13} className="mt-0.5 shrink-0" />
                  Send the passphrase a different way than the share (say, in person or another app). Anyone with both can
                  log in to these servers.
                </div>
              </div>
            )}
          </>
        )}
        {error && (
          <div className="flex items-start gap-2 rounded-md bg-danger-soft px-3 py-2 text-[12.5px] text-danger">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <span className="selectable">{error}</span>
          </div>
        )}
      </div>
    </Modal>
  );
}

/** Import a share code or .tusk file into a folder. */
export function ImportDialog() {
  const dialog = useApp((s) => s.importDialog);
  const folders = useApp((s) => s.folders);
  const close = () => useApp.getState().closeImportDialog();
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<SharePreview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pass, setPass] = useState("");
  const [parent, setParent] = useState<string>("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!dialog) return;
    setText("");
    setPass("");
    setPreview(null);
    setProblem(null);
    setParent(dialog.parentId ?? "");
  }, [dialog]);

  // Preview as soon as something that looks like a share is pasted.
  useEffect(() => {
    if (!text.trim()) {
      setPreview(null);
      setProblem(null);
      return;
    }
    let live = true;
    shareApi.preview(text).then(
      (p) => live && (setPreview(p), setProblem(null)),
      (e) => live && (setPreview(null), setProblem(errText(e))),
    );
    return () => {
      live = false;
    };
  }, [text]);

  // Folders as an indented list, parents first.
  const options = useMemo(() => {
    const out: { id: string; label: string }[] = [];
    const walk = (parentId: string | null, depth: number) => {
      for (const f of folders.filter((x) => (x.parentId ?? null) === parentId).sort((a, b) => a.name.localeCompare(b.name))) {
        out.push({ id: f.id, label: `${"   ".repeat(depth)}${f.name}` });
        walk(f.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [folders]);

  if (!dialog) return null;

  const openFile = async () => {
    const path = await openDialog({ multiple: false, filters: [{ name: "Tusk share", extensions: ["tusk", "txt"] }] });
    if (typeof path !== "string") return;
    try {
      setText(await api.readTextFile(path));
    } catch (e) {
      setProblem(errText(e));
    }
  };

  const run = async () => {
    setBusy(true);
    try {
      const r = await shareApi.import(text, preview?.encrypted ? pass : null, parent || null);
      const s = useApp.getState();
      await s.loadConnections();
      await s.loadTunnels();
      if (parent) s.toggleFolder(parent, true);
      s.toggleFolder(r.folderId, true);
      s.showToast(`Imported ${r.name}: ${describe(r.counts)}`, "ok");
      close();
    } catch (e) {
      const kind = e instanceof DbError ? e.info.kind : null;
      setProblem(kind === "PASSPHRASE_WRONG" ? "Wrong passphrase. Check it with whoever shared this." : errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Import shared folder"
      width={520}
      onClose={close}
      footer={
        <>
          <button className="btn-outline" onClick={close}>
            Cancel
          </button>
          <button
            className="btn-primary"
            disabled={!preview || busy || (preview.encrypted && !pass)}
            onClick={() => void run()}
          >
            {busy ? <Spinner size={12} /> : <Upload size={13} />} Import
          </button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3.5 p-4 text-[13px]"
        onSubmit={(e) => {
          e.preventDefault();
          if (preview && !busy && (!preview.encrypted || pass)) void run();
        }}
      >
        <div className="flex items-end gap-2">
          <Field label="Share code" className="flex-1">
            <textarea
              className="field h-20 resize-none font-mono text-[11.5px] break-all"
              autoFocus
              placeholder="tusk-share-1:…"
              aria-label="Share code"
              value={text}
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
            />
          </Field>
        </div>
        <button type="button" className="btn-outline self-start" onClick={() => void openFile()}>
          <FolderOpen size={13} /> Open a .tusk file…
        </button>
        {preview && (
          <div className="flex items-start gap-2.5 rounded-md bg-bg px-3 py-2.5" data-share-preview>
            <FolderSymlink size={16} className="mt-0.5 shrink-0 text-warn" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">{preview.name}</div>
              <div className="text-[12px] text-muted">{describe(preview.counts)}</div>
              {preview.encrypted && (
                <div className="mt-1 flex items-center gap-1 text-[12px] text-muted">
                  <Lock size={11} /> Includes passwords and keys
                </div>
              )}
            </div>
          </div>
        )}
        {preview?.encrypted && (
          <Field label="Passphrase">
            <input
              className="field"
              type="password"
              value={pass}
              onChange={(e) => {
                setPass(e.target.value);
                setProblem(null);
              }}
              aria-label="Passphrase"
            />
          </Field>
        )}
        {preview && (
          <Field label="Put it in">
            <select className="field" value={parent} onChange={(e) => setParent(e.target.value)} aria-label="Put it in">
              <option value="">Top level</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
        )}
        {problem && (
          <div className="flex items-start gap-2 rounded-md bg-danger-soft px-3 py-2 text-[12.5px] text-danger">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <span className="selectable">{problem}</span>
          </div>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
