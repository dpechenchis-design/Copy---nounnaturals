# Mobile pass: Bank, schedule sheet and Posting (Meta posting design)

Done on the approved prototype (`design/concepts/concept-6.html`, source `design/concepts/src/post.js` and `post.css`) at 390 and 360 wide, light and dark, in headless Chromium (touch, mobile emulation). States: #bank.light.form.trial, .instagram.trial, .instagram, .facebook, .confirm.trial, .perm, .connecting, #posting.light.queue (and .strat), plus dark. Numbers are getBoundingClientRect and computed styles. No code changed. The real app uses the same class names in `src/design`.

Rules checked: docs/MOBILE-PASS.md "Rules the real build must follow". Findings from the first mobile pass that still apply (inputs 15.5px, text under 12px, safe area top and sides) are repeated only where they hit these screens.

## Must fix

| # | State | What is wrong (measured) | Class / element | Fix |
|---|---|---|---|---|
| 1 | posting queue, "Finish in TikTok" row (390 and 360, light and dark) | The row is broken. The button "Send to the TikTok app" is 203 px wide in `.qact` beside the text, so the text column is 53 px at 390 and 23 px at 360. The title shows "S...", the account pill and the time wrap one word per line, "Approved by Khaled" breaks into three lines. | `.qrow` with `.qact` holding a long label | Stack long actions under the text on a phone. In `post.css`: `@media(max-width:600px){.qrow{flex-wrap:wrap}.qrow .qact{flex-basis:100%;order:3}.qrow .qact .btn{width:100%}}` (or put the button inside the `.grow` column for the `finish` state, full width, 44 px tall). Rule: a `.qact` wider than 120 px goes under the text, never beside it. |
| 2 | schedule sheet, confirm step (#bank.confirm.trial, 360) | "Yes, schedule 3 posts" is the last element of a 1090 px sheet in a 726 px window. It sits at y 1130, so the owner must scroll past all three rows and the warning to reach it. It is not in a sticky bar. | `.btn.primary.block.lg.mt-3` in the confirm step | Put it in the same sticky footer the form step uses: `<div class="schfoot">` holding the primary button (its safe area padding is already in `.schfoot`). Keep "Change something" at the top. Then the main action is always at the bottom edge. |
| 3 | schedule sheet form (all form states) | The caption textarea is 15.5px (`textarea.prompt`). iPhone Safari zooms the page on tap. The `@username` collab input is 16px but has no `type`, `inputmode` or `autocorrect`. | `.prompt` (caption), the collab `.field input` | `input,textarea,select{font-size:16px}` as in MOBILE-PASS finding 3. Collab field: `autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="done"`. Caption: normal text and spellcheck. Never `maximum-scale`. |
| 4 | schedule sheet and queue, amber text (light) | Amber text on white measures 3.65:1 at 13.5px: "1 left out" under the item count, "Not sure yet that Instagram allows a collab on a trial reel...". Fails 4.5:1. Dark mode passes. | `--warn` used as a text color (`.warnc`, footer `small`, bold lines) | Keep `--warn` for fills and borders. Add `--warn-ink:#7F5A10` (about 6:1 on white and on the tan canvas) in the light block of `tokens.css` and use it for every warn colored text. Dark keeps today's value. |
| 5 | queue rows with a side button: Failed, Scheduled, Posted (360, and Posted at 390) | The side button squeezes the text column to 109 to 157 px (Posted rows at 390: 139 px, because "Numbers" takes 117 px). Titles are cut ("Hook C: Foam is no...", "Myth bust: I'm too you...") and usernames are cut inside the account pill (`@khaled.no...`, `@nounnatu...`). Editors recognise a post by its title and the team runs many accounts, so a cut title or username invites a wrong tap. | `.qrow b.sm.clip`, `pfpill`, `.qact` | (a) Title wraps to two lines: `.qrow b.clip{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}` (the existing `.clip2`). (b) Account pill never cuts: `.pfpill{max-width:100%}` with no ellipsis on its label; it already sits on its own wrapped line. (c) Under 400 wide, put Retry, Move and Numbers under the text like fix 1. Usernames are never cut by an ellipsis anywhere in the real build. |

## Should fix

| # | State | What is wrong (measured) | Class / element | Fix |
|---|---|---|---|---|
| 6 | Bank tiles and list (behind the sheet) | "Approved by Khaled · Nov 13, 4:10 pm" needs 224 px and gets 104 px at 360 (119 at 390): it reads "Approved by Kha...". Our rule is that approved videos always show who approved them. | `small.mut.clip` in `.bkt` and `.bkr` | `small.mut.clip{white-space:normal;overflow:visible;text-overflow:clip;line-height:1.3}` for approval lines. In tiles show "Khaled · Nov 13" if two lines are too tall; the list row and the confirm step show the full line. The confirm step already fits on one line at 360. |
| 7 | queue, Failed and Posting now rows | "Approved by Khaled" wraps to two lines at 360 (text column 109 px). Readable but tall. | `.qrow small.mut` | Solved by fix 5c. |
| 8 | week by account (#posting.light.week, not in the list but part of Posting) | `.slotc` post cells are 96 x 41 px, under 44. Their text is 11px. The grid (916 px) scrolls sideways inside `.wk.xscroll` on purpose, but with no edge hint, and the 150 px account column scrolls away, so the account is lost when looking at Friday. Drag does not exist on touch. | `.slotc`, `.slotc b/small`, `.wkr`, `.wka` | `.slotc{min-height:44px}`, `.slotc b,.slotc small{font-size:12px}`. Sticky first column: `.wka{position:sticky;left:0;z-index:1;background:var(--well)}`. Edge fade: `.wk{mask-image:linear-gradient(90deg,#000 calc(100% - 24px),transparent)}`. Start scrolled to today's column. On touch, a tap on a post opens a sheet with day and time chips (Move). |
| 9 | schedule sheet, cover frames | Frame time labels are 11px white on the frame (0:00, 0:05 ...). Real frames can be bright. Each frame is 64 x 114, big enough to tap. | `.thumb` in the cover row | 12px and a bottom scrim (`linear-gradient(transparent,rgba(0,0,0,.6))` behind the label). The row scrolls sideways on purpose: add the edge fade and `scrollIntoView({inline:'center'})` for the selected frame. |
| 10 | Bank tiles, nav | "1 day in bank" pill is 11px, nav badge 10px, "More" label 11px (first pass). | `.c-bl.gl`, `.nav-i`, `.nav-i .badge` | 12px floor. |
| 11 | Bank, connecting state (#bank.connecting) | The floating selection bar (`.selbar`, y 612 to 684) lands on the Grid/List switch and the filter chips, and "2 selected" wraps in a 72 px column with "Being connected" under it. Schedule is correctly grayed and 44 px tall. | `.selbar` | Keep room for it: while something is selected add `padding-bottom:96px` to the bank list. Make the bar a row: count (`white-space:nowrap`), Clear, Schedule. "Being connected" stays in the page banner (already there). |
| 12 | schedule sheet, When rows | At 390 the account name in a time row is cut ("@nounnat...") because the time chips take the room, and at 360 "Noun Na..." is partly under the sticky header while scrolling. | account label in the When list | Put the account pill on its own line above its time chips (`flex-wrap:wrap`, `flex:1 1 100%` on the label). |
| 13 | all sheets | `overscroll-behavior` is `auto`, so a flick at the end of the sheet moves the page. The page behind is already locked (body `overflow:hidden`, good). | `.sheet` | `.sheet{overscroll-behavior:contain}`. |

## Nice

| # | State | Note | Fix |
|---|---|---|---|
| 14 | schedule sheet | The sheet is 726 px tall (86dvh). The sticky header (about 100 px) and the footer (84 px) leave about 540 px for the form on an 844 px phone, and about 440 px on an iPhone SE. Fine, but the two line subtitle costs space. | Hide the subtitle once the sheet is scrolled (`.panel-h p{display:none}` when `scrollTop>8`). |
| 15 | queue | The filter tags (Posting now, Needs a check ...) wrap to three lines at 360 and are not buttons. If they become filters they must be 44 px tall. | If they filter, use `.chip`; if they only count, keep as is. |

## Checked and fine

- No sideways page scroll in any of the states at 390 or 360 (scrollWidth equals the viewport). Only the intended scrollers exist (`.wk`, the cover row).
- Tap targets in the sheet at 360 and 390: every button, chip, toggle (44 x 44), segmented tab (Reel and Trial reel 140 x 44, Instagram and Facebook 129 x 44), radio option (294 x 75 and up), Add (96 x 48), collab chip (164 x 44) and the account chooser `.acct` (all 44 tall, 138 to 164 wide) are 44 px or more. Cover frames are 64 x 114. The collab chip's remove cross sits inside its 164 x 44 button.
- Main action: "Schedule 3 posts" is sticky (`.schfoot`, 58 px button, 235 wide, safe area in its padding) and stays reachable while the form scrolls, in light and dark.
- Queue buttons: Open (196 x 44, 189 x 44), It is posted (130 x 44), It is not posted (155 x 44), Retry (94 x 44) and Open the live post (109 to 125 x 44) all pass. In Needs a check the three buttons stack one per line at both widths and do not crowd each other. The non admin view (.strat) hides the two settle buttons and shows "Only the owner and admins can settle this."
- "Approved by ... Nov 13, 9:02 am" lines in the confirm step fit on one line at 360.
- Sheet scroll: the page behind is locked while a sheet is open, header and footer stay put.
- Dark mode: no text below 4.5:1 found in the queue, the sheet or the confirm step. White text on the gradient account pills reads well in both themes. The gold "AI draft" tag is dark text on gold and reads well.
- "You cannot post to these" rows keep a lock icon and words (Reconnect needed, Not posting yet), so they do not rely on color alone.

## Build rules to add for these screens

1. Any row action wider than 120 px goes under the text on screens under 600 wide.
2. Titles, usernames and "who approved" lines wrap or clamp to two lines, never one line with an ellipsis.
3. Amber text uses `--warn-ink`, not `--warn`.
4. The confirm step of the schedule sheet uses the same sticky `.schfoot` as the form.
5. On touch, every drag action has a tap alternative (Move opens a sheet with day and time chips).
