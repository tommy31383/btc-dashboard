/**
 * TomiHedgeChart v0.4.3 — chart price + entry/close markers + weekly bias.
 *
 * Anh Tommy spec:
 *   - TF selector: 5m, 15m, 1h, 4h, 1d, 1w
 *   - Price line từ /api/binance/klines/:tf?full=1
 *   - Markers từ state.tomiHedge*.eventLog (▲ ADD LONG green, ▼ ADD SHORT red, ✕ CLOSE)
 *   - Weekly bias badge (🟢 UP / 🔴 DOWN) từ lastWeeklyTrend
 */
import React, { useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from "react-native";
import Svg, { Polyline, Line, Text as SvgText, Circle, Path } from "react-native-svg";
import { P } from "../utils/v2Theme";
import { api } from "../utils/backendApi";

type Tf = "5m" | "15m" | "1h" | "4h" | "1d" | "1w";
const TFS: Tf[] = ["5m", "15m", "1h", "4h", "1d", "1w"];

interface Bar { time: number; open: number; high: number; low: number; close: number; volume: number }

interface Event {
  ts: number;
  kind: "ADD" | "CLOSE";
  side: "LONG" | "SHORT";
  price: number;
  qty: number;
  avgEntryAfter?: number;
  realizedPnl?: number;
  weeklyTrend?: "UP" | "DOWN";
}

interface Props {
  eventLog?: Event[];
  weeklyTrend?: "UP" | "DOWN";
  title?: string;
}

const CHART_W = 360;
const CHART_H = 220;
const PAD_L = 50;
const PAD_R = 8;
const PAD_T = 10;
const PAD_B = 22;
const VISIBLE_BARS: Record<Tf, number> = { "5m": 200, "15m": 200, "1h": 168, "4h": 180, "1d": 180, "1w": 156 };

export default function TomiHedgeChart({ eventLog, weeklyTrend, title }: Props) {
  const [tf, setTf] = useState<Tf>("1h");
  const [bars, setBars] = useState<Bar[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    setLoading(true); setErr(null);
    api.klines(tf).then((res) => {
      if (cancel) return;
      const all = res.bars || [];
      const slice = all.slice(-VISIBLE_BARS[tf]);
      setBars(slice);
    }).catch((e) => {
      if (cancel) return;
      setErr(e?.message ?? String(e));
    }).finally(() => { if (!cancel) setLoading(false); });
    return () => { cancel = true; };
  }, [tf]);

  const { points, minP, maxP, t0, t1 } = useMemo(() => {
    if (bars.length === 0) return { points: "", minP: 0, maxP: 0, t0: 0, t1: 0 };
    let mn = Infinity, mx = -Infinity;
    for (const b of bars) {
      if (b.low < mn) mn = b.low;
      if (b.high > mx) mx = b.high;
    }
    if (mn === mx) { mn -= 1; mx += 1; }
    const t0 = bars[0].time;
    const t1 = bars[bars.length - 1].time + (bars.length > 1 ? bars[1].time - bars[0].time : 0);
    const w = CHART_W - PAD_L - PAD_R;
    const h = CHART_H - PAD_T - PAD_B;
    const xOf = (t: number) => PAD_L + ((t - t0) / (t1 - t0)) * w;
    const yOf = (p: number) => PAD_T + (1 - (p - mn) / (mx - mn)) * h;
    const pts = bars.map((b) => `${xOf(b.time).toFixed(1)},${yOf(b.close).toFixed(1)}`).join(" ");
    return { points: pts, minP: mn, maxP: mx, t0, t1 };
  }, [bars]);

  const w = CHART_W - PAD_L - PAD_R;
  const h = CHART_H - PAD_T - PAD_B;
  const xOf = (t: number) => PAD_L + ((t - t0) / Math.max(1, t1 - t0)) * w;
  const yOf = (p: number) => PAD_T + (1 - (p - minP) / Math.max(1e-9, maxP - minP)) * h;

  // Filter events trong khoảng visible
  const visEvents = useMemo(() => {
    if (!eventLog || bars.length === 0) return [];
    return eventLog.filter((e) => e.ts >= t0 && e.ts <= t1);
  }, [eventLog, t0, t1, bars.length]);

  // Y-axis labels (5 ticks)
  const yTicks = useMemo(() => {
    if (bars.length === 0) return [];
    const out: { y: number; label: string }[] = [];
    for (let i = 0; i <= 4; i++) {
      const p = minP + ((maxP - minP) * i) / 4;
      out.push({ y: yOf(p), label: p.toFixed(0) });
    }
    return out;
  }, [bars.length, minP, maxP]);

  // Stats events
  const adds = visEvents.filter((e) => e.kind === "ADD");
  const closes = visEvents.filter((e) => e.kind === "CLOSE");

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Text style={styles.h2}>📊 {title || "TomiHedge Chart"}</Text>
        <View style={styles.biasBadge}>
          <Text style={styles.biasLabel}>WEEKLY BIAS</Text>
          {weeklyTrend ? (
            <Text style={[styles.biasValue, { color: weeklyTrend === "UP" ? P.green : P.error }]}>
              {weeklyTrend === "UP" ? "🟢 UP" : "🔴 DOWN"}
            </Text>
          ) : (
            <Text style={[styles.biasValue, { color: P.dim }]}>—</Text>
          )}
        </View>
      </View>

      {/* TF selector */}
      <View style={styles.tfRow}>
        {TFS.map((t) => (
          <TouchableOpacity
            key={t}
            style={[styles.tfBtn, tf === t && styles.tfBtnActive]}
            onPress={() => setTf(t)}
          >
            <Text style={[styles.tfText, tf === t && styles.tfTextActive]}>{t}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Chart */}
      <View style={styles.chartBox}>
        {loading && <ActivityIndicator color={P.bitcoinOrange} style={{ position: "absolute", top: 100, left: 170 }} />}
        {err && <Text style={styles.error}>⚠️ {err}</Text>}
        <Svg width={CHART_W} height={CHART_H}>
          {/* Grid + Y labels */}
          {yTicks.map((tk, i) => (
            <React.Fragment key={i}>
              <Line x1={PAD_L} y1={tk.y} x2={CHART_W - PAD_R} y2={tk.y} stroke={P.borderSoft} strokeWidth={0.5} strokeDasharray="2,3" />
              <SvgText x={PAD_L - 4} y={tk.y + 3} fill={P.dim} fontSize="9" textAnchor="end" fontFamily="monospace">
                {tk.label}
              </SvgText>
            </React.Fragment>
          ))}
          {/* Price line */}
          {points && (
            <Polyline points={points} fill="none" stroke={P.bitcoinOrange} strokeWidth={1.5} />
          )}
          {/* Markers */}
          {visEvents.map((e, i) => {
            const x = xOf(e.ts);
            const y = yOf(e.price);
            const isAdd = e.kind === "ADD";
            const color = e.side === "LONG" ? P.green : P.error;
            if (isAdd) {
              // Triangle up (LONG) or down (SHORT)
              const tri = e.side === "LONG"
                ? `M${x},${y - 6} L${x - 5},${y + 3} L${x + 5},${y + 3} Z`
                : `M${x},${y + 6} L${x - 5},${y - 3} L${x + 5},${y - 3} Z`;
              return <Path key={i} d={tri} fill={color} opacity={0.85} />;
            } else {
              // Close = X cross
              return (
                <React.Fragment key={i}>
                  <Line x1={x - 4} y1={y - 4} x2={x + 4} y2={y + 4} stroke={color} strokeWidth={1.5} />
                  <Line x1={x - 4} y1={y + 4} x2={x + 4} y2={y - 4} stroke={color} strokeWidth={1.5} />
                </React.Fragment>
              );
            }
          })}
        </Svg>
      </View>

      {/* Legend + stats */}
      <View style={styles.legendRow}>
        <Text style={styles.legendItem}><Text style={{ color: P.green }}>▲</Text> ADD LONG</Text>
        <Text style={styles.legendItem}><Text style={{ color: P.error }}>▼</Text> ADD SHORT</Text>
        <Text style={styles.legendItem}><Text style={{ color: P.text }}>✕</Text> CLOSE</Text>
        <Text style={styles.legendItem}>· Visible: {adds.length} ADD, {closes.length} CLOSE</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: P.surface, borderRadius: 6, padding: 10, marginBottom: 14, borderWidth: 1, borderColor: P.border },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  h2: { color: P.text, fontSize: 13, fontWeight: "700" },
  biasBadge: { alignItems: "flex-end" },
  biasLabel: { color: P.dim, fontSize: 8, fontFamily: "monospace", letterSpacing: 0.8 },
  biasValue: { fontSize: 13, fontWeight: "700", fontFamily: "monospace" },
  tfRow: { flexDirection: "row", gap: 4, marginBottom: 6 },
  tfBtn: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 3, borderWidth: 1, borderColor: P.borderSoft },
  tfBtnActive: { borderColor: P.bitcoinOrange, backgroundColor: P.bitcoinOrange + "22" },
  tfText: { color: P.dim, fontSize: 10, fontWeight: "700", fontFamily: "monospace" },
  tfTextActive: { color: P.bitcoinOrange },
  chartBox: { width: CHART_W, height: CHART_H, alignSelf: "center", position: "relative" },
  legendRow: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 6 },
  legendItem: { color: P.dim, fontSize: 10, fontFamily: "monospace" },
  error: { color: P.error, fontSize: 11, padding: 8 },
});
