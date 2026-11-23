// b-farm.js: the farm planner. farmPlan(row, deposit) builds one plan per protocol from two things the
// snapshot gives: its family (from the category) and the chain class of its cheapest chain. Every step
// carries dollars and minutes; the plan ends in an expected drop, a net, a break-even and a verdict.
//
// Chain class -> how money gets in:     evm: approve + deposit (2 transactions)
//   onetx: one signed transaction (Solana, Sui, Aptos, Starknet...)   ledger: add a USDC trustline first
//   hl: USDC goes in through Hyperliquid's bridge from Arbitrum     btc: the position is BTC, not USDC
//   app: any other chain: the protocol's own deposit flow (1 transaction at the default gas)
// Family -> what keeps the position counted:
//   Trading: weekly volume (perps: open + close a hedged pair; DEX: rebalance the LP range)
//   Lending, Vaults, RWA & stables: balance held for the season, checked monthly
//   Infra: staking categories stake the chain's asset (unbonding wait); a Chain row bridges USDC in and lends it
//
// ASSUMPTIONS (not in the snapshot; the same for every row, printed on the page):
//   GAS_USD per chain, SEASON_DAYS 90, FARMER_SHARE 5% of the token's value to depositors,
//   HOUR_USD $20 for your time, PERP_FEE 0.05% taker, SWAP_FEE 0.3%.
//   expected drop = deposit / (TVL + deposit) x implied value x FARMER_SHARE x token odds
//   cost = cash + minutes / 60 x HOUR_USD;  net = drop - cost;  break-even = cost x TVL / (K - cost)
//   verdict: Farm when drop >= 2x cost, Marginal when drop >= cost, else Skip.
(function (root) {
  'use strict';

  const GAS_USD = {
    Ethereum: 2.5, Bitcoin: 3, Tron: 1.5, Binance: 0.1, BSC: 0.1, Polygon: 0.02, Avalanche: 0.05, Solana: 0.01,
    Sui: 0.01, Aptos: 0.01, TON: 0.05, Sonic: 0.02, 'Hyperliquid L1': 0.02, Stellar: 0.01, Near: 0.01,
    Arbitrum: 0.05, Base: 0.03, 'OP Mainnet': 0.05, Optimism: 0.05, Linea: 0.05, Scroll: 0.05, 'zkSync Era': 0.05, Blast: 0.05,
    Mantle: 0.05, Ink: 0.03, Unichain: 0.03, Katana: 0.03, Plasma: 0.02, Berachain: 0.03, Monad: 0.02, MegaETH: 0.02,
    Sei: 0.01, Celo: 0.01, Fantom: 0.01, xDai: 0.01, Gnosis: 0.01, Kava: 0.01, Flare: 0.01, Ripple: 0.01, Cardano: 0.2,
    Cronos: 0.05, Hemi: 0.05, Metis: 0.05, Moonbeam: 0.02, 'Robinhood Chain': 0.03, Arc: 0.02, 'X Layer': 0.02,
    'Plume Mainnet': 0.02, Starknet: 0.05, Doge: 0.5, Litecoin: 0.05, Algorand: 0.01, Stacks: 0.5,
  };
  const EVM = new Set(['Ethereum', 'Binance', 'BSC', 'Polygon', 'Avalanche', 'Sonic', 'Arbitrum', 'Base', 'OP Mainnet', 'Optimism',
    'Linea', 'Scroll', 'zkSync Era', 'Blast', 'Mantle', 'Ink', 'Unichain', 'Katana', 'Plasma', 'Berachain', 'Monad', 'MegaETH',
    'Sei', 'Celo', 'Fantom', 'xDai', 'Gnosis', 'Flare', 'Cronos', 'Hemi', 'Metis', 'Moonbeam', 'Robinhood Chain', 'Arc', 'X Layer',
    'Plume Mainnet', 'Manta', 'Ronin', 'Klaytn', 'RISE', 'Tempo', 'Reya Network', 'Fluent', 'CORE', 'RSK', 'BSquared', 'Mezo']);
  const ONETX = new Set(['Solana', 'Sui', 'Aptos', 'TON', 'Near', 'Starknet', 'Tron']);
  const LEDGER = new Set(['Stellar', 'Ripple', 'Algorand']);
  const BTC_CHAINS = new Set(['Bitcoin', 'Stacks']);
  const BTC_CATEGORIES = new Set(['Anchor BTC', 'Decentralized BTC', 'Restaked BTC']);
  // Categories whose position is a staked asset, or a minted yield asset (with issuer onboarding).
  const STAKE_CATEGORIES = new Set(['Staking Pool', 'Restaking', 'Liquid Staking', 'Liquid Restaking']);
  const MINT_CATEGORIES = new Set(['RWA', 'Stablecoin Wrapper', 'Dual-Token Stablecoin']);
  const DEFAULT_GAS = 0.3;
  const SEASON_DAYS = 90, WEEKS = 13, MONTHS = 3;
  const FARMER_SHARE = 0.05, HOUR_USD = 20, PERP_FEE = 0.0005, SWAP_FEE = 0.003;
  const DEFAULT_DEPOSIT = 10000;

  const gasOf = (c) => (c in GAS_USD ? GAS_USD[c] : DEFAULT_GAS);
  const classOf = (c) => (c === 'Hyperliquid L1' ? 'hl' : EVM.has(c) ? 'evm' : ONETX.has(c) ? 'onetx' : LEDGER.has(c) ? 'ledger' : BTC_CHAINS.has(c) ? 'btc' : 'app');

  // The cheapest chain the protocol lists (ties: the one it lists first).
  function cheapestChain(chains) {
    if (!chains || chains.length === 0) return { chain: 'its main chain', gas: DEFAULT_GAS, cls: 'app' };
    let best = chains[0];
    chains.forEach((c) => { if (gasOf(c) < gasOf(best)) best = c; });
    return { chain: best, gas: gasOf(best), cls: classOf(best) };
  }

  // No toLocaleString: main.ts and the browser must print the same bytes whatever the locale.
  const usd = (n) => '$' + (n >= 100 ? String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : n.toFixed(2));

  // farmPlan: one row and one deposit in; the plan's steps {step, do, usd, min}, totals and verdict out.
  function farmPlan(row, deposit) {
    const d = deposit || DEFAULT_DEPOSIT, { chain, gas, cls } = cheapestChain(row.chains), n = row.name;
    const c = row.category, stake = row.family === 'Infra' && STAKE_CATEGORIES.has(c), mint = MINT_CATEGORIES.has(c);
    const btc = cls === 'btc' || BTC_CATEGORIES.has(c), asset = btc ? 'BTC' : stake ? `${chain}'s staking asset` : 'USDC';
    const steps = [], add = (step, text, cost, min) => steps.push({ step, do: text, usd: cost, min });
    const fundFee = chain === 'Ethereum' || btc ? 4 : 1;

    // 1. Money onto the chain, by chain class.
    if (cls === 'hl') {
      add('Fund', `Withdraw ${usd(d)} USDC from an exchange to Arbitrum, then send it through Hyperliquid's bridge to your Hyperliquid account.`, 1 + GAS_USD.Arbitrum, 15);
    } else if (cls === 'app') {
      add('Fund', `Move ${usd(d)} onto ${chain} in the asset its apps take, by exchange withdrawal where one exists, else the chain's own bridge.`, fundFee, 15);
    } else {
      add('Fund', `Withdraw ${usd(d)} of ${btc ? 'BTC' : 'USDC'} from an exchange to a fresh wallet on ${chain} (${row.chains.length > 1 ? `cheapest of its ${row.chains.length} chains` : 'its only chain'}).`, fundFee, 10);
    }
    if (cls === 'ledger') add('Trustline', `Add the USDC trustline (opt-in) to the wallet before funds arrive; the chain locks a small reserve.`, 0.5, 5);
    if (asset.endsWith('staking asset')) add('Swap', `Swap the USDC to ${asset} on a DEX on ${chain}.`, d * SWAP_FEE + gas, 5);
    if (mint) add('Onboard', `Complete ${n}'s issuer onboarding (KYC or wallet whitelist) if its app asks for it before minting.`, 0, 30);

    // 2. The entry, by family; transactions by chain class.
    const tx = cls === 'evm' ? 2 : 1;
    const how = cls === 'evm' ? ' Two transactions: approve, then deposit.' : cls === 'app' ? " Follow the app's deposit flow." : ' One signed transaction.';
    if (row.category === 'Dexs') {
      add('Enter', `Swap into the two assets of ${n}'s deepest pool on ${chain} and add ${usd(d)} of liquidity.${how}`, d * SWAP_FEE + (tx + 1) * gas, 15);
      add('Rebalance', `Each week, check the LP range and re-center it if price left it: about ${WEEKS} checks, half needing 2 transactions.`, WEEKS * gas, WEEKS * 8);
    } else if (row.category === 'Derivatives') {
      add('Enter', `Deposit ${usd(d)} USDC margin on ${n} (${chain}).${how}`, tx * gas, 10);
      add('Volume', `Each week, open and close a delta-neutral pair (long and short, ${usd(d / 2)} each): ${usd(2 * d)} of taker volume a week.`, WEEKS * 2 * d * PERP_FEE, WEEKS * 10);
    } else if (row.family === 'Trading') {
      add('Enter', `Deposit ${usd(d)} USDC into ${n} on ${chain}.${how}`, tx * gas, 10);
      add('Activity', `Each week, make one trade of about ${usd(d / 10)} so the account shows use, not only a balance.`, WEEKS * (d / 10 * SWAP_FEE + gas), WEEKS * 5);
    } else {
      const verb = c === 'CDP' || c === 'CDP Manager' ? `Lock ${usd(d)} of collateral ${n} accepts on ${chain}, mint its stablecoin at under 40% loan-to-value, and hold it.`
        : c === 'Collateral Markets' || c === 'Collateral Management' ? `Deposit ${usd(d)} of an asset ${n}'s vaults accept on ${chain} and keep the receipt.`
        : c === 'Chain' ? `Supply the ${usd(d)} ${asset} now on ${chain} to the largest lending market there, so the chain's own activity counts it.`
        : c === 'Payments' ? `Fund a ${n} wallet or channel with ${usd(d)} ${asset} on ${chain}; make one small payment a month.`
        : row.family === 'Lending' ? `Supply ${usd(d)} ${asset} to ${n}'s main market on ${chain}; borrow nothing, so nothing can be liquidated.`
        : row.family === 'Vaults' ? `Deposit ${usd(d)} ${asset} into ${n}'s largest ${asset} vault on ${chain} and keep the shares.`
        : mint ? `Mint or buy ${usd(d)} of ${n}'s yield-bearing asset with USDC on ${chain} and hold it.`
        : stake ? `Stake ${usd(d)} of ${asset} through ${n} on ${chain} and keep the receipt.`
        : `Deposit ${usd(d)} ${asset} into ${n}'s app on ${chain} and keep the position open.`;
      add('Enter', verb + how, tx * gas, 10);
      add('Hold', `Hold the balance for the ${SEASON_DAYS}-day season; once a month, check ${n}'s app for a points or rewards balance and log it.`, 0, MONTHS * 5);
    }

    // 3. Out, and the claim.
    const wait = stake ? ` Unstaking waits the protocol's stated unbonding period.` : row.family === 'Vaults' ? ' Some vaults queue withdrawals for days.' : '';
    const back = asset.endsWith('staking asset') || row.category === 'Dexs' ? ', swap back to USDC' : '';
    add('Exit', `Withdraw the position${back} and send the ${btc ? 'BTC' : 'USDC'} back to the exchange.${wait}`, tx * gas + fundFee + (back ? d * SWAP_FEE : 0), 15);
    add('Claim', `If a token is announced, claim only through the link on ${n}'s own site; never sign a transfer to claim.`, gas, 10);

    const cash = steps.reduce((s, x) => s + x.usd, 0), minutes = steps.reduce((s, x) => s + x.min, 0);
    const cost = cash + minutes / 60 * HOUR_USD;
    const K = row.implied_value_usd * FARMER_SHARE * row.token_odds;
    const drop = d / (row.tvl_usd + d) * K, net = drop - cost;
    const breakEven = K > cost ? cost * row.tvl_usd / (K - cost) : Infinity;
    const verdict = drop >= 2 * cost ? 'Farm' : drop >= cost ? 'Marginal' : 'Skip';
    return { chain, cls, asset, deposit: d, steps, cash, cost, minutes, days: SEASON_DAYS, drop, net, breakEven, verdict };
  }

  // The plan as board.json's farm_steps: each step with its cost and time, then the verdict line.
  function planStrings(plan) {
    const lines = plan.steps.map((s, i) => `${i + 1}. ${s.step}: ${s.do} Cost ${usd(s.usd)}; time ${s.min} min.`);
    const be = Number.isFinite(plan.breakEven) ? usd(plan.breakEven) : 'none (the drop never covers the cost)';
    lines.push(`Verdict at a ${usd(plan.deposit)} deposit: ${plan.verdict}. Expected drop ${usd(plan.drop)} vs cost ${usd(plan.cost)} (${usd(plan.cash)} cash + ${plan.minutes} min at $${HOUR_USD}/h), net ${plan.net < 0 ? '-' : ''}${usd(Math.abs(plan.net))} over ${plan.days} days; break-even deposit ${be}.`);
    return lines;
  }

  // planCensus: the proof line. Every step of every row counted, each with $ and minutes; how many
  // distinct plan shapes (step lists) the families and chain classes produce.
  function planCensus(rows, deposit) {
    let steps = 0, priced = 0;
    const shapes = new Set(), mins = [];
    rows.forEach((r) => {
      const p = farmPlan(r, deposit);
      steps += p.steps.length;
      priced += p.steps.filter((s) => Number.isFinite(s.usd) && s.min > 0).length;
      shapes.add(p.cls + ':' + p.steps.map((s) => s.step).join('>'));
      mins.push(p.minutes);
    });
    return { rows: rows.length, steps, priced, shapes: shapes.size, minMin: Math.min(...mins), maxMin: Math.max(...mins) };
  }

  const FarmModel = { GAS_USD, DEFAULT_GAS, SEASON_DAYS, FARMER_SHARE, HOUR_USD, DEFAULT_DEPOSIT, cheapestChain, farmPlan, planStrings, planCensus, usd };
  if (typeof module === 'object' && module.exports) module.exports = FarmModel; else root.FarmModel = FarmModel;
})(typeof window !== 'undefined' ? window : globalThis);
