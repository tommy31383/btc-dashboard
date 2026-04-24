/**
 * Calibration — port từ BTCX/live/backend/learner.py.
 *
 * Mỗi lần rule FIRE, log 1 prediction kèm entry price + mature_at (sau N bars).
 * Khi đến mature, so giá hiện tại với entry → hit/miss → cộng dồn vào bucket
 * (bucket = floor(rawConf/10)*10) cho cặp (tfKey, side).
 *
 * Sau MIN_RESOLVED mẫu, hit_rate < HIT_RATE_THRESHOLD → đánh dấu rule "kém"
 * (UI có thể tự động bỏ track hoặc chỉ cảnh báo — em chọn cảnh báo, không tự
 * untrack để tránh ghi đè ý anh Tommy).
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

const PENDING_KEY = "@btc_calib_pending";
const STATS_KEY = "@btc_calib_stats";
const LOG_KEY = "@btc_calib_log";

export const HIT_RATE_THRESHOLD = 0.4;
export const MIN_RESOLVED_FOR_WARN = 10;
export const MIN_RESOLVED_FOR_DISABLE = 30;
const MAX_LOG_ENTRIES = 500;

/** Bars để chờ trước khi resolve (mature horizon) per TF. */
const TF_HORIZON_BARS: Record<string, number> = {
  "1m": 5, "5m": 4, "15m": 4, "30m": 3,
  "1h": 3, "4h": 2, "1d": 2, "1w": 1,
};

/** ms per TF — để compute mature timestamp. */
const TF_MS: Record<string, number> = {
  "1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
  "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000, "1w": 604_800_000,
};

export interface PendingPrediction {
  id: string;
  ruleId: string;     // "<tfKey>:<rank>"
  tfKey: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  rawConf: number;    // 0-100, dùng winRate * profitFactor scaled
  barTimeMs: number;
  matureMs: number;
  createdMs: number;
}

export interface BucketStats {
  n: number;
  hits: number;
  hitRate: number;
  avgReturn: number;
}

export interface RuleStats {
  n: number;
  hits: number;
  hitRate: number;
  avgReturn: number;
  lastResolvedMs: number;
}

export interface CalibStats {
  /** Per (tfKey:side) → buckets */
  buckets: Record<string, Record<string, BucketStats>>;
  /** Per ruleId */
  rules: Record<string, RuleStats>;
}

export interface ResolveLogEntry {
  ruleId: string;
  tfKey: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  exitPrice: number;
  ret: number;
  hit: 0 | 1;
  resolvedMs: number;
}

const EMPTY_STATS: CalibStats = { buckets: {}, rules: {} };

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const v = await AsyncStorage.getItem(key);
    if (!v) return fallback;
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

export async function loadPending(): Promise<PendingPrediction[]> {
  return readJson<PendingPrediction[]>(PENDING_KEY, []);
}

export async function loadStats(): Promise<CalibStats> {
  const s = await readJson<CalibStats>(STATS_KEY, EMPTY_STATS);
  if (!s.buckets) s.buckets = {};
  if (!s.rules) s.rules = {};
  return s;
}

export async function loadLog(): Promise<ResolveLogEntry[]> {
  return readJson<ResolveLogEntry[]>(LOG_KEY, []);
}

/** Log a new prediction. Dedup: same (ruleId, barTimeMs, side) → skip. */
export async function logPrediction(args: {
  ruleId: string;
  tfKey: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  rawConf: number;
  barTimeMs: number;
}): Promise<string | null> {
  const horizon = TF_HORIZON_BARS[args.tfKey] ?? 4;
  const dt = TF_MS[args.tfKey];
  if (!dt) return null;

  const pending = await loadPending();
  for (const p of pending) {
    if (
      p.ruleId === args.ruleId &&
      p.barTimeMs === args.barTimeMs &&
      p.side === args.side
    ) {
      return null;
    }
  }
  const now = Date.now();
  const entry: PendingPrediction = {
    id: Math.random().toString(36).slice(2, 14),
    ruleId: args.ruleId,
    tfKey: args.tfKey,
    side: args.side,
    entryPrice: args.entryPrice,
    rawConf: Math.round(args.rawConf),
    barTimeMs: args.barTimeMs,
    matureMs: args.barTimeMs + horizon * dt,
    createdMs: now,
  };
  pending.push(entry);
  await writeJson(PENDING_KEY, pending);
  return entry.id;
}

function bucketOf(conf: number): string {
  return String(Math.max(0, Math.min(100, Math.floor(conf / 10) * 10)));
}

function updateBucket(
  stats: CalibStats,
  tfKey: string,
  side: "LONG" | "SHORT",
  rawConf: number,
  hit: 0 | 1,
  ret: number,
): void {
  const key = `${tfKey}:${side}`;
  if (!stats.buckets[key]) stats.buckets[key] = {};
  const bucket = bucketOf(rawConf);
  const s = stats.buckets[key][bucket] ?? { n: 0, hits: 0, hitRate: 0, avgReturn: 0 };
  const prevSum = s.avgReturn * Math.max(1, s.n);
  s.n += 1;
  s.hits += hit;
  s.hitRate = +(s.hits / s.n).toFixed(3);
  s.avgReturn = +((prevSum + ret) / s.n).toFixed(5);
  stats.buckets[key][bucket] = s;
}

function updateRule(
  stats: CalibStats,
  ruleId: string,
  hit: 0 | 1,
  ret: number,
  nowMs: number,
): void {
  const r = stats.rules[ruleId] ?? { n: 0, hits: 0, hitRate: 0, avgReturn: 0, lastResolvedMs: 0 };
  const prevSum = r.avgReturn * Math.max(1, r.n);
  r.n += 1;
  r.hits += hit;
  r.hitRate = +(r.hits / r.n).toFixed(3);
  r.avgReturn = +((prevSum + ret) / r.n).toFixed(5);
  r.lastResolvedMs = nowMs;
  stats.rules[ruleId] = r;
}

/**
 * Resolve all matured pendings using (tfKey)→currentPrice map. Returns count.
 * Updates stats + appends log.
 */
export async function resolvePending(
  getPrice: (tfKey: string) => number | null,
): Promise<number> {
  const pending = await loadPending();
  if (pending.length === 0) return 0;

  const now = Date.now();
  const stats = await loadStats();
  const log = await loadLog();
  const still: PendingPrediction[] = [];
  let resolved = 0;

  for (const p of pending) {
    if (now < p.matureMs) {
      still.push(p);
      continue;
    }
    const cur = getPrice(p.tfKey);
    if (cur === null || cur <= 0) {
      still.push(p);
      continue;
    }
    const ret = (cur - p.entryPrice) / p.entryPrice;
    const hit: 0 | 1 = (p.side === "LONG" ? ret > 0 : ret < 0) ? 1 : 0;
    updateBucket(stats, p.tfKey, p.side, p.rawConf, hit, ret);
    updateRule(stats, p.ruleId, hit, ret, now);
    log.push({
      ruleId: p.ruleId,
      tfKey: p.tfKey,
      side: p.side,
      entryPrice: p.entryPrice,
      exitPrice: cur,
      ret: +ret.toFixed(5),
      hit,
      resolvedMs: now,
    });
    resolved += 1;
  }

  if (resolved > 0) {
    await writeJson(PENDING_KEY, still);
    await writeJson(STATS_KEY, stats);
    if (log.length > MAX_LOG_ENTRIES) log.splice(0, log.length - MAX_LOG_ENTRIES);
    await writeJson(LOG_KEY, log);
  }
  return resolved;
}

/**
 * Apply calibration: blend raw heuristic confidence with empirical hit-rate.
 * adj = 0.4 × raw + 0.6 × hit_rate × 100. Bucket có >= 5 mẫu mới tính.
 */
export function applyCalibration(
  stats: CalibStats,
  tfKey: string,
  side: "LONG" | "SHORT",
  rawConf: number,
): { adjusted: number; info: { hitRate: number; n: number; bucket: number } | null } {
  const key = `${tfKey}:${side}`;
  const buckets = stats.buckets[key];
  if (!buckets) return { adjusted: rawConf, info: null };

  const rawBucket = Math.floor(rawConf / 10) * 10;
  let best: { dist: number; bucket: number; stats: BucketStats } | null = null;
  for (const [bStr, s] of Object.entries(buckets)) {
    const b = parseInt(bStr, 10);
    if (Number.isNaN(b)) continue;
    if (s.n < 5) continue;
    const dist = Math.abs(b - rawBucket);
    if (best === null || dist < best.dist) best = { dist, bucket: b, stats: s };
  }
  if (!best) return { adjusted: rawConf, info: null };

  const hr = best.stats.hits / Math.max(1, best.stats.n);
  const adj = Math.max(0, Math.min(100, Math.round(0.4 * rawConf + 0.6 * hr * 100)));
  return {
    adjusted: adj,
    info: { hitRate: +hr.toFixed(3), n: best.stats.n, bucket: best.bucket },
  };
}

/** Health classification cho 1 rule. */
export type RuleHealth = "unknown" | "ok" | "warn" | "bad";

export function classifyRuleHealth(stats: RuleStats | undefined): RuleHealth {
  if (!stats || stats.n < MIN_RESOLVED_FOR_WARN) return "unknown";
  if (stats.hitRate >= HIT_RATE_THRESHOLD) return "ok";
  if (stats.n >= MIN_RESOLVED_FOR_DISABLE) return "bad";
  return "warn";
}

export async function clearAllCalibration(): Promise<void> {
  await Promise.all([
    AsyncStorage.removeItem(PENDING_KEY),
    AsyncStorage.removeItem(STATS_KEY),
    AsyncStorage.removeItem(LOG_KEY),
  ]);
}
