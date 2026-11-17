# Meta for Noun ART: the plan

A plan for Khaled to approve (Nov 16 2026). Nothing has been requested, changed or submitted at Meta. Every click in Meta Business Suite and on developers.facebook.com is Khaled's. Checked against Meta's own developer pages on Nov 16 2026 (sources at the end). When it is approved, CLAUDE.md, docs/DECISIONS.md, docs/CONNECT-SOCIAL.md and docs/BUILT.md change in the same commit as the first build.

## Status (Nov 16 2026)
- Meta is connected the way docs/CONNECT-SOCIAL.md says: one Noun ART Meta app, one system user ("Noun ART poster") with a key that never expires, entered in Replit Secrets. Each Instagram account and Facebook Page it reaches shows on Settings, Integrations by its username, and Add puts it in everyone's posting permissions.
- The calls that post one Reel to Instagram and one Reel to a Facebook Page are written (`src/lib/social/meta/graph.ts`) behind the posting guard (`src/lib/social/posting/publish.ts`), with tests. Nothing calls them: there is no Schedule sheet, no posting run and no video storage yet.
- The database is ready for this: posts, post attempts, post kinds (video, reel, trial reel, carousel, photo post), posting times and the rule that a post goes out only with an owner's or admin's approval (or for a person whose "Needs admin approval before posting" box is unticked) and only with posting permission on that account.
- Fable 5.2 reviewed this plan on Nov 16 and approved it with changes, which are in it now. One is urgent for every platform: today's posting rule lets a person move a post that is already posting or posted back to scheduled, which would post it twice. Nothing can post yet, so no harm is done; the database draft in section 5 closes it.
- TikTok runs apart (docs/TIKTOK.md on its own branch, waiting for TikTok). This plan builds the Schedule sheet and the posting run so TikTok plugs into the same screens later.

## The short answer

1. **No review at Meta.** Our app posts only to Noun's own Pages and Instagram accounts through a system user of the same business, so Meta's own table says Standard Access, App Review "Not required". No audit, no "private until approved" rule like TikTok's. Posting can start as soon as the videos have an address Meta can fetch.
2. **What Meta can do by API:** Reels, trial reels (shown first to people who do not follow us), photo posts, carousels of photos and videos, a custom cover, up to 3 collaborators, the AI label, and Facebook Page Reels, videos and photos. Many accounts on one app and one key.
3. **What it cannot do by API:** attach a sound from Instagram's music library, read whether a trial reel "graduated", graduate it by hand, or tell us by live update when a post is done (we ask every minute instead).
4. **The video address.** Meta pulls the file from a web address itself. A private R2 link signed for two hours is enough for Meta, so Instagram and Facebook do not have to wait for TikTok's Video address (TikTok does wait: it needs its Video address, a URL prefix on the r2.dev Public Development URL, checked with Verify). This needs a first test post (decision 1).
5. **Limits that shape the plan:** Instagram allows 50 posts a day per account through the API (Meta's pages say 50 in two places and 100 in one, so the app reads the real number from Meta before each post); a Reel is 3 seconds to 15 minutes and at most 300 MB; a Facebook Page takes 30 Reels a day, each 3 to 90 seconds.
6. **Khaled Wins** must become a professional Instagram account (Creator is fine), be linked to a Facebook Page, be added to Noun's Business portfolio and be given to the system user. About 15 minutes, steps in section 2.

## 1. What we ask Meta for

### Permissions (already on the key, nothing new)
| Permission | What it gives us | Used by |
|---|---|---|
| `instagram_basic` | the account's username, picture, followers | Integrations, Accounts, the Schedule sheet |
| `instagram_content_publish` | Reels, trial reels, photos, carousels | the posting run |
| `instagram_manage_insights` | post and account numbers | post numbers (later build) |
| `pages_show_list` | the Pages the system user can reach | Integrations |
| `pages_read_engagement` | Page names, pictures, the Page's own key | Integrations, posting to a Page |
| `pages_manage_posts` | Page Reels, videos, photos | the posting run |
| `read_insights` | Page numbers | post numbers (later build) |

Not asked for now: `instagram_manage_comments` and `pages_manage_engagement` (the Comments tab, a later build, a new key then), `instagram_manage_contents` (deleting an Instagram post through the API; we never delete), anything for ads, messages or money. Meta also lists `publish_video` for Page videos on one page; if a Page video is refused for it, Khaled adds it to the key (Claude says when).

### App Review
None. Meta's App Review page: "My app is only for a business I own or manage", no login, Standard Access, "Not required". Business apps get Standard Access automatically. If Meta ever asks for a review anyway, Claude prepares it with you.

### One setting to check: the app's mode
On developers.facebook.com, the Noun ART app's top bar shows "App Mode: Development" or "Live". If it says Development, switch it to Live (the privacy and terms addresses are already filled in, which Live needs). Why: Meta keeps posts made by an app in Development mode visible only to people with a role on the app. Not confirmed for system users on Meta's pages today, so the first test post (section 2C) checks it.

## 2. Khaled's steps, in order

Never paste a key in a chat. Nothing new goes in Replit Secrets for Meta. Every step is in Noun's own Business portfolio, never the ERP's apps or keys.

### A. Khaled Wins (about 15 minutes, can be done today)
Meta's help pages would not load for the check, so menu names come from Meta's developer pages plus current guides. If a screen looks different, stop and send Claude a screenshot.
1. **Make it professional.** In the Instagram app on the Khaled Wins account: Settings and activity, Account type and tools, Switch to professional account. Pick **Creator** (decision 2). Pick a category such as "Entrepreneur". Personal accounts cannot be reached by any app.
2. **Make a Facebook Page for it** (skip if Khaled Wins already has one). Open business.facebook.com with Noun's portfolio chosen: Settings, Accounts, Pages, Add, Create a new Page. Name: `Khaled Wins`. Category: Entrepreneur or Public figure. Made inside the portfolio, the Page belongs to Noun from the start.
3. **Link the Instagram account to that Page.** In the Instagram app: Edit profile, Page (under Public business information), Connect an existing Page, pick Khaled Wins. Or on Facebook as the Page: Settings, Linked accounts, Instagram, Connect account.
4. **Add the Instagram account to Noun's portfolio.** Business settings (business.facebook.com/settings): Accounts, Instagram accounts, Add, then log in to Khaled Wins on the window that opens. This needs full control of the portfolio. An Instagram account sits in one portfolio at a time (decision 3).
5. **Give both to the system user.** Business settings: Users, System users, Noun ART poster, Assign assets.
   - Pages: Khaled Wins, with only content (create and manage content). Nothing for messages, ads or money. If Meta asks for partial access before content, pick partial access, content.
   - Instagram accounts: Khaled Wins, content only.
   - No new key is needed: the key already has every permission, and Meta checks which accounts it may reach at each call.
6. **In Noun ART:** Settings, Integrations, Instagram, Refresh. The Khaled Wins username shows under "Found"; press Add. Do the same on the Facebook card for the Khaled Wins Page only if we want to post there too (decision 8). Each one then shows in the posting permissions in Team and access.

### B. Noun Naturals and every account added later
Same steps from 1 or from 4, whichever is not done yet. The Noun Naturals Instagram and Page are most likely in the portfolio and given to the system user already (the Integrations card shows them under Found or Added). A new account later is always: professional, linked to a Page, in Noun's portfolio, given to Noun ART poster with content only, then Refresh and Add.

### C. The first test (after builds M1a, M2 and M3 are pushed, the database draft is live and the four R2 keys are entered)
1. Make one throwaway Instagram account (professional, no Noun branding) and add it like steps A2 to A6.
2. Schedule one short test video to it in the published app. Claude watches the posting run with you.
3. It proves three things at once: Meta takes our signed R2 link, the post is public (the app mode question), and the whole run works. Only then does anything go to Noun Naturals or Khaled Wins, and only then is the posting queue (M4) finished.

## 3. Rules every Meta post follows

- **Approval:** a post goes out only from "scheduled", and the database lets a post into "scheduled" only with an owner's or admin's approval of that exact video, or for a person whose "Needs admin approval before posting" box is unticked, and only with posting permission on that account. The database checks it again at every step of the run. Every post shows who approved it, in the sheet, the queue and the card.
- **A test run never posts.** Only the published app at art.incivera.ai posts.
- **Never posted twice.** When Meta does not answer clearly at the very last step, the post stays "Posting" and asks a person to check, never "Failed", so a Retry cannot post it twice.
- **Caption:** at most 2,200 characters, 30 hashtags and 20 @mentions on Instagram; the sheet counts and stops before Meta refuses.
- **Video checks before scheduling, not at posting time:** Instagram Reel 3 seconds to 15 minutes, MP4 or MOV, at most 300 MB; Facebook Reel 3 to 90 seconds (longer goes as a Page video); vertical 9:16 recommended.
- **Photos:** JPEG only, at most 8 MB, between 4:5 and 1.91:1 (Instagram's rules; the Carousels screen exports to these).
- **AI label:** Meta added an "AI generated" field on June 22 2026. It is set from the video's own record (decision 9).
- **Keys:** the system user's key and each Page's key stay on the server, are never saved, logged or shown, and every call is signed with the app secret (built).

## 4. Scale: 30 posts a day across many accounts

| Limit (Meta's) | Number | What we do |
|---|---|---|
| Instagram posts per account | 50 a day through the API (one page says 100); a carousel counts as one | the app reads `content_publishing_limit` before each post and never goes over; each account's own daily cap in Accounts (default 3, decision 6) |
| Instagram prepared videos | 400 a day per account; a prepared video expires after 24 hours | one prepared video per try; the run publishes it within minutes |
| Facebook Page Reels | 30 a day per Page | the same daily cap per Page |
| Facebook collaborator invites | 10 a day | not used on Facebook in this plan |
| How long Meta takes | usually under a minute, Meta says ask once a minute for up to 5 minutes | the run asks once a minute, for up to 15 minutes, then says "Instagram is still preparing it" |
| Live updates | Meta has none for posting | we ask Meta (status check), no webhook needed |

**30 a day:** with a cap of 3 posts a day per account, 30 posts need 10 accounts across TikTok, Instagram and Facebook. The caps are per account and the owner changes them.

**Many accounts, one key:** one Noun ART app and one system user serve every Instagram account and Page in Noun's portfolio. A new account is never a new app or a new key, only steps A4 to A6.

## 5. What we build, screen by screen, in build order

Each build is planned by Fable 5.2, built by the builder named below, checked by a Sonnet 5.5 and a Haiku 5.5 agent before the push (and the big ones by a separate Fable 5.2 reviewer), and shown on a phone and a computer before it is called done. Nothing is pushed without Khaled's yes.

**M0. The database draft first** (Opus 5.5; see "The database change" below). It fixes a hole in today's rule and adds the one switch that makes "posted once" certain. Tested on the throwaway database (`npm run test:db`) before any other build starts.

**M1a. Meta posting core for videos** (server only, no screen; Opus 5.5)
- Instagram: Reel and **trial reel** (`trial_params` with the graduation choice), cover picture or cover frame, up to 3 collaborators, share to feed, AI label, caption.
- Facebook Page: Reel (3 to 90 seconds) and Page video (longer ones).
- **The run no longer waits inside one call.** Today the guard waits up to a minute for Instagram; a long Reel can take longer and a server call should not hang. New: the try saves Meta's prepared video id, and each minute the run looks again and publishes when it is ready.
- **Published at most once, for sure.** Right before the last step (Instagram's publish, Facebook's finish) the run flips a one time switch on the try, through a database function that also checks the approval and the posting permission again at that very moment (an approval undone while Instagram was preparing stops it here). Before the switch nothing can be out, so giving up after 15 minutes is a safe "Failed" with Retry. After the switch, the run never publishes again: if Meta did not answer clearly, it asks Meta whether the post is out, and if Meta cannot say, the post waits in "Needs a check".
- **Daily cap or Instagram's limit reached:** the post is not started and stays scheduled for the next free time. No try is used up.
- **Video address for Meta:** a private R2 link signed for two hours, made right before Meta is asked and never saved or logged; the same for a cover picture (decision 1). The guard today asks for a public R2 address and refuses anything but videos; both change for Meta. TikTok keeps its own rule (a verified public domain) later.
- Before each post: the video's length and size for that platform. After: the link to the live post and the time it went out.
- Every Meta error number becomes one plain sentence and a yes or no on "Retry helps": for example "Instagram could not fetch the video" (retry), "Instagram's daily limit for this account is reached" (tomorrow), "The video is not a format Instagram takes" (fix the file), "Instagram restricted this account; open the Instagram app" (a person acts).
- Tests for every call with no network and no database, like today's.

**M1b. Photos and carousels** (Opus 5.5, after the Carousels screen exists, because until then nothing makes a carousel to post)
- Instagram photo post and carousel (each photo or video prepared as an item, then the carousel; up to 10 items until a test shows Meta takes 20).
- Facebook photo and several photos in one post.

**Design first for M2 and M4.** The prototype has the sheet and the queue, but not the Instagram box with trial reels, the Facebook box or the "Needs a check" group. Fable 5.2 designs those in the prototype's style and Khaled approves them on a phone and a computer before they are built.

**M2. Bank and schedule, and the Schedule sheet** (design copied from the approved prototype, `design/concepts/src/post.js`; Fable 5.2 builds the screen, Opus 5.5 the saving)
- Bank: every approved video and carousel waiting to post, grid and list, filters, pick one or many, "Approved by" on each.
- The Schedule sheet, shared by every platform (TikTok adds its own box later):
  - **Accounts:** every connected account by its username with its platform pill. Accounts the person may not post to show grayed. No ticked channel: Schedule is grayed.
  - **When:** the account's next free posting times (New York time) or a time picked by hand. With many videos, each takes the next free time.
  - **Caption** per platform, with the counter, hashtags, and "Rewrite in Noun style" later.
  - **Cover:** pick a frame from the video, or add a picture.
  - **Instagram box:** Reel or Trial reel. For a trial reel: "Share with followers when it does well" (automatic) or "I decide in Instagram" (by hand), decision 4. For a Reel: "Also show in the feed". "Collab with" up to 3 @usernames (each must accept in the Instagram app). AI label.
  - **Facebook box:** Reel or video (picked by itself from the length, can be changed), caption.
  - The checks above in plain words, before Schedule is pressed.
  - **Confirm step:** every post that will go out, its account and time, and "Approved by Khaled, Nov 13, 4:10 pm". Then Schedule.
- Every choice and what Meta showed when the sheet opened are saved on the post (`platform_settings`), so the history is complete.
- **Saving is done as the person who presses Schedule**, never with the server's master key, so the database checks that person's posting permission and records them as the one who scheduled it. The approval comes from the video's place in the bank. Move, Stop and Retry are saved the same way.
- **On the demo** (localhost, the Replit workspace): everything works on sample data and nothing is saved.
- **In the published app:** Schedule shows grayed with "Being connected" until the four R2 keys, the Meta keys, the posting timer and the database draft are all in place.

**M3. The posting run** (Opus 5.5; needs the draft migration below)
- A Supabase timer every minute calls a protected address on the published app (`/api/posting/run`, with a shared secret the owner saves once in Supabase Vault and in Replit Secrets as `POSTING_RUN_SECRET`, the same pattern as the UGC sync). Until the secret is saved it does nothing.
- It posts what is due through the posting guard, a few at a time, and looks again at the Instagram videos still being prepared.
- Big files never pass through Replit: Meta fetches them from R2.

**M4. The posting queue** (Fable 5.2 builds the screen from the prototype)
- Groups: Posting now, Needs a check, Failed, Scheduled, Posted. Each row shows the account by its username, the time and who approved it.
- **Failed:** the plain reason and Retry (when Retry helps). Retry puts it back to Scheduled for the next free time; the database checks the approval again.
- **Needs a check** (Meta did not answer clearly): a button opens the account, then "It is posted" or "It is not posted" (owner and admins, new permission `posting.resolve`). Who decided and when is saved.
- **Scheduled:** Move (another time) and Stop.
- **Posted:** the link to the live post. Trial reels say "Trial reel: check in Instagram whether it was shared with followers", because the API does not tell us.

**Later, each with its own plan:** post numbers (Meta's insights at the fixed checkpoints, the same tables as TikTok's plan), comments (read, reply, hide), Instagram stories (Business accounts only), Telegram notices for failures, product tags.

### The database change (one draft for Khaled's yes, `supabase/drafts/`)
- **A fix to today's posting rule.** The Fable review found that today a person with posting permission can move a post that is already posting or posted back to scheduled, and the run would then post it a second time. The draft stops that: a person may move a post back to scheduled only from draft, failed or cancelled, never from posting or posted. This protects TikTok too.
- **The one time switch** on each try (a new column `post_attempts.publish_claimed_at`) and the server only function that flips it after checking the approval and the posting permission again.
- **Who settled a post that needed a check** (`posts.resolved_by`, `posts.resolved_at`) and the permission `posting.resolve` ("Mark a post that needs a check as posted or not posted") in `src/lib/access/permissions.ts` and the seed, owner and admins.
- **The posting timer** (pg_cron and pg_net calling `/api/posting/run`, reading its secret from Vault; does nothing without it), the same pattern as the UGC sync draft.
- **One live post per video per account** (added Nov 17 2026 after the Sonnet, Haiku and Fable reviews of the screens): a unique index `posts_one_live_per_account`, so a double tap, two people at once, or a Retry of a failed post that was scheduled again can never put the same video on one account twice. The app also checks it first and says "Already scheduled or posted on this account."
- Everything else already has a place: `platform_settings` for the trial reel, collaborators, share to feed and Facebook's choice; `cover_r2_key` for a cover picture; Meta's prepared video ids in the try's record.
It goes up after the code, in its own push, like the other drafts.

### Who builds what (Fable 5.2's split)
| Order | Section | Builder | Owns | Must not touch |
|---|---|---|---|---|
| 1 | Database draft and its tests | Opus 5.5 | `supabase/drafts`, database tests | `supabase/migrations`, the app |
| 2 | M1a | Opus 5.5 | `src/lib/social/meta`, `src/lib/social/posting/publish.ts`, a Meta link helper in `src/lib/r2`, tests | screens, `supabase`, TikTok code |
| 3 | Design of the new boxes, then M2 and M4 screens | Fable 5.2 | pages, components, `src/design`, `src/lib/sample` | `src/lib/social`, saving, `supabase` |
| 3 | Saving: schedule, move, stop, retry, resolve | Opus 5.5 | `src/lib/content/posting*.ts` | components, `publish.ts` |
| 3 | M3, the posting run | Opus 5.5 | `src/app/api/posting/run`, `src/lib/social/posting/run.ts` | `publish.ts` inside, screens |
| 4 | Permission key, Integrations card, docs (BUILT, DECISIONS, CONNECT-SOCIAL, DATA, AGENTS, CLAUDE.md) | Sonnet 5.5 | those files only | everything else |
| 4 | Phone pass (docs/MOBILE-PASS.md) | Sonnet 5.5 | look only, then small fixes | logic |
| 5 | Checks before the push | Sonnet 5.5, Haiku 5.5 and a separate Fable 5.2 | read only | |
| 6 | First test (section 2C), then M1b when Carousels exists | | | |

## 6. Clean data: what we keep

- On each post: the kind (Reel, trial reel, photo, carousel), every choice in the sheet (`platform_settings`: graduation, collaborators, share to feed, Facebook as Reel or video, AI label), caption and hashtags as sent, cover, who scheduled it, who approved it, Meta's post id and its link, the time it went out, and who settled it if it needed a check.
- On each try (`post_attempts`): when it started and ended, Meta's prepared video id, each status Meta gave, the error number and our plain sentence. Never a key, never an address.
- Nothing is deleted. A stopped post is "cancelled", a failed one keeps its reason.
- So Vera and the future AI editor can learn which hooks, captions, times and trial reels worked.

## 7. Decisions for Khaled (with my recommendation)

**Khaled's answers (Nov 16 2026):** build it, starting with the database fix. Khaled Wins is already a Creator account and already in Meta Business Suite; it goes into Noun's portfolio ("it's ready"), and the Integrations card will show it once the published app reads Meta. Trial reels are shared with followers by themselves when they do well (automatic is the default); Reel is the default and Trial reel is a choice each time. Start at 3 posts a day per account, and yes, it can go higher when needed (each account's cap in Accounts, up to Meta's 50 on Instagram and 30 on a Page). Collabs are wanted now, Noun Naturals with Khaled Wins (the invited account accepts once in the Instagram app; the API cannot accept for it). Instagram sounds are in the video file. Decisions 1, 8, 9, 10, 12 and 13 were not answered, so the builds follow the recommendations below until he says otherwise.

**Later the same night:** collabs are allowed on trial reels too (the first test confirms Meta takes it). The AI label goes on when the video is AI. Long videos and landscape videos are wanted on Instagram, not only 9:16: Meta's API takes Instagram videos of any shape from 3 seconds to 15 minutes and up to 300 MB, all published as Reels (a landscape one shows with bars in the Reels tab). Longer than 15 minutes is only possible in the Instagram app today, not through the API. On Facebook, a video longer than 90 seconds or not vertical goes as a Page video, any length. Too big a file stays the editor's smaller version, as in decision 10.

**Built (Nov 17 2026):** the database draft, M1a and M3, checked by Sonnet 5.5, Haiku 5.5 and a separate Fable 5.2 review, all findings fixed. New accounts start with a daily cap of 3 (the draft changes the default); accounts already added keep their cap, which may be 0, and 0 means nothing posts, so set 3 on each in Accounts. A Facebook video goes as a Reel only when it is vertical and 3 to 90 seconds, else as a Page video. Still to build: the Bank and schedule and Posting screens (M2, M4), after Khaled approves Fable's design.

1. **Video address for Instagram and Facebook:** Recommend: a private R2 link signed for two hours, so Meta posting starts as soon as the four R2 keys are entered, without waiting for TikTok's Video address. Meta's pages do not say whether such a link works, so the first test post on a throwaway account proves it (step 2C). If it does not, we use the r2.dev Public Development URL, which TikTok needs anyway (its Video address, checked with Verify).
2. **Khaled Wins as Creator or Business:** Recommend: Creator. Posting by the app works on both. Creator keeps the full music library in the Instagram app for posts you make by hand; Business limits it to licensed music. The only thing Creator loses by API is stories, which are not in this plan.
3. **Who holds Khaled Wins in Meta:** Recommend: add the Instagram account to Noun's Business portfolio and make its Page there. You stay its owner and can remove it from the portfolio any time; it is the only way the system user can post to it.
4. **Trial reels by default:** Recommend: "Share with followers when it does well" (Meta decides by performance). "I decide in Instagram" means someone must open the Instagram app for every trial. How do you want it?
5. **When to use trial reels:** Recommend: the person picks Reel or Trial reel in the sheet, Reel by default. Once the hook maker exists, extra hooks of a video already posted start as Trial reel by themselves (the concept says hook variants go out as trial reels).
6. **Daily cap:** Recommend: 3 posts a day per Instagram account and per Page to start (Meta allows 50 and 30), trial reels included, raised per account in Accounts once the numbers show it does not hurt reach.
7. **Collaborators:** Recommend: allowed, up to 3 @usernames, so a Noun Naturals Reel can show on Khaled Wins too as one post with shared numbers. The collaborator accepts in the Instagram app. Collab on trial reels stays off until a test shows Meta allows it.
8. **Facebook:** Recommend: no automatic copy of every Instagram post. The Noun Naturals Page is an account in the sheet like any other, ticked when we want it. Khaled Wins gets a Page only because Instagram needs one; posting there is your call (say if yes).
9. **AI label on Instagram:** Meta now has an "AI generated" field. Recommend: on for realistic AI, by itself from the video's record, and the labeled versus unlabeled test, if you still want it, runs on Instagram first. Your call.
10. **Files over 300 MB:** our edits are full quality and can be bigger than Instagram's 300 MB. A smaller copy is a different file, so it needs its own approval. Recommend: the sheet checks the size and, if too big, says "Too big for Instagram (300 MB). Ask the editor for a smaller version." The editor uploads it as the next version (v3 and so on), it goes through Review like any version, and its approval covers it. No new kind of file. A shrink inside the app would cost money per video; decide later if it happens often. Is that how you want it?
11. **Instagram sounds:** Meta's API cannot attach a sound from Instagram's music library. Recommend: videos for Instagram carry their sound in the file (licensed tracks or Higgsfield music, mixed by us). Trending Instagram audio stays a by hand post in the Instagram app for now.
12. **Posts that need a check:** Recommend: owners and admins decide "posted" or "not posted" (new permission `posting.resolve`), never a retry on a guess.
13. **Trial reels without an approval:** a person whose "Needs admin approval before posting" box is unticked may post without an approval today. Recommend: the same for trial reels, no special rule (they are seen by people who do not follow us, which is less risk, not more). Your call.
14. **What is the Khaled Wins username?** Needed to find it on the Integrations card.

## Sources (read Nov 16 2026)

Meta for Developers (`https://developers.facebook.com/docs/...`):
- Content publishing (containers, status every minute up to 5 minutes, 24 hour expiry, 400 containers a day, the daily limit, carousels up to 20, resumable upload): `instagram-platform/content-publishing/`
- Media reference (Reels, trial_params, collaborators up to 3, cover_url, thumb_offset, share_to_feed, is_ai_generated, video and photo specs, 300 MB, 3 seconds to 15 minutes): `instagram-platform/instagram-graph-api/reference/ig-user/media`
- Trial reels in the API (Dec 3 2025): `instagram-platform/changelog`
- Daily limit call (quota_total "currently 50"): `instagram-platform/instagram-graph-api/reference/ig-user/content_publishing_limit`
- Media fields (permalink, media_product_type): `instagram-platform/reference/instagram-media`
- Error codes and what to do: `instagram-platform/instagram-graph-api/reference/error-codes`
- Webhook fields (none for posting): https://developers.facebook.com/documentation/instagram-platform/webhooks/fields
- Professional accounts, Creator supported, stories Business only: `instagram-platform/instagram-api-with-facebook-login`
- App Review not required for a business's own assets: `instagram-platform/app-review` and `graph-api/overview/access-levels/`
- Facebook Page Reels (start, upload by file_url, finish, 3 to 90 seconds, 30 a day): `video-api/guides/reels-publishing`
- Page videos, photos, posts and scheduling: `graph-api/reference/page/videos/`, `graph-api/reference/page/photos`, `pages-api/posts`, `graph-api/reference/page/feed/`

Not confirmed yet, to check in the first tests: whether Meta takes a signed R2 link; whether posts from a Development mode app are public; trial reel eligibility (third parties say 1,000 followers), whether trial reels take collaborators or share to feed, and whether they count in the daily limit; carousels of 20 (one Meta page still says 10); several photos in one Facebook post (a community report says it can fail); whether a Page video has a permalink field; the exact Business Suite menu names (Meta's help pages did not load).
