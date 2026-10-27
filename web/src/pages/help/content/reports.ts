// Help center: Reports (§10, §13.15, §13.18, §13.31).
import type { HelpTopic } from "../helpTypes";

export const topics: HelpTopic[] = [
  // ------------------------------------------------------------------ Master report
  {
    id: "master-report",
    pageKey: "master-report",
    title: "Master report",
    group: "Reports",
    summary:
      "One report for every traffic question: group the messages by up to five fields, pick any metrics, filter by anything, compare with an earlier period, chart it, drill down and export.",
    keywords: [
      "report",
      "traffic report",
      "customize report",
      "master grouping",
      "usage enterprise",
      "negative margin",
      "bilateral",
      "group by",
      "column selection",
      "drill down",
      "saved view",
      "compare",
    ],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "The Master report answers almost any question about traffic: how much a customer sent yesterday, which vendor trunks lost money last week, which error codes grew today. You choose how to group the messages (for example by customer, then by destination), which figures to show (attempts, ASR, revenue, margin and so on) and the period. Everyone can use it, within what their role and [[am-visibility|visibility policy]] let them see.",
          },
          {
            kind: "text",
            text: "The older separate reports (Customize, Enterprise, Master Grouping, Usage Enterprise, Negative Margin and Bilateral) are now ready-made starting points of this report, under **Start from…**. The [[sales-report|Sales]] and [[noc-report|NOC]] reports use the same screen with their own defaults and an extra panel.",
          },
          {
            kind: "text",
            text: "**Older periods.** Message details are kept 12 months; the figures are kept for ever, in totals per 15 minutes. A period that starts more than 12 months ago gives the same figures as before, in any time zone, by day, hour or quarter hour. What needs single messages cannot be shown for it: grouping by second, minute or IP address, and TPS peak and TPS now; the report says so. Sender IDs older than 12 months are kept per day (UTC) with the partners, trunks and destinations.",
          },
          {
            kind: "text",
            text: "Every figure is explained in [[report-metrics|Report metrics explained]].",
          },
        ],
      },
      {
        id: "layout",
        title: "What you see on the page",
        blocks: [
          {
            kind: "list",
            title: "Header buttons",
            items: [
              "**Export**: download every row of the report (see [[master-report#export|Export]]).",
              "**Start from…**: load a ready-made report (its grouping, metrics, period and filters).",
              "**Report views…**: open a report view you saved, or one a colleague shared (shared views show the owner's name and cannot be changed).",
              "**Save view**: save the current report, settings included, under a name. Scheduled reports can e-mail a saved view.",
              "**Chart** / **Hide chart**: show or hide a chart of the current page of results.",
            ],
          },
          {
            kind: "list",
            title: "Above the grid",
            items: [
              "The settings bar: **From**, **to**, the quick period buttons, **Each day** hours, **Timezone**, **Type** and **Compare**.",
              "**Group by**: the grouping levels as numbered chips, then **+ Add level**.",
              "**Column Selection (n)**: which metrics are shown; n is how many are chosen.",
              "The totals line: the exact window used (in UTC), the window it is compared with, the number of rows, how long the report took, and the total of every metric for all rows that pass the filters (not just the rows on screen).",
              "The chart, when switched on.",
            ],
          },
          {
            kind: "list",
            title: "The grid",
            items: [
              "One column per group-by field (in level order), then one column per metric.",
              "A filter box under every column header. Filters on group-by columns choose which messages are counted; filters on metric columns hide groups after they are added up (for example **Margin** `< 0`). See [[grids-and-filters]] and [[filter-builder]].",
              "Click a column header to sort. Sorting and paging run on the server, so the report stays fast on millions of messages.",
              "When **Compare** is on, each metric shows a small arrow with the change in %: green when the change is good, red when it is bad, `=` when unchanged. For cost-like metrics (Cost, Cost (B), Cost (Avg), Failed Submits, Delivery Delay, Re-routes, HLR Cost) going up is red.",
              "A negative **Margin** is shown in red.",
            ],
          },
          {
            kind: "list",
            title: "Detail panel (click a row)",
            items: [
              "**Figures**: every chosen metric for the row, with the previous value in brackets when comparing. The **EDRs behind this row** button opens EDR search filtered to the messages counted in this row.",
              "**Drill down**: keep only this row and break it down by one more field (one button per field not yet used).",
            ],
          },
          {
            kind: "text",
            text: "Column filters on group-by fields apply before grouping; filters on metrics apply after, e.g. Margin `< 0`.",
          },
        ],
      },
      {
        id: "settings",
        title: "Report settings",
        blocks: [
          {
            kind: "fields",
            title: "Settings bar",
            fields: [
              {
                name: "From / to",
                what: "Start and end of the period, always in UTC. Typing a date here switches the period to a custom one.",
                values:
                  "Date and time, for example `2026-10-01 00:00` to `2026-10-08 00:00`. The end is not included. At most 400 days.",
              },
              {
                name: "Quick periods",
                what: "Buttons for the usual periods. The highlighted button is the one in use. The server works the period out in the chosen **Timezone**.",
                values:
                  "**Today**, **Yesterday** (default), **Last 24 hours**, **Last 7 days** (today and the six days before), **This week** (from Monday), **Last week**, **This month**, **Last month**.",
              },
              {
                name: "Each day",
                what: "Count only these hours, on every day of the period. Handy for comparing busy hours across days.",
                values:
                  "From hour `00:00`–`23:00` to hour `00:59`–`23:59`, in the report time zone. Default: the whole day. A range such as `22:00 – 05:59` wraps past midnight.",
              },
              {
                name: "Timezone",
                what: "The time zone that decides where days, hours, weeks and months start, for the quick periods and for the Date, Hour, Week and Month groupings.",
                values:
                  "UTC (default) or one of 31 zones from GMT−12:00 to GMT+12:00, including the half-hour zones (St John's, Tehran, Kabul, India, Kathmandu, Darwin).",
              },
              {
                name: "Type",
                what: "Which messages to count.",
                values:
                  "**MT and MO** (default), **MT** (mobile-terminated: messages we send to phones) or **MO** (mobile-originated: messages from phones).",
              },
              {
                name: "Compare",
                what: "Show each figure next to the same figure for an earlier window, with the change in %.",
                values:
                  "**No comparison** (default); **Previous period** (a window of the same length just before); **Same time last week** (the same window moved back seven days).",
              },
            ],
          },
          {
            kind: "fields",
            title: "Group by and columns",
            fields: [
              {
                name: "Group by",
                what: "How messages are grouped into rows. Level 1 is the outer grouping. Each chip has ‹ and › to move it, and × to remove it (the last level cannot be removed).",
                values:
                  "Up to five levels, any order. The fields are listed in [[report-metrics#dimensions|Group-by fields]].",
              },
              {
                name: "+ Add level",
                what: "Adds another grouping level at the end. Hidden once there are five levels.",
              },
              {
                name: "Column Selection",
                what: "Opens a list of every metric with a tick box. Tick what you want and press **Apply**; **Cancel** keeps the old choice. At least one metric is needed.",
                values: "Any of the metrics in [[report-metrics]].",
              },
            ],
          },
        ],
      },
      {
        id: "how-to-run",
        title: "How to build a report",
        blocks: [
          {
            kind: "steps",
            items: [
              "Pick a period with a quick button, or type **From** and **to** (UTC).",
              "Check **Timezone** if days should start somewhere other than UTC midnight.",
              "Under **Group by**, add the levels you need with **+ Add level**, and order them with ‹ ›. For example **Customer**, then **Destination (MCCMNC)**.",
              "Press **Column Selection**, tick the metrics and press **Apply**.",
              "Type filters under the column headers, for example `Acme%` under **Customer** or `< 80` under **DLR(t) %**.",
              "The grid and totals update by themselves; there is no Run button on this page.",
            ],
          },
          {
            kind: "tip",
            text: "Country and destination filters accept names as well as codes: `Nigeria`, `%MTN%` and `62130` all work.",
          },
        ],
      },
      {
        id: "how-to-drill",
        title: "How to drill down and see the messages",
        blocks: [
          {
            kind: "steps",
            title: "Drill down",
            items: [
              "Click the row you want to look into.",
              "In the detail panel open **Drill down**.",
              "Press the field to break it down by, for example **Vendor Trunk**.",
              "The report now keeps only that row (filters are added under its group-by columns) and adds the field as a new level. Remove the filters or the level to go back.",
            ],
          },
          {
            kind: "steps",
            title: "See the EDRs behind a row",
            items: [
              "Click the row.",
              "In **Figures**, press **EDRs behind this row**.",
              "EDR search opens with the row's customer, trunk, destination and so on as filters, and the report window as the time range. For a Date row the range is that day.",
            ],
          },
          {
            kind: "warning",
            text: "For an Hour row, the EDR search is narrowed to that exact hour only when the report time zone is UTC. In other zones the whole report window is used.",
          },
        ],
      },
      {
        id: "how-to-compare",
        title: "How to compare with an earlier period",
        blocks: [
          {
            kind: "steps",
            items: [
              "Set **Compare** to **Previous period** or **Same time last week**.",
              'The totals line shows both windows ("vs …").',
              "Each metric cell gets an arrow with the change in %. Hover over it to see the previous value.",
              'Open a row to see "was …" next to every figure.',
            ],
          },
          {
            kind: "tip",
            text: "With **Chart** on and comparing, the chart draws the previous window as a dashed second series.",
          },
        ],
      },
      {
        id: "views",
        title: "How to save and reuse a report",
        blocks: [
          {
            kind: "steps",
            title: "Save a report view",
            items: [
              "Set up the report: settings, grouping, metrics, filters and sort.",
              "Press **Save view** and type a name.",
              "The view now appears under **Report views…** and can be picked in [[scheduled|Scheduled reports]] to e-mail it on a timetable.",
            ],
          },
          {
            kind: "steps",
            title: "Start from a ready-made report",
            items: [
              "Open **Start from…**.",
              "Pick one: **Sales report**, **Billing report**, **NOC report**, **Customize** (date, customer, vendor), **Enterprise** (customer and trunk), **Master Grouping** (date, customer and trunk, vendor and trunk), **Usage Enterprise** (billable usage per customer and destination, last month), **Negative Margin** (traffic sold below cost, margin < 0) or **Bilateral** (customer and vendor, to look at one bilateral partner both ways).",
              "Change anything you like; the ready-made report itself is not changed.",
            ],
          },
          {
            kind: "tip",
            text: "The report settings are kept in the tab's address, so copying the link or reopening the tab brings the same report back.",
          },
        ],
      },
      {
        id: "export",
        title: "How to export",
        blocks: [
          {
            kind: "steps",
            items: [
              "Set up the report and sort it the way you want the file sorted.",
              "Press **Export**.",
              "Choose **Excel**, **CSV** or **PDF**. The file has every row (up to 100,000) and the totals, in the current sort.",
            ],
          },
          {
            kind: "tip",
            text: "A PDF lists at most the first 2,000 rows; use Excel or CSV for large reports.",
          },
        ],
      },
      {
        id: "chart",
        title: "The chart",
        blocks: [
          {
            kind: "text",
            text: "The chart shows the first metric you chose (TPS (peak) is skipped). When level 1 is Date, Hour, Week or Month it is a line over time (up to the last 200 points). Otherwise it is a bar chart of the top 15 rows on the current page.",
          },
        ],
      },
      {
        id: "how-it-works",
        title: "How it works",
        blocks: [
          {
            kind: "list",
            items: [
              "The report reads the EDRs (one record per message attempt) for the window and the **Each day** hours, keeps the ones that match **Type** and the filters on group-by fields, groups them and adds them up.",
              "Ratios such as ASR, DLR and margin % are worked out from the group's sums, not averaged from smaller rows, so totals are always correct.",
              "Filters on metric columns then remove groups (for example only rows with margin below 0). Totals and the row count use the same filtered groups.",
              "Money (Revenue, Cost, Margin, average rates, HLR Cost) is in the platform currency so different companies can be added up. Revenue (B) and Cost (B) are in the business company's own base currency.",
              "Customer and vendor names follow your visibility policy: masked names stay masked here and in exports.",
            ],
          },
        ],
      },
      {
        id: "tips",
        title: "Tips and things to watch",
        blocks: [
          {
            kind: "warning",
            text: 'A metric filter cannot be OR-ed with a group-by filter in the filter builder (for example "Customer is X OR Margin < 0"). The report shows an error; use AND, or two separate reports.',
          },
          {
            kind: "tip",
            text: "Removing a grouping level or a metric also removes the sort and the column filter on that column.",
          },
          {
            kind: "tip",
            text: 'If the grid says "Pick at least one grouping and one metric", add a **Group by** level or tick a metric in **Column Selection**.',
          },
          {
            kind: "tip",
            text: 'In the trial, "now" is the time of the newest fake message, so **Today** and **TPS (now)** are counted up to that moment, not up to the real clock.',
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ Enterprise report
  {
    id: "enterprise-report",
    pageKey: "enterprise-report",
    title: "Enterprise report",
    group: "Reports",
    summary:
      "The billing team's traffic report per customer or vendor enterprise, with day and month totals cut at midnight in the partner's own billing time zone, so the numbers match the partner's invoice.",
    keywords: [
      "enterprise report",
      "billing report",
      "invoice check",
      "reconciliation",
      "billing time zone",
      "partner time zone",
      "usage",
      "customer traffic",
      "vendor traffic",
    ],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "Use the Enterprise report to see what each customer or vendor sent or received over a period: attempts, billable messages, revenue or cost, margin and more. The billing team uses it to check invoices, and invoice reconciliation runs the same report to compare a partner's invoice with our own figures.",
          },
          {
            kind: "text",
            text: "Its key difference from the [[master-report]]: days and months can be cut at midnight in each partner's billing time zone, and amounts are shown in the partner's own currency as well as the platform currency.",
          },
        ],
      },
      {
        id: "layout",
        title: "What you see on the page",
        blocks: [
          {
            kind: "list",
            items: [
              "**Settings** at the top: **Customers** / **Vendors**, **From** / **to**, quick periods, **Time zone**, **Report by**, the **Rows by** chips, **Filters** and the **Run report** button.",
              'The **Total** line: the total of every visible metric for all rows, and on the right "Cut in …" with the time zone used (or "Cut in n time zones" when partners are in different zones; hover to see how many enterprises are in each).',
              "The grid: one row per period and grouping, with a filter under every column, server-side sort and paging. Use **Columns** to add or remove metrics.",
              "**Export** in the header downloads the rows that match the current filters as CSV.",
              "A negative **Margin** is shown in red.",
            ],
          },
          {
            kind: "fields",
            title: "Grid columns",
            fields: [
              {
                name: "Period",
                what: "The hour, day, week (starting Monday) or month of the row, in the time zone used. Not shown when **Report by** is **Whole period**.",
              },
              { name: "Enterprise", what: "The customer or vendor enterprise (with **Rows by** Enterprise)." },
              { name: "Trunk", what: "The customer or vendor trunk (with **Rows by** Trunk)." },
              { name: "Country", what: "Destination country (with **Rows by** Country or Destination)." },
              { name: "MCCMNC / Network", what: "Destination network code and name (with **Rows by** Destination)." },
              {
                name: "Account Manager",
                what: "The account manager of the partner at the time each message was sent (with **Rows by** Account manager).",
              },
              {
                name: "Currency",
                what: "The partner's billing currency. Always shown, because rows in different currencies cannot be added up in partner money.",
              },
              {
                name: "Metrics",
                what: "The chosen figures. Customers default to Attempts, Successful, Billable (Customer), ASR %, DLR (Customer), Revenue, Avg Rate (Customer), Revenue (platform), Cost (platform), Margin, Margin %. Vendors default to the vendor-side equivalents. See [[report-metrics]].",
              },
            ],
          },
        ],
      },
      {
        id: "fields",
        title: "Report settings",
        blocks: [
          {
            kind: "fields",
            title: "Settings",
            fields: [
              {
                name: "Customers / Vendors",
                what: "Which side to report. Switching side clears the enterprise and trunk filters.",
                values: "Default **Customers**.",
              },
              {
                name: "From / to",
                what: "Start and end of the period, read as local time in the time zone used (see **Time zone**).",
                values:
                  "Date and time; the end is not included. Default: this month. At most 400 days; the end must be after the start.",
              },
              {
                name: "Quick periods",
                what: "Fill **From** and **to** in one click.",
                values: "**Today**, **Yesterday**, **Last 7 days**, **This month**, **Last month**.",
              },
              {
                name: "Time zone",
                what: "Where days and months are cut.",
                values:
                  "**Partner's billing time zone** (default: the trunk's billing time zone, or the enterprise's when the trunk has none, or UTC), **UTC**, or **Platform** (the platform time zone, shown in brackets).",
              },
              {
                name: "Report by",
                what: "How rows are split in time.",
                values: "**Whole period**, **Hour**, **Day** (default), **Week**, **Month**.",
              },
              {
                name: "Rows by",
                what: "Chips that choose the row grouping. Click a chip to turn it on or off; several can be on.",
                values:
                  "**Enterprise**, **Trunk** (both on by default), **Country**, **Destination**, **Account manager**.",
              },
            ],
          },
          {
            kind: "fields",
            title: "Filters (button)",
            fields: [
              {
                name: "Customers / Vendors",
                what: "Only these enterprises. The list offers customers (or vendors) and bilateral partners.",
                values: "Search by name; pick several.",
              },
              { name: "Trunks", what: "Only these trunks of the chosen side.", values: "Pick several." },
              {
                name: "Destinations",
                what: "Only these exact destination codes.",
                values: "A 3-digit code means that country's **All networks** entry, not the whole country.",
              },
              {
                name: "Account managers (at send time)",
                what: "Only traffic sent while one of these people was the partner's account manager.",
              },
              { name: "Type", what: "Message type.", values: "**MT and MO** (default), **MT** or **MO**." },
            ],
          },
          {
            kind: "text",
            text: "The **Filters** button shows how many filters are set, for example **Filters (2)**.",
          },
        ],
      },
      {
        id: "how-to-run",
        title: "How to run the report",
        blocks: [
          {
            kind: "steps",
            items: [
              "Choose **Customers** or **Vendors**.",
              "Pick a quick period or type **From** and **to**.",
              "Leave **Time zone** on **Partner's billing time zone** to match partner invoices, or choose UTC or the platform zone.",
              "Choose **Report by** and switch on the **Rows by** chips you need.",
              "Optionally open **Filters** to narrow to some enterprises, trunks, destinations or account managers.",
              "Press **Run report**. Changes to the settings take effect only when you press it.",
              "Narrow further with the filters under the columns, or add metrics with **Columns**.",
            ],
          },
          {
            kind: "steps",
            title: "Check a partner's invoice by hand",
            items: [
              "Choose the partner's side and the invoice period, for example **Last month**.",
              "Keep **Partner's billing time zone**.",
              "Set **Report by** to **Whole period** or **Month**, **Rows by** Enterprise (add Destination for a per-destination check).",
              "Open **Filters** and pick the partner.",
              "Press **Run report** and compare **Billable** and **Revenue** (or **Cost**) with the invoice.",
            ],
          },
        ],
      },
      {
        id: "how-it-works",
        title: "How it works",
        blocks: [
          {
            kind: "list",
            items: [
              "Trunks are grouped by the time zone their traffic is cut in, and each group is counted in its own zone. With a period column, rows of different time zones stay separate; with **Whole period** they are combined.",
              "**Revenue**, **Cost**, **Avg Rate** and **HLR Cost** are in the partner's currency (the other side's money is converted into it). Columns marked with the platform currency, such as **Revenue (EUR)** and **Margin (EUR)**, are in the platform currency so they add up across partners.",
              "When rows are in several currencies, the totals of partner-currency columns are left blank (hover the total to see why); read each row instead.",
              "Archived trunks still count, because their traffic still has to be billed.",
              "Account manager attribution uses the manager at send time, so moving a client to another manager does not move its past traffic.",
              "On Run report the chosen metrics are kept; columns follow the new grouping, and column filters on grouping columns that are gone are dropped.",
            ],
          },
          {
            kind: "text",
            text: "The settings are stored in the tab's address, so the same report reopens with the tab or a copied link.",
          },
        ],
      },
      {
        id: "tips",
        title: "Tips and things to watch",
        blocks: [
          {
            kind: "tip",
            text: "Billable counts depend on each trunk's billing type (per attempt, per submit, per receipt or per delivered message). See [[report-metrics#counts|Message counts]].",
          },
          {
            kind: "warning",
            text: "If the totals line says the EDR store is not answering, the report is empty because the message store is down, not because there was no traffic.",
          },
          {
            kind: "tip",
            text: 'Pressing **Export** before running the report shows "Run the report first."',
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ Sales report
  {
    id: "sales-report",
    pageKey: "sales-report",
    title: "Sales report",
    group: "Reports",
    summary:
      "How clients and destinations are growing: volume, revenue and margin per customer and destination against the previous period, plus the top growing, declining, new and stopped clients.",
    keywords: [
      "sales",
      "growth",
      "decline",
      "new clients",
      "stopped clients",
      "account manager",
      "movers",
      "revenue trend",
    ],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "Account managers and sales heads use this report to see where they are winning or losing: which clients grow, which fall, who sent their first traffic and who stopped. It is the [[master-report]] with sales defaults and an extra panel, so everything that works there (grouping, metrics, filters, drill-down, chart, export, saved views) works here too.",
          },
        ],
      },
      {
        id: "layout",
        title: "What you see on the page",
        blocks: [
          {
            kind: "list",
            items: [
              "The Master report settings and grid, set by default to: grouped by **Customer** and **Destination (MCCMNC)**; metrics Attempts, Delivered, Revenue, Margin, Margin % and Avg Rate (Customer); **Last 7 days**; compared with the **Previous period**; sorted by Revenue, highest first.",
              "The panel **Sales report: what stands out** (click its title to fold it), with its own filters and four cards.",
            ],
          },
          {
            kind: "fields",
            title: "Cards in the panel",
            fields: [
              {
                name: "Top growing",
                what: "Clients whose revenue rose by at least the threshold, biggest gain in money first. The change is shown in green.",
              },
              {
                name: "Top declining",
                what: "Clients whose revenue fell by at least the threshold, biggest loss first. The change is shown in red.",
              },
              {
                name: "New clients",
                what: 'Clients with traffic in this period and none in the previous one, highest revenue first. Marked "new".',
              },
              {
                name: "Stopped sending",
                what: 'Clients with traffic in the previous period and none in this one, by their previous revenue. Marked "stopped".',
              },
            ],
          },
          {
            kind: "text",
            text: "Each card shows the number of clients in brackets and lists the first six, with revenue in the platform currency and the change in %. Hover a client name to see the account manager.",
          },
        ],
      },
      {
        id: "fields",
        title: "Panel filters",
        blocks: [
          {
            kind: "fields",
            fields: [
              {
                name: "Account manager",
                what: "Only clients of this account manager (at the time the messages were sent).",
                values: "Default **All account managers**.",
              },
              {
                name: "Country",
                what: "Only traffic to these destination countries.",
                values:
                  "Pick several; the list has select-all for the countries you filtered. Default **All countries**.",
              },
              {
                name: "Growth / decline threshold %",
                what: "How much revenue must change for a client to count as growing or declining.",
                values: "0 to 1000; default `20`.",
              },
            ],
          },
          {
            kind: "text",
            text: "The panel uses the period and **Timezone** from the settings bar. It does not use the grid's column filters.",
          },
        ],
      },
      {
        id: "how-to",
        title: "How to use it",
        blocks: [
          {
            kind: "steps",
            title: "See how my clients did this month",
            items: [
              "Press the **This month** quick period.",
              "In the panel, choose yourself under **Account manager**.",
              "Read the four cards; open the full grid below to see each client per destination with the change against last period.",
              "To keep the setup, press **Save view**.",
            ],
          },
          {
            kind: "steps",
            title: "Look into a declining client",
            items: [
              "Type the client name under the **Customer** column.",
              "Click a destination row and use **Drill down** › **Vendor Trunk** or **Date** to see where the drop happened.",
            ],
          },
        ],
      },
      {
        id: "how-it-works",
        title: "How it works",
        blocks: [
          {
            kind: "list",
            items: [
              "The previous period always has the same length and ends where the current one starts.",
              "Change % = (revenue now − revenue before) ÷ revenue before × 100, in the platform currency.",
              "A client is growing or declining only when it had traffic in both periods.",
              "Each list holds up to 25 clients; the card shows the first six.",
            ],
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ Billing report
  {
    id: "billing-report",
    pageKey: "billing-report",
    title: "Billing report",
    group: "Reports",
    summary:
      "Is everything billed and paid? Per enterprise for a period: billable volume and amount on each side, invoices, payments, today's balance and credit use, disputes and negative-margin traffic.",
    keywords: [
      "billing",
      "finance",
      "invoiced",
      "payments",
      "balance",
      "credit limit",
      "disputes",
      "negative margin",
      "re-rating",
    ],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "The finance team uses this report to check, for each enterprise, that traffic was invoiced, payments came in or went out, balances are within credit, vendor invoices match, and no traffic was sold below cost. It lists one row per enterprise that has a customer or vendor billing account.",
          },
        ],
      },
      {
        id: "layout",
        title: "What you see on the page",
        blocks: [
          {
            kind: "fields",
            title: "Settings",
            fields: [
              {
                name: "Period",
                what: "The period for traffic, invoices and payments, worked out in UTC.",
                values:
                  "**Today**, **Yesterday**, **Last 24 hours**, **Last 7 days**, **This week**, **Last week**, **This month**, **Last month** (default) or **Custom**.",
              },
              { name: "From *", what: "Custom period only: first day.", values: "A date; required." },
              {
                name: "To (exclusive) *",
                what: "Custom period only: the day after the last day.",
                values: "A date; required. For all of October enter From `2026-10-01`, To `2026-11-01`.",
              },
            ],
          },
          {
            kind: "fields",
            title: "Grid columns",
            fields: [
              { name: "Enterprise", what: "The enterprise name." },
              { name: "Type", what: "Customer, Vendor or Bilateral." },
              { name: "Account Manager", what: "The enterprise's account manager." },
              { name: "Billing Cycle", what: "The billing cycle of the enterprise." },
              {
                name: "Currency",
                what: "The enterprise's billing currency. All amounts on the row except Negative Margin are in it.",
              },
              { name: "Billable (C)", what: "Billable messages the enterprise sent as a customer in the period." },
              { name: "Amount (C)", what: "What those billable messages are worth at its sell rates." },
              { name: "Billable (V)", what: "Billable messages we sent to it as a vendor." },
              { name: "Amount (V)", what: "What those messages cost at its buy rates." },
              { name: "Invoices", what: "Invoices with an invoice date in the period (failed ones not counted)." },
              { name: "Invoiced", what: "Total usage charges on those invoices." },
              { name: "Payments In", what: "Payments received from the enterprise as a customer, by payment date." },
              { name: "Payments Out", what: "Payments we made to it as a vendor, by payment date." },
              { name: "Balance", what: "The balance as of today (not the end of the period). Red when negative." },
              {
                name: "Credit Used %",
                what: "How much of the credit limit the balance uses. Amber from 70 %, red from 90 %. A dash when there is no credit limit.",
              },
              { name: "Disputed", what: "Vendor invoices for the period that are in dispute. Amber when above 0." },
              {
                name: "Vendor Invoice Diff.",
                what: "The vendor's invoiced amount minus our own figure, for vendor invoices covering the period. Amber when not 0.",
              },
              {
                name: "Negative-Margin Msgs",
                what: "Billable customer messages sold for less than they cost. Red when above 0.",
              },
              {
                name: "Negative Margin",
                what: "The money lost on those messages, in the platform currency. Red when above 0.",
              },
              {
                name: "Credit Limit, Re-rated",
                what: "Hidden by default; add them with **Columns**. Re-rated is the net change from re-rating runs that touch the period.",
              },
            ],
          },
          {
            kind: "list",
            title: "Detail panel (click a row)",
            items: [
              "**Billing**: customer side, vendor side, invoiced, payments, balance today with credit limit and use, disputes, negative margin and re-rated amount.",
              "**SOA** opens the statement of account for the enterprise; **Enterprise** opens its Billing tab.",
            ],
          },
        ],
      },
      {
        id: "how-to",
        title: "How to use it",
        blocks: [
          {
            kind: "steps",
            title: "Find customers over their credit",
            items: [
              "Choose the period (balance and credit use are always today's).",
              "Type `>= 90` under **Credit Used %**, or `< 0` under **Balance**.",
              "Click a row and press **SOA** to see the statement.",
            ],
          },
          {
            kind: "steps",
            title: "Find traffic sold below cost",
            items: [
              "Choose the period.",
              "Sort by **Negative Margin**, highest first.",
              "For the details, open the [[master-report]] with **Start from…** › **Negative Margin**.",
            ],
          },
        ],
      },
      {
        id: "tips",
        title: "Tips and things to watch",
        blocks: [
          {
            kind: "tip",
            text: "Filtering, sorting and paging run on the server. Use the filter under any column, for example `> 0` under **Disputed**.",
          },
          {
            kind: "warning",
            text: "Balance and Credit Used % are as of today even when you report an old period.",
          },
          {
            kind: "tip",
            text: "**Export** is not available on this page yet.",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ NOC report
  {
    id: "noc-report",
    pageKey: "noc-report",
    title: "NOC report",
    group: "Reports",
    summary:
      "Is traffic flowing well, and where are the problems? Per vendor trunk today: TPS, ASR, DLR, delay, failed submits and re-routes against the same time last week, plus binds down, top error codes and the worst vendor trunks.",
    keywords: [
      "noc",
      "quality",
      "asr",
      "dlr",
      "delay",
      "binds down",
      "error codes",
      "worst vendors",
      "tps",
      "failed submits",
    ],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "The NOC (network operations centre) team uses this report to spot quality problems quickly. It is the [[master-report]] with NOC defaults and a problems panel on top, so you can regroup, add metrics, drill down and open the EDRs behind any row.",
          },
        ],
      },
      {
        id: "layout",
        title: "What you see on the page",
        blocks: [
          {
            kind: "list",
            items: [
              "The Master report settings and grid, set by default to: grouped by **Vendor Trunk**; metrics Attempts, TPS (avg), TPS (peak), ASR %, DLR(t) %, Delivery Delay (s), Failed Submits and Re-routes; **Today**; compared with **Same time last week**; sorted by Attempts.",
              "The panel **NOC report: what stands out** with three cards. It refreshes every minute.",
            ],
          },
          {
            kind: "fields",
            title: "Cards in the panel",
            fields: [
              {
                name: "Binds down",
                what: "Active trunks whose connection (bind) is not online right now, with the side and how long it has been down. Red dot: down; amber dot: stopped. **Network status** opens the full picture.",
                values: "Shows up to eight. This list is the current state, not the chosen period.",
              },
              {
                name: "Top error codes",
                what: "The eight most frequent error codes in the period, with the count and their share of all attempts.",
              },
              {
                name: "Worst vendor trunks",
                what: "Vendor trunks with at least 100 attempts that have a problem, worst first: **Low ASR** (below 75 %), **Low DLR** (below 70 %) or **Slow delivery** (average delay above 20 s). Low ASR and DLR cells are red, slow delay amber.",
                values: "Shows up to eight.",
              },
            ],
          },
        ],
      },
      {
        id: "how-to",
        title: "How to use it",
        blocks: [
          {
            kind: "steps",
            title: "Find why a vendor trunk is failing",
            items: [
              "Find the trunk in **Worst vendor trunks** or sort the grid by **ASR %**, lowest first.",
              "Click its row in the grid and use **Drill down** › **Error Code** or **Destination (MCCMNC)**.",
              "Press **EDRs behind this row** to see the individual messages.",
            ],
          },
          {
            kind: "steps",
            title: "Check the last hour only",
            items: [
              "Type the window in **From** and **to** (UTC), or set **Each day** to the hours you want.",
              "Optionally add **Hour** as the first **Group by** level and press **Chart** to see the trend.",
            ],
          },
        ],
      },
      {
        id: "tips",
        title: "Tips and things to watch",
        blocks: [
          {
            kind: "tip",
            text: "For Failed Submits, Delivery Delay and Re-routes, a red arrow means the value went up compared with last week.",
          },
          {
            kind: "tip",
            text: 'In the trial there is no live SMPP traffic: the figures come from generated messages, and "now" is the time of the newest one.',
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ Team report
  {
    id: "team-report",
    pageKey: "team-report",
    title: "Team report",
    group: "Reports",
    summary:
      "Each team member's business results and their work in the system for a period: revenue and margin of their clients against targets, rate and routing changes, billing and NOC work, and sign-in activity.",
    keywords: [
      "team",
      "performance",
      "targets",
      "account manager results",
      "activity",
      "kpi",
      "ranking",
      "timeline",
      "sign-ins",
      "devices",
    ],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "Admins and department managers use the Team report to follow their people: how account managers' clients are doing against their targets, how much rate, routing, billing and NOC work each person did, and when and from where they signed in.",
          },
          {
            kind: "list",
            title: "Who you can see",
            items: [
              "Administrators: everyone.",
              "Department managers: their department (and themselves).",
              "Team leads: their team.",
              "Everyone else: only themselves.",
            ],
          },
          {
            kind: "text",
            text: "The scope in use is shown on the **Members** card.",
          },
        ],
      },
      {
        id: "layout",
        title: "What you see on the page",
        blocks: [
          {
            kind: "list",
            title: "Header buttons",
            items: [
              "**Scheduled e-mail**: opens [[scheduled|Scheduled reports]] in a new tab, where a weekly summary can be set up as a Team report schedule.",
              "**Export**: downloads the report as CSV.",
              "**Targets**: set monthly revenue and margin targets per account manager. Not available to team leads or people who only see themselves.",
            ],
          },
          {
            kind: "list",
            title: "Summary cards",
            items: [
              "**Members**: how many are listed, how many were active, and the scope.",
              "**Messages**: messages sent by their clients.",
              "**Revenue**: revenue of their clients, with margin and margin %. Shows Hidden when your visibility policy hides it.",
              "**Saves**: changes saved in the system, with hours online.",
              "**Alerts acknowledged**, with the dates of the period.",
            ],
          },
          {
            kind: "list",
            title: "The member list and side panel",
            items: [
              "Section buttons switch the columns: **Business results**, **Rates & routing**, **Billing**, **NOC**, **System activity**.",
              "A green dot before a name means the person is online now. Click a name to open their details.",
              "With nobody opened, the side panel shows **Activity by hour (UTC)** (saves by everyone listed) and **Ranking**: the top 15 members for the metric you pick.",
            ],
          },
        ],
      },
      {
        id: "filters",
        title: "Filters",
        blocks: [
          {
            kind: "fields",
            fields: [
              {
                name: "Period",
                what: "The period reported, in UTC.",
                values:
                  "**Today**, **This week**, **Last 7 days** (default), **Last week**, **This month**, **Last month**, **Custom**.",
              },
              {
                name: "From (UTC) / To (UTC, not included)",
                what: "Custom period only. Both are needed before the list loads.",
              },
              { name: "Department", what: "Only members of this department.", values: "Default **All departments**." },
              {
                name: "Role",
                what: "Only members with this role.",
                values:
                  "**All roles**, **Account Manager** (account manager), **Director / Head**, **Dept manager**, **Admin**.",
              },
              { name: "Member", what: "Find people by name or username." },
              {
                name: "Compare with the previous period",
                what: "Also work out the previous period of the same length, used for growth.",
                values: "On by default.",
              },
            ],
          },
        ],
      },
      {
        id: "columns",
        title: "Columns in each section",
        blocks: [
          {
            kind: "fields",
            title: "Business results (account managers only)",
            fields: [
              { name: "Active clients", what: "Their clients that sent traffic in the period." },
              { name: "New", what: "Clients whose first traffic was in the period (green)." },
              { name: "Stopped", what: "Clients that sent in the previous period but not in this one (amber)." },
              { name: "Messages", what: "Messages sent by their clients." },
              {
                name: "Revenue / Margin / Margin %",
                what: "Of their clients, in the platform currency. Traffic counts for the account manager at the time it was sent.",
              },
              {
                name: "Growth",
                what: "Revenue change against the previous period, in %. Green when up, amber when down.",
              },
              { name: "Target", what: "Their revenue target for the period (monthly targets prorated by day)." },
              { name: "Achieved", what: "Revenue ÷ target. Green from 100 %, amber below 70 %." },
            ],
          },
          {
            kind: "fields",
            title: "Rates & routing",
            fields: [
              {
                name: "Rate tables / Rate changes",
                what: "Rate tables they changed and the number of rates changed.",
              },
              { name: "RNs accepted / RNs rejected", what: "Vendor rate notifications they decided." },
              {
                name: "Market moves / Avg to handle",
                what: "Market moves they handled and the average hours from detection to handling.",
              },
              { name: "Route rules", what: "Route rules they changed." },
              { name: "Bulk jobs", what: "Bulk changes they ran." },
              { name: "Undone by others", what: "Their changes that someone else undid (amber when above 0)." },
            ],
          },
          {
            kind: "fields",
            title: "Billing",
            fields: [
              {
                name: "Invoices generated / Invoices sent",
                what: "Invoices they created and those e-mailed in the period.",
              },
              { name: "SOAs generated / SOAs sent", what: "Statements of account they created and e-mailed." },
              { name: "Payments recorded", what: "Payments they entered." },
              {
                name: "Disputes opened / Disputes closed",
                what: "Vendor invoices they put in or took out of dispute.",
              },
              {
                name: "Avg vendor SOA confirm",
                what: "Average hours to confirm a vendor statement (not measured yet; shows a dash).",
              },
            ],
          },
          {
            kind: "fields",
            title: "NOC",
            fields: [
              { name: "Alerts acknowledged", what: "Alerts they acknowledged." },
              {
                name: "Avg to acknowledge / Avg to resolve",
                what: "Average minutes from an alert starting to their acknowledgement, and to it ending.",
              },
              { name: "Incidents handled", what: "Acknowledged alerts that have ended." },
              { name: "Tickets raised", what: "Trouble-ticket e-mails they sent." },
              { name: "Binds started / stopped", what: "Times they started or stopped a trunk bind." },
            ],
          },
          {
            kind: "fields",
            title: "System activity",
            fields: [
              { name: "Roles", what: "Their roles." },
              { name: "Days active", what: "Days they signed in." },
              {
                name: "Hours online",
                what: "Time signed in during the period. A session left open counts at most 12 hours.",
              },
              { name: "Last sign-in", what: "Their latest sign-in (UTC)." },
              { name: "Saves", what: "Changes they saved (entries in the audit trail)." },
              { name: "Pages most used", what: "Their three most opened pages (hover for counts)." },
              {
                name: "New devices / IPs",
                what: "Sign-ins from a device, browser and IP combination not seen before (amber when above 0).",
              },
            ],
          },
        ],
      },
      {
        id: "member",
        title: "A member's details",
        blocks: [
          {
            kind: "list",
            items: [
              '**Overview**: for account managers, **Their clients** with a daily chart of messages and revenue, and the lists of new clients (click to open the enterprise) and clients that stopped sending. Then **Activity by hour (UTC)**, **Sign-in days** (first sign-in, last seen, hours and saves per day) and **Devices and IPs** (new ones are marked "new").',
              "**Timeline**: every change, sign-in and action of the person, newest first. Click an entry that points at a record (enterprise, trunk, rate table, route rule) to open it in a new tab.",
              "**Close** returns to the team charts.",
            ],
          },
        ],
      },
      {
        id: "targets",
        title: "How to set targets",
        blocks: [
          {
            kind: "steps",
            items: [
              "Press **Targets**.",
              "Choose the **Month**.",
              "Type a **Revenue target** and **Margin target** for each account manager, in the platform currency. Leave a box empty for no target.",
              "Press **Save**.",
            ],
          },
          {
            kind: "tip",
            text: "For a period that is not a whole month, the target is each month's target prorated by the days inside the period.",
          },
        ],
      },
      {
        id: "tips",
        title: "Tips and things to watch",
        blocks: [
          {
            kind: "tip",
            text: 'Money follows your [[am-visibility|visibility policy]]: you may see "Hidden", "Above limit", or margin only as "Low", "Normal" or "High".',
          },
          {
            kind: "tip",
            text: "To get a weekly summary by e-mail, add a schedule in [[scheduled|Scheduled reports]] with **Report Template** set to **Team report** and **Each run covers** set to **Last week**.",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ Scheduled reports
  {
    id: "scheduled",
    pageKey: "scheduled",
    title: "Scheduled reports",
    group: "Reports",
    summary:
      "Reports e-mailed automatically on a timetable: a ready-made report, a saved Master report view or the Team report, as Excel, CSV or PDF.",
    keywords: ["schedule report", "cron", "email report", "automatic report", "weekly summary", "report subscription"],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "Set up reports that go out by e-mail by themselves, for example the Sales report every Monday morning to the sales team, or a saved Master report view every day to a manager. Each schedule picks the report, the recipients, the timetable and the file type.",
          },
        ],
      },
      {
        id: "layout",
        title: "What you see on the page",
        blocks: [
          {
            kind: "list",
            items: [
              "Header: **Undo**, **History**, **Export** and the **Add** button.",
              "Grid columns: **Info ID**, **Name**, **Report Template**, **Status** (green dot: Active; grey: Inactive), **Schedule** (the CRON expression), **Next Run**, **Last Run** and **Last Status** (green: Sent; red: Failed, hover for the reason). **Business Company** and **Updated By** can be added with **Columns**.",
              "Deleted schedules appear greyed out.",
              "Detail panel, **Schedule** tab: the report, recipients, sending company, schedule with next run, file type, last run and any error, with **Run now**, **Edit** and **Delete** (or **Restore** for administrators on a deleted one). **History** tab: every saved change of this schedule.",
            ],
          },
        ],
      },
      {
        id: "fields",
        title: "Fields in the schedule form",
        blocks: [
          {
            kind: "fields",
            fields: [
              {
                name: "Report Template",
                what: "What kind of report to send.",
                values: "**Ready-made report**, **Saved Master Report view** or **Team report**.",
              },
              {
                name: "Report",
                what: "Ready-made report only: which one. Each runs with its own period, for example the Sales report covers the last 7 days.",
                values:
                  "Sales, Billing, NOC, Customize, Enterprise, Master Grouping, Usage Enterprise, Negative Margin, Bilateral.",
              },
              {
                name: "View",
                what: "Saved view only: the Master report view to send, with its settings, filters and sort.",
                values:
                  "Only views saved with **Save view** on the Master report appear. If the list is empty, save a view there first.",
              },
              {
                name: "Each run covers",
                what: "Team report only: the period of each e-mail.",
                values: "**Yesterday**, **Last 7 days**, **Last week (weekly summary)**, **Last month**.",
              },
              {
                name: "Department",
                what: "Team report only: one department, or everyone.",
                values: "Default **Everyone**.",
              },
              {
                name: "Schedule Report Name",
                what: "The schedule's name, also shown in the list.",
                values: "Required, up to 120 characters, unique. Example: `Sales weekly – team`.",
              },
              {
                name: "Status",
                what: "Only active schedules run.",
                values: "**Active** (default) or **Inactive** (no next run).",
              },
              { name: "Description", what: "A note for colleagues.", values: "Optional, up to 500 characters." },
              { name: "Business Company", what: "The company the e-mail is sent from.", values: "Required." },
              {
                name: "Notification Email",
                what: "Who receives the report.",
                values:
                  "One or more addresses separated by commas, for example `sales@example.net, head@example.net`. Each address is checked when you save.",
              },
              {
                name: "CRON Interval",
                what: "How often, roughly. Changing it fills the expression below.",
                values: "**Minute**, **Hourly**, **Daily** (default), **Weekly**, **Monthly**.",
              },
              {
                name: "CRON Frequency (every n)",
                what: "Every how many minutes, hours or days. Changing it fills the expression below.",
                values: "1 to 59; default 1.",
              },
              {
                name: "CRON Scheduler Expression",
                what: "The exact timetable: minute, hour, day of month, month, weekday, in UTC. Under the box you see it in words and the next three runs.",
                values:
                  "Filled from the interval: Minute `*/n * * * *`; Hourly `0 */n * * *`; Daily `0 6 * * *` (06:00 UTC; `0 6 */n * *` for every n days); Weekly `0 6 * * 1` (Monday 06:00); Monthly `0 6 1 * *`. You can type your own, for example `30 7 * * 1-5` for weekdays at 07:30 UTC.",
              },
              { name: "File", what: "The attachment format.", values: "**Excel** (default), **CSV** or **PDF**." },
              {
                name: "Email Body",
                what: "The text of the e-mail, in HTML. Placeholders are filled in when it is sent.",
                values: "`{report}` report name, `{from}` and `{to}` the period in UTC, `{rows}` the number of rows.",
              },
            ],
          },
        ],
      },
      {
        id: "how-to",
        title: "How to add, test and stop a schedule",
        blocks: [
          {
            kind: "steps",
            title: "Add a schedule",
            items: [
              "Press **Add**.",
              "Choose the **Report Template** and then the report, view or Team settings.",
              "Type the **Schedule Report Name** and the **Notification Email** addresses.",
              "Choose **CRON Interval** and **CRON Frequency**, or type the expression. Check the next runs shown below it.",
              "Choose the **File** type, adjust the **Email Body** if needed and press **Add schedule**.",
            ],
          },
          {
            kind: "steps",
            title: "Send it now to test",
            items: [
              "Click the schedule.",
              "Press **Run now**. A message tells you whether it was sent, and to whom.",
              "Check the e-mail in [[email-logs|Email logs]].",
            ],
          },
          {
            kind: "steps",
            title: "Pause or remove a schedule",
            items: [
              "To pause, open it with **Edit** (or double-click), set **Status** to **Inactive** and save.",
              "To remove, press **Delete** in the detail panel. The schedule is archived and an administrator can restore it. See [[safe-delete]].",
            ],
          },
        ],
      },
      {
        id: "how-it-works",
        title: "How it works",
        blocks: [
          {
            kind: "list",
            items: [
              "Every minute the system sends the active schedules that are due, then works out the next run.",
              'Each run uses the report\'s period relative to the moment it runs, for example "yesterday" is the day before the run.',
              'If the saved view behind a schedule was deleted, the run fails with "The report template no longer exists".',
              "Every save is one change you can undo with **Undo** (Ctrl+Z). See [[undo-and-history]].",
            ],
          },
          {
            kind: "tip",
            text: "In the trial, e-mails are only written to Email logs; nothing is actually sent.",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ Daily traffic alerts
  {
    id: "daily-traffic",
    pageKey: "daily-traffic",
    title: "Daily traffic alerts",
    group: "Reports",
    summary: "Yesterday's traffic summary per trunk, e-mailed to a partner's contact every day at a set hour.",
    keywords: ["daily traffic alert", "daily summary", "partner email", "traffic summary", "yesterday traffic"],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "Account managers use daily traffic alerts to keep partners informed. Every day, at the hour you choose, the partner's chosen contact receives a short table of yesterday's traffic on each of its trunks.",
          },
        ],
      },
      {
        id: "layout",
        title: "What you see on the page",
        blocks: [
          {
            kind: "list",
            items: [
              "Header: **Undo**, **History**, **Export** and **Add**.",
              "Grid columns: **Info ID**, **Name**, **Enterprise**, **Contact** (which contact type receives it), **Send Hour (UTC)**, **Status** (green dot: Active; grey: Inactive) and **Last Sent**.",
              "Deleted alerts appear greyed out.",
              "Detail panel, **Alert** tab: enterprise, contact type, sending company, the time it goes out and when it was last sent, with **Send now**, **Edit** and **Delete** (**Restore** for administrators). **History** tab: its saved changes.",
            ],
          },
        ],
      },
      {
        id: "fields",
        title: "Fields in the alert form",
        blocks: [
          {
            kind: "fields",
            fields: [
              {
                name: "Name",
                what: "The alert's name.",
                values:
                  'Required, up to 120 characters, unique. Filled with "<enterprise> – daily summary" when you pick the enterprise first.',
              },
              { name: "Status", what: "Only active alerts are sent.", values: "**Active** (default) or **Inactive**." },
              {
                name: "Enterprise",
                what: "The partner whose traffic is summarised and who receives it.",
                values: "Required. Search by name.",
              },
              {
                name: "Enterprise Contact Email",
                what: "Which of the enterprise's contacts receives the e-mail.",
                values:
                  "**Commercial** (default), **Technical**, **Rates** or **Finance**. The addresses come from the enterprise's contacts.",
              },
              {
                name: "Business Company",
                what: "The company the e-mail is sent from.",
                values: "Optional; default is the enterprise's own business company.",
              },
              {
                name: "Send hour (UTC)",
                what: "The hour of the day the e-mail goes out.",
                values: "0 to 23; default 6 (06:00 UTC).",
              },
              {
                name: "Email Body",
                what: "The text of the e-mail. Placeholders are filled when it is sent.",
                values:
                  "`{enterprise}` partner name, `{date}` the day reported, `{summary}` the traffic table, `{company}` the sending company.",
              },
            ],
          },
        ],
      },
      {
        id: "summary",
        title: "What the summary contains",
        blocks: [
          {
            kind: "text",
            text: "The summary covers yesterday, midnight to midnight UTC. It has one line per trunk of the enterprise, customer trunks first, then vendor trunks, with these columns:",
          },
          {
            kind: "list",
            items: [
              "**Trunk**: the trunk name and its side (customer or vendor).",
              "**Messages**: all attempts on the trunk.",
              "**Delivered**: messages with a delivered receipt.",
              "**DLR %**: delivered ÷ messages accepted by the vendor × 100.",
              "**Amount**: revenue (customer trunks) or cost (vendor trunks), in the platform currency.",
            ],
          },
          {
            kind: "text",
            text: 'With no traffic, the e-mail says "No traffic on this day."',
          },
        ],
      },
      {
        id: "how-to",
        title: "How to add and test an alert",
        blocks: [
          {
            kind: "steps",
            items: [
              "Press **Add**.",
              "Pick the **Enterprise**; the name is filled in for you.",
              "Choose the **Enterprise Contact Email** type and the **Send hour (UTC)**.",
              "Adjust the **Email Body** if you want and press **Add alert**.",
              "Click the new alert and press **Send now**. A window shows the recipients, subject and text exactly as sent.",
            ],
          },
          {
            kind: "warning",
            text: 'If the enterprise has no contact of the chosen type, the window shows "no contact (logged as failed)". Add the contact on the enterprise first.',
          },
        ],
      },
      {
        id: "how-it-works",
        title: "How it works",
        blocks: [
          {
            kind: "list",
            items: [
              "Every minute the system checks for active alerts whose send hour has come and that were not yet sent today (UTC), and sends them.",
              "Every e-mail, sent or failed, is written to [[email-logs|Email logs]].",
              "Saves can be undone (Ctrl+Z); delete archives the alert.",
            ],
          },
          {
            kind: "tip",
            text: "In the trial, e-mails are only written to Email logs; nothing is actually sent.",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ concept: metrics
  {
    id: "report-metrics",
    title: "Report metrics explained",
    group: "Reports",
    summary:
      "Every figure the reports offer (attempts, ASR, DLR, revenue, margin, rates, delay, HLR, TPS and more), how each is calculated, plus the group-by fields, periods, time zones and currencies.",
    keywords: [
      "metrics",
      "asr",
      "dlr",
      "dlr(s)",
      "dlr(t)",
      "margin",
      "billable",
      "reported",
      "tps",
      "hlr",
      "delivery delay",
      "base currency",
      "platform currency",
      "formula",
      "definitions",
    ],
    sections: [
      {
        id: "basics",
        title: "Where the figures come from",
        blocks: [
          {
            kind: "text",
            text: "Every traffic report is built from EDRs (event data records): one record per message attempt. If a message is re-tried on another vendor, each try is a separate EDR. Figures are counted for a group (for example one customer on one day) and ratios are then worked out from the group's sums, so a total is never an average of averages.",
          },
          {
            kind: "text",
            text: "The same metric names are used in the [[master-report]], the [[enterprise-report]], and the [[sales-report]] and [[noc-report]]. Labels differ a little between pages; both are given below.",
          },
        ],
      },
      {
        id: "counts",
        title: "Message counts",
        blocks: [
          {
            kind: "fields",
            fields: [
              {
                name: "Attempts",
                what: "Every EDR in the group: each message attempt, including re-tries.",
                values: "Count.",
              },
              { name: "Successful", what: "Attempts the vendor accepted (the submit was answered OK)." },
              { name: "Submitted", what: "Attempts that were routed to a vendor trunk (accepted or not)." },
              {
                name: "Failed Submits",
                what: "Attempts sent to a vendor that the vendor rejected (Submitted minus Successful).",
              },
              { name: "Delivered", what: "Attempts with a delivered receipt (status DELIVRD) from the vendor." },
              {
                name: "Billable (Customer) / Billable (C)",
                what: "Messages we can charge the customer for. It depends on the customer trunk's billing type: every attempt, accepted submits, messages with a final receipt, or delivered messages only. Only the final attempt of a re-tried message counts.",
              },
              {
                name: "Billable (Vendor) / Billable (V)",
                what: "Messages the vendor can charge us for, by the vendor trunk's billing type. Every attempt that reached the vendor can count.",
              },
              {
                name: "Reported (C)",
                what: "Messages for which the customer got a final receipt (any status other than none or ENROUTE).",
              },
              { name: "Reported (V)", what: "Messages for which the vendor sent a final receipt." },
              {
                name: "Re-routes",
                what: "Attempts that were re-tries: re-routed after a failed receipt, or attempt number 2 or higher.",
              },
              { name: "MO Count", what: "Mobile-originated messages (from phones)." },
            ],
          },
        ],
      },
      {
        id: "quality",
        title: "Quality ratios",
        blocks: [
          {
            kind: "fields",
            fields: [
              {
                name: "ASR % (answer seizure ratio)",
                what: "Share of attempts the vendor accepted.",
                values: "Successful ÷ Attempts × 100, one decimal.",
              },
              {
                name: "DLR(s) % / DLR (Customer)",
                what: "Delivery ratio as the customer sees it: receipts reporting delivered to the customer.",
                values: "Customer-side delivered ÷ Successful × 100.",
              },
              {
                name: "DLR(t) % / DLR (Vendor)",
                what: "Delivery ratio as the vendor reported it.",
                values: "Vendor-side delivered ÷ Successful × 100.",
              },
              {
                name: "Delivery Delay (s)",
                what: "Average time to delivery for delivered messages.",
                values: "Sum of delivery delays of delivered messages ÷ Delivered, in seconds, one decimal.",
              },
            ],
          },
          {
            kind: "tip",
            text: "A ratio shows a dash when there is nothing to divide by (for example DLR with no successful messages).",
          },
        ],
      },
      {
        id: "money",
        title: "Money",
        blocks: [
          {
            kind: "fields",
            fields: [
              {
                name: "Revenue",
                what: "What we charge customers for billable messages (sell rate × message parts).",
                values: "Master report: platform currency. Enterprise report: the partner's own currency.",
              },
              {
                name: "Cost",
                what: "What vendors charge us for billable messages (buy rate × message parts).",
                values: "Master report: platform currency. Enterprise report: the partner's own currency.",
              },
              {
                name: "Margin",
                what: "Revenue minus cost, in the platform currency. Red when negative.",
                values: "Revenue − Cost.",
              },
              { name: "Margin %", what: "Margin as a share of revenue.", values: "(Revenue − Cost) ÷ Revenue × 100." },
              {
                name: "Avg Rate (Customer)",
                what: "Average sell price per billable customer message.",
                values: "Revenue ÷ Billable (Customer), 5–6 decimals.",
              },
              {
                name: "Avg Rate (Vendor)",
                what: "Average buy price per billable vendor message.",
                values: "Cost ÷ Billable (Vendor).",
              },
              {
                name: "Cost (Avg)",
                what: "Average buy price per billable vendor message, always in the platform currency.",
                values: "Cost ÷ Billable (Vendor).",
              },
              {
                name: "Revenue (B) / Cost (B)",
                what: "Revenue and cost in the base currency of the business company that carried the traffic. In the Master report it is blank when a row mixes more than one business company, because base currencies cannot be added. In the Enterprise report these columns are shown with the platform currency in their name, for example **Revenue (EUR)**.",
              },
              {
                name: "HLR Cost",
                what: "What number lookups (HLR) cost. Master report: platform currency; Enterprise report: partner currency.",
              },
              { name: "HLR Cost (B)", what: "Enterprise report: HLR cost in the platform currency." },
            ],
          },
          {
            kind: "text",
            text: "The platform currency is the one currency every cross-company total uses (EUR unless set otherwise). Amounts in other currencies are converted at the latest exchange rate on the [[currencies|Currencies]] page.",
          },
        ],
      },
      {
        id: "hlr",
        title: "HLR lookups",
        blocks: [
          {
            kind: "text",
            text: "An HLR lookup asks the mobile network which network a number belongs to now (for example after it was ported).",
          },
          {
            kind: "fields",
            fields: [
              { name: "HLR Cached", what: "Lookups answered from the stored result of an earlier lookup." },
              { name: "HLR Live", what: "Lookups sent to an HLR provider." },
              { name: "HLR Total", what: "HLR Cached + HLR Live." },
              { name: "HLR Accomplished", what: "Lookups that returned an answer." },
              { name: "HLR Ported", what: "Lookups that found the number ported to another network." },
            ],
          },
        ],
      },
      {
        id: "tps",
        title: "Speed (TPS)",
        blocks: [
          {
            kind: "text",
            text: "TPS means transactions (messages) per second.",
          },
          {
            kind: "fields",
            fields: [
              {
                name: "TPS (avg)",
                what: "Average speed over the whole window.",
                values: "Attempts ÷ number of seconds in the window (the **Each day** hours do not shorten it).",
              },
              {
                name: "TPS (peak)",
                what: "Speed in the busiest minute of the window.",
                values: "Highest per-minute attempts ÷ 60. Cannot be sorted on.",
              },
              {
                name: "TPS (now)",
                what: "Speed in the last minute, only when the window includes now; otherwise blank.",
                values: "Attempts in the last minute ÷ 60.",
              },
            ],
          },
        ],
      },
      {
        id: "dimensions",
        title: "Group-by fields",
        blocks: [
          {
            kind: "text",
            text: "In the Master report (and the Sales and NOC reports) you can group by up to five of these, in any order:",
          },
          {
            kind: "fields",
            fields: [
              {
                name: "Date, Hour, Week, Month",
                what: 'Time buckets in the report time zone. Weeks start on Monday and show as "Week of …".',
              },
              {
                name: "Customer, Customer Trunk, Customer IP",
                what: "Who sent the message and over which trunk and address.",
              },
              {
                name: "Vendor, Vendor Trunk, Vendor IP",
                what: 'Where it was sent. Messages not routed show "not routed".',
              },
              { name: "Country", what: "Destination country, shown as name and ISO code." },
              {
                name: "Destination (MCCMNC)",
                what: "Destination network as the customer was charged: country · network (code).",
              },
              {
                name: "Vendor Destination",
                what: "Destination network as sent to the vendor (can differ after a translation).",
              },
              { name: "Product Category", what: "The product category of the traffic." },
              { name: "Sender ID", what: "The sender name or number on the message." },
              { name: "Route Rule, Route Type", what: "The route rule that chose the vendor, and its type." },
              { name: "Rate Table", what: "The customer rate table used." },
              {
                name: "Account Manager, Vendor Account Manager",
                what: "The customer's or vendor's account manager at the time of sending.",
              },
              { name: "Business Company", what: "Our company that carried the traffic." },
              { name: "Currency", what: "The customer's billing currency." },
              { name: "Type", what: "MT or MO." },
              { name: "HLR Provider", what: "The provider that answered the number lookup." },
              { name: "Error Code", what: "The error returned for the attempt, with its name." },
              { name: "Delivery Status", what: 'The final receipt status, or "no receipt".' },
            ],
          },
          {
            kind: "text",
            text: "The Enterprise report has its own simpler grouping: **Enterprise**, **Trunk**, **Country**, **Destination** and **Account manager**, split by **Report by** (whole period, hour, day, week or month).",
          },
        ],
      },
      {
        id: "periods",
        title: "Periods and time zones",
        blocks: [
          {
            kind: "list",
            title: "Quick periods",
            items: [
              "**Today**: from midnight until now.",
              "**Yesterday**: the whole previous day.",
              "**Last 24 hours**: the 24 hours up to now.",
              "**Last 7 days**: today and the six days before.",
              "**This week** / **Last week**: weeks start on Monday.",
              "**This month** / **Last month**: calendar months.",
              "**Custom**: your own start and end; the end is never included. At most 400 days.",
            ],
          },
          {
            kind: "list",
            title: "Time zones",
            items: [
              "Master, Sales and NOC reports: the **Timezone** setting (UTC by default, 31 zones) decides where days start for the quick periods and for Date, Hour, Week and Month rows. The **From** and **to** boxes are always UTC; the totals line shows the exact window used, in UTC.",
              "Enterprise report: days and months are cut at midnight in each partner's billing time zone by default, or in UTC or the platform time zone.",
              "Billing report, Team report, daily traffic alerts and the schedules' timetables use UTC.",
            ],
          },
          {
            kind: "list",
            title: "Comparing periods",
            items: [
              "**Previous period**: a window of the same length just before.",
              "**Same time last week**: the same window seven days earlier.",
              "The change is (now − before) ÷ before × 100. It is green when the change is good and red when bad; for cost-like figures (Cost, Cost (B), Cost (Avg), Failed Submits, Delivery Delay, Re-routes, HLR Cost) a rise is bad.",
            ],
          },
        ],
      },
      {
        id: "filters",
        title: "Filtering on metrics",
        blocks: [
          {
            kind: "text",
            text: "In the Master report, a filter under a group-by column (for example Customer `Acme%`) decides which messages are counted. A filter under a metric column (for example Margin `< 0` or DLR(t) % `< 80`) hides whole rows after they are added up. Both use the usual filter grammar: `%` and `_` wildcards, case-insensitive matching, regular expressions and the multi-field builder. See [[grids-and-filters]] and [[filter-builder]].",
          },
          {
            kind: "warning",
            text: "Metric filters can be combined with field filters only with AND, not OR.",
          },
        ],
      },
    ],
  },
];
