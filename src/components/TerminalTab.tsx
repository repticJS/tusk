import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ChevronDown, ChevronUp, RotateCw, Search, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { DbError, sshApi } from "../lib/api";
import { useApp, type TerminalTab as TerminalTabT } from "../store";
import { Spinner } from "./ui";

type ConnState = "connecting" | "connected" | "closed";

const DARK: ITheme = {
  background: "#0e1014",
  foreground: "#d8dce3",
  cursor: "#5b8cff",
  cursorAccent: "#0e1014",
  selectionBackground: "rgba(91,140,255,0.35)",
  black: "#1a1e25",
  red: "#f26d6d",
  green: "#4cc38a",
  yellow: "#e7b350",
  blue: "#5b8cff",
  magenta: "#c08cff",
  cyan: "#3fc1c9",
  white: "#d8dce3",
  brightBlack: "#5c6370",
  brightRed: "#ff8f8f",
  brightGreen: "#6fe0a8",
  brightYellow: "#ffd27a",
  brightBlue: "#86a9ff",
  brightMagenta: "#d6b0ff",
  brightCyan: "#7adde3",
  brightWhite: "#ffffff",
};

const LIGHT: ITheme = {
  background: "#f6f7f9",
  foreground: "#1c2027",
  cursor: "#3a6df0",
  cursorAccent: "#f6f7f9",
  selectionBackground: "rgba(58,109,240,0.25)",
  black: "#1c2027",
  red: "#c93c3c",
  green: "#1f7a4d",
  yellow: "#946200",
  blue: "#2c5ad8",
  magenta: "#8a3fc7",
  cyan: "#0b7f86",
  white: "#dfe3ea",
  brightBlack: "#646c79",
  brightRed: "#e05252",
  brightGreen: "#23905d",
  brightYellow: "#b7791f",
  brightBlue: "#3a6df0",
  brightMagenta: "#a35bd9",
  brightCyan: "#12969e",
  brightWhite: "#ffffff",
};

const ANSI_DIM = "\x1b[2m";
const ANSI_RED = "\x1b[31m";
const ANSI_RESET = "\x1b[0m";

export function TerminalTab({ tab, active }: { tab: TerminalTabT; active: boolean }) {
  const host = useApp((s) => s.sshHosts.find((h) => h.id === tab.hostId));
  const theme = useApp((s) => s.theme);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const stateRef = useRef<ConnState>("connecting");
  const [state, setStateRaw] = useState<ConnState>("connecting");
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  const setState = (s: ConnState) => {
    stateRef.current = s;
    setStateRaw(s);
  };

  const connect = useCallback(
    async (acceptFingerprint: string | null = null): Promise<void> => {
      const term = termRef.current;
      const h = useApp.getState().sshHosts.find((x) => x.id === tab.hostId);
      if (!term || !h) return;
      setState("connecting");
      if (!acceptFingerprint) term.write(`${ANSI_DIM}Connecting to ${h.user}@${h.host}:${h.port}…${ANSI_RESET}\r\n`);
      const app = useApp.getState();
      try {
        await sshApi.open(
          tab.id,
          h.id,
          term.cols,
          term.rows,
          acceptFingerprint,
          (bytes) => term.write(bytes),
          (e) => {
            if (e.type === "connected") {
              setState("connected");
              if (e.banner) term.write(e.banner.replace(/\r?\n/g, "\r\n"));
            } else if (e.type === "closed") {
              setState("closed");
              term.write(
                `\r\n${ANSI_DIM}── Disconnected${e.reason ? `: ${e.reason}` : ""}. Press Enter or R to reconnect ──${ANSI_RESET}\r\n`,
              );
            }
          },
        );
      } catch (err) {
        const info = err instanceof DbError ? err.info : { message: String(err), kind: null, hint: null, detail: null };
        const kind = info.kind;
        if (kind === "HOSTKEY_UNKNOWN" || kind === "HOSTKEY_CHANGED") {
          const ok = await app.requestHostKey({
            hostId: h.id,
            message: info.message,
            key: info.detail ?? "",
            changed: kind === "HOSTKEY_CHANGED",
          });
          if (ok && info.hint) return connect(info.hint);
          term.write(`${ANSI_RED}Host key not accepted.${ANSI_RESET}\r\n`);
        } else if (kind === "PASSWORD_REQUIRED" || kind === "AUTH_FAILED" || kind === "PASSPHRASE_REQUIRED") {
          const r = await app.requestSshSecret({
            hostId: h.id,
            what: kind === "PASSPHRASE_REQUIRED" ? "passphrase" : "password",
            message: kind === "PASSWORD_REQUIRED" ? undefined : info.message,
          });
          if (r) {
            await sshApi.setSecret(h.id, r.secret, r.save);
            return connect(acceptFingerprint);
          }
          term.write(`${ANSI_RED}Cancelled.${ANSI_RESET}\r\n`);
        } else {
          term.write(`${ANSI_RED}${info.message}${ANSI_RESET}\r\n`);
        }
        setState("closed");
        term.write(`${ANSI_DIM}Press Enter or R to try again.${ANSI_RESET}\r\n`);
      }
    },
    [tab.id, tab.hostId],
  );

  // Create the terminal once.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const term = new Terminal({
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "JetBrains Mono", monospace',
      fontSize: 14,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
      theme: useApp.getState().theme === "dark" ? DARK : LIGHT,
      rightClickSelectsWord: false,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.loadAddon(new WebLinksAddon((_e, uri) => void openUrl(uri).catch(() => {})));
    term.open(el);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // Falls back to the DOM renderer.
    }
    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      // Ctrl+C copies when there's a selection, otherwise it's an interrupt.
      if (mod && key === "c" && (e.shiftKey || term.hasSelection())) {
        if (term.hasSelection()) {
          void writeText(term.getSelection());
          term.clearSelection();
        }
        e.preventDefault();
        return false;
      }
      // Ctrl+V / Ctrl+Shift+V: let the browser fire a paste event, which xterm handles.
      if (mod && key === "v") return false;
      if (mod && e.shiftKey && key === "f") {
        e.preventDefault();
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.select(), 0);
        return false;
      }
      // App-level shortcuts that must keep working inside a terminal.
      if (mod && e.key === "Tab") return false;
      if (mod && e.shiftKey && (key === "p" || key === "w" || key === "t")) return false;
      return true;
    });

    term.onData((data) => {
      if (stateRef.current === "connected") {
        void sshApi.write(tab.id, data);
      } else if (stateRef.current === "closed" && (data === "\r" || data.toLowerCase() === "r")) {
        void connect();
      }
    });

    // Fit to the container whenever it changes size (and is visible).
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame = 0;
    const ro = new ResizeObserver(() => {
      // Fit on the next frame; resizing inside the observer callback loops.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!el.offsetWidth || !el.offsetHeight) return;
        fit.fit();
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (stateRef.current === "connected") void sshApi.resize(tab.id, term.cols, term.rows);
        }, 60);
      });
    });
    ro.observe(el);

    if (el.offsetWidth) fit.fit();
    void connect();

    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      void sshApi.close(tab.id).catch(() => {});
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = theme === "dark" ? DARK : LIGHT;
  }, [theme]);

  useEffect(() => {
    if (!active) return;
    // Refit after being shown (hidden tabs have no size) and take focus.
    const t = setTimeout(() => {
      if (containerRef.current?.offsetWidth) fitRef.current?.fit();
      termRef.current?.focus();
    }, 0);
    return () => clearTimeout(t);
  }, [active]);

  const onContextMenu = async (e: React.MouseEvent) => {
    e.preventDefault();
    const term = termRef.current;
    if (!term) return;
    // PuTTY/MobaXterm style: right-click copies a selection, otherwise pastes.
    if (term.hasSelection()) {
      await writeText(term.getSelection());
      term.clearSelection();
    } else {
      const text = await readText().catch(() => "");
      if (text) term.paste(text);
    }
    term.focus();
  };

  const find = (dir: "next" | "prev") => {
    const opts = { caseSensitive: false, decorations: { matchOverviewRuler: "#e7b350", activeMatchColorOverviewRuler: "#5b8cff" } };
    if (dir === "next") searchRef.current?.findNext(query, opts);
    else searchRef.current?.findPrevious(query, opts);
  };

  const target = host ? `${host.user}@${host.host}${host.port === 22 ? "" : `:${host.port}`}` : "";

  return (
    <div className="flex h-full flex-col" style={{ background: theme === "dark" ? DARK.background : LIGHT.background }}>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-panel px-3 text-[12px]">
        <span
          className={`h-2 w-2 rounded-full ${state === "connected" ? "bg-ok" : state === "connecting" ? "bg-warn" : "bg-faint"}`}
        />
        <span className="font-medium">{host?.name}</span>
        <span className="text-faint">{target}</span>
        {state === "connecting" && <Spinner size={11} />}
        <div className="flex-1" />
        {state === "closed" && (
          <button className="btn-outline h-6" onClick={() => void connect()}>
            <RotateCw size={12} /> Reconnect
          </button>
        )}
        <button
          className="btn-ghost h-6 px-1.5"
          title="Find (Ctrl+Shift+F)"
          onClick={() => {
            setSearchOpen(true);
            setTimeout(() => searchInputRef.current?.select(), 0);
          }}
        >
          <Search size={13} />
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        {searchOpen && (
          <div className="absolute top-2 right-4 z-10 flex items-center gap-1 rounded-lg border border-border bg-panel p-1 shadow-xl">
            <input
              ref={searchInputRef}
              className="h-7 w-56 rounded bg-bg px-2 text-[12.5px] outline-none"
              placeholder="Find in terminal"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") find(e.shiftKey ? "prev" : "next");
                if (e.key === "Escape") {
                  setSearchOpen(false);
                  searchRef.current?.clearDecorations();
                  termRef.current?.focus();
                }
              }}
            />
            <button className="btn-ghost h-7 px-1.5" onClick={() => find("prev")} title="Previous (Shift+Enter)">
              <ChevronUp size={14} />
            </button>
            <button className="btn-ghost h-7 px-1.5" onClick={() => find("next")} title="Next (Enter)">
              <ChevronDown size={14} />
            </button>
            <button
              className="btn-ghost h-7 px-1.5"
              onClick={() => {
                setSearchOpen(false);
                searchRef.current?.clearDecorations();
                termRef.current?.focus();
              }}
            >
              <X size={14} />
            </button>
          </div>
        )}
        {/* Padding lives on the wrapper: the measured box must never grow scrollbars,
            or fitting the terminal and the scrollbar appearing resize each other forever. */}
        <div className="absolute inset-0 py-1 pl-2" onContextMenu={(e) => void onContextMenu(e)}>
          <div ref={containerRef} className="tusk-terminal h-full w-full overflow-hidden" />
        </div>
      </div>
    </div>
  );
}
