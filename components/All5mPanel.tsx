/**
 * All5mPanel — full-screen panel cho tab "5m All".
 *
 * Strategy: mỗi 5m closed → quyết định LONG/SHORT theo StochRSI K (LONG K<10,
 * SHORT K>90), fallback S/R 15m. TP+4%/SL-2%. Cooldown 15m sau entry.
 */
import React, { useMemo, useState, useCallback, memo } from "react";
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from "react-native";
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
const MAX_OPEN_ROWS_PER_SIDE = 30;

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
            exitMark = (
              <>
                <Circle cx={xX} cy={xY} r={2.5} fill={win ? P.green : P.error} opacity={0.9} />
                {/* Connect line entry → exit faint */}
                <Line x1={eX} y1={eY} x2={xX} y2={xY} stroke={win ? P.green : P.error} strokeWidth={0.5} strokeDasharray="2,2" opacity={0.4} />
              </>
            );
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
  const upnlPct = currentPrice !== null
    ? (p.side === "LONG" ? (currentPrice - p.entryPrice) : (p.entryPrice - currentPrice)) / p.entryPrice * 100 * LEVERAGE
    : 0;
  let grossUsd = currentPrice !== null ? MARGIN_PER_TRADE * upnlPct / LEVERAGE * LEVERAGE / 100 : 0;
  if (grossUsd < -MARGIN_PER_TRADE) grossUsd = -MARGIN_PER_TRADE;
  const upnlUsd = grossUsd - FEE_PER_SIDE;
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
      {p.trailingStopEnabled
        ? <Text style={[styles.cellW, { color: "#3b82f6", fontSize: 10 }]}>
            TRAIL m{p.lastTrailMilestone ?? 0} · SL ${p.slPrice.toFixed(0)}
          </Text>
        : <Text style={[styles.cellW, { color: P.green, fontSize: 10 }]}>TP ${p.tpPrice.toFixed(0)} ({distTpPct.toFixed(2)}%)</Text>
      }
      <Text style={[styles.cellW, { color: P.error, fontSize: 10 }]}>
        {p.trailingStopEnabled
          ? `dist ${distSlPct.toFixed(2)}%`
          : `SL $${p.slPrice.toFixed(0)} (${distSlPct.toFixed(2)}%)`
        }
      </Text>
      <Text style={[styles.cellW, { color: P.dim, fontSize: 10 }]}>held {heldStr}</Text>
      <Text style={[styles.cellNarrow, { color, textAlign: "right" }]}>{fmtUsd(upnlUsd, true)}</Text>
      <Text style={[styles.cellNarrow, { color, textAlign: "right", fontSize: 10 }]}>{fmtPct(upnlPct)}</Text>
      {onCloseManual && (
        <TouchableOpacity onPress={handleClose} style={styles.closeBtn}>
          <Text style={styles.closeBtnText}>✕</Text>
        </TouchableOpacity>
      )}
    </View>
  );
});

export default function All5mPanel({ account, summary, currentPrice, stoch5mK, onReset, onCloseManual, presetKey, onSetPreset, price5mBars, support15m, resistance15m, footer }: Props) {
  const [filter, setFilter] = useState<Filter>("ALL");
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
  const openLongVisible = useMemo(() => openLong.slice(0, MAX_OPEN_ROWS_PER_SIDE), [openLong]);
  const openShortVisible = useMemo(() => openShort.slice(0, MAX_OPEN_ROWS_PER_SIDE), [openShort]);

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
            {preset.trailingStopEnabled
              ? ` · K<${STOCH_LONG}/K>${STOCH_SHORT} · trail SL · stack ${STACK_MAX_PER_SIDE}/side`
              : ` · TP+${TP_PCT}%/SL-${SL_PCT}% · stack ${STACK_MAX_PER_SIDE}/side · dist ${STACK_MIN_ENTRY_DIST_PCT}%`
            }
          </Text>
        </View>
        <TouchableOpacity onPress={handleReset} style={styles.resetBtn}>
          <Text style={styles.resetBtnText}>🗑 RESET</Text>
        </TouchableOpacity>
      </View>

      {/* PRESET SWITCHER (anh Tommy v4.8.24): 10 picks từ TPSL_GRID_v1 SHORTLIST_v1
        * 7 candidates (composite rank 3.25-5.75) + 3 legacy current prod (6.75-9.50) */}
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
                {p.trailingStopEnabled
                  ? `K<${p.stochLongLevel}/K>${p.stochShortLevel} · trail SL · stack ${p.stackMaxPerSide}`
                  : `TP+${p.tpPct}%/SL-${p.slPct}% · stack ${p.stackMaxPerSide} · dist ${p.stackMinEntryDistPct}%`}
              </Text>
              <Text style={[styles.presetMetric, { color: accentColor }]}>
                3y: +${(p.expectedNet3y / 1000).toFixed(0)}k · DD ${(p.expectedMaxDd3y / 1000).toFixed(1)}k
              </Text>
              <Text style={styles.presetDesc}>{p.description}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* RULE LOGIC — dynamic theo active preset (anh Tommy v4.7.1) */}
      <View style={styles.ruleBox}>
        <Text style={styles.ruleTitle}>📋 RULE: SMART STACK [{preset.emoji} {preset.label}] — nhiều lệnh cùng side, mỗi lệnh TP/SL riêng</Text>
        <Text style={styles.ruleLine}>
          <Text style={styles.ruleStrong}>Stack gates per side (preset {preset.label}):</Text>
          {"\n"}  • Tối đa <Text style={[styles.ruleNum, { color: P.bitcoinOrange }]}>{STACK_MAX_PER_SIDE}</Text> lệnh OPEN cùng side (LONG / SHORT đếm riêng)
          {"\n"}  • Tối thiểu <Text style={styles.ruleNum}>{STACK_SPACING_MIN} phút</Text> giữa 2 entry CÙNG side
          {"\n"}  • Entry mới phải xa entry gần nhất CÙNG side ≥ <Text style={styles.ruleNum}>{STACK_MIN_ENTRY_DIST_PCT}%</Text> (tránh nhồi 1 vùng)
        </Text>
        <Text style={styles.ruleLine}>
          <Text style={styles.ruleStrong}>Trigger:</Text> mỗi cây 5m vừa đóng (close-bar evaluate)
        </Text>
        <Text style={styles.ruleLine}>
          <Text style={styles.ruleStrong}>Primary signal — StochRSI 5m K(14,14,3,3):</Text>
          {"\n"}  • K &lt; <Text style={styles.ruleNum}>{STOCH_LONG}</Text> → vào <Text style={[styles.ruleStrong, { color: P.green }]}>LONG</Text>
          {"\n"}  • K &gt; <Text style={styles.ruleNum}>{STOCH_SHORT}</Text> → vào <Text style={[styles.ruleStrong, { color: P.error }]}>SHORT</Text>
        </Text>
        <Text style={styles.ruleLine}>
          <Text style={styles.ruleStrong}>Fallback — S/R 15m (pivot {SR_LOOKBACK} cây gần nhất):</Text>
          {"\n"}  • Nếu close ≤ <Text style={styles.ruleNum}>{SR_PROX_PCT}%</Text> trên Support → <Text style={[styles.ruleStrong, { color: P.green }]}>LONG</Text>
          {"\n"}  • Nếu close ≤ <Text style={styles.ruleNum}>{SR_PROX_PCT}%</Text> dưới Resistance → <Text style={[styles.ruleStrong, { color: P.error }]}>SHORT</Text>
        </Text>
        <Text style={styles.ruleLine}>
          <Text style={styles.ruleStrong}>Exit (per-lệnh):</Text>{" "}
          {preset.trailingStopEnabled
            ? <>Initial SL <Text style={[styles.ruleNum, { color: P.error }]}>-{SL_PCT}%</Text> · Trailing: PnL hit N×100% → SL ratchet (N-1)×100%{"\n"}  Không có TP cố định — chỉ exit qua SL. Milestone 1→SL breakeven, 2→+100%...</>
            : <>TP <Text style={[styles.ruleNum, { color: P.green }]}>+{TP_PCT}%</Text> · SL <Text style={[styles.ruleNum, { color: P.error }]}>-{SL_PCT}%</Text> raw price.</>
          }
          {"\n"}  Mỗi tick scan TỪNG lệnh OPEN riêng, hit exit → close độc lập (không ảnh hưởng lệnh khác).
        </Text>
        <Text style={styles.ruleLine}>
          <Text style={styles.ruleStrong}>Risk per lệnh:</Text> margin <Text style={styles.ruleNum}>${MARGIN_PER_TRADE}</Text> × <Text style={styles.ruleNum}>{LEVERAGE}x</Text> = notional <Text style={styles.ruleNum}>${MARGIN_PER_TRADE * LEVERAGE}</Text> · fee <Text style={styles.ruleNum}>${FEE_PER_SIDE.toFixed(2)}</Text>/side
        </Text>
        <Text style={styles.ruleLine}>
          <Text style={styles.ruleStrong}>Cooldown chung:</Text> <Text style={styles.ruleNum}>{COOLDOWN_MIN} phút</Text> giữa các entry (mọi side) · không vào trùng cây 5m
        </Text>
        <Text style={styles.ruleLine}>
          <Text style={styles.ruleStrong}>Tên rule:</Text> <Text style={[styles.ruleNum, { color: P.tertiary }]}>SMART_STACK_5M_v2 · {preset.label}</Text> · expected 3y NET +${(preset.expectedNet3y / 1000).toFixed(0)}k · DD ${preset.expectedMaxDd3y}
        </Text>
      </View>

      {/* KPI */}
      <View style={styles.kpiGrid}>
        <Kpi label="CAPITAL" value={fmtUsd(account.capital)} color={P.text} />
        <Kpi label="EQUITY" value={fmtUsd(equity)} color={equity >= INITIAL_CAPITAL ? P.green : P.error} sub={`uPnL ${fmtUsd(unrealized, true)}`} />
        <Kpi label="ROI" value={`${equityRoi >= 0 ? "+" : ""}${equityRoi.toFixed(2)}%`} color={equityRoi >= 0 ? P.green : P.error} />
        <Kpi label="WIN RATE" value={summary.totalClosed > 0 ? `${summary.winRate.toFixed(1)}%` : "—"} color={P.tertiary} />
        <Kpi label="TRADES" value={`${summary.totalClosed}`} color={P.text} sub={`${summary.wins}W · ${summary.losses}L`} />
        <Kpi label="OPEN" value={`${summary.openCount}`} color={P.primaryContainer} sub={`free $${summary.freeMargin.toFixed(0)}`} />
      </View>

      {/* Status detail — memoized theo open/stoch/price thay đổi */}
      {useMemo(() => {
        const longCount = openLong.length;
        const shortCount = openShort.length;
        const k = stoch5mK;
        const cd = summary.cooldownRemainMs;
        const freeM = summary.freeMargin;
        const minMargin = 30;
        const lastLong = openLong[0] ?? null;
        const lastShort = openShort[0] ?? null;
        const now = Date.now();

        // Eval per side
        const evalSide = (side: "LONG" | "SHORT", count: number, lastEntry: Position | null) => {
          const blocks: string[] = [];
          // 1. Cooldown chung
          if (cd > 0) blocks.push(`cooldown ${fmtCountdown(cd)}`);
          // 2. Free margin
          if (freeM < minMargin) blocks.push(`free margin $${freeM.toFixed(0)} < $${minMargin}`);
          // 3. Stack max
          if (count >= STACK_MAX_PER_SIDE) blocks.push(`STACK FULL ${count}/${STACK_MAX_PER_SIDE}`);
          // 4. Spacing per side
          if (lastEntry && STACK_SPACING_MIN > 0) {
            const sinceLastMin = (now - lastEntry.entryMs) / 60000;
            if (sinceLastMin < STACK_SPACING_MIN) {
              blocks.push(`spacing còn ${(STACK_SPACING_MIN - sinceLastMin).toFixed(1)}m`);
            }
          }
          // 5. Distance per side (only valid if currentPrice known)
          if (lastEntry && currentPrice !== null && STACK_MIN_ENTRY_DIST_PCT > 0) {
            const distPct = Math.abs(currentPrice - lastEntry.entryPrice) / lastEntry.entryPrice * 100;
            if (distPct < STACK_MIN_ENTRY_DIST_PCT) {
              blocks.push(`dist ${distPct.toFixed(2)}% < ${STACK_MIN_ENTRY_DIST_PCT}%`);
            }
          }
          // 6. Trigger condition (signal)
          let trigger: string;
          let triggered = false;
          const stochTriggered = side === "LONG" ? (k !== null && k < STOCH_LONG) : (k !== null && k > STOCH_SHORT);
          let srTriggered = false;
          let srInfo = "";
          if (currentPrice !== null) {
            if (side === "LONG" && support15m) {
              const distSup = ((currentPrice - support15m) / support15m) * 100;
              srTriggered = distSup >= 0 && distSup <= SR_PROX_PCT;
              srInfo = `Support $${support15m.toFixed(0)} (cách ${distSup.toFixed(2)}%, trigger ≤${SR_PROX_PCT}%)`;
            } else if (side === "SHORT" && resistance15m) {
              const distRes = ((resistance15m - currentPrice) / currentPrice) * 100;
              srTriggered = distRes >= 0 && distRes <= SR_PROX_PCT;
              srInfo = `Resistance $${resistance15m.toFixed(0)} (cách ${distRes.toFixed(2)}%, trigger ≤${SR_PROX_PCT}%)`;
            }
          }
          triggered = stochTriggered || srTriggered;
          if (stochTriggered) {
            trigger = `✅ Stoch K=${k?.toFixed(1)} ${side === "LONG" ? `<${STOCH_LONG}` : `>${STOCH_SHORT}`} (PRIMARY)`;
          } else if (srTriggered) {
            trigger = `✅ ${srInfo} (FALLBACK)`;
          } else {
            const stochInfo = k !== null ? `K=${k.toFixed(1)} (chờ ${side === "LONG" ? `<${STOCH_LONG}` : `>${STOCH_SHORT}`})` : "K=—";
            trigger = `⏳ Chưa trigger · ${stochInfo}${srInfo ? " · " + srInfo : ""}`;
          }

          if (!triggered) blocks.push("no signal");
          return { triggered, blocks, trigger };
        };

        const longEval = evalSide("LONG", longCount, lastLong);
        const shortEval = evalSide("SHORT", shortCount, lastShort);
        const longReady = longEval.blocks.length === 0;
        const shortReady = shortEval.blocks.length === 0;

        const Bullet = ({ side, count, max, ready, blocks, trigger }: {
          side: "LONG" | "SHORT"; count: number; max: number; ready: boolean; blocks: string[]; trigger: string;
        }) => {
          const sideColor = side === "LONG" ? P.green : P.error;
          const statusColor = ready ? P.green : P.bitcoinOrange;
          return (
            <View style={{ marginBottom: 4 }}>
              <Text style={[styles.cdBannerText, { color: sideColor, textAlign: "left", fontWeight: "700" }]}>
                {ready ? "✅" : "⏸"} {side} {count}/{max} — {ready ? "READY (cây 5m kế đóng → vào lệnh)" : "BLOCKED"}
              </Text>
              <Text style={[styles.cdBannerText, { color: P.dim, textAlign: "left", fontSize: 10 }]}>
                · Trigger: <Text style={{ color: statusColor }}>{trigger}</Text>
              </Text>
              {blocks.length > 0 && (
                <Text style={[styles.cdBannerText, { color: P.error, textAlign: "left", fontSize: 10 }]}>
                  · Block: {blocks.join(" · ")}
                </Text>
              )}
            </View>
          );
        };

        return (
          <View style={[styles.cdBanner, { backgroundColor: P.surface, borderWidth: 1, borderColor: P.borderSoft, padding: 10 }]}>
            <Text style={[styles.cdBannerText, { color: P.text, fontWeight: "700", marginBottom: 6 }]}>
              🎯 ENGINE STATUS — preset {preset.emoji} {preset.label} · K={k !== null ? k.toFixed(1) : "—"} · price ${currentPrice?.toFixed(0) ?? "—"}
            </Text>
            <Bullet side="LONG" count={longCount} max={STACK_MAX_PER_SIDE} ready={longReady} blocks={longEval.blocks} trigger={longEval.trigger} />
            <Bullet side="SHORT" count={shortCount} max={STACK_MAX_PER_SIDE} ready={shortReady} blocks={shortEval.blocks} trigger={shortEval.trigger} />
          </View>
        );
      }, [openLong, openShort, stoch5mK, summary.cooldownRemainMs, summary.freeMargin, currentPrice, preset, STACK_MAX_PER_SIDE, STACK_SPACING_MIN, STACK_MIN_ENTRY_DIST_PCT, STOCH_LONG, STOCH_SHORT, SR_PROX_PCT, support15m, resistance15m])}

      {/* Price 5m + entry/exit markers (anh Tommy v4.7.12) */}
      {price5mBars && price5mBars.length >= 2 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>📊 PRICE 5m + ENTRIES (last 120 cây ≈ 10h)</Text>
          <PriceChartWithMarkersSvg bars={price5mBars} positions={account.positions} />
        </View>
      )}

      {/* Equity curve */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>📈 EQUITY ({account.equityHistory.length} pts)</Text>
        <EquityCurveSvg data={account.equityHistory} />
      </View>

      {/* OPEN list — split LONG/SHORT, dùng OpenPositionRow memo */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>🟢 OPEN ({open.length}) · TỔNG uPnL: <Text style={{ color: unrealized >= 0 ? P.green : P.error }}>{fmtUsd(unrealized, true)}</Text></Text>
        {open.length === 0 ? (
          <Text style={styles.empty}>chưa có lệnh nào đang mở</Text>
        ) : (
          ([["LONG", openLong, openLongVisible], ["SHORT", openShort, openShortVisible]] as const).map(([side, list, visibleList]) => {
            if (list.length === 0) return null;
            let sideUpnl = 0;
            if (currentPrice !== null) {
              for (const p of list) {
                const upnlPct = (side === "LONG" ? (currentPrice - p.entryPrice) : (p.entryPrice - currentPrice)) / p.entryPrice * 100 * LEVERAGE;
                let grossUsd = MARGIN_PER_TRADE * upnlPct / LEVERAGE * LEVERAGE / 100;
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
                {list.length > visibleList.length ? (
                  <Text style={styles.openListHint}>
                    hiện {visibleList.length}/{list.length} lệnh mới nhất để mobile đỡ lag
                  </Text>
                ) : null}
                {visibleList.map((p, i) => (
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
            <PriceChartWithMarkersSvg bars={price5mBars} positions={closed.slice(0, 50)} height={180} maxBars={500} />
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
  presetRow: { flexDirection: "row", gap: 8, marginBottom: 12 },
  presetBtn: { flex: 1, padding: 10, borderRadius: 4, borderWidth: 2, gap: 2 },
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
  ruleBox: {
    backgroundColor: P.elevated, borderWidth: 1, borderColor: P.border,
    borderLeftWidth: 4, borderLeftColor: P.bitcoinOrange,
    borderRadius: 4, padding: 12, marginBottom: 14,
  },
  ruleTitle: {
    color: P.bitcoinOrange, fontFamily: "JetBrainsMono_700Bold",
    fontSize: 12, fontWeight: "900", letterSpacing: 1, marginBottom: 8,
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
  openListHint: { color: P.dim, fontSize: 10, marginBottom: 6, fontStyle: "italic" },
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
