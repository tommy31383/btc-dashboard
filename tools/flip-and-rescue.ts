/**
 * flip-and-rescue.ts
 *
 * Với các rule có LOSS RATE > 70% (WR < 30%, N >= 30):
 *   - Compute entries với side GỐC của rule (giữ nguyên conditions)
 *   - Nhưng khi simulate: FLIP side (LONG → SHORT, SHORT → LONG)
 *   - Grid search TP/SL để tìm combo tốt nhất
 *
 * Logic: nếu entry signal đúng nhưng side sai, flip → WR sẽ cao.
 *
 * Output:
 *   - assets/flip_rescue.json
 *   - assets/flip_rescue_preview.html
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
// 2026-04-22: grid mở rộng — no RR filter (cover RR<1, SL rộng, TP dài swing)
const TP_GRID = [0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 7, 10, 15];
const SL_GRID = [0.5, 1, 1.5, 2, 3, 4, 5, 7, 10];

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
    all.unshift(...batch); endTime = batch[0].time - 1;
    await new Promise(r => setTimeout(r, 80));
  }
  const m = new Map<number, Candle>(); for (const c of all) m.set(c.time, c);
  return [...m.values()].sort((a,b) => a.time - b.time);
}
function htfIdxAt(arr: Candle[], t: number): number {
  let lo=0, hi=arr.length-1, ans=-1;
  while (lo<=hi) { const m=(lo+hi)>>1; if (arr[m].time<=t) { ans=m; lo=m+1; } else hi=m-1; }
  return ans;
}
function trendFromEMA(price: number, ema: number | null): "UP"|"DOWN"|"FLAT" {
  if (ema==null) return "FLAT";
  const d = (price-ema)/ema*100;
  return d>0.3 ? "UP" : d<-0.3 ? "DOWN" : "FLAT";
}
function simulate(c: Candle[], idx: number, entry: number, side: "LONG"|"SHORT", tp: number, sl: number, maxHold: number) {
  const tpP = side==="LONG" ? entry*(1+tp/100) : entry*(1-tp/100);
  const slP = side==="LONG" ? entry*(1-sl/100) : entry*(1+sl/100);
  for (let i=idx+1; i<Math.min(idx+1+maxHold, c.length); i++) {
    if (side==="LONG") { if (c[i].low<=slP) return "LOSS"; if (c[i].high>=tpP) return "WIN"; }
    else              { if (c[i].high>=slP) return "LOSS"; if (c[i].low<=tpP) return "WIN"; }
  }
  return "TIMEOUT";
}

interface TFContext {
  entry: Candle[]; closes: number[];
  rsi: (number|null)[]; macdHist: (number|null)[]; bb: any;
  ema50: (number|null)[]; stoch: (number|null)[]; div: (string|null)[];
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
  const stoch: (number|null)[] = new Array(closes.length).fill(null);
  for (let i=50; i<closes.length; i++) stoch[i] = calcStochRSI(closes.slice(0,i+1)).k;
  const div: (string|null)[] = new Array(closes.length).fill(null);
  for (let i=50; i<closes.length; i++) { if (i%3===0) div[i] = detectDivergence(closes.slice(0,i+1)); else div[i] = div[i-1]; }
  return {
    entry, closes, rsi: rsiS, macdHist: macdS.histogram, bb, ema50, stoch, div,
    htfNear, htfFar,
    htfNearEMA: calcEMASeries(htfNear.map(x=>x.close),50),
    htfFarEMA:  calcEMASeries(htfFar.map(x=>x.close),50),
  };
}

/** Compute entries giữ nguyên side conditions (LONG rule → check BULLISH etc) */
function computeEntries(ctx: TFContext, tfKey: string, rule: any): number[] {
  const rcfg = rule.config || {};
  const side: "LONG"|"SHORT" = rcfg.forceSide || rule.stats?.side || "LONG";
  const required: string[] = rcfg.requiredConditions || [];
  const minScore = rcfg.minScore ?? 1;
  const out: number[] = [];
  for (let i=50; i<ctx.entry.length-1; i++) {
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

async function run() {
  console.log("=== flip-and-rescue ===");
  const verPath = join(__dirname, "..", "assets", "rules_verification.json");
  const hardPath = join(__dirname, "..", "assets", "hard_rules.json");
  const ver = JSON.parse(readFileSync(verPath, "utf8"));
  const hard = JSON.parse(readFileSync(hardPath, "utf8"));

  // Candidates: WR < 30% AND N >= 30
  const candidates = ver.results.filter((r: any) => r.fresh.winRate < 30 && r.fresh.trades >= 30);
  console.log(`Loss>70% candidates: ${candidates.length} / ${ver.results.length}`);

  const byTF: Record<string, any[]> = {};
  for (const r of candidates) (byTF[r.tfKey] ||= []).push(r);

  const results: any[] = [];

  for (const tfKey of Object.keys(byTF)) {
    console.log(`\n[${tfKey}] building ctx + ${byTF[tfKey].length} rules`);
    const ctx = await buildTFContext(tfKey);
    console.log(`  entries=${ctx.entry.length}`);

    for (const ver_r of byTF[tfKey]) {
      const tfRules = hard.tfs[tfKey]?.rules || [];
      const rule = tfRules.find((x: any) => x.rank === ver_r.rank);
      if (!rule) continue;
      const rcfg = rule.config || {};
      const origSide: "LONG"|"SHORT" = rcfg.forceSide || rule.stats?.side || "LONG";
      const flipSide: "LONG"|"SHORT" = origSide === "LONG" ? "SHORT" : "LONG";
      const lev = rcfg.leverage || 10;
      const maxHold = rcfg.maxHoldBars || 100;

      const entries = computeEntries(ctx, tfKey, rule);
      if (entries.length < 30) {
        results.push({ tfKey, rank: rule.rank, label: rule.label, origSide, flipSide, flipStatus: "too_few_entries", entryCount: entries.length });
        continue;
      }

      let best: any = null;
      for (const tp of TP_GRID) {
        for (const sl of SL_GRID) {
          // no RR filter — cover RR<1 scalper setups
          let w=0, l=0, t=0;
          for (const idx of entries) {
            const r = simulate(ctx.entry, idx, ctx.closes[idx], flipSide, tp, sl, maxHold);
            if (r==="WIN") w++; else if (r==="LOSS") l++; else t++;
          }
          const n = w+l+t;
          const gross = w*tp*lev - l*sl*lev;
          const fees = n*0.08*lev;
          const net = gross - fees;
          const wr = n>0 ? w/n*100 : 0;
          const pf = l>0 ? (w*tp)/(l*sl) : (w>0 ? 999 : 0);
          const combo = { tp, sl, trades: n, winRate: +wr.toFixed(1), netPnL: Math.round(net), pf: +pf.toFixed(2) };
          if (!best || combo.netPnL > best.netPnL) best = combo;
        }
      }

      // Status
      let flipStatus: string;
      if (best.winRate >= 60 && best.netPnL > 1000) flipStatus = "FLIP_GOLD";
      else if (best.winRate >= 50 && best.netPnL > 500) flipStatus = "FLIP_SILVER";
      else if (best.winRate >= 45 && best.netPnL > 0) flipStatus = "FLIP_BRONZE";
      else flipStatus = "FLIP_JUNK";

      results.push({
        tfKey, rank: rule.rank, label: rule.label || `${origSide} rank${rule.rank}`,
        origSide, flipSide, lev, maxHold,
        required: rcfg.requiredConditions || [],
        htfFilter: rcfg.htfTrendFilter?.mode || rcfg.htfTrendFilter || null,
        original: { tp: rcfg.targetPct, sl: rcfg.stopPct, trades: ver_r.fresh.trades, winRate: ver_r.fresh.winRate, netPnL: ver_r.fresh.netPnL },
        flipped: best,
        flipStatus,
        entryCount: entries.length,
      });
      console.log(`  #${String(rule.rank).padStart(2)} ${origSide}→${flipSide} orig(WR=${ver_r.fresh.winRate}%) flip best(+${best.tp}/-${best.sl} WR=${best.winRate}% NET=${best.netPnL}%) [${flipStatus}]`);
    }
  }

  const byStatus: Record<string, number> = {};
  for (const r of results) byStatus[r.flipStatus] = (byStatus[r.flipStatus] || 0) + 1;
  console.log(`\n=== Summary ===`);
  console.log(JSON.stringify(byStatus, null, 2));

  const out = { generatedAt: new Date().toISOString(), byStatus, results };
  writeFileSync(join(__dirname, "..", "assets", "flip_rescue.json"), JSON.stringify(out, null, 2));
  writeFileSync(join(__dirname, "..", "assets", "flip_rescue_preview.html"), renderHTML(out));
  console.log(`\n✅ Wrote flip_rescue.json + .html`);
}

function renderHTML(d: any): string {
  const statusColor: Record<string, string> = { FLIP_GOLD:"#F4B860", FLIP_SILVER:"#C0C0C0", FLIP_BRONZE:"#CD7F32", FLIP_JUNK:"#555", too_few_entries:"#333" };
  const sorted = [...d.results].sort((a:any,b:any)=> (b.flipped?.netPnL ?? -99999) - (a.flipped?.netPnL ?? -99999));
  const rows = sorted.map((r:any, i:number) => {
    if (!r.flipped) return `<tr style="opacity:0.4;border-bottom:1px solid #2a2a2a;"><td colspan="12" style="padding:6px;color:#666;">${i+1}. ${r.tfKey} #${r.rank} ${r.label} — ${r.flipStatus}</td></tr>`;
    const sc = statusColor[r.flipStatus] || "#555";
    const deltaWR = r.flipped.winRate - r.original.winRate;
    return `<tr style="border-bottom:1px solid #2a2a2a;">
      <td style="padding:6px;color:#888;font-family:monospace;">${i+1}</td>
      <td style="padding:6px;"><span style="background:${sc};color:#000;padding:2px 8px;border-radius:2px;font-weight:800;font-size:10px;letter-spacing:1px;">${r.flipStatus.replace('FLIP_','')}</span></td>
      <td style="padding:6px;font-family:monospace;color:#ddd;">${r.tfKey}</td>
      <td style="padding:6px;color:#aaa;">${r.origSide}→<strong style="color:${r.flipSide==='LONG'?'#4ade80':'#f87171'};">${r.flipSide}</strong></td>
      <td style="padding:6px;color:#F4B860;font-family:monospace;font-size:10px;">${r.htfFilter||'-'}</td>
      <td style="padding:6px;color:#eee;font-size:11px;max-width:260px;">${r.label}</td>
      <td style="padding:6px;color:#aaa;font-family:monospace;font-size:10px;">${r.required.join('+')||'(any)'}</td>
      <td style="padding:6px;font-family:monospace;color:#888;">+${r.original.tp}/-${r.original.sl}<br><span style="color:#ef4444;">${r.original.winRate}%</span> / <span style="color:#ef4444;">${r.original.netPnL}%</span></td>
      <td style="padding:6px;font-family:monospace;font-weight:700;color:#F4B860;">+${r.flipped.tp}/-${r.flipped.sl}<br><span style="color:${r.flipped.winRate>=50?'#4ade80':'#fbbf24'};">${r.flipped.winRate}%</span> / <span style="color:${r.flipped.netPnL>=0?'#4ade80':'#ef4444'};">${r.flipped.netPnL>=0?'+':''}${r.flipped.netPnL}%</span></td>
      <td style="padding:6px;text-align:right;font-family:monospace;color:${deltaWR>=0?'#4ade80':'#ef4444'};">${deltaWR>=0?'+':''}${deltaWR.toFixed(1)}%</td>
      <td style="padding:6px;text-align:right;font-family:monospace;color:#ccc;">${r.flipped.trades}</td>
      <td style="padding:6px;text-align:right;font-family:monospace;color:${r.flipped.pf>=2?'#4ade80':r.flipped.pf>=1.3?'#fbbf24':'#ef4444'};">${r.flipped.pf}</td>
    </tr>`;
  }).join("");
  const statuses = Object.entries(d.byStatus).map(([k,v])=>`<span style="background:${statusColor[k]||'#555'};color:#000;padding:4px 10px;border-radius:2px;font-weight:800;font-size:11px;letter-spacing:1px;">${k.replace('FLIP_','')}: ${v}</span>`).join(" ");
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Flip Rescue</title>
<style>
body{background:#121212;color:#eee;font-family:'Space Grotesk',system-ui,sans-serif;margin:0;padding:24px;}
h1{color:#F4B860;font-weight:800;letter-spacing:2px;margin:0 0 4px;}
.sub{color:#888;font-size:13px;margin-bottom:20px;}
table{width:100%;border-collapse:collapse;background:#1c1b1b;border-radius:4px;overflow:hidden;}
thead{background:#2a2a2a;}
thead th{padding:10px 6px;text-align:left;color:#F4B860;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;font-weight:700;}
tbody tr:hover{background:#242323;}
</style></head><body>
<h1>FLIP & RESCUE — Đảo side + grid TP/SL</h1>
<div class="sub">Rule loss>70% (WR<30%) → flip side, grid search TP/SL · forward test 2.3Y</div>
<div style="margin-bottom:24px;display:flex;gap:8px;flex-wrap:wrap;">${statuses}</div>
<p style="color:#888;font-size:12px;">
<strong style="color:#F4B860;">GOLD</strong> = flip WR≥60% & NET>1000%. <strong style="color:#C0C0C0;">SILVER</strong> = WR≥50%. <strong style="color:#CD7F32;">BRONZE</strong> = WR≥45% & NET>0. <strong>JUNK</strong> = flip vẫn tệ.
</p>
<table>
<thead><tr><th>#</th><th>STATUS</th><th>TF</th><th>SIDE</th><th>HTF</th><th>LABEL</th><th>COND</th><th>ORIG</th><th>FLIPPED</th><th>Δ WR</th><th>N</th><th>PF</th></tr></thead>
<tbody>${rows}</tbody>
</table>
<div style="margin-top:32px;color:#666;font-size:11px;text-align:center;">btc-dashboard v4.3.20 · flip-rescue</div>
</body></html>`;
}

run();
