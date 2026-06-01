/**
 * probe-hedge05-rescue-7y.mjs  (anh Tommy 2026-06-01)
 * TRỌNG TÂM ĐÚNG Ý TOMMY: tìm PHƯƠNG PHÁP CỨU LỆNH (lỗ→lãi), KHÔNG phải entry.
 * Cố định entry (RSI(1h)<35 oversold khi flat), chỉ đổi RESCUE protocol:
 *   BASE      : SL/TP cố định 1 leg (không cứu) — baseline EV.
 *   GRID_FLAT : nhồi đều khi lỗ (-g×ATR/lần, ≤N), TP tổng @ avg+t×ATR, HARD-SL @ -H×ATR. (martingale-lite bounded)
 *   GRID_MART : như trên nhưng nhồi GẤP ĐÔI (1,2,4...) — martingale thuần, để LỘ cái bẫy.
 *   REENTRY   : bị SL → vào lại fresh khi RSI<35 lần nữa, ≤N lần (KHÔNG avg down).
 * ĐO: ROI/RA/WR-campaign/DD + ĐUÔI (worst campaign, #hard-stop) + WF retain + recent.
 * Martingale lộ mặt = WR rất cao NHƯNG worst-campaign khổng lồ + EV âm OOS.
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
const M = C1.length, H = C1.map(x => x.h), L = C1.map(x => x.l), CL = C1.map(x => x.c);
function rsiS(c, p) { const o = new Array(c.length).fill(null); if (c.length <= p) return o; let g = 0, l = 0; for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; if (d >= 0) g += d; else l -= d; } let ag = g / p, al = l / p; o[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); for (let i = p + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; ag = (ag * (p - 1) + Math.max(d, 0)) / p; al = (al * (p - 1) + Math.max(-d, 0)) / p; o[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); } return o; }
function atrS(p) { const tr = new Array(M).fill(0); for (let i = 1; i < M; i++) tr[i] = Math.max(H[i] - L[i], Math.abs(H[i] - CL[i - 1]), Math.abs(L[i] - CL[i - 1])); const o = new Array(M).fill(null); let s = 0; for (let i = 1; i <= p; i++) s += tr[i]; o[p] = s / p; for (let i = p + 1; i < M; i++) o[i] = (o[i - 1] * (p - 1) + tr[i]) / p; return o; }
const RSI = rsiS(CL, 14), ATR = atrS(14), WARM = 50;
const isEntry = i => RSI[i - 1] != null && RSI[i - 1] >= 35 && RSI[i] < 35;  // cross xuống 35 (oversold), cố định

// mode: BASE | GRID_FLAT | GRID_MART | REENTRY
function sim(mode, P, iStart, iEnd) {
  // P = {sl,tp, g,N,tp2,H, reN}
  let wallet = INITIAL, peak = INITIAL, trough = INITIAL, lastEntry = -1e9;
  let camp = 0, campWin = 0, worst = 0, hardStops = 0; const perYear = {};
  let active = null; // campaign state
  for (let i = Math.max(iStart, WARM); i < iEnd; i++) {
    const bar = C1[i], price = bar.c, atr = ATR[i] || 0, yr = new Date(bar.t).getUTCFullYear();
    if (active) {
      const a = active;
      if (mode === "BASE" || mode === "REENTRY") {
        // single leg legs: a.legs[0]
        const leg = a.legs[0];
        let cx = null, hard = false;
        if (bar.l <= leg.sl) cx = leg.sl; else if (bar.h >= leg.tp) cx = leg.tp;
        if (cx != null) {
          const pnl = leg.qty * (cx - leg.entry) - leg.qty * cx * FEE_SIDE;
          a.realized += pnl;
          const lost = cx <= leg.sl;
          if (mode === "REENTRY" && lost && a.attempts < P.reN) {
            // re-enter fresh ngay (cùng bar close) — KHÔNG avg, leg mới với SL/TP riêng
            a.attempts++;
            a.legs[0] = { entry: price, qty: Q0, sl: price - P.sl * atr, tp: price + P.tp * atr };
            wallet -= Q0 * price * FEE_SIDE;
          } else {
            wallet += a.realized; camp++; if (a.realized >= 0) campWin++; if (a.realized < worst) worst = a.realized; perYear[yr] = (perYear[yr] || 0) + a.realized; active = null;
          }
        }
      } else { // GRID_FLAT / GRID_MART
        // add khi lỗ
        const nextLvl = a.firstEntry - (a.adds + 1) * P.g * a.atr0;
        if (a.adds < P.N && bar.l <= nextLvl) {
          const addQty = mode === "GRID_MART" ? Q0 * Math.pow(2, a.adds + 1) : Q0;
          const px = nextLvl;
          a.cost += addQty * px; a.qty += addQty; a.adds++;
          wallet -= addQty * px * FEE_SIDE;
        }
        const avg = a.cost / a.qty;
        const tpPx = avg + P.tp2 * a.atr0;
        const hardPx = a.firstEntry - P.H * a.atr0;
        let cx = null, hard = false;
        if (bar.l <= hardPx) { cx = hardPx; hard = true; }
        else if (bar.h >= tpPx) cx = tpPx;
        if (cx != null) {
          const pnl = a.qty * (cx - avg) - a.qty * cx * FEE_SIDE;
          wallet += pnl; camp++; if (pnl >= 0) campWin++; if (pnl < worst) worst = pnl; if (hard) hardStops++; perYear[yr] = (perYear[yr] || 0) + pnl; active = null;
        }
      }
    }
    if (!active && atr > 0 && (i - lastEntry >= 2) && isEntry(i)) {
      lastEntry = i;
      if (mode === "GRID_FLAT" || mode === "GRID_MART") { active = { firstEntry: price, cost: Q0 * price, qty: Q0, adds: 0, atr0: atr }; wallet -= Q0 * price * FEE_SIDE; }
      else { active = { legs: [{ entry: price, qty: Q0, sl: price - P.sl * atr, tp: price + P.tp * atr }], realized: 0, attempts: 0 }; wallet -= Q0 * price * FEE_SIDE; }
    }
    // equity (gồm uPnL thô)
    let up = 0; if (active) { if (active.legs) up = active.legs[0].qty * (price - active.legs[0].entry) + active.realized; else up = active.qty * (price - active.cost / active.qty); }
    const eq = wallet + up; if (eq > peak) peak = eq; if (eq < trough) trough = eq;
  }
  if (active) { const last = CL[iEnd - 1]; let pnl = active.legs ? active.legs[0].qty * (last - active.legs[0].entry) + active.realized : active.qty * (last - active.cost / active.qty); wallet += pnl; }
  const roi = (wallet - INITIAL) / INITIAL * 100, ddPct = peak > trough ? (peak - trough) / peak * 100 : 0;
  const yrsPos = Object.values(perYear).filter(v => v >= 0).length, yrs = Object.keys(perYear).length;
  return { roi, ddPct, ra: ddPct > 0 ? roi / ddPct : roi, wr: camp ? campWin / camp * 100 : 0, camp, worst, hardStops, yrsPos, yrs };
}
const split = Math.floor(M * 0.7), recentTs = Date.UTC(2025, 0, 1);
let recentIdx = C1.findIndex(x => x.t >= recentTs);
console.log(`\n=== TEST PHƯƠNG PHÁP CỨU LỆNH · entry cố định RSI(1h)<35 · BTC 7y ===`);
console.log(`worst = lệnh/campaign lỗ nặng nhất ($, qty base ${Q0}). hardStops = số lần chạm cap thảm họa.\n`);
console.log(`Rescue     | ROI%   |  DD%  |   RA   | WR-camp | #camp | worst$  | hardSL | stab | TRAIN→TEST | REC ROI`);
console.log(`-----------|--------|-------|--------|---------|-------|---------|--------|------|-----------|--------`);
const P = { sl: 2, tp: 2, g: 1.2, N: 5, tp2: 0.5, H: 8, reN: 3 };
for (const mode of ["BASE", "REENTRY", "GRID_FLAT", "GRID_MART"]) {
  const full = sim(mode, P, 0, M), trn = sim(mode, P, 0, split), tst = sim(mode, P, split, M), rec = sim(mode, P, recentIdx, M);
  const retain = trn.ra > 0 ? tst.ra / trn.ra : (tst.ra >= 0 ? 1 : 0), flag = retain >= 0.7 ? "✅" : retain >= 0.4 ? "⚠️" : "❌";
  console.log(`${mode.padEnd(10)} | ${(full.roi >= 0 ? "+" : "")}${full.roi.toFixed(1).padStart(5)} | ${full.ddPct.toFixed(1).padStart(5)} | ${(full.ra >= 0 ? "+" : "")}${full.ra.toFixed(3).padStart(6)} | ${full.wr.toFixed(0).padStart(6)}% | ${String(full.camp).padStart(5)} | ${full.worst.toFixed(0).padStart(7)} | ${String(full.hardStops).padStart(6)} | ${full.yrsPos}/${full.yrs}  | ${(trn.ra >= 0 ? "+" : "")}${trn.ra.toFixed(2)}→${(tst.ra >= 0 ? "+" : "")}${tst.ra.toFixed(2)} ${flag} | ${(rec.roi >= 0 ? "+" : "")}${rec.roi.toFixed(1)}%`);
}
console.log(`\nĐọc: GRID WR cao mà worst$ khổng lồ + TEST âm = BẪY martingale. REENTRY/BASE EV thật mới robust.`);
console.log(`[done]`);
