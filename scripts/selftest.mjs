#!/usr/bin/env node
/**
 * Consistency checks on data/latest.json and data/history.json.
 *
 * These do not re-fetch anything — they assert that the numbers the collector
 * wrote agree with each other. Run after a snapshot to catch a source changing
 * shape underneath us (a renamed field usually shows up as a null or a ratio
 * that stops adding up, not as a crash).
 *
 *   node scripts/selftest.mjs
 */

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { historyRow } from './lib/delta.mjs';

const DATA = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'data');

let failed = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failed++;
};
const near = (a, b, tol = 0.01) =>
  a != null && b != null && isFinite(a) && isFinite(b) &&
  Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b), 1e-9) * tol;

const s = JSON.parse(await readFile(resolve(DATA, 'latest.json'), 'utf8'));
const hist = JSON.parse(await readFile(resolve(DATA, 'history.json'), 'utf8'));

console.log(`\nsnapshot ${s.iso}  block ${s.block}\n`);

// --- shape ---------------------------------------------------------------
ok('has a timestamp', Number.isFinite(s.ts) && s.ts > 1.7e9);
ok('ETH price is sane', s.ethUsd > 100 && s.ethUsd < 100000, `$${s.ethUsd}`);
ok('protocol TVL present', s.protocol.managedTvlUsd > 0);
ok('fee windows all present',
  ['h4', 'h12', 'h24', 'd7', 'd30'].every((k) => Number.isFinite(s.protocol.fees[k])));
ok('fee windows are monotonic',
  s.protocol.fees.h4 <= s.protocol.fees.h12 + 1 &&
  s.protocol.fees.h12 <= s.protocol.fees.h24 + 1 &&
  s.protocol.fees.h24 <= s.protocol.fees.d7 + 1);

// A ratio is only meaningful when both sides measure the same thing. Chain-wide
// volume over Delta-only TVL was exactly that mistake, so guard against it coming back.
ok('no chain-volume-over-Delta-TVL ratio', s.protocol.capitalEfficiency === undefined);
ok('chain totals are labelled as chain-scoped',
  s.protocol.chainVolume24hUsd > 0 && s.protocol.volume24hUsd === undefined);
ok('fee yield = Delta fees over Delta TVL',
  near(s.protocol.feeYield24hPct, (s.protocol.fees.h24 / s.protocol.managedTvlUsd) * 100));
ok('7d fee yield is a daily rate, comparable to the 24h one',
  near(s.protocol.feeYield7dAvgPct, (s.protocol.fees.d7 / 7 / s.protocol.managedTvlUsd) * 100));

// --- momentum & direction ------------------------------------------------
const m = s.momentum;
ok('momentum present', !!m && m.feesPerHour != null);
ok('fee rates are per-hour conversions',
  near(m.feesPerHour.h24, s.protocol.fees.h24 / 24) && near(m.feesPerHour.d7, s.protocol.fees.d7 / 168));
ok('feeVsWeek is the ratio of those rates', near(m.feeVsWeek, m.feesPerHour.h24 / m.feesPerHour.d7));
ok('direction has a known state',
  ['expanding', 'steady', 'cooling'].includes(s.direction?.state), s.direction?.state);
ok('direction score matches its signals',
  s.direction.score === s.direction.signals.reduce((a, x) => a + x.score, 0));
ok('direction summary is a sentence, not a pitch',
  typeof s.direction.summary === 'string' && s.direction.summary.length > 20 &&
  !/moon|pump|gem|guaranteed|to the|100x|buy now/i.test(s.direction.summary));

// --- ETH rate -------------------------------------------------------------
// Every USD figure is scaled by this, so a stale rate skews the whole snapshot.
ok('ETH rate has a recorded source', typeof s.ethUsdSource === 'string' && s.ethUsdSource.length > 0,
  s.ethUsdSource);
ok('ETH rate is read from the chain, not a cache',
  /^chain:/.test(s.ethUsdSource || '') || !!s.seed, s.ethUsdSource);
ok('drift from the cached rate is recorded',
  s.freshness.apiEthUsdDriftPct == null || isFinite(s.freshness.apiEthUsdDriftPct),
  s.freshness.apiEthUsdDriftPct == null ? 'n/a' : s.freshness.apiEthUsdDriftPct.toFixed(2) + '%');

// --- token ---------------------------------------------------------------
const d = s.delta;
ok('DELTA has a price', d.priceUsd > 0, `$${d.priceUsd}`);
ok('chain price agrees with the API price',
  d.priceUsdApi == null || near(d.priceUsd, d.priceUsdApi, 0.05),
  `chain ${d.priceUsd} vs api ${d.priceUsdApi}`);
ok('turnover = volume over tradeable float',
  near(d.turnover24hPct, (d.volume24hUsd / d.supply.floatCapUsd) * 100));
// Delta's UI, its market-cap chart and every aggregator price the FULL supply.
// Matching that is what makes our number comparable to theirs.
ok('market cap = total supply x price', near(d.supply.marketCapUsd, d.supply.total * d.priceUsd));
ok('float cap = circulating x price', near(d.supply.floatCapUsd, d.supply.circulating * d.priceUsd));
ok('float cap <= market cap', d.supply.floatCapUsd <= d.supply.marketCapUsd + 1);
ok('locked % matches the excluded balances',
  near(d.supply.lockedPctOfSupply, (d.supply.nonCirculating / d.supply.total) * 100, 0.001));
ok('circulating <= total', d.supply.circulating <= d.supply.total);
ok('excluded addresses account for the gap',
  near(d.supply.total - d.supply.circulating,
    (d.supply.excluded || []).reduce((a, e) => a + e.balance, 0), 0.001));
ok('holder count is plausible', d.holders.count > 0 && d.holders.count < 1e8, `${d.holders.count}`);
ok('top10 <= top50 <= 100%',
  d.holders.top10Pct <= d.holders.top50Pct + 0.001 && d.holders.top50Pct <= 100);
ok('wallet-only concentration <= all-address concentration',
  d.holders.top10WalletsPct <= d.holders.top10Pct + 0.001);
ok('gini in [0,1]', d.holders.giniApprox == null ||
  (d.holders.giniApprox >= 0 && d.holders.giniApprox <= 1), `${d.holders.giniApprox}`);
ok('top holders are sorted descending',
  d.holders.top.every((h, i, a) => i === 0 || a[i - 1].balance >= h.balance));

// --- liquidity -----------------------------------------------------------
const L = d.liquidity;
ok('pool TVL > 0', L.poolTvlUsd > 0);
ok('active + idle = pool TVL', near(L.activeUsd + L.idleUsd, L.poolTvlUsd));
ok('activePct matches active/TVL', near(L.activePct, (L.activeUsd / L.poolTvlUsd) * 100));
ok('the +/-5% band contains the +/-2% band', L.depth.pct5.totalUsd >= L.depth.pct2.totalUsd);
ok('depth is present on both sides of spot',
  L.depth.pct2.token0Usd > 0 && L.depth.pct2.token1Usd > 0);
ok('buy and sell depth split the band',
  near(L.depth.pct2.sellDepthUsd + L.depth.pct2.buyDepthUsd, L.depth.pct2.totalUsd));
// Uniform liquidity puts the band ratio at the tick-span ratio (~2.45). A large
// deviation means either shaped liquidity or a broken tick walk.
const spanRatio = Math.ceil(Math.log(1.05) / Math.log(1.0001)) / Math.ceil(Math.log(1.02) / Math.log(1.0001));
const bandRatio = L.depth.pct5.totalUsd / L.depth.pct2.totalUsd;
ok('depth band ratio is physically plausible', bandRatio > 1 && bandRatio < spanRatio * 1.6,
  `${bandRatio.toFixed(2)} vs uniform ${spanRatio.toFixed(2)}`);
ok('active liquidity <= pool TVL', L.activeUsd <= L.poolTvlUsd);
ok('capital efficiency matches volume/active',
  near(L.capitalEfficiency, d.volume24hUsd / L.activeUsd));
ok('pool token balances are positive', L.tokenInPool > 0 && L.wethInPool > 0);

// --- staking -------------------------------------------------------------
const st = s.staking;
ok('farm list matches the farm count', st.farms.length === st.farmCount);
ok('total staked = sum of farms',
  near(st.totalStakedUsd, st.farms.reduce((a, f) => a + (f.stakedUsd || 0), 0), 0.001));
ok('total emissions = sum of farms',
  near(st.totalRewardsWethPerDay, st.farms.reduce((a, f) => a + f.rewardsWethPerDay, 0), 0.001));
ok('only funded farms emit',
  st.farms.every((f) => f.rewardsWethPerDay === 0 || f.streaming));
ok('blended APR matches emissions/staked', st.totalStakedUsd <= 0 || near(
  st.blendedAprPct, (st.totalRewardsUsdPerDay * 365 / st.totalStakedUsd) * 100));
ok('per-farm staked never exceeds vault TVL',
  st.farms.every((f) => f.stakedUsd == null || f.tvlUsd == null || f.stakedUsd <= f.tvlUsd * 1.001));

// --- pools ---------------------------------------------------------------
ok('pool rows are unique by address',
  new Set(s.topPools.map((p) => p.pool)).size === s.topPools.length);
ok('pools are sorted by volume',
  s.topPools.every((p, i, a) => i === 0 || a[i - 1].volume24hUsd >= p.volume24hUsd));
// A pool quoted in something other than WETH/USDG/ETH legitimately has no USD
// price, so allow a few — but a sudden majority means the price logic broke.
const unpriced = s.topPools.filter((p) => !(p.priceUsd > 0));
ok('most listed pools have a price', unpriced.length <= s.topPools.length * 0.25,
  unpriced.length ? `${unpriced.length} unpriced: ${unpriced.map((p) => p.symbol).join(',')}` : 'all priced');
ok('fees follow volume x fee tier',
  s.topPools.every((p) => near(p.fees24hUsd, p.volume24hUsd * (p.feePpm / 1e6), 0.001)));
ok('DELTA appears in the pool list',
  s.topPools.some((p) => p.token.toLowerCase() === d.token.toLowerCase()));

// --- history -------------------------------------------------------------
ok('history is an array with rows', Array.isArray(hist) && hist.length > 0, `${hist.length} rows`);
ok('history is ordered by time', hist.every((r, i, a) => i === 0 || a[i - 1].ts <= r.ts));
ok('history timestamps are unique', new Set(hist.map((r) => r.ts)).size === hist.length);
const row = historyRow(s);
ok('historyRow produces every charted field',
  ['fees24hUsd', 'managedTvlUsd', 'volume24hUsd', 'positions', 'deltaMcUsd',
    'holders', 'stakedUsd', 'activePct', 'top10Pct'].every((k) => Number.isFinite(row[k])));

console.log(failed ? `\n${failed} check(s) failed\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
