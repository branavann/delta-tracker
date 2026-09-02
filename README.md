# Delta Protocol Monitor

A self-updating dashboard for [Delta](https://deltaliquidity.app) on Robinhood Chain
(chain id 4663) and the **$DELTA** token
(`0xe8ffd7e24187f72afb08d75b1bb13088a989a791`).

A GitHub Action commits a snapshot every hour, and GitHub Pages serves a static
page that reads it. No server, no database, no keys — and because every snapshot is
a commit, the history is auditable and portable.

**The page does not depend on that schedule to be current.** It recomputes every
metric live in your browser on load, again every ten minutes while the tab is open,
and instantly when you press **Refresh** — using the same module the hourly job
runs. The committed snapshot is the historical record and the offline fallback;
what you see on screen is computed from Delta's API and the chain at the moment you
look at it.

---

## Setup (about 5 minutes)

1. **Create a repo and push these files.**

   ```bash
   git init && git add . && git commit -m "Delta protocol monitor"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```

2. **Allow Actions to commit.**
   Settings → Actions → General → *Workflow permissions* → **Read and write permissions** → Save.

3. **Turn on Pages.**
   Settings → Pages → Source: **Deploy from a branch** → Branch `main`, folder `/ (root)` → Save.
   Your dashboard appears at `https://<you>.github.io/<repo>/` within a minute or two.

4. **Run it once now.**
   Actions → *Snapshot Delta* → **Run workflow**. This replaces the bundled starter
   snapshot with live data. After that it runs on its own every hour. (You do not
   have to wait for it — the page computes live numbers in the browser regardless;
   the job exists to build history.)

To run the collector locally: `node scripts/snapshot.mjs` (Node 18+, no dependencies).

---

## The page

Two views, toggled in the header (the choice is remembered per browser):

**Simple** opens with a one-line read on which way the protocol is moving, then
six cards — price, how much you can sell before the price moves 2%, real revenue,
locked supply, whale concentration, and daily turnover. Each states in plain
language *why that number reaches price*, so someone new to DeFi can use the page
without a glossary.

**Full** adds the protocol tiles, liquidity-shape breakdown, stake vaults, holder
distribution and the pool table. Every metric carries a **?** that opens the same
two-part explainer — what it is, and the mechanism by which it moves price — on
hover, tap or keyboard focus.

### Staying current

| | Updates | Purpose |
|---|---|---|
| Page load | immediately | You never open the page to a stale number |
| While open | every 10 minutes | Keeps a parked tab honest |
| **Refresh** button | on demand | Forces a full recompute right now |
| Hourly Action | every hour | Builds the history the charts plot; offline fallback |

A status pill in the header shows which you are looking at: **live** with a
timestamp once the browser has recomputed, or a warning if the live fetch failed
and the committed snapshot is being shown instead.

The live path and the scheduled job import the *same* `scripts/lib/delta.mjs`, so
they cannot drift. Two of Delta's endpoints (`/api/farms/topology`,
`/api/usdg/pools`) are not CORS-open; the browser falls back to the farm topology
from the committed snapshot and reads ETH/USD straight from the chain, which is
what it prefers anyway.

### Share card

**Share card** renders a PNG on a canvas and opens it for download: 1200×1500 (4:5)
to fill the timeline on a phone, or 1600×900 (16:9). It carries the price, five
supporting numbers, and the same one-to-two sentence read, with the ratios behind
that read printed underneath so the claim is checkable rather than asserted.

The wording comes from `direction()` in the collector, which scores a fixed set of
signals the same way every run and always pairs the lead with a standing caveat
(thin depth, a short reward runway, or concentrated supply). It describes what the
data did — never what price will do — and the card is stamped "not financial advice".
`direction()` is exported, so a Discord bot can post the identical sentence.

## What it tracks

**Protocol** — Delta TVL, fee generation over 4h / 12h / 24h / 7d / 14d / 30d,
fee yield on Delta's own capital, positions opened, unique LPs, and — labelled
separately as chain context — volume and trades across every pool Delta indexes.

**Liquidity shape (DELTA/WETH)** — the part that plain TVL hides. The collector
walks the pool's initialised ticks outward from spot and measures how much capital
actually sits within ±2% and ±5% of the current price, split into the side that
absorbs sells (WETH) and the side that absorbs buys (DELTA). At the time of writing
only about **2% of the pool's $1.35M** is close enough to spot to absorb a trade
without real slippage — the signature of broad, near-full-range liquidity rather
than tightly shaped positions. That is also why 24h volume is ~256× the *active*
capital but only ~5× the pool as a whole.

A cross-check worth knowing: for uniformly spread liquidity the ±5% band should hold
about 2.45× what the ±2% band holds, because that is the ratio of their tick spans.
Measured, it is 2.44×. The self-test asserts this, so a broken tick walk shows up as
a failure rather than a plausible-looking wrong number.

**Stakes and real yield** — for each of Delta's 16 stake vaults: the USD value of
the staked position (computed from the vault's Uniswap V3 liquidity and tick range),
the WETH emission rate, and a real-yield APR. Rewards are paid in WETH rather than a
minted token, so the APR is not inflated by emissions of the protocol's own supply.

**$DELTA token** — price, market cap and tradeable float, locked supply, holder
count, top-10 / top-50 concentration, wallet-only concentration (excluding the
locker, the pool and other contracts), and an approximate Gini coefficient.

**Growth charts** — every metric above plotted over time from the accumulated
snapshots, aggregated to one point per day beyond a three-day span. Price and
market cap do not wait for that: they use Delta's own daily OHLC candles
(`/ix/pools/token/{token}/candles`), so those two charts show real history from the
very first load.

---

## Where the numbers come from

| Source | Used for |
|---|---|
| `deltaliquidity.app/stats`, `/ix/pnl/tvl`, `/ix/pools/list`, `/ix/farms/metrics`, `/api/farms/topology` | Delta's own read API — TVL, fees by window, per-pool volume, farm topology |
| `rpc.mainnet.chain.robinhood.com` | `eth_call` reads: pool `slot0`/`liquidity`/`ticks`, vault tick ranges and liquidity, farm `rewardRate`/`periodFinish`, ERC-20 balances |
| `robinhoodchain.blockscout.com` | Token metadata, holder count, holder list |

Delta's API is undocumented and could change shape without notice. If a run starts
failing, the endpoint list at the top of `scripts/snapshot.mjs` is the place to look.

### Things worth knowing about the data

- **ETH/USD is read from the chain, not from Delta's API.** This is the big one.
  `/stats.ethUsd` is a cached value that was observed **frozen for 55 hours**
  (reading 2455.02 while the live WETH/USDG pool priced ETH at 2396.37 — a 2.5%
  gap). Every USD figure in a snapshot is scaled by this rate, so a stale ETH price
  silently inflates market cap, TVL, fee totals, depth and staking APR *together*,
  in a way that looks internally consistent. The collector now reads ETH/USD from
  the deepest WETH/USDG pool on chain — the same pool Delta names as its own
  `ethRatePool` — and agrees with Delta's live feed to 0.02%. The snapshot records
  `ethUsdSource` and the drift from the cached value, and the page shows a banner
  whenever they diverge by more than 0.75%.
- **Market cap prices the full supply.** Delta's site, its market-cap chart and its
  range builder all value all 1B tokens, and so does every aggregator, so the
  headline matches that convention and is directly comparable to theirs. The
  float-only value (excluding the 100M in the locker) is carried alongside as
  `floatCapUsd` and shown as "tradeable float" rather than quietly substituted for
  market cap — the two differ by 10%, which is more than enough to look like
  agreement by coincidence at some moments and a bug at others.

- **Ratios only compare like with like.** `/ix/pools/list` reports each *pool's*
  volume across every pool Delta indexes — chain-wide activity generated by all the
  liquidity in those pools, not Delta's. Dividing it by Delta's own TVL produced a
  "176× capital efficiency" that measured nothing, so it is gone. What replaced it
  is fee yield: fees earned *by Delta positions* over the value held *in Delta
  positions*, as a daily rate. `/stats` confirms the numerator is Delta-scoped —
  `feesManagedWeth + feesDirectWeth` equals `feesWeth` exactly. Chain volume is
  still shown, labelled as chain activity, and never divided by anything Delta-scoped.
- **DELTA's price is read from the pool, not the API.** `sqrtPriceX96²`, adjusted
  for the decimal difference, is the price the tick-level liquidity maths is already
  denominated in. Delta's reported price is kept as `priceUsdApi`; the two track
  within about 1%, and the self-test fails if they ever diverge past 5%.
- **`feesManagedUnpriced`** counts fee events Delta could not price (v4 above-ceiling).
  It was 311 at the time of writing, which means the fee total slightly understates.

- **Delta TVL is not pool TVL.** `/ix/pnl/tvl` reports capital sitting in *Delta*
  positions (~$1.58M), not the full depth of the underlying pools. Both appear on the
  page, labelled separately.
- **Emissions are read from the contracts, not the API.** `/ix/farms/metrics` reports
  only rewards that have already *settled* over a window, so it reads `0` for a
  freshly funded farm — including the largest one. The collector uses each farm's
  on-chain `rewardRate` instead (stored at 1e36 precision), gated on `periodFinish`
  still being in the future. Delta's settled figure is kept alongside as
  `settledWethPerDay` for cross-checking.
- **Pool prices need decimal adjustment.** The API's `price` field is a raw ratio.
  WETH-quoted pools happen to have matching decimals so they look right as-is, but
  USDG-quoted pools (6dp quote, 18dp token) read 1e12 too small. The collector
  applies `10 ** (tokenDecimals - quoteDecimals)`.
- **A token can appear more than once.** The pool list returns the same token in both
  its `active` and `established` buckets, and a token often has several pools at
  different fee tiers. Rows are de-duplicated by pool address before anything is summed.
- **Circulating supply** = total supply minus balances at the addresses in
  `CFG.NON_CIRCULATING` (currently `RobinhoodLocker`, holding 100M, plus burn
  addresses). Every excluded address is echoed into `latest.json` so the number can
  be audited. Add addresses there if more supply gets locked.
- **Concentration is reported two ways.** Top-10 by address includes the locker and
  the pool contract, which are not people; top-10 *wallets* excludes contracts and is
  the number a trader actually wants. Two pages of holders are pulled (100 addresses)
  so the wallet-only top 50 is a real top 50 rather than whatever survived filtering
  one page.
- **Gini is approximate.** Exact across the top holders Blockscout returns, with the
  remaining supply spread evenly across the remaining holders. That assumption
  understates true inequality, so treat it as a floor.

### Not tracked: Router custody

Delta's roadmap describes a **Router** that converts project fees into liquidity on
schedules or market-cap milestones, with custody set to *locked*, *burned*, or
*operator-held*. As of this build there is no public routing interface, no router
contract in Delta's published contract list, and no endpoint exposing routes — so
milestone alerts and the burned/locked/operator split cannot be computed yet, and
the dashboard does not guess at them. When Delta ships the routing interface, add a
`router` block to `collect()` and a section to the page; the shape of everything
else is already in place.

---

## Reconciling against Delta's own site

Worth knowing how the two line up, because most apparent gaps are timing, not method:

| Delta's UI | This dashboard | Relationship |
|---|---|---|
| MARKET CAP | `delta.supply.marketCapUsd` | Same: full supply x price |
| 24H VOLUME / 24H FEES | `delta.volume24hUsd` / `fees24hUsd` | Same. Their fees are volume x fee tier, which lands on the tier exactly |
| LIQUIDITY (`N ETH`) | `delta.liquidity.poolTvlUsd` | Same pool value, theirs quoted in ETH |
| TVL | `protocol.managedTvlUsd` | Same field |
| TOTAL FEES | `protocol.lifetimeFeesUsd` | Same, but see below — it moves with ETH |
| ETH PRICE | `ethUsd` | Ours is live from chain; theirs was stale in `/stats` |

**Total fees can go down.** Fees accrue in WETH and every USD total is that WETH
revalued at spot, so a falling ETH drags the all-time figure down even though no
fees were lost. `protocol.lifetimeFeesWeth` is the monotonic series — chart that one
if a decreasing "all-time" number would confuse people.

**Volume and fees run ~4% below Delta's token page.** Their header is token-wide;
`/ix/pools/list` only surfaces DELTA's main v3 pool, and the v4 endpoint publishes
pool state but no volume. So our $4.50M against their $4.68M is a known, bounded
gap in the same direction every time, not a drifting error. Fees inherit it exactly
(ours $44.96K vs their $46.86K), because fees are volume x fee tier.

**DELTA's pool count.** The token has 153 pools on paper, but the 1% WETH v3 pool
holds **99.7%** of the readable liquidity ($1.175M of $1.179M; the next three v3
pools hold $3.5K, $4 and $0). Volume, fees and depth are aggregated across every
readable pool anyway, so a second venue is picked up automatically if one grows.
v4 pools use a singleton PoolManager and cannot be read with v3 calls; they are
reported as `poolsUnreadable` rather than silently dropped.

## Files

```
index.html               the dashboard (no build step, no dependencies)
scripts/snapshot.mjs     the collector — every endpoint and formula lives here
data/latest.json         current snapshot, rewritten each run
data/history.json        append-only time series behind the growth charts
.github/workflows/snapshot.yml   the 4-hourly job
```

`data/latest.json` and `data/history.json` ship with one real snapshot taken on
2026-09-02 so the page renders immediately; the first workflow run replaces it.

## Tuning

Everything configurable is the `CFG` object at the top of `scripts/snapshot.mjs`:
the token and pool addresses, the RPC URL (`RHC_RPC` env var overrides it), the
non-circulating address list, the depth bands (`[0.02, 0.05]`), how many pools to
keep, and the history cap. To change the cadence, edit the `cron` line in the
workflow — but keep in mind each run is one commit, so every 4 hours is already
~2,200 commits a year.

## Going further

- **Discord bot.** `collect()` returns a plain object and has no browser or
  filesystem dependency, so the same file can back a webhook post. Import it,
  format the fields you want, and `POST` to a Discord webhook URL on the same
  schedule — the same shape as the PONS updates that inspired this.
- **Alerting.** Compare the new snapshot against the last row of `history.json` and
  post only when something crosses a threshold: a large-holder move, a fee-per-day
  drop, staking rewards running out (`rewardsEndsInDays`), or active liquidity
  collapsing.
- **More tokens.** `CFG.DELTA` / `CFG.DELTA_POOL` are the only token-specific
  values; point them elsewhere for a second dashboard.
