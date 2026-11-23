// Dev tool, not part of the entry's run: renders out/dashboard in headless Chrome at 1440x900, one
// URL-hash state per screenshot, and writes them to screenshots/. Run main.ts into out/ first.
// usage: node scripts/shoot.mjs [--out out] [--chrome <chrome.exe>]
import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync, readdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const out = resolve(arg('--out', 'out'));
const chrome = arg('--chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const page = pathToFileURL(join(out, 'dashboard', 'index.html')).href;

// The three views the judge's prompt names (the board, a protocol's detail, a filtered view), then the
// priced comps the model is fitted on.
export const SHOTS = [
  ['1-board.png', 'tab=radar'],
  ['2-detail.png', 'tab=radar&sort=value&dir=-1&open=august-digital'],
  ['3-filtered.png', 'tab=radar&fam=Lending&verdict=Farm&sort=net&dir=-1&dep=25000'],
  ['4-comps.png', 'tab=comps'],
];

mkdirSync('screenshots', { recursive: true });
for (const f of readdirSync('screenshots')) if (!SHOTS.some(([n]) => n === f)) unlinkSync(join('screenshots', f));
for (const [name, hash] of SHOTS) {
  const file = resolve('screenshots', name);
  execFileSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--window-size=1440,900', '--virtual-time-budget=8000', `--screenshot=${file}`, `${page}#${hash}`], { stdio: 'ignore' });
  console.log(name, statSync(file).size, 'bytes');
}
