import {
  ChevronDown,
  Code2,
  Copy,
  Download,
  Hash,
  Info,
  KeyRound,
  PanelRight,
  Plus,
  RefreshCw,
  Rows3,
  TableProperties,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { api, DbError, type StatementResult } from "../lib/api";
import { copyAs, exportToFile } from "../lib/export";
import * as meta from "../lib/meta";
import {
  formatBytes,
  formatCount,
  formatDuration,
  isNumericType,
  normalizeInput,
  qualified,
  quoteIdent,
  quoteLiteral,
} from "../lib/sql";
import { metaSession, useApp, type TableTab as TableTabT } from "../store";
import { CellInspector, type InspectedCell } from "./CellInspector";
import { DataGrid, type DataGridHandle, type GridCol, type RowState } from "./DataGrid";
import { SqlEditor } from "./SqlEditor";
import { DropdownButton, Modal, Spinner } from "./ui";

const PAGE = 500;
const AUTO_COUNT_LIMIT = 2_000_000;

type View = "data" | "structure" | "ddl";
type Row = (string | null)[];

export function TableTab({ tab }: { tab: TableTabT; active: boolean }) {
  const session = useMemo(() => metaSession(tab.connId, tab.database), [tab.connId, tab.database]);
  const showToast = useApp((s) => s.showToast);
  const openQueryTab = useApp((s) => s.openQueryTab);
  const connectionState = useApp((s) => s.status[tab.connId]?.state);
  const connect = useApp((s) => s.connect);
  const rel = qualified(tab.schema, tab.name);

  const [view, setView] = useState<View>("data");
  const [details, setDetails] = useState<meta.TableDetails | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [rows, setRows] = useState<Row[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [lastQueryMs, setLastQueryMs] = useState<number | null>(null);
  const [count, setCount] = useState<{ value: number; exact: boolean } | null>(null);
  const [counting, setCounting] = useState(false);

  const [filterDraft, setFilterDraft] = useState("");
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<{ col: number; dir: "asc" | "desc" } | null>(null);

  // Pending changes, keyed by loaded-row index.
  const [edits, setEdits] = useState<Map<number, Map<number, string | null>>>(new Map());
  const [newRows, setNewRows] = useState<(string | null | undefined)[][]>([]);
  const [deleted, setDeleted] = useState<Set<number>>(new Set());
  const [preview, setPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [cell, setCell] = useState<{ row: number; col: number } | null>(null);
  const [selectedRows, setSelectedRows] = useState<number[]>([]);
  const [inspector, setInspector] = useState(false);
  const gridRef = useRef<DataGridHandle>(null);
  const loadingRef = useRef(false);
  const generation = useRef(0);

  const isTable = tab.objKind === "r" || tab.objKind === "p" || tab.objKind === "f";
  const pk = details?.primaryKey ?? [];
  const editable = isTable && pk.length > 0;
  const changeCount = [...edits.values()].reduce((a, m) => a + m.size, 0) + newRows.length + deleted.size;

  // ---- loading ----

  const loadDetails = useCallback(async () => {
    setLoadError(null);
    try {
      if (connectionState !== "connected" && !(await connect(tab.connId))) {
        setLoadError("Not connected");
        return;
      }
      setDetails(await meta.tableDetails(session, tab.schema, tab.name));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, tab.schema, tab.name]);

  useEffect(() => {
    void loadDetails();
  }, [loadDetails]);

  const selectSql = useCallback(
    (limit: number, offset: number) => {
      if (!details) return "";
      const cols = details.columns.map((c) => quoteIdent(c.name)).join(", ");
      let sql = `SELECT ${cols} FROM ${rel}`;
      if (filter.trim()) sql += ` WHERE ${filter}`;
      if (sort) sql += ` ORDER BY ${quoteIdent(details.columns[sort.col].name)} ${sort.dir.toUpperCase()} NULLS LAST`;
      else if (pk.length) sql += ` ORDER BY ${pk.map(quoteIdent).join(", ")}`;
      sql += ` LIMIT ${limit}`;
      if (offset) sql += ` OFFSET ${offset}`;
      return sql;
    },
    [details, rel, filter, sort, pk],
  );

  const fetchRows = useCallback(
    async (offset: number, limit: number): Promise<{ rows: Row[]; more: boolean; ms: number } | null> => {
      const [res] = await api.run(session, [selectSql(limit + 1, offset)], limit + 1);
      if (res?.error) throw new DbError(res.error);
      const got = res?.rows ?? [];
      return { rows: got.slice(0, limit), more: got.length > limit, ms: res?.durationMs ?? 0 };
    },
    [session, selectSql],
  );

  const reload = useCallback(
    async (keep = 0) => {
      if (!details) return;
      const gen = ++generation.current;
      loadingRef.current = true;
      setLoading(true);
      try {
        const r = await fetchRows(0, Math.max(PAGE, keep));
        if (!r || gen !== generation.current) return;
        setRows(r.rows);
        setHasMore(r.more);
        setLastQueryMs(r.ms);
        setLoadError(null);
        // A new filter/sort starts at the top; a reload after saving keeps the position.
        if (!keep) gridRef.current?.scrollToRow(0);
      } catch (e) {
        if (gen === generation.current) {
          setRows([]);
          setHasMore(false);
          setLoadError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (gen === generation.current) {
          loadingRef.current = false;
          setLoading(false);
        }
      }
    },
    [details, fetchRows],
  );

  const runCount = useCallback(async () => {
    setCounting(true);
    try {
      const n = await meta.exactCount(session, rel, filter);
      setCount({ value: n, exact: true });
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setCounting(false);
    }
  }, [session, rel, filter, showToast]);

  // Reload when the table, filter or sort changes.
  useEffect(() => {
    if (!details) return;
    void reload();
    // Start from the planner's estimate; count exactly when that's cheap.
    setCount(filter.trim() ? null : { value: details.estimate, exact: false });
    if (details.estimate < AUTO_COUNT_LIMIT) void runCount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [details, filter, sort]);

  const loadMore = useCallback(async () => {
    if (loadingRef.current || !hasMore || !details) return;
    loadingRef.current = true;
    setLoading(true);
    const gen = generation.current;
    try {
      const r = await fetchRows(rows.length, PAGE);
      if (!r || gen !== generation.current) return;
      setRows((prev) => [...prev, ...r.rows]);
      setHasMore(r.more);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), "error");
      setHasMore(false);
    } finally {
      if (gen === generation.current) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }, [hasMore, details, fetchRows, rows.length, showToast]);

  // ---- grid plumbing ----

  const columns: GridCol[] = useMemo(
    () =>
      (details?.columns ?? []).map((c) => ({
        name: c.name,
        typeName: c.typeName,
        typeLabel: c.type,
        pk: c.pkOrdinal !== null,
      })),
    [details],
  );

  const getValue = useCallback(
    (r: number, c: number): string | null => {
      if (r >= rows.length) return newRows[r - rows.length]?.[c] ?? null;
      const e = edits.get(r);
      if (e?.has(c)) return e.get(c)!;
      return rows[r]?.[c] ?? null;
    },
    [rows, newRows, edits],
  );

  const isEdited = useCallback(
    (r: number, c: number) => (r >= rows.length ? newRows[r - rows.length]?.[c] !== undefined : !!edits.get(r)?.has(c)),
    [rows.length, newRows, edits],
  );

  const rowState = useCallback(
    (r: number): RowState => (r >= rows.length ? "new" : deleted.has(r) ? "deleted" : undefined),
    [rows.length, deleted],
  );

  const setCellValue = useCallback(
    (r: number, c: number, raw: string | null) => {
      const col = details?.columns[c];
      if (!col) return;
      if (col.generated === "s" || col.identity === "a") {
        showToast(`"${col.name}" is generated by the database and can't be edited`, "info");
        return;
      }
      const value = raw === null ? null : normalizeInput(raw, col.typeName);
      if (r >= rows.length) {
        const i = r - rows.length;
        setNewRows((prev) => prev.map((row, j) => (j === i ? row.map((v, k) => (k === c ? value : v)) : row)));
        return;
      }
      setEdits((prev) => {
        const next = new Map(prev);
        const m = new Map(next.get(r) ?? []);
        if (value === rows[r][c]) m.delete(c);
        else m.set(c, value);
        if (m.size) next.set(r, m);
        else next.delete(r);
        return next;
      });
    },
    [details, rows, showToast],
  );

  const addRow = () => {
    if (!details) return;
    setNewRows((prev) => [...prev, details.columns.map(() => undefined)]);
    setTimeout(() => gridRef.current?.scrollToRow(rows.length + newRows.length), 30);
  };

  const deleteSelected = () => {
    const sel = selectedRows.length ? selectedRows : cell ? [cell.row] : [];
    if (!sel.length) return;
    const newIdx = new Set(sel.filter((r) => r >= rows.length).map((r) => r - rows.length));
    if (newIdx.size) setNewRows((prev) => prev.filter((_, i) => !newIdx.has(i)));
    setDeleted((prev) => {
      const next = new Set(prev);
      const existing = sel.filter((r) => r < rows.length);
      // Toggle: deleting already-deleted rows restores them.
      const allDeleted = existing.every((r) => next.has(r));
      for (const r of existing) allDeleted ? next.delete(r) : next.add(r);
      return next;
    });
  };

  const discard = () => {
    setEdits(new Map());
    setNewRows([]);
    setDeleted(new Set());
  };

  // ---- saving ----

  const buildChangeSql = (): string[] => {
    if (!details) return [];
    const cols = details.columns;
    // Numbers read better unquoted; everything else is a typed literal Postgres coerces.
    const lit = (c: number, v: string | null) =>
      v !== null && isNumericType(cols[c].typeName) && /^-?\d+(\.\d+)?$/.test(v) ? v : quoteLiteral(v);
    const where = (r: number) =>
      pk
        .map((name) => {
          const idx = cols.findIndex((c) => c.name === name);
          const v = rows[r][idx];
          return v === null ? `${quoteIdent(name)} IS NULL` : `${quoteIdent(name)} = ${lit(idx, v)}`;
        })
        .join(" AND ");
    const out: string[] = [];
    for (const r of [...deleted].sort((a, b) => a - b)) out.push(`DELETE FROM ${rel} WHERE ${where(r)};`);
    for (const [r, m] of [...edits.entries()].sort((a, b) => a[0] - b[0])) {
      if (deleted.has(r)) continue;
      const sets = [...m.entries()].map(([c, v]) => `${quoteIdent(cols[c].name)} = ${lit(c, v)}`);
      out.push(`UPDATE ${rel} SET ${sets.join(", ")} WHERE ${where(r)};`);
    }
    for (const row of newRows) {
      const idx = row.map((v, i) => (v === undefined ? -1 : i)).filter((i) => i >= 0);
      if (!idx.length) out.push(`INSERT INTO ${rel} DEFAULT VALUES;`);
      else
        out.push(
          `INSERT INTO ${rel} (${idx.map((i) => quoteIdent(cols[i].name)).join(", ")}) VALUES (${idx
            .map((i) => lit(i, row[i] ?? null))
            .join(", ")});`,
        );
    }
    return out;
  };

  const save = async () => {
    const stmts = buildChangeSql();
    if (!stmts.length) return;
    setSaving(true);
    try {
      const counts = await api.executeAtomic(session, stmts.join("\n"));
      const missed = stmts.filter((s, i) => !s.startsWith("INSERT") && counts[i] === 0).length;
      showToast(
        missed
          ? `Saved, but ${missed} row(s) were not found — they may have been changed by someone else`
          : `Saved ${stmts.length} change${stmts.length === 1 ? "" : "s"}`,
        missed ? "error" : "ok",
      );
      discard();
      setPreview(null);
      await reload(rows.length);
      if (newRows.length || deleted.size) void runCount();
    } catch (e) {
      const info = e instanceof DbError ? e.info : null;
      showToast(`Nothing was saved: ${info?.message ?? String(e)}${info?.detail ? ` — ${info.detail}` : ""}`, "error");
    } finally {
      setSaving(false);
    }
  };

  // Ctrl+S saves, Delete marks rows, scoped to this tab while it's focused.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    const typing = target.tagName === "INPUT" || target.tagName === "TEXTAREA";
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (changeCount) setPreview(buildChangeSql().join("\n"));
    } else if (e.key === "Delete" && editable && !typing && selectedRows.length) {
      e.preventDefault();
      deleteSelected();
    } else if (e.key === "F5" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r")) {
      e.preventDefault();
      if (!changeCount) void reload();
    }
  };

  const inspected: InspectedCell | null =
    cell && details?.columns[cell.col]
      ? {
          column: details.columns[cell.col].name,
          typeName: details.columns[cell.col].typeName,
          typeLabel: details.columns[cell.col].type,
          value: getValue(cell.row, cell.col),
          editable: editable && rowState(cell.row) !== "deleted",
        }
      : null;

  const exportAll = async (format: "csv" | "json") => {
    if (!details) return;
    showToast("Fetching all rows…", "info");
    const [res]: StatementResult[] = await api.run(session, [selectSql(10_000_000, 0)], 10_000_000);
    if (res.error) return showToast(res.error.message, "error");
    const p = await exportToFile({ columns: columns, rows: res.rows }, format, tab.name);
    if (p) showToast(`Exported ${formatCount(res.rows.length)} rows to ${p}`, "ok");
  };

  // ---- render ----

  return (
    <div className="flex h-full flex-col" onKeyDown={onKeyDown}>
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border bg-panel px-2.5">
        <div className="flex rounded-md border border-border p-0.5">
          {(
            [
              ["data", "Data", <Rows3 size={13} key="d" />],
              ["structure", "Structure", <TableProperties size={13} key="s" />],
              ["ddl", "DDL", <Code2 size={13} key="c" />],
            ] as const
          ).map(([v, label, icon]) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`flex h-6 items-center gap-1.5 rounded px-2.5 text-[12px] ${
                view === v ? "bg-hover font-medium text-text" : "text-muted hover:text-text"
              }`}
            >
              {icon}
              {label}
            </button>
          ))}
        </div>
        {view === "data" && (
          <>
            <form
              className="ml-1 flex h-7 max-w-[560px] min-w-[200px] flex-1 items-center rounded-md border border-border bg-bg focus-within:border-accent"
              onSubmit={(e) => {
                e.preventDefault();
                if (changeCount) return showToast("Save or discard your changes first", "info");
                setFilter(filterDraft);
              }}
            >
              <span className="pr-1 pl-2.5 font-mono text-[11.5px] font-semibold text-accent">WHERE</span>
              <input
                className="selectable h-full min-w-0 flex-1 bg-transparent font-mono text-[12.5px] outline-none placeholder:text-faint"
                placeholder="status = 'active' AND created_at > now() - interval '7 days'"
                spellCheck={false}
                value={filterDraft}
                onChange={(e) => setFilterDraft(e.target.value)}
              />
              {(filterDraft || filter) && (
                <button
                  type="button"
                  className="px-2 text-faint hover:text-text"
                  title="Clear filter"
                  onClick={() => {
                    setFilterDraft("");
                    setFilter("");
                  }}
                >
                  <X size={13} />
                </button>
              )}
            </form>
            <button className="btn-ghost" title="Reload (F5)" onClick={() => void reload()} disabled={!!changeCount}>
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            </button>
            {editable && (
              <>
                <button className="btn-ghost" title="Add row" onClick={addRow}>
                  <Plus size={14} /> Row
                </button>
                <button
                  className="btn-ghost"
                  title="Mark selected rows for deletion (Delete)"
                  disabled={!selectedRows.length && !cell}
                  onClick={deleteSelected}
                >
                  <Trash2 size={14} />
                </button>
              </>
            )}
            {!editable && details && isTable && (
              <span
                className="flex items-center gap-1 text-[12px] text-faint"
                title="Rows can only be edited safely in tables with a primary key"
              >
                <Info size={13} /> Read-only (no primary key)
              </span>
            )}
            {!isTable && <span className="text-[12px] text-faint">{meta.KIND_LABEL[tab.objKind]} · read-only</span>}
            <div className="flex-1" />
            {changeCount > 0 && (
              <div className="flex items-center gap-1 rounded-md bg-warn-soft py-0.5 pr-0.5 pl-2.5 text-[12px] text-warn">
                {changeCount} pending
                <button className="btn-ghost h-6 text-warn" onClick={discard} title="Discard all changes">
                  <Undo2 size={13} /> Discard
                </button>
                <button
                  className="btn-primary h-6"
                  onClick={() => setPreview(buildChangeSql().join("\n"))}
                  title="Review and save (Ctrl+S)"
                >
                  Save…
                </button>
              </div>
            )}
            <DropdownButton
              className="btn-ghost"
              title="Export"
              label={
                <>
                  <Download size={14} />
                  <ChevronDown size={12} />
                </>
              }
              items={[
                {
                  label: "Loaded rows as CSV…",
                  onClick: () =>
                    void exportToFile({ columns, rows }, "csv", tab.name).then((p) => p && showToast(`Saved ${p}`, "ok")),
                },
                {
                  label: "Loaded rows as JSON…",
                  onClick: () =>
                    void exportToFile({ columns, rows }, "json", tab.name).then((p) => p && showToast(`Saved ${p}`, "ok")),
                },
                { label: "All rows as CSV…", onClick: () => void exportAll("csv") },
                { label: "All rows as JSON…", onClick: () => void exportAll("json") },
                "separator",
                {
                  label: "Copy loaded rows as INSERTs",
                  onClick: () => void copyAs({ columns, rows }, "insert", rel).then(() => showToast("Copied", "ok")),
                },
              ]}
            />
            <button
              className={`btn-ghost ${inspector ? "text-accent" : ""}`}
              title="Value panel"
              onClick={() => setInspector((v) => !v)}
            >
              <PanelRight size={14} />
            </button>
          </>
        )}
        {view !== "data" && <div className="flex-1" />}
      </div>

      <div className="min-h-0 flex-1">
        {!details && !loadError && (
          <div className="flex h-full items-center justify-center text-muted">
            <Spinner />
          </div>
        )}
        {loadError && (
          <div className="m-4 rounded-lg border border-danger/30 bg-danger-soft p-3 font-mono text-[12.5px]">
            <span className="font-semibold text-danger">ERROR</span>: {loadError}
            {filter && (
              <button
                className="ml-3 font-sans text-accent hover:underline"
                onClick={() => {
                  setFilter("");
                  setFilterDraft("");
                }}
              >
                Clear filter
              </button>
            )}
          </div>
        )}
        {details && view === "data" && !loadError && (
          <Group orientation="horizontal" className="h-full">
            <Panel minSize="200px">
              <DataGrid
                ref={gridRef}
                columns={columns}
                rowCount={rows.length + newRows.length}
                getValue={getValue}
                isEdited={isEdited}
                rowState={rowState}
                editable={editable}
                onCellEdited={setCellValue}
                onSelect={(c, sel) => {
                  setCell(c);
                  setSelectedRows(sel);
                }}
                onNearEnd={hasMore ? () => void loadMore() : undefined}
                sort={sort}
                onHeaderClick={(col) => {
                  if (changeCount) return showToast("Save or discard your changes first", "info");
                  setSort((s) =>
                    s?.col !== col ? { col, dir: "asc" } : s.dir === "asc" ? { col, dir: "desc" } : null,
                  );
                }}
              />
            </Panel>
            {inspector && (
              <>
                <Separator className="w-px" />
                <Panel defaultSize="30%" minSize="200px">
                  <CellInspector
                    cell={inspected}
                    onClose={() => setInspector(false)}
                    onApply={(v) => cell && setCellValue(cell.row, cell.col, v)}
                  />
                </Panel>
              </>
            )}
          </Group>
        )}
        {details && view === "structure" && <Structure details={details} />}
        {details && view === "ddl" && (
          <Ddl
            sql={meta.tableDdl(tab.schema, tab.name, details)}
            onOpen={(sql) => openQueryTab(tab.connId, tab.database, sql, `${tab.name}.sql`)}
          />
        )}
      </div>

      {view === "data" && details && (
        <div className="flex h-7 shrink-0 items-center gap-3 border-t border-border bg-panel px-3 text-[11.5px] text-muted">
          <span>
            {formatCount(rows.length)} loaded
            {count && (
              <>
                {" "}
                of {count.exact ? "" : "~"}
                {formatCount(count.value)} rows
              </>
            )}
            {hasMore && !loading && <span className="text-faint"> · scroll for more</span>}
          </span>
          {(!count || !count.exact) && (
            <button className="text-accent hover:underline" onClick={() => void runCount()} disabled={counting}>
              {counting ? "Counting…" : "Exact count"}
            </button>
          )}
          {loading && <Spinner size={11} />}
          <div className="flex-1" />
          {pk.length > 0 && (
            <span className="flex items-center gap-1">
              <KeyRound size={11} /> {pk.join(", ")}
            </span>
          )}
          {lastQueryMs !== null && <span>{formatDuration(lastQueryMs)}</span>}
          <span>{formatBytes(details.totalSize)}</span>
        </div>
      )}

      {preview !== null && (
        <Modal
          title="Review changes"
          width={760}
          onClose={() => setPreview(null)}
          footer={
            <>
              <span className="mr-auto text-[12px] text-muted">Runs in a single transaction: all or nothing.</span>
              <button className="btn-outline" onClick={() => setPreview(null)}>
                Back
              </button>
              <button className="btn-primary" onClick={() => void save()} disabled={saving}>
                {saving && <Spinner size={12} />} Commit {changeCount} change{changeCount === 1 ? "" : "s"}
              </button>
            </>
          }
        >
          <div className="h-[340px] border-b border-border">
            <SqlEditor value={preview} readOnly />
          </div>
        </Modal>
      )}
    </div>
  );
}

function Structure({ details }: { details: meta.TableDetails }) {
  const th = "px-3 py-2 text-left text-[11.5px] font-semibold uppercase tracking-wide text-faint";
  const td = "px-3 py-1.5 align-top";
  return (
    <div className="selectable h-full overflow-auto p-4">
      <div className="mb-4 flex flex-wrap gap-2 text-[12px]">
        <Pill label="Type" value={meta.KIND_LABEL[details.kind]} />
        <Pill label="Rows (est.)" value={formatCount(details.estimate)} />
        <Pill label="Total size" value={formatBytes(details.totalSize)} />
        {details.comment && <Pill label="Comment" value={details.comment} />}
      </div>
      <Section title="Columns" count={details.columns.length}>
        <table className="w-full border-collapse text-[12.5px]">
          <thead>
            <tr className="border-b border-border">
              <th className={th}>#</th>
              <th className={th}>Name</th>
              <th className={th}>Type</th>
              <th className={th}>Nullable</th>
              <th className={th}>Default</th>
              <th className={th}>Comment</th>
            </tr>
          </thead>
          <tbody>
            {details.columns.map((c, i) => (
              <tr key={c.name} className="border-b border-border/60 hover:bg-hover/50">
                <td className={`${td} text-faint`}>{i + 1}</td>
                <td className={`${td} font-medium`}>
                  <span className="inline-flex items-center gap-1.5">
                    {c.pkOrdinal !== null && <KeyRound size={12} className="text-warn" />}
                    {c.name}
                  </span>
                </td>
                <td className={`${td} font-mono text-[12px] text-accent`}>{c.type}</td>
                <td className={td}>{c.notNull ? <span className="text-faint">not null</span> : "yes"}</td>
                <td className={`${td} font-mono text-[12px] text-muted`}>
                  {c.identity ? `identity (${c.identity === "a" ? "always" : "by default"})` : c.generated === "s" ? `generated: ${c.default}` : c.default}
                </td>
                <td className={`${td} text-muted`}>{c.comment}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      {details.indexes.length > 0 && (
        <Section title="Indexes" count={details.indexes.length}>
          {details.indexes.map((i) => (
            <Def key={i.name} name={i.name} badge={i.primary ? "primary" : i.unique ? "unique" : undefined} extra={formatBytes(i.size)}>
              {i.definition}
            </Def>
          ))}
        </Section>
      )}
      {details.constraints.filter((c) => c.type !== "n").length > 0 && (
        <Section title="Constraints" count={details.constraints.filter((c) => c.type !== "n").length}>
          {details.constraints
            .filter((c) => c.type !== "n")
            .map((c) => (
              <Def key={c.name} name={c.name} badge={CONSTRAINT_LABEL[c.type] ?? c.type}>
                {c.definition}
              </Def>
            ))}
        </Section>
      )}
      {details.triggers.length > 0 && (
        <Section title="Triggers" count={details.triggers.length}>
          {details.triggers.map((t) => (
            <Def key={t.name} name={t.name}>
              {t.definition}
            </Def>
          ))}
        </Section>
      )}
    </div>
  );
}

const CONSTRAINT_LABEL: Record<string, string> = {
  p: "primary key",
  u: "unique",
  f: "foreign key",
  c: "check",
  x: "exclusion",
  t: "trigger",
};

function Pill({ label, value }: { label: string; value: string }) {
  return (
    <span className="rounded-md border border-border bg-panel px-2.5 py-1">
      <span className="text-faint">{label}</span> <span className="font-medium">{value}</span>
    </span>
  );
}

function Section(props: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div className="mb-5 overflow-hidden rounded-lg border border-border bg-panel">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-[12.5px] font-semibold">
        <Hash size={13} className="text-faint" />
        {props.title}
        <span className="font-normal text-faint">{props.count}</span>
      </div>
      {props.children}
    </div>
  );
}

function Def(props: { name: string; badge?: string; extra?: string; children: string }) {
  return (
    <div className="border-b border-border/60 px-3 py-2 last:border-0">
      <div className="flex items-center gap-2 text-[12.5px]">
        <span className="font-medium">{props.name}</span>
        {props.badge && <span className="rounded bg-accent-soft px-1.5 py-px text-[11px] text-accent">{props.badge}</span>}
        {props.extra && <span className="ml-auto text-[11.5px] text-faint">{props.extra}</span>}
      </div>
      <div className="mt-0.5 font-mono text-[12px] text-muted">{props.children}</div>
    </div>
  );
}

function Ddl({ sql, onOpen }: { sql: string; onOpen: (sql: string) => void }) {
  const showToast = useApp((s) => s.showToast);
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 gap-2 border-b border-border px-3 py-2">
        <button className="btn-outline" onClick={() => onOpen(sql)}>
          <Code2 size={13} /> Open in query tab
        </button>
        <button
          className="btn-ghost"
          onClick={() => void navigator.clipboard.writeText(sql).then(() => showToast("Copied", "ok"))}
        >
          <Copy size={13} /> Copy
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <SqlEditor value={sql} readOnly />
      </div>
    </div>
  );
}
