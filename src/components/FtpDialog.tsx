import { useState } from "react";
import { ftpApi, type FtpProtocol, type FtpSite } from "../lib/api";
import { blankFtpSite, COLORS } from "../lib/defaults";
import { useApp } from "../store";
import { KindSwitch } from "./SshDialogs";
import { Field, Modal, Spinner } from "./ui";

/** New / edit FTP or FTPS site. */
export function FtpDialog() {
  const { editing } = useApp((s) => s.ftpDialog);
  const { closeFtpDialog: close, loadConnections, openFilesTab, showToast } = useApp.getState();
  const [cfg, setCfg] = useState<FtpSite>(() => ({ ...blankFtpSite(), ...editing }));
  const [password, setPassword] = useState("");
  const [touched, setTouched] = useState(false);
  const [quick, setQuick] = useState("");
  const [saving, setSaving] = useState(false);
  const isNew = !editing?.id;
  const anonymous = !cfg.user.trim() || cfg.user.trim() === "anonymous";

  const set = <K extends keyof FtpSite>(k: K, v: FtpSite[K]) => setCfg((c) => ({ ...c, [k]: v }));

  // "ftp://user@host:port/path" or "user@host" quick entry.
  const applyQuick = (text: string) => {
    setQuick(text);
    const m = /^(?:(ftps?|ftpes):\/\/)?(?:([^@\s/]+)@)?([^:\s/]+)(?::(\d+))?(\/\S*)?$/.exec(text.trim());
    if (!m) return;
    setCfg((c) => ({
      ...c,
      protocol: m[1] === "ftp" ? "ftp" : m[1] ? "ftps" : c.protocol,
      user: m[2] ?? c.user,
      host: m[3],
      port: Number(m[4] ?? c.port) || 21,
      startDir: m[5] && m[5] !== "/" ? m[5] : c.startDir,
      name: c.name || m[3],
    }));
  };

  const save = async (connect: boolean) => {
    setSaving(true);
    try {
      const site: FtpSite = { ...cfg, id: cfg.id || crypto.randomUUID(), name: cfg.name.trim() || cfg.host.trim(), host: cfg.host.trim() };
      await ftpApi.save(site, touched ? password : null);
      await loadConnections();
      close();
      if (connect) openFilesTab({ kind: "ftp", id: site.id });
      else showToast("FTP site saved", "ok");
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setSaving(false);
    }
  };

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
            <button className="btn-outline" onClick={() => void save(false)} disabled={saving || !cfg.host.trim()}>
              Save
            </button>
          )}
          <button className="btn-primary" onClick={() => void save(true)} disabled={saving || !cfg.host.trim()}>
            {saving && <Spinner size={12} />} Save & open files
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
        {isNew && <KindSwitch value="ftp" folderId={cfg.folderId} />}
        {isNew && (
          <input
            className="field font-mono text-[12px]"
            placeholder="Quick fill: ftp://user@host:21/path"
            value={quick}
            onChange={(e) => applyQuick(e.target.value)}
            spellCheck={false}
          />
        )}
        <div className="flex gap-3">
          <Field label="Name" className="flex-1">
            <input className="field" value={cfg.name} placeholder="Web hosting" onChange={(e) => set("name", e.target.value)} />
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
        <Field label="Encryption">
          <div className="flex rounded-md border border-border p-0.5">
            {(
              [
                ["ftps", "FTP over TLS (FTPS)"],
                ["ftp", "Plain FTP (unencrypted)"],
              ] as [FtpProtocol, string][]
            ).map(([v, label]) => (
              <button
                type="button"
                key={v}
                onClick={() => set("protocol", v)}
                className={`h-7 flex-1 rounded text-[12.5px] ${cfg.protocol === v ? "bg-hover font-medium text-text" : "text-muted hover:text-text"}`}
              >
                {label}
              </button>
            ))}
          </div>
        </Field>
        {cfg.protocol === "ftp" && (
          <div className="rounded-md bg-warn/10 px-3 py-2 text-[12px] text-warn">
            Plain FTP sends your password and files unencrypted. Use it only on trusted networks.
          </div>
        )}
        <div className="flex gap-3">
          <Field label="Host" className="flex-1">
            <input className="field" value={cfg.host} placeholder="ftp.example.com" onChange={(e) => set("host", e.target.value)} spellCheck={false} />
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
        <div className="flex gap-3">
          <Field label="User" className="flex-1" hint={anonymous ? "Empty logs in anonymously" : undefined}>
            <input className="field" value={cfg.user} placeholder="anonymous" onChange={(e) => set("user", e.target.value)} spellCheck={false} />
          </Field>
          <Field label="Password" className="flex-1">
            <input
              className="field"
              type="password"
              value={password}
              placeholder={!isNew && !touched ? "•••••• (unchanged)" : ""}
              onChange={(e) => {
                setPassword(e.target.value);
                setTouched(true);
              }}
            />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-[12.5px]">
          <input type="checkbox" checked={cfg.savePassword} onChange={(e) => set("savePassword", e.target.checked)} />
          Save password <span className="text-faint">(Windows Credential Manager)</span>
        </label>
        <Field label="Start folder (optional)" hint="The file manager opens here. Leave empty for the server's default.">
          <input
            className="field font-mono text-[12px]"
            value={cfg.startDir ?? ""}
            placeholder="/public_html"
            onChange={(e) => set("startDir", e.target.value)}
            spellCheck={false}
          />
        </Field>
        {cfg.protocol === "ftps" && (
          <label className="flex items-center gap-2 text-[12.5px]">
            <input type="checkbox" checked={cfg.acceptInvalidCerts} onChange={(e) => set("acceptInvalidCerts", e.target.checked)} />
            Accept self-signed certificates <span className="text-faint">(still encrypted, but not verified)</span>
          </label>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
