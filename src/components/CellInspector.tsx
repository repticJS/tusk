import { Check, Copy, X } from "lucide-react";
import { useEffect, useState } from "react";
import { displayValue, isJsonType, prettyJson } from "../lib/sql";

export interface InspectedCell {
  column: string;
  typeLabel?: string | null;
  typeName?: string | null;
  value: string | null;
  editable: boolean;
}

/** Side panel showing the full value of the selected cell; edits long values. */
export function CellInspector(props: {
  cell: InspectedCell | null;
  onApply?: (value: string | null) => void;
  onClose: () => void;
}) {
  const { cell } = props;
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);

  const json = cell && cell.value !== null && isJsonType(cell.typeName) ? prettyJson(cell.value) : null;
  const shown = cell ? (json ?? displayValue(cell.value, cell.typeName)) : "";

  useEffect(() => {
    setDraft(cell?.value === null ? "" : shown);
    setCopied(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cell?.column, cell?.value]);

  const dirty = !!cell && (cell.value === null ? draft !== "" : draft !== shown);

  return (
    <div className="flex h-full flex-col bg-panel">
      <div className="flex h-9 items-center gap-2 border-b border-border px-3">
        <div className="min-w-0 flex-1 truncate text-[12.5px] font-semibold">
          {cell ? cell.column : "Value"}
          {cell?.typeLabel && <span className="ml-2 font-normal text-faint">{cell.typeLabel}</span>}
        </div>
        {cell && (
          <button
            className="btn-ghost h-6 px-1.5"
            title="Copy value"
            onClick={() => {
              void navigator.clipboard.writeText(cell.value ?? "");
              setCopied(true);
            }}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
        )}
        <button className="btn-ghost h-6 px-1.5" title="Close panel" onClick={props.onClose}>
          <X size={13} />
        </button>
      </div>
      {!cell ? (
        <div className="p-4 text-[12.5px] text-faint">Select a cell to see its full value.</div>
      ) : cell.editable ? (
        <>
          <textarea
            className="selectable min-h-0 flex-1 resize-none bg-bg p-3 font-mono text-[12.5px] leading-relaxed text-text outline-none"
            spellCheck={false}
            value={draft}
            placeholder={cell.value === null ? "NULL" : ""}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && dirty) {
                e.preventDefault();
                props.onApply?.(draft);
              }
            }}
          />
          <div className="flex items-center gap-2 border-t border-border p-2">
            <button className="btn-outline" onClick={() => props.onApply?.(null)} disabled={cell.value === null}>
              Set NULL
            </button>
            <div className="flex-1" />
            <button className="btn-primary" disabled={!dirty} onClick={() => props.onApply?.(draft)}>
              Apply
            </button>
          </div>
        </>
      ) : (
        <pre className="selectable min-h-0 flex-1 overflow-auto p-3 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap break-words">
          {cell.value === null ? <span className="text-faint">NULL</span> : shown}
        </pre>
      )}
    </div>
  );
}
