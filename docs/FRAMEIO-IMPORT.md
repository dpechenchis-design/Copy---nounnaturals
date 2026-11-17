# Bring in from Frame.io (Nov 16 2026)

The one time move of the agency's finished edits from Frame.io into Noun ART. Each card the Notion import gave a Frame.io link becomes that card's v1, in full quality, waiting in Review. Week 1 (70 cards) and Week 2 (14 cards) of the Noun Naturals space carry a link: 84 videos.

**How (owner, Nov 16 2026): the official Frame.io V4 API only**, signed in with the owner's own Adobe login. Never the share page's private (GraphQL) service. No video byte passes through our server.

## The flow
1. **Connect once.** Settings, Integrations, Frame.io, Connect Frame.io (needs integrations.manage). Adobe's sign in opens, the owner signs in with the Adobe login the agency added to its Frame.io workspace, and Adobe sends him back to `/connect/frameio/callback`. Only on `https://art.incivera.ai` or `https://noun-art.replit.app`: Adobe needs https, so localhost cannot connect (the same exception as TikTok).
2. **Open the sheet** from the week page's pill (the screen: `src/components/edits/FrameioImport.tsx`). It lists every title with a Frame.io link (`listFrameioImport`), grouped by week; a title that already has a version says so and is never moved again.
3. **Per title**, the browser asks our server `resolveFrameioEdit(cardId)`. The server reads the link from the card itself (never from the browser), finds the one file behind it, and answers Frame.io's signed download link (text, short lived).
4. **The browser** fetches the file from Frame.io and hands it to the normal edited video upload: `startEditUpload` (signed R2 link), straight to Cloudflare R2, then `saveEditVersion` with intake `{ via: "import" }`.
5. **Saving**: the server finds the source again from the card's link (metadata only) and saves the version with where it came from. The database numbers it v1 and moves the card to review as for any version. Nothing is messaged, nothing changes on Frame.io.

## Resolving a link (src/lib/frameio/resolve.ts)
- The link is followed server side one redirect at a time (`redirect: "manual"`), only on `f.io`, `frame.io` and `*.frame.io` over https, at most 6 hops, and no answer body is ever read. Seen on a real link: `f.io/<code>` 302 to `next.frame.io/share/<shareId>`, which 307s to `.../share/<shareId>/view/<assetId>`.
- Then `GET https://api.frame.io/v4/accounts` and, in each account: `GET /v4/accounts/{account_id}/files/{asset_id}?include=media_links.original`. A 404 there may be a version stack (`GET .../version_stacks/{id}`): its head version is taken. With no asset id: `GET .../shares/{share_id}/assets`; one file (or one version stack) is the answer.
- A folder or more than one file: "needs-pick" (never guessed). 403: "no-access" (the Adobe login has no download rights). 404 in every account: "not-found". 401: "not-connected". A file that is not a video, or no download link (downloads off, still processing): said in plain words.
- The answer the browser gets is `media_links.original.download_url`: a temporary signed link to the original file as the editor uploaded it. Fetched at once, never stored.

## Who may do what
- Connect and Disconnect: `integrations.manage` (owner and admins).
- The move (resolve, and saving an import): `footage.upload` and `calendar.plan`. The database also refuses an import from anyone who does not plan the calendar. No new permission key.
- A test run (localhost, the Replit workspace) never reads Frame.io or the real cards: the list shows the demo weeks (`demo: true`), and `resolveFrameioEdit` answers "A test run never reads Frame.io".

## The data (live, Nov 16 2026)
`supabase/migrations/20261121000000_frameio_import.sql`, pushed on the owner's yes (Nov 16 2026) in its own push after the code. Tests: `supabase/tests/frameio-import.test.mjs`.
- versions: `intake_via` also allows `import`; new `source_kind` (`frameio`), `source_url`, `source_share_id`, `source_file_id`, `source_file_name`, `source_bytes`, all fixed once saved. An import always has its source; nothing else has one.
- Send to editor on an imported version goes to the card's editor (not to whoever ran the move).
- `frameio_connections` (who connected, in the audit trail) and `frameio_connection_tokens` (the sealed Adobe tokens, kept out of the audit trail). Both server only.

Before it went live, the code worked without it: the Frame.io card says "being connected" and Connect is refused before Adobe opens; an import is never saved without its source: before then it fails with Retry, and nothing is saved.

## Files
- `src/lib/frameio/`: `env.ts` (the two secrets), `oauth.ts` (Adobe IMS), `state.ts` (the signed sign in check), `tokens.ts` (the saved connection, fresh tokens, the health check), `client.ts` (the Frame.io calls), `resolve.ts` (link to file), `actions.ts` (Connect, Disconnect), `result.ts` (plain words), `frameio.test.mjs`.
- `src/app/connect/frameio/callback/route.ts`.
- `src/lib/content/frameio-import.ts` (the contract with the screen), `frameio-import-actions.ts`, `frameio-import-db.ts`; `edits-save.ts` and `edits-db.ts` (intake `import` and its source).
- Settings, Integrations: the Frame.io card (`src/lib/integrations/registry.ts`, `core.ts`, `health.ts`, `load.ts`, `src/components/settings/IntegrationsPanel.tsx`).

## Still to check on the real thing
- Whether Frame.io's original file host lets a page on our addresses read it (CORS). Frame.io does not document it. A preview file on `assets.frame.io` answered a page on art.incivera.ai (Nov 16 2026); the original was not tried. If it refuses, the fallback is a small Cloudflare Worker that copies the signed link into R2 (owner deploys once), still with no byte through Replit.
- Adobe's token exchange is sent with the client id and secret in a Basic header and the `redirect_uri` in the body; Adobe's page does not list `redirect_uri` for that call.
- The agency's Frame.io account must use Adobe sign in, and must add the owner's Adobe login with download rights.
