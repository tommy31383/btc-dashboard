/**
 * Rule validator — kiểm tra 1 HardRule có hợp lệ không trước khi load.
 * Lightweight validator (không dùng ajv để khỏi tăng bundle); chỉ check các
 * field critical mà nếu sai sẽ làm useRuleAlerts crash.
 */
import { HardRule } from "./hardRules";

export interface ValidationIssue {
  rank: number;
  field: string;
  message: string;
}

export interface ValidationReport {
  total: number;
  valid: number;
  issues: ValidationIssue[];
}

const COND_KEYS = new Set(["stochExtreme", "rsiExtreme", "divergence", "bollingerTouch", "macdCross"]);
const FORCE_SIDES = new Set(["LONG", "SHORT"]);
const SOURCES = new Set(["GRID", "GA", "VERIFIED", "MANUAL"]);

function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function validateRule(rule: any, rank: number): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const push = (field: string, message: string) => issues.push({ rank, field, message });

  if (!rule || typeof rule !== "object") {
    push("rule", "không phải object");
    return issues;
  }
  if (!isNumber(rule.rank)) push("rank", "thiếu hoặc không phải số");
  if (typeof rule.source !== "string" || !SOURCES.has(rule.source)) {
    push("source", `không hợp lệ: ${rule.source}`);
  }
  if (!rule.config || typeof rule.config !== "object") {
    push("config", "thiếu");
    return issues;
  }
  const c = rule.config;
  for (const k of ["leverage", "targetPct", "stopPct", "maxHoldBars", "stochOSLevel", "stochOBLevel", "rsiOSLevel", "rsiOBLevel"]) {
    if (!isNumber(c[k])) push(`config.${k}`, "thiếu hoặc không phải số");
  }
  if (isNumber(c.targetPct) && isNumber(c.stopPct) && c.stopPct > 0 && c.targetPct / c.stopPct < 0.5) {
    push("config.targetPct", `R:R quá thấp (${(c.targetPct / c.stopPct).toFixed(2)})`);
  }
  if (c.forceSide !== undefined && !FORCE_SIDES.has(c.forceSide)) {
    push("config.forceSide", `chỉ chấp nhận LONG/SHORT, đang: ${c.forceSide}`);
  }
  if (Array.isArray(c.requiredConditions)) {
    for (const k of c.requiredConditions) {
      if (!COND_KEYS.has(k)) push("config.requiredConditions", `condition lạ: ${k}`);
    }
  }
  if (c.weights && typeof c.weights === "object") {
    for (const k of Object.keys(c.weights)) {
      if (!COND_KEYS.has(k)) push(`config.weights.${k}`, "key lạ");
    }
  }
  if (c.htfRsiFilter) {
    const f = c.htfRsiFilter;
    if (typeof f.tf !== "string") push("config.htfRsiFilter.tf", "thiếu");
    if (!["<", ">", "<=", ">="].includes(f.op)) push("config.htfRsiFilter.op", "op không hợp lệ");
    if (!isNumber(f.value)) push("config.htfRsiFilter.value", "thiếu");
  }
  if (!rule.stats || typeof rule.stats !== "object") {
    push("stats", "thiếu");
  } else {
    const s = rule.stats;
    if (!isNumber(s.winRate) || s.winRate < 0 || s.winRate > 100) push("stats.winRate", "ngoài [0,100]");
    if (!isNumber(s.profitFactor)) push("stats.profitFactor", "thiếu");
    if (!isNumber(s.trades)) push("stats.trades", "thiếu");
  }
  return issues;
}

export function validateRules(rules: HardRule[]): ValidationReport {
  const issues: ValidationIssue[] = [];
  let valid = 0;
  for (const r of rules) {
    const ri = validateRule(r, r?.rank ?? -1);
    if (ri.length === 0) valid += 1;
    else issues.push(...ri);
  }
  return { total: rules.length, valid, issues };
}
