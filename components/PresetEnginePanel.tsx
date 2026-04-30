/**
 * PresetEnginePanel — UI điều khiển Preset Engine (anh Tommy v0.3.0).
 *
 * Hiển thị:
 *   - 2 section: REAL (trade Binance thật) + PAPER (simulate)
 *   - Mỗi section: dropdown chọn preset (10 picks), edit margin/leverage/maxStack/walletMin
 *   - Paper: stats $capital · WR · PF · trades + nút Reset/Clear
 *   - Real: tracked positions count + nút Clear (đóng hết)
 */
import React, { useEffect, useMemo, useState } from "react";
import { View, Text, ScrollView, TouchableOpacity, TextInput, StyleSheet } from "react-native";
import { P } from "../utils/v2Theme";
import { api } from "../utils/backendApi";

type ToggleView = "real" | "paper";

interface Props {
  state: any;
  onRefresh: () => Promise<void>;
}

const PRESET_KEYS = [
  "WHALE_MAX_66", "WHALE_MAX_48", "WHALE_MAX_38", "WHALE_MAX_88",
  "WHALE_MID_66", "TOMI_MAX_55", "TOMI_MIN_66",
  "WHALE_MAX", "WHALE_MID", "TOMI_MAX",
];

const PRESET_LABELS: Record<string, { emoji: string; label: string; tp: number; sl: number; stack: number }> = {
  WHALE_MAX_66: { emoji: "🔴", label: "WHALE 6/6 ⭐", tp: 6, sl: 6, stack: 200 },
  WHALE_MAX_48: { emoji: "🔴", label: "WHALE 4/8", tp: 4, sl: 8, stack: 200 },
  WHALE_MAX_38: { emoji: "🔴", label: "WHALE 3/8 (WR 72%)", tp: 3, sl: 8, stack: 200 },
  WHALE_MAX_88: { emoji: "🔴", label: "WHALE 8/8 (min DD)", tp: 8, sl: 8, stack: 200 },
  WHALE_MID_66: { emoji: "🟠", label: "WHALE 100 6/6", tp: 6, sl: 6, stack: 100 },
  TOMI_MAX_55: { emoji: "🔵", label: "TOMI 200 5/5", tp: 5, sl: 5, stack: 200 },
  TOMI_MIN_66: { emoji: "⚪", label: "TOMI 50 6/6 (starter)", tp: 6, sl: 6, stack: 50 },
  WHALE_MAX: { emoji: "🔴", label: "WHALE 200 LEGACY", tp: 5, sl: 2.5, stack: 200 },
  WHALE_MID: { emoji: "🟠", label: "WHALE 100 LEGACY", tp: 5, sl: 2.5, stack: 100 },
  TOMI_MAX: { emoji: "🔵", label: "TOMI 200 LEGACY", tp: 4, sl: 4, stack: 200 },
};

export default function PresetEnginePanel({ state, onRefresh }: Props) {
  const [view, setView] = useState<ToggleView>("real");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settings = state?.settings || {};
  const paper = state?.paperEngine;

  // Local edit state
  const [walletMin, setWalletMin] = useState(String(settings.walletMinUsd ?? 50));
  const [paperCap, setPaperCap] = useState(String(settings.paperCapitalUsd ?? 5000));

  useEffect(() => {
    setWalletMin(String(settings.walletMinUsd ?? 50));
    setPaperCap(String(settings.paperCapitalUsd ?? 5000));
  }, [settings.walletMinUsd, settings.paperCapitalUsd]);

  const askPwd = (): string | null => {
    if (typeof window === "undefined") return null;
    const v = window.prompt("Nhập mật khẩu để xác nhận:");
    return v?.trim() || null;
  };

  const updateConfig = async (patch: Partial<any>) => {
    try {
      setBusy(true); setError(null);
      await api.setPresetConfig(patch);
      await onRefresh();
    } catch (e: any) { setError(e?.message ?? String(e)); }
    finally { setBusy(false); }
  };

  const onPaperReset = async () => {
    const pwd = askPwd(); if (!pwd) return;
    try { setBusy(true); await api.paperReset(pwd); await onRefresh(); }
    catch (e: any) { setError(e?.message ?? String(e)); }
    finally { setBusy(false); }
  };

  const onPaperClear = async () => {
    const pwd = askPwd(); if (!pwd) return;
    if (!window.confirm("Xóa HẾT paper trades + reset capital? Không revert được.")) return;
    try { setBusy(true); await api.paperClear(pwd); await onRefresh(); }
    catch (e: any) { setError(e?.message ?? String(e)); }
    finally { setBusy(false); }
  };

  const onRealClear = async () => {
    const pwd = askPwd(); if (!pwd) return;
    if (!window.confirm("⚠️ Xóa HẾT tracked positions + pending trên SERVER. Position trên BINANCE KHÔNG bị đóng. Tiếp tục?")) return;
    try { setBusy(true); await api.realClear(pwd); await onRefresh(); }
    catch (e: any) { setError(e?.message ?? String(e)); }
    finally { setBusy(false); }
  };

  // Real stats
  const realOpen = state?.trackedPositions?.length || 0;
  const realLong = state?.trackedPositions?.filter((p: any) => p.side === "LONG").length || 0;
  const realShort = realOpen - realLong;
  const availableUsd = parseFloat(state?.binanceSnapshot?.account?.availableBalance ?? "NaN");

  // Paper stats
  const paperOpen = paper?.positions?.filter((p: any) => p.status === "OPEN").length || 0;
  const paperClosed = paper?.totalClosed || 0;
  const paperWins = paper?.wins || 0;
  const paperLosses = paper?.losses || 0;
  const paperWr = paperClosed > 0 ? (paperWins / paperClosed * 100).toFixed(1) : "0";
  const paperRoi = paper ? (((paper.capital - paper.initialCapital) / paper.initialCapital) * 100).toFixed(2) : "0";

  return (
    <View style={styles.card}>
      {/* HEADER + TOGGLE */}
      <View style={styles.headerRow}>
        <Text style={styles.h1}>⚡ PRESET ENGINE</Text>
        <View style={styles.toggleRow}>
          <TouchableOpacity
            style={[styles.toggleBtn, view === "real" && styles.toggleActive]}
            onPress={() => setView("real")}
          >
            <Text style={[styles.toggleText, view === "real" && styles.toggleTextActive]}>🔴 REAL</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.toggleBtn, view === "paper" && styles.toggleActiveBlue]}
            onPress={() => setView("paper")}
          >
            <Text style={[styles.toggleText, view === "paper" && styles.toggleTextActive]}>📋 PAPER</Text>
          </TouchableOpacity>
        </View>
      </View>

      {error && <Text style={styles.error}>⚠️ {error}</Text>}

      {/* MODE INFO */}
      <View style={styles.modeInfo}>
        <Text style={styles.dim}>
          Server engine mode: <Text style={{ color: P.bitcoinOrange, fontWeight: "700" }}>{settings.serverEngineMode || "preset"}</Text>
        </Text>
        {settings.serverEngineMode === "htf_rules" && (
          <Text style={styles.warn}>⚠️ HTF rules mode đang chạy — preset OFF. Click bên dưới để switch.</Text>
        )}
        {settings.serverEngineMode !== "htf_rules" && (
          <TouchableOpacity onPress={() => updateConfig({ serverEngineMode: "htf_rules" })} disabled={busy}>
            <Text style={styles.linkText}>Switch về HTF rules mode</Text>
          </TouchableOpacity>
        )}
        {settings.serverEngineMode === "htf_rules" && (
          <TouchableOpacity onPress={() => updateConfig({ serverEngineMode: "preset" })} disabled={busy}>
            <Text style={styles.linkText}>Switch sang PRESET mode</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* REAL VIEW */}
      {view === "real" && (
        <View>
          <Text style={styles.h2}>🔴 REAL ENGINE — Binance thật</Text>
          <Text style={styles.dim}>
            Available USDT: <Text style={{ color: availableUsd > (settings.walletMinUsd ?? 50) ? P.green : P.error, fontWeight: "700" }}>
              ${Number.isFinite(availableUsd) ? availableUsd.toFixed(2) : "—"}
            </Text>
          </Text>
          <Text style={styles.dim}>Open: <Text style={{ color: P.text }}>{realOpen}</Text> ({realLong} LONG / {realShort} SHORT)</Text>

          {/* PRESET DROPDOWN */}
          <Text style={styles.label}>Active Preset:</Text>
          <View style={styles.presetGrid}>
            {PRESET_KEYS.map((k) => {
              const meta = PRESET_LABELS[k];
              const active = settings.activePresetKey === k;
              return (
                <TouchableOpacity
                  key={k}
                  style={[styles.presetBtn, active && styles.presetActive]}
                  onPress={() => updateConfig({ activePresetKey: k })}
                  disabled={busy}
                >
                  <Text style={styles.presetText}>{meta.emoji} {meta.label}</Text>
                  <Text style={styles.presetSubText}>TP{meta.tp}/SL{meta.sl} stack {meta.stack}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* CONFIG FIELDS */}
          <View style={styles.configRow}>
            <Text style={styles.label}>Margin USDT/lệnh:</Text>
            <Text style={styles.dim}>${settings.marginUsd ?? 1} × leverage {settings.leverage ?? 100}x = ${(settings.marginUsd ?? 1) * (settings.leverage ?? 100)} notional</Text>
          </View>
          <View style={styles.configRow}>
            <Text style={styles.label}>Wallet min USDT (stop entry):</Text>
            <View style={styles.inlineEdit}>
              <TextInput
                style={styles.input}
                value={walletMin}
                onChangeText={setWalletMin}
                keyboardType="numeric"
              />
              <TouchableOpacity
                style={styles.applyBtn}
                onPress={() => updateConfig({ walletMinUsd: parseFloat(walletMin) || 50 })}
                disabled={busy}
              >
                <Text style={styles.applyBtnText}>SAVE</Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* CLEAR BUTTON */}
          <View style={styles.actionRow}>
            <TouchableOpacity style={styles.dangerBtn} onPress={onRealClear} disabled={busy}>
              <Text style={styles.dangerBtnText}>🗑️ CLEAR REAL STATE</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.smallDim}>Clear = xóa tracked positions + pending + firedIds. Position trên Binance KHÔNG bị đóng.</Text>
        </View>
      )}

      {/* PAPER VIEW */}
      {view === "paper" && (
        <View>
          <Text style={styles.h2}>📋 PAPER ENGINE — virtual simulate</Text>

          {/* Toggle paperEnabled */}
          <View style={styles.configRow}>
            <Text style={styles.label}>Paper Engine:</Text>
            <TouchableOpacity
              style={[styles.toggleBtn, settings.paperEnabled && styles.toggleActive]}
              onPress={() => updateConfig({ paperEnabled: !settings.paperEnabled })}
              disabled={busy}
            >
              <Text style={[styles.toggleText, settings.paperEnabled && styles.toggleTextActive]}>
                {settings.paperEnabled ? "✅ ON" : "❌ OFF"}
              </Text>
            </TouchableOpacity>
          </View>

          {/* PAPER STATS */}
          <View style={styles.statsBox}>
            <Text style={styles.dim}>
              Capital: <Text style={{ color: P.bitcoinOrange, fontWeight: "700" }}>${paper?.capital?.toFixed(2) ?? "—"}</Text>
              {paper && <Text style={styles.dim}> (init ${paper.initialCapital}, ROI {paperRoi}%)</Text>}
            </Text>
            <Text style={styles.dim}>
              Open: {paperOpen} · Closed: {paperClosed} · Wins: {paperWins} · Losses: {paperLosses} · WR: {paperWr}%
            </Text>
            <Text style={styles.dim}>Total NET: <Text style={{ color: (paper?.totalPnlUsd ?? 0) >= 0 ? P.green : P.error }}>${paper?.totalPnlUsd?.toFixed(2) ?? "0"}</Text></Text>
          </View>

          {/* PAPER PRESET DROPDOWN */}
          <Text style={styles.label}>Paper Preset:</Text>
          <View style={styles.presetGrid}>
            {PRESET_KEYS.map((k) => {
              const meta = PRESET_LABELS[k];
              const active = settings.paperPresetKey === k;
              return (
                <TouchableOpacity
                  key={k}
                  style={[styles.presetBtn, active && styles.presetActiveBlue]}
                  onPress={() => updateConfig({ paperPresetKey: k })}
                  disabled={busy}
                >
                  <Text style={styles.presetText}>{meta.emoji} {meta.label}</Text>
                  <Text style={styles.presetSubText}>TP{meta.tp}/SL{meta.sl} stack {meta.stack}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* PAPER CONFIG */}
          <View style={styles.configRow}>
            <Text style={styles.label}>Paper Capital USDT:</Text>
            <View style={styles.inlineEdit}>
              <TextInput
                style={styles.input}
                value={paperCap}
                onChangeText={setPaperCap}
                keyboardType="numeric"
              />
              <TouchableOpacity
                style={styles.applyBtn}
                onPress={() => updateConfig({ paperCapitalUsd: parseFloat(paperCap) || 5000 })}
                disabled={busy}
              >
                <Text style={styles.applyBtnText}>SAVE</Text>
              </TouchableOpacity>
            </View>
          </View>
          <Text style={styles.smallDim}>Margin: ${settings.paperMarginUsd ?? 1} × Leverage: {settings.paperLeverage ?? 125}x</Text>

          {/* PAPER ACTIONS */}
          <View style={styles.actionRow}>
            <TouchableOpacity style={styles.warnBtn} onPress={onPaperReset} disabled={busy}>
              <Text style={styles.warnBtnText}>↻ RESET STATS (giữ open)</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.dangerBtn} onPress={onPaperClear} disabled={busy}>
              <Text style={styles.dangerBtnText}>🗑️ CLEAR PAPER (xóa hết)</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: P.surface, borderRadius: 6, padding: 14, marginBottom: 14, borderWidth: 1, borderColor: P.border },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  h1: { color: P.bitcoinOrange, fontSize: 16, fontWeight: "800" },
  h2: { color: P.text, fontSize: 14, fontWeight: "700", marginTop: 12, marginBottom: 8 },
  dim: { color: P.dim, fontSize: 12 },
  smallDim: { color: P.dim, fontSize: 10, marginTop: 4 },
  warn: { color: "#fbbf24", fontSize: 11, marginTop: 4 },
  error: { color: P.error, fontSize: 12, marginBottom: 8 },
  linkText: { color: P.bitcoinOrange, fontSize: 11, marginTop: 4, textDecorationLine: "underline" },

  toggleRow: { flexDirection: "row", gap: 4 },
  toggleBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 4, borderWidth: 1, borderColor: P.border, backgroundColor: P.surface },
  toggleActive: { borderColor: P.error, backgroundColor: P.error + "33" },
  toggleActiveBlue: { borderColor: "#3b82f6", backgroundColor: "#3b82f633" },
  toggleText: { color: P.dim, fontSize: 11, fontWeight: "700" },
  toggleTextActive: { color: P.text },

  modeInfo: { padding: 8, backgroundColor: P.surface, borderRadius: 4, marginBottom: 10 },

  label: { color: P.text, fontSize: 12, fontWeight: "600", marginTop: 10, marginBottom: 4 },

  presetGrid: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 8 },
  presetBtn: { paddingHorizontal: 8, paddingVertical: 6, borderRadius: 4, borderWidth: 1, borderColor: P.border, backgroundColor: P.surface, minWidth: 140 },
  presetActive: { borderColor: P.error, backgroundColor: P.error + "22" },
  presetActiveBlue: { borderColor: "#3b82f6", backgroundColor: "#3b82f622" },
  presetText: { color: P.text, fontSize: 11, fontWeight: "600" },
  presetSubText: { color: P.dim, fontSize: 9 },

  configRow: { flexDirection: "column", gap: 4, marginTop: 8 },
  inlineEdit: { flexDirection: "row", alignItems: "center", gap: 6 },
  input: { backgroundColor: P.surface, color: P.text, padding: 6, borderRadius: 4, borderWidth: 1, borderColor: P.border, minWidth: 80, fontSize: 12 },
  applyBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 4, backgroundColor: P.bitcoinOrange },
  applyBtnText: { color: "#000", fontWeight: "700", fontSize: 11 },

  statsBox: { padding: 10, backgroundColor: P.surface, borderRadius: 4, marginVertical: 8, gap: 4 },

  actionRow: { flexDirection: "row", gap: 8, marginTop: 12, flexWrap: "wrap" },
  dangerBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 4, backgroundColor: P.error },
  dangerBtnText: { color: "#fff", fontWeight: "700", fontSize: 11 },
  warnBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 4, backgroundColor: "#fbbf24" },
  warnBtnText: { color: "#000", fontWeight: "700", fontSize: 11 },
});
