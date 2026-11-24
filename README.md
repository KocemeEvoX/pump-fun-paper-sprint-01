# Pump.fun Paper Sprint — Fresh-Momentum Micro-Scalp

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/KocemeEvoX/pump-fun-paper-sprint-01/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/KocemeEvoX/pump-fun-paper-sprint-01/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A bot for the make.fun bounty **Pump.fun Paper Sprint: Any Bot Can Win**
(`u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b`). It paper-trades
pump.fun bonding curves on a 6-hour replay (agent-fun/replay/v2), starting
from 10 SOL, max 5 open positions.

## Strategy

A micro-scalp on fresh coins, written fresh for this bounty:

- **Entry.** Within 10 slots of a coin's `CreateEvent`, buy once it shows
  real buy pressure: at least 2 buy trades from at least 1 distinct wallet
  in the last 10 slots, net buy flow ≥ 0.05 SOL, price flat-to-up (0% to
  +50% since the window start) and near its window high, real SOL reserve
  0.3–50 SOL. Stake is 0.05 SOL, capped at 1% of the real reserve (the
  harness size cap); buys below 0.012 SOL are skipped. One buy per coin,
  ever — capital keeps rotating to new coins.
- **Exits (checked first every batch).** Sell everything at +15%
  take-profit; give-back guard sells everything once a +10% peak pulls back
  10%; hard stop at −12%; time exit after 25 slots unless up ≥ 10x the
  stop (a runner earns more time). A curve that completes is closed by the
  replay. Sells use wide-open slippage (10000 bps).
- **Why this shape.** A 16-set sweep on the dev window showed every slow
  variant losing money, and losing more the longer it held; the tightest
  sets won on both halves of a coin-split stress test. The half
  take-profit of the first version mostly gave its gains back, so the
  second pass sells the whole position at take-profit.
- **Deterministic.** No clock, no randomness, no network; iteration only
  over insertion-ordered maps fed by the batch stream. Two runs produce
  byte-identical action logs (checked in `tools/backtest.ts`).

## Layout

- `main.ts` — entrypoint, run by the grader as `node /bot/main.ts` (Node 22).
- `strategy.ts` — the strategy (parameters in `DEFAULT_PARAMS`).
- `vendor/makefun-bot.ts` — the kit's SDK shim, byte-identical.
- `tools/` — local backtest harness: `sim.ts` (a port of the replay
  engine, loading all three dataset parts), `backtest.ts`, `sweep.ts`.

## Run locally

```sh
node tools/backtest.ts <path to the unpacked kit>   # dev-window backtest
node tools/sweep.ts <path to the unpacked kit>      # parameter sweep
```

Dev-window backtest after the second pass (local sim, all 3 dataset parts,
1222 coins): net **−1.11 SOL**, 1156 fills, 578 coins, 578 round trips
(127 wins), max drawdown 0.114, 0 rejected, 17 failed txs, determinism PASS.
The kit's own `grade-local` (process driver) on the same code agrees:
net **−1.073 SOL**, 1146 fills over 573 coins, 573 round trips, win rate
22.9%, max drawdown 0.110, 0 rejected, 27 failed, guardrails met, L1 regrade
reproduced byte for byte. The dev window is a hard, dump-dominated sample —
no variant tested here (including the kit's pilot strategies) scores
positive on it — so the numbers are reported as measured, not dressed up.

## License

MIT — see `LICENSE`.
