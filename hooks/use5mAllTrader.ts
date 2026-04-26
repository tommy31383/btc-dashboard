/**
 * use5mAllTrader — engine cho tab "5m All".
 *
 * - Lắng nghe cây 5m mới đóng (rawKlines["5m"]) → gọi tryEntry5mBar
 *   với stoch5mK + S/R 15m.
 * - Mỗi tick price → processOpen để close TP/SL.
 *
 * S/R 15m: pivot rolling 50 cây gần nhất (= 12.5 giờ). Support = min low,
 * resistance = max high.
 */
import { useEffect, useRef, useState } from "react";
import {
  All5mAccount, AccountSummary, closePositionManual, emptyAccount,
  loadAccount, processOpen, pullAccountFromGist, resetAccount, summarize, tryEntry5mBar,
} from "../utils/all5mAccount";

const FOLLOWER_PULL_MS = 60 * 1000; // anh Tommy v4.5.2: 30s → 60s
import { TFAnalysis, Kline, RawKlinesMap } from "./useBinanceKlines";

const SR_LOOKBACK_15M = 50;

export interface Use5mAllTraderResult {
  account: All5mAccount;
  summary: AccountSummary;
  reset: () => Promise<void>;
  reload: () => Promise<void>;
  closeManual: (positionId: string) => Promise<void>;
}

function pivotSR(klines15m: Kline[] | undefined): { support: number | null; resistance: number | null } {
  if (!klines15m || klines15m.length < SR_LOOKBACK_15M + 1) return { support: null, resistance: null };
  // exclude in-progress bar (last)
  const closedTail = klines15m.slice(-SR_LOOKBACK_15M - 1, -1);
  let lo = Infinity, hi = -Infinity;
  for (const c of closedTail) {
    if (c.low < lo) lo = c.low;
    if (c.high > hi) hi = c.high;
  }
  return { support: lo === Infinity ? null : lo, resistance: hi === -Infinity ? null : hi };
}

export function use5mAllTrader(
  rawKlines: RawKlinesMap,
  tfData: TFAnalysis[],
  currentPrice: number | null,
  enabled: boolean,
  isLeader: boolean = true,    // anh Tommy: chỉ leader run engine + push state lên gist; follower pull mirror
): Use5mAllTraderResult {
  const [account, setAccount] = useState<All5mAccount>(() => emptyAccount());
  const lastBarTimeRef = useRef<number>(0);

  useEffect(() => {
    if (!enabled) return;
    loadAccount().then(setAccount);
  }, [enabled]);

  // 5m bar đóng → try entry — CHỈ LEADER
  useEffect(() => {
    if (!enabled || !isLeader) return;
    const klines5m: Kline[] | undefined = rawKlines["5m"];
    if (!klines5m || klines5m.length < 2) return;
    const closedBar = klines5m[klines5m.length - 2];
    if (!closedBar || closedBar.time === lastBarTimeRef.current) return;
    lastBarTimeRef.current = closedBar.time;

    const stoch5m = tfData.find((t) => t.key === "5m")?.stochK ?? null;
    const { support, resistance } = pivotSR(rawKlines["15m"]);

    (async () => {
      const created = await tryEntry5mBar(closedBar.time, closedBar.close, stoch5m, support, resistance);
      if (created) setAccount(await loadAccount());
    })();
  }, [enabled, isLeader, rawKlines, tfData]);

  // Tick → close OPEN khi hit TP/SL — CHỈ LEADER
  useEffect(() => {
    if (!enabled || !isLeader || currentPrice === null || currentPrice <= 0) return;
    (async () => {
      const closed = await processOpen(currentPrice);
      if (closed > 0) setAccount(await loadAccount());
    })();
  }, [enabled, isLeader, currentPrice]);

  // FOLLOWER: pull state mỗi 30s từ gist mirror
  useEffect(() => {
    if (!enabled || isLeader) return;
    let alive = true;
    const pull = async () => {
      if (!alive) return;
      const remote = await pullAccountFromGist();
      if (alive && remote) setAccount(remote);
    };
    pull();
    const id = setInterval(pull, FOLLOWER_PULL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [enabled, isLeader]);

  const reset = async () => {
    if (!isLeader) return; // follower không được reset
    const fresh = await resetAccount();
    lastBarTimeRef.current = 0;
    setAccount(fresh);
  };
  const reload = async () => setAccount(await loadAccount());
  const closeManual = async (positionId: string) => {
    if (!isLeader) return; // follower không được close
    if (currentPrice === null || currentPrice <= 0) return;
    const ok = await closePositionManual(positionId, currentPrice);
    if (ok) setAccount(await loadAccount());
  };

  return { account, summary: summarize(account), reset, reload, closeManual };
}
