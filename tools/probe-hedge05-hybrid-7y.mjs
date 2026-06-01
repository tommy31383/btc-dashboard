/**
 * probe-hedge05-hybrid-7y.mjs  (anh Tommy 2026-06-01)
 * PROBE v8 — HYBRID (option 1): trend NGÀY chọn HƯỚNG + mean-rev cross vào LỆNH.
 *   Gate ngày (EMA50/EMA200 daily) → chỉ cho LONG khi ngày UP.
 *   Entry = mean-rev cross robust (RSI↑40/Stoch↑20/BB reclaim) trong ADX(1h)<25, SL2/TP3.
 * "Mua dip trong uptrend" — kỳ vọng cải thiện stab 3/8 (không fade ngược trend ngày).
 * So sánh gate: NONE(=pure mean-rev) | D_EMA50 | D_EMA200. WF retain + lát 2025.
 */
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const INITIAL = 100000, FEE_SIDE = 0.05 / 100, QTY = 0.05, HOUR_MS = 3600000, DAY_MS = 86400000;
const c5 = JSON.parse(readFileSync(join(__dirname, "..", ".cache", "binance-5m-7y.json"), "utf8"));
// 1h
const hMap = new Map();
for (let i = 0; i < c5.length; i++) { const b = c5[i], k = Math.floor(b.time / HOUR_MS); let h = hMap.get(k); if (!h) hMap.set(k, { t: k * HOUR_MS, o: b.open, h: b.high, l: b.low, c: b.close }); else { if (b.high > h.h) h.h = b.high; if (b.low < h.l) h.l = b.low; h.c = b.close; } }
const C1 = [...hMap.values()].sort((a, b) => a.t - b.t);
const M = C1.length, H = C1.map(x => x.h), L = C1.map(x => x.l), CL = C1.map(x => x.c);
// daily
const dMap = new Map();
for (let i = 0; i < c5.length; i++) { const b = c5[i], k = Math.floor(b.time / DAY_MS); let d = dMap.get(k); if (!d) dMap.set(k, { key: k, c: b.close }); else d.c = b.close; }
const days = [...dMap.values()].sort((a, b) => a.key - b.key);
const DC = days.map(d => d.c);
function emaArr(a, p) { const o = new Array(a.length).fill(null), k = 2 / (p + 1); let e = 0; for (let i = 0; i < p; i++) e += a[i]; e /= p; o[p - 1] = e; for (let i = p; i < a.length; i++) { e = a[i] * k + e * (1 - k); o[i] = e; } return o; }
const dEMA50 = emaArr(DC, 50), dEMA200 = emaArr(DC, 200);
const dayIdxByKey = new Map(days.map((d, j) => [d.key, j]));
// gate cho 1h bar tại thời điểm t: dùng daily candle ĐÃ ĐÓNG (day-1)
function dailyTrend(t, kind) {
  const dk = Math.floor(t / DAY_MS), j = dayIdxByKey.get(dk);
  if (j == null || j < 1) return false;
  const jp = j - 1; // daily đã đóng
  if (kind === "NONE") return true;
  if (kind === "D_EMA50") return dEMA50[jp] != null && DC[jp] > dEMA50[jp];
  if (kind === "D_EMA200") return dEMA200[jp] != null && DC[jp] > dEMA200[jp];
  return true;
}
// 1h indicators
function rsi(c, p) { const o = new Array(c.length).fill(null); if (c.length <= p) return o; let g = 0, l = 0; for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; if (d >= 0) g += d; else l -= d; } let ag = g / p, al = l / p; o[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); for (let i = p + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; ag = (ag * (p - 1) + Math.max(d, 0)) / p; al = (al * (p - 1) + Math.max(-d, 0)) / p; o[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); } return o; }
function sma(a, p) { const o = new Array(a.length).fill(null); let s = 0; for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= p) s -= a[i - p]; if (i >= p - 1) o[i] = s / p; } return o; }
function bbLower(c, p, k) { const m = sma(c, p), o = new Array(c.length).fill(null); for (let i = p - 1; i < c.length; i++) { let sq = 0; for (let j = i - p + 1; j <= i; j++) sq += (c[j] - m[i]) ** 2; o[i] = m[i] - k * Math.sqrt(sq / p); } return o; }
function stochK(p) { const o = new Array(M).fill(null); for (let i = p - 1; i < M; i++) { let hi = -Infinity, lo = Infinity; for (let j = i - p + 1; j <= i; j++) { if (H[j] > hi) hi = H[j]; if (L[j] < lo) lo = L[j]; } o[i] = hi === lo ? 50 : (CL[i] - lo) / (hi - lo) * 100; } return o; }
function atr(p) { const tr = new Array(M).fill(0); for (let i = 1; i < M; i++) tr[i] = Math.max(H[i] - L[i], Math.abs(H[i] - CL[i - 1]), Math.abs(L[i] - CL[i - 1])); const o = new Array(M).fill(null); let s = 0; for (let i = 1; i <= p; i++) s += tr[i]; o[p] = s / p; for (let i = p + 1; i < M; i++) o[i] = (o[i - 1] * (p - 1) + tr[i]) / p; return o; }
function adxA(p) { const tr = new Array(M).fill(0), pD = new Array(M).fill(0), nD = new Array(M).fill(0); for (let i = 1; i < M; i++) { const u = H[i] - H[i - 1], dn = L[i - 1] - L[i]; pD[i] = (u > dn && u > 0) ? u : 0; nD[i] = (dn > u && dn > 0) ? dn : 0; tr[i] = Math.max(H[i] - L[i], Math.abs(H[i] - CL[i - 1]), Math.abs(L[i] - CL[i - 1])); } const sT = new Array(M).fill(0), sP = new Array(M).fill(0), sN = new Array(M).fill(0); let t0 = 0, p0 = 0, n0 = 0; for (let i = 1; i <= p; i++) { t0 += tr[i]; p0 += pD[i]; n0 += nD[i]; } sT[p] = t0; sP[p] = p0; sN[p] = n0; for (let i = p + 1; i < M; i++) { sT[i] = sT[i - 1] - sT[i - 1] / p + tr[i]; sP[i] = sP[i - 1] - sP[i - 1] / p + pD[i]; sN[i] = sN[i - 1] - sN[i - 1] / p + nD[i]; } const dx = new Array(M).fill(null); for (let i = p; i < M; i++) { if (sT[i] === 0) continue; const a = 100 * sP[i] / sT[i], b = 100 * sN[i] / sT[i], s = a + b; dx[i] = s === 0 ? 0 : 100 * Math.abs(a - b) / s; } const adx = new Array(M).fill(null); let acc = 0, cnt = 0, st = -1; for (let i = p; i < M; i++) if (dx[i] != null) { acc += dx[i]; cnt++; if (cnt === p) { st = i; adx[i] = acc / p; break; } } if (st > 0) for (let i = st + 1; i < M; i++) if (dx[i] != null) adx[i] = (adx[i - 1] * (p - 1) + dx[i]) / p; return adx; }
const RSI = rsi(CL, 14), BBL = bbLower(CL, 20, 2), STK = stochK(14), ATR = atr(14), ADX = adxA(14), WARM = 220;
function crossScore(i, rsiThr) { let s = 0; if (RSI[i - 1] != null && RSI[i] != null && RSI[i - 1] < rsiThr && RSI[i] >= rsiThr) s++; if (STK[i - 1] != null && STK[i] != null && STK[i - 1] < 20 && STK[i] >= 20) s++; if (BBL[i - 1] != null && BBL[i] != null && CL[i - 1] < BBL[i - 1] && CL[i] >= BBL[i]) s++; return s; }
function sim(gateKind, iStart, iEnd, slM = 2, tpM = 3, cdH = 2) {
  let wallet = INITIAL, peak = INITIAL, trough = INITIAL, n = 0, win = 0, lastEntry = -1e9; const perYear = {}; const open = [];
  for (let i = Math.max(iStart, WARM); i < iEnd; i++) {
    const bar = C1[i], price = bar.c, yr = new Date(bar.t).getUTCFullYear();
    for (let k = open.length - 1; k >= 0; k--) { const t = open[k]; let cx = null; if (bar.l <= t.sl) cx = t.sl; else if (bar.h >= t.tp) cx = t.tp; else if (i - t.openIdx >= 24) cx = price; if (cx != null) { const g = QTY * (cx - t.entry) - QTY * cx * FEE_SIDE; wallet += g; n++; if (g >= 0) win++; perYear[yr] = (perYear[yr] || 0) + g; open.splice(k, 1); } }
    if (ATR[i] != null && ATR[i] > 0 && (i - lastEntry >= cdH) && ADX[i] != null && ADX[i] < 25 && dailyTrend(bar.t, gateKind) && crossScore(i, 40) >= 1) { wallet -= QTY * price * FEE_SIDE; open.push({ entry: price, tp: price + tpM * ATR[i], sl: price - slM * ATR[i], openIdx: i }); lastEntry = i; }
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
console.log(`\n=== PROBE v8 HYBRID · trend-ngày gate + mean-rev cross · BTC 7y ===`);
console.log(`Entry robust: ANY cross/rsi40/ADX(1h)<25/SL2-TP3/cd2/ts24. Chỉ đổi GATE ngày.\n`);
console.log(`Gate ngày  | RA full | DD%  | WR%  | ent/yr | stab | per-year | TRAIN→TEST retain | REC'25 ROI`);
console.log(`-----------|---------|------|------|--------|------|----------|-------------------|----------`);
for (const gk of ["NONE", "D_EMA50", "D_EMA200"]) {
  const full = sim(gk, 0, M), trn = sim(gk, 0, split), tst = sim(gk, split, M), rec = sim(gk, recentIdx, M);
  const retain = trn.ra > 0 ? tst.ra / trn.ra : (tst.ra >= 0 ? 1 : 0), flag = retain >= 0.7 ? "✅" : retain >= 0.4 ? "⚠️" : "❌";
  const ys = Object.entries(full.perYear).map(([y, v]) => `${y.slice(2)}:${v >= 0 ? "+" : ""}${(v / 1000).toFixed(1)}`).join(" ");
  console.log(`${gk.padEnd(10)} | ${(full.ra >= 0 ? "+" : "")}${full.ra.toFixed(3).padStart(6)} | ${full.ddPct.toFixed(1).padStart(4)} | ${full.wr.toFixed(0).padStart(4)} | ${full.perYr.toFixed(0).padStart(6)} | ${full.yrsPos}/${full.yrs}  | ${ys}`);
  console.log(`           |  → TRAIN ${trn.ra.toFixed(2)} → TEST ${tst.ra.toFixed(2)} retain ${(retain * 100).toFixed(0)}% ${flag} | REC RA ${(rec.ra >= 0 ? "+" : "")}${rec.ra.toFixed(2)} ROI ${(rec.roi >= 0 ? "+" : "")}${rec.roi.toFixed(1)}% n${rec.n}`);
}
console.log(`\n[done]`);
