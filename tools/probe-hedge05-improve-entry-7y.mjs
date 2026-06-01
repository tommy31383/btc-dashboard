/**
 * probe-hedge05-improve-entry-7y.mjs  (anh Tommy 2026-06-01)
 * IMPROVE: ghép cơ chế cứu đã validate (grid g1.2 widen1.5 N3 TP0.3 hard-6ATR)
 * lên 8 kiểu ENTRY → tìm entry nâng RA + tần suất mà vẫn robust.
 *   E_RSI35d : RSI cross xuống 35 (baseline, bắt dip)
 *   E_RSI30d : RSI cross xuống 30 (sâu hơn)
 *   E_RSI40u : RSI cross LÊN 40 (đảo chiều — như hedge04)
 *   E_STK20u : Stoch K cross lên 20
 *   E_BBrec  : close lại trên BB lower (reclaim)
 *   E_ANYrev : bất kỳ 1 trong 3 đảo chiều (nhiều lệnh)
 *   E_ANYrev_R: ANYrev + ADX(1h)<25 (range)
 *   E_RSI35d_R: RSI cross xuống 35 + ADX<25
 * Đo RA/DD/WR/#camp/worst/hardSL/stab + WF + recent.
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
function stochKS(p) { const o = new Array(M).fill(null); for (let i = p - 1; i < M; i++) { let hi = -Infinity, lo = Infinity; for (let j = i - p + 1; j <= i; j++) { if (HH[j] > hi) hi = HH[j]; if (LL[j] < lo) lo = LL[j]; } o[i] = hi === lo ? 50 : (CL[i] - lo) / (hi - lo) * 100; } return o; }
function bbLowS() { const o = new Array(M).fill(null); for (let i = 19; i < M; i++) { let s = 0; for (let j = i - 19; j <= i; j++) s += CL[j]; const m = s / 20; let sq = 0; for (let j = i - 19; j <= i; j++) sq += (CL[j] - m) ** 2; o[i] = m - 2 * Math.sqrt(sq / 20); } return o; }
function atrS(p) { const tr = new Array(M).fill(0); for (let i = 1; i < M; i++) tr[i] = Math.max(HH[i] - LL[i], Math.abs(HH[i] - CL[i - 1]), Math.abs(LL[i] - CL[i - 1])); const o = new Array(M).fill(null); let s = 0; for (let i = 1; i <= p; i++) s += tr[i]; o[p] = s / p; for (let i = p + 1; i < M; i++) o[i] = (o[i - 1] * (p - 1) + tr[i]) / p; return o; }
function adxS(p) { const tr = new Array(M).fill(0), pD = new Array(M).fill(0), nD = new Array(M).fill(0); for (let i = 1; i < M; i++) { const u = HH[i] - HH[i - 1], dn = LL[i - 1] - LL[i]; pD[i] = (u > dn && u > 0) ? u : 0; nD[i] = (dn > u && dn > 0) ? dn : 0; tr[i] = Math.max(HH[i] - LL[i], Math.abs(HH[i] - CL[i - 1]), Math.abs(LL[i] - CL[i - 1])); } const sT = new Array(M).fill(0), sP = new Array(M).fill(0), sN = new Array(M).fill(0); let t0 = 0, p0 = 0, n0 = 0; for (let i = 1; i <= p; i++) { t0 += tr[i]; p0 += pD[i]; n0 += nD[i]; } sT[p] = t0; sP[p] = p0; sN[p] = n0; for (let i = p + 1; i < M; i++) { sT[i] = sT[i - 1] - sT[i - 1] / p + tr[i]; sP[i] = sP[i - 1] - sP[i - 1] / p + pD[i]; sN[i] = sN[i - 1] - sN[i - 1] / p + nD[i]; } const dx = new Array(M).fill(null); for (let i = p; i < M; i++) { if (sT[i] === 0) continue; const a = 100 * sP[i] / sT[i], b = 100 * sN[i] / sT[i], s = a + b; dx[i] = s === 0 ? 0 : 100 * Math.abs(a - b) / s; } const adx = new Array(M).fill(null); let acc = 0, cnt = 0, st = -1; for (let i = p; i < M; i++) if (dx[i] != null) { acc += dx[i]; cnt++; if (cnt === p) { st = i; adx[i] = acc / p; break; } } if (st > 0) for (let i = st + 1; i < M; i++) if (dx[i] != null) adx[i] = (adx[i - 1] * (p - 1) + dx[i]) / p; return adx; }
const RSI = rsiS(CL, 14), STK = stochKS(14), BBL = bbLowS(), ATR = atrS(14), ADX = adxS(14), WARM = 220;
const rng = i => ADX[i] != null && ADX[i] < 25;
const ENTRIES = {
  E_RSI35d:  i => RSI[i - 1] != null && RSI[i - 1] >= 35 && RSI[i] < 35,
  E_RSI30d:  i => RSI[i - 1] != null && RSI[i - 1] >= 30 && RSI[i] < 30,
  E_RSI40u:  i => RSI[i - 1] != null && RSI[i - 1] < 40 && RSI[i] >= 40,
  E_STK20u:  i => STK[i - 1] != null && STK[i - 1] < 20 && STK[i] >= 20,
  E_BBrec:   i => BBL[i - 1] != null && CL[i - 1] < BBL[i - 1] && CL[i] >= BBL[i],
  E_ANYrev:  i => (RSI[i - 1] != null && RSI[i - 1] < 40 && RSI[i] >= 40) || (STK[i - 1] != null && STK[i - 1] < 20 && STK[i] >= 20) || (BBL[i - 1] != null && CL[i - 1] < BBL[i - 1] && CL[i] >= BBL[i]),
  E_ANYrev_R: i => rng(i) && ((RSI[i - 1] != null && RSI[i - 1] < 40 && RSI[i] >= 40) || (STK[i - 1] != null && STK[i - 1] < 20 && STK[i] >= 20) || (BBL[i - 1] != null && CL[i - 1] < BBL[i - 1] && CL[i] >= BBL[i])),
  E_RSI35d_R: i => rng(i) && RSI[i - 1] != null && RSI[i - 1] >= 35 && RSI[i] < 35,
};
const G = 1.2, N = 3, WIDEN = 1.5, HARD = 6, TP2 = 0.3;
function cumDist(adds) { let d = 0; for (let k = 0; k <= adds; k++) d += G * Math.pow(WIDEN, k); return d; }
function sim(entryFn, iStart, iEnd) {
  let wallet = INITIAL, peak = INITIAL, trough = INITIAL, lastE = -1e9, camp = 0, win = 0, worst = 0, hard = 0; const py = {}; let a = null;
  for (let i = Math.max(iStart, WARM); i < iEnd; i++) {
    const px = CL[i], atr = ATR[i] || 0, yr = new Date(C1[i].t).getUTCFullYear();
    if (a) {
      if (a.adds < N) { const lvl = a.firstEntry - cumDist(a.adds) * a.atr0; if (LL[i] <= lvl) { a.cost += Q0 * lvl; a.qty += Q0; a.adds++; wallet -= Q0 * lvl * FEE; } }
      const avg = a.cost / a.qty, tpPx = avg + TP2 * a.atr0, hardPx = a.firstEntry - HARD * a.atr0;
      let done = false, pnl = 0, isHard = false;
      if (LL[i] <= hardPx) { pnl = a.qty * (hardPx - avg) - a.qty * hardPx * FEE; done = true; isHard = true; }
      else if (HH[i] >= tpPx) { pnl = a.qty * (tpPx - avg) - a.qty * tpPx * FEE; done = true; }
      if (done) { wallet += pnl; camp++; if (pnl >= 0) win++; if (pnl < worst) worst = pnl; if (isHard) hard++; py[yr] = (py[yr] || 0) + pnl; a = null; }
    }
    if (!a && atr > 0 && (i - lastE >= 2) && entryFn(i)) { lastE = i; a = { firstEntry: px, cost: Q0 * px, qty: Q0, adds: 0, atr0: atr }; wallet -= Q0 * px * FEE; }
    let up = a ? a.qty * (px - a.cost / a.qty) : 0; const eq = wallet + up; if (eq > peak) peak = eq; if (eq < trough) trough = eq;
  }
  if (a) wallet += a.qty * (CL[iEnd - 1] - a.cost / a.qty);
  const roi = (wallet - INITIAL) / INITIAL * 100, dd = peak > trough ? (peak - trough) / peak * 100 : 0;
  const yp = Object.values(py).filter(v => v >= 0).length, yrs = Object.keys(py).length, span = (C1[iEnd - 1].t - C1[Math.max(iStart, WARM)].t) / (365 * 86400000);
  return { roi, dd, ra: dd > 0 ? roi / dd : roi, wr: camp ? win / camp * 100 : 0, camp, perYr: camp / span, worst, hard, yp, yrs };
}
const split = Math.floor(M * 0.7), rTs = Date.UTC(2025, 0, 1); let rIdx = C1.findIndex(x => x.t >= rTs);
console.log(`\n=== IMPROVE hedge05 · grid rescue × 8 ENTRY · BTC 7y ===`);
console.log(`Cơ chế cứu cố định (đã validate). Tìm entry nâng RA + #camp mà giữ robust.\n`);
console.log(`Entry       | ROI%  |  DD%  |   RA   | WR%  | camp/yr | worst$ | hardSL | stab | TRAIN→TEST  | REC ROI`);
console.log(`------------|-------|-------|--------|------|---------|--------|--------|------|-------------|--------`);
const rows = [];
for (const [name, fn] of Object.entries(ENTRIES)) {
  const f = sim(fn, 0, M), tr = sim(fn, 0, split), ts = sim(fn, split, M), rc = sim(fn, rIdx, M);
  const ret = tr.ra > 0 ? ts.ra / tr.ra : (ts.ra >= 0 ? 1 : 0), fl = ret >= 0.7 ? "✅" : ret >= 0.4 ? "⚠️" : "❌";
  rows.push({ name, f, ret, rc, fl });
  console.log(`${name.padEnd(11)} | ${(f.roi >= 0 ? "+" : "")}${f.roi.toFixed(1).padStart(4)} | ${f.dd.toFixed(1).padStart(5)} | ${(f.ra >= 0 ? "+" : "")}${f.ra.toFixed(3).padStart(6)} | ${f.wr.toFixed(0).padStart(4)} | ${f.perYr.toFixed(0).padStart(7)} | ${f.worst.toFixed(0).padStart(6)} | ${String(f.hard).padStart(6)} | ${f.yp}/${f.yrs}  | ${(tr.ra >= 0 ? "+" : "")}${tr.ra.toFixed(2)}→${(ts.ra >= 0 ? "+" : "")}${ts.ra.toFixed(2)} ${fl} | ${(rc.roi >= 0 ? "+" : "")}${rc.roi.toFixed(1)}%`);
}
console.log(`\n=== Ứng viên IMPROVE (RA≥1.0 & WF≥0.7 & recent>0) sort theo ROI ===`);
const cand = rows.filter(r => r.f.ra >= 1.0 && r.ret >= 0.7 && r.rc.roi > 0).sort((a, b) => b.f.roi - a.f.roi);
for (const r of cand) console.log(`  ${r.name}: ROI +${r.f.roi.toFixed(1)}% RA ${r.f.ra.toFixed(3)} camp/yr ${r.f.perYr.toFixed(0)} worst ${r.f.worst.toFixed(0)} recent +${r.rc.roi.toFixed(1)}%`);
if (!cand.length) console.log("  (baseline RSI35d vẫn tốt nhất)");
console.log(`[done]`);
