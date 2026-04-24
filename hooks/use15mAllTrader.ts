/**
 * use15mAllTrader — engine cho tab "15m All".
 *
 * - Lắng nghe nến 15m mới đóng (từ rawKlines) → tryCreatePending(barTime, closePrice)
 * - Mỗi tick price/refresh tfData:
 *     * processPending(currentPrice, stoch5mK) — fill nếu K<20 hoặc deadline
 *     * processOpen(currentPrice) — close nếu hit TP/SL
 */
import { useEffect, useRef, useState } from "react";
import {
  All15mAccount, AccountSummary, emptyAccount,
  loadAccount, processOpen, processPending, resetAccount, summarize, tryCreatePending,
} from "../utils/all15mAccount";
import { TFAnalysis, Kline, RawKlinesMap } from "./useBinanceKlines";

export interface Use15mAllTraderResult {
  account: All15mAccount;
  summary: AccountSummary;
  reset: () => Promise<void>;
  reload: () => Promise<void>;
}

export function use15mAllTrader(
  rawKlines: RawKlinesMap,
  tfData: TFAnalysis[],
  currentPrice: number | null,
  enabled: boolean,
): Use15mAllTraderResult {
  const [account, setAccount] = useState<All15mAccount>(() => emptyAccount());
  const lastBarTimeRef = useRef<number>(0);

  // Mount load
  useEffect(() => {
    if (!enabled) return;
    loadAccount().then(setAccount);
  }, [enabled]);

  // 15m new bar close → create pending
  useEffect(() => {
    if (!enabled) return;
    const klines15m: Kline[] | undefined = rawKlines["15m"];
    if (!klines15m || klines15m.length < 2) return;
    // Latest CLOSED bar = klines[klines.length - 2] (last one is in-progress)
    const closedBar = klines15m[klines15m.length - 2];
    if (!closedBar || closedBar.time === lastBarTimeRef.current) return;
    lastBarTimeRef.current = closedBar.time;
    (async () => {
      const created = await tryCreatePending(closedBar.time, closedBar.close);
      if (created) setAccount(await loadAccount());
    })();
  }, [enabled, rawKlines]);

  // Tick → process pending + open
  useEffect(() => {
    if (!enabled || currentPrice === null || currentPrice <= 0) return;
    const stoch5m = tfData.find((t) => t.key === "5m")?.stochK ?? null;
    (async () => {
      const filled = await processPending(currentPrice, stoch5m);
      const closed = await processOpen(currentPrice);
      if (filled > 0 || closed > 0) setAccount(await loadAccount());
    })();
  }, [enabled, currentPrice, tfData]);

  const reset = async () => {
    const fresh = await resetAccount();
    lastBarTimeRef.current = 0;
    setAccount(fresh);
  };
  const reload = async () => setAccount(await loadAccount());

  return { account, summary: summarize(account), reset, reload };
}
