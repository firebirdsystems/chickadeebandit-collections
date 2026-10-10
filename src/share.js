/**
 * External share links: a public page for one row of this app, minted, copied
 * and revoked from a small panel. Read-only unless the app passes `writable`.
 *
 * The hub renders the public page from `manifest.shareable`; this file is only
 * the member-facing half. It is a controller with its dependencies passed in —
 * the SDK's share helper, the clipboard, the confirm dialog, and a `view` that
 * owns the DOM — so the sequencing below can be tested in Node without a
 * browser. The same file ships in every app with a share panel (notes,
 * routines, trip-planner, announcements, board-minutes, document-library,
 * kids-activities, milestones, health-cards, timetable, carpool); keep the
 * copies identical.
 *
 * The sequencing is the part worth having here rather than inline:
 *   - two reads of the link list can be in flight at once (open's, and the one
 *     create makes to pick up the new link), and the slower must not win;
 *   - the panel can be closed, or reopened on another item, while a request is
 *     out, and a late answer must not paint into it;
 *   - a refused list read is not an empty list. The SDK turns every non-2xx
 *     (including a household's sharing policy saying no) into `links: []` with
 *     `limits: null`, so `limits` is the only tell. Showing "no links" there
 *     invites a member to mint a second one.
 */

/**
 * @param deps.share          createShareHelper(...) from the hub SDK
 * @param deps.itemType       the manifest.shareable key this panel mints
 * @param deps.noun           what the public page shows, for copy ("note")
 * @param deps.scopeHtml      (item) => trusted HTML saying what a link exposes
 *                            and what stays in the household, or ""
 * @param deps.esc            HTML escaper
 * @param deps.glyph          optional — glyph from the hub SDK, to mark a
 *                            link's password and submissions notes; omit it
 *                            and the notes are words alone
 * @param deps.confirm        async (message, opts) => boolean
 * @param deps.writeText      clipboard writer
 * @param deps.activeLinks    activeShareLinks from the hub SDK
 * @param deps.expiryChoices  SHARE_EXPIRY_CHOICES from the hub SDK
 * @param deps.defaultExpiryHours DEFAULT_SHARE_EXPIRY_HOURS from the hub SDK
 * @param deps.getMe          the session member, or null
 * @param deps.isAdmin        () => boolean — admins may revoke anyone's link
 * @param deps.memberName     (id) => display name, for links another adult made
 * @param deps.view           { show(), render(html), hide() }
 * @param deps.calendarUrl    optional — share.calendarUrl from the hub SDK, for
 *                            an item type that declares a calendar. A link it
 *                            returns a url for gets a "Copy calendar link"
 *                            button; omit it and the panel is page-only.
 * @param deps.writable       optional — mint links that accept submissions (the
 *                            item type must declare `submit`)
 * @param deps.writableVerb   optional — what a visitor can do on a writable
 *                            page, for copy ("tick off tasks")
 * @param deps.expiryFor      optional — (item) => { hours, label } | null, an
 *                            extra expiry choice for this item (a sit's link
 *                            ending the day after the sit), offered first and
 *                            selected by default. Called at open and again at
 *                            mint, with the object open() was given — look the
 *                            item up by id if it can change meanwhile
 */
export function createShareUi(deps) {
  /** A hub glyph ahead of a note's words, when the app passed one in. */
  const mark = (name) => (deps.glyph ? `${deps.glyph(name)} ` : "");
  /** { id, title } of the item the open panel is for, or null when closed. */
  let target = null;
  /** The item object open() was given, for deps.expiryFor at mint time. */
  let targetItem = null;
  /** Bumped on every open and close. Async work pins the value it started
   *  under and stops painting once it moves. */
  let session = 0;
  /** Orders reads of the link list within one session. */
  let readSeq = 0;
  let links = [];
  /** "loading" until the first read answers, then "ok" or "refused". A later
   *  failed read after a good one does not flip back to refused: one blip is
   *  not the household switching sharing off. */
  let listState = "loading";
  /** Whether the household's plan allows the enhanced options — a password, a
   *  writable link, an expiry past 30 days — as the list read (or a refused
   *  mint) says. False until the read answers: nothing is offered on a guess. */
  let entitled = false;
  let busy = false;
  let error = "";
  let notice = "";
  /** The chosen preset, in hours — used unless the item's own choice is. */
  let expiry = deps.defaultExpiryHours;
  /** The open item's own expiry choice from deps.expiryFor, or null. */
  let itemChoice = null;
  /** Whether the item's own choice is selected. Kept apart from `expiry`: its
   *  hours can equal a preset's, and the two mean different things at mint (a
   *  moment, asked again, versus a fixed length). */
  let ownSelected = false;
  /** Optional link password. Kept in state because every render rebuilds the
   *  input; cleared after a mint so the next link does not inherit it. */
  let password = "";

  /** The link's calendar subscription url, or null (no calendar declared, or a
   *  password link, which serves no feed). */
  function calendarUrlOf(link) {
    return deps.calendarUrl ? deps.calendarUrl(link) : null;
  }

  function pin() {
    const s = session;
    return () => s === session && target !== null;
  }

  async function refresh() {
    const seq = ++readSeq;
    const still = pin();
    let status = null;
    try {
      status = await deps.share.listAll();
    } catch {
      status = null; // fetch itself rejected: offline, aborted
    }
    // Superseded is not failed: a newer read owns the list now.
    if (seq !== readSeq || !still()) return "stale";
    if (!status || status.limits === null) {
      if (listState === "loading") listState = "refused";
      return "failed";
    }
    links = status.links ?? [];
    entitled = status.entitled === true;
    listState = "ok";
    dropItemChoiceIfSelected();
    return "ok";
  }

  function render() {
    if (target) deps.view.render(html());
  }

  function html() {
    const esc = deps.esc;
    const me = deps.getMe();
    const admin = !!deps.isAdmin();
    const active = deps.activeLinks(links, target.id);

    const rows = active.map((l) => {
      const mine = l.createdBy === me?.id;
      const calendar = calendarUrlOf(l);
      const by = mine ? "" : ` · shared by ${esc(deps.memberName(l.createdBy) || "another adult")}`;
      const locked = l.hasPassword ? ` · <span data-testid="share-password-marker">${mark("lock")}password</span>` : "";
      const writes = l.writable ? ` · <span data-testid="share-writable-marker">${mark("pencil")}accepts submissions</span>` : "";
      return `
      <div class="share-row" data-testid="share-row">
        <input readonly class="share-url" value="${esc(l.url)}" onclick="this.select()" aria-label="Share link" />
        <div class="share-meta">
          Expires ${esc(new Date(l.expiresAt).toLocaleDateString())} · ${l.viewCount ?? 0} view${l.viewCount === 1 ? "" : "s"}${locked}${writes}${by}
        </div>
        <div class="share-row-actions">
          <button type="button" class="share-btn" data-share-action="copy" data-link-id="${esc(l.id)}">Copy</button>
          ${calendar ? `<button type="button" class="share-btn" data-share-action="copy-calendar" data-link-id="${esc(l.id)}" data-testid="share-copy-calendar">Copy calendar link</button>` : ""}
          ${mine || admin ? `<button type="button" class="share-btn share-btn-danger" data-share-action="revoke" data-link-id="${esc(l.id)}">Revoke</button>` : ""}
        </div>
      </div>`;
    }).join("");

    const scope = deps.scopeHtml ? deps.scopeHtml(target) : "";
    let body;
    if (listState === "loading") {
      body = `<p class="share-muted">Checking existing links…</p>`;
    } else if (listState === "refused") {
      body = `<p class="share-error" data-testid="share-refused">Sharing isn’t available here right now.
        In a shared space only stewards can create links unless a steward opens it up,
        and a household can switch sharing off entirely.</p>`;
    } else {
      body = rows || `<p class="share-muted" data-testid="share-empty">No active links yet.</p>`;
    }

    return `
    <h3 id="share-title">Share “${esc(target.title)}”</h3>
    <p class="share-intro">
      Anyone with the link can view this ${esc(deps.noun)}${deps.writable && !writableBlocked()
        ? ` and ${esc(deps.writableVerb || "respond through the page")}` : ""}, with no account needed.
      Links expire on their own, and you can revoke one at any time.
    </p>
    ${scope ? `<p class="share-scope">${scope}</p>` : ""}
    ${active.some(calendarUrlOf) ? `<p class="share-scope" data-testid="share-calendar-note">A link with a calendar
      link also works as a calendar subscription: paste the calendar link into Google, Apple or Outlook Calendar. It
      stops updating when the link expires. After you revoke a link, a calendar app can keep showing its events until
      its next refresh, which can take a few hours.</p>` : ""}
    ${error ? `<p class="share-error" role="alert" data-testid="share-error">${esc(error)}</p>` : ""}
    ${writableBlocked() ? `<p class="share-error" data-testid="share-plan-needed">A link that lets visitors
      ${esc(deps.writableVerb || "respond through the page")} needs an active plan.</p>` : ""}
    ${notice ? `<p class="share-notice" role="status" data-testid="share-notice">${esc(notice)}</p>` : ""}
    ${body}
    <div class="share-create">
      <label class="share-expiry-label" for="share-expiry">Link lasts</label>
      <select id="share-expiry" class="share-expiry" data-share-action="expiry">
        ${choices().map(({ value, label, selected }) =>
          `<option value="${value}"${selected ? " selected" : ""}>${esc(label)}</option>`).join("")}
      </select>
      ${entitled || password !== "" ? `<label class="share-password-label" for="share-password">Password</label>
      <input id="share-password" class="share-password" type="text" autocomplete="off" spellcheck="false"
        data-share-action="password" data-testid="share-password" placeholder="Optional, 6+ characters"
        maxlength="${MAX_PASSWORD_LENGTH}" value="${esc(password)}" ${busy ? "disabled" : ""} />` : ""}
      <button type="button" class="share-btn share-btn-primary" data-share-action="create" data-testid="share-create"
        ${busy || listState !== "ok" || writableBlocked() ? "disabled" : ""}>${busy ? "Creating…" : "Create link"}</button>
    </div>
    ${entitled ? `<p class="share-muted share-password-hint">With a password, visitors must enter it before they see
      anything; send it separately from the link.${deps.calendarUrl
        ? " A link with a password can’t be used as a calendar subscription." : ""}</p>` : ""}
    <div class="share-actions">
      <button type="button" class="share-btn" data-share-action="close">Close</button>
    </div>`;
  }

  /** A writable panel on a plan that cannot mint writable links. Said up front
   *  rather than minted as a read-only link the member did not ask for. */
  function writableBlocked() {
    return !!deps.writable && listState === "ok" && !entitled;
  }

  /** The open item's own expiry choice, when the plan can mint it: past 30
   *  days needs an active plan. */
  function usableItemChoice() {
    if (!itemChoice || itemChoice.hours > MAX_EXPIRY_HOURS) return null;
    return entitled || itemChoice.hours <= LAPSED_MAX_EXPIRY_HOURS ? itemChoice : null;
  }

  /** The expiry options for the open item: its own choice first, if any. */
  function choices() {
    const own = usableItemChoice();
    const presets = deps.expiryChoices.map(({ hours, label }) => ({
      value: String(hours), label, selected: !(own && ownSelected) && hours === expiry,
    }));
    return own ? [{ value: "own", label: own.label, selected: ownSelected }, ...presets] : presets;
  }

  /** The item's own choice stops being offered (the plan cannot mint it, or its
   *  moment passed): fall back to the default preset rather than leave a choice
   *  selected that is not on screen. */
  function dropItemChoiceIfSelected() {
    if (ownSelected && !usableItemChoice()) {
      ownSelected = false;
      expiry = deps.defaultExpiryHours;
    }
  }

  /** deps.expiryFor's answer, or null when it is absent, throws, or is not a
   *  positive whole number of hours with a label. */
  function itemExpiryChoice(item) {
    if (!deps.expiryFor) return null;
    let choice;
    try {
      choice = deps.expiryFor(item);
    } catch {
      return null;
    }
    const hours = Number(choice?.hours);
    if (!Number.isInteger(hours) || hours <= 0 || !choice?.label) return null;
    return { hours, label: String(choice.label) };
  }

  async function open(item) {
    session++;
    target = { id: String(item.id), title: String(item.title ?? "") };
    targetItem = item;
    links = [];
    listState = "loading";
    busy = false;
    error = "";
    notice = "";
    itemChoice = itemExpiryChoice(item);
    ownSelected = itemChoice !== null;
    expiry = deps.defaultExpiryHours;
    password = "";
    entitled = false;
    deps.view.show();
    render();
    const still = pin();
    await refresh();
    if (still()) render();
  }

  function close() {
    session++;
    target = null;
    targetItem = null;
    deps.view.hide();
  }

  async function create() {
    if (!target || busy || listState !== "ok") return;
    const item = target;
    const secret = password.trim();
    // Every reason at once, so fixing one does not uncover the next.
    const refusals = [];
    if (writableBlocked()) {
      refusals.push(`A link that lets visitors ${deps.writableVerb || "respond through the page"} needs an active plan.`);
    }
    // The item's own choice is a moment ("the day after the sit ends"), and the
    // hub counts hours from the mint, so ask again now rather than trusting the
    // count taken when the panel opened. Gone means the moment has passed.
    let hours = expiry;
    if (ownSelected && itemChoice) {
      const fresh = itemExpiryChoice(targetItem);
      if (!fresh) {
        refusals.push(`“${itemChoice.label}” has already passed. Pick how long the link lasts.`);
        itemChoice = null;
        ownSelected = false;
        expiry = deps.defaultExpiryHours;
      } else if (!entitled && fresh.hours > LAPSED_MAX_EXPIRY_HOURS) {
        refusals.push(`“${fresh.label}” is more than 30 days away, which needs an active plan. Pick a shorter length.`);
        ownSelected = false;
        expiry = deps.defaultExpiryHours;
      } else if (fresh.hours > MAX_EXPIRY_HOURS) {
        // The hub would clamp it silently, to a moment the label does not name.
        refusals.push(`“${fresh.label}” is more than a year away, longer than a link can last. Pick a shorter length.`);
        ownSelected = false;
        expiry = deps.defaultExpiryHours;
      } else {
        hours = fresh.hours;
      }
    }
    if (secret && !entitled) {
      // The field was offered, then a re-read said the plan lapsed. Refuse
      // rather than mint an open link the member believes is protected.
      refusals.push("Passwords need an active plan. Clear the password to create an open link.");
    } else if (password !== "" && secret === "") {
      refusals.push("A password can’t be only spaces. Clear it for a link with no password.");
    } else if (secret && secret.length < MIN_PASSWORD_LENGTH) {
      refusals.push(`A password needs at least ${MIN_PASSWORD_LENGTH} characters.`);
    } else if (secret.length > MAX_PASSWORD_LENGTH) {
      refusals.push(`A password can be at most ${MAX_PASSWORD_LENGTH} characters.`);
    }
    if (refusals.length) {
      notice = "";
      error = refusals.join(" ");
      render();
      return;
    }
    const still = pin();
    busy = true;
    error = "";
    notice = "";
    render();
    try {
      const opts = { expiresInHours: hours, label: item.title };
      if (secret) opts.password = secret;
      if (deps.writable) opts.writable = true;
      const link = await deps.share.create(deps.itemType, item.id, opts);
      // The field is disabled while the mint is out, so what it holds is what
      // was sent; clearing it keeps the next link from inheriting the secret.
      if (still() && password.trim() === secret) password = "";
      const listed = await refresh();
      if (!still()) return;
      if (listed === "failed" && !links.some((l) => l.id === link.id)) {
        // The link exists; only our picture of the list is behind. Show it from
        // the mint reply so the one copy of a live url is not just a clipboard
        // write that may also have failed.
        links = [...links, {
          id: link.id, url: link.url, itemId: item.id, createdBy: deps.getMe()?.id,
          expiresAt: link.expiresAt, revokedAt: null, viewCount: 0,
          hasPassword: !!link.hasPassword, writable: !!link.writable,
          ...(link.calendarUrl ? { calendarUrl: link.calendarUrl } : {}),
        }];
        error = "Link created, but the list of links couldn’t be refreshed.";
      }
      let copied = false;
      try {
        await deps.writeText(link.url);
        copied = true;
      } catch { /* the url is on screen in a selectable field either way */ }
      if (!still()) return;
      notice = copied ? "Link created and copied." : "Link created. Select it above to copy.";
    } catch (err) {
      if (!still()) return;
      error = err?.message || "Couldn’t create the link.";
      // The plan lapsed since the list read: show the panel as it is now.
      if (err?.missingCapability) {
        entitled = false;
        dropItemChoiceIfSelected();
      }
    } finally {
      if (still()) {
        busy = false;
        render();
      }
    }
  }

  async function copy(linkId, kind = "page") {
    const link = links.find((l) => l.id === linkId);
    if (!link) return;
    const text = kind === "calendar" ? calendarUrlOf(link) : link.url;
    if (!text) return;
    const still = pin();
    try {
      await deps.writeText(text);
      if (!still()) return;
      error = "";
      notice = kind === "calendar" ? "Calendar link copied." : "Link copied.";
    } catch {
      if (!still()) return;
      notice = "";
      // The calendar link has no field on screen to select, so say it here.
      error = kind === "calendar"
        ? `Couldn’t copy. The calendar link is ${text}`
        : "Couldn’t copy. Select the link text instead.";
    }
    render();
  }

  async function revoke(linkId) {
    const still = pin();
    const ok = await deps.confirm("Revoke this link?", {
      description: `Anyone using it will lose access to this ${deps.noun} straight away.`,
      confirmLabel: "Revoke",
    });
    if (!ok || !still()) return;
    try {
      await deps.share.revoke(linkId);
      // Drop it locally first: the link is dead once the hub says so, and
      // leaving it up because the re-read failed invites a second revoke.
      links = links.filter((l) => l.id !== linkId);
      await refresh();
      if (!still()) return;
      error = "";
      notice = "Link revoked.";
    } catch (err) {
      if (!still()) return;
      notice = "";
      error = err?.message || "Couldn’t revoke the link.";
    }
    render();
  }

  /** Click delegation. Link ids come from the hub and item ids from rows any
   *  member can write, so neither is ever interpolated into an inline handler. */
  function handleClick(e) {
    const el = e.target?.closest?.("[data-share-action]");
    if (!el) return;
    const { shareAction, linkId } = el.dataset;
    if (shareAction === "create") create();
    else if (shareAction === "copy") copy(linkId);
    else if (shareAction === "copy-calendar") copy(linkId, "calendar");
    else if (shareAction === "revoke") revoke(linkId);
    else if (shareAction === "close") close();
  }

  /** The form is rebuilt on every render, so its values live in state. Takes
   *  both `change` and `input` events, so a typed password is in state
   *  without waiting for the field to blur. */
  function handleChange(e) {
    const action = e.target?.dataset?.shareAction;
    if (action === "expiry") {
      ownSelected = e.target.value === "own";
      if (!ownSelected) expiry = Number(e.target.value) || deps.defaultExpiryHours;
    } else if (action === "password") {
      password = String(e.target.value ?? "");
    }
  }

  return { open, close, create, copy, revoke, handleClick, handleChange, isOpen: () => target !== null };
}

/** The hub's limits (share-links.ts MIN_PASSWORD_LENGTH, and the 256 cap in
 *  share-links-protocol.ts). Checked here so the member reads why, instead of
 *  the hub's generic "Invalid share-link expiry or password". */
const MIN_PASSWORD_LENGTH = 6;
const MAX_PASSWORD_LENGTH = 256;
/** The longest expiry a lapsed plan can mint (share-links.ts
 *  FREE_MAX_EXPIRY_HOURS, the SDK's SHARE_EXPIRY_CHOICES ceiling). */
const LAPSED_MAX_EXPIRY_HOURS = 720;
/** The longest any link can last (share-links.ts PREMIUM_MAX_EXPIRY_HOURS). */
const MAX_EXPIRY_HOURS = 8760;

const STYLE_ID = "share-ui-style";
const STYLE = `
.share-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; padding: 16px; z-index: 1000; }
.share-panel { background: var(--hub-surface, #fff); color: var(--hub-text, #000); border-radius: var(--hub-radius, 12px); padding: 22px; width: 100%; max-width: 480px; max-height: 90vh; overflow-y: auto; box-shadow: 0 20px 60px rgba(0,0,0,.18); font-size: .9rem; }
.share-panel h3 { font-size: 1.05rem; margin: 0 0 8px; overflow-wrap: anywhere; }
.share-intro, .share-scope, .share-muted { color: var(--hub-text-muted, #6b7280); font-size: .84rem; margin: 0 0 10px; }
.share-error { background: var(--hub-tint-danger, #fee2e2); color: var(--hub-tint-danger-fg, #991b1b); border-radius: 6px; padding: 8px 10px; font-size: .84rem; margin: 0 0 10px; }
.share-notice { background: var(--hub-tint-success, #dcfce7); color: var(--hub-tint-success-fg, #166534); border-radius: 6px; padding: 8px 10px; font-size: .84rem; margin: 0 0 10px; }
.share-row { padding: 8px 0; border-bottom: 1px solid var(--hub-border, #e5e7eb); }
.share-url { width: 100%; font: inherit; font-size: .8rem; padding: 5px 7px; border: 1px solid var(--hub-border, #d1d5db); border-radius: 6px; background: var(--hub-bg, #f9fafb); color: inherit; }
.share-meta { font-size: .75rem; color: var(--hub-text-muted, #6b7280); margin-top: 3px; }
.share-row-actions { display: flex; gap: 6px; margin-top: 6px; }
.share-create { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 14px; }
.share-expiry-label, .share-password-label { font-size: .8rem; color: var(--hub-text-muted, #6b7280); }
.share-password { font: inherit; font-size: .85rem; padding: 6px; width: 11em; border: 1px solid var(--hub-border, #d1d5db); border-radius: 6px; background: var(--hub-bg, #fff); color: inherit; }
.share-password-hint { margin-top: 6px; font-size: .78rem; }
.share-expiry { font: inherit; font-size: .85rem; padding: 6px; border: 1px solid var(--hub-border, #d1d5db); border-radius: 6px; background: var(--hub-bg, #fff); color: inherit; }
.share-actions { display: flex; justify-content: flex-end; margin-top: 16px; }
.share-btn { font: inherit; font-size: .82rem; font-weight: 600; padding: 6px 12px; border-radius: 8px; border: 1px solid var(--hub-border, #d1d5db); background: transparent; color: var(--hub-text, #000); cursor: pointer; }
.share-btn:disabled { opacity: .45; cursor: default; }
.share-btn-primary { background: var(--hub-primary, #111827); color: var(--hub-primary-fg, #fff); border-color: var(--hub-primary, #111827); }
.share-btn-danger { color: var(--hub-tint-danger-fg, #dc2626); }
`;

/**
 * The DOM half: an overlay the controller renders into. Kept separate so the
 * controller never touches `document`. `bind(ui)` wires delegation once the
 * controller exists (the two need each other).
 */
export function createOverlayView(doc) {
  let el = null;
  let ui = null;
  function onKey(e) { if (e.key === "Escape") ui?.close(); }
  return {
    bind(controller) { ui = controller; },
    show() {
      if (!doc.getElementById(STYLE_ID)) {
        const style = doc.createElement("style");
        style.id = STYLE_ID;
        style.textContent = STYLE;
        doc.head.appendChild(style);
      }
      el?.remove();
      el = doc.createElement("div");
      el.className = "share-backdrop";
      el.setAttribute("data-testid", "share-panel");
      el.innerHTML = `<div class="share-panel" role="dialog" aria-modal="true" aria-labelledby="share-title"></div>`;
      el.addEventListener("click", (e) => {
        if (e.target === el) ui?.close();
        else ui?.handleClick(e);
      });
      el.addEventListener("change", (e) => ui?.handleChange(e));
      el.addEventListener("input", (e) => ui?.handleChange(e));
      doc.addEventListener("keydown", onKey);
      doc.body.appendChild(el);
    },
    /** Every render replaces the panel's markup, so a field the member is
     *  typing in (the password, while a list read or a copy lands) would lose
     *  focus mid-word. Put focus and the caret back on the field with the same
     *  id. */
    render(html) {
      if (!el) return;
      const active = doc.activeElement;
      const focusedId = active && active.id && el.contains(active) ? active.id : null;
      const caret = focusedId ? [active.selectionStart, active.selectionEnd] : null;
      el.querySelector(".share-panel").innerHTML = html;
      if (!focusedId) return;
      // Looked up inside the panel: the host page may use the same id.
      const next = [...el.querySelectorAll("[id]")].find((node) => node.id === focusedId);
      if (!next) return;
      // A disabled field (the password while a mint is out) will not take
      // focus, and the browser leaves it on the body; that is accepted.
      next.focus();
      try {
        if (caret[0] !== null && caret[0] !== undefined) next.setSelectionRange(caret[0], caret[1]);
      } catch { /* a select has no caret */ }
    },
    hide() {
      el?.remove();
      el = null;
      doc.removeEventListener("keydown", onKey);
    },
  };
}
