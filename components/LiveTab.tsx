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
import DebugLabel from "./DebugLabel";
import {
  View, Text, ScrollView, TextInput, TouchableOpacity, StyleSheet, useWindowDimensions,
} from "react-native";
import { P } from "../utils/v2Theme";
import { UseBinanceLiveResult } from "../hooks/useBinanceLive";
import { LiveSettings } from "../utils/liveTraderEngine";

/** Hard-roll password để force claim leader (anh Tommy đặt). */
const CLAIM_LEADER_PASSWORD = "30318384";

interface Props {
  live: UseBinanceLiveResult;
}

export default function LiveTab({ live }: Props) {
  const { width } = useWindowDimensions();
  const isWide = width >= 900;

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.rootContent}>
      <DebugLabel name="LiveTab" />
      <StatusBar live={live} />

      <View style={[styles.grid, isWide && styles.gridWide]}>
        <View style={[isWide && styles.col]}>
          <ControlsCard live={live} />
          <CredentialsCard live={live} />
          <SettingsCard live={live} />
        </View>
        <View style={[isWide && styles.col]}>
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
      <View style={styles.statusRow}>
        <BigPill label="MODE" value={live.state.dryRun ? "DRY" : "REAL"} color={live.state.dryRun ? P.dim : P.error} />
        <BigPill label="AUTO" value={live.state.autoEnabled ? "ON" : "OFF"} color={live.state.autoEnabled ? P.green : P.dim} />
        <BigPill label="OPEN" value={`${live.openCount}/${live.state.settings.maxOpen}`} color={P.text} />
        <BigPill label="TRACKED" value={`${live.state.trackedPositions.length}`} color={P.tertiary} />
        <BigPill label="PENDING" value={`${live.state.pendingAlerts.length}`} color={P.bitcoinOrange} />
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
  const isFollower = live.role === "FOLLOWER";
  const canControl = !isFollower; // anh Tommy: follower chỉ XEM, không bật AUTO/REAL
  return (
    <Card title={`⚡ CONTROLS${isFollower ? " · 👁 READ-ONLY (FOLLOWER)" : ""}`}>
      {isFollower && (
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
    </Card>
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
    <Card title="🔐 CREDENTIALS (local only — KHÔNG sync)">
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
    </Card>
  );
}

// ── SETTINGS ────────────────────────────────────────────────────────────────

function SettingsCard({ live }: Props) {
  const s = live.state.settings;
  const [draft, setDraft] = useState<LiveSettings>(s);
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
          <TouchableOpacity onPress={live.resetSettings} style={styles.btnGhost}>
            <Text style={styles.btnGhostText}>RESET DEFAULT</Text>
          </TouchableOpacity>
        </View>
      )}
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

// ── TRACKED (Plan B virtual lệnh, mỗi lệnh TP/SL riêng) ──────────────────────

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
  const handleClose = (id: string, side: string, entry: number) => {
    if (typeof window !== "undefined") {
      const ok = window.confirm(`Close ${side} @${entry.toFixed(0)} ngay tại $${markPrice?.toFixed(0) ?? "?"}? (sẽ gửi MARKET reduceOnly lên Binance)`);
      if (!ok) return;
    }
    live.closeTracked(id);
  };
  // Sort: newest first
  const sorted = tracked.slice().sort((a, b) => b.entryMs - a.entryMs);
  // Column widths (px) — total ~880, scroll ngang trên mobile
  const cols = {
    stt: 32, side: 56, rule: 110, entry: 80, qty: 60, tp: 130, sl: 130, held: 56, upnl: 70, action: 80,
  };
  return (
    <Card title={`🎯 SMART STACK · ${longCount}/${cfg.stackMaxPerSide} LONG · ${shortCount}/${cfg.stackMaxPerSide} SHORT`}>
      <Text style={styles.note}>
        Mỗi virtual lệnh có entry/TP/SL/qty riêng. App tự đóng đúng qty của lệnh khi mark price hit (Plan B).
        {"\n"}⚠️ CHỈ count lệnh APP MỞ qua rule. Lệnh anh tự đặt trên Binance (manual) KHÔNG hiện ở đây.
      </Text>
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
              <Text style={[styles.tblHeadCell, { width: cols.qty }]}>QTY</Text>
              <Text style={[styles.tblHeadCell, { width: cols.tp }]}>TP (dist%)</Text>
              <Text style={[styles.tblHeadCell, { width: cols.sl }]}>SL (dist%)</Text>
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
                  <Text style={[styles.tblCell, { width: cols.qty }]}>{t.qty}</Text>
                  <Text style={[styles.tblCell, { width: cols.tp, color: P.green }]}>${t.tpPrice.toFixed(1)} ({distTp.toFixed(2)}%)</Text>
                  <Text style={[styles.tblCell, { width: cols.sl, color: P.error }]}>${t.slPrice.toFixed(1)} ({distSl.toFixed(2)}%)</Text>
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
    <Card title={`📍 OPEN POSITIONS · ${open.length}`}>
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
    <Card title={`📋 OPEN ORDERS · ${orders.length}`}>
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
    <Card title={`📜 HISTORY · ${live.state.journal.length} total`}>
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

  toggle: { borderWidth: 2, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 4 },
  toggleText: { fontFamily: "monospace", fontWeight: "900", fontSize: 11, letterSpacing: 1 },

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
