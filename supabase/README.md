# The database

`migrations/20261115000000_init.sql` is the first database migration: 79 tables, every rule for who sees and
changes what, the status automation, the posting rule and the audit trail. docs/DATA.md explains it in plain words.

**This folder is live.** The Supabase project `noun-art` (production) is linked to this GitHub repo, and Supabase
runs every new file in `supabase/migrations` by itself when main is pushed. The switch for that ("Deploy to production",
branch `main`, in Project Settings, Integrations, GitHub) was turned on by the owner on Nov 15 2026; automatic
branching stays off. So:

- A file in `migrations` is never edited after it was pushed. A change is always a new file with a later
  timestamp in its name (`YYYYMMDDHHMMSS_name.sql`).
- A file that is not ready does not go in `migrations`. Keep it out of this folder until the owner approves it.
- Nothing is ever run on the project by hand, and no test or seed of demo data ever touches it. There is one
  Supabase project (no test project); a test run on localhost signs in for real but shows demo data only: it
  never reads, adds or changes the real content (see `src/lib/database-target.ts`). Rules that write are tested here, on the throwaway database.

## Tests

`npm run test:db` loads the migrations into a throwaway in memory Postgres (PGlite) with stand ins for what
Supabase provides (the roles, the `auth` schema, the realtime publication and Supabase's default grants) and runs
the behavior tests in `supabase/tests` (every file in `migrations`, in order, as on the live project; 213 tests), acting as owner, admin, strategist, editor, viewer, a stranger
and our own server. Run it before every commit that touches this folder.

Proven only on the stand ins, so the first run on the real project and the first real Google sign in are the
real test of: the sign in trigger on `auth.users` (it makes a profile only for a Google sign in, read from
`raw_app_meta_data ->> 'provider'`), realtime, and the two extensions (`pgcrypto`, `pg_trgm`).

Note on timestamps: the newest live file is 20261120000000_notion_scripts.sql, and three drafts already hold later ones: the two Frame.io drafts (20261120100000 and 20261121000000) and Upload/Files (20261122000000). Every new migration must use a timestamp later than all of them: two files never share one.

## Drafts

A migration that waits for the owner's yes lives in `docs/drafts`, never here. Its tests still run in `npm run test:db`: the suite finds the file by the end of its name (`draftOrLive` in `tests/helpers.mjs`), loads the draft after every live migration, and from the day the file moves into `migrations` it uses the live file by itself. The suites that count tables, permission keys and open functions do the same (`FILES_READER`, `DRAFT_ONLY_KEYS`, `LIVE_LABELS`), so moving an approved draft needs no test edits.

Waiting now: only the Meta posting draft, `supabase/drafts/20261119300000_meta_posting.sql`. When the owner approves it, it needs a timestamp later than 20261123000000 (the Additional content migration is live), so rename it before it moves into `migrations`, in its own push, after the code is pushed and republished. `supabase/migrations/20261122000000_files_and_reader.sql` went live Nov 16 2026 (tests in `tests/files-reader.test.mjs`; explained in docs/DATA.md).

`supabase/migrations/20261123000000_additional_content.sql` (Additional content, a space of folders) went live Nov 17 2026 on the owner's yes (tests in `tests/additional-content.test.mjs`; explained in docs/DATA.md).

Live (owner's yes, Nov 17 2026): `supabase/migrations/20261123200000_moved_edits_team.sql` (data only, no schema change): the edits moved into Noun Naturals on Nov 17 2026 lose their uploader, so Send to editor on them goes to the whole editing team (`edit_requests.sent_to` null), and notes already sent on them to Daryna go to the team too. Tests in `tests/moved-edits-team.test.mjs`. The Meta posting draft then needs a timestamp later than this one.

## Rules for the next migration

- Grant every new table and function explicitly to the roles that need it. Nothing is open by default: the
  first migration revokes everything new from `anon`, `authenticated` and `public`.
- Never grant delete on any table.
- Run each new table through the same steps the first migration runs in its loops: row level security on, the
  `no_hard_delete` and `no_truncate` triggers, the `zz_audit` trigger (and `updated_at` and realtime where they apply).
  Those loops only ran once, over the tables that existed then, so they do not cover tables added later.
- The default that takes execute away from `public` is global on purpose: Postgres gives every new function to
  `public` by a built in default, and only the global form can take that away; a per schema form cannot. So after
  any later `create extension` run by this role, the migration that adds it must grant execute on that
  extension's functions explicitly.
- A person action on a row our server owns (decide on an agent's plan, mark a check wrong, mark a notice read)
  comes as its own narrow function, like `public.set_card_shot`, never as a wide update permission.
- A person function that must change a column only the system sets (as `public.retry_clip` does on raw_clips) is `security definer`, checks the permission itself, and marks its own write for the table's guard inside its transaction. Never loosen the guard for everyone.
- Functions for our own server only (the reader's `claim_clip_jobs`, `reserve_ai_spend`, `finish_clip_index` ...) are granted to `service_role` alone and tested as refused for every signed in role.
- Add a behavior test for every new rule, and keep the whole suite green.
