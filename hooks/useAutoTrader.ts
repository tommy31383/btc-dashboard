/**
 * useAutoTrader — Auto paper-trader engine.
 *
 * Quy trình:
 *   1. Mount: pullAndMergeAccount() để sync state từ remote.
 *   2. Mỗi `activeAlerts` mới (rule fire) → tryCreatePending() tạo PENDING
 *      với limit price ±0.1%. Dedup bằng ruleId+firedAt.
 *   3. Mỗi tick `currentPrice` → processPending() + processOpen() để
 *      fill / close position theo SL/TP/timeout.
 *
 * Spec: cap 1000 USD, margin 30/lệnh, lev 100x, no concurrent limit,
 * limit 0.1% chờ tối đa 5p; xem `utils/autoAccount.ts`.
 */
import { useEffect, useRef, useState } from "react";
import { RuleAlert } from "./useRuleAlerts";
import {
  AutoAccount,
  emptyAccount,
  loadAccount,
  pullAndMergeAccount,
  tryCreatePending,
  processPending,
  processOpen,
  resetAccount,
  summarize,
  tfMs,
} from "../utils/autoAccount";

export interface UseAutoTraderResult {
  account: AutoAccount;
  summary: ReturnType<typeof summarize>;
  reset: () => Promise<void>;
  reload: () => Promise<void>;
}

export function useAutoTrader(
  activeAlerts: RuleAlert[],
  currentPrice: number | null,
): UseAutoTraderResult {
  const [account, setAccount] = useState<AutoAccount>(() => emptyAccount());
  const lastFireKeyRef = useRef<Record<string, 1>>({});

  // Mount: pull from remote + merge
  useEffect(() => {
    (async () => {
      const merged = await pullAndMergeAccount();
      setAccount(merged);
    })();
  }, []);

  // On new alerts → create PENDING positions
  useEffect(() => {
    if (activeAlerts.length === 0) return;
    (async () => {
      let created = 0;
      for (const a of activeAlerts) {
        const key = `${a.id}:${a.firedAt}`;
        if (lastFireKeyRef.current[key]) continue;
        lastFireKeyRef.current[key] = 1;

        const cfg = a.rule.config as any;
        const side = a.side === "BOTH" ? "LONG" : a.side;
        const pos = await tryCreatePending({
          ruleId: a.id,
          tfKey: a.tfKey,
          side,
          ruleEntryPrice: a.entryPrice,
          slPriceRaw: a.slPrice,
          tpPriceRaw: a.tpPrice,
          targetPct: cfg.targetPct ?? 1,
          stopPct: cfg.stopPct ?? 1,
          maxHoldBars: cfg.maxHoldBars ?? 50,
          barMs: tfMs(a.tfKey),
        });
        if (pos) created++;
      }
      if (created > 0) setAccount(await loadAccount());
    })();
  }, [activeAlerts]);

  // On price tick → process pending + open
  useEffect(() => {
    if (currentPrice === null || currentPrice <= 0) return;
    (async () => {
      const filled = await processPending(currentPrice);
      const closed = await processOpen(currentPrice);
      if (filled > 0 || closed > 0) setAccount(await loadAccount());
    })();
  }, [currentPrice]);

  const reset = async () => {
    const fresh = await resetAccount();
    lastFireKeyRef.current = {};
    setAccount(fresh);
  };

  const reload = async () => {
    setAccount(await pullAndMergeAccount());
  };

  const summary = summarize(account);
  return { account, summary, reset, reload };
}
