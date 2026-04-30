/**
 * ServerTab — connect to btc-trader-server (cloud 24/7).
 *
 * If not authed → login form.
 * If authed → state + scheduler + alerts + control buttons.
 */
import React, { useState, useMemo, useEffect } from "react";
import { View, Text, ScrollView, TextInput, TouchableOpacity, StyleSheet } from "react-native";
import Svg, { Polyline, Polygon, Circle, Line as SvgLine } from "react-native-svg";
import { P } from "../utils/v2Theme";
import DebugLabel from "./DebugLabel";
import { useBackendLive } from "../hooks/useBackendLive";
import { SERVER_URL } from "../utils/backendApi";
import PresetEnginePanel from "./PresetEnginePanel";

const PASSWORD_PROMPT = "Mã 30318384 cho destructive action:";

interface ServerTabProps {
  klinesByTf?: Record<string, { time: number; close: number }[]>;
}

export default function ServerTab({ klinesByTf }: ServerTabProps = {}) {
  const live = useBackendLive();
  const [pwInput, setPwInput] = useState("");
  const [chartTf, setChartTf] = useState<"5m" | "15m" | "1h" | "4h">("15m");
  const [containerW, setContainerW] = useState<number>(0);

  // ALL hooks MUST be at top — Rules of Hooks (anh Tommy v4.8.7 fix crash)
  const s = live.state;
  const trackedAll = s?.trackedPositions ?? [];
  const allPos = s?.binanceSnapshot?.positions ?? [];
  const symbol = s?.settings?.symbol ?? "BTCUSDT";
  const symPosAll = allPos.find((p: any) => p.symbol === symbol);
  const markPriceAll = symPosAll ? parseFloat(symPosAll.markPrice) : null;
  // Binance hedge mode: 2 records per symbol (LONG + SHORT)
  const binanceLongPos = allPos.find((p: any) => p.symbol === symbol && p.positionSide === "LONG");
  const binanceShortPos = allPos.find((p: any) => p.symbol === symbol && p.positionSide === "SHORT");
  const memoLists = useMemo(() => {
    const long: any[] = [];
    const short: any[] = [];
    let lUpnl = 0, sUpnl = 0, lSize = 0, sSize = 0;
    let lQty = 0, sQty = 0, lQtyEntry = 0, sQtyEntry = 0;
    for (const t of trackedAll) {
      if (t.side === "LONG") long.push(t);
      else if (t.side === "SHORT") short.push(t);
    }
    long.sort((a, b) => b.entryMs - a.entryMs);
    short.sort((a, b) => b.entryMs - a.entryMs);
    for (const t of long) {
      lSize += t.qty * t.entryPrice;
      lQty += t.qty;
      lQtyEntry += t.qty * t.entryPrice;
    }
    for (const t of short) {
      sSize += t.qty * t.entryPrice;
      sQty += t.qty;
      sQtyEntry += t.qty * t.entryPrice;
    }
    if (markPriceAll !== null) {
      for (const t of long) lUpnl += (markPriceAll - t.entryPrice) * t.qty;
      for (const t of short) sUpnl += (t.entryPrice - markPriceAll) * t.qty;
    }
    const lAvgEntry = lQty > 0 ? lQtyEntry / lQty : 0;
    const sAvgEntry = sQty > 0 ? sQtyEntry / sQty : 0;
    return {
      longList: long, shortList: short,
      longCount: long.length, shortCount: short.length,
      longUpnl: lUpnl, shortUpnl: sUpnl,
      longSize: lSize, shortSize: sSize,
      longQty: lQty, shortQty: sQty,
      longAvgEntry: lAvgEntry, shortAvgEntry: sAvgEntry,
    };
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

  // Authed view — reuse hooks computed above
  const sched = live.scheduler;
  const tracked = trackedAll;
  const markPrice = markPriceAll;
  const { longList, shortList, longCount, shortCount, longUpnl, shortUpnl, longSize, shortSize, longQty, shortQty, longAvgEntry, shortAvgEntry } = memoLists;
  const wallet = s?.binanceSnapshot?.account?.totalWalletBalance ?? "—";
  const upnl = s?.binanceSnapshot?.account?.totalUnrealizedProfit ?? "—";
  const avail = s?.binanceSnapshot?.account?.availableBalance ?? "—";
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
        {/* Server version + health info */}
        {live.serverInfo && (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12, marginTop: 6 }}>
            <Text style={[styles.dim, { color: P.bitcoinOrange, fontWeight: "700" }]}>
              v{live.serverInfo.version}
            </Text>
            {live.serverHealth && (
              <>
                <Text style={styles.dim}>
                  uptime {live.serverHealth.uptime >= 3600
                    ? `${(live.serverHealth.uptime / 3600).toFixed(1)}h`
                    : `${(live.serverHealth.uptime / 60).toFixed(0)}m`}
                </Text>
                <Text style={styles.dim}>mem {live.serverHealth.memMb}MB</Text>
                <Text style={styles.dim}>pid {live.serverHealth.pid}</Text>
              </>
            )}
          </View>
        )}
      </View>

      {/* v0.3.0 PRESET ENGINE PANEL (anh Tommy: Real + Paper song song) */}
      <PresetEnginePanel state={s} onRefresh={live.refresh} />

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
          <Kpi label="AVAIL" value={`$${parseFloat(avail).toFixed(2)}`} color={P.bitcoinOrange} />
          <Kpi label="uPnL" value={`$${parseFloat(upnl).toFixed(2)}`} color={parseFloat(upnl) >= 0 ? P.green : P.error} />
        </View>
        <View style={styles.kpiGrid}>
          <Kpi label="DAILY" value={`$${dailyPnl.toFixed(2)}`} color={dailyPnl >= 0 ? P.green : P.error} />
          <Kpi label="LONG" value={`${longCount}/${s?.settings?.stackMaxPerSide ?? "?"}`} color={P.green} />
          <Kpi label="SHORT" value={`${shortCount}/${s?.settings?.stackMaxPerSide ?? "?"}`} color={P.error} />
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

      {/* BINANCE POSITIONS — net hedge state lấy từ /fapi/v2/positionRisk thật (anh Tommy v4.8.13) */}
      <View style={styles.card}>
        <Text style={styles.h2}>🏦 BINANCE POSITIONS (live · {symbol})</Text>
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          {(["LONG", "SHORT"] as const).map((side) => {
            const p = side === "LONG" ? binanceLongPos : binanceShortPos;
            const sideColor = side === "LONG" ? P.green : P.error;
            const amt = p ? parseFloat(p.positionAmt) : 0;
            const hasPos = Math.abs(amt) > 0;
            const entry = p ? parseFloat(p.entryPrice) : 0;
            const mark = p ? parseFloat(p.markPrice) : 0;
            const upnl = p ? parseFloat(p.unRealizedProfit) : 0;
            const liq = p ? parseFloat(p.liquidationPrice) : 0;
            const lev = p ? parseInt(p.leverage) : 0;
            const notional = Math.abs(amt) * mark;
            const upnlPct = entry > 0 ? ((side === "LONG" ? mark - entry : entry - mark) / entry) * 100 : 0;
            return (
              <View key={side} style={{ flex: 1, minWidth: 280, padding: 8, backgroundColor: P.surface, borderRadius: 4, borderWidth: 1, borderColor: hasPos ? sideColor : P.borderSoft }}>
                <Text style={{ color: sideColor, fontFamily: "monospace", fontWeight: "800", fontSize: 12, marginBottom: 4 }}>
                  {side === "LONG" ? "🟢" : "🔴"} {side} {hasPos ? `· $${notional.toFixed(0)} USDT` : "· trống"}
                </Text>
                {hasPos ? (
                  <>
                    <Text style={{ color: P.text, fontFamily: "monospace", fontSize: 11 }}>
                      qty <Text style={{ color: P.dim }}>{Math.abs(amt).toFixed(4)} BTC</Text>
                      {"  "}· avg entry <Text style={{ color: P.bitcoinOrange, fontWeight: "700" }}>${entry.toFixed(2)}</Text>
                    </Text>
                    <Text style={{ color: P.dim, fontFamily: "monospace", fontSize: 11 }}>
                      mark <Text style={{ color: P.text }}>${mark.toFixed(2)}</Text>
                      {"  "}· lev <Text style={{ color: P.text }}>{lev}x</Text>
                      {"  "}· liq <Text style={{ color: P.error }}>${liq.toFixed(0)}</Text>
                    </Text>
                    <Text style={{ fontFamily: "monospace", fontSize: 12, fontWeight: "800", color: upnl >= 0 ? P.green : P.error, marginTop: 2 }}>
                      uPnL {upnl >= 0 ? "+" : ""}${upnl.toFixed(2)} ({upnlPct >= 0 ? "+" : ""}{upnlPct.toFixed(2)}%)
                    </Text>
                  </>
                ) : (
                  <Text style={[styles.dim, { fontStyle: "italic" }]}>không có position</Text>
                )}
              </View>
            );
          })}
        </View>
        <Text style={[styles.dim, { marginTop: 6, fontStyle: "italic" }]}>
          💡 Lấy từ /fapi/v2/positionRisk · refresh poll {sched?.pollMs ? `${Math.round(sched.pollMs / 1000)}s` : "30s"}.
          App tracked card bên dưới = N entries logical với TP/SL riêng (Plan B).
        </Text>
      </View>

      {/* SYNC CHECK moved inside TRACKED card (anh Tommy v4.8.17) */}
      {false && (
      <View style={styles.card}>
        <Text style={styles.h2}>🔄 SYNC CHECK · App tracked vs Binance</Text>
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          {(["LONG", "SHORT"] as const).map((side) => {
            const sideColor = side === "LONG" ? P.green : P.error;
            const appQty = side === "LONG" ? longQty : shortQty;
            const appAvg = side === "LONG" ? longAvgEntry : shortAvgEntry;
            const appSize = side === "LONG" ? longSize : shortSize;
            const appUpnl = side === "LONG" ? longUpnl : shortUpnl;
            const appCount = side === "LONG" ? longCount : shortCount;
            const binPos = side === "LONG" ? binanceLongPos : binanceShortPos;
            const binQty = binPos ? Math.abs(parseFloat(binPos.positionAmt)) : 0;
            const binEntry = binPos ? parseFloat(binPos.entryPrice) : 0;
            const binMark = binPos ? parseFloat(binPos.markPrice) : 0;
            const binSize = binQty * binMark;
            const binUpnl = binPos ? parseFloat(binPos.unRealizedProfit) : 0;
            // Diff
            const qtyDiff = appQty - binQty;
            const entryDiff = appAvg - binEntry;
            const TOL_QTY = 0.0005; // 0.0005 BTC
            const TOL_ENTRY = 50;   // $50
            const qtyOk = Math.abs(qtyDiff) <= TOL_QTY;
            const entryOk = appAvg === 0 || binEntry === 0 || Math.abs(entryDiff) <= TOL_ENTRY;
            const allOk = qtyOk && entryOk;
            return (
              <View key={side} style={{
                flex: 1, minWidth: 280, padding: 8, borderRadius: 4, borderWidth: 1,
                borderColor: allOk ? sideColor + "55" : P.error,
                backgroundColor: allOk ? P.surface : P.error + "12",
              }}>
                <Text style={{ color: allOk ? sideColor : P.error, fontFamily: "monospace", fontWeight: "800", fontSize: 12, marginBottom: 4 }}>
                  {allOk ? "✅" : "⚠️"} {side} {allOk ? "SYNC" : "MISMATCH"}
                </Text>
                <Text style={{ color: P.dim, fontFamily: "monospace", fontSize: 10 }}>
                  qty: app <Text style={{ color: P.text }}>{appQty.toFixed(4)}</Text> vs bin <Text style={{ color: P.text }}>{binQty.toFixed(4)}</Text>
                  {!qtyOk && <Text style={{ color: P.error }}> · diff {qtyDiff >= 0 ? "+" : ""}{qtyDiff.toFixed(4)}</Text>}
                </Text>
                <Text style={{ color: P.dim, fontFamily: "monospace", fontSize: 10 }}>
                  avg entry: app <Text style={{ color: P.text }}>${appAvg.toFixed(0)}</Text> vs bin <Text style={{ color: P.text }}>${binEntry.toFixed(0)}</Text>
                  {!entryOk && <Text style={{ color: P.error }}> · diff ${entryDiff >= 0 ? "+" : ""}{entryDiff.toFixed(0)}</Text>}
                </Text>
                <Text style={{ color: P.dim, fontFamily: "monospace", fontSize: 10 }}>
                  size: app <Text style={{ color: P.bitcoinOrange }}>${appSize.toFixed(0)}</Text> vs bin <Text style={{ color: P.bitcoinOrange }}>${binSize.toFixed(0)}</Text>
                </Text>
                <Text style={{ color: P.dim, fontFamily: "monospace", fontSize: 10 }}>
                  uPnL: app <Text style={{ color: appUpnl >= 0 ? P.green : P.error }}>${appUpnl.toFixed(2)}</Text> vs bin <Text style={{ color: binUpnl >= 0 ? P.green : P.error }}>${binUpnl.toFixed(2)}</Text>
                </Text>
                <Text style={{ color: P.dim, fontFamily: "monospace", fontSize: 9, fontStyle: "italic", marginTop: 2 }}>
                  app {appCount} entries · bin 1 net
                </Text>
              </View>
            );
          })}
        </View>
        <Text style={[styles.dim, { marginTop: 6, fontStyle: "italic" }]}>
          💡 Tolerance: qty ±0.0005 BTC · entry ±$50. MISMATCH → reconcile sẽ tự fix tại cycle poll kế (max 30s).
        </Text>
      </View>
      )}

      {/* Chart entry/exit markers */}
      <View style={styles.card} onLayout={(e) => setContainerW(e.nativeEvent.layout.width - 24)}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Text style={styles.h2}>📊 PRICE {chartTf} + ENTRIES</Text>
          <View style={{ flexDirection: "row", gap: 4 }}>
            {(["5m", "15m", "1h", "4h"] as const).map((tf) => (
              <TouchableOpacity key={tf} onPress={() => setChartTf(tf)}
                style={{
                  paddingHorizontal: 8, paddingVertical: 3, borderRadius: 3, borderWidth: 1,
                  borderColor: chartTf === tf ? P.bitcoinOrange : P.borderSoft,
                  backgroundColor: chartTf === tf ? P.bitcoinOrange + "22" : P.surface,
                }}>
                <Text style={{ color: chartTf === tf ? P.bitcoinOrange : P.dim, fontSize: 10, fontFamily: "monospace", fontWeight: "700" }}>{tf}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
        {containerW > 0 && (
          <ServerPriceChart
            bars={klinesByTf?.[chartTf] ?? []}
            tracked={tracked}
            journal={live.journal}
            width={containerW}
            tf={chartTf}
          />
        )}
      </View>

      {/* Tracked positions */}
      <View style={styles.card}>
        <Text style={styles.h2}>📈 TRACKED ({tracked.length})</Text>

        {/* SYNC CHECK inline (anh Tommy v4.8.17) — compare app vs Binance */}
        <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
          {(["LONG", "SHORT"] as const).map((side) => {
            const sideColor = side === "LONG" ? P.green : P.error;
            const appQty = side === "LONG" ? longQty : shortQty;
            const appAvg = side === "LONG" ? longAvgEntry : shortAvgEntry;
            const appCount = side === "LONG" ? longCount : shortCount;
            const binPos = side === "LONG" ? binanceLongPos : binanceShortPos;
            const binQty = binPos ? Math.abs(parseFloat(binPos.positionAmt)) : 0;
            const binEntry = binPos ? parseFloat(binPos.entryPrice) : 0;
            const qtyDiff = appQty - binQty;
            const entryDiff = appAvg - binEntry;
            const TOL_QTY = 0.0005, TOL_ENTRY = 50;
            const qtyOk = Math.abs(qtyDiff) <= TOL_QTY;
            const entryOk = appAvg === 0 || binEntry === 0 || Math.abs(entryDiff) <= TOL_ENTRY;
            const ok = qtyOk && entryOk;
            return (
              <View key={side} style={{
                flex: 1, minWidth: 200, padding: 6, borderRadius: 3, borderWidth: 1,
                borderColor: ok ? sideColor + "55" : P.error,
                backgroundColor: ok ? P.surface : P.error + "12",
              }}>
                <Text style={{ color: ok ? sideColor : P.error, fontFamily: "monospace", fontWeight: "800", fontSize: 11 }}>
                  {ok ? "✅" : "⚠️"} {side} {ok ? "SYNC" : "MISMATCH"} · {appCount} app vs 1 bin
                </Text>
                <Text style={{ color: P.dim, fontFamily: "monospace", fontSize: 9 }}>
                  qty: <Text style={{ color: P.text }}>{appQty.toFixed(4)}</Text> vs <Text style={{ color: P.text }}>{binQty.toFixed(4)}</Text>
                  {!qtyOk && <Text style={{ color: P.error }}> ({qtyDiff >= 0 ? "+" : ""}{qtyDiff.toFixed(4)})</Text>}
                </Text>
                <Text style={{ color: P.dim, fontFamily: "monospace", fontSize: 9 }}>
                  entry: <Text style={{ color: P.text }}>${appAvg.toFixed(0)}</Text> vs <Text style={{ color: P.text }}>${binEntry.toFixed(0)}</Text>
                  {!entryOk && <Text style={{ color: P.error }}> (${entryDiff >= 0 ? "+" : ""}{entryDiff.toFixed(0)})</Text>}
                </Text>
              </View>
            );
          })}
        </View>

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
                    const heldMin = (Date.now() - t.entryMs) / 60000;
                    const heldStr = heldMin < 60 ? `${heldMin.toFixed(0)}m` : `${(heldMin / 60).toFixed(1)}h`;
                    const dt = new Date(t.entryMs);
                    const dtStr = `${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")} ${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
                    const diff = markPrice !== null ? (side === "LONG" ? (markPrice - t.entryPrice) : (t.entryPrice - markPrice)) : 0;
                    const upnlUsd = diff * t.qty;
                    // anh Tommy v0.2.2: pnl% phải × leverage (giống 5m ALL)
                    const binPos = side === "LONG" ? binanceLongPos : binanceShortPos;
                    const lev = binPos ? parseInt(binPos.leverage) : 100;
                    const upnlPct = markPrice !== null ? (diff / t.entryPrice) * 100 * lev : 0;
                    const upnlColor = upnlUsd >= 0 ? P.green : P.error;
                    const sizeUsd = t.qty * t.entryPrice;
                    const isTrailing = t.tfKey === "15m" && (t.lastTrailStep ?? 0) > 0;
                    return (
                      <View key={t.id} style={[styles.posRow, { flexWrap: "wrap" }]}>
                        <Text style={[styles.dim, { width: 22 }]}>{i + 1}</Text>
                        <Text style={[styles.dim, { width: 90, color: P.tertiary, fontSize: 10 }]}>{dtStr}</Text>
                        <Text style={[styles.dim, { width: 65 }]}>${t.entryPrice.toFixed(0)}</Text>
                        <Text style={[styles.dim, { color: P.bitcoinOrange, width: 60, fontWeight: "700" }]}>${sizeUsd.toFixed(0)}</Text>
                        <Text style={[styles.dim, { color: P.green, width: 65 }]}>TP ${t.tpPrice.toFixed(0)}</Text>
                        <Text style={[styles.dim, { color: isTrailing ? P.bitcoinOrange : P.error, width: 65 }]}>
                          {isTrailing ? `🔄SL $${t.slPrice.toFixed(0)}` : `SL $${t.slPrice.toFixed(0)}`}
                        </Text>
                        <Text style={[styles.dim, { color: upnlColor, width: 70, fontWeight: "700" }]}>
                          {upnlUsd >= 0 ? "+" : ""}${upnlUsd.toFixed(2)}
                        </Text>
                        <Text style={[styles.dim, { color: upnlColor, width: 55, fontWeight: "700" }]}>
                          {upnlPct >= 0 ? "+" : ""}{upnlPct.toFixed(2)}%
                        </Text>
                        <Text style={[styles.dim, { width: 40 }]}>{heldStr}</Text>
                        <TouchableOpacity onPress={() => { const pw = askPw(); if (pw) live.closePosition(t.id, pw); }}>
                          <Text style={{ color: P.error, fontWeight: "800", fontSize: 11 }}>✕</Text>
                        </TouchableOpacity>
                        {isTrailing && (
                          <Text style={{ width: "100%", color: P.bitcoinOrange, fontSize: 10, marginTop: 2, paddingLeft: 22 }}>
                            ↳ TRAIL step {t.lastTrailStep} · SL trailed from ${t.origSlPrice?.toFixed(0) ?? "—"} → ${t.slPrice.toFixed(0)}
                          </Text>
                        )}
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

function ServerPriceChart({ bars, tracked, journal, width, tf }: {
  bars: { time: number; close: number }[];
  tracked: any[]; journal: any[]; width: number; tf: string;
}) {
  const height = 240;
  if (bars.length < 2) {
    return <Text style={{ color: P.dim, fontSize: 11, fontFamily: "monospace", padding: 12 }}>chưa có data {tf}</Text>;
  }
  const maxBars = 120;
  let slice = bars.slice(-maxBars);
  if (tracked.length > 0) {
    const oldestOpen = Math.min(...tracked.map((t) => t.entryMs));
    if (oldestOpen < slice[0].time) {
      const startIdx = Math.max(0, bars.findIndex((b) => b.time >= oldestOpen) - 1);
      if (startIdx >= 0 && startIdx < bars.length) slice = bars.slice(startIdx);
    }
  }
  const tMin = slice[0].time;
  const tMax = Math.max(slice[slice.length - 1].time, ...tracked.map((t) => t.entryMs), Date.now());
  const range = tMax - tMin || 1;
  const closes = slice.map((b) => b.close);
  // SMART RANGE (anh Tommy v4.8.13): chỉ dùng closes + tracked entryPrice (NOT tp/sl —
  // tránh outlier SL/TP xa kéo lệch chart). Markers ngoài range sẽ clamp tới edge.
  const pricePoints: number[] = [...closes];
  for (const t of tracked) pricePoints.push(t.entryPrice);
  let pMin = Math.min(...pricePoints);
  let pMax = Math.max(...pricePoints);
  // Padding 5% trên dưới để có không gian thở
  const pad5 = (pMax - pMin) * 0.05;
  pMin -= pad5;
  pMax += pad5;
  const pRange = pMax - pMin || 1;
  const pad = 8;
  const w = width - pad * 2;
  const h = height - pad * 2;
  const xOf = (t: number) => {
    if (t < tMin) return pad;
    if (t > tMax) return width - pad;
    return pad + ((t - tMin) / range) * w;
  };
  const yOf = (p: number) => {
    // Clamp price ra ngoài range vào edge (anh Tommy v4.8.13)
    const clamped = Math.max(pMin, Math.min(pMax, p));
    return pad + h - ((clamped - pMin) / pRange) * h;
  };
  const pricePts = slice.map((b) => `${xOf(b.time).toFixed(1)},${yOf(b.close).toFixed(1)}`).join(" ");

  // CLOSE markers từ journal (last 30 closes)
  // 2026-04-28 BUG FIX: server v0.2.2+ trả {action:{kind:"CLOSE"}} nested.
  // Defensive: handle cả 2 schema (verbose nested + legacy flat) tránh chart trống marker.
  const isClose = (j: any) =>
    j?.action?.kind === "CLOSE" || j?.actionKind === "CLOSE" || j?.a === "C";
  const closesJ = journal.filter(isClose).slice(0, 30);
  // Y-axis ticks (5 levels) + current price line
  const currentPrice = closes[closes.length - 1];
  const ticks = [pMax, pMax - (pMax - pMin) * 0.25, (pMax + pMin) / 2, pMin + (pMax - pMin) * 0.25, pMin];
  return (
    <View style={{ width, height, backgroundColor: P.surface, borderRadius: 2, borderWidth: 1, borderColor: P.borderSoft, marginTop: 8 }}>
      <Svg width={width} height={height}>
        {/* Y-axis grid lines + current price horizontal line */}
        {ticks.map((p, i) => (
          <SvgLine key={`tick-${i}`} x1={pad} y1={yOf(p)} x2={width - 50} y2={yOf(p)} stroke={P.borderSoft} strokeWidth={0.3} strokeDasharray="2,4" opacity={0.4} />
        ))}
        <SvgLine x1={pad} y1={yOf(currentPrice)} x2={width - 50} y2={yOf(currentPrice)} stroke={P.bitcoinOrange} strokeWidth={0.6} strokeDasharray="3,2" opacity={0.6} />
        <Polyline points={pricePts} fill="none" stroke={P.bitcoinOrange} strokeWidth={1.4} opacity={0.85} />
        {tracked.map((p) => {
          const eX = xOf(p.entryMs);
          const eY = yOf(p.entryPrice);
          const longSide = p.side === "LONG";
          const color = longSide ? P.green : P.error;
          const tri = longSide
            ? `${eX},${eY - 7} ${eX - 6},${eY + 4} ${eX + 6},${eY + 4}`
            : `${eX},${eY + 7} ${eX - 6},${eY - 4} ${eX + 6},${eY - 4}`;
          return (
            <React.Fragment key={`open-${p.id}`}>
              <SvgLine x1={eX} y1={eY} x2={eX} y2={height - pad} stroke={color} strokeWidth={0.4} strokeDasharray="2,3" opacity={0.3} />
              <Polygon points={tri} fill={color} opacity={1} stroke={P.surface} strokeWidth={0.7} />
            </React.Fragment>
          );
        })}
        {closesJ.map((j: any, i: number) => {
          const a = j.action;
          if (!a?.closePrice || !a?.side) return null;
          const cX = xOf(j.ts);
          const cY = yOf(a.closePrice);
          const win = a.trigger === "TP";
          const dotColor = win ? P.green : P.error;
          return <Circle key={`close-${i}`} cx={cX} cy={cY} r={4} fill={dotColor} opacity={1} stroke={P.surface} strokeWidth={0.5} />;
        })}
      </Svg>
      {/* Y-axis tick value labels (right edge) */}
      {ticks.map((p, i) => {
        const y = yOf(p);
        if (y < 12 || y > height - 4) return null;
        return (
          <Text key={`lbl-${i}`} style={{
            position: "absolute", right: 4, top: y - 7,
            color: P.dim, fontSize: 9, fontFamily: "monospace",
          }}>${p.toFixed(0)}</Text>
        );
      })}
      {/* Current price label (highlight cam) */}
      <Text style={{
        position: "absolute", right: 4, top: yOf(currentPrice) - 7,
        color: P.bitcoinOrange, fontSize: 10, fontFamily: "monospace", fontWeight: "800",
      }}>${currentPrice.toFixed(0)}</Text>
      <View style={{ position: "absolute", top: 4, left: 8, flexDirection: "row", gap: 12, flexWrap: "wrap" }}>
        <Text style={{ color: P.green, fontSize: 9, fontFamily: "monospace" }}>▲ LONG ● TP</Text>
        <Text style={{ color: P.error, fontSize: 9, fontFamily: "monospace" }}>▼ SHORT ● SL</Text>
      </View>
      <Text style={{ position: "absolute", bottom: 2, left: 8, color: P.dim, fontSize: 9, fontFamily: "monospace" }}>
        range ${(pMax - pMin).toFixed(0)} · {tracked.length} open · {closesJ.length} closed · {((tMax - tMin) / 3600000).toFixed(1)}h
      </Text>
    </View>
  );
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
