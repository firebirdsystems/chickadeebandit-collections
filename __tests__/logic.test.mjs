import { describe, it, expect } from "vitest";
import {
  canEdit, parseIds, toggleId, liveIds, nameKey, findByName, tagsOf, searchableFields, filterItems, countByLabel,
  photosOf, coverPhoto, collectionCover, cutoutState, canRequestCutout, showsCutout, displayFileId, cutoutFailure,
  cutoutLabel, plural, cleanDate, formatDate, withoutDeleted, pendingElsewhere, needsCheck, holdKey, holdIsFresh, HOLD_FRESH_MS, PENDING_TIMEOUT_MS,
  staleCovers, cutoutIsUnnamed, DB_BATCH_MAX, isHeic, storedAsHeic, heicRefusal, heicKeptRefusal, cutoutSupported, missingCutoutThumbs, withNoThumb, NO_THUMB_MAX, intoHeld, carriedOver,
  THUMB_BACKFILL_MAX, wroteNothing, imageRetryDelay, IMAGE_RETRY_WAITS_MS,
} from "../src/logic.js";

const adult = { id: "a", role: "adult" };
const admin = { id: "z", role: "admin" };
const kid = { id: "k", role: "child" };

describe("canEdit", () => {
  it("lets the member who added a row, and any adult, change it", () => {
    expect(canEdit({ created_by: "k" }, kid)).toBe(true);
    expect(canEdit({ created_by: "k" }, adult)).toBe(true);
    expect(canEdit({ created_by: "k" }, admin)).toBe(true);
  });
  it("refuses another child, a missing row and a missing member", () => {
    expect(canEdit({ created_by: "a" }, kid)).toBe(false);
    expect(canEdit(null, adult)).toBe(false);
    expect(canEdit({ created_by: "k" }, null)).toBe(false);
  });
});

describe("ids stored on an item", () => {
  it("reads a JSON array and nothing else", () => {
    expect(parseIds(`["a","b"]`)).toEqual(["a", "b"]);
    expect(parseIds(["a", 3, "b"])).toEqual(["a", "b"]);
    for (const bad of ["", null, undefined, "not json", `{"a":1}`, `"a"`, 7]) expect(parseIds(bad)).toEqual([]);
    expect(parseIds(`["a",1,null]`)).toEqual(["a"]);
  });
  it("toggles without touching the list it was given", () => {
    const ids = ["a"];
    expect(toggleId(ids, "b")).toEqual(["a", "b"]);
    expect(toggleId(ids, "a")).toEqual([]);
    expect(ids).toEqual(["a"]);
  });
  it("drops ids whose tag is gone", () => {
    expect(liveIds(["a", "gone", "b"], [{ id: "a" }, { id: "b" }])).toEqual(["a", "b"]);
  });
});

describe("names", () => {
  it("treats case and spacing as the same name", () => {
    expect(nameKey("  Bin   1 ")).toBe("bin 1");
    const rows = [{ id: "1", name: "Garage" }];
    expect(findByName(rows, " garage ")).toBe(rows[0]);
    expect(findByName(rows, "Attic")).toBeNull();
    expect(findByName([{ id: "x", name: "" }], "  ")).toBeNull();
  });
  it("keeps tags to their own collection", () => {
    const tags = [{ id: "1", collection_id: "c1" }, { id: "2", collection_id: "c2" }];
    expect(tagsOf(tags, "c1")).toEqual([tags[0]]);
  });
});

describe("finding items", () => {
  const items = [
    { id: "1", collection_id: "c1", name: "Barnaby", note: "From Grandma", tag_ids: `["steiff","gift"]`, location_ids: `["shelf"]` },
    { id: "2", collection_id: "c1", name: "Honey", note: "", tag_ids: `["gift"]`, location_ids: `["bin"]` },
    { id: "3", collection_id: "c2", name: "Drill", note: "", tag_ids: "", location_ids: `["bin","garage"]` },
  ];
  const ids = (list) => list.map((item) => item.id);

  it("is findable by note, tag name and place name, not just its name", () => {
    const names = new Map([["steiff", "Steiff"], ["shelf", "Bedroom shelf"]]);
    const fields = searchableFields(items[0], names);
    expect(fields).toEqual(expect.arrayContaining(["Barnaby", "From Grandma", "Steiff", "Bedroom shelf"]));
    // A tag whose name is unknown adds nothing, and no map is needed at all.
    expect(fields).toHaveLength(4);
    expect(searchableFields(items[2])).toEqual(["Drill", ""]);
  });
  it("narrows to one collection", () => {
    expect(ids(filterItems(items, { collectionId: "c1" }))).toEqual(["1", "2"]);
    expect(ids(filterItems(items))).toEqual(["1", "2", "3"]);
  });
  it("needs every chosen tag", () => {
    expect(ids(filterItems(items, { tagIds: ["gift"] }))).toEqual(["1", "2"]);
    expect(ids(filterItems(items, { tagIds: ["gift", "steiff"] }))).toEqual(["1"]);
  });
  it("needs any one chosen place", () => {
    expect(ids(filterItems(items, { locationIds: ["bin"] }))).toEqual(["2", "3"]);
    expect(ids(filterItems(items, { locationIds: ["shelf", "garage"] }))).toEqual(["1", "3"]);
    expect(ids(filterItems(items, { collectionId: "c1", locationIds: ["bin"], tagIds: ["gift"] }))).toEqual(["2"]);
  });
  it("counts items per tag and per place", () => {
    expect(countByLabel(items, "tag_ids")).toEqual(new Map([["steiff", 1], ["gift", 2]]));
    expect(countByLabel(items, "location_ids").get("bin")).toBe(2);
  });
});

describe("photos of an item", () => {
  const photos = [
    { id: "b", item_id: "1", sort_order: 1, created_at: "2026-01-02" },
    { id: "a", item_id: "1", sort_order: 0, created_at: "2026-01-03" },
    { id: "c", item_id: "1", sort_order: 1, created_at: "2026-01-01" },
    { id: "d", item_id: "2", sort_order: 0, created_at: "2026-01-01" },
  ];
  it("orders by position, then oldest first", () => {
    expect(photosOf(photos, "1").map((photo) => photo.id)).toEqual(["a", "c", "b"]);
    expect(coverPhoto(photos, "1").id).toBe("a");
    expect(coverPhoto(photos, "none")).toBeNull();
  });
  it("covers a collection with its newest item that has a photo", () => {
    const items = [{ id: "9", collection_id: "c1" }, { id: "2", collection_id: "c1" }, { id: "1", collection_id: "c1" }, { id: "x", collection_id: "c2" }];
    expect(collectionCover(items, photos, "c1").id).toBe("d");
    expect(collectionCover(items, photos, "c2")).toBeNull();
  });
});

describe("where a cutout stands", () => {
  const now = Date.parse("2026-01-02T10:10:00Z");
  const asked = (msAgo) => new Date(now - msAgo).toISOString();

  it("is done whenever the row holds a cutout, whatever the status says", () => {
    expect(cutoutState({ cutout_file_id: "f", cutout_status: "pending" }, now)).toBe("done");
  });
  it("believes a pending row only while it is fresh", () => {
    expect(cutoutState({ cutout_status: "pending", cutout_requested_at: asked(PENDING_TIMEOUT_MS - 1) }, now)).toBe("pending");
    expect(cutoutState({ cutout_status: "pending", cutout_requested_at: asked(PENDING_TIMEOUT_MS) }, now)).toBe("failed");
    expect(cutoutState({ cutout_status: "pending", cutout_requested_at: null }, now)).toBe("failed");
    expect(cutoutState({ cutout_status: "pending", cutout_requested_at: "garbage" }, now)).toBe("failed");
  });
  it("reads done-without-a-file as failed and an unknown status as none", () => {
    expect(cutoutState({ cutout_status: "done", cutout_file_id: null }, now)).toBe("failed");
    expect(cutoutState({ cutout_status: "wat" }, now)).toBe("none");
    expect(cutoutState({}, now)).toBe("none");
    for (const status of ["none", "failed", "quota"]) expect(cutoutState({ cutout_status: status }, now)).toBe(status);
  });
  it("never asks again for a photo that has a cutout or is waiting for one", () => {
    expect(canRequestCutout({ cutout_file_id: "f", cutout_status: "done" }, now)).toBe(false);
    expect(canRequestCutout({ cutout_status: "pending", cutout_requested_at: asked(1000) }, now)).toBe(false);
    expect(canRequestCutout({ cutout_status: "pending", cutout_requested_at: asked(PENDING_TIMEOUT_MS + 1) }, now)).toBe(true);
    for (const status of ["none", "failed", "quota"]) expect(canRequestCutout({ cutout_status: status }, now)).toBe(true);
  });
});

describe("a hold on a cutout request", () => {
  const now = Date.parse("2026-01-02T10:10:00Z");
  const taken = (msAgo) => new Date(now - msAgo).toISOString();
  it("needs no renewing while it is far too young for anyone else to take", () => {
    expect(holdIsFresh(taken(0), now)).toBe(true);
    expect(holdIsFresh(taken(HOLD_FRESH_MS - 1), now)).toBe(true);
    expect(holdIsFresh(taken(HOLD_FRESH_MS), now)).toBe(false);
    // Fresh must end well before another requester may take the row.
    expect(HOLD_FRESH_MS * 2).toBeLessThanOrEqual(PENDING_TIMEOUT_MS);
  });
  it("is renewed when its age cannot be trusted", () => {
    for (const bad of [null, undefined, "", "garbage", taken(-5000)]) expect(holdIsFresh(bad, now)).toBe(false);
  });
});

describe("which file is drawn", () => {
  const photo = { file_id: "orig", thumb_file_id: "thumb", cutout_file_id: "cut", use_cutout: 1 };
  it("draws the cutout when there is one and it is switched on", () => {
    expect(showsCutout(photo)).toBe(true);
    expect(displayFileId(photo)).toBe("cut");
    expect(displayFileId(photo, { small: true })).toBe("cut");
  });
  it("draws the cutout's own small copy in a small slot, never the photo's", () => {
    const withSmall = { ...photo, cutout_thumb_file_id: "cut-thumb" };
    expect(displayFileId(withSmall, { small: true })).toBe("cut-thumb");
    expect(displayFileId(withSmall)).toBe("cut");
    // Switched off, the cutout's copy is not the picture being shown.
    expect(displayFileId({ ...withSmall, use_cutout: 0 }, { small: true })).toBe("thumb");
  });
  it("draws the photo as taken when the cutout is switched off or absent", () => {
    expect(showsCutout({ ...photo, use_cutout: 0 })).toBe(false);
    expect(showsCutout({ ...photo, use_cutout: "0" })).toBe(false);
    expect(displayFileId({ ...photo, use_cutout: 0 })).toBe("orig");
    expect(displayFileId({ ...photo, use_cutout: 0 }, { small: true })).toBe("thumb");
    expect(displayFileId({ ...photo, cutout_file_id: null }, { small: true })).toBe("thumb");
    expect(displayFileId({ file_id: "orig", thumb_file_id: null }, { small: true })).toBe("orig");
  });
});

describe("a refused cutout", () => {
  it("tells the monthly allowance apart from the per-minute limit", () => {
    const spent = cutoutFailure(429, { error: "used up", used: 100, limit: 100 });
    expect(spent).toMatchObject({ status: "quota", stop: true });
    expect(spent.message).toContain("100");
    expect(cutoutFailure(429, { error: "Too many requests" })).toEqual({ status: "failed", stop: false, message: "" });
    expect(cutoutFailure(429, null).status).toBe("failed");
  });
  it("leaves the photo unasked when the household or the app may not have cutouts", () => {
    expect(cutoutFailure(402)).toMatchObject({ status: "none", stop: true });
    expect(cutoutFailure(402).message).toMatch(/plan/);
    expect(cutoutFailure(403)).toEqual({ status: "none", stop: true, message: "" });
  });
  it("stops asking while the service is unavailable, and keeps going after one bad photo", () => {
    expect(cutoutFailure(503)).toMatchObject({ status: "failed", stop: true });
    expect(cutoutFailure(502)).toEqual({ status: "failed", stop: false, message: "" });
    expect(cutoutFailure(413).message).toMatch(/too large/);
    expect(cutoutFailure(undefined)).toEqual({ status: "failed", stop: false, message: "" });
  });
  it("has a line for each state worth explaining", () => {
    for (const state of ["pending", "failed", "quota", "unsupported"]) expect(cutoutLabel(state)).not.toBe("");
    for (const state of ["none", "done"]) expect(cutoutLabel(state)).toBe("");
  });
});

describe("a picture the hub makes no cutout from", () => {
  it("is settled for good by the hub's 415, and the rest of the queue goes on", () => {
    expect(cutoutFailure(415)).toMatchObject({ status: "unsupported", stop: false });
    expect(cutoutFailure(415).message).toMatch(/JPEG, PNG and WebP/);
  });
  it("is never asked about again, unlike one that merely failed", () => {
    const row = { cutout_file_id: null, cutout_status: "unsupported", cutout_requested_at: "2026-01-01T00:00:00.000Z" };
    expect(cutoutState(row)).toBe("unsupported");
    expect(canRequestCutout(row)).toBe(false);
    expect(canRequestCutout({ ...row, cutout_status: "failed" })).toBe(true);
  });
  it("is known by its type before it is asked about", () => {
    for (const type of ["image/jpeg", "image/jpg", "image/png", "image/webp", "IMAGE/PNG"]) expect(cutoutSupported(type), type).toBe(true);
    for (const type of ["image/gif", "image/heic", "image/heif", "application/pdf"]) expect(cutoutSupported(type), type).toBe(false);
  });
  it("is not ruled out while its type is unknown", () => {
    expect(cutoutSupported(undefined)).toBe(true);
    expect(cutoutSupported("")).toBe(true);
  });
});

describe("cutouts with no small copy", () => {
  const me = { id: "k", role: "child" };
  const photo = (id, extra = {}) => ({ id, file_id: `f-${id}`, cutout_file_id: `c-${id}`, cutout_thumb_file_id: null, created_by: "k", ...extra });
  it("are this member's photos that have a cutout and no copy of it", () => {
    const rows = [
      photo("p1"),
      photo("p2", { cutout_thumb_file_id: "t2" }),
      photo("p3", { cutout_file_id: null }),
      photo("p4", { created_by: "someone-else" }),
    ];
    expect(missingCutoutThumbs(rows, me).map((row) => row.id)).toEqual(["p1"]);
  });
  it("leave out a photo already asked about in this visit", () => {
    expect(missingCutoutThumbs([photo("p1"), photo("p2")], me, new Set(["p1"])).map((row) => row.id)).toEqual(["p2"]);
  });
  it("are nobody's when nobody is looking", () => {
    expect(missingCutoutThumbs([photo("p1")], null)).toEqual([]);
  });
  it("are taken a bounded number at a time, from anywhere in the list", () => {
    const rows = Array.from({ length: THUMB_BACKFILL_MAX + 10 }, (_, i) => photo(`p${i}`));
    expect(missingCutoutThumbs(rows, me, new Set(), THUMB_BACKFILL_MAX, () => 0)).toHaveLength(THUMB_BACKFILL_MAX);
    const fromTheEnd = missingCutoutThumbs(rows, me, new Set(), 3, () => 0.999).map((row) => row.id);
    expect(fromTheEnd).toEqual([`p${rows.length - 1}`, "p0", "p1"]);
  });
});

describe("photos remembered as taking no small copy", () => {
  it("gain one more, once", () => {
    expect(withNoThumb(["p1"], "p2")).toEqual(["p1", "p2"]);
    expect(withNoThumb(["p1", "p2"], "p1")).toEqual(["p2", "p1"]);
  });
  it("are the newest of them past the most that is kept", () => {
    const full = Array.from({ length: NO_THUMB_MAX }, (_, i) => `p${i}`);
    const kept = withNoThumb(full, "new");
    expect(kept).toHaveLength(NO_THUMB_MAX);
    expect(kept[0]).toBe("p1");
    expect(kept.at(-1)).toBe("new");
  });
});

describe("rows read again", () => {
  it("land on the objects already held, so a write on its way still changes the row on show", () => {
    const held = { id: "p1", cutout_status: "pending", cutout_file_id: null };
    const rows = intoHeld([held, { id: "p2" }], [{ id: "p1", cutout_status: "pending", cutout_file_id: null }, { id: "p3" }]);
    expect(rows[0]).toBe(held);
    // The write that held it answers after the rows were read again.
    Object.assign(held, { cutout_status: "done", cutout_file_id: "cut-1" });
    expect(rows[0].cutout_file_id).toBe("cut-1");
  });
  it("carry what was read, in the order read, without rows that are gone", () => {
    const held = { id: "i1", name: "Old" };
    const rows = intoHeld([held, { id: "i2", name: "Gone" }], [{ id: "i3", name: "New" }, { id: "i1", name: "Renamed" }]);
    expect(rows.map((row) => row.id)).toEqual(["i3", "i1"]);
    expect(held.name).toBe("Renamed");
  });
});

describe("rows a first page read again does not have", () => {
  it("are the ones held and not read, in the order held", () => {
    const held = [{ id: "i1" }, { id: "i2" }, { id: "i3" }];
    expect(carriedOver(held, [{ id: "i2" }, { id: "i9" }])).toEqual([held[0], held[2]]);
  });
  it("are none on a first read, and none when the page has them all", () => {
    expect(carriedOver([], [{ id: "i1" }])).toEqual([]);
    expect(carriedOver([{ id: "i1" }], [{ id: "i1" }])).toEqual([]);
  });
});

describe("a write that changed nothing", () => {
  it("is the hub's success with no row changed", () => {
    expect(wroteNothing({ rows: [], changed: 0 })).toBe(true);
    expect(wroteNothing({ rows: [], changed: 1 })).toBe(false);
  });
  it("is not assumed when the answer carries no count", () => {
    expect(wroteNothing({ rows: [] })).toBe(false);
    expect(wroteNothing(undefined)).toBe(false);
  });
});

describe("a picture that did not load", () => {
  it("is asked for again after longer and longer waits, then left", () => {
    const waits = IMAGE_RETRY_WAITS_MS.map((_, tries) => imageRetryDelay(tries, () => 0));
    expect(waits).toEqual(IMAGE_RETRY_WAITS_MS);
    expect([...waits].sort((a, b) => a - b)).toEqual(waits);
    expect(imageRetryDelay(IMAGE_RETRY_WAITS_MS.length)).toBeNull();
  });
  it("waits, all told, longer than the minute the hub's limit is counted over", () => {
    expect(IMAGE_RETRY_WAITS_MS.reduce((sum, wait) => sum + wait, 0)).toBeGreaterThan(60_000);
  });
  it("spreads a screenful of tiles out, by up to half as long again", () => {
    expect(imageRetryDelay(0, () => 0.5)).toBe(IMAGE_RETRY_WAITS_MS[0] * 1.25);
    expect(imageRetryDelay(0, () => 0.999)).toBeLessThan(IMAGE_RETRY_WAITS_MS[0] * 1.5 + 1);
  });
});

describe("a page that arrives after a delete", () => {
  const gone = { collections: new Set(["c-gone"]), items: new Set(["i-gone"]), photos: new Set(["p-gone"]) };
  const ids = (rows) => rows.map((row) => row.id);
  it("leaves out deleted items, and items of a deleted collection", () => {
    const page = [{ id: "i1", collection_id: "c1" }, { id: "i-gone", collection_id: "c1" }, { id: "i2", collection_id: "c-gone" }];
    expect(ids(withoutDeleted(page, gone))).toEqual(["i1"]);
  });
  it("leaves out deleted photos, and photos of a deleted item or collection", () => {
    const page = [
      { id: "p1", item_id: "i1", collection_id: "c1" }, { id: "p-gone", item_id: "i1", collection_id: "c1" },
      { id: "p2", item_id: "i-gone", collection_id: "c1" }, { id: "p3", item_id: "i3", collection_id: "c-gone" },
    ];
    expect(ids(withoutDeleted(page, gone))).toEqual(["p1"]);
  });
  it("keeps everything when nothing was deleted", () => {
    const none = { collections: new Set(), items: new Set(), photos: new Set() };
    expect(withoutDeleted([{ id: "i1", collection_id: "c1" }], none)).toHaveLength(1);
  });
});

describe("cutouts being made somewhere else", () => {
  const now = Date.parse("2026-01-02T10:10:00Z");
  const asked = (msAgo) => new Date(now - msAgo).toISOString();
  const photos = [
    { id: "ours", cutout_status: "pending", cutout_requested_at: asked(1000) },
    { id: "theirs", cutout_status: "pending", cutout_requested_at: asked(1000) },
    { id: "stale", cutout_status: "pending", cutout_requested_at: asked(PENDING_TIMEOUT_MS + 1) },
    { id: "done", cutout_status: "done", cutout_file_id: "f" },
    { id: "none", cutout_status: "none" },
  ];
  const held = new Map([["ours", "x"]]);
  const stale = photos[2];

  it("are the pending rows this tab does not hold, an old one first", () => {
    expect(pendingElsewhere(photos, held, new Set(), now).map((p) => p.id)).toEqual(["stale", "theirs"]);
  });
  it("include an old request until it has been asked about once, and not after", () => {
    // The tab slept through someone else's cutout: its copy is old, not failed.
    expect(needsCheck(stale, held, new Set(), now)).toBe(true);
    const checked = new Set([holdKey(stale)]);
    expect(needsCheck(stale, held, checked, now)).toBe(false);
    expect(pendingElsewhere(photos, held, checked, now).map((p) => p.id)).toEqual(["theirs"]);
  });
  it("ask again when the same photo is taken afresh and goes stale again", () => {
    const checked = new Set([holdKey(stale)]);
    const retaken = { ...stale, cutout_requested_at: asked(PENDING_TIMEOUT_MS + 5) };
    expect(holdKey(retaken)).not.toBe(holdKey(stale));
    expect(needsCheck(retaken, held, checked, now)).toBe(true);
  });
  it("never count a fresh request, a held one, or a settled one as needing a check", () => {
    const none = new Set();
    expect(needsCheck(photos[1], held, none, now)).toBe(false);
    expect(needsCheck({ ...stale, id: "ours" }, held, none, now)).toBe(false);
    expect(needsCheck({ ...stale, cutout_file_id: "f" }, held, none, now)).toBe(false);
    expect(needsCheck({ ...stale, cutout_status: "failed" }, held, none, now)).toBe(false);
  });
  it("are asked about a batch at a time", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, cutout_status: "pending", cutout_requested_at: asked(1000) }));
    expect(pendingElsewhere(many, new Set(), new Set(), now)).toHaveLength(25);
    expect(pendingElsewhere(many, new Set(), new Set(), now, 3)).toHaveLength(3);
  });
});

describe("the acquired date", () => {
  it("is stored as a real day or not at all", () => {
    expect(cleanDate("2019-12-25")).toBe("2019-12-25");
    expect(cleanDate(" 2020-02-29 ")).toBe("2020-02-29");
    for (const bad of ["", null, undefined, "2019-02-30", "2019-13-01", "25/12/2019", "2019-12-25T00:00:00Z", "2019-1-5"]) {
      expect(cleanDate(bad)).toBeNull();
    }
  });
  it("reads as the same day in every time zone", () => {
    expect(formatDate("2019-12-25", "en-GB")).toBe("25 December 2019");
    expect(formatDate("2019-01-01", "en-US")).toBe("January 1, 2019");
    expect(formatDate(null)).toBe("");
    expect(formatDate("nonsense")).toBe("");
  });
  it("makes an item findable by the year it was acquired", () => {
    expect(searchableFields({ name: "Barnaby", note: "", acquired_date: "1998-06-01" })).toContain("1998");
    expect(searchableFields({ name: "Barnaby", note: "", acquired_date: null })).toEqual(["Barnaby", ""]);
  });
});

it("plural", () => {
  expect(plural(1, "item")).toBe("1 item");
  expect(plural(0, "item")).toBe("0 items");
  expect(plural(2, "match", "matches")).toBe("2 matches");
});

describe("the picture a shared page shows for an item", () => {
  const photo = (over) => ({ id: "p1", item_id: "i1", file_id: "f1", thumb_file_id: "t1", cutout_file_id: null, use_cutout: 1, sort_order: 0, created_at: "2026-01-01", ...over });
  const item = (cover) => ({ id: "i1", cover_file_ids: cover });

  it("is the first photo as taken, never its thumbnail", () => {
    expect(staleCovers([item("")], [photo()])).toEqual([{ id: "i1", value: '["f1"]' }]);
  });
  it("is the cutout when the item shows one, and the photo again when it is switched off", () => {
    expect(staleCovers([item('["f1"]')], [photo({ cutout_file_id: "c1" })])).toEqual([{ id: "i1", value: '["c1"]' }]);
    expect(staleCovers([item('["c1"]')], [photo({ cutout_file_id: "c1", use_cutout: 0 })])).toEqual([{ id: "i1", value: '["f1"]' }]);
  });
  it("follows the order the photos are shown in", () => {
    const later = photo({ id: "p2", file_id: "f2", sort_order: 1 });
    const earlier = photo({ id: "p3", file_id: "f3", sort_order: 0, created_at: "2025-01-01" });
    expect(staleCovers([item("")], [later, photo(), earlier])).toEqual([{ id: "i1", value: '["f3"]' }]);
  });
  it("is emptied when the last photo goes", () => {
    expect(staleCovers([item('["f1"]')], [])).toEqual([{ id: "i1", value: "[]" }]);
  });
  it("leaves alone an item that is already right", () => {
    expect(staleCovers([item('["f1"]')], [photo()])).toEqual([]);
    // No photo: the column's default, an empty list and a missing value all mean none.
    expect(staleCovers([item(""), { id: "i2", cover_file_ids: "[]" }, { id: "i3" }], [])).toEqual([]);
  });
  it("judges each item by its own photos", () => {
    const rows = [item(""), { id: "i2", cover_file_ids: "" }];
    expect(staleCovers(rows, [photo({ item_id: "i2", file_id: "f9" })])).toEqual([{ id: "i2", value: '["f9"]' }]);
  });
});

describe("a cutout whose write matched no row", () => {
  // The hub hands every asker the photo's one cutout, so the file is deleted
  // only when no row will ever name it.
  it("is deleted when the photo's row is gone", () => {
    expect(cutoutIsUnnamed(false, null, "cut-1")).toBe(true);
  });
  it("is deleted when the row already names a different cutout", () => {
    expect(cutoutIsUnnamed(true, "cut-2", "cut-1")).toBe(true);
  });
  it("is kept when the row names it: the write landed and its answer was lost", () => {
    expect(cutoutIsUnnamed(true, "cut-1", "cut-1")).toBe(false);
  });
  it("is kept when the row is there and names none: whoever holds it is about to write this same file", () => {
    expect(cutoutIsUnnamed(true, null, "cut-1")).toBe(false);
  });
  it("is kept when the row could not be read back", () => {
    expect(cutoutIsUnnamed(null, null, "cut-1")).toBe(false);
    expect(cutoutIsUnnamed(undefined, null, "cut-1")).toBe(false);
  });
});

describe("refusals that are not the photo's fault", () => {
  it("stops asking once storage is full, and says so", () => {
    const full = cutoutFailure(507, { scope: "app" });
    expect(full).toMatchObject({ status: "failed", stop: true });
    expect(full.message).toMatch(/no storage left/);
  });
  it("leaves a photo whose cutout another request is still making free to be asked for again", () => {
    expect(cutoutFailure(409)).toEqual({ status: "failed", stop: false, message: "" });
  });
  it("asks about as many photos at once as one batch carries", () => {
    const waiting = Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, cutout_status: "pending", cutout_requested_at: new Date().toISOString() }));
    expect(pendingElsewhere(waiting, new Map())).toHaveLength(DB_BATCH_MAX);
  });
});

describe("HEIC photos", () => {
  it("are known by type, or by name when the browser gives no type", () => {
    expect(isHeic({ type: "image/heic", name: "a" })).toBe(true);
    expect(isHeic({ type: "image/heif-sequence", name: "a" })).toBe(true);
    expect(isHeic({ type: "", name: "IMG_0042.HEIC" })).toBe(true);
    expect(isHeic({ type: "", name: "DSC00012.HIF" })).toBe(true);
    expect(isHeic({ type: "image/jpeg", name: "IMG_0042.jpeg" })).toBe(false);
    expect(isHeic({ type: "", name: "notes.txt" })).toBe(false);
    expect(isHeic(null)).toBe(false);
  });
  it("are told apart by what the hub says it stored, not by what was picked", () => {
    const picked = { type: "image/heic", name: "IMG_0042.HEIC" };
    expect(storedAsHeic({ id: "f1", name: "IMG_0042.jpg", mimeType: "image/jpeg" }, picked)).toBe(false);
    expect(storedAsHeic({ id: "f1", name: "IMG_0042.HEIC", mimeType: "image/heic" }, picked)).toBe(true);
    expect(storedAsHeic({ id: "f1", name: "bear.jpg", mimeType: "image/jpeg" }, { type: "image/jpeg", name: "bear.jpg" })).toBe(false);
  });
  it("say so when the JPEG made of one is what the hub had no room for", () => {
    expect(heicRefusal("IMG_0042.HEIC", 413)).toMatch(/"IMG_0042\.HEIC" is too large/);
    expect(heicRefusal("IMG_0042.HEIC", 507)).toMatch(/no storage left/);
    expect(heicRefusal("IMG_0042.HEIC", 429)).toBeNull();
    expect(heicRefusal("IMG_0042.HEIC", 0)).toBeNull();
  });
  it("say so when the hub kept one because the JPEG was the trouble", () => {
    expect(heicKeptRefusal("IMG_0042.HEIC", { id: "f1", notConverted: "too_large" })).toMatch(/"IMG_0042\.HEIC" is too large/);
    expect(heicKeptRefusal("IMG_0042.HEIC", { id: "f1", notConverted: "no_room" })).toMatch(/no storage left/);
    // Not converted at all, or a hub that does not say: the general message stands.
    expect(heicKeptRefusal("IMG_0042.HEIC", { id: "f1", notConverted: "unavailable" })).toBeNull();
    expect(heicKeptRefusal("IMG_0042.HEIC", { id: "f1" })).toBeNull();
    expect(heicKeptRefusal("IMG_0042.HEIC", null)).toBeNull();
  });
  it("are taken as stored the way they were picked by a hub that does not say", () => {
    expect(storedAsHeic({ id: "f1" }, { type: "image/heic", name: "IMG_0042.HEIC" })).toBe(true);
    expect(storedAsHeic({ id: "f1" }, { type: "", name: "IMG_0042.heic" })).toBe(true);
    expect(storedAsHeic({ id: "f1" }, { type: "image/png", name: "bear.png" })).toBe(false);
  });
});
