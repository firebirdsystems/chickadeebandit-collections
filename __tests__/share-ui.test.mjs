/**
 * The share panel's controller, driven the way the page drives it.
 *
 * What is worth covering is ordering and failure rather than markup: two reads
 * of the link list in flight at once, a panel closed or reopened while a
 * request is out, a refused read that must not look like "no links", and a
 * mint whose follow-up read fails. This file is identical in every app that
 * ships src/share.js.
 */

import { describe, it, expect, vi } from "vitest";
import { createShareUi } from "../src/share.js";

/** Same shape as the SDK's activeShareLinks (tested in the hub). */
const activeShareLinks = (links, itemId, now = new Date()) =>
  (links ?? []).filter((l) =>
    (itemId === undefined || l.itemId === itemId)
    && !l.revokedAt && new Date(l.expiresAt).getTime() > now.getTime());

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const ME = { id: "adult-1", name: "Alex" };
const LATER = new Date(Date.now() + 7 * 864e5).toISOString();

function link(over = {}) {
  return {
    id: "link-1", url: "https://hub.example/share/abc", itemId: "item-1",
    createdBy: ME.id, expiresAt: LATER, revokedAt: null, viewCount: 0, ...over,
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = async (n = 10) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

const ok = (links) => ({ enabled: true, entitled: true, bundle: null, limits: { maxActive: 100 }, links });
const refused = () => ({ enabled: true, entitled: false, bundle: null, limits: null, links: [] });

/** Same shape as the SDK's shareCalendarUrl (tested in the hub). */
const calendarUrl = (l) => (typeof l?.calendarUrl === "string" && /^https?:\/\//.test(l.calendarUrl)
  ? l.calendarUrl.replace(/^https?:\/\//, "webcal://") : null);

function harness({
  lists = [ok([])], admin = false, confirm = true, create, writeText, calendar = false, extra = {},
} = {}) {
  const queue = [...lists];
  const share = {
    enabled: true,
    listAll: vi.fn(() => {
      const next = queue.length > 1 ? queue.shift() : queue[0];
      return next instanceof Promise ? next : Promise.resolve(next);
    }),
    create: create ?? vi.fn(async () => ({ id: "link-new", url: "https://hub.example/share/new", expiresAt: LATER })),
    revoke: vi.fn(async () => ({ success: true })),
  };
  const view = { html: "", shown: false, show() { this.shown = true; }, render(h) { this.html = h; }, hide() { this.shown = false; this.html = ""; } };
  const ui = createShareUi({
    share,
    itemType: "thing",
    noun: "thing",
    scopeHtml: () => "Only the title and body are shown.",
    esc,
    confirm: vi.fn(async () => confirm),
    writeText: writeText ?? vi.fn(async () => {}),
    activeLinks: activeShareLinks,
    expiryChoices: [{ hours: 24, label: "1 day" }, { hours: 168, label: "7 days" }],
    defaultExpiryHours: 168,
    getMe: () => ME,
    isAdmin: () => admin,
    memberName: (id) => ({ "adult-2": "Morgan" }[id] ?? ""),
    view,
    ...(calendar ? { calendarUrl } : {}),
    ...extra,
  });
  return { ui, share, view, push: (l) => queue.push(l) };
}

const createDisabled = (html) => /data-share-action="create"[^>]*\bdisabled\b/.test(html);
const typePassword = (ui, value) => ui.handleChange({ target: { dataset: { shareAction: "password" }, value } });
const selectedExpiry = (html) => html.match(/<option value="(\w+)" selected>/)?.[1];

describe("share panel", () => {
  it("lists only live links for the open item, and enables create once the list is read", async () => {
    const h = harness({ lists: [ok([
      link(),
      link({ id: "other", itemId: "item-2", url: "https://hub.example/share/other" }),
      link({ id: "dead", url: "https://hub.example/share/dead", revokedAt: "2026-01-01T00:00:00Z" }),
    ])] });
    const opening = h.ui.open({ id: "item-1", title: "Wifi" });
    expect(h.view.shown).toBe(true);
    expect(h.view.html).toContain("Checking existing links");
    expect(createDisabled(h.view.html)).toBe(true);
    await opening;
    expect(h.view.html).toContain("share/abc");
    expect(h.view.html).not.toContain("share/other");
    expect(h.view.html).not.toContain("share/dead");
    expect(createDisabled(h.view.html)).toBe(false);
    expect(h.view.html).toContain("Only the title and body are shown.");
  });

  it("treats a refused list read as refused, not as no links", async () => {
    const h = harness({ lists: [refused()] });
    await h.ui.open({ id: "item-1", title: "Wifi" });
    expect(h.view.html).toContain('data-testid="share-refused"');
    expect(h.view.html).not.toContain('data-testid="share-empty"');
    expect(createDisabled(h.view.html)).toBe(true);
    await h.ui.create();
    expect(h.share.create).not.toHaveBeenCalled();
  });

  it("treats a rejected fetch the same as a refusal", async () => {
    const h = harness({ lists: [Promise.reject(new Error("offline"))] });
    await h.ui.open({ id: "item-1", title: "Wifi" });
    expect(h.view.html).toContain('data-testid="share-refused"');
  });

  it("mints with the item type, id, title and chosen expiry, then copies the url", async () => {
    const h = harness({ lists: [ok([]), ok([link({ id: "link-new", url: "https://hub.example/share/new" })])] });
    await h.ui.open({ id: "item-1", title: "Wifi" });
    h.ui.handleChange({ target: { dataset: { shareAction: "expiry" }, value: "24" } });
    await h.ui.create();
    expect(h.share.create).toHaveBeenCalledWith("thing", "item-1", { expiresInHours: 24, label: "Wifi" });
    expect(h.view.html).toContain("share/new");
    expect(h.view.html).toContain("Link created and copied.");
    expect(createDisabled(h.view.html)).toBe(false);
  });

  it("drops a stale read that lands after a newer one", async () => {
    const first = deferred();
    const second = deferred();
    const h = harness({ lists: [first.promise, second.promise] });
    const opening = h.ui.open({ id: "item-1", title: "Wifi" });
    // Reopen on the same item: a new session and a second read.
    const reopening = h.ui.open({ id: "item-1", title: "Wifi" });
    second.resolve(ok([link({ url: "https://hub.example/share/fresh" })]));
    await reopening;
    first.resolve(ok([]));
    await opening;
    expect(h.view.html).toContain("share/fresh");
  });

  it("shows the minted link when the follow-up read fails", async () => {
    const h = harness({ lists: [ok([]), refused()] });
    await h.ui.open({ id: "item-1", title: "Wifi" });
    await h.ui.create();
    expect(h.view.html).toContain("share/new");
    expect(h.view.html).toContain("couldn’t be refreshed");
    // One blip after a good read is not "sharing is off".
    expect(h.view.html).not.toContain('data-testid="share-refused"');
  });

  it("reports a refused mint and re-enables the button", async () => {
    const h = harness({ create: vi.fn(async () => { throw new Error("Too many active links"); }) });
    await h.ui.open({ id: "item-1", title: "Wifi" });
    await h.ui.create();
    expect(h.view.html).toContain("Too many active links");
    expect(createDisabled(h.view.html)).toBe(false);
  });

  it("says so when the clipboard write fails after a mint", async () => {
    const h = harness({
      lists: [ok([]), ok([link({ id: "link-new", url: "https://hub.example/share/new" })])],
      writeText: vi.fn(async () => { throw new Error("denied"); }),
    });
    await h.ui.open({ id: "item-1", title: "Wifi" });
    await h.ui.create();
    expect(h.view.html).toContain("Select it above to copy");
  });

  it("keeps a newer read's list when an older read in the same session lands last", async () => {
    // Revoke and create both re-read the list. The revoke's read goes out
    // first but answers last, without the link the create just made.
    const revokeRead = deferred();
    const createRead = deferred();
    const h = harness({ lists: [ok([link()]), revokeRead.promise, createRead.promise] });
    await h.ui.open({ id: "item-1", title: "Wifi" });
    const revoking = h.ui.revoke("link-1");
    await flush();
    const creating = h.ui.create();
    await flush();
    createRead.resolve(ok([link({ id: "link-new", url: "https://hub.example/share/new" })]));
    await creating;
    revokeRead.resolve(ok([]));
    await revoking;
    expect(h.view.html).toContain("share/new");
  });

  it("paints nothing, and leaves the clipboard alone, after the panel closes mid-create", async () => {
    const minting = deferred();
    const writeText = vi.fn(async () => {});
    const h = harness({ create: vi.fn(() => minting.promise), writeText });
    await h.ui.open({ id: "item-1", title: "Wifi" });
    const creating = h.ui.create();
    h.ui.close();
    expect(h.view.shown).toBe(false);
    minting.resolve({ id: "link-new", url: "https://hub.example/share/new", expiresAt: LATER });
    await creating;
    expect(h.view.html).toBe("");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("does not carry one item's result into the next item's panel", async () => {
    const minting = deferred();
    const h = harness({ create: vi.fn(() => minting.promise) });
    await h.ui.open({ id: "item-1", title: "Wifi" });
    const creating = h.ui.create();
    await h.ui.open({ id: "item-2", title: "Door code" });
    minting.resolve({ id: "link-new", url: "https://hub.example/share/new", expiresAt: LATER });
    await creating;
    expect(h.view.html).toContain("Door code");
    expect(h.view.html).not.toContain("Link created");
    expect(createDisabled(h.view.html)).toBe(false);
  });

  it("revokes only after confirmation and drops the link even if the re-read fails", async () => {
    const h = harness({ lists: [ok([link()]), refused()] });
    await h.ui.open({ id: "item-1", title: "Wifi" });
    await h.ui.revoke("link-1");
    expect(h.share.revoke).toHaveBeenCalledWith("link-1");
    expect(h.view.html).not.toContain("share/abc");
    expect(h.view.html).toContain("Link revoked.");
  });

  it("does nothing when revoke is not confirmed", async () => {
    const h = harness({ lists: [ok([link()])], confirm: false });
    await h.ui.open({ id: "item-1", title: "Wifi" });
    await h.ui.revoke("link-1");
    expect(h.share.revoke).not.toHaveBeenCalled();
    expect(h.view.html).toContain("share/abc");
  });

  it("offers revoke on another adult's link only to an admin, and names who made it", async () => {
    const theirs = link({ createdBy: "adult-2" });
    const member = harness({ lists: [ok([theirs])] });
    await member.ui.open({ id: "item-1", title: "Wifi" });
    expect(member.view.html).toContain("shared by Morgan");
    expect(member.view.html).not.toContain('data-share-action="revoke"');

    const admin = harness({ lists: [ok([theirs])], admin: true });
    await admin.ui.open({ id: "item-1", title: "Wifi" });
    expect(admin.view.html).toContain('data-share-action="revoke"');
  });

  it("escapes the title, urls and link ids", async () => {
    const h = harness({ lists: [ok([link({ id: `x" onclick="bad`, url: `https://e/<b>` })])] });
    await h.ui.open({ id: "item-1", title: `<img src=x onerror=alert(1)>` });
    expect(h.view.html).not.toContain("<img");
    expect(h.view.html).not.toContain("<b>");
    expect(h.view.html).not.toContain(`" onclick="bad`);
  });

  it("offers a calendar link only on links that serve one, and copies it in webcal form", async () => {
    const writeText = vi.fn(async () => {});
    const h = harness({
      calendar: true,
      writeText,
      lists: [ok([
        link({ calendarUrl: "https://hub.example/api/share/abc/calendar.ics" }),
        // A password link serves no feed, so the hub sends no calendarUrl.
        link({ id: "link-pw", url: "https://hub.example/share/pw" }),
      ])],
    });
    await h.ui.open({ id: "item-1", title: "Soccer" });
    expect(h.view.html).toContain('data-testid="share-calendar-note"');
    expect(h.view.html.match(/data-share-action="copy-calendar"/g)).toHaveLength(1);
    expect(h.view.html).toContain('data-share-action="copy-calendar" data-link-id="link-1"');
    await h.ui.copy("link-1", "calendar");
    expect(writeText).toHaveBeenCalledWith("webcal://hub.example/api/share/abc/calendar.ics");
    expect(h.view.html).toContain("Calendar link copied.");
    writeText.mockClear();
    await h.ui.copy("link-pw", "calendar");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("says the calendar link out loud when the clipboard refuses it", async () => {
    const h = harness({
      calendar: true,
      writeText: vi.fn(async () => { throw new Error("denied"); }),
      lists: [ok([link({ calendarUrl: "https://hub.example/api/share/abc/calendar.ics" })])],
    });
    await h.ui.open({ id: "item-1", title: "Soccer" });
    await h.ui.copy("link-1", "calendar");
    expect(h.view.html).toContain("The calendar link is webcal://hub.example/api/share/abc/calendar.ics");
  });

  it("keeps the calendar link when a mint's follow-up read fails", async () => {
    const h = harness({
      calendar: true,
      lists: [ok([]), refused()],
      create: vi.fn(async () => ({
        id: "link-new", url: "https://hub.example/share/new", expiresAt: LATER,
        calendarUrl: "https://hub.example/api/share/new/calendar.ics",
      })),
    });
    await h.ui.open({ id: "item-1", title: "Soccer" });
    await h.ui.create();
    expect(h.view.html).toContain('data-share-action="copy-calendar" data-link-id="link-new"');
  });

  // The hub leaves calendarUrl off every link while the plan has lapsed (the
  // feed would 404), so the note must not promise a subscription then.
  it("shows no calendar note when no live link serves a feed", async () => {
    const h = harness({ calendar: true, lists: [ok([link()])] });
    await h.ui.open({ id: "item-1", title: "Soccer" });
    expect(h.view.html).not.toContain("share-calendar-note");
    expect(h.view.html).not.toContain("copy-calendar");
  });

  it("shows no calendar row or note on a page-only panel", async () => {
    const h = harness({ lists: [ok([link({ calendarUrl: "https://hub.example/api/share/abc/calendar.ics" })])] });
    await h.ui.open({ id: "item-1", title: "Wifi" });
    expect(h.view.html).not.toContain("copy-calendar");
    expect(h.view.html).not.toContain("share-calendar-note");
  });

  it("marks a password and a writable link with a glyph when the app passes one, and in words alone when it does not", async () => {
    const lists = [ok([link({ hasPassword: true, writable: true })])];
    const drawn = harness({ lists, extra: { glyph: (name) => `<svg data-glyph="${name}"></svg>` } });
    await drawn.ui.open({ id: "item-1", title: "Wifi" });
    expect(drawn.view.html).toContain('data-testid="share-password-marker"><svg data-glyph="lock"></svg> password</span>');
    expect(drawn.view.html).toContain('data-testid="share-writable-marker"><svg data-glyph="pencil"></svg> accepts submissions</span>');

    const plain = harness({ lists });
    await plain.ui.open({ id: "item-1", title: "Wifi" });
    expect(plain.view.html).toContain('data-testid="share-password-marker">password</span>');
    expect(plain.view.html).toContain('data-testid="share-writable-marker">accepts submissions</span>');
  });

  it("sends a password only when one is typed, and clears it after the mint", async () => {
    const h = harness({ lists: [ok([]), ok([link({ id: "link-new", url: "https://hub.example/share/new", hasPassword: true })])] });
    await h.ui.open({ id: "item-1", title: "Wifi" });
    typePassword(h.ui, "  hunter22  ");
    await h.ui.create();
    expect(h.share.create).toHaveBeenCalledWith("thing", "item-1", { expiresInHours: 168, label: "Wifi", password: "hunter22" });
    expect(h.view.html).toContain('data-testid="share-password-marker"');
    expect(h.view.html).toMatch(/data-testid="share-password"[^>]*value=""/);
    h.share.create.mockClear();
    await h.ui.create();
    expect(h.share.create.mock.calls[0][2]).not.toHaveProperty("password");
  });

  it("refuses a password shorter than the hub accepts, without minting", async () => {
    const h = harness();
    await h.ui.open({ id: "item-1", title: "Wifi" });
    typePassword(h.ui, "12345");
    await h.ui.create();
    expect(h.share.create).not.toHaveBeenCalled();
    expect(h.view.html).toContain("at least 6 characters");
    expect(h.view.html).toMatch(/data-testid="share-password"[^>]*value="12345"/);
    expect(createDisabled(h.view.html)).toBe(false);
  });

  it("keeps the typed password when a mint is refused", async () => {
    const h = harness({ create: vi.fn(async () => { throw new Error("Too many active links"); }) });
    await h.ui.open({ id: "item-1", title: "Wifi" });
    typePassword(h.ui, "hunter22");
    await h.ui.create();
    expect(h.view.html).toMatch(/data-testid="share-password"[^>]*value="hunter22"/);
  });

  it("does not carry a typed password into another item's panel", async () => {
    const h = harness();
    await h.ui.open({ id: "item-1", title: "Wifi" });
    typePassword(h.ui, "hunter22");
    await h.ui.open({ id: "item-2", title: "Door code" });
    await h.ui.create();
    expect(h.share.create.mock.calls[0][2]).not.toHaveProperty("password");
  });

  it("escapes a typed password in the field", async () => {
    const h = harness();
    await h.ui.open({ id: "item-1", title: "Wifi" });
    // Five characters, so the too-short refusal re-renders the field with it.
    typePassword(h.ui, `"><b>`);
    await h.ui.create();
    expect(h.view.html).not.toContain("<b>");
    expect(h.view.html).toContain("&quot;&gt;&lt;b&gt;");
  });

  it("marks password links in the list", async () => {
    const h = harness({ lists: [ok([link(), link({ id: "link-pw", url: "https://hub.example/share/pw", hasPassword: true })])] });
    await h.ui.open({ id: "item-1", title: "Wifi" });
    expect(h.view.html.match(/data-testid="share-password-marker"/g)).toHaveLength(1);
  });

  it("says a password link is no calendar subscription only on a calendar panel", async () => {
    const cal = harness({ calendar: true });
    await cal.ui.open({ id: "item-1", title: "Soccer" });
    expect(cal.view.html).toContain("can’t be used as a calendar subscription");
    const page = harness();
    await page.ui.open({ id: "item-1", title: "Wifi" });
    expect(page.view.html).not.toContain("calendar subscription");
  });

  it("mints writable links, and says what a visitor can do, only when asked", async () => {
    const h = harness({ extra: { writable: true, writableVerb: "tick off tasks" } });
    await h.ui.open({ id: "item-1", title: "Sit" });
    expect(h.view.html).toContain("view this thing and tick off tasks");
    await h.ui.create();
    expect(h.share.create.mock.calls[0][2]).toMatchObject({ writable: true });
    const ro = harness();
    await ro.ui.open({ id: "item-1", title: "Wifi" });
    expect(ro.view.html).not.toContain("view this thing and");
    await ro.ui.create();
    expect(ro.share.create.mock.calls[0][2]).not.toHaveProperty("writable");
  });

  it("offers the item's own expiry first and selects it", async () => {
    const expiryFor = vi.fn((item) => (item.endsOn ? { hours: 100, label: "Until Oct 11" } : null));
    const h = harness({ extra: { expiryFor } });
    await h.ui.open({ id: "item-1", title: "Sit", endsOn: "2026-10-10" });
    expect(expiryFor).toHaveBeenCalledWith(expect.objectContaining({ id: "item-1", endsOn: "2026-10-10" }));
    expect(h.view.html.indexOf("Until Oct 11")).toBeLessThan(h.view.html.indexOf("1 day"));
    expect(selectedExpiry(h.view.html)).toBe("own");
    await h.ui.create();
    expect(h.share.create.mock.calls[0][2].expiresInHours).toBe(100);
    // Another item without its own choice falls back to the default.
    await h.ui.open({ id: "item-2", title: "Other" });
    expect(h.view.html).not.toContain("Until Oct 11");
    expect(selectedExpiry(h.view.html)).toBe("168");
  });

  it("ignores an item expiry that is missing, malformed or throws", async () => {
    for (const expiryFor of [
      () => ({ hours: 0, label: "Now" }),
      () => ({ hours: 12.5, label: "Half" }),
      () => ({ hours: 48 }),
      () => { throw new Error("bad date"); },
    ]) {
      const h = harness({ extra: { expiryFor } });
      await h.ui.open({ id: "item-1", title: "Sit" });
      expect(selectedExpiry(h.view.html)).toBe("168");
    }
  });

  it("marks links that accept submissions", async () => {
    const h = harness({ lists: [ok([link(), link({ id: "link-w", url: "https://hub.example/share/w", writable: true })])] });
    await h.ui.open({ id: "item-1", title: "Sit" });
    expect(h.view.html.match(/data-testid="share-writable-marker"/g)).toHaveLength(1);
  });

  it("locks the password field while a mint is out, and clears it only once sent", async () => {
    const minting = deferred();
    const h = harness({ create: vi.fn(() => minting.promise) });
    await h.ui.open({ id: "item-1", title: "Wifi" });
    typePassword(h.ui, "hunter22");
    const creating = h.ui.create();
    expect(h.view.html).toMatch(/data-testid="share-password"[^>]*\bdisabled\b/);
    minting.resolve({ id: "link-new", url: "https://hub.example/share/new", expiresAt: LATER, hasPassword: true });
    await creating;
    expect(h.view.html).toMatch(/data-testid="share-password"[^>]*value=""/);
    expect(h.view.html).not.toMatch(/data-testid="share-password"[^>]*\bdisabled\b/);
  });

  it("refuses a password longer than the hub accepts, without minting", async () => {
    const h = harness();
    await h.ui.open({ id: "item-1", title: "Wifi" });
    typePassword(h.ui, "x".repeat(257));
    await h.ui.create();
    expect(h.share.create).not.toHaveBeenCalled();
    expect(h.view.html).toContain("at most 256 characters");
  });

  it("asks the item for its expiry again at mint time", async () => {
    let hours = 100;
    const h = harness({ extra: { expiryFor: () => ({ hours, label: "Until Oct 11" }) } });
    await h.ui.open({ id: "item-1", title: "Sit" });
    hours = 97; // three hours pass with the panel open
    await h.ui.create();
    expect(h.share.create.mock.calls[0][2].expiresInHours).toBe(97);
  });

  it("keeps a preset the member picked over the item's own choice", async () => {
    const h = harness({ extra: { expiryFor: () => ({ hours: 100, label: "Until Oct 11" }) } });
    await h.ui.open({ id: "item-1", title: "Sit" });
    h.ui.handleChange({ target: { dataset: { shareAction: "expiry" }, value: "24" } });
    await h.ui.create();
    expect(h.share.create.mock.calls[0][2].expiresInHours).toBe(24);
  });

  it("refuses to mint when the item's own expiry has passed since the panel opened, then drops it", async () => {
    let choice = { hours: 3, label: "Until the sit ends" };
    const h = harness({ extra: { expiryFor: () => choice } });
    await h.ui.open({ id: "item-1", title: "Sit" });
    choice = null; // the end went by with the panel open
    await h.ui.create();
    expect(h.share.create).not.toHaveBeenCalled();
    expect(h.view.html).toContain("“Until the sit ends” has already passed");
    expect(h.view.html).not.toContain(">Until the sit ends<");
    expect(selectedExpiry(h.view.html)).toBe("168");
  });

  it("offers no password on a lapsed plan, whose mint would refuse one", async () => {
    const lapsed = { ...ok([]), entitled: false };
    const h = harness({ lists: [lapsed] });
    await h.ui.open({ id: "item-1", title: "Wifi" });
    expect(h.view.html).not.toContain('data-testid="share-password"');
    expect(h.view.html).not.toContain("send it separately");
    await h.ui.create();
    expect(h.share.create.mock.calls[0][2]).not.toHaveProperty("password");
  });

  it("offers no password before the list read says the plan allows one", async () => {
    const read = deferred();
    const h = harness({ lists: [read.promise] });
    const opening = h.ui.open({ id: "item-1", title: "Wifi" });
    expect(h.view.html).not.toContain('data-testid="share-password"');
    read.resolve(ok([]));
    await opening;
    expect(h.view.html).toContain('data-testid="share-password"');
  });

  it("refuses a typed password once a re-read says the plan lapsed, rather than minting an open link", async () => {
    const lapsed = { ...ok([]), entitled: false };
    const h = harness({ lists: [ok([]), lapsed] });
    await h.ui.open({ id: "item-1", title: "Wifi" });
    typePassword(h.ui, "hunter22");
    await h.ui.revoke("missing"); // any action that re-reads the list
    await h.ui.create();
    expect(h.share.create).not.toHaveBeenCalled();
    expect(h.view.html).toContain("Passwords need an active plan");
  });

  it("switches to the lapsed state when a mint is refused for the plan", async () => {
    const refusedForPlan = Object.assign(new Error("Password protection requires an active plan"), { missingCapability: true });
    const h = harness({ create: vi.fn(async () => { throw refusedForPlan; }) });
    await h.ui.open({ id: "item-1", title: "Wifi" });
    typePassword(h.ui, "hunter22");
    await h.ui.create();
    expect(h.view.html).toContain("requires an active plan");
    // The field stays while it holds text, so the member can clear it; a second
    // Create is not a dead end.
    expect(h.view.html).toMatch(/data-testid="share-password"[^>]*value="hunter22"/);
    await h.ui.create();
    expect(h.view.html).toContain("Passwords need an active plan");
    typePassword(h.ui, "");
    h.share.create.mockResolvedValueOnce({ id: "link-new", url: "https://hub.example/share/new", expiresAt: LATER });
    await h.ui.create();
    expect(h.share.create.mock.calls.at(-1)[2]).not.toHaveProperty("password");
  });

  it("gives every reason for a refusal at once", async () => {
    let choice = { hours: 3, label: "Until the sit ends" };
    const h = harness({ extra: { expiryFor: () => choice } });
    await h.ui.open({ id: "item-1", title: "Sit" });
    choice = null;
    typePassword(h.ui, "12345");
    await h.ui.create();
    expect(h.view.html).toContain("has already passed");
    expect(h.view.html).toContain("at least 6 characters");
  });

  it("refuses a lapsed writable mint in create() itself, not only by the disabled button", async () => {
    const h = harness({ lists: [{ ...ok([]), entitled: false }], extra: { writable: true, writableVerb: "tick off tasks" } });
    await h.ui.open({ id: "item-1", title: "Sit" });
    expect(h.view.html).not.toContain("view this thing and tick off tasks");
    await h.ui.create();
    expect(h.share.create).not.toHaveBeenCalled();
  });

  it("never offers or mints an item expiry longer than any link can last", async () => {
    const hours = { v: 9000 };
    const h = harness({ extra: { expiryFor: () => ({ hours: hours.v, label: "Until the sit ends" }) } });
    await h.ui.open({ id: "item-1", title: "Sit" });
    expect(h.view.html).not.toContain("Until the sit ends");
    hours.v = 100;
    await h.ui.open({ id: "item-1", title: "Sit" });
    hours.v = 9000; // moved past a year while the panel was open
    await h.ui.create();
    expect(h.share.create).not.toHaveBeenCalled();
    expect(h.view.html).toContain("more than a year away");
  });

  it("tells a preset apart from the item's own choice with the same hours", async () => {
    const hours = { v: 168 };
    const h = harness({ extra: { expiryFor: () => ({ hours: hours.v, label: "Until the sit ends" }) } });
    await h.ui.open({ id: "item-1", title: "Sit" });
    h.ui.handleChange({ target: { dataset: { shareAction: "expiry" }, value: "168" } });
    hours.v = 5; // the item's moment moves; the member picked "7 days", not it
    await h.ui.create();
    expect(h.share.create.mock.calls[0][2].expiresInHours).toBe(168);
  });

  it("refuses an item expiry that grew past a lapsed plan's 30 days while the panel was open", async () => {
    const hours = { v: 100 };
    const h = harness({
      lists: [{ ...ok([]), entitled: false }],
      extra: { expiryFor: () => ({ hours: hours.v, label: "Until the sit ends" }) },
    });
    await h.ui.open({ id: "item-1", title: "Sit" });
    expect(selectedExpiry(h.view.html)).toBe("own");
    hours.v = 960;
    await h.ui.create();
    expect(h.share.create).not.toHaveBeenCalled();
    expect(h.view.html).toContain("more than 30 days away");
    expect(selectedExpiry(h.view.html)).toBe("168");
  });

  it("keeps a writable panel's Create off on a lapsed plan, and says why", async () => {
    const h = harness({ lists: [{ ...ok([]), entitled: false }], extra: { writable: true, writableVerb: "tick off tasks" } });
    await h.ui.open({ id: "item-1", title: "Sit" });
    expect(h.view.html).toContain('data-testid="share-plan-needed"');
    expect(h.view.html).toContain("tick off tasks");
    expect(createDisabled(h.view.html)).toBe(true);
  });

  it("does not offer an item expiry past 30 days on a lapsed plan", async () => {
    const h = harness({
      lists: [{ ...ok([]), entitled: false }],
      extra: { expiryFor: () => ({ hours: 1000, label: "Until the sit ends" }) },
    });
    await h.ui.open({ id: "item-1", title: "Sit" });
    expect(h.view.html).not.toContain("Until the sit ends");
    expect(selectedExpiry(h.view.html)).toBe("168");
    await h.ui.create();
    expect(h.share.create.mock.calls[0][2].expiresInHours).toBe(168);
  });

  it("refuses a password of only spaces rather than minting an open link", async () => {
    const h = harness();
    await h.ui.open({ id: "item-1", title: "Wifi" });
    typePassword(h.ui, "      ");
    await h.ui.create();
    expect(h.share.create).not.toHaveBeenCalled();
    expect(h.view.html).toContain("can’t be only spaces");
  });

  it("keeps the writable marker on a link shown from the mint reply", async () => {
    const h = harness({
      lists: [ok([]), refused()],
      extra: { writable: true },
      create: vi.fn(async () => ({ id: "link-new", url: "https://hub.example/share/new", expiresAt: LATER, writable: true })),
    });
    await h.ui.open({ id: "item-1", title: "Sit" });
    await h.ui.create();
    expect(h.view.html).toContain('data-testid="share-writable-marker"');
  });

  it("routes delegated clicks by data attribute", async () => {
    const h = harness({ lists: [ok([link()])] });
    await h.ui.open({ id: "item-1", title: "Wifi" });
    const click = (dataset) => h.ui.handleClick({ target: { closest: () => ({ dataset }) } });
    click({ shareAction: "copy", linkId: "link-1" });
    await flush();
    expect(h.view.html).toContain("Link copied.");
    const cal = harness({ calendar: true, lists: [ok([link({ calendarUrl: "https://hub.example/api/share/abc/calendar.ics" })])] });
    await cal.ui.open({ id: "item-1", title: "Soccer" });
    cal.ui.handleClick({ target: { closest: () => ({ dataset: { shareAction: "copy-calendar", linkId: "link-1" } }) } });
    await flush();
    expect(cal.view.html).toContain("Calendar link copied.");
    click({ shareAction: "close" });
    expect(h.ui.isOpen()).toBe(false);
  });
});
