Save everything between the START and END lines below, exactly as written, as CLAUDE.md in the top folder of this project. Then read it. This is our rulebook for the whole project.

----- START OF CLAUDE.md -----

# Noun Naturals Content System

Read this first, every session. Keep it current: when a real decision is made, update this file in the same commit.

## What this is
Noun Naturals' content system, separate from the Noun ERP (erp.incivera.ai). A web app, used mostly on phones, that runs the content calendar for our editing team in Ukraine:
- Weekly content calendar (week, day, type, format, platforms, status), replacing the Notion calendar (import it once with the Notion API).
- Editors upload finished videos straight to storage (never through our server), at full quality.
- We review in the app: comments pinned to a moment in the video, approve or request edits. Statuses: draft, sent for approval, needs edits, approved, scheduled, posted.
- Notices to the team by Gmail (later WhatsApp Business).
- Posting to TikTok, Instagram, Facebook, YouTube, only after the owner approves.
- Post numbers from each platform, tied to sales through the ERP.

## The owner
Khaled, owner of Noun Naturals, not a coder. He clicks Pull and Republish on Replit himself. He uses voice dictation: read for intent (team names: Steven, Kareem).
Writing to him: plain words, lead with the answer, short. No hyphens or em dashes in prose (code, file names and URLs are fine).

## Build order
1. Concept: agree on the idea, the screens and the flows with the owner. No code yet.
2. Design systems: Fable 5.2 designs several design system options as previews. The owner picks one.
3. Build every screen on the approved design system only.
4. Then the features, in this order: calendar, uploads, review and approval; Gmail notices, then WhatsApp; posting; post numbers tied to ERP sales.

## Design system (insanely important)
- Design work is done by Fable 5.2: it designs the design system options, the screens and every visual decision. Other agents only build what Fable designed and the owner approved.
- Look: frosted glass. Translucent cards with background blur, soft light, depth, rounded corners, generous spacing. Premium, calm, clean.
- Platforms always show as their own gradient card or pill in the platform's brand colors, with its real logo: TikTok, Instagram, Facebook, Meta, YouTube, Pinterest, Gmail, WhatsApp, Notion, Google Drive. Every tile and every channel gets its logo and its gradient, everywhere it appears, from one shared component.
- One source of truth: colors, gradients, blur, type, spacing, radius, shadows and motion live as design tokens; every screen uses them. No one off styles.
- Ease of use first: big clear actions, few steps, obvious status, nothing hidden behind menus that matters daily. Editors in Ukraine must understand it without training.
- Mobile first: design for the phone, then widen for desktop. Thumb friendly buttons (at least 44px), no sideways scrolling, fast on a phone connection. Installable as a web app (home screen icon, full screen).
- Every dropdown has a search bar. Light and dark mode both look finished.
- Nothing ships until it looks right on a phone. Show the owner screenshots on phone and desktop before asking for approval.

## How we work
- Fable 5.2 orchestrates: it plans each build, designs, and reviews the result. Opus 5.5, Sonnet 5.5 and Haiku 5.5 agents write the code, picked by difficulty.
- Before every push, a Sonnet 5.5 agent and a Haiku 5.5 agent each check the change for crashes on their own. Fix what they find, then push.
- Run the type check and tests before every commit. Never chain pull, add, commit and push in one command. Check for conflict markers before committing.
- Chats compact at 40% (a user setting on this computer). Never change it.
- Remember everything that matters: save each decision or rule the owner gives to memory, and keep docs/BUILT.md (everything built, one line each, with month and main files) and docs/DECISIONS.md (what we chose and why) current in the same commit as the change.

## Safety
- Never paste secrets, never enter passwords. Keys go in Replit Secrets, entered by the owner.
- This project has its own keys. Never use the ERP's keys (sharing breaks the ERP's TikTok sign in and widens what a leak can do). Meta: a separate system user with posting permissions only. TikTok: its own Content Posting app.
- Nothing is posted, sent or messaged without the owner's yes. Connecting an account or approving access is the owner's click.
- Big files never pass through the Replit server: browsers upload and download straight from storage with signed links (Replit charges for data sent).
- Team logins: editors see only their own work and comments. No customer data in this app.

## The ERP link
- Read sales, product and marketing numbers from the ERP's Claude connector, read only. Never change ERP data.
- This chat can message the ERP chat, but the ERP is the source of truth for money.

## Brand rules
- Noun's voice, logo and colors (add them here once chosen).
- TikTok bans QR codes, links and discount cards in boxes: use TikTok coupons instead.

## Open decisions (fill in as decided)
- Hosting: Replit. Database: (to decide). Video storage: Google Drive for masters plus a fast preview for review (to confirm).
- WhatsApp: needs a WhatsApp Business number; groups by API to be checked.
- TikTok public posting needs TikTok's review of our posting app; until then posts are private.

----- END OF CLAUDE.md -----

Once it is saved: Fable 5.2, we start with step 1 of the Build order, the concept. No code and no design yet. First ask me what you need to know about how our team in Ukraine works today (the Notion content calendar, Frame.io links, approvals, edits, posting), then propose the concept: the screens and the flows. When I approve the concept, design several design system options for me to pick from.
