// One time bridge from the approved prototype (design/concepts, concept 6 "Iris on Tan") to the real app.
// It copies the design tokens and component styles, the icon set, the platform and model logos and the logo outlines.
// Run: node scripts/extract-design.mjs
// After the first run the files in src/design are the source of truth. Do not run this again without checking the diff:
// it overwrites tokens.css, core.css and screens.css.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const proto = path.join(root, 'design', 'concepts');
const out = path.join(root, 'src', 'design');
fs.mkdirSync(path.join(out, 'data'), { recursive: true });

const html = fs.readFileSync(path.join(proto, 'concept-6.html'), 'utf8');
let css = html.match(/<style[^>]*>([\s\S]*?)<\/style>/)[1];
// fonts come from next/font, so the family names become variables set on <html>
css = css.replaceAll("'Manrope'", 'var(--font-manrope)').replaceAll("'Poppins'", 'var(--font-poppins)');

const cut = marker => { const i = css.indexOf(marker); if (i < 0) throw new Error('marker not found: ' + marker); return i; };
const iBase = cut('/* ===== Base:');
const iHome = cut('/* ===== Home =====');
const head = name => `/* Noun ART design system: ${name}. Copied from the approved concept 6 (Iris on Tan), then owned here. */\n`;
fs.writeFileSync(path.join(out, 'tokens.css'), head('tokens') + css.slice(0, iBase).trim() + '\n');
fs.writeFileSync(path.join(out, 'core.css'), head('base, shell, surfaces, buttons, controls, pills, platform tiles, data tiles, navigation, sheet and toast') + css.slice(iBase, iHome).trim() + '\n');
fs.writeFileSync(path.join(out, 'screens.css'), head('screen styles and the desktop density pass') + css.slice(iHome).trim() + '\n');

// CFG, platform logos, model logos and the logo outlines are plain data in the first script of the built file
const s0 = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)][0][1];
const win = {}; vm.runInNewContext(s0, { window: win });
fs.writeFileSync(path.join(out, 'data', 'logos.json'), JSON.stringify({ platforms: win.LOGOS, models: win.MLOGOS }, null, 1));
fs.writeFileSync(path.join(out, 'data', 'brand-paths.json'), JSON.stringify(win.NF, null, 1));

// the line icon set is a plain object literal in src/app.js; later files add or replace a few
const icons = {};
for (const f of ['app.js', 'flows.js', 'views.js', 'brand.js', 'settings.js', 'post.js', 'rail.js', 'signin.js', 'editor.js']) {
  const src = fs.readFileSync(path.join(proto, 'src', f), 'utf8');
  const lit = src.match(/const ICONS = (\{[\s\S]*?\n\});/);
  if (lit) Object.assign(icons, vm.runInNewContext('(' + lit[1] + ')'));
  for (const m of src.matchAll(/Object\.assign\(ICONS, (\{[\s\S]*?\})\);/g)) { try { Object.assign(icons, vm.runInNewContext('(' + m[1] + ')')); } catch { /* not a plain literal */ } }
  for (const m of src.matchAll(/^ICONS\.([a-zA-Z0-9_]+) = ('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`$]*`);/gm)) icons[m[1]] = vm.runInNewContext(m[2]);
}
// the approved Studio icon is the camera aperture (rail.js keeps the alternatives)
{ const rail = fs.readFileSync(path.join(proto, 'src', 'rail.js'), 'utf8'); const lit = rail.match(/const STUDIO_IC = (\{[\s\S]*?\n\});/); if (lit) { const alt = vm.runInNewContext('(' + lit[1] + ')'); icons.studio = alt.aperture[1]; icons.studioClapper = alt.clapper[1]; icons.studioLens = alt.lens[1]; } }
fs.writeFileSync(path.join(out, 'data', 'icons.json'), JSON.stringify(icons, null, 1));

console.log('tokens', iBase, 'core', iHome - iBase, 'screens', css.length - iHome, '| icons', Object.keys(icons).length, '| platform logos', Object.keys(win.LOGOS).length, '| model logos', Object.keys(win.MLOGOS || {}).length, '| brand paths', Object.keys(win.NF || {}).join(','));
