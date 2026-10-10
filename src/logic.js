import { isAdult } from "./shared.js";
export { isAdult };

// ── Who may change what ──────────────────────────────────────────────────────

/**
 * Mirrors the `owner_or_visibility` row policy every table carries: the member
 * who added a row may change or delete it, and so may an adult. Everyone may
 * add. A button this hides is one whose write would do nothing: the hub
 * answers an UPDATE or DELETE of a row the member may not change with a
 * success that changed no rows, not with a refusal.
 */
export function canEdit(row, me) {
  if (!row || !me) return false;
  return row.created_by === me.id || isAdult(me);
}

// ── Tags and locations on an item ────────────────────────────────────────────

/** The ids stored in an item's `tag_ids` / `location_ids` column. */
export function parseIds(value) {
  if (Array.isArray(value)) return value.filter((id) => typeof id === "string");
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function toggleId(ids, id) {
  return ids.includes(id) ? ids.filter((other) => other !== id) : [...ids, id];
}

/** Ids that still name a row. A deleted tag stays in the column until the item
 *  is next saved; it is dropped here so it is never drawn or counted. */
export function liveIds(ids, rows) {
  const known = new Set(rows.map((row) => row.id));
  return ids.filter((id) => known.has(id));
}

/** A name as two people would agree it is the same one. */
export function nameKey(name) {
  return String(name ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/** The row already carrying this name, so "garage" does not sit beside "Garage". */
export function findByName(rows, name) {
  const key = nameKey(name);
  return key ? rows.find((row) => nameKey(row.name) === key) ?? null : null;
}

export function tagsOf(tags, collectionId) {
  return tags.filter((tag) => tag.collection_id === collectionId);
}

// ── Finding items ────────────────────────────────────────────────────────────

/**
 * Everything a person might type to find an item: its name and note, and the
 * names of its tags and the places it is stored. `names` maps a tag or
 * location id to its name.
 */
export function searchableFields(item, names = new Map()) {
  const labels = [...parseIds(item.tag_ids), ...parseIds(item.location_ids)]
    .map((id) => names.get(id))
    .filter(Boolean);
  // The year it was acquired, so "1998" finds everything from that year.
  const year = cleanDate(item.acquired_date)?.slice(0, 4);
  return [item.name, item.note, ...labels, ...(year ? [year] : [])];
}

/**
 * Items in a collection that carry EVERY chosen tag and sit in ANY chosen
 * location. Tags narrow ("Steiff" and "1950s"); an item is only in one place,
 * so two locations mean "either".
 */
export function filterItems(items, { collectionId = null, tagIds = [], locationIds = [] } = {}) {
  return items.filter((item) => {
    if (collectionId && item.collection_id !== collectionId) return false;
    const tags = parseIds(item.tag_ids);
    if (!tagIds.every((id) => tags.includes(id))) return false;
    if (!locationIds.length) return true;
    const locations = parseIds(item.location_ids);
    return locationIds.some((id) => locations.includes(id));
  });
}

/** How many items carry each tag or location id. */
export function countByLabel(items, column) {
  const counts = new Map();
  for (const item of items) {
    for (const id of parseIds(item[column])) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

// ── Photos ───────────────────────────────────────────────────────────────────

/** An item's photos in the order they are shown: `sort_order`, then oldest first. */
export function photosOf(photos, itemId) {
  return photos
    .filter((photo) => photo.item_id === itemId)
    .sort((a, b) => (a.sort_order - b.sort_order) || String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)));
}

export function coverPhoto(photos, itemId) {
  return photosOf(photos, itemId)[0] ?? null;
}

/** The newest item in a collection that has a photo lends the collection its cover. */
export function collectionCover(items, photos, collectionId) {
  const withPhotos = new Set(photos.map((photo) => photo.item_id));
  const item = items.find((candidate) => candidate.collection_id === collectionId && withPhotos.has(candidate.id));
  return item ? coverPhoto(photos, item.id) : null;
}

// ── Cutouts ──────────────────────────────────────────────────────────────────

/**
 * How long a `pending` row is believed. The request is made by the tab that
 * added the photo; if that tab closed before the answer came back, nothing will
 * ever write one. Past this the row reads as failed and may be asked for again.
 */
export const PENDING_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * How long a hold this tab has just taken needs no renewing. Nobody else can
 * take a hold until it is PENDING_TIMEOUT_MS old, so one far younger than that
 * is still ours, and asking the database to confirm it is a wasted request for
 * every photo added. A hold that has waited in the queue longer is renewed.
 */
export const HOLD_FRESH_MS = 60 * 1000;

export function holdIsFresh(stamp, now = Date.now()) {
  const taken = Date.parse(stamp ?? "");
  return Number.isFinite(taken) && now - taken >= 0 && now - taken < HOLD_FRESH_MS;
}

const CUTOUT_STATES = new Set(["none", "pending", "done", "failed", "quota", "unsupported"]);

/**
 * The kinds of picture the hub makes a cutout from. It stores others (a GIF,
 * and a HEIC kept by an earlier version of the app) and answers a request for
 * a cutout of one with a 415, every time.
 */
const CUTOUT_SOURCE_TYPES = /^image\/(jpe?g|png|webp)$/i;

/** Whether a cutout can be made from a stored file of this type. A type that
 *  is not known is not ruled out: the hub decides when it is asked. */
export function cutoutSupported(mimeType) {
  return !mimeType || CUTOUT_SOURCE_TYPES.test(mimeType);
}

/** Where a photo's cutout stands, as the app should treat it right now. */
export function cutoutState(photo, now = Date.now()) {
  if (photo.cutout_file_id) return "done";
  const status = CUTOUT_STATES.has(photo.cutout_status) ? photo.cutout_status : "none";
  // "done" with no file is a row whose cutout was reclaimed or never written.
  if (status === "done") return "failed";
  if (status !== "pending") return status;
  const asked = Date.parse(photo.cutout_requested_at ?? "");
  return Number.isFinite(asked) && now - asked < PENDING_TIMEOUT_MS ? "pending" : "failed";
}

/**
 * Whether asking the hub for a cutout is allowed. A photo that has one, or is
 * waiting for one, is not asked about again: the answer is already here or on
 * its way, and each ask is a file request against the per-minute limit.
 */
export function canRequestCutout(photo, now = Date.now()) {
  const state = cutoutState(photo, now);
  return state === "none" || state === "failed" || state === "quota";
}

/** True when the item should be drawn from its cutout, not the photo as taken. */
export function showsCutout(photo) {
  return !!photo.cutout_file_id && Number(photo.use_cutout) !== 0;
}

/** The file to draw. `small` prefers the small copy of whichever picture is
 *  shown: the cutout's own, or the thumbnail of the photo as taken. Never the
 *  one for the other, which is a different picture. */
export function displayFileId(photo, { small = false } = {}) {
  if (showsCutout(photo)) return (small && photo.cutout_thumb_file_id) || photo.cutout_file_id;
  return (small && photo.thumb_file_id) || photo.file_id;
}

/**
 * What a refused cutout request means for the photo's row.
 *
 *   status   what is written to `cutout_status`
 *   stop     the hub will refuse every request the same way, so stop asking
 *            for the rest of this visit
 *   message  what to tell the person, once
 *
 * A 429 is two different refusals. With a `limit` in the reply it is the
 * household's monthly allowance; without one it is the hub's per-minute limit
 * on file requests, which a retry a little later gets past.
 */
export function cutoutFailure(status, detail = null) {
  if (status === 429 && typeof detail?.limit === "number") {
    return { status: "quota", stop: true, message: `This month's ${detail.limit} photo cutouts are used up. New photos are kept as taken.` };
  }
  if (status === 429) return { status: "failed", stop: false, message: "" };
  if (status === 402) {
    return { status: "none", stop: true, message: "Removing photo backgrounds needs an active plan. Photos are kept as taken." };
  }
  if (status === 403) return { status: "none", stop: true, message: "" };
  if (status === 503) {
    return { status: "failed", stop: true, message: "Removing photo backgrounds is unavailable right now. Photos are kept as taken; try again later." };
  }
  if (status === 413) return { status: "failed", stop: false, message: "That photo is too large to remove the background from." };
  // Not this request's bad luck but the picture's kind: asking again is
  // refused again, so the row says so and is never asked about after.
  if (status === 415) {
    return { status: "unsupported", stop: false, message: "The background can be removed from JPEG, PNG and WebP photos only." };
  }
  // Every cutout after this one would be refused for the same reason.
  if (status === 507) {
    return { status: "failed", stop: true, message: "There is no storage left for photos with the background removed. Photos are kept as taken." };
  }
  return { status: "failed", stop: false, message: "" };
}

/** One line under a photo saying where its cutout stands, or "" when there is nothing to say. */
export function cutoutLabel(state) {
  switch (state) {
    case "pending": return "Removing the background…";
    case "failed": return "The background could not be removed.";
    case "quota": return "This month's cutouts are used up.";
    case "unsupported": return "The background cannot be removed from this kind of picture.";
    default: return "";
  }
}

/**
 * Whether a cutout the hub has just handed back should be deleted because its
 * write matched no row. `rowThere` is whether the photo's row was found when
 * read back (null when that could not be found out) and `named` is the cutout
 * that row now holds.
 *
 * The hub keeps one cutout for a photo and hands the same file to everyone who
 * asks, so a row that is there and names none may be about to be given this
 * very file by whoever holds it now. Only a row that is gone, or names another
 * file, will never name this one.
 */
export function cutoutIsUnnamed(rowThere, named, madeId) {
  if (rowThere === null || rowThere === undefined) return false;
  if (!rowThere) return true;
  return !!named && named !== madeId;
}

/** The most small copies made up for in one visit. */
export const THUMB_BACKFILL_MAX = 40;

/**
 * The photos whose cutout has no small copy and that this member added: the
 * ones to ask the hub about again, which hands back the cutout it already
 * holds, at no cost, and lets a small copy be made of it. A small copy is lost
 * when the request that stores it is refused (a burst of new photos passes the
 * hub's per-minute limit) or its answer never arrives, and the grid then draws
 * the cutout whole. `tried` holds the photos already asked about in this
 * visit, and those this device found to take no copy on an earlier one: one
 * whose cutout is too small to need a copy is not asked about twice. At most `max`, picked from anywhere in the list so that the same few
 * do not use up every visit.
 */
export function missingCutoutThumbs(photos, me, tried = new Set(), max = THUMB_BACKFILL_MAX, random = Math.random) {
  if (!me) return [];
  const missing = photos.filter((photo) =>
    photo.cutout_file_id && !photo.cutout_thumb_file_id && photo.created_by === me.id && !tried.has(photo.id));
  if (missing.length <= max) return missing;
  const start = Math.floor(random() * missing.length);
  return [...missing.slice(start), ...missing.slice(0, start)].slice(0, max);
}

/** The most photos remembered as having a cutout that takes no small copy. */
export const NO_THUMB_MAX = 500;

/**
 * The photos a device remembers as having a cutout that takes no small copy,
 * with one more: the newest `max`, each once. Such a cutout is small enough
 * to be its own copy, so asking about it on every visit would fetch it whole
 * each time for nothing.
 */
export function withNoThumb(remembered, id, max = NO_THUMB_MAX) {
  return [...remembered.filter((held) => held !== id), id].slice(-max);
}

// ── Rows read again ──────────────────────────────────────────────────────────

/**
 * Rows just read, each as the object already held for it where there is one,
 * now carrying what was read. A write on its way holds the object of the row
 * it is changing and sets the outcome on it when the hub answers. Were the
 * rows read again swapped in as new objects, that outcome would land on one
 * no longer on show.
 */
export function intoHeld(held, read) {
  const known = new Map(held.map((row) => [row.id, row]));
  return read.map((row) => {
    const mine = known.get(row.id);
    return mine ? Object.assign(mine, row) : row;
  });
}

/**
 * The rows held that a first page read again does not have. They are further
 * on than a first page reaches, or were deleted on another device, and only
 * the later pages say which. So they are kept until every page is in: an item
 * far down a long collection does not vanish, and the sheet open on it does
 * not close, each time the rows are read again.
 */
export function carriedOver(held, read) {
  const got = new Set(read.map((row) => row.id));
  return held.filter((row) => !got.has(row.id));
}

// ── Writes that changed nothing ──────────────────────────────────────────────

/**
 * True when the hub's answer to an UPDATE or DELETE says no row was changed.
 * That is not a refusal: a row deleted on another device, and a row the member
 * may not change, both come back as a success with `changed: 0`. An answer
 * with no count (demo mode) is taken as a write that landed.
 */
export function wroteNothing(result) {
  return result?.changed === 0;
}

// ── Pictures that did not load ───────────────────────────────────────────────

/**
 * How long to wait before asking again for a picture that failed to load, or
 * null once it has been asked for often enough. The hub allows a member a
 * fixed number of file reads a minute and a long grid scrolled quickly passes
 * it, so the waits together outlast the minute, and each is spread out so that
 * a screenful of tiles does not all ask again at the same moment.
 */
export const IMAGE_RETRY_WAITS_MS = [4_000, 20_000, 60_000];

export function imageRetryDelay(tries, random = Math.random) {
  const wait = IMAGE_RETRY_WAITS_MS[tries];
  return wait === undefined ? null : Math.round(wait * (1 + random() / 2));
}

/** The most statements the hub takes in one batch. */
export const DB_BATCH_MAX = 25;

// ── HEIC photos ──────────────────────────────────────────────────────────────

/** True for a HEIC or HEIF photo, by its type or, when a browser gives it
 *  none, by its name. */
export function isHeic(file) {
  // `.hif` is the same format under the name some cameras give it.
  return /^image\/hei[cf]/i.test(file?.type ?? "") || /\.(hei[cf]|hif)$/i.test(file?.name ?? "");
}

/**
 * Why a HEIC photo that this browser had already turned into a JPEG was not
 * added, when the hub refused the JPEG for its size. A JPEG is larger than the
 * HEIC it was drawn from, so "too large" needs saying in those terms. Null for
 * any other refusal, which is reported as the hub worded it.
 */
export function heicRefusal(name, status) {
  if (status === 413) return `"${name}" is too large to add: a HEIC photo is stored as a JPEG, which is the larger of the two.`;
  if (status === 507) return `There is no storage left for "${name}": a HEIC photo is stored as a JPEG, which is the larger of the two.`;
  return null;
}

/**
 * Why a HEIC photo the hub kept as a HEIC was not added, when the hub's reply
 * says the JPEG was the trouble: it was too large, or there was no room for
 * it. Null when the hub could not convert the photo at all, and for a hub
 * that does not say.
 */
export function heicKeptRefusal(name, uploaded) {
  return heicRefusal(name, { too_large: 413, no_room: 507 }[uploaded?.notConverted]);
}

/** True when the hub kept a picked photo as a HEIC rather than as a JPEG.
 *  `uploaded` is the hub's reply, which names what it stored. A hub that
 *  does not say stored the photo as it was picked. */
export function storedAsHeic(uploaded, picked) {
  return isHeic({ type: uploaded?.mimeType ?? picked?.type, name: uploaded?.name ?? picked?.name });
}

// ── The picture a shared page shows ──────────────────────────────────────────

/**
 * Items whose `cover_file_ids` is not what their photos say it should be, with
 * the value to store: [{ id, value }].
 *
 * A shared collection page shows one picture for each item, and the hub reads
 * it from that column. It should hold the file the item's tile draws at full
 * size: its first photo, as the cutout when the item shows one. The hub puts
 * the photo's own small copy in the tile, so the photo is named, never its
 * thumbnail. An item with no photo holds an empty list.
 *
 * Only call this once every page of `photos` has been read: an item whose
 * photos have not arrived yet looks like an item with none.
 */
export function staleCovers(items, photos) {
  const first = new Map();
  for (const photo of photos) {
    const best = first.get(photo.item_id);
    if (!best || photosOf([best, photo], photo.item_id)[0] === photo) first.set(photo.item_id, photo);
  }
  const stale = [];
  for (const item of items) {
    const cover = first.get(item.id);
    const want = cover ? [displayFileId(cover)] : [];
    const have = parseIds(item.cover_file_ids);
    if (have.length !== want.length || have[0] !== want[0]) stale.push({ id: item.id, value: JSON.stringify(want) });
  }
  return stale;
}

/**
 * The cover writes to send, as the batches to send them in: each a list of
 * { id, value }, none longer than the hub takes in one request. `items` are
 * the ones this member may change. Empty when every cover is already right.
 */
export function coverWrites(items, photos, max = DB_BATCH_MAX) {
  const stale = staleCovers(items, photos);
  const batches = [];
  for (let i = 0; i < stale.length; i += max) batches.push(stale.slice(i, i + max));
  return batches;
}

// ── Rows deleted while more are still arriving ───────────────────────────────

/**
 * Rows from a page that arrived late, less the ones deleted in the meantime.
 * Older items and photos are read behind the first paint, so a page asked for
 * before a delete can land after it, and adding it whole would bring the
 * deleted rows back until the next reload. `gone` holds the ids deleted in this
 * visit: `collections`, `items`, `photos`. A row goes if it was deleted itself
 * or if the collection or item it belongs to was.
 */
export function withoutDeleted(rows, gone) {
  return rows.filter((row) =>
    !gone.items.has(row.id) && !gone.photos.has(row.id)
    && !gone.collections.has(row.collection_id) && !gone.items.has(row.item_id));
}

/** One request for one photo: the row and the stamp of the hold on it. */
export function holdKey(photo) {
  return `${photo.id}|${photo.cutout_requested_at ?? ""}`;
}

/** True when the row itself says a cutout is on its way, whatever its age. */
function unresolved(photo) {
  return !photo.cutout_file_id && photo.cutout_status === "pending";
}

/**
 * A `pending` row past its five minutes that the database has not yet been
 * asked about. Its age alone does not mean it failed: this tab may have been
 * asleep while another finished the cutout, and what it holds is only its own
 * old copy. So it is asked about once before it is believed. `checked` holds
 * the holdKey of every stale request already asked about and found unchanged.
 */
export function needsCheck(photo, heldHere, checked, now = Date.now()) {
  return unresolved(photo) && !heldHere.has(photo.id)
    && cutoutState(photo, now) !== "pending" && !checked.has(holdKey(photo));
}

/**
 * The photos whose cutout someone else is making, or was: every `pending` row
 * this tab does not hold that is either still fresh or stale and not yet
 * checked. Their answer is written by another tab or device, so the only way
 * to learn it is to ask. At most `max`, the most a batch carries; the stale
 * ones go first, since they are the ones shown wrongly until asked about.
 */
export function pendingElsewhere(photos, heldHere, checked = new Set(), now = Date.now(), max = DB_BATCH_MAX) {
  const stale = photos.filter((photo) => needsCheck(photo, heldHere, checked, now));
  const fresh = photos.filter((photo) => unresolved(photo) && !heldHere.has(photo.id) && cutoutState(photo, now) === "pending");
  return [...stale, ...fresh].slice(0, max);
}

// ── Dates ────────────────────────────────────────────────────────────────────

/** A date box's value as it is stored: yyyy-mm-dd for a real day, else null. */
export function cleanDate(value) {
  const text = String(value ?? "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  // Date rolls 31 February over into March; a day that does not exist is not stored.
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? text : null;
}

/** "12 March 2019" for a stored date, or "" for none. It is a calendar day,
 *  not an instant, so it reads the same in every time zone. */
export function formatDate(value, locale = undefined) {
  const clean = cleanDate(value);
  if (!clean) return "";
  const [year, month, day] = clean.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day))
    .toLocaleDateString(locale, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

// ── Small things ─────────────────────────────────────────────────────────────

export function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}
