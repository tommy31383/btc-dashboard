import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HOUR_MS, type Candle } from "./core";
import {
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
      evaluatorVersion: "test-evaluator-v1",
    });

    assert.equal(klineAttempts, 2);
    assert.ok(requested.every((url) => url.startsWith("https://fapi.binance.com/")));
    assert.ok(requested.some((url) => new URL(url).searchParams.get("startTime") === String(cachedHour + HOUR_MS)));
    assert.equal(data.hourly.length, 2);
    assert.equal(data.hourly.at(-1)?.time, now - HOUR_MS);
    assert.deepEqual(data.funding.map((entry) => entry.mark), [null, 101.5]);
    assert.equal(data.provenance.gitSha, "test-git-sha");
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
      }),
      /Invalid Binance kline/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
