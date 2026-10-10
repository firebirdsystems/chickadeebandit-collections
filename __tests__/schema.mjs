/**
 * Shared migration-schema reader for the manifest ratchets in this suite.
 *
 * The manifest names columns the hub resolves in raw SQL — file-reclaim
 * columns, share-link projections, share-link filters. Every one of those is a
 * string that no compiler checks, so the tests here re-derive the real column
 * set from the migrations and compare.
 */
import { readFileSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const manifest = JSON.parse(readFileSync(join(__dirname, "../manifest.json"), "utf-8"));
export const prefix = `app_${manifest.id.replaceAll("-", "_")}__`;

const migrationsDir = join(__dirname, "../migrations");
export const schema = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(migrationsDir, f), "utf-8"))
  .join("\n");

function createTableBody(table) {
  const head = new RegExp(`create\\s+table\\s+if\\s+not\\s+exists\\s+["\\[]?${table}["\\]]?\\s*\\(`, "i");
  const m = head.exec(schema);
  if (!m) return null;
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  while (i < schema.length && depth > 0) {
    if (schema[i] === "(") depth++;
    else if (schema[i] === ")") depth--;
    i++;
  }
  return schema.slice(start, i - 1);
}

function columnNames(body) {
  const segments = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) { segments.push(current); current = ""; } else current += ch;
  }
  segments.push(current);
  const constraints = new Set(["primary", "unique", "check", "foreign", "constraint"]);
  return segments
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split(/\s+/)[0].replace(/^["[`]|["\]`]$/g, ""))
    .filter((name) => !constraints.has(name.toLowerCase()));
}

/** Every app table's columns: CREATE TABLE bodies plus appended ALTER TABLE ADD
 *  COLUMN statements. Callers need the ALTERs — several columns arrive in a
 *  later migration than the table. */
export function appTableColumns() {
  const tables = new Map();
  for (const m of schema.matchAll(/create\s+table\s+if\s+not\s+exists\s+["\[]?([A-Za-z0-9_]+)["\]]?\s*\(/gi)) {
    if (!m[1].startsWith(prefix)) continue;
    const body = createTableBody(m[1]);
    if (body) tables.set(m[1], new Set(columnNames(body)));
  }
  for (const m of schema.matchAll(/alter\s+table\s+["\[]?([A-Za-z0-9_]+)["\]]?\s+add\s+column\s+["\[]?([A-Za-z0-9_]+)["\]]?/gi)) {
    tables.get(m[1])?.add(m[2]);
  }
  return tables;
}

/** Columns of one UNPREFIXED table name, as the manifest spells it. */
export function columnsOf(table) {
  return appTableColumns().get(`${prefix}${table}`);
}

/** Mirrors the hub's `isPlaintextAppDbColumn`: the only columns a raw-SQL
 *  filter (share-link where/parent_where/order) may name. Note the hub does
 *  NOT consult db_encryption here — an app with encryption off still has to
 *  list a non-conventional column in db_plaintext_columns. */
const BUILTIN_PLAINTEXT = new Set([
  "id", "household_id", "created_at", "updated_at", "sent_at", "read_at",
  "expires_at", "last_synced_at", "completed", "all_day",
  "status", "type", "category", "week", "emoji", "icon",
  "position", "sort_order", "pinned", "key", "version",
  "visibility", "audience",
  "membership_type", "membership_roles",
]);

export function isPlaintextColumn(column) {
  return BUILTIN_PLAINTEXT.has(column)
    || column.endsWith("_id") || column.endsWith("_at")
    || column.endsWith("_date") || column.endsWith("_by")
    || (manifest.db_plaintext_columns ?? []).includes(column);
}
