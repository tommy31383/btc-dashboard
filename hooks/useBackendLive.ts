/**
 * useBackendLive — connect to btc-trader-server (cloud 24/7).
 *
 * Provides live state, scheduler status, control mutations.
 * - Login → token saved AsyncStorage, persists.
 * - WebSocket subscribe → state update real-time.
 * - REST fallback for actions.
 */
import { useEffect, useRef, useState, useCallback } from "react";
import { api, getToken, setToken, startWs, stopWs, onWsMessage } from "../utils/backendApi";

export interface BackendLiveState {
  authed: boolean;
  loading: boolean;
  lastError: string | null;
  state: any | null;             // server state (publicState — strip secrets)
  scheduler: any | null;         // scheduler status
  alerts: any[];                 // current rule alerts
  lastUpdateMs: number;
}

export interface BackendLiveActions {
  login: (password: string) => Promise<boolean>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  setAuto: (value: boolean) => Promise<void>;
  setDryRun: (value: boolean, password?: string) => Promise<void>;
  setSettings: (partial: any) => Promise<void>;
  closePosition: (id: string, password: string) => Promise<void>;
  editTpSl: (id: string, newTp?: number, newSl?: number, password?: string) => Promise<void>;
  bulkClose: (filter: "ALL" | "PROFIT" | "LOSS" | "OLD_HOURS", password: string) => Promise<void>;
}

export function useBackendLive(): BackendLiveState & BackendLiveActions {
  const [authed, setAuthed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [lastError, setLastError] = useState<string | null>(null);
  const [state, setStateLocal] = useState<any | null>(null);
  const [scheduler, setScheduler] = useState<any | null>(null);
  const [alerts, setAlerts] = useState<any[]>([]);
  const [lastUpdateMs, setLastUpdateMs] = useState(0);
  const refreshTimerRef = useRef<any>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await api.state();
      setStateLocal(r.state);
      setScheduler(r.scheduler);
      setLastUpdateMs(Date.now());
      setLastError(null);
      try {
        const a = await api.alerts();
        setAlerts(a.alerts || []);
      } catch {}
    } catch (e: any) {
      setLastError(e?.message ?? String(e));
    }
  }, []);

  // Init: check token, start WS, fetch state
  useEffect(() => {
    (async () => {
      const t = await getToken();
      if (!t) { setLoading(false); return; }
      try {
        await api.me();
        setAuthed(true);
        await refresh();
        startWs();
      } catch {
        setToken(null);
        setAuthed(false);
      } finally {
        setLoading(false);
      }
    })();
    // Periodic refresh fallback every 15s (in case WS drops)
    refreshTimerRef.current = setInterval(() => {
      if (authed) refresh().catch(() => {});
    }, 15000);
    return () => {
      if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
      stopWs();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // WS subscriber
  useEffect(() => {
    if (!authed) return;
    const off = onWsMessage((msg) => {
      if (msg?.type === "state" && msg.state) {
        setStateLocal(msg.state);
        setLastUpdateMs(msg.ts ?? Date.now());
      }
    });
    return off;
  }, [authed]);

  const login = useCallback(async (password: string): Promise<boolean> => {
    setLoading(true);
    setLastError(null);
    try {
      const r = await api.login(password);
      await setToken(r.token);
      setAuthed(true);
      await refresh();
      startWs();
      return true;
    } catch (e: any) {
      setLastError(e?.message ?? String(e));
      return false;
    } finally {
      setLoading(false);
    }
  }, [refresh]);

  const logout = useCallback(async () => {
    try { await api.logout(); } catch {}
    await setToken(null);
    stopWs();
    setAuthed(false);
    setStateLocal(null);
    setScheduler(null);
    setAlerts([]);
  }, []);

  const setAuto = useCallback(async (value: boolean) => {
    try { await api.setAuto(value); await refresh(); } catch (e: any) { setLastError(e?.message); }
  }, [refresh]);

  const setDryRun = useCallback(async (value: boolean, password?: string) => {
    try { await api.setDryRun(value, password); await refresh(); } catch (e: any) { setLastError(e?.message); }
  }, [refresh]);

  const setSettings = useCallback(async (partial: any) => {
    try { await api.setSettings(partial); await refresh(); } catch (e: any) { setLastError(e?.message); }
  }, [refresh]);

  const closePosition = useCallback(async (id: string, password: string) => {
    try { await api.closePosition(id, password); await refresh(); } catch (e: any) { setLastError(e?.message); }
  }, [refresh]);

  const editTpSl = useCallback(async (id: string, newTp?: number, newSl?: number, password?: string) => {
    try { await api.editTpSl(id, newTp, newSl, password); await refresh(); } catch (e: any) { setLastError(e?.message); }
  }, [refresh]);

  const bulkClose = useCallback(async (filter: "ALL" | "PROFIT" | "LOSS" | "OLD_HOURS", password: string) => {
    try { await api.bulkClose(filter, password); await refresh(); } catch (e: any) { setLastError(e?.message); }
  }, [refresh]);

  return {
    authed, loading, lastError, state, scheduler, alerts, lastUpdateMs,
    login, logout, refresh, setAuto, setDryRun, setSettings,
    closePosition, editTpSl, bulkClose,
  };
}
