import { useState, useEffect, useMemo } from "react";
import { computeRCI, RCIResult } from "../utils/rci";
import { RawKlinesMap } from "./useBinanceKlines";

const FUNDING_URL = "https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT";
const FUNDING_POLL_MS = 5 * 60_000; // 5 min — funding chỉ đổi mỗi 8h, poll thưa

/** Fetch funding rate live + compute RCI từ klines hiện có. */
export function useRCI(rawKlines: RawKlinesMap): RCIResult {
  const [fundingRate, setFundingRate] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    const fetchFunding = async () => {
      try {
        const r = await fetch(FUNDING_URL);
        if (!r.ok) return;
        const j = await r.json();
        const fr = parseFloat(j.lastFundingRate);
        if (active && !isNaN(fr)) setFundingRate(fr);
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
    return computeRCI({
      closes4h: k4.map((k) => k.close),
      closes1h: k1.map((k) => k.close),
      klines4h: k4,
      fundingRate,
    });
  }, [rawKlines, fundingRate]);
}
