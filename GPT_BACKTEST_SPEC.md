# Backtest Spec

Date: 2026-04-24

Scope: common rules for GPT/backtest scripts in this repo so results are comparable across runs and machines.

## Core Principle

Every backtest must declare:

- date range
- symbol
- timeframe used for entry
- higher timeframe data used for filters
- entry price convention
- fee model
- overlap policy
- TP / SL / max hold policy
- how open candles are handled

If a script does not state these, its result is not considered production-grade.

## Default Market Data Rules

- Exchange: Binance spot REST `/api/v3/klines`
- Symbol: `BTCUSDT`
- Candle source: closed historical candles only
- Timezone: UTC timestamps from Binance, no local-time reinterpretation
- Higher timeframe alignment: always use the last closed HTF candle whose `openTime <= entry candle time`

## Entry Convention

Default:

- Signal is evaluated on the current closed candle
- Entry happens at that candle's `close`

Do not mix:

- `open` entry in one script
- `close` entry in another script

unless the script explicitly says so.

## Exit Convention

Default order:

1. Check stop-loss hit
2. Check take-profit hit
3. If neither hit before `maxHoldBars`, exit at close of final hold candle

This means the engine is pessimistic on ambiguous candles that could have touched both TP and SL.

## Fee Convention

Default GPT rule fee:

- `0.05%` per side
- total round-trip fee = `0.10%`

Older research scripts may use `0.04%` per side. Those results should be labeled clearly and not mixed silently with `0.05%` runs.

## Position Overlap

Default:

- one position at a time

When a trade opens, the engine skips forward until that trade closes.

If a script allows overlapping trades, it must say so explicitly in its assumptions.

## Timeout Convention

If TP/SL is not hit within `maxHoldBars`:

- exit at close of the last allowed candle
- classify as `TIMEOUT`
- still include fee in net result

## Support / Resistance Convention

When a rule references support or resistance:

- support = minimum low over the specified lookback window on the declared timeframe
- resistance = maximum high over the specified lookback window on the declared timeframe

"Near support" or "near resistance" must always be defined numerically, for example:

- `max(0.2%, 0.35 * ATR15m)`

Natural-language words like "near", "touch", "deep", or "strong" are not enough by themselves.

## Indicator Convention

Indicators must be computed from the same candle set used by the script and only from candles available up to the decision point.

Examples:

- Stoch/RSI/MACD at candle `i` must not peek at candle `i+1`
- HTF trend must use the last closed HTF candle, not the forming one

## Rule Template

Every GPT rule backtest should document:

```md
Rule:
- side
- entry timeframe
- context timeframe(s)
- trigger condition(s)

Assumptions:
- date range
- fee per side
- entry at close/open
- one-position-at-a-time or overlap
- TP / SL / maxHold
- support/resistance definition
- indicator thresholds
```

## Current Default Templates In This Repo

### Template A: feature-scan rules

Used by:

- `tools/scan-features.ts`
- `tools/backtest-1h-highwr-rules.ts`
- `tools/backtest-1h-selected-rules-3y.ts`
- `tools/optimize-selected-1h-rules.ts`

Rules:

- each closed candle is a candidate sample
- if feature combo matches, assume entry at candle close
- fixed TP/SL unless optimization script says otherwise

### Template B: stoch + support rules

Used by:

- `tools/backtest-gpt-rule-15m-stoch-support.ts`
- `tools/optimize-gpt-rule-15m-stoch-support.ts`
- `tools/compare-gpt-rule-15m-stoch-support-tp.ts`

Rules:

- entry on `15m` close
- `1h` support/resistance from rolling lookback
- optional early exit via Stoch threshold
- one position at a time

### Template C: context/adaptive rules

Used by:

- `tools/backtest-gpt-rule-15m-1h-up-adaptive.ts`
- `tools/optimize-gpt-rule-15m-1h-up.ts`

Rules:

- context from higher timeframe trend
- trigger from lower timeframe bars
- adaptive SL/TP by context

## Why Results Can Differ Between Backtests

If two people backtest "the same rule" but get different results, the usual causes are:

- different fee
- entry at `open` vs `close`
- different TP/SL priority on the same candle
- different max hold
- different overlap policy
- different HTF alignment
- using open candles vs closed candles
- different support/resistance definitions
- different date range

## Promotion Rule

A rule should not be promoted into `hard_rules` unless:

- assumptions are fully written down
- results are reproducible
- sample size is acceptable
- retest period is long enough for the intended use
- the rule still makes structural sense, not just statistical sense
