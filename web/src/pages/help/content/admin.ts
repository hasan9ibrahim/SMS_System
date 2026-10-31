// Help center: Admin (§11, §13.10, §13.17, §13.19, §13.20, §13.22, §13.28).
import type { HelpTopic } from "../helpTypes";

export const topics: HelpTopic[] = [
  // ------------------------------------------------------------------ change history
  {
    id: "change-history",
    pageKey: "change-history",
    title: "Change history",
    group: "Admin",
    summary:
      "Every save, with who, when and exactly which fields changed, and an Undo button per change. You see your own saves; administrators and directors see everyone's, and a department's manager sees that department's. **My changes** shows only your own saves.",
    keywords: ["undo", "history", "my changes", "audit", "revert", "rollback", "who changed", "before after", "diff"],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: 'Every time someone saves a record (a route rule, a rate, a trunk, a user, a template and so on) the system writes one **change**. This page lists the ones you may see, newest first. Use it to answer "who changed this, and when?", to see the exact before and after values, and to undo a mistake.',
          },
          {
            kind: "text",
            text: "Open **My changes** from your avatar menu (top right) to see the same page filtered to your own saves. Everyone can use it for their own work. Administrators and directors (the Management department) see the full list; a department's manager sees the changes of the people in that department, to follow the team.",
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
              { name: "Change", what: "The change number. Numbers only go up, one per save.", values: "e.g. `#4521`" },
              { name: "Time (UTC)", what: "When the save happened, in UTC (world time, not your local time)." },
              { name: "Note", what: "The reason the user typed when saving, if any." },
              { name: "User", what: "Who saved it." },
              {
                name: "Type",
                what: "What kind of save it was. **Undo** rows are highlighted.",
                values: "Create, Edit, Clone, Delete, Reorder, Enable, Disable, Bulk, Undo, Import, Cleanup",
              },
              { name: "Record type", what: "Which kind of record changed, e.g. Route rule, Rate, User." },
              {
                name: "Record ID",
                what: 'The ID of the record(s) changed. A bulk change shows the first three IDs and "+N" for the rest.',
              },
              {
                name: "What changed",
                what: 'The change as a short sentence with record names. Hover it to see more fields. On the right: an **Undo** button when you may undo it, or "undone by #N" when it was already undone.',
              },
            ],
          },
          {
            kind: "fields",
            title: "Detail panel (click a row)",
            fields: [
              { name: "Summary", what: "The full sentence describing the change (shown when the change has one)." },
              {
                name: "Fields",
                what: "One line per field touched: **Record**, **Field**, **Before**, **After**. When a list changed (for example the vendors of a rule), green `+` lines show what was added and red `−` lines what was removed.",
              },
              {
                name: "About",
                what: 'Record type, every record touched (up to 20 by name, then "+N more"), Note, the IP address the save came from, and **Undo of** when this change is itself an undo.',
              },
              { name: "Undo this change", what: "Button on the right of the panel, shown only when you may undo it." },
            ],
          },
          {
            kind: "text",
            text: "Filter any column with the box under its header, or build a multi-field filter. See [[grids-and-filters]] and [[filter-builder]].",
          },
        ],
      },
      {
        id: "how-to-undo",
        title: "How to undo a change",
        blocks: [
          {
            kind: "steps",
            items: [
              "Find the change: filter **User**, **Record type**, **Record ID** or **Time (UTC)**, or open **My changes**.",
              "Click the row and check the **Fields** tab: these are exactly the fields the undo will put back.",
              "Click **Undo** in the row (or **Undo this change** in the panel).",
              "If nobody changed the same fields since, it is done at once. A message confirms it and offers **Redo** for 10 seconds.",
              'If someone else changed one of the same fields later, a box shows both values ("you set 60, A. User later set 70"). Choose **Keep current**, **Restore mine** or **Cancel**.',
            ],
          },
          {
            kind: "list",
            title: "The conflict choices",
            items: [
              "**Keep current**: undoes only the fields nobody changed since. The later work stays.",
              "**Restore mine**: puts your earlier values back everywhere, overwriting the later edit.",
              "**Cancel**: changes nothing.",
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
              "One save is one change. A bulk operation (for example replacing a vendor on 24 rules) is one change and is undone as one.",
              "Undo restores only the fields that change touched. Other people's later edits to other fields are kept.",
              "An undo is itself a change (type **Undo**, with **Undo of #N**). You can undo an undo to apply the original again.",
              "Undoing a delete brings the record back with its original ID.",
              "Undoing a Cleanup center change opens its findings again. Undoing a Migration import change rolls the whole import back. See [[cleanup]] and [[migration]].",
              "The restored values take effect straight away, the same as a normal save.",
              "The same history is shown on each record's **History** tab, and the **Undo** button in page headers and Ctrl+Z undo your last change on that page. See [[undo-and-history]].",
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
            text: "You see and can undo your own changes. Administrators and directors (the **Management** department) see and undo everyone's; a department's manager ([[departments]]) sees and undoes the changes of the people in that department. Other people's changes are not listed for anyone else.",
          },
          {
            kind: "tip",
            text: 'A change that was already undone shows "undone by #N" instead of a button. Undo the undo if you need it back.',
          },
          {
            kind: "tip",
            text: "Re-rating requests are not undone here. Edit or decline a pending request on the [[re-rating]] page instead.",
          },
          {
            kind: "tip",
            text: "Change history shows field values. The [[audit|Audit trail]] lists every call that changed something, including ones that failed.",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ users
  {
    id: "users",
    pageKey: "users",
    title: "Users",
    group: "Admin",
    summary:
      "Staff accounts: who they are, their department and access group, their password state and 2FA. Set temporary passwords, force a password change and turn on 2FA here.",
    keywords: [
      "staff",
      "accounts",
      "login",
      "password",
      "temporary password",
      "change others passwd",
      "force change",
      "2FA",
      "TOTP",
      "QR",
      "authenticator",
      "account manager",
      "AM",
    ],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "Admins use this page to add and edit staff users (admins, managers, account managers, NOC, billing), decide what each person can open (through their **GUI Access Group**), and look after their passwords and two-factor sign-in (2FA). Customer logins for the self-service portal are on [[customer-portal]] instead.",
          },
        ],
      },
      {
        id: "layout",
        title: "What you see on the page",
        blocks: [
          {
            kind: "text",
            text: "The header has the filled **Add user** button. The grid lists every user; click a row to see the detail panel on the right, double-click (or Enter) to edit. Tick rows to act on several users at once. Plain text in the quick search box matches the start of a value (`ann` finds names starting with Ann); type `%ann` to find it anywhere.",
          },
          {
            kind: "fields",
            title: "Grid columns",
            fields: [
              { name: "Info ID", what: "The user's ID number." },
              { name: "Department", what: "The department the user belongs to." },
              { name: "UserName", what: "The sign-in name." },
              { name: "Name", what: "First and last name." },
              { name: "Email", what: "Work e-mail address. Reminders and notices go here." },
              { name: "User Type", what: "**Wholesale** (uses the GUI) or **Api** (connects by API only)." },
              { name: "GUI Access Group", what: "The role that decides which pages and buttons the user sees." },
              { name: "Status", what: "Green dot **Active**, grey dot **Inactive**." },
              {
                name: "Password",
                what: 'The password state in words, with a coloured dot: green "N days left", amber when it expires within 7 days or must be changed at next login, red "Expired N days ago", grey "Temporary · N h left". Hover to see when it was last changed.',
                values: "Filter by OK, Expiring (7 days), Expired, Temporary, Must change",
              },
              { name: "Password Changed", what: "Date and time of the last password change (UTC)." },
              {
                name: "Days Left",
                what: "Days until the password expires. Amber at 7 or fewer, red when negative (already expired).",
              },
              { name: "2FA", what: "**On** when the authenticator app is set up. **Off** is shown in amber." },
              { name: "Account Manager", what: "Yes when the user is an account manager." },
              { name: "Last Login", what: 'When the user last signed in, or "never". Hidden by default.' },
            ],
          },
          {
            kind: "text",
            text: "More columns can be added with **Columns**: Director / Head, Team Lead / Manager, Business Company and Sessions. Tick **Show deleted** to see archived users (greyed out).",
          },
          {
            kind: "fields",
            title: "Detail panel tabs",
            fields: [
              {
                name: "Profile",
                what: "Email, phone, user type and roles, business company, who they report to, address, whether several logins are allowed, how many live enterprises they manage as Account Manager, and who updated the record last. Buttons: **Edit**, **Delete**.",
              },
              {
                name: "Password & 2FA",
                what: "Password state, last changed, expiry date, temporary password end time, whether QR 2FA (TOTP) is enabled, last login and open sessions. Buttons: **Change password**, **Force change**, **Enable QR 2FA** or **Disable QR 2FA**.",
              },
              {
                name: "Visibility",
                what: "The user's effective visibility policy: what they see of other Account Managers' enterprises. Admins get a **Preview as** button. See [[visibility]].",
              },
              { name: "History", what: "Every saved change to this user, their password and 2FA, with Undo." },
            ],
          },
        ],
      },
      {
        id: "fields",
        title: "Fields in the user form",
        blocks: [
          {
            kind: "fields",
            title: "Add user / Edit user",
            fields: [
              { name: "First Name", what: "Required. Up to 80 characters." },
              { name: "Last Name", what: "Required. Up to 80 characters." },
              {
                name: "UserName",
                what: "Required. The name used to sign in. Must be unique.",
                values: "Lower case letters, digits, dot, dash, underscore; up to 40 characters. e.g. `j.smith`",
              },
              { name: "Email", what: "Required. Work e-mail address.", values: "e.g. `j.smith@example.com`" },
              { name: "Phone", what: "Optional phone number." },
              {
                name: "Department",
                what: "Required. The user's department (managed on [[departments]]). Used by visibility assignments and team reports.",
              },
              {
                name: "GUI Access Group",
                what: "The role that decides which menus, pages and buttons the user sees. See [[access-groups]].",
              },
              {
                name: "Business Company",
                what: "The selling company the user works for (see [[business-companies]]).",
              },
              {
                name: "Reports to (Director / Head)",
                what: "The user's manager. Type to search users. Used for team reports and for team visibility.",
              },
              {
                name: "Api User",
                what: "Required. Whether this is a person using the GUI or an API connection.",
                values: "No (Wholesale GUI user) — default; Yes (Api user)",
              },
              {
                name: "Status",
                what: "Required. **Inactive** users cannot sign in but keep their history.",
                values: "Active (default), Inactive",
              },
              {
                name: "OTP verification",
                what: "Required. How the user proves who they are with a one-time code at sign-in.",
                values:
                  "Off (default), Code by e-mail, Authenticator app (Google Authenticator). With the app, enrol it with **Enable QR 2FA** after saving.",
              },
              { name: "Language", what: "Required. Language of the screens.", values: "English" },
              {
                name: "Account manager",
                what: 'Tick when the user manages enterprises as account manager. Visibility policies assigned to "All account managers" apply to them.',
              },
              {
                name: "Director / Head",
                what: "Tick for heads of a team. Their team members' work shows in team reports, and a visibility policy can let them see their team's enterprises.",
              },
              {
                name: "Allow multiple logins",
                what: "When ticked, the user can be signed in on several devices at once. Off means one session at a time.",
              },
              {
                name: "Access exceptions",
                what: "Overrides the GUI access group for this user only. Per page: Inherit, No access, View only or Full. Per tab or section: Inherit, Show or Hide. No access wins even over the group's Every page.",
              },
              { name: "Address 1", what: "Required. Street address." },
              { name: "Address 2", what: "Optional second address line." },
              { name: "Country", what: "Required. Pick from the list.", values: "Default `AE`" },
              { name: "State", what: "Optional." },
              { name: "City", what: "Optional." },
              { name: "Zip Code", what: "Optional, up to 20 characters." },
              {
                name: "Temporary password",
                what: "Only when adding a user. The first password, valid for 24 hours. The user must change it at first sign-in. The rules below the box tick green as they are met.",
                values: "At least 12 characters, not the username or name, not on a known-leaked list",
              },
            ],
          },
          {
            kind: "fields",
            title: "Change password dialog (temporary password)",
            fields: [
              {
                name: "New Password *",
                what: "The temporary password you give the user. **Show** reveals what you typed.",
              },
              {
                name: "Confirm Password *",
                what: 'Type it again. "the passwords do not match" appears until both are the same.',
              },
              {
                name: "Password rules",
                what: "Each rule ticks as it is met: at least 12 characters; not the username or name; not one of the user's last 12 passwords; not on a known-leaked password list.",
              },
            ],
          },
          {
            kind: "fields",
            title: "Enable QR 2FA dialog",
            fields: [
              { name: "Create secret", what: "Makes a new secret key for this user." },
              {
                name: "Key and otpauth link",
                what: "The secret, in groups of four characters, and a link that can be turned into a QR code. Add either to an authenticator app on the user's phone.",
              },
              {
                name: "6-digit code",
                what: "The code the app shows now. **Confirm** stays disabled until 6 digits are typed.",
              },
            ],
          },
        ],
      },
      {
        id: "how-to-add",
        title: "How to add a user",
        blocks: [
          {
            kind: "steps",
            items: [
              "Click **Add user**.",
              "Fill in the name, **UserName**, **Email**, **Department** and address. Choose the **GUI Access Group** (what they may open).",
              "Tick **Account manager** and/or **Director / Head** if they apply.",
              "Type a **Temporary password** that meets every rule, and give it to the user by a safe route (not in the same e-mail as the username).",
              "Click **Add user**. The user has 24 hours to sign in and choose their own password.",
              "If they will use an authenticator app, open the user's **Password & 2FA** tab and click **Enable QR 2FA**.",
            ],
          },
        ],
      },
      {
        id: "how-to-passwords",
        title: "How to reset or force a password change",
        blocks: [
          {
            kind: "steps",
            title: "Give a user a temporary password",
            items: [
              "Click the user and open the **Password & 2FA** tab.",
              "Click **Change password**.",
              "Type the **New Password *** twice, until every rule ticks.",
              "Click **Set temporary password**. It is valid 24 hours, the user's open sessions are signed out, and they must change it at their next sign-in.",
            ],
          },
          {
            kind: "steps",
            title: "Force one or more users to change their password",
            items: [
              "For one user: open **Password & 2FA** and click **Force change**. The button is greyed out when the user already has to change it.",
              "For several: tick their rows in the grid, then choose **Force a password change (N)** from the selection bar.",
              'Their Password column shows "Must change at next login". Their current password still works, but only to reach the Change Password screen.',
            ],
          },
          {
            kind: "steps",
            title: "Let users choose their own password (e-mailed link)",
            items: [
              "For one user: open the row's **More** menu and choose **E-mail password link…**. For several: tick their rows and choose **E-mail password links (N)** from the selection bar. After a Migration Center import, **E-mail password links** on the import does it for the users it created.",
              "Click **E-mail the link**. Each user gets an e-mail with the Xpert logo and a link that works once, for 72 hours; a new link replaces the earlier one.",
              "The link opens the **Set your password** screen: the user types a password until every rule ticks, then signs in as usual with the sign-in code. The link never signs anyone in.",
              "The result lists the users skipped (deleted, inactive, no e-mail, or an administrator when you are not one) and any address that got links for several users: whoever reads a shared mailbox can set those passwords, so give each user their own address or set a temporary password instead.",
            ],
          },
        ],
      },
      {
        id: "how-to-2fa",
        title: "How to turn 2FA on or off for a user",
        blocks: [
          {
            kind: "steps",
            items: [
              "Open the user's **Password & 2FA** tab and click **Enable QR 2FA**.",
              "Click **Create secret**.",
              "On the user's phone, open an authenticator app (for example Google Authenticator), choose to add an account and type the key (or scan the link as a QR code).",
              "Type the 6-digit code the app shows into **6-digit code** and click **Confirm**.",
              "To remove it (for example when a phone is lost), click **Disable QR 2FA** and confirm. Then enrol the new phone the same way.",
            ],
          },
          { kind: "text", text: "See [[passwords-and-2fa]] for the full password and 2FA rules." },
        ],
      },
      {
        id: "how-to-delete",
        title: "How to delete (archive) a user",
        blocks: [
          {
            kind: "steps",
            items: [
              "Click the user, open **Profile** and click **Delete**.",
              "The dialog lists what depends on the user: live enterprises they manage, users who report to them, and open sessions (which are signed out).",
              "If they are account manager of live enterprises, delete is blocked: hand those enterprises to another Account Manager first.",
              "Otherwise confirm. The user is archived, not erased. An administrator can **Restore** them with **Show deleted** ticked.",
            ],
          },
          { kind: "text", text: "See [[safe-delete]]." },
        ],
      },
      {
        id: "tips",
        title: "Tips and things to watch",
        blocks: [
          {
            kind: "tip",
            text: "Click a number on [[security|Security settings]] (for example Expired) to open this list filtered on that password state.",
          },
          {
            kind: "tip",
            text: "Every save here (profile, password reset, forced change, 2FA) is one change you can undo from **History** or the page header.",
          },
          {
            kind: "warning",
            text: "The password itself is never shown or stored, only a secure fingerprint of it. If a user forgets theirs, set a new temporary password.",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ access groups
  {
    id: "access-groups",
    pageKey: "access-groups",
    title: "GUI access groups",
    group: "Admin",
    summary:
      "Roles: for every page of the menu, which buttons (View, Add, Edit, Delete, Export and so on) the members of a group may use.",
    keywords: [
      "roles",
      "permissions",
      "rights",
      "access",
      "menu",
      "buttons",
      "RBAC",
      "export credentials",
    ],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: 'A GUI access group is a role, such as "NOC", "Billing" or "Account manager". It decides which menus and pages its users see, and which buttons work on each page. Every user gets one group on the [[users]] page. Admins set groups up once and change them when a role\'s duties change.',
          },
          {
            kind: "text",
            text: "The server checks every action against the group, reading included. A page the group does not give cannot be reached from another page either: its tabs, sections and buttons on other pages are hidden, and forms on other pages only show the names of its records in their pickers (for example a vendor trunk's name, enterprise and category, never its connection details). Global search and History only show records of pages the group gives.",
          },
          {
            kind: "text",
            text: "Admin pages (everything under Admin) are for administrators only. **Every page** never includes them; a group gets an Admin page only when that page is ticked on its own. A group with **Administrator** ticked makes its users full administrators: every page, the Admin pages included, and what only administrators may do. Only an administrator can tick it, change such a group, give it to a user, or change an administrator.",
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
              { name: "Info ID", what: "The group's ID." },
              { name: "Access Group Name", what: "The role's name." },
              { name: "Description", what: "What the role is for." },
              { name: "Pages", what: "How many pages the group may open, or **All** when it has the Every page row." },
              { name: "Every Page", what: "Yes when actions are granted on all pages at once (never the Admin pages)." },
              { name: "Administrator", what: "Yes when the group makes its users full administrators (the Admin pages included)." },
              { name: "Users", what: "How many users have this group." },
              { name: "Status", what: "Green **Active** or grey **Inactive**." },
            ],
          },
          {
            kind: "fields",
            title: "Detail panel tabs",
            fields: [
              {
                name: "Pages and buttons",
                what: "The group's permission matrix, read-only. Buttons: **Clone**, **Users** (opens the Users list filtered on this group), **Edit**, **Delete**.",
              },
              { name: "Info", what: "Description, number of users, last update." },
              { name: "History", what: "Every saved change to this group, with Undo." },
            ],
          },
        ],
      },
      {
        id: "fields",
        title: "Fields in the group form",
        blocks: [
          {
            kind: "fields",
            title: "Add GUI access group / Edit",
            fields: [
              { name: "Access Group Name", what: "Required, up to 80 characters.", values: "e.g. `NOC shift`" },
              { name: "Status", what: "Required.", values: "Active (default), Inactive" },
              { name: "Description", what: "Optional, up to 500 characters." },
              {
                name: "Administrator",
                what: "Full administrator: every page, the Admin pages included, and the actions only administrators have; the matrix then does not limit the group. Only an administrator can change it. The starting **Administrator** group has it.",
              },
              { name: "Find a page…", what: "Type part of a page name to show only matching rows of the matrix." },
              {
                name: "Every page row",
                what: 'Ticks here grant that action on every page that has it. Pages covered this way show their box ticked and greyed out ("Granted by Every page").',
              },
              {
                name: "Section row (all / none)",
                what: "Each menu section (Dashboard, Live, Enterprises, Finance, Rates, Routing, Switch, Monitoring, Reports, Admin) has **all** and **none** links to grant or clear every page in it.",
              },
              {
                name: "Page checkbox",
                what: "The box before a page name turns on every action that page has, or clears them all. It shows a dash when only some are on.",
              },
              {
                name: "Action boxes",
                what: "One box per action the page has. Pages without an action show an empty cell.",
              },
              {
                name: "Tabs and sections",
                what: "Untick a tab or form section to hide it from the group, e.g. the Enterprise **Docs** tab or the vendor trunk **Connection** section. A single user can be given an exception with **Access exceptions** on [[users|Users]]. Pages without View are hidden from the menu and Ctrl K; opening one by link shows **No access**.",
              },
            ],
          },
          {
            kind: "fields",
            title: "The actions (matrix columns)",
            fields: [
              { name: "View", what: "Open the page and read its records. Every other action needs View." },
              { name: "Add", what: "Create records." },
              { name: "Edit", what: "Change records." },
              { name: "Delete", what: "Archive records (safe delete)." },
              { name: "Export", what: "Download lists and files." },
              { name: "Import", what: "Upload files that change records." },
              { name: "Send", what: "E-mail partners (rates, invoices, statements)." },
              { name: "Approve", what: "Approve or reject requests (one person makes, another checks)." },
              { name: "Start / stop", what: "Start or stop binds and jobs." },
              { name: "Change passwords", what: "Set other users' temporary passwords (Users, Customer portal)." },
              {
                name: "Export credentials",
                what: "Sensitive exports with trunk connection details. Also needs 2FA, and only admins can actually include credentials ([[migration]]).",
              },
            ],
          },
        ],
      },
      {
        id: "how-to",
        title: "How to add, clone or change a group",
        blocks: [
          {
            kind: "steps",
            title: "Add a group",
            items: [
              "Click **Add group**. A new group starts with only **Dashboard: View**.",
              "Type the **Access Group Name** and a **Description**.",
              "Use **all** on a section or the page checkbox for broad rights, then untick single actions you do not want.",
              "Click **Add group**, then give it to users on the [[users]] page.",
            ],
          },
          {
            kind: "steps",
            title: "Clone a group",
            items: [
              "Click the group, then **Clone** in the detail panel.",
              'Type the name of the copy (it suggests "Name (copy)").',
              "Edit the copy. The original is not touched.",
            ],
          },
          {
            kind: "steps",
            title: "See who has a group",
            items: ["Click the group and then **Users**. The Users list opens filtered on that group."],
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
              "Ticking any action also ticks **View** on that page. Unticking **View** clears every action on that page.",
              "A page with no action ticked disappears from the menu of the group's users.",
              "Rights from the **Every page** row and from single pages add up.",
              "A save takes effect for every member of the group. It is one change you can undo.",
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
            text: "A group cannot be deleted while users have it. Give them another group first (use **Users** to find them).",
          },
          {
            kind: "tip",
            text: "Keep **Change passwords** for supervisors and admins only. Seeing and undoing other people's changes follows the person (administrator, director or department manager), not a permission ([[change-history]]).",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ visibility
  {
    id: "visibility",
    pageKey: "visibility",
    title: "Visibility policies",
    group: "Admin",
    summary:
      "Account manager visibility mode: show other Account Managers' enterprises as IDs, hide money and contact data, and give someone temporary sight of an enterprise.",
    keywords: [
      "Account Manager visibility",
      "masking",
      "hide margin",
      "hide revenue",
      "policy",
      "presets",
      "share",
      "temporary access",
      "preview as",
      "view as",
    ],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: 'A visibility policy limits what an account manager sees of clients and vendors that are not theirs. Other Account Managers\' enterprises and trunks can appear only as IDs ("Customer #2481"), and items such as margin, revenue, costs, balances and contact details can be hidden. Admins set this up; it applies everywhere: lists, records, search and exports.',
          },
          {
            kind: "text",
            text: "The page has three views, picked with the switch above the grid: **Policies**, **Assignments** and **Shares & temporary access**. See also [[am-visibility]].",
          },
        ],
      },
      {
        id: "policies",
        title: "Policies view",
        blocks: [
          {
            kind: "fields",
            title: "Grid columns",
            fields: [
              { name: "Name", what: "The policy's name." },
              { name: "Status", what: "Green **Active** or grey **Inactive**." },
              { name: "Masks Others", what: "Yes when others' enterprises and trunks show as IDs." },
              {
                name: "Team Counts as Own",
                what: "Yes when a team lead's team members' enterprises count as their own.",
              },
              { name: "Assignments", what: "How many assignments use the policy." },
              { name: "Description", what: "Your description, followed by a short summary of what the policy hides." },
              { name: "Updated", what: "Last change." },
            ],
          },
          {
            kind: "text",
            text: "Click **New policy** to create one, or double-click a row to edit it.",
          },
        ],
      },
      {
        id: "policy-fields",
        title: "Fields in the policy form",
        blocks: [
          {
            kind: "fields",
            title: "New visibility policy / Visibility policy",
            fields: [
              {
                name: "Start from a preset",
                what: "Only on a new policy. Fills the whole form from a ready policy, which you can then change.",
                values:
                  "Strict Account Manager (others masked, all money hidden), Standard Account Manager (others masked, own money shown), Team lead (team shown, others masked)",
              },
              { name: "Name", what: "Required, up to 120 characters." },
              { name: "Status", what: "Active or Inactive." },
              { name: "Description", what: "Optional, up to 500 characters." },
              {
                name: "Mask others' enterprises and trunks as IDs",
                what: 'When ticked, enterprises and trunks of other Account Managers show as neutral IDs such as "Customer #2481" everywhere: lists, search, records and exports. The ID stays the same, so traffic can still be followed. On by default.',
              },
              {
                name: "For team leads: their team members' enterprises count as own",
                what: "When ticked, a user marked Director / Head also sees their team's enterprises as their own.",
              },
              {
                name: "Item table",
                what: "For each item, choose what is shown for **Others' clients and vendors** and for **Own**. Choices: **Shown**, **Hidden**, and for margin only **Band**.",
                values:
                  "Items: Margin and margin %; Revenue; Cost / vendor buy rates; Customer sell rates; Balances, credit limits, invoices, payments; Contact details, IPs, usernames, passwords; Traffic volumes (attempts, TPS). New policy default: others Hidden, own Shown, traffic Shown for both.",
              },
              {
                name: "Margin band: Low below (%)",
                what: 'With **Band**, margins under this show as "Low".',
                values: "Default `5`",
              },
              {
                name: "Margin band: High above (%)",
                what: 'Margins over this show as "High"; in between is "Normal". Must not be below Low.',
                values: "Default `20`",
              },
              {
                name: "Show revenue only up to (platform currency)",
                what: "Revenue above this amount is hidden. Leave empty for no limit.",
                values: "e.g. `10000`; not below 0",
              },
              {
                name: "Cost of vendors carrying own clients' traffic, last (days)",
                what: "Vendors that carried the user's own clients' traffic in this many days count as own for cost, so their buy rates show. Leave empty for never.",
                values: "1 to 365, e.g. `30`",
              },
            ],
          },
          {
            kind: "warning",
            text: "**Save** stays disabled until the policy has a name, Low is not above High, and Band is used for margin only.",
          },
        ],
      },
      {
        id: "assignments",
        title: "Assignments view",
        blocks: [
          {
            kind: "fields",
            title: "Grid columns",
            fields: [
              { name: "Assigned To", what: "All account managers, Department, or User." },
              { name: "Target", what: "The department or user name." },
              { name: "Policy", what: "The policy given." },
              { name: "Users", what: "How many users get their policy from this assignment right now." },
              { name: "Assigned By", what: "Who made the assignment." },
              { name: "Assigned", what: "When." },
              { name: "Remove", what: "Link at the end of the row that removes the assignment." },
            ],
          },
          {
            kind: "fields",
            title: "Assign a visibility policy dialog",
            fields: [
              {
                name: "Assign to",
                what: "Who gets the policy.",
                values: "A user (default), A department, All account managers",
              },
              {
                name: "User / Department",
                what: "Search and pick the user or department (not asked for All account managers).",
              },
              { name: "Policy", what: "Search and pick the policy. Its summary shows under each choice." },
            ],
          },
          {
            kind: "text",
            text: "Above the grid, **Check a user's effective policy** shows which policy a chosen user really gets, where it comes from and how many enterprises count as their own, team or granted.",
          },
        ],
      },
      {
        id: "grants",
        title: "Shares & temporary access view",
        blocks: [
          {
            kind: "fields",
            title: "Grid columns",
            fields: [
              { name: "User", what: "Who was given sight." },
              { name: "Enterprise", what: "The enterprise they can now see." },
              { name: "Kind", what: "**Temporary** (ends by itself) or **Lasting share**." },
              { name: "State", what: "Green **Active**; hollow dot for **Expired** or **Revoked**." },
              { name: "Expires", what: "End time for temporary access (UTC)." },
              { name: "Reason", what: "Why it was granted." },
              { name: "Granted By", what: "The admin who granted it." },
              { name: "Granted", what: "When." },
              { name: "Revoke", what: "Link on active rows that ends the access now." },
            ],
          },
          {
            kind: "fields",
            title: "Grant sight of an enterprise dialog",
            fields: [
              { name: "User", what: "Required. The person who needs to see the enterprise." },
              {
                name: "Enterprise",
                what: "Required. Shows the enterprise's current Account Manager under each choice.",
              },
              {
                name: "Temporary / Lasting share",
                what: "Temporary ends at a set time; Lasting share stays until revoked.",
              },
              {
                name: "Until (UTC) — expires by itself",
                what: "Only for Temporary. The end date and time in UTC.",
                values: "Default: 7 days from now",
              },
              {
                name: "Reason",
                what: "Required, up to 300 characters.",
                values: "e.g. `covering a colleague on holiday`",
              },
            ],
          },
        ],
      },
      {
        id: "how-to",
        title: "How to set up visibility mode",
        blocks: [
          {
            kind: "steps",
            items: [
              "In **Policies**, click **New policy**, pick a preset (for example **Standard Account Manager**), adjust it and **Save**.",
              "Switch to **Assignments** and click **Assign policy**. Choose **All account managers**, a department or one user, pick the policy and click **Assign**.",
              "Check the result: pick a user under **Check a user's effective policy**, then click **Preview as** to browse the system the way they see it.",
              "A strip under the tabs says whose view you are previewing. Click **End preview** to go back to your own view.",
              "To let someone cover a colleague, switch to **Shares & temporary access**, click **Grant access**, fill in user, enterprise, end time and reason, and click **Grant**.",
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
              "**Own** means enterprises where the user is account manager, plus their team's when the policy counts the team, plus enterprises granted to them.",
              "When several assignments match a user, the user's own assignment wins over their department's, which wins over the one for all account managers.",
              "Assigning a policy to a target replaces that target's earlier assignment.",
              "Administrators are never restricted. Users with no policy assigned see everything.",
              "Masking is done by the server, so masked names cannot be found by search or seen in exports.",
              "Every policy change and grant is written to the [[audit|Audit trail]].",
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
            text: "Admins can also start a preview from the avatar menu with **View as user…**. While previewing, lists, records, search and exports answer as that user; live feeds do not.",
          },
          {
            kind: "tip",
            text: "A user's effective policy is also shown on the **Visibility** tab of their record on [[users]].",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ departments
  {
    id: "departments",
    pageKey: "departments",
    title: "Departments",
    group: "Admin",
    summary: "The company's departments (Sales, NOC, Billing…) and who manages each one.",
    keywords: ["teams", "department manager", "org chart"],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "Every user belongs to one department. Departments are used to group users, to assign a visibility policy to a whole department, and in team reports. Admins keep this list up to date.",
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
              { name: "Info ID", what: "The department's ID." },
              { name: "Department Name", what: "Its name." },
              { name: "Manager", what: "The user who manages it." },
              { name: "Users", what: "How many users are in it." },
              { name: "Status", what: "Green **Active** or grey **Inactive**." },
              { name: "Updated By", what: "Who changed it last." },
            ],
          },
          {
            kind: "text",
            text: "The detail panel's **Department** tab shows manager, users, description and last update, with **Users** (opens the Users list filtered on this department), **Edit** and **Delete**. **History** lists every change with Undo.",
          },
        ],
      },
      {
        id: "fields",
        title: "Fields in the department form",
        blocks: [
          {
            kind: "fields",
            title: "Add department / Edit",
            fields: [
              { name: "Department Name", what: "Required, up to 80 characters.", values: "e.g. `NOC`" },
              { name: "Status", what: "Required.", values: "Active (default), Inactive" },
              { name: "Manager", what: "Optional. Type to search users." },
              { name: "Description", what: "Optional free text." },
            ],
          },
        ],
      },
      {
        id: "how-to",
        title: "How to add, edit or delete a department",
        blocks: [
          {
            kind: "steps",
            items: [
              "Click **Add department**, fill in the form and click **Add department**.",
              "To edit, double-click the row (or click **Edit** in the detail panel) and **Save**.",
              "To delete, click **Delete** in the detail panel and confirm.",
            ],
          },
          {
            kind: "warning",
            text: "A department cannot be deleted while users are in it. Click **Users** to find them and move them to another department first. See [[safe-delete]].",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ business companies
  {
    id: "business-companies",
    pageKey: "business-companies",
    title: "Business companies",
    group: "Admin",
    summary:
      "The companies you sell through: their currency, SMPP details, bank, default e-mail templates, sending mailboxes and the logo and format files used on invoices, rate sheets and statements.",
    keywords: [
      "selling entity",
      "company",
      "mailbox",
      "SMTP",
      "OAuth",
      "invoice format",
      "logo",
      "bank details",
      "IBAN",
      "templates",
    ],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "A business company is a legal entity that sells to partners. Each enterprise and user belongs to one. The company decides how partner e-mails look and where they are sent from: its mailboxes, its default e-mail templates, its logo and the format files used to build invoices, customer rate sheets and statements of account (SOA). Admins and billing set it up.",
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
              { name: "Info ID", what: "The company's ID." },
              { name: "Name", what: "Company name." },
              { name: "Description", what: "Free text." },
              { name: "Base Currency", what: "The company's main currency." },
              { name: "TPS Limit", what: "Maximum messages per second (TPS) for the company, if set." },
              { name: "Enterprises", what: "How many live enterprises belong to it." },
              { name: "Users", what: "How many users belong to it." },
              { name: "Updated By", what: "Who changed it last." },
              { name: "Updated Time", what: "When." },
            ],
          },
          {
            kind: "fields",
            title: "Detail panel tabs",
            fields: [
              {
                name: "Company",
                what: "Currency, TPS limit, website, SMPP address, first invoice number, address, bank, how many default templates are set, enterprises and users. Buttons: **Clone**, **Edit**, **Delete**.",
              },
              {
                name: "Mailboxes",
                what: "One row per department mailbox: sender, which e-mails it sends (Senders), SMTP server, whether a password and client secret are stored (amber or red when missing), and the last connection check (green or red dot).",
              },
              {
                name: "Format files",
                what: "The logo and format files, with upload and download, and the list of format file variables.",
              },
              { name: "History", what: "Every change to the company and its files, with Undo." },
            ],
          },
        ],
      },
      {
        id: "fields-company",
        title: "Fields: Company part",
        blocks: [
          {
            kind: "text",
            text: "The form has six parts, picked with the switch at the top: **Company**, **Default templates**, **Address & bank**, **Mailboxes**, **Senders** and **Format files**. A red dot on a part means a field there has an error.",
          },
          {
            kind: "fields",
            title: "Company",
            fields: [
              { name: "Name", what: "Required, up to 120 characters." },
              { name: "Base Currency", what: "Required. The company's main currency.", values: "Default EUR" },
              { name: "TPS Limit", what: "Optional cap on messages per second.", values: "1 to 100000" },
              {
                name: "Website",
                what: "Optional. Also used to suggest mailbox addresses.",
                values: "e.g. `https://www.company.example`",
              },
              {
                name: "SMPP IP",
                what: "The SMPP address partners connect to. Shown in tech-info e-mails.",
                values: "e.g. `10.0.0.5`",
              },
              {
                name: "SMPP Port",
                what: "SMPP port shown in tech-info e-mails.",
                values: "1 to 65535; default `2775`",
              },
              {
                name: "Invoice Number (sequence start)",
                what: "Required. The number the company's invoice numbering starts from.",
                values: "Default `1`",
              },
              { name: "Business Company IP", what: "Optional IP address of the company, up to 45 characters." },
              {
                name: "Customer Rate File Name",
                what: "The file name of rate sheets sent to or downloaded for customers. Write variables as `[Key]` or `{Key}`, in any case; spaces are ignored, so `{Date and Time}` works.",
                values:
                  "e.g. `[EnterpriseName]_[ProductCategoryName]_[Currency]_[Date and Time]`; also `[Trunk]` `[Company]` `[Username]` `[Timezone]` `[RateTable]`. Empty: `Rates_<trunk>_<date>`",
              },
              {
                name: "SOA File Name",
                what: "The file name of statements of account (e-mailed and downloaded).",
                values:
                  "e.g. `SOA_[EnterpriseName]_[FromDate]_[ToDate]`; also `[BeneficiaryAddress]` `[Currency]` `[Company]` `[Username]` `[Date]`. Empty: `SOA_<from>_<to>`",
              },
              {
                name: "Invoice File Name",
                what: "The file name of invoice PDFs (e-mailed and downloaded).",
                values:
                  "e.g. `[InvoiceRefNumber]_[EnterpriseName]_[InvoiceDate]`; also `[InvoiceDueDate]` `[CurrencyCode]` `[CompanyRegisteredName]` `[RegistrationNumber]` (or `[PARAM1001]`) `[VATNumber]` `[GrandTotal]`. Empty: the invoice number",
              },
              { name: "Description", what: "Optional free text." },
            ],
          },
        ],
      },
      {
        id: "fields-templates",
        title: "Fields: Default templates part",
        blocks: [
          {
            kind: "text",
            text: "One box per e-mail type: **Customer Rate**, **Invoice**, **Low Balance**, **Bind Down**, **Customer Tech Info**, **Customer Trunk Change Info**, **SOA Statement**, **Rate Upload Notification** and **Auto Upload Report – Rejected**. Each lists the [[email-templates|e-mail templates]] of that type that are shared or belong to this company. Leave a box on **Shared default** to use the shared template.",
          },
        ],
      },
      {
        id: "fields-address",
        title: "Fields: Address & bank part",
        blocks: [
          {
            kind: "fields",
            title: "Address",
            fields: [
              { name: "Address Line 1 / Address Line 2", what: "Street address, printed on invoices." },
              { name: "City / State / ZIP", what: "Optional." },
              { name: "Country", what: "Pick from the list." },
            ],
          },
          {
            kind: "fields",
            title: "Bank",
            fields: [
              { name: "Beneficiary Name", what: "The account holder." },
              { name: "Beneficiary Address", what: "The account holder's address." },
              { name: "Bank", what: "Bank name." },
              { name: "Bank Address", what: "Bank address." },
              { name: "Currency", what: "Account currency." },
              { name: "Account Number", what: "Up to 60 characters." },
              { name: "IBAN", what: "International bank account number, up to 40 characters." },
              { name: "Swift", what: "Bank's SWIFT/BIC code, up to 11 characters." },
            ],
          },
        ],
      },
      {
        id: "fields-mailboxes",
        title: "Fields: Mailboxes part",
        blocks: [
          {
            kind: "text",
            text: "Each department (NOC, Sales, Rates, Billing, Support) can have one sending mailbox. Add one with the department buttons under **Add a mailbox**; the addresses are pre-filled from the company website. **Remove** drops a mailbox.",
          },
          {
            kind: "fields",
            title: "One mailbox block",
            fields: [
              { name: "Name", what: "Sender name shown to partners." },
              { name: "Phone", what: "Optional phone in the signature." },
              { name: "SMTP Email", what: "Required. The From address.", values: "e.g. `noc@company.example`" },
              {
                name: "SMTP Secure",
                what: "Required. How the connection is encrypted.",
                values: "STARTTLS (default), SSL / TLS, None",
              },
              { name: "SMTP Host", what: "Required. The mail server.", values: "e.g. `smtp.company.example`" },
              { name: "SMTP Port", what: "Required.", values: "1 to 65535; default `587` (465 needs SSL / TLS)" },
              { name: "SMTP UserName", what: "Sign-in name on the mail server." },
              {
                name: "SMTP Password",
                what: "Write-only. A stored password shows as dots; leave it empty to keep it, type to replace it.",
              },
              {
                name: "IMAP Host (incoming)",
                what: "Optional. The mailbox is read over SSL with the SMTP login. On the **Rates** mailbox, rate sheets that arrive become Incoming RNs. Under the field you see when it was last read, or the last read error.",
              },
              { name: "IMAP Port", what: "Optional.", values: "1 to 65535" },
              { name: "Extension Number", what: "Optional phone extension." },
              { name: "Skype Name", what: "Optional." },
              { name: "Client ID", what: "Required. The OAuth client ID for the mail service." },
              {
                name: "Client Secret",
                what: "Write-only OAuth secret. Required until one is stored; then leave it empty to keep it.",
              },
              { name: "OAuth Redirect URIs (one per line)", what: "Required. One address per line." },
              {
                name: "Check SMTP Connection",
                what: "Tests the mailbox step by step: resolve host, connect, encryption, log in. Each step shows a green or red dot; steps after a failure are skipped.",
              },
            ],
          },
        ],
      },
      {
        id: "fields-senders",
        title: "Fields: Senders part",
        blocks: [
          {
            kind: "text",
            text: "Picks which department mailbox sends each kind of e-mail for this company's partners, for example tech info from **Support** instead of **NOC**. Under each choice you see the address it will go out from. If the chosen department has no mailbox, the default department's mailbox is used, then department@website. A partner always gets e-mail from the mailboxes of the company it belongs to, so a partner of one entity never receives mail from another.",
          },
          {
            kind: "fields",
            title: "E-mail kinds (default mailbox)",
            fields: [
              { name: "Rate sheets & rate notices", what: "Send rate and rate-change notices. Default **Rates**." },
              { name: "Replies to vendor RNs", what: "RN accepted / rejected replies. Default **Rates**." },
              { name: "Tech info", what: "Customer connection details. Default **NOC**." },
              { name: "Traffic & monitoring alerts", what: "Alerts sent to partners. Default **NOC**." },
              { name: "Trouble tickets", what: "Message lists sent from the Observation Deck. Default **NOC**." },
              { name: "Daily traffic summary", what: "Daily traffic alerts. Default **NOC**." },
              { name: "Scheduled reports", what: "Scheduled report e-mails. Default **NOC**." },
              { name: "Invoices", what: "Customer invoices. Default **Billing**." },
              { name: "Statements of account", what: "SOA e-mails. Default **Billing**." },
              { name: "Payment confirmations", what: "Sent after a payment is booked. Default **Billing**." },
              { name: "Vendor invoice replies", what: "Accepting or disputing a vendor invoice. Default **Billing**." },
            ],
          },
          {
            kind: "text",
            text: "**Templates and bank details per company.** Every e-mail uses the partner's company's default template for its type (Default templates part), else one of the company's own templates, else the shared one. Any template can use the company's details: `{company}`, `{company_address}`, `{company_website}`, `{bank_details}` (all bank lines) and `{bank_beneficiary}`, `{bank_name}`, `{bank_address}`, `{bank_currency}`, `{bank_account}`, `{bank_iban}`, `{bank_swift}`. Invoices are issued by the partner's company: the PDF shows its name, address and a **Payment details** block with its bank account, and the invoice e-mail comes from its billing mailbox with its Invoice template.",
          },
        ],
      },
      {
        id: "fields-files",
        title: "Fields: Format files part",
        blocks: [
          {
            kind: "fields",
            title: "Files (each up to 10 MB)",
            fields: [
              { name: "Company Logo (PNG)", what: "Logo on e-mails and documents.", values: ".png" },
              {
                name: "Invoice Format File (XLSX)",
                what: "Layout used to build invoices.",
                values: ".xlsx, .xls, .xml",
              },
              {
                name: "Customer Rate Format File (XLSX)",
                what: "Layout of customer rate sheets.",
                values: ".xlsx, .xls, .xml",
              },
              { name: "SOA Format File (XLSX)", what: "Layout of statements of account.", values: ".xlsx, .xls, .xml" },
            ],
          },
          {
            kind: "text",
            text: "A missing file shows **missing** in amber. **Upload…** replaces a file; click a file name to download it. **Format file and file name variables** lists the keys each format file can hold (the old platform's `[EnterpriseName]`, `[InvoiceRefNumber]`, `[FromDate]` and so on) and every variable the three file names accept.",
          },
          {
            kind: "list",
            items: [
              "Dates and times in file names are UTC: `[Date]` is `2026-10-30`, `[Time]` is `16-49`, `[DateTime]` (or `{Date and Time}`) is `2026-10-30_16-49`.",
              "`[Username]` is who sent or downloaded the file; automatic sends (auto invoices, market move re-pricing) use `system`.",
              "Characters a file name cannot hold (`/ \\ : * ? \" < > |`) become `_`. Saving refuses a variable the file does not know and names it.",
            ],
          },
          {
            kind: "warning",
            text: "The uploaded format files are kept with the company for now; invoices, rate sheets and statements are still laid out by the platform's own layout. Their keys are listed so a format file from the old platform can be checked.",
          },
          { kind: "tip", text: "Files can be uploaded only after the company is saved." },
        ],
      },
      {
        id: "how-to",
        title: "How to add, clone or delete a company",
        blocks: [
          {
            kind: "steps",
            title: "Add a company",
            items: [
              "Click **Add company** and fill in the **Company** part.",
              "Go through **Default templates**, **Address & bank** and **Mailboxes**. Use **Check SMTP Connection** on each mailbox.",
              "Click **Add company**.",
              "Click **Edit** in the detail panel, open **Format files** and upload the logo and format files.",
            ],
          },
          {
            kind: "steps",
            title: "Clone a company",
            items: [
              "Click the company and then **Clone**. Type the name of the copy.",
              "The copy has everything except mailbox passwords and client secrets. Edit it and type those in.",
            ],
          },
          {
            kind: "steps",
            title: "Delete a company",
            items: [
              "Click **Delete** in the detail panel. The dialog lists what depends on it.",
              "Delete is blocked while live enterprises or users belong to the company. Move them first. See [[safe-delete]].",
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
            text: "Passwords and client secrets are never shown again after saving. Keep a copy in your password manager.",
          },
          {
            kind: "tip",
            text: "**Check SMTP Connection** ends by connecting to the mail server and logging in. On the test system it stops before that: it checks the host name, port, encryption and that a password exists, but does not contact the mail server.",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ logged in users
  {
    id: "logged-in",
    pageKey: "logged-in",
    title: "Logged-in users",
    group: "Admin",
    summary:
      "Everyone signed in right now, staff and customer portal users, with where they are and the device they use. Sign anyone out with Force logout.",
    keywords: ["sessions", "online", "who is online", "force logout", "kick", "sign out"],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "Use it to see who is online, spot a session from an unexpected place or device, and end it. Admins use it after a password reset or when someone leaves the company.",
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
              { name: "Logged In At", what: "When the session started (UTC)." },
              { name: "User", what: "The person's name. Your own session is marked **you**." },
              { name: "User Type", what: "**Wholesale** (staff) or **Customer** (portal user)." },
              { name: "IP Address", what: "Where the session connects from." },
              { name: "Location", what: "Approximate place, from the IP address." },
              { name: "Device", what: "Desktop, Mobile, Tablet or Bot." },
              { name: "OS", what: "Operating system." },
              { name: "Browser", what: "Browser name." },
              { name: "Last Seen", what: "The session's last activity." },
              { name: "Action", what: '**Force logout** button, or "This session" on your own.' },
            ],
          },
          {
            kind: "text",
            text: "Hidden columns (add them with **Columns**): UserName and Enterprise (for customer sessions). The detail panel shows the same facts with the customer's enterprise.",
          },
        ],
      },
      {
        id: "how-to",
        title: "How to sign someone out",
        blocks: [
          {
            kind: "steps",
            items: [
              "Find the session (filter **User** or **IP Address**).",
              "Click **Force logout** in the row or in the detail panel.",
              "Confirm. The session ends at once and the row disappears.",
            ],
          },
          {
            kind: "tip",
            text: "Your own session cannot be ended here: sign out from the avatar menu. Setting a temporary password or a password change also signs the user out of their other sessions.",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ audit trail
  {
    id: "audit",
    pageKey: "audit",
    title: "Audit trail",
    group: "Admin",
    summary:
      "A read-only log of every action that changed something, by user, with IP address and time, including actions that failed.",
    keywords: ["audit log", "activity log", "security log", "who did what", "actions"],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "Every request that changes data (add, edit, delete, send, import and so on) is written here, whether it succeeded or not. Admins and auditors use it to see who did what and from where. Nothing on this page can be changed.",
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
              { name: "Info ID", what: "Entry number." },
              { name: "IP Address", what: "Where the request came from." },
              { name: "Module Name", what: "The area of the system, e.g. routing or admin." },
              { name: "Controller", what: "The technical name of the request." },
              { name: "Method", what: "The kind of request.", values: "POST (create), PUT / PATCH (change), DELETE" },
              { name: "Action", what: "What was done, in words." },
              { name: "Table Name", what: "The kind of record touched." },
              { name: "Master ID", what: "The ID of the record touched." },
              { name: "Update Time", what: "When (UTC)." },
              { name: "User", what: "Who did it, or **system** for automatic jobs." },
              {
                name: "HTTP Status",
                what: "The answer code. 400 or above means the action failed; it is shown in red and the row is greyed out. Hidden by default.",
              },
            ],
          },
          {
            kind: "text",
            text: "Hidden columns also include User ID and Duration (ms). The detail panel shows module, action, table, master ID, user, IP and the answer with its time. **Change history** opens [[change-history]] for the field-by-field values.",
          },
        ],
      },
      {
        id: "how-to",
        title: "How to find what a user did",
        blocks: [
          {
            kind: "steps",
            items: [
              "Type the user name in the filter under **User**.",
              "Narrow it with **Update Time**, **Module Name** or **Table Name** and **Master ID** for one record.",
              "Click an entry for details; open **Change history** to see before and after values.",
            ],
          },
          {
            kind: "tip",
            text: "Read-only actions (opening pages, searching) are not logged here. See [[team-report]] for each person's activity.",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ email templates
  {
    id: "email-templates",
    pageKey: "email-templates",
    title: "Email templates",
    group: "Admin",
    summary:
      "The texts of every e-mail the system sends to partners (rate sheets, invoices, low balance, bind down, statements…), with {placeholders} filled in when sent.",
    keywords: ["mail", "e-mail", "template", "placeholder", "variables", "subject", "body", "notification text"],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "Each automatic e-mail uses a template of its type. A template can be shared by every business company, or belong to one company. Which one is used is set on [[business-companies]] (defaults per type), [[traffic-alerts]] and [[soa-report]].",
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
              { name: "Info ID", what: "Template ID." },
              { name: "Name", what: "Template name." },
              {
                name: "Email Type",
                what: "Which e-mail it is for.",
                values:
                  "Customer Rate, Invoice, Low Balance, Bind Down, Customer Tech Info, Trunk Change Info, SOA Statement, Rate Upload Notification, Traffic Alert, Auto Upload Report – Reject, EDR – Trouble Ticket, Send SOA, Monitoring Alert",
              },
              { name: "Subject", what: "The e-mail subject line." },
              { name: "Business Company", what: "The company it belongs to, or **Shared**." },
              { name: "Used By", what: "How many company defaults, traffic alerts and SOA reports use it." },
              { name: "Updated Time", what: "Last change." },
            ],
          },
          {
            kind: "text",
            text: "The detail panel shows a **Preview** of the e-mail filled with fake sample values (with **Clone**, **Edit**, **Delete**), **Info** and **History**.",
          },
        ],
      },
      {
        id: "fields",
        title: "Fields in the template form",
        blocks: [
          {
            kind: "fields",
            title: "Add e-mail template / Edit",
            fields: [
              { name: "Name", what: "Required, up to 120 characters." },
              {
                name: "Email Type",
                what: "Required. Decides which placeholders are offered.",
                values: "Default: Customer Rate",
              },
              {
                name: "Business Company",
                what: "Leave on **Shared by every company**, or pick the one company that uses it.",
              },
              {
                name: "Subject",
                what: "Required, up to 300 characters. Placeholders work here too.",
                values: "e.g. `New rates for {enterprise} from {rate_date}`",
              },
              {
                name: "Body",
                what: "Required. Designed in **Visual** mode (what you see is the e-mail) or written in **HTML** mode (the full source, for designs made in another tool). **Import HTML file** loads a design saved as .html. Plain text still works and keeps its line breaks.",
              },
              {
                name: "Visual toolbar",
                what: "Style (paragraph, headings, quote), **Font** (fonts every mail app has, and web fonts such as Montserrat that classic Outlook replaces with their fallback), **Size**, bold / italic / underline / strike, **text colour**, **highlight**, **cell / paragraph background** (for coloured sections and buttons), alignment, lists, **link**, **image**, image width and centring, **button**, **table**, **divider**, **e-mail layout** (a page background with a 600 px card; click again to change the colours), clear formatting, undo and redo.",
              },
              {
                name: "Images",
                what: 'Upload PNG, JPEG or GIF up to 2 MB, or reuse an image uploaded before. Uploaded images are embedded in the sent e-mail, so readers see them without clicking "Download pictures". `{company_logo}` puts the business company\'s own logo in.',
              },
              {
                name: "Placeholder chips",
                what: "Under the body: one chip per placeholder of the chosen type. Click a chip to insert it where the cursor is. Hover to see what it means and an example.",
                values:
                  "Every type has `{enterprise}` and `{company}`; e.g. Customer Rate adds `{trunk}`, `{rate_date}`",
              },
              {
                name: "Preview (sample values)",
                what: "The finished e-mail, updated as you pause typing, in three views: **In the system** (as Email Logs, new Outlook, Outlook on the web, Gmail and Apple Mail show it), **Outlook for Windows** (an approximation of classic Outlook, which draws e-mails with Word: rounded corners, shadows, background images and web fonts are dropped) and **Phone** (375 px). With a business company picked, its name, logo, address and bank fill the placeholders. A warning lists any `{word}` that is not a placeholder of this type.",
              },
              {
                name: "Compatibility",
                what: "Under the preview: what will look different and in which mail apps. **Check** items need attention (an image without a width, a web font with no fallback, images from other websites, pictures pasted as data, Gmail's 102 KB limit); **Note** items are small differences (square corners in classic Outlook, ignored responsive rules).",
              },
              {
                name: "Send test",
                what: "Sends the template with sample values to up to five addresses, from the mailbox that sends this kind of e-mail, so you can open it in your own Outlook. It shows in [[email-logs|Email Logs]] as type Template Test.",
              },
            ],
          },
        ],
      },
      {
        id: "how-to",
        title: "How to add, clone or delete a template",
        blocks: [
          {
            kind: "steps",
            title: "Add a template",
            items: [
              "Click **Add template**.",
              "Pick the **Email Type** first, then type the **Name** and **Subject**.",
              "Design the **Body** in Visual mode (or paste or import HTML), clicking placeholder chips to insert them.",
              "Check the three preview views and the Compatibility list; use **Send test** to see it in your own Outlook.",
              "Click **Add template**.",
              "Choose it as a default on [[business-companies]] if needed.",
            ],
          },
          {
            kind: "steps",
            title: "Clone",
            items: ["Click the template, then **Clone**, and type a name for the copy. Edit the copy."],
          },
          {
            kind: "warning",
            text: "A template that is used by a business company default, a traffic alert or an SOA report cannot be deleted. Choose another template there first. See [[safe-delete]].",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ security settings
  {
    id: "security",
    pageKey: "security",
    title: "Security settings",
    group: "Admin",
    summary:
      "The password policy for everyone (lifetime, reminders, temporary passwords, length and history) and an overview of passwords, 2FA and security events.",
    keywords: [
      "password policy",
      "password lifetime",
      "expiry",
      "reminders",
      "2FA",
      "security events",
      "failed attempts",
    ],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "Every staff and customer portal user must change their password regularly. Admins set the rules here and watch how many passwords are expired, expiring or temporary. Other users can open the page but cannot change the settings. See [[passwords-and-2fa]].",
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
              "Header: **Users** opens the [[users]] page (for forcing a change or setting temporary passwords).",
              'Left: **Password policy** card with the settings and a one-line summary, e.g. "Expires every 30 days · reminders 7, 3 and 1 days before".',
              "Right, top: **Passwords now**: active staff and portal users per state (OK, Expiring (7 days), Expired, Temporary, Must change). Click a staff number to open Users filtered on that state in a new tab.",
              "Right, middle: **Staff without 2FA** (amber when not zero), **Failed changes, 24 h** (red when not zero; wrong password or 2FA code), **Reminders, 7 days** with the last run time, and **Send due reminders now**.",
              "Right, bottom: **Latest security events**: When, User (portal users marked), What and IP. Green dot = changed, red = failed, amber = forced or temporary, hollow = reminder or settings. The same events show on each person's Team activity. Passwords are never stored or shown.",
            ],
          },
        ],
      },
      {
        id: "fields",
        title: "Fields in the password policy",
        blocks: [
          {
            kind: "fields",
            title: "Password policy",
            fields: [
              {
                name: "Password lifetime",
                what: "Everyone changes their password this often. It cannot be turned off.",
                values: "7 to 365 days; default 30",
              },
              {
                name: "Temporary password",
                what: "How long an admin-set password works. It must be changed at first sign-in.",
                values: "1 to 72 hours; default 24",
              },
              {
                name: "Minimum length",
                what: "Shortest allowed password.",
                values: "12 to 64 characters; never below 12",
              },
              {
                name: "Password history",
                what: "A new password may not be one of the user's last N passwords.",
                values: "12 to 24; never below 12",
              },
              {
                name: "Reminders before expiry",
                what: "Days before expiry when the user gets a top-bar banner and an e-mail. Remove a day with its x; type a day and click **Add**. The e-mail never holds a password or a sign-in link.",
                values:
                  "1 to 30 days, at most 5 reminders, at least 1; default 7, 3 and 1. All must be before the expiry.",
              },
              {
                name: "Always on",
                what: "Locked rules that cannot be changed: 2FA at every login and on every password change; not the username or name and not on the known-leaked list; a password change signs the user out of every other session.",
              },
            ],
          },
        ],
      },
      {
        id: "how-to",
        title: "How to change the policy",
        blocks: [
          {
            kind: "steps",
            items: [
              "Change the numbers or reminder days. The footer shows the first problem, if any.",
              "Click **Save** (admins only). **Reset** throws away your edits.",
              "The new lifetime applies at once: expiry dates and the Users list follow it.",
            ],
          },
          {
            kind: "steps",
            title: "Send reminders now",
            items: [
              "Reminders normally go out by themselves every hour.",
              "Click **Send due reminders now** to run it at once. The message says how many were sent, or that none is due. A user is not reminded twice for the same day.",
            ],
          },
        ],
      },
      {
        id: "tips",
        title: "Tips and things to watch",
        blocks: [
          { kind: "warning", text: "Only admins can save. For everyone else the fields and **Save** are greyed out." },
          {
            kind: "tip",
            text: "Security events also appear on each person's activity in [[team-report]]. Passwords are never stored or shown.",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ cleanup center
  {
    id: "cleanup",
    pageKey: "cleanup",
    title: "Cleanup center",
    group: "Admin",
    summary:
      "Finds unused, expired, duplicate, shadowed and broken records (rules, rate tables, trunks, enterprises, lists, users) and lets you review and fix them as one undoable change.",
    keywords: [
      "unused rules",
      "duplicates",
      "redundant",
      "shadowed",
      "expired",
      "dormant",
      "housekeeping",
      "tidy",
      "merge",
    ],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "Over time the system collects rules that never match, rate tables on no trunk, idle trunks and near-copies. A nightly scan finds them and lists each as a **finding**. Nothing changes until a person reviews the finding and applies it. Rules owners, rate managers and admins use this page.",
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
              "Header: **Settings** and **Scan now** (runs the scan at once and reports new, resolved and open findings).",
              "Area cards: **Rules**, **Rate tables**, **Trunks**, **Enterprises**, **Lists**, **Users**, each with its open count and top kinds. Click one to filter the list on it. Next to them: totals, awaiting approval, applied in 30 days, and the last and next scan time.",
              "The grid opens showing Open and Awaiting approval findings only.",
            ],
          },
          {
            kind: "fields",
            title: "Grid columns",
            fields: [
              {
                name: "Finding",
                what: "The kind of problem.",
                values:
                  "e.g. Unused route rule, Expired route rule, Identical route rules, Near-duplicate route rules, Shadowed route rule, Conflicting route rules, Broken vendor reference, Unassigned translation rule, Unassigned HLR rule, Rate table on no trunk, Identical rate tables, Trunk without traffic, Inactive trunk without traffic, Dormant enterprise, Duplicate enterprise, Unused number list, User not signed in",
              },
              { name: "What", what: "The record(s) and the problem in one line. Hover for why it matters." },
              {
                name: "Suggested",
                what: "The suggested fix.",
                values: "Merge, Delete (archive), Deactivate, Reassign, Reorder, Review by hand",
              },
              { name: "Impact", what: 'What it means for traffic, e.g. "0 messages in the last 30 days".' },
              { name: "Msgs 30 Days", what: "Messages the record handled in the last 30 days." },
              {
                name: "State",
                what: "Amber **Open** or **Awaiting approval**, green **Applied**, grey **Ignored** or **Resolved** (fixed some other way).",
              },
              { name: "Found", what: "When the scan found it." },
            ],
          },
          {
            kind: "fields",
            title: "Finding card (detail panel)",
            fields: [
              { name: "Why", what: "Why this matters." },
              { name: "Impact", what: "Effect on traffic or billing." },
              {
                name: "Action",
                what: "When there is more than one possible fix, pick it here; the suggested one is marked.",
              },
              { name: "Records", what: "The records involved, each a link that opens it in a new tab." },
              { name: "What applying does", what: "The exact edits the fix will make." },
              {
                name: "Replay (route rules)",
                what: 'For route rule fixes, the last 24 hours of traffic are replayed: "Routing result unchanged", or a table of routes that would change (client trunk, destination, vendor now, after, messages in 24 h).',
              },
            ],
          },
        ],
      },
      {
        id: "fields-settings",
        title: "Fields in Cleanup settings",
        blocks: [
          {
            kind: "fields",
            title: "Settings",
            fields: [
              {
                name: "Unused after (days without traffic)",
                what: "A rule with no message in this many days counts as unused.",
                values: "Default 30",
              },
              {
                name: "Expired: days after the stop time",
                what: "A rule past its stop time by this many days counts as expired.",
                values: "Default 7",
              },
              {
                name: "Dormant enterprise after (days)",
                what: "An enterprise without traffic this long counts as dormant.",
                values: "Default 90",
              },
              {
                name: "Idle user after (days without sign-in)",
                what: "A user who has not signed in this long is listed.",
                values: "Default 90",
              },
              {
                name: "Cleanups by non-administrators wait for an administrator's approval",
                what: "When ticked, an Apply by a non-admin puts the finding in **Awaiting approval** instead of changing anything.",
                values: "Off by default",
              },
              {
                name: "Weekly summary to (rules owners)",
                what: "E-mail addresses that get a weekly summary while findings are open. Separate with commas.",
                values: "e.g. `rates@example.com, noc@example.com`",
              },
            ],
          },
        ],
      },
      {
        id: "how-to",
        title: "How to review and fix findings",
        blocks: [
          {
            kind: "steps",
            title: "One finding",
            items: [
              "Click an area card or filter **Finding** to narrow the list.",
              "Click a finding and read **Why**, **Impact**, **Records** and **What applying does**.",
              "For route rules, check the replay. If routes would change, make sure that is what you want.",
              "Pick another **Action** if the suggested one is not right.",
              "Click **Apply: …**. The message gives the change number; it can be undone from History.",
              "Or click **Ignore…**, type why, and click **Ignore**. It will not be suggested again. **Reopen** brings an ignored finding back.",
            ],
          },
          {
            kind: "steps",
            title: "Many at once",
            items: [
              "Tick several findings (or filter a whole kind and select all). The selection bar shows how many and their messages in 30 days.",
              "Choose **Apply the suggestions (N)**, **Delete (archive) where allowed (N)**, **Deactivate where allowed (N)** or **Ignore… (N)**.",
              "All applied findings become one change. Any that could not be applied are listed as skipped, with the reason.",
            ],
          },
          {
            kind: "steps",
            title: "Approve waiting findings (admins)",
            items: ["Open a finding in **Awaiting approval** and click **Approve**. It is applied as one change."],
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
              "The scan runs every night; **Scan now** runs it on demand. A finding whose problem disappeared becomes **Resolved**.",
              "**Delete (archive)** archives the record (safe delete), so it can be restored. **Merge** keeps the first rule, adds the other rules' client trunks to it and archives the rest. **Reorder** moves the shadowed rule's priority. **Reassign** removes vendors that can no longer take traffic. **Review by hand** changes nothing: open the records and fix them yourself.",
              "A fix is skipped when the record changed since the scan (already archived, already inactive, no working vendor left and so on).",
              "Undoing the change in [[change-history]] puts every record back and opens the findings again.",
              "Pages such as [[route-rules]] show a **Cleanup** badge with the open count for their records; it opens this page filtered.",
              'When you add or edit some records, a "Possible duplicate" note can appear with a link to the existing one, so you can use it instead of making a copy.',
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
            text: "Applying changes live records: deleted rules stop matching traffic straight away. Always read the replay for route rules.",
          },
          { kind: "tip", text: "Only administrators can approve findings that are awaiting approval." },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ migration center
  {
    id: "migration",
    pageKey: "migration",
    title: "Migration center",
    group: "Admin",
    summary:
      "Bulk import from the old platform (CSV files through column mappings) or from another installation, with a dry run first; and full encrypted export packages.",
    keywords: [
      "import",
      "export",
      "migration",
      "CSV",
      "dry run",
      "rollback",
      "go live",
      "column mapping",
      "encrypted package",
      "credentials",
    ],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "Use it to move a whole platform's data in or out in one go: departments, product categories, users, enterprises, trunks, rate tables and rates, number lists, route rules, translation rules, HLR rules and opening balances. Imports always start with a **dry run** that writes nothing. Exports make one encrypted package. This is an admin page.",
          },
          {
            kind: "text",
            text: "Three views, picked with the switch under the header: **Imports**, **Exports** and **Column mappings**. Header buttons: **New export**, the filled **New import**, and **New mapping** on the mappings view.",
          },
        ],
      },
      {
        id: "imports-view",
        title: "Imports view",
        blocks: [
          {
            kind: "fields",
            title: "Imports list",
            fields: [
              { name: "#", what: "Import number." },
              {
                name: "Status",
                what: "Amber **Dry run** (checked, nothing written), green **Applied**, grey **Rolled back**, red **Failed**.",
              },
              { name: "Source", what: "The system the data came from." },
              { name: "Files", what: "Number of files." },
              { name: "Result", what: 'e.g. "12 new · 3 updated · 40 skipped · 2 with errors".' },
              { name: "By / Checked", what: "Who ran it and when it was last checked." },
            ],
          },
          {
            kind: "fields",
            title: "Import panel (click an import)",
            fields: [
              { name: "Next step", what: "What to do next, in words." },
              {
                name: "Buttons",
                what: "**Fix and re-run** and **Apply** on a dry run; **Go live** when imported trunks wait inactive; **E-mail password links** when the import created users (each picks their own password); **Roll back** on an applied import.",
              },
              {
                name: "Counts table",
                what: "Per entity: In file, New, Update, Skip, Errors (red), and In system (records there now).",
              },
              {
                name: "Problems",
                what: "Every problem by entity, row and field. Red dot = error (blocks apply), amber = warning. Tick **Errors only** to hide warnings.",
              },
            ],
          },
        ],
      },
      {
        id: "import-fields",
        title: "Fields in the import dialog",
        blocks: [
          {
            kind: "fields",
            title: "New import / Fix and re-run",
            fields: [
              {
                name: "Source system",
                what: "Required. The name of the system the data comes from. Old IDs are kept per source system, so a second run updates instead of duplicating.",
                values: "e.g. `Reference platform`",
              },
              { name: "From", what: "Where the data comes from.", values: "CSV files (default), Export package" },
              {
                name: "Entity / File",
                what: 'One row per entity, in the order they are loaded: Departments; Product categories; Users; Enterprises and contacts; Customer trunks; Vendor trunks; Rate tables; Rates; Number lists; Route rules; Translation rules; HLR rules; Opening balances. Choose a CSV file for each you need. Later files may name records of earlier ones in the same import (the department of a new user, the number list of a new translation rule). **Template** downloads an empty file with our column names. Each row says how records are matched (e.g. "external ID, else name") and whether it holds credentials.',
              },
              {
                name: "Columns",
                what: "Which column mapping translates the file's column names. **Template names** means the file already uses ours. A mapping saved for the source system is picked automatically.",
              },
              {
                name: "If it exists",
                what: "What to do when a record already exists. Rates, number list values and opening balances are always added (a value already in its list is skipped). Translation rules that exist are skipped: edit them on their page. A user in the file whose username belongs to a deleted user is restored with the file's details (a deleted user keeps its username), whatever this says; the dry run lists it as a warning.",
                values: "Skip (default), Update, Add new",
              },
              {
                name: "Package / Package password",
                what: "For Export package: pick a finished export package (made by a Migration export of another installation, system to system) and type the password it was made with.",
              },
              {
                name: "Create trunks inactive (go live per partner later)",
                what: "When ticked (default), imported trunks carry no traffic until you activate them.",
              },
              {
                name: "2FA code",
                what: "Your 6-digit code from the authenticator app. Needed when the files hold trunk credentials (System ID, username, password, host, port). Admins only.",
              },
            ],
          },
        ],
      },
      {
        id: "lists-and-rules",
        title: "Number lists, translation rules and HLR rules",
        blocks: [
          {
            kind: "list",
            items: [
              "**Number lists**: one row per value (or several values in one cell, separated by , or ;) with the list's **name** and **type** (tag, random, sender_id_template). Rows with the same name go into one list. A list that already exists keeps its type and gets only the values it lacks.",
              "**Translation rules**: the rule's conditions (Sender ID, receiver and content patterns, destinations, Sender ID and receiver lists by name), its conversions (type and value, or a number list for random_number and sender_id_template), TON / NPI and the customer or vendor trunks it applies to (by name, or **all**). The dry run runs the same checks as the rule form.",
              "**HLR rules**: name, the **HLR provider** by name, the receiver pattern (DNID) and the customer trunks (empty = every trunk). Add HLR providers by hand first: they hold the provider's URL and credentials.",
              "Undoing the import's change archives the lists and rules it made and removes the values it added to lists that were already there.",
            ],
          },
        ],
      },
      {
        id: "how-to-import",
        title: "How to import from the old platform",
        blocks: [
          {
            kind: "steps",
            items: [
              "Export each entity from the old platform as CSV, or fill in our templates.",
              "Column names are matched loosely: case, spaces, dashes and underscores do not matter, and the usual other names work (\"User name\" or \"Login\" for Username, \"E-mail\" for Email…). A template downloaded here imports back unchanged, whatever mapping is picked. If the old system's names are different again, pick the ready mapping or save your own under **Column mappings**.",
              "Choices are read the way people write them: \"Active\", \"Tier 1\", \"Bilateral\", \"TLS 1.2\" or \"Yes\" work; a word the field does not know is listed by the dry run.",
              "Click **New import**, type the **Source system**, choose the files, mappings and what to do if a record exists.",
              "Click **Run dry run**. It writes nothing and lists every problem by file and row.",
              "Fix the files, click **Fix and re-run**, and repeat until there are no errors.",
              "Click **Apply** and confirm. Everything is written as one change in [[change-history]].",
              "Trunks arrive inactive: click **Go live**, then **Activate this partner** for one enterprise or **Activate all**. Activating is also one undoable change.",
              "Imported users have no password anyone knows: click **E-mail password links** so each picks their own, or set a temporary password per user in [[users]].",
              "To undo the whole import, click **Roll back** and confirm: created records are archived and updated fields go back.",
            ],
          },
        ],
      },
      {
        id: "exports",
        title: "Exports view and the export dialog",
        blocks: [
          {
            kind: "text",
            text: "The list shows #, Status (green done, amber running, red failed), Content, Size, Made by and Made. Click an export to see its manifest: each entity with its sensitivity level (General, Business, amber Financial, red Credentials) and record count, and the links between records.",
          },
          {
            kind: "fields",
            title: "New export package",
            fields: [
              {
                name: "Rates",
                what: "Which rates go in.",
                values: "Current and future only (default), All, with history, None",
              },
              {
                name: "Package password",
                what: "The package is encrypted with this password. It is not stored anywhere: keep it safe.",
                values: "At least 12 characters",
              },
              { name: "Repeat password", what: "Must match." },
              {
                name: "Include trunk connection details (System IDs, hosts, IPs, ports)",
                what: "Admins only. Adds trunk credentials.",
              },
              {
                name: "Also include passwords",
                what: "Only with connection details ticked. Adds the trunk passwords for a full move.",
              },
              {
                name: "Your 2FA code",
                what: "Shown when credentials are included. Required. Logged in the audit trail; the other admins get an e-mail.",
              },
            ],
          },
          {
            kind: "steps",
            title: "Make and download a package",
            items: [
              "Click **New export**, fill in the dialog and click **Make package**. It is written in the background.",
              "When the status is done, click the export and then **Download**.",
              "If it holds credentials, type your 2FA code. A single-use link is made and used at once; it expires after 15 minutes.",
            ],
          },
        ],
      },
      {
        id: "mappings",
        title: "Column mappings view",
        blocks: [
          {
            kind: "text",
            text: 'Lists each mapping: Source system, Entity, Name (built-in ones are marked "ready"), Mapped fields and Updated. Built-in mappings can only be copied (**Copy**); your own can be edited (**Edit**).',
          },
          {
            kind: "fields",
            title: "New column mapping",
            fields: [
              { name: "Source system", what: "Required. The system whose files use these names." },
              { name: "Name", what: "Name of the mapping.", values: "Default `Default`" },
              { name: "Entity", what: "Which entity it is for. Cannot be changed when editing." },
              {
                name: "Our field / Their column name",
                what: "For each of our fields, type the column name used in their file. Fields marked `*` are required; credential fields are marked.",
              },
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
            text: "Making and downloading export packages is for admins only. Including credentials needs 2FA to be set up on your own account; otherwise the system asks you to turn it on first.",
          },
          { kind: "warning", text: "Errors block **Apply**. Warnings do not, but read them." },
          {
            kind: "tip",
            text: "EDRs (message records) are not in packages: they stay in the reporting store and link to the new records through the old IDs.",
          },
          { kind: "tip", text: "See [[passwords-and-2fa#sensitive-exports]] for the rules on sensitive exports." },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ customer portal
  {
    id: "customer-portal",
    pageKey: "customer-portal",
    title: "Customer portal",
    group: "Admin",
    summary: "Logins for the customer self-service portal: one per contact person, tied to a customer enterprise.",
    keywords: ["portal users", "customer login", "self-service", "portal password"],
    sections: [
      {
        id: "overview",
        title: "What this page is for",
        blocks: [
          {
            kind: "text",
            text: "Customers can sign in to a self-service portal. Each login belongs to one customer (or bilateral) enterprise. Account managers and admins add logins, reset passwords and switch them off here. Portal users follow the same monthly password change as staff.",
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
              { name: "Info ID", what: "Login ID." },
              { name: "Email", what: "The contact's e-mail." },
              { name: "UserName", what: "Sign-in name." },
              { name: "Enterprise", what: "The customer it belongs to." },
              { name: "First Name / Last Name", what: "The contact's name." },
              { name: "Status", what: "Green **Active** or grey **Inactive** (cannot sign in)." },
              {
                name: "Password Days Left",
                what: "Days until the password expires; amber at 7 or fewer, red when expired. Hidden by default.",
              },
              { name: "Last Login", what: 'Last sign-in, or "never". Hidden by default.' },
            ],
          },
          {
            kind: "text",
            text: "The detail panel's **Login** tab shows enterprise, e-mail, password changed and expiry, temporary password end time, whether a change is due at login, and last login, with **Change password**, **Edit** and **Delete**. **History** lists changes with Undo.",
          },
        ],
      },
      {
        id: "fields",
        title: "Fields in the portal user form",
        blocks: [
          {
            kind: "fields",
            title: "Add portal user / Edit",
            fields: [
              {
                name: "Enterprise",
                what: "Required. Type to search; only customer and bilateral enterprises are offered.",
              },
              { name: "First Name", what: "Required, up to 80 characters." },
              { name: "Last Name", what: "Required, up to 80 characters." },
              { name: "Email", what: "Required.", values: "e.g. `ops@acme-mobile.example`" },
              { name: "UserName", what: "Required, up to 60 characters." },
              { name: "Status", what: "Required.", values: "Active (default), Inactive" },
              {
                name: "Sign-in code",
                what: "Two-factor sign-in for the portal. By default a code is e-mailed at every portal sign-in. Turn it off only when the customer asks.",
              },
              {
                name: "Temporary password",
                what: "Only when adding. Valid 24 hours; the customer changes it at first sign-in. The rules tick as they are met.",
              },
            ],
          },
        ],
      },
      {
        id: "how-to",
        title: "How to add a login or reset a password",
        blocks: [
          {
            kind: "steps",
            title: "Add a login",
            items: [
              "Click **Add portal user**.",
              "Pick the **Enterprise**, fill in the name, **Email** and **UserName**.",
              "Type a **Temporary password** that meets every rule and click **Add portal user**.",
              "Send the customer their username and, separately, the temporary password.",
            ],
          },
          {
            kind: "steps",
            title: "Reset a password",
            items: [
              "Click the login, then **Change password** on the **Login** tab.",
              "Type the **New Password *** twice and click **Set temporary password**. It works for 24 hours and must be changed at first sign-in.",
            ],
          },
          {
            kind: "tip",
            text: "To stop a contact signing in but keep their history, set **Status** to Inactive instead of deleting. Deleted logins are archived and can be restored by an administrator.",
          },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ concept: passwords and 2FA
  {
    id: "passwords-and-2fa",
    title: "Passwords and 2FA",
    group: "Admin",
    summary:
      "The monthly password change, the Change Password screen, setting up 2FA with an authenticator app, which actions ask for a 2FA code, and the rules for sensitive exports.",
    keywords: [
      "password expired",
      "change password",
      "monthly password",
      "2FA",
      "two-factor",
      "TOTP",
      "authenticator",
      "Google Authenticator",
      "temporary password",
      "encrypted export",
    ],
    sections: [
      {
        id: "monthly",
        title: "The monthly password change",
        blocks: [
          {
            kind: "text",
            text: "Everyone who signs in (all staff and customer portal users) must change their password regularly: every 30 days unless an admin has set another lifetime on [[security|Security settings]]. The rule cannot be switched off.",
          },
          {
            kind: "list",
            items: [
              'From the first reminder day (by default 7, 3 and 1 days before) a banner in the top bar says "Your password expires in N days" with **Change now** and **Later**. You also get an e-mail; it never contains a password or a sign-in link.',
              "When the password has expired, is temporary, or an admin forced a change, only the **Change your password** screen shows. No other page works until you change it. If you already had the system open, you are sent there on your next action.",
              "Changing the password signs you out of every other session and device.",
            ],
          },
        ],
      },
      {
        id: "change-screen",
        title: "How to change your password",
        blocks: [
          {
            kind: "steps",
            items: [
              "Open the avatar menu (top right) and choose **Change password**, or click **Change now** on the banner. When your password expired, the screen opens by itself.",
              "Type your **Current password**.",
              "Type the **New password** and repeat it in **Confirm new password**. Use **Show** to check what you typed.",
              "Watch the rules under the boxes tick as they are met.",
              "Enter the 6-digit code. It is always needed: with 2FA on, the **2FA code (from your authenticator app)**; without it, click **Send code** and type the **Code sent to your e-mail** (it works for 10 minutes).",
              "Click **Change password**. The message says how many other sessions were signed out and the date of your next change.",
            ],
          },
          {
            kind: "fields",
            title: "Password rules",
            fields: [
              { name: "At least 12 characters", what: "Admins can raise the minimum, never lower it below 12." },
              { name: "Not your username or name", what: "It may not contain your username, first or last name." },
              { name: "Not one of your last 12 passwords", what: "Admins can raise this to up to 24." },
              {
                name: "Not on a known-leaked password list",
                what: "Common passwords such as `password1234` are refused.",
              },
            ],
          },
          {
            kind: "tip",
            text: "A long phrase of several unrelated words is easy to remember and meets every rule, e.g. `orange river lamp 42`.",
          },
        ],
      },
      {
        id: "temporary",
        title: "Temporary passwords and forced changes",
        blocks: [
          {
            kind: "list",
            items: [
              "An admin (or a role with **Change passwords**) can set a temporary password on [[users]] or [[customer-portal]]. It works for 24 hours by default, signs out your open sessions, and must be changed at first sign-in.",
              "An admin can also **Force change** for one or many users: they must change their password at the next sign-in.",
              "If you forget your password, ask an admin for a temporary one.",
            ],
          },
        ],
      },
      {
        id: "2fa-setup",
        title: "Setting up 2FA with an authenticator app",
        blocks: [
          {
            kind: "text",
            text: "2FA (two-factor authentication) means you need a second proof besides your password: a 6-digit code from an app on your phone that changes every 30 seconds. The code is also called TOTP (time-based one-time password).",
          },
          {
            kind: "steps",
            items: [
              "Install an authenticator app on your phone, for example Google Authenticator.",
              "An admin opens your user on [[users]], tab **Password & 2FA**, and clicks **Enable QR 2FA**, then **Create secret**.",
              "In the app, add an account and type the key shown (or scan the link as a QR code).",
              "Read the 6-digit code from the app; the admin types it in **6-digit code** and clicks **Confirm**.",
              "From now on, use the app's current code whenever the system asks for a 2FA code.",
            ],
          },
          {
            kind: "warning",
            text: "Lost or changed your phone? Ask an admin to click **Disable QR 2FA** on your user and enrol the new phone.",
          },
        ],
      },
      {
        id: "needs-2fa",
        title: "Which actions ask for a 2FA code",
        blocks: [
          {
            kind: "list",
            items: [
              "Signing in.",
              "Changing your own password (when 2FA is set up on your account).",
              "Making an export package that includes trunk credentials, and downloading it, on [[migration]].",
              "Running an import whose files hold trunk credentials (System ID, username, password, host, port).",
            ],
          },
          {
            kind: "tip",
            text: "The number of users without 2FA is shown on [[security|Security settings]]; the 2FA column on [[users]] shows who has it.",
          },
        ],
      },
      {
        id: "sensitive-exports",
        title: "Sensitive exports (credentials)",
        blocks: [
          {
            kind: "list",
            items: [
              "Trunk connection details (System IDs, usernames, passwords, hosts, IPs and ports) are the most sensitive data. Only admins can export or import them.",
              "Every such export or import asks for your 2FA code. Your own account must have 2FA set up first.",
              "The package is an encrypted file. It opens only with the password you choose when making it (at least 12 characters), which is not stored anywhere.",
              "You can leave passwords out (untick **Also include passwords**) and set them separately later.",
              "The download link is made for you, works once and expires after 15 minutes.",
              "Every credential export and import is written to the [[audit|Audit trail]] and the other admins get an e-mail.",
            ],
          },
        ],
      },
      {
        id: "related",
        title: "Related topics",
        blocks: [
          {
            kind: "text",
            text: "[[security|Security settings]] · [[users]] · [[customer-portal]] · [[migration]] · [[logged-in|Logged-in users]]",
          },
        ],
      },
    ],
  },
];
