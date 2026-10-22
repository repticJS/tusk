import { useState } from "react";
import { rdpApi, type RdpConfig } from "../lib/api";
import { blankRdp, COLORS } from "../lib/defaults";
import { useApp } from "../store";
import { KindSwitch } from "./SshDialogs";
import { Field, Modal, Spinner } from "./ui";

const SIZES = ["1280x720", "1366x768", "1440x900", "1600x900", "1920x1080", "2560x1440"];

/** New / edit remote desktop connection. */
export function RdpDialog() {
  const { editing } = useApp((s) => s.rdpDialog);
  const { closeRdpDialog: close, loadConnections, openRdpTab, showToast } = useApp.getState();
  const [cfg, setCfg] = useState<RdpConfig>(() => ({ ...blankRdp(), ...editing }));
  const [password, setPassword] = useState("");
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const isNew = !editing?.id;

  const set = <K extends keyof RdpConfig>(k: K, v: RdpConfig[K]) => setCfg((c) => ({ ...c, [k]: v }));

  // "host:port" in the host field fills both.
  const setHost = (text: string) => {
    const m = /^([^:\s]+):(\d+)$/.exec(text.trim());
    if (m) setCfg((c) => ({ ...c, host: m[1], port: Number(m[2]) }));
    else set("host", text);
  };
  // "DOMAIN\user" or "user@domain" in the user field.
  const setUser = (text: string) => {
    const m = /^([^\\]+)\\(.+)$/.exec(text);
    if (m) setCfg((c) => ({ ...c, domain: m[1], user: m[2] }));
    else set("user", text);
  };

  const save = async (connect: boolean) => {
    setSaving(true);
    try {
      const c: RdpConfig = { ...cfg, id: cfg.id || crypto.randomUUID(), name: cfg.name.trim() || cfg.host.trim(), host: cfg.host.trim() };
      await rdpApi.save(c, touched ? password : null);
      await loadConnections();
      close();
      if (connect) openRdpTab(c.id);
      else showToast("Remote desktop saved", "ok");
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setSaving(false);
    }
  };

  const fixed = cfg.size !== "fit";

  return (
    <Modal
      title={isNew ? "New connection" : `Edit ${editing?.name}`}
      onClose={close}
      width={580}
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
            {saving && <Spinner size={12} />} {isNew ? "Save & connect" : "Save & open"}
          </button>
        </>
      }
    >
      <form
        className="flex max-h-[70vh] flex-col gap-3.5 overflow-auto p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save(true);
        }}
      >
        {isNew && <KindSwitch value="rdp" folderId={cfg.folderId} />}
        <div className="flex gap-3">
          <Field label="Name" className="flex-1">
            <input className="field" value={cfg.name} placeholder="Office PC" onChange={(e) => set("name", e.target.value)} />
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
          <Field label="Computer" className="flex-1">
            <input
              className="field"
              value={cfg.host}
              placeholder="pc-name, server.example.com or 10.0.0.5"
              onChange={(e) => setHost(e.target.value)}
              spellCheck={false}
            />
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
          <Field label="User" className="flex-1">
            <input className="field" value={cfg.user} placeholder="Administrator" onChange={(e) => setUser(e.target.value)} spellCheck={false} />
          </Field>
          <Field label="Domain (optional)" className="w-40">
            <input className="field" value={cfg.domain} placeholder="CORP" onChange={(e) => set("domain", e.target.value)} spellCheck={false} />
          </Field>
        </div>
        <Field label="Password">
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
        <label className="flex items-center gap-2 text-[12.5px]">
          <input type="checkbox" checked={cfg.savePassword} onChange={(e) => set("savePassword", e.target.checked)} />
          Save password <span className="text-faint">(Windows Credential Manager)</span>
        </label>

        <div className="mt-1 text-[11px] font-semibold tracking-wide text-faint uppercase">Display</div>
        <div className="flex gap-3">
          <Field label="Screen size" className="flex-1">
            <select className="field" value={cfg.size} onChange={(e) => set("size", e.target.value)} aria-label="Screen size">
              <option value="fit">Fit the tab (resizes with it)</option>
              {SIZES.map((s) => (
                <option key={s} value={s}>
                  {s.replace("x", " × ")}
                </option>
              ))}
            </select>
          </Field>
          {fixed && (
            <Field label="If it's bigger than the tab" className="flex-1">
              <select className="field" value={cfg.scale} onChange={(e) => set("scale", e.target.value as RdpConfig["scale"])}>
                <option value="fit">Shrink to fit</option>
                <option value="none">Show actual size (scroll)</option>
              </select>
            </Field>
          )}
        </div>
        <div className="flex gap-3">
          <Field label="Colors" className="flex-1">
            <select className="field" value={cfg.colorDepth} onChange={(e) => set("colorDepth", Number(e.target.value) as 16 | 32)}>
              <option value={32}>Highest quality (32-bit)</option>
              <option value={16}>High color (16-bit, for slow connections)</option>
            </select>
          </Field>
          <Field label="Experience" className="flex-1">
            <select className="field" value={cfg.performance} onChange={(e) => set("performance", e.target.value as RdpConfig["performance"])}>
              <option value="best">Best looking (wallpaper, animations)</option>
              <option value="fast">Fastest (plain desktop)</option>
            </select>
          </Field>
        </div>
        <div className="flex flex-col gap-2 text-[12.5px]">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={cfg.fullScreen} onChange={(e) => set("fullScreen", e.target.checked)} />
            Open full screen
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={cfg.sound} onChange={(e) => set("sound", e.target.checked)} />
            Play the computer's sound here
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={cfg.clipboard} onChange={(e) => set("clipboard", e.target.checked)} />
            Share the clipboard (copy and paste between the computers)
          </label>
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
