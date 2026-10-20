import DataEditor, {
  CompactSelection,
  GridCellKind,
  type DrawHeaderCallback,
  type EditableGridCell,
  type GridCell,
  type GridColumn,
  type GridSelection,
  type Item,
  type Rectangle,
  type Theme,
} from "@glideapps/glide-data-grid";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { displayValue, isBoolType, isJsonType, isNumericType } from "../lib/sql";
import { useApp } from "../store";

export interface GridCol {
  name: string;
  typeName?: string | null;
  /** Shown faintly next to the name, e.g. "int4" or "varchar(40)". */
  typeLabel?: string | null;
  pk?: boolean;
}

export type RowState = "new" | "deleted" | undefined;

export interface DataGridProps {
  columns: GridCol[];
  rowCount: number;
  getValue: (row: number, col: number) => string | null;
  isEdited?: (row: number, col: number) => boolean;
  rowState?: (row: number) => RowState;
  editable?: boolean;
  onCellEdited?: (row: number, col: number, value: string) => void;
  onSelect?: (cell: { row: number; col: number } | null, selectedRows: number[]) => void;
  onNearEnd?: () => void;
  sort?: { col: number; dir: "asc" | "desc" } | null;
  onHeaderClick?: (col: number) => void;
}

export interface DataGridHandle {
  selectedRows(): number[];
  focus(): void;
  scrollToRow(row: number): void;
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function useGridTheme(): { theme: Partial<Theme>; vars: Record<string, string> } {
  const mode = useApp((s) => s.theme);
  return useMemo(() => {
    const v = (n: string) => cssVar(`--${n}`);
    const vars = {
      faint: v("faint"),
      muted: v("muted"),
      warnSoft: v("warn-soft"),
      dangerSoft: v("danger-soft"),
      okSoft: v("ok-soft"),
      accent: v("accent"),
      text: v("text"),
    };
    const theme: Partial<Theme> = {
      accentColor: v("accent"),
      accentFg: v("accent-fg"),
      accentLight: v("accent-soft"),
      textDark: v("text"),
      textMedium: v("muted"),
      textLight: v("faint"),
      textBubble: v("text"),
      bgIconHeader: v("muted"),
      fgIconHeader: v("panel"),
      textHeader: v("text"),
      textHeaderSelected: v("accent-fg"),
      bgCell: v("bg"),
      bgCellMedium: v("panel"),
      bgHeader: v("panel"),
      bgHeaderHasFocus: v("hover"),
      bgHeaderHovered: v("hover"),
      bgBubble: v("panel-2"),
      bgBubbleSelected: v("accent-soft"),
      bgSearchResult: v("warn-soft"),
      borderColor: v("border"),
      horizontalBorderColor: v("border"),
      drilldownBorder: v("border"),
      linkColor: v("accent"),
      cellHorizontalPadding: 10,
      cellVerticalPadding: 4,
      headerFontStyle: "600 12.5px",
      baseFontStyle: "13px",
      markerFontStyle: "11px",
      fontFamily: cssVar("--font-sans") || "Segoe UI, sans-serif",
      editorFontSize: "13px",
      lineHeight: 1.4,
      roundingRadius: 4,
    };
    return { theme, vars };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);
}

const MAX_DISPLAY = 300;

function shortDisplay(v: string | null, typeName?: string | null): string {
  const s = displayValue(v, typeName);
  const oneLine = s.length > MAX_DISPLAY ? s.slice(0, MAX_DISPLAY) + "…" : s;
  return oneLine.replace(/\s*[\r\n]+\s*/g, " ⏎ ");
}

function initialWidth(col: GridCol, sample: (string | null)[]): number {
  const header = col.name.length * 7.6 + (col.typeLabel ? col.typeLabel.length * 6.4 + 12 : 0) + 34;
  let longest = 0;
  for (const v of sample) longest = Math.max(longest, Math.min((v ?? "NULL").length, 60));
  const body = longest * 7.2 + 24;
  return Math.round(Math.min(Math.max(header, body, 70), isJsonType(col.typeName) ? 380 : 320));
}

export const DataGrid = forwardRef<DataGridHandle, DataGridProps>(function DataGrid(props, ref) {
  const { columns, rowCount, getValue, isEdited, rowState, editable, onCellEdited, onSelect, onNearEnd, sort, onHeaderClick } =
    props;
  const { theme, vars } = useGridTheme();
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [selection, setSelection] = useState<GridSelection>({
    columns: CompactSelection.empty(),
    rows: CompactSelection.empty(),
  });
  const [showSearch, setShowSearch] = useState(false);
  const editorRef = useRef<import("@glideapps/glide-data-grid").DataEditorRef>(null);

  // Reset widths and selection when the column set changes (new query result).
  const colKey = columns.map((c) => c.name).join("\u0001");
  useEffect(() => {
    setWidths({});
    setSelection({ columns: CompactSelection.empty(), rows: CompactSelection.empty() });
  }, [colKey]);

  const gridColumns: GridColumn[] = useMemo(() => {
    const sampleRows = Math.min(rowCount, 80);
    return columns.map((c, i) => {
      const sample: (string | null)[] = [];
      for (let r = 0; r < sampleRows; r++) sample.push(getValue(r, i));
      const key = `${i}:${c.name}`;
      return {
        id: key,
        title: c.name,
        width: widths[key] ?? initialWidth(c, sample),
      };
    });
    // Widths are sampled once per column set; getValue changes on every edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns, widths, rowCount > 0]);

  const getCellContent = useCallback(
    ([col, row]: Item): GridCell => {
      const c = columns[col];
      const v = getValue(row, col);
      const state = rowState?.(row);
      const edited = isEdited?.(row, col);
      const canEdit = !!editable && state !== "deleted";
      const themeOverride: Partial<Theme> = {};
      if (v === null) themeOverride.textDark = vars.faint;
      if (edited) themeOverride.bgCell = vars.warnSoft;
      const display = shortDisplay(v, c?.typeName);
      return {
        kind: GridCellKind.Text,
        data: v === null ? "" : isBoolType(c?.typeName) ? display : v,
        displayData: display,
        allowOverlay: true,
        readonly: !canEdit,
        contentAlign: isNumericType(c?.typeName) ? "right" : undefined,
        themeOverride: Object.keys(themeOverride).length ? themeOverride : undefined,
      };
    },
    [columns, getValue, isEdited, rowState, editable, vars],
  );

  const getRowThemeOverride = useCallback(
    (row: number): Partial<Theme> | undefined => {
      const st = rowState?.(row);
      if (st === "deleted") return { bgCell: vars.dangerSoft, textDark: vars.muted };
      if (st === "new") return { bgCell: vars.okSoft };
      return undefined;
    },
    [rowState, vars],
  );

  const handleEdit = useCallback(
    ([col, row]: Item, cell: EditableGridCell) => {
      if (cell.kind !== GridCellKind.Text) return;
      const old = getValue(row, col);
      // Opening and closing the editor on a NULL cell shouldn't turn it into ''.
      if (old === null && cell.data === "") return;
      onCellEdited?.(row, col, cell.data);
    },
    [getValue, onCellEdited],
  );

  const selectedRowsOf = useCallback((sel: GridSelection): number[] => {
    const rows = new Set<number>(sel.rows.toArray());
    if (sel.current) {
      const r = sel.current.range;
      for (let i = r.y; i < r.y + r.height; i++) rows.add(i);
    }
    return [...rows].sort((a, b) => a - b);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      selectedRows: () => selectedRowsOf(selection),
      focus: () => editorRef.current?.focus(),
      scrollToRow: (row: number) => editorRef.current?.scrollTo(0, row),
    }),
    [selection, selectedRowsOf],
  );

  const onSelectionChange = useCallback(
    (sel: GridSelection) => {
      setSelection(sel);
      const cell = sel.current ? { col: sel.current.cell[0], row: sel.current.cell[1] } : null;
      onSelect?.(cell, selectedRowsOf(sel));
    },
    [onSelect, selectedRowsOf],
  );

  const onVisible = useCallback(
    (range: Rectangle) => {
      if (onNearEnd && range.y + range.height >= rowCount - 40) onNearEnd();
    },
    [onNearEnd, rowCount],
  );

  const drawHeader: DrawHeaderCallback = useCallback(
    (args) => {
      const { ctx, rect, columnIndex, theme: t, isSelected } = args;
      const c = columns[columnIndex];
      if (!c) return;
      ctx.save();
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, rect.width, rect.height);
      ctx.clip();
      const pad = 10;
      let x = rect.x + pad;
      const y = rect.y + rect.height / 2;
      ctx.textBaseline = "middle";
      if (c.pk) {
        ctx.fillStyle = "#e7b350";
        ctx.font = `600 10px ${t.fontFamily}`;
        ctx.fillText("PK", x, y + 0.5);
        x += ctx.measureText("PK").width + 6;
      }
      ctx.fillStyle = isSelected ? t.textHeaderSelected : t.textHeader;
      ctx.font = `600 12.5px ${t.fontFamily}`;
      ctx.fillText(c.name, x, y);
      x += ctx.measureText(c.name).width + 6;
      if (c.typeLabel) {
        ctx.fillStyle = isSelected ? t.textHeaderSelected : t.textLight;
        ctx.font = `11px ${t.fontFamily}`;
        ctx.fillText(c.typeLabel, x, y + 0.5);
      }
      if (sort && sort.col === columnIndex) {
        ctx.fillStyle = isSelected ? t.textHeaderSelected : t.accentColor;
        ctx.font = `600 12px ${t.fontFamily}`;
        ctx.fillText(sort.dir === "asc" ? "▲" : "▼", rect.x + rect.width - 18, y);
      }
      ctx.restore();
    },
    [columns, sort],
  );

  return (
    <div
      className="h-full w-full"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
          e.preventDefault();
          e.stopPropagation();
          setShowSearch(true);
        }
      }}
    >
      <DataEditor
        ref={editorRef}
        width="100%"
        height="100%"
        columns={gridColumns}
        rows={rowCount}
        getCellContent={getCellContent}
        getRowThemeOverride={getRowThemeOverride}
        onCellEdited={handleEdit}
        onPaste={!!editable}
        theme={theme}
        rowMarkers={{ kind: "number", width: Math.max(44, String(rowCount).length * 8 + 22) }}
        smoothScrollX
        smoothScrollY
        getCellsForSelection
        gridSelection={selection}
        onGridSelectionChange={onSelectionChange}
        rowSelect="multi"
        columnSelect="none"
        rangeSelect="multi-rect"
        onColumnResize={(_c, size, idx) => setWidths((w) => ({ ...w, [gridColumns[idx].id!]: size }))}
        onVisibleRegionChanged={onVisible}
        onHeaderClicked={onHeaderClick ? (col) => onHeaderClick(col) : undefined}
        drawHeader={drawHeader}
        headerHeight={32}
        rowHeight={28}
        showSearch={showSearch}
        onSearchClose={() => setShowSearch(false)}
        keybindings={{ search: true }}
        overscrollX={40}
        maxColumnAutoWidth={500}
        scaleToRem={false}
      />
    </div>
  );
});
