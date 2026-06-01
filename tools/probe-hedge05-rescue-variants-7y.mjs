/**
 * probe-hedge05-rescue-variants-7y.mjs  (anh Tommy 2026-06-01)
 * ĐÀO SÂU CƠ CHẾ CỨU — 6 biến thể trên nền GRID_FLAT (entry RSI<35 cố định).
 * Mục tiêu: GIẢM ĐUÔI (worst/hardStops) + TĂNG RA so với baseline.
 *   BASELINE   : nhồi đều g1.2, N3, TP avg+0.3ATR, hard -6ATR (bản đã validate)
 *   WIDEN      : khoảng cách nhồi giãn dần (×1.5) → nhồi chậm khi crash → đuôi nhỏ
 *   CONFIRM_ADD: chỉ nhồi khi nến xanh tại level (không nhồi vào freefall)
 *   BE_TIMEOUT : campaign kéo >48h → thoát ngay (tránh cưỡi bear)
 *   PARTIAL    : chạm TP → chốt 70%, 30% còn lại trail ATR×3 (bắt bounce lớn)
 *   DYN_TP     : TP co theo số adds (0 adds→1.0ATR chạy, 3 adds→0.2ATR thoát nhanh)
 * Đo: RA/DD/WR/worst$/hardSL/stab + WF retain + recent.
 */
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const INITIAL = 100000, FEE_SIDE = 0.05 / 100, Q0 = 0.03, HOUR = 3600000;
const c5 = JSON.parse(readFileSync(join(__dirname, "..", ".cache", "binance-5m-7y.json"), "utf8"));
const hMap = new Map();
for (let i = 0; i < c5.length; i++) { const b = c5[i], k = Math.floor(b.time / HOUR); let h = hMap.get(k); if (!h) hMap.set(k, { t: k * HOUR, o: b.open, h: b.high, l: b.low, c: b.close }); else { if (b.high > h.h) h.h = b.high; if (b.low < h.l) h.l = b.low; h.c = b.close; } }
const C1 = [...hMap.values()].sort((a, b) => a.t - b.t);
const M = C1.length, H = C1.map(x => x.h), L = C1.map(x => x.l), CL = C1.map(x => x.c), OP = C1.map(x => x.o);
function rsiS(c, p) { const o = new Array(c.length).fill(null); if (c.length <= p) return o; let g = 0, l = 0; for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; if (d >= 0) g += d; else l -= d; } let ag = g / p, al = l / p; o[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); for (let i = p + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; ag = (ag * (p - 1) + Math.max(d, 0)) / p; al = (al * (p - 1) + Math.max(-d, 0)) / p; o[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); } return o; }
function atrS(p) { const tr = new Array(M).fill(0); for (let i = 1; i < M; i++) tr[i] = Math.max(H[i] - L[i], Math.abs(H[i] - CL[i - 1]), Math.abs(L[i] - CL[i - 1])); const o = new Array(M).fill(null); let s = 0; for (let i = 1; i <= p; i++) s += tr[i]; o[p] = s / p; for (let i = p + 1; i < M; i++) o[i] = (o[i - 1] * (p - 1) + tr[i]) / p; return o; }
const RSI = rsiS(CL, 14), ATR = atrS(14), WARM = 50;
const isEntry = i => RSI[i - 1] != null && RSI[i - 1] >= 35 && RSI[i] < 35;
const G = 1.2, N = 3, HH = 6, TP2 = 0.3;
function sim(mode, iStart, iEnd) {
  const widen = mode === "WIDEN" ? 1.5 : 1.0, confirm = mode === "CONFIRM_ADD", beTO = mode === "BE_TIMEOUT" ? 48 : 0, partial = mode === "PARTIAL", dynTP = mode === "DYN_TP";
  let wallet = INITIAL, peak = INITIAL, trough = INITIAL, lastEntry = -1e9, camp = 0, campWin = 0, worst = 0, hardStops = 0; const perYear = {};
  let a = null;
  function cumDist(adds) { let d = 0; for (let k = 0; k <= adds; k++) d += G * Math.pow(widen, k); return d; }
  for (let i = Math.max(iStart, WARM); i < iEnd; i++) {
    const bar = C1[i], price = bar.c, atr = ATR[i] || 0, yr = new Date(bar.t).getUTCFullYear();
    if (a) {
      // add
      if (a.adds < N) { const nextLvl = a.firstEntry - cumDist(a.adds) * a.atr0; if (bar.l <= nextLvl && (!confirm || bar.c > bar.o)) { a.cost += Q0 * nextLvl; a.qty += Q0; a.adds++; wallet -= Q0 * nextLvl * FEE_SIDE; } }
      const avg = a.cost / a.qty;
      const tpMult = dynTP ? Math.max(0.2, 1.0 - 0.3 * a.adds) : TP2;
      const tpPx = avg + tpMult * a.atr0, hardPx = a.firstEntry - HH * a.atr0;
      let done = false, pnl = 0, hard = false;
      if (partial && a.partialDone) {
        if (bar.h > a.trailPeak) a.trailPeak = bar.h;
        const trailStop = a.trailPeak - 3 * a.atr0, exitPx = Math.max(trailStop, hardPx);
        if (bar.l <= exitPx) { pnl = a.realized + a.qty * (exitPx - avg) - a.qty * exitPx * FEE_SIDE; done = true; if (exitPx <= hardPx) hard = true; }
      } else {
        if (bar.l <= hardPx) { pnl = a.qty * (hardPx - avg) - a.qty * hardPx * FEE_SIDE; done = true; hard = true; }
        else if (bar.h >= tpPx) {
          if (partial) { const closeQ = a.qty * 0.7; a.realized = closeQ * (tpPx - avg) - closeQ * tpPx * FEE_SIDE; a.qty -= closeQ; a.partialDone = true; a.trailPeak = bar.h; }
          else { pnl = a.qty * (tpPx - avg) - a.qty * tpPx * FEE_SIDE; done = true; }
        }
      }
      if (!done && beTO > 0 && (i - a.openIdx) >= beTO) { pnl = (a.realized || 0) + a.qty * (price - avg) - a.qty * price * FEE_SIDE; done = true; }
      if (done) { wallet += pnl; camp++; if (pnl >= 0) campWin++; if (pnl < worst) worst = pnl; if (hard) hardStops++; perYear[yr] = (perYear[yr] || 0) + pnl; a = null; }
    }
    if (!a && atr > 0 && (i - lastEntry >= 2) && isEntry(i)) { lastEntry = i; a = { firstEntry: price, cost: Q0 * price, qty: Q0, adds: 0, atr0: atr, openIdx: i, partialDone: false, realized: 0, trailPeak: price }; wallet -= Q0 * price * FEE_SIDE; }
    let up = a ? (a.realized || 0) + a.qty * (price - a.cost / a.qty) : 0; const eq = wallet + up; if (eq > peak) peak = eq; if (eq < trough) trough = eq;
  }
  if (a) wallet += (a.realized || 0) + a.qty * (CL[iEnd - 1] - a.cost / a.qty);
  const roi = (wallet - INITIAL) / INITIAL * 100, ddPct = peak > trough ? (peak - trough) / peak * 100 : 0;
  const yrsPos = Object.values(perYear).filter(v => v >= 0).length, yrs = Object.keys(perYear).length;
  return { roi, ddPct, ra: ddPct > 0 ? roi / ddPct : roi, wr: camp ? campWin / camp * 100 : 0, camp, worst, hardStops, perYear, yrsPos, yrs };
}
const split = Math.floor(M * 0.7), recentTs = Date.UTC(2025, 0, 1);
let recentIdx = C1.findIndex(x => x.t >= recentTs);
console.log(`\n=== ĐÀO SÂU CƠ CHẾ CỨU · 6 biến thể · entry RSI<35 · BTC 7y ===`);
console.log(`Nền: g${G}/N${N}/hard-${HH}ATR. Tìm bản GIẢM đuôi / TĂNG RA so BASELINE.\n`);
console.log(`Mode        | ROI%   |  DD%  |   RA   | WR%  | worst$  | hardSL | stab | TRAIN→TEST  | REC ROI`);
console.log(`------------|--------|-------|--------|------|---------|--------|------|-------------|--------`);
for (const mode of ["BASELINE", "WIDEN", "CONFIRM_ADD", "BE_TIMEOUT", "PARTIAL", "DYN_TP"]) {
  const full = sim(mode, 0, M), trn = sim(mode, 0, split), tst = sim(mode, split, M), rec = sim(mode, recentIdx, M);
  const retain = trn.ra > 0 ? tst.ra / trn.ra : (tst.ra >= 0 ? 1 : 0), flag = retain >= 0.7 ? "✅" : retain >= 0.4 ? "⚠️" : "❌";
  console.log(`${mode.padEnd(11)} | ${(full.roi >= 0 ? "+" : "")}${full.roi.toFixed(1).padStart(5)} | ${full.ddPct.toFixed(1).padStart(5)} | ${(full.ra >= 0 ? "+" : "")}${full.ra.toFixed(3).padStart(6)} | ${full.wr.toFixed(0).padStart(4)} | ${full.worst.toFixed(0).padStart(7)} | ${String(full.hardStops).padStart(6)} | ${full.yrsPos}/${full.yrs}  | ${(trn.ra >= 0 ? "+" : "")}${trn.ra.toFixed(2)}→${(tst.ra >= 0 ? "+" : "")}${tst.ra.toFixed(2)} ${flag} | ${(rec.roi >= 0 ? "+" : "")}${rec.roi.toFixed(1)}%`);
}
console.log(`\nTìm: worst$ NHỎ hơn (đuôi an toàn hơn) HOẶC RA cao hơn mà vẫn qua WF.`);
console.log(`[done]`);
