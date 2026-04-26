import React, { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { P } from "../utils/v2Theme";
import gptRuleDrafts from "../assets/gpt_rule_drafts.json";
import DebugLabel from "./DebugLabel";

type TrendLabel = "UP" | "DOWN" | "SIDEWAY";
type TrendRow = {
  interval: string;
  startClose: number;
  endClose: number;
  pct: number;
  trend: TrendLabel;
};

const INTERVALS = ["5m", "15m", "1h", "2h", "4h", "6h", "8h", "12h"] as const;
const REFRESH_MS = 60_000;
const LONG_RULE = gptRuleDrafts.rules[0];

function deriveTrend(pct: number): TrendLabel {
  if (pct > 0.6) return "UP";
  if (pct < -0.6) return "DOWN";
  return "SIDEWAY";
}

function pctColor(trend: TrendLabel) {
  if (trend === "UP") return P.green;
  if (trend === "DOWN") return P.red;
  return P.dim;
}

export default function GptRuleScreen() {
  const [rows, setRows] = useState<TrendRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const results = await Promise.all(
          INTERVALS.map(async (interval) => {
            const res = await fetch(
              `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=6`,
            );
            if (!res.ok) throw new Error(`Fetch ${interval} failed`);
            const data = await res.json();
            const startClose = Number(data[0]?.[4] ?? 0);
            const endClose = Number(data[5]?.[4] ?? 0);
            const pct = startClose > 0 ? ((endClose - startClose) / startClose) * 100 : 0;
            return {
              interval,
              startClose,
              endClose,
              pct,
              trend: deriveTrend(pct),
            } satisfies TrendRow;
          }),
        );
        if (cancelled) return;
        setRows(results);
        setUpdatedAt(Date.now());
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Load trend failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const summary = useMemo(() => {
    const up = rows.filter((row) => row.trend === "UP").length;
    const down = rows.filter((row) => row.trend === "DOWN").length;
    const sideway = rows.filter((row) => row.trend === "SIDEWAY").length;
    return { up, down, sideway };
  }, [rows]);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <DebugLabel name="GptRuleScreen" />
      <View style={styles.headerCard}>
        <Text style={styles.eyebrow}>GPT RULE</Text>
        <Text style={styles.title}>Trend Matrix</Text>
        <Text style={styles.subtitle}>Live BTCUSDT, cach tinh theo 5 nen gan nhat moi khung.</Text>
      </View>

      <View style={styles.summaryRow}>
        <View style={styles.summaryCard}>
          <Text style={styles.summaryLabel}>UP</Text>
          <Text style={[styles.summaryValue, { color: P.green }]}>{summary.up}</Text>
        </View>
        <View style={styles.summaryCard}>
          <Text style={styles.summaryLabel}>DOWN</Text>
          <Text style={[styles.summaryValue, { color: P.red }]}>{summary.down}</Text>
        </View>
        <View style={styles.summaryCard}>
          <Text style={styles.summaryLabel}>SIDEWAY</Text>
          <Text style={[styles.summaryValue, { color: P.dim }]}>{summary.sideway}</Text>
        </View>
      </View>

      <View style={styles.tableCard}>
        <View style={styles.tableHead}>
          <Text style={[styles.headText, styles.colInterval]}>TF</Text>
          <Text style={[styles.headText, styles.colTrend]}>TREND</Text>
          <Text style={[styles.headText, styles.colPct]}>5C %</Text>
        </View>

        {loading ? (
          <View style={styles.loadingWrap}>
            <ActivityIndicator size="small" color={P.primaryContainer} />
            <Text style={styles.loadingText}>Dang tai live trend...</Text>
          </View>
        ) : null}

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        {!loading && !error
          ? rows.map((row) => (
              <View key={row.interval} style={styles.tableRow}>
                <Text style={[styles.cellText, styles.colInterval]}>{row.interval}</Text>
                <Text style={[styles.cellText, styles.colTrend, { color: pctColor(row.trend) }]}>
                  {row.trend}
                </Text>
                <Text style={[styles.cellText, styles.colPct, { color: pctColor(row.trend) }]}>
                  {row.pct >= 0 ? "+" : ""}
                  {row.pct.toFixed(2)}%
                </Text>
              </View>
            ))
          : null}
      </View>

      <View style={styles.ruleCard}>
        <Text style={styles.ruleEyebrow}>RULE DRAFT</Text>
        <Text style={styles.ruleTitle}>{LONG_RULE.name}</Text>
        <Text style={styles.ruleBody}>{LONG_RULE.thesis}</Text>

        <View style={styles.ruleSection}>
          <Text style={styles.ruleSectionTitle}>Entry Rules</Text>
          {LONG_RULE.entryRules.map((item) => (
            <Text key={item} style={styles.ruleLine}>
              - {item}
            </Text>
          ))}
        </View>

        <View style={styles.ruleSection}>
          <Text style={styles.ruleSectionTitle}>Entry</Text>
          <Text style={styles.ruleBody}>{LONG_RULE.entry}</Text>
        </View>

        <View style={styles.ruleSection}>
          <Text style={styles.ruleSectionTitle}>SL</Text>
          <Text style={styles.ruleBody}>{LONG_RULE.stopLoss}</Text>
        </View>

        <View style={styles.ruleSection}>
          <Text style={styles.ruleSectionTitle}>TP</Text>
          {LONG_RULE.takeProfit.map((item) => (
            <Text key={item} style={styles.ruleLine}>
              - {item}
            </Text>
          ))}
        </View>

        <View style={styles.ruleSection}>
          <Text style={styles.ruleSectionTitle}>Cancel</Text>
          {LONG_RULE.cancelRules.map((item) => (
            <Text key={item} style={styles.ruleLine}>
              - {item}
            </Text>
          ))}
        </View>
      </View>

      <Text style={styles.footerText}>
        Cap nhat: {updatedAt ? new Date(updatedAt).toLocaleTimeString() : "--:--:--"}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: P.bg,
  },
  content: {
    padding: 16,
    paddingBottom: 88,
    gap: 12,
  },
  headerCard: {
    backgroundColor: P.card,
    borderWidth: 1,
    borderColor: P.border,
    padding: 16,
    gap: 8,
  },
  eyebrow: {
    color: P.primaryContainer,
    fontFamily: "JetBrainsMono_700Bold",
    fontSize: 10,
    letterSpacing: 1.6,
  },
  title: {
    color: P.text,
    fontFamily: "SpaceGrotesk_700Bold",
    fontSize: 24,
  },
  subtitle: {
    color: P.text2,
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    lineHeight: 19,
  },
  summaryRow: {
    flexDirection: "row",
    gap: 10,
  },
  summaryCard: {
    flex: 1,
    backgroundColor: P.cardAlt,
    borderWidth: 1,
    borderColor: P.border,
    padding: 14,
    gap: 6,
  },
  summaryLabel: {
    color: P.dim,
    fontFamily: "JetBrainsMono_500Medium",
    fontSize: 10,
    letterSpacing: 1.2,
  },
  summaryValue: {
    fontFamily: "SpaceGrotesk_700Bold",
    fontSize: 20,
  },
  tableCard: {
    backgroundColor: P.card,
    borderWidth: 1,
    borderColor: P.border,
    overflow: "hidden",
  },
  tableHead: {
    flexDirection: "row",
    backgroundColor: P.surface,
    borderBottomWidth: 1,
    borderBottomColor: P.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  headText: {
    color: P.dim,
    fontFamily: "JetBrainsMono_700Bold",
    fontSize: 10,
    letterSpacing: 1.2,
  },
  tableRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: P.borderSoft,
  },
  cellText: {
    color: P.text,
    fontFamily: "JetBrainsMono_500Medium",
    fontSize: 13,
  },
  colInterval: {
    flex: 0.9,
  },
  colTrend: {
    flex: 1.4,
  },
  colPct: {
    flex: 1,
    textAlign: "right",
  },
  loadingWrap: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingVertical: 20,
  },
  loadingText: {
    color: P.dim,
    fontFamily: "Inter_400Regular",
    fontSize: 13,
  },
  errorText: {
    color: P.red,
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    padding: 16,
  },
  footerText: {
    color: P.dim,
    fontFamily: "JetBrainsMono_500Medium",
    fontSize: 10,
    textAlign: "center",
    letterSpacing: 1,
  },
  ruleCard: {
    backgroundColor: P.cardAlt,
    borderWidth: 1,
    borderColor: P.border,
    borderLeftWidth: 3,
    borderLeftColor: P.primaryContainer,
    padding: 16,
    gap: 12,
  },
  ruleEyebrow: {
    color: P.primaryContainer,
    fontFamily: "JetBrainsMono_700Bold",
    fontSize: 10,
    letterSpacing: 1.4,
  },
  ruleTitle: {
    color: P.text,
    fontFamily: "SpaceGrotesk_700Bold",
    fontSize: 20,
  },
  ruleSection: {
    gap: 6,
  },
  ruleSectionTitle: {
    color: P.primary,
    fontFamily: "SpaceGrotesk_700Bold",
    fontSize: 14,
  },
  ruleBody: {
    color: P.text2,
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    lineHeight: 19,
  },
  ruleLine: {
    color: P.text,
    fontFamily: "JetBrainsMono_500Medium",
    fontSize: 12,
    lineHeight: 18,
  },
});
