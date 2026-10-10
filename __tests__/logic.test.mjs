import { describe, it, expect } from "vitest";
import {
  canEdit, parseIds, toggleId, liveIds, nameKey, findByName, tagsOf, searchableFields, filterItems, countByLabel,
  photosOf, coverPhoto, collectionCover, cutoutState, canRequestCutout, showsCutout, displayFileId, cutoutFailure,
  cutoutLabel, fitWithin, thumbName, plural, cleanDate, formatDate, withoutDeleted, pendingElsewhere, needsCheck, holdKey, holdIsFresh, HOLD_FRESH_MS, PENDING_TIMEOUT_MS,
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
    expect(cutoutFailure(415).stop).toBe(false);
    expect(cutoutFailure(413).message).toMatch(/too large/);
    expect(cutoutFailure(undefined)).toEqual({ status: "failed", stop: false, message: "" });
  });
  it("has a line for each state worth explaining", () => {
    for (const state of ["pending", "failed", "quota"]) expect(cutoutLabel(state)).not.toBe("");
    for (const state of ["none", "done"]) expect(cutoutLabel(state)).toBe("");
  });
});

describe("images", () => {
  it("shrinks to the longest side and never enlarges", () => {
    expect(fitWithin(4000, 3000, 480)).toEqual({ width: 480, height: 360, scaled: true });
    expect(fitWithin(3000, 4000, 480)).toEqual({ width: 360, height: 480, scaled: true });
    expect(fitWithin(480, 300, 480)).toEqual({ width: 480, height: 300, scaled: false });
    expect(fitWithin(0, 0, 480).scaled).toBe(false);
  });
  it("names a thumbnail from the photo, safely", () => {
    expect(thumbName("IMG_0042.HEIC")).toBe("thumb-IMG_0042.jpg");
    expect(thumbName("../../etc/pass<wd>.png")).toBe("thumb-etcpasswd.jpg");
    expect(thumbName("")).toBe("thumb-photo.jpg");
    expect(thumbName("x".repeat(200) + ".jpg").length).toBeLessThanOrEqual(70);
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
