# Noun ART published pages build: rules for every builder (Fable 5.2 orchestrator, Nov 15 2026)

Repo: `C:\Users\Khaled NOUN NATURALS\Content Sytstem For Noun` (Next.js 16, Supabase). You are one of several builders
working in this same folder at the same time. Each has its own section and its own files. Your brief names yours.

## The job, in one line
Today your screen works on demo data on localhost and shows empty or "Being connected" in the published app. Make it
real in the published app, and keep the demo on localhost working.

## Read first (in this order, skim what is not about your screen)
1. `CLAUDE.md`, `docs/HANDOFF.md`, `AGENTS.md` (this Next.js is new: check `node_modules/next/dist/docs/01-app` before
   using an API you are not sure of; `cacheComponents` is on).
2. Your screen's part of `docs/CONCEPT.md`, `docs/DATA.md` (the tables), `docs/DECISIONS.md` (search your screen's name).
3. `docs/PORTING.md` and `docs/MOBILE-PASS.md` (how a screen is ported, phone and iPad rules).
4. The patterns you must copy:
   - `src/lib/database-target.ts` and `src/lib/content/mode.ts` (real vs demo).
   - `src/lib/content/calendar-actions.ts`, `calendar-rows.ts` (`gate`, `fail`, `dbFail`, `isUuid`), `calendar-db.ts`
     (server actions and reads with the person's own session), and `src/lib/content/calendar.ts` (a loader that
     serves demo or database rows to one screen component).
   - `supabase/migrations/20261115000000_init.sql` for your tables (grep the table name: columns, checks, triggers,
     row level security, grants) and the later migrations. The database's rules are the lock: read them before you
     write an insert, many columns are filled or refused by triggers.
   - `supabase/tests/helpers.mjs` and `supabase/tests/edit-intake.test.mjs` (database tests on a throwaway PGlite,
     and how a DRAFT migration is tested without becoming live).

## Hard rules
- **Published vs test run.** The published app (`usesRealContent()` true) reads and writes real data and shows NO demo
  data, not one sample name, number or picture. A test run (localhost) shows demo only and never reads or writes the
  real content. Every read and write goes through that check.
- **Demo content** reaches a screen only through `src/lib/content/demo-bundle.ts` via `demo()` in `mode.ts`.
  `src/lib/content` is the only importer of `src/lib/sample` by value (types are free). Never add a file to
  `src/lib/content/sample-importers.mjs`.
- **Every server action**, in this order: signed in and let in (`getAccess`), `usesRealContent()` (a test run answers
  "test-run" and saves nothing, without opening the database), a permission key from `src/lib/access/permissions.ts`
  (never a role name), then the write with the person's own Supabase session so row level security stays the lock.
  Use the service role client (`src/lib/supabase/admin.ts`) only where the database says "only our server" and say
  why in a comment. Answers are plain words.
- **Never a hard delete** (`deleted_at`). **Big files never pass through our server.** **Nothing is posted, sent or
  messaged** without the owner's click, and no code path of yours may call a platform, Telegram, Gmail or any outside
  service that sends something, unless your brief says so.
- **Database.** `supabase/migrations` is LIVE on push: never add or edit a file there. First try to build on the live
  tables (the schema is rich). If you truly need a schema change, write ONE new file in `supabase/drafts/` with the
  file name your brief gives you, plus a test file in `supabase/tests/` that applies it only on the throwaway database
  (the edit-intake pattern). Build so that everything that can work on the live schema works without the draft, and
  the parts that need the draft are grayed with a plain reason until it is approved (detect the missing table or
  column and fall back; never crash). List exactly which is which in your report.
- **Never** read or print `.env.local`, never write real data, never commit, push, stash, reset or checkout. No new
  npm packages. Do not start or stop servers. **Never run `npm run build`** (a dev server runs on port 3000; the
  orchestrator runs the build at the end).
- **Design.** The approved look is the prototype, concept 6 "Iris on Tan":
  `http://localhost:5175/design/concepts/concept-6.html?x=1#<screen>.light` (or `.dark`; change the `?x=` number to
  redraw; source in `design/concepts/src`). Copy its markup into React with the same class names. Style only with
  `src/design`; extra CSS only in your own file under `src/design/screens/` with tokens only. No Tailwind, no hex
  colors, no new shadows. Every dropdown has a search bar (`Dropdown`, `FilterChip`). Platforms always as their real
  logo (`Pf`, `PfPill`). Phone and iPad first: 44px targets, no sideways scroll at 360, light and dark both finished.
- **Words on screen:** plain words, short, no hyphens or em dashes in sentences. He calls them "spaces", never
  "collections". Anything grayed says why in one plain line.
- **Empty and not connected states are finished states**: a calm empty card with one line saying what will appear
  and, where it helps, a button to the place that fixes it (for a missing connection: Settings, Integrations).

## Files: who may touch what
- You own only the files your brief lists (and new files in the folders it names).
- **Never touch** (another build, Cloudflare R2 for edited videos, is running in this folder right now):
  `src/components/edits/*`, `src/lib/content/edits.ts`, `edits-view.ts`, `src/components/upload/uploader.ts`,
  `queue.ts`, `UploadProvider.tsx`, any `src/lib/r2*` or storage files, the R2 entries of
  `src/lib/integrations/registry.ts`. You may import from them (types and functions) but not edit them.
- **Shared files, off limits unless your brief gives you one by name:** `src/lib/access/permissions.ts`,
  `src/components/settings/SettingsScreen.tsx`, `src/lib/integrations/registry.ts`, `src/lib/nav.ts`,
  `src/components/shell/*`, `src/lib/content/types.ts`, `lists.ts`, `shell.ts`, `home.ts`, `calendar*.ts`,
  `src/design/*.css` and `ui.tsx` (your own `src/design/screens/<yours>.css` is fine), `src/app/globals.css`,
  `supabase/tests/helpers.mjs`, `package.json`, `eslint.config.mjs`, `CLAUDE.md` and everything in `docs/`.
  Put new types in your own files. If you need a change in a shared file, work around it in your own files and write
  the exact change you want in your report under "Shared file requests".
- Two allowed small touches, done as one tiny Edit right after re reading the file:
  1. `src/lib/content/demo-bundle.ts`: one new `export * as <name> from "../sample/<name>";` line for a new sample
     module of yours.
  2. An existing shared test (`src/lib/content/screens.test.mjs`, `content.test.mjs`, `src/lib/access/*.test.mjs`)
     that asserts the old behavior of YOUR screen: change only the lines about your screen. New tests go in your own
     new `*.test.mjs` files.
- Other builders' half written files will sometimes make `npm run typecheck` or `npm run lint` fail in files that are
  not yours. That is their work in progress: ignore it, fix only your own files, and never "fix" theirs.

## How to prove it works (you cannot run the published app here)
- Keep the database talk thin and put the logic in pure functions (rows in, view out; input in, plan out), tested
  with plain objects in `*.test.mjs` next to the code (`npm test` runs `node --test`; look at how the existing
  tests import TypeScript, `src/lib/import/ts-resolve.mjs` and `src/lib/content/test-hooks.mjs`).
- For every write your actions make, add a database test in `supabase/tests/<your-section>.test.mjs` that runs the
  same insert or update as the right kind of person on the throwaway database and proves it is allowed, and that
  the wrong person is refused. This is how we know the published app will not fail on a rule in the database.
- Demo on localhost: open `http://localhost:3000/<your screen>` with the Browser pane tools **in your own new tab**
  (`tabs_create`, then pass that `tabId` to every call; never touch a tab you did not open; other builders use the
  same pane). Check 390 wide, 1180x820 (iPad) and 1440 wide, light and dark, beside the prototype. Reset the viewport
  (`preset: "desktop"`) and close your tab when done. If the page fails to load because another builder's file is
  mid edit, wait a little and try again.
- Before you report: `npm run typecheck` and `npm run lint` clean for your files, `npm test` and `npm run test:db`
  passing for your tests (run just your test files while iterating: `node --test <file>` the way package.json does).

## Your report (through SubagentHandback, plain words, exact)
1. Files you wrote or changed (absolute paths).
2. What now works in the published app, step by step as a person would use it.
3. What is grayed or not built, and the one line reason shown on screen.
4. Draft migrations (file, what it adds, what waits on it) and tests added (how many, passing?).
5. What the owner must do (keys by NAME only, clicks, approvals), in order.
6. Shared file requests (exact text) and one line each for `docs/BUILT.md` and `docs/DECISIONS.md`, plus anything
   `docs/DATA.md` or `docs/SETUP.md` should say.
7. Open questions for the owner, each with your recommendation.
8. What you checked in the browser and what you could not check.
If you run short of budget, stop at a point where your files typecheck, and say exactly what is complete and what is partial.
