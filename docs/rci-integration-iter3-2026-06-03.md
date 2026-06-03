# RCI Integration — Iteration 3 (2026-06-03)

**Verdict: BLOCKED — all iter3 tasks rest on a false data premise. No deploy. v0.4.76 remains validated only on 3y (unchanged from iter2).**

Goal was to validate the v0.4.76 funding-skip-entry deploy on full 7y (incl. 2021 blowoff)
using OI / Long-Short / taker-ratio as a 7y-available proxy for funding-crowding, and to
test LS-ratio and taker-ratio as standalone filters on 7y.

---

## The blocker — the "7y" sentiment files are 13 days, not 7 years

> **Update (follow-up):** the five misnamed files below have since been renamed from the
> `-7y` suffix to `-recent` (e.g. `binance-oi-1h-7y.json` → `binance-oi-1h-recent.json`) and
> the code references in `tools/backtest-7-directions-7y.ts` updated accordingly. The table
> below keeps the original `-7y` names as they were at the time of this analysis.

First action was to inspect the JSON (as instructed). Date spans:

| File | Records | Span | Coverage |
|---|---|---|---|
| `binance-oi-1h-7y.json` | 320 | 2026-05-11 → 2026-05-25 | **13 days** |
| `binance-globalLS-1h-7y.json` | 320 | 2026-05-11 → 2026-05-25 | **13 days** |
| `binance-takerRatio-1h-7y.json` | 320 | 2026-05-11 → 2026-05-25 | **13 days** |
| `binance-topLSAccount-1h-7y.json` | 320 | 2026-05-11 → 2026-05-25 | **13 days** |
| `binance-topLSPosition-1h-7y.json` | 320 | 2026-05-11 → 2026-05-25 | **13 days** |
| `binance-funding-3y.json` | 3285 | 2023-05-25 → 2026-05-24 | 3 years |
| `binance-5m-7y.json` | 778,970 | 2019-01-01 → 2026-05-31 | 7 years (price only) |

The `-7y` suffix is a **misnomer**. Binance's futures-data endpoints
(`futures/data/openInterestHist`, `globalLongShortAccountRatio`, `takerlongshortRatio`,
`topLongShortAccountRatio`, `topLongShortPositionRatio`) only serve roughly the **last
30 days** of history (and 320 × 1h ≈ 13 days is what was actually fetched). They
**cannot be backfilled** to 2021 — Binance does not expose that history through any public
endpoint. The data needed for the whole iter3 plan does not exist and cannot be obtained.

This is the same class of limitation flagged in iter2 (funding only 3y, no 2021), only worse:
the proposed proxies have *less* history than funding, not more.

---

## Task 1 — funding ↔ OI/LS proxy correlation (7y validation of v0.4.76)

**Cannot be done.**

- Funding history: 2023-05 → 2026-05.
- OI/LS history: 2026-05-11 → 2026-05-25.
- **Overlap = 13 days** (only 38 funding settlements fall inside the LS window).
- **Overlap before 2026 = zero.** There is no shared history with 2021/2022, so even a
  perfect funding↔OI correlation on 13 days could not be projected back to the 2021 blowoff.

A 13-day, ~13-point correlation is statistically meaningless and would be dishonest to
report as a finding. Worse, the funding in that exact window was near-zero/negative
(rate range −0.0042% to +0.0090% per 8h) — there isn't a single crowding *extreme*
(>0.05%) in the overlap to correlate against. The proxy idea is untestable, not just weak.

**Consequence: v0.4.76 (funding-block at 0.05%) is still validated only on 3y / n=3 skips.
The 2021-blowoff robustness question that iter3 was meant to answer remains OPEN.** No new
evidence either way. v0.4.76 should be regarded as "works on the 3y sample, untested on 2021."

---

## Task 2 — extreme Long/Short ratio as standalone reversal filter

**Cannot be done (no 7y data), and the proposed thresholds are mis-specified.**

Even setting history aside, the spec's thresholds (sweep 2.5 / 3.0 / 3.5, "3.0 = 75% long")
do not match the field. In `binance-globalLS-1h-7y.json` the `ratio` field is
`longAcc / shortAcc`, where longAcc + shortAcc = 1. Observed over the 13 days:

- `ratio` range: **0.604 → 1.636**, mean 1.16.
- Count of `ratio > 2.5`: **0** (would never fire).
- Count of `ratio > 1.5`: 24 / 320 hours.

A "75% accounts long" reading is `longAcc 0.75 / shortAcc 0.25 = ratio 3.0` in this
schema, but the data never gets remotely close even in this recent window. The 2.5/3.0/3.5
sweep would produce zero trades. A correctly-scaled threshold (e.g. ratio > 1.4–1.6) is
plausible in principle but **cannot be backtested on 7y** — only 13 days exist, far too
little for a 7y / ≥5-of-8-years stability judgment. REJECT (untestable).

## Task 3 — taker buy/sell ratio exhaustion filter

**Cannot be done.** Same 13-day limitation. `takerRatio.ratio` (buyVol/sellVol) ranges
0.503 → 1.890, mean 1.026 over the window — but with only 13 days there is no way to run a
7y backtest or assess per-year stability. REJECT (untestable).

---

## Deploy recommendation

- **No deploy from iter3.** Nothing was testable.
- **v0.4.76 stays as-is** (funding-block 0.05%), still carrying its iter2 caveat: validated
  on 3y only (n=3 skips), **2021 blowoff untested**. Iter3 did not change that risk profile.
- **Do not** add LS-ratio or taker-ratio filters — they are unvalidated on history and the
  only available data is 13 recent days.

## What would actually unblock this

The proxy/crowding research needs a long history of crowding data that Binance simply does
not serve. Options, in rough order of effort:

1. **Forward-collect** OI / LS / taker hourly into a growing append-only log (like the
   altdata logger deployed in v0.4.50) and revisit in 6–12 months. This is the only path
   to a *clean* dataset, but gives no 2021 coverage ever.
2. **Stop chasing 2021 crowding via proxies.** It is structurally unavailable. The honest
   position is that the funding filter is a 3y-validated, downside-free tweak and should be
   treated as such — not retro-fitted to 2021.
3. If a 2021 crowding view is genuinely required, it would need a paid/third-party
   historical futures-sentiment dataset, outside the current `.cache` tooling.

**Recommendation: option 2.** Per the standing lessons (filter-overfit risk, judge on a
real harness, n<20/yr red flag), do not manufacture an edge from 13 days of data. Close the
RCI/crowding line of inquiry here unless/until a forward-collected log accumulates.

---

## Honesty note

No backtest was run in iter3 because running one on 13 days of data and presenting it as a
"7y validation" would be misleading. The single most valuable deliverable iter3 could
produce was the correct diagnosis that the input data does not exist — which prevents a
future iteration from repeating the same dead-end.
