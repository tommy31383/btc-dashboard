/**
 * PaperSection — render khi presetView === "paper".
 * Includes:
 *   - PAPER CLOSED HISTORY (last 50 trades, table giống All5mPanel CLOSED)
 *   - PAPER EQUITY CURVE (capital theo time, derived from closed positions)
 */
import React, { useMemo } from "react";
import { View, Text, StyleSheet, ScrollView } from "react-native";
import Svg, { Polyline, Line as SvgLine } from "react-native-svg";
import { P } from "../utils/v2Theme";

interface Props {
  state: any;
  width: number;
}

function fmtUsd(v: number, signed = false): string {
  const sign = signed && v >= 0 ? "+" : "";
  return `${sign}$${v.toFixed(2)}`;
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function PaperSection({ state, width }: Props) {
  const paper = state?.paperEngine;
  const cfg = state?.settings || {};

  const { closed, equityCurve } = useMemo(() => {
    const positions = paper?.positions || [];
    const closed = positions.filter((p: any) => p.status !== "OPEN").sort((a: any, b: any) => (b.exitMs ?? 0) - (a.exitMs ?? 0));
    // Equity curve: từ initial → cumulative net pnl theo thứ tự close
    const initCap = paper?.initialCapital ?? cfg.paperCapitalUsd ?? 5000;
    const sortedClosed = [...closed].sort((a: any, b: any) => (a.exitMs ?? 0) - (b.exitMs ?? 0));
    let cap = initCap;
    const curve: { t: number; equity: number }[] = [{ t: paper?.resetAt ?? Date.now(), equity: initCap }];
    for (const p of sortedClosed) {
      cap += p.pnlUsd ?? 0;
      curve.push({ t: p.exitMs ?? Date.now(), equity: cap });
    }
    return { closed, equityCurve: curve };
  }, [paper, cfg.paperCapitalUsd]);

  if (!paper) {
    return (
      <View style={styles.card}>
        <Text style={styles.h2}>📋 PAPER SECTION</Text>
        <Text style={styles.empty}>Paper engine chưa init</Text>
      </View>
    );
  }

  return (
    <View>
      {/* EQUITY CURVE */}
      <View style={styles.card}>
        <Text style={styles.h2}>📈 PAPER EQUITY CURVE ({equityCurve.length} pts)</Text>
        {equityCurve.length < 2 ? (
          <Text style={styles.empty}>Chưa có lệnh đóng — chờ paper close lần đầu</Text>
        ) : (
          <EquityCurveSvg data={equityCurve} width={Math.min(800, width - 32)} initial={paper.initialCapital} />
        )}
        <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 4 }}>
          <Text style={styles.dim}>init ${paper.initialCapital.toFixed(0)}</Text>
          <Text style={styles.dim}>current ${paper.capital.toFixed(2)}</Text>
          <Text style={{ color: paper.capital >= paper.initialCapital ? P.green : P.error, fontFamily: "monospace", fontSize: 11, fontWeight: "700" }}>
            ROI {((paper.capital - paper.initialCapital) / paper.initialCapital * 100).toFixed(2)}%
          </Text>
        </View>
      </View>

      {/* CLOSED HISTORY */}
      <View style={styles.card}>
        <Text style={styles.h2}>📜 PAPER CLOSED HISTORY ({closed.length})</Text>
        {closed.length === 0 ? (
          <Text style={styles.empty}>Chưa có lệnh đóng</Text>
        ) : (
          <ScrollView horizontal>
            <View>
              {closed.slice(0, 50).map((p: any) => {
                const win = p.status === "WIN";
                const sideColor = p.side === "LONG" ? P.green : P.error;
                const outcomeColor = win ? P.green : P.error;
                const notional = (cfg.paperMarginUsd ?? 1) * (cfg.paperLeverage ?? 125);
                return (
                  <View key={p.id} style={styles.row}>
                    <Text style={[styles.cell, styles.cellTime]}>{fmtTime(p.exitMs)}</Text>
                    <Text style={[styles.cell, styles.cellOutcome, { color: outcomeColor, fontWeight: "700" }]}>{p.status}</Text>
                    <Text style={[styles.cell, styles.cellSide, { color: sideColor, fontWeight: "700" }]}>{p.side}</Text>
                    <Text style={[styles.cell, styles.cellSrc, { color: P.dim }]}>{(p.source || "?").replace(/_/g, " ")}</Text>
                    <Text style={[styles.cell, styles.cellSize, { color: P.bitcoinOrange }]}>${notional.toFixed(0)}</Text>
                    <Text style={[styles.cell, styles.cellPrice]}>${p.entryPrice.toFixed(0)} → ${p.exitPrice?.toFixed(0) ?? "?"}</Text>
                    <Text style={[styles.cell, styles.cellPnl, { color: outcomeColor, textAlign: "right", fontWeight: "700" }]}>
                      {fmtUsd(p.pnlUsd ?? 0, true)}
                    </Text>
                  </View>
                );
              })}
            </View>
          </ScrollView>
        )}
      </View>
    </View>
  );
}

function EquityCurveSvg({ data, width, initial }: { data: { t: number; equity: number }[]; width: number; initial: number }) {
  const height = 160;
  const pad = 8;
  if (data.length < 2) return null;
  const tMin = data[0].t;
  const tMax = data[data.length - 1].t;
  const tRange = (tMax - tMin) || 1;
  const equities = data.map((d) => d.equity);
  const eMin = Math.min(...equities, initial * 0.95);
  const eMax = Math.max(...equities, initial * 1.05);
  const eRange = (eMax - eMin) || 1;
  const w = width - pad * 2;
  const h = height - pad * 2;
  const xOf = (t: number) => pad + ((t - tMin) / tRange) * w;
  const yOf = (e: number) => pad + h - ((e - eMin) / eRange) * h;
  const initY = yOf(initial);
  const points = data.map((d) => `${xOf(d.t).toFixed(1)},${yOf(d.equity).toFixed(1)}`).join(" ");
  const finalEquity = data[data.length - 1].equity;
  const isWin = finalEquity >= initial;

  return (
    <View style={{ width, height, backgroundColor: P.surface, borderRadius: 2, borderWidth: 1, borderColor: P.borderSoft, marginTop: 6 }}>
      <Svg width={width} height={height}>
        {/* Initial capital baseline */}
        <SvgLine x1={pad} y1={initY} x2={width - pad} y2={initY} stroke={P.dim} strokeWidth={0.5} strokeDasharray="3,3" opacity={0.5} />
        <Polyline points={points} fill="none" stroke={isWin ? P.green : P.error} strokeWidth={1.6} opacity={0.9} />
      </Svg>
      <Text style={{ position: "absolute", top: 4, left: 8, color: P.dim, fontSize: 9, fontFamily: "monospace" }}>
        init ${initial.toFixed(0)}
      </Text>
      <Text style={{ position: "absolute", bottom: 4, right: 8, color: isWin ? P.green : P.error, fontSize: 10, fontFamily: "monospace", fontWeight: "700" }}>
        ${finalEquity.toFixed(2)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: P.elevated, borderRadius: 4, padding: 12, margin: 8 },
  h2: { color: P.text2, fontSize: 11, fontWeight: "800", letterSpacing: 1, marginBottom: 8, fontFamily: "SpaceGrotesk_700Bold" },
  dim: { color: P.dim, fontSize: 10, fontFamily: "monospace" },
  empty: { color: P.dim, fontSize: 11, padding: 8, fontStyle: "italic" },
  row: { flexDirection: "row", paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: P.borderSoft + "33" },
  cell: { color: P.text, fontSize: 11, paddingHorizontal: 4, fontFamily: "monospace" },
  cellTime: { width: 90 },
  cellOutcome: { width: 50 },
  cellSide: { width: 60 },
  cellSrc: { width: 90 },
  cellSize: { width: 60 },
  cellPrice: { width: 160 },
  cellPnl: { width: 90 },
});
