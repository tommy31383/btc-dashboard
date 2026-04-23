/**
 * report-hard-rules.ts
 *
 * Reads assets/hard_rules.json and outputs a self-contained HTML report
 * (assets/hard_rules_report.html) with sortable tables, color-coded stats,
 * and full rule details per TF.
 *
 * Usage:
 *   npx tsx tools/report-hard-rules.ts
 *   npx tsx tools/report-hard-rules.ts --open    # open in browser after generating
 *
 * No external deps — pure inline CSS/JS, opens in any browser offline.
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const args = process.argv.slice(2);
const shouldOpen = args.includes("--open");

interface HardRule {
  rank: number;
  source: "GRID" | "GA" | "VERIFIED" | "MYRULE" | string;
  config: {
    leverage: number;
    targetPct: number;
    stopPct: number;
    minScore: number;
    minWeightedScore?: number;
    stochOSLevel: number;
    stochOBLevel: number;
    rsiOSLevel: number;
    rsiOBLevel: number;
    requiredConditions?: string[];
    weights?: Record<string, number>;
    maxHoldBars: number;
  };
  stats: {
    winRate: number;
    profitFactor: number;
    trades: number;
    avgWinPct: number;
    avgLossPct: number;
    avgHoldBars: number;
    wins: number;
    losses: number;
    timeouts: number;
  };
  label: string;
  compositeScore: number;
}

interface HardRulesData {
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

const COND_LABELS: Record<string, string> = {
  stochExtreme: "Stoch",
  rsiExtreme: "RSI",
  divergence: "Phân Kỳ",
  bollingerTouch: "Bollinger",
  macdCross: "MACD",
};

const escape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function fmtRule(rule: HardRule): {
  shape: string;
  thresholds: string;
  tpsl: string;
  rr: string;
  weights: string | null;
} {
  const cfg = rule.config as any;
  const lev = cfg.leverage || 100;
  const isGA = !!cfg.weights;
  const hasShape = (cfg.requiredConditions?.length || 0) > 0;
  const htfFilter = cfg.htfTrendFilter;
  const htfRsi = cfg.htfRsiFilter as { tf: string; op: string; value: number } | undefined;
  const htfFilters = cfg.htfFilters as any[] | undefined;
  const baseShape = isGA
    ? `🧬 GA Weighted (≥${cfg.minWeightedScore})`
    : hasShape
      ? `BẮT BUỘC: ${cfg.requiredConditions!.map((k: string) => COND_LABELS[k] || k).join(" + ")}`
      : `Bất kỳ (Score ≥ ${cfg.minScore})`;
  const htfLines: string[] = [];
  if (htfFilter) {
    htfLines.push(`📈 HTF Trend: ${escape(htfFilter.label || htfFilter.mode)}`);
  }
  if (htfRsi) {
    htfLines.push(`📈 HTF RSI: ${escape(htfRsi.tf)} RSI ${escape(htfRsi.op)} ${htfRsi.value}`);
  }
  if (Array.isArray(htfFilters) && htfFilters.length > 0) {
    const parts = htfFilters.map((f: any) => {
      if (f.type === "trend") return `${f.tf || "near"} ${String(f.direction).toUpperCase()}`;
      if (f.type === "rsi") return `${f.tf} RSI ${f.op} ${f.value}`;
      if (f.type === "slope") return `${f.tf} ${f.indicator} ${f.direction === "rising" ? "↑" : "↓"}${f.lookback ? ` (lb${f.lookback})` : ""}`;
      if (f.type === "compare") return `${f.tf} ${f.left}${f.op}${f.right}`;
      if (f.type === "stochRange") {
        const p: string[] = [];
        if (f.kMin !== undefined) p.push(`K≥${f.kMin}`);
        if (f.kMax !== undefined) p.push(`K≤${f.kMax}`);
        if (f.dMin !== undefined) p.push(`D≥${f.dMin}`);
        if (f.dMax !== undefined) p.push(`D≤${f.dMax}`);
        return `${f.tf} ${p.join(",")}`;
      }
      if (f.type === "cross") return `${f.tf} ${f.direction}`;
      return f.type;
    });
    htfLines.push(`🔭 HTF Filters (${htfFilters.length}): ${escape(parts.join(" · "))}`);
  }
  const shape = htfLines.length > 0
    ? `${baseShape}<br><span style="color:#f7931a;font-size:9px">${htfLines.join("<br>")}</span>`
    : baseShape;
  const thresholds = `Stoch &lt;${cfg.stochOSLevel}/&gt;${cfg.stochOBLevel} · RSI &lt;${cfg.rsiOSLevel}/&gt;${cfg.rsiOBLevel}`;
  const tpsl = `<span class="bull">+${(cfg.targetPct * lev).toFixed(0)}% PnL</span> / <span class="bear">-${(cfg.stopPct * lev).toFixed(0)}% PnL</span> <span class="dim">(giá +${cfg.targetPct.toFixed(2)}% / -${cfg.stopPct.toFixed(2)}%, x${lev})</span>`;
  const rr = `1:${(cfg.targetPct / cfg.stopPct).toFixed(2)}`;
  let weights: string | null = null;
  if (isGA && cfg.weights) {
    const items = Object.entries(cfg.weights as Record<string, number>)
      .filter(([, w]) => (w ?? 0) > 0)
      .sort(([, a], [, b]) => (b ?? 0) - (a ?? 0))
      .map(([k, w]) => `${COND_LABELS[k] || k}=${w}`);
    weights = items.join(" · ");
  }
  return { shape, thresholds, tpsl, rr, weights };
}

function ruleColor(wr: number): string {
  if (wr >= 65) return "wr-good";
  if (wr >= 50) return "wr-mid";
  return "wr-bad";
}
function pfColor(pf: number): string {
  if (pf >= 2) return "pf-good";
  if (pf >= 1.2) return "pf-mid";
  return "pf-bad";
}

// Convert interval string to minutes per candle
const INTERVAL_MIN: Record<string, number> = {
  "5m": 5, "15m": 15, "1h": 60, "4h": 240, "1d": 1440, "1w": 10080,
};

function periodFromCandles(interval: string, candles: number): { days: number; label: string } {
  const min = INTERVAL_MIN[interval] || 60;
  const totalMin = candles * min;
  const days = totalMin / 60 / 24;
  let label: string;
  if (days < 30) label = `${days.toFixed(1)} ngày`;
  else if (days < 365) label = `${(days / 30).toFixed(1)} tháng (${Math.round(days)} ngày)`;
  else label = `${(days / 365).toFixed(1)} năm (${Math.round(days)} ngày)`;
  return { days, label };
}

function buildHTML(data: HardRulesData): string {
  const tfKeys = Object.keys(data.tfs);
  const totalRules = Object.values(data.tfs).reduce((s, t) => s + t.rules.length, 0);
  const generatedDate = new Date(data.generated_at);

  // Per-TF cards
  const tfSections = tfKeys.map((tfKey) => {
    const tf = data.tfs[tfKey];
    const period = periodFromCandles(tf.interval, tf.candles_used);
    const rows = tf.rules.map((rule) => {
      const f = fmtRule(rule);
      const stats = rule.stats as any;
      // Source label — full Vietnamese names
      const sourceClass = rule.source.toLowerCase();
      const sourceText = rule.source === "GA"
        ? "🧬 Genetic Algo"
        : rule.source === "VERIFIED"
          ? "⭐ Verified (đã tính fee)"
          : rule.source === "MYRULE"
            ? "📝 Tomi's Rule"
            : "↻ Grid Search";
      // NET PnL column (only present for VERIFIED rules from scan-tpsl)
      const netPnL = stats.netPnL !== undefined ? stats.netPnL : null;
      const grossPnL = stats.grossPnL !== undefined ? stats.grossPnL : null;
      const feeCost = stats.feeCost !== undefined ? stats.feeCost : null;
      const netCell = netPnL !== null
        ? `<span class="${netPnL >= 0 ? 'bull-text' : 'bear-text'}" style="font-weight:900">${netPnL >= 0 ? '+' : ''}${netPnL}%</span>${grossPnL !== null ? `<br><span class="dim" style="font-size:9px">gross +${grossPnL}% / fee -${feeCost}%</span>` : ''}`
        : `<span class="dim">—</span>`;
      // Frequency: lệnh/tháng (and lệnh/ngày if very high, lệnh/tuần if low)
      const tradesPerMonth = (stats.trades / period.days * 30);
      let freqLabel: string;
      if (tradesPerMonth >= 30) freqLabel = `${(tradesPerMonth / 30).toFixed(1)}/ngày`;
      else if (tradesPerMonth >= 1) freqLabel = `${tradesPerMonth.toFixed(1)}/tháng`;
      else freqLabel = `${(tradesPerMonth * 12).toFixed(1)}/năm`;
      const monthlyNetPnL = netPnL !== null ? Math.round(netPnL / period.days * 30) : null;
      // Direction badge: VERIFIED rules have explicit side, GRID/GA trade both
      const side = stats.side as string | undefined;
      const sideCell = side === "LONG"
        ? `<span class="side-long">🟢 LONG</span>`
        : side === "SHORT"
          ? `<span class="side-short">🔴 SHORT</span>`
          : `<span class="side-both">⇅ Cả 2</span>`;
      const labelHtml = rule.label
        ? `<br><span class="rule-label" title="${escape(rule.label)}">${escape(rule.label)}</span>`
        : "";
      return `
        <tr>
          <td class="rank">#${rule.rank}${labelHtml}</td>
          <td>${sideCell}</td>
          <td><span class="source-${sourceClass}">${sourceText}</span></td>
          <td class="${ruleColor(stats.winRate)} stat-cell">${stats.winRate.toFixed(0)}%</td>
          <td class="${pfColor(stats.profitFactor)} stat-cell">${stats.profitFactor === 999 ? "∞" : stats.profitFactor.toFixed(1)}</td>
          <td>
            <span class="dim" style="font-weight:800;font-size:12px">${stats.trades}</span>
            <br><span class="dim" style="font-size:9px">${freqLabel}</span>
          </td>
          <td class="dim" style="font-size:10px">
            <span class="bull-text">${stats.wins} thắng</span><br>
            <span class="bear-text">${stats.losses} thua</span><br>
            <span class="dim">${stats.timeouts} hết hạn</span>
          </td>
          <td class="bull-text">+${stats.avgWinPct.toFixed(0)}%</td>
          <td class="bear-text">-${Math.abs(stats.avgLossPct).toFixed(0)}%</td>
          <td>
            ${netCell}
            ${monthlyNetPnL !== null ? `<br><span class="dim" style="font-size:9px">~${monthlyNetPnL >= 0 ? '+' : ''}${monthlyNetPnL}%/tháng</span>` : ''}
          </td>
          <td><span class="shape">${f.shape}</span></td>
          <td class="thresholds">${f.thresholds}</td>
          <td class="tpsl">${f.tpsl}</td>
          <td class="dim">R:R ${f.rr}</td>
          <td class="weights">${f.weights ? escape(f.weights) : "—"}</td>
        </tr>
      `;
    }).join("");

    const priceChange = ((tf.price_range.last - tf.price_range.first) / tf.price_range.first * 100).toFixed(1);
    const priceColor = parseFloat(priceChange) >= 0 ? "bull-text" : "bear-text";

    return `
      <section class="tf-card">
        <header class="tf-header">
          <h2>${tf.label}</h2>
          <div class="tf-meta">
            <span class="period-badge"><strong>📅 ${period.label}</strong></span>
            <span>·</span>
            <span><strong>${tf.candles_used.toLocaleString()}</strong> nến</span>
            <span>·</span>
            <span>$${tf.price_range.first.toLocaleString()} → $${tf.price_range.last.toLocaleString()} <span class="${priceColor}">(${priceChange}%)</span></span>
            <span>·</span>
            <span>${tf.rules.length} bộ rule</span>
          </div>
        </header>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Hướng<br><span class="th-sub">(LONG/SHORT)</span></th>
                <th>Nguồn (algorithm)</th>
                <th>Win Rate<br><span class="th-sub">(% thắng)</span></th>
                <th>Profit Factor<br><span class="th-sub">(lời/lỗ)</span></th>
                <th>Số lệnh<br><span class="th-sub">(tần suất)</span></th>
                <th>Chi tiết<br><span class="th-sub">(W/L/Hết hạn)</span></th>
                <th>TB Thắng<br><span class="th-sub">(PnL%)</span></th>
                <th>TB Thua<br><span class="th-sub">(PnL%)</span></th>
                <th>NET PnL<br><span class="th-sub">(sau fee)</span></th>
                <th>Hình dạng rule</th>
                <th>Threshold</th>
                <th>TP/SL (PnL%)</th>
                <th>R:R</th>
                <th>Trọng số (Genetic Algo)</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </section>
    `;
  }).join("\n");

  // Overall stats
  const allRules = Object.values(data.tfs).flatMap((t) => t.rules);
  const avgWR = allRules.reduce((s, r) => s + r.stats.winRate, 0) / (allRules.length || 1);
  const avgPF = allRules.reduce((s, r) => s + Math.min(r.stats.profitFactor, 100), 0) / (allRules.length || 1);
  const gaCount = allRules.filter((r) => r.source === "GA").length;
  const gridCount = allRules.length - gaCount;

  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BTC Hard Rules Report — ${generatedDate.toLocaleString("vi-VN")}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #0a0a1a;
    color: #ffffff;
    font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
    line-height: 1.4;
    padding: 24px;
    font-size: 13px;
  }
  .header {
    background: linear-gradient(135deg, #f7931a22 0%, #f7931a08 100%);
    border: 1px solid #f7931a44;
    border-radius: 12px;
    padding: 20px;
    margin-bottom: 24px;
  }
  h1 {
    color: #f7931a;
    font-size: 20px;
    letter-spacing: 1px;
    margin-bottom: 8px;
  }
  .sub {
    color: #aaaaaa;
    font-size: 11px;
    margin-bottom: 12px;
  }
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: 12px;
    margin-top: 12px;
  }
  .stat-box {
    background: #ffffff08;
    border-radius: 6px;
    padding: 10px;
    text-align: center;
  }
  .stat-val {
    font-size: 18px;
    font-weight: 900;
    color: #ffffff;
  }
  .stat-label {
    font-size: 9px;
    color: #888;
    margin-top: 4px;
    letter-spacing: 0.5px;
  }
  .tf-card {
    background: #0d1117;
    border: 1px solid #ffffff15;
    border-radius: 12px;
    padding: 16px;
    margin-bottom: 20px;
  }
  .tf-header {
    display: flex;
    align-items: baseline;
    gap: 16px;
    flex-wrap: wrap;
    margin-bottom: 12px;
    padding-bottom: 10px;
    border-bottom: 1px solid #ffffff15;
  }
  h2 {
    color: #f7931a;
    font-size: 18px;
    font-weight: 900;
  }
  .tf-meta {
    color: #aaa;
    font-size: 11px;
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .table-wrap {
    overflow-x: auto;
  }
  table {
    border-collapse: collapse;
    font-size: 11px;
    width: 100%;
    min-width: 900px;
  }
  thead th {
    background: #1a1a2e;
    color: #888;
    text-align: left;
    padding: 8px 6px;
    font-weight: 700;
    letter-spacing: 0.5px;
    border-bottom: 2px solid #f7931a44;
    white-space: nowrap;
  }
  tbody td {
    padding: 8px 6px;
    border-bottom: 1px solid #ffffff08;
    vertical-align: top;
  }
  tbody tr:hover {
    background: #ffffff05;
  }
  .rank {
    color: #ffa502;
    font-weight: 900;
    font-size: 12px;
  }
  .source-grid {
    background: #ffa50220;
    color: #ffa502;
    padding: 2px 6px;
    border-radius: 3px;
    border: 1px solid #ffa50244;
    font-size: 9px;
    font-weight: 800;
    white-space: nowrap;
  }
  .source-ga {
    background: #2ed57320;
    color: #2ed573;
    padding: 2px 6px;
    border-radius: 3px;
    border: 1px solid #2ed57344;
    font-size: 9px;
    font-weight: 800;
    white-space: nowrap;
  }
  .source-verified {
    background: #f7931a30;
    color: #f7931a;
    padding: 2px 6px;
    border-radius: 3px;
    border: 1px solid #f7931a80;
    font-size: 9px;
    font-weight: 900;
    white-space: nowrap;
  }
  .source-myrule {
    background: #e84a8b30;
    color: #ff7ab0;
    padding: 2px 6px;
    border-radius: 3px;
    border: 1px solid #e84a8b80;
    font-size: 9px;
    font-weight: 900;
    white-space: nowrap;
  }
  .rule-label {
    display: block;
    color: #ff7ab0;
    font-size: 10px;
    font-weight: 700;
    font-style: italic;
    margin-top: 3px;
    line-height: 1.25;
    max-width: 220px;
    word-break: break-word;
    white-space: normal;
  }
  .th-sub {
    color: #666;
    font-size: 8px;
    font-weight: 400;
    display: block;
    margin-top: 2px;
  }
  .side-long {
    background: #2ed57325;
    color: #2ed573;
    padding: 4px 8px;
    border-radius: 4px;
    border: 1px solid #2ed57360;
    font-size: 11px;
    font-weight: 900;
    white-space: nowrap;
    display: inline-block;
  }
  .side-short {
    background: #ff475725;
    color: #ff4757;
    padding: 4px 8px;
    border-radius: 4px;
    border: 1px solid #ff475760;
    font-size: 11px;
    font-weight: 900;
    white-space: nowrap;
    display: inline-block;
  }
  .side-both {
    background: #ffffff10;
    color: #aaa;
    padding: 4px 8px;
    border-radius: 4px;
    border: 1px solid #ffffff20;
    font-size: 11px;
    font-weight: 700;
    white-space: nowrap;
    display: inline-block;
  }
  .period-badge {
    background: #f7931a30;
    color: #f7931a;
    padding: 4px 10px;
    border-radius: 4px;
    border: 1px solid #f7931a60;
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.5px;
  }
  .stat-cell {
    font-weight: 900;
    font-size: 12px;
    text-align: center;
  }
  .wr-good, .pf-good { color: #2ed573; }
  .wr-mid, .pf-mid { color: #ffa502; }
  .wr-bad, .pf-bad { color: #ff4757; }
  .bull, .bull-text { color: #2ed573; }
  .bear, .bear-text { color: #ff4757; }
  .dim { color: #888; }
  .shape {
    font-weight: 700;
    color: #2ed573;
  }
  .thresholds { color: #ccc; font-size: 10px; }
  .tpsl { font-size: 10px; }
  .weights {
    color: #2ed573;
    font-style: italic;
    font-size: 10px;
    max-width: 200px;
  }
  .footer {
    text-align: center;
    color: #555;
    font-size: 10px;
    margin-top: 24px;
    padding-top: 16px;
    border-top: 1px solid #ffffff10;
  }
  .legend {
    background: #ffffff05;
    padding: 12px;
    border-radius: 6px;
    margin-top: 12px;
    font-size: 10px;
    color: #aaa;
    line-height: 1.6;
  }
  .legend strong { color: #fff; }
</style>
</head>
<body>

<div class="header">
  <h1>📦 BTC HARD RULES REPORT</h1>
  <div class="sub">Pre-baked top trading rules generated from Binance historical data · Generated ${generatedDate.toLocaleString("vi-VN")}</div>
  <div class="stats-grid">
    <div class="stat-box">
      <div class="stat-val">${tfKeys.length}</div>
      <div class="stat-label">TIMEFRAMES</div>
    </div>
    <div class="stat-box">
      <div class="stat-val">${totalRules}</div>
      <div class="stat-label">RULES TỔNG</div>
    </div>
    <div class="stat-box">
      <div class="stat-val ${avgWR >= 55 ? "wr-good" : "wr-mid"}">${avgWR.toFixed(1)}%</div>
      <div class="stat-label">WR TRUNG BÌNH</div>
    </div>
    <div class="stat-box">
      <div class="stat-val ${avgPF >= 1.5 ? "pf-good" : "pf-mid"}">${avgPF.toFixed(2)}</div>
      <div class="stat-label">PF TRUNG BÌNH</div>
    </div>
    <div class="stat-box">
      <div class="stat-val" style="color: #ffa502">${gridCount}</div>
      <div class="stat-label">GRID</div>
    </div>
    <div class="stat-box">
      <div class="stat-val" style="color: #2ed573">${gaCount}</div>
      <div class="stat-label">GA</div>
    </div>
  </div>
  <div class="legend">
    <strong>📚 GIẢI THÍCH CÁC CỘT:</strong>
    <br><br>
    <strong>Hướng (LONG/SHORT):</strong>
    <ul style="margin: 4px 0 8px 16px;">
      <li><span class="side-long">🟢 LONG</span> — Vào lệnh MUA (kỳ vọng giá tăng → lời). Hit TP khi giá tăng X%, hit SL khi giá giảm Y%.</li>
      <li><span class="side-short">🔴 SHORT</span> — Vào lệnh BÁN KHỐNG (kỳ vọng giá giảm → lời). Hit TP khi giá giảm X%, hit SL khi giá tăng Y%.</li>
      <li><span class="side-both">⇅ Cả 2</span> — Rule dùng cho cả LONG và SHORT (engine tự quyết khi nào đi chiều nào dựa vào quá-bán/quá-mua).</li>
    </ul>
    <strong>Nguồn (algorithm):</strong>
    <ul style="margin: 4px 0 8px 16px;">
      <li><span class="source-grid">↻ Grid Search</span> — thử tất cả combo từ 1 grid cố định (vd Stoch=[5,10], TP=[1.5,2,3]). Đơn giản, đầy đủ.</li>
      <li><span class="source-ga">🧬 Genetic Algo</span> — Tiến hóa rule qua nhiều thế hệ (như chọn lọc tự nhiên). Mỗi ĐK có trọng số 0-3 học được. Tìm rule mà Grid bỏ sót.</li>
      <li><span class="source-verified">⭐ Verified</span> — Kết quả từ deep-scan + ĐÃ TÍNH FEE Binance (0.05%/side). Đáng tin nhất.</li>
      <li><span class="source-myrule">📝 Tomi's Rule</span> — Rule do Tommy tự tay thiết kế (file tools/my_rules/*.json), đã backtest qua backtest-my-rule.ts và pass (NET PnL > 0). Nhãn (italic màu hồng) chính là tên rule trong file gốc.</li>
    </ul>
    <strong>Win Rate (WR):</strong> % số lệnh thắng. <span class="wr-good">≥65% tốt</span> · <span class="wr-mid">50-65% khá</span> · <span class="wr-bad">&lt;50% rủi ro</span>
    <br>
    <strong>Profit Factor (PF):</strong> Tổng tiền lời ÷ Tổng tiền lỗ. <span class="pf-good">≥2 tốt</span> · <span class="pf-mid">1.2-2 khá</span> · <span class="pf-bad">&lt;1 LỖ</span>. PF=1 nghĩa là hòa vốn.
    <br>
    <strong>Số lệnh:</strong> Tổng signal kích hoạt trong giai đoạn test. Càng nhiều lệnh → thống kê càng đáng tin.
    <br>
    <strong>Chi tiết (W/L/Hết hạn):</strong>
    <ul style="margin: 4px 0 8px 16px;">
      <li><span class="bull-text">Thắng (Win)</span>: lệnh hit Take Profit (TP) → đóng lời</li>
      <li><span class="bear-text">Thua (Loss)</span>: lệnh hit Stop Loss (SL) → cắt lỗ</li>
      <li><span class="dim">Hết hạn (Timeout)</span>: chưa hit TP/SL trong N nến → đóng tay (flat ~0)</li>
    </ul>
    <strong>TB Thắng / TB Thua:</strong> PnL trung bình mỗi lệnh thắng/thua (đã × đòn bẩy).
    <br>
    <strong>NET PnL (sau fee):</strong> Lợi nhuận THỰC TẾ sau khi trừ phí Binance (~0.10% round-trip × leverage). Đây là số mày kiếm thật.
    <br>
    <strong>Hình dạng rule:</strong>
    <ul style="margin: 4px 0 8px 16px;">
      <li><strong>Bất kỳ (Score ≥ N)</strong>: chỉ cần N/5 điều kiện đúng cùng lúc, không bắt buộc cụ thể nào</li>
      <li><strong>BẮT BUỘC X+Y</strong>: phải có ĐK X VÀ Y cùng lúc mới vào lệnh</li>
      <li><strong>🧬 GA Weighted</strong>: mỗi ĐK có trọng số khác nhau (Stoch=3 quan trọng, MACD=0 bỏ qua), vào lệnh khi tổng ≥ ngưỡng</li>
    </ul>
    <strong>Threshold:</strong> Ngưỡng số học cho mỗi indicator (vd Stoch&lt;5/&gt;95 = StochRSI &lt; 5 quá bán hoặc &gt; 95 quá mua).
    <br>
    <strong>TP/SL (PnL%):</strong> Take Profit / Stop Loss tính theo % PnL trên vốn (đã ×leverage). VD: TP+200% PnL = vốn 100u lời 200u.
    <br>
    <strong>R:R (Risk:Reward):</strong> Tỉ lệ TP/SL. R:R 1:2 nghĩa là rủi ro 1 đồng để kiếm 2 đồng. Càng cao càng tốt (≥1.5 OK).
    <br>
    <strong>Trọng số (Genetic Algo):</strong> Chỉ áp dụng cho rule GA. Cho biết ĐK nào quan trọng (weight cao = ưu tiên).
  </div>
</div>

${tfSections}

<div class="footer">
  Generated by <code>tools/report-hard-rules.ts</code> · Data: ${escape(data.data_source)} ·
  ${generatedDate.toISOString()}
</div>

</body>
</html>`;
}

function main() {
  const jsonPath = join(__dirname, "..", "assets", "hard_rules.json");
  const htmlPath = join(__dirname, "..", "assets", "hard_rules_report.html");

  let data: HardRulesData;
  try {
    data = JSON.parse(readFileSync(jsonPath, "utf-8"));
  } catch (e) {
    console.error(`❌ Could not read ${jsonPath}`);
    console.error(`   Run first: npx tsx tools/generate-hard-rules.ts`);
    process.exit(1);
  }

  const html = buildHTML(data);
  writeFileSync(htmlPath, html);

  const sizeMB = (html.length / 1024).toFixed(1);
  console.log(`✅ Wrote ${htmlPath} (${sizeMB} KB)`);
  console.log(`   ${Object.keys(data.tfs).length} TFs, ${Object.values(data.tfs).reduce((s, t) => s + t.rules.length, 0)} rules`);

  if (shouldOpen) {
    try {
      const platform = process.platform;
      const cmd = platform === "win32" ? `start "" "${htmlPath}"`
                : platform === "darwin" ? `open "${htmlPath}"`
                : `xdg-open "${htmlPath}"`;
      execSync(cmd, { stdio: "ignore" });
      console.log(`   Opened in browser.`);
    } catch (e) {
      console.log(`   Open manually: file://${htmlPath.replace(/\\/g, "/")}`);
    }
  } else {
    console.log(`   Open: file://${htmlPath.replace(/\\/g, "/")}`);
  }
}

main();
