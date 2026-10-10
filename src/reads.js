// Every SELECT the app sends. The first-render ones are also declared in
// manifest.preload, which the hub answers from rows embedded in the document;
// __tests__/preload.test.mjs holds the two copies together.

/**
 * Items and photos are read a page at a time, newest first, and the two page
 * sizes answer to different limits.
 *
 * The FIRST page of each is preloaded: the hub embeds the rows in the document
 * and the app's first request costs nothing. The hub drops a whole preload over
 * 256 KB, and a photo row is about 500 bytes of JSON and an item row about 420
 * before its note, so the first page is small enough that both fit with room
 * for notes, collections, tags and places.
 *
 * Every LATER page travels over the network, where the limit is 5,000 rows a
 * request across both tables. A large page there means a household with a
 * thousand photos pays one more request, not eight.
 */
export const FIRST_PAGE_SIZE = 120;
export const NEXT_PAGE_SIZE = 1500;

export const READS = {
  collections: "SELECT id, name, description, auto_cutout, created_by, created_at, updated_at FROM app_collections__collections ORDER BY created_at DESC, id DESC",
  tags: "SELECT id, collection_id, name, created_by, created_at FROM app_collections__tags ORDER BY created_at, id",
  locations: "SELECT id, name, created_by, created_at FROM app_collections__locations ORDER BY created_at, id",
  items: `SELECT id, collection_id, name, note, acquired_date, tag_ids, location_ids, created_by, created_at, updated_at FROM app_collections__items ORDER BY created_at DESC, id DESC LIMIT ${FIRST_PAGE_SIZE}`,
  photos: `SELECT id, collection_id, item_id, file_id, thumb_file_id, cutout_file_id, cutout_status, cutout_requested_at, use_cutout, sort_order, created_by, created_at FROM app_collections__photos ORDER BY created_at DESC, id DESC LIMIT ${FIRST_PAGE_SIZE}`,
};

/** The order of the first-render batch, and of manifest.preload. */
export const READ_ORDER = ["collections", "tags", "locations", "items", "photos"];

// The page after a given row. Same columns and order as the first page, so the
// pages concatenate.
export const NEXT_PAGE = {
  items: `SELECT id, collection_id, name, note, acquired_date, tag_ids, location_ids, created_by, created_at, updated_at FROM app_collections__items WHERE (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ${NEXT_PAGE_SIZE}`,
  photos: `SELECT id, collection_id, item_id, file_id, thumb_file_id, cutout_file_id, cutout_status, cutout_requested_at, use_cutout, sort_order, created_by, created_at FROM app_collections__photos WHERE (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ${NEXT_PAGE_SIZE}`,
};

export function firstRenderBatch() {
  return READ_ORDER.map((name) => ({ sql: READS[name] }));
}

/** Batch results keyed by read name. A missing result reads as no rows. */
export function namedResults(results) {
  const named = {};
  READ_ORDER.forEach((name, i) => { named[name] = results?.[i]?.rows ?? []; });
  return named;
}

/**
 * The statements for the next round of pages, given the last page read of each
 * table and the size that page was asked for. Both tables go in one batch, so
 * a round is one request however many tables still have rows to come. Empty
 * when everything has been read.
 */
export function nextPageBatch(lastPages, pageSize) {
  return Object.keys(NEXT_PAGE)
    .map((name) => ({ name, sql: NEXT_PAGE[name], params: nextPageParams(lastPages[name] ?? [], pageSize) }))
    .filter((statement) => statement.params);
}

/** Params for NEXT_PAGE, or null when `rows`, asked for `pageSize` at a time, was the last page. */
export function nextPageParams(rows, pageSize) {
  if (!rows.length || rows.length < pageSize) return null;
  const last = rows[rows.length - 1];
  return [last.created_at, last.created_at, last.id];
}
