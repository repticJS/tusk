// Catalog introspection. Everything goes through the generic query path.
import { query, type SessionRef } from "./api";
import { quoteIdent, quoteLiteral, qualified } from "./sql";

export type RelKind = "r" | "p" | "v" | "m" | "f";

export interface DbObject {
  schema: string;
  name: string;
  kind: RelKind;
  estimate: number;
  size: number;
  comment: string | null;
}

export interface DbFunction {
  oid: string;
  schema: string;
  name: string;
  args: string;
  result: string | null;
  kind: "f" | "p";
}

export interface SchemaContents {
  objects: DbObject[];
  functions: DbFunction[];
}

export interface TableColumn {
  name: string;
  type: string;
  /** Underlying type name (int4, jsonb…) for formatting decisions. */
  typeName: string;
  notNull: boolean;
  default: string | null;
  pkOrdinal: number | null;
  identity: string;
  generated: string;
  comment: string | null;
}

export interface TableIndex {
  name: string;
  definition: string;
  primary: boolean;
  unique: boolean;
  size: number;
}

export interface TableConstraint {
  name: string;
  type: string;
  definition: string;
}

export interface TableTrigger {
  name: string;
  definition: string;
}

export interface TableDetails {
  kind: RelKind;
  columns: TableColumn[];
  primaryKey: string[];
  indexes: TableIndex[];
  constraints: TableConstraint[];
  triggers: TableTrigger[];
  estimate: number;
  totalSize: number;
  comment: string | null;
  viewDefinition: string | null;
}

export const KIND_LABEL: Record<RelKind, string> = {
  r: "table",
  p: "partitioned table",
  v: "view",
  m: "materialized view",
  f: "foreign table",
};

export async function listDatabases(s: SessionRef): Promise<string[]> {
  const rows = await query<{ datname: string }>(
    s,
    "select datname from pg_database where datallowconn and not datistemplate order by datname",
  );
  return rows.map((r) => r.datname);
}

export async function listSchemas(s: SessionRef, includeSystem: boolean): Promise<string[]> {
  const rows = await query<{ nspname: string }>(
    s,
    `select nspname from pg_namespace
     where nspname !~ '^pg_(toast|temp_|toast_temp_)'
     ${includeSystem ? "" : "and nspname not in ('pg_catalog', 'information_schema')"}
     order by nspname in ('pg_catalog', 'information_schema'), nspname = 'public' desc, nspname`,
  );
  return rows.map((r) => r.nspname);
}

export async function schemaContents(s: SessionRef, schema: string): Promise<SchemaContents> {
  const lit = quoteLiteral(schema);
  const [objects, functions] = await Promise.all([
    query<Record<string, string | null>>(
      s,
      `select c.relname as name, c.relkind::text as kind,
              greatest(c.reltuples, 0)::bigint::text as estimate,
              pg_total_relation_size(c.oid)::text as size,
              obj_description(c.oid, 'pg_class') as comment
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = ${lit} and c.relkind in ('r','p','v','m','f') and not c.relispartition
       order by c.relname`,
    ),
    query<Record<string, string | null>>(
      s,
      `select p.oid::text as oid, p.proname as name, pg_get_function_identity_arguments(p.oid) as args,
              pg_get_function_result(p.oid) as result, p.prokind::text as kind
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = ${lit} and p.prokind in ('f','p')
         and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
       order by p.proname, 3`,
    ),
  ]);
  return {
    objects: objects.map((o) => ({
      schema,
      name: o.name!,
      kind: o.kind as RelKind,
      estimate: Number(o.estimate),
      size: Number(o.size),
      comment: o.comment,
    })),
    functions: functions.map((f) => ({
      oid: f.oid!,
      schema,
      name: f.name!,
      args: f.args ?? "",
      result: f.result,
      kind: f.kind as "f" | "p",
    })),
  };
}

export async function tableDetails(s: SessionRef, schema: string, table: string): Promise<TableDetails> {
  const rel = `${quoteLiteral(qualified(schema, table))}::regclass`;
  const [info, columns, indexes, constraints, triggers] = await Promise.all([
    query(
      s,
      `select c.relkind::text as kind, greatest(c.reltuples, 0)::bigint::text as estimate,
              pg_total_relation_size(c.oid)::text as size, obj_description(c.oid, 'pg_class') as comment,
              case when c.relkind in ('v','m') then pg_get_viewdef(c.oid, true) end as viewdef
       from pg_class c where c.oid = ${rel}`,
    ),
    query(
      s,
      `select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, t.typname as typename,
              a.attnotnull::text as notnull, pg_get_expr(d.adbin, d.adrelid) as default,
              (select k.ord::text from pg_index i, unnest(i.indkey) with ordinality k(attnum, ord)
                where i.indrelid = a.attrelid and i.indisprimary and k.attnum = a.attnum) as pk,
              a.attidentity::text as identity, a.attgenerated::text as generated,
              col_description(a.attrelid, a.attnum) as comment
       from pg_attribute a
       join pg_type t on t.oid = a.atttypid
       left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
       where a.attrelid = ${rel} and a.attnum > 0 and not a.attisdropped
       order by a.attnum`,
    ),
    query(
      s,
      `select ic.relname as name, pg_get_indexdef(i.indexrelid) as def, i.indisprimary::text as primary,
              i.indisunique::text as unique, pg_relation_size(i.indexrelid)::text as size
       from pg_index i join pg_class ic on ic.oid = i.indexrelid
       where i.indrelid = ${rel} order by i.indisprimary desc, ic.relname`,
    ),
    query(
      s,
      `select conname as name, contype::text as type, pg_get_constraintdef(oid, true) as def
       from pg_constraint where conrelid = ${rel}
       order by array_position(array['p','u','f','c','x','t'], contype::text), conname`,
    ),
    query(
      s,
      `select tgname as name, pg_get_triggerdef(oid, true) as def
       from pg_trigger where tgrelid = ${rel} and not tgisinternal order by tgname`,
    ),
  ]);
  const cols: TableColumn[] = columns.map((c) => ({
    name: c.name!,
    type: c.type!,
    typeName: c.typename!,
    notNull: c.notnull === "true",
    default: c.default,
    pkOrdinal: c.pk ? Number(c.pk) : null,
    identity: c.identity ?? "",
    generated: c.generated ?? "",
    comment: c.comment,
  }));
  const i = info[0] ?? {};
  return {
    kind: (i.kind ?? "r") as RelKind,
    columns: cols,
    primaryKey: cols
      .filter((c) => c.pkOrdinal !== null)
      .sort((a, b) => a.pkOrdinal! - b.pkOrdinal!)
      .map((c) => c.name),
    indexes: indexes.map((x) => ({
      name: x.name!,
      definition: x.def!,
      primary: x.primary === "true",
      unique: x.unique === "true",
      size: Number(x.size),
    })),
    constraints: constraints.map((x) => ({ name: x.name!, type: x.type!, definition: x.def! })),
    triggers: triggers.map((x) => ({ name: x.name!, definition: x.def! })),
    estimate: Number(i.estimate ?? 0),
    totalSize: Number(i.size ?? 0),
    comment: i.comment ?? null,
    viewDefinition: i.viewdef ?? null,
  };
}

export async function functionDefinition(s: SessionRef, oid: string): Promise<string> {
  const rows = await query<{ def: string }>(s, `select pg_get_functiondef(${Number(oid)}) as def`);
  return rows[0]?.def ?? "";
}

export interface Relation {
  schema: string;
  name: string;
  kind: RelKind;
}

/**
 * Every user relation in the database: a {schema: {table: [columns]}} map for
 * editor autocompletion plus a flat list for the command palette.
 */
export async function completionSchema(
  s: SessionRef,
): Promise<{ schema: Record<string, Record<string, string[]>>; relations: Relation[] }> {
  const rows = await query<{ s: string; t: string; k: string; c: string | null }>(
    s,
    `select n.nspname as s, c.relname as t, c.relkind::text as k, a.attname as c
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     left join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
     where c.relkind in ('r','p','v','m','f') and not c.relispartition
       and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_'
     order by 1, 2, a.attnum
     limit 100000`,
  );
  const schema: Record<string, Record<string, string[]>> = {};
  const relations: Relation[] = [];
  for (const r of rows) {
    const tables = (schema[r.s] ??= {});
    if (!tables[r.t]) {
      tables[r.t] = [];
      relations.push({ schema: r.s, name: r.t, kind: r.k as RelKind });
    }
    if (r.c) tables[r.t].push(r.c);
  }
  return { schema, relations };
}

export async function exactCount(s: SessionRef, from: string, where: string): Promise<number> {
  const rows = await query<{ n: string }>(
    s,
    `select count(*)::text as n from ${from}${where.trim() ? ` where ${where}` : ""}`,
  );
  return Number(rows[0]?.n ?? 0);
}

/** A readable CREATE TABLE statement assembled from the catalog. */
export function tableDdl(schema: string, table: string, d: TableDetails): string {
  const name = qualified(schema, table);
  if (d.kind === "v" || d.kind === "m") {
    const kw = d.kind === "m" ? "MATERIALIZED VIEW" : "VIEW";
    return `CREATE ${d.kind === "v" ? "OR REPLACE " : ""}${kw} ${name} AS\n${(d.viewDefinition ?? "").trimEnd()}\n`;
  }
  const lines = d.columns.map((c) => {
    let l = `  ${quoteIdent(c.name)} ${c.type}`;
    if (c.identity === "a") l += " GENERATED ALWAYS AS IDENTITY";
    else if (c.identity === "d") l += " GENERATED BY DEFAULT AS IDENTITY";
    else if (c.generated === "s" && c.default) l += ` GENERATED ALWAYS AS (${c.default}) STORED`;
    else if (c.default) l += ` DEFAULT ${c.default}`;
    if (c.notNull) l += " NOT NULL";
    return l;
  });
  for (const con of d.constraints) {
    if (con.type === "n") continue; // NOT NULL constraints (PG 18) are already on the columns
    lines.push(`  CONSTRAINT ${quoteIdent(con.name)} ${con.definition}`);
  }
  let sql = `CREATE TABLE ${name} (\n${lines.join(",\n")}\n);\n`;
  const constraintNames = new Set(d.constraints.map((c) => c.name));
  for (const idx of d.indexes) {
    if (!constraintNames.has(idx.name)) sql += `\n${idx.definition};`;
  }
  for (const t of d.triggers) sql += `\n${t.definition};`;
  if (d.comment) sql += `\n\nCOMMENT ON TABLE ${name} IS ${quoteLiteral(d.comment)};`;
  for (const c of d.columns) {
    if (c.comment) sql += `\nCOMMENT ON COLUMN ${name}.${quoteIdent(c.name)} IS ${quoteLiteral(c.comment)};`;
  }
  return sql.trimEnd() + "\n";
}
