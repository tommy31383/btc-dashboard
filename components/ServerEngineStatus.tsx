/**
 * ServerEngineStatus — panel "🎯 ENGINE STATUS" cho server preset engine.
 * Render cho cả Real + Paper, switch theo presetView.
 *
 * Format giống All5mPanel ENGINE STATUS:
 *   🎯 ENGINE STATUS — 🔴 WHALE 6/6 ⭐ · K=18.5 · $76465
 *   ⏸ LONG 65/200 — BLOCKED
 *     · ⏳ no signal · K=18.5 · Sup $76045 (0.55%)
 *     · block: free margin $19 < $30 · no signal
 */
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { P } from "../utils/v2Theme";
import { ToggleView } from "./PresetEnginePanel";

interface PresetMeta {
  label: string; emoji: string;
  tpPct: number; slPct: number;
  stackMaxPerSide: number;
  stochLongLevel: number; stochShortLevel: number;
  srProximityPct: number;
  cooldownMin: number;
}

const PRESET_META: Record<string, PresetMeta> = {
  WHALE_MAX_66: { label: "WHALE 6/6 ⭐", emoji: "🔴", tpPct: 6, slPct: 6, stackMaxPerSide: 200, stochLongLevel: 10, stochShortLevel: 90, srProximityPct: 0.4, cooldownMin: 5 },
  WHALE_MAX_48: { label: "WHALE 4/8", emoji: "🔴", tpPct: 4, slPct: 8, stackMaxPerSide: 200, stochLongLevel: 10, stochShortLevel: 90, srProximityPct: 0.4, cooldownMin: 5 },
  WHALE_MAX_38: { label: "WHALE 3/8", emoji: "🔴", tpPct: 3, slPct: 8, stackMaxPerSide: 200, stochLongLevel: 10, stochShortLevel: 90, srProximityPct: 0.4, cooldownMin: 5 },
  WHALE_MAX_88: { label: "WHALE 8/8", emoji: "🔴", tpPct: 8, slPct: 8, stackMaxPerSide: 200, stochLongLevel: 10, stochShortLevel: 90, srProximityPct: 0.4, cooldownMin: 5 },
  WHALE_MID_66: { label: "WHALE 100 6/6", emoji: "🟠", tpPct: 6, slPct: 6, stackMaxPerSide: 100, stochLongLevel: 10, stochShortLevel: 90, srProximityPct: 0.4, cooldownMin: 5 },
  TOMI_MAX_55: { label: "TOMI 200 5/5", emoji: "🔵", tpPct: 5, slPct: 5, stackMaxPerSide: 200, stochLongLevel: 5, stochShortLevel: 95, srProximityPct: 0.2, cooldownMin: 5 },
  TOMI_MIN_66: { label: "TOMI 50 6/6", emoji: "⚪", tpPct: 6, slPct: 6, stackMaxPerSide: 50, stochLongLevel: 5, stochShortLevel: 95, srProximityPct: 0.2, cooldownMin: 5 },
  WHALE_MAX: { label: "WHALE 200 LEGACY", emoji: "🔴", tpPct: 5, slPct: 2.5, stackMaxPerSide: 200, stochLongLevel: 10, stochShortLevel: 90, srProximityPct: 0.4, cooldownMin: 5 },
  WHALE_MID: { label: "WHALE 100 LEGACY", emoji: "🟠", tpPct: 5, slPct: 2.5, stackMaxPerSide: 100, stochLongLevel: 10, stochShortLevel: 90, srProximityPct: 0.4, cooldownMin: 5 },
  TOMI_MAX: { label: "TOMI 200 LEGACY", emoji: "🔵", tpPct: 4, slPct: 4, stackMaxPerSide: 200, stochLongLevel: 5, stochShortLevel: 95, srProximityPct: 0.2, cooldownMin: 5 },
};

interface Props {
  view: ToggleView;
  state: any;
  markPrice: number | null;
}

export default function ServerEngineStatus({ view, state, markPrice }: Props) {
  const cfg = state?.settings || {};
  const diag = state?.presetDiagnostics;
  const isPaper = view === "paper";

  const presetKey = isPaper ? (cfg.paperPresetKey || "WHALE_MAX_66") : (cfg.activePresetKey || "WHALE_MAX_66");
  const preset = PRESET_META[presetKey] || PRESET_META.WHALE_MAX_66;

  // Open positions per side
  let openLong = 0, openShort = 0;
  if (isPaper) {
    const opens = (state?.paperEngine?.positions || []).filter((p: any) => p.status === "OPEN");
    openLong = opens.filter((p: any) => p.side === "LONG").length;
    openShort = opens.filter((p: any) => p.side === "SHORT").length;
  } else {
    openLong = (state?.trackedPositions || []).filter((p: any) => p.side === "LONG").length;
    openShort = (state?.trackedPositions || []).filter((p: any) => p.side === "SHORT").length;
  }

  // Free margin
  let freeMargin = 0, marginPerTrade = 1;
  if (isPaper) {
    const cap = state?.paperEngine?.capital ?? 5000;
    marginPerTrade = cfg.paperMarginUsd ?? 1;
    freeMargin = cap - (openLong + openShort) * marginPerTrade;
  } else {
    freeMargin = parseFloat(state?.binanceSnapshot?.account?.availableBalance ?? "0");
    marginPerTrade = cfg.walletMinUsd ?? 50;
  }

  // Diagnostics from server (last eval ~60s)
  const stochK = diag?.stochK ?? null;
  const support = diag?.support15m ?? null;
  const resistance = diag?.resistance15m ?? null;
  const decision = isPaper ? diag?.paperDecision : diag?.realDecision;

  const evalSide = (side: "LONG" | "SHORT") => {
    const count = side === "LONG" ? openLong : openShort;
    const blocks: string[] = [];
    if (freeMargin < marginPerTrade) blocks.push(`free margin $${freeMargin.toFixed(0)} < $${marginPerTrade}`);
    if (count >= preset.stackMaxPerSide) blocks.push(`STACK FULL ${count}/${preset.stackMaxPerSide}`);

    // Signal trigger
    const stochThreshold = side === "LONG" ? preset.stochLongLevel : preset.stochShortLevel;
    const stochTriggered = stochK !== null && (side === "LONG" ? stochK < stochThreshold : stochK > stochThreshold);
    let srTriggered = false;
    let srInfo = "";
    if (markPrice !== null) {
      if (side === "LONG" && support !== null) {
        const d = ((markPrice - support) / support) * 100;
        srTriggered = d >= 0 && d <= preset.srProximityPct;
        srInfo = `Sup $${support.toFixed(0)} (${d.toFixed(2)}%)`;
      } else if (side === "SHORT" && resistance !== null) {
        const d = ((resistance - markPrice) / markPrice) * 100;
        srTriggered = d >= 0 && d <= preset.srProximityPct;
        srInfo = `Res $${resistance.toFixed(0)} (${d.toFixed(2)}%)`;
      }
    }
    const triggered = stochTriggered || srTriggered;
    let trigger: string;
    if (stochTriggered) trigger = `✅ K=${stochK?.toFixed(1)} ${side === "LONG" ? `<${preset.stochLongLevel}` : `>${preset.stochShortLevel}`} (stoch)`;
    else if (srTriggered) trigger = `✅ ${srInfo} (S/R fallback)`;
    else { const sk = stochK !== null ? `K=${stochK.toFixed(1)}` : "K=—"; trigger = `⏳ no signal · ${sk}${srInfo ? " · " + srInfo : ""}`; }
    if (!triggered) blocks.push("no signal");
    // Decision from server (overrides if has cooldown/already_eval/wallet_low etc)
    if (decision === "COOLDOWN") blocks.unshift("cooldown (server)");
    if (decision === "WALLET_LOW") blocks.unshift("wallet low (server)");

    return { count, blocks, trigger };
  };

  const longE = evalSide("LONG");
  const shortE = evalSide("SHORT");

  return (
    <View style={styles.box}>
      <Text style={styles.header}>
        🎯 ENGINE STATUS {isPaper ? "📋 PAPER" : "🔴 REAL"} — {preset.emoji} {preset.label} · K={stochK !== null ? stochK.toFixed(1) : "—"} · ${markPrice?.toFixed(0) ?? "—"}
      </Text>
      {(["LONG", "SHORT"] as const).map((side) => {
        const e = side === "LONG" ? longE : shortE;
        const ready = e.blocks.length === 0;
        const c = side === "LONG" ? P.green : P.error;
        return (
          <View key={side} style={{ marginBottom: 3 }}>
            <Text style={[styles.line, { color: c, fontWeight: "700" }]}>
              {ready ? "✅" : "⏸"} {side} {e.count}/{preset.stackMaxPerSide} — {ready ? "READY" : "BLOCKED"}
            </Text>
            <Text style={[styles.line, { color: ready ? P.green : P.bitcoinOrange }]}>  · {e.trigger}</Text>
            {e.blocks.length > 0 && <Text style={[styles.line, { color: P.error }]}>  · block: {e.blocks.join(" · ")}</Text>}
          </View>
        );
      })}
      {diag && (
        <Text style={[styles.line, { color: P.dim, marginTop: 4, fontSize: 9 }]}>
          last eval: {new Date(diag.lastEvalMs).toLocaleTimeString()} · bar: {new Date(diag.bar5mTime).toLocaleTimeString()}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { backgroundColor: P.surface, borderWidth: 1, borderColor: P.borderSoft, borderRadius: 4, padding: 10, margin: 8 },
  header: { color: P.text, fontSize: 12, fontWeight: "700", marginBottom: 6, fontFamily: "JetBrainsMono_500Medium" },
  line: { fontSize: 10, fontFamily: "JetBrainsMono_400Regular", lineHeight: 15 },
});
