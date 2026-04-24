/**
 * all15mAccount — paper-trading account cho tab "15m All".
 *
 * Spec (anh Tommy):
 *   - Capital: 1000 USDT
 *   - Mỗi nến 15m đóng → tạo 1 PENDING LONG (deadline +7 phút)
 *   - Trong 7 phút: check 5m StochRSI K; K<20 → fill ngay
 *   - Hết 7 phút chưa khớp → force fill tại current price
 *   - Mỗi lệnh: margin 30 USD × 100x = notional 3000 → TP +5% / SL -2% raw
 *     PnL/lệnh: TP +5% × 30 × 100 / 100 = +$150  ·  SL -2% → cap -margin = -$30
 *   - Local PC only — AsyncStorage, KHÔNG sync repo
 *
 * Storage key: @all15m_data_v1 (file 15mALLdata.json conceptually)
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEY = "@all15m_data_v1";

export const INITIAL_CAPITAL = 1000;
export const MARGIN_PER_TRADE = 30;
export const LEVERAGE = 100;
export const NOTIONAL = MARGIN_PER_TRADE * LEVERAGE; // 3000
export const TP_PCT = 5;
export const SL_PCT = 2;
export const PENDING_TIMEOUT_MS = 7 * 60 * 1000; // 7 phút
export const STOCH_OS_LEVEL = 20;
export const FEE_PER_SIDE_PCT = 0.05;
export const FEE_PER_SIDE = NOTIONAL * (FEE_PER_SIDE_PCT / 100); // = 1.5 USD/side
export const FEE_PER_TRADE = FEE_PER_SIDE * 2;                   // = 3 USD/lệnh (entry + exit)

export type EntryMode = "stoch_dep" | "force_timeout";
export type Outcome = "PENDING" | "OPEN" | "WIN" | "LOSS";

export interface Position {
  id: string;                 // uuid: bar-${ts}
  bar15mTime: number;         // close timestamp của nến 15m trigger
  status: Outcome;
  // Pending
  pendingCreatedMs: number;
  pendingDeadlineMs: number;  // +7 phút
  triggerPrice: number;       // close của nến 15m
  // Open
  entryPrice?: number;
  entryMs?: number;
  entryMode?: EntryMode;
  tpPrice?: number;
  slPrice?: number;
  entryFeeUsd?: number;       // trừ ngay khi fill (1 side)
  // Closed
  exitPrice?: number;
  exitMs?: number;
  exitFeeUsd?: number;        // trừ khi close (1 side)
  pnlUsd?: number;            // pnl GROSS (chưa trừ fee)
  pnlNetUsd?: number;         // pnl NET = gross − entryFee − exitFee
}

export interface AccountStats {
  totalClosed: number;
  wins: number;
  losses: number;
  totalPnlUsd: number;
  totalFeeUsd: number;
  lastResetMs: number;
}

export interface All15mAccount {
  version: 1;
  capital: number;            // current cash (sau pnl)
  positions: Position[];
  equityHistory: { t: number; equity: number }[]; // for chart, append on each close
  stats: AccountStats;
  updatedAt: number;
}

export function emptyAccount(): All15mAccount {
  const now = Date.now();
  return {
    version: 1,
    capital: INITIAL_CAPITAL,
    positions: [],
    equityHistory: [{ t: now, equity: INITIAL_CAPITAL }],
    stats: { totalClosed: 0, wins: 0, losses: 0, totalPnlUsd: 0, totalFeeUsd: 0, lastResetMs: now },
    updatedAt: now,
  };
}

export async function loadAccount(): Promise<All15mAccount> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyAccount();
    const p = JSON.parse(raw) as All15mAccount;
    if (p.version !== 1) return emptyAccount();
    if (!p.equityHistory) p.equityHistory = [{ t: p.updatedAt, equity: p.capital }];
    return p;
  } catch { return emptyAccount(); }
}

export async function saveAccount(acc: All15mAccount): Promise<void> {
  acc.updatedAt = Date.now();
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(acc));
}

export async function resetAccount(): Promise<All15mAccount> {
  const fresh = emptyAccount();
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
  return fresh;
}

/** Free margin = capital - sum(margin của OPEN/PENDING). */
export function usedMargin(acc: All15mAccount): number {
  return acc.positions
    .filter((p) => p.status === "OPEN" || p.status === "PENDING")
    .length * MARGIN_PER_TRADE;
}
export function freeMargin(acc: All15mAccount): number {
  return acc.capital - usedMargin(acc);
}

/** Tạo pending khi nến 15m mới đóng. Dedup theo bar15mTime. */
export async function tryCreatePending(bar15mTime: number, triggerPrice: number): Promise<Position | null> {
  const acc = await loadAccount();
  if (acc.positions.some((p) => p.bar15mTime === bar15mTime)) return null;
  if (freeMargin(acc) < MARGIN_PER_TRADE) return null;
  const now = Date.now();
  const pos: Position = {
    id: `bar-${bar15mTime}`,
    bar15mTime,
    status: "PENDING",
    pendingCreatedMs: now,
    pendingDeadlineMs: now + PENDING_TIMEOUT_MS,
    triggerPrice,
  };
  acc.positions.unshift(pos);
  await saveAccount(acc);
  return pos;
}

function fillPosition(pos: Position, fillPrice: number, mode: EntryMode, nowMs: number) {
  pos.status = "OPEN";
  pos.entryPrice = fillPrice;
  pos.entryMs = nowMs;
  pos.entryMode = mode;
  pos.tpPrice = fillPrice * (1 + TP_PCT / 100);
  pos.slPrice = fillPrice * (1 - SL_PCT / 100);
  pos.entryFeeUsd = FEE_PER_SIDE;
}

/** Process pending: fill nếu (5m K < 20) hoặc deadline. Return số lệnh đã fill. */
export async function processPending(currentPrice: number, stoch5mK: number | null): Promise<number> {
  const acc = await loadAccount();
  const now = Date.now();
  let filled = 0;
  for (const p of acc.positions) {
    if (p.status !== "PENDING") continue;
    const stochOk = stoch5mK !== null && stoch5mK < STOCH_OS_LEVEL;
    const expired = now >= p.pendingDeadlineMs;
    if (stochOk) { fillPosition(p, currentPrice, "stoch_dep", now); filled++; }
    else if (expired) { fillPosition(p, currentPrice, "force_timeout", now); filled++; }
  }
  if (filled > 0) {
    // Trừ entry fee NGAY khi mở lệnh (như sàn thật)
    const totalEntryFee = filled * FEE_PER_SIDE;
    acc.capital -= totalEntryFee;
    acc.stats.totalFeeUsd += totalEntryFee;
    acc.equityHistory.push({ t: Date.now(), equity: acc.capital });
    if (acc.equityHistory.length > 1000) acc.equityHistory = acc.equityHistory.slice(-1000);
    await saveAccount(acc);
  }
  return filled;
}

/** Process OPEN: check TP/SL hit theo current price. PnL_USD = MARGIN × pnlPct × LEV / 100, capped -MARGIN. */
export async function processOpen(currentPrice: number): Promise<number> {
  const acc = await loadAccount();
  const now = Date.now();
  let closed = 0;
  for (const p of acc.positions) {
    if (p.status !== "OPEN" || !p.entryPrice || !p.tpPrice || !p.slPrice) continue;
    let outcome: "WIN" | "LOSS" | null = null;
    let exitPrice = currentPrice;
    if (currentPrice >= p.tpPrice) { outcome = "WIN"; exitPrice = p.tpPrice; }
    else if (currentPrice <= p.slPrice) { outcome = "LOSS"; exitPrice = p.slPrice; }
    if (!outcome) continue;

    const rawPct = ((exitPrice - p.entryPrice) / p.entryPrice) * 100;
    let grossPnl = MARGIN_PER_TRADE * rawPct * LEVERAGE / 100;
    if (grossPnl < -MARGIN_PER_TRADE) grossPnl = -MARGIN_PER_TRADE;
    const exitFee = FEE_PER_SIDE;
    const entryFee = p.entryFeeUsd ?? FEE_PER_SIDE;
    const netPnl = grossPnl - entryFee - exitFee;

    p.status = outcome;
    p.exitPrice = exitPrice;
    p.exitMs = now;
    p.exitFeeUsd = exitFee;
    p.pnlUsd = grossPnl;
    p.pnlNetUsd = netPnl;

    // Capital đã trừ entryFee lúc fill — giờ chỉ +grossPnl − exitFee
    acc.capital += grossPnl - exitFee;
    acc.stats.totalClosed++;
    if (outcome === "WIN") acc.stats.wins++; else acc.stats.losses++;
    acc.stats.totalPnlUsd += netPnl;
    acc.stats.totalFeeUsd += exitFee;
    acc.equityHistory.push({ t: now, equity: acc.capital });
    closed++;
  }
  if (closed > 0) {
    // Cap equityHistory to last 1000 points
    if (acc.equityHistory.length > 1000) acc.equityHistory = acc.equityHistory.slice(-1000);
    await saveAccount(acc);
  }
  return closed;
}

export interface AccountSummary {
  capital: number;
  equity: number;        // capital (đã reflect closed pnl)
  freeMargin: number;
  usedMargin: number;
  pendingCount: number;
  openCount: number;
  totalClosed: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnlUsd: number;
  totalFeeUsd: number;
  roi: number;           // % vs INITIAL_CAPITAL
}

export function summarize(acc: All15mAccount): AccountSummary {
  const used = usedMargin(acc);
  const pending = acc.positions.filter((p) => p.status === "PENDING").length;
  const open = acc.positions.filter((p) => p.status === "OPEN").length;
  const wr = acc.stats.totalClosed > 0 ? (acc.stats.wins / acc.stats.totalClosed) * 100 : 0;
  return {
    capital: acc.capital,
    equity: acc.capital,
    freeMargin: acc.capital - used,
    usedMargin: used,
    pendingCount: pending,
    openCount: open,
    totalClosed: acc.stats.totalClosed,
    wins: acc.stats.wins,
    losses: acc.stats.losses,
    winRate: wr,
    totalPnlUsd: acc.stats.totalPnlUsd,
    totalFeeUsd: acc.stats.totalFeeUsd,
    roi: ((acc.capital - INITIAL_CAPITAL) / INITIAL_CAPITAL) * 100,
  };
}
