/**
 * probe-hedge05-stress-7y.mjs  (anh Tommy 2026-06-01)
 * STRESS-TEST fill thật — đóng caveat "backtest lạc quan".
 * 3 model: OPTIMISTIC (như cũ) → REALISTIC (slip 5bps) → PESSIMISTIC (slip 10bps + hard-stop
 * fill tại bar.low = gap xuyên cap). Xem RA giữ không + đuôi xấu nhất thật.
 * + tìm cú rớt 1h tệ nhất 7y để mô tả rủi ro gap.
 */
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const INITIAL = 100000, FEE = 0.05 / 100, Q0 = 0.03, HOUR = 3600000;
const c5 = JSON.parse(readFileSync(join(__dirname, "..", ".cache", "binance-5m-7y.json"), "utf8"));
const hMap = new Map();
for (let i = 0; i < c5.length; i++) { const b = c5[i], k = Math.floor(b.time / HOUR); let h = hMap.get(k); if (!h) hMap.set(k, { t: k * HOUR, o: b.open, h: b.high, l: b.low, c: b.close }); else { if (b.high > h.h) h.h = b.high; if (b.low < h.l) h.l = b.low; h.c = b.close; } }
const C1 = [...hMap.values()].sort((a, b) => a.t - b.t);
const M = C1.length, HH = C1.map(x => x.h), LL = C1.map(x => x.l), CL = C1.map(x => x.c);
function rsiS(c, p) { const o = new Array(c.length).fill(null); if (c.length <= p) return o; let g = 0, l = 0; for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; if (d >= 0) g += d; else l -= d; } let ag = g / p, al = l / p; o[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); for (let i = p + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; ag = (ag * (p - 1) + Math.max(d, 0)) / p; al = (al * (p - 1) + Math.max(-d, 0)) / p; o[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); } return o; }
function atrS(p) { const tr = new Array(M).fill(0); for (let i = 1; i < M; i++) tr[i] = Math.max(HH[i] - LL[i], Math.abs(HH[i] - CL[i - 1]), Math.abs(LL[i] - CL[i - 1])); const o = new Array(M).fill(null); let s = 0; for (let i = 1; i <= p; i++) s += tr[i]; o[p] = s / p; for (let i = p + 1; i < M; i++) o[i] = (o[i - 1] * (p - 1) + tr[i]) / p; return o; }
const RSI = rsiS(CL, 14), ATR = atrS(14), WARM = 50;
const isEntry = i => RSI[i - 1] != null && RSI[i - 1] >= 35 && RSI[i] < 35;
const G = 0.8, WIDEN = 1.8, N = 3, TP2 = 0.4, HARD = 7;
const cum = adds => { let d = 0; for (let k = 0; k <= adds; k++) d += G * Math.pow(WIDEN, k); return d; };
// slipAdd/slipExit = fraction; hardAtLow = fill hard-stop tại bar.low (gap)
function sim(slipAdd, slipExit, hardAtLow, iStart, iEnd) {
  let wallet = INITIAL, peak = INITIAL, trough = INITIAL, lastE = -1e9, camp = 0, win = 0, worst = 0, hardC = 0; const py = {}; let a = null;
  for (let i = Math.max(iStart, WARM); i < iEnd; i++) {
    const px = CL[i], atr = ATR[i] || 0, yr = new Date(C1[i].t).getUTCFullYear();
    if (a) {
      if (a.adds < N) { const lvl = a.firstEntry - cum(a.adds) * a.atr0; if (LL[i] <= lvl) { const fill = lvl * (1 + slipAdd); a.cost += Q0 * fill; a.qty += Q0; a.adds++; wallet -= Q0 * fill * FEE; } }
      const avg = a.cost / a.qty, tpPx = avg + TP2 * a.atr0, hardPx = a.firstEntry - HARD * a.atr0;
      let done = false, pnl = 0, isH = false;
      if (LL[i] <= hardPx) { const fill = hardAtLow ? Math.min(hardPx, LL[i]) : hardPx * (1 - slipExit); pnl = a.qty * (fill - avg) - a.qty * fill * FEE; done = true; isH = true; }
      else if (HH[i] >= tpPx) { const fill = tpPx * (1 - slipExit); pnl = a.qty * (fill - avg) - a.qty * fill * FEE; done = true; }
      if (done) { wallet += pnl; camp++; if (pnl >= 0) win++; if (pnl < worst) worst = pnl; if (isH) hardC++; py[yr] = (py[yr] || 0) + pnl; a = null; }
    }
    if (!a && atr > 0 && (i - lastE >= 2) && isEntry(i)) { lastE = i; a = { firstEntry: px, cost: Q0 * px, qty: Q0, adds: 0, atr0: atr }; wallet -= Q0 * px * FEE; }
    let up = a ? a.qty * (px - a.cost / a.qty) : 0; const eq = wallet + up; if (eq > peak) peak = eq; if (eq < trough) trough = eq;
  }
  if (a) wallet += a.qty * (CL[iEnd - 1] - a.cost / a.qty);
  const roi = (wallet - INITIAL) / INITIAL * 100, dd = peak > trough ? (peak - trough) / peak * 100 : 0;
  const yp = Object.values(py).filter(v => v >= 0).length, yrs = Object.keys(py).length;
  return { roi, dd, ra: dd > 0 ? roi / dd : roi, wr: camp ? win / camp * 100 : 0, camp, worst, hardC, yp, yrs };
}
const split = Math.floor(M * 0.7), rTs = Date.UTC(2025, 0, 1); let rIdx = C1.findIndex(x => x.t >= rTs);
console.log(`\n=== STRESS-TEST hedge05 grid · fill thật · BTC 7y ===`);
console.log(`Config improved: g0.8/w1.8/N3/tp0.4/hard7. Entry RSI↓35.\n`);
console.log(`Fill model          | ROI%  |  DD%  |   RA   | WR%  | worst$ | hardSL | TRAIN→TEST  | REC ROI`);
console.log(`--------------------|-------|-------|--------|------|--------|--------|-------------|--------`);
const models = [["OPTIMISTIC (cũ)", 0, 0, false], ["REALISTIC 5bps", 0.0005, 0.0005, false], ["PESSIMISTIC 10bps+gap", 0.0010, 0.0010, true]];
for (const [name, sa, se, hl] of models) {
  const f = sim(sa, se, hl, 0, M), tr = sim(sa, se, hl, 0, split), ts = sim(sa, se, hl, split, M), rc = sim(sa, se, hl, rIdx, M);
  const ret = tr.ra > 0 ? ts.ra / tr.ra : (ts.ra >= 0 ? 1 : 0), fl = ret >= 0.7 ? "✅" : ret >= 0.4 ? "⚠️" : "❌";
  console.log(`${name.padEnd(19)} | ${(f.roi >= 0 ? "+" : "")}${f.roi.toFixed(1).padStart(4)} | ${f.dd.toFixed(1).padStart(5)} | ${(f.ra >= 0 ? "+" : "")}${f.ra.toFixed(3).padStart(6)} | ${f.wr.toFixed(0).padStart(4)} | ${f.worst.toFixed(0).padStart(6)} | ${String(f.hardC).padStart(6)} | ${(tr.ra >= 0 ? "+" : "")}${tr.ra.toFixed(2)}→${(ts.ra >= 0 ? "+" : "")}${ts.ra.toFixed(2)} ${fl} | ${(rc.roi >= 0 ? "+" : "")}${rc.roi.toFixed(1)}%`);
}
// cú rớt 1h tệ nhất + worst-case campaign nếu gặp ngay khi nhồi đủ
let worstDrop = 0, worstT = 0;
for (let i = 1; i < M; i++) { const d = (LL[i] - CL[i - 1]) / CL[i - 1] * 100; if (d < worstDrop) { worstDrop = d; worstT = C1[i].t; } }
console.log(`\n=== RỦI RO GAP ===`);
console.log(`Cú rớt 1h tệ nhất 7y: ${worstDrop.toFixed(1)}% (${new Date(worstT).toISOString().slice(0, 10)})`);
console.log(`Worst-case lý thuyết: nếu rớt ${worstDrop.toFixed(0)}% lúc đã nhồi 4× (notional 4×base), loss ≈ 4 × base × ${(-worstDrop).toFixed(0)}% price`);
const avgPx = 40000, lossWC = 4 * Q0 * avgPx * (-worstDrop / 100);
console.log(`  ≈ $${lossWC.toFixed(0)} (4×${Q0}BTC×$${avgPx}×${(-worstDrop).toFixed(0)}%) = ${(lossWC / INITIAL * 100).toFixed(2)}% vốn $100k — hard-cap −7ATR thường chặn TRƯỚC mức này.`);
console.log(`\n[done]`);
