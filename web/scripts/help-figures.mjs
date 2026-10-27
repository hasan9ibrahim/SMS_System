// Help pictures (team trial round 6, §15.1 help): screenshots of the main pages with numbered arrows. Run against
// the fake-data stack (mock + vite on :5173) whenever a page's layout changes:
//
//   node web/scripts/help-figures.mjs [figure-id …]
//
// Writes web/public/help-img/<id>.jpg and web/src/pages/help/content/figures.json (picture size, and for every mark
// the spot it points at and where its numbered bubble sits, in % of the picture). The help center draws the arrows
// over the picture (HelpPage Figure), so they stay sharp at any size. Fake data only: never point this at a live
// platform.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.HELP_BASE ?? "http://127.0.0.1:5173";
const API = process.env.HELP_API ?? "http://127.0.0.1:4010/api/v1";
const W = 1440;
const H = 860;
const GAP = 64; // bubble distance from its spot, px

/**
 * One picture per figure. A mark points at the centre of the first visible element `sel` matches (Playwright
 * selector). `gap` overrides the bubble distance. `at` is where the bubble sits from the spot: n, s, e, w, ne, nw, se, sw.
 */
const FIGURES = [
  {
    id: "layout",
    path: "/enterprises",
    alt: "The window: menu bar, page tabs, page header and status bar",
    marks: [
      { sel: ".topbar .menu-top >> nth=0", at: "s", label: "Main menu", text: "Every page, by area. Hover a heading to see its pages." },
      { sel: "button.jump", at: "s", label: "Search or jump to (Ctrl K)", text: "Type a page, enterprise, trunk, rate table, rule or user. Your favourite pages come first." },
      { sel: "button.tps-pill", at: "s", label: "Live TPS", text: "Messages per second right now, over the whole platform." },
      { sel: "button.bell", at: "s", gap: 110, label: "Alerts", text: "Open incidents. A red count means something needs a look." },
      { sel: "button.avatar", at: "s", gap: 56, label: "Your menu", text: "Theme (light, dark, blue-grey), My changes, password, alert sounds and sign out." },
      { sel: ".tabstrip .tab >> nth=2", at: "se", label: "Page tabs", text: "Each page opens in a tab. Drag a tab out to give it its own window." },
      { sel: "button.tabs-split", at: "sw", label: "Split view", text: "Two pages side by side in one window." },
      { sel: "[aria-label='Help for this page']", at: "se", gap: 80, label: "Help for this page", text: "Opens the help topic of the page you are on." },
      { sel: ".statusbar", at: "n", xyFrom: "left", label: "Status bar", text: "Rows shown, keyboard shortcuts, and live/autosave state." },
    ],
  },
  {
    id: "grids",
    path: "/routing/rules",
    alt: "A list page: quick search, column filters, views and columns",
    marks: [
      { sel: "input.pill-search-input", at: "s", label: "Quick search", text: "Type to search. Pick a field from the list to turn your text into a filter pill." },
      { sel: "input[aria-label='Filter Rule']", at: "s", label: "Column filter", text: "Every column has a filter under its title. `%` matches anything, `_` one character." },
      { sel: "button.gf-select >> nth=0", at: "s", label: "Pick-list filter", text: "Columns with fixed values filter with a checklist." },
      { sel: "button:has-text('Views')", at: "sw", label: "Views", text: "Save the filters, sorting and columns you use often, and open them again in one click." },
      { sel: "button:has-text('Columns')", at: "sw", label: "Columns", text: "Show, hide and reorder columns." },
      { sel: ".gh-cell >> nth=2", at: "s", label: "Sort", text: "Click a column title to sort; click again to reverse." },
      { sel: "input[aria-label^='Select row'] >> nth=1", at: "e", label: "Select rows", text: "Tick rows for the actions in the header (Clone, Delete, Edit, More)." },
    ],
  },
  {
    id: "route-rules",
    path: "/routing/rules",
    alt: "Route rules page",
    marks: [
      { sel: "button:has-text('New rule')", at: "s", label: "New rule", text: "Opens the full rule window: general, configuration, conditions and vendors, saved with one Save." },
      { sel: "button:has-text('Simulate')", at: "s", label: "Simulate", text: "Test which rule and vendor a message would take, before or after a change." },
      { sel: "button.btn-ghost:has-text('History')", at: "s", label: "Undo and History", text: "Undo your last save, or see every change to rules." },
      { sel: ".ra-btn:has-text('Clone')", at: "sw", label: "Row actions", text: "Clone, Delete, Edit and More act on the ticked rules. Clone opens a prefilled New rule window." },
      { sel: "input[aria-label='Filter Customer trunks']", at: "s", label: "Trunk filters", text: "A trunk search also finds rules that apply to all trunks." },
      { sel: "button.dot-toggle >> nth=0", at: "w", label: "On / off", text: "Click the dot to turn a rule on or off." },
      { sel: "input[aria-label='Filter Vendors']", at: "s", label: "Vendors", text: "Hover for each vendor's share, cost and live volume. Click a row to open its detail panel." },
    ],
  },
  {
    id: "rate-manager",
    path: "/rates/manager",
    alt: "Rate manager list of rate tables",
    marks: [
      { sel: "button.on:has-text('Customer')", at: "s", label: "Customer or vendor", text: "Switch between customer (selling) and vendor (buying) rate tables." },
      { sel: "button:has-text('New rate table')", at: "s", label: "New rate table", text: "Create an empty table, then add rates or import a sheet." },
      { sel: ".ra-btn:has-text('Send rates')", at: "sw", label: "Send rates", text: "E-mail the current rate sheet to every live customer trunk using the ticked tables. A summary shows who got it." },
      { sel: "button.link.strong >> nth=0", at: "e", label: "Open a table", text: "Click a name to open the table: rates, history, and editable rate cells (dashed boxes)." },
      { sel: "input[aria-label='Filter Neg. Margin']", at: "s", label: "Negative margin", text: "Filter tables that sell below cost somewhere." },
    ],
  },
  {
    id: "rate-lookup",
    path: "/rates/rate-lookup",
    alt: "Rate lookup with customer and vendor sides",
    marks: [
      { sel: "input[aria-label='Search both sides']", at: "s", label: "Search both sides", text: "One search for destination, country or MCCMNC on both sides at once." },
      { sel: "button.on:has-text('Side by side')", at: "s", label: "Layouts", text: "Side by side, one destination at a time, or the advanced lookup." },
      { sel: "button.checklist-btn >> nth=1", at: "s", label: "Side filters", text: "Narrow each side by product, trunk, country or network." },
      { sel: "button.vt-sort >> nth=0", at: "s", label: "Expand a destination", text: "Click a destination row to see every table's rate for it." },
    ],
  },
  {
    id: "live-analytics",
    path: "/live/analytics",
    alt: "Live analytics report",
    marks: [
      { sel: "button.btn:has-text('Live')", at: "s", label: "Live / Pause", text: "Figures stream in place. Pause to read them still; the tab shows a light while live." },
      { sel: "button.on:has-text('Today')", at: "s", label: "Period", text: "Today, yesterday, last 7 days, months, or any range with the date chip." },
      { sel: "button.btn:has-text('Columns')", at: "sw", label: "Columns", text: "Pick the figures to show, grouped by Traffic, Quality, Billing and Network." },
      { sel: "input.la-row-search", at: "s", label: "Search rows", text: "Starts-with search on the names in the first column." },
      { sel: "button.la-sort:has-text('Margin')", at: "s", label: "Sort", text: "Click any column title to sort high to low; again for low to high." },
      { sel: ".la-grid tbody tr >> nth=3", at: "e", gap: 110, xyFrom: "left", label: "Expand a row", text: "Click a name to break it down (by trunk, vendor, country…). Double-click for its detail." },
    ],
  },
  {
    id: "dashboard",
    path: "/dashboard",
    alt: "Live dashboard",
    marks: [
      { sel: ".dash-kpi >> nth=0", at: "s", label: "Today's figures", text: "Attempts, submitted and delivered, money, ASR/DLR, TPS, who is online, and market moves." },
      { sel: "select:has(option:has-text('Live'))", at: "sw", label: "Refresh", text: "How often the dashboard updates. Live = every second." },
      { sel: "button:has-text('Panels')", at: "sw", label: "Panels", text: "Show or hide panels. Drag a panel by its corner handle to rearrange." },
      { sel: "text=Top clients today", at: "e", label: "Top lists", text: "Click a row to open its Live analytics view in a new tab." },
    ],
  },
  {
    id: "edr-search",
    path: "/monitoring/edr",
    alt: "EDR search",
    marks: [
      { sel: "select[aria-label='EDR Template']", at: "s", label: "Template", text: "Switch the columns in one click. \"All message details\" shows everything about each message." },
      { sel: ".range-chip >> nth=0", at: "s", label: "Period", text: "The time range searched. Today by default." },
      { sel: "input.pill-search-input", at: "s", label: "Number or message ID", text: "Type a phone number or a message ID, or pick a field to filter on." },
      { sel: "button:has-text('Columns')", at: "sw", label: "Columns", text: "Add or remove single columns on top of the template." },
      { sel: ".grid .gc >> nth=3", at: "s", label: "Open a message", text: "Click a row for every detail of that message and its receipts." },
    ],
  },
  {
    id: "enterprises",
    path: "/enterprises",
    alt: "Enterprises list",
    marks: [
      { sel: "button.btn-primary", at: "s", label: "New enterprise", text: "Add a partner. Customer and vendor trunks are added inside its record." },
      { sel: ".grid .gc >> nth=2", at: "e", label: "Open the record", text: "General info, documents, billing, contacts, trunks and rules, in tabs." },
      { sel: "input.pill-search-input", at: "s", label: "Search", text: "Find by name, brand or ID, or pick a field to filter on." },
    ],
  },
  {
    id: "simulator",
    path: "/routing/simulator",
    alt: "Route simulator",
    marks: [
      { sel: ".lookup-btn >> nth=0", at: "s", label: "Customer trunk", text: "The trunk the test message comes in on." },
      { sel: "input[placeholder^='447700']", at: "s", label: "Receivers", text: "One or more numbers, or switch to destination mode to pick networks." },
      { sel: "button:has-text('Simulate') >> nth=-1", at: "s", label: "Simulate", text: "Shows the matching rule, every vendor with why it would or would not get the message, and shadowed rules." },
    ],
  },
];

const POS = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0], ne: [0.8, -0.8], nw: [-0.8, -0.8], se: [0.8, 0.8], sw: [-0.8, 0.8] };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const pct = (v, of) => Math.round((v / of) * 10000) / 100;

// ---------------------------------------------------------------- bubble placement without clutter
// Each bubble tries its preferred side first, then the nearest other sides, at growing distances, and takes the first
// place where it touches no other bubble, spot or arrow and its arrow crosses no other arrow. The user asked that the
// arrows never cover one another (team trial round 6).
const R = 17; // bubble radius with its white ring
const ORDER = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function crosses(a, b) {
  const d = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const [p1, p2, p3, p4] = [
    { x: a.bx, y: a.by },
    { x: a.x, y: a.y },
    { x: b.bx, y: b.by },
    { x: b.x, y: b.y },
  ];
  return d(p1, p2, p3) * d(p1, p2, p4) < 0 && d(p3, p4, p1) * d(p3, p4, p2) < 0;
}

function clashes(c, self, spots, placed) {
  let n = 0;
  if (c.bx < R + 2 || c.bx > W - R - 2 || c.by < R + 2 || c.by > H - R - 2) n += 5;
  spots.forEach((s, j) => {
    if (j === self) return;
    if (Math.hypot(c.bx - s.x, c.by - s.y) < R + 8) n++; // bubble on another spot
    if (segDist(s.x, s.y, c.bx, c.by, c.x, c.y) < 9) n++; // arrow over another spot
  });
  for (const p of placed) {
    if (Math.hypot(c.bx - p.bx, c.by - p.by) < 2 * R + 6) n++; // bubbles touching
    if (segDist(c.bx, c.by, p.bx, p.by, p.x, p.y) < R + 4) n++; // bubble on another arrow
    if (segDist(p.bx, p.by, c.bx, c.by, c.x, c.y) < R + 4) n++; // arrow under another bubble
    if (crosses(c, p)) n++;
  }
  return n;
}

function place(s, self, spots, placed) {
  const first = s.m.at ?? "s";
  const k = ORDER.indexOf(first);
  // The preferred side, then its neighbours either way round.
  const sides = [0, 1, -1, 2, -2, 3, -3, 4].map((o) => ORDER[(k + o + 8) % 8]);
  const gaps = [...new Set([s.m.gap ?? GAP, 56, 80, 110, 140, 175])];
  let best = null;
  for (const gap of gaps)
    for (const side of sides) {
      const [dx, dy] = POS[side];
      const c = { x: s.x, y: s.y, bx: s.x + dx * gap, by: s.y + dy * gap };
      const n = clashes(c, self, spots, placed);
      if (n === 0) return { ...c, clashes: 0 };
      if (!best || n < best.clashes) best = { ...c, clashes: n };
    }
  return { ...best, bx: clamp(best.bx, R + 2, W - R - 2), by: clamp(best.by, R + 2, H - R - 2) };
}

async function api(method, path, body) {
  await fetch(API + path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

const only = process.argv.slice(2);
const outFile = join(ROOT, "src/pages/help/content/figures.json");
let out = {};
try {
  out = JSON.parse(readFileSync(outFile, "utf8"));
} catch {
  /* first run */
}

// A clean window: light theme and no open tabs, so every picture shows one page.
await api("PATCH", "/me/preferences", { theme: "light" });
const browser = await chromium.launch({ args: ["--no-proxy-server"] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
for (const f of FIGURES.filter((x) => !only.length || only.includes(x.id))) {
  await api("PUT", "/me/workspace", { tabs: [], activeTabId: null });
  await page.goto(BASE + f.path, { waitUntil: "load" });
  await page.waitForTimeout(5000);
  // First every spot, so no bubble or arrow lands on another mark's spot, then the bubbles one by one.
  const spots = [];
  for (const m of f.marks) {
    const box = await page.locator(`${m.sel} >> visible=true`).first().boundingBox().catch(() => null);
    if (!box) {
      console.warn(`${f.id}: nothing matches ${m.sel}`);
      continue;
    }
    const x = m.xyFrom === "left" ? box.x + Math.min(60, box.width / 2) : box.x + box.width / 2;
    spots.push({ m, x, y: box.y + box.height / 2 });
  }
  const placed = [];
  for (const [i, s] of spots.entries()) {
    const b = place(s, i, spots, placed);
    placed.push({ x: s.x, y: s.y, bx: b.bx, by: b.by });
    if (b.clashes) console.warn(`${f.id}: mark ${i + 1} (${s.m.label}) still touches ${b.clashes} other mark(s)`);
  }
  const marks = spots.map((s, i) => ({
    label: s.m.label,
    text: s.m.text,
    x: pct(s.x, W),
    y: pct(s.y, H),
    bx: pct(placed[i].bx, W),
    by: pct(placed[i].by, H),
  }));
  await page.screenshot({ path: join(ROOT, `public/help-img/${f.id}.jpg`), type: "jpeg", quality: 80 });
  out[f.id] = { src: `/help-img/${f.id}.jpg`, alt: f.alt, width: W, height: H, marks };
  console.log(`${f.id}: ${marks.length}/${f.marks.length} marks`);
}
await browser.close();
writeFileSync(outFile, JSON.stringify(out, null, 2) + "\n");
