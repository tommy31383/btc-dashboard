/**
 * tomiHedgeEngine.ts (anh Tommy v0.4.0) — Binance HEDGE + CROSS architecture.
 *
 * 2 NET positions độc lập (LONG + SHORT) cho 1 symbol:
 *   - Same-side ADD → MERGE weighted avg entry
 *   - PARTIAL CLOSE → giữ avg_entry (chỉ giảm qty)
 *   - PnL = chênh avg_entry vs current/exit price
 *   - LIQ = NET direction (1 LIQ duy nhất)
 *
 * Layered:
 *   - tomiHedgeEngine = ARCHITECTURE (position management, NO entry/close logic)
 *   - rules/hedge01.ts = INSTANCE (entry/close logic, designed by Tommy)
 *
 * State per engine instance (real + paper share schema):
 */
import { Candle as Kline } from "../backtester";

export interface NetPosition {
  qty: number;          // BTC (LONG positive, SHORT positive — convention)
  avgEntry: number;     // weighted avg
  notionalAtEntry: number;  // sum of (add_qty × add_price) — for fee tracking
  totalAdds: number;    // số lần ADD (cho stats)
}

export function emptyNet(): NetPosition {
  return { qty: 0, avgEntry: 0, notionalAtEntry: 0, totalAdds: 0 };
}

/** Add qty (positive) to net position with weighted avg merge. */
export function addToNet(net: NetPosition, addQty: number, addPrice: number): NetPosition {
  if (addQty <= 0) return net;
  const newQty = net.qty + addQty;
  const newAvg = newQty > 0
    ? (net.qty * net.avgEntry + addQty * addPrice) / newQty
    : 0;
  return {
    qty: newQty,
    avgEntry: newAvg,
    notionalAtEntry: net.notionalAtEntry + addQty * addPrice,
    totalAdds: net.totalAdds + 1,
  };
}

/** Partial close — giữ avg_entry NGUYÊN (KHÔNG đổi), chỉ giảm qty.
 *  Returns: { net_remain, realizedPnl } */
export function partialClose(
  side: "LONG" | "SHORT",
  net: NetPosition,
  closeQty: number,
  closePrice: number,
): { net: NetPosition; realizedGrossPnl: number } {
  if (closeQty <= 0 || net.qty <= 0) return { net, realizedGrossPnl: 0 };
  const actualClose = Math.min(closeQty, net.qty);
  const remainQty = net.qty - actualClose;
  const realized = side === "LONG"
    ? actualClose * (closePrice - net.avgEntry)
    : actualClose * (net.avgEntry - closePrice);
  return {
    net: {
      qty: remainQty,
      avgEntry: remainQty > 0 ? net.avgEntry : 0, // reset avg if fully closed
      notionalAtEntry: net.notionalAtEntry, // keep history (read-only stat)
      totalAdds: net.totalAdds,
    },
    realizedGrossPnl: realized,
  };
}

/** Close ALL — full liquidate side. */
export function closeAll(
  side: "LONG" | "SHORT",
  net: NetPosition,
  closePrice: number,
): { net: NetPosition; realizedGrossPnl: number } {
  return partialClose(side, net, net.qty, closePrice);
}

// === LIQ — NET direction (1 cái duy nhất, không per-side) ===
const MAINT_MARGIN_RATE = 0.004; // BTCUSDT tier 0

export interface AccountLiq {
  liqPrice: number | null;
  netQty: number;            // signed
  netEntry: number;          // weighted break-even
  netDirection: "LONG" | "SHORT" | "HEDGED";
}

export function computeAccountLiq(
  longNet: NetPosition,
  shortNet: NetPosition,
  wallet: number,
  markPrice: number | null,
): AccountLiq {
  const netQty = longNet.qty - shortNet.qty;
  if (Math.abs(netQty) < 1e-9) {
    return { liqPrice: null, netQty: 0, netEntry: 0, netDirection: "HEDGED" };
  }
  const netEntry = (longNet.qty * longNet.avgEntry - shortNet.qty * shortNet.avgEntry) / netQty;
  const mp = markPrice && markPrice > 0 ? markPrice : netEntry;
  const netNotional = Math.abs(netQty) * mp;
  const longNotional = longNet.qty * mp;
  const shortNotional = shortNet.qty * mp;
  const mmTotal = (longNotional + shortNotional) * MAINT_MARGIN_RATE;
  const buffer = wallet - mmTotal;
  if (buffer <= 0) return { liqPrice: netEntry, netQty, netEntry, netDirection: netQty > 0 ? "LONG" : "SHORT" };

  const lossRatio = buffer / netNotional;
  const liqPrice = netQty > 0
    ? netEntry * (1 - lossRatio)
    : netEntry * (1 + lossRatio);

  return {
    liqPrice: liqPrice > 0 ? liqPrice : null,
    netQty, netEntry,
    netDirection: netQty > 0 ? "LONG" : "SHORT",
  };
}

// === Engine state (real + paper instance schema) ===

export interface TomiHedgeState {
  /** ID engine instance: "real" or "paper" */
  engineId: string;
  /** Active rule key (vd "hedge01") */
  activeRuleKey: string;
  /** Wallet/capital USDT */
  wallet: number;
  /** Initial capital (cho ROI calc, paper only) */
  initialCapital: number;
  /** 2 NET positions */
  longNet: NetPosition;
  shortNet: NetPosition;
  /** Stats */
  totalRealizedPnl: number;
  totalFeesPaid: number;
  totalAddsLong: number;
  totalAddsShort: number;
  totalCloses: number;
  /** Last bar evaluated (avoid double-fire same bar) */
  lastBar5mTime: number;
  /** Last entry timestamp (cho cooldown nếu rule cần) */
  lastEntryMs: number;
  /** Reset timestamp */
  resetAt: number;
}

export function emptyTomiHedgeState(engineId: string, ruleKey: string, capital: number): TomiHedgeState {
  return {
    engineId, activeRuleKey: ruleKey,
    wallet: capital, initialCapital: capital,
    longNet: emptyNet(), shortNet: emptyNet(),
    totalRealizedPnl: 0, totalFeesPaid: 0,
    totalAddsLong: 0, totalAddsShort: 0, totalCloses: 0,
    lastBar5mTime: 0, lastEntryMs: 0,
    resetAt: Date.now(),
  };
}

// === Rule interface — Hedge01 etc implement this ===

export interface RuleContext {
  state: TomiHedgeState;
  c5: Kline[];        // 5m candles (full history)
  c15: Kline[];       // 15m candles
  c1h?: Kline[];      // 1h candles (optional cho HTF filter)
  markPrice: number;
  walletBalance: number; // for real: Binance wallet; paper: state.wallet
}

export interface RuleEntrySignal {
  side: "LONG" | "SHORT";
  notionalUsd: number;  // size USDT mỗi ADD (vd $77 = 0.001 BTC × $77k)
}

export interface RuleCloseSignal {
  side: "LONG" | "SHORT";
  closeMode: "ALL" | "PARTIAL_QTY" | "PARTIAL_USD";
  amount?: number;  // qty BTC (PARTIAL_QTY) hoặc USDT (PARTIAL_USD)
}

export interface TomiHedgeRule {
  key: string;
  name: string;
  description: string;
  /** Eval entry — return signal hoặc null (no entry this tick) */
  evalEntry(ctx: RuleContext): RuleEntrySignal | null;
  /** Eval close — return signal hoặc null (no close this tick).
   *  Có thể return array để close cả 2 sides nếu rule muốn */
  evalClose(ctx: RuleContext): RuleCloseSignal | RuleCloseSignal[] | null;
}
