/**
 * rescue-rules.ts
 *
 * Với các rule có netPnL âm hoặc quá nhỏ (hoặc WR < 50%) trong hard_rules.json,
 * grid-search TP/SL để xem có combo nào "cứu" được rule.
 *
 * Output:
 *   - assets/rules_rescue.json
 *   - assets/rules_rescue_preview.html
 *
 * Logic:
 *   1. Fetch klines 1 lần/TF, pre-compute indicators
 *   2. Với mỗi rule, tính danh sách entry signals (không phụ thuộc TP/SL)
 *   3. Grid TP = [1,1.5,2,2.5,3,4,5], SL = [0.5,1,1.5,2], chỉ RR ≥ 1
 *   4. Simulate từng (entry, tp, sl) combo → pick best (ranking: netPnL)
 *   5. Nếu best_net > current_net * 1.5 → "RESCUED"
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { calcStochRSI, detectDivergence, calcEMASeries, calcRSISeriesAligned, calcMACDSeries, calcBollingerSeries } from "../utils/indicators";

const BINANCE = "https://api.binance.com/api/v3";
interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number; }

const TF_CONFIG: Record<string, { candles: number; htfNear: string; htfFar: string }> = {
  "5m":  { candles: 10000, htfNear: "15m", htfFar: "1h" },
  "15m": { candles: 10000, htfNear: "1h",  htfFar: "4h" },
  "1h":  { candles: 10000, htfNear: "4h",  htfFar: "1d" },
  "4h":  { candles: 6000,  htfNear: "1d",  htfFar: "1w" },
  "1d":  { candles: 2000,  htfNear: "1w",  htfFar: "1M" },
  "1w":  { candles: 500,   htfNear: "1M",  htfFar: "1M" },
};
const TF_MINUTES: Record<string, number> = { "5m":5,"15m":15,"1h":60,"4h":240,"1d":1440,"1w":10080,"1M":43200 };

const TP_GRID = [1, 1.5, 2, 2.5, 3, 4, 5];
const SL_GRID = [0.5, 1, 1.5, 2];

async function fetchKlines(interval: string, total: number): Promise<Candle[]> {
  const all: Candle[] = []; let endTime: number | undefined;
  while (all.length < total) {
    const limit = Math.min(1000, total - all.length);
    const params = new URLSearchParams({ symbol: "BTCUSDT", interval, limit: String(limit) });
    if (endTime) params.set("endTime", String(endTime));
    const res = await fetch(`${BINANCE}/klines?${params}`);
    const data: any[] = await res.json();
    if (!Array.isArray(data) || !data.length) break;
    const batch = data.map((k: any) => ({ time:+k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5] }));
    all.unshift(...batch);
    endTime = batch[0].time - 1;
    await new Promise(r => setTimeout(r, 80));
  }
  const m = new Map<number, Candle>(); for (const c of all) m.set(c.time, c);
  return [...m.values()].sort((a,b) => a.time - b.time);
}

function htfIdxAt(htf: Candle[], targetTime: number): number {
  let lo = 0, hi = htf.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (htf[mid].time <= targetTime) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}
function trendFromEMA(price: number, ema: number | null): "UP"|"DOWN"|"FLAT" {
  if (ema == null) return "FLAT";
  const d = (price - ema) / ema * 100;
  return d > 0.3 ? "UP" : d < -0.3 ? "DOWN" : "FLAT";
}

function simulate(c: Candle[], idx: number, entry: number, side: "LONG"|"SHORT", tp: number, sl: number, maxHold: number) {
  const tpP = side === "LONG" ? entry*(1+tp/100) : entry*(1-tp/100);
  const slP = side === "LONG" ? entry*(1-sl/100) : entry*(1+sl/100);
  for (let i = idx+1; i < Math.min(idx+1+maxHold, c.length); i++) {
    if (side === "LONG") { if (c[i].low <= slP) return "LOSS"; if (c[i].high >= tpP) return "WIN"; }
    else                 { if (c[i].high >= slP) return "LOSS"; if (c[i].low <= tpP) return "WIN"; }
  }
  return "TIMEOUT";
}

interface TFContext {
  entry: Candle[];
  closes: number[];
  rsi: (number|null)[];
  macdHist: (number|null)[];
  bb: { upper:(number|null)[]; lower:(number|null)[]; middle:(number|null)[] };
  ema50: (number|null)[];
  stoch: (number|null)[];
  div: (string|null)[];
  htfNear: Candle[];
  htfFar: Candle[];
  htfNearEMA: (number|null)[];
  htfFarEMA: (number|null)[];
}

async function buildTFContext(tfKey: string): Promise<TFContext> {
  const cfg = TF_CONFIG[tfKey];
  const entry = await fetchKlines(tfKey, cfg.candles);
  const htfNear = await fetchKlines(cfg.htfNear, Math.ceil(cfg.candles*TF_MINUTES[tfKey]/TF_MINUTES[cfg.htfNear])+100).catch(()=>[]);
  const htfFar  = await fetchKlines(cfg.htfFar,  Math.ceil(cfg.candles*TF_MINUTES[tfKey]/TF_MINUTES[cfg.htfFar])+100).catch(()=>[]);
  const closes = entry.map(x=>x.close);
  const rsiS = calcRSISeriesAligned(closes,14);
  const macdS = calcMACDSeries(closes);
  const bb = calcBollingerSeries(closes,20,2);
  const ema50 = calcEMASeries(closes,50);
  const stoch: (number|null)[] = new Array(closes.length).fill(null);
  for (let i = 50; i < closes.length; i++) { stoch[i] = calcStochRSI(closes.slice(0,i+1)).k; }
  const div: (string|null)[] = new Array(closes.length).fill(null);
  for (let i = 50; i < closes.length; i++) { if (i%3===0) div[i] = detectDivergence(closes.slice(0,i+1)); else div[i] = div[i-1]; }
  return {
    entry, closes, rsi: rsiS, macdHist: macdS.histogram, bb, ema50, stoch, div,
    htfNear, htfFar,
    htfNearEMA: calcEMASeries(htfNear.map(x=>x.close),50),
    htfFarEMA:  calcEMASeries(htfFar.map(x=>x.close),50),
  };
}

function computeEntries(ctx: TFContext, tfKey: string, rule: any): number[] {
  const rcfg = rule.config || {};
  const side: "LONG"|"SHORT" = rcfg.forceSide || rule.stats?.side || "LONG";
  const required: string[] = rcfg.requiredConditions || [];
  const minScore = rcfg.minScore ?? 1;
  const entries: number[] = [];

  for (let i = 50; i < ctx.entry.length - 1; i++) {
    const price = ctx.closes[i];
    if (rcfg.candleReversalFilter) {
      if (i < 1) continue;
      const prevBull = ctx.entry[i-1].close >= ctx.entry[i-1].open;
      const currBull = ctx.entry[i].close >= ctx.entry[i].open;
      const rev = prevBull === currBull ? null : (!prevBull && currBull ? "UP_REVERSAL" : "DOWN_REVERSAL");
      const want = side === "LONG" ? "UP_REVERSAL" : "DOWN_REVERSAL";
      if (rev !== want) continue;
    }
    if (rcfg.emaPosFilter) {
      const e = ctx.ema50[i]; if (e==null) continue;
      const above = price >= e;
      if (rcfg.emaPosFilter === "above" && !above) continue;
      if (rcfg.emaPosFilter === "below" && above) continue;
    }
    if (rcfg.htfTrendFilter) {
      const mode = rcfg.htfTrendFilter.mode || rcfg.htfTrendFilter;
      const want = side === "LONG" ? "UP" : "DOWN";
      const t = ctx.entry[i].time + TF_MINUTES[tfKey]*60*1000 - 1;
      const ni = htfIdxAt(ctx.htfNear, t), fi = htfIdxAt(ctx.htfFar, t);
      const nt = ni>=0 ? trendFromEMA(ctx.htfNear[ni].close, ctx.htfNearEMA[ni]) : "FLAT";
      const ft = fi>=0 ? trendFromEMA(ctx.htfFar[fi].close, ctx.htfFarEMA[fi]) : "FLAT";
      if (mode === "near_match" && nt !== want) continue;
      if (mode === "far_match"  && ft !== want) continue;
      if (mode === "both_match" && (nt !== want || ft !== want)) continue;
    }
    const rsi = ctx.rsi[i], stK = ctx.stoch[i], mh = ctx.macdHist[i], pmh = i>0 ? ctx.macdHist[i-1] : null;
    const bbU = ctx.bb.upper[i], bbL = ctx.bb.lower[i];
    const dv = ctx.div[i];
    const conds: Record<string, boolean> = {
      stochExtreme:   stK !== null && (side==="LONG" ? stK < (rcfg.stochOSLevel ?? 5) : stK > (rcfg.stochOBLevel ?? 95)),
      rsiExtreme:     rsi !== null && (side==="LONG" ? rsi < (rcfg.rsiOSLevel ?? 25) : rsi > (rcfg.rsiOBLevel ?? 75)),
      divergence:     side==="LONG" ? dv === "BULLISH_DIV" : dv === "BEARISH_DIV",
      bollingerTouch: side==="LONG" ? (bbL!==null && price <= bbL) : (bbU!==null && price >= bbU),
      macdCross:      mh!==null && pmh!==null && (side==="LONG" ? ((pmh<0 && mh>=0) || mh>pmh) : ((pmh>0 && mh<=0) || mh<pmh)),
    };
    let fail = false;
    for (const k of required) if (!conds[k]) { fail = true; break; }
    if (fail) continue;
    if (!rcfg.candleReversalFilter && required.length === 0) {
      const n = Object.values(conds).filter(Boolean).length;
      if (n < minScore) continue;
    }
    entries.push(i);
  }
  return entries;
}

async function run() {
  console.log("=== rescue-rules ===");
  const verPath = join(__dirname, "..", "assets", "rules_verification.json");
  const hardPath = join(__dirname, "..", "assets", "hard_rules.json");
  const ver = JSON.parse(readFileSync(verPath, "utf8"));
  const hard = JSON.parse(readFileSync(hardPath, "utf8"));

  // Candidates: netPnL ≤ 500% OR WR < 50%
  const candidates = ver.results.filter((r: any) => r.fresh.netPnL <= 500 || r.fresh.winRate < 50);
  console.log(`Candidates: ${candidates.length} / ${ver.results.length}`);

  // Group by TF
  const byTF: Record<string, any[]> = {};
  for (const r of candidates) { (byTF[r.tfKey] ||= []).push(r); }

  const results: any[] = [];

  for (const tfKey of Object.keys(byTF)) {
    console.log(`\n[${tfKey}] building ctx + ${byTF[tfKey].length} rules`);
    const ctx = await buildTFContext(tfKey);
    console.log(`  entries=${ctx.entry.length}`);

    for (const ver_r of byTF[tfKey]) {
      // Reconstruct rule from hard_rules
      const tfRules = hard.tfs[tfKey]?.rules || [];
      const rule = tfRules.find((x: any) => x.rank === ver_r.rank);
      if (!rule) continue;
      const rcfg = rule.config || {};
      const side: "LONG"|"SHORT" = rcfg.forceSide || rule.stats?.side || "LONG";
      const lev = rcfg.leverage || 10;
      const maxHold = rcfg.maxHoldBars || 100;
      const feePerSide = 0.04;

      const entries = computeEntries(ctx, tfKey, rule);
      if (entries.length < 30) {
        results.push({ ...ver_r, bestCombo: null, reason: "too_few_entries", entryCount: entries.length });
        continue;
      }

      let best: any = null;
      const gridResults: any[] = [];
      for (const tp of TP_GRID) {
        for (const sl of SL_GRID) {
          if (tp < sl) continue; // RR < 1 skip
          let w=0, l=0, t=0;
          for (const idx of entries) {
            const r = simulate(ctx.entry, idx, ctx.closes[idx], side, tp, sl, maxHold);
            if (r === "WIN") w++; else if (r === "LOSS") l++; else t++;
          }
          const n = w+l+t;
          const gross = w*tp*lev - l*sl*lev;
          const fees = n*feePerSide*2*lev;
          const net = gross - fees;
          const wr = n>0 ? w/n*100 : 0;
          const exp = n>0 ? net/n : 0;
          const pf = l>0 ? (w*tp)/(l*sl) : (w>0 ? 999 : 0);
          const combo = { tp, sl, trades: n, winRate: +wr.toFixed(1), netPnL: Math.round(net), expectancy: +exp.toFixed(2), pf: +pf.toFixed(2) };
          gridResults.push(combo);
          if (!best || combo.netPnL > best.netPnL) best = combo;
        }
      }

      const curNet = ver_r.fresh.netPnL;
      const curWR = ver_r.fresh.winRate;
      let status: string;
      if (best.netPnL > Math.max(500, curNet * 1.5) && best.winRate >= 45) status = "RESCUED";
      else if (best.netPnL > curNet * 1.2) status = "IMPROVED";
      else status = "DEAD";

      results.push({
        tfKey, rank: rule.rank, label: rule.label || `${side} rank${rule.rank}`,
        side, lev, maxHold,
        required: rcfg.requiredConditions || [],
        htfFilter: rcfg.htfTrendFilter?.mode || rcfg.htfTrendFilter || null,
        current: { tpPct: rcfg.targetPct, slPct: rcfg.stopPct, trades: ver_r.fresh.trades, winRate: curWR, netPnL: curNet },
        best,
        status,
        entryCount: entries.length,
        grid: gridResults,
      });
      console.log(`  #${String(rule.rank).padStart(2)} ${side.padEnd(5)} cur(+${rcfg.targetPct}/-${rcfg.stopPct}) WR=${curWR}% NET=${curNet}% → best(+${best.tp}/-${best.sl}) WR=${best.winRate}% NET=${best.netPnL}% [${status}]`);
    }
  }

  const outPath = join(__dirname, "..", "assets", "rules_rescue.json");
  writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
  console.log(`\n✅ Wrote ${outPath}`);

  const byStatus: Record<string, number> = {};
  for (const r of results) byStatus[r.status || r.reason] = (byStatus[r.status || r.reason] || 0) + 1;
  console.log(`Status: ${JSON.stringify(byStatus)}`);

  // HTML
  writeFileSync(join(__dirname, "..", "assets", "rules_rescue_preview.html"), renderHTML({ results, byStatus }));
  console.log(`✅ Wrote rules_rescue_preview.html`);
}

function renderHTML(d: any): string {
  const statusColor: Record<string, string> = { RESCUED: "#4ade80", IMPROVED: "#fbbf24", DEAD: "#666", too_few_entries: "#444" };
  const sorted = [...d.results].sort((a: any, b: any) => {
    const order: Record<string, number> = { RESCUED: 3, IMPROVED: 2, DEAD: 1 };
    const sa = order[a.status] ?? 0, sb = order[b.status] ?? 0;
    if (sa !== sb) return sb - sa;
    return (b.best?.netPnL ?? -99999) - (a.best?.netPnL ?? -99999);
  });
  const rows = sorted.map((r: any, i: number) => {
    if (!r.best) return `<tr style="border-bottom:1px solid #2a2a2a;opacity:0.4;">
      <td style="padding:6px;color:#888;">${i+1}</td>
      <td colspan="11" style="padding:6px;color:#666;">${r.tfKey} #${r.rank} ${r.label} — skipped (${r.reason || 'n/a'}, entries=${r.entryCount})</td>
    </tr>`;
    const deltaNet = r.best.netPnL - r.current.netPnL;
    const deltaWR = r.best.winRate - r.current.winRate;
    const sc = statusColor[r.status] || "#666";
    return `<tr style="border-bottom:1px solid #2a2a2a;">
      <td style="padding:6px;color:#888;font-family:monospace;">${i+1}</td>
      <td style="padding:6px;"><span style="background:${sc};color:#000;padding:2px 8px;border-radius:2px;font-weight:800;font-size:10px;letter-spacing:1px;">${r.status}</span></td>
      <td style="padding:6px;font-family:monospace;color:#ddd;">${r.tfKey}</td>
      <td style="padding:6px;font-weight:700;color:${r.side==="LONG"?"#4ade80":"#f87171"};">${r.side}</td>
      <td style="padding:6px;color:#F4B860;font-family:monospace;font-size:10px;">${r.htfFilter||'-'}</td>
      <td style="padding:6px;color:#eee;font-size:11px;max-width:220px;">${r.label}</td>
      <td style="padding:6px;color:#aaa;font-family:monospace;font-size:10px;">${r.required.join('+')||'(any)'}</td>
      <td style="padding:6px;font-family:monospace;color:#888;">+${r.current.tpPct}/-${r.current.slPct}<br><span style="color:${r.current.winRate>=50?"#4ade80":"#ef4444"};">${r.current.winRate}%</span> / <span style="color:${r.current.netPnL>=0?"#4ade80":"#ef4444"};">${r.current.netPnL}%</span></td>
      <td style="padding:6px;font-family:monospace;color:#F4B860;font-weight:700;">+${r.best.tp}/-${r.best.sl}<br><span style="color:${r.best.winRate>=50?"#4ade80":"#fbbf24"};">${r.best.winRate}%</span> / <span style="color:${r.best.netPnL>=0?"#4ade80":"#ef4444"};">${r.best.netPnL}%</span></td>
      <td style="padding:6px;text-align:right;font-family:monospace;color:${deltaNet>=0?"#4ade80":"#ef4444"};">${deltaNet>=0?'+':''}${deltaNet}%<br><span style="font-size:10px;">${deltaWR>=0?'+':''}${deltaWR.toFixed(1)}% WR</span></td>
      <td style="padding:6px;text-align:right;font-family:monospace;color:#ccc;">${r.best.trades}</td>
      <td style="padding:6px;text-align:right;font-family:monospace;color:${r.best.pf>=2?"#4ade80":r.best.pf>=1.3?"#fbbf24":"#ef4444"};">${r.best.pf}</td>
    </tr>`;
  }).join("");
  const statuses = Object.entries(d.byStatus).map(([k,v]) => `<span style="background:${statusColor[k]||'#555'};color:#000;padding:4px 10px;border-radius:2px;font-weight:800;font-size:11px;letter-spacing:1px;">${k}: ${v}</span>`).join(" ");
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Rules Rescue — v4.3.20</title>
<style>
body{background:#121212;color:#eee;font-family:'Space Grotesk',system-ui,sans-serif;margin:0;padding:24px;}
h1{color:#F4B860;font-weight:800;letter-spacing:2px;margin:0 0 4px;}
.sub{color:#888;font-size:13px;margin-bottom:20px;}
table{width:100%;border-collapse:collapse;background:#1c1b1b;border-radius:4px;overflow:hidden;}
thead{background:#2a2a2a;}
thead th{padding:10px 6px;text-align:left;color:#F4B860;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;font-weight:700;}
tbody tr:hover{background:#242323;}
</style></head><body>
<h1>RULES RESCUE — Grid Search TP/SL</h1>
<div class="sub">Forward test 2.3Y · Grid TP [${TP_GRID.join(', ')}]% × SL [${SL_GRID.join(', ')}]% (RR ≥ 1)</div>
<div style="margin-bottom:24px;display:flex;gap:8px;flex-wrap:wrap;">${statuses}</div>
<p style="color:#888;font-size:12px;">
<strong style="color:#4ade80;">RESCUED</strong> = best NET > max(500%, cur × 1.5) & WR ≥ 45% —  TP/SL gốc đang sai, combo mới cứu được rule.
<strong style="color:#fbbf24;">IMPROVED</strong> = best NET > cur × 1.2 nhưng chưa đủ mạnh.
<strong style="color:#666;">DEAD</strong> = không combo nào cứu nổi, rule logic fundamentally broken.
</p>
<table>
<thead><tr><th>#</th><th>STATUS</th><th>TF</th><th>SIDE</th><th>HTF</th><th>LABEL</th><th>COND</th><th>CURRENT (TP/SL → WR/NET)</th><th>BEST (TP/SL → WR/NET)</th><th>Δ NET / Δ WR</th><th>N</th><th>PF</th></tr></thead>
<tbody>${rows}</tbody>
</table>
<div style="margin-top:32px;color:#666;font-size:11px;text-align:center;">btc-dashboard v4.3.20 · rescue grid search</div>
</body></html>`;
}

run();
