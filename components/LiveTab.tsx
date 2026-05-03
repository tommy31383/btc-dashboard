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
import React, { useMemo, useState, useEffect } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import DebugLabel from "./DebugLabel";
import { PRESETS, PresetKey, getActivePresetKey, DEFAULT_PRESET_KEY } from "../utils/all5mAccount";
import {
  View, Text, ScrollView, TextInput, TouchableOpacity, StyleSheet, useWindowDimensions,
} from "react-native";
import Svg, { Polyline, Polygon, Circle, Line as SvgLine } from "react-native-svg";
import { P } from "../utils/v2Theme";
import { MaterialIcon } from "./v2/MaterialIcon";
import { UseBinanceLiveResult } from "../hooks/useBinanceLive";
import { LiveSettings } from "../utils/liveTraderEngine";

/** Hard-roll password để force claim leader — v4.9.27 (anh Tommy): rotate "3031". */
const CLAIM_LEADER_PASSWORD = "3031";

interface Props {
  live: UseBinanceLiveResult;
  /** Klines theo TF — user chọn TF chart trong LivePriceChartCard (anh Tommy v4.7.21).
   *  Lưu lựa chọn vào AsyncStorage @live_chart_tf_v1. */
  klinesByTf?: Record<string, { time: number; close: number }[]>;
}

const CHART_TF_STORAGE_KEY = "@live_chart_tf_v1";
const CHART_TF_OPTIONS = ["5m", "15m", "1h", "4h"] as const;
type ChartTfKey = typeof CHART_TF_OPTIONS[number];

function useChartTf(): [ChartTfKey, (k: ChartTfKey) => void] {
  const [tf, setTf] = useState<ChartTfKey>("15m");
  useEffect(() => {
    AsyncStorage.getItem(CHART_TF_STORAGE_KEY).then((v) => {
      if (v && CHART_TF_OPTIONS.includes(v as ChartTfKey)) setTf(v as ChartTfKey);
    });
  }, []);
  const update = (k: ChartTfKey) => {
    setTf(k);
    AsyncStorage.setItem(CHART_TF_STORAGE_KEY, k).catch(() => {});
  };
  return [tf, update];
}

function ChartTfPicker({ tf, onChange }: { tf: ChartTfKey; onChange: (k: ChartTfKey) => void }) {
  return (
    <View style={{ flexDirection: "row", gap: 6, padding: 8, borderBottomWidth: 1, borderBottomColor: P.borderSoft }}>
      <Text style={{ color: P.dim, fontSize: 10, fontFamily: "monospace", alignSelf: "center", marginRight: 4 }}>TF:</Text>
      {CHART_TF_OPTIONS.map((k) => {
        const active = k === tf;
        return (
          <TouchableOpacity
            key={k}
            onPress={() => onChange(k)}
            style={{
              paddingHorizontal: 10, paddingVertical: 4, borderRadius: 3,
              borderWidth: 1,
              borderColor: active ? P.bitcoinOrange : P.borderSoft,
              backgroundColor: active ? P.bitcoinOrange + "22" : P.surface,
            }}
          >
            <Text style={{
              color: active ? P.bitcoinOrange : P.dim,
              fontSize: 10, fontFamily: "monospace", fontWeight: "700", letterSpacing: 0.5,
            }}>{k}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

/** Shared hook — đọc active preset từ AsyncStorage (đồng bộ với tab 5m ALL).
 *  Poll 5s để detect khi user đổi preset bên tab 5m ALL → reflect trong LIVE. */
function useActivePreset(): PresetKey {
  const [key, setKey] = useState<PresetKey>(DEFAULT_PRESET_KEY);
  useEffect(() => {
    let alive = true;
    const refresh = () => { getActivePresetKey().then((k) => { if (alive) setKey(k); }); };
    refresh();
    const id = setInterval(refresh, 5000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return key;
}

export default function LiveTab({ live, klinesByTf }: Props) {
  const { width } = useWindowDimensions();
  const isWide = width >= 900;
  const presetKey = useActivePreset();
  const preset = PRESETS[presetKey];
  const fiveMModeOn = live.state.settings.use5mAllEngineMode;

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.rootContent}>
      <DebugLabel name="LiveTab" />
      <StatusBar live={live} />

      {/* 5m ALL ENGINE MODE BANNER — nổi bật khi ON (anh Tommy v4.7.10) */}
      {fiveMModeOn && (
        <View style={[styles.fiveMBanner, { borderColor: preset.emoji === "🔴" ? P.error : preset.emoji === "🟡" ? P.bitcoinOrange : P.green }]}>
          <Text style={styles.fiveMBannerTitle}>
            ⚡ 5m ALL ENGINE: <Text style={{ color: preset.emoji === "🔴" ? P.error : preset.emoji === "🟡" ? P.bitcoinOrange : P.green, fontWeight: "900" }}>
              {preset.emoji} {preset.label}
            </Text>
          </Text>
          <Text style={styles.fiveMBannerSub}>
            Stoch K&lt;{preset.stochLongLevel}/&gt;{preset.stochShortLevel} · S/R 15m ±{preset.srProximityPct}% · TP+{preset.tpPct}%/SL-{preset.slPct}% · cd {preset.cooldownMin}m
            {"  "}· đồng bộ tab 5m ALL · expected 3y NET +${(preset.expectedNet3y / 1000).toFixed(0)}k · DD ${preset.expectedMaxDd3y}
          </Text>
        </View>
      )}

      <View style={[styles.grid, isWide && styles.gridWide]}>
        <View style={[isWide && styles.col]}>
          <ControlsCard live={live} />
          <CredentialsCard live={live} />
          <SettingsCard live={live} />
        </View>
        <View style={[isWide && styles.col]}>
          <LivePriceChartCard live={live} klinesByTf={klinesByTf} />
          <TrackedPositionsCard live={live} />
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
  const alias = live.account?.accountAlias;

  // Leader/follower badge (anh Tommy: single-leader lock)
  const isLeader = live.role === "LEADER";
  const isFollower = live.role === "FOLLOWER";
  const isBoot = live.role === "BOOTING";
  const isDisconnected = live.role === "DISCONNECTED";
  const roleColor = isLeader ? P.green : isFollower ? P.bitcoinOrange : isDisconnected ? P.error : P.dim;
  const verifyLeftSec = Math.ceil(live.verifyLeftMs / 1000);
  const roleLabel = isLeader
    ? "👑 LEADER"
    : isFollower
    ? "👁 FOLLOWER"
    : isDisconnected
    ? "⛔ DISCONNECTED"
    : isBoot && live.verifyLeftMs > 0
    ? `⏳ VERIFYING ${verifyLeftSec}s`
    : "⏳ BOOTING";
  // Leader info — phân biệt rõ 3 case: disconnected / có PAT đang push / LOCAL không PAT
  const leaderTxt = (() => {
    if (isDisconnected) return "⛔ Chưa nhập API key — KHÔNG tham gia leader election. Connect ở section CREDENTIALS bên dưới.";
    if (live.leader) {
      const beatAgo = Math.floor((Date.now() - live.leader.lastBeatMs) / 1000);
      const isMe = live.leader.deviceId === live.deviceId;
      const cityCountry = live.leader.city && live.leader.city !== "?"
        ? ` · ${live.leader.city}, ${live.leader.country}` : "";
      const ip = live.leader.ip ? ` · ${live.leader.ip}` : "";
      return `${isMe ? "👉 BẠN " : ""}${live.leader.deviceLabel} (${live.leader.deviceType || "?"})${cityCountry}${ip} · beat ${beatAgo}s ago`;
    }
    if (isLeader && !live.hasPat) {
      return `👉 BẠN (${live.deviceLabel || "?"}) — LOCAL mode (chưa có GitHub Token để sync multi-device. Vào DASHBOARD → SETTINGS → GitHub PAT)`;
    }
    if (isLeader && live.hasPat && live.verifyLeftMs > 0) {
      return `👉 BẠN (${live.deviceLabel || "?"}) — đang push leader file lên gist, còn ${verifyLeftSec}s nữa hiển thị info đầy đủ`;
    }
    if (isLeader && live.hasPat) {
      // Edge case: đã verify xong nhưng gist trả null (API delay) — auto-retry trong tick 20s tới
      return `👉 BẠN (${live.deviceLabel || "?"}) — gist info chưa nhận được, auto-pull lại trong tick kế (mỗi 20s). Bấm 🔄 RECHECK PAT để pull ngay.`;
    }
    if (isBoot && live.verifyLeftMs > 0) {
      return `⏳ Đang verify leader claim trên gist · còn ${verifyLeftSec}s · sau đó hiển thị LEADER hoặc FOLLOWER chính xác`;
    }
    return "(chưa có leader)";
  })();
  const meIpTxt = live.myIpLoc
    ? `${live.myIpLoc.ip} · ${live.myIpLoc.city}, ${live.myIpLoc.country}`
    : "—";
  const handleRename = () => {
    if (typeof window === "undefined") return;
    const next = window.prompt(`Đặt tên device này (đang là "${live.deviceLabel}"):`, live.deviceLabel);
    if (next === null) return;
    live.setMyDeviceLabel(next);
  };
  const syncTxt = live.lastSyncMs > 0 ? `synced ${Math.floor((Date.now() - live.lastSyncMs) / 1000)}s ago` : "—";
  const handleClaim = () => {
    if (typeof window === "undefined") {
      live.claimLeadership();
      return;
    }
    // Hard-roll: phải nhập password đúng mới được takeover (anh Tommy spec)
    const pwd = window.prompt(
      `🔒 CLAIM LEADER — nhập password để force takeover từ ${live.leader?.deviceLabel ?? "device hiện tại"}:`
    );
    if (pwd === null) return; // user cancel
    if (pwd !== CLAIM_LEADER_PASSWORD) {
      window.alert("❌ Sai password — không được claim.");
      return;
    }
    const ok = window.confirm(
      `⚠️ CLAIM LEADER?\n\n` +
      `Máy này sẽ ghi đè leader file trên gist.\n` +
      `Máy "${live.leader?.deviceLabel ?? "?"}" sẽ TỰ ĐỘNG demote về FOLLOWER trong tối đa 20s ` +
      `(khi tick check kế tiếp pull leader info từ gist).\n\n` +
      `🚨 RISK: trong 20s overlap đó, NẾU máy kia vẫn AUTO ON + có rule fire → cả 2 máy cùng vào lệnh thật trên Binance.\n\n` +
      `→ Khuyến cáo: SAU khi claim, ĐỢI 30s rồi mới bật AUTO ở máy này.`
    );
    if (!ok) return;
    live.claimLeadership();
  };

  return (
    <View style={styles.statusBar}>
      {alias && (
        <View style={styles.profileRow}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{alias.charAt(0).toUpperCase()}</Text>
          </View>
          <View>
            <Text style={styles.profileLabel}>BINANCE FUTURES ACCOUNT</Text>
            <Text style={styles.profileAlias}>{alias}</Text>
          </View>
        </View>
      )}
      <View style={styles.roleRow}>
        <BigPill label="ROLE" value={roleLabel} color={roleColor} />
        <View style={styles.roleInfo}>
          <Text style={[styles.note, { fontSize: 10, lineHeight: 14 }]}>
            <Text style={{ color: P.dim, fontSize: 9, letterSpacing: 1 }}>LEADER:</Text>{" "}
            <Text style={{ color: roleColor, fontWeight: "700" }}>{leaderTxt}</Text>
            {"\n"}
            <Text style={{ color: P.dim, fontSize: 9, letterSpacing: 1 }}>ME:</Text>{" "}
            <Text style={{ color: P.text2, fontWeight: "700" }}>{live.deviceLabel || "?"}</Text>{" "}
            <Text style={{ color: P.dim }}>· {meIpTxt}</Text>
            {isFollower && ` · ${syncTxt}`}
          </Text>
        </View>
        <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
          <TouchableOpacity onPress={handleRename} style={styles.btnGhost}>
            <Text style={styles.btnGhostText}>✏️ RENAME</Text>
          </TouchableOpacity>
          {!isLeader && !isBoot && !isDisconnected && (
            <TouchableOpacity onPress={handleClaim} style={styles.btnDanger}>
              <Text style={styles.btnDangerText}>🔒 CLAIM LEADER</Text>
            </TouchableOpacity>
          )}
          {isLeader && !live.hasPat && !isDisconnected && (
            <TouchableOpacity onPress={() => live.recheckPat()} style={styles.btnGhost}>
              <Text style={styles.btnGhostText}>🔄 RECHECK PAT</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
      {isFollower && (
        <Text style={[styles.warn, { color: P.bitcoinOrange }]}>
          ⚠️ FOLLOWER MODE — không tự vào lệnh / close. Xem state mirror từ leader. Bấm CLAIM để takeover.
        </Text>
      )}
      {isDisconnected && (
        <Text style={[styles.warn, { color: P.error }]}>
          ⛔ DISCONNECTED — device này chưa có Binance API key, không tham gia leader/follower election. Nhập key ở CREDENTIALS để connect.
        </Text>
      )}
      {/* TOP KPI 3-col compact (Stitch inspiration v4.6.0) — quan trọng nhất, hiện luôn */}
      <View style={styles.kpiTop}>
        <View style={styles.kpiTopCell}>
          <Text style={styles.kpiTopLabel}>MODE</Text>
          <Text style={[styles.kpiTopValue, { color: live.state.dryRun ? P.dim : P.error }]}>
            {live.state.dryRun ? "DRY" : "REAL"}
          </Text>
        </View>
        <View style={styles.kpiTopDivider} />
        <View style={styles.kpiTopCell}>
          <Text style={styles.kpiTopLabel}>AUTO</Text>
          <Text style={[styles.kpiTopValue, { color: live.state.autoEnabled ? P.green : P.dim }]}>
            {live.state.autoEnabled ? "ON" : "OFF"}
          </Text>
        </View>
        <View style={styles.kpiTopDivider} />
        <View style={styles.kpiTopCell}>
          <Text style={styles.kpiTopLabel}>PnL TODAY</Text>
          <Text style={[styles.kpiTopValue, { color: live.dailyPnl >= 0 ? P.green : P.error }]}>
            {live.dailyPnl >= 0 ? "+" : ""}${live.dailyPnl.toFixed(2)}
          </Text>
        </View>
      </View>

      {/* Secondary KPIs — pill row scroll horizontal, info phụ */}
      <View style={styles.statusRow}>
        <BigPill label="OPEN" value={`${live.openCount}/${live.state.settings.maxOpen}`} color={P.text} />
        <BigPill label="TRACKED" value={`${live.state.trackedPositions.length}`} color={P.tertiary} />
        <BigPill label="PENDING" value={`${live.state.pendingAlerts.length}`} color={P.bitcoinOrange} />
        {wallet !== null && (
          <BigPill label="WALLET" value={`$${wallet.toFixed(2)}`} color={P.bitcoinOrange} />
        )}
        {avail !== null && (
          <BigPill label="AVAIL" value={`$${avail.toFixed(2)}`} color={P.dim} />
        )}
        {upnl !== null && (
          <BigPill label="uPnL" value={`${upnl >= 0 ? "+" : ""}$${upnl.toFixed(2)}`} color={upnl >= 0 ? P.green : P.error} />
        )}
        {/* Peak equity + current DD% (anh Tommy v4.6.9 Equity DD protection) */}
        {live.state.peakEquityUsd && live.state.peakEquityUsd > 0 && wallet !== null && upnl !== null && (() => {
          const cur = wallet + upnl;
          const ddPct = ((live.state.peakEquityUsd - cur) / live.state.peakEquityUsd) * 100;
          const ddColor = ddPct >= live.state.settings.equityDdPausePct ? P.error : ddPct >= live.state.settings.equityDdPausePct * 0.7 ? P.bitcoinOrange : P.dim;
          return (
            <>
              <BigPill label="PEAK EQ" value={`$${live.state.peakEquityUsd.toFixed(2)}`} color={P.tertiary} />
              <BigPill label="CUR DD%" value={`-${ddPct.toFixed(1)}%`} color={ddColor} />
            </>
          );
        })()}
        {isPaused && (
          <BigPill label={live.state.pauseReason === "equity-dd" ? "DD-PAUSED" : "PAUSED"} value={`${cooldownLeftM}m`} color={live.state.pauseReason === "equity-dd" ? P.error : P.bitcoinOrange} />
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
  const isFollower = live.role === "FOLLOWER";
  // v4.8.2 (anh Tommy): SERVER OWNS TRADING — LIVE tab read-only
  const SERVER_OWNS = true;
  const canControl = !isFollower && !SERVER_OWNS;
  return (
    <CollapsibleCard storageKey="@live_card_controls" icon="bolt" title={`CONTROLS${SERVER_OWNS ? " · 🔒 SERVER OWNS" : isFollower ? " · READ-ONLY (FOLLOWER)" : ""}`}>
      {SERVER_OWNS && (
        <View style={{ backgroundColor: P.error + "12", borderWidth: 1, borderColor: P.error + "55", padding: 10, borderRadius: 4, marginBottom: 8 }}>
          <Text style={{ color: P.error, fontFamily: "monospace", fontWeight: "800", fontSize: 12, marginBottom: 4 }}>
            🔒 LIVE TAB DEPRECATED — SERVER controls trading
          </Text>
          <Text style={{ color: P.text, fontFamily: "monospace", fontSize: 10, lineHeight: 14 }}>
            Cloud server (https://tommybtc.duckdns.org) đang own Binance API + auto-trade 24/7.
            {"\n"}LIVE tab này chỉ READ-ONLY. Mọi action (close, edit TP/SL, settings) phải dùng tab SERVER.
            {"\n"}Bật cả 2 cùng lúc → DUPLICATE entry + lệch state.
          </Text>
        </View>
      )}
      {isFollower && !SERVER_OWNS && (
        <Text style={[styles.warn, { color: P.bitcoinOrange }]}>
          🔒 Bạn đang ở FOLLOWER mode — KHÔNG được bật AUTO / đổi DRY/REAL / reset / clear / close.
          Bấm CLAIM LEADER ở STATUS để takeover.
        </Text>
      )}
      <View style={styles.row}>
        <Toggle
          label={live.state.autoEnabled ? "AUTO ON" : "AUTO OFF"}
          on={live.state.autoEnabled}
          color={P.green}
          disabled={!credsSet || !canControl}
          onPress={() => live.setAutoEnabled(!live.state.autoEnabled)}
        />
        <Toggle
          label={live.state.dryRun ? "DRY RUN" : "REAL ORDERS"}
          on={!live.state.dryRun}
          color={P.green}
          solidWhenOn
          disabled={!canControl}
          onPress={() => live.setDryRun(!live.state.dryRun)}
        />
      </View>
      <Text style={styles.note}>
        💡 AUTO ON/OFF: bật/tắt engine. OFF → ignore mọi rule fire.
        {"\n"}💡 DRY RUN: chỉ giả lập, log vào HISTORY, KHÔNG gửi lên Binance.
        {"\n"}💡 REAL ORDERS (xanh): gửi MARKET + TP + SL thật, ăn tiền thật.
      </Text>
      {!live.state.dryRun && canControl && (
        <Text style={styles.warn}>🟢 REAL MODE — lệnh sẽ vào Binance bằng tiền thật.</Text>
      )}
      {!credsSet && canControl && (
        <Text style={styles.note}>Nhập API key trước khi bật AUTO.</Text>
      )}
      <View style={styles.row}>
        {isPaused && canControl && (
          <TouchableOpacity onPress={live.resetCooldown} style={styles.btnGhost}>
            <Text style={styles.btnGhostText}>RESET COOLDOWN</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity onPress={live.pullFromRemote} style={styles.btnGhost}>
          <Text style={styles.btnGhostText}>PULL FROM GIT</Text>
        </TouchableOpacity>
        {/* TEST CONNECTION cho phép cả follower (chỉ verify key, không vào lệnh) */}
        <TouchableOpacity onPress={live.testNow} style={styles.btnGhost}>
          <Text style={styles.btnGhostText}>TEST CONNECTION</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.note}>
        💡 RESET COOLDOWN: bỏ qua pause sau daily-cap, resume ngay.
        {"\n"}💡 PULL FROM GIT: pull settings + history mới nhất từ GitHub (nếu đổi ở máy khác).
        {"\n"}💡 TEST CONNECTION: gọi GET account để verify API key, hiện wallet ngay.
      </Text>
    </CollapsibleCard>
  );
}

// ── CREDENTIALS ─────────────────────────────────────────────────────────────

function CredentialsCard({ live }: Props) {
  const [keyDraft, setKeyDraft] = useState(live.state.apiKey);
  const [secretDraft, setSecretDraft] = useState(live.state.apiSecret);
  const [savedFlash, setSavedFlash] = useState(false);
  const credsSet = !!live.state.apiKey && !!live.state.apiSecret;

  async function handleSave() {
    await live.setCredentials(keyDraft.trim(), secretDraft.trim());
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 3000);
  }

  // Web-only props: cho phép PASTE (anh Tommy yêu cầu giữ paste hoạt động),
  // nhưng khi user copy/cut → clipboard chỉ chứa dấu **** (không có PAT thật).
  // Right-click menu giữ nguyên để mobile có thể paste qua context menu.
  const noCopyProps: any = {
    onCopy: (e: any) => {
      e.preventDefault?.();
      const len = (e.target?.value || "").length;
      try { e.clipboardData?.setData?.("text/plain", "*".repeat(Math.max(8, len))); } catch {}
    },
    onCut: (e: any) => {
      e.preventDefault?.();
      const len = (e.target?.value || "").length;
      try { e.clipboardData?.setData?.("text/plain", "*".repeat(Math.max(8, len))); } catch {}
    },
  };

  return (
    <CollapsibleCard storageKey="@live_card_credentials" icon="lock" title="CREDENTIALS (local only — KHÔNG sync)">
      <Text style={styles.warn}>
        ⚠️ DISABLE quyền "Withdrawal" trên API key. Chỉ enable Futures + Trading.
        {"\n"}🔒 Nhập / paste vào được, KHÔNG show / copy ra để tránh lộ key.
      </Text>
      <TextInput
        placeholder="API Key (paste vào)"
        placeholderTextColor={P.dim}
        value={keyDraft}
        onChangeText={setKeyDraft}
        style={styles.input}
        secureTextEntry={true}
        autoCapitalize="none" autoCorrect={false}
        {...noCopyProps}
      />
      <TextInput
        placeholder="API Secret (paste vào)"
        placeholderTextColor={P.dim}
        value={secretDraft}
        onChangeText={setSecretDraft}
        style={styles.input}
        secureTextEntry={true}
        autoCapitalize="none" autoCorrect={false}
        {...noCopyProps}
      />
      <View style={styles.row}>
        <TouchableOpacity onPress={handleSave} style={styles.btnPrimary}>
          <Text style={styles.btnPrimaryText}>SAVE</Text>
        </TouchableOpacity>
        {credsSet && (
          <Text style={[styles.note, { color: P.green, marginLeft: 6 }]}>✓ key đã lưu</Text>
        )}
      </View>
      {live.role === "FOLLOWER" && (
        <Text style={[styles.note, { color: P.bitcoinOrange, fontSize: 10 }]}>
          ℹ️ Bạn là FOLLOWER. Nhập key để sẵn sàng — khi anh CLAIM LEADER, app sẽ auto-trade với key này ngay.
        </Text>
      )}
      {savedFlash && (
        <Text style={[styles.note, { color: P.green, fontWeight: "700" }]}>
          ✅ Đã lưu local. Bấm TEST CONNECTION để verify.
        </Text>
      )}
      <Text style={styles.note}>
        💡 Key chỉ lưu ở máy này (AsyncStorage). KHÔNG bao giờ sync git.
        {"\n"}💡 Sang máy khác: phải nhập lại API key + secret. Nhưng SETTINGS + HISTORY thì sync (qua PULL FROM GIT).
      </Text>
    </CollapsibleCard>
  );
}

// ── SETTINGS ────────────────────────────────────────────────────────────────

function SettingsCard({ live }: Props) {
  const s = live.state.settings;
  const [draft, setDraft] = useState<LiveSettings>(s);
  const livePresetKey = useActivePreset();
  const livePreset = PRESETS[livePresetKey];
  // Track whether user has unsaved edits — if dirty, do NOT clobber with incoming `s`
  // (would overwrite their input when gist sync arrives mid-edit).
  const [dirty, setDirty] = useState(false);
  React.useEffect(() => {
    if (!dirty) setDraft(s);
  }, [s, dirty]);

  function field<K extends keyof LiveSettings>(key: K, value: LiveSettings[K]) {
    setDirty(true);
    setDraft((d) => ({ ...d, [key]: value }));
  }

  function commit() {
    live.setSettings(draft);
    setDirty(false);
  }

  function toggleTf(tf: string) {
    setDirty(true);
    setDraft((d) => {
      const exists = d.excludedTfs.includes(tf);
      const nextExcluded = exists ? d.excludedTfs.filter((x) => x !== tf) : [...d.excludedTfs, tf];
      // MUTEX 1-chiều (anh Tommy v4.7.11): khi user enable 5m rule (remove "5m" khỏi excludedTfs),
      // và 5m ALL Engine đang ON → auto OFF engine để tránh 2 nguồn signal cùng cây 5m.
      const next = { ...d, excludedTfs: nextExcluded };
      if (tf === "5m" && exists && d.use5mAllEngineMode) {
        // Removed "5m" from excluded → 5m rule sẽ ON → tắt engine
        next.use5mAllEngineMode = false;
      }
      return next;
    });
  }

  /** Toggle 5m ALL Engine — MUTEX 1-chiều với 5m rule (excludedTfs). */
  function toggle5mAllEngine() {
    const turningOn = !draft.use5mAllEngineMode;
    // Confirm dialog khi BẬT (do backtest 3y cho thấy giảm NET) — anh Tommy v4.7.25
    if (turningOn && typeof window !== "undefined") {
      const ok = window.confirm(
        "⚠️ BẬT 5m ALL Engine cho LIVE?\n\n" +
        "Backtest 3y v4.7.x cho thấy MỌI preset đều giảm hoặc âm NET vs rules-only:\n" +
        "  • BALANCED: NET -28k% (vs baseline +295k%)\n" +
        "  • WHALE: NET -13k%\n" +
        "  • TURTLE: NET +39k% (chỉ 13% baseline)\n\n" +
        "Khuyến nghị: dùng cho paper test (tab 5m ALL), KHÔNG ON ở LIVE production.\n\n" +
        "Vẫn muốn bật?"
      );
      if (!ok) return;
    }
    setDirty(true);
    setDraft((d) => {
      const next: LiveSettings = { ...d, use5mAllEngineMode: turningOn };
      // Khi bật engine → auto add "5m" vào excludedTfs (tắt 5m rule path)
      if (turningOn && !d.excludedTfs.includes("5m")) {
        next.excludedTfs = [...d.excludedTfs, "5m"];
      }
      return next;
    });
  }

  // Anh Tommy v4.7.0: Apply Best preset từ backtest 3y (PRESET B + DD Protection).
  // Backtest results: NET +937k%, MaxDD -46k%, PF 1.54 (best risk-adjusted).
  function applyBest() {
    if (typeof window !== "undefined") {
      const ok = window.confirm(
        "🚀 APPLY BEST PRESET?\n\n" +
        "Áp config tốt nhất từ backtest 3y (NET +937k%, PF 1.54, MaxDD -46k%):\n\n" +
        "• Margin $1, Leverage 100x, Max Open 100\n" +
        "• Daily cap -$50, Cooldown 4h\n" +
        "• Stack max 50/side, spacing 0, dist 0%, notional $200k\n" +
        "• LTF confirm: Stoch 20/80, S/R proximity 0.4%\n" +
        "• Equity DD Protection: drop 30% → pause 4h\n" +
        "• Excluded TFs: 5m\n\n" +
        "Override settings hiện tại. Tiếp tục?"
      );
      if (!ok) return;
    }
    const best: LiveSettings = {
      symbol: draft.symbol,
      leverage: 100,
      marginUsd: 1,
      maxOpen: 100,
      dailyLossCapUsd: -50,
      cooldownMinutes: 240,
      excludedTfs: ["5m"],
      confirmStochOsLevel: 20,
      confirmStochObLevel: 80,
      confirmSrProximityPct: 0.4,
      stackMaxPerSide: 50,
      stackPerSideSpacingMin: 0,
      stackMinEntryDistPct: 0,
      stackMaxNotionalUsd: 200000,
      equityDdPausePct: 30,
      equityDdPauseHours: 4,
      use5mAllEngineMode: false,  // user phải bật rõ ràng (v4.7.8)
      stackBetterEntryMode: "off", // v4.7.29: backtest confirm OFF tốt nhất
    };
    setDirty(true);
    setDraft(best);
  }

  const allTfs = ["5m", "15m", "1h", "4h", "1d"];

  return (
    <CollapsibleCard storageKey="@live_card_settings" icon="settings" title="SETTINGS (sync git)" defaultCollapsed>
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

      <Text style={styles.subLabel}>🎯 SMART STACK (cùng side)</Text>
      <View style={styles.fieldRow}>
        <NumField label="Max per side" value={draft.stackMaxPerSide} onChangeNum={(v) => field("stackMaxPerSide", Math.max(1, Math.round(v)))} />
        <NumField label="Spacing (phút)" value={draft.stackPerSideSpacingMin} onChangeNum={(v) => field("stackPerSideSpacingMin", Math.max(0, Math.round(v)))} />
      </View>
      <View style={styles.fieldRow}>
        <NumField label="Min entry dist (%)" value={draft.stackMinEntryDistPct} onChangeNum={(v) => field("stackMinEntryDistPct", Math.max(0, v))} step={0.05} />
        <NumField label="Max notional CÙNG side ($)" value={draft.stackMaxNotionalUsd} onChangeNum={(v) => field("stackMaxNotionalUsd", Math.max(0, Math.round(v)))} step={1000} />
      </View>
      <Text style={styles.note}>
        💡 Max notional: tổng size ($) cùng side ≤ N → chống liquidation khi nhồi nhiều lệnh small qty.
        {"\n"}   Vd: marginUsd $1 × lev 100 = notional $100/lệnh. 15 lệnh = $1500. Cap $50k thừa thoải mái.
        {"\n"}   Lưu ý: cap quá thấp sẽ block lệnh hợp lệ. 0 = tắt cap.
      </Text>
      <Text style={styles.note}>
        💡 Cho phép nhiều lệnh CÙNG side; mỗi lệnh TP/SL riêng (Plan B monitor).
        {"\n"}   App tự đóng đúng qty của lệnh khi mark price hit (Binance gộp position nhưng phần đóng đúng).
        {"\n"}💡 Spacing: tối thiểu N phút giữa 2 entry CÙNG side. 0 = tắt.
        {"\n"}💡 Min entry dist: entry mới phải xa entry gần nhất CÙNG side ≥ N% (tránh nhồi 1 vùng).
      </Text>

      {/* Better Entry section removed v4.8.18 — backtest 3y confirm OFF tốt nhất, locked. */}

      <Text style={styles.subLabel}>🛡 EQUITY DD PROTECTION (anh Tommy v4.6.9)</Text>
      <View style={styles.fieldRow}>
        <NumField label="Drop từ peak (%)" value={draft.equityDdPausePct} onChangeNum={(v) => field("equityDdPausePct", Math.max(0, Math.min(100, v)))} step={5} />
        <NumField label="Pause (giờ)" value={draft.equityDdPauseHours} onChangeNum={(v) => field("equityDdPauseHours", Math.max(0, Math.round(v)))} />
      </View>
      <Text style={styles.note}>
        💡 App track peak equity (wallet + uPnL). Khi current equity drop X% từ peak → auto pause auto-trade Y giờ.
        {"\n"}   Vd peak $100, drop 30% → equity $70 → pause 4h. Sau 4h auto resume.
        {"\n"}   0% = tắt protection (KHÔNG khuyến cáo — backtest 3y có 1 đợt DD -76k% trong 2.5 tháng đầu).
      </Text>

      <Text style={styles.subLabel}>⚡ 5m ALL ENGINE MODE (v4.7.8+)</Text>
      <View style={{
        backgroundColor: P.error + "12", borderWidth: 1, borderColor: P.error + "55",
        padding: 8, borderRadius: 4, marginBottom: 8,
      }}>
        <Text style={{ color: P.error, fontFamily: "monospace", fontWeight: "800", fontSize: 11, marginBottom: 3 }}>
          ⚠️ KHÔNG khuyến nghị ON cho LIVE production
        </Text>
        <Text style={{ color: P.text, fontFamily: "monospace", fontSize: 10, lineHeight: 14 }}>
          Backtest 3y (v4.7.x): 5m ALL Engine ON cho LIVE → mọi preset đều
          <Text style={{ color: P.error, fontWeight: "700" }}> giảm/lỗ NET vs rules-only</Text>:
          {"\n"}  • BALANCED: NET -28k% (vs Mode A +295k%)
          {"\n"}  • WHALE: NET -13k% (DD thấp nhất nhưng NET vẫn âm)
          {"\n"}  • TURTLE: NET +39k% (chỉ 13% NET của Mode A)
          {"\n"}Lý do: 149k-205k 5m candidates 3y → noisy, đẩy HTF rules ra khỏi stack/DD budget.
          {"\n"}💡 Dùng cho <Text style={{ color: P.bitcoinOrange, fontWeight: "700" }}>paper test (tab 5m ALL)</Text> thôi — KHÔNG ON ở LIVE production.
        </Text>
      </View>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <TouchableOpacity
          onPress={toggle5mAllEngine}
          style={[
            styles.tfChip,
            {
              borderColor: draft.use5mAllEngineMode ? P.green : P.dim,
              backgroundColor: draft.use5mAllEngineMode ? P.green + "22" : P.surface,
              paddingHorizontal: 14, paddingVertical: 8,
            },
          ]}
        >
          <Text style={{ color: draft.use5mAllEngineMode ? P.green : P.dim, fontFamily: "monospace", fontWeight: "800", fontSize: 11 }}>
            {draft.use5mAllEngineMode ? "✓ 5m ALL ENGINE: ON" : "○ 5m ALL ENGINE: OFF"}
          </Text>
        </TouchableOpacity>
        {draft.use5mAllEngineMode && (
          <View style={[styles.tfChip, {
            borderColor: livePreset.emoji === "🔴" ? P.error : livePreset.emoji === "🟡" ? P.bitcoinOrange : P.green,
            backgroundColor: P.surface, paddingHorizontal: 12, paddingVertical: 8,
          }]}>
            <Text style={{
              color: livePreset.emoji === "🔴" ? P.error : livePreset.emoji === "🟡" ? P.bitcoinOrange : P.green,
              fontFamily: "monospace", fontWeight: "800", fontSize: 11,
            }}>
              ⇨ Active preset: {livePreset.emoji} {livePreset.label}
            </Text>
          </View>
        )}
      </View>
      <Text style={styles.note}>
        💡 ON: mỗi cây 5m close, LIVE evaluate signal giống engine 5m ALL — Stoch K (per active preset)
        + S/R 15m fallback. Entry MARKET thật, tpPct/slPct/cooldown từ active preset
        (đồng bộ tab 5m ALL via @all5m_preset_v1).
        {"\n"}   ⇨ Đổi preset (WHALE/EAGLE/TURTLE) ở tab 5m ALL → cả paper + LIVE đều áp ngay.
        {"\n"}   Margin/leverage dùng từ LIVE settings ({draft.marginUsd} × {draft.leverage}x = ${draft.marginUsd * draft.leverage} notional/lệnh).
        {"\n"}   HTF rules (1h/4h/1d/1w) vẫn chạy SONG SONG.
        {"\n"}   ⚠️ Stack gates LIVE settings vẫn áp (max {draft.stackMaxPerSide}/side, dist {draft.stackMinEntryDistPct}%).
        {"\n"}   🔒 MUTEX 1-chiều với 5m rule (excludedTfs): bật cái này → tự động ADD "5m" vào excluded.
        {"\n"}   Tắt cả 2 OK; bật 1 trong 2 OK; KHÔNG cho phép cùng ON (tránh 2 nguồn signal trùng cây 5m).
      </Text>

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

      {live.role === "FOLLOWER" ? (
        <Text style={[styles.warn, { color: P.bitcoinOrange }]}>
          🔒 FOLLOWER read-only — settings hiện đang mirror từ leader, không sửa được. Bấm CLAIM LEADER để đổi.
        </Text>
      ) : (
        <View style={styles.row}>
          <TouchableOpacity onPress={commit} style={styles.btnPrimary}>
            <Text style={styles.btnPrimaryText}>SAVE + SYNC GIT</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={applyBest} style={[styles.btnPrimary, { backgroundColor: P.green }]}>
            <Text style={[styles.btnPrimaryText, { color: "#fff" }]}>🚀 APPLY BEST</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={live.resetSettings} style={styles.btnGhost}>
            <Text style={styles.btnGhostText}>RESET DEFAULT</Text>
          </TouchableOpacity>
        </View>
      )}
      {dirty && (
        <Text style={[styles.note, { color: P.bitcoinOrange, fontSize: 10, marginTop: 4 }]}>
          ⚠️ Có thay đổi chưa save. Bấm SAVE + SYNC GIT để áp dụng + push lên gist.
        </Text>
      )}
      <Text style={styles.note}>
        Notional/lệnh = ${(draft.marginUsd * draft.leverage).toFixed(0)} ·
        max margin lock = ${(draft.marginUsd * draft.maxOpen).toFixed(0)}
      </Text>
    </CollapsibleCard>
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

// ── TRACKED (Plan B virtual lệnh, mỗi lệnh TP/SL riêng) ──────────────────────

// v4.9.27 (anh Tommy): KHÔNG prompt password user nữa — chỉ confirm yes/no.
import { DESTRUCTIVE_PWD as DESTRUCTIVE_PASSWORD } from "../utils/serverSecrets";

/** Confirm yes/no trước destructive action. Password gửi tự động trong API. */
function requireDestructivePassword(actionLabel: string): boolean {
  if (typeof window === "undefined") return true;
  return window.confirm(`Anh có chắc muốn ${actionLabel}?`);
}

/** Compute weighted summary cho stack 1 side */
function computeSideSummary(tracked: { side: string; qty: number; entryPrice: number; tpPrice: number; slPrice: number }[], side: "LONG" | "SHORT", markPrice: number | null) {
  const list = tracked.filter((t) => t.side === side);
  if (list.length === 0) return null;
  let sumQty = 0, sumNotional = 0, sumQtyTp = 0, sumQtySl = 0;
  for (const p of list) {
    sumQty += p.qty;
    sumNotional += p.qty * p.entryPrice;
    sumQtyTp += p.qty * p.tpPrice;
    sumQtySl += p.qty * p.slPrice;
  }
  const avgEntry = sumNotional / sumQty;
  const avgTp = sumQtyTp / sumQty;
  const avgSl = sumQtySl / sumQty;
  const upnlPct = markPrice !== null
    ? ((side === "LONG" ? (markPrice - avgEntry) : (avgEntry - markPrice)) / avgEntry) * 100
    : 0;
  const upnlUsd = markPrice !== null
    ? (side === "LONG" ? (markPrice - avgEntry) : (avgEntry - markPrice)) * sumQty
    : 0;
  return { count: list.length, sumQty, sumNotional, avgEntry, avgTp, avgSl, upnlPct, upnlUsd };
}

// ── PRICE CHART + ENTRY/EXIT MARKERS (anh Tommy v4.7.19, TF chooser v4.7.21) ──
// User chọn TF (5m/15m/1h/4h) qua chip — lưu @live_chart_tf_v1.
// Last 120 cây của TF chọn. Marker compact:
//   ▲ green = LONG entry · ▼ red = SHORT entry
//   ● green = WIN exit (TP hit) · ● red = LOSS exit (SL hit)
//   Faint dash entry → exit
function LivePriceChartCard({ live, klinesByTf }: { live: UseBinanceLiveResult; klinesByTf?: Record<string, { time: number; close: number }[]> }) {
  const [tf, setTf] = useChartTf();
  const [containerW, setContainerW] = useState<number>(0);
  const bars = klinesByTf?.[tf] ?? [];
  const tracked = live.state.trackedPositions;
  const journal = live.state.journal;

  // Always render Card với onLayout để measure container thực
  return (
    <Card icon="auto_graph" title={`PRICE ${tf} + ENTRIES (${bars.length} cây)`}>
      <ChartTfPicker tf={tf} onChange={setTf} />
      <View
        style={{ width: "100%" }}
        onLayout={(e) => setContainerW(e.nativeEvent.layout.width)}
      >
        {bars.length < 2 ? (
          <Text style={{ color: P.dim, fontSize: 11, fontFamily: "monospace", padding: 12 }}>
            chưa có data {tf} — chờ Binance load
          </Text>
        ) : containerW === 0 ? (
          <View style={{ height: 240 }} />  /* wait for layout */
        ) : (
          <ChartInner
            bars={bars} tracked={tracked} journal={journal}
            width={containerW} height={240}
          />
        )}
      </View>
    </Card>
  );
}

function ChartInner({ bars, tracked, journal, width, height }: {
  bars: { time: number; close: number }[];
  tracked: UseBinanceLiveResult["state"]["trackedPositions"];
  journal: UseBinanceLiveResult["state"]["journal"];
  width: number; height: number;
}) {
  const maxBars = 120;
  let slice = bars.slice(-maxBars);
  // Extend window để include all OPEN positions (anh Tommy v4.7.23)
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
  // Price range: include all bar closes + ALL tracked entry/tp/sl (anh Tommy v4.7.23)
  const pricePoints: number[] = slice.map((b) => b.close);
  for (const t of tracked) {
    pricePoints.push(t.entryPrice, t.tpPrice, t.slPrice);
  }
  const pMin = Math.min(...pricePoints);
  const pMax = Math.max(...pricePoints);
  const pRange = pMax - pMin || 1;
  const pad = 8;
  const w = width - pad * 2;
  const h = height - pad * 2;
  // Clamp x position để markers ngoài window vẫn hiện ở edge
  const xOf = (t: number) => {
    if (t < tMin) return pad;
    if (t > tMax) return width - pad;
    return pad + ((t - tMin) / range) * w;
  };
  const yOf = (p: number) => pad + h - ((p - pMin) / pRange) * h;
  const pricePts = slice.map((b) => `${xOf(b.time).toFixed(1)},${yOf(b.close).toFixed(1)}`).join(" ");

  // SHOW ALL tracked positions (no filter — clamp to edge nếu ngoài window)
  const allOpen = tracked;
  const olderCount = tracked.filter((t) => t.entryMs < tMin).length;

  // CLOSE entries from journal (no filter — clamp to edge)
  const closes_ = journal.filter((j) => j.action.kind === "CLOSE");
  type CloseMark = { side: "LONG" | "SHORT"; closePrice: number; closeMs: number; entryPrice?: number; entryMs?: number; trigger: "TP" | "SL" };
  const closeMarks: CloseMark[] = closes_.slice(-50).map((j) => {  // last 50 closes max
    const a: any = j.action;
    const matchEntry = journal.slice().reverse().find((e) => e.action.kind === "ENTRY" && e.ruleId === j.ruleId && e.ts < j.ts);
    const ea: any = matchEntry?.action;
    return {
      side: a.side,
      closePrice: a.closePrice,
      closeMs: j.ts,
      entryPrice: ea?.entryPrice,
      entryMs: matchEntry?.ts,
      trigger: a.trigger,
    };
  });

  return (
      <View style={{ width, height, backgroundColor: P.surface, borderRadius: 2, borderWidth: 1, borderColor: P.borderSoft }}>
        <Svg width={width} height={height}>
          <Polyline points={pricePts} fill="none" stroke={P.bitcoinOrange} strokeWidth={1.4} opacity={0.85} />
          {/* OPEN tracked entries — triangle markers (clamped to edge if older than window) */}
          {allOpen.map((p) => {
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
          {/* CLOSE markers — circles */}
          {closeMarks.map((c, i) => {
            const cX = xOf(c.closeMs);
            const cY = yOf(c.closePrice);
            const win = c.trigger === "TP";
            const dotColor = win ? P.green : P.error;
            const lineEl = c.entryPrice && c.entryMs ? (
              <SvgLine
                x1={xOf(c.entryMs)} y1={yOf(c.entryPrice)} x2={cX} y2={cY}
                stroke={dotColor} strokeWidth={0.5} strokeDasharray="2,2" opacity={0.4}
              />
            ) : null;
            return (
              <React.Fragment key={`close-${i}`}>
                {lineEl}
                <Circle cx={cX} cy={cY} r={4} fill={dotColor} opacity={1} stroke={P.surface} strokeWidth={0.5} />
              </React.Fragment>
            );
          })}
        </Svg>
        <View style={{ position: "absolute", top: 4, left: 8, flexDirection: "row", gap: 12, flexWrap: "wrap" }}>
          <Text style={{ color: P.dim, fontSize: 9, fontFamily: "monospace" }}>${pMax.toFixed(0)}</Text>
          <Text style={{ color: P.green, fontSize: 9, fontFamily: "monospace" }}>▲ LONG  ● TP</Text>
          <Text style={{ color: P.error, fontSize: 9, fontFamily: "monospace" }}>▼ SHORT  ● SL</Text>
        </View>
        <Text style={{ position: "absolute", bottom: 2, left: 8, color: P.dim, fontSize: 9, fontFamily: "monospace" }}>
          ${pMin.toFixed(0)} · {tracked.length} open ({olderCount > 0 ? `${olderCount} clamped left ◀ ` : ""}) · {closeMarks.length} closed · window {((tMax - tMin) / 3600000).toFixed(1)}h
        </Text>
      </View>
  );
}

function TrackedPositionsCard({ live }: Props) {
  const tracked = live.state.trackedPositions;
  const cfg = live.state.settings;
  const isFollower = live.role === "FOLLOWER";
  const longCount = tracked.filter((t) => t.side === "LONG").length;
  const shortCount = tracked.filter((t) => t.side === "SHORT").length;
  const markPrice = (() => {
    const p = live.positions.find((x) => x.symbol === cfg.symbol);
    return p ? parseFloat(p.markPrice) : null;
  })();
  const longSummary = computeSideSummary(tracked, "LONG", markPrice);
  const shortSummary = computeSideSummary(tracked, "SHORT", markPrice);
  const handleClose = (id: string, side: string, entry: number) => {
    if (!requireDestructivePassword(`CLOSE ${side} @$${entry.toFixed(0)}`)) return;
    if (typeof window !== "undefined") {
      const ok = window.confirm(`Close ${side} @${entry.toFixed(0)} ngay tại $${markPrice?.toFixed(0) ?? "?"}? (sẽ gửi MARKET reduceOnly lên Binance)`);
      if (!ok) return;
    }
    live.closeTracked(id);
  };
  const handleEditTpSl = (id: string, side: "LONG" | "SHORT", entry: number, tp: number, sl: number) => {
    if (typeof window === "undefined") return;
    const newTpStr = window.prompt(`✏️ Edit TP cho ${side} entry $${entry.toFixed(1)}\nTP hiện tại: $${tp.toFixed(1)}\nNhập giá TP mới (Enter trống = giữ nguyên):`, tp.toFixed(1));
    if (newTpStr === null) return;
    const newSlStr = window.prompt(`✏️ Edit SL cho ${side} entry $${entry.toFixed(1)}\nSL hiện tại: $${sl.toFixed(1)}\nNhập giá SL mới (Enter trống = giữ nguyên):`, sl.toFixed(1));
    if (newSlStr === null) return;
    const newTp = newTpStr.trim() === "" ? undefined : parseFloat(newTpStr);
    const newSl = newSlStr.trim() === "" ? undefined : parseFloat(newSlStr);
    if (newTp !== undefined && (!Number.isFinite(newTp) || newTp <= 0)) { window.alert("❌ TP không hợp lệ."); return; }
    if (newSl !== undefined && (!Number.isFinite(newSl) || newSl <= 0)) { window.alert("❌ SL không hợp lệ."); return; }
    // Validation side-aware
    if (side === "LONG") {
      if (newTp !== undefined && newTp <= entry) { window.alert("❌ LONG: TP phải > entry"); return; }
      if (newSl !== undefined && newSl >= entry) { window.alert("❌ LONG: SL phải < entry"); return; }
    } else {
      if (newTp !== undefined && newTp >= entry) { window.alert("❌ SHORT: TP phải < entry"); return; }
      if (newSl !== undefined && newSl <= entry) { window.alert("❌ SHORT: SL phải > entry"); return; }
    }
    if (newTp === undefined && newSl === undefined) return;
    if (!requireDestructivePassword(`EDIT TP/SL ${side}`)) return;
    live.updateTrackedTpSl(id, newTp, newSl);
  };
  const handleBulkClose = async (filter: "ALL" | "PROFIT" | "LOSS" | "OLD_HOURS") => {
    const labels = { ALL: "TẤT CẢ lệnh", PROFIT: "lệnh đang LỜI", LOSS: "lệnh đang LỖ", OLD_HOURS: "lệnh giữ > 24h" };
    const label = labels[filter];
    if (typeof window !== "undefined") {
      const ok = window.confirm(`⚠️ BULK CLOSE ${label}?\n\nSẽ gửi MARKET reduceOnly cho từng lệnh khớp filter. Không thể undo.`);
      if (!ok) return;
    }
    if (!requireDestructivePassword(`BULK CLOSE ${label}`)) return;
    const r = await live.closeTrackedBulk(filter, 24);
    if (typeof window !== "undefined") window.alert(`✅ Bulk close done: ${r.closed} closed, ${r.errors} errors.`);
  };
  // Sort: newest first
  const sorted = tracked.slice().sort((a, b) => b.entryMs - a.entryMs);
  // Column widths (px) — total ~920, scroll ngang trên mobile
  const cols = {
    stt: 32, side: 56, rule: 110, entry: 80, qty: 80, tp: 140, sl: 140, held: 56, upnl: 70, action: 130,
  };
  return (
    <Card icon="track_changes" title={`SMART STACK · ${longCount}/${cfg.stackMaxPerSide} LONG · ${shortCount}/${cfg.stackMaxPerSide} SHORT`}>
      <Text style={styles.note}>
        Mỗi virtual lệnh có entry/TP/SL/qty riêng. App tự đóng đúng qty của lệnh khi mark price hit (Plan B).
        {"\n"}⚠️ CHỈ count lệnh APP MỞ qua rule. Lệnh anh tự đặt trên Binance (manual) KHÔNG hiện ở đây.
        {"\n"}🔒 CLOSE / EDIT TP-SL / BULK CLOSE đều cần mã xác nhận trước khi gửi Binance.
      </Text>

      {/* STACK SUMMARY (per side) — anh Tommy v4.7.5 */}
      {(longSummary || shortSummary) && (
        <View style={styles.stackSummaryWrap}>
          {longSummary && (
            <View style={[styles.stackSummary, { borderColor: P.green + "55" }]}>
              <Text style={[styles.stackSummaryTitle, { color: P.green }]}>📊 LONG · {longSummary.count} lệnh</Text>
              <Text style={styles.stackSummaryLine}>
                avg entry <Text style={styles.stackSummaryNum}>${longSummary.avgEntry.toFixed(1)}</Text>
                {"  "}· total <Text style={styles.stackSummaryNum}>${longSummary.sumNotional.toFixed(0)}</Text>
              </Text>
              <Text style={styles.stackSummaryLine}>
                avg TP <Text style={[styles.stackSummaryNum, { color: P.green }]}>${longSummary.avgTp.toFixed(1)}</Text>
                {"  "}· avg SL <Text style={[styles.stackSummaryNum, { color: P.error }]}>${longSummary.avgSl.toFixed(1)}</Text>
              </Text>
              <Text style={styles.stackSummaryLine}>
                uPnL <Text style={[styles.stackSummaryNum, { color: longSummary.upnlPct >= 0 ? P.green : P.error }]}>
                  {longSummary.upnlPct >= 0 ? "+" : ""}{longSummary.upnlPct.toFixed(2)}% (${longSummary.upnlUsd.toFixed(2)})
                </Text>
              </Text>
            </View>
          )}
          {shortSummary && (
            <View style={[styles.stackSummary, { borderColor: P.error + "55" }]}>
              <Text style={[styles.stackSummaryTitle, { color: P.error }]}>📊 SHORT · {shortSummary.count} lệnh</Text>
              <Text style={styles.stackSummaryLine}>
                avg entry <Text style={styles.stackSummaryNum}>${shortSummary.avgEntry.toFixed(1)}</Text>
                {"  "}· total <Text style={styles.stackSummaryNum}>${shortSummary.sumNotional.toFixed(0)}</Text>
              </Text>
              <Text style={styles.stackSummaryLine}>
                avg TP <Text style={[styles.stackSummaryNum, { color: P.green }]}>${shortSummary.avgTp.toFixed(1)}</Text>
                {"  "}· avg SL <Text style={[styles.stackSummaryNum, { color: P.error }]}>${shortSummary.avgSl.toFixed(1)}</Text>
              </Text>
              <Text style={styles.stackSummaryLine}>
                uPnL <Text style={[styles.stackSummaryNum, { color: shortSummary.upnlPct >= 0 ? P.green : P.error }]}>
                  {shortSummary.upnlPct >= 0 ? "+" : ""}{shortSummary.upnlPct.toFixed(2)}% (${shortSummary.upnlUsd.toFixed(2)})
                </Text>
              </Text>
            </View>
          )}
        </View>
      )}

      {/* BULK ACTIONS (LEADER only) — anh Tommy v4.7.5 */}
      {!isFollower && tracked.length > 0 && (
        <View style={styles.bulkRow}>
          <Text style={styles.bulkLabel}>🚀 BULK:</Text>
          <TouchableOpacity onPress={() => handleBulkClose("PROFIT")} style={[styles.bulkBtn, { borderColor: P.green }]}>
            <Text style={[styles.bulkBtnText, { color: P.green }]}>✓ CLOSE PROFIT</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => handleBulkClose("LOSS")} style={[styles.bulkBtn, { borderColor: P.error }]}>
            <Text style={[styles.bulkBtnText, { color: P.error }]}>✗ CLOSE LOSS</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => handleBulkClose("OLD_HOURS")} style={[styles.bulkBtn, { borderColor: P.bitcoinOrange }]}>
            <Text style={[styles.bulkBtnText, { color: P.bitcoinOrange }]}>⏱ CLOSE &gt;24h</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => handleBulkClose("ALL")} style={[styles.bulkBtn, { borderColor: P.error, backgroundColor: P.error + "18" }]}>
            <Text style={[styles.bulkBtnText, { color: P.error, fontWeight: "800" }]}>🔥 CLOSE ALL</Text>
          </TouchableOpacity>
        </View>
      )}
      {sorted.length === 0 ? (
        <Text style={styles.note}>Chưa có virtual lệnh nào đang theo dõi.</Text>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator>
          <View>
            {/* Header row */}
            <View style={[styles.tblRow, styles.tblHeader]}>
              <Text style={[styles.tblHeadCell, { width: cols.stt }]}>#</Text>
              <Text style={[styles.tblHeadCell, { width: cols.side }]}>SIDE</Text>
              <Text style={[styles.tblHeadCell, { width: cols.rule }]}>RULE</Text>
              <Text style={[styles.tblHeadCell, { width: cols.entry }]}>ENTRY</Text>
              <Text style={[styles.tblHeadCell, { width: cols.qty }]}>SIZE (USDT)</Text>
              <Text style={[styles.tblHeadCell, { width: cols.tp }]}>TP (dist%) ✏️</Text>
              <Text style={[styles.tblHeadCell, { width: cols.sl }]}>SL (dist%) ✏️</Text>
              <Text style={[styles.tblHeadCell, { width: cols.held }]}>HELD</Text>
              <Text style={[styles.tblHeadCell, { width: cols.upnl, textAlign: "right" }]}>uPnL</Text>
              <Text style={[styles.tblHeadCell, { width: cols.action, textAlign: "center" }]}>ACTION</Text>
            </View>
            {sorted.map((t, idx) => {
              const sideColor = t.side === "LONG" ? P.green : P.error;
              const upnlPct = markPrice !== null
                ? (t.side === "LONG" ? (markPrice - t.entryPrice) : (t.entryPrice - markPrice)) / t.entryPrice * 100
                : 0;
              const distTp = markPrice !== null ? Math.abs(t.tpPrice - markPrice) / markPrice * 100 : 0;
              const distSl = markPrice !== null ? Math.abs(t.slPrice - markPrice) / markPrice * 100 : 0;
              const heldMin = Math.floor((Date.now() - t.entryMs) / 60000);
              const heldStr = heldMin >= 60 ? `${(heldMin / 60).toFixed(1)}h` : `${heldMin}m`;
              const upnlColor = upnlPct >= 0 ? P.green : P.error;
              return (
                <View key={t.id} style={styles.tblRow}>
                  <Text style={[styles.tblCell, { width: cols.stt, color: P.dim }]}>{idx + 1}</Text>
                  <Text style={[styles.tblCell, { width: cols.side, color: sideColor, fontWeight: "800" }]}>{t.side}</Text>
                  <Text style={[styles.tblCell, { width: cols.rule, color: P.tertiary, fontWeight: "700" }]}>{t.id}</Text>
                  <Text style={[styles.tblCell, { width: cols.entry }]}>${t.entryPrice.toFixed(1)}</Text>
                  <Text style={[styles.tblCell, { width: cols.qty }]}>${(t.qty * t.entryPrice).toFixed(2)}</Text>
                  <TouchableOpacity disabled={isFollower} onPress={() => handleEditTpSl(t.id, t.side, t.entryPrice, t.tpPrice, t.slPrice)} style={{ width: cols.tp }}>
                    <Text style={[styles.tblCell, { color: P.green, textDecorationLine: isFollower ? "none" : "underline" }]}>${t.tpPrice.toFixed(1)} ({distTp.toFixed(2)}%)</Text>
                  </TouchableOpacity>
                  <TouchableOpacity disabled={isFollower} onPress={() => handleEditTpSl(t.id, t.side, t.entryPrice, t.tpPrice, t.slPrice)} style={{ width: cols.sl }}>
                    <Text style={[styles.tblCell, { color: P.error, textDecorationLine: isFollower ? "none" : "underline" }]}>${t.slPrice.toFixed(1)} ({distSl.toFixed(2)}%)</Text>
                  </TouchableOpacity>
                  <Text style={[styles.tblCell, { width: cols.held, color: P.dim }]}>{heldStr}</Text>
                  <Text style={[styles.tblCell, { width: cols.upnl, textAlign: "right", color: upnlColor, fontWeight: "700" }]}>
                    {upnlPct >= 0 ? "+" : ""}{upnlPct.toFixed(2)}%
                  </Text>
                  <View style={{ width: cols.action, alignItems: "center" }}>
                    {isFollower ? (
                      <Text style={[styles.posCellSmall, { color: P.dim, textAlign: "center" }]}>read-only</Text>
                    ) : (
                      <TouchableOpacity onPress={() => handleClose(t.id, t.side, t.entryPrice)} style={styles.btnDanger}>
                        <Text style={styles.btnDangerText}>✕ CLOSE</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                </View>
              );
            })}
          </View>
        </ScrollView>
      )}
    </Card>
  );
}

function PositionsCard({ live }: Props) {
  const open = live.positions.filter((p) => parseFloat(p.positionAmt) !== 0);
  // Pre-build TP/SL lookup từ open orders Binance (fallback nếu không có trackedPositions)
  const tpslBySide: { LONG?: { tp?: number; sl?: number }; SHORT?: { tp?: number; sl?: number } } = {};
  for (const o of live.openOrders) {
    if (!o.closePosition) continue;
    const positionSide: "LONG" | "SHORT" = o.side === "SELL" ? "LONG" : "SHORT";
    if (!tpslBySide[positionSide]) tpslBySide[positionSide] = {};
    const price = parseFloat(o.stopPrice || o.price || "0");
    if (o.type.includes("TAKE_PROFIT")) tpslBySide[positionSide]!.tp = price;
    else if (o.type.includes("STOP")) tpslBySide[positionSide]!.sl = price;
  }
  // Mobile-friendly card stacking layout
  return (
    <Card icon="location_on" title={`OPEN POSITIONS · ${open.length}`}>
      {open.length === 0 ? (
        <Text style={styles.note}>Không có position nào mở trên Binance.</Text>
      ) : (
        open.map((p, i) => {
          const amt = parseFloat(p.positionAmt);
          const entry = parseFloat(p.entryPrice);
          const mark = parseFloat(p.markPrice);
          const upnl = parseFloat(p.unRealizedProfit);
          const lev = parseInt(p.leverage, 10) || 1;
          const side: "LONG" | "SHORT" = amt > 0 ? "LONG" : "SHORT";
          const notional = Math.abs(amt) * entry;
          const margin = notional / lev;
          const roe = margin > 0 ? (upnl / margin) * 100 : 0;
          const trackedForSide = live.state.trackedPositions.filter((t) => t.side === side);
          const ruleIds = trackedForSide.map((t) => t.id).join(", ");
          const trackedTpSl = trackedForSide.length > 0
            ? { tp: trackedForSide[0].tpPrice, sl: trackedForSide[0].slPrice }
            : null;
          const tpsl = trackedTpSl ?? (tpslBySide[side] || {});
          const tpDist = tpsl.tp ? ((tpsl.tp - mark) / mark) * 100 : null;
          const slDist = tpsl.sl ? ((tpsl.sl - mark) / mark) * 100 : null;
          const ctrlBy = trackedForSide.length > 0 ? "APP" : (tpslBySide[side]?.tp || tpslBySide[side]?.sl) ? "BINANCE" : "NONE";
          const ctrlColor = ctrlBy === "APP" ? P.tertiary : ctrlBy === "BINANCE" ? P.bitcoinOrange : P.error;
          const sideColor = side === "LONG" ? P.green : P.error;
          const upnlColor = upnl >= 0 ? P.green : P.error;
          return (
            <View key={i} style={styles.itemCard}>
              <View style={styles.itemHeader}>
                <Text style={[styles.itemSide, { color: sideColor }]}>{side}</Text>
                <Text style={styles.itemRule} numberOfLines={1}>{p.symbol} · {lev}x</Text>
                <Text style={[styles.itemUpnl, { color: upnlColor }]}>
                  {upnl >= 0 ? "+" : ""}${upnl.toFixed(2)} ({roe >= 0 ? "+" : ""}{roe.toFixed(1)}%)
                </Text>
              </View>
              <View style={styles.itemDetailGrid}>
                <Detail label="ENTRY" value={`$${entry.toFixed(1)}`} />
                <Detail label="MARK" value={`$${mark.toFixed(1)}`} sub={`Δ ${(((mark - entry) / entry) * 100).toFixed(3)}%`} subColor={P.dim} />
                <Detail label="SIZE" value={`$${notional.toFixed(0)}`} sub={`${Math.abs(amt)} BTC`} subColor={P.dim} />
                <Detail label="MARGIN" value={`$${margin.toFixed(2)}`} />
                <Detail label="TP" value={tpsl.tp ? `$${tpsl.tp.toFixed(1)}` : "—"} sub={tpDist !== null ? `${tpDist >= 0 ? "+" : ""}${tpDist.toFixed(2)}%` : ""} subColor={P.green} />
                <Detail label="SL" value={tpsl.sl ? `$${tpsl.sl.toFixed(1)}` : "—"} sub={slDist !== null ? `${slDist >= 0 ? "+" : ""}${slDist.toFixed(2)}%` : ""} subColor={P.error} />
                {parseFloat(p.liquidationPrice) > 0 && (
                  <Detail label="LIQ" value={`$${parseFloat(p.liquidationPrice).toFixed(1)}`} subColor={P.bitcoinOrange} />
                )}
              </View>
              <Text style={[styles.note, { fontSize: 10, marginTop: 4, color: ctrlColor, fontWeight: "700" }]} numberOfLines={2}>
                ⚙️ TP/SL: {ctrlBy === "APP" ? `APP self-monitor (${trackedForSide.length} tracked${ruleIds ? ` · ${ruleIds}` : ""})` : ctrlBy === "BINANCE" ? "BINANCE orders" : "NONE — chưa có TP/SL!"}
              </Text>
            </View>
          );
        })
      )}
    </Card>
  );
}

/** Compact label/value cell — dùng cho mobile-friendly stacked detail grid. */
function Detail({ label, value, sub, subColor }: { label: string; value: string; sub?: string; subColor?: string }) {
  return (
    <View style={styles.detailCell}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
      {sub && <Text style={[styles.detailSub, { color: subColor || P.dim }]}>{sub}</Text>}
    </View>
  );
}

// ── OPEN ORDERS (TP/SL pending) ─────────────────────────────────────────────

function OpenOrdersCard({ live }: Props) {
  const orders = live.openOrders;
  return (
    <Card icon="list_alt" title={`OPEN ORDERS · ${orders.length}`}>
      {orders.length === 0 ? (
        <Text style={styles.note}>
          Không có order pending trên Binance.{"\n"}
          💡 App em chạy Plan B — KHÔNG đặt TP/SL trên Binance, mà tự monitor giá → gửi MARKET close khi hit. Xem TP/SL của các position đang chạy ở pill TRACKED + HISTORY.
        </Text>
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
  const [expanded, setExpanded] = useState(false);
  // Sort newest first (Binance trả oldest first), limit 50
  const trades = [...live.recentTrades].sort((a, b) => b.time - a.time).slice(0, 50);
  const renderRow = (t: typeof trades[number]) => {
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
  };
  return (
    <View style={styles.card}>
      <TouchableOpacity onPress={() => setExpanded((v) => !v)} style={styles.collapsibleHeader}>
        <Text style={styles.cardTitle}>{expanded ? "▼" : "▶"} 💱 RECENT FILLS · {trades.length}/50</Text>
      </TouchableOpacity>
      {expanded && (
        <View style={styles.cardBody}>
          {trades.length === 0
            ? <Text style={styles.note}>Chưa có fill nào trong 50 lệnh gần nhất.</Text>
            : trades.map(renderRow)}
        </View>
      )}
    </View>
  );
}

// ── HISTORY ─────────────────────────────────────────────────────────────────

function HistoryCard({ live }: Props) {
  const [filter, setFilter] = useState<"ALL" | "ENTRY" | "CLOSE" | "PENDING" | "BLOCK" | "ERROR">("ALL");
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
      else if (a.kind === "CLOSE") body = `CLOSE ${a.side} (${a.trigger}) qty ${a.qty} @ $${a.closePrice.toFixed(0)}`;
      else if (a.kind === "PENDING") body = `PENDING ${a.side} (rule HTF fire @$${a.htfEntryPrice.toFixed(0)}) — chờ Stoch5m K<20 (LONG) / K>80 (SHORT) HOẶC giá chạm S/R 15m ±0.4% mới vào lệnh`;
      else if (a.kind === "DISCARD") body = `DISCARD · ${a.reason}`;
      else if (a.kind === "BLOCK") body = `BLOCK · ${a.reason}`;
      else body = `ERROR · ${a.message}`;
      return `${dd}/${mo} ${hh}:${mi}  📌rule=${j.ruleId.padEnd(10)}  ${j.dryRun ? "[DRY] " : ""}${body}`;
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
    <Card icon="history" title={`HISTORY · ${live.state.journal.length} total`}>
      <View style={styles.row}>
        {(["ALL", "ENTRY", "CLOSE", "PENDING", "BLOCK", "ERROR"] as const).map((f) => (
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
    text = `ENTRY ${a.side} qty ${a.qty} @ $${a.entryPrice.toFixed(0)} → TP $${a.tpPrice.toFixed(0)} / SL $${a.slPrice.toFixed(0)}${a.confirmedBy ? `  ✓ ${a.confirmedBy}` : ""}`;
  } else if (a.kind === "CLOSE") {
    color = a.trigger === "TP" ? P.green : P.error;
    text = `CLOSE ${a.side} (${a.trigger}) qty ${a.qty} @ $${a.closePrice.toFixed(0)}`;
  } else if (a.kind === "PENDING") {
    color = P.tertiary;
    text = `PENDING ${a.side} — rule HTF (1h/4h) đã fire @ $${a.htfEntryPrice.toFixed(0)} (TP ${a.tpPct.toFixed(2)}% / SL ${a.slPct.toFixed(2)}%). KHÔNG vào MARKET ngay. Đang chờ 1 trong 2 điều kiện trên TF nhỏ hơn (5m/15m): (1) Stoch 5m K<20 nếu LONG / K>80 nếu SHORT, HOẶC (2) giá chạm support/resistance 15m trong ±0.4%. Đạt → mới gửi MARKET vào.`;
  } else if (a.kind === "DISCARD") {
    color = P.dim;
    text = `DISCARD · ${a.reason}`;
  } else if (a.kind === "BLOCK") {
    color = P.bitcoinOrange;
    text = `BLOCK · ${a.reason}`;
  } else {
    color = P.error;
    text = `ERROR · ${a.message}`;
  }
  return (
    <View style={styles.journalCard}>
      <View style={styles.journalHeader}>
        <Text style={styles.journalTime}>{dd}/{mm} {hh}:{mi}</Text>
        <View style={styles.journalKindPill}>
          <Text style={[styles.journalKindText, { color }]}>{a.kind}{j.dryRun && a.kind === "ENTRY" ? " [DRY]" : ""}</Text>
        </View>
        <Text style={styles.journalRule} numberOfLines={1}>📌 {j.ruleId}</Text>
      </View>
      <Text style={[styles.journalBody, { color }]}>{text}</Text>
    </View>
  );
}

// ── SHARED ──────────────────────────────────────────────────────────────────

type IconName = React.ComponentProps<typeof MaterialIcon>["name"];

function CardHeader({ icon, title }: { icon?: IconName; title: string }) {
  return (
    <View style={styles.cardHeader}>
      {icon && <MaterialIcon name={icon} size={16} color={P.bitcoinOrange} />}
      <Text style={styles.cardTitleText}>{title}</Text>
    </View>
  );
}

function Card({ title, icon, children }: { title: string; icon?: IconName; children: React.ReactNode }) {
  return (
    <View style={styles.card}>
      <View style={styles.cardTitleWrap}>
        <CardHeader icon={icon} title={title} />
      </View>
      <View style={styles.cardBody}>{children}</View>
    </View>
  );
}

/**
 * CollapsibleCard — Card có nút toggle ▼/▶, lưu trạng thái local (AsyncStorage).
 * Anh Tommy v4.5.5: dùng cho SETTINGS / CONTROLS / CREDENTIALS để hide/show + nhớ.
 */
function CollapsibleCard({
  storageKey,
  title,
  icon,
  defaultCollapsed = false,
  children,
}: {
  storageKey: string;
  title: string;
  icon?: IconName;
  defaultCollapsed?: boolean;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState<boolean>(defaultCollapsed);
  const [hydrated, setHydrated] = useState(false);
  React.useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(storageKey).then((v) => {
      if (!alive) return;
      if (v === "1") setCollapsed(true);
      else if (v === "0") setCollapsed(false);
      setHydrated(true);
    }).catch(() => setHydrated(true));
    return () => { alive = false; };
  }, [storageKey]);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    AsyncStorage.setItem(storageKey, next ? "1" : "0").catch(() => {});
  };

  return (
    <View style={styles.card}>
      <TouchableOpacity onPress={toggle} activeOpacity={0.7} style={styles.cardTitleWrap}>
        <View style={styles.cardHeader}>
          {icon && <MaterialIcon name={icon} size={16} color={P.bitcoinOrange} />}
          <Text style={styles.cardTitleText}>{title}</Text>
          <Text style={styles.cardChevron}>{collapsed ? "▶" : "▼"}</Text>
        </View>
      </TouchableOpacity>
      {!collapsed && <View style={styles.cardBody}>{children}</View>}
    </View>
  );
}

/** Stitch-style toggle (rounded switch + label). Card-style hộp với label trên + switch dưới (Stitch v4.6.0). */
function Toggle({ label, on, onPress, disabled, color, solidWhenOn }:
  { label: string; on: boolean; onPress: () => void; disabled?: boolean; color: string; solidWhenOn?: boolean }) {
  const filled = on && solidWhenOn;
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.7}
      style={[
        styles.toggleCard,
        {
          borderColor: on ? color : P.borderSoft,
          backgroundColor: filled ? color + "11" : on ? color + "08" : P.surface,
          opacity: disabled ? 0.4 : 1,
        },
      ]}
    >
      <Text style={[styles.toggleCardLabel, { color: on ? color : P.dim }]} numberOfLines={1}>
        {label}
      </Text>
      <View style={[styles.switchTrack, { backgroundColor: on ? color + "33" : P.borderSoft, borderColor: on ? color : P.border }]}>
        <View style={[styles.switchThumb, { backgroundColor: on ? color : P.dim, alignSelf: on ? "flex-end" : "flex-start" }]} />
      </View>
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
  profileRow: {
    flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 10,
    paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: P.borderSoft,
  },
  avatar: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: P.bitcoinOrange,
    alignItems: "center", justifyContent: "center",
  },
  avatarText: {
    color: "#fff", fontFamily: "monospace", fontSize: 18, fontWeight: "900",
  },
  profileLabel: { color: P.dim, fontFamily: "monospace", fontSize: 9, letterSpacing: 1 },
  profileAlias: { color: P.text, fontFamily: "monospace", fontSize: 14, fontWeight: "700", letterSpacing: 1, marginTop: 2 },
  statusRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  roleRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, marginBottom: 8 },
  roleInfo: { flex: 1, minWidth: 140 },

  // Top KPI 3-col compact (Stitch v4.6.0)
  kpiTop: {
    flexDirection: "row",
    backgroundColor: P.surface,
    borderWidth: 1,
    borderColor: P.borderSoft,
    borderRadius: 4,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginVertical: 8,
  },
  kpiTopCell: { flex: 1, alignItems: "flex-start" },
  kpiTopDivider: { width: 1, backgroundColor: P.borderSoft, marginHorizontal: 8 },
  kpiTopLabel: { color: P.dim, fontFamily: "monospace", fontSize: 9, fontWeight: "800", letterSpacing: 1.5 },
  kpiTopValue: { fontFamily: "monospace", fontSize: 16, fontWeight: "800", marginTop: 4 },
  pill: {
    backgroundColor: P.elevated, borderWidth: 1, borderColor: P.border,
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 4, minWidth: 76, alignItems: "center",
  },
  pillLabel: { color: P.dim, fontFamily: "monospace", fontSize: 9, letterSpacing: 1 },
  pillValue: { fontFamily: "monospace", fontSize: 13, fontWeight: "900", marginTop: 2 },
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

  // Stitch-style header (icon + title + optional chevron)
  cardTitleWrap: { borderBottomWidth: 1, borderBottomColor: P.borderSoft, paddingHorizontal: 10, paddingVertical: 10 },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  cardTitleText: {
    color: P.text2, fontFamily: "monospace", fontSize: 11, fontWeight: "900", letterSpacing: 1,
    flex: 1,
  },
  cardChevron: { color: P.dim, fontSize: 11, fontWeight: "700" },

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
  btnDanger: { backgroundColor: P.errorContainer, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 3, marginLeft: 6 },
  btnDangerText: { color: P.onErrorContainer, fontFamily: "monospace", fontWeight: "800", fontSize: 10, letterSpacing: 0.5 },
  // 5m ALL ENGINE MODE banner (v4.7.10)
  fiveMBanner: {
    marginHorizontal: 12, marginBottom: 8, marginTop: 4,
    padding: 10, borderRadius: 4, borderWidth: 2,
    backgroundColor: P.surface,
  },
  fiveMBannerTitle: {
    color: P.text, fontSize: 12, fontFamily: "monospace", fontWeight: "800",
    letterSpacing: 0.8, marginBottom: 3,
  },
  fiveMBannerSub: {
    color: P.dim, fontSize: 10, fontFamily: "monospace", lineHeight: 14,
  },
  // Stack summary + bulk actions (v4.7.5)
  stackSummaryWrap: { flexDirection: "row", gap: 8, marginTop: 8, marginBottom: 8, flexWrap: "wrap" },
  stackSummary: { flex: 1, minWidth: 280, padding: 8, borderRadius: 4, borderWidth: 1, backgroundColor: P.surface },
  stackSummaryTitle: { fontFamily: "monospace", fontWeight: "800", fontSize: 11, letterSpacing: 0.5, marginBottom: 4 },
  stackSummaryLine: { color: P.dim, fontFamily: "monospace", fontSize: 10, lineHeight: 14 },
  stackSummaryNum: { color: P.text, fontWeight: "700" },
  bulkRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8, marginBottom: 8, flexWrap: "wrap" },
  bulkLabel: { color: P.dim, fontFamily: "monospace", fontSize: 10, fontWeight: "800", letterSpacing: 1 },
  bulkBtn: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 3, borderWidth: 1 },
  bulkBtnText: { fontFamily: "monospace", fontSize: 10, fontWeight: "700", letterSpacing: 0.5 },

  toggle: { borderWidth: 2, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 4 },
  toggleText: { fontFamily: "monospace", fontWeight: "900", fontSize: 11, letterSpacing: 1 },

  // Stitch-style toggle card (v4.6.0)
  toggleCard: {
    flex: 1, minWidth: 130,
    borderWidth: 1, borderRadius: 6,
    paddingHorizontal: 12, paddingVertical: 10,
    gap: 10,
  },
  toggleCardLabel: { fontFamily: "monospace", fontSize: 10, fontWeight: "800", letterSpacing: 1 },
  switchTrack: {
    width: 40, height: 20, borderRadius: 999,
    borderWidth: 1, padding: 2, justifyContent: "center",
  },
  switchThumb: {
    width: 14, height: 14, borderRadius: 999,
  },

  tfChip: { borderWidth: 1, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 4 },

  filterChip: { borderWidth: 1, borderColor: P.border, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 4 },
  filterChipActive: { borderColor: P.bitcoinOrange, backgroundColor: P.bitcoinOrange + "22" },
  filterText: { color: P.dim, fontFamily: "monospace", fontWeight: "700", fontSize: 10, letterSpacing: 1 },

  posCard: { borderBottomWidth: 1, borderBottomColor: P.borderSoft, paddingVertical: 6 },
  posRow: { flexDirection: "row", paddingVertical: 4, gap: 6, alignItems: "center", flexWrap: "wrap" },
  posCell: { color: P.text2, fontFamily: "monospace", fontSize: 11 },
  posCellSmall: { color: P.dim, fontFamily: "monospace", fontSize: 10 },

  histRow: { flexDirection: "row", paddingVertical: 6, gap: 8, alignItems: "flex-start", borderBottomWidth: 1, borderBottomColor: P.borderSoft, flexWrap: "wrap" },
  histTime: { color: P.dim, fontFamily: "monospace", fontSize: 10, width: 78 },
  histRule: { fontFamily: "monospace", fontSize: 10, width: 90 },
  histRulePill: {
    backgroundColor: P.bitcoinOrange + "22", borderWidth: 1, borderColor: P.bitcoinOrange,
    borderRadius: 3, paddingHorizontal: 6, paddingVertical: 2, width: 100,
  },
  histRulePillText: { color: P.bitcoinOrange, fontFamily: "monospace", fontSize: 9, fontWeight: "700", letterSpacing: 0.5 },
  histText: { fontFamily: "monospace", fontSize: 11, flex: 1, lineHeight: 16, minWidth: 200 },

  // Collapsible header — toàn bộ title chứa cả ▼/▶ icon
  collapsibleHeader: { borderBottomWidth: 0 },

  // Table-style (TrackedPositions) — header + STT, scroll ngang trên mobile
  tblRow: { flexDirection: "row", alignItems: "center", paddingVertical: 6, gap: 4, borderBottomWidth: 1, borderBottomColor: P.borderSoft },
  tblHeader: { backgroundColor: P.elevated, borderBottomColor: P.border, borderBottomWidth: 2 },
  tblHeadCell: { color: P.dim, fontFamily: "monospace", fontSize: 9, fontWeight: "800", letterSpacing: 1 },
  tblCell: { color: P.text2, fontFamily: "monospace", fontSize: 11 },

  // Mobile-friendly card layout (PositionsCard, etc)
  itemCard: { borderBottomWidth: 1, borderBottomColor: P.borderSoft, paddingVertical: 8, gap: 6 },
  itemHeader: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  itemSide: { fontFamily: "monospace", fontSize: 13, fontWeight: "900", letterSpacing: 1, minWidth: 56 },
  itemRule: { color: P.tertiary, fontFamily: "monospace", fontSize: 11, fontWeight: "700", flexShrink: 1, minWidth: 80 },
  itemUpnl: { fontFamily: "monospace", fontSize: 13, fontWeight: "800", marginLeft: "auto" },
  itemDetailGrid: { flexDirection: "row", gap: 10, flexWrap: "wrap", marginTop: 2 },
  detailCell: { minWidth: 78, paddingVertical: 2 },
  detailLabel: { color: P.dim, fontFamily: "monospace", fontSize: 9, letterSpacing: 1 },
  detailValue: { color: P.text, fontFamily: "monospace", fontSize: 12, fontWeight: "700", marginTop: 1 },
  detailSub: { fontFamily: "monospace", fontSize: 10, marginTop: 1 },

  // Mobile-friendly journal layout (HistoryCard)
  journalCard: { borderBottomWidth: 1, borderBottomColor: P.borderSoft, paddingVertical: 8, gap: 4 },
  journalHeader: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  journalTime: { color: P.dim, fontFamily: "monospace", fontSize: 10 },
  journalKindPill: { backgroundColor: P.elevated, borderRadius: 3, paddingHorizontal: 6, paddingVertical: 2, borderWidth: 1, borderColor: P.borderSoft },
  journalKindText: { fontFamily: "monospace", fontSize: 10, fontWeight: "800", letterSpacing: 0.5 },
  journalRule: { color: P.bitcoinOrange, fontFamily: "monospace", fontSize: 10, fontWeight: "700", flexShrink: 1 },
  journalBody: { fontFamily: "monospace", fontSize: 11, lineHeight: 16 },
});
