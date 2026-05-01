/**
 * All5mPanel — full-screen panel cho tab "5m All".
 *
 * Strategy: mỗi 5m closed → quyết định LONG/SHORT theo StochRSI K (LONG K<10,
 * SHORT K>90), fallback S/R 15m. TP+4%/SL-2%. Cooldown 15m sau entry.
 */
import React, { useMemo, useState, useCallback, memo, useEffect } from "react";
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, useWindowDimensions } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Svg, { Polyline, Line, Polygon, Circle } from "react-native-svg";
import { P } from "../utils/v2Theme";
import DebugLabel from "./DebugLabel";
import {
  All5mAccount, AccountSummary, Position,
  INITIAL_CAPITAL, MARGIN_PER_TRADE, LEVERAGE, FEE_PER_SIDE,
  PRESETS, PresetKey, getEffectivePreset,
} from "../utils/all5mAccount";

interface Props {
  account: All5mAccount;
  summary: AccountSummary;
  currentPrice: number | null;
  stoch5mK: number | null;
  onReset: () => Promise<void> | void;
  onCloseManual?: (positionId: string) => Promise<void> | void;
  /** Active preset (anh Tommy v4.7.0) */
  presetKey: PresetKey;
  onSetPreset: (key: PresetKey) => Promise<void> | void;
  /** Price 5m bars cho chart entry/exit markers (anh Tommy v4.7.12) */
  price5mBars?: { time: number; close: number }[];
  /** S/R 15m levels cho status fallback display (anh Tommy v4.7.18) */
  support15m?: number | null;
  resistance15m?: number | null;
  /** Optional content rendered at bottom of the scroll (vd PaperTradeJournal) */
  footer?: React.ReactNode;
}

type Filter = "ALL" | "WIN" | "LOSS";

function fmtUsd(n: number, sign = false) { return (sign && n > 0 ? "+" : "") + "$" + n.toFixed(2); }
function fmtPct(n: number, sign = true) { return (sign && n > 0 ? "+" : "") + n.toFixed(2) + "%"; }
function fmtTime(ms: number) {
  const d = new Date(ms);
  const dd = String(d.getDate()).padStart(2, "0");
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${dd}/${mo} ${hh}:${mi}`;
}
function fmtCountdown(ms: number) {
  if (ms <= 0) return "00:00";
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Price chart 5m + entry/exit markers (anh Tommy v4.7.12).
 * Marker compact để không rối khi nhiều lệnh:
 *   ▲ green (4px) = LONG entry · ▼ red = SHORT entry
 *   ● green (3px) = WIN exit  · ● red = LOSS exit
 * Auto-zoom theo time range của bars + markers (last 100 bars ~8h).
 */
// memo: chỉ re-render khi bars / positions thay đổi thật sự, không re-render theo currentPrice
const PriceChartWithMarkersSvg = memo(function PriceChartWithMarkersSvg({
  bars, positions, width = 760, height = 220, maxBars = 120,
}: {
  bars: { time: number; close: number }[];
  positions: Position[];
  width?: number; height?: number; maxBars?: number;
}) {
  if (!bars || bars.length < 2) {
    return <View style={[styles.chartBox, { width, height, justifyContent: "center", alignItems: "center" }]}>
      <Text style={styles.chartEmpty}>chưa có price data 5m</Text>
    </View>;
  }
  const sortedPositions = [...positions].sort((a, b) => a.entryMs - b.entryMs);
  const intervalMs = bars.length >= 2 ? Math.max(1, bars[1].time - bars[0].time) : 300_000;
  const markerStart = sortedPositions.length > 0
    ? Math.min(...sortedPositions.map((p) => Math.min(p.entryMs, p.exitMs ?? p.entryMs)))
    : null;
  const markerEnd = sortedPositions.length > 0
    ? Math.max(...sortedPositions.map((p) => Math.max(p.entryMs, p.exitMs ?? p.entryMs)))
    : null;

  let slice = bars.slice(-maxBars);
  if (markerStart !== null && markerEnd !== null) {
    const padMs = intervalMs * 6; // ~30m mỗi phía cho chart 5m
    const ranged = bars.filter((b) => b.time >= markerStart - padMs && b.time <= markerEnd + padMs);
    if (ranged.length >= 2) {
      slice = ranged.length > maxBars ? ranged.slice(-maxBars) : ranged;
    }
  }

  const tMin = slice[0].time;
  const tMax = slice[slice.length - 1].time;
  const range = tMax - tMin || 1;
  const closes = slice.map((b) => b.close);
  // dùng loop thay Math.min/max(...array) để tránh stack overflow khi array lớn
  let pMin = closes[0], pMax = closes[0];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] < pMin) pMin = closes[i];
    if (closes[i] > pMax) pMax = closes[i];
  }
  const pRange = pMax - pMin || 1;
  const pad = 8;
  const w = width - pad * 2;
  const h = height - pad * 2;
  const xOf = (t: number) => pad + ((t - tMin) / range) * w;
  const yOf = (p: number) => pad + h - ((p - pMin) / pRange) * h;
  const pricePts = slice.map((b) => `${xOf(b.time).toFixed(1)},${yOf(b.close).toFixed(1)}`).join(" ");
  // Filter positions có time trong range
  const visible = positions.filter((p) => {
    const firstMs = Math.min(p.entryMs, p.exitMs ?? p.entryMs);
    const lastMs = Math.max(p.entryMs, p.exitMs ?? p.entryMs);
    return lastMs >= tMin - intervalMs && firstMs <= tMax + intervalMs;
  });
  return (
    <View style={{ width, height, backgroundColor: P.surface, borderRadius: 2, borderWidth: 1, borderColor: P.borderSoft }}>
      <Svg width={width} height={height}>
        {/* Price line */}
        <Polyline points={pricePts} fill="none" stroke={P.bitcoinOrange} strokeWidth={1.2} opacity={0.85} />
        {/* Markers */}
        {visible.map((p) => {
          const eX = xOf(p.entryMs);
          const eY = yOf(p.entryPrice);
          const longSide = p.side === "LONG";
          const entryColor = longSide ? P.green : P.error;
          // Triangle 5px (entry)
          const tri = longSide
            ? `${eX},${eY - 4} ${eX - 3.5},${eY + 2} ${eX + 3.5},${eY + 2}`
            : `${eX},${eY + 4} ${eX - 3.5},${eY - 2} ${eX + 3.5},${eY - 2}`;
          // Exit dot if closed and within range
          let exitMark = null;
          if (p.exitMs && p.exitPrice && p.exitMs <= tMax + intervalMs && p.exitMs >= tMin - intervalMs) {
            const xX = xOf(p.exitMs);
            const xY = yOf(p.exitPrice);
            const win = p.status === "WIN";
            // v4.8.33: bỏ connect line entry→exit (stack 200 → chart bị rối)
            exitMark = <Circle cx={xX} cy={xY} r={2.5} fill={win ? P.green : P.error} opacity={0.9} />;
          }
          return (
            <React.Fragment key={p.id}>
              <Polygon points={tri} fill={entryColor} opacity={0.95} />
              {exitMark}
            </React.Fragment>
          );
        })}
        {/* Labels */}
        <Text> </Text>
      </Svg>
      {/* Min/max price + legend */}
      <View style={{ position: "absolute", top: 4, left: 8, flexDirection: "row", gap: 12 }}>
        <Text style={{ color: P.dim, fontSize: 9, fontFamily: "monospace" }}>${pMax.toFixed(0)}</Text>
        <Text style={{ color: P.green, fontSize: 9, fontFamily: "monospace" }}>▲ LONG  ● win</Text>
        <Text style={{ color: P.error, fontSize: 9, fontFamily: "monospace" }}>▼ SHORT  ● loss</Text>
      </View>
      <Text style={{ position: "absolute", bottom: 2, left: 8, color: P.dim, fontSize: 9, fontFamily: "monospace" }}>${pMin.toFixed(0)} · {slice.length} cây 5m</Text>
    </View>
  );
});

// memo: chỉ re-render khi equityHistory thay đổi
const EquityCurveSvg = memo(function EquityCurveSvg({ data, width = 760, height = 220 }: { data: { t: number; equity: number }[]; width?: number; height?: number; }) {
  if (!data || data.length < 2) {
    return <View style={[styles.chartBox, { width, height, justifyContent: "center", alignItems: "center" }]}>
      <Text style={styles.chartEmpty}>chưa có data — chờ lệnh đầu tiên đóng</Text>
    </View>;
  }
  const vals = data.map((d) => d.equity);
  const min = Math.min(INITIAL_CAPITAL, ...vals);
  const max = Math.max(INITIAL_CAPITAL, ...vals);
  const range = max - min || 1;
  const pad = 8;
  const w = width - pad * 2;
  const h = height - pad * 2;
  const pts = data.map((d, i) => {
    const x = pad + (i / (data.length - 1)) * w;
    const y = pad + h - ((d.equity - min) / range) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const yInitial = pad + h - ((INITIAL_CAPITAL - min) / range) * h;
  const current = vals[vals.length - 1];
  const color = current >= INITIAL_CAPITAL ? P.green : P.error;
  // Find max + min point indices for marker labels
  let maxIdx = 0, minIdx = 0;
  for (let i = 1; i < vals.length; i++) {
    if (vals[i] > vals[maxIdx]) maxIdx = i;
    if (vals[i] < vals[minIdx]) minIdx = i;
  }
  const xOf = (i: number) => pad + (i / (data.length - 1)) * w;
  const yOf = (v: number) => pad + h - ((v - min) / range) * h;
  // Y-axis tick values: min, mid1, INITIAL_CAPITAL, mid2, max
  const ticks = Array.from(new Set([min, (min + INITIAL_CAPITAL) / 2, INITIAL_CAPITAL, (INITIAL_CAPITAL + max) / 2, max])).sort((a, b) => a - b);
  const fmtV = (v: number) => v >= 10000 ? `$${(v / 1000).toFixed(1)}k` : `$${v.toFixed(0)}`;
  return (
    <View style={{ width, height, backgroundColor: P.surface, borderRadius: 2, borderWidth: 1, borderColor: P.borderSoft }}>
      <Svg width={width} height={height}>
        {/* Baseline line */}
        <Line x1={0} y1={yInitial} x2={width} y2={yInitial} stroke={P.dim} strokeWidth={0.6} strokeDasharray="3,3" />
        {/* Equity polyline */}
        <Polyline points={pts} fill="none" stroke={color} strokeWidth={2} />
        {/* MAX point marker */}
        <Circle cx={xOf(maxIdx)} cy={yOf(vals[maxIdx])} r={3} fill={P.green} />
        {/* MIN point marker (only if different from max and below baseline) */}
        {minIdx !== maxIdx && vals[minIdx] < INITIAL_CAPITAL && (
          <Circle cx={xOf(minIdx)} cy={yOf(vals[minIdx])} r={3} fill={P.error} />
        )}
        {/* CURRENT point marker (last) */}
        <Circle cx={xOf(vals.length - 1)} cy={yOf(current)} r={4} fill={color} stroke={P.surface} strokeWidth={1} />
      </Svg>
      {/* Y-axis tick labels (right edge) */}
      {ticks.map((t, i) => {
        const y = yOf(t);
        if (y < 12 || y > height - 4) return null;
        return (
          <Text key={i} style={{
            position: "absolute", right: 4, top: y - 7,
            color: t === INITIAL_CAPITAL ? P.dim : P.tertiary,
            fontSize: 9, fontFamily: "monospace",
          }}>{fmtV(t)}{t === INITIAL_CAPITAL ? " ─" : ""}</Text>
        );
      })}
      {/* Top-left: MAX value + delta from baseline */}
      <View style={{ position: "absolute", top: 4, left: 6 }}>
        <Text style={{ color: P.green, fontSize: 10, fontFamily: "monospace", fontWeight: "700" }}>
          ▲ MAX {fmtV(max)} ({((max - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100).toFixed(1)}%)
        </Text>
      </View>
      {/* Bottom-left: MIN value + delta */}
      <View style={{ position: "absolute", bottom: 4, left: 6 }}>
        <Text style={{ color: vals[minIdx] >= INITIAL_CAPITAL ? P.dim : P.error, fontSize: 10, fontFamily: "monospace", fontWeight: "700" }}>
          ▼ MIN {fmtV(vals[minIdx])} ({((vals[minIdx] - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100).toFixed(1)}%)
        </Text>
      </View>
      {/* Top-right (next to ticks): CURRENT */}
      <View style={{ position: "absolute", top: 4, left: width / 2 - 50 }}>
        <Text style={{ color, fontSize: 11, fontFamily: "monospace", fontWeight: "800" }}>
          NOW {fmtV(current)} ({((current - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100).toFixed(2)}%)
        </Text>
      </View>
    </View>
  );
});

// ─── Per-position row (memo: chỉ re-render khi currentPrice thay đổi hoặc position data thay đổi) ───
const OpenPositionRow = memo(function OpenPositionRow({
  p, i, currentPrice, onCloseManual,
}: {
  p: Position; i: number; currentPrice: number | null;
  onCloseManual?: (id: string) => void;
}) {
  // v4.9.12 (anh Tommy fix display): leveraged % không cap → confusing.
  // Đổi sang PnL% theo MARGIN (đã cap tại -100% + fee) → consistent với USD column.
  const rawPctMove = currentPrice !== null
    ? (p.side === "LONG" ? (currentPrice - p.entryPrice) : (p.entryPrice - currentPrice)) / p.entryPrice * 100
    : 0;
  let grossUsd = currentPrice !== null ? MARGIN_PER_TRADE * rawPctMove * LEVERAGE / 100 : 0;
  const isLiquidated = grossUsd <= -MARGIN_PER_TRADE; // hit liquidation cap
  if (grossUsd < -MARGIN_PER_TRADE) grossUsd = -MARGIN_PER_TRADE;
  const upnlUsd = grossUsd - FEE_PER_SIDE;
  // PnL% on margin = upnlUsd / margin × 100 (naturally cap at -100% - feeImpact ~-105%)
  const upnlPct = (upnlUsd / MARGIN_PER_TRADE) * 100;
  const color = upnlUsd >= 0 ? P.green : P.error;
  const notional = MARGIN_PER_TRADE * LEVERAGE;
  const distTpPct = currentPrice !== null ? Math.abs(p.tpPrice - currentPrice) / currentPrice * 100 : 0;
  const distSlPct = currentPrice !== null ? Math.abs(p.slPrice - currentPrice) / currentPrice * 100 : 0;
  const heldMin = Math.floor((Date.now() - p.entryMs) / 60000);
  const heldStr = heldMin >= 60 ? `${(heldMin / 60).toFixed(1)}h` : `${heldMin}m`;
  const handleClose = useCallback(() => {
    if (!onCloseManual) return;
    if (typeof window !== "undefined") {
      const ok = window.confirm(`Close ${p.side} @${p.entryPrice.toFixed(0)} ngay tại $${currentPrice?.toFixed(0)}?`);
      if (!ok) return;
    }
    onCloseManual(p.id);
  }, [p.id, p.side, p.entryPrice, currentPrice, onCloseManual]);
  return (
    <View key={p.id} style={styles.row}>
      <Text style={[styles.cellNarrow, { color: P.dim, width: 22 }]}>{i + 1}</Text>
      <Text style={[styles.cellW, { color: P.tertiary }]}>{fmtTime(p.entryMs)}</Text>
      <Text style={[styles.cellW, { color: P.tertiary, fontSize: 10, fontWeight: "700" }]}>{p.source.replace("_", " ")}</Text>
      <Text style={[styles.cellW, { color: P.bitcoinOrange, fontSize: 10 }]}>size ${notional}</Text>
      <Text style={[styles.cellW, { color: P.text }]}>@${p.entryPrice.toFixed(0)}</Text>
      <Text style={[styles.cellW, { color: P.green, fontSize: 10 }]}>TP ${p.tpPrice.toFixed(0)} ({distTpPct.toFixed(2)}%)</Text>
      <Text style={[styles.cellW, { color: P.error, fontSize: 10 }]}>SL ${p.slPrice.toFixed(0)} ({distSlPct.toFixed(2)}%)</Text>
      <Text style={[styles.cellW, { color: P.dim, fontSize: 10 }]}>held {heldStr}</Text>
      <Text style={[styles.cellNarrow, { color, textAlign: "right" }]}>{fmtUsd(upnlUsd, true)}</Text>
      <Text style={[styles.cellNarrow, { color, textAlign: "right", fontSize: 10 }]}>
        {fmtPct(upnlPct)}{isLiquidated ? " 💀" : ""}
      </Text>
      {onCloseManual && (
        <TouchableOpacity onPress={handleClose} style={styles.closeBtn}>
          <Text style={styles.closeBtnText}>✕</Text>
        </TouchableOpacity>
      )}
    </View>
  );
});

// ─── EngineStatus memo component ────────────────────────────────────────────
const EngineStatus = memo(function EngineStatus({
  openLong, openShort, stoch5mK, cooldownRemainMs, freeMargin,
  currentPrice, preset, support15m, resistance15m,
}: {
  openLong: Position[]; openShort: Position[];
  stoch5mK: number | null; cooldownRemainMs: number; freeMargin: number;
  currentPrice: number | null;
  preset: import("../utils/all5mAccount").Preset;
  support15m: number | null; resistance15m: number | null;
}) {
  const STACK_MAX = preset.stackMaxPerSide;
  const SPACING_MIN = preset.stackPerSideSpacingMin;
  const DIST_PCT = preset.stackMinEntryDistPct;
  const STOCH_L = preset.stochLongLevel;
  const STOCH_S = preset.stochShortLevel;
  const SR_PROX = preset.srProximityPct;
  const MIN_MARGIN = 30;
  const now = Date.now();

  const evalSide = (side: "LONG" | "SHORT", list: Position[]) => {
    const count = list.length;
    const lastEntry = list[0] ?? null;
    const blocks: string[] = [];
    if (cooldownRemainMs > 0) blocks.push(`cooldown ${fmtCountdown(cooldownRemainMs)}`);
    if (freeMargin < MIN_MARGIN) blocks.push(`free margin $${freeMargin.toFixed(0)} < $${MIN_MARGIN}`);
    if (count >= STACK_MAX) blocks.push(`STACK FULL ${count}/${STACK_MAX}`);
    if (lastEntry && SPACING_MIN > 0) {
      const sinceMin = (now - lastEntry.entryMs) / 60000;
      if (sinceMin < SPACING_MIN) blocks.push(`spacing còn ${(SPACING_MIN - sinceMin).toFixed(1)}m`);
    }
    if (lastEntry && currentPrice !== null && DIST_PCT > 0) {
      const distPct = Math.abs(currentPrice - lastEntry.entryPrice) / lastEntry.entryPrice * 100;
      if (distPct < DIST_PCT) blocks.push(`dist ${distPct.toFixed(2)}% < ${DIST_PCT}%`);
    }
    const k = stoch5mK;
    const stochTriggered = side === "LONG" ? (k !== null && k < STOCH_L) : (k !== null && k > STOCH_S);
    let srTriggered = false;
    let srInfo = "";
    if (currentPrice !== null) {
      if (side === "LONG" && support15m) {
        const d = ((currentPrice - support15m) / support15m) * 100;
        srTriggered = d >= 0 && d <= SR_PROX;
        srInfo = `Sup $${support15m.toFixed(0)} (${d.toFixed(2)}%)`;
      } else if (side === "SHORT" && resistance15m) {
        const d = ((resistance15m - currentPrice) / currentPrice) * 100;
        srTriggered = d >= 0 && d <= SR_PROX;
        srInfo = `Res $${resistance15m.toFixed(0)} (${d.toFixed(2)}%)`;
      }
    }
    const triggered = stochTriggered || srTriggered;
    let trigger: string;
    if (stochTriggered) trigger = `✅ K=${stoch5mK?.toFixed(1)} ${side === "LONG" ? `<${STOCH_L}` : `>${STOCH_S}`} (stoch)`;
    else if (srTriggered) trigger = `✅ ${srInfo} (S/R fallback)`;
    else { const sk = k !== null ? `K=${k.toFixed(1)}` : "K=—"; trigger = `⏳ no signal · ${sk}${srInfo ? " · " + srInfo : ""}`; }
    if (!triggered) blocks.push("no signal");
    return { count, blocks, trigger };
  };

  const longE = evalSide("LONG", openLong);
  const shortE = evalSide("SHORT", openShort);
  return (
    <View style={esStyles.box}>
      <Text style={esStyles.header}>
        🎯 ENGINE STATUS — {preset.emoji} {preset.label} · K={stoch5mK !== null ? stoch5mK.toFixed(1) : "—"} · ${currentPrice?.toFixed(0) ?? "—"}
      </Text>
      {(["LONG", "SHORT"] as const).map((side) => {
        const e = side === "LONG" ? longE : shortE;
        const ready = e.blocks.length === 0;
        const c = side === "LONG" ? P.green : P.error;
        return (
          <View key={side} style={{ marginBottom: 3 }}>
            <Text style={[esStyles.line, { color: c, fontWeight: "700" }]}>
              {ready ? "✅" : "⏸"} {side} {e.count}/{STACK_MAX} — {ready ? "READY" : "BLOCKED"}
            </Text>
            <Text style={[esStyles.line, { color: ready ? P.green : P.bitcoinOrange }]}>  · {e.trigger}</Text>
            {e.blocks.length > 0 && <Text style={[esStyles.line, { color: P.error }]}>  · block: {e.blocks.join(" · ")}</Text>}
          </View>
        );
      })}
    </View>
  );
});
const esStyles = StyleSheet.create({
  box: { backgroundColor: P.surface, borderWidth: 1, borderColor: P.borderSoft, borderRadius: 4, padding: 10, marginBottom: 12 },
  header: { color: P.text, fontSize: 12, fontWeight: "700", marginBottom: 6, fontFamily: "JetBrainsMono_500Medium" },
  line: { fontSize: 10, fontFamily: "JetBrainsMono_400Regular", lineHeight: 15 },
});

const RULE_OPEN_KEY = "@all5m_rule_open";

export default function All5mPanel({ account, summary, currentPrice, stoch5mK, onReset, onCloseManual, presetKey, onSetPreset, price5mBars, support15m, resistance15m, footer }: Props) {
  const [filter, setFilter] = useState<Filter>("ALL");
  const [ruleOpen, setRuleOpen] = useState(false);
  const { width: winWidth } = useWindowDimensions();
  // Chart width: full window width - padding 32 (root 16 mỗi bên), max 760 cho desktop
  const chartW = Math.min(760, Math.max(280, winWidth - 32));

  // Persist ruleOpen state (anh Tommy: "nhớ rule đã chọn")
  useEffect(() => {
    AsyncStorage.getItem(RULE_OPEN_KEY).then((v) => { if (v === "1") setRuleOpen(true); }).catch(() => {});
  }, []);
  const toggleRule = useCallback(() => {
    setRuleOpen((v) => {
      const next = !v;
      AsyncStorage.setItem(RULE_OPEN_KEY, next ? "1" : "0").catch(() => {});
      return next;
    });
  }, []);
  const preset = getEffectivePreset(presetKey);
  // ALL tunable values từ active preset (anh Tommy v4.7.1)
  const TP_PCT = preset.tpPct;
  const SL_PCT = preset.slPct;
  const STACK_MAX_PER_SIDE = preset.stackMaxPerSide;
  const STACK_MIN_ENTRY_DIST_PCT = preset.stackMinEntryDistPct;
  const STACK_SPACING_MIN = preset.stackPerSideSpacingMin;
  const COOLDOWN_MIN = preset.cooldownMin;
  const STOCH_LONG = preset.stochLongLevel;
  const STOCH_SHORT = preset.stochShortLevel;
  const SR_PROX_PCT = preset.srProximityPct;
  const SR_LOOKBACK = preset.srLookback15m;

  // ── Memoize lists — tránh re-filter mỗi render ──────────────────────────
  const open = useMemo(() => account.positions.filter((p) => p.status === "OPEN"), [account.positions]);
  const closedAll = useMemo(() => account.positions.filter((p) => p.status === "WIN" || p.status === "LOSS"), [account.positions]);
  const closed = useMemo(() => filter === "ALL" ? closedAll : closedAll.filter((p) => p.status === filter), [closedAll, filter]);
  const openLong = useMemo(() => open.filter((p) => p.side === "LONG").sort((a, b) => b.entryMs - a.entryMs), [open]);
  const openShort = useMemo(() => open.filter((p) => p.side === "SHORT").sort((a, b) => b.entryMs - a.entryMs), [open]);
  // v4.8.31: show all open positions (removed 30-row cap per Tommy request)

  const handleSwitchPreset = useCallback((key: PresetKey) => {
    if (key === presetKey) return;
    const target = getEffectivePreset(key);
    if (typeof window !== "undefined") {
      const ok = window.confirm(
        `🔄 SWITCH PRESET → ${target.emoji} ${target.label}?\n\n` +
        `TP +${target.tpPct}% / SL -${target.slPct}%\n` +
        `Stack max ${target.stackMaxPerSide}/side · dist ≥ ${target.stackMinEntryDistPct}%\n\n` +
        `📊 3y backtest: NET +$${target.expectedNet3y.toLocaleString()} · MaxDD $${target.expectedMaxDd3y.toLocaleString()}\n\n` +
        `⚠️ Lệnh OPEN giữ TP/SL CŨ. Lệnh MỚI sẽ dùng preset mới.`
      );
      if (!ok) return;
    }
    Promise.resolve(onSetPreset(key));
  }, [presetKey, onSetPreset]);

  const handleReset = useCallback(() => {
    if (typeof window !== "undefined") {
      const ok = window.confirm(
        `RESET 5m All account?\n\nXoá tất cả lệnh, capital về $${INITIAL_CAPITAL}.\n\nKhông thể undo.`
      );
      if (!ok) return;
    }
    Promise.resolve(onReset());
  }, [onReset]);

  const unrealized = useMemo(() => {
    if (currentPrice === null) return 0;
    let s = 0;
    for (const p of open) {
      const pct = p.side === "LONG"
        ? (currentPrice - p.entryPrice) / p.entryPrice * 100
        : (p.entryPrice - currentPrice) / p.entryPrice * 100;
      let pnl = MARGIN_PER_TRADE * pct * LEVERAGE / 100;
      if (pnl < -MARGIN_PER_TRADE) pnl = -MARGIN_PER_TRADE;
      s += pnl - FEE_PER_SIDE;
    }
    return s;
  }, [open, currentPrice]);

  const equity = account.capital + unrealized;
  const equityRoi = ((equity - INITIAL_CAPITAL) / INITIAL_CAPITAL) * 100;

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.rootContent}>
      <DebugLabel name="All5mPanel" />
      <View style={styles.headerRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.h1}>⚡ 5m ALL — RULE: SMART STACK</Text>
          <Text style={styles.subtitle}>
            Preset: <Text style={{ color: P.bitcoinOrange, fontWeight: "700" }}>{preset.emoji} {preset.label}</Text>
            {` · TP+${TP_PCT}%/SL-${SL_PCT}% · stack ${STACK_MAX_PER_SIDE}/side · K<${STOCH_LONG}/${STOCH_SHORT}`}
          </Text>
        </View>
        <TouchableOpacity onPress={handleReset} style={styles.resetBtn}>
          <Text style={styles.resetBtnText}>🗑 RESET</Text>
        </TouchableOpacity>
      </View>

      {/* PRESET SWITCHER — 7 picks v2 + 3 LEGACY (anh Tommy v4.8.34: add lại 3 legacy) */}
      <View style={styles.presetRow}>
        {([
          "WHALE_MAX_66", "WHALE_MAX_48", "WHALE_MAX_38", "WHALE_MAX_88",
          "TOMI_MAX_55", "WHALE_MID_66", "TOMI_MIN_66",
          "WHALE_MAX", "WHALE_MID", "TOMI_MAX",
        ] as PresetKey[]).map((k) => {
          const p = getEffectivePreset(k);
          const active = k === presetKey;
          // Color theo prefix: WHALE_MAX = đỏ, WHALE_MID = cam, TOMI_MAX = xanh, TOMI_MIN = trắng
          const accentColor =
            k.startsWith("WHALE_MAX") ? P.error :
            k.startsWith("WHALE_MID") ? P.bitcoinOrange :
            k.startsWith("TOMI_MAX")  ? "#3b82f6" :
            k.startsWith("TOMI_MIN")  ? "#9ca3af" :
            "#22c55e";
          return (
            <TouchableOpacity
              key={k}
              onPress={() => handleSwitchPreset(k)}
              style={[
                styles.presetBtn,
                { borderColor: active ? accentColor : P.borderSoft, backgroundColor: active ? accentColor + "22" : P.surface },
              ]}
            >
              <Text style={[styles.presetTitle, { color: active ? accentColor : P.text }]}>
                {p.emoji} {p.label} {active ? "✓" : ""}
              </Text>
              <Text style={styles.presetSub}>
                {`TP+${p.tpPct}%/SL-${p.slPct}% · stack ${p.stackMaxPerSide} · K<${p.stochLongLevel}/${p.stochShortLevel}`}
              </Text>
              <Text style={[styles.presetMetric, { color: accentColor }]}>
                3y: +${(p.expectedNet3y / 1000).toFixed(0)}k · DD ${(p.expectedMaxDd3y / 1000).toFixed(1)}k
              </Text>
              <Text style={styles.presetDesc}>{p.description}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* RULE LOGIC — collapsible (v4.8.31) */}
      <TouchableOpacity onPress={toggleRule} style={styles.ruleToggle} activeOpacity={0.7}>
        <Text style={styles.ruleToggleText}>
          {ruleOpen ? "▼" : "▶"} 📋 RULE: SMART STACK [{preset.emoji} {preset.label}]
          {!ruleOpen ? `  · TP+${TP_PCT}%/SL-${SL_PCT}% · stack ${STACK_MAX_PER_SIDE}/side · K<${STOCH_LONG}/${STOCH_SHORT}` : ""}
        </Text>
      </TouchableOpacity>
      {ruleOpen && (
        <View style={styles.ruleBox}>
          <Text style={styles.ruleLine}>
            <Text style={styles.ruleStrong}>Stack gates per side:</Text>
            {"\n"}  • Tối đa <Text style={[styles.ruleNum, { color: P.bitcoinOrange }]}>{STACK_MAX_PER_SIDE}</Text> lệnh OPEN cùng side
            {"\n"}  • Spacing {STACK_SPACING_MIN} phút · dist ≥ {STACK_MIN_ENTRY_DIST_PCT}% giữa entries cùng side
          </Text>
          <Text style={styles.ruleLine}>
            <Text style={styles.ruleStrong}>Primary:</Text> K &lt; <Text style={styles.ruleNum}>{STOCH_LONG}</Text> → <Text style={[styles.ruleStrong, { color: P.green }]}>LONG</Text> · K &gt; <Text style={styles.ruleNum}>{STOCH_SHORT}</Text> → <Text style={[styles.ruleStrong, { color: P.error }]}>SHORT</Text>
            {"\n"}<Text style={styles.ruleStrong}>Fallback S/R 15m ({SR_LOOKBACK} cây):</Text> close ≤ {SR_PROX_PCT}% từ Support/Resistance
          </Text>
          <Text style={styles.ruleLine}>
            <Text style={styles.ruleStrong}>Exit:</Text> TP <Text style={[styles.ruleNum, { color: P.green }]}>+{TP_PCT}%</Text> · SL <Text style={[styles.ruleNum, { color: P.error }]}>-{SL_PCT}%</Text> · Cooldown {COOLDOWN_MIN}m
            {"\n"}<Text style={styles.ruleStrong}>Risk:</Text> ${MARGIN_PER_TRADE} × {LEVERAGE}x = ${MARGIN_PER_TRADE * LEVERAGE} · fee ${FEE_PER_SIDE.toFixed(2)}/side
            {"\n"}<Text style={styles.ruleStrong}>3y backtest:</Text> NET +${(preset.expectedNet3y / 1000).toFixed(0)}k · MaxDD $${preset.expectedMaxDd3y.toLocaleString()}
          </Text>
        </View>
      )}

      {/* KPI */}
      <View style={styles.kpiGrid}>
        <Kpi label="CAPITAL" value={fmtUsd(account.capital)} color={P.text} />
        <Kpi label="EQUITY" value={fmtUsd(equity)} color={equity >= INITIAL_CAPITAL ? P.green : P.error} sub={`uPnL ${fmtUsd(unrealized, true)}`} />
        <Kpi label="ROI" value={`${equityRoi >= 0 ? "+" : ""}${equityRoi.toFixed(2)}%`} color={equityRoi >= 0 ? P.green : P.error} />
        <Kpi label="WIN RATE" value={summary.totalClosed > 0 ? `${summary.winRate.toFixed(1)}%` : "—"} color={P.tertiary} />
        <Kpi label="TRADES" value={`${summary.totalClosed}`} color={P.text} sub={`${summary.wins}W · ${summary.losses}L`} />
        <Kpi label="OPEN" value={`${summary.openCount}`} color={P.primaryContainer} sub={`free $${summary.freeMargin.toFixed(0)}`} />
      </View>

      {/* ENGINE STATUS — memo component (v4.8.31) */}
      <EngineStatus
        openLong={openLong} openShort={openShort}
        stoch5mK={stoch5mK}
        cooldownRemainMs={summary.cooldownRemainMs}
        freeMargin={summary.freeMargin}
        currentPrice={currentPrice}
        preset={preset}
        support15m={support15m ?? null}
        resistance15m={resistance15m ?? null}
      />

      {/* Price 5m + entry/exit markers (anh Tommy v4.7.12) */}
      {price5mBars && price5mBars.length >= 2 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>📊 PRICE 5m + ENTRIES (last 120 cây ≈ 10h)</Text>
          <PriceChartWithMarkersSvg bars={price5mBars} positions={account.positions} width={chartW} />
        </View>
      )}

      {/* Equity curve */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>📈 EQUITY ({account.equityHistory.length} pts)</Text>
        <EquityCurveSvg data={account.equityHistory} width={chartW} />
      </View>

      {/* OPEN list — split LONG/SHORT, dùng OpenPositionRow memo */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>🟢 OPEN ({open.length}) · TỔNG uPnL: <Text style={{ color: unrealized >= 0 ? P.green : P.error }}>{fmtUsd(unrealized, true)}</Text></Text>
        {open.length === 0 ? (
          <Text style={styles.empty}>chưa có lệnh nào đang mở</Text>
        ) : (
          ([["LONG", openLong], ["SHORT", openShort]] as const).map(([side, list]) => {
            if (list.length === 0) return null;
            let sideUpnl = 0;
            if (currentPrice !== null) {
              for (const p of list) {
                // v4.9.12 fix: tính raw price move, gross USD, cap tại liquidation
                const rawPctMove = (side === "LONG" ? (currentPrice - p.entryPrice) : (p.entryPrice - currentPrice)) / p.entryPrice * 100;
                let grossUsd = MARGIN_PER_TRADE * rawPctMove * LEVERAGE / 100;
                if (grossUsd < -MARGIN_PER_TRADE) grossUsd = -MARGIN_PER_TRADE;
                sideUpnl += grossUsd - FEE_PER_SIDE;
              }
            }
            const sideColor = side === "LONG" ? P.green : P.error;
            return (
              <View key={side} style={{ marginTop: 6 }}>
                <Text style={[styles.sectionTitle, { color: sideColor, marginTop: 4 }]}>
                  {side === "LONG" ? "🟢" : "🔴"} {side} ({list.length}) · uPnL <Text style={{ color: sideUpnl >= 0 ? P.green : P.error }}>{fmtUsd(sideUpnl, true)}</Text>
                </Text>
                {list.map((p, i) => (
                  <OpenPositionRow key={p.id} p={p} i={i} currentPrice={currentPrice} onCloseManual={onCloseManual} />
                ))}
              </View>
            );
          })
        )}
      </View>

      {/* CLOSED history */}
      <View style={styles.section}>
        <View style={styles.filterRow}>
          <Text style={styles.sectionTitle}>📜 CLOSED ({closedAll.length})</Text>
          <View style={{ flexDirection: "row", gap: 6 }}>
            {(["ALL", "WIN", "LOSS"] as Filter[]).map((f) => (
              <TouchableOpacity key={f} onPress={() => setFilter(f)} style={[styles.filterBtn, filter === f && styles.filterBtnActive]}>
                <Text style={[styles.filterBtnText, filter === f && styles.filterBtnTextActive]}>{f}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
        {price5mBars && price5mBars.length >= 2 && closed.length > 0 ? (
          <View style={{ marginBottom: 10 }}>
            <Text style={styles.closedChartTitle}>📉 CLOSE MAP (auto zoom theo lệnh đóng)</Text>
            <PriceChartWithMarkersSvg bars={price5mBars} positions={closed.slice(0, 50)} height={180} maxBars={500} width={chartW} />
          </View>
        ) : null}
        {closed.length === 0
          ? <Text style={styles.empty}>chưa có lệnh đóng</Text>
          : closed.slice(0, 50).map((p) => {
              const color = p.status === "WIN" ? P.green : P.error;
              const sideColor = p.side === "LONG" ? P.green : P.error;
              return (
                <View key={p.id} style={styles.row}>
                  <Text style={[styles.cellW, { color: P.dim, fontSize: 10 }]}>{fmtTime(p.exitMs!)}</Text>
                  <Text style={[styles.cellNarrow, { color, fontWeight: "700" }]}>{p.status}</Text>
                  <Text style={[styles.cellNarrow, { color: sideColor, fontWeight: "700" }]}>{p.side}</Text>
                  <Text style={[styles.cellW, { color: P.dim, fontSize: 10 }]}>{p.source.replace("_", " ")}</Text>
                  <Text style={[styles.cellW, { color: P.bitcoinOrange, fontSize: 10 }]}>size ${MARGIN_PER_TRADE * LEVERAGE}</Text>
                  <Text style={[styles.cellW, { color: P.text }]}>${p.entryPrice.toFixed(0)} → ${p.exitPrice!.toFixed(0)}</Text>
                  <Text style={[styles.cellW, { color: P.dim, fontSize: 10 }]}>fee -${(p.entryFeeUsd + (p.exitFeeUsd ?? FEE_PER_SIDE)).toFixed(2)}</Text>
                  <Text style={[styles.cellNarrow, { color, textAlign: "right" }]}>{fmtUsd(p.pnlNetUsd ?? p.pnlUsd!, true)}</Text>
                </View>
              );
            })}
      </View>
      {footer ? <View style={{ marginTop: 16 }}>{footer}</View> : null}
    </ScrollView>
  );
}

function Kpi({ label, value, color, sub }: { label: string; value: string; color: string; sub?: string }) {
  return (
    <View style={styles.kpi}>
      <Text style={styles.kpiLabel}>{label}</Text>
      <Text style={[styles.kpiValue, { color }]}>{value}</Text>
      {sub ? <Text style={styles.kpiSub}>{sub}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: P.bg },
  rootContent: { padding: 16, paddingBottom: 80 },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 },
  h1: { color: P.primary, fontSize: 16, fontWeight: "700", letterSpacing: 1.5, fontFamily: "SpaceGrotesk_700Bold" },
  subtitle: { color: P.dim, fontSize: 11, marginBottom: 14, fontFamily: "Inter_400Regular" },
  resetBtn: { backgroundColor: P.errorContainer, paddingHorizontal: 14, paddingVertical: 6, borderRadius: 2 },
  resetBtnText: { color: P.onErrorContainer, fontSize: 11, fontWeight: "700", letterSpacing: 1 },
  presetRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 },
  presetBtn: { flexGrow: 1, flexBasis: 150, minWidth: 150, padding: 10, borderRadius: 4, borderWidth: 2, gap: 2 },
  presetTitle: { fontSize: 12, fontWeight: "700", letterSpacing: 0.5 },
  presetSub: { color: P.dim, fontSize: 10 },
  presetMetric: { fontSize: 11, fontWeight: "700", marginTop: 2 },
  presetDesc: { color: P.tertiary, fontSize: 9, fontStyle: "italic" },
  closeBtn: { backgroundColor: P.errorContainer, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 3, marginLeft: 6 },
  closeBtnText: { color: P.onErrorContainer, fontSize: 11, fontWeight: "700" },
  kpiGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 16 },
  kpi: { flexBasis: "15%", flexGrow: 1, backgroundColor: P.surface, borderColor: P.borderSoft, borderWidth: 1, borderRadius: 4, padding: 10, minWidth: 130 },
  kpiLabel: { color: P.dim, fontSize: 9, letterSpacing: 1.2, fontFamily: "JetBrainsMono_500Medium" },
  kpiValue: { fontSize: 18, fontWeight: "800", marginTop: 4, fontFamily: "JetBrainsMono_700Bold" },
  kpiSub: { color: P.dim, fontSize: 10, marginTop: 2, fontFamily: "JetBrainsMono_400Regular" },
  ruleToggle: {
    flexDirection: "row", alignItems: "center", paddingVertical: 6, paddingHorizontal: 10,
    backgroundColor: P.elevated, borderWidth: 1, borderColor: P.border,
    borderLeftWidth: 4, borderLeftColor: P.bitcoinOrange,
    borderRadius: 4, marginBottom: 6,
  },
  ruleToggleText: {
    color: P.bitcoinOrange, fontFamily: "JetBrainsMono_700Bold",
    fontSize: 11, fontWeight: "700", flex: 1,
  },
  ruleBox: {
    backgroundColor: P.elevated, borderWidth: 1, borderColor: P.border,
    borderLeftWidth: 4, borderLeftColor: P.bitcoinOrange,
    borderRadius: 4, padding: 12, marginBottom: 14,
  },
  ruleLine: {
    color: P.text2, fontFamily: "monospace", fontSize: 11, lineHeight: 16, marginBottom: 6,
  },
  ruleStrong: { color: P.text, fontWeight: "700" },
  ruleNum: { color: P.bitcoinOrange, fontWeight: "700" },
  cdBanner: { backgroundColor: P.tertiaryContainer, padding: 10, borderRadius: 4, marginBottom: 12 },
  cdBannerText: { color: P.onTertiaryContainer, fontSize: 12, textAlign: "center", fontFamily: "JetBrainsMono_500Medium" },
  section: { marginBottom: 18 },
  sectionTitle: { color: P.text, fontSize: 13, fontWeight: "700", marginBottom: 8, letterSpacing: 0.4 },
  closedChartTitle: { color: P.tertiary, fontSize: 11, fontWeight: "700", marginBottom: 8, letterSpacing: 0.3 },
  empty: { color: P.dim, fontStyle: "italic", paddingVertical: 8, fontSize: 12 },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 5, borderBottomColor: P.borderSoft, borderBottomWidth: 1, gap: 10, flexWrap: "wrap" },
  cellW: { flexBasis: 110, flexShrink: 0, fontFamily: "JetBrainsMono_500Medium", fontSize: 11 },
  cellNarrow: { flexBasis: 70, flexShrink: 0, fontFamily: "JetBrainsMono_500Medium", fontSize: 11 },
  filterRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  filterBtn: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 2, borderWidth: 1, borderColor: P.borderSoft },
  filterBtnActive: { backgroundColor: P.primaryContainer, borderColor: P.primaryContainer },
  filterBtnText: { color: P.dim, fontSize: 10, letterSpacing: 1, fontFamily: "JetBrainsMono_500Medium" },
  filterBtnTextActive: { color: P.onPrimaryContainer, fontWeight: "700" },
  chartBox: { backgroundColor: P.surface, borderRadius: 2, borderWidth: 1, borderColor: P.borderSoft },
  chartEmpty: { color: P.dim, fontSize: 12, fontStyle: "italic" },
});
