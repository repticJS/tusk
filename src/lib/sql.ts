// SQL text helpers: quoting, statement splitting, value formatting.

const RESERVED = new Set(
  (
    "all analyse analyze and any array as asc asymmetric authorization binary both case cast check collate " +
    "collation column concurrently constraint create cross current_catalog current_date current_role " +
    "current_schema current_time current_timestamp current_user default deferrable desc distinct do else end " +
    "except false fetch for foreign freeze from full grant group having ilike in initially inner intersect into " +
    "is isnull join lateral leading left like limit localtime localtimestamp natural not notnull null offset on " +
    "only or order outer overlaps placing primary references returning right select session_user similar some " +
    "symmetric system_user table tablesample then to trailing true union unique user using variadic verbose when " +
    "where window with"
  ).split(" "),
);

/** Quotes an identifier only when Postgres requires it. */
export function quoteIdent(name: string): string {
  if (/^[a-z_][a-z0-9_$]*$/.test(name) && !RESERVED.has(name)) return name;
  return '"' + name.replace(/"/g, '""') + '"';
}

export function qualified(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

/** Quotes a string literal (standard_conforming_strings, the default since 9.1). */
export function quoteLiteral(value: string | null): string {
  if (value === null) return "NULL";
  return "'" + value.replace(/'/g, "''") + "'";
}

export interface Statement {
  text: string;
  /** Offsets of the trimmed statement in the original script. */
  from: number;
  to: number;
}

/**
 * Splits a script into statements on top-level semicolons, respecting
 * strings, quoted identifiers, dollar quotes and (nested) comments.
 * Statements that are only whitespace/comments are dropped.
 */
export function splitStatements(script: string): Statement[] {
  const out: Statement[] = [];
  let start = 0;
  let hasCode = false;
  let i = 0;
  const n = script.length;

  const push = (end: number) => {
    if (hasCode) {
      const raw = script.slice(start, end);
      const lead = raw.length - raw.trimStart().length;
      const text = raw.trim();
      out.push({ text, from: start + lead, to: start + lead + text.length });
    }
    hasCode = false;
  };

  while (i < n) {
    const c = script[i];
    const next = script[i + 1];
    if (c === "-" && next === "-") {
      const nl = script.indexOf("\n", i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (c === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (script[i] === "/" && script[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (script[i] === "*" && script[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      // E'...' strings allow backslash escapes.
      const escapes = c === "'" && i > 0 && /[eE]/.test(script[i - 1]) && !/\w/.test(script[i - 2] ?? "");
      hasCode = true;
      i++;
      while (i < n) {
        if (escapes && script[i] === "\\") {
          i += 2;
          continue;
        }
        if (script[i] === c) {
          if (script[i + 1] === c) {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      i++;
      continue;
    }
    if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(script.slice(i, i + 64));
      // Not a dollar quote if it's a positional param like $1 or inside an identifier.
      if (m && !/[\w$]/.test(script[i - 1] ?? "")) {
        const tag = m[0];
        const close = script.indexOf(tag, i + tag.length);
        hasCode = true;
        i = close === -1 ? n : close + tag.length;
        continue;
      }
    }
    if (c === ";") {
      push(i);
      start = i + 1;
      i++;
      continue;
    }
    if (!/\s/.test(c)) hasCode = true;
    i++;
  }
  push(n);
  return out;
}

/** The statement containing the cursor, or the closest one before it. */
export function statementAt(script: string, pos: number): Statement | null {
  const stmts = splitStatements(script);
  if (!stmts.length) return null;
  let best: Statement | null = null;
  for (const s of stmts) {
    // Treat the trailing semicolon as part of the statement.
    if (pos >= s.from && pos <= s.to + 1) return s;
    if (s.to <= pos) best = s;
  }
  return best ?? stmts[0];
}

export function firstKeyword(sql: string): string {
  const stripped = sql.replace(/^(\s|--[^\n]*\n?|\/\*[\s\S]*?\*\/|\()+/, "");
  return (/^[A-Za-z]+/.exec(stripped)?.[0] ?? "").toUpperCase();
}

const NUMERIC_TYPES = new Set([
  "int2", "int4", "int8", "float4", "float8", "numeric", "oid", "money",
  "smallint", "integer", "bigint", "real", "double precision",
]);

export function isNumericType(t?: string | null): boolean {
  if (!t) return false;
  return NUMERIC_TYPES.has(t) || t.startsWith("numeric") || t.startsWith("decimal");
}

export function isJsonType(t?: string | null): boolean {
  return t === "json" || t === "jsonb";
}

export function isBoolType(t?: string | null): boolean {
  return t === "bool" || t === "boolean";
}

/** Postgres sends booleans as t/f in text mode. */
export function displayValue(v: string | null, type?: string | null): string {
  if (v === null) return "NULL";
  if (isBoolType(type)) return v === "t" ? "true" : v === "f" ? "false" : v;
  return v;
}

/** Turns a displayed/edited value back into what Postgres should receive. */
export function normalizeInput(v: string, type?: string | null): string {
  if (isBoolType(type)) {
    const l = v.trim().toLowerCase();
    if (["true", "t", "1", "yes", "y", "on"].includes(l)) return "true";
    if (["false", "f", "0", "no", "n", "off"].includes(l)) return "false";
  }
  return v;
}

export function prettyJson(v: string): string | null {
  try {
    return JSON.stringify(JSON.parse(v), null, 2);
  } catch {
    return null;
  }
}

export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1) return "<1 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
}

// ---- export helpers ----

export function toCsv(columns: string[], rows: (string | null)[][]): string {
  const esc = (v: string | null) => {
    if (v === null) return "";
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  return [columns.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))].join("\r\n");
}

export function toTsv(columns: string[] | null, rows: (string | null)[][]): string {
  const esc = (v: string | null) => (v === null ? "" : v.replace(/[\t\n\r]/g, " "));
  const lines = rows.map((r) => r.map(esc).join("\t"));
  return (columns ? [columns.join("\t"), ...lines] : lines).join("\n");
}

export function toJson(
  columns: { name: string; typeName?: string | null }[],
  rows: (string | null)[][],
): string {
  const objs = rows.map((r) => {
    const o: Record<string, unknown> = {};
    columns.forEach((c, i) => {
      const v = r[i];
      if (v === null) o[c.name] = null;
      else if (isJsonType(c.typeName)) {
        try {
          o[c.name] = JSON.parse(v);
        } catch {
          o[c.name] = v;
        }
      } else if (isBoolType(c.typeName)) o[c.name] = v === "t";
      else if (["int2", "int4", "float4", "float8"].includes(c.typeName ?? "")) o[c.name] = Number(v);
      else o[c.name] = v;
    });
    return o;
  });
  return JSON.stringify(objs, null, 2);
}

export function toInserts(table: string, columns: string[], rows: (string | null)[][]): string {
  const cols = columns.map(quoteIdent).join(", ");
  return rows
    .map((r) => `INSERT INTO ${table} (${cols}) VALUES (${r.map(quoteLiteral).join(", ")});`)
    .join("\n");
}
