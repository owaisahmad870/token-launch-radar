// b-farm.js: the farm planner. farmPlan(row, deposit) turns one radar row into six costed steps
// (dollars and minutes each), an expected drop, a net, a break-even deposit and a verdict.
//
// The snapshot holds no gas prices, no airdrop sizes and no season lengths, so those are ASSUMPTIONS,
// named here, printed on the page, and the same for every protocol:
//   GAS_USD        cost of one transaction per chain (the plan farms on the cheapest chain the row lists)
//   FUND_USD       exchange withdrawal fee to get USDC onto that chain (and the same to leave)
//   SEASON_DAYS    the points season the plan holds through (90 days, one action a week)
//   FARMER_SHARE   share of the token's value that goes to depositors (5%)
//   expected drop  = deposit / (TVL + deposit) x implied value x FARMER_SHARE x token odds
//   HOUR_USD       your time ($20/h): cost = cash (gas + fees) + minutes / 60 x HOUR_USD
//   net            = expected drop - cost;  break-even deposit = cost x TVL / (K - cost), K = value x share x odds
//   verdict        Farm when the drop is at least 2x the cost, Marginal when it covers the cost, Skip otherwise.
(function (root) {
  'use strict';

  const GAS_USD = {
    Ethereum: 2.5, Bitcoin: 3, Tron: 1.5, Binance: 0.1, BSC: 0.1, Polygon: 0.02, Avalanche: 0.05, Solana: 0.01,
    Sui: 0.01, Aptos: 0.01, TON: 0.05, Sonic: 0.02, Hyperliquid: 0.02, 'Hyperliquid L1': 0.02, Stellar: 0.01, Near: 0.01,
    Arbitrum: 0.05, Base: 0.03, 'OP Mainnet': 0.05, Optimism: 0.05, Linea: 0.05, Scroll: 0.05, 'zkSync Era': 0.05, Blast: 0.05,
    Mantle: 0.05, Ink: 0.03, Unichain: 0.03, Katana: 0.03, Plasma: 0.02, Berachain: 0.03, Monad: 0.02, MegaETH: 0.02,
    Sei: 0.01, Celo: 0.01, Fantom: 0.01, xDai: 0.01, Gnosis: 0.01, Kava: 0.01, Flare: 0.01, Ripple: 0.01, Cardano: 0.2,
    Cronos: 0.05, Hemi: 0.05, Metis: 0.05, Moonbeam: 0.02, 'Robinhood Chain': 0.03, Arc: 0.02, 'X Layer': 0.02,
    'Plume Mainnet': 0.02, Starknet: 0.05, Doge: 0.5, Litecoin: 0.05,
  };
  const DEFAULT_GAS = 0.3;        // a chain not in the table
  const FUND_USD = (chain) => (chain === 'Ethereum' || chain === 'Bitcoin' ? 4 : 1);
  const SEASON_DAYS = 90, WEEKS = Math.round(SEASON_DAYS / 7);
  const FARMER_SHARE = 0.05;
  const HOUR_USD = 20;            // your time, priced into the cost: 125 minutes of work is not free
  const PERP_FEE = 0.0005, SWAP_FEE = 0.003; // taker fee on weekly perp volume; swap fee to enter an LP
  const DEFAULT_DEPOSIT = 10000;

  const gasOf = (chain) => (chain in GAS_USD ? GAS_USD[chain] : DEFAULT_GAS);

  // The cheapest chain the protocol lists (ties: the one it lists first).
  function cheapestChain(chains) {
    if (!chains || chains.length === 0) return { chain: 'its main chain', gas: DEFAULT_GAS };
    let best = chains[0];
    chains.forEach((c) => { if (gasOf(c) < gasOf(best)) best = c; });
    return { chain: best, gas: gasOf(best) };
  }

  // No toLocaleString: main.ts and the browser must print the same bytes whatever the locale.
  const usd = (n) => '$' + (n >= 100 ? String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : n.toFixed(2));

  // The family's entry action: what to do, and any fee beyond gas.
  function entryAction(row, d, chain) {
    const c = row.category || '', n = row.name;
    if (row.family === 'Lending') return { text: `Supply ${usd(d)} USDC to ${n}'s main market on ${chain}; borrow nothing, so nothing can be liquidated.`, fee: 0 };
    if (c === 'Dexs') return { text: `Swap half to the pool's other asset and add ${usd(d)} of liquidity to ${n}'s deepest USDC pool on ${chain}.`, fee: d / 2 * SWAP_FEE };
    if (c === 'Derivatives') return { text: `Deposit ${usd(d)} USDC margin on ${n} (${chain}) and open a delta-neutral pair: a long and a short of equal size.`, fee: 0 };
    if (row.family === 'Trading') return { text: `Deposit ${usd(d)} USDC into ${n} on ${chain} and make one trade.`, fee: 0 };
    if (row.family === 'Vaults') return { text: `Deposit ${usd(d)} USDC into ${n}'s largest USDC vault on ${chain} and keep the vault shares.`, fee: 0 };
    if (row.family === 'RWA & stables') return { text: `Mint or buy ${usd(d)} of ${n}'s yield-bearing asset with USDC on ${chain} and hold it.`, fee: 0 };
    if (row.family === 'Infra') return { text: `Stake or deposit ${usd(d)} of the asset ${n} accepts on ${chain} and keep the receipt.`, fee: 0 };
    return { text: `Deposit ${usd(d)} USDC into ${n}'s app on ${chain} and keep the position open.`, fee: 0 };
  }

  // farmPlan: one row, one deposit in, six steps out, each {step, do, usd, min}.
  function farmPlan(row, deposit) {
    const d = deposit || DEFAULT_DEPOSIT, { chain, gas } = cheapestChain(row.chains), fund = FUND_USD(chain);
    const entry = entryAction(row, d, chain);
    const weekly = row.category === 'Derivatives' ? d * PERP_FEE * WEEKS : 0;
    const steps = [
      { step: 'Fund', do: `Withdraw ${usd(d)} USDC from an exchange to a fresh wallet on ${chain} (${row.chains.length > 1 ? `the cheapest of its ${row.chains.length} chains` : 'its only chain'}).`, usd: fund, min: 10 },
      { step: 'Enter', do: entry.text + ' Two transactions: approve, then deposit.', usd: 2 * gas + entry.fee, min: 10 },
      { step: 'Qualify', do: `Make one qualifying action a week for ${WEEKS} weeks (top up, claim or ${row.category === 'Derivatives' ? 'roll the pair once, volume = deposit' : 'restake'}), one transaction each.`, usd: WEEKS * gas + weekly, min: WEEKS * 5 },
      { step: 'Track', do: `Check ${row.name}'s own points or rewards page once a month for the ${SEASON_DAYS}-day season and log the balance.`, usd: 0, min: 15 },
      { step: 'Exit', do: `Withdraw the position and send the USDC back to the exchange.`, usd: 2 * gas + fund, min: 15 },
      { step: 'Claim', do: `If a token is announced, claim only through the link on ${row.name}'s own site; never sign a transfer to claim.`, usd: gas, min: 10 },
    ];
    const cash = steps.reduce((s, x) => s + x.usd, 0), minutes = steps.reduce((s, x) => s + x.min, 0);
    const cost = cash + minutes / 60 * HOUR_USD;
    const K = row.implied_value_usd * FARMER_SHARE * row.token_odds;
    const drop = d / (row.tvl_usd + d) * K;
    const net = drop - cost;
    const breakEven = K > cost ? cost * row.tvl_usd / (K - cost) : Infinity;
    const verdict = drop >= 2 * cost ? 'Farm' : drop >= cost ? 'Marginal' : 'Skip';
    return { chain, deposit: d, steps, cash, cost, minutes, days: SEASON_DAYS, drop, net, breakEven, verdict };
  }

  // The plan as board.json's farm_steps: each step with its cost and time, then the verdict line.
  function planStrings(plan) {
    const lines = plan.steps.map((s, i) => `${i + 1}. ${s.step}: ${s.do} Cost ${usd(s.usd)}; time ${s.min} min.`);
    const be = Number.isFinite(plan.breakEven) ? usd(plan.breakEven) : 'none (the drop never covers the cost)';
    lines.push(`Verdict at a ${usd(plan.deposit)} deposit: ${plan.verdict}. Expected drop ${usd(plan.drop)} vs cost ${usd(plan.cost)} (${usd(plan.cash)} cash + ${plan.minutes} min at $${HOUR_USD}/h), net ${plan.net < 0 ? '-' : ''}${usd(Math.abs(plan.net))} over ${plan.days} days; break-even deposit ${be}.`);
    return lines;
  }

  const FarmModel = { GAS_USD, DEFAULT_GAS, SEASON_DAYS, FARMER_SHARE, DEFAULT_DEPOSIT, cheapestChain, farmPlan, planStrings, usd };
  if (typeof module === 'object' && module.exports) module.exports = FarmModel; else root.FarmModel = FarmModel;
})(typeof window !== 'undefined' ? window : globalThis);
