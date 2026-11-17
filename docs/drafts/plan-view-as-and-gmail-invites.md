# Plan: role preview ("View as") and Gmail invites (Fable 5.2, Nov 15 2026)

Two briefs, two Opus 5.5 builders. Both first read: CLAUDE.md, the root AGENTS.md, the cookies, cacheComponents and server action pages in node_modules/next/dist/docs, docs/PORTING.md, docs/MOBILE-PASS.md. Rules for both: no Tailwind, design system classes and tokens only, 44px targets, no sideways scroll, light and dark. Never open a .env file. Do not edit docs/*.md or CLAUDE.md. Checks before handing back: npm run typecheck, npm run lint, npm test, npm run build.

## What the ERP does (read only)

View as (noun-erp/client/src/layout/AppShell.tsx lines 417 to 575, client/src/lib/permissions.tsx, client/src/pages/Settings.tsx 211 and 503): a top bar button left of the avatar (round eye with a role color dot on phones, "Viewing as: Owner ▾" wider). It opens "View as (demo)": one search list (People and Roles, custom roles tagged "custom"), a tick on the current one, "Back to yourself (Owner)". Only in DEV, only owner and admin. Settings has a "View as {role}" button per role. It only changes what is drawn; a page the role may not open shows "You don't have access" with "Stop viewing as {role}".

Invite email (noun-erp/server/people.ts, server/index.ts 679, client/src/lib/google-people.ts, client/src/pages/Settings.tsx 107): sent from the inviter's own Gmail through the Gmail REST API (users/me/messages/send). Each person presses "Connect Google" once: Supabase signInWithOAuth (google) with extra scope gmail.send, access_type=offline, prompt=consent. The refresh token is saved AES-256-GCM encrypted in table google_links (key TOKEN_ENCRYPTION_KEY), refreshed with GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (the OAuth client Supabase sign in uses). Outside production it answers "preview" and sends nothing; not connected answers "connect". "Resend invite" button. The email: tan page, white 520px card, small caps "Noun ERP", "You've been invited", who and which role, "Sign in with Google using {email}", one pill button, small footer. The ERP keeps no send log; Noun ART will.

## Brief A: "View as" role preview

Goal: the owner and admins pick any role and the whole app draws as that role (sidebar, phone bar, Home, pages, hidden buttons). Only where the app is not the published app. It never gives real permissions.

Design:
- On screen: "View as". It replaces the old "See as" switch on Home.
- State is a cookie `noun-view-as`, read on the server inside getViewer(), so every server page follows.
- Gate, server only: process.env.REPLIT_DEPLOYMENT !== "1", and (when signed in) the real role holds team.roles. In the no keys preview the sample owner may use it. In the published app the cookie is ignored, the control is not sent, the action refuses.
- Placement: top bar, left of the avatar. Phone: round 44px eye button with a role color dot. Tablet up: pill "Viewing as: Editor ▾". Opens the shell sheet (openSheet): title "View as (demo)", one line of explanation, search box, role list (color dot, name, "custom" tag, tick on current), "Back to yourself ({my role})", footer "Only on a test run. Saving still follows your own role."
- Banner while on: slim sticky strip, first child of <main id="view">, gradient from tokens, eye icon, "Viewing as {role}. Demo only." and a 44px "Stop preview" button. The avatar stays the real person.
- Second entry: "View as {role}" button (eye icon) in the RoleEditor header (the only way to preview a custom role built on screen in sample mode).
- Roles only, no "view as a person" yet.

Files:
- New src/lib/access/view-as.ts (pure, no Next imports): VIEW_AS_COOKIE; type ViewAsRole { id, key: RoleKey | null, name, color, permissions }; encodeViewAs; parseViewAs(raw) strict (a prebuilt id resolves from PREBUILT and ignores carried permissions; a custom role needs a 1 to 40 char name, permissions filtered by isPermissionKey and deduped; never key "owner"; junk gives null); mayUseViewAs({ published, signedIn, selfPermissions }); viewerAs(self, role, standIn?) returns self for the person's own role, otherwise a Viewer with role: role.key ?? "viewer", roleName, permissions, custom: !role.key, viewAs: { roleId, roleName }, photoUrl: null, and the stand in sample person's id and name.
- New src/lib/access/view-as-actions.ts ("use server"): startViewAs(role), stopViewAs(). Each checks mayPreviewRoles(); when USES_DATABASE also getAccess() active and real role has team.roles. Then sets or deletes the cookie (path /, sameSite lax, 30 days) and calls refresh(). Never reads the cookie to decide anything.
- src/lib/database-target.ts: add isPublishedApp() and mayPreviewRoles(). Nothing else.
- src/lib/auth/access.ts: Viewer gains optional custom?: boolean and viewAs?: { roleId; roleName }.
- src/lib/get-viewer.ts: new cached getShown() returning { self, viewer, canViewAs, roles: ViewAsRole[] }; getViewer() returns .viewer. Stand in sample people: editor PREVIEW_EDITOR (olena); strategist and admin a sample person of that role from src/lib/sample/people.ts; viewer and custom none. samplePersonOf also works when viewer.viewAs is set.
- src/lib/viewer.ts: remove SEE_AS_KEY, SeeAs, previewViewer. Keep IS_PREVIEW, PREVIEW_VIEWER, PREVIEW_EDITOR.
- src/lib/nav.ts: canOpen(viewer, key) (prebuilt: today's allowed(role, key) unchanged; custom: SCREEN_NEEDS). hasEditorHome(viewer) (prebuilt: isEditorRole; custom: has footage.upload and lacks review.approve).
- src/lib/team/roles.ts: viewAsRoles(activeCustom?) = five prebuilt plus the custom role being previewed. TODO(Phase B): read public.roles.
- src/app/(app)/layout.tsx: always <Suspense><Gate/></Suspense>, also in the no keys preview (the cookie is request time data). Gate passes self, viewer, canViewAs, roles to AppShell.
- src/components/shell/AppShell.tsx, TopBar.tsx, Sidebar.tsx, MobileNav.tsx, shell-context.ts: take the viewer instead of role; use canOpen and hasEditorHome; add useViewer() and useViewAs() ({ can, active, roles, start, stop }); page guard in Routed: when !canOpen(viewer, screen.key) draw NoAccess instead. PaintHost canEdit unchanged.
- New src/components/shell/ViewAs.tsx (button, sheet, banner) and src/components/shell/NoAccess.tsx ("You don't have access to {screen}", "Go to Home", and "Stop preview" while previewing).
- Styles: one new src/design/screens/view-as.css plus its import line.
- Delete src/components/home/see-as.tsx and fix users: src/app/(app)/page.tsx (server picks Home with hasEditorHome), EditorHome.tsx (drop the switch), ClipDirections.tsx (useViewer(); me is the stand in id or "khaled"), UgcScreen.tsx (use the prop), home.css (comment only).
- canSee in src/lib/sample/spaces.ts and callers (calendar pages, ugc page, src/lib/calendar/card-view.ts): every space by permissions.includes("spaces.all") instead of role owner or admin.
- src/components/settings/team/RoleEditor.tsx: only the "View as {role}" button, shown when useViewAs().can.
- Tests: src/lib/access/view-as.test.mjs and src/lib/access/nav.test.mjs (covered by the test glob).

SCREEN_NEEDS for custom roles (any of, unless noted): home, calendar always; upload footage.upload; review footage.upload, footage.reply, review.notes, review.approve; ugc, library, sounds, brand footage.upload, calendar.plan, brand.manage; analytics posting.numbers; studio, carousels studio.make; templates brand.manage, studio.make; bank posting.bank; posting posting.bank, posting.accounts, posting.all_channels; accounts, ads posting.accounts; discovery, competitors posting.numbers AND calendar.plan; community calendar.plan; activity, audit team.activity; rules rules.propose, rules.approve; settings team.manage, team.roles, settings.view; integrations (if a screen key exists) settings.view.

Must hold: no "use server" file imports get-viewer or reads the cookie (actions use getAccess(), the real role). Published app: no button, cookie ignored, action refuses. An editor previewed on /settings sees NoAccess (the guard also applies to real people). First client render matches the server.

Tests: parseViewAs rejects junk, oversized name, "owner" key on a custom role; prebuilt id ignores carried permissions; unknown keys dropped; mayUseViewAs false when published and without team.roles; viewerAs own role returns self; canOpen equals today's lists for the five roles; custom map gives the editor list for [footage.upload, footage.reply] and the viewer list for [calendar.all_cards, posting.numbers]; hasEditorHome right for five roles; file scan: no "use server" file imports get-viewer.

Checks: four commands; npm run build must pass. By hand on localhost at 375px and desktop, light and dark: Editor, Viewer, a sample custom role, then Stop preview.

## Brief B: invite emails from Gmail

Goal: pressing Invite in the published app emails the person from the inviter's own Gmail, like the ERP, with Noun ART's own keys. Built now; real sending starts after the owner's clicks and the migration.

Decisions:
- Per person "Connect Google" through Supabase OAuth, scope https://www.googleapis.com/auth/gmail.send, access_type=offline, prompt=consent, include_granted_scopes=true, login_hint = the person's email.
- Refresh token saved encrypted in Supabase, one row per person, written with the person's own session, RLS own row. No service role key. Encryption key in Replit Secrets.
- Secret names (Noun ART's own values, never the ERP's): GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, TOKEN_ENCRYPTION_KEY (32 random bytes, base64).
- redirectTo /auth/callback?next=/settings&link=google on whichever of the three addresses the browser is on.
- From: the inviter's own Gmail. Subject: "{inviter} invited you to Noun ART".
- Body (html plus plain text): small caps "NOUN ART"; "You've been invited"; "{inviter} added you to Noun ART, Noun Naturals' content system, as {role}."; "Sign in with Google using {email}. It has to be this exact address."; optional note; pill button "Open Noun ART" to https://art.incivera.ai/signin; footer "art.incivera.ai · only invited people can sign in". ERP layout (tan page, white 520px card, radius 14), button in Noun ART's accent (hex from src/design/tokens.css, inlined).
- Connecting Google is allowed on a test run. Sending is never allowed on a test run.

Files:
- New src/lib/google/: env.ts googleReady(); crypto.ts AES-256-GCM format v1.iv.tag.data; oauth.ts refresh exchange, granted scopes via tokeninfo, revoke; gmail.ts buildMime (multipart/alternative, base64 encoded subject, refuses CR or LF in any header) and sendGmail returning message id and thread id; invite-email.ts pure { subject, html, text }, everything escaped; link.ts save, read, unlink the google_links row (missing table 42P01 or PGRST205 gives "not-set-up", never an error page); actions.ts ("use server") googleStatus, connect start helper, disconnectGoogle, previewInviteEmail, resendInviteEmail; *.test.mjs.
- src/app/auth/callback/route.ts: when link=google, after the exchange, check the session user is the same person and gmail.send was granted, then save provider_refresh_token encrypted. A problem goes to /settings?google=... with one plain sentence.
- src/app/(app)/settings/actions.ts: invitePerson sends after the insert, only when usesRealContent(); result gains email: { state: "sent" | "connect" | "failed" | "not-set-up" | "test-run"; preview? }; every attempt writes an invite_emails row; a failure never undoes the invite; new resendInvite(inviteId) with the same mayGrant rule.
- src/lib/team/types.ts, src/lib/team/source.ts: TeamData.gmail { state, email }; InviteRow.emailedAt, InviteRow.emailState (null when the table is missing); TeamResult gains the email part.
- src/components/settings/team/InviteSheet.tsx, PeopleList.tsx, TeamTab.tsx: button "Send invite" when connected, else "Save invite" with a notice "Connect your Gmail to email invites" linking to Settings, Integrations; invited row shows "Emailed {date}" or "Not emailed", "Resend invite", "Copy sign in link"; failure line "The invite is saved, but the email did not go out." with "Copy sign in link"; test run or sample: "Test run: no email was sent. This is what would go out." with the rendered email.
- New src/components/settings/GoogleCard.tsx: the Gmail tile from src/design/Platform, Connect, "Connected since", Disconnect, for people with team.manage (wired into the Integrations page later).
- src/instrumentation.ts: add the three secret names to the presence check.
- package.json: add src/lib/google/*.test.mjs to the test script.
- Drafts only, never in supabase/migrations (read supabase/README.md): docs/drafts/gmail-invites-migration-draft.sql and docs/drafts/gmail-invites-tests-draft.mjs.txt. google_links: profile_id pk, refresh_enc, scopes text[], linked_at, deleted_at; RLS own row only. invite_emails: invite_id, to_email, from_email, sent_by, subject, status fixed list (sent, failed, not_connected), gmail_message_id, gmail_thread_id, error, created_at; RLS insert own, select for team managers, no update, no delete.

Tests: crypto round trip and tamper fails; buildMime header injection refused, non ASCII subject, both parts; invite-email escaping, exact sign in link; send decision table (test run never calls Gmail; not connected gives "connect"; Gmail 403 and 5xx give "failed" and the invite is kept); existing tests stay green.

## Owner's steps (after the build)

1. Google Cloud, project Noun ART, APIs and Services, Library: turn on Gmail API, then Google Drive API.
2. Google Auth Platform, Data access, Add scopes: gmail.send. Save.
3. Google Auth Platform, Audience: Publish app (owner decided Nov 15: publish to production).
4. Clients: the Web client Supabase uses; copy Client ID and secret into Replit Secrets as GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, plus TOKEN_ENCRYPTION_KEY from `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` in the Replit Shell. Never the ERP's values.
5. Supabase, Authentication, URL Configuration: the three addresses in Redirect URLs.
6. Approve the small database update (Google connections and invite email log).
7. Pull and Republish.
8. Published app: Settings, Integrations, Google, Connect, tick Gmail. Steven and David once each.
9. Invite one of his own other addresses to test.

Drive (upload build): a service account of project noun-art as Content manager on the Shared Drive "NOUN Content System"; fallback an owner OAuth connection if service account keys are blocked.

## Open questions

1. Strategist menu: follow its permissions (adds Analytics, Studio, Carousels, Templates, Discovery, Competitors, Community, Checker rules) or keep today's eight screens?
2. Decided Nov 15: publish to production.
