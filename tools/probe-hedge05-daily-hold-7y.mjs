/**
 * probe-hedge05-daily-hold-7y.mjs  (anh Tommy 2026-06-01)
 *
 * PROBE v3 — TỔNG HỢP: ÉP ≥1 lệnh MỚI mỗi ngày (Tommy yêu cầu cứng) NHƯNG
 * mỗi lệnh ĐỘC LẬP, GIỮ qua nhiều ngày + trail riêng (giữ edge từ v2).
 *   - Mỗi ngày D: mở 1 lệnh tại open ngày, hướng theo DIR variant (luôn có 1 lệnh).
 *   - Mỗi lệnh: trail = extremum ∓ trailMult×ATR_entry, check 5m intraday, time-stop 15d.
 *   - Book = rổ position trend-aligned cuốn chiếu. Winner (vào sớm) gánh laggard.
 *   - "Biến lỗ thành lãi": lệnh vào ngày xấu bị trail cắt nhỏ; lệnh ngày tốt chạy lớn.
 *
 * DIR: ALWAYS_LONG | EMA_DIR | EMA_LONG_BEARSHORT
 * Sizing: flat | conviction (ADX cao → ×2)
 * Metric: RA=ROI/maxDD, WR/lệnh, ent/yr (~365), stab/8, DD, maxConcurrent, fee. + train/test.
 */
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const INITIAL = 100000, FEE_SIDE = 0.05 / 100, BASE_QTY = 0.05, DAY_MS = 86400000, WARMUP = 210;
const MAX_CONCURRENT = 40, TIME_STOP_DAYS = 15;

const c5 = JSON.parse(readFileSync(join(__dirname, "..", ".cache", "binance-5m-7y.json"), "utf8"));
const dayMap = new Map();
for (let i = 0; i < c5.length; i++) {
  const b = c5[i], k = Math.floor(b.time / DAY_MS); let d = dayMap.get(k);
  if (!d) dayMap.set(k, { key: k, o: b.open, h: b.high, l: b.low, c: b.close, firstIdx: i, lastIdx: i });
  else { if (b.high > d.h) d.h = b.high; if (b.low < d.l) d.l = b.low; d.c = b.close; d.lastIdx = i; }
}
const days = [...dayMap.values()].sort((a, b) => a.key - b.key);
const N = days.length;
const dayOfBar = new Int32Array(c5.length);   // map 5m idx -> day index
{ let j = 0; for (let i = 0; i < c5.length; i++) { while (j < N - 1 && c5[i].time >= days[j + 1].key * DAY_MS) j++; dayOfBar[i] = j; } }
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
const isBear = j => ema200[j] != null && C[j] < ema200[j];
function dailySide(dir, jp) {
  const up = ema50[jp] != null && C[jp] > ema50[jp];
  if (dir === "ALWAYS_LONG") return "LONG";
  if (dir === "EMA_DIR") return up ? "LONG" : "SHORT";
  // EMA_LONG_BEARSHORT: up→LONG, down+bear→SHORT, down+notbear→LONG(default long-bias)
  if (up) return "LONG"; return isBear(jp) ? "SHORT" : "LONG";
}

function sim(dir, trailMult, conviction, jStart, jEnd) {
  let wallet = INITIAL, peak = INITIAL, trough = INITIAL, fee = 0;
  let nTrade = 0, nWin = 0, nLong = 0, nShort = 0, maxConc = 0, forcedDays = 0;
  const perYear = {};
  const open = []; // {side,entry,qty,atrE,hwm,lwm,openDayIdx}
  function closePos(k, px, ts) {
    const p = open[k];
    const gross = p.side === "LONG" ? p.qty * (px - p.entry) : p.qty * (p.entry - px);
    const f = p.qty * px * FEE_SIDE; wallet += gross - f; fee += f;
    const yr = new Date(ts).getUTCFullYear(); const net = gross - f;
    perYear[yr] = (perYear[yr] || 0) + net; nTrade++; if (net >= 0) nWin++;
    if (p.side === "LONG") nLong++; else nShort++;
    open.splice(k, 1);
  }
  let curDay = -1;
  for (let i = (jStart > 0 ? days[jStart].firstIdx : 0); i < (jEnd < N ? days[jEnd].firstIdx : c5.length); i++) {
    const bar = c5[i], dIdx = dayOfBar[i];
    // new day → forced entry at this bar (first bar of day)
    if (dIdx !== curDay) {
      curDay = dIdx;
      const jp = dIdx - 1;
      if (jp >= WARMUP && atr14[jp] != null && atr14[jp] > 0 && open.length < MAX_CONCURRENT) {
        const side = dailySide(dir, jp);
        let qty = BASE_QTY;
        if (conviction && adx14[jp] != null && adx14[jp] > 25) qty = BASE_QTY * 2; // conviction size
        const f = qty * bar.open * FEE_SIDE; wallet -= f; fee += f;
        open.push({ side, entry: bar.open, qty, atrE: atr14[jp], hwm: bar.open, lwm: bar.open, openDayIdx: dIdx });
        forcedDays++;
        if (open.length > maxConc) maxConc = open.length;
      }
    }
    // trail + time-stop check every 5m bar
    for (let k = open.length - 1; k >= 0; k--) {
      const p = open[k];
      if (p.side === "LONG") {
        if (bar.high > p.hwm) p.hwm = bar.high;
        const trail = p.hwm - trailMult * p.atrE;
        if (bar.low <= trail) { closePos(k, Math.min(trail, bar.high), bar.time); continue; }
      } else {
        if (bar.low < p.lwm) p.lwm = bar.low;
        const trail = p.lwm + trailMult * p.atrE;
        if (bar.high >= trail) { closePos(k, Math.max(trail, bar.low), bar.time); continue; }
      }
      if (dIdx - p.openDayIdx >= TIME_STOP_DAYS) closePos(k, bar.close, bar.time);
    }
    // DD sample at last bar of each day
    if (i === days[dIdx].lastIdx) {
      let up = 0; for (const p of open) up += p.side === "LONG" ? p.qty * (bar.close - p.entry) : p.qty * (p.entry - bar.close);
      const eq = wallet + up; if (eq > peak) peak = eq; if (eq < trough) trough = eq;
    }
  }
  // close residual
  const lastBar = c5[(jEnd < N ? days[jEnd].firstIdx : c5.length) - 1];
  while (open.length) closePos(0, lastBar.close, lastBar.time);
  const roi = (wallet - INITIAL) / INITIAL * 100;
  const ddPct = peak > trough ? (peak - trough) / peak * 100 : 0;
  const ra = ddPct > 0 ? roi / ddPct : roi;
  const yrs = Object.keys(perYear).length, yrsPos = Object.values(perYear).filter(v => v >= 0).length;
  const span = (days[Math.min(jEnd, N - 1)].key - days[Math.max(jStart, WARMUP)].key) / 365;
  return { roi, ddPct, ra, wr: nTrade ? nWin / nTrade * 100 : 0, nTrade, nLong, nShort, perYr: nTrade / span, maxConc, fee, perYear, yrs, yrsPos, forcedDays };
}

console.log(`\n=== PROBE v3 hedge05 · ÉP ≥1 lệnh/ngày + GIỮ độc lập + trail · BTC 7y (${N} days) ===`);
console.log(`Buy&hold mốc +669%/7y. Mỗi ngày mở 1 lệnh, giữ tới trail/time-stop. RA=ROI/maxDD.\n`);
console.log(`DIR                 | trail | conv | ROI%   |  DD%  |   RA   | WR%  | ent/yr | maxOpen | stab | fee$`);
console.log(`--------------------|-------|------|--------|-------|--------|------|--------|---------|------|-----`);
const dirs = ["ALWAYS_LONG", "EMA_DIR", "EMA_LONG_BEARSHORT"];
const rows = [];
for (const dir of dirs) for (const tr of [3, 5]) for (const conv of [false, true]) {
  const r = sim(dir, tr, conv, 0, N);
  rows.push({ dir, tr, conv, ...r });
  console.log(`${dir.padEnd(19)} | ${String(tr).padStart(4)}× | ${(conv?"adx":"flat").padEnd(4)} | ${(r.roi>=0?"+":"")}${r.roi.toFixed(1).padStart(6)} | ${r.ddPct.toFixed(1).padStart(5)} | ${(r.ra>=0?"+":"")}${r.ra.toFixed(3).padStart(6)} | ${r.wr.toFixed(1).padStart(4)} | ${r.perYr.toFixed(0).padStart(6)} | ${String(r.maxConc).padStart(7)} | ${r.yrsPos}/${r.yrs} | ${r.fee.toFixed(0)}`);
}
console.log(`\n=== TOP 4 theo RA — per-year + train/test 70/30 ===`);
const split = Math.floor(N * 0.7);
for (const r of [...rows].sort((a, b) => b.ra - a.ra).slice(0, 4)) {
  const ys = Object.entries(r.perYear).map(([y, v]) => `${y.slice(2)}:${v>=0?"+":""}${(v/1000).toFixed(1)}k`).join(" ");
  const tr = sim(r.dir, r.tr, r.conv, 0, split), te = sim(r.dir, r.tr, r.conv, split, N);
  const retain = tr.ra > 0 ? (te.ra / tr.ra) : 0;
  console.log(`${r.dir}/trail${r.tr}/${r.conv?"adx":"flat"}  RA ${r.ra.toFixed(3)} ROI ${r.roi.toFixed(0)}% DD ${r.ddPct.toFixed(1)}% WR ${r.wr.toFixed(0)}% ent/yr ${r.perYr.toFixed(0)} stab ${r.yrsPos}/${r.yrs} L/S ${r.nLong}/${r.nShort}`);
  console.log(`     per-year: ${ys}`);
  console.log(`     TRAIN RA ${tr.ra.toFixed(3)} (ROI ${tr.roi.toFixed(0)}% DD ${tr.ddPct.toFixed(1)}%) | TEST RA ${te.ra.toFixed(3)} (ROI ${te.roi.toFixed(0)}% DD ${te.ddPct.toFixed(1)}%) | retain ${(retain*100).toFixed(0)}%`);
}
console.log(`\n[done]`);
