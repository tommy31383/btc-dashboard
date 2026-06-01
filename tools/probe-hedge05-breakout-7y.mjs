/**
 * probe-hedge05-breakout-7y.mjs  (anh Tommy 2026-06-01)
 * PROBE v9 — option 3: góc TREND chưa test = BREAKOUT intraday held+trail.
 *   BREAK_D20/D50: 1h close > Donchian high(N) → LONG (momentum breakout)
 *   BREAK_PDH: 1h close > high ngày hôm trước → LONG
 *   MTF: daily EMA50 up AND breakout 1h → LONG (multi-TF confirm)
 * Single position + re-entry, ATR trail, time-stop 10d. LONG-only. WF + lát 2025.
 */
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const INITIAL = 100000, FEE_SIDE = 0.05 / 100, QTY = 0.05, HOUR_MS = 3600000, DAY_MS = 86400000;
const c5 = JSON.parse(readFileSync(join(__dirname, "..", ".cache", "binance-5m-7y.json"), "utf8"));
const hMap = new Map();
for (let i = 0; i < c5.length; i++) { const b = c5[i], k = Math.floor(b.time / HOUR_MS); let h = hMap.get(k); if (!h) hMap.set(k, { t: k * HOUR_MS, o: b.open, h: b.high, l: b.low, c: b.close }); else { if (b.high > h.h) h.h = b.high; if (b.low < h.l) h.l = b.low; h.c = b.close; } }
const C1 = [...hMap.values()].sort((a, b) => a.t - b.t);
const M = C1.length, H = C1.map(x => x.h), L = C1.map(x => x.l), CL = C1.map(x => x.c);
const dMap = new Map();
for (let i = 0; i < c5.length; i++) { const b = c5[i], k = Math.floor(b.time / DAY_MS); let d = dMap.get(k); if (!d) dMap.set(k, { key: k, h: b.high, c: b.close }); else { if (b.high > d.h) d.h = b.high; d.c = b.close; } }
const days = [...dMap.values()].sort((a, b) => a.key - b.key);
const DC = days.map(d => d.c), DH = days.map(d => d.h);
const dayIdxByKey = new Map(days.map((d, j) => [d.key, j]));
function emaArr(a, p) { const o = new Array(a.length).fill(null), k = 2 / (p + 1); let e = 0; for (let i = 0; i < p; i++) e += a[i]; e /= p; o[p - 1] = e; for (let i = p; i < a.length; i++) { e = a[i] * k + e * (1 - k); o[i] = e; } return o; }
const dEMA50 = emaArr(DC, 50);
function atr(p) { const tr = new Array(M).fill(0); for (let i = 1; i < M; i++) tr[i] = Math.max(H[i] - L[i], Math.abs(H[i] - CL[i - 1]), Math.abs(L[i] - CL[i - 1])); const o = new Array(M).fill(null); let s = 0; for (let i = 1; i <= p; i++) s += tr[i]; o[p] = s / p; for (let i = p + 1; i < M; i++) o[i] = (o[i - 1] * (p - 1) + tr[i]) / p; return o; }
const ATR = atr(14), WARM = 220;
function donHigh(N) { const o = new Array(M).fill(null); for (let i = N; i < M; i++) { let mx = -Infinity; for (let j = i - N; j < i; j++) if (H[j] > mx) mx = H[j]; o[i] = mx; } return o; }
const DON20 = donHigh(20), DON50 = donHigh(50);
function priorDayHigh(t) { const dk = Math.floor(t / DAY_MS), j = dayIdxByKey.get(dk); if (j == null || j < 1) return null; return DH[j - 1]; }
function dailyUp(t) { const dk = Math.floor(t / DAY_MS), j = dayIdxByKey.get(dk); if (j == null || j < 1) return false; const jp = j - 1; return dEMA50[jp] != null && DC[jp] > dEMA50[jp]; }
function signal(kind, i) {
  const bar = C1[i];
  if (kind === "BREAK_D20") return DON20[i] != null && bar.c > DON20[i];
  if (kind === "BREAK_D50") return DON50[i] != null && bar.c > DON50[i];
  if (kind === "BREAK_PDH") { const p = priorDayHigh(bar.t); return p != null && bar.c > p; }
  if (kind === "MTF") return DON20[i] != null && bar.c > DON20[i] && dailyUp(bar.t);
  return false;
}
function sim(kind, trailMult, iStart, iEnd) {
  let wallet = INITIAL, peak = INITIAL, trough = INITIAL, n = 0, win = 0; const perYear = {};
  let inPos = false, entry = 0, atrE = 0, hwm = 0, openIdx = 0, cycWallet = 0;
  function close(px, ts) { const g = QTY * (px - entry) - QTY * px * FEE_SIDE; wallet += g; const yr = new Date(ts).getUTCFullYear(); perYear[yr] = (perYear[yr] || 0) + (wallet - cycWallet); n++; if (wallet >= cycWallet) win++; inPos = false; }
  for (let i = Math.max(iStart, WARM); i < iEnd; i++) {
    const bar = C1[i];
    if (inPos) {
      if (bar.h > hwm) hwm = bar.h;
      const trail = hwm - trailMult * atrE;
      if (bar.l <= trail) { close(Math.min(trail, bar.h), bar.t); }
      else if (i - openIdx >= 240) { close(bar.c, bar.t); } // 240h = 10d time-stop
    }
    if (!inPos && ATR[i] != null && ATR[i] > 0 && signal(kind, i)) {
      wallet -= QTY * bar.c * FEE_SIDE; inPos = true; entry = bar.c; atrE = ATR[i]; hwm = bar.c; openIdx = i; cycWallet = wallet;
    }
    let up = inPos ? QTY * (bar.c - entry) : 0; const eq = wallet + up; if (eq > peak) peak = eq; if (eq < trough) trough = eq;
  }
  if (inPos) close(C1[iEnd - 1].c, C1[iEnd - 1].t);
  const roi = (wallet - INITIAL) / INITIAL * 100, ddPct = peak > trough ? (peak - trough) / peak * 100 : 0;
  const yrsPos = Object.values(perYear).filter(v => v >= 0).length, yrs = Object.keys(perYear).length;
  const span = Math.max(0.1, (C1[iEnd - 1].t - C1[Math.max(iStart, WARM)].t) / (365 * 86400000));
  return { roi, ddPct, ra: ddPct > 0 ? roi / ddPct : roi, wr: n ? win / n * 100 : 0, n, perYr: n / span, perYear, yrs, yrsPos };
}
const split = Math.floor(M * 0.7), recentTs = Date.UTC(2025, 0, 1);
let recentIdx = C1.findIndex(x => x.t >= recentTs); if (recentIdx < 0) recentIdx = M - 1;
console.log(`\n=== PROBE v9 BREAKOUT (option 3 góc trend chưa test) · BTC 7y ===`);
console.log(`Single pos + re-entry, ATR trail, time-stop 10d. LONG-only.\n`);
console.log(`Kind       | trail | RA full | DD%  | WR%  | ent/yr | stab | TRAIN→TEST retain  | REC'25 RA/ROI`);
console.log(`-----------|-------|---------|------|------|--------|------|--------------------|-------------`);
for (const kind of ["BREAK_D20", "BREAK_D50", "BREAK_PDH", "MTF"]) for (const tr of [3, 5]) {
  const full = sim(kind, tr, 0, M), trn = sim(kind, tr, 0, split), tst = sim(kind, tr, split, M), rec = sim(kind, tr, recentIdx, M);
  const retain = trn.ra > 0 ? tst.ra / trn.ra : (tst.ra >= 0 ? 1 : 0), flag = retain >= 0.7 ? "✅" : retain >= 0.4 ? "⚠️" : "❌";
  console.log(`${kind.padEnd(10)} | ${String(tr).padStart(4)}× | ${(full.ra >= 0 ? "+" : "")}${full.ra.toFixed(3).padStart(6)} | ${full.ddPct.toFixed(1).padStart(4)} | ${full.wr.toFixed(0).padStart(4)} | ${full.perYr.toFixed(0).padStart(6)} | ${full.yrsPos}/${full.yrs}  | ${(trn.ra >= 0 ? "+" : "")}${trn.ra.toFixed(2)}→${(tst.ra >= 0 ? "+" : "")}${tst.ra.toFixed(2)} ${(retain * 100).toFixed(0).padStart(5)}% ${flag} | RA ${(rec.ra >= 0 ? "+" : "")}${rec.ra.toFixed(2)} ROI ${(rec.roi >= 0 ? "+" : "")}${rec.roi.toFixed(1)}%`);
}
console.log(`\n[done]`);
