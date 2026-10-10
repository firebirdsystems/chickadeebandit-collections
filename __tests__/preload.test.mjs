import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { describe, it, expect } from "vitest";
import { READS, READ_ORDER, NEXT_PAGE, FIRST_PAGE_SIZE, NEXT_PAGE_SIZE, firstRenderBatch, namedResults, nextPageBatch, nextPageParams } from "../src/reads.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(__dirname, "../manifest.json"), "utf-8"));
const html = readFileSync(join(__dirname, "../src/index.html"), "utf-8");
const scenarios = JSON.parse(readFileSync(join(__dirname, "../scenarios.json"), "utf-8")).scenarios;
const replayed = new Set(scenarios.flatMap((s) => s.steps).filter((step) => step.action === "db").map((step) => step.sql));
const preload = manifest.preload ?? {};
const prefix = `app_${manifest.id.replace(/-/g, "_")}__`;

// The hub runs `manifest.preload` while rendering the document and answers the
// app's matching api/db request from the embedded rows, matching on the
// statement text. A drifted copy is not an error anywhere: it is a preload that
// silently never answers. The app posts src/reads.js, so the manifest is held
// to that.
describe("manifest.preload mirrors the first-render batch", () => {
  it("declares exactly the statements the app posts, in the order it posts them", () => {
    expect(Object.keys(preload)).toEqual(READ_ORDER);
    expect(Object.values(preload).map(({ sql }) => sql)).toEqual(firstRenderBatch().map(({ sql }) => sql));
  });

  it("stays within the hub's caps and reads only this app's tables", () => {
    expect(Object.keys(preload).length).toBeLessThanOrEqual(6);
    for (const [name, { sql, params = [] }] of Object.entries(preload)) {
      expect(sql, name).toMatch(/^(SELECT|WITH) /);
      expect(sql, name).not.toMatch(/;|--/);
      for (const table of sql.match(/(?:FROM|JOIN)\s+(\w+)/g) ?? []) expect(table, name).toMatch(new RegExp(`\\s${prefix}`));
      expect((sql.match(/\?/g) ?? []).length, `${name}: placeholders vs params`).toBe(params.length);
    }
  });
});

// Every table is governed, and the hub refuses a governed statement whose shape
// it cannot rewrite. Nothing in this repo can check that; scenarios.json can,
// because the hub replays it against the real runtime.
describe("statements the app sends", () => {
  it("reads are each replayed in scenarios.json, byte for byte", () => {
    for (const [name, sql] of [...Object.entries(READS), ...Object.entries(NEXT_PAGE)]) {
      expect(replayed.has(sql), `${name} is not a db step in scenarios.json`).toBe(true);
    }
  });

  it("fixed statements in index.html are each replayed too", () => {
    const fixed = [...html.matchAll(/"((?:INSERT|UPDATE|DELETE|SELECT) [^"]*app_collections__[^"]*)"/g)].map((m) => m[1]);
    expect(fixed.length).toBeGreaterThan(8);
    for (const sql of fixed) expect(replayed.has(sql), `not replayed: ${sql}`).toBe(true);
  });

  // A statement assembled at run time has no text to replay, so the check
  // above would pass without it. Every statement is spelled out instead.
  it("none is assembled from a template", () => {
    const templated = [...html.matchAll(/`\s*(?:INSERT|UPDATE|DELETE|SELECT)\b[^`]*`/g)].map((m) => m[0]);
    expect(templated).toEqual([]);
  });
});

describe("paging", () => {
  const row = (i) => ({ id: `r${String(i).padStart(5, "0")}`, created_at: "2026-01-01T00:00:00Z" });
  const page = (length) => Array.from({ length }, (_, i) => row(i));

  it("names batch results in the order they were sent", () => {
    const named = namedResults(READ_ORDER.map((name) => ({ rows: [{ name }] })));
    for (const name of READ_ORDER) expect(named[name]).toEqual([{ name }]);
    expect(namedResults(undefined).items).toEqual([]);
  });

  it("asks for another page only after a full one, starting after its last row", () => {
    expect(nextPageParams([], FIRST_PAGE_SIZE)).toBeNull();
    expect(nextPageParams(page(FIRST_PAGE_SIZE - 1), FIRST_PAGE_SIZE)).toBeNull();
    const full = page(FIRST_PAGE_SIZE);
    const last = full[FIRST_PAGE_SIZE - 1];
    expect(nextPageParams(full, FIRST_PAGE_SIZE)).toEqual([last.created_at, last.created_at, last.id]);
    // The same rows are a short page when more were asked for.
    expect(nextPageParams(full, NEXT_PAGE_SIZE)).toBeNull();
    for (const sql of Object.values(NEXT_PAGE)) expect((sql.match(/\?/g) ?? []).length).toBe(3);
  });

  it("reads the next page of every table that has one in a single batch", () => {
    const full = page(FIRST_PAGE_SIZE);
    const short = [row(1)];
    expect(nextPageBatch({ items: full, photos: full }, FIRST_PAGE_SIZE).map((s) => s.name)).toEqual(["items", "photos"]);
    expect(nextPageBatch({ items: short, photos: full }, FIRST_PAGE_SIZE))
      .toEqual([{ name: "photos", sql: NEXT_PAGE.photos, params: [full.at(-1).created_at, full.at(-1).created_at, full.at(-1).id] }]);
    expect(nextPageBatch({ items: short, photos: [] }, FIRST_PAGE_SIZE)).toEqual([]);
    expect(nextPageBatch({}, NEXT_PAGE_SIZE)).toEqual([]);
  });

  it("asks each statement for the size its page is judged by", () => {
    for (const name of ["items", "photos"]) expect(READS[name].endsWith(` LIMIT ${FIRST_PAGE_SIZE}`), name).toBe(true);
    for (const sql of Object.values(NEXT_PAGE)) expect(sql.endsWith(` LIMIT ${NEXT_PAGE_SIZE}`)).toBe(true);
  });

  it("keeps both first pages inside the preload the hub will embed", () => {
    // Real-shaped rows: every id a UUID, a photo with its thumbnail and cutout,
    // an item with four tags, two places and a 500-character note, which is
    // far more than most will carry. Over 256 KB the hub drops the whole
    // preload and every launch pays for the request again.
    const uuid = "6082ba46-bf70-4a1a-b4c7-337679bef918";
    const at = "2026-10-09T23:11:04.912Z";
    const photo = { id: uuid, collection_id: uuid, item_id: uuid, file_id: uuid, thumb_file_id: uuid, cutout_file_id: uuid, cutout_status: "pending", cutout_requested_at: at, use_cutout: 1, sort_order: 12, created_by: uuid, created_at: at };
    const item = { id: uuid, collection_id: uuid, name: "n".repeat(40), note: "n".repeat(500), tag_ids: JSON.stringify([uuid, uuid, uuid, uuid]), location_ids: JSON.stringify([uuid, uuid]), cover_file_ids: JSON.stringify([uuid]), created_by: uuid, created_at: at, updated_at: at };
    const firstPages = FIRST_PAGE_SIZE * (JSON.stringify(photo).length + JSON.stringify(item).length);
    // The other three reads share the budget; leave them a quarter of it.
    expect(firstPages).toBeLessThan(256 * 1024 * 0.75);
  });

  it("stays under the rows one request may return", () => {
    expect(Object.keys(NEXT_PAGE).length * NEXT_PAGE_SIZE).toBeLessThanOrEqual(5000);
  });

  // The hub answers a reply over 2 MB with a 413, the same way every time, so
  // a page that can exceed it is a household that never sees its older rows.
  it("keeps a later round under the size one reply may be, with every note full", () => {
    const uuid = "6082ba46-bf70-4a1a-b4c7-337679bef918";
    const at = "2026-10-09T23:11:04.912Z";
    const bytes = (row) => new TextEncoder().encode(JSON.stringify(row)).length;
    const photo = { id: uuid, collection_id: uuid, item_id: uuid, file_id: uuid, thumb_file_id: uuid, cutout_file_id: uuid, cutout_status: "pending", cutout_requested_at: at, use_cutout: 1, sort_order: 12, created_by: uuid, created_at: at };
    // The longest the boxes allow, in characters that take three bytes each.
    const item = { id: uuid, collection_id: uuid, name: "名".repeat(120), note: "記".repeat(2000), acquired_date: "2019-12-25", tag_ids: JSON.stringify(Array(8).fill(uuid)), location_ids: JSON.stringify(Array(4).fill(uuid)), cover_file_ids: JSON.stringify([uuid]), created_by: uuid, created_at: at, updated_at: at };
    expect(NEXT_PAGE_SIZE * (bytes(photo) + bytes(item))).toBeLessThan(2 * 1024 * 1024);
  });

  it("pages carry the same columns and order as the first page", () => {
    for (const name of Object.keys(NEXT_PAGE)) {
      const head = (sql) => sql.slice(0, sql.indexOf(" FROM "));
      const tail = (sql) => sql.slice(sql.indexOf(" ORDER BY "), sql.lastIndexOf(" LIMIT "));
      expect(head(NEXT_PAGE[name])).toBe(head(READS[name]));
      expect(tail(NEXT_PAGE[name])).toBe(tail(READS[name]));
    }
  });
});
