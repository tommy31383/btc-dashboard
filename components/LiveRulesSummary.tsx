/**
 * LiveRulesSummary — Material You rule aggregate (v4.3.36)
 *
 * v4.3.36: thêm ETA cho mỗi failed condition (slope-projected, refresh 5 min).
 *   - Aggregate fail-counts per (label, tfKey) thay vì chỉ theo label
 *   - Parse label → indicator + threshold
 *   - useIndicatorHistory cung cấp slope/min → ETA tới ngưỡng
 *   - Format: "(~12m)" / "(~2.3h)" / "↗ đang đi xa" / "đang gom mẫu..."
 */
import React, { useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { P } from "../utils/v2Theme";
import { RuleMatchDetail } from "../hooks/useRuleAlerts";
import { TFAnalysis } from "../hooks/useBinanceKlines";
import { parseRuleId } from "../hooks/useTrackedRules";
import DebugLabel from "./DebugLabel";
import {
  useIndicatorHistory, parseFilterLabel, estimateETA, formatETA,
} from "../hooks/useIndicatorHistory";

interface Props {
  trackedIds: Set<string> | string[];
  ruleStatus: Record<string, "ARMED" | "FIRED" | "OFF">;
  ruleMatchDetails: Record<string, RuleMatchDetail>;
  tfData: TFAnalysis[];
}

function LiveRulesSummaryInner({ trackedIds, ruleStatus, ruleMatchDetails, tfData }: Props) {
  const history = useIndicatorHistory(tfData);

  const stats = useMemo(() => {
    let fired = 0, armed = 0, htfBlocked = 0, featBlocked = 0, off = 0;
    /** key = `${label}|${tfKey}` so we can look up per-TF slope. */
    const failKeyCount: Record<string, { label: string; tfKey: string; count: number }> = {};
    const idsArr = trackedIds instanceof Set ? Array.from(trackedIds) : trackedIds;
    for (const id of idsArr) {
      const st = ruleStatus[id];
      const d = ruleMatchDetails[id];
      if (!st || st === "OFF" || !d) { off++; continue; }
      if (st === "FIRED") { fired++; continue; }
      const { tfKey } = parseRuleId(id);
      const condsAllPass = d.matched >= d.required;
      const htfFails = (d.htfFiltersStatus || []).filter((f) => !f.match);
      const featFails = (d.featFiltersStatus || []).filter((f) => !f.match);
      const htfOk = d.htfMatch !== false && htfFails.length === 0 && d.htfRsiMatch !== false;
      const featOk = featFails.length === 0;
      const bump = (label: string) => {
        const k = `${label}|${tfKey}`;
        if (!failKeyCount[k]) failKeyCount[k] = { label, tfKey, count: 0 };
        failKeyCount[k].count++;
      };
      if (condsAllPass && !htfOk) {
        htfBlocked++;
        htfFails.forEach((f) => bump(f.label));
      } else if (condsAllPass && htfOk && !featOk) {
        featBlocked++;
        featFails.forEach((f) => bump(f.label));
      } else {
        armed++;
      }
    }
    const topFails = Object.values(failKeyCount)
      .sort((a, b) => b.count - a.count)
      .slice(0, 4);
    return { fired, armed, htfBlocked, featBlocked, off, total: idsArr.length, topFails };
  }, [trackedIds, ruleStatus, ruleMatchDetails]);

  // ETA per fail row — recomputed when history ref tick changes (every 5 min)
  // or when topFails list itself changes.
  // Animated dots for "đang gom mẫu..." state — cycle every 500ms
  const [dotPhase, setDotPhase] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setDotPhase((p) => (p + 1) % 3), 500);
    return () => clearInterval(id);
  }, []);
  const dots = ".".repeat(dotPhase + 1).padEnd(3, " ");

  const failsWithETA = useMemo(() => {
    return stats.topFails.map((f) => {
      const parsed = parseFilterLabel(f.label);
      if (!parsed) return { ...f, etaText: "", etaColor: P.dim, eta: null as any, parsed: null };
      const eta = estimateETA(history, f.tfKey, parsed);
      const etaText = formatETA(eta);
      const etaColor =
        eta.direction === "approaching" && (eta.etaMinutes ?? Infinity) < 60 ? P.green
        : eta.direction === "approaching" ? P.bitcoinOrange
        : eta.direction === "away" ? P.error
        : P.dim;
      return { ...f, etaText, etaColor, eta, parsed };
    });
  }, [stats.topFails, history]);

  function fmtVal(v: number): string {
    return Math.abs(v) < 10 ? v.toFixed(2) : v.toFixed(1);
  }
  function targetText(p: NonNullable<ReturnType<typeof parseFilterLabel>>): string {
    if (p.op === "between") return `${fmtVal(p.min!)}–${fmtVal(p.max!)}`;
    return `${p.op} ${fmtVal(p.val!)}`;
  }

  if (stats.total === 0) return null;

  return (
    <CollapsibleSummary
      total={stats.total}
      failCount={failsWithETA.length}
      stats={stats}
      failsWithETA={failsWithETA}
      dots={dots}
      fmtVal={fmtVal}
    />
  );
}

function CollapsibleSummary({
  total, failCount, stats, failsWithETA, dots, fmtVal,
}: any) {
  const [collapsed, setCollapsed] = React.useState(false);
  React.useEffect(() => {
    AsyncStorage.getItem("@dashboard_card_rules_summary").then((v) => {
      if (v === "1") setCollapsed(true);
    }).catch(() => {});
  }, []);
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    AsyncStorage.setItem("@dashboard_card_rules_summary", next ? "1" : "0").catch(() => {});
  };
  return (
    <View style={styles.card}>
      <DebugLabel name="LiveRulesSummary" />
      <TouchableOpacity onPress={toggle} activeOpacity={0.7}>
        <Text style={styles.caption}>{collapsed ? "▶" : "▼"} LIVE RULES SUMMARY · {total} TRACKED{failCount > 0 ? ` · ${failCount} chờ` : ""}</Text>
      </TouchableOpacity>
      {!collapsed && (<>
      <View style={styles.row}>
        <StatCell label="FIRED" value={stats.fired} color={P.error} />
        <StatCell label="ARMED" value={stats.armed} color={P.primaryContainer} divider />
        <StatCell label="HTF BLK" value={stats.htfBlocked} color={P.dim} divider />
        <StatCell label="FEAT BLK" value={stats.featBlocked} color={P.dim} divider />
      </View>

      {failsWithETA.length > 0 && (
        <View style={styles.quote}>
          <Text style={styles.quoteCaption}>ĐANG CHỜ TÍN HIỆU · ETA refresh mỗi 20s</Text>
          {failsWithETA.map((f: any) => {
            const isInsuf = f.eta?.direction === "insufficient";
            const cur = f.eta?.current;
            const have = f.eta?.samplesCount ?? 0;
            const need = f.eta?.samplesNeeded ?? 3;
            return (
              <View key={`${f.label}|${f.tfKey}`} style={styles.quoteRow}>
                <Text style={styles.quoteLine} numberOfLines={1}>
                  · {f.count} rule [{f.tfKey.toUpperCase()}] chờ{" "}
                  <Text style={styles.quoteLabel}>{f.label}</Text>
                  {isInsuf && f.parsed && cur !== undefined ? (
                    <Text style={styles.quoteSub}>
                      {"  "}now <Text style={{ color: P.text2 }}>{fmtVal(cur)}</Text>
                    </Text>
                  ) : null}
                </Text>
                {isInsuf ? (
                  <Text style={[styles.etaText, { color: P.dim }]}>
                    gom {have}/{need}
                    <Text style={{ color: P.bitcoinOrange }}>{dots}</Text>
                  </Text>
                ) : f.etaText ? (
                  <Text style={[styles.etaText, { color: f.etaColor }]}>{f.etaText}</Text>
                ) : null}
              </View>
            );
          })}
        </View>
      )}
      </>)}
    </View>
  );
}

function StatCell({ label, value, color, divider }: {
  label: string; value: number; color: string; divider?: boolean;
}) {
  const active = value > 0;
  return (
    <View style={[styles.statCell, divider && styles.statCellDivider]}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, { color: active ? color : P.dim }]}>
        {value.toString().padStart(2, "0")}
      </Text>
    </View>
  );
}

const LiveRulesSummary = React.memo(LiveRulesSummaryInner);
export default LiveRulesSummary;

const styles = StyleSheet.create({
  card: { backgroundColor: P.elevated, borderRadius: 2, padding: 14, marginBottom: 10 },
  caption: {
    color: P.text2, fontSize: 10, fontWeight: "700", letterSpacing: 2,
    textTransform: "uppercase", fontFamily: "SpaceGrotesk_700Bold", marginBottom: 12,
  },
  row: { flexDirection: "row" },
  statCell: { flex: 1, alignItems: "center", paddingVertical: 4 },
  statCellDivider: { borderLeftWidth: 1, borderLeftColor: P.highest },
  statLabel: {
    color: P.dim, fontSize: 8, fontWeight: "700", letterSpacing: 1.2,
    textTransform: "uppercase", fontFamily: "SpaceGrotesk_700Bold", marginBottom: 4,
  },
  statValue: { fontSize: 16, fontWeight: "700", fontFamily: "JetBrainsMono_500Medium" },
  quote: {
    marginTop: 14, backgroundColor: P.surface, borderRadius: 2, padding: 12,
    borderLeftWidth: 4, borderLeftColor: P.tertiary,
  },
  quoteCaption: {
    color: P.tertiary, fontSize: 10, fontWeight: "700", letterSpacing: 1.5,
    textTransform: "uppercase", fontFamily: "SpaceGrotesk_700Bold", marginBottom: 6,
  },
  quoteRow: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    gap: 8, paddingVertical: 2,
  },
  quoteLine: {
    flex: 1, color: P.text2, fontSize: 11,
    fontFamily: "Inter_400Regular", fontStyle: "italic", lineHeight: 16,
  },
  quoteLabel: {
    color: P.tertiary, fontWeight: "700", fontStyle: "normal",
    fontFamily: "SpaceGrotesk_700Bold",
  },
  quoteSub: {
    color: P.dim, fontSize: 10, fontStyle: "normal",
    fontFamily: "JetBrainsMono_500Medium",
  },
  etaText: {
    fontSize: 10, fontWeight: "700", letterSpacing: 0.5,
    fontFamily: "JetBrainsMono_700Bold", minWidth: 56, textAlign: "right",
  },
});
