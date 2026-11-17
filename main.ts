// AnchorSnap: a long-only cbBTC/USDC bot for the bars-replay/v1 harness.
//
// Strategy (designed for this replay: fills at the next bar's open, 4 bps fee,
// 2 bps slippage, constant-product impact against each bar's pool depth, so a
// full-size round trip costs roughly 35 bps and only dislocations pay):
//
//   - Anchor: the simple mean of the last 360 closes (six hours). The bot
//     measures how far the latest close sits from that anchor.
//   - Mean-reversion entry: when flat and the close is at least 0.50% under
//     the anchor, buy with 90% of equity. It only dip-buys while the anchor
//     itself is not sliding: if the anchor fell more than 0.4% over the 240
//     bars before it, the dip is treated as a downtrend, not a dislocation.
//   - Exit: sell the whole position when the close is back at the anchor, or
//     when the close falls 1.5% under the entry fill price (stop), whichever
//     comes first. After an exit that filled under the entry price, entries
//     pause for 300 bars so a grinding slide is not bought again and again.
//   - Trend fallback: if nothing has been bought by bar 600 and the close is
//     above the anchor with a 120-bar return over +0.4%, buy 60% of equity
//     and ride it; sell if the close slips 0.2% under the anchor or the stop
//     hits. This keeps the bot in the race on a window that only goes up.
//   - Probe: if still nothing has been bought by bar 1300, buy 15% of equity
//     and hold it to the end, so the bot almost always records a trade.
//   - Every order caps its slippage at 250 bps from the close it was decided
//     on; a refused order is simply decided again on the next bar while its
//     reason still holds, because every decision below reads the account and
//     the latest bar fresh from the batch.
//
// All arithmetic is float64 on + - * / over the bars' integers, so two runs
// on the same bars send the same orders. No clock, no randomness, no files.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

const ANCHOR_SPAN = 360; // bars in the anchor mean (six hours of 1m bars)
const BUY_DEV = -0.005; // enter at a close 0.50% or more under the anchor
const EXIT_DEV = 0; // leave when the close is back at the anchor
const SIZE_FRAC = 0.9; // share of equity a mean-reversion buy spends
const STOP_FRAC = 0.015; // leave when the close is 1.5% under the entry fill
const SLOPE_SPAN = 240; // bars the anchor's own drift is measured over
const SLOPE_MIN = -0.004; // anchor down more than 0.4% over that span: no dip-buy
const COOLDOWN_BARS = 300; // bars with no entries after a losing exit
const TREND_FROM = 600; // first bar the trend fallback may fire on
const TREND_SPAN = 120; // bars the fallback's return is measured over
const TREND_RET = 0.004; // fallback needs a 120-bar return over +0.4%
const TREND_SIZE = 0.6; // share of equity the trend fallback spends
const TREND_EXIT_DEV = -0.002; // trend position leaves 0.2% under the anchor
const PROBE_FROM = 1300; // first bar the probe may fire on
const PROBE_SIZE = 0.15; // share of equity the probe spends
const MAX_SLIPPAGE_BPS = 250;

/** Closes of CBBTC bars seen so far, oldest first (raw prices, price_scale). */
const closes: number[] = [];
/** Running sum of the last ANCHOR_SPAN closes. */
let anchorSum = 0;
/** Running sum of the ANCHOR_SPAN closes that ended SLOPE_SPAN bars ago. */
let pastSum = 0;
/** Index (in CBBTC bars) of the bar being answered; -1 before the first. */
let barIndex = -1;
/** Filled buys so far. */
let entries = 0;
/** What the open position is: 'mr' | 'trend' | 'probe', or null when flat. */
let kind: 'mr' | 'trend' | 'probe' | null = null;
/** The kind the buy last sent will open, once its fill lands. */
let sentKind: 'mr' | 'trend' | 'probe' | null = null;
/** Raw fill price of the buy that opened the position. */
let entryPrice = 0;
/** Entries are blocked while barIndex is below this (post-loss cooldown). */
let cooldownUntil = -1;

function anchorNow(): number | null {
  return closes.length >= ANCHOR_SPAN ? anchorSum / ANCHOR_SPAN : null;
}

function anchorPast(): number | null {
  return closes.length >= ANCHOR_SPAN + SLOPE_SPAN ? pastSum / ANCHOR_SPAN : null;
}

/** Fold one CBBTC bar into the anchor windows. */
function pushClose(close: number): void {
  barIndex++;
  closes.push(close);
  anchorSum += close;
  if (closes.length > ANCHOR_SPAN) anchorSum -= closes[closes.length - 1 - ANCHOR_SPAN];
  // The past window trails the current one by SLOPE_SPAN bars: it gains the
  // close that was current SLOPE_SPAN bars ago and drops its own oldest.
  if (barIndex >= SLOPE_SPAN) {
    pastSum += closes[barIndex - SLOPE_SPAN];
    if (barIndex - SLOPE_SPAN >= ANCHOR_SPAN) pastSum -= closes[barIndex - SLOPE_SPAN - ANCHOR_SPAN];
  }
}

/** Learn from the fills a batch carries: entries, exits, losing exits. */
function readFills(batch: Batch): void {
  for (const f of batch.fills) {
    if (f.symbol !== SYMBOL || f.status !== 'filled') continue;
    if (f.side === 'buy') {
      entries++;
      kind = sentKind ?? 'mr';
      entryPrice = Number(f.price);
    } else {
      if (entryPrice > 0 && Number(f.price) < entryPrice) cooldownUntil = barIndex + COOLDOWN_BARS;
      kind = null;
      entryPrice = 0;
    }
  }
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    let fresh = false;
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      pushClose(Number(bar.c));
      fresh = true;
    }
    readFills(batch);
    if (!fresh || state.warmingUp) return [];

    const close = state.close(SYMBOL);
    const anchor = anchorNow();
    if (close === null || anchor === null) return [];
    const closeN = Number(close);
    const dev = closeN / anchor - 1;
    const held = state.positions.get(SYMBOL);

    if (held !== undefined && held.qty > 0n) {
      // Exit rules by the kind of position this is; a position whose opening
      // fill this session somehow did not record is treated as mean-reversion.
      const posKind = kind ?? 'mr';
      let exit = false;
      if (posKind === 'mr') {
        if (dev >= EXIT_DEV) exit = true;
        if (entryPrice > 0 && closeN <= entryPrice * (1 - STOP_FRAC)) exit = true;
      } else if (posKind === 'trend') {
        if (dev <= TREND_EXIT_DEV) exit = true;
        if (entryPrice > 0 && closeN <= entryPrice * (1 - STOP_FRAC)) exit = true;
      }
      // A probe position is held to the end of the window.
      if (exit) return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      return [];
    }

    // Flat: one entry may fire, mean reversion first.
    const equity = state.equity;
    const spend = (frac: number): bigint => {
      const byFrac = (equity * BigInt(Math.round(frac * 10000))) / 10000n;
      const room = state.weightRoom(SYMBOL);
      let n = byFrac < state.cash ? byFrac : state.cash;
      if (room < n) n = room;
      return n;
    };
    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);

    if (barIndex >= cooldownUntil && dev <= BUY_DEV) {
      const past = anchorPast();
      const sliding = past !== null && anchor / past - 1 < SLOPE_MIN;
      if (!sliding) {
        const n = spend(SIZE_FRAC);
        if (n >= minNotional) {
          sentKind = 'mr';
          return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: n, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
      }
    }
    if (entries === 0 && barIndex >= TREND_FROM && dev > 0 && closes.length > TREND_SPAN) {
      const ret = closeN / closes[closes.length - 1 - TREND_SPAN] - 1;
      if (ret > TREND_RET) {
        const n = spend(TREND_SIZE);
        if (n >= minNotional) {
          sentKind = 'trend';
          return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: n, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
      }
    }
    if (entries === 0 && barIndex >= PROBE_FROM) {
      const n = spend(PROBE_SIZE);
      if (n >= minNotional) {
        sentKind = 'probe';
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: n, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
    }
    return [];
  },
});
