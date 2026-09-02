/**
 * Delta protocol collector — the maths, with no environment dependencies.
 *
 * This module runs unchanged in Node (the scheduled snapshot) and in the browser
 * (the dashboard's live refresh). Keeping one implementation is deliberate: two
 * copies of this arithmetic would drift, and a dashboard that disagrees with its
 * own data file is worse than one that is merely stale.
 *
 * Everything here uses only fetch, BigInt and TextDecoder.
 *
 * Sources
 *   1. deltaliquidity.app  - the app's own read API
 *   2. Robinhood Chain RPC - eth_call for pool, vault and farm state
 *   3. Blockscout          - token metadata and the holder list
 */

export const CFG = {
  delta: 'https://deltaliquidity.app',
  // globalThis.process guard: this module also runs in the browser.
  rpc: (typeof process !== 'undefined' && process.env?.RHC_RPC) || 'https://rpc.mainnet.chain.robinhood.com',
  scout: 'https://robinhoodchain.blockscout.com',

  DELTA: '0xe8ffd7e24187f72afb08d75b1bb13088a989a791', // $DELTA token
  DELTA_POOL: '0xd64fbda67e1015df43fa5e49f02ca844729e5f94', // DELTA/WETH 1%
  WETH: '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
  USDG: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  // Deepest WETH/USDG pool on the chain (~$15M). Delta names this same address as
  // its own `ethRatePool`; we read it directly rather than trusting a cached
  // number, because /stats.ethUsd has been observed frozen for 55 hours and every
  // USD figure on this page is scaled by it.
  ETH_RATE_POOL: '0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca',

  // Balances held here are treated as non-circulating. Auditable: every address
  // is echoed into latest.json under delta.supply.excluded.
  NON_CIRCULATING: {
    '0xd0f7d8c6e9f6d80c297bebe4f7fd1b9c8125c32f': 'RobinhoodLocker',
    '0x0000000000000000000000000000000000000000': 'zero address',
    '0x000000000000000000000000000000000000dead': 'burn address',
  },

  DEPTH_BANDS: [0.02, 0.05], // +/- price bands for the liquidity depth walk
  TOP_POOLS: 25,
  HOLDER_PAGES: 2, // 50 holders per page
  HISTORY_CAP: 8760, // ~1 year of hourly rows
  CANDLE_DAYS: 120, // how far back to pull Delta's daily price candles
};

// -------------------------------------------------------------- utilities ---

const SEL = {
  slot0: '0x3850c7bd',
  liquidity: '0x1a686502',
  ticks: '0xf30dba93',
  tickSpacing: '0xd0c93a7c',
  token0: '0x0dfe1681',
  token1: '0xd21220a7',
  fee: '0xddca3f43',
  totalSupply: '0x18160ddd',
  balanceOf: '0x70a08231',
  decimals: '0x313ce567',
  // Delta vault (unverified, selectors probed against the deployed bytecode)
  vaultPool: '0x16f0115b',
  tickLower: '0x59c4f905',
  tickUpper: '0x55b812a8',
  totalLiquidity: '0x15770f92',
  // Delta farm
  periodFinish: '0xebe2b12b',
  rewardRate: '0x7b0a47ee',
  symbol: '0x95d89b41',
};

// Farm rewardRate is stored with 1e36 precision (verified against the rate that
// /ix/farms/metrics reports for the one farm with a settled distribution window).
const REWARD_RATE_SCALE = 1e36;

const Q96 = 2 ** 96;
const pad = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const encAddr = (sel, a) => sel + pad(a);
const encInt24 = (sel, n) => {
  const v = BigInt(n) < 0n ? (1n << 256n) + BigInt(n) : BigInt(n);
  return sel + v.toString(16).padStart(64, '0');
};

const word = (hex, i) => (hex ? '0x' + hex.replace(/^0x/, '').slice(i * 64, (i + 1) * 64) : '0x');
const uint = (hex) => (hex && hex !== '0x' ? BigInt(hex) : 0n);
const int = (hex) => {
  let v = uint(hex);
  return v >= 1n << 255n ? v - (1n << 256n) : v;
};
const num = (bi, dec = 18) => Number(bi) / 10 ** dec;

/** Decode an ABI-encoded string return value. */
const decodeString = (hex) => {
  if (!hex || hex === '0x') return null;
  try {
    const b = hex.replace(/^0x/, '');
    const len = Number(BigInt('0x' + b.slice(64, 128)));
    const data = b.slice(128, 128 + len * 2);
    const bytes = new Uint8Array(data.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(data.substr(i * 2, 2), 16);
    return new TextDecoder().decode(bytes).replace(/\0/g, '') || null;
  } catch {
    return null;
  }
};

const nowSec = () => Math.floor(Date.now() / 1000);

async function jget(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      // No custom headers: keeps these as CORS-simple requests, so the browser
      // build never depends on the server answering a preflight.
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return await r.json();
    } catch (e) {
      last = e;
      await new Promise((s) => setTimeout(s, 800 * (i + 1)));
    }
  }
  throw last;
}

/** Batched eth_call. calls: [{to, data}] -> array of hex results (null on revert).
 *  The public RPC rejects batches somewhere above 50 calls, so keep chunks small. */
async function ethCallBatch(calls, chunk = 25) {
  const out = new Array(calls.length).fill(null);
  for (let off = 0; off < calls.length; off += chunk) {
    const slice = calls.slice(off, off + chunk);
    const body = slice.map((c, i) => ({
      jsonrpc: '2.0',
      id: i + 1,
      method: 'eth_call',
      params: [{ to: c.to, data: c.data }, 'latest'],
    }));
    let res;
    for (let t = 0; t < 3; t++) {
      try {
        const r = await fetch(CFG.rpc, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error('rpc ' + r.status);
        res = await r.json();
        break;
      } catch (e) {
        if (t === 2) throw e;
        await new Promise((s) => setTimeout(s, 800 * (t + 1)));
      }
    }
    for (const r of res) {
      if (r.result && r.result !== '0x') out[off + r.id - 1] = r.result;
    }
  }
  return out;
}

async function blockNumber() {
  const r = await fetch(CFG.rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
  });
  return Number(BigInt((await r.json()).result));
}

// ------------------------------------------------------- uniswap v3 math ---

const tickToSqrt = (t) => Math.pow(1.0001, t / 2);

/** Token amounts held by liquidity L over [tl, tu] at the current sqrt price. */
function amountsForLiquidity(L, sqrtP, tl, tu) {
  const a = tickToSqrt(tl);
  const b = tickToSqrt(tu);
  if (sqrtP <= a) return { amount0: L * (1 / a - 1 / b), amount1: 0 };
  if (sqrtP >= b) return { amount0: 0, amount1: L * (b - a) };
  return { amount0: L * (1 / sqrtP - 1 / b), amount1: L * (sqrtP - a) };
}

/**
 * Walk initialised ticks outward from spot to measure how much capital sits
 * within a price band. Returns USD on each side.
 *
 * token0 sits above the current tick (it is what gets bought as price rises),
 * token1 sits below it.
 */
async function liquidityDepth(pool, tick, spacing, liquidity, band, p0Usd, p1Usd, d0, d1) {
  const span = Math.ceil(Math.log(1 + band) / Math.log(1.0001));
  const hi = tick + span;
  const lo = tick - span;

  // Only multiples of tickSpacing can be initialised.
  const first = Math.ceil((tick + 1) / spacing) * spacing;
  const upTicks = [];
  for (let t = first; t <= hi + spacing; t += spacing) upTicks.push(t);
  const lastDown = Math.floor(tick / spacing) * spacing;
  const downTicks = [];
  for (let t = lastDown; t >= lo - spacing; t -= spacing) downTicks.push(t);

  const calls = [...upTicks, ...downTicks].map((t) => ({
    to: pool,
    data: encInt24(SEL.ticks, t),
  }));
  const res = await ethCallBatch(calls);
  const net = new Map();
  [...upTicks, ...downTicks].forEach((t, i) => {
    const r = res[i];
    net.set(t, r ? Number(int(word(r, 1))) : 0);
  });

  // Upward: accumulate token0 between spot and hi.
  let L = Number(liquidity);
  let cur = tick;
  let amt0 = 0;
  for (const t of upTicks) {
    const top = Math.min(t, hi);
    if (top > cur && L > 0) amt0 += amountsForLiquidity(L, tickToSqrt(cur), cur, top).amount0;
    if (t >= hi) break;
    cur = t;
    L += net.get(t) || 0;
  }

  // Downward: accumulate token1 between lo and spot.
  L = Number(liquidity);
  cur = tick;
  let amt1 = 0;
  for (const t of downTicks) {
    const bot = Math.max(t, lo);
    if (cur > bot && L > 0) amt1 += amountsForLiquidity(L, tickToSqrt(cur), bot, cur).amount1;
    if (t <= lo) break;
    L -= net.get(t) || 0;
    cur = t;
  }

  const usd0 = (amt0 / 10 ** d0) * p0Usd;
  const usd1 = (amt1 / 10 ** d1) * p1Usd;
  return { token0Usd: usd0, token1Usd: usd1, totalUsd: usd0 + usd1 };
}

/**
 * ETH/USD, read from the deepest WETH/USDG pool on the chain.
 *
 * Delta's own /stats.ethUsd is a cached value that has been seen 55 hours stale,
 * and every USD figure in a snapshot is scaled by this number, so a stale rate
 * silently inflates market cap, TVL, fees, depth and APR together (2.5% at the
 * time this was written). Preference order: chain, Delta's live USDG feed, then
 * the cached /stats value as a last resort.
 */
async function ethUsdPrice(stats, usdgFeed, callBatch) {
  const pool = usdgFeed?.ethRatePool || CFG.ETH_RATE_POOL;
  try {
    const [s0, t0] = await callBatch([
      { to: pool, data: SEL.slot0 },
      { to: pool, data: SEL.token0 },
    ]);
    if (s0 && t0) {
      const sqrtP = Number(uint(word(s0, 0))) / Q96;
      const zeroIsWeth = ('0x' + word(t0, 0).slice(-40)).toLowerCase() === CFG.WETH;
      // token1 per token0 in raw units; WETH is 18dp, USDG 6dp.
      const p1PerP0 = sqrtP * sqrtP * 10 ** ((zeroIsWeth ? 18 : 6) - (zeroIsWeth ? 6 : 18));
      const px = zeroIsWeth ? p1PerP0 : 1 / p1PerP0;
      if (px > 10 && px < 100000) {
        return { ethUsd: px, source: 'chain:' + pool, apiEthUsd: stats?.ethUsd ?? null };
      }
    }
  } catch {
    /* fall through */
  }
  if (usdgFeed?.ethUsd > 0) {
    return { ethUsd: usdgFeed.ethUsd, source: 'delta:usdg-feed', apiEthUsd: stats?.ethUsd ?? null };
  }
  return { ethUsd: stats?.ethUsd, source: 'delta:stats (may be stale)', apiEthUsd: stats?.ethUsd ?? null };
}

// ----------------------------------------------------------- direction ----

/**
 * Rate-of-change read built from the rolling windows in a single snapshot, so it
 * works from the very first collection instead of waiting for history.
 *
 * Each window is converted to a per-hour rate; comparing a short window against a
 * long one says whether activity is running above or below its own recent norm.
 */
export function momentum(w) {
  const rate = (win, hours) => (w[win]?.feesUsd != null ? w[win].feesUsd / hours : null);
  const openRate = (win, hours) => (w[win]?.opened != null ? w[win].opened / hours : null);
  const ratio = (a, b) => (a != null && b > 0 ? a / b : null);

  const fee4 = rate('4h', 4), fee24 = rate('24h', 24), fee7 = rate('7d', 168), fee30 = rate('30d', 720);
  const open4 = openRate('4h', 4), open24 = openRate('24h', 24), open7 = openRate('7d', 168);
  return {
    feesPerHour: { h4: fee4, h24: fee24, d7: fee7, d30: fee30 },
    openedPerHour: { h4: open4, h24: open24, d7: open7 },
    // >1 means the shorter, more recent window is running hotter
    feeVsWeek: ratio(fee24, fee7),
    feeVsDay: ratio(fee4, fee24),
    lpVsWeek: ratio(open24, open7),
    lpVsDay: ratio(open4, open24),
  };
}

/**
 * A plain-language read on which way the protocol is moving.
 *
 * Deliberately describes what the data did, never what price will do. Signals are
 * scored the same way every run so the wording cannot drift with mood, and the
 * inputs are returned alongside the verdict so anyone can check the reasoning.
 */
export function direction(snap, history = []) {
  const m = snap.momentum;
  const sig = [];
  const score = (label, v, hi, lo, up, down) => {
    if (v == null || !isFinite(v)) return;
    const s = v >= hi ? 1 : v <= lo ? -1 : 0;
    sig.push({ label, value: v, score: s, text: s > 0 ? up : s < 0 ? down : null });
  };

  score('fees vs weekly pace', m.feeVsWeek, 1.15, 0.85,
    'fee generation is running above its weekly pace', 'fee generation has slowed below its weekly pace');
  score('fees, last 4h', m.feeVsDay, 1.15, 0.85,
    'the last four hours are busier than the day behind them', 'the last four hours are quieter than the day behind them');
  score('new positions', m.lpVsWeek, 1.15, 0.85,
    'LPs are opening positions faster than the weekly average', 'LPs are opening fewer positions than the weekly average');

  // Trend signals, only once there is enough history to mean anything.
  const rows = history.filter((r) => r.ts <= snap.ts).slice(-43); // ~7 days of 4-hourly rows
  if (rows.length >= 6) {
    const first = rows[0], last = rows[rows.length - 1];
    const chg = (k) => (first[k] > 0 && last[k] != null ? last[k] / first[k] - 1 : null);
    score('TVL trend', 1 + (chg('managedTvlUsd') ?? 0), 1.05, 0.95,
      'TVL has grown over the past week', 'TVL has drained over the past week');
    score('holder trend', 1 + (chg('holders') ?? 0), 1.02, 0.995,
      'the holder count is still rising', 'the holder count is falling');
  }

  const total = sig.reduce((s, x) => s + x.score, 0);
  const state = total >= 2 ? 'expanding' : total <= -2 ? 'cooling' : 'steady';

  // Lead with the strongest supporting signal, then the standing caveat, so the
  // summary never reads as a one-sided pitch.
  const supporting = sig.filter((s) => s.score === (total >= 0 ? 1 : -1) && s.text);
  const lead = supporting.length
    ? supporting[0].text[0].toUpperCase() + supporting[0].text.slice(1)
    : 'Activity is tracking close to its recent averages';
  const second = supporting[1]?.text ? `, and ${supporting[1].text}` : '';

  const activePct = snap.delta.liquidity.activePct;
  const runway = Math.min(
    ...snap.staking.farms.filter((f) => f.streaming).map((f) => f.rewardsEndsInDays ?? Infinity),
    Infinity
  );
  const caveats = [];
  if (activePct != null && activePct < 5) {
    caveats.push(`only ${activePct.toFixed(1)}% of the DELTA pool sits within ±2% of spot, so size still moves the price`);
  }
  if (isFinite(runway) && runway < 3) {
    caveats.push(`staking rewards are funded for another ${runway.toFixed(1)} days`);
  }
  if (snap.delta.holders.top10WalletsPct > 25) {
    caveats.push(`the ten largest wallets hold ${snap.delta.holders.top10WalletsPct.toFixed(0)}% of supply`);
  }

  const headline = { expanding: 'Expanding', cooling: 'Cooling off', steady: 'Holding steady' }[state];
  const summary = `${lead}${second}.` + (caveats.length ? ` Worth knowing: ${caveats[0]}.` : '');

  return { state, headline, summary, score: total, signals: sig };
}

// --------------------------------------------------------------- collect ---

/**
 * @param {object} opts
 *   history          previous rows, used only for the trend signals in direction()
 *   topologyFallback farm topology from a prior snapshot. /api/* is not CORS-open,
 *                    so a browser cannot fetch it and passes the cached copy instead.
 */
export async function collect(opts = {}) {
  const { history = [], topologyFallback = null } = Array.isArray(opts) ? { history: opts } : opts;
  const ts = nowSec();

  const [stats, tvl, pools, topology, farmMetrics, usdgFeed, block] = await Promise.all([
    jget(`${CFG.delta}/stats`),
    jget(`${CFG.delta}/ix/pnl/tvl`),
    jget(`${CFG.delta}/ix/pools/list?window=86400`),
    jget(`${CFG.delta}/api/farms/topology`).catch(() => ({ farms: topologyFallback || [] })),
    jget(`${CFG.delta}/ix/farms/metrics`).catch(() => ({ farms: [] })),
    jget(`${CFG.delta}/api/usdg/pools`).catch(() => null),
    blockNumber().catch(() => null),
  ]);

  const eth = await ethUsdPrice(stats, usdgFeed, ethCallBatch);
  const ethUsd = eth.ethUsd;
  const allPools = [...(pools.active || []), ...(pools.established || [])];

  // One row per pool. A token can appear in both the "active" and "established"
  // buckets, and can have several pools at different fee tiers.
  const byPool = new Map();
  for (const p of allPools) if (!byPool.has(p.pool)) byPool.set(p.pool, p);
  const uniquePools = [...byPool.values()];

  // `price` is the raw token1/token0 ratio and is NOT decimal-adjusted, so a
  // USDG-quoted pool (6dp quote, 18dp token) reads 1e12 too small. WETH-quoted
  // pools happen to have matching decimals, which is why they look right as-is.
  const quoteUsd = (q) => {
    const a = (q || '').toLowerCase();
    if (a === CFG.USDG) return 1;
    if (a === CFG.WETH || /^0x0+$/.test(a)) return ethUsd; // WETH or native ETH
    return null;
  };
  const usdPrice = (p) => {
    const qu = quoteUsd(p.quote);
    if (qu == null || !(p.price > 0)) return null;
    const scale = 10 ** ((p.tokenDecimals ?? 18) - (p.quoteDecimals ?? 18));
    return p.price * scale * qu;
  };

  // token address -> USD price, taken from its highest-volume pool.
  const priceOf = new Map([[CFG.WETH, ethUsd]]);
  const meta = new Map();
  for (const p of [...uniquePools].sort((a, b) => (b.volume24hUsd || 0) - (a.volume24hUsd || 0))) {
    const t = p.token.toLowerCase();
    const usd = usdPrice(p);
    if (usd != null && !priceOf.has(t)) priceOf.set(t, usd);
    if (!meta.has(t)) {
      meta.set(t, {
        symbol: p.symbol,
        name: p.name,
        decimals: p.tokenDecimals ?? 18,
        totalSupply: p.totalSupply,
      });
    }
  }
  meta.set(CFG.WETH, { symbol: 'WETH', name: 'Wrapped ETH', decimals: 18 });

  // Delta's UI derives a pool's 24h fees as volume x fee tier; verified against
  // their token page, where fees24h / volume24h lands on the tier exactly.
  const feesUsdOf = (p) => (p.volume24hUsd || 0) * ((p.feePpm || 0) / 1e6);
  const protoVolume24h = uniquePools.reduce((s, p) => s + (p.volume24hUsd || 0), 0);
  const protoTrades24h = uniquePools.reduce((s, p) => s + (p.trades24h || 0), 0);

  // ---- $DELTA -------------------------------------------------------------

  // DELTA trades in several pools (a 1% V3 ETH pool, USDG pools, V4 pools).
  // Volume, fees and exit depth must aggregate across all of them; only the
  // headline price and tick detail come from the deepest single pool.
  const deltaPools = uniquePools.filter((p) => p.token.toLowerCase() === CFG.DELTA);
  const dp =
    deltaPools.find((p) => (p.pool || '').toLowerCase() === CFG.DELTA_POOL) ||
    deltaPools.slice().sort((a, b) => (b.volume24hUsd || 0) - (a.volume24hUsd || 0))[0] ||
    {};
  const [tokenInfo, counters, holdersPage] = await Promise.all([
    jget(`${CFG.scout}/api/v2/tokens/${CFG.DELTA}`).catch(() => ({})),
    jget(`${CFG.scout}/api/v2/tokens/${CFG.DELTA}/counters`).catch(() => ({})),
    jget(`${CFG.scout}/api/v2/tokens/${CFG.DELTA}/holders`).catch(() => ({ items: [] })),
  ]);

  // Blockscout returns 50 holders per page, largest first. Pull enough pages that
  // "top 50 wallets" is a real top 50 even after contracts are filtered out.
  const holderItems = [...(holdersPage.items || [])];
  let next = holdersPage.next_page_params;
  for (let page = 1; page < CFG.HOLDER_PAGES && next; page++) {
    const q = new URLSearchParams(next).toString();
    const more = await jget(`${CFG.scout}/api/v2/tokens/${CFG.DELTA}/holders?${q}`).catch(() => null);
    if (!more?.items?.length) break;
    holderItems.push(...more.items);
    next = more.next_page_params;
  }

  const decimals = Number(tokenInfo.decimals ?? 18);
  const totalSupply = num(BigInt(tokenInfo.total_supply || dp.totalSupply || '0'), decimals);
  const apiDeltaUsd = priceOf.get(CFG.DELTA) ?? usdPrice(dp) ?? 0;

  const holders = holderItems.map((h) => ({
    address: h.address?.hash,
    label: h.address?.name || null,
    isContract: !!h.address?.is_contract,
    balance: num(BigInt(h.value || '0'), decimals),
  }));
  holders.sort((a, b) => b.balance - a.balance);

  const excluded = [];
  let nonCirculating = 0;
  for (const h of holders) {
    const tag = CFG.NON_CIRCULATING[(h.address || '').toLowerCase()];
    if (tag) {
      nonCirculating += h.balance;
      excluded.push({ address: h.address, label: tag, balance: h.balance });
    }
  }
  const circulating = Math.max(totalSupply - nonCirculating, 0);

  const share = (list, n) => list.slice(0, n).reduce((s, h) => s + h.balance, 0) / (totalSupply || 1);
  // Contracts (the locker, the pool itself, vaults) are not "whales" in the sense
  // a trader cares about, so report wallet-only concentration alongside the raw one.
  const wallets = holders.filter((h) => !h.isContract);
  const holderCount = Number(counters.token_holders_count || tokenInfo.holders_count || 0);

  // Gini across the known top holders plus the untracked remainder spread evenly.
  const gini = (() => {
    const known = holders.map((h) => h.balance);
    const rest = Math.max(holderCount - known.length, 0);
    const restTotal = Math.max(totalSupply - known.reduce((s, v) => s + v, 0), 0);
    if (!rest || !restTotal) return null;
    const vals = [...Array(Math.min(rest, 20000)).fill(restTotal / rest), ...known].sort((a, b) => a - b);
    const n = vals.length;
    const sum = vals.reduce((s, v) => s + v, 0);
    if (!sum) return null;
    let cum = 0;
    vals.forEach((v, i) => (cum += (i + 1) * v));
    return (2 * cum) / (n * sum) - (n + 1) / n;
  })();

  // ---- DELTA pool state, across every pool we can read --------------------

  // v4 pools are identified by a 32-byte id inside a singleton PoolManager, not by
  // an address, so the v3 calls below cannot reach them. They are counted in the
  // volume totals and reported as unreadable rather than silently ignored.
  const readable = deltaPools.filter((p) => (p.pool || '').length === 42);
  const unreadablePools = deltaPools.length - readable.length;

  const perPoolCalls = readable.flatMap((p) => [
    { to: p.pool, data: SEL.slot0 },
    { to: p.pool, data: SEL.liquidity },
    { to: p.pool, data: SEL.tickSpacing },
    { to: p.pool, data: SEL.token0 },
    { to: p.pool, data: SEL.token1 },
    { to: p.pool, data: SEL.fee },
    { to: CFG.DELTA, data: encAddr(SEL.balanceOf, p.pool) },
  ]);
  const pr = perPoolCalls.length ? await ethCallBatch(perPoolCalls) : [];

  const poolState = readable.map((p, i) => {
    const o = i * 7;
    if (!pr[o]) return null; // pool did not answer slot0 — skip rather than guess
    return {
      meta: p,
      sqrtPriceX96: uint(word(pr[o], 0)),
      tick: pr[o] ? Number(int(word(pr[o], 1))) : null,
      liquidity: uint(pr[o + 1]),
      spacing: Number(uint(pr[o + 2])) || 200,
      token0: '0x' + word(pr[o + 3], 0).slice(-40),
      token1: '0x' + word(pr[o + 4], 0).slice(-40),
      feePpm: Number(uint(pr[o + 5])) || p.feePpm || 0,
      deltaBal: num(uint(pr[o + 6]), decimals),
    };
  }).filter((p) => p && p.tick != null && p.sqrtPriceX96 > 0n);

  // The deepest readable pool sets the headline price and tick detail.
  const primary =
    poolState.find((p) => p.meta.pool.toLowerCase() === CFG.DELTA_POOL) ||
    poolState.slice().sort((a, b) => (b.meta.volume24hUsd || 0) - (a.meta.volume24hUsd || 0))[0];

  const priceFromPool = (st) => {
    const sqrtP = Number(st.sqrtPriceX96) / Q96;
    const zeroIsDelta = st.token0.toLowerCase() === CFG.DELTA;
    const quote = (zeroIsDelta ? st.token1 : st.token0).toLowerCase();
    const qDec = quote === CFG.USDG ? 6 : 18;
    const qUsd = quote === CFG.USDG ? 1 : ethUsd;
    // sqrtPriceX96^2 is token1 per token0 in raw units; undo the decimal difference.
    const p1PerP0 = sqrtP * sqrtP * 10 ** ((zeroIsDelta ? decimals : qDec) - (zeroIsDelta ? qDec : decimals));
    const deltaInQuote = zeroIsDelta ? p1PerP0 : 1 / p1PerP0;
    return { sqrtP, zeroIsDelta, quote, qDec, qUsd, deltaUsd: deltaInQuote * qUsd };
  };

  const primaryPx = primary ? priceFromPool(primary) : null;
  const chainDeltaUsd = primaryPx?.deltaUsd;
  const deltaUsd = chainDeltaUsd > 0 && isFinite(chainDeltaUsd) ? chainDeltaUsd : apiDeltaUsd;

  // Walk each readable pool and sum. A seller can route across all of them, so the
  // aggregate is the number that answers "how much can I actually sell".
  const bands = {};
  CFG.DEPTH_BANDS.forEach((b) => {
    bands['pct' + Math.round(b * 100)] = { totalUsd: 0, sellDepthUsd: 0, buyDepthUsd: 0 };
  });
  let poolTvlUsd = 0, bucketUsd = 0, deltaInPool = 0, quoteValueUsd = 0;
  const poolBreakdown = [];

  for (const st of poolState) {
    const px = priceFromPool(st);
    const zeroIsDelta = px.zeroIsDelta;
    const p0Usd = zeroIsDelta ? deltaUsd : px.qUsd;
    const p1Usd = zeroIsDelta ? px.qUsd : deltaUsd;
    const d0 = zeroIsDelta ? decimals : px.qDec;
    const d1 = zeroIsDelta ? px.qDec : decimals;

    const qBal = await ethCallBatch([{ to: px.quote, data: encAddr(SEL.balanceOf, st.meta.pool) }]);
    const quoteBal = num(uint(qBal[0]), px.qDec);
    const tvl = st.deltaBal * deltaUsd + quoteBal * px.qUsd;
    poolTvlUsd += tvl;
    deltaInPool += st.deltaBal;
    quoteValueUsd += quoteBal * px.qUsd;

    const entry = { pool: st.meta.pool, feePpm: st.feePpm, quote: px.quote, tvlUsd: tvl, depth: {} };
    for (const band of CFG.DEPTH_BANDS) {
      const r = await liquidityDepth(st.meta.pool, st.tick, st.spacing, st.liquidity, band, p0Usd, p1Usd, d0, d1);
      // Walking up in tick accumulates token0. Whichever side is NOT delta is the
      // side that pays out when someone sells, so it is the sell depth.
      const sell = zeroIsDelta ? r.token1Usd : r.token0Usd;
      const buy = zeroIsDelta ? r.token0Usd : r.token1Usd;
      const key = 'pct' + Math.round(band * 100);
      bands[key].totalUsd += r.totalUsd;
      bands[key].sellDepthUsd += sell;
      bands[key].buyDepthUsd += buy;
      entry.depth[key] = { totalUsd: r.totalUsd, sellDepthUsd: sell, buyDepthUsd: buy };
    }
    const bl = Math.floor(st.tick / st.spacing) * st.spacing;
    const bk = amountsForLiquidity(Number(st.liquidity), px.sqrtP, bl, bl + st.spacing);
    bucketUsd += (bk.amount0 / 10 ** d0) * p0Usd + (bk.amount1 / 10 ** d1) * p1Usd;
    poolBreakdown.push(entry);
  }

  const depth = bands;
  const sqrtPriceX96 = primary?.sqrtPriceX96 ?? 0n;
  const tick = primary?.tick ?? 0;
  const spacing = primary?.spacing ?? 200;
  const activeLiquidity = primary?.liquidity ?? 0n;
  const feePpm = primary?.feePpm || dp.feePpm || 10000;
  const wethInPool = quoteValueUsd / (ethUsd || 1); // quote side expressed in ETH

  const active2 = depth.pct2?.totalUsd || 0;
  // Summed over every DELTA pool. Each pool has its own fee tier, so fees are
  // computed per pool and then added — not volume summed and one tier applied.
  const deltaVolume24h = deltaPools.reduce((s, p) => s + (p.volume24hUsd || 0), 0);
  const deltaFees24hUsd = deltaPools.reduce((s, p) => s + feesUsdOf(p), 0);

  // ---- stakes / farms -----------------------------------------------------

  const topo = topology.farms || topologyFallback || [];
  const metricsBy = new Map((farmMetrics.farms || []).map((f) => [f.farm.toLowerCase(), f]));

  // Label any farm token that has no live pool in the list.
  const unknown = [...new Set(topo.flatMap((f) => [f.token0, f.token1]))]
    .map((a) => (a || '').toLowerCase())
    .filter((a) => a && !meta.has(a));
  if (unknown.length) {
    const uc = unknown.flatMap((a) => [
      { to: a, data: SEL.symbol },
      { to: a, data: SEL.decimals },
    ]);
    const ur = await ethCallBatch(uc);
    unknown.forEach((a, i) => {
      meta.set(a, {
        symbol: decodeString(ur[i * 2]) || a.slice(0, 6),
        name: null,
        decimals: ur[i * 2 + 1] ? Number(uint(ur[i * 2 + 1])) : 18,
      });
    });
  }

  const PER_FARM = 8;
  const fCalls = [];
  for (const f of topo) {
    fCalls.push(
      { to: f.vault, data: SEL.tickLower },
      { to: f.vault, data: SEL.tickUpper },
      { to: f.vault, data: SEL.totalLiquidity },
      { to: f.vault, data: SEL.totalSupply },
      { to: f.vault, data: encAddr(SEL.balanceOf, f.farm) },
      { to: f.pool, data: SEL.slot0 },
      { to: f.farm, data: SEL.periodFinish },
      { to: f.farm, data: SEL.rewardRate }
    );
  }
  const fr = fCalls.length ? await ethCallBatch(fCalls) : [];

  const farms = topo.map((f, i) => {
    const o = i * PER_FARM;
    const tl = fr[o] ? Number(int(fr[o])) : null;
    const tu = fr[o + 1] ? Number(int(fr[o + 1])) : null;
    const L = fr[o + 2] ? Number(uint(fr[o + 2])) : 0;
    const supply = fr[o + 3] ? Number(uint(fr[o + 3])) : 0;
    const staked = fr[o + 4] ? Number(uint(fr[o + 4])) : 0;
    const sq = fr[o + 5] ? Number(uint(word(fr[o + 5], 0))) / Q96 : null;
    const finish = fr[o + 6] ? Number(uint(fr[o + 6])) : null;
    const rewardRate = fr[o + 7] ? Number(uint(fr[o + 7])) : 0;

    const t0 = (f.token0 || '').toLowerCase();
    const t1 = (f.token1 || '').toLowerCase();
    const m0 = meta.get(t0) || { symbol: '?', decimals: 18 };
    const m1 = meta.get(t1) || { symbol: '?', decimals: 18 };
    const u0 = priceOf.get(t0) ?? null;
    const u1 = priceOf.get(t1) ?? null;

    let positionUsd = null;
    if (tl != null && tu != null && sq && L > 0 && u0 != null && u1 != null) {
      const a = amountsForLiquidity(L, sq, tl, tu);
      positionUsd = (a.amount0 / 10 ** m0.decimals) * u0 + (a.amount1 / 10 ** m1.decimals) * u1;
    }
    const stakedPct = supply > 0 ? staked / supply : 0;
    const stakedUsd = positionUsd != null ? positionUsd * stakedPct : null;

    // Current emission rate straight from the farm, gated on the stream still
    // being funded. Delta's own API only reports rewards that have already
    // settled over a window, so it reads 0 for freshly funded farms.
    const streaming = finish ? finish > ts : false;
    const wethPerDay = streaming ? (rewardRate / REWARD_RATE_SCALE) * 86400 : 0;
    const usdPerDay = wethPerDay * ethUsd;
    const apr = stakedUsd && stakedUsd > 0 ? ((usdPerDay * 365) / stakedUsd) * 100 : null;

    const mm = metricsBy.get(f.farm.toLowerCase()) || {};
    const winSec = Number(mm.windowSeconds || 0);
    const settledWeth = Number(BigInt(mm.rewardsWindow || '0')) / 1e18;

    return {
      farm: f.farm,
      vault: f.vault,
      pool: f.pool,
      token0: f.token0,
      token1: f.token1,
      pair: `${m0.symbol}/${m1.symbol}`,
      feeTier: f.fee,
      tvlUsd: positionUsd,
      stakedUsd,
      stakedPct: stakedPct * 100,
      rewardsWethPerDay: wethPerDay,
      rewardsUsdPerDay: usdPerDay,
      aprPct: apr,
      // Cross-check: realised distribution rate over Delta's own settled window.
      settledWethPerDay: winSec > 0 ? (settledWeth / winSec) * 86400 : null,
      fees24hWeth: Number(BigInt(mm.fees24h || '0')) / 1e18,
      rewardsEndTs: finish,
      rewardsEndsInDays: finish ? (finish - ts) / 86400 : null,
      streaming,
    };
  });

  const live = farms.filter((f) => f.streaming && f.rewardsWethPerDay > 0);
  const stakedTotal = farms.reduce((s, f) => s + (f.stakedUsd || 0), 0);
  const wethPerDayTotal = farms.reduce((s, f) => s + f.rewardsWethPerDay, 0);

  // ---- assemble -----------------------------------------------------------

  const W = (k) => stats.windows?.[k] || {};
  const snapshot = {
    ts,
    iso: new Date(ts * 1000).toISOString(),
    block,
    ethUsd,
    sources: {
      stats: `${CFG.delta}/stats`,
      tvl: `${CFG.delta}/ix/pnl/tvl`,
      pools: `${CFG.delta}/ix/pools/list?window=86400`,
      farms: `${CFG.delta}/ix/farms/metrics`,
      chain: CFG.rpc,
      explorer: CFG.scout,
    },
    ethUsdSource: eth.source,
    ethUsdApi: eth.apiEthUsd,
    freshness: {
      statsAgeSec: stats.ageSec ?? null,
      statsStale: !!stats.stale,
      tvlAgeSec: tvl.ageSec ?? null,
      // How far Delta's cached ETH rate has drifted from the live pool. Every USD
      // figure would be off by this much if we used their number.
      apiEthUsdAgeSec: tvl.ethUsdAgeSec ?? null,
      apiEthUsdDriftPct: eth.apiEthUsd > 0 ? ((eth.apiEthUsd / ethUsd - 1) * 100) : null,
    },

    protocol: {
      managedTvlUsd: tvl.tvlUsd,
      managedTvlQuoteUsd: tvl.quoteUsd,
      managedTvlBaseUsd: tvl.baseUsd,
      poolsTracked: tvl.pools,
      openRungsV3: tvl.openRungsV3,
      openRungsV4: tvl.openRungsV4,
      positionsTotal: stats.positionsTotal,
      positionsV3: stats.positionsV3,
      positionsV4: stats.positionsV4,
      lifetimeFeesUsd: stats.feesUsd,
      // Fees accrue in WETH and every USD figure here is that WETH revalued at spot
      // ETH, so the USD totals FALL when ETH falls. The WETH figure is the one that
      // only ever goes up — chart that if you want a monotonic series.
      lifetimeFeesWeth: Number(BigInt(stats.feesWeth || '0')) / 1e18,
      lifetimeOwners: W('all').uniqueOwners,
      lifetimeDepositedUsd: W('all').depositedUsd,
      // Chain-side context: the total traded on every pool Delta indexes. This is
      // NOT Delta's own volume, so it must never be divided by Delta's TVL.
      chainVolume24hUsd: protoVolume24h,
      chainTrades24h: protoTrades24h,
      chainPoolsIndexed: uniquePools.length,
      // Delta's own return on its own capital: fees earned by Delta positions over
      // the value held in them. Both sides are Delta-scoped, so this one is fair.
      // Both expressed as a DAILY rate so they can be compared directly.
      feeYield24hPct: tvl.tvlUsd ? (W('24h').feesUsd / tvl.tvlUsd) * 100 : null,
      feeYield7dAvgPct: tvl.tvlUsd ? (W('7d').feesUsd / 7 / tvl.tvlUsd) * 100 : null,
      feesUnpricedEvents: stats.feesManagedUnpriced ?? null,
      fees: {
        h4: W('4h').feesUsd,
        h12: W('12h').feesUsd,
        h24: W('24h').feesUsd,
        d7: W('7d').feesUsd,
        d14: W('14d').feesUsd,
        d30: W('30d').feesUsd,
        all: W('all').feesUsd,
      },
      feesWeth: {
        h24: Number(BigInt(W('24h').feesWeth || '0')) / 1e18,
        d7: Number(BigInt(W('7d').feesWeth || '0')) / 1e18,
        all: Number(BigInt(W('all').feesWeth || '0')) / 1e18,
      },
      opened: { h4: W('4h').opened, h24: W('24h').opened, d7: W('7d').opened },
      owners: { h4: W('4h').uniqueOwners, h24: W('24h').uniqueOwners, d7: W('7d').uniqueOwners },
      depositedUsd: { h24: W('24h').depositedUsd, d7: W('7d').depositedUsd },
    },

    momentum: momentum(stats.windows || {}),

    delta: {
      token: CFG.DELTA,
      pool: CFG.DELTA_POOL,
      symbol: tokenInfo.symbol || 'DELTA',
      decimals,
      priceUsd: deltaUsd, // from the pool's own sqrtPriceX96
      priceUsdApi: apiDeltaUsd, // Delta's reported price, for cross-checking
      priceWeth: dp.price ?? null,
      change24hPct: dp.change24hPct ?? null,
      spark24h: dp.spark || [],
      // Aggregated across every DELTA pool, not just the deepest one.
      volume24hUsd: deltaVolume24h,
      volume1hUsd: deltaPools.reduce((s, p) => s + (p.volume1hUsd || 0), 0),
      trades24h: deltaPools.reduce((s, p) => s + (p.trades24h || 0), 0),
      poolCount: deltaPools.length,
      poolsReadable: poolState.length,
      poolsUnreadable: unreadablePools,
      // Primary pool = the deepest one, which sets price and the tick detail.
      primaryPool: primary?.meta?.pool ?? CFG.DELTA_POOL,
      primaryVolume24hUsd: dp.volume24hUsd ?? null,
      feePpm,
      fees24hUsd: deltaFees24hUsd,
      // Share of the tradeable float that changed hands today.
      turnover24hPct: circulating * deltaUsd > 0
        ? (deltaVolume24h / (circulating * deltaUsd)) * 100 : null,
      poolAgeDays: dp.createdTs ? (ts - Number(dp.createdTs)) / 86400 : null,
      supply: {
        total: totalSupply,
        circulating,
        nonCirculating,
        excluded,
        // Delta's own UI, its market-cap chart and its range builder all price the
        // FULL supply, and so does every aggregator. Match that convention for the
        // headline so the numbers are directly comparable, and carry the float-only
        // value separately rather than quietly reporting a different measure.
        marketCapUsd: totalSupply * deltaUsd,
        fdvUsd: totalSupply * deltaUsd,
        floatCapUsd: circulating * deltaUsd,
        lockedPctOfSupply: totalSupply > 0 ? (nonCirculating / totalSupply) * 100 : 0,
      },
      holders: {
        count: holderCount,
        sampled: holders.length,
        transfers: Number(counters.transfers_count || 0),
        top10Pct: share(holders, 10) * 100,
        top50Pct: share(holders, 50) * 100,
        top10WalletsPct: share(wallets, 10) * 100,
        top50WalletsPct: share(wallets, 50) * 100,
        giniApprox: gini,
        top: holders.slice(0, 20).map((h) => ({
          ...h,
          pctOfSupply: (h.balance / (totalSupply || 1)) * 100,
        })),
      },
      liquidity: {
        tick,
        sqrtPriceX96: sqrtPriceX96.toString(),
        tickSpacing: spacing,
        activeLiquidity: activeLiquidity.toString(),
        poolTvlUsd,
        wethInPool,
        tokenInPool: deltaInPool,
        activeBucketUsd: bucketUsd,
        depth,
        activeUsd: active2,
        idleUsd: Math.max(poolTvlUsd - active2, 0),
        activePct: poolTvlUsd ? (active2 / poolTvlUsd) * 100 : null,
        capitalEfficiency: active2 ? (dp.volume24hUsd || 0) / active2 : null,
        capitalEfficiencyTvl: poolTvlUsd ? (dp.volume24hUsd || 0) / poolTvlUsd : null,
      },
    },

    staking: {
      farmCount: farms.length,
      streamingCount: live.length,
      totalStakedUsd: stakedTotal,
      totalRewardsWethPerDay: wethPerDayTotal,
      totalRewardsUsdPerDay: wethPerDayTotal * ethUsd,
      blendedAprPct: stakedTotal > 0 ? ((wethPerDayTotal * ethUsd * 365) / stakedTotal) * 100 : null,
      farms: farms.sort((a, b) => (b.stakedUsd || 0) - (a.stakedUsd || 0)),
    },

    topPools: uniquePools
      .slice()
      .sort((a, b) => (b.volume24hUsd || 0) - (a.volume24hUsd || 0))
      .slice(0, CFG.TOP_POOLS)
      .map((p) => {
        const usd = usdPrice(p) ?? priceOf.get(p.token.toLowerCase()) ?? null;
        const supply = num(BigInt(p.totalSupply || '0'), p.tokenDecimals ?? 18) || 0;
        // A brand-new pool reports a nonsense percentage against a zero baseline.
        const chg = p.change24hPct;
        return {
          symbol: p.symbol,
          name: p.name,
          token: p.token,
          pool: p.pool,
          isV4: (p.pool || '').length > 44, // v4 pool ids are not addresses
          priceUsd: usd,
          change24hPct: Math.abs(chg) > 100000 ? null : chg,
          isNew: Math.abs(chg) > 100000 || (p.createdTs && ts - Number(p.createdTs) < 86400),
          volume24hUsd: p.volume24hUsd,
          fees24hUsd: feesUsdOf(p),
          trades24h: p.trades24h,
          marketCapUsd: usd != null ? supply * usd : null,
          ageDays: p.createdTs ? (ts - Number(p.createdTs)) / 86400 : null,
          feePpm: p.feePpm,
        };
      }),

    notes: {
      managedTvl:
        'Delta TVL is capital sitting in Delta positions, not the total depth of the underlying pools.',
      chainVolume:
        'Volume and trades are totals for every pool Delta indexes — chain-wide activity, not Delta\'s own. They are never divided by Delta\'s TVL.',
      feeYield:
        'Fee yield divides fees earned by Delta positions by the value held in them, so both sides are Delta-scoped. It is a realised daily rate, not annualised.',
      price:
        'DELTA price is read from the pool\'s own sqrtPriceX96 so it agrees with the tick-level liquidity maths; Delta\'s reported price is kept as priceUsdApi.',
      circulating:
        'Circulating supply = total supply minus balances at the addresses listed in delta.supply.excluded.',
      gini: 'Gini is approximate: exact for the top holders Blockscout returns, remainder spread evenly.',
      router:
        'Router custody (locked / burned / operator-held) and milestone routes are announced but not yet exposed by a public interface or contract, so they are not tracked here.',
    },
  };

  // Delta publishes OHLC candles per token; daily closes give the price chart real
  // history from the first run instead of waiting for snapshots to accumulate.
  try {
    const from = ts - CFG.CANDLE_DAYS * 86400;
    const c = await jget(
      `${CFG.delta}/ix/pools/token/${CFG.DELTA}/candles?tf=86400&from=${from}&denom=usd`
    );
    const rows = (c?.candles || []).filter((x) => x.c > 0);
    snapshot.delta.dailyCloses = rows.map((x) => ({
      t: x.t,
      date: new Date(x.t * 1000).toISOString().slice(0, 10),
      priceUsd: x.c,
      mcUsd: x.c * totalSupply,
      trades: x.n ?? null,
    }));
  } catch {
    snapshot.delta.dailyCloses = [];
  }

  snapshot.direction = direction(snapshot, history);
  return snapshot;
}

/** Compact row appended to the history series. */
export function historyRow(s) {
  return {
    ts: s.ts,
    date: s.iso.slice(0, 10),
    ethUsd: r6(s.ethUsd),
    managedTvlUsd: r2(s.protocol.managedTvlUsd),
    fees24hUsd: r2(s.protocol.fees.h24),
    fees4hUsd: r2(s.protocol.fees.h4),
    volume24hUsd: r2(s.protocol.chainVolume24hUsd),
    trades24h: s.protocol.chainTrades24h,
    positions: s.protocol.positionsTotal,
    opened24h: s.protocol.opened.h24,
    owners24h: s.protocol.owners.h24,
    deltaPriceUsd: r8(s.delta.priceUsd),
    deltaMcUsd: r2(s.delta.supply.marketCapUsd),
    deltaFdvUsd: r2(s.delta.supply.fdvUsd),
    deltaVolume24hUsd: r2(s.delta.volume24hUsd),
    deltaFees24hUsd: r2(s.delta.fees24hUsd),
    feeYield24hPct: r2(s.protocol.feeYield24hPct),
    feeVsWeek: r2(s.momentum.feeVsWeek),
    lpVsWeek: r2(s.momentum.lpVsWeek),
    direction: s.direction?.state ?? null,
    poolTvlUsd: r2(s.delta.liquidity.poolTvlUsd),
    activeUsd: r2(s.delta.liquidity.activeUsd),
    activePct: r2(s.delta.liquidity.activePct),
    holders: s.delta.holders.count,
    top10Pct: r2(s.delta.holders.top10Pct),
    top50Pct: r2(s.delta.holders.top50Pct),
    top10WalletsPct: r2(s.delta.holders.top10WalletsPct),
    stakedUsd: r2(s.staking.totalStakedUsd),
    rewardsWethPerDay: r6(s.staking.totalRewardsWethPerDay),
    blendedAprPct: r2(s.staking.blendedAprPct),
  };
}

const round = (v, n) => (typeof v === 'number' && isFinite(v) ? Number(v.toFixed(n)) : null);
const r2 = (v) => round(v, 2);
const r6 = (v) => round(v, 6);
const r8 = (v) => round(v, 10);
