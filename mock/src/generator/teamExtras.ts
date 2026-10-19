/**
 * Team activity (§13.18) for build step 5.18: 90 days of finished staff sessions (sign-in and last
 * seen per working day, with the occasional new device) and the pages opened in them. Runs last on
 * its own forked stream, so earlier tables are unchanged for the same seed. IPs are TEST-NET ranges.
 */
import type { Profile } from "./profiles.js";
import type { Rng } from "./rng.js";
import type { TableSink } from "./sink.js";
import { DAY, type World } from "./world.js";

/** Pages people open, by department (paths of the GUI's page registry). */
const COMMON = ["/", "/dashboard", "/enterprises", "/admin/changes"];
export const PAGES_BY_DEPARTMENT: Record<string, string[]> = {
  Sales: [
    "/enterprises",
    "/reports/sales",
    "/rates/lookup",
    "/reports/enterprise",
    "/rates/market-moves",
    "/routing/lcr",
  ],
  Rates: ["/rates/manager", "/rates/incoming", "/rates/market-moves", "/rates/lookup", "/routing/rules", "/rates/bulk"],
  NOC: ["/live", "/monitoring/incidents", "/routing/rules", "/observation/binds", "/observation/edrs", "/routing/qbr"],
  Billing: [
    "/finance/invoices",
    "/finance/transactions",
    "/finance/soa",
    "/finance/vendor-invoices",
    "/finance/balances",
  ],
  Management: ["/reports/team", "/reports/master", "/dashboard", "/reports/sales", "/live"],
  Admin: ["/admin/users", "/admin/audit", "/admin/visibility", "/admin/logged-in"],
};
const CLIENTS = [
  { device: "desktop", os: "Windows 11", browser: "Chrome 129" },
  { device: "desktop", os: "macOS 14", browser: "Safari 17" },
  { device: "desktop", os: "macOS 14", browser: "Chrome 129" },
  { device: "mobile", os: "iOS 18", browser: "Safari 18" },
  { device: "mobile", os: "Android 14", browser: "Chrome 129" },
];
const LOCATIONS = ["Dubai, AE", "London, GB", "Limassol, CY", "Amsterdam, NL", "Singapore, SG"];
const HOUR = 3600_000;

export async function generateTeamExtras(world: World, rng: Rng, sink: TableSink, profile: Profile): Promise<void> {
  const full = profile.name === "full";
  const days = full ? 90 : 14;
  const now = world.anchor;
  const today = Math.floor(now / DAY) * DAY;
  let sId = 100_000; // after the open sessions of admin extras
  let pvId = 0;
  for (const u of world.users) {
    const pages = [...COMMON, ...(PAGES_BY_DEPARTMENT[u.department] ?? [])];
    // A usual device and IP, and a work pattern: start hour and how often they come in.
    const usual = rng.pick(CLIENTS.slice(0, 3));
    const ip = `${rng.pick(["192.0.2", "198.51.100", "203.0.113"])}.${rng.int(1, 254)}`;
    const location = rng.pick(LOCATIONS);
    const presence = rng.int(65, 95) / 100;
    const startHour = rng.int(6, 10);
    for (let d = days; d >= 1; d--) {
      const dayStart = today - d * DAY;
      const weekday = new Date(dayStart).getUTCDay();
      const weekend = weekday === 0 || weekday === 6;
      if (!rng.chance(weekend ? (u.department === "NOC" ? 0.6 : 0.08) : presence)) continue;
      const sessions = rng.chance(0.3) ? 2 : 1;
      let t = dayStart + (startHour + rng.int(0, 90) / 60) * HOUR;
      for (let k = 0; k < sessions; k++) {
        const length = (sessions === 2 ? rng.int(2, 4) : rng.int(5, 9)) * HOUR + rng.int(0, 59) * 60_000;
        const odd = rng.chance(0.02); // sign-in from a new device or IP
        const c = odd ? rng.pick(CLIENTS) : usual;
        const end = Math.min(t + length, now - HOUR);
        if (end <= t) break;
        await sink.insert("user_sessions", {
          id: ++sId,
          user_kind: "staff",
          user_id: u.id,
          portal_user_id: null,
          ip: odd ? `203.0.113.${rng.int(1, 254)}` : ip,
          location: odd ? rng.pick(LOCATIONS) : location,
          device: c.device,
          os: c.os,
          browser: c.browser,
          logged_in_at: new Date(t),
          last_seen_at: new Date(end),
          ended_at: new Date(end),
          ended_by_id: null,
          end_reason: rng.chance(0.7) ? "logout" : "expired",
        });
        // Pages opened during the session, most of them the department's own.
        const views = rng.int(full ? 6 : 3, full ? 30 : 10);
        for (let v = 0; v < views; v++)
          await sink.insert("page_views", {
            id: ++pvId,
            user_id: u.id,
            path: rng.chance(0.75)
              ? rng.pick(pages.slice(COMMON.length).length ? pages.slice(COMMON.length) : pages)
              : rng.pick(COMMON),
            at: new Date(t + rng.int(0, Math.max(1, Math.floor((end - t) / 60_000))) * 60_000),
          });
        t = end + rng.int(30, 120) * 60_000;
      }
    }
  }
}
