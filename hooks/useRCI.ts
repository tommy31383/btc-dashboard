import { useState, useEffect, useMemo } from "react";
import { computeRCI, RCIResult } from "../utils/rci";
import { RawKlinesMap } from "./useBinanceKlines";

// v4: fundingRate history endpoint cho current + prev (acceleration). limit=2 → [prev, current].
const FUNDING_HIST_URL = "https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=2";
const FUNDING_POLL_MS = 5 * 60_000; // 5 min — funding chỉ đổi mỗi 8h, poll thưa

interface Bar { high: number; low: number; close: number; volume: number }

/** Wilder ADX — trả 3 giá trị ADX cuối (cho slope: adx4h, prev1, prev2). v4 Group3. */
function adxLast3(bars: Bar[], period = 14): { adx: number | null; p1: number | null; p2: number | null } {
  const n = bars.length;
  if (n < period * 3) return { adx: null, p1: null, p2: null };
  const tr: number[] = [0], pdm: number[] = [0], ndm: number[] = [0];
  for (let i = 1; i < n; i++) {
    const up = bars[i].high - bars[i - 1].high;
    const dn = bars[i - 1].low - bars[i].low;
    pdm.push(up > dn && up > 0 ? up : 0);
    ndm.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close),
    ));
  }
  // Wilder smoothing
  let atr = tr.slice(1, period + 1).reduce((a, b) => a + b, 0);
  let sp = pdm.slice(1, period + 1).reduce((a, b) => a + b, 0);
  let sn = ndm.slice(1, period + 1).reduce((a, b) => a + b, 0);
  const dx: number[] = [];
  for (let i = period + 1; i < n; i++) {
    atr = atr - atr / period + tr[i];
    sp = sp - sp / period + pdm[i];
    sn = sn - sn / period + ndm[i];
    const pDI = atr > 0 ? (100 * sp) / atr : 0;
    const nDI = atr > 0 ? (100 * sn) / atr : 0;
    const sum = pDI + nDI;
    dx.push(sum > 0 ? (100 * Math.abs(pDI - nDI)) / sum : 0);
  }
  if (dx.length < period + 2) return { adx: null, p1: null, p2: null };
  // ADX = Wilder MA of DX
  const adxSeries: number[] = [];
  let adx = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  adxSeries.push(adx);
  for (let i = period; i < dx.length; i++) {
    adx = (adx * (period - 1) + dx[i]) / period;
    adxSeries.push(adx);
  }
  const L = adxSeries.length;
  return {
    adx: adxSeries[L - 1] ?? null,
    p1: adxSeries[L - 2] ?? null,
    p2: adxSeries[L - 3] ?? null,
  };
}

/** Fetch funding (current+prev) live + compute RCI v4 từ klines hiện có. */
export function useRCI(rawKlines: RawKlinesMap): RCIResult {
  const [funding, setFunding] = useState<{ cur: number | null; prev: number | null }>({ cur: null, prev: null });

  useEffect(() => {
    let active = true;
    const fetchFunding = async () => {
      try {
        const r = await fetch(FUNDING_HIST_URL);
        if (!r.ok) return;
        const arr = await r.json();
        if (!active || !Array.isArray(arr) || arr.length === 0) return;
        // arr sorted ascending by time → last = current settled, [len-2] = prev
        const cur = parseFloat(arr[arr.length - 1]?.fundingRate);
        const prev = arr.length >= 2 ? parseFloat(arr[arr.length - 2]?.fundingRate) : null;
        setFunding({ cur: isNaN(cur) ? null : cur, prev: prev !== null && !isNaN(prev) ? prev : null });
      } catch {
        // keep last known funding
      }
    };
    fetchFunding();
    const id = setInterval(fetchFunding, FUNDING_POLL_MS);
    return () => { active = false; clearInterval(id); };
  }, []);

  return useMemo(() => {
    const k4 = rawKlines["4h"] ?? [];
    const k1 = rawKlines["1h"] ?? [];
    const adx = adxLast3(k4, 14);
    return computeRCI({
      closes4h: k4.map((k) => k.close),
      closes1h: k1.map((k) => k.close),
      klines4h: k4,
      fundingRate: funding.cur,
      prevFundingRate: funding.prev,
      adx4h: adx.adx,
      adxPrev1: adx.p1,
      adxPrev2: adx.p2,
    });
  }, [rawKlines, funding]);
}
