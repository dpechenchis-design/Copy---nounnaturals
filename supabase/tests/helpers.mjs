/* Test helpers for the Noun ART database migration.
   A fresh Postgres runs in memory (PGlite, Postgres in WebAssembly), gets the few things Supabase provides that the
   migration does not create itself (roles, the auth schema, the realtime publication, Supabase's default grants),
   then runs the migration file. Nothing here touches the live Supabase project. */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";

const SUPABASE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The migration under test: supabase/migrations/*_init.sql (the drafts path is only an old fallback). */
export const MIGRATION_PATH = (() => {
  const dir = join(SUPABASE_DIR, "migrations");
  if (existsSync(dir)) {
    const hit = readdirSync(dir).filter((f) => f.endsWith("_init.sql")).sort()[0];
    if (hit) return join(dir, hit);
  }
  return join(SUPABASE_DIR, "drafts", "0001_init.sql");
})();

/** Every migration after the first, in the order Supabase runs them (by the timestamp in the name). */
const LATER_MIGRATIONS = (() => {
  const dir = join(SUPABASE_DIR, "migrations");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql") && join(dir, f) !== MIGRATION_PATH)
    .sort()
    .map((f) => join(dir, f));
})();

/** A migration that may still wait as a draft: found by the end of its name (the part after the timestamp) in
    supabase/migrations (live) or else in supabase/drafts or docs/drafts (the owner has not approved it yet). A suite
    loads a draft with freshDb({ extra: [path] }); once the file is live every freshDb() has it already. */
export function draftOrLive(nameEnd) {
  const live = join(SUPABASE_DIR, "migrations");
  const hit = existsSync(live) ? readdirSync(live).filter((f) => f.endsWith(nameEnd)).sort()[0] : undefined;
  if (hit) return { live: true, file: hit, path: join(live, hit) };
  for (const drafts of [join(SUPABASE_DIR, "drafts"), join(SUPABASE_DIR, "..", "docs", "drafts")]) {
    const draft = existsSync(drafts) ? readdirSync(drafts).filter((f) => f.endsWith(nameEnd)).sort()[0] : undefined;
    if (draft) return { live: false, file: draft, path: join(drafts, draft) };
  }
  throw new Error(`no migration or draft named *${nameEnd}`);
}

/** The Meta posting change (supabase/drafts/20261119300000_meta_posting.sql until the owner approves it). */
export const META_POSTING = draftOrLive("_meta_posting.sql");

/** Upload/Files and the Gemini reader (supabase/migrations/20261122000000_files_and_reader.sql, live since Nov 16 2026). */
export const FILES_READER = draftOrLive("_files_and_reader.sql");

/** Additional content, a space of folders (supabase/migrations/20261123000000_additional_content.sql, live since Nov 17 2026; it was a draft until the owner
    approves it). It adds no permission key and runs after Upload/Files. */
export const ADDITIONAL_CONTENT = draftOrLive("_additional_content.sql");

/** The spaces every fresh database starts with, in tile order: Noun Naturals and Founder, then Additional content
    once its migration is live. */
export const SEEDED_SPACES = ["noun", "founder", ...(ADDITIONAL_CONTENT.live ? ["additional"] : [])];

/** Cards every fresh database starts with: the six Halloween videos of Additional content once it is live. */
export const SEEDED_CARDS = ADDITIONAL_CONTENT.live ? 6 : 0;

/** The drafts that add a permission key src/lib/access/permissions.ts already lists, in the order they run (by the
    timestamp in the name), each with its key and the labels the live database keeps until it runs. */
const KEY_DRAFT_LIST = [
  { draft: META_POSTING, key: "posting.resolve", labels: {} },
  { draft: FILES_READER, key: "files.manage", labels: { "page.upload": "Upload" } },
].sort((a, b) => (a.draft.file < b.draft.file ? -1 : 1));
const waiting = KEY_DRAFT_LIST.filter((d) => !d.draft.live);

/** Permission keys the code lists that only a draft adds: the code has them, the live database not yet. Each one
    leaves this list on the day its draft is live, so the suites that compare the code with the live database count
    them by themselves from that day on. */
export const DRAFT_ONLY_KEYS = waiting.map((d) => d.key);

/** Labels the live database still has while a draft that rewords them waits (the Upload/Files migration, now live, relabelled the
    page key page.upload "Upload/Files", as the code says). Empty now that it is live. */
export const LIVE_LABELS = Object.assign({}, ...waiting.map((d) => d.labels));

/** The paths of the drafts that add a key and are not live yet, in the order they run: freshDb({ extra: KEY_DRAFTS })
    is the database with every key the code lists. Empty once they are all live. */
export const KEY_DRAFTS = waiting.map((d) => d.draft.path);

/** The keys the code lists that a database still lacks when it has every live migration plus the drafts in
    `loaded` (draftOrLive answers, for example [FILES_READER]). */
export const keysMissingWith = (loaded = []) => waiting.filter((d) => !loaded.includes(d.draft)).map((d) => d.key);

/* What Supabase gives every project before any migration runs (the parts this migration uses).
   auth.uid(), auth.role() and auth.jwt() read request.jwt.claims the way Supabase's own definitions do. */
const SUPABASE_BASE = `
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role supabase_auth_admin nologin noinherit;

create schema auth;
create table auth.users (
  id uuid primary key,
  email text,
  email_confirmed_at timestamptz,
  raw_app_meta_data jsonb not null default '{}'::jsonb,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;
grant usage on schema auth to anon, authenticated, service_role, supabase_auth_admin;
grant execute on all functions in schema auth to anon, authenticated, service_role;
grant all on auth.users to supabase_auth_admin;

create publication supabase_realtime;

-- The worst case of the "Automatically expose new tables" setting: Supabase grants everything on new
-- tables, sequences and functions in public to anon, authenticated and service_role. The migration must
-- take all of that back by itself.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`;

const fileName = (path) => basename(path);

/** A fresh database with every migration applied, as on the live project. `extra`: more SQL files (paths) run after it, in order, for
    example a draft migration under test (docs/drafts/paint-migration-draft.sql). `before`: stop before the first later migration whose
    file name is this or sorts after it (for example "20261116000000"), to build the world an older file left; then run the rest with
    applyMigrationsFrom. */
export async function freshDb({ extra = [], before = null } = {}) {
  const db = await PGlite.create({ extensions: { pgcrypto, pg_trgm } });
  await db.exec(SUPABASE_BASE);
  await db.exec(readFileSync(MIGRATION_PATH, "utf8"));
  for (const file of LATER_MIGRATIONS) {
    if (before && fileName(file) >= before) break;
    await db.exec(readFileSync(file, "utf8"));
  }
  for (const file of extra) await db.exec(readFileSync(file, "utf8"));
  return db;
}

/** Run every later migration from the one named `from` on, as the database owner with nobody signed in (as Supabase runs a migration). */
export async function applyMigrationsFrom(db, from) {
  const files = LATER_MIGRATIONS.filter((f) => fileName(f) >= from);
  if (!files.length) throw new Error(`no migration from ${from}`);
  for (const file of files) await db.exec(readFileSync(file, "utf8"));
  return files.map(fileName);
}

/** Run exactly one later migration, the one whose file name starts with `name` (its timestamp), as applyMigrationsFrom
    runs them. For a suite that proves what that one file does on the world just before it, without the later files. */
export async function applyMigration(db, name) {
  const files = LATER_MIGRATIONS.filter((f) => fileName(f).startsWith(name));
  if (files.length !== 1) throw new Error(`expected one migration named ${name}, found ${files.length}`);
  await db.exec(readFileSync(files[0], "utf8"));
  return fileName(files[0]);
}

/** The old prebuilt Editor's permissions (team access seed). Editor was merged into Strategist/Editor by the 20261116000000 migration. */
export const OLD_EDITOR_KEYS = [
  "footage.upload", "footage.reply",
  "page.calendar", "page.upload", "page.review", "page.ugc", "page.library", "page.sounds", "page.brand",
];

/** Keep the narrow "editor" persona the older suites prove their rules with: the owner builds a custom role "Editor" with the old
    Editor permissions and gives it to these people. Answers the role's id. */
export async function narrowEditor(db, owner, ...profileIds) {
  return as(db, owner, async (tx) => {
    const id = (await tx.query(`insert into public.roles (name, color) values ('Editor', 'st-bank') returning id`)).rows[0].id;
    for (const key of OLD_EDITOR_KEYS) {
      await tx.query(`insert into public.role_permissions (role_id, permission_key) values ($1, $2)`, [id, key]);
    }
    for (const p of profileIds) await tx.query(`update public.profiles set role_id = $1 where id = $2`, [id, p]);
    return id;
  });
}

/** A person who opens only the spaces given to them. Strategist/Editor holds spaces.all since the 20261119200000 migration
    (owner, Nov 16 2026), so the suites that prove "a person sees only the spaces given to them" use this custom role: every
    key Strategist/Editor holds except spaces.all and the keys in `without`. Gives it to these people; answers the role's id. */
export async function oneSpaceStrategist(db, owner, name, without = [], ...profileIds) {
  return as(db, owner, async (tx) => {
    const id = (await tx.query(`insert into public.roles (name) values ($1) returning id`, [name])).rows[0].id;
    await tx.query(
      `insert into public.role_permissions (role_id, permission_key)
       select $1, rp.permission_key from public.role_permissions rp join public.roles r on r.id = rp.role_id
        where r.key = 'strategist' and rp.deleted_at is null and rp.permission_key <> all ($2::text[])`,
      [id, ["spaces.all", ...without]],
    );
    for (const p of profileIds) await tx.query(`update public.profiles set role_id = $1 where id = $2`, [id, p]);
    return id;
  });
}

/** Sign a person in for the first time (what Supabase Auth does): a row in auth.users fires the profile trigger.
    Google by default; pass provider "email" for an email and password sign up (Supabase's Email provider). */
export async function signUp(db, email, name = email ? email.split("@")[0] : "someone", provider = "google") {
  const id = randomUUID();
  await db.query(
    `insert into auth.users (id, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data) values ($1, $2, $3, $4, $5)`,
    [id, email, provider === "google" ? new Date().toISOString() : null, { provider, providers: [provider] }, { full_name: name }],
  );
  return id;
}

/** Run fn(tx) inside one transaction as a signed in person (role authenticated with their JWT claims),
    as our own server ("service"), or as anon. Commits on success, rolls back and rethrows on error. */
export async function as(db, who, fn) {
  return db.transaction(async (tx) => {
    if (who === "service") {
      await tx.exec(`set local role service_role`);
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: "service_role" })]);
    } else if (who === "anon") {
      await tx.exec(`set local role anon`);
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: "anon" })]);
    } else {
      await tx.exec(`set local role authenticated`);
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: who, role: "authenticated" })]);
    }
    return fn(tx);
  });
}

/** Rows of a query run as someone. */
export async function rowsAs(db, who, sql, params = []) {
  return as(db, who, async (tx) => (await tx.query(sql, params)).rows);
}

/** One value (first column of the first row) of a query run as someone. */
export async function oneAs(db, who, sql, params = []) {
  const rows = await rowsAs(db, who, sql, params);
  if (!rows.length) return undefined;
  return Object.values(rows[0])[0];
}

/** One value of a query run as the database owner (setup and checks, no row level security). */
export async function one(db, sql, params = []) {
  const r = await db.query(sql, params);
  if (!r.rows.length) return undefined;
  return Object.values(r.rows[0])[0];
}
