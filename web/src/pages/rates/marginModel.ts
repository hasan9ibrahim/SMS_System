// Margin calculator without React (team trial round 3): the SMS version of the team's swap-deal sheet. Outbound =
// traffic we send to the carrier (it is our vendor); inbound = traffic the carrier sends us (it is our customer).
// Every figure is worked out to 6 decimals; the page chooses how many to show.
import type { MarginDealInput, MarginDealLine } from "@sms/contract";

export const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** One row's figures over the period and per day. */
export function lineFigures(l: MarginDealLine, periodDays: number) {
  const days = Math.max(1, periodDays);
  const marginPerSms = r6(l.rate - l.cost);
  return {
    marginPerSms,
    smsPerDay: r6(l.messages / days),
    costPerDay: r6((l.messages * l.cost) / days),
    revenuePerDay: r6((l.messages * l.rate) / days),
    marginPerDay: r6((l.messages * marginPerSms) / days),
    totalCost: r6(l.messages * l.cost),
    totalRevenue: r6(l.messages * l.rate),
    totalMargin: r6(l.messages * marginPerSms),
  };
}

export function legTotals(lines: MarginDealLine[], periodDays: number) {
  const days = Math.max(1, periodDays);
  let messages = 0;
  let cost = 0;
  let revenue = 0;
  for (const l of lines) {
    messages += l.messages;
    cost += l.messages * l.cost;
    revenue += l.messages * l.rate;
  }
  return {
    messages,
    cost: r6(cost),
    revenue: r6(revenue),
    margin: r6(revenue - cost),
    smsPerDay: r6(messages / days),
    costPerDay: r6(cost / days),
    revenuePerDay: r6(revenue / days),
    marginPerDay: r6((revenue - cost) / days),
  };
}

/** Total margin of both legs and the netting: above 0 we pay the carrier, below 0 the carrier pays us. */
export function dealSummary(d: Pick<MarginDealInput, "outbound" | "inbound" | "periodDays">) {
  const outbound = legTotals(d.outbound, d.periodDays);
  const inbound = legTotals(d.inbound, d.periodDays);
  return {
    outbound,
    inbound,
    totalMargin: r6(outbound.margin + inbound.margin),
    netting: r6(outbound.cost - inbound.revenue),
  };
}

export const blankLine = (): MarginDealLine => ({ destination: "", mccmnc: null, cost: 0, rate: 0, messages: 0 });

export const blankDeal = (): MarginDealInput => ({
  name: "",
  carrierEnterpriseId: null,
  carrierName: "",
  currency: "EUR",
  periodDays: 30,
  notes: null,
  outbound: [blankLine()],
  inbound: [blankLine()],
});

/** CSV of the deal, laid out like the sheet: both legs, then the totals. */
export function dealCsv(d: MarginDealInput): string {
  const s = dealSummary(d);
  const q = (v: unknown) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const rows: unknown[][] = [
    ["Deal", d.name],
    ["Carrier", d.carrierName],
    ["Currency", d.currency],
    ["Period (days)", d.periodDays],
    [],
    [`Us to ${d.carrierName}`],
    [
      "Destination",
      "MCCMNC",
      "Cost",
      "Selling rate",
      "SMS",
      "Margin/SMS",
      "Cost/day",
      "Margin/day",
      "SMS/day",
      "Total cost",
      "Total margin",
    ],
    ...d.outbound.map((l) => {
      const f = lineFigures(l, d.periodDays);
      return [
        l.destination,
        l.mccmnc ?? "",
        l.cost,
        l.rate,
        l.messages,
        f.marginPerSms,
        f.costPerDay,
        f.marginPerDay,
        f.smsPerDay,
        f.totalCost,
        f.totalMargin,
      ];
    }),
    [
      "Total",
      "",
      "",
      "",
      s.outbound.messages,
      "",
      s.outbound.costPerDay,
      s.outbound.marginPerDay,
      s.outbound.smsPerDay,
      s.outbound.cost,
      s.outbound.margin,
    ],
    [],
    [`${d.carrierName} to us`],
    [
      "Destination",
      "MCCMNC",
      "Cost",
      "Selling rate",
      "SMS",
      "Margin/SMS",
      "Revenue/day",
      "Margin/day",
      "SMS/day",
      "Total revenue",
      "Total margin",
    ],
    ...d.inbound.map((l) => {
      const f = lineFigures(l, d.periodDays);
      return [
        l.destination,
        l.mccmnc ?? "",
        l.cost,
        l.rate,
        l.messages,
        f.marginPerSms,
        f.revenuePerDay,
        f.marginPerDay,
        f.smsPerDay,
        f.totalRevenue,
        f.totalMargin,
      ];
    }),
    [
      "Total",
      "",
      "",
      "",
      s.inbound.messages,
      "",
      s.inbound.revenuePerDay,
      s.inbound.marginPerDay,
      s.inbound.smsPerDay,
      s.inbound.revenue,
      s.inbound.margin,
    ],
    [],
    ["Total margin", s.totalMargin],
    ["Netting", s.netting],
    [
      s.netting > 0 ? `We pay ${d.carrierName}` : s.netting < 0 ? `${d.carrierName} pays us` : "Even",
      Math.abs(s.netting),
    ],
  ];
  return rows.map((r) => r.map(q).join(",")).join("\n") + "\n";
}
