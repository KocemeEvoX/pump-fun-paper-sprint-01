// Offline backtest of strategy.ts on the kit's dev window (all 3 parts) with the
// local engine port (tools/sim.ts).
//
//   node tools/backtest.ts <kit dir> ['{"stakeSol":0.4}'] [--trips]
//
// Prints net PnL, fills, coins, drawdown, reject reasons, top-3 coin share of
// PnL, and a determinism check (two runs, action-log hashes must match).

import { createStrategy, DEFAULT_PARAMS, type Params } from '../strategy.ts';
import { loadDataset, makeHello, phaseSeed, simulate } from './sim.ts';

const kit = process.argv[2];
if (kit === undefined) {
  console.error('usage: node tools/backtest.ts <kit dir> [params json] [--trips]');
  process.exit(2);
}
const overrides = process.argv[3] !== undefined && process.argv[3].startsWith('{') ? (JSON.parse(process.argv[3]) as Partial<Params>) : {};
const ds = loadDataset(kit);
const hello = makeHello(phaseSeed('pilot-pumpfun-replay', 'dev', ds.sha256));
const params = { ...DEFAULT_PARAMS, ...overrides };
const r = simulate(ds, hello, createStrategy(params));
const sol = (x: bigint) => (Number(x) / 1e9).toFixed(6);
const wins = r.trips.filter((t) => t.pnl > 0n).length;
console.log(`net ${sol(r.netPnl)} SOL  fills ${r.fills}  coins ${r.mints}  trips ${r.trips.length}  wins ${wins}  losses ${r.trips.length - wins}  dd ${r.maxDrawdown.toFixed(4)}  rejected ${r.rejected} ${JSON.stringify(r.rejectReasons)}  failed ${r.failed}`);
const sorted = [...r.perMint.entries()].sort((a, b) => (a[1] > b[1] ? -1 : a[1] < b[1] ? 1 : 0));
const top3 = sorted.slice(0, 3).reduce((s, [, v]) => s + v, 0n);
const top3Share = r.netPnl !== 0n ? (Number(top3) / Number(r.netPnl)) : 0;
console.log(`top3 share ${top3Share.toFixed(3)}  top3: ${sorted.slice(0, 3).map(([m, v]) => `${m.slice(0, 6)}:${sol(v)}`).join(' ')}  without-top3 ${sol(r.netPnl - top3)}`);
const noFail = simulate(ds, hello, createStrategy(params), { failKey: null });
const twoX = simulate(ds, hello, createStrategy(params), { feeMultiplier: 2n });
console.log(`without failed txs ${sol(noFail.netPnl)}  at 2x fees ${sol(twoX.netPnl)}`);
// Determinism: a second run must produce the identical action log.
const again = simulate(ds, hello, createStrategy(params));
console.log(`determinism ${again.actionLogHash === r.actionLogHash ? 'PASS' : 'FAIL'}  hash ${r.actionLogHash.slice(0, 16)}`);
if (process.argv.includes('--trips')) {
  for (const t of r.trips) console.log(t.mint, t.open, t.close - t.open, sol(t.pnl));
}
