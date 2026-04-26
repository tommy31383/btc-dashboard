/**
 * all5mAccount — paper-trading account cho tab "5m All".
 *
 * Spec (anh Tommy, theo backtest tools/backtest-stoch-5m.ts):
 *   - 5m closed bar → quyết định ngay (không có PENDING phase như 15mALL)
 *   - StochRSI 5m K<10 → LONG; K>90 → SHORT
 *   - Else fallback S/R 15m: close gần support (≤0.3%) → LONG, gần resistance → SHORT
 *   - TP +4% / SL -2% (raw); cooldown 15 phút (3 cây 5m) sau entry
 *   - Capital $1000, margin $30 × 100x, fee 0.05%/side ($1.5/side)
 *   - Vào song song nhiều lệnh
 *   - Local PC only (AsyncStorage)
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { pullFile, scheduleFilePush } from "./gistSync";

const STORAGE_KEY = "@all5m_data_v1";
const REMOTE_FILE = "all5m_account.json";

export const INITIAL_CAPITAL = 1000;
export const MARGIN_PER_TRADE = 30;
export const LEVERAGE = 100;
export const NOTIONAL = MARGIN_PER_TRADE * LEVERAGE;
export const TP_PCT = 4;
export const SL_PCT = 2;
export const STOCH_LONG_LEVEL = 10;
export const STOCH_SHORT_LEVEL = 90;
export const COOLDOWN_MS = 10 * 60 * 1000;  // 10 phút giữa các entry (tổng, mọi side)
export const SR_PROXIMITY_PCT = 0.3;
// SMART STACK: cho phép nhiều lệnh cùng side, mỗi lệnh TP/SL riêng (anh Tommy v4.3.87+)
export const STACK_MAX_PER_SIDE = 15;            // tối đa 15 LONG + 15 SHORT cùng lúc
export const STACK_PER_SIDE_SPACING_MS = 10 * 60 * 1000; // tối thiểu 10m giữa 2 entry CÙNG side
export const STACK_MIN_ENTRY_DIST_PCT = 0.3;     // entry mới phải xa entry gần nhất cùng side ≥ 0.3%
export const FEE_PER_SIDE_PCT = 0.05;
export const FEE_PER_SIDE = NOTIONAL * (FEE_PER_SIDE_PCT / 100);
export const FEE_PER_TRADE = FEE_PER_SIDE * 2;

export type EntrySource = "stoch_long" | "stoch_short" | "sr_long" | "sr_short";
export type Side = "LONG" | "SHORT";
export type Outcome = "OPEN" | "WIN" | "LOSS";

export interface Position {
  id: string;
  bar5mTime: number;
  status: Outcome;
  side: Side;
  source: EntrySource;
  entryPrice: number;
  entryMs: number;
  tpPrice: number;
  slPrice: number;
  entryFeeUsd: number;
  exitPrice?: number;
  exitMs?: number;
  exitFeeUsd?: number;
  pnlUsd?: number;        // gross
  pnlNetUsd?: number;     // net (gross − 2× fee)
}

export interface AccountStats {
  totalClosed: number;
  wins: number;
  losses: number;
  totalPnlUsd: number;
  totalFeeUsd: number;
  lastEntryMs: number;    // for cooldown
  lastResetMs: number;
}

export interface All5mAccount {
  version: 1;
  capital: number;
  positions: Position[];
  equityHistory: { t: number; equity: number }[];
  stats: AccountStats;
  updatedAt: number;
}

export function emptyAccount(): All5mAccount {
  const now = Date.now();
  return {
    version: 1,
    capital: INITIAL_CAPITAL,
    positions: [],
    equityHistory: [{ t: now, equity: INITIAL_CAPITAL }],
    stats: { totalClosed: 0, wins: 0, losses: 0, totalPnlUsd: 0, totalFeeUsd: 0, lastEntryMs: 0, lastResetMs: now },
    updatedAt: now,
  };
}

export async function loadAccount(): Promise<All5mAccount> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyAccount();
    const p = JSON.parse(raw) as All5mAccount;
    if (p.version !== 1) return emptyAccount();
    if (!p.equityHistory) p.equityHistory = [{ t: p.updatedAt, equity: p.capital }];
    return p;
  } catch { return emptyAccount(); }
}

function isAll5mAccount(v: unknown): v is All5mAccount {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return o.version === 1 && typeof o.capital === "number" && Array.isArray(o.positions);
}

export async function saveAccount(acc: All5mAccount, opts: { sync?: boolean } = {}): Promise<void> {
  acc.updatedAt = Date.now();
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(acc));
  if (opts.sync !== false) {
    // Leader push lên gist — debounce 10s (anh Tommy v4.5.2: 5s → 10s)
    scheduleFilePush(
      REMOTE_FILE,
      async () => acc,
      () => `data: 5m ALL · ${acc.positions.filter(p => p.status === "OPEN").length} open · cap $${acc.capital.toFixed(0)}`,
      10000,
    );
  }
}

/** Follower pull state từ gist + save local (KHÔNG push lại). Trả về account mới hoặc null. */
export async function pullAccountFromGist(): Promise<All5mAccount | null> {
  const remote = await pullFile<All5mAccount>(REMOTE_FILE, isAll5mAccount);
  if (!remote) return null;
  // Lưu local nhưng KHÔNG sync lại (tránh loop)
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(remote));
  return remote;
}

export async function resetAccount(): Promise<All5mAccount> {
  const fresh = emptyAccount();
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
  await saveAccount(fresh); // sync gist luôn
  return fresh;
}

export function usedMargin(acc: All5mAccount): number {
  return acc.positions.filter((p) => p.status === "OPEN").length * MARGIN_PER_TRADE;
}
export function freeMargin(acc: All5mAccount): number {
  return acc.capital - usedMargin(acc);
}

/**
 * Quyết định entry cho 1 cây 5m closed.
 *  - Dedup theo bar5mTime
 *  - Cooldown: lastEntryMs + 15 phút
 *  - Trigger: stoch K<10 LONG, K>90 SHORT, else S/R 15m fallback
 * Trả về true nếu có entry mới.
 */
export async function tryEntry5mBar(
  bar5mTime: number,
  fillPrice: number,
  stoch5mK: number | null,
  support15m: number | null,
  resistance15m: number | null,
): Promise<Position | null> {
  const acc = await loadAccount();
  if (acc.positions.some((p) => p.bar5mTime === bar5mTime)) return null;
  const now = Date.now();
  if (now - acc.stats.lastEntryMs < COOLDOWN_MS) return null;
  if (freeMargin(acc) < MARGIN_PER_TRADE) return null;

  let side: Side | null = null;
  let source: EntrySource | null = null;

  if (stoch5mK !== null && stoch5mK < STOCH_LONG_LEVEL) { side = "LONG"; source = "stoch_long"; }
  else if (stoch5mK !== null && stoch5mK > STOCH_SHORT_LEVEL) { side = "SHORT"; source = "stoch_short"; }
  else if (support15m !== null && resistance15m !== null) {
    const distSup = ((fillPrice - support15m) / support15m) * 100;
    const distRes = ((resistance15m - fillPrice) / fillPrice) * 100;
    if (distSup >= 0 && distSup <= SR_PROXIMITY_PCT) { side = "LONG"; source = "sr_long"; }
    else if (distRes >= 0 && distRes <= SR_PROXIMITY_PCT) { side = "SHORT"; source = "sr_short"; }
  }
  if (!side || !source) return null;

  // SMART STACK gates (anh Tommy v4.3.87+):
  //   1. Max N OPEN cùng side
  //   2. Min spacing 10m giữa 2 entry CÙNG side
  //   3. Min distance 0.3% giữa entry mới và entry gần nhất cùng side (tránh nhồi 1 vùng)
  const sameSideOpen = acc.positions.filter((p) => p.status === "OPEN" && p.side === side);
  if (sameSideOpen.length >= STACK_MAX_PER_SIDE) return null;
  if (sameSideOpen.length > 0) {
    const lastSame = sameSideOpen.reduce((a, b) => (a.entryMs > b.entryMs ? a : b));
    if (now - lastSame.entryMs < STACK_PER_SIDE_SPACING_MS) return null;
    const distPct = Math.abs(fillPrice - lastSame.entryPrice) / lastSame.entryPrice * 100;
    if (distPct < STACK_MIN_ENTRY_DIST_PCT) return null;
  }

  const tpPrice = side === "LONG" ? fillPrice * (1 + TP_PCT / 100) : fillPrice * (1 - TP_PCT / 100);
  const slPrice = side === "LONG" ? fillPrice * (1 - SL_PCT / 100) : fillPrice * (1 + SL_PCT / 100);

  const pos: Position = {
    id: `bar5m-${bar5mTime}`,
    bar5mTime,
    status: "OPEN",
    side, source,
    entryPrice: fillPrice,
    entryMs: now,
    tpPrice, slPrice,
    entryFeeUsd: FEE_PER_SIDE,
  };
  acc.positions.unshift(pos);

  acc.capital -= FEE_PER_SIDE;
  acc.stats.totalFeeUsd += FEE_PER_SIDE;
  acc.stats.lastEntryMs = now;
  acc.equityHistory.push({ t: now, equity: acc.capital });
  if (acc.equityHistory.length > 1000) acc.equityHistory = acc.equityHistory.slice(-1000);
  await saveAccount(acc);
  return pos;
}

export async function processOpen(currentPrice: number): Promise<number> {
  const acc = await loadAccount();
  const now = Date.now();
  let closed = 0;
  for (const p of acc.positions) {
    if (p.status !== "OPEN") continue;
    let outcome: "WIN" | "LOSS" | null = null;
    let exitPrice = currentPrice;
    if (p.side === "LONG") {
      if (currentPrice >= p.tpPrice) { outcome = "WIN"; exitPrice = p.tpPrice; }
      else if (currentPrice <= p.slPrice) { outcome = "LOSS"; exitPrice = p.slPrice; }
    } else {
      if (currentPrice <= p.tpPrice) { outcome = "WIN"; exitPrice = p.tpPrice; }
      else if (currentPrice >= p.slPrice) { outcome = "LOSS"; exitPrice = p.slPrice; }
    }
    if (!outcome) continue;

    const rawPct = p.side === "LONG"
      ? ((exitPrice - p.entryPrice) / p.entryPrice) * 100
      : ((p.entryPrice - exitPrice) / p.entryPrice) * 100;
    let grossPnl = MARGIN_PER_TRADE * rawPct * LEVERAGE / 100;
    if (grossPnl < -MARGIN_PER_TRADE) grossPnl = -MARGIN_PER_TRADE;
    const exitFee = FEE_PER_SIDE;
    const netPnl = grossPnl - p.entryFeeUsd - exitFee;

    p.status = outcome;
    p.exitPrice = exitPrice;
    p.exitMs = now;
    p.exitFeeUsd = exitFee;
    p.pnlUsd = grossPnl;
    p.pnlNetUsd = netPnl;

    acc.capital += grossPnl - exitFee;
    acc.stats.totalClosed++;
    if (outcome === "WIN") acc.stats.wins++; else acc.stats.losses++;
    acc.stats.totalPnlUsd += netPnl;
    acc.stats.totalFeeUsd += exitFee;
    acc.equityHistory.push({ t: now, equity: acc.capital });
    closed++;
  }
  if (closed > 0) {
    if (acc.equityHistory.length > 1000) acc.equityHistory = acc.equityHistory.slice(-1000);
    await saveAccount(acc);
  }
  return closed;
}

/** Manual close 1 lệnh OPEN tại currentPrice (anh Tommy yêu cầu UI close riêng từng lệnh). */
export async function closePositionManual(positionId: string, currentPrice: number): Promise<boolean> {
  const acc = await loadAccount();
  const p = acc.positions.find((x) => x.id === positionId && x.status === "OPEN");
  if (!p) return false;
  const now = Date.now();
  const rawPct = p.side === "LONG"
    ? ((currentPrice - p.entryPrice) / p.entryPrice) * 100
    : ((p.entryPrice - currentPrice) / p.entryPrice) * 100;
  let grossPnl = MARGIN_PER_TRADE * rawPct * LEVERAGE / 100;
  if (grossPnl < -MARGIN_PER_TRADE) grossPnl = -MARGIN_PER_TRADE;
  const exitFee = FEE_PER_SIDE;
  const netPnl = grossPnl - p.entryFeeUsd - exitFee;
  p.status = grossPnl >= 0 ? "WIN" : "LOSS";
  p.exitPrice = currentPrice;
  p.exitMs = now;
  p.exitFeeUsd = exitFee;
  p.pnlUsd = grossPnl;
  p.pnlNetUsd = netPnl;
  acc.capital += grossPnl - exitFee;
  acc.stats.totalClosed++;
  if (p.status === "WIN") acc.stats.wins++; else acc.stats.losses++;
  acc.stats.totalPnlUsd += netPnl;
  acc.stats.totalFeeUsd += exitFee;
  acc.equityHistory.push({ t: now, equity: acc.capital });
  if (acc.equityHistory.length > 1000) acc.equityHistory = acc.equityHistory.slice(-1000);
  await saveAccount(acc);
  return true;
}

export interface AccountSummary {
  capital: number;
  equity: number;
  freeMargin: number;
  usedMargin: number;
  openCount: number;
  totalClosed: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnlUsd: number;
  totalFeeUsd: number;
  roi: number;
  cooldownRemainMs: number;
}

export function summarize(acc: All5mAccount): AccountSummary {
  const used = usedMargin(acc);
  const open = acc.positions.filter((p) => p.status === "OPEN").length;
  const wr = acc.stats.totalClosed > 0 ? (acc.stats.wins / acc.stats.totalClosed) * 100 : 0;
  const cooldownRemain = Math.max(0, acc.stats.lastEntryMs + COOLDOWN_MS - Date.now());
  return {
    capital: acc.capital,
    equity: acc.capital,
    freeMargin: acc.capital - used,
    usedMargin: used,
    openCount: open,
    totalClosed: acc.stats.totalClosed,
    wins: acc.stats.wins,
    losses: acc.stats.losses,
    winRate: wr,
    totalPnlUsd: acc.stats.totalPnlUsd,
    totalFeeUsd: acc.stats.totalFeeUsd,
    roi: ((acc.capital - INITIAL_CAPITAL) / INITIAL_CAPITAL) * 100,
    cooldownRemainMs: cooldownRemain,
  };
}
