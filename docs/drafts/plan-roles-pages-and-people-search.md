# Plan: page access per role, custom roles, and people search in the invite box (Fable 5.2, Nov 15 2026)

Status: a plan and a design preview. Nothing is built. The owner approves the preview first: `design/previews/roles-and-people.html` (open it in a browser; it shows phone and computer, light and dark, and every control responds).

What the owner asked for: build different editor roles like the ERP (pick which pages each role sees; some editors see every page but hold no admin powers, some see a few pages), and have the invite box suggest people from his Google as he types, like the ERP.

Every builder first reads: CLAUDE.md, the root AGENTS.md, docs/PORTING.md, docs/MOBILE-PASS.md, supabase/README.md, and the Next docs in node_modules/next/dist/docs for any API they touch (route handlers, cookies, server actions). Rules for all sections: no Tailwind, design system classes and tokens only, 44px targets on phones, no sideways scroll, light and dark, every dropdown has a search bar, code checks permissions and never role names, never a hard delete, never open a .env file, never read or change the ERP repo beyond reading it.

## What the ERP does (read only, for reference)

- Roles (noun-erp/client/src/pages/Settings.tsx 355 to 640, client/src/lib/permissions.tsx, client/src/mock/team.ts): role chips with a color dot and member count; "Create custom role" (Name, Start from, Create, Cancel); the chosen role's pill, description, "Used by", "View as", "Reset to built-in" (only once a built in role was changed), "Delete role" (blocked while people hold it). Left "What this role can do": one row per area with View, Edit, Approve pills, a dash where it does not apply, scope chips on Orders. Right "Sensitive switches". Bottom "Compare all roles" with a dot legend. Rule: Edit and Approve need that area's View.
- People search (client/src/design/PersonField.tsx, client/src/lib/google-people.ts, server/people.ts): a 220 ms debounced search as you type; the server calls the People API with the person's own Google token: `people:searchDirectoryPeople`, `people:searchContacts`, `otherContacts:search` (people emailed), one empty warm up search first, merged, deduplicated by email, 8 results, tagged "Company directory" or "Contact". Nothing stored. A source that fails is skipped. Typing a new address always works.

## The design in one page

One fixed permission list stays the single truth (src/lib/access/permissions.ts equals the permissions table). It grows from 24 keys to 46:

- **22 new page keys**, one per screen except Home: `page.analytics`, `page.calendar`, `page.upload`, `page.review`, `page.studio`, `page.carousels`, `page.ugc`, `page.bank`, `page.posting`, `page.accounts`, `page.brand`, `page.templates`, `page.library`, `page.sounds`, `page.discovery`, `page.community`, `page.competitors`, `page.ads`, `page.activity`, `page.audit`, `page.rules`, `page.settings`. Group `pages`. Home is always open (it is the fallback page).
- **The 24 action keys do not change.** They stay the database's lock on data and actions. The Roles page only shows them in a new layout.

How the Roles page maps onto keys (this table is the contract for sections A, B and C):

| Page (sidebar order) | View | Edit | Approve |
|---|---|---|---|
| Home | always | none | none |
| Analytics | page.analytics (needs posting.numbers) | none | none |
| Calendar | page.calendar | calendar.plan | none. Scope chips: "Only their cards" or "Every card" = calendar.all_cards |
| Upload | page.upload | footage.upload | none |
| Review | page.review | review.notes | review.approve |
| Studio | page.studio | studio.make | none |
| Carousels and photos | page.carousels | studio.make (moves with Studio) | none |
| UGC, mentions and comments | page.ugc | none yet (replying gets its own key when built) | none |
| Bank and schedule | page.bank | posting.bank | none |
| Posting | page.posting | none (who may post is per person: their channels) | none |
| Accounts | page.accounts | posting.accounts | none |
| Brand kit | page.brand | brand.manage | none |
| Templates | page.templates | brand.manage (moves with Brand kit) | none |
| Library | page.library | none | none |
| Sounds | page.sounds | brand.manage (moves with Brand kit) | none |
| Discovery, Community, Competitors, Ads | page.<key> | none yet | none |
| Activity | page.activity (needs team.activity) | none | none |
| Audit trail | page.audit (needs team.activity) | none | none |
| Checker rules | page.rules | rules.propose | rules.approve |
| Settings | page.settings | none (the tabs inside follow the switches) | none |

"Other switches" on the right, in three blocks, hold the 13 action keys that are not tied to one page:
- Everyday work: footage.direct, footage.reply, calendar.setup.
- Sensitive: posting.numbers, posting.all_channels, team.activity, settings.view.
- Admin powers: team.manage, team.roles, spaces.all, spaces.manage, ai.setup, integrations.manage.

Rules of the editor (pure functions in permissions.ts, tested):
1. Edit and Approve on a page are only "on" when the page's View is on. With View off the pills are dimmed; the action key itself is left alone (another page may share it, and the database lock must not move by surprise).
2. A page that is empty without a data switch moves with it: turning on View for Analytics, Activity or Audit trail also turns on its data key, and says so in a toast; turning that data key off hides those pages, and says so.
3. A shared Edit key (Studio with Carousels; Brand kit with Templates and Sounds) is one switch shown on each row; the row says "Edit moves with Studio".
4. Everything already true stays true: nobody edits their own role, nobody gives a key they lack, the Owner role is locked, a role in use cannot be removed.

What "hidden and blocked" means, honestly:
- Hidden: the sidebar, the phone bar, the More sheet, search and Home links all read one function, `canOpen(viewer, screen)`, which becomes "holds the page key" for every role (the hardcoded EDITOR_SCREENS and VIEWER_SCREENS lists go away; the five prebuilt roles get the same pages as today through their seed, so nothing changes for them).
- Blocked on the server: every page.tsx under src/app/(app) calls one server helper before it reads anything, and draws NoAccess instead of the page. Today the block is drawn by the client shell only; this moves it to the server so the page's data is never sent.
- The data lock stays the action keys in row level security. A page key shows or hides a page; it never opens data by itself. That is why rule 2 exists.

The owner's two editor examples ship as ready roles in the sample team and as choices in "Start from" (they are examples he can change, not prebuilt roles in the database, because no demo data goes in the database):
- **Editor, every page**: every page except Activity, Audit trail, Checker rules and Settings; Edit only on Upload; Reply to notes on; See post numbers on (Analytics needs it); every Admin power off.
- **Editor, basics**: Home, Calendar (only their cards), Upload, Review; Edit on Upload; Reply to notes on.

Open question for the owner (does not block the build, the default is shown in the preview): should "every page" for a senior editor include the Team pages (Activity, Audit trail, Checker rules)? The default says no, because the audit trail shows everyone's activity, which reads as an admin power.

## Owner decisions after the preview (Nov 15 2026)

- Every space is ticked by default when inviting someone; the inviter unticks what they should not open. Already done in src/components/settings/team/InviteSheet.tsx. Section C: when invites get a spaces column, a new invite with no choice made means every space, and a person let in from an invite gets every space unless it was unticked.
- Opus 5.5 builds every section (the owner asked for Opus builders). Fable planned and designed, and reviews B and E against the preview.
- "Editor, every page" leaves out the Team pages (Activity, Audit trail, Checker rules) by default, as in the preview; the owner may still change it.

## Section A. The permission list, page keys and nav (Opus 5.5 builder)

Files: src/lib/access/permissions.ts, src/lib/nav.ts, src/lib/access/view-as.ts, src/lib/team/roles.ts, src/lib/sample/access.ts, tests in src/lib/access/*.test.mjs.

1. permissions.ts: add group `pages` and the 22 page keys in sidebar order, with label = the screen's label and hint null. Add `PAGE_KEY: Record<ScreenKey, PermissionKey | null>` (Home null), `PAGE_EDIT`, `PAGE_APPROVE`, `PAGE_NEEDS` and `SWITCH_GROUPS` exactly as the table above, plus pure helpers `pageState(role, screen)` (view, edit, approve, each on, off, dimmed or not available), `withPageView(role, screen, on)` and `withSwitch(role, key, on)` that return the key changes of rules 1 to 3 as a list of ticks and unticks, so the screen and the tests share one rule. A test asserts every one of the 46 keys appears exactly once in the layout (a page pill, a scope chip or a switch), so a future key cannot be forgotten.
2. PREBUILT_ROLES get their page keys: owner and admin all; strategist and editor the eight of today's EDITOR_SCREENS; viewer analytics and calendar. Result: no visible change for the five roles.
3. nav.ts: `canOpen(viewer, key)` = Home, or the viewer holds PAGE_KEY[key] (Owner: all). Remove `allowed`, EDITOR_SCREENS, VIEWER_SCREENS and SCREEN_NEEDS; keep EDITOR_PHONE_BAR as an order only. The phone bar becomes: the first four pages the person may open from a fixed order (home, review, upload, studio, calendar, bank, analytics), then More; the raised Upload button shows only with page.upload. `hasEditorHome` stays as is.
4. view-as.ts: no format change (permissions are carried as keys); the 4000 character cookie limit still fits 46 keys, assert it in a test.
5. The sample team (src/lib/sample/access.ts, src/lib/team/roles.ts) gains the two example roles with one sample person each.
6. Tests: the five prebuilt roles open exactly today's screens; the two examples open exactly their lists; rules 1 to 3; the count of keys; access.test.mjs still matches the draft seed word for word (after section C edits the draft).

## Section B. The Roles page (Opus 5.5 builder; Fable 5.2 reviews against the preview)

Files: src/components/settings/team/RolesPanel.tsx, RoleEditor.tsx, NewRoleSheet.tsx, role-ui.tsx, a new src/components/settings/team/CompareRoles.tsx, a new src/design/screens/roles.css (plus its import line). The new classes are in the preview's first style block (`.perm`, `.pg`, `.prow-list`, `.sec-row`, `.sw`, `.rdot`, `.menu-see`, `.cmp*`, `.dots`); copy them as they are, tokens only.

Build exactly what the preview shows:
- Role chips: color dot, name, member count; "Create custom role" as the dashed chip (owner and admins only).
- Create custom role (the existing sheet): Name, Start from (the searchable dropdown: every role the person may give, the two examples, and "Nothing ticked"), Create and Cancel. The new role copies the pages and switches of its start.
- Role card header: the role's pill, "Prebuilt", "Custom role" or "Cannot be changed", "N of 23 pages"; "View as {role}" (test runs only, already built); "Reset to built-in" only on a prebuilt role that differs from PREBUILT_ROLES; "Remove role" on a custom role, disabled with the reason while people or open invites hold it. Custom roles: Name and "What it is for" fields saved on blur (rename). "Used by" names, wrapped, never cut.
- Left "What this role can do": a block per sidebar section with "N of M pages" and Show all or Hide all; a row per page with View, Edit, Approve pills (a small bar where it does not apply, with a spoken label); the Calendar scope chips. On a phone the three pills sit under the page name and share the width.
- Right: "What they will see" (the pages as tags, and how many are hidden), then "Other switches" in the three blocks with the app's one Toggle.
- Bottom: "Compare all roles": sticky first column, sideways scroll inside its own box with the edge fade (a deliberate scroll row, allowed by MOBILE-PASS rule 6), dot legend.
- A tick saves at once through the existing TeamApi (`setRolePermission`); the helpers from section A decide which keys move; a refusal shows the reason from `editRoleRefusal`. Reset is a list of ticks and unticks through the same call, never a delete.
- Preview honesty: in sample mode and on a test run nothing is saved and the toast says so.

Needs Fable: no new design decisions; Fable 5.2 only compares the built screen with the preview on phone and computer, light and dark, before it is shown to the owner.

## Section C. The database (Opus 5.5 builder; the owner approves the file before it moves)

Decision: **fold into the team access draft, do not write a second migration.** docs/drafts/team-access-migration-draft.sql is not live, so it is edited in place and still becomes one file, `supabase/migrations/<timestamp>_team_access.sql`, only after the owner approves it. Custom roles (create from a start, rename, remove without deleting, reset) are already in that draft: tables `permissions`, `roles`, `role_permissions`, `profile_role_changes`, with `guard_role` and `guard_role_permission`.

Changes to the draft:
1. Section 2 seed: 22 more rows in `permissions` (group_key `pages`, group_label `Pages`, sort_order 300 and up, same words as permissions.ts) and the prebuilt roles' page rows exactly as section A step 2.
2. Nothing else needs a new table or column. The existing guards already cover page keys, because they work on any key in the list: only a key the actor holds, never their own role, never the Owner role. No row level security policy reads a page key, on purpose (data stays behind the action keys).
3. "Create from a start" is done by the app as ordinary ticks on the new role, so each tick passes the guard. "Reset to built-in" is ticks and unticks toward the seed. No new function.
4. Tests (docs/drafts/team-access-tests-draft.mjs.txt, later supabase/tests): an admin gives a page key they hold; a person without team.roles cannot; nobody ticks a page on their own role; a custom role made from Editor carries the editor's eight pages; unticking sets deleted_at and the history row stays; the permission count is 46 and matches permissions.ts.
5. Until this migration is live, the real team keeps showing the five prebuilt roles read only (today's behavior) and the role builder works on the sample team. docs/DATA.md gets the new group in the same commit as the migration.

The Gmail invites migration (20261115120000_gmail_invites.sql) is live and already has `google_links.scopes`, so people search needs **no database change**.

## Section D. Blocking pages on the server (Opus 5.5 builder)

Files: a new src/lib/auth/guard-screen.ts, every page.tsx under src/app/(app), src/components/shell/AppShell.tsx, Sidebar.tsx, MobileNav.tsx, NoAccess.tsx.

1. `guardScreen(key)`: a server helper that reads the viewer (getViewer, so View as on a test run is honored for drawing; real saving still follows getAccess) and returns whether the page may be drawn. Each page.tsx calls it first and returns `<NoAccess screen=... />` before any data read. Check the Next 16 docs for the right way to do this in a server component with cacheComponents; do not guess from older versions.
2. Nested routes take their parent's key (/calendar/card/1 is Calendar, /tasks follows Home).
3. The client guard in AppShell stays as the second layer. Sidebar sections with no visible page are not drawn. The More sheet and search list only pages the person may open.
4. Server actions keep checking action keys with getAccess (no change), so a hidden page's actions were never reachable by a page key alone.
5. Tests: a table test over all 23 screens for the two example roles and the five prebuilt ones; by hand: View as "Editor, basics", type /bank in the address bar, see NoAccess and no bank data in the page source.

## Section E. People search in the invite "Who" box (Opus 5.5 builder)

Already done by the owner's go ahead in Google Cloud (project noun-art): the People API is enabled, and contacts.readonly, contacts.other.readonly and directory.readonly are saved under Google Auth Platform, Data Access, next to gmail.send. No console step is left for the owner. drive.file is not used.

Files: src/lib/google/env.ts, actions.ts, a new src/lib/google/people.ts, a new src/app/api/people/search/route.ts, a new src/components/PersonField.tsx, src/components/settings/team/InviteSheet.tsx, src/components/settings/GoogleCard.tsx, src/lib/google/result.ts, src/app/auth/callback/route.ts, src/app/privacy/page.tsx, src/lib/sample (sample contacts), tests in src/lib/google/google.test.mjs.

1. Scopes. env.ts: `PEOPLE_SCOPES` = `https://www.googleapis.com/auth/contacts.readonly`, `https://www.googleapis.com/auth/contacts.other.readonly`, `https://www.googleapis.com/auth/directory.readonly`. `startGoogleConnect` asks for gmail.send plus these three on the same Connect step (access_type offline, prompt consent, include_granted_scopes true, login_hint as today). Open Google in a new tab like the ERP's google-people.ts (`skipBrowserRedirect: true`, then open the returned URL), so the invite being typed is not lost; fall back to the same tab when the browser blocks the new tab. The callback keeps requiring gmail.send only; the people scopes are optional (Google lets a person untick them), and whatever was granted is saved in `google_links.scopes` as today.
2. The owner and each admin reconnect once: the Google card shows "Suggestions while typing: off. Connect again to turn them on" when the saved scopes lack the people scopes, with the same Connect button. After connecting, a browser event tells every open Who box to search fresh.
3. The server route: `GET /api/people/search?q=` (a route handler, not a server action, so quick typing can cancel old requests). Steps: the person's own session; active and holds team.manage (only people who may invite can search); read their own google_links row with their own session; unseal; refresh the access token; then in parallel `people:searchDirectoryPeople` (sources DOMAIN_PROFILE and DOMAIN_CONTACT), `people:searchContacts` and `otherContacts:search`, page size 10, read mask names, emailAddresses, photos, organizations (names and emailAddresses for other contacts), with the one empty warm up search the first time per person. Merge in that order, deduplicate by lowercased email, tag "directory" or "contact", return at most 8 as `{ state, people: [{ name, email, photo, source }] }`. `q` is trimmed and cut to 80 characters and travels only to Google. States: `ok`, `connect` (no connection), `reconnect` (connected without the people scopes, or Google answers 403), `not-set-up`, `off` (not signed in or may not invite). A source that fails is skipped, never an error page.
4. Nothing stored: no table, no log line with the query or the results, response header `Cache-Control: private, no-store`. A small cache lives only in the browser tab's memory (like the ERP) and is cleared on connect and disconnect. Photos load straight from Google with `referrerPolicy="no-referrer"`; check the app's image and content security settings allow it, else show initials.
5. Test run and preview: with no keys (the sample preview) the box searches a short list of sample contacts in src/lib/sample, tagged the same way, so the owner can try it. Signed in on localhost it may use the real search, because it is the person's own Google data, not Noun ART content; it never reads or writes content tables (`usesRealContent()` is not involved). Sending stays off on a test run as today.
6. `PersonField` (shared, in src/components, so every later "type an email" box uses the same one; this is the owner's "anytime we type in an email"): the label "Who", a sunk field with a search icon, 16px text, `inputMode="email"`, no autocapitalize. Under it, inside the sheet (never a floating layer, so the phone keyboard cannot cover it): up to 5 rows, 56px each: photo or initials, name, email, the tag. A person already on the team or invited is shown dimmed with "Already on the team" and cannot be picked. A typed valid email that matches nobody gets a last row "Invite name@x.com, New address". Arrow keys, Enter and Escape work on a computer; the first pickable row is highlighted. Picking shows the person as one chip with an x. 220 ms debounce, at least 2 characters, old requests cancelled.
7. Not connected or needs reconnect: plain typing works exactly as today, and one line under the field says how to turn suggestions on, linking to Settings, Integrations. The invite is never blocked by search.
8. InviteSheet uses PersonField for the email; the rest of the sheet does not change. The Integrations card for Google names the new use in one line.
9. The privacy page, in the same commit (today it says the app only sends invites). Add a third bullet under "What we get from your Google account":
   "**Contact suggestions (optional):** if you connect Google in Settings, Noun ART can look up names and email addresses in your Google contacts, the people you have emailed and your company directory, only while you type in an invite box, to suggest who you mean. It reads them at that moment and stores nothing: no contact, no search and no result is saved. The only address kept is the one you choose to invite."
   Also change the Gmail bullet's last sentence to stay exact: "Noun ART cannot read, search, change or delete your mail, and it never asks for that permission." stays; add "It can look up contacts only as described below." Update the date on the page. src/app/terms needs no change.
10. Docs in the same commit: docs/SETUP.md (the reconnect step, and that the Google Cloud part is done), docs/BUILT.md, docs/DECISIONS.md, CLAUDE.md status line.

Risk to tell the owner plainly: these three are "sensitive" Google scopes, like gmail.send. If the consent screen is External and not verified, Google shows its warning screen and caps the app at 100 users until it is verified. Only the owner and admins connect, so the cap is not a problem, but the warning screen will show the new permissions on the reconnect. The directory search only returns people for nounnaturals.com accounts; for anyone else that source is quietly empty.

## Section F. Tests, phone pass, crash checks, push

1. Each builder runs before handing back: `npm run typecheck`, `npm run lint`, `npm run build`, `npm test`. Section C also runs `npm run test:db` once its file is in supabase/ (not before the owner approves it).
2. Unit tests named in each section. For people search, google.test.mjs gets a fake fetch: three sources merged and deduplicated, a failing source skipped, 403 gives `reconnect`, no link gives `connect`, the query cut to 80 characters, nothing written to the database, a person without team.manage gets `off`.
3. Phone pass (a Sonnet 5.5 agent, after sections B and E, before the owner sees it): Roles page and the invite sheet at 390 and 360 wide, light and dark, keyboard open in the Who box (suggestions stay visible above the keyboard, the Send button stays sticky in the sheet), 44px targets on every pill, switch and suggestion row, no sideways scroll except the Compare table inside its own box, "Used by" wraps, sheet max height 86dvh with the page behind locked. Findings go into docs/MOBILE-PASS.md and are fixed.
4. By hand on localhost, phone width and computer, light and dark: build "Editor, every page" and "Editor, basics" from Create custom role; View as each; check the sidebar, phone bar, More sheet; type a hidden page's address; reset a changed prebuilt role; type in the Who box in the three Gmail states.
5. Before the push, a Sonnet 5.5 agent and a Haiku 5.5 agent each check the whole change for crashes on their own (null roles, a role with zero pages, a person whose role was removed, the cookie with 46 keys, Google answering slowly or not at all, a double tap on a pill, the route called signed out). Fix what they find.
6. Then, as separate commands and never chained: check for conflict markers, add, commit, push. The team access migration is pushed only after the owner approves the SQL, in its own commit.

## Order and who builds

1. The owner approves the preview (and answers the one open question, or accepts the default).
2. Section A (Opus 5.5), then B and D in parallel (two Opus 5.5 builders; B owns src/components/settings/team and roles.css, D owns the pages and the shell).
3. Section E (one Opus 5.5 builder) can run in parallel with A to D: it shares no file with them except InviteSheet.tsx, which only E edits.
4. Section C (Opus 5.5) edits the draft and its tests alongside A; the file moves into supabase/migrations only on the owner's yes.
5. Fable 5.2 reviews B and E against the preview, then the Sonnet phone pass, then the Sonnet and Haiku crash checks, then the push.

No section needs Fable to build it. Fable builds only if the owner says "build it with Fable".
