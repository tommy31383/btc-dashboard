/**
 * probe-hedge05-grid-regimegate-7y.mjs  (anh Tommy 2026-06-01)
 * LỚP AN TOÀN ĐUÔI: không mở campaign grid khi regime BEAR (tránh nhồi vào chợ rơi dài).
 * Gate: NONE | NOT_BEAR_EMA (daily close ≥ EMA200) | NOT_BEAR_REGIME (hedge04 getRegime≠BEAR)
 * Mục tiêu: giảm hardStops + worst$ mà GIỮ RA, không cắt quá nhiều campaign.
 * Base grid đã chốt: g1.2 widen1.5, N3, TP avg+0.3ATR, hard −6ATR. Entry RSI<35.
 */
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const INITIAL = 100000, FEE = 0.05 / 100, Q0 = 0.03, HOUR = 3600000, DAY = 86400000;
const c5 = JSON.parse(readFileSync(join(__dirname, "..", ".cache", "binance-5m-7y.json"), "utf8"));
function resample(ms) { const m = new Map(); for (let i = 0; i < c5.length; i++) { const b = c5[i], k = Math.floor(b.time / ms); let d = m.get(k); if (!d) m.set(k, { key: k, h: b.high, l: b.low, c: b.close }); else { if (b.high > d.h) d.h = b.high; if (b.low < d.l) d.l = b.low; d.c = b.close; } } return [...m.values()].sort((a, b) => a.key - b.key); }
const C1 = resample(HOUR), CD = resample(DAY);
const M = C1.length, H = C1.map(x => x.c), L = C1.map(x => x.c); // placeholder, real H/L below
const HH1 = C1.map(x => x.h), LL1 = C1.map(x => x.l), CL = C1.map(x => x.c);
const mapD = new Map(CD.map((b, i) => [b.key, i]));
function rsiS(c, p) { const o = new Array(c.length).fill(null); if (c.length <= p) return o; let g = 0, l = 0; for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; if (d >= 0) g += d; else l -= d; } let ag = g / p, al = l / p; o[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); for (let i = p + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; ag = (ag * (p - 1) + Math.max(d, 0)) / p; al = (al * (p - 1) + Math.max(-d, 0)) / p; o[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); } return o; }
function atr1() { const tr = new Array(M).fill(0); for (let i = 1; i < M; i++) tr[i] = Math.max(HH1[i] - LL1[i], Math.abs(HH1[i] - CL[i - 1]), Math.abs(LL1[i] - CL[i - 1])); const o = new Array(M).fill(null); let s = 0; for (let i = 1; i <= 14; i++) s += tr[i]; o[14] = s / 14; for (let i = 15; i < M; i++) o[i] = (o[i - 1] * 13 + tr[i]) / 14; return o; }
const RSI = rsiS(CL, 14), ATR = atr1(), WARM = 50;
// daily EMA200 + getRegime
const DCc = CD.map(d => d.c);
function emaA(a, p) { const o = new Array(a.length).fill(null), k = 2 / (p + 1); let e = 0; for (let i = 0; i < p; i++) e += a[i]; e /= p; o[p - 1] = e; for (let i = p; i < a.length; i++) { e = a[i] * k + e * (1 - k); o[i] = e; } return o; }
const dEMA200 = emaA(DCc, 200);
const REGIME = (() => { const n = CD.length, raw = []; for (let i = 0; i < n; i++) { if (i < 200) { raw.push("RANGE"); continue; } let s2 = 0; for (let j = i - 199; j <= i; j++) s2 += CD[j].c; const ma200 = s2 / 200; let s5 = 0; for (let j = i - 49; j <= i; j++) s5 += CD[j].c; const ma50 = s5 / 50; let ar = 0; for (let j = i - 19; j <= i; j++) ar += (CD[j].h - CD[j].l) / CD[j].c; ar /= 20; if (CD[i].c < ma200) raw.push("BEAR"); else if (CD[i].c > ma50 && ma50 > ma200 && ar > 0.04) raw.push("BULL"); else raw.push("RANGE"); } const out = new Array(n).fill("RANGE"); let cur = "RANGE", cnt = 0, lr = "RANGE"; for (let i = 0; i < n; i++) { if (raw[i] === lr) cnt++; else { cnt = 1; lr = raw[i]; } if (cnt >= 3) cur = raw[i]; out[i] = cur; } return out; })();
function gateOk(gate, t) { const di = mapD.get(Math.floor(t / DAY) - 1); if (di == null) return true; if (gate === "NONE") return true; if (gate === "NOT_BEAR_EMA") return dEMA200[di] != null && CD[di].c >= dEMA200[di]; if (gate === "NOT_BEAR_REGIME") return REGIME[di] !== "BEAR"; return true; }
const G = 1.2, N = 3, WIDEN = 1.5, HARD = 6, TP2 = 0.3;
function cumDist(adds) { let d = 0; for (let k = 0; k <= adds; k++) d += G * Math.pow(WIDEN, k); return d; }
function sim(gate, iStart, iEnd) {
  let wallet = INITIAL, peak = INITIAL, trough = INITIAL, lastE = -1e9, camp = 0, win = 0, worst = 0, hard = 0; const py = {}; let a = null;
  for (let i = Math.max(iStart, WARM); i < iEnd; i++) {
    const t = C1[i].key * HOUR, px = CL[i], atr = ATR[i] || 0, yr = new Date(t).getUTCFullYear();
    if (a) {
      if (a.adds < N) { const lvl = a.firstEntry - cumDist(a.adds) * a.atr0; if (LL1[i] <= lvl) { a.cost += Q0 * lvl; a.qty += Q0; a.adds++; wallet -= Q0 * lvl * FEE; } }
      const avg = a.cost / a.qty, tpPx = avg + TP2 * a.atr0, hardPx = a.firstEntry - HARD * a.atr0;
      let done = false, pnl = 0, isHard = false;
      if (LL1[i] <= hardPx) { pnl = a.qty * (hardPx - avg) - a.qty * hardPx * FEE; done = true; isHard = true; }
      else if (HH1[i] >= tpPx) { pnl = a.qty * (tpPx - avg) - a.qty * tpPx * FEE; done = true; }
      if (done) { wallet += pnl; camp++; if (pnl >= 0) win++; if (pnl < worst) worst = pnl; if (isHard) hard++; py[yr] = (py[yr] || 0) + pnl; a = null; }
    }
    if (!a && atr > 0 && (i - lastE >= 2) && RSI[i - 1] != null && RSI[i - 1] >= 35 && RSI[i] < 35 && gateOk(gate, t)) { lastE = i; a = { firstEntry: px, cost: Q0 * px, qty: Q0, adds: 0, atr0: atr }; wallet -= Q0 * px * FEE; }
    let up = a ? a.qty * (px - a.cost / a.qty) : 0; const eq = wallet + up; if (eq > peak) peak = eq; if (eq < trough) trough = eq;
  }
  if (a) wallet += a.qty * (CL[iEnd - 1] - a.cost / a.qty);
  const roi = (wallet - INITIAL) / INITIAL * 100, dd = peak > trough ? (peak - trough) / peak * 100 : 0;
  const yp = Object.values(py).filter(v => v >= 0).length, yrs = Object.keys(py).length;
  return { roi, dd, ra: dd > 0 ? roi / dd : roi, wr: camp ? win / camp * 100 : 0, camp, worst, hard, py, yp, yrs };
}
const split = Math.floor(M * 0.7), rTs = Date.UTC(2025, 0, 1); let rIdx = C1.findIndex(x => x.key * HOUR >= rTs);
console.log(`\n=== LỚP AN TOÀN ĐUÔI · regime-gate trên grid rescue · BTC 7y ===`);
console.log(`Base: g1.2 widen1.5 N3 TP0.3 hard-6ATR, entry RSI<35.\n`);
console.log(`Gate              | ROI%  |  DD%  |   RA   | WR%  | #camp | worst$ | hardSL | stab | TRAIN→TEST  | REC ROI`);
console.log(`------------------|-------|-------|--------|------|-------|--------|--------|------|-------------|--------`);
for (const gate of ["NONE", "NOT_BEAR_EMA", "NOT_BEAR_REGIME"]) {
  const f = sim(gate, 0, M), tr = sim(gate, 0, split), ts = sim(gate, split, M), rc = sim(gate, rIdx, M);
  const ret = tr.ra > 0 ? ts.ra / tr.ra : (ts.ra >= 0 ? 1 : 0), fl = ret >= 0.7 ? "✅" : ret >= 0.4 ? "⚠️" : "❌";
  console.log(`${gate.padEnd(17)} | ${(f.roi >= 0 ? "+" : "")}${f.roi.toFixed(1).padStart(4)} | ${f.dd.toFixed(1).padStart(5)} | ${(f.ra >= 0 ? "+" : "")}${f.ra.toFixed(3).padStart(6)} | ${f.wr.toFixed(0).padStart(4)} | ${String(f.camp).padStart(5)} | ${f.worst.toFixed(0).padStart(6)} | ${String(f.hard).padStart(6)} | ${f.yp}/${f.yrs}  | ${(tr.ra >= 0 ? "+" : "")}${tr.ra.toFixed(2)}→${(ts.ra >= 0 ? "+" : "")}${ts.ra.toFixed(2)} ${fl} | ${(rc.roi >= 0 ? "+" : "")}${rc.roi.toFixed(1)}%`);
}
const best = sim("NOT_BEAR_REGIME", 0, M);
console.log(`\nNOT_BEAR_REGIME per-year:`);
console.log("  " + Object.entries(best.py).map(([y, v]) => `${y}:${v >= 0 ? "+" : ""}$${(v / 1000).toFixed(1)}k`).join("  "));
console.log(`\nChọn gate nào giảm hardSL+worst mà RA giữ ~1.0 & #camp không rớt quá nhiều.`);
console.log(`[done]`);
