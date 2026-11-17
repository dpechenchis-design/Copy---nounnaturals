# Noun ART setup: what Khaled needs to do

This is the list of accounts to create and keys to enter. Claude cannot do these steps: every one is your own click, and no key ever goes into a chat.

Where a key goes:
- On Replit: Secrets (the lock icon). Name on the left, value on the right. The names are in `.env.example`.
- On this computer, for testing: a file named `.env.local` in the project folder, edited in Notepad. Git ignores it.

These are Noun ART's own accounts and keys. Nothing here is shared with the Noun ERP or the PLM.

## Today's state

The app runs in preview. It shows sample data and nobody is signed in. Each step below turns one real part on. You can do them in any order inside a phase, but Phase 1 comes first.

## Phase 1: replace Notion and Frame.io

### 1. GitHub and Replit (so you can Pull and Republish)
1. Done (Nov 14 2026): the private GitHub repository is `khalednoun/noun-art`, and this folder is connected to it.
2. In Replit, create a new app from that GitHub repository.
3. Replit runs it with `npm run build` and then `npm run start`.
4. After that, each time Claude pushes, you click Pull and then Republish in Replit.

### 2. The address art.incivera.ai
1. In Replit, open Deployments, then Domains, and add `art.incivera.ai`.
2. Replit shows two DNS records. Add them where incivera.ai is managed.
3. Wait until Replit shows the domain as verified.

### 3. Supabase (the database and sign in)
1. At supabase.com, create a new project named `noun-art`. Do not reuse the ERP or PLM project.
2. In the `noun-art` project click the green Connect button at the top (or open Project Settings, then API Keys). There is one Supabase project for everything, like the ERP, so the first two values go in every place the app runs: Replit Secrets (the lock icon), the published app's secrets, and the file `.env.local` on your computer for testing on localhost. Sign in is the real thing everywhere; content is not shared: the published app shows the real content, and a run on localhost or in the Replit workspace shows demo data only. Do not use Replit's own built in database for this app; if Replit offers to add one, say no. On Replit, click Republish after entering them: the app reads these two when it is built, so an app published before the keys were entered keeps running as the sample preview with no sign in. The values:
   - Project URL goes in `NEXT_PUBLIC_SUPABASE_URL`
   - The anon (publishable) key goes in `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - The service role (secret) key goes in `SUPABASE_SERVICE_ROLE_KEY`. This one is a master key. It goes in Replit Secrets only, never in `.env.local`. Since Nov 15 2026 the published app uses it to save the TikTok, Instagram and Facebook accounts and their sign in tokens (docs/CONNECT-SOCIAL.md). Since Nov 16 2026 it also lets the owner undo an approval on Review, notes each edited video's file size, and records the Drive folders made for raw clips.
3. The tables are created by Supabase itself from GitHub (the file is in `supabase/migrations`). To see that it worked: in Supabase open Table Editor; you should see 79 tables, for example `cards`, `weeks` and `spaces`. If the list is empty, open Project Settings, then Integrations, then GitHub, check that "Deploy to production" is on and the branch is `main`, and tell Claude. Do not enter the Supabase keys anywhere before the tables exist.

### 4. Google sign in
1. In Google Cloud Console, create a project named `Noun ART`.
2. Set up the OAuth consent screen (Google now calls it Google Auth Platform, then Audience) as External, because the editing team signs in with emails outside nounnaturals.com. External does not let strangers into the app: Google only proves who someone is, and the app lets in only people an owner or admin invited. While the screen is in Testing, only addresses you add as test users can sign in; press Publish app when the team is ready to join.
3. Create an OAuth client of type Web application. Under "Authorized redirect URIs" paste this address: `https://gbkxpykbrsygguljevli.supabase.co/auth/v1/callback` (it is also shown in Supabase under Authentication, then Sign In / Providers, then Google).
4. Paste the client ID and client secret into that same Supabase page. They do not go in Replit.
5. On that same Providers page, switch Email off and leave only Google on. The app only lets Google sign ins in, and with Email off nobody can even try another way.
6. Tell Supabase which addresses it may send people back to after Google. In the `noun-art` project open Authentication, then URL Configuration. Set Site URL to `https://art.incivera.ai`. Under Redirect URLs add all three: `https://art.incivera.ai/auth/callback**` (the published app), `https://noun-art.replit.app/auth/callback**` (the same app on its Replit address, for testing on Replit) and `http://localhost:3000/auth/callback**` (testing on this computer). Done on Nov 15 2026. The two stars at the end matter: the app adds a note to that address saying which page the person was headed to, and the stars let Supabase accept it. Without this, Google sign in ends on an error page or on the wrong address.
7. To test: open the app, press Continue with Google, and pick your work account. You should land back in the app. Someone who was not invited sees "An owner or admin has to let you in" and a Sign out button, and nothing else.

### 5. Google Drive (raw footage)
Done Nov 16 2026: the shared drive is `Noun ART (Content System)` (Drive id 0ADFeg6ttIxarUk9PVA) and the Google Drive API card is Healthy. The steps, for the record:
1. In Drive, create a Shared Drive named `Noun ART (Content System)`.
2. In the same Google Cloud project, turn on the Google Drive API and create a service account.
3. Add the service account's email to the Shared Drive as Content manager.
4. Create a JSON key for the service account. From that file, put the email in `GOOGLE_SERVICE_ACCOUNT_EMAIL` and the private key in `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`.
5. Open the Shared Drive in the browser. The long code at the end of the address goes in `GOOGLE_DRIVE_SHARED_DRIVE_ID`.
6. Enter the three keys in Replit Secrets (the published app) and Republish. Paste the whole private_key value, from BEGIN to END.
7. Check it: Settings, Integrations, the Google Drive API card should say Connected after Refresh, and its "Shared drive" line should say `Noun ART (Content System)` with "matches". Another name there means GOOGLE_DRIVE_SHARED_DRIVE_ID points at another drive (or the drive was renamed). If it says the service account cannot see the shared drive, add it to the shared drive again. Then upload one raw clip from Upload, on a computer and on a phone.
8. How it works: the browser sends each raw clip straight to Google Drive on a one file link our server opens (the file never passes through Replit). Everything goes through the company's service account: nobody's own Google is used, and the Google card never asks anyone for Drive. A test run (localhost) never talks to Drive.
9. Let the team open the clips: in Google Drive, open the shared drive Noun ART (Content System), Manage members, and add the Ukraine team and admins as Viewers (Content manager for anyone who should move or rename files). Without this, Open in Drive tells an editor they need access.

### 6. Cloudflare R2 (edited videos)
1. In Cloudflare, open R2 and create a bucket named `noun-art`. Leave it private (no public access).
2. Create an API token for R2 (R2, Manage API tokens, Create API token) with "Object Read & Write" on that bucket only. Cloudflare then shows an Access Key ID and a Secret Access Key once: keep that page open for the next step.
3. In Replit Secrets (the published app), enter `R2_ACCOUNT_ID` (the account id shown on the R2 page), `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_BUCKET` (`noun-art`). Republish.
4. Let browsers upload to the bucket. Open the bucket, Settings, CORS policy, Add CORS policy, and paste exactly this:

```json
[
  {
    "AllowedOrigins": ["https://art.incivera.ai", "https://noun-art.replit.app", "http://localhost:3000"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["Content-Type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

   Without this rule every upload stops with "The connection dropped". `ETag` must be exposed: a video over 5 GB goes up in parts and the app reads each part's ETag.
5. Check it: Settings, Integrations, the Cloudflare R2 card should say Connected after Refresh. Then upload one edited video from a row of a week.
5b. On the bucket, Settings, Object lifecycle rules, add one rule: abort incomplete multipart uploads after 7 days. A big upload that is never finished then stops costing money.
6. Needed for TikTok posting only: on the bucket, Settings, turn on the Public Development URL. Put that address (like `https://pub-<hash>.r2.dev`, no path) in Replit Secrets as `R2_PUBLIC_BASE_URL`, in the workspace and in Deployments, then Pull and Republish. Then Settings, Integrations, TikTok, Video address, press Verify (see docs/CONNECT-SOCIAL.md). Team playback in the app always uses private signed links; the public address is only for TikTok's one download per post. The risk: a public address never expires and covers every file in the bucket, including unapproved edits and older versions. Anyone with a file's exact address can open it. There is no listing, and the names carry long random parts, so they cannot be guessed. Cloudflare calls r2.dev a development address and may rate limit it; if that ever throttles TikTok, we move to a custom domain later. No DNS record is needed.

How it works: the browser sends each edited video straight to R2 with a signed link from our server (the file never passes through Replit), then the app saves it as a new version on its card. A test run (localhost) never calls R2 and never saves: it keeps its pretend uploader.

### 6c. Frame.io (the one time move of the agency's edits)
Needs R2 (section 6) working first. Details: docs/FRAMEIO-IMPORT.md.
1. Ask the agency to add your Adobe login to their Frame.io workspace with download rights. Their Frame.io account must use Adobe sign in.
2. At developer.adobe.com/console, create a new project (Noun ART). Add API, pick Frame.io API, choose User Authentication, then OAuth Web App.
3. Default redirect URI: `https://art.incivera.ai/connect/frameio/callback`. Redirect URI pattern (periods escaped, comma between): `https://art\.incivera\.ai/connect/frameio/callback,https://noun-art\.replit\.app/connect/frameio/callback`. Localhost is not added: Adobe needs https, so connect on the published app or the Replit address.
4. Scopes: `openid`, `email`, `profile`, `offline_access`, `additional_info.roles`.
5. Copy the Client ID into `FRAMEIO_CLIENT_ID` and the Client Secret into `FRAMEIO_CLIENT_SECRET` in Replit Secrets. `TOKEN_ENCRYPTION_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are already there. Republish.
6. After the Frame.io database draft is approved and live: Settings, Integrations, Frame.io, Connect Frame.io, sign in with that Adobe login. The card then says Connected.

### 7. Telegram (notices)
1. In Telegram, message @BotFather and send `/newbot`. Name it Noun ART.
2. Put the token it gives you in `TELEGRAM_BOT_TOKEN`.
3. Make up a long random phrase and put it in `TELEGRAM_WEBHOOK_SECRET`.
4. Set the bot's picture to the Noun ART icon (`design/brand/noun-art/icon/icon-512.png`).

### 8. Gemini (reads the videos)
1. At aistudio.google.com, create an API key in the Noun ART Google Cloud project.
2. Put it in `GEMINI_API_KEY` (Replit Secrets and `.env.local`). Done Nov 15 2026.
3. Then set up the reader on Google Cloud, next section.

### 8b. Gemini reader on Google Cloud
The reader is a small job, `art-reader`, that runs on our own Google Cloud (project noun-art). For every new video it reads the sound only (Gemini Transcribe), writes a title and a summary and finds the card (Gemini Hydrogen), and files it in the shared drive. It never watches the picture and the video never passes through Replit. Replit cannot run background jobs, so this part lives on Google Cloud. Uploads never wait for it: without the reader, files still upload and wait in New uploads.

Your clicks, in order:
1. Billing on. Google Cloud console, project noun-art, Billing: link a billing account. Cloud Run needs it. The cost is small (a few dollars a month at 30 videos a day), not zero.
2. The Gemini key on the paid tier. At aistudio.google.com, API keys: the key in `GEMINI_API_KEY` must show the paid tier (Set up billing, on the same project). On the free tier Google may use what it hears to train its models, and the limits are too low.
3. Run the setup script once. In the Google Cloud console press the Cloud Shell button (top right, the `>_` icon). Open `worker/setup.sh` in the GitHub repo, copy all of it, paste it into Cloud Shell and press Enter. It turns on Cloud Run, Cloud Build, Artifact Registry, Secret Manager and Cloud Scheduler, builds the reader, makes the job `art-reader`, sets it to check every 5 minutes, and lets our service account start it. When it asks, paste the Supabase service role key and the Gemini key yourself, straight into Cloud Shell (never into a chat). At the end it prints the job name and its region.
4. In Replit Secrets (the published app), add `ART_READER_JOB` (the job name it printed, `art-reader`) and `ART_READER_REGION` (the region it printed, for example `us-central1`). `SUPABASE_SERVICE_ROLE_KEY` must be there too. Republish.
5. Check it: Settings, Integrations, the Gemini reader card. "Waiting for the reader to be set up" means it has not checked in yet; after the first run (within 5 minutes) it says Connected with its last check in. Then upload one short video with talking and watch its title appear in Upload/Files.
6. Updates by themselves (done Nov 17 2026, once): in Cloud Shell run `bash noun-art/worker/auto-update-setup.sh`. It prints a GitHub link: sign in to GitHub as khalednoun (the repo's owner) and install Google Cloud Build on khalednoun/noun-art only. From then on every push to main that changes `worker/` or `src/lib/` rebuilds the reader and updates the job by itself (trigger `art-reader-update`, `worker/cloudbuild-deploy.yaml`, about 3 minutes). Branches and forks never deploy, so Daryna's work changes nothing until it is merged. A failed build leaves the reader as it was. Nobody needs Cloud Shell for an update; it is only for changing a key (run `worker/setup.sh` again).
7. Optional, recommended: a $20 budget alert. Google Cloud console, Billing, Budgets and alerts, Create budget, $20 a month for project noun-art, email alerts at 50%, 90% and 100%. It only warns; the daily limit in the app is what stops the spending.

What it may spend: Settings, AI costs shows today and this month by model, against the daily limit ($5 to start). Only the owner changes the limit there. When it is reached, the reader stops for the day and files wait.

## Phase 2: posting

### 9. TikTok
Full steps: docs/CONNECT-SOCIAL.md. In short: Noun ART is approved at TikTok API for Business (docs/TIKTOK.md). Put `TIKTOK_BUSINESS_APP_ID`, `TIKTOK_BUSINESS_APP_SECRET`, `TOKEN_ENCRYPTION_KEY` and `SUPABASE_SERVICE_ROLE_KEY` in Replit Secrets (workspace and Deployments), make `https://art.incivera.ai/connect/tiktok/callback/` the active return address (it ends with a slash; TikTok refuses localhost), and turn on the Public Development URL on the R2 bucket, put it in `R2_PUBLIC_BASE_URL`, then press Verify under Video address on the TikTok Integrations card (no DNS record). Posting also needs `POSTING_RUN_SECRET` and the Meta posting database draft live.

### 10. Meta (Instagram and Facebook)
Full steps: docs/CONNECT-SOCIAL.md. In short: a new Business app Noun ART and a system user (Employee) with content permissions only on our Pages and Instagram accounts; `META_APP_ID`, `META_APP_SECRET` and `META_SYSTEM_USER_TOKEN` in Replit Secrets (and `.env.local` to check it on this computer). Then Add each account on the Integrations page.

## Phase 3: the Studio and the agents

### 11. Higgsfield
Full steps: docs/CONNECT-SOCIAL.md. A key from console.higgsfield.ai: the key ID in `HIGGSFIELD_API_KEY`, the secret in `HIGGSFIELD_API_SECRET`. Add prepaid credit there and watch the balance there.

### 12. Claude
1. At console.anthropic.com, create an API key for Noun ART and set a monthly spend limit.
2. Enter `ANTHROPIC_API_KEY`.

### 13. Canva
1. At canva.com/developers, create a Connect integration for Noun ART.
2. Enter `CANVA_CLIENT_ID` and `CANVA_CLIENT_SECRET`.

## Rules that never change
- Connecting an account or approving access is always your click.
- Nothing is posted, sent or messaged without your yes.
- If a key was ever pasted somewhere it should not be, replace it at the provider and enter the new one.

## Refunnel (UGC)

`REFUNNEL_API_KEY`: a Refunnel brand key (Settings, Developer, read only). Enter it in Replit Secrets and in `.env.local` on this computer. It stays on the server and turns on live posts in the UGC tab; without it the tab shows sample data.


## Gmail invites (and the Drive API)

Invites are emailed from the inviter's own Gmail. Steps, in order, all done by the owner:

1. Google Cloud, project Noun ART, APIs and Services, Library: turn on Gmail API, then Google Drive API.
2. Google Auth Platform, Data access, Add scopes: gmail.send. Save.
3. Google Auth Platform, Audience: press Publish app (decided Nov 15, so Gmail stays connected; the people who connect Gmail see a one time "unverified app" notice).
4. Google Auth Platform, Clients: open the Web client Supabase uses, copy its Client ID and secret into Replit Secrets (workspace and published app) as GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET. Add TOKEN_ENCRYPTION_KEY: run `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` once in the Replit Shell and paste the result. Never the ERP's values.
5. Supabase, Authentication, URL Configuration: Redirect URLs include https://art.incivera.ai/**, https://noun-art.replit.app/** and http://localhost:3000/**.
6. Database update: done (approved Nov 15 2026, supabase/migrations/20261115120000_gmail_invites.sql).
7. Pull and Republish.
8. In the published app: Settings, Integrations, Gmail, Connect, and tick the send box on Google's screen. Steven and David do the same once.
9. Invite one of your own other addresses to check it arrives.

### Connect your Google again (people search, Nov 15 2026)

One Google button now connects everything Noun ART uses your Google for (the list is src/lib/google/uses.ts): Gmail (invites from your own address) and Contacts (names pop up as you type an email in the invite Who box). Drive is listed too, but it goes through the company account (the Google Drive API card), so it is never asked for and never needs Connect again.
- Google Cloud is done: the People API is on, and contacts.readonly, contacts.other.readonly and directory.readonly are saved under Google Auth Platform, Data access, next to gmail.send. Nothing is left to do there.
- The owner, Steven and David each connect again once, in the published app: Settings, Integrations, Google, Connect again (or the Connect again button on Home). Google opens in a new tab; tick every box on Google's screen. The tab closes itself and the invite box starts suggesting people.
- Google shows its warning screen again for the new permissions (the app is not verified). Only the owner and admins connect, so the 100 user cap does not matter.
- Directory search finds people only for nounnaturals.com accounts; for any other account that source is quietly empty.
- Nothing about the people found is saved anywhere. The privacy page says so.
- A new Google use later is one entry in src/lib/google/uses.ts: it is asked for on the Connect step, listed on the Google card and on Home, and everyone sees "New Google feature added" until they connect again.
