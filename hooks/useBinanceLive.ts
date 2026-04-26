/**
 * useBinanceLive — wire activeAlerts → liveTraderEngine + poll Binance state.
 *
 * Phase 1 (DRY RUN): mỗi alert mới → decideEntry → log vào journal.
 * Phase 2 (real): executeAction sẽ gọi Binance API thật.
 *
 * Settings + journal sync qua GitHub repo (utils/gistSync). API key/secret
 * CHỈ lưu local AsyncStorage.
 */
import { useEffect, useRef, useState } from "react";
import { RuleAlert } from "./useRuleAlerts";
import {
  LiveTraderState, LiveSettings, loadState, saveState, decideEntry, executeAction,
  maybeTriggerCooldown, AlertInput, emptyState, pullRemote, DEFAULT_SETTINGS,
  monitorTrackedPositions, addToPending, confirmPending, closeTrackedManual, reconcileTrackedPositions,
} from "../utils/liveTraderEngine";
import {
  AccountSnapshot, PositionRisk, OpenOrder, UserTrade,
  getDailyPnl, getPositions, getOpenOrders, getRecentTrades, testConnection, getDualSidePosition,
} from "../utils/binanceLive";
import { saveState as engineSaveState } from "../utils/liveTraderEngine";
import {
  LiveRole, LeaderInfo, IpLocation,
  getDeviceId, getDeviceLabel, setDeviceLabel, getLeaderInfo, pushLeader, canClaim,
  fetchIpLocation, nextHeartbeatDelayMs,
  LEADER_CHECK_INTERVAL_MS,
} from "../utils/leaderElection";
import { getGistConfig } from "../utils/gistSync";
import { ensureNotificationPermission } from "../utils/liveAlerts";

// Anh Tommy v4.5.3: tăng x2 nữa (tổng x4)
const POLL_MS = 120 * 1000;              // Binance poll 60s → 120s (2 phút)
const FOLLOWER_PULL_MS = 120 * 1000;     // follower pull 60s → 120s

export interface UseBinanceLiveResult {
  state: LiveTraderState;
  account: AccountSnapshot | null;
  positions: PositionRisk[];
  openOrders: OpenOrder[];
  recentTrades: UserTrade[];
  dailyPnl: number;
  openCount: number;
  lastError: string | null;
  // Single-leader lock
  role: LiveRole;                    // DISCONNECTED | BOOTING | LEADER | FOLLOWER
  leader: LeaderInfo | null;         // current leader info from gist
  deviceId: string;                  // mình
  deviceLabel: string;               // tên hiển thị của mình
  myIpLoc: IpLocation | null;        // IP + city/country của mình
  hasPat: boolean;                   // có GitHub Personal Access Token để sync multi-device không
  lastSyncMs: number;                // lần follower pull state cuối
  verifyLeftMs: number;              // count down verify leader claim (3s sau push)
  claimLeadership: () => Promise<void>; // force takeover
  setMyDeviceLabel: (label: string) => Promise<void>;
  recheckPat: () => Promise<void>;       // re-run election để pick up PAT mới nhập (manual)
  setCredentials: (apiKey: string, apiSecret: string) => Promise<void>;
  setAutoEnabled: (on: boolean) => Promise<void>;
  setDryRun: (on: boolean) => Promise<void>;
  setSettings: (partial: Partial<LiveSettings>) => Promise<void>;
  resetSettings: () => Promise<void>;
  resetCooldown: () => Promise<void>;
  clearJournal: () => Promise<void>;
  testNow: () => Promise<void>;
  pullFromRemote: () => Promise<void>;
  closeTracked: (positionId: string) => Promise<void>;
}

export function useBinanceLive(
  activeAlerts: RuleAlert[],
  currentPrice: number | null = null,
  ltfCtx: { stoch5m: number | null; support15m: number | null; resistance15m: number | null } = { stoch5m: null, support15m: null, resistance15m: null },
): UseBinanceLiveResult {
  const [state, setState] = useState<LiveTraderState>(() => emptyState());
  const [account, setAccount] = useState<AccountSnapshot | null>(null);
  const [positions, setPositions] = useState<PositionRisk[]>([]);
  const [openOrders, setOpenOrders] = useState<OpenOrder[]>([]);
  const [recentTrades, setRecentTrades] = useState<UserTrade[]>([]);
  const [dailyPnl, setDailyPnl] = useState(0);
  const [lastError, setLastError] = useState<string | null>(null);
  const [role, setRole] = useState<LiveRole>("BOOTING");
  const [leader, setLeader] = useState<LeaderInfo | null>(null);
  const [deviceId, setDeviceId] = useState<string>("");
  const [deviceLabel, setDeviceLabelState] = useState<string>("");
  const [myIpLoc, setMyIpLoc] = useState<IpLocation | null>(null);
  const [hasPat, setHasPat] = useState<boolean>(false);
  const [lastSyncMs, setLastSyncMs] = useState<number>(0);
  const [verifyLeftMs, setVerifyLeftMs] = useState<number>(0); // count-down verify leader claim
  const verifyDeadlineRef = useRef<number>(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const roleRef = useRef(role);
  roleRef.current = role;
  const deviceIdRef = useRef(deviceId);
  deviceIdRef.current = deviceId;
  const deviceLabelRef = useRef<string>("");
  const myIpLocRef = useRef<IpLocation | null>(null);
  myIpLocRef.current = myIpLoc;
  const lastAlertSeenRef = useRef<Set<string>>(new Set());

  /** Election logic dùng chung cho boot + sau khi setCredentials. */
  const runElection = useRef(async (myId: string, label: string) => {
    const cfg = await getGistConfig();
    setHasPat(!!cfg.pat);
    if (!cfg.pat) {
      setRole("LEADER");
      setLeader(null);
      setLastError("ℹ️ LOCAL mode — chưa có GitHub Personal Access Token (PAT) để sync giữa các device. Vào DASHBOARD → SETTINGS → GitHub PAT để nhập.");
      return;
    }
    const info = await getLeaderInfo();
    setLeader(info);
    const iAmLeader = canClaim(info, myId, Date.now());
    try {
      const merged = await pullRemote(stateRef.current, iAmLeader ? "boot" : "follower");
      await saveState(merged, { sync: false });
      setState(merged);
      setLastSyncMs(Date.now());
    } catch {}
    if (iAmLeader) {
      // Set BOOTING (verifying) trước, KHÔNG vội set LEADER → tránh hiển thị nhầm khi race
      setRole("BOOTING");
      // Request browser notification permission (chạy 1 lần trên LEADER) — không block boot
      ensureNotificationPermission().catch(() => {});
      // Push lên gist
      const ok = await pushLeader(myId, label, myIpLocRef.current);
      if (!ok) {
        // Push fail → giữ LEADER local + báo rõ lỗi (PAT thiếu quyền? Worker fail?)
        setRole("LEADER");
        const { getLeaderPushError } = await import("../utils/leaderElection");
        const err = getLeaderPushError();
        setLastError(`⚠️ PUSH LEADER FAIL: ${err || "không rõ"}\n→ Check Cloudflare Worker GH_PAT có quyền Contents:Write trên repo không. App đang chạy LOCAL mode.`);
        return;
      }
      // Count down 3s cho gist propagate (UI hiện countdown qua verifyLeftMs)
      // anh Tommy v4.5.3: 6s → 12s
      const verifyDeadline = Date.now() + 12000;
      verifyDeadlineRef.current = verifyDeadline;
      setVerifyLeftMs(12000);
      const tickId = setInterval(() => {
        const left = Math.max(0, verifyDeadline - Date.now());
        setVerifyLeftMs(left);
        if (left <= 0) clearInterval(tickId);
      }, 200);
      await new Promise((r) => setTimeout(r, 12000));
      clearInterval(tickId);
      setVerifyLeftMs(0);
      verifyDeadlineRef.current = 0;
      // Verify ai là leader thực
      const verify = await getLeaderInfo();
      setLeader(verify);
      if (verify && verify.deviceId === myId) {
        setRole("LEADER");
        setLastError(`👑 LEADER xác nhận — auto-trade chạy ở "${label}".`);
      } else {
        setRole("FOLLOWER");
        setLastError(`👁 FOLLOWER — device khác "${verify?.deviceLabel ?? "?"}" thắng race claim leader.`);
      }
    } else {
      setRole("FOLLOWER");
    }
  }).current;

  // Boot: deviceId + label + IP + load state. Election CHỈ chạy khi đã connect (có API key).
  useEffect(() => {
    (async () => {
      const myId = await getDeviceId();
      const label = await getDeviceLabel();
      deviceLabelRef.current = label;
      setDeviceId(myId);
      setDeviceLabelState(label);
      const s = await loadState();
      setState(s);
      // IP fetch background (cache 1h)
      fetchIpLocation().then((loc) => { if (loc) setMyIpLoc(loc); }).catch(() => {});
      // Anh Tommy: device chưa connect (chưa có API key) → KHÔNG tham gia leader election
      if (!s.apiKey || !s.apiSecret) {
        setRole("DISCONNECTED");
        setLeader(null);
        return;
      }
      await runElection(myId, label);
    })();
  }, []);

  // Khi credentials được nhập (transition từ DISCONNECTED → có key) → trigger election
  useEffect(() => {
    if (!deviceId) return;
    if (roleRef.current !== "DISCONNECTED") return;
    if (!state.apiKey || !state.apiSecret) return;
    runElection(deviceId, deviceLabelRef.current);
  }, [deviceId, state.apiKey, state.apiSecret]);

  // Auto-poll PAT mỗi 30s nếu đang LOCAL mode (LEADER + chưa có PAT) → khi user nhập PAT
  // ở DASHBOARD → tự động phát hiện và re-run election để chuyển sang gist sync mode.
  useEffect(() => {
    if (!deviceId) return;
    if (roleRef.current !== "LEADER" || hasPat) return;
    let alive = true;
    const id = setInterval(async () => {
      if (!alive) return;
      const cfg = await getGistConfig();
      if (cfg.pat && alive) {
        await runElection(deviceIdRef.current, deviceLabelRef.current);
      }
    }, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, [deviceId, hasPat, role]);

  // Leader: heartbeat 15s + jitter ±2s (PA B - tránh 2 device push collision)
  useEffect(() => {
    if (role !== "LEADER" || !deviceId) return;
    let alive = true;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    const scheduleNext = () => {
      if (!alive) return;
      timerId = setTimeout(async () => {
        if (!alive) return;
        await pushLeader(deviceId, deviceLabelRef.current, myIpLocRef.current);
        scheduleNext();
      }, nextHeartbeatDelayMs());
    };
    scheduleNext();
    return () => { alive = false; if (timerId) clearTimeout(timerId); };
  }, [role, deviceId]);

  // All CONNECTED devices: pull leader info mỗi 20s + auto-elect khi cần
  useEffect(() => {
    if (!deviceId) return;
    if (role === "DISCONNECTED") return;
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      const info = await getLeaderInfo();
      if (!alive) return;
      setLeader(info);
      const myRole = roleRef.current;
      const now = Date.now();
      if (canClaim(info, deviceId, now)) {
        if (myRole !== "LEADER") {
          const ok = await pushLeader(deviceId, deviceLabelRef.current, myIpLocRef.current);
          if (ok) {
            const verify = await getLeaderInfo();
            if (alive && verify?.deviceId === deviceId) {
              setRole("LEADER");
              setLeader(verify);
            }
          }
        }
      } else {
        // Có leader khác đang sống — mình phải là FOLLOWER
        if (myRole === "LEADER") {
          // Hiếm: leader bị steal → revert
          setRole("FOLLOWER");
        } else if (myRole === "BOOTING") {
          setRole("FOLLOWER");
        }
      }
    };
    const id = setInterval(tick, LEADER_CHECK_INTERVAL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [deviceId, role]);

  // Follower: pull live_trading.json mỗi 30s để mirror leader's state
  useEffect(() => {
    if (role !== "FOLLOWER") return;
    let alive = true;
    const pull = async () => {
      if (!alive) return;
      try {
        const merged = await pullRemote(stateRef.current, "follower");
        if (!alive) return;
        await saveState(merged, { sync: false });
        setState(merged);
        setLastSyncMs(Date.now());
      } catch {}
    };
    pull(); // immediate on becoming follower
    const id = setInterval(pull, FOLLOWER_PULL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [role]);

  // Subscribe activeAlerts → fire decideEntry on new ones — CHỈ LEADER
  useEffect(() => {
    if (role !== "LEADER") return;
    if (!activeAlerts.length) return;
    const seen = lastAlertSeenRef.current;
    const fresh = activeAlerts.filter((a) => {
      const key = `${a.id}@${a.firedAt}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (!fresh.length) return;

    (async () => {
      let s = stateRef.current;
      const openCount = positions.filter((p) => parseFloat(p.positionAmt) !== 0).length;
      for (const a of fresh) {
        if (a.side === "BOTH") continue;
        const tpPct = (Math.abs(a.tpPrice - a.entryPrice) / a.entryPrice) * 100;
        const slPct = (Math.abs(a.entryPrice - a.slPrice) / a.entryPrice) * 100;
        const input: AlertInput = {
          id: a.id, tfKey: a.tfKey, side: a.side,
          entryPrice: a.entryPrice, tpPrice: a.tpPrice, slPrice: a.slPrice,
          firedAt: a.firedAt, tpPct, slPct,
        };
        const action = decideEntry(s, input, { dailyPnl, openCount, nowMs: Date.now() });
        if (action.kind === "PENDING") {
          s = await executeAction(s, input, action);  // log PENDING
          s = await addToPending(s, input);
        } else {
          s = await executeAction(s, input, action);
        }
      }
      setState(s);
    })();
  }, [role, activeAlerts, dailyPnl, positions]);

  // Poll Binance state every 30s — CHỈ LEADER (follower đọc snapshot từ gist)
  useEffect(() => {
    if (role !== "LEADER") return;
    if (!state.apiKey || !state.apiSecret) return;
    let alive = true;
    const cred = { apiKey: state.apiKey, apiSecret: state.apiSecret };

    async function poll() {
      try {
        const sym = stateRef.current.settings.symbol;
        const [acc, pos, pnl, ords, trades, hedge] = await Promise.all([
          testConnection(cred),
          getPositions(cred, sym),
          getDailyPnl(cred, sym),
          getOpenOrders(cred, sym),
          getRecentTrades(cred, sym, 50),
          getDualSidePosition(cred).catch(() => stateRef.current.hedgeMode),
        ]);
        if (!alive) return;
        setAccount(acc);
        setPositions(pos);
        setDailyPnl(pnl);
        setOpenOrders(ords);
        setRecentTrades(trades);
        // Push snapshot vào state để follower mirror
        const snapshot = {
          ts: Date.now(),
          account: acc,
          positions: pos,
          openOrders: ords,
          recentTrades: trades,
          dailyPnl: pnl,
        };
        const updates: any = { binanceSnapshot: snapshot };
        if (hedge !== stateRef.current.hedgeMode) updates.hedgeMode = hedge;
        let next = { ...stateRef.current, ...updates };
        // Reconcile trackedPositions với Binance position thực tế (anh Tommy: chống stale state sau crash)
        const recon = await reconcileTrackedPositions(next, pos);
        if (recon.dropped > 0 && recon.warning) {
          setLastError(recon.warning);
        }
        next = recon.next;
        await engineSaveState(next, { sync: true });
        setState(next);
        if (recon.dropped === 0) setLastError(null);
        const next2 = await maybeTriggerCooldown(stateRef.current, pnl);
        if (next2 !== stateRef.current) setState(next2);
      } catch (e: any) {
        if (!alive) return;
        setLastError(e?.message ?? String(e));
      }
    }
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [role, state.apiKey, state.apiSecret]);

  // FOLLOWER: render từ binanceSnapshot mirrored từ gist (không poll Binance trực tiếp)
  useEffect(() => {
    if (role !== "FOLLOWER") return;
    const snap = state.binanceSnapshot;
    if (!snap) return;
    setAccount(snap.account);
    setPositions(snap.positions || []);
    setDailyPnl(snap.dailyPnl || 0);
    setOpenOrders(snap.openOrders || []);
    setRecentTrades(snap.recentTrades || []);
  }, [role, state.binanceSnapshot]);

  // Plan B: monitor TP/SL mỗi tick price — CHỈ LEADER (follower mirror state, không tự close)
  useEffect(() => {
    if (role !== "LEADER") return;
    if (currentPrice === null || currentPrice <= 0) return;
    if (!stateRef.current.trackedPositions.length) return;
    if (stateRef.current.dryRun) return;
    (async () => {
      const next = await monitorTrackedPositions(stateRef.current, currentPrice);
      if (next !== stateRef.current) setState(next);
    })();
  }, [role, currentPrice]);

  // Phase 2: confirm pending alerts mỗi tick (LTF stoch + S/R check) — CHỈ LEADER
  useEffect(() => {
    if (role !== "LEADER") return;
    if (currentPrice === null || currentPrice <= 0) return;
    if (!stateRef.current.pendingAlerts.length) return;
    const activeIds = new Set(activeAlerts.map((a) => a.id));
    const openCount = positions.filter((p) => parseFloat(p.positionAmt) !== 0).length;
    (async () => {
      const next = await confirmPending(stateRef.current, {
        currentPrice,
        stoch5m: ltfCtx.stoch5m,
        support15m: ltfCtx.support15m,
        resistance15m: ltfCtx.resistance15m,
        activeAlertIds: activeIds,
        dailyPnl,
        openCount,
      });
      if (next !== stateRef.current) setState(next);
    })();
  }, [role, currentPrice, ltfCtx.stoch5m, ltfCtx.support15m, ltfCtx.resistance15m, activeAlerts, positions, dailyPnl]);

  const openCount = positions.filter((p) => parseFloat(p.positionAmt) !== 0).length;

  /** Guard: writes vào lệnh / settings chỉ cho phép ở LEADER (tránh race multi-device). */
  function requireLeader(action: string): boolean {
    if (roleRef.current !== "LEADER") {
      setLastError(`🔒 ${action}: device này là FOLLOWER. Bấm CLAIM LEADER ở STATUS để takeover.`);
      return false;
    }
    return true;
  }

  return {
    state, account, positions, openOrders, recentTrades, dailyPnl, openCount, lastError,
    role, leader, deviceId, deviceLabel, myIpLoc, hasPat, lastSyncMs, verifyLeftMs,
    async claimLeadership() {
      if (!deviceIdRef.current) return;
      const ok = await pushLeader(deviceIdRef.current, deviceLabelRef.current, myIpLocRef.current);
      if (!ok) {
        setLastError("❌ CLAIM LEADER fail (network / git lỗi).");
        return;
      }
      await new Promise((r) => setTimeout(r, 4000)); // anh Tommy v4.5.3: 2s → 4s read-after-write
      const verify = await getLeaderInfo();
      setLeader(verify);
      if (verify?.deviceId === deviceIdRef.current) {
        setRole("LEADER");
        setLastError(`👑 CLAIMED LEADER — auto-trade chạy ở "${deviceLabelRef.current}" từ giờ.`);
        const merged = await pullRemote(stateRef.current, "follower");
        await saveState(merged, { sync: false });
        setState(merged);
        setLastSyncMs(Date.now());
      } else {
        setLastError(`❌ CLAIM fail — device khác "${verify?.deviceLabel}" thắng race.`);
      }
    },
    async setMyDeviceLabel(label: string) {
      const trimmed = label.trim() || "Unknown";
      await setDeviceLabel(trimmed);
      deviceLabelRef.current = trimmed;
      setDeviceLabelState(trimmed);
      // Nếu mình đang là leader → push update ngay để các device khác thấy tên mới
      if (roleRef.current === "LEADER") {
        await pushLeader(deviceIdRef.current, trimmed, myIpLocRef.current);
      }
    },
    async recheckPat() {
      if (!deviceIdRef.current) return;
      await runElection(deviceIdRef.current, deviceLabelRef.current);
    },
    async setCredentials(apiKey, apiSecret) {
      // Anh Tommy: follower vẫn được nhập + save API key (lưu local, sẵn sàng claim leader sau).
      // Credentials lưu local only, KHÔNG sync gist.
      const next = { ...stateRef.current, apiKey, apiSecret, leverageSetForSession: false };
      await saveState(next); setState(next);
    },
    async setAutoEnabled(on) {
      if (!requireLeader("Bật/tắt AUTO")) return;
      const next = { ...stateRef.current, autoEnabled: on };
      await saveState(next); setState(next);
    },
    async setDryRun(on) {
      if (!requireLeader("Đổi DRY/REAL")) return;
      const next = { ...stateRef.current, dryRun: on };
      await saveState(next); setState(next);
    },
    async setSettings(partial) {
      if (!requireLeader("Đổi settings")) return;
      const next = { ...stateRef.current, settings: { ...stateRef.current.settings, ...partial }, leverageSetForSession: false };
      await saveState(next); setState(next);
    },
    async resetSettings() {
      if (!requireLeader("Reset settings")) return;
      const next = { ...stateRef.current, settings: DEFAULT_SETTINGS };
      await saveState(next); setState(next);
    },
    async resetCooldown() {
      if (!requireLeader("Reset cooldown")) return;
      const next = { ...stateRef.current, pausedUntilMs: 0 };
      await saveState(next); setState(next);
    },
    async clearJournal() {
      if (!requireLeader("Clear journal")) return;
      const next = { ...stateRef.current, journal: [] };
      await saveState(next); setState(next);
    },
    async testNow() {
      const cur = stateRef.current;
      if (!cur.apiKey || !cur.apiSecret) {
        setLastError("Chưa nhập API key/secret. SAVE trước khi TEST.");
        return;
      }
      try {
        const acc = await testConnection({ apiKey: cur.apiKey, apiSecret: cur.apiSecret });
        setAccount(acc);
        setLastError(`✅ Connected · wallet $${parseFloat(acc.totalWalletBalance).toFixed(2)} · avail $${parseFloat(acc.availableBalance).toFixed(2)}`);
      } catch (e: any) {
        setLastError("❌ " + (e?.message ?? String(e)));
      }
    },
    async pullFromRemote() {
      const mode = roleRef.current === "FOLLOWER" ? "follower" : "leader";
      const merged = await pullRemote(stateRef.current, mode);
      await saveState(merged, { sync: false });
      setState(merged);
      setLastSyncMs(Date.now());
    },
    async closeTracked(positionId) {
      if (!requireLeader("Manual close")) return;
      if (currentPrice === null || currentPrice <= 0) {
        setLastError("Không có mark price để close. Refresh thử lại.");
        return;
      }
      const next = await closeTrackedManual(stateRef.current, positionId, currentPrice);
      setState(next);
    },
  };
}
