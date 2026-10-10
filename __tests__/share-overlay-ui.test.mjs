// @vitest-environment jsdom
/**
 * The share panel's DOM half (`createOverlayView`) wired to the real
 * controller, against a real DOM.
 *
 * share-ui.test.mjs drives the controller with a string-capturing view, which
 * cannot see two things that only exist in a browser: typing reaches the
 * controller through `input` events (a click on Create does not blur the field
 * first on touch), and every render replaces the panel's markup, which drops
 * the focus of a field the member is typing in. This file is identical in
 * every app that ships src/share.js.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { createShareUi, createOverlayView } from "../src/share.js";

const LATER = new Date(Date.now() + 7 * 864e5).toISOString();
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const flush = async (n = 10) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function mount({ list = Promise.resolve(null), create } = {}) {
  const ok = { enabled: true, entitled: true, bundle: null, limits: { maxActive: 100 }, links: [
    { id: "link-1", url: "https://hub.example/share/abc", itemId: "item-1", createdBy: "adult-1", expiresAt: LATER, revokedAt: null, viewCount: 0 },
  ] };
  const share = {
    listAll: vi.fn(async () => (await list) ?? ok),
    create: create ?? vi.fn(async () => ({ id: "link-new", url: "https://hub.example/share/new", expiresAt: LATER })),
    revoke: vi.fn(),
  };
  const view = createOverlayView(document);
  const ui = createShareUi({
    share, itemType: "thing", noun: "thing", scopeHtml: () => "", esc,
    confirm: async () => true, writeText: async () => {},
    activeLinks: (links, itemId) => links.filter((l) => l.itemId === itemId && !l.revokedAt),
    expiryChoices: [{ hours: 24, label: "1 day" }, { hours: 168, label: "7 days" }],
    defaultExpiryHours: 168, getMe: () => ({ id: "adult-1" }), isAdmin: () => false,
    memberName: () => "", view,
  });
  view.bind(ui);
  return { ui, share };
}

const field = () => document.getElementById("share-password");
function type(value) {
  const input = field();
  input.focus();
  input.value = value;
  input.setSelectionRange(value.length, value.length);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

afterEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

describe("share overlay", () => {
  it("mints with a password typed and never blurred", async () => {
    const { ui, share } = mount();
    await ui.open({ id: "item-1", title: "Wifi" });
    type("hunter22");
    document.querySelector('[data-share-action="create"]').click();
    await flush();
    expect(share.create).toHaveBeenCalledWith("thing", "item-1", expect.objectContaining({ password: "hunter22" }));
  });

  it("keeps focus and the caret in the password field when a render lands mid-typing", async () => {
    const { ui } = mount();
    await ui.open({ id: "item-1", title: "Wifi" });
    type("hun");
    const before = field();
    await ui.copy("link-1"); // a Copy lands and the panel re-renders
    expect(field()).not.toBe(before);
    expect(document.activeElement).toBe(field());
    expect(field().value).toBe("hun");
    expect([field().selectionStart, field().selectionEnd]).toEqual([3, 3]);
  });

  it("leaves focus off the field while it is disabled for a mint (pins browser behaviour)", async () => {
    const minting = deferred();
    const { ui } = mount({ create: vi.fn(() => minting.promise) });
    await ui.open({ id: "item-1", title: "Wifi" });
    type("hunter22");
    const creating = ui.create();
    expect(field().disabled).toBe(true);
    expect(document.activeElement).not.toBe(field());
    minting.resolve({ id: "link-new", url: "https://hub.example/share/new", expiresAt: LATER });
    await creating;
  });

  it("restores focus inside the panel even when the host page reuses the id", async () => {
    const host = document.createElement("input");
    host.id = "share-password";
    document.body.appendChild(host);
    const { ui } = mount();
    await ui.open({ id: "item-1", title: "Wifi" });
    const inPanel = document.querySelector(".share-panel #share-password");
    inPanel.focus();
    await ui.copy("link-1");
    expect(document.activeElement).toBe(document.querySelector(".share-panel #share-password"));
    expect(document.activeElement).not.toBe(host);
  });

  it("closes on Escape and on a backdrop click", async () => {
    const { ui } = mount();
    await ui.open({ id: "item-1", title: "Wifi" });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(ui.isOpen()).toBe(false);
    await ui.open({ id: "item-1", title: "Wifi" });
    document.querySelector('[data-testid="share-panel"]').click();
    expect(ui.isOpen()).toBe(false);
  });
});
