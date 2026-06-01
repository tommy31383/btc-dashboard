/**
 * probe-hedge05-regime-trend-7y.mjs  (anh Tommy 2026-06-01)
 *
 * PROBE v4 — CỨU TREND (path 4): trend decay vì đánh cả lúc chop.
 * Thử REGIME-GATE: chỉ vào lệnh khi regime THẬT SỰ trending → sit out chop.
 *   - flat + EMA50-up + GATE(adx/bull) → OPEN LONG (selective, KHÔNG ép daily)
 *   - LONG + EMA50 flip down → close; intraday trail.
 * Gate: NONE | ADX25 | ADX30 | BULL(>EMA200) | ADX25+BULL.
 * Đo: full RA/DD/stab + WALK-FORWARD retain + LÁT CẮT 2025→ (regime thù địch).
 */
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const INITIAL = 100000, FEE_SIDE = 0.05 / 100, BASE_QTY = 0.05, DAY_MS = 86400000, WARMUP = 210;

const c5 = JSON.parse(readFileSync(join(__dirname, "..", ".cache", "binance-5m-7y.json"), "utf8"));
const dayMap = new Map();
for (let i = 0; i < c5.length; i++) {
  const b = c5[i], k = Math.floor(b.time / DAY_MS); let d = dayMap.get(k);
  if (!d) dayMap.set(k, { key: k, o: b.open, h: b.high, l: b.low, c: b.close, firstIdx: i, lastIdx: i });
  else { if (b.high > d.h) d.h = b.high; if (b.low < d.l) d.l = b.low; d.c = b.close; d.lastIdx = i; }
}
const days = [...dayMap.values()].sort((a, b) => a.key - b.key);
const N = days.length;
const H = days.map(d => d.h), L = days.map(d => d.l), C = days.map(d => d.c);
function ema(a, p) { const o = new Array(a.length).fill(null), k = 2 / (p + 1); let e = 0; for (let i = 0; i < p; i++) e += a[i]; e /= p; o[p - 1] = e; for (let i = p; i < a.length; i++) { e = a[i] * k + e * (1 - k); o[i] = e; } return o; }
function atrW(p) { const tr = new Array(N).fill(0); for (let i = 1; i < N; i++) tr[i] = Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1])); const o = new Array(N).fill(null); let s = 0; for (let i = 1; i <= p; i++) s += tr[i]; o[p] = s / p; for (let i = p + 1; i < N; i++) o[i] = (o[i - 1] * (p - 1) + tr[i]) / p; return o; }
function adxArr(p) {
  const tr = new Array(N).fill(0), pD = new Array(N).fill(0), nD = new Array(N).fill(0);
  for (let i = 1; i < N; i++) { const u = H[i] - H[i - 1], dn = L[i - 1] - L[i]; pD[i] = (u > dn && u > 0) ? u : 0; nD[i] = (dn > u && dn > 0) ? dn : 0; tr[i] = Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1])); }
  const sT = new Array(N).fill(0), sP = new Array(N).fill(0), sN = new Array(N).fill(0); let t0 = 0, p0 = 0, n0 = 0;
  for (let i = 1; i <= p; i++) { t0 += tr[i]; p0 += pD[i]; n0 += nD[i]; } sT[p] = t0; sP[p] = p0; sN[p] = n0;
  for (let i = p + 1; i < N; i++) { sT[i] = sT[i - 1] - sT[i - 1] / p + tr[i]; sP[i] = sP[i - 1] - sP[i - 1] / p + pD[i]; sN[i] = sN[i - 1] - sN[i - 1] / p + nD[i]; }
  const dx = new Array(N).fill(null);
  for (let i = p; i < N; i++) { if (sT[i] === 0) continue; const pdi = 100 * sP[i] / sT[i], ndi = 100 * sN[i] / sT[i], s = pdi + ndi; dx[i] = s === 0 ? 0 : 100 * Math.abs(pdi - ndi) / s; }
  const adx = new Array(N).fill(null); let acc = 0, cnt = 0, st = -1;
  for (let i = p; i < N; i++) if (dx[i] != null) { acc += dx[i]; cnt++; if (cnt === p) { st = i; adx[i] = acc / p; break; } }
  if (st > 0) for (let i = st + 1; i < N; i++) if (dx[i] != null) adx[i] = (adx[i - 1] * (p - 1) + dx[i]) / p;
  return adx;
}
const ema50 = ema(C, 50), ema200 = ema(C, 200), atr14 = atrW(14), adx14 = adxArr(14);
const GATES = {
  NONE:       j => true,
  ADX25:      j => adx14[j] != null && adx14[j] > 25,
  ADX30:      j => adx14[j] != null && adx14[j] > 30,
  BULL:       j => ema200[j] != null && C[j] > ema200[j],
  ADX25_BULL: j => adx14[j] != null && adx14[j] > 25 && ema200[j] != null && C[j] > ema200[j],
};

function sim(gateFn, trailMult, jStart, jEnd) {
  let wallet = INITIAL, peak = INITIAL, trough = INITIAL, fee = 0;
  let nTrade = 0, nWin = 0; const perYear = {};
  let side = null, qty = 0, entry = 0, atrE = 0, hwm = 0, cycEntryWallet = 0;
  function close(px, ts) {
    const gross = qty * (px - entry), f = qty * px * FEE_SIDE; wallet += gross - f; fee += f;
    const yr = new Date(ts).getUTCFullYear(); perYear[yr] = (perYear[yr] || 0) + (wallet - cycEntryWallet);
    nTrade++; if (wallet >= cycEntryWallet) nWin++; side = null; qty = 0;
  }
  for (let j = jStart; j < jEnd; j++) {
    const jp = j - 1; if (jp < WARMUP) continue;
    const atrV = atr14[jp]; if (atrV == null || atrV <= 0) continue;
    const day = days[j], openPx = c5[day.firstIdx].open, openTs = day.key * DAY_MS;
    const trendUp = ema50[jp] != null && C[jp] > ema50[jp];
    // exit on trend flip at open
    if (side && !trendUp) close(openPx, openTs);
    // open if flat + trend up + regime gate
    if (!side && trendUp && gateFn(jp)) {
      const f = BASE_QTY * openPx * FEE_SIDE; wallet -= f; fee += f;
      side = "LONG"; qty = BASE_QTY; entry = openPx; atrE = atrV; hwm = openPx; cycEntryWallet = wallet;
    }
    // intraday trail
    if (side) {
      for (let i = day.firstIdx; i <= day.lastIdx; i++) {
        const bar = c5[i]; if (bar.high > hwm) hwm = bar.high;
        const trail = hwm - trailMult * atrE;
        if (bar.low <= trail) { close(Math.min(trail, bar.high), bar.time); break; }
      }
    }
    if (day.firstIdx <= day.lastIdx) { // DD sample EOD
      let eq = wallet; if (side) eq += qty * (c5[day.lastIdx].close - entry);
      if (eq > peak) peak = eq; if (eq < trough) trough = eq;
    }
  }
  if (side) close(c5[days[jEnd - 1].lastIdx].close, days[jEnd - 1].key * DAY_MS);
  const roi = (wallet - INITIAL) / INITIAL * 100;
  const ddPct = peak > trough ? (peak - trough) / peak * 100 : 0;
  const ra = ddPct > 0 ? roi / ddPct : roi;
  const yrs = Object.keys(perYear).length, yrsPos = Object.values(perYear).filter(v => v >= 0).length;
  const span = Math.max(0.1, (days[Math.min(jEnd, N - 1)].key - days[Math.max(jStart, WARMUP)].key) / 365);
  return { roi, ddPct, ra, wr: nTrade ? nWin / nTrade * 100 : 0, nTrade, perYr: nTrade / span, fee, perYear, yrs, yrsPos };
}

// recent slice index (2025-01-01)
const recentKey = Math.floor(Date.UTC(2025, 0, 1) / DAY_MS);
let recentIdx = days.findIndex(d => d.key >= recentKey); if (recentIdx < 0) recentIdx = N - 1;
const split = Math.floor(N * 0.7);

console.log(`\n=== PROBE v4 hedge05 · REGIME-GATED TREND · BTC 7y (${N} days) ===`);
console.log(`Selective (KHÔNG ép daily). WF split @ ${new Date(days[split].key*DAY_MS).toISOString().slice(0,10)}, recent @ ${new Date(days[recentIdx].key*DAY_MS).toISOString().slice(0,10)}.\n`);
console.log(`Gate        | trail | RA full | DD%  | ent/yr | stab | TRAIN→TEST retain  | RECENT'25+ RA/ROI`);
console.log(`------------|-------|---------|------|--------|------|--------------------|------------------`);
for (const [gn, gf] of Object.entries(GATES)) for (const tr of [3, 4]) {
  const full = sim(gf, tr, 0, N);
  const trn = sim(gf, tr, 0, split), tst = sim(gf, tr, split, N);
  const rec = sim(gf, tr, recentIdx, N);
  const retain = trn.ra > 0 ? tst.ra / trn.ra : 0;
  const flag = retain >= 0.7 ? "✅" : retain >= 0.4 ? "⚠️" : "❌";
  console.log(`${gn.padEnd(11)} | ${String(tr).padStart(4)}× | ${(full.ra>=0?"+":"")}${full.ra.toFixed(3).padStart(6)} | ${full.ddPct.toFixed(1).padStart(4)} | ${full.perYr.toFixed(0).padStart(6)} | ${full.yrsPos}/${full.yrs}  | ${(trn.ra>=0?"+":"")}${trn.ra.toFixed(2)}→${(tst.ra>=0?"+":"")}${tst.ra.toFixed(2)} ${(retain*100).toFixed(0).padStart(4)}% ${flag} | RA ${(rec.ra>=0?"+":"")}${rec.ra.toFixed(2)} ROI ${(rec.roi>=0?"+":"")}${rec.roi.toFixed(1)}% n${rec.nTrade}`);
}
console.log(`\nGhi chú: RECENT'25+ = chạy rule chỉ trên 2025-01→2026-05 (regime thù địch). RA dương + WF retain≥40% = có cửa.`);
console.log(`[done]`);
