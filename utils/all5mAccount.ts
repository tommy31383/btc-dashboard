/**
 * all5mAccount — paper-trading account cho tab "5m All".
 *
 * Spec (v4.8.23 — stack-sweep winner picks, xem 5MALL_TRADING_RULES.md):
 *   - 5m closed bar → quyết định ngay (không có PENDING phase như 15mALL)
 *   - StochRSI 5m K<stochLongLevel → LONG; K>stochShortLevel → SHORT (per preset)
 *   - Else fallback S/R 15m: close gần support (≤srProximityPct%) → LONG / resistance → SHORT
 *   - TP/SL theo active preset (WHALE 5/2.5, TOMI 4/4)
 *   - Capital $5000 (v4.7.20 bump từ $1000), margin $30 × 100x, fee 0.05%/side ($1.5/side)
 *   - Hedge mode: LONG + SHORT độc lập, có thể coexist; vào song song nhiều lệnh
 *   - 5 preset switch: WHALE_MAX/MID + TOMI_MAX/MID/MIN (default TOMI_MID — PF 3.55, DD 0.2%)
 *   - Local PC + gist mirror (leader/follower pattern)
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import { pullFile, scheduleFilePush } from "./gistSync";

const STORAGE_KEY = "@all5m_data_v1";
const REMOTE_FILE = "all5m_account.json";
const PRESET_STORAGE_KEY = "@all5m_preset_v1";
const LOCAL_SAVE_DEBOUNCE_MS = 750;
const MOBILE_STACK_CAP_PER_SIDE = 50;

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
// 🎯 PRESETS v5 (anh Tommy v4.8.24 — TPSL_GRID_v1 SHORTLIST_v1, 10 picks)
//   Source: assets/preset_shortlist_v1.json (curated từ 280-combo TP/SL grid 3y).
//   Composite rank = avg of (NET/MaxDD/WR/PF) ranks · thấp = tốt hơn.
//   Naming: 3 LEGACY keys giữ nguyên (current prod) + 7 NEW keys với suffix TP/SL.
//
//   Top 4 (composite < 4) — đáng adopt:
//   - WHALE_MAX_48 🔴 WHALE 4/8     → 3.25 ⭐ overall winner (high-WR yolo)
//   - WHALE_MAX_66 🔴 WHALE 6/6     → 3.75 ⭐ MAIN (top NET + DD<1%) ★ DEFAULT
//   - WHALE_MAX_38 🔴 WHALE 3/8     → 3.75 (top WR 72%)
//   - WHALE_MAX_88 🔴 WHALE 8/8     → 4.00 (min DD 0.14%)
//   Mid (composite 4-6):
//   - WHALE_MID_66 🟠 mid 6/6       → 4.25 (mid balanced stack 100)
//   - TOMI_MAX_55  🔵 TOMI 5/5      → 5.50 (TOMI 200 stable)
//   - TOMI_MIN_66  ⚪ TOMI 50 6/6   → 5.75 (starter cực bảo thủ)
//   Legacy production (kept for compat — composite 6.75-9.50, kém hơn alternatives):
//   - TOMI_MAX     🔵 TOMI 4/4      → 6.75 (legacy)
//   - WHALE_MAX    🔴 WHALE 5/2.5   → 8.50 (legacy, DD 8% tệ)
//   - WHALE_MID    🟠 WHALE 5/2.5   → 9.50 (legacy, last place)
// ════════════════════════════════════════════════════════════════════

export type PresetKey =
  | "WHALE_MAX_66" | "WHALE_MAX_48" | "WHALE_MAX_38" | "WHALE_MAX_88"
  | "TOMI_MAX_55" | "WHALE_MID_66" | "TOMI_MIN_66"
  | "WHALE_MAX" | "WHALE_MID" | "TOMI_MAX"; // 3 legacy current prod

const VALID_KEYS: PresetKey[] = [
  "WHALE_MAX_66", "WHALE_MAX_48", "WHALE_MAX_38", "WHALE_MAX_88",
  "TOMI_MAX_55", "WHALE_MID_66", "TOMI_MIN_66",
  "WHALE_MAX", "WHALE_MID", "TOMI_MAX",
];

/** Migration map: legacy key (v4.8.23 trở về trước) → v4.8.24 key gần nhất.
 *  TOMI_MID/TOMI_MIN cũ (4/4) bị bỏ — map sang upgraded variants. */
const LEGACY_KEY_MAP: Record<string, PresetKey> = {
  AGGRESSIVE: "WHALE_MAX",      // giữ current legacy (5/2.5)
  BALANCED:   "WHALE_MAX_66",   // upgrade lên ⭐ MAIN
  TURTLE:     "TOMI_MIN_66",    // upgrade từ TURTLE cũ → TOMI_MIN 6/6
  TOMI:       "TOMI_MIN_66",
  TOMI_MID:   "WHALE_MID_66",   // TOMI_MID 4/4 cũ → WHALE_MID 6/6 (cùng stack 100, NET cao hơn)
  TOMI_MIN:   "TOMI_MIN_66",    // upgrade 4/4 → 6/6 (NET cao hơn, DD thấp hơn)
};

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

function isNativeMobileRuntime(): boolean {
  return Platform.OS === "android" || Platform.OS === "ios";
}

// ─── Helper: WHALE base config (stoch 10/90, srProx 0.4, srLB 30) ──────
const WHALE_BASE = {
  stackBetterEntryMode: "off" as const,
  cooldownMin: 5,
  stochLongLevel: 10, stochShortLevel: 90,
  srProximityPct: 0.4, srLookback15m: 30,
  stackMinEntryDistPct: 0, stackPerSideSpacingMin: 0,
};
// ─── Helper: TOMI base config (stoch 5/95, srProx 0.2, srLB 50) ────────
const TOMI_BASE = {
  stackBetterEntryMode: "off" as const,
  cooldownMin: 5,
  stochLongLevel: 5, stochShortLevel: 95,
  srProximityPct: 0.2, srLookback15m: 50,
  stackMinEntryDistPct: 0, stackPerSideSpacingMin: 0,
};

export const PRESETS: Record<PresetKey, Preset> = {
  // ════════════ 7 CANDIDATE từ TPSL_GRID_v1 (composite rank thấp = tốt) ═══════════

  // ─── #1 ⭐ MAIN: WHALE_MAX 6/6 (composite 3.75) ──────────────────────────
  WHALE_MAX_66: {
    key: "WHALE_MAX_66", label: "WHALE 6/6 ⭐", emoji: "🔴",
    description: "MAIN ⭐ · Top NET với DD<1% · NET $4.09M, DD 0.87% (TPSL_GRID_v1)",
    tpPct: 6, slPct: 6,
    stackMaxPerSide: 200, ...WHALE_BASE,
    expectedNet3y: 4090815, expectedMaxDd3y: 2772,
  },
  // ─── #2 high-WR yolo: WHALE_MAX 4/8 (composite 3.25 — overall winner) ──
  WHALE_MAX_48: {
    key: "WHALE_MAX_48", label: "WHALE 4/8", emoji: "🔴",
    description: "High-WR yolo · NET $3.91M, WR 65.9%, DD 0.39%",
    tpPct: 4, slPct: 8,
    stackMaxPerSide: 200, ...WHALE_BASE,
    expectedNet3y: 3911061, expectedMaxDd3y: 6534,
  },
  // ─── #3 top WR: WHALE_MAX 3/8 (composite 3.75) ──────────────────────────
  WHALE_MAX_38: {
    key: "WHALE_MAX_38", label: "WHALE 3/8", emoji: "🔴",
    description: "Top WR 72% · NET $3.87M, dễ tâm lý",
    tpPct: 3, slPct: 8,
    stackMaxPerSide: 200, ...WHALE_BASE,
    expectedNet3y: 3873390, expectedMaxDd3y: 6534,
  },
  // ─── #4 min DD yolo: WHALE_MAX 8/8 (composite 4.00) ─────────────────────
  WHALE_MAX_88: {
    key: "WHALE_MAX_88", label: "WHALE 8/8", emoji: "🔴",
    description: "Min DD yolo · NET $3.65M, DD chỉ 0.14%, PF 7.18",
    tpPct: 8, slPct: 8,
    stackMaxPerSide: 200, ...WHALE_BASE,
    expectedNet3y: 3648270, expectedMaxDd3y: 2970,
  },
  // ─── #5 mid balanced: WHALE_MID 6/6 (composite 4.25) ────────────────────
  WHALE_MID_66: {
    key: "WHALE_MID_66", label: "WHALE 100 6/6", emoji: "🟠",
    description: "Mid balanced · NET $2.31M, DD 0.10% · stack 100",
    tpPct: 6, slPct: 6,
    stackMaxPerSide: 100, ...WHALE_BASE,
    expectedNet3y: 2305122, expectedMaxDd3y: 1683,
  },
  // ─── #6 TOMI 200 stable: TOMI_MAX 5/5 (composite 5.50) ──────────────────
  TOMI_MAX_55: {
    key: "TOMI_MAX_55", label: "TOMI 200 5/5", emoji: "🔵",
    description: "TOMI 200 stable · NET $3.05M, DD 0.10%",
    tpPct: 5, slPct: 5,
    stackMaxPerSide: 200, ...TOMI_BASE,
    expectedNet3y: 3050910, expectedMaxDd3y: 2385,
  },
  // ─── #7 starter: TOMI_MIN 6/6 (composite 5.75) ──────────────────────────
  TOMI_MIN_66: {
    key: "TOMI_MIN_66", label: "TOMI 50 6/6", emoji: "⚪",
    description: "Starter cực bảo thủ · NET $1.15M, MaxDD chỉ $957",
    tpPct: 6, slPct: 6,
    stackMaxPerSide: 50, ...TOMI_BASE,
    expectedNet3y: 1145433, expectedMaxDd3y: 957,
  },

  // ════════════ 3 LEGACY current production (kept cho rollback) ════════════════

  // ─── Legacy WHALE_MAX 5/2.5 (composite 8.50 — DD tệ) ────────────────────
  WHALE_MAX: {
    key: "WHALE_MAX", label: "WHALE 5/2.5 (legacy)", emoji: "🔴",
    description: "LEGACY current · NET $3.03M nhưng DD 8.0% (kém alternatives)",
    tpPct: 5, slPct: 2.5,
    stackMaxPerSide: 200, ...WHALE_BASE,
    expectedNet3y: 3028056, expectedMaxDd3y: 15627,
  },
  // ─── Legacy WHALE_MID 5/2.5 (composite 9.50 — last place) ──────────────
  WHALE_MID: {
    key: "WHALE_MID", label: "WHALE 100 5/2.5 (legacy)", emoji: "🟠",
    description: "LEGACY current · NET $1.89M, DD 2.59%",
    tpPct: 5, slPct: 2.5,
    stackMaxPerSide: 100, ...WHALE_BASE,
    expectedNet3y: 1888767, expectedMaxDd3y: 7359,
  },
  // ─── Legacy TOMI_MAX 4/4 (composite 6.75) ───────────────────────────────
  TOMI_MAX: {
    key: "TOMI_MAX", label: "TOMI 200 4/4 (legacy)", emoji: "🔵",
    description: "LEGACY current · NET $2.63M, DD 0.28%, symmetric",
    tpPct: 4, slPct: 4,
    stackMaxPerSide: 200, ...TOMI_BASE,
    expectedNet3y: 2633499, expectedMaxDd3y: 2424,
  },
};

// Default = WHALE_MAX_66 ⭐ MAIN (composite 3.75, NET $4.09M, DD 0.87%).
// Anh muốn safer → switch TOMI_MIN_66 (composite 5.75, MaxDD chỉ $957).
export const DEFAULT_PRESET_KEY: PresetKey = "WHALE_MAX_66";
export const MOBILE_DEFAULT_PRESET_KEY: PresetKey = "TOMI_MIN_66";

export function getEffectivePreset(key: PresetKey): Preset {
  const base = PRESETS[key];
  if (!isNativeMobileRuntime()) return base;
  return {
    ...base,
    stackMaxPerSide: Math.min(base.stackMaxPerSide, MOBILE_STACK_CAP_PER_SIDE),
  };
}

// Cache trong RAM để tryEntry5mBar không phải đọc AsyncStorage mỗi lần
let _activePresetCache: PresetKey | null = null;
let _accountCache: All5mAccount | null = null;
let _localSaveTimer: ReturnType<typeof setTimeout> | null = null;

export async function getActivePresetKey(): Promise<PresetKey> {
  if (_activePresetCache) return _activePresetCache;
  try {
    const raw = await AsyncStorage.getItem(PRESET_STORAGE_KEY);
    if (raw) {
      // Hit on new key
      if ((VALID_KEYS as string[]).includes(raw)) {
        _activePresetCache = raw as PresetKey;
        return _activePresetCache;
      }
      // Migration: legacy key → map sang key v4.8.20 gần nhất + persist lại
      const migrated = LEGACY_KEY_MAP[raw];
      if (migrated) {
        _activePresetCache = migrated;
        try { await AsyncStorage.setItem(PRESET_STORAGE_KEY, migrated); } catch {}
        return migrated;
      }
    }
  } catch {}
  _activePresetCache = isNativeMobileRuntime() ? MOBILE_DEFAULT_PRESET_KEY : DEFAULT_PRESET_KEY;
  return _activePresetCache;
}

export async function setActivePresetKey(key: PresetKey): Promise<void> {
  _activePresetCache = key;
  await AsyncStorage.setItem(PRESET_STORAGE_KEY, key);
}

export async function getActivePreset(): Promise<Preset> {
  const k = await getActivePresetKey();
  return getEffectivePreset(k);
}

/** Sync getter — dùng cho UI display (countdown) khi không await được. Trả về cached hoặc DEFAULT. */
export function getCachedActivePreset(): Preset {
  const key = _activePresetCache ?? (isNativeMobileRuntime() ? MOBILE_DEFAULT_PRESET_KEY : DEFAULT_PRESET_KEY);
  return getEffectivePreset(key);
}

// Backward-compat: TP_PCT / SL_PCT / STACK_MAX_PER_SIDE / STACK_MIN_ENTRY_DIST_PCT
// vẫn export để code cũ (All5mPanel chart axis...) không vỡ. Giá trị = DEFAULT preset (WHALE_MAX_66).
export const TP_PCT = PRESETS.WHALE_MAX_66.tpPct;
export const SL_PCT = PRESETS.WHALE_MAX_66.slPct;
export const STACK_MAX_PER_SIDE = PRESETS.WHALE_MAX_66.stackMaxPerSide;
export const STACK_MIN_ENTRY_DIST_PCT = PRESETS.WHALE_MAX_66.stackMinEntryDistPct;

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
  if (_accountCache) return _accountCache;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const fresh = emptyAccount();
      _accountCache = fresh;
      return fresh;
    }
    const p = JSON.parse(raw) as All5mAccount;
    if (p.version !== 1) {
      const fresh = emptyAccount();
      _accountCache = fresh;
      return fresh;
    }
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
    _accountCache = p;
    return p;
  } catch {
    const fresh = emptyAccount();
    _accountCache = fresh;
    return fresh;
  }
}

function isAll5mAccount(v: unknown): v is All5mAccount {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return o.version === 1 && typeof o.capital === "number" && Array.isArray(o.positions);
}

function scheduleLocalSave(acc: All5mAccount, immediate: boolean = false): void {
  const write = () => {
    _localSaveTimer = null;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(acc)).catch(() => {});
  };
  if (immediate) {
    if (_localSaveTimer) {
      clearTimeout(_localSaveTimer);
      _localSaveTimer = null;
    }
    write();
    return;
  }
  if (_localSaveTimer) clearTimeout(_localSaveTimer);
  _localSaveTimer = setTimeout(write, LOCAL_SAVE_DEBOUNCE_MS);
}

export async function saveAccount(acc: All5mAccount, opts: { sync?: boolean; immediateLocalSave?: boolean } = {}): Promise<void> {
  acc.updatedAt = Date.now();
  _accountCache = acc;
  scheduleLocalSave(acc, opts.immediateLocalSave === true);
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
  _accountCache = remote;
  scheduleLocalSave(remote, true);
  return remote;
}

export async function resetAccount(): Promise<All5mAccount> {
  const fresh = emptyAccount();
  _accountCache = fresh;
  scheduleLocalSave(fresh, true);
  await saveAccount(fresh, { immediateLocalSave: true }); // sync gist luôn
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
      // ⚠️ DEAD CODE PATH (v4.8.23): TẤT CẢ 5 preset hiện tại đều KHÔNG set
      // trailingStopEnabled=true → branch này không được run trong production.
      // Logic giữ lại để Tommy re-enable cho preset cụ thể khi backtest đủ.
      // Decision log: bỏ trailing để TP4/SL4 fixed consistency với WHALE TP5/SL2.5.
      // Xem 5MALL_TRADING_RULES.md section "TRAILING STOP" để chi tiết.
      // ────────────────────────────────────────────────────────────────────
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
