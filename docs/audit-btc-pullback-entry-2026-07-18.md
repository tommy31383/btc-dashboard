# BTC Pullback Entry Research — 2026-07-18

## Status

Research-only. No live rule, server, order, arming, or deployment change.

The question is whether a long entry can be moved into a BTC pullback while
the completed 1W/2W context remains bullish, instead of waiting for a late
lower-timeframe confirmation.

## Replay contract

- Symbol: BTCUSDT only.
- Data: 1H candles, aggregated to completed 4H, 1D, 1W and 2W bars.
- Signal decision: only bars whose close is complete; HTF points are used only
  when their `closeTime` is at or before the signal bar close.
- Fill: next 1H candle open.
- Position model: long-only, one position at a time, one entry per episode;
  no forced daily entry.
- Exit default: `2 ATR` stop, `4 ATR` target, maximum `48` 1H bars.
- Intrabar convention: gap-aware fill; if SL and TP are both touched in one
  candle, SL is resolved first.
- Cost: `0.04%` fee plus `0.02%` slippage per side, using the existing exact-fill
  settlement helper.
- Metric `netR` is the sum of normalized per-trade returns from this replay;
  it is not a promise about account-level risk sizing.

## Candidate definitions

| Mode | Pullback / trigger |
|---|---|
| `EMA20_RECLAIM` | 4H low/high touches EMA20, then 1H close reclaims the zone |
| `EMA50_RECLAIM` | Same with 4H EMA50 |
| `PULLBACK_FIRST_TOUCH` | Enter at the first 1H bar after a completed 4H touch |
| `K10_1D_RECOVER` / `K20_1D_RECOVER` | 1D StochRSI K enters below 10/20, then turns up |
| `K10_4H_RECOVER` / `K20_4H_RECOVER` | 4H StochRSI K enters below 10/20, then turns up |
| `HL_RECLAIM` | 4H higher-low structure followed by reclaim of the prior high |

All modes require the same macro context: completed weekly close above rising
weekly EMA20, completed 2W K>D, and non-declining 2W close.

## Baseline results

### Futures, full cache

| Mode | Trades | WR | PF | Net | Without best | Max DD |
|---|---:|---:|---:|---:|---:|---:|
| EMA20 reclaim | 135 | 42.2% | 1.01 | +0.010 | -0.042 | 0.164 |
| EMA50 reclaim | 84 | 36.9% | 0.82 | -0.151 | -0.241 | 0.214 |
| First touch | 306 | 35.9% | 0.88 | -0.378 | -0.475 | 0.664 |
| K10 1D recovery | 12 | 41.7% | 1.53 | +0.050 | +0.010 | 0.069 |
| K20 1D recovery | 24 | 45.8% | 1.55 | +0.099 | +0.059 | 0.091 |
| K10 4H recovery | 75 | 38.7% | 1.01 | +0.011 | -0.040 | 0.188 |
| K20 4H recovery | 112 | 33.9% | 0.84 | -0.196 | -0.268 | 0.487 |
| HL reclaim | 267 | 39.0% | 1.04 | +0.090 | +0.021 | 0.371 |

### Spot, full cache

| Mode | Trades | WR | PF | Net | Without best | Max DD |
|---|---:|---:|---:|---:|---:|---:|
| EMA20 reclaim | 186 | 44.1% | 1.04 | +0.070 | +0.018 | 0.255 |
| EMA50 reclaim | 101 | 43.6% | 1.21 | +0.203 | +0.113 | 0.171 |
| First touch | 411 | 38.2% | 0.94 | -0.257 | -0.362 | 0.626 |
| K10 1D recovery | 17 | 47.1% | 1.34 | +0.041 | +0.002 | 0.075 |
| K20 1D recovery | 36 | 47.2% | 1.49 | +0.141 | +0.099 | 0.075 |
| K10 4H recovery | 104 | 50.0% | 1.72 | +0.690 | +0.580 | 0.203 |
| K20 4H recovery | 154 | 40.9% | 1.23 | +0.350 | +0.240 | 0.553 |
| HL reclaim | 402 | 42.5% | 1.23 | +0.910 | +0.831 | 0.266 |

## IS/OOS gate

Split: IS through `2022-12-31`, OOS from `2023-01-01`.

- Futures OOS: K10 1D recovery `n=7`, PF `0.90`; K10 4H recovery `n=54`,
  PF `0.96`; HL reclaim `n=190`, PF `0.97`.
- Spot OOS: K10 1D recovery `n=7`, PF `0.96`; K10 4H recovery `n=53`,
  PF `1.00`; HL reclaim `n=200`, PF `0.98`.
- Spot K10 4H with wider `3ATR/6ATR/72h` exits: OOS `n=50`, PF `1.09`,
  net `+0.048`, without-best `-0.025`.

The positive full-period results are therefore not a live-ready edge. The
recent OOS is approximately breakeven and the wider-exit variant is carried by
concentration that fails the drop-top-winner check.

## Current conclusion

1. `PULLBACK_FIRST_TOUCH` is rejected: it enters earlier, but the cost of
   avoiding confirmation is negative on both futures and spot full samples and
   worse in OOS.
2. EMA reclaim is not a robust improvement: EMA20 is near breakeven and EMA50
   is asset/regime dependent.
3. StochRSI recovery is a useful research lead, not a production rule. 1D
   recovery has too few trades; 4H recovery has better spot history but is
   approximately breakeven in recent OOS after macro re-check correction.
4. `HL_RECLAIM` has the largest full-sample spot result, but is near/below PF 1
   in both recent OOS datasets. It is rejected for live promotion.
5. Claude found and Codex fixed a MEDIUM issue: StochRSI recovery now re-checks
   macro bullishness at fire time, matching EMA behavior. The regression test
   covers the rejected trigger when macro is false.
6. No candidate passes the project money-path gate. The Claude audit remains
   `CONDITIONAL`, not an authorization to deploy.

## Reproduction

```sh
cd /Users/lap16116/BTC_PC/btc-dashboard
npx --yes tsx@4.23.1 tools/backtest-pullback-entry-research-7y.ts
PULLBACK_DATA=.cache/binance-spot-btcusdt-1h-full.json npx --yes tsx@4.23.1 tools/backtest-pullback-entry-research-7y.ts
PULLBACK_DATA=.cache/binance-spot-btcusdt-1h-full.json PULLBACK_MODE=K10_4H_RECOVER PULLBACK_START=2023-01-01T00:00:00Z PULLBACK_STOP_ATR=3 PULLBACK_TARGET_ATR=6 PULLBACK_MAX_HOLD=72 npx --yes tsx@4.23.1 tools/backtest-pullback-entry-research-7y.ts
```

## Provenance

- Futures cache SHA-256: `f738aefc1304fda8bb871cb919fc00b8c2b98ac0be23cb05e94c22158bd000a7`
- Spot cache SHA-256: `4fcd971d0c665ba4f93783984f6d7e6e1fbd99f074067d9808cf388f65a87de1`
- Replay SHA-256: `91e730d5571ff8f5d4fcfd5fe499a5ff999af8ad4c571a540efc9a9b77607870`
- Helper SHA-256: `8b56eb604d9373178ff8cd9c77bd7c45a0171912329a778a9dbf7168d595dbe3`
- Existing fill helper SHA-256: `9c8d9abdaf851297b609a6acfb4fbb34c0a1933bc3a21c905c629f16b698f764`
- Research test SHA-256: `3aae629137072cf500fadc8d044b8db6265e8aa35bc471b3ee082d7727d5f3f5`
- Data last candle: `2026-07-11T16:00:00Z`; replay as-of: `2026-07-11T17:00:00Z`.

## Audit state

Claude packet `MSG-090` was submitted through `AI_RELAY.md` at
`2026-07-18T08:57:51+07:00`. Claude returned `CONDITIONAL` at 09:03:37:
no-lookahead and exact-fill passed; OOS durability failed; G1/G2/G3 remain
unrun. Codex fixed the macro re-check finding and reran the focused test,
typecheck, full futures baseline, and key OOS commands. The scheduled heartbeat
completed at `2026-07-18T10:00:43+07:00` after 30 iterations. The report is
closed as research-only; G1/G2/G3 remain future gates only if Tommy explicitly
reopens this line.
