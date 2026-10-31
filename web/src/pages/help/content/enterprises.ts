// Help center: enterprises and trunks (§5, §13.1, §13.2, §13.26, §13.29, §13.30).
import type { HelpTopic } from "../helpTypes";

export const topics: HelpTopic[] = [
  // ------------------------------------------------------------------ Enterprises list
  {
    id: "enterprises",
    pageKey: "enterprises",
    title: "Enterprises",
    group: "Enterprises",
    summary:
      "The list of every partner (customer, vendor or both). Find a partner, see its type, category, status and account manager, and open its full record.",
    keywords: [
      "partner",
      "customer",
      "vendor",
      "bilateral",
      "client",
      "carrier",
      "account",
      "enterprise list",
      "tier",
      "category",
      "account manager",
      "AM",
      "business company",
    ],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "An **enterprise** is one partner company: a customer that sends us traffic, a vendor we send traffic to, or a **bilateral** partner that is both. Everything about a partner hangs off its enterprise: contacts, documents, billing, its customer and vendor trunks, its account manager and its change history.",
          },
          {
            kind: "text",
            text: "Account managers (Account Managers) use this page to find their partners. NOC staff use it to jump to a partner's trunks. Billing uses it to reach a partner's billing details. Admins use it to add, delete and restore partners.",
          },
          {
            kind: "text",
            text: "Each row opens the partner's full record in its own tab. See [[enterprise-record|Enterprise record]] for every tab and field of that screen.",
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
              "**Undo**: undoes your own last change on enterprises (also **Ctrl+Z**). See [[undo-and-history]].",
              "**History**: opens the change history of all enterprises: who changed what and when, with undo per change.",
              "**Export**: exports the rows that match the current filters. In the trial this button is not active yet.",
              "**New enterprise** (the filled button): opens an empty enterprise record in a new tab.",
            ],
          },
          {
            kind: "list",
            title: "Filter card",
            items: [
              "**Quick search box** — click it to pick a field (for example **Type** or **Status**); each field filter shows as a pill in the box. × on a pill removes it. Plain text typed outside a pill searches the main text fields when you press **Enter**; it matches the start of a value (`Colo` finds names starting with Colo), so type `%colo` to find it anywhere. **Esc** clears it. See [[grids-and-filters#quick-search]].",
              "**Any of (OR)…** in the search card opens the filter builder for conditions on several fields joined with AND or OR. See [[filter-builder]].",
              "**Show deleted** adds deleted (archived) enterprises to the list, greyed out.",
              "**Clear all** removes every filter and the search.",
              "On the right: **Save as view** keeps the current filters as a named view and **Views** reapplies a saved view; then the selection summary, the header actions and **Columns** to show or hide columns.",
            ],
          },
          {
            kind: "fields",
            title: "Grid columns",
            fields: [
              {
                name: "ID",
                what: "The enterprise's number in the system. Never changes.",
                values: "Filter with an exact number, e.g. `1042`.",
              },
              {
                name: "Full Legal Name",
                what: "The partner's full legal company name. Unique across all enterprises, deleted ones included.",
              },
              { name: "Brand Name", what: "Short name used in trunk names and reports.", values: "e.g. `ACME`." },
              {
                name: "Type",
                what: "Customer, Vendor or Bilateral (both). Decides which trunk and billing tabs the record has.",
              },
              { name: "Category", what: "The partner's tier: Tier 1, Tier 2 or Tier 3." },
              { name: "Status", what: "Active or Inactive." },
              {
                name: "Business Company",
                what: "Our own company that contracts with this partner and invoices it (sets the base currency).",
              },
              {
                name: "Account Manager",
                what: "The Account Manager who owns the partner today. Shows a dash when none is set.",
              },
              {
                name: "Customer trunks / Vendor trunks",
                what: "How many live trunks the enterprise has on each side, in bold. Point at a number to see the trunks by name. Sort or filter on them like any number (for example `>2`).",
              },
              {
                name: "Hidden columns",
                what: "Country, Updated By, Updated Time and the internal ID columns can be turned on from the columns menu.",
              },
            ],
          },
          {
            kind: "text",
            text: "Every column has its own filter under the header. Text filters accept `%` (any run of characters) and `_` (one character) and ignore upper and lower case. Filtering, sorting and paging run on the server, so the list stays fast with thousands of partners. See [[grids-and-filters]].",
          },
          {
            kind: "list",
            title: "Detail panel (click a row; it opens on the right of the grid)",
            items: [
              "Title: **Full Legal Name – Brand Name (ID)** and the type, with × to close.",
              "**General**: Type, Category, Status, Business company, Account manager, Country and who updated it last (UTC). Beside them, **Emails** lists the e-mail addresses of the four contacts (Commercial, Technical, Rates, Finance).",
              "**Record**: a link that opens the full record for docs, billing, trunks, account managers and history.",
              "At the bottom: ID, Created date and, for a deleted enterprise, **Deleted** with the date (amber).",
            ],
          },
          {
            kind: "list",
            title: "Actions in the header",
            items: [
              "**Edit**: opens the highlighted enterprise in a new tab (or double-click the row).",
              "**Delete**: starts the safe delete check. With several rows ticked, it deletes all of them after one confirmation that names how many.",
            ],
          },
        ],
      },
      {
        id: "how-to-find",
        title: "How to find and open a partner",
        blocks: [
          {
            kind: "steps",
            items: [
              "Type the start of the name in the **Full Legal Name** filter, e.g. `acme` for names that start with Acme, or `%mobile%` for names containing mobile.",
              "Or type in the quick search box and press **Enter**. It matches the start of a name; type `%mobile` to find it anywhere.",
              "Click the row to see its summary and contact e-mails in the detail panel on the right.",
              "Double-click the row or press **Enter** to open the full record in its own tab. Hold **Ctrl** (or **Cmd**) while double-clicking to force a second tab even if the record is already open.",
            ],
          },
          {
            kind: "tip",
            text: "Inside an open record you can switch to another partner with the **Full Legal Name – Brand Name (ID)** picker at the top. Type a name, brand name or an ID number.",
          },
        ],
      },
      {
        id: "how-to-add",
        title: "How to add an enterprise",
        blocks: [
          {
            kind: "steps",
            items: [
              "Click **New enterprise**. An empty record opens in a new tab on the **General** tab.",
              "Fill in at least **Full Legal Name**, **Brand Name**, **Business company**, **Account manager** (picked once here; later changes go through **Hand over**), **Legal address** and one e-mail address for each of the four contacts (Commercial, Technical, Rates, Finance).",
              "Pick the **Type**: Customer, Vendor or Bilateral (both).",
              "Click **Add enterprise**. The record saves and the other tabs (Docs, Billing, trunks, Account managers, History) become available.",
              "Go to **Billing** and click **Set up customer billing** and/or **Set up vendor billing**, then **Save billing**.",
              "Add trunks from the **Customer trunks** or **Vendor trunks** tab.",
            ],
          },
          {
            kind: "text",
            text: "Every field is explained in [[enterprise-record#general-fields|Enterprise record: General tab]].",
          },
        ],
      },
      {
        id: "how-to-delete",
        title: "How to delete or restore an enterprise",
        blocks: [
          {
            kind: "steps",
            items: [
              "Highlight the row and click **Delete** in the header (or tick several rows), or click **Delete** in the open record.",
              "The dialog checks what depends on the partner: live binds, customer and vendor trunks, route rules using its trunks, unpaid or draft invoices, customer and vendor balances, open disputes, and traffic in the last 30 days.",
              "Items in red block the delete. Settle them first (pay or credit the invoices, bring balances to zero, close disputes).",
              "An enterprise that still has any customer or vendor trunk that is not deleted cannot be deleted or archived, not even with an administrator override. Delete its trunks first.",
              "Optionally write a **Reason**, then click **Delete**.",
            ],
          },
          {
            kind: "text",
            text: "Delete never erases data. The enterprise is archived: it leaves lists, pickers and routing at once. It stays in reports, invoices and history. See [[safe-delete]].",
          },
          {
            kind: "text",
            text: "To restore, tick **Show deleted**, open the deleted enterprise and click **Restore** in the banner at the top.",
          },
          {
            kind: "warning",
            text: "Only an administrator can restore a deleted enterprise, and only an administrator can **Override the blockers**. An override needs a written reason, which is saved with the change. Live trunks can never be overridden: delete them first.",
          },
        ],
      },
      {
        id: "tips",
        title: "Tips and things to watch",
        blocks: [
          {
            kind: "tip",
            text: "A deleted enterprise keeps its name reserved. To reuse the name for a new partner, first rename the deleted one (restore it, add a suffix, delete again).",
          },
          {
            kind: "tip",
            text: "Depending on your visibility settings, some partner names or figures may be masked or hidden for you. See [[am-visibility]].",
          },
          {
            kind: "text",
            text: "Related: [[customer-trunks|Customer trunks]], [[vendor-trunks|Vendor trunks]], [[enterprise-report|Enterprise report]], [[balances|Balances]].",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ Enterprise record
  {
    id: "enterprise-record",
    title: "Enterprise record",
    group: "Enterprises",
    summary:
      "The single-partner screen: General details and contacts, Docs, Billing, Customer trunks, Vendor trunks, Account managers and History, all in one tab.",
    keywords: [
      "enterprise",
      "partner record",
      "general info",
      "contacts",
      "KYC",
      "contract",
      "documents",
      "billing",
      "credit limit",
      "opening balance",
      "beneficiary",
      "bank details",
      "IBAN",
      "SWIFT",
      "hand over",
      "handover",
      "account manager",
      "credit alert",
      "bind alert",
    ],
    sections: [
      {
        id: "overview",
        title: "What this screen is for",
        blocks: [
          {
            kind: "text",
            text: "The enterprise record holds one partner's whole account. It opens in its own tab from the [[enterprises|Enterprises]] list, from a trunk, or from **New enterprise**.",
          },
          {
            kind: "text",
            text: "Account Managers keep contacts and details up to date and hand partners over. Billing sets currency, cycle, credit limit and bank details. NOC opens the partner's trunks from here.",
          },
        ],
      },
      {
        id: "layout",
        title: "What you see on the screen",
        blocks: [
          {
            kind: "list",
            title: "Header",
            items: [
              "**Full Legal Name – Brand Name (ID)** picker: click it and type a name, brand name or ID to switch to another partner in the same tab. If you have unsaved edits you are asked whether to discard them.",
              "**Delete**: starts the safe delete check (hidden when the enterprise is already deleted).",
              "**Notifications**: **Send rates…** and **Send tech info…** for all the enterprise's customer trunks at once. Greyed out when the enterprise has no customer trunks. See [[enterprise-record#notifications]].",
              "The filled button on the right changes with the tab: **Add enterprise** / **Save**, **Upload document**, **Save billing**, **New customer trunk**, **New vendor trunk** or **Hand over**. A **Discard** button appears next to Save when you have unsaved edits.",
            ],
          },
          {
            kind: "text",
            text: "Under the header a grey line sums up the partner: type, tier, business company, Account Manager and status. If the enterprise is deleted, a banner says when and by whom, and editing is off until it is restored.",
          },
          {
            kind: "list",
            title: "Tabs",
            items: [
              "**General**: identity, address, company details, alerts and contacts.",
              "**Docs**: contracts, KYC and other files.",
              "**Billing**: customer and/or vendor billing sides and bank details.",
              "**Customer trunks**: only for Customer and Bilateral partners. Shows a count.",
              "**Vendor trunks**: only for Vendor and Bilateral partners. Shows a count.",
              "**Account managers**: Account Manager history and **Hand over**.",
              "**History**: every saved change to this enterprise, with undo.",
            ],
          },
          {
            kind: "text",
            text: "On a new enterprise only **General** is open; the other tabs unlock after **Add enterprise**. Edits stay when you switch tabs. A tab with unsaved edits marks the page tab, and closing it asks first.",
          },
          {
            kind: "text",
            text: "The status bar shows the enterprise ID, type and status.",
          },
        ],
      },
      {
        id: "general-fields",
        title: "General tab: fields",
        blocks: [
          {
            kind: "fields",
            title: "General information",
            fields: [
              {
                name: "Full Legal Name",
                what: "The partner's full legal company name. Required. Must be unique, including deleted enterprises.",
                values: "Up to 200 characters, e.g. `Acme Mobile Ltd`.",
              },
              {
                name: "Brand Name",
                what: "Short name used in trunk names and reports. Required.",
                values: "Up to 100 characters, e.g. `ACME`.",
              },
              {
                name: "Business company",
                what: "Our own company that holds the contract with this partner. It sets the default billing currency and appears on invoices. Required.",
                values:
                  "Pick from the list; each shows its base currency, e.g. `Example Telecom FZ (USD)`. New enterprises start with the first one.",
              },
              {
                name: "Type",
                what: "What the partner is to us. Decides which trunk tabs and billing sides exist.",
                values:
                  "**Customer** (sends us traffic), **Vendor** (we send to it) or **Bilateral (both)**. Default Customer.",
              },
              {
                name: "Category",
                what: "The partner's tier, used for grouping in lists and reports.",
                values: "Tier 1, Tier 2 or Tier 3. Default Tier 2.",
              },
              {
                name: "Status",
                what: "Whether the partner is active.",
                values: "Active or Inactive. Default Active.",
              },
              {
                name: "Account manager",
                what: "The Account Manager who owns the partner. Shown and required only when adding an enterprise. Afterwards the General tab no longer shows it: changes go through the **Account managers** tab (**Hand over**), so that past results stay with the Account Manager who earned them.",
                values: "Pick a user who is an active account manager.",
              },
            ],
          },
          {
            kind: "fields",
            title: "Address",
            fields: [
              { name: "Legal address", what: "The registered address. Required.", values: "Up to 200 characters." },
              {
                name: "Physical address",
                what: "Where the partner actually operates, when it differs from the legal address.",
                values: "Optional, up to 200 characters.",
              },
              { name: "City", what: "City.", values: "Optional, up to 100 characters." },
              { name: "State / region", what: "State, province or region.", values: "Optional, up to 100 characters." },
              {
                name: "Country",
                what: "The partner's country.",
                values: "Pick from the country list, shown with its ISO code, e.g. `Germany (DE)`.",
              },
              { name: "ZIP / postcode", what: "Postal code.", values: "Optional, up to 20 characters." },
            ],
          },
          {
            kind: "fields",
            title: "Company details",
            fields: [
              {
                name: "Website",
                what: "The partner's website.",
                values: "e.g. `https://acme.example`. Up to 300 characters.",
              },
              { name: "Fax", what: "Fax number.", values: "Optional, up to 50 characters." },
              {
                name: "Registration number",
                what: "Company registration number.",
                values: "Optional, up to 100 characters.",
              },
              {
                name: "VAT number",
                what: "Tax / VAT number. Also used to warn about possible duplicate partners.",
                values: "Optional, up to 100 characters.",
              },
              {
                name: "Account number",
                what: "Our account number for this client, shown in the header of its invoices and as **Account No** on the Invoices list. Customers and bilateral partners only.",
                values: "Optional, up to 50 characters.",
              },
              {
                name: "Billing time zone",
                what: "Day and month totals for this partner are cut at midnight in this zone (for example in the Enterprise report and invoice checks). Trunks can override it.",
                values: "Pick a time zone. Default `UTC`.",
              },
              {
                name: "'All networks' code",
                what: "How this partner writes a country's all-networks rate in rate sheets: MCC (262), MCC0 (2620), MCC00 (26200), MCC000 (262000), MCC* (262*) or **Custom…**: MCC followed by up to 6 characters you type (e.g. MCC99 = 26299 for Germany).",
                values:
                  "Incoming RNs from the partner read that code as the country rate; rate notifications to the partner write country rates that way. Default MCC.",
              },
              {
                name: "Notice: increase",
                what: "How many days' notice the partner gets for rate increases. Used by rate notices and the rate tools to flag increases that start too early. The three notices sit on one line, last.",
                values: "0 to 90 days. Default 7.",
              },
              {
                name: "Notice: decrease / Notice: new destination",
                what: "The same for decreases and for destinations the partner had no rate for. Saves that start sooner ask for confirmation; incoming vendor RNs are flagged.",
                values: "0 to 90 days. Default 0 (no notice).",
              },
            ],
          },
          {
            kind: "fields",
            title: "Alerts",
            fields: [
              {
                name: "Bind alert",
                what: "Send an alert when one of the partner's trunks loses its binds (SMPP connections).",
                values: "Tick box. On by default.",
              },
              {
                name: "Credit alert",
                what: "Send alerts as the partner uses up its credit limit.",
                values:
                  "Tick box. Off by default; ticked automatically when a non-zero credit limit is saved on the Billing tab, and cleared when the limit is removed. You can still untick it.",
              },
              {
                name: "Notice at",
                what: "First credit alert level, as % of the credit limit used.",
                values: "1–100 %. Default 50.",
              },
              {
                name: "Warning at",
                what: "Second level. From here the credit use on the Billing tab turns amber.",
                values: "1–100 %. Default 70. Must be higher than Notice at.",
              },
              {
                name: "Critical at",
                what: "Third level. From here the credit use on the Billing tab turns red.",
                values: "1–100 %. Default 90. Must be higher than Warning at.",
              },
            ],
          },
          {
            kind: "fields",
            title: "Contacts (Commercial, Technical, Rates, Finance)",
            fields: [
              { name: "Name", what: "Contact person for that area.", values: "Optional, up to 200 characters." },
              { name: "Phone", what: "Contact phone number.", values: "Optional, e.g. `+44 20 7946 0000`." },
              {
                name: "Emails",
                what: "Where e-mails for that area go: commercial matters, technical (for example tech-info mails), rate sheets and notices, finance (invoices, statements). Required: at least one per contact.",
                values:
                  "One or more addresses, e.g. `noc@acme.example`. Pasting adds the address(es) at once, even a list such as `Name <a@b.com>; c@d.com`, so **Save** right after a paste keeps them.",
              },
            ],
          },
          {
            kind: "text",
            text: "Under the form a grey line shows when the enterprise was added and by whom, and when it was last updated (UTC) and by whom.",
          },
        ],
      },
      {
        id: "general-how",
        title: "General tab: how to edit and save",
        blocks: [
          {
            kind: "steps",
            items: [
              "Change the fields you need. The **Save** button becomes active as soon as something has changed.",
              "Click **Save**. Each save is one change in History and can be undone from the message that appears or from **History**.",
              "Click **Discard** to drop your edits and go back to the saved values.",
            ],
          },
          {
            kind: "text",
            text: "If something is missing, a banner says **Check the highlighted fields** with a count, and each problem field shows its message, e.g. **Required**, **At least one email** or **Levels must rise: notice < warning < critical**.",
          },
          {
            kind: "text",
            text: "While you add or edit a partner, the screen warns if another enterprise has the same name, VAT number or contact e-mail, so you do not create a duplicate.",
          },
          {
            kind: "warning",
            text: "You cannot change **Type** so that a side disappears while it still has trunks. For example, a Bilateral partner with 3 vendor trunks cannot become Customer until those vendor trunks are deleted.",
          },
          {
            kind: "tip",
            text: "If someone else saves the same enterprise (or a change is undone) while you have no unsaved edits, the form refreshes to the newest version by itself.",
          },
        ],
      },
      {
        id: "docs",
        title: "Docs tab",
        blocks: [
          {
            kind: "text",
            text: "Stores the partner's contracts, KYC (know-your-customer) papers and other files.",
          },
          {
            kind: "fields",
            title: "Document list columns",
            fields: [
              { name: "Name", what: "The document name: the file name without its extension." },
              { name: "File", what: "The original file name." },
              { name: "Size", what: "File size in B, KB or MB." },
              { name: "Uploaded by", what: "The user who uploaded it." },
              { name: "Uploaded (UTC)", what: "Upload date and time in UTC." },
              { name: "Download / Delete", what: "**Download** saves the file; **Delete** archives it." },
            ],
          },
          {
            kind: "steps",
            title: "How to upload documents",
            items: [
              "Click **Upload document** and pick one or more files, or drag files onto the drop area.",
              "Each file uploads on its own and a message confirms it.",
            ],
          },
          {
            kind: "steps",
            title: "How to delete a document",
            items: [
              "Click **Delete** on the row and confirm.",
              "The file is archived, not erased. Use **Undo** on the message or the **History** tab to bring it back.",
            ],
          },
          {
            kind: "warning",
            text: "Each file can be at most 10 MB. Larger or empty files are refused. On a deleted enterprise you can download files but not upload or delete them.",
          },
        ],
      },
      {
        id: "billing",
        title: "Billing tab",
        blocks: [
          {
            kind: "text",
            text: "Billing has one side per role: **Customer billing** for a customer, **Vendor billing** for a vendor, and both for a bilateral partner. Below them is **Beneficiary**, the partner's bank details. One **Save billing** saves the whole tab as one change.",
          },
          {
            kind: "text",
            text: "A side that has never been set up shows **No customer billing yet** (or vendor) and a **Set up customer billing** link. The link fills in starting values: the business company's currency, the first billing cycle, the enterprise's billing time zone, Postpaid with auto invoicing on (customer side), and an opening balance of 0. Nothing is stored until you click **Save billing**.",
          },
          {
            kind: "fields",
            title: "Customer billing / Vendor billing",
            fields: [
              {
                name: "Currency",
                what: "The currency the partner is billed in (customer side) or bills us in (vendor side). Required.",
                values: "Pick from the currency list, e.g. `EUR – Euro`. Fixed once invoices exist.",
              },
              {
                name: "Billing cycle",
                what: "How often invoices are made and when they are due.",
                values:
                  "Pick a cycle, e.g. `Monthly – Net 7`. Cycles are set up under [[billing-cycles|Billing cycles]].",
              },
              {
                name: "Time zone",
                what: "The time zone in which the billing period starts and ends for this side.",
                values: "Pick a time zone. Starts as the enterprise's billing time zone.",
              },
              {
                name: "Billing type",
                what: "Customer side only. **Postpaid**: the partner pays after use, up to a credit limit. **Prepaid**: the partner pays in advance.",
                values: "Postpaid or Prepaid.",
              },
              {
                name: "Credit limit",
                what: "Customer side, Postpaid only. How much the partner may owe. Credit alerts are measured against it.",
                values: "Amount in the side's currency, e.g. `5000`. Empty = no limit set.",
              },
              {
                name: "Opening balance",
                what: "The balance the partner starts with. Required.",
                values: "Positive = starts in credit, negative = starts owing. e.g. `-1250.00`.",
              },
              {
                name: "Balance",
                what: "Read-only, shown once the side is saved. Opening balance + payments − usage. Next to it: **in credit**, **owes us** (amber), **settled**, or on the vendor side **vendor in credit** / **we owe**. For Postpaid customers it also shows **% of credit limit used**, amber past the Warning level and red past the Critical level.",
              },
              {
                name: "Auto invoicing",
                what: "Customer side only. Create invoices automatically at the end of each billing cycle.",
                values: "Tick box. On by default.",
              },
              {
                name: "Send payment confirmation / Send payment",
                what: "The default for new payments: whether the payment e-mail is sent to the partner (a confirmation to a customer, the payment to a vendor). It can still be changed per payment.",
                values: "Tick box.",
              },
              { name: "Description", what: "Free notes about the billing arrangement.", values: "Optional text." },
            ],
          },
          {
            kind: "fields",
            title: "Beneficiary (bank details for payments to this partner)",
            fields: [
              { name: "Beneficiary name", what: "Name on the partner's bank account." },
              { name: "Bank", what: "Bank name." },
              { name: "Bank address", what: "Address of the bank branch." },
              { name: "Beneficiary address", what: "Address of the account holder." },
              { name: "Account number", what: "Bank account number." },
              {
                name: "IBAN",
                what: "International bank account number.",
                values: "e.g. `DE00 0000 0000 0000 0000 00` (fake).",
              },
              { name: "SWIFT / BIC", what: "The bank's SWIFT / BIC code." },
              { name: "Account currency", what: "Currency of the bank account.", values: "3-letter code, e.g. `USD`." },
              { name: "Crypto wallet", what: "Wallet address, for partners paid in crypto." },
            ],
          },
          {
            kind: "tip",
            text: "Each side shows when it was last updated and by whom, or **Not saved yet** for a side you just set up.",
          },
          {
            kind: "text",
            text: "Payments and invoices themselves are handled under Finance, for example [[transactions|Transactions]], [[invoices|Invoices]] and [[balances|Balances]].",
          },
        ],
      },
      {
        id: "trunk-tabs",
        title: "Customer trunks and Vendor trunks tabs",
        blocks: [
          {
            kind: "text",
            text: "These tabs list only this partner's trunks, with the same columns and per-column filters as the [[customer-trunks|Customer trunks]] and [[vendor-trunks|Vendor trunks]] pages (without the Enterprise column). **Show deleted** adds deleted trunks.",
          },
          {
            kind: "steps",
            items: [
              "Double-click a trunk (or select it and press **Enter**) to open it in its own tab.",
              "Click **New customer trunk** or **New vendor trunk** to add one. The new trunk form opens with this enterprise already filled in.",
            ],
          },
          {
            kind: "text",
            text: "Every trunk field is explained in [[trunk-record|Trunk record]].",
          },
        ],
      },
      {
        id: "account-managers",
        title: "Account managers tab and Hand over",
        blocks: [
          {
            kind: "text",
            text: "Lists every Account Manager the partner has had: **Account manager**, **From**, **Until** (UTC), **Note**, and a tag **Current** or **Scheduled**.",
          },
          {
            kind: "text",
            text: "Under it, **Partner Account Manager** shows the partner's own account manager on their side: the **Commercial** contact from the General tab, with name, phone and e-mails (click to write, copy icon to copy). Change it on the General tab.",
          },
          {
            kind: "fields",
            title: "Hand over dialog",
            fields: [
              {
                name: "New account manager",
                what: "The Account Manager who takes over. Required. The current Account Manager is not in the list.",
              },
              {
                name: "Effective",
                what: "**Now** hands over at once. **At a set time (UTC)** schedules it; pick the date and time, which cannot be in the past.",
              },
              { name: "Note", what: "Why the partner is handed over.", values: "Optional, up to 500 characters." },
              {
                name: "E-mail the client",
                what: "Sends the client an introduction from the new Account Manager: to the commercial contact (or the rates contact), both Account Managers in copy. The note can be used in the template as {note}.",
                values: "Ticked by default.",
              },
              {
                name: "Template",
                what: "Which **Account Manager Handover** e-mail template to use. Company default uses the business company's template. Write your own on [[email-templates|E-mail templates]] with {enterprise}, {old_am}, {new_am}, {new_am_email}, {effective_date} and {note}.",
              },
            ],
          },
          {
            kind: "steps",
            title: "How to hand a partner over",
            items: [
              "Open the **Account managers** tab. The General tab no longer shows the account manager.",
              "Click **Hand over**.",
              "Pick the **New account manager**, choose **Now** or a time, add a note.",
              "Click **Hand over now** or **Schedule handover**.",
            ],
          },
          {
            kind: "text",
            text: "Revenue, cost and margin from before the handover stay credited to the previous Account Manager. Reports split results by the Account Manager at the time each message was sent. A new scheduled handover replaces one that has not started yet. You can undo a handover from History until it takes effect.",
          },
        ],
      },
      {
        id: "notifications",
        title: "Notifications: send rates and tech info",
        blocks: [
          {
            kind: "text",
            text: "The **Notifications** button in the record header sends e-mails for all the enterprise's customer trunks at once. It is greyed out when the enterprise has no customer trunks.",
          },
          {
            kind: "fields",
            fields: [
              {
                name: "Send rates…",
                what: "E-mails the rate sheet of every customer trunk of the enterprise, as on the [[notifications|Notifications]] page (**Customer Send Rate Information**).",
                values: "Excel or CSV.",
              },
              {
                name: "Send tech info…",
                what: "Sends ONE e-mail with the connection details of every customer trunk, using the **Customer Tech Info** template. The placeholder {trunks} is replaced by every trunk's block; if the template has no {trunks}, the blocks are added after the body.",
              },
            ],
          },
        ],
      },
      {
        id: "history",
        title: "History tab",
        blocks: [
          {
            kind: "text",
            text: "Shows every saved change to this enterprise, newest first and grouped by day (Today, Yesterday, then the date). Each change has one line with the time (UTC), who saved it, what kind of change it was and its number, then one row per field: the old value in grey → the new value. See [[undo-and-history]].",
          },
          {
            kind: "list",
            items: [
              "List fields such as **Account managers** or e-mail lists show **+** for what was added, **−** for what was removed and **~** for an item that stayed but changed (for example an account manager period that now has an end date).",
              "A save that touched many fields shows the first six; click **Show all N fields** for the rest.",
              "**Undo** is on the changes you may undo: your own, and for administrators, directors and department managers those of the people they cover. See [[change-history]].",
            ],
          },
        ],
      },
      {
        id: "delete",
        title: "Deleting and restoring",
        blocks: [
          {
            kind: "text",
            text: "**Delete** archives the enterprise. It is blocked while there are live binds, unpaid or draft invoices, a customer or vendor balance that is not zero, or open disputes. It is also blocked while the enterprise has any customer or vendor trunk that is not deleted; these show in red and no administrator override is offered for them, so delete the trunks first. See [[enterprises#how-to-delete|How to delete an enterprise]] and [[safe-delete]].",
          },
          {
            kind: "warning",
            text: "A deleted enterprise is read-only: all forms, uploads and trunk buttons are off. Only an administrator can **Restore** it.",
          },
        ],
      },
      {
        id: "tips",
        title: "Tips and things to watch",
        blocks: [
          {
            kind: "tip",
            text: "Keep the four contact e-mails correct: rate notices, tech info, invoices and statements are sent to them.",
          },
          {
            kind: "tip",
            text: "If your visibility settings mask a partner, you may see it but not be allowed to save changes to it. See [[am-visibility]].",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ Customer trunks list
  {
    id: "customer-trunks",
    pageKey: "customer-trunks",
    title: "Customer trunks",
    group: "Enterprises",
    summary:
      "All customer trunks across all partners: the connections our customers bind to and send traffic on. Find, open, clone and delete them.",
    keywords: [
      "customer trunk",
      "client trunk",
      "ingress",
      "SMPP account",
      "system_id",
      "username",
      "bind",
      "TPS",
      "connection",
      "clone trunk",
      "bulk delete",
    ],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "A **customer trunk** is one connection a customer uses to send us messages: its login (username and password), the IP addresses it may connect from, its speed limit, and the rate tables that price its traffic. One customer can have many trunks, for example one per product category.",
          },
          {
            kind: "text",
            text: "NOC uses this page to find a trunk by username or name, Account Managers to check a customer's set-up, and admins to clone or delete trunks in bulk. The same list for one partner is on the [[enterprise-record#trunk-tabs|enterprise record]].",
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
              "**Undo** and **History**: your last change on customer trunks, and the full change history.",
              "**Export**: not active yet in the trial.",
              "**New customer trunk** (filled): opens an empty trunk form in a new tab.",
            ],
          },
          {
            kind: "fields",
            title: "Grid columns",
            fields: [
              { name: "ID", what: "Trunk number in the system." },
              {
                name: "Trunk Name",
                what: "The trunk's name, unique across trunks (deleted ones included).",
                values: "Convention `Partner_Category`, e.g. `ACME_OTP`.",
              },
              { name: "Enterprise", what: "The customer that owns the trunk." },
              { name: "UserName", what: "The SMPP login (system_id) the customer binds with." },
              { name: "Product Category", what: "The product the trunk sells, e.g. OTP, PROMO, DIRECT." },
              { name: "Protocol", what: "SMPP or HTTP." },
              { name: "TPS", what: "TPS (messages per second) allowed per session." },
              { name: "State", what: "Active or Inactive: whether the trunk may carry traffic." },
              {
                name: "Connection",
                what: "Whether the customer is bound now: green **Up** or red **Down**.",
              },
              { name: "Bind Type", what: "TX (send only), RX (receive only), TR (both) or AUTO." },
              {
                name: "Rules",
                what: "How many translation rules run on the trunk, in bold. Point at the number to see them by name.",
              },
              { name: "Hidden columns", what: "Updated By and Updated Time can be turned on from the columns menu." },
            ],
          },
          {
            kind: "list",
            title: "Detail panel (click a row; it opens on the right of the grid)",
            items: [
              "**General**: the Enterprise (click to open it), Username, Protocol, Bind type, TPS, Category and Rules running.",
              "At the bottom: ID, who updated it last (UTC), and **Deleted (archived)** in amber for a deleted trunk.",
            ],
          },
          {
            kind: "list",
            title: "Actions in the header",
            items: [
              "**Edit**, **Clone** and **Delete** act on the highlighted trunk. With several rows ticked, **Delete** acts on all of them.",
            ],
          },
          {
            kind: "text",
            text: "Filters, quick search, saved views and **Show deleted** work as on every list. Plain text in the quick search box matches the start of a value (`Colo` finds trunks starting with Colo); type `%colo` to find it anywhere. See [[grids-and-filters]].",
          },
        ],
      },
      {
        id: "how-to",
        title: "How to add, clone and open trunks",
        blocks: [
          {
            kind: "steps",
            title: "Add",
            items: [
              "Click **New customer trunk**.",
              "Pick the **Enterprise**, fill in the form and click **Add customer trunk**. See [[trunk-record|Trunk record]] for every field.",
            ],
          },
          {
            kind: "steps",
            title: "Clone",
            items: [
              "Highlight the trunk and click **Clone** in the header.",
              "A new form opens with every setting copied. The name becomes the old name plus `_copy`; **Username** and **Password** are empty.",
              "Change the name, enter a new username and password, adjust anything else, and click **Add customer trunk**.",
            ],
          },
          {
            kind: "steps",
            title: "Open",
            items: ["Double-click the row or press **Enter**. Hold **Ctrl** / **Cmd** to force a second tab."],
          },
        ],
      },
      {
        id: "bulk-delete",
        title: "How to delete one or many trunks",
        blocks: [
          {
            kind: "steps",
            items: [
              "For one trunk: row menu › **Delete…**.",
              "For many: tick the rows, then the header's **Delete N trunks…**. Deleted rows in the selection are skipped.",
              "The dialog checks each trunk and shows **can be deleted** or **blocked:** with the reason (for example live binds).",
              "Write a **Reason** if you like, then click **Delete N**. Blocked trunks are skipped unless an administrator ticks **Override the blockers** and writes a reason.",
            ],
          },
          {
            kind: "text",
            text: "Each deleted trunk is archived: it leaves routing and pickers at once but stays in reports. It drops out of route rules that name it; its rate tables stay, only the link goes. Each delete is its own change, so each can be undone from History. See [[safe-delete]].",
          },
          {
            kind: "warning",
            text: "Only an administrator can restore a deleted trunk. A trunk cannot be restored while its enterprise is deleted, or while another live trunk uses the same username.",
          },
        ],
      },
      {
        id: "tips",
        title: "Tips",
        blocks: [
          {
            kind: "tip",
            text: "To send a customer its connection details or rate sheet by e-mail, use the [[notifications|Notifications]] page (**Send Tech Info**, **Send Rate**).",
          },
          {
            kind: "tip",
            text: "Live sessions per trunk are on [[network-status|Network status]].",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ Vendor trunks list
  {
    id: "vendor-trunks",
    pageKey: "vendor-trunks",
    title: "Vendor trunks",
    group: "Enterprises",
    summary:
      "All vendor trunks across all partners: the connections we bind to and send traffic to. Find, open, clone and delete them.",
    keywords: [
      "vendor trunk",
      "supplier trunk",
      "egress",
      "route",
      "SMPP client",
      "buy rate",
      "host",
      "clone trunk",
      "bulk delete",
    ],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "A **vendor trunk** is one connection we open to a vendor to send messages: the vendor's host and port, our login, speed limits, which kinds of message the vendor accepts, and its own buy rate table. Route rules pick vendor trunks to send each message to.",
          },
          {
            kind: "text",
            text: "NOC uses this page to find and check vendor connections; routing and rates staff use it to reach a vendor's buy rates.",
          },
        ],
      },
      {
        id: "layout",
        title: "What you see on the page",
        blocks: [
          {
            kind: "text",
            text: "The page works like [[customer-trunks|Customer trunks]]: **Undo**, **History**, **Export** (not active yet) and **New vendor trunk** in the header; per-column filters; quick search matching the start of a value (type `%text` to find it anywhere); detail panel on the right; row menu with **Open**, **Clone…** and **Delete…**; and the header actions with **Clone…** (one trunk) and **Delete N trunks…**.",
          },
          {
            kind: "fields",
            title: "Grid columns",
            fields: [
              { name: "ID", what: "Trunk number in the system." },
              { name: "Trunk Name", what: "The trunk's name, unique across trunks." },
              { name: "Enterprise", what: "The vendor that owns the trunk." },
              { name: "UserName", what: "Our login (system_id) at the vendor." },
              { name: "Product Category", what: "The quality / product class of the route, e.g. DIRECT, SIM, WHS." },
              {
                name: "Protocol",
                what: "SMPP, HTTP or Service. A service trunk sends nothing to a network: routed to it, the message is ended by the switch and the client gets the receipt set on the trunk (Receipt status, after Receipt after seconds; 0 = at once). One outcome per trunk: add a trunk for each outcome you need (delivered, undelivered, rejected, expired…). It has no connection, so it never shows as down.",
              },
              { name: "TPS", what: "TPS (messages per second) we send per session." },
              { name: "State", what: "Active or Inactive: whether the trunk may carry traffic." },
              {
                name: "Connection",
                what: "Our bind to the vendor now: green **Up** (all sessions bound), orange **Reconnecting** (some sessions missing, or down for less than the trunk's **Bind down alert after** time while we retry) or red **Down**.",
              },
              { name: "Bind Type", what: "TX, RX or TR." },
              {
                name: "Rules",
                what: "How many translation rules run on the trunk, in bold. Point at the number to see them by name.",
              },
              {
                name: "Hidden columns",
                what: "Host, Updated By and Updated Time can be turned on from the columns menu.",
              },
            ],
          },
        ],
      },
      {
        id: "how-to",
        title: "How to add, clone and delete",
        blocks: [
          {
            kind: "steps",
            title: "Add",
            items: [
              "Click **New vendor trunk**, pick the **Enterprise** and fill in the form. See [[trunk-record|Trunk record]].",
              "Click **Add vendor trunk**. The trunk gets its own empty buy rate table, which you fill in on its **Rates** tab or in [[rate-manager|Rate manager]].",
            ],
          },
          {
            kind: "steps",
            title: "Clone",
            items: [
              "Highlight the trunk and click **Clone** in the header.",
              "Everything is copied except the name (gets `_copy`), username and password. Fill those in and click **Add vendor trunk**.",
            ],
          },
          {
            kind: "steps",
            title: "Delete",
            items: [
              "Highlight the trunk and click **Delete** in the header; for several, tick them first.",
              "The check lists route rules sending to the trunk (routing skips it from now on), customer trunks using it as express vendor (they fall back to normal routing), its own buy rate table (kept with full history) and rules attached directly.",
              "Live binds block the delete. Click **Delete** to archive.",
            ],
          },
          {
            kind: "warning",
            text: "Deleting a vendor trunk takes it out of routing at once. Check the route rules that send to it first, so traffic does not lose its only route.",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ Trunk record
  {
    id: "trunk-record",
    title: "Trunk record",
    group: "Enterprises",
    summary:
      "The single trunk screen for customer and vendor trunks: connection, SMPP or HTTP settings, receipts, routing options, capacity and limits, rate tables, buy rates, rules and history.",
    keywords: [
      "trunk",
      "customer trunk",
      "vendor trunk",
      "SMPP",
      "HTTP",
      "bind",
      "system_id",
      "password",
      "host IP",
      "IP whitelist",
      "TPS",
      "sessions",
      "max connections",
      "DLR",
      "delivery receipt",
      "session affinity",
      "rate table",
      "express vendor",
      "express margin",
      "revenue limit",
      "cost limit",
      "TON",
      "NPI",
      "auto TON / NPI",
      "data coding",
      "window size",
      "enquire link",
      "translation rules",
      "HLR rules",
      "clone",
      "tech info",
    ],
    sections: [
      {
        id: "overview",
        title: "What this screen is for",
        blocks: [
          {
            kind: "text",
            text: "The trunk record holds every setting of one trunk. A **customer trunk** is what a customer binds to us with; a **vendor trunk** is how we bind to a vendor. Both use the same screen; some sections differ, as marked below.",
          },
          {
            kind: "text",
            text: "It opens in its own tab from the trunk lists, from an enterprise's trunk tabs, or from **New customer trunk** / **New vendor trunk**.",
          },
        ],
      },
      {
        id: "layout",
        title: "What you see on the screen",
        blocks: [
          {
            kind: "list",
            title: "Header",
            items: [
              "**Clone**: opens a new trunk form with all settings copied (see below).",
              "**Delete**: starts the safe delete check (hidden if the trunk is already deleted).",
              "The filled button changes with the tab: **Add customer trunk** / **Add vendor trunk** / **Save** on General, **Save rules** on Rules. **Discard** appears when you have unsaved edits.",
            ],
          },
          {
            kind: "text",
            text: "A grey line under the header sums up the trunk: kind, enterprise, protocol, TPS and status. A deleted trunk shows a banner and cannot be edited until restored.",
          },
          {
            kind: "list",
            title: "Tabs",
            items: [
              "**General**: the trunk form.",
              "**Rates**: vendor trunks only. The trunk's own buy rate table.",
              "**Rules**: translation rules (and on customer trunks HLR rules) that run on this trunk, plus a test.",
              "**History**: every saved change to the trunk, with undo.",
            ],
          },
          {
            kind: "text",
            text: "On a new trunk only **General** is open. The status bar shows the trunk kind, ID and enterprise.",
          },
        ],
      },
      {
        id: "top-fields",
        title: "Top of the form (both kinds)",
        blocks: [
          {
            kind: "fields",
            fields: [
              {
                name: "Enterprise",
                what: "The partner that owns the trunk. Required. On a new trunk, pick it with the searchable picker (it is already filled when you start from an enterprise). After saving it is fixed and shown as a link: a trunk cannot move to another enterprise; clone it instead.",
                values:
                  "A customer trunk needs a Customer or Bilateral enterprise; a vendor trunk needs a Vendor or Bilateral one. A deleted enterprise cannot get new trunks.",
              },
              { name: "Trunk ID", what: "The trunk's number. Shown after saving." },
              {
                name: "Buy rate table",
                what: "Vendor trunks only. Every vendor trunk owns one rate table with its buy rates. Click it to open it in Rate manager.",
              },
            ],
          },
        ],
      },
      {
        id: "trunk-fields",
        title: "Trunk section (both kinds)",
        blocks: [
          {
            kind: "fields",
            fields: [
              {
                name: "Trunk name",
                what: "The trunk's name. Required. Unique across all trunks, deleted ones included.",
                values: "Up to 100 characters. Convention `Partner_Category`, e.g. `ACME_OTP`.",
              },
              {
                name: "Protocol",
                what: "How messages are exchanged. On vendor trunks, HTTP replaces the **SMPP session** section with the **HTTP API** section.",
                values: "SMPP (default) or HTTP.",
              },
              {
                name: "Product category",
                what: "The product class of the trunk, e.g. OTP, PROMO, DIRECT, SIM. Used in routing and reports. Required on vendor trunks, optional on customer trunks.",
                values: "Pick from the product category list (kept under [[categories|Product categories]]).",
              },
              {
                name: "Billing type",
                what: "The event that makes a message billable. Required.",
                values:
                  "**Submit** (default): when the message is accepted. **Delivery**: only when a delivered receipt comes back. **Reported**: when any receipt comes back. **Attempt**: every attempt.",
              },
              {
                name: "Status",
                what: "Active or Inactive. An inactive trunk carries no traffic.",
                values: "Default Active.",
              },
              {
                name: "Bind type",
                what: "Which kind of SMPP connection is used. TX sends only, RX receives only (receipts, MO), TR does both on one connection.",
                values:
                  "TX, RX, TR (default). Customer trunks also allow **AUTO** (accept whatever the customer binds as).",
              },
              {
                name: "Billing time zone",
                what: "Day and month totals in the Enterprise report are cut at midnight in this zone.",
                values: "Leave empty to use the enterprise's time zone.",
              },
            ],
          },
        ],
      },
      {
        id: "customer-connection",
        title: "Customer trunk: Connection (what the client binds with)",
        blocks: [
          {
            kind: "fields",
            fields: [
              {
                name: "Allowed host IPs",
                what: "The IP addresses the customer may connect from. Binds from any other address are refused. Required: at least one.",
                values: "One or more IPv4 or IPv6 addresses, e.g. `10.0.0.5`, `2001:db8::1`.",
              },
              {
                name: "Username (system_id)",
                what: "The SMPP login the customer binds with. Required. Unique across all customer trunks, deleted ones included.",
                values: "Up to 16 characters, e.g. `acme_otp`.",
              },
              {
                name: "Password",
                what: "The SMPP password. Required for a new trunk. Never shown again after saving: an existing trunk shows `•••••••• (set; type to change)`. Leave it empty to keep the current password.",
                values: "Up to 9 characters (SMPP limit).",
              },
              {
                name: "Port",
                what: "The port the customer connects to. Not typed in: it follows SSL, and Send Tech Info sends it.",
                values: "`2775` when SSL is None, `2776` for any TLS.",
              },
              {
                name: "Max connections",
                what: "How many sessions (binds) the customer may open at the same time. Required.",
                values: "1–10. Default 2.",
              },
              {
                name: "System type",
                what: "The SMPP system_type the customer is expected to send in its bind.",
                values: "Optional, up to 13 characters.",
              },
              {
                name: "SSL",
                what: "Whether the connection is encrypted.",
                values: "None (default), TLS 1.2 or TLS 1.3.",
              },
            ],
          },
        ],
      },
      {
        id: "customer-receipts",
        title: "Customer trunk: Delivery receipts",
        blocks: [
          {
            kind: "text",
            text: "A delivery receipt (DLR) tells the customer whether its message arrived. The rule is to answer on the same session and IP that sent the message, so a customer with several binds never gets a receipt on a connection it did not use.",
          },
          {
            kind: "fields",
            fields: [
              {
                name: "Receipt routing",
                what: "Which session gets a receipt first. Receipts go at once on the session the message came from; if it is gone, on another bound receiver session of the trunk, else they wait until the customer binds again. This setting only picks which session is tried first.",
                values:
                  "**Same session only (hold)** (default), **Any session from the same IP**, **Any session of the trunk**.",
              },
              {
                name: "Hold receipts for",
                what: "How long a receipt waits for the customer to bind again before it is dropped.",
                values: "0–720 hours. Default 72.",
              },
              {
                name: "DLR push URL",
                what: "For HTTP customers: the address we send receipts to.",
                values: "A full URL, e.g. `https://hooks.acme.example/dlr`.",
              },
              {
                name: "MO push URL",
                what: "For HTTP customers: the address we send incoming (MO, mobile-originated) messages to.",
                values: "A full URL.",
              },
              {
                name: "Delayed submit",
                what: "When on, we confirm a message to the customer (submit_sm_resp) only after the vendor has accepted it.",
                values: "Tick box. Off by default.",
              },
              { name: "Send bind", what: "Notify the customer of bind events.", values: "Tick box. Off by default." },
            ],
          },
        ],
      },
      {
        id: "customer-routing",
        title: "Customer trunk: Routing",
        blocks: [
          {
            kind: "fields",
            fields: [
              {
                name: "Consider HLR rate",
                what: "Add the cost of the number lookup (HLR) to what the customer is charged.",
                values: "Tick box. Off by default.",
              },
              {
                name: "Service type routing",
                what: "Use the SMPP service_type the customer sends as an extra key when route rules are matched.",
                values: "Tick box. Off by default.",
              },
              {
                name: "Part-wise routing",
                what: "Route each part of a long (multipart) message on its own instead of keeping all parts together.",
                values: "Tick box. Off by default.",
              },
              {
                name: "Loop detection",
                what: "Block messages that come back into the switch, so a message cannot circle between partners.",
                values: "Tick box. On by default.",
              },
              {
                name: "Default data coding",
                what: "How text is read when the customer sends data coding 0.",
                values: "**0 – SMSC default (GSM 7-bit)** (default) or **3 – Latin-1**.",
              },
              {
                name: "TON / NPI",
                what: "Whether the sender's and receiver's type of number (TON) and numbering plan (NPI) go on as the customer sent them, or are set from the addresses after this trunk's translation rules. Auto: an alphanumeric sender gets 5 / 0; a sender with + or of 9 or more digits 1 / 1 (the + taken off); a short code of 3–8 digits 3 / 0; a full international receiver (8–15 digits) 1 / 1. A TON or NPI a translation rule sets is kept. Auto cannot shorten a sender: one over 11 characters is still refused (0x0A).",
                values: "**As sent** (default) or **Auto (fix after translation)**.",
              },
              {
                name: "Express vendor trunk",
                what: "Pins the trunk to one vendor trunk. Every message skips route rules and goes straight to this vendor.",
                values: "Search and pick a vendor trunk, or leave **None – route normally**.",
              },
              {
                name: "Express margin",
                what: "Shown only when an express vendor trunk is set. The % added on the express vendor's cost for every message.",
                values: "A percentage, 0–1000, e.g. `10` for 10 %.",
              },
            ],
          },
          {
            kind: "warning",
            text: "An express vendor trunk overrides all route rules for this customer trunk. If that vendor trunk is deleted, the customer trunk falls back to normal routing.",
          },
        ],
      },
      {
        id: "customer-capacity",
        title: "Customer trunk: Capacity and limits, Pricing",
        blocks: [
          {
            kind: "fields",
            title: "Capacity and limits",
            fields: [
              {
                name: "TPS per session",
                what: "Maximum messages per second on each session. Required. The hint shows the trunk total: TPS per session × Max connections, e.g. 50 × 2 sessions = 100 TPS.",
                values: "1–100,000. Default 50.",
              },
              {
                name: "Overflow buffer",
                what: "How many messages can wait in a queue when the customer sends faster than its TPS.",
                values: "Messages, default 10,000.",
              },
              {
                name: "Revenue limit",
                what: "Traffic stops when the trunk's revenue reaches this amount in the period.",
                values: "An amount, or empty for no limit.",
              },
              {
                name: "Limit period",
                what: "The period the revenue limit counts over. It resets automatically.",
                values:
                  "Per hour, Per day, Per week, Per month or Per billing cycle. Set both limit and period, or neither.",
              },
            ],
          },
          {
            kind: "fields",
            title: "Pricing",
            fields: [
              {
                name: "Rate tables",
                what: "The customer rate tables that price this trunk's traffic, in order. For each message, the first table that has a rate for the destination sets the price.",
                values:
                  "Use **Add a customer rate table…** to search and add one (only live customer tables are offered; each shows its category and number of rates), or **Create new rate table** to make a new customer table on the spot (named after the trunk with its product category filled in; it is added at the end). Drag a row by ⠿ to change the order, or use ↑ and ↓ (Alt+↑ / Alt+↓ on a focused row); x removes one. A table can be listed only once.",
              },
            ],
          },
          {
            kind: "tip",
            text: "Put specific tables (for example a special deal for a few destinations) above the general price list, because the first match wins.",
          },
        ],
      },
      {
        id: "vendor-connection",
        title: "Vendor trunk: Connection (how we bind to the vendor)",
        blocks: [
          {
            kind: "fields",
            fields: [
              {
                name: "Host",
                what: "The vendor's server address we connect to. Required.",
                values: "Host name or IP, e.g. `smpp.vendor.example` or `10.0.0.5`. Up to 255 characters.",
              },
              { name: "Port", what: "The vendor's port. Required.", values: "1–65535. Default `2775`." },
              {
                name: "Source IP",
                what: "Our own address the bind comes from (when the vendor allows only certain IPs).",
                values: "Optional; must be a valid IP address.",
              },
              {
                name: "Username (system_id)",
                what: "Our login at the vendor. Required.",
                values: "Up to 16 characters.",
              },
              {
                name: "Password",
                what: "Our password at the vendor. Required for a new trunk; never shown again after saving. Leave empty to keep it.",
                values: "Up to 9 characters.",
              },
              {
                name: "Max connections",
                what: "How many sessions we open to the vendor. Required.",
                values: "1–10. Default 2.",
              },
              {
                name: "System type",
                what: "SMPP system_type we send in the bind.",
                values: "Optional, up to 13 characters.",
              },
              {
                name: "Service type",
                what: "SMPP service_type we send with messages.",
                values: "Optional, up to 6 characters.",
              },
              { name: "SSL", what: "Encryption of the connection.", values: "None (default), TLS 1.2 or TLS 1.3." },
            ],
          },
        ],
      },
      {
        id: "vendor-smpp",
        title: "Vendor trunk: SMPP session (protocol SMPP)",
        blocks: [
          {
            kind: "fields",
            fields: [
              {
                name: "Window size",
                what: "How many messages may be sent before the vendor has answered the earlier ones.",
                values: "1–1000. Default 10.",
              },
              {
                name: "Submit interval",
                what: "A pause between messages sent to the vendor.",
                values: "Milliseconds. Default 0 (no pause).",
              },
              {
                name: "Submit timeout",
                what: "How long we wait for the vendor to accept a message before treating it as failed.",
                values: "Seconds. Default 30.",
              },
              {
                name: "Enquire link every",
                what: "How often an idle session sends the keep-alive check (enquire_link).",
                values: "Seconds, 5–3600. Default 30.",
              },
              {
                name: "Enquire link response",
                what: "How long we wait for the answer to enquire_link. No answer in time drops the session, which is then retried on the reconnect schedule.",
                values: "Seconds. Default 30.",
              },
              {
                name: "Reconnect after",
                what: "Seconds before each new bind attempt after a session drops or a bind is refused. The last value repeats until the bind is up or the trunk is stopped. An active trunk binds all its Max connections sessions when it is activated or saved, and keeps them up.",
                values: "A list, e.g. `5, 10, 30, 60` (default): 5 s, 10 s, 30 s, then every 60 s.",
              },
              {
                name: "Bind down alert after",
                what: "The Bind Down Alert goes out, and Connection turns red **Down**, only after the trunk has had no bound session this long, so short reconnects make no noise. A refused login (wrong password or system ID) alerts at once.",
                values: "Minutes. Default 2.",
              },
              {
                name: "Retry after wrong login",
                what: "After the vendor refuses the bind for a wrong password or system ID, wait this long before trying again: retrying quickly won't fix it and can lock the account. Saving the trunk (e.g. with new credentials) tries again at once.",
                values: "Minutes. Default 15.",
              },
              {
                name: "Message ID type",
                what: "How the vendor writes its message IDs, so receipts can be matched to messages.",
                values: "Default, Decimal or Hexadecimal.",
              },
              {
                name: "Bind address TON",
                what: "addr_ton sent in the bind (type of number).",
                values: "0–6. Default 0.",
              },
              {
                name: "Bind address NPI",
                what: "addr_npi sent in the bind (numbering plan).",
                values: "0–18. Default 0.",
              },
              {
                name: "Bind address range",
                what: "address_range sent in the bind.",
                values: "Optional, up to 41 characters.",
              },
            ],
          },
        ],
      },
      {
        id: "vendor-http",
        title: "Vendor trunk: HTTP API (protocol HTTP)",
        blocks: [
          {
            kind: "text",
            text: "For vendors with a web API instead of SMPP. We send each message as an HTTP request built from a template, and read the answer and the receipts with regular expressions (search patterns).",
          },
          {
            kind: "fields",
            fields: [
              {
                name: "Submit URL",
                what: "The address we send messages to. Required for an HTTP trunk.",
                values: "e.g. `https://api.vendor.example/send`.",
              },
              {
                name: "Success regex",
                what: "A pattern that, when found in the vendor's answer, means the message was accepted.",
                values: 'e.g. `"status":"ok"`. Must be a valid regular expression.',
              },
              {
                name: "Message ID regex",
                what: "A pattern that picks the vendor's message ID out of the answer.",
                values: 'e.g. `"id":"([^"]+)"`.',
              },
              {
                name: "Receiver port",
                what: "The port on our side that receives the vendor's callbacks.",
                values: "1–65535.",
              },
              {
                name: "Extra headers",
                what: "Extra HTTP headers sent with each message.",
                values: "One per line, `Header: value`.",
              },
              {
                name: "POST body",
                what: "The request body template. Placeholders are filled in per message.",
                values: 'e.g. `{"to":"{dst}","from":"{src}","text":"{text}"}`.',
              },
              { name: "Receipt callback URL", what: "The address the vendor sends receipts to." },
              { name: "Callback interval", what: "How often receipts are collected, in seconds." },
              { name: "Receipt status regex", what: "Pattern that picks the status out of a receipt callback." },
              {
                name: "Receipt message ID regex",
                what: "Pattern that picks the message ID out of a receipt callback.",
              },
              {
                name: "Success statuses",
                what: "Receipt statuses that mean delivered.",
                values: "Comma separated, e.g. `DELIVRD,DELIVERED`.",
              },
              {
                name: "Failure statuses",
                what: "Receipt statuses that mean failed.",
                values: "Comma separated, e.g. `UNDELIV,REJECTD`.",
              },
              { name: "Callback extra headers", what: "Headers expected or sent with receipt callbacks." },
              { name: "Callback POST body", what: "Template of the receipt callback body." },
            ],
          },
        ],
      },
      {
        id: "vendor-messages",
        title: "Vendor trunk: Messages",
        blocks: [
          {
            kind: "text",
            text: "These settings describe what the vendor accepts. Routing skips a vendor trunk that cannot take a message.",
          },
          {
            kind: "fields",
            fields: [
              {
                name: "Allowed data codings",
                what: "Text encodings the vendor accepts (0 = GSM 7-bit, 3 = Latin-1, 8 = Unicode, and others).",
                values: "**Any** (no restriction), or tick any of 0, 1, 2, 3, 4, 5, 6, 7, 8, 13, 14. Default Any.",
              },
              {
                name: "Re-route on receipt status",
                what: "Failed receipts with these statuses are retried on the next vendor in the route.",
                values: "Tick any of EXPIRED, UNDELIV, REJECTD, UNKNOWN. None by default.",
              },
              {
                name: "Allowed source TON",
                what: "Sender number types the vendor accepts (TON = type of number: 0 unknown, 1 international, 2 national, 5 alphanumeric…).",
                values: "**Any**, or tick 0–6. Default Any.",
              },
              {
                name: "Allowed destination TON",
                what: "Receiver number types the vendor accepts.",
                values: "**Any**, or tick 0–6. Default Any.",
              },
              {
                name: "Allowed source NPI",
                what: "Sender numbering plans the vendor accepts (NPI = numbering plan indicator: 0 unknown, 1 ISDN/E.164…).",
                values: "**Any**, or tick 0, 1, 3, 4, 6, 8, 9, 10, 14, 18. Default Any.",
              },
              {
                name: "Allowed destination NPI",
                what: "Receiver numbering plans the vendor accepts.",
                values: "**Any**, or tick 0, 1, 3, 4, 6, 8, 9, 10, 14, 18. Default Any.",
              },
              {
                name: "TON / NPI",
                what: "As sent, or set from the addresses after this vendor trunk's translation rules, the same way as on a customer trunk (see Customer trunk: Routing). The allowed TON / NPI above, the sender check and what the vendor is sent all use the values set: with Auto, a vendor that takes destination TON 1 only also gets a full international number sent with TON 0. A sender Auto cannot fix (over 11 characters) still passes the vendor over.",
                values: "**As sent** (default) or **Auto (fix after translation)**.",
              },
              {
                name: "Max message length",
                what: "The longest message the vendor takes.",
                values: "Empty = **Any** length, or 1–2000 characters. Default Any.",
              },
              {
                name: "Supports multipart",
                what: "The vendor accepts long messages sent in several parts.",
                values: "Tick box. On by default.",
              },
              {
                name: "Receipt timeout",
                what: "How long we wait for a receipt from the vendor.",
                values: "Seconds. Default 172800 (48 hours).",
              },
              {
                name: "Status on receipt timeout",
                what: "The status recorded when no receipt arrives in time.",
                values: "DELIVRD, EXPIRED, UNDELIV, REJECTD or UNKNOWN (default).",
              },
              {
                name: "Receipt timeout applies to",
                what: "The destinations the receipt timeout and its status apply to. Messages to other destinations wait the default 48 hours, then get UNKNOWN.",
                values: "Every destination (default), or countries and networks picked in the tree.",
              },
            ],
          },
        ],
      },
      {
        id: "vendor-capacity",
        title: "Vendor trunk: Capacity and limits",
        blocks: [
          {
            kind: "fields",
            fields: [
              {
                name: "TPS per session",
                what: "Maximum messages per second we send on each session. The hint shows the trunk total (TPS × Max connections).",
                values: "1–100,000. Default 50.",
              },
              {
                name: "Overflow buffer",
                what: "Messages that can queue when traffic is faster than the TPS.",
                values: "Default 10,000.",
              },
              {
                name: "Cost limit",
                what: "Traffic to this vendor stops when the cost reaches this amount in the period.",
                values: "An amount, or empty for no limit.",
              },
              {
                name: "Limit period",
                what: "The period the cost limit counts over.",
                values: "Per hour, Per day, Per week, Per month or Per billing cycle. Set both or neither.",
              },
            ],
          },
        ],
      },
      {
        id: "rates-tab",
        title: "Rates tab (vendor trunks)",
        blocks: [
          {
            kind: "text",
            text: "Shows the vendor trunk's own buy rate table, the same view as in [[rate-manager|Rate manager]]: current, scheduled and closed rates and the change log. You can edit rates here; one save is one change that can be undone.",
          },
          {
            kind: "tip",
            text: "Vendor rate notices (RNs) are handled on the incoming RN page and never re-rate traffic that was already sent.",
          },
        ],
      },
      {
        id: "rules-tab",
        title: "Rules tab",
        blocks: [
          {
            kind: "text",
            text: "Lists every rule that runs on this trunk: **Translation rules** (rewrite or block messages) on both kinds, and **HLR rules** (number lookups) on customer trunks. Rules run top to bottom.",
          },
          {
            kind: "fields",
            title: "Rule table columns",
            fields: [
              { name: "#", what: "Run order on this trunk." },
              { name: "Rule", what: "Rule name. Tags show **Rule inactive** or **Removed on save**." },
              {
                name: "Applies through",
                what: "Why the rule reaches this trunk: **Direct** (attached to this trunk), **Enterprise**, **Category** or **All trunks**.",
              },
              { name: "Does", what: "A short description of what the rule does." },
              { name: "On", what: "Untick to switch the rule off for this trunk only." },
              {
                name: "Continue",
                what: "Translation rules only. When ticked, the next rule also runs after this one matches.",
              },
              {
                name: "⠿ / Remove",
                what: "Drag the handle to change the order (or Alt+↑ / Alt+↓ on a focused row). The bin (**Remove**) takes a rule attached to this trunk directly off it on save; click it again to keep the rule. A rule that reaches the trunk through its enterprise, category or all trunks cannot be removed here: untick **On** to stop it on this trunk, or change the rule's trunks.",
              },
            ],
          },
          {
            kind: "steps",
            title: "How to change the rules on a trunk",
            items: [
              "Drag rules to reorder them (translation and HLR rules sit side by side), tick or untick **On** and **Continue**, or click the bin to remove a direct rule.",
              "Click **Save rules**. **Discard** drops your edits.",
            ],
          },
          {
            kind: "text",
            text: "Order, on/off and continue belong to this trunk only. To change where an inherited rule applies, edit the rule itself on [[translation-rules|Translation rules]] or [[hlr|HLR]].",
          },
          {
            kind: "fields",
            title: "Test",
            fields: [
              { name: "Sender ID", what: "Sample sender.", values: "e.g. `ACME`." },
              { name: "Receiver", what: "Sample receiver number. Required.", values: "e.g. `00447700900123`." },
              { name: "Sender TON / Sender NPI", what: "Sample type of number and numbering plan." },
              { name: "Text", what: "Sample message text." },
              {
                name: "Vendor DLR stat",
                what: "A receipt status to test receipt rules with.",
                values: "e.g. `UNDELIV`.",
              },
            ],
          },
          {
            kind: "tip",
            text: "**Run** sends the sample through the saved rules (and HLR rules on customer trunks) and shows what each rule did. Save your changes first to test them.",
          },
        ],
      },
      {
        id: "how-to-add",
        title: "How to add a trunk",
        blocks: [
          {
            kind: "steps",
            items: [
              "Open the enterprise and go to **Customer trunks** or **Vendor trunks**, then click **New customer trunk** / **New vendor trunk**. (Or start from the trunk list and pick the **Enterprise** yourself.)",
              "Fill in **Trunk name**, **Username (system_id)** and **Password**.",
              "Customer trunk: add at least one **Allowed host IPs** address and add the **Rate tables**.",
              "Vendor trunk: fill in **Host**, **Product category** and, for HTTP, the **Submit URL**.",
              "Check **Max connections** and **TPS per session** (defaults 2 sessions × 50 TPS).",
              "Click **Add customer trunk** / **Add vendor trunk**. The **Rules** and **History** tabs (and **Rates** on a vendor trunk) open up.",
            ],
          },
        ],
      },
      {
        id: "how-to-clone",
        title: "How to clone a trunk",
        blocks: [
          {
            kind: "steps",
            items: [
              "Open the trunk and click **Clone** (or use **Clone…** in the trunk list).",
              "A new form opens titled **(clone of #ID)** with every setting copied, including IPs, limits and rate tables.",
              "The name becomes the original name plus `_copy`. **Username** and **Password** are empty: enter new ones.",
              "To move a trunk to another enterprise, pick the new **Enterprise** here.",
              "Click **Add customer trunk** / **Add vendor trunk**. Then delete the old trunk if it is no longer needed.",
            ],
          },
        ],
      },
      {
        id: "how-to-delete",
        title: "How to delete a trunk",
        blocks: [
          {
            kind: "text",
            text: "Click **Delete** in the header. The check shows live binds (blocking), route rules that use it, rate tables attached (customer) or its own buy rate table (vendor), customer trunks using it as express vendor (vendor) and rules attached directly. The trunk is archived, not erased. To delete many at once use the header actions on the [[customer-trunks|Customer trunks]] or [[vendor-trunks|Vendor trunks]] list. See [[safe-delete]].",
          },
        ],
      },
      {
        id: "tech-info",
        title: "Sending tech info by e-mail",
        blocks: [
          {
            kind: "text",
            text: "Tech info is an e-mail to the customer with its connection details (our SMPP address and port, its username and settings). Send it from the [[notifications|Notifications]] page: select one or more customer trunks and choose **Send Tech Info**. A preview shows the recipients (up to three addresses from the enterprise's Technical and Commercial contacts), the subject and the text before you click **Send**. The text comes from the **Customer Tech Info** e-mail template and can include the host, port, username, bind type, allowed IPs, TPS and number of connections. Every e-mail sent is listed in [[email-logs|Email logs]].",
          },
          {
            kind: "warning",
            text: "Read the preview before you click **Send**: it shows exactly what the customer gets. If the preview shows **no contact**, add a Technical or Commercial e-mail on the enterprise first.",
          },
          {
            kind: "tip",
            text: "To send one e-mail with the details of every customer trunk of a partner, use **Notifications › Send tech info…** on the enterprise record ([[enterprise-record#notifications]]).",
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
              "A customer binds with **Username (system_id)** and **Password** from one of the **Allowed host IPs**, up to **Max connections** sessions.",
              "Each message is checked against the trunk's translation and HLR rules, then priced with the first matching **Rate tables** entry and routed by route rules (or sent straight to the **Express vendor trunk**).",
              "The chosen vendor trunk must accept the message (data coding, TON/NPI, length, multipart); otherwise routing skips it.",
              "Replies always go back on the session that sent the request. Receipts follow **Receipt routing** and wait up to **Hold receipts for** when the customer is not bound.",
              "Revenue and cost limits stop traffic when reached in their period.",
              "Each save is one change in History, with undo. The password is recorded without its value, so undo cannot bring back an old password.",
            ],
          },
          {
            kind: "tip",
            text: "In the trial no real SMPP or HTTP traffic flows: binds, receipts and limits are simulated.",
          },
        ],
      },
      {
        id: "tips",
        title: "Tips and things to watch",
        blocks: [
          {
            kind: "warning",
            text: "Validation on save: trunk name and customer username must be unique (deleted trunks count); host IPs and source IP must be real IP addresses; HTTP regex fields must be valid patterns; a limit needs both an amount and a period.",
          },
          {
            kind: "tip",
            text: "If a save fails, a banner says **Check the highlighted fields** and each field shows its problem.",
          },
          {
            kind: "text",
            text: "Related: [[network-status|Network status]] (live sessions), [[route-rules|Route rules]], [[rate-manager|Rate manager]], [[enterprise-record|Enterprise record]].",
          },
        ],
      },
    ],
  },
];
