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
  monitorTrackedPositions, addToPending, confirmPending, closeTrackedManual,
} from "../utils/liveTraderEngine";
import {
  AccountSnapshot, PositionRisk, OpenOrder, UserTrade,
  getDailyPnl, getPositions, getOpenOrders, getRecentTrades, testConnection, getDualSidePosition,
} from "../utils/binanceLive";
import { saveState as engineSaveState } from "../utils/liveTraderEngine";
import {
  LiveRole, LeaderInfo, getDeviceId, autoDeviceLabel, getLeaderInfo, pushLeader, canClaim,
  HEARTBEAT_INTERVAL_MS, LEADER_CHECK_INTERVAL_MS,
} from "../utils/leaderElection";

const POLL_MS = 30 * 1000;
const FOLLOWER_PULL_MS = 30 * 1000;     // follower pull live_trading.json mỗi 30s

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
  role: LiveRole;                    // BOOTING | LEADER | FOLLOWER
  leader: LeaderInfo | null;         // current leader info from gist
  deviceId: string;                  // mình
  lastSyncMs: number;                // lần follower pull state cuối
  claimLeadership: () => Promise<void>; // force takeover
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
  const [lastSyncMs, setLastSyncMs] = useState<number>(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const roleRef = useRef(role);
  roleRef.current = role;
  const deviceIdRef = useRef(deviceId);
  deviceIdRef.current = deviceId;
  const lastAlertSeenRef = useRef<Set<string>>(new Set());
  const deviceLabelRef = useRef<string>(autoDeviceLabel());

  // Boot: deviceId + check leader + load state
  useEffect(() => {
    (async () => {
      const myId = await getDeviceId();
      setDeviceId(myId);
      let s = await loadState();
      setState(s);
      // Check leader info trước khi merge — quyết định mode pullRemote
      const info = await getLeaderInfo();
      setLeader(info);
      const myRole: LiveRole = !info || info.deviceId === myId
        ? (info?.deviceId === myId ? "LEADER" : "BOOTING")
        : "FOLLOWER";
      try {
        s = await pullRemote(s, myRole === "FOLLOWER" ? "follower" : "boot");
        await saveState(s, { sync: false });
        setState(s);
        setLastSyncMs(Date.now());
      } catch {}
      // Default: nếu chưa có leader → tự claim
      if (!info) {
        const ok = await pushLeader(myId, deviceLabelRef.current);
        if (ok) {
          // Read-after-write verify
          const verify = await getLeaderInfo();
          setLeader(verify);
          if (verify?.deviceId === myId) setRole("LEADER");
          else setRole("FOLLOWER");
        }
      } else if (info.deviceId === myId) {
        setRole("LEADER");
      } else {
        setRole("FOLLOWER");
      }
    })();
  }, []);

  // Leader: heartbeat mỗi 15s
  useEffect(() => {
    if (role !== "LEADER" || !deviceId) return;
    let alive = true;
    const beat = async () => {
      if (!alive) return;
      await pushLeader(deviceId, deviceLabelRef.current);
    };
    const id = setInterval(beat, HEARTBEAT_INTERVAL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [role, deviceId]);

  // All devices: pull leader info mỗi 20s + auto-elect khi cần
  useEffect(() => {
    if (!deviceId) return;
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
          // Tự promote nếu leader cũ chết / chưa có leader
          const ok = await pushLeader(deviceId, deviceLabelRef.current);
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
  }, [deviceId]);

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

  // Poll Binance state every 30s when credentials present
  useEffect(() => {
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
        if (hedge !== stateRef.current.hedgeMode) {
          const next = { ...stateRef.current, hedgeMode: hedge };
          await engineSaveState(next, { sync: false });
          setState(next);
        }
        setLastError(null);
        const next = await maybeTriggerCooldown(stateRef.current, pnl);
        if (next !== stateRef.current) setState(next);
      } catch (e: any) {
        if (!alive) return;
        setLastError(e?.message ?? String(e));
      }
    }
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [state.apiKey, state.apiSecret]);

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
    role, leader, deviceId, lastSyncMs,
    async claimLeadership() {
      if (!deviceIdRef.current) return;
      const ok = await pushLeader(deviceIdRef.current, deviceLabelRef.current);
      if (!ok) {
        setLastError("❌ CLAIM LEADER fail (network / git lỗi).");
        return;
      }
      // Read-after-write verify (chống race với device khác cùng claim)
      await new Promise((r) => setTimeout(r, 1000));
      const verify = await getLeaderInfo();
      setLeader(verify);
      if (verify?.deviceId === deviceIdRef.current) {
        setRole("LEADER");
        setLastError("👑 CLAIMED LEADER — auto-trade sẽ chạy ở máy này từ giờ.");
        // Pull state mới nhất + chuyển sang chế độ leader (giữ trackedPositions từ remote)
        const merged = await pullRemote(stateRef.current, "follower");
        await saveState(merged, { sync: false });
        setState(merged);
        setLastSyncMs(Date.now());
      } else {
        setLastError(`❌ CLAIM fail — device khác (${verify?.deviceLabel}) thắng race.`);
      }
    },
    async setCredentials(apiKey, apiSecret) {
      // Credentials lưu local only → cho phép cả follower set (không sync)
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
