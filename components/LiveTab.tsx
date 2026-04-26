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
          <OpenOrdersCard live={live} />
          <RecentFillsCard live={live} />
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
        <BigPill label="POS MODE" value={live.state.hedgeMode ? "HEDGE" : "ONE-WAY"} color={live.state.hedgeMode ? P.tertiary : P.text2} />
        {live.account?.multiAssetsMargin !== undefined && (
          <BigPill
            label="ASSET MODE"
            value={live.account.multiAssetsMargin ? "MULTI" : "SINGLE"}
            color={live.account.multiAssetsMargin ? P.error : P.text2}
          />
        )}
        {live.account?.feeTier !== undefined && (
          <BigPill label="FEE TIER" value={`VIP ${live.account.feeTier}`} color={P.dim} />
        )}
        {live.account?.canTrade === false && (
          <BigPill label="TRADE" value="LOCKED" color={P.error} />
        )}
      </View>
      {live.lastError && (
        <Text style={[styles.errorBar, { color: live.lastError.startsWith("✅") ? P.green : P.error }]}>
          {live.lastError}
        </Text>
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
          color={P.green}
          solidWhenOn
          onPress={() => live.setDryRun(!live.state.dryRun)}
        />
      </View>
      <Text style={styles.note}>
        💡 AUTO ON/OFF: bật/tắt engine. OFF → ignore mọi rule fire.
        {"\n"}💡 DRY RUN: chỉ giả lập, log vào HISTORY, KHÔNG gửi lên Binance.
        {"\n"}💡 REAL ORDERS (xanh): gửi MARKET + TP + SL thật, ăn tiền thật.
      </Text>
      {!live.state.dryRun && (
        <Text style={styles.warn}>🟢 REAL MODE — lệnh sẽ vào Binance bằng tiền thật.</Text>
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
      <Text style={styles.note}>
        💡 RESET COOLDOWN: bỏ qua pause sau daily-cap, resume ngay.
        {"\n"}💡 PULL FROM GIT: pull settings + history mới nhất từ GitHub (nếu đổi ở máy khác).
        {"\n"}💡 TEST CONNECTION: gọi GET account để verify API key, hiện wallet ngay.
      </Text>
    </Card>
  );
}

// ── CREDENTIALS ─────────────────────────────────────────────────────────────

function CredentialsCard({ live }: Props) {
  const [keyDraft, setKeyDraft] = useState(live.state.apiKey);
  const [secretDraft, setSecretDraft] = useState(live.state.apiSecret);
  const [show, setShow] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const credsSet = !!live.state.apiKey && !!live.state.apiSecret;

  async function handleSave() {
    await live.setCredentials(keyDraft.trim(), secretDraft.trim());
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 3000);
  }

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
        <TouchableOpacity onPress={handleSave} style={styles.btnPrimary}>
          <Text style={styles.btnPrimaryText}>SAVE</Text>
        </TouchableOpacity>
        {credsSet && (
          <Text style={[styles.note, { color: P.green, marginLeft: 6 }]}>✓ key đã lưu</Text>
        )}
      </View>
      {savedFlash && (
        <Text style={[styles.note, { color: P.green, fontWeight: "700" }]}>
          ✅ Đã lưu local. Bấm TEST CONNECTION để verify.
        </Text>
      )}
      <Text style={styles.note}>
        💡 Key chỉ lưu ở máy này (AsyncStorage). KHÔNG bao giờ sync git.
        {"\n"}💡 Sang máy khác: phải nhập lại API key + secret. Nhưng SETTINGS + HISTORY thì sync (qua PULL FROM GIT).
      </Text>
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
        <NumField label="Leverage (info, set trên Binance)" value={draft.leverage} onChangeNum={(v) => field("leverage", v)} />
      </View>
      <Text style={styles.note}>
        💡 Leverage chỉ là info (để tính notional/margin hiển thị). App KHÔNG tự set leverage trên Binance.
        Anh muốn đổi → vào Binance Futures → BTCUSDT → đổi leverage thủ công.
      </Text>
      <View style={styles.fieldRow}>
        <NumField label="Margin (USD)" value={draft.marginUsd} onChangeNum={(v) => field("marginUsd", v)} step={0.5} />
        <NumField label="Max OPEN" value={draft.maxOpen} onChangeNum={(v) => field("maxOpen", Math.max(1, Math.round(v)))} />
      </View>
      <View style={styles.fieldRow}>
        <NumField label="Daily cap (USD, âm)" value={draft.dailyLossCapUsd} onChangeNum={(v) => field("dailyLossCapUsd", v)} step={1} />
        <NumField label="Cooldown (phút)" value={draft.cooldownMinutes} onChangeNum={(v) => field("cooldownMinutes", Math.max(1, Math.round(v)))} />
      </View>
      <Text style={styles.note}>
        💡 Daily cap: dailyPnL ≤ ngưỡng này → tự pause auto-trade
        {"\n"}💡 Cooldown: thời gian tạm dừng sau khi cap chạm. Hết cooldown → resume.
      </Text>
      <Text style={styles.note}>TP/SL lấy theo từng rule (targetPct / stopPct trong hard_rules.json)</Text>

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
  // Pre-build TP/SL lookup from open orders (closePosition=true, side ngược position)
  const tpslBySide: { LONG?: { tp?: number; sl?: number }; SHORT?: { tp?: number; sl?: number } } = {};
  for (const o of live.openOrders) {
    if (!o.closePosition) continue;
    // SELL closePosition → close LONG; BUY closePosition → close SHORT
    const positionSide: "LONG" | "SHORT" = o.side === "SELL" ? "LONG" : "SHORT";
    if (!tpslBySide[positionSide]) tpslBySide[positionSide] = {};
    const price = parseFloat(o.stopPrice || o.price || "0");
    if (o.type.includes("TAKE_PROFIT")) tpslBySide[positionSide]!.tp = price;
    else if (o.type.includes("STOP")) tpslBySide[positionSide]!.sl = price;
  }
  return (
    <Card title={`📍 OPEN POSITIONS · ${open.length}`}>
      {open.length === 0 ? (
        <Text style={styles.note}>Không có position nào mở.</Text>
      ) : (
        open.map((p, i) => {
          const amt = parseFloat(p.positionAmt);
          const entry = parseFloat(p.entryPrice);
          const mark = parseFloat(p.markPrice);
          const upnl = parseFloat(p.unRealizedProfit);
          const lev = parseInt(p.leverage, 10) || 1;
          const side: "LONG" | "SHORT" = amt > 0 ? "LONG" : "SHORT";
          // ROE = uPnL / margin (margin = notional / lev)
          const notional = Math.abs(amt) * entry;
          const margin = notional / lev;
          const roe = margin > 0 ? (upnl / margin) * 100 : 0;
          const tpsl = tpslBySide[side] || {};
          const tpDist = tpsl.tp ? ((tpsl.tp - mark) / mark) * 100 : null;
          const slDist = tpsl.sl ? ((tpsl.sl - mark) / mark) * 100 : null;
          return (
            <View key={i} style={styles.posCard}>
              <View style={styles.posRow}>
                <Text style={[styles.posCell, { color: side === "LONG" ? P.green : P.error, width: 56, fontWeight: "800" }]}>{side}</Text>
                <Text style={[styles.posCell, { width: 70 }]}>{p.symbol}</Text>
                <Text style={[styles.posCell, { width: 56, color: P.bitcoinOrange }]}>{lev}x</Text>
                <Text style={[styles.posCell, { color: upnl >= 0 ? P.green : P.error, flex: 1, textAlign: "right", fontWeight: "800", fontSize: 13 }]}>
                  {upnl >= 0 ? "+" : ""}${upnl.toFixed(2)}
                </Text>
                <Text style={[styles.posCell, { color: roe >= 0 ? P.green : P.error, width: 70, textAlign: "right", fontWeight: "700" }]}>
                  ({roe >= 0 ? "+" : ""}{roe.toFixed(1)}%)
                </Text>
              </View>
              <View style={styles.posRow}>
                <Text style={[styles.posCellSmall, { width: 110 }]}>
                  size ${notional.toFixed(2)}
                </Text>
                <Text style={[styles.posCellSmall, { width: 70 }]}>
                  ({Math.abs(amt)} BTC)
                </Text>
                <Text style={[styles.posCellSmall, { marginLeft: 10 }]}>margin ${margin.toFixed(2)}</Text>
              </View>
              <View style={styles.posRow}>
                <Text style={[styles.posCellSmall, { width: 110 }]}>entry ${entry.toFixed(1)}</Text>
                <Text style={[styles.posCellSmall, { width: 110 }]}>mark ${mark.toFixed(1)}</Text>
                <Text style={[styles.posCellSmall, { flex: 1, textAlign: "right", color: P.dim }]}>
                  Δ {(((mark - entry) / entry) * 100).toFixed(3)}%
                </Text>
              </View>
              {(tpsl.tp || tpsl.sl || parseFloat(p.liquidationPrice) > 0) && (
                <View style={styles.posRow}>
                  {tpsl.tp ? (
                    <Text style={[styles.posCellSmall, { color: P.green, width: 130 }]}>
                      TP ${tpsl.tp.toFixed(1)} ({tpDist! >= 0 ? "+" : ""}{tpDist!.toFixed(2)}%)
                    </Text>
                  ) : <View style={{ width: 130 }} />}
                  {tpsl.sl ? (
                    <Text style={[styles.posCellSmall, { color: P.error, width: 130 }]}>
                      SL ${tpsl.sl.toFixed(1)} ({slDist! >= 0 ? "+" : ""}{slDist!.toFixed(2)}%)
                    </Text>
                  ) : <View style={{ width: 130 }} />}
                  {parseFloat(p.liquidationPrice) > 0 && (
                    <Text style={[styles.posCellSmall, { color: P.bitcoinOrange, flex: 1, textAlign: "right" }]}>
                      LIQ ${parseFloat(p.liquidationPrice).toFixed(1)}
                    </Text>
                  )}
                </View>
              )}
            </View>
          );
        })
      )}
    </Card>
  );
}

// ── OPEN ORDERS (TP/SL pending) ─────────────────────────────────────────────

function OpenOrdersCard({ live }: Props) {
  const orders = live.openOrders;
  return (
    <Card title={`📋 OPEN ORDERS · ${orders.length}`}>
      {orders.length === 0 ? (
        <Text style={styles.note}>Không có order nào pending.</Text>
      ) : (
        orders.map((o) => {
          const isStop = o.type.includes("STOP");
          const isTP = o.type.includes("TAKE_PROFIT");
          const color = isTP ? P.green : isStop ? P.error : P.text;
          return (
            <View key={o.orderId} style={styles.posRow}>
              <Text style={[styles.posCell, { width: 56, color, fontWeight: "800" }]}>{o.side}</Text>
              <Text style={[styles.posCell, { width: 110, color }]}>{o.type.replace("_MARKET", "")}</Text>
              <Text style={[styles.posCell, { width: 80 }]}>qty {o.origQty}</Text>
              <Text style={[styles.posCell, { flex: 1, textAlign: "right" }]}>
                @ ${parseFloat(o.stopPrice || o.price).toFixed(1)}
              </Text>
            </View>
          );
        })
      )}
    </Card>
  );
}

// ── RECENT FILLS ────────────────────────────────────────────────────────────

function RecentFillsCard({ live }: Props) {
  // Sort newest first by time (Binance trả oldest first)
  const trades = [...live.recentTrades].sort((a, b) => b.time - a.time).slice(0, 30);
  return (
    <Card title={`💱 RECENT FILLS · ${live.recentTrades.length}`}>
      {trades.length === 0 ? (
        <Text style={styles.note}>Chưa có fill nào trong 50 lệnh gần nhất.</Text>
      ) : (
        trades.map((t) => {
          const pnl = parseFloat(t.realizedPnl);
          const qty = parseFloat(t.qty);
          const price = parseFloat(t.price);
          const notional = qty * price;
          const time = new Date(t.time);
          const dd = String(time.getDate()).padStart(2, "0");
          const mo = String(time.getMonth() + 1).padStart(2, "0");
          const hh = String(time.getHours()).padStart(2, "0");
          const mi = String(time.getMinutes()).padStart(2, "0");
          return (
            <View key={t.id} style={styles.posRow}>
              <Text style={[styles.posCell, { width: 78, color: P.dim }]}>{dd}/{mo} {hh}:{mi}</Text>
              <Text style={[styles.posCell, { width: 50, color: t.side === "BUY" ? P.green : P.error, fontWeight: "700" }]}>{t.side}</Text>
              <Text style={[styles.posCell, { width: 80 }]}>${notional.toFixed(2)}</Text>
              <Text style={[styles.posCell, { width: 90 }]}>@ ${price.toFixed(1)}</Text>
              {pnl !== 0 && (
                <Text style={[styles.posCell, { color: pnl >= 0 ? P.green : P.error, flex: 1, textAlign: "right", fontWeight: "700" }]}>
                  {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}
                </Text>
              )}
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
  const [copyFlash, setCopyFlash] = useState(false);
  const items = useMemo(() => {
    const all = [...live.state.journal].slice(-200).reverse();
    if (filter === "ALL") return all;
    return all.filter((j) => j.action.kind === filter);
  }, [live.state.journal, filter]);

  async function handleCopyLog() {
    const lines = items.map((j) => {
      const t = new Date(j.ts);
      const dd = String(t.getDate()).padStart(2, "0");
      const mo = String(t.getMonth() + 1).padStart(2, "0");
      const hh = String(t.getHours()).padStart(2, "0");
      const mi = String(t.getMinutes()).padStart(2, "0");
      const a: any = j.action;
      let body = "";
      if (a.kind === "ENTRY") body = `ENTRY ${a.side} qty ${a.qty} @ $${a.entryPrice.toFixed(0)} → TP $${a.tpPrice.toFixed(0)} / SL $${a.slPrice.toFixed(0)}`;
      else if (a.kind === "BLOCK") body = `BLOCK · ${a.reason}`;
      else body = `ERROR · ${a.message}`;
      return `${dd}/${mo} ${hh}:${mi}  ${j.ruleId.padEnd(8)}  ${j.dryRun ? "[DRY] " : ""}${body}`;
    });
    const txt = `LIVE TRADING LOG (${filter}) — ${items.length} entries\n` + lines.join("\n");
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(txt);
        setCopyFlash(true);
        setTimeout(() => setCopyFlash(false), 2000);
      }
    } catch {}
  }

  return (
    <Card title={`📜 HISTORY · ${live.state.journal.length} total`}>
      <View style={styles.row}>
        {(["ALL", "ENTRY", "BLOCK", "ERROR"] as const).map((f) => (
          <TouchableOpacity key={f} onPress={() => setFilter(f)}
            style={[styles.filterChip, filter === f && styles.filterChipActive]}>
            <Text style={[styles.filterText, filter === f && { color: P.bitcoinOrange }]}>{f}</Text>
          </TouchableOpacity>
        ))}
        <TouchableOpacity onPress={handleCopyLog} style={[styles.btnGhost, { marginLeft: "auto" }]}>
          <Text style={styles.btnGhostText}>{copyFlash ? "✓ COPIED" : "📋 COPY LOG"}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={live.clearJournal} style={styles.btnGhost}>
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
      <Text style={[styles.histText, { color }]} numberOfLines={6}>
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

function Toggle({ label, on, onPress, disabled, color, solidWhenOn }:
  { label: string; on: boolean; onPress: () => void; disabled?: boolean; color: string; solidWhenOn?: boolean }) {
  const filled = on && solidWhenOn;
  return (
    <TouchableOpacity
      onPress={onPress} disabled={disabled}
      style={[
        styles.toggle,
        {
          borderColor: on ? color : P.border,
          backgroundColor: filled ? color : on ? color + "22" : "transparent",
          opacity: disabled ? 0.4 : 1,
        },
      ]}
    >
      <Text style={[styles.toggleText, { color: filled ? "#fff" : on ? color : P.dim }]}>
        {label}
      </Text>
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

  posCard: { borderBottomWidth: 1, borderBottomColor: P.borderSoft, paddingVertical: 6 },
  posRow: { flexDirection: "row", paddingVertical: 4, gap: 6, alignItems: "center" },
  posCell: { color: P.text2, fontFamily: "monospace", fontSize: 11 },
  posCellSmall: { color: P.dim, fontFamily: "monospace", fontSize: 10 },

  histRow: { flexDirection: "row", paddingVertical: 6, gap: 8, alignItems: "flex-start", borderBottomWidth: 1, borderBottomColor: P.borderSoft },
  histTime: { color: P.dim, fontFamily: "monospace", fontSize: 10, width: 78 },
  histRule: { fontFamily: "monospace", fontSize: 10, width: 90 },
  histText: { fontFamily: "monospace", fontSize: 11, flex: 1, lineHeight: 16 },
});
