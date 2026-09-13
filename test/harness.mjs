// Dependency-free harness: loads content.js in a vm with a stubbed DOM and
// drives the scrape, API and cancellation paths. Run with: node test/harness.mjs
//
// The stub covers a virtualised list, rows that are already actioned, follow
// buttons outside the affiliates container, and an orphaned content script whose
// chrome.* bindings are dead.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "content.js"), "utf8");

const ROW_COUNT = 25;
const VIEW_SIZE = 5;
const SCROLL_STEP = 5;
const PANEL_ID = "affiliate-tools-panel";
const BLOCK_PATH = "/i/api/1.1/blocks/create.json";
const MUTE_PATH = "/i/api/1.1/mutes/users/create.json";
const MAX_FAILURES_IN_A_ROW = 5;
const DAILY_REQUEST_CAP = 400;
const LIST_SELECTOR = 'section[role="region"][aria-labelledby^="accessible-list-"]';
// Row actions are found by test id, since X renders some of them as <button>
// and some as <div role="button">.
const ROW_SELECTOR = "[data-testid]";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Clock that can jump forward, so the page-settle gate is testable without
// sleeping through it. Real time still flows, so cancellable sleeps terminate.
let clockOffsetMs = 0;
const RealDate = Date;

class FakeDate extends RealDate {
  constructor(...args) {
    if (args.length) super(...args);
    else super(RealDate.now() + clockOffsetMs);
  }
  static now() {
    return RealDate.now() + clockOffsetMs;
  }
}

function advanceClock(ms) {
  clockOffsetMs += ms;
}

// ---------------------------------------------------------------------------
// DOM stub
// ---------------------------------------------------------------------------

function makeElement(tagName) {
  const el = {
    tagName,
    id: "",
    type: "",
    style: {},
    children: [],
    listeners: {},
    textContent: "",
    disabled: false,
    hidden: false,
    isConnected: false,
    appendChild(child) {
      el.children.push(child);
      return child;
    },
    addEventListener(type, fn) {
      (el.listeners[type] ||= []).push(fn);
    },
    remove() {
      el.isConnected = false;
    },
  };
  return el;
}

function click(el) {
  for (const fn of el.listeners.click || []) fn();
}

function findButton(root, label) {
  return root.children.find((c) => c.tagName === "button" && c.textContent === label);
}

// A quarter of the rows are already actioned, so their button reads Unblock.
const rows = Array.from({ length: ROW_COUNT }, (_, i) => ({
  handle: `acct_${i}`,
  userId: String(1000 + i),
  action: i % 4 === 3 ? "unblock" : "follow",
  label: i % 4 === 3 ? "Unblock" : "Follow",
}));

const ACTION_LABELS = { follow: "Follow", unfollow: "Unfollow", unblock: "Unblock" };

// Rows shaped like the live affiliates list: a `cellInnerDiv` holding a
// `UserCell`, an avatar test id with the handle, a profile link and the action
// button. The aria-label carries no `@handle`, as on the live list.
const cells = rows.map((row, index) => {
  const actionFor = () => {
    // A run of already-actioned rows at the front made long lists slow.
    const blockedPrefix = actionedRowCount !== null && index < actionedRowCount;
    return uniformAction || (blockedPrefix ? "unblock" : row.action);
  };

  const cell = {
    scrollIntoView() {
      if (bounceAtBottom) {
        scroller.scrollTop = Math.max(0, scroller.scrollTop - 200);
        return;
      }
      if (!frozenScroller) return;
      viewStart = Math.min(viewStart + VIEW_SIZE - 1, Math.max(0, loadedRowCount - VIEW_SIZE));
    },
    querySelectorAll(selector) {
      // Counted, because a handle read queries the row's links and should not
      // repeat on every pass.
      if (selector === "a[href]") {
        handleReads += 1;
        return [link];
      }
      if (selector === ROW_SELECTOR) return [avatar, button];
      return [];
    },
  };

  const button = {
    getAttribute(name) {
      if (uniformTestId) return name === "data-testid" ? uniformTestId : null;
      const action = actionFor();
      if (name === "data-testid") return `${row.userId}-${action}`;
      if (name === "aria-label") return ACTION_LABELS[action] || row.label;
      return null;
    },
    closest(selector) {
      return selector === '[data-testid="cellInnerDiv"]' ? cell : null;
    },
  };

  const avatar = {
    getAttribute(name) {
      if (name !== "data-testid") return null;
      return uniformTestId ? uniformTestId : `UserAvatar-Container-${row.handle}`;
    },
  };

  const link = {
    getAttribute(name) {
      return name === "href" ? `/${row.handle}` : null;
    },
  };

  return { cell, button, avatar, link };
});

let viewStart = 0;
// Once the bottom is reached, X keeps swapping the rendered window without
// adding accounts. Turning this on models that.
let churnAtBottom = false;
let churnTick = 0;
// The page scroller is the wrong guess: scrollBy does nothing and the list only
// moves when a row is pulled into view.
let frozenScroller = false;
// At the end of the list, pulling the last row into view shifts the scroll
// position back up. The next step then scrolls down again, which looks like the
// list moved. That bounce is what kept the scan running at the bottom.
let bounceAtBottom = false;
let sectionPresent = true;
let primaryPresent = true;
let decoySectionPresent = false;
let injectedPanel = null;
// Rows that exist in the DOM. A long list pages in while it is scrolled.
let loadedRowCount = ROW_COUNT;
let pagingEnabled = false;
let pageLoadPending = false;
const PAGE_SIZE = 5;
let maxScrollTop = 0;
const scrollDeltas = [];
// Selected tab label, or null when there is no tab bar.
let selectedTabText = null;
// Answer to the next confirm().
let confirmAnswer = true;
let lastAlert = null;
// Overrides every row's action/state, for the mostly-already-blocked list.
let uniformAction = null;
// Replaces every row's test id, for rows with no action.
let uniformTestId = null;
// Rows before this index report "unblock", an already-blocked prefix.
let actionedRowCount = null;
let handleReads = 0;

const section = {
  firstChild: null,
  parentElement: null,
  // X renders a spinner inside the list while it fetches the next page.
  loading: false,
  querySelector(selector) {
    if (selector === '[role="progressbar"]') return section.loading ? {} : null;
    return null;
  },
  querySelectorAll(selector) {
    // Only the rendered window exists, as on the live list.
    let size = VIEW_SIZE;
    if (churnAtBottom && scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight) {
      churnTick += 1;
      size = VIEW_SIZE - (churnTick % 2);
    }
    const window = cells
      .slice(viewStart, viewStart + size)
      .filter((_, i) => viewStart + i < loadedRowCount);

    if (selector === ROW_SELECTOR) return window.flatMap((c) => [c.avatar, c.button]);
    if (selector === "a[href]") return window.map((c) => c.link);
    if (selector === '[data-testid="cellInnerDiv"]') return window.map((c) => c.cell);
    return [];
  },
};

// A scraper widening past the affiliates container would pick this up.
const decoyButton = {
  getAttribute(name) {
    if (name === "data-testid") return "9999-follow";
    if (name === "aria-label") return "Follow @sidebar_decoy";
    return null;
  },
};

const mainElement = {
  firstChild: null,
  inserted: [],
  insertBefore(child) {
    child.isConnected = true;
    mainElement.inserted.push(child);
    injectedPanel = child;
    return child;
  },
  querySelectorAll() {
    return [decoyButton];
  },
};

const panelHost = {
  inserted: [],
  insertBefore(child, ref) {
    assert.equal(ref, section, "the panel must sit beside the list, not inside it");
    child.isConnected = true;
    injectedPanel = child;
    panelHost.inserted.push(child);
    return child;
  },
};

// The sidebar renders its own section[role=region] modules, sometimes first in
// document order. That is how the panel once landed in "What's happening".
const sidebarHost = {
  inserted: [],
  insertBefore(child) {
    sidebarHost.inserted.push(child);
    return child;
  },
};

const sidebarSection = {
  parentElement: sidebarHost,
  querySelector() {
    return null;
  },
  querySelectorAll() {
    return [];
  },
};

// Another accessible-list region in the same column, rendered first. The anchor
// should follow the list holding row actions.
const decoyHost = {
  inserted: [],
  insertBefore(child) {
    decoyHost.inserted.push(child);
    return child;
  },
};

const decoySection = {
  parentElement: decoyHost,
  querySelector() {
    return null;
  },
  querySelectorAll(selector) {
    assert.equal(selector, ROW_SELECTOR);
    return [decoyButton];
  },
};

const sidebarElement = {
  contains(node) {
    return node === sidebarSection;
  },
  querySelector() {
    return null;
  },
  querySelectorAll() {
    return [];
  },
};

const primaryElement = {
  contains(node) {
    return node === section;
  },
  querySelector(selector) {
    if (selector === LIST_SELECTOR) return sectionPresent ? section : null;
    return null;
  },
  querySelectorAll() {
    return [];
  },
};

const bodyElement = {
  appended: [],
  appendChild(child) {
    child.isConnected = true;
    injectedPanel = child;
    bodyElement.appended.push(child);
    return child;
  },
};

section.parentElement = panelHost;

// A row is 200px tall and the viewport 1000px, so five rows render at a time and
// scrollTop maps onto the rendered window.
const ROW_HEIGHT_PX = 200;

// The next page lands a moment after the bottom is hit.
function schedulePageLoad() {
  if (!pagingEnabled || pageLoadPending || loadedRowCount >= ROW_COUNT) return;
  pageLoadPending = true;
  setTimeout(() => {
    loadedRowCount = Math.min(ROW_COUNT, loadedRowCount + PAGE_SIZE);
    pageLoadPending = false;
  }, 150);
}

const scroller = {
  clientHeight: 1000,
  scrollTop: 0,
  get scrollHeight() {
    return loadedRowCount * ROW_HEIGHT_PX;
  },
  scrollBy(_x, y) {
    scrollDeltas.push(y);
    if (frozenScroller) return;
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.scrollTop = Math.max(0, Math.min(scroller.scrollTop + y, max));
    maxScrollTop = Math.max(maxScrollTop, scroller.scrollTop);
    viewStart = Math.min(
      Math.round(scroller.scrollTop / ROW_HEIGHT_PX),
      Math.max(0, loadedRowCount - VIEW_SIZE)
    );
    // Hitting the bottom asks X for the next page.
    if (scroller.scrollTop >= max) schedulePageLoad();
  },
  scrollTo(_x, y) {
    scroller.scrollTop = y;
    viewStart = 0;
  },
};

const windowStub = {
  location: { href: "https://x.com/SomeCo/affiliates", origin: "https://x.com" },
};

const tabElement = {
  textContent: "",
  getAttribute(name) {
    if (name === "aria-selected") return "true";
    return null;
  },
};

const messageListeners = [];
windowStub.addEventListener = (type, fn) => {
  if (type === "message") messageListeners.push(fn);
};
windowStub.postMessage = () => {};

const documentStub = {
  cookie: "ct0=csrf-token-value; auth_token=session",
  head: { appendChild() {} },
  body: bodyElement,
  documentElement: { appendChild() {} },
  scrollingElement: scroller,
  querySelector(selector) {
    if (selector === '[data-testid="primaryColumn"]') return primaryPresent ? primaryElement : null;
    if (selector === '[data-testid="sidebarColumn"]') return sidebarElement;
    if (selector === LIST_SELECTOR) return sectionPresent ? section : null;
    if (selector === '[role="tab"][aria-selected="true"]') {
      if (!selectedTabText) return null;
      tabElement.textContent = selectedTabText;
      return tabElement;
    }
    if (selector === "main") return mainElement;
    return null;
  },
  querySelectorAll(selector) {
    if (selector === LIST_SELECTOR) {
      const regions = [];
      if (decoySectionPresent) regions.push(decoySection);
      regions.push(sidebarSection);
      if (sectionPresent) regions.push(section);
      return regions;
    }
    if (selector === '[role="tab"]') {
      if (!selectedTabText) return [];
      tabElement.textContent = selectedTabText;
      return [tabElement];
    }
    return [];
  },
  getElementById(id) {
    return id === PANEL_ID && injectedPanel && injectedPanel.isConnected
      ? injectedPanel
      : null;
  },
  createElement: makeElement,
};

// ---------------------------------------------------------------------------
// Network stub
// ---------------------------------------------------------------------------

const calls = [];
let responder = () => ({ status: 200 });

const fetchStub = async (url, init) => {
  calls.push({ url, init });
  const plan = responder(url, init);
  const status = plan.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(plan.headers || {}),
    json: async () => plan.body ?? {},
  };
};

class MutationObserverStub {
  constructor(callback) {
    this.callback = callback;
  }
  observe() {}
}

// ---------------------------------------------------------------------------
// chrome.storage stub, where the daily cap is persisted
// ---------------------------------------------------------------------------

const storage = new Map();

// chrome.* calls throw this after the extension is reloaded under a live
// content script.
let storageError = null;

// Mirrors content.js's key format, so a format change gets caught here.
function todayKey(now = new Date()) {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

const chromeStub = {
  // content.js probes id for liveness, and undefined means orphaned.
  runtime: { id: "test-extension", getURL: (path) => `chrome-extension://test/${path}` },
  storage: {
    local: {
      async get(key) {
        if (storageError) throw storageError;
        return storage.has(key) ? { [key]: storage.get(key) } : {};
      },
      async set(entries) {
        if (storageError) throw storageError;
        for (const [key, value] of Object.entries(entries)) storage.set(key, value);
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const context = vm.createContext({
  window: windowStub,
  document: documentStub,
  location: windowStub.location,
  chrome: chromeStub,
  MutationObserver: MutationObserverStub,
  fetch: fetchStub,
  alert: (message) => {
    lastAlert = message;
  },
  confirm: () => confirmAnswer,
  // The panel reads the column's background and pinned offset. Only the calls
  // matter here.
  getComputedStyle: () => ({
    position: "static",
    top: "auto",
    backgroundColor: "rgb(0, 0, 0)",
  }),
  console,
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval: () => {},
  Date: FakeDate,
  Math,
  JSON,
  URL,
  URLSearchParams,
  Headers,
});

vm.runInContext(source, context, { filename: "content.js" });

assert.equal(typeof context.collectAllTargets, "function", "content.js should load");
assert.ok(injectedPanel, "controls should be injected on the affiliates page");
assert.equal(injectedPanel.id, PANEL_ID);

const stopButton = findButton(injectedPanel, "Stop");
assert.ok(findButton(injectedPanel, "Mute all"), "panel should offer Mute all");
assert.ok(findButton(injectedPanel, "Block all"), "panel should offer Block all");
assert.ok(findButton(injectedPanel, "Mute + Block all"), "panel should offer both");
assert.ok(stopButton, "panel should offer Stop");
assert.equal(stopButton.hidden, true, "Stop should be hidden while idle");
assert.match(
  injectedPanel.style.cssText,
  /position:sticky/,
  "the panel has to stay put while a list thousands of rows long is scrolled"
);

// Feeds the bearer the way sniffer.js does.
for (const listener of messageListeners) {
  listener({
    source: windowStub,
    origin: windowStub.location.origin,
    data: {
      source: "affiliate-tools",
      type: "auth",
      authorization: "Bearer TESTTOKEN",
    },
  });
}

// ---------------------------------------------------------------------------
// Scrape
// ---------------------------------------------------------------------------

console.log("checking the scraper does not widen past the list container...");
sectionPresent = false;
assert.deepEqual(
  [...context.currentRows()],
  [],
  "a missing container must not fall back to the rest of the page"
);
sectionPresent = true;

console.log(`scraping ${ROW_COUNT} virtualised rows...`);
handleReads = 0;
const targets = await context.collectAllTargets({ maxMs: 30000, settleRounds: 3 });

assert.equal(targets.length, ROW_COUNT, "should materialise every row by scrolling");

// The same rows stay rendered across several steps of the walk, so each row
// caches its parsed handle.
assert.ok(
  handleReads <= ROW_COUNT,
  `a row's handle should be parsed once, not once per pass - ${handleReads} ` +
    `parses for ${ROW_COUNT} rows`
);
assert.deepEqual(
  { ...targets[0] },
  { handle: "acct_0", userId: "1000", state: "follow" },
  "should pair handle with the numeric user id and the row's state"
);
assert.equal(targets[3].handle, "acct_3", "unblock-state rows should still be collected");
assert.equal(
  /@/.test(cells[0].button.getAttribute("aria-label")),
  false,
  "the fixture must leave the handle out of the button label, as the live list does"
);

console.log("checking the in-list loading probe...");
section.loading = false;
assert.equal(context.listIsLoading(), false, "no spinner means not loading");
section.loading = true;
assert.equal(context.listIsLoading(), true, "a progressbar inside the list means loading");
section.loading = false;

console.log("checking the diagnostic waits for the page to settle...");

// Leaving and returning restarts the "on this view since" timer.
windowStub.location.href = "https://x.com/SomeCo/";
context.checkAndInject();
windowStub.location.href = "https://x.com/SomeCo/affiliates";
sectionPresent = false;
context.checkAndInject();

assert.equal(
  bodyElement.appended.length,
  0,
  "a container that has not rendered yet must not be reported as missing"
);

advanceClock(9000);
context.checkAndInject();

assert.equal(
  bodyElement.appended.length,
  1,
  "once the page has settled the missing container should be reported as a banner"
);
assert.match(
  injectedPanel.children[0].textContent,
  /no affiliates list found after \d+s/,
  "the report should say how long it waited, so a timing problem is visible"
);
assert.equal(
  findButton(injectedPanel, "Block all").disabled,
  true,
  "actions must be disabled when there is no list to act on"
);
assert.equal(
  findButton(injectedPanel, "Reset cap").disabled,
  false,
  "the budget counter belongs to the extension, so a missing list must not lock it"
);

sectionPresent = true;
context.checkAndInject();
assert.equal(
  findButton(injectedPanel, "Block all").disabled,
  false,
  "the panel should recover once the container appears"
);

console.log("checking the sidebar's own regions are not mistaken for the list...");
// Forces the document-order fallback, with the sidebar section listed first.
primaryPresent = false;
panelHost.inserted.length = 0;
context.removePanel();
context.checkAndInject();

assert.equal(
  sidebarHost.inserted.length,
  0,
  "a region inside the sidebar must never be used as the panel anchor"
);
assert.equal(
  panelHost.inserted.length,
  1,
  "the real list container should win even when the sidebar comes first"
);
primaryPresent = true;

console.log("checking the container with the rows wins over document order...");

// A column can hold several accessible-list regions, and the affiliates list is
// identified by the row actions inside it.
decoySectionPresent = true;
context.removePanel();
context.checkAndInject();

assert.equal(
  decoyHost.inserted.length,
  0,
  "a region with no rows in it must not be used as the panel anchor"
);
assert.equal(
  panelHost.inserted.length,
  2,
  "the region holding the row actions should be the anchor"
);

decoySectionPresent = false;

console.log("checking the list lookup is not repeated on every step...");

// Re-resolving the container on each of the walk's hundreds of steps costs a
// document-wide query plus a row count per candidate, so the answer is held
// until the container leaves the document.
section.isConnected = true;
const cached = context.affiliatesSection();
assert.ok(cached, "the list should still resolve");
assert.equal(
  context.affiliatesSection(),
  cached,
  "a repeated lookup must return the held answer, not re-scan the page"
);

section.isConnected = false;
sectionPresent = false;
assert.equal(context.affiliatesSection(), null, "a detached container must not be reused");

// Back to the fixture default: no isConnected, so no hold.
sectionPresent = true;

console.log("checking the affiliates view is detected without an /affiliates path...");

// The list can also be a selected tab on the followers page, where the URL
// never changes.
selectedTabText = "Affiliates";
windowStub.location.href = "https://x.com/SomeCo/following";
context.checkAndInject();

assert.ok(injectedPanel, "a selected Affiliates tab must be enough to inject the panel");
assert.equal(
  findButton(injectedPanel, "Block all").disabled,
  false,
  "the actions should be live on a tab-detected affiliates view"
);

selectedTabText = "Followers";
context.checkAndInject();
assert.equal(
  documentStub.getElementById(PANEL_ID),
  null,
  "a different tab must take the panel away again"
);

console.log("checking a tab switch drops the list held for the previous tab...");

// On a tab-detected view the path cannot invalidate the held container, and the
// list node survives the switch even though it belongs to the old tab.
section.isConnected = true;
windowStub.location.href = "https://x.com/SomeCo/following";
selectedTabText = "Affiliates";
context.checkAndInject();
assert.equal(context.affiliatesSection(), section, "the affiliates tab should resolve the list");

selectedTabText = "Followers";
sectionPresent = false;
context.checkAndInject();
assert.equal(
  context.affiliatesSection(),
  null,
  "a tab switch must drop the container held for the previous tab, still-connected or not"
);

sectionPresent = true;
section.isConnected = false;
selectedTabText = null;
windowStub.location.href = "https://x.com/SomeCo/affiliates";
context.checkAndInject();
assert.ok(injectedPanel, "the /affiliates route should still inject the panel");

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

console.log("running mute + block over the first 3 targets...");
responder = () => ({ status: 200 });
calls.length = 0;
const summary = await context.runActions(["mute", "block"], targets.slice(0, 3), () => {});

assert.deepEqual({ ...summary.totals.mute }, { applied: 3, noop: 0, failed: 0 });
assert.deepEqual({ ...summary.totals.block }, { applied: 3, noop: 0, failed: 0 });
assert.equal(summary.processed, 3);
assert.equal(summary.stopReason, null);

assert.deepEqual(
  calls.map((c) => new URL(c.url).pathname),
  [MUTE_PATH, BLOCK_PATH, MUTE_PATH, BLOCK_PATH, MUTE_PATH, BLOCK_PATH]
);
assert.equal(calls[0].init.method, "POST");
assert.equal(calls[0].init.credentials, "include");
assert.equal(calls[0].init.body, "user_id=1000");
assert.equal(calls[0].init.headers["x-csrf-token"], "csrf-token-value");
assert.equal(calls[0].init.headers.authorization, "Bearer TESTTOKEN");

const blockAction = {
  key: "block",
  verb: "Block",
  past: "blocked",
  path: BLOCK_PATH,
};

console.log("checking 400 is a logged no-op, not a failure...");
responder = () => ({
  status: 400,
  body: { errors: [{ code: 158, message: "You have already blocked this user." }] },
});
calls.length = 0;
const noop = await context.applyAction(blockAction, { handle: "acct_0", userId: "1000" });
assert.deepEqual(
  { ...noop },
  { ok: true, noop: true, detail: "158 You have already blocked this user." },
  "400 should short-circuit as a no-op, carrying the body"
);
assert.equal(calls.length, 1, "400 should not be retried");

console.log("checking 429 backs off and retries...");
let firstAttempt = true;
responder = () => {
  if (firstAttempt) {
    firstAttempt = false;
    return {
      status: 429,
      headers: { "x-rate-limit-reset": String(Math.floor(Date.now() / 1000)) },
    };
  }
  return { status: 200 };
};
calls.length = 0;
const retried = await context.applyAction(blockAction, { handle: "acct_0", userId: "1000" });
assert.deepEqual({ ...retried }, { ok: true }, "429 should be retried, not dropped");
assert.equal(calls.length, 2, "429 should cost exactly one retry");

console.log("checking a 400 that is not 'already' stays a failure...");
responder = () => ({
  status: 400,
  body: {
    errors: [
      { code: 353, message: "This request requires a valid transaction ID." },
    ],
  },
});
calls.length = 0;
const rejected = await context.applyAction(blockAction, { handle: "acct_0", userId: "1000" });
assert.equal(rejected.ok, false, "only 'already in state' 400s may be swallowed");
assert.match(rejected.reason, /353/, "the failure should carry X's own message");
assert.equal(calls.length, 1, "400 should not be retried");

console.log("checking no-ops are tallied separately and do not trip the breaker...");
responder = () => ({
  status: 400,
  body: { errors: [{ code: 158, message: "You have already blocked this user." }] },
});
calls.length = 0;
const noops = await context.runActions(
  ["block"],
  targets.slice(0, MAX_FAILURES_IN_A_ROW),
  () => {}
);
assert.deepEqual({ ...noops.totals.block }, {
  applied: 0,
  noop: MAX_FAILURES_IN_A_ROW,
  failed: 0,
});
assert.equal(
  noops.stopReason,
  null,
  `${MAX_FAILURES_IN_A_ROW} consecutive no-ops must not trip a ${MAX_FAILURES_IN_A_ROW}-failure breaker`
);

console.log("checking the circuit breaker...");
responder = () => ({ status: 500, body: { errors: [{ message: "boom" }] } });
calls.length = 0;
const aborted = await context.runActions(["block"], targets.slice(0, 10), () => {});
assert.equal(aborted.stopReason, "circuit-breaker");
assert.equal(calls.length, 5, "should abort after 5 consecutive failures");
assert.equal(aborted.totals.block.failed, 5, "partial tallies should survive the abort");

// ---------------------------------------------------------------------------
// Daily request cap
// ---------------------------------------------------------------------------

console.log("checking the daily cap is enforced at the request level...");
responder = () => ({ status: 200 });

// The last unit of budget must still be spendable, then the run stops.
storage.set("dailyQuota", { day: todayKey(), used: DAILY_REQUEST_CAP - 1 });
calls.length = 0;
const capped = await context.runActions(["block"], targets.slice(0, 4), () => {});

assert.equal(capped.stopReason, "daily-cap");
assert.equal(calls.length, 1, "only the remaining budget should be spent");
assert.deepEqual({ ...capped.totals.block }, { applied: 1, noop: 0, failed: 0 });
assert.equal(capped.processed, 1, "the capped run should stop where the budget ran out");

console.log("checking the cap rolls over at local midnight...");
storage.set("dailyQuota", { day: "2020-01-01", used: DAILY_REQUEST_CAP });
calls.length = 0;
const fresh = await context.runActions(["block"], targets.slice(0, 3), () => {});

assert.equal(fresh.stopReason, null, "yesterday's count is not today's count");
assert.deepEqual({ ...fresh.totals.block }, { applied: 3, noop: 0, failed: 0 });
assert.deepEqual(
  { ...storage.get("dailyQuota") },
  { day: todayKey(), used: 3 },
  "the counter should be rewritten under today's key"
);
assert.equal(await context.remainingToday(), DAILY_REQUEST_CAP - 3);

console.log("checking a combined run costs one request per action...");
storage.clear();
calls.length = 0;
const combined = await context.runActions(["mute", "block"], targets.slice(0, 3), () => {});

assert.equal(combined.stopReason, null);
assert.equal(calls.length, 6);
assert.equal(
  storage.get("dailyQuota").used,
  6,
  "Mute + Block on 3 accounts should spend 6 of the daily budget"
);

console.log("checking the cap can be reset by hand from the panel...");
storage.set("dailyQuota", { day: todayKey(), used: DAILY_REQUEST_CAP });

const resetButton = findButton(injectedPanel, "Reset cap");
assert.ok(resetButton, "the panel should offer a manual cap reset");
assert.equal(
  resetButton.disabled,
  false,
  "the reset should be available while nothing is running"
);

confirmAnswer = false;
click(resetButton);
await sleep(20);
assert.equal(
  storage.get("dailyQuota").used,
  DAILY_REQUEST_CAP,
  "declining the confirmation must leave the counter alone"
);

confirmAnswer = true;
click(resetButton);
await sleep(20);
assert.deepEqual(
  { ...storage.get("dailyQuota") },
  { day: todayKey(), used: 0 },
  "a confirmed reset should zero today's counter"
);
assert.equal(
  await context.remainingToday(),
  DAILY_REQUEST_CAP,
  "the whole daily budget should be available again"
);
assert.match(
  injectedPanel.children[0].textContent,
  /daily cap reset/,
  "the panel should report the reset rather than the old readout"
);

console.log("checking a reset cap survives into a real run...");
calls.length = 0;
const afterReset = await context.runActions(["block"], targets.slice(0, 3), () => {});
assert.equal(afterReset.stopReason, null, "the reset budget should not stop the run");
assert.equal(calls.length, 3, "the requests spent after a reset are counted from zero");
assert.equal(storage.get("dailyQuota").used, 3, "the counter restarts from the reset");

storage.clear();
confirmAnswer = true;

// ---------------------------------------------------------------------------
// Cancellation, driven through the real UI
// ---------------------------------------------------------------------------

console.log("checking Stop ends a run early...");
responder = () => ({ status: 200 });
calls.length = 0;

const blockAll = findButton(injectedPanel, "Block all");
const run = blockAll.listeners.click[0]();

const progressText = () => injectedPanel?.children[0].textContent ?? "";
const deadline = Date.now() + 60000;
while (!/@acct_/.test(progressText()) && Date.now() < deadline) await sleep(100);

assert.ok(calls.length > 0, "the run should reach the API phase");
assert.match(progressText(), /\d+\/\d+/, "the run should report per-account progress");

// Simulate X re-rendering the virtualised list and taking the panel with it.
injectedPanel.isConnected = false;
injectedPanel = null;
context.checkAndInject();

assert.ok(injectedPanel, "the panel should be rebuilt after a re-render");
const liveStatus = injectedPanel.children[0];
const liveStop = findButton(injectedPanel, "Stop");
assert.match(
  liveStatus.textContent,
  /\d+\/\d+/,
  "a rebuilt panel must show the live progress, not look idle"
);
assert.equal(liveStop.hidden, false, "a rebuilt panel must know a run is in flight");
assert.equal(
  findButton(injectedPanel, "Reset cap").disabled,
  true,
  "the cap must not be resettable while a run is spending it"
);
assert.equal(
  findButton(injectedPanel, "Block all").disabled,
  true,
  "a rebuilt panel must not offer a second concurrent run"
);

click(liveStop);
await run;

assert.ok(
  calls.length < ROW_COUNT,
  `Stop should end the run early, but ${calls.length} calls were made`
);
assert.match(liveStatus.textContent, /stopped early/, "the panel should report the stop");
assert.equal(liveStop.hidden, true, "Stop should hide again once the run ends");

// ---------------------------------------------------------------------------
// Navigation abort, also driven through the UI
// ---------------------------------------------------------------------------

console.log("checking a run aborts when the user navigates away...");
calls.length = 0;

// start() paints "collecting affiliates..." synchronously, so a per-account
// line means the API phase.
const run2 = findButton(injectedPanel, "Block all").listeners.click[0]();

const navDeadline = Date.now() + 60000;
while (!/@acct_/.test(progressText()) && Date.now() < navDeadline) await sleep(100);
assert.match(progressText(), /\d+\/\d+/, "the second run should reach the API phase");

// Navigating away mid-run. The affiliates selector would start matching
// whatever timeline is now on screen.
windowStub.location.href = "https://x.com/SomeCo/with_replies";
await run2;

assert.ok(
  calls.length < ROW_COUNT,
  `navigating away should end the run early, but ${calls.length} calls were made`
);
assert.match(
  progressText(),
  /left the affiliates page/,
  "leaving the page mid-run should abort the run and say so"
);

windowStub.location.href = "https://x.com/SomeCo/affiliates";

// ---------------------------------------------------------------------------
// A long list that is mostly already blocked
// ---------------------------------------------------------------------------

console.log("checking which row states count as already done...");
assert.equal(context.alreadyInState("unblock", ["block"]), true);
assert.equal(
  context.alreadyInState("unblock", ["mute"]),
  false,
  "a blocked row says nothing about whether it is muted"
);
assert.equal(
  context.alreadyInState("unblock", ["mute", "block"]),
  false,
  "a combined run must still mute a blocked account"
);
assert.equal(
  context.alreadyInState("follow", ["block"]),
  false,
  "a row waiting to be followed is still not blocked"
);
assert.equal(
  context.alreadyInState("unblock", []),
  false,
  "with no requested action nothing may be assumed done"
);

console.log("checking the scan reaches the bottom without skipping a screen...");

// Rows 0-19 are blocked and only the tail needs work, which is where long lists
// used to crawl.
actionedRowCount = 20;
uniformAction = null;
viewStart = 0;
scrollDeltas.length = 0;
maxScrollTop = 0;

const mixed = await context.collectAllTargets();

assert.equal(mixed.length, ROW_COUNT, "the walk must see every row");

// Rows 20-24 are the tail, except index 23, which stays blocked.
const stillToBlock = mixed.filter((row) => row.state !== "unblock");
assert.equal(
  stillToBlock.length,
  4,
  "the rows that still need blocking should survive the scan"
);
assert.equal(
  stillToBlock[0].handle,
  "acct_20",
  "the scan must not stop at the already-blocked prefix"
);

const bottom = scroller.scrollHeight - scroller.clientHeight;
assert.equal(maxScrollTop, bottom, "the scan has to pull to the bottom of the list");
// Each step stays under one screen so consecutive windows overlap and no row
// falls between them.
assert.ok(
  scrollDeltas.every((delta) => delta > 0 && delta < scroller.clientHeight),
  `every step must overlap the last, got ${JSON.stringify(scrollDeltas)}`
);

console.log("checking a list that pages in as it is scrolled is read whole...");

// Rows arrive a page at a time as the bottom is reached.
actionedRowCount = 20;
pagingEnabled = true;
loadedRowCount = PAGE_SIZE;
viewStart = 0;
maxScrollTop = 0;

const paged = await context.collectAllTargets();

assert.equal(
  paged.length,
  ROW_COUNT,
  `a paged list must be read to the end, got ${paged.length} of ${ROW_COUNT} rows`
);
assert.equal(
  paged.filter((row) => row.state !== "unblock").length,
  4,
  "the rows that still need blocking must survive a paged scan"
);

pagingEnabled = false;
loadedRowCount = ROW_COUNT;
actionedRowCount = null;

console.log("checking a fully blocked list reports nothing to do...");
uniformAction = "unblock";
actionedRowCount = null;
calls.length = 0;
lastAlert = null;
storage.clear();

await findButton(injectedPanel, "Block all").listeners.click[0]();

assert.match(
  lastAlert,
  /already blocked/,
  "an all-blocked list should say so instead of 'no affiliate handles found'"
);
assert.equal(calls.length, 0, "nothing may be sent for accounts already in that state");

// That run ended in a dialog and set no status, so the panel falls back to the
// budget readout.
await sleep(30);
assert.match(
  injectedPanel.children[0].textContent,
  /requests left today/,
  "a run that ends in a dialog should fall back to the idle budget readout"
);

uniformAction = null;

console.log("checking a list whose rows carry no action says what it found...");

// X renders an account it already considers blocked as a static label with no
// button, so no row here is actionable.
uniformTestId = "UserCell";
lastAlert = null;
calls.length = 0;

await findButton(injectedPanel, "Block all").listeners.click[0]();

assert.match(
  lastAlert,
  /No affiliate handles found/,
  "an unreadable list still has to end in the same outcome"
);
assert.match(
  lastAlert,
  /profile link/,
  "the message should say the rows were there, not that the list was missing"
);
assert.match(
  lastAlert,
  /already shows as blocked has no button/,
  "the message should name the likely cause"
);
assert.equal(calls.length, 0, "nothing may be sent when no row could be read");

uniformTestId = null;

// ---------------------------------------------------------------------------
// Extension reloaded under an open page (orphaned content script)
// ---------------------------------------------------------------------------

console.log("checking an orphaned script still runs instead of dying...");
responder = () => ({ status: 200 });
storage.clear();
calls.length = 0;

// A reload leaves this script with its DOM and listener while chrome.runtime.id
// is gone and every chrome.* call throws.
chromeStub.runtime.id = undefined;

const orphaned = await context.runActions(["block"], targets.slice(0, 2), () => {});

assert.equal(orphaned.stopReason, null, "an orphaned script should finish the run");
assert.equal(
  calls.length,
  2,
  "the API calls do not go through chrome.*, so they must still be sent"
);
assert.deepEqual({ ...orphaned.totals.block }, { applied: 2, noop: 0, failed: 0 });
assert.equal(storage.has("dailyQuota"), false, "a dead binding must not be written through");

console.log("checking the panel says to refresh while the context is dead...");
context.checkAndInject();
assert.match(
  progressText(),
  /Refresh this page/,
  "an orphaned panel should name the fix instead of failing on the first request"
);

console.log("checking a storage call that dies mid-run is survivable...");
chromeStub.runtime.id = "test-extension";
storageError = new Error("Extension context invalidated.");
storage.clear();
calls.length = 0;

const midRun = await context.runActions(["block"], targets.slice(0, 2), () => {});

assert.equal(midRun.stopReason, null, "a storage failure must not kill the run");
assert.equal(calls.length, 2, "the requests themselves are unaffected by storage");
assert.deepEqual({ ...midRun.totals.block }, { applied: 2, noop: 0, failed: 0 });
storageError = null;

console.log("checking the panel recovers once storage is reachable again...");
context.removePanel();
context.checkAndInject();
await sleep(20);
assert.match(progressText(), /requests left today/, "a live context should show the budget again");


console.log("checking the walk settles at the bottom instead of scrolling on...");

// X keeps re-rendering the virtualised window after the bottom is reached. A
// walk that reads any change there as progress never settles and scrolls until
// it runs into its own ceiling.
churnAtBottom = true;
churnTick = 0;
viewStart = 0;
scroller.scrollTop = 0;
uniformAction = null;
actionedRowCount = null;
pagingEnabled = false;
loadedRowCount = ROW_COUNT;
scrollDeltas.length = 0;

const churned = await context.collectAllTargets({ maxMs: 30000 });
churnAtBottom = false;

assert.equal(churned.length, ROW_COUNT, "a churning list must still be read whole");
assert.ok(
  scrollDeltas.length < 60,
  `the walk has to settle at the bottom, took ${scrollDeltas.length} steps`
);

console.log("checking a list that only moves through scrollIntoView is read whole...");

// scrollTop never advances here, so progress can only come from the rows that
// turn up after the last rendered one is pulled into view.
frozenScroller = true;
viewStart = 0;
scroller.scrollTop = 0;

const fellBack = await context.collectAllTargets({ maxMs: 30000 });
frozenScroller = false;

assert.equal(
  fellBack.length,
  ROW_COUNT,
  `a list that only moves through scrollIntoView must still be read whole, got ${fellBack.length}`
);


console.log("checking the scan stops at the end instead of bouncing there...");

// The scan reaches the end, cannot scrollBy any further, and falls back to
// pulling the last row into view. That shifts the position, the next step
// scrolls down again, and the pair repeats for as long as the walk is allowed
// to run.
bounceAtBottom = true;
viewStart = 0;
scroller.scrollTop = 0;
uniformAction = null;
actionedRowCount = null;
pagingEnabled = false;
loadedRowCount = ROW_COUNT;
scrollDeltas.length = 0;

const bounced = await context.collectAllTargets({ maxMs: 30000 });
bounceAtBottom = false;

assert.equal(bounced.length, ROW_COUNT, "the list still has to be read whole");
// Reaching the end of this fixture takes 8 steps, plus the settle rounds. A
// walk that bounces at the end instead runs until its time limit stops it.
assert.ok(
  scrollDeltas.length < 20,
  `the scan has to stop at the end of the list, took ${scrollDeltas.length} steps`
);

console.log("\nall checks passed");
