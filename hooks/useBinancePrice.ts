import { useState, useEffect, useRef, useCallback } from "react";
import { BINANCE_REST, BINANCE_WS } from "../utils/constants";
import { onWsMessage } from "../utils/backendApi";

const THROTTLE_MS = 500; // Update UI max 2x per second

export interface PriceData {
  price: number;
  change24h: number;
  changePct24h: number;
  high24h: number;
  low24h: number;
  volume24h: number;
}

export interface UseBinancePriceResult {
  priceData: PriceData | null;
  priceHistory: number[];
  connectionStatus: "LIVE" | "POLLING" | "ERROR";
  error: string | null;
}

const MAX_HISTORY = 60;
const MAX_BACKOFF = 60000; // 60s max

export function useBinancePrice(): UseBinancePriceResult {
  const [priceData, setPriceData] = useState<PriceData | null>(null);
  const [priceHistory, setPriceHistory] = useState<number[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<"LIVE" | "POLLING" | "ERROR">("POLLING");
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backoffRef = useRef(2000);
  const mountedRef = useRef(true);
  const lastUpdateRef = useRef(0);
  const pendingDataRef = useRef<PriceData | null>(null);
  const throttleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushPrice = useCallback((data: PriceData) => {
    if (!mountedRef.current) return;
    setPriceData(data);
    setError(null);
    setPriceHistory((prev) => {
      const next = [...prev, data.price];
      return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
    });
    lastUpdateRef.current = Date.now();
  }, []);

  const updatePrice = useCallback((data: PriceData) => {
    if (!mountedRef.current) return;
    const now = Date.now();
    const elapsed = now - lastUpdateRef.current;

    if (elapsed >= THROTTLE_MS) {
      // Enough time passed — flush immediately
      flushPrice(data);
    } else {
      // Buffer and schedule flush
      pendingDataRef.current = data;
      if (!throttleTimerRef.current) {
        throttleTimerRef.current = setTimeout(() => {
          throttleTimerRef.current = null;
          if (pendingDataRef.current) {
            flushPrice(pendingDataRef.current);
            pendingDataRef.current = null;
          }
        }, THROTTLE_MS - elapsed);
      }
    }
  }, [flushPrice]);

  const fetchREST = useCallback(async () => {
    try {
      const res = await fetch(`${BINANCE_REST}/ticker/24hr?symbol=BTCUSDT`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      updatePrice({
        price: parseFloat(d.lastPrice),
        change24h: parseFloat(d.priceChange),
        changePct24h: parseFloat(d.priceChangePercent),
        high24h: parseFloat(d.highPrice),
        low24h: parseFloat(d.lowPrice),
        volume24h: parseFloat(d.volume),
      });
    } catch (e: any) {
      if (mountedRef.current) setError(`Lỗi kết nối REST: ${e.message || "Không rõ"}`);
    }
  }, [updatePrice]);

  const startPolling = useCallback(() => {
    if (pollRef.current) return;
    setConnectionStatus("POLLING");
    fetchREST();
    // v4.8.35 (anh Tommy Phương án A): 3s → 10s — giảm 70% Binance hit từ client.
    // WS connection là primary, REST chỉ là fallback khi WS fail/down.
    // 10s khi server WS markPrice không nuôi price; nếu có push từ server → coi là LIVE.
    pollRef.current = setInterval(fetchREST, 10000);
  }, [fetchREST]);

  // v4.8.35 (anh Tommy B3): subscribe markPrice từ server WS để bypass Binance WS.
  // Server đã maintain WS connection tới Binance, push price ~1s → giảm 1 connection per client.
  useEffect(() => {
    const off = onWsMessage((msg) => {
      if (msg?.type === "markPrice" && typeof msg.price === "number") {
        // Update price field nhanh; high/low/volume giữ giá trị cũ từ REST 24h ticker.
        if (mountedRef.current) {
          setConnectionStatus("LIVE");
          setPriceData((prev) => prev
            ? { ...prev, price: msg.price }
            : { price: msg.price, change24h: 0, changePct24h: 0, high24h: 0, low24h: 0, volume24h: 0 });
          setPriceHistory((prevH) => {
            const next = [...prevH, msg.price];
            return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
          });
          lastUpdateRef.current = Date.now();
        }
      }
    });
    return off;
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const connectWS = useCallback(() => {
    if (!mountedRef.current) return;

    try {
      // Close previous WS if exists
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }

      const ws = new WebSocket(BINANCE_WS);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!mountedRef.current) return;
        setConnectionStatus("LIVE");
        setError(null);
        stopPolling();
        backoffRef.current = 2000; // Reset backoff on success
      };

      ws.onmessage = (event) => {
        try {
          const d = JSON.parse(event.data);
          updatePrice({
            price: parseFloat(d.c),
            change24h: parseFloat(d.p),
            changePct24h: parseFloat(d.P),
            high24h: parseFloat(d.h),
            low24h: parseFloat(d.l),
            volume24h: parseFloat(d.v),
          });
        } catch {
          // Skip malformed message
        }
      };

      ws.onerror = () => {
        ws.close();
      };

      ws.onclose = () => {
        if (!mountedRef.current) return;
        setConnectionStatus("POLLING");
        startPolling();
        // Exponential backoff
        const delay = backoffRef.current;
        backoffRef.current = Math.min(delay * 2, MAX_BACKOFF);
        reconnectRef.current = setTimeout(connectWS, delay);
      };
    } catch {
      startPolling();
    }
  }, [updatePrice, startPolling, stopPolling]);

  useEffect(() => {
    mountedRef.current = true;
    connectWS();

    return () => {
      mountedRef.current = false;
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
      stopPolling();
      if (reconnectRef.current) {
        clearTimeout(reconnectRef.current);
      }
      if (throttleTimerRef.current) {
        clearTimeout(throttleTimerRef.current);
      }
    };
  }, [connectWS, stopPolling]);

  return { priceData, priceHistory, connectionStatus, error };
}
