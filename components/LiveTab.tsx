/**
 * LiveTab — full screen Live Trading control center.
 *
 * Sections:
 *   1. STATUS bar — wallet, dailyPnl, openCount, autoEnabled, paused, lastError
 *   2. CONTROLS — toggle AUTO + DRY RUN/REAL + reset cooldown
 *   3. CREDENTIALS — API key/secret (masked, local only)
 *   4. SETTINGS — margin, leverage, max open, daily cap, cooldown, TP/SL, excluded TFs
 *   5. POSITIONS — live position list từ Binance
 *   6. HISTORY — journal đầy đủ với filter dry/real, action kind
 */
import React, { useMemo, useState } from "react";
import {
  View, Text, ScrollView, TextInput, TouchableOpacity, StyleSheet, useWindowDimensions,
} from "react-native";
import { P } from "../utils/v2Theme";
import { UseBinanceLiveResult } from "../hooks/useBinanceLive";
import { LiveSettings } from "../utils/liveTraderEngine";

interface Props {
  live: UseBinanceLiveResult;
}

export default function LiveTab({ live }: Props) {
  const { width } = useWindowDimensions();
  const isWide = width >= 900;

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.rootContent}>
      <StatusBar live={live} />

      <View style={[styles.grid, isWide && styles.gridWide]}>
        <View style={styles.col}>
          <ControlsCard live={live} />
          <CredentialsCard live={live} />
          <SettingsCard live={live} />
        </View>
        <View style={styles.col}>
          <PositionsCard live={live} />
          <HistoryCard live={live} />
        </View>
      </View>
    </ScrollView>
  );
}

// ── STATUS BAR ──────────────────────────────────────────────────────────────

function StatusBar({ live }: Props) {
  const isPaused = live.state.pausedUntilMs > Date.now();
  const cooldownLeftM = isPaused ? Math.ceil((live.state.pausedUntilMs - Date.now()) / 60000) : 0;
  const wallet = live.account ? parseFloat(live.account.totalWalletBalance) : null;
  const avail = live.account ? parseFloat(live.account.availableBalance) : null;
  const upnl = live.account ? parseFloat(live.account.totalUnrealizedProfit) : null;

  return (
    <View style={styles.statusBar}>
      <View style={styles.statusRow}>
        <BigPill label="MODE" value={live.state.dryRun ? "DRY" : "REAL"} color={live.state.dryRun ? P.dim : P.error} />
        <BigPill label="AUTO" value={live.state.autoEnabled ? "ON" : "OFF"} color={live.state.autoEnabled ? P.green : P.dim} />
        <BigPill label="OPEN" value={`${live.openCount}/${live.state.settings.maxOpen}`} color={P.text} />
        <BigPill
          label="PnL TODAY"
          value={`${live.dailyPnl >= 0 ? "+" : ""}$${live.dailyPnl.toFixed(2)}`}
          color={live.dailyPnl >= 0 ? P.green : P.error}
        />
        {wallet !== null && (
          <BigPill label="WALLET" value={`$${wallet.toFixed(2)}`} color={P.bitcoinOrange} />
        )}
        {avail !== null && (
          <BigPill label="AVAIL" value={`$${avail.toFixed(2)}`} color={P.dim} />
        )}
        {upnl !== null && (
          <BigPill label="uPnL" value={`${upnl >= 0 ? "+" : ""}$${upnl.toFixed(2)}`} color={upnl >= 0 ? P.green : P.error} />
        )}
        {isPaused && (
          <BigPill label="PAUSED" value={`${cooldownLeftM}m`} color={P.bitcoinOrange} />
        )}
      </View>
      {live.lastError && (
        <Text style={styles.errorBar}>❌ {live.lastError}</Text>
      )}
    </View>
  );
}

function BigPill({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <View style={styles.pill}>
      <Text style={styles.pillLabel}>{label}</Text>
      <Text style={[styles.pillValue, { color }]}>{value}</Text>
    </View>
  );
}

// ── CONTROLS ────────────────────────────────────────────────────────────────

function ControlsCard({ live }: Props) {
  const isPaused = live.state.pausedUntilMs > Date.now();
  const credsSet = !!live.state.apiKey && !!live.state.apiSecret;
  return (
    <Card title="⚡ CONTROLS">
      <View style={styles.row}>
        <Toggle
          label={live.state.autoEnabled ? "AUTO ON" : "AUTO OFF"}
          on={live.state.autoEnabled}
          color={P.green}
          disabled={!credsSet}
          onPress={() => live.setAutoEnabled(!live.state.autoEnabled)}
        />
        <Toggle
          label={live.state.dryRun ? "DRY RUN" : "REAL ORDERS"}
          on={!live.state.dryRun}
          color={P.error}
          onPress={() => live.setDryRun(!live.state.dryRun)}
        />
      </View>
      {!live.state.dryRun && (
        <Text style={styles.warn}>🔴 REAL MODE — lệnh sẽ vào Binance bằng tiền thật.</Text>
      )}
      {!credsSet && (
        <Text style={styles.note}>Nhập API key trước khi bật AUTO.</Text>
      )}
      <View style={styles.row}>
        {isPaused && (
          <TouchableOpacity onPress={live.resetCooldown} style={styles.btnGhost}>
            <Text style={styles.btnGhostText}>RESET COOLDOWN</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity onPress={live.pullFromRemote} style={styles.btnGhost}>
          <Text style={styles.btnGhostText}>PULL FROM GIT</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={live.testNow} style={styles.btnGhost}>
          <Text style={styles.btnGhostText}>TEST CONNECTION</Text>
        </TouchableOpacity>
      </View>
    </Card>
  );
}

// ── CREDENTIALS ─────────────────────────────────────────────────────────────

function CredentialsCard({ live }: Props) {
  const [keyDraft, setKeyDraft] = useState(live.state.apiKey);
  const [secretDraft, setSecretDraft] = useState(live.state.apiSecret);
  const [show, setShow] = useState(false);
  return (
    <Card title="🔐 CREDENTIALS (local only — KHÔNG sync)">
      <Text style={styles.warn}>
        ⚠️ DISABLE quyền "Withdrawal" trên API key. Chỉ enable Futures + Trading.
      </Text>
      <TextInput
        placeholder="API Key"
        placeholderTextColor={P.dim}
        value={keyDraft}
        onChangeText={setKeyDraft}
        style={styles.input}
        secureTextEntry={!show}
        autoCapitalize="none" autoCorrect={false}
      />
      <TextInput
        placeholder="API Secret"
        placeholderTextColor={P.dim}
        value={secretDraft}
        onChangeText={setSecretDraft}
        style={styles.input}
        secureTextEntry={!show}
        autoCapitalize="none" autoCorrect={false}
      />
      <View style={styles.row}>
        <TouchableOpacity onPress={() => setShow((v) => !v)} style={styles.btnGhost}>
          <Text style={styles.btnGhostText}>{show ? "👁 hide" : "👁 show"}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => live.setCredentials(keyDraft.trim(), secretDraft.trim())}
          style={styles.btnPrimary}
        >
          <Text style={styles.btnPrimaryText}>SAVE</Text>
        </TouchableOpacity>
      </View>
    </Card>
  );
}

// ── SETTINGS ────────────────────────────────────────────────────────────────

function SettingsCard({ live }: Props) {
  const s = live.state.settings;
  const [draft, setDraft] = useState<LiveSettings>(s);
  React.useEffect(() => { setDraft(s); }, [s]);

  function field<K extends keyof LiveSettings>(key: K, value: LiveSettings[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  function commit() {
    live.setSettings(draft);
  }

  function toggleTf(tf: string) {
    setDraft((d) => {
      const exists = d.excludedTfs.includes(tf);
      return { ...d, excludedTfs: exists ? d.excludedTfs.filter((x) => x !== tf) : [...d.excludedTfs, tf] };
    });
  }

  const allTfs = ["5m", "15m", "1h", "4h", "1d"];

  return (
    <Card title="⚙️ SETTINGS (sync git)">
      <View style={styles.fieldRow}>
        <NumField label="Symbol (lock)" value={draft.symbol} disabled />
        <NumField label="Leverage" value={draft.leverage} onChangeNum={(v) => field("leverage", v)} />
      </View>
      <View style={styles.fieldRow}>
        <NumField label="Margin (USD)" value={draft.marginUsd} onChangeNum={(v) => field("marginUsd", v)} step={0.5} />
        <NumField label="Max OPEN" value={draft.maxOpen} onChangeNum={(v) => field("maxOpen", Math.max(1, Math.round(v)))} />
      </View>
      <View style={styles.fieldRow}>
        <NumField label="Daily cap (USD, âm)" value={draft.dailyLossCapUsd} onChangeNum={(v) => field("dailyLossCapUsd", v)} step={1} />
        <NumField label="Cooldown (phút)" value={draft.cooldownMinutes} onChangeNum={(v) => field("cooldownMinutes", Math.max(1, Math.round(v)))} />
      </View>
      <View style={styles.fieldRow}>
        <NumField label="TP %" value={draft.tpPct} onChangeNum={(v) => field("tpPct", v)} step={0.5} />
        <NumField label="SL %" value={draft.slPct} onChangeNum={(v) => field("slPct", v)} step={0.5} />
      </View>

      <Text style={styles.subLabel}>Excluded TFs (bấm để toggle)</Text>
      <View style={styles.row}>
        {allTfs.map((tf) => {
          const off = draft.excludedTfs.includes(tf);
          return (
            <TouchableOpacity key={tf} onPress={() => toggleTf(tf)}
              style={[styles.tfChip, { borderColor: off ? P.error : P.green, backgroundColor: off ? P.error + "22" : P.green + "22" }]}>
              <Text style={{ color: off ? P.error : P.green, fontFamily: "monospace", fontWeight: "700", fontSize: 11 }}>
                {off ? "✕" : "✓"} {tf}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <View style={styles.row}>
        <TouchableOpacity onPress={commit} style={styles.btnPrimary}>
          <Text style={styles.btnPrimaryText}>SAVE + SYNC GIT</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={live.resetSettings} style={styles.btnGhost}>
          <Text style={styles.btnGhostText}>RESET DEFAULT</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.note}>
        Notional/lệnh = ${(draft.marginUsd * draft.leverage).toFixed(0)} ·
        max margin lock = ${(draft.marginUsd * draft.maxOpen).toFixed(0)}
      </Text>
    </Card>
  );
}

function NumField({
  label, value, onChangeNum, disabled, step,
}: { label: string; value: number | string; onChangeNum?: (v: number) => void; disabled?: boolean; step?: number }) {
  const [raw, setRaw] = useState(String(value));
  React.useEffect(() => { setRaw(String(value)); }, [value]);
  return (
    <View style={styles.numField}>
      <Text style={styles.numLabel}>{label}</Text>
      <TextInput
        style={[styles.input, disabled && { opacity: 0.5 }]}
        value={raw}
        onChangeText={(t) => {
          setRaw(t);
          if (onChangeNum) {
            const n = parseFloat(t);
            if (!isNaN(n)) onChangeNum(n);
          }
        }}
        editable={!disabled}
        keyboardType="numeric"
      />
    </View>
  );
}

// ── POSITIONS ───────────────────────────────────────────────────────────────

function PositionsCard({ live }: Props) {
  const open = live.positions.filter((p) => parseFloat(p.positionAmt) !== 0);
  return (
    <Card title={`📍 OPEN POSITIONS · ${open.length}`}>
      {open.length === 0 ? (
        <Text style={styles.note}>Không có position nào mở.</Text>
      ) : (
        open.map((p, i) => {
          const amt = parseFloat(p.positionAmt);
          const upnl = parseFloat(p.unRealizedProfit);
          const side = amt > 0 ? "LONG" : "SHORT";
          return (
            <View key={i} style={styles.posRow}>
              <Text style={[styles.posCell, { color: side === "LONG" ? P.green : P.error, width: 50, fontWeight: "800" }]}>{side}</Text>
              <Text style={[styles.posCell, { width: 80 }]}>{p.symbol}</Text>
              <Text style={[styles.posCell, { width: 70 }]}>qty {Math.abs(amt)}</Text>
              <Text style={[styles.posCell, { width: 90 }]}>@ ${parseFloat(p.entryPrice).toFixed(0)}</Text>
              <Text style={[styles.posCell, { color: upnl >= 0 ? P.green : P.error, flex: 1, textAlign: "right", fontWeight: "700" }]}>
                {upnl >= 0 ? "+" : ""}${upnl.toFixed(2)}
              </Text>
            </View>
          );
        })
      )}
    </Card>
  );
}

// ── HISTORY ─────────────────────────────────────────────────────────────────

function HistoryCard({ live }: Props) {
  const [filter, setFilter] = useState<"ALL" | "ENTRY" | "BLOCK" | "ERROR">("ALL");
  const items = useMemo(() => {
    const all = [...live.state.journal].slice(-200).reverse();
    if (filter === "ALL") return all;
    return all.filter((j) => j.action.kind === filter);
  }, [live.state.journal, filter]);

  return (
    <Card title={`📜 HISTORY · ${live.state.journal.length} total`}>
      <View style={styles.row}>
        {(["ALL", "ENTRY", "BLOCK", "ERROR"] as const).map((f) => (
          <TouchableOpacity key={f} onPress={() => setFilter(f)}
            style={[styles.filterChip, filter === f && styles.filterChipActive]}>
            <Text style={[styles.filterText, filter === f && { color: P.bitcoinOrange }]}>{f}</Text>
          </TouchableOpacity>
        ))}
        <TouchableOpacity onPress={live.clearJournal} style={[styles.btnGhost, { marginLeft: "auto" }]}>
          <Text style={styles.btnGhostText}>CLEAR</Text>
        </TouchableOpacity>
      </View>
      {items.length === 0 ? (
        <Text style={styles.note}>No entries.</Text>
      ) : (
        items.map((j, i) => <JournalRow key={i} j={j} />)
      )}
    </Card>
  );
}

function JournalRow({ j }: { j: any }) {
  const t = new Date(j.ts);
  const dd = String(t.getDate()).padStart(2, "0");
  const mm = String(t.getMonth() + 1).padStart(2, "0");
  const hh = String(t.getHours()).padStart(2, "0");
  const mi = String(t.getMinutes()).padStart(2, "0");
  const a = j.action;
  let color = P.dim, text = "";
  if (a.kind === "ENTRY") {
    color = a.side === "LONG" ? P.green : P.error;
    text = `${a.side} qty ${a.qty} @ $${a.entryPrice.toFixed(0)} → TP $${a.tpPrice.toFixed(0)} / SL $${a.slPrice.toFixed(0)}`;
  } else if (a.kind === "BLOCK") {
    color = P.bitcoinOrange;
    text = `BLOCK · ${a.reason}`;
  } else {
    color = P.error;
    text = `ERROR · ${a.message}`;
  }
  return (
    <View style={styles.histRow}>
      <Text style={styles.histTime}>{dd}/{mm} {hh}:{mi}</Text>
      <Text style={[styles.histRule, { color: P.dim }]} numberOfLines={1}>{j.ruleId}</Text>
      <Text style={[styles.histText, { color }]} numberOfLines={2}>
        {j.dryRun && a.kind === "ENTRY" ? "[DRY] " : ""}{text}
      </Text>
    </View>
  );
}

// ── SHARED ──────────────────────────────────────────────────────────────────

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{title}</Text>
      <View style={styles.cardBody}>{children}</View>
    </View>
  );
}

function Toggle({ label, on, onPress, disabled, color }:
  { label: string; on: boolean; onPress: () => void; disabled?: boolean; color: string }) {
  return (
    <TouchableOpacity
      onPress={onPress} disabled={disabled}
      style={[
        styles.toggle,
        { borderColor: on ? color : P.border, backgroundColor: on ? color + "22" : "transparent",
          opacity: disabled ? 0.4 : 1 },
      ]}
    >
      <Text style={[styles.toggleText, { color: on ? color : P.dim }]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: P.bg },
  rootContent: { padding: 12, paddingBottom: 80 },
  statusBar: {
    backgroundColor: P.card, borderWidth: 1, borderColor: P.border,
    borderLeftWidth: 4, borderLeftColor: P.bitcoinOrange,
    borderRadius: 4, padding: 10, marginBottom: 12,
  },
  statusRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  pill: {
    backgroundColor: P.elevated, borderWidth: 1, borderColor: P.border,
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 4, minWidth: 90, alignItems: "center",
  },
  pillLabel: { color: P.dim, fontFamily: "monospace", fontSize: 9, letterSpacing: 1 },
  pillValue: { fontFamily: "monospace", fontSize: 14, fontWeight: "900", marginTop: 2 },
  errorBar: { color: P.error, fontFamily: "monospace", fontSize: 11, marginTop: 8 },

  grid: { flexDirection: "column", gap: 12 },
  gridWide: { flexDirection: "row" },
  col: { flex: 1, gap: 12 },

  card: { backgroundColor: P.card, borderWidth: 1, borderColor: P.border, borderRadius: 4, marginBottom: 12 },
  cardTitle: {
    color: P.text2, fontFamily: "monospace", fontSize: 11, fontWeight: "900", letterSpacing: 1,
    padding: 10, borderBottomWidth: 1, borderBottomColor: P.borderSoft,
  },
  cardBody: { padding: 10 },

  row: { flexDirection: "row", gap: 8, flexWrap: "wrap", alignItems: "center", marginVertical: 4 },
  fieldRow: { flexDirection: "row", gap: 8, marginVertical: 4 },
  numField: { flex: 1 },
  numLabel: { color: P.dim, fontFamily: "monospace", fontSize: 10, marginBottom: 2 },

  input: {
    color: P.text, backgroundColor: P.elevated, borderWidth: 1, borderColor: P.border,
    borderRadius: 4, paddingHorizontal: 10, paddingVertical: 8,
    fontFamily: "monospace", fontSize: 12,
  },
  subLabel: { color: P.dim, fontFamily: "monospace", fontSize: 10, marginTop: 8, marginBottom: 4 },

  warn: { color: P.bitcoinOrange, fontSize: 10, lineHeight: 14, fontFamily: "monospace", marginVertical: 4 },
  note: { color: P.dim, fontSize: 10, lineHeight: 14, fontFamily: "monospace", marginVertical: 4 },

  btnPrimary: { backgroundColor: P.bitcoinOrange, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 4 },
  btnPrimaryText: { color: P.onPrimary, fontFamily: "monospace", fontWeight: "700", fontSize: 11, letterSpacing: 1 },
  btnGhost: { borderWidth: 1, borderColor: P.border, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 4 },
  btnGhostText: { color: P.text2, fontFamily: "monospace", fontWeight: "700", fontSize: 11, letterSpacing: 1 },

  toggle: { borderWidth: 2, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 4 },
  toggleText: { fontFamily: "monospace", fontWeight: "900", fontSize: 11, letterSpacing: 1 },

  tfChip: { borderWidth: 1, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 4 },

  filterChip: { borderWidth: 1, borderColor: P.border, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 4 },
  filterChipActive: { borderColor: P.bitcoinOrange, backgroundColor: P.bitcoinOrange + "22" },
  filterText: { color: P.dim, fontFamily: "monospace", fontWeight: "700", fontSize: 10, letterSpacing: 1 },

  posRow: { flexDirection: "row", paddingVertical: 6, gap: 6, alignItems: "center", borderBottomWidth: 1, borderBottomColor: P.borderSoft },
  posCell: { color: P.text2, fontFamily: "monospace", fontSize: 11 },

  histRow: { flexDirection: "row", paddingVertical: 6, gap: 8, alignItems: "flex-start", borderBottomWidth: 1, borderBottomColor: P.borderSoft },
  histTime: { color: P.dim, fontFamily: "monospace", fontSize: 10, width: 78 },
  histRule: { fontFamily: "monospace", fontSize: 10, width: 90 },
  histText: { fontFamily: "monospace", fontSize: 11, flex: 1, lineHeight: 16 },
});
