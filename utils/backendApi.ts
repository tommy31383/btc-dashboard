/**
 * Backend API client (anh Tommy v0.2 — cloud server).
 *
 * Talks to btc-trader-server (deployed at SERVER_URL).
 * Token stored in AsyncStorage @backend_token_v1, persists across sessions.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

// User có thể override qua AsyncStorage @backend_url_v1 (vd nếu DNS issue)
const DEFAULT_SERVER_URL = "https://tommybtc.duckdns.org";
const URL_KEY = "@backend_url_v1";
const TOKEN_KEY = "@backend_token_v1";

let _cachedUrl: string | null = null;
export async function getServerUrl(): Promise<string> {
  if (_cachedUrl) return _cachedUrl;
  try {
    const u = await AsyncStorage.getItem(URL_KEY);
    if (u) { _cachedUrl = u; return u; }
  } catch {}
  _cachedUrl = DEFAULT_SERVER_URL;
  return DEFAULT_SERVER_URL;
}
export async function setServerUrl(url: string): Promise<void> {
  _cachedUrl = url || DEFAULT_SERVER_URL;
  if (url && url !== DEFAULT_SERVER_URL) await AsyncStorage.setItem(URL_KEY, url);
  else await AsyncStorage.removeItem(URL_KEY);
}
// Backward-compat: SERVER_URL constant for static reads (use getServerUrl() in async paths)
export const SERVER_URL = DEFAULT_SERVER_URL;

let _cachedToken: string | null = null;

export async function getToken(): Promise<string | null> {
  if (_cachedToken) return _cachedToken;
  try {
    const t = await AsyncStorage.getItem(TOKEN_KEY);
    _cachedToken = t;
    return t;
  } catch { return null; }
}

export async function setToken(token: string | null): Promise<void> {
  _cachedToken = token;
  if (token) await AsyncStorage.setItem(TOKEN_KEY, token);
  else await AsyncStorage.removeItem(TOKEN_KEY);
}

async function request<T>(path: string, method: "GET" | "POST" = "GET", body?: any): Promise<T> {
  const token = await getToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const url = await getServerUrl();
  const res = await fetch(`${url}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = {};
  try { data = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}: ${text.slice(0, 200)}`);
  return data as T;
}

export interface LoginResponse { token: string; ttlDays: number; }

export interface ServerInfo { name: string; version: string; }
export interface ServerHealth { ok: boolean; uptime: number; pid: number; memMb: number; ts: number; }

export const api = {
  root: () => request<ServerInfo>("/"),
  login: (password: string) => request<LoginResponse>("/api/auth/login", "POST", { password }),
  logout: () => request<{ ok: boolean }>("/api/auth/logout", "POST"),
  me: () => request<{ jti: string; exp: number }>("/api/auth/me"),
  health: () => request<any>("/api/health"),

  // LIVE
  state: () => request<any>("/api/live/state"),
  journal: (limit = 100) => request<any>(`/api/live/journal?limit=${limit}`),
  // 2026-04-28: 7-day rolling journal — lazy load history per day, KHÔNG cache vào state
  // (anh Tommy: optimized RAM — chỉ giữ 100 entry RAM, history fetch on-demand).
  journalHistory: (date: string) =>
    request<{ entries: any[]; count: number }>(`/api/live/journal/history?date=${encodeURIComponent(date)}`),
  journalDays: () =>
    request<{ days: string[] }>("/api/live/journal/days"),
  alerts: () => request<any>("/api/live/alerts"),
  trackedRules: () => request<any>("/api/live/tracked-rules"),
  setAuto: (value: boolean) => request<any>("/api/live/auto", "POST", { value }),
  setDryRun: (value: boolean, password?: string) =>
    request<any>("/api/live/dry-run", "POST", { value, confirmPassword: password }),
  setSettings: (settings: any) => request<any>("/api/live/settings", "POST", { settings }),
  closePosition: (positionId: string, password: string) =>
    request<any>("/api/live/close", "POST", { positionId, confirmPassword: password }),
  editTpSl: (positionId: string, newTp?: number, newSl?: number, password?: string) =>
    request<any>("/api/live/edit-tp-sl", "POST", { positionId, newTp, newSl, confirmPassword: password }),
  bulkClose: (filter: "ALL" | "PROFIT" | "LOSS" | "OLD_HOURS", password: string, oldHoursThreshold?: number) =>
    request<any>("/api/live/bulk-close", "POST", { filter, confirmPassword: password, oldHoursThreshold }),

  // Binance status (read-only — verify connectivity)
  binanceAccount: () => request<any>("/api/binance/account"),
  binancePositions: () => request<any>("/api/binance/positions"),
  binanceHedge: () => request<any>("/api/binance/hedge-mode"),

  // v0.3.0 PRESET ENGINE (anh Tommy: server replica của 5m ALL)
  presets: () => request<any>("/api/live/presets"),
  setPresetConfig: (config: any) => request<any>("/api/live/preset-config", "POST", { config }),
  paperReset: (password: string) => request<any>("/api/live/paper/reset", "POST", { confirmPassword: password }),
  paperClear: (password: string) => request<any>("/api/live/paper/clear", "POST", { confirmPassword: password }),
  realClear: (password: string) => request<any>("/api/live/real/clear", "POST", { confirmPassword: password }),
};

export type WsHandler = (msg: any) => void;
let _ws: WebSocket | null = null;
let _wsHandlers = new Set<WsHandler>();
let _wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;

async function connectWs(): Promise<void> {
  const token = await getToken();
  if (!token) return;
  const url = await getServerUrl();
  // v4.9.10 (audit SEC1): JWT qua Sec-WebSocket-Protocol header thay vì URL query
  // (URL query leak vào Caddy/nginx logs, Referer headers, browser history).
  // Server v0.3.7+ accept subprotocol "bearer" + token. Backward compat fallback ?token=.
  const wsUrl = url.replace(/^http/, "ws") + "/ws";
  try {
    _ws = new WebSocket(wsUrl, ["bearer", token]);
    _ws.onopen = () => console.log("[backend ws] connected");
    _ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data as string);
        _wsHandlers.forEach((fn) => fn(msg));
      } catch {}
    };
    _ws.onclose = () => {
      console.log("[backend ws] closed — reconnect in 5s");
      _ws = null;
      if (_wsReconnectTimer) clearTimeout(_wsReconnectTimer);
      _wsReconnectTimer = setTimeout(connectWs, 5000);
    };
    _ws.onerror = (e) => console.warn("[backend ws] error", e);
  } catch (e) {
    console.warn("[backend ws] connect fail, retry 5s", e);
    _wsReconnectTimer = setTimeout(connectWs, 5000);
  }
}

export async function startWs(): Promise<void> {
  if (_ws && _ws.readyState !== WebSocket.CLOSED) return;
  await connectWs();
}

export function stopWs(): void {
  if (_wsReconnectTimer) clearTimeout(_wsReconnectTimer);
  _wsReconnectTimer = null;
  if (_ws) { _ws.close(); _ws = null; }
}

export function onWsMessage(fn: WsHandler): () => void {
  _wsHandlers.add(fn);
  return () => _wsHandlers.delete(fn);
}
