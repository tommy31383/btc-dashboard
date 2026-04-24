/**
 * Paper Trader — port simplified từ BTCX/live/backend/trader.py.
 * KHÔNG đụng API thật. Chỉ ghi log entry/exit + tính PnL local AsyncStorage.
 *
 * Flow:
 *   1. Rule FIRE → openTrade() ghi 1 trade OPEN với entry/SL/TP
 *   2. Mỗi tick price → checkOpenTrades() so currentPrice với SL/TP/timeout
 *   3. Khi đóng → status WIN/LOSS/TIMEOUT, update PnL cộng dồn
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

const TRADES_KEY = "@btc_paper_trades";
const MAX_TRADES = 200;

const TF_MS: Record<string, number> = {
  "1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
  "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000, "1w": 604_800_000,
};

export interface PaperTrade {
  id: string;
  ruleId: string;
  tfKey: string;
  side: "LONG" | "SHORT";
  status: "OPEN" | "WIN" | "LOSS" | "TIMEOUT";
  entryPrice: number;
  slPrice: number;
  tpPrice: number;
  leverage: number;
  /** Raw price % (KHÔNG nhân leverage) — match style cfg.targetPct/stopPct */
  targetPct: number;
  stopPct: number;
  /** Bars max hold trước khi timeout. */
  maxHoldBars: number;
  openedMs: number;
  /** Deadline = opened + maxHoldBars × bar_ms */
  deadlineMs: number;
  closedMs?: number;
  exitPrice?: number;
  /** PnL % đã nhân leverage */
  leveragedPnlPct?: number;
}

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

export async function loadTrades(): Promise<PaperTrade[]> {
  return readJson<PaperTrade[]>(TRADES_KEY, []);
}

async function saveTrades(trades: PaperTrade[]): Promise<void> {
  if (trades.length > MAX_TRADES) trades.splice(0, trades.length - MAX_TRADES);
  await writeJson(TRADES_KEY, trades);
}

/**
 * Open new paper trade. Dedup: nếu đã có OPEN trade của cùng ruleId → skip
 * (tránh chồng lệnh khi rule bắn lại trên cùng 1 nến).
 */
export async function openTrade(args: {
  ruleId: string;
  tfKey: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  slPrice: number;
  tpPrice: number;
  leverage: number;
  targetPct: number;
  stopPct: number;
  maxHoldBars: number;
  barTimeMs: number;
}): Promise<PaperTrade | null> {
  const trades = await loadTrades();
  for (const t of trades) {
    if (t.status === "OPEN" && t.ruleId === args.ruleId) return null;
  }
  const dt = TF_MS[args.tfKey] ?? 3_600_000;
  const trade: PaperTrade = {
    id: Math.random().toString(36).slice(2, 14),
    ruleId: args.ruleId,
    tfKey: args.tfKey,
    side: args.side,
    status: "OPEN",
    entryPrice: args.entryPrice,
    slPrice: args.slPrice,
    tpPrice: args.tpPrice,
    leverage: args.leverage,
    targetPct: args.targetPct,
    stopPct: args.stopPct,
    maxHoldBars: args.maxHoldBars,
    openedMs: Date.now(),
    deadlineMs: args.barTimeMs + args.maxHoldBars * dt,
  };
  trades.push(trade);
  await saveTrades(trades);
  return trade;
}

/**
 * Check open trades: so currentPrice với SL/TP/deadline. Đóng nếu match.
 * Returns danh sách trade vừa đóng trong call này (để UI/notify).
 */
export async function checkOpenTrades(
  getPrice: (tfKey: string) => number | null,
): Promise<PaperTrade[]> {
  const trades = await loadTrades();
  const now = Date.now();
  const justClosed: PaperTrade[] = [];

  for (const t of trades) {
    if (t.status !== "OPEN") continue;
    const cur = getPrice(t.tfKey);
    if (cur === null || cur <= 0) {
      if (now > t.deadlineMs) {
        t.status = "TIMEOUT";
        t.closedMs = now;
        t.exitPrice = t.entryPrice;
        t.leveragedPnlPct = 0;
        justClosed.push(t);
      }
      continue;
    }

    let closed = false;
    if (t.side === "LONG") {
      if (cur <= t.slPrice) {
        t.status = "LOSS";
        t.exitPrice = t.slPrice;
        t.leveragedPnlPct = -t.stopPct * t.leverage;
        closed = true;
      } else if (cur >= t.tpPrice) {
        t.status = "WIN";
        t.exitPrice = t.tpPrice;
        t.leveragedPnlPct = t.targetPct * t.leverage;
        closed = true;
      }
    } else {
      if (cur >= t.slPrice) {
        t.status = "LOSS";
        t.exitPrice = t.slPrice;
        t.leveragedPnlPct = -t.stopPct * t.leverage;
        closed = true;
      } else if (cur <= t.tpPrice) {
        t.status = "WIN";
        t.exitPrice = t.tpPrice;
        t.leveragedPnlPct = t.targetPct * t.leverage;
        closed = true;
      }
    }

    if (!closed && now > t.deadlineMs) {
      const rawPct = ((cur - t.entryPrice) / t.entryPrice) * 100;
      const pnl = t.side === "LONG" ? rawPct : -rawPct;
      t.status = "TIMEOUT";
      t.exitPrice = cur;
      t.leveragedPnlPct = +(pnl * t.leverage).toFixed(2);
      closed = true;
    }

    if (closed) {
      t.closedMs = now;
      justClosed.push(t);
    }
  }

  if (justClosed.length > 0) await saveTrades(trades);
  return justClosed;
}

export interface PaperTradeSummary {
  total: number;
  open: number;
  wins: number;
  losses: number;
  timeouts: number;
  winRate: number;
  totalPnlPct: number;
  bestTradePct: number;
  worstTradePct: number;
}

export function summarize(trades: PaperTrade[]): PaperTradeSummary {
  const closed = trades.filter((t) => t.status !== "OPEN");
  const wins = closed.filter((t) => t.status === "WIN").length;
  const losses = closed.filter((t) => t.status === "LOSS").length;
  const timeouts = closed.filter((t) => t.status === "TIMEOUT").length;
  const totalPnl = closed.reduce((s, t) => s + (t.leveragedPnlPct ?? 0), 0);
  const pnls = closed.map((t) => t.leveragedPnlPct ?? 0);
  return {
    total: trades.length,
    open: trades.length - closed.length,
    wins,
    losses,
    timeouts,
    winRate: closed.length > 0 ? +((wins / closed.length) * 100).toFixed(1) : 0,
    totalPnlPct: +totalPnl.toFixed(2),
    bestTradePct: pnls.length > 0 ? +Math.max(...pnls).toFixed(2) : 0,
    worstTradePct: pnls.length > 0 ? +Math.min(...pnls).toFixed(2) : 0,
  };
}

export async function clearAllPaperTrades(): Promise<void> {
  await AsyncStorage.removeItem(TRADES_KEY);
}
