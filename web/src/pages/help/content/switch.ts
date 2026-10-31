// Help center: Switch (§6.3 QBR stats, §6.4, §6.5, §8, §13.2, §13.24).
import type { HelpTopic } from "../helpTypes";

export const topics: HelpTopic[] = [
  // ------------------------------------------------------------------ translation rules
  {
    id: "translation-rules",
    pageKey: "translation-rules",
    title: "Translation rules",
    group: "Switch",
    summary:
      "Rewrite or block messages as they pass a trunk: change the sender or receiver, edit the text, override SMPP fields and translate delivery receipts. A rule runs on its trunks as soon as you save it.",
    keywords: [
      "digit rule",
      "digitrule",
      "translation",
      "rewrite",
      "sender id",
      "receiver",
      "DNID",
      "block",
      "content",
      "replace word",
      "remove word",
      "DLR",
      "receipt",
      "TON",
      "NPI",
      "regex",
      "applies to",
      "duplicate to trunk",
      "manipulation",
    ],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "A translation rule looks at each message on a trunk and, when its conditions match, changes it or blocks it. Typical jobs: strip a `00` from the receiver, replace a customer's Sender ID, remove a word a destination does not allow, block messages with short links, or turn a vendor's odd delivery receipt (DLR) status into one the customer understands.",
          },
          {
            kind: "text",
            text: "NOC and routing staff use it daily; Account Managers (account managers) use it when one partner needs special handling. You assign the rule to trunks, enterprises, product categories or all trunks in the same form, so there is no separate step on the trunk.",
          },
          {
            kind: "list",
            title: "Words used on this page",
            items: [
              "**Ingress**: on the way in, on the customer trunk the message arrived on.",
              "**Egress**: on the way out, on the vendor trunk the message is sent to.",
              "**Sender ID**: who the message is from (a name like `ACME` or a number).",
              "**Receiver ID** (also called DNID): the phone number the message goes to.",
              "**MCCMNC**: the code of a mobile network (MCC = country, MNC = network). A 3-digit MCC alone is only the country’s “All networks” entry, not every network.",
              "**Regex** (regular expression): a pattern language for text. `^` means “starts with”, `$` “ends with”, `[0-9]` one digit, `+` “one or more”.",
              "**DLR**: the delivery receipt a vendor sends back (for example `DELIVRD` or `UNDELIV`).",
            ],
          },
        ],
      },
      {
        id: "layout",
        title: "What you see on the page",
        blocks: [
          {
            kind: "text",
            text: "The page uses the standard layout: header with the **Add rule** button, the filter card with the quick search box, the rules grid with a filter under each column, a detail panel on the right for the selected rule and the status bar. See [[layout]] and [[grids-and-filters]].",
          },
          {
            kind: "fields",
            title: "Grid columns",
            fields: [
              { name: "ID", what: "The rule's number. Rules are sorted by ID by default." },
              { name: "Name", what: "The rule's name, in bold." },
              {
                name: "Type",
                what: "Ingress or Egress when the rule forces it; grey “implied” when the trunk decides (customer trunk = ingress, vendor trunk = egress).",
              },
              { name: "Action", what: "**Allow** (rewrite) or **Block**. Block shows in red." },
              {
                name: "Continues",
                what: "Yes = later rules still run after this one matches. **No** (bold) = the trunk stops after this rule.",
              },
              { name: "Sender ID", what: "The Sender ID pattern the rule matches, if any." },
              { name: "DNID", what: "The receiver pattern the rule matches, if any." },
              {
                name: "MCCMNC",
                what: "The networks the rule is limited to, by name in bold: the first two, then “+N”. Point at the cell to see them all. Filter: a country, a network or a code, for example `France`, `Orange` or `208`.",
              },
              { name: "Message Text", what: "The text pattern the rule matches, if any." },
              {
                name: "Sender ID Conversion Type",
                what: "How the Sender ID is changed (Left Strip, Prepend, Translation…).",
              },
              {
                name: "Sender ID Conversion",
                what: "The value used by that conversion, or the number list name for Random Number and Sender ID Template.",
              },
              { name: "Status", what: "Active, or grey Inactive. Inactive rows are dimmed and never run." },
              {
                name: "Applies To",
                what: "A summary of the targets in bold, for example “3 customer trunks, 1 enterprise”. Point at it to see every trunk, enterprise and category by name. **Not assigned** in amber means the rule runs nowhere.",
              },
              { name: "Used by", what: "How many live trunks the rule actually reaches through its targets." },
              { name: "Updated By", what: "Who saved the rule last." },
            ],
          },
          {
            kind: "list",
            title: "Detail panel tabs",
            items: [
              "**Rule**: buttons **Edit**, **Clone**, **Duplicate to trunk** (only when the rule runs somewhere) and **Delete**; a one-line summary of what the rule does; then Type, Action, Continues, Sender ID conversion, the time Window and who updated it.",
              "**Used by (n)**: every trunk the rule reaches, with its enterprise, **Through** (directly, its enterprise, its category or all trunks) and **On** (“Off here” when that trunk has switched the rule off). Click a trunk to open its Rules tab.",
              "**Test**: run a sample message through the saved rule. See [[translation-rules#test]].",
              "**History**: every saved change to this rule, with who and when. See [[undo-and-history]].",
            ],
          },
          {
            kind: "tip",
            text: "An amber **Cleanup** badge in the header appears when the Cleanup Center has found rules that are not assigned to anything. Click it to review them.",
          },
        ],
      },
      {
        id: "fields-rule",
        title: "Fields: Rule",
        blocks: [
          {
            kind: "fields",
            title: "Rule section",
            fields: [
              {
                name: "Name",
                what: "A clear name staff will recognise.",
                values: "Required, up to 100 characters. Example: `Strip 00 for Acme Mobile`.",
              },
              {
                name: "Type",
                what: "Forces the rule to run on the way in or out. Leave it empty in almost all cases: the trunk decides (a customer trunk means ingress, a vendor trunk egress). The note next to the section title shows what the rule will be.",
                values: "Empty (**Implied by the trunk**, default), **Ingress** or **Egress**.",
              },
              {
                name: "Status",
                what: "Only active rules run on traffic.",
                values: "**Active** (default) or **Inactive**.",
              },
              {
                name: "Action",
                what: "What happens when the conditions match. **Block** rejects the message and hides all rewrite sections.",
                values: "**Allow (rewrite)** (default) or **Block**.",
              },
              {
                name: "Is Continue",
                what: "A small switch: **YES · next rules** carries on with the trunk's next rule after this one matches; **STOP** makes this rule the last one to run for a matching message. A trunk can override this for itself on its Rules tab.",
                values: "STOP by default for a new rule.",
              },
              {
                name: "Start",
                what: "The rule only runs from this date and time.",
                values: "Date and time in UTC. Empty = from now.",
              },
              {
                name: "Stop",
                what: "The rule stops running at this date and time.",
                values: "Date and time in UTC. Empty = no end. Must be after Start.",
              },
            ],
          },
        ],
      },
      {
        id: "fields-applies-to",
        title: "Fields: Applies to",
        blocks: [
          {
            kind: "text",
            text: "This section decides where the rule runs. Saving applies it everywhere it targets, straight away.",
          },
          {
            kind: "fields",
            title: "Applies to section",
            fields: [
              {
                name: "Customer trunks (ingress) / Vendor trunks (egress)",
                what: "Switches which side you are picking targets for. A rule can have targets on both sides.",
              },
              {
                name: "All customer trunks / All vendor trunks",
                what: "Tick to run the rule on every trunk of that side. The pickers below are hidden while it is ticked.",
              },
              {
                name: "Trunks",
                what: "Pick individual trunks. Search by trunk name or enterprise. The number in brackets shows how many you picked.",
              },
              {
                name: "Enterprises",
                what: "Pick enterprises: the rule runs on all their trunks of the chosen side, including trunks added later.",
              },
              {
                name: "Product categories",
                what: "Pick product categories: the rule runs on every trunk in them, including trunks added later.",
              },
              {
                name: "Position on trunks",
                what: "Where the rule goes in a trunk's list when that trunk has not placed it yet. Trunks that already ordered the rule keep their order.",
                values:
                  "**After the ordered rules** (insert at the bottom, default) or **Before the ordered rules** (insert at the top).",
              },
            ],
          },
          {
            kind: "text",
            text: "The line under the picker sums up the targets, or says “Not assigned: the rule runs nowhere until it applies to something.”",
          },
        ],
      },
      {
        id: "fields-match",
        title: "Fields: Match conditions",
        blocks: [
          {
            kind: "text",
            text: "All conditions you fill in must hold for the rule to match. Empty conditions are ignored, so a rule with no conditions matches every message. Most conditions have a **Match / Not Match** switch: **Not Match** turns the condition around (for example “the Sender ID is NOT in this list”).",
          },
          {
            kind: "text",
            text: "The section is one compact grid: a row each for **Sender ID** (with **Case sensitive** under its name), **Receiver ID**, **Message text** and **MCCMNC**; columns **Pattern (regex)** and **Number list / networks**. Each pattern and list has its own Match / Not Match switch. Under Sender ID and Receiver ID, **values** lists exact values as rows: click **Add Sender ID** (or **Add Receiver**), type the value, pick **Is**, **Starts with** or **Contains**, and for Sender IDs tick **Case sensitive** per row. Any row matching is a hit; the Match / Not Match after the pattern applies to the rows too. Paste a list (one per line or comma separated) into a row to get one row each. **Case sensitive** under the Sender ID name is for the pattern and the list only. For MCCMNC, type a pattern or click **Pick networks…** to tick countries and networks in a window (the row then shows how many and which; **Clear** empties it).",
          },
          {
            kind: "fields",
            title: "Match conditions section",
            fields: [
              {
                name: "Sender ID (regex)",
                what: "A pattern the Sender ID must match.",
                values: "Regex, up to 500 characters. Example: `^[A-Z]+$` (letters only), `^TEST`.",
              },
              {
                name: "Case sensitive (next to Sender ID)",
                what: 'Ticked: the Sender ID pattern and the Sender ID List must match the exact capitals (`BANK` does not match "Bank"). Cleared: any mix of capitals matches, and the rule summary shows **(any case)**. Receiver and text conditions are not affected.',
                values: "Ticked by default.",
              },
              {
                name: "Keywords \\Numeric and \\Alpha",
                what: "Sender ID only. `\\Numeric` in the Sender ID pattern matches numeric Sender IDs; `\\Alpha` matches Sender IDs with at least one letter.",
              },
              {
                name: "Receiver ID (regex)",
                what: "A pattern the receiver number must match.",
                values: "Regex. Example: `^00` (starts with 00), `^4477`.",
              },
              {
                name: "Message Body Text (regex)",
                what: "A pattern the message text must contain.",
                values: "Regex. Example: `bit\\.ly` (a short link; the backslash makes the dot literal).",
              },
              {
                name: "Sender ID List",
                what: "The Sender ID must be (or, with Not Match, must not be) one of the entries in a number list. Any list type can be used. **New list** creates a list without leaving the form. Capitals count unless Case sensitive is cleared.",
                values:
                  "Pick a list from [[number-lists]]. In a Sender ID Template entry each `{n}` stands for one digit.",
              },
              {
                name: "Receiver ID List",
                what: "The receiver must be (or must not be) in the chosen number list.",
                values: "Pick a list, or create one with **New list**.",
              },
              {
                name: "MCCMNC",
                what: "Limits the rule to the receiver's network. Tick countries and networks in the tree; search by country, network or code (`%` and `_` wildcards), with **Select all** / **Clear all** (or **Select shown** / **Clear shown** while searching).",
                values:
                  "Network codes like `23410`. A 3-digit MCC (for example `234`) is the country's “All networks” entry only; to cover every network in a country, tick the whole country in the tree.",
              },
              {
                name: "MCCMNC (regex)",
                what: "A regular expression on the receiver's MCCMNC code, instead of (or as well as) ticking networks. A network matches when it is ticked or matches the pattern; **Not Match** next to MCCMNC turns both around.",
                values: "For example `^415` (every Lebanese network) or `^(415|420)`. Empty = not used.",
              },
              {
                name: "Sender ID values / Receiver values",
                what: "Exact values as rows, each with its own match and (Sender ID only) its own case. Any row matching is a hit.",
                values: "Match: **Is** (the whole value), **Starts with** or **Contains**. Case sensitive on by default for a new Sender ID row; a new row copies the match and case of the row above.",
              },
            ],
          },
          {
            kind: "tip",
            text: "Leaving the lengths at 0 and 20 means “no length check”.",
          },
        ],
      },
      {
        id: "fields-conversion",
        title: "Fields: Sender and receiver conversion",
        blocks: [
          {
            kind: "text",
            text: "These fields change the Sender ID and the receiver number. They are hidden when the Action is Block.",
          },
          {
            kind: "fields",
            title: "Conversion types",
            fields: [
              {
                name: "Left Strip",
                what: "Removes characters from the start.",
                values: "Value = how many, 1–99. `2` turns `0044…` into `44…`.",
              },
              { name: "Right Strip", what: "Removes characters from the end.", values: "Value = how many, 1–99." },
              {
                name: "Prepend",
                what: "Adds text in front.",
                values: "Value = the text. `+` turns `447…` into `+447…`.",
              },
              { name: "Append", what: "Adds text at the end.", values: "Value = the text." },
              {
                name: "Translation",
                what: "Replaces the whole value with a new one. With `from=to` it swaps a prefix instead.",
                values: "`INFO` makes every matching Sender ID become `INFO`. `00=+` turns `0044…` into `+44…`.",
              },
              {
                name: "Regex Replace",
                what: "Rewrites any part that matches a pattern. Shows a **Pattern** and a **Replace with** field.",
                values:
                  "Pattern `^0(\\d+)`, Replace with `44$1` turns `07700…` into `447700…`. `$1`…`$9` insert the pattern's groups; an empty Replace with removes the match.",
              },
              {
                name: "Random Number",
                what: "Sender ID only. Replaces the Sender ID with a random entry from a Random number list.",
                values: "Shows **Random list** instead of Value. Only Random lists can be picked.",
              },
              {
                name: "Sender ID Template",
                what: "Sender ID only. Picks a random entry from a Sender ID Template list; each `{n}` becomes a random digit. If the entry has a content template, the message text is replaced too (`{code}` = the code found in the original text, `{text}` = the original text).",
                values: "Shows **Template list**. Only Sender ID Template lists can be picked.",
              },
            ],
          },
          {
            kind: "fields",
            title: "Fields in this section",
            fields: [
              {
                name: "Sender ID Conversion",
                what: "How to change the Sender ID.",
                values: "**None** (default) or one of the types above.",
              },
              {
                name: "Value / Pattern",
                what: "The value the conversion uses. Greyed out while the conversion is None. The hint under the field explains what to enter.",
                values: "Up to 200 characters.",
              },
              {
                name: "Random list / Template list",
                what: "The number list used by Random Number or Sender ID Template. **New list** creates one of the right type.",
              },
              {
                name: "Replace with",
                what: "Regex Replace only: what each match becomes.",
                values: "Up to 100 characters. Empty removes the match.",
              },
              {
                name: "Receiver ID Conversion",
                what: "How to change the receiver number. Same types as above except Random Number and Sender ID Template.",
                values: "**None** (default), Left Strip, Right Strip, Prepend, Append, Translation or Regex Replace.",
              },
            ],
          },
          {
            kind: "tip",
            text: "When the receiver changes, the network (MCCMNC) is looked up again from the new number, so later rules and routing see the new network.",
          },
        ],
      },
      {
        id: "fields-smpp",
        title: "Fields: SMPP field overrides",
        blocks: [
          {
            kind: "text",
            text: "SMPP is the protocol used between partners. These fields force values in the message. Leave a field on **Keep** to leave the message as it is.",
          },
          {
            kind: "fields",
            title: "SMPP field overrides section",
            fields: [
              {
                name: "Sender TON",
                what: "Type of number of the sender.",
                values:
                  "Keep, `0 Unknown`, `1 International`, `2 National`, `3 Network specific`, `4 Subscriber number`, `5 Alphanumeric`, `6 Abbreviated`. Use 5 for names like `ACME`, 1 for international numbers.",
              },
              {
                name: "Sender NPI",
                what: "Numbering plan of the sender.",
                values:
                  "Keep, `0 Unknown`, `1 ISDN (E.164)`, `3 Data (X.121)`, `4 Telex`, `6 Land mobile`, `8 National`, `9 Private`, `10 ERMES`, `14 Internet (IP)`, `18 WAP client ID`.",
              },
              {
                name: "Billing Type",
                what: "The billing event recorded for the message.",
                values: "Keep, Attempt, Submit, Reported or Delivery.",
              },
              {
                name: "Destination TON",
                what: "Type of number of the receiver.",
                values: "Same choices as Sender TON.",
              },
              {
                name: "Destination NPI",
                what: "Numbering plan of the receiver.",
                values: "Same choices as Sender NPI.",
              },
              {
                name: "Registered Delivery",
                what: "Whether a delivery receipt is requested.",
                values: "Keep, `0 No receipt` or `1 Receipt`.",
              },
            ],
          },
        ],
      },
      {
        id: "fields-dlr",
        title: "Fields: DLR Status & Error Code Convert",
        blocks: [
          {
            kind: "text",
            text: "Translates the delivery receipt a vendor sends into what the customer receives. Click **Add DLR conversion** for each line (up to 50) and the **×** to remove one.",
          },
          {
            kind: "fields",
            title: "One conversion line",
            fields: [
              {
                name: "Vendor stat",
                what: "The status the vendor sends. Matched without regard to case.",
                values: "Up to 10 characters, saved in capitals. Example: `UNKNOWN`.",
              },
              {
                name: "Vendor err",
                what: "The vendor's error code. Empty = any error code.",
                values: "Example: `000`, or empty.",
              },
              { name: "Customer stat", what: "The status the customer gets instead.", values: "Example: `UNDELIV`." },
              {
                name: "Customer err",
                what: "The error code the customer gets. Empty = keep the vendor's error code.",
                values: "Example: `001`, or empty.",
              },
            ],
          },
          { kind: "tip", text: "The first line that matches the vendor's stat (and error, if given) is used." },
        ],
      },
      {
        id: "fields-content",
        title: "Fields: Content rewrite",
        blocks: [
          {
            kind: "text",
            text: "Changes the message text. The steps run in this order: first the word replacements, then the regex rewrite, then the MSG Template.",
          },
          {
            kind: "fields",
            title: "Replace or remove words",
            fields: [
              {
                name: "Find word or phrase",
                what: "The word or phrase to look for, exactly as typed (no regex). Blank lines are dropped when you save.",
                values: "Up to 200 characters. Example: `free`.",
              },
              {
                name: "Replace with (empty = remove)",
                what: "What the word becomes. Leave empty to remove the word; the extra space it leaves is tidied up.",
                values: "Up to 500 characters. Example: `no charge`, or empty.",
              },
              {
                name: "Not part of a word",
                what: "Only matches the word on its own, not inside a longer word (`free` does not match `freedom`). Works for Arabic and accented letters too.",
                values: "Ticked by default.",
              },
              {
                name: "Case sensitive",
                what: 'Only matches the exact capitals you typed: with `code`, "Code", "cOde" and "CODE" are left alone. Clear it to match any mix of capitals.',
                values: "Ticked by default.",
              },
            ],
          },
          {
            kind: "text",
            text: "Click **Add word** for each word or phrase (up to 50) and the **×** to remove one.",
          },
          {
            kind: "fields",
            title: "Format numbers",
            fields: [
              {
                name: "Number pattern",
                what: "Formats every number in the text with a digit pattern: `#` stands for one digit. A longer number repeats the last group. Click a common pattern to use it, or again to clear it.",
                values: "Empty = off. Example: `### ### ###` turns `210271019` into `210 271 019`.",
              },
              {
                name: "From … digits",
                what: "Only numbers with at least this many digits are formatted.",
                values: "2–20. Default 6.",
              },
              {
                name: "Sample text",
                what: "Type a sample to see the result next to it. Not saved.",
              },
            ],
          },
          {
            kind: "fields",
            title: "Regex rewrite and template",
            fields: [
              {
                name: "Regex Pattern",
                what: "A pattern to find in the text. Every match is rewritten.",
                values: "Regex, up to 500 characters. Example: `code ([0-9]+)`.",
              },
              {
                name: "Regex Index",
                what: "Which group of the pattern to replace. Empty = replace the whole match.",
                values: "1–5. Must not be higher than the number of groups in the pattern.",
              },
              {
                name: "Message Text",
                what: "What the match (or group) becomes. `$1`…`$9` insert what the pattern's brackets caught and `$0` the whole match, so you can pull a part out into new text. Greyed out until a Regex Pattern is entered; required once there is one.",
                values:
                  "Up to 1,000 characters. Empty text removes the match. Example: Regex Pattern `^.*?([0-9]{4,8}).*$` with Message Text `PIN $1 for you` turns `Your code is 482913. FREE gift at bit.ly/x` into `PIN 482913 for you`.",
              },
              {
                name: "MSG Template",
                what: "Replaces the whole text. `{text}` is the text after the steps above.",
                values: "Up to 1,000 characters. Example: `[Brand] {text}`.",
              },
            ],
          },
          {
            kind: "text",
            text: "Under the form a grey line sums up the whole rule in plain words, for example “When receiver ~ ^00: receiver left strip 2”. Check it before you save.",
          },
        ],
      },
      {
        id: "how-to-add",
        title: "How to add a rule",
        blocks: [
          {
            kind: "steps",
            items: [
              "Click **Add rule** in the page header.",
              "Enter a **Name**, keep **Status** Active and choose the **Action**.",
              "In **Applies to**, choose the side, then pick trunks, enterprises or product categories (or tick All). Choose **Position on trunks**.",
              "Fill in the **Match conditions** that pick the messages you want.",
              "For an Allow rule, fill in the conversions, SMPP overrides, DLR conversions or content rewrite you need.",
              "Read the summary line at the bottom of the form.",
              "Click **Add rule**. The rule runs on its trunks at once and is selected in the grid.",
              "Open the **Test** tab and run a sample message to confirm the result.",
            ],
          },
        ],
      },
      {
        id: "how-to-edit",
        title: "How to edit, clone or duplicate a rule",
        blocks: [
          {
            kind: "steps",
            title: "Edit",
            items: [
              "Double-click the row (or press Enter), or click **Edit** in the detail panel.",
              "Change the fields. To try your changes before saving, click **Test this form** at the bottom: it runs a sample message through the form as it is now, without saving.",
              "Click **Save**. If the rule runs on more than one trunk you are asked to confirm “Save on n trunks”.",
            ],
          },
          {
            kind: "steps",
            title: "Clone",
            items: [
              "Select the rule and click **Clone** in the detail panel (or Clone in the row's menu).",
              "A new rule window opens filled from the rule, named “… (copy)” and **Inactive**; nothing is saved yet.",
              "Change what differs, check its targets and click **Add rule**. Set it Active when ready; Cancel saves nothing.",
            ],
          },
          {
            kind: "steps",
            title: "Duplicate to trunk (a variant for one partner)",
            items: [
              "Select a shared rule and click **Duplicate to trunk**.",
              "Pick one of the trunks the rule runs on and click **Duplicate**.",
              "The copy is active on that trunk only, in the same position; the original stops running there. The other trunks keep the original.",
              "Edit the copy for that partner.",
            ],
          },
        ],
      },
      {
        id: "how-to-delete",
        title: "How to delete a rule",
        blocks: [
          {
            kind: "steps",
            items: [
              "Right-click the row and choose **Delete…**, or click **Delete** in the detail panel.",
              "Review what depends on the rule and confirm.",
              "The rule is archived, not destroyed: it stops running everywhere. An administrator can **Restore** it.",
            ],
          },
          {
            kind: "warning",
            text: "A rule assigned to a live trunk or enterprise cannot be deleted, not even with an administrator override. The delete window lists those trunks and enterprises in red: remove the rule from them first. A rule for all trunks or for a category does not block the delete; it just stops running there.",
          },
          { kind: "text", text: "See [[safe-delete]]. Ctrl+Z undoes your last change; see [[undo-and-history]]." },
        ],
      },
      {
        id: "test",
        title: "How to test a rule",
        blocks: [
          {
            kind: "text",
            text: "The **Test** tab runs the saved rule on a sample message, whatever its status and targets. The **Test this form** button in the editor runs the unsaved form instead. To test all rules of one trunk in order, use the Test on the trunk's Rules tab (see [[trunk-record]]).",
          },
          {
            kind: "fields",
            title: "Test fields",
            fields: [
              { name: "Sender ID", what: "The sample Sender ID.", values: "Example: `ACME`." },
              { name: "Receiver", what: "The sample receiver number. Required.", values: "Example: `00447700900123`." },
              { name: "Sender TON / Sender NPI", what: "Optional sample values.", values: "Numbers 0–6 and 0–18." },
              { name: "Text", what: "The sample message text.", values: "Up to 2,000 characters." },
              {
                name: "Vendor DLR stat",
                what: "Optional: a vendor receipt status, to check the DLR conversions.",
                values: "Example: `UNDELIV`.",
              },
            ],
          },
          {
            kind: "list",
            title: "Reading the result",
            items: [
              "The headline says **Blocked** (red), “n rules changed the message” (green) or **No change**.",
              "A table shows each field **Before** and **After**; changed rows are highlighted.",
              "Each rule shows whether it matched, every condition with a tick or a cross and why (for example “length 9, allowed 10-15”), what it changed, and “Stop” when it ended the run.",
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
              "Each trunk has an ordered list of rules (its Rules tab). The trunk runs them top to bottom; order, on/off and Continue can be set per trunk without changing the rule.",
              "A rule matches when every condition holds, it is active, and the current time is inside Start and Stop.",
              "A matching **Block** rule rejects the message and ends the run. A matching rule with **Is Continue** cleared ends the run after it rewrites.",
              "A matching Allow rule applies, in order: Sender ID conversion, receiver conversion (and new network lookup), SMPP overrides, DLR conversion, then the content rewrite. The next rule sees the rewritten message.",
              "Customer-trunk (ingress) rules run before routing, so route rules see the rewritten receiver and network. Vendor-trunk (egress) rules change what the vendor receives.",
              "Targets on an enterprise or product category follow the trunks: a new trunk in that enterprise or category gets the rule automatically.",
              "Every save is one change in the history and can be undone.",
            ],
          },
          {
            kind: "text",
            text: "Related: [[number-lists|Number lists]], [[hlr|HLR]], [[route-rules|Route rules]], [[simulator|Simulator]].",
          },
        ],
      },
      {
        id: "tips",
        title: "Tips and things to watch",
        blocks: [
          {
            kind: "warning",
            text: "Saving a rule used by several trunks changes it on all of them. When only one partner needs something different, use **Duplicate to trunk** instead.",
          },
          {
            kind: "warning",
            text: "The save is refused with highlighted fields when a pattern is not a valid regex, a conversion has no value (strip needs 1–99, prepend/append need text, translation needs the new value), a list of the wrong type is picked, an MCCMNC code is unknown, Min length is above Max, Stop is not after Start, or Regex Index is higher than the pattern's groups.",
          },
          {
            kind: "tip",
            text: "A rule with no conditions matches every message on its trunks. Always add at least one condition unless that is really what you want.",
          },
          {
            kind: "tip",
            text: "A rule shown as **Not assigned** does nothing. Either add targets or delete it.",
          },
          {
            kind: "tip",
            text: "In the grid, a Sender ID filter like `^TEST` finds rules whose pattern contains that text.",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ HLR
  {
    id: "hlr",
    pageKey: "hlr",
    title: "HLR",
    group: "Switch",
    summary:
      "Set up HLR and number-portability lookups: the providers you query and their prices, the rules that decide which provider a customer trunk asks, and the policies route rules use.",
    keywords: [
      "HLR",
      "MNP",
      "NPQ",
      "number portability",
      "ported",
      "lookup",
      "number check",
      "provider",
      "cache",
      "policy",
      "DNID pattern",
      "home location register",
    ],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "An HLR (Home Location Register) lookup asks an outside provider which network a phone number really belongs to today. This matters when a number has been ported (moved to another network): the message must be routed and billed for the new network. An MNP / NPQ provider answers only the porting question; a number check provider says whether the number exists.",
          },
          {
            kind: "text",
            text: "Routing and NOC staff use this page to add providers, keep their prices, and decide which numbers are looked up and by whom. The page has three views, chosen with the **Providers / Rules / Policies** switch above the grid.",
          },
          {
            kind: "list",
            items: [
              "**Providers**: who you query, how, what it costs, and how they perform.",
              "**Rules**: on a customer trunk, which provider is asked for which numbers.",
              "**Policies**: per destination, which providers to try in which order and how long to keep answers. Route rules use a policy in their HLR action.",
            ],
          },
        ],
      },
      {
        id: "providers-view",
        title: "Providers view",
        blocks: [
          {
            kind: "text",
            text: "Live status and figures cover the last 24 hours and refresh every 5 minutes. The header button is **Add provider**.",
          },
          {
            kind: "fields",
            title: "Provider grid columns",
            fields: [
              { name: "ID", what: "The provider's number." },
              { name: "Provider Name", what: "The provider's name." },
              { name: "Type", what: "HLR, MNP / NPQ or Number check." },
              {
                name: "Live",
                what: "Current health: green **Up**, amber **Slow**, red **Down**, grey **Inactive**.",
              },
              { name: "Lookups 24 h", what: "Lookups in the last 24 hours (live and cached)." },
              { name: "Success", what: "Share of lookups that succeeded. Shown in amber below 90 %." },
              { name: "Avg ms", what: "Average response time in milliseconds." },
              { name: "Cost 24 h", what: "What the lookups cost in the last 24 hours, in the platform currency." },
              { name: "Default Rate", what: "Price per live lookup for destinations without their own price." },
              { name: "Currency", what: "The provider's currency." },
              { name: "Prices", what: "How many destinations have their own price." },
              { name: "Cache (days)", what: "How long answers are kept and reused." },
              { name: "Rules", what: "HLR rules that use this provider." },
              { name: "Policies", what: "HLR policies that list this provider." },
              { name: "Status", what: "Active or Inactive." },
            ],
          },
          {
            kind: "text",
            text: "The **Provider** tab in the detail panel shows live figures (lookups split into live and cached, success, average time against the timeout, cost, ported numbers), the request (GET or POST and the URL), credentials (user and whether a password is stored), price, cache and budget, what uses it, and the response mapping. Buttons: **Edit**, **Prices (n)** and **Delete**. The **History** tab lists changes.",
          },
        ],
      },
      {
        id: "fields-provider",
        title: "Fields: provider form",
        blocks: [
          {
            kind: "fields",
            title: "Provider section",
            fields: [
              {
                name: "Provider Name",
                what: "The name shown everywhere.",
                values: "Required, up to 100 characters. Example: `Lookupia HLR`.",
              },
              {
                name: "Type",
                what: "What the provider answers.",
                values: "**HLR** (default), **MNP / NPQ** or **Number check**.",
              },
              { name: "Status", what: "Inactive providers are never asked.", values: "Active (default) or Inactive." },
              { name: "Currency", what: "The currency of the provider's prices.", values: "Required. Default EUR." },
              {
                name: "Default Rate",
                what: "Price per live lookup where a destination has no price of its own. Cached answers cost nothing.",
                values: "0–1, up to 6 decimals. Default `0.002`.",
              },
              {
                name: "Enable Caching",
                what: "How many days an answer is kept and reused instead of asking again. A policy can set its own cache times.",
                values: "0–7 days. `0` = no cache. Default 1.",
              },
              {
                name: "Timeout",
                what: "How long to wait for an answer before giving up (and trying the next provider in a policy).",
                values: "100–30,000 ms. Default 1,500.",
              },
              {
                name: "Daily Budget",
                what: "Once this much is spent in a day, the provider is skipped for the rest of the day.",
                values: "Amount in the provider's currency. Empty = no limit.",
              },
            ],
          },
          {
            kind: "fields",
            title: "Request section",
            fields: [
              {
                name: "URL",
                what: "The provider's address. `{DNID}` is replaced by the phone number.",
                values: "Required. Example: `https://api.example.com/lookup?msisdn={DNID}`.",
              },
              { name: "UserName", what: "Login for the provider, if it needs one.", values: "Up to 100 characters." },
              {
                name: "Password",
                what: "The provider's password. It is stored and never shown again. When editing, leave it empty to keep the stored one, or type a new one to replace it.",
              },
              {
                name: "Extra Headers",
                what: "Extra request headers, one per line.",
                values: "Example: `X-Api-Key: demo-key-123`.",
              },
              {
                name: "Data (POST body)",
                what: "When filled, the request is sent as a POST with this body; when empty, as a GET.",
                values: 'Example: `{"msisdn":"{DNID}"}`.',
              },
            ],
          },
          {
            kind: "fields",
            title: "Response mapping section",
            fields: [
              {
                name: "MCC",
                what: "Where the country code is found in the answer. Required.",
                values: "Default `mcc`.",
              },
              { name: "MNC", what: "Where the network code is found. Required.", values: "Default `mnc`." },
              {
                name: "MCCMNC",
                what: "Where the combined network code is found. Required.",
                values: "Default `mccmnc`.",
              },
              {
                name: "Old MCC / Old MNC / Old MCCMNC",
                what: "Where the original network (before porting) is found. Optional.",
              },
              { name: "Ported", what: "Where the “is ported” flag is found.", values: "Default `ported`." },
              {
                name: "Error Code / Error String",
                what: "Where the provider's error code and message are found. Optional.",
              },
              {
                name: "Success Codes",
                what: "Which codes in the answer mean success.",
                values: "Default `0`.",
              },
              { name: "Number Check", what: "Where a number-check result is found (number check providers)." },
              { name: "DNID Score", what: "Where a number quality score is found, if the provider gives one." },
            ],
          },
          {
            kind: "tip",
            text: "Copy the field names from the provider's API documentation. Each mapping says where that value sits in the provider's reply.",
          },
        ],
      },
      {
        id: "provider-prices",
        title: "Provider prices",
        blocks: [
          {
            kind: "text",
            text: "Click **Prices (n)** on a provider to open its price list in the same tab. Every destination not listed uses the provider's Default Rate. A network's own price wins over its country's (the country's All networks code).",
          },
          {
            kind: "fields",
            title: "Price grid columns",
            fields: [
              { name: "Country / Network / MCCMNC", what: "The destination." },
              { name: "Rate", what: "Price per live lookup, in the provider's currency." },
              { name: "Updated By / Updated Time", what: "Who changed the price last, and when (UTC)." },
            ],
          },
          {
            kind: "fields",
            title: "Set a destination price",
            fields: [
              {
                name: "Destination",
                what: "The country or network. Pick the country's All networks code to set the default for its networks without their own price. Fixed when editing.",
                values: "Required. Search by country, network or MCCMNC.",
              },
              { name: "Rate", what: "The price per live lookup.", values: "Required, 0–1, up to 6 decimals." },
            ],
          },
          {
            kind: "steps",
            title: "Manage prices",
            items: [
              "Click **Set price** to add one, or double-click a row to edit it.",
              "Select rows with Space or the check boxes and use **Remove n prices** to delete several at once.",
              "Click **Import Rate** to load a file with columns `mccmnc` and `rate`. Existing prices are updated, new ones added; you can also choose to remove prices that are missing from the file.",
              "Use Export in the header to download the price list.",
              "Click **All providers** to go back.",
            ],
          },
        ],
      },
      {
        id: "rules-view",
        title: "Rules view",
        blocks: [
          {
            kind: "text",
            text: "An HLR rule says: on these customer trunks, numbers matching this pattern are looked up with this provider. On a trunk the rules are checked top to bottom and the first rule whose DNID pattern matches decides the provider.",
          },
          {
            kind: "fields",
            title: "Rule grid columns",
            fields: [
              { name: "ID", what: "The rule's number." },
              { name: "Rule Name", what: "The rule's name." },
              { name: "Provider Name", what: "The provider asked." },
              { name: "Type", what: "The provider's type." },
              { name: "DNID Pattern", what: "The receiver pattern the rule matches." },
              { name: "Status", what: "Active, or Inactive (row dimmed)." },
              {
                name: "Applies To",
                what: "Summary of the targets in bold. Point at it to see every trunk, enterprise and category by name. **Not assigned** in amber = runs nowhere.",
              },
              { name: "Used by", what: "Live customer trunks the rule reaches." },
              { name: "Updated By", what: "Who saved it last." },
            ],
          },
          {
            kind: "text",
            text: "Detail panel: **Rule** (provider, pattern, targets, status and position, with **Edit** and **Delete**), **Used by (n)** (trunks, how they are reached, and “Off here” where a trunk switched the rule off) and **History**.",
          },
        ],
      },
      {
        id: "fields-rule",
        title: "Fields: HLR rule form",
        blocks: [
          {
            kind: "fields",
            title: "Rule section",
            fields: [
              { name: "Rule Name", what: "A clear name.", values: "Required, up to 100 characters." },
              {
                name: "Provider Name",
                what: "The provider to ask.",
                values: "Required. Search live HLR, MNP or number check providers.",
              },
              {
                name: "DNID Pattern",
                what: "A regex on the receiver number after translation rules have run.",
                values: "Required. Starts as `^`. Example: `^44` (UK numbers), `^4477`.",
              },
              {
                name: "Try a number",
                what: "Type a sample number to check the pattern as you type: green “matches”, grey “no match” or red “invalid pattern”. Not saved.",
                values: "Example: `447700900123`.",
              },
              { name: "Status", what: "Only active rules run.", values: "Active (default) or Inactive." },
              {
                name: "Position on trunks",
                what: "Where the rule goes on a trunk that has not placed it yet.",
                values: "**After the ordered rules** (default) or **Before the ordered rules**.",
              },
            ],
          },
          {
            kind: "fields",
            title: "Applies to section",
            fields: [
              { name: "All customer trunks", what: "Tick to run the rule on every customer trunk." },
              { name: "Customer trunks", what: "Pick individual customer trunks." },
              { name: "Enterprises", what: "Pick enterprises: all their customer trunks, including new ones." },
              { name: "Product categories", what: "Pick categories: all customer trunks in them, including new ones." },
            ],
          },
          {
            kind: "text",
            text: "Saving applies the rule everywhere it targets, straight away. With no targets the form says **Not assigned**: the rule runs on no trunk.",
          },
          {
            kind: "tip",
            text: "HLR rules apply to customer trunks only. If a rule runs on more than one trunk, saving asks you to confirm “Save on n trunks”.",
          },
          {
            kind: "warning",
            text: "An HLR rule assigned to a live trunk or enterprise cannot be deleted, not even with an administrator override; the delete window shows those items in red. Remove the rule from those trunks / enterprises first. A rule for all customer trunks or a category does not block; it just stops running there.",
          },
        ],
      },
      {
        id: "policies-view",
        title: "Policies view",
        blocks: [
          {
            kind: "text",
            text: "A policy lists, per destination, which providers to ask and how long to keep answers. Route rules use a policy in their HLR action; when they do, the policy wins over the trunk's HLR rules.",
          },
          {
            kind: "fields",
            title: "Policy grid columns",
            fields: [
              { name: "ID", what: "The policy's number." },
              { name: "Policy", what: "The policy's name." },
              { name: "Status", what: "Active or Inactive." },
              { name: "Destinations", what: "How many destination entries it has." },
              { name: "Catch-all", what: "Yes when it has an entry for every other destination." },
              { name: "Providers", what: "The providers it uses." },
              { name: "Route rules", what: "How many route rules use it." },
              { name: "Updated By / Updated Time", what: "Who changed it last, and when." },
            ],
          },
          {
            kind: "text",
            text: "Detail panel: **Destinations** (each entry with its providers and cache times, plus **Edit** and **Delete**), **Test** and **History**.",
          },
        ],
      },
      {
        id: "fields-policy",
        title: "Fields: HLR policy form",
        blocks: [
          {
            kind: "fields",
            title: "Policy section",
            fields: [
              { name: "Policy", what: "The policy's name.", values: "Required, up to 100 characters." },
              { name: "Status", what: "Active or Inactive.", values: "Default Active." },
            ],
          },
          {
            kind: "fields",
            title: "Destinations: one row per entry",
            fields: [
              {
                name: "Destination",
                what: "The network or country the entry covers. **Every other destination** is the catch-all row.",
                values: "Pick a network (MCCMNC) or a country (3-digit MCC). Each destination only once.",
              },
              {
                name: "Mode",
                what: "**In order** asks the listed providers one after another. **Auto (cheapest)** asks the cheapest provider that meets the minimum success rate first, then the others by price.",
                values: "Default In order.",
              },
              {
                name: "Providers (tried in order)",
                what: "Add providers with **+ provider…**. The number shows the order; **←** moves a provider earlier, **×** removes it.",
                values: "Up to 10 per row. A provider only once.",
              },
              {
                name: "Min success %",
                what: "Auto mode only: providers below this success rate are tried last.",
                values: "0–100. Required for Auto (starts at 90).",
              },
              {
                name: "Cache ported (h)",
                what: "Hours to keep an answer for a ported number.",
                values: "0–720. `0` = no cache. Default 168 (7 days).",
              },
              {
                name: "Cache not ported (h)",
                what: "Hours to keep an answer for a number that is not ported.",
                values: "0–720. Default 336 (14 days).",
              },
            ],
          },
          {
            kind: "list",
            items: [
              "**Add destination** adds a row; **Add catch-all** adds the Every other destination row (only one is allowed).",
              "A network's own entry wins over its country's entry; the catch-all covers the rest. No matching entry means no HLR lookup.",
              "On an error or timeout the next provider is tried. Cached answers are free and instant.",
            ],
          },
        ],
      },
      {
        id: "policy-test",
        title: "How to test a policy",
        blocks: [
          {
            kind: "steps",
            items: [
              "Select the policy and open the **Test** tab.",
              "Enter a **Receiver number** (5–15 digits, a leading + is allowed) and click **Run**.",
              "The headline shows which entry applies and the mode, or “No entry: no HLR lookup”. On the right: the network found and the cache times.",
              "The table lists the providers in the order they would be asked, with price, success rate and live status. The highlighted row is **asked first**; the others are **fallback**, or **skipped** with the reason (deleted, inactive, down, or success under the minimum).",
            ],
          },
        ],
      },
      {
        id: "how-to",
        title: "How to set up HLR from scratch",
        blocks: [
          {
            kind: "steps",
            items: [
              "In **Providers**, click **Add provider** and fill in the request, credentials and response mapping.",
              "Open **Prices** and set or import the provider's prices per destination.",
              "For lookups on customer trunks: in **Rules**, click **Add rule**, pick the provider, a DNID pattern and the trunks it applies to.",
              "For lookups chosen by routing: in **Policies**, click **Add policy**, add destinations (and a catch-all) with providers and cache times, then use the policy in a route rule's HLR action on [[route-rules|Route rules]].",
              "Test: the policy **Test** tab, or the Test on a trunk's Rules tab, which also shows the HLR provider the message would get.",
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
              "Translation rules run first, so the DNID pattern sees the rewritten receiver.",
              "A route rule with an HLR action uses its policy; otherwise the customer trunk's HLR rules are checked in order and the first match decides the provider.",
              "A cached answer is reused for its cache time and costs nothing; a live lookup costs the destination's price or the Default Rate.",
              "The answer's network (MCCMNC) is then used for routing and rating, so a ported number is routed and billed to its real network.",
              "Every save on this page is one undoable change. See [[undo-and-history]].",
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
            text: "Provider passwords are write-only: no one can read them back. Keep your own record with the provider.",
          },
          {
            kind: "tip",
            text: "Watch **Success** (amber below 90 %) and **Live** in the provider grid. A provider that is down is skipped by policies.",
          },
          {
            kind: "tip",
            text: "An amber **Cleanup** badge in the Rules view means some HLR rules are not assigned to any trunk.",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ number lists
  {
    id: "number-lists",
    pageKey: "number-lists",
    title: "Number lists",
    group: "Switch",
    summary:
      "Lists of numbers or Sender IDs used by translation and route rules: Tag lists to match against, Random lists to pick a sender from, and Sender ID Template lists.",
    keywords: ["number list", "whitelist", "blacklist", "tag", "random", "sender id template", "list import"],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "A number list holds values that rules use. Instead of typing hundreds of numbers into a rule, you keep them in a list and point the rule at it. Lists can also be created from inside the rule form with **New list**.",
          },
          {
            kind: "fields",
            title: "List types",
            fields: [
              {
                name: "Tag",
                what: "Numbers or Sender IDs that rules match against (Sender ID List, Receiver ID List, whitelists).",
              },
              {
                name: "Random",
                what: "Sender IDs (long or short codes of 3–20 digits) that a Random Number conversion picks from: a translation rule matching one or many Sender IDs sends each message with one of them, at random.",
              },
              {
                name: "Sender ID Template",
                what: "A Sender ID (up to 11 characters, each `{n}` one random digit) and, after a `|`, the text the message becomes: `{code}` is the code found in the original text, `{text}` the original text.",
              },
            ],
          },
        ],
      },
      {
        id: "layout",
        title: "What you see on the page",
        blocks: [
          {
            kind: "fields",
            title: "List grid columns",
            fields: [
              { name: "Info ID", what: "The list's number." },
              { name: "Name", what: "The list's name." },
              { name: "Type", what: "Tag, Random or Sender ID Template." },
              { name: "Entries", what: "How many values the list holds. Point at the number to see the first 100." },
              {
                name: "Used by",
                what: "How many live rules (translation and route rules) use the list. Point at the number to see them by name.",
              },
              { name: "Updated By / Updated Time", what: "Who changed it last, and when." },
            ],
          },
          {
            kind: "text",
            text: "The detail panel shows the type and what uses the list, and has **Open entries**, **Edit** and **Delete**. Double-click a list (or press Enter) to open its entries in the same tab.",
          },
          {
            kind: "fields",
            title: "Entries grid columns",
            fields: [
              { name: "Info ID", what: "The entry's number." },
              { name: "Number (Sender ID for template lists)", what: "The value." },
              {
                name: "Content template",
                what: "Template lists only: the text the message becomes, or “— (Sender ID only)”.",
              },
              { name: "Created By / Created Time", what: "Who added it, and when." },
            ],
          },
        ],
      },
      {
        id: "fields",
        title: "Fields",
        blocks: [
          {
            kind: "fields",
            title: "Add number list / Edit",
            fields: [
              {
                name: "Name",
                what: "The list's name.",
                values: "Required, up to 100 characters. Example: `Blocked senders`.",
              },
              {
                name: "Type",
                what: "What the list is for. Fixed when the list is created from a rule's conversion field.",
                values: "Tag (default), Random or Sender ID Template.",
              },
            ],
          },
          {
            kind: "fields",
            title: "Add to a list",
            fields: [
              {
                name: "Values",
                what: "Tag and Random lists: the values to add.",
                values: "One per line, or separated by commas, semicolons or tabs. Duplicates are ignored.",
              },
              {
                name: "Sender ID | content template",
                what: "Template lists: one entry per line, the Sender ID then optionally `|` and the content.",
                values: "Example: `OURBRAND | Your OurBrand code is {code}`, or `INFO{n}{n}` alone.",
              },
            ],
          },
        ],
      },
      {
        id: "how-to",
        title: "How to work with lists",
        blocks: [
          {
            kind: "steps",
            title: "Create a list and fill it",
            items: [
              "Click **Add list**, enter a **Name**, pick the **Type** and click **Add list**. The entries open.",
              "Click **Add**, paste the values and click **Add n**. Values already in the list are skipped; values that do not fit the type are reported.",
            ],
          },
          {
            kind: "steps",
            title: "Import, export and delete entries",
            items: [
              "Click **Import List** and choose a file with one value per line, or a CSV with a `value` (or `number`) column. A dry run shows what will change first. You can also choose to delete entries missing from the file.",
              "Use Export in the header to download the entries.",
              "Select entries (Space or check boxes) and use **Delete n entries**, or **Delete** in the detail panel for one.",
              "Click **All lists** to go back.",
            ],
          },
          {
            kind: "steps",
            title: "Delete a list",
            items: [
              "Right-click the list and choose **Delete…**, or use **Delete list** inside it.",
              "If live rules use the list, delete is blocked: change those rules first. See [[safe-delete]].",
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
            text: "In the entries grid, a filter like `4477%` finds a whole number range (`%` = any characters).",
          },
          {
            kind: "tip",
            text: "Any list type can be used as a match list in a rule. Conversion lists must match the conversion: Random Number needs a Random list, Sender ID Template a Sender ID Template list.",
          },
          {
            kind: "text",
            text: "Every add, delete and import is one undoable change. Related: [[translation-rules]].",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ QBR stats
  {
    id: "qbr-stats",
    pageKey: "qbr-stats",
    title: "QBR stats",
    group: "Switch",
    summary:
      "The quality figures (ASR, DLR, delivery delay) per trunk and destination that quality-based routing uses, with manual overrides for vendor trunks.",
    keywords: ["QBR", "quality based routing", "ASR", "DLR", "ADD", "delivery delay", "override", "vendor stat"],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "QBR (quality-based routing) orders vendors by how well they deliver. This page shows the figures it uses, per trunk and destination, from the last 24 hours of traffic, refreshed every 5 minutes. Routing staff check it and, for vendor trunks, can set a figure by hand.",
          },
          {
            kind: "list",
            title: "The figures",
            items: [
              "**ASR** (answer seizure ratio): share of attempts the vendor accepted.",
              "**DLR**: share of accepted messages that were delivered.",
              "**ADD** (average delivery delay): seconds from sending to delivery.",
            ],
          },
        ],
      },
      {
        id: "layout",
        title: "What you see on the page",
        blocks: [
          {
            kind: "text",
            text: "**QBR Stats For** above the grid switches between **Customer trunks** and **Vendor trunks** (vendor is the default). Filter the Trunk column to see one trunk.",
          },
          {
            kind: "fields",
            title: "Grid columns",
            fields: [
              { name: "Trunk", what: "The trunk." },
              { name: "MCCMNC / Country / Network", what: "The destination." },
              { name: "Attempts 24 h", what: "Messages tried in the last 24 hours." },
              { name: "ASR", what: "The ASR used by routing (the override if there is one)." },
              { name: "DLR", what: "The DLR used by routing." },
              { name: "ADD (s)", what: "The average delivery delay used by routing." },
              { name: "Override", what: "An amber **Manual** tag when a figure was set by hand." },
              { name: "Updated At", what: "When the row was last refreshed or changed." },
            ],
          },
          {
            kind: "text",
            text: "The **Stat** tab in the detail panel compares the traffic figures with the figures used by QBR routing (and who set the override). Vendor rows have **Override** and, when overridden, **Clear override**.",
          },
        ],
      },
      {
        id: "fields",
        title: "Fields: Add Vendor Stat / Override",
        blocks: [
          {
            kind: "fields",
            fields: [
              {
                name: "Vendor Trunk",
                what: "The vendor trunk. Fixed when overriding an existing row.",
                values: "Required.",
              },
              { name: "MCCMNC", what: "The destination. Fixed when overriding an existing row.", values: "Required." },
              {
                name: "ASR %",
                what: "The ASR routing should use. Empty keeps the traffic figure (shown in the hint).",
                values: "A number, for example `85` or `85.5`.",
              },
              {
                name: "DLR %",
                what: "The DLR routing should use. Empty keeps the traffic figure.",
                values: "A number.",
              },
              {
                name: "ADD (s)",
                what: "The delivery delay routing should use. Empty keeps the traffic figure.",
                values: "Seconds.",
              },
            ],
          },
        ],
      },
      {
        id: "how-to",
        title: "How to override a vendor figure",
        blocks: [
          {
            kind: "steps",
            items: [
              "Switch **QBR Stats For** to **Vendor trunks**.",
              "Double-click the row (or click **Override** in the detail panel), or click **Add vendor stat** for a pair with no traffic yet.",
              "Enter the figures you want routing to use and click **Save stat**.",
              "To go back to the real traffic figures, click **Clear override**.",
            ],
          },
          {
            kind: "tip",
            text: "An override wins until you clear it, even when traffic changes. QBR route rules order vendors by the destination's effective DLR. See [[route-rules]].",
          },
          { kind: "text", text: "Each change can be undone (Ctrl+Z). Customer rows are read-only." },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ notifications
  {
    id: "notifications",
    pageKey: "notifications",
    title: "Notifications",
    group: "Switch",
    summary: "Send rate sheets and connection details to customers by e-mail, or download a trunk's rate sheet.",
    keywords: ["send rate", "rate sheet", "tech info", "connection details", "view rate", "customer notification"],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "Account Managers and rates staff use this page to send customers their current rates (**Send Rate**) or their connection details (**Send Tech Info**), for one trunk or many at once. Every e-mail sent shows in [[email-logs|Email logs]].",
          },
        ],
      },
      {
        id: "layout",
        title: "What you see on the page",
        blocks: [
          {
            kind: "fields",
            title: "Grid columns (customer trunks)",
            fields: [
              { name: "Enterprise Name", what: "The customer." },
              { name: "Customer Trunk Name", what: "The trunk." },
              { name: "Category", what: "The trunk's product category." },
              { name: "Protocol", what: "SMPP or HTTP." },
              { name: "Capacity", what: "The trunk's TPS (messages per second)." },
              { name: "Status", what: "Green Active or grey Inactive." },
            ],
          },
          {
            kind: "text",
            text: "The **Notify** tab in the detail panel has **Send Rate**, **Send Tech Info**, **View Rate (Excel)** and **CSV**, and lists the trunk's last e-mails with a link to all e-mail logs.",
          },
        ],
      },
      {
        id: "fields",
        title: "Fields",
        blocks: [
          {
            kind: "fields",
            title: "Customer Send Rate Information",
            fields: [
              { name: "File Type", what: "The rate sheet format.", values: "**Excel** (default) or **CSV**." },
              {
                name: "Send Email to each enterprise's Rates contact",
                what: "When ticked, each trunk's rate sheet is e-mailed to its enterprise's Rates contact (or Commercial contact). When cleared, the button becomes **Download** and saves the sheets to your computer instead (the first 10 trunks).",
                values: "Ticked by default.",
              },
            ],
          },
          {
            kind: "text",
            text: "Both dialogs show a preview of the e-mail (To, Subject and body) for the first selected trunk; each trunk gets its own e-mail.",
          },
        ],
      },
      {
        id: "how-to",
        title: "How to send",
        blocks: [
          {
            kind: "steps",
            title: "Send rates to several customers",
            items: [
              "Tick the trunks in the grid (Space or the check boxes).",
              "Choose **Send Rate…** from the bulk actions.",
              "Pick the **File Type**, check the preview and click **Send**.",
              "A message confirms how many were sent. Trunks without a rate table or without a contact are listed as failed.",
            ],
          },
          {
            kind: "steps",
            title: "Send connection details",
            items: [
              "Select one trunk and click **Send Tech Info**, or tick several and choose **Send Tech Info…**.",
              "Check the preview: it goes to the Technical (or Commercial) contact.",
              "Click **Send**.",
            ],
          },
          {
            kind: "steps",
            title: "Just look at the rates",
            items: ["Select the trunk and click **View Rate (Excel)** or **CSV** to download the sheet."],
          },
        ],
      },
      {
        id: "tips",
        title: "Tips and things to watch",
        blocks: [
          {
            kind: "warning",
            text: "Always read the Tech Info preview before sending. It shows exactly what the customer receives, including any login details the e-mail template contains.",
          },
          {
            kind: "tip",
            text: "E-mail wording comes from [[email-templates|Email templates]]. Contacts come from the enterprise record.",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ email logs
  {
    id: "email-logs",
    pageKey: "email-logs",
    title: "Email logs",
    group: "Switch",
    summary:
      "Every e-mail the platform sent: rate sheets, tech info, invoices, alerts, broadcasts and more, with status and errors.",
    keywords: ["email log", "mail log", "sent emails", "failed email", "smtp"],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "Use it to check whether a partner was sent something (a rate sheet, an invoice, an alert), to whom, and why an e-mail failed. It is read-only.",
          },
          {
            kind: "text",
            text: "Every e-mail is written here first and then sent, usually within seconds, from the business company mailbox for that kind of e-mail (sign-in codes from the platform's own address). When the mail server is busy or cannot be reached, it is tried again after 1, 5, 15 and 60 minutes; if the server refuses it or the last try fails, it is marked **Failed** with the server's answer.",
          },
          { kind: "tip", text: "On the test system e-mails are recorded here but never sent." },
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
              { name: "Info ID", what: "The log entry number. Newest first." },
              { name: "Enterprise", what: "The partner it was about, if any." },
              { name: "Customer Trunk / Vendor Trunk", what: "The trunk it was about, if any." },
              {
                name: "Email Type",
                what: "What kind of e-mail: Send Rate, Send Tech Info, Invoice, Traffic Alert, Broadcast, OTP, Credit Alert and others.",
              },
              { name: "Status", what: "Amber **Queued** (waiting to go out), green **Sent** or red **Failed**." },
              { name: "Rate Date", what: "For rate e-mails, the date of the rates." },
              { name: "File", what: "The attached file name." },
              { name: "Error", what: "Why it failed, in red (for example no contact address)." },
              { name: "To Address", what: "The recipients." },
              { name: "Updated By", what: "Who sent it, or “platform” for automatic e-mails." },
              { name: "Updated Time", what: "When it was sent (UTC)." },
            ],
          },
          {
            kind: "text",
            text: "The **E-mail** tab in the detail panel shows the e-mail itself: From, To, CC, Subject, File, any error and the body. CC Address and Subject can also be shown as columns.",
          },
        ],
      },
      {
        id: "how-to",
        title: "How to find an e-mail",
        blocks: [
          {
            kind: "steps",
            items: [
              "Filter **Enterprise** or **Customer Trunk** with part of the name (for example `acme%`).",
              "Pick the **Email Type** and, if needed, **Status** Failed.",
              "Narrow **Updated Time** to a date range.",
              "Select the row to read the e-mail. Use Export to download the filtered list as a file.",
            ],
          },
          { kind: "text", text: "See [[grids-and-filters]] and [[filter-builder]]." },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ firewall
  {
    id: "firewall",
    pageKey: "firewall",
    title: "Firewall",
    group: "Switch",
    summary:
      "Ban or trust IP addresses at the platform's listeners, and set the brute-force protection that bans addresses automatically.",
    keywords: ["firewall", "ban ip", "block ip", "trusted ip", "whitelist ip", "brute force", "filter", "listener"],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "NOC and admin staff use the firewall to block addresses that attack the platform and to make sure partners' addresses are never blocked. It has three tabs: **Banned IP**, **Trusted IP** and **Filter**.",
          },
          {
            kind: "list",
            items: [
              "**Banned IP**: addresses blocked at the listeners of the chosen filter. Automatic bans come from the brute-force protection and lift by themselves.",
              "**Trusted IP**: addresses always let through, even after failed attempts. Trusted beats banned.",
              "**Filter**: which listener a rule guards (SMPP, HTTP API, Portal or all) and when the brute-force protection bans.",
            ],
          },
        ],
      },
      {
        id: "layout",
        title: "What you see on the page",
        blocks: [
          {
            kind: "fields",
            title: "Banned IP / Trusted IP grid columns",
            fields: [
              { name: "IP Address", what: "The address or range." },
              { name: "Filter", what: "The filter (listener) the rule applies to." },
              { name: "Source", what: "**Manual** (added by staff) or **Automatic** (brute-force protection)." },
              { name: "Reason", what: "Why it was added." },
              { name: "Hits (24 h)", what: "How often the rule was hit in the last 24 hours." },
              { name: "Last Hit", what: "When it was last hit." },
              { name: "Expires", what: "When the rule lifts, or “never”." },
              { name: "Added", what: "When it was added." },
              { name: "Action", what: "**Remove** takes the rule off." },
            ],
          },
          {
            kind: "fields",
            title: "Filter grid columns",
            fields: [
              { name: "Name", what: "The filter's name." },
              { name: "Listener", what: "SMPP, HTTP API, Portal or All listeners." },
              { name: "Status", what: "Green Active or grey Inactive. Rules of an inactive filter do not apply." },
              { name: "Failed Attempts / Window (s) / Ban (min)", what: "The automatic ban setting." },
              { name: "Banned / Trusted", what: "How many rules use the filter." },
            ],
          },
          {
            kind: "text",
            text: "Above the Banned and Trusted grids is the **Check an IP…** box: type an address and click **Check** to see whether it is banned (red), trusted (green) or has no rule (normal checks apply), and which rule decides.",
          },
        ],
      },
      {
        id: "fields",
        title: "Fields",
        blocks: [
          {
            kind: "fields",
            title: "Add bar (Banned IP and Trusted IP)",
            fields: [
              {
                name: "IP Address",
                what: "One address, or a range in CIDR form (address/size).",
                values:
                  "Example: `198.51.100.7` or `198.51.100.0/24`. For a range, use the network address (ending in 0 for a /24).",
              },
              { name: "Select filter", what: "Which filter (listener) the rule applies to.", values: "Required." },
              { name: "Reason (optional)", what: "A note for colleagues.", values: "Up to 300 characters." },
            ],
          },
          {
            kind: "fields",
            title: "Add filter / Edit filter",
            fields: [
              { name: "Name", what: "The filter's name.", values: "Required, up to 60 characters." },
              {
                name: "Listener",
                what: "Which entry point it guards.",
                values: "SMPP (default), HTTP API, Portal or All listeners.",
              },
              { name: "Status", what: "Active or Inactive.", values: "Default Active." },
              {
                name: "Failed attempts",
                what: "Failed binds or logins that trigger a ban.",
                values: "1–1,000. Default 5.",
              },
              {
                name: "Within (seconds)",
                what: "The time window for those attempts.",
                values: "10–86,400. Default 60.",
              },
              {
                name: "Ban for (minutes)",
                what: "How long the automatic ban lasts.",
                values: "1–525,600. Default 60.",
              },
            ],
          },
          {
            kind: "text",
            text: "The form sums it up, for example “5 failed binds or logins within 60 s ban the address for 60 minutes.”",
          },
        ],
      },
      {
        id: "how-to",
        title: "How to ban, trust or unban",
        blocks: [
          {
            kind: "steps",
            title: "Ban or trust an address",
            items: [
              "Open **Banned IP** or **Trusted IP**.",
              "Type the address in the add bar, pick the filter, add a reason.",
              "Click **Ban** or **Trust**.",
            ],
          },
          {
            kind: "steps",
            title: "Remove a rule",
            items: ["Click **Remove** in the Action column, or **Delete** in the detail panel. Ctrl+Z undoes it."],
          },
        ],
      },
      {
        id: "tips",
        title: "Tips and things to watch",
        blocks: [
          {
            kind: "warning",
            text: "Before banning a range, use **Check an IP…** on a partner's address to make sure you are not cutting off a customer or vendor.",
          },
          {
            kind: "tip",
            text: "Add your partners' addresses to **Trusted IP** so failed binds during set-up never ban them.",
          },
          { kind: "tip", text: "When several rules cover an address, trusted wins, then the most specific range." },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ sms to voice
  {
    id: "sms-to-voice",
    pageKey: "sms-to-voice",
    title: "SMS to voice",
    group: "Switch",
    summary:
      "Turn matching SMS (for example one-time codes sent to landlines) into a voice call that reads the text out.",
    keywords: ["sms to voice", "text to speech", "tts", "landline", "OTP", "voice call"],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "Some numbers cannot receive SMS, such as landlines. A rule here turns matching messages into a voice call that reads the text, with digits read one at a time so a code is easy to note down.",
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
              { name: "SmsVoiceID", what: "The rule's number. Rules are checked in this order." },
              { name: "Sender ID", what: "The Sender ID pattern, or “any”." },
              { name: "Receiver ID", what: "The receiver pattern, or “any”." },
              { name: "Prefix", what: "The number start the receiver must have, or “any”." },
              { name: "Repeat", what: "How many times the call reads the text." },
              { name: "Destination", what: "The network the receiver must be on, or “any”." },
              { name: "Status", what: "Green Active or grey Inactive (row dimmed)." },
              { name: "Updated By", what: "Who saved it last." },
            ],
          },
          {
            kind: "text",
            text: "The test box above the grid takes a Sender ID, a Receiver and a Message text; **Test** shows which rule matches (or “No active rule matches: sent as SMS”) and what the call would read. The detail panel has **Rule** (Edit, Delete) and **History**.",
          },
        ],
      },
      {
        id: "fields",
        title: "Fields: SMS to voice rule",
        blocks: [
          {
            kind: "fields",
            fields: [
              {
                name: "Sender ID",
                what: "Only messages from this Sender ID. Empty = any.",
                values: "Up to 32 characters. `%` = any characters, `_` = one character, any case. Example: `%OTP%`.",
              },
              {
                name: "Receiver ID",
                what: "Only messages to this number. Empty = any.",
                values: "Up to 32 characters, same wildcards.",
              },
              {
                name: "Prefix",
                what: "Only receivers starting with these digits. Empty = any.",
                values: "Up to 15 digits. Example: `4420` (London landlines).",
              },
              { name: "Repeat", what: "How many times the call reads the text.", values: "1–5. Default 2." },
              {
                name: "Destination",
                what: "Only receivers on this network. Empty = any destination.",
                values: "Search a network or country.",
              },
              { name: "Status", what: "Only active rules are used.", values: "Active (default) or Inactive." },
            ],
          },
        ],
      },
      {
        id: "how-to",
        title: "How to add and test a rule",
        blocks: [
          {
            kind: "steps",
            items: [
              "Click **Add** and fill in the conditions. Leave a field empty to match anything.",
              "Set **Repeat** and click **Add rule**.",
              "In the test box, enter a sample sender, receiver and text and click **Test**.",
              "Check which rule matched and what the call reads.",
            ],
          },
          {
            kind: "tip",
            text: "Active rules are checked by SmsVoiceID; the first one where every filled-in condition matches is used.",
          },
          { kind: "tip", text: "The test never places a call; it only shows what would happen." },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ traffic alerts
  {
    id: "traffic-alerts",
    pageKey: "traffic-alerts",
    title: "Traffic alerts",
    group: "Switch",
    summary:
      "E-mail when a customer trunk's ASR, DLR, margin or delivery delay falls out of range over a recent time window.",
    keywords: ["traffic alert", "ASR alert", "DLR alert", "margin alert", "quality alert", "threshold"],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "A traffic alert watches one customer trunk (optionally one vendor, Sender ID or network) and e-mails when quality drops. NOC staff and Account Managers use it to catch problems before the customer complains. For platform-wide alert rules see [[alert-rules|Alert rules]].",
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
              { name: "Info ID", what: "The alert's number." },
              { name: "Name", what: "The alert's name." },
              { name: "Customer Trunk", what: "The trunk watched." },
              { name: "Vendor Trunk", what: "Limits to one vendor, or “any”." },
              { name: "Notification Email", what: "Addresses that get the e-mail." },
              { name: "Status", what: "Green Active or grey Inactive (row dimmed)." },
              {
                name: "Last Check",
                what: "Green **OK**, red **Firing**, grey **Too few messages** (not enough traffic to judge) or **Not checked**.",
              },
              { name: "Last Fired", what: "When it last started firing, or “never”." },
            ],
          },
          {
            kind: "text",
            text: "The **Alert** tab shows the last measured values (Messages, ASR, DLR, Margin, Delivery delay) with breached values in red, plus the last check, last fired, traffic and who is notified. Buttons: **Check now**, **Edit**, **Clone**, **Delete**. **History** lists changes.",
          },
        ],
      },
      {
        id: "fields",
        title: "Fields: traffic alert form",
        blocks: [
          {
            kind: "fields",
            title: "Alert",
            fields: [
              { name: "Name", what: "The alert's name.", values: "Required, up to 80 characters." },
              {
                name: "Sample Count (≥)",
                what: "Messages needed in the window before the alert judges; below this it shows Too few messages.",
                values: "At least 1. Default 100.",
              },
              { name: "Sample Interval (minutes)", what: "The time window measured.", values: "1–1,440. Default 15." },
              { name: "Status", what: "Only active alerts are checked.", values: "Active (default) or Inactive." },
            ],
          },
          {
            kind: "fields",
            title: "Thresholds",
            fields: [
              {
                name: "ASR Threshold (≤)",
                what: "Alert when ASR is at or below this.",
                values: "0–100 %. Default 70.",
              },
              {
                name: "DLR Threshold (≤)",
                what: "Alert when DLR is at or below this.",
                values: "0–100 %. Default 50.",
              },
              {
                name: "MRG Threshold (≤)",
                what: "Alert when margin (revenue minus cost, as a share of revenue) is at or below this.",
                values: "-100 to 100 %. Default 0.",
              },
              {
                name: "Avg Delivery Delay (≥)",
                what: "Alert when the average delivery delay is at or above this.",
                values: "Seconds. Empty = not checked.",
              },
            ],
          },
          {
            kind: "fields",
            title: "Traffic",
            fields: [
              { name: "Customer Trunk", what: "The trunk to watch.", values: "Required." },
              { name: "Vendor Trunk", what: "Only traffic sent to this vendor.", values: "Empty = any vendor." },
              { name: "Sender ID", what: "Only messages with this exact Sender ID.", values: "Empty = any sender." },
              {
                name: "MCCMNC",
                what: "Only traffic to this network.",
                values: "Up to 6 digits. Empty = any destination.",
              },
            ],
          },
          {
            kind: "fields",
            title: "Notify",
            fields: [
              {
                name: "Notification Email",
                what: "Who gets the e-mail.",
                values: "Addresses separated by commas, spaces or new lines. Invalid addresses block the save.",
              },
              {
                name: "Enterprise Contact Email",
                what: "Also send to this contact of the customer's enterprise.",
                values: "None (default), Technical, Commercial, Rates or Finance.",
              },
              {
                name: "Email Template",
                what: "The wording of the e-mail (traffic alert templates).",
                values: "Required.",
              },
            ],
          },
        ],
      },
      {
        id: "how-to",
        title: "How to add and check an alert",
        blocks: [
          {
            kind: "steps",
            items: [
              "Click **Add**, give it a name and pick the **Customer Trunk**.",
              "Set the sample size, window and thresholds.",
              "Enter the notification addresses and pick the template, then click **Add alert**.",
              "Click **Check now** to measure straight away; a message shows the result and any e-mails sent.",
            ],
          },
          {
            kind: "tip",
            text: "To watch a similar trunk, use **Clone** and change the trunk.",
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
              "Every 5 minutes (or on **Check now**) the alert measures the last Sample Interval of traffic for its trunk and filters.",
              "With fewer messages than the Sample Count it shows Too few messages and does nothing.",
              "Otherwise any breached threshold makes it **Firing**.",
              "An e-mail goes out only when the alert starts firing, not on every check while it keeps firing. Sent e-mails appear in [[email-logs|Email logs]].",
            ],
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ broadcast
  {
    id: "broadcast",
    pageKey: "broadcast",
    title: "Broadcast",
    group: "Switch",
    summary: "E-mail many partners at once, chosen by business company, contact type and enterprise type.",
    keywords: ["broadcast", "mass email", "newsletter", "announcement", "maintenance notice", "email all partners"],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "Use Broadcast for announcements to many partners, such as planned maintenance or a price change. Each enterprise gets its own e-mail, and every one shows in [[email-logs|Email logs]]. The grid lists past broadcasts.",
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
              { name: "Subject", what: "The e-mail subject." },
              { name: "Business Company", what: "Your company the e-mail was sent from." },
              { name: "Sender", what: "The mailbox it came from." },
              { name: "Enterprises", what: "How many enterprises were reached." },
              { name: "Addresses", what: "How many e-mail addresses it went to." },
              { name: "No Address", what: "Enterprises with no matching contact, in amber when above 0." },
              { name: "Sent By / Sent", what: "Who sent it, and when." },
            ],
          },
          {
            kind: "text",
            text: "The **Broadcast** tab shows the audience, reach, attachment and sender, with an **Email logs** button.",
          },
        ],
      },
      {
        id: "fields",
        title: "Fields: New broadcast",
        blocks: [
          {
            kind: "fields",
            fields: [
              {
                name: "Business Company",
                what: "Which of your companies sends; only its partners are reached.",
                values: "Defaults to the first.",
              },
              { name: "Sender", what: "One of the business company's mailboxes.", values: "Required." },
              { name: "Subject", what: "The e-mail subject.", values: "Required, up to 200 characters." },
              {
                name: "Contact Type",
                what: "Which contacts of each enterprise get it.",
                values: "Commercial (default), Technical, Rates, Finance. At least one.",
              },
              {
                name: "Enterprise Type",
                what: "Which partners get it.",
                values: "Customer and Bilateral (default), Vendor. At least one.",
              },
              {
                name: "Message",
                what: "The body, with a toolbar for **B**old, **I**talic, **U**nderline, bulleted and numbered lists, **Link** (http, https or mailto only) and **Clear** formatting.",
                values: "Required.",
              },
              { name: "Attachment (one file, up to 5 MB)", what: "An optional file sent with every e-mail." },
            ],
          },
          {
            kind: "text",
            text: "The footer counts the audience (“n enterprises · n addresses”) or says what is missing; a line lists some of the enterprises reached. Only active enterprises are included.",
          },
        ],
      },
      {
        id: "how-to",
        title: "How to send a broadcast",
        blocks: [
          {
            kind: "steps",
            items: [
              "Click **New broadcast**.",
              "Pick the **Business Company** and **Sender**, and write the **Subject**.",
              "Tick the **Contact Type** and **Enterprise Type** boxes and check the audience count.",
              "Write the message and add an attachment if needed.",
              "Click **Send** and confirm. A message shows how many addresses and enterprises were reached and how many had no address.",
            ],
          },
          {
            kind: "warning",
            text: "A broadcast cannot be recalled. Check the audience count and the text before you confirm.",
          },
        ],
      },
    ],
  },
];
