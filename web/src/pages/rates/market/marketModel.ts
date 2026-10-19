// Market moves (§13.14) without React: labels, the vendor rate chart, and the links behind "Update
// rates" (Bulk rating pre-filled with the suggested rates) and "Reroute" (Route Rules on a vendor).
import type { EChartsCoreOption } from "echarts/core";
import type { MarketMoveDetail, MarketMoveRow, MarketMoveVendor } from "@sms/contract";
import type { ChartColors } from "../../../ui/Chart";
import { emptyState, encodeState } from "../../../grid/filterModel";

export const STATE_LABEL: Record<MarketMoveRow["state"], string> = {
  open: "Open",
  snoozed: "Snoozed",
  handled: "Handled",
  dismissed: "Dismissed",
  expired: "Expired",
};
export const STATE_TONE: Record<MarketMoveRow["state"], "good" | "warning" | "error" | "neutral"> = {
  open: "warning",
  snoozed: "neutral",
  handled: "good",
  dismissed: "neutral",
  expired: "neutral",
};

/** "↑ +8.4 %" */
export const moveLabel = (r: Pick<MarketMoveRow, "direction" | "avgChangePct">) =>
  `${r.direction === "up" ? "↑" : "↓"} ${r.avgChangePct > 0 ? "+" : ""}${r.avgChangePct.toFixed(1)} %`;

/** Step lines of the top vendors' rates; the vendors that moved are drawn solid, the others faint. */
export function vendorChart(
  vendors: MarketMoveVendor[],
  c: ChartColors,
  currency: string,
  now = Date.now(),
): EChartsCoreOption {
  const palette = [c.accent, c.error, c.warning, c.good, c.secondary];
  let k = 0;
  return {
    grid: { left: 52, right: 12, top: 10, bottom: 24 },
    tooltip: { trigger: "axis", valueFormatter: (v: number) => `${Number(v).toFixed(5)} ${currency}` },
    xAxis: { type: "time", axisLabel: { color: c.secondary }, axisLine: { lineStyle: { color: c.border } } },
    yAxis: {
      type: "value",
      scale: true,
      axisLabel: { color: c.secondary, formatter: (v: number) => v.toFixed(3) },
      splitLine: { lineStyle: { color: c.border } },
    },
    // The vendors that moved, and the three cheapest that did not (more would clutter the card).
    series: [...vendors.filter((v) => v.moved), ...vendors.filter((v) => !v.moved).slice(0, 3)].map((v) => {
      const pts = v.series.map((p) => [Date.parse(p.at), p.rate]);
      const last = pts.at(-1);
      if (last && (last[0] as number) < now) pts.push([now + 3 * 86_400_000, last[1] as number]);
      return {
        name: v.vendorTrunk,
        type: "line",
        step: "end",
        showSymbol: false,
        data: pts,
        lineStyle: v.moved ? { width: 2 } : { width: 1, type: "dashed", opacity: 0.5 },
        color: v.moved ? palette[k++ % palette.length] : c.secondary,
      };
    }),
  };
}

/** Bulk rating with the chosen clients' suggested rates (§13.14 "Update rates"). */
export const updateRatesUrl = (move: Pick<MarketMoveDetail, "id" | "mccmnc">, tableIds: number[]) =>
  `/rates/bulk?move=${move.id}&tables=${tableIds.join(",")}&mccmnc=${move.mccmnc}`;

/** Route Rules that use a vendor trunk, to move traffic (Bulk edit there replaces the vendor). */
export const routeRulesFor = (vendorTrunk: string) =>
  `/routing/rules?g=${encodeState({ ...emptyState(), columns: { vendors: { field: "vendors", op: "like", value: vendorTrunk } } })}`;
