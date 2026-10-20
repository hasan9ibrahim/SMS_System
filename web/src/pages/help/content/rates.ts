// Help center: Rates (§6.1, §6.2, §13.11–13.14, §13.21, §13.32).
import type { HelpTopic } from "../helpTypes";

export const topics: HelpTopic[] = [
  // ------------------------------------------------------------------ concept: how rates work
  {
    id: "rates-basics",
    title: "How rates work",
    group: "Rates",
    summary:
      "Rate tables, rates, effective dates and history: how the platform knows what to charge a client and what a vendor charges us for each message.",
    keywords: [
      "rate table",
      "sell rate",
      "buy rate",
      "price list",
      "tariff",
      "effective date",
      "rate history",
      "notice period",
      "blocked",
      "sender ID",
      "currency",
      "RN",
      "rate notification",
      "all networks",
      "country rate",
    ],
    sections: [
      {
        id: "tables",
        title: "Rate tables",
        blocks: [
          {
            kind: "text",
            text: "A **rate table** is a price list: one price per destination. There are two kinds:",
          },
          {
            kind: "list",
            items: [
              "**Customer (sell) tables** hold what we charge a client. You create them yourself in the [[rate-manager|Rate manager]] and attach them to one or more customer trunks. Several clients can share one table.",
              "**Vendor (buy) tables** hold what a vendor charges us. Each vendor trunk has exactly one, created together with the trunk. You see it in the Rate manager (switch to **Vendor**) and on the vendor trunk's **Rates** tab.",
            ],
          },
          {
            kind: "text",
            text: "Every table has a **name**, a **product category** (the traffic class, e.g. DIRECT, HQ or OTP, see [[categories|Product categories]]) and a **currency**. All rates in a table are in its currency.",
          },
        ],
      },
      {
        id: "lines",
        title: "Rates: one per destination",
        blocks: [
          {
            kind: "text",
            text: "Each price in a table is a **rate** for one destination. A destination is an **MCCMNC** code (Mobile Country Code + Mobile Network Code) from the [[mccmnc|MCCMNC codes]] list, for example `26201` for one German network.",
          },
          {
            kind: "list",
            items: [
              '**Network rate**: a price for one network, e.g. "Germany · Example Mobile (26201)".',
              '**Country rate ("All networks")**: a price for the 3-digit country code, e.g. "Germany · All networks (262)". It is the fallback for every network of that country that has no rate of its own.',
              '**Sender-ID rate**: a rate can also name a **Sender ID** (the "from" name or number on the SMS). That price applies only to messages sent with that sender ID. Rates without a sender ID are the normal (generic) price.',
            ],
          },
          {
            kind: "tip",
            text: 'Ticking a whole country in the destination tree adds a rate for every code of that country, including its "All networks" code. Ticking only the "All networks" row adds just the country fallback.',
          },
        ],
      },
      {
        id: "dates",
        title: "Effective dates and history",
        blocks: [
          {
            kind: "text",
            text: "A rate is never overwritten. When you change a rate, the platform ends the old rate and starts a **new version** from the effective date you choose. Dates and times are in the platform (system) time zone, 24-hour; by default a change is dated today 00:00 (**Next 00:00** and **Now** are one click away). A date in the past is fine: the change still applies from the moment you save, so traffic already sent keeps its rate; the past date is shown as the rate's effective date. Re-rating past traffic is a separate request ([[re-rating|Re-rating]]). The old version stays in the table's history with its from and to dates.",
          },
          {
            kind: "list",
            items: [
              "**Current**: rates valid right now.",
              "**Scheduled**: rates that start in the future. A destination can have a current rate and a scheduled next rate at the same time.",
              "**Closed**: rates that have ended. They are kept so old traffic can always be explained.",
            ],
          },
          {
            kind: "text",
            text: "Each new version is marked with its change against the version before: **New** (the destination had no rate), **Increase**, **Decrease** or **Same**.",
          },
          {
            kind: "warning",
            text: "Effective dates can never be in the past. Traffic already sent always keeps the rate it was sent at. A correction for old traffic is only possible through a [[re-rating|Re-rating]] request with approval.",
          },
        ],
      },
      {
        id: "notice",
        title: "Increases and notice periods",
        blocks: [
          {
            kind: "text",
            text: "Each client has a **Rate notice period** (in days) on its enterprise record. A price increase on a customer table should not start sooner than that notice.",
          },
          {
            kind: "list",
            items: [
              "When a table is used by several clients, the longest notice period among them counts.",
              "If you save a change that starts sooner than the client's notice for that kind (increase, decrease or new destination, set on the enterprise), the platform stops and shows **Changes sooner than the client's notice**, listing each rate, its kind, its current and new rate and the earliest allowed date. You can cancel and change the date, or choose **Apply anyway** (the override is logged with the change).",
              "Decreases and new destinations can start at once.",
              "In [[bulk|Bulk rating]], **Respect notice periods** moves each increase to the end of its client's notice automatically.",
            ],
          },
        ],
      },
      {
        id: "blocked",
        title: "Blocked rates",
        blocks: [
          {
            kind: "text",
            text: "A rate can be **blocked** (shown with a lock icon). The price stays in the table, but traffic is not accepted at it: a blocked customer rate means the client cannot send to that destination at that price, and a blocked vendor rate is never used by routing. Unblock the rate to use it again. A new rate on a blocked rate keeps the block.",
          },
        ],
      },
      {
        id: "currency",
        title: "Currency and converted rates",
        blocks: [
          {
            kind: "text",
            text: "Rates are stored in the table's currency. For comparisons (margins, best buy, routing costs, reports) the platform converts them to the platform currency with the latest exchange rate from [[currencies|Currencies]]. The hidden **Sys Rate** column in the rate grid shows the converted value.",
          },
        ],
      },
      {
        id: "picking",
        title: "How a rate is picked for a message",
        blocks: [
          {
            kind: "steps",
            title: "Client price (sell rate)",
            items: [
              "The message's destination network is found (from the number, using the [[master-table|Master table]] dial codes, or an HLR lookup).",
              "The customer trunk's rate tables are tried in the order they are listed on the trunk. The first table that has a rate for the destination prices the message.",
              "Inside that table the most specific rate valid at send time wins: a rate with the message's sender ID first, then the network's own rate, then the country's \"All networks\" rate.",
              "If no rate is found, or the rate is blocked, the message has no price and is not accepted.",
            ],
          },
          {
            kind: "text",
            text: "Vendor costs work the same way per vendor trunk: the network rate, else the country rate (sender-ID rates and blocked rates are not used for routing). Routing then chooses a vendor using the [[route-rules|Route rules]]. You can test any destination in [[rate-lookup|Rate lookup]].",
          },
        ],
      },
      {
        id: "best-buy",
        title: "Best buy and margin",
        blocks: [
          {
            kind: "text",
            text: "**Best buy** is the cheapest current vendor rate for a destination in the same product category, converted to the customer table's currency. **Margin** is sell rate minus best buy; **Margin %** is that margin divided by the sell rate. A negative margin means we sell below the cheapest vendor cost and is shown in red.",
          },
        ],
      },
      {
        id: "notifications",
        title: "Rate notifications (RNs)",
        blocks: [
          {
            kind: "list",
            items: [
              "**To clients**: when you save a change on a customer table with **Send RN to clients** ticked (the default), each client using the table gets one e-mail listing the changed rates (new rate and date, closed, blocked or withdrawn). It goes to the client's rates contact, or the commercial contact when there is none, from its business company's rates mailbox.",
              "**From vendors**: vendors send us their own RNs. They arrive in [[incoming-rns|Incoming RNs]], where they are checked against live traffic and accepted or rejected.",
            ],
          },
          {
            kind: "tip",
            text: "In the trial, e-mails are written to the e-mail log and not really sent.",
          },
        ],
      },
      {
        id: "no-rerate",
        title: "A vendor RN never re-rates traffic already sent",
        blocks: [
          {
            kind: "text",
            text: "Vendors sometimes send a new rate with a date in the past. The platform never applies it to messages already sent: the new rate starts when the RN was received (or when it is accepted, if later). The vendor's stated date is kept on the rate for reference, and the rate is flagged **Back-dated** so you can see how much traffic was sent in between at the old cost.",
          },
          {
            kind: "warning",
            text: "Billed messages (EDRs, the per-message records) always keep the rate and cost they were billed at. If billing agrees with the vendor to apply a back-dated rate, it must be done through a manual [[re-rating|Re-rating]] request with approval, which posts a credit or debit note.",
          },
        ],
      },
      {
        id: "undo",
        title: "Every save is one change you can undo",
        blocks: [
          {
            kind: "text",
            text: "Each save on rates (one edit, a batch from the bulk bar, a bulk rating job or an accepted RN) is recorded as one change with your name and time. You can undo it from the toast, from the table's **Change log** or from **History**. See [[undo-and-history]].",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ Rate manager
  {
    id: "rate-manager",
    pageKey: "rate-manager",
    title: "Rate manager",
    group: "Rates",
    summary:
      "All customer (sell) and vendor (buy) rate tables in one workspace: find a table, open its rates, edit them in place or in bulk, add destinations, export and see the change log.",
    keywords: [
      "rate table",
      "rates",
      "sell rates",
      "buy rates",
      "price list",
      "add rates",
      "close rate",
      "block rate",
      "copy rates",
      "margin",
      "best buy",
      "scheduled",
      "export rates",
      "send RN",
      "rate history",
      "ratetable",
    ],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "The Rate manager is where account managers (AMs), the rates team and billing look after prices. It opens with the list of rate tables filling the page. When you open a table, the list shrinks into a narrow panel on the left and the table's rates open on the right, in the same tab.",
          },
          {
            kind: "text",
            text: "Use it to create client price lists, change rates (one at a time or many at once), add new destinations, close or block destinations, check margins against the best vendor, and see who changed what. For the ideas behind it (versions, notice periods, how a rate is picked) read [[rates-basics|How rates work]] first.",
          },
          {
            kind: "tip",
            text: "Links to a rate table from a trunk, a route rule or an alert open the table here directly. Ctrl-click a table to open it in its own tab.",
          },
        ],
      },
      {
        id: "list",
        title: "The full list of rate tables",
        blocks: [
          {
            kind: "text",
            text: "The header has **New rate table** (the main button). Above the grid, the **Customer / Vendor** switch picks which kind of table you see (Customer is the default), and **Account manager** keeps only tables of that AM's clients (**All** = every AM). Both work as filters, so they also show as filter chips and stay in the tab's address.",
          },
          {
            kind: "fields",
            title: "Columns",
            fields: [
              { name: "Name", what: "The table's name. Click it to open the table (Ctrl-click: new tab)." },
              {
                name: "Type",
                what: "Customer (sell) or Vendor (buy). Set by the Customer / Vendor switch.",
              },
              {
                name: "Clients",
                what: "The clients whose trunks use the table, in bold. The first two are shown, then +n; point at the cell to see them all.",
              },
              {
                name: "Trunks",
                what: "The trunks that use the table, in bold (first two, then +n); point at the cell to see them all.",
              },
              { name: "Product Category", what: "The table's traffic class, e.g. DIRECT or OTP." },
              { name: "Currency", what: "The currency of every rate in the table." },
              { name: "Active Rates", what: "How many rates are valid right now." },
              { name: "Scheduled", what: "How many rates start in the future." },
              {
                name: "Neg. Margin",
                what: "Customer tables: how many current rates sell below the best vendor cost. Shown in red when above 0. Empty for vendor tables.",
              },
              {
                name: "Avg Margin",
                what: "Average margin of today's traffic on the table. Cannot be filtered or sorted (it comes from live traffic).",
              },
              {
                name: "Today",
                what: "Today's revenue (customer table) or cost (vendor table) in the table's currency. Cannot be filtered or sorted.",
              },
              { name: "Last Change / By", what: "When the table or its rates last changed, and who changed it." },
              {
                name: "Hidden columns",
                what: "Add from the column menu: ID, Account Manager, Vendor Trunk, Customer Trunks, Next Change, Description and Deleted.",
              },
            ],
          },
          {
            kind: "list",
            title: "Row menu",
            items: [
              "**Open** / **Open in new tab**.",
              "**Bulk rating…**: opens [[bulk|Bulk rating]] for this table (customer tables only).",
              "**Delete…**: archives the table (see below).",
            ],
          },
          {
            kind: "text",
            text: "Tick several tables (Space or the checkboxes) and choose **Bulk rating (n tables)…** to re-price them together. Filtering, sorting and search all run on the server; see [[grids-and-filters]].",
          },
        ],
      },
      {
        id: "panel",
        title: "The left panel (when a table is open)",
        blocks: [
          {
            kind: "list",
            items: [
              "**Customer (sell) / Vendor (buy)** switch: which kind of table the panel lists. It starts on the kind of the open table.",
              "**Filter rate tables…**: type part of a name to narrow the list.",
              'Tables are grouped by product category ("Customer · OTP"). Each shows its number of current rates and, when there are any, an amber **n scheduled** badge. The open table is highlighted.',
              "Click a table to open it; Ctrl-click or middle-click opens it in a new tab.",
              "At the bottom: the number of tables, **New rate table**, and **Full list** (back to the full-page list).",
            ],
          },
        ],
      },
      {
        id: "table-header",
        title: "The open table: header and summary cards",
        blocks: [
          {
            kind: "text",
            text: 'Under the table\'s name you see its type, currency and category, the trunks that use it (click a trunk to open it in a new tab; more than four show as +n) or "not used by any trunk", and the last import (when and by whom).',
          },
          {
            kind: "fields",
            title: "Header actions",
            fields: [
              {
                name: "Import",
                what: "Uploading a rate sheet into a table. Not available yet; it comes with the import wizard.",
              },
              {
                name: "Export",
                what: "Downloads the rates of the view you are on (Current, Scheduled or Closed; from Change log it exports Current) that match the grid's filters, search and sort, as a CSV file. Columns: Country, Network, MCCMNC, Dial Code, Sender ID, Rate, Currency, Sys Rate, Best Buy, Best Vendor, Margin, Margin %, Change, From Date (UTC), To Date (UTC), Blocked, Rate Note. Values you are not allowed to see stay hidden in the file.",
              },
              {
                name: "Send to client",
                what: "Customer tables only. Not available as a separate step: clients are notified when you save with **Send RN to clients** ticked.",
              },
              { name: "History", what: "Switches to the **Change log** view." },
              {
                name: "More (…)",
                what: "**Rename…** (name and description) and **Delete table…** (customer tables only).",
              },
              {
                name: "Add rates",
                what: "Adds prices for new destinations (or new versions for existing ones). See the Add rates dialog below.",
              },
              { name: "× (close)", what: "Closes the table and goes back to the full list." },
            ],
          },
          {
            kind: "fields",
            title: "Summary cards",
            fields: [
              { name: "Active rates", what: "Rates valid now, and in how many countries." },
              {
                name: "Scheduled changes",
                what: "Rates that start later, the next date and how many are increases. Amber when increases are planned.",
              },
              {
                name: "Negative margin",
                what: "Customer tables: current rates that sell below today's best buy. Red when above 0.",
              },
              {
                name: "Closed rates",
                what: "Vendor tables: how many ended rates are kept in the history.",
              },
              {
                name: "Avg margin",
                what: "Margin weighted by today's traffic. Green when positive, red when negative.",
              },
              {
                name: "Revenue today / Cost today",
                what: 'Money from today\'s messages on this table, and the number of messages. Shows "EDR store unavailable" when traffic figures cannot be read.',
              },
            ],
          },
        ],
      },
      {
        id: "grid",
        title: "The rate grid",
        blocks: [
          {
            kind: "text",
            text: "Above the grid are the view tabs, each with its count: **Current**, **Scheduled**, **Closed** and **Change log**. Next to them are quick filters: **Change** (All, New, Increase, Decrease, Same), **Sender ID** (Any, With sender ID, Without), **Negative margin only** (customer tables) and a search box (**Search MCCMNC, network…**, press Enter). Every column also has its own filter under the header.",
          },
          {
            kind: "fields",
            title: "Columns",
            fields: [
              { name: "Country / Network / MCCMNC", what: "The destination of the rate." },
              {
                name: "Sender ID",
                what: "Empty for the normal price; a value means the rate only prices that sender ID.",
              },
              {
                name: "Sell Rate (USD) (Buy Rate on vendor tables)",
                what: "The price, in the table's currency (named in the header). Click it to edit. A lock icon means the rate is blocked. Edited values are highlighted until you save.",
              },
              {
                name: "Rate (EUR)",
                what: "The same price in EUR, the platform currency, at the latest exchange rate. Click it to type the price in EUR instead: the table-currency rate follows (and the other way round). Hover to see the exchange rate used. Plain text on tables already in EUR.",
              },
              {
                name: "Best Buy / Best Vendor",
                what: "Customer tables: the cheapest current vendor rate for the destination in the same category, and which vendor trunk offers it.",
              },
              {
                name: "Margin / Margin %",
                what: "Sell rate minus best buy, and that as a % of the sell rate. Green when positive, red when negative. Recalculated live while you edit.",
              },
              {
                name: "Change",
                what: "How this version compares with the one before: NEW, SAME, ↑ +x% or ↓ −x%.",
              },
              {
                name: "Effective",
                what: 'When the rate started. In Current, a rate with a scheduled next rate shows "→ next rate from date". In Closed it shows the from – to dates.',
              },
              {
                name: "Hidden columns",
                what: "Change %, Until, Next Rate, Next From, Blocked, Negative margin, Dial Code, Rate Note, Updated By, Updated Time and Rate ID.",
              },
            ],
          },
          {
            kind: "text",
            text: "Rows that sell below best buy are tinted red. Vendor tables show a shorter set of columns (no best buy or margin). The status bar shows the table name, active rates and how many edits are unsaved.",
          },
        ],
      },
      {
        id: "editing",
        title: "Editing rates in the grid",
        blocks: [
          {
            kind: "steps",
            title: "Change one rate",
            items: [
              "Click the rate in the **Sell Rate** column.",
              "Type the new rate and press Enter (or click away). Esc cancels.",
              "The cell is highlighted and the bulk bar shows **1 unsaved**. Make more edits if you like.",
              "The batch is dated today 00:00 (platform time zone) unless you set another date with **From today 00:00** in the bulk bar; it applies from the moment you save.",
              "Click **Save n changes**.",
            ],
          },
          {
            kind: "text",
            text: "Select rows (checkboxes or Space) to open the **bulk bar** under the grid. Its actions only prepare edits; nothing is saved until you click **Save n changes**.",
          },
          {
            kind: "fields",
            title: "Bulk bar",
            fields: [
              {
                name: "Set rate",
                what: "Gives every selected rate the same rate.",
                values: "**New sell rate**: a number of 0 or more, e.g. `0.0125`. Then **Apply to selection**.",
              },
              {
                name: "Change by % / margin",
                what: "Changes the selected rates relative to what they are now.",
                values:
                  "**By %** (**Change %**, e.g. `5` raises by 5 %, `-3` lowers by 3 %); **By amount** (**Add (negative to lower)**, e.g. `0.001`); **Best buy + margin** (customer tables; **Margin over best buy** is an amount added to the best buy rate, e.g. `0.002`). Rates with no best buy, or that would go below zero, are skipped with a warning.",
              },
              {
                name: "Effective date…",
                what: "One start date for the whole batch.",
                values:
                  "**Effective from for this batch** (platform time zone, 24-hour), then **Set date**. **Today 00:00**, **Next 00:00** and **Now** fill it in one click. A past date is shown as the effective date but applies from the save (at most a year back). While the default today 00:00 is kept, an edited scheduled rate keeps its own later start date.",
              },
              {
                name: "Block",
                what: "Blocks the selected rates; if they are all blocked already, it unblocks them.",
              },
              {
                name: "Close rate",
                what: "Ends the selected rates on the batch date (or now) after you confirm. They move to Closed when saved. A scheduled rate that has not started yet is withdrawn and the version before it runs on.",
              },
              {
                name: "Bulk rating…",
                what: "Customer tables: opens [[bulk|Bulk rating]] in a new tab with this table and the selected destinations, to re-price them on other clients' tables too.",
              },
              { name: "Discard", what: "Throws away all unsaved edits." },
              {
                name: "Send RN to clients",
                what: "Customer tables: e-mail each client using the table the changed rates. Ticked by default.",
              },
              { name: "Save n changes", what: "Saves every unsaved edit as one change you can undo." },
            ],
          },
          {
            kind: "tip",
            text: "Edits stay when you switch view or filter, but the selection clears. A tab with unsaved edits is marked, so you are warned before closing it.",
          },
        ],
      },
      {
        id: "add-rates",
        title: "Add rates dialog",
        blocks: [
          {
            kind: "text",
            text: "**Add rates** gives a price to one or many destinations at once, one rate per chosen code. Use it for destinations the table does not have yet; for a destination that already has a rate, it creates a new version from the chosen date.",
          },
          {
            kind: "fields",
            fields: [
              {
                name: "Destinations",
                what: "Required. Pick countries and networks in the destination tree (see below).",
              },
              {
                name: "Rate (currency)",
                what: "Required. The price in the table's currency.",
                values: "A number of 0 or more with up to 4 decimals shown, e.g. `0.0350`.",
              },
              {
                name: "Sender ID",
                what: "Optional. Fill in only for a special price for one sender ID.",
                values: 'Up to 20 characters. Empty ("Any") = the normal price.',
              },
              {
                name: "Effective from",
                what: "When the new rates start, in the platform time zone (24-hour).",
                values:
                  "Default: today 00:00. **Now** = at once. A past date applies from the save; traffic already sent keeps its rate.",
              },
              { name: "Rate note", what: "Optional remark saved on the rates (up to 500 characters)." },
              {
                name: "Send RN to clients",
                what: "Customer tables only. Ticked by default: clients using the table get an e-mail with the new lines.",
              },
            ],
          },
          {
            kind: "steps",
            title: "How to add rates",
            items: [
              "Open the table and click **Add rates**.",
              "In the tree, search for a country or network and tick what you need.",
              "Enter the **Rate**, and if needed a **Sender ID**, **Effective from** date and **Rate note**.",
              "With **Send RN to clients** ticked, type an optional **Note on the RN**: it is added at the top of the e-mail each client gets.",
              "Click **Add n rates**. The toast says how many rates were added and how many clients got an RN; click Undo there to take it back.",
            ],
          },
        ],
      },
      {
        id: "tree",
        title: "The destination tree picker",
        blocks: [
          {
            kind: "text",
            text: "The same tree is used wherever you pick destinations for rating (Add rates, Bulk rating). It lists every country with its networks from the [[mccmnc|MCCMNC codes]] master.",
          },
          {
            kind: "list",
            items: [
              "**Search** (**Country, network or MCCMNC**): type a country name, ISO code (e.g. `DE`), MCC, network name or code. `%` matches any text and `_` any one character, e.g. `2620%`. When a country matches, all its networks are shown; otherwise only the matching networks.",
              "Tick a **country** to select all its (shown) networks. A half-filled box means only some are selected. The arrow opens the country to tick single networks.",
              "The country's **All networks** row (shown in grey) is the country-level fallback code.",
              "**Selected X of Y networks** counts what you picked. **Select all** / **Clear all** act on everything; while searching they become **Select shown** / **Clear shown** and act only on the search results.",
            ],
          },
        ],
      },
      {
        id: "new-table",
        title: "New rate table dialog",
        blocks: [
          {
            kind: "text",
            text: "**New rate table** creates a customer (sell) table. Vendor (buy) tables are created with their vendor trunk, one per trunk.",
          },
          {
            kind: "fields",
            fields: [
              {
                name: "Name",
                what: "Required. Up to 100 characters. Must be unique, also against deleted tables.",
                values: "e.g. `Acme Mobile OTP EUR`",
              },
              {
                name: "Product category",
                what: "Required. The traffic class the table prices. Best buy and margins compare against vendors of the same category.",
              },
              {
                name: "Currency",
                what: "Required. The currency of every rate in the table. Starts on the platform currency. Cannot be changed later.",
              },
              { name: "Description", what: "Optional, up to 500 characters." },
              {
                name: "Copy rates from a vendor trunk",
                what: "Tick to fill the new table from a vendor's current buy rates.",
              },
              {
                name: "Vendor trunk",
                what: "Shown when copying. The vendor trunk whose current rates are copied.",
              },
              {
                name: "Margin %",
                what: "Shown when copying. Added on top of each buy rate.",
                values:
                  "Default `10`, steps of 0.5. Each buy rate is converted to the table's currency and multiplied by (1 + Margin % / 100), e.g. buy 0.0100 with 10 → sell 0.0110.",
              },
            ],
          },
          {
            kind: "text",
            text: 'Copied rates start now, are marked New and get the note "Copied from vendor trunk …". The new table opens at once. To price clients with it, add it to their customer trunks (see [[customer-trunks|Customer trunks]]).',
          },
          {
            kind: "tip",
            text: "Margin % here is a mark-up on cost. A 10 % mark-up gives a margin of about 9.1 % of the sell rate in the grid's Margin % column.",
          },
        ],
      },
      {
        id: "rename-delete",
        title: "Rename and delete a table",
        blocks: [
          {
            kind: "steps",
            title: "Rename",
            items: [
              "Open the table, click **More (…)** and choose **Rename…**.",
              "Change **Name** (required, unique) and **Description**, then **Save**.",
            ],
          },
          {
            kind: "text",
            text: "**Delete table…** (or **Delete…** in the list's row menu) archives the table after showing what depends on it. It is blocked while any customer trunk still prices with the table: remove it from those trunks first. The rate history is kept. A deleted table shows a banner and cannot be edited; an administrator can restore it. See [[safe-delete]].",
          },
          {
            kind: "warning",
            text: "Vendor tables cannot be deleted here; they are archived together with their vendor trunk.",
          },
        ],
      },
      {
        id: "saving",
        title: "What happens when you save",
        blocks: [
          {
            kind: "list",
            items: [
              "Each new rate starts a new version from its effective date; the version before it ends at that moment. Versions that would start on or after that date are replaced.",
              'A rate equal to the current one is skipped ("Nothing changed").',
              "Blocks are applied first, then rate changes; a new version keeps the block of the rate it replaces.",
              "On customer tables, changes that start sooner than the clients' notice period for that kind stop the save and open **Changes sooner than the client's notice**: the table lists MCCMNC, Change (with the notice days), Now, New, From and Earliest with notice. Choose **Cancel** and set a later date, or **Apply anyway** (logged with the change).",
              "If someone else saved the same rates at the same moment, you are asked to reload, review and save again.",
              "Vendor rate changes update best buy and routing costs straight away.",
              "The whole batch is one change: the toast offers Undo, and it appears in **Change log**.",
              "On customer tables, **Save n changes** first shows a summary: counts of increases, decreases, closed and blocked rates, the effective date, the clients using the table and each rate with current → new and %. Untick **Send RN to clients** or type a **Note on the RN** there, then **Save n changes** (or **Back to editing**).",
            ],
          },
        ],
      },
      {
        id: "change-log",
        title: "Change log and history",
        blocks: [
          {
            kind: "text",
            text: 'The **Change log** view (or **History** in the header) lists every saved change on this table in plain words: who, when, any note, and each rate as "Country · Network (MCCMNC): old → new (+5 %) from 21 Oct 2026, 00:00", or New, Closed, Blocked, Scheduled rate withdrawn. Changes with more than 10 rates fold; click **Show the n rates**. **Technical (with undo)** shows the same changes field by field, where you can undo your own changes; undoing someone else\'s needs that permission. The **Closed** view shows the old versions themselves with their dates. See [[undo-and-history]].',
          },
        ],
      },
      {
        id: "tips",
        title: "Tips and things to watch",
        blocks: [
          {
            kind: "tip",
            text: "Use **Negative margin only** on a customer table to find every destination you sell below cost, then **Change by % / margin → Best buy + margin** to fix them in one batch.",
          },
          {
            kind: "tip",
            text: "For several clients or a large job, use [[bulk|Bulk rating]]: it previews the impact on last week's traffic before anything changes.",
          },
          {
            kind: "warning",
            text: "Rates never start in the past, and a saved rate never changes the price of traffic already sent.",
          },
          {
            kind: "tip",
            text: "Depending on your visibility settings, some rates may be hidden or masked; such rates cannot be changed by % or amount. See [[am-visibility]].",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ Incoming RNs
  {
    id: "incoming-rns",
    pageKey: "incoming-rns",
    title: "Incoming RNs",
    group: "Rates",
    summary:
      "Vendor rate notifications (RNs): each vendor rate sheet is read, compared with the current buy rates, checked against live traffic, then accepted or rejected with an automatic reply to the vendor.",
    keywords: [
      "rate notification",
      "RN",
      "vendor rates",
      "rate sheet",
      "price change",
      "upload rates",
      "accept",
      "reject",
      "back-dated",
      "notice breach",
      "live traffic",
      "auto upload",
      "rates mailbox",
    ],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "Vendors send their new prices as rate sheets, usually by e-mail to the rates mailbox. Each sheet becomes an **RN** (rate notification) for one vendor trunk. The rates team and NOC use this page to review RNs before the new buy rates are loaded, so that a price increase on a destination carrying traffic never slips through unnoticed.",
          },
          {
            kind: "text",
            text: "The page opens with the queue of RNs. Opening an RN shows its review screen in the same tab.",
          },
        ],
      },
      {
        id: "queue",
        title: "The RN queue",
        blocks: [
          {
            kind: "text",
            text: "Header buttons: **Add RN** (upload a sheet or simulate an e-mail) and **Settings**. Rows of flagged RNs that are due soon are highlighted. Tick several RNs and choose **Bulk edit › Accept n pending RNs** to accept them all at once (each RN is still its own change you can undo; the confirmation warns when some have live traffic flags or notice breaches).",
          },
          {
            kind: "fields",
            title: "Columns",
            fields: [
              { name: "Reference", what: "The RN's number. Click to open the review (Ctrl-click: new tab)." },
              { name: "Vendor", what: 'The vendor company. "not matched" (amber) when no trunk was found.' },
              { name: "Vendor Trunk", what: "The trunk whose buy table the RN updates." },
              { name: "Received", what: "When the e-mail arrived or the file was uploaded (UTC)." },
              {
                name: "Effective",
                what: "The earliest date stated in the sheet. Amber and bold when the RN is flagged, still pending and starts within the reminder days.",
              },
              { name: "Rates", what: "Number of destinations in the sheet." },
              {
                name: "Live Flags",
                what: "Rates that raise or close a destination carrying traffic (red when above 0).",
              },
              { name: "Notice", what: "Increases with less notice than agreed with the vendor (amber)." },
              { name: "Back-dated", what: "Rates whose stated date is before the RN arrived (amber)." },
              {
                name: "Status",
                what: "Pending review (amber), Accepted (green), Partly accepted (amber), Rejected (red), Failed (red: the file could not be read), Unmatched (amber: no vendor trunk found).",
              },
              { name: "Decided By", what: 'Who decided, or "auto" when it was accepted automatically.' },
              {
                name: "Hidden columns",
                what: "Increases, Decreases, New, Closed, Errors, Turn Negative, Due Soon, From, Subject, File, Auto-accepted, Decided At, and the source (E-mail or Upload).",
              },
            ],
          },
          {
            kind: "text",
            text: "The detail panel shows **Open review**, a **File** download of the original sheet, and the RN's vendor, received time and sender, subject, file, effective date, rate counts by change, flag counts and the decision.",
          },
        ],
      },
      {
        id: "add",
        title: "Add RN dialog",
        blocks: [
          {
            kind: "text",
            text: "RNs normally arrive by e-mail. **Add RN** lets you load one by hand, or simulate an incoming e-mail.",
          },
          {
            kind: "fields",
            fields: [
              {
                name: "Upload a file / Simulate an e-mail",
                what: "How the RN comes in.",
              },
              {
                name: "Rate sheet",
                what: "An Excel workbook (.xlsx, the first sheet is read) or CSV / semicolon / tab separated text, or paste from Excel.",
                values:
                  "Protected (locked) sheets are read as usual. A workbook that needs a password to open fails with a file error asking for an unlocked file.",
              },
              {
                name: "Header row",
                what: "The row with the column headers, e.g. `3` when the vendor puts a title and an account line above them.",
                values:
                  "Empty = found automatically: the first of the first 20 rows with a rate and a destination column.",
              },
              {
                name: "Vendor trunk",
                what: "Upload only. The trunk the sheet is for.",
                values:
                  "Empty = the platform finds the trunk from a username column in the file or from the file name. The trunk must already have a vendor rate table.",
              },
              { name: "From", what: "E-mail only. The sender's address, e.g. `rates@vendor.example`." },
              {
                name: "Subject",
                what: "E-mail only. The trunk's username (SMPP system ID) or name is looked for here.",
              },
              { name: "Body", what: "E-mail only. Also searched for the trunk." },
              {
                name: "Rate sheet",
                what: "Choose a CSV / TXT / TSV file, or paste the sheet into the box (e.g. straight from Excel).",
                values:
                  'Comma, semicolon or tab separated. Columns are found by their headers: MCCMNC (or MCC + MNC, or a dial code / prefix), Country, Network, Rate (or Price), Effective Date, Currency, Change / Status, Sender ID and Username. Dates like `2026-11-01`, `01/11/2026`, `01.11.2026` or `01-Nov-2026`. A change such as "closed" or "removed" closes the destination.',
              },
            ],
          },
          {
            kind: "text",
            text: "Click **Read and check**. The toast says how many RNs were created, auto-accepted, unmatched or failed, and the first one opens. One file with a username column for several trunks becomes one RN per trunk.",
          },
        ],
      },
      {
        id: "check",
        title: "How an RN is checked",
        blocks: [
          {
            kind: "list",
            items: [
              "Each rate is compared with the trunk's current rate: **New**, **Increase**, **Decrease**, **Unchanged** or **Closed** (destination removed). Closing a destination that was never priced counts as Unchanged.",
              "Unknown destinations, duplicates and unreadable rates are listed as file errors. A file with no usable rate is **Failed**.",
              "**Applied From** is the stated date, but never earlier than the time the RN was received. A rate with an earlier stated date is **Back-dated**, with the messages and cost sent in between at the old rate.",
              "**Notice breach**: an increase starting sooner than the notice agreed with that vendor.",
              "**Live traffic**: for every Increase or Closed rate the platform counts messages on that trunk and destination in the last hour, 24 hours and 7 days. If the count in the configured window reaches the minimum, the rate is flagged **Increase on live traffic** or **Closed on live traffic**.",
              "**Turns negative**: the margin at the new cost falls below zero.",
              "The clients sending that traffic, and the margin now and at the new cost, are shown on each rate.",
            ],
          },
          {
            kind: "text",
            text: "If auto-accept is on and the RN has no flagged rate, no notice breach, no file error and no back-dated rate that affected traffic already sent, it is accepted at once. Flagged RNs always wait for review. The column layout of the vendor's file is remembered for its next sheet.",
          },
        ],
      },
      {
        id: "review",
        title: "The review screen",
        blocks: [
          {
            kind: "fields",
            title: "Header actions (pending RNs)",
            fields: [
              { name: "← Incoming RNs", what: "Back to the queue." },
              { name: "Re-check", what: "Runs the check again against today's rates and traffic." },
              {
                name: "Reject…",
                what: "Rejects every pending rate. A reason is required; it goes in the Rejected reply to the vendor.",
              },
              {
                name: "Accept + reroute",
                what: "Accepts, then opens [[route-rules|Route rules]] filtered on this vendor trunk in a new tab, so you can move traffic to another vendor before the new rate starts.",
              },
              {
                name: "Accept + update customers",
                what: "Accepts, then opens [[bulk|Bulk rating]] with the client tables and destinations affected by the flagged rates.",
              },
              {
                name: "Accept all pending",
                what: "Accepts every pending rate. Back-dated rates apply from now and keep their stated date; traffic already sent keeps its cost.",
              },
              {
                name: "Re-rate back-dated traffic",
                what: "Shown when back-dated rates affected traffic already sent (see the setting). Off by default: nothing is re-rated (pending review). Ticked: accepting also creates a [[re-rating|re-rating request]] for those destinations from the stated date, which another user approves.",
              },
            ],
          },
          {
            kind: "text",
            text: "When the RN is **Unmatched**, a banner lets you **Assign to trunk…**; the rates are then read against that trunk's rates.",
          },
          {
            kind: "fields",
            title: "Summary cards",
            fields: [
              { name: "Rates", what: "Total rates and the count per change (up, down, new, closed, same)." },
              { name: "Live traffic flags", what: "Flagged rates (red), and how many turn negative." },
              { name: "Notice breaches", what: "Short-notice increases (amber), and the days required." },
              { name: "Back-dated", what: "Rates applied from receipt instead of their stated date (amber)." },
              { name: "File errors", what: "Rates that could not be read (red), and how the trunk was found." },
            ],
          },
          {
            kind: "fields",
            title: "Rate columns",
            fields: [
              { name: "Country / Network / MCCMNC", what: "The destination." },
              { name: "Change", what: "New, Increase, Decrease, Unchanged or Closed. Increase and Closed are amber." },
              {
                name: "Old Rate / New Rate",
                what: 'Current buy rate and the vendor\'s new rate ("closed" when removed).',
              },
              { name: "Change %", what: "The difference in %." },
              {
                name: "Stated Date / Applied From",
                what: "The vendor's date and the date that will really be used (amber when back-dated).",
              },
              { name: "Msgs 24h", what: "Messages on this trunk and destination in the last 24 hours." },
              { name: "Customers", what: "Clients whose traffic used this destination on this trunk." },
              {
                name: "Margin Now / Margin New",
                what: "Margin of that traffic now and at the new cost. Margin New is red when below zero.",
              },
              { name: "Decision", what: "Pending, Accepted (green) or Rejected (red; hover for the reason)." },
              {
                name: "Flags",
                what: "Chips: Increase / Closed on live traffic and Turns negative (red), Notice breach and Back-dated (amber).",
              },
              {
                name: "Hidden columns",
                what: "Sender ID, Notice Given, Live Flag, Notice Breach, Back-dated, Live Traffic, Msgs 1h, Msgs 7d, Turns Negative, Sent Between.",
              },
            ],
          },
          {
            kind: "text",
            text: "Flagged rates are on top. Rows are tinted red for live flags or negative margin, amber for notice breaches or back-dated rates. Select rates to get **Accept selected** and **Reject selected…**.",
          },
          {
            kind: "list",
            title: "Side panel",
            items: [
              "Clicking a rate shows its old → new rate, stated / applied dates, notice given versus required, traffic in 1 h / 24 h / 7 d, what was sent before receipt, the customers and any reject reason.",
              "**Replies (n)**: the replies to the vendor. Sent ones can be shown; a **draft** can be edited (subject and body) and sent with **Send reply**.",
              "**Log**: every step (received, checked, decided, replied) with user and time.",
              "**File (n)**: sender, subject, file name, the **Header row** used, a table of every column (letter, header in the file, read as), **Download the original file**, and the file errors row by row.",
            ],
          },
        ],
      },
      {
        id: "how-to",
        title: "How to review an RN",
        blocks: [
          {
            kind: "steps",
            items: [
              "Open the RN from the queue (sort or filter by **Live Flags** or **Status** to find urgent ones).",
              "Look at the flagged rates on top: the traffic, customers and margin impact.",
              "If a vendor raises a busy destination, choose **Accept + reroute** to move traffic, or **Accept + update customers** to re-price the affected clients.",
              "To refuse some rates, select them and choose **Reject selected…** with a reason; accept the rest with **Accept selected** or **Accept all pending**.",
              "Check the **Replies** tab: send any draft reply to the vendor.",
            ],
          },
        ],
      },
      {
        id: "accepting",
        title: "What accepting does",
        blocks: [
          {
            kind: "list",
            items: [
              "Accepted rates are loaded into the vendor trunk's buy table from their **Applied From** date (never earlier than now); closed rates are closed. This is one change you can undo.",
              "Rejected rates are not loaded.",
              "The status becomes Accepted, Partly accepted or Rejected once no rate is pending.",
              "The vendor gets a **Successful** or **Rejected** reply (a **Failed** reply goes out when the file could not be read). The reply states the date really applied when it differs from the sheet.",
              "Best buy, margins and routing costs follow the new buy rates.",
            ],
          },
          {
            kind: "warning",
            text: "A vendor RN never re-rates traffic already sent, even with a past date. See [[rates-basics#no-rerate|How rates work]].",
          },
        ],
      },
      {
        id: "settings",
        title: "Settings dialog",
        blocks: [
          {
            kind: "fields",
            title: "Defaults",
            fields: [
              {
                name: "Live traffic window",
                what: "Which traffic counts as live for the flags.",
                values: "Last hour, Last 24 hours or Last 7 days.",
              },
              { name: "Messages to count as live", what: "Minimum messages in the window. At least 1." },
              {
                name: "Back-dated: messages sent to need review",
                what: "A back-dated rate counts as affecting live traffic when at least this many messages were sent since its stated date. Only then is re-rating offered on accept, and the RN is never auto-accepted. Default 1.",
              },
              {
                name: "Due soon: days before the date",
                what: "A flagged, pending RN is marked due soon this many days before it starts (0–30).",
              },
              {
                name: "Auto-accept RNs with no flagged rate",
                what: "Accept automatically when there is no live increase or close, no notice breach and no file error.",
              },
              {
                name: "Successful / Failed / Rejected reply",
                what: "What happens with each kind of reply.",
                values: "Send automatically, Draft, confirm first (kept on the RN until you send it), or Don't send.",
              },
            ],
          },
          {
            kind: "fields",
            title: "Per vendor (choose a vendor)",
            fields: [
              { name: "Auto-accept", what: "Default, On, or Off (always review) for this vendor." },
              {
                name: "Agreed notice for increases (days)",
                what: "Notice the vendor must give for increases (0–365). Used for notice breaches.",
              },
              {
                name: "Replies",
                what: "Default, or This vendor's own modes (then set Successful, Failed and Rejected separately).",
              },
              {
                name: "Also reply to",
                what: "Extra addresses, comma separated. The RN's sender always gets the reply.",
              },
              {
                name: "Remembered columns",
                what: "How this vendor's file headers were read last time. **Forget** clears it so the next file is read fresh.",
              },
            ],
          },
          {
            kind: "text",
            text: "**Save defaults** saves the top part; **Save vendor settings** saves the vendor part.",
          },
          {
            kind: "tip",
            text: "In the trial, replies are written to the e-mail log and not really sent, and the rates mailbox is simulated with **Simulate an e-mail**.",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ Market moves
  {
    id: "market-moves",
    pageKey: "market-moves",
    title: "Market moves",
    group: "Rates",
    summary:
      "Destinations where several leading vendors changed their rates in the same direction, with the clients affected and a suggested new sell rate for each.",
    keywords: [
      "market",
      "vendor price changes",
      "rate movement",
      "trend",
      "suggested rate",
      "auto-apply",
      "digest",
      "account manager",
      "repricing",
    ],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "When the leading vendors for a destination all raise (or lower) their prices around the same time, the market has moved and our client prices may need to follow. This page lists those moves so account managers can update client rates, reroute, or decide to leave them. It opens showing **Open** moves only.",
          },
          {
            kind: "text",
            text: "The **Account manager** filter keeps moves for that AM's clients. Account managers only see moves for their own clients.",
          },
        ],
      },
      {
        id: "detection",
        title: "How a move is found",
        blocks: [
          {
            kind: "list",
            items: [
              "For each destination the platform keeps the **top vendors**: the cheapest N vendor trunks, plus Tier 1 vendors if set.",
              "It looks at their rate changes over the look-back period (from imports, accepted RNs and manual edits).",
              "When at least the minimum number of top vendors move in the same direction by at least the minimum %, with start dates within the window of each other, that is one move.",
              "A move is **Urgent** when it is an increase of at least the urgent % starting within the urgent days.",
              "Scans run every 15 minutes, soon after vendor rates change, and when you click **Scan now**. Snoozed moves reopen when the snooze ends; moves nobody acted on expire after the look-back period.",
            ],
          },
        ],
      },
      {
        id: "list",
        title: "Columns",
        blocks: [
          {
            kind: "fields",
            fields: [
              { name: "Country / Network / MCCMNC", what: "The destination." },
              { name: "Direction", what: "↑ Up or ↓ Down." },
              { name: "Avg Change", what: "Average change of the vendors that moved. Increases red, decreases green." },
              { name: "Moved", what: 'How many of the top vendors moved, e.g. "3 of 5".' },
              { name: "From", what: "The first new start date." },
              { name: "New Cost", what: "Market cost before → after." },
              { name: "Clients", what: "Client tables selling this destination." },
              { name: "Msgs 7d", what: "Messages to this destination in the last 7 days." },
              { name: "Urgent", what: "Red chip for urgent moves; open urgent rows are highlighted." },
              {
                name: "State",
                what: "Open (amber), Snoozed, Handled (green), Dismissed or Expired.",
              },
              { name: "Detected", what: "When the scan found the move." },
              { name: "Hidden columns", what: "Top Vendors, To (last start date), Handled By, Auto-applied." },
            ],
          },
        ],
      },
      {
        id: "detail",
        title: "The detail panel",
        blocks: [
          {
            kind: "text",
            text: '**Move** tab: the change, "x of y top vendors moved", the dates, market cost old → new, and actions: **Snooze…** (1, 7 or 30 days), **Dismiss…** (note required), **Mark handled** (note optional), **Reopen** (for a move that is not open) and **Add note** (note required). A chart shows the top vendors\' rates over the last 90 days: vendors that moved are solid rates, the cheapest ones that did not are dashed. The table lists each top vendor trunk with Tier, Old, New, Change (or "did not move"), From and a **Reroute…** link that opens the route rules using that vendor.',
          },
          {
            kind: "fields",
            title: "Affected clients tab",
            fields: [
              { name: "Table / Clients / AM", what: "The client's rate table, its clients and account manager." },
              { name: "Sell", what: "Today's sell rate in the table's currency." },
              {
                name: "Margin now / At new cost",
                what: "Margin today and at the new market cost (red when selling below the new cost).",
              },
              { name: "Msgs 7d", what: "The table's messages to the destination in 7 days." },
              { name: "Notice", what: "The client's rate notice period in days." },
              {
                name: "Suggested / From",
                what: "Suggested new sell rate and the earliest date with notice. The suggestion keeps the client's current margin over the new cost, or the target margin when that is higher.",
              },
              { name: "Auto-apply", what: "The auto-apply rule covering this client, if any." },
            ],
          },
          {
            kind: "text",
            text: "Tables whose suggestion differs from today's rate are ticked for you. **Log** tab: every action and note with user and time.",
          },
        ],
      },
      {
        id: "how-to",
        title: "How to update client rates after a move",
        blocks: [
          {
            kind: "steps",
            items: [
              "Select the move and open the **Affected clients** tab.",
              "Tick the client tables to update.",
              "Click **Update rates (n)**. [[bulk|Bulk rating]] opens with the suggested rates and dates filled in.",
              "Review, adjust any rate and click **Apply**. The move is marked handled automatically.",
            ],
          },
          {
            kind: "tip",
            text: "If some top vendors did not move, the card says so: rerouting to them keeps the old cost.",
          },
        ],
      },
      {
        id: "settings",
        title: "Settings dialog",
        blocks: [
          {
            kind: "fields",
            title: "Detection",
            fields: [
              {
                name: "Cheapest N vendors count",
                what: "How many of the cheapest vendor trunks per destination are top vendors.",
              },
              { name: "Tier 1 vendors count too", what: "Also treat Tier 1 vendors as top vendors." },
              { name: "Dates within (days)", what: "Start dates must fall within this many days of each other." },
              { name: "At least N vendors", what: "Minimum number of top vendors that must move." },
              { name: "Moving by at least (%)", what: "Minimum change per vendor." },
              { name: "Look back (days)", what: "How far back changes are read; moves older than this expire." },
              { name: "Urgent: increase ≥ (%)", what: "Increase size that makes a move urgent." },
              { name: "Urgent: starting within (days)", what: "…when it starts within this many days." },
              { name: "Target margin for suggestions (%)", what: "Minimum margin used for suggested rates." },
              {
                name: "Daily digest at (UTC hour)",
                what: "When each AM gets the e-mail digest of new moves for their clients.",
              },
            ],
          },
          {
            kind: "fields",
            title: "Auto-apply rules",
            fields: [
              { name: "Client", what: "The client the rule covers." },
              {
                name: "keep margin ≥ %",
                what: "When the margin at the new cost falls below this, the client's table is re-priced automatically, from the move's date or the client's notice, whichever is later. Each re-price is one undoable change.",
              },
              { name: "decreases too", what: "Also follow price decreases (otherwise increases only)." },
            ],
          },
          {
            kind: "text",
            text: "**Add rule** adds it; **Delete** removes one. **Send digest now** sends the digest at once; **Save** stores the detection settings for the next scan.",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ Bulk rating
  {
    id: "bulk",
    pageKey: "bulk",
    title: "Bulk rating",
    group: "Rates",
    summary:
      "Re-price several clients' rate tables for many destinations in one job: choose the scope and one action, review every rate with its impact on last week's traffic, then apply it as one undoable change.",
    keywords: [
      "bulk",
      "mass update",
      "reprice",
      "price increase",
      "change by percent",
      "cost plus margin",
      "formula",
      "impact",
      "multiple clients",
    ],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: 'Bulk rating changes customer (sell) rates across many tables at once, for example "raise Germany by 5 % for these ten clients" or "set every OTP table to best buy + 15 %". You see every affected rate and the money impact before anything changes. It opens from the [[rate-manager|Rate manager]] (selected tables or rates), from [[incoming-rns|Incoming RNs]] and from [[market-moves|Market moves]], already filled in.',
          },
          {
            kind: "text",
            text: "The scope stays in the tab's address, so the job can be reopened or shared as a link. Nothing changes until you apply.",
          },
        ],
      },
      {
        id: "scope",
        title: "Step 1 · Scope",
        blocks: [
          {
            kind: "fields",
            fields: [
              {
                name: "Clients' rate tables",
                what: "The customer tables to change. Remove one with ×; add with **Add a client's rate table…**, or click **Pick customer trunks…**, tick the trunks (search, **Select all shown**) and **Add their rate tables**: every client table those trunks use joins the scope. At least one is required.",
              },
              {
                name: "Destinations by MCCMNC",
                what: "Single networks (or country-level codes). Add with **Add an MCCMNC…**.",
              },
              {
                name: "Destinations by country (every network)",
                what: "Whole countries by ISO code. Add with **Add a country…**.",
              },
              {
                name: "Pick countries and networks…",
                what: "Opens the destination tree (see [[rate-manager#tree|the destination tree]]). Whole countries are added as countries, the rest as MCCMNC codes; **Add to scope** adds them.",
              },
              {
                name: "Paste a list",
                what: "Paste MCCMNC codes (3–6 digits) or country ISO codes (2 letters), one per line or separated by commas, spaces or semicolons. Anything else is listed as ignored.",
              },
            ],
          },
          {
            kind: "text",
            text: 'With no destinations, the job covers every destination the tables price. The line under the buttons shows the size, e.g. "3 tables × 2 MCCMNC + 1 countries = 140 rates". A job can hold up to 20,000 rates; narrow the scope if it is larger.',
          },
        ],
      },
      {
        id: "action",
        title: "Step 2 · Action",
        blocks: [
          {
            kind: "fields",
            fields: [
              {
                name: "Action",
                what: "What to do to every rate in scope.",
                values:
                  "**Set a fixed rate** (the default); **Change by %**; **Change by amount**; **Cost + margin %**; **Cost + amount**; **Close rates**; **Block rates**; **Unblock rates**; **Suggested rates only (market move)**. Opened from a market move, it starts on **Suggested rates only**.",
              },
              {
                name: "Value",
                what: "Its label follows the action: **New rate**, **Change % (negative lowers)**, **Add (negative lowers)**, **Margin % over cost** or **Amount over cost**.",
                values:
                  "e.g. `5` for +5 %, `-0.001` to lower by 0.001. Cost + margin % multiplies the cost by (1 + value / 100).",
              },
              {
                name: "Cost",
                what: "For Cost + actions: **Best vendor (best buy)** (cheapest vendor in the table's category) or **A chosen vendor trunk**.",
              },
              {
                name: "Vendor trunk",
                what: "The vendor whose current rate is the cost, when you chose a vendor trunk.",
              },
              { name: "Round to", what: "Decimals of the new rates: 2 to 6. Default 4." },
              {
                name: "Effective from",
                what: "When the new rates start, in the platform time zone. Default: today 00:00; **Now** = at once. A past date applies from the save; traffic already sent keeps its rate.",
              },
              {
                name: "Respect notice periods",
                what: "Ticked by default. Increases start when each client's notice period ends instead of on the chosen date.",
              },
              {
                name: "Also add destinations a table lacks",
                what: "For Set a fixed rate and Cost + actions: add a new rate where a table has no rate yet. Off = only change existing rates.",
              },
            ],
          },
          {
            kind: "text",
            text: "Click **Preview**. Rates the action cannot price (no current rate for a % change, no cost for Cost +) are shown with a note and skipped.",
          },
        ],
      },
      {
        id: "impact",
        title: "Step 4 · Impact cards",
        blocks: [
          {
            kind: "fields",
            fields: [
              { name: "To apply", what: "Rates that will change, split into up, down, new, closed and (un)blocked." },
              {
                name: "Below cost",
                what: "Rates whose new rate is under the cost (red), plus unchanged and excluded counts.",
              },
              {
                name: "Notice breaches",
                what: "Increases sooner than the client's notice (amber), and how many were moved to the notice date.",
              },
              {
                name: "Revenue change (7 days)",
                what: "What last week's traffic would bring in more or less at the new rates, in the platform currency.",
              },
              { name: "Margin change (7 days)", what: "The same for margin. Green when it goes up, red when down." },
            ],
          },
          {
            kind: "text",
            text: "The cards update as you edit or exclude rows. Traffic figures cover normal rates only (not sender-ID rates).",
          },
        ],
      },
      {
        id: "review",
        title: "Step 3 · Review grid",
        blocks: [
          {
            kind: "list",
            title: "Toolbar",
            items: [
              "**All / Changing / Flagged / Excluded / Edited**: quick views with counts. Flagged = below cost or notice breach.",
              "Search box: table, client, country, network, MCCMNC, sender ID or vendor.",
              "Formula box (`=cost*1.15`) and **Fill shown rows**: writes a rate or formula into every row currently shown.",
              "**Exclude below cost**, **Exclude notice breaches** and **Reset edits** (undo all typed rates and exclusions).",
            ],
          },
          {
            kind: "fields",
            title: "Columns",
            fields: [
              {
                name: "(tick box)",
                what: "Untick to exclude the row; the header box acts on all shown rows. Excluded rows are faded.",
              },
              { name: "Table / Clients", what: "The rate table and its clients." },
              { name: "Country / Network / MCCMNC / Sender ID", what: "The rate's destination." },
              { name: "Current", what: "Today's rate." },
              {
                name: "New rate",
                what: "The rate that will be applied. Type over it: a number, or a formula with `cost` and `rate` (the current rate), e.g. `=cost*1.15`, `=rate+0.002`, `=(cost+0.001)*1.1`. Enter keeps it, Esc undoes, empty goes back to the computed rate. Typed cells are highlighted.",
              },
              { name: "Change", what: "Change in % (amber for increases), or New, Same, Close, Block, Unblock, Skip." },
              { name: "Cost / Cost vendor", what: "The cost used and which vendor trunk it comes from." },
              { name: "Margin now / Margin new", what: "Margin % today and at the new rate (red when below cost)." },
              { name: "From", what: '"Now" or the start date; amber when moved to the end of the notice period.' },
              {
                name: "Msgs 7d / Revenue Δ 7d",
                what: "Last week's messages and the revenue difference for this rate.",
              },
              { name: "Note", what: 'Why a row is skipped or flagged, e.g. "sells below cost" or "no cost".' },
            ],
          },
          {
            kind: "text",
            text: "Rows below cost are tinted red; notice breaches amber.",
          },
        ],
      },
      {
        id: "apply",
        title: "Step 5 · Apply",
        blocks: [
          {
            kind: "steps",
            items: [
              "Click **Apply n changes** in the header.",
              "In **Apply n changes?** add an optional **Note** (shown in History) and keep or untick **Send RN to clients**.",
              "Click **Apply**. All tables change together as one change, undone as one.",
              "If **Respect notice periods** was off and some increases start too soon, **Changes sooner than the client's notice** opens: **Apply anyway** (logged) or cancel, tick **Respect notice periods** and preview again.",
            ],
          },
          {
            kind: "text",
            text: "New rates open new versions; traffic already sent keeps its rate. When the job came from a market move, a banner explains it and the move is marked handled after applying.",
          },
        ],
      },
      {
        id: "tips",
        title: "Tips and things to watch",
        blocks: [
          {
            kind: "tip",
            text: "Use **Flagged** and **Exclude below cost** before applying, so no client is priced under cost by accident.",
          },
          {
            kind: "warning",
            text: "Cost + actions price customer tables only. Vendor tables cannot be in a bulk rating job.",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ Product categories
  {
    id: "categories",
    pageKey: "categories",
    title: "Product categories",
    group: "Rates",
    summary: "The traffic classes (such as DIRECT, HQ and OTP) that trunks, rate tables and rules belong to.",
    keywords: ["product category", "traffic class", "DIRECT", "HQ", "OTP", "quality class"],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "A product category is a class of traffic, for example DIRECT, HQ or OTP. Every trunk and rate table has one. Best buy and margins compare a client's rates only with vendors of the same category. Admins and the rates team maintain the list.",
          },
        ],
      },
      {
        id: "layout",
        title: "What you see",
        blocks: [
          {
            kind: "fields",
            title: "Columns",
            fields: [
              { name: "Info ID", what: "The category's number." },
              { name: "Category Name", what: "The name shown everywhere." },
              { name: "Customer trunks / Vendor trunks / Rate tables", what: "How many use the category." },
              { name: "Updated By", what: "Who changed it last (hidden: Updated Time, Deleted)." },
            ],
          },
          {
            kind: "text",
            text: "The detail panel repeats the counts and has **Edit** and **Delete** (or **Restore** for administrators on a deleted category).",
          },
        ],
      },
      {
        id: "fields",
        title: "Fields",
        blocks: [
          {
            kind: "fields",
            fields: [
              {
                name: "Category Name",
                what: "Required, up to 40 characters, unique.",
                values: "e.g. `OTP`",
              },
            ],
          },
        ],
      },
      {
        id: "how-to",
        title: "How to add, rename or delete",
        blocks: [
          {
            kind: "steps",
            items: [
              "**Add category**, enter the name and click **Add category**.",
              "To rename, double-click the row (or **Edit**), change the name and **Save**. Everything using the category shows the new name.",
              "To delete, select it and click **Delete**. The dependencies are shown first.",
            ],
          },
          {
            kind: "warning",
            text: "A category cannot be deleted while trunks, rate tables or rules use it. Deleting archives it; filter on **Deleted** to see deleted ones. See [[safe-delete]].",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ Countries
  {
    id: "countries",
    pageKey: "countries",
    title: "Countries",
    group: "Rates",
    summary:
      "The country list: name, ISO code, international dial code and region, with the MCCMNC codes of each country.",
    keywords: ["country", "ISO", "dial code", "country code", "region"],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "Countries hold the MCCMNC codes and are used in destination names, pickers and reports. The **Region** groups countries in the destination picker. Countries can be added and changed but not deleted.",
          },
        ],
      },
      {
        id: "layout",
        title: "What you see",
        blocks: [
          {
            kind: "fields",
            title: "Columns",
            fields: [
              { name: "Info ID", what: "The country's number." },
              { name: "Name", what: "Country name." },
              { name: "ISO Code", what: "Two-letter code, e.g. `DE`." },
              { name: "Dial Code", what: "International calling code, shown as `+49`." },
              { name: "Region", what: "The region group, e.g. Europe." },
              { name: "MCCMNC codes", what: "How many destination codes the country has." },
              { name: "Updated By", what: "Who changed it last." },
            ],
          },
          {
            kind: "text",
            text: "In the detail panel, the **n codes** link opens [[mccmnc|MCCMNC codes]] filtered to that country in a new tab. **Export** downloads the filtered list as CSV.",
          },
        ],
      },
      {
        id: "fields",
        title: "Fields",
        blocks: [
          {
            kind: "fields",
            fields: [
              { name: "Name", what: "Required, up to 80 characters." },
              { name: "ISO", what: "Required, 2 letters (made upper case).", values: "e.g. `DE`" },
              { name: "Dial Code", what: "Required, up to 4 digits, without +.", values: "e.g. `49`" },
              { name: "Region", what: "Required. Pick from the list; used in the destination picker." },
            ],
          },
          {
            kind: "steps",
            title: "How to add or edit",
            items: [
              "Click **Add country**, or double-click a row to edit.",
              "Fill in the fields and click **Add country** / **Save**.",
            ],
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ MCCMNC codes
  {
    id: "mccmnc",
    pageKey: "mccmnc",
    title: "MCCMNC codes",
    group: "Rates",
    summary:
      "The destination master list: every mobile network code (MCC + MNC) with its country and name. It is the key for rating, routing and reports.",
    keywords: [
      "MCCMNC",
      "MCC",
      "MNC",
      "destination",
      "network",
      "operator",
      "all networks",
      "DLR target",
      "master list",
    ],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "An **MCCMNC** code identifies a mobile network: the **MCC** (Mobile Country Code, 3 digits) plus the **MNC** (Mobile Network Code, 2–3 digits), e.g. `262` + `01` = `26201`. Rates, route rules, dial codes and reports all point at these codes, and every destination picker shows the names from here.",
          },
          {
            kind: "text",
            text: "Each country also has an **All networks** code: the MCC alone (e.g. `262`). It is the fallback price and route for any network of the country without its own rate.",
          },
        ],
      },
      {
        id: "layout",
        title: "What you see",
        blocks: [
          {
            kind: "text",
            text: "Header: **Add code** (main button), **Import** and **Export** (the filtered list as CSV).",
          },
          {
            kind: "fields",
            title: "Columns",
            fields: [
              { name: "MCC / MNC", what: "The two parts of the code. MNC is empty for the All networks code." },
              { name: "Original MNC", what: "The MNC as the operator publishes it, if different." },
              { name: "MCCMNC", what: "The full code." },
              { name: "ISO / Country / Country Code", what: "The country, its ISO code and dial code." },
              { name: "Network", what: 'The network name, or "All networks" for the country code.' },
              { name: "All networks", what: "Yes for the country-level code." },
              {
                name: "DLR target",
                what: "The expected delivery-receipt (DLR) success rate for the destination. Route rule DLR figures turn amber below it. Click to change.",
              },
            ],
          },
        ],
      },
      {
        id: "fields",
        title: "Fields in the code form",
        blocks: [
          {
            kind: "fields",
            fields: [
              { name: "MCC", what: "Required, 3 digits.", values: "e.g. `262`" },
              { name: "MNC", what: "Empty = the country's All networks code.", values: "e.g. `01`" },
              { name: "Original MNC", what: "Optional, as the operator publishes it (up to 10 characters)." },
              { name: "MCCMNC", what: "Read only: the code MCC + MNC make." },
              { name: "Country", what: "Required. Search by name." },
              {
                name: "Code Network",
                what: "Required when an MNC is given. The network name (up to 120 characters).",
              },
            ],
          },
          {
            kind: "warning",
            text: "The MCC and MNC of a code in use (by rates, rules, dial codes or MO numbers) cannot change; add a new code instead.",
          },
        ],
      },
      {
        id: "dlr-target",
        title: "How to set a DLR target",
        blocks: [
          {
            kind: "steps",
            items: [
              "Click the value in the **DLR target** column.",
              "Type a % between 0 and 100 and press Enter. Leave it empty to remove the target. Esc cancels.",
            ],
          },
          {
            kind: "text",
            text: 'A target on the All networks code covers every network of that country that has no target of its own (shown as "country\'s").',
          },
        ],
      },
      {
        id: "import",
        title: "How to import codes",
        blocks: [
          {
            kind: "steps",
            items: [
              "Click **Import** and **Choose CSV file…** (use **Download template** for the layout).",
              "Columns: `mcc`, `mnc` (empty = All networks), `original_mnc`, `country` (name, or `iso`) and `network`. Codes are matched by MCC + MNC.",
              "Choose **Add and update** (rows not in the file stay) or **Replace** (codes missing from the file are archived, except codes still in use, which are kept and listed).",
              "The file is checked first: the report shows Rows, Add, Change, Unchanged and Archive, plus Errors, Kept because still in use and Remarks.",
              "Click **Import**. It is saved as one change you can undo.",
            ],
          },
          {
            kind: "warning",
            text: "Nothing is imported while any row has an error. Fix the file and choose it again.",
          },
        ],
      },
      {
        id: "delete",
        title: "Deleting a code",
        blocks: [
          {
            kind: "text",
            text: "**Delete** archives the code. It is blocked while rates, rules, dial codes or MO numbers use it. Administrators can restore a deleted code. See [[safe-delete]].",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ Master table
  {
    id: "master-table",
    pageKey: "master-table",
    title: "Master table",
    group: "Rates",
    summary:
      "Dial-code profiles: sets of number prefixes mapped to MCCMNC codes, used to find the network of a phone number.",
    keywords: ["dial code", "prefix", "number plan", "profile", "master data", "numbering"],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "The master table maps **dial codes** (number prefixes such as `4915`) to MCCMNC codes, so the platform can tell which network a phone number belongs to. The longest matching prefix wins. Dial codes are grouped in **profiles**; the **All** profile is the default used to resolve numbers (for example in [[rate-lookup|Rate lookup]] and route tests). It cannot be renamed or deleted.",
          },
        ],
      },
      {
        id: "profiles",
        title: "The profile list",
        blocks: [
          {
            kind: "fields",
            title: "Columns",
            fields: [
              { name: "Profile", what: 'The profile\'s name ("· default" for All).' },
              { name: "Dial codes", what: "How many prefixes it holds." },
              { name: "MCCMNC codes", what: "How many destinations they point at." },
              { name: "Updated By / Updated", what: "Last change." },
            ],
          },
          {
            kind: "fields",
            title: "Add / rename profile",
            fields: [
              { name: "Profile", what: "Required, up to 40 characters." },
              {
                name: "Copy dial codes from",
                what: "New profiles only. Optional: start with another profile's prefixes; empty = start empty.",
              },
            ],
          },
          {
            kind: "text",
            text: "Double-click a profile, or **Open dial codes** in the detail panel, to see its prefixes in the same tab.",
          },
        ],
      },
      {
        id: "codes",
        title: "A profile's dial codes",
        blocks: [
          {
            kind: "text",
            text: "Header: **Add dial code**, **All profiles** (back), **Import**, **Delete profile** (not for All) and Export. Columns: **Dial Code**, **MCCMNC**, **Country**, **Network**. Tick rows to **Delete n dial codes** at once.",
          },
          {
            kind: "fields",
            title: "Dial code form",
            fields: [
              {
                name: "Dial Code",
                what: "Required. Digits only, up to 16; a leading + is removed.",
                values: "e.g. `4915`",
              },
              {
                name: "MCCMNC",
                what: "Required. The destination the prefix belongs to; search by country, network or code.",
              },
            ],
          },
          {
            kind: "tip",
            text: "A filter like `4475%` on the Dial Code column finds a whole range of prefixes.",
          },
        ],
      },
      {
        id: "import",
        title: "How to import dial codes",
        blocks: [
          {
            kind: "steps",
            items: [
              "Open the profile and click **Import** (Master Data Import).",
              "Choose a CSV with columns `prefix` (digits) and `mccmnc` (a live code).",
              "Choose **Add and update** (a prefix already in the profile is updated, a new one added) or **Replace** (prefixes missing from the file are archived).",
              "Check the report and click **Import**. It is one change you can undo.",
            ],
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ MO reference book
  {
    id: "mo-book",
    pageKey: "mo-book",
    title: "MO reference book",
    group: "Rates",
    summary:
      "Two-way and MO (mobile-originated) billing numbers: the long numbers and short codes a client receives replies on, with what we charge and pay for them.",
    keywords: ["MO", "mobile originated", "two-way", "long number", "short code", "keyword", "inbound SMS"],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "**MO** (mobile-originated) traffic is SMS sent by phone users to a number, for example replies to a two-way campaign. Each entry here is a long number or short code (optionally with a keyword) that a customer trunk receives MO traffic on, with the rate charged to the client, the vendor rate, and any setup or fixed charge. All amounts are in the customer trunk's currency. Billing uses it to charge MO traffic.",
          },
        ],
      },
      {
        id: "layout",
        title: "What you see",
        blocks: [
          {
            kind: "text",
            text: 'Header: **Add MO number** (main button), **Import** and **Export**. Columns: Info ID, Customer Trunk, Number, Keyword ("any" when empty), Rate, Vendor Rate, Currency, MCCMNC, Destination, Setup Charge, Fix Charge, Created Time and Created By. The detail panel shows the amounts with currency and **Edit** / **Delete** (**Restore** for administrators).',
          },
        ],
      },
      {
        id: "fields",
        title: "Fields",
        blocks: [
          {
            kind: "fields",
            fields: [
              {
                name: "Customer Trunk",
                what: "Required. The client trunk that receives the MO traffic. Sets the currency.",
              },
              {
                name: "Number",
                what: "Required. Long number (digits) or short code, up to 21 characters; a leading + is removed.",
                values: "e.g. `491701234567` or `12345`",
              },
              { name: "Keyword", what: "Optional. Empty = any message to the number.", values: "e.g. `INFO`" },
              { name: "Rate", what: "Required. Charged to the client per message (0 or more)." },
              { name: "Vendor Rate", what: "Optional. Paid to the vendor per message." },
              { name: "Currency", what: "Read only: the customer trunk's currency." },
              { name: "MCCMNC", what: "Optional. The destination of the number." },
              { name: "Setup Charge", what: "One-off charge. Default 0." },
              { name: "Fix Charge", what: "Charge per billing cycle. Default 0." },
            ],
          },
          {
            kind: "text",
            text: "Number + keyword must be unique.",
          },
        ],
      },
      {
        id: "import",
        title: "How to import",
        blocks: [
          {
            kind: "steps",
            items: [
              "Click **Import** and choose a CSV (use **Download template**).",
              "Columns: `customer_trunk` (name), `number`, `keyword`, `rate`, `vendor_rate`, `mccmnc`, `setup_charge`, `fix_charge`. An optional `currency` column must match the trunk's currency.",
              "Rows are matched by number + keyword. **Add and update** keeps rows not in the file; **Replace** archives entries missing from the file (MO traffic already billed keeps its charges).",
              "Check the report and click **Import** (one undoable change).",
            ],
          },
        ],
      },
    ],
  },
];
