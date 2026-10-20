import { AlertCircle, CheckCircle2, ChevronDown, Download, PanelRight, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import type { StatementResult } from "../lib/api";
import { copyAs, exportToFile } from "../lib/export";
import { firstKeyword, formatCount, formatDuration } from "../lib/sql";
import { useApp } from "../store";
import { CellInspector, type InspectedCell } from "./CellInspector";
import { DataGrid } from "./DataGrid";
import { DropdownButton, Spinner } from "./ui";

export interface RunOutcome {
  results: StatementResult[];
  statements: string[];
  startedAt: number;
}

export function QueryResults(props: {
  outcome: RunOutcome | null;
  running: boolean;
  runStarted: number | null;
  onCancel: () => void;
  onJumpToError: (statement: number, position: number | null) => void;
}) {
  const { outcome, running } = props;
  const sets = useMemo(() => (outcome?.results ?? []).filter((r) => r.columns), [outcome]);
  const hasError = !!outcome?.results.some((r) => r.error);
  const [active, setActive] = useState<number | "messages">("messages");
  const [cell, setCell] = useState<{ row: number; col: number } | null>(null);
  const [inspector, setInspector] = useState(false);
  const showToast = useApp((s) => s.showToast);

  useEffect(() => {
    setCell(null);
    if (!outcome) return;
    if (hasError || sets.length === 0) setActive("messages");
    else setActive(sets.length - 1);
  }, [outcome, hasError, sets.length]);

  const current = typeof active === "number" ? sets[active] : undefined;
  const columns = useMemo(
    () => (current?.columns ?? []).map((c) => ({ name: c.name, typeName: c.typeName, typeLabel: c.typeName })),
    [current],
  );
  const getValue = useCallback((r: number, c: number) => current?.rows[r]?.[c] ?? null, [current]);

  const inspected: InspectedCell | null =
    current && cell && current.columns?.[cell.col]
      ? {
          column: current.columns[cell.col].name,
          typeName: current.columns[cell.col].typeName,
          typeLabel: current.columns[cell.col].typeName,
          value: current.rows[cell.row]?.[cell.col] ?? null,
          editable: false,
        }
      : null;

  if (running && !outcome) {
    return <RunningBanner started={props.runStarted} onCancel={props.onCancel} />;
  }
  if (!outcome) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-faint">
        <div className="text-[13px]">Run a query to see results</div>
        <div className="flex gap-3 text-[12px]">
          <span>
            <span className="kbd">Ctrl</span> + <span className="kbd">Enter</span> run statement
          </span>
          <span>
            <span className="kbd">Ctrl</span> + <span className="kbd">Shift</span> + <span className="kbd">Enter</span> run all
          </span>
        </div>
      </div>
    );
  }

  const exportData = current ? { columns: current.columns ?? [], rows: current.rows } : null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-panel px-2">
        {sets.map((r, i) => (
          <button
            key={i}
            onClick={() => setActive(i)}
            className={`h-7 rounded-md px-2.5 text-[12px] ${
              active === i ? "bg-hover font-medium text-text" : "text-muted hover:text-text"
            }`}
          >
            {sets.length > 1 ? `Result ${i + 1}` : "Result"}
            <span className="ml-1.5 text-faint">{formatCount(r.rowCount)}</span>
          </button>
        ))}
        <button
          onClick={() => setActive("messages")}
          className={`flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] ${
            active === "messages" ? "bg-hover font-medium text-text" : "text-muted hover:text-text"
          }`}
        >
          {hasError && <AlertCircle size={13} className="text-danger" />}
          Messages
        </button>
        <div className="flex-1" />
        {running && (
          <span className="flex items-center gap-2 pr-2 text-[12px] text-muted">
            <Spinner size={12} /> Running…
            <button className="btn-outline h-6" onClick={props.onCancel}>
              Cancel
            </button>
          </span>
        )}
        {current && (
          <>
            <span className="pr-2 text-[12px] text-muted">
              {formatCount(current.rowCount)} {current.rowCount === 1 ? "row" : "rows"} · {formatDuration(current.durationMs)}
            </span>
            {current.truncated && (
              <span
                className="mr-2 flex items-center gap-1 rounded bg-warn-soft px-1.5 py-0.5 text-[11.5px] text-warn"
                title="Raise the row limit in the toolbar to fetch more"
              >
                <TriangleAlert size={12} /> showing first {formatCount(current.rows.length)}
              </span>
            )}
            <DropdownButton
              className="btn-ghost h-7"
              label={
                <>
                  <Download size={13} /> Export <ChevronDown size={12} />
                </>
              }
              items={[
                {
                  label: "Save as CSV…",
                  onClick: () =>
                    exportData &&
                    exportToFile(exportData, "csv", "result").then((p) => p && showToast(`Saved ${p}`, "ok")),
                },
                {
                  label: "Save as JSON…",
                  onClick: () =>
                    exportData &&
                    exportToFile(exportData, "json", "result").then((p) => p && showToast(`Saved ${p}`, "ok")),
                },
                "separator",
                {
                  label: "Copy as TSV (for Excel)",
                  onClick: () => exportData && copyAs(exportData, "tsv").then(() => showToast("Copied", "ok")),
                },
                {
                  label: "Copy as JSON",
                  onClick: () => exportData && copyAs(exportData, "json").then(() => showToast("Copied", "ok")),
                },
                {
                  label: "Copy as INSERT statements",
                  onClick: () => exportData && copyAs(exportData, "insert").then(() => showToast("Copied", "ok")),
                },
              ]}
            />
            <button
              className={`btn-ghost h-7 ${inspector ? "text-accent" : ""}`}
              title="Value panel"
              onClick={() => setInspector((v) => !v)}
            >
              <PanelRight size={14} />
            </button>
          </>
        )}
      </div>
      <div className="min-h-0 flex-1">
        {active === "messages" || !current ? (
          <Messages outcome={outcome} onJumpToError={props.onJumpToError} />
        ) : (
          <Group orientation="horizontal" className="h-full">
            <Panel minSize="200px">
              <DataGrid
                columns={columns}
                rowCount={current.rows.length}
                getValue={getValue}
                onSelect={(c) => {
                  setCell(c);
                }}
              />
            </Panel>
            {inspector && (
              <>
                <Separator className="w-px" />
                <Panel defaultSize="30%" minSize="180px">
                  <CellInspector cell={inspected} onClose={() => setInspector(false)} />
                </Panel>
              </>
            )}
          </Group>
        )}
      </div>
    </div>
  );
}

function RunningBanner(props: { started: number | null; onCancel: () => void }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 100);
    return () => clearInterval(t);
  }, []);
  const elapsed = props.started ? Date.now() - props.started : 0;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-muted">
      <div className="flex items-center gap-2 text-[13px]">
        <Spinner /> Running… <span className="tabular-nums text-faint">{formatDuration(elapsed)}</span>
      </div>
      <button className="btn-outline" onClick={props.onCancel}>
        Cancel query
      </button>
    </div>
  );
}

function Messages(props: { outcome: RunOutcome; onJumpToError: (statement: number, position: number | null) => void }) {
  const { outcome } = props;
  const total = outcome.results.reduce((a, r) => a + r.durationMs, 0);
  const skipped = outcome.statements.length - (outcome.results.at(-1)?.statement ?? -1) - 1;
  return (
    <div className="selectable h-full overflow-auto p-3 font-mono text-[12.5px]">
      {outcome.results.map((r, i) => {
        const stmt = outcome.statements[r.statement] ?? "";
        const kw = firstKeyword(stmt) || "Statement";
        return (
          <div key={i} className="mb-2.5">
            <div className="flex items-start gap-2">
              {r.error ? (
                <AlertCircle size={14} className="mt-0.5 shrink-0 text-danger" />
              ) : (
                <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-ok" />
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-muted" title={stmt}>
                  {stmt.replace(/\s+/g, " ").slice(0, 160)}
                </div>
                {r.error ? (
                  <div className="mt-1 rounded-md border border-danger/30 bg-danger-soft p-2.5 text-text">
                    <div>
                      <span className="font-semibold text-danger">ERROR</span>
                      {r.error.code && <span className="text-faint"> [{r.error.code}]</span>}: {r.error.message}
                    </div>
                    {r.error.detail && <div className="mt-1 text-muted">DETAIL: {r.error.detail}</div>}
                    {r.error.hint && <div className="mt-1 text-muted">HINT: {r.error.hint}</div>}
                    <button
                      className="mt-1.5 font-sans text-[12px] text-accent hover:underline"
                      onClick={() => props.onJumpToError(r.statement, r.error?.position ?? null)}
                    >
                      Show in editor
                    </button>
                  </div>
                ) : (
                  <div className="text-text">
                    {kw}
                    {r.columns
                      ? ` · ${formatCount(r.rowCount)} ${r.rowCount === 1 ? "row" : "rows"} returned`
                      : r.affected != null && ["INSERT", "UPDATE", "DELETE", "MERGE", "COPY"].includes(kw)
                        ? ` · ${formatCount(r.affected)} ${r.affected === 1 ? "row" : "rows"} affected`
                        : " · OK"}
                    <span className="text-faint"> · {formatDuration(r.durationMs)}</span>
                  </div>
                )}
                {r.notices.map((n, j) => (
                  <div key={j} className="mt-1 text-warn">
                    {n}
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })}
      {skipped > 0 && <div className="text-faint">{skipped} remaining statement(s) not run because of the error.</div>}
      <div className="mt-3 border-t border-border pt-2 text-faint">
        {outcome.statements.length} statement(s) · total {formatDuration(total)}
      </div>
    </div>
  );
}
