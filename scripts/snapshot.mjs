#!/usr/bin/env node
/**
 * Scheduled snapshot runner.
 *
 * Thin Node wrapper around scripts/lib/delta.mjs: reads the existing history,
 * runs the shared collector, and writes data/latest.json + data/history.json.
 * All of the arithmetic lives in the library so the browser runs the same code.
 *
 *   node scripts/snapshot.mjs
 */

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect, historyRow, CFG } from './lib/delta.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = resolve(ROOT, 'data');


async function main() {
  let history = [];
  try {
    history = JSON.parse(await readFile(resolve(DATA, 'history.json'), 'utf8'));
    if (!Array.isArray(history)) history = [];
  } catch {
    /* first run */
  }

  // History goes in so the direction read can use trend signals once they exist.
  const snap = await collect({ history });

  const row = historyRow(snap);
  const last = history[history.length - 1];
  // Guard against a double-run within the same 10 minutes overwriting the series.
  if (last && snap.ts - last.ts < 600) history[history.length - 1] = row;
  else history.push(row);
  if (history.length > CFG.HISTORY_CAP) history = history.slice(-CFG.HISTORY_CAP);

  await mkdir(DATA, { recursive: true });
  await writeFile(resolve(DATA, 'latest.json'), JSON.stringify(snap, null, 2));
  await writeFile(resolve(DATA, 'history.json'), JSON.stringify(history));

  console.log(
    `snapshot ${snap.iso}  block ${snap.block}  ` +
      `managedTVL $${Math.round(snap.protocol.managedTvlUsd).toLocaleString()}  ` +
      `fees24h $${Math.round(snap.protocol.fees.h24 || 0).toLocaleString()}  ` +
      `DELTA $${snap.delta.priceUsd.toPrecision(4)}  ` +
      `MC $${(snap.delta.supply.marketCapUsd / 1e6).toFixed(2)}M  ` +
      `holders ${snap.delta.holders.count}  ` +
      `history ${history.length} rows`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error('snapshot failed:', e);
    process.exit(1);
  });
}
