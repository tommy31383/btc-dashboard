/**
 * ConsolidatedPositions — gộp tất cả OPEN positions thành 2 NET LONG + NET SHORT
 * (giống Binance hedge mode display).
 *
 * Mỗi side hiển thị:
 *   - Total qty (BTC)
 *   - Avg entry (weighted by qty)
 *   - Mark price (current)
 *   - uPnL ($+%)
 *   - Notional ($)
 *   - Margin used ($)
 *   - Estimated LIQ price (cross margin formula)
 *   - N positions summed
 *
 * Used trong:
 *   - All5mPanel (5m ALL local paper)
 *   - PresetOpenList (server paper view)
 *   - ServerTab REAL view (override với binanceSnapshot.positions data thực)
 */
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { P } from "../utils/v2Theme";

// Binance Futures USDT-M tier 0 maintenance margin rate (BTCUSDT)
const MAINT_MARGIN_RATE = 0.004; // 0.4%

interface RawPosition {
  side: "LONG" | "SHORT";
  entryPrice: number;
  qty?: number;          // BTC qty (paper: notional/entry, real: positionAmt)
  notional?: number;     // alternative input (paper)
}

interface Props {
  positions: RawPosition[];      // tất cả OPEN positions của engine
  markPrice: number | null;
  /** Wallet/capital total (cross collateral) — để tính liq price.
   *  Paper: paper.capital. Real: account.totalWalletBalance. */
  walletUsd: number | null;
  /** Notional fallback: dùng nếu position không có qty/notional rõ */
  marginUsd: number;
  leverage: number;
  /** Override label cho header (vd "📋 PAPER NET POSITIONS" vs "🔴 REAL NET POSITIONS") */
  title?: string;
  /** Tooltip / footer note */
  note?: string;
}

interface NetSide {
  count: number;
  totalQty: number;
  avgEntry: number;
  notional: number;       // qty × markPrice (current)
  marginUsed: number;     // notional / leverage
  upnlUsd: number;
  upnlPct: number;        // % so với margin used
  liqPrice: number | null;
}

function consolidate(positions: RawPosition[], side: "LONG" | "SHORT", markPrice: number | null, marginUsd: number, leverage: number): NetSide {
  const filtered = positions.filter((p) => p.side === side);
  if (filtered.length === 0) {
    return { count: 0, totalQty: 0, avgEntry: 0, notional: 0, marginUsed: 0, upnlUsd: 0, upnlPct: 0, liqPrice: null };
  }
  let totalQty = 0;
  let qtyEntry = 0; // sum of qty × entryPrice for weighted avg
  for (const p of filtered) {
    const qty = p.qty ?? (p.notional ? p.notional / p.entryPrice : (marginUsd * leverage) / p.entryPrice);
    totalQty += qty;
    qtyEntry += qty * p.entryPrice;
  }
  const avgEntry = qtyEntry / totalQty;
  const mp = markPrice && markPrice > 0 ? markPrice : avgEntry;
  const notional = totalQty * mp;
  const marginUsed = notional / leverage;
  const rawPct = side === "LONG" ? (mp - avgEntry) / avgEntry * 100 : (avgEntry - mp) / avgEntry * 100;
  const upnlUsd = notional * rawPct / 100;
  const upnlPct = marginUsed > 0 ? (upnlUsd / marginUsed) * 100 : 0;
  return { count: filtered.length, totalQty, avgEntry, notional, marginUsed, upnlUsd, upnlPct, liqPrice: null };
}

/** v4.9.18 (anh Tommy): Binance HEDGE cross liq — 2 sides SHARE wallet, hedge nhau.
 *  Formula (per Binance Futures docs):
 *    buffer = wallet + uPnL_OTHER_side - maint_margin_TOTAL
 *    LIQ_LONG  = avg_entry_LONG  × (1 - buffer / notional_LONG)
 *    LIQ_SHORT = avg_entry_SHORT × (1 + buffer / notional_SHORT)
 *    maint_margin_TOTAL = (notional_LONG + notional_SHORT) × MMR
 *
 *  Khi qty_LONG ≈ qty_SHORT (perfectly hedged) → buffer rất lớn → LIQ practically infinite (đúng logic Binance).
 *  Note: uPnL_other tại current markPrice là estimate; thực tế LIQ thay đổi khi price move.
 */
function computeLiqPriceHedge(
  side: "LONG" | "SHORT",
  netThis: NetSide,
  netOther: NetSide,
  wallet: number,
): number | null {
  if (netThis.count === 0 || netThis.notional === 0) return null;
  const maintMarginTotal = (netThis.notional + netOther.notional) * MAINT_MARGIN_RATE;
  // uPnL của side bên kia HỖ TRỢ collateral khi side này thua (hedge benefit)
  const buffer = wallet + netOther.upnlUsd - maintMarginTotal;
  if (buffer <= 0) return netThis.avgEntry; // already past liq
  const lossRatio = buffer / netThis.notional;
  return side === "LONG"
    ? netThis.avgEntry * (1 - lossRatio)
    : netThis.avgEntry * (1 + lossRatio);
}

export default function ConsolidatedPositions({ positions, markPrice, walletUsd, marginUsd, leverage, title, note }: Props) {
  const longNet = consolidate(positions, "LONG", markPrice, marginUsd, leverage);
  const shortNet = consolidate(positions, "SHORT", markPrice, marginUsd, leverage);

  if (walletUsd !== null) {
    // v4.9.18: hedge cross — pass other side cho mỗi liq computation
    longNet.liqPrice = computeLiqPriceHedge("LONG", longNet, shortNet, walletUsd);
    shortNet.liqPrice = computeLiqPriceHedge("SHORT", shortNet, longNet, walletUsd);
  }

  const totalUpnl = longNet.upnlUsd + shortNet.upnlUsd;

  return (
    <View style={styles.card}>
      <Text style={styles.h2}>
        {title ?? "🏦 NET POSITIONS (Binance hedge gộp)"}{" "}
        <Text style={{ color: totalUpnl >= 0 ? P.green : P.error, fontWeight: "700" }}>
          · TỔNG uPnL {totalUpnl >= 0 ? "+" : ""}${totalUpnl.toFixed(2)}
        </Text>
      </Text>

      <View style={styles.row}>
        {(["LONG", "SHORT"] as const).map((side) => {
          const net = side === "LONG" ? longNet : shortNet;
          const sideColor = side === "LONG" ? P.green : P.error;
          const upnlColor = net.upnlUsd >= 0 ? P.green : P.error;
          if (net.count === 0) {
            return (
              <View key={side} style={[styles.netCard, { borderColor: sideColor + "55" }]}>
                <Text style={[styles.sideTitle, { color: sideColor }]}>
                  {side === "LONG" ? "🟢" : "🔴"} {side} NET · trống
                </Text>
                <Text style={styles.empty}>không có position</Text>
              </View>
            );
          }
          // Distance to LIQ %
          const liqDistPct = net.liqPrice !== null && markPrice
            ? Math.abs(net.liqPrice - markPrice) / markPrice * 100
            : null;
          const liqDanger = liqDistPct !== null && liqDistPct < 1.5; // < 1.5% → đỏ alert

          return (
            <View key={side} style={[styles.netCard, { borderColor: sideColor + "88", backgroundColor: sideColor + "08" }]}>
              <Text style={[styles.sideTitle, { color: sideColor }]}>
                {side === "LONG" ? "🟢" : "🔴"} {side} NET · {net.count} entries
              </Text>
              <View style={styles.kvRow}>
                <Text style={styles.k}>size:</Text>
                <Text style={styles.v}>${net.notional.toFixed(0)} USDT <Text style={{ color: P.dim, fontSize: 9 }}>({net.totalQty.toFixed(4)} BTC)</Text></Text>
              </View>
              <View style={styles.kvRow}>
                <Text style={styles.k}>avg entry:</Text>
                <Text style={styles.v}>${net.avgEntry.toFixed(0)}</Text>
              </View>
              <View style={styles.kvRow}>
                <Text style={styles.k}>mark:</Text>
                <Text style={styles.v}>${markPrice ? markPrice.toFixed(0) : "—"}</Text>
              </View>
              <View style={styles.kvRow}>
                <Text style={styles.k}>margin used:</Text>
                <Text style={styles.v}>${net.marginUsed.toFixed(2)} USDT</Text>
              </View>
              <View style={styles.kvRow}>
                <Text style={styles.k}>uPnL:</Text>
                <Text style={[styles.v, { color: upnlColor, fontWeight: "700" }]}>
                  {net.upnlUsd >= 0 ? "+" : ""}${net.upnlUsd.toFixed(2)} ({net.upnlPct >= 0 ? "+" : ""}{net.upnlPct.toFixed(1)}%)
                </Text>
              </View>
              <View style={[styles.kvRow, { marginTop: 4, paddingTop: 4, borderTopWidth: 1, borderTopColor: P.border + "33" }]}>
                <Text style={styles.k}>💀 LIQ price:</Text>
                <Text style={[styles.v, { color: liqDanger ? P.error : P.bitcoinOrange, fontWeight: "700" }]}>
                  {/* v4.9.18: nếu liq < 0 hoặc > 10x markPrice = perfectly hedged → ∞ */}
                  {net.liqPrice === null
                    ? "—"
                    : (net.liqPrice <= 0 || (markPrice && net.liqPrice > markPrice * 10))
                      ? "∞ hedged"
                      : `$${net.liqPrice.toFixed(0)}`}
                  {liqDistPct !== null && net.liqPrice !== null && net.liqPrice > 0 && markPrice && net.liqPrice <= markPrice * 10 && (
                    <Text style={{ color: liqDanger ? P.error : P.dim, fontSize: 10 }}>
                      {" "}({liqDistPct.toFixed(2)}% away{liqDanger ? " ⚠️" : ""})
                    </Text>
                  )}
                </Text>
              </View>
            </View>
          );
        })}
      </View>

      {note && <Text style={styles.note}>{note}</Text>}
      <Text style={styles.note}>
        💡 LIQ ước tính theo BINANCE HEDGE CROSS — buffer = wallet + uPnL_other − maint_total. Khi 2 side hedge nhau → LIQ ∞ (an toàn). MMR=0.4% tier 0 BTCUSDT.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: P.surface, borderRadius: 6, padding: 12, marginBottom: 14, borderWidth: 1, borderColor: P.border },
  h2: { color: P.text, fontSize: 13, fontWeight: "700", marginBottom: 10, fontFamily: "monospace" },
  row: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  netCard: { flex: 1, minWidth: 240, borderWidth: 1, borderRadius: 6, padding: 10, gap: 3 },
  sideTitle: { fontSize: 12, fontWeight: "700", marginBottom: 6, fontFamily: "monospace" },
  empty: { color: P.dim, fontSize: 11, fontStyle: "italic", paddingVertical: 4 },
  kvRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 1 },
  k: { color: P.dim, fontSize: 10, fontFamily: "monospace" },
  v: { color: P.text, fontSize: 11, fontFamily: "monospace", fontWeight: "600" },
  note: { color: P.dim, fontSize: 9, fontFamily: "monospace", marginTop: 8, fontStyle: "italic" },
});
