import type { EditorView } from "@codemirror/view";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { ChevronDown, Database, FolderOpen, History, Play, Save, Square, Zap } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { api, DbError } from "../lib/api";
import { firstKeyword, formatCount, splitStatements, statementAt, type Statement } from "../lib/sql";
import { cacheKey, tabSession, useApp, type QueryTab as QueryTabT } from "../store";
import { QueryResults, type RunOutcome } from "./QueryResults";
import { setErrorMark, SqlEditor } from "./SqlEditor";
import { DropdownButton, Spinner } from "./ui";

const ROW_LIMITS = [1000, 10000, 100000, 1000000];

export function QueryTab({ tab, active }: { tab: QueryTabT; active: boolean }) {
  const updateTab = useApp((s) => s.updateTab);
  const addHistory = useApp((s) => s.addHistory);
  const showToast = useApp((s) => s.showToast);
  const rowLimit = useApp((s) => s.rowLimit);
  const setRowLimit = useApp((s) => s.setRowLimit);
  const setHistoryOpen = useApp((s) => s.setHistoryOpen);
  const conn = useApp((s) => s.connections.find((c) => c.id === tab.connId));
  const databases = useApp((s) => s.databases[tab.connId]);
  const completion = useApp((s) => s.cache[cacheKey(tab.connId, tab.database)]?.completion);
  const loadCompletion = useApp((s) => s.loadCompletion);
  const connectionState = useApp((s) => s.status[tab.connId]?.state);
  const connect = useApp((s) => s.connect);

  const viewRef = useRef<EditorView | null>(null);
  const [running, setRunning] = useState(false);
  const [runStarted, setRunStarted] = useState<number | null>(null);
  const [outcome, setOutcome] = useState<RunOutcome | null>(null);
  const [inTransaction, setInTransaction] = useState(false);
  // Offsets of the statements in the last run, for mapping error positions.
  const lastRun = useRef<Statement[]>([]);
  const sqlRef = useRef(tab.sql);
  sqlRef.current = tab.sql;

  useEffect(() => {
    if (active && connectionState === "connected") void loadCompletion(tab.connId, tab.database);
  }, [active, connectionState, tab.connId, tab.database, loadCompletion]);

  const session = tabSession(tab);

  const execute = useCallback(
    async (stmts: Statement[]) => {
      if (!stmts.length || running) return;
      if (connectionState !== "connected" && !(await connect(tab.connId))) return;
      viewRef.current?.dispatch({ effects: setErrorMark.of(null) });
      lastRun.current = stmts;
      const texts = stmts.map((s) => s.text);
      const started = Date.now();
      setRunning(true);
      setRunStarted(started);
      try {
        const results = await api.run(session, texts, rowLimit);
        setOutcome({ results, statements: texts, startedAt: started });
        // Track explicit transactions so the user can see one is open.
        let tx = inTransaction;
        for (const r of results) {
          const text = texts[r.statement];
          const kw = firstKeyword(text);
          if (r.error) continue;
          if (kw === "BEGIN" || (kw === "START" && /^\s*start\s+transaction/i.test(text))) tx = true;
          else if (["COMMIT", "END", "ABORT"].includes(kw)) tx = false;
          else if (kw === "ROLLBACK" && !/^\s*rollback\s+(work\s+|transaction\s+)?to\b/i.test(text)) tx = false;
        }
        setInTransaction(tx);
        const failed = results.find((r) => r.error);
        addHistory({
          sql: texts.join(";\n\n"),
          connId: tab.connId,
          database: tab.database,
          at: started,
          durationMs: Date.now() - started,
          ok: !failed,
        });
        if (failed) markError(failed.statement, failed.error?.position ?? null);
        // DDL changes the schema; refresh autocomplete in the background.
        if (texts.some((t) => ["CREATE", "ALTER", "DROP"].includes(firstKeyword(t))))
          void loadCompletion(tab.connId, tab.database, true);
      } catch (e) {
        const info = e instanceof DbError ? e.info : { message: String(e) };
        setOutcome({
          results: [{ statement: 0, rows: [], rowCount: 0, truncated: false, durationMs: 0, notices: [], error: info }],
          statements: texts,
          startedAt: started,
        });
      } finally {
        setRunning(false);
        setRunStarted(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [running, connectionState, tab.connId, tab.database, rowLimit, inTransaction],
  );

  const markError = (statement: number, position: number | null) => {
    const view = viewRef.current;
    const stmt = lastRun.current[statement];
    if (!view || !stmt) return;
    const doc = view.state.doc.toString();
    if (doc.slice(stmt.from, stmt.to) !== stmt.text) return; // edited since
    let from = stmt.from;
    let to = stmt.to;
    if (position) {
      from = stmt.from + position - 1;
      const m = /^[\w$."]+|^./.exec(doc.slice(from, stmt.to));
      to = from + (m ? m[0].length : 1);
    }
    view.dispatch({
      effects: setErrorMark.of({ from, to }),
      selection: { anchor: from },
      scrollIntoView: true,
    });
    view.focus();
  };

  const runCurrent = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const doc = view.state.doc.toString();
    const sel = view.state.selection.main;
    if (!sel.empty) {
      // Run the selection; keep offsets relative to the full document.
      const part = doc.slice(sel.from, sel.to);
      return execute(splitStatements(part).map((s) => ({ ...s, from: s.from + sel.from, to: s.to + sel.from })));
    }
    const stmt = statementAt(doc, sel.head);
    if (stmt) void execute([stmt]);
  }, [execute]);

  const runAll = useCallback(() => {
    const doc = viewRef.current?.state.doc.toString() ?? sqlRef.current;
    void execute(splitStatements(doc));
  }, [execute]);

  const explain = (analyze: boolean) => {
    const view = viewRef.current;
    if (!view) return;
    const doc = view.state.doc.toString();
    const sel = view.state.selection.main;
    const stmt = sel.empty ? statementAt(doc, sel.head) : { text: doc.slice(sel.from, sel.to).trim(), from: sel.from, to: sel.to };
    if (!stmt?.text) return;
    const opts = analyze ? "(ANALYZE, BUFFERS, VERBOSE)" : "(VERBOSE)";
    void execute([{ text: `EXPLAIN ${opts} ${stmt.text}`, from: -1, to: -1 }]);
  };

  const cancel = () => void api.cancel(session).catch((e) => showToast(String(e.message ?? e), "error"));

  const saveFile = useCallback(async () => {
    let path = tab.filePath;
    if (!path) {
      path = (await saveDialog({ defaultPath: `${tab.title}.sql`, filters: [{ name: "SQL", extensions: ["sql"] }] })) ?? undefined;
      if (!path) return;
    }
    await api.writeTextFile(path, sqlRef.current);
    const name = path.split(/[\\/]/).pop() ?? path;
    updateTab(tab.id, { filePath: path, title: name });
    showToast(`Saved ${name}`, "ok");
  }, [tab.filePath, tab.title, tab.id, updateTab, showToast]);

  const openFile = async () => {
    const path = await openDialog({ multiple: false, filters: [{ name: "SQL", extensions: ["sql", "txt"] }] });
    if (typeof path !== "string") return;
    const text = await api.readTextFile(path);
    updateTab(tab.id, { sql: text, filePath: path, title: path.split(/[\\/]/).pop() ?? path });
  };

  const switchDatabase = async (db: string) => {
    if (db === tab.database) return;
    await api.closeSession(session).catch(() => {});
    setInTransaction(false);
    updateTab(tab.id, { database: db });
  };

  const onChange = useCallback((v: string) => updateTab(tab.id, { sql: v }), [tab.id, updateTab]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border bg-panel px-2.5">
        {running ? (
          <button className="btn-danger" onClick={cancel} title="Cancel the running query">
            <Square size={12} fill="currentColor" /> Cancel
          </button>
        ) : (
          <button className="btn-primary" onClick={runCurrent} title="Run statement at cursor or selection (Ctrl+Enter)">
            <Play size={13} fill="currentColor" /> Run
          </button>
        )}
        <button className="btn-outline" onClick={runAll} disabled={running} title="Run the whole script (Ctrl+Shift+Enter / F5)">
          Run all
        </button>
        <DropdownButton
          className="btn-ghost"
          title="Show the query plan"
          label={
            <>
              <Zap size={13} /> Explain <ChevronDown size={12} />
            </>
          }
          items={[
            { label: "Explain", hint: "plan only", onClick: () => explain(false) },
            { label: "Explain analyze", hint: "runs the query", onClick: () => explain(true) },
          ]}
        />
        <div className="mx-1 h-5 w-px bg-border" />
        <DropdownButton
          className="btn-ghost max-w-[260px]"
          title="Database for this tab"
          label={
            <>
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: conn?.color ?? "var(--faint)" }} />
              <span className="truncate">{conn?.name}</span>
              <span className="text-faint">/</span>
              <Database size={12} className="shrink-0" />
              <span className="truncate">{tab.database}</span>
              <ChevronDown size={12} className="shrink-0" />
            </>
          }
          items={(databases ?? [tab.database]).map((d) => ({
            label: d,
            icon: d === tab.database ? <span className="text-accent">●</span> : undefined,
            onClick: () => void switchDatabase(d),
          }))}
        />
        {inTransaction && (
          <div className="ml-1 flex items-center gap-1 rounded-md bg-warn-soft py-0.5 pr-0.5 pl-2 text-[12px] text-warn">
            Transaction open
            <button
              className="btn-ghost h-6 text-warn"
              onClick={() => void execute([{ text: "COMMIT", from: -1, to: -1 }])}
            >
              Commit
            </button>
            <button
              className="btn-ghost h-6 text-warn"
              onClick={() => void execute([{ text: "ROLLBACK", from: -1, to: -1 }])}
            >
              Rollback
            </button>
          </div>
        )}
        {running && (
          <span className="ml-1 text-muted">
            <Spinner size={12} />
          </span>
        )}
        <div className="flex-1" />
        <DropdownButton
          className="btn-ghost text-[12px]"
          title="Maximum rows to fetch per result"
          label={
            <>
              Limit {formatCount(rowLimit)} <ChevronDown size={12} />
            </>
          }
          items={ROW_LIMITS.map((n) => ({
            label: `${formatCount(n)} rows`,
            icon: n === rowLimit ? <span className="text-accent">●</span> : undefined,
            onClick: () => setRowLimit(n),
          }))}
        />
        <button className="btn-ghost" title="Query history" onClick={() => setHistoryOpen(true)}>
          <History size={14} />
        </button>
        <button className="btn-ghost" title="Open .sql file" onClick={() => void openFile()}>
          <FolderOpen size={14} />
        </button>
        <button className="btn-ghost" title="Save to file (Ctrl+S)" onClick={() => void saveFile()}>
          <Save size={14} />
        </button>
      </div>
      <Group orientation="vertical" className="min-h-0 flex-1">
        <Panel defaultSize="45%" minSize="80px">
          <SqlEditor
            value={tab.sql}
            onChange={onChange}
            schema={completion}
            onRun={runCurrent}
            onRunAll={runAll}
            onSave={() => void saveFile()}
            autoFocus={active}
            onCreate={(v) => (viewRef.current = v)}
          />
        </Panel>
        <Separator className="h-px" />
        <Panel minSize="100px">
          <QueryResults
            outcome={outcome}
            running={running}
            runStarted={runStarted}
            onCancel={cancel}
            onJumpToError={markError}
          />
        </Panel>
      </Group>
    </div>
  );
}
