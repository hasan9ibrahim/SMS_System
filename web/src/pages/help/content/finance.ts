// Help center: Finance (§7, §12.3, §13.29, §13.31, §13.33).
import type { HelpTopic } from "../helpTypes";

export const topics: HelpTopic[] = [
  // ------------------------------------------------------------------ concept
  {
    id: "billing-basics",
    title: "How billing works",
    group: "Finance",
    summary:
      "The money side of the platform in one place: billing cycles, invoices, payments, balances and credit limits, currencies, time zones and the check of vendor invoices against our traffic.",
    keywords: [
      "billing",
      "finance",
      "balance",
      "invoice",
      "payment",
      "credit note",
      "credit limit",
      "prepaid",
      "postpaid",
      "currency",
      "exchange rate",
      "platform currency",
      "time zone",
      "reconciliation",
      "SOA",
      "statement of account",
    ],
    sections: [
      {
        id: "overview",
        title: "The big picture",
        blocks: [
          {
            kind: "text",
            text: "Every message the platform carries is rated twice: once at the customer's sell rate (what we charge them) and once at the vendor's buy rate (what the vendor charges us). These rated records are the EDRs (event detail records). Finance turns them into invoices, balances and statements, per enterprise and per **side**: the customer side (we bill them) and the vendor side (they bill us). A reciprocal partner has both sides.",
          },
          {
            kind: "list",
            title: "The Finance pages and what each one does",
            items: [
              "[[billing-cycles|Billing cycles]]: the named periods invoices are cut on, such as `Monthly – Net 7`.",
              "[[invoices|Invoices]]: our invoices to customers, created from the EDRs by an invoice request.",
              "[[transactions|Transactions]]: payments in and out, credit notes, adjustments and bank charges.",
              "[[balances|Enterprise balance]]: what every partner owes or has in credit right now.",
              "[[vendor-invoices|Vendor invoices]]: the vendors' invoices to us, checked automatically against our own figures.",
              "[[soa|SOA]] and [[soa-report|SOA report]]: the statement of account sent to a partner, and the copies sent or exported.",
              "[[charges|Charges calculator]]: usage charges for any period, without making an invoice.",
              "[[currencies|Currencies]]: the currency list and exchange rates.",
            ],
          },
        ],
      },
      {
        id: "billing-settings",
        title: "Billing settings on the enterprise",
        blocks: [
          {
            kind: "text",
            text: "Each enterprise has billing settings per side on its **Billing** tab (see [[enterprise-record|the enterprise record]]). Nothing on the Finance pages works for a side until these exist: an invoice request for an enterprise without customer billing settings fails, and a vendor invoice for an enterprise without vendor billing settings is refused.",
          },
          {
            kind: "fields",
            title: "Billing tab fields that drive Finance",
            fields: [
              {
                name: "Currency",
                what: "The currency the side is billed in. Invoices, balances and the SOA for this side use it.",
                values: "An ISO code from [[currencies|Currencies]], e.g. `EUR`. It is fixed once invoices exist.",
              },
              {
                name: "Billing cycle",
                what: "How long each usage period is and how many days the customer has to pay.",
                values: "A cycle from [[billing-cycles|Billing cycles]].",
              },
              {
                name: "Time zone",
                what: "Where the partner's billing day starts and ends. Usage days are cut at midnight in this zone.",
                values: "e.g. `Europe/Berlin`. Empty means UTC.",
              },
              {
                name: "Billing type",
                what: "**Prepaid**: the partner pays first and traffic stops when the balance (plus credit) runs out. **Postpaid**: the partner pays after the invoice, up to the credit limit.",
              },
              {
                name: "Credit limit",
                what: "How much a postpaid customer may owe. Credit alerts are based on it. The [[balances|Enterprise balance]] page shows how much of it is used.",
              },
              {
                name: "Opening balance",
                what: "The balance the side started with on this platform.",
                values: "Positive = starts in credit, negative = starts owing.",
              },
              {
                name: "Auto invoicing",
                what: "Customer side only. When ticked, invoices are made automatically at the end of each billing cycle.",
              },
              {
                name: "Send payment confirmation",
                what: "The default for the **Send payment confirmation** tick box when someone adds a payment for this side.",
              },
            ],
          },
        ],
      },
      {
        id: "cycles-and-invoices",
        title: "Billing cycles and invoice generation",
        blocks: [
          {
            kind: "text",
            text: "A billing cycle says how many days of usage go on one invoice (**Usage Days**) and how many days after the invoice date the payment is due (**Due Days**). For example `Monthly – Net 7` bills each calendar month and wants payment 7 days after the invoice date.",
          },
          {
            kind: "steps",
            title: "What happens when an invoice is made",
            items: [
              "An invoice request starts, either automatically at the end of the cycle (**Auto**) or by hand with **Generate Request** on the [[invoices|Invoices]] page (**Manual**).",
              "The request reads the customer's EDRs for the usage period, with days cut at midnight in the chosen time zone, and adds up messages and charges in the customer's billing currency.",
              "It works out the **Opening Balance** (the balance just before the invoice date), subtracts the **Usage Charges** and gets the **Closing Balance**.",
              "If the closing balance is negative, that amount is the **Due Amount**. If the customer is still in credit, nothing is due and the invoice is marked **Paid** straight away.",
              "The invoice gets the next number of the business company (for example `INV-3-1042`) unless you typed one, and the due date from the billing cycle unless you set one.",
            ],
          },
          {
            kind: "text",
            text: "A **Proforma** invoice is different: it asks for an amount in advance, has no traffic lines, and does not count as usage in balances.",
          },
        ],
      },
      {
        id: "payments",
        title: "Payments, credit notes and adjustments",
        blocks: [
          {
            kind: "text",
            text: "Every money movement that is not usage is a transaction on the [[transactions|Transactions]] page. Each one has a **Payment Type**: **Credit** or **Debit**.",
          },
          {
            kind: "list",
            items: [
              "Customer side: a **Credit** (for example a receipt or a credit note) raises the customer's balance; a **Debit** lowers it.",
              "Vendor side: a **Debit** (for example a bill payment we make) raises the vendor balance; a **Credit** lowers it.",
              "A transaction can point to the customer invoice it settles. The invoice then lists it under **Payments**, and it can no longer be regenerated or deleted.",
              "A payment can be left off the partner's SOA (with a reason). It still counts in every balance and report.",
            ],
          },
        ],
      },
      {
        id: "balances",
        title: "Balances and credit limits",
        blocks: [
          {
            kind: "text",
            text: "Every balance on the platform uses the same rule: **Balance = opening balance + payments − usage**. A positive balance is the partner's credit; a negative balance is money owed, and is shown in amber.",
          },
          {
            kind: "list",
            items: [
              "Customer balance: opening balance, plus customer transactions (credit +, debit −), minus the usage charges of every traffic invoice that did not fail.",
              "Vendor balance: opening balance, plus vendor transactions (debit +, credit −), minus the amount of every **accepted** vendor invoice. Vendor invoices that are pending, disputed or rejected do not count yet.",
              "Net balance: customer balance minus vendor balance, in the customer currency. The vendor side is converted at today's rate when the currencies differ. Negative net means the partner owes us after offsetting.",
              "Credit used: what the customer owes as a share of the credit limit. Amber from 80 %, red at 100 %.",
            ],
          },
        ],
      },
      {
        id: "currencies",
        title: "Currencies and conversion",
        blocks: [
          {
            kind: "list",
            items: [
              "Exchange rates are stored as units per 1 USD. Converting from one currency to another goes through USD.",
              "A new rate starts from the moment it is saved. Earlier rates are kept, so amounts already converted never move.",
              "A payment's **Final Amount** is its amount converted to the base currency of the enterprise's business company, at the rate in force on the payment date.",
              "Totals across partners and companies (for example the [[charges|Charges calculator]] totals and the vendor invoice monthly summary) are in the **platform currency**. In the trial the platform currency is the euro (`EUR`).",
            ],
          },
        ],
      },
      {
        id: "time-zones",
        title: "Time zones for billing periods",
        blocks: [
          {
            kind: "text",
            text: "A billing day runs from midnight to midnight in the partner's billing time zone, not in UTC. The same date range can hold different traffic for two partners in different zones.",
          },
          {
            kind: "list",
            items: [
              "Invoices, the Charges calculator and the vendor invoice check all cut days in the partner's time zone (or the zone you choose on the form).",
              "Vendor invoices show **Input From Date** and **Input To Date**: the exact window our figures were counted for, in UTC. Hover a value to see it in the partner's zone.",
              "Times such as **Transaction Time** and **Created Time** are shown in UTC.",
            ],
          },
          {
            kind: "tip",
            text: "If a vendor's figures are off by roughly one day of traffic, check the time zone on the vendor invoice first.",
          },
        ],
      },
      {
        id: "reconciliation",
        title: "Checking vendor invoices against traffic",
        blocks: [
          {
            kind: "steps",
            items: [
              "A vendor invoice arrives (added by hand, imported from a file, or received by the billing mailbox).",
              "The platform counts our own vendor cost for that vendor, period, currency and time zone from the EDRs.",
              "It compares the amount, the message count (when the invoice has one) and, if set, each destination, using the partner's reconciliation rule or the default rule.",
              "Within tolerance: **Match**, and the invoice is **Accepted** (an acceptance e-mail is sent or waits for you, as the rule says). Outside: **Mismatch**, and a pending invoice becomes **Disputed**.",
              "Billing then decides disputed invoices by hand: **Accept**, **Reject** or **Keep pending**, always with a note.",
            ],
          },
          {
            kind: "text",
            text: "Only accepted vendor invoices count in the vendor balance and appear in the SOA's main lines. See [[vendor-invoices|Vendor invoices]] for the details.",
          },
        ],
      },
      {
        id: "rules",
        title: "Rules the system enforces",
        blocks: [
          {
            kind: "list",
            items: [
              "Every save is one change you can undo (Ctrl+Z or **Undo** in the page header). See [[undo-and-history]].",
              "Delete never erases finance data: it archives the record. It is blocked while something depends on it, for example an invoice with linked payments or a billing cycle that enterprises use. See [[safe-delete]].",
              "Depending on your visibility settings, balances and amounts of some partners may show as `—`. See [[am-visibility]].",
            ],
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ transactions
  {
    id: "transactions",
    pageKey: "transactions",
    title: "Transactions",
    group: "Finance",
    summary:
      "Record payments received and made, credit notes, adjustments and bank charges; send payment confirmations; choose which payments appear on the partner's statement.",
    keywords: [
      "payment",
      "receipt",
      "credit note",
      "adjustment",
      "dispute",
      "bank charges",
      "bill payment",
      "reprocess",
      "payment confirmation",
      "include in SOA",
      "exclude from SOA",
      "TX",
    ],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "The billing team uses this page to record every money movement that is not traffic usage: a customer paying us, us paying a vendor, credit notes, adjustments, disputes and bank charges. Each transaction changes the partner's balance at once. Customer and vendor transactions are in the same list; the **Enterprise Type** column tells them apart.",
          },
          {
            kind: "text",
            text: "Each transaction gets a reference `TX-` followed by its number, e.g. `TX-10452`. That reference is used in confirmations, invoices and the SOA.",
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
              "**Add transaction** (the accent button): opens the transaction form.",
              "**Undo** and **History**: take back your last change, or see every change made on this page.",
              "**Export**: downloads the rows that match the current filters as a CSV file, including the final amount, base currency and the reason for leaving a payment off the SOA.",
            ],
          },
          {
            kind: "fields",
            title: "Grid columns",
            fields: [
              { name: "Name", what: "The enterprise the transaction belongs to." },
              { name: "Enterprise Type", what: "**Customer** or **Vendor**: which side of the enterprise it affects." },
              { name: "Payment Date", what: "The date the money moved. The list is sorted by it, newest first." },
              { name: "Transaction Time", what: "When the transaction was entered on the platform (UTC)." },
              { name: "Mode of Payment", what: "How the money moved, e.g. **Bank Transfer**." },
              { name: "Payment Type", what: "**Credit** or **Debit**." },
              {
                name: "Transaction Type",
                what: "What kind of transaction it is, e.g. **Receipt** or **Credit Note**.",
              },
              { name: "Amount", what: "The amount in the source currency." },
              { name: "Currency", what: "The source currency." },
              { name: "Invoice Number", what: "The customer invoice it settles, if any." },
              { name: "Description", what: "Free text entered with the transaction." },
              {
                name: "Confirmation",
                what: "Whether the payment confirmation e-mail went out.",
                values: "Green **Sent**, grey **Not sent**, red **Failed** (the partner has no billing contact).",
              },
              {
                name: "In SOA",
                what: "**Yes** if it appears on the partner's statement. **No** (amber) if it was left off; hover to see the reason.",
              },
              { name: "Updated By", what: "Who last changed it." },
            ],
          },
          {
            kind: "text",
            text: "Every column has a filter under its header. Hidden columns such as **Final Amount** and **Base Currency** can be added from the column menu. See [[grids-and-filters]].",
          },
          {
            kind: "list",
            title: "Detail panel",
            items: [
              "**Transaction** tab: enterprise and side, amount and the converted final amount with the rate used, type and mode, payment date and who entered it, linked invoice, confirmation status with time and recipients, SOA status with reason, and the description. Buttons: **Edit**, **Send confirmation** (or **Re-send confirmation** once sent) and **Delete**.",
              "**History** tab: every change to this transaction.",
            ],
          },
          {
            kind: "text",
            text: "When you select rows, the status bar shows how many are selected and how many of them are off the SOA.",
          },
        ],
      },
      {
        id: "fields",
        title: "Fields in the transaction form",
        blocks: [
          {
            kind: "fields",
            title: "Transaction Information",
            fields: [
              {
                name: "Enterprise Type",
                what: "Which side the transaction is for. Switching it resets **Payment Type**, **Transaction Type** and **Invoice Number** to the defaults for that side.",
                values:
                  "**Customer** (default: Receipt, Credit) or **Vendor** (default: Bill Payment, Debit). Cannot be changed when editing.",
              },
              {
                name: "Enterprise Name",
                what: "The partner. Only enterprises of the chosen type, or reciprocal ones, are offered.",
                values: "Type part of the name or alias, e.g. `Acme`. Required.",
              },
              {
                name: "Invoice Number",
                what: "The customer invoice this payment settles. It then shows under **Payments** on that invoice.",
                values:
                  "Optional. Only invoices of the chosen enterprise are offered. Not available for vendor payments: those settle vendor invoices, which are handled on [[vendor-invoices|Vendor invoices]].",
              },
              {
                name: "Transaction Type",
                what: "What kind of movement it is.",
                values:
                  "**Receipt**, **Adjustment**, **Disputes**, **Credit Note**, **Bank Charges**, **Bill Payment**. **Reprocess** is only posted by approved [[re-rating|re-rating]] requests and cannot be chosen by hand.",
              },
              {
                name: "Mode of Payment",
                what: "How the money moved. Required for every type except Reprocess.",
                values:
                  "**Cash**, **By Cheque**, **Bank Transfer** (default), **Paypal**, **Credit Card**, **Debit Card**, **Wire Transfer**, **Crypto**.",
              },
              {
                name: "Payment Type",
                what: "**Credit** or **Debit**. This decides whether the balance goes up or down. The hint under the field says it in words, e.g. “Raises the customer's balance by 5,000.00 EUR”.",
                values:
                  "Customer side: Credit raises the balance, Debit lowers it. Vendor side: Debit raises it, Credit lowers it.",
              },
              {
                name: "Payment Date",
                what: "The date the money moved. It also picks the exchange rate used for the final amount.",
                values: "Required. Not more than a year ahead. Default today.",
              },
              {
                name: "Amount",
                what: "The amount in the source currency.",
                values: "Required, at least `0.01`, e.g. `5000.00`.",
              },
              {
                name: "Source Currency",
                what: "The currency the money was paid in. A new transaction takes the side's billing currency once you choose the enterprise; the hint shows that billing currency.",
                values: "Any currency from [[currencies|Currencies]]. Default `EUR` until the enterprise is chosen.",
              },
              {
                name: "Transaction Description",
                what: "Free text, for example the bank reference.",
                values: "Optional, up to 500 characters.",
              },
            ],
          },
          {
            kind: "fields",
            title: "Transaction Conversion (read-only)",
            fields: [
              { name: "Source", what: "The amount and currency you entered." },
              {
                name: "Rate",
                what: "The exchange rate from the source currency to the base currency of the enterprise's business company, on the payment date.",
              },
              {
                name: "Final Amount",
                what: "The amount in that base currency. It is calculated and stored when you save.",
              },
            ],
          },
          {
            kind: "fields",
            title: "Confirmation and SOA",
            fields: [
              {
                name: "Send payment confirmation",
                what: "On a new transaction, e-mails a confirmation to the partner's billing contacts when you save. The save button then reads **Add and send confirmation**. When editing, the tick box is stored but does not send; use **Send confirmation** in the detail panel instead.",
                values:
                  "Default comes from the side's billing settings. **Preview** shows the recipients, subject and text, including the balance after this payment.",
              },
              {
                name: "Include in SOA",
                what: "Whether the transaction appears on the partner's statement of account. Unticked, it still counts in balances and reports.",
                values: "Ticked by default.",
              },
              {
                name: "Reason for leaving it off the SOA",
                what: "Shown only when **Include in SOA** is unticked.",
                values: "Required then, up to 300 characters, e.g. `Internal correction, agreed with partner`.",
              },
            ],
          },
        ],
      },
      {
        id: "how-to-add",
        title: "How to record a payment",
        blocks: [
          {
            kind: "steps",
            items: [
              "Click **Add transaction**.",
              "Choose **Customer** or **Vendor**, then the enterprise.",
              "For a customer payment against an invoice, pick the invoice in **Invoice Number**. The list shows each invoice's date, due amount and payment status.",
              "Check **Transaction Type**, **Mode of Payment** and **Payment Type**. Read the hint under Payment Type to be sure the balance moves the right way.",
              "Enter the **Payment Date**, **Amount** and **Source Currency**. Check the converted **Final Amount**.",
              "Tick **Send payment confirmation** if the partner should get an e-mail, and click **Preview** to check it.",
              "Click **Add transaction** (or **Add and send confirmation**). A message confirms the save and whether the confirmation was sent or failed.",
            ],
          },
        ],
      },
      {
        id: "how-to-edit",
        title: "How to edit or delete a transaction",
        blocks: [
          {
            kind: "steps",
            title: "Edit",
            items: [
              "Double-click the row, press Enter, or click **Edit** in the detail panel.",
              "Change the fields and click **Save**. The side (customer or vendor) cannot change; delete and re-add instead.",
            ],
          },
          {
            kind: "steps",
            title: "Delete",
            items: [
              "Select the transaction and click **Delete** in the detail panel.",
              "Confirm. The transaction is archived and no longer counts in the balance. **Undo** brings it back; an administrator can also **Restore** it later.",
            ],
          },
        ],
      },
      {
        id: "how-to-confirm",
        title: "How to send or re-send a payment confirmation",
        blocks: [
          {
            kind: "steps",
            items: [
              "Select the transaction.",
              "Click **Send confirmation** (or **Re-send confirmation**) in the detail panel.",
              "The **Confirmation** column turns **Sent**, or **Failed** if the partner has no billing contact. Every attempt is logged in [[email-logs|Email logs]].",
            ],
          },
          {
            kind: "steps",
            title: "Several at once",
            items: [
              "Tick the rows (Space selects the current row).",
              "Choose **Send confirmations** from the selection actions.",
            ],
          },
        ],
      },
      {
        id: "how-to-soa",
        title: "How to include or exclude payments from the SOA",
        blocks: [
          {
            kind: "steps",
            items: [
              "Tick the transactions.",
              "Choose **Include in SOA**, or **Exclude from SOA…**.",
              "For Exclude, type the **Reason** and click **Exclude from SOA**. The reason is required.",
            ],
          },
          {
            kind: "text",
            text: "You can also include a single payment straight from the statement on the [[soa|SOA]] page, under **Payments left off the SOA**.",
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
              "The balance changes as soon as you save. See [[billing-basics#balances|how balances are worked out]].",
              "The final amount is stored with the rate used, so a later change of exchange rate never changes a saved transaction.",
              "Linking an invoice blocks regenerating or deleting that invoice while the payment is linked.",
              "Leaving a payment off the SOA only changes the statement. The SOA then shows that it differs from the system balance.",
              "Each save, bulk action and confirmation is one change you can undo. See [[undo-and-history]].",
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
            text: "Check **Payment Type** before saving. On the vendor side a payment we make is a **Debit**, and it raises the vendor balance (we owe less).",
          },
          {
            kind: "tip",
            text: "If a confirmation fails, add a finance (or commercial) contact on the enterprise's contacts, then use **Re-send confirmation**.",
          },
          {
            kind: "tip",
            text: "In the trial, confirmation e-mails are not really sent; they are recorded in Email logs as if they were.",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ invoices
  {
    id: "invoices",
    pageKey: "invoices",
    title: "Invoices",
    group: "Finance",
    summary:
      "Customer invoices made from the traffic records: generate them, check the charge details, download the PDF, send them and track payment.",
    keywords: [
      "invoice",
      "customer invoice",
      "generate request",
      "invoice request",
      "regenerate",
      "proforma",
      "traffic invoice",
      "auto invoicing",
      "due amount",
      "charge details",
      "PDF",
      "send invoice",
      "mark paid",
    ],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "The billing team uses this page to make, check and send customer invoices. Invoices are made from the customer's EDRs for a usage period. Most are made automatically at the end of each billing cycle (**Auto**); you can make one by hand at any time with **Generate Request** (**Manual**).",
          },
          {
            kind: "text",
            text: "The page has two views, switched at the top: **Invoices** (the invoices themselves) and **Invoice requests** (the background jobs that make them).",
          },
        ],
      },
      {
        id: "layout",
        title: "What you see on the Invoices view",
        blocks: [
          {
            kind: "list",
            title: "Header buttons",
            items: [
              "**Generate Request** (the accent button): opens the form to make one or more invoices.",
              "**Undo** and **History**: take back your last change, or see every change made on invoices.",
              "**Export**: downloads the rows that match the current filters as a CSV file.",
            ],
          },
          {
            kind: "fields",
            title: "Grid columns",
            fields: [
              { name: "Invoice No", what: "The invoice number, e.g. `INV-3-1042`." },
              { name: "Enterprise Name", what: "The customer." },
              { name: "Enterprise Type", what: "**Customer** or **Reciprocal**." },
              {
                name: "Invoice Type",
                what: "**Auto** (made by the billing cycle) or **Manual** (made by Generate Request).",
              },
              { name: "Billing Type", what: "**Prepaid** or **Postpaid**, from the customer's billing settings." },
              { name: "Currency", what: "The customer's billing currency." },
              { name: "Invoice Date", what: "The date printed on the invoice." },
              { name: "Usage Start Date / Usage End Date", what: "The traffic period the invoice covers." },
              { name: "Payment Due Date", what: "When payment is due." },
              {
                name: "Due Amount",
                what: "What the customer has to pay: the owed part of the closing balance. Amber when more than zero.",
              },
              {
                name: "Opening Balance",
                what: "The customer's balance just before the invoice date. Positive = credit, negative = owed (amber).",
              },
              { name: "Usage Charges", what: "The traffic charges for the usage period." },
              { name: "Closing Balance", what: "Opening balance minus usage charges." },
              { name: "Email Status", what: "**Sent** or **UnSent**." },
              {
                name: "Status",
                what: "Where the invoice is in its making.",
                values: "grey **Pending**, blue **Inprogress**, green **Completed**, red **Failed**.",
              },
              {
                name: "Payment",
                what: "Payment status.",
                values: "amber **Unpaid**, amber **Partly paid**, green **Paid**.",
              },
              { name: "Remarks", what: "Free text." },
              {
                name: "PDF · Charges",
                what: "Two icons at the end of the row: download the PDF (only when Completed), and open the **Charge Details** window.",
              },
            ],
          },
          {
            kind: "text",
            text: "Hidden columns such as **Business Company**, **Kind** (Traffic or Proforma), **Time Zone**, **Messages** and **Email Sent** can be added from the column menu. When you select rows, the status bar adds up their due amount (when they share one currency).",
          },
          {
            kind: "list",
            title: "Detail panel",
            items: [
              "**Invoice** tab: enterprise, type, usage period and time zone, message count, dates, opening balance, usage charges, closing balance, due amount, status, e-mail status with recipients, linked payments and who created it. Buttons: **Edit**, **PDF**, **Send Invoice** (or **Send again**), **Regenerate**, **Send SOA** and **Delete**.",
              "**Charge details** tab: the lines behind the usage charges, per MCCMNC (mobile country and network code) and rate, with messages and amount.",
              "**History** tab: every change to this invoice.",
            ],
          },
        ],
      },
      {
        id: "requests-view",
        title: "What you see on the Invoice requests view",
        blocks: [
          {
            kind: "text",
            text: "Every invoice is made by a request that runs in the background. This view lists them, newest first, so you can see what is running and why one failed. Rows cannot be edited.",
          },
          {
            kind: "fields",
            title: "Grid columns",
            fields: [
              { name: "Request No", what: "The request's number." },
              { name: "Request Start Time / Request End Time", what: "When the job started and finished." },
              {
                name: "Invoice Type",
                what: "**Auto** or **Manual**, with “· regenerate” when it recomputes an existing invoice.",
              },
              { name: "Kind", what: "**Traffic** or **Proforma**." },
              { name: "Enterprise Name / Enterprise Type / Billing Type", what: "The customer and its billing type." },
              { name: "Status", what: "**Pending**, **Inprogress**, **Completed** or **Failed**." },
              { name: "Error", what: "Why the request failed, in red." },
              { name: "Invoice No", what: "The invoice it made." },
              { name: "Remarks", what: "Remarks typed on the request." },
            ],
          },
        ],
      },
      {
        id: "fields-generate",
        title: "Fields in the Generate Request form",
        blocks: [
          {
            kind: "fields",
            fields: [
              {
                name: "Invoice Type",
                what: "**Traffic**: usage from the EDRs. **Proforma**: an amount you ask for in advance; it does not count as usage in balances.",
                values: "Default Traffic.",
              },
              {
                name: "Enterprise Name",
                what: "One or more customers (customer or reciprocal enterprises). Each gets its own request and invoice.",
                values: "Required. Each must have customer billing settings.",
              },
              {
                name: "Timezone",
                what: "Where usage days are cut at midnight.",
                values: "Empty = each enterprise's own billing time zone (recommended).",
              },
              {
                name: "Usage Start Date / Usage End Date",
                what: "The traffic period.",
                values: "Required. Default the last calendar month. End not before start, at most 366 days.",
              },
              {
                name: "Invoice Date",
                what: "The date printed on the invoice. The opening balance is taken just before it.",
                values: "Default today.",
              },
              {
                name: "Due Date Type",
                what: "**Auto (billing cycle due days)**: invoice date plus the cycle's Due Days. **Manual**: you pick the date.",
              },
              {
                name: "Due Date",
                what: "Shown only for a manual due date.",
                values: "Required then; not before the invoice date.",
              },
              {
                name: "Invoice Number",
                what: "Your own invoice number.",
                values:
                  "Only when exactly one enterprise is chosen. Empty = the business company's next number. Must not be in use already.",
              },
              {
                name: "Amount",
                what: "Proforma only: the amount asked for.",
                values: "Required for proforma, at least `0.01`.",
              },
              { name: "Volume", what: "Proforma only: the message count to print. Optional." },
              {
                name: "Currency",
                what: "Proforma only.",
                values: "Empty = the customer's billing currency.",
              },
              { name: "Remarks", what: "Free text printed with the invoice. Up to 500 characters." },
            ],
          },
        ],
      },
      {
        id: "how-to-generate",
        title: "How to make an invoice by hand",
        blocks: [
          {
            kind: "steps",
            items: [
              "Click **Generate Request**.",
              "Choose **Traffic** or **Proforma** and one or more enterprises.",
              "Check the usage period (default last month), invoice date and due date type.",
              "Click **Submit** (it shows the number of invoices when you chose several).",
              "The page switches to **Invoice requests**. The requests run in the background; a message tells you when the invoices are ready, or why one failed.",
              "Go back to **Invoices** to check the new invoice and its charge details before sending.",
            ],
          },
        ],
      },
      {
        id: "how-to-send",
        title: "How to send, mark or download invoices",
        blocks: [
          {
            kind: "steps",
            title: "Send by e-mail",
            items: [
              "Select one invoice and click **Send Invoice** in the detail panel, or tick several rows and choose **Send Invoice** from the selection actions.",
              "Each completed invoice is e-mailed with its PDF to the customer's billing contacts. Invoices that are not completed, deleted, or whose customer has no billing contact are skipped; the message says how many and why.",
            ],
          },
          {
            kind: "steps",
            title: "Mark payment or e-mail status",
            items: [
              "Tick the invoices and choose **Mark…**.",
              "Pick a **Payment status** (Unpaid, Partly paid, Paid) and/or an **Email status** (UnSent, Sent). Leave one as **Leave as it is** to keep it.",
              "Click **Mark**.",
            ],
          },
          {
            kind: "steps",
            title: "Download",
            items: [
              "Click the download icon in the row, or **PDF** in the detail panel. Only completed invoices have a PDF.",
              "Click the list icon in the row to open **Charge Details** in a window.",
            ],
          },
        ],
      },
      {
        id: "how-to-edit",
        title: "How to edit, regenerate or delete an invoice",
        blocks: [
          {
            kind: "text",
            text: "**Edit** changes only the **Payment Due Date** (not before the invoice date) and **Remarks**. Amounts always come from the usage.",
          },
          {
            kind: "steps",
            title: "Regenerate",
            items: [
              "Select the invoice and click **Regenerate**.",
              "A new request recomputes the usage and balances for the same period, number and dates. The invoice shows **Inprogress** while it runs.",
              "When it finishes the invoice is updated and its e-mail status goes back to **UnSent**, so you can send the corrected version.",
            ],
          },
          {
            kind: "steps",
            title: "Delete",
            items: [
              "Click **Delete** in the detail panel. The dialog lists what depends on the invoice.",
              "Delete is blocked while payments are linked to the invoice or a regenerate is running. An invoice already e-mailed can be deleted; the partner keeps the copy they received.",
              "A deleted invoice is archived and stops counting in the balance.",
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
              "Usage comes from the customer's EDRs for the period, with days cut at midnight in the chosen time zone, in the customer's billing currency.",
              "**Opening Balance** = the customer balance just before the invoice date. **Closing Balance** = opening − usage charges. **Due Amount** = what the closing balance owes (zero if still in credit, and the invoice is then marked Paid).",
              "For a proforma invoice the due amount is the amount asked for, and it does not change the balance.",
              "A traffic request fails if the customer is already invoiced for an overlapping period. Use **Regenerate** on that invoice instead.",
              "Payments recorded on [[transactions|Transactions]] with this invoice number show under **Payments** in the detail panel.",
              "**Send SOA** opens the [[soa|SOA]] page for this customer.",
              "See [[billing-basics#cycles-and-invoices|how invoices are made]].",
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
            text: "An invoice with linked payments cannot be regenerated or deleted. Unlink or delete the payment first if the invoice really is wrong.",
          },
          {
            kind: "tip",
            text: "Check the **Charge details** tab before sending: a warning there means the usage period is not fully covered by traffic records.",
          },
          {
            kind: "tip",
            text: "In the trial the generated traffic covers only a limited date range. A traffic request for a period outside it fails with a message naming the dates that are covered. Auto invoices in the list come from the generated data, and e-mails are recorded in [[email-logs|Email logs]] instead of being sent.",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ vendor invoices
  {
    id: "vendor-invoices",
    pageKey: "vendor-invoices",
    title: "Vendor invoices",
    group: "Finance",
    summary:
      "Vendors' invoices to us, each checked automatically against our own traffic and cost for the same period, with accept, reject and dispute handling, tolerance rules and a monthly summary.",
    keywords: [
      "vendor invoice",
      "partner invoice",
      "reconciliation",
      "recon",
      "dispute",
      "dispute amount",
      "match",
      "mismatch",
      "accept",
      "reject",
      "tolerance",
      "reconciliation rule",
      "monthly summary",
      "import",
      "input from date",
    ],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "When a vendor sends us an invoice, the billing team records it here. The platform then counts what we think we owe that vendor for the same period (from our EDRs) and compares the two. Invoices that match within tolerance are accepted automatically; the others become **Disputed** and wait for a decision.",
          },
          {
            kind: "text",
            text: "The page has three views, switched at the top: **Invoices**, **Reconciliation rules** and **Monthly summary**.",
          },
        ],
      },
      {
        id: "layout",
        title: "What you see on the Invoices view",
        blocks: [
          {
            kind: "list",
            title: "Header buttons",
            items: [
              "**Add** (the accent button): record a vendor invoice by hand.",
              "**Import**: add many invoices from a file.",
              "**Undo**, **History** and **Export** (CSV of the filtered rows).",
            ],
          },
          {
            kind: "fields",
            title: "Grid columns",
            fields: [
              { name: "Info ID", what: "The record number." },
              { name: "Enterprise Name", what: "The vendor." },
              { name: "Invoice Number", what: "The vendor's own invoice number." },
              {
                name: "Status",
                what: "The decision.",
                values: "grey **Pending**, green **Accepted**, amber **Disputed**, red **Rejected**.",
              },
              {
                name: "Check",
                what: "The result of the comparison.",
                values:
                  "green **Match**, amber **Mismatch**, grey **No EDR data** (our records do not cover the period), **Not checked**.",
              },
              { name: "Charge Volume", what: "Messages on their invoice." },
              { name: "Charge Amount", what: "Their amount." },
              { name: "Our Amount", what: "Our vendor cost for the same vendor, period and time zone." },
              {
                name: "Dispute Amount",
                what: "Their amount minus ours. Positive means they charge more than we counted.",
              },
              {
                name: "Difference %",
                what: "The dispute amount as a share of ours.",
                values: "Plain within 1 %, amber up to 5 %, red beyond 5 %.",
              },
              { name: "Invoice Date / Invoice Due Date", what: "The dates on their invoice." },
              { name: "Invoice From Date / Invoice To Date", what: "The period their invoice covers." },
              {
                name: "Input From Date / Input To Date",
                what: "The exact window our figures were counted for, in UTC. Hover to see it in the partner's time zone. **not counted** means we could not count (see the check reasons).",
              },
              {
                name: "Email",
                what: "The acceptance or rejection e-mail.",
                values: "**—** (none), **Waiting to confirm**, **Sent**, **Failed**.",
              },
              { name: "Remarks", what: "Free text." },
            ],
          },
          {
            kind: "text",
            text: "Hidden columns include **Account Manager**, **Currency**, **Our Volume**, **Volume Difference**, **Timezone**, **Source** (Manual, Import or Email), **Lines**, **Checked Time** and **Created By/Time**. When you select rows, the status bar adds up their difference (when they share one currency).",
          },
          {
            kind: "list",
            title: "Detail panel",
            items: [
              "**Reconciliation** tab: their amount and count, our amount and count, the difference in money, % and messages, and the result. Below: partner and AM, period and time zone, input period, dates and source, the check reasons (one line per check), the rule used, e-mail status, whether the invoice is on the SOA, and **Notes and history** (received, checked, status changes, notes and e-mails). Buttons: **Accept**, **Reject**, **Keep pending**, **Send acceptance**, **Check again**, **Edit**, **Note** and **Delete** (only the ones that fit the current status are shown).",
              "**Destinations** tab: our vendor cost per MCCMNC for the period. When the invoice has destination lines, their figures sit next to ours, largest difference first, and destinations beyond the rule's limit are flagged in red.",
              "**Changes** tab: every change to this record.",
            ],
          },
        ],
      },
      {
        id: "fields",
        title: "Fields in the vendor invoice form",
        blocks: [
          {
            kind: "fields",
            title: "Vendor Invoice",
            fields: [
              {
                name: "Enterprise",
                what: "The vendor (vendor or reciprocal enterprises). It must have vendor billing settings.",
                values: "Required.",
              },
              {
                name: "Invoice Number",
                what: "The vendor's invoice number.",
                values: "Required, up to 60 characters. Must be unique for this vendor (not case-sensitive).",
              },
              {
                name: "Currency",
                what: "The invoice currency. Our figures are counted in the same currency.",
                values: "Empty = the vendor billing currency.",
              },
              {
                name: "Charge Volume",
                what: "Messages on their invoice. When empty, the message count is not checked.",
                values: "Optional whole number.",
              },
              { name: "Charge Amount", what: "Their total amount.", values: "Required, e.g. `12450.00`." },
              {
                name: "Timezone",
                what: "Where our figures are cut at midnight.",
                values: "Empty = the partner's billing time zone.",
              },
              { name: "Invoice Date", what: "The date on their invoice.", values: "Required. Default today." },
              {
                name: "Invoice Due Date",
                what: "When they want to be paid.",
                values: "Optional; not before the invoice date.",
              },
              {
                name: "Invoice From Date / Invoice To Date",
                what: "The traffic period on their invoice.",
                values: "Required. Default the last calendar month. At most 366 days.",
              },
              { name: "Remarks", what: "Free text, up to 500 characters." },
            ],
          },
          {
            kind: "fields",
            title: "Per-destination lines (optional)",
            fields: [
              {
                name: "Lines",
                what: "Their figures per destination, one per line, so the platform can compare destination by destination.",
                values:
                  "`mccmnc, volume, amount` per line; comma, semicolon or tab between values; volume may be empty. Example: `23410,125000,2450.00`. MCCMNC is 5 or 6 digits and may appear only once. A header line starting with `mccmnc` is ignored.",
              },
            ],
          },
          {
            kind: "text",
            text: "When editing, the lines already on file are kept unless you click **Replace the … lines on file**.",
          },
        ],
      },
      {
        id: "how-to-add",
        title: "How to add and check a vendor invoice",
        blocks: [
          {
            kind: "steps",
            items: [
              "Click **Add**.",
              "Choose the vendor and type the invoice number, charge amount and (if printed) charge volume.",
              "Check the period and the time zone. A wrong time zone shifts the period by hours and causes false mismatches.",
              "Optionally paste the destination lines.",
              "Click **Add and check**. The comparison runs at once; the message shows the result and the new status.",
              "Open the **Reconciliation** tab to read the check reasons.",
            ],
          },
        ],
      },
      {
        id: "how-to-import",
        title: "How to import vendor invoices",
        blocks: [
          {
            kind: "steps",
            items: [
              "Click **Import** and choose the file.",
              "Columns: `enterprise` (name or alias), `invoice_number`, `charge_volume`, `charge_amount`, `currency`, `invoice_date`, `due_date`, `period_from`, `period_to`, `timezone`, `remarks`.",
              "Dates are `YYYY-MM-DD`. An empty currency or time zone takes the partner's billing settings.",
              "Each invoice is checked as it is added. Invoices already on file are left as they are (import only adds).",
            ],
          },
        ],
      },
      {
        id: "how-to-decide",
        title: "How to accept, reject or keep an invoice pending",
        blocks: [
          {
            kind: "steps",
            items: [
              "Select the invoice and read the check reasons and the **Destinations** tab.",
              "Click **Accept**, **Reject** or **Keep pending**.",
              "Type the note. It is required to reject, to keep pending, and to accept an invoice that did not match (e.g. `agreed after discussion, credit note received`).",
              "For Accept and Reject, leave **Send the acceptance e-mail to the partner** (or rejection e-mail) ticked to e-mail the partner. The preview shows the recipients and text.",
              "Click the button (it reads e.g. **Accept and e-mail**). The status changes and the decision is logged in Notes and history.",
            ],
          },
          {
            kind: "list",
            title: "Other actions",
            items: [
              "**Send acceptance**: for an accepted invoice whose acceptance e-mail was not sent yet (for example when the rule says **Confirm before sending**).",
              "**Check again**: recounts our figures and compares again, for example after late traffic records arrived or the rule changed.",
              "**Note**: adds a note to the history without changing anything.",
              "**Edit**: change the invoice. **Save and check** saves and runs the comparison again.",
            ],
          },
        ],
      },
      {
        id: "rules-view",
        title: "The Reconciliation rules view",
        blocks: [
          {
            kind: "text",
            text: "A rule sets how close their figures must be to ours to count as a match. There is one **Default rule** for every partner, and you can add a rule for a single partner. Click **Add partner rule** to add one; double-click a row to edit it. The default rule cannot be deleted.",
          },
          {
            kind: "text",
            text: "Grid columns: **Partner**, **Amount %**, **Amount (fixed)**, **Amount Rule**, **Count %**, **Count (fixed)**, **Count Rule**, **Destination %**, **Acceptance Email**, **Disputed in SOA** and **Invoices** (how many vendor invoices the rule covers).",
          },
          {
            kind: "fields",
            title: "Fields in the rule form",
            fields: [
              {
                name: "Enterprise",
                what: "The partner the rule is for. Cannot change once saved. Each partner can have only one rule.",
              },
              {
                name: "Amount: Within %",
                what: "Allowed difference in money, as a share of our amount.",
                values: "0–100. Default `1`.",
              },
              {
                name: "Amount: Within amount",
                what: "Allowed difference in money, as a fixed amount in the invoice currency.",
                values: "Default `50`.",
              },
              {
                name: "Amount: With both",
                what: "How the two limits combine when both are set.",
                values:
                  "**Both must hold (stricter)** (default for amount) or **Either is enough (looser)**. At least one of % and fixed must be set.",
              },
              {
                name: "Message count: Within % / Within messages / With both",
                what: "The same for the message count. Only checked when the invoice has a charge volume.",
                values: "Defaults `1` %, `1000` messages, **Either is enough (looser)**.",
              },
              {
                name: "Flag a destination off by more than",
                what: "Per-destination check: any destination whose amount differs from ours by more than this share makes the invoice a mismatch. Needs destination lines on the invoice.",
                values: "Empty = no per-destination check.",
              },
              {
                name: "Acceptance e-mail on a match",
                what: "What happens when an invoice matches and is accepted automatically.",
                values:
                  "**Send at once** (default) or **Confirm before sending** (the e-mail waits; use **Send acceptance**).",
              },
              {
                name: "Rejected and pending in the SOA",
                what: "How invoices that are not accepted show on the partner's statement.",
                values: "**Separate “disputed” block** (default; printed but not in the balance) or **Left off**.",
              },
            ],
          },
          {
            kind: "tip",
            text: "Changing a rule does not change past results. Use **Check again** on an invoice to apply the new rule to it.",
          },
        ],
      },
      {
        id: "summary-view",
        title: "The Monthly summary view",
        blocks: [
          {
            kind: "text",
            text: "For the billing team: per month, how many vendor invoices there were, how many matched, how many are pending, accepted, disputed or rejected, and the money involved. Choose **From month**, **To month** (default the last 12 months, at most 36), and optionally a **Partner** or **Account manager**.",
          },
          {
            kind: "text",
            text: "Columns: **Month**, **Invoices**, **Match**, **Mismatch** (amber when any), **No EDR data** (also counts unchecked ones), **Pending**, **Accepted**, **Disputed** (amber when any), **Rejected**, and **Their amount**, **Our amount** and **Difference** in the platform currency. A **Total** row closes the table.",
          },
        ],
      },
      {
        id: "how-it-works",
        title: "How the check works",
        blocks: [
          {
            kind: "list",
            items: [
              "Our figures are the vendor cost in our EDRs for this vendor, from midnight on **Invoice From Date** to the end of **Invoice To Date** in the invoice's time zone, in the invoice currency.",
              "If our records do not fully cover the period, the result is **No EDR data** and the status does not change.",
              "Amount and count are each compared against the rule. The invoice matches only if every check passes. Each check writes one line in the reasons, e.g. “Amount within tolerance (1 % and 50.00 EUR)”.",
              "A **Pending** or **Disputed** invoice that matches becomes **Accepted**. A **Pending** invoice that does not match becomes **Disputed**. Invoices already accepted or rejected keep their status when checked again.",
              "Only **Accepted** vendor invoices count in the vendor balance on [[balances|Enterprise balance]] and in the SOA's main lines. Disputed and pending ones go to the SOA's disputed block or are left off, as the rule says.",
              "See [[billing-basics#reconciliation|reconciliation in short]].",
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
            text: "An accepted invoice cannot be deleted: it counts in the partner's balance and SOA. Reject it or keep it pending first, or give a reason to override the block.",
          },
          {
            kind: "warning",
            text: "Adding a vendor invoice whose number already exists for that vendor is refused.",
          },
          {
            kind: "tip",
            text: "In the trial a simulated billing mailbox “receives” weekly invoices from about a third of the vendors (source **Email**), every six hours. Their figures are close to ours, with some off by a few percent, so you can practise disputes.",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ SOA
  {
    id: "soa",
    pageKey: "soa",
    title: "SOA",
    group: "Finance",
    summary:
      "Build a statement of account for one or more partners, check every line before it goes out, adjust it by hand, then e-mail it or export it as Excel or PDF.",
    keywords: [
      "SOA",
      "statement of account",
      "statement",
      "send SOA",
      "manual entry",
      "disputed block",
      "opening balance",
      "closing balance",
      "export",
    ],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "A statement of account (SOA) lists, for one partner and period, the opening balance, every invoice and payment line, and the closing balance. The billing team uses this page to prepare SOAs, check them line by line, correct them by hand when needed, and then send them to the partner or export them. Each sent or exported SOA is kept on the [[soa-report|SOA report]] page.",
          },
          {
            kind: "text",
            text: "You can also open this page with a partner already chosen from **Send SOA** on [[invoices|Invoices]] and [[balances|Enterprise balance]].",
          },
        ],
      },
      {
        id: "fields",
        title: "Search fields",
        blocks: [
          {
            kind: "fields",
            fields: [
              {
                name: "Enterprise",
                what: "One or more partners.",
                values: "Required. Type a name or alias and pick from the list.",
              },
              {
                name: "Invoice Type",
                what: "Which customer invoices to include.",
                values: "**All** (default), **Auto** or **Manual**.",
              },
              {
                name: "From Date / To Date",
                what: "The statement period.",
                values: "Default the last calendar month. At most 3 years.",
              },
              {
                name: "Send SOA Email Template",
                what: "The e-mail template used by **Send Email**.",
                values:
                  "An **SOA Statement** or **Send SOA** template from [[email-templates|Email templates]]. Required to send.",
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
            kind: "list",
            title: "Header and toolbar",
            items: [
              "**SOA Report** (header): opens the list of sent and exported SOAs.",
              "**Search** (the accent button): lists one row per chosen partner.",
              "**Check All** / **Uncheck All**: tick or untick every row.",
              "**Send Email**: e-mails the SOA to the ticked partners.",
              "**Queue SOA Export · Excel** and **PDF**: makes the files for the ticked partners in the background.",
            ],
          },
          {
            kind: "fields",
            title: "Result table",
            fields: [
              { name: "Enterprise", what: "The partner and its type." },
              {
                name: "Customer opening / Customer closing",
                what: "The customer side's balance at the start and end of the period. Negative (owed) in amber.",
              },
              { name: "Vendor opening / Vendor closing", what: "The same for the vendor side." },
              { name: "Lines", what: "How many lines the statement has." },
              { name: "Left off", what: "Payments left off the SOA." },
              { name: "Disputed", what: "Vendor invoices not accepted (disputed or pending)." },
              {
                name: "Billing contact",
                what: "The first address the SOA goes to. Red **none** means sending will fail.",
              },
              { name: "Last SOA sent", what: "When an SOA was last e-mailed, or **never**." },
            ],
          },
          {
            kind: "text",
            text: "Click a row to see that partner's full statement below the table. With one partner chosen, it opens straight away.",
          },
        ],
      },
      {
        id: "statement",
        title: "Reading the statement",
        blocks: [
          {
            kind: "text",
            text: "The statement header shows the partner, business company, period, time zone, invoice type and the e-mail recipients. Then each side has its own table: **Customer side · our invoices to them** and **Vendor side · their invoices to us**, each in its own currency.",
          },
          {
            kind: "fields",
            title: "Statement columns",
            fields: [
              { name: "Date", what: "The line's date." },
              {
                name: "Type",
                what: "e.g. **Invoice**, **Vendor invoice**, **Payment received**, **Payment made**, **Credit note**, **Adjustment**, **Bank charges**, **Re-rating**, **Opening balance**.",
              },
              {
                name: "Reference · description",
                what: "Invoice number or `TX-` reference, description, and any note.",
              },
              {
                name: "Source",
                what: "**Auto** (from the system) or **Manual** (added or changed by hand).",
              },
              { name: "Status", what: "For vendor invoices, the decision (Accepted, Disputed…)." },
              { name: "Amount", what: "The line's effect on the balance." },
              { name: "Balance", what: "The running balance after the line. Positive = credit, negative = owed." },
            ],
          },
          {
            kind: "list",
            title: "Below each side",
            items: [
              "**System balance at** the To Date, and whether the SOA agrees. If not, the difference is shown in amber (payments left off, lines removed or added by hand).",
              "**Disputed and pending vendor invoices**: printed as a separate block (not in the balance) or left off, as the partner's reconciliation rule says. **Add to SOA** puts one in the main lines.",
              "**Payments left off the SOA**: they still count in balances. **Include** puts one back on.",
              "**Removed by hand**: lines someone removed. **Put back** restores one.",
              "For reciprocal partners: **Net balance (customer − vendor)** at the bottom.",
            ],
          },
        ],
      },
      {
        id: "fields-entry",
        title: "Fields in the Manual entry form",
        blocks: [
          {
            kind: "fields",
            fields: [
              { name: "Side", what: "**Customer** or **Vendor**. Shown only when the partner has both sides." },
              {
                name: "Type",
                what: "The kind of line.",
                values: "**Payment**, **Credit note**, **Adjustment**, **Opening balance**.",
              },
              { name: "Date", what: "The line's date.", values: "Within the statement period. Default the To Date." },
              { name: "Amount", what: "The amount in the side's currency.", values: "More than 0." },
              {
                name: "Effect on the balance",
                what: "Whether the line raises or lowers the balance.",
                values:
                  "**Raises (credit)** (default for Payment and Credit note) or **Lowers (charge)** (default for Adjustment and Opening balance).",
              },
              { name: "Description", what: "The text printed on the line.", values: "Required, up to 300 characters." },
              { name: "Note", what: "An internal note, shown under the line on screen. Optional." },
              {
                name: "SOA only / Changes the balance",
                what: "**SOA only** (default): the line appears on the statement only and balances do not change. **Changes the balance**: also records a real transaction (Receipt or Bill Payment, Credit Note, or Adjustment) so the balance changes too.",
              },
            ],
          },
        ],
      },
      {
        id: "how-to-send",
        title: "How to prepare and send SOAs",
        blocks: [
          {
            kind: "steps",
            items: [
              "Choose the partners, invoice type and period, and the e-mail template.",
              "Click **Search**.",
              "Click each partner to check its statement. Look at the amber difference line, the disputed block and the payments left off.",
              "Correct anything that needs it (see below).",
              "Tick the partners to send to and click **Send Email**.",
              "In the window, check the preview (use **Preview for** to switch partner). A red “no billing contact” means that one will fail.",
              "Click **Send … e-mails**. The sends run in the background; a message tells you when they are done. Each one appears on [[soa-report|SOA report]] with a copy of the statement as sent.",
            ],
          },
          {
            kind: "steps",
            title: "Export instead of sending",
            items: [
              "Tick the partners and click **Queue SOA Export · Excel** or **PDF**.",
              "When the message says they are done, download the files from [[soa-report|SOA report]].",
            ],
          },
        ],
      },
      {
        id: "how-to-adjust",
        title: "How to correct a statement by hand",
        blocks: [
          {
            kind: "list",
            items: [
              "**Remove** an invoice or vendor invoice line: click **Remove** on the line and type the reason (required). It moves to **Removed by hand**.",
              "**Take back** a manual line: click **Take back** on it. A balance-changing manual entry also deletes its transaction.",
              "**Add a line**: click **Manual entry** in the statement header, fill in the form and click **Add entry**.",
              "**Add a disputed vendor invoice** to the main lines: click **Add to SOA** in the disputed block (a note is optional).",
              "**Include a payment** that was left off: click **Include** in **Payments left off the SOA**.",
            ],
          },
          {
            kind: "text",
            text: "Every manual change is logged with your name and the time, and **Undo** takes it back. See [[undo-and-history]].",
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
              "Lines come from the system: customer invoices dated in the period (filtered by Invoice Type), accepted vendor invoices, and transactions marked **Include in SOA**.",
              "Accepted vendor invoices are added automatically, even ones accepted after the period was first looked at.",
              "The opening and closing balances use the same rule as every balance screen. See [[billing-basics#balances|balances]].",
              "Removing a line or adding an SOA-only entry changes the statement but not the partner's real balance; that is why the difference to the system balance is shown.",
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
            text: "A partner without a billing contact cannot receive an SOA. Its send fails and shows on SOA report with the error “The partner has no billing contact”.",
          },
          {
            kind: "tip",
            text: "In the trial, SOA e-mails are recorded in [[email-logs|Email logs]] instead of being sent.",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ SOA report
  {
    id: "soa-report",
    pageKey: "soa-report",
    title: "SOA report",
    group: "Finance",
    summary:
      "Every SOA that was e-mailed or exported, with its status and the file exactly as it was when it ran; download it or e-mail it again.",
    keywords: ["SOA report", "SOA history", "sent statements", "SOA export", "download SOA", "resend SOA"],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "Each **Send Email** or **Queue SOA Export** on the [[soa|SOA]] page creates one report per partner here. The billing team uses this page to see whether sends worked, to download the files, and to send a statement again. The file is always the statement as it was when the report ran; later changes never alter it.",
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
              "**New SOA** (the accent button): opens the [[soa|SOA]] page.",
              "**Export** is not available on this page.",
            ],
          },
          {
            kind: "fields",
            title: "Grid columns",
            fields: [
              { name: "ID", what: "The report number. Newest first." },
              { name: "Enterprise", what: "The partner." },
              { name: "From Date / To Date", what: "The statement period." },
              { name: "Invoice Type", what: "**All**, **Auto** or **Manual**." },
              { name: "File Type", what: "**Excel** or **PDF**." },
              { name: "Purpose", what: "**Export** (file only) or **E-mail** (sent to the partner)." },
              {
                name: "Status",
                what: "Where the report is.",
                values: "grey **Pending**, blue **Inprogress**, green **Success**, red **Failed**.",
              },
              { name: "Error", what: "Why it failed, in red." },
              { name: "E-mailed", what: "When it was last e-mailed." },
              { name: "Created Time", what: "When it was queued." },
              {
                name: "Download · Action",
                what: "Download the file, or send it by e-mail. Both only work when the status is Success.",
              },
            ],
          },
          {
            kind: "text",
            text: "Hidden columns include **Template**, **Closing Balance** and **Created By**.",
          },
          {
            kind: "text",
            text: "The detail panel shows the status and error, the statement settings, the closing balance, to whom and with which template it was e-mailed, and who created it (or “scheduled”). Buttons: **Download**, **Send Email** and **Open SOA**.",
          },
        ],
      },
      {
        id: "fields",
        title: "Fields in the Send SOA Email Notification window",
        blocks: [
          {
            kind: "fields",
            fields: [
              { name: "Enterprise", what: "The partner. Read-only." },
              {
                name: "Template",
                what: "The e-mail template to use.",
                values: "Required. An **SOA Statement** or **Send SOA** template.",
              },
            ],
          },
        ],
      },
      {
        id: "how-to",
        title: "How to download or re-send an SOA",
        blocks: [
          {
            kind: "steps",
            title: "Download",
            items: [
              "Find the report (filter **Enterprise** or the dates).",
              "Click the download icon, or **Download** in the detail panel. Excel files download as `.xls`, PDFs as `.pdf`, named after the partner's alias and the period.",
            ],
          },
          {
            kind: "steps",
            title: "Send again",
            items: [
              "Click the mail icon, or **Send Email** in the detail panel.",
              "Choose the template and click **Send**. The same file goes to the partner's current billing contacts, and **E-mailed** updates.",
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
            text: "To send a corrected statement, fix it on the [[soa|SOA]] page and send a new one; an old report never changes.",
          },
          {
            kind: "warning",
            text: "Sending fails when the partner has no billing contact. Add a finance contact on the enterprise first.",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ balances
  {
    id: "balances",
    pageKey: "balances",
    title: "Enterprise balance",
    group: "Finance",
    summary:
      "What every partner owes or has in credit right now: customer, vendor and net balance, credit limit use, billing cycle and currency.",
    keywords: [
      "balance",
      "enterprise balance",
      "customer balance",
      "vendor balance",
      "net balance",
      "credit limit",
      "credit used",
      "owes",
      "receivable",
      "payable",
    ],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "One row per enterprise that has billing settings. Billing and account managers use it to see who owes us, whom we owe, and who is close to their credit limit. The page is read-only: balances change through invoices, payments and accepted vendor invoices.",
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
            items: ["**Export**: downloads the filtered rows as a CSV file."],
          },
          {
            kind: "fields",
            title: "Grid columns",
            fields: [
              { name: "Enterprise Name", what: "The partner." },
              {
                name: "Customer Balance",
                what: "The customer side's balance in its billing currency. Positive = in credit; negative = owes us (amber). Hover for the words.",
              },
              {
                name: "Vendor Balance",
                what: "The vendor side's balance in its billing currency. Negative = we owe the vendor (amber).",
              },
              {
                name: "Net Balance",
                what: "Customer balance minus vendor balance, in the customer currency. Negative (amber) = the partner owes us after offsetting.",
              },
              { name: "Account Manager", what: "The partner's AM." },
              { name: "Billing", what: "**Prepaid** or **Postpaid** (customer side)." },
              { name: "Customer Credit", what: "The customer's credit limit." },
              {
                name: "Credit Used",
                what: "What the customer owes as a share of the credit limit.",
                values: "Plain below 80 %, amber from 80 %, red at 100 % or more.",
              },
              { name: "Billing Cycle", what: "The billing cycle in use." },
              { name: "Currency", what: "The currency of the net balance." },
            ],
          },
          {
            kind: "text",
            text: "A `—` means the side has no billing settings, or your visibility settings hide this partner's figures (see [[am-visibility]]).",
          },
          {
            kind: "list",
            title: "Detail panel",
            items: [
              "Each side's balance in words, the credit limit and how much is used, the net balance (with a note when the vendor side was converted), the account manager and billing cycle.",
              "**Send SOA**: opens the [[soa|SOA]] page for this partner.",
              "**Billing settings**: opens the enterprise's Billing tab (double-click or Enter does the same).",
              "**Transactions**: opens [[transactions|Transactions]]; filter **Name** there for this partner.",
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
              "Customer balance = opening balance + customer payments (credit +, debit −) − usage charges of traffic invoices.",
              "Vendor balance = opening balance + vendor payments (debit +, credit −) − accepted vendor invoices.",
              "Payments left off the SOA still count here.",
              "Usage is counted when it is invoiced, so traffic since the last invoice is not in these balances yet. Use the [[charges|Charges calculator]] to see it.",
              "When the two sides use different currencies, the vendor side is converted to the customer currency at today's rate for the net balance.",
              "See [[billing-basics#balances|how balances work]].",
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
            text: "Filter **Credit Used** with `>=` 80 to see every customer near the limit, or sort **Net Balance** ascending to see who owes most.",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ charges
  {
    id: "charges",
    pageKey: "charges",
    title: "Charges calculator",
    group: "Finance",
    summary:
      "Usage charges for any period, for one enterprise or all of them, per side, in the trunk currency and the platform currency, without making an invoice.",
    keywords: ["charges", "usage charges", "calculator", "revenue", "cost", "period charges", "unbilled"],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "Use it to answer “how much did this partner use between these dates?” without creating an invoice, for example to check traffic since the last invoice, or before generating one. It reads the traffic records directly and changes nothing.",
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
                name: "Enterprise",
                what: "One enterprise, or all of them.",
                values: "Empty shows **Select All** and calculates for every enterprise.",
              },
              {
                name: "Period From / Period To",
                what: "The period, both days included.",
                values: "Default from the 1st of this month to today. At most 366 days.",
              },
            ],
          },
          {
            kind: "text",
            text: "Click **Go** to calculate.",
          },
        ],
      },
      {
        id: "layout",
        title: "What you see in the result",
        blocks: [
          {
            kind: "list",
            items: [
              "**Period**: the dates and number of days. Days are cut in each enterprise's billing time zone.",
              "**Customer charges** and **Vendor charges**: the totals in the platform currency.",
              "**Both sides** / **Customers** / **Vendors**: shows only the rows of one side.",
            ],
          },
          {
            kind: "fields",
            title: "Table columns",
            fields: [
              { name: "Enterprise", what: "The partner." },
              { name: "Side", what: "**Customer** (what we charge) or **Vendor** (what we are charged)." },
              { name: "Time zone", what: "The billing time zone used to cut the days." },
              { name: "Messages", what: "Billable messages." },
              { name: "Usage charges", what: "The amount in the trunk's currency." },
              { name: "(platform currency)", what: "The same amount in the platform currency, e.g. `EUR`." },
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
              "Only billable messages count: each trunk decides whether it bills on attempt, submit, report or delivery.",
              "An enterprise can have more than one row per side when its trunks use different currencies.",
              "Platform currency amounts use the latest exchange rates.",
              "The result is not saved. See [[invoices|Invoices]] to bill the usage.",
            ],
          },
          {
            kind: "tip",
            text: "In the trial the traffic records cover a limited date range, so periods outside it show “No traffic in the period”.",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ currencies
  {
    id: "currencies",
    pageKey: "currencies",
    title: "Currencies",
    group: "Finance",
    summary: "The currency list and exchange rates: add currencies, set or sync rates, and see the full rate history.",
    keywords: [
      "currency",
      "currencies",
      "exchange rate",
      "FX",
      "rate per USD",
      "sync rates",
      "exchange history",
      "ISO",
      "platform currency",
    ],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "Finance and admins use this page to keep the list of currencies and their exchange rates. Rates are used to convert payments to the business company's base currency and to show cross-partner totals in the platform currency (the euro in the trial).",
          },
          {
            kind: "text",
            text: "The page has three views, switched at the top: **Currency**, **Currency Exchange** and **Exchange history**.",
          },
        ],
      },
      {
        id: "currency-view",
        title: "The Currency view",
        blocks: [
          {
            kind: "list",
            title: "Header buttons",
            items: ["**Add currency** (the accent button), **Undo**, **History** and **Export** (CSV)."],
          },
          {
            kind: "fields",
            title: "Grid columns",
            fields: [
              { name: "Currency ID", what: "The record number." },
              { name: "Currency", what: "The name, e.g. `Swiss Franc`." },
              { name: "ISO", what: "The three-letter code, e.g. `CHF`." },
              { name: "Symbol", what: "e.g. `Fr.`" },
              { name: "Rate per USD", what: "How many units of this currency make 1 USD, at the rate in force." },
              { name: "Enterprises", what: "How many enterprise billing settings use this currency." },
              { name: "Updated By", what: "Who last changed it (**seed data** for the starting list)." },
            ],
          },
          {
            kind: "text",
            text: "The detail panel shows the rate and since when, how many billing settings use the currency, and its history. **Edit** changes the name and symbol.",
          },
          {
            kind: "fields",
            title: "Fields in the currency form",
            fields: [
              { name: "Currency", what: "The name.", values: "Required, up to 60 characters." },
              { name: "Symbol", what: "The symbol.", values: "Required, up to 8 characters." },
              {
                name: "ISO",
                what: "The three-letter code. New currencies only; it cannot change later.",
                values: "Required, e.g. `CHF`. Must not exist already.",
              },
              {
                name: "Rate",
                what: "New currencies only: the starting rate.",
                values: "Units per 1 USD, e.g. `0.88`.",
              },
            ],
          },
        ],
      },
      {
        id: "exchange-view",
        title: "The Currency Exchange view",
        blocks: [
          {
            kind: "list",
            title: "Header buttons",
            items: [
              "**Sync Rates** (the accent button): pulls today's market rate for every currency. You confirm first.",
              "**Exchange history**: switches to the history view.",
              "**Undo** and **History**.",
            ],
          },
          {
            kind: "fields",
            title: "Grid columns",
            fields: [
              { name: "Info ID", what: "The record number." },
              { name: "ISO", what: "The code." },
              { name: "Currency", what: "The name." },
              {
                name: "Rate (per USD)",
                what: "The rate in force. The change from the previous rate is shown in brackets, e.g. `(+0.35 %)`.",
              },
              { name: "Updated Time", what: "Since when the rate applies (**base** for the starting rate)." },
              { name: "Updated By", what: "Who set it, or **market feed** for a sync." },
            ],
          },
          {
            kind: "fields",
            title: "Fields in the Edit rate form",
            fields: [
              {
                name: "Rate",
                what: "The new rate, in units of this currency per 1 USD. The hint shows the current rate and the change in %.",
                values: "e.g. `0.9215`. USD is always 1 and cannot be edited.",
              },
            ],
          },
        ],
      },
      {
        id: "history-view",
        title: "The Exchange history view",
        blocks: [
          {
            kind: "text",
            text: "Every rate ever set, newest first: **ISO**, **Currency**, **Rate (per USD)**, **Time** and **User**. Filter **ISO** to see one currency's history.",
          },
        ],
      },
      {
        id: "how-to",
        title: "How to change rates",
        blocks: [
          {
            kind: "steps",
            title: "Set one rate by hand",
            items: [
              "Open **Currency Exchange**.",
              "Double-click the currency, or click **Edit** in the detail panel.",
              "Enter the new rate and check the % change in the hint.",
              "Click **Save rate**.",
            ],
          },
          {
            kind: "steps",
            title: "Sync all rates",
            items: ["Open **Currency Exchange** and click **Sync Rates**.", "Click **Sync rates** to confirm."],
          },
          {
            kind: "steps",
            title: "Add a currency",
            items: [
              "On **Currency**, click **Add currency**.",
              "Enter the name, symbol, ISO code and starting rate.",
              "Click **Add currency**.",
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
              "All rates are per 1 USD. To convert between two other currencies, the amount goes through USD.",
              "A new rate applies from the moment it is saved. Earlier rates stay in the history, so amounts already converted keep their rate.",
              "**Undo** on a rate change sets the earlier rate again from now on; the history is never rewritten.",
              "Currencies cannot be deleted from this page.",
              "See [[billing-basics#currencies|currencies and conversion]].",
            ],
          },
          {
            kind: "tip",
            text: "In the trial, **Sync Rates** does not reach a real market feed: it moves each rate by a small random amount (up to about 0.6 %).",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ billing cycles
  {
    id: "billing-cycles",
    pageKey: "billing-cycles",
    title: "Billing cycles",
    group: "Finance",
    summary:
      "Named billing cycles such as “Monthly – Net 7”: how long each usage period is and how many days the customer has to pay.",
    keywords: [
      "billing cycle",
      "cycle",
      "net 7",
      "net 30",
      "monthly",
      "weekly",
      "fortnightly",
      "due days",
      "usage days",
    ],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "A billing cycle is chosen on each enterprise's Billing tab. It sets how much usage goes on one invoice and when payment is due. Finance and admins keep the list of cycles here.",
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
              "**Add cycle** (the accent button), **Undo** and **History**. **Export** is not available on this page.",
            ],
          },
          {
            kind: "fields",
            title: "Grid columns",
            fields: [
              { name: "Info ID", what: "The record number." },
              { name: "Name", what: "e.g. `Monthly – Net 7`." },
              { name: "Usage Days", what: "Days of usage per invoice." },
              { name: "Due Days", what: "Days after the invoice date that payment is due." },
              { name: "Billing Type", what: "**Monthly**, **Fortnightly**, **Weekly**, **Daily** or **Custom**." },
              { name: "Week Day", what: "The day a weekly or fortnightly cycle starts." },
              { name: "Enterprises", what: "How many enterprises are billed on it." },
              {
                name: "Updated By / Updated Time",
                what: "Who last changed it and when (**seed data** for the starting list).",
              },
            ],
          },
          {
            kind: "text",
            text: "The detail panel shows the usage period, the payment due rule and how many enterprises use the cycle, with **Edit** and **Delete**, and a **History** tab.",
          },
        ],
      },
      {
        id: "fields",
        title: "Fields in the billing cycle form",
        blocks: [
          {
            kind: "fields",
            fields: [
              {
                name: "Name",
                what: "The name shown on the enterprise's Billing tab.",
                values: "Required, up to 60 characters, unique (not case-sensitive). e.g. `Monthly – Net 7`.",
              },
              {
                name: "Billing Type",
                what: "The kind of cycle. Choosing Daily, Weekly or Fortnightly fixes **Usage Days**.",
                values:
                  "**Monthly** (default), **Fortnightly** (14 days), **Weekly** (7 days), **Daily** (1 day), **Custom**.",
              },
              {
                name: "Week Day",
                what: "The day the cycle starts.",
                values: "MON–SUN. Required for Weekly and Fortnightly (default MON); not used for the others.",
              },
              {
                name: "Usage Days",
                what: "Days of usage per invoice. Locked for Daily, Weekly and Fortnightly.",
                values: "1–366. Default `30`.",
              },
              {
                name: "Due Days",
                what: "Days after the invoice date the payment is due. Used when an invoice's due date type is Auto.",
                values: "0–180. Default `7`.",
              },
            ],
          },
        ],
      },
      {
        id: "how-to",
        title: "How to add, edit or delete a cycle",
        blocks: [
          {
            kind: "steps",
            title: "Add",
            items: [
              "Click **Add cycle**.",
              "Enter the name, choose the billing type (and week day if asked), and set usage days and due days.",
              "Click **Add cycle**.",
            ],
          },
          {
            kind: "steps",
            title: "Edit",
            items: [
              "Double-click the row or click **Edit** in the detail panel.",
              "Change the fields and click **Save**. If enterprises use the cycle, the form says how many; the change applies to their next invoices.",
            ],
          },
          {
            kind: "steps",
            title: "Delete",
            items: [
              "Click **Delete** in the detail panel.",
              "Delete is blocked while any enterprise is billed on the cycle. Move those enterprises to another cycle first. See [[safe-delete]].",
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
            text: "Put the payment terms in the name (e.g. `Weekly – Net 7`) so they are clear when someone picks a cycle on the Billing tab.",
          },
          {
            kind: "text",
            text: "See [[billing-basics#cycles-and-invoices|how cycles drive invoices]].",
          },
        ],
      },
    ],
  },
];
