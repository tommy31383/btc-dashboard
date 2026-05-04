/**
 * backtest-long-every-bar.ts (anh Tommy 2026-05-04)
 * Mỗi cây nến → ADD LONG. Khi net avg gain ≥ 50% → CLOSE ALL.
 * Test trên 5m, 15m, 1h, 4h.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const INITIAL_CAPITAL = 100000;
const QTY_BTC = 0.001;
const TP_PCT = 50;
const FEE_PER_SIDE_PCT = 0.05;
const MAINT_MARGIN_RATE = 0.004;

interface Candle { time: number; open: number; high: number; low: number; close: number; }
interface Net { qty: number; avg: number; }

function loadCache(tf: string): Candle[] { return JSON.parse(readFileSync(join(__dirname,"..",".cache",`binance-${tf}-3y.json`),"utf8")); }
function addNet(n: Net, q: number, p: number): Net { const nq=n.qty+q; return { qty:nq, avg: nq>0?(n.qty*n.avg+q*p)/nq:0 }; }

function run(tf: string, c: Candle[]) {
  let net: Net = { qty: 0, avg: 0 };
  let wallet = INITIAL_CAPITAL;
  let totalFees = 0, totalRealizedPnl = 0;
  let totalAdds = 0, totalCloses = 0;
  let liq = false, liqMs = 0, peak = INITIAL_CAPITAL, trough = INITIAL_CAPITAL;

  for (let i = 0; i < c.length; i++) {
    const bar = c[i]; const price = bar.close; const ts = bar.time;
    // CLOSE first if TP hit (use bar high to be optimistic)
    if (net.qty > 0 && net.avg > 0) {
      const gainAtHigh = (bar.high - net.avg) / net.avg * 100;
      if (gainAtHigh >= TP_PCT) {
        const closePrice = net.avg * (1 + TP_PCT/100); // close at TP target
        const realized = net.qty * (closePrice - net.avg);
        const fee = net.qty * closePrice * (FEE_PER_SIDE_PCT/100);
        wallet += realized - fee;
        totalRealizedPnl += realized; totalFees += fee; totalCloses++;
        net = { qty: 0, avg: 0 };
      }
    }
    // ADD LONG every bar
    const fee = QTY_BTC * price * (FEE_PER_SIDE_PCT/100);
    net = addNet(net, QTY_BTC, price);
    wallet -= fee; totalFees += fee; totalAdds++;
    // Stats + LIQ
    let upnl = net.qty > 0 ? net.qty * (price - net.avg) : 0;
    const eq = wallet + upnl;
    if (eq > peak) peak = eq;
    if (eq < trough) trough = eq;
    if (net.qty > 0) {
      const mm = net.qty * price * MAINT_MARGIN_RATE;
      if (eq <= mm) { liq = true; liqMs = ts; break; }
    }
  }
  const lastPrice = c[c.length-1].close;
  const finalUpnl = net.qty > 0 ? net.qty * (lastPrice - net.avg) : 0;
  const finalEq = wallet + finalUpnl;
  const roi = ((finalEq - INITIAL_CAPITAL)/INITIAL_CAPITAL) * 100;
  return {
    tf, liquidated: liq, liqAtMs: liqMs,
    totalAdds, totalCloses,
    totalRealizedPnl, totalFees,
    finalNet: net, lastPrice, finalUpnl, finalEq, wallet, roi,
    maxDD: peak-trough, peak, trough,
  };
}

function main() {
  const tfs = ["5m", "15m", "1h", "4h", "1d"];
  console.log(`\n=== LONG EVERY BAR + TP ${TP_PCT}% (qty 0.001 BTC, $100k cap) ===\n`);
  console.log("TF    Total bars  ADDs    CLOSES  Realized       Final NET                      uPnL          EQUITY      ROI %      DD$       LIQ");
  for (const tf of tfs) {
    const c = loadCache(tf);
    const r = run(tf, c);
    console.log(`${tf.padEnd(5)} ${c.length.toString().padStart(10)} ${r.totalAdds.toString().padStart(7)} ${r.totalCloses.toString().padStart(7)} ${('+$'+r.totalRealizedPnl.toFixed(0)).padStart(13)} ${(r.finalNet.qty.toFixed(2)+' BTC @ $'+r.finalNet.avg.toFixed(0)).padEnd(30)} ${((r.finalUpnl>=0?'+':'')+'$'+r.finalUpnl.toFixed(0)).padStart(13)} ${('$'+r.finalEq.toFixed(0)).padStart(11)} ${(r.roi>=0?'+':'')+r.roi.toFixed(2)+'%'.padStart(8)} $${r.maxDD.toFixed(0).padStart(8)} ${r.liquidated?('YES @ '+new Date(r.liqAtMs).toISOString().slice(0,10)):'NO'}`);
  }
}
main();
