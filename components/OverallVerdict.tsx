/**
 * OverallVerdict — V2 HUD / Bloomberg Terminal style (v4.3.18)
 *
 * Design handoff: Claude Design V2 (Bloomberg). Dense terminal HUD:
 *  - Grid background + corner brackets
 *  - Price header · Full-width TF grid
 *  - Verdict + sparkline · Confidence + WR/N/Edge nested
 *  - LÝ DO grid {k,v,h} · 8 badges 4x2 · Summary bar 2-col fill
 */
import React, { useMemo } from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import Svg, { Path, Polyline, Rect, Defs, Pattern } from "react-native-svg";
import { COLORS, TimeframeKey } from "../utils/constants";
import { Verdict } from "../hooks/useAlerts";
import { TFAnalysis, Kline, RawKlinesMap } from "../hooks/useBinanceKlines";
import verdictAccuracyByTF from "../assets/verdict_accuracy_by_tf.json";
import DebugLabel from "./DebugLabel";

// ── Material You warm palette (v4.3.20) ──
const P = {
  bg: "#131313", card: "#1c1b1b", surface: "#0e0e0e",
  border: "#2a2a2a", grid: "#201f1f",
  text: "#e5e2e1", dim: "#9f8e80", fade: "#514439",
  orange: "#ffb874", green: "#10b981", red: "#ffb4ab", yellow: "#ffdcc0",
  tertiary: "#b5ebff", onPrimary: "#4b2800", bitcoinOrange: "#F7931A",
};

interface Props {
  verdict: Verdict;
  selectedTF: TimeframeKey;
  onSelectTF: (tf: TimeframeKey) => void;
  tfData: TFAnalysis[];
  rawKlines: RawKlinesMap;
  price: number;
  change24hPct: number;
}

const TF_LIST: TimeframeKey[] = ["5m", "15m", "1h", "4h", "1d", "1w", "1M"];

// ── Backtest stats lookup ──────────────────────────────────────────
function resolveStatsTF(tf: TimeframeKey): { statsTF: TimeframeKey; fallback: boolean } {
  if (tf === "1w" || tf === "1M") return { statsTF: "1d", fallback: true };
  return { statsTF: tf, fallback: false };
}
interface Stats { wr: number; N: number; edge: number; tp: number; sl: number; maxHold: number; breakEven: number; statsTF: TimeframeKey; fallback: boolean; }
function getStats(verdictText: string, tf: TimeframeKey): Stats | null {
  const { statsTF, fallback } = resolveStatsTF(tf);
  const byTF: any = (verdictAccuracyByTF as any).byTF || {};
  const block: any = byTF[statsTF];
  if (!block) return null;
  const entry = block.byText?.[verdictText];
  if (!entry) return null;
  return { wr: entry.wr, N: entry.N, edge: entry.edge, tp: block.tp, sl: block.sl, maxHold: block.maxHold, breakEven: block.breakEven, statsTF, fallback };
}
function trustLevel(stats: Stats | null): { label: string; color: string; good: boolean } {
  if (!stats) return { label: "THẤP", color: P.red, good: false };
  if (stats.edge >= 5) return { label: "CAO", color: P.green, good: true };
  if (stats.edge >= 0) return { label: "T.BÌNH", color: P.yellow, good: true };
  return { label: "THẤP", color: P.red, good: false };
}

// ── Derive state neutral/long/short từ verdict text ──
function deriveState(verdict: Verdict): "neutral" | "long" | "short" {
  const t = verdict.text.toUpperCase();
  if (t.includes("LONG") || t.includes("MUA") || t.includes("TĂNG")) return "long";
  if (t.includes("SHORT") || t.includes("BÁN") || t.includes("GIẢM")) return "short";
  return "neutral";
}

// ── Build 4 reasons {k,v,h} từ selected TF ──
function buildReasons(tfa: TFAnalysis | undefined): Array<{ k: string; v: string; h: string }> {
  if (!tfa) return [];
  const out: Array<{ k: string; v: string; h: string }> = [];

  // RSI
  const rsi = tfa.rsi;
  if (rsi !== null) {
    let hint = "neutral zone · no extreme";
    if (rsi < 30) hint = "quá bán · có thể bounce";
    else if (rsi < 45) hint = "yếu · nghiêng bán";
    else if (rsi < 55) hint = "neutral zone · no extreme";
    else if (rsi < 70) hint = "mạnh · nghiêng mua";
    else hint = "quá mua · cảnh giác pullback";
    out.push({ k: "RSI", v: rsi.toFixed(1), h: hint });
  } else out.push({ k: "RSI", v: "—", h: "không đủ data" });

  // TREND (EMA 9/21/50 stacked)
  const e9 = tfa.ema9, e21 = tfa.ema21, e50 = tfa.ema50;
  if (e9 !== null && e21 !== null && e50 !== null) {
    if (e9 > e21 && e21 > e50) out.push({ k: "TREND", v: "stacked ▲", h: "EMA 9 > 21 > 50 · bull aligned" });
    else if (e9 < e21 && e21 < e50) out.push({ k: "TREND", v: "stacked ▼", h: "EMA 9 < 21 < 50 · bear aligned" });
    else out.push({ k: "TREND", v: "flat", h: "EMA crossing · slope ≈ 0" });
  } else out.push({ k: "TREND", v: "—", h: "chưa đủ bars" });

  // VOL
  const volRatio = tfa.volumeAvg > 0 ? tfa.volumeCurrent / tfa.volumeAvg : 0;
  let volHint = "balanced";
  if (volRatio >= 1.5) volHint = "breakout confirmation";
  else if (volRatio >= 1.2) volHint = "above average";
  else if (volRatio < 0.8) volHint = "weak flow · cannot break range";
  out.push({ k: "VOL", v: `${volRatio.toFixed(1)}×`, h: volHint });

  // MACD (thay FUND)
  const mh = tfa.macdHistogram;
  if (mh !== null) {
    const sign = mh >= 0 ? "+" : "";
    let hint = "balanced · no side winning";
    if (mh > 0 && mh > Math.abs(mh) * 0.5) hint = "bull momentum growing";
    else if (mh > 0) hint = "mild bull momentum";
    else if (mh < 0) hint = Math.abs(mh) > 1 ? "bear momentum growing" : "mild bear momentum";
    out.push({ k: "MACD", v: `${sign}${mh.toFixed(2)}`, h: hint });
  } else out.push({ k: "MACD", v: "—", h: "không đủ data" });

  return out;
}

// ── Build 8 badges ──
interface BadgeItem { name: string; count: number; total: number; active: boolean; bull: boolean; }
function buildBadges(tfData: TFAnalysis[], verdict: Verdict): BadgeItem[] {
  const N = tfData.length;
  // RSI extreme count
  const rsiHits = verdict.rsiOB + verdict.rsiOS;
  const rsiBull = verdict.rsiOS > verdict.rsiOB;
  // STO extreme
  const stoHits = verdict.stochOB + verdict.stochOS;
  const stoBull = verdict.stochOS > verdict.stochOB;
  // MACD bull count
  const macdBullCount = tfData.filter((t) => t.macdHistogram !== null && t.macdHistogram > 0).length;
  const macdBull = macdBullCount >= N / 2;
  // VOL high count
  const volHighCount = tfData.filter((t) => t.volumeHigh).length;
  // BBK (close vượt BB upper or lower)
  const bbkCount = tfData.filter((t) => {
    if (t.bollingerUpper === null || t.bollingerLower === null) return false;
    return t.lastClose > t.bollingerUpper || t.lastClose < t.bollingerLower;
  }).length;
  const bbkBull = tfData.filter((t) => t.bollingerUpper !== null && t.lastClose > t.bollingerUpper).length
                 > tfData.filter((t) => t.bollingerLower !== null && t.lastClose < t.bollingerLower).length;
  // EMA stacked count
  const emaStackedBullCount = tfData.filter((t) => t.ema9 !== null && t.ema21 !== null && t.ema50 !== null && t.ema9 > t.ema21 && t.ema21 > t.ema50).length;
  const emaStackedBearCount = tfData.filter((t) => t.ema9 !== null && t.ema21 !== null && t.ema50 !== null && t.ema9 < t.ema21 && t.ema21 < t.ema50).length;
  const emaHits = Math.max(emaStackedBullCount, emaStackedBearCount);
  const emaBull = emaStackedBullCount >= emaStackedBearCount;
  // DIV (phân kỳ)
  const divHits = verdict.bullDiv + verdict.bearDiv;
  const divBull = verdict.bullDiv > verdict.bearDiv;
  // ADJ (cặp kề cực trị)
  const adjHits = verdict.adjPairsOB.length + verdict.adjPairsOS.length;
  const adjBull = verdict.adjPairsOS.length > verdict.adjPairsOB.length;

  return [
    { name: "RSI",  count: rsiHits,  total: 7, active: rsiHits > 0,  bull: rsiBull },
    { name: "STO",  count: stoHits,  total: 7, active: stoHits > 0,  bull: stoBull },
    { name: "MACD", count: macdBullCount, total: 7, active: macdBullCount >= 3, bull: macdBull },
    { name: "VOL",  count: volHighCount,  total: 7, active: volHighCount > 0,   bull: true },
    { name: "BBK",  count: bbkCount,      total: 7, active: bbkCount > 0,       bull: bbkBull },
    { name: "EMA",  count: emaHits,       total: 7, active: emaHits >= 3,       bull: emaBull },
    { name: "DIV",  count: divHits,       total: 7, active: divHits > 0,        bull: divBull },
    { name: "ADJ",  count: adjHits,       total: 6, active: adjHits > 0,        bull: adjBull },
  ];
}

function buildLongShort(badges: BadgeItem[]): { long: number; short: number } {
  let long = 0, short = 0;
  badges.forEach((b) => {
    if (!b.active) return;
    if (b.bull) long++; else short++;
  });
  return { long, short };
}

// ── Sparkline closes ──
function takeCloses(klines: Kline[] | undefined, n: number): number[] {
  if (!klines || klines.length === 0) return [];
  return klines.slice(-n).map((k) => k.close);
}

// ── Build 1-câu kết luận conclusion ──
function buildConclusion(verdict: Verdict, stats: Stats | null, selectedTF: TimeframeKey): string {
  if (stats && stats.edge >= 5) return `Backtest ${selectedTF.toUpperCase()} edge +${stats.edge}% → có thể vào lệnh theo verdict.`;
  if (stats && stats.edge < 0) return `Edge ${stats.edge}% (âm) → KHÔNG nên vào lệnh. Chờ tín hiệu rõ hơn.`;
  if (!stats || stats.N < 5) return `Không đủ mẫu backtest cho "${verdict.text}" trên ${selectedTF.toUpperCase()} → chưa có cơ sở.`;
  return `Edge trung tính (${stats.edge >= 0 ? "+" : ""}${stats.edge}%) → chờ tín hiệu rõ hơn.`;
}

// ── Corner bracket SVG ──
type CornerPos = "tl" | "tr" | "bl" | "br";
function Corner({ pos, color = P.orange }: { pos: CornerPos; color?: string }) {
  const stylesByPos: Record<CornerPos, any> = {
    tl: { top: -1, left: -1 }, tr: { top: -1, right: -1 },
    bl: { bottom: -1, left: -1 }, br: { bottom: -1, right: -1 },
  };
  const pathByPos: Record<CornerPos, string> = {
    tl: "M0 8V0h8", tr: "M0 0h8v8", bl: "M0 0v8h8", br: "M8 0v8H0",
  };
  return (
    <View style={[{ position: "absolute", width: 10, height: 10 }, stylesByPos[pos]]} pointerEvents="none">
      <Svg width={10} height={10} viewBox="0 0 8 8">
        <Path d={pathByPos[pos]} stroke={color} strokeWidth={1.5} fill="none" />
      </Svg>
    </View>
  );
}

function SubCard({ children, accent, style }: { children: React.ReactNode; accent?: string; style?: any }) {
  const c = accent || P.dim;
  return (
    <View style={[styles.subCard, style]}>
      <Corner pos="tl" color={c} />
      <Corner pos="tr" color={c} />
      <Corner pos="bl" color={c} />
      <Corner pos="br" color={c} />
      {children}
    </View>
  );
}

// ── Sparkline ──
function Sparkline({ data, color, width = 80, height = 40 }: { data: number[]; color: string; width?: number; height?: number }) {
  if (data.length < 2) return <View style={{ width, height }} />;
  const min = Math.min(...data), max = Math.max(...data), range = max - min || 1;
  const points = data.map((y, i) => {
    const x = (i / (data.length - 1)) * 100;
    const yy = 100 - ((y - min) / range) * 100;
    return `${x.toFixed(2)},${yy.toFixed(2)}`;
  }).join(" ");
  const areaPoints = `${points} 100,100 0,100`;
  return (
    <Svg width={width} height={height} viewBox="0 0 100 100" preserveAspectRatio="none">
      <Polyline points={areaPoints} fill={color} fillOpacity={0.12} stroke="none" />
      <Polyline points={points} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
    </Svg>
  );
}

// ── Main ──
function OverallVerdictInner({
  verdict, selectedTF, onSelectTF,
  tfData, rawKlines, price, change24hPct,
}: Props) {
  const state = deriveState(verdict);
  const accent = state === "long" ? P.green : state === "short" ? P.red : P.yellow;
  const icon = state === "long" ? "▲" : state === "short" ? "▼" : "⏸";
  const stats = getStats(verdict.text, selectedTF);
  const trust = trustLevel(stats);

  const reasons = useMemo(() => {
    const tfa = tfData.find((t) => t.key === selectedTF);
    return buildReasons(tfa);
  }, [tfData, selectedTF]);

  const badges = useMemo(() => buildBadges(tfData, verdict), [tfData, verdict]);
  const { long, short } = useMemo(() => buildLongShort(badges), [badges]);

  const spark = useMemo(() => takeCloses(rawKlines[selectedTF], 30), [rawKlines, selectedTF]);
  const conclusion = buildConclusion(verdict, stats, selectedTF);
  const changeColor = change24hPct >= 0 ? P.green : P.red;
  const changeSign = change24hPct >= 0 ? "+" : "";

  return (
    <View style={styles.outer}>
      <DebugLabel name="OverallVerdict" />
      {/* Grid noise overlay — absolute, behind everything */}
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <Svg width="100%" height="100%">
          <Defs>
            <Pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse">
              <Path d="M 24 0 L 0 0 0 24" fill="none" stroke={P.grid} strokeWidth="1" />
            </Pattern>
          </Defs>
          <Rect width="100%" height="100%" fill="url(#grid)" />
        </Svg>
      </View>

      {/* 1. PRICE HEADER */}
      <SubCard>
        <View style={styles.headerRow}>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <Text style={styles.headerSymbol}>◆ BTC-USDT</Text>
            <Text style={styles.headerMeta}>PERP · BINANCE</Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "baseline" }}>
            <Text style={styles.headerPrice}>{price ? price.toLocaleString(undefined, { maximumFractionDigits: 0 }) : "—"}</Text>
            <Text style={[styles.headerChange, { color: changeColor }]}>{changeSign}{change24hPct.toFixed(2)}%</Text>
          </View>
        </View>
      </SubCard>

      {/* 2. TF GRID (7 cols full-width) */}
      <View style={styles.tfGrid}>
        {TF_LIST.map((tf, i) => {
          const active = tf === selectedTF;
          return (
            <TouchableOpacity
              key={tf}
              onPress={() => onSelectTF(tf)}
              style={[
                styles.tfCell,
                active && { backgroundColor: P.orange },
              ]}
            >
              <Text style={[styles.tfText, active && styles.tfTextActive]}>{tf}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* 3. VERDICT + SPARKLINE */}
      <SubCard accent={accent}>
        <View style={styles.verdictRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.microLabel}>▼ VERDICT · {selectedTF.toUpperCase()}</Text>
            <Text style={[styles.verdictText, { color: accent }]}>{icon}  {verdict.text}</Text>
            <Text style={[styles.verdictConcl, { color: accent, opacity: 0.85 }]}>{conclusion}</Text>
          </View>
          <Sparkline data={spark} color={accent} />
        </View>
      </SubCard>

      {/* 4. TRUST + WR/N/EDGE side by side */}
      <View style={styles.trustRow}>
        <SubCard style={{ flex: 2, padding: 10 }}>
          <Text style={styles.microLabel}>CONFIDENCE</Text>
          <Text style={[styles.trustLevel, { color: trust.color }]}>
            {trust.good ? "▲" : "▼"} {trust.label}
          </Text>
        </SubCard>
        <SubCard style={{ flex: 3, paddingVertical: 6, paddingHorizontal: 0 }}>
          <View style={{ flexDirection: "row" }}>
            {[
              ["WR%", stats ? `${stats.wr}` : "—", P.text],
              ["N", stats ? `${stats.N}` : "—", P.text],
              ["EDGE", stats ? `${stats.edge >= 0 ? "+" : ""}${stats.edge}` : "—", stats ? (stats.edge >= 0 ? P.green : P.red) : P.dim],
            ].map(([k, v, c], i) => (
              <View key={k as string} style={[styles.statCol, i > 0 && { borderLeftWidth: 1, borderLeftColor: P.border }]}>
                <Text style={styles.statLabel}>{k as string}</Text>
                <Text style={[styles.statValue, { color: c as string }]}>{v as string}</Text>
              </View>
            ))}
          </View>
        </SubCard>
      </View>

      {/* Hint line */}
      <Text style={styles.hintLine}>
        <Text style={{ color: P.orange }}>※</Text> {stats ? `N=${stats.N} mẫu · TP${stats.tp}/SL${stats.sl} · BE ≥${stats.breakEven}%` : `Chưa có đủ mẫu backtest`}
        <Text style={{ color: P.fade }}>  // bt {stats?.statsTF.toUpperCase() || "—"} · {stats?.maxHold || "—"} bars{stats?.fallback ? " · fallback" : ""}</Text>
      </Text>

      {/* 5. LÝ DO grid {k,v,h} */}
      <SubCard style={{ paddingHorizontal: 0, paddingVertical: 8 }}>
        <Text style={[styles.microLabel, { paddingHorizontal: 10, paddingBottom: 4 }]}>▼ LÝ DO · {reasons.length}</Text>
        {reasons.map((r, i) => (
          <View key={r.k} style={[styles.reasonRow, i > 0 && { borderTopWidth: 1, borderTopColor: P.border, borderStyle: "dashed" }]}>
            <Text style={styles.reasonKey}>▶ {r.k}</Text>
            <Text style={styles.reasonVal}>{r.v}</Text>
            <Text style={styles.reasonHint}>{r.h}</Text>
          </View>
        ))}
      </SubCard>

      {/* 6. BADGES 4x2 */}
      <SubCard style={{ padding: 2 }}>
        <View style={styles.badgeGrid}>
          {badges.map((b) => {
            const c = b.active ? (b.bull ? P.green : b.name === "STO" || b.name === "MACD" || b.name === "EMA" ? (b.bull ? P.green : P.red) : P.yellow) : P.dim;
            return (
              <View key={b.name} style={[styles.badgeCell, { borderLeftColor: b.active ? c : "transparent" }]}>
                <Text style={[styles.badgeCount, { color: c }]}>{b.count}/{b.total}</Text>
                <Text style={[styles.badgeName, { color: c, opacity: b.active ? 1 : 0.7 }]}>{b.name}</Text>
              </View>
            );
          })}
        </View>
      </SubCard>

      {/* 7. SUMMARY BAR 2-col */}
      <View style={styles.summaryRow}>
        <View style={[styles.summaryCell, { borderBottomColor: long >= short ? P.green : P.fade }]}>
          <Text style={[styles.summaryLabel, { color: P.green }]}>✓ LONG SIG</Text>
          <Text style={[styles.summaryCount, { color: P.green }]}>{long}</Text>
        </View>
        <View style={[styles.summaryCell, { borderBottomColor: short > long ? P.red : P.fade }]}>
          <Text style={[styles.summaryLabel, { color: P.red }]}>⚠ SHORT SIG</Text>
          <Text style={[styles.summaryCount, { color: P.red }]}>{short}</Text>
        </View>
      </View>
    </View>
  );
}

const OverallVerdict = React.memo(OverallVerdictInner);
export default OverallVerdict;

// ── Styles ──
const styles = StyleSheet.create({
  outer: {
    backgroundColor: P.card, borderRadius: 2, padding: 14, paddingLeft: 18, marginBottom: 10,
    borderLeftWidth: 4, borderLeftColor: P.bitcoinOrange, overflow: "hidden",
  },
  // Price header
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 6, paddingHorizontal: 10 },
  headerSymbol: { color: P.orange, fontSize: 10, fontWeight: "800", letterSpacing: 1, fontFamily: "monospace" },
  headerMeta: { color: P.dim, fontSize: 9, letterSpacing: 1, marginLeft: 10, fontFamily: "monospace" },
  headerPrice: { color: P.text, fontSize: 13, fontWeight: "800", fontFamily: "monospace" },
  headerChange: { fontSize: 10, fontWeight: "700", marginLeft: 8, fontFamily: "monospace" },
  // TF grid
  tfGrid: { flexDirection: "row", marginTop: 10, gap: 4 },
  tfCell: { flex: 1, paddingVertical: 6, backgroundColor: P.surface, borderRadius: 2, alignItems: "center" },
  tfText: { color: P.dim, fontSize: 10, fontWeight: "700", letterSpacing: 1, fontFamily: "SpaceGrotesk_700Bold" },
  tfTextActive: { color: P.onPrimary, fontWeight: "800" },
  // Sub card generic
  subCard: {
    backgroundColor: P.card, borderWidth: 1, borderColor: P.border,
    padding: 10, marginTop: 10, position: "relative",
  },
  // Verdict
  verdictRow: { flexDirection: "row", alignItems: "center", padding: 2 },
  microLabel: { color: P.dim, fontSize: 8, letterSpacing: 2, fontFamily: "monospace", fontWeight: "600" },
  verdictText: { fontSize: 18, fontWeight: "900", letterSpacing: 2, fontFamily: "monospace", marginTop: 4 },
  verdictConcl: { fontSize: 10, marginTop: 6, fontFamily: "monospace", lineHeight: 14 },
  // Trust row
  trustRow: { flexDirection: "row", marginTop: 10, gap: 8 },
  trustLevel: { fontSize: 13, fontWeight: "900", letterSpacing: 1.5, fontFamily: "monospace", marginTop: 4 },
  statCol: { flex: 1, alignItems: "center", paddingHorizontal: 4 },
  statLabel: { color: P.dim, fontSize: 8, letterSpacing: 1.5, fontFamily: "monospace" },
  statValue: { fontSize: 16, fontWeight: "800", fontFamily: "monospace", marginTop: 2 },
  hintLine: { color: P.dim, fontSize: 9.5, letterSpacing: 0.3, fontFamily: "monospace", marginTop: 6 },
  // LÝ DO
  reasonRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 10, paddingVertical: 5 },
  reasonKey: { width: 54, color: P.orange, fontSize: 9, letterSpacing: 1.5, fontWeight: "700", fontFamily: "monospace" },
  reasonVal: { width: 80, color: P.text, fontSize: 11, fontWeight: "700", fontFamily: "monospace" },
  reasonHint: { flex: 1, color: P.dim, fontSize: 10, fontStyle: "italic", fontFamily: "monospace" },
  // Badges
  badgeGrid: { flexDirection: "row", flexWrap: "wrap" },
  badgeCell: { width: "25%", paddingVertical: 7, paddingHorizontal: 4, alignItems: "center", backgroundColor: P.surface, borderLeftWidth: 2, borderTopWidth: 1, borderTopColor: P.border },
  badgeCount: { fontSize: 12, fontWeight: "900", letterSpacing: 0.5, fontFamily: "monospace" },
  badgeName: { fontSize: 8, letterSpacing: 1.5, marginTop: 2, fontFamily: "monospace", fontWeight: "700" },
  // Summary
  summaryRow: { flexDirection: "row", marginTop: 10, backgroundColor: P.border, padding: 1, gap: 1 },
  summaryCell: { flex: 1, backgroundColor: P.card, flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 2 },
  summaryLabel: { fontSize: 9, letterSpacing: 1.5, fontWeight: "700", fontFamily: "monospace" },
  summaryCount: { fontSize: 17, fontWeight: "900", fontFamily: "monospace" },
});

// Keep COLORS reference silent for dead-code lint
void COLORS;
