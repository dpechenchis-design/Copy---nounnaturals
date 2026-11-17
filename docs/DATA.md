# Noun ART data, in plain words

What the database keeps, who can see it, and who can change it. The real thing is `supabase/migrations/20261115000000_init.sql` (written Nov 14 2026, tightened Nov 15 after three rounds of independent review; the owner approved it on Nov 14). It runs start to finish and passes 34 behavior tests on a throwaway copy of Postgres on this computer (`npm run test:db`). It has not run on the live Supabase project yet. The app's types are in `src/lib/types.ts`.

## The big ideas

- **Spaces come first.** Noun Naturals content and Founder content are spaces. Every week, card, raw clip, upload and to do item belongs to one. The owner and admins open every space; everyone else only the spaces they were given.
- **Everything hangs off a family tree:** space, week, card, then raw clips, versions, variants, posts and numbers. One raw clip can feed several cards of its own space.
- **Nothing is ever deleted.** Every row has a "deleted at" date instead. The app has no delete permission, and the database refuses a delete (and emptying a table) even from our own server.
- **Label lists are picked, never typed.** Type, format, product, series, hook style, note tags, direction tags and the rest are small lists the owner can add to.
- **Statuses sit in stages.** There are 13 built in statuses (the content team's own words) and the owner and admins can add their own. Each status sits in one of six fixed stages: Planning, Shooting, Editing, Review, Ready, Posted.
- **No vendor lock.** Every AI tool and model is just a name in a list.
- **Files never sit in the database.** Raw footage is in Google Drive (we keep Drive's permanent file id). Edits, AI variants and carousels are in Cloudflare R2.
- **Every action is recorded:** who (a person, an AI agent, a Claude connector, or the system), what, on which card, from which page, when, and what changed. The record can never be edited.
- **Permissions are set table by table in the file itself.** Nothing depends on the Supabase switch "Automatically expose new tables". People who are not signed in get nothing at all.

## The tables

### Spaces and people
| Table | What it holds |
|---|---|
| spaces | Each space: Noun Naturals content, Founder content. |
| person_spaces | Which spaces each person may open. The owner and admins need no row. |
| profiles | Each person who signed in with Google: name, photo, role, access, language, Telegram chat id, and the "Needs admin approval before posting" box. |
| invites | People invited by email with the role they get on first sign in. |
| person_posting_accounts | Posting permissions: which channels (accounts) each person may schedule and post on. No row means no posting on that channel. |

### Calendar (the week tables)
| Table | What it holds |
|---|---|
| weeks | Each week of a space (Week 3, starting on a Monday), draft or not. |
| cards | One row of a week table: its space and week, day (or none yet), type, product, hook, script, script sections, reference, source and instructions links, the founder columns (how to film, shoot batch, what you need), editor, status, row order, the Shot box (who and when), and any imported columns that matched nothing. |
| card_formats | Every format of a card. A card can have several; the first is the first format. |
| card_platforms | Which platforms a card is planned for. |
| card_accounts | Which exact accounts a card is planned for, once known. |
| card_statuses | The statuses: 13 built in, plus custom ones. Each has a label, a stage, a color and an order. |
| card_status_changes | Every status change of every card, with from, to, who and when. |
| import_batches | Each Import on a week table: CSV, Excel, pasted or Notion, the file name, how every column and value was matched, what was fixed, and what matched nothing. |
| space_todos | The to do list of each space: task, status, due date, who ticked it done and when. |
| drive_folders | The Google Drive folders the app made (space, week, day, card), tracked by Drive id. |

### Raw clips and directions
| Table | What it holds |
|---|---|
| upload_batches | One upload into a day inbox of a space: who, from which device (iPhone, camera card), when. |
| raw_clips | Each raw clip in Google Drive, its space, day and upload, and what Gemini found: transcript, shots, best takes, possible hooks. |
| clip_match_suggestions | Gemini's guess of which card each clip belongs to, and what the person chose. |
| card_raw_clips | The confirmed links: which clips feed which card, who linked them and when. |
| clip_directions | Our directions to the editor, Frame.io style: on a moment of a clip with a drawing, on a whole clip, or on a whole upload. Tag, text and Ukrainian text. This is also where plain comments on a raw clip live. |
| clip_direction_replies | Replies on a direction: the editor's question and our answer. |

### Versions, variants, carousels
| Table | What it holds |
|---|---|
| versions | Each edit uploaded to a card (v1, v2, numbered by the database), its file in R2, who uploaded it, and its review state. |
| version_raw_clips | Which raw clips each edit was cut from. |
| variants | A new video made from a version: what changed, which tool and model, the prompt, the cost, its virality score. |
| variant_faces | Whose likeness a variant uses. Posting it then always needs the owner's approval. |
| ai_generations, ai_generation_outputs | Every AI job and each file it made. |
| assets, asset_slides, asset_claims | Carousels and photos, each slide, and the approved claims they use. |

Live since Nov 16 2026 (supabase/migrations/20261117000000_edit_intake.sql; tests in supabase/tests/edit-intake.test.mjs):
- versions would also save how each version came in: from its row or in a mass upload, how its title was found (the code in the file name, the AI with its percent, or picked by hand) and which mass upload it was part of. Set when the version is made, never changed; older versions keep them empty.
- edit_upload_batches: one mass upload of edited videos (who, which space, how many files, how many matched by code, by AI, by hand, and not matched).
- edit_match_suggestions: the AI's answer for one file (the title it suggested, how sure, why, the model, the cost in dollars, the other titles it weighed), what the person chose and the version it became. Only our server writes the AI's part; a person records their choice through public.decide_edit_match.

Also live since Nov 16 2026 (owner approved), all in supabase/migrations: 20261118000000_raw_clip_upload.sql (two unique indexes on drive_folders; tests in raw-clip-upload.test.mjs), 20261118200000_ugc.sql (ugc_posts, card_ugc_references and the ugc.manage permission; no rights table, UGC is download only; tests in ugc.test.mjs), 20261118300000_spaces.sql (spaces.description, one live space per name; tests in spaces-draft.test.mjs), 20261119000000_review_undo.sql (review.undo), 20261119100000_space_create.sql (spaces.create), 20261119200000_strategist_editor_access.sql (Strategist/Editor role gets 30 of 50 keys).

### Review
| Table | What it holds |
|---|---|
| review_comments | A note pinned to a moment in the video, with tag, text, Ukrainian text, voice note and drawing. Draft until sent. |
| edit_requests | Each press of "Send to editor". |
| approvals | Every approve or reject: which video, who decided, their role at that moment, when. Anyone holding review.undo (owner and admins) can revoke one; a revoke can never be cleared again. |
| checks, check_results, checker_rules, checker_references | The AI first check, its house rules and good examples. |

### Posts and numbers
| Table | What it holds |
|---|---|
| bank_items | The content bank. |
| posts | One video or carousel on one account: time, caption, sound, AI label, status, who scheduled it, who approved it, or that it went out without an approval. |
| post_attempts, post_metrics | Each try to publish, and the numbers at 1 hour, 1 day, 3, 7 and 30 days. |
| sounds, sound_platforms | The sounds library. |
| social_accounts | Each TikTok, Instagram, Facebook or YouTube account, shown by username. |
| account_tokens | The sign in keys for each account. **Only our server can read this.** Not even the owner from the app. |
| posting_slots | Daily time slots per account. |

### Brand kit, AI agents and money
products, claims, brand_assets, brand_rules, templates, faces, agents, agent_prompt_versions, agent_runs, agent_tool_calls, agent_run_outputs, agent_threads, agent_messages, budgets, ai_providers, ai_models, app_settings. Unchanged from the first draft.

### Notices and history
notifications (every notice sent or tried) and audit_log (every change by anyone, forever, never edited).

### Fixed label lists
platforms, content_types, content_formats, products, series, hook_styles, note_tags, direction_tags, variant_kinds, asset_kinds, post_kinds, sound_sources, template_kinds, brand_asset_kinds, metric_checkpoints.

79 tables in all in the first migration. The Gmail invites migration (20261115120000_gmail_invites.sql) adds google_links (each person's sealed Google connection, only its owner reads it) and invite_emails (the send log, never changed). The team access migration (20261115200000_team_access.sql) adds permissions (the fixed list of 46, 22 of them page keys), roles (prebuilt and custom), role_permissions (each tick, never deleted) and profile_role_changes (who had which role when); every rule now asks whether a person's role has a permission: 85 tables. The Strategist/Editor migration (20261116000000_strategist_editor.sql) adds no table: it merges the prebuilt Strategist and Editor roles into one, "Strategist/Editor" (key `strategist`), with the union of their permissions (which is the Strategist set, so nobody loses access); it moves every Editor person (every status) and every open invite to it, each move written in profile_role_changes; it retires Editor with deleted_at (never deleted; used and cancelled invites keep it as history; nobody can give it again); and it makes the old value `editor` in profiles.role and invites.role mean Strategist/Editor, so old code keeps working. The legacy columns then hold `strategist`; the enum keeps the value `editor` for old approvals. It also fixes the history trigger on profiles: it now fires on every update, so a role changed by writing only profiles.role is recorded too (it used to fire only when role_id was in the statement). The week trash migration (20261116100000_week_trash.sql) adds no table: weeks gain deleted_by, purged_at and purged_by, cards gain deleted_with_week_id (no foreign key on purpose); deleting a week takes its live cards with it and Restore brings back exactly those within 30 days; Delete forever sets purged_at; only a person whose role has calendar.delete_weeks (new key, Owner and Admin) may move a week to the Trash, back or out, and nobody may add cards to a week in the Trash. The seven Nov 16 2026 migrations (edit intake, raw clip upload, UGC, spaces, review undo, space create, Strategist/Editor access) bring the total to 89 tables and the permissions list to 50.

## Who can see and change what

The database itself enforces this, so a bug in the app cannot leak work. Everything below is only inside the spaces a person may open.

| | Owner | Admin | Strategist/Editor | A custom role with the old Editor permissions | Viewer |
|---|---|---|---|---|---|
| Spaces | All | All | Given ones | Given ones | Given ones |
| Weeks, to do lists | Change | Change | Change | Read | Read |
| Cards | Change | Change | Change | Only cards assigned to them, read only | Read |
| Shot box | Tick | Tick | Tick | Tick, on their cards | Tick |
| Statuses | Add, rename, recolor | Add, rename, recolor | Read | Read | Read |
| Raw clips | All | All | All, match to cards | **Every day's clips**; can upload | Read |
| Directions on raw clips | Write | Write | Write, reply | Read, reply | Read |
| Versions | All | All | All | Upload onto their own cards | Read |
| Review notes | Write, send to editor | Write, send to editor | Write, send to editor, reply | See sent notes on their cards, reply, tick fixed | Read sent notes |
| Approve or reject | Yes | Yes | No | No | No |
| Schedule or post | Every channel | Every channel | Ticked channels only | Ticked channels only | Ticked channels only |
| Post numbers | Yes | Yes | Yes | **No** | Yes |
| Imports | See, add | See, add | See, add | No | No |
| Accounts, sounds, brand kit | Change | Change | Read | Read | Read |
| Account sign in keys | **Nobody in the app.** Our server only | | | | |
| Who opens which space, posting channels, the approval box | Everyone else | Everyone else | No | No | No |
| Team, invites | Everyone | Strategist/Editors, viewers and any role that does less than Admin | No | No | No |
| Someone else's name, photo, language, Telegram chat | No | No | No | No | No |
| Your own name, photo, language, Telegram chat | Yes | Yes | Yes | Yes | Yes |
| Your own email | No (it comes from Google) | No | No | No | No |
| Review state, virality score, "good example" mark, AI cost, file length and size | Only the database and our server | | | | |
| AI jobs, agent runs, notices (check results follow the card) | Read all; start an AI job | Read all; start an AI job | Read their own; start an AI job | Read their own notices | Read their own notices |
| Audit trail | See | See | No | No | No |

**Posting rule (owner, Nov 14 2026):**

| Who schedules or posts | Needs the channel ticked? | Needs an approval of that exact video by the owner or an admin? |
|---|---|---|
| Owner or admin | No, every channel | No |
| Anyone else, approval box ticked (the default) | Yes | Yes |
| Anyone else, approval box unticked | Yes | No |
| The automatic scheduler (our server), carrying on or retrying exactly what a person scheduled (same video, same account) | Judged as that person: the rows above apply | Judged as that person |
| The automatic scheduler, anything else (a post nobody scheduled, a draft, a changed video or account) | No | Always |

A video using someone's likeness always needs the owner's approval, whoever posts it. Every post records who approved it, or that it went out without an approval. Nobody can change their own approval box, their own channels or their own spaces.

The rule is checked again at every step: when a post is scheduled, when the scheduler starts posting it, when it goes live, and on every retry. So **a revoked approval stops a post at its next step**, and so does taking a channel away from the person who scheduled it, even if the post was already waiting in the queue. (Revoking does not pull back a post that is already live.) Moving a post back to draft or cancelling it, or changing its video or account, forgets who scheduled it, so the scheduler can never post a different video under someone else's name. Who scheduled a post, who approved it and "went out without an approval" are filled in by the database only; whatever the app sends there is ignored. People only move a post to draft, scheduled or cancelled (or press Finish in TikTok); posting, failed and the retry count belong to our server.

**The file of a video can never be swapped.** Once a version, variant, carousel or AI result is saved, its file in R2 (and a raw clip's file in Drive) is fixed for everyone, our own server included. A new file is always a new version. So the video that was approved is exactly the video that posts. Measured facts like length and size are filled in by our server only. A carousel that was approved cannot have its slides or claims changed.

**Sign in is Google only.** The database makes a profile only for a Google sign in with an email. Anyone signing in another way (email and password, another provider, no email) gets no profile, sees nothing, and cannot use an invite. If someone signs in before they were invited, they wait as pending; the moment the owner or an admin invites that email, they are let in with the invited role.

**Status follows what happened:** linking a raw clip moves a card to Shot, a new version to In review, Send to editor to Needs edits, an approval to Approved, the bank to In bank, scheduling to Scheduled, a post that must be finished inside the TikTok app to Finish in TikTok, going live to Posted. It only moves forward along the line (stage first, then the order inside the stage), so a card on a custom status moves by where that status sits. The one exception: inside Review, a card goes back and forth between In review and Needs edits. Ticking Shot never changes the status. People can still set any status by hand.

**Built in statuses stay.** Their key and stage never change and they cannot be removed; their label and color can.

**Nobody changes their own role.** Admins cannot touch owners or admins. There is always at least one owner.

## Things I was unsure about or decided on my own

1. **People nobody invited** sign in with Google as a Viewer waiting to be let in ("pending") and see nothing but their own name until the owner or an admin lets them in, or invites their email (which lets them in at once with that role).
2. **The owner's own invite** is seeded for khaled@nounnaturals.com, the owner's Google account. The first Google sign in with that address becomes the owner.
3. **Fixed step by step lists** (not editable): role, access, card stage, review state of a video, approve or reject, post status, AI job status. Card statuses themselves are now editable.
4. **A card can have several formats**, kept in their own table. The single format column of the first draft is gone; the first format is the one with the lowest order.
5. **A card's day must fall inside its week**, and its space always matches its week's space.
6. **A raw clip can only feed cards of its own space.**
7. **Viewers read directions but do not reply**, like everywhere else they only read. Editors, strategists, admins and the owner reply.
8. **Only the owner, admins and strategists** change weeks and to do items, and see imports. Editors read the to do list.
9. **Every active person who can see a card may tick Shot**, viewers included. Editors can only see (so only tick) their own cards. The stamp is always the real person and time, even if someone tries to type another.
10. **Strategists only plan inside their spaces**: a strategist with only Noun Naturals cannot add or change Founder cards.
11. **Owners and admins may schedule without an approval**; the post then says it went out without one.
12. **The built in statuses Script in progress and Script in QA** have their own colors.
13. **Seeds are only real reference data**: the two spaces, the 13 statuses, the direction tags, TikTok, Instagram, Facebook and YouTube (Threads removed), the eight content types and four formats from the import lists ("Comment reply" and "Live" are gone, "TikTok comment" and the others came in), plus the system lists (note tags, AI models, agents, the four owner checker rules, settings). Products, series and hook styles are no longer seeded because those were guesses; the owner adds the real ones.
14. **"Send to editor" sends every unsent note on that video**, from every reviewer, in one message.
15. **New versions start as "Checking"** while the AI first check runs.
16. **A new version after a card was approved does not move the card back.**
17. **Account sign in keys** sit as plain text in the server only table. Moving them into Supabase Vault (encrypted) is a good later step.
18. **Removing a person** means setting them to Removed. Deleting a user in the Supabase dashboard will fail on purpose.
19. **Everyone active can see the team's names, photos and emails.**
20. **The audit trail trusts the "agent run" and "via Claude" markers only from our own server.**
21. **Editing someone else's profile** is limited to their role, access, removal and approval box. Only the person (or our server) changes their name, photo, language or Telegram chat.
22. **Rows only our server writes** (agent runs, AI job results, check results, notices) cannot be changed from the app at all. A person can start an AI job, but its status, cost and results always start empty and are filled by our server. Later, things a person must do there (like marking a notice read) will each get their own small, checked action, the way the Shot box works.
23. **The same idea on other tables:** a review note is never saved as already sent, Gemini's findings on a raw clip and its card match guesses are not editable by people, who proposed or approved a checker rule and who added or retired a bank item are always the real person.
24. **Not tightened yet:** the "created by" field on some tables could still be filled with another name when a row is added (the audit trail always records the real person), and managers can edit an account's follower count and health. I judged these low risk; say if you want them locked too.
25. **Anything added to the database later** starts closed: no access for signed in people, people who are not signed in, or anyone else until a migration grants it on purpose.
26. **The test copy of Postgres stands in for some Supabase parts**: the sign in trigger runs on a stand in for Supabase's user table, and live updates and Supabase's own extensions are not proven until it runs on the real project.

## Not in this migration (later, each in its own migration)

Comments inbox, mentions and UGC, competitors, discovery, ads, custom roles and per person exceptions, custom columns (docs/CUSTOM-COLUMNS.md), upload resume tracking, saved sounds per person, the ERP link.

## The Frame.io move (live, Nov 16 2026)

supabase/migrations/20261121000000_frameio_import.sql (live, Nov 16 2026). Tests: supabase/tests/frameio-import.test.mjs. Details: docs/FRAMEIO-IMPORT.md.
- versions: `intake_via` also allows `import` (brought in from another system). New columns, all fixed once saved: `source_kind` (`frameio` first), `source_url` (the link on the card), `source_share_id`, `source_file_id`, `source_file_name`, `source_bytes`. An import always has a source, a link and a file id, and never a match or a mass upload; nothing else has a source. Only someone who plans the calendar (calendar.plan) brings a video in.
- Send to editor on an imported version goes to the card's editor (nobody when the card has none), not to the person who ran the move.
- frameio_connections: the one Frame.io connection (Adobe's id for the owner, email, name, who connected, when, health). One live row at a time; another Adobe login removes the old one (deleted_at). In the audit trail.
- frameio_connection_tokens: the Adobe access and refresh tokens, sealed by our server with TOKEN_ENCRYPTION_KEY and bound to the connection. Not in the audit trail (it would keep a copy of every sealed token).
- Both tables: server only (RLS on, no policies, nothing for anon or authenticated), never deleted, updated_at.

## Upload/Files and the Gemini reader (live, owner approved Nov 16 2026)

supabase/migrations/20261122000000_files_and_reader.sql, live since Nov 16 2026. Nothing uploaded before it is read by Gemini, matched or not (owner, Nov 16 2026); only files uploaded after it go to the reader. Tests: supabase/tests/files-reader.test.mjs. The code works on the old database too: the new flows switch on only when the server sees the table raw_clip_moves. Now: 92 tables (the two Frame.io tables are live too) and 51 permission keys live, 52 once the Meta posting draft is live too (posting.resolve).

What Gemini does: one model turns the SOUND of a file into text; a second model reads that text and writes a title, two lines and the cards it fits. Nothing watches the picture. A file with no speech is a "No sound video" and costs nothing. Photos are never read.

- drive_folders: four more kinds: `new_uploads` (one per space), `week_raw` (one per week), `team` (a folder a person made) and `legacy` (in the drive before the app). New: the folder it sits in (`parent_drive_folder_id`), Gemini's lines about it (`ai_summary`, `ai_summary_run_id`, `ai_read_at`, our server's only) and `needs_sync` (Drive was down, the sweeper redoes it). One live folder per card. The new tree (Week N, day, card) carries its week (`week_id`): one week folder per week, one day folder per week and day, so it lives next to the first upload flow's folders ("Week of ... > day > Raw", no `week_id`) for the same day.
- upload_batches (a drop): `day` may be empty. New: `drive_folder_id` (where it was dropped, saved once), `origin` (`upload`, `files` or `folder_read`, fixed) and Gemini's lines about the whole drop (`ai_summary`, `summary_run_id`, our server's only).
- raw_clips (a file): `shot_on` may be empty. New: `kind` (`video` is anything with sound to read, `photo` is never read and never queued), `has_speech`, `ai_title`, `ai_summary`, `home_drive_folder_id` (where it was dropped, saved once; `drive_folder_id` is where it is now), the reader's bookkeeping (`index_attempts`, `index_hold` = `cap`, `next_try_at`, `claimed_at`, `index_error`) and `storage_provider` (`gdrive`). All of Gemini's and the reader's columns are written by our server only.
- clip_match_suggestions: `auto_applied` (Gemini was sure and filed it without asking), our server's only.
- raw_clip_moves (new, the undo ledger): one row per match that was filed: the file, the card, the suggestion, the link (card_raw_clips), whether the original moved, from which folder to which, the shortcut, by Gemini (`auto_applied`, with its confidence and run) or by a person (`made_by`), and when and by whom it was undone. Everyone who opens the space reads it. Nobody writes it by hand, not even an owner: only the database's own functions. One live move per file and card. Never deleted, in the audit trail, live.
- What reading costs: every paid call is one agent run (agent `clip_indexer` or `clip_matcher`) with one line in agent_tool_calls (model, tokens, cost) and one row in agent_run_outputs saying what it was about (`raw_clips`, `upload_batches` or `drive_folders` and the id). The runs, calls and outputs of those two agents can be read by every active person, so the cost shows under each file; other agents' runs stay as they were.
- The daily limit: app_settings `ai.daily_cap_usd` (5 dollars, New York day; only the owner changes it). A run still going counts as its estimate. app_settings `ai.reader_heartbeat` (`{ at, running }`) is written by the reader; no row means it was never set up.
- New permission `files.manage`, "Manage folders and read them with Gemini" (Footage and edits): Owner, Admin, Strategist/Editor. The page key `page.upload` is labelled "Upload/Files"; uploading stays `footage.upload`.
- Prices saved on ai_models (checked Nov 16 2026): gemini-3.5-transcribe 0.005 dollars a minute; gemini-4-hydrogen 1.50 in and 7.50 out per million tokens.

Who can do what, once it is live:

| | Owner, Admin | Strategist/Editor | Uploads only (old Editor keys) | Viewer | A role with files.manage only |
|---|---|---|---|---|---|
| Drop files (footage.upload) | Yes | Yes | Yes | No | No |
| See files, drops, matches and the undo ledger | Their spaces | Their spaces | Their spaces | Their spaces | Their spaces |
| Match a file to a card, undo a match (calendar.plan) | Yes | Yes | No | No | No |
| Make, rename, move, remove a team folder (files.manage) | Yes | Yes | No | No | Yes |
| See the folders from before the app, Read a folder with Gemini (files.manage) | Yes | Yes | No | No | Yes |
| Retry a failed file | Yes | Yes | Yes | No | No |
| See what reading cost, and the daily meter | Yes | Yes | Yes | Yes | Yes |
| Change the daily limit | Owner only | No | No | No | No |
| Write Gemini's findings, the reader's bookkeeping, the ledger | Nobody. Our server and the database only | | | | |

Functions. Our server only (the service key): `claim_clip_jobs` (the next files, one reader per file, a 15 minute lease; a file held for the limit is taken only when there is room for that file; it also closes a reader run left open for over an hour, counted at its estimate), `reserve_ai_spend` (holds an estimate against the limit, one caller at a time), `finish_clip_index` (transcript, no speech, title and suggestions with an auto applied match, held for the limit, retry, file gone; saves what was paid, once). An auto applied match always gets its ledger row, also when Gemini filed it under a card that is not among its three guesses (that card gets its own accepted suggestion); when the card is gone the answer says `refused` and the reader takes its Drive work back. A file gone from Drive (or in a folder that went to the trash) is marked failed with its reason and Retry, never removed. `save_reader_summary` (a drop's or a folder's lines), `clip_card_candidates` (the 25 best cards of the file's space for Gemini to pick from), `reader_heartbeat`. Signed in people: `decide_clip_suggestion` and `undo_clip_move` (calendar.plan; both safe to press twice; a move is checked: it starts in the folder the file was dropped into or is in, and ends in a recorded Raw of a week of the file's own space), `request_folder_read` (files.manage), `requeue_folder_clips` (files.manage: Undo on Remove folder puts the failed files of that folder and the folders inside it back in the queue), `retry_clip`, `ai_spend_today` (the meter).

When it goes live it touches: every raw clip gets its home folder (the folder it is in), raw clips that are photos are marked photos and leave the queue, and every raw clip already saved, matched or not, is marked read (done): nothing uploaded before the migration is read by Gemini (owner, Nov 16 2026), only files uploaded after it.

Decided on my own, say if you want it different: (1) a sound file is saved as kind `video` (it is read the same way); (2) the limit counts every agent run of the day, not only the reader's; (3) a failed file may be retried by anyone who uploads or plans; (4) the folders from before the app are hidden from people without files.manage.

## Draft: Additional content, a space of folders (not live, waits for the owner's yes)

supabase/migrations/20261123000000_additional_content.sql, live since Nov 17 2026 (owner approved), pushed after the code and after Upload/Files (it stops with a clear error when Upload/Files has not run). Tests: supabase/tests/additional-content.test.mjs (it loads the live file). The code works on the old database too: with no `spaces.kind` and no `space_folders` the readers fall back (no tile, no crash). After it: 94 tables (Upload/Files added 1, this one 2). No new permission key: calendar.plan adds, renames and removes folders and adds and links rows; spaces.create adds a space of folders; files.manage is the Drive side.

In plain words: "Additional content" is its own space. Inside are folders instead of weeks (Sea salt spray batch, Halloween special, more later). A row now lives in a week or in a folder. A week's row can also show in a folder as a link, never a copy.

What changes on tables that exist:
- spaces: `kind`, `weekly` (weeks inside, every space of today) or `folders` (folders inside). It never changes once saved. A week cannot be added to a space of folders.
- cards: `week_id` may be empty; new `home_folder_id` (the folder a row lives in). Exactly one of the two is set (check `cards_one_home`, and the same rule in plain words in the trigger). A folder row takes its space from its folder, another space is refused, and its day is free (no week to fall inside). No row joins a removed folder.
- drive_folders: one more kind, `folder` (the Drive folder of a folder), with new `folder_id`; a `folder` record always names its folder and its space; one live per folder. Found by id, never by name.
- variant_kinds: one more label, `no_music` ("No music cut").

New tables:

| Table | What it holds |
|---|---|
| space_folders | A folder of a space of folders: `space_id`, `slug` (its address), `name`, `code` (2 to 4 capitals, SSB or HAL; a row reads "HAL 03"), `description` (at most 280 letters), `sort_order`, `created_by`, `created_at`, `updated_at`, `deleted_at`. One live folder per address, per name (case and outer spaces do not count) and per code in a space. |
| folder_cards | A row shown in a folder it does not live in: `folder_id`, `card_id`, `sort_order`, `added_by`, `created_at`, `updated_at`, `deleted_at`. One live link per folder and row. It may cross spaces: the Sea salt spray rows stay in Noun Naturals content, Week 1. |

Both: row level security, never deleted (removing a folder or a link sets deleted_at), updated_at, the audit trail, realtime, read and add and change for signed in people, nothing for anyone not signed in.

Rules:
- Folders: seen by everyone who opens the space, like weeks. People who plan (calendar.plan) in that space add, rename, reorder and remove them. The creator is always the signed in person. A folder only goes in a space of folders and never moves to another space.
- Removing a folder: refused while a row lives in it ("That folder still holds videos"). Its links are marked removed with it. Bringing a folder back is not built (v1); its links would not come back by themselves.
- Links: a person sees a link only when they open the folder's space AND can see the row. So a person without Noun Naturals content sees the Sea salt spray folder and none of its Week 1 rows. Planners add and unlink under the same two conditions. A link keeps its folder and its row (unlink and add a new one). A row cannot be linked into the folder it already lives in, and a removed row or a removed folder takes no new link.
- The week Trash is untouched. A folder row never goes to the Trash with a week. A linked row goes with its own week and comes back with it; the link row stays as it is the whole time, so the app hides a link whose row is in the Trash.
- Everything that works by card works on a folder row as before: the Shot box, versions (v1, v2), the status automation, review, posting.
- The reader: `clip_card_candidates` also offers rows that live in a folder. Such a row comes back with no `week_id` and its folder's name as `week_name`. `decide_clip_suggestion` is unchanged: a matched file still moves only into a week's Raw, so in a space of folders a match is saved without moving the file until that rule is widened.

What it adds when it goes live (each only when missing, so a second run changes nothing):
- The space "Additional content" (address `additional`, kind folders), opened by everyone who opens Noun Naturals content that day (owners and admins open every space anyway). If someone already added a space with that name by hand and it has no weeks, that one is used.
- Its two folders: Sea salt spray batch (`sea-salt-spray-batch`, SSB) and Halloween special (`halloween-special`, HAL).
- Six Halloween rows that live in the Halloween folder, V1 to V6: Trick or Shampoo, Candy or Shampoo, Giving Away Shampoo, Halloween Giveaway, Treats and Free Shampoo, Candy AND Shampoo. Source `notion_import`, no day. `extra` "Edited video" and "Edited video (no music)" both hold the share link of the whole Halloween folder on Frame.io (per video links were not collected).
- A link in the Sea salt spray folder to every live row named SSB/0NN of every live Week 1 of Noun Naturals content (one week today; two would both be linked) (15 today: SSB/001 to SSB/016, there is no SSB/008), in title order. A database without that week is left as it is; with the week and not one such row, the file stops.

Open before the push: the status of the six Halloween rows. It is `review` (In review, what the import makes of "Sent for approval to the client") until the owner answers; it is one line at the top of the seeds in the file, with the Frame.io links.

Decided on my own, say if you want it different: (1) a space never changes its kind, and weeks and folders each stay in their own kind of space; (2) a `folder` Drive record must name its space as well as its folder; (3) the six Halloween rows are not ticked Shot (the Frame.io weeks were ticked by their own migration; say so and one line does it); (4) a row or link someone removed by hand is not added again by a second run.
