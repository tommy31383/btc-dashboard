/**
 * probe-hedge05-rescue-hedge-7y.mjs  (anh Tommy 2026-06-01)
 * ĐÀO THÊM cơ chế cứu — 4 cách, so với GRID baseline (RA1.03/worst-172):
 *   GRID        : nhồi đều WIDEN (bản đã chốt) — tham chiếu.
 *   HEDGE_LOCK  : LONG lỗ -3ATR → mở SHORT khóa (delta~0). Giá rớt tiếp -2ATR HOẶC RSI<25
 *                 → đóng SHORT ăn leg giảm (cushion). Giá lên +2ATR → unlock cắt SHORT lỗ nhỏ.
 *                 KHÔNG tăng long exposure (khác martingale). LONG TP @ entry+0.5ATR.
 *   HEDGE_GRID  : kết hợp nhồi đều + khóa SHORT khi quá sâu.
 *   PARTIAL_FIX : grid, chạm TP chốt 70%, 30% trail ATR×3 (làm lại đúng).
 * Đo RA/DD/WR/worst$/hardSL/stab + WF + recent. Sanity: ROI phải trong [-50,+50]%.
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
const M = C1.length, H = C1.map(x => x.h), L = C1.map(x => x.l), CL = C1.map(x => x.c);
function rsiS(c, p) { const o = new Array(c.length).fill(null); if (c.length <= p) return o; let g = 0, l = 0; for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; if (d >= 0) g += d; else l -= d; } let ag = g / p, al = l / p; o[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); for (let i = p + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; ag = (ag * (p - 1) + Math.max(d, 0)) / p; al = (al * (p - 1) + Math.max(-d, 0)) / p; o[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); } return o; }
function atrS(p) { const tr = new Array(M).fill(0); for (let i = 1; i < M; i++) tr[i] = Math.max(H[i] - L[i], Math.abs(H[i] - CL[i - 1]), Math.abs(L[i] - CL[i - 1])); const o = new Array(M).fill(null); let s = 0; for (let i = 1; i <= p; i++) s += tr[i]; o[p] = s / p; for (let i = p + 1; i < M; i++) o[i] = (o[i - 1] * (p - 1) + tr[i]) / p; return o; }
const RSI = rsiS(CL, 14), ATR = atrS(14), WARM = 50;
const isEntry = i => RSI[i - 1] != null && RSI[i - 1] >= 35 && RSI[i] < 35;
const G = 1.2, N = 3, WIDEN = 1.5, HH = 6, TP2 = 0.3, LOCK = 3, BANK = 2, UNLOCK = 2;
function cumDist(adds) { let d = 0; for (let k = 0; k <= adds; k++) d += G * Math.pow(WIDEN, k); return d; }

function sim(mode, iStart, iEnd) {
  let wallet = INITIAL, peak = INITIAL, trough = INITIAL, lastEntry = -1e9, camp = 0, win = 0, worst = 0, hard = 0; const py = {};
  let a = null;
  for (let i = Math.max(iStart, WARM); i < iEnd; i++) {
    const bar = C1[i], px = bar.c, atr = ATR[i] || 0, yr = new Date(bar.t).getUTCFullYear();
    if (a) {
      const useGrid = (mode === "GRID" || mode === "HEDGE_GRID" || mode === "PARTIAL_FIX");
      // 1. grid add (nếu dùng grid)
      if (useGrid && a.adds < N && !a.locked) { const lvl = a.firstEntry - cumDist(a.adds) * a.atr0; if (bar.l <= lvl) { a.cost += Q0 * lvl; a.qty += Q0; a.adds++; wallet -= Q0 * lvl * FEE; } }
      const avg = a.cost / a.qty;
      // 2. hedge lock (nếu dùng hedge)
      if ((mode === "HEDGE_LOCK" || mode === "HEDGE_GRID")) {
        if (!a.locked && bar.l <= avg - LOCK * a.atr0) { a.locked = true; a.shortEntry = avg - LOCK * a.atr0; wallet -= a.qty * a.shortEntry * FEE; }
        else if (a.locked) {
          // bank: rớt tiếp BANK*ATR hoặc RSI<25 → đóng SHORT ăn leg giảm
          if (bar.l <= a.shortEntry - BANK * a.atr0 || (RSI[i] != null && RSI[i] < 25)) { const sx = Math.max(bar.l, a.shortEntry - BANK * a.atr0); a.realized += a.qty * (a.shortEntry - sx) - a.qty * sx * FEE; a.locked = false; }
          // unlock lỗ nhỏ nếu giá bật lên
          else if (bar.h >= a.shortEntry + UNLOCK * a.atr0) { const sx = a.shortEntry + UNLOCK * a.atr0; a.realized += a.qty * (a.shortEntry - sx) - a.qty * sx * FEE; a.locked = false; }
        }
      }
      // 3. exit
      const tpPx = avg + TP2 * a.atr0, hardPx = a.firstEntry - HH * a.atr0;
      let done = false, pnl = 0, isHard = false;
      if (mode === "PARTIAL_FIX" && a.partialDone) {
        if (bar.h > a.trailPeak) a.trailPeak = bar.h; const ts = Math.max(a.trailPeak - 3 * a.atr0, hardPx);
        if (bar.l <= ts) { pnl = a.realized + a.qty * (ts - avg) - a.qty * ts * FEE; done = true; if (ts <= hardPx) isHard = true; }
      } else if (!a.locked) {  // chỉ TP/hard khi KHÔNG đang khóa
        if (bar.l <= hardPx) { pnl = a.realized + a.qty * (hardPx - avg) - a.qty * hardPx * FEE; done = true; isHard = true; }
        else if (bar.h >= tpPx) {
          if (mode === "PARTIAL_FIX") { const cq = a.qty * 0.7; a.realized += cq * (tpPx - avg) - cq * tpPx * FEE; a.qty -= cq; a.partialDone = true; a.trailPeak = bar.h; }
          else { pnl = a.realized + a.qty * (tpPx - avg) - a.qty * tpPx * FEE; done = true; }
        }
      }
      if (done) { wallet += pnl; camp++; if (pnl >= 0) win++; if (pnl < worst) worst = pnl; if (isHard) hard++; py[yr] = (py[yr] || 0) + pnl; a = null; }
    }
    if (!a && atr > 0 && (i - lastEntry >= 2) && isEntry(i)) { lastEntry = i; a = { firstEntry: px, cost: Q0 * px, qty: Q0, adds: 0, atr0: atr, realized: 0, locked: false, shortEntry: 0, partialDone: false, trailPeak: px }; wallet -= Q0 * px * FEE; }
    let up = 0; if (a) { const avg = a.cost / a.qty; up = a.realized + a.qty * (px - avg) + (a.locked ? a.qty * (a.shortEntry - px) : 0); } const eq = wallet + up; if (eq > peak) peak = eq; if (eq < trough) trough = eq;
  }
  if (a) { const avg = a.cost / a.qty; wallet += a.realized + a.qty * (CL[iEnd - 1] - avg); }
  const roi = (wallet - INITIAL) / INITIAL * 100, dd = peak > trough ? (peak - trough) / peak * 100 : 0;
  const yp = Object.values(py).filter(v => v >= 0).length, yrs = Object.keys(py).length;
  return { roi, dd, ra: dd > 0 ? roi / dd : roi, wr: camp ? win / camp * 100 : 0, camp, worst, hard, yp, yrs };
}
const split = Math.floor(M * 0.7), rTs = Date.UTC(2025, 0, 1);
let rIdx = C1.findIndex(x => x.t >= rTs);
console.log(`\n=== ĐÀO THÊM cơ chế cứu (hedge lock + partial-fix) · BTC 7y ===`);
console.log(`So với GRID baseline (RA1.03 worst-172). Sanity ROI∈[-50,50]%.\n`);
console.log(`Mode        | ROI%   |  DD%  |   RA   | WR%  | worst$  | hardSL | stab | TRAIN→TEST  | REC ROI`);
console.log(`------------|--------|-------|--------|------|---------|--------|------|-------------|--------`);
for (const mode of ["GRID", "HEDGE_LOCK", "HEDGE_GRID", "PARTIAL_FIX"]) {
  const f = sim(mode, 0, M), tr = sim(mode, 0, split), ts = sim(mode, split, M), rc = sim(mode, rIdx, M);
  const ret = tr.ra > 0 ? ts.ra / tr.ra : (ts.ra >= 0 ? 1 : 0), fl = ret >= 0.7 ? "✅" : ret >= 0.4 ? "⚠️" : "❌";
  const sane = f.roi > -60 && f.roi < 60 ? "" : " ⚠️BUG?";
  console.log(`${mode.padEnd(11)} | ${(f.roi >= 0 ? "+" : "")}${f.roi.toFixed(1).padStart(5)} | ${f.dd.toFixed(1).padStart(5)} | ${(f.ra >= 0 ? "+" : "")}${f.ra.toFixed(3).padStart(6)} | ${f.wr.toFixed(0).padStart(4)} | ${f.worst.toFixed(0).padStart(7)} | ${String(f.hard).padStart(6)} | ${f.yp}/${f.yrs}  | ${(tr.ra >= 0 ? "+" : "")}${tr.ra.toFixed(2)}→${(ts.ra >= 0 ? "+" : "")}${ts.ra.toFixed(2)} ${fl} | ${(rc.roi >= 0 ? "+" : "")}${rc.roi.toFixed(1)}%${sane}`);
}
console.log(`\nHedge lock dùng SHORT chỉ để KHÓA (không phải tìm edge SHORT). Thắng GRID nếu worst nhỏ hơn mà RA giữ.`);
console.log(`[done]`);
