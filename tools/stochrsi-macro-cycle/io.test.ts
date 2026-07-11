import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HOUR_MS, type Candle } from "./core";
import {
  EVALUATOR_VERSION,
  defaultCachePaths,
  loadAndRefreshData,
  mergeCandles,
  sha256File,
  validateHourlyData,
} from "./io";

function bar(time: number, close: number): Candle {
  return { time, open: close - 1, high: close + 1, low: close - 2, close, volume: 10 };
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test("material audit fixes use evaluator version v2", () => {
  assert.equal(EVALUATOR_VERSION, "stochrsi-macro-cycle/v2");
});

test("default caches are explicitly Futures-specific", () => {
  const paths = defaultCachePaths();

  assert.match(paths.hourlyCachePath, /binance-futures-btcusdt-1h-7y\.json$/);
  assert.match(paths.fundingCachePath, /binance-futures-btcusdt-funding-7y\.json$/);
  assert.doesNotMatch(paths.hourlyCachePath, /binance-1h-7y\.json$/);
});

test("merge deduplicates and excludes the forming hour", () => {
  const now = Date.UTC(2026, 6, 11, 12);
  const merged = mergeCandles(
    [bar(now - 2 * HOUR_MS, 1)],
    [bar(now - 2 * HOUR_MS, 2), bar(now, 3)],
    now,
  );

  assert.deepEqual(merged.map((candle) => [candle.time, candle.close]), [[now - 2 * HOUR_MS, 2]]);
});

test("validation lists gaps over three hours with the documented handling", () => {
  const validation = validateHourlyData([bar(0, 1), bar(5 * HOUR_MS, 2)]);

  assert.deepEqual(validation.gaps, [
    {
      fromTime: 0,
      toTime: 5 * HOUR_MS,
      missingHours: 4,
      handling: "aggregate_available_hours",
    },
  ]);
});

test("normalizes a zero cached funding mark to missing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stochrsi-io-"));
  const hourlyCachePath = join(directory, "hourly.json");
  const fundingCachePath = join(directory, "funding.json");
  const now = Date.UTC(2026, 6, 11, 12);

  try {
    await writeFile(hourlyCachePath, JSON.stringify([bar(now - HOUR_MS, 100)]));
    await writeFile(
      fundingCachePath,
      JSON.stringify([{ time: now - 8 * HOUR_MS, rate: 0.001, mark: 0 }]),
    );

    const data = await loadAndRefreshData({
      refresh: false,
      nowMs: now,
      cachePaths: { hourlyCachePath, fundingCachePath },
      gitSha: "test-git-sha",
      gitDirty: false,
    });

    assert.equal(data.funding[0].mark, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("offline default pins as-of time to the cached completed-hour cutoff", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stochrsi-io-"));
  const hourlyCachePath = join(directory, "hourly.json");
  const fundingCachePath = join(directory, "funding.json");
  const futureHour = Date.UTC(2099, 0, 1);

  try {
    await writeFile(hourlyCachePath, JSON.stringify([bar(futureHour, 100)]));
    await writeFile(fundingCachePath, "[]");

    const data = await loadAndRefreshData({
      refresh: false,
      cachePaths: { hourlyCachePath, fundingCachePath },
      gitSha: "test-git-sha",
      gitDirty: false,
    });

    assert.equal(data.asOfMs, futureHour + HOUR_MS);
    assert.equal(data.hourly.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refreshes incrementally through fake Binance responses and writes reproducible provenance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stochrsi-io-"));
  const hourlyCachePath = join(directory, "hourly.json");
  const fundingCachePath = join(directory, "funding.json");
  const now = Date.UTC(2026, 6, 11, 12);
  const cachedHour = now - 2 * HOUR_MS;
  const cachedFunding = now - 16 * HOUR_MS;
  let klineAttempts = 0;
  const requested: string[] = [];

  try {
    await writeFile(hourlyCachePath, JSON.stringify([bar(cachedHour, 100)]));
    await writeFile(
      fundingCachePath,
      JSON.stringify([{ symbol: "BTCUSDT", time: cachedFunding, rate: "0.0001", mark: null }]),
    );

    const data = await loadAndRefreshData({
      nowMs: now,
      cachePaths: { hourlyCachePath, fundingCachePath },
      fetchImpl: async (url) => {
        requested.push(url);
        const parsed = new URL(url);
        if (parsed.pathname.endsWith("/klines")) {
          klineAttempts += 1;
          if (klineAttempts === 1) return jsonResponse({ code: -1003 }, 429);
          return jsonResponse([
            [now - HOUR_MS, "100", "103", "99", "102", "8"],
            [now, "102", "104", "101", "103", "9"],
          ]);
        }
        if (parsed.pathname.endsWith("/fundingRate")) {
          return jsonResponse([
            {
              symbol: "BTCUSDT",
              fundingTime: now - 8 * HOUR_MS,
              fundingRate: "-0.0002",
              markPrice: "101.5",
            },
          ]);
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
      retryDelayMs: 0,
      gitSha: "test-git-sha",
      gitDirty: false,
      evaluatorVersion: "test-evaluator-v1",
    } as Parameters<typeof loadAndRefreshData>[0]);

    assert.equal(klineAttempts, 2);
    assert.ok(requested.every((url) => url.startsWith("https://fapi.binance.com/")));
    assert.ok(requested.some((url) => new URL(url).searchParams.get("startTime") === String(cachedHour + HOUR_MS)));
    assert.equal(data.hourly.length, 2);
    assert.equal(data.hourly.at(-1)?.time, now - HOUR_MS);
    assert.deepEqual(data.funding.map((entry) => entry.mark), [null, 101.5]);
    assert.equal(data.provenance.gitSha, "test-git-sha");
    assert.equal(data.provenance.gitDirty, false);
    assert.equal(data.provenance.evaluatorVersion, "test-evaluator-v1");
    assert.equal(data.provenance.hourly.range.firstTime, cachedHour);
    assert.equal(data.provenance.hourly.range.lastTime, now - HOUR_MS);
    assert.match(data.provenance.hourly.sha256, /^[a-f0-9]{64}$/);
    assert.match(data.provenance.funding.sha256, /^[a-f0-9]{64}$/);
    assert.equal(data.provenance.gaps.length, 0);
    assert.equal(await sha256File(hourlyCachePath), data.provenance.hourly.sha256);

    const persistedHourly = JSON.parse(await readFile(hourlyCachePath, "utf8"));
    assert.equal(persistedHourly.length, 2);
    assert.equal(persistedHourly.at(-1).time, now - HOUR_MS);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects malformed official kline data before writing a cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stochrsi-io-"));
  const now = Date.UTC(2026, 6, 11, 12);

  try {
    await assert.rejects(
      loadAndRefreshData({
        nowMs: now,
        cachePaths: {
          hourlyCachePath: join(directory, "hourly.json"),
          fundingCachePath: join(directory, "funding.json"),
        },
        fetchImpl: async (url) =>
          url.includes("/klines")
            ? jsonResponse([[now - HOUR_MS, "not-a-number", "103", "99", "102", "8"]])
            : jsonResponse([]),
        retryDelayMs: 0,
        gitSha: "test-git-sha",
        gitDirty: false,
      } as Parameters<typeof loadAndRefreshData>[0]),
      /Invalid Binance kline/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("canonicalizes both caches before deriving refresh cursors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stochrsi-io-"));
  const hourlyCachePath = join(directory, "hourly.json");
  const fundingCachePath = join(directory, "funding.json");
  const now = Date.UTC(2026, 6, 11, 12);
  const latestHour = now - 2 * HOUR_MS;
  const latestFunding = now - 8 * HOUR_MS;
  const starts = new Map<string, number>();

  try {
    await writeFile(
      hourlyCachePath,
      JSON.stringify([bar(latestHour, 102), bar(now + HOUR_MS, 999), bar(now - 3 * HOUR_MS, 101), bar(latestHour, 103)]),
    );
    await writeFile(
      fundingCachePath,
      JSON.stringify([
        { time: latestFunding, rate: 0.0001, mark: null },
        { time: now + 1, rate: 0.5, mark: 100 },
        { time: latestFunding - 8 * HOUR_MS, rate: 0.0002, mark: null },
        { time: latestFunding, rate: 0.0003, mark: 101 },
      ]),
    );

    const data = await loadAndRefreshData({
      nowMs: now,
      cachePaths: { hourlyCachePath, fundingCachePath },
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        starts.set(parsed.pathname, Number(parsed.searchParams.get("startTime")));
        return jsonResponse([]);
      },
      retryDelayMs: 0,
      gitSha: "test-git-sha",
      gitDirty: false,
    } as Parameters<typeof loadAndRefreshData>[0]);

    assert.equal(starts.get("/fapi/v1/klines"), latestHour + HOUR_MS);
    assert.equal(starts.get("/fapi/v1/fundingRate"), latestFunding + 1);
    assert.deepEqual(data.hourly.map((entry) => [entry.time, entry.close]), [
      [now - 3 * HOUR_MS, 101],
      [latestHour, 103],
    ]);
    assert.deepEqual(data.funding.map((entry) => [entry.time, entry.rate]), [
      [latestFunding - 8 * HOUR_MS, 0.0002],
      [latestFunding, 0.0003],
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects kline pages that violate ordering, range, alignment, or endpoint limit", async (context) => {
  const now = Date.UTC(2026, 6, 11, 12);
  const cachedHour = now - 4 * HOUR_MS;
  const cursor = cachedHour + HOUR_MS;
  const cases: Array<[string, unknown[]]> = [
    ["out of order", [[cursor + HOUR_MS, "1", "2", "0", "1", "1"], [cursor, "1", "2", "0", "1", "1"]]],
    ["outside request range", [[cursor - HOUR_MS, "1", "2", "0", "1", "1"]]],
    ["not aligned", [[cursor + 1, "1", "2", "0", "1", "1"]]],
    ["over limit", Array.from({ length: 1_501 }, (_, index) => [cursor + index * HOUR_MS, "1", "2", "0", "1", "1"])],
  ];

  for (const [name, page] of cases) {
    await context.test(name, async () => {
      const directory = await mkdtemp(join(tmpdir(), "stochrsi-io-"));
      const hourlyCachePath = join(directory, "hourly.json");
      const fundingCachePath = join(directory, "funding.json");
      try {
        await writeFile(hourlyCachePath, JSON.stringify([bar(cachedHour, 100)]));
        await writeFile(fundingCachePath, "[]");
        await assert.rejects(
          loadAndRefreshData({
            nowMs: now,
            cachePaths: { hourlyCachePath, fundingCachePath },
            fetchImpl: async (url) => url.includes("/klines") ? jsonResponse(page) : jsonResponse([]),
            retryDelayMs: 0,
            gitSha: "test-git-sha",
            gitDirty: false,
          } as Parameters<typeof loadAndRefreshData>[0]),
          /Binance klines page|Invalid Binance kline/,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test("rejects funding pages that violate ordering, range, or endpoint limit", async (context) => {
  const now = Date.UTC(2026, 6, 11, 12);
  const cachedFunding = now - 32 * HOUR_MS;
  const cursor = cachedFunding + 1;
  const funding = (time: number) => ({ symbol: "BTCUSDT", fundingTime: time, fundingRate: "0.0001", markPrice: null });
  const cases: Array<[string, unknown[]]> = [
    ["out of order", [funding(cursor + 2), funding(cursor + 1)]],
    ["outside request range", [funding(cursor - 1)]],
    ["over limit", Array.from({ length: 1_001 }, (_, index) => funding(cursor + index))],
  ];

  for (const [name, page] of cases) {
    await context.test(name, async () => {
      const directory = await mkdtemp(join(tmpdir(), "stochrsi-io-"));
      const hourlyCachePath = join(directory, "hourly.json");
      const fundingCachePath = join(directory, "funding.json");
      try {
        await writeFile(hourlyCachePath, JSON.stringify([bar(now - HOUR_MS, 100)]));
        await writeFile(fundingCachePath, JSON.stringify([funding(cachedFunding)]));
        await assert.rejects(
          loadAndRefreshData({
            nowMs: now,
            cachePaths: { hourlyCachePath, fundingCachePath },
            fetchImpl: async (url) => url.includes("/fundingRate") ? jsonResponse(page) : jsonResponse([]),
            retryDelayMs: 0,
            gitSha: "test-git-sha",
            gitDirty: false,
          } as Parameters<typeof loadAndRefreshData>[0]),
          /Binance funding page/,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test("continues a full 1500-row kline page at last timestamp plus one hour and terminates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stochrsi-io-"));
  const now = Date.UTC(2026, 6, 11, 12);
  const hourlyCachePath = join(directory, "hourly.json");
  const fundingCachePath = join(directory, "funding.json");
  const start = Date.UTC(2019, 6, 11, 12);
  const page = Array.from({ length: 1_500 }, (_, index) => [start + index * HOUR_MS, "1", "2", "0", "1", "1"]);
  const cursors: number[] = [];

  try {
    await loadAndRefreshData({
      nowMs: now,
      cachePaths: { hourlyCachePath, fundingCachePath },
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname.endsWith("/fundingRate")) return jsonResponse([]);
        cursors.push(Number(parsed.searchParams.get("startTime")));
        return jsonResponse(cursors.length === 1 ? page : []);
      },
      retryDelayMs: 0,
      gitSha: "test-git-sha",
      gitDirty: false,
    } as Parameters<typeof loadAndRefreshData>[0]);

    assert.deepEqual(cursors, [start, start + 1_500 * HOUR_MS]);
    assert.equal(new Set(cursors).size, cursors.length);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("continues a full 1000-row funding page at last timestamp plus one millisecond", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stochrsi-io-"));
  const now = Date.UTC(2026, 6, 11, 12);
  const hourlyCachePath = join(directory, "hourly.json");
  const fundingCachePath = join(directory, "funding.json");
  const start = Date.UTC(2019, 6, 11, 12);
  const funding = (time: number) => ({ symbol: "BTCUSDT", fundingTime: time, fundingRate: "0.0001", markPrice: null });
  const firstPage = Array.from({ length: 1_000 }, (_, index) => funding(start + index * 8 * HOUR_MS));
  const lastTime = start + 999 * 8 * HOUR_MS;
  const cursors: number[] = [];

  try {
    await writeFile(hourlyCachePath, JSON.stringify([bar(now - HOUR_MS, 100)]));
    await loadAndRefreshData({
      nowMs: now,
      cachePaths: { hourlyCachePath, fundingCachePath },
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname.endsWith("/klines")) return jsonResponse([]);
        cursors.push(Number(parsed.searchParams.get("startTime")));
        return jsonResponse(cursors.length === 1 ? firstPage : [funding(lastTime + 1)]);
      },
      retryDelayMs: 0,
      gitSha: "test-git-sha",
      gitDirty: false,
    } as Parameters<typeof loadAndRefreshData>[0]);

    assert.deepEqual(cursors, [start, lastTime + 1]);
    assert.equal(new Set(cursors).size, cursors.length);
    const persisted = JSON.parse(await readFile(fundingCachePath, "utf8"));
    assert.equal(persisted.at(-1).time, lastTime + 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rolls back both cache files when committing the second staged update fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stochrsi-io-"));
  const hourlyCachePath = join(directory, "hourly.json");
  const fundingCachePath = join(directory, "funding.json");
  const now = Date.UTC(2026, 6, 11, 12);
  const originalHourly = JSON.stringify([bar(now - 2 * HOUR_MS, 100)]);
  const originalFunding = JSON.stringify([{ time: now - 16 * HOUR_MS, rate: 0.0001, mark: null }]);
  let injected = false;

  try {
    await writeFile(hourlyCachePath, originalHourly);
    await writeFile(fundingCachePath, originalFunding);

    await assert.rejects(
      loadAndRefreshData({
        nowMs: now,
        cachePaths: { hourlyCachePath, fundingCachePath },
        fetchImpl: async (url) => url.includes("/klines")
          ? jsonResponse([[now - HOUR_MS, "100", "102", "99", "101", "1"]])
          : jsonResponse([{ symbol: "BTCUSDT", fundingTime: now - 8 * HOUR_MS, fundingRate: "0.0002", markPrice: null }]),
        retryDelayMs: 0,
        gitSha: "test-git-sha",
        gitDirty: false,
        cacheRenameImpl: async (from: string, to: string) => {
          if (!injected && from.includes(".stage") && to === fundingCachePath) {
            injected = true;
            throw new Error("injected second cache commit failure");
          }
          await rename(from, to);
        },
      } as Parameters<typeof loadAndRefreshData>[0]),
      /injected second cache commit failure/,
    );

    assert.equal(await readFile(hourlyCachePath, "utf8"), originalHourly);
    assert.equal(await readFile(fundingCachePath, "utf8"), originalFunding);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("resolves git metadata before fetching or mutating caches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stochrsi-io-"));
  const hourlyCachePath = join(directory, "hourly.json");
  const fundingCachePath = join(directory, "funding.json");
  const now = Date.UTC(2026, 6, 11, 12);
  const originalHourly = JSON.stringify([bar(now - HOUR_MS, 100)]);
  const originalFunding = "[]";
  let fetchCalls = 0;

  try {
    await writeFile(hourlyCachePath, originalHourly);
    await writeFile(fundingCachePath, originalFunding);
    await assert.rejects(
      loadAndRefreshData({
        nowMs: now,
        cachePaths: { hourlyCachePath, fundingCachePath },
        fetchImpl: async () => {
          fetchCalls += 1;
          return jsonResponse([]);
        },
        retryDelayMs: 0,
        gitSha: "   ",
        gitDirty: false,
      } as Parameters<typeof loadAndRefreshData>[0]),
      /Unable to resolve evaluator git SHA/,
    );

    assert.equal(fetchCalls, 0);
    assert.equal(await readFile(hourlyCachePath, "utf8"), originalHourly);
    assert.equal(await readFile(fundingCachePath, "utf8"), originalFunding);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not retry a nonretryable 400 response", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stochrsi-io-"));
  let klineAttempts = 0;
  try {
    await assert.rejects(
      loadAndRefreshData({
        nowMs: Date.UTC(2026, 6, 11, 12),
        cachePaths: { hourlyCachePath: join(directory, "hourly.json"), fundingCachePath: join(directory, "funding.json") },
        fetchImpl: async (url) => {
          if (url.includes("/klines")) klineAttempts += 1;
          return url.includes("/klines") ? jsonResponse({}, 400) : jsonResponse([]);
        },
        retryAttempts: 5,
        retryDelayMs: 0,
        gitSha: "test-git-sha",
        gitDirty: false,
      } as Parameters<typeof loadAndRefreshData>[0]),
      /Binance 400/,
    );
    assert.equal(klineAttempts, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stops after five retryable failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stochrsi-io-"));
  let klineAttempts = 0;
  try {
    await assert.rejects(
      loadAndRefreshData({
        nowMs: Date.UTC(2026, 6, 11, 12),
        cachePaths: { hourlyCachePath: join(directory, "hourly.json"), fundingCachePath: join(directory, "funding.json") },
        fetchImpl: async (url) => {
          if (url.includes("/klines")) klineAttempts += 1;
          return url.includes("/klines") ? jsonResponse({}, 503) : jsonResponse([]);
        },
        retryAttempts: 5,
        retryDelayMs: 0,
        gitSha: "test-git-sha",
        gitDirty: false,
      } as Parameters<typeof loadAndRefreshData>[0]),
      /Binance 503/,
    );
    assert.equal(klineAttempts, 5);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("retries thrown TypeError and AbortError without real waits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stochrsi-io-"));
  const now = Date.UTC(2026, 6, 11, 12);
  let klineAttempts = 0;
  try {
    const data = await loadAndRefreshData({
      nowMs: now,
      cachePaths: { hourlyCachePath: join(directory, "hourly.json"), fundingCachePath: join(directory, "funding.json") },
      fetchImpl: async (url) => {
        if (url.includes("/fundingRate")) return jsonResponse([]);
        klineAttempts += 1;
        if (klineAttempts === 1) throw new TypeError("network failed");
        if (klineAttempts === 2) throw new DOMException("timed out", "AbortError");
        return jsonResponse([[now - HOUR_MS, "100", "102", "99", "101", "1"]]);
      },
      retryAttempts: 5,
      retryDelayMs: 0,
      gitSha: "test-git-sha",
      gitDirty: false,
    } as Parameters<typeof loadAndRefreshData>[0]);

    assert.equal(klineAttempts, 3);
    assert.equal(data.hourly.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("retries one Node TimeoutError and uses the subsequent successful response", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stochrsi-io-"));
  const now = Date.UTC(2026, 6, 11, 12);
  let klineAttempts = 0;
  try {
    const data = await loadAndRefreshData({
      nowMs: now,
      cachePaths: { hourlyCachePath: join(directory, "hourly.json"), fundingCachePath: join(directory, "funding.json") },
      fetchImpl: async (url) => {
        if (url.includes("/fundingRate")) return jsonResponse([]);
        klineAttempts += 1;
        if (klineAttempts === 1) throw new DOMException("timed out", "TimeoutError");
        return jsonResponse([[now - HOUR_MS, "100", "102", "99", "101", "1"]]);
      },
      retryAttempts: 5,
      retryDelayMs: 0,
      gitSha: "test-git-sha",
      gitDirty: false,
    } as Parameters<typeof loadAndRefreshData>[0]);

    assert.equal(klineAttempts, 2);
    assert.equal(data.hourly.length, 1);
    assert.equal(data.hourly[0].time, now - HOUR_MS);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bounds repeated Node TimeoutError failures at five attempts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stochrsi-io-"));
  let klineAttempts = 0;
  try {
    await assert.rejects(
      loadAndRefreshData({
        nowMs: Date.UTC(2026, 6, 11, 12),
        cachePaths: { hourlyCachePath: join(directory, "hourly.json"), fundingCachePath: join(directory, "funding.json") },
        fetchImpl: async (url) => {
          if (url.includes("/klines")) klineAttempts += 1;
          if (url.includes("/klines")) throw new DOMException("timed out", "TimeoutError");
          return jsonResponse([]);
        },
        retryAttempts: 5,
        retryDelayMs: 0,
        gitSha: "test-git-sha",
        gitDirty: false,
      } as Parameters<typeof loadAndRefreshData>[0]),
      /timed out/,
    );
    assert.equal(klineAttempts, 5);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects retry attempt counts above the hard maximum of five", async () => {
  await assert.rejects(
    loadAndRefreshData({ retryAttempts: 6, gitSha: "test-git-sha", gitDirty: false } as Parameters<typeof loadAndRefreshData>[0]),
    /retry attempts/,
  );
});

test("bootstraps at the exact UTC hour seven calendar years earlier across leap years", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stochrsi-io-"));
  const now = Date.UTC(2024, 2, 1, 12, 34, 56, 789);
  const expectedStart = Date.UTC(2017, 2, 1, 12);
  const starts = new Map<string, number>();
  try {
    await loadAndRefreshData({
      nowMs: now,
      cachePaths: { hourlyCachePath: join(directory, "hourly.json"), fundingCachePath: join(directory, "funding.json") },
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        starts.set(parsed.pathname, Number(parsed.searchParams.get("startTime")));
        return parsed.pathname.endsWith("/klines")
          ? jsonResponse([[expectedStart, "100", "102", "99", "101", "1"]])
          : jsonResponse([]);
      },
      retryDelayMs: 0,
      gitSha: "test-git-sha",
      gitDirty: false,
    } as Parameters<typeof loadAndRefreshData>[0]);

    assert.equal(starts.get("/fapi/v1/klines"), expectedStart);
    assert.equal(starts.get("/fapi/v1/fundingRate"), expectedStart);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
