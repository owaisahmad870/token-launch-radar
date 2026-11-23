// a-model.js: the radar's value model. main.ts runs THIS file to write board.json, and the page runs it
// again in the browser from the raw snapshot, then checks its numbers against board.json row by row.
//
// implied value = 10 ^ ( b0 + b1*(log10 TVL - mean) + b2*growth7d + b3*(log10(1 + years) - mean) + family )
//   - b0..b3 and the family terms are fitted by fitValueModel() on the snapshot's own priced tokens
//     (market cap > 0, no CEX): what the market pays today for a protocol with this TVL, 7-day growth and age.
//   - growth7d = change_7d / 100, clamped to [-0.5, +1.0]; years = days since DefiLlama began tracking it
//     (for a pre-token row: how long it has run with no token on record).
// Nothing names a protocol: one function scores every row. Validation: leaveOneOut(), walkForward(),
// against naiveMultiple() (every protocol at the median market cap / TVL). Band: P25-P75 of the
// leave-one-out errors. tokenOdds(): a logistic fit of "records a token" on TVL and age.
(function (root) {
  'use strict';

  const MODEL_VERSION = 'comps-huber-ridge-2';
  const DAY = 86400000;
  const RIDGE = 5, HUBER = 0.5;
  const GROWTH_MIN = -0.5, GROWTH_MAX = 1.0;
  const WF_START = 0.6; // walk-forward tests the newest 40% of priced tokens, each fitted on older ones only

  // The house watchlist rule, reused for the whole snapshot (protocols below the floor included).
  const EXCLUDED_CATEGORIES = ['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX'];
  const VERSION_MARK = /\s(v\d+(\.\d+)?|\d+\.\d+)$/i;
  const DERIVED_WORD = /\b(wrapped|staked|staking)\b/i;
  const EXCHANGE_PREFIX = /^(binance|coinbase|bybit|kraken|bitget|okx|bitfinex|gemini)\b/i;

  // Category -> family: comps per DefiLlama category are too few (Risk Curators has 1), families pool them.
  const FAMILY = {
    'Lending': 'Lending', 'CDP': 'Lending', 'CDP Manager': 'Lending', 'Uncollateralized Lending': 'Lending',
    'Collateral Markets': 'Lending', 'Collateral Management': 'Lending', 'Interest Rate Derivatives': 'Lending',
    'Dexs': 'Trading', 'Derivatives': 'Trading', 'Options': 'Trading', 'Liquidity Manager': 'Trading',
    'Prediction Market': 'Trading', 'OTC Marketplace': 'Trading', 'Synthetics': 'Trading', 'NFT Marketplace': 'Trading',
    'Yield': 'Vaults', 'Yield Aggregator': 'Vaults', 'Risk Curators': 'Vaults', 'Onchain Capital Allocator': 'Vaults',
    'Basis Trading': 'Vaults', 'Leveraged Farming': 'Vaults', 'Farm': 'Vaults', 'Indexes': 'Vaults', 'CeDeFi': 'Vaults',
    'RWA': 'RWA & stables', 'Stablecoin Wrapper': 'RWA & stables', 'Dual-Token Stablecoin': 'RWA & stables',
    'Payments': 'RWA & stables', 'Crypto Card Issuer': 'RWA & stables',
    'Chain': 'Infra', 'Restaking': 'Infra', 'Staking Pool': 'Infra', 'Cross Chain Bridge': 'Infra', 'Bridge': 'Infra',
    'Canonical Bridge': 'Infra', 'Liquid Staking': 'Infra', 'Liquid Restaking': 'Infra', 'Anchor BTC': 'Infra',
    'Decentralized BTC': 'Infra', 'Restaked BTC': 'Infra',
  };
  const familyOf = (p) => FAMILY[p.category] || 'Other';
  const byStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

  function ageDays(asOf, listedAt) {
    if (!listedAt) return null;
    const d = Math.floor((Date.parse(asOf + 'T00:00:00Z') - Date.parse(listedAt + 'T00:00:00Z')) / DAY);
    return Number.isFinite(d) ? Math.max(0, d) : null;
  }

  const hasToken = (p) => p.mcap_usd !== null || p.gecko_id !== null || p.symbol !== null;

  // Why a pre-token protocol is left off the radar (the house rule), or null when the radar ranks it.
  function exclusionReason(p) {
    if (EXCLUDED_CATEGORIES.includes(p.category)) return 'category ' + p.category;
    if (VERSION_MARK.test(p.name)) return 'version marker in name';
    if (DERIVED_WORD.test(p.name)) return 'wrapped/staked product';
    if (EXCHANGE_PREFIX.test(p.name)) return "exchange's product";
    return null;
  }

  // Every protocol lands in exactly one class: the 758 are accounted for, none dropped silently.
  function classify(p) {
    if (p.mcap_usd !== null && p.mcap_usd > 0) return p.category === 'CEX' ? 'traded-cex' : 'comp';
    if (hasToken(p)) return 'token-unpriced';
    return exclusionReason(p) === null ? 'radar' : 'excluded';
  }

  // Features of one protocol. Unknown age takes the comps' median age, and the row says so.
  function features(p, asOf, medianAge) {
    const d = ageDays(asOf, p.listed_at);
    const days = d === null ? medianAge : d;
    return {
      lt: Math.log10(Math.max(1, p.tvl_usd)),
      g: clamp((p.change_7d === null ? 0 : p.change_7d) / 100, GROWTH_MIN, GROWTH_MAX),
      a: Math.log10(1 + days / 365),
      days: d,
      fam: familyOf(p),
    };
  }

  // Gaussian elimination with partial pivoting: solves A x = b for a small dense system.
  function solve(A, b) {
    const n = b.length, M = A.map((r, i) => r.concat([b[i]]));
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      const t = M[c]; M[c] = M[piv]; M[piv] = t;
      for (let r = c + 1; r < n; r++) {
        const f = M[r][c] / M[c][c];
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
      let s = M[r][n];
      for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
      x[r] = s / M[r][r];
    }
    return x;
  }

  const dot = (w, x) => w.reduce((s, wi, i) => s + wi * x[i], 0);
  const FAMILIES = ['Infra', 'Lending', 'Other', 'RWA & stables', 'Trading', 'Vaults'];
  // Design row: level, TVL and age centred on the comps' means (so the ridge shrinks slopes, not the
  // level), growth, then one 0/1 column per family.
  const design = (f, mu) => [1, f.lt - mu.lt, f.g, f.a - mu.a].concat(FAMILIES.map((k) => (f.fam === k ? 1 : 0)));

  // fitValueModel: Huber-weighted ridge regression of log10(market cap) on the design row.
  //   - Huber weights (20 reweighting passes): a comp more than HUBER dex off the line counts less, so a
  //     handful of tokens priced at 1/100th of their TVL cannot drag the line.
  //   - Ridge RIDGE on growth, age and the families, none on TVL: a term moves the value only as far as
  //     the comps support it. Chosen by leave-one-out and walk-forward error (the page shows both).
  // Input: comps as {f, y}. Output: {beta, mu, fam} with fam[k] the family's own coefficient.
  function fitValueModel(comps) {
    const n = comps.length, mu = { lt: 0, a: 0 };
    comps.forEach((c) => { mu.lt += c.f.lt / n; mu.a += c.f.a / n; });
    const X = comps.map((c) => design(c.f, mu)), k = X[0].length, w = new Array(n).fill(1);
    const pen = [1e-9, 1e-9, RIDGE, RIDGE].concat(FAMILIES.map(() => RIDGE));
    let beta = new Array(k).fill(0);
    for (let it = 0; it < 20; it++) {
      const A = [], b = new Array(k).fill(0);
      for (let i = 0; i < k; i++) A.push(new Array(k).fill(0));
      X.forEach((x, r) => {
        for (let i = 0; i < k; i++) { b[i] += w[r] * x[i] * comps[r].y; for (let j = 0; j < k; j++) A[i][j] += w[r] * x[i] * x[j]; }
      });
      for (let i = 0; i < k; i++) A[i][i] += pen[i];
      beta = solve(A, b);
      X.forEach((x, r) => { const e = Math.abs(comps[r].y - dot(beta, x)); w[r] = e <= HUBER ? 1 : HUBER / e; });
    }
    const fam = {};
    FAMILIES.forEach((f, i) => { fam[f] = beta[4 + i]; });
    return { beta: beta.slice(0, 4), mu, fam };
  }

  const predictLog = (fit, f) => dot(fit.beta, [1, f.lt - fit.mu.lt, f.g, f.a - fit.mu.a]) + fit.fam[f.fam];

  // valueTerms: the implied value as a product. base = the typical comp's value (mean log TVL and age,
  // flat week, before the family term); then one multiplier each for TVL, growth, age and family.
  function valueTerms(fit, f) {
    return { base: fit.beta[0], tvl: fit.beta[1] * (f.lt - fit.mu.lt), growth: fit.beta[2] * f.g, age: fit.beta[3] * (f.a - fit.mu.a), family: fit.fam[f.fam] };
  }

  // Leave-one-out: refit without each priced token and predict it. Errors in log10 units (dex).
  function leaveOneOut(comps) {
    return comps.map((c, i) => c.y - predictLog(fitValueModel(comps.filter((_, j) => j !== i)), c.f));
  }

  // Walk-forward: order priced tokens by listing date; each of the newest 40% is predicted by a fit on
  // the ones listed before it only. No look-ahead.
  function walkForward(comps) {
    const dated = comps.filter((c) => c.listed).sort((a, b) => byStr(a.listed, b.listed) || byStr(a.slug, b.slug));
    const start = Math.floor(dated.length * WF_START), err = [];
    for (let i = start; i < dated.length; i++) err.push(dated[i].y - predictLog(fitValueModel(dated.slice(0, i)), dated[i].f));
    return { err, n: err.length, trainFrom: start };
  }

  // The baseline any model must beat: market cap = TVL x the median comp's market cap / TVL (LOO).
  function naiveMultiple(comps) {
    return comps.map((c, i) => {
      const m = median(comps.filter((_, j) => j !== i).map((d) => d.y - d.f.lt));
      return c.y - (c.f.lt + m);
    });
  }

  function quantile(xs, q) {
    const s = xs.slice().sort((a, b) => a - b), at = (s.length - 1) * q, lo = Math.floor(at);
    return lo + 1 < s.length ? s[lo] + (s[lo + 1] - s[lo]) * (at - lo) : s[lo];
  }
  const median = (xs) => quantile(xs, 0.5);
  const medAbs = (xs) => median(xs.map(Math.abs));

  // tokenOdds: logistic fit (IRLS, 30 steps) of "records a token" on [1, log10 TVL, log10(1+years)] over
  // comparable protocols. It is the share of protocols like this one that record a token, not a launch date.
  function fitTokenOdds(sample) {
    let w = [0, 0, 0];
    for (let it = 0; it < 30; it++) {
      const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
      sample.forEach((s) => {
        const x = [1, s.f.lt, s.f.a], p = 1 / (1 + Math.exp(-dot(w, x))), v = Math.max(p * (1 - p), 1e-9);
        const z = dot(w, x) + (s.label - p) / v;
        for (let i = 0; i < 3; i++) { b[i] += v * x[i] * z; for (let j = 0; j < 3; j++) A[i][j] += v * x[i] * x[j]; }
      });
      for (let i = 0; i < 3; i++) A[i][i] += 1e-6;
      w = solve(A, b);
    }
    return w;
  }
  const tokenOdds = (w, f) => 1 / (1 + Math.exp(-(w[0] + w[1] * f.lt + w[2] * f.a)));

  // The three comps nearest in (log TVL, age, growth), same family first: the row's evidence.
  function nearestComps(f, comps) {
    return comps.map((c) => ({
      c, d: Math.hypot(c.f.lt - f.lt, c.f.a - f.a, (c.f.g - f.g) / 2) + (c.f.fam === f.fam ? 0 : 0.5),
    })).sort((x, y) => x.d - y.d || byStr(x.c.slug, y.c.slug)).slice(0, 3).map((x) => x.c);
  }

  // buildRadar: snapshot in, the whole radar out. main.ts and the page both call it.
  function buildRadar(snap) {
    const asOf = snap.as_of, groups = { radar: [], comp: [], 'traded-cex': [], 'token-unpriced': [], excluded: [] };
    snap.protocols.forEach((p) => groups[classify(p)].push(p));
    const compAges = groups.comp.map((p) => ageDays(asOf, p.listed_at)).filter((d) => d !== null);
    const medianAge = Math.round(median(compAges));
    const feat = (p) => features(p, asOf, medianAge);
    const comps = groups.comp.map((p) => ({ slug: p.slug, name: p.name, p, f: feat(p), y: Math.log10(p.mcap_usd), listed: p.listed_at }));

    const fit = fitValueModel(comps);
    const loo = leaveOneOut(comps), wf = walkForward(comps), naive = naiveMultiple(comps);
    const band = [quantile(loo, 0.25), quantile(loo, 0.75)];
    const validation = {
      n: comps.length,
      loo_mad: medAbs(loo), naive_mad: medAbs(naive), wf_mad: medAbs(wf.err), wf_n: wf.n,
      loo_within2x: loo.filter((e) => Math.abs(e) <= Math.log10(2)).length / loo.length,
      naive_within2x: naive.filter((e) => Math.abs(e) <= Math.log10(2)).length / naive.length,
      band_p25: band[0], band_p75: band[1],
    };

    const oddsSample = snap.protocols.filter((p) => classify(p) !== 'excluded' && classify(p) !== 'traded-cex' && !EXCLUDED_CATEGORIES.includes(p.category))
      .map((p) => ({ f: feat(p), label: hasToken(p) ? 1 : 0 }));
    const oddsW = fitTokenOdds(oddsSample);

    const scored = groups.radar.map((p) => {
      const f = feat(p), logv = predictLog(fit, f);
      return {
        slug: p.slug, name: p.name, category: p.category, chains: p.chains, family: f.fam,
        tvl_usd: p.tvl_usd, change_7d: p.change_7d, listed_at: p.listed_at, age_days: f.days,
        watch: snap.watchlist.includes(p.slug),
        implied_value_usd: Math.max(1, Math.round(Math.pow(10, logv))),
        p25_usd: Math.max(1, Math.round(Math.pow(10, logv + band[0]))),
        p75_usd: Math.max(1, Math.round(Math.pow(10, logv + band[1]))),
        token_odds: tokenOdds(oddsW, f),
        // log10 terms; 10^term is each one's multiplier on the typical comp's value (see valueTerms).
        terms: valueTerms(fit, f),
        f, peers: nearestComps(f, comps).map((c) => ({ slug: c.slug, name: c.name, tvl_usd: c.p.tvl_usd, mcap_usd: c.p.mcap_usd })),
      };
    });
    scored.sort((a, b) => b.implied_value_usd - a.implied_value_usd || byStr(a.slug, b.slug));
    scored.forEach((r, i) => { r.rank = i + 1; });

    const compRows = comps.map((c, i) => ({
      slug: c.slug, name: c.name, category: c.p.category, family: c.f.fam, tvl_usd: c.p.tvl_usd, change_7d: c.p.change_7d,
      age_days: c.f.days, mcap_usd: c.p.mcap_usd, fitted_usd: Math.round(Math.pow(10, predictLog(fit, c.f))), loo_err: loo[i],
    })).sort((a, b) => b.tvl_usd - a.tvl_usd || byStr(a.slug, b.slug));

    const accounting = {
      total: snap.protocols.length, radar: groups.radar.length, comp: groups.comp.length, traded_cex: groups['traded-cex'].length,
      token_unpriced: groups['token-unpriced'].length, excluded: groups.excluded.length,
      watch_covered: scored.filter((r) => r.watch).length, watch_total: snap.watchlist.length,
    };
    const excluded = groups.excluded.map((p) => ({ slug: p.slug, name: p.name, tvl_usd: p.tvl_usd, reason: exclusionReason(p) }))
      .sort((a, b) => b.tvl_usd - a.tvl_usd || byStr(a.slug, b.slug));
    return { version: MODEL_VERSION, as_of: asOf, median_age_days: medianAge, fit, odds_w: oddsW, validation, accounting, rows: scored, comps: compRows, excluded };
  }

  // boardChecksum: FNV-1a over "rank:slug:value" of every row. main.ts stores the one it wrote into
  // board.json; the page recomputes it from its own fit, so a match proves screen = board.json.
  function boardChecksum(rows) {
    let h = 0x811c9dc5;
    const s = rows.map((r) => r.rank + ':' + r.slug + ':' + r.implied_value_usd).join('|');
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  const RadarModel = { MODEL_VERSION, boardChecksum, FAMILY, EXCLUDED_CATEGORIES, ageDays, classify, exclusionReason, features, fitValueModel, leaveOneOut, walkForward, naiveMultiple, fitTokenOdds, tokenOdds, nearestComps, quantile, buildRadar };
  if (typeof module === 'object' && module.exports) module.exports = RadarModel; else root.RadarModel = RadarModel;
})(typeof window !== 'undefined' ? window : globalThis);
