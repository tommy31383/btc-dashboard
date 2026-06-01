/**
 * probe-hedge05-grid-on-h04-7y.mjs  (anh Tommy 2026-06-01)
 * Option 3: ghép GRID-CỨU vào entry hedge04 (chất lượng hơn RSI<35).
 * So 3 cách, ĐỀU dưới fill REALISTIC 5bps:
 *   H04_FIXSL  : hedge04 gốc (fixed SL×2/TP per-signal) — baseline.
 *   H04_GRID   : entry hedge04 + grid cứu (g0.8/w1.8/N3/tp0.4/h7) thay vì fixed SL.
 *   H05_GRID   : entry RSI<35 + grid (để đối chiếu).
 * Câu hỏi: entry tốt hơn (h04) + grid có robust hơn dưới slippage không?
 */
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const INITIAL = 100000, FEE = 0.05 / 100, Q0 = 0.03, HOUR = 3600000, H4 = 4 * HOUR, DAY = 86400000, SLIP = 0.0005;
const c5 = JSON.parse(readFileSync(join(__dirname, "..", ".cache", "binance-5m-7y.json"), "utf8"));
function rs(ms) { const m = new Map(); for (let i = 0; i < c5.length; i++) { const b = c5[i], k = Math.floor(b.time / ms); let d = m.get(k); if (!d) m.set(k, { key: k, t: k * ms, o: b.open, h: b.high, l: b.low, c: b.close }); else { if (b.high > d.h) d.h = b.high; if (b.low < d.l) d.l = b.low; d.c = b.close; } } return [...m.values()].sort((a, b) => a.key - b.key); }
const C1 = rs(HOUR), C4 = rs(H4), CD = rs(DAY), M = C1.length;
const map4 = new Map(C4.map((b, i) => [b.key, i])), mapD = new Map(CD.map((b, i) => [b.key, i]));
function rsiA(c, p) { const o = new Array(c.length).fill(null); if (c.length <= p) return o; let g = 0, l = 0; for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; if (d >= 0) g += d; else l -= d; } let ag = g / p, al = l / p; o[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); for (let i = p + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; ag = (ag * (p - 1) + Math.max(d, 0)) / p; al = (al * (p - 1) + Math.max(-d, 0)) / p; o[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); } return o; }
function stA(b, p) { const o = new Array(b.length).fill(null); for (let i = p - 1; i < b.length; i++) { let hi = -Infinity, lo = Infinity; for (let j = i - p + 1; j <= i; j++) { if (b[j].h > hi) hi = b[j].h; if (b[j].l < lo) lo = b[j].l; } o[i] = hi === lo ? 50 : (b[i].c - lo) / (hi - lo) * 100; } return o; }
function atA(b, p) { const N = b.length, tr = new Array(N).fill(0); for (let i = 1; i < N; i++) tr[i] = Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c)); const o = new Array(N).fill(null); if (N <= p) return o; let s = 0; for (let i = 1; i <= p; i++) s += tr[i]; o[p] = s / p; for (let i = p + 1; i < N; i++) o[i] = (o[i - 1] * (p - 1) + tr[i]) / p; return o; }
function emA(c, p) { const o = new Array(c.length).fill(null); if (c.length < p) return o; const k = 2 / (p + 1); let e = 0; for (let i = 0; i < p; i++) e += c[i]; e /= p; o[p - 1] = e; for (let i = p; i < c.length; i++) { e = c[i] * k + e * (1 - k); o[i] = e; } return o; }
function adA(b, p) { const N = b.length, tr = new Array(N).fill(0), pD = new Array(N).fill(0), nD = new Array(N).fill(0); for (let i = 1; i < N; i++) { const u = b[i].h - b[i - 1].h, dn = b[i - 1].l - b[i].l; pD[i] = (u > dn && u > 0) ? u : 0; nD[i] = (dn > u && dn > 0) ? dn : 0; tr[i] = Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c)); } const sT = new Array(N).fill(0), sP = new Array(N).fill(0), sN = new Array(N).fill(0); let t0 = 0, p0 = 0, n0 = 0; for (let i = 1; i <= p; i++) { t0 += tr[i]; p0 += pD[i]; n0 += nD[i]; } sT[p] = t0; sP[p] = p0; sN[p] = n0; for (let i = p + 1; i < N; i++) { sT[i] = sT[i - 1] - sT[i - 1] / p + tr[i]; sP[i] = sP[i - 1] - sP[i - 1] / p + pD[i]; sN[i] = sN[i - 1] - sN[i - 1] / p + nD[i]; } const dx = new Array(N).fill(null); for (let i = p; i < N; i++) { if (sT[i] === 0) continue; const a = 100 * sP[i] / sT[i], bb = 100 * sN[i] / sT[i], s = a + bb; dx[i] = s === 0 ? 0 : 100 * Math.abs(a - bb) / s; } const adx = new Array(N).fill(null); let acc = 0, cnt = 0, st = -1; for (let i = p; i < N; i++) if (dx[i] != null) { acc += dx[i]; cnt++; if (cnt === p) { st = i; adx[i] = acc / p; break; } } if (st > 0) for (let i = st + 1; i < N; i++) if (dx[i] != null) adx[i] = (adx[i - 1] * (p - 1) + dx[i]) / p; return adx; }
const cl1 = C1.map(b => b.c), RSI1 = rsiA(cl1, 14), STK1 = stA(C1, 14), ATR1 = atA(C1, 14), EMA200_1 = emA(cl1, 200);
const BBL1 = (() => { const o = new Array(M).fill(null); for (let i = 19; i < M; i++) { let s = 0; for (let j = i - 19; j <= i; j++) s += cl1[j]; const m = s / 20; let sq = 0; for (let j = i - 19; j <= i; j++) sq += (cl1[j] - m) ** 2; o[i] = m - 2 * Math.sqrt(sq / 20); } return o; })();
const ADX4 = adA(C4, 14), ATR4 = atA(C4, 14);
const ATR4PASS = (() => { const o = new Array(C4.length).fill(false); for (let i = 104; i < C4.length; i++) { if (ATR4[i] == null) continue; const cur = ATR4[i] / C4[i].c; const a = []; for (let j = i - 90; j < i; j++) if (ATR4[j] != null) a.push(ATR4[j] / C4[j].c); if (a.length < 90) continue; a.sort((x, y) => x - y); o[i] = cur >= a[Math.floor(a.length * 0.35)]; } return o; })();
const REGIME = (() => { const n = CD.length, raw = []; for (let i = 0; i < n; i++) { if (i < 200) { raw.push("RANGE"); continue; } let s2 = 0; for (let j = i - 199; j <= i; j++) s2 += CD[j].c; const ma2 = s2 / 200; let s5 = 0; for (let j = i - 49; j <= i; j++) s5 += CD[j].c; const ma5 = s5 / 50; let ar = 0; for (let j = i - 19; j <= i; j++) ar += (CD[j].h - CD[j].l) / CD[j].c; ar /= 20; if (CD[i].c < ma2) raw.push("BEAR"); else if (CD[i].c > ma5 && ma5 > ma2 && ar > 0.04) raw.push("BULL"); else raw.push("RANGE"); } const out = new Array(n).fill("RANGE"); let cur = "RANGE", cnt = 0, lr = "RANGE"; for (let i = 0; i < n; i++) { if (raw[i] === lr) cnt++; else { cnt = 1; lr = raw[i]; } if (cnt >= 3) cur = raw[i]; out[i] = cur; } return out; })();
const i4 = t => map4.get(Math.floor(t / H4) - 1), iD = t => mapD.get(Math.floor(t / DAY) - 1), WARM = 220;
function h04gate(i) { const t = C1[i].t, di = iD(t); if (di == null || REGIME[di] !== "RANGE") return false; const k = i4(t); if (k == null || k < 1 || ADX4[k] == null || ADX4[k] <= 20 || ADX4[k - 1] == null || ADX4[k - 1] <= 20 || !ATR4PASS[k]) return false; if (EMA200_1[i] == null || C1[i].c < EMA200_1[i]) return false; return true; }
function h04sig(i) { return (BBL1[i] != null && C1[i].l <= BBL1[i] && C1[i].c > C1[i].o) || (RSI1[i - 1] != null && RSI1[i - 1] < 40 && RSI1[i] >= 40) || (STK1[i - 1] != null && STK1[i - 1] < 20 && STK1[i] >= 20); }
const G = 0.8, WIDEN = 1.8, N = 3, TP2 = 0.4, HARD = 7;
const cum = ad => { let d = 0; for (let k = 0; k <= ad; k++) d += G * Math.pow(WIDEN, k); return d; };
function sim(mode, iStart, iEnd) {
  let wallet = INITIAL, peak = INITIAL, trough = INITIAL, lastE = -1e9, camp = 0, win = 0, worst = 0, hardC = 0; const py = {}; let a = null;
  for (let i = Math.max(iStart, WARM); i < iEnd; i++) {
    const bar = C1[i], px = bar.c, atr = ATR1[i] || 0, yr = new Date(bar.t).getUTCFullYear();
    if (a) {
      if (mode !== "H04_FIXSL" && a.adds < N) { const lvl = a.fe - cum(a.adds) * a.atr0; if (bar.l <= lvl) { const fill = lvl * (1 + SLIP); a.cost += Q0 * fill; a.qty += Q0; a.adds++; wallet -= Q0 * fill * FEE; } }
      const avg = a.cost / a.qty;
      let done = false, pnl = 0, isH = false;
      if (mode === "H04_FIXSL") { const tpPx = a.fe + 1.5 * a.atr0, slPx = a.fe - 2 * a.atr0; if (bar.l <= slPx) { const f = slPx * (1 - SLIP); pnl = Q0 * (f - a.fe) - Q0 * f * FEE; done = true; isH = true; } else if (bar.h >= tpPx) { const f = tpPx * (1 - SLIP); pnl = Q0 * (f - a.fe) - Q0 * f * FEE; done = true; } else if (i - a.oi >= 24) { pnl = Q0 * (px - a.fe) - Q0 * px * FEE; done = true; } }
      else { const tpPx = avg + TP2 * a.atr0, hardPx = a.fe - HARD * a.atr0; if (bar.l <= hardPx) { const f = hardPx * (1 - SLIP); pnl = a.qty * (f - avg) - a.qty * f * FEE; done = true; isH = true; } else if (bar.h >= tpPx) { const f = tpPx * (1 - SLIP); pnl = a.qty * (f - avg) - a.qty * f * FEE; done = true; } }
      if (done) { wallet += pnl; camp++; if (pnl >= 0) win++; if (pnl < worst) worst = pnl; if (isH) hardC++; py[yr] = (py[yr] || 0) + pnl; a = null; }
    }
    let entry = false;
    if (mode === "H05_GRID") entry = (i - lastE >= 2) && RSI1[i - 1] != null && RSI1[i - 1] >= 35 && RSI1[i] < 35;
    else entry = (i - lastE >= 2) && h04gate(i) && h04sig(i);
    if (!a && atr > 0 && entry) { lastE = i; const f = px * (1 + SLIP); a = { fe: f, cost: Q0 * f, qty: Q0, adds: 0, atr0: atr, oi: i }; wallet -= Q0 * f * FEE; }
    let up = a ? a.qty * (px - a.cost / a.qty) : 0; const eq = wallet + up; if (eq > peak) peak = eq; if (eq < trough) trough = eq;
  }
  if (a) wallet += a.qty * (C1[iEnd - 1].c - a.cost / a.qty);
  const roi = (wallet - INITIAL) / INITIAL * 100, dd = peak > trough ? (peak - trough) / peak * 100 : 0;
  const yp = Object.values(py).filter(v => v >= 0).length, yrs = Object.keys(py).length;
  return { roi, dd, ra: dd > 0 ? roi / dd : roi, wr: camp ? win / camp * 100 : 0, camp, worst, hardC, yp, yrs };
}
const split = Math.floor(M * 0.7), rTs = Date.UTC(2025, 0, 1); let rIdx = C1.findIndex(x => x.t >= rTs);
console.log(`\n=== GRID-CỨU trên entry hedge04 · fill REALISTIC 5bps · BTC 7y ===`);
console.log(`Mode       | ROI%  |  DD%  |   RA   | WR%  | camp | worst$ | hardSL | stab | TRAIN→TEST  | REC ROI`);
console.log(`-----------|-------|-------|--------|------|------|--------|--------|------|-------------|--------`);
for (const mode of ["H04_FIXSL", "H04_GRID", "H05_GRID"]) {
  const f = sim(mode, 0, M), tr = sim(mode, 0, split), ts = sim(mode, split, M), rc = sim(mode, rIdx, M);
  const ret = tr.ra > 0 ? ts.ra / tr.ra : (ts.ra >= 0 ? 1 : 0), fl = ret >= 0.7 ? "✅" : ret >= 0.4 ? "⚠️" : "❌";
  console.log(`${mode.padEnd(10)} | ${(f.roi >= 0 ? "+" : "")}${f.roi.toFixed(1).padStart(4)} | ${f.dd.toFixed(1).padStart(5)} | ${(f.ra >= 0 ? "+" : "")}${f.ra.toFixed(3).padStart(6)} | ${f.wr.toFixed(0).padStart(4)} | ${String(f.camp).padStart(4)} | ${f.worst.toFixed(0).padStart(6)} | ${String(f.hardC).padStart(6)} | ${f.yp}/${f.yrs}  | ${(tr.ra >= 0 ? "+" : "")}${tr.ra.toFixed(2)}→${(ts.ra >= 0 ? "+" : "")}${ts.ra.toFixed(2)} ${fl} | ${(rc.roi >= 0 ? "+" : "")}${rc.roi.toFixed(1)}%`);
}
console.log(`\nGrid cứu hedge04 thắng nếu RA > H04_FIXSL mà giữ robust dưới slippage.`);
console.log(`[done]`);
