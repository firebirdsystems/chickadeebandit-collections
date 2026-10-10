import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { describe, it, expect } from "vitest";
import { manifest, prefix, appTableColumns } from "./schema.mjs";
import { staleCovers, coverWrites, DB_BATCH_MAX } from "../src/logic.js";
import { READS } from "../src/reads.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(__dirname, "../src/index.html"), "utf-8");
const { scenarios } = JSON.parse(readFileSync(join(__dirname, "../scenarios.json"), "utf-8"));

const item = manifest.shareable?.collection;
const feed = item?.feed;

/**
 * A share link is an anonymous read that skips row policies, so the declared
 * columns are the whole public surface. These pin that surface to what the
 * panel tells the adult making the link.
 */
describe("shareable.collection", () => {
  it("shares one collection, never all of them", () => {
    expect(Object.keys(manifest.shareable)).toEqual(["collection"]);
    expect(item.table).toBe("collections");
    expect(item.id_column ?? "id").toBe("id");
    expect(item.title_column).toBe("name");
    expect(item.columns.map((c) => c.column)).toEqual(["description"]);
  });

  it("lists that collection's items: name, acquired date and notes", () => {
    expect(item.feeds).toBeUndefined();
    expect(feed.table).toBe("items");
    expect(feed.fk_column).toBe("collection_id");
    expect(feed.columns.map((c) => c.column)).toEqual(["name", "acquired_date", "note"]);
  });

  // Where a thing is kept is not for strangers, and tags are stored as ids
  // that mean nothing outside the app. Who added what is a member id.
  it("never reaches where things are stored, tags, or who added them", () => {
    const text = JSON.stringify(item);
    for (const s of ["location", "tag_ids", "created_by", "visibility"]) expect(text).not.toContain(s);
  });

  // Checked against the app's own item read, which scenarios.json replays
  // against the hub: a column that statement returns is a column that exists.
  it("names only real columns", () => {
    const parent = appTableColumns().get(`${prefix}${item.table}`);
    for (const column of [item.title_column, ...item.columns.map((c) => c.column)]) {
      expect(parent.has(column), `collections.${column}`).toBe(true);
    }
    const read = READS.items.slice("SELECT ".length, READS.items.indexOf(" FROM ")).split(", ");
    for (const column of [feed.fk_column, feed.files_column, feed.order_column, ...feed.columns.map((c) => c.column)]) {
      expect(read, `items.${column}`).toContain(column);
    }
    expect(appTableColumns().get(`${prefix}items`).has("cover_file_ids")).toBe(true);
  });

  // The hub orders in raw SQL, outside the codec, so the column it sorts by
  // must be stored in the clear. `_at` columns are.
  it("orders by a column stored in the clear, newest first, as the app does", () => {
    expect(feed.order_column).toBe("created_at");
    expect(feed.order).toBe("newest");
    expect(feed.max_items).toBe(200);
  });

  it("is read-only: nobody outside the household can add to it", () => {
    expect(item.submit).toBeUndefined();
    expect(item.aggregates).toBeUndefined();
    expect(item.calendar).toBeUndefined();
  });

  // A read ACL (uploader-only, say) would hide every photo not uploaded by the
  // adult who made the link.
  it("serves each item's picture, with no file read ACL in the way", () => {
    expect(feed.files_column).toBe("cover_file_ids");
    expect(manifest.file_acls?.read).toBeUndefined();
  });

  it("is the item type the page mints, for adults", () => {
    expect(page).toMatch(/itemType:\s*"collection"/);
    expect(page).toMatch(/const canShare = \(\) => share\.enabled && isAdult\(me\)/);
  });

  it("tells the sharer what the page shows and what stays home", () => {
    const scope = page.match(/const SHARE_SCOPE = "([^"]+)"/)?.[1] ?? "";
    expect(scope).toMatch(/name, notes, the date it was acquired and one photo, which opens at full size/);
    expect(scope).toMatch(/Tags and where things are stored stay in the household/);
    // Both are the hub's limits: 200 entries in a feed, 100 files on a page.
    expect(scope).toMatch(/newest 200 items and shows up to 100 photos/);
    // A link is to the collection as it will be, not as it was when shared.
    expect(scope).toMatch(/The page is live: whatever anyone in the household adds/);
    expect(page).toMatch(/scopeHtml: \(\) => `\$\{coversCurrent \? "" : "<strong>[^"]+<\/strong> "\}\$\{SHARE_SCOPE\}`/);
  });
});

/**
 * `cover_file_ids` is a second name for a file a photo row owns. Every column a
 * reclaim key names counts as a row still naming the file: listed there, a
 * deleted photo would be kept, and kept public, for as long as an item's copy
 * of its id had not caught up.
 */
describe("items.cover_file_ids owns nothing", () => {
  it("is named by no key that reclaims or keeps files", () => {
    for (const key of ["delete_file_columns", "update_file_columns", "delete_file_list_columns", "update_file_list_columns"]) {
      expect(JSON.stringify(manifest[key] ?? {}), key).not.toContain("cover_file_ids");
    }
    expect(JSON.stringify(manifest.delete_cascades)).not.toContain("cover_file_ids");
    expect(JSON.stringify(manifest.member_references)).not.toContain("cover_file_ids");
  });

  // The hub refuses a bundle with a single-file column (`*_file_id`) that no
  // key reclaims. This one holds a list, the other shape a share page reads.
  it("holds a list, not a bare id", () => {
    const [{ value }] = staleCovers([{ id: "i1", cover_file_ids: "" }], [{ id: "p1", item_id: "i1", file_id: "f1", sort_order: 0, created_at: "a" }]);
    expect(JSON.parse(value)).toEqual(["f1"]);
  });

  // The hub refuses a batch of more than 25 statements outright, and a
  // household that already has items starts with every cover unwritten.
  it("is written in batches the hub accepts, leaving none out", () => {
    expect(DB_BATCH_MAX).toBe(25);
    const items = Array.from({ length: 63 }, (_, i) => ({ id: `i${i}`, cover_file_ids: "" }));
    const photos = items.map((item, i) => ({ id: `p${i}`, item_id: item.id, file_id: `f${i}`, sort_order: 0, created_at: "a" }));
    const batches = coverWrites(items, photos);
    expect(batches.map((batch) => batch.length)).toEqual([25, 25, 13]);
    expect(batches.flat().map((write) => write.id)).toEqual(items.map((item) => item.id));
    expect(coverWrites([], [])).toEqual([]);
    expect(page).toContain("for (const group of coverWrites(isAdult(me) ? items : [], photos))");
  });

  // Whatever file the column names is served to anyone holding a link, so the
  // hub lets only an adult write it, and the app sends the write for nobody
  // else. scenarios.json replays the refusal a child gets.
  it("is written by adults only, by the hub's rule and not just the app's", () => {
    expect(manifest.row_policies.items.column_write_acls).toEqual({ cover_file_ids: { writable_by: ["adult"] } });
    const refused = scenarios.flatMap((scenario) => scenario.steps)
      .filter((step) => /cover_file_ids = \?|cover_file_ids,/.test(step.sql ?? "") && step.expect?.status === 403);
    expect(refused.map((step) => step.as).sort()).toEqual(["kid", "kid", "sibling"]);
    // The app's INSERT of an item leaves the column to its default.
    expect(page).toMatch(/"INSERT INTO app_collections__items \((?![^)]*cover_file_ids)[^)]*\)/);
  });

  it("is written by one fixed statement that touches nothing else", () => {
    expect(page).toContain('"UPDATE app_collections__items SET cover_file_ids = ? WHERE id = ?"');
  });
});
