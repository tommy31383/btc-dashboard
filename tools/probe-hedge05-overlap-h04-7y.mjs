/**
 * probe-hedge05-overlap-h04-7y.mjs  (anh Tommy 2026-06-01)
 * TEST: đo overlap thật giữa hedge05-mean-rev và hedge04 (live).
 *   - Replicate hedge04 chính xác (4h RANGE + ADX>20 sticky + ATR35th + EMA200_1h + S04B/R/K)
 *   - hedge05 mean-rev: 1h ADX<25 + ANY cross + SL2/TP3
 *   - Overlap = % entry hedge05 nằm trong ±2h của 1 entry hedge04
 *   - Marginal: sim CHỈ entry hedge05 KHÔNG trùng → RA/WR/recent (có giá trị riêng?)
 * Sanity: hedge04-replica phải ra ~102/năm (≈714/7y) mới tin được.
 */
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const INITIAL = 100000, FEE_SIDE = 0.05 / 100, QTY = 0.05, HOUR = 3600000, H4 = 4 * HOUR, DAY = 86400000;
const c5 = JSON.parse(readFileSync(join(__dirname, "..", ".cache", "binance-5m-7y.json"), "utf8"));
function resample(ms) { const m = new Map(); for (let i = 0; i < c5.length; i++) { const b = c5[i], k = Math.floor(b.time / ms); let d = m.get(k); if (!d) m.set(k, { key: k, t: k * ms, o: b.open, h: b.high, l: b.low, c: b.close }); else { if (b.high > d.h) d.h = b.high; if (b.low < d.l) d.l = b.low; d.c = b.close; } } return [...m.values()].sort((a, b) => a.key - b.key); }
const C1 = resample(HOUR), C4 = resample(H4), CD = resample(DAY);
const map4 = new Map(C4.map((b, i) => [b.key, i])), mapD = new Map(CD.map((b, i) => [b.key, i]));
// ---- indicators ----
function rsiS(c, p) { const o = new Array(c.length).fill(null); if (c.length <= p) return o; let g = 0, l = 0; for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; if (d >= 0) g += d; else l -= d; } let ag = g / p, al = l / p; o[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); for (let i = p + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; ag = (ag * (p - 1) + Math.max(d, 0)) / p; al = (al * (p - 1) + Math.max(-d, 0)) / p; o[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); } return o; }
function stochKS(bars, p) { const o = new Array(bars.length).fill(null); for (let i = p - 1; i < bars.length; i++) { let hi = -Infinity, lo = Infinity; for (let j = i - p + 1; j <= i; j++) { if (bars[j].h > hi) hi = bars[j].h; if (bars[j].l < lo) lo = bars[j].l; } o[i] = hi === lo ? 50 : (bars[i].c - lo) / (hi - lo) * 100; } return o; }
function atrS(bars, p) { const N = bars.length, tr = new Array(N).fill(0); for (let i = 1; i < N; i++) tr[i] = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c)); const o = new Array(N).fill(null); if (N <= p) return o; let s = 0; for (let i = 1; i <= p; i++) s += tr[i]; o[p] = s / p; for (let i = p + 1; i < N; i++) o[i] = (o[i - 1] * (p - 1) + tr[i]) / p; return o; }
function emaLast(c, p) { const o = new Array(c.length).fill(null); if (c.length < p) return o; const k = 2 / (p + 1); let e = 0; for (let i = 0; i < p; i++) e += c[i]; e /= p; o[p - 1] = e; for (let i = p; i < c.length; i++) { e = c[i] * k + e * (1 - k); o[i] = e; } return o; }
function adxS(bars, p) { const N = bars.length, tr = new Array(N).fill(0), pD = new Array(N).fill(0), nD = new Array(N).fill(0); for (let i = 1; i < N; i++) { const u = bars[i].h - bars[i - 1].h, dn = bars[i - 1].l - bars[i].l; pD[i] = (u > dn && u > 0) ? u : 0; nD[i] = (dn > u && dn > 0) ? dn : 0; tr[i] = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c)); } const sT = new Array(N).fill(0), sP = new Array(N).fill(0), sN = new Array(N).fill(0); let t0 = 0, p0 = 0, n0 = 0; for (let i = 1; i <= p; i++) { t0 += tr[i]; p0 += pD[i]; n0 += nD[i]; } sT[p] = t0; sP[p] = p0; sN[p] = n0; for (let i = p + 1; i < N; i++) { sT[i] = sT[i - 1] - sT[i - 1] / p + tr[i]; sP[i] = sP[i - 1] - sP[i - 1] / p + pD[i]; sN[i] = sN[i - 1] - sN[i - 1] / p + nD[i]; } const dx = new Array(N).fill(null); for (let i = p; i < N; i++) { if (sT[i] === 0) continue; const a = 100 * sP[i] / sT[i], b = 100 * sN[i] / sT[i], s = a + b; dx[i] = s === 0 ? 0 : 100 * Math.abs(a - b) / s; } const adx = new Array(N).fill(null); let acc = 0, cnt = 0, st = -1; for (let i = p; i < N; i++) if (dx[i] != null) { acc += dx[i]; cnt++; if (cnt === p) { st = i; adx[i] = acc / p; break; } } if (st > 0) for (let i = st + 1; i < N; i++) if (dx[i] != null) adx[i] = (adx[i - 1] * (p - 1) + dx[i]) / p; return adx; }
// 1h
const cl1 = C1.map(b => b.c);
const RSI1 = rsiS(cl1, 14), STK1 = stochKS(C1, 14), ATR1 = atrS(C1, 14), EMA200_1 = emaLast(cl1, 200), ADX1 = adxS(C1, 14);
const BBL1 = (() => { const o = new Array(C1.length).fill(null); for (let i = 19; i < C1.length; i++) { let s = 0; for (let j = i - 19; j <= i; j++) s += cl1[j]; const m = s / 20; let sq = 0; for (let j = i - 19; j <= i; j++) sq += (cl1[j] - m) ** 2; o[i] = m - 2 * Math.sqrt(sq / 20); } return o; })();
// 4h ADX + ATR%ile pass
const ADX4 = adxS(C4, 14), ATR4 = atrS(C4, 14);
const ATR4PASS = (() => { const o = new Array(C4.length).fill(false); for (let i = 0; i < C4.length; i++) { if (ATR4[i] == null || i < 90 + 14) continue; const cur = ATR4[i] / C4[i].c; const arr = []; for (let j = i - 90; j < i; j++) if (ATR4[j] != null) arr.push(ATR4[j] / C4[j].c); if (arr.length < 90) continue; arr.sort((a, b) => a - b); o[i] = cur >= arr[Math.floor(arr.length * 0.35)]; } return o; })();
// 1d regime (RANGE/BULL/BEAR + 3-bar persist)
const REGIME = (() => { const n = CD.length, raw = []; for (let i = 0; i < n; i++) { if (i < 200) { raw.push("RANGE"); continue; } let s200 = 0; for (let j = i - 199; j <= i; j++) s200 += CD[j].c; const ma200 = s200 / 200; let s50 = 0; for (let j = i - 49; j <= i; j++) s50 += CD[j].c; const ma50 = s50 / 50; let ar = 0; for (let j = i - 19; j <= i; j++) ar += (CD[j].h - CD[j].l) / CD[j].c; ar /= 20; if (CD[i].c < ma200) raw.push("BEAR"); else if (CD[i].c > ma50 && ma50 > ma200 && ar > 0.04) raw.push("BULL"); else raw.push("RANGE"); } const out = new Array(n).fill("RANGE"); let cur = "RANGE", cnt = 0, lastRaw = "RANGE"; for (let i = 0; i < n; i++) { if (raw[i] === lastRaw) cnt++; else { cnt = 1; lastRaw = raw[i]; } if (cnt >= 3) cur = raw[i]; out[i] = cur; } return out; })();
// map 1h bar → last completed 4h idx / 1d idx (lookahead-safe: dùng bar đã đóng trước t)
function idx4At(t) { return map4.get(Math.floor(t / H4) - 1); }
function idxDAt(t) { return mapD.get(Math.floor(t / DAY) - 1); }

const WARM = 220, split = Math.floor(C1.length * 0.7), recentTs = Date.UTC(2025, 0, 1);
let recentIdx = C1.findIndex(x => x.t >= recentTs);

// ---- collect entries ----
function hedge04Entries() {
  const ent = []; let cdB = -1e18, cdR = -1e18, cdK = -1e18;
  for (let i = WARM; i < C1.length; i++) {
    const t = C1[i].t, bar = C1[i];
    const di = idxDAt(t); if (di == null || REGIME[di] !== "RANGE") continue;
    const k4 = idx4At(t); if (k4 == null || k4 < 1) continue;
    if (ADX4[k4] == null || ADX4[k4] <= 20 || ADX4[k4 - 1] == null || ADX4[k4 - 1] <= 20) continue;
    if (!ATR4PASS[k4]) continue;
    if (EMA200_1[i] == null || bar.c < EMA200_1[i]) continue;
    if (ATR1[i] == null || ATR1[i] <= 0) continue;
    // S04B
    if (BBL1[i] != null && bar.l <= BBL1[i] && bar.c > bar.o && t - cdB >= 2 * HOUR) { ent.push(t); cdB = t; }
    if (RSI1[i - 1] != null && RSI1[i] != null && RSI1[i - 1] < 40 && RSI1[i] >= 40 && t - cdR >= 2 * HOUR) { ent.push(t); cdR = t; }
    if (STK1[i - 1] != null && STK1[i] != null && STK1[i - 1] < 20 && STK1[i] >= 20 && t - cdK >= 2 * HOUR) { ent.push(t); cdK = t; }
  }
  return ent;
}
// hedge05: trả entry index list (1h) + cho phép filter
function hedge05Sim(filterFn, iStart, iEnd) {
  let wallet = INITIAL, peak = INITIAL, trough = INITIAL, n = 0, win = 0, lastEntry = -1e9; const perYear = {}; const open = []; const entTimes = [];
  for (let i = Math.max(iStart, WARM); i < iEnd; i++) {
    const bar = C1[i], price = bar.c, yr = new Date(bar.t).getUTCFullYear();
    for (let k = open.length - 1; k >= 0; k--) { const tt = open[k]; let cx = null; if (bar.l <= tt.sl) cx = tt.sl; else if (bar.h >= tt.tp) cx = tt.tp; else if (i - tt.openIdx >= 24) cx = price; if (cx != null) { const g = QTY * (cx - tt.entry) - QTY * cx * FEE_SIDE; wallet += g; n++; if (g >= 0) win++; perYear[yr] = (perYear[yr] || 0) + g; open.splice(k, 1); } }
    const cross = (RSI1[i - 1] != null && RSI1[i - 1] < 40 && RSI1[i] >= 40) || (STK1[i - 1] != null && STK1[i - 1] < 20 && STK1[i] >= 20) || (BBL1[i - 1] != null && cl1[i - 1] < BBL1[i - 1] && cl1[i] >= BBL1[i]);
    if (ATR1[i] != null && ATR1[i] > 0 && (i - lastEntry >= 2) && ADX1[i] != null && ADX1[i] < 25 && cross && (!filterFn || filterFn(bar.t))) { wallet -= QTY * price * FEE_SIDE; open.push({ entry: price, tp: price + 3 * ATR1[i], sl: price - 2 * ATR1[i], openIdx: i }); lastEntry = i; entTimes.push(bar.t); }
    let up = 0; for (const tt of open) up += QTY * (price - tt.entry); const eq = wallet + up; if (eq > peak) peak = eq; if (eq < trough) trough = eq;
  }
  const last = C1[iEnd - 1].c; for (const tt of open) wallet += QTY * (last - tt.entry);
  const roi = (wallet - INITIAL) / INITIAL * 100, ddPct = peak > trough ? (peak - trough) / peak * 100 : 0;
  const yrsPos = Object.values(perYear).filter(v => v >= 0).length, yrs = Object.keys(perYear).length;
  return { roi, ddPct, ra: ddPct > 0 ? roi / ddPct : roi, wr: n ? win / n * 100 : 0, n, entTimes, yrsPos, yrs };
}

console.log(`\n=== TEST overlap hedge05-meanrev vs hedge04 · BTC 7y ===`);
const h04 = hedge04Entries();
const yrsSpan = (C1[C1.length - 1].t - C1[WARM].t) / (365 * DAY);
console.log(`hedge04-replica: ${h04.length} entries (${(h04.length / yrsSpan).toFixed(0)}/năm) — sanity vs known 102/năm: ${Math.abs(h04.length / yrsSpan - 102) < 35 ? "✅ khớp" : "⚠️ lệch (caveat)"}`);
const h04set = h04.slice().sort((a, b) => a - b);
function nearH04(t) { // binary search ±2h
  let lo = 0, hi = h04set.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (Math.abs(h04set[m] - t) <= 2 * HOUR) return true; if (h04set[m] < t) lo = m + 1; else hi = m - 1; } return false; }

const full = hedge05Sim(null, 0, C1.length);
const overlapCount = full.entTimes.filter(nearH04).length;
const overlapPct = full.entTimes.length ? overlapCount / full.entTimes.length * 100 : 0;
console.log(`hedge05 full: ${full.entTimes.length} entries (${(full.entTimes.length / yrsSpan).toFixed(0)}/năm) RA ${full.ra.toFixed(3)} WR ${full.wr.toFixed(0)}%`);
console.log(`\n>>> OVERLAP: ${overlapCount}/${full.entTimes.length} entry hedge05 trùng hedge04 (±2h) = ${overlapPct.toFixed(0)}%`);
console.log(`    → ${(100 - overlapPct).toFixed(0)}% entry hedge05 là RIÊNG (hedge04 không bắt)\n`);

// marginal: chỉ entry KHÔNG trùng hedge04
const marg = hedge05Sim((t) => !nearH04(t), 0, C1.length);
const margTrn = hedge05Sim((t) => !nearH04(t), 0, split);
const margTst = hedge05Sim((t) => !nearH04(t), split, C1.length);
const margRec = hedge05Sim((t) => !nearH04(t), recentIdx, C1.length);
const retain = margTrn.ra > 0 ? margTst.ra / margTrn.ra : 0;
console.log(`MARGINAL (chỉ ${marg.n} entry hedge05-RIÊNG, bỏ phần trùng h04):`);
console.log(`  RA ${marg.ra.toFixed(3)} · WR ${marg.wr.toFixed(0)}% · ${(marg.n / yrsSpan).toFixed(0)}/năm · stab ${marg.yrsPos}/${marg.yrs}`);
console.log(`  WF: TRAIN ${margTrn.ra.toFixed(2)} → TEST ${margTst.ra.toFixed(2)} (retain ${(retain * 100).toFixed(0)}%) · RECENT'25 RA ${margRec.ra.toFixed(2)} ROI ${margRec.roi.toFixed(1)}%`);
console.log(`\n→ Nếu MARGINAL dương + robust → hedge05 BỔ SUNG thật (build differentiate). Nếu âm → chỉ là h04+noise.`);
console.log(`[done]`);
