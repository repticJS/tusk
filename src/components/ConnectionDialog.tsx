import { CheckCircle2, AlertCircle, Link2 } from "lucide-react";
import { useState } from "react";
import { api, type ConnectionConfig, type SslMode } from "../lib/api";
import { useApp } from "../store";
import { Field, Modal, Spinner } from "./ui";

const COLORS = ["#5b8cff", "#4cc38a", "#e7b350", "#f26d6d", "#b07cff", "#3fc1c9", "#ff8a4c", "#8a92a0"];

const blank = (): ConnectionConfig => ({
  id: "",
  name: "",
  host: "localhost",
  port: 5432,
  user: "postgres",
  database: "postgres",
  sslMode: "prefer",
  color: COLORS[0],
  savePassword: true,
  showSystemSchemas: false,
});

/** Parses postgres://user:pass@host:port/db?sslmode=require */
function parseUrl(url: string): Partial<ConnectionConfig> & { password?: string } {
  const u = new URL(url.trim().replace(/^postgresql:/, "postgres:").replace(/^postgres:/, "http:"));
  const out: Partial<ConnectionConfig> & { password?: string } = {};
  if (u.hostname) out.host = decodeURIComponent(u.hostname);
  if (u.port) out.port = Number(u.port);
  if (u.username) out.user = decodeURIComponent(u.username);
  if (u.password) out.password = decodeURIComponent(u.password);
  const db = u.pathname.replace(/^\//, "");
  if (db) out.database = decodeURIComponent(db);
  const ssl = u.searchParams.get("sslmode");
  if (ssl) out.sslMode = (ssl === "verify-ca" ? "verify-full" : ssl === "allow" ? "prefer" : ssl) as SslMode;
  return out;
}

export function ConnectionDialog() {
  const { editing } = useApp((s) => s.connectionDialog);
  const close = useApp((s) => s.closeConnectionDialog);
  const loadConnections = useApp((s) => s.loadConnections);
  const connect = useApp((s) => s.connect);
  const showToast = useApp((s) => s.showToast);

  const [cfg, setCfg] = useState<ConnectionConfig>(() => (editing ? { ...editing } : blank()));
  const [password, setPassword] = useState("");
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [url, setUrl] = useState("");
  const [test, setTest] = useState<{ state: "idle" | "running" | "ok" | "error"; text?: string }>({ state: "idle" });
  const [saving, setSaving] = useState(false);
  const isNew = !editing?.id;

  const set = <K extends keyof ConnectionConfig>(k: K, v: ConnectionConfig[K]) => setCfg((c) => ({ ...c, [k]: v }));

  const applyUrl = (text: string) => {
    setUrl(text);
    if (!/^postgres(ql)?:\/\//.test(text.trim())) return;
    try {
      const { password: pw, ...rest } = parseUrl(text);
      setCfg((c) => ({ ...c, ...rest, name: c.name || rest.database || "" }));
      if (pw) {
        setPassword(pw);
        setPasswordTouched(true);
      }
    } catch {
      // Keep typing.
    }
  };

  const resolved = (): ConnectionConfig => ({
    ...cfg,
    id: cfg.id || crypto.randomUUID(),
    name: cfg.name.trim() || `${cfg.database}@${cfg.host}`,
  });

  const runTest = async () => {
    setTest({ state: "running" });
    try {
      // Without a typed password, test with the stored one by opening via the backend.
      const info = await api.testConnection(resolved(), passwordTouched ? password : null);
      setTest({ state: "ok", text: `Connected · PostgreSQL ${info.serverVersion}` });
    } catch (e) {
      setTest({ state: "error", text: e instanceof Error ? e.message : String(e) });
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const c = resolved();
      await api.saveConnection(c, passwordTouched ? password : null);
      await loadConnections();
      close();
      if (isNew) void connect(c.id);
      else showToast("Connection saved", "ok");
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
          <button className="btn-outline mr-auto" onClick={() => void runTest()} disabled={test.state === "running"}>
            {test.state === "running" && <Spinner size={12} />} Test connection
          </button>
          <button className="btn-outline" onClick={close}>
            Cancel
          </button>
          <button className="btn-primary" onClick={() => void save()} disabled={saving || !cfg.host}>
            {saving && <Spinner size={12} />} {isNew ? "Save & connect" : "Save"}
          </button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3.5 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="flex h-8 items-center gap-2 rounded-md border border-dashed border-border bg-bg px-2.5 focus-within:border-accent">
          <Link2 size={13} className="text-faint" />
          <input
            className="min-w-0 flex-1 bg-transparent font-mono text-[12px] outline-none placeholder:text-faint"
            placeholder="Paste a connection URL: postgres://user:password@host:5432/db"
            value={url}
            onChange={(e) => applyUrl(e.target.value)}
          />
        </div>
        <div className="flex gap-3">
          <Field label="Name" className="flex-1">
            <input className="field" value={cfg.name} placeholder="My database" onChange={(e) => set("name", e.target.value)} autoFocus />
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
                  title={c === "#f26d6d" ? "Red: handy for production" : undefined}
                />
              ))}
            </div>
          </Field>
        </div>
        <div className="flex gap-3">
          <Field label="Host" className="flex-1">
            <input className="field" value={cfg.host} onChange={(e) => set("host", e.target.value)} spellCheck={false} />
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
            <input className="field" value={cfg.user} onChange={(e) => set("user", e.target.value)} spellCheck={false} />
          </Field>
          <Field label="Password" className="flex-1">
            <input
              className="field"
              type="password"
              value={password}
              placeholder={!isNew && !passwordTouched ? "•••••• (unchanged)" : ""}
              onChange={(e) => {
                setPassword(e.target.value);
                setPasswordTouched(true);
              }}
            />
          </Field>
        </div>
        <div className="flex gap-3">
          <Field label="Database" className="flex-1">
            <input className="field" value={cfg.database} onChange={(e) => set("database", e.target.value)} spellCheck={false} />
          </Field>
          <Field label="SSL" className="w-40">
            <select className="field" value={cfg.sslMode} onChange={(e) => set("sslMode", e.target.value as SslMode)}>
              <option value="disable">disable</option>
              <option value="prefer">prefer</option>
              <option value="require">require</option>
              <option value="verify-full">verify-full</option>
            </select>
          </Field>
        </div>
        <div className="flex flex-col gap-2 pt-1">
          <label className="flex items-center gap-2 text-[12.5px]">
            <input type="checkbox" checked={cfg.savePassword} onChange={(e) => set("savePassword", e.target.checked)} />
            Save password <span className="text-faint">(stored in Windows Credential Manager)</span>
          </label>
          <label className="flex items-center gap-2 text-[12.5px]">
            <input
              type="checkbox"
              checked={cfg.showSystemSchemas}
              onChange={(e) => set("showSystemSchemas", e.target.checked)}
            />
            Show system schemas <span className="text-faint">(pg_catalog, information_schema)</span>
          </label>
        </div>
        {test.state === "ok" && (
          <div className="flex items-center gap-2 rounded-md bg-ok-soft px-3 py-2 text-[12.5px] text-ok">
            <CheckCircle2 size={14} /> {test.text}
          </div>
        )}
        {test.state === "error" && (
          <div className="flex items-start gap-2 rounded-md bg-danger-soft px-3 py-2 text-[12.5px] text-danger">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <span className="selectable break-words">{test.text}</span>
          </div>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

export function PasswordPrompt() {
  const req = useApp((s) => s.passwordRequest);
  const resolve = useApp((s) => s.resolvePassword);
  const conn = useApp((s) => s.connections.find((c) => c.id === req?.connId));
  const [pw, setPw] = useState("");
  if (!req) return null;
  const submit = () => {
    resolve(pw);
    setPw("");
  };
  return (
    <Modal
      title={`Password for ${conn?.name ?? "connection"}`}
      width={400}
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
        {req.failed && (
          <div className="rounded-md bg-danger-soft px-3 py-2 text-[12.5px] text-danger">
            Password authentication failed. Try again.
          </div>
        )}
        <div className="text-[12.5px] text-muted">
          {conn?.user}@{conn?.host}:{conn?.port}
        </div>
        <input className="field" type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} />
        <div className="text-[11.5px] text-faint">Kept in memory until Tusk closes. Edit the connection to save it.</div>
      </form>
    </Modal>
  );
}
