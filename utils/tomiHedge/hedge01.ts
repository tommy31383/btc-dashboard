/**
 * rules/hedge01.ts (anh Tommy v0.4.0) — STUB rule.
 *
 * Hedge01 = INSTANCE đầu tiên chạy trên TomiHedge architecture.
 * Entry/close logic CHỜ ANH TOMMY DESIGN.
 *
 * Hiện tại: NO-OP — không fire entry, không close.
 * Khi anh Tommy design xong → fill `evalEntry` + `evalClose` với logic cụ thể.
 */
import { TomiHedgeRule, RuleContext, RuleEntrySignal, RuleCloseSignal } from "./engine";

export const hedge01: TomiHedgeRule = {
  key: "hedge01",
  name: "Hedge01",
  description: "First TomiHedge rule instance — chờ anh Tommy design entry/close",

  evalEntry(_ctx: RuleContext): RuleEntrySignal | null {
    // TODO anh Tommy design:
    //   - Detect entry signal (vd pivot, stoch, S/R, divergence...)
    //   - Return { side: "LONG" | "SHORT", notionalUsd: 77 (or dynamic) }
    //   - Return null → no entry this tick
    return null;
  },

  evalClose(_ctx: RuleContext): RuleCloseSignal | RuleCloseSignal[] | null {
    // TODO anh Tommy design:
    //   - Decide close điều kiện (vd ROI %, opposite signal, time-based, TP/SL avg-based)
    //   - Return { side, closeMode: "ALL"|"PARTIAL_USD", amount? }
    //   - Hoặc array nếu close cả 2 sides
    //   - Return null → no close this tick
    return null;
  },
};

/** Registry — em add rule mới vào đây khi anh design (Hedge02, etc.) */
export const RULES: Record<string, TomiHedgeRule> = {
  hedge01,
};

export const DEFAULT_RULE_KEY = "hedge01";

export function getRule(key: string): TomiHedgeRule {
  return RULES[key] || RULES[DEFAULT_RULE_KEY];
}

export const VALID_RULE_KEYS = Object.keys(RULES);
