/**
 * use5mAllTrader — engine cho tab "5m All".
 *
 * v4.8.31 cleanup:
 *  - Removed follower/leader mode (server owns trading; front-end is display only)
 *  - processOpen now uses getAccountCached() — no AsyncStorage on hot tick path
 *  - 5m-bar useEffect keyed on closedBar.time (not entire rawKlines/tfData ref)
 *    → avoids re-firing on every WebSocket tick
 */
import { useEffect, useRef, useState } from "react";
import {
  All5mAccount, AccountSummary, closePositionManual, emptyAccount,
  loadAccount, getAccountCached, processOpen, resetAccount, summarize, tryEntry5mBar,
  PresetKey, getActivePresetKey, setActivePresetKey, DEFAULT_PRESET_KEY,
  PRESETS,
} from "../utils/all5mAccount";
import { TFAnalysis, Kline, RawKlinesMap } from "./useBinanceKlines";

export interface Use5mAllTraderResult {
  account: All5mAccount;
  summary: AccountSummary;
  reset: () => Promise<void>;
  reload: () => Promise<void>;
  closeManual: (positionId: string) => Promise<void>;
  presetKey: PresetKey;
  setPreset: (key: PresetKey) => Promise<void>;
}

function pivotSR(klines15m: Kline[] | undefined, lookback: number): { support: number | null; resistance: number | null } {
  if (!klines15m || klines15m.length < lookback + 1) return { support: null, resistance: null };
  const closedTail = klines15m.slice(-lookback - 1, -1);
  let lo = Infinity, hi = -Infinity;
  for (const c of closedTail) {
    if (c.low < lo) lo = c.low;
    if (c.high > hi) hi = c.high;
  }
  return { support: lo === Infinity ? null : lo, resistance: hi === -Infinity ? null : hi };
}

export function use5mAllTrader(
  rawKlines: RawKlinesMap,
  tfData: TFAnalysis[],
  currentPrice: number | null,
  enabled: boolean,
): Use5mAllTraderResult {
  const [account, setAccount] = useState<All5mAccount>(() => emptyAccount());
  const [presetKey, setPresetKey] = useState<PresetKey>(DEFAULT_PRESET_KEY);
  const lastBarTimeRef = useRef<number>(0);

  // Warm RAM cache + load preset once on mount
  useEffect(() => {
    if (!enabled) return;
    loadAccount().then((acc) => setAccount(acc));
    getActivePresetKey().then(setPresetKey);
  }, [enabled]);

  // 5m bar đóng → try entry (keyed on closedBar.time để không re-fire mỗi tick)
  const klines5m: Kline[] | undefined = rawKlines["5m"];
  const closedBarTime = klines5m && klines5m.length >= 2 ? klines5m[klines5m.length - 2].time : 0;

  useEffect(() => {
    if (!enabled || !closedBarTime || closedBarTime === lastBarTimeRef.current) return;
    lastBarTimeRef.current = closedBarTime;

    const closedBar = klines5m![klines5m!.length - 2];
    const stoch5m = tfData.find((t) => t.key === "5m")?.stochK ?? null;
    const { support, resistance } = pivotSR(rawKlines["15m"], PRESETS[presetKey].srLookback15m);

    (async () => {
      const created = await tryEntry5mBar(closedBar.time, closedBar.close, stoch5m, support, resistance);
      if (created) setAccount({ ...getAccountCached() });
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, closedBarTime]);

  // Tick → close OPEN khi hit TP/SL (sync RAM path)
  useEffect(() => {
    if (!enabled || currentPrice === null || currentPrice <= 0) return;
    (async () => {
      const closed = await processOpen(currentPrice);
      if (closed > 0) setAccount({ ...getAccountCached() });
    })();
  }, [enabled, currentPrice]);

  const reset = async () => {
    const fresh = await resetAccount();
    lastBarTimeRef.current = 0;
    setAccount(fresh);
  };

  const reload = async () => {
    const acc = await loadAccount();
    setAccount(acc);
  };

  const closeManual = async (positionId: string) => {
    if (currentPrice === null || currentPrice <= 0) return;
    const ok = await closePositionManual(positionId, currentPrice);
    if (ok) setAccount({ ...getAccountCached() });
  };

  const setPreset = async (key: PresetKey) => {
    await setActivePresetKey(key);
    setPresetKey(key);
  };

  return { account, summary: summarize(account), reset, reload, closeManual, presetKey, setPreset };
}
