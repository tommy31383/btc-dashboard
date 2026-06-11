/**
 * quickverify-exp-trailing-7y.mjs — DỌN HÒM mũi ③a (Exp-trailing siết SL tại 2R).
 * Champion BTC4h entries (SL 1.6ATR, TP 16ATR). So 2 exit:
 *   BASELINE : SL / TP / close<EMA20 sau 10 bar / hold 70  (= live).
 *   EXP-TRAIL: như baseline NHƯNG khi đạt +2R (2×1.6ATR profit) → bật trailing exp siết SL vào đỉnh:
 *              trailStop = peakHigh − ATR×max(0.3, 1.6·e^(−(profitR−2)/2)). low≤trailStop → exit.
 * Giả thuyết: crypto re-test sâu 1.5R→0.5R trước khi bứt 16R → siết sớm cắt winner, giết asymmetry.
 * Judge: ΣRet% + per-year + #winner bị cắt non.
 */
import { readFileSync } from "fs";
import { ema, rsi, atr, adxDi, CHAMPION } from "/Users/lap16116/BTC_PC/btc-trader-server/dist/engine/champion.js";

const C = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/";
const raw = JSON.parse(readFileSync(C + "binance-5m-7y.json")).sort((a, b) => a.time - b.time);
const H4 = 4 * 3600e3, H1D = 24 * 3600e3;
const build = (r, ms) => { const b = new Map(); for (const c of r) { const k = Math.floor(c.time / ms); const o = b.get(k); if (!o) b.set(k, { time: k * ms, open: c.open, close: c.close, high: c.high, low: c.low }); else { o.high = Math.max(o.high, c.high); o.low = Math.min(o.low, c.low); o.close = c.close; } } return [...b.keys()].sort((a, b) => a - b).map(k => b.get(k)); };
const b4 = build(raw, H4), b1d = build(raw, H1D);
const cd = b1d.map(b => b.close), e200dArr = ema(cd, 200), tdd = b1d.map(b => b.time);
const e200dAt = t => { let lo = 0, hi = tdd.length - 1, idx = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (tdd[m] <= t) { idx = m; lo = m + 1; } else hi = m - 1; } return idx >= 0 ? e200dArr[idx] : null; };

const c = b4.map(b => b.close), h = b4.map(b => b.high), l = b4.map(b => b.low), t = b4.map(b => b.time);
const e200 = ema(c, 200), e20 = ema(c, 20), R = rsi(c, 14), A = atr(b4, 14), { adx, pdi, mdi } = adxDi(b4, 14);
const cfg = CHAMPION.btc4h, TP_ATR = 16, HOLD = cfg.hold, EXIT_EMA = 10;

// generate entries (BTC4h champion gates, faithful)
const entries = [];
let last = -999;
for (let i = 200; i < c.length - HOLD - 1; i++) {
  if (i - last < cfg.cool) continue;
  const a = adx[i], pp = pdi[i], mm = mdi[i], r = R[i], e2 = e200[i], at = A[i];
  if ([a, pp, mm, r, e2, at].some(v => v == null)) continue;
  const e2d = e200dAt(t[i]); if (e2d == null) continue;
  if (r >= CHAMPION.rsiMax || c[i] <= e2) continue;
  if (!(a > cfg.adx && pp > mm * cfg.diR)) continue;
  if (c[i] < e2d * cfg.bg) continue;
  entries.push({ i, ep: c[i], at, sl: c[i] - cfg.slAtr * at, tp: c[i] + TP_ATR * at });
  last = i;
}

function simExit(e, mode) {
  const Rrisk = cfg.slAtr * e.at;                 // 1.6 ATR
  let peak = e.ep, trailOn = false;
  for (let k = e.i + 1; k <= Math.min(e.i + HOLD, c.length - 1); k++) {
    const held = k - e.i;
    peak = Math.max(peak, h[k]);
    if (l[k] <= e.sl) return { px: e.sl, reason: "SL", held };
    if (h[k] >= e.tp) return { px: e.tp, reason: "TP", held };
    if (mode === "exp") {
      const profitR = (peak - e.ep) / Rrisk;
      if (profitR >= 2) trailOn = true;
      if (trailOn) {
        const kAtr = Math.max(0.3, cfg.slAtr * Math.exp(-(profitR - 2) / 2));
        const trail = peak - e.at * kAtr;
        if (l[k] <= trail && trail > e.sl) return { px: trail, reason: "TRAIL", held };
      }
    }
    if (e20[k] != null && c[k] < e20[k] && held >= EXIT_EMA) return { px: c[k], reason: "EMA20", held };
  }
  const last = Math.min(e.i + HOLD, c.length - 1);
  return { px: c[last], reason: "HOLD", held: last - e.i };
}

function run(mode) {
  const yr = {}; let sum = 0, win = 0, trailCut = 0, reasons = {};
  for (const e of entries) {
    const x = simExit(e, mode);
    const ret = (x.px - e.ep) / e.ep * 100;
    sum += ret; if (ret > 0) win++;
    reasons[x.reason] = (reasons[x.reason] || 0) + 1;
    if (x.reason === "TRAIL") trailCut++;
    const y = new Date(t[e.i]).getUTCFullYear(); yr[y] = (yr[y] || 0) + ret;
  }
  return { sum, win, n: entries.length, yr, trailCut, reasons };
}

const base = run("base"), exp = run("exp");
console.log("=== QUICK-VERIFY ③a Exp-trailing @2R vs BASELINE — Champion BTC4h 7y ===");
console.log(`n entries = ${base.n}\n`);
console.log(`${'metric'.padEnd(16)} | ${'BASELINE'.padStart(12)} | ${'EXP-TRAIL'.padStart(12)} | Δ`);
console.log(`${'ΣRet%'.padEnd(16)} | ${base.sum.toFixed(0).padStart(12)} | ${exp.sum.toFixed(0).padStart(12)} | ${(exp.sum - base.sum).toFixed(0)}`);
console.log(`${'WR%'.padEnd(16)} | ${(100 * base.win / base.n).toFixed(0).padStart(12)} | ${(100 * exp.win / exp.n).toFixed(0).padStart(12)} |`);
console.log(`${'avg ret/trade%'.padEnd(16)} | ${(base.sum / base.n).toFixed(3).padStart(12)} | ${(exp.sum / exp.n).toFixed(3).padStart(12)} |`);
console.log(`\nExp-trail cắt non (reason=TRAIL): ${exp.trailCut} lệnh`);
console.log(`Exit reason BASELINE:`, base.reasons);
console.log(`Exit reason EXP-TRAIL:`, exp.reasons);
console.log("\n--- PER YEAR ΣRet% (year | base | exp | Δ) ---");
for (const y of Object.keys(base.yr).sort())
  console.log(`  ${y} | ${base.yr[y].toFixed(0).padStart(6)} | ${exp.yr[y].toFixed(0).padStart(6)} | ${(exp.yr[y] - base.yr[y]).toFixed(0).padStart(6)}`);
const verdict = exp.sum < base.sum ? "EXP-TRAIL HẠI (siết sớm giết asymmetry) → ĐÓNG HÒM" : "exp-trail có lợi — soi kỹ trước khi tin";
console.log(`\nVERDICT: ${verdict}`);
