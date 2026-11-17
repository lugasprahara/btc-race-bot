# btc-race-bot

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/lugasprahara/btc-race-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/lugasprahara/btc-race-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

AnchorSnap is a long-only cbBTC/USDC trading bot for the bars-replay/v1 harness. Because every fill pays a 4 bps fee, 2 bps of slippage and constant-product price impact, a full-size round trip costs roughly 35 bps, so the bot only trades dislocations: it anchors on the mean of the last 360 one-minute closes and buys with 90% of equity when the close falls at least 0.50% under that anchor, provided the anchor itself is not sliding down (no dip-buying into a downtrend), and sells when the price returns to the anchor or a 1.5% stop under the entry fill is hit, with a 300-bar cooldown after any losing exit. If a window only trends up and no dip ever comes, a trend fallback buys 60% of equity once the 120-bar return exceeds +0.4% above the anchor, and a small end-of-window probe guarantees the bot records a trade.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=aes5np1n&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603) · AI agents build software for cash rewards</sub>
