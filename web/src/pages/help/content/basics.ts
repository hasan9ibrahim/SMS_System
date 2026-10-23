// Help center: getting started, the window layout and the live pages (§3, §4, §13.3–13.6, §13.10, §13.17,
// §13.25, §13.29, §13.30, §15).
import type { HelpTopic } from "../helpTypes";

export const topics: HelpTopic[] = [
  // ------------------------------------------------------------------ getting started
  {
    id: "getting-started",
    title: "Getting started",
    group: "Getting started",
    summary: "What the platform is, what each main menu is for, a first tour, and how the trial on fake data works.",
    keywords: ["introduction", "overview", "first steps", "tour", "trial", "demo", "menu", "view as user", "welcome"],
    sections: [
      {
        id: "what-it-is",
        title: "What the platform is",
        blocks: [
          {
            kind: "text",
            text: "This is our SMS aggregation platform. Customers send us messages over SMPP (the standard protocol between SMS systems) or HTTP. The platform picks a vendor for each message by rules, price and quality, sends it on, and then rates, bills and reports every attempt.",
          },
          {
            kind: "text",
            text: "Everything the team needs lives here: partners (we call them **enterprises**) and their connections (**trunks**), rates, routing, billing, monitoring and reports. Words you may not know are explained in the [[glossary]].",
          },
          {
            kind: "list",
            title: "Who uses what",
            items: [
              "**NOC engineers** — trunks, binds, routing, translation and HLR rules, the live dashboard, alerts and troubleshooting.",
              "**Rates team** — rate tables, vendor rate notifications, LCR (least-cost routing) and rate lookup.",
              "**Billing / finance** — transactions, invoices, SOA (statements of account), balances and vendor invoices.",
              "**Account managers (AM)** — their enterprises, reports, market moves and traffic alerts.",
              "**Administrators** — users, access groups, visibility policies, security and the change history.",
            ],
          },
        ],
      },
      {
        id: "menus",
        title: "The main menu and what each area is for",
        blocks: [
          {
            kind: "text",
            text: "The header is one top bar: the logo, then the main menu (the current section is underlined), then search and live status on the right. A menu with several pages opens a drop-down; a menu with one page opens it straight away. Pages marked **step …** or **later** in a drop-down are not finished yet and show a short placeholder.",
          },
          {
            kind: "list",
            items: [
              "**Dashboard** — the live NOC view of today's traffic: volume, money, who started or stopped sending, TPS (messages per second) and top lists. See [[dashboard]].",
              "**Live** — **Live analytics**: the traffic report that refreshes by itself while the period includes today. See [[live-analytics]].",
              "**Enterprises** — partners (customers, vendors or both) with their general info, docs, billing, account managers, and their customer and vendor trunks.",
              "**Finance** — transactions and payments, customer and vendor invoices, SOA, balances, the charges calculator, currencies and billing cycles.",
              "**Rates** — the Rate manager with every rate table, incoming vendor rate notifications (RNs), market moves, bulk rating, re-rating, rate lookup, product categories, countries, MCCMNC codes and the master table of dial codes.",
              "**Routing** — route rules, the route map, LCR and the route simulator.",
              "**Switch** — translation rules, number lists, HLR (number lookup), QBR stats, notifications, SMS to voice, traffic alerts and other switch tools.",
              "**Monitoring** — alert rules and incidents, EDR search and downloads, network status, signaling traces, failed EDRs, network diagnosis and repush requests.",
              "**Reports** — the Master report and the department reports (enterprise, sales, billing, NOC, team), scheduled reports and daily traffic e-mails.",
              "**Admin** — change history, users, access groups, visibility policies, departments, business companies, logged-in users, audit trail, e-mail templates, security, cleanup, migration and the customer portal.",
              "**Help** — this help center.",
            ],
          },
          {
            kind: "text",
            text: "After the menu: **Search or jump to…** ([[search-jump]], **Ctrl K**; on a laptop-sized screen only its magnifier icon shows, so the menu up to **Help** always fits); on the right the live **TPS** pill (click it to open the Dashboard), the server clock, the alert bell ([[alerts-and-popups]]) and your avatar with your personal settings.",
          },
        ],
      },
      {
        id: "first-tour",
        title: "A suggested first tour",
        blocks: [
          {
            kind: "steps",
            items: [
              "Start on the **Home** tab. It lists the daily screens and a few tips. Read [[layout]] once so you know the parts of every page.",
              "Open **Enterprises**. Type the start of a name in the filter box under **Full Legal Name** and watch the list narrow. Click a row to see its details on the right of the grid, double-click it to open the full record. See [[grids-and-filters]].",
              "Open **Rates › Rate manager** and pick a rate table. This is where customer and vendor prices live.",
              "Open **Routing › Route rules**. Click a rule and look at its **Conditions**, **Vendors**, **Traffic** and **History** in the detail panel.",
              "Open **Routing › Rate lookup** and type a country or network to see vendor costs and client rates side by side.",
              "Open **Reports › Enterprise report**, then **Dashboard** to see today's traffic move live.",
              "Press **Ctrl K** and type the name of any page or record to jump to it. Ctrl-click a few links to open them in new tabs, and try dragging a tab out of the window ([[tabs]]).",
              "Make a small change somewhere, then press **Ctrl Z** or use **Undo** to take it back ([[undo-and-history]]).",
            ],
          },
        ],
      },
      {
        id: "trial",
        title: "How the trial works",
        blocks: [
          {
            kind: "text",
            text: "During the trial the platform runs on **fake data only**. The enterprises, trunks, people, rates, invoices and traffic are generated: names are made up, IP addresses and passwords are fake, and no message is really sent. The amounts of data are realistic (thousands of destinations, hundreds of trunks, millions of EDRs), so you can judge whether the screens are fast enough.",
          },
          {
            kind: "text",
            text: "Live figures (the dashboard, TPS, alerts) come from a traffic simulator that behaves like a real switch. Nothing you do here touches the platform we use today.",
          },
          {
            kind: "text",
            text: "There is no sign-in screen yet. Everyone in the trial works as the **same demo administrator user**, so you can see every page and button. Because the user is shared, the theme, open tabs, saved views, alert sounds, dashboard settings and **My changes** are shared too: if a colleague switches to the dark theme, you may see it as well.",
          },
          {
            kind: "tip",
            text: "Something missing, wrong or slow? Tell the team. Every requested change is collected and fed into the next build.",
          },
        ],
      },
      {
        id: "view-as",
        title: "View as user",
        blocks: [
          {
            kind: "text",
            text: "Administrators can preview the system as another user sees it. This is how you check what an account manager with a visibility policy sees (see [[am-visibility]]).",
          },
          {
            kind: "steps",
            items: [
              "Click your avatar at the top right and choose **View as user…**.",
              "In **User**, type part of a name or username and pick the person. Account managers are marked as such.",
              "Click **Preview**. A strip under the tabs says **Previewing as …** and shows which policy applies.",
              "Browse as usual. Lists, records, search and exports now answer as that user sees them.",
              "Click **End preview** in the strip to go back to your own view.",
            ],
          },
          {
            kind: "warning",
            text: "Your own rights do not change while you preview, but saves to records that are masked for that user are refused. Live feeds (dashboard, TPS, alerts) are not filtered by the preview.",
          },
        ],
      },
      {
        id: "personal-settings",
        title: "Your personal settings",
        blocks: [
          {
            kind: "fields",
            title: "Avatar menu (top right)",
            fields: [
              { name: "Dark theme / Light theme", what: "Switches the colour theme. See [[themes]]." },
              {
                name: "Open pages in the current tab / Open pages in a new tab",
                what: "Chooses where menu items and links open by default. Ctrl-click or middle-click always opens a new tab.",
                values: "Default: new tab.",
              },
              {
                name: "Turn animations off / on",
                what: "Turns the live animations on the dashboard (counters rolling, bars growing, rows sliding) off or on.",
              },
              {
                name: "My changes",
                what: "Opens the Change history filtered to your own changes. See [[undo-and-history]].",
              },
              {
                name: "View as user…",
                what: "Administrators only: preview the system as another user. See above.",
              },
              {
                name: "Change password",
                what: "Change your password. It asks for your current password and a 2FA code, and shows the rules for the new password.",
              },
              {
                name: "Alert sounds",
                what: "Mute alert sounds or pick a sound per severity. See [[alerts-and-popups]].",
              },
              { name: "Sign out", what: "Not available yet in the trial." },
            ],
          },
          {
            kind: "text",
            text: "Passwords must be changed regularly. From a few days before yours expires, a strip under the tabs says **Your password expires …** with **Change now** and **Later**. If the password has expired, is temporary or an administrator asked you to change it, only the **Change your password** screen is shown until you choose a new one.",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ layout
  {
    id: "layout",
    title: "The window layout",
    group: "Getting started",
    summary:
      "Every page uses the same layout: top bar, tab strip, page header, filter card with quick search, grid, detail panel and status bar.",
    keywords: [
      "screen",
      "layout",
      "header",
      "status bar",
      "detail panel",
      "toolbar",
      "menu bar",
      "back button",
      "action bar",
      "clone",
      "delete",
      "more",
    ],
    sections: [
      {
        id: "overview",
        title: "One layout on every page",
        blocks: [
          {
            kind: "text",
            text: "Once you know one page you know them all. From top to bottom every window has the same parts, described below.",
          },
        ],
      },
      {
        id: "top-bar",
        title: "Top bar",
        blocks: [
          {
            kind: "list",
            title: "One bar, from left to right",
            items: [
              "**SMS Platform** logo — opens the Home tab.",
              "**Main menu** — Dashboard, Live, Enterprises, Finance, Rates, Routing, Switch, Monitoring, Reports, Admin and Help. The menu of the page you are on is underlined. See [[getting-started#menus]].",
              "**Search or jump to…** — after the menu; finds pages and records. Shortcut **Ctrl K**. See [[search-jump]].",
              "**TPS pill** (on the right, with the clock) — the total messages per second right now across the platform. Its dot is grey and it reads **— TPS** when the live feed is not connected. Click it to open the Dashboard.",
              "**Bell** — the number of open incidents and a list of the latest ones. See [[alerts-and-popups]].",
              "**Avatar** — your initials; opens your personal settings. See [[getting-started#personal-settings]].",
            ],
          },
        ],
      },
      {
        id: "tab-strip",
        title: "Tab strip",
        blocks: [
          {
            kind: "text",
            text: "Each open page is a tab, like in a web browser: icon, title and a close ✕. The **Home** tab is always first and cannot be closed. A red dot on a tab means an open incident concerns the data it shows; a small dot means the tab has unsaved changes. On the right: **Split view** and the list of open tabs. Everything about tabs is in [[tabs]].",
          },
        ],
      },
      {
        id: "page-header",
        title: "Page header",
        blocks: [
          {
            kind: "list",
            items: [
              "**Back arrow** — goes back to the page you had open before in this tab, or, if there is none, to the tab this one was opened from. Shortcut **Alt+←**. It is greyed out when there is nowhere to go back to.",
              "**Page title** — on record pages it can be a picker to switch to another record. There is no description line under the title.",
              "**Sibling links** — the other pages of the same menu as small links; the current one is highlighted. Ctrl-click or middle-click opens one in a new tab.",
              "**Actions** on the right (small buttons) — usually **Undo**, **History**, **Export** and the page's main action. The main action (for example **Add rule**) is the only filled, coloured button on the page.",
            ],
          },
        ],
      },
      {
        id: "action-bar",
        title: "Record action bar (next to New)",
        blocks: [
          {
            kind: "text",
            text: "On list pages a small group of buttons sits right after the page's **New** button. It acts on the row you selected: **Clone**, **Delete** (or **Restore** for an archived row) and the page's main record action, such as **Edit**. Every other action for that record is under **More ▾**.",
          },
          {
            kind: "list",
            items: [
              "The buttons are **greyed** until you click or tick one row. A greyed action that does not apply to the selected row shows why when you hover it (for example a wrong status or a missing permission).",
              "With several rows ticked the bar is greyed too; use the bulk actions bar for several rows.",
              "There is no Open button: **double-click** a row (or press **Enter**) to open it.",
              "On narrow screens the buttons show only their icons; hover one to see its name.",
            ],
          },
        ],
      },
      {
        id: "filter-row",
        title: "Filter card",
        blocks: [
          {
            kind: "text",
            text: "Under the header, list pages show a filter card: the quick search box (with a pill for every column filter), the page's own controls, **Show deleted** where the list has archived records and **Clear all**; on the right **Save as view**, **Views**, the selection summary and **Columns**. The grid follows straight after; its footer gives the row count, for example **Showing 400 of 12,480 records · scroll for more**. See [[grids-and-filters]].",
          },
        ],
      },
      {
        id: "grid",
        title: "Data grid",
        blocks: [
          {
            kind: "text",
            text: "The list itself: column headers, then a row of filter boxes (one under every column), then the rows. The headers have a light blue tint in the light theme. The first column is a checkbox for selection. Numbers are right-aligned. Status is a small coloured dot. Deleted (archived) rows are greyed out. The row you clicked is tinted. See [[grids-and-filters]].",
          },
        ],
      },
      {
        id: "detail-panel",
        title: "Detail panel",
        blocks: [
          {
            kind: "text",
            text: "Click a row and its details open on the right of the grid. The grid narrows; the panel does not cover it. The panel shows its title with ✕, its sections as tabs across the top (for example Conditions, Vendors, Traffic, History), then the chosen section, then the facts (ID, created…) at the bottom. The section you chose stays open while you move from row to row. Close it with ✕.",
          },
          {
            kind: "tip",
            text: "Drag the bar on the left edge of the detail panel to make it wider or narrower. Double-click the bar to switch between wide and the default width. The width is remembered per list.",
          },
        ],
      },
      {
        id: "status-bar",
        title: "Status bar",
        blocks: [
          {
            kind: "list",
            items: [
              "**Left** — row counts, for example `12,480 rows · 400 loaded · 3 selected`. A `+` after the number means the total is an estimate.",
              "**Middle** — the keyboard shortcuts of the page.",
              "**Right** — **Live** (or **Live offline** in amber when the live feed is not connected), **Autosave on**, and **Server UTC** with the server's time. All times in the platform are UTC unless a page says otherwise. **Server not reachable** in amber means the screens cannot reach the server.",
            ],
          },
        ],
      },
      {
        id: "colours",
        title: "What the colours mean",
        blocks: [
          {
            kind: "text",
            text: "Colour is only used when it means something: **green** is good, **amber** is a warning, **red** is a problem (for example a loss, a low ASR or a blocked item). The accent colour (blue) marks buttons, the selected tab and filters in use. Everything else is neutral.",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ tabs
  {
    id: "tabs",
    title: "Tabs, windows and split view",
    group: "Getting started",
    summary:
      "Open several pages as tabs, drag a tab out into its own window, show two tabs side by side, and get your tabs back next time.",
    keywords: ["tab", "window", "pop out", "second monitor", "split", "side by side", "pin", "duplicate", "dock"],
    sections: [
      {
        id: "open",
        title: "Opening pages in tabs",
        blocks: [
          {
            kind: "list",
            items: [
              "A menu item or link opens in a new tab or in the current tab, depending on your setting in the avatar menu (**Open pages in a new tab** / **in the current tab**). The default is a new tab.",
              "If the page is already open in a tab, that tab is brought to the front instead of opening a second copy. A plain menu link keeps the filters you set on that tab.",
              "**Ctrl-click** (Cmd-click on a Mac) or **middle-click** always opens a new tab. Middle-click on a menu item opens the tab in the background, without switching to it.",
              "**+** at the end of the tabs opens **Search or jump to…**; what you pick there opens in a new tab.",
              "The Home tab is pinned: a link clicked on Home always opens a new tab.",
            ],
          },
        ],
      },
      {
        id: "manage",
        title: "Closing, reordering and pinning",
        blocks: [
          {
            kind: "list",
            items: [
              "Close a tab with its ✕, or **middle-click** it.",
              "Drag a tab left or right to reorder it. Pinned tabs always stay on the left, after Home.",
              "**Right-click** a tab for its menu: **Pin** / **Unpin**, **Duplicate** (a second copy of the same page), **Open in new window**, **Close** and **Close other tabs**. On Home only **Close other tabs** is offered.",
              "A pinned tab has no ✕; unpin it to close it.",
              "Closing a tab with unsaved changes asks first: **Close tab with unsaved changes?**",
              "**N tabs** at the right of the strip lists every open tab; pick one to jump to it.",
            ],
          },
        ],
      },
      {
        id: "own-state",
        title: "Each tab keeps its own state",
        blocks: [
          {
            kind: "text",
            text: "Filters, sort, columns and the chosen view are kept per tab and are part of the tab's address. The browser's address bar shows the active tab's page, so you can copy it and send it to a colleague: it opens the same page with the same filters.",
          },
        ],
      },
      {
        id: "pop-out",
        title: "Drag a tab out into its own window",
        blocks: [
          {
            kind: "steps",
            items: [
              "Drag a tab and drop it outside the browser window (for example on a second monitor). It opens in its own window and leaves the tab strip. You can also right-click the tab and choose **Open in new window**.",
              "The new window shows the page without the tab strip. Theme and live data come from the main window, so both stay in step.",
              "Links you open from that window open as tabs in the main window.",
              "To bring it back, drag the title at the top left of the window onto the main window's tab strip, or click **Dock back**. The window closes and the tab returns.",
            ],
          },
          {
            kind: "tip",
            text: "If nothing happens when you drag a tab out, your browser may be blocking pop-up windows for this site. Allow pop-ups and try again.",
          },
        ],
      },
      {
        id: "split",
        title: "Split view: two tabs side by side",
        blocks: [
          {
            kind: "steps",
            items: [
              "Click **Split view** at the right of the tab strip (you need at least two tabs). The active tab shows on the left and another tab on the right.",
              "Use the arrow next to **Split view** to choose the right-hand tab.",
              "Each side has a small bar with a drop-down to pick its tab. The side marked **Tabs you click open here** is the focused one: clicking a tab in the strip shows it on that side.",
              "The ⇄ button on the left bar swaps the sides. ✕ on the right bar closes split view.",
              "Drag the bar between the two sides to give one more room. Double-click it to go back to half and half; with the bar focused, ← and → move it. The size is remembered in this browser.",
            ],
          },
        ],
      },
      {
        id: "remembered",
        title: "Your tabs are remembered",
        blocks: [
          {
            kind: "text",
            text: "The set of open tabs, their order, pins and the active tab are saved to your profile and come back the next time you open the platform (up to 50 tabs). Opening a link from outside (for example from an e-mail) adds it as a new tab next to the ones you had.",
          },
          {
            kind: "tip",
            text: "In the trial everyone shares one demo user, so a colleague's tabs can show up in your workspace after a reload.",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ grids and filters
  {
    id: "grids-and-filters",
    title: "Lists, column filters and sorting",
    group: "Getting started",
    summary:
      "How every list works: filters under each column, wildcards, numbers and dates, sorting, scrolling through millions of rows, columns, selection, export and saved views.",
    keywords: [
      "grid",
      "list",
      "table",
      "filter",
      "search",
      "wildcard",
      "regex",
      "sort",
      "columns",
      "export",
      "csv",
      "views",
      "select all",
      "paging",
    ],
    sections: [
      {
        id: "server",
        title: "All filtering happens on the server",
        blocks: [
          {
            kind: "text",
            text: "Lists can hold millions of rows, so filtering, sorting and searching always run on the server. You never page through results: every matching row is on one scrollable page. The first rows show at once, and more load in the background as you scroll down (you may briefly see **Loading more…** at the bottom).",
          },
          {
            kind: "text",
            text: "The footer under the grid shows the count, for example **Showing 400 of 12,480 records · scroll for more**. A new filter or sort scrolls back to the top.",
          },
        ],
      },
      {
        id: "column-filters",
        title: "Filter under each column",
        blocks: [
          {
            kind: "text",
            text: "Every column has a filter box under its header. Type and wait a moment: the list updates by itself. A filter in use turns blue. Press **Esc** in the box to clear it. If what you typed cannot be used on that column, the box turns red and its tooltip says why (for example `Use a number, e.g. >=5 or 5..10`).",
          },
          {
            kind: "text",
            text: "Columns with fixed values (status, type, yes/no) show a drop-down instead. Tick the values you want; **Select all** removes the filter. The button shows **All**, the single value, or for example **2 of 5**.",
          },
          {
            kind: "fields",
            title: "What you can type in a text column",
            fields: [
              {
                name: "au",
                what: "Contains `au` anywhere.",
                values: "Case does not matter: `AU`, `Au` and `au` give the same result.",
              },
              {
                name: "acme%",
                what: "Starts with `acme`. `%` stands for any text (also none).",
                values: "`%mobile` ends with mobile; `%tel%com%` contains tel and later com.",
              },
              { name: "a_c", what: "`_` stands for exactly one character.", values: "`a_c` matches abc, a1c, aXc." },
              { name: "=ACME", what: "Equals exactly (still not case-sensitive)." },
              { name: "!test", what: "Does not contain `test`." },
              {
                name: "/^ab[0-9]+$/",
                what: "A regular expression between slashes, for advanced patterns. Not case-sensitive.",
                values: "`/^(mtn|vodacom)/` starts with mtn or vodacom.",
              },
              { name: "empty / !empty", what: "The cell is empty / is not empty." },
            ],
          },
          {
            kind: "fields",
            title: "Prefix and MCCMNC columns",
            fields: [
              {
                name: "505",
                what: "Starts with `505` (the box says **starts with…**).",
                values: "Use `%` or `_` to write your own pattern, e.g. `%01`.",
              },
            ],
          },
          {
            kind: "fields",
            title: "Number columns (rates, counts, money, %)",
            fields: [
              { name: "5 or =5", what: "Equals 5." },
              { name: ">5  >=5  <5  <=5", what: "Greater / less than. `≥` and `≤` also work." },
              { name: "!=5", what: "Not equal to 5." },
              { name: "5..10", what: "Between 5 and 10, both included." },
              { name: "1,2,3", what: "Any of these values." },
              { name: "empty / !empty", what: "No value / has a value." },
            ],
          },
          {
            kind: "fields",
            title: "Date and time columns (UTC)",
            fields: [
              { name: "2026-10-01", what: "That whole day." },
              {
                name: "2026-10-01..2026-10-16",
                what: "From the first date to the second (the box says **from..to**).",
              },
              { name: ">=2026-10-01  <2026-10-01", what: "On or after / before a date." },
            ],
          },
        ],
      },
      {
        id: "chips",
        title: "Field pills and Clear all",
        blocks: [
          {
            kind: "text",
            text: "Every column filter shows as a pill in the quick search box, for example `Type = Customer, Vendor` or `Margin = <0`, and also under its column header. All pills apply together (AND). Click × on a pill to remove that filter, or press **Backspace** in the empty box to remove the last pill. Conditions from the filter builder show as one chip such as **All of 3 conditions**; click it to edit them. **Clear all** removes every filter and the quick search but keeps your sort and columns; a page with a default filter (e.g. EDR search's today) goes back to it.",
          },
        ],
      },
      {
        id: "quick-search",
        title: "Quick search",
        blocks: [
          {
            kind: "text",
            text: "Click the quick search box and a card opens listing the page's fields by category: **Text**, **Customer**, **Vendor**, **Choices**, **Numbers and money**, **Dates and times**. Only visible columns and filter-only fields are listed; show a hidden column with **Columns** to filter by it.",
          },
          {
            kind: "steps",
            title: "Filter by a field",
            items: [
              "Click the quick search box.",
              "Pick a field in the card. A pill such as **Status = …** appears in the box.",
              "Type the value with the same shorthand as the column filters: `%` any text, `_` one character, `=exact`, `!not`, `/regex/`, numbers `>5`, `5..10`, `1,2,3`, dates `2026-10-01..2026-10-16`. Choice fields open a checklist instead.",
              "Add more pills the same way. They all apply together (AND).",
            ],
          },
          {
            kind: "text",
            text: "Plain text typed in the box (outside a pill) is a normal quick search over the main text columns: press **Enter**, or click **Search all text columns for …** in the card. **Esc** clears it. On **Enterprises**, **Customer trunks**, **Vendor trunks** and **Users** plain text matches the start of a value (`Colo` finds names starting with Colo); type `%colo` to find it anywhere. Other lists match anywhere. On some lists (such as EDRs) you can type several items separated by commas; a long number then matches a sender or receiver exactly.",
          },
        ],
      },
      {
        id: "builder",
        title: "Filters on several fields at once",
        blocks: [
          {
            kind: "text",
            text: "**Any of (OR)…** in the quick search card opens the filter builder, where you combine as many conditions as you like with AND and OR, on any field of the list, including columns that are hidden. See [[filter-builder]].",
          },
        ],
      },
      {
        id: "sorting",
        title: "Sorting",
        blocks: [
          {
            kind: "list",
            items: [
              "Click a column header to sort by it: first ascending ▲, then descending ▼, then back to the default order.",
              "**Shift-click** another header to add it as a second sort (up to five). Small numbers next to the arrows show the order.",
              "Lists of countries and destinations are sorted by country name, then network name, unless you choose another column.",
            ],
          },
        ],
      },
      {
        id: "columns",
        title: "Choosing and resizing columns",
        blocks: [
          {
            kind: "list",
            items: [
              "**Columns** at the right of the filter card lists every field. Tick or untick to show or hide a column. Fields marked **hidden by default** are extra columns you can add. At least one column stays visible.",
              "**Default columns** in the same menu goes back to the standard set.",
              "Drag the right edge of a column header to make it wider or narrower.",
            ],
          },
        ],
      },
      {
        id: "selection",
        title: "Selecting rows and bulk actions",
        blocks: [
          {
            kind: "list",
            items: [
              "Click a row to make it the active row and show its details on the right. Double-click (or middle-click) a row to open the full record; **Ctrl-click** opens it in a new tab where the page supports it.",
              "Tick the checkbox at the start of a row to select it. **Shift**-tick selects every row between the last one you ticked and this one.",
              "The checkbox in the header selects all loaded rows. When more rows match, a line offers **Select all … matching**, which loads and selects every matching row, up to 5,000.",
              "The selection summary appears on the right of the filter card. With several rows ticked, the actions in the header (Delete, More…) act on all of them; an action without its own window asks first, naming how many rows.",
              "Changing a filter or the quick search clears the selection, so a bulk action never touches rows you can no longer see.",
            ],
          },
        ],
      },
      {
        id: "export",
        title: "Exporting",
        blocks: [
          {
            kind: "text",
            text: "**Export** in the page header downloads the rows that match the current filters (CSV), in the order shown. Masked names and hidden values stay masked in the file (see [[am-visibility]]). On pages where export is not ready yet the button is greyed out.",
          },
          {
            kind: "warning",
            text: "Exports that contain credentials (passwords, usernames) are for administrators only, need a 2FA code and produce an encrypted file.",
          },
        ],
      },
      {
        id: "views",
        title: "Saved views",
        blocks: [
          {
            kind: "text",
            text: "A view saves the current filters, quick search, sort and columns under a name, so you can come back to them in one click.",
          },
          {
            kind: "steps",
            title: "Save a view",
            items: [
              "Set the filters, sort and columns you want.",
              "Click **Save as view** in the filter card (or **Views › Save as new view…**).",
              "Type a **Name** (up to 100 characters).",
              "Optional: in **Share read-only with**, find colleagues by name or username and tick them. With nobody ticked the view is private.",
              "Click **Save view**.",
            ],
          },
          {
            kind: "list",
            title: "The Views menu",
            items: [
              "**My views** — your views; click one to apply it. The bin icon deletes it, for you and everyone you shared it with.",
              "**Shared with me (read-only)** — views colleagues shared with you, with the owner's name. You can apply them but not change them.",
              "**Save changes to …** — after changing filters on one of your own views, saves the changes into it.",
            ],
          },
        ],
      },
      {
        id: "deleted",
        title: "Show deleted",
        blocks: [
          {
            kind: "text",
            text: "Lists that have archived records offer **Show deleted**. Tick it to list deleted records next to the live ones, greyed out. See [[safe-delete]].",
          },
        ],
      },
      {
        id: "keys",
        title: "Keyboard in a grid",
        blocks: [
          {
            kind: "text",
            text: "Click a row first, then: **↑ ↓** move, **Page Up / Page Down** jump 15 rows, **Home / End** go to the first / last loaded row, **Space** ticks the row (**Shift+Space** a range), **Enter** opens it. Some pages add their own keys, shown in the status bar. All shortcuts: [[keyboard-shortcuts]].",
          },
        ],
      },
      {
        id: "masked-cells",
        title: "Cells you are not allowed to see",
        blocks: [
          {
            kind: "text",
            text: "If a visibility policy applies to you, some cells show **Hidden**, a band such as **Low / Normal / High**, or **Above limit** instead of the value. Hover to see why. See [[am-visibility]].",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ filter builder
  {
    id: "filter-builder",
    title: "The filter builder (AND / OR)",
    group: "Getting started",
    summary:
      "Combine as many conditions as you need on any field, with AND, OR and nested groups, with worked examples.",
    keywords: ["filter", "builder", "and", "or", "group", "advanced filter", "conditions", "query"],
    sections: [
      {
        id: "open",
        title: "Opening the builder",
        blocks: [
          {
            kind: "text",
            text: "Click the quick search box above any list and choose **Any of (OR)…** in the card. When the builder already has conditions, a chip such as **All of 3 conditions** shows them; click the chip to edit them. The builder's conditions are combined (AND) with the filters under the column headers.",
          },
        ],
      },
      {
        id: "parts",
        title: "What is in the builder",
        blocks: [
          {
            kind: "fields",
            title: "Group and condition rows",
            fields: [
              {
                name: "Match all (AND) / any (OR) of these",
                what: "How the rows of this group combine. **all (AND)**: a record must meet every condition. **any (OR)**: one is enough.",
                values: "Default: all (AND).",
              },
              {
                name: "Field",
                what: "Which field to test. Every field of the list is offered, also columns that are not shown; those are marked **(hidden column)**.",
              },
              {
                name: "Operator",
                what: "How to compare. The choice depends on the field type.",
                values:
                  "**equals**, **not equal**, **matches** (with `%` and `_`), **does not match**, **is one of**, **is not one of**, **between**, **>**, **≥**, **<**, **≤**, **is empty**, **is not empty**, **regex**.",
              },
              {
                name: "Value",
                what: "What to compare with. Text fields take text; number fields take numbers; date fields a date from the calendar and a 24-hour time typed as HH:MM (e.g. `0930` becomes 09:30; empty = 00:00, UTC); fixed-value fields a drop-down or tick boxes. **between** asks for **From** and **to**. **is one of** takes values separated by commas. **is empty** needs no value.",
                values:
                  "In **matches**: `re%` starts with re, `%re` ends with re, `%re%` contains re, `_` is one character.",
              },
              { name: "✕", what: "Removes that condition." },
              { name: "+ Condition", what: "Adds a condition row to this group." },
              {
                name: "+ Group",
                what: "Adds a group inside this one. A new group uses the opposite logic (an OR group inside an AND group, and the other way round). Groups can be nested three levels deep. The bin icon removes a group.",
              },
            ],
          },
          {
            kind: "fields",
            title: "Buttons",
            fields: [
              {
                name: "Apply",
                what: "Checks the conditions and applies them. Problems are listed in red (for example `Rate: enter a value`).",
              },
              { name: "Cancel", what: "Closes without changing anything." },
              { name: "Clear builder", what: "Removes all builder conditions. Column filters stay." },
            ],
          },
          {
            kind: "tip",
            text: "Text comparisons are never case-sensitive. A regex that is not valid is refused when you click **Apply**.",
          },
        ],
      },
      {
        id: "example-and",
        title: "Example 1: all of several conditions (AND)",
        blocks: [
          {
            kind: "text",
            text: "Goal: active customer trunks of enterprises whose name starts with Acme (a fake name) and with a TPS limit of at least 50.",
          },
          {
            kind: "steps",
            items: [
              "Open **Enterprises › Customer trunks** click the quick search box and choose **Any of (OR)…**.",
              "Leave **Match all (AND)**.",
              "First row: **Status** · **is one of** · tick **Active**.",
              "**+ Condition**: **Enterprise** · **matches** · `acme%`.",
              "**+ Condition**: **TPS** · **≥** · `50`.",
              "Click **Apply**. The chip reads **All of 3 conditions**.",
            ],
          },
        ],
      },
      {
        id: "example-or",
        title: "Example 2: any of several conditions (OR)",
        blocks: [
          {
            kind: "text",
            text: "Goal: route rules that send to the (fake) vendor Kite Direct **or** whose rule name contains OTP.",
          },
          {
            kind: "steps",
            items: [
              "Open **Routing › Route rules** click the quick search box and choose **Any of (OR)…**.",
              "Click **any (OR)**.",
              "First row: **Vendors** · **matches** · `%kite direct%`.",
              "**+ Condition**: **Rule** · **matches** · `%otp%`.",
              "Click **Apply**. The chip reads **Any of 2 conditions**.",
            ],
          },
        ],
      },
      {
        id: "example-nested",
        title: "Example 3: AND with an OR group inside",
        blocks: [
          {
            kind: "text",
            text: "Goal: route rules for France that have a problem: an ASR below 60 % **or** a negative margin.",
          },
          {
            kind: "steps",
            items: [
              "Open **Routing › Route rules**, click the quick search box, choose **Any of (OR)…** and leave **Match all (AND)**.",
              "First row: **Destination** · **matches** · `%france%`.",
              "Click **+ Group**. A new box appears that matches **any (OR)**.",
              "In the new group's first row: **ASR** · **<** · `60`.",
              "In the same group click **+ Condition**: **Margin** · **<** · `0`.",
              "Click **Apply**. Rules must be for France AND (have an ASR below 60 OR a negative margin).",
            ],
          },
          {
            kind: "tip",
            text: "Field names differ per list. Use the **Field** drop-down to see what each list offers. Save a useful combination as a view so you do not have to build it again ([[grids-and-filters#views]]).",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ undo and history
  {
    id: "undo-and-history",
    title: "Undo and change history",
    group: "Getting started",
    summary:
      "Every save is one change. Undo your own change at once or later, see each record's History, and find every change in Change history.",
    keywords: ["undo", "redo", "history", "audit", "change log", "my changes", "revert", "ctrl z"],
    sections: [
      {
        id: "one-change",
        title: "Each save is one change",
        blocks: [
          {
            kind: "text",
            text: "Every time you save a rule, rate, trunk or other record, the platform records one **change** with a number, who made it, when (UTC), the type (create, edit, delete, bulk and so on), and a field-by-field list of what changed from what to what. A bulk action on 24 rules is one change too, and is undone as one.",
          },
        ],
      },
      {
        id: "quick-undo",
        title: "Undo right after saving",
        blocks: [
          {
            kind: "list",
            items: [
              "After a save, a message such as **Saved · change #4521** appears for 10 seconds with an **Undo** button.",
              "**Ctrl+Z** (Cmd+Z on a Mac) on the page undoes your last change on that page. It does nothing while you are typing in a field.",
              "**Undo** in the page header does the same as Ctrl+Z. If there is nothing of yours to undo there, it says **Nothing of yours to undo here.**",
              "Every undo first asks **Undo this change?** with a summary of what will be put back; click **Undo** to confirm or Cancel to keep it.",
              "After an undo, the message offers **Redo** for 10 seconds.",
            ],
          },
        ],
      },
      {
        id: "history",
        title: "History of a record or page",
        blocks: [
          {
            kind: "text",
            text: "Records have a **History** tab or section, and list pages that edit records have a **History** button in the header. Both show the changes newest first: number, type, who, when, and what changed (for example `priority 12 → 10`). Undone changes are struck through and say **undone by #…**. Click **Load older changes** to go further back.",
          },
          {
            kind: "steps",
            title: "Undo an older change",
            items: [
              "Open the record's **History** (or the page's **History** button, or **My changes** in the avatar menu).",
              "Find the change and click **Undo** next to it.",
              "Only the fields that change touched are restored. Later edits by others to other fields are kept.",
            ],
          },
        ],
      },
      {
        id: "conflict",
        title: "When someone changed the same field since",
        blocks: [
          {
            kind: "text",
            text: "If a colleague has changed the same field after you, undo stops and shows **Someone changed the same field since**, with both values (for example you set 60%, a colleague later set 70%). Choose:",
          },
          {
            kind: "list",
            items: [
              "**Restore mine** — put your earlier values back everywhere.",
              "**Keep current** — undo only the fields nobody changed since.",
              "**Cancel** — do nothing.",
            ],
          },
        ],
      },
      {
        id: "rules",
        title: "Rules the system applies",
        blocks: [
          {
            kind: "list",
            items: [
              "You can undo your own changes. Users whose access group has **Undo others' changes** (and administrators) can undo anyone's.",
              "An undo is itself a change with its own number, so it can be undone again and the trail stays complete.",
              "Undoing a delete brings the record back with its original ID and settings.",
              "An undo takes effect straight away, like a normal save; routing uses the restored rule at once.",
            ],
          },
        ],
      },
      {
        id: "change-history-page",
        title: "The Change history page",
        blocks: [
          {
            kind: "text",
            text: "**Admin › Change history** lists every change in the system, with the same filters as any list, and **Undo** per change. **My changes** (avatar menu) is the same page filtered to you. See [[change-history]].",
          },
          {
            kind: "tip",
            text: "In the trial everyone works as the same demo user, so **My changes** shows everybody's trial changes.",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ safe delete
  {
    id: "safe-delete",
    title: "Safe delete and restore",
    group: "Getting started",
    summary:
      "Delete archives a record instead of removing it, shows what depends on it, is blocked while billing items are open, and can be restored.",
    keywords: ["delete", "archive", "remove", "restore", "dependencies", "blocked", "override", "show deleted"],
    sections: [
      {
        id: "archive",
        title: "Delete means archive",
        blocks: [
          {
            kind: "text",
            text: "Deleting a trunk, enterprise, rate table, rule, user or any other record never removes data. The record is marked deleted with who and when. It leaves normal lists, pickers and routing at once and stops carrying traffic, but it stays in reports, invoices and history. Past reports keep showing it under its real name, so totals never change after a delete.",
          },
        ],
      },
      {
        id: "dialog",
        title: "The delete window",
        blocks: [
          {
            kind: "text",
            text: "Clicking **Delete** opens **Delete …?**. It first checks what depends on the record (**Checking what depends on it…**) and lists each item with a count, for example live binds, route rules and rate tables using it, open invoices, unpaid balance, open disputes and traffic in the last 30 days. Items with a green tick are fine; items in red with a warning sign block the delete.",
          },
          {
            kind: "fields",
            fields: [
              {
                name: "Reason",
                what: "Why you delete it. Saved with the change.",
                values: "Optional, up to 500 characters; required when you override.",
              },
              {
                name: "Override the blockers",
                what: "Administrators only, shown when something blocks the delete. Lets you delete anyway. Not offered for live trunks of an enterprise or for live trunks / enterprises using a translation or HLR rule.",
                values: "Needs a written **Reason**, which is logged.",
              },
              {
                name: "Delete / Override and delete",
                what: "Archives the record. The button is greyed out while blockers remain (unless overridden).",
              },
              { name: "Cancel", what: "Closes without deleting." },
            ],
          },
        ],
      },
      {
        id: "blocked",
        title: "When delete is blocked",
        blocks: [
          {
            kind: "text",
            text: "A trunk or enterprise with a non-zero balance, an unpaid or draft invoice, an open dispute or live binds cannot be deleted. The window says **Settle the red items first**. Settle them (for example record the payment or close the dispute) and try again, or ask an administrator to override.",
          },
          {
            kind: "list",
            title: "Blockers that cannot be overridden",
            items: [
              "An enterprise that still has any customer or vendor trunk that is not deleted cannot be deleted or archived, not even with an administrator override. Delete its trunks first.",
              "A translation rule or HLR rule assigned to a live trunk or enterprise cannot be deleted, not even with an override. Remove it from those trunks / enterprises first. Rules that run on all trunks or on a category do not block; they just stop running there.",
              "The delete window shows these items in red and offers no override for them.",
            ],
          },
        ],
      },
      {
        id: "bulk",
        title: "Deleting several records",
        blocks: [
          {
            kind: "text",
            text: "On lists that allow it, select rows and use the header's **Delete**. The window checks each record and shows **can be deleted** or **blocked: …**. Blocked records are skipped unless an administrator ticks **Override the blockers** and gives a reason. **Delete N** deletes the rest. Each delete is its own change, so each can be undone from History.",
          },
        ],
      },
      {
        id: "restore",
        title: "Finding and restoring a deleted record",
        blocks: [
          {
            kind: "steps",
            items: [
              "Tick **Show deleted** in the list's filter card. Deleted records appear greyed out.",
              "Open the record. A banner says **This … is deleted** with when and by whom; editing is off.",
              "Administrators click **Restore** in the banner. Others see **An administrator can restore it.**",
              "Right after a delete you can also click **Undo** in the message, or undo the change from History ([[undo-and-history]]).",
            ],
          },
          {
            kind: "tip",
            text: "An enterprise can only be deleted once all its customer and vendor trunks are deleted. Nothing is ever hard-deleted.",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ search / jump
  {
    id: "search-jump",
    title: "Search or jump to (Ctrl K)",
    group: "Getting started",
    summary:
      "Press Ctrl K anywhere to find a page or a record (enterprise, trunk, rate table, route rule or user) and open it.",
    keywords: ["search", "jump", "ctrl k", "command palette", "find", "go to", "quick open"],
    sections: [
      {
        id: "open",
        title: "Opening it",
        blocks: [
          {
            kind: "text",
            text: "Press **Ctrl K** (Cmd K on a Mac) on any page, click **Search or jump to…** in the top bar, or click **+** in the tab strip. Press **Ctrl K** again or **Esc** to close it.",
          },
        ],
      },
      {
        id: "what",
        title: "What it finds",
        blocks: [
          {
            kind: "list",
            items: [
              "**Pages** — every page of the menu, by its name, menu or description. Type several words to narrow down, for example `rate table` or `invoice vendor`. With nothing typed it lists a few pages to start from.",
              "**Records** — enterprises, customer trunks, vendor trunks, rate tables, route rules and users, by name or ID. Results appear as you type.",
            ],
          },
          {
            kind: "text",
            text: "A record opens on its own page: an enterprise or trunk opens its record, a rate table opens in the Rate manager, a route rule opens Route rules with that rule selected, a user opens Users.",
          },
        ],
      },
      {
        id: "keys",
        title: "Moving and opening",
        blocks: [
          {
            kind: "list",
            items: [
              "**↑ ↓** move through the results.",
              "**Enter** opens the highlighted result.",
              "**Ctrl+Enter** or **Ctrl-click** opens it in a new tab.",
              "**Esc** closes the window.",
            ],
          },
          {
            kind: "tip",
            text: "If a visibility policy applies to you, other account managers' enterprises are found only by their masked ID (for example `Customer #12`), not by name.",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ themes
  {
    id: "themes",
    title: "Light and dark theme",
    group: "Getting started",
    summary: "Switch between the light and the dark theme; the choice is saved to your profile.",
    keywords: ["theme", "dark mode", "light mode", "colours", "night"],
    sections: [
      {
        id: "switch",
        title: "Switching the theme",
        blocks: [
          {
            kind: "steps",
            items: [
              "Click your avatar (your initials) at the top right.",
              "Choose **Dark theme** (or **Light theme** when dark is on).",
            ],
          },
          {
            kind: "text",
            text: "The whole window changes at once, including windows you dragged out. The choice is saved to your profile and comes back next time.",
          },
          {
            kind: "text",
            text: "Both themes use soft colours for long shifts (no pure white or black). Green, amber and red mean the same in both.",
          },
          {
            kind: "tip",
            text: "In the trial everyone shares one demo user, so the theme is shared too: if it changes by itself after a reload, a colleague switched it.",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ AM visibility
  {
    id: "am-visibility",
    title: "Account manager visibility",
    group: "Getting started",
    summary:
      "What masking and hiding mean when a visibility policy applies to you, and why past results stay with the account manager who earned them.",
    keywords: [
      "visibility",
      "masking",
      "hidden",
      "AM",
      "account manager",
      "policy",
      "privacy",
      "attribution",
      "handover",
    ],
    sections: [
      {
        id: "what",
        title: "What visibility mode is",
        blocks: [
          {
            kind: "text",
            text: "An administrator can switch on a visibility policy for all account managers (AMs), a department or chosen users. With a policy you see the names of **your own** clients and vendors (those where you are the AM, and optionally your team's or ones shared with you). Everyone else's appear as neutral IDs, and some figures can be hidden.",
          },
        ],
      },
      {
        id: "masking",
        title: "Masked names",
        blocks: [
          {
            kind: "list",
            items: [
              "Other AMs' enterprises and trunks show as IDs such as `Customer #2481` or `Vendor trunk #1036`. The ID is the same everywhere, so you can still follow traffic (“vendor #1036 has low DLR”) without knowing who it is.",
              "Masked names cannot be searched for by name, are not shown in tooltips, and stay masked in exports, e-mails, scheduled reports and the API.",
              "You cannot save changes to a record that is masked for you.",
            ],
          },
        ],
      },
      {
        id: "hiding",
        title: "Hidden values",
        blocks: [
          {
            kind: "text",
            text: "A policy can hide items, separately for others' records and for your own: margin and margin %, revenue, cost and vendor buy rates, customer sell rates, balances and invoices, contact details and credentials, and traffic volumes. A hidden cell shows one of these instead of the value:",
          },
          {
            kind: "list",
            items: [
              "**Hidden** — you may not see this value.",
              "**Low / Normal / High** — margin shown only as a band.",
              "**Above limit** — revenue above the amount your policy allows.",
            ],
          },
          {
            kind: "text",
            text: "Masking is done on the server, so it applies to every page, export and report, not only to what is on screen. Your effective policy is shown on your user profile; administrators manage policies in **Admin › Visibility policies** ([[visibility]]) and can check what you see with **View as user** ([[getting-started#view-as]]).",
          },
          {
            kind: "tip",
            text: "Live feeds (dashboard, TPS, alerts) are not filtered by **View as user** in the trial.",
          },
        ],
      },
      {
        id: "attribution",
        title: "AM attribution at send time",
        blocks: [
          {
            kind: "text",
            text: "Every message record (EDR) stores the customer-side and vendor-side AM **at the moment the message was sent**. Reports read the AM from the message, not from the client's current setting.",
          },
          {
            kind: "list",
            items: [
              "When a client moves to another AM, revenue, cost, margin and volume before the handover stay with the previous AM. The new AM is credited from the handover time on.",
              "A client handed over mid-month shows two lines in AM reports, one per AM, each with its date range.",
              "Invoices and SOAs belong to the client, so they do not change with the AM.",
            ],
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ alerts
  {
    id: "alerts-and-popups",
    title: "Alerts, pop-ups and sounds",
    group: "Getting started",
    summary:
      "How incidents reach you: the bell, pop-up cards with Acknowledge and Snooze, sounds per severity, and red dots on tabs.",
    keywords: ["alert", "incident", "bell", "popup", "notification", "sound", "acknowledge", "snooze", "mute"],
    sections: [
      {
        id: "where",
        title: "Where alerts come from",
        blocks: [
          {
            kind: "text",
            text: "Alert rules (**Monitoring › Alert rules**, see [[alert-rules]]) watch traffic figures such as volume, TPS, ASR, DLR or margin. When a rule's condition is met, the server opens an **incident** and tells everyone the rule notifies, even if nobody has the dashboard open. Each incident has a severity: **Info**, **Warning** or **Critical**.",
          },
          {
            kind: "tip",
            text: "In the trial, incidents come from the traffic simulator, not from real traffic.",
          },
        ],
      },
      {
        id: "bell",
        title: "The bell",
        blocks: [
          {
            kind: "text",
            text: "The bell at the top right shows how many incidents are open (not yet recovered). The number is highlighted while there are incidents you have not looked at. Click the bell to see the latest incidents with their message, state (**Open**, **Acknowledged** or **Recovered**) and start time in UTC. A red dot means critical, amber a warning, green recovered. **All incidents** opens the Incidents page ([[incidents]]).",
          },
        ],
      },
      {
        id: "popups",
        title: "Pop-up cards",
        blocks: [
          {
            kind: "text",
            text: "A new incident (from a rule that uses pop-ups) shows as a card in the corner of whatever page you are on, at most three at a time. The card shows the severity (with **still on** when it repeats), the rule name, the time, what happened in plain words, and **Now** against **baseline** when there is one.",
          },
          {
            kind: "fields",
            title: "Buttons on a card",
            fields: [
              {
                name: "Acknowledge",
                what: "Tells everyone you are on it. Saved on the server, so all your tabs and colleagues see it, and a critical sound stops repeating.",
              },
              {
                name: "Open in Analytics",
                what: "Opens [[live-analytics]] in a new tab, broken down by what the incident is about.",
              },
              {
                name: "Snooze…",
                what: "Silences this incident for a while.",
                values: "**15 min**, **1 hour** or **Until tomorrow**.",
              },
              { name: "✕", what: "Hides the card without acknowledging." },
            ],
          },
          {
            kind: "text",
            text: "When the figure returns to normal, a short green message says **OK – … is back to normal**.",
          },
        ],
      },
      {
        id: "sounds",
        title: "Sounds",
        blocks: [
          {
            kind: "steps",
            items: [
              "Click your avatar and choose **Alert sounds**.",
              "Tick **Mute alert sounds for me** to silence all sounds for yourself, or pick a sound for **Info**, **Warning** and **Critical**: **No sound**, **Chime**, **Ping**, **Beep** or **Siren**. **Play** lets you hear it.",
              "Click **Save**.",
            ],
          },
          {
            kind: "text",
            text: "Defaults: Info **Ping**, Warning **Chime**, Critical **Siren**. A critical incident repeats its sound every 15 seconds until someone acknowledges it.",
          },
          {
            kind: "tip",
            text: "Browsers only play sound after you have clicked somewhere on the page once. If you hear nothing, click anywhere in the window.",
          },
        ],
      },
      {
        id: "tab-dots",
        title: "Red dots on tabs",
        blocks: [
          {
            kind: "text",
            text: "While incidents are open, tabs showing live traffic (Dashboard, Live analytics, Incidents) get a red dot so you notice them among your other tabs.",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ keyboard shortcuts
  {
    id: "keyboard-shortcuts",
    title: "Keyboard shortcuts",
    group: "Getting started",
    summary: "Every keyboard shortcut and mouse shortcut in the platform, in one place.",
    keywords: ["keyboard", "shortcut", "hotkey", "keys", "ctrl", "mouse", "middle click"],
    sections: [
      {
        id: "everywhere",
        title: "Anywhere",
        blocks: [
          {
            kind: "fields",
            fields: [
              { name: "Ctrl K (Cmd K)", what: "Open or close **Search or jump to…**. See [[search-jump]]." },
              { name: "Alt+←", what: "Back to the previous page in this tab, or to the tab it was opened from." },
              {
                name: "Ctrl+Z (Cmd+Z)",
                what: "Undo your last change on the page, on pages with an **Undo** button. Not while typing in a field.",
              },
              { name: "Esc", what: "Close the open dialog, menu or drop-down." },
            ],
          },
        ],
      },
      {
        id: "mouse",
        title: "Mouse",
        blocks: [
          {
            kind: "fields",
            fields: [
              { name: "Ctrl-click / Cmd-click a link", what: "Open it in a new tab." },
              {
                name: "Middle-click a link or menu item",
                what: "Open it in a new tab (from the menu: in the background).",
              },
              { name: "Middle-click a tab", what: "Close the tab." },
              {
                name: "Right-click a tab",
                what: "Tab menu: Pin, Duplicate, Open in new window, Close, Close other tabs.",
              },
              { name: "Drag a tab", what: "Reorder it; drop it outside the window to open it in its own window." },
              { name: "Click a column header", what: "Sort by it (ascending, descending, off)." },
              { name: "Shift-click a column header", what: "Add a second sort column (up to five)." },
              { name: "Double-click or middle-click a row", what: "Open the record." },
              { name: "Ctrl-click a row", what: "Open the record (in a new tab where the page supports it)." },
              { name: "Shift-tick a row checkbox", what: "Select every row between the last ticked one and this one." },
              {
                name: "Double-click the bar on the left edge of the detail panel",
                what: "Switch the panel between wide and default width.",
              },
            ],
          },
        ],
      },
      {
        id: "grid",
        title: "In a list (click a row first)",
        blocks: [
          {
            kind: "fields",
            fields: [
              { name: "↑ / ↓", what: "Previous / next row." },
              { name: "Page Up / Page Down", what: "15 rows up / down." },
              { name: "Home / End", what: "First / last loaded row." },
              { name: "Space", what: "Tick or untick the row. **Shift+Space** ticks a range." },
              { name: "Enter", what: "Open the row." },
              { name: "E (Route rules)", what: "Edit the active rule." },
              { name: "D (Route rules)", what: "Duplicate the active rule." },
            ],
          },
        ],
      },
      {
        id: "boxes",
        title: "In filter and search boxes",
        blocks: [
          {
            kind: "fields",
            fields: [
              { name: "Esc in a column filter", what: "Clear that filter." },
              {
                name: "Enter in the quick search box",
                what: "Search all text columns for what you typed. **Esc** clears it. **Backspace** in the empty box removes the last field pill.",
              },
              {
                name: "↑ / ↓ / Enter / Esc in Search or jump to",
                what: "Move, open, close. **Ctrl+Enter** opens in a new tab.",
              },
              {
                name: "↑ / ↓ / Enter in a record picker",
                what: "Move through the matches and pick one (for example the enterprise picker in a record header).",
              },
              {
                name: "↑ / ↓ / Enter / Esc in Rate lookup",
                what: "Pick a destination from the suggestions, or close them.",
              },
              { name: "Enter in Save as view", what: "Save the view." },
            ],
          },
        ],
      },
      {
        id: "editing",
        title: "While editing",
        blocks: [
          {
            kind: "fields",
            fields: [
              {
                name: "Enter / Esc in an inline cell edit",
                what: "Keep / cancel the edit (for example a sell rate in a rate table).",
              },
              {
                name: "Enter or comma in a list field",
                what: "Add the typed value as a chip. **Backspace** in an empty box removes the last chip.",
              },
              {
                name: "Enter in a dialog field",
                what: "Submit, on dialogs that support it (for example Route simulator and Network diagnosis: **Enter runs**).",
              },
            ],
          },
          {
            kind: "tip",
            text: "Each page lists its own shortcuts in the middle of the status bar at the bottom of the window.",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ glossary
  {
    id: "glossary",
    title: "Glossary",
    group: "Getting started",
    summary: "Words and abbreviations used in the platform, from A to Z.",
    keywords: ["glossary", "terms", "abbreviations", "definitions", "dictionary", "acronyms"],
    sections: [
      {
        id: "a-c",
        title: "A – C",
        blocks: [
          {
            kind: "list",
            items: [
              "**ADD (average delivery delay)** — average number of seconds between sending a message and receiving its delivery receipt.",
              "**AM (account manager)** — the salesperson responsible for a customer or vendor. See [[am-visibility]].",
              "**ASR (answer-seizure ratio)** — the share of attempts the platform accepted and sent on: successful ÷ attempts, in %.",
              "**Attempt** — one message received from a customer, whatever happened to it next.",
              "**Billable (C) / (V)** — messages billable to the customer / billable by the vendor.",
              "**Billing cycle** — how often a partner is invoiced and when payment is due, e.g. Monthly – Net 7.",
              "**Bind** — an SMPP login session between two systems. A trunk can have several binds (Max Connections).",
              "**Business company** — our own selling entity or brand; it owns enterprises, invoice formats and e-mail templates.",
              "**CDR (call detail record)** — the older name for a usage record; here we use EDR.",
              "**Credit limit** — how much a customer may owe before traffic is stopped or warned about.",
              "**Customer** — an enterprise that sends traffic to us and pays us.",
              "**Customer trunk** — a customer's connection to us: an SMPP system_id or HTTP user, with its IPs, TPS limit and rate tables.",
            ],
          },
        ],
      },
      {
        id: "d-h",
        title: "D – H",
        blocks: [
          {
            kind: "list",
            items: [
              "**Data coding** — how message text is encoded: 0 GSM 7-bit (default), 3 Latin-1, 8 UCS2 (Unicode, for non-Latin scripts) and others.",
              "**Destination** — a country and mobile network, identified by its MCCMNC.",
              "**Dial code / prefix** — the leading digits of a phone number (e.g. `33` for France, `3361` for a network) used to find the destination.",
              "**DLR (delivery report / receipt)** — the message that says whether an SMS was delivered (stat DELIVRD, UNDELIV, EXPIRED …). DLR % = delivered ÷ successful. **DLR (c)** is what we report to the customer, **DLR (v)** what the vendor reported.",
              "**DNID / receiver** — the destination phone number. **Sender ID** is the source address.",
              "**EDR (event data record)** — one row per message attempt with both legs (customer and vendor), the rate and cost at send time. Feeds reports, billing and re-rating.",
              "**Enterprise** — a partner company: customer, vendor or both (bilateral).",
              "**ESME / SMSC** — in SMPP, the client (ESME) and the server (SMSC). We are the SMSC toward customers and an ESME toward vendors.",
              "**HLR (home location register) lookup** — a query to find which network a number belongs to now, and whether it is ported or reachable.",
            ],
          },
        ],
      },
      {
        id: "i-m",
        title: "I – M",
        blocks: [
          {
            kind: "list",
            items: [
              "**Incident** — one firing of an alert rule, from start to recovery. See [[alerts-and-popups]].",
              "**LCR (least-cost routing)** — ranking vendors by cost (and quality) for each destination.",
              "**Margin** — revenue minus cost. **Margin %** = margin ÷ revenue.",
              "**Master table** — the list of dial-code prefixes and the MCCMNC each belongs to.",
              "**MCC (mobile country code)** — three digits for a country, e.g. `208` France.",
              "**MCCMNC** — MCC + MNC together, e.g. `20801`. The main routing and rating key.",
              "**MNC (mobile network code)** — two or three digits for a network within a country.",
              "**MNP / ported** — mobile number portability: a number that moved to another network keeps its digits, so only an HLR lookup shows its real network.",
              "**MO / MT** — mobile-originated (sent by a phone) / mobile-terminated (sent to a phone) messages.",
            ],
          },
        ],
      },
      {
        id: "n-r",
        title: "N – R",
        blocks: [
          {
            kind: "list",
            items: [
              "**NOC (network operations centre)** — the team that watches traffic and connections around the clock.",
              "**Product category** — a traffic class label such as DIRECT, HQ, SIM, OTP or PROMO, used on trunks, rate tables and route rules.",
              "**QBR (quality-based routing)** — routing that takes vendor quality (ASR, DLR, delay) into account, not only price.",
              "**Rate table** — a price list per MCCMNC (and optionally sender ID) with validity dates. Customer rate tables set what we charge; vendor rates what we pay.",
              "**Bilateral** — an enterprise that is both customer and vendor.",
              "**Re-rating** — recalculating the charges of past traffic after a rate correction.",
              "**RN (rate notification)** — a vendor's notice of new rates. A vendor RN never re-rates traffic already sent; it applies from its effective date.",
              "**Route rule** — conditions (customer, destination, sender …) that pick which vendors a message goes to, in which order or share.",
            ],
          },
        ],
      },
      {
        id: "s-z",
        title: "S – Z",
        blocks: [
          {
            kind: "list",
            items: [
              "**Sender ID** — the source address shown to the recipient: a number or a short name (alphanumeric).",
              "**SMPP (Short Message Peer-to-Peer)** — the standard protocol SMS systems use to exchange messages and receipts.",
              "**SOA (statement of account)** — a list of a partner's invoices, payments and balance over a period.",
              "**Submitted / successful** — attempts accepted and sent on to a vendor.",
              "**system_id** — the SMPP username of a trunk.",
              "**TON / NPI** — type of number and numbering plan of an address, e.g. TON 1 international, TON 5 alphanumeric; NPI 1 E.164.",
              "**TPS (transactions per second)** — messages per second; also the speed limit set on a trunk.",
              "**Translation rule** — a rule that rewrites or blocks a message (sender, receiver, content, TON/NPI, DLR) on a trunk.",
              "**Trunk** — a connection to a partner: customer trunk (incoming) or vendor trunk (outgoing).",
              "**TX / RX / TRX** — bind modes: transmitter (send only), receiver (receive only), transceiver (both).",
              "**UTC** — the time zone all times are shown in, unless a page says otherwise.",
              "**Vendor** — an enterprise we send traffic to and pay.",
              "**Vendor trunk** — our connection to a vendor, SMPP or HTTP, with its capacity and message rules.",
            ],
          },
        ],
      },
    ],
  },

  // ================================================================== Dashboard & live
  {
    id: "home",
    pageKey: "home",
    title: "Home",
    group: "Dashboard & live",
    summary: "The start tab: the daily screens one click away and a few tips for working with the app.",
    keywords: ["home", "start", "welcome", "daily screens"],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "Home is the first tab and is always open (it is pinned and cannot be closed). It greets you by first name and gives quick access to the screens the team uses every day. After you sign in, the **Dashboard** opens; click the Home tab to come back here.",
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
              "**Daily screens** — **Dashboard** and **Live analytics** always on top, then **Most used by you** (your most opened pages in the last 30 days, with how many times) and **Recently opened** (the pages and records you opened last, newest first, with how long ago). Until you have a history, Most used shows Enterprises, Rate manager, Route rules, Rate lookup and Enterprise report.",
              "**Working with the app** — short tips: Ctrl K, opening and closing tabs, dragging tabs out, typing column filters, saved views and Ctrl Z.",
              "The status bar shows how many pages and menus the platform has.",
            ],
          },
        ],
      },
      {
        id: "how-to",
        title: "How to use it",
        blocks: [
          {
            kind: "list",
            items: [
              "Click a daily screen to open it in a new tab. If it is already open, its tab comes to the front.",
              "Ctrl-click or middle-click opens another copy in a new tab.",
              "Right-click the Home tab and choose **Close other tabs** to tidy up; pinned tabs stay.",
            ],
          },
          {
            kind: "tip",
            text: "Your open tabs and theme are saved to your profile and come back next time. New to the platform? Start with [[getting-started]].",
          },
        ],
      },
    ],
  },
  {
    id: "dashboard",
    pageKey: "dashboard",
    title: "Dashboard",
    group: "Dashboard & live",
    summary:
      "The live NOC view of today: volume and money counters, traffic movers, a live TPS chart, TPS per trunk and today's top clients, vendors and destinations.",
    keywords: ["dashboard", "NOC", "live", "TPS", "movers", "top clients", "today", "summary", "realtime"],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "The Dashboard shows today's traffic as it happens, without reloading. NOC engineers keep it open to see at a glance who started sending, who is ramping up or dropping, and how hard each client pushes against its TPS (messages per second) limit. Managers and AMs use it for today's volume and margin.",
          },
          {
            kind: "text",
            text: "Figures are pushed from the server: the counters every second by default, the movers and top lists every few seconds. Every row, chip and chart line can be clicked to open [[live-analytics]] for it in a new tab.",
          },
          {
            kind: "tip",
            text: "In the trial the traffic comes from a simulator, so the figures are fake but move like real traffic.",
          },
        ],
      },
      {
        id: "header",
        title: "Header controls",
        blocks: [
          {
            kind: "fields",
            title: "Settings in the page header (saved to your profile)",
            fields: [
              {
                name: "Movers window",
                what: "The time window the Traffic movers compare: the last window against the window before it.",
                values: "**Last 5 minutes**, **Last 15 minutes** (default), **Last 30 minutes**, **Last hour**.",
              },
              {
                name: "Refresh",
                what: "How often the counters, movers, top lists and TPS tables update. The TPS chart always stays live.",
                values:
                  "**Live (1 s)** (default), **Every 5 s**, **Every 10 s**, **Every 30 s**, **Every minute**, **Paused** (keeps the figures shown when you paused).",
              },
              {
                name: "Panels",
                what: "Tick or untick the panels to show. The default order is Today's summary, Top clients and vendors, TPS per trunk, Traffic movers, Top destinations, Live TPS chart. **Reset layout** puts every panel back in that order at full width.",
                values: "All shown by default.",
              },
              {
                name: "Moving and resizing panels",
                what: "Hover a panel: drag the **⠿** grip (top right) onto another panel to move it there, and drag the corner (bottom right) to make it narrower, wider, shorter or taller. Two half-width panels sit side by side. Double-click the corner to give the panel its own height again.",
                values: "Widths go in twelfths of the page (a quarter at the least). Saved to your profile.",
              },
              {
                name: "Live / Paused / Offline",
                what: "The state of the feed. **Live** (green dot) is updating, **Paused** when Refresh is Paused, **Offline** when the live connection is lost (it reconnects by itself).",
              },
            ],
          },
        ],
      },
      {
        id: "summary",
        title: "Today (summary bar)",
        blocks: [
          {
            kind: "text",
            text: "Counters for today (the day in the platform time zone) that roll to their new value. Admins and department managers also see **Online now** in the page header, next to the title (signed-in colleagues; green initials are active in the last 5 minutes; click to open Logged-in users). Everyone sees the **Market moves** card with the number of open moves and how many are urgent (click to open Market moves).",
          },
          {
            kind: "fields",
            title: "Counters",
            fields: [
              { name: "Attempts", what: "Messages received from customers today." },
              { name: "Submitted", what: "Messages sent on to a vendor." },
              { name: "Delivered", what: "Messages with a delivered receipt." },
              { name: "Revenue", what: "What customers are charged today." },
              { name: "Cost", what: "What vendors charge us today." },
              {
                name: "Margin",
                what: "Revenue minus cost, under Revenue in the same card.",
                values: "Red when negative.",
              },
              { name: "ASR", what: "Accepted ÷ attempts.", values: "Amber below 80 %, red below 60 %." },
              { name: "DLR", what: "Delivered ÷ submitted.", values: "Amber below 70 %, red below 50 %." },
              { name: "TPS now", what: "Total messages per second right now." },
              {
                name: "Online",
                what: "Customers sending now and vendors receiving now, in one card. A green light shows next to **Online**.",
              },
            ],
          },
          {
            kind: "text",
            text: "Under the counters, **Top destinations** shows today's five busiest destinations as chips (rank, country, network, attempts). Click one to open its analytics.",
          },
        ],
      },
      {
        id: "movers",
        title: "Traffic movers",
        blocks: [
          {
            kind: "text",
            text: "The heading says what is compared, for example `Last 15 min vs the 15 min before`. Four columns:",
          },
          {
            kind: "list",
            items: [
              "**Started** (green) — clients with no traffic in the previous window that are sending now. Newly appeared rows get a **new** badge and a short pulse.",
              "**Customer** — customer trunks whose traffic went up (▲) or down (▼), biggest change first. **Volume ≥** leaves out trunks that sent fewer messages than this in the window (now and before); default 100.",
              "**Vendor** — the same for vendor trunks, with its own **Volume ≥**.",
              "**Stopped** (red) — clients that were sending and dropped to zero.",
            ],
          },
          {
            kind: "text",
            text: "Each row: client (or vendor) and trunk with the destination it sends most to, a sparkline of the last hour, the TPS now and **from** the earlier TPS (for Stopped: what it **was**), the change in % with ▲ or ▼, then ASR and DLR. Hover for the full figures and message counts; click to open its analytics. **None** means no trunk is in that group.",
          },
        ],
      },
      {
        id: "chart",
        title: "Live TPS chart",
        blocks: [
          {
            kind: "text",
            text: "A streaming line chart of total TPS (left axis, filled line) and the ten busiest client trunks (right axis). Choose the length at the top right: **5 min**, **15 min** or **1 h**. Click a trunk name in the legend to hide or show its line. Hover for exact values; click a trunk's line to open its analytics.",
          },
        ],
      },
      {
        id: "tps-tables",
        title: "TPS per client trunk / per vendor trunk",
        blocks: [
          {
            kind: "text",
            text: "Two tables side by side, busiest first. The heading shows how many trunks are sending and their total TPS. Rows slide up or down smoothly as their rank changes. Click a row to open that trunk's analytics.",
          },
          {
            kind: "fields",
            title: "Columns",
            fields: [
              { name: "Trunk", what: "Trunk name." },
              { name: "TPS", what: "Messages per second right now." },
              { name: "Limit", what: "The TPS limit set on the trunk." },
              {
                name: "Use of limit",
                what: "TPS as a share of the limit, as a bar with the %.",
                values: "Amber above 80 %, red at 100 % or more.",
              },
              { name: "Queue", what: "Messages waiting in the trunk's buffer. Highlighted when above zero." },
            ],
          },
        ],
      },
      {
        id: "tops",
        title: "Top clients, vendors and destinations today",
        blocks: [
          {
            kind: "text",
            text: "Ranked tables for today, with a bar showing each row's share of the volume. Rows move when their rank changes. **Click a row** to open what it is made of today under it, framed: for a client its destinations (whole countries) and vendors, for a vendor its clients and destinations, for a destination its clients and vendors, each with the volume. Click the row again to close it. **Click a line of the breakdown** to open the row in Live analytics in a new tab.",
          },
          {
            kind: "fields",
            title: "Top clients / Top vendors today",
            fields: [
              { name: "#", what: "Rank by volume." },
              { name: "Client / Vendor", what: "Enterprise name." },
              { name: "Volume", what: "Attempts today." },
              { name: "Revenue / Cost", what: "Revenue for clients, cost for vendors." },
              { name: "Margin", what: "Revenue minus cost.", values: "Red when negative." },
              { name: "ASR / DLR", what: "Acceptance and delivery ratios in %." },
            ],
          },
          {
            kind: "fields",
            title: "Top destinations today",
            fields: [
              { name: "Country", what: "The destination country, all its networks together." },
              { name: "Networks", what: "How many of its networks had traffic today." },
              { name: "Volume, Revenue, Margin, ASR, DLR", what: "As above, for traffic to that country." },
            ],
          },
        ],
      },
      {
        id: "how-to",
        title: "How to …",
        blocks: [
          {
            kind: "steps",
            title: "Investigate a client that dropped",
            items: [
              "Look in **Customer** (a ▼ row) or **Stopped** for the client.",
              "Hover the row to see TPS before and now, ASR and DLR.",
              "Click it. Live analytics opens in a new tab, broken down for that client.",
              "Break the client down by destination or vendor there to find where traffic fell.",
            ],
          },
          {
            kind: "steps",
            title: "Make the dashboard calmer",
            items: [
              "Set **Refresh** to **Every 30 s** or **Every minute**.",
              "Untick panels you do not need under **Panels**.",
              "Turn animations off in the avatar menu (**Turn animations off**).",
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
            text: "Your movers window, Customer and Vendor volumes, chart length, refresh, hidden panels and layout are saved to your profile and come back next time.",
          },
          {
            kind: "tip",
            text: "A red dot on the Dashboard tab means there are open incidents. See [[alerts-and-popups]].",
          },
          {
            kind: "warning",
            text: "If all panels are hidden the page says so; use **Panels** to show them again. If the status bar says **Reconnecting to the live feed…**, the figures shown are not current.",
          },
        ],
      },
    ],
  },
  {
    id: "live-analytics",
    pageKey: "live-analytics",
    title: "Live analytics",
    group: "Dashboard & live",
    summary:
      "The analytics report: a total row you break down level by level (customer, trunk, destination, vendor, time …), with figures that refresh by themselves while the period includes today.",
    keywords: [
      "analytics",
      "analytics report",
      "live report",
      "drill down",
      "breakdown",
      "ASR",
      "DLR",
      "traffic report",
    ],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "Live analytics is the main monitoring report. It starts from one **Total** row for the chosen period and lets you break any row down by another level (for example Customer, then Customer trunk, then Destination, then 15 minutes) to find exactly where traffic, ASR, DLR or margin changed. While the period includes today, the figures refresh in place at the interval you choose.",
          },
          {
            kind: "text",
            text: "NOC uses it to investigate incidents and drops; AMs and managers use it to check their clients' traffic and margin. The Dashboard, incident pop-ups and other pages open it already broken down by the right level.",
          },
        ],
      },
      {
        id: "header",
        title: "Header controls",
        blocks: [
          {
            kind: "fields",
            fields: [
              {
                name: "Live / Paused / Not live",
                what: "**Live** (green): figures are refreshing. **Paused**: the period includes today but refresh is paused or off. **Not live**: the period is over, so nothing changes.",
              },
              {
                name: "Pause / Resume",
                what: "Right after the Live / Paused / Not live indicator. Freezes the figures while you investigate, keeping the chosen interval. **Resume** catches up.",
                values: "Greyed out when the period does not include today or Refresh is Off.",
              },
              {
                name: "Refresh",
                what: "After **Pause**. How often the figures refresh while the period includes today.",
                values:
                  "**Off**, **1 s (live)**, **2 s**, **5 s**, **15 s**, **30 s** (default), **1 min**, **5 min**.",
              },
              {
                name: "Columns",
                what: "Right of the period bar. Adds or removes columns, grouped **Traffic**, **Quality**, **Money** and **HLR/MNP**. Saved per user. **Reset to default columns** goes back to the standard set. See [[live-analytics#columns]].",
              },
            ],
          },
        ],
      },
      {
        id: "period",
        title: "Choosing the period",
        blocks: [
          {
            kind: "fields",
            fields: [
              {
                name: "From day / To day",
                what: "The calendar days to report, both included (UTC).",
                values: "At most 400 days.",
              },
              {
                name: "Today, Yesterday, Last 7 days, This month, Last month",
                what: "Quick buttons that fill in From and To.",
              },
              {
                name: "Each day",
                what: "Only these hours of each day, e.g. 08:00–17:59 every day of last week.",
                values: "From `00:00` to `23:59` (whole day) by default.",
              },
            ],
          },
          {
            kind: "text",
            text: "Changes apply at once; there is no Search button. If the days are not valid the header shows why in red: **Pick the From and To days**, **To must be on or after From** or **At most 400 days**.",
          },
          {
            kind: "tip",
            text: "In the trial, **Today** is the latest day that has traffic in the fake data, and the page opens on it.",
          },
        ],
      },
      {
        id: "table",
        title: "The table",
        blocks: [
          {
            kind: "list",
            items: [
              "**Total** — the first row, with all traffic of the period. It opens broken down **by customer** (or by what the link that opened the page asked for).",
              "**+** at the start of a row opens a menu of levels to break it down by; **−** closes the breakdown. Each row can be broken down by any level not already used above it. An expanded row group is marked by bold lines above and below it, so you can see where a breakdown starts and ends. The **Total** row is bold throughout on a grey fill.",
              "**Search** — the top breakdown has a search box in the first column header; each nested breakdown has its own search row. Each box is labelled with the level name (for example **Customer trunk**) and matches the start of the name.",
              "**A–Z** next to the top search sorts by name. Click any column header to sort every breakdown by it: the first click shows the highest first, the next click flips it.",
              "Breakdowns show the 100 busiest rows; **Show … more of …** loads the next 100.",
              "Enterprises are shown by their brand name.",
              "**EDRs** at the end of a row opens the messages behind it; the ⬇ icon exports them. See below.",
              "On narrow screens the table scrolls sideways instead of cutting figures.",
            ],
          },
          {
            kind: "fields",
            title: "Levels you can break down by",
            fields: [
              { name: "Customer / Customer trunk", what: "The sending enterprise / its connection." },
              {
                name: "Customer country / Customer network (MCCMNC)",
                what: "Destination as rated on the customer side.",
              },
              { name: "Vendor / Vendor trunk", what: "The enterprise / connection the traffic was sent to." },
              { name: "Vendor country / Vendor network (MCCMNC)", what: "Destination as rated on the vendor side." },
              {
                name: "Customer account manager / Vendor account manager",
                what: "The AM at the time the message was sent.",
              },
              {
                name: "Customer Sender ID",
                what: "The Sender ID as the customer sent it. Numeric Sender IDs (digits only, with or without +) are grouped in one **Numeric** row; only that row's **+** offers **Customer Sender ID (each numeric)**, which lists them one by one.",
              },
              {
                name: "Vendor Sender ID",
                what: "The Sender ID as we sent it to the vendor, after translation rules. Numeric ones are grouped the same way; the **Numeric** row's **+** offers **Vendor Sender ID (each numeric)**.",
              },
              { name: "Product category", what: "The traffic class (DIRECT, OTP …)." },
              { name: "15 minutes, Hour, Day, Week, Month", what: "Time buckets, shown in time order." },
            ],
          },
        ],
      },
      {
        id: "columns",
        title: "Columns",
        blocks: [
          {
            kind: "fields",
            fields: [
              { name: "Attempts", what: "Messages received from customers." },
              { name: "Submitted", what: "Sent to a vendor." },
              { name: "Billable (C)", what: "Billable to the customer." },
              { name: "Billable (V)", what: "Billable by the vendor." },
              { name: "ASR %", what: "Accepted ÷ attempts." },
              { name: "DLR (c) %", what: "Delivered as reported to the customer (the receipts we send)." },
              { name: "DLR (v) %", what: "Delivered as reported by the vendor." },
              { name: "Margin", what: "Revenue − cost, in the platform currency." },
              { name: "Revenue", what: "Customer charges, in the platform currency." },
              { name: "Cost", what: "Vendor charges, in the platform currency." },
              { name: "Delivered", what: "Delivery receipts DELIVRD from vendors." },
              { name: "Rate (C) / Rate (V)", what: "Average customer / vendor rate per message." },
              { name: "Delay sec", what: "Average delivery delay in seconds." },
              { name: "HLR/MNP", what: "Number of HLR / MNP lookups." },
              { name: "Ported", what: "Numbers the HLR / MNP lookup found ported to another network." },
              { name: "TPS", what: "Live TPS: messages per second over the last minute." },
              { name: "HLR/MNP cost", what: "Cost of HLR / MNP lookups, in the platform currency." },
            ],
          },
          {
            kind: "fields",
            title: "Hidden by default (add them with Columns)",
            fields: [
              {
                name: "Cached HLR/MNP",
                what: "Of all lookups, numbers already looked up in the last 24 hours, answered from the cache.",
              },
              { name: "Live HLR/MNP", what: "Lookups sent to a provider (not from the cache)." },
              { name: "HLR/MNP answered", what: "Lookups that returned a result." },
              { name: "Margin %", what: "Margin ÷ revenue." },
              { name: "Avg cost", what: "Average cost per billable message, in the platform currency." },
              { name: "Success", what: "Accepted by the platform." },
              { name: "Failed submits", what: "Messages no vendor accepted." },
              { name: "Reroutes", what: "Messages sent again to another vendor." },
              { name: "Reported (C)", what: "Delivery receipts sent to the customer." },
              { name: "Reported (V)", what: "Delivery receipts received from vendors." },
              { name: "Avg TPS", what: "Average messages per second over the period." },
              { name: "Peak TPS", what: "Busiest second of the period." },
              { name: "MO", what: "Mobile originated messages." },
            ],
          },
          {
            kind: "text",
            text: "The columns shown above are the default set. **Columns** (right of the period bar) adds or removes columns and saves your choice per user. Money and rate columns show 6 decimals on every row; they are never rounded to whole units.",
          },
          {
            kind: "list",
            title: "Colours",
            items: [
              "**ASR, DLR (c), DLR (v)**: green from 80 %, amber box from 60 % to under 80 %, red box below 60 %.",
              "**Margin**: green when positive, red box when negative.",
            ],
          },
        ],
      },
      {
        id: "detail",
        title: "Traffic over time (detail panel)",
        blocks: [
          {
            kind: "steps",
            items: [
              "Double-click any row (or the Total row). A panel opens on the right of the table with that row's traffic over time, newest first.",
              "Choose the **Period** of each line: **Second**, **Minute** (default), **15 minutes**, **Hour** or **Day**. **Show older** loads more lines.",
              "Click a time line. The table above then shows only that moment, with a strip **Showing only …**.",
              "Click **Show the whole period** in the strip to go back. Close the panel with ✕.",
            ],
          },
        ],
      },
      {
        id: "edrs",
        title: "Seeing and exporting the messages (EDRs)",
        blocks: [
          {
            kind: "steps",
            items: [
              "Click **EDRs** on a row. A window lists the message records (EDRs) behind that row for the period, with the usual column filters.",
              "The foot of the window shows when the list was loaded. Click **Refresh** to load the EDRs written since you opened it.",
              "Click **Open in EDR search** to continue in a new tab with the same filters ([[edr-search]]).",
              "Click **Export…** (or the ⬇ icon on the row) to request a CSV or Excel file of those EDRs.",
            ],
          },
          {
            kind: "warning",
            text: "The **Each day** hours filter is not applied in the EDR window; it shows the whole days of the period.",
          },
        ],
      },
      {
        id: "how-it-works",
        title: "How it works",
        blocks: [
          {
            kind: "text",
            text: "Every row is a query on the server over the full traffic data, filtered on the rows above it, so even large periods stay fast. While the period includes today, the server signals new data and the open levels refresh at your chosen interval; a refresh is skipped while the previous one is still loading. Past periods are fixed and do not refresh.",
          },
          {
            kind: "text",
            text: "Figures read the AM and rates as they were when each message was sent, so later handovers or rate changes do not change them ([[am-visibility#attribution]]). The status bar shows how many rows the top level has, e.g. `248 × customer`.",
          },
        ],
      },
      {
        id: "tips",
        title: "Tips",
        blocks: [
          {
            kind: "tip",
            text: "To find a DLR drop: break the Total down by **Customer**, sort by **DLR (c) %**, break the worst customer down by **Vendor**, then double-click the vendor row and look at it **by Minute**.",
          },
          {
            kind: "tip",
            text: "Settings on this page (period, levels, refresh) are not saved: they reset when you reopen the page. Only your **Columns** choice is saved. Copy the result with **Export…** if you need to keep it.",
          },
        ],
      },
    ],
  },
];
