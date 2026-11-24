// Fresh-momentum bot for the pump.fun paper sprint (agent-fun/replay/v2).
//
// Idea (second pass, after the sweep): a micro-scalp on fresh coins. Buy a
// small, equal stake in a coin within its first seconds of trading, only
// after its first trades show real buy pressure, then get out within seconds
// — the whole trade is over before the usual post-launch dump. Every coin is
// bought at most once, so capital keeps rotating to new coins and the
// 20-coin guardrail is met by breadth, not by re-trading the same winners.
//
// Why this shape: the first sweep (10 sets, full dev window) showed every
// slow variant losing money, and losing more the longer it held — holding
// losers bleeds, and the half-take-profit that let winners "run" mostly gave
// the gains back. The tightest sets won on both halves of a coin-split
// stress test, and the pilot sniper reference (same shape) loses least of
// all. So exits are tight and final: take-profit sells the whole position.
//
// Entry (all on the coin's own trade tape, slots since its CreateEvent):
//   - very young: at most maxAge slots old;
//   - at least minBuys buy trades from at least minBuyers distinct wallets in
//     the last `window` slots, with net buy SOL >= minNetSol;
//   - price up at least minPriceUp (and at most maxPriceUp) since the window
//     start, sitting within nearHigh of the window high — a breakout, not a
//     coin that already ran and faded;
//   - real SOL reserve inside [minRqSol, maxRqSol]: too small and the 1%
//     size cap makes the trade fee-dominated, too large and it is no longer
//     an early coin.
//   - stake is min(stakeSol, size cap); skipped when the cap is below
//     minBuySol, so the coin waits for its reserve to grow instead of
//     buying dust. minBuySol stays above the 0.01 SOL round-trip floor.
//
// Exits (checked every batch, exits first, before any new entry):
//   - take-profit: sell everything at cost * (1 + takeProfit);
//   - give-back guard: once value has peaked at cost * (1 + trailArm), sell
//     everything when it falls trail below that peak;
//   - hard stop: sell everything at cost * (1 - stopLoss);
//   - fade: sell everything when the last fadeWindow slots show net outflow
//     worse than -fadeNetSol while the position is not comfortably up
//     (off by default: fadeNetSol huge);
//   - time: sell everything after maxHold slots unless the position is up at
//     least holdIfUp (a runner earns more time).
// A curve that completes is closed by the replay itself. Sells use wide-open
// slippage (10000 bps): a sell refused for a 2-slot price move is worse than
// a sell at a slightly worse price.
//
// Deterministic by construction: no clock, no randomness, no environment;
// iteration is over insertion-ordered maps fed by the batch stream, and
// per-coin tapes are trimmed in slot order.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Entry lookback window, in slots. */
  window: number;
  /** Net buy SOL (buys minus sells) over the window. */
  minNetSol: number;
  /** Buy trades in the window. */
  minBuys: number;
  /** Distinct buying wallets in the window. */
  minBuyers: number;
  /** Price now over price at the window start, minus 1. */
  minPriceUp: number;
  /** Upper bound on that rise: skip coins that already ran too far. */
  maxPriceUp: number;
  /** Price now at least this share of the window high. */
  nearHigh: number;
  /** Real SOL reserve bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Slots since CreateEvent before an entry is allowed / after which it is not. */
  minAge: number;
  maxAge: number;
  /** Target SOL per position (the 1%-of-real-reserve cap applies too). */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Sell everything when value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Hard stop: sell all at cost * (1 - stopLoss). */
  stopLoss: number;
  /** Trailing stop arms once value reached cost * (1 + trailArm). */
  trailArm: number;
  /** Once armed, sell all when value falls this far below its peak. */
  trail: number;
  /** Exit after this many slots held (unless up at least holdIfUp). */
  maxHold: number;
  /** The time limit does not apply while the position is up at least this much. */
  holdIfUp: number;
  /** Fade window (slots) and exit when net SOL over it is below -fadeNetSol. */
  fadeWindow: number;
  fadeNetSol: number;
}

export const DEFAULT_PARAMS: Params = {
  window: 10,
  minNetSol: 0.05,
  minBuys: 2,
  minBuyers: 1,
  minPriceUp: 0,
  maxPriceUp: 0.5,
  nearHigh: 0.8,
  minRqSol: 0.3,
  maxRqSol: 50,
  minAge: 0,
  maxAge: 10,
  stakeSol: 0.05,
  minBuySol: 0.012,
  buySlipBps: 10_000,
  takeProfit: 0.15,
  stopLoss: 0.12,
  trailArm: 0.1,
  trail: 0.1,
  maxHold: 25,
  holdIfUp: 10,
  fadeWindow: 20,
  fadeNetSol: 1000,
};

const LAMPORTS = 1e9;
/** Curve fee share (protocol 95bps + creator 30bps) deducted from a sell's value. */
const CURVE_FEE = 0.0125;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: Trade[];
}

interface Held {
  opened: number;
  peakValue: number;
  /** True once a full exit sell has been sent. */
  exiting: boolean;
  /** Some buy of this position filled. */
  filled: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Coins already bought once (or decided against for good): never re-entered. */
  const decided = new Set<Pubkey>();
  const keep = Math.max(p.window, p.fadeWindow) + 5;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, trades: [] };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** Entry signal on a coin's tape at slot `now`. */
  const entrySignal = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.created === null) return false;
    const age = now - t.created;
    if (age < p.minAge || age > p.maxAge) return false;
    const from = now - p.window;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    const byUser = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
      }
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (buys < p.minBuys || byUser.size < p.minBuyers) return false;
    if (buySol - sellSol < p.minNetSol) return false;
    if (startPrice <= 0 || last <= 0) return false;
    const up = last / startPrice - 1;
    if (up < p.minPriceUp || up > p.maxPriceUp) return false;
    if (last < high * p.nearHigh) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded: Pubkey[] = [];
      const seenTraded = new Set<Pubkey>();
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          if (!seenTraded.has(e.mint)) {
            seenTraded.add(e.mint);
            traded.push(e.mint);
          }
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      /** Mark-to-market value of a held position in SOL, curve and tx fees deducted. */
      const valueOf = (mint: Pubkey): number => {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined || curve === undefined) return 0;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        return ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
      };

      // Exits first: a coin that should be sold is never left holding while we buy more.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) held.delete(mint);
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint)) continue;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        const value = valueOf(mint);
        if (value > h.peakValue) h.peakValue = value;
        const t = tapeOf(mint);
        let exit = h.exiting;
        // Take-profit sells the whole position: in this universe the half left
        // riding mostly gives the gain back (first sweep).
        if (!exit && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && value < cost * 1.05 && flow(t, now, p.fadeWindow) < -p.fadeNetSol) exit = true;
        if (!exit && now - h.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Entries: one buy per coin, in batch event order, while slots and cash last.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      for (const mint of traded) {
        if (orders.length >= cap || slotsLeft <= 0) break;
        if (decided.has(mint) || held.has(mint) || pendingByMint.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const t = tapes.get(mint)!;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (!entrySignal(t, now, rqSol)) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, p.stakeSol);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: BigInt(Math.floor(amount * LAMPORTS)),
          max_slippage_bps: p.buySlipBps,
        });
        decided.add(mint);
        held.set(mint, { opened: now, peakValue: 0, exiting: false, filled: false });
        free -= amount + tx;
        slotsLeft--;
      }
      return orders;
    },
  };
}
