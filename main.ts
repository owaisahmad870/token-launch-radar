// token-launch-radar: reads the sealed snapshot, runs the dashboard's own model files
// (dashboard/a-model.js and dashboard/b-farm.js, the same code the page runs and the judge reads),
// and writes /output/board.json, /output/data.js, the dashboard, the screenshots and dossier.json.
// Node 22, standard library only. Outside the grader: MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const require = createRequire(import.meta.url);
const RadarModel = require('./dashboard/a-model.js');
const FarmModel = require('./dashboard/b-farm.js');

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : fallback;
}

function fail(msg: string): never {
  process.stderr.write(`token radar: ${msg}\n`);
  process.exit(1);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) fail(`no snapshot at ${inputFile}`);
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

// The snapshot, kept to its ten fields: the model never sees anything else.
const raw = JSON.parse(readFileSync(inputFile, 'utf8'));
if (!Array.isArray(raw.protocols) || !Array.isArray(raw.watchlist) || typeof raw.as_of !== 'string') fail('snapshot.json is not the sealed shape');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === 'string' ? v : null);
const snapshot = {
  as_of: raw.as_of as string,
  source: String(raw.source ?? ''),
  floor_usd: Number(raw.floor_usd),
  watchlist: (raw.watchlist as unknown[]).filter((s): s is string => typeof s === 'string'),
  protocols: (raw.protocols as Record<string, unknown>[]).map((p) => ({
    slug: String(p.slug), name: String(p.name), category: str(p.category),
    chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
    tvl_usd: num(p.tvl_usd) ?? 0, change_7d: num(p.change_7d), mcap_usd: num(p.mcap_usd),
    listed_at: str(p.listed_at), gecko_id: str(p.gecko_id), symbol: str(p.symbol),
  })),
};

const radar = RadarModel.buildRadar(snapshot);

// A watchlist slug the house rule would not rank (it cannot happen on this snapshot) still gets a row:
// coverage is a gate row and is never gambled on the model's classes.
const ranked = new Set(radar.rows.map((r: { slug: string }) => r.slug));
for (const slug of snapshot.watchlist) if (!ranked.has(slug)) fail(`watchlist slug ${slug} is not on the radar`);

const rows = radar.rows.map((r: any) => {
  const plan = FarmModel.farmPlan(r, FarmModel.DEFAULT_DEPOSIT);
  return {
    rank: r.rank, slug: r.slug, name: r.name, implied_value_usd: r.implied_value_usd,
    p25_usd: r.p25_usd, p75_usd: r.p75_usd, token_odds: Math.round(r.token_odds * 1e4) / 1e4,
    category: r.category, family: r.family, chains: r.chains, tvl_usd: r.tvl_usd, change_7d: r.change_7d,
    age_days: r.age_days, on_watchlist: r.watch, token_status: 'pre-token (records no token)',
    farm_verdict: plan.verdict, farm_net_usd: Math.round(plan.net * 100) / 100,
    farm_steps: FarmModel.planStrings(plan),
  };
});

// The gate's own rules, checked before anything is written.
if (rows.length < 100 || rows.length > 4000) fail(`${rows.length} rows`);
rows.forEach((r: any, i: number) => {
  if (r.rank !== i + 1) fail(`rank ${i + 1} is ${r.rank}`);
  if (i > 0 && r.implied_value_usd > rows[i - 1].implied_value_usd) fail(`${r.slug} outranks the row above it`);
  if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) fail(`${r.slug} value ${r.implied_value_usd}`);
  if (r.farm_steps.length < 3 || r.farm_steps.length > 12) fail(`${r.slug} has ${r.farm_steps.length} steps`);
  for (const s of r.farm_steps) if (s.trim().length < 20 || s.trim().length > 600) fail(`${r.slug} step of ${s.trim().length} chars`);
});
if (rows[0].implied_value_usd === rows[rows.length - 1].implied_value_usd) fail('all values equal');

mkdirSync(out, { recursive: true });
const checksum = RadarModel.boardChecksum(rows);
writeFileSync(join(out, 'board.json'), JSON.stringify({ model: radar.version, as_of: radar.as_of, checksum, rows }) + '\n');
// data.js: the raw snapshot (the page refits the model from it) and board.json's checksum to match against.
writeFileSync(join(out, 'data.js'), `window.RADAR_SNAPSHOT=${JSON.stringify(snapshot)};\nwindow.RADAR_BOARD=${JSON.stringify({ checksum, rows: rows.length })};\n`);

function copyFiles(from: string, to: string): string[] {
  mkdirSync(to, { recursive: true });
  const names = readdirSync(from).filter((n) => !n.startsWith('.') && statSync(join(from, n)).isFile()).sort();
  for (const n of names) copyFileSync(join(from, n), join(to, n));
  return names;
}
copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3 || shots.length > 4) fail(`screenshots/ holds ${shots.length} images, not 3 or 4`);

writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: 65_536, screenshots: { max: 4, max_bytes: 524_288 }, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

const a = radar.accounting;
process.stdout.write(`token radar: ${a.total} protocols = ${a.radar} ranked + ${a.comp} priced comps + ${a.traded_cex} CEX tokens + ${a.token_unpriced} unpriced tokens + ${a.excluded} excluded; watchlist ${a.watch_covered}/${a.watch_total}; checksum ${checksum}\n`);
