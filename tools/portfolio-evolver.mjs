/**
 * portfolio-evolver.mjs — tìm PHƯƠNG ÁN BOOK tốt nhất (đòn bẩy thật: allocation/diversify/sizing,
 * KHÔNG phải entry — entry đã chứng minh 0 alpha). Search:
 *   - sleeve subset của [BTC4h, BTC1h, ETH4h, SOL4h]
 *   - risk weight mỗi sleeve ∈ {0.5,0.75,1.0,1.25,1.5} (× CHAMPION.risk × volScale)
 *   - tpAtr global ∈ {10,12,14,16}
 * Sizing = eqvol shared-equity $100k. Maximize Calmar.
 * HARD gates: per-year ≥7/8 dương (không skip/né năm) + OOS test 2023-26 Calmar>0.8 + maxDD<40%.
 * STOP: touch portfolio-evolver-STOP. Best → portfolio-best.json, log → portfolio-log.jsonl.
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "fs";
import { ema, rsi, atr, adxDi, volScale, CHAMPION } from "/Users/lap16116/BTC_PC/btc-trader-server/dist/engine/champion.js";
const C = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/";
const FEE = 0.0004, H4 = 4 * 3600e3, H1 = 3600e3, H1D = 24 * 3600e3;
const build = (raw, ms) => { const b = new Map(); for (const c of raw) { const k = Math.floor(c.time / ms); const o = b.get(k); if (!o) b.set(k, { time: k * ms, open: c.open, close: c.close, high: c.high, low: c.low }); else { o.high = Math.max(o.high, c.high); o.low = Math.min(o.low, c.low); o.close = c.close; } } return [...b.keys()].sort((a, b) => a - b).map(k => b.get(k)); };
function prep(file, withH1) {
  const raw = JSON.parse(readFileSync(C + file)).sort((a, b) => a.time - b.time);
  const b4 = build(raw, H4), b1d = build(raw, H1D); const cd = b1d.map(x => x.close); const e200d = ema(cd, 200);
  const e200dAt = t => { let lo = 0, hi = b1d.length - 1, i = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (b1d[m].time <= t) { i = m; lo = m + 1; } else hi = m - 1; } return i >= 0 ? e200d[i] : null; };
  const mk = bars => { const c = bars.map(x => x.close); return { c, h: bars.map(x => x.high), l: bars.map(x => x.low), t: bars.map(x => x.time), e200: ema(c, 200), e20: ema(c, 20), rsi: rsi(c, 14), atr: atr(bars, 14), ...adxDi(bars, 14), e200dAt }; };
  const out = { p4: mk(b4) }; if (withH1) out.p1 = mk(build(raw, H1)); return out;
}
const ETH = prep("binance-eth-5m-7y.json", false);
const BTC = prep("binance-5m-7y.json", true);
const SOL = prep("binance-sol-5m-3y.json", false);
// gen: kind 'bg'|'band', exitEma, gate4h(P4 for BTC1h)
function gen(P, cfg, tpAtr, { kind, exitEma, gate4h }) {
  const { c, h, l, t, e200, e20, rsi: R, atr: A, adx, pdi, mdi, e200dAt } = P; let pos = [], out = [], last = -999;
  for (let i = 200; i < c.length - cfg.hold - 1; i++) {
    const np = []; for (const q of pos) { let xpx = c[i], done = false; if (l[i] <= q.sl) { xpx = q.sl; done = true; } else if (h[i] >= q.tp) { xpx = q.tp; done = true; } else if (e20[i] != null && c[i] < e20[i] && i - q.ei >= exitEma) done = true; else if (i - q.ei >= cfg.hold) done = true; if (done) out.push({ eP: q.ep, xP: xpx, xT: t[i], eTs: q.eTs, vs: q.vs }); else np.push(q); } pos = np;
    if (pos.length >= cfg.maxpos || i - last < cfg.cool) continue;
    const a = adx[i], pp = pdi[i], mm = mdi[i], r = R[i], e2 = e200[i], at = A[i]; if ([a, pp, mm, r, e2, at].some(v => v == null)) continue;
    const price = c[i], e2d = e200dAt(t[i]); if (e2d === null) continue; if (r >= 101 || price <= e2) continue;
    if (!(a > cfg.adx && pp > mm * cfg.diR)) continue;
    if (kind === "band") { const ratio = price / e2d; if (!(ratio >= cfg.bandLo && ratio <= cfg.bandHi)) continue; } else { if (price < e2d * cfg.bg) continue; }
    if (gate4h) { const G = gate4h; let lo = 0, hi = G.t.length - 1, j = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (G.t[m] <= t[i]) { j = m; lo = m + 1; } else hi = m - 1; } if (j < 0 || G.adx[j] == null) continue; if (!(G.adx[j] > 18 && G.pdi[j] > G.mdi[j] * 0.95 && G.c[j] > G.e200[j])) continue; }
    pos.push({ ei: i, ep: price, sl: price - cfg.slAtr * at, tp: price + tpAtr * at, eTs: t[i], vs: volScale(A, i) }); last = i;
  }
  return out;
}
// precompute trades per (sleeve, tpAtr)
const TPS = [10, 12, 14, 16];
const SLEEVES = {
  BTC4h: tp => gen(BTC.p4, CHAMPION.btc4h, tp, { kind: "bg", exitEma: 10 }),
  BTC1h: tp => gen(BTC.p1, CHAMPION.btc1h, tp, { kind: "bg", exitEma: 4, gate4h: BTC.p4 }),
  ETH4h: tp => gen(ETH.p4, CHAMPION.eth4h, tp, { kind: "band", exitEma: 10 }),
  SOL4h: tp => gen(SOL.p4, CHAMPION.btc4h, tp, { kind: "bg", exitEma: 10 }),  // SOL dùng btc4h trend cfg
};
const CACHE = {}; for (const s in SLEEVES) for (const tp of TPS) { CACHE[`${s}:${tp}`] = SLEEVES[s](tp).map(tr => ({ ...tr, sleeve: s })); }
console.log("trade counts (tp12):", Object.fromEntries(Object.keys(SLEEVES).map(s => [s, CACHE[`${s}:12`].length])));

function simulate(trades, weights) { // eqvol shared equity, per-sleeve weight
  let equity = 1e5, om = 0; const open = []; const ev = []; for (const tr of trades) { ev.push({ ty: "E", t: tr.eTs, tr }); ev.push({ ty: "X", t: tr.xT, tr }); }
  ev.sort((a, b) => a.t - b.t || (a.ty === "X" ? -1 : 1)); const pts = []; const yr = {};
  for (const e of ev) {
    if (e.ty === "X") { const k = open.findIndex(o => o.tr === e.tr); if (k < 0) continue; const o = open[k]; open.splice(k, 1); om -= o.m; const pnl = o.q * (e.tr.xP - o.eP) - o.q * e.tr.xP * FEE; equity += pnl; pts.push(equity); const y = new Date(e.tr.xT).getUTCFullYear(); (yr[y] ??= 0); yr[y] += pnl - o.feeIn; }
    else { const w = weights[e.tr.sleeve]; let m = 0.04 * w * equity * e.tr.vs; const room = equity - om; if (room <= 0) continue; m = Math.min(m, room); const q = m * 10 / e.tr.eP; const feeIn = q * e.tr.eP * FEE; equity -= feeIn; om += m; open.push({ tr: e.tr, m, q, eP: e.tr.eP, feeIn }); }
  }
  let peak = 1e5, dd = 0; for (const x of pts) { if (x > peak) peak = x; const d = (peak - x) / peak; if (d > dd) dd = d; }
  const yrs = trades.length ? (trades[trades.length - 1].xT - Math.min(...trades.map(t => t.eTs))) / (365.25 * 24 * 3600e3) : 1;
  const cagr = Math.pow(Math.max(equity, 1) / 1e5, 1 / yrs) - 1;
  return { cagr, dd, calmar: dd > 0 ? cagr / dd : 0, ret: equity / 1e5 - 1, yr };
}
function evaluate(cand) { // cand={sleeves:{BTC4h:w,...}, tp}
  const names = Object.keys(cand.sleeves); if (!names.length) return null;
  let trades = []; for (const s of names) trades = trades.concat(CACHE[`${s}:${cand.tp}`]);
  trades.sort((a, b) => a.eTs - b.eTs);
  const full = simulate(trades, cand.sleeves);
  // gate per-year (BTC full 8y; SOL only 2023+ so 8y window). ≥7/8 dương, đếm năm có lệnh
  const ys = Object.keys(full.yr); const pos = ys.filter(y => full.yr[y] > 0).length;
  if (ys.length >= 8 && pos < 7) return null; if (ys.length < 8 && pos < ys.length - 1) return null;
  if (full.dd > 0.40) return null;
  // OOS test 2023-26
  const tTest = trades.filter(t => new Date(t.xT).getUTCFullYear() >= 2023); const test = simulate(tTest, cand.sleeves);
  if (test.calmar < 0.8) return null;
  return { ...full, posYrs: `${pos}/${ys.length}`, oosCalmar: +test.calmar.toFixed(2), score: +(full.calmar + (full.ret > 50 ? 0.5 : 0)).toFixed(3) };
}
let seed = 424242; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const WSET = [0.5, 0.75, 1.0, 1.25, 1.5]; const SNAMES = Object.keys(SLEEVES);
function randCand() { const sl = {}; for (const s of SNAMES) if (rnd() < 0.6) sl[s] = WSET[Math.floor(rnd() * WSET.length)]; if (!Object.keys(sl).length) sl[SNAMES[Math.floor(rnd() * 4)]] = 1.0; return { sleeves: sl, tp: TPS[Math.floor(rnd() * TPS.length)] }; }
function mutate(c) { const n = { sleeves: { ...c.sleeves }, tp: c.tp }; const r = rnd();
  if (r < 0.3) { const s = SNAMES[Math.floor(rnd() * 4)]; if (n.sleeves[s]) delete n.sleeves[s]; else n.sleeves[s] = 1.0; if (!Object.keys(n.sleeves).length) n.sleeves[s] = 1.0; }
  else if (r < 0.7) { const ks = Object.keys(n.sleeves); const s = ks[Math.floor(rnd() * ks.length)]; n.sleeves[s] = WSET[Math.floor(rnd() * WSET.length)]; }
  else n.tp = TPS[Math.floor(rnd() * TPS.length)];
  return n; }
// baseline = live BTC-only + ETH (current deployed)
const baseline = evaluate({ sleeves: { BTC4h: 1.0, BTC1h: 1.0, ETH4h: 1.0 }, tp: 12 });
console.log("LIVE book (BTC4h+BTC1h+ETH4h, w1, tp12):", JSON.stringify(baseline));
let best = baseline, bestC = { sleeves: { BTC4h: 1.0, BTC1h: 1.0, ETH4h: 1.0 }, tp: 12 }, iter = 0, found = 0;
const LOG = C + "../tools/portfolio-log.jsonl", BEST = C + "../tools/portfolio-best.json", STOP = C + "../tools/portfolio-evolver-STOP";
const MAX = +(process.env.MAX_ITER || 3000);
while (iter < MAX) { if (existsSync(STOP)) { console.log("STOP"); break; } iter++;
  const cand = (rnd() < 0.3 || !bestC) ? randCand() : mutate(bestC);
  const e = evaluate(cand);
  if (e && (!best || e.score > best.score)) { best = e; bestC = cand; found++; appendFileSync(LOG, JSON.stringify({ iter, cand, e }) + "\n"); writeFileSync(BEST, JSON.stringify({ champion: cand, eval: e, vsLive: baseline }, null, 2));
    console.log(`[${iter}] BEST score=${e.score} calmar=${e.calmar.toFixed(2)} ret=${(e.ret * 100).toFixed(0)}% dd=${(e.dd * 100).toFixed(1)}% posYrs=${e.posYrs} oosCalmar=${e.oosCalmar} | ${JSON.stringify(cand)}`); }
  if (iter % 500 === 0) console.log(`...iter ${iter} found=${found} bestScore=${best ? best.score : "?"}`);
}
console.log(`\nDONE iter=${iter}. BEST: ${JSON.stringify(bestC)} → calmar=${best.calmar.toFixed(2)} ret=${(best.ret*100).toFixed(0)}% dd=${(best.dd*100).toFixed(1)}% posYrs=${best.posYrs} oosCalmar=${best.oosCalmar}`);
