/**
 * probe-hedge05-meanrev-freq-7y.mjs  (anh Tommy 2026-06-01)
 *
 * PROBE v5 — path 1: MEAN-REVERSION TẦN SUẤT CAO. Họ duy nhất cải thiện OOS.
 * Câu hỏi: hedge04=102/năm robust. Đẩy lên gần 365/năm (mỗi ngày) có GIỮ robust
 * + DƯƠNG ở 2025-2026 không? (mean-rev đáng lẽ sống trong chop).
 *
 * Tín hiệu LONG oversold trên 1h (resample 5m→1h):
 *   RSI(14)<thr · close<BB(20,2) lower · StochK(14)<20  → score 0..3
 *   confluence: ANY(≥1, freq cao) | 2of3 | ALL(≥3, ≈hedge04)
 * Per-trade TP/SL = mult×ATR_1h, cooldown, time-stop. LONG-only (SHORT no edge).
 * Đo: RA/WR/ent-yr + WALK-FORWARD retain + LÁT CẮT 2025→.
 */
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const INITIAL = 100000, FEE_SIDE = 0.05 / 100, QTY = 0.05, HOUR_MS = 3600000;

const c5 = JSON.parse(readFileSync(join(__dirname, "..", ".cache", "binance-5m-7y.json"), "utf8"));
// resample 5m → 1h
const hMap = new Map();
for (let i = 0; i < c5.length; i++) {
  const b = c5[i], k = Math.floor(b.time / HOUR_MS); let h = hMap.get(k);
  if (!h) hMap.set(k, { t: k * HOUR_MS, o: b.open, h: b.high, l: b.low, c: b.close });
  else { if (b.high > h.h) h.h = b.high; if (b.low < h.l) h.l = b.low; h.c = b.close; }
}
const C1 = [...hMap.values()].sort((a, b) => a.t - b.t);
const M = C1.length;
const H = C1.map(x => x.h), L = C1.map(x => x.l), CL = C1.map(x => x.c);

function rsi(c, p) { const o = new Array(c.length).fill(null); if (c.length <= p) return o; let g = 0, l = 0; for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; if (d >= 0) g += d; else l -= d; } let ag = g / p, al = l / p; o[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); for (let i = p + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; ag = (ag * (p - 1) + Math.max(d, 0)) / p; al = (al * (p - 1) + Math.max(-d, 0)) / p; o[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); } return o; }
function sma(a, p) { const o = new Array(a.length).fill(null); let s = 0; for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= p) s -= a[i - p]; if (i >= p - 1) o[i] = s / p; } return o; }
function bbLower(c, p, k) { const m = sma(c, p), o = new Array(c.length).fill(null); for (let i = p - 1; i < c.length; i++) { let sq = 0; for (let j = i - p + 1; j <= i; j++) sq += (c[j] - m[i]) ** 2; o[i] = m[i] - k * Math.sqrt(sq / p); } return o; }
function stochK(p) { const o = new Array(M).fill(null); for (let i = p - 1; i < M; i++) { let hi = -Infinity, lo = Infinity; for (let j = i - p + 1; j <= i; j++) { if (H[j] > hi) hi = H[j]; if (L[j] < lo) lo = L[j]; } o[i] = hi === lo ? 50 : (CL[i] - lo) / (hi - lo) * 100; } return o; }
function atr(p) { const tr = new Array(M).fill(0); for (let i = 1; i < M; i++) tr[i] = Math.max(H[i] - L[i], Math.abs(H[i] - CL[i - 1]), Math.abs(L[i] - CL[i - 1])); const o = new Array(M).fill(null); let s = 0; for (let i = 1; i <= p; i++) s += tr[i]; o[p] = s / p; for (let i = p + 1; i < M; i++) o[i] = (o[i - 1] * (p - 1) + tr[i]) / p; return o; }
function adxA(p) {
  const tr = new Array(M).fill(0), pD = new Array(M).fill(0), nD = new Array(M).fill(0);
  for (let i = 1; i < M; i++) { const u = H[i] - H[i - 1], dn = L[i - 1] - L[i]; pD[i] = (u > dn && u > 0) ? u : 0; nD[i] = (dn > u && dn > 0) ? dn : 0; tr[i] = Math.max(H[i] - L[i], Math.abs(H[i] - CL[i - 1]), Math.abs(L[i] - CL[i - 1])); }
  const sT = new Array(M).fill(0), sP = new Array(M).fill(0), sN = new Array(M).fill(0); let t0 = 0, p0 = 0, n0 = 0;
  for (let i = 1; i <= p; i++) { t0 += tr[i]; p0 += pD[i]; n0 += nD[i]; } sT[p] = t0; sP[p] = p0; sN[p] = n0;
  for (let i = p + 1; i < M; i++) { sT[i] = sT[i - 1] - sT[i - 1] / p + tr[i]; sP[i] = sP[i - 1] - sP[i - 1] / p + pD[i]; sN[i] = sN[i - 1] - sN[i - 1] / p + nD[i]; }
  const dx = new Array(M).fill(null);
  for (let i = p; i < M; i++) { if (sT[i] === 0) continue; const a = 100 * sP[i] / sT[i], b = 100 * sN[i] / sT[i], s = a + b; dx[i] = s === 0 ? 0 : 100 * Math.abs(a - b) / s; }
  const adx = new Array(M).fill(null); let acc = 0, cnt = 0, st = -1;
  for (let i = p; i < M; i++) if (dx[i] != null) { acc += dx[i]; cnt++; if (cnt === p) { st = i; adx[i] = acc / p; break; } }
  if (st > 0) for (let i = st + 1; i < M; i++) if (dx[i] != null) adx[i] = (adx[i - 1] * (p - 1) + dx[i]) / p;
  return adx;
}
const RSI = rsi(CL, 14), BBL = bbLower(CL, 20, 2), STK = stochK(14), ATR = atr(14), ADX = adxA(14);
const WARM = 220;

// score oversold tại bar i (đã đóng)
function score(i, rsiThr) {
  let s = 0;
  if (RSI[i] != null && RSI[i] < rsiThr) s++;
  if (BBL[i] != null && CL[i] < BBL[i]) s++;
  if (STK[i] != null && STK[i] < 20) s++;
  return s;
}
// rangeGate: ADX<25 (không trending) — mean-rev hợp range
function sim(minScore, rsiThr, rangeGate, slM, tpM, cooldownH, timeStopH, iStart, iEnd) {
  let wallet = INITIAL, peak = INITIAL, trough = INITIAL, fee = 0;
  let n = 0, win = 0, lastEntry = -1e9; const perYear = {};
  const open = []; // {entry,tp,sl,openIdx}
  for (let i = Math.max(iStart, WARM); i < iEnd; i++) {
    const bar = C1[i], price = bar.c, ts = bar.t, yr = new Date(ts).getUTCFullYear();
    // manage open
    for (let k = open.length - 1; k >= 0; k--) {
      const t = open[k]; let cx = null, w = false;
      if (bar.l <= t.sl) cx = t.sl;            // SL first
      else if (bar.h >= t.tp) { cx = t.tp; w = true; }
      else if (i - t.openIdx >= timeStopH) cx = price; // time stop
      if (cx != null) { const g = QTY * (cx - t.entry), f = QTY * cx * FEE_SIDE; wallet += g - f; fee += f; n++; if (g - f >= 0) win++; perYear[yr] = (perYear[yr] || 0) + (g - f); open.splice(k, 1); }
    }
    // entry
    if (ATR[i] != null && ATR[i] > 0 && (i - lastEntry >= cooldownH)) {
      const rangeOk = !rangeGate || (ADX[i] != null && ADX[i] < 25);
      if (rangeOk && score(i, rsiThr) >= minScore) {
        const f = QTY * price * FEE_SIDE; wallet -= f; fee += f;
        open.push({ entry: price, tp: price + tpM * ATR[i], sl: price - slM * ATR[i], openIdx: i });
        lastEntry = i;
      }
    }
    // DD sample
    let up = 0; for (const t of open) up += QTY * (price - t.entry);
    const eq = wallet + up; if (eq > peak) peak = eq; if (eq < trough) trough = eq;
  }
  const last = C1[iEnd - 1].c; for (const t of open) wallet += QTY * (last - t.entry);
  const roi = (wallet - INITIAL) / INITIAL * 100;
  const ddPct = peak > trough ? (peak - trough) / peak * 100 : 0;
  const ra = ddPct > 0 ? roi / ddPct : roi;
  const yrs = Object.keys(perYear).length, yrsPos = Object.values(perYear).filter(v => v >= 0).length;
  const span = Math.max(0.1, (C1[iEnd - 1].t - C1[Math.max(iStart, WARM)].t) / (365 * 86400000));
  return { roi, ddPct, ra, wr: n ? win / n * 100 : 0, n, perYr: n / span, fee, perYear, yrs, yrsPos };
}

const split = Math.floor(M * 0.7);
const recentTs = Date.UTC(2025, 0, 1);
let recentIdx = C1.findIndex(x => x.t >= recentTs); if (recentIdx < 0) recentIdx = M - 1;
console.log(`\n=== PROBE v5 hedge05 · MEAN-REV TẦN SUẤT CAO · BTC 7y (1h: ${M} bars) ===`);
console.log(`WF split @ ${new Date(C1[split].t).toISOString().slice(0,10)}, recent @ ${new Date(C1[recentIdx].t).toISOString().slice(0,10)}. SL×2/TP×1.5 ATR, cd 2h, ts 24h.\n`);
console.log(`conf      | rsiThr | range | RA full | DD%  | WR%  | ent/yr | stab | TRAIN→TEST retain  | RECENT'25+ RA/ROI/n`);
console.log(`----------|--------|-------|---------|------|------|--------|------|--------------------|--------------------`);
const cfgs = [];
for (const [lbl, ms] of [["ANY≥1", 1], ["2of3", 2], ["ALL=3", 3]])
  for (const rsiThr of [30, 35])
    for (const rg of [false, true])
      cfgs.push([lbl, ms, rsiThr, rg]);
const out = [];
for (const [lbl, ms, rsiThr, rg] of cfgs) {
  const full = sim(ms, rsiThr, rg, 2, 1.5, 2, 24, 0, M);
  const trn = sim(ms, rsiThr, rg, 2, 1.5, 2, 24, 0, split);
  const tst = sim(ms, rsiThr, rg, 2, 1.5, 2, 24, split, M);
  const rec = sim(ms, rsiThr, rg, 2, 1.5, 2, 24, recentIdx, M);
  const retain = trn.ra > 0 ? tst.ra / trn.ra : 0;
  const flag = retain >= 0.7 ? "✅" : retain >= 0.4 ? "⚠️" : "❌";
  out.push({ lbl, ms, rsiThr, rg, full, retain, rec });
  console.log(`${lbl.padEnd(9)} | ${String(rsiThr).padStart(6)} | ${(rg?"ADX<25":"no").padEnd(5)} | ${(full.ra>=0?"+":"")}${full.ra.toFixed(3).padStart(6)} | ${full.ddPct.toFixed(1).padStart(4)} | ${full.wr.toFixed(0).padStart(4)} | ${full.perYr.toFixed(0).padStart(6)} | ${full.yrsPos}/${full.yrs}  | ${(trn.ra>=0?"+":"")}${trn.ra.toFixed(2)}→${(tst.ra>=0?"+":"")}${tst.ra.toFixed(2)} ${(retain*100).toFixed(0).padStart(4)}% ${flag} | RA ${(rec.ra>=0?"+":"")}${rec.ra.toFixed(2)} ROI ${(rec.roi>=0?"+":"")}${rec.roi.toFixed(1)}% n${rec.n}`);
}
console.log(`\n=== Ứng viên: WF retain≥40% + RECENT dương + ent/yr cao nhất ===`);
const cand = out.filter(o => o.retain >= 0.4 && o.rec.roi > 0).sort((a, b) => b.full.perYr - a.full.perYr).slice(0, 4);
for (const o of cand) {
  const ys = Object.entries(o.full.perYear).map(([y, v]) => `${y.slice(2)}:${v>=0?"+":""}${(v/1000).toFixed(1)}k`).join(" ");
  console.log(`${o.lbl}/rsi${o.rsiThr}/${o.rg?"range":"all"}  ent/yr ${o.full.perYr.toFixed(0)} RA ${o.full.ra.toFixed(3)} DD ${o.full.ddPct.toFixed(1)}% WR ${o.full.wr.toFixed(0)}% retain ${(o.retain*100).toFixed(0)}% RECENT ROI +${o.rec.roi.toFixed(1)}%`);
  console.log(`     per-year: ${ys}`);
}
if (!cand.length) console.log("(không cấu hình nào đạt cả 2 tiêu chí)");
console.log(`\n[done]`);
