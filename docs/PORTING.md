# How to build a screen in the real app

For any agent that moves a screen from the approved prototype into the real app. Read all of it before writing code.

## The goal
The screen must look and behave exactly like the approved prototype (concept 6, "Iris on Tan"), on phone and desktop, in light and dark. The owner approved that design; do not redesign anything. Where the prototype and this file disagree, ask in your report instead of guessing.

## Read first
1. `AGENTS.md` at the repo root. This Next.js (16.4) is newer than your training data. Check `node_modules/next/dist/docs/01-app` before using an API you are not sure of.
2. `CLAUDE.md` (what the product is, the safety rules, how to write to the owner).
3. `docs/MOBILE-PASS.md`: the findings for your screen and the "Rules the real build must follow" list at the end. Fix the findings that belong to your screen.
4. The part of `docs/CONCEPT.md` about your screen.

## Where things are
- Prototype source (reference only, never imported): `design/concepts/src` (`app.js` data and shell, `flows.js` review, raw clips, upload, `views.js` calendar views, `post.js` bank and schedule, `editor.js` editor views, `base.css`, `flows.css`).
- Prototype running: `http://localhost:5173/concept-6.html?x=1#<screen>.light` (or `.dark`). Only changing the `#hash` does not redraw: change the `?x=` number too.
- Real app running: `http://localhost:3000` (a dev server is already up; do not start or stop servers).
- Design system: `src/design` (`tokens.css`, `core.css`, `screens.css`, `app.css`, `Icon.tsx`, `Platform.tsx`, `ui.tsx`, `Brand.tsx`). The prototype's CSS is already in `screens.css`, so the class names you see in the prototype already work.
- Shared pieces you should use, not rebuild:
  - `Icon`, `IconSlot` (`src/design/Icon.tsx`); `Pf`, `PfPill` (`src/design/Platform.tsx`); `StatusPill`, `Pill`, `Tag`, `Bar`, `Toggle`, `Seg`, `Avatar`, `Score`, `Thumb` (`src/design/ui.tsx`)
  - `FilterChip` (chip that opens a searchable picker sheet), `Dropdown` (searchable), `SampleNote`, `PersonAvatar` (`src/components`)
  - `useShell()` from `src/components/shell/shell-context.ts`: `openSheet(content, { label, className })`, `closeSheet()`, `toast(message, icon)`
  - Sample people, accounts and cards: `src/lib/sample/people.ts`, `accounts.ts`, `cards.ts`
  - The list of screens and roles: `src/lib/nav.ts`

## The recipe
1. Open your screen in the prototype and read its source (`VIEW.<screen>` and the `ACT` handlers it uses). Capture the real markup with the browser's JavaScript tool (`document.querySelector('#view').innerHTML`) when the source is hard to follow.
2. Write React that outputs the same elements and the same class names. There is no Tailwind in this app (it overrode the design system class names); style only with the design system classes. Do not invent new class names when the prototype has one.
3. Put the screen's sample data in `src/lib/sample/<screen>.ts` with exported types, copied from the prototype's data. Mark it `TODO(database)`. The page (a server component) reads the sample data and passes it down as props, so a database query can replace it later without touching the components.
4. Interactive parts are client components (`"use client"`) in `src/components/<screen>/`. Keep `page.tsx` a server component with `export const metadata = { title: "..." }`.
5. Put `<SampleNote />` in the page header (the `.page-h` row), as Home does.

## Rules
- **Your files only.** Your brief lists the folders you own. Other agents are working in other folders at the same time. Never edit `src/design/tokens.css`, `core.css`, `screens.css`, `app.css`, `ui.tsx`, `Icon.tsx`, `src/components/shell`, `src/lib/nav.ts`, the shared sample files or another screen's folder. If you need a change there, work around it inside your own folder and list the request in your report.
- **Extra CSS** goes only in your screen's file, `src/design/screens/<screen>.css` (already imported). Tokens only: no hard coded colors, sizes that should be tokens, or one off shadows. Most screens need little or none.
- **Preview honesty.** Nothing is connected yet. Buttons change what is on screen (local state) so the owner can try the flow, but anything that would save, send, upload, post or message must say so: its toast starts with "Preview:" and nothing leaves the browser. Never fake a result as if it were real.
- **No secrets, no network calls**, no new npm packages, no git commands that change anything, no commits.
- **Next.js with cacheComponents:** no `new Date()`, `Date.now()` or `Math.random()` in a server component. In a dynamic route, `params` is a Promise (`const { id } = await params`) and the page needs `generateStaticParams` over the sample ids. Do not call `usePathname` outside a Suspense boundary on a dynamic route.
- **No `dangerouslySetInnerHTML`** with data. Icons come from `Icon`.
- **Phone first.** Every tap target at least 44px. No sideways page scroll at 360 wide. File pickers are a real `<label>` around `<input type="file">` (visually hidden, never `display:none`). The main action stays reachable (use the existing `sticky-cta` class as the prototype does). Use the right keyboard on fields (`type="search"`, `enterKeyHint`, `inputMode`).
- **Accessible:** every button and link has a name, toggles use `aria-pressed` or `role="switch"`, lists have keys, images have alt text.
- **Words on screen:** copy the prototype's wording. Plain words, no hyphens or em dashes in sentences.
- **Comments:** short, plain, saying why. Leave `TODO(database)`, `TODO(storage)` or `TODO(sign in)` where the real thing plugs in.

## Before you report
1. `npx tsc --noEmit` shows no error in your files (errors in other agents' folders are theirs).
2. `npx eslint <your folders>` is clean.
3. Do not run `next build` (three agents share one build folder). The orchestrator runs it.
4. Look at your screen in the browser, in your own new tab (never touch a tab you did not open): phone (375 wide) and desktop (1440 wide), light and dark, next to the prototype. Fix what differs. Reset the viewport and close your tab when done.

## Your report
- The files you wrote.
- What works, and what you did not build (be exact).
- Anything that differs from the prototype and why.
- Requests for changes to shared files.
- Which phone pass findings you fixed.

## Building something the prototype does not have
Some features were decided after the prototype (spaces, the week table from the content team's Notion, the Shot checkbox, directions on raw clips). For those there is no markup to copy, so:
- Build only from the design system. Reuse its classes and components (`card`, `btn`, `chip`, `seg`, `st` pills, `Pf` and `PfPill` for platforms, `sheet`, `notice`, `tbl`, `sticky-cta`, `Thumb`, `Score`, `PersonAvatar`, `FilterChip`, `Dropdown`). Look at how Calendar, Upload and Review use them and match that.
- New styles go only in your own file under `src/design/screens/` and use tokens only (`var(--sp-*)`, `var(--r-*)`, `var(--sh-*)`, `var(--ink*)`, `var(--surface*)`, `var(--accent)`, `var(--grad-*)`). No hex colors, no new shadows, no new font sizes. The only exception is a color the user picks (a status pill's paint), which is data.
- The look: warm tan canvas, soft raised cards, Iris purple for the main action, calm and roomy, high contrast text. Subtle depth on key controls only. Platforms always as their real logo. Nothing gray on gray.
- Phone first, then widen. The main action is one big button within thumb reach. Nothing that matters daily hides in a menu.
- The orchestrator (Fable 5.2) reviews your screenshots and may ask for layout changes. Describe your layout choices in the report.
- There is no Tailwind. Do not add packages.
