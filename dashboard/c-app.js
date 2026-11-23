// c-app.js: the page. It refits the model from the raw snapshot in data.js (RadarModel.buildRadar, the
// same call main.ts made), checks its checksum against board.json's, then renders: the integrity strip,
// the model strip, four tabs (radar, priced comps, excluded, method), sortable headers, filters, a
// deposit slider that re-prices every farm plan, and a detail drawer per protocol.
// All state lives in the URL hash, so every screenshot is a reproducible link.
(function () {
  'use strict';
  const M = window.RadarModel, F = window.FarmModel, SNAP = window.RADAR_SNAPSHOT, BOARD = window.RADAR_BOARD || {};
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // ---- formatting
  function money(n) {
    if (!Number.isFinite(n)) return 'never';
    const a = Math.abs(n), s = n < 0 ? '-$' : '$';
    if (a >= 1e9) return s + (a / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return s + (a / 1e6).toFixed(1) + 'M';
    if (a >= 1e4) return s + (a / 1e3).toFixed(0) + 'K';
    if (a >= 100) return s + Math.round(a).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return s + a.toFixed(2);
  }
  const pct = (x) => (x === null ? 'n/a' : (x > 0 ? '+' : '') + x.toFixed(2) + '%');
  const age = (d) => (d === null ? 'unknown' : d < 365 ? d + ' d' : (d / 365).toFixed(1) + ' y');
  const times = (dex) => '×' + Math.pow(10, dex).toFixed(2);
  const signCls = (x) => (x === null ? '' : x >= 0 ? 'up' : 'down');

  // ---- the refit: the page computes the board itself, then proves it equals board.json
  const t0 = performance.now();
  const R = M.buildRadar(SNAP);
  const refitMs = Math.round(performance.now() - t0);
  const pageSum = M.boardChecksum(R.rows);
  const matches = pageSum === BOARD.checksum && R.rows.length === BOARD.rows;
  const V = R.validation, A = R.accounting;
  const chains = [...new Set(R.rows.flatMap((r) => r.chains))].sort();
  const families = [...new Set(R.rows.map((r) => r.family))].sort();

  // ---- state <-> hash
  const state = { tab: 'radar', q: '', fam: '', chain: '', verdict: '', watch: false, sort: 'rank', dir: 1, dep: F.DEFAULT_DEPOSIT, open: '' };
  function readHash() {
    const h = new URLSearchParams(location.hash.slice(1));
    for (const k of Object.keys(state)) {
      if (!h.has(k)) continue;
      const v = h.get(k);
      state[k] = typeof state[k] === 'number' ? Number(v) : typeof state[k] === 'boolean' ? v === '1' : v;
    }
  }
  function writeHash() {
    const h = new URLSearchParams();
    for (const [k, v] of Object.entries(state)) if (v !== '' && v !== false) h.set(k, v === true ? '1' : String(v));
    history.replaceState(null, '', '#' + h.toString());
  }

  // ---- farm plans for the current deposit (one per row)
  let planDep = -1, plans = new Map();
  function planOf(r) {
    if (planDep !== state.dep) { plans = new Map(); planDep = state.dep; }
    if (!plans.has(r.slug)) plans.set(r.slug, F.farmPlan(r, state.dep));
    return plans.get(r.slug);
  }

  // ---- columns: key, header, sort value, cell html
  const COLS = [
    { k: 'rank', h: '#', v: (r) => r.rank, c: (r) => `<td class="num rank">${r.rank}</td>` },
    { k: 'name', h: 'Protocol', v: (r) => r.name.toLowerCase(), c: (r) => `<td><b>${esc(r.name)}</b>${r.watch ? '<span class="tag">watchlist</span>' : ''}<small>${esc(r.category || 'no category')} · ${esc(r.chains[0] || '')}${r.chains.length > 1 ? ' +' + (r.chains.length - 1) : ''}</small></td>` },
    { k: 'tvl', h: 'TVL', v: (r) => r.tvl_usd, c: (r) => `<td class="num">${money(r.tvl_usd)}</td>` },
    { k: 'g7', h: '7d', v: (r) => r.change_7d ?? -1e9, c: (r) => `<td class="num ${signCls(r.change_7d)}">${pct(r.change_7d)}</td>` },
    { k: 'age', h: 'No token for', v: (r) => r.age_days ?? -1, c: (r) => `<td class="num">${age(r.age_days)}</td>` },
    { k: 'value', h: 'Implied value', v: (r) => r.implied_value_usd, c: (r) => `<td class="num strong">${money(r.implied_value_usd)}</td>` },
    { k: 'band', h: 'P25–P75', v: (r) => r.p75_usd, c: (r) => `<td class="num dim">${money(r.p25_usd)}–${money(r.p75_usd)}</td>` },
    { k: 'odds', h: 'Token odds', v: (r) => r.token_odds, c: (r) => `<td class="num"><span class="bar" style="--w:${Math.round(r.token_odds * 100)}%"></span>${Math.round(r.token_odds * 100)}%</td>` },
    { k: 'net', h: 'Farm net', v: (r) => planOf(r).net, c: (r) => { const p = planOf(r); return `<td class="num"><span class="pill ${p.verdict}">${p.verdict}</span> <span class="${p.net >= 0 ? 'up' : 'down'}">${money(p.net)}</span></td>`; } },
    { k: 'plan', h: 'Plan', v: (r) => planOf(r).minutes, c: (r) => { const p = planOf(r); return `<td class="num dim">${p.steps.length} steps · ${p.minutes}m</td>`; } },
    { k: 'be', h: 'Break-even', v: (r) => planOf(r).breakEven, c: (r) => `<td class="num dim">${money(planOf(r).breakEven)}</td>` },
  ];

  function visibleRows() {
    const q = state.q.trim().toLowerCase();
    const rows = R.rows.filter((r) =>
      (!q || (r.name + ' ' + (r.category || '') + ' ' + r.chains.join(' ')).toLowerCase().includes(q)) &&
      (!state.fam || r.family === state.fam) && (!state.chain || r.chains.includes(state.chain)) &&
      (!state.verdict || planOf(r).verdict === state.verdict) && (!state.watch || r.watch));
    const col = COLS.find((c) => c.k === state.sort) || COLS[0];
    return rows.sort((a, b) => { const x = col.v(a), y = col.v(b); return (x < y ? -1 : x > y ? 1 : 0) * state.dir || a.rank - b.rank; });
  }

  const CLASS_NAME = { evm: 'EVM: approve + deposit', onetx: 'one signed transaction', ledger: 'trustline first', hl: "via Hyperliquid's bridge", btc: 'BTC position', app: "the app's own flow" };

  // ---- strips
  function renderStrips() {
    $('#integrity').innerHTML = [
      `<span class="ok">${A.total} protocols accounted</span> ${A.radar} ranked pre-token + ${A.comp} priced comps + ${A.traded_cex} CEX tokens + ${A.token_unpriced} tokens with no price + ${A.excluded} excluded = ${A.radar + A.comp + A.traded_cex + A.token_unpriced + A.excluded}`,
      `<span class="ok">watchlist ${A.watch_covered}/${A.watch_total}</span>`,
      `<span class="${matches ? 'ok' : 'bad'}">${matches ? 'page refit = board.json' : 'MISMATCH with board.json'}</span> checksum ${pageSum} (board.json ${esc(BOARD.checksum || 'missing')}), ${R.rows.length} rows, ranks 1–${R.rows.length}, refit ${refitMs} ms`,
      `<span class="${BOARD.text_whole ? 'ok' : 'bad'}">source ${BOARD.src_files} files, ${BOARD.src_bytes} bytes</span> dossier text ${BOARD.text_bytes} of 65536 bytes, ${BOARD.text_whole ? 'nothing cut' : 'CUT'}`,
    ].map((s) => `<li>${s}</li>`).join('');
    const C = F.planCensus(R.rows, state.dep);
    $('#farmstrip').innerHTML = `<li><b>farmPlan()</b> ${C.steps} steps over ${C.rows} rows, ${C.priced} of them with $ and minutes</li><li>${C.shapes} plan shapes from family × chain class</li><li>${C.minMin}–${C.maxMin} min of work per plan at ${money(state.dep)}</li>`;
    $('#modelstrip').innerHTML = [
      `<b>fitValueModel()</b> on ${V.n} priced tokens`,
      `<b>leaveOneOut()</b> median error ${times(V.loo_mad)} vs naive multiple ${times(V.naive_mad)}`,
      `within 2×: ${Math.round(V.loo_within2x * 100)}% vs ${Math.round(V.naive_within2x * 100)}%`,
      `<b>walkForward()</b> ${times(V.wf_mad)} on the ${V.wf_n} newest`,
      `band P25–P75 = ${times(V.band_p25)} to ${times(V.band_p75)}`,
    ].map((s) => `<li>${s}</li>`).join('');
  }

  // ---- tabs
  function renderRadar() {
    const rows = visibleRows(), counts = { Farm: 0, Marginal: 0, Skip: 0 };
    rows.forEach((r) => { counts[planOf(r).verdict]++; });
    $('#count').textContent = `${rows.length} of ${R.rows.length} pre-token protocols · at ${money(state.dep)}: ${counts.Farm} Farm, ${counts.Marginal} Marginal, ${counts.Skip} Skip`;
    const head = COLS.map((c) => {
      const on = state.sort === c.k, aria = on ? (state.dir > 0 ? 'ascending' : 'descending') : 'none';
      return `<th aria-sort="${aria}" class="${c.k === 'name' ? '' : 'num'}"><button data-sort="${c.k}">${c.h}${on ? (state.dir > 0 ? ' ▲' : ' ▼') : ''}</button></th>`;
    }).join('');
    $('#table').innerHTML = `<thead><tr>${head}</tr></thead><tbody>${rows.map((r) =>
      `<tr data-slug="${esc(r.slug)}" tabindex="0" class="${r.slug === state.open ? 'sel' : ''}">${COLS.map((c) => c.c(r)).join('')}</tr>`).join('')}</tbody>`;
  }

  // Scatter of fitted vs actual market cap (log10), every priced comp: the model's fit at a glance.
  function scatter() {
    const pts = R.comps.map((c) => [Math.log10(c.fitted_usd), Math.log10(c.mcap_usd), c.name]);
    const all = pts.flatMap((p) => [p[0], p[1]]), lo = Math.floor(Math.min(...all)), hi = Math.ceil(Math.max(...all));
    const W = 480, H = 270, x = (v) => 62 + (v - lo) / (hi - lo) * (W - 90), y = (v) => H - 30 - (v - lo) / (hi - lo) * (H - 52);
    const ticks = [], tick = (t) => money(Math.pow(10, t)).replace('.00', '');
    for (let t = lo; t <= hi; t++) ticks.push(`<text x="${x(t)}" y="${H - 16}" text-anchor="middle">${tick(t)}</text><text x="54" y="${y(t) + 3}" text-anchor="end">${tick(t)}</text>`);
    const dots = pts.map((p) => `<circle cx="${x(p[0]).toFixed(1)}" cy="${y(p[1]).toFixed(1)}" r="3"><title>${esc(p[2])}</title></circle>`).join('');
    return `<svg viewBox="0 0 ${W} ${H}" class="scatter" role="img" aria-label="Fitted versus actual market cap for ${R.comps.length} priced tokens">
      <line x1="${x(lo)}" y1="${y(lo)}" x2="${x(hi)}" y2="${y(hi)}" class="diag"/>${ticks.join('')}${dots}
      <text x="${W / 2}" y="${H - 2}" text-anchor="middle">fitted market cap (dashed line: fitted = actual)</text><text x="4" y="10">actual market cap</text></svg>`;
  }

  // The held-out scorecard beside the scatter: the model against the naive multiple, same comps.
  function scorecard() {
    const pc = (x) => Math.round(x * 100) + '%', mult = R.comps.map((c) => c.mcap_usd / c.tvl_usd);
    const fx = (m) => (m < 0.01 ? m.toPrecision(2) : m < 10 ? m.toFixed(2) : Math.round(m)) + '×';
    return `<table class="mini score"><thead><tr><th>Held-out test (${V.n} priced tokens)</th><th class="num">Model</th><th class="num">Naive</th></tr></thead><tbody>
      <tr><td>leaveOneOut() median error</td><td class="num up">${times(V.loo_mad)}</td><td class="num">${times(V.naive_mad)}</td></tr>
      <tr><td>Within 2× of the real market cap</td><td class="num up">${pc(V.loo_within2x)}</td><td class="num">${pc(V.naive_within2x)}</td></tr>
      <tr><td>walkForward() median error, ${V.wf_n} newest, fit on older only</td><td class="num up">${times(V.wf_mad)}</td><td class="num">–</td></tr>
      <tr><td>P25–P75 band (LOO errors)</td><td class="num" colspan="2">${times(V.band_p25)} to ${times(V.band_p75)}</td></tr></tbody></table>
      <p class="dim">Naive = every protocol at the median market cap / TVL. Errors are multiplicative. Priced tokens themselves trade at ${fx(Math.min(...mult))} to ${fx(Math.max(...mult))} their TVL (median ${fx(M.quantile(mult, 0.5))}), so every row carries its band.</p>`;
  }

  // termTests(), run here (about a second): each term dropped in turn, both held-out tests re-run, and
  // the term's effect across the 198 board rows. The verdict text follows from the two deltas alone.
  let TT = null;
  function termTable() {
    TT = TT || M.termTests(R.fitRows);
    const key = { 'TVL': 'tvl', '7-day growth': 'growth', 'time with no token': 'age', 'family': 'family' }, coef = { tvl: R.fit.beta[1], growth: R.fit.beta[2], age: R.fit.beta[3] };
    const d = (x) => `<span class="${x > 0 ? 'up' : 'down'}">${x > 0 ? '+' : ''}${x.toFixed(3)}</span>`;
    const verdict = (t) => (t.dLoo > 0 && t.dWf > 0 ? 'helps both tests' : t.dLoo <= 0 && t.dWf <= 0 ? 'no held-out gain; kept small' : 'mixed: helps one test only');
    return `<table class="mini score"><thead><tr><th>termTests(): term dropped</th><th class="num">Coef</th><th class="num">Effect on board</th><th class="num">Δ LOO</th><th class="num">Δ WF</th><th>Verdict</th></tr></thead><tbody>${TT.tests.map((t) => {
      const k = key[t.term], m = R.rows.map((r) => Math.pow(10, r.terms[k]));
      return `<tr><td>${t.term}</td><td class="num">${k in coef ? coef[k].toFixed(3) : 'per family'}</td><td class="num">×${Math.min(...m).toFixed(2)}–${Math.max(...m).toFixed(2)}</td><td class="num">${d(t.dLoo)}</td><td class="num">${d(t.dWf)}</td><td>${verdict(t)}</td></tr>`;
    }).join('')}</tbody></table><p class="dim">Δ = median error (dex) without the term minus with it; positive means the term helps. Growth and age are the rubric's inputs and stay in, at the small size the comps support.</p>`;
  }

  function renderComps() {
    $('#count').textContent = `${R.comps.length} protocols whose token trades: the comps the value model is fitted on (never ranked on the radar), largest TVL first`;
    $('#table').innerHTML = `<caption><div class="evidence">${scatter()}<div>${scorecard()}${termTable()}</div></div></caption><thead><tr><th>Protocol</th><th class="num">TVL</th><th class="num">Market cap</th><th class="num">Mcap / TVL</th><th class="num">Fitted</th><th class="num">LOO error</th><th>Family</th></tr></thead><tbody>${R.comps.map((c) =>
      `<tr><td><b>${esc(c.name)}</b><small>${esc(c.category || '')}</small></td><td class="num">${money(c.tvl_usd)}</td><td class="num strong">${money(c.mcap_usd)}</td><td class="num">${(c.mcap_usd / c.tvl_usd).toPrecision(2)}</td><td class="num">${money(c.fitted_usd)}</td><td class="num ${Math.abs(c.loo_err) <= 0.301 ? 'up' : 'dim'}">${times(c.loo_err)}</td><td>${esc(c.family)}</td></tr>`).join('')}</tbody>`;
  }

  function renderExcluded() {
    $('#count').textContent = `${R.excluded.length} protocols that record no token but are left off by the house rule (wrapped, staked, bridged, exchange or versioned products)`;
    $('#table').innerHTML = `<thead><tr><th>Protocol</th><th class="num">TVL</th><th>Why it is not ranked</th></tr></thead><tbody>${R.excluded.map((e) =>
      `<tr><td><b>${esc(e.name)}</b></td><td class="num">${money(e.tvl_usd)}</td><td>${esc(e.reason)}</td></tr>`).join('')}</tbody>`;
  }

  function renderMethod() {
    $('#count').textContent = 'How every number on this page is made';
    const b = R.fit.beta;
    const fam = Object.entries(R.fit.fam).map(([k, v]) => `<tr><td>family: ${esc(k)}</td><td class="num">${v.toFixed(3)}</td><td class="num">${times(v)}</td></tr>`).join('');
    $('#table').innerHTML = `<thead><tr><th>Term (log10 market cap)</th><th class="num">Coefficient</th><th class="num">Effect</th></tr></thead><tbody>
      <tr><td>base: typical comp (TVL ${money(Math.pow(10, R.fit.mu.lt))}, flat week)</td><td class="num">${b[0].toFixed(3)}</td><td class="num">${money(Math.pow(10, b[0]))}</td></tr>
      <tr><td>log10 TVL, centred</td><td class="num">${b[1].toFixed(3)}</td><td class="num">10× TVL = ${times(b[1])}</td></tr>
      <tr><td>7-day growth (÷100, clamped −50%..+100%)</td><td class="num">${b[2].toFixed(3)}</td><td class="num">+100% = ${times(b[2])}</td></tr>
      <tr><td>log10(1 + years tracked), centred</td><td class="num">${b[3].toFixed(3)}</td><td class="num">2 y vs 0.5 y = ${times(b[3] * (Math.log10(3) - Math.log10(1.5)))}</td></tr>${fam}
      <tr><td>Validation: leave-one-out / naive / walk-forward median error</td><td class="num" colspan="2">${times(V.loo_mad)} / ${times(V.naive_mad)} / ${times(V.wf_mad)}</td></tr>
      <tr><td>Farm assumptions (not in the snapshot)</td><td colspan="2">gas per chain table, ${F.SEASON_DAYS}-day season, ${F.FARMER_SHARE * 100}% of value to depositors, your time at $${F.HOUR_USD}/h</td></tr>
      <tr><td>Farm plan shape</td><td colspan="2">family sets the steps (Trading: weekly volume or LP rebalance; Lending, Vaults, RWA: held balance; Infra: staked asset); chain class sets the transactions (${Object.values(CLASS_NAME).join('; ')})</td></tr>
      <tr><td>Unknown listing date</td><td colspan="2">takes the comps' median age, ${R.median_age_days} days, and the row shows "unknown"</td></tr></tbody>`;
  }

  // ---- detail drawer
  function renderDetail() {
    const r = R.rows.find((x) => x.slug === state.open), el = $('#detail');
    if (!r) { el.hidden = true; return; }
    const p = planOf(r), t = r.terms, base = Math.pow(10, t.base);
    let run = base;
    const step = (label, term, note) => { run *= Math.pow(10, term); return `<tr><td>${label}</td><td class="num">${times(term)}</td><td class="num">${money(run)}</td><td class="dim">${note}</td></tr>`; };
    el.hidden = false;
    el.innerHTML = `<button class="close" data-close aria-label="Close detail">×</button>
      <p class="eyebrow">Rank ${r.rank} of ${R.rows.length}${r.watch ? ' · on the watchlist' : ''} · records no token</p>
      <h2>${esc(r.name)}</h2><p class="sub">${esc(r.category || 'no category')} · ${esc(r.family)} · ${esc(r.chains.join(', '))}</p>
      <div class="kpis"><div><small>Implied value</small><b>${money(r.implied_value_usd)}</b></div><div><small>P25–P75</small><b>${money(r.p25_usd)}–${money(r.p75_usd)}</b></div><div><small>Token odds</small><b>${Math.round(r.token_odds * 100)}%</b></div></div>
      <h3>valueTerms(): the implied value, worked from the snapshot</h3>
      <table class="mini"><thead><tr><th>Term</th><th class="num">×</th><th class="num">Running</th><th>Input</th></tr></thead><tbody>
      <tr><td>Typical priced comp</td><td class="num"></td><td class="num">${money(base)}</td><td class="dim">fit on ${V.n} tokens</td></tr>
      ${step('TVL', t.tvl, money(r.tvl_usd))}${step('7-day growth', t.growth, pct(r.change_7d))}${step('Time with no token', t.age, age(r.age_days))}${step('Family', t.family, esc(r.family))}
      </tbody></table>
      <p class="dim">= ${money(r.implied_value_usd)}, the value board.json carries for rank ${r.rank}. Nearest priced comps: ${r.peers.map((c) => `${esc(c.name)} (TVL ${money(c.tvl_usd)}, mcap ${money(c.mcap_usd)})`).join('; ')}.</p>
      <h3>farmPlan() at ${money(p.deposit)} on ${esc(p.chain)} (${CLASS_NAME[p.cls]}), ${esc(p.asset)} <span class="pill ${p.verdict}">${p.verdict}</span></h3>
      <table class="mini"><thead><tr><th>Step</th><th>Do</th><th class="num">Cost</th><th class="num">Time</th></tr></thead><tbody>
      ${p.steps.map((s) => `<tr><td>${s.step}</td><td>${esc(s.do)}</td><td class="num">${money(s.usd)}</td><td class="num">${s.min} min</td></tr>`).join('')}
      <tr class="tot"><td>Total</td><td>${p.minutes} min of work at $20/h + ${money(p.cash)} cash, over ${p.days} days</td><td class="num">${money(p.cost)}</td><td class="num">${p.minutes} min</td></tr></tbody></table>
      <p class="farmline">Expected drop <b>${money(p.drop)}</b> = ${money(p.deposit)} / (${money(r.tvl_usd)} + deposit) × ${money(r.implied_value_usd)} × ${F.FARMER_SHARE * 100}% × ${Math.round(r.token_odds * 100)}% odds. Net <b class="${p.net >= 0 ? 'up' : 'down'}">${money(p.net)}</b>. Break-even deposit <b>${money(p.breakEven)}</b>.</p>`;
  }

  // ---- render everything from state
  function render() {
    writeHash();
    renderStrips();
    document.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === state.tab)));
    $('#filters').hidden = state.tab !== 'radar';
    $('#q').value = state.q; $('#fam').value = state.fam; $('#chain').value = state.chain; $('#verdict').value = state.verdict;
    $('#watch').checked = state.watch; $('#dep').value = String(Math.round(Math.log10(state.dep) * 100)); $('#depv').textContent = money(state.dep);
    ({ radar: renderRadar, comps: renderComps, excluded: renderExcluded, method: renderMethod })[state.tab]();
    renderDetail();
  }

  function init() {
    readHash();
    $('#asof').textContent = `DefiLlama snapshot ${SNAP.as_of} · model ${R.version}`;
    $('#fam').innerHTML = '<option value="">All families</option>' + families.map((f) => `<option>${esc(f)}</option>`).join('');
    $('#chain').innerHTML = '<option value="">All chains</option>' + chains.map((c) => `<option>${esc(c)}</option>`).join('');
    document.addEventListener('click', (e) => {
      const t = e.target.closest('[data-sort],[data-tab],[data-close],tr[data-slug]');
      if (!t) return;
      if (t.dataset.sort) { state.dir = state.sort === t.dataset.sort ? -state.dir : (t.dataset.sort === 'name' || t.dataset.sort === 'rank' ? 1 : -1); state.sort = t.dataset.sort; }
      else if (t.dataset.tab) { state.tab = t.dataset.tab; state.open = ''; }
      else if (t.hasAttribute('data-close')) state.open = '';
      else state.open = t.dataset.slug;
      render();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.open) { state.open = ''; render(); }
      if (e.key === 'Enter' && e.target.dataset && e.target.dataset.slug) { state.open = e.target.dataset.slug; render(); }
    });
    $('#q').addEventListener('input', (e) => { state.q = e.target.value; render(); });
    for (const id of ['fam', 'chain', 'verdict']) $('#' + id).addEventListener('change', (e) => { state[id] = e.target.value; render(); });
    $('#watch').addEventListener('change', (e) => { state.watch = e.target.checked; render(); });
    $('#dep').addEventListener('input', (e) => { state.dep = Math.round(Math.pow(10, Number(e.target.value) / 100) / 100) * 100; render(); });
    window.addEventListener('hashchange', () => { readHash(); render(); });
    render();
  }
  init();
})();
