import { useState, useEffect, useRef, useCallback } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { BINANCE_REST, TIMEFRAMES, TimeframeKey } from "../utils/constants";
import {
  calcRSI,
  calcStochRSI,
  calcMACD,
  calcEMA,
  calcBollinger,
  calcVolumeAnalysis,
  detectDivergence,
  calcATRPct,
  DivergenceType,
} from "../utils/indicators";

export interface Kline {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TFAnalysis {
  key: TimeframeKey;
  label: string;
  rsi: number | null;
  stochK: number | null;
  stochD: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  ema9: number | null;
  ema21: number | null;
  ema50: number | null;
  ema200: number | null;
  bollingerUpper: number | null;
  bollingerMiddle: number | null;
  bollingerLower: number | null;
  bollingerWidth: number | null;
  volumeCurrent: number;
  volumeAvg: number;
  volumeHigh: boolean;
  divergence: DivergenceType;
  lastClose: number;
  atrPct: number | null;
  emaDistPct: number | null;
}

export type RawKlinesMap = Record<string, Kline[]>;

const CACHE_KEY = "@btc_klines_cache";

function klineFingerprint(kline: Kline | undefined): string {
  if (!kline) return "0";
  return [kline.time, kline.open, kline.high, kline.low, kline.close, kline.volume].join(":");
}

function analyzeKlines(klines: Kline[], tfKey: TimeframeKey, tfLabel: string): TFAnalysis {
  const closes = klines.map((k) => k.close);
  const volumes = klines.map((k) => k.volume);
  const lastClose = closes[closes.length - 1] || 0;

  const rsi = calcRSI(closes);
  const stoch = calcStochRSI(closes);
  const macd = calcMACD(closes);
  const bollinger = calcBollinger(closes);
  const volAnalysis = calcVolumeAnalysis(volumes);
  const divergence = detectDivergence(closes);
  const ema50Value = calcEMA(closes, 50);
  const atrPct = klines.length >= 15 ? calcATRPct(klines, 14) : null;
  const emaDistPct = ema50Value !== null && ema50Value > 0
    ? ((lastClose - ema50Value) / ema50Value) * 100
    : null;

  return {
    key: tfKey,
    label: tfLabel,
    rsi,
    stochK: stoch.k,
    stochD: stoch.d,
    macd: macd.macd,
    macdSignal: macd.signal,
    macdHistogram: macd.histogram,
    ema9: calcEMA(closes, 9),
    ema21: calcEMA(closes, 21),
    ema50: ema50Value,
    ema200: calcEMA(closes, 200),
    bollingerUpper: bollinger.upper,
    bollingerMiddle: bollinger.middle,
    bollingerLower: bollinger.lower,
    bollingerWidth: bollinger.width,
    volumeCurrent: volAnalysis?.current ?? 0,
    volumeAvg: volAnalysis?.avg ?? 0,
    volumeHigh: volAnalysis?.isHigh ?? false,
    divergence,
    lastClose,
    atrPct,
    emaDistPct,
  };
}

export function useBinanceKlines(): {
  tfData: TFAnalysis[];
  rawKlines: RawKlinesMap;
  loading: boolean;
  lastUpdate: number;
  error: string | null;
  refetch: () => Promise<void>;
} {
  const [tfData, setTfData] = useState<TFAnalysis[]>([]);
  const [rawKlines, setRawKlines] = useState<RawKlinesMap>({});
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const retryCountRef = useRef(0);

  // Load cache on mount
  useEffect(() => {
    AsyncStorage.getItem(CACHE_KEY).then((val) => {
      if (val) {
        try {
          const cached = JSON.parse(val) as RawKlinesMap;
          const analyses: TFAnalysis[] = TIMEFRAMES.map((tf) => {
            const klines = cached[tf.key] || [];
            return analyzeKlines(klines, tf.key as TimeframeKey, tf.label);
          }).filter((a) => a.lastClose > 0);

          if (analyses.length > 0) {
            setRawKlines(cached);
            setTfData(analyses);
            setLoading(false);
          }
        } catch {
          // Invalid cache
        }
      }
    });
  }, []);

  const lastCandleFingerprintRef = useRef<Record<string, string>>({});
  const analysisCacheRef = useRef<Record<string, TFAnalysis>>({});

  const fetchAllKlines = useCallback(async () => {
    try {
      const results = await Promise.all(
        TIMEFRAMES.map(async (tf) => {
          const url = `${BINANCE_REST}/klines?symbol=BTCUSDT&interval=${tf.interval}&limit=${tf.limit}`;
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status} cho ${tf.label}`);
          const data = await res.json();
          return { tf, data };
        })
      );

      const newRawKlines: RawKlinesMap = {};
      const analyses: TFAnalysis[] = [];

      // Analyze one TF at a time, yielding to the UI between each so the
      // refresh spinner and touch events stay responsive on mobile.
      for (const { tf, data } of results) {
        const klines: Kline[] = data.map((k: any[]) => ({
          time: k[0],
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
        }));
        newRawKlines[tf.key] = klines;

        // Skip re-analysis only when the live candle content is unchanged.
        const fingerprint = klineFingerprint(klines[klines.length - 1]);
        const prevFingerprint = lastCandleFingerprintRef.current[tf.key] ?? "";
        const cached = analysisCacheRef.current[tf.key];
        if (fingerprint === prevFingerprint && cached) {
          analyses.push(cached);
        } else {
          const result = analyzeKlines(klines, tf.key as TimeframeKey, tf.label);
          analyses.push(result);
          analysisCacheRef.current[tf.key] = result;
          lastCandleFingerprintRef.current[tf.key] = fingerprint;
        }

        // Yield to UI thread between TFs — prevents 300-500ms jank on refresh
        await new Promise<void>((r) => setTimeout(r, 0));
      }

      setRawKlines(newRawKlines);
      setTfData(analyses);
      setLastUpdate(Date.now());
      setLoading(false);
      setError(null);
      retryCountRef.current = 0;

      // Move AsyncStorage write OFF the critical path — the spinner already
      // stopped and the UI is fully interactive by the time this runs.
      setTimeout(() => {
        try {
          AsyncStorage.setItem(CACHE_KEY, JSON.stringify(newRawKlines)).catch(() => {});
        } catch {}
      }, 200);
    } catch (e: any) {
      retryCountRef.current++;
      setError(`Lỗi tải dữ liệu: ${e.message || "Không rõ"}`);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAllKlines();
    intervalRef.current = setInterval(fetchAllKlines, 60000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchAllKlines]);

  return { tfData, rawKlines, loading, lastUpdate, error, refetch: fetchAllKlines };
}
