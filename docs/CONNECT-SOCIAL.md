# Connecting TikTok, Meta and Higgsfield: your steps

Every step here is your own click. Never paste a key in a chat. Keys go in Replit Secrets (the lock icon: name on the left, value on the right), in both the workspace and the published app (Deployments, Secrets). These are Noun ART's own apps and keys, never the ERP's: sharing the ERP's TikTok app breaks the ERP's TikTok sign in.

## TikTok (TikTok API for Business, built Nov 17 2026)

### The honest picture first
- Noun ART is approved at business-api.tiktok.com. It is a TikTok API for Business app, made for a brand posting to its own accounts. Posts are public from the first one.
- The connector and the posting are built on a branch and not pushed yet, so the steps below are the plan for when it is. Nothing has been tested with a real account.
- TikTok only accepts return addresses that start with https, and keeps one active at a time. So `http://localhost:3000` is impossible: you connect TikTok on `https://art.incivera.ai` (active) or on `https://noun-art.replit.app` (listed, switched on only for a test on Replit).

### Your steps
1. In Replit Secrets (workspace and Deployments, Secrets) add:
   - `TIKTOK_BUSINESS_APP_ID` (TikTok API for Business, My Apps, Noun ART, App Detail, Basic Information)
   - `TIKTOK_BUSINESS_APP_SECRET` (same page)
   - `TOKEN_ENCRYPTION_KEY` (already there for Gmail; the TikTok tokens are sealed with it)
   - `SUPABASE_SERVICE_ROLE_KEY` (Supabase, `noun-art`, Project Settings, API Keys, the secret key; Replit Secrets only)
2. At TikTok, on the app's page, the account holder redirect addresses are, each ending with a slash:
   - `https://art.incivera.ai/connect/tiktok/callback/` (active)
   - `https://noun-art.replit.app/connect/tiktok/callback/` (listed)
3. Pull and Republish when Claude says the build is pushed.
4. Settings, Integrations, TikTok, Connect TikTok. Log in and press Authorize. The account shows under its username.
5. For every other account: switch to that account in TikTok first (or sign out of TikTok), then press "Add another TikTok account". It never replaces an account that is already there. If the account is already connected, the app says so plainly and adds nothing. Each account joins the posting permissions channel list by itself.
6. Accounts that were connected with the old TikTok app show "Connected with the old TikTok app". Press Reconnect: the same row is kept, with its posting permissions.

### The Video address (needed before anything posts)
TikTok pulls each video from our storage address and only trusts an address it has verified. It checks the address as a prefix on R2's own public address, so there is no DNS record and no media.incivera.ai.
1. In Cloudflare, on the R2 bucket, Settings, turn on the Public Development URL.
2. Put that address (like `https://pub-<hash>.r2.dev`, no path) in Replit Secrets as `R2_PUBLIC_BASE_URL`, in the workspace and in Deployments. Pull and Republish.
3. Settings, Integrations, TikTok, Video address, press Verify. One press: the app adds the address at TikTok, puts TikTok's check file in the bucket and asks TikTok to check. Nothing is stored; the app asks TikTok each time. The status says one of:
   - Verified: done.
   - Not verified yet: TikTok has the address but has not read the check file.
   - Not verified: TikTok's check failed. Press Verify again.
   - Not added yet: press Verify.
   - No answer: TikTok did not answer. Try later.
4. Verify puts one small .txt check file at the bucket root. Never delete it. `R2_PUBLIC_BASE_URL` is the bare r2.dev address, no path, in both the workspace and Deployments.
5. Team playback in the app always uses private signed links. The public address is only for TikTok's one download per post.
Risk: a public address never expires and covers every file in the bucket, including unapproved edits and older versions. Anyone with a file's exact address can open it. There is no listing, and the names carry long random parts, so they cannot be guessed. Not yet verified: whether TikTok accepts an r2.dev address. The first Verify shows it. If r2.dev ever throttles (Cloudflare calls it a development address), we move to a custom domain later.

### For posting
- `POSTING_RUN_SECRET` in Replit Secrets (the same one as for Meta, below).
- The Meta posting database draft approved and live (the switch and the run's lease). TikTok posting shares them. Until it is live, Schedule stays grayed "Being connected" for TikTok.
- Every post is public. The first tests go to a throwaway TikTok account, never a Noun account (docs/TIKTOK.md has the test steps).

## Meta: Instagram and Facebook (checked against Meta's developer pages on Nov 15 2026)

### The honest picture first
- Meta needs no extra review for this setup. Our app only posts to Noun's own Pages and Instagram accounts through a system user that belongs to the same business as the app, and Meta gives business apps "Standard Access" for that automatically, so no App Review should be needed. One Meta page says a review may still be asked for; if the token screen refuses a permission in step 6, tell Claude and we prepare the review.
- No return addresses are needed: there is no "Log in with Facebook" screen. You make one token by hand, and it works on localhost too.
- Each Instagram account must be a professional account (Business or Creator) linked to a Facebook Page.

### Steps tonight
1. Open developers.facebook.com, My Apps, Create app. Name: `Noun ART`. Type: Business. Business portfolio: Noun Naturals. Never reuse or edit the ERP's Meta app.
2. In the new app, add the use cases (or products) for managing a Page's content and for Instagram content publishing. Under App settings, Basic, set Privacy Policy URL `https://art.incivera.ai/privacy`, Terms URL `https://art.incivera.ai/terms`, and the Noun ART icon (`design/brand/noun-art/icon/icon-512.png`). Save.
3. Open business.facebook.com, Settings (Business settings), Users, System users, Add. Name: `Noun ART poster`. Role: Employee (not Admin).
4. Select that system user, Assign assets:
   - Pages: each Noun Facebook Page we post to, with only the content permission (create and manage content). Nothing for ads, messages or money.
   - Instagram accounts: each Noun Instagram account, content only.
   - Apps: Noun ART.
5. Still on the system user, Generate new token. App: Noun ART. Expiration: Never (simplest; Meta also offers 60 days, which would need renewing).
6. Tick only these permissions: `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`, `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `read_insights`. Generate, and copy the token (Meta shows it once).
7. Back on developers.facebook.com, the Noun ART app, App settings, Basic: copy the App ID and the App secret (Show).
8. In Replit Secrets add `META_APP_ID`, `META_APP_SECRET` and `META_SYSTEM_USER_TOKEN`. Add the same three to `.env.local` on this computer to check it there: a test run only reads (it lists the accounts and checks the token), it never posts or saves.
9. After Pull and Republish: Settings, Integrations, Instagram (or Facebook). The accounts the token can reach are listed by username. Press Add on each one we post to. They then show in everyone's posting permissions.

### For posting (Nov 16 2026, the full plan is docs/META.md)
- Nothing new in the key: it already has every posting permission. No App Review.
- On developers.facebook.com, if the Noun ART app says "App Mode: Development", switch it to Live.
- Each account we post to (Noun Naturals, Khaled Wins, any later one) is professional, linked to a Facebook Page, in Noun's Business portfolio and given to Noun ART poster with content only (docs/META.md section 2).
- When the posting screens are pushed, Claude gives you one more secret, `POSTING_RUN_SECRET`: the same value goes in Replit Secrets and in Supabase Vault (name `posting_run_secret`), so the every minute posting run can start. Until then nothing posts.

## Higgsfield (checked against Higgsfield's docs on Nov 15 2026)

### The honest picture first
- No review or approval: a key works as soon as it is made. Every video it makes is paid from the prepaid balance, so the key stays on our server only, and the app never starts a paid job from a test run (localhost or the Replit workspace).
- Higgsfield has no "check my balance" call in its API today, so the card checks that the key is accepted, and you watch the balance in Higgsfield's console.

### Steps tonight
1. Open console.higgsfield.ai (cloud.higgsfield.ai now leads to open.higgsfield.ai) and sign in with the Noun account. Add prepaid credit.
2. API keys, Create key, name it `Noun ART`. It shows two values: a key ID and a secret. The secret is shown once.
3. In Replit Secrets add `HIGGSFIELD_API_KEY` (the key ID) and `HIGGSFIELD_API_SECRET` (the secret). To see the card turn green on this computer, add them to `.env.local` too.
4. After Pull and Republish: Settings, Integrations, Higgsfield shows Connected.
