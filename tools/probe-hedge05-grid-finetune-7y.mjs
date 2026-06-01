/**
 * probe-hedge05-grid-finetune-7y.mjs  (anh Tommy 2026-06-01)
 * IMPROVE lever cuối: tinh chỉnh sâu grid (g/widen/tp2/hard) trên entry RSI35d.
 * Tìm RA > 1.03 mà GIỮ: WF retain≥0.7, recent>0, worst>-400, stab≥7/8.
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
function sim(g, widen, N, tp2, hard, iStart, iEnd) {
  let wallet = INITIAL, peak = INITIAL, trough = INITIAL, lastE = -1e9, camp = 0, win = 0, worst = 0, hardC = 0; const py = {}; let a = null;
  const cum = adds => { let d = 0; for (let k = 0; k <= adds; k++) d += g * Math.pow(widen, k); return d; };
  for (let i = Math.max(iStart, WARM); i < iEnd; i++) {
    const px = CL[i], atr = ATR[i] || 0, yr = new Date(C1[i].t).getUTCFullYear();
    if (a) {
      if (a.adds < N) { const lvl = a.firstEntry - cum(a.adds) * a.atr0; if (LL[i] <= lvl) { a.cost += Q0 * lvl; a.qty += Q0; a.adds++; wallet -= Q0 * lvl * FEE; } }
      const avg = a.cost / a.qty, tpPx = avg + tp2 * a.atr0, hardPx = a.firstEntry - hard * a.atr0;
      let done = false, pnl = 0, isH = false;
      if (LL[i] <= hardPx) { pnl = a.qty * (hardPx - avg) - a.qty * hardPx * FEE; done = true; isH = true; }
      else if (HH[i] >= tpPx) { pnl = a.qty * (tpPx - avg) - a.qty * tpPx * FEE; done = true; }
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
console.log(`\n=== FINE-TUNE grid (entry RSI35d) · BTC 7y ===`);
console.log(`Current center: g1.2/widen1.5/N3/tp0.3/hard6 → RA 1.030. Tìm cao hơn mà giữ robust.\n`);
const out = [];
for (const g of [0.8, 1.0, 1.2, 1.4]) for (const widen of [1.2, 1.5, 1.8]) for (const tp2 of [0.2, 0.3, 0.4]) for (const hard of [5, 6, 7]) {
  const f = sim(g, widen, 3, tp2, hard, 0, M), tr = sim(g, widen, 3, tp2, hard, 0, split), ts = sim(g, widen, 3, tp2, hard, split, M), rc = sim(g, widen, 3, tp2, hard, rIdx, M);
  const ret = tr.ra > 0 ? ts.ra / tr.ra : (ts.ra >= 0 ? 1 : 0);
  const pass = f.ra > 0 && ret >= 0.7 && rc.roi > 0 && f.worst > -400 && f.yp >= 7;
  out.push({ g, widen, tp2, hard, f, ret, rc, pass });
}
const passed = out.filter(o => o.pass).sort((a, b) => b.f.ra - a.f.ra);
console.log(`${passed.length}/${out.length} cấu hình PASS (robust). Top 10 RA:`);
console.log(`g   | wid | tp2 | hard | RA full | ROI%  | DD%  | camp | worst$ | hardSL | stab | retain | recROI`);
console.log(`----|-----|-----|------|---------|-------|------|------|--------|--------|------|--------|-------`);
for (const o of passed.slice(0, 10))
  console.log(`${o.g.toFixed(1)} | ${o.widen.toFixed(1)} | ${o.tp2.toFixed(1)} | ${String(o.hard).padStart(3)}  | ${(o.f.ra >= 0 ? "+" : "")}${o.f.ra.toFixed(3).padStart(6)} | ${(o.f.roi >= 0 ? "+" : "")}${o.f.roi.toFixed(1).padStart(4)} | ${o.f.dd.toFixed(1).padStart(4)} | ${String(o.f.camp).padStart(4)} | ${o.f.worst.toFixed(0).padStart(6)} | ${String(o.f.hardC).padStart(6)} | ${o.f.yp}/${o.f.yrs}  | ${(o.ret * 100).toFixed(0).padStart(5)}% | ${(o.rc.roi >= 0 ? "+" : "")}${o.rc.roi.toFixed(1)}%`);
const best = passed[0];
if (best) { console.log(`\n🏆 BEST: g${best.g}/widen${best.widen}/tp${best.tp2}/hard${best.hard} → RA ${best.f.ra.toFixed(3)} (vs center 1.030 = ${best.f.ra > 1.03 ? "+" + ((best.f.ra - 1.03) / 1.03 * 100).toFixed(0) + "% IMPROVE" : "không hơn"})`); }
console.log(`[done]`);
