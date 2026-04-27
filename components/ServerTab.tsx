/**
 * ServerTab — connect to btc-trader-server (cloud 24/7).
 *
 * If not authed → login form.
 * If authed → state + scheduler + alerts + control buttons.
 */
import React, { useState, useMemo, useEffect } from "react";
import { View, Text, ScrollView, TextInput, TouchableOpacity, StyleSheet } from "react-native";
import { P } from "../utils/v2Theme";
import DebugLabel from "./DebugLabel";
import { useBackendLive } from "../hooks/useBackendLive";
import { SERVER_URL } from "../utils/backendApi";

const PASSWORD_PROMPT = "Mã 30318384 cho destructive action:";

export default function ServerTab() {
  const live = useBackendLive();
  const [pwInput, setPwInput] = useState("");

  // ALL hooks MUST be at top — Rules of Hooks (anh Tommy v4.8.7 fix crash)
  const s = live.state;
  const trackedAll = s?.trackedPositions ?? [];
  const symPosAll = s?.binanceSnapshot?.positions?.find((p: any) => p.symbol === (s?.settings?.symbol ?? "BTCUSDT"));
  const markPriceAll = symPosAll ? parseFloat(symPosAll.markPrice) : null;
  const memoLists = useMemo(() => {
    const long: any[] = [];
    const short: any[] = [];
    let lUpnl = 0, sUpnl = 0, lSize = 0, sSize = 0;
    for (const t of trackedAll) {
      if (t.side === "LONG") long.push(t);
      else if (t.side === "SHORT") short.push(t);
    }
    long.sort((a, b) => b.entryMs - a.entryMs);
    short.sort((a, b) => b.entryMs - a.entryMs);
    for (const t of long) lSize += t.qty * t.entryPrice;
    for (const t of short) sSize += t.qty * t.entryPrice;
    if (markPriceAll !== null) {
      for (const t of long) lUpnl += (markPriceAll - t.entryPrice) * t.qty;
      for (const t of short) sUpnl += (t.entryPrice - markPriceAll) * t.qty;
    }
    return { longList: long, shortList: short, longCount: long.length, shortCount: short.length, longUpnl: lUpnl, shortUpnl: sUpnl, longSize: lSize, shortSize: sSize };
  }, [trackedAll, markPriceAll]);

  if (live.loading) {
    return (
      <View style={styles.center}>
        <Text style={styles.dim}>⏳ Connecting to {SERVER_URL}...</Text>
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
          placeholder="password (30318384)"
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

  // Authed view — reuse hooks computed above
  const sched = live.scheduler;
  const tracked = trackedAll;
  const markPrice = markPriceAll;
  const { longList, shortList, longCount, shortCount, longUpnl, shortUpnl, longSize, shortSize } = memoLists;
  const wallet = s?.binanceSnapshot?.account?.totalWalletBalance ?? "—";
  const upnl = s?.binanceSnapshot?.account?.totalUnrealizedProfit ?? "—";
  const dailyPnl = s?.binanceSnapshot?.dailyPnl ?? 0;
  const lastPollMs = sched?.lastPollOkMs ?? 0;
  const lastEvalMs = sched?.lastRuleEvalMs ?? 0;

  const askPw = (): string | null => {
    if (typeof window === "undefined") return null;
    const v = window.prompt(PASSWORD_PROMPT);
    return v && v.trim();
  };

  return (
    <ScrollView style={styles.scroll}>
      <DebugLabel name="ServerTab" />
      <View style={styles.card}>
        <View style={styles.headerRow}>
          <Text style={styles.h1}>☁️ BTC TRADER SERVER · 24/7</Text>
          <TouchableOpacity onPress={live.logout} style={styles.btnGhost}>
            <Text style={styles.btnGhostText}>LOGOUT</Text>
          </TouchableOpacity>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Text style={styles.dim}>{SERVER_URL} · last update </Text>
          <LiveAgo timestampMs={live.lastUpdateMs} suffix=" ago" />
        </View>
      </View>

      {/* ENGINE START/STOP — clearer for new entries vs Plan B */}
      <View style={styles.card}>
        <Text style={styles.h2}>⚙️ ENGINE — NEW ENTRIES</Text>
        <View style={styles.row}>
          <TouchableOpacity
            style={[styles.chip, {
              borderColor: s?.autoEnabled ? P.green : P.error,
              backgroundColor: (s?.autoEnabled ? P.green : P.error) + "22",
              paddingHorizontal: 18, paddingVertical: 10,
            }]}
            onPress={() => {
              if (!s?.autoEnabled) {
                if (typeof window !== "undefined" && !window.confirm("▶️ START? Server sẽ tự vào lệnh mới khi rule fire. Plan B vẫn monitor positions hiện có.")) return;
                live.setAuto(true);
              } else {
                if (typeof window !== "undefined" && !window.confirm("⏸ STOP new entries? Plan B vẫn close positions hiện có khi hit TP/SL.")) return;
                live.setAuto(false);
              }
            }}
          >
            <Text style={{ color: s?.autoEnabled ? P.green : P.error, fontFamily: "monospace", fontWeight: "900", fontSize: 13, letterSpacing: 1 }}>
              {s?.autoEnabled ? "▶️ RUNNING (STOP)" : "⏸ STOPPED (START)"}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.chip, { borderColor: s?.dryRun ? P.bitcoinOrange : P.error, backgroundColor: (s?.dryRun ? P.bitcoinOrange : P.error) + "22" }]}
            onPress={() => {
              if (s?.dryRun) {
                const pw = askPw();
                if (pw) live.setDryRun(false, pw);
              } else {
                live.setDryRun(true);
              }
            }}
          >
            <Text style={{ color: s?.dryRun ? P.bitcoinOrange : P.error, fontFamily: "monospace", fontWeight: "800" }}>
              {s?.dryRun ? "DRY RUN" : "REAL ‼️"}
            </Text>
          </TouchableOpacity>
        </View>
        <Text style={[styles.dim, { marginTop: 6 }]}>
          💡 STOP/START chỉ block lệnh MỚI. Plan B vẫn monitor TP/SL của lệnh hiện có 24/7.
          {"\n"}💡 DRY = log only · REAL = MARKET thật trên Binance (cần password switch).
        </Text>
      </View>

      {/* KPIs */}
      <View style={styles.card}>
        <Text style={styles.h2}>📊 STATUS</Text>
        <View style={styles.kpiGrid}>
          <Kpi label="WALLET" value={`$${parseFloat(wallet).toFixed(2)}`} />
          <Kpi label="uPnL" value={`$${parseFloat(upnl).toFixed(2)}`} color={parseFloat(upnl) >= 0 ? P.green : P.error} />
          <Kpi label="DAILY" value={`$${dailyPnl.toFixed(2)}`} color={dailyPnl >= 0 ? P.green : P.error} />
        </View>
        <View style={styles.kpiGrid}>
          <Kpi label="LONG" value={`${longCount}/${s?.settings?.stackMaxPerSide ?? "?"}`} color={P.green} />
          <Kpi label="SHORT" value={`${shortCount}/${s?.settings?.stackMaxPerSide ?? "?"}`} color={P.error} />
          <Kpi label="HEDGE" value={s?.hedgeMode ? "✅" : "❌"} />
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
          <Text style={styles.dim}>poll </Text><LiveAgo timestampMs={lastPollMs} suffix=" ago" />
          <Text style={styles.dim}> · ruleEval </Text><LiveAgo timestampMs={lastEvalMs} suffix=" ago" />
          <Text style={styles.dim}> · alerts {sched?.lastRuleAlerts ?? 0}</Text>
        </View>
        {s?.pauseReason && (
          <Text style={[styles.error, { marginTop: 6 }]}>
            🛑 PAUSED ({s.pauseReason}) — until {new Date(s.pausedUntilMs).toLocaleTimeString()}
          </Text>
        )}
      </View>

      {/* Active firing rules */}
      <View style={styles.card}>
        <Text style={styles.h2}>🔔 ACTIVE FIRING ({live.alerts.length})</Text>
        {live.alerts.length === 0 ? (
          <Text style={styles.dim}>không có rule nào fire</Text>
        ) : (
          live.alerts.slice(0, 10).map((a: any, i: number) => (
            <Text key={i} style={[styles.dim, { marginBottom: 2 }]}>
              <Text style={{ color: a.side === "LONG" ? P.green : P.error, fontWeight: "700" }}>{a.tfKey}#{a.id.split(":").pop()} {a.side}</Text>
              {"  "}@ ${a.entryPrice.toFixed(0)} TP ${a.tpPrice.toFixed(0)} SL ${a.slPrice.toFixed(0)}
            </Text>
          ))
        )}
      </View>

      {/* Tracked positions */}
      <View style={styles.card}>
        <Text style={styles.h2}>📈 TRACKED ({tracked.length})</Text>
        {tracked.length === 0 ? (
          <Text style={styles.dim}>chưa có position nào</Text>
        ) : (
          <>
            <View style={styles.row}>
              <TouchableOpacity style={[styles.chip, { borderColor: P.green }]}
                onPress={() => { const pw = askPw(); if (pw) live.bulkClose("PROFIT", pw); }}>
                <Text style={{ color: P.green, fontFamily: "monospace", fontWeight: "700", fontSize: 10 }}>✓ CLOSE PROFIT</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.chip, { borderColor: P.error }]}
                onPress={() => { const pw = askPw(); if (pw) live.bulkClose("LOSS", pw); }}>
                <Text style={{ color: P.error, fontFamily: "monospace", fontWeight: "700", fontSize: 10 }}>✗ CLOSE LOSS</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.chip, { borderColor: P.error, backgroundColor: P.error + "22" }]}
                onPress={() => { const pw = askPw(); if (pw) live.bulkClose("ALL", pw); }}>
                <Text style={{ color: P.error, fontFamily: "monospace", fontWeight: "800", fontSize: 10 }}>🔥 CLOSE ALL</Text>
              </TouchableOpacity>
            </View>
            {(["LONG", "SHORT"] as const).map((side) => {
              const list = side === "LONG" ? longList : shortList;
              if (list.length === 0) return null;
              const sideColor = side === "LONG" ? P.green : P.error;
              const sideUpnlUsd = side === "LONG" ? longUpnl : shortUpnl;
              const sideSizeUsd = side === "LONG" ? longSize : shortSize;
              return (
                <View key={side} style={{ marginTop: 8 }}>
                  <Text style={[styles.h2, { color: sideColor, marginTop: 4 }]}>
                    {side === "LONG" ? "🟢" : "🔴"} {side} ({list.length}) ·
                    <Text style={{ color: P.bitcoinOrange }}> size ${sideSizeUsd.toFixed(0)}</Text> ·
                    <Text style={{ color: sideUpnlUsd >= 0 ? P.green : P.error }}> uPnL {sideUpnlUsd >= 0 ? "+" : ""}${sideUpnlUsd.toFixed(2)}</Text>
                  </Text>
                  {list.map((t: any, i: number) => {
                    const heldH = ((Date.now() - t.entryMs) / 3600000).toFixed(1);
                    const diff = markPrice !== null ? (side === "LONG" ? (markPrice - t.entryPrice) : (t.entryPrice - markPrice)) : 0;
                    const upnlUsd = diff * t.qty;
                    const upnlPct = markPrice !== null ? (diff / t.entryPrice) * 100 : 0;
                    const upnlColor = upnlUsd >= 0 ? P.green : P.error;
                    const sizeUsd = t.qty * t.entryPrice;
                    return (
                      <View key={t.id} style={styles.posRow}>
                        <Text style={[styles.dim, { width: 24 }]}>{i + 1}</Text>
                        <Text style={[styles.dim, { width: 70 }]}>${t.entryPrice.toFixed(0)}</Text>
                        <Text style={[styles.dim, { color: P.bitcoinOrange, width: 70, fontWeight: "700" }]}>${sizeUsd.toFixed(0)}</Text>
                        <Text style={[styles.dim, { color: P.green, width: 70 }]}>TP ${t.tpPrice.toFixed(0)}</Text>
                        <Text style={[styles.dim, { color: P.error, width: 70 }]}>SL ${t.slPrice.toFixed(0)}</Text>
                        <Text style={[styles.dim, { color: upnlColor, width: 75, fontWeight: "700" }]}>
                          {upnlUsd >= 0 ? "+" : ""}${upnlUsd.toFixed(2)}
                        </Text>
                        <Text style={[styles.dim, { color: upnlColor, width: 60, fontWeight: "700" }]}>
                          {upnlPct >= 0 ? "+" : ""}{upnlPct.toFixed(2)}%
                        </Text>
                        <Text style={[styles.dim, { width: 40 }]}>{heldH}h</Text>
                        <TouchableOpacity onPress={() => { const pw = askPw(); if (pw) live.closePosition(t.id, pw); }}>
                          <Text style={{ color: P.error, fontWeight: "800", fontSize: 11 }}>✕</Text>
                        </TouchableOpacity>
                      </View>
                    );
                  })}
                </View>
              );
            })}
          </>
        )}
      </View>

      {live.lastError && (
        <View style={[styles.card, { borderColor: P.error, borderWidth: 1 }]}>
          <Text style={styles.error}>⚠️ {live.lastError}</Text>
        </View>
      )}
    </ScrollView>
  );
}

/**
 * LiveAgo — tự tick mỗi 1s, chỉ re-render component nhỏ này (anh Tommy v4.8.9 perf).
 * Parent ServerTab + 64 tracked rows KHÔNG re-render → tiết kiệm CPU/battery.
 */
function LiveAgo({ timestampMs, prefix = "", suffix = "" }: { timestampMs: number; prefix?: string; suffix?: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  if (!timestampMs) return <Text style={styles.dim}>—</Text>;
  const sec = Math.max(0, Math.round((now - timestampMs) / 1000));
  const txt = sec < 60 ? `${sec}s` : sec < 3600 ? `${Math.round(sec / 60)}m` : `${(sec / 3600).toFixed(1)}h`;
  return <Text style={styles.dim}>{prefix}{txt}{suffix}</Text>;
}

function Kpi({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={styles.kpi}>
      <Text style={styles.kpiLabel}>{label}</Text>
      <Text style={[styles.kpiValue, color ? { color } : null]}>{value}</Text>
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
  btnGhost: { borderWidth: 1, borderColor: P.borderSoft, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 3 },
  btnGhostText: { color: P.dim, fontSize: 10, fontFamily: "monospace", fontWeight: "700" },
  row: { flexDirection: "row", gap: 6, flexWrap: "wrap", marginBottom: 8 },
  chip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 3, borderWidth: 1 },
  kpiGrid: { flexDirection: "row", gap: 6, marginBottom: 6 },
  kpi: { flex: 1, padding: 8, backgroundColor: P.surface, borderRadius: 3, borderWidth: 1, borderColor: P.borderSoft },
  kpiLabel: { color: P.dim, fontSize: 9, letterSpacing: 1, fontWeight: "700" },
  kpiValue: { color: P.text, fontSize: 14, fontWeight: "800", fontFamily: "JetBrainsMono_700Bold", marginTop: 2 },
  posRow: { flexDirection: "row", alignItems: "center", paddingVertical: 4, gap: 4, borderBottomWidth: 1, borderBottomColor: P.surface },
});
