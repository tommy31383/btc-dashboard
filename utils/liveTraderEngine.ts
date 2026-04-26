/**
 * liveTraderEngine.ts — Auto-trade engine wrap quanh Binance Live.
 *
 * Phase 1: DRY RUN — log lệnh ra journal, KHÔNG gửi POST thật.
 * Phase 2: real orders (chuyển dryRun=false).
 *
 * Settings configurable + sync qua GitHub Contents API (file `live_trading.json`).
 * API key/secret CHỈ lưu local AsyncStorage, KHÔNG sync.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  Credentials, notionalToQty, placeMarketOrder, placeStopMarket, placeTakeProfitMarket, setLeverage,
} from "./binanceLive";
import { pullFile, scheduleFilePush } from "./gistSync";
import { notify, playSlHit, playTpHit, playEntry } from "./liveAlerts";

const STORAGE_KEY = "@live_trader_v2";
const SECRET_KEY = "@live_trader_secret_v1";
const REMOTE_FILE = "live_trading.json";

export interface LiveSettings {
  symbol: string;
  leverage: number;
  marginUsd: number;
  maxOpen: number;
  dailyLossCapUsd: number;     // âm, vd -15
  cooldownMinutes: number;
  excludedTfs: string[];        // ["5m"] etc
  // LTF confirm (Phase 2): khi rule HTF fire → đợi LTF confirm trước khi vào lệnh
  confirmStochOsLevel: number;   // K < N → confirm LONG (default 20)
  confirmStochObLevel: number;   // K > N → confirm SHORT (default 80)
  confirmSrProximityPct: number; // close ≤ N% từ S/R → confirm (default 0.4)
  // SMART STACK (anh Tommy v4.3.87+): cho phép nhiều lệnh cùng side, mỗi lệnh TP/SL riêng
  stackMaxPerSide: number;          // tối đa N lệnh cùng side (default 15)
  stackPerSideSpacingMin: number;   // tối thiểu N phút giữa 2 entry CÙNG side (default 10)
  stackMinEntryDistPct: number;     // entry mới xa entry gần nhất cùng side ≥ N% (default 0.3)
  /** Tổng notional (USD) cap CÙNG side — chống liquidation khi nhồi nhiều lệnh small qty (v4.4.8+) */
  stackMaxNotionalUsd: number;      // default 50000 = block nếu sum notional cùng side > 50k
}

/** Hard timeouts to prevent state from growing unbounded if data feeds stall. */
const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;       // 24h
const TRACKED_POSITION_MAX_AGE_MS = 72 * 60 * 60 * 1000; // 72h

/** SMART STACK defaults — chỉ dùng khi settings chưa migrate (loadState merge với DEFAULT_SETTINGS). */

export const DEFAULT_SETTINGS: LiveSettings = {
  symbol: "BTCUSDT",
  leverage: 100,
  marginUsd: 1,
  maxOpen: 30,
  dailyLossCapUsd: -15,
  cooldownMinutes: 60,
  excludedTfs: ["5m"],
  confirmStochOsLevel: 20,
  confirmStochObLevel: 80,
  confirmSrProximityPct: 0.4,
  stackMaxPerSide: 15,
  stackPerSideSpacingMin: 10,
  stackMinEntryDistPct: 0.3,
  stackMaxNotionalUsd: 50000,
};

export type LiveAction =
  | { kind: "ENTRY"; side: "LONG" | "SHORT"; entryPrice: number; tpPrice: number; slPrice: number; qty: number; confirmedBy?: string }
  | { kind: "CLOSE"; side: "LONG" | "SHORT"; closePrice: number; qty: number; trigger: "TP" | "SL" }
  | { kind: "PENDING"; side: "LONG" | "SHORT"; htfEntryPrice: number; tpPct: number; slPct: number }
  | { kind: "DISCARD"; reason: string }
  | { kind: "BLOCK"; reason: string }
  | { kind: "ERROR"; message: string };

/** Alert HTF đang chờ LTF confirm. TP/SL pct lưu raw để recalc theo entry price khi confirm. */
export interface PendingAlert {
  id: string;
  tfKey: string;
  side: "LONG" | "SHORT";
  htfEntryPrice: number;       // price tại lúc HTF fire (info)
  tpPct: number;               // raw % từ rule
  slPct: number;               // raw %
  addedMs: number;
}

export interface TrackedPosition {
  id: string;
  side: "LONG" | "SHORT";
  qty: number;
  entryPrice: number;
  tpPrice: number;
  slPrice: number;
  entryMs: number;
}

export interface LiveJournalEntry {
  ts: number;
  ruleId: string;
  tfKey: string;
  action: LiveAction;
  dryRun: boolean;
}

/** Snapshot từ Binance API — leader push để follower mirror (không cần API key trên follower). */
export interface BinanceSnapshot {
  ts: number;                       // lúc snapshot (ms)
  account: any | null;              // AccountSnapshot — typed lỏng để khỏi cycle import
  positions: any[];                 // PositionRisk[]
  openOrders: any[];                // OpenOrder[]
  recentTrades: any[];              // UserTrade[] (top 50)
  dailyPnl: number;
}

/** State sync qua gist (KHÔNG có apiKey/secret) */
export interface LiveSyncState {
  settings: LiveSettings;
  autoEnabled: boolean;
  dryRun: boolean;
  pausedUntilMs: number;
  leverageSetForSession: boolean;
  hedgeMode: boolean;       // detect từ /fapi/v1/positionSide/dual
  journal: LiveJournalEntry[];
  firedIds: Record<string, number>;
  /** App tự monitor TP/SL (Plan B) — list các position đã mở chờ close khi giá hit */
  trackedPositions: TrackedPosition[];
  /** HTF rule fire → đợi LTF confirm (Phase 2) */
  pendingAlerts: PendingAlert[];
  /** Snapshot Binance — leader poll xong push, follower đọc render */
  binanceSnapshot?: BinanceSnapshot;
}

/** Full state in-memory (sync state + secrets) */
export interface LiveTraderState extends LiveSyncState {
  apiKey: string;
  apiSecret: string;
}

export function emptySyncState(): LiveSyncState {
  return {
    settings: DEFAULT_SETTINGS,
    autoEnabled: false,
    dryRun: true,
    pausedUntilMs: 0,
    leverageSetForSession: false,
    hedgeMode: false,
    journal: [],
    firedIds: {},
    trackedPositions: [],
    pendingAlerts: [],
    binanceSnapshot: undefined,
  };
}

export function emptyState(): LiveTraderState {
  return { ...emptySyncState(), apiKey: "", apiSecret: "" };
}

// ── Persistence ────────────────────────────────────────────────────────────

export async function loadState(): Promise<LiveTraderState> {
  try {
    const [rawSync, rawSecret] = await Promise.all([
      AsyncStorage.getItem(STORAGE_KEY),
      AsyncStorage.getItem(SECRET_KEY),
    ]);
    const sync = rawSync ? { ...emptySyncState(), ...JSON.parse(rawSync) } : emptySyncState();
    // Settings có thể bị stale nếu schema đổi → merge with default
    sync.settings = { ...DEFAULT_SETTINGS, ...(sync.settings || {}) };
    const secret = rawSecret ? JSON.parse(rawSecret) : { apiKey: "", apiSecret: "" };
    return { ...sync, apiKey: secret.apiKey || "", apiSecret: secret.apiSecret || "" };
  } catch {
    return emptyState();
  }
}

function trimJournal(s: LiveSyncState): LiveSyncState {
  if (s.journal.length > 500) s.journal = s.journal.slice(-500);
  return s;
}

export async function saveState(s: LiveTraderState, opts: { sync?: boolean } = {}): Promise<void> {
  const { apiKey, apiSecret, ...sync } = s;
  trimJournal(sync);
  try { await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(sync)); } catch {}
  try { await AsyncStorage.setItem(SECRET_KEY, JSON.stringify({ apiKey, apiSecret })); } catch {}
  if (opts.sync !== false) {
    scheduleFilePush(
      REMOTE_FILE,
      async () => sync,
      () => `live: update settings/journal (${new Date().toISOString().slice(0, 16)})`,
      12000, // anh Tommy v4.5.3: 6s → 12s
    );
  }
}

/** Pull remote sync state & merge journal entries (union by ts+ruleId).
 *  Mode "leader": chỉ merge journal + firedIds, KHÔNG đụng pendingAlerts/trackedPositions
 *    (leader có local state authoritative).
 *  Mode "follower": leader là nguồn truth → MIRROR trackedPositions + pendingAlerts từ remote.
 *  Mode "boot" (default): merge journal nhưng ưu tiên local state — cho lần load đầu, chưa biết role.
 */
export async function pullRemote(
  local: LiveTraderState,
  mode: "leader" | "follower" | "boot" = "boot",
): Promise<LiveTraderState> {
  const remote = await pullFile<LiveSyncState>(REMOTE_FILE);
  if (!remote) return local;
  const seen = new Set(local.journal.map((j) => `${j.ts}|${j.ruleId}|${j.action.kind}`));
  const merged = [...local.journal];
  for (const r of remote.journal || []) {
    const k = `${r.ts}|${r.ruleId}|${r.action.kind}`;
    if (!seen.has(k)) merged.push(r);
  }
  merged.sort((a, b) => a.ts - b.ts);
  const base: LiveTraderState = {
    ...local,
    settings: { ...DEFAULT_SETTINGS, ...(remote.settings || local.settings) },
    autoEnabled: remote.autoEnabled ?? local.autoEnabled,
    dryRun: remote.dryRun ?? local.dryRun,
    pausedUntilMs: Math.max(local.pausedUntilMs, remote.pausedUntilMs || 0),
    journal: merged,
    firedIds: { ...local.firedIds, ...(remote.firedIds || {}) },
  };
  if (mode === "follower") {
    // Mirror leader's authoritative lists — follower KHÔNG được tự sửa.
    return {
      ...base,
      trackedPositions: remote.trackedPositions || [],
      pendingAlerts: remote.pendingAlerts || [],
      binanceSnapshot: remote.binanceSnapshot,
    };
  }
  return base;
}

// ── Decision + Execution ───────────────────────────────────────────────────

export async function logAction(
  s: LiveTraderState,
  ruleId: string,
  tfKey: string,
  action: LiveAction,
): Promise<LiveTraderState> {
  const next = { ...s, journal: [...s.journal, { ts: Date.now(), ruleId, tfKey, action, dryRun: s.dryRun }] };
  await saveState(next);
  return next;
}

export interface AlertInput {
  id: string;
  tfKey: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  tpPrice: number;
  slPrice: number;
  firedAt: number;
  /** Raw % từ rule.config — dùng để recalc TP/SL theo entry price khi LTF confirm */
  tpPct: number;
  slPct: number;
}

/**
 * decideEntry: Phase 2 — không vào lệnh ngay. Chỉ check basic gate; pass → push vào pendingAlerts.
 * ENTRY thực sự chỉ fire qua confirmPending() khi LTF condition đạt.
 */
/**
 * SMART STACK gate — kiểm tra giới hạn per-side cho 1 alert (LONG/SHORT).
 * Trả về null nếu pass; trả về reason nếu block.
 *
 * Áp dụng dựa trên `trackedPositions` (virtual lệnh app đang theo dõi TP/SL),
 * KHÔNG dựa trên Binance position aggregated.
 */
export function checkStackGate(
  s: LiveTraderState,
  side: "LONG" | "SHORT",
  entryPrice: number,
  nowMs: number,
): string | null {
  const cfg = s.settings;
  const maxPerSide = cfg.stackMaxPerSide;
  const spacingMs = cfg.stackPerSideSpacingMin * 60_000;
  const minDistPct = cfg.stackMinEntryDistPct;
  const maxNotionalUsd = cfg.stackMaxNotionalUsd;
  const sameSide = s.trackedPositions.filter((p) => p.side === side);
  if (sameSide.length >= maxPerSide) {
    return `stack full ${sameSide.length}/${maxPerSide} ${side}`;
  }
  // Notional cap CÙNG side — chống liquidation
  if (maxNotionalUsd > 0) {
    const currentNotional = sameSide.reduce((sum, p) => sum + p.qty * p.entryPrice, 0);
    const newOrderNotional = cfg.marginUsd * cfg.leverage;
    if (currentNotional + newOrderNotional > maxNotionalUsd) {
      return `stack notional cap ${side}: current $${currentNotional.toFixed(0)} + new $${newOrderNotional.toFixed(0)} > $${maxNotionalUsd} (chống liquidation)`;
    }
  }
  if (sameSide.length > 0) {
    const lastSame = sameSide.reduce((a, b) => (a.entryMs > b.entryMs ? a : b));
    if (nowMs - lastSame.entryMs < spacingMs) {
      const leftMin = Math.ceil((spacingMs - (nowMs - lastSame.entryMs)) / 60000);
      return `stack spacing ${leftMin}m left (last ${side} ${new Date(lastSame.entryMs).toLocaleTimeString()})`;
    }
    const distPct = Math.abs(entryPrice - lastSame.entryPrice) / lastSame.entryPrice * 100;
    if (distPct < minDistPct) {
      return `stack price too close (${distPct.toFixed(2)}% < ${minDistPct}%) to last ${side} @${lastSame.entryPrice.toFixed(2)}`;
    }
  }
  return null;
}

export function decideEntry(
  s: LiveTraderState,
  alert: AlertInput,
  ctx: { dailyPnl: number; openCount: number; nowMs: number },
): LiveAction {
  const cfg = s.settings;
  if (!s.autoEnabled) return { kind: "BLOCK", reason: "auto OFF" };
  if (cfg.excludedTfs.includes(alert.tfKey)) return { kind: "BLOCK", reason: `TF ${alert.tfKey} excluded` };
  if (ctx.nowMs < s.pausedUntilMs) {
    const left = Math.ceil((s.pausedUntilMs - ctx.nowMs) / 60000);
    return { kind: "BLOCK", reason: `paused (cooldown ${left}m)` };
  }
  if (ctx.dailyPnl <= cfg.dailyLossCapUsd) {
    return { kind: "BLOCK", reason: `daily loss cap hit ($${ctx.dailyPnl.toFixed(2)})` };
  }
  if (ctx.openCount >= cfg.maxOpen) {
    return { kind: "BLOCK", reason: `max open ${cfg.maxOpen} reached` };
  }
  // Per-rule cooldown 10 phút (sau lần ENTRY thật)
  const PER_RULE_COOLDOWN_MS = 10 * 60_000;
  const lastFire = s.firedIds[alert.id];
  if (lastFire && ctx.nowMs - lastFire < PER_RULE_COOLDOWN_MS) {
    const leftMin = Math.ceil((PER_RULE_COOLDOWN_MS - (ctx.nowMs - lastFire)) / 60000);
    return { kind: "BLOCK", reason: `per-rule cooldown ${leftMin}m (rule ${alert.id})` };
  }
  // Đã pending rồi → skip
  if (s.pendingAlerts.some((p) => p.id === alert.id && p.side === alert.side)) {
    return { kind: "BLOCK", reason: `already pending (rule ${alert.id})` };
  }
  // SMART STACK gate (per side: max 15, spacing 10m, min dist 0.3%)
  const stackBlock = checkStackGate(s, alert.side, alert.entryPrice, ctx.nowMs);
  if (stackBlock) return { kind: "BLOCK", reason: stackBlock };
  // Anh Tommy v4.6.7 (PA A2): rule 5m + 15m KHÔNG qua Phase 2 LTF confirm
  // (backtest-compare-3y.ts cho thấy 15m LTF confirm tệ hơn NORMAL ~5k%/rule).
  // → Entry MARKET ngay tại current price (chuyển về LIVE legacy behavior cho LTF rules)
  if (!isHtfRuleForLtfConfirm(alert.tfKey)) {
    const tpPrice = alert.side === "LONG" ? alert.entryPrice * (1 + alert.tpPct / 100) : alert.entryPrice * (1 - alert.tpPct / 100);
    const slPrice = alert.side === "LONG" ? alert.entryPrice * (1 - alert.slPct / 100) : alert.entryPrice * (1 + alert.slPct / 100);
    const notional = cfg.marginUsd * cfg.leverage;
    const qty = notionalToQty(notional, alert.entryPrice);
    return {
      kind: "ENTRY", side: alert.side,
      entryPrice: alert.entryPrice, tpPrice, slPrice, qty,
      confirmedBy: `${alert.tfKey} skip-LTF (entry HTF close)`,
    };
  }
  return {
    kind: "PENDING",
    side: alert.side,
    htfEntryPrice: alert.entryPrice,
    tpPct: alert.tpPct,
    slPct: alert.slPct,
  };
}

/** TF nào sẽ qua Phase 2 LTF confirm. 5m + 15m skip vì entry HTF close ngay tốt hơn. */
function isHtfRuleForLtfConfirm(tfKey: string): boolean {
  return tfKey === "1h" || tfKey === "4h" || tfKey === "1d" || tfKey === "1w";
}

/**
 * Push alert vào pending queue (gọi sau khi decideEntry trả PENDING).
 */
export async function addToPending(s: LiveTraderState, alert: AlertInput): Promise<LiveTraderState> {
  const next: LiveTraderState = {
    ...s,
    pendingAlerts: [...s.pendingAlerts, {
      id: alert.id, tfKey: alert.tfKey, side: alert.side,
      htfEntryPrice: alert.entryPrice, tpPct: alert.tpPct, slPct: alert.slPct,
      addedMs: Date.now(),
    }],
  };
  await saveState(next);
  return next;
}

/**
 * confirmPending: kiểm tra mọi pending alert → nếu LTF confirm đạt → execute ENTRY.
 *
 * Confirm rule:
 *   LONG: stoch5m K < confirmStochOsLevel (20) HOẶC price ≤ support15m × (1 + proximity%)
 *   SHORT: K > confirmStochObLevel (80) HOẶC price ≥ resistance15m × (1 - proximity%)
 */
export async function confirmPending(
  s: LiveTraderState,
  ctx: {
    currentPrice: number;
    stoch5m: number | null;
    support15m: number | null;
    resistance15m: number | null;
    activeAlertIds: Set<string>;
    dailyPnl: number;
    openCount: number;
  },
): Promise<LiveTraderState> {
  if (!s.pendingAlerts.length) return s;
  const cfg = s.settings;
  const remaining: PendingAlert[] = [];
  let next = s;

  const now = Date.now();
  for (const p of s.pendingAlerts) {
    // Discard nếu rule không còn ARMED/FIRED (Tommy: "miễn rule còn fire")
    if (!ctx.activeAlertIds.has(p.id)) {
      next = await logAction(next, p.id, p.tfKey, { kind: "DISCARD", reason: "rule no longer firing" });
      continue;
    }
    // Hard timeout: nếu pending quá 24h (data feed lỗi / rule armed mãi) → discard tránh state phình
    if (now - p.addedMs > PENDING_MAX_AGE_MS) {
      next = await logAction(next, p.id, p.tfKey, {
        kind: "DISCARD",
        reason: `pending expired (>24h, addedMs=${new Date(p.addedMs).toISOString()})`,
      });
      continue;
    }
    // Confirm condition
    let confirmedBy: string | null = null;
    if (p.side === "LONG") {
      if (ctx.stoch5m !== null && ctx.stoch5m < cfg.confirmStochOsLevel) {
        confirmedBy = `Stoch5m K=${ctx.stoch5m.toFixed(1)} < ${cfg.confirmStochOsLevel}`;
      } else if (ctx.support15m !== null) {
        const distSup = ((ctx.currentPrice - ctx.support15m) / ctx.support15m) * 100;
        if (distSup >= 0 && distSup <= cfg.confirmSrProximityPct) {
          confirmedBy = `near support15m ${distSup.toFixed(2)}%`;
        }
      }
    } else {
      if (ctx.stoch5m !== null && ctx.stoch5m > cfg.confirmStochObLevel) {
        confirmedBy = `Stoch5m K=${ctx.stoch5m.toFixed(1)} > ${cfg.confirmStochObLevel}`;
      } else if (ctx.resistance15m !== null) {
        const distRes = ((ctx.resistance15m - ctx.currentPrice) / ctx.currentPrice) * 100;
        if (distRes >= 0 && distRes <= cfg.confirmSrProximityPct) {
          confirmedBy = `near resistance15m ${distRes.toFixed(2)}%`;
        }
      }
    }
    if (!confirmedBy) {
      remaining.push(p);
      continue;
    }
    // Recheck per-rule cooldown + maxOpen + dailyPnl + SMART STACK tại thời điểm confirm
    const lastFire = next.firedIds[p.id];
    if (lastFire && Date.now() - lastFire < 10 * 60_000) { remaining.push(p); continue; }
    if (ctx.openCount >= cfg.maxOpen) { remaining.push(p); continue; }
    if (ctx.dailyPnl <= cfg.dailyLossCapUsd) { remaining.push(p); continue; }
    const stackBlock = checkStackGate(next, p.side, ctx.currentPrice, Date.now());
    if (stackBlock) {
      next = await logAction(next, p.id, p.tfKey, { kind: "DISCARD", reason: stackBlock });
      continue;
    }

    // Build ENTRY action với current price
    const entryPrice = ctx.currentPrice;
    const tpPrice = p.side === "LONG" ? entryPrice * (1 + p.tpPct / 100) : entryPrice * (1 - p.tpPct / 100);
    const slPrice = p.side === "LONG" ? entryPrice * (1 - p.slPct / 100) : entryPrice * (1 + p.slPct / 100);
    const notional = cfg.marginUsd * cfg.leverage;
    const qty = notionalToQty(notional, entryPrice);
    const action: LiveAction = {
      kind: "ENTRY", side: p.side,
      entryPrice, tpPrice, slPrice, qty,
      confirmedBy,
    };
    const alertInput: AlertInput = {
      id: p.id, tfKey: p.tfKey, side: p.side,
      entryPrice, tpPrice, slPrice, firedAt: p.addedMs,
      tpPct: p.tpPct, slPct: p.slPct,
    };
    next = await executeAction(next, alertInput, action);
  }

  if (remaining.length !== s.pendingAlerts.length) {
    next = { ...next, pendingAlerts: remaining };
    await saveState(next);
  }
  return next;
}

export async function executeAction(
  s: LiveTraderState,
  alert: AlertInput,
  action: LiveAction,
): Promise<LiveTraderState> {
  let next = await logAction(s, alert.id, alert.tfKey, action);
  if (action.kind !== "ENTRY") return next;

  next = { ...next, firedIds: { ...next.firedIds, [alert.id]: Date.now() } };

  if (s.dryRun) {
    await saveState(next);
    return next;
  }

  const cred: Credentials = { apiKey: s.apiKey, apiSecret: s.apiSecret };
  // KHÔNG gọi setLeverage — dùng leverage hiện tại trên Binance (Tommy set thủ công).
  // Lý do: Isolated Margin với open position không cho phép giảm leverage → gây lỗi -4161.
  // Anh muốn đổi leverage → vào Binance app → BTCUSDT Futures → đóng position rồi đổi.
  try {
    const buySell: "BUY" | "SELL" = action.side === "LONG" ? "BUY" : "SELL";
    const posSide: "LONG" | "SHORT" | undefined = s.hedgeMode ? action.side : undefined;
    // Plan B: chỉ gửi MARKET entry. TP/SL app tự monitor mark price.
    await placeMarketOrder(cred, s.settings.symbol, buySell, action.qty, posSide);
    // Push vào trackedPositions để monitor
    next = {
      ...next,
      trackedPositions: [...next.trackedPositions, {
        id: alert.id,
        side: action.side,
        qty: action.qty,
        entryPrice: action.entryPrice,
        tpPrice: action.tpPrice,
        slPrice: action.slPrice,
        entryMs: Date.now(),
      }],
    };
    // Notify + sound (anh Tommy v4.4.8+)
    try {
      playEntry();
      notify({
        title: `🔔 ENTRY ${action.side} ${alert.id}`,
        body: `qty ${action.qty} @ $${action.entryPrice.toFixed(0)} → TP $${action.tpPrice.toFixed(0)} / SL $${action.slPrice.toFixed(0)}`,
        tag: `entry-${alert.id}-${Date.now()}`,
      });
    } catch {}
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    next = await logAction(next, alert.id, alert.tfKey, { kind: "ERROR", message: msg + explainBinanceError(msg) });
  }
  await saveState(next);
  return next;
}

/**
 * Map mã lỗi Binance → giải thích tiếng Việt + hint khắc phục.
 * Ghép sau message gốc để user hiểu vì sao + sửa thế nào.
 */
export function explainBinanceError(msg: string): string {
  const m = msg.toLowerCase();
  if (msg.includes("-4161")) return "\n💡 Leverage giảm không cho phép khi đang có position mở (Isolated). Hoặc đóng position, hoặc đổi setting.leverage cho khớp với leverage hiện tại trên Binance.";
  if (msg.includes("-4046") || m.includes("no need to change")) return "\n💡 Leverage hiện tại đã = setting, không cần đổi (an toàn).";
  if (msg.includes("-2014")) return "\n💡 API key sai format. Check lại đã paste đúng chưa.";
  if (msg.includes("-2015")) return "\n💡 IP máy không nằm trong whitelist Binance, hoặc key thiếu permission Futures. Vào Binance API Mgmt → check IP + tick Enable Futures.";
  if (msg.includes("-1021")) return "\n💡 Timestamp lệch. Check đồng hồ máy đúng giờ chưa.";
  if (msg.includes("-1022")) return "\n💡 Signature sai. Có thể secret key copy thiếu/lệch ký tự.";
  if (msg.includes("-2019")) return "\n💡 Margin không đủ. Account avail balance không đủ cho lệnh này.";
  if (msg.includes("-4131") || m.includes("price filter")) return "\n💡 Giá order ngoài range cho phép. Có thể price stale.";
  if (msg.includes("-1111") || m.includes("precision")) return "\n💡 Quantity precision sai. BTCUSDT yêu cầu 3 chữ số (vd 0.001).";
  if (msg.includes("-1013") || m.includes("filter failure: notional")) return "\n💡 Notional quá nhỏ. BTCUSDT min notional ~$5 — tăng margin × lev.";
  if (msg.includes("-2027") || m.includes("max position")) return "\n💡 Đã đạt max position size cho symbol. Đóng bớt position rồi thử lại.";
  if (msg.includes("-4120") || m.includes("algo order")) return "\n💡 Lỗi -4120: account đang ở Portfolio Margin hoặc Hedge Mode. Vào Binance: (1) Wallet → Portfolio Margin → DISABLE; (2) Trade → Position Mode → chọn 'One-way Mode'.";
  if (msg.includes("418") || m.includes("banned")) return "\n💡 IP bị Binance ban tạm thời (rate limit). Chờ vài phút.";
  return "";
}

/**
 * Reconcile trackedPositions với Binance positions thực tế (anh Tommy v4.4.8+).
 * Sau app crash hoặc restart, trackedPositions có thể KHÁC actual Binance position
 * (qty đã close manually, hoặc position bị Binance cancel) → drop tracked entries
 * không còn nằm trong Binance position thực + log warning.
 *
 * Strategy: tổng abs(positionAmt) cùng side phải >= sum(qty) của trackedPositions cùng side.
 * Nếu Binance qty < tracked qty → có position đã close ngoài app → drop tracked dư.
 */
export async function reconcileTrackedPositions(
  s: LiveTraderState,
  binancePositions: { positionAmt: string; positionSide?: string }[],
): Promise<{ next: LiveTraderState; dropped: number; warning: string | null }> {
  if (!s.trackedPositions.length) return { next: s, dropped: 0, warning: null };
  // Tính tổng qty Binance theo side
  let binanceLong = 0, binanceShort = 0;
  for (const p of binancePositions) {
    const amt = parseFloat(p.positionAmt) || 0;
    if (p.positionSide === "LONG") binanceLong += Math.abs(amt);
    else if (p.positionSide === "SHORT") binanceShort += Math.abs(amt);
    else if (amt > 0) binanceLong += amt;
    else if (amt < 0) binanceShort += Math.abs(amt);
  }
  // Tổng qty tracked theo side
  const trackedLong = s.trackedPositions.filter((t) => t.side === "LONG").reduce((sum, t) => sum + t.qty, 0);
  const trackedShort = s.trackedPositions.filter((t) => t.side === "SHORT").reduce((sum, t) => sum + t.qty, 0);
  const tolBtc = 0.0005; // 0.0005 BTC ~$30 tolerance
  const longMismatch = trackedLong - binanceLong > tolBtc;
  const shortMismatch = trackedShort - binanceShort > tolBtc;
  if (!longMismatch && !shortMismatch) return { next: s, dropped: 0, warning: null };
  // Có mismatch → drop tracked positions từ cũ nhất theo side đang dư
  let trackedPositions = [...s.trackedPositions];
  let dropped = 0;
  const dropDebt = (side: "LONG" | "SHORT", debt: number) => {
    const sorted = trackedPositions.filter((t) => t.side === side).sort((a, b) => a.entryMs - b.entryMs);
    let remaining = debt;
    const toDrop = new Set<string>();
    for (const t of sorted) {
      if (remaining <= 0) break;
      toDrop.add(t.id);
      remaining -= t.qty;
    }
    trackedPositions = trackedPositions.filter((t) => !toDrop.has(t.id));
    dropped += toDrop.size;
  };
  if (longMismatch) dropDebt("LONG", trackedLong - binanceLong);
  if (shortMismatch) dropDebt("SHORT", trackedShort - binanceShort);
  const next: LiveTraderState = { ...s, trackedPositions };
  await saveState(next);
  const warning = `⚠️ Reconcile: Binance position khác app (${dropped} tracked dropped). LONG ${trackedLong}→${binanceLong}, SHORT ${trackedShort}→${binanceShort}.`;
  return { next, dropped, warning };
}

/**
 * Manual close 1 tracked position (anh Tommy: UI cho phép close từng lệnh riêng).
 * REAL mode: gửi MARKET reduceOnly đúng qty của lệnh đó.
 * DRY RUN: chỉ remove khỏi list + log CLOSE trigger=TP (manual).
 */
export async function closeTrackedManual(
  s: LiveTraderState,
  positionId: string,
  markPrice: number,
): Promise<LiveTraderState> {
  const pos = s.trackedPositions.find((p) => p.id === positionId);
  if (!pos) return s;
  let next = s;
  if (!s.dryRun && s.apiKey && s.apiSecret) {
    const cred: Credentials = { apiKey: s.apiKey, apiSecret: s.apiSecret };
    const closeSide: "BUY" | "SELL" = pos.side === "LONG" ? "SELL" : "BUY";
    const posSide: "LONG" | "SHORT" | undefined = s.hedgeMode ? pos.side : undefined;
    try {
      await placeMarketOrder(cred, s.settings.symbol, closeSide, pos.qty, posSide);
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      next = await logAction(next, pos.id, "live", { kind: "ERROR", message: `manual close: ${msg}` + explainBinanceError(msg) });
      return next; // KHÔNG remove khỏi list nếu API fail — user retry
    }
  }
  next = await logAction(next, pos.id, "live", {
    kind: "CLOSE", side: pos.side, closePrice: markPrice, qty: pos.qty, trigger: "TP",
  });
  next = { ...next, trackedPositions: next.trackedPositions.filter((p) => p.id !== positionId) };
  await saveState(next);
  return next;
}

/**
 * Plan B monitor: scan trackedPositions, nếu mark price hit TP/SL → gửi MARKET close (reduceOnly).
 * Gọi từ hook mỗi tick price update.
 */
export async function monitorTrackedPositions(s: LiveTraderState, markPrice: number): Promise<LiveTraderState> {
  if (!s.trackedPositions.length || s.dryRun) return s;
  if (!s.apiKey || !s.apiSecret) return s;
  const cred: Credentials = { apiKey: s.apiKey, apiSecret: s.apiSecret };
  let next = s;
  const remaining: TrackedPosition[] = [];
  const now = Date.now();
  for (const pos of s.trackedPositions) {
    // Hard timeout: tracked position quá 72h (mark price feed chết / app restart mất state)
    // → log + drop khỏi list để khỏi monitor sai. User cần check Binance manual để close nếu còn.
    if (now - pos.entryMs > TRACKED_POSITION_MAX_AGE_MS) {
      next = await logAction(next, pos.id, "live", {
        kind: "ERROR",
        message: `tracked position expired (>72h, entryMs=${new Date(pos.entryMs).toISOString()}). Check Binance manually — app stopped monitoring TP/SL.`,
      });
      continue;
    }
    let trigger: "TP" | "SL" | null = null;
    if (pos.side === "LONG") {
      if (markPrice >= pos.tpPrice) trigger = "TP";
      else if (markPrice <= pos.slPrice) trigger = "SL";
    } else {
      if (markPrice <= pos.tpPrice) trigger = "TP";
      else if (markPrice >= pos.slPrice) trigger = "SL";
    }
    if (!trigger) {
      remaining.push(pos);
      continue;
    }
    // Hit → gửi MARKET close
    const closeSide: "BUY" | "SELL" = pos.side === "LONG" ? "SELL" : "BUY";
    const posSide: "LONG" | "SHORT" | undefined = s.hedgeMode ? pos.side : undefined;
    try {
      await placeMarketOrder(cred, s.settings.symbol, closeSide, pos.qty, posSide);
      next = await logAction(next, pos.id, "live", {
        kind: "CLOSE", side: pos.side, closePrice: markPrice, qty: pos.qty, trigger,
      });
      // Notify + sound (anh Tommy v4.4.8+) — SL urgent, TP nhẹ
      try {
        if (trigger === "SL") {
          playSlHit();
          notify({
            title: `🚨 SL HIT — ${pos.side} ${pos.id}`,
            body: `Closed ${pos.qty} @ $${markPrice.toFixed(0)} (entry $${pos.entryPrice.toFixed(0)})`,
            tag: `sl-${pos.id}`,
            urgent: true,
          });
        } else {
          playTpHit();
          notify({
            title: `✅ TP HIT — ${pos.side} ${pos.id}`,
            body: `Closed ${pos.qty} @ $${markPrice.toFixed(0)} (entry $${pos.entryPrice.toFixed(0)})`,
            tag: `tp-${pos.id}`,
          });
        }
      } catch {}
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      next = await logAction(next, pos.id, "live", { kind: "ERROR", message: `close ${trigger}: ${msg}` + explainBinanceError(msg) });
      // Giữ lại trong remaining để retry tick sau
      remaining.push(pos);
    }
  }
  if (remaining.length !== s.trackedPositions.length) {
    next = { ...next, trackedPositions: remaining };
    await saveState(next);
  }
  return next;
}

export async function maybeTriggerCooldown(s: LiveTraderState, dailyPnl: number): Promise<LiveTraderState> {
  if (dailyPnl <= s.settings.dailyLossCapUsd && s.pausedUntilMs < Date.now()) {
    const next = { ...s, pausedUntilMs: Date.now() + s.settings.cooldownMinutes * 60_000 };
    await saveState(next);
    return next;
  }
  return s;
}
