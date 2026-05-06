/**
 * backtest-grid-variants.ts (anh Tommy 2026-05-04)
 * Test 4 cải thiện Grid trading:
 *   BASE. spacing 0.5% (winner trước)
 *   A.    Trend-follow: chỉ BUY khi close > MA200(1d)
 *   B.    ATR-dynamic: spacing = 0.5 × ATR(14)/price (rolling)
 *   C.    Reset grid: khi giá vượt outer range +5%, close all + dịch grid
 *   D.    Combo: 50% cap Hedge01 + 50% cap Grid 0.5%
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const INITIAL_CAPITAL = 100000;
const QTY_BTC = 0.001;
const FEE_PER_SIDE_PCT = 0.05;
const MAINT_MARGIN_RATE = 0.004;

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }
interface Pos { entry: number; tp: number; openMs: number; }

function loadCache(tf: string): Candle[] { return JSON.parse(readFileSync(join(__dirname,"..",".cache",`binance-${tf}-3y.json`),"utf8")); }
function calcSMA(a: number[], p: number): (number|null)[] { const o: (number|null)[] = new Array(a.length).fill(null); if (a.length<p) return o; let s=0; for (let i=0;i<p;i++) s+=a[i]; o[p-1]=s/p; for (let i=p;i<a.length;i++){s+=a[i]-a[i-p]; o[i]=s/p;} return o; }
function calcATR(c: Candle[], p: number): (number|null)[] { const o: (number|null)[] = new Array(c.length).fill(null); if (c.length<=p) return o; const tr: number[] = new Array(c.length).fill(0); for (let i=1;i<c.length;i++) tr[i]=Math.max(c[i].high-c[i].low, Math.abs(c[i].high-c[i-1].close), Math.abs(c[i].low-c[i-1].close)); let s=0; for (let i=1;i<=p;i++) s+=tr[i]; o[p]=s/p; for (let i=p+1;i<c.length;i++) o[i]=(o[i-1]!*(p-1)+tr[i])/p; return o; }
function findIdx(arr: { time: number }[], t: number): number { let lo=0, hi=arr.length-1, ans=-1; while (lo<=hi){const m=(lo+hi)>>1; if (arr[m].time<=t){ans=m; lo=m+1;} else hi=m-1;} return ans; }

// ============ BASE / A / C grid (static range) ============
function runStaticGrid(name: string, c: Candle[], spacingPct: number, htfTrendFilter: boolean, c1d: Candle[], ma200_1d: (number|null)[], resetOnBreakout: boolean) {
  const P_MIN = 25000, P_MAX = 130000;
  const buildLevels = (pMin: number, pMax: number): number[] => {
    const lv: number[] = [];
    let p = pMin;
    while (p <= pMax) { lv.push(p); p *= 1 + spacingPct/100; }
    return lv;
  };
  let levels = buildLevels(P_MIN, P_MAX);
  let levelOpen = new Array(levels.length).fill(false);
  let positions: Pos[] = [];
  let wallet = INITIAL_CAPITAL;
  let totalFees=0, totalRealized=0, totalBuys=0, totalSells=0, resetCount=0;
  let liq=false, liqMs=0, peak=INITIAL_CAPITAL, trough=INITIAL_CAPITAL;
  let prevClose = c[0].close;

  for (let i=0;i<c.length;i++){
    const bar = c[i]; const ts = bar.time;
    // SELL TPs
    for (let pi=positions.length-1;pi>=0;pi--){
      const p = positions[pi];
      if (bar.high>=p.tp){
        const realized = QTY_BTC*(p.tp-p.entry);
        const fee = QTY_BTC*p.tp*(FEE_PER_SIDE_PCT/100);
        wallet += realized-fee; totalRealized += realized; totalFees += fee; totalSells++;
        for (let li=0;li<levels.length;li++) if (Math.abs(levels[li]-p.entry)/p.entry<0.001){levelOpen[li]=false; break;}
        positions.splice(pi,1);
      }
    }
    // RESET if reset enabled and price beyond outer +5%
    if (resetOnBreakout) {
      const outerHi = levels[levels.length-1] * 1.05;
      const outerLo = levels[0] * 0.95;
      if (bar.close > outerHi || bar.close < outerLo) {
        // Close all positions at market
        for (const p of positions) {
          const realized = QTY_BTC*(bar.close-p.entry);
          const fee = QTY_BTC*bar.close*(FEE_PER_SIDE_PCT/100);
          wallet += realized-fee; totalRealized += realized; totalFees += fee; totalSells++;
        }
        positions = []; resetCount++;
        const newCenter = bar.close;
        const newMin = newCenter*0.6, newMax = newCenter*1.6;
        levels = buildLevels(newMin, newMax);
        levelOpen = new Array(levels.length).fill(false);
      }
    }
    // BUY (with HTF filter if enabled)
    let buyEnabled = true;
    if (htfTrendFilter) {
      const idx1d = findIdx(c1d, ts);
      if (idx1d>=200) {
        const ma = ma200_1d[idx1d-1];
        if (ma!==null && c1d[idx1d-1].close <= ma) buyEnabled = false;
      } else buyEnabled = false;
    }
    if (buyEnabled) {
      for (let li=0;li<levels.length;li++){
        if (levelOpen[li]) continue;
        const lvl = levels[li];
        if (bar.low<=lvl && prevClose>lvl){
          const tp = lvl*(1+spacingPct/100);
          const fee = QTY_BTC*lvl*(FEE_PER_SIDE_PCT/100);
          positions.push({entry:lvl, tp, openMs:ts});
          levelOpen[li]=true;
          wallet -= fee; totalFees += fee; totalBuys++;
        }
      }
    }
    // Stats + LIQ
    let upnl=0; for (const p of positions) upnl += QTY_BTC*(bar.close-p.entry);
    const eq = wallet+upnl;
    if (eq>peak) peak=eq; if (eq<trough) trough=eq;
    if (positions.length>0){
      const totQ = positions.length*QTY_BTC;
      const mm = totQ*bar.close*MAINT_MARGIN_RATE;
      if (eq<=mm){liq=true; liqMs=ts; break;}
    }
    prevClose = bar.close;
  }
  const lastPrice = c[c.length-1].close;
  let upnl=0; for (const p of positions) upnl += QTY_BTC*(lastPrice-p.entry);
  const finalEq = wallet+upnl;
  const roi = ((finalEq-INITIAL_CAPITAL)/INITIAL_CAPITAL)*100;
  return {name, totalBuys, totalSells, openPos: positions.length, resetCount,
    totalRealized, totalFees, finalUpnl:upnl, finalEq, roi, maxDD:peak-trough, liquidated:liq};
}

// ============ B. ATR-dynamic grid (rolling) ============
function runATRDynamic(name: string, c: Candle[], k: number) {
  const closes = c.map(b=>b.close);
  const atr = calcATR(c, 14);
  let positions: Pos[] = [];
  let wallet = INITIAL_CAPITAL;
  let totalFees=0, totalRealized=0, totalBuys=0, totalSells=0;
  let liq=false, liqMs=0, peak=INITIAL_CAPITAL, trough=INITIAL_CAPITAL;
  let lastBuyPrice = c[0].close;

  for (let i=15;i<c.length;i++){
    const bar = c[i]; const ts = bar.time;
    const a = atr[i]; if (!a) continue;
    const spacing = k * a; // dynamic spacing in $
    // SELL TPs
    for (let pi=positions.length-1;pi>=0;pi--){
      const p = positions[pi];
      if (bar.high>=p.tp){
        const realized = QTY_BTC*(p.tp-p.entry);
        const fee = QTY_BTC*p.tp*(FEE_PER_SIDE_PCT/100);
        wallet += realized-fee; totalRealized += realized; totalFees += fee; totalSells++;
        positions.splice(pi,1);
      }
    }
    // BUY: when price drops by spacing from lastBuyPrice (or any previous level)
    if (bar.low <= lastBuyPrice - spacing) {
      const buyPrice = lastBuyPrice - spacing;
      const tp = buyPrice + spacing;
      const fee = QTY_BTC*buyPrice*(FEE_PER_SIDE_PCT/100);
      positions.push({entry:buyPrice, tp, openMs:ts});
      wallet -= fee; totalFees += fee; totalBuys++;
      lastBuyPrice = buyPrice;
    } else if (bar.close > lastBuyPrice + spacing) {
      // Re-anchor lastBuyPrice up if price runs up significantly
      lastBuyPrice = bar.close;
    }
    let upnl=0; for (const p of positions) upnl += QTY_BTC*(bar.close-p.entry);
    const eq = wallet+upnl;
    if (eq>peak) peak=eq; if (eq<trough) trough=eq;
    if (positions.length>0){
      const totQ = positions.length*QTY_BTC;
      const mm = totQ*bar.close*MAINT_MARGIN_RATE;
      if (eq<=mm){liq=true; liqMs=ts; break;}
    }
  }
  const lastPrice = c[c.length-1].close;
  let upnl=0; for (const p of positions) upnl += QTY_BTC*(lastPrice-p.entry);
  const finalEq = wallet+upnl;
  const roi = ((finalEq-INITIAL_CAPITAL)/INITIAL_CAPITAL)*100;
  return {name, totalBuys, totalSells, openPos: positions.length, resetCount: 0,
    totalRealized, totalFees, finalUpnl:upnl, finalEq, roi, maxDD:peak-trough, liquidated:liq};
}

// ============ D. Combo Hedge01 + Grid (50/50) ============
// Hedge01 = score profile gom 8 setups (skip implementation, dùng kết quả backtest đã chạy: ROI +8.70%, DD $32k)
// Combo = 50% cap × Hedge01 ROI + 50% cap × Grid ROI
function comboEstimate(gridROI: number, gridDD: number) {
  const HEDGE01_ROI = 8.70; // %, backtest 3y
  const HEDGE01_DD = 32000; // $, backtest 3y
  // 50/50 split
  const hedge01_pnl = (INITIAL_CAPITAL/2) * HEDGE01_ROI/100;
  const grid_pnl = (INITIAL_CAPITAL/2) * gridROI/100;
  const totalPnl = hedge01_pnl + grid_pnl;
  const totalROI = totalPnl/INITIAL_CAPITAL*100;
  const totalDD = (HEDGE01_DD/2) + (gridDD/2); // combined DD assumption
  return { totalROI, totalDD, hedge01_pnl, grid_pnl };
}

function main() {
  console.log("[grid-variants] Loading...");
  const c = loadCache("5m"); const c1d = loadCache("1d");
  const ma200_1d = calcSMA(c1d.map(b=>b.close), 200);

  const results: any[] = [];
  // BASELINE
  console.log("\n--- BASELINE: spacing 0.5% no filter ---");
  const r0 = runStaticGrid("BASELINE 0.5%", c, 0.5, false, c1d, ma200_1d, false); results.push(r0);
  console.log(`  ROI ${r0.roi.toFixed(2)}% · BUYs ${r0.totalBuys} · SELLs ${r0.totalSells} · open ${r0.openPos} · DD $${r0.maxDD.toFixed(0)}`);

  // A. HTF trend filter
  console.log("\n--- A. HTF trend filter (BUY only when BTC > MA200d) ---");
  const rA = runStaticGrid("A. HTF trend filter", c, 0.5, true, c1d, ma200_1d, false); results.push(rA);
  console.log(`  ROI ${rA.roi.toFixed(2)}% · BUYs ${rA.totalBuys} · SELLs ${rA.totalSells} · open ${rA.openPos} · DD $${rA.maxDD.toFixed(0)}`);

  // B. ATR dynamic
  console.log("\n--- B. ATR-dynamic spacing (k=0.5) ---");
  const rB05 = runATRDynamic("B1. ATR k=0.5", c, 0.5); results.push(rB05);
  console.log(`  ROI ${rB05.roi.toFixed(2)}% · BUYs ${rB05.totalBuys} · SELLs ${rB05.totalSells} · open ${rB05.openPos} · DD $${rB05.maxDD.toFixed(0)}`);
  const rB1 = runATRDynamic("B2. ATR k=1.0", c, 1.0); results.push(rB1);
  console.log(`  ROI ${rB1.roi.toFixed(2)}% · BUYs ${rB1.totalBuys} · SELLs ${rB1.totalSells} · open ${rB1.openPos} · DD $${rB1.maxDD.toFixed(0)}`);
  const rB2 = runATRDynamic("B3. ATR k=2.0", c, 2.0); results.push(rB2);
  console.log(`  ROI ${rB2.roi.toFixed(2)}% · BUYs ${rB2.totalBuys} · SELLs ${rB2.totalSells} · open ${rB2.openPos} · DD $${rB2.maxDD.toFixed(0)}`);

  // C. Reset on breakout
  console.log("\n--- C. Reset grid on breakout (+5% outer) ---");
  const rC = runStaticGrid("C. Reset on breakout", c, 0.5, false, c1d, ma200_1d, true); results.push(rC);
  console.log(`  ROI ${rC.roi.toFixed(2)}% · BUYs ${rC.totalBuys} · SELLs ${rC.totalSells} · open ${rC.openPos} · resets ${rC.resetCount} · DD $${rC.maxDD.toFixed(0)}`);

  // D. Combo (estimate from baseline grid + Hedge01 known stats)
  console.log("\n--- D. Combo 50% Hedge01 + 50% Grid ---");
  const rD = comboEstimate(r0.roi, r0.maxDD);
  console.log(`  Estimate: ROI ${rD.totalROI.toFixed(2)}% · DD ~$${rD.totalDD.toFixed(0)} (Hedge01 +$${rD.hedge01_pnl.toFixed(0)} + Grid +$${rD.grid_pnl.toFixed(0)})`);

  // Sort
  console.log("\n=== SORTED BY ROI ===");
  results.sort((a,b)=>b.roi-a.roi);
  console.log("Setup                              BUYs   SELLs  Open  Realized   Fees    EQUITY      ROI%       DD$       LIQ");
  for (const r of results){
    console.log(`${r.name.padEnd(32)}${r.totalBuys.toString().padStart(7)}  ${r.totalSells.toString().padStart(5)}  ${r.openPos.toString().padStart(4)}  ${('$'+r.totalRealized.toFixed(0)).padStart(9)}  ${('$'+r.totalFees.toFixed(0)).padStart(7)}  ${('$'+r.finalEq.toFixed(0)).padStart(10)}  ${(r.roi>=0?'+':'')+r.roi.toFixed(2).padStart(7)}%  $${r.maxDD.toFixed(0).padStart(7)}  ${r.liquidated?"YES":"NO"}`);
  }
  console.log(`\nD. Combo (estimate): ROI ${rD.totalROI.toFixed(2)}% · DD ~$${rD.totalDD.toFixed(0)}`);

  writeFileSync(join(__dirname,"..","assets","backtest_grid_variants_3y.json"), JSON.stringify({results, comboEstimate: rD}));
  console.log("\nSaved → assets/backtest_grid_variants_3y.json");
}
main();
