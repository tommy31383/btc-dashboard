/**
 * eth-champion-evolver.mjs — champion-challenger loop tìm rule ETH4h entry/trend tốt hơn.
 * RÀNG BUỘC (Tommy 2026-06-09): KHÔNG skip case (no regime-skip; ≥3 lệnh/năm MỌI năm), chỉ tối ưu
 * ENTRY + TREND gate (exit GIỮ champion: slAtr1.4/tp12/hold60/EMA20-10). Chống beta-mirage bằng 5 HARD gate:
 *   1) ≥3 lệnh mỗi năm (không né năm xấu)  2) OOS test 2023-26 dương  3) cross-asset BTC+SOL sumRet>0
 *   4) medAlpha vs random-null > fee (entry thêm value, không chỉ beta)  5) score = Calmar + drop-top20-sống.
 * Nếu KHÔNG config nào qua = xác nhận không có entry-alpha ETH (báo honest, không ship).
 * STOP: touch eth-evolver-STOP. Best → eth-champion-best.json, log → eth-evolver-log.jsonl.
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "fs";
import { ema, rsi, atr, adxDi, volScale } from "/Users/lap16116/BTC_PC/btc-trader-server/dist/engine/champion.js";
const C = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/";
const FEE = 0.0004, H4 = 4 * 3600e3, H1D = 24 * 3600e3;
const build = (raw, ms) => { const b = new Map(); for (const c of raw) { const k = Math.floor(c.time / ms); const o = b.get(k); if (!o) b.set(k, { time: k * ms, open: c.open, close: c.close, high: c.high, low: c.low }); else { o.high = Math.max(o.high, c.high); o.low = Math.min(o.low, c.low); o.close = c.close; } } return [...b.keys()].sort((a, b) => a - b).map(k => b.get(k)); };
function prepAsset(file) {
  const raw = JSON.parse(readFileSync(C + file)).sort((a, b) => a.time - b.time);
  const b4 = build(raw, H4), b1d = build(raw, H1D);
  const cd = b1d.map(x => x.close); const e200d = ema(cd, 200);
  const e200dAt = t => { let lo = 0, hi = b1d.length - 1, idx = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (b1d[m].time <= t) { idx = m; lo = m + 1; } else hi = m - 1; } return idx >= 0 ? e200d[idx] : null; };
  const c = b4.map(x => x.close), h = b4.map(x => x.high), l = b4.map(x => x.low), t = b4.map(x => x.time);
  // higher-TF daily uptrend (for trend-confirm option): daily close > EMA50d
  const e50d = ema(cd, 50); const upDayAt = t => { let lo = 0, hi = b1d.length - 1, idx = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (b1d[m].time <= t) { idx = m; lo = m + 1; } else hi = m - 1; } return idx >= 0 && e50d[idx] !== null ? cd[idx] > e50d[idx] : false; };
  return { c, h, l, t, e200: ema(c, 200), e20: ema(c, 20), rsi: rsi(c, 14), atr: atr(b4, 14), ...adxDi(b4, 14), e200dAt, upDayAt };
}
const ETH = prepAsset("binance-eth-5m-7y.json");
const BTC = prepAsset("binance-5m-7y.json");
const SOL = prepAsset("binance-sol-5m-3y.json");

// fixed champion exit; vary entry params p = {adxT, diR, bandLo, bandHi, needUpDay}
const EX = { slAtr: 1.4, tpAtr: 12, hold: 60, emaExit: 10, cool: 2, maxpos: 5 };
function genTrades(P, p) {
  const { c, h, l, t, e200, e20, rsi: R, atr: A, adx, pdi, mdi, e200dAt, upDayAt } = P;
  let pos = [], out = [], last = -999;
  for (let i = 200; i < c.length - EX.hold - 1; i++) {
    const np = [];
    for (const q of pos) { let xpx = c[i], done = false; if (l[i] <= q.sl) { xpx = q.sl; done = true; } else if (h[i] >= q.tp) { xpx = q.tp; done = true; } else if (e20[i] != null && c[i] < e20[i] && i - q.ei >= EX.emaExit) done = true; else if (i - q.ei >= EX.hold) done = true; if (done) out.push({ eP: q.ep, xP: xpx, xT: t[i], eT: t[i] /*placeholder*/, ei: q.ei, xi: i, eTs: q.eTs, vs: q.vs }); else np.push(q); }
    pos = np;
    if (pos.length >= EX.maxpos || i - last < EX.cool) continue;
    const a = adx[i], pp = pdi[i], mm = mdi[i], r = R[i], e2 = e200[i], at = A[i];
    if ([a, pp, mm, r, e2, at].some(v => v == null)) continue;
    const price = c[i], e2d = e200dAt(t[i]); if (e2d === null) continue;
    if (r >= 101 || price <= e2) continue;
    if (!(a > p.adxT && pp > mm * p.diR)) continue;
    const ratio = price / e2d; if (!(ratio >= p.bandLo && ratio <= p.bandHi)) continue;
    if (p.needUpDay && !upDayAt(t[i])) continue;
    pos.push({ ei: i, ep: price, sl: price - EX.slAtr * at, tp: price + EX.tpAtr * at, eTs: t[i], vs: volScale(A, i) });
    last = i;
  }
  return out;
}
const median = xs => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
function simCalmar(out) { // eqvol $100k → Calmar
  let equity = 1e5, om = 0; const open = []; const ev = []; for (const tr of out) { ev.push({ ty: "E", t: tr.eTs, tr }); ev.push({ ty: "X", t: tr.xT, tr }); }
  ev.sort((a, b) => a.t - b.t || (a.ty === "X" ? -1 : 1)); const pts = [];
  for (const e of ev) { if (e.ty === "X") { const k = open.findIndex(o => o.tr === e.tr); if (k < 0) continue; const o = open[k]; open.splice(k, 1); om -= o.m; equity += o.q * (e.tr.xP - o.eP) - o.q * e.tr.xP * FEE; pts.push(equity); } else { let m = 0.04 * equity * e.tr.vs; const room = equity - om; if (room <= 0) continue; m = Math.min(m, room); const q = m * 10 / e.tr.eP; equity -= q * e.tr.eP * FEE; om += m; open.push({ tr: e.tr, m, q, eP: e.tr.eP }); } }
  let peak = 1e5, dd = 0; for (const x of pts) { if (x > peak) peak = x; const d = (peak - x) / peak; if (d > dd) dd = d; }
  const yrs = out.length ? (out[out.length - 1].xT - out[0].eTs) / (365.25 * 24 * 3600e3) : 1;
  const cagr = Math.pow(Math.max(equity, 1) / 1e5, 1 / yrs) - 1; return { cagr, dd, calmar: dd > 0 ? cagr / dd : 0, ret: equity / 1e5 - 1 };
}
let seed = 20260609;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
function evaluate(p) {
  const out = genTrades(ETH, p);
  if (out.length < 40) return null;
  // gate 1: ≥3 lệnh mỗi năm (không skip case)
  const yr = {}; for (const o of out) { const y = new Date(o.xT).getUTCFullYear(); (yr[y] ??= { n: 0, sum: 0 }); yr[y].n++; yr[y].sum += (o.xP - o.eP) / o.eP * 100; }
  const years = Object.keys(yr); if (years.length < 7) return null; // phải phủ hầu hết 8 năm
  if (years.some(y => yr[y].n < 3)) return null;                    // né năm = loại
  const posYrs = years.filter(y => yr[y].sum > 0).length;
  // gate 2: OOS test 2023-26 dương
  const oos = out.filter(o => new Date(o.xT).getUTCFullYear() >= 2023); const oosSum = oos.reduce((a, o) => a + (o.xP - o.eP) / o.eP * 100, 0); if (oosSum <= 0) return null;
  // gate 3: cross-asset BTC + SOL không âm
  const btcSum = genTrades(BTC, p).reduce((a, o) => a + (o.xP - o.eP) / o.eP * 100, 0);
  const solSum = genTrades(SOL, p).reduce((a, o) => a + (o.xP - o.eP) / o.eP * 100, 0);
  if (btcSum <= 0 || solSum <= 0) return null;
  // gate 4: medAlpha vs random-null > fee round-trip
  const rets = out.map(o => (o.xP - o.eP) / o.eP * 100); const medT = median(rets);
  const rr = []; for (const o of out) { const hb = o.xi - o.ei; for (let k = 0; k < 3; k++) { const s = 200 + Math.floor(rnd() * (ETH.c.length - 200 - hb - 1)); rr.push((ETH.c[s + hb] - ETH.c[s]) / ETH.c[s] * 100); } }
  const medAlpha = medT - median(rr); if (medAlpha <= FEE * 2 * 100) return null;
  // score: Calmar + drop-top20 survive bonus
  const cm = simCalmar(out); const sorted = [...rets].sort((a, b) => b - a); const trim = sorted.slice(Math.floor(sorted.length * 0.2)).reduce((a, b) => a + b, 0);
  const score = cm.calmar + (trim > 0 ? 1.0 : 0) + posYrs * 0.1 + medAlpha * 0.1;
  return { p, n: out.length, calmar: +cm.calmar.toFixed(2), ret: +(cm.ret * 100).toFixed(0), dd: +(cm.dd * 100).toFixed(1), posYrs, years: years.length, oosSum: +oosSum.toFixed(0), btcSum: +btcSum.toFixed(0), solSum: +solSum.toFixed(0), medAlpha: +medAlpha.toFixed(3), dropTop20: +trim.toFixed(0), score: +score.toFixed(3) };
}
function mutate(p) { const q = { ...p }; const k = ["adxT", "diR", "bandLo", "bandHi", "needUpDay"][Math.floor(rnd() * 5)];
  if (k === "adxT") q.adxT = Math.max(8, Math.min(30, p.adxT + (rnd() < .5 ? -2 : 2)));
  else if (k === "diR") q.diR = Math.max(0.8, Math.min(2.0, +(p.diR + (rnd() < .5 ? -0.1 : 0.1)).toFixed(2)));
  else if (k === "bandLo") q.bandLo = Math.max(0.70, Math.min(1.0, +(p.bandLo + (rnd() < .5 ? -0.03 : 0.03)).toFixed(2)));
  else if (k === "bandHi") q.bandHi = Math.max(q.bandLo + 0.05, Math.min(1.25, +(p.bandHi + (rnd() < .5 ? -0.03 : 0.03)).toFixed(2)));
  else q.needUpDay = !p.needUpDay;
  return q; }
// seed champion = current live ETH4h params
let champ = { adxT: 18, diR: 1.3, bandLo: 0.85, bandHi: 1.10, needUpDay: false };
let champEval = evaluate(champ);
console.log("LIVE champion eval:", champEval ? JSON.stringify(champEval) : "FAILS gates (current live rule doesn't pass honest gates!)");
let best = champEval, bestP = champ, iter = 0, found = 0;
const LOG = C + "../tools/eth-evolver-log.jsonl", BEST = C + "../tools/eth-champion-best.json", STOP = C + "../tools/eth-evolver-STOP";
const MAX = +(process.env.MAX_ITER || 4000);
while (iter < MAX) {
  if (existsSync(STOP)) { console.log("STOP file → halt"); break; }
  iter++;
  // 70% mutate best, 30% random restart
  let cand; if (rnd() < 0.3 || !bestP) cand = { adxT: 10 + Math.floor(rnd() * 18), diR: +(0.8 + rnd() * 1.0).toFixed(2), bandLo: +(0.75 + rnd() * 0.2).toFixed(2), bandHi: +(0.95 + rnd() * 0.25).toFixed(2), needUpDay: rnd() < 0.5 };
  else cand = mutate(bestP);
  if (cand.bandHi <= cand.bandLo) continue;
  const e = evaluate(cand);
  if (e && (!best || e.score > best.score)) { best = e; bestP = cand; found++; appendFileSync(LOG, JSON.stringify({ iter, ...e }) + "\n"); writeFileSync(BEST, JSON.stringify({ champion: cand, eval: e, vsLive: champEval, iter }, null, 2));
    console.log(`[${iter}] NEW champion score=${e.score} calmar=${e.calmar} ret=${e.ret}% dd=${e.dd}% posYrs=${e.posYrs}/${e.years} oos=${e.oosSum} btc=${e.btcSum} sol=${e.solSum} medA=${e.medAlpha} dropTop20=${e.dropTop20} | ${JSON.stringify(cand)}`); }
  if (iter % 500 === 0) console.log(`...iter ${iter}, champions found=${found}, bestScore=${best ? best.score : "none"}`);
}
console.log(`\nDONE iter=${iter}. ${best ? `BEST score=${best.score}: ${JSON.stringify(bestP)} → ${JSON.stringify(best)}` : "NO config passed all 5 gates = không có entry-alpha ETH (xác nhận lesson)."}`);
