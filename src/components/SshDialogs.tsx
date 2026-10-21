import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderOpen, ShieldAlert, ShieldQuestion } from "lucide-react";
import { useState } from "react";
import { sshApi, type SshAuth, type SshHost } from "../lib/api";
import { useApp } from "../store";
import { blankConnection, blankSshHost, COLORS } from "../lib/defaults";
import { Field, Modal, Spinner } from "./ui";

/** PostgreSQL / SSH switch shown at the top of a new-connection dialog. */
export function KindSwitch({ value, folderId }: { value: "postgres" | "ssh"; folderId?: string | null }) {
  const s = useApp.getState();
  const pick = (v: "postgres" | "ssh") => {
    if (v === value) return;
    if (v === "ssh") {
      s.closeConnectionDialog();
      s.openSshDialog({ ...blankSshHost(), folderId });
    } else {
      s.closeSshDialog();
      s.openConnectionDialog({ ...blankConnection(), folderId });
    }
  };
  return (
    <div className="flex rounded-md border border-border p-0.5">
      {(
        [
          ["postgres", "PostgreSQL"],
          ["ssh", "SSH"],
        ] as const
      ).map(([v, label]) => (
        <button
          type="button"
          key={v}
          onClick={() => pick(v)}
          className={`h-7 flex-1 rounded px-3 text-[12.5px] ${value === v ? "bg-hover font-medium text-text" : "text-muted hover:text-text"}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function SshDialog() {
  const { editing } = useApp((s) => s.sshDialog);
  const close = useApp((s) => s.closeSshDialog);
  const loadConnections = useApp((s) => s.loadConnections);
  const openTerminalTab = useApp((s) => s.openTerminalTab);
  const showToast = useApp((s) => s.showToast);
  const [cfg, setCfg] = useState<SshHost>(() => (editing ? { ...editing } : blankSshHost()));
  const [secret, setSecret] = useState("");
  const [secretTouched, setSecretTouched] = useState(false);
  const [quick, setQuick] = useState("");
  const [saving, setSaving] = useState(false);
  const isNew = !editing?.id;

  const set = <K extends keyof SshHost>(k: K, v: SshHost[K]) => setCfg((c) => ({ ...c, [k]: v }));

  // "user@host:port" or "ssh -p 2222 user@host" quick entry.
  const applyQuick = (text: string) => {
    setQuick(text);
    const t = text.trim().replace(/^ssh\s+/, "");
    const port = /(?:^|\s)-p\s*(\d+)/.exec(t)?.[1];
    const target = t.replace(/(?:^|\s)-p\s*\d+/, "").trim().split(/\s+/)[0] ?? "";
    const m = /^(?:([^@\s]+)@)?([^:\s]+)(?::(\d+))?$/.exec(target);
    if (!m) return;
    setCfg((c) => ({
      ...c,
      user: m[1] ?? c.user,
      host: m[2],
      port: Number(port ?? m[3] ?? c.port) || 22,
      name: c.name || m[2],
    }));
  };

  const browseKey = async () => {
    const path = await openDialog({ multiple: false, title: "Choose a private key" });
    if (typeof path === "string") set("keyPath", path);
  };

  const save = async (connect: boolean) => {
    setSaving(true);
    try {
      const c: SshHost = { ...cfg, id: cfg.id || crypto.randomUUID(), name: cfg.name.trim() || cfg.host };
      const sendSecret = cfg.auth === "agent" ? null : secretTouched ? secret : null;
      await sshApi.save(c, sendSecret);
      await loadConnections();
      close();
      if (connect) openTerminalTab(c.id);
      else showToast("SSH host saved", "ok");
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setSaving(false);
    }
  };

  const secretLabel = cfg.auth === "key" ? "Key passphrase" : "Password";

  return (
    <Modal
      title={isNew ? "New connection" : `Edit ${editing?.name}`}
      onClose={close}
      width={560}
      footer={
        <>
          <button className="btn-outline" onClick={close}>
            Cancel
          </button>
          {!isNew && (
            <button className="btn-outline" onClick={() => void save(false)} disabled={saving || !cfg.host}>
              Save
            </button>
          )}
          <button className="btn-primary" onClick={() => void save(true)} disabled={saving || !cfg.host || !cfg.user}>
            {saving && <Spinner size={12} />} {isNew ? "Save & open terminal" : "Save & open"}
          </button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3.5 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save(true);
        }}
      >
        {isNew && <KindSwitch value="ssh" folderId={cfg.folderId} />}
        {isNew && (
          <input
            className="field font-mono text-[12px]"
            placeholder="Quick fill: user@host:port  or  ssh -p 2222 user@host"
            value={quick}
            onChange={(e) => applyQuick(e.target.value)}
            spellCheck={false}
          />
        )}
        <div className="flex gap-3">
          <Field label="Name" className="flex-1">
            <input className="field" value={cfg.name} placeholder="web-01" onChange={(e) => set("name", e.target.value)} />
          </Field>
          <Field label="Color">
            <div className="flex h-[31px] items-center gap-1">
              {COLORS.map((c) => (
                <button
                  type="button"
                  key={c}
                  className={`h-5 w-5 rounded-full ring-offset-2 ring-offset-panel ${cfg.color === c ? "ring-2 ring-text" : ""}`}
                  style={{ background: c }}
                  onClick={() => set("color", c)}
                />
              ))}
            </div>
          </Field>
        </div>
        <div className="flex gap-3">
          <Field label="Host" className="flex-1">
            <input className="field" value={cfg.host} placeholder="server.example.com" onChange={(e) => set("host", e.target.value)} spellCheck={false} />
          </Field>
          <Field label="Port" className="w-24">
            <input
              className="field"
              value={cfg.port}
              inputMode="numeric"
              onChange={(e) => set("port", Number(e.target.value.replace(/\D/g, "")) || 0)}
            />
          </Field>
        </div>
        <Field label="User">
          <input className="field" value={cfg.user} placeholder="root" onChange={(e) => set("user", e.target.value)} spellCheck={false} />
        </Field>
        <Field label="Start folder (optional)" hint="The terminal and file panel open here. Leave empty for your home folder.">
          <input
            className="field font-mono text-[12px]"
            value={cfg.startDir ?? ""}
            placeholder="/home/New Webapp"
            onChange={(e) => set("startDir", e.target.value)}
            spellCheck={false}
          />
        </Field>
        <Field label="Authentication">
          <div className="flex rounded-md border border-border p-0.5">
            {(
              [
                ["password", "Password"],
                ["key", "Private key"],
                ["agent", "SSH agent"],
              ] as [SshAuth, string][]
            ).map(([v, label]) => (
              <button
                type="button"
                key={v}
                onClick={() => set("auth", v)}
                className={`h-7 flex-1 rounded text-[12.5px] ${cfg.auth === v ? "bg-hover font-medium text-text" : "text-muted hover:text-text"}`}
              >
                {label}
              </button>
            ))}
          </div>
        </Field>
        {cfg.auth === "key" && (
          <Field label="Private key file" hint="OpenSSH or PuTTY (.ppk) format">
            <div className="flex gap-2">
              <input
                className="field font-mono text-[12px]"
                value={cfg.keyPath ?? ""}
                placeholder="C:\Users\you\.ssh\id_ed25519"
                onChange={(e) => set("keyPath", e.target.value)}
                spellCheck={false}
              />
              <button type="button" className="btn-outline h-[31px]" onClick={() => void browseKey()}>
                <FolderOpen size={13} /> Browse
              </button>
            </div>
          </Field>
        )}
        {cfg.auth !== "agent" ? (
          <>
            <Field label={cfg.auth === "key" ? `${secretLabel} (if the key has one)` : secretLabel}>
              <input
                className="field"
                type="password"
                value={secret}
                placeholder={!isNew && !secretTouched ? "•••••• (unchanged)" : ""}
                onChange={(e) => {
                  setSecret(e.target.value);
                  setSecretTouched(true);
                }}
              />
            </Field>
            <label className="flex items-center gap-2 text-[12.5px]">
              <input type="checkbox" checked={cfg.saveSecret} onChange={(e) => set("saveSecret", e.target.checked)} />
              Save {secretLabel.toLowerCase()} <span className="text-faint">(Windows Credential Manager)</span>
            </label>
          </>
        ) : (
          <div className="rounded-md bg-panel-2 px-3 py-2 text-[12px] text-muted">
            Uses keys from the Windows OpenSSH Authentication Agent or Pageant.
          </div>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

export function SshSecretPrompt() {
  const req = useApp((s) => s.sshSecretRequest);
  const resolve = useApp((s) => s.resolveSshSecret);
  const host = useApp((s) => s.sshHosts.find((h) => h.id === req?.hostId));
  const [value, setValue] = useState("");
  const [save, setSave] = useState(false);
  if (!req) return null;
  const submit = () => {
    resolve({ secret: value, save });
    setValue("");
  };
  const label = req.what === "passphrase" ? "Key passphrase" : "Password";
  return (
    <Modal
      title={`${label} for ${host?.name ?? "host"}`}
      width={420}
      closeOnBackdrop={false}
      onClose={() => resolve(null)}
      footer={
        <>
          <button className="btn-outline" onClick={() => resolve(null)}>
            Cancel
          </button>
          <button className="btn-primary" onClick={submit}>
            Connect
          </button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {req.message && <div className="rounded-md bg-danger-soft px-3 py-2 text-[12.5px] text-danger">{req.message}</div>}
        <div className="text-[12.5px] text-muted">
          {host?.user}@{host?.host}
          {host && host.port !== 22 ? `:${host.port}` : ""}
          {req.what === "passphrase" && host?.keyPath && <div className="mt-1 truncate font-mono text-[11.5px]">{host.keyPath}</div>}
        </div>
        <input className="field" type="password" autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
        <label className="flex items-center gap-2 text-[12.5px]">
          <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
          Remember in Windows Credential Manager
        </label>
      </form>
    </Modal>
  );
}

export function HostKeyPrompt() {
  const req = useApp((s) => s.hostKeyRequest);
  const resolve = useApp((s) => s.resolveHostKey);
  if (!req) return null;
  return (
    <Modal
      title={req.changed ? "Host key changed" : "Unknown host"}
      width={560}
      closeOnBackdrop={false}
      onClose={() => resolve(false)}
      footer={
        <>
          <button className="btn-outline" onClick={() => resolve(false)}>
            Cancel
          </button>
          <button className={req.changed ? "btn-danger" : "btn-primary"} onClick={() => resolve(true)}>
            {req.changed ? "Replace key and connect" : "Trust and connect"}
          </button>
        </>
      }
    >
      <div className="flex gap-3 p-4">
        {req.changed ? (
          <ShieldAlert size={22} className="mt-0.5 shrink-0 text-danger" />
        ) : (
          <ShieldQuestion size={22} className="mt-0.5 shrink-0 text-warn" />
        )}
        <div className="min-w-0 text-[13px]">
          <p>{req.message}</p>
          <p className="mt-3 text-muted">Server key fingerprint:</p>
          <div className="selectable mt-1 rounded-md bg-bg px-3 py-2 font-mono text-[12px] break-all">{req.key}</div>
          <p className="mt-3 text-[12px] text-faint">
            {req.changed
              ? "Only continue if you know the server's key was changed (for example it was reinstalled)."
              : "If you're not sure, compare this with the fingerprint shown by the server's administrator. Tusk will remember it."}
          </p>
        </div>
      </div>
    </Modal>
  );
}
