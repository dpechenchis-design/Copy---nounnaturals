/* Writes design/email/invite-preview.html: a sample of the invite email, to open in a browser.
     node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./src/lib/import/ts-resolve.mjs scripts/render-invite-preview.mjs
   Add --assets to also redraw the email's two pictures in public/email from the brand SVGs (needs sharp, which Next brings).
   The real email loads its pictures from https://art.incivera.ai/email/; the preview points at public/email instead,
   so it shows them before the app is republished. */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INVITE_ASSET_BASE, renderInviteHtml } from "../src/lib/google/invite-email-design.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

if (process.argv.includes("--assets")) {
  const { default: sharp } = await import("sharp");
  const brand = join(root, "design", "brand", "noun-art");
  const out = join(root, "public", "email");
  mkdirSync(out, { recursive: true });
  /* The Logo 1 Flow wordmark in white (light Iris art) on nothing, for purple backgrounds. One picture, used twice:
     on the hero's gradient (shown 200 x 42) and inside the button (shown 105 x 22). Its baseline is the picture's
     bottom edge, so in the button it sits on the line of the word "Open". The file's motion is dropped. */
  const still = (f) => Buffer.from(readFileSync(join(brand, f), "utf8").replace(/<style>[\s\S]*?<\/style>/, ""));
  await sharp(still("option-1/lockup-on-purple.svg"), { density: 400 }).resize(420, 88, { fit: "fill" }).png().toFile(join(out, "noun-art-wordmark-white@2x.png"));
  /* The Logo 2 Viewfinder app icon (the n in four corner marks on the Iris tile), shown 40 x 40. */
  await sharp(readFileSync(join(brand, "icon", "icon.svg")), { density: 300 }).resize(80, 80).png().toFile(join(out, "noun-art-icon@2x.png"));
  console.log("pictures written to public/email");
}

const html = renderInviteHtml({
  inviterName: "Khaled",
  roleName: "Editor",
  toEmail: "olena@nounnaturals.com",
  note: "Welcome to the team, Olena. Your first raw clips are waiting in Week 3.",
  signInUrl: "https://art.incivera.ai/signin",
}).replaceAll(INVITE_ASSET_BASE, "../../public/email/");

const file = join(root, "design", "email", "invite-preview.html");
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, html);
console.log("written " + file);
