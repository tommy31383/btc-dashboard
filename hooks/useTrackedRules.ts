/**
 * useTrackedRules — ALL monitorable rules luôn ON.
 *
 * Tommy quyết định bỏ vụ tắt/bật từ user (v4.3.28). Mọi rule trong
 * hard_rules.json (NET PnL > 0, không bị disable) đều được theo dõi.
 * Các setter là no-op để giữ tương thích với call site cũ.
 */
import { useMemo } from "react";
import { getHardRules, isRuleMonitorable } from "../utils/hardRules";

export type TrackedRuleId = string; // "tfKey:rank"

export function makeRuleId(tfKey: string, rank: number): TrackedRuleId {
  return `${tfKey}:${rank}`;
}

export function parseRuleId(id: TrackedRuleId): { tfKey: string; rank: number } {
  const [tfKey, rankStr] = id.split(":");
  return { tfKey, rank: parseInt(rankStr, 10) };
}

export interface UseTrackedRulesResult {
  trackedIds: Set<TrackedRuleId>;
  isTracked: (id: TrackedRuleId) => boolean;
  toggle: (id: TrackedRuleId) => void;
  trackAll: (ids: TrackedRuleId[]) => void;
  untrackMany: (ids: TrackedRuleId[]) => void;
  untrackAll: () => void;
  count: number;
}

const NOOP = () => {};

export function useTrackedRules(): UseTrackedRulesResult {
  const trackedIds = useMemo(() => {
    const ids = new Set<TrackedRuleId>();
    const data = getHardRules();
    for (const tfKey of Object.keys(data.tfs)) {
      for (const rule of data.tfs[tfKey].rules) {
        if (isRuleMonitorable(rule)) ids.add(makeRuleId(tfKey, rule.rank));
      }
    }
    return ids;
  }, []);

  return {
    trackedIds,
    isTracked: () => true,
    toggle: NOOP,
    trackAll: NOOP,
    untrackMany: NOOP,
    untrackAll: NOOP,
    count: trackedIds.size,
  };
}
