// AnchorLadder: a long-only cbBTC/USDC bot for the bars-replay/v1 harness.
//
// Design (fills land at the next bar's open and pay a 4 bps fee, 2 bps of
// slippage and constant-product impact against the bar's pool depth, so a
// full-size round trip costs roughly 35 bps and only real dislocations pay):
//
//   - Anchor: the simple mean of the last 360 closes (six hours). Entries and
//     exits are decided by how far the latest close sits from that anchor.
//   - Laddered mean-reversion entry: the first tranche spends 60% of equity
//     when the close is at least 0.50% under the anchor. Dislocations usually
//     overshoot before they snap back, so if the close sinks to 0.90% or more
//     under the anchor while the position is open, a second tranche spends
//     another 40% of equity and the position's entry price becomes the
//     quantity-weighted blend of the two fills. One average entry, bought in
//     two steps, instead of the whole stake at the first touch. The ladder
//     matters because the exit and the stop are both measured from that one
//     blended entry price: averaging down only helps if the deeper fill
//     genuinely pulls the break-even closer to where the price already is,
//     which the blend arithmetic in readFills guarantees by weighting each
//     fill by its filled quantity rather than by the notional it cost.
//   - Slide guard: neither tranche buys while the anchor itself is falling:
//     if the anchor lost more than 0.6% over the 240 bars before it, the dip
//     is read as a downtrend, not a dislocation.
//   - Exit: sell everything when the close is back at the anchor, or when the
//     close falls 1.5% under the blended entry fill (stop), whichever comes
//     first. An exit filled under the blended entry pauses entries for 300
//     bars, so a grinding slide is not bought again and again.
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
const BUY_DEV = -0.005; // first tranche at a close 0.50% or more under the anchor
const ADD_DEV = -0.009; // second tranche at a close 0.90% or more under the anchor
const EXIT_DEV = 0; // leave when the close is back at the anchor
const FIRST_FRAC = 0.6; // share of equity the first tranche spends
const ADD_FRAC = 0.4; // share of equity the second tranche spends
const STOP_FRAC = 0.015; // leave when the close is 1.5% under the blended entry
const SLOPE_SPAN = 240; // bars the anchor's own drift is measured over
const SLOPE_MIN = -0.006; // anchor down more than 0.6% over that span: no dip-buy
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
/** Quantity-weighted average fill price of the open position (raw price). */
let entryPrice = 0;
/** Quantity held per this bot's own fill tally (raw base units, as float). */
let heldQty = 0;
/** Whether the second tranche has already been added to this position. */
let added = false;
/** Entries are blocked while barIndex is below this (post-loss cooldown). */
let cooldownUntil = -1;

function anchorNow(): number | null {
  return closes.length >= ANCHOR_SPAN ? anchorSum / ANCHOR_SPAN : null;
}

function anchorPast(): number | null {
  return closes.length >= ANCHOR_SPAN + SLOPE_SPAN ? pastSum / ANCHOR_SPAN : null;
}

/** True while the anchor itself is sliding down (a trend, not a dip). */
function sliding(anchor: number): boolean {
  const past = anchorPast();
  return past !== null && anchor / past - 1 < SLOPE_MIN;
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

/** Learn from the fills a batch carries: entries, blends, exits, losses. */
function readFills(batch: Batch): void {
  for (const f of batch.fills) {
    if (f.symbol !== SYMBOL || f.status !== 'filled') continue;
    if (f.side === 'buy') {
      entries++;
      const q = Number(f.qty);
      const p = Number(f.price);
      if (heldQty > 0 && kind === 'mr') {
        // Second tranche: fold this fill into the blended entry price.
        entryPrice = (entryPrice * heldQty + p * q) / (heldQty + q);
        added = true;
      } else {
        kind = sentKind ?? 'mr';
        entryPrice = p;
        added = false;
      }
      heldQty += q;
    } else {
      heldQty -= Number(f.qty);
      if (heldQty <= 0) {
        heldQty = 0;
        if (entryPrice > 0 && Number(f.price) < entryPrice) cooldownUntil = barIndex + COOLDOWN_BARS;
        kind = null;
        entryPrice = 0;
        added = false;
      }
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

    const equity = state.equity;
    const spend = (frac: number): bigint => {
      const byFrac = (equity * BigInt(Math.round(frac * 10000))) / 10000n;
      const room = state.weightRoom(SYMBOL);
      let n = byFrac < state.cash ? byFrac : state.cash;
      if (room < n) n = room;
      return n;
    };
    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);

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
      // No exit: a mean-reversion position whose dislocation deepened far
      // past the first tranche takes its second tranche here.
      if (posKind === 'mr' && !added && dev <= ADD_DEV && barIndex >= cooldownUntil && !sliding(anchor)) {
        const n = spend(ADD_FRAC);
        if (n >= minNotional) {
          sentKind = 'mr';
          return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: n, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
      }
      return [];
    }

    // Flat: one entry may fire, mean reversion first.
    if (barIndex >= cooldownUntil && dev <= BUY_DEV && !sliding(anchor)) {
      const n = spend(FIRST_FRAC);
      if (n >= minNotional) {
        sentKind = 'mr';
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: n, max_slippage_bps: MAX_SLIPPAGE_BPS }];
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
