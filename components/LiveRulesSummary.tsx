/**
 * LiveRulesSummary — Material You rule aggregate (v4.3.20)
 *
 * Pattern mirror từ Stitch 02_dashboard_main.html "Live Rules Summary":
 *   bg surface-container-high, rounded-sm, p-5, space-y-5
 *   Top: 4-col grid (Fired/Armed/HTF BLK/Feat BLK), divider border-l per col
 *   Bottom: quote box bg surface-container-lowest border-l-4 border-tertiary (ice blue)
 *   "▸ ĐANG CHỜ TÍN HIỆU" caption + italic body listing top failed conditions.
 */
import React, { useMemo } from "react";
import { View, Text, StyleSheet } from "react-native";
import { P } from "../utils/v2Theme";
import { RuleMatchDetail } from "../hooks/useRuleAlerts";

interface Props {
  trackedIds: Set<string> | string[];
  ruleStatus: Record<string, "ARMED" | "FIRED" | "OFF">;
  ruleMatchDetails: Record<string, RuleMatchDetail>;
}

function LiveRulesSummaryInner({ trackedIds, ruleStatus, ruleMatchDetails }: Props) {
  const stats = useMemo(() => {
    let fired = 0,
      armed = 0,
      htfBlocked = 0,
      featBlocked = 0,
      off = 0;
    const failLabelCount: Record<string, number> = {};
    const idsArr = trackedIds instanceof Set ? Array.from(trackedIds) : trackedIds;
    for (const id of idsArr) {
      const st = ruleStatus[id];
      const d = ruleMatchDetails[id];
      if (!st || st === "OFF" || !d) {
        off++;
        continue;
      }
      if (st === "FIRED") {
        fired++;
        continue;
      }
      const condsAllPass = d.matched >= d.required;
      const htfFails = (d.htfFiltersStatus || []).filter((f) => !f.match);
      const featFails = (d.featFiltersStatus || []).filter((f) => !f.match);
      const htfOk = d.htfMatch !== false && htfFails.length === 0 && d.htfRsiMatch !== false;
      const featOk = featFails.length === 0;
      if (condsAllPass && !htfOk) {
        htfBlocked++;
        htfFails.forEach((f) => {
          failLabelCount[f.label] = (failLabelCount[f.label] || 0) + 1;
        });
      } else if (condsAllPass && htfOk && !featOk) {
        featBlocked++;
        featFails.forEach((f) => {
          failLabelCount[f.label] = (failLabelCount[f.label] || 0) + 1;
        });
      } else {
        armed++;
      }
    }
    const topFails = Object.entries(failLabelCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
    return { fired, armed, htfBlocked, featBlocked, off, total: idsArr.length, topFails };
  }, [trackedIds, ruleStatus, ruleMatchDetails]);

  if (stats.total === 0) return null;

  return (
    <View style={styles.card}>
      <Text style={styles.caption}>▼ LIVE RULES SUMMARY · {stats.total} TRACKED</Text>
      <View style={styles.row}>
        <StatCell label="FIRED" value={stats.fired} color={P.error} />
        <StatCell label="ARMED" value={stats.armed} color={P.primaryContainer} divider />
        <StatCell label="HTF BLK" value={stats.htfBlocked} color={P.dim} divider />
        <StatCell label="FEAT BLK" value={stats.featBlocked} color={P.dim} divider />
      </View>

      {stats.topFails.length > 0 && (
        <View style={styles.quote}>
          <Text style={styles.quoteCaption}>ĐANG CHỜ TÍN HIỆU</Text>
          {stats.topFails.map(([label, count]) => (
            <Text key={label} style={styles.quoteLine} numberOfLines={1}>
              · {count} rule waiting{" "}
              <Text style={styles.quoteLabel}>{label}</Text>
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}

function StatCell({
  label,
  value,
  color,
  divider,
}: {
  label: string;
  value: number;
  color: string;
  divider?: boolean;
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
  card: {
    backgroundColor: P.elevated,
    borderRadius: 2,
    padding: 14,
    marginBottom: 10,
  },
  caption: {
    color: P.text2,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 2,
    textTransform: "uppercase",
    fontFamily: "SpaceGrotesk_700Bold",
    marginBottom: 12,
  },
  row: {
    flexDirection: "row",
  },
  statCell: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 4,
  },
  statCellDivider: {
    borderLeftWidth: 1,
    borderLeftColor: P.highest,
  },
  statLabel: {
    color: P.dim,
    fontSize: 8,
    fontWeight: "700",
    letterSpacing: 1.2,
    textTransform: "uppercase",
    fontFamily: "SpaceGrotesk_700Bold",
    marginBottom: 4,
  },
  statValue: {
    fontSize: 16,
    fontWeight: "700",
    fontFamily: "JetBrainsMono_500Medium",
  },
  quote: {
    marginTop: 14,
    backgroundColor: P.surface,
    borderRadius: 2,
    padding: 12,
    borderLeftWidth: 4,
    borderLeftColor: P.tertiary,
  },
  quoteCaption: {
    color: P.tertiary,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 2,
    textTransform: "uppercase",
    fontFamily: "SpaceGrotesk_700Bold",
    marginBottom: 6,
  },
  quoteLine: {
    color: P.text2,
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    fontStyle: "italic",
    lineHeight: 16,
  },
  quoteLabel: {
    color: P.tertiary,
    fontWeight: "700",
    fontStyle: "normal",
    fontFamily: "SpaceGrotesk_700Bold",
  },
});
