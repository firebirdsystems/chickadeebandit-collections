import { isAdult } from "./shared.js";
export { isAdult };

// ── Who may change what ──────────────────────────────────────────────────────

/**
 * Mirrors the `owner_or_visibility` row policy every table carries: the member
 * who added a row may change or delete it, and so may an adult. Everyone may
 * add. A button this hides is one the hub would answer with a 403.
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

const CUTOUT_STATES = new Set(["none", "pending", "done", "failed", "quota"]);

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
 * Whether asking the hub for a cutout is allowed. Each request the hub accepts
 * spends one of the household's cutouts for the month, and a second request for
 * the same photo makes a second file, so a photo that has a cutout or is
 * waiting for one is never asked about again.
 */
export function canRequestCutout(photo, now = Date.now()) {
  const state = cutoutState(photo, now);
  return state === "none" || state === "failed" || state === "quota";
}

/** True when the item should be drawn from its cutout, not the photo as taken. */
export function showsCutout(photo) {
  return !!photo.cutout_file_id && Number(photo.use_cutout) !== 0;
}

/** The file to draw. `small` prefers the thumbnail of the photo as taken; a
 *  cutout has no thumbnail and is drawn whole. */
export function displayFileId(photo, { small = false } = {}) {
  if (showsCutout(photo)) return photo.cutout_file_id;
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
  return { status: "failed", stop: false, message: "" };
}

/** One line under a photo saying where its cutout stands, or "" when there is nothing to say. */
export function cutoutLabel(state) {
  switch (state) {
    case "pending": return "Removing the background…";
    case "failed": return "The background could not be removed.";
    case "quota": return "This month's cutouts are used up.";
    default: return "";
  }
}

// ── Images ───────────────────────────────────────────────────────────────────

/** The size to draw a picture at so its longest side is at most `max`. Never enlarges. */
export function fitWithin(width, height, max) {
  const longest = Math.max(width, height);
  if (!longest || longest <= max) return { width, height, scaled: false };
  const scale = max / longest;
  return { width: Math.round(width * scale), height: Math.round(height * scale), scaled: true };
}

export function thumbName(filename) {
  const base = String(filename ?? "").replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9 _-]/g, "").trim().slice(0, 60);
  return `thumb-${base || "photo"}.jpg`;
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
export function pendingElsewhere(photos, heldHere, checked = new Set(), now = Date.now(), max = 25) {
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
