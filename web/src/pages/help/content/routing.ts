// Help center: Routing (§6.3, §9.2, §13.8–13.11, §13.16, §13.23, §13.24, §13.27, §15.4).
import type { HelpTopic } from "../helpTypes";

export const topics: HelpTopic[] = [
  // ------------------------------------------------------------------ concept: how routing works
  {
    id: "routing-basics",
    title: "How routing works",
    group: "Routing",
    summary:
      "How a message is matched to a route rule, how the rule picks a vendor, and what the Test and the Simulator show.",
    keywords: [
      "routing",
      "route rule",
      "priority",
      "vendor selection",
      "failover",
      "backup vendor",
      "LCR",
      "least cost",
      "QBR",
      "quality",
      "margin",
      "hunt policy",
      "continue routing",
    ],
    sections: [
      {
        id: "overview",
        title: "The short version",
        blocks: [
          {
            kind: "text",
            text: "Every message a customer sends is checked against the route rules, one rule at a time, in **priority** order. The first rule whose conditions match decides what happens: it either blocks the message or picks a vendor trunk to send it to. Rules are set up on [[route-rules|Route rules]].",
          },
          {
            kind: "steps",
            title: "What happens to one message",
            items: [
              "The customer trunk's translation rules run first (they may change the sender or receiver, or block the message). See [[translation-rules|Translation rules]].",
              "The destination is found from the receiver number (the longest matching dial code gives the MCCMNC, the mobile network code). An HLR lookup can replace it with the real network of a ported number.",
              "The customer rate for that destination is found on the trunk's rate tables. No rate means the message is rejected.",
              "The route rules are tried in order: highest priority number first (100 before 1), then lowest rule ID.",
              "The first rule that matches picks the vendor (or blocks). If it finds no usable vendor, its **Continue routing** setting says whether to try more rules.",
            ],
          },
        ],
      },
      {
        id: "matching",
        title: "How a rule is matched",
        blocks: [
          {
            kind: "list",
            items: [
              "**Priority** is a number from 1 to 100. High numbers are tried first (100 before 1). Two rules with the same priority are tried in rule ID order.",
              "A rule must be **on** and inside its **Time** window (start and stop, in UTC). A rule that is off or outside its time never matches.",
              "Each condition is one chip on the rule (Trunk, Category, Destination, Sender, Receiver, Content, TPS, Revenue/msg, HLR ported). Conditions the rule does not set are ignored.",
              "**all must match** (the default): every condition must pass. **any one matches**: one passing condition is enough. Click the words next to the rule title to switch.",
              "A rule with no conditions at all matches every message. That is why a new rule starts off.",
              "Sender conditions match the exact capitals unless the rule's **Case sensitive** box is cleared (then any case matches). Receiver, content and the MCCMNC pattern ignore upper and lower case.",
              "A destination list matches exact codes only. A 3-digit code is the country's All networks entry, not the whole country. To cover a whole country, tick all its networks, or use **All**.",
            ],
          },
          {
            kind: "fields",
            title: "Continue routing",
            fields: [
              {
                name: "STOP – end here",
                what: "The default. The first matching rule decides. If it finds no usable vendor, the message is rejected.",
              },
              {
                name: "YES – keep evaluating",
                what: "If this rule matches but no vendor qualifies, the next rules in priority order are tried.",
              },
              {
                name: "NEXT – jump to group",
                what: "If this rule matches but no vendor qualifies, only the rules of the chosen **Next group** are tried after it.",
              },
            ],
          },
        ],
      },
      {
        id: "route-types",
        title: "Route types",
        blocks: [
          {
            kind: "fields",
            fields: [
              {
                name: "Static",
                what: "A fixed list of vendor trunks, arranged in levels. The hunt policy decides the order inside a level.",
                values: "Grey dot in the grid.",
              },
              {
                name: "Least cost",
                what: "Also called LCR (least cost routing). Every vendor trunk in the rule's scope that has a rate for the destination is ranked, cheapest first. An LCR profile can filter and order them further.",
                values: "Blue (accent) dot.",
              },
              {
                name: "Quality",
                what: "Also called QBR (quality based routing). Vendors are ranked by a quality score made from ASR, DLR, delivery delay and cost.",
                values: "Green dot.",
              },
              {
                name: "Block",
                what: "Matching messages are rejected. No vendor is used.",
                values: "Red dot.",
              },
            ],
          },
        ],
      },
      {
        id: "vendor-order",
        title: "How the vendor is chosen",
        blocks: [
          {
            kind: "text",
            text: "Once a rule matches, the vendor is picked in this fixed order. The Test and the Simulator show which step decided.",
          },
          {
            kind: "steps",
            items: [
              "**Number whitelist**: if the receiver is on one of the rule's whitelists, the message goes to that whitelist's vendor, whatever the split.",
              "**Warm-up**: if a vendor has a warm-up count (for example the first 500 messages a day) and it has not been reached yet, the message goes to that vendor.",
              "**The normal choice**: the static levels and hunt policy, the least cost ranking, or the quality ranking.",
            ],
          },
          {
            kind: "fields",
            title: "Hunt policy (static rules)",
            fields: [
              {
                name: "Top down (by level)",
                what: "Vendors are tried in the order they are listed on each level.",
              },
              {
                name: "Round robin",
                what: "Traffic is spread evenly over the vendors of a level, in turn.",
              },
              {
                name: "Percentage split",
                what: "Each vendor on a level gets its **Share %** of the traffic. The shares of each level must add up to 100. With **Split per customer trunk** on (the default), every customer trunk's own traffic follows the shares; off, the shares apply to the rule's total traffic. The same receiver number always lands on the same vendor.",
              },
            ],
          },
        ],
      },
      {
        id: "failover",
        title: "Levels, backups and failover",
        blocks: [
          {
            kind: "text",
            text: "A static rule can have up to 10 levels (**Max route level**). Level 1 is used first. When a vendor cannot take a message, the system fails over in this order:",
          },
          {
            kind: "steps",
            items: [
              "The vendor's own **backups** (set with the Backup tick on its row). With several backups, the vendor's traffic is split between them by their share %.",
              "The other vendors of the same level, in the order of the hunt policy.",
              "The vendors of the next level, and so on up to the last level.",
              "Older rules may have rule-wide backups marked **last resort**: they are tried after every level.",
            ],
          },
          {
            kind: "text",
            text: "A vendor is skipped when it leaves less than the rule's **Minimum margin**, or (in the live switch) when it is down, rejects the message or is at its capacity limit.",
          },
          {
            kind: "tip",
            text: "In the trial there is no live SMPP traffic, so the Test and the Simulator only fail over on margin: a vendor is skipped when its margin is below the minimum.",
          },
        ],
      },
      {
        id: "lcr-qbr",
        title: "Least cost and quality ranking",
        blocks: [
          {
            kind: "list",
            items: [
              "The pool is every vendor trunk in the rule's scope (**Vendor categories** and **Vendor trunks**) that has a rate for the destination. If the rule lists vendors in its table, only those are used.",
              "**Least cost** without a profile: the cheapest vendors in the pool, up to 10, in cost order.",
              "**Least cost** with an **LCR profile**: the profile leaves out vendors (tier, minimum ASR or DLR, maximum delay, maximum cost, at TPS limit), orders the rest by cost or by a quality-weighted score, uses the first N, and can split traffic between them by percentage. See [[lcr|LCR]].",
              "**Quality**: each vendor gets a score from ASR (35 %), DLR (35 %), delay (20 %) and cost (10 %). These are the defaults; a rule can set its own weights, which must add up to 100. Delay scores best at 0 seconds and worst at 60 seconds; the cheapest vendor gets the best cost score. A missing figure counts as average. Equal scores go to the cheaper vendor.",
              "A Quality rule with vendors listed in its table ranks the vendors of each level by quality, then fails over level by level like a static rule.",
              "Vendors below the minimum margin are skipped; the next one in the ranking is used.",
            ],
          },
        ],
      },
      {
        id: "margin",
        title: "Minimum margin",
        blocks: [
          {
            kind: "text",
            text: "Margin is the customer's sell rate minus the vendor's cost, per message, in the platform currency. The rule's **Minimum margin** is typed in one box:",
          },
          {
            kind: "list",
            items: [
              "`0.002` is an amount: the vendor must leave at least 0.002 per message.",
              "`5%` is a percentage of the sell rate: the vendor must leave at least 5 % of what the customer pays.",
              "A minus sign makes either negative, for example `-0.001` or `-2%`. This allows a small loss, for example to keep a key route running.",
              "`0` (the default) means the vendor must not cost more than the sell rate.",
            ],
          },
          {
            kind: "tip",
            text: "A vendor without a known cost or a message without a known sell rate is not held back by the margin check.",
          },
        ],
      },
      {
        id: "hlr",
        title: "HLR and routing",
        blocks: [
          {
            kind: "list",
            items: [
              "HLR (home location register) lookup asks which network a number really belongs to, so ported numbers are routed to their real network.",
              "HLR can be switched on for a whole customer trunk (on the trunk's rules), or from a route rule with the **HLR action** condition: \"do HLR with policy X\" for all or some of the rule's customer trunks. The route rule setting wins over the trunk setting.",
              "Which providers are asked per destination is set in HLR policies, under [[hlr|HLR]].",
              "The **HLR ported** condition matches only ported numbers, or only numbers that are not ported.",
            ],
          },
        ],
      },
      {
        id: "testing",
        title: "Testing before you go live",
        blocks: [
          {
            kind: "list",
            items: [
              "**Test** tab on a rule: runs a sample message through that one rule and shows every condition with a tick or a cross, then the vendors tried with their cost and margin.",
              "**Simulate** button on Route rules: runs a sample message through all rules in priority order and shows which rules were tried, which one decided, and the vendor.",
              "[[simulator|Simulator]] page: the full path of a message on a customer trunk, including translation rules, the customer rate, the route and the margin. It can also send a simulated test SMS.",
              "[[route-map|Route map]]: today's rule and vendor for every destination a customer trunk sells.",
            ],
          },
          {
            kind: "tip",
            text: "Nothing in the Test, Simulate or Simulator sends a real message or writes an EDR (the record of a sent message).",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ Route rules
  {
    id: "route-rules",
    pageKey: "route-rules",
    title: "Route rules",
    group: "Routing",
    summary:
      "Decide which vendor gets each message: rules match on trunk, destination, sender, content, TPS, revenue and more, then send to a vendor split, least cost or quality ranking, or block.",
    keywords: [
      "routing",
      "route rule",
      "vendor selection",
      "conditions",
      "vendor split",
      "share",
      "backup vendor",
      "minimum margin",
      "warm-up",
      "whitelist",
      "TPS routing",
      "revenue routing",
      "bulk edit",
      "replace vendor",
      "priority",
      "routerule",
      "undo",
    ],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "Route rules decide where customer traffic goes. Each rule has conditions (which messages it is for) and vendors (where they go). The NOC and routing team use this page every day to add routes, move traffic between vendors, react to quality problems and check how much traffic each rule carries. Account managers use it to see how their clients are routed.",
          },
          {
            kind: "text",
            text: "For the logic behind matching and vendor choice, read [[routing-basics|How routing works]] first.",
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
              "**Page header**: links to the other routing pages (Route map, LCR, Re-rating, Rate lookup, Simulator) and the actions **Undo**, **History**, **Export**, **Cleanup** (only when there are findings), **Simulate** and the blue **New rule** button.",
              '**Filter row**: the active filter chips, **Add filter** (the filter builder), **Quick search**, **Clear all**, **Save as view**, **Views**, and on the right the selection summary (for example "2 selected · 28.2k msgs"), **Bulk edit** and the columns menu.',
              "**Grid**: one row per rule, sorted by priority then ID, with a filter box under every column header. See [[grids-and-filters]].",
              "**Detail panel**: opens when you click a rule. On the left the sections **Conditions**, **Vendors**, **Traffic**, **History** and **Test**; on the right the **Traffic 24h** trend line with Messages and Margin for the last 24 hours.",
              "**Status bar**: row counts and the shortcuts ↑↓ move · Space select · E edit · D duplicate · Ctrl+Z undo.",
            ],
          },
          {
            kind: "fields",
            title: "Header actions",
            fields: [
              {
                name: "Undo",
                what: "Undoes your last change on this page (same as Ctrl+Z). See [[undo-and-history]].",
              },
              {
                name: "History",
                what: "Opens a side drawer with every change to route rules, newest first, each with its own Undo.",
              },
              {
                name: "Export",
                what: "Downloads the rows that match the current filters as a CSV file (ID, rule, priority, type, category, customer trunks, destination, vendors, messages, ASR, DLR, margin, status, start and stop time). Up to 100,000 rows.",
              },
              {
                name: "Cleanup",
                what: "Shows how many open findings the Cleanup Center has for route rules: unused, expired, identical, near duplicate, shadowed (never reached because an earlier rule always matches first), conflicting and broken rules. Hover to see the counts; click to open the Cleanup Center in a new tab. See [[cleanup|Cleanup center]].",
              },
              {
                name: "Simulate",
                what: "Opens the Route simulator: runs a sample message through all live rules in priority order. See [[route-rules#simulate|Simulate]].",
              },
              {
                name: "New rule",
                what: "Opens the New route rule form.",
              },
            ],
          },
        ],
      },
      {
        id: "columns",
        title: "Grid columns and their filters",
        blocks: [
          {
            kind: "text",
            text: "Type in the box under a column header to filter on it. Filtering, sorting and paging run on the server, so they are fast even with many thousands of rules. `%` stands for any text and `_` for one character; case is ignored.",
          },
          {
            kind: "fields",
            fields: [
              { name: "Checkbox", what: "Selects the row for Bulk edit. The header box selects all loaded rows." },
              { name: "ID", what: "The rule number. Filter: equals." },
              { name: "Rule", what: "The rule name. Filter: contains, with `%` and `_` wildcards." },
              {
                name: "Pri",
                what: "Priority, 1–100. High numbers are tried first; the grid opens sorted that way. Filter: a range (from – to).",
              },
              {
                name: "Type",
                what: "A coloured dot and the route type: Static (grey), Least cost (blue), Quality (green) or Block (red). Filter: pick from the list.",
              },
              {
                name: "Category",
                what: "The customer product categories the rule is for (for example Direct, Promo, OTP, WHS), or All. Filter: pick categories from the list.",
              },
              {
                name: "Customer trunks",
                what: 'The first trunks the rule matches (in bold), then "+N" for the rest. Point at the cell to see every trunk in a small window. Filter: contains.',
              },
              {
                name: "Destination",
                what: 'The destinations by name (in bold): Country · Network (MCCMNC), then "+N". Point at the cell to see every destination. Filter: type a country, a network or a code, for example `France`, `Orange` or `208`; also equals, empty or not empty.',
              },
              {
                name: "Vendors",
                what: 'The vendor split in bold, for example "Kite_DIR 60 · Orbit_DIR 40", or the least cost or quality pool. Point at it to see every vendor with its share, level and backups; click it to edit the level 1 split in place. Shows — for Block rules. Filter: contains (vendor name).',
              },
              {
                name: "24h",
                what: "Messages through the rule in the traffic window (24 hours by default; the header shows the window in use). Hover the number to see the per-customer breakdown. Filter: at least.",
              },
              { name: "ASR", what: "Answer seizure ratio: % of messages the vendors accepted. Filter: at least." },
              {
                name: "DLR",
                what: "Delivery ratio: % of messages delivered. Shown in **amber** when it is below the rule's DLR target (the rule's own target, or else its destinations' targets). Hover to see which target applies. Filter: at most.",
              },
              {
                name: "Margin",
                what: "Sell minus cost for the rule's traffic in the window, in the platform currency. Shown in **red** when negative. Filter: less than (for example `0` to find loss-making rules), or a range.",
              },
              {
                name: "On",
                what: "Filled green dot = on; hollow dot = off. Click the dot to turn the rule on or off at once (one undoable change). Filter: On or Off.",
              },
            ],
          },
          {
            kind: "list",
            title: "Hidden filters (add them with Add filter)",
            items: [
              "**Traffic window**: 15m, 1h, 24h, 7d or 30d. Changes the 24h column to that window.",
              "**DLR target** and **DLR below target**: find rules whose delivery is under target.",
              "**Customer trunk ID** and **Vendor trunk ID**: every rule that uses one trunk.",
            ],
          },
        ],
      },
      {
        id: "rule-form",
        title: "The rule form (New rule and E edit)",
        blocks: [
          {
            kind: "text",
            text: "**Double-click** a rule (or press Enter) to open the detail panel on **Edit**: its general settings, saved in place with **Save**. The panel then has **Configuration** (Category, Customer trunks and Destination, each a block with **Edit**, and the Vendors), **Conditions** (sender, receiver, content, TPS, revenue, time, HLR, multipart), Traffic, History and Test. **New rule** opens one window: fill the general settings and click **Continue**; Category, Customer trunks (side by side, each a list with search and Check all), Destination, Vendors and the other conditions then appear in the same window, each saved as you go; tick **Rule on** and click **Done**.",
          },
          {
            kind: "fields",
            title: "New route rule / Edit",
            fields: [
              {
                name: "Name",
                what: "Required. A name the team will recognise in the grid, reports and EDRs.",
                values: "Up to 120 characters, e.g. `AU OTP Premium`.",
              },
              {
                name: "Priority",
                what: "Required. The evaluation order: high numbers are tried first (100 before 1).",
                values: "1–100. Default 97. Only an administrator can set 98, 99 or 100.",
              },
              {
                name: "Route type",
                what: "Only on a new rule (change it later in the Vendors popup). Static, Least cost, Quality or Block.",
                values: "Default Static.",
              },
              {
                name: "Continue routing",
                what: "What happens when this rule matches but no vendor qualifies.",
                values: "STOP – end here (default), YES – keep evaluating, NEXT – jump to group.",
              },
              {
                name: "Group",
                what: "The route rule group this rule belongs to. Groups are used with NEXT.",
                values: "Optional.",
              },
              {
                name: "Next group",
                what: "The group whose rules are tried next. Only for NEXT, and then required.",
              },
              {
                name: "DLR target %",
                what: "The delivery % this rule should reach. The grid shows the rule's DLR in amber below it.",
                values: "0–100. Empty = use the destinations' targets, set on [[mccmnc|MCCMNC codes]].",
              },
              {
                name: "Comment",
                what: "Free note, shown under the condition chips.",
                values: "Up to 1000 characters.",
              },
              {
                name: "Rule on",
                what: "Ticked = the rule routes traffic.",
                values: "A new rule starts off: with no conditions yet it would match all traffic.",
              },
            ],
          },
          {
            kind: "steps",
            title: "How to add a rule",
            items: [
              "Click **New rule**.",
              "Enter the **Name** and **Priority**, pick the **Route type** and click **Continue**. The rule is added switched off and the same window shows Category, Customer trunks, Destination, Vendors and Other conditions.",
              "Tick the categories and customer trunks (**Inclusive** or **Exclusive**) and pick the destinations; click each block's Save.",
              "Add the vendors in the Vendors block and click **Save vendors**; add other conditions with **+ Add condition** if needed. Tick **Rule on** and click **Done**.",
              "Open **Test** and run a sample number through the rule.",
              "Turn the rule on: click the hollow dot in the **On** column, or press E and tick **Rule on**.",
            ],
          },
        ],
      },
      {
        id: "conditions",
        title: "Conditions section",
        blocks: [
          {
            kind: "text",
            text: "The section title shows the rule number and name, then **all must match** or **any one matches**; click it to switch. Each condition is a chip of field, operator and value, for example `Trunk in Acme_OTP, Beta_DIR +2`, `Destination in Australia · Telstra (50501)`, `Sender not is one of TEST, DEMO`, `TPS 5s > 50 · release 45`, `Revenue/msg ≥ 0.040`, `Time always`.",
          },
          {
            kind: "list",
            items: [
              "Click a chip to edit that condition. Click its **×** to remove it. Each save is one undoable change.",
              "**+ Add condition** lists the conditions the rule does not have yet: Trunk, Category, Destination, Sender, Receiver, Content, TPS, Revenue/msg, HLR ported, HLR action, Multipart.",
              "**Time** is always shown. It reads `always` when the rule has started and stops more than 5 years from now. It has no ×; edit it instead.",
              "If another rule has exactly the same conditions, a warning is shown above the chips.",
              "An archived (deleted) rule shows a banner and cannot be edited until it is restored.",
            ],
          },
          {
            kind: "fields",
            title: "Trunk condition",
            fields: [
              {
                name: "Inclusive / Exclusive",
                what: "Match messages from the chosen customer trunks, or from every trunk except them.",
              },
              {
                name: "Search customer trunks…",
                what: "Search and tick the trunks. Each shows its enterprise and category. When the rule has a Category condition, only trunks of those categories are listed (or outside them, for Exclusive).",
                values: "At least one trunk.",
              },
            ],
          },
          {
            kind: "fields",
            title: "Category condition",
            fields: [
              {
                name: "Inclusive / Exclusive",
                what: "Match messages from customer trunks of the ticked product categories (for example OTP, Promo), or of every other category.",
                values: "Tick at least one category.",
              },
            ],
          },
          {
            kind: "fields",
            title: "Destination condition",
            fields: [
              {
                name: "All / Inclusive / Exclusive",
                what: "**All** is every destination, including ones added to the MCCMNC master later. Inclusive and Exclusive use the destination tree.",
              },
              {
                name: "Destination tree",
                what: "Tick a whole country or single networks. The chosen ones show as chips by name; a ticked country shows as one chip.",
                values: "Exact codes only: a 3-digit code is the country's All networks entry, not the whole country.",
              },
              {
                name: "MCCMNC pattern (regular expression)",
                what: "Optional. Matches the destination code with a pattern.",
                values: "e.g. `^50(5|6)` for codes starting 505 or 506. Must be a valid regular expression.",
              },
            ],
          },
          {
            kind: "fields",
            title: "Sender, Receiver and Content conditions",
            fields: [
              {
                name: "Match / Not match",
                what: "Match messages whose value fits, or messages whose value does not fit.",
              },
              {
                name: "Case sensitive",
                what: 'Sender only. Ticked: the Sender ID values, the regex and the Sender ID list must match the exact capitals (`BANK` does not match "Bank"). Cleared: any mix of capitals matches, and the chip shows **any case**.',
                values: "Ticked by default.",
              },
              {
                name: "Keywords \\Numeric and \\Alpha",
                what: "Sender only. `\\Numeric` matches numeric Sender IDs (digits, optional +); `\\Alpha` matches Sender IDs with at least one letter. Click the keyword under the Sender buttons to use it; it switches to Regex. Translation rules accept the same keywords.",
              },
              {
                name: "Is one of",
                what: "Sender and Receiver. The whole value must be one of the values you add.",
                values: "e.g. Sender is one of `BANK`, `OTP`.",
              },
              {
                name: "Starts with",
                what: "The value starts with one of the values you add.",
                values: "e.g. Receiver starts with `614`.",
              },
              {
                name: "Contains",
                what: "Content only. The message text contains one of the words or phrases.",
                values: "e.g. `code`, `verification`.",
              },
              {
                name: "Regex",
                what: "A free regular expression for anything the value list cannot express. Switching to Regex keeps what the list stood for, so you can fine-tune it.",
                values: "e.g. `^(TEST|DEMO)` or `code|otp`. Up to 200 characters.",
              },
              {
                name: "Type a … and press + or Enter",
                what: "Adds a value. Sender IDs and numbers can be pasted as a list separated by commas, semicolons or new lines; content phrases are split by new lines only, so they keep their commas. Click a value's × to remove it.",
                values:
                  "Sender: capitals count while Case sensitive is ticked. Receiver and content: upper and lower case match alike.",
              },
              {
                name: "Sender ID list / Receiver ID list",
                what: "Sender and Receiver only. Also requires the sender or receiver to be in a number list. The list is a separate check from the values above.",
                values: "Lists are kept in [[number-lists|Number lists]]. Enter values, a list, or both.",
              },
            ],
          },
          {
            kind: "fields",
            title: "TPS condition (messages per second)",
            fields: [
              { name: "Average over", what: "How live TPS is measured.", values: "1 s, 5 s (default), 10 s or 60 s." },
              { name: "Operator", what: "How live TPS is compared.", values: ">, ≥, =, ≤, < or between. Default >." },
              {
                name: "Measured on",
                what: "Which traffic is counted.",
                values: "Customer trunk (default), Customer (all its trunks), Destination, Sender ID or This rule.",
              },
              { name: "TPS", what: "The value to compare with.", values: "Default 50." },
              { name: "and TPS", what: "The upper value, for between.", values: "Must be at least the lower value." },
              {
                name: "Tolerance ±%",
                what: "For =, because live TPS is rarely an exact number.",
                values: "Default 5, at most 50.",
              },
              {
                name: "Release at −%",
                what: "Switch back only when TPS has moved this far back past the value. Stops the rule flapping on and off.",
                values: "Default 10. The chip shows the release point, e.g. `> 50 · release 45`.",
              },
              {
                name: "Hold (s)",
                what: "TPS must stay past the value this long before the rule takes over.",
                values: "Default 30, at most 3600.",
              },
            ],
          },
          {
            kind: "fields",
            title: "Revenue/msg condition",
            fields: [
              {
                name: "Type",
                what: "**Per message**: the customer's sell rate for this message. **Accumulated**: revenue already earned over a period.",
              },
              { name: "Operator", what: ">, ≥, =, ≤, < or between.", values: "Default ≥." },
              {
                name: "Revenue (base currency)",
                what: "The amount to compare with, in the platform currency.",
                values: "e.g. `0.04` (default).",
              },
              { name: "and", what: "The upper amount, for between." },
              {
                name: "Period",
                what: "Accumulated only.",
                values: "Last 15 min, Last 60 min, Today (default), This week, This month, Billing cycle.",
              },
              {
                name: "Measured on",
                what: "Accumulated only: whose revenue is counted.",
                values: "Customer trunk, Customer (all its trunks), Destination, Sender ID, This rule.",
              },
              {
                name: "And margin at least",
                what: "Optional. Also require the chosen vendor to leave this margin.",
                values: "Empty = none, `0.002` = amount, `5%` = % of the sell rate, `-` for negative.",
              },
            ],
          },
          {
            kind: "fields",
            title: "Time condition",
            fields: [
              { name: "Start (UTC)", what: "When the rule starts routing.", values: "Date and time in UTC." },
              {
                name: "Stop (UTC)",
                what: "When it stops. Use it for scheduled routing, for example a weekend campaign.",
                values: "Must be after the start. A new rule runs from now for 10 years.",
              },
            ],
          },
          {
            kind: "fields",
            title: "HLR ported, HLR action and Multipart",
            fields: [
              {
                name: "HLR ported",
                what: "**Only ported numbers** or **Only not ported**, from the HLR result.",
              },
              {
                name: "HLR policy",
                what: "HLR action: do an HLR lookup with this policy before routing. The policy sets which providers are asked per destination.",
                values: "Required for this condition. Policies: [[hlr|HLR]].",
              },
              {
                name: "For the rule's customer trunks",
                what: "HLR action: tick the trunks the lookup is for.",
                values:
                  "None ticked = all of the rule's trunks. If the rule matches every trunk, the lookup runs for all of them.",
              },
              {
                name: "Multipart",
                what: "Added straight away from + Add condition. Multipart messages (long SMS sent in several parts) will not match this rule. The chip reads `Multipart denied`.",
              },
            ],
          },
        ],
      },
      {
        id: "vendors",
        title: "Vendors section",
        blocks: [
          {
            kind: "text",
            text: 'The panel shows the route type, hunt policy, max level and minimum margin, then a table of the vendors: **Level**, **Vendor trunk**, **Share**, **Backup** ("for" the vendor it stands in for, or "last resort") and **Warm-up**. Each vendor is followed by its backups. Click **Edit vendors…** to change them in a wide popup.',
          },
          {
            kind: "fields",
            title: "Edit vendors – top row",
            fields: [
              {
                name: "Route type",
                what: "Static, Least cost, Quality or Block. Block hides everything else: matching messages are rejected.",
              },
              {
                name: "Hunt policy",
                what: "How vendors of one level share the traffic.",
                values: "Top down (by level), Round robin, Percentage split.",
              },
              {
                name: "Max route level",
                what: "How many levels the rule can have. Each vendor's Level can be 1 up to this number.",
                values: "1–10.",
              },
              {
                name: "Split per customer trunk",
                what: "Percentage split only. On: every customer trunk's own traffic is split by the shares. Off: the shares apply to the rule's total traffic.",
                values: "On by default.",
              },
            ],
          },
          {
            kind: "fields",
            title: "Edit vendors – vendor table",
            fields: [
              { name: "Level", what: "Level 1 is used first; higher levels take over when a level fails." },
              {
                name: "Vendor trunk",
                what: "Search and pick the vendor trunk. Each shows its enterprise and category.",
                values: "Required on every row. Up to 50 rows.",
              },
              {
                name: "Share %",
                what: "Percentage split only. The vendor's part of the level's traffic.",
                values: "0–100. The shares of each level must add up to 100; a warning shows while they do not.",
              },
              {
                name: "Backup",
                what: "Tick to give this vendor its own backups. A row opens under it: **Backups for this vendor (share of its traffic)**. Pick each backup vendor and its share; **+ Add backup** adds more.",
                values: "Up to 5 backups per vendor. With more than one backup their shares must add up to 100.",
              },
              {
                name: "Warm-up first",
                what: "Send the first N messages to this vendor before the normal split applies, e.g. the first 500 a day.",
                values: "Empty = off.",
              },
              {
                name: "Counted per",
                what: "Warm-up only: count for the whole rule, or separately for each customer trunk.",
                values: "Rule (default) or Customer trunk.",
              },
              {
                name: "Resets",
                what: "Warm-up only: when the count starts again. **Every … hours** shows a box for your own period, e.g. 6.",
                values: "Never, Hourly, Daily, Weekly, Every … hours (1–8760).",
              },
              { name: "×", what: "Removes the vendor and its backups." },
            ],
          },
          {
            kind: "fields",
            title: "Edit vendors – Vendors in scope (Least cost and Quality)",
            fields: [
              {
                name: "Vendor categories",
                what: "Which vendor trunk categories may be used.",
                values: "All categories, Only these, All but these (then tick the categories).",
              },
              {
                name: "Vendor trunks",
                what: "Which vendor trunks may be used. The picker follows the chosen categories.",
                values: "All trunks, Only these, All but these.",
              },
              {
                name: "LCR profile",
                what: "Least cost only. A profile filters vendors (tiers, quality, maximum rate, TPS), orders them and sets how many are used and how traffic is split.",
                values: "Empty = the cheapest vendors in scope. Profiles: [[lcr|LCR]] › Profiles.",
              },
              {
                name: "Quality ranking weights (%)",
                what: "Quality only. How much ASR, DLR, Delay and Cost count in the score.",
                values:
                  "Defaults ASR 35 · DLR 35 · Delay 20 · Cost 10. Must add up to 100. **Back to defaults** clears your own weights.",
              },
            ],
          },
          {
            kind: "fields",
            title: "Edit vendors – Limits",
            fields: [
              {
                name: "Minimum margin",
                what: "Vendors that leave less margin than this are skipped.",
                values:
                  "`0.002` = amount in the platform currency, `5%` = % of the sell rate, `-0.001` or `-2%` = allow a small loss. Default 0.",
              },
              {
                name: "+ Add limit",
                what: "Minimum margin is always shown; the other limits (Skip vendor at % of its TPS, Volume cap) appear when set or when added here.",
              },
              {
                name: "Skip vendor at % of its TPS",
                what: "Skip a vendor when its current TPS reaches this % of its limit, so the next level takes the excess instead of queueing.",
                values: "1–100. Empty = off.",
              },
              {
                name: "Volume cap (messages)",
                what: "The most messages the rule may carry per interval.",
                values: "Empty = off. Set together with **per**.",
              },
              { name: "per", what: "The cap's interval.", values: "Minute, Hour or Day (default Day)." },
            ],
          },
          {
            kind: "fields",
            title: "Edit vendors – Number whitelists",
            fields: [
              {
                name: "Always to vendor",
                what: "Messages to these numbers always go to this vendor, whatever the split or warm-up.",
                values: "Must be one of the rule's vendors (except on Least cost rules).",
              },
              {
                name: "Numbers (n), one per line",
                what: "The receiver numbers. Spaces, commas and semicolons also separate them.",
                values: "Digits only, up to 15 each, e.g. `61412345678`.",
              },
              { name: "or number list", what: "Use a number list instead of (or as well as) typed numbers." },
              {
                name: "Add whitelist",
                what: "Adds another whitelist, e.g. test numbers to one vendor and VIP numbers to another.",
                values: "Up to 20.",
              },
            ],
          },
          {
            kind: "text",
            text: "Click **Save vendors** to save everything in the popup as one change, or **Cancel** to close without saving.",
          },
          {
            kind: "steps",
            title: "How to change the split quickly",
            items: [
              "In the grid, click the **Vendors** cell of a static rule.",
              "The **Level 1 vendors** editor opens. Change a vendor, its share, remove one with ×, or click **Add**.",
              "Click **Save** (or press Enter in a box). Vendors on other levels are kept; **+N on other levels** opens the Vendors section.",
            ],
          },
          {
            kind: "tip",
            text: "Least cost and quality rules rank the vendors in scope, so their Vendors cell only offers **Open Vendors section**.",
          },
        ],
      },
      {
        id: "traffic",
        title: "Traffic section and hover volumes",
        blocks: [
          {
            kind: "list",
            items: [
              "Pick the time frame at the top: **15m**, **1h**, **24h** (default), **7d** or **30d**.",
              "Totals: **Messages**, **ASR**, **DLR** and **Margin** (green when positive, red when negative).",
              "A chart of messages (bars) and margin (line) over time.",
              "**Vendors over time**: which vendor carried the traffic in each period. Other vendors are grey; messages that were not routed are red. The table below lists each time the main vendor changed: **From**, **Until**, **Main vendor** and its **Share**.",
              "Two tables, per **Customer trunk** and per **Vendor trunk**: Msgs, Share, ASR, DLR, Margin.",
              "**Hover volumes**: rest the mouse on the number in the 24h column. A popup lists the top 10 customer trunks sending through the rule, with volume, share, ASR, DLR and margin. Its own time frame switch does not change the grid.",
            ],
          },
          {
            kind: "tip",
            text: "In the trial the traffic figures come from the fake traffic generator. If the EDR store is not answering, the section says so instead of showing numbers.",
          },
        ],
      },
      {
        id: "history",
        title: "History section and undo",
        blocks: [
          {
            kind: "list",
            items: [
              "Every save on a rule is one change: a condition, the vendors, the settings, turning it on or off, a duplicate, a delete, a bulk edit.",
              "The **History** section lists the rule's changes, newest first: change number, type, user, time (UTC), what changed (before → after) and the note.",
              "Each of your own changes has an **Undo** button. Undo puts back only the fields that change touched, so other people's later edits stay.",
              "If someone changed the same field after you, you are asked: **Keep current** (undo only the untouched fields), **Restore mine** (put your values back everywhere) or **Cancel**.",
              "Right after a save an **Undo** toast shows for 10 seconds. **Ctrl+Z** on the page undoes your last change. An undo is itself a change, so it can be redone.",
              'Undoing other people\'s changes needs the "undo others" permission.',
            ],
          },
          { kind: "text", text: "See [[undo-and-history]] for the full rules." },
        ],
      },
      {
        id: "test",
        title: "Test section",
        blocks: [
          {
            kind: "text",
            text: "Runs a sample message through this one rule, even if it is off, so you can check it before turning it on.",
          },
          {
            kind: "fields",
            title: "Test form",
            fields: [
              {
                name: "Receiver number",
                what: "Required. The number to test.",
                values: "5–15 digits, e.g. `61412345678`.",
              },
              {
                name: "Customer trunk",
                what: "The trunk the message comes from. Sets the category and the sell rate.",
                values: "Starts with the rule's first trunk. Empty = any trunk.",
              },
              { name: "Sender", what: "The sender ID.", values: "Up to 20 characters." },
              {
                name: "MCCMNC (after HLR)",
                what: "Force the destination, as if an HLR lookup had found it.",
                values: "Empty = from the number's dial code.",
              },
              { name: "Content", what: "The message text, for content conditions." },
              { name: "HLR ported", what: "The HLR result to assume.", values: "Unknown, Ported or Not ported." },
              { name: "Live TPS", what: "The TPS to assume, for a TPS condition." },
              {
                name: "Revenue/msg",
                what: "The sell rate to assume.",
                values: "Empty = from the trunk's rate for the destination.",
              },
              {
                name: "Revenue so far",
                what: "The accumulated revenue to assume, for an accumulated revenue condition.",
              },
              { name: "Warm-up sent", what: "How many warm-up messages are already counted.", values: "Default 0." },
            ],
          },
          {
            kind: "list",
            title: "The result",
            items: [
              "The outcome with a coloured dot: **Routed** (green), **No vendor available** (amber), **Blocked by the rule** (red) or **Rule does not match** (grey).",
              "The chosen vendor, its level, and what decided it: number whitelist, warm-up threshold, percentage split, top down, round robin, least cost or quality score.",
              "The destination found and the sell rate.",
              "Every check with a tick or a cross and the reason (status, time, each condition).",
              'The vendors tried: Level, Vendor, Cost, Margin and a note (share, backup, "margin below …"). The chosen one is highlighted.',
            ],
          },
        ],
      },
      {
        id: "simulate",
        title: "Simulate (all rules)",
        blocks: [
          {
            kind: "text",
            text: "**Simulate** in the header opens the Route simulator. It has the same form as the Test section and runs the message through every live rule in priority order.",
          },
          {
            kind: "list",
            items: [
              "The table shows **Pri**, **Rule** and **Result** for the rules that matched. Tick **Show the N rules tried before (did not match)** to see why earlier rules were skipped.",
              "Click a rule name to close the simulator and show that rule in the grid.",
              "Below it is the full decision of the deciding rule, as in the Test section. If no rule matched, the message would be rejected.",
            ],
          },
        ],
      },
      {
        id: "how-to",
        title: "Common tasks",
        blocks: [
          {
            kind: "steps",
            title: "Duplicate a rule",
            items: [
              "Select the rule in the grid.",
              'Press **D** or click **Clone** next to New rule. A copy named "… (copy)" is added, switched off, with the same conditions and vendors.',
              "The copy's settings open straight away with the name selected: type the new name and save.",
              "Change what differs and turn it on.",
            ],
          },
          {
            kind: "steps",
            title: "Move traffic from one vendor to another on many rules",
            items: [
              "Filter the grid, e.g. type the vendor name in the **Vendors** filter.",
              "Tick the rules (or the header box to select all loaded rows).",
              "Click **Bulk edit** › **Replace vendor…**, choose the vendor trunk to replace and the one to use instead, add a note and click **Apply**.",
              "The vendor is swapped on every level, in the vendor scope and in number whitelists of those rules. One Undo restores them all.",
            ],
          },
          {
            kind: "steps",
            title: "Delete (archive) a rule",
            items: [
              "Select the rule and click **Bulk edit** › **Delete…**.",
              "The delete dialog shows what depends on the rule. Confirm to archive it: it stops routing at once but stays in reports and history.",
              "Undo brings it back with the same ID. Restoring an archived rule later needs an administrator. See [[safe-delete]].",
            ],
          },
          {
            kind: "steps",
            title: "Find rules losing money",
            items: [
              "Type `0` in the **Margin** filter (less than 0).",
              "Sort by **24h** to see the biggest first.",
              "Open a rule's **Traffic** section to see which vendor and customer cause the loss.",
            ],
          },
        ],
      },
      {
        id: "bulk",
        title: "Bulk edit",
        blocks: [
          {
            kind: "text",
            text: "Select rules with the checkboxes (or Space), then open **Bulk edit**. Each bulk action is one change and is undone as one.",
          },
          {
            kind: "fields",
            fields: [
              {
                name: "Turn on / Turn off",
                what: "Switches all selected rules on or off.",
                values:
                  "Static rules without vendors cannot be turned on; the whole action is refused and the rules are named.",
              },
              {
                name: "Set priority…",
                what: "Gives all selected rules the same priority.",
                values: "New priority (1–100).",
              },
              {
                name: "Shift priority…",
                what: "Moves all selected rules earlier or later by the same amount.",
                values: "Shift by (positive = earlier), e.g. `10`. Results stay between 1 and 100.",
              },
              {
                name: "Replace vendor…",
                what: "Swaps one vendor trunk for another in the selected rules.",
                values: "Replace vendor trunk … with … (two different trunks).",
              },
              {
                name: "Apply LCR profile…",
                what: "Makes the selected rules Least cost with the chosen profile.",
              },
              {
                name: "Delete…",
                what: "Archives the selected rules. They stop routing at once and stay in reports and history.",
              },
              {
                name: "Note (kept with the change)",
                what: "Optional reason, shown in History.",
                values: "Up to 500 characters.",
              },
            ],
          },
          {
            kind: "tip",
            text: "Changing the filter clears the selection, so a bulk edit never acts on rows you cannot see.",
          },
        ],
      },
      {
        id: "shortcuts",
        title: "Keyboard shortcuts",
        blocks: [
          {
            kind: "fields",
            fields: [
              { name: "↑ ↓", what: "Move between rules." },
              { name: "Space", what: "Select or unselect the rule for Bulk edit." },
              {
                name: "E",
                what: "Edit the rule's settings (name, priority, continue routing, group, DLR target, comment, on/off).",
              },
              { name: "D", what: "Duplicate the rule (the copy starts off)." },
              { name: "Ctrl+Z", what: "Undo your last change on this page." },
            ],
          },
        ],
      },
      {
        id: "watch",
        title: "Tips and things to watch",
        blocks: [
          {
            kind: "warning",
            text: "A rule with no conditions matches every message. Keep new rules off until their conditions and vendors are set and tested.",
          },
          {
            kind: "warning",
            text: "Saves are refused when: the name is empty; stop is not after start; a pattern is not a valid regular expression; Inclusive is chosen with nothing picked; NEXT has no next group; an active static rule has no vendor; a vendor's level is above Max route level; percentage shares of a level do not add up to 100; quality weights do not add up to 100; a whitelist has no numbers or list; or an LCR profile is set on a rule that is not Least cost.",
          },
          {
            kind: "tip",
            text: "Priority decides everything: a broad rule with a low number hides every rule after it. The Cleanup button flags such shadowed rules.",
          },
          {
            kind: "tip",
            text: "Turning a rule on or off with the dot is a change like any other and can be undone.",
          },
          {
            kind: "tip",
            text: "In the trial the Test and Simulate check the conditions, whitelists, warm-up, levels, backups and margin. They do not apply the TPS capacity skip, the volume cap, the HLR action, the Multipart condition or the margin inside a revenue condition.",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ Route map
  {
    id: "route-map",
    pageKey: "route-map",
    title: "Route map",
    group: "Routing",
    summary:
      "For one customer trunk, which rule and vendor every destination it sells gets today, with sell rate, vendor cost and margin.",
    keywords: ["route map", "routing table", "destination routing", "no route", "no vendor", "margin per destination"],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "Choose a customer trunk and see, for every destination it has a rate for, whether messages would be routed today, by which rule, to which vendor, at what cost and margin. NOC staff use it to find destinations with no route; account managers use it to check a client's margins.",
          },
        ],
      },
      {
        id: "layout",
        title: "What you see on the page",
        blocks: [
          {
            kind: "fields",
            title: "Top of the page",
            fields: [
              {
                name: "Customer trunk",
                what: "The trunk to map. Search by name; each shows its enterprise and category. The grid stays empty until a trunk is chosen.",
                values: "The trunk is kept in the tab, so the tab can be reopened or moved.",
              },
              { name: "Export", what: "Downloads the rows matching the current filters as CSV." },
            ],
          },
          {
            kind: "fields",
            title: "Grid columns",
            fields: [
              {
                name: "Country / Network / MCCMNC",
                what: 'The destination. "All networks" is the country\'s default rate.',
              },
              {
                name: "Sell rate",
                what: "The customer's rate in the rate table's currency. Hover to see the rate table.",
              },
              { name: "Sell (platform currency)", what: "The sell rate converted to the platform currency." },
              {
                name: "Route",
                what: "**Routed** (green): a rule picks a vendor. **Blocked** (grey): a block rule matches. **No vendor** (amber): rules match but no vendor qualifies (rate, margin, scope). **No rule** (red): no route rule matches, so messages would fail.",
              },
              { name: "Rule", what: "The deciding rule. Click it to open that rule on Route rules in a new tab." },
              { name: "Type", what: "Static, Least cost, Quality or Block." },
              { name: "Vendor", what: "The vendor trunk chosen." },
              { name: "Cost (platform currency)", what: "The vendor's rate for the destination." },
              {
                name: "Margin / Margin %",
                what: "Sell minus cost, as an amount and as a % of the sell rate. Red when negative.",
              },
            ],
          },
          {
            kind: "text",
            text: "Hidden columns you can add or filter on: Currency, Rate table, Rule ID, Pri (rule priority) and Decided by. Clicking a row opens the **Route** detail with the same facts in one place.",
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
              "Every destination with a sell rate on the trunk's rate tables is run through the live route rules in order, the same way as the Simulator.",
              "It is the steady-state route: a message with no receiver number or content, so number whitelists, warm-up and content conditions do not apply.",
              "The map is worked out once a minute per trunk; filters and sorting then run on the server.",
            ],
          },
          {
            kind: "steps",
            title: "How to find destinations without a route",
            items: [
              "Choose the customer trunk.",
              "In the **Route** filter, pick **No rule** and **No vendor**.",
              "Click a rule name to fix that rule, or add a rule on [[route-rules|Route rules]].",
            ],
          },
          {
            kind: "tip",
            text: "To see the exact path of one message (with translation rules and a real number), use the [[simulator|Simulator]].",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ LCR
  {
    id: "lcr",
    pageKey: "lcr",
    title: "LCR",
    group: "Routing",
    summary:
      "Vendors ranked by cost (or a quality-weighted score) per destination, client margins against those positions, reusable LCR profiles and alerts when the cheapest vendor changes.",
    keywords: ["LCR", "least cost routing", "cheapest vendor", "LCR profile", "what-if", "vendor ranking", "tier"],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: 'LCR (least cost routing) ranks the vendors that can carry a destination. The routing and pricing teams use it to see who is cheapest now or on a future date, test "what if" a vendor is removed or makes an offer, check where client prices sit against vendor costs, and keep the profiles that Least cost route rules use.',
          },
          {
            kind: "text",
            text: "The page has four views, switched at the top: **LCR table**, **Client view**, **Profiles** and **Changes**. The view is kept in the tab.",
          },
        ],
      },
      {
        id: "table",
        title: "LCR table view",
        blocks: [
          {
            kind: "fields",
            title: "Controls",
            fields: [
              { name: "Destination", what: "Find the destination by country, network or MCCMNC." },
              {
                name: "Point in time (UTC)",
                what: "Rank by the rates valid at that time. **Now** clears it; **Next Monday** sets next Monday 00:00 UTC, to see the effect of scheduled rate changes.",
              },
              {
                name: "LCR profile",
                what: "Apply a profile's filters, order and picks.",
                values: "Empty = rank every vendor by cost.",
              },
              {
                name: "Quality-weighted score",
                what: "Rank by a score instead of cost alone. Set the weights for Cost, ASR, DLR and Delay.",
                values: "Defaults Cost 60, ASR 10, DLR 25, Delay 5.",
              },
            ],
          },
          {
            kind: "fields",
            title: "Columns",
            fields: [
              {
                name: "#",
                what: "The rank. A green ↑ or red ↓ shows how a what-if moved it; hover to see the old rank. — = left out.",
              },
              { name: "Vendor trunk / Vendor", what: "The trunk and its enterprise." },
              { name: "Tier", what: "The vendor's tier (T1, T2, T3)." },
              { name: "Cost", what: "The rate in the platform currency, used for ranking." },
              { name: "Rate", what: "The rate in the vendor's own currency." },
              { name: "Since", what: "When the current rate started." },
              { name: "Scheduled", what: "The next rate and its start date. Amber when it goes up." },
              { name: "ASR / DLR / Delay s", what: "Quality for this vendor and destination." },
              { name: "TPS / limit", what: "Current messages per second against the trunk's limit. Red at the limit." },
              { name: "Routed now", what: "How many client trunks routing sends to this vendor for the destination." },
              { name: "Score", what: "The quality-weighted score, when that ranking is on." },
              { name: "Used", what: "Green when the profile uses this vendor, with its share for a percentage split." },
              {
                name: "Left out",
                what: 'Why the profile left the vendor out, e.g. "DLR below 90 %" or "at its TPS limit".',
              },
              { name: "What-if", what: "**Remove** takes the vendor out of the ranking; **Put back** returns it." },
            ],
          },
          {
            kind: "steps",
            title: "How to test a what-if",
            items: [
              "Choose the destination.",
              "Click **Remove** on a vendor, or pick a vendor in **Vendor (new rate or offer)…**, type its cost and click **Add**.",
              "The ranks update, and cards show **Routes that change** (of the client trunks selling the destination), **Messages (7 days)**, **Cost change (7 days)** and **Margin change (7 days)**.",
              "Click **Clear what-if** to go back. Nothing is saved.",
            ],
          },
          {
            kind: "fields",
            title: "Header actions",
            fields: [
              { name: "Export", what: "Downloads the table on screen as CSV." },
              {
                name: "Apply to route rules",
                what: "Opens Route rules filtered to this destination in a new tab. There, select rules and use Bulk edit › Apply LCR profile.",
              },
              {
                name: "Price clients from LCR",
                what: "Opens bulk rating for this destination, to set client rates from cost plus margin. See [[bulk]].",
              },
            ],
          },
        ],
      },
      {
        id: "clients",
        title: "Client view",
        blocks: [
          {
            kind: "fields",
            fields: [
              { name: "Client", what: "A customer enterprise." },
              {
                name: "or account manager",
                what: "All clients of one account manager. Choosing one clears the other.",
              },
              { name: "LCR profile", what: "Use a profile's picks for the LCR positions.", values: "Optional." },
              {
                name: "Show",
                what: "**Below cost only** shows rates sold under the cheapest vendor. Sort by **Lowest margin first**, **Most traffic first** or **By destination**. Search narrows the rates.",
              },
            ],
          },
          {
            kind: "text",
            text: "Cards show the number of **Rates**, how many are **Below cost** (red) and the **Average margin at LCR 1**. The table lists Client trunk, Country, Network, MCCMNC, **Sell**, then **LCR 1–3** (the three cheapest eligible vendors with their cost) and **Margin 1–3** (red when negative), and **Msgs 7d**. Below-cost rates are highlighted. More rates load as you scroll.",
          },
        ],
      },
      {
        id: "profiles",
        title: "Profiles",
        blocks: [
          {
            kind: "text",
            text: "A profile is a named set of LCR rules that Least cost route rules can use. The list shows Name, Status, Vendors Used, Split, Min DLR, Quality-weighted (Score or Cost), Rules (how many route rules use it; point at the number to see them by name), Vendor scope (**All vendors**, **N vendors** or **All but N**; point at it to see the vendor trunks), Updated By and Updated. On the LCR table, point at the client changes under the Margin change card to see every client trunk whose vendor would change. Click **New profile**, or double-click a profile to edit it. Profile changes have Undo and History.",
          },
          {
            kind: "fields",
            title: "Profile form",
            fields: [
              { name: "Name", what: "Required." },
              { name: "Status", what: "Active or Inactive." },
              { name: "Description", what: "Optional note." },
              {
                name: "Vendor trunks",
                what: "All, Only these or All but these, then add the trunks.",
                values: "Only these / All but these need at least one trunk.",
              },
              { name: "Tiers allowed", what: "Tier 1, Tier 2, Tier 3.", values: "None ticked = all tiers." },
              {
                name: "Minimum ASR % / Minimum DLR %",
                what: "Leave out vendors with lower quality.",
                values: "Empty = any.",
              },
              { name: "Maximum delay (s)", what: "Leave out slower vendors.", values: "Empty = any." },
              { name: "Maximum cost (platform currency)", what: "Leave out dearer vendors.", values: "Empty = any." },
              {
                name: "Vendors to use (1–10)",
                what: "How many of the top-ranked vendors are used.",
                values: "Default 3.",
              },
              {
                name: "Split",
                what: "**Top-down**: the first is used, the next ones are failover. **Percentage**: traffic is split by position.",
              },
              {
                name: "Shares per position (%)",
                what: "Percentage only: one share per vendor position.",
                values: "Must add up to 100. Filled in evenly when you switch to Percentage.",
              },
              {
                name: "Tie-breaker",
                what: "For equal cost or score.",
                values: "Better DLR first (default) or Lower cost first.",
              },
              {
                name: "Leave out vendors at their TPS limit",
                what: "Skip vendors that are full right now.",
                values: "On by default.",
              },
              {
                name: "Rank by the quality-weighted score",
                what: "Rank by a score of Cost, ASR, DLR and Delay instead of cost alone. Set the **Weights**.",
                values: "Defaults Cost 60, ASR 10, DLR 25, Delay 5.",
              },
            ],
          },
          {
            kind: "tip",
            text: "A vendor with no quality figures yet (no traffic) is not left out by the minimum ASR, DLR or delay settings.",
          },
        ],
      },
      {
        id: "changes",
        title: "Changes",
        blocks: [
          {
            kind: "text",
            text: "Lists when the top LCR vendor of a destination changed or its cheapest cost moved: when it was detected, the destination, the kind of change (**Top vendor changed** or **Cheapest cost moved**), old and new vendor, old and new cost and the change % (amber when the cost went up). A link opens the related market move. Press Enter on a row to open that destination's LCR table. See [[market-moves|Market moves]].",
          },
          {
            kind: "fields",
            title: "Alert settings",
            fields: [
              { name: "Check every 15 minutes", what: "Turns the checks on or off." },
              {
                name: "When the top LCR vendor changes",
                what: "Record a change when another vendor becomes cheapest.",
              },
              {
                name: "When the cheapest cost moves by more than (%)",
                what: "Record a change when the best cost moves this much.",
                values: "e.g. `5`.",
              },
            ],
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ Re-rating
  {
    id: "re-rating",
    pageKey: "re-rating",
    title: "Re-rating",
    group: "Routing",
    summary:
      "Recompute charges on past messages after a rate correction. One user requests, another approves; the difference is posted as a credit or debit note.",
    keywords: ["re-rating", "rerating", "reprocess", "rate correction", "credit note", "debit note", "maker-checker"],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "When a rate was wrong for messages already sent, re-rating works out what they should have cost with the corrected rate table and posts the difference to the enterprise's account. Billing staff request it; a second person approves or declines it (maker-checker: the requester cannot approve their own request).",
          },
        ],
      },
      {
        id: "layout",
        title: "What you see on the page",
        blocks: [
          {
            kind: "fields",
            title: "Grid columns",
            fields: [
              { name: "Request id", what: "The request number." },
              { name: "Enterprise Type", what: "Customer or Vendor." },
              { name: "Reprocess Type", what: "Manual or Auto." },
              { name: "Enterprises", what: "The enterprises in scope." },
              { name: "Rate table", what: "The table whose rates are applied." },
              { name: "Description", what: "The requester's note." },
              { name: "Start Date / End Date", what: "The period of messages re-rated." },
              { name: "Priority", what: "P1, P2 or P3." },
              {
                name: "Request Status",
                what: "**Pending Approval** (amber), **Approved** (green) or **Declined** (grey).",
              },
              {
                name: "Reprocess Status",
                what: "**In Queue** and **In Process** (amber), **Completed** (green), **Failed** (red), or — before approval.",
              },
              { name: "Total EDRs", what: "How many message records were re-rated." },
              { name: "Requested by / Updated by", what: "Who asked, and who last changed the request." },
            ],
          },
          {
            kind: "text",
            text: "Click a request to see its detail: status, scope, who requested and decided, processing times, the buttons **Edit**, **Approve** and **Decline** (when you may use them), and the **Re-Rating Summary**.",
          },
          {
            kind: "fields",
            title: "Re-Rating Summary",
            fields: [
              { name: "Enterprise", what: "One row per enterprise." },
              { name: "Total EDR", what: "Messages in scope." },
              {
                name: "Billed / Re-rated",
                what: "The amount billed at the time, and the amount with the corrected rates.",
              },
              { name: "Amount", what: "The difference, in the table's currency." },
              { name: "Payment Type", what: "Credit note or Debit note." },
              {
                name: "Transaction",
                what: "To post, Posted (with the transaction number), Not posted (no note) or No difference.",
              },
            ],
          },
        ],
      },
      {
        id: "fields",
        title: "Fields in the Re-Rating Request form",
        blocks: [
          {
            kind: "fields",
            fields: [
              { name: "Description", what: "Why the re-rating is needed.", values: "Optional, up to 500 characters." },
              {
                name: "Start Date / End Date",
                what: "Required. The period of messages to re-rate.",
                values: "End on or after start, and not in the future.",
              },
              {
                name: "Enterprise Type",
                what: "Customer (sell side) or Vendor (buy side). Switching clears the enterprises and rate table.",
              },
              { name: "Priority", what: "Required. How urgent the request is.", values: "P1, P2 (default), P3." },
              {
                name: "Customer / Vendor",
                what: "Required. The enterprises whose messages are re-rated.",
                values: "Search and tick one or more.",
              },
              {
                name: "Rate Table",
                what: "Required. The corrected rate table. Only tables of the chosen side are listed.",
              },
              { name: "Reprocess Reason", what: "Fixed to Rate Correction." },
              { name: "Sender ID", what: "Only re-rate messages from this sender ID.", values: "Optional." },
              {
                name: "MCCMNC (empty = all)",
                what: "Only re-rate these destinations.",
                values: "Tick countries or networks in the tree.",
              },
              {
                name: "Don't add credit/debit note to transaction",
                what: "Work out the difference but do not post a note.",
              },
            ],
          },
        ],
      },
      {
        id: "how-to",
        title: "How to request and approve",
        blocks: [
          {
            kind: "steps",
            title: "Request a re-rating",
            items: [
              "Click **Request re-rating**.",
              "Fill in the period, side, enterprises and rate table (and optionally sender ID and destinations).",
              "Click **Preview** to see how many EDRs are in scope and the amounts per enterprise.",
              "Click **Request**. The request waits for another user.",
              "While it is pending you can open it and click **Edit** to change it.",
            ],
          },
          {
            kind: "steps",
            title: "Approve or decline",
            items: [
              "Open a request that someone else made.",
              "Check the scope and summary.",
              "Click **Approve** to queue it, or **Decline** and enter the **Reason** (required).",
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
              "Each message is priced with the table's rate valid at its send time. A back-dated rate counts from its stated date.",
              "Customer side: a lower amount becomes a credit note to the customer, a higher one a debit note.",
              "Vendor side: a higher cost becomes a credit note to the vendor, a lower one a debit note.",
              "Notes are posted to [[transactions|Transactions]] as Reprocess entries, unless **Don't add credit/debit note** is ticked.",
              "The EDRs themselves keep the amounts they were billed at.",
            ],
          },
          {
            kind: "warning",
            text: "Only the requester can edit a pending request, and only another user can approve or decline it.",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ Rate lookup
  {
    id: "rate-lookup",
    pageKey: "rate-lookup",
    title: "Rate lookup",
    group: "Routing",
    summary:
      "Vendor costs and client rates for any destination in seconds: side by side, for one destination, or as a matrix over many destinations.",
    keywords: [
      "rate lookup",
      "price check",
      "vendor cost",
      "client rate",
      "margin",
      "best cost",
      "compare rates",
      "matrix",
    ],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: 'Answer "what do we pay and what do we charge for this destination?" quickly. Account managers use it before quoting a client; the routing team uses it to spot cheaper vendors and below-cost sells. Three modes are switched in the header: **Side by side** (the default), **One destination** and **Advanced**. Your choices are kept in the tab.',
          },
        ],
      },
      {
        id: "sides",
        title: "Side by side",
        blocks: [
          {
            kind: "text",
            text: "Customer rates (sell) on the left and vendor rates (buy) on the right, each with its own filters. **Show** in the header picks Both, Customer or Vendor.",
          },
          {
            kind: "fields",
            title: "Filters on each side",
            fields: [
              { name: "Product category", what: "Tick categories." },
              { name: "Customer trunk / Vendor trunk", what: "Tick trunks." },
              { name: "Country", what: "Tick countries. MCCMNCs outside them drop out." },
              { name: "MCCMNC", what: "Tick single destinations." },
              { name: "Search", what: "Country, network or code.", values: "`%` and `_` wildcards." },
              { name: "Inactive trunks", what: "Include rates of inactive trunks." },
              { name: "Clear filters", what: "Clears that side's filters, including the column filters." },
              {
                name: "Column filters",
                what: "Under each header, like the other grids: Destination (country or network, wildcards), MCCMNC (starts with, or wildcards), and Tables, Price and Sys price with **≥**, **≤** or **Range** (from – to).",
                values:
                  "Price compares each table's own rate in its currency; Sys price the converted rate. Number filters apply when you press Enter or leave the box.",
              },
            ],
          },
          {
            kind: "fields",
            title: "Columns",
            fields: [
              {
                name: "Destination",
                what: "Country · Network. Click a row to open the rate tables that price it, cheapest first.",
              },
              { name: "MCCMNC", what: "The code (or the table's category on an opened row)." },
              { name: "Tables", what: "How many rate tables price the destination." },
              {
                name: "Price",
                what: 'The price range in the tables\' currency (or "several currencies"). On an opened row: the rate, with ▲ or ▼ when a new rate is scheduled.',
              },
              { name: "Sys price", what: "The price in the platform currency. The cheapest table is green." },
            ],
          },
          {
            kind: "tip",
            text: "Click a rate table name to open it in [[rate-manager|Rate manager]]. Click a column header (Destination, Tables, Sys price) to sort.",
          },
        ],
      },
      {
        id: "easy",
        title: "One destination",
        blocks: [
          {
            kind: "fields",
            title: "Search and toggles",
            fields: [
              {
                name: "Search box",
                what: "Type a country, network, MCCMNC, dial code or phone number. Results appear as you type; ↑ ↓ and Enter pick another match.",
              },
              {
                name: "Live lookup (HLR)",
                what: "Resolve a phone number by an HLR lookup instead of its prefix, so a ported number shows its real network.",
              },
              { name: "My clients only", what: "Only clients you manage." },
              { name: "Include inactive", what: "Include inactive trunks and rates." },
              { name: "Show scheduled rates", what: "Show the next rate and its date.", values: "On by default." },
              {
                name: "Original currency / Converted",
                what: "Show rates as entered, or converted to the platform currency.",
              },
            ],
          },
          {
            kind: "fields",
            title: "Vendor costs panel",
            fields: [
              { name: "Vendor trunk", what: "Click to open the trunk." },
              { name: "Tier", what: "T1, T2, T3." },
              {
                name: "Rate",
                what: "Click to open the rate table in Rate manager. The best active cost is green. * means the country rate or another network's rate applies.",
              },
              {
                name: "Since / Scheduled",
                what: "Start of the current rate, and the next rate (amber when it goes up).",
              },
              {
                name: "24h / ASR / DLR",
                what: "The vendor's traffic and quality for the destination in the last 24 hours.",
              },
              { name: "Routed", what: "Routing sends this destination to the vendor for at least one client today." },
            ],
          },
          {
            kind: "fields",
            title: "Client rates panel",
            fields: [
              { name: "Client trunk", what: "Click to open the trunk." },
              { name: "Account mgr", what: "The client's account manager." },
              { name: "Sell", what: "The client's rate. Click to open the table. Red when below the best cost." },
              { name: "7 days", what: "Messages in the last 7 days." },
              { name: "Margin vs best", what: "Sell minus the best vendor cost, amount and %. Red when negative." },
              {
                name: "vs routed",
                what: 'Margin against the vendor routing really uses, with its name, or "not routed".',
              },
            ],
          },
          {
            kind: "text",
            text: "Each panel has **Copy** (paste into a spreadsheet) and **CSV**. **Route rules for this destination** opens Route rules filtered to it; **Compare the country** opens Advanced mode for the whole country.",
          },
        ],
      },
      {
        id: "advanced",
        title: "Advanced",
        blocks: [
          {
            kind: "fields",
            title: "Inputs",
            fields: [
              { name: "Countries", what: "Add countries by name; Enter adds the first match." },
              {
                name: "MCCMNCs or numbers",
                what: "Paste codes or phone numbers, separated by lines, commas or semicolons. The counter shows codes, numbers and anything not read.",
                values: "3–6 digits = MCCMNC, longer = phone number, e.g. `50501, 50502` or `+61412345678`.",
              },
              { name: "Upload file", what: "Adds the codes and numbers from a CSV or text file." },
              {
                name: "View",
                what: "**Vendor costs**, **Client rates**, **Margin matrix** or **Cheapest vendors** (with **N**, 1–10).",
              },
              {
                name: "Filters",
                what: "Clients: Account managers, Customers, Customer trunks, Rate tables. Vendors: Vendors, Vendor trunks, Vendor tier. Both sides: Product categories, Business companies, Rate table currencies, Sender ID.",
              },
              {
                name: "As of",
                what: "Rates valid at this time (UTC): a past date or a scheduled future one.",
                values: "Empty = now.",
              },
              { name: "Include inactive", what: "Include inactive trunks and rates." },
              { name: "Original / platform currency", what: "How rates are shown." },
              {
                name: "Only destinations with",
                what: "**Below-cost sells** (red), **Cheaper than routed**, **Expiring soon** (ends within 14 days with no new version), **Only one vendor**.",
              },
            ],
          },
          {
            kind: "list",
            items: [
              "Click **Look up** to run. **Clear** empties the form. **Save lookup** keeps it under a name and can share it read-only with colleagues; the saved lookups menu reopens one.",
              "Results: **Destination**, **Best** (cheapest active vendor), **Vendors** (how many), **Highlights**, then one column per trunk. When there are too many, the 60 trunks covering most destinations are shown; narrow with filters.",
              "**Update rates** opens bulk rating for the destinations shown (up to 500). **Copy** and **Export CSV** take the results.",
            ],
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ Simulator
  {
    id: "simulator",
    pageKey: "simulator",
    title: "Simulator",
    group: "Routing",
    summary:
      "See what the switch would do with a message on a customer trunk: translation, destination, customer rate, the route rules tried, the vendor, cost and margin.",
    keywords: ["route simulator", "simulate", "test SMS", "TON", "NPI", "data coding", "why not routed"],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: 'The Route Simulator follows one message from a customer trunk all the way to a vendor. NOC staff use it to answer "why did this message fail?" or "where will this go?", and to check a new route before a client starts sending. It can also send a simulated test SMS.',
          },
        ],
      },
      {
        id: "fields",
        title: "Fields in the form",
        blocks: [
          {
            kind: "fields",
            fields: [
              {
                name: "Customer Trunk ID",
                what: "Required. The trunk the message comes in on.",
                values: "Search by ID, name or enterprise.",
              },
              { name: "Sender ID", what: "The sender.", values: "Default `INFO`, up to 20 characters." },
              {
                name: "Send to",
                what: "**Numbers**: type receiver numbers. **Destination**: tick countries or networks; a test number is made from each network's dial code.",
                values: "Numbers comma-separated, up to 20 at once, e.g. `447700900123, 33612345678`.",
              },
              {
                name: "MCCMNC",
                what: "Force the destination, as if HLR found it.",
                values: "Empty = from the number.",
              },
              {
                name: "Source TON / Source NPI",
                what: "The sender's type of number and numbering plan, as sent over SMPP.",
                values:
                  "Automatic from the sender: letters = 5 Alphanumeric / 0 Unknown; up to 8 digits = 3 Network specific; longer = 1 International / 1 ISDN (E.164).",
              },
              {
                name: "Dest TON / Dest NPI",
                what: "The same for the receiver.",
                values: "Automatic from the receiver.",
              },
              {
                name: "Vendor trunk (test directly, skips routing)",
                what: "Send straight to this vendor at its own rate. The route rules are still shown for reference.",
                values: "Empty = by the route rules.",
              },
              {
                name: "Data coding",
                what: "The SMPP character set.",
                values:
                  "0–8. Automatic from the text: 0 (GSM 7-bit) or 8 (UCS-2) when the text has characters outside GSM.",
              },
              {
                name: "Message Text",
                what: "The text. The counter under it shows the coding, characters, bits per character, how many SMS parts and bytes. A warning shows when the text needs UCS-2.",
                values: "Up to 1600 characters.",
              },
              { name: "Test SMS (also send it)", what: "Also send the message and show its delivery receipt." },
              {
                name: "Back to automatic coding and TON / NPI",
                what: "Shown once you change coding or TON / NPI by hand; returns them to automatic.",
              },
            ],
          },
          {
            kind: "text",
            text: "Click **Go** (or press Enter). With several receivers it shows **Go (n)** and one result per receiver.",
          },
        ],
      },
      {
        id: "result",
        title: "What the result shows",
        blocks: [
          {
            kind: "list",
            items: [
              '**Verdict** (green or red): "Routes to vendor (decided by, level) · cost · margin", "Sent straight to vendor (routing skipped)", or why it is blocked.',
              "**Translation**: the sender and receiver before → after the trunk's translation rules, each rule (changed the message, matched, no match, blocked) and the HLR rule.",
              "**Destination and rate**: the destination, the customer rate with its rate table, and the encoding.",
              "**Route**: the deciding rule and its outcome, the vendors tried (Vendor trunk, Level, Cost, Margin, Note), and **Rules tried** with the reason each one matched or not.",
              "The **Test** section of a route rule and **Simulate** on Route rules list **Vendors skipped** the same way: a vendor whose own vendor translation rule blocks the test message is passed over (its Note says so) and the next vendor is chosen.",
              "**Vendor translation**: the egress rules on the chosen vendor trunk, run after routing — the sender, receiver and text the vendor would actually receive, and each rule's result. Routing and the customer rate use the message before this step. A vendor whose own rule blocks the message is skipped and the next vendor is tried; the skipped vendors are listed under **Vendors skipped**. A block on the customer trunk rejects the message before routing.",
              "With several receivers or destinations, each result is headed by the number (if any), then **country · network** and the MCCMNC.",
              "**Test SMS**: a message ID and a receipt status (DELIVRD, UNDELIV, EXPIRED or REJECTD).",
              "The status bar counts how many of the messages would be routed.",
            ],
          },
          {
            kind: "list",
            title: "Reasons a message is blocked",
            items: [
              "Blocked by a translation rule on the trunk.",
              "Unknown destination: no dial code matches the number.",
              "No customer rate for the destination (ESME_RINVDSTADR).",
              "No route rule matches.",
              "Blocked by a route rule.",
              "A route rule matched but no vendor qualifies.",
              "The chosen direct vendor has no rate for the destination.",
            ],
          },
          {
            kind: "tip",
            text: "In the trial the test SMS is simulated: no real message is sent, no EDR is written, and the receipt status is random (mostly DELIVRD).",
          },
          { kind: "text", text: "For the routing logic itself see [[routing-basics|How routing works]]." },
        ],
      },
    ],
  },
];
