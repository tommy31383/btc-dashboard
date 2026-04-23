/**
 * useTrackedRules — manages which hard rules the user is monitoring.
 *
 * Persists tracked rule IDs to AsyncStorage. A rule ID is the composite
 * "<tfKey>:<rank>" so we can uniquely identify rules across TFs.
 *
 * The app uses this to know which rules to actively check against incoming
 * candle data and fire push notifications for.
 */
import { useEffect, useState, useCallback } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getHardRules } from "../utils/hardRules";

const STORAGE_KEY = "@btc_tracked_rule_ids";
/** Sentinel value — if this key exists, user has seen the app before.
 *  First-time users get all rules auto-tracked. */
const INIT_KEY = "@btc_rules_initialized";

export type TrackedRuleId = string; // format: "15m:42"

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
  untrackAll: () => void;
  count: number;
}

export function useTrackedRules(): UseTrackedRulesResult {
  const [trackedIds, setTrackedIds] = useState<Set<TrackedRuleId>>(new Set());

  // Load on mount — first-time users get ALL rules auto-tracked
  useEffect(() => {
    (async () => {
      try {
        const [saved, initialized] = await Promise.all([
          AsyncStorage.getItem(STORAGE_KEY),
          AsyncStorage.getItem(INIT_KEY),
        ]);
        if (saved) {
          // Returning user — load saved tracked IDs
          const arr = JSON.parse(saved);
          if (Array.isArray(arr) && arr.length > 0) {
            setTrackedIds(new Set(arr));
            return;
          }
        }
        if (initialized) return; // user explicitly untracked everything
        // First-time: auto-track ALL rules
        const data = getHardRules();
        const allIds: TrackedRuleId[] = [];
        for (const tfKey of Object.keys(data.tfs)) {
          for (const rule of data.tfs[tfKey].rules) {
            allIds.push(makeRuleId(tfKey, rule.rank));
          }
        }
        if (allIds.length > 0) {
          const newSet = new Set(allIds);
          setTrackedIds(newSet);
          await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(allIds));
        }
        await AsyncStorage.setItem(INIT_KEY, "1");
      } catch {}
    })();
  }, []);

  const persist = useCallback((next: Set<TrackedRuleId>) => {
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(next))).catch(() => {});
  }, []);

  const isTracked = useCallback((id: TrackedRuleId) => trackedIds.has(id), [trackedIds]);

  const toggle = useCallback((id: TrackedRuleId) => {
    setTrackedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      persist(next);
      return next;
    });
  }, [persist]);

  const trackAll = useCallback((ids: TrackedRuleId[]) => {
    setTrackedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      persist(next);
      return next;
    });
  }, [persist]);

  const untrackAll = useCallback(() => {
    setTrackedIds(new Set());
    persist(new Set());
  }, [persist]);

  return {
    trackedIds,
    isTracked,
    toggle,
    trackAll,
    untrackAll,
    count: trackedIds.size,
  };
}
