import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Bot, Eraser, Square } from "lucide-react";
import { useEffect, useRef } from "react";
import { claudeApi, type ClaudeActivity } from "../lib/api";
import { useApp, type ClaudeTermTab as ClaudeTermTabModel } from "../store";
import { DARK, LIGHT } from "./TerminalTab";

const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";
/** Longest result printed in full; the Claude panel has the rest. */
const MAX_LINES = 400;
/** Earlier steps shown when the tab opens. */
const REPLAY = 30;

const crlf = (s: string) => s.replace(/\r?\n/g, "\r\n");
const isBusy = (a: ClaudeActivity) => a.outcome === "running" || a.outcome === "waiting";

/** How a step looks typed at a prompt. */
function commandLine(a: ClaudeActivity, cont: string): string {
  const note = (s: string) => `${DIM}# ${s}${RESET}`;
  switch (a.tool) {
    case "server_run":
    case "db_query":
    case "db_execute":
      return a.input.replace(/\r?\n/g, `\r\n${cont}`);
    case "db_tables":
      return "\\dt";
    case "db_describe":
      return `\\d ${a.input}`;
    case "db_activity":
      return `${DIM}-- sessions and locks${RESET}`;
    case "server_status":
      return note("check how the server is doing");
    case "server_logs":
      return note(`read logs: ${a.input}`);
    case "run_saved_command":
      return note(`run saved command "${a.input}"`);
    case "files_list":
      return `ls ${a.input || "~"}`;
    case "files_read":
      return `cat ${a.input}`;
    case "files_write": {
      const [path, ...rest] = a.input.split("\n");
      return note(`write ${path} (${new Blob([rest.slice(1).join("\n")]).size} bytes)`);
    }
    default:
      return note(a.tool);
  }
}

/** Colours the "(exit status N)" line commands end with. */
function exitColour(text: string) {
  return text.replace(/\(exit status (\w+)\)\s*$/, (_m, code) => `${code === "0" ? DIM : RED}(exit status ${code})${RESET}`);
}

function capLines(text: string) {
  const lines = text.split("\n");
  if (lines.length <= MAX_LINES) return text;
  return `${lines.slice(0, MAX_LINES).join("\n")}\n${DIM}… ${lines.length - MAX_LINES} more lines (see the Claude panel)${RESET}`;
}

interface Printed {
  header: boolean;
  waiting: boolean;
  /** Live output shown so far. */
  text: string;
  done: boolean;
}

/** A read-only terminal that replays what Claude does on one server or database, as it happens. */
export function ClaudeTermTab({ tab, active }: { tab: ClaudeTermTabModel; active: boolean }) {
  const theme = useApp((s) => s.theme);
  const running = useApp((s) => s.claude?.activity.find((a) => a.targetId === tab.targetId && isBusy(a))?.id ?? null);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

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
      convertEol: false,
      theme: useApp.getState().theme === "dark" ? DARK : LIGHT,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.open(el);
    termRef.current = term;
    fitRef.current = fit;
    try {
      fit.fit();
    } catch {
      // Hidden tabs have no size yet.
    }

    let disposed = false;
    let pumping = false;
    let dirty = false;
    let promptShown = false;
    let lineStart = true;
    const printed = new Map<number, Printed>();

    const write = (text: string) =>
      new Promise<void>((resolve) => {
        if (disposed || !text) return resolve();
        lineStart = text.endsWith("\n");
        term.write(text, resolve);
      });
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const newLine = () => (lineStart ? Promise.resolve() : write("\r\n"));

    const s0 = useApp.getState();
    const host = s0.sshHosts.find((h) => h.id === tab.targetId);
    const conn = s0.connections.find((c) => c.id === tab.targetId);
    const site = s0.ftpSites.find((f) => f.id === tab.targetId);
    const name = host?.name ?? conn?.name ?? site?.name ?? "";
    const badge = `\x1b[35mclaude${RESET} `;
    const prompt = (a?: ClaudeActivity) =>
      tab.targetKind === "server"
        ? `${badge}\x1b[1;32m${host?.user ?? "user"}@${name}${RESET}:\x1b[1;34m~${RESET}$ `
        : tab.targetKind === "database"
          ? `${badge}\x1b[1;36m${a?.database || conn?.database || "postgres"}${RESET}=> `
          : `${badge}\x1b[1;33mftp:${name}${RESET}> `;
    const cont = tab.targetKind === "database" ? `${conn?.database ?? ""}-> ` : "> ";

    const entries = () =>
      (useApp.getState().claude?.activity ?? []).filter((a) => a.targetId === tab.targetId).sort((a, b) => a.id - b.id);

    // Earlier steps are shown at once; only new ones are typed out.
    const before = entries();
    const replayFrom = before.length > REPLAY ? before[before.length - REPLAY].id : 0;
    const seen = new Set(before.filter((a) => !isBusy(a)).map((a) => a.id));
    for (const a of before) if (a.id < replayFrom) printed.set(a.id, { header: true, waiting: true, text: "", done: true });

    const type = async (text: string, animate: boolean) => {
      if (!animate) return write(text);
      // Fast enough not to hold anything up: at most about a second per command.
      const step = Math.max(1, Math.ceil(text.length / 60));
      for (let i = 0; i < text.length && !disposed; i += step) {
        await write(text.slice(i, i + step));
        await sleep(16);
      }
    };

    const finish = async (a: ClaudeActivity, p: Printed) => {
      await newLine();
      if (a.outcome === "denied") {
        await write(`${YELLOW}✗ You declined this in Tusk.${RESET}\r\n`);
      } else if (a.outcome === "stopped") {
        await write(`${YELLOW}^C Stopped in Tusk.${RESET}\r\n`);
      } else if (a.outcome === "error") {
        await write(`${RED}${crlf(capLines(a.result))}${RESET}\r\n`);
      } else {
        // Whatever the live output hasn't shown yet.
        const rest = p.text && a.result.startsWith(p.text.trimEnd()) ? a.result.slice(p.text.trimEnd().length) : p.text ? "" : a.result;
        const tail = p.text && !rest ? (a.result.match(/\(exit status \w+\)\s*$/)?.[0] ?? "") : rest;
        const text = exitColour(capLines(tail.replace(/^\n/, "")));
        if (text.trim()) await write(`${crlf(text)}\r\n`);
      }
    };

    const pump = async () => {
      if (pumping) {
        dirty = true;
        return;
      }
      pumping = true;
      try {
        do {
          dirty = false;
          for (const a of entries()) {
            if (disposed) return;
            let p = printed.get(a.id);
            if (!p) {
              p = { header: false, waiting: false, text: "", done: false };
              printed.set(a.id, p);
            }
            if (p.done) continue;
            const animate = !seen.has(a.id);
            if (!p.header) {
              if (!promptShown) {
                await newLine();
                await write(prompt(a));
              }
              promptShown = false;
              await type(commandLine(a, cont), animate);
              await write("\r\n");
              p.header = true;
            }
            if (a.outcome === "waiting" && !p.waiting) {
              await write(`${YELLOW}⏸ Waiting for your OK in Tusk…${RESET}\r\n`);
              p.waiting = true;
            }
            if (a.output.length > p.text.length && a.output.startsWith(p.text)) {
              await write(crlf(a.output.slice(p.text.length)));
              p.text = a.output;
            }
            if (isBusy(a)) break; // Keep steps in order: the next one waits for this.
            await finish(a, p);
            p.done = true;
          }
          const latest = entries();
          if (!dirty && !promptShown && latest.length && latest.every((a) => printed.get(a.id)?.done)) {
            // Back at the prompt, like a terminal waiting for the next command.
            await newLine();
            await write(prompt(latest[latest.length - 1]));
            promptShown = true;
          }
        } while (dirty && !disposed);
      } finally {
        pumping = false;
      }
    };

    void (async () => {
      await write(
        `${DIM}Watching Claude on ${name}. What Claude runs here shows up as it happens; press Ctrl+C to stop it.${RESET}\r\n\r\n`,
      );
      if (!before.length) {
        await write(prompt());
        promptShown = true;
      }
      await pump();
    })();

    const unsub = useApp.subscribe((s, prev) => {
      if (s.claude?.activity !== prev.claude?.activity) void pump();
    });
    const input = term.onData((d) => {
      if (d !== "\x03") return;
      const a = entries().find(isBusy);
      if (a) void claudeApi.stop(a.id);
    });
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // Not laid out yet.
      }
    });
    ro.observe(el);
    return () => {
      disposed = true;
      unsub();
      input.dispose();
      ro.disconnect();
      term.dispose();
      termRef.current = null;
    };
  }, [tab.targetId, tab.targetKind]);

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = theme === "dark" ? DARK : LIGHT;
  }, [theme]);

  useEffect(() => {
    if (!active) return;
    requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {
        // Not laid out yet.
      }
      termRef.current?.focus();
    });
  }, [active]);

  return (
    <div className="flex h-full flex-col" data-claude-term={tab.targetId}>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-panel px-3 text-[12px]">
        <Bot size={13} className="text-accent" />
        <span className="font-medium">Watching Claude</span>
        <span className="truncate text-muted">read-only · Ctrl+C stops what Claude is running</span>
        <div className="flex-1" />
        {running !== null && (
          <button className="btn h-6 px-2 text-[11.5px] text-danger" onClick={() => void claudeApi.stop(running)} title="Stop what Claude is running">
            <Square size={10} /> Stop
          </button>
        )}
        <button className="btn-ghost h-6 px-2 text-[11.5px]" onClick={() => termRef.current?.clear()} title="Clear the screen">
          <Eraser size={11} /> Clear
        </button>
      </div>
      <div
        ref={containerRef}
        className="min-h-0 flex-1 px-2 py-1"
        style={{ background: theme === "dark" ? DARK.background : LIGHT.background }}
      />
    </div>
  );
}
