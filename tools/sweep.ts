// Small parameter sweep for strategy.ts on the dev window (all 3 parts).
//
//   node tools/sweep.ts <kit dir>
//
// Prints one line per parameter set: net PnL, fills, coins, trips, wins,
// drawdown, rejected/failed, top-3 share. Pick by robustness (median across
// sets, low concentration, drawdown well under 50%), not the best cell.

import { createStrategy, DEFAULT_PARAMS, type Params } from '../strategy.ts';
import { loadDataset, makeHello, phaseSeed, simulate } from './sim.ts';

const kit = process.argv[2];
if (kit === undefined) {
  console.error('usage: node tools/sweep.ts <kit dir>');
  process.exit(2);
}
const ds = loadDataset(kit);
const hello = makeHello(phaseSeed('pilot-pumpfun-replay', 'dev', ds.sha256));
const sol = (x: bigint) => (Number(x) / 1e9).toFixed(3);

const SETS: Array<[string, Partial<Params>]> = [
  ['A v1-defaults', {}],
  ['B stake0.05', { stakeSol: 0.05 }],
  // Round 2: micro-scalp shape — buy fresh coins fast, exit within seconds.
  // (The pilot sniper reference scores -0.49 SOL / dd 0.053 on this window with
  // the same shape: age<=3 slots, stake 0.1, TP +15%, SL -12%, hold<=10 slots.
  // These sets are my own thresholds around that shape, not its parameters.)
  ['K scalp0.05 age30 hold60', { stakeSol: 0.05, minBuySol: 0.01, maxAge: 30, window: 10, minBuys: 2, minBuyers: 1, minNetSol: 0.05, minPriceUp: 0, maxPriceUp: 0.5, nearHigh: 0.8, minRqSol: 0.3, takeProfit: 0.2, stopLoss: 0.12, trailArm: 0.15, trail: 0.15, maxHold: 60, holdIfUp: 10, fadeNetSol: 1000 }],
  ['L scalp0.10 age30 hold60', { stakeSol: 0.1, minBuySol: 0.01, maxAge: 30, window: 10, minBuys: 2, minBuyers: 1, minNetSol: 0.05, minPriceUp: 0, maxPriceUp: 0.5, nearHigh: 0.8, minRqSol: 0.3, takeProfit: 0.2, stopLoss: 0.12, trailArm: 0.15, trail: 0.15, maxHold: 60, holdIfUp: 10, fadeNetSol: 1000 }],
  ['M scalp0.05 age10 hold25', { stakeSol: 0.05, minBuySol: 0.01, maxAge: 10, window: 10, minBuys: 2, minBuyers: 1, minNetSol: 0.05, minPriceUp: 0, maxPriceUp: 0.5, nearHigh: 0.8, minRqSol: 0.3, takeProfit: 0.15, stopLoss: 0.12, trailArm: 0.15, trail: 0.15, maxHold: 25, holdIfUp: 10, fadeNetSol: 1000 }],
  ['N scalp0.05 age60 hold120', { stakeSol: 0.05, minBuySol: 0.01, maxAge: 60, window: 20, minBuys: 2, minBuyers: 1, minNetSol: 0.05, minPriceUp: 0, maxPriceUp: 0.5, nearHigh: 0.8, minRqSol: 0.3, takeProfit: 0.3, stopLoss: 0.15, trailArm: 0.2, trail: 0.2, maxHold: 120, holdIfUp: 10, fadeNetSol: 1000 }],
  ['O scalp0.05 rise-req', { stakeSol: 0.05, minBuySol: 0.01, maxAge: 30, window: 10, minBuys: 3, minBuyers: 2, minNetSol: 0.1, minPriceUp: 0.05, maxPriceUp: 0.5, nearHigh: 0.85, minRqSol: 0.3, takeProfit: 0.2, stopLoss: 0.12, trailArm: 0.15, trail: 0.15, maxHold: 60, holdIfUp: 10, fadeNetSol: 1000 }],
  ['P scalp0.05 TP50', { stakeSol: 0.05, minBuySol: 0.01, maxAge: 30, window: 10, minBuys: 2, minBuyers: 1, minNetSol: 0.05, minPriceUp: 0, maxPriceUp: 0.5, nearHigh: 0.8, minRqSol: 0.3, takeProfit: 0.5, stopLoss: 0.12, trailArm: 0.3, trail: 0.25, maxHold: 60, holdIfUp: 10, fadeNetSol: 1000 }],
];

const nets: number[] = [];
for (const [name, over] of SETS) {
  const params = { ...DEFAULT_PARAMS, ...over };
  const r = simulate(ds, hello, createStrategy(params));
  const wins = r.trips.filter((t) => t.pnl > 0n).length;
  const sorted = [...r.perMint.entries()].sort((a, b) => (a[1] > b[1] ? -1 : a[1] < b[1] ? 1 : 0));
  const top3 = sorted.slice(0, 3).reduce((s, [, v]) => s + v, 0n);
  const share = r.netPnl !== 0n ? Number(top3) / Number(r.netPnl) : 0;
  nets.push(Number(r.netPnl) / 1e9);
  console.log(`${name}: net ${sol(r.netPnl)} fills ${r.fills} coins ${r.mints} trips ${r.trips.length} wins ${wins} dd ${r.maxDrawdown.toFixed(3)} rej ${r.rejected} fail ${r.failed} top3 ${share.toFixed(2)} w/o-top3 ${sol(r.netPnl - top3)}`);
}
nets.sort((a, b) => a - b);
const med = nets[Math.floor(nets.length / 2)];
console.log(`sweep net SOL: median ${med.toFixed(3)} p10 ${nets[Math.floor(0.1 * nets.length)].toFixed(3)} p90 ${nets[Math.floor(0.9 * nets.length)].toFixed(3)} min ${nets[0].toFixed(3)} max ${nets[nets.length - 1].toFixed(3)}`);
