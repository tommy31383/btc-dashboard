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

/** v4.9.19 (anh Tommy fix): Binance hedge cross — chỉ 1 LIQ duy nhất theo NET direction.
 *  Khi net_long (qty_L > qty_S): giá tăng = lời, KHÔNG liq → chỉ liq khi giá xuống.
 *  Khi net_short: ngược lại.
 *  Khi hedged (qty_L = qty_S): không có liq.
 *
 *  Formula:
 *    net_qty       = qty_LONG - qty_SHORT
 *    net_entry     = (qty_L × entry_L - qty_S × entry_S) / net_qty   (break-even)
 *    net_notional  = |net_qty| × markPrice
 *    mm_total      = (notional_L + notional_S) × MMR
 *    buffer        = wallet - mm_total
 *
 *    if net_qty > 0:  LIQ = net_entry × (1 - buffer / net_notional)  (giá xuống)
 *    if net_qty < 0:  LIQ = net_entry × (1 + buffer / net_notional)  (giá lên)
 */
interface AccountLiq {
  liqPrice: number | null;
  netQty: number;
  netEntry: number;
  netDirection: "LONG" | "SHORT" | "HEDGED";
  liqDistPct: number | null;
}

function computeAccountLiq(
  longNet: NetSide, shortNet: NetSide,
  wallet: number, markPrice: number | null,
): AccountLiq {
  const qtyL = longNet.totalQty;
  const qtyS = shortNet.totalQty;
  const netQty = qtyL - qtyS;

  if (Math.abs(netQty) < 1e-9) {
    return { liqPrice: null, netQty: 0, netEntry: 0, netDirection: "HEDGED", liqDistPct: null };
  }

  const netEntry = (qtyL * longNet.avgEntry - qtyS * shortNet.avgEntry) / netQty;
  const mp = markPrice && markPrice > 0 ? markPrice : netEntry;
  const netNotional = Math.abs(netQty) * mp;
  const mmTotal = (longNet.notional + shortNet.notional) * MAINT_MARGIN_RATE;
  const buffer = wallet - mmTotal;

  if (buffer <= 0) {
    return { liqPrice: netEntry, netQty, netEntry, netDirection: netQty > 0 ? "LONG" : "SHORT", liqDistPct: 0 };
  }

  const lossRatio = buffer / netNotional;
  const liqPrice = netQty > 0
    ? netEntry * (1 - lossRatio)
    : netEntry * (1 + lossRatio);

  // Liq price âm hoặc vô lý (>10x markPrice) → coi như no-liq
  let liqDistPct: number | null = null;
  let finalLiq: number | null = liqPrice;
  if (liqPrice <= 0 || (mp && liqPrice > mp * 10)) {
    finalLiq = null;
  } else if (mp) {
    liqDistPct = Math.abs(liqPrice - mp) / mp * 100;
  }

  return {
    liqPrice: finalLiq, netQty, netEntry,
    netDirection: netQty > 0 ? "LONG" : "SHORT",
    liqDistPct,
  };
}

export default function ConsolidatedPositions({ positions, markPrice, walletUsd, marginUsd, leverage, title, note }: Props) {
  const longNet = consolidate(positions, "LONG", markPrice, marginUsd, leverage);
  const shortNet = consolidate(positions, "SHORT", markPrice, marginUsd, leverage);

  // v4.9.19: tính Account-level liq dựa trên NET direction (anh Tommy fix)
  const accountLiq = walletUsd !== null
    ? computeAccountLiq(longNet, shortNet, walletUsd, markPrice)
    : null;

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
              {/* v4.9.19: bỏ liq per-side (sai logic). LIQ chỉ ở Net Position card phía dưới. */}
            </View>
          );
        })}
      </View>

      {/* v4.9.19: Account-level LIQ card (đúng logic hedge cross) */}
      {accountLiq && (longNet.count > 0 || shortNet.count > 0) && (() => {
        const dirColor = accountLiq.netDirection === "LONG" ? P.green : (accountLiq.netDirection === "SHORT" ? P.error : P.dim);
        const liqDanger = accountLiq.liqDistPct !== null && accountLiq.liqDistPct < 5;
        return (
          <View style={[styles.accountLiqCard, { borderColor: dirColor + "88" }]}>
            <Text style={[styles.h2, { marginBottom: 6, color: dirColor }]}>
              🌐 ACCOUNT NET — {accountLiq.netDirection === "HEDGED" ? "⚖️ HEDGED" : `${accountLiq.netDirection === "LONG" ? "🟢" : "🔴"} NET ${accountLiq.netDirection}`}
            </Text>
            {accountLiq.netDirection === "HEDGED" ? (
              <Text style={styles.empty}>2 side qty bằng nhau → KHÔNG có LIQ (hedged hoàn toàn)</Text>
            ) : (
              <View style={{ gap: 3 }}>
                <View style={styles.kvRow}>
                  <Text style={styles.k}>net qty:</Text>
                  <Text style={styles.v}>{Math.abs(accountLiq.netQty).toFixed(4)} BTC ({accountLiq.netDirection})</Text>
                </View>
                <View style={styles.kvRow}>
                  <Text style={styles.k}>break-even:</Text>
                  <Text style={styles.v}>${accountLiq.netEntry.toFixed(0)}</Text>
                </View>
                <View style={[styles.kvRow, { marginTop: 4, paddingTop: 4, borderTopWidth: 1, borderTopColor: P.border + "33" }]}>
                  <Text style={[styles.k, { fontSize: 11 }]}>💀 ACCOUNT LIQ:</Text>
                  <Text style={[styles.v, { color: liqDanger ? P.error : P.bitcoinOrange, fontWeight: "900", fontSize: 13 }]}>
                    {accountLiq.liqPrice === null
                      ? "∞ safe"
                      : `$${accountLiq.liqPrice.toFixed(0)}`}
                    {accountLiq.liqDistPct !== null && (
                      <Text style={{ color: liqDanger ? P.error : P.dim, fontSize: 10 }}>
                        {" "}({accountLiq.liqDistPct.toFixed(2)}% {accountLiq.netDirection === "LONG" ? "↓" : "↑"}{liqDanger ? " ⚠️" : ""})
                      </Text>
                    )}
                  </Text>
                </View>
                <Text style={[styles.note, { marginTop: 2 }]}>
                  📌 Net {accountLiq.netDirection.toLowerCase()} → liq CHỈ khi giá {accountLiq.netDirection === "LONG" ? "GIẢM xuống" : "TĂNG lên"} ${accountLiq.liqPrice?.toFixed(0) ?? "—"}.
                  Hướng ngược lại: {accountLiq.netDirection === "LONG" ? "giá tăng = LỜI" : "giá giảm = LỜI"} → KHÔNG liq.
                </Text>
              </View>
            )}
          </View>
        );
      })()}

      {note && <Text style={styles.note}>{note}</Text>}
      <Text style={styles.note}>
        💡 ACCOUNT LIQ tính theo NET position: net_qty = qty_L − qty_S. Net long → liq khi giá XUỐNG. Net short → liq khi giá LÊN. Hedge cross: 2 side share wallet, lời/lỗ bù trừ. MMR=0.4% (tier 0 BTCUSDT).
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
  accountLiqCard: { marginTop: 10, borderWidth: 2, borderRadius: 6, padding: 10 },
});
