/**
 * binanceLive.ts — Binance USDT-M Futures REST client (browser-only).
 *
 * Auth: HMAC-SHA256 qua Web Crypto API (subtle.crypto). Hoạt động trên Expo Web.
 *
 * IMPORTANT: API key của Tommy phải DISABLE quyền "Withdrawal" — chỉ enable
 * "Enable Futures" + "Enable Trading". Không có Withdrawal = ngay cả khi key
 * leak, attacker không rút tiền được.
 *
 * Endpoints chính:
 *   GET  /fapi/v2/account            — balance + positions tổng quan
 *   GET  /fapi/v2/positionRisk       — chi tiết từng position
 *   POST /fapi/v1/leverage           — set leverage
 *   POST /fapi/v1/order              — đặt lệnh MARKET / TP_MARKET / STOP_MARKET
 *   DELETE /fapi/v1/order            — huỷ lệnh
 *   GET  /fapi/v1/income             — lấy realized PnL today để tính dailyPnl
 *   GET  /fapi/v1/exchangeInfo       — lấy minQty/precision (cache 1 giờ)
 */

const BASE = "https://fapi.binance.com";

export interface Credentials {
  apiKey: string;
  apiSecret: string;
}

async function hmacSHA256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    parts.push(`${k}=${encodeURIComponent(String(v))}`);
  }
  return parts.join("&");
}

async function signedRequest<T>(
  cred: Credentials,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, string | number | undefined> = {},
): Promise<T> {
  const ts = Date.now();
  const allParams = { ...params, timestamp: ts, recvWindow: 5000 };
  const query = buildQuery(allParams);
  const sig = await hmacSHA256Hex(cred.apiSecret, query);
  const url = `${BASE}${path}?${query}&signature=${sig}`;
  const res = await fetch(url, {
    method,
    headers: { "X-MBX-APIKEY": cred.apiKey },
  });
  const text = await res.text();
  let data: any = {};
  try { data = JSON.parse(text); } catch { /* keep text */ }
  if (!res.ok) {
    const code = data?.code ?? res.status;
    const msg = data?.msg ?? text;
    throw new Error(`Binance ${method} ${path} → ${code}: ${msg}`);
  }
  return data as T;
}

// ── Public types (subset of Binance response) ──────────────────────────────

export interface AccountSnapshot {
  totalWalletBalance: string;
  totalUnrealizedProfit: string;
  totalMarginBalance: string;
  availableBalance: string;
  feeTier?: number;
  canTrade?: boolean;
  canDeposit?: boolean;
  canWithdraw?: boolean;
  multiAssetsMargin?: boolean;
  totalInitialMargin?: string;
  totalMaintMargin?: string;
  accountAlias?: string;     // Binance random 4-8 char ID per futures account
}

export async function getMultiAssetsMode(cred: Credentials): Promise<boolean> {
  const res = await signedRequest<{ multiAssetsMargin: boolean }>(cred, "GET", "/fapi/v1/multiAssetsMargin");
  return res.multiAssetsMargin === true;
}

export interface PositionRisk {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  liquidationPrice: string;
  unRealizedProfit: string;
  leverage: string;
  positionSide: "BOTH" | "LONG" | "SHORT";
}

export interface IncomeRow {
  symbol: string;
  incomeType: string; // REALIZED_PNL, COMMISSION, FUNDING_FEE
  income: string;     // signed
  time: number;
}

export interface OrderResponse {
  orderId: number;
  symbol: string;
  status: string;
  clientOrderId: string;
  price: string;
  origQty: string;
  type: string;
  side: "BUY" | "SELL";
}

// ── API ─────────────────────────────────────────────────────────────────────

export async function testConnection(cred: Credentials): Promise<AccountSnapshot> {
  return signedRequest<AccountSnapshot>(cred, "GET", "/fapi/v2/account");
}

export async function getPositions(cred: Credentials, symbol = "BTCUSDT"): Promise<PositionRisk[]> {
  return signedRequest<PositionRisk[]>(cred, "GET", "/fapi/v2/positionRisk", { symbol });
}

export async function setLeverage(cred: Credentials, symbol: string, leverage: number): Promise<unknown> {
  return signedRequest(cred, "POST", "/fapi/v1/leverage", { symbol, leverage });
}

/** Check account dual-side (Hedge Mode) — returns true nếu account ở Hedge Mode. */
export async function getDualSidePosition(cred: Credentials): Promise<boolean> {
  const res = await signedRequest<{ dualSidePosition: boolean }>(cred, "GET", "/fapi/v1/positionSide/dual");
  return res.dualSidePosition === true;
}

export async function placeMarketOrder(
  cred: Credentials,
  symbol: string,
  side: "BUY" | "SELL",
  quantity: number,
  positionSide?: "LONG" | "SHORT" | "BOTH",
): Promise<OrderResponse> {
  const params: Record<string, string | number> = {
    symbol, side, type: "MARKET",
    quantity: quantity.toString(),
  };
  if (positionSide) params.positionSide = positionSide;
  return signedRequest<OrderResponse>(cred, "POST", "/fapi/v1/order", params);
}

/** STOP_MARKET dùng reduceOnly+quantity (One-way) hoặc positionSide (Hedge — không kèm reduceOnly) */
export async function placeStopMarket(
  cred: Credentials,
  symbol: string,
  side: "BUY" | "SELL",
  stopPrice: number,
  quantity: number,
  positionSide?: "LONG" | "SHORT" | "BOTH",
): Promise<OrderResponse> {
  const params: Record<string, string | number> = {
    symbol, side,
    type: "STOP_MARKET",
    stopPrice: stopPrice.toString(),
    quantity: quantity.toString(),
    workingType: "MARK_PRICE",
  };
  if (positionSide && positionSide !== "BOTH") {
    params.positionSide = positionSide;
    // Hedge mode KHÔNG dùng reduceOnly (positionSide đã định nghĩa side)
  } else {
    params.reduceOnly = "true";
  }
  return signedRequest<OrderResponse>(cred, "POST", "/fapi/v1/order", params);
}

export async function placeTakeProfitMarket(
  cred: Credentials,
  symbol: string,
  side: "BUY" | "SELL",
  stopPrice: number,
  quantity: number,
  positionSide?: "LONG" | "SHORT" | "BOTH",
): Promise<OrderResponse> {
  const params: Record<string, string | number> = {
    symbol, side,
    type: "TAKE_PROFIT_MARKET",
    stopPrice: stopPrice.toString(),
    quantity: quantity.toString(),
    workingType: "MARK_PRICE",
  };
  if (positionSide && positionSide !== "BOTH") {
    params.positionSide = positionSide;
  } else {
    params.reduceOnly = "true";
  }
  return signedRequest<OrderResponse>(cred, "POST", "/fapi/v1/order", params);
}

export interface OpenOrder {
  orderId: number;
  symbol: string;
  side: "BUY" | "SELL";
  type: string;
  origQty: string;
  price: string;
  stopPrice: string;
  status: string;
  reduceOnly: boolean;
  closePosition: boolean;
  time: number;
}

export interface UserTrade {
  id: number;
  symbol: string;
  side: "BUY" | "SELL";
  qty: string;
  price: string;
  realizedPnl: string;
  commission: string;
  time: number;
}

export async function getOpenOrders(cred: Credentials, symbol = "BTCUSDT"): Promise<OpenOrder[]> {
  return signedRequest<OpenOrder[]>(cred, "GET", "/fapi/v1/openOrders", { symbol });
}

export async function getRecentTrades(cred: Credentials, symbol = "BTCUSDT", limit = 50): Promise<UserTrade[]> {
  return signedRequest<UserTrade[]>(cred, "GET", "/fapi/v1/userTrades", { symbol, limit });
}

/** Realized PnL hôm nay (UTC). Sum incomeType=REALIZED_PNL + COMMISSION + FUNDING_FEE */
export async function getDailyPnl(cred: Credentials, symbol = "BTCUSDT"): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const rows = await signedRequest<IncomeRow[]>(cred, "GET", "/fapi/v1/income", {
    symbol,
    startTime: startOfDay.getTime(),
    limit: 1000,
  });
  let sum = 0;
  for (const r of rows) sum += parseFloat(r.income);
  return sum;
}

/** Tính quantity từ notional + price, làm tròn 3 chữ số (BTCUSDT precision = 0.001 BTC) */
export function notionalToQty(notionalUsd: number, price: number): number {
  const qty = notionalUsd / price;
  return Math.max(0.001, Math.floor(qty * 1000) / 1000);
}
