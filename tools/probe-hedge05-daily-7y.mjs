/**
 * probe-hedge05-daily-7y.mjs  (anh Tommy 2026-06-01)
 *
 * RESEARCH PROBE — KHÔNG phải rule production.
 * Câu hỏi: "Đánh giá trend của NGÀY rồi đánh theo trend" có edge trên BTC 7y không?
 *
 * Model bare (chưa có re-entry/pyramid):
 *   - Resample 5m 7y → daily (UTC).
 *   - Mỗi ngày D: xác định trend bằng daily candle D-1 (KHÔNG lookahead).
 *   - Vào lệnh tại 5m bar đầu ngày D (open), exit theo 2 model:
 *       EOD_ONLY: giữ tới close cuối ngày (đo directional edge thuần).
 *       TPSL:     SL/TP = mult × ATR_1d[D-1], fill 5m intraday (SL ưu tiên nếu cùng bar).
 *   - 7 định nghĩa trend × 3 hướng × 2 exit = 42 config + 2 baseline.
 *
 * Metrics: RA = ROI/maxDD, WR, per-year stability /7, trades, fee. (RA invariant theo qty.)
 */
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INITIAL = 100000;
const FEE_SIDE = 0.05 / 100;     // 0.05% mỗi side
const QTY = 0.05;                // BTC/lệnh (RA bất biến theo qty)
const DAY_MS = 86400000;
const WARMUP_DAYS = 210;         // đủ cho EMA200 daily

// ---------- load + resample ----------
const c5 = JSON.parse(readFileSync(join(__dirname, "..", ".cache", "binance-5m-7y.json"), "utf8"));

// group 5m theo UTC day
const dayMap = new Map(); // dayKey -> {o,h,l,c,first5mIdx,last5mIdx}
for (let i = 0; i < c5.length; i++) {
  const b = c5[i];
  const k = Math.floor(b.time / DAY_MS);
  let d = dayMap.get(k);
  if (!d) { d = { key: k, o: b.open, h: b.high, l: b.low, c: b.close, firstIdx: i, lastIdx: i }; dayMap.set(k, d); }
  else { if (b.high > d.h) d.h = b.high; if (b.low < d.l) d.l = b.low; d.c = b.close; d.lastIdx = i; }
}
const days = [...dayMap.values()].sort((a, b) => a.key - b.key);
const dayIdxByKey = new Map(days.map((d, j) => [d.key, j]));
const N = days.length;

// ---------- daily indicators ----------
const H = days.map(d => d.h), L = days.map(d => d.l), C = days.map(d => d.c), O = days.map(d => d.o);

function ema(arr, p) {
  const o = new Array(arr.length).fill(null); const k = 2 / (p + 1);
  let e = 0; for (let i = 0; i < p; i++) e += arr[i]; e /= p; o[p - 1] = e;
  for (let i = p; i < arr.length; i++) { e = arr[i] * k + e * (1 - k); o[i] = e; } return o;
}
function atrWilder(p) {
  const tr = new Array(N).fill(0);
  for (let i = 1; i < N; i++) tr[i] = Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1]));
  const o = new Array(N).fill(null); let s = 0;
  for (let i = 1; i <= p; i++) s += tr[i]; o[p] = s / p;
  for (let i = p + 1; i < N; i++) o[i] = (o[i - 1] * (p - 1) + tr[i]) / p; return o;
}
function adxDI(p) {
  const tr = new Array(N).fill(0), pDM = new Array(N).fill(0), nDM = new Array(N).fill(0);
  for (let i = 1; i < N; i++) {
    const up = H[i] - H[i - 1], dn = L[i - 1] - L[i];
    pDM[i] = (up > dn && up > 0) ? up : 0;
    nDM[i] = (dn > up && dn > 0) ? dn : 0;
    tr[i] = Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1]));
  }
  const sTR = new Array(N).fill(0), sP = new Array(N).fill(0), sN = new Array(N).fill(0);
  let tr0 = 0, p0 = 0, n0 = 0;
  for (let i = 1; i <= p; i++) { tr0 += tr[i]; p0 += pDM[i]; n0 += nDM[i]; }
  sTR[p] = tr0; sP[p] = p0; sN[p] = n0;
  for (let i = p + 1; i < N; i++) {
    sTR[i] = sTR[i - 1] - sTR[i - 1] / p + tr[i];
    sP[i] = sP[i - 1] - sP[i - 1] / p + pDM[i];
    sN[i] = sN[i - 1] - sN[i - 1] / p + nDM[i];
  }
  const pDI = new Array(N).fill(null), nDI = new Array(N).fill(null), dx = new Array(N).fill(null);
  for (let i = p; i < N; i++) {
    if (sTR[i] === 0) continue;
    pDI[i] = 100 * sP[i] / sTR[i]; nDI[i] = 100 * sN[i] / sTR[i];
    const sum = pDI[i] + nDI[i]; dx[i] = sum === 0 ? 0 : 100 * Math.abs(pDI[i] - nDI[i]) / sum;
  }
  const adx = new Array(N).fill(null); let d0 = 0, cnt = 0, startI = -1;
  for (let i = p; i < N; i++) { if (dx[i] != null) { d0 += dx[i]; cnt++; if (cnt === p) { startI = i; adx[i] = d0 / p; break; } } }
  if (startI > 0) for (let i = startI + 1; i < N; i++) if (dx[i] != null) adx[i] = (adx[i - 1] * (p - 1) + dx[i]) / p;
  return { pDI, nDI, adx };
}
function donchian(p) {
  const hh = new Array(N).fill(null), ll = new Array(N).fill(null);
  for (let i = p; i < N; i++) {
    let mx = -Infinity, mn = Infinity;
    for (let j = i - p; j < i; j++) { if (H[j] > mx) mx = H[j]; if (L[j] < mn) mn = L[j]; }
    hh[i] = mx; ll[i] = mn;
  }
  return { hh, ll };
}

const ema20 = ema(C, 20), ema50 = ema(C, 50), ema200 = ema(C, 200);
const atr14 = atrWilder(14);
const { pDI, nDI, adx } = adxDI(14);
const { hh, ll } = donchian(20);

// ---------- trend definitions (dùng index j = D-1, không lookahead) ----------
// trả về "UP" | "DOWN" | "NEUTRAL"
const TRENDS = {
  MOM_GREEN:  j => C[j] > O[j] ? "UP" : "DOWN",                                   // hôm qua nến xanh
  MOM_CLOSE:  j => (j >= 1 && C[j] > C[j - 1]) ? "UP" : "DOWN",                    // hôm qua close cao hơn
  EMA_FAST:   j => (ema20[j] != null && ema50[j] != null) ? (ema20[j] > ema50[j] ? "UP" : "DOWN") : "NEUTRAL",
  EMA50:      j => (ema50[j] != null) ? (C[j] > ema50[j] ? "UP" : "DOWN") : "NEUTRAL",
  EMA200:     j => (ema200[j] != null) ? (C[j] > ema200[j] ? "UP" : "DOWN") : "NEUTRAL",
  ADX_DI:     j => (adx[j] != null && adx[j] > 20) ? (pDI[j] > nDI[j] ? "UP" : "DOWN") : "NEUTRAL", // chỉ trend khi ADX>20
  DONCH20:    j => (hh[j] != null) ? (C[j] >= hh[j] ? "UP" : (C[j] <= ll[j] ? "DOWN" : "NEUTRAL")) : "NEUTRAL",
};

// regime bear confirmed: daily close < EMA200 (dùng D-1)
const isBear = j => ema200[j] != null && C[j] < ema200[j];

// ---------- simulator ----------
// dir variant: "LONG_ONLY" | "BOTH_BEAR" | "BOTH_NAIVE"
// exit: "EOD" | "TPSL"  (slMult/tpMult × ATR_1d[D-1])
function sim(trendFn, dirVariant, exit, slMult, tpMult, jStart, jEnd) {
  let wallet = INITIAL, peak = INITIAL, trough = INITIAL, fee = 0;
  let nTrade = 0, nWin = 0, nLong = 0, nShort = 0;
  const perYear = {};
  for (let j = jStart; j < jEnd; j++) {
    const jp = j - 1;                       // daily candle đã đóng (D-1)
    if (jp < WARMUP_DAYS) continue;
    const atrV = atr14[jp];
    if (atrV == null || atrV <= 0) continue;
    let t = trendFn(jp);
    // quyết định hướng
    let side = null;
    if (t === "UP") side = "LONG";
    else if (t === "DOWN") {
      if (dirVariant === "LONG_ONLY") side = null;
      else if (dirVariant === "BOTH_BEAR") side = isBear(jp) ? "SHORT" : null;
      else side = "SHORT"; // BOTH_NAIVE
    } else side = null;     // NEUTRAL → skip
    if (!side) continue;

    const day = days[j];
    const entryBar = c5[day.firstIdx];
    const entryPx = entryBar.open;
    const year = new Date(day.key * DAY_MS).getUTCFullYear();
    let exitPx = null;

    if (exit === "EOD") {
      exitPx = c5[day.lastIdx].close;
    } else {
      const slPx = side === "LONG" ? entryPx - slMult * atrV : entryPx + slMult * atrV;
      const tpPx = side === "LONG" ? entryPx + tpMult * atrV : entryPx - tpMult * atrV;
      for (let i = day.firstIdx; i <= day.lastIdx; i++) {
        const bar = c5[i];
        if (side === "LONG") {
          const slHit = bar.low <= slPx, tpHit = bar.high >= tpPx;
          if (slHit) { exitPx = slPx; break; }      // SL ưu tiên (bảo thủ)
          if (tpHit) { exitPx = tpPx; break; }
        } else {
          const slHit = bar.high >= slPx, tpHit = bar.low <= tpPx;
          if (slHit) { exitPx = slPx; break; }
          if (tpHit) { exitPx = tpPx; break; }
        }
      }
      if (exitPx == null) exitPx = c5[day.lastIdx].close; // time stop EOD
    }

    const gross = side === "LONG" ? QTY * (exitPx - entryPx) : QTY * (entryPx - exitPx);
    const f = QTY * entryPx * FEE_SIDE + QTY * exitPx * FEE_SIDE;
    const net = gross - f;
    wallet += net; fee += f; nTrade++;
    if (net >= 0) nWin++;
    if (side === "LONG") nLong++; else nShort++;
    perYear[year] = (perYear[year] || 0) + net;
    if (wallet > peak) peak = wallet;
    if (wallet < trough) trough = wallet;
  }
  const roi = (wallet - INITIAL) / INITIAL * 100;
  const ddPct = peak > trough ? (peak - trough) / peak * 100 : 0;
  const ra = ddPct > 0 ? roi / ddPct : (roi !== 0 ? roi : 0);
  const yrs = Object.keys(perYear).length;
  const yrsPos = Object.values(perYear).filter(v => v >= 0).length;
  return { roi, ddPct, ra, wr: nTrade ? nWin / nTrade * 100 : 0, nTrade, nLong, nShort, fee, perYear, yrs, yrsPos };
}

// ---------- baselines ----------
function alwaysLongEOD(jStart, jEnd) {
  return sim(() => "UP", "LONG_ONLY", "EOD", 0, 0, jStart, jEnd);
}

// ---------- run ----------
const jStart = 0, jEnd = N;
console.log(`\n=== PROBE hedge05 daily-trend · BTC 7y (${N} UTC days, ${new Date(days[0].key*DAY_MS).toISOString().slice(0,10)} → ${new Date(days[N-1].key*DAY_MS).toISOString().slice(0,10)}) ===`);
console.log(`Model: 1 lệnh/ngày, vào tại open ngày, fee 0.1% round-trip, qty ${QTY} BTC. RA = ROI/maxDD.\n`);

const bh = (C[N - 1] - C[WARMUP_DAYS]) / C[WARMUP_DAYS] * 100;
const al = alwaysLongEOD(jStart, jEnd);
console.log(`BASELINE buy&hold (warmup→cuối): ROI ${bh.toFixed(0)}%`);
console.log(`BASELINE always-LONG-EOD mỗi ngày: ROI ${al.roi.toFixed(1)}% · DD ${al.ddPct.toFixed(1)}% · RA ${al.ra.toFixed(3)} · WR ${al.wr.toFixed(1)}% · n=${al.nTrade} · stab ${al.yrsPos}/${al.yrs} · fee $${al.fee.toFixed(0)}\n`);

const dirs = ["LONG_ONLY", "BOTH_BEAR", "BOTH_NAIVE"];
const exits = [["EOD", 0, 0], ["TPSL", 1.0, 1.5]];

console.log(`TrendDef    | Dir        | Exit       |  ROI%  |  DD%  |   RA   | WR%  |   n   | L/S       | stab | fee$`);
console.log(`------------|------------|------------|--------|-------|--------|------|-------|-----------|------|------`);
const rows = [];
for (const [tname, tfn] of Object.entries(TRENDS)) {
  for (const dir of dirs) {
    for (const [ex, sm, tm] of exits) {
      const r = sim(tfn, dir, ex, sm, tm, jStart, jEnd);
      rows.push({ tname, dir, ex, ...r });
      const exLabel = ex === "EOD" ? "EOD" : `SL${sm}/TP${tm}`;
      console.log(
        `${tname.padEnd(11)} | ${dir.padEnd(10)} | ${exLabel.padEnd(10)} | ${(r.roi>=0?"+":"")}${r.roi.toFixed(1).padStart(6)} | ${r.ddPct.toFixed(1).padStart(5)} | ${(r.ra>=0?"+":"")}${r.ra.toFixed(3).padStart(6)} | ${r.wr.toFixed(1).padStart(4)} | ${String(r.nTrade).padStart(5)} | ${String(r.nLong)+"/"+String(r.nShort)} | ${r.yrsPos}/${r.yrs} | ${r.fee.toFixed(0)}`
      );
    }
  }
}

// top theo RA (chỉ giữ n>=200 cho ý nghĩa thống kê + DD>0)
console.log(`\n=== TOP 8 theo RA (n≥200, có ý nghĩa) ===`);
const top = rows.filter(r => r.nTrade >= 200 && r.ddPct > 0).sort((a, b) => b.ra - a.ra).slice(0, 8);
for (const r of top) {
  const yrStr = Object.entries(r.perYear).map(([y, v]) => `${y.slice(2)}:${v>=0?"+":""}${(v/1000).toFixed(1)}k`).join(" ");
  console.log(`${r.tname}/${r.dir}/${r.ex}  RA ${r.ra.toFixed(3)} ROI ${r.roi.toFixed(1)}% DD ${r.ddPct.toFixed(1)}% WR ${r.wr.toFixed(1)}% n=${r.nTrade} stab ${r.yrsPos}/${r.yrs}`);
  console.log(`     per-year: ${yrStr}`);
}
console.log(`\n[done]`);
