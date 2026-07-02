import { Kline } from "../hooks/useBinanceKlines";

export interface CandlestickPoint {
  time: number; // seconds (UTCTimestamp) — lightweight-charts does NOT accept ms
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface VolumePoint {
  time: number; // seconds
  value: number;
  color: string;
}

/** Kline.time is milliseconds (Binance convention used app-wide) — lightweight-charts
 *  expects seconds. This is the ONLY place that conversion happens for the chart tab. */
export function klinesToCandlestickData(klines: Kline[]): CandlestickPoint[] {
  return klines.map((k) => ({
    time: Math.floor(k.time / 1000),
    open: k.open,
    high: k.high,
    low: k.low,
    close: k.close,
  }));
}

export function klinesToVolumeData(
  klines: Kline[],
  colors: { upColor: string; downColor: string }
): VolumePoint[] {
  return klines.map((k) => ({
    time: Math.floor(k.time / 1000),
    value: k.volume,
    color: k.close >= k.open ? colors.upColor : colors.downColor,
  }));
}
