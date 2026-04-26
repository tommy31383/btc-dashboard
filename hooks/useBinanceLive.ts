/**
 * useBinanceLive — wire activeAlerts → liveTraderEngine + poll Binance state.
 *
 * Phase 1 (DRY RUN): mỗi alert mới → decideEntry → log vào journal.
 * Phase 2 (real): executeAction sẽ gọi Binance API thật.
 *
 * Settings + journal sync qua GitHub repo (utils/gistSync). API key/secret
 * CHỈ lưu local AsyncStorage.
 */
import { useEffect, useRef, useState } from "react";
import { RuleAlert } from "./useRuleAlerts";
import {
  LiveTraderState, LiveSettings, loadState, saveState, decideEntry, executeAction,
  maybeTriggerCooldown, AlertInput, emptyState, pullRemote, DEFAULT_SETTINGS,
} from "../utils/liveTraderEngine";
import {
  AccountSnapshot, PositionRisk, getDailyPnl, getPositions, testConnection,
} from "../utils/binanceLive";

const POLL_MS = 30 * 1000;

export interface UseBinanceLiveResult {
  state: LiveTraderState;
  account: AccountSnapshot | null;
  positions: PositionRisk[];
  dailyPnl: number;
  openCount: number;
  lastError: string | null;
  setCredentials: (apiKey: string, apiSecret: string) => Promise<void>;
  setAutoEnabled: (on: boolean) => Promise<void>;
  setDryRun: (on: boolean) => Promise<void>;
  setSettings: (partial: Partial<LiveSettings>) => Promise<void>;
  resetSettings: () => Promise<void>;
  resetCooldown: () => Promise<void>;
  clearJournal: () => Promise<void>;
  testNow: () => Promise<void>;
  pullFromRemote: () => Promise<void>;
}

export function useBinanceLive(activeAlerts: RuleAlert[]): UseBinanceLiveResult {
  const [state, setState] = useState<LiveTraderState>(() => emptyState());
  const [account, setAccount] = useState<AccountSnapshot | null>(null);
  const [positions, setPositions] = useState<PositionRisk[]>([]);
  const [dailyPnl, setDailyPnl] = useState(0);
  const [lastError, setLastError] = useState<string | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const lastAlertSeenRef = useRef<Set<string>>(new Set());

  // Boot: load local then merge remote
  useEffect(() => {
    (async () => {
      let s = await loadState();
      setState(s);
      try {
        s = await pullRemote(s);
        await saveState(s, { sync: false });
        setState(s);
      } catch {}
    })();
  }, []);

  // Subscribe activeAlerts → fire decideEntry on new ones
  useEffect(() => {
    if (!activeAlerts.length) return;
    const seen = lastAlertSeenRef.current;
    const fresh = activeAlerts.filter((a) => {
      const key = `${a.id}@${a.firedAt}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (!fresh.length) return;

    (async () => {
      let s = stateRef.current;
      const openCount = positions.filter((p) => parseFloat(p.positionAmt) !== 0).length;
      for (const a of fresh) {
        if (a.side === "BOTH") continue;
        const input: AlertInput = {
          id: a.id, tfKey: a.tfKey, side: a.side,
          entryPrice: a.entryPrice, tpPrice: a.tpPrice, slPrice: a.slPrice,
          firedAt: a.firedAt,
        };
        const action = decideEntry(s, input, { dailyPnl, openCount, nowMs: Date.now() });
        s = await executeAction(s, input, action);
      }
      setState(s);
    })();
  }, [activeAlerts, dailyPnl, positions]);

  // Poll Binance state every 30s when credentials present
  useEffect(() => {
    if (!state.apiKey || !state.apiSecret) return;
    let alive = true;
    const cred = { apiKey: state.apiKey, apiSecret: state.apiSecret };

    async function poll() {
      try {
        const [acc, pos, pnl] = await Promise.all([
          testConnection(cred),
          getPositions(cred, stateRef.current.settings.symbol),
          getDailyPnl(cred, stateRef.current.settings.symbol),
        ]);
        if (!alive) return;
        setAccount(acc);
        setPositions(pos);
        setDailyPnl(pnl);
        setLastError(null);
        const next = await maybeTriggerCooldown(stateRef.current, pnl);
        if (next !== stateRef.current) setState(next);
      } catch (e: any) {
        if (!alive) return;
        setLastError(e?.message ?? String(e));
      }
    }
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [state.apiKey, state.apiSecret]);

  const openCount = positions.filter((p) => parseFloat(p.positionAmt) !== 0).length;

  return {
    state, account, positions, dailyPnl, openCount, lastError,
    async setCredentials(apiKey, apiSecret) {
      const next = { ...stateRef.current, apiKey, apiSecret, leverageSetForSession: false };
      await saveState(next); setState(next);
    },
    async setAutoEnabled(on) {
      const next = { ...stateRef.current, autoEnabled: on };
      await saveState(next); setState(next);
    },
    async setDryRun(on) {
      const next = { ...stateRef.current, dryRun: on };
      await saveState(next); setState(next);
    },
    async setSettings(partial) {
      const next = { ...stateRef.current, settings: { ...stateRef.current.settings, ...partial }, leverageSetForSession: false };
      await saveState(next); setState(next);
    },
    async resetSettings() {
      const next = { ...stateRef.current, settings: DEFAULT_SETTINGS };
      await saveState(next); setState(next);
    },
    async resetCooldown() {
      const next = { ...stateRef.current, pausedUntilMs: 0 };
      await saveState(next); setState(next);
    },
    async clearJournal() {
      const next = { ...stateRef.current, journal: [] };
      await saveState(next); setState(next);
    },
    async testNow() {
      try {
        const acc = await testConnection({ apiKey: state.apiKey, apiSecret: state.apiSecret });
        setAccount(acc); setLastError(null);
      } catch (e: any) {
        setLastError(e?.message ?? String(e));
      }
    },
    async pullFromRemote() {
      const merged = await pullRemote(stateRef.current);
      await saveState(merged, { sync: false });
      setState(merged);
    },
  };
}
