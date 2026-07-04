import { useState, useEffect, useRef } from "react";
import { BINANCE_REST, TIMEFRAMES } from "../utils/constants";
import { Kline, RawKlinesMap } from "./useBinanceKlines";

export function parseBinanceKlineTuples(tuples: any[]): Kline[] {
  return tuples.map((k: any[]) => ({
    time: k[0],
    closeTime: typeof k[6] === "number" ? k[6] : undefined,
    isClosed: typeof k[7] === "boolean" ? k[7] : (typeof k[6] === "number" ? k[6] < Date.now() : false),
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

interface UseSymbolKlinesResult {
  rawKlines: RawKlinesMap;
  loading: boolean;
  error: string | null;
}

/**
 * Fetches klines for a single Binance symbol across all TIMEFRAMES, direct
 * from the public Binance REST API (no server proxy — that only caches
 * BTC). Intentionally separate from useBinanceKlines: that hook also feeds
 * the BTC-only rule engine (useRuleAlerts, useAlerts, useRiskRadar, etc.)
 * and must not be parameterized, to avoid any risk of an accidental
 * behavior change to live trading signals.
 *
 * symbol=null means "not fetching" (used when the chart is showing BTC,
 * which reuses the rawKlines prop from App.tsx instead of a second fetch).
 */
export function useSymbolKlines(symbol: string | null): UseSymbolKlinesResult {
  const [rawKlines, setRawKlines] = useState<RawKlinesMap>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tracks which symbol the current `rawKlines` state actually belongs to —
  // read by TradingChartTab to detect "fetch still in flight for a symbol
  // switch" vs "data is ready for the currently-selected symbol".
  const dataSymbolRef = useRef<string | null>(null);

  useEffect(() => {
    if (!symbol) {
      setRawKlines({});
      dataSymbolRef.current = null;
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;

    const fetchForSymbol = async () => {
      setLoading(true);
      try {
        const results = await Promise.all(
          TIMEFRAMES.map(async (tf) => {
            const url = `${BINANCE_REST}/klines?symbol=${symbol}&interval=${tf.interval}&limit=${tf.limit}`;
            const res = await fetch(url);
            if (res.status === 429 || res.status === 418) {
              throw new Error(`Rate limited (${res.status}) cho ${tf.label} — sẽ thử lại sau`);
            }
            if (!res.ok) throw new Error(`HTTP ${res.status} cho ${tf.label}`);
            const data = await res.json();
            return { tf, data };
          })
        );

        // Stale-response guard: a slower fetch for a symbol the user has
        // since switched away from must not overwrite newer state.
        if (cancelled) return;

        const newRawKlines: RawKlinesMap = {};
        for (const { tf, data } of results) {
          newRawKlines[tf.key] = parseBinanceKlineTuples(data);
        }

        if (cancelled) return;
        setRawKlines(newRawKlines);
        dataSymbolRef.current = symbol;
        setLoading(false);
        setError(null);
      } catch (e: any) {
        if (cancelled) return;
        setError(e.message || "Lỗi tải dữ liệu");
        setLoading(false);
      }
    };

    fetchForSymbol();
    const interval = setInterval(fetchForSymbol, 60000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [symbol]);

  // Only expose data once it actually belongs to the requested symbol —
  // prevents a caller from briefly seeing a previous symbol's candles
  // under the current symbol's label (Codex-caught P1 in the spec).
  const isDataReady = symbol !== null && dataSymbolRef.current === symbol;

  return {
    rawKlines: isDataReady ? rawKlines : {},
    loading,
    error,
  };
}
