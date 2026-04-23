/**
 * test-fixed-tpsl.ts
 *
 * Test TOÀN BỘ 92 rule trong hard_rules.json với TP/SL CỐ ĐỊNH (mặc định TP=3%, SL=5%, RR=0.6).
 *   - Native rule (requiredConditions): reuse computeEntries từ rescue logic
 *   - Golden rule (delegatedTo=useRiskRadar): evaluate feature-based
 *
 * Chạy: npx tsx tools/test-fixed-tpsl.ts [--tp=3] [--sl=5]
 *
 * Output:
 *   - assets/fixed_tpsl_test.json
 *   - assets/fixed_tpsl_test_preview.html
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { calcStochRSI, detectDivergence, calcEMASeries, calcRSISeriesAligned, calcMACDSeries, calcBollingerSeries, calcATRPct } from "../utils/indicators";

// ─── CLI args ───
const argTP = process.argv.find(a => a.startsWith("--tp="));
const argSL = process.argv.find(a => a.startsWith("--sl="));
const FIXED_TP = argTP ? parseFloat(argTP.split("=")[1]) : 3;
const FIXED_SL = argSL ? parseFloat(argSL.split("=")[1]) : 5;

console.log(`=== test-fixed-tpsl · TP=+${FIXED_TP}% / SL=-${FIXED_SL}% (RR=${(FIXED_TP/FIXED_SL).toFixed(2)}) ===`);

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
  entry: Candle[]; closes: number[];
  rsi: (number|null)[]; macdHist: (number|null)[];
  bb: any; ema50: (number|null)[]; ema20: (number|null)[];
  stoch: (number|null)[]; div: (string|null)[];
  atrPct: (number|null)[];
  htfNear: Candle[]; htfFar: Candle[];
  htfNearEMA: (number|null)[]; htfFarEMA: (number|null)[];
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
  const ema20 = calcEMASeries(closes,20);

  // ATR% pre-compute (rolling window)
  const atrPct: (number|null)[] = new Array(closes.length).fill(null);
  for (let i = 20; i < closes.length; i++) {
    atrPct[i] = calcATRPct(entry.slice(0, i+1), 14);
  }

  const stoch: (number|null)[] = new Array(closes.length).fill(null);
  for (let i = 50; i < closes.length; i++) stoch[i] = calcStochRSI(closes.slice(0,i+1)).k;
  const div: (string|null)[] = new Array(closes.length).fill(null);
  for (let i = 50; i < closes.length; i++) { if (i%3===0) div[i] = detectDivergence(closes.slice(0,i+1)); else div[i] = div[i-1]; }
  return {
    entry, closes, rsi: rsiS, macdHist: macdS.histogram, bb, ema50, ema20, stoch, div, atrPct,
    htfNear, htfFar,
    htfNearEMA: calcEMASeries(htfNear.map(x=>x.close),50),
    htfFarEMA:  calcEMASeries(htfFar.map(x=>x.close),50),
  };
}

// ─── Native rule entries (requiredConditions) ───
function computeEntriesNative(ctx: TFContext, tfKey: string, rule: any): number[] {
  const rcfg = rule.config || {};
  const side: "LONG"|"SHORT" = rcfg.forceSide || rule.stats?.side || "LONG";
  const required: string[] = rcfg.requiredConditions || [];
  const minScore = rcfg.minScore ?? 1;
  const out: number[] = [];
  for (let i = 50; i < ctx.entry.length - 1; i++) {
    const price = ctx.closes[i];
    if (rcfg.candleReversalFilter) {
      if (i<1) continue;
      const prevBull = ctx.entry[i-1].close >= ctx.entry[i-1].open;
      const currBull = ctx.entry[i].close >= ctx.entry[i].open;
      const rev = prevBull===currBull ? null : (!prevBull && currBull ? "UP_REVERSAL" : "DOWN_REVERSAL");
      const want = side==="LONG" ? "UP_REVERSAL" : "DOWN_REVERSAL";
      if (rev !== want) continue;
    }
    if (rcfg.emaPosFilter) {
      const e = ctx.ema50[i]; if (e==null) continue;
      const above = price >= e;
      if (rcfg.emaPosFilter==="above" && !above) continue;
      if (rcfg.emaPosFilter==="below" && above) continue;
    }
    if (rcfg.htfTrendFilter) {
      const mode = rcfg.htfTrendFilter.mode || rcfg.htfTrendFilter;
      const want = side==="LONG" ? "UP" : "DOWN";
      const t = ctx.entry[i].time + TF_MINUTES[tfKey]*60*1000 - 1;
      const ni = htfIdxAt(ctx.htfNear, t), fi = htfIdxAt(ctx.htfFar, t);
      const nt = ni>=0 ? trendFromEMA(ctx.htfNear[ni].close, ctx.htfNearEMA[ni]) : "FLAT";
      const ft = fi>=0 ? trendFromEMA(ctx.htfFar[fi].close, ctx.htfFarEMA[fi]) : "FLAT";
      if (mode==="near_match" && nt!==want) continue;
      if (mode==="far_match"  && ft!==want) continue;
      if (mode==="both_match" && (nt!==want || ft!==want)) continue;
    }
    const rsi = ctx.rsi[i], stK = ctx.stoch[i], mh = ctx.macdHist[i], pmh = i>0 ? ctx.macdHist[i-1] : null;
    const bbU = ctx.bb.upper[i], bbL = ctx.bb.lower[i];
    const dv = ctx.div[i];
    const conds: Record<string, boolean> = {
      stochExtreme:   stK!==null && (side==="LONG" ? stK < (rcfg.stochOSLevel ?? 5) : stK > (rcfg.stochOBLevel ?? 95)),
      rsiExtreme:     rsi!==null && (side==="LONG" ? rsi < (rcfg.rsiOSLevel ?? 25) : rsi > (rcfg.rsiOBLevel ?? 75)),
      divergence:     side==="LONG" ? dv==="BULLISH_DIV" : dv==="BEARISH_DIV",
      bollingerTouch: side==="LONG" ? (bbL!==null && price<=bbL) : (bbU!==null && price>=bbU),
      macdCross:      mh!==null && pmh!==null && (side==="LONG" ? ((pmh<0 && mh>=0) || mh>pmh) : ((pmh>0 && mh<=0) || mh<pmh)),
    };
    let fail = false;
    for (const k of required) if (!conds[k]) { fail = true; break; }
    if (fail) continue;
    if (!rcfg.candleReversalFilter && required.length===0) {
      const n = Object.values(conds).filter(Boolean).length;
      if (n < minScore) continue;
    }
    out.push(i);
  }
  return out;
}

// ─── Golden rule entries (feature-based) ───
// Only 1h TF; features từ useRiskRadar
function computeEntriesGolden(ctx: TFContext, rule: any): number[] {
  const rcfg = rule.config || {};
  const features: string[] = rcfg.features || [];
  const htfState: "FLAT"|"DOWN" = rcfg.htfTrendFilter?.state || "FLAT";
  const side: "LONG"|"SHORT" = rcfg.forceSide || "LONG";
  const out: number[] = [];

  for (let i = 50; i < ctx.entry.length - 1; i++) {
    const price = ctx.closes[i];
    const mh = ctx.macdHist[i];
    const e20 = ctx.ema20[i], e50 = ctx.ema50[i];
    const atr = ctx.atrPct[i];
    const bbU = ctx.bb.upper[i], bbL = ctx.bb.lower[i], bbM = ctx.bb.middle[i];
    const bodyPct = (Math.abs(ctx.entry[i].close - ctx.entry[i].open) / ctx.entry[i].open) * 100;

    // HTF 4h state
    const t = ctx.entry[i].time + TF_MINUTES["1h"]*60*1000 - 1;
    const ni = htfIdxAt(ctx.htfNear, t);
    const htfTrend = ni>=0 ? trendFromEMA(ctx.htfNear[ni].close, ctx.htfNearEMA[ni]) : "FLAT";
    if (htfTrend !== htfState) continue;

    const emaDist = (e50!==null && e50!==0) ? ((price-e50)/e50)*100 : null;
    const bbWidth = (bbU!==null && bbL!==null && bbM!==null && bbM!==0) ? ((bbU-bbL)/bbM)*100 : null;

    let ok = true;
    for (const f of features) {
      if (f === "macdBull")       { if (!(mh !== null && mh >= 0 && mh < 50)) { ok=false; break; } }
      else if (f === "macdBear")  { if (!(mh !== null && mh < 0 && mh > -50)) { ok=false; break; } }
      else if (f === "emaNear")   { if (!(emaDist !== null && Math.abs(emaDist) < 0.5)) { ok=false; break; } }
      else if (f === "atrLow")    { if (!(atr !== null && atr < 0.3)) { ok=false; break; } }
      else if (f === "emaCrossBull") { if (!(e20!==null && e50!==null && e20 > e50)) { ok=false; break; } }
      else if (f === "emaCrossBear") { if (!(e20!==null && e50!==null && e20 < e50)) { ok=false; break; } }
      else if (f === "bodySmall") { if (!(bodyPct < 0.1)) { ok=false; break; } }
      else if (f === "bbSqueeze") { if (!(bbWidth !== null && bbWidth < 1.5)) { ok=false; break; } }
      else { ok=false; break; }
    }
    if (!ok) continue;
    out.push(i);
  }
  return out;
}

async function run() {
  const hardPath = join(__dirname, "..", "assets", "hard_rules.json");
  const hard = JSON.parse(readFileSync(hardPath, "utf8"));

  const tfKeys = Object.keys(hard.tfs);
  const results: any[] = [];

  for (const tfKey of tfKeys) {
    const rules = (hard.tfs[tfKey]?.rules || []);
    if (!rules.length) continue;
    console.log(`\n[${tfKey}] building ctx + ${rules.length} rules`);
    const ctx = await buildTFContext(tfKey);
    console.log(`  entries=${ctx.entry.length}`);

    for (const rule of rules) {
      const rcfg = rule.config || {};
      const side: "LONG"|"SHORT" = rcfg.forceSide || rule.stats?.side || "LONG";
      const lev = rcfg.leverage || 10;
      const maxHold = rcfg.maxHoldBars || 100;
      const isGolden = rcfg.delegatedTo === "useRiskRadar" || rule.source === "golden-riskRadar";
      const isDisabled = rcfg.disabled === true;

      let entries: number[];
      if (isGolden) {
        if (tfKey !== "1h") { continue; }
        entries = computeEntriesGolden(ctx, rule);
      } else {
        entries = computeEntriesNative(ctx, tfKey, rule);
      }

      if (entries.length === 0) {
        results.push({ tfKey, rank: rule.rank, label: rule.label||`${side} rank${rule.rank}`, side, isGolden, isDisabled, entryCount: 0, fresh: null, note: "no_entries" });
        continue;
      }

      let w=0, l=0, t=0;
      for (const idx of entries) {
        const r = simulate(ctx.entry, idx, ctx.closes[idx], side, FIXED_TP, FIXED_SL, maxHold);
        if (r==="WIN") w++; else if (r==="LOSS") l++; else t++;
      }
      const n = w+l+t;
      const feePerSide = 0.04;
      const gross = w*FIXED_TP*lev - l*FIXED_SL*lev;
      const fees = n*feePerSide*2*lev;
      const net = gross - fees;
      const wr = n>0 ? w/n*100 : 0;
      const exp = n>0 ? net/n : 0;
      const pf = l>0 ? (w*FIXED_TP)/(l*FIXED_SL) : (w>0 ? 999 : 0);

      const oldWR = rule.stats?.winRate ?? null;
      const oldNet = rule.stats?.netPnL ?? null;

      const fresh = { trades: n, wins: w, losses: l, timeouts: t, winRate: +wr.toFixed(1), netPnL: Math.round(net), expectancy: +exp.toFixed(2), pf: +pf.toFixed(2) };
      const row: any = {
        tfKey, rank: rule.rank, label: rule.label || `${side} rank${rule.rank}`,
        side, isGolden, isDisabled, lev,
        origCfg: { tp: rcfg.targetPct, sl: rcfg.stopPct },
        origStats: { winRate: oldWR, netPnL: oldNet, trades: rule.stats?.trades ?? null },
        fixedTPSL: { tp: FIXED_TP, sl: FIXED_SL },
        fresh,
        entryCount: entries.length,
      };
      results.push(row);
      console.log(`  ${isGolden?'🥇':isDisabled?'✕ ':'  '} #${String(rule.rank).padStart(2)} ${side.padEnd(5)} N=${String(n).padStart(5)} WR=${String(fresh.winRate).padStart(5)}% NET=${String(fresh.netPnL).padStart(7)}% PF=${fresh.pf.toFixed(2)} ${rule.label?.slice(0,45) || ''}`);
    }
  }

  // Rank all by WR (filter N>=30)
  const ranked = [...results].filter(r=>r.fresh && r.fresh.trades>=30).sort((a,b)=>b.fresh.winRate - a.fresh.winRate);

  const summary = {
    fixed_tp: FIXED_TP, fixed_sl: FIXED_SL, rr: +(FIXED_TP/FIXED_SL).toFixed(2),
    total: results.length,
    withEntries: results.filter(r=>r.fresh).length,
    wr60plus: ranked.filter(r=>r.fresh.winRate>=60).length,
    wr70plus: ranked.filter(r=>r.fresh.winRate>=70).length,
    netPositive: ranked.filter(r=>r.fresh.netPnL>0).length,
    netNegative: ranked.filter(r=>r.fresh.netPnL<=0).length,
  };

  const out = { generatedAt: new Date().toISOString(), summary, results, ranked };
  writeFileSync(join(__dirname, "..", "assets", "fixed_tpsl_test.json"), JSON.stringify(out, null, 2));
  writeFileSync(join(__dirname, "..", "assets", "fixed_tpsl_test_preview.html"), renderHTML(out));
  console.log(`\n=== Summary ===`);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\n✅ Wrote assets/fixed_tpsl_test.json + .html`);
}

function renderHTML(d: any): string {
  const s = d.summary;
  const rows = d.ranked.map((r: any, i: number) => {
    const wr = r.fresh.winRate;
    const wrColor = wr>=70 ? "#4ade80" : wr>=60 ? "#86efac" : wr>=50 ? "#fbbf24" : wr>=40 ? "#fb923c" : "#ef4444";
    const netColor = r.fresh.netPnL>=0 ? "#4ade80" : "#ef4444";
    const srcBadge = r.isGolden ? `<span style="background:#F4B860;color:#000;padding:2px 6px;border-radius:2px;font-size:10px;font-weight:800;">GOLDEN</span>`
      : r.isDisabled ? `<span style="background:#4a2222;color:#ff9999;padding:2px 6px;border-radius:2px;font-size:10px;">DISABLED</span>`
      : `<span style="background:#353534;color:#aaa;padding:2px 6px;border-radius:2px;font-size:10px;">hard</span>`;
    const origWR = r.origStats.winRate !== null ? r.origStats.winRate.toFixed(1)+'%' : 'n/a';
    const origTPSL = r.origCfg.tp ? `+${r.origCfg.tp}/-${r.origCfg.sl}` : 'n/a';
    return `<tr style="border-bottom:1px solid #2a2a2a;">
      <td style="padding:6px;color:#888;font-family:monospace;">${i+1}</td>
      <td style="padding:6px;">${srcBadge}</td>
      <td style="padding:6px;font-family:monospace;color:#ddd;">${r.tfKey}</td>
      <td style="padding:6px;font-weight:700;color:${r.side==="LONG"?"#4ade80":"#f87171"};">${r.side}</td>
      <td style="padding:6px;color:#eee;font-size:11px;max-width:280px;">${r.label}</td>
      <td style="padding:6px;text-align:right;font-family:monospace;color:#888;font-size:10px;">${origTPSL}<br>${origWR}</td>
      <td style="padding:6px;text-align:right;font-family:monospace;font-weight:800;color:${wrColor};">${wr.toFixed(1)}%</td>
      <td style="padding:6px;text-align:right;font-family:monospace;color:#ccc;">${r.fresh.trades}</td>
      <td style="padding:6px;text-align:right;font-family:monospace;color:${netColor};">${r.fresh.netPnL>=0?'+':''}${r.fresh.netPnL}%</td>
      <td style="padding:6px;text-align:right;font-family:monospace;color:${r.fresh.pf>=2?"#4ade80":r.fresh.pf>=1.3?"#fbbf24":"#ef4444"};">${r.fresh.pf}</td>
    </tr>`;
  }).join("");

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Fixed TP/SL Test</title>
<style>
body{background:#121212;color:#eee;font-family:'Space Grotesk',system-ui,sans-serif;margin:0;padding:24px;}
h1{color:#F4B860;font-weight:800;letter-spacing:2px;margin:0 0 4px;}
.sub{color:#888;font-size:13px;margin-bottom:20px;}
table{width:100%;border-collapse:collapse;background:#1c1b1b;border-radius:4px;overflow:hidden;}
thead{background:#2a2a2a;}
thead th{padding:10px 6px;text-align:left;color:#F4B860;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;font-weight:700;}
tbody tr:hover{background:#242323;}
.stat{background:#1c1b1b;padding:10px 14px;border-left:3px solid #F4B860;border-radius:2px;}
.stat b{color:#F4B860;font-size:18px;display:block;}
.stat span{color:#888;font-size:11px;letter-spacing:1px;}
</style></head><body>
<h1>FIXED TP/SL TEST — TP +${s.fixed_tp}% / SL -${s.fixed_sl}% (RR ${s.rr})</h1>
<div class="sub">Generated ${new Date(d.generatedAt).toLocaleString("vi-VN")} · Toàn bộ ${s.total} rule + 11 Goldens · forward test 2.3Y</div>
<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px;">
  <div class="stat"><b>${s.total}</b><span>TOTAL RULES</span></div>
  <div class="stat"><b>${s.withEntries}</b><span>HAVE ENTRIES</span></div>
  <div class="stat" style="border-color:#4ade80;"><b style="color:#4ade80;">${s.wr70plus}</b><span>WR ≥ 70%</span></div>
  <div class="stat" style="border-color:#86efac;"><b style="color:#86efac;">${s.wr60plus}</b><span>WR ≥ 60%</span></div>
  <div class="stat" style="border-color:#4ade80;"><b style="color:#4ade80;">${s.netPositive}</b><span>NET > 0</span></div>
  <div class="stat" style="border-color:#ef4444;"><b style="color:#ef4444;">${s.netNegative}</b><span>NET ≤ 0</span></div>
</div>
<p style="color:#888;font-size:12px;">⚠ RR=${s.rr} (TP nhỏ hơn SL) → rule cần WR cao để net dương. Break-even WR ≈ ${(100*s.fixed_sl/(s.fixed_tp+s.fixed_sl)).toFixed(1)}%.</p>
<table>
<thead><tr><th>#</th><th>SRC</th><th>TF</th><th>SIDE</th><th>LABEL</th><th>ORIG TP/SL · WR</th><th>FIXED WR</th><th>N</th><th>NET</th><th>PF</th></tr></thead>
<tbody>${rows}</tbody>
</table>
<div style="margin-top:32px;color:#666;font-size:11px;text-align:center;">btc-dashboard v4.3.20 · fixed-tpsl-test</div>
</body></html>`;
}

run();
