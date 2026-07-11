import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { HOUR_MS, type Candle } from "./core";

const FUTURES_REST = "https://fapi.binance.com";
const SYMBOL = "BTCUSDT";
const KLINE_LIMIT = 1_500;
const FUNDING_LIMIT = 1_000;
const DEFAULT_RETRY_ATTEMPTS = 3;
const MAX_RETRY_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 30_000;

export const EVALUATOR_VERSION = "stochrsi-macro-cycle/v1";

export interface FundingRecord {
  time: number;
  rate: number;
  mark: number | null;
}

export interface DataGap {
  fromTime: number;
  toTime: number;
  missingHours: number;
  handling: "aggregate_available_hours";
}

export interface DataRange {
  firstTime: number | null;
  lastTime: number | null;
  rowCount: number;
}

export interface CachePaths {
  hourlyCachePath: string;
  fundingCachePath: string;
}

export interface FileProvenance {
  path: string;
  sha256: string;
  range: DataRange;
}

export interface Provenance {
  source: typeof FUTURES_REST;
  symbol: typeof SYMBOL;
  interval: "1h";
  refreshedAt: string;
  asOfMs: number;
  gitSha: string;
  gitDirty: boolean;
  evaluatorVersion: string;
  hourly: FileProvenance;
  funding: FileProvenance;
  gaps: DataGap[];
}

export interface RefreshResult {
  hourly: Candle[];
  funding: FundingRecord[];
  asOfMs: number;
  provenance: Provenance;
}

export interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<FetchResponse>;
export type RenameLike = (from: string, to: string) => Promise<void>;

export interface LoadAndRefreshDataOptions {
  refresh?: boolean;
  nowMs?: number;
  cachePaths?: Partial<CachePaths>;
  fetchImpl?: FetchLike;
  retryAttempts?: number;
  retryDelayMs?: number;
  gitSha?: string;
  gitDirty?: boolean;
  evaluatorVersion?: string;
  cacheRenameImpl?: RenameLike;
}

function defaultCachePaths(): CachePaths {
  return {
    hourlyCachePath: join(process.cwd(), ".cache", "binance-1h-7y.json"),
    fundingCachePath: join(process.cwd(), ".cache", "binance-funding-7y.json"),
  };
}

function finiteNumber(value: unknown, label: string): number {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(number)) throw new Error(`Invalid ${label}: ${String(value)}`);
  return number;
}

function timestamp(value: unknown, label: string): number {
  const time = finiteNumber(value, label);
  if (!Number.isSafeInteger(time) || time < 0) throw new Error(`Invalid ${label}: ${String(value)}`);
  return time;
}

function parseCandle(value: unknown, label: string): Candle {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  const record = value as Record<string, unknown>;
  const candle: Candle = {
    time: timestamp(record.time, `${label}.time`),
    open: finiteNumber(record.open, `${label}.open`),
    high: finiteNumber(record.high, `${label}.high`),
    low: finiteNumber(record.low, `${label}.low`),
    close: finiteNumber(record.close, `${label}.close`),
    volume: finiteNumber(record.volume, `${label}.volume`),
  };
  validateCandle(candle, label);
  return candle;
}

function validateCandle(candle: Candle, label: string): void {
  if (candle.time % HOUR_MS !== 0) throw new Error(`Invalid ${label}.time: not aligned to 1h`);
  if (candle.volume < 0) throw new Error(`Invalid ${label}.volume: negative`);
  if (candle.low > candle.high) throw new Error(`Invalid ${label}: low exceeds high`);
  if (candle.open < candle.low || candle.open > candle.high) throw new Error(`Invalid ${label}: open outside range`);
  if (candle.close < candle.low || candle.close > candle.high) throw new Error(`Invalid ${label}: close outside range`);
}

function parseKline(value: unknown): Candle {
  if (!Array.isArray(value) || value.length < 6) throw new Error("Invalid Binance kline: expected six fields");
  try {
    const candle: Candle = {
      time: timestamp(value[0], "Binance kline time"),
      open: finiteNumber(value[1], "Binance kline open"),
      high: finiteNumber(value[2], "Binance kline high"),
      low: finiteNumber(value[3], "Binance kline low"),
      close: finiteNumber(value[4], "Binance kline close"),
      volume: finiteNumber(value[5], "Binance kline volume"),
    };
    validateCandle(candle, "Binance kline");
    return candle;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid Binance kline: ${message}`);
  }
}

function parseKlines(value: unknown): Candle[] {
  if (!Array.isArray(value)) throw new Error("Invalid Binance klines response: expected an array");
  return value.map(parseKline);
}

function parseCachedCandles(value: unknown): Candle[] {
  if (!Array.isArray(value)) throw new Error("Invalid cached hourly candles: expected an array");
  return value.map((entry) => parseCandle(entry, "cached candle"));
}

function parseFunding(value: unknown, label: string, requireSymbol: boolean): FundingRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  const record = value as Record<string, unknown>;
  if (requireSymbol && record.symbol !== SYMBOL) throw new Error(`Invalid ${label}.symbol: ${String(record.symbol)}`);
  const timeValue = record.time ?? record.fundingTime;
  const rateValue = record.rate ?? record.fundingRate;
  const markValue = record.mark ?? record.markPrice;
  const mark = markValue === null || markValue === undefined ? null : finiteNumber(markValue, `${label}.mark`);
  if (mark !== null && mark < 0) throw new Error(`Invalid ${label}.mark: negative`);
  return {
    time: timestamp(timeValue, `${label}.time`),
    rate: finiteNumber(rateValue, `${label}.rate`),
    mark,
  };
}

function parseFundings(value: unknown, label: string, requireSymbol: boolean): FundingRecord[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}: expected an array`);
  return value.map((entry) => parseFunding(entry, label, requireSymbol));
}

function sortAndDedupeFunding(existing: FundingRecord[], incoming: FundingRecord[], nowMs: number): FundingRecord[] {
  const byTime = new Map<number, FundingRecord>();
  for (const entry of existing) if (entry.time <= nowMs) byTime.set(entry.time, entry);
  for (const entry of incoming) if (entry.time <= nowMs) byTime.set(entry.time, entry);
  return [...byTime.values()].sort((left, right) => left.time - right.time);
}

function validateFundingData(funding: FundingRecord[]): void {
  for (let index = 0; index < funding.length; index += 1) {
    const entry = funding[index];
    if (!Number.isSafeInteger(entry.time) || entry.time < 0) throw new Error(`Invalid funding time: ${entry.time}`);
    if (!Number.isFinite(entry.rate)) throw new Error(`Invalid funding rate: ${entry.rate}`);
    if (entry.mark !== null && (!Number.isFinite(entry.mark) || entry.mark < 0)) {
      throw new Error(`Invalid funding mark: ${entry.mark}`);
    }
    if (index > 0 && entry.time <= funding[index - 1].time) {
      throw new Error(`Funding records are not strictly sorted at ${entry.time}`);
    }
  }
}

export function mergeCandles(existing: Candle[], incoming: Candle[], nowMs: number): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const candle of existing) {
    validateCandle(candle, "cached candle");
    if (candle.time + HOUR_MS <= nowMs) byTime.set(candle.time, candle);
  }
  for (const candle of incoming) {
    validateCandle(candle, "refreshed candle");
    if (candle.time + HOUR_MS <= nowMs) byTime.set(candle.time, candle);
  }
  return [...byTime.values()].sort((left, right) => left.time - right.time);
}

export function validateHourlyData(hourly: Candle[]): { gaps: DataGap[] } {
  const gaps: DataGap[] = [];
  for (let index = 0; index < hourly.length; index += 1) {
    validateCandle(hourly[index], "hourly candle");
    if (index === 0) continue;
    const previous = hourly[index - 1];
    const current = hourly[index];
    if (current.time <= previous.time) throw new Error(`Hourly candles are not strictly sorted at ${current.time}`);
    const missingHours = (current.time - previous.time) / HOUR_MS - 1;
    if (!Number.isInteger(missingHours)) throw new Error(`Hourly candle spacing is invalid at ${current.time}`);
    if (missingHours > 3) {
      gaps.push({
        fromTime: previous.time,
        toTime: current.time,
        missingHours,
        handling: "aggregate_available_hours",
      });
    }
  }
  return { gaps };
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function temporarySibling(path: string, kind: "stage" | "backup"): string {
  return `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.${kind}`;
}

function isFileNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

async function stageAndCommitCachePair(
  cachePaths: CachePaths,
  hourly: Candle[],
  funding: FundingRecord[],
  renameImpl: RenameLike,
): Promise<void> {
  // Rollback covers caught rename failures, but two paths cannot be crash-atomic
  // without a manifest/pointer. An interrupted run must recover via online refresh.
  validateHourlyData(hourly);
  validateFundingData(funding);

  const destinations = [cachePaths.hourlyCachePath, cachePaths.fundingCachePath];
  const stages = destinations.map((path) => temporarySibling(path, "stage"));
  const backups = destinations.map((path) => temporarySibling(path, "backup"));
  await Promise.all(destinations.map((path) => mkdir(dirname(path), { recursive: true })));

  try {
    const stageWrites = await Promise.allSettled([
      writeFile(stages[0], JSON.stringify(hourly)),
      writeFile(stages[1], JSON.stringify(funding)),
    ]);
    const failedStageWrite = stageWrites.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failedStageWrite) throw failedStageWrite.reason;

    const [stagedHourlyRaw, stagedFundingRaw] = await Promise.all([readJson(stages[0]), readJson(stages[1])]);
    const stagedHourly = parseCachedCandles(stagedHourlyRaw);
    const stagedFunding = parseFundings(stagedFundingRaw, "staged funding", false);
    validateHourlyData(stagedHourly);
    validateFundingData(stagedFunding);
  } catch (error) {
    await Promise.all(stages.map((path) => rm(path, { force: true })));
    throw error;
  }

  const backupChecked = [false, false];
  const hadOriginal = [false, false];
  try {
    for (let index = 0; index < destinations.length; index += 1) {
      try {
        await renameImpl(destinations[index], backups[index]);
        hadOriginal[index] = true;
      } catch (error) {
        if (!isFileNotFound(error)) throw error;
      }
      backupChecked[index] = true;
    }

    await renameImpl(stages[0], destinations[0]);
    await renameImpl(stages[1], destinations[1]);
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (let index = destinations.length - 1; index >= 0; index -= 1) {
      if (!backupChecked[index]) continue;
      try {
        await rm(destinations[index], { force: true });
        if (hadOriginal[index]) await renameImpl(backups[index], destinations[index]);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    await Promise.all(stages.map((path) => rm(path, { force: true })));
    if (rollbackErrors.length > 0) throw new AggregateError([error, ...rollbackErrors], "Cache pair commit and rollback failed");
    throw error;
  }

  await Promise.all(backups.map((path) => rm(path, { force: true })));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchJson(
  path: string,
  fetchImpl: FetchLike,
  retryAttempts: number,
  retryDelayMs: number,
): Promise<unknown> {
  for (let attempt = 1; attempt <= retryAttempts; attempt += 1) {
    let response: FetchResponse;
    try {
      response = await fetchImpl(`${FUTURES_REST}${path}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.ok) return await response.json();
    } catch (error) {
      const retryable = error instanceof TypeError || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"));
      if (!retryable || attempt === retryAttempts) throw error;
      await delay(retryDelayMs * attempt);
      continue;
    }
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === retryAttempts) throw new Error(`Binance ${response.status} ${path}`);
    await delay(retryDelayMs * attempt);
  }
  throw new Error(`Binance retry limit reached for ${path}`);
}

function validateOfficialPage<T extends { time: number }>(
  page: T[],
  label: "klines" | "funding",
  cursor: number,
  endTime: number,
  limit: number,
): void {
  if (page.length > limit) throw new Error(`Binance ${label} page exceeds endpoint limit ${limit}`);
  for (let index = 0; index < page.length; index += 1) {
    const time = page[index].time;
    if (time < cursor || time > endTime) {
      throw new Error(`Binance ${label} page timestamp ${time} is outside [${cursor}, ${endTime}]`);
    }
    if (index > 0 && time <= page[index - 1].time) {
      throw new Error(`Binance ${label} page timestamps are not strictly ascending at ${time}`);
    }
  }
}

function query(path: string, parameters: Record<string, string | number>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(parameters)) search.set(key, String(value));
  return `${path}?${search.toString()}`;
}

async function fetchKlines(
  startTime: number,
  nowMs: number,
  fetchImpl: FetchLike,
  retryAttempts: number,
  retryDelayMs: number,
): Promise<Candle[]> {
  const result: Candle[] = [];
  let cursor = startTime;
  while (cursor < nowMs) {
    const page = parseKlines(
      await fetchJson(
        query("/fapi/v1/klines", { symbol: SYMBOL, interval: "1h", limit: KLINE_LIMIT, startTime: cursor, endTime: nowMs }),
        fetchImpl,
        retryAttempts,
        retryDelayMs,
      ),
    );
    validateOfficialPage(page, "klines", cursor, nowMs, KLINE_LIMIT);
    if (page.length === 0) break;
    const last = page.at(-1)!;
    result.push(...page);
    cursor = last.time + HOUR_MS;
    if (page.length < KLINE_LIMIT) break;
  }
  return result;
}

async function fetchFunding(
  startTime: number,
  nowMs: number,
  fetchImpl: FetchLike,
  retryAttempts: number,
  retryDelayMs: number,
): Promise<FundingRecord[]> {
  const result: FundingRecord[] = [];
  let cursor = startTime;
  while (cursor <= nowMs) {
    const page = parseFundings(
      await fetchJson(
        query("/fapi/v1/fundingRate", { symbol: SYMBOL, limit: FUNDING_LIMIT, startTime: cursor, endTime: nowMs }),
        fetchImpl,
        retryAttempts,
        retryDelayMs,
      ),
      "Binance funding response",
      true,
    );
    validateOfficialPage(page, "funding", cursor, nowMs, FUNDING_LIMIT);
    if (page.length === 0) break;
    const last = page.at(-1)!;
    result.push(...page);
    cursor = last.time + 1;
    if (page.length < FUNDING_LIMIT) break;
  }
  return result;
}

function dataRange<T extends { time: number }>(entries: T[]): DataRange {
  return {
    firstTime: entries[0]?.time ?? null,
    lastTime: entries.at(-1)?.time ?? null,
    rowCount: entries.length,
  };
}

function sevenCalendarYearsBeforeAlignedHour(nowMs: number): number {
  const now = new Date(nowMs);
  return Date.UTC(
    now.getUTCFullYear() - 7,
    now.getUTCMonth(),
    now.getUTCDate(),
    now.getUTCHours(),
  );
}

function resolveGitMetadata(explicitSha: string | undefined, explicitDirty: boolean | undefined): {
  gitSha: string;
  gitDirty: boolean;
} {
  const gitSha = explicitSha === undefined
    ? execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), encoding: "utf8" }).trim()
    : explicitSha.trim();
  if (!gitSha) throw new Error("Unable to resolve evaluator git SHA");
  const gitDirty = explicitDirty === undefined
    ? execFileSync("git", ["status", "--porcelain"], { cwd: process.cwd(), encoding: "utf8" }).trim().length > 0
    : explicitDirty;
  if (typeof gitDirty !== "boolean") throw new Error("Unable to resolve evaluator dirty-worktree state");
  return { gitSha, gitDirty };
}

export async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function loadAndRefreshData(options: LoadAndRefreshDataOptions = {}): Promise<RefreshResult> {
  const nowMs = options.nowMs ?? Date.now();
  const cachePaths = { ...defaultCachePaths(), ...options.cachePaths };
  const refresh = options.refresh ?? true;
  const retryAttempts = options.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? 250;
  if (!Number.isInteger(nowMs) || nowMs <= 0) throw new Error(`Invalid refresh timestamp: ${nowMs}`);
  if (!Number.isInteger(retryAttempts) || retryAttempts < 1 || retryAttempts > MAX_RETRY_ATTEMPTS) {
    throw new Error(`Invalid retry attempts: ${retryAttempts}; expected 1-${MAX_RETRY_ATTEMPTS}`);
  }
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) throw new Error(`Invalid retry delay: ${retryDelayMs}`);
  const gitMetadata = resolveGitMetadata(options.gitSha, options.gitDirty);

  const cachedHourlyRaw = await readJson(cachePaths.hourlyCachePath);
  const cachedFundingRaw = await readJson(cachePaths.fundingCachePath);
  let hourly = mergeCandles([], cachedHourlyRaw === undefined ? [] : parseCachedCandles(cachedHourlyRaw), nowMs);
  let funding = sortAndDedupeFunding(
    [],
    cachedFundingRaw === undefined ? [] : parseFundings(cachedFundingRaw, "cached funding", false),
    nowMs,
  );

  if (refresh) {
    const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    const bootstrapStart = sevenCalendarYearsBeforeAlignedHour(nowMs);
    const klineStart = hourly.at(-1)?.time !== undefined ? hourly.at(-1)!.time + HOUR_MS : bootstrapStart;
    const fundingStart = funding.at(-1)?.time !== undefined ? funding.at(-1)!.time + 1 : bootstrapStart;
    const [newHourly, newFunding] = await Promise.all([
      fetchKlines(klineStart, nowMs, fetchImpl, retryAttempts, retryDelayMs),
      fetchFunding(fundingStart, nowMs, fetchImpl, retryAttempts, retryDelayMs),
    ]);
    hourly = mergeCandles(hourly, newHourly, nowMs);
    funding = sortAndDedupeFunding(funding, newFunding, nowMs);
    await stageAndCommitCachePair(cachePaths, hourly, funding, options.cacheRenameImpl ?? rename);
  }

  if (hourly.length === 0) throw new Error("No completed BTCUSDT 1h candles are available");
  const validation = validateHourlyData(hourly);
  const [hourlyHash, fundingHash] = await Promise.all([
    sha256File(cachePaths.hourlyCachePath),
    sha256File(cachePaths.fundingCachePath),
  ]);
  const provenance: Provenance = {
    source: FUTURES_REST,
    symbol: SYMBOL,
    interval: "1h",
    refreshedAt: new Date(nowMs).toISOString(),
    asOfMs: nowMs,
    gitSha: gitMetadata.gitSha,
    gitDirty: gitMetadata.gitDirty,
    evaluatorVersion: options.evaluatorVersion ?? EVALUATOR_VERSION,
    hourly: { path: cachePaths.hourlyCachePath, sha256: hourlyHash, range: dataRange(hourly) },
    funding: { path: cachePaths.fundingCachePath, sha256: fundingHash, range: dataRange(funding) },
    gaps: validation.gaps,
  };
  return { hourly, funding, asOfMs: nowMs, provenance };
}
