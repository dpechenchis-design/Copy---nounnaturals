# TikTok for Noun ART: the plan

A plan for Khaled to approve (Nov 16 2026). Nothing has been requested, filled in or submitted at TikTok. Every request, form and review in TikTok's portals is Khaled's click. Checked against TikTok's own pages on Nov 16 2026 (sources at the end). When it is approved, CLAUDE.md, docs/DECISIONS.md and docs/CONNECT-SOCIAL.md change in the same commit as the first build.

## Status (Nov 17 2026): built on the branch, not pushed yet

The connector and the posting are built on the branch `claude/tiktok-business-build`. Nothing is pushed, so nothing is live and nothing has been tested with a real TikTok account.

**Built:**
- **B1, the connection.** Connect TikTok, then "Add another TikTok account" for each account. Each shows by its username with its level (business or personal) and what it may do in plain words. Connecting an account twice says "already connected" and makes no second row. Reconnect adopts an account that was connected with the old app (matched by username). Disconnect revokes. Every account joins the posting permissions channel list by itself.
- **B3, the posting.** After approval, the posting run posts to TikTok in two phases, like Meta. TikTok pulls the video from our R2 public address (the bucket's Public Development URL). Posted shows the link. A clear refusal fails with one plain sentence. An unclear answer never counts as failed: it waits, then shows "Needs a check".
- **The Video address card.** Settings, Integrations, TikTok, Video address: one "Verify" press adds the address at TikTok, puts TikTok's check file in the bucket and asks TikTok to check. Nothing is stored; the app asks TikTok each time. (Nov 17 2026: replaces the DNS record plan.)
- **The B2 box basics** in the Schedule sheet: disclosure ("Your brand" on, "Paid partnership" off), Comments, Duet and Stitch, "Needs a Shop product link" (goes to drafts, ends as Finish in TikTok) and the AI label (taken from the video's own label).
- No database change and no new permission key. The old developers.tiktok.com code and key names are removed.

**Deferred (not built):** reading comments, insights and the video library (they need tables), live updates (webhooks), sounds and the account's limits in the box, photo posts, a daily token refresh timer with Telegram notices, finding an unclear post through TikTok's video list, and the Spark Ads and mentions scopes.

**Not verified:** TikTok's own pages for this API could not be read. The facts come from TikTok's open source SDKs: the numeric error codes, the draft status and the scope separator. Also not verified: whether TikTok accepts an r2.dev prefix, whether adding the same prefix again returns the same check file, and whether r2.dev's rate limit lets TikTok's download through. The first real test reads the real answers and Claude fixes any difference.

**The first real test (your click, a throwaway TikTok account, never a Noun account):**
1. Sign in through Connect TikTok on art.incivera.ai. The account shows by its username.
2. Connect the same account again. It says "already connected" and no second row appears.
3. "Add another TikTok account" with a second account gives a second row.
4. Settings, Integrations, TikTok, Video address, press Verify: it says verified. If it says not yet, TikTok may not accept an r2.dev address (not yet verified).
5. Schedule one short video. It posts publicly once, with its link, labelled "Your brand".
6. Schedule one with "Needs a Shop product link". It lands as Finish in TikTok and is not posted.
7. Claude reads the real error codes from the tries and maps them.
8. Disconnect, and check TikTok shows the access removed.

## Approval history (Nov 16 and 17 2026)
- **Noun ART is approved** at business-api.tiktok.com (seen Nov 17 2026): App ID 7709047425054638101, Online, Verification status Approved. The third try did it (access form with the original Business Center 6987900128824655873). Next: Khaled copies the App ID and Secret into Replit Secrets (section 2, E), Khaled answers the open points in section 7, then the connector is built (section 5). The October 12 Business Center may now be deleted if Khaled wants; nothing depends on it.
- Noun Naturals' developer profile at business-api.tiktok.com was rejected. Per Khaled, it was rejected over the ERP's ad spend reading app, which he has deleted.
- Khaled resubmitted the profile on Nov 16 with the new description from section 3. TikTok shows "Your profile is currently under review" and says about 3 business days. The use case list still has every box ticked. It cannot be edited while the profile is under review, so it was left as is.
- Khaled submitted the Accounts API Access Application Form on Nov 16. It uses Business Center verification, the use case text, and the 76 second prototype recording as its screen recording.
- The Accounts API access form was filed before the app itself, so the app description now ends with "Our Accounts API access form is filed." (495 of 500 characters) to tie the two together for TikTok's reviewers.
- The Noun ART app form was filled again on Nov 16 (the first fill was lost when the tab was reused): name, description, both redirect URLs, and only TikTok accounts, Mentions and Discovery ticked. Khaled uploaded the logo (`design/brand/noun-art/icon/icon-512.png`) and submitted it on Nov 16. The Apps page shows "Noun ART", Verification Status Pending, no App ID yet. TikTok says 2 to 3 business days. Now wait for TikTok's emails on the profile, the access form and the app.
- **Rejected (Nov 17 2026), and why.** TikTok: "The Business Center information provided in your Accounts API Access Application does not meet verification requirements." Checked in Khaled's signed in browser:
  - We have two Business Centers. "Noun Naturals" (ID 6987900128824655873, the original with the ad account, shop and pixel) is **not verified**: its verification was rejected on Feb 13 2026 because "the business name and business registration name could not be found in official databases". "Noun Naturals_7522505134010843925" (ID **7695724708314398726**, created Oct 12 2026) **is verified**, tied to the company's tax ID, admin accounts@nounnaturals.com.
  - The developer profile is fine: company Noun Naturals, nounnaturals.com, email on nounnaturals.com, Direct Advertiser. Its sign in email is accounts@nounnaturals.com.
  - Fix: send the access form again with the verified Business Center ID 7695724708314398726, the sign in email accounts@nounnaturals.com, and the company's full legal name exactly as on its registration papers; then resubmit the app (Edit, Submit). TikTok uses the latest form submission. Claude filled the form again on Nov 17 (app name, email, websites, Business Center ID, use case, fewer than 10 accounts, Direct Advertiser). Khaled adds the legal name, uploads the recording, ticks Agree and submits.
  - **Done Nov 17 2026:** Khaled submitted the new access form (legal name Noun Naturals LLC; name match "No", developer profile company name Noun Naturals; Business Center 7695724708314398726; email accounts@nounnaturals.com; the 76 second recording). Claude then resubmitted the Noun ART app unchanged (Edit, Submit). Status: Pending.
  - Khaled wants the application tied to the original Business Center (6987900128824655873), which holds the ad account, shop and pixel; the verified one (created Oct 12 2026, under the same accounts@nounnaturals.com login) has almost nothing in it. Tried Nov 17: "Share verification" cannot do it (TikTok: "You can only share verification to Agency Partner"; the original is listed as Direct). The way is "Try again" on the original's Verification page as **Noun Naturals LLC** with a registration document. It opens in a new tab, so Khaled clicks it. Why February failed: the form had Business name "NOUN NATURALS" and, in the EIN box, "CP575A" (the IRS letter's form code) instead of the EIN 86-3489333. Khaled chose (Nov 17): verify the original and keep the pending app as is. The "Try again" page opens as a popup the agent cannot fill, so Khaled fills it: Business, United States, nounnaturals.com, the IRS EIN letter (CP 575 or 147C, all pages), the business name exactly as printed on that letter, EIN 86-3489333. **The original is now verified** (approved Nov 16 2026 21:13 ET, "NOUN NATURALS LLC", certificate 86-3489333), after Khaled resubmitted it with the IRS CP 575 A letter, name "NOUN NATURALS" as printed and the real EIN. Next: resend the access form with 6987900128824655873 so the application points at the Business Center that holds the assets.
  - **Rejected a second time (seen Nov 17 2026), same wording.** The missing piece is the **legal representative**: on both Business Centers, Verification, Business info shows "Legal representative certificate type: -" and "certificate number: -". Company information is verified on both; primary contact is khaled@nounnaturals.com (matches the developer profile's domain). TikTok's help ("How to verify your business on TikTok", ads.tiktok.com/help/article/about-business-verification): Verification, Continue verification (here it is behind "View details", which opens a popup), Edit information, Legal representative: Passport, Driver's license or National ID, upload it and enter its number. Khaled does this himself (an ID is never entered by Claude). Then: resend the access form once, with 6987900128824655873, and resubmit the app. The form asks not to be sent many times but reviews the latest one, so send it only after the legal representative shows verified. Do not delete the October 12 center until the app is approved. Resend the access form with 6987900128824655873 only after the original shows verified; sending it before would bring the same rejection, since TikTok reviews the latest form.
  - The Business Center page has no way to add the legal representative: Verification, Business info shows those two lines read only, with no upload and no edit (checked again Nov 16 2026). Khaled's phone number is now on the primary contact.
  - **Third try, Nov 16 2026 (Khaled's choice):** access form sent once with the original Business Center **6987900128824655873**, the first time that ID went in the form (both rejections were for 7695724708314398726). Same other answers: Noun Naturals LLC; "No" plus Noun Naturals; Noun ART; accounts@nounnaturals.com; https://nounnaturals.com, https://art.incivera.ai; the same use case; the 76 second recording; Less Than 10; Direct Advertiser. Claude filled it, Khaled uploaded the video, ticked Agree and submitted (Lark shows "Submitted"). Claude then resubmitted the Noun ART app unchanged (Edit, Submit). Status: **Pending**.
  - If it is rejected again with the same wording: send the form once more with question 6 "Submit An Acceptable Document for Business Verification" (it adds question 7 "Supporting Document", an upload) and the IRS CP 575 A EIN letter, then resubmit the app.
- Video library (owner, Nov 16 2026): once accounts are connected, pick one or many TikTok accounts, see every posted video as tiles in a grid, separated by account, and open one to see its numbers. The TikTok accounts scope already covers it (video list plus per video insights, 24 to 48 hours late), so nothing more is requested. Built with post numbers (section 5, step 4).
- The app was approved and the owner approved the plan; the build is described at the top of this page.

## The short answer

1. **Change doors.** TikTok has two developer programs. The one we built on (TikTok for Developers, developers.tiktok.com, the "Content Posting API") names our exact use as not acceptable for public posting: its rules give as an example of what it refuses a tool to "upload contents to the account(s) you or your team manages". Its app review also refuses apps for private use. So that app would most likely stay private forever.
2. **TikTok API for Business is the right door** (business-api.tiktok.com, its "Accounts API"). It is made for brands working on their own accounts. It posts publicly with no "private until audit" rule, and it gives everything the concept wants: full numbers (reach, watch time, completion, retention, traffic sources, audience), comments (read, reply in words, hide), licensed TikTok music attached at posting, drafts for "Finish in TikTok", Spark Ads codes, mentions of Noun, and trending sounds and hashtags for Vera. Our concept already chose it ("TikTok Organic API ... Content Posting API as backup").
3. **What Khaled requests:** register Noun Naturals as a TikTok API for Business developer, fill TikTok's Accounts API access form, then create one new app "Noun ART" with the "TikTok Accounts" scopes listed in section 1. TikTok says about 3 business days for the developer, then 2 to 3 business days for the app. The form's own review time is not published.
4. **Limits that shape the plan:** 15 posts a day per account (6 a minute), numbers arrive 24 to 48 hours late (so TikTok has no 1 hour number), 40 calls a minute per account, tokens last a day and refresh for a year.
5. **What the API cannot do:** add a TikTok Shop product link, or post a video as a reply to a comment. Both go through "Finish in TikTok": the video waits in the account's TikTok drafts (or on the phone) and a person finishes it in the TikTok app.
6. **What is kept from what we built:** the sealed tokens, the account list, Integrations card, posting permissions, the posting guard and its database rule. What changes: the calls to TikTok (new addresses and fields) and the callback address.

## 1. What we ask TikTok for

### The two doors, side by side

| | TikTok for Developers (built Nov 15) | TikTok API for Business (proposed) |
|---|---|---|
| Made for | apps many creators use | brands and agencies on their own accounts |
| Our use case | named as not acceptable for public posting | listed as allowed (publishing, comments, insights, ad authorization on owned accounts) |
| Public posts | only after an audit we would most likely fail; until then private only, 5 accounts a day, account must be private | yes, from approval |
| Numbers | views, likes, comments, shares only | also reach, watch time, completion, retention per second, traffic sources, new followers, audience |
| Comments | none | read, reply in words or with an image, hide, like, live updates |
| Music | none (only "auto add music" on photo posts) | attach a Commercial Music Library track by its id, with volumes |
| Drafts | yes (inbox) | yes (`upload_to_draft`) |
| Spark Ads codes, mentions, trends | no | yes |
| Return addresses | up to 10, all active | up to 10, **only one active at a time**, must end with `/` |

Both use "sign in with TikTok" (the same TikTok consent screen), so for Khaled and the team nothing looks different.

### The scopes for the new app, and why

Ask for all of them in the first application: since March 20 2026 every later scope increase needs TikTok's access form again.

| Scope | What it gives us | Used by |
|---|---|---|
| `user.info.basic` | the account's name and picture | Integrations card, Accounts, posting screen |
| `user.info.username` | the @handle (every account shows by its username) | everywhere |
| `user.info.profile` | bio, verified badge, profile link | Accounts |
| `user.info.stats` | followers, likes, video count | Accounts, Home |
| `user.account.type` | which TikTok account level it is | Integrations card (warns when a feature needs a higher level) |
| `user.insights` | the account's numbers per day: views, profile views, new and lost followers, audience | Analytics, Vera |
| `video.list` | the account's posts with basic counts | numbers, finding posts finished in TikTok |
| `video.insights` | per post: reach, watch time, completion, retention, traffic sources, audience | post numbers, Vera |
| `video.publish` | post a video or photo post | the posting run |
| `video.upload` | send a post to the account's TikTok drafts | Finish in TikTok |
| `comment.list` | read comments and replies on our posts | Comments tab |
| `comment.list.manage` | reply, hide, like | Comments tab |
| `biz.spark.auth` | turn on Spark Ads for a post and get its code | Spark Ads (owner only) |
| `biz.brand.insights` | posts and comments that @mention Noun, top hashtags and words | UGC and mentions, Vera |
| `discovery.search.words` | keyword and search ideas (listed in TikTok's agent guide; drop it if the app form does not offer it) | Discovery, Vera |

Not asked for: direct messages (`message.list.*`), creator marketplace (`biz.creator.*`), ad recommendations (`biz.ads.recommend`), orders (`tcm.order.update`). None is in the concept for now.

### TikTok account level

TikTok has three levels: a plain personal account; "Advanced Access" once the account is linked to a TikTok for Business account or Business Center; and "Verified Business" after business verification. Some numbers (unique viewers, new and lost followers per day) and all of the mentions need Advanced Access or Verified. A Business account can only use sounds from TikTok's Commercial Music Library, which is the library a brand must use anyway (TikTok's licenses for other music do not cover brand promotion). Recommendation: every Noun account is a Business account and is linked to Noun's Business Center.

## 2. Khaled's steps, in order

Never paste a key in a chat. Keys go in Replit Secrets (workspace and the published app's Deployments, Secrets). This is Noun ART's own app, never the ERP's.

### A. The TikTok accounts (about 20 minutes, can be done today)
1. Make a list of every Noun TikTok account (the handle and who has the login). Tell Claude the list.
2. On each account, in the TikTok app: Settings and privacy, Account. If it says "Switch to Business account", it is still personal; switch it (decision 2 below first).
3. Link each account to Noun's TikTok Business Center (business.tiktok.com). Claude walks you through it on screen when you do it; TikTok moves these menus often.
4. Make one throwaway TikTok test account with no Noun branding. Every API post is public, so the first test posts go there.

### B. Fix the developer profile (about 10 minutes, then about 3 business days)
Seen on Nov 16 2026 with Khaled signed in: Noun Naturals already has a developer profile at business-api.tiktok.com (made for the ERP: Direct Advertiser, nounnaturals.com email and website), and TikTok rejected it, so no app can be created yet ("You cannot create an app while your developer profile is rejected"). The page shows no reason. Khaled says it was rejected over the ERP's app for reading ad spend, which he deleted on Nov 16. Its description promises a read only ad reporting tool that will not create or manage ads, while its use case list ticks Campaign, Creative, Audience and Catalog Management. It does not mention posting at all.
1. Profile (account menu, My Profile), Additional Information, the pencil. Use cases: keep Reporting, Accounts and Business Center; untick the rest. Description: the text in section 3, "Developer profile description". Save and resubmit.
2. Wait for TikTok's email. One profile covers the ERP and Noun ART; each gets its own app.

### C. The Accounts API access form
1. On the Accounts API page TikTok links its "Accounts API Access Application Form" (a Lark form; it asks you to sign in to Lark). It must be filled in before the app is created.
2. Answer with the texts in section 3. If it asks something not covered there, stop and send Claude a screenshot.

### D0. The Create New App form as it really is (seen Nov 16 2026, profile under review)
"Create an App" opens again now that the profile is under review. The form is titled "Marketing API App", but it is the only app type on this portal, and its scope list also holds the organic groups. One app covers everything in this plan; developers.tiktok.com is not needed.
- **App name:** `Noun ART`
- **App description** (456 of 500 characters): Noun ART is Noun Naturals' internal content tool, used only by our own team and our contracted editing agency. It publishes videos and photo posts our owner approved to our own TikTok accounts at planned times, with content disclosure and AI labels; reads post and account insights; lists comments on our own posts so a person can reply or hide them; and lets our owner create Spark Ads codes for our own posts. Nothing is posted without a person's action.
- **Advertiser redirect URL:** `https://art.incivera.ai/connect/tiktok/ads/callback/`. This is for ad accounts, used only later for ads. The return address for TikTok accounts (step D4) is set on the app's page after it is created.
- **Tick:**
  - "TikTok accounts": profile, posts and numbers, comments, publishing video and photo posts, post settings, Spark Ads codes, benchmarks, trending search.
  - "Mentions".
  - Under "Creative management", only the line "Discovery": TikTok's licensed music list and trending hashtags.
- **Leave everything else unticked.** Ads, audiences, reporting, pixels and catalogs come later, only if the owner decides on ads.
- **Added by the form** once "TikTok accounts" is ticked:
  - App logo: 512x512 JPG or PNG. Use `design/brand/noun-art/icon/icon-512.png`.
  - TikTok account holder redirect URL: `https://art.incivera.ai/connect/tiktok/callback/`.
- **Filled by Claude on Nov 16 2026** in Khaled's signed in browser: name, description, the advertiser URL, the redirect URL, and the three ticks (TikTok accounts, Mentions, Discovery). Khaled uploaded the logo and submitted it the same day; status Pending.
- **The warning on "TikTok accounts":** TikTok shows a warning sign there. It says to fill in the Accounts API Access Application Form first, or the approval may be rejected.
- **Before Submit:** TikTok requires its Accounts API Access Application Form before an app asking for "TikTok accounts": https://bytedance.sg.larkoffice.com/share/base/form/shrlgu4WEvtSXpEDLcCw56u4Rfc (a Lark form). Fill it first, then submit the app. Submitting is Khaled's click.

### D. Create the app (about 15 minutes, then 2 to 3 business days)
1. My Apps, Create. Name: `Noun ART`. Logo: `design/brand/noun-art/icon/icon-512.png` (TikTok shows an error page to people if the app has no logo).
2. Description: the text in section 3. TikTok asks whether access is limited to internal use: answer yes, honestly. TikTok's own example of that is an in house tool.
3. Permission scope: TikTok Accounts, and tick every scope in the table in section 1.
4. TikTok account holder redirect URLs, copied exactly, each ending with `/`:
   - `https://art.incivera.ai/connect/tiktok/callback/` (make this one active)
   - `https://noun-art.replit.app/connect/tiktok/callback/` (listed, not active; switch to it only when testing on Replit's address)
   TikTok keeps one of them active at a time and refuses `localhost` (https only, no port). This is a second exception to the three addresses rule (decision 3).
5. Submit, and wait for TikTok's email.

### E. Your steps now
1. Copy the App ID and Secret (My Apps, App Detail, Basic Information) into Replit Secrets as `TIKTOK_BUSINESS_APP_ID` and `TIKTOK_BUSINESS_APP_SECRET`, in the workspace and in Deployments. `TOKEN_ENCRYPTION_KEY` and `SUPABASE_SERVICE_ROLE_KEY` must be there too. Full list: docs/CONNECT-SOCIAL.md.
2. Make `https://art.incivera.ai/connect/tiktok/callback/` the active return address at TikTok (it must end with `/`). `https://noun-art.replit.app/connect/tiktok/callback/` stays listed. TikTok keeps one active at a time and refuses localhost.
3. Pull and Republish when Claude says the build is pushed.
4. In Cloudflare, on the R2 bucket, turn on the Public Development URL. Put that address (like `https://pub-<hash>.r2.dev`, no path) in Replit Secrets as `R2_PUBLIC_BASE_URL` (workspace and Deployments), Pull and Republish. Then Settings, Integrations, TikTok, Video address, press Verify. No DNS record.
5. For posting: `POSTING_RUN_SECRET` in Replit Secrets, and the Meta posting database draft approved and live (the switch and the run's lease).
6. Connect TikTok, once per account (switch to that account in TikTok first, or sign out of TikTok), then the first test above.

### F. The old app at developers.tiktok.com
The old code and the old key names (`TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`) are removed from Noun ART. The old app at developers.tiktok.com can be deleted. Accounts connected with it show "Connected with the old TikTok app": press Reconnect and the same row is kept, with its posting permissions.

## 3. The review plan

### What TikTok checks
- **Developer registration:** a real company with its own domain and a company email; TikTok does not take personal developers. About 3 business days.
- **Accounts API access form:** since March 20 2026, required before any app with "TikTok Accounts" scopes. Its questions are behind a Lark sign in, so they are not known yet. Answers below cover what TikTok's pages ask elsewhere.
- **App review:** the description, whether access is internal, the scopes and the logo. TikTok says it may take 2 to 3 business days.
- TikTok's pages show no posting audit for this door and no "private until audit" rule. If one shows up during review, Claude prepares it with you.

### Texts to paste (Claude adjusts them to the form's exact questions)

**Developer profile description** (covers the ERP's reporting and Noun ART)
> Noun Naturals is a hair care brand (CPG) selling on our own Shopify store, TikTok Shop and Amazon. We build internal tools used only by our own team and our contracted editing agency; they are never offered to other businesses. 1) Reporting: we connect only our own TikTok ad accounts and read daily spend, impressions, clicks and conversions to calculate profit per channel and per product. 2) Our own organic TikTok accounts (Accounts API): after our owner approves each video in our internal content tool, it publishes the video to our own TikTok accounts at a planned time with the correct content disclosure and AI labels, reads post and account insights, lists comments on our own posts so a team member can reply or hide them, and lets our owner create Spark Ads authorization codes for our own posts. Nothing is posted, replied to or authorized without a person's action. We never download or copy other people's content.

**App description**
> Noun ART is Noun Naturals' internal content studio, at https://art.incivera.ai. Access is limited to our own organization: the Noun Naturals team and our contracted editing agency, signed in with company Google accounts. Each Noun Naturals TikTok account is connected once by its owner. The tool publishes approved videos and photo posts to those accounts at planned times, with the correct content disclosure and AI labels, sends some posts to the account's drafts to be finished in TikTok, reads post and account insights to learn what works, lists comments on our posts so a person can reply or hide them, and lets our owner create Spark Ads authorization codes for our own posts. Nothing is posted, replied to or authorized without a person's action.

**Why each scope** (one line each, for the form)
- user.info.basic, user.info.username, user.info.profile, user.account.type: show each connected account by its name, handle and picture, so the team always sees which account a post goes to.
- user.info.stats, user.insights: follower and account numbers on our Accounts and Analytics screens.
- video.list, video.insights: each post's performance at fixed times after posting, to compare videos and plan the next ones.
- video.publish: publish approved videos and photo posts to our own accounts at their planned times.
- video.upload: send posts that need a TikTok Shop product link to the account's drafts, so a person adds the link in TikTok.
- comment.list, comment.list.manage: show comments on our posts; a person replies in words or hides spam.
- biz.spark.auth: our owner turns on ad authorization for one of our posts and gets its Spark Ads code.
- biz.brand.insights: see public posts that mention @nounnaturals, to thank creators and learn what people say.

### A short demo video, ready in case it is asked for
TikTok's developer program for creators asks for one; the Business forms may too. Claude prepares it with you after build B2, recorded on art.incivera.ai on a phone and a computer, about 2 minutes: sign in; Settings, Integrations, Connect TikTok and TikTok's consent screen; the account showing by its username; an approved video in the Schedule sheet with the TikTok box (account, caption, disclosure, AI label, sound, comments, duet, stitch); the post going live with its link; its numbers; a comment answered; a Spark Ads code made by the owner.

### Rules the posting screen follows anyway
The Business door does not publish screen rules, but TikTok's community guidelines and the other program's rules show what TikTok expects, and following them protects the accounts:
- Show the account's picture and name in the posting box, from TikTok at the moment it opens.
- The caption is always editable (2,200 characters for video, 4,000 for photo posts with a 90 character title).
- Content disclosure is always set: "Your brand" (TikTok labels it "Promotional content") for Noun's own products, "Branded content" ("Paid partnership") only when a creator is paid. Branded content can never be private.
- The AI label is set whenever a variant has realistic AI people or scenes (TikTok may remove or restrict unlabeled realistic AI, and the label cannot be taken off later).
- Comments, Duet and Stitch are shown and follow the account's own settings.
- A preview of the exact approved video.
- The video's length is checked against what the account may post (TikTok's settings call), before scheduling, not at the last minute.
- When the video carries its own music (not a TikTok sound): the line "By posting, you agree to TikTok's Music Usage Confirmation".
- No QR codes or outside links in the video (TikTok Shop's content rules ban them for anything promoting the Shop; the ads rules ban QR codes). The AI first check already looks for this.
- After posting: say plainly that TikTok may take a few minutes to show it.

### What works before approval
- Everything in Noun ART that does not talk to TikTok: the posting screen, the Bank, Schedule and the queue, built and tested on sample data and with TikTok's published test video address.
- The developers.tiktok.com sandbox already connected: sign in and private test posts to a private test account (up to 10 test users). Only useful for a quick check, not for real work.
- Nothing public. Until the new app is approved, real posting is by hand in TikTok, as today.

### How long
About one to two weeks end to end if TikTok answers in its stated times (3 business days, then the form, then 2 to 3 business days). For comparison, the old door was days to two weeks for its review plus 2 to 6 weeks for its audit (reported by other companies), and our use case is the example it refuses.

## 4. Scale: 30 videos a day across many accounts

| Limit (TikTok's) | Number | What we do |
|---|---|---|
| Posts per account | 6 a minute, 15 a day (videos; photo posts the same) | every account gets a daily cap in Accounts, default 3, never above 15; the queue spreads posts over the account's time slots |
| Calls per account | 40 a minute per endpoint | reads per account run one at a time and back off on "rate limit" |
| Calls per app | 600 a minute across all accounts (Basic level; 1,000 at higher levels) | numbers are read in one paged sweep a day (20 posts a page), a few accounts at a time (as Refresh does today, 3 at once) |
| Numbers delay | 24 to 48 hours; post numbers stop updating 365 days after posting | no 1 hour TikTok number; checkpoints filled from the daily read |
| Account numbers | look back at most 60 days | on connect, the last 60 days are read once, then one day at a time |
| Video file | mp4, mov or webm, up to 1 GB, 3 to 600 seconds, 23 to 60 frames a second, at least 360 pixels; check each account's longest length | checked when the video is scheduled |
| Photo post | up to 35 images, JPG or WebP, 20 MB each | checked in the Carousels screen |
| Comments | 30 a page with up to 3 replies each; reply up to 1,200 characters; new comments arrive by live update within about 5 minutes | live updates first, a sweep every 6 hours as backup |
| Mentions | top 1,000 posts mentioning us in the last 90 days, 24 to 48 hours late | read once a day |

**30 a day:** at TikTok's ceiling that is 2 accounts, but 15 posts a day on one account looks like spam and spreads its reach thin. With a cap of 3 a day, 30 posts need 10 active accounts; with 5 a day, 6. The caps live per account (Accounts screen, `daily_cap`), so the owner tunes them.

**Many accounts, one app:** one Noun ART app serves every TikTok account. Each account is connected once, by someone signed in to that account, and gets its own token. No account needs its own app or API. The limits per account (15 posts a day, 40 calls a minute) apply to each account separately; only the 600 calls a minute is shared. TikTok allows this for accounts we own. Posting for accounts that belong to other people or businesses would make us an agency, and would need a new profile description and app review.

**Staying connected:**
- An access token lasts one day; the refresh token one year. Our token keeper refreshes when under 5 minutes are left (built), and a daily timer refreshes every account, so a quiet account never lapses.
- 30 days before an account's refresh token ends, Home shows the owner "Reconnect @handle before (date)", and Telegram says it once.
- TikTok's Business door has no "app removed" live update, so the daily refresh is also the check: a refused refresh marks the account "Reconnect needed" (built) and tells the owner on Telegram.
- Each account is connected by its own login, once. Disconnect cancels the token at TikTok and keeps the account's history (built).

## 5. What the connector does, screen by screen, in build order

Each build is planned by Fable 5.2, built by Opus 5.5 or Sonnet 5.5, checked by a Sonnet 5.5 and a Haiku 5.5 agent before the push, and shown on a phone and a computer before it is called done. Builds 3 to 8 each come with a migration draft for the owner to approve first.

**B1. Switch the connection to the new app** (built Nov 17 2026, not pushed; needs the step 2E keys)
- Settings, Integrations, TikTok card: Connect, Add account, Refresh and Disconnect now use the Business app. The callback stays `/connect/tiktok/callback/` (now with the trailing slash TikTok needs).
- The card shows per account: level (personal, Advanced, Verified), which permissions were granted in plain words ("posting, numbers, comments"), and a missing one as "Connect again to allow comments".
- New on the card: Video address with one Verify press (no DNS record, see decision 10), Turn on live updates, and the health of both.
- The "Private until TikTok's audit" badge goes away for accounts connected through the new app.
- The old developers.tiktok.com keys and code are removed once this works.

**B2. The TikTok box in the Schedule sheet** (basics built Nov 17 2026: disclosure, Comments, Duet, Stitch, Shop link, AI label; the rest below is deferred; the owner approves on phone and computer before push)
- Opens with the chosen account's picture and name, and its limits from TikTok (longest video, comments, duet, stitch).
- Caption with hashtags (editable, counter), disclosure ("Your brand" on by default for Noun posts, decision 4), AI label (set from the variant's record, decision 5), Comments, Duet, Stitch.
- Sound: pick a TikTok sound from the trending Commercial Music Library list (top 100, by genre and country). Or "Keep the video's sound". Saved TikTok sounds live in the Sounds library and say "TikTok only".
  - It plays over the video, like in the TikTok and Instagram apps (owner, Nov 16 2026).
  - Two bars to drag: the sound's volume, and the original audio's volume.
  - A slider for which part of the song plays.
  - These map to TikTok's `music_sound_volume`, `video_original_sound_volume`, `music_sound_start` and `music_sound_end`. TikTok mixes the final video, so the preview is close but not guaranteed identical.
  - Not confirmed yet: whether TikTok's preview link plays the whole song or a clip.
  - Instagram's sound mix depends on what Meta's API allows (the Meta session). Higgsfield music is mixed into the file by us, with the same two bars.
- "Needs a Shop product link" switch: the post will go to drafts for Finish in TikTok.
- Preview of the exact approved video, the length check, and the plain notes.
- Buttons: Schedule (into the account's time slots) and Post now. Grayed for anyone without the channel ticked; the approval rule stays in the database as today.
- Every choice and what TikTok showed at that moment are saved on the post.

**B3. The posting run** (built Nov 17 2026, not pushed; needs R2_PUBLIC_BASE_URL, the bucket's Public Development URL, with the Video address verified; live updates are deferred, the run asks for the status each minute)
- A Supabase timer each minute calls a protected route on the published app; it posts what is due through the posting guard (built). A test run never posts.
- Before posting it asks TikTok for the account's settings again; if something changed (the video is now too long for the account, the account is gone), the post goes to Failed with one plain sentence, never posted on a guess.
- TikTok pulls the video from R2 itself; big files never pass through Replit.
- The answer comes by live update first, with a status check as backup (every 30 seconds for a few minutes, then rarer). Posted shows the link and who approved it. Failed tells the team on Telegram, with a Retry button.
- Daily caps and the 6 a minute limit are kept per account.

**B4. Post numbers**
- One sweep a day per account: every post's numbers from the last year (reach, views, likes, comments, shares, saves, watch time, average watch, completion, new followers, profile views, retention curve, traffic sources, audience), saved as a new row each day.
- The fixed checkpoints (1 day, 3, 7, 30) take the read nearest to their time, so posts compare fairly. The 1 hour checkpoint stays empty for TikTok, with the note "TikTok gives numbers after about a day".
- Account numbers per day (followers gained and lost, profile views, views), with 60 days read back on connect.
- Shown on the card's Posted row, in the Posting queue and later in Analytics. Editors do not see numbers (`posting.numbers`, as today).
- Posts made by hand in TikTok are saved too (marked "not posted from Noun ART"), so the history is complete.

**B5. Finish in TikTok**
- For what the API cannot do: a TikTok Shop product link, a TikTok sound not in the trending list, or a video reply to a comment.
- Shop link or sound: the post goes to the account's TikTok drafts (`upload_to_draft`); the card and post show "Finish in TikTok" with three short steps; Home shows the count; Telegram nudges once.
- Video reply to a comment: the card shows the comment's words, who wrote it and a link to our video; a "Save to phone" button gives the approved file; the person opens the comment in TikTok, taps reply with video and picks it.
- When the finished post appears on the account, the app finds it (time, length, caption) and asks "Is this the one?"; on yes, it is Posted and its numbers start.

**B6. Comments tab** (in UGC, mentions and comments; needs its migration)
- Every comment and reply on our TikTok posts, newest first, by account and video, live within about 5 minutes.
- Reply in words (up to 1,200 characters) on a person's click; Vera may draft, a person sends. Hide a comment (TikTok lets us hide, never delete, other people's comments). Like.
- Answer with a video: makes a "Comment reply" card tied to that comment, which ends in B5.
- New permission `comments.reply` ("Reply to and hide comments on our posts") in `src/lib/access/permissions.ts` and the seed, in the same change.
- Care: TikTok warns against many near identical replies in a short time, so the app flags a reply that repeats an earlier one.

**B7. Mentions into UGC and mentions**
- Public TikTok posts that @mention Noun (top 1,000 in 90 days) and comments that mention us, in the same feed as Refunnel's, as links that play in TikTok.
- No download for these: TikTok's Business rules forbid downloading TikTok videos. Downloads stay with Refunnel's files, where creators gave their rights.

**B8. Spark Ads codes** (owner only, with the Ads phase)
- On a posted video: Allow Spark Ads, pick 7, 30, 60, 180 or 365 days, and the app gets the code. Extend or remove later (ads must be paused first). Turning it on accepts TikTok's ad content terms and locks the caption.
- The code is kept sealed like a token and shown only to the owner. New permission `ads.spark`, owner only by default.
- Launching an ad stays in Ads Manager or, later, the TikTok for Business MCP, always on the owner's click (campaigns are created switched off; a person turns them on).

**B9. Vera's TikTok tools** (in Vera's own chat, later)
- Read only: trending sounds and hashtags, search ideas, mentions, our posts with their numbers, comments to draft replies for.
- Through our own tool layer with the app's token, or the TikTok Social MCP given our token (it then has the API's normal limits). Its posting, comment and Spark tools are never given to Vera: those stay a person's click in the app.

## 6. Clean data: what we keep

Already in the database (first migration): `social_accounts` (open id, handle, followers, health, daily cap, time zone), `account_tokens` (sealed, server only), `posts` (caption, hashtags, sound, cover, AI label, `platform_settings`, TikTok's post id, link, Finish in TikTok fields, who scheduled and approved), `post_attempts` (every try and TikTok's answer, never a token), `post_metrics` (the checkpoints), `posting_slots`, `sounds`.

New, in migration drafts the owner approves before each build:
- **posts.platform_settings** (no new table): every TikTok choice (disclosure, AI label, comments, duet, stitch, sound id, volumes, start and end, draft or direct) plus what TikTok showed when the box opened (account limits).
- **platform_events** (B3): every live update and status answer from TikTok, as received, append only, so nothing is lost and a duplicate never posts twice.
- **social_videos** (B4): every post on a connected account, ours or made by hand: TikTok's id, link, caption, time, length, kind, linked to our post when it is ours.
- **social_video_stats** (B4): one row per post per daily read, with every number TikTok gives, the retention curve and the traffic sources; the checkpoint rows in `post_metrics` point at the read they came from.
- **account_stats_daily** (B4): per account per day: followers gained and lost, views, profile views, audience.
- **social_comments** (B6): every comment and reply on our posts: TikTok's id, parent, author's handle, words, likes, time, hidden or not and by whom. Never deleted.
- **comment_replies** (B6): our replies: words, who wrote, who sent, drafted by Vera or a person, TikTok's id or the reason it failed.
- **comment_reply_cards** (B6): the link from a comment to its "Comment reply" card and the finished post.
- **TikTok sounds** in `sounds` (B2): track and clip ids, name, artist, length, preview, trend history.
- **spark_authorizations** (B8): post, sealed code, days, start, end, who, when, removed.
- **Mentions** (B7) go into the UGC tables already drafted (`docs/drafts/ugc-migration-draft.sql`) with TikTok as a source.

Every row keeps who and when, nothing is hard deleted, and TikTok's raw answer is kept next to the clean fields, so Vera and the future AI editor can learn which hooks, sounds, times and captions worked.

## 7. Decisions for Khaled (with my recommendation)

1. **Move TikTok to TikTok API for Business and never submit the old app for review.** Recommend: yes. The old door names our use as refused; the new one is built for it and gives far more.
2. **Make every Noun TikTok account a Business account linked to Noun's Business Center.** Recommend: yes. It unlocks mentions and daily follower numbers. The cost: in the TikTok app those accounts only see the Commercial Music Library, which is the only music a brand may use anyway. Please send the list of accounts and which are Business today.
   **Still open: the list of accounts and which are Business today.**
3. **Return addresses:** TikTok's Business door keeps one address active at a time and refuses localhost. Recommend: `art.incivera.ai` active, `noun-art.replit.app` listed and switched on only for a test on Replit. A second exception to the three addresses rule.
4. **Disclosure:** TikTok's rules require it even when promoting our own business; undisclosed posts can lose reach and repeat cases can restrict the account. Recommend: "Your brand" on by default for every Noun post; "Paid partnership" only for paid creators. (TikTok's branded content rules also ban paid promotion of hair growth products, which matters if we ever pay creators for one.)
   **Build assumed: yes, "Your brand" is on by default.**
5. **AI labels:** TikTok requires a label on realistic AI and may remove or restrict unlabeled posts; the label cannot be removed later. Recommend: always label realistic AI on TikTok, and run the labeled vs unlabeled test only on content that is not realistic, or on Instagram first. Your call.
   **Still open (your call). The build copies the label from the video's own AI label.**
6. **Music:** Recommend: editors deliver TikTok cuts with voice and original sound only; the TikTok sound is attached at posting from the trending licensed list. A video with licensed TikTok music baked in may only be posted on TikTok, never reused on Instagram or Facebook.
7. **Shop links and who finishes in TikTok:** Recommend: Finish in TikTok for now, done by our own team (it needs the account logins on a phone), not the agency. TikTok Shop's own Partner API can post a video with a product link, but it is a separate app and sign in, built for affiliate creators, and not confirmed for a brand's own account: worth checking in its own session later.
8. **Daily cap:** Recommend: 3 posts a day per account to start (TikTok allows 15), raised per account once numbers show it does not hurt reach. How many TikTok accounts will we run?
   **Build assumed: default 3, never above 15 (the cap is the smaller of the daily cap and 15). How many TikTok accounts is still open.**
9. **Ask for Spark Ads and mentions now:** Recommend: yes, in the first application, because every later addition needs TikTok's access form again.
10. **Video address:** ~~R2 serves edited videos from `media.incivera.ai`, verified at TikTok by a DNS record.~~ Superseded Nov 17 2026 (owner approved): TikTok checks a URL prefix on R2's own public address, so no DNS record and no media.incivera.ai. Steps: Public Development URL on the bucket, that address as `R2_PUBLIC_BASE_URL`, then Verify on the card. Risk: any video in the bucket can be opened by anyone with its exact address (no listing, long random names). r2.dev is rate limited (Cloudflare calls it a development address). Not yet verified: that TikTok accepts an r2.dev prefix. Fallback: a custom domain later if r2.dev throttles.
11. **Who may reply to comments:** Recommend: owner and admins always, plus whoever you tick (`comments.reply`).
12. **Test account:** every post through the new door is public. Recommend: one throwaway TikTok account for the first real tests, before any Noun account.
   **Build assumed: yes, a throwaway account first (the first test above).**

## Sources (read Nov 16 2026)

TikTok for Developers:
- Content sharing guidelines (intended use, screen rules, the 15 a day cap): https://developers.tiktok.com/docs/en/content-sharing-guidelines
- App review guidelines: https://developers.tiktok.com/docs/en/app-review-guidelines
- Content Posting API, get started and direct post: https://developers.tiktok.com/docs/en/content-posting-api-get-started and https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post
- Upload to drafts (5 waiting per 24 hours): https://developers.tiktok.com/docs/en/content-posting-api-reference-upload-video
- Photo posts: https://developers.tiktok.com/docs/en/content-posting-api-reference-photo-post
- Media and URL rules: https://developers.tiktok.com/docs/en/content-posting-api-media-transfer-guide
- Creator info: https://developers.tiktok.com/docs/en/content-posting-api-reference-query-creator-info
- Rate limits: https://developers.tiktok.com/docs/en/tiktok-api-v2-rate-limit
- Tokens: https://developers.tiktok.com/docs/en/oauth-user-access-token-management
- Video fields: https://developers.tiktok.com/docs/en/tiktok-api-v2-video-object
- Webhooks: https://developers.tiktok.com/docs/en/webhooks-events
- Sandbox: https://developers.tiktok.com/docs/en/add-a-sandbox

TikTok API for Business (`https://business-api.tiktok.com/portal/docs/<page>/v1.3`):
- Organic API and Accounts API overview, the access form since March 20 2026, allowed and banned uses: `organic-api`, `accounts-api`, `accounts-api-overview`
- Authorization, one active redirect URL, trailing slash, token lifetimes: `accounts-api-authorization`, `accounts-api-authentication`
- Account and post insights, delay: `get-profile-data-of-a-tiktok-account`, `get-post-data-of-a-tiktok-account`, `accounts-insights-data-latency`
- Publishing (15 a day, music, drafts, disclosure fields): `publish-a-public-video-post-to-an-owned-account`
- Verified video domains: `manage-url-properties`, `add-a-url-property-to-an-ad-account`
- Comments: `manage-comments-on-owned-tiktok-videos`, `reply-to-an-existing-comment-on-an-owned-video`
- Spark Ads codes: `manage-tiktok-post-ad-authorization`, `enable-or-disable-the-ad-authorization-setting-for-a-tiktok-post`
- Live updates: `accounts-api-webhooks-guide`, `post-publishing-events`, `comment-update-event`
- Rate limits: `accounts-api-rate-limits`
- Developer registration and apps: `register-as-a-developer`, `create-a-developer-app`
- Mentions: `mentions-api-overview`, `mentions-api-authorization`, `get-top-1000-mentioned-posts`
- Trending licensed music: `get-popular-tracks-from-the-commercial-music-library`
- TikTok Social MCP and the ads MCP: `tiktok-social-mcp-server`, `available-tools-in-tiktok-social-mcp-server`, `how-to-connect-a-custom-agent-to-tiktok-social-mcp-server-as-a-developer`, `tiktok-ads-mcp-server`, `available-tools-in-tiktok-for-business-mcp-server`

Rules and music:
- Commercial Music Library terms: https://www.tiktok.com/legal/page/global/commercial-music-library-user-terms/en and https://ads.tiktok.com/resources/help/article/how-to-use-the-commercial-music-library
- Disclosure of commercial content: https://www.tiktok.com/safety/en/policies-and-engagement/regulated-commercial-activities
- Branded content policy: https://www.tiktok.com/legal/page/global/bc-policy/en
- AI labels: https://www.tiktok.com/safety/en/policies-and-engagement/integrity-authenticity
- TikTok Shop content rules (no links or QR codes): https://seller-us.tiktok.com/university/essay?knowledge_id=6837891779151617
- TikTok Shop Partner API, shoppable video: https://partner.tiktokshop.com/docv2/page/post-shoppable-video-202603

Not confirmed yet, to check during the build: whether Commercial Music Library tracks outside the trending top 100 can be attached by id; whether a refresh resets the one year refresh token; the exact questions in TikTok's access form; whether the Business door asks for a demo video; whether the brand's own TikTok Shop account may use the shoppable video API.
