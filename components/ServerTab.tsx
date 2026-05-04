/**
 * ServerTab v0.4.2 (anh Tommy kill preset legacy) — TomiHedge ONLY.
 *
 * Layout:
 *   - Login form (if not authed)
 *   - Header (server status + version + logout)
 *   - TomiHedgePanel (paper) — Hedge01 rule
 *   - KPIs (Binance wallet/avail/daily)
 *   - Actions (reset paper)
 */
import React, { useState } from "react";
import { View, Text, ScrollView, TextInput, TouchableOpacity, StyleSheet } from "react-native";
import { P } from "../utils/v2Theme";
import DebugLabel from "./DebugLabel";
import { useBackendLive } from "../hooks/useBackendLive";
import { SERVER_URL, api } from "../utils/backendApi";
import { DESTRUCTIVE_PWD } from "../utils/serverSecrets";
import TomiHedgePanel, { TomiHedgeView } from "./TomiHedgePanel";

interface ServerTabProps {
  klinesByTf?: Record<string, { time: number; close: number }[]>;
}

export default function ServerTab({ klinesByTf: _klinesByTf }: ServerTabProps = {}) {
  const live = useBackendLive();
  const [pwInput, setPwInput] = useState("");
  const [tomiView, setTomiView] = useState<TomiHedgeView>("paper");

  const s = live.state;
  const allPos = s?.binanceSnapshot?.positions ?? [];
  const symbol = s?.settings?.symbol ?? "BTCUSDT";
  const symPos = allPos.find((p: any) => p.symbol === symbol);
  const markPrice = symPos ? parseFloat(symPos.markPrice) : null;

  if (live.loading) {
    return (
      <View style={styles.center}>
        <Text style={styles.dim}>⏳ Connecting to {SERVER_URL}...</Text>
        <Text style={[styles.dim, { fontSize: 10, marginTop: 8, fontStyle: "italic" }]}>
          Tự timeout sau 10s nếu server không phản hồi
        </Text>
      </View>
    );
  }

  if (!live.authed) {
    return (
      <View style={styles.center}>
        <DebugLabel name="ServerTab.Login" />
        <Text style={styles.h1}>🔐 LOGIN — btc-trader-server</Text>
        <Text style={styles.dim}>Server: {SERVER_URL}</Text>
        <TextInput
          value={pwInput}
          onChangeText={setPwInput}
          secureTextEntry
          placeholder="Nhập password..."
          placeholderTextColor={P.dim}
          style={styles.input}
        />
        <TouchableOpacity style={styles.btnPrimary} onPress={async () => {
          const ok = await live.login(pwInput);
          if (ok) setPwInput("");
        }}>
          <Text style={styles.btnPrimaryText}>LOGIN</Text>
        </TouchableOpacity>
        {live.lastError && <Text style={styles.error}>❌ {live.lastError}</Text>}
      </View>
    );
  }

  // Server stats
  const wallet = s?.binanceSnapshot?.account?.totalWalletBalance ?? "—";
  const avail = s?.binanceSnapshot?.account?.availableBalance ?? "—";
  const dailyPnl = s?.binanceSnapshot?.dailyPnl ?? 0;
  const sched = live.scheduler;
  const lastEvalMs = sched?.lastRuleEvalAt ?? 0;
  const lastEvalAge = lastEvalMs > 0 ? Math.floor((Date.now() - lastEvalMs) / 1000) : -1;
  const ruleKey = s?.settings?.activeRuleKey ?? "hedge01";
  const mode = s?.settings?.serverEngineMode ?? "tomihedge";

  const handleReset = async () => {
    if (typeof window === "undefined") return;
    const cap = window.prompt("Reset paper với capital USDT (default 1000):", "1000");
    if (!cap) return;
    const capNum = parseFloat(cap);
    if (!Number.isFinite(capNum) || capNum < 100) {
      window.alert("Capital phải >= 100");
      return;
    }
    if (!window.confirm(`Anh có chắc reset paper với capital $${capNum}?`)) return;
    try {
      await api.tomihedgePaperReset(DESTRUCTIVE_PWD, capNum);
      await live.refresh();
      window.alert("✅ Reset paper xong, capital = $" + capNum);
    } catch (e: any) {
      window.alert("❌ " + (e?.message ?? String(e)));
    }
  };

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={{ padding: 8 }}>
      <DebugLabel name="ServerTab" />

      {/* HEADER */}
      <View style={styles.card}>
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.h1}>
              ☁️ BTC TRADER SERVER · 🌊 <Text style={{ color: P.bitcoinOrange }}>{ruleKey.toUpperCase()}</Text>
            </Text>
            <Text style={styles.dim}>
              {SERVER_URL} · v{live.serverInfo?.version ?? "?"} · mode: {mode}
              {lastEvalAge >= 0 ? ` · last eval: ${lastEvalAge}s ago` : ""}
            </Text>
          </View>
          <TouchableOpacity onPress={live.logout} style={styles.btnGhost}>
            <Text style={styles.btnGhostText}>LOGOUT</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* BINANCE ACCOUNT KPIs */}
      <View style={styles.card}>
        <Text style={styles.h2}>🏦 BINANCE ACCOUNT</Text>
        <View style={styles.kpiRow}>
          <Kpi label="WALLET" value={`$${parseFloat(String(wallet)).toFixed(2)}`} color={P.bitcoinOrange} />
          <Kpi label="AVAILABLE" value={`$${parseFloat(String(avail)).toFixed(2)}`} color={P.text} />
          <Kpi label="DAILY PNL" value={`${dailyPnl >= 0 ? "+" : ""}$${parseFloat(String(dailyPnl)).toFixed(2)}`} color={dailyPnl >= 0 ? P.green : P.error} />
          <Kpi label="MARK PRICE" value={markPrice ? `$${markPrice.toFixed(0)}` : "—"} color={P.text} />
        </View>
      </View>

      {/* TomiHedge PANEL — toggle Real/Paper */}
      <TomiHedgePanel state={s} markPrice={markPrice} view={tomiView} onViewChange={setTomiView} />

      {/* ACTIONS */}
      <View style={styles.card}>
        <Text style={styles.h2}>⚙️ ACTIONS</Text>
        <View style={styles.actionRow}>
          <TouchableOpacity style={[styles.btnGhost, { borderColor: P.bitcoinOrange }]} onPress={handleReset}>
            <Text style={[styles.btnGhostText, { color: P.bitcoinOrange }]}>🔄 RESET PAPER</Text>
          </TouchableOpacity>
        </View>
        <Text style={styles.dim}>
          💡 RESET sẽ đóng paper state hiện tại (LONG + SHORT) và start fresh với capital mới.
          Real engine vẫn chạy độc lập (chưa migrate sang TomiHedge).
        </Text>
      </View>

      {live.lastError && (
        <View style={[styles.card, { borderColor: P.error, borderWidth: 1 }]}>
          <Text style={styles.error}>⚠️ {live.lastError}</Text>
        </View>
      )}
    </ScrollView>
  );
}

function Kpi({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <View style={styles.kpi}>
      <Text style={styles.kpiLabel}>{label}</Text>
      <Text style={[styles.kpiValue, { color }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: P.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 20, backgroundColor: P.bg },
  card: { backgroundColor: P.elevated, borderRadius: 4, padding: 12, margin: 8 },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  h1: { color: P.text, fontSize: 14, fontWeight: "800", letterSpacing: 1, fontFamily: "SpaceGrotesk_700Bold" },
  h2: { color: P.text2, fontSize: 11, fontWeight: "800", letterSpacing: 1, fontFamily: "SpaceGrotesk_700Bold", marginBottom: 8 },
  dim: { color: P.dim, fontSize: 11, fontFamily: "JetBrainsMono_500Medium" },
  error: { color: P.error, fontSize: 12, fontFamily: "JetBrainsMono_500Medium" },
  input: { borderWidth: 1, borderColor: P.borderSoft, color: P.text, padding: 10, marginVertical: 10, width: 240, fontFamily: "monospace", fontSize: 14 },
  btnPrimary: { backgroundColor: P.bitcoinOrange, paddingHorizontal: 24, paddingVertical: 10, borderRadius: 4 },
  btnPrimaryText: { color: P.bg, fontWeight: "800", letterSpacing: 1 },
  btnGhost: { borderWidth: 1, borderColor: P.borderSoft, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 4 },
  btnGhostText: { color: P.dim, fontWeight: "700", letterSpacing: 1, fontSize: 12 },
  kpiRow: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  kpi: { minWidth: 110 },
  kpiLabel: { color: P.dim, fontSize: 9, fontFamily: "monospace" },
  kpiValue: { fontSize: 16, fontWeight: "700", fontFamily: "monospace" },
  actionRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 6 },
});
