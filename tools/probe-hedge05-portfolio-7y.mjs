/**
 * probe-hedge05-portfolio-7y.mjs  (anh Tommy 2026-06-01)
 * IMPROVE tầng hệ thống: ghép hedge01(trend) + hedge04(đảo chiều) + hedge05(grid cứu).
 * Đo monthly PnL từng rule → correlation matrix → combined portfolio RA/Sharpe/stab.
 * Uncorrelated → combined Sharpe/RA cao hơn từng rule = diversification thật.
 *   hedge04: replica thật (4h RANGE+ADX>20+ATR35+EMA200_1h + S04B/R/K, fixed SL/TP)
 *   hedge05: improved (entry RSI↓35 + grid g0.8/w1.8/N3/tp0.4/h7)
 *   hedge01-proxy: 4h Donchian(10) breakout + ADX(4h)>20, LONG held + ATR×3 trail
 */
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const FEE = 0.05 / 100, HOUR = 3600000, H4 = 4 * HOUR, DAY = 86400000;
const c5 = JSON.parse(readFileSync(join(__dirname, "..", ".cache", "binance-5m-7y.json"), "utf8"));
function resample(ms) { const m = new Map(); for (let i = 0; i < c5.length; i++) { const b = c5[i], k = Math.floor(b.time / ms); let d = m.get(k); if (!d) m.set(k, { key: k, t: k * ms, o: b.open, h: b.high, l: b.low, c: b.close }); else { if (b.high > d.h) d.h = b.high; if (b.low < d.l) d.l = b.low; d.c = b.close; } } return [...m.values()].sort((a, b) => a.key - b.key); }
const C1 = resample(HOUR), C4 = resample(H4), CD = resample(DAY);
const map4 = new Map(C4.map((b, i) => [b.key, i])), mapD = new Map(CD.map((b, i) => [b.key, i]));
const mkey = t => { const d = new Date(t); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
// ---- indicators (generic on a bar array) ----
function rsiArr(c, p) { const o = new Array(c.length).fill(null); if (c.length <= p) return o; let g = 0, l = 0; for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; if (d >= 0) g += d; else l -= d; } let ag = g / p, al = l / p; o[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); for (let i = p + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; ag = (ag * (p - 1) + Math.max(d, 0)) / p; al = (al * (p - 1) + Math.max(-d, 0)) / p; o[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); } return o; }
function stochArr(bars, p) { const o = new Array(bars.length).fill(null); for (let i = p - 1; i < bars.length; i++) { let hi = -Infinity, lo = Infinity; for (let j = i - p + 1; j <= i; j++) { if (bars[j].h > hi) hi = bars[j].h; if (bars[j].l < lo) lo = bars[j].l; } o[i] = hi === lo ? 50 : (bars[i].c - lo) / (hi - lo) * 100; } return o; }
function atrArr(bars, p) { const N = bars.length, tr = new Array(N).fill(0); for (let i = 1; i < N; i++) tr[i] = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c)); const o = new Array(N).fill(null); if (N <= p) return o; let s = 0; for (let i = 1; i <= p; i++) s += tr[i]; o[p] = s / p; for (let i = p + 1; i < N; i++) o[i] = (o[i - 1] * (p - 1) + tr[i]) / p; return o; }
function emaArr(c, p) { const o = new Array(c.length).fill(null); if (c.length < p) return o; const k = 2 / (p + 1); let e = 0; for (let i = 0; i < p; i++) e += c[i]; e /= p; o[p - 1] = e; for (let i = p; i < c.length; i++) { e = c[i] * k + e * (1 - k); o[i] = e; } return o; }
function adxArr(bars, p) { const N = bars.length, tr = new Array(N).fill(0), pD = new Array(N).fill(0), nD = new Array(N).fill(0); for (let i = 1; i < N; i++) { const u = bars[i].h - bars[i - 1].h, dn = bars[i - 1].l - bars[i].l; pD[i] = (u > dn && u > 0) ? u : 0; nD[i] = (dn > u && dn > 0) ? dn : 0; tr[i] = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c)); } const sT = new Array(N).fill(0), sP = new Array(N).fill(0), sN = new Array(N).fill(0); let t0 = 0, p0 = 0, n0 = 0; for (let i = 1; i <= p; i++) { t0 += tr[i]; p0 += pD[i]; n0 += nD[i]; } sT[p] = t0; sP[p] = p0; sN[p] = n0; for (let i = p + 1; i < N; i++) { sT[i] = sT[i - 1] - sT[i - 1] / p + tr[i]; sP[i] = sP[i - 1] - sP[i - 1] / p + pD[i]; sN[i] = sN[i - 1] - sN[i - 1] / p + nD[i]; } const dx = new Array(N).fill(null); for (let i = p; i < N; i++) { if (sT[i] === 0) continue; const a = 100 * sP[i] / sT[i], b = 100 * sN[i] / sT[i], s = a + b; dx[i] = s === 0 ? 0 : 100 * Math.abs(a - b) / s; } const adx = new Array(N).fill(null); let acc = 0, cnt = 0, st = -1; for (let i = p; i < N; i++) if (dx[i] != null) { acc += dx[i]; cnt++; if (cnt === p) { st = i; adx[i] = acc / p; break; } } if (st > 0) for (let i = st + 1; i < N; i++) if (dx[i] != null) adx[i] = (adx[i - 1] * (p - 1) + dx[i]) / p; return adx; }
// 1h indicators
const cl1 = C1.map(b => b.c);
const RSI1 = rsiArr(cl1, 14), STK1 = stochArr(C1, 14), ATR1 = atrArr(C1, 14), EMA200_1 = emaArr(cl1, 200), ADX1 = adxArr(C1, 14);
const BBL1 = (() => { const o = new Array(C1.length).fill(null); for (let i = 19; i < C1.length; i++) { let s = 0; for (let j = i - 19; j <= i; j++) s += cl1[j]; const m = s / 20; let sq = 0; for (let j = i - 19; j <= i; j++) sq += (cl1[j] - m) ** 2; o[i] = m - 2 * Math.sqrt(sq / 20); } return o; })();
const ADX4 = adxArr(C4, 14), ATR4 = atrArr(C4, 14);
const ATR4PASS = (() => { const o = new Array(C4.length).fill(false); for (let i = 90 + 14; i < C4.length; i++) { if (ATR4[i] == null) continue; const cur = ATR4[i] / C4[i].c; const arr = []; for (let j = i - 90; j < i; j++) if (ATR4[j] != null) arr.push(ATR4[j] / C4[j].c); if (arr.length < 90) continue; arr.sort((a, b) => a - b); o[i] = cur >= arr[Math.floor(arr.length * 0.35)]; } return o; })();
const REGIME = (() => { const n = CD.length, raw = []; for (let i = 0; i < n; i++) { if (i < 200) { raw.push("RANGE"); continue; } let s2 = 0; for (let j = i - 199; j <= i; j++) s2 += CD[j].c; const ma200 = s2 / 200; let s5 = 0; for (let j = i - 49; j <= i; j++) s5 += CD[j].c; const ma50 = s5 / 50; let ar = 0; for (let j = i - 19; j <= i; j++) ar += (CD[j].h - CD[j].l) / CD[j].c; ar /= 20; if (CD[i].c < ma200) raw.push("BEAR"); else if (CD[i].c > ma50 && ma50 > ma200 && ar > 0.04) raw.push("BULL"); else raw.push("RANGE"); } const out = new Array(n).fill("RANGE"); let cur = "RANGE", cnt = 0, lr = "RANGE"; for (let i = 0; i < n; i++) { if (raw[i] === lr) cnt++; else { cnt = 1; lr = raw[i]; } if (cnt >= 3) cur = raw[i]; out[i] = cur; } return out; })();
const idx4At = t => map4.get(Math.floor(t / H4) - 1), idxDAt = t => mapD.get(Math.floor(t / DAY) - 1);
const WARM = 220;
// ---- hedge04 monthly PnL ----
function hedge04Monthly() {
  const mon = {}; const open = []; let cdB = -1e18, cdR = -1e18, cdK = -1e18; const Q = 0.05;
  for (let i = WARM; i < C1.length; i++) {
    const bar = C1[i], t = bar.t, px = bar.c;
    for (let k = open.length - 1; k >= 0; k--) { const tr = open[k]; let cx = null; if (bar.l <= tr.sl) cx = tr.sl; else if (bar.h >= tr.tp) cx = tr.tp; else if (i - tr.oi >= 24) cx = px; if (cx != null) { const pnl = Q * (cx - tr.e) - Q * cx * FEE; mon[mkey(t)] = (mon[mkey(t)] || 0) + pnl; open.splice(k, 1); } }
    const di = idxDAt(t); if (di == null || REGIME[di] !== "RANGE") continue;
    const k4 = idx4At(t); if (k4 == null || k4 < 1 || ADX4[k4] == null || ADX4[k4] <= 20 || ADX4[k4 - 1] == null || ADX4[k4 - 1] <= 20) continue;
    if (!ATR4PASS[k4] || EMA200_1[i] == null || bar.c < EMA200_1[i] || ATR1[i] == null || ATR1[i] <= 0) continue;
    const ap = ATR1[i] / bar.c;
    if (BBL1[i] != null && bar.l <= BBL1[i] && bar.c > bar.o && t - cdB >= 2 * HOUR) { open.push({ e: px, sl: px * (1 - ap * 2), tp: px * (1 + ap * 1.5), oi: i }); cdB = t; mon[mkey(t)] = (mon[mkey(t)] || 0) - Q * px * FEE; }
    if (RSI1[i - 1] != null && RSI1[i - 1] < 40 && RSI1[i] >= 40 && t - cdR >= 2 * HOUR) { open.push({ e: px, sl: px * (1 - ap * 2), tp: px * (1 + ap * 1), oi: i }); cdR = t; mon[mkey(t)] = (mon[mkey(t)] || 0) - Q * px * FEE; }
    if (STK1[i - 1] != null && STK1[i - 1] < 20 && STK1[i] >= 20 && t - cdK >= 2 * HOUR) { open.push({ e: px, sl: px * (1 - ap * 2), tp: px * (1 + ap * 1), oi: i }); cdK = t; mon[mkey(t)] = (mon[mkey(t)] || 0) - Q * px * FEE; }
  }
  return mon;
}
// ---- hedge05 monthly PnL (improved grid) ----
function hedge05Monthly() {
  const mon = {}; const Q = 0.03, G = 0.8, WIDEN = 1.8, N = 3, TP2 = 0.4, HARD = 7; let a = null, lastE = -1e9;
  const cum = adds => { let d = 0; for (let k = 0; k <= adds; k++) d += G * Math.pow(WIDEN, k); return d; };
  for (let i = WARM; i < C1.length; i++) {
    const bar = C1[i], t = bar.t, px = bar.c, atr = ATR1[i] || 0;
    if (a) {
      if (a.adds < N) { const lvl = a.fe - cum(a.adds) * a.atr0; if (bar.l <= lvl) { a.cost += Q * lvl; a.qty += Q; a.adds++; mon[mkey(t)] = (mon[mkey(t)] || 0) - Q * lvl * FEE; } }
      const avg = a.cost / a.qty, tpPx = avg + TP2 * a.atr0, hardPx = a.fe - HARD * a.atr0; let cx = null;
      if (bar.l <= hardPx) cx = hardPx; else if (bar.h >= tpPx) cx = tpPx;
      if (cx != null) { mon[mkey(t)] = (mon[mkey(t)] || 0) + a.qty * (cx - avg) - a.qty * cx * FEE; a = null; }
    }
    if (!a && atr > 0 && (i - lastE >= 2) && RSI1[i - 1] != null && RSI1[i - 1] >= 35 && RSI1[i] < 35) { lastE = i; a = { fe: px, cost: Q * px, qty: Q, adds: 0, atr0: atr }; mon[mkey(t)] = (mon[mkey(t)] || 0) - Q * px * FEE; }
  }
  return mon;
}
// ---- hedge01-proxy monthly PnL (4h Donchian breakout trend, held+trail) ----
function hedge01Monthly() {
  const mon = {}, Q = 0.05; let pos = null;
  const don = (() => { const o = new Array(C4.length).fill(null); for (let i = 10; i < C4.length; i++) { let mx = -Infinity; for (let j = i - 10; j < i; j++) if (C4[j].h > mx) mx = C4[j].h; o[i] = mx; } return o; })();
  for (let i = 30; i < C4.length; i++) {
    const bar = C4[i], t = bar.t, px = bar.c;
    if (pos) { if (bar.h > pos.hwm) pos.hwm = bar.h; const trail = pos.hwm - 3 * pos.atrE; if (bar.l <= trail) { const cx = Math.min(trail, bar.h); mon[mkey(t)] = (mon[mkey(t)] || 0) + Q * (cx - pos.e) - Q * cx * FEE; pos = null; } }
    if (!pos && don[i] != null && ATR4[i] != null && ADX4[i] != null && ADX4[i] > 20 && bar.c > don[i]) { pos = { e: px, hwm: bar.h, atrE: ATR4[i] }; mon[mkey(t)] = (mon[mkey(t)] || 0) - Q * px * FEE; }
  }
  return mon;
}
// ---- align + stats ----
const h01 = hedge01Monthly(), h04 = hedge04Monthly(), h05 = hedge05Monthly();
const allM = [...new Set([...Object.keys(h01), ...Object.keys(h04), ...Object.keys(h05)].map(Number))].sort((a, b) => a - b);
const A = allM.map(m => h01[m] || 0), B = allM.map(m => h04[m] || 0), C = allM.map(m => h05[m] || 0);
function corr(x, y) { const n = x.length, mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n; let sxy = 0, sx = 0, sy = 0; for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sx += (x[i] - mx) ** 2; sy += (y[i] - my) ** 2; } return sxy / Math.sqrt(sx * sy); }
function stats(arr) { const tot = arr.reduce((a, b) => a + b, 0); let eq = 0, peak = 0, dd = 0; const yPnl = {}; for (let i = 0; i < arr.length; i++) { eq += arr[i]; if (eq > peak) peak = eq; if (peak - eq > dd) dd = peak - eq; const y = 2019 + Math.floor((allM[i] - 2019 * 12) / 12); yPnl[y] = (yPnl[y] || 0) + arr[i]; } const mean = tot / arr.length, sd = Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length); const yp = Object.values(yPnl).filter(v => v >= 0).length, yrs = Object.keys(yPnl).length; return { tot, dd, ra: dd > 0 ? tot / dd : tot, sharpe: sd > 0 ? mean / sd * Math.sqrt(12) : 0, yp, yrs }; }
console.log(`\n=== PORTFOLIO · hedge01(trend) + hedge04(đảo) + hedge05(grid cứu) · ${allM.length} tháng ===`);
console.log(`(hedge01 = proxy 4h breakout; hedge04 = replica thật; hedge05 = improved)\n`);
const s1 = stats(A), s4 = stats(B), s5 = stats(C);
console.log(`Rule        | tot$   | maxDD$ |  RA   | Sharpe | stab`);
console.log(`------------|--------|--------|-------|--------|-----`);
console.log(`hedge01     | ${s1.tot.toFixed(0).padStart(6)} | ${s1.dd.toFixed(0).padStart(6)} | ${s1.ra.toFixed(2).padStart(5)} | ${s1.sharpe.toFixed(2).padStart(6)} | ${s1.yp}/${s1.yrs}`);
console.log(`hedge04     | ${s4.tot.toFixed(0).padStart(6)} | ${s4.dd.toFixed(0).padStart(6)} | ${s4.ra.toFixed(2).padStart(5)} | ${s4.sharpe.toFixed(2).padStart(6)} | ${s4.yp}/${s4.yrs}`);
console.log(`hedge05     | ${s5.tot.toFixed(0).padStart(6)} | ${s5.dd.toFixed(0).padStart(6)} | ${s5.ra.toFixed(2).padStart(5)} | ${s5.sharpe.toFixed(2).padStart(6)} | ${s5.yp}/${s5.yrs}`);
console.log(`\nCORRELATION (monthly PnL):`);
console.log(`  h01-h04: ${corr(A, B).toFixed(2)}   h01-h05: ${corr(A, C).toFixed(2)}   h04-h05: ${corr(B, C).toFixed(2)}`);
console.log(`  (gần 0 hoặc âm = diversify tốt)`);
const P2 = B.map((v, i) => v + C[i]); const sp2 = stats(P2);
const P3 = A.map((v, i) => v + B[i] + C[i]); const sp3 = stats(P3);
console.log(`\nCOMBINED (sum natural size):`);
console.log(`  h04+h05      : RA ${sp2.ra.toFixed(2)} Sharpe ${sp2.sharpe.toFixed(2)} stab ${sp2.yp}/${sp2.yrs}  (vs h04 ${s4.sharpe.toFixed(2)} / h05 ${s5.sharpe.toFixed(2)})`);
console.log(`  h01+h04+h05  : RA ${sp3.ra.toFixed(2)} Sharpe ${sp3.sharpe.toFixed(2)} stab ${sp3.yp}/${sp3.yrs}  ← portfolio đủ 3`);
console.log(`\nDiversify thật nếu Sharpe combined > max từng rule.`);
console.log(`[done]`);
