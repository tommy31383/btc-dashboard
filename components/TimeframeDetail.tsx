import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { COLORS } from "../utils/constants";
import { TFAnalysis } from "../hooks/useBinanceKlines";

interface Props {
  tf: TFAnalysis;
}

function fmt(n: number | null, dec = 2): string {
  return n === null ? "—" : n.toFixed(dec);
}

function fmtPrice(n: number | null): string {
  return n === null ? "—" : "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtVol(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return n.toFixed(2);
}

export default function TimeframeDetail({ tf }: Props) {
  const priceAboveEma9 = tf.ema9 !== null && tf.lastClose > tf.ema9;
  const bbPosition =
    tf.bollingerUpper !== null && tf.bollingerLower !== null
      ? tf.lastClose > tf.bollingerUpper
        ? "TRÊN BAND TRÊN"
        : tf.lastClose < tf.bollingerLower
        ? "DƯỚI BAND DƯỚI"
        : "Trong vùng"
      : "—";
  const bbColor =
    bbPosition === "TRÊN BAND TRÊN" ? COLORS.bear :
    bbPosition === "DƯỚI BAND DƯỚI" ? COLORS.bull : COLORS.neutral;

  return (
    <View style={styles.container}>
      <View style={styles.box}>
        <Text style={styles.boxTitle}>EMA</Text>
        <Text style={styles.row}><Text style={styles.label}>EMA 9: </Text><Text style={styles.val}>{fmtPrice(tf.ema9)}</Text></Text>
        <Text style={styles.row}><Text style={styles.label}>EMA 21: </Text><Text style={styles.val}>{fmtPrice(tf.ema21)}</Text></Text>
        <Text style={styles.row}><Text style={styles.label}>EMA 50: </Text><Text style={styles.val}>{fmtPrice(tf.ema50)}</Text></Text>
        <Text style={styles.row}><Text style={styles.label}>EMA 200: </Text><Text style={styles.val}>{fmtPrice(tf.ema200)}</Text></Text>
        <Text style={[styles.status, { color: priceAboveEma9 ? COLORS.bull : COLORS.bear }]}>
          Giá {priceAboveEma9 ? "TRÊN" : "DƯỚI"} EMA9
        </Text>
      </View>

      <View style={styles.box}>
        <Text style={styles.boxTitle}>BOLLINGER</Text>
        <Text style={styles.row}><Text style={styles.label}>Trên: </Text><Text style={styles.val}>{fmtPrice(tf.bollingerUpper)}</Text></Text>
        <Text style={styles.row}><Text style={styles.label}>Giữa: </Text><Text style={styles.val}>{fmtPrice(tf.bollingerMiddle)}</Text></Text>
        <Text style={styles.row}><Text style={styles.label}>Dưới: </Text><Text style={styles.val}>{fmtPrice(tf.bollingerLower)}</Text></Text>
        <Text style={styles.row}><Text style={styles.label}>Độ rộng: </Text><Text style={styles.val}>{fmt(tf.bollingerWidth)}</Text></Text>
        <Text style={[styles.status, { color: bbColor }]}>{bbPosition}</Text>
      </View>

      <View style={styles.box}>
        <Text style={styles.boxTitle}>MACD</Text>
        <Text style={styles.row}><Text style={styles.label}>MACD: </Text><Text style={styles.val}>{fmt(tf.macd)}</Text></Text>
        <Text style={styles.row}><Text style={styles.label}>Tín hiệu: </Text><Text style={styles.val}>{fmt(tf.macdSignal)}</Text></Text>
        <Text style={styles.row}>
          <Text style={styles.label}>Histogram: </Text>
          <Text style={[styles.val, {
            color: tf.macdHistogram !== null ? tf.macdHistogram >= 0 ? COLORS.bull : COLORS.bear : COLORS.textMuted
          }]}>{fmt(tf.macdHistogram)}</Text>
        </Text>
      </View>

      <View style={styles.box}>
        <Text style={styles.boxTitle}>KHỐI LƯỢNG</Text>
        <Text style={styles.row}><Text style={styles.label}>Hiện tại: </Text><Text style={styles.val}>{fmtVol(tf.volumeCurrent)}</Text></Text>
        <Text style={styles.row}><Text style={styles.label}>TB(20): </Text><Text style={styles.val}>{fmtVol(tf.volumeAvg)}</Text></Text>
        {tf.volumeHigh && (
          <Text style={[styles.status, { color: COLORS.warning }]}>KHỐI LƯỢNG CAO 🔥</Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flexDirection: "row", flexWrap: "wrap", gap: 8, padding: 12, backgroundColor: COLORS.bgPanel + "88", borderRadius: 8, marginTop: 4, marginBottom: 8 },
  box: { flex: 1, minWidth: "45%", backgroundColor: COLORS.bg + "cc", borderRadius: 8, padding: 10, borderWidth: 1, borderColor: "#ffffff10" },
  boxTitle: { color: COLORS.bitcoin, fontSize: 11, fontWeight: "700", fontFamily: "monospace", marginBottom: 6 },
  row: { marginBottom: 2 },
  label: { color: COLORS.textMuted, fontSize: 10, fontFamily: "monospace" },
  val: { color: COLORS.text, fontSize: 10, fontWeight: "600", fontFamily: "monospace" },
  status: { fontSize: 10, fontWeight: "700", fontFamily: "monospace", marginTop: 4 },
});
