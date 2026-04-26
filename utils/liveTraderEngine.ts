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
}

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
      3000,
    );
  }
}

/** Pull remote sync state & merge journal entries (union by ts+ruleId). */
export async function pullRemote(local: LiveTraderState): Promise<LiveTraderState> {
  const remote = await pullFile<LiveSyncState>(REMOTE_FILE);
  if (!remote) return local;
  const seen = new Set(local.journal.map((j) => `${j.ts}|${j.ruleId}|${j.action.kind}`));
  const merged = [...local.journal];
  for (const r of remote.journal || []) {
    const k = `${r.ts}|${r.ruleId}|${r.action.kind}`;
    if (!seen.has(k)) merged.push(r);
  }
  merged.sort((a, b) => a.ts - b.ts);
  return {
    ...local,
    settings: { ...DEFAULT_SETTINGS, ...(remote.settings || local.settings) },
    autoEnabled: remote.autoEnabled ?? local.autoEnabled,
    dryRun: remote.dryRun ?? local.dryRun,
    pausedUntilMs: Math.max(local.pausedUntilMs, remote.pausedUntilMs || 0),
    journal: merged,
    firedIds: { ...local.firedIds, ...(remote.firedIds || {}) },
  };
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
  return {
    kind: "PENDING",
    side: alert.side,
    htfEntryPrice: alert.entryPrice,
    tpPct: alert.tpPct,
    slPct: alert.slPct,
  };
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

  for (const p of s.pendingAlerts) {
    // Discard nếu rule không còn ARMED/FIRED (Tommy: "miễn rule còn fire")
    if (!ctx.activeAlertIds.has(p.id)) {
      next = await logAction(next, p.id, p.tfKey, { kind: "DISCARD", reason: "rule no longer firing" });
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
    // Recheck per-rule cooldown + maxOpen + dailyPnl tại thời điểm confirm
    const lastFire = next.firedIds[p.id];
    if (lastFire && Date.now() - lastFire < 10 * 60_000) { remaining.push(p); continue; }
    if (ctx.openCount >= cfg.maxOpen) { remaining.push(p); continue; }
    if (ctx.dailyPnl <= cfg.dailyLossCapUsd) { remaining.push(p); continue; }

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
 * Plan B monitor: scan trackedPositions, nếu mark price hit TP/SL → gửi MARKET close (reduceOnly).
 * Gọi từ hook mỗi tick price update.
 */
export async function monitorTrackedPositions(s: LiveTraderState, markPrice: number): Promise<LiveTraderState> {
  if (!s.trackedPositions.length || s.dryRun) return s;
  if (!s.apiKey || !s.apiSecret) return s;
  const cred: Credentials = { apiKey: s.apiKey, apiSecret: s.apiSecret };
  let next = s;
  const remaining: TrackedPosition[] = [];
  for (const pos of s.trackedPositions) {
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
