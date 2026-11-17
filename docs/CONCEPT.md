# Noun Content System: Concept

Version 1, November 14, 2026. Written with Khaled. Status: waiting for the owner's approval.
Nothing in here is built yet. The name of the app and of the AI agent come later.

## 1. In one line

An AI native creative studio and content system in one app: Noun plans, shoots, generates, edits, reviews, multiplies, posts and learns from its content, so we can post about 30 different videos a day without creating every day.

It has two halves that share one library and one brand kit:
- **The AI Creative Studio:** make and edit images, videos, music and carousels with every model we have access to (Higgsfield and our other tools), starting from our own footage, products and faces.
- **The content system:** plan, review, approve, bank, post, measure and learn.

Everything the studio makes lands in the content system's review feed and family tree, so the AI learns from it.

## 2. What we believe (the rules every screen follows)

1. **Post a lot without creating every day.** Every shoot fills a content bank with many finished posts. The system posts from the bank.
2. **Clean data is the real product.** Every clip, version, variant, comment, approval, post and number is saved in a fixed shape, so the AI can learn what works. Fixed label lists, nothing ever hard deleted.
3. **Nothing goes out without a yes.** No post, no ad, no message without a human approval. Spending money is always the owner's click.
4. **The AI does the work, people make the calls.** The head of content (our AI agent) makes videos and suggests; we approve.
5. **Phone first, easy on the eyes.** Big clear actions, obvious status, a team in Ukraine understands it without training.
6. **No vendor lock.** Higgsfield, Gemini, Claude and Canva are tools we can swap when better ones come.
7. **Official data only.** We use platform APIs, never scraping.
8. **You can always see the system working.** Every automatic step (a clip being indexed, an AI video being made, a post going out, numbers coming in) shows live in one Activity view, with what it is doing, why, and what it cost. Nothing happens in the dark.

## 3. People and what they can do

| Who | Role | Sees | Can do |
|---|---|---|---|
| Khaled | Owner | Everything | Everything, including final approvals, budgets, ads, connecting accounts |
| Steven, David | Admins | Everything | Plan, review, approve, schedule, manage the team. Ads and budgets only if the owner allows |
| Strategist (agency) | Planner | The calendar, references, results | Create and edit cards, add references, see what worked |
| Editors (agency) | Makers | Only their own cards and the comments on them | Download raw, upload versions, answer comments, mark fixed |
| Head of content | AI agent | Everything it is allowed to read | Make variants and drafts within a budget, suggest, draft replies. Never posts or spends on its own |

Custom roles (exactly what each person sees and does) come later. The database itself enforces who sees what, so a bug in the app cannot leak work.

### Who's online and the audit trail (same as the Noun ERP)

This works exactly like the ERP does today.

**Sign in with Google.** Everyone signs in with their Google account. Their Google profile picture becomes their avatar everywhere in the app.

**Who's online, live.**
- At the top of every screen, next to the owner, sit the avatars of everyone online right now.
- Each avatar shows a status dot: **online**, **away** (no activity for a few minutes), or offline.
- Tap an avatar to see **which page they are on** right now.
- When two people are on the same page (for example both reviewing the same card), you see each other's **live mouse cursor** with their name, and the comment they are typing.

**Team page** (Settings, Team and access), same layout as the ERP:

| Person | Role | Last active | Access |
|---|---|---|---|
| Google photo, name, email | Owner, Admin, Strategist, Editor, Viewer... | "Active now", "59 min ago", "Yesterday", "Oct 31", "via Claude" when the action came through a Claude connector, "Hasn't signed in yet" | Active, Invited, Removed |

- Owner and admins can **invite a person**, change their role, add an **exception** for one person, or **view the app as them** to check exactly what they see.
- Agency editors never see this page.

**Audit trail.** Every action is recorded, forever: who did it, what they did, on which card or file, from which page, when, and the before and after.
- Examples: "Steven approved v2 of Ingredient truth: Patchouli", "Editor uploaded raw clip IMG_4412.mov", "Head of content made 3 hook variants (cost $4.20)", "David changed Kareem's role to Admin", "Post went live on @nounnaturals".
- Actions by the head of content and by Claude connectors are recorded the same way, marked as AI or "via Claude".
- Owner and admins can filter the trail by person, card, action or date. Each card also shows its own history.
- The audit trail is part of the clean data: the AI learns who approves what and how fast work moves.

## 4. The building blocks of the data (in plain words)

Everything hangs off a **family tree**, so we always know where a post came from:

```
Card (the idea)
 └ Raw clips (what we shot)
    └ Versions (v1, v2, v3 from the editor)
       └ Variants (new hook, new person, new language, new music...)
          └ Posts (one per account per platform)
             └ Numbers (pulled at 1 hour, 1 day, 3 days, 7 days, 30 days)
```

| Thing | What it holds |
|---|---|
| **Card** | One idea: week, day, type, format, product, series, reference link, target accounts, who it is assigned to, status |
| **Raw clip** | A file in Google Drive, plus what Gemini found in it: transcript, shots, best takes, possible hooks |
| **Version** | An edit from the editor, with every timestamped comment and who approved it |
| **Variant** | A new video made from a version, with exactly what changed, which tool made it, the prompt and the cost |
| **Asset** | A carousel, photo or slide set, with its template, product theme and the claims it uses |
| **Post** | One video or carousel on one account: time, caption, sound, link, AI label yes or no |
| **Numbers** | Views, reach, plays, watch time, completion, likes, comments, saves, shares, follows |
| **Review comment** | Pinned to a second of a version, tagged as hook, pacing, captions, audio, brand or other |
| **Account** | One TikTok, Instagram, Facebook or YouTube account, shown by its username and logo |
| **Sound** | A track in our sounds library and where it came from |
| **Brand kit** | Logos, fonts, colors per product, product photos, label text, claims, voice rules, layouts, faces, do not list |

**Fixed label lists** (picked, never typed): type (talking head, comment reply, live...), format (education, connection, objection handling, proof...), product, series, hook style, face, sound, real or AI.

## 5. Statuses

A card moves left to right. The status is always visible as a colored pill.

`Idea` → `Planned` → `Shot` → `Editing` → `In review` ⇄ `Needs edits` → `Approved` → `In bank` → `Scheduled` → `Posted`

Extra status: `Finish in TikTok` for videos that need a TikTok Shop product link added by hand (the API cannot add it yet).
Every approval shows **who** approved it and **when**.

## 6. How the work flows

### A. Plan
The strategist creates cards for the week: day, type, format, product, reference link, accounts. The week is just a view of cards, not a separate table, so results can be compared across weeks.
Week 1 from Notion comes in once by CSV import.
Gemini watches the reference link (Higgsfield video analysis) and turns it into a shot list on the card.

### B. Shoot, upload, and Gemini sorts it (Upload/Files, decided Nov 16 2026)
We shoot on iPhone. About 75% of uploads come from a computer and 25% from a phone, so both are first class: on a computer, drag many files or a whole folder; on a phone, pick from the camera roll. Files go straight from the browser into Google Drive, never through Replit, with progress and resume after a dropped connection. Photos are allowed too.

**One sidebar item, Upload/Files, with a small switch between two tabs.**
- **Upload** is the main path: a mass upload into a space (Noun Naturals content or Founder content). It never asks for a week or a day: footage for Monday is often shot on Wednesday, or uploaded three weeks later. Everything lands in the space's **New uploads** folder. "Change folder" sends a drop into any other folder instead.
- **Files** is the shared drive inside the app, and it is used a lot: every folder and file already in the drive shows (also what people made straight in Google Drive, and what was copied from the old NOUN x DARYNA folder), not only what the app made. Open any folder and drop files or folders onto it (a cameraman opens Week 7 and drops a whole shoot). "Create a folder here" makes it in Drive too: the interface is the Drive. The app's own folders are locked (no rename, move or remove); team folders can be renamed, moved and removed, and Remove always has Undo (Drive's trash, never a delete). A Week folder made in Files never makes a week in the Calendar: week folders follow the content calendar.

**Gemini reads every upload, wherever it lands.** It only listens, it never watches (cost):
- Gemini Transcribe turns the sound into text. Gemini Hydrogen reads that text and writes a short title, a one or two line summary, and up to three cards it fits, on any week's board of the space (a mixed drop of Weeks 1, 2, 3 and 5 sorts itself). The Shot tick is a strong hint, never required.
- A clip with no speech is a **"No sound video"**: no title, no guess, and $0.
- **Sure (90% or more):** the clip is filed by itself, with Undo. Dropped into New uploads or a week folder, the original MOVES into that week's Raw (same Drive id); dropped into a team folder (B roll, BTS, Freestyle), it stays there. Either way a shortcut goes into Week, the card's calendar day, the card's folder. A card moved to another day takes its folder along.
- **Not sure, and No sound videos,** wait in New uploads and in the content team's inbox for one tap: Confirm, Pick another card, or Make a card from this clip.
- Gemini also writes two lines about each drop and each folder ("great B roll for sea salt spray topics").
- **Every AI cost shows** under the file, the drop and the folder, with the model's logo, and in Settings, AI costs (today, this month, the daily limit, files read, sorted alone, Undo presses), for everyone, editors too. The daily limit starts at $5 and only the owner changes it; when it is reached, files still upload and wait for the next day.
- The old folders from before the app are read only when someone presses "Read this folder with Gemini", with the cost shown on the button first.

**The content team's inbox** (the Strategist/Editor Home and Upload/Files) lists the drops newest first: what Gemini filed by itself (with Undo), what waits for a tap, the No sound videos, and Freestyle, B roll and BTS drops with Gemini's summary of what they are and what they could be used for. Every suggestion, confirmation, Undo and cost is saved (who, when, confidence, model), so the matching gets better and we can tune the 90% line from the Undo count.

The folders, inside the one shared drive owned by Noun Naturals:

```
Noun ART (Content System)
  ├ (what was in the drive before the app, shown as it is)
  └ Noun Naturals content
      ├ New uploads (flat: waits here until sorted)
      ├ B roll, BTS, Freestyle ... (team folders)
      └ Week 2
          ├ Raw (the week's originals, flat)
          └ Wed Nov 11
              └ W46 WED 03 Bar against bottle (shortcuts to its clips)
```

The app tracks folders and files by Google's permanent ID, so renaming or moving them in Drive never breaks anything. The reader is a small job on our own Google Cloud (art-reader), because Replit cannot run background work; uploads never depend on it.

### C. Edit
Editors download the matched raw, edit, and upload v1 onto the card. The edit goes to Cloudflare R2 (fast to play, ready to post). Raw and edit show side by side.
Before a human sees it, an **AI first check** runs: TikTok bans (QR codes, links, discount cards), text hidden under platform buttons, spelling, product name, claims, and a virality score.

**The checker learns our rules.** We do not retrain a model; we give it a growing book of house rules and reference videos that it reads on every check:
- **Teach it by chat** on any video: "for next videos, the label must face the camera, never say cure". It proposes rules; a person approves each one before it counts.
- **It learns from review notes:** when the same Needs edits note repeats, it proposes a rule.
- **References:** any approved video can be marked as a good example to compare with.
- Every check line names the rule behind it, and a person can mark it wrong. Rules that are often overridden get flagged for review.
- A **Checker rules** screen lists every rule: who added it, from where, how often it fired and was overridden, on or off.

**How it is built (the agent pattern):** following Anthropic's guide to building effective agents and Google's agent docs. Start with the simplest loop that works: a fixed workflow (watch the video, check each rule, write the result) plus an evaluator step, not a free roaming agent. A small set of well described tools (read the rules, look at reference videos, read the card's brief and claims library, write the check result, propose a rule). Human approval for every new rule. Every run is logged with inputs, model, cost and result, so we can test it against past videos before changing it. The model is Gemini (it watches video natively), run through Google's agent kit; the vendor stays swappable.

### D. Review (swipe feed or grid)
Two ways to see everything waiting, one tap apart:
- **Swipe:** like a TikTok feed, strongest scores first. Swipe to approve.
- **Grid:** every video waiting as tiles (thumbnail, title, editor, version, status, accounts), filter by account, editor or day. Tap one to open it.

Asking for edits works like Frame.io:
- A big, clearly labeled **Add comment at 0:07** button pauses the video on that exact frame and opens the comment box there; a hint tells new reviewers to pause anywhere and comment on that frame. A quick circle or arrow can be drawn on the frame. The editor opens each note on that same frame.
- A comment box is always visible under the video. Tap or hold the timeline to pin a note to that second, by voice or text, with a label (Hook, Captions, Audio, Pacing, Product, Other). Voice is turned into text. Editors can translate any note to Ukrainian.
- Notes collect as a draft. Then one button: **Send to editor (3 notes)**. It cannot be sent with no notes, so the editor always knows what to fix.
- Sending sets the status to Needs edits and messages the editor on Telegram (Google Chat as fallback) with the title, every note with its second, and a link that opens the video at that moment.
- Compare v1 and v2 side by side, or raw and edit. v2 lands on the same card. Full history stays.

### E. Multiply (one video becomes many)
From any approved version:
- **Hook maker:** record many hooks for one body; the app glues each hook onto the body.
- **Higgsfield Ad Multiplier** (videos 4 to 30 seconds): new hook or call to action only, swap person, product, background or outfit, or recreate for another market or language.
- **Avatars:** Khaled and the team (consent is on file) say new scripts in their own cloned voice.
- **Dubbing** into other languages, **reframe** to vertical, **upscale**.
- **Original music** made with Higgsfield (ElevenLabs Music) for videos with no sound.
- **Carousels and photos:** the AI writes slides from the approved claims list, makes photos with Nano Banana using real product shots, fills a Canva brand template in that product's colors. Open in Canva to tweak.

Every variant passes the virality score and the style rules before it reaches the swipe feed. Every variant records what changed, which tool, the prompt and the cost.

### E2. The AI Creative Studio (the workspace)

One workspace, no jumping between apps. Modes along the top: **Image**, **Video**, **Edit**, **Audio**, **Carousel**. Switching mode keeps your prompt, references and results on screen.

**Left: what you start from**
- Prompt, written or spoken. The AI can rewrite it in Noun's style.
- References dragged in from our own library: raw clips, approved edits, product photos, label shots, brand kit, saved faces (Soul IDs of Khaled and the team), past winners, a competitor or trend reference.
- A product picker: choosing a product loads its photos and color theme automatically.

**Middle: the model and its settings**
- Model picker with search, grouped by job (realistic people, product shots, text on image, video from image, video edit, music, voice). Each model shows its name, a one line description, what it is best at, and the **estimated cost before you generate**.
- The model list is read live from Higgsfield's API, so new models appear on their own. Other providers we have keys for (Google Gemini and Veo directly, Canva for layouts) sit in the same picker. One picker, many vendors, nothing locked in.
- Settings that change by model: aspect ratio, resolution, duration, number of outputs, seed, strength of references.
- "Auto" option: the studio picks the best model for the job and says why.

**Right: results**
- A grid of results with cost, model and prompt on each.
- On any result: make variations, upscale, reframe, extend, remove background, expand, change one thing ("same video, new person"), add music, dub, run the virality score.
- **Send to review** puts it into the swipe feed on the right card. **Save to library** keeps it as an asset.

**Edit mode (AI native editing)**
- Open any video, from raw to approved: a simple timeline with the transcript under it. Cut by deleting words in the transcript.
- One tap jobs: new hook, new call to action, captions in Noun's style, swap music, reframe to vertical, clean audio, translate and dub.
- Prompt edits: "make this tighter and add a product shot at 0:04". The AI writes an edit recipe; a render service makes it; the recipe stays editable.
- This is the seed of the full AI editor, which learns from every version and comment we collect.

**Every generation is recorded** in the family tree: source, model, prompt, settings, cost, who asked (a person or the head of content). The monthly AI budget and spend per person show at the top of the studio.

### F. Bank and schedule
Approved posts go into the **content bank**. Each account has daily time slots. The scheduler fills the slots from the bank.
Rules: no near duplicates on the same account; hook variants spread across accounts or go out as Instagram trial reels; real footage first, with a cap on AI posts per day that rises only if AI performs.
Home shows one number: **days of content left in the bank**.

### G. Post
| Platform | How |
|---|---|
| Instagram | Reels, carousels, trial reels, trending audio, collab posts, product tags, posted by API |
| Facebook | Reels posted to the Page by API |
| TikTok | Videos and photo posts by API, with trending licensed music. Videos needing a Shop product link go as a draft and show `Finish in TikTok` |
| Threads | Optional extra channel |
| YouTube | Later |

Once posted, the card shows `Posted`, the link, and who approved it.

### H. Measure
Numbers are pulled on a fixed clock (1 hour, 1 day, 3 days, 7 days, 30 days) so posts compare fairly. Instagram: reach, plays, watch time, saves, shares. TikTok: views, watch time, completion, and benchmarks against similar accounts.
Tying posts to ERP sales is on hold.

### I. Community
One inbox for comments on TikTok, Instagram and Facebook. The agent drafts replies; we approve. TikTok text replies post from the app. A video reply to a TikTok comment is made in the app and posted with one tap in TikTok (the API cannot post video replies yet).
Mentions: videos and comments that mention Noun, top words and hashtags people use about us.

### J. Discover
Trending keywords, hashtags and licensed music on TikTok. Hashtag search on Instagram. Competitors: Instagram Business Discovery (followers, posts, likes, comments over time). TikTok gives no official competitor numbers, so we use trends, mentions and TikTok One creator data.

### K. Ads (later phase)
Spark Ads recommendations (our posts and creator posts), boost with one click, GMV Max for TikTok Shop, Meta ads. The agent explains the plan; the owner clicks to launch. Runs through the TikTok for Business MCP and the Meta Ads MCP.

## 7. The head of content (AI agent, built later in its own chat)

**Its job:** keep the content bank full and make every week better than the last.

**What it reads:** our raw footage index, every version and comment, every post and its numbers, TikTok Social MCP (trends, sentiment, mentions, benchmarks), Instagram insights, the brand kit and claims list.

**What it does on its own (within a monthly budget the owner sets):**
- Picks winners and tells Higgsfield what to make: new hooks, avatar videos, remixes, dubs, music, carousels.
- Writes cards for the strategist: what to shoot next and why.
- Drafts comment replies.
- Writes a weekly brief: what worked, which hooks won, next week's plan.

**What always needs a human yes:** posting, launching ads, spending past the budget, using someone's likeness on a post.

**Every output** lands in the swipe feed with a note: what it did and why.

**Later:** the AI editor (drop raw footage, get an edit in Noun's style with motion graphics and captions). It learns from the version history and timestamped comments we collect from day one.

## 8. Screens

The list of screens and what each is for. **Where each screen sits (tabs, menus) is decided in the design step**, not here.

| Screen | For |
|---|---|
| **Home (owner, admins)** | Days left in the bank, what needs me now (reviews, Finish in TikTok, comments), today's posts, quick numbers |
| **Home (editors, content team)** | Their to do list first: feedback sent to them (video with notes at the frame, drawings, tick done, upload next version), new edits assigned (brief, raw, due), then "Went live" with who approved and audience comments. No numbers |
| **Calendar** | Notion style views of the same cards: Calendar (week or month), Board (by status), Table, Gallery (tiles); shared filters, sort and group; drag to move; each day's Raw clips inbox |
| **Raw clips (day view)** | All of a day's raw clips in one place; AI suggested matches to titles; confirm, rematch, download; comments and status |
| **Card** | Everything about one idea: brief, reference, matched raw, versions, variants, comments, posts, numbers |
| **Upload/Files** | One sidebar item with a small switch. Upload: drag many files or a folder into a space's New uploads (computer), or pick from the camera roll (phone), no day asked. Files: the shared drive inside the app, every folder and file, drop onto any folder, make team folders. Gemini titles, summarizes and sorts every upload, with its cost shown; the content team's inbox for what waits (see 6 B) |
| **Review** | Swipe or grid; timestamped notes; Send to editor; approve; compare versions |
| **Library** | Search all raw clips, edits, variants and carousels (by product, face, hook, words spoken) |
| **AI Creative Studio** | The full creative workspace: Image, Video, Edit, Audio and Carousel modes; references from our library; model picker with description and cost; results; send to review (see 6 E2) |
| **Carousels and photos** | Its own tab, run as a chat with the Carousel agent (part of the head of content's family): dictate the idea, it asks how many slides, which product and which account, shows a plan with models and cost, then builds the slides from brand kit product photos and AI images (Claude writes the copy; Nano Banana, Higgsfield, GPT Image make images). Edit slides by chat or by hand; claims only from the claims library; send to review |
| **UGC, mentions and comments** | Under Make. Every post, story and video that tags or mentions Noun on Instagram, Facebook, TikTok and elsewhere, newest first, with filters by platform and type. Each one can be saved to the Library and downloaded so editors can use it as UGC in our videos. Shows whether the creator's permission was asked, granted or declined. Story mentions are saved as they arrive because they expire after 24 hours. Editors may open it. A Comments tab (owner, Nov 14 2026) holds the comments on our own TikTok, Instagram and Facebook videos: reply in words right there where the platform allows it, or "Answer with a video", which makes a "TikTok comment" card tied to that comment; the editor attaches the finished video to it, and when it has to be finished inside TikTok it waits as a draft reply to that comment, with the comment and a link to it on the card. |
| **Templates** | Carousel layouts, caption and hook templates, Canva brand templates, edit recipes |
| **Checker rules** | The AI first check's house rules and reference videos (see 6 C) |
| **Bank and schedule** | What is in the bank, slots per account, what posts when |
| **Accounts** | Every connected account by username and logo, health, posting limits |
| **Insights** | Per post, per account, hook leaderboard, real vs AI, labeled vs unlabeled |
| **Discovery** | Trending keywords, hashtags, music; hashtag search |
| **Community** | Comments inbox and mentions, with drafted replies |
| **Competitors** | Tracked accounts and how they move |
| **Ads** | Boost suggestions, running ads, results (later) |
| **Sounds** | Saved TikTok and Instagram sounds, our Higgsfield music, licensed tracks |
| **Brand kit** | Per product colors, logos, fonts, product photos, label text, claims with sources, voice rules, layouts, faces, do not list |
| **Head of content** | Chat with the agent, its weekly brief, its budget |
| **Activity** | Live feed of everything the system and the agent are doing: indexing, AI jobs (with cost), posts going out, numbers pulled, errors to fix |
| **Team** | Same as the ERP's Team and access: Google photo, name, email, role, last active, access status; invite, change role, exceptions, view the app as a person |
| **Audit trail** | Every action by every person and by the AI, filterable by person, card, action and date |
| **Who's online (top bar, every screen)** | Avatars of everyone online with online and away dots; tap to see their page; live cursors when on the same page |
| **Settings** | Connections (owner's clicks), budgets, notifications, language |

**Editors get a simpler app:** My cards, Upload, Comments to fix. Nothing else to learn.

## 9. Look

- Tactile neumorphism for controls (raised search bars, sunk cards, chunky toggles, dials, pressed pills), with confident color accents. Easy on the eyes.
- Background: the warm tan from the Noun ERP.
- Frosted glass for data tiles and platform tiles: each platform's real logo on a gradient glass tile, from one shared component.
- High contrast for actions and status. Light and dark mode. Every dropdown has search. Buttons at least 44px.
- Designed by Fable 5.2, several options, the owner picks. App look and content brand stay separate.

## 10. Notices

- Phone notifications from the installed web app (no app store).
- A Telegram bot in the team group: "v2 ready for review", "3 posts need Finish in TikTok", with links.
- One daily summary. Never one email per item.

## 11. What we build on

### The app
| Job | Tool |
|---|---|
| Hosting | Replit |
| App code (proposed) | Next.js and TypeScript, styled only by the design system (design tokens and its own classes, no Tailwind); installable web app |
| Database, sign in, roles, live updates, who's online and live cursors | Supabase (its own new project, separate from the ERP and PLM); Supabase Realtime for presence |
| Sign in | Google (Workspace accounts; agency uses Google accounts too) |
| Raw footage | Google Drive API, Shared Drive "Noun ART (Content System)", through the company's service account |
| Reading every upload | The Gemini reader: a Cloud Run job (art-reader) on our own Google Cloud, started after each upload and every 5 minutes, within the daily limit |
| Edits, variants, carousels | Cloudflare R2 (free downloads, direct links for posting) |
| Old raw archive (optional) | Google Cloud archive storage |
| Transcribing raw clips | Gemini 3.5 Transcribe (word timestamps, speaker labels, language detection; about $0.005 a minute, Nov 2026) |
| Titles, summaries and matching clips to cards, translation | Gemini 4 Hydrogen (Google's everyday model, $1.50 in and $7.50 out per million tokens, Nov 2026). For raw clips it reads the transcript and never watches the picture; Argon was dropped (owner, Nov 15 2026). Model names in settings, never hard coded |
| Writing, planning, the agent | Claude API |
| Notices | Telegram Bot API, web push |

### Posting and numbers
| Job | Tool |
|---|---|
| Instagram | Meta Graph API: publishing (reels, carousels, trial reels, audio, collabs, product tags), insights, comments, hashtag search, Business Discovery |
| Facebook | Meta Graph API: Page reels, insights, comments |
| TikTok | TikTok Organic API (Accounts: publish, comments, insights, benchmarks; Discovery; Mentions; Spark Ads recommendations); Content Posting API as backup |
| Threads | Threads API (optional) |
| YouTube | YouTube Data API (later) |

### Making content
| Job | Tool |
|---|---|
| Video variants, avatars, remixes, dubbing, reframe, upscale, virality score, video analysis | Higgsfield API |
| Images | Higgsfield API (Nano Banana family, GPT Image, Seedream, FLUX, Soul) |
| Music and voice | Higgsfield API (ElevenLabs Music, voice cloning) |
| Carousel templates | Canva Connect API (autofill brand templates, open in Canva) |

### The agent's MCPs
TikTok Social MCP, Canva, Google Drive, Gmail (watching TikTok and Meta developer emails), Shopify (read only, products), Noun ERP (read only). Later: TikTok for Business MCP and Meta Ads MCP for ads.

## 12. Safety

- Nothing posted, sent or spent without a human yes. Ads and budgets are the owner's click.
- This app has its own keys everywhere. Never the ERP's keys. Keys go in Replit Secrets, entered by the owner.
- Big files never pass through Replit.
- Avatar consent is on file. Only the owner side approves posts using someone's likeness.
- AI labels: we test labeled vs unlabeled, on secondary accounts first. TikTok requires labels on realistic AI.
- No customer data in this app. Official data only.

## 13. Rough monthly costs (to confirm)

| Item | Rough cost |
|---|---|
| Supabase | about $25 to start |
| Cloudflare R2 (edits only) | about $15 to $30, growing slowly; archive keeps it low |
| Higgsfield | a budget the owner sets |
| Gemini, Claude | usage based, small at first |
| Replit, Google Workspace, Canva | already paid |

## 14. Build phases

Each phase ends with something the team uses every day.

| Phase | Name | What ships |
|---|---|---|
| 0 | Design | Fable 5.2 designs the design system options and every screen; the owner picks; screenshots on phone and desktop |
| 1 | Replace Notion and Frame.io | Google sign in with photos, roles, who's online with live cursors, Team page, audit trail, calendar and cards, CSV import, raw upload to Drive, edit upload, swipe review with timestamped comments and versions, raw beside edit, Telegram and phone notices, Gemini indexing (clean data starts day one) |
| 2 | Post from the app | Connect accounts, content bank, scheduler, posting to Instagram, Facebook and TikTok, numbers on a clock, insights |
| 3 | AI Creative Studio | The studio workspace (Image, Video, Edit, Audio, Carousel), live model picker with costs, brand kit, Higgsfield (hooks, Ad Multiplier, avatars, music, dubbing, virality score), hook maker, carousels with Canva and Nano Banana, sounds library, one time import of existing Higgsfield projects |
| 4 | Listen | Discovery, mentions, comments inbox, competitors |
| 5 | Head of content | The agent (own chat): fills the bank within budget, weekly brief, learns from approvals |
| 6 | Ads | Spark Ads, Meta ads, GMV Max through the MCPs |
| Later | | AI editor, YouTube, Business Messaging, ERP sales link, product links on TikTok when the API allows |

## 15. Still open

1. How many people are on the Google Workspace (decides how long Drive holds raw footage).
2. The exact tan from the ERP, and the other colors.
3. Who finishes TikTok drafts (adds Shop links): the agency or our team?
4. How many accounts per platform today.
5. Whether our own TikTok app gets licensed music access like Higgsfield has.
6. Which Canva plan autofill needs today.
7. Higgsfield music: confirm commercial use terms.
8. Meta API features to confirm against live docs (collabs, product tags, carousel size).
9. "Kafka": did you mean Higgsfield, Kling, or something else?
10. Names for the app and the agent.
11. ~~Bringing in existing Higgsfield work~~ Decided: a **one time import** of current Higgsfield projects through the Higgsfield connector into the app's library, during phase 3. After that, the team creates inside the app's Studio. The app copies every result into our own storage right away, since Higgsfield may keep files only for a limited time.
