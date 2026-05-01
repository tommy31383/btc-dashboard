/**
 * PresetOpenList — render OPEN positions list cho PRESET ENGINE.
 * View=real → từ state.trackedPositions (Binance app-tracked)
 * View=paper → từ state.paperEngine.positions filter status=OPEN
 *
 * Format giống All5mPanel.tsx (anh Tommy yêu cầu UI giống nhau).
 */
import React, { useMemo } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from "react-native";
import { P } from "../utils/v2Theme";
import { ToggleView } from "./PresetEnginePanel";

interface Props {
  view: ToggleView;
  state: any;
  markPrice: number | null;
}

interface NormalizedPos {
  id: string;
  side: "LONG" | "SHORT";
  source: string;             // "stoch_long" | "sr_long" ...
  entryPrice: number;
  entryMs: number;
  tpPrice: number;
  slPrice: number;
  notional: number;           // size USD
}

function fmtUsd(v: number, signed = false): string {
  const sign = signed && v >= 0 ? "+" : "";
  return `${sign}$${v.toFixed(2)}`;
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fmtHeld(entryMs: number): string {
  const ms = Date.now() - entryMs;
  const h = ms / 3600_000;
  if (h < 1) return `${(ms / 60_000).toFixed(0)}m`;
  if (h < 24) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

export default function PresetOpenList({ view, state, markPrice }: Props) {
  const cfg = state?.settings || {};

  const data = useMemo<{ positions: NormalizedPos[]; isPaper: boolean; marginUsd: number; leverage: number }>(() => {
    if (view === "paper") {
      const paper = state?.paperEngine;
      const open = (paper?.positions || []).filter((p: any) => p.status === "OPEN");
      const margin = cfg.paperMarginUsd ?? 1;
      const lev = cfg.paperLeverage ?? 125;
      const positions: NormalizedPos[] = open.map((p: any) => ({
        id: p.id, side: p.side, source: p.source || "?",
        entryPrice: p.entryPrice, entryMs: p.entryMs,
        tpPrice: p.tpPrice, slPrice: p.slPrice,
        notional: margin * lev,
      }));
      return { positions, isPaper: true, marginUsd: margin, leverage: lev };
    }
    // REAL — từ trackedPositions
    const tracked = state?.trackedPositions || [];
    const margin = cfg.marginUsd ?? 1;
    const lev = cfg.leverage ?? 125;
    const positions: NormalizedPos[] = tracked.map((p: any) => ({
      id: p.id, side: p.side, source: (p.tfKey === "5m" ? "preset" : "htf"),
      entryPrice: p.entryPrice, entryMs: p.entryMs,
      tpPrice: p.tpPrice, slPrice: p.slPrice,
      notional: p.qty ? p.qty * p.entryPrice : margin * lev,
    }));
    return { positions, isPaper: false, marginUsd: margin, leverage: lev };
  }, [view, state, cfg.paperMarginUsd, cfg.paperLeverage, cfg.marginUsd, cfg.leverage]);

  const { positions, isPaper, marginUsd, leverage } = data;

  // v0.3.2 (anh Tommy): Binance MARKET = TAKER 0.05%/side, trừ NGAY khi fill.
  // Entry fee đã trừ vào capital lúc fill → uPnL realtime CHỈ trừ exit fee (sẽ trừ khi close).
  // pnlUsd net của position = gross - entryFee (đã trừ rồi) - exitFee (estimate lúc display).
  const FEE_PER_SIDE_PCT = 0.05;

  // v4.9.12 (anh Tommy fix): add isLiquidated flag để UI show 💀 LIQ badge
  const enriched = useMemo(() => {
    return positions.map((p) => {
      let upnlPct: number | null = null;
      let upnlUsd: number | null = null;
      let upnlPctOnMargin: number | null = null;
      let exitFeeEst: number | null = null;
      let isLiquidated = false;
      if (markPrice && markPrice > 0) {
        const rawPct = p.side === "LONG" ? (markPrice - p.entryPrice) / p.entryPrice * 100 : (p.entryPrice - markPrice) / p.entryPrice * 100;
        upnlPct = rawPct;
        let gross = p.notional * rawPct / 100;
        if (gross <= -marginUsd) { gross = -marginUsd; isLiquidated = true; }
        const qty = p.notional / p.entryPrice;
        exitFeeEst = qty * markPrice * (FEE_PER_SIDE_PCT / 100);
        let net = gross - exitFeeEst;
        if (net < -marginUsd) net = -marginUsd;
        upnlUsd = net;
        if (marginUsd > 0) upnlPctOnMargin = net / marginUsd * 100;
      }
      return { ...p, upnlPct, upnlUsd, upnlPctOnMargin, feeRoundTrip: exitFeeEst, isLiquidated };
    });
  }, [positions, markPrice, marginUsd]);

  const longs = enriched.filter((p) => p.side === "LONG");
  const shorts = enriched.filter((p) => p.side === "SHORT");
  const totalUpnl = enriched.reduce((s, p) => s + (p.upnlUsd ?? 0), 0);
  const longUpnl = longs.reduce((s, p) => s + (p.upnlUsd ?? 0), 0);
  const shortUpnl = shorts.reduce((s, p) => s + (p.upnlUsd ?? 0), 0);

  if (positions.length === 0) {
    return (
      <View style={styles.card}>
        <Text style={styles.h2}>{isPaper ? "📋 PAPER OPEN" : "🔴 REAL OPEN"} (0)</Text>
        <Text style={styles.empty}>Chưa có lệnh nào đang mở</Text>
      </View>
    );
  }

  // Tổng fee đang lock trong open positions (round-trip estimate)
  const totalOpenFee = enriched.reduce((s, p) => s + (p.feeRoundTrip ?? 0), 0);
  // Equity = capital + sum(open uPnL net) — chỉ paper có capital
  const paperCap = state?.paperEngine?.capital;
  const equity = isPaper && typeof paperCap === "number" ? paperCap + totalUpnl : null;

  return (
    <View style={styles.card}>
      <Text style={styles.h2}>
        {isPaper ? "📋 PAPER OPEN" : "🔴 REAL OPEN"} ({positions.length}) · TỔNG uPnL{" "}
        <Text style={{ color: totalUpnl >= 0 ? P.green : P.error }}>{fmtUsd(totalUpnl, true)}</Text>
        {" "}<Text style={{ color: P.dim, fontSize: 11 }}>(net of fee)</Text>
      </Text>
      {isPaper && equity !== null && (
        <Text style={{ color: P.dim, fontSize: 11, marginTop: 2 }}>
          EQUITY = capital ${paperCap?.toFixed(2)} + uPnL = <Text style={{ color: equity >= (state?.paperEngine?.initialCapital ?? 5000) ? P.green : P.error, fontWeight: "700" }}>${equity.toFixed(2)}</Text>
          {" · "}exit fee estimate <Text style={{ color: "#fbbf24" }}>${totalOpenFee.toFixed(3)}</Text>
        </Text>
      )}
      {!isPaper && totalOpenFee > 0 && (
        <Text style={{ color: P.dim, fontSize: 11, marginTop: 2 }}>
          exit fee estimate: <Text style={{ color: "#fbbf24" }}>${totalOpenFee.toFixed(3)}</Text>
        </Text>
      )}

      {([["LONG", longs, longUpnl, P.green], ["SHORT", shorts, shortUpnl, P.error]] as const).map(([side, list, sUpnl, color]) => {
        if (list.length === 0) return null;
        return (
          <View key={side} style={{ marginTop: 8 }}>
            <Text style={[styles.sideTitle, { color }]}>
              {side === "LONG" ? "🟢" : "🔴"} {side} ({list.length}) · uPnL{" "}
              <Text style={{ color: sUpnl >= 0 ? P.green : P.error }}>{fmtUsd(sUpnl, true)}</Text>
            </Text>
            <ScrollView horizontal style={{ marginTop: 4 }}>
              <View>
                {list.map((p, i) => {
                  const tpPct = Math.abs(p.tpPrice - p.entryPrice) / p.entryPrice * 100;
                  const slPct = Math.abs(p.entryPrice - p.slPrice) / p.entryPrice * 100;
                  const upnlColor = (p.upnlUsd ?? 0) >= 0 ? P.green : P.error;
                  return (
                    <View key={p.id} style={styles.row}>
                      <Text style={[styles.cell, styles.cellNum]}>{i + 1}</Text>
                      <Text style={[styles.cell, styles.cellTime]}>{fmtTime(p.entryMs)}</Text>
                      <Text style={[styles.cell, styles.cellSrc, { color: P.bitcoinOrange }]}>{p.source.replace(/_/g, " ")}</Text>
                      <Text style={[styles.cell, styles.cellSize, { color: P.bitcoinOrange }]}>size ${p.notional.toFixed(0)}</Text>
                      <Text style={[styles.cell, styles.cellPrice]}>@${p.entryPrice.toFixed(0)}</Text>
                      <Text style={[styles.cell, styles.cellTp, { color: P.green }]}>TP ${p.tpPrice.toFixed(0)} ({tpPct.toFixed(2)}%)</Text>
                      <Text style={[styles.cell, styles.cellSl, { color: P.error }]}>SL ${p.slPrice.toFixed(0)} ({slPct.toFixed(2)}%)</Text>
                      <Text style={[styles.cell, styles.cellHeld, { color: P.dim }]}>held {fmtHeld(p.entryMs)}</Text>
                      <Text style={[styles.cell, styles.cellPnl, { color: upnlColor, textAlign: "right" }]}>
                        {p.upnlUsd !== null ? fmtUsd(p.upnlUsd, true) : "—"}
                      </Text>
                      <Text style={[styles.cell, styles.cellPct, { color: upnlColor, textAlign: "right" }]}>
                        {p.upnlPctOnMargin !== null ? `${p.upnlPctOnMargin >= 0 ? "+" : ""}${p.upnlPctOnMargin.toFixed(2)}%${p.isLiquidated ? " 💀" : ""}` : "—"}
                      </Text>
                    </View>
                  );
                })}
              </View>
            </ScrollView>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: P.surface, borderRadius: 6, padding: 12, marginBottom: 14, borderWidth: 1, borderColor: P.border },
  h2: { color: P.text, fontSize: 14, fontWeight: "700", marginBottom: 6 },
  empty: { color: P.dim, fontSize: 11, padding: 8, fontStyle: "italic" },
  sideTitle: { fontSize: 12, fontWeight: "700" },
  row: { flexDirection: "row", paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: P.border + "33", alignItems: "center" },
  cell: { color: P.text, fontSize: 11, paddingHorizontal: 4, fontFamily: "monospace" },
  cellNum: { width: 24, color: P.dim, fontSize: 10 },
  cellTime: { width: 90 },
  cellSrc: { width: 90 },
  cellSize: { width: 95 },
  cellPrice: { width: 80 },
  cellTp: { width: 130 },
  cellSl: { width: 130 },
  cellHeld: { width: 80 },
  cellPnl: { width: 80, fontWeight: "700" },
  cellPct: { width: 80, fontWeight: "700" },
});
