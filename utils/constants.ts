export const TIMEFRAMES = [
  { key: "5m", label: "5M", interval: "5m", limit: 100 },
  { key: "15m", label: "15M", interval: "15m", limit: 100 },
  { key: "1h", label: "1H", interval: "1h", limit: 100 },
  { key: "4h", label: "4H", interval: "4h", limit: 100 },
  { key: "1d", label: "1D", interval: "1d", limit: 100 },
  { key: "1w", label: "1W", interval: "1w", limit: 100 },
  { key: "1M", label: "1MO", interval: "1M", limit: 100 },
] as const;

export type TimeframeKey = (typeof TIMEFRAMES)[number]["key"];

export const COLORS = {
  bg: "#0a0a1a",
  bgCard: "#0d1117",
  bgPanel: "#1a1a2e",
  bitcoin: "#f7931a",
  bull: "#2ed573",
  bear: "#ff4757",
  warning: "#ffa502",
  neutral: "#888888",
  neutralDark: "#555555",
  neutralDarker: "#333333",
  text: "#ffffff",
  textDim: "#aaaaaa",
  textMuted: "#666666",
} as const;

export const BINANCE_REST = "https://api.binance.com/api/v3";
export const BINANCE_WS = "wss://stream.binance.com:9443/ws/btcusdt@ticker";

export const DEFAULT_SETTINGS = {
  soundEnabled: true,
  overboughtAlert: true,
  oversoldAlert: true,
  divergenceAlert: true,
  multiTfAlert: true,
  stochRsiAlert: true,
  stochRsiAdjacentAlert: true,
  notifyEntrySignal: true,   // Push notification khi có tín hiệu vào lệnh
  notifyExitSignal: true,    // Push notification khi tín hiệu WIN/LOSS
  notifyMinScore: 3,         // Chỉ thông báo khi score >= N
  overboughtLevel: 70,
  oversoldLevel: 30,
};

export type Settings = typeof DEFAULT_SETTINGS;
