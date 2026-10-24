// Help center: Monitoring – alert rules, incidents, EDRs and the Observation Deck tools (§9, §13.6, §13.7).
import type { HelpTopic } from "../helpTypes";

export const topics: HelpTopic[] = [
  // ------------------------------------------------------------------ Alert rules
  {
    id: "alert-rules",
    pageKey: "alert-rules",
    title: "Alert rules",
    group: "Monitoring",
    summary:
      "Set up rules that watch live traffic statistics and raise a pop-up, a sound and/or an e-mail when something crosses a limit, such as a customer's DLR dropping or a vendor bind going down.",
    keywords: [
      "alerts",
      "alarm",
      "monitoring",
      "threshold",
      "notification",
      "pop-up",
      "sound",
      "e-mail alert",
      "DLR drop",
      "ASR drop",
      "bind down",
      "quiet hours",
      "active hours",
      "cooldown",
      "severity",
      "NOC",
    ],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "An alert rule tells the platform what to watch (for example **DLR %** of each customer), when it counts as a problem (for example a drop of 20 % compared with the previous 15 minutes) and who should hear about it, and how (pop-up, sound, e-mail).",
          },
          {
            kind: "text",
            text: "Rules are checked on the server every few seconds, so they fire even when nobody has the dashboard open. Each time a rule fires for one customer, trunk or vendor it opens an **incident**, which you follow up on the [[incidents|Incidents]] page.",
          },
          {
            kind: "text",
            text: "Typical users: the NOC (network operations) team sets rules for binds, TPS and delivery rates; account managers set rules for their own customers (started / stopped sending, margin); billing may watch revenue and margin.",
          },
        ],
      },
      {
        id: "layout",
        title: "What you see on the page",
        blocks: [
          {
            kind: "list",
            title: "Header",
            items: [
              "**Add rule** (the blue button) opens an empty rule form.",
              "The quick search looks in the rule name and scope. **Show deleted** also lists deleted rules, greyed out.",
            ],
          },
          {
            kind: "fields",
            title: "Grid columns",
            fields: [
              { name: "Name", what: "The rule's name, in bold." },
              {
                name: "Scope",
                what: "What the rule watches, in words, e.g. `Customers: Acme Mobile, Blue Fox SMS`, `Each vendor trunk` or `Country: NG, KE`.",
              },
              {
                name: "Metric",
                what: "The statistic that is measured: Attempts, TPS, ASR, DLR, Margin, Delay, Bind and so on.",
              },
              {
                name: "Condition",
                what: "The full condition in one line, e.g. `DLR down 20 % vs previous window · 15 min · ≥ 500 msgs`.",
              },
              {
                name: "Severity",
                what: "Info (grey dot), Warning (amber dot) or Critical (red dot).",
              },
              { name: "Channels", what: "How people are told: Pop-up, Sound, E-mail." },
              { name: "Status", what: "Active or Inactive. Inactive rows are greyed out and never fire." },
              { name: "Last Triggered", what: "When the rule last opened an incident, or `never`." },
              {
                name: "Open",
                what: "How many incidents of this rule are still open (not recovered). Shown in red when above 0.",
              },
              { name: "Updated By", what: "The user who saved the rule last." },
            ],
          },
          {
            kind: "text",
            text: "Hidden columns you can add from the column chooser: **Info ID**, **Incidents (30 d)** (incidents in the last 30 days) and **Updated Time**. Every column has a filter under its header; see [[grids-and-filters]].",
          },
          {
            kind: "list",
            title: "Detail panel",
            items: [
              "**Rule** tab: scope, condition, severity, active hours, how and who is notified, extra e-mail recipients, repeat, what happens after recovery, last triggered, and the incident count (open and last 30 days).",
              "Buttons on the **Rule** tab: **Disable** / **Enable**, **Clone**, **Incidents** (opens the Incidents page filtered to this rule), **Edit** and **Delete**. A deleted rule shows **Restore** instead (administrators only).",
              "**History** tab: every saved change to the rule, who made it and when.",
            ],
          },
          {
            kind: "text",
            text: "The status bar shows the row count and the shortcuts: arrow keys move, **Enter** edits, **Ctrl+Z** undoes your last change.",
          },
        ],
      },
      {
        id: "fields-rule",
        title: "Fields: Rule",
        blocks: [
          {
            kind: "fields",
            title: "Rule part of the form",
            fields: [
              {
                name: "Name",
                what: "A name that says what the rule is for. It must be unique (not case-sensitive) among rules that are not deleted.",
                values: "Required, up to 120 characters. Example: `Key customers – DLR drop`.",
              },
              {
                name: "Status",
                what: "Active rules are checked; Inactive rules are kept but never fire. Switching a rule off also closes its open incidents on the next check.",
                values: "Active (default) or Inactive.",
              },
              {
                name: "Severity",
                what: "How serious the alert is. It sets the colour of the pop-up, which sound plays, and when the e-mail goes out (see Notify).",
                values: "Info, Warning (default) or Critical.",
              },
              {
                name: "Scope",
                what: "What the rule watches. With a list of customers, trunks or vendors, each one is watched on its own, so one rule can open several incidents at the same time (one per customer, for example).",
                values:
                  "All traffic · Customers (default) · Customer trunks · Vendors · Vendor trunks · Country (ISO codes) · Network / MCCMNC · Sender ID · Product category.",
              },
              {
                name: "Customers / Customer trunks / Vendors / Vendor trunks (empty = each one)",
                what: "Shown for those scopes. Add records as chips with the lookup; remove one with its ×. Leave it empty to watch every customer (or trunk, or vendor) separately.",
                values: "Optional. Type part of a name and pick from the list.",
              },
              {
                name: "Product category (empty = each one)",
                what: "Shown for the Product category scope.",
                values: "Choose at least one category.",
              },
              {
                name: "Country (ISO codes), comma-separated",
                what: "Shown for the Country scope. Two-letter country codes.",
                values: "Required. Example: `NG, KE`.",
              },
              {
                name: "Network / MCCMNC, comma-separated",
                what: "Shown for the Network scope. MCCMNC is the mobile country code plus network code that identifies one mobile network.",
                values: "Required. Example: `62130, 63902`.",
              },
              {
                name: "Sender ID, comma-separated",
                what: "Shown for the Sender ID scope. The sender names or numbers to watch.",
                values: "Required. Example: `BANKALERT`.",
              },
            ],
          },
          {
            kind: "tip",
            text: "In the trial, rules scoped to a country, network, sender ID or product category are measured on all traffic. Customer, vendor and trunk scopes are measured exactly.",
          },
        ],
      },
      {
        id: "fields-watch",
        title: "Fields: What to watch",
        blocks: [
          {
            kind: "fields",
            title: "What to watch",
            fields: [
              {
                name: "Metric",
                what: "The statistic measured over the window.",
                values:
                  "**Volume – attempts** (messages received from customers) · **Volume – submitted** (accepted by the vendor) · **Volume – delivered** (delivery receipt says delivered) · **TPS** (messages per second) · **ASR %** (share of attempts the vendor accepted) · **DLR %** (share of submitted messages that were delivered) · **Margin (amount)** · **Margin %** · **Revenue** · **Average delivery delay (s)** (seconds from submit to delivery receipt) · **Bind status**. Default: DLR %.",
              },
              {
                name: "Condition",
                what: "When the metric counts as a problem.",
                values:
                  "**Above a value** · **Below a value** · **Increase by % vs baseline** · **Decrease by % vs baseline** (default) · **Started sending** · **Stopped sending (no traffic for the window)** · **Bind down**.",
              },
              {
                name: "Value",
                what: "Shown for Above / Below. The limit, in the metric's own unit: a percentage for ASR, DLR and Margin %, the platform currency for Revenue and Margin, seconds for delay, messages for volume, messages per second for TPS.",
                values: "Required, 0 or more, one decimal allowed. Example: `85` for DLR below 85 %.",
              },
              {
                name: "Change (%)",
                what: "Shown for Increase / Decrease by %. How big the change must be compared with the baseline.",
                values: "Required, more than 0. Default `20`.",
              },
              {
                name: "Compared with",
                what: "Shown for Increase / Decrease by %. The baseline the current value is compared with.",
                values:
                  "**The previous window** (the same length of time just before, the default) · **Same time yesterday** · **Same weekday last week**.",
              },
              {
                name: "Evaluate over",
                what: "The window: how many minutes of traffic each check looks at. Longer windows are calmer; shorter windows react faster. Not shown for Bind status / Bind down.",
                values: "1, 5, 15 (default), 30 or 60 min.",
              },
              {
                name: "Only with at least (messages)",
                what: "The minimum sample. If fewer messages than this were sent in the window, the rule does not fire. This avoids noise on tiny volumes (two failed messages out of three is not a 33 % DLR problem). For Started / Stopped sending it is the volume that counts as sending.",
                values: "0 or more. Default `500`.",
              },
              {
                name: "Active hours (UTC)",
                what: "When the rule may fire. Use it for quiet hours, e.g. only during office hours. Outside these hours the rule is not checked at all.",
                values:
                  "Tick **Always** (default), or untick it and choose the days (Sun–Sat) and a From hour and To hour in UTC. Example: Mon–Fri, `08:00` to `20:00`. The To hour must be after the From hour; at least one day is required.",
              },
            ],
          },
          {
            kind: "warning",
            text: "The form checks these combinations when you save: **Started sending** and **Stopped sending** only work with a volume metric or TPS. **Revenue**, **Margin** and **Margin %** are measured on the customer side, so they cannot be used with a Vendors or Vendor trunks scope. Choosing **Bind status** always means **Bind down** (and the other way round).",
          },
        ],
      },
      {
        id: "fields-notify",
        title: "Fields: Notify",
        blocks: [
          {
            kind: "fields",
            title: "Notify",
            fields: [
              {
                name: "How",
                what: "The channels. **Pop-up** shows a card in the corner of every page and tab. **Sound** plays the user's sound for this severity. **E-mail** sends a message (see below).",
                values: "Tick at least one. Default: Pop-up and Sound.",
              },
              {
                name: "Users (none and no department = everyone)",
                what: "The users who get the pop-up, sound and e-mail. If you choose no users and no departments, every user is notified.",
                values: "Optional. Add users as chips with the lookup.",
              },
              {
                name: "Departments",
                what: "Every active user of a ticked department is notified too.",
                values: "Optional. Tick one or more departments.",
              },
              {
                name: "More e-mail addresses",
                what: "Shown when E-mail is ticked. Extra addresses outside the user list, e.g. a team mailbox. Critical alerts are e-mailed at once, Warning alerts in a 15-minute digest, and Info alerts only in the daily summary.",
                values:
                  "Comma-separated addresses. Example: `noc@company.example`. A wrong address is shown in red and blocks saving.",
              },
              {
                name: "Also e-mail the partner's contact",
                what: "Shown when E-mail is ticked. For partner-facing alerts: the e-mail also goes to this contact type of the customer or vendor the incident is about.",
                values: "No (internal alert) (default), Technical, Commercial, Rates or Finance.",
              },
            ],
          },
          {
            kind: "warning",
            text: "With **E-mail** ticked, the rule needs at least one recipient: a user, a department, an extra address or the partner's contact. Otherwise saving is refused.",
          },
          {
            kind: "tip",
            text: "Each user chooses their own sounds (and can mute them) under the avatar menu → **Alert sounds**. See [[alerts-and-popups]].",
          },
        ],
      },
      {
        id: "fields-repeat",
        title: "Fields: Repeat and recovery",
        blocks: [
          {
            kind: "fields",
            title: "Repeat and recovery",
            fields: [
              {
                name: "Re-alert every (min)",
                what: "While the problem lasts and nobody has acknowledged or snoozed the incident, the pop-up and sound come back every this many minutes.",
                values: "1 to 1440 minutes. Empty (default) = alert once.",
              },
              {
                name: "Quiet after recovery (min)",
                what: "The cooldown. After an incident recovers, the same rule does not open a new incident for the same customer, trunk or vendor for this many minutes. This stops alerts flapping on and off.",
                values: "Required, 0 to 1440 minutes. Default `15`.",
              },
              {
                name: "Recovery",
                what: "**Send an OK notice when it is back to normal**: a short green message (and, with E-mail, a recovery e-mail if an alert e-mail went out) when the incident recovers.",
                values: "Ticked by default.",
              },
            ],
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
              "Click **Add rule**.",
              "Enter a **Name**, keep **Status** on Active and choose the **Severity**.",
              "Choose the **Scope**. For customers, trunks or vendors, add the ones to watch, or leave the list empty to watch each one.",
              "Under **What to watch**, choose the **Metric** and the **Condition**, then fill in the value, the baseline, the window and the minimum sample.",
              "If the rule should only fire at certain times, untick **Always** and choose the days and hours (UTC).",
              "Under **Notify**, tick how people are told and choose the users or departments (leave both empty for everyone). With E-mail, add extra addresses or the partner's contact if needed.",
              "Set **Re-alert every (min)**, **Quiet after recovery (min)** and the **Recovery** notice.",
              "Click **Test on live traffic** to see what the rule would do right now (see below).",
              "Click **Add rule**. The rule starts being checked within a minute.",
            ],
          },
        ],
      },
      {
        id: "how-to-test",
        title: "How to test a rule before saving",
        blocks: [
          {
            kind: "text",
            text: "**Test on live traffic** checks the form as it is now against current traffic, without saving and without raising any alert. It works for new rules and for changes to an existing rule.",
          },
          {
            kind: "fields",
            title: "Test result table",
            fields: [
              {
                name: "Heading",
                what: "How many would fire now (or `Nothing would fire now`) and the time of the check.",
              },
              { name: "Scope", what: "Each customer, trunk or vendor the rule watches." },
              { name: "Now", what: "The metric's value in the current window." },
              { name: "Baseline", what: "The value it is compared with (previous window, yesterday or last week)." },
              { name: "Messages", what: "How many messages the value rests on (the sample)." },
              {
                name: "Result",
                what: "A red dot if it would fire, green if not, with the reason, e.g. `only 120 messages (minimum 500)`, `within the limit` or `the condition holds`.",
              },
            ],
          },
          {
            kind: "tip",
            text: "Only the first 12 lines are shown; a note says how many more there are. If a test shows dozens firing at once, the limit is probably too tight or the minimum sample too low.",
          },
        ],
      },
      {
        id: "how-to-manage",
        title: "How to edit, clone, switch off or delete a rule",
        blocks: [
          {
            kind: "list",
            items: [
              "**Edit**: double-click the row, press **Enter**, or click **Edit** in the detail panel. Change the form and click **Save**. Each save is one change you can undo with **Ctrl+Z** or from the History tab.",
              "**Disable / Enable**: in the detail panel. Disabling keeps the rule but stops it firing; its open incidents recover on the next check.",
              "**Clone**: asks for the name of the copy (default `<name> (copy)`) and creates a new rule with the same settings. Useful for the same rule with another scope or severity.",
              "**Incidents**: opens the Incidents page filtered to this rule.",
              "**Delete**: archives the rule. The confirmation lists its open incidents, which then close. Past incidents keep their rule name. An administrator can **Restore** a deleted rule. See [[safe-delete]].",
            ],
          },
          {
            kind: "warning",
            text: "A deleted rule cannot be edited or switched on until it is restored.",
          },
        ],
      },
      {
        id: "how-it-works",
        title: "How a rule fires",
        blocks: [
          {
            kind: "list",
            items: [
              "The server checks every active rule about every 15 seconds, but only inside its active hours.",
              "For each customer, trunk or vendor in the scope, it measures the metric over the window (e.g. the last 15 minutes) and the baseline.",
              "If the window has fewer messages than the minimum sample, nothing fires.",
              "**Above / Below**: fires when the value is above / below the limit. **Increase / Decrease by %**: fires when the change from the baseline is at least the given %. **Started sending**: no traffic in the window before, and at least the minimum sample now. **Stopped sending**: traffic in the window before, none in the current window. **Bind down**: fires while the trunk's bind is down.",
              "When it fires, an incident opens (unless the same rule recovered for the same scope within the quiet period). The people notified get a pop-up and/or sound; Critical e-mails go at once, Warning in the 15-minute digest, Info in the daily summary at 07:00 UTC.",
              "While it lasts, the incident keeps its current and peak value up to date and re-alerts at the repeat interval (unless acknowledged or snoozed).",
              "When the condition no longer holds, the incident recovers: it gets an end time, the OK notice goes out if ticked, and the quiet period starts.",
            ],
          },
          {
            kind: "text",
            text: "Alert e-mails use the **Monitoring Alert** template from [[email-templates|Email templates]] and appear in [[email-logs|Email logs]]. The older [[traffic-alerts|Traffic alerts]] only e-mail on low ASR / DLR; alert rules replace and extend them.",
          },
          {
            kind: "tip",
            text: "In the trial, rules run on the simulated live traffic, and baselines for yesterday and last week use each trunk's usual levels.",
          },
        ],
      },
      {
        id: "tips",
        title: "Tips and things to watch",
        blocks: [
          {
            kind: "tip",
            text: "Start with a 15-minute window and a minimum sample of a few hundred messages. Shorter windows and small samples give many false alarms.",
          },
          {
            kind: "tip",
            text: "For a customer who sends in bursts, use **Stopped sending** with a 30 or 60 minute window, and active hours that match their usual sending time.",
          },
          {
            kind: "tip",
            text: "Keep Critical for things someone must act on now: the Critical sound repeats every 15 seconds until the incident is acknowledged.",
          },
          {
            kind: "warning",
            text: "Leaving both **Users** and **Departments** empty notifies everyone. For a rule that is only for you, add yourself as the user.",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ Incidents
  {
    id: "incidents",
    pageKey: "incidents",
    title: "Incidents",
    group: "Monitoring",
    summary:
      "Every alert an alert rule has raised: when it started and ended, how long it lasted, the worst value, who acknowledged it, and notes. Acknowledge, snooze and investigate from here.",
    keywords: ["alerts", "incident log", "acknowledge", "snooze", "alarm history", "bell", "NOC", "outage"],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "Each time an [[alert-rules|alert rule]] fires for one customer, trunk or vendor, an incident is opened. This page lists all of them, newest first. The NOC uses it to see what is going on now, to acknowledge alerts, and to write down what was done. Managers use it to look back at how often and how long problems lasted.",
          },
          {
            kind: "text",
            text: "The bell in the top menu shows the count of open incidents and the latest ones; clicking an incident there opens it on this page. New and changed incidents refresh the list by themselves (at most every 5 seconds).",
          },
          {
            kind: "tip",
            text: "The pop-up and the incident show the value now (and what it was before), the rule's condition, the window it measured (e.g. **last 60 min**) and, for margin, ASR and DLR, the **worst destinations**, e.g. India (IN) -9.10 EUR. A 60-minute window can include the end of yesterday, so it can differ from Live analytics' Today, which starts at 00:00 UTC.",
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
              { name: "Incident", what: "The incident number." },
              { name: "Start Time", what: "When the rule first fired (UTC)." },
              { name: "End Time", what: "When it recovered, or a red `open` while it lasts." },
              {
                name: "Duration (s)",
                what: "How long it lasted (or has lasted so far), shown as e.g. `12 min` or `1 h 05 min`.",
              },
              { name: "Severity", what: "Info (grey), Warning (amber) or Critical (red), taken from the rule." },
              {
                name: "State",
                what: "**Open** (red dot): nobody has acknowledged it yet. **Acknowledged** (amber): someone is on it. **Recovered** (green): the condition no longer holds.",
              },
              { name: "Rule", what: "The alert rule that raised it." },
              { name: "Scope", what: "The customer, trunk or vendor (or All traffic) it is about." },
              { name: "Metric", what: "The metric of the rule, e.g. DLR or TPS." },
              {
                name: "What happened",
                what: "The alert in plain words, e.g. `Acme Mobile DLR dropped from 92 % to 61 % in 15 min`. It is kept up to date while the incident is open.",
              },
              {
                name: "Peak",
                what: "The worst value reached: the highest for Above / Increase rules, the lowest for Below / Decrease rules.",
              },
              { name: "Acknowledged By", what: "Who acknowledged it, or —." },
            ],
          },
          {
            kind: "text",
            text: "Hidden columns: **Acknowledged At**, **Notes** (number of notes), **Rule ID** and **Scope Kind**. Open Critical incidents are highlighted in the grid.",
          },
          {
            kind: "list",
            title: "Header",
            items: [
              "**Export** downloads the incidents that match the current filters (up to 100,000 rows).",
              "The quick search looks in What happened, Rule and Scope.",
            ],
          },
        ],
      },
      {
        id: "detail",
        title: "The incident detail",
        blocks: [
          {
            kind: "fields",
            title: "Incident tab",
            fields: [
              { name: "What happened", what: "The alert text." },
              { name: "Rule", what: "The rule name and its full condition." },
              {
                name: "Now / baseline / peak",
                what: "The latest measured value, the value it was compared with, and the worst value so far.",
              },
              { name: "Started / Ended", what: "Start and end time in UTC; `still open` while it lasts." },
              { name: "Duration", what: "How long it lasted." },
              { name: "Acknowledged", what: "Who acknowledged it and when." },
              { name: "Snoozed until", what: "Shown while a snooze is running." },
              { name: "E-mailed", what: "When the alert e-mail went out, if the rule sends e-mail." },
              { name: "Notes", what: "Notes from users (and the system), with name and time." },
            ],
          },
          {
            kind: "list",
            title: "Buttons",
            items: [
              "**Acknowledge** (only while Open): marks that you are on it. The state becomes Acknowledged, your name is stored, and the rule stops re-alerting and ringing.",
              "**Snooze…** (until it recovers): **15 min**, **1 hour** or **Until tomorrow** (07:00 UTC the next day). Re-alerts and the repeating sound stop for that time; the incident stays open.",
              "**Open in Analytics**: opens [[live-analytics|Live analytics]] for the customer, vendor or trunk of the incident, so you can see the traffic around it.",
              "**Add a note** box and **Add** (or Enter): writes a note, up to 2,000 characters.",
            ],
          },
        ],
      },
      {
        id: "how-to-handle",
        title: "How to handle an incident",
        blocks: [
          {
            kind: "steps",
            items: [
              "Click the incident in the grid, the bell, or **Acknowledge** on the pop-up card.",
              "Click **Acknowledge** so colleagues can see someone is on it.",
              "Click **Open in Analytics** to look at the traffic; check [[edr-search|EDR search]] for the failing messages and [[network-status|Network status]] for binds.",
              "Write what you found and did in **Add a note**.",
              "If you need time, use **Snooze…** so the alert does not ring again meanwhile.",
              "The incident recovers by itself when the metric is back to normal; you do not close it by hand.",
            ],
          },
        ],
      },
      {
        id: "how-to-find",
        title: "How to find past incidents",
        blocks: [
          {
            kind: "list",
            items: [
              "Filter **State** to Open and Acknowledged to see what is still going on.",
              "Filter **Rule** or **Scope** to see how often one customer or rule had problems; filter **Start Time** for a period.",
              "From an alert rule's detail panel, **Incidents** opens this page already filtered to that rule.",
              "Sort **Duration (s)** descending to find the longest problems. See [[grids-and-filters]] and [[filter-builder]].",
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
            text: "A recovered incident cannot be acknowledged or snoozed any more. You can still add notes.",
          },
          {
            kind: "tip",
            text: "Deleting or disabling a rule closes its open incidents on the next check; the incidents stay in the list.",
          },
          {
            kind: "tip",
            text: "Pop-ups, sounds and the bell are explained in [[alerts-and-popups]].",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ EDR search
  {
    id: "edr-search",
    pageKey: "edr-search",
    title: "EDR search",
    group: "Monitoring",
    summary:
      "Find any single message and see everything about it: the customer leg, the vendor leg, every routing attempt, the delivery result, money and HLR. Send selected EDRs in a trouble ticket, re-send them to another vendor, or export them.",
    keywords: [
      "EDR",
      "CDR",
      "message record",
      "edrdeck",
      "message trace",
      "msg id",
      "DLR",
      "delivery receipt",
      "cause code",
      "trouble ticket",
      "repush",
      "message status",
      "DELIVRD",
      "UNDELIV",
    ],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "An EDR (event data record) is the record of one message attempt. It holds both legs: the **customer leg** (what the customer sent us, on which trunk, at what rate) and the **vendor leg** (which vendor we sent it to, at what cost), plus the outcome. If a message was re-routed, each attempt has its own EDR; the last one is the **final attempt**.",
          },
          {
            kind: "text",
            text: "Use it to answer questions like: did this number get the message, why did it fail, which vendor carried it, what did we charge and pay? The NOC and support use it daily; Account Managers use it to answer customer complaints.",
          },
        ],
      },
      {
        id: "filters",
        title: "The filter card",
        blocks: [
          {
            kind: "fields",
            title: "Filters above the grid",
            fields: [
              {
                name: "Period chip",
                what: "The time range on **Start Time**, in UTC, e.g. `Today · 22 Oct 2026 07:00 → 22 Oct 2026 08:00 UTC`. Click it to set From and To (fill one or both), then **Apply**.",
                values: "Date and time, e.g. `2026-10-16 08:00` to `2026-10-16 09:00`.",
              },
              {
                name: "Status",
                what: "Message statuses to show (none ticked = all), and **Final attempt only** (hides attempts that were re-routed; tick it to count each message once).",
                values: "Any number of statuses; Final on or off.",
              },
              {
                name: "Number, sender, message ID…",
                what: "One search box for receiver numbers (DNID), sender IDs, Customer Msg IDs and Vendor Msg IDs, mixed in any order. Each value finds the EDRs whose number, sender, customer message ID or vendor message ID (any part of a long message) starts with it: `2348` finds every number starting 2348, a whole number finds that number. The grid updates as you type.",
                values:
                  "One or more values separated by commas, semicolons or new lines. A number may have `+`, spaces or dashes. Example: `2348030000001, ACMEBANK, 586f7e92c4d1471d`.",
              },
              {
                name: "Destinations",
                what: "**Destinations: All** opens a country / network tree; tick countries or networks (select all works too) and click **Apply**. The chip shows how many networks are chosen.",
                values: "Empty = all destinations.",
              },
              {
                name: "Template",
                what: "Picks a saved column set from [[edr-templates|EDR templates]]. `Template: default columns` goes back to the standard columns.",
              },
            ],
          },
          {
            kind: "text",
            text: "Every grid column also has its own filter under the header (text with `%` and `_` wildcards, numbers, lists, dates), and the filter builder can combine conditions with AND / OR. The quick search takes a sender, a number (or several numbers), a message ID, or a customer / vendor / trunk name. See [[grids-and-filters]] and [[filter-builder]].",
          },
          {
            kind: "tip",
            text: "There are millions of EDRs. Always set a time range first, then narrow down; searches over short periods are much faster.",
          },
        ],
      },
      {
        id: "layout",
        title: "What you see on the page",
        blocks: [
          {
            kind: "list",
            title: "Header and status bar",
            items: [
              "**Templates** opens the EDR templates page.",
              "**Export** opens the EDR Download Request (see below).",
              "Tick rows (or press Space) to select them; the bulk menu offers **Trouble Ticket…** and **EDR Repush…**.",
              "The status bar shows the number of rows and how many EDRs are selected.",
            ],
          },
          {
            kind: "fields",
            title: "Default grid columns",
            fields: [
              { name: "Start Time", what: "When we received the message from the customer (UTC, to the second)." },
              { name: "Customer Enterprise", what: "The customer who sent the message." },
              { name: "Customer Trunk", what: "The customer's trunk (connection) it came in on." },
              { name: "Customer Msg ID", what: "The message ID we gave the customer." },
              { name: "Sender ID", what: "The sender name or number (source address)." },
              { name: "DNID", what: "The receiver's number (destination address)." },
              { name: "Customer MCCMNC", what: "The mobile network of the receiver, as found for the customer side." },
              { name: "Vendor Enterprise", what: "The vendor it was sent to, or `not routed`." },
              { name: "Vendor Trunk", what: "The vendor trunk used." },
              { name: "Vendor Msg ID", what: "The message ID the vendor returned." },
              {
                name: "Cause Code",
                what: "The SMPP result code of the submit to the vendor (or of our own rejection). `0 OK` is muted; any other code is red, e.g. `88 Throttling error`.",
              },
              {
                name: "Message Status",
                what: "The delivery receipt status. Green: DELIVRD. Red: UNDELIV, REJECTD, EXPIRED, DELETED. Amber: UNKNOWN. Others (ACCEPTD, SENT, ACKED, BUFFRED, ENROUTE) are neutral; — means no receipt yet.",
              },
              { name: "Delivery Delay (s)", what: "Seconds from submit to delivery." },
            ],
          },
        ],
      },
      {
        id: "columns-customer",
        title: "All EDR columns: customer leg",
        blocks: [
          {
            kind: "text",
            text: "Add any of these from the column chooser or an EDR template. They also show in the **Customer leg** tab of the detail panel.",
          },
          {
            kind: "fields",
            fields: [
              { name: "Customer Enterprise / Customer Enterprise ID", what: "The customer's name and number." },
              { name: "Customer Trunk / Customer Trunk ID", what: "The customer trunk's name and number." },
              { name: "Customer IP / Customer Port", what: "The address and port the customer connected from." },
              { name: "Session ID", what: "The customer's SMPP session (connection) the message came on." },
              { name: "Bind Type", what: "How the customer bound: TX (send only), RX (receive only) or TR (both)." },
              { name: "Protocol", what: "SMPP or HTTP." },
              { name: "Customer Msg ID", what: "The ID we returned to the customer; they use it to match receipts." },
              {
                name: "Type",
                what: "MT (mobile-terminated, sent to a phone) or MO (mobile-originated, from a phone).",
              },
              { name: "Sender ID", what: "Source address as received." },
              { name: "DNID", what: "Destination number as received." },
              { name: "Routed Dest Addr", what: "The destination after number translation, as sent onward." },
              {
                name: "SRC TON / SRC NPI / DST TON / DST NPI",
                what: "Type of number and numbering plan of the sender and receiver, as SMPP codes (e.g. TON 1 = international, 5 = alphanumeric).",
              },
              { name: "Coding", what: "Data coding of the text: 0 = GSM 7-bit, 8 = UCS-2 (Unicode), and so on." },
              { name: "Message Text", what: "The text of the message." },
              {
                name: "Customer MCCMNC / MCC / MNC / Country",
                what: "The receiver's network, country code, network code and country.",
              },
              { name: "Product Category / Product Category ID", what: "The product category of the traffic." },
              { name: "Business Company ID", what: "Which of our business companies the customer belongs to." },
              {
                name: "Customer Billing Type",
                what: "How the customer is billed for this message (e.g. on submit or on delivery).",
              },
              { name: "Rate Table ID", what: "The customer rate table used." },
              { name: "Rate / Currency", what: "The customer's price for this message and its currency." },
              { name: "Sys Rate", what: "The same price in the platform's base currency." },
              { name: "Translation Rule IDs", what: "The number translation rules applied on the customer side." },
              { name: "Customer Msg Status", what: "The receipt status we sent back to the customer." },
            ],
          },
        ],
      },
      {
        id: "columns-vendor",
        title: "All EDR columns: vendor leg",
        blocks: [
          {
            kind: "fields",
            fields: [
              {
                name: "Vendor Enterprise / Vendor Enterprise ID",
                what: "The vendor's name and number; empty if not routed.",
              },
              { name: "Vendor Trunk / Vendor Trunk ID", what: "The vendor trunk used." },
              { name: "Vendor IP / Vendor Port", what: "The vendor's address and port." },
              {
                name: "Vendor Msg ID",
                what: "The ID the vendor returned; quote it when you ask the vendor about a message.",
              },
              { name: "Vendor MCCMNC", what: "The network as seen on the vendor side." },
              { name: "Vendor Billing Type", what: "How the vendor bills us for it." },
              { name: "Vendor Rate Table ID", what: "The vendor rate table used." },
              { name: "Vendor Rate / Vendor Currency", what: "The vendor's price and currency." },
              { name: "Vendor Sys Rate", what: "The vendor price in base currency." },
              { name: "ExRate", what: "The exchange rate used to convert the vendor price." },
              { name: "Vendor Translation Rule IDs", what: "Number translation rules applied on the vendor side." },
              {
                name: "Route Rule ID / Route Rule Group ID",
                what: "The [[route-rules|route rule]] (and its group) that picked the vendor.",
              },
              {
                name: "Decided By",
                what: "What decided the vendor: `split` (normal vendor order or percentage split), `whitelist`, `warmup`, `qbr` (quality-based routing), `backup` or `lcr` (least cost routing).",
              },
              { name: "DLR ReRoute", what: "Yes if this attempt was re-routed because of a failed delivery receipt." },
              {
                name: "Repush Request ID",
                what: "Set when the attempt was created by an EDR repush (see [[repush]]).",
              },
            ],
          },
        ],
      },
      {
        id: "columns-outcome",
        title: "All EDR columns: outcome, money and HLR",
        blocks: [
          {
            kind: "fields",
            title: "Outcome",
            fields: [
              { name: "Start Time", what: "When we received the message." },
              { name: "Submit Time", what: "When we sent it to the vendor." },
              { name: "SubmitResp Time", what: "When the vendor answered the submit." },
              { name: "Delivery Time", what: "When the delivery receipt came back." },
              { name: "Attempt No", what: "1 for the first try, 2 for the first re-route, and so on." },
              { name: "Final", what: "Yes on the last attempt of a message." },
              { name: "Submit Success", what: "Yes if the vendor accepted the submit." },
              { name: "Cause Code / Cause", what: "The SMPP result code and its name (e.g. `ESME_RTHROTTLED`)." },
              { name: "Message Status", what: "The delivery receipt status." },
              { name: "Delivery Error", what: "The error code in the delivery receipt (`000` = none)." },
              { name: "Network Error", what: "The network error code from the receipt, if any." },
              { name: "Registered Delivery", what: "Whether the customer asked for a delivery receipt (SMPP flag)." },
              { name: "MSG Count", what: "Number of SMS parts for long messages." },
              { name: "UDH", what: "The user data header (used for long-message parts)." },
              { name: "Delivery Delay (s)", what: "Seconds from submit to delivery." },
              { name: "Buffered", what: "Yes if the message waited in a queue before sending." },
              { name: "UUID", what: "The EDR's unique ID." },
            ],
          },
          {
            kind: "fields",
            title: "Money & HLR",
            fields: [
              {
                name: "Customer Billable / Vendor Billable",
                what: "Whether the message is charged to the customer / by the vendor.",
              },
              { name: "Revenue / Cost", what: "What we charge and what we pay, in the leg's currency." },
              { name: "Revenue (base) / CostSysRate", what: "The same in base currency." },
              { name: "HLR Provider / HLR Provider ID", what: "The HLR (number lookup) provider used, if any." },
              { name: "HLR Fetch Type", what: "`none`, `cached` (from the lookup cache) or `live`." },
              { name: "HLR Is Ported", what: "Yes if the number was moved to another network." },
              { name: "HLR Is Accomplished", what: "Yes if the lookup succeeded." },
              { name: "HLR Error Code", what: "The lookup error code, if any." },
              { name: "HLR Cost", what: "What the lookup cost, in base currency." },
            ],
          },
        ],
      },
      {
        id: "detail",
        title: "The EDR detail panel",
        blocks: [
          {
            kind: "text",
            text: "Click a row to open it. The title shows sender → receiver, the start time, the attempt number (and `(final)`), and the status or the error.",
          },
          {
            kind: "list",
            items: [
              "**Customer leg**, **Vendor leg**, **Outcome** and **Money & HLR** tabs list every field above for this EDR.",
              "The **Outcome** tab has **Trouble Ticket** and **Repush** buttons for this one EDR.",
              "**Attempts** lists every attempt of the same message (same Customer Msg ID and customer trunk): number, start, vendor trunk (or `not routed`), cause, status and whether it is final. The attempt you opened is highlighted.",
            ],
          },
        ],
      },
      {
        id: "trouble-ticket",
        title: "How to send a trouble ticket",
        blocks: [
          {
            kind: "steps",
            items: [
              "Select the EDRs (or open one) and choose **Trouble Ticket…** (or **Trouble Ticket** in the detail).",
              "Fill in the form below and click **Preview** to see the recipients, subject and body.",
              "Click **Send Mail**. The EDRs go in the body and as a CSV attachment; the e-mail is logged in [[email-logs|Email logs]].",
            ],
          },
          {
            kind: "fields",
            title: "Trouble Ticket form",
            fields: [
              {
                name: "Ticket Send To",
                what: "Customer or Vendor. Vendor is preselected when the EDRs have a vendor.",
                values: "For Customer, all EDRs must belong to one customer.",
              },
              {
                name: "Vendor Trunk",
                what: "Shown for Vendor: whose technical contact gets the ticket. Preselected from the EDRs.",
                values: "Required for Vendor.",
              },
              {
                name: "Trouble Ticket Template",
                what: "The e-mail template (type Trouble Ticket) to use.",
                values: "Required.",
              },
              {
                name: "Email Subject",
                what: "Overrides the template's subject.",
                values: "Optional, up to 200 characters.",
              },
              {
                name: "Attachment",
                what: "An extra file to attach, e.g. a screenshot.",
                values: "Optional, up to 5 MB.",
              },
              {
                name: "Email Columns",
                what: "The EDR columns to include in the e-mail.",
                values:
                  "At least one. Default: Submit Time, Customer Msg ID, Vendor Msg ID, Sender ID, DNID, Message Status, Delivery Error.",
              },
            ],
          },
          {
            kind: "warning",
            text: "The preview shows `no technical contact` in red when the partner has no technical contact e-mail. Add one on the enterprise first.",
          },
        ],
      },
      {
        id: "repush",
        title: "How to re-send EDRs to another vendor (repush)",
        blocks: [
          {
            kind: "steps",
            items: [
              "Select the EDRs and choose **EDR Repush…** (or **Repush** in the detail).",
              "Pick an active **Vendor Trunk**. The dialog says how many of the selected EDRs can be re-sent.",
              "Click **Proceed**. A message shows the repush request number and how many were delivered and failed; the [[repush|Repush requests]] page opens.",
            ],
          },
          {
            kind: "text",
            text: "Only final attempts that were not delivered are re-sent; the others are skipped. Each re-sent EDR becomes a new attempt on the chosen trunk, marked with the repush request, and the old one stops being the final attempt.",
          },
          {
            kind: "tip",
            text: "In the trial, re-sent messages are simulated: about 8 in 10 come back delivered.",
          },
        ],
      },
      {
        id: "export",
        title: "How to download EDRs",
        blocks: [
          {
            kind: "steps",
            items: [
              "Set the filters and sort you want.",
              "Click **Export**. The **EDR Download Request** dialog opens.",
              "Choose the **Download File Type**: CSV or XLSX.",
              "Choose the **EDR Template** for the columns, or keep **The columns shown now**.",
              "Click **Request**. The request is queued and the [[edr-download|EDR download]] page opens; download the file there when it is ready.",
            ],
          },
          {
            kind: "text",
            text: "Downloads run in the background, with at most 1,000,000 rows (1,048,575 for XLSX).",
          },
        ],
      },
      {
        id: "tips",
        title: "Tips and things to watch",
        blocks: [
          {
            kind: "tip",
            text: "To count messages rather than attempts, tick **Final**.",
          },
          {
            kind: "tip",
            text: "A message with no vendor and a red cause code was rejected before routing; those also appear in [[failed-edr|Failed EDRs]].",
          },
          {
            kind: "tip",
            text: "To test how a number would be routed now, use the [[simulator|Route simulator]].",
          },
          {
            kind: "warning",
            text: "What you can see depends on your account-manager visibility; masked customers or vendors stay masked here. See [[am-visibility]].",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ EDR download
  {
    id: "edr-download",
    pageKey: "edr-download",
    title: "EDR download",
    group: "Monitoring",
    summary:
      "Background EDR exports requested from EDR search: progress, status, and the file to download when it is ready.",
    keywords: ["EDR export", "EDR request", "download", "CSV", "XLSX", "Excel", "background job"],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "Large EDR exports take time, so they run in the background. You ask for one from [[edr-search|EDR search]] (**Export**), and it appears here. Come back when it is done and download the file. The page refreshes itself every 3 seconds.",
          },
          {
            kind: "text",
            text: "The **EDR Search** button in the bar above the grid takes you back to set up a new request.",
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
              { name: "EDR No", what: "The request number." },
              {
                name: "Status",
                what: "Pending (waiting its turn), In progress (with a progress bar), Success (green), Failed (red) or Cancelled.",
              },
              { name: "File", what: "The file name; click it to download (only when Success)." },
              { name: "File Type", what: "CSV or XLSX." },
              { name: "Progress", what: "Percentage done." },
              { name: "Rows", what: "How many EDRs the file holds." },
              { name: "Filters", what: "The filters of the request, in words." },
              {
                name: "Request Start Time / Request End Time",
                what: "When it was asked for and when it finished (UTC).",
              },
              { name: "Error", what: "Why it failed, in red." },
              { name: "Requested By", what: "Who asked for it." },
              { name: "Action", what: "**Download** when ready; **Cancel** while Pending or In progress." },
            ],
          },
          {
            kind: "text",
            text: "The detail panel shows the filters, the columns (template name or `As shown when requested`), rows, file size, who requested it and when, finish time and any error.",
          },
        ],
      },
      {
        id: "how-to",
        title: "How to request and download EDRs",
        blocks: [
          {
            kind: "steps",
            items: [
              "Open [[edr-search|EDR search]], set the time range and filters.",
              "Click **Export**, choose CSV or XLSX and an EDR template (or the columns shown now), and click **Request**.",
              "On this page, wait until the status is Success.",
              "Click the file name or **Download**.",
            ],
          },
          {
            kind: "tip",
            text: "Requests run one at a time. Cancel requests you no longer need so others are not held up.",
          },
          {
            kind: "warning",
            text: "A file holds at most 1,000,000 rows (1,048,575 for XLSX). Split long periods into several requests.",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ EDR templates
  {
    id: "edr-templates",
    pageKey: "edr-templates",
    title: "EDR templates",
    group: "Monitoring",
    summary:
      "Saved sets of EDR columns, in order, used to switch the EDR search grid, choose the columns of an EDR download, and so on.",
    keywords: ["EDR columns", "column set", "template", "layout", "saved view"],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "An EDR has over 100 columns. A template is a named list of the columns you need for one job, e.g. `Billing check` (rates, revenue, cost) or `Delivery check` (IDs, status, delay). Pick it in the **Template** box on [[edr-search|EDR search]] or in the EDR download request.",
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
              { name: "Info ID", what: "The template number." },
              { name: "Name", what: "The template name." },
              { name: "Columns", what: "How many columns it has." },
              { name: "Updated By / Updated Time", what: "Who saved it last and when." },
            ],
          },
          {
            kind: "text",
            text: "The detail panel's **Columns** tab lists the columns in order, with **Edit** and **Delete**; the **History** tab lists every change. **Add** (the blue button) creates a template.",
          },
        ],
      },
      {
        id: "fields",
        title: "Fields in the template form",
        blocks: [
          {
            kind: "fields",
            fields: [
              {
                name: "Name",
                what: "The template's name, unique among templates (not case-sensitive).",
                values: "Required, up to 100 characters.",
              },
              {
                name: "Column Selection",
                what: "The columns, in the order they will appear. Tick columns in the list on the right to add them (they go to the end); use ↑ and ↓ to move one, and × to remove it.",
                values:
                  "At least one column. A new template starts with Start Time, Customer Trunk, Sender ID, DNID and Message Status.",
              },
            ],
          },
        ],
      },
      {
        id: "how-to",
        title: "How to add, change or delete a template",
        blocks: [
          {
            kind: "steps",
            title: "Add",
            items: [
              "Click **Add**.",
              "Enter the **Name**.",
              "Tick the columns and put them in order.",
              "Click **Add template**.",
            ],
          },
          {
            kind: "list",
            items: [
              "**Edit**: double-click the row (or **Edit** in the detail), change it and click **Save**. Each save can be undone with **Ctrl+Z**. See [[undo-and-history]].",
              "**Delete**: archives the template; an administrator can restore it. See [[safe-delete]].",
            ],
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ Network status
  {
    id: "network-status",
    pageKey: "network-status",
    title: "Network status",
    group: "Monitoring",
    summary:
      "Live bind status of every customer and vendor trunk: connections, queue, TPS and status, with Start / Stop per trunk and the SMPP sessions behind each one.",
    keywords: ["binds", "bind status", "SMPP sessions", "connections", "online", "offline", "queue", "kick", "unbind"],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "A **bind** is an SMPP connection (SMPP is the protocol SMS traffic uses between platforms). On the **Customer** tab you see the sessions each customer has opened to us; on the **Vendor** tab, the connections we hold to each vendor. The NOC uses it to see who is connected, spot queues building up, and restart a bind. The page refreshes every 10 seconds.",
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
              { name: "Enterprise ID / Trunk ID", what: "The numbers of the enterprise and trunk." },
              { name: "Enterprise Name / Trunk Name", what: "Their names." },
              { name: "IP Address", what: "The IP addresses of the trunk." },
              { name: "Number of Connections", what: "Open connections out of the maximum allowed, e.g. `2 / 4`." },
              {
                name: "Queue",
                what: "Vendor tab only: messages waiting to be sent to the vendor. Amber when above 200.",
              },
              { name: "TPS", what: "Current messages per second on the trunk." },
              {
                name: "Status",
                what: "**Online** (green): bound. **Offline** (red): not connected. **Stopped** (amber): stopped by a user with Stop.",
              },
              { name: "Since", what: "When the status last changed (UTC)." },
              { name: "Action", what: "**Stop** for an online trunk, **Start** otherwise." },
            ],
          },
          {
            kind: "list",
            items: [
              "Hidden columns: **Max Connections** and **Changed By**.",
              "**CSV** and **Excel** download the rows that match the current filters.",
              "The detail panel lists the trunk's **SMPP sessions**: session ID, remote address, bind type (TX, RX or TR), since when, messages submitted, and delivery receipts waiting to go back.",
            ],
          },
        ],
      },
      {
        id: "how-to",
        title: "How to stop or start a bind",
        blocks: [
          {
            kind: "steps",
            items: [
              "Choose the **Customer** or **Vendor** tab and find the trunk.",
              "Click **Stop** and confirm. For a vendor, the switch unbinds its connections and messages waiting in the queue are re-routed. For a customer, its sessions are closed and new binds are refused until Start.",
              "Click **Start** to bring it back. A vendor trunk is bound again at once; a customer's binds are accepted again and the customer reconnects within a few seconds.",
            ],
          },
          {
            kind: "warning",
            text: "Stopping a customer cuts their traffic until someone clicks Start. Tell the account manager first.",
          },
        ],
      },
      {
        id: "how-it-works",
        title: "How it works",
        blocks: [
          {
            kind: "text",
            text: "Delivery receipts go back on the same session the message came in on (session affinity). The **Receipts waiting** count in the sessions table shows receipts still to be returned. A vendor trunk going Offline can raise a **Bind down** alert if you have an [[alert-rules|alert rule]] for it.",
          },
          {
            kind: "tip",
            text: "In the trial, binds and sessions are simulated and nothing is actually connected or disconnected.",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ PCAP trace
  {
    id: "pcap-trace",
    pageKey: "pcap-trace",
    title: "PCAP trace",
    group: "Monitoring",
    summary:
      "Every SMPP packet on the switch is recorded and kept 60 days. Download the 15-minute trace files, or extract a PCAP for a period and a trunk, number, message ID or IP.",
    keywords: ["PCAP", "trace", "recording", "Wireshark", "extract", "packet capture", "past traffic"],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "The switch records all SMPP traffic all the time, so you can look at the packets of something that already happened (a customer's complaint from yesterday, a vendor's receipts last week) without having started a capture first. For a capture from now on, use [[signaling|Signaling deck]], which also has this extract filter (**Extract from the recording**) and lists both kinds of file.",
          },
        ],
      },
      {
        id: "trace-files",
        title: "Trace files",
        blocks: [
          {
            kind: "fields",
            fields: [
              {
                name: "File Name",
                what: "`trace-YY-MM-DD-HH-MM-SS.pcap.gz`: one file per 15 minutes, named by its start (UTC). The newest file is still being written (`.pcap`, marked **recording**); the others are gzip-compressed.",
              },
              { name: "File Size", what: "The file's size." },
              { name: "Update Time (UTC)", what: "When the file was closed (or last written, for the newest)." },
              { name: "Download", what: "Click the name, the button, or double-click the row. Opens in Wireshark." },
            ],
          },
          {
            kind: "text",
            text: "Files older than 60 days are deleted automatically. Filter by name or time under the column headers.",
          },
        ],
      },
      {
        id: "extract",
        title: "Extract a PCAP",
        blocks: [
          {
            kind: "fields",
            fields: [
              { name: "From / To (UTC)", what: "The period, at most 24 hours, inside the last 60 days." },
              { name: "Customer trunk / Vendor trunk", what: "Only that trunk's traffic. Leave **Any** for all." },
              { name: "Number", what: "Messages with this sender or receiver." },
              { name: "Message ID", what: "One message (ours or the vendor's) and its receipts." },
              { name: "IP", what: "An address or range." },
            ],
          },
          {
            kind: "steps",
            items: [
              "Set the period and any filters (all filters must match).",
              "Click **Extract PCAP**. The page switches to **Extracted files**, where the file is ready in a few seconds.",
              "Download it. Extracted files are deleted 30 days after they are made unless you tick **Keep**.",
            ],
          },
        ],
      },
    ],
  },
  // ------------------------------------------------------------------ Signaling deck
  {
    id: "signaling",
    pageKey: "signaling",
    title: "Signaling deck",
    group: "Monitoring",
    summary: "Capture SMPP traffic on the switch into PCAP files that you download and open in Wireshark.",
    keywords: ["PCAP", "trace", "packet capture", "Wireshark", "SMPP trace", "tcpdump", "signaling"],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "When a partner reports a problem the EDRs cannot explain (wrong TON/NPI, bad encoding, missing receipts), capture the raw SMPP messages and look at them in Wireshark or send them to the partner. Mainly for the NOC.",
          },
        ],
      },
      {
        id: "fields",
        title: "Fields to start a capture",
        blocks: [
          {
            kind: "fields",
            fields: [
              {
                name: "Filter",
                what: "Only capture traffic to and from this IP address or range.",
                values:
                  "Optional. An IPv4 / IPv6 address or range, e.g. `10.0.0.5` or `10.0.0.0/24`. Empty = all SMPP traffic.",
              },
              {
                name: "Max Duration (s)",
                what: "The capture stops after this many seconds.",
                values: "1 to 3600. Default 60.",
              },
              {
                name: "Max File Size (bytes)",
                what: "The capture stops when the file reaches this size. The size in KB / MB is shown next to it.",
                values: "1024 to 104857600 (100 MB). Default 10485760 (10 MB).",
              },
            ],
          },
          {
            kind: "text",
            text: "Click **Start**. The capture stops at whichever limit comes first, or when you click **Stop**.",
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
              { name: "Sr. No.", what: "The capture number." },
              { name: "File Name", what: "The PCAP file; click to download." },
              { name: "Filter", what: "The IP filter, or `all`." },
              { name: "Status", what: "Running, Done (green), Stopped or Failed (red)." },
              { name: "File Size / Packets", what: "How much has been captured so far." },
              { name: "Update Time", what: "Last update (UTC)." },
              { name: "Started By", what: "Who started it." },
              {
                name: "Keep",
                what: "Tick to keep the file for good (for example during a dispute). Untick to let it expire again.",
              },
              {
                name: "Deleted on",
                what: "When the file is deleted: 30 days after the capture ended, unless **Keep** is ticked (then it shows **Kept**).",
              },
              { name: "Action", what: "**Stop** while running; **Download** afterwards." },
            ],
          },
          {
            kind: "warning",
            text: "Capture files hold phone numbers and message text. They are deleted 30 days after the capture ends; download what you need to share, or tick **Keep**.",
          },
          {
            kind: "text",
            text: "The detail panel shows the filter, the limits, packets and size, who started it and when. Running captures refresh every 2 seconds.",
          },
        ],
      },
      {
        id: "tips",
        title: "Tips and things to watch",
        blocks: [
          {
            kind: "warning",
            text: "At most three captures can run at the same time. Stop one before starting another.",
          },
          { kind: "tip", text: "Use a filter for one partner's IP; capturing all SMPP traffic fills the file fast." },
          {
            kind: "tip",
            text: "In the trial, capture files are built from simulated SMPP traffic; they open in Wireshark but contain no real messages.",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ Failed EDRs
  {
    id: "failed-edr",
    pageKey: "failed-edr",
    title: "Failed EDRs",
    group: "Monitoring",
    summary:
      "Messages we rejected before routing them to any vendor, with the error, plus the Failed EDR Download list for background exports.",
    keywords: ["failed EDR", "rejected", "error code", "before routing", "no route", "failed edr download"],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "Some messages never reach a vendor: the sender is invalid, there is no route, the customer is out of credit, and so on. These have no vendor leg. Support and Account Managers use this page to show a customer why their messages were refused.",
          },
          {
            kind: "text",
            text: "Two tabs at the top: **Failed EDR Search** (the messages) and **Failed EDR Download** (background exports, same as [[edr-download|EDR download]]).",
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
              "**From Date** and **To Date** (UTC) above the grid set the time range.",
              "**Export** opens the **Failed EDR Request** dialog: choose CSV or XLSX and click **Generate Request**; it appears on the Failed EDR Download tab.",
            ],
          },
          {
            kind: "fields",
            title: "Grid columns",
            fields: [
              { name: "Time", what: "When the message arrived (UTC)." },
              { name: "Customer Enterprise / Customer Trunk", what: "Who sent it and on which trunk." },
              { name: "Customer IP", what: "The address it came from." },
              { name: "Customer Msg ID", what: "The message ID given to the customer." },
              { name: "Sender ID / DNID", what: "Sender and receiver." },
              { name: "MCCMNC", what: "The receiver's network." },
              { name: "Error Code", what: "The SMPP error code and name, in red." },
              { name: "Error", what: "The error name, e.g. `ESME_RINVSRCADR`." },
            ],
          },
          {
            kind: "text",
            text: "Hidden columns: UUID, IDs, **Port**, **Country** and **Message Text**. The detail panel shows the customer and trunk, address and port, message ID, destination, error, text and UUID, with a **Copy Msg ID** button.",
          },
        ],
      },
      {
        id: "how-to",
        title: "How to find and re-send failed messages",
        blocks: [
          {
            kind: "steps",
            items: [
              "Set **From Date** and **To Date**.",
              "Filter by customer, trunk, Error Code or message ID.",
              "Open a row to see the details, or tick rows and choose **Repush … to a vendor…** to send them through a chosen active vendor trunk (see [[repush]]).",
              "To share the list, click **Export** → **Generate Request**, then download it from the **Failed EDR Download** tab.",
            ],
          },
          {
            kind: "warning",
            text: "Fix the cause (route, credit, sender) before re-sending; otherwise the customer's next messages fail the same way.",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ Network diagnosis
  {
    id: "diagnosis",
    pageKey: "diagnosis",
    title: "Network diagnosis",
    group: "Monitoring",
    summary: "Run Ping, Trace Route, MTR or Telnet from the switch host to check a partner's connection.",
    keywords: ["ping", "traceroute", "trace route", "MTR", "telnet", "port check", "connectivity", "network test"],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "When a bind will not come up, check from the switch itself whether the partner's host can be reached and whether its SMPP port is open. The output shows as the tool prints it. The last 10 runs stay on the page until you close the tab.",
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
                name: "Tool",
                what: "**Ping**: is the host reachable and how fast. **Trace Route**: the path of hops to the host. **MTR**: trace route with loss and delay per hop. **Telnet**: is a port open.",
                values: "Default Ping.",
              },
              {
                name: "Destination",
                what: "The host to test.",
                values: "Required. A host name or IP, e.g. `198.51.100.20`.",
              },
              {
                name: "Source",
                what: "Which IP of the switch to send from, when it has several.",
                values: "Optional. Must be an IP address.",
              },
              {
                name: "Count",
                what: "Not for Telnet: how many probes to send.",
                values: "1 to 20. Default 4.",
              },
              {
                name: "Port",
                what: "Telnet only: the port to try.",
                values: "Required, 1 to 65535. Default 2775 (SMPP).",
              },
            ],
          },
        ],
      },
      {
        id: "how-to",
        title: "How to run a test",
        blocks: [
          {
            kind: "steps",
            items: [
              "Choose the **Tool**.",
              "Enter the **Destination** (and Source, Count or Port).",
              "Click **Go** or press Enter.",
            ],
          },
          {
            kind: "text",
            text: "Each run shows the command, a green dot (exit 0, success) or red dot (failure), the exit code, how long it took, the time in UTC, and the output.",
          },
          { kind: "tip", text: "In the trial, the output is simulated; nothing leaves the switch." },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ Repush requests
  {
    id: "repush",
    pageKey: "repush",
    title: "Repush requests",
    group: "Monitoring",
    summary: "A log of EDRs re-sent to another vendor trunk, with how many were delivered or failed.",
    keywords: ["repush", "resend", "re-send", "retry", "EDR repush"],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "Each time someone re-sends EDRs from [[edr-search|EDR search]] or [[failed-edr|Failed EDRs]], a repush request is recorded here: which vendor trunk was used, how many EDRs were re-sent, the outcome, and who did it.",
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
              { name: "Info ID", what: "The repush request number." },
              { name: "Total EDR Count", what: "How many EDRs were re-sent." },
              { name: "Vendor Trunk", what: "The vendor trunk they were sent to." },
              { name: "Status", what: "Pending or Done (green)." },
              { name: "Delivered", what: "How many of the new attempts were delivered." },
              { name: "Failed", what: "How many were not delivered (red when above 0)." },
              { name: "Created By / Created Time", what: "Who made the request and when." },
            ],
          },
          {
            kind: "text",
            text: "Hidden column: **Skipped** (selected EDRs that were not re-sent because they were delivered already or not the final attempt). The detail panel shows the vendor trunk, the counts and who created it, with a **New attempts in EDR Search** button that opens EDR search filtered to this request's new attempts.",
          },
        ],
      },
      {
        id: "how-it-works",
        title: "How a repush works",
        blocks: [
          {
            kind: "list",
            items: [
              "Only final attempts that were not delivered are re-sent; the rest are counted as skipped.",
              "Each re-sent EDR becomes a new attempt (attempt number + 1) on the chosen vendor trunk, with the repush request ID. The old attempt is no longer the final one.",
              "Find the new attempts in EDR search with the **Repush Request ID** column, or use the button in the detail panel.",
            ],
          },
          { kind: "tip", text: "In the trial, re-sent messages are simulated: about 8 in 10 come back delivered." },
        ],
      },
    ],
  },
];
