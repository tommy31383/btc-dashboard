/**
 * autoAccount — paper-trading account TỰ ĐỘNG vào lệnh khi rule fire.
 *
 * Spec (anh Tommy):
 *   - Capital ban đầu: 1000 USDT
 *   - Mỗi lệnh: margin 30 USDT, leverage 100x → notional 3000 USDT
 *   - Khi rule fire → đặt limit order tốt hơn 0.1% (LONG: -0.1%, SHORT: +0.1%)
 *   - Chờ tối đa 5 phút; không khớp → vào ngay tại current price
 *   - Không giới hạn concurrent positions (chỉ giới hạn bởi capital còn lại)
 *   - SL hit → -30 USD (margin × 100 × stopPct/100 = 30 × stopPct)
 *     Thực ra: pnl = -stopPct × notional / 100 = -30×stopPct USD
 *   - Reset: xoá hết, capital về 1000
 *
 * Storage: file `auto_account.json` trên branch `paper-data`.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { pullFile, scheduleFilePush, deleteFile } from "./gistSync";

const STORAGE_KEY = "@auto_account_v1";
const REMOTE_PATH = "auto_account.json";

export const INITIAL_CAPITAL_USD = 1000;
export const MARGIN_PER_TRADE_USD = 30;
export const LEVERAGE = 100;
export const NOTIONAL_USD = MARGIN_PER_TRADE_USD * LEVERAGE; // 3000
export const LIMIT_OFFSET_PCT = 0.1;        // tốt hơn rule entry 0.1%
export const LIMIT_WAIT_MS = 5 * 60 * 1000; // 5 phút

export type PositionStatus = "PENDING" | "OPEN" | "WIN" | "LOSS" | "TIMEOUT" | "RESET";

export interface AutoPosition {
  id: string;
  ruleId: string;
  tfKey: string;
  side: "LONG" | "SHORT";
  status: PositionStatus;

  /** Giá entry "lý tưởng" theo rule (raw close khi fire). */
  ruleEntryPrice: number;
  /** Limit price = ruleEntry ± 0.1%. */
  limitPrice: number;
  /** Giá fill thực tế (= limitPrice nếu khớp limit; = currentPrice nếu hết 5p). */
  entryPrice?: number;

  slPrice: number;
  tpPrice: number;
  marginUsd: number;
  leverage: number;
  notionalUsd: number;
  targetPct: number;
  stopPct: number;
  maxHoldBars: number;
  /** Bar interval ms (TF của rule). */
  barMs: number;

  createdMs: number;       // khi rule fire
  limitExpiresMs: number;  // createdMs + 5p
  openedMs?: number;       // khi fill
  closedMs?: number;
  exitPrice?: number;
  pnlUsd?: number;
  /** "limit_filled" | "auto_at_expiry" — debug */
  entryMode?: "limit_filled" | "auto_at_expiry";

  /** TF đặt limit order (nhỏ hơn rule TF). Cho debug, hiện chưa dùng để khớp candle. */
  entryTfKey?: string;
}

export interface AccountStats {
  totalTrades: number; // tổng số đã đóng
  wins: number;
  losses: number;
  timeouts: number;
  totalPnLUsd: number;
  lastResetMs: number;
}

export interface AutoAccount {
  version: 1;
  capitalUsd: number;     // tiền hiện tại (đã cộng/trừ PnL các lệnh đã đóng)
  positions: AutoPosition[];
  stats: AccountStats;
  updatedAt: number;
}

const TF_MS: Record<string, number> = {
  "1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
  "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000, "1w": 604_800_000,
};
export function tfMs(tfKey: string): number { return TF_MS[tfKey] ?? 3_600_000; }

/** TF nhỏ hơn dùng để "tìm entry thuận lợi". */
export function smallerEntryTF(ruleTF: string): string {
  switch (ruleTF) {
    case "5m":  return "1m";
    case "15m": return "5m";
    case "1h":  return "5m";
    case "4h":  return "15m";
    case "1d":  return "1h";
    case "1w":  return "4h";
    default:    return "5m";
  }
}

export function emptyAccount(): AutoAccount {
  return {
    version: 1,
    capitalUsd: INITIAL_CAPITAL_USD,
    positions: [],
    stats: {
      totalTrades: 0, wins: 0, losses: 0, timeouts: 0,
      totalPnLUsd: 0, lastResetMs: Date.now(),
    },
    updatedAt: Date.now(),
  };
}

export async function loadAccount(): Promise<AutoAccount> {
  try {
    const v = await AsyncStorage.getItem(STORAGE_KEY);
    if (!v) return emptyAccount();
    const parsed = JSON.parse(v) as AutoAccount;
    if (parsed.version !== 1) return emptyAccount();
    return parsed;
  } catch {
    return emptyAccount();
  }
}

async function persist(acc: AutoAccount): Promise<void> {
  acc.updatedAt = Date.now();
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(acc));
  scheduleFilePush(
    REMOTE_PATH,
    () => loadAccount(),
    () => `auto: account · cap $${acc.capitalUsd.toFixed(0)} · ${acc.stats.totalTrades} trades · PnL $${acc.stats.totalPnLUsd.toFixed(0)}`,
  );
}

export async function saveAccount(acc: AutoAccount): Promise<void> { await persist(acc); }

/** Pull from remote + merge (remote wins for closed positions, keeps any local-only). */
export async function pullAndMergeAccount(): Promise<AutoAccount> {
  const local = await loadAccount();
  const remote = await pullFile<AutoAccount>(REMOTE_PATH);
  if (!remote || remote.version !== 1) return local;
  // Position merge: remote takes precedence on closed; union otherwise
  const byId = new Map<string, AutoPosition>();
  for (const p of remote.positions) byId.set(p.id, p);
  for (const p of local.positions) {
    const r = byId.get(p.id);
    if (!r) byId.set(p.id, p);
    else {
      const lClosed = p.status !== "OPEN" && p.status !== "PENDING";
      const rClosed = r.status !== "OPEN" && r.status !== "PENDING";
      if (lClosed && !rClosed) byId.set(p.id, p);
      else if (rClosed && !lClosed) byId.set(p.id, r);
      else if ((p.openedMs || p.createdMs) > (r.openedMs || r.createdMs)) byId.set(p.id, p);
    }
  }
  const merged: AutoAccount = {
    version: 1,
    capitalUsd: remote.updatedAt > local.updatedAt ? remote.capitalUsd : local.capitalUsd,
    positions: Array.from(byId.values()).sort((a, b) => b.createdMs - a.createdMs),
    stats: remote.updatedAt > local.updatedAt ? remote.stats : local.stats,
    updatedAt: Date.now(),
  };
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  return merged;
}

/** RESET: xoá hết, về 1000 USD. Cũng xoá file remote. */
export async function resetAccount(): Promise<AutoAccount> {
  const fresh = emptyAccount();
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
  // Push file rỗng (DELETE rồi PUT lại). Dùng PUT trực tiếp để không cần delete branch ref.
  scheduleFilePush(
    REMOTE_PATH,
    async () => fresh,
    () => `auto: RESET account → cap $${INITIAL_CAPITAL_USD}`,
    100, // push gần ngay
  );
  return fresh;
}

// ─── Mutation helpers ──────────────────────────────────────────────────────

export interface OpenPositionArgs {
  ruleId: string;
  tfKey: string;
  side: "LONG" | "SHORT";
  ruleEntryPrice: number;
  slPriceRaw: number;   // SL đã tính theo rule (cùng leverage scale với entry)
  tpPriceRaw: number;
  targetPct: number;    // raw price %
  stopPct: number;
  maxHoldBars: number;
  barMs: number;
}

/** Tạo PENDING position (khi rule fire). Dedup: nếu đã có PENDING/OPEN cùng ruleId → skip. */
export async function tryCreatePending(args: OpenPositionArgs): Promise<AutoPosition | null> {
  const acc = await loadAccount();
  // Dedup
  if (acc.positions.some((p) => p.ruleId === args.ruleId && (p.status === "PENDING" || p.status === "OPEN"))) {
    return null;
  }
  // Margin check: nếu không còn đủ margin → skip
  const usedMargin = acc.positions
    .filter((p) => p.status === "OPEN" || p.status === "PENDING")
    .reduce((s, p) => s + p.marginUsd, 0);
  if (usedMargin + MARGIN_PER_TRADE_USD > acc.capitalUsd) return null;

  const limitOffset = args.ruleEntryPrice * (LIMIT_OFFSET_PCT / 100);
  const limitPrice = args.side === "LONG"
    ? args.ruleEntryPrice - limitOffset
    : args.ruleEntryPrice + limitOffset;

  const now = Date.now();
  const pos: AutoPosition = {
    id: `auto_${now}_${Math.random().toString(36).slice(2, 8)}`,
    ruleId: args.ruleId,
    tfKey: args.tfKey,
    side: args.side,
    status: "PENDING",
    ruleEntryPrice: args.ruleEntryPrice,
    limitPrice,
    slPrice: args.slPriceRaw,
    tpPrice: args.tpPriceRaw,
    marginUsd: MARGIN_PER_TRADE_USD,
    leverage: LEVERAGE,
    notionalUsd: NOTIONAL_USD,
    targetPct: args.targetPct,
    stopPct: args.stopPct,
    maxHoldBars: args.maxHoldBars,
    barMs: args.barMs,
    createdMs: now,
    limitExpiresMs: now + LIMIT_WAIT_MS,
    entryTfKey: smallerEntryTF(args.tfKey),
  };
  acc.positions.unshift(pos);
  await persist(acc);
  return pos;
}

/** Process pending → check fill (limit hit hoặc hết 5p auto fill). */
export async function processPending(currentPrice: number): Promise<number> {
  if (currentPrice <= 0) return 0;
  const acc = await loadAccount();
  const now = Date.now();
  let changed = 0;

  for (const p of acc.positions) {
    if (p.status !== "PENDING") continue;
    let fill: { price: number; mode: "limit_filled" | "auto_at_expiry" } | null = null;

    if (p.side === "LONG" && currentPrice <= p.limitPrice) {
      fill = { price: p.limitPrice, mode: "limit_filled" };
    } else if (p.side === "SHORT" && currentPrice >= p.limitPrice) {
      fill = { price: p.limitPrice, mode: "limit_filled" };
    } else if (now >= p.limitExpiresMs) {
      fill = { price: currentPrice, mode: "auto_at_expiry" };
    }

    if (fill) {
      p.status = "OPEN";
      p.entryPrice = fill.price;
      p.openedMs = now;
      p.entryMode = fill.mode;
      // Reposition SL/TP theo entry thực tế (giữ % rule)
      p.slPrice = p.side === "LONG"
        ? fill.price * (1 - p.stopPct / 100)
        : fill.price * (1 + p.stopPct / 100);
      p.tpPrice = p.side === "LONG"
        ? fill.price * (1 + p.targetPct / 100)
        : fill.price * (1 - p.targetPct / 100);
      changed++;
    }
  }

  if (changed > 0) await persist(acc);
  return changed;
}

/** Process OPEN positions → close on SL/TP/timeout. Returns # closed. */
export async function processOpen(currentPrice: number): Promise<number> {
  if (currentPrice <= 0) return 0;
  const acc = await loadAccount();
  const now = Date.now();
  let changed = 0;

  for (const p of acc.positions) {
    if (p.status !== "OPEN" || !p.entryPrice || !p.openedMs) continue;
    let closeAt: { price: number; status: PositionStatus; pnl: number } | null = null;

    const tpHit = p.side === "LONG" ? currentPrice >= p.tpPrice : currentPrice <= p.tpPrice;
    const slHit = p.side === "LONG" ? currentPrice <= p.slPrice : currentPrice >= p.slPrice;
    const deadline = p.openedMs + p.maxHoldBars * p.barMs;
    const timedOut = now >= deadline;

    if (slHit) {
      const pnl = -p.stopPct * p.notionalUsd / 100;   // âm
      closeAt = { price: p.slPrice, status: "LOSS", pnl };
    } else if (tpHit) {
      const pnl = p.targetPct * p.notionalUsd / 100;  // dương
      closeAt = { price: p.tpPrice, status: "WIN", pnl };
    } else if (timedOut) {
      // Đóng tại current price, PnL theo % thực tế
      const pct = p.side === "LONG"
        ? (currentPrice - p.entryPrice) / p.entryPrice * 100
        : (p.entryPrice - currentPrice) / p.entryPrice * 100;
      const pnl = pct * p.notionalUsd / 100;
      closeAt = { price: currentPrice, status: "TIMEOUT", pnl };
    }

    if (closeAt) {
      p.status = closeAt.status;
      p.exitPrice = closeAt.price;
      p.pnlUsd = closeAt.pnl;
      p.closedMs = now;
      acc.capitalUsd += closeAt.pnl;
      acc.stats.totalTrades++;
      acc.stats.totalPnLUsd += closeAt.pnl;
      if (closeAt.status === "WIN") acc.stats.wins++;
      else if (closeAt.status === "LOSS") acc.stats.losses++;
      else if (closeAt.status === "TIMEOUT") acc.stats.timeouts++;
      changed++;
    }
  }

  if (changed > 0) await persist(acc);
  return changed;
}

export function summarize(acc: AutoAccount) {
  const open = acc.positions.filter((p) => p.status === "OPEN");
  const pending = acc.positions.filter((p) => p.status === "PENDING");
  const closed = acc.positions.filter(
    (p) => p.status === "WIN" || p.status === "LOSS" || p.status === "TIMEOUT",
  );
  const usedMargin = (open.length + pending.length) * MARGIN_PER_TRADE_USD;
  const winRate = acc.stats.totalTrades > 0
    ? (acc.stats.wins / acc.stats.totalTrades) * 100
    : 0;
  const equity = acc.capitalUsd; // unrealized chưa cộng — UI có thể tính riêng nếu cần
  const roi = ((acc.capitalUsd - INITIAL_CAPITAL_USD) / INITIAL_CAPITAL_USD) * 100;
  return { open, pending, closed, usedMargin, winRate, equity, roi };
}
