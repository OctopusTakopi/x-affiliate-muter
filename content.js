// =============================================================================
// X Affiliate Muter & Blocker: content script
// =============================================================================
// Adds "Mute all" / "Block all" controls to a company's /affiliates tab and
// walks the listed affiliates with X's v1.1 REST endpoints, which take a
// form-encoded `user_id` and have no GraphQL query ids to keep up with:
//   mute   POST /i/api/1.1/mutes/users/create.json
//   block  POST /i/api/1.1/blocks/create.json
//
// The bearer comes from sniffer.js, the ct0 cookie from document.cookie. The
// list is virtualised, so a run scrolls all of it first to render every row.

"use strict";

const LOG = "[Affiliate Tools]";

const ACTIONS = {
  mute: {
    key: "mute",
    verb: "Mute",
    past: "muted",
    path: "/i/api/1.1/mutes/users/create.json",
  },
  block: {
    key: "block",
    verb: "Block",
    past: "blocked",
    path: "/i/api/1.1/blocks/create.json",
  },
};

// A row's action button carries `<userId>-<state>`. The state names what the
// button would do, so the "un*" forms mark work that is already done.
const ROW_ACTION_RE = /^(\d+)-([a-z]+)$/;
// X uses either a <button> or a <div role="button"> for a row action, so the
// scan keys off the test id shape alone.
const ROW_SELECTOR = "[data-testid]";
const HANDLE_RE = /@([A-Za-z0-9_]{1,15})/;

// The virtualised row wrapper, plus the avatar test id holding the handle.
const ROW_CONTAINER_SELECTOR = '[data-testid="cellInnerDiv"]';
const AVATAR_HANDLE_RE = /^UserAvatar-Container-(.+)$/;

// Site chrome. Keeps the first link in a row from being read as the account.
const RESERVED_PATHS = new Set([
  "about", "compose", "explore", "home", "i", "jobs", "login", "logout",
  "messages", "notifications", "premium", "privacy", "search", "settings",
  "signup", "tos",
]);

// Per action, the row states meaning the account is already in it. A request
// for one of these comes back 400 "already ..." and still spends budget.
const DONE_STATES = {
  mute: new Set(["unmute", "muted"]),
  block: new Set(["unblock", "blocked"]),
};
const NO_STATES = new Set();

// A row counts as done only when every requested action is already in state.
// A blocked account may still be unmuted.
function alreadyInState(state, kinds) {
  return kinds.length > 0 && kinds.every((kind) => (DONE_STATES[kind] || NO_STATES).has(state));
}

const MIN_DELAY_MS = 700;
const JITTER_MS = 400;
const MAX_FAILURES_IN_A_ROW = 5;
const MAX_ATTEMPTS = 3;
const MAX_RATE_LIMIT_WAIT_MS = 15 * 60 * 1000;
const CHECK_DEBOUNCE_MS = 250;
const CHECK_INTERVAL_MS = 2000;
// Rows are only materialised near the viewport, so a bigger step would scroll
// past rows that were never rendered. Half a screen overlaps each step with the
// last, and extra steps cost little since a step waits for the re-render.
const SCROLL_STEP_SCREENS = 0.5;
const FRAME_MS = 40;
// How long a step waits for the window to re-render before moving on anyway.
const WINDOW_WAIT_MS = 400;
// How long it waits when X is showing a spinner inside the list.
const LOADING_WAIT_MS = 5000;
// How long a step at the end of the list waits. Reaching the end is what makes
// X fetch the next page, and the rows from it only show up after another
// scroll, so a step there has to outlast the round trip even when no spinner is
// rendered to say one is in flight.
const BOTTOM_WAIT_MS = 1500;
// Both ceilings are sized from what 400 accounts costs, which is as many as a
// run can act on anyway: the daily budget is 400 requests. Measured against the
// test fixture at several row heights and viewport sizes, 400 accounts arriving
// in pages of 20 takes 100 to 220 steps and 15 to 30 seconds, rising to about
// 60 seconds when every page fetch takes 2.5s. The ceilings sit above that, so
// they only stop a walk that has gone wrong.
const COLLECT_MAX_MS = 75 * 1000;
const COLLECT_MAX_STEPS = 400;
const COLLECT_SETTLE_ROUNDS = 3;
const PROGRESS_EVERY = 25;
// How long to wait for the list before giving up on it. Gates only the
// diagnostic, since finding the container short-circuits the wait.
const DIAGNOSTIC_DELAY_MS = 8000;

// Counted in requests: one mute or one block is one request, so a combined run
// costs two per account. Every HTTP attempt counts, retries included.
const DAILY_REQUEST_CAP = 400;
const QUOTA_KEY = "dailyQuota";

const LIST_SELECTOR = 'section[role="region"][aria-labelledby^="accessible-list-"]';

let authBearer = null;
let cancelRequested = false;
// Path the current run started on. If the user navigates away mid-run the
// affiliates selector would match some other timeline, so the run aborts.
let runPath = null;

// Run state lives outside the panel, so a rebuilt panel still shows a live run.
const runState = { running: false, text: "" };
let panelControls = null;
// Whether the list container was found last time. Without it, actions are off.
let listContainerFound = false;
// Arrival on an affiliates view, to tell "not rendered yet" from "absent".
let affiliatesViewSince = null;
let announcedWaiting = false;

function log(...args) {
  console.log(LOG, ...args);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function leftRunPage() {
  return runPath !== null && getCurrentPath() !== runPath;
}

// True once the run should wind down: the user hit Stop, or navigated away.
function runAborted() {
  return cancelRequested || leftRunPage();
}

// Cancellable sleep. A long wait must not trap the UI after the user hits Stop.
async function sleepCancelable(ms) {
  const deadline = Date.now() + ms;
  while (!runAborted() && Date.now() < deadline) {
    await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
  }
}

// =============================
// BEARER SNIFFER
// =============================

// sniffer.js installs at document_start, so it may have captured the bearer
// before this script attached its listener. Ping for it.
function requestAuth() {
  window.postMessage({ source: "affiliate-tools", type: "request-auth" }, "*");
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  // The sniffer posts to this page's own origin, so a different origin means
  // some other sender. An unstamped message still shares this window.
  if (event.origin && event.origin !== window.location.origin) return;
  const data = event.data;
  if (!data || data.source !== "affiliate-tools" || data.type !== "auth") return;

  if (typeof data.authorization === "string" && data.authorization.startsWith("Bearer ")) {
    if (!authBearer) log("Captured auth bearer.");
    authBearer = data.authorization;
  }
});

requestAuth();

// Resolves with the bearer, or null if the run was aborted while waiting.
async function waitForAuth(maxWaitMs = 10000) {
  const startedAt = Date.now();
  while (!authBearer && !runAborted() && Date.now() - startedAt < maxWaitMs) {
    requestAuth();
    await sleepCancelable(300);
  }
  if (runAborted()) return null;
  if (!authBearer) {
    throw new Error(
      "Could not capture the auth token yet. Click around X for a second, then retry."
    );
  }
  return authBearer;
}

// =============================
// PAGE DETECTION
// =============================

function getCurrentPath() {
  try {
    return new URL(window.location.href).pathname;
  } catch {
    return window.location.pathname;
  }
}

// Matches any path segment named "affiliates". Matching per segment means an
// extra segment cannot hide the panel.
function pathSaysAffiliates() {
  return getCurrentPath()
    .split("/")
    .some((part) => part.toLowerCase() === "affiliates");
}

function selectedTabLabel() {
  const active = document.querySelector('[role="tab"][aria-selected="true"]');
  return active ? (active.textContent || "").trim() : null;
}

// The Affiliates list can be its own route, or a selected tab on the
// followers/following page where the URL never changes. Either signal counts.
function onAffiliatesPage() {
  if (pathSaysAffiliates()) return true;
  return (selectedTabLabel() || "").toLowerCase() === "affiliates";
}

// Every tab label on the page, starred when selected, for console diagnostics.
function tabLabels() {
  const labels = [];
  for (const tab of document.querySelectorAll('[role="tab"]')) {
    const label = (tab.textContent || "").trim();
    if (label) {
      labels.push(label + (tab.getAttribute("aria-selected") === "true" ? "*" : ""));
    }
  }
  return labels;
}

// X renders several of these: the sidebar's "What's happening" and "Who to
// follow" modules also match, and document order can put the sidebar first. So
// prefer the primary column, then anything outside the sidebar, and among those
// the candidate with the most row actions. The result is cached until the
// container leaves the document, since the walk asks for it on every step.
let cachedSection = null;

function affiliatesSection() {
  if (cachedSection && cachedSection.isConnected) return cachedSection;
  cachedSection = null;

  const primary = document.querySelector('[data-testid="primaryColumn"]');
  const sidebar = document.querySelector('[data-testid="sidebarColumn"]');

  const candidates = primary ? Array.from(primary.querySelectorAll(LIST_SELECTOR)) : [];
  for (const section of document.querySelectorAll(LIST_SELECTOR)) {
    if (candidates.includes(section)) continue;
    if (sidebar && sidebar.contains(section)) continue;
    candidates.push(section);
  }

  if (candidates.length > 1) {
    let bestRows = 0;
    for (const section of candidates) {
      const rows = section.querySelectorAll(ROW_SELECTOR).length;
      if (rows > bestRows) {
        bestRows = rows;
        cachedSection = section;
      }
    }
  }

  if (!cachedSection) cachedSection = candidates[0] || null;
  return cachedSection;
}

// Last path explained, so the 2s poll does not repeat itself.
let lastDiagnosedPath = null;

// Reports which markup assumption failed, so the panel does not vanish quietly.
function listContainerCandidates() {
  const described = [];
  for (const node of document.querySelectorAll('[role="region"]')) {
    if (described.length >= 5) break;
    const labelledBy = node.getAttribute("aria-labelledby") || "(none)";
    const rows = node.querySelectorAll(ROW_SELECTOR).length;
    described.push(`${node.tagName.toLowerCase()}[aria-labelledby=${labelledBy}] rows=${rows}`);
  }
  return described;
}

function explainNoPanel() {
  const path = getCurrentPath();
  if (path === lastDiagnosedPath) return;
  lastDiagnosedPath = path;

  if (!onAffiliatesPage()) {
    log(
      `no controls: ${path} is not an affiliates view. ` +
        `Tabs on this page: ${tabLabels().join(", ") || "none"}`
    );
    return;
  }

  const section = affiliatesSection();
  if (!section) {
    log(
      `no controls: ${path} looks right, but nothing matched ${LIST_SELECTOR}. ` +
        `Regions on this page: ${listContainerCandidates().join(" | ") || "none"}`
    );
    return;
  }

  if (!section.parentElement) {
    log("no controls: the list container has no parent to insert beside.");
  }
}

// =============================
// TARGET COLLECTION
// =============================

// The row a button belongs to. Returns null with no wrapper to scope to, since
// reading the handle off the whole list would label every button the same.
function rowContainer(button) {
  if (typeof button.closest !== "function") return null;
  return button.closest(ROW_CONTAINER_SELECTOR);
}

// The handle of the account a row is about. Some of X's lists put it in the
// button's aria-label; the affiliates list only has `<userId>-<state>` there.
// So read the row's avatar test id or its profile link instead.
function readHandleFromRow(row) {
  for (const link of row.querySelectorAll("a[href]")) {
    const match = /^\/([A-Za-z0-9_]{1,15})$/.exec(link.getAttribute("href") || "");
    if (match && !RESERVED_PATHS.has(match[1].toLowerCase())) return match[1];
  }

  for (const node of row.querySelectorAll(ROW_SELECTOR)) {
    const match = AVATAR_HANDLE_RE.exec(node.getAttribute("data-testid") || "");
    if (match && !RESERVED_PATHS.has(match[1].toLowerCase())) return match[1];
  }

  return null;
}

// A row's handle never changes and the same rows stay rendered across steps, so
// the read is cached. Only a hit is cached; a rendering row has no handle yet.
const handleCache = new WeakMap();

function handleFromRow(row) {
  if (!row) return null;
  const cached = handleCache.get(row);
  if (cached) return cached;
  const handle = readHandleFromRow(row);
  if (handle) handleCache.set(row, handle);
  return handle;
}

// One row, or null for a button that is not a row action.
function rowFromButton(button) {
  const idMatch = (button.getAttribute("data-testid") || "").match(ROW_ACTION_RE);
  if (!idMatch) return null;

  const labelled = HANDLE_RE.exec(button.getAttribute("aria-label") || "");
  const handle = labelled ? labelled[1] : handleFromRow(rowContainer(button));
  if (!handle) return null;

  return { handle, userId: idMatch[1], state: idMatch[2] };
}

// The rows materialised now. The walk passes the section in to save a query.
function currentRows(section = affiliatesSection()) {
  if (!section) return [];

  const rows = [];
  for (const button of section.querySelectorAll(ROW_SELECTOR)) {
    const row = rowFromButton(button);
    if (row) rows.push(row);
  }
  return rows;
}

// One observation of the rendered window. Parses the rows that exist now and
// folds them into `seen`, so a row rendered only midway through a scroll is
// kept. No fallback to <main> or <body>, which would scrape unrelated accounts.
function harvest(section, seen) {
  const rows = currentRows(section);
  let grew = false;
  for (const row of rows) {
    if (!seen.has(row.handle)) {
      seen.set(row.handle, row);
      grew = true;
    }
  }
  return { rows, grew };
}

// What the list container holds. "no handles found" can mean the list had not
// rendered, or that the rows carry no action (X renders an account it already
// considers blocked as a static label, with no button).
function listContents() {
  const section = affiliatesSection();
  if (!section) {
    return {
      found: false,
      summary: `nothing on ${getCurrentPath()} matched ${LIST_SELECTOR}`,
    };
  }

  const elements = section.querySelectorAll(ROW_SELECTOR);
  const sample = [];
  let actions = 0;
  for (const element of elements) {
    const testId = element.getAttribute("data-testid") || "";
    if (ROW_ACTION_RE.test(testId)) actions += 1;
    if (sample.length >= 8) break;
    sample.push(testId || "(no test id)");
  }

  // Distinct profile links count the rows on show, even action-less rows.
  const profiles = new Set();
  for (const link of section.querySelectorAll("a[href]")) {
    const match = /^\/([A-Za-z0-9_]{1,15})$/.exec(link.getAttribute("href") || "");
    if (match) profiles.add(match[1]);
  }

  return {
    found: true,
    elements: elements.length,
    actions,
    profiles: profiles.size,
    sample,
    summary:
      `${elements.length} test-id element(s), ${actions} row action(s) and ` +
      `${profiles.size} profile link(s) in the list's current window; none of ` +
      `them yielded a handle with a user id. First test ids: ` +
      `${sample.join(", ") || "none"}`,
  };
}

function reportNoTargets() {
  const contents = listContents();
  log(`no targets: ${contents.summary}`);
  return contents;
}

// The panel message cannot name the cause, so it reports what was found.
function noTargetsMessage(contents) {
  if (!contents.found) {
    return (
      "No affiliate handles found: the affiliates list itself was not on the " +
      "page. Open the Affiliates tab, wait for the list, then retry."
    );
  }

  return (
    `No affiliate handles found. The list was there - ${contents.elements} ` +
    `element(s), ${contents.actions} row action(s), ${contents.profiles} ` +
    "profile link(s). Nothing in it came out as a handle and an id.\n\n" +
    (contents.actions
      ? "The row actions were there but their handles could not be read from " +
        "their rows, which is a bug in this extension rather than a rendering " +
        "problem. "
      : "Nothing in it was a mute/block action: an account X already shows as " +
        "blocked has no button to read, so a fully blocked list looks like " +
        "this. ") +
    "The console lists the test ids that were seen."
  );
}

// Usually the page itself scrolls. If the list sits in its own scrolling
// container, scrolling the document moves nothing and the scan re-reads one
// screenful. Overflowing content alone is not enough: an `overflow: visible`
// wrapper is taller than its box but never scrolls, making scrollBy a no-op.
function scrolls(node) {
  if (!(node.scrollHeight > node.clientHeight + 8)) return false;
  if (typeof getComputedStyle !== "function") return true;
  const overflow = getComputedStyle(node).overflowY;
  return overflow === "auto" || overflow === "scroll" || overflow === "overlay";
}

function scroller(section = affiliatesSection()) {
  for (let node = section; node; node = node.parentElement) {
    if (scrolls(node)) return node;
  }
  return document.scrollingElement || document.documentElement;
}

// How close to the end still counts as the end. Zoom and fractional device
// pixels mean the numbers rarely land exactly equal.
const BOTTOM_SLACK_PX = 4;

// The scroller has reached its end. Guarded by whether it scrolls at all: an
// element whose content fits reports scrollTop 0 and scrollHeight equal to
// clientHeight, which is a page that never scrolled and not a bottom.
function atBottom(el) {
  if (!el) return false;
  const height = el.scrollHeight || 0;
  const view = el.clientHeight || 0;
  if (height <= view + 8) return false;
  return (el.scrollTop || 0) + view >= height - BOTTOM_SLACK_PX;
}

// X shows a spinner inside the list while it fetches the next page.
function listIsLoading(section = affiliatesSection()) {
  return Boolean(section && section.querySelector('[role="progressbar"]'));
}

// Identity of the rendered window: the readable rows, or the scroll position
// when no row can be read. The fallback keeps the walk going on odd markup.
function windowFingerprint(el, rows) {
  if (rows.length) return `${rows.length}|${rows[0].handle}|${rows[rows.length - 1].handle}`;
  return `scroll:${(el && el.scrollTop) || 0}`;
}

// Move the list on by half a screen and report what changed. Which element
// actually scrolls cannot be known for sure, so the step is judged by its
// effect, with scrollIntoView on the last rendered row as the fallback. A step
// that moves nothing and finds nothing new means the end of the list.
//
// X swaps the virtualised window in a frame or two, so the step polls for the
// change; a spinner inside the list earns a longer wait. Each poll harvests the
// window it read anyway. The caller passes the last fingerprint back in, which
// saves a subtree query on a column holding thousands of nodes.
async function advanceList(section, el, step, seen, marker) {
  const before = el.scrollTop || 0;
  el.scrollBy(0, step);
  const wasAtBottom = atBottom(el);
  // The fallback exists for a scroller this code guessed wrong, so it only runs
  // while there is somewhere left to go. At the end of the list it pulls the
  // last row back into view, which shifts the scroll position, and that shift
  // then reads as movement on the next step.
  if ((el.scrollTop || 0) === before && !wasAtBottom) {
    const rows = section.querySelectorAll(ROW_CONTAINER_SELECTOR);
    const last = rows[rows.length - 1];
    if (last && typeof last.scrollIntoView === "function") {
      last.scrollIntoView({ block: "end" });
    }
  }

  let wait = WINDOW_WAIT_MS;
  if (listIsLoading(section)) wait = LOADING_WAIT_MS;
  else if (wasAtBottom) wait = BOTTOM_WAIT_MS;
  const deadline = Date.now() + wait;
  let grew = false;
  let seenMarker = marker;

  while (!runAborted() && Date.now() < deadline) {
    await sleepCancelable(FRAME_MS);
    const observed = harvest(section, seen);
    grew = grew || observed.grew;
    seenMarker = windowFingerprint(el, observed.rows);

    if (wasAtBottom) {
      // A changed window at the end of the list is X re-rendering, so it is no
      // reason to move on, and sampling the whole wait is what catches a row
      // the re-render only shows some of the time. The next page landing is the
      // real signal, and it arrives as the scroller having somewhere to go
      // again, or as rows that were not in the window before.
      if (observed.grew || !atBottom(el)) break;
    } else if (seenMarker !== marker) {
      break;
    }
  }

  // Read after the wait. A step that could not scrollBy moves through
  // scrollIntoView, and that lands while the window is still settling.
  return {
    grew,
    advanced: (el.scrollTop || 0) > before,
    bottom: atBottom(el),
    marker: seenMarker,
  };
}

// Walk the virtualised list to the bottom, keeping every row passed on the way.
// The step stays under a screen, because a row scrolled past was never rendered
// and cannot be recovered. The list is finished once several steps in a row
// find no new account and move it no further. Reaching the bottom is only what
// makes X fetch the next page, so a bottom alone does not end the walk.
async function collectAllTargets({
  maxMs = COLLECT_MAX_MS,
  maxSteps = COLLECT_MAX_STEPS,
  settleRounds = COLLECT_SETTLE_ROUNDS,
  onProgress,
} = {}) {
  const seen = new Map();
  const startedAt = Date.now();
  let settled = 0;
  let steps = 0;
  let reported = 0;
  let atEnd = false;

  // Resolved once for the whole walk. Picking the scroller and measuring it are
  // layout reads, and the walk takes hundreds of otherwise cheap steps.
  let el = null;
  let step = 0;

  harvest(affiliatesSection(), seen);

  // Identity of the window the last step ended on, carried forward so each
  // observation reads the list once. Set when the scroller is resolved.
  let marker = null;

  while (!runAborted() && Date.now() - startedAt < maxMs && steps < maxSteps) {
    const section = affiliatesSection();
    if (!section) break;

    if (!el || !el.isConnected) {
      el = scroller(section);
      const viewport = Math.max(400, Math.round(el.clientHeight || 0));
      step = Math.max(200, Math.round(viewport * SCROLL_STEP_SCREENS));
      // A marker taken against a different scroller cannot be compared.
      marker = windowFingerprint(el, currentRows(section));
    }

    steps += 1;
    const { grew, advanced, bottom, marker: ended } = await advanceList(
      section,
      el,
      step,
      seen,
      marker
    );
    marker = ended;
    atEnd = bottom;
    // Progress means a new account, or a list that moved while it still had
    // somewhere to go. Once the scroller is at its end the position can still
    // twitch, and counting that as movement is what kept the walk scrolling
    // there. A bottom with a page still in flight is covered by grew.
    settled = grew || (advanced && !bottom) ? 0 : settled + 1;

    if (onProgress && seen.size >= reported + PROGRESS_EVERY) {
      reported = seen.size;
      onProgress(seen.size);
    }

    if (settled >= settleRounds) break;
  }

  if (runAborted()) {
    log(`Collection interrupted with ${seen.size} affiliate(s) seen.`);
  } else {
    (el || scroller()).scrollTo(0, 0);
    const elapsed = Date.now() - startedAt;
    log(
      `Collected ${seen.size} affiliate(s) in ${Math.round(elapsed / 1000)}s ` +
        `(${steps} steps, ${atEnd ? "reached the end of the list" : "list stopped changing"}).`
    );
    if (settled < settleRounds) {
      const bound =
        steps >= maxSteps
          ? `${maxSteps} steps`
          : `the ${Math.round(maxMs / 1000)}s cap`;
      console.warn(
        LOG,
        `Stopped at ${bound} before the list stopped changing, so it may be ` +
          `longer than the ${seen.size} collected.`
      );
    }
    // Row states, since skipping already-actioned accounts depends on them.
    const states = new Map();
    for (const row of seen.values()) states.set(row.state, (states.get(row.state) || 0) + 1);
    log(
      `Row states seen: ${
        Array.from(states, ([state, count]) => `${state}=${count}`).join(", ") || "none"
      }.`
    );
  }
  return Array.from(seen.values());
}

// =============================
// DAILY REQUEST CAP
// =============================

// Persisted so the cap survives reloads. With no storage it counts in memory.
let memoryQuota = { day: null, used: 0 };
const quotaStore =
  typeof chrome !== "undefined" && chrome.storage && chrome.storage.local
    ? chrome.storage.local
    : null;

// Reloading, updating or disabling the extension leaves running content scripts
// in place, but every chrome.* call from then on throws "Extension context
// invalidated." chrome.runtime.id is undefined in such an orphaned script.
function extensionAlive() {
  try {
    return typeof chrome !== "undefined" && Boolean(chrome.runtime && chrome.runtime.id);
  } catch {
    return false;
  }
}

// The one error here that no retry can fix, so the page names it.
function isInvalidatedContext(error) {
  const message = String((error && error.message) || error || "");
  return /extension context invalidated/i.test(message);
}

// Logged once: a broken binding would otherwise print on every request.
let quotaStorageBroken = false;
function noteQuotaStorageBroken(what, error) {
  if (quotaStorageBroken) return;
  quotaStorageBroken = true;
  log(`daily cap storage ${what} - the cap now only counts this tab:`, error);
}

function todayKey(now = new Date()) {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

// A dead storage binding must not end a run. In-memory still keeps the cap.
async function readQuota() {
  if (quotaStore && extensionAlive()) {
    try {
      const stored = await quotaStore.get(QUOTA_KEY);
      const quota = stored && stored[QUOTA_KEY];
      if (quota && typeof quota.used === "number") return quota;
      return { day: null, used: 0 };
    } catch (e) {
      noteQuotaStorageBroken("unreadable", e);
    }
  }
  return memoryQuota;
}

async function writeQuota(quota) {
  memoryQuota = quota;
  if (quotaStore && extensionAlive()) {
    try {
      await quotaStore.set({ [QUOTA_KEY]: quota });
    } catch (e) {
      noteQuotaStorageBroken("unwritable", e);
    }
  }
}

async function usedToday() {
  const day = todayKey();
  const quota = await readQuota();
  return quota.day === day ? quota.used : 0;
}

async function remainingToday() {
  return Math.max(0, DAILY_REQUEST_CAP - (await usedToday()));
}

// Read-modify-write per request, so a second tab overshoots by one at most.
async function consumeRequest() {
  const day = todayKey();
  const used = await usedToday();

  if (used >= DAILY_REQUEST_CAP) {
    const error = new Error(
      `Daily cap of ${DAILY_REQUEST_CAP} mute/block requests reached. It resets at local midnight.`
    );
    error.code = "DAILY_CAP";
    throw error;
  }

  await writeQuota({ day, used: used + 1 });
  return { used: used + 1, remaining: DAILY_REQUEST_CAP - used - 1 };
}

// =============================
// X API
// =============================

function getCsrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function buildHeaders() {
  if (!authBearer || !authBearer.startsWith("Bearer ")) {
    throw new Error("Authorization bearer token missing or invalid.");
  }

  const csrf = getCsrfToken();
  if (!csrf) {
    throw new Error("ct0 CSRF cookie not found. Log into X, then retry.");
  }

  return {
    authorization: authBearer,
    "x-csrf-token": csrf,
    "x-twitter-active-user": "yes",
    "x-twitter-auth-type": "OAuth2Session",
    "x-twitter-client-language": "en",
    "content-type": "application/x-www-form-urlencoded",
  };
}

// X puts the actionable part of a failure in the response body.
async function describeError(res) {
  try {
    const body = await res.json();
    const first = Array.isArray(body && body.errors) ? body.errors[0] : null;
    if (first) return [first.code, first.message].filter(Boolean).join(" ");
    if (body && typeof body === "object") return JSON.stringify(body).slice(0, 200);
    return "";
  } catch {
    return "unreadable response body";
  }
}

// Honour X's own reset header when there is one, else back off exponentially.
async function backoff(attempt, res) {
  const reset = Number(res && res.headers && res.headers.get("x-rate-limit-reset"));
  if (Number.isFinite(reset) && reset > 0) {
    const waitMs = reset * 1000 - Date.now();
    if (waitMs > 0) {
      const capped = Math.min(waitMs + 500, MAX_RATE_LIMIT_WAIT_MS);
      log(`Rate limited; waiting up to ${Math.ceil(capped / 1000)}s (Stop cancels).`);
      await sleepCancelable(capped);
      return;
    }
  }
  await sleepCancelable(Math.min(60000, 2 ** attempt * 1000));
}

async function callAction(action, userId, headers) {
  await consumeRequest();

  return fetch(`${location.origin}${action.path}`, {
    method: "POST",
    credentials: "include",
    headers,
    body: new URLSearchParams({ user_id: userId }).toString(),
  });
}

// X answers 400 for "already in that state" and also for genuinely bad requests
// (bad auth data, malformed params). Only the first is a no-op.
function isAlreadyInStateError(detail) {
  return /already/i.test(detail);
}

async function applyAction(action, target) {
  // Outside the retry loop: a missing cookie or bearer means a dead session.
  const headers = buildHeaders();

  for (let attempt = 1; ; attempt++) {
    if (runAborted()) return { ok: false, cancelled: true };
    const lastAttempt = attempt >= MAX_ATTEMPTS;

    let res;
    try {
      res = await callAction(action, target.userId, headers);
    } catch (e) {
      // A spent budget is terminal, so it is never retried with backoff.
      if (e && e.code === "DAILY_CAP") throw e;
      if (lastAttempt) return { ok: false, reason: String(e) };
      await backoff(attempt, null);
      continue;
    }

    if (res.ok) return { ok: true };

    const detail = await describeError(res);

    if (res.status === 400 && isAlreadyInStateError(detail)) {
      return { ok: true, noop: true, detail };
    }

    if (res.status === 429) {
      if (lastAttempt) return { ok: false, reason: "rate limited" };
      await backoff(attempt, res);
      continue;
    }

    return {
      ok: false,
      reason: `HTTP ${res.status}${detail ? ` (${detail})` : ""}`,
    };
  }
}

async function runActions(kinds, targets, onProgress) {
  const totals = Object.fromEntries(
    kinds.map((kind) => [kind, { applied: 0, noop: 0, failed: 0 }])
  );

  let processed = 0;
  let failuresInARow = 0;
  let stopReason = null;
  let first = true;

  const report = (line) => {
    log(line);
    onProgress(line);
  };

  outer: for (const target of targets) {
    const notes = [];

    for (const kind of kinds) {
      const action = ACTIONS[kind];

      // Pace between calls only.
      if (!first) await sleepCancelable(MIN_DELAY_MS + Math.random() * JITTER_MS);
      first = false;

      let result;
      try {
        result = runAborted()
          ? { ok: false, cancelled: true }
          : await applyAction(action, target);
      } catch (e) {
        if (!e || e.code !== "DAILY_CAP") throw e;
        if (notes.length) {
          report(`${processed + 1}/${targets.length} @${target.handle} - ${notes.join(", ")}`);
        }
        stopReason = "daily-cap";
        break outer;
      }

      if (result.cancelled) {
        if (notes.length) {
          report(`${processed + 1}/${targets.length} @${target.handle} - ${notes.join(", ")} (interrupted)`);
        }
        break outer;
      }

      if (result.ok) {
        if (result.noop) {
          // Already in that state, so the failure streak is left alone.
          totals[kind].noop += 1;
          notes.push(`already ${action.past}${result.detail ? ` (${result.detail})` : ""}`);
        } else {
          totals[kind].applied += 1;
          failuresInARow = 0;
          notes.push(action.past);
        }
      } else {
        totals[kind].failed += 1;
        failuresInARow += 1;
        notes.push(`${action.verb.toLowerCase()} failed: ${result.reason}`);
        console.error(LOG, `@${target.handle}`, action.verb, result.reason);

        // A run of hard failures means a dead session or a dead account, and
        // pushing on only risks the account. Checked per call.
        if (failuresInARow >= MAX_FAILURES_IN_A_ROW) {
          report(`${processed + 1}/${targets.length} @${target.handle} - ${notes.join(", ")}`);
          stopReason = "circuit-breaker";
          break outer;
        }
      }
    }

    processed += 1;
    report(`${processed}/${targets.length} @${target.handle} - ${notes.join(", ")}`);
  }

  if (!stopReason && runAborted()) {
    stopReason = cancelRequested ? "cancelled" : "navigated";
  }

  return { totals, processed, total: targets.length, stopReason };
}

// =============================
// UI
// =============================

const PANEL_ID = "affiliate-tools-panel";

// Used when the list container cannot be found. X's <main> wraps both the
// timeline column and the sidebar, so the panel is pinned to the viewport.
const DEGRADED_PANEL_STYLE =
  "position:fixed;top:0;left:0;right:0;z-index:2147483647;" +
  "display:flex;gap:8px;align-items:center;flex-wrap:wrap;" +
  "padding:8px 16px;background:rgb(22,24,28);border-bottom:1px solid rgb(244,33,46);";

const NAV_FALLBACK_PX = 53;

// X pins its column header at top:0, so a panel at top:0 would cover the back
// button and the title. The scan is bounded; a long list means many nodes.
function pinnedAbovePx() {
  const primary = document.querySelector('[data-testid="primaryColumn"]');
  if (!primary || typeof getComputedStyle !== "function") return NAV_FALLBACK_PX;

  let checked = 0;
  for (const el of primary.querySelectorAll("div")) {
    if (++checked > 250) break;
    const style = getComputedStyle(el);
    if (style.position !== "sticky" && style.position !== "fixed") continue;
    if (parseFloat(style.top) !== 0) continue;
    const height = Math.round(el.getBoundingClientRect().height);
    if (height > 0) return height;
  }
  return NAV_FALLBACK_PX;
}

// Rows scroll under the panel, so match the column's paint. Themes vary.
function columnBackground() {
  const primary = document.querySelector('[data-testid="primaryColumn"]');
  for (const el of [primary, document.body, document.documentElement]) {
    if (!el || typeof getComputedStyle !== "function") continue;
    const background = getComputedStyle(el).backgroundColor;
    if (background && background !== "transparent" && background !== "rgba(0, 0, 0, 0)") {
      return background;
    }
  }
  return "rgb(0, 0, 0)";
}

// The list can run to thousands of rows, so the controls stay pinned in place.
function panelStyle() {
  return (
    `position:sticky;top:${pinnedAbovePx()}px;z-index:3;` +
    "display:flex;gap:8px;align-items:center;justify-content:flex-end;" +
    `flex-wrap:wrap;padding:8px 16px;background:${columnBackground()};`
  );
}

function styleButton(btn, { danger = false } = {}) {
  const accent = danger ? "rgb(244, 33, 46)" : "rgb(113, 118, 123)";
  btn.style.cssText = [
    "padding:4px 12px",
    "border-radius:9999px",
    `border:1px solid ${accent}`,
    "background:transparent",
    `color:${danger ? accent : "rgb(239, 243, 244)"}`,
    "cursor:pointer",
    "font-size:13px",
    "font-weight:600",
    "line-height:18px",
  ].join(";");
}

function applyRunState() {
  if (!panelControls) return;

  const { panel, status, actions, stop, reset } = panelControls;

  if (!panel.isConnected) {
    panelControls = null;
    return;
  }

  // A disabled button with no explanation looks broken, so the title says why.
  const actionsBlockedBecause = runState.running
    ? "a run is already in flight"
    : !listContainerFound
      ? "the affiliates list was not found on this page"
      : "";

  for (const btn of actions) {
    btn.disabled = Boolean(actionsBlockedBecause);
    btn.title = actionsBlockedBecause;
  }

  // The budget is this extension's own counter, so clearing it does not need
  // the list. A run in flight blocks it, since a run re-reads the counter and
  // would then grow past what the user agreed to.
  const resetBlockedBecause = runState.running ? "a run is already in flight" : "";
  reset.disabled = Boolean(resetBlockedBecause);
  reset.title = resetBlockedBecause;
  stop.hidden = !runState.running;
  stop.disabled = !runState.running;

  // Assigning identical text still replaces the node, which the observer sees.
  if (status.textContent !== runState.text) status.textContent = runState.text;
}

function setRunState(running, text) {
  runState.running = running;
  if (text !== undefined) runState.text = text;
  applyRunState();
}

const ORPHANED_TEXT = "extension reloaded. Refresh this page (F5) to restore it";

// Reported once from the poll, so the page says so before a button is clicked.
let orphanedReported = false;
function reportIfOrphaned() {
  if (extensionAlive()) return false;
  // No chrome object at all means a host that never had one.
  if (typeof chrome === "undefined") return false;
  if (!orphanedReported) {
    orphanedReported = true;
    log(
      "extension was reloaded: this page is running a dead copy of it. " +
        "The run would still work, but the daily cap could only count this tab."
    );
  }
  return true;
}

function announceOrphaned() {
  if (runState.running) return;
  if (reportIfOrphaned()) setRunState(false, ORPHANED_TEXT);
}

// Idle budget readout. Re-checked after the await so a new run survives it.
async function refreshQuotaReadout() {
  // The degraded banner's message matters more than the budget readout.
  if (!listContainerFound) return;

  if (reportIfOrphaned()) {
    setRunState(false, ORPHANED_TEXT);
    return;
  }

  const remaining = await remainingToday();
  if (runState.running || reportIfOrphaned()) return;
  setRunState(false, `${remaining} requests left today`);
}

// The cap is self-imposed pacing, and a run that burned the budget on failures
// is a fair reason to start the day over. It confirms first, and it is blocked
// mid-run because a run re-reads the counter and would then overrun the cap.
async function resetDailyCap() {
  if (runState.running) return;

  const used = await usedToday();
  if (used > 0) {
    const confirmed = confirm(
      `Reset today's request budget?\n\n` +
        `${used} of today's ${DAILY_REQUEST_CAP} requests are counted as used. ` +
        `Resetting starts the count at 0, so up to ${DAILY_REQUEST_CAP} more ` +
        "requests can be sent today."
    );
    if (!confirmed) return;
  }

  await writeQuota({ day: todayKey(), used: 0 });
  log(`daily cap reset - ${DAILY_REQUEST_CAP} requests available again.`);
  setRunState(false, `daily cap reset. ${DAILY_REQUEST_CAP} requests left today`);
}

function summarizeRun(kinds, result) {
  const parts = kinds.map((kind) => {
    const tally = result.totals[kind];
    const noop = tally.noop ? `, ${tally.noop} already` : "";
    const failed = tally.failed ? `, ${tally.failed} failed` : "";
    return `${ACTIONS[kind].past} ${tally.applied}${noop}${failed}`;
  });

  const body = `${parts.join("; ")} - ${result.processed}/${result.total} accounts`;

  if (result.stopReason === "cancelled") return `stopped early: ${body}`;
  if (result.stopReason === "navigated") return `stopped (left the affiliates page): ${body}`;
  if (result.stopReason === "daily-cap") {
    return `daily cap of ${DAILY_REQUEST_CAP} requests reached: ${body}`;
  }
  if (result.stopReason === "circuit-breaker") {
    return `aborted after ${MAX_FAILURES_IN_A_ROW} consecutive failures: ${body}`;
  }
  return body;
}

function buildPanel() {
  const panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.style.cssText = panelStyle();

  const status = document.createElement("span");
  status.style.cssText = "font-size:12px;color:rgb(113, 118, 123);margin-right:auto;";
  panel.appendChild(status);

  const addButton = (label, options) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    styleButton(btn, options);
    panel.appendChild(btn);
    return btn;
  };

  const muteBtn = addButton("Mute all");
  const blockBtn = addButton("Block all", { danger: true });
  const bothBtn = addButton("Mute + Block all", { danger: true });
  const stopBtn = addButton("Stop", { danger: true });
  const resetBtn = addButton("Reset cap");

  const actions = [muteBtn, blockBtn, bothBtn];

  const start = (kinds) => async () => {
    // A silent click looks like a broken button, so every path out logs.
    if (runState.running) {
      log("ignored: a run is already in flight.");
      return;
    }

    cancelRequested = false;
    runPath = getCurrentPath();
    const wanted = kinds.map((kind) => ACTIONS[kind].verb).join(" + ");
    log(`run requested: ${wanted} on ${getCurrentPath()}`);
    setRunState(true, "waiting for the auth token...");

    const stoppedWhile = (phase, seen) =>
      `${cancelRequested ? "stopped" : "stopped (left the affiliates page)"} while ${phase}` +
      (seen === undefined ? "" : ` (${seen} accounts seen)`);

    try {
      if (!(await waitForAuth())) {
        setRunState(false, stoppedWhile("waiting for the auth token"));
        return;
      }
      // Fail fast on a dead session before spending a minute scrolling.
      buildHeaders();

      setRunState(true, "collecting affiliates...");
      const targets = await collectAllTargets({
        onProgress: (count) =>
          setRunState(true, `scrolling the list - ${count} accounts seen so far`),
      });
      if (runAborted()) {
        setRunState(false, stoppedWhile("collecting", targets.length));
        return;
      }

      if (!targets.length) {
        alert(noTargetsMessage(reportNoTargets()));
        return;
      }

      // Rows already in state are dropped; X answers 400 and spends budget.
      const todo = targets.filter((target) => !alreadyInState(target.state, kinds));
      const skipped = targets.length - todo.length;
      const alreadyDone = kinds.map((kind) => ACTIONS[kind].past).join(" and ");

      if (!todo.length) {
        log(`nothing to do: all ${targets.length} listed accounts are already ${alreadyDone}.`);
        alert(
          `Nothing to do: every account in this list of ${targets.length} is ` +
            `already ${alreadyDone}.\n\nNo requests were sent. Unblock or ` +
            "unmute them on X if you want to act on them again."
        );
        return;
      }

      const remaining = await remainingToday();
      const planned = todo.length * kinds.length;
      const overBudget =
        planned > remaining
          ? `\n\nOnly ${remaining} of today's ${DAILY_REQUEST_CAP} requests are left, so it will stop partway.`
          : "";
      const skipNote = skipped
        ? `\n\n${skipped} of the ${targets.length} listed accounts are already ` +
          `${alreadyDone} and will be skipped.`
        : "";

      const confirmed = confirm(
        `Found ${todo.length} affiliate accounts needing action. ${wanted} all of them?\n\n` +
          `This sends ${planned} requests (${remaining} left of today's ` +
          `${DAILY_REQUEST_CAP}) and can take several minutes. You can stop it ` +
          "while it runs." +
          overBudget +
          skipNote
      );
      if (!confirmed || runAborted()) return;

      const result = await runActions(kinds, todo, (msg) => setRunState(true, msg));
      const left = await remainingToday();
      const skippedNote = skipped ? ` | ${skipped} already ${alreadyDone}, skipped` : "";
      setRunState(
        false,
        `${summarizeRun(kinds, result)}${skippedNote} | ${left} left today`
      );
    } catch (e) {
      console.error(LOG, e);

      // Nothing on this page can fix an orphaned script, so say what does.
      if (isInvalidatedContext(e)) {
        setRunState(false, ORPHANED_TEXT);
        alert(
          "Affiliate run stopped: the extension was reloaded or updated while " +
            "this tab stayed open, so this page is running a copy of it that " +
            "can no longer reach its storage.\n\n" +
            "Refresh the page (F5), then retry."
        );
        return;
      }

      setRunState(false, "stopped with an error. See the console.");
      alert(`Affiliate run stopped: ${e.message}`);
    } finally {
      cancelRequested = false;
      runPath = null;
      // The paths that end in a dialog never set a status of their own, and a
      // blank status looks dead, so fall back to the idle budget readout.
      if (runState.running) {
        setRunState(false, "");
        refreshQuotaReadout();
      }
    }
  };

  muteBtn.addEventListener("click", start(["mute"]));
  blockBtn.addEventListener("click", start(["block"]));
  bothBtn.addEventListener("click", start(["mute", "block"]));

  stopBtn.addEventListener("click", () => {
    if (!runState.running) return;
    cancelRequested = true;
    setRunState(true, "stopping after the current call...");
  });

  resetBtn.addEventListener("click", resetDailyCap);

  panelControls = { panel, status, actions, stop: stopBtn, reset: resetBtn };
  return panel;
}

function injectPanel() {
  if (!onAffiliatesPage()) {
    explainNoPanel();
    return;
  }

  const section = affiliatesSection();
  const found = Boolean(section);

  // X renders the timeline well after document_idle; early polls prove little.
  const waitedMs = Date.now() - (affiliatesViewSince === null ? Date.now() : affiliatesViewSince);
  const settled = found || waitedMs >= DIAGNOSTIC_DELAY_MS;

  if (found && !section.parentElement) {
    explainNoPanel();
    return;
  }

  const existing = document.getElementById(PANEL_ID);
  if (existing) {
    // Rebuild only when the list appeared or vanished, and only once settled.
    if (found === listContainerFound || !settled) return;
    removePanel();
  }

  if (!settled) {
    if (!announcedWaiting) {
      announcedWaiting = true;
      log("waiting for the affiliates list to render...");
    }
    return;
  }

  listContainerFound = found;
  const panel = buildPanel();

  if (found) {
    // Sibling before the list; a re-render would eat a panel placed inside it.
    section.parentElement.insertBefore(panel, section);
  } else {
    // Put the diagnosis on the page. A missing control looks broken.
    panel.style.cssText = DEGRADED_PANEL_STYLE;
    runState.text =
      `no affiliates list found after ${Math.round(waitedMs / 1000)}s ` +
      `(readyState=${document.readyState}) - ${LIST_SELECTOR} matched nothing. Regions: ` +
      `${listContainerCandidates().join(" | ") || "none"}`;
    document.body.appendChild(panel);
  }

  applyRunState();
  refreshQuotaReadout();
  log(found ? "Injected controls." : "Injected diagnostic banner: no list container.");
}

function removePanel() {
  const panel = document.getElementById(PANEL_ID);
  if (panel) panel.remove();
  panelControls = null;
}

// =============================
// SPA HANDLING
// =============================

let lastPath = getCurrentPath();
let lastTab = selectedTabLabel();
let checkScheduled = false;

function checkAndInject() {
  const currentPath = getCurrentPath();
  const currentTab = selectedTabLabel();

  // The Affiliates list can be one tab of a page whose URL never changes, so a
  // tab switch has to invalidate everything cached about the list. Only a
  // reading that names a tab counts, since X blanks it while re-rendering.
  const tabChanged = currentTab !== null && lastTab !== null && currentTab !== lastTab;
  if (currentTab !== null) lastTab = currentTab;

  if (currentPath !== lastPath || tabChanged) {
    lastPath = currentPath;
    lastDiagnosedPath = null;
    // A different page or tab means a different list.
    cachedSection = null;
    removePanel();
  }

  if (onAffiliatesPage()) {
    if (affiliatesViewSince === null) {
      affiliatesViewSince = Date.now();
      announcedWaiting = false;
    }
    injectPanel();
    announceOrphaned();
  } else {
    affiliatesViewSince = null;
    removePanel();
    explainNoPanel();
  }
}

// X mutates its DOM constantly, so bursts are coalesced into one check.
function scheduleCheck() {
  if (checkScheduled) return;
  checkScheduled = true;
  setTimeout(() => {
    checkScheduled = false;
    checkAndInject();
  }, CHECK_DEBOUNCE_MS);
}

setInterval(checkAndInject, CHECK_INTERVAL_MS);

new MutationObserver(scheduleCheck).observe(document.documentElement, {
  childList: true,
  subtree: true,
});

checkAndInject();
log("content script loaded.");
