import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { COLORS } from "../utils/constants";
import { LiveSignalRecord } from "../hooks/useLiveSignals";
import { BacktestConfig } from "../utils/backtester";

interface Props {
  activeSignals: LiveSignalRecord[];
  config: BacktestConfig;
}

const CONDITION_LABELS: Record<string, string> = {
  stochExtreme: "StochRSI Cực",
  rsiExtreme: "RSI Cực",
  divergence: "Phân Kỳ",
  bollingerTouch: "Bollinger",
  macdCross: "MACD Đảo",
};

function ScoreDots({ score }: { score: number }) {
  return (
    <View style={styles.scoreDots}>
      {[1, 2, 3, 4, 5].map((i) => (
        <View
          key={i}
          style={[
            styles.dot,
            i <= score && (score >= 4 ? styles.dotHigh : score >= 3 ? styles.dotMed : styles.dotLow),
          ]}
        />
      ))}
    </View>
  );
}

function SignalCard({ record, config }: { record: LiveSignalRecord; config: BacktestConfig }) {
  const { signal, tfLabel, status, currentPnlPct, maxFavorable, maxAdverse } = record;
  const isLong = signal.type === "LONG";
  const dirColor = isLong ? COLORS.bull : COLORS.bear;
  const pnlColor = (currentPnlPct ?? 0) >= 0 ? COLORS.bull : COLORS.bear;

  const leveragedPnl = (currentPnlPct ?? 0) * config.leverage;
  const conditions = Object.entries(signal.conditions)
    .filter(([, v]) => v)
    .map(([k]) => CONDITION_LABELS[k] || k);

  return (
    <View style={[styles.card, { borderColor: dirColor + "40" }]}>
      <View style={styles.cardHeader}>
        <View style={styles.cardLeft}>
          <View style={[styles.dirBadge, { backgroundColor: dirColor + "20" }]}>
            <Text style={[styles.dirText, { color: dirColor }]}>
              {isLong ? "▲ LONG" : "▼ SHORT"}
            </Text>
          </View>
          <Text style={styles.tfBadge}>{tfLabel}</Text>
        </View>
        <View style={styles.cardRight}>
          <ScoreDots score={signal.score} />
          <Text style={styles.scoreText}>{signal.score}/5</Text>
        </View>
      </View>

      <View style={styles.priceRow}>
        <View style={styles.priceItem}>
          <Text style={styles.priceLabel}>Vào</Text>
          <Text style={styles.priceVal}>${signal.entryPrice.toFixed(2)}</Text>
        </View>
        <View style={styles.priceItem}>
          <Text style={[styles.priceLabel, { color: COLORS.bull }]}>TP</Text>
          <Text style={[styles.priceVal, { color: COLORS.bull }]}>${signal.targetPrice.toFixed(2)}</Text>
        </View>
        <View style={styles.priceItem}>
          <Text style={[styles.priceLabel, { color: COLORS.bear }]}>SL</Text>
          <Text style={[styles.priceVal, { color: COLORS.bear }]}>${signal.stopPrice.toFixed(2)}</Text>
        </View>
      </View>

      {status === "ACTIVE" && currentPnlPct !== undefined && (
        <View style={styles.pnlRow}>
          <Text style={[styles.pnlMain, { color: pnlColor }]}>
            {leveragedPnl >= 0 ? "+" : ""}{leveragedPnl.toFixed(1)}%
          </Text>
          <Text style={styles.pnlSub}>
            (giá {currentPnlPct >= 0 ? "+" : ""}{currentPnlPct.toFixed(3)}%)
          </Text>
          <Text style={styles.pnlFav}>
            Max: +{(maxFavorable * config.leverage).toFixed(0)}% / -{(maxAdverse * config.leverage).toFixed(0)}%
          </Text>
        </View>
      )}

      <View style={styles.condRow}>
        {conditions.map((c) => (
          <View key={c} style={styles.condBadge}>
            <Text style={styles.condText}>{c}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function SignalPanelInner({ activeSignals, config }: Props) {
  if (activeSignals.length === 0) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>TÍN HIỆU VÀO LỆNH</Text>
        <View style={styles.emptyBox}>
          <Text style={styles.emptyIcon}>🔍</Text>
          <Text style={styles.emptyText}>Đang quét tín hiệu...</Text>
          <Text style={styles.emptySubText}>
            Cần ít nhất {config.minScore}/5 điều kiện thỏa mãn
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>
        TÍN HIỆU VÀO LỆNH ({activeSignals.length})
      </Text>
      {activeSignals.map((record) => (
        <SignalCard key={record.id} record={record} config={config} />
      ))}
    </View>
  );
}

const SignalPanel = React.memo(SignalPanelInner);
export default SignalPanel;

const styles = StyleSheet.create({
  container: {
    backgroundColor: COLORS.bgCard,
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#ffffff10",
  },
  title: {
    color: COLORS.bitcoin,
    fontSize: 13,
    fontWeight: "700",
    fontFamily: "monospace",
    marginBottom: 10,
    textAlign: "center",
  },
  emptyBox: { alignItems: "center", padding: 20 },
  emptyIcon: { fontSize: 28, marginBottom: 8 },
  emptyText: { color: COLORS.textMuted, fontSize: 12, fontFamily: "monospace" },
  emptySubText: { color: COLORS.neutralDark, fontSize: 10, fontFamily: "monospace", marginTop: 4 },
  card: {
    backgroundColor: "#ffffff05",
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
  },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  cardLeft: { flexDirection: "row", alignItems: "center", gap: 8 },
  cardRight: { flexDirection: "row", alignItems: "center", gap: 6 },
  dirBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  dirText: { fontSize: 12, fontWeight: "900", fontFamily: "monospace" },
  tfBadge: { color: COLORS.bitcoin, fontSize: 12, fontWeight: "700", fontFamily: "monospace" },
  scoreDots: { flexDirection: "row", gap: 3 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#ffffff15" },
  dotHigh: { backgroundColor: COLORS.bull },
  dotMed: { backgroundColor: COLORS.warning },
  dotLow: { backgroundColor: COLORS.bear },
  scoreText: { color: COLORS.textDim, fontSize: 10, fontFamily: "monospace", fontWeight: "700" },
  priceRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 8 },
  priceItem: { alignItems: "center" },
  priceLabel: { color: COLORS.textMuted, fontSize: 8, fontFamily: "monospace", fontWeight: "700" },
  priceVal: { color: COLORS.text, fontSize: 11, fontFamily: "monospace", fontWeight: "700" },
  pnlRow: { alignItems: "center", marginBottom: 8, paddingVertical: 6, backgroundColor: "#ffffff05", borderRadius: 6 },
  pnlMain: { fontSize: 18, fontWeight: "900", fontFamily: "monospace" },
  pnlSub: { color: COLORS.textMuted, fontSize: 9, fontFamily: "monospace", marginTop: 2 },
  pnlFav: { color: COLORS.textMuted, fontSize: 8, fontFamily: "monospace", marginTop: 2 },
  condRow: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  condBadge: { backgroundColor: COLORS.bitcoin + "15", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  condText: { color: COLORS.bitcoin, fontSize: 8, fontWeight: "700", fontFamily: "monospace" },
});
