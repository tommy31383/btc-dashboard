# Task 3 - Binance Data Refresh and Provenance

## Status

Implemented within the assigned ownership boundary. The refresh module is public-data only and defaults to the repository `.cache` paths; tests inject temporary paths and a fake fetch implementation.

## RED Evidence

Command:

```sh
npx tsx --test tools/stochrsi-macro-cycle/io.test.ts
```

Observed result before `io.ts` existed: exit `1`, with `Error: Cannot find module './io'` from `tools/stochrsi-macro-cycle/io.test.ts`.

## GREEN Evidence

After implementing `tools/stochrsi-macro-cycle/io.ts`, the same focused command exited `0`:

```text
1..4
# tests 4
# pass 4
# fail 0
```

The focused tests use only fake HTTPS responses and temporary cache files. They cover completed-hour filtering, fresh-over-cached deduplication, gap reporting, nullable legacy funding marks, incremental public endpoint requests, bounded `429` retry, SHA-256 provenance, and malformed-response rejection.

## Verification

```sh
npx tsx --test tools/stochrsi-macro-cycle/*.test.ts
```

Exited `0`: `46` tests passed, `0` failed.

```sh
npx tsc --noEmit --pretty false --skipLibCheck --module nodenext --moduleResolution nodenext --target es2022 --esModuleInterop tools/stochrsi-macro-cycle/io.ts tools/stochrsi-macro-cycle/io.test.ts
git diff --check
```

Both commands exited `0` with no output.

## Self-Review

- Uses default Node `fetch` with the fixed public `https://fapi.binance.com` base URL and `AbortSignal.timeout`; it does not read credentials or alter TLS verification.
- Retries only `429` and `5xx` responses, with a bounded attempt count.
- Validates OHLCV and funding values before cache writes, filters the forming 1h candle, sorts/deduplicates with refreshed values winning, and writes each cache atomically.
- Keeps internal historical gaps intact and records every gap larger than three hours with `aggregate_available_hours` handling.
- Records cache paths, SHA-256 hashes, row counts/ranges, refresh time, evaluator version, and evaluator git SHA in provenance.

## Concerns

- This task deliberately did not perform a live Binance request. Endpoint behavior is covered through injected fixtures; Task 4's real replay should be the first controlled online refresh.
- Existing historical gaps remain a documented data-quality limitation. They are reported, not erased or filled.
