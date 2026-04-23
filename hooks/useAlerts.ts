import { useState, useEffect, useRef, useCallback } from "react";
import { TFAnalysis } from "./useBinanceKlines";
import { Settings, TIMEFRAMES, TimeframeKey } from "../utils/constants";
import { playAlertSound, AlertSoundType } from "../utils/sound";

// Per-TF verdict config (from tools/backtest-verdict-by-tf.ts).
// atrTight = P30 ATR percentile per TF (adaptive threshold for "GOLDEN" setup).
// suppressLong = TF bị noise, LONG verdicts không reliable → chỉ SHORT/NEUTRAL.
const PER_TF_VERDICT: Record<TimeframeKey, {
  near: TimeframeKey; far: TimeframeKey; atrTight: number; suppressLong: boolean;
}> = {
  "5m":  { near: "15m", far: "1h",  atrTight: 0.122, suppressLong: true  },
  "15m": { near: "1h",  far: "4h",  atrTight: 0.257, suppressLong: true  },
  "1h":  { near: "4h",  far: "1d",  atrTight: 0.468, suppressLong: false },
  "4h":  { near: "1d",  far: "1w",  atrTight: 1.057, suppressLong: false },
  "1d":  { near: "1w",  far: "1M",  atrTight: 3.127, suppressLong: false },
  "1w":  { near: "1M",  far: "1M",  atrTight: 8.072, suppressLong: false },
  "1M":  { near: "1M",  far: "1M",  atrTight: 16.444, suppressLong: false },
};

export interface Alert {
  id: string;
  type: "critical" | "warning" | "info";
  message: string;
  icon: string;
  timestamp: number;
  soundType: AlertSoundType;
}

export interface VerdictTFDetail {
  label: string;
  rsi: number | null;
  rsiStatus: "OB" | "OS" | "NEUTRAL";
  stochK: number | null;
  stochStatus: "OB" | "OS" | "NEUTRAL";
  macdBull: boolean | null;
  divergence: string | null;
}

export interface Verdict {
  icon: string;
  text: string;
  color: string;
  reason: string;
  tfDetails: VerdictTFDetail[];
  rsiOB: number;
  rsiOS: number;
  stochOB: number;
  stochOS: number;
  bullDiv: number;
  bearDiv: number;
  adjPairsOB: string[][];
  adjPairsOS: string[][];
}

const TF_ORDER = TIMEFRAMES.map((t) => t.key);

function getAdjacentPairs(
  tfData: TFAnalysis[],
  check: (tf: TFAnalysis) => boolean
): string[][] {
  const pairs: string[][] = [];
  for (let i = 0; i < TF_ORDER.length - 1; i++) {
    const a = tfData.find((t) => t.key === TF_ORDER[i]);
    const b = tfData.find((t) => t.key === TF_ORDER[i + 1]);
    if (a && b && check(a) && check(b)) {
      pairs.push([a.label, b.label]);
    }
  }
  return pairs;
}

export function useAlerts(
  tfData: TFAnalysis[],
  settings: Settings,
  selectedTF: TimeframeKey = "1h",
): {
  criticalAlerts: Alert[];
  normalAlerts: Alert[];
  verdict: Verdict;
} {
  const [criticalAlerts, setCriticalAlerts] = useState<Alert[]>([]);
  const [normalAlerts, setNormalAlerts] = useState<Alert[]>([]);
  const [verdict, setVerdict] = useState<Verdict>({
    icon: "⏸",
    text: "TRUNG TÍNH",
    color: "#888888",
    reason: "",
    tfDetails: [],
    rsiOB: 0, rsiOS: 0, stochOB: 0, stochOS: 0,
    bullDiv: 0, bearDiv: 0, adjPairsOB: [], adjPairsOS: [],
  });
  const prevAlertKeysRef = useRef<Set<string>>(new Set());

  const generateAlerts = useCallback(() => {
    if (tfData.length === 0) return;

    const newAlerts: Alert[] = [];
    const { overboughtLevel, oversoldLevel } = settings;

    let obCount = 0, osCount = 0, bullDivCount = 0, bearDivCount = 0, stochObCount = 0, stochOsCount = 0;
    const obTFs: string[] = [], osTFs: string[] = [], stochObTFs: string[] = [], stochOsTFs: string[] = [];
    const bearDivTFs: string[] = [], bullDivTFs: string[] = [];
    const tfDetails: VerdictTFDetail[] = [];

    tfData.forEach((tf) => {
      const rsiStatus: "OB" | "OS" | "NEUTRAL" =
        tf.rsi !== null && tf.rsi > overboughtLevel ? "OB" :
        tf.rsi !== null && tf.rsi < oversoldLevel ? "OS" : "NEUTRAL";

      const stochStatus: "OB" | "OS" | "NEUTRAL" =
        tf.stochK !== null && tf.stochK > 80 ? "OB" :
        tf.stochK !== null && tf.stochK < 20 ? "OS" : "NEUTRAL";

      tfDetails.push({
        label: tf.label,
        rsi: tf.rsi,
        rsiStatus,
        stochK: tf.stochK,
        stochStatus,
        macdBull: tf.macdHistogram !== null ? tf.macdHistogram >= 0 : null,
        divergence: tf.divergence,
      });

      if (tf.rsi !== null) {
        if (tf.rsi > overboughtLevel) {
          obCount++;
          obTFs.push(tf.label);
          if (settings.overboughtAlert) {
            newAlerts.push({
              id: `ob-${tf.key}`, type: "warning",
              message: `${tf.label} RSI ${tf.rsi.toFixed(1)} — QUÁ MUA`,
              icon: "🔥", timestamp: Date.now(), soundType: "danger",
            });
          }
        }
        if (tf.rsi < oversoldLevel) {
          osCount++;
          osTFs.push(tf.label);
          if (settings.oversoldAlert) {
            newAlerts.push({
              id: `os-${tf.key}`, type: "info",
              message: `${tf.label} RSI ${tf.rsi.toFixed(1)} — QUÁ BÁN`,
              icon: "💎", timestamp: Date.now(), soundType: "bullish",
            });
          }
        }
      }

      if (tf.divergence === "BEARISH_DIV") {
        bearDivCount++;
        bearDivTFs.push(tf.label);
        if (settings.divergenceAlert) {
          newAlerts.push({
            id: `bdiv-${tf.key}`, type: "warning",
            message: `${tf.label} PHÂN KỲ GIẢM — Giá lên nhưng RSI giảm`,
            icon: "⚠️", timestamp: Date.now(), soundType: "danger",
          });
        }
      }
      if (tf.divergence === "BULLISH_DIV") {
        bullDivCount++;
        bullDivTFs.push(tf.label);
        if (settings.divergenceAlert) {
          newAlerts.push({
            id: `bldiv-${tf.key}`, type: "info",
            message: `${tf.label} PHÂN KỲ TĂNG — Giá giảm nhưng RSI tăng`,
            icon: "🚀", timestamp: Date.now(), soundType: "bullish",
          });
        }
      }

      if (tf.stochK !== null && settings.stochRsiAlert) {
        if (tf.stochK > 80) {
          stochObCount++;
          stochObTFs.push(tf.label);
          newAlerts.push({
            id: `stoch-ob-${tf.key}`, type: "warning",
            message: `${tf.label} StochRSI K=${tf.stochK.toFixed(0)} > 80 — Vùng quá mua`,
            icon: "📈", timestamp: Date.now(), soundType: "warning",
          });
        }
        if (tf.stochK < 20) {
          stochOsCount++;
          stochOsTFs.push(tf.label);
          newAlerts.push({
            id: `stoch-os-${tf.key}`, type: "info",
            message: `${tf.label} StochRSI K=${tf.stochK.toFixed(0)} < 20 — Vùng quá bán`,
            icon: "📉", timestamp: Date.now(), soundType: "bullish",
          });
        }
      }
    });

    const critical: Alert[] = [];
    const normal: Alert[] = [];

    if (obCount >= 2 && settings.multiTfAlert) {
      critical.push({
        id: "multi-ob", type: "critical",
        message: `ĐA KHUNG QUÁ MUA — RSI (${obTFs.join(", ")})`,
        icon: "🚨", timestamp: Date.now(), soundType: "danger",
      });
    }
    if (osCount >= 2 && settings.multiTfAlert) {
      critical.push({
        id: "multi-os", type: "critical",
        message: `ĐA KHUNG QUÁ BÁN — RSI (${osTFs.join(", ")})`,
        icon: "🚨", timestamp: Date.now(), soundType: "bullish",
      });
    }

    const adjOB = settings.stochRsiAdjacentAlert
      ? getAdjacentPairs(tfData, (tf) => tf.stochK !== null && tf.stochK > 80)
      : [];
    const adjOS = settings.stochRsiAdjacentAlert
      ? getAdjacentPairs(tfData, (tf) => tf.stochK !== null && tf.stochK < 20)
      : [];

    adjOB.forEach((pair, i) => {
      critical.push({
        id: `stoch-adj-ob-${i}`, type: "critical",
        message: `⚡ ${pair[0]}+${pair[1]} StochRSI cùng >80 — Xác suất quay đầu GIẢM cao!`,
        icon: "⚡", timestamp: Date.now(), soundType: "danger",
      });
    });
    adjOS.forEach((pair, i) => {
      critical.push({
        id: `stoch-adj-os-${i}`, type: "critical",
        message: `⚡ ${pair[0]}+${pair[1]} StochRSI cùng <20 — Xác suất quay đầu TĂNG cao!`,
        icon: "⚡", timestamp: Date.now(), soundType: "bullish",
      });
    });

    newAlerts.forEach((a) => {
      if (a.type === "critical") critical.push(a);
      else normal.push(a);
    });

    // Vibration
    if (settings.soundEnabled) {
      const currentKeys = new Set([...critical, ...normal].map((a) => a.id));
      const prevKeys = prevAlertKeysRef.current;
      const newKeys = [...currentKeys].filter((k) => !prevKeys.has(k));
      if (newKeys.length > 0) {
        const firstNew = [...critical, ...normal].find((a) => newKeys.includes(a.id));
        if (firstNew) playAlertSound(firstNew.soundType);
      }
      prevAlertKeysRef.current = currentKeys;
    }

    setCriticalAlerts(critical);
    setNormalAlerts(normal.slice(0, 30));

    // ── Verdict scheme v3 (per-TF adaptive, backtest-verdict-by-tf) ──
    const cfg = PER_TF_VERDICT[selectedTF] ?? PER_TF_VERDICT["1h"];
    const trendOf = (tf: TFAnalysis | undefined): "UP"|"DOWN"|"FLAT" => {
      if (!tf || tf.ema50 === null || tf.ema50 <= 0) return "FLAT";
      const d = (tf.lastClose - tf.ema50) / tf.ema50 * 100;
      return d > 0.3 ? "UP" : d < -0.3 ? "DOWN" : "FLAT";
    };
    const tfSel  = tfData.find(t => t.key === selectedTF);
    const tfNear = tfData.find(t => t.key === cfg.near);
    const tfFar  = tfData.find(t => t.key === cfg.far);

    const tNear = trendOf(tfNear);
    const tFar  = trendOf(tfFar);
    const atrSel = tfSel?.atrPct ?? null;
    const emaDistSel = tfSel?.emaDistPct ?? null;
    const rsiSel = tfSel?.rsi ?? null;
    const rsiFar = tfFar?.rsi ?? null;

    // Multi-TF score (iter4 weights) — adapted per-TF context
    let scoreLONG = 0;
    if (tNear === "FLAT") scoreLONG += 30;
    if (tNear === "DOWN") scoreLONG -= 20;
    if (tFar === "FLAT" || tFar === "UP") scoreLONG += 10;
    if (rsiFar !== null && rsiFar > 75) scoreLONG -= 25;
    if (tFar === "UP" || tFar === "FLAT") scoreLONG += 8;
    if (atrSel !== null && atrSel < cfg.atrTight) scoreLONG += 25;
    if (emaDistSel !== null && emaDistSel >= -0.5 && emaDistSel <= 0.5) scoreLONG += 20;
    if (rsiSel !== null && rsiSel < 60) scoreLONG += 10;
    if (rsiSel !== null && rsiSel > 70) scoreLONG -= 30;

    // GOLDEN_LONG per-TF: atr<tight + emaDist±0.5 + far HTF FLAT
    const goldenLONG = atrSel !== null && atrSel < cfg.atrTight
      && emaDistSel !== null && emaDistSel >= -0.5 && emaDistSel <= 0.5
      && tFar === "FLAT";

    const reasons: string[] = [];
    reasons.push(`Khung phân tích: ${selectedTF.toUpperCase()} (HTF: ${cfg.near}+${cfg.far})`);
    if (cfg.suppressLong) {
      reasons.push(`⚠️ TF ${selectedTF} scalp-noise → LONG verdict bị khoá (theo backtest)`);
    }
    if (goldenLONG && !cfg.suppressLong) {
      reasons.push(`💎 ATR ${selectedTF} ${atrSel!.toFixed(2)}% < ${cfg.atrTight}% · EMA dist ${emaDistSel!.toFixed(2)}% · ${cfg.far} FLAT`);
    }
    if (scoreLONG > 0) reasons.push(`Multi-TF Score LONG = ${scoreLONG}/123`);
    if (osCount > 0) reasons.push(`RSI Quá Bán: ${osTFs.join(", ")} (${osCount}/7)`);
    if (obCount > 0) reasons.push(`RSI Quá Mua: ${obTFs.join(", ")} (${obCount}/7)`);
    if (bullDivCount > 0) reasons.push(`Phân Kỳ Tăng: ${bullDivTFs.join(", ")}`);
    if (bearDivCount > 0) reasons.push(`Phân Kỳ Giảm: ${bearDivTFs.join(", ")}`);
    if (adjOS.length > 0) reasons.push(`StochRSI kề nhau <20: ${adjOS.map(p => p.join("+")).join(", ")}`);
    if (adjOB.length > 0) reasons.push(`StochRSI kề nhau >80: ${adjOB.map(p => p.join("+")).join(", ")}`);
    reasons.push(`HTF trend — ${cfg.near.toUpperCase()}:${tNear} · ${cfg.far.toUpperCase()}:${tFar}`);

    let v: Verdict;
    const base = {
      tfDetails,
      rsiOB: obCount, rsiOS: osCount,
      stochOB: stochObCount, stochOS: stochOsCount,
      bullDiv: bullDivCount, bearDiv: bearDivCount,
      adjPairsOB: adjOB, adjPairsOS: adjOS,
    };

    // suppressLong: ở 5m/15m, chặn tất cả LONG verdicts → chỉ SHORT CAUTION hoặc TRUNG TÍNH
    if (!cfg.suppressLong && goldenLONG) {
      v = { ...base, icon: "💎", text: "GOLDEN LONG SETUP", color: "#ffd700",
        reason: reasons.join("\n") };
    } else if (!cfg.suppressLong && scoreLONG >= 80) {
      v = { ...base, icon: "🚀", text: "STRONG LONG (SCORE)", color: "#2ed573",
        reason: reasons.join("\n") };
    } else if (!cfg.suppressLong && scoreLONG >= 60) {
      v = { ...base, icon: "📊", text: "POTENTIAL LONG (SCORE)", color: "#2ed573",
        reason: reasons.join("\n") };
    } else if (!cfg.suppressLong && scoreLONG >= 50) {
      v = { ...base, icon: "🟢", text: "WEAK LONG (SCORE)", color: "#2ed573",
        reason: reasons.join("\n") };
    } else if (!cfg.suppressLong && adjOS.length > 0 && tFar !== "DOWN") {
      v = { ...base, icon: "⚡", text: "STOCH REVERSAL LONG", color: "#ffa502",
        reason: reasons.join("\n") };
    } else if ((obCount >= 3 || bearDivCount > 0) && tFar !== "UP") {
      v = { ...base, icon: "🔴", text: "SHORT CAUTION", color: "#ff4757",
        reason: reasons.join("\n") };
    } else {
      v = { ...base, icon: "⏸", text: "TRUNG TÍNH", color: "#888888",
        reason: reasons.join("\n") };
    }
    setVerdict(v);
  }, [tfData, settings, selectedTF]);

  useEffect(() => {
    generateAlerts();
  }, [generateAlerts]);

  return { criticalAlerts, normalAlerts, verdict };
}
