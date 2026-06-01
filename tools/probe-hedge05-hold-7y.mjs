/**
 * probe-hedge05-hold-7y.mjs  (anh Tommy 2026-06-01)
 *
 * PROBE v2 — sửa lỗi v1: GIỮ lệnh qua nhiều ngày (swing), trail ATR theo trend.
 * Mỗi ngày quyết định tại open dùng daily candle D-1 (không lookahead):
 *   - flat + trend UP        → OPEN LONG (base qty)            [1 lệnh]
 *   - LONG + UP + đang lãi    → ADD pyramid (cap maxAdds)       [≥1 lệnh/ngày activity]
 *   - LONG + trend DOWN/NEUT  → CLOSE ALL (trend flip)
 *   - intraday 5m: chase highWatermark, trail = hwm - k×ATR → CLOSE nếu thủng
 *   - re-entry: stop xong, hôm sau trend còn UP → vào lại
 * LONG-only (v1 xác nhận SHORT no edge). 1 biến thể BOTH_BEAR để đối chiếu.
 *
 * Metric: RA=ROI/maxDD, WR theo cycle, entries/năm, stability /8, DD, fee.
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
const H = days.map(d => d.h), L = days.map(d => d.l), C = days.map(d => d.c), O = days.map(d => d.o);

function ema(arr, p) { const o = new Array(arr.length).fill(null); const k = 2 / (p + 1); let e = 0; for (let i = 0; i < p; i++) e += arr[i]; e /= p; o[p - 1] = e; for (let i = p; i < arr.length; i++) { e = arr[i] * k + e * (1 - k); o[i] = e; } return o; }
function atrW(p) { const tr = new Array(N).fill(0); for (let i = 1; i < N; i++) tr[i] = Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1])); const o = new Array(N).fill(null); let s = 0; for (let i = 1; i <= p; i++) s += tr[i]; o[p] = s / p; for (let i = p + 1; i < N; i++) o[i] = (o[i - 1] * (p - 1) + tr[i]) / p; return o; }
function adxDI(p) {
  const tr = new Array(N).fill(0), pD = new Array(N).fill(0), nD = new Array(N).fill(0);
  for (let i = 1; i < N; i++) { const up = H[i] - H[i - 1], dn = L[i - 1] - L[i]; pD[i] = (up > dn && up > 0) ? up : 0; nD[i] = (dn > up && dn > 0) ? dn : 0; tr[i] = Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1])); }
  const sT = new Array(N).fill(0), sP = new Array(N).fill(0), sN = new Array(N).fill(0); let t0 = 0, p0 = 0, n0 = 0;
  for (let i = 1; i <= p; i++) { t0 += tr[i]; p0 += pD[i]; n0 += nD[i]; } sT[p] = t0; sP[p] = p0; sN[p] = n0;
  for (let i = p + 1; i < N; i++) { sT[i] = sT[i - 1] - sT[i - 1] / p + tr[i]; sP[i] = sP[i - 1] - sP[i - 1] / p + pD[i]; sN[i] = sN[i - 1] - sN[i - 1] / p + nD[i]; }
  const pDI = new Array(N).fill(null), nDI = new Array(N).fill(null), dx = new Array(N).fill(null);
  for (let i = p; i < N; i++) { if (sT[i] === 0) continue; pDI[i] = 100 * sP[i] / sT[i]; nDI[i] = 100 * sN[i] / sT[i]; const s = pDI[i] + nDI[i]; dx[i] = s === 0 ? 0 : 100 * Math.abs(pDI[i] - nDI[i]) / s; }
  const adx = new Array(N).fill(null); let acc = 0, cnt = 0, st = -1;
  for (let i = p; i < N; i++) if (dx[i] != null) { acc += dx[i]; cnt++; if (cnt === p) { st = i; adx[i] = acc / p; break; } }
  if (st > 0) for (let i = st + 1; i < N; i++) if (dx[i] != null) adx[i] = (adx[i - 1] * (p - 1) + dx[i]) / p;
  return { pDI, nDI, adx };
}
const ema20 = ema(C, 20), ema50 = ema(C, 50), ema200 = ema(C, 200), atr14 = atrW(14);
const { pDI, nDI, adx } = adxDI(14);
const TRENDS = {
  EMA_FAST: j => (ema20[j] != null && ema50[j] != null) ? (ema20[j] > ema50[j] ? "UP" : "DOWN") : "NEUT",
  EMA50:    j => (ema50[j] != null) ? (C[j] > ema50[j] ? "UP" : "DOWN") : "NEUT",
  EMA200:   j => (ema200[j] != null) ? (C[j] > ema200[j] ? "UP" : "DOWN") : "NEUT",
  ADX_DI:   j => (adx[j] != null && adx[j] > 20) ? (pDI[j] > nDI[j] ? "UP" : "DOWN") : "NEUT",
};
const isBear = j => ema200[j] != null && C[j] < ema200[j];

// trailMult × ATR; pyramid: maxAdds + stepPct; allowShort: BOTH_BEAR
function sim(trendFn, trailMult, maxAdds, stepPct, allowShort, jStart, jEnd) {
  let wallet = INITIAL, peak = INITIAL, trough = INITIAL, fee = 0;
  let entries = 0, cycles = 0, cycWins = 0;
  const perYear = {};
  // position state
  let side = null, qty = 0, cost = 0, hwm = 0, lwm = 0, atrEntry = 0, lastAddPx = 0, cycEntryWallet = 0;
  function closeAll(px, ts) {
    if (!side) return;
    const gross = side === "LONG" ? qty * (px - cost / qty) : qty * (cost / qty - px);
    const f = qty * px * FEE_SIDE; wallet += gross - f; fee += f;
    const year = new Date(ts).getUTCFullYear(); perYear[year] = (perYear[year] || 0) + (wallet - cycEntryWallet);
    cycles++; if (wallet >= cycEntryWallet) cycWins++;
    side = null; qty = 0; cost = 0; hwm = 0; lwm = 0; atrEntry = 0; lastAddPx = 0;
  }
  function openOrAdd(s, px, atrV) {
    const f = BASE_QTY * px * FEE_SIDE; wallet -= f; fee += f;
    if (!side) { side = s; qty = BASE_QTY; cost = BASE_QTY * px; hwm = px; lwm = px; atrEntry = atrV; lastAddPx = px; cycEntryWallet = wallet; }
    else { qty += BASE_QTY; cost += BASE_QTY * px; lastAddPx = px; }
    entries++;
  }
  for (let j = jStart; j < jEnd; j++) {
    const jp = j - 1; if (jp < WARMUP) continue;
    const atrV = atr14[jp]; if (atrV == null || atrV <= 0) continue;
    const t = trendFn(jp), day = days[j];
    const openBar = c5[day.firstIdx], openPx = openBar.open, openTs = day.key * DAY_MS;
    const wantSide = t === "UP" ? "LONG" : (t === "DOWN" && allowShort && isBear(jp) ? "SHORT" : null);

    // 1) trend flip / opposite → close at day open
    if (side && side !== wantSide) closeAll(openPx, openTs);
    // 2) open or pyramid at day open
    if (wantSide && (!side || side === wantSide)) {
      if (!side) openOrAdd(wantSide, openPx, atrV);
      else {
        const inProfit = side === "LONG" ? openPx > cost / qty : openPx < cost / qty;
        const stepOk = side === "LONG" ? openPx >= lastAddPx * (1 + stepPct / 100) : openPx <= lastAddPx * (1 - stepPct / 100);
        const addsSoFar = Math.round(qty / BASE_QTY) - 1;
        if (inProfit && stepOk && addsSoFar < maxAdds) openOrAdd(wantSide, openPx, atrV);
      }
    }
    // 3) intraday trail
    if (side) {
      for (let i = day.firstIdx; i <= day.lastIdx; i++) {
        const bar = c5[i];
        if (side === "LONG") {
          if (bar.high > hwm) hwm = bar.high;
          const trail = hwm - trailMult * atrEntry;
          if (bar.low <= trail) { closeAll(Math.min(trail, bar.high), bar.time); break; }
        } else {
          if (bar.low < lwm) lwm = bar.low;
          const trail = lwm + trailMult * atrEntry;
          if (bar.high >= trail) { closeAll(Math.max(trail, bar.low), bar.time); break; }
        }
      }
    }
    // 4) mark-to-EOD equity for DD
    let eq = wallet;
    if (side) { const px = c5[day.lastIdx].close; eq += side === "LONG" ? qty * (px - cost / qty) : qty * (cost / qty - px); }
    if (eq > peak) peak = eq; if (eq < trough) trough = eq;
  }
  // close residual
  if (side) closeAll(c5[days[jEnd - 1].lastIdx].close, days[jEnd - 1].key * DAY_MS);
  const roi = (wallet - INITIAL) / INITIAL * 100;
  const ddPct = peak > trough ? (peak - trough) / peak * 100 : 0;
  const ra = ddPct > 0 ? roi / ddPct : roi;
  const yrs = Object.keys(perYear).length, yrsPos = Object.values(perYear).filter(v => v >= 0).length;
  const span = (days[jEnd - 1].key - days[Math.max(jStart, WARMUP)].key) / 365;
  return { roi, ddPct, ra, wr: cycles ? cycWins / cycles * 100 : 0, entries, perYr: entries / span, cycles, fee, perYear, yrs, yrsPos };
}

console.log(`\n=== PROBE v2 hedge05 · GIỮ qua ngày + trail + pyramid · BTC 7y (${N} days) ===`);
console.log(`Buy&hold mốc: +669% / 7y. RA = ROI/maxDD. entries = opens+adds.\n`);
console.log(`TrendDef  | trail | pyramid     | short |  ROI%  |  DD%  |   RA   | WR%  | ent/yr | cyc | stab | fee$`);
console.log(`----------|-------|-------------|-------|--------|-------|--------|------|--------|-----|------|-----`);
const trails = [2, 3, 4];
const pyrs = [[0, 0], [5, 2]];   // off / on(maxAdds5, step2%)
const rows = [];
for (const [tn, tf] of Object.entries(TRENDS)) {
  for (const tr of trails) {
    for (const [ma, sp] of pyrs) {
      for (const short of [false, true]) {
        if (short && tn !== "EMA50" && tn !== "ADX_DI") continue; // chỉ test short ở 2 def
        const r = sim(tf, tr, ma, sp, short, 0, N);
        rows.push({ tn, tr, ma, sp, short, ...r });
        const pyL = ma ? `add${ma}/${sp}%` : "off";
        console.log(`${tn.padEnd(9)} | ${String(tr).padStart(4)}× | ${pyL.padEnd(11)} | ${(short?"bear":"no").padEnd(5)} | ${(r.roi>=0?"+":"")}${r.roi.toFixed(1).padStart(6)} | ${r.ddPct.toFixed(1).padStart(5)} | ${(r.ra>=0?"+":"")}${r.ra.toFixed(3).padStart(6)} | ${r.wr.toFixed(1).padStart(4)} | ${r.perYr.toFixed(0).padStart(6)} | ${String(r.cycles).padStart(3)} | ${r.yrsPos}/${r.yrs} | ${r.fee.toFixed(0)}`);
      }
    }
  }
}
console.log(`\n=== TOP 6 theo RA (cycles≥20) ===`);
for (const r of rows.filter(r => r.cycles >= 20).sort((a, b) => b.ra - a.ra).slice(0, 6)) {
  const ys = Object.entries(r.perYear).map(([y, v]) => `${y.slice(2)}:${v>=0?"+":""}${(v/1000).toFixed(1)}k`).join(" ");
  console.log(`${r.tn}/trail${r.tr}/${r.ma?`pyr${r.ma}`:"noPyr"}/${r.short?"bear":"L"}  RA ${r.ra.toFixed(3)} ROI ${r.roi.toFixed(0)}% DD ${r.ddPct.toFixed(1)}% WR ${r.wr.toFixed(0)}% ent/yr ${r.perYr.toFixed(0)} stab ${r.yrsPos}/${r.yrs}`);
  console.log(`     ${ys}`);
}

// ===== WALK-FORWARD 70/30 cho top configs (kiểm robust, KHÔNG ép daily) =====
console.log(`\n=== WALK-FORWARD 70/30 — v2 chọn-lọc (no forced daily) ===`);
const split = Math.floor(N * 0.7);
const splitDate = new Date(days[split].key * DAY_MS).toISOString().slice(0, 10);
console.log(`Split @ ${splitDate}`);
const checkCfgs = [
  ["EMA50", TRENDS.EMA50, 3, 0, 0, false],
  ["EMA50", TRENDS.EMA50, 4, 0, 0, false],
  ["EMA50", TRENDS.EMA50, 3, 0, 0, true],
  ["EMA_FAST", TRENDS.EMA_FAST, 3, 0, 0, false],
];
for (const [nm, tf, tr, ma, sp, sh] of checkCfgs) {
  const full = sim(tf, tr, ma, sp, sh, 0, N);
  const trn = sim(tf, tr, ma, sp, sh, 0, split);
  const tst = sim(tf, tr, ma, sp, sh, split, N);
  const retain = trn.ra > 0 ? tst.ra / trn.ra : 0;
  console.log(`${nm}/trail${tr}/${sh?"bear":"L"}  FULL RA ${full.ra.toFixed(3)} (DD ${full.ddPct.toFixed(1)}% stab ${full.yrsPos}/${full.yrs}) | TRAIN RA ${trn.ra.toFixed(3)} → TEST RA ${tst.ra.toFixed(3)} | retain ${(retain*100).toFixed(0)}%  ${retain>=0.7?"✅ ROBUST":retain>=0.4?"⚠️ moderate":"❌ decay"}`);
}
console.log(`\n[done]`);
