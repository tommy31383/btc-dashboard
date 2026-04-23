import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { EntrySignal } from "./backtester";

let initialized = false;
let permissionGranted = false;

// Configure how notifications behave when app is in foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowAlert: true,
  }),
});

export async function initNotifications(): Promise<boolean> {
  if (initialized) return permissionGranted;
  initialized = true;

  try {
    const { status: existing } = await Notifications.getPermissionsAsync();
    let finalStatus = existing;
    if (existing !== "granted") {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    permissionGranted = finalStatus === "granted";

    if (Platform.OS === "android" && permissionGranted) {
      await Notifications.setNotificationChannelAsync("btc-signals", {
        name: "BTC Signals",
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: "#f7931a",
      });
    }
    return permissionGranted;
  } catch {
    permissionGranted = false;
    return false;
  }
}

export async function notifyNewSignal(
  tfLabel: string,
  signal: EntrySignal
): Promise<void> {
  if (!permissionGranted) return;

  const isLong = signal.type === "LONG";
  const arrow = isLong ? "▲" : "▼";
  const title = `${arrow} ${signal.type} ${tfLabel} · Score ${signal.score}/5`;
  const body = `Entry: $${signal.entryPrice.toFixed(2)} · TP: $${signal.targetPrice.toFixed(2)} · SL: $${signal.stopPrice.toFixed(2)}`;

  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        data: { type: "entry", tf: tfLabel, signal: signal.type, score: signal.score },
        sound: true,
      },
      trigger: Platform.OS === "android" ? { channelId: "btc-signals" } as any : null,
    });
  } catch {}
}

export async function notifySignalClosed(
  tfLabel: string,
  signal: EntrySignal,
  status: "WIN" | "LOSS" | "EXPIRED",
  leveragedPnlPct: number
): Promise<void> {
  if (!permissionGranted) return;

  const icon = status === "WIN" ? "✓" : status === "LOSS" ? "✕" : "⏱";
  const statusLabel = status === "WIN" ? "THẮNG" : status === "LOSS" ? "THUA" : "HẾT HẠN";
  const title = `${icon} ${statusLabel} · ${signal.type} ${tfLabel}`;
  const sign = leveragedPnlPct >= 0 ? "+" : "";
  const body = `PnL: ${sign}${leveragedPnlPct.toFixed(1)}% (đòn bẩy)`;

  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        data: { type: "exit", tf: tfLabel, status },
        sound: true,
      },
      trigger: Platform.OS === "android" ? { channelId: "btc-signals" } as any : null,
    });
  } catch {}
}

export async function notifyBacktestDone(
  tfLabel: string,
  winRate: number,
  totalTrades: number,
  profitFactor: number,
  newCandles: number
): Promise<void> {
  if (!permissionGranted) return;

  const wrIcon = winRate >= 60 ? "✓" : winRate >= 45 ? "~" : "✕";
  const title = `${wrIcon} Backtest ${tfLabel} xong`;
  const pfStr = profitFactor === Infinity ? "∞" : profitFactor.toFixed(1);
  const deltaStr = newCandles > 0 ? ` · +${newCandles} nến mới` : " · cache";
  const body = `WR ${winRate.toFixed(0)}% · ${totalTrades} lệnh · PF ${pfStr}${deltaStr}`;

  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        data: { type: "backtest", tf: tfLabel },
        sound: true,
      },
      trigger: Platform.OS === "android" ? { channelId: "btc-signals" } as any : null,
    });
  } catch {}
}

export async function notifyOptimizerDone(
  tfLabel: string,
  bestWinRate: number,
  bestTrades: number,
  bestProfitFactor: number,
  config: { minScore: number; stochOSLevel: number; stochOBLevel: number; targetPct: number; stopPct: number }
): Promise<void> {
  if (!permissionGranted) return;

  const wrIcon = bestWinRate >= 60 ? "✓" : bestWinRate >= 45 ? "~" : "✕";
  const title = `${wrIcon} Tối ưu ${tfLabel} xong`;
  const pfStr = bestProfitFactor === Infinity ? "∞" : bestProfitFactor.toFixed(1);
  const body = `Best WR ${bestWinRate.toFixed(0)}% · Score≥${config.minScore} · TP ${config.targetPct}% / SL ${config.stopPct}% · PF ${pfStr} (${bestTrades} lệnh)`;

  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        data: { type: "optimizer", tf: tfLabel },
        sound: true,
      },
      trigger: Platform.OS === "android" ? { channelId: "btc-signals" } as any : null,
    });
  } catch {}
}

/**
 * Push notification when a TRACKED rule's conditions match live candle data.
 * Title shows direction + TF + condition shape; body shows entry/TP/SL prices
 * so user can act immediately without opening the app.
 */
export async function notifyRuleFire(
  rule: any, // HardRule from utils/hardRules
  side: "LONG" | "SHORT",
  entryPrice: number,
  tpPrice: number,
  slPrice: number
): Promise<void> {
  if (!permissionGranted) return;

  const cfg = rule.config as any;
  const stats = rule.stats as any;
  const lev = cfg.leverage || 100;
  const tfKey = (rule.label?.match(/\b(5m|15m|1h|4h|1d|1w)\b/i) || [""])[0] || "";
  const sideEmoji = side === "LONG" ? "🟢" : "🔴";
  const sideText = side === "LONG" ? "LONG" : "SHORT";

  // Build short shape description
  const shapeBits: string[] = [];
  if (cfg.weights) shapeBits.push("🧬GA");
  if (cfg.requiredConditions?.length) shapeBits.push(cfg.requiredConditions.join("+"));
  if (cfg.htfTrendFilter) shapeBits.push(`HTF:${(cfg.htfTrendFilter.label || cfg.htfTrendFilter.mode || "").toString().slice(0, 20)}`);
  const shape = shapeBits.length > 0 ? shapeBits.join(" · ") : `Score≥${cfg.minScore}`;

  const title = `${sideEmoji} ${sideText} ${tfKey ? `${tfKey} ` : ""}#${rule.rank} · WR ${stats.winRate}%`;
  const body =
    `Entry $${entryPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })} · ` +
    `TP $${tpPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })} (+${(cfg.targetPct * lev).toFixed(0)}% PnL) · ` +
    `SL $${slPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })} (-${(cfg.stopPct * lev).toFixed(0)}% PnL)\n` +
    `${shape} · x${lev}`;

  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        data: { type: "rule_fire", rank: rule.rank, side },
        sound: true,
      },
      trigger: Platform.OS === "android" ? { channelId: "btc-signals" } as any : null,
    });
  } catch {}
}

export function isPermissionGranted(): boolean {
  return permissionGranted;
}
