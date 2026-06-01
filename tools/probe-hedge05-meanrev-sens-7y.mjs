/**
 * probe-hedge05-meanrev-sens-7y.mjs  (anh Tommy 2026-06-01)
 * PROBE v7 — SENSITIVITY quanh winner v6: ANY-cross/RANGE(ADX<25)/SL2-TP3.
 * Vùng phẳng robust (nhiều config quanh đó cùng dương+WF-pass) = edge thật.
 * Chỉ 1 điểm dương = overfit corner → bỏ.
 * PASS = RA_full>0 & WF retain≥40% & RECENT'25 ROI>0.
 */
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const INITIAL = 100000, FEE_SIDE = 0.05 / 100, QTY = 0.05, HOUR_MS = 3600000;
const c5 = JSON.parse(readFileSync(join(__dirname, "..", ".cache", "binance-5m-7y.json"), "utf8"));
const hMap = new Map();
for (let i = 0; i < c5.length; i++) { const b = c5[i], k = Math.floor(b.time / HOUR_MS); let h = hMap.get(k); if (!h) hMap.set(k, { t: k * HOUR_MS, o: b.open, h: b.high, l: b.low, c: b.close }); else { if (b.high > h.h) h.h = b.high; if (b.low < h.l) h.l = b.low; h.c = b.close; } }
const C1 = [...hMap.values()].sort((a, b) => a.t - b.t);
const M = C1.length, H = C1.map(x => x.h), L = C1.map(x => x.l), CL = C1.map(x => x.c);
function rsi(c, p) { const o = new Array(c.length).fill(null); if (c.length <= p) return o; let g = 0, l = 0; for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; if (d >= 0) g += d; else l -= d; } let ag = g / p, al = l / p; o[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); for (let i = p + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; ag = (ag * (p - 1) + Math.max(d, 0)) / p; al = (al * (p - 1) + Math.max(-d, 0)) / p; o[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); } return o; }
function sma(a, p) { const o = new Array(a.length).fill(null); let s = 0; for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= p) s -= a[i - p]; if (i >= p - 1) o[i] = s / p; } return o; }
function bbLower(c, p, k) { const m = sma(c, p), o = new Array(c.length).fill(null); for (let i = p - 1; i < c.length; i++) { let sq = 0; for (let j = i - p + 1; j <= i; j++) sq += (c[j] - m[i]) ** 2; o[i] = m[i] - k * Math.sqrt(sq / p); } return o; }
function stochK(p) { const o = new Array(M).fill(null); for (let i = p - 1; i < M; i++) { let hi = -Infinity, lo = Infinity; for (let j = i - p + 1; j <= i; j++) { if (H[j] > hi) hi = H[j]; if (L[j] < lo) lo = L[j]; } o[i] = hi === lo ? 50 : (CL[i] - lo) / (hi - lo) * 100; } return o; }
function atr(p) { const tr = new Array(M).fill(0); for (let i = 1; i < M; i++) tr[i] = Math.max(H[i] - L[i], Math.abs(H[i] - CL[i - 1]), Math.abs(L[i] - CL[i - 1])); const o = new Array(M).fill(null); let s = 0; for (let i = 1; i <= p; i++) s += tr[i]; o[p] = s / p; for (let i = p + 1; i < M; i++) o[i] = (o[i - 1] * (p - 1) + tr[i]) / p; return o; }
function adxA(p) { const tr = new Array(M).fill(0), pD = new Array(M).fill(0), nD = new Array(M).fill(0); for (let i = 1; i < M; i++) { const u = H[i] - H[i - 1], dn = L[i - 1] - L[i]; pD[i] = (u > dn && u > 0) ? u : 0; nD[i] = (dn > u && dn > 0) ? dn : 0; tr[i] = Math.max(H[i] - L[i], Math.abs(H[i] - CL[i - 1]), Math.abs(L[i] - CL[i - 1])); } const sT = new Array(M).fill(0), sP = new Array(M).fill(0), sN = new Array(M).fill(0); let t0 = 0, p0 = 0, n0 = 0; for (let i = 1; i <= p; i++) { t0 += tr[i]; p0 += pD[i]; n0 += nD[i]; } sT[p] = t0; sP[p] = p0; sN[p] = n0; for (let i = p + 1; i < M; i++) { sT[i] = sT[i - 1] - sT[i - 1] / p + tr[i]; sP[i] = sP[i - 1] - sP[i - 1] / p + pD[i]; sN[i] = sN[i - 1] - sN[i - 1] / p + nD[i]; } const dx = new Array(M).fill(null); for (let i = p; i < M; i++) { if (sT[i] === 0) continue; const a = 100 * sP[i] / sT[i], b = 100 * sN[i] / sT[i], s = a + b; dx[i] = s === 0 ? 0 : 100 * Math.abs(a - b) / s; } const adx = new Array(M).fill(null); let acc = 0, cnt = 0, st = -1; for (let i = p; i < M; i++) if (dx[i] != null) { acc += dx[i]; cnt++; if (cnt === p) { st = i; adx[i] = acc / p; break; } } if (st > 0) for (let i = st + 1; i < M; i++) if (dx[i] != null) adx[i] = (adx[i - 1] * (p - 1) + dx[i]) / p; return adx; }
const RSI = rsi(CL, 14), BBL = bbLower(CL, 20, 2), STK = stochK(14), ATR = atr(14), ADX = adxA(14), WARM = 220;
function crossScore(i, rsiThr) { let s = 0; if (RSI[i - 1] != null && RSI[i] != null && RSI[i - 1] < rsiThr && RSI[i] >= rsiThr) s++; if (STK[i - 1] != null && STK[i] != null && STK[i - 1] < 20 && STK[i] >= 20) s++; if (BBL[i - 1] != null && BBL[i] != null && CL[i - 1] < BBL[i - 1] && CL[i] >= BBL[i]) s++; return s; }
function sim(rsiThr, adxMax, slM, tpM, cdH, iStart, iEnd) {
  let wallet = INITIAL, peak = INITIAL, trough = INITIAL, n = 0, win = 0, lastEntry = -1e9; const perYear = {}; const open = [];
  for (let i = Math.max(iStart, WARM); i < iEnd; i++) {
    const bar = C1[i], price = bar.c, yr = new Date(bar.t).getUTCFullYear();
    for (let k = open.length - 1; k >= 0; k--) { const t = open[k]; let cx = null; if (bar.l <= t.sl) cx = t.sl; else if (bar.h >= t.tp) cx = t.tp; else if (i - t.openIdx >= 24) cx = price; if (cx != null) { const g = QTY * (cx - t.entry) - QTY * cx * FEE_SIDE; wallet += g; n++; if (g >= 0) win++; perYear[yr] = (perYear[yr] || 0) + g; open.splice(k, 1); } }
    if (ATR[i] != null && ATR[i] > 0 && (i - lastEntry >= cdH) && ADX[i] != null && ADX[i] < adxMax && crossScore(i, rsiThr) >= 1) { wallet -= QTY * price * FEE_SIDE; open.push({ entry: price, tp: price + tpM * ATR[i], sl: price - slM * ATR[i], openIdx: i }); lastEntry = i; }
    let up = 0; for (const t of open) up += QTY * (price - t.entry); const eq = wallet + up; if (eq > peak) peak = eq; if (eq < trough) trough = eq;
  }
  const last = C1[iEnd - 1].c; for (const t of open) wallet += QTY * (last - t.entry);
  const roi = (wallet - INITIAL) / INITIAL * 100, ddPct = peak > trough ? (peak - trough) / peak * 100 : 0;
  const yrsPos = Object.values(perYear).filter(v => v >= 0).length, yrs = Object.keys(perYear).length;
  const span = Math.max(0.1, (C1[iEnd - 1].t - C1[Math.max(iStart, WARM)].t) / (365 * 86400000));
  return { roi, ddPct, ra: ddPct > 0 ? roi / ddPct : roi, wr: n ? win / n * 100 : 0, n, perYr: n / span, perYear, yrs, yrsPos };
}
const split = Math.floor(M * 0.7), recentTs = Date.UTC(2025, 0, 1);
let recentIdx = C1.findIndex(x => x.t >= recentTs); if (recentIdx < 0) recentIdx = M - 1;
function evalCfg(rsiThr, adxMax, slM, tpM, cdH) {
  const full = sim(rsiThr, adxMax, slM, tpM, cdH, 0, M), trn = sim(rsiThr, adxMax, slM, tpM, cdH, 0, split), tst = sim(rsiThr, adxMax, slM, tpM, cdH, split, M), rec = sim(rsiThr, adxMax, slM, tpM, cdH, recentIdx, M);
  const retain = trn.ra > 0 ? tst.ra / trn.ra : (tst.ra >= 0 ? 1 : 0);
  const pass = full.ra > 0 && retain >= 0.4 && rec.roi > 0;
  return { full, retain, rec, pass };
}
console.log(`\n=== PROBE v7 SENSITIVITY quanh winner (ANY/ADX<25/SL2-TP3/cd2/rsi40) · BTC 7y ===`);
console.log(`PASS = RA_full>0 & retain≥40% & RECENT'25 ROI>0\n`);
console.log(`rsi | adxMax | SL  | TP  | cd | RA full | DD%  | ent/yr | stab | retain | REC ROI | PASS`);
console.log(`----|--------|-----|-----|----|---------|------|--------|------|--------|---------|-----`);
const grid = [];
// SL×TP neighborhood
for (const slM of [1.8, 2, 2.2]) for (const tpM of [2.5, 3, 3.5]) grid.push([40, 25, slM, tpM, 2]);
// adx + cd + rsi sweeps tại center SL2/TP3
for (const a of [22, 28]) grid.push([40, a, 2, 3, 2]);
for (const cd of [1, 3]) grid.push([40, 25, 2, 3, cd]);
for (const r of [38, 42]) grid.push([r, 25, 2, 3, 2]);
let pass = 0;
for (const [rsiThr, adxMax, slM, tpM, cdH] of grid) {
  const r = evalCfg(rsiThr, adxMax, slM, tpM, cdH);
  if (r.pass) pass++;
  console.log(`${rsiThr} |   ${String(adxMax).padStart(4)} | ${slM.toFixed(1)} | ${tpM.toFixed(1)} | ${cdH}h | ${(r.full.ra>=0?"+":"")}${r.full.ra.toFixed(3).padStart(6)} | ${r.full.ddPct.toFixed(1).padStart(4)} | ${r.full.perYr.toFixed(0).padStart(6)} | ${r.full.yrsPos}/${r.full.yrs}  | ${(r.retain*100).toFixed(0).padStart(5)}% | ${(r.rec.roi>=0?"+":"")}${r.rec.roi.toFixed(1).padStart(5)}% | ${r.pass?"✅":"❌"}`);
}
console.log(`\n→ ${pass}/${grid.length} cấu hình PASS. ${pass >= grid.length*0.6 ? "✅ VÙNG PHẲNG ROBUST — edge thật" : pass >= grid.length*0.3 ? "⚠️ BÁN-ỔN — cần lọc thêm" : "❌ GÓC OVERFIT — bỏ"}`);
console.log(`[done]`);
