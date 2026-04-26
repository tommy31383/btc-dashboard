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
  // TP/SL lấy theo rule (cfg.targetPct / cfg.stopPct), không cấu hình ở đây
}

export const DEFAULT_SETTINGS: LiveSettings = {
  symbol: "BTCUSDT",
  leverage: 100,
  marginUsd: 1,
  maxOpen: 30,
  dailyLossCapUsd: -15,
  cooldownMinutes: 60,
  excludedTfs: ["5m"],
};

export type LiveAction =
  | { kind: "ENTRY"; side: "LONG" | "SHORT"; entryPrice: number; tpPrice: number; slPrice: number; qty: number }
  | { kind: "BLOCK"; reason: string }
  | { kind: "ERROR"; message: string };

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
  journal: LiveJournalEntry[];
  firedIds: Record<string, number>;
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
    journal: [],
    firedIds: {},
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
  if (s.firedIds[alert.id] && Date.now() - s.firedIds[alert.id] < 60_000) {
    return { kind: "BLOCK", reason: "dedup (vừa fire)" };
  }

  const notional = cfg.marginUsd * cfg.leverage;
  const qty = notionalToQty(notional, alert.entryPrice);
  return {
    kind: "ENTRY",
    side: alert.side,
    entryPrice: alert.entryPrice,
    tpPrice: alert.tpPrice,
    slPrice: alert.slPrice,
    qty,
  };
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
    const closeSide: "BUY" | "SELL" = action.side === "LONG" ? "SELL" : "BUY";
    await placeMarketOrder(cred, s.settings.symbol, buySell, action.qty);
    await placeTakeProfitMarket(cred, s.settings.symbol, closeSide, action.tpPrice, true);
    await placeStopMarket(cred, s.settings.symbol, closeSide, action.slPrice, true);
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
  if (msg.includes("418") || m.includes("banned")) return "\n💡 IP bị Binance ban tạm thời (rate limit). Chờ vài phút.";
  return "";
}

export async function maybeTriggerCooldown(s: LiveTraderState, dailyPnl: number): Promise<LiveTraderState> {
  if (dailyPnl <= s.settings.dailyLossCapUsd && s.pausedUntilMs < Date.now()) {
    const next = { ...s, pausedUntilMs: Date.now() + s.settings.cooldownMinutes * 60_000 };
    await saveState(next);
    return next;
  }
  return s;
}
