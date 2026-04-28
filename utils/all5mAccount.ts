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
const PRESET_STORAGE_KEY = "@all5m_preset_v1";

// v4.7.20 (anh Tommy): bump $1000 → $5000 cho stack 75 (WHALE) khả thi
// — 75 LONG × $30 + 75 SHORT × $30 = $4500 max margin, $5000 đủ buffer.
// Migration: account cũ có flag `capitalVersion: 1` (or undefined) → top up +$4000 ONCE.
export const INITIAL_CAPITAL = 5000;
export const PREV_INITIAL_CAPITAL = 1000;
export const MARGIN_PER_TRADE = 30;
export const LEVERAGE = 100;
export const NOTIONAL = MARGIN_PER_TRADE * LEVERAGE;
export const FEE_PER_SIDE_PCT = 0.05;
export const FEE_PER_SIDE = NOTIONAL * (FEE_PER_SIDE_PCT / 100);
export const FEE_PER_TRADE = FEE_PER_SIDE * 2;

// Defaults (display fallback) — actual values dùng từ active preset
export const STOCH_LONG_LEVEL = 10;
export const STOCH_SHORT_LEVEL = 90;
export const COOLDOWN_MS = 10 * 60 * 1000;
export const SR_PROXIMITY_PCT = 0.3;
export const SR_LOOKBACK_15M = 50;
export const STACK_PER_SIDE_SPACING_MS = 10 * 60 * 1000;

// ════════════════════════════════════════════════════════════════════
// 🎯 PRESETS v3 (anh Tommy v4.8.22 — TURTLE removed, TOMI added)
//   3 chế độ switch trong UI:
//   - AGGRESSIVE 🔴 WHALE  → Highest PnL (3y backtest +$1.52M, MaxDD $5.9k)
//   - BALANCED   🟡 EAGLE  → Balanced     (3y backtest +$635k, MaxDD $1.98k)
//   - TOMI       🔵 TOMI   → Best risk-adjusted (3y backtest +$1.16M, MaxDD $1.1k, PF 3.52)
// ════════════════════════════════════════════════════════════════════

export type PresetKey = "AGGRESSIVE" | "BALANCED" | "TOMI";

export interface Preset {
  key: PresetKey;
  label: string;
  emoji: string;
  description: string;
  // Trade exit
  tpPct: number;
  slPct: number;
  // Stack gates
  stackMaxPerSide: number;
  stackMinEntryDistPct: number;
  stackPerSideSpacingMin: number;
  /** Better entry only mode (anh Tommy v4.7.27): "off" | "vs-last" | "vs-best" | "vs-avg" */
  stackBetterEntryMode?: "off" | "vs-last" | "vs-best" | "vs-avg";
  // Entry gates
  cooldownMin: number;
  stochLongLevel: number;
  stochShortLevel: number;
  srProximityPct: number;
  srLookback15m: number;
  /**
   * Trailing SL theo PnL% milestone (anh Tommy v4.8.22 — Tomi5mALL):
   * true → KHÔNG dùng fixed TP. Mỗi lần leveraged PnL% hit milestone N×100%,
   * SL update lên tương ứng (N-1)×100% PnL (lag 1 milestone = 1% raw price × 100x).
   * - PnL hit 100% → SL về 0% = breakeven
   * - PnL hit 200% → SL về 100%
   * - PnL hit N×100% → SL về (N-1)×100%
   * Không có fixed TP — vị thế chỉ đóng khi giá chạm SL.
   */
  trailingStopEnabled?: boolean;
  // Backtest expectations (3y)
  expectedNet3y: number;
  expectedMaxDd3y: number;
}

export const PRESETS: Record<PresetKey, Preset> = {
  // ─── TOMI (anh Tommy v4.8.22): Stoch K<5/K>95 + S/R 0.2% · TP+4% / SL-4% ───
  // Grid sweep 70 combo TP×SL → TP4/SL4 best NET/DD ratio (ratio 1014, 3y backtest).
  // SL rộng 4% để tránh bị quét sớm khi Stoch extreme thường có pullback trước.
  TOMI: {
    key: "TOMI", label: "TOMI", emoji: "🔵",
    description: "Extreme entry K<5/K>95 · TP+4%/SL-4%",
    tpPct: 4, slPct: 4,
    stackMaxPerSide: 50, stackMinEntryDistPct: 0, stackPerSideSpacingMin: 0,
    stackBetterEntryMode: "off",
    cooldownMin: 5,
    stochLongLevel: 5, stochShortLevel: 95,
    srProximityPct: 0.2, srLookback15m: 50,
    expectedNet3y: 1165062, expectedMaxDd3y: 1149,
  },
  AGGRESSIVE: {
    key: "AGGRESSIVE", label: "WHALE", emoji: "🔴",
    description: "Highest PnL · vốn lớn",
    tpPct: 5, slPct: 2.5,
    stackMaxPerSide: 75, stackMinEntryDistPct: 0, stackPerSideSpacingMin: 0,
    stackBetterEntryMode: "off",
    cooldownMin: 5,
    stochLongLevel: 10, stochShortLevel: 90,
    srProximityPct: 0.4, srLookback15m: 30,
    expectedNet3y: 1516473, expectedMaxDd3y: 5874,
  },
  BALANCED: {
    key: "BALANCED", label: "EAGLE", emoji: "🟡",
    description: "Balanced · vốn vừa",
    tpPct: 5, slPct: 2.5,
    stackMaxPerSide: 30, stackMinEntryDistPct: 0.1, stackPerSideSpacingMin: 10,
    stackBetterEntryMode: "off",
    cooldownMin: 5,
    stochLongLevel: 15, stochShortLevel: 85,
    srProximityPct: 0.4, srLookback15m: 50,
    expectedNet3y: 633753, expectedMaxDd3y: 1983,
  },

};

export const DEFAULT_PRESET_KEY: PresetKey = "BALANCED";

// Cache trong RAM để tryEntry5mBar không phải đọc AsyncStorage mỗi lần
let _activePresetCache: PresetKey | null = null;

export async function getActivePresetKey(): Promise<PresetKey> {
  if (_activePresetCache) return _activePresetCache;
  try {
    const raw = await AsyncStorage.getItem(PRESET_STORAGE_KEY);
    if (raw && (raw === "AGGRESSIVE" || raw === "BALANCED" || raw === "TOMI")) {
      _activePresetCache = raw;
      return raw;
    }
  } catch {}
  _activePresetCache = DEFAULT_PRESET_KEY;
  return DEFAULT_PRESET_KEY;
}

export async function setActivePresetKey(key: PresetKey): Promise<void> {
  _activePresetCache = key;
  await AsyncStorage.setItem(PRESET_STORAGE_KEY, key);
}

export async function getActivePreset(): Promise<Preset> {
  const k = await getActivePresetKey();
  return PRESETS[k];
}

/** Sync getter — dùng cho UI display (countdown) khi không await được. Trả về cached hoặc DEFAULT. */
export function getCachedActivePreset(): Preset {
  return PRESETS[_activePresetCache ?? DEFAULT_PRESET_KEY];
}

// Backward-compat: TP_PCT / SL_PCT / STACK_MAX_PER_SIDE / STACK_MIN_ENTRY_DIST_PCT
// vẫn export để code cũ (All5mPanel chart axis...) không vỡ. Giá trị = BALANCED preset.
export const TP_PCT = PRESETS.BALANCED.tpPct;
export const SL_PCT = PRESETS.BALANCED.slPct;
export const STACK_MAX_PER_SIDE = PRESETS.BALANCED.stackMaxPerSide;
export const STACK_MIN_ENTRY_DIST_PCT = PRESETS.BALANCED.stackMinEntryDistPct;

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
  /** Tomi5mALL: trailing SL active trên vị thế này */
  trailingStopEnabled?: boolean;
  /** Tomi5mALL: milestone PnL% cao nhất đã hit (0 = chưa trailing) */
  lastTrailMilestone?: number;
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
  /** v4.7.20 (anh Tommy): track migration cap $1k → $5k. undefined hoặc 1 = chưa migrate. */
  capitalVersion?: number;
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
    capitalVersion: 2, // mới = v2 (5000)
  };
}

export async function loadAccount(): Promise<All5mAccount> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyAccount();
    const p = JSON.parse(raw) as All5mAccount;
    if (p.version !== 1) return emptyAccount();
    if (!p.equityHistory) p.equityHistory = [{ t: p.updatedAt, equity: p.capital }];
    // ── Migration v1→v2 (anh Tommy v4.7.20): bump capital baseline $1k → $5k
    // Top up diff $4000 ONCE để mày không mất lệnh hiện tại.
    if (!p.capitalVersion || p.capitalVersion < 2) {
      const diff = INITIAL_CAPITAL - PREV_INITIAL_CAPITAL;
      p.capital += diff;
      p.capitalVersion = 2;
      p.equityHistory.push({ t: Date.now(), equity: p.capital });
      // Save migrated state
      try { await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(p)); } catch {}
    }
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
    // Leader push lên gist — debounce 20s (anh Tommy v4.5.3: 10s → 20s)
    scheduleFilePush(
      REMOTE_FILE,
      async () => acc,
      () => `data: 5m ALL · ${acc.positions.filter(p => p.status === "OPEN").length} open · cap $${acc.capital.toFixed(0)}`,
      20000,
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

  // Đọc active preset (cache RAM, gần như miễn phí sau lần đầu)
  const preset = await getActivePreset();

  if (now - acc.stats.lastEntryMs < preset.cooldownMin * 60 * 1000) return null;
  if (freeMargin(acc) < MARGIN_PER_TRADE) return null;

  let side: Side | null = null;
  let source: EntrySource | null = null;

  if (stoch5mK !== null && stoch5mK < preset.stochLongLevel) { side = "LONG"; source = "stoch_long"; }
  else if (stoch5mK !== null && stoch5mK > preset.stochShortLevel) { side = "SHORT"; source = "stoch_short"; }
  else if (support15m !== null && resistance15m !== null) {
    const distSup = ((fillPrice - support15m) / support15m) * 100;
    const distRes = ((resistance15m - fillPrice) / fillPrice) * 100;
    if (distSup >= 0 && distSup <= preset.srProximityPct) { side = "LONG"; source = "sr_long"; }
    else if (distRes >= 0 && distRes <= preset.srProximityPct) { side = "SHORT"; source = "sr_short"; }
  }
  if (!side || !source) return null;

  // SMART STACK gates — dùng PRESET đang active (anh Tommy v4.7.1):
  const sameSideOpen = acc.positions.filter((p) => p.status === "OPEN" && p.side === side);
  if (sameSideOpen.length >= preset.stackMaxPerSide) return null;
  if (sameSideOpen.length > 0) {
    const lastSame = sameSideOpen.reduce((a, b) => (a.entryMs > b.entryMs ? a : b));
    const spacingMs = preset.stackPerSideSpacingMin * 60 * 1000;
    if (spacingMs > 0 && now - lastSame.entryMs < spacingMs) return null;
    if (preset.stackMinEntryDistPct > 0) {
      const distPct = Math.abs(fillPrice - lastSame.entryPrice) / lastSame.entryPrice * 100;
      if (distPct < preset.stackMinEntryDistPct) return null;
    }
    // BETTER ENTRY ONLY (anh Tommy v4.7.27): entry mới tốt hơn benchmark cùng side
    if (preset.stackBetterEntryMode && preset.stackBetterEntryMode !== "off") {
      let benchmark: number;
      if (preset.stackBetterEntryMode === "vs-last") benchmark = lastSame.entryPrice;
      else if (preset.stackBetterEntryMode === "vs-best") {
        benchmark = side === "LONG"
          ? Math.min(...sameSideOpen.map((p) => p.entryPrice))
          : Math.max(...sameSideOpen.map((p) => p.entryPrice));
      } else { // vs-avg
        const sumQ = sameSideOpen.reduce((a, b) => a + 1, 0);  // 5m ALL qty không track sẵn — dùng count
        const sumE = sameSideOpen.reduce((a, b) => a + b.entryPrice, 0);
        benchmark = sumE / sumQ;
      }
      if (side === "LONG" && fillPrice >= benchmark) return null;
      if (side === "SHORT" && fillPrice <= benchmark) return null;
    }
  }

  const tpPrice = side === "LONG" ? fillPrice * (1 + preset.tpPct / 100) : fillPrice * (1 - preset.tpPct / 100);
  const slPrice = side === "LONG" ? fillPrice * (1 - preset.slPct / 100) : fillPrice * (1 + preset.slPct / 100);

  const pos: Position = {
    id: `bar5m-${bar5mTime}`,
    bar5mTime,
    status: "OPEN",
    side, source,
    entryPrice: fillPrice,
    entryMs: now,
    tpPrice, slPrice,
    entryFeeUsd: FEE_PER_SIDE,
    // Tomi5mALL: trailing SL per-position flag
    ...(preset.trailingStopEnabled ? { trailingStopEnabled: true, lastTrailMilestone: 0 } : {}),
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
  let trailMutated = false; // Tomi5mALL: SL updated but not closed → cần save

  for (const p of acc.positions) {
    if (p.status !== "OPEN") continue;
    let outcome: "WIN" | "LOSS" | null = null;
    let exitPrice = currentPrice;

    if (p.trailingStopEnabled) {
      // ── Tomi5mALL trailing SL milestone logic ──────────────────────────
      // leveragedPnlPct = raw price move % × 100x leverage
      const leveragedPnlPct = (p.side === "LONG"
        ? (currentPrice - p.entryPrice) / p.entryPrice
        : (p.entryPrice - currentPrice) / p.entryPrice) * 100 * LEVERAGE;
      const milestone = Math.max(0, Math.floor(leveragedPnlPct / 100));
      const lastMilestone = p.lastTrailMilestone ?? 0;

      if (milestone > lastMilestone && milestone >= 1) {
        // SL ratchet: milestone N → SL tại (N-1)×100% PnL
        // trailRawPct = (milestone - 1) / LEVERAGE  (raw price %)
        const trailRawPct = (milestone - 1) / LEVERAGE;
        const newSl = p.side === "LONG"
          ? p.entryPrice * (1 + trailRawPct)
          : p.entryPrice * (1 - trailRawPct);
        // Chỉ dịch SL theo hướng có lợi — không bao giờ lùi SL lại
        if (p.side === "LONG" && newSl > p.slPrice) { p.slPrice = newSl; trailMutated = true; }
        if (p.side === "SHORT" && newSl < p.slPrice) { p.slPrice = newSl; trailMutated = true; }
        p.lastTrailMilestone = milestone;
      }

      // Chỉ exit qua SL (không có TP cố định)
      // WIN nếu SL đã trail lên trên entry (profitable), LOSS nếu dưới entry
      if (p.side === "LONG" && currentPrice <= p.slPrice) {
        outcome = p.slPrice >= p.entryPrice ? "WIN" : "LOSS";
        exitPrice = p.slPrice;
      } else if (p.side === "SHORT" && currentPrice >= p.slPrice) {
        outcome = p.slPrice <= p.entryPrice ? "WIN" : "LOSS";
        exitPrice = p.slPrice;
      }
    } else {
      // ── Normal fixed TP / SL ──────────────────────────────────────────
      if (p.side === "LONG") {
        if (currentPrice >= p.tpPrice) { outcome = "WIN"; exitPrice = p.tpPrice; }
        else if (currentPrice <= p.slPrice) { outcome = "LOSS"; exitPrice = p.slPrice; }
      } else {
        if (currentPrice <= p.tpPrice) { outcome = "WIN"; exitPrice = p.tpPrice; }
        else if (currentPrice >= p.slPrice) { outcome = "LOSS"; exitPrice = p.slPrice; }
      }
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
  if (closed > 0 || trailMutated) {
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
  const cdMs = getCachedActivePreset().cooldownMin * 60 * 1000;
  const cooldownRemain = Math.max(0, acc.stats.lastEntryMs + cdMs - Date.now());
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
