/**
 * Hard Rules — pre-baked top trading rules generated offline by
 * tools/generate-hard-rules.ts and bundled into the app via
 * assets/hard_rules.json.
 *
 * App users get sane high-WR/PF rules out of the box without waiting for
 * Grid/GA optimizer to run on their phone.
 */
import { BacktestConfig } from "./backtester";

// Static import — bundled at build time
import hardRulesJson from "../assets/hard_rules.json";

export interface HardRuleStats {
  winRate: number;
  profitFactor: number;
  trades: number;
  avgWinPct: number;
  avgLossPct: number;
  avgHoldBars: number;
  wins: number;
  losses: number;
  timeouts: number;
}

export interface HardRule {
  rank: number;
  source: "GRID" | "GA" | "VERIFIED" | string;
  config: BacktestConfig;
  stats: HardRuleStats;
  // Optional after trim-hard-rules.ts removes them to slim JSON
  label?: string;
  compositeScore?: number;
}

export interface HardRulesByTF {
  generated_at: string;
  data_source: string;
  tfs: Record<string, {
    interval: string;
    label: string;
    candles_used: number;
    price_range: { min: number; max: number; first: number; last: number };
    rules: HardRule[];
  }>;
}

/** Get the bundled hard rules dataset. Safe even if JSON is partial. */
export function getHardRules(): HardRulesByTF {
  return hardRulesJson as unknown as HardRulesByTF;
}

/** Convenience: get rules for a specific TF, or empty array */
export function getHardRulesForTF(tfKey: string): HardRule[] {
  const all = getHardRules();
  return all.tfs[tfKey]?.rules || [];
}

/** Sanity check: does our bundled JSON have any rules? */
export function hasHardRules(): boolean {
  const all = getHardRules();
  return Object.keys(all.tfs || {}).length > 0;
}
