/**
 * Local mirror of the hub's scalar-file-column ratchet.
 *
 * Every column holding a hub file id must be named by
 * `manifest.delete_file_columns`, so the hub reads the id off the doomed row
 * and queues the R2 reclaim inside the DELETE's own transaction. The pattern
 * this replaces was a trailing `files.delete(id).catch(() => {})` in the
 * client, fired after the row was already gone: when it was interrupted the
 * metadata row survived, so the orphan reconciler read the object as live, no
 * UI could reach it, and it stayed billed against the household's hard file cap
 * until the app was uninstalled.
 *
 * `delete_cascades` does NOT satisfy this. That key fires when the PARENT is
 * deleted; a direct DELETE of the row that owns the file consults
 * `delete_file_columns` and nothing else.
 *
 * The hub rejects the bundle at publish time. This test is the same check where
 * it is cheap to fix.
 */
import { describe, it, expect } from "vitest";
import { manifest, prefix, appTableColumns } from "./schema.mjs";

/** Scalar hub-file-id columns. List columns (`*_file_ids`) are a different
 *  lane — the reclaim engine reads raw SQL and cannot parse a JSON array. */
const FILE_ID_COLUMN_RE = /^(?:file_id|file_key|photo_id|[a-z0-9_]*_file_id|[a-z0-9_]*_photo_id|[a-z0-9_]*_image_id)$/;

/** [unprefixedTable, column] for every scalar file column in the schema. */
function schemaFileColumns() {
  const found = [];
  for (const [physical, columns] of appTableColumns()) {
    for (const column of columns) {
      if (FILE_ID_COLUMN_RE.test(column)) found.push([physical.slice(prefix.length), column]);
    }
  }
  return found;
}

/** Tables/columns whose deletes reclaim durably: delete_file_columns, plus
 *  versioned_records (that lane reclaims through the countersigned purge). */
function declaredColumns() {
  const declared = new Map();
  const add = (table, columns) => {
    if (!table) return;
    const set = declared.get(table) ?? new Set();
    declared.set(table, set);
    for (const column of [columns].flat().filter(Boolean)) set.add(column);
  };
  for (const [table, columns] of Object.entries(manifest.delete_file_columns ?? {})) add(table, columns);
  for (const cfg of Object.values(manifest.versioned_records ?? {})) {
    add(cfg.table, cfg.file_column);
    add(cfg.version_table, cfg.file_column);
  }
  return declared;
}

describe("hub file reclaim", () => {
  it("declares every scalar file column for the app-originated delete lane", () => {
    const declared = declaredColumns();
    const undeclared = schemaFileColumns()
      .filter(([table, column]) => !declared.get(table)?.has(column))
      .map(([table, column]) => `${table}.${column}`);
    expect(undeclared).toEqual([]);
  });

  it("names only real tables and columns", () => {
    const tables = appTableColumns();
    for (const [table, columns] of Object.entries(manifest.delete_file_columns ?? {})) {
      const names = tables.get(`${prefix}${table}`);
      expect(names, `delete_file_columns.${table} has no CREATE TABLE`).toBeDefined();
      // The engine resolves the doomed rows by id before deleting them.
      expect(names.has("id"), `${table} needs an id column`).toBe(true);
      for (const column of columns) {
        expect(names.has(column), `${table}.${column} is missing from the schema`).toBe(true);
        // The reclaim reads this column in raw SQL, outside the decrypt path.
        expect(column.endsWith("_id") || (manifest.db_plaintext_columns ?? []).includes(column)
          || manifest.db_encryption === "off", `${table}.${column} would be encrypted at rest`).toBe(true);
      }
    }
  });
});
