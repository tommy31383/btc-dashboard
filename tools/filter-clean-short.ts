/**
 * filter-clean-short.ts (anh Tommy 2026-05-04)
 * Filter SHORT signals score≥9: chỉ giữ entry mà từ đó đến hit TP5%, giá không tăng quá 3% (MAE ≤ 3%).
 * → "clean SHORT" = không bị giao dịch ngược trước khi xuống TP.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const TP_PCT = 5;
const MAX_ADVERSE_PCT = 3;
const FORWARD_BARS_15M = 96 * 7; // 7d max horizon

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }

function loadCache(tf: string): Candle[] { return JSON.parse(readFileSync(join(__dirname,"..",".cache",`binance-${tf}-3y.json`),"utf8")); }
function calcSMA(a: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); if (a.length<p) return o; let s=0; for (let i=0;i<p;i++) s+=a[i]; o[p-1]=s/p; for (let i=p;i<a.length;i++){s+=a[i]-a[i-p]; o[i]=s/p;} return o; }
function calcEMA(a: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); if (a.length<p) return o; const k=2/(p+1); let e=0; for (let i=0;i<p;i++) e+=a[i]; e/=p; o[p-1]=e; for (let i=p;i<a.length;i++){e=a[i]*k+e*(1-k); o[i]=e;} return o; }
function calcStdev(a: number[], p: number, sma: (number|null)[]): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); for (let i=p-1;i<a.length;i++){const m=sma[i]; if (m===null) continue; let sq=0; for (let j=i-p+1;j<=i;j++) sq+=(a[j]-m)**2; o[i]=Math.sqrt(sq/p);} return o; }
function calcRSI(c: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(c.length).fill(null); if (c.length<=p) return o; let g=0,l=0; for (let i=1;i<=p;i++){const ch=c[i]-c[i-1]; if (ch>=0) g+=ch; else l-=ch;} let ag=g/p, al=l/p; o[p]=al===0?100:100-100/(1+ag/al); for (let i=p+1;i<c.length;i++){const ch=c[i]-c[i-1]; ag=(ag*(p-1)+Math.max(ch,0))/p; al=(al*(p-1)+Math.max(-ch,0))/p; o[i]=al===0?100:100-100/(1+ag/al);} return o; }
function calcStochK(c: Candle[], p: number): (number|null)[] { const o: (number|null)[] = new Array(c.length).fill(null); for (let i=p-1;i<c.length;i++){let hi=-Infinity, lo=Infinity; for (let j=i-p+1;j<=i;j++){if (c[j].high>hi) hi=c[j].high; if (c[j].low<lo) lo=c[j].low;} o[i]=hi===lo?50:((c[i].close-lo)/(hi-lo))*100;} return o; }
function calcATR(c: Candle[], p: number): (number|null)[] { const o: (number|null)[] = new Array(c.length).fill(null); if (c.length<=p) return o; const tr: number[] = new Array(c.length).fill(0); for (let i=1;i<c.length;i++) tr[i]=Math.max(c[i].high-c[i].low, Math.abs(c[i].high-c[i-1].close), Math.abs(c[i].low-c[i-1].close)); let s=0; for (let i=1;i<=p;i++) s+=tr[i]; o[p]=s/p; for (let i=p+1;i<c.length;i++) o[i]=(o[i-1]!*(p-1)+tr[i])/p; return o; }
function calcMACDHist(c: number[]): (number|null)[] { const e12=calcEMA(c,12), e26=calcEMA(c,26); const macd: (number|null)[] = c.map((_,i) => (e12[i]!=null && e26[i]!=null) ? e12[i]!-e26[i]! : null); const v: number[]=[], m: number[]=[]; for (let i=0;i<macd.length;i++) if (macd[i]!==null){v.push(macd[i]!); m.push(i);} const sigEma = calcEMA(v, 9); const signal: (number|null)[] = new Array(c.length).fill(null); for (let k=0;k<sigEma.length;k++) if (sigEma[k]!==null) signal[m[k]] = sigEma[k]; return c.map((_,i) => (macd[i]!=null && signal[i]!=null) ? macd[i]!-signal[i]! : null); }
function pct(x: number[], q: number) { if (x.length===0) return NaN; const s=[...x].sort((a,b)=>a-b); return s[Math.min(Math.floor(s.length*q), s.length-1)]; }
function mean(x: number[]) { return x.length ? x.reduce((s,v)=>s+v,0)/x.length : NaN; }

function main() {
  const c = loadCache("15m");
  const c5 = loadCache("5m");
  const closes = c.map(b=>b.close);
  const rsi = calcRSI(closes, 14);
  const stochK = calcStochK(c, 14);
  const macdH = calcMACDHist(closes);
  const ma50 = calcSMA(closes, 50);
  const ma20 = calcSMA(closes, 20);
  const sd20 = calcStdev(closes, 20, ma20);
  const atr14 = calcATR(c, 14);
  const vols = c.map(b=>b.volume??0);
  const volMA = calcSMA(vols, 20);

  // Build all SHORT signals score≥9
  const shortIdx: number[] = [];
  for (let i=20;i<c.length;i++){
    const b = c[i];
    const upW = (b.high-Math.max(b.open,b.close))/b.open*100;
    const body = Math.abs(b.close-b.open)/b.open*100;
    const isBull = b.close>b.open ? 1 : 0;
    const volR = volMA[i] && volMA[i]!>0 ? (b.volume??0)/volMA[i]! : 0;
    const ma=ma20[i], sd=sd20[i];
    const bbPos = (ma!==null && sd!==null && sd>0) ? (b.close-(ma-2*sd))/(4*sd)*100 : 50;
    const mom5 = i>=5 ? (b.close-c[i-5].close)/c[i-5].close*100 : 0;
    const mom10 = i>=10 ? (b.close-c[i-10].close)/c[i-10].close*100 : 0;
    const mom20 = i>=20 ? (b.close-c[i-20].close)/c[i-20].close*100 : 0;
    const atr = atr14[i]; const range = b.high-b.low;
    const atrR = atr && atr>0 ? range/atr : 0;
    const distMA50 = ma50[i] && ma50[i]!>0 ? (b.close-ma50[i]!)/ma50[i]!*100 : 0;
    const r = rsi[i] ?? 50;
    const sk = stochK[i] ?? 50;
    const mh = macdH[i] ?? 0;
    let sS=0;
    if (upW>=0.5) sS++; if (body>=0.5) sS++; if (isBull===1) sS++; if (volR>=2.0) sS++; if (atrR>=1.5) sS++; if (r>=65) sS++; if (sk>=70) sS++; if (mh>=100) sS++; if (bbPos>=95) sS++; if (distMA50>=3) sS++; if (mom5>0&&mom10>0&&mom20>0) sS++;
    if (sS>=9) shortIdx.push(i);
  }
  console.log(`Total SHORT signals score≥9: ${shortIdx.length}`);

  // Filter clean shorts: from entry close, before hit TP5% (price drops 5%), MAE (max rise) ≤ 3%
  const clean: { ts: number; entry: number; tpHitTs: number; tpHitBars: number; mae: number }[] = [];
  const dirty_hitTPbutHighMAE: any[] = [];
  const dirty_neverHitTP: any[] = [];
  for (const idx of shortIdx) {
    const entry = c[idx].close;
    const tpTarget = entry * (1 - TP_PCT/100);
    const maxAdverseTarget = entry * (1 + MAX_ADVERSE_PCT/100);
    let mae = 0;
    let hitTPidx = -1;
    let stoppedByAdverse = false;
    const limit = Math.min(c.length, idx + 1 + FORWARD_BARS_15M);
    for (let j=idx+1; j<limit; j++) {
      // Check adverse first (high)
      if (c[j].high >= maxAdverseTarget) {
        // Stop tracking — exceeded 3% rise, this is dirty
        const adverse = (c[j].high - entry)/entry*100;
        if (adverse > mae) mae = adverse;
        stoppedByAdverse = true;
        break;
      }
      const adverse = (c[j].high - entry)/entry*100;
      if (adverse > mae) mae = adverse;
      // Check TP hit (low)
      if (c[j].low <= tpTarget) {
        hitTPidx = j;
        break;
      }
    }
    if (hitTPidx >= 0 && !stoppedByAdverse) {
      clean.push({ts: c[idx].time, entry, tpHitTs: c[hitTPidx].time, tpHitBars: hitTPidx - idx, mae});
    } else if (stoppedByAdverse) {
      dirty_hitTPbutHighMAE.push({ts: c[idx].time, entry, mae});
    } else {
      dirty_neverHitTP.push({ts: c[idx].time, entry, mae});
    }
  }

  console.log(`\n=== FILTER RESULTS (TP=${TP_PCT}%, max adverse=${MAX_ADVERSE_PCT}%) ===`);
  console.log(`✅ CLEAN: ${clean.length} (${(clean.length/shortIdx.length*100).toFixed(1)}%)`);
  console.log(`❌ Dirty (giá vượt +${MAX_ADVERSE_PCT}% trước khi TP): ${dirty_hitTPbutHighMAE.length}`);
  console.log(`❌ Never hit TP trong ${FORWARD_BARS_15M*0.25}h: ${dirty_neverHitTP.length}`);

  if (clean.length>0) {
    const maeArr = clean.map(c=>c.mae).sort((a,b)=>a-b);
    const hitArr = clean.map(c=>c.tpHitBars).sort((a,b)=>a-b);
    console.log(`\nCLEAN MAE: mean=${mean(maeArr).toFixed(2)}%  med=${pct(maeArr,0.5).toFixed(2)}%  p75=${pct(maeArr,0.75).toFixed(2)}%  p90=${pct(maeArr,0.9).toFixed(2)}%`);
    console.log(`CLEAN time to TP: median=${pct(hitArr,0.5)} bars 15m = ${(pct(hitArr,0.5)*0.25).toFixed(1)}h  p75=${(pct(hitArr,0.75)*0.25).toFixed(1)}h`);

    // EV per clean trade
    const totalEV = clean.length * TP_PCT;  // mỗi clean trade = full TP%
    console.log(`\nEV nếu trade chỉ clean: ${clean.length} × ${TP_PCT}% = ${totalEV}% theo notional (notional × ${totalEV/100}x)`);
    console.log(`Real WR: 100% (nếu giá ko cross adverse threshold thì sure hit TP)`);
  }

  // Build output for chart
  const cleanSet = new Set(clean.map(c=>c.ts));
  const shortMarkers = shortIdx.map(idx => ({
    ts: c[idx].time, price: c[idx].close, high: c[idx].high,
    isClean: cleanSet.has(c[idx].time),
  }));

  const priceLine: { ts: number; price: number }[] = [];
  const step = 10;
  for (let i=0;i<c5.length;i+=step) priceLine.push({ts:c5[i].time, price:c5[i].close});

  writeFileSync(join(__dirname,"..","assets","clean_short_score9.json"), JSON.stringify({
    period:{start:c5[0].time, end:c5[c5.length-1].time},
    config:{tpPct:TP_PCT, maxAdversePct:MAX_ADVERSE_PCT},
    totalShorts: shortIdx.length, cleanCount: clean.length,
    dirtyHitButHighMAE: dirty_hitTPbutHighMAE.length, dirtyNeverHitTP: dirty_neverHitTP.length,
    cleanRatio: clean.length/shortIdx.length,
    shortMarkers, priceLine,
  }));
  console.log("\nSaved → assets/clean_short_score9.json");
}
main();
