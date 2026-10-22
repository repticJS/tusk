import { json } from "@codemirror/lang-json";
import { PostgreSQL, sql } from "@codemirror/lang-sql";
import { StreamLanguage, type StreamParser } from "@codemirror/language";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { go } from "@codemirror/legacy-modes/mode/go";
import { javascript, typescript } from "@codemirror/legacy-modes/mode/javascript";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { nginx } from "@codemirror/legacy-modes/mode/nginx";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { python } from "@codemirror/legacy-modes/mode/python";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { rust } from "@codemirror/legacy-modes/mode/rust";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { html, xml } from "@codemirror/legacy-modes/mode/xml";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Check, FileWarning, RotateCw, Save } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { filesApi, sftpApi } from "../lib/api";
import { useApp, type RemoteFileTab as RemoteFileTabT } from "../store";
import { SqlEditor } from "./SqlEditor";
import { Spinner } from "./ui";

const legacy = (p: StreamParser<unknown>): Extension => StreamLanguage.define(p);

/** Picks syntax highlighting from the file name. */
function languageFor(path: string): { ext: Extension | null; label: string } {
  const name = path.split("/").pop()!.toLowerCase();
  const ext = name.includes(".") ? name.split(".").pop()! : "";
  if (name === "dockerfile" || name.endsWith(".dockerfile")) return { ext: legacy(dockerFile), label: "Dockerfile" };
  if (path.includes("/nginx/") || ext === "nginx") return { ext: legacy(nginx), label: "nginx" };
  if (/^\.?(bashrc|bash_profile|profile|zshrc|bash_aliases|bash_logout)$/.test(name) || ["sh", "bash", "zsh"].includes(ext))
    return { ext: legacy(shell), label: "Shell" };
  const map: Record<string, [() => Extension, string]> = {
    json: [() => json(), "JSON"],
    yml: [() => legacy(yaml), "YAML"],
    yaml: [() => legacy(yaml), "YAML"],
    toml: [() => legacy(toml), "TOML"],
    ini: [() => legacy(properties), "INI"],
    conf: [() => legacy(properties), "Config"],
    cfg: [() => legacy(properties), "Config"],
    env: [() => legacy(properties), "Env"],
    properties: [() => legacy(properties), "Properties"],
    py: [() => legacy(python), "Python"],
    js: [() => legacy(javascript), "JavaScript"],
    mjs: [() => legacy(javascript), "JavaScript"],
    cjs: [() => legacy(javascript), "JavaScript"],
    ts: [() => legacy(typescript), "TypeScript"],
    go: [() => legacy(go), "Go"],
    rs: [() => legacy(rust), "Rust"],
    rb: [() => legacy(ruby), "Ruby"],
    lua: [() => legacy(lua), "Lua"],
    xml: [() => legacy(xml), "XML"],
    html: [() => legacy(html), "HTML"],
    htm: [() => legacy(html), "HTML"],
    sql: [() => sql({ dialect: PostgreSQL }), "SQL"],
  };
  if (name === ".env" || name.startsWith(".env.")) return { ext: legacy(properties), label: "Env" };
  const hit = map[ext];
  return hit ? { ext: hit[0](), label: hit[1] } : { ext: null, label: "Plain text" };
}

export function RemoteFileTab({ tab, active }: { tab: RemoteFileTabT; active: boolean }) {
  const showToast = useApp((s) => s.showToast);
  const setDirty = useApp((s) => s.setDirty);
  const host = useApp((s) => s.sshHosts.find((h) => h.id === tab.hostId) ?? s.ftpSites.find((f) => f.id === tab.hostId));
  const [original, setOriginal] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [state, setState] = useState<"loading" | "ready" | "saving" | "error">("loading");
  const [problem, setProblem] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const textRef = useRef(text);
  textRef.current = text;

  const lang = useMemo(() => languageFor(tab.path), [tab.path]);
  const dirty = original !== null && text !== original;

  useEffect(() => {
    setDirty(tab.id, dirty);
  }, [dirty, tab.id, setDirty]);

  const load = useCallback(async () => {
    setState("loading");
    setProblem(null);
    try {
      const f = tab.filesId ? await filesApi.readText(tab.filesId, tab.path) : await sftpApi.readText(tab.termId, tab.path);
      if (f.content == null) {
        setProblem(f.reason ?? "can't be edited");
        setState("error");
        return;
      }
      setOriginal(f.content);
      setText(f.content);
      setState("ready");
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
      setState("error");
    }
  }, [tab.termId, tab.filesId, tab.path]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async () => {
    const content = textRef.current;
    setState("saving");
    try {
      if (tab.filesId) await filesApi.writeText(tab.filesId, tab.path, content);
      else await sftpApi.writeText(tab.termId, tab.path, content);
      setOriginal(content);
      setSavedAt(Date.now());
      setState("ready");
    } catch (e) {
      setState("ready");
      showToast(`Couldn't save ${tab.title}: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }, [tab.termId, tab.filesId, tab.path, tab.title, showToast]);

  const downloadInstead = async () => {
    const dir = await openDialog({ directory: true, title: "Download to folder" });
    if (typeof dir !== "string") return;
    try {
      if (tab.filesId)
        await filesApi.download(tab.filesId, `dl-${tab.id}`, [{ path: tab.path, dir: false, size: 0 }], dir, "overwrite", () => {});
      else await sftpApi.download(tab.termId, `dl-${tab.id}`, [tab.path], dir, () => {});
      showToast(`Downloaded ${tab.title} to ${dir}`, "ok");
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  useEffect(() => {
    if (active) setTimeout(() => viewRef.current?.focus(), 0);
  }, [active, state]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-panel px-3 text-[12.5px]">
        <button className="btn-primary" onClick={() => void save()} disabled={!dirty || state !== "ready"} title="Save to server (Ctrl+S)">
          {state === "saving" ? <Spinner size={12} /> : <Save size={13} />} Save
        </button>
        <button
          className="btn-ghost"
          title="Reload from server"
          onClick={() => void load()}
          disabled={state === "loading" || state === "saving"}
        >
          <RotateCw size={13} />
        </button>
        <span className="ml-1 min-w-0 truncate font-mono text-[12px] text-muted" title={tab.path}>
          {host ? `${host.user}@${host.host}:` : ""}
          {tab.path}
        </span>
        <div className="flex-1" />
        {dirty ? (
          <span className="rounded bg-warn-soft px-1.5 py-0.5 text-[11.5px] text-warn">Modified</span>
        ) : savedAt ? (
          <span className="flex items-center gap-1 text-[11.5px] text-ok">
            <Check size={12} /> Saved
          </span>
        ) : null}
        <span className="text-[11.5px] text-faint">{lang.label}</span>
      </div>
      <div className="min-h-0 flex-1">
        {state === "loading" && (
          <div className="flex h-full items-center justify-center text-muted">
            <Spinner />
          </div>
        )}
        {state === "error" && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-[13px] text-muted">
            <FileWarning size={28} className="text-faint" />
            <div>
              <span className="font-medium text-text">{tab.title}</span> {problem}.
            </div>
            <button className="btn-outline" onClick={() => void downloadInstead()}>
              Download instead
            </button>
          </div>
        )}
        {(state === "ready" || state === "saving") && (
          <SqlEditor
            value={text}
            onChange={setText}
            language={lang.ext}
            lineWrapping={false}
            onSave={() => void save()}
            onCreate={(v) => (viewRef.current = v)}
          />
        )}
      </div>
    </div>
  );
}
