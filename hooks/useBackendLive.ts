/**
 * useBackendLive — connect to btc-trader-server (cloud 24/7).
 *
 * Provides live state, scheduler status, control mutations.
 * - Login → token saved AsyncStorage, persists.
 * - WebSocket subscribe → state update real-time.
 * - REST fallback for actions.
 */
import { useEffect, useRef, useState, useCallback } from "react";
import { api, getToken, setToken, startWs, stopWs, onWsMessage, ServerInfo, ServerHealth } from "../utils/backendApi";

// 2026-04-28 (anh Tommy): RAM cap journal client-side. Server-side cũng cap 100,
// disk rolling 7 ngày, lazy history per-day. KHÔNG cache history vào _cache.
const CLIENT_JOURNAL_CAP = 100;

// Dedup key cho journal entries (timestamp + ruleId + actionKind)
function journalKey(e: any): string {
  return `${e?.ts ?? e?.t ?? 0}|${e?.ruleId ?? e?.r ?? "?"}|${e?.action?.kind ?? e?.actionKind ?? e?.a ?? "?"}`;
}

// Module-level cache — persist across mount/unmount khi user switch tab
// (anh Tommy v4.8.14: switch tab không reload từ đầu)
const _cache = {
  authed: false,
  state: null as any,
  scheduler: null as any,
  alerts: [] as any[],
  journal: [] as any[],
  lastUpdateMs: 0,
  initialized: false,
  serverInfo: null as ServerInfo | null,
  serverHealth: null as ServerHealth | null,
};
let _wsStarted = false;
const _stateSubscribers = new Set<() => void>();
function _notifyAll() { for (const fn of _stateSubscribers) fn(); }

export interface BackendLiveState {
  authed: boolean;
  loading: boolean;
  lastError: string | null;
  state: any | null;             // server state (publicState — strip secrets)
  scheduler: any | null;         // scheduler status
  alerts: any[];                 // current rule alerts
  journal: any[];                // recent journal entries (CLOSE for chart markers)
  lastUpdateMs: number;
  serverInfo: ServerInfo | null; // version, name từ GET /
  serverHealth: ServerHealth | null; // uptime, mem, pid từ GET /api/health
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
  // 2026-04-28: lazy history loader — KHÔNG cache vào state, caller tự manage memory.
  loadJournalHistory: (date: string) => Promise<any[]>;
  loadJournalDays: () => Promise<string[]>;
}

export function useBackendLive(): BackendLiveState & BackendLiveActions {
  // Sử dụng cache module-level làm initial state — instant render khi remount
  const [authed, setAuthed] = useState(_cache.authed);
  const [loading, setLoading] = useState(!_cache.initialized);
  const [lastError, setLastError] = useState<string | null>(null);
  const [state, setStateLocal] = useState<any | null>(_cache.state);
  const [scheduler, setScheduler] = useState<any | null>(_cache.scheduler);
  const [alerts, setAlerts] = useState<any[]>(_cache.alerts);
  const [journal, setJournal] = useState<any[]>(_cache.journal);
  const [lastUpdateMs, setLastUpdateMs] = useState(_cache.lastUpdateMs);
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(_cache.serverInfo);
  const [serverHealth, setServerHealth] = useState<ServerHealth | null>(_cache.serverHealth);
  const refreshTimerRef = useRef<any>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await api.state();
      _cache.state = r.state; setStateLocal(r.state);
      _cache.scheduler = r.scheduler; setScheduler(r.scheduler);
      _cache.lastUpdateMs = Date.now(); setLastUpdateMs(_cache.lastUpdateMs);
      setLastError(null);
      try {
        const a = await api.alerts();
        _cache.alerts = a.alerts || []; setAlerts(_cache.alerts);
      } catch {}
      try {
        const j = await api.journal(CLIENT_JOURNAL_CAP);
        // 2026-04-28: cap RAM client-side dù server có trả về nhiều hơn.
        _cache.journal = (j.entries || []).slice(0, CLIENT_JOURNAL_CAP);
        setJournal(_cache.journal);
      } catch {}
      // v4.8.35 (anh Tommy Phương án A): bỏ root + health khỏi refresh loop
      // — fetch 1 lần ở init/login + WS reconnect là đủ. Giảm 2 reqs/refresh.
      _notifyAll();
    } catch (e: any) {
      setLastError(e?.message ?? String(e));
    }
  }, []);

  // Init: check token, start WS, fetch state — chạy 1 LẦN cho cả app
  useEffect(() => {
    // Subscribe để nhận update từ instances khác (cùng cache)
    const sync = () => {
      setAuthed(_cache.authed);
      setStateLocal(_cache.state);
      setScheduler(_cache.scheduler);
      setAlerts(_cache.alerts);
      setJournal(_cache.journal);
      setLastUpdateMs(_cache.lastUpdateMs);
      setServerInfo(_cache.serverInfo);
      setServerHealth(_cache.serverHealth);
    };
    _stateSubscribers.add(sync);

    // Init chỉ chạy 1 lần global
    if (!_cache.initialized) {
      _cache.initialized = true;
      (async () => {
        const t = await getToken();
        if (!t) { setLoading(false); return; }
        try {
          await api.me();
          _cache.authed = true; setAuthed(true);
          await Promise.all([refresh(), fetchServerInfo()]);
          if (!_wsStarted) { startWs(); _wsStarted = true; }
        } catch {
          setToken(null);
          _cache.authed = false; setAuthed(false);
        } finally {
          setLoading(false);
        }
      })();
      // Single global refresh interval — không multi-instance
      // v4.8.35: 15s → 30s — WS đã push state realtime, REST chỉ là safety fallback
      // v4.9.9 (anh Tommy audit D3): SKIP REST refresh nếu WS healthy (lastWsTs < 10s).
      // WS đã push state realtime → REST chỉ là safety fallback khi WS chết.
      // Trước: 30s × 3 reqs = 6 reqs/min lãng phí ~600KB/min. Giờ chỉ refresh nếu WS stale.
      refreshTimerRef.current = setInterval(() => {
        if (!_cache.authed) return;
        const wsAge = Date.now() - (_cache.lastUpdateMs || 0);
        if (wsAge < 60_000) return; // WS healthy → skip REST
        refresh().catch(() => {});
      }, 30000);
    } else {
      setLoading(false);
    }
    return () => {
      _stateSubscribers.delete(sync);
      // KHÔNG clear interval / stop WS — giữ persistent qua mount/unmount
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // WS subscriber — update cache + notify all instances
  useEffect(() => {
    if (!authed) return;
    const off = onWsMessage((msg) => {
      if (msg?.type === "state" && msg.state) {
        _cache.state = msg.state; setStateLocal(msg.state);
        _cache.lastUpdateMs = msg.ts ?? Date.now(); setLastUpdateMs(_cache.lastUpdateMs);
        _notifyAll();
        return;
      }
      // 2026-04-28: server push DELTA append, KHÔNG full state — bandwidth -99.8%.
      if (msg?.type === "journal_append" && msg.entry) {
        const entry = msg.entry;
        const k = journalKey(entry);
        const existing = _cache.journal;
        // dedup theo timestamp+ruleId+actionKind (tránh duplicate khi WS retry)
        if (existing.some((e) => journalKey(e) === k)) return;
        const next = [entry, ...existing].slice(0, CLIENT_JOURNAL_CAP);
        _cache.journal = next; setJournal(next);
        _cache.lastUpdateMs = msg.ts ?? Date.now(); setLastUpdateMs(_cache.lastUpdateMs);
        _notifyAll();
        return;
      }
      // Bulk replace (server có thể push lại nếu reconnect mất delta)
      if (msg?.type === "journal_snapshot" && Array.isArray(msg.entries)) {
        const next = msg.entries.slice(0, CLIENT_JOURNAL_CAP);
        _cache.journal = next; setJournal(next);
        _notifyAll();
      }
    });
    return off;
  }, [authed]);

  const fetchServerInfo = useCallback(async () => {
    try {
      const [info, health] = await Promise.all([api.root(), api.health()]);
      _cache.serverInfo = info;
      _cache.serverHealth = health;
      _notifyAll();
    } catch { /* non-critical, bỏ qua */ }
  }, []);

  const login = useCallback(async (password: string): Promise<boolean> => {
    setLoading(true);
    setLastError(null);
    try {
      const r = await api.login(password);
      await setToken(r.token);
      _cache.authed = true; setAuthed(true);
      await Promise.all([refresh(), fetchServerInfo()]);
      if (!_wsStarted) { startWs(); _wsStarted = true; }
      _notifyAll();
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
    stopWs(); _wsStarted = false;
    _cache.authed = false; setAuthed(false);
    _cache.state = null; setStateLocal(null);
    _cache.scheduler = null; setScheduler(null);
    _cache.alerts = []; setAlerts([]);
    _cache.journal = []; setJournal([]);
    _notifyAll();
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

  // 2026-04-28: lazy loaders — KHÔNG cache vào _cache, caller tự dispose để giữ RAM thấp.
  const loadJournalHistory = useCallback(async (date: string): Promise<any[]> => {
    try {
      const r = await api.journalHistory(date);
      return r.entries || [];
    } catch (e: any) {
      setLastError(e?.message ?? String(e));
      return [];
    }
  }, []);

  const loadJournalDays = useCallback(async (): Promise<string[]> => {
    try {
      const r = await api.journalDays();
      return r.days || [];
    } catch (e: any) {
      setLastError(e?.message ?? String(e));
      return [];
    }
  }, []);

  return {
    authed, loading, lastError, state, scheduler, alerts, journal, lastUpdateMs,
    serverInfo, serverHealth,
    login, logout, refresh, setAuto, setDryRun, setSettings,
    closePosition, editTpSl, bulkClose,
    loadJournalHistory, loadJournalDays,
  };
}
