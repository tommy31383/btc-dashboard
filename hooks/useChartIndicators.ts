import { useEffect, useRef, useState, useCallback } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  IndicatorKey,
  DEFAULT_ENABLED_INDICATORS,
  CHART_INDICATORS_STORAGE_KEY,
  parseStoredIndicators,
} from "../utils/chartIndicators";

export function useChartIndicators() {
  const [enabled, setEnabled] = useState<IndicatorKey[]>(DEFAULT_ENABLED_INDICATORS);
  // Guards against the AsyncStorage read resolving AFTER the user has
  // already toggled something: if the user interacts before hydration
  // finishes, the late-arriving stored value must NOT clobber their
  // in-flight change.
  const userInteracted = useRef(false);

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(CHART_INDICATORS_STORAGE_KEY).then((raw) => {
      if (cancelled || userInteracted.current) return;
      setEnabled(parseStoredIndicators(raw));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = useCallback((next: IndicatorKey[]) => {
    AsyncStorage.setItem(CHART_INDICATORS_STORAGE_KEY, JSON.stringify(next)).catch(() => {});
  }, []);

  const toggle = useCallback(
    (key: IndicatorKey) => {
      userInteracted.current = true;
      setEnabled((prev) => {
        const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
        persist(next);
        return next;
      });
    },
    [persist]
  );

  const reset = useCallback(() => {
    userInteracted.current = true;
    setEnabled(DEFAULT_ENABLED_INDICATORS);
    persist(DEFAULT_ENABLED_INDICATORS);
  }, [persist]);

  return { enabled, toggle, reset };
}
