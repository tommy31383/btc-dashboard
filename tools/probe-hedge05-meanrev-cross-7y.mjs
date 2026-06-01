/**
 * probe-hedge05-meanrev-cross-7y.mjs  (anh Tommy 2026-06-01)
 *
 * PROBE v6 — SỬA BUG v5: vào lệnh khi oversold ĐANG ĐẢO (cross), như hedge04.
 *   RSI cross↑ thr · StochK cross↑ 20 · BB reclaim (close lại trên BB lower)
 * v5 bắt dao rơi (oversold thô) → WR 55% < breakeven → âm (đúng toán, sai cơ chế).
 * Câu hỏi giữ nguyên: đẩy mean-rev gần 365/năm có robust + dương 2025-26 không?
 * Per-trade TP/SL grid. LONG-only. WF retain + lát cắt 2025→.
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

// CROSS-based oversold-reversal score (như hedge04)
function crossScore(i, rsiThr) {
  let s = 0;
  if (RSI[i - 1] != null && RSI[i] != null && RSI[i - 1] < rsiThr && RSI[i] >= rsiThr) s++;       // RSI cross↑
  if (STK[i - 1] != null && STK[i] != null && STK[i - 1] < 20 && STK[i] >= 20) s++;               // Stoch cross↑20
  if (BBL[i - 1] != null && BBL[i] != null && CL[i - 1] < BBL[i - 1] && CL[i] >= BBL[i]) s++;      // BB reclaim
  return s;
}
function sim(minScore, rsiThr, rangeGate, slM, tpM, cdH, tsH, iStart, iEnd) {
  let wallet = INITIAL, peak = INITIAL, trough = INITIAL, fee = 0, n = 0, win = 0, lastEntry = -1e9; const perYear = {};
  const open = [];
  for (let i = Math.max(iStart, WARM); i < iEnd; i++) {
    const bar = C1[i], price = bar.c, ts = bar.t, yr = new Date(ts).getUTCFullYear();
    for (let k = open.length - 1; k >= 0; k--) { const t = open[k]; let cx = null, w = false; if (bar.l <= t.sl) cx = t.sl; else if (bar.h >= t.tp) { cx = t.tp; w = true; } else if (i - t.openIdx >= tsH) cx = price; if (cx != null) { const g = QTY * (cx - t.entry), f = QTY * cx * FEE_SIDE; wallet += g - f; fee += f; n++; if (g - f >= 0) win++; perYear[yr] = (perYear[yr] || 0) + (g - f); open.splice(k, 1); } }
    if (ATR[i] != null && ATR[i] > 0 && (i - lastEntry >= cdH)) {
      const rangeOk = !rangeGate || (ADX[i] != null && ADX[i] < 25);
      if (rangeOk && crossScore(i, rsiThr) >= minScore) { const f = QTY * price * FEE_SIDE; wallet -= f; fee += f; open.push({ entry: price, tp: price + tpM * ATR[i], sl: price - slM * ATR[i], openIdx: i }); lastEntry = i; }
    }
    let up = 0; for (const t of open) up += QTY * (price - t.entry); const eq = wallet + up; if (eq > peak) peak = eq; if (eq < trough) trough = eq;
  }
  const last = C1[iEnd - 1].c; for (const t of open) wallet += QTY * (last - t.entry);
  const roi = (wallet - INITIAL) / INITIAL * 100, ddPct = peak > trough ? (peak - trough) / peak * 100 : 0, ra = ddPct > 0 ? roi / ddPct : roi;
  const yrs = Object.keys(perYear).length, yrsPos = Object.values(perYear).filter(v => v >= 0).length;
  const span = Math.max(0.1, (C1[iEnd - 1].t - C1[Math.max(iStart, WARM)].t) / (365 * 86400000));
  return { roi, ddPct, ra, wr: n ? win / n * 100 : 0, n, perYr: n / span, fee, perYear, yrs, yrsPos };
}
const split = Math.floor(M * 0.7), recentTs = Date.UTC(2025, 0, 1);
let recentIdx = C1.findIndex(x => x.t >= recentTs); if (recentIdx < 0) recentIdx = M - 1;
console.log(`\n=== PROBE v6 hedge05 · MEAN-REV CROSS (đã sửa bug) · BTC 7y (1h ${M} bars) ===`);
console.log(`WF @ ${new Date(C1[split].t).toISOString().slice(0,10)}, recent @ ${new Date(C1[recentIdx].t).toISOString().slice(0,10)}. cd 2h, ts 24h.\n`);
console.log(`conf  | rsi | range  | SL/TP   | RA full | DD%  | WR%  | ent/yr | stab | TRAIN→TEST retain  | RECENT'25+ RA/ROI/n`);
console.log(`------|-----|--------|---------|---------|------|------|--------|------|--------------------|--------------------`);
const out = [];
for (const [lbl, ms] of [["ANY", 1], ["2of3", 2]])
  for (const rsiThr of [40])
    for (const rg of [false, true])
      for (const [slM, tpM] of [[2, 2], [1.5, 2.5], [2, 3]]) {
        const full = sim(ms, rsiThr, rg, slM, tpM, 2, 24, 0, M);
        const trn = sim(ms, rsiThr, rg, slM, tpM, 2, 24, 0, split);
        const tst = sim(ms, rsiThr, rg, slM, tpM, 2, 24, split, M);
        const rec = sim(ms, rsiThr, rg, slM, tpM, 2, 24, recentIdx, M);
        const retain = trn.ra > 0 ? tst.ra / trn.ra : 0, flag = retain >= 0.7 ? "✅" : retain >= 0.4 ? "⚠️" : "❌";
        out.push({ lbl, rsiThr, rg, slM, tpM, full, retain, rec });
        console.log(`${lbl.padEnd(5)} | ${rsiThr} | ${(rg?"ADX<25":"no").padEnd(6)} | ${slM}/${tpM} ATR | ${(full.ra>=0?"+":"")}${full.ra.toFixed(3).padStart(6)} | ${full.ddPct.toFixed(1).padStart(4)} | ${full.wr.toFixed(0).padStart(4)} | ${full.perYr.toFixed(0).padStart(6)} | ${full.yrsPos}/${full.yrs}  | ${(trn.ra>=0?"+":"")}${trn.ra.toFixed(2)}→${(tst.ra>=0?"+":"")}${tst.ra.toFixed(2)} ${(retain*100).toFixed(0).padStart(4)}% ${flag} | RA ${(rec.ra>=0?"+":"")}${rec.ra.toFixed(2)} ROI ${(rec.roi>=0?"+":"")}${rec.roi.toFixed(1)}% n${rec.n}`);
      }
console.log(`\n=== Ứng viên (retain≥40% + RECENT dương) sort theo ent/yr ===`);
const cand = out.filter(o => o.retain >= 0.4 && o.rec.roi > 0).sort((a, b) => b.full.perYr - a.full.perYr);
for (const o of cand.slice(0, 5)) { const ys = Object.entries(o.full.perYear).map(([y, v]) => `${y.slice(2)}:${v>=0?"+":""}${(v/1000).toFixed(1)}k`).join(" "); console.log(`${o.lbl}/rsi${o.rsiThr}/${o.rg?"range":"all"}/SL${o.slM}TP${o.tpM}  ent/yr ${o.full.perYr.toFixed(0)} RA ${o.full.ra.toFixed(3)} DD ${o.full.ddPct.toFixed(1)}% WR ${o.full.wr.toFixed(0)}% retain ${(o.retain*100).toFixed(0)}% RECENT +${o.rec.roi.toFixed(1)}%`); console.log(`     ${ys}`); }
if (!cand.length) console.log("(không cấu hình nào đạt — mean-rev high-freq cũng không robust)");
console.log(`\n[done]`);
