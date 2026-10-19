// Home daily screens (team trial round 1): the two pages everyone starts from, then the user's most
// used pages and the pages and records they opened last, from their page views (§13.18).
import { PAGES, pageForPath, type PageDef } from "../nav/registry";

export interface MyPage {
  path: string;
  title: string | null;
  views: number;
  lastAt: string;
}

export interface HomeEntry {
  path: string;
  label: string;
  page: PageDef;
  /** Times opened in the last 30 days (most used), or when last opened (recent). */
  views?: number;
  lastAt?: string;
}

/** Always first: the live view of the platform. */
export const PINNED = ["dashboard", "live-analytics"];
/** Shown as most used until the user has a history. */
export const DEFAULT_DAILY = ["enterprises", "rate-manager", "route-rules", "rate-lookup", "enterprise-report"];
const SKIP = new Set(["home", "help"]);

const recordLabel = (p: MyPage, page: PageDef) => {
  if (p.path === page.path) return page.label;
  const id = /\/(\d+)$/.exec(p.path)?.[1];
  const kind = page.key === "enterprises" ? "Enterprise" : page.label.replace(/s$/, "");
  return p.title ?? (id ? `${kind} #${id}` : page.label);
};

export function homeEntries(pages: MyPage[], limits = { mostUsed: 6, recent: 8 }) {
  const pinned = PINNED.map((k) => PAGES.find((p) => p.key === k)!).map((page) => ({
    path: page.path,
    label: page.label,
    page,
  }));
  // Most used: views summed per page (a record counts for its list page), pinned pages left out.
  const byPage = new Map<string, number>();
  for (const p of pages) {
    const page = pageForPath(p.path);
    if (!page || SKIP.has(page.key) || PINNED.includes(page.key)) continue;
    byPage.set(page.key, (byPage.get(page.key) ?? 0) + p.views);
  }
  let mostUsed: HomeEntry[] = [...byPage.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limits.mostUsed)
    .map(([key, views]) => {
      const page = PAGES.find((p) => p.key === key)!;
      return { path: page.path, label: page.label, page, views };
    });
  const fromHistory = mostUsed.length > 0;
  if (!fromHistory)
    mostUsed = DEFAULT_DAILY.map((k) => PAGES.find((p) => p.key === k)!).map((page) => ({
      path: page.path,
      label: page.label,
      page,
    }));
  // Recent: pages and records, last opened first (the list is already in that order).
  const recent: HomeEntry[] = [];
  for (const p of pages) {
    const page = pageForPath(p.path);
    if (!page || SKIP.has(page.key)) continue;
    recent.push({ path: p.path, label: recordLabel(p, page), page, lastAt: p.lastAt });
    if (recent.length >= limits.recent) break;
  }
  return { pinned, mostUsed, fromHistory, recent };
}

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago". */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86_400);
  return d === 1 ? "yesterday" : `${d} days ago`;
}
