import { save } from "@tauri-apps/plugin-dialog";
import { api } from "./api";
import { toCsv, toInserts, toJson, toTsv } from "./sql";

export interface ExportData {
  columns: { name: string; typeName?: string | null }[];
  rows: (string | null)[][];
}

export async function exportToFile(data: ExportData, format: "csv" | "json", baseName: string): Promise<string | null> {
  const path = await save({
    defaultPath: `${baseName}.${format}`,
    filters: [format === "csv" ? { name: "CSV", extensions: ["csv"] } : { name: "JSON", extensions: ["json"] }],
  });
  if (!path) return null;
  const text =
    format === "csv"
      ? toCsv(
          data.columns.map((c) => c.name),
          data.rows,
        )
      : toJson(data.columns, data.rows);
  // A BOM makes Excel open UTF-8 CSVs correctly.
  await api.writeTextFile(path, format === "csv" ? "﻿" + text : text);
  return path;
}

export async function copyAs(data: ExportData, format: "tsv" | "json" | "insert", table = "table_name") {
  const names = data.columns.map((c) => c.name);
  const text =
    format === "tsv" ? toTsv(names, data.rows) : format === "json" ? toJson(data.columns, data.rows) : toInserts(table, names, data.rows);
  await navigator.clipboard.writeText(text);
}
