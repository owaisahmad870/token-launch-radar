// Dev tool: our mirror of the server's seven gate rows plus dossier_matches, and the extras the server
// does not check: the dossier text is whole (nothing cut), the rendered page says its refit equals
// board.json, and two runs of main.ts write the same bytes.
// usage: node scripts/gate.mjs --snapshot <snapshot.json> [--node <node.exe>] [--chrome <chrome.exe>]
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, rmSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { buildDossier } from '../vendor/makefun-board.ts';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const snapPath = resolve(arg('--snapshot', 'D:/make.fun/scout/kit-radar38/token-radar-01-kit/input/snapshot.json'));
const node = arg('--node', process.execPath);
const chrome = arg('--chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const CAPS = { text_max_bytes: 65536, screenshots: { max: 4, max_bytes: 524288 }, dashboard: { max_files: 400, max_bytes: 4194304 } };
const NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const results = [];
const row = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? 'pass' : 'FAIL'}  ${name.padEnd(18)} ${detail}`); };

function run(out) {
  execFileSync(node, ['main.ts', '--input', snapPath], { env: { ...process.env, MAKEFUN_OUTPUT_DIR: out }, stdio: ['ignore', 'pipe', 'inherit'] });
}
function walk(dir, rel = '') {
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const p = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? walk(dir, p) : [p];
  }).sort();
}

const base = mkdtempSync(join(tmpdir(), 'radar-gate-'));
const out = join(base, 'a'), out2 = join(base, 'b');
run(out); run(out2);
const snap = JSON.parse(readFileSync(snapPath, 'utf8'));

// 1. dashboard_files (stricter than the scorer: no http(s) address anywhere in any file)
{
  const files = walk(join(out, 'dashboard'));
  const bytes = files.reduce((s, f) => s + statSync(join(out, 'dashboard', f)).size, 0);
  const bad = files.find((f) => !f.split('/').every((s) => NAME.test(s)) || /https?:\/\//i.test(readFileSync(join(out, 'dashboard', f), 'utf8')));
  const ok = files.includes('index.html') && files.some((f) => f.endsWith('.css')) && files.some((f) => f.endsWith('.js')) && files.length <= 400 && bytes <= 4194304 && !bad;
  row('dashboard_files', ok, `${files.length} files, ${bytes} bytes${bad ? ', offending ' + bad : ''}`);
}

// 2-5. board_file, sorted_by_value, coverage, farm_steps
const boardText = readFileSync(join(out, 'board.json'));
const board = JSON.parse(boardText.toString('utf8'));
const rows = Array.isArray(board) ? board : board.rows;
{
  const known = new Set(snap.protocols.map((p) => p.slug)), seen = new Set();
  const bad = rows.filter((r) => typeof r.slug !== 'string' || !known.has(r.slug) || seen.has(r.slug) || !seen.add(r.slug) || /\s/.test(r.slug) ||
    typeof r.name !== 'string' || !r.name || !Number.isSafeInteger(r.rank) || r.rank < 1 ||
    !Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd < 1 || r.implied_value_usd > 1e14 || !Array.isArray(r.farm_steps));
  row('board_file', rows.length >= 100 && rows.length <= 4000 && boardText.length <= 8 * 1048576 && bad.length === 0, `${rows.length} rows, ${boardText.length} bytes, ${bad.length} bad`);
  const byRank = rows.slice().sort((a, b) => a.rank - b.rank);
  const ranksOk = byRank.every((r, i) => r.rank === i + 1), mono = byRank.every((r, i) => i === 0 || r.implied_value_usd <= byRank[i - 1].implied_value_usd);
  const distinct = new Set(rows.map((r) => r.implied_value_usd)).size;
  row('sorted_by_value', ranksOk && mono && distinct > 1, `ranks 1..${rows.length} ${ranksOk}, non-increasing ${mono}, ${distinct} distinct values`);
  const missing = snap.watchlist.filter((s) => !seen.has(s));
  row('coverage', missing.length === 0, `${snap.watchlist.length - missing.length}/${snap.watchlist.length}${missing.length ? ' missing ' + missing.slice(0, 5) : ''}`);
  const badSteps = rows.filter((r) => r.farm_steps.length < 3 || r.farm_steps.length > 12 || r.farm_steps.some((s) => typeof s !== 'string' || s.trim().length < 20 || s.trim().length > 600));
  const lens = rows.flatMap((r) => r.farm_steps.map((s) => s.trim().length));
  row('farm_steps', badSteps.length === 0, `${badSteps.length} bad rows; step length ${Math.min(...lens)}..${Math.max(...lens)}`);
}

// 6. screenshots: 3-4 whole PNG/JPEG, <=512 KiB, long side <=1440, short side >=800
function dims(b) {
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (b.subarray(b.length - 8, b.length - 4).toString('latin1') !== 'IEND') return null;
    return [b.readUInt32BE(16), b.readUInt32BE(20)];
  }
  if (b[0] === 0xff && b[1] === 0xd8 && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9) {
    for (let i = 2; i < b.length - 9;) {
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xc3) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}
{
  const shots = readdirSync(join(out, 'screenshots')).filter((n) => !n.startsWith('.'));
  const info = shots.map((n) => { const b = readFileSync(join(out, 'screenshots', n)); const d = dims(b); return { n, size: b.length, d, ok: NAME.test(n) && b.length <= 524288 && d && Math.max(...d) <= 1440 && Math.min(...d) >= 800 }; });
  row('screenshots', shots.length >= 3 && shots.length <= 4 && info.every((x) => x.ok), info.map((x) => `${x.n} ${x.size}B ${x.d ? x.d.join('x') : 'not whole'}`).join(', '));
}

// 7. dossier_matches, plus the text cap: every source file shown whole
{
  const written = readFileSync(join(out, 'dossier.json'));
  const rebuilt = Buffer.from(buildDossier(out, CAPS));
  const text = JSON.parse(written.toString('utf8')).text || '';
  row('dossier_matches', written.equals(rebuilt) && written.length <= 1.5 * 1048576, `${written.length} bytes of 1572864`);
  const cut = /not shown|left out/.test(text.split('\n').slice(-3).join('\n'));
  row('x_source_whole', !cut, `dossier text ${Buffer.byteLength(text)} of 65536 bytes${cut ? ', CUT' : ''}`);
}

// Extra: the rendered page refits the model and says it matches board.json
{
  const dom = execFileSync(chrome, ['--headless=new', '--disable-gpu', '--virtual-time-budget=8000', '--dump-dom', pathToFileURL(join(out, 'dashboard', 'index.html')).href], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const ok = dom.includes('page refit = board.json') && dom.includes(`checksum ${board.checksum}`);
  row('x_page_matches', ok, ok ? `page checksum ${board.checksum} = board.json` : 'page does not report a match');
}

// Extra: determinism, two runs byte for byte
{
  const a = walk(out), b = walk(out2);
  const diff = a.length !== b.length ? ['file lists differ'] : a.filter((f, i) => f !== b[i] || !readFileSync(join(out, f)).equals(readFileSync(join(out2, f))));
  row('x_double_run', diff.length === 0, `${a.length} files${diff.length ? ', differ: ' + diff.slice(0, 3) : ' identical'} (node ${execFileSync(node, ['--version'], { encoding: 'utf8' }).trim()})`);
}

rmSync(base, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `GATE FAIL (${failed})` : 'GATE PASS');
process.exit(failed ? 1 : 0);
