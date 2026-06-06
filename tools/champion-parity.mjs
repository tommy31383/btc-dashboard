/**
 * champion-parity.mjs — Verify TS champion.ts port reproduces Python backtest (146%/20.4%/n387).
 * Uses the SAME indicator helpers exported by the compiled champion.js (server dist), runs the
 * 3-sleeve equity-fraction backtest over 7y, compares CAGR/DD/n to general-rule-autoloop honest_eval.
 */
import { readFileSync } from "fs";
import { ema, rsi, atr, adxDi, volScale, CHAMPION } from "/Users/lap16116/BTC_PC/btc-trader-server/dist/engine/champion.js";

const C = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/";
const rawBtc = JSON.parse(readFileSync(C + "binance-5m-7y.json")).sort((a, b) => a.time - b.time);
const rawEth = JSON.parse(readFileSync(C + "binance-eth-5m-7y.json")).sort((a, b) => a.time - b.time);
const rf = JSON.parse(readFileSync(C + "binance-funding-7y.json"));
const fk = Object.keys(rf[0]).find(k => k.toLowerCase().includes("time"));
const rk = ["fundingRate", "rate", "r", "funding"].find(k => k in rf[0]);
const fund = rf.map(e => [+e[fk], +e[rk]]).sort((a, b) => a[0] - b[0]);
const ftimes = fund.map(x => x[0]);
function fundAt(t) { let lo = 0, hi = ftimes.length - 1, idx = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (ftimes[m] <= t) { idx = m; lo = m + 1; } else hi = m - 1; } return idx >= 0 ? fund[idx][1] : 0; }

const H4 = 4 * 3600e3, H1 = 3600e3, H1D = 24 * 3600e3;
function build(raw, ms) {
  const b = new Map();
  for (const c of raw) { const k = Math.floor(c.time / ms); const o = b.get(k); if (!o) b.set(k, { time: k * ms, open: c.open, close: c.close, high: c.high, low: c.low, volume: c.volume }); else { o.high = Math.max(o.high, c.high); o.low = Math.min(o.low, c.low); o.close = c.close; o.volume += c.volume; } }
  return [...b.keys()].sort((a, b) => a - b).map(k => b.get(k));
}

// Build bars
const b4 = build(rawBtc, H4), b1 = build(rawBtc, H1), b1d = build(rawBtc, H1D);
const e4 = build(rawEth, H4), e1d = build(rawEth, H1D);

function e200dArr(b1dBars) { const cl = b1dBars.map(x => x.close); const e = ema(cl, 200); return { t: b1dBars.map(x => x.time), e }; }
function e200dAt(P, t) { let lo = 0, hi = P.t.length - 1, idx = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (P.t[m] <= t) { idx = m; lo = m + 1; } else hi = m - 1; } return idx >= 0 ? P.e[idx] : null; }
const btcD = e200dArr(b1d), ethD = e200dArr(e1d);

// Precompute indicators per TF
function prep(bars) {
  const c = bars.map(b => b.close);
  return { bars, c, h: bars.map(b => b.high), l: bars.map(b => b.low), t: bars.map(b => b.time), e200: ema(c, 200), e20: ema(c, 20), rsi: rsi(c, 14), atr: atr(bars, 14), ...adxDi(bars, 14) };
}
const P4 = prep(b4), P1 = prep(b1), PE = prep(e4);

// Sleeve generator faithful to autoloop gen_4h/gen_1h. Returns trades [{e_ms,x_ms,ret,vs,sleeve}]
function gen(P, dailyP, cfg, { eth = false, gate4h = null, tf = H4, exitEmaBars = 10 } = {}, sleeveName) {
  const { c, h, l, t, e200, e20, rsi: R, atr: A, adx, pdi, mdi } = P;
  let pos = [], out = [], last = -999;
  for (let i = 200; i < c.length - cfg.hold - 1; i++) {
    const np = [];
    for (const p of pos) {
      let xpx = c[i], done = false;
      if (l[i] <= p.sl) { xpx = p.sl; done = true; }
      else if (h[i] >= p.tp) { xpx = p.tp; done = true; }
      else if (e20[i] !== null && c[i] < e20[i] && i - p.ei >= exitEmaBars) done = true;
      else if (i - p.ei >= cfg.hold) done = true;
      if (done) out.push({ e: p.ems, x: t[i] + tf, ret: (xpx - p.epx) / p.epx, vs: p.vs, sleeve: sleeveName });
      else np.push(p);
    }
    pos = np;
    if (pos.length >= cfg.maxpos || i - last < cfg.cool) continue;
    const a = adx[i], pp = pdi[i], mm = mdi[i], r = R[i], e2 = e200[i], at = A[i];
    if ([a, pp, mm, r, e2, at].some(v => v === null || v === undefined)) continue;
    const fr = fundAt(t[i]), price = c[i], e2d = e200dAt(dailyP, t[i]);
    if (e2d === null) continue;
    if (fr >= CHAMPION.fundingMax || r >= CHAMPION.rsiMax || price <= e2) continue;
    if (!(a > cfg.adx && pp > mm * cfg.diR)) continue;
    let ok;
    if (eth) { const ratio = price / e2d; ok = ratio >= cfg.bandLo && ratio <= cfg.bandHi; }
    else ok = price >= e2d * cfg.bg;
    if (!ok) continue;
    if (gate4h) {
      // BTC1h gate: 4h trend at t[i]
      let lo = 0, hi = gate4h.t.length - 1, j = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (gate4h.t[m] <= t[i]) { j = m; lo = m + 1; } else hi = m - 1; }
      if (j < 0 || gate4h.adx[j] === null) continue;
      if (!(gate4h.adx[j] > 18 && gate4h.pdi[j] > gate4h.mdi[j] * 0.95 && gate4h.c[j] > gate4h.e200[j])) continue;
    }
    const vs = volScale(A, i);
    pos.push({ ei: i, epx: price, sl: price - cfg.slAtr * at, tp: price + cfg.tpAtr * at, vs, ems: t[i] });
    last = i;
  }
  return out;
}

const tr4 = gen(P4, btcD, CHAMPION.btc4h, { exitEmaBars: 10 }, "BTC4h");
const tr1 = gen(P1, btcD, CHAMPION.btc1h, { tf: H1, exitEmaBars: 4, gate4h: P4 }, "BTC1h");
const tre = gen(PE, ethD, CHAMPION.eth4h, { eth: true }, "ETH4h");

// Equity-fraction sizing loop (faithful to honest_eval)
const CAPITAL = 100000, LEV = CHAMPION.lev, RISK = CHAMPION.risk, CAP = CHAMPION.cap;
const all = [...tr4, ...tr1, ...tre].sort((a, b) => a.e - b.e);
// event timeline: open at e, close at x
const events = [];
for (const tr of all) { events.push({ ms: tr.e, type: "open", tr }); events.push({ ms: tr.x, type: "close", tr }); }
events.sort((a, b) => a.ms - b.ms || (a.type === "close" ? -1 : 1));
let equity = CAPITAL, marginUsed = 0, peak = CAPITAL, maxdd = 0, taken = 0;
const openMap = new Map();
const yrPnl = {}, yrN = {};
for (const ev of events) {
  if (ev.type === "close") {
    const o = openMap.get(ev.tr); if (!o) continue;
    const pnl = ev.tr.ret * o.margin * LEV - 0.0006 * o.margin;
    equity += pnl; marginUsed -= o.margin; openMap.delete(ev.tr);
    const yr = new Date(ev.tr.e).getUTCFullYear(); yrPnl[yr] = (yrPnl[yr] || 0) + pnl;
  } else {
    if (equity > peak) peak = equity; const dd = (peak - equity) / peak * 100; if (dd > maxdd) maxdd = dd;
    const margin = RISK * equity * ev.tr.vs;
    if (margin > 0 && marginUsed + margin <= CAP * equity) { marginUsed += margin; openMap.set(ev.tr, { margin }); taken++; const yr = new Date(ev.tr.e).getUTCFullYear(); yrN[yr] = (yrN[yr] || 0) + 1; }
  }
}
const t0 = all[0].e, t1 = all[all.length - 1].x; const yspan = (t1 - t0) / (365.25 * 24 * 3600e3);
const cagr = (Math.pow(equity / CAPITAL, 1 / yspan) - 1) * 100;

console.log("=== TS PORT PARITY (champion.js helpers) ===");
console.log(`sleeves: BTC4h=${tr4.length} BTC1h=${tr1.length} ETH4h=${tre.length}  total=${all.length}  taken=${taken}`);
console.log(`Final equity: $${equity.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
console.log(`CAGR: ${cagr.toFixed(1)}%   MaxDD: ${maxdd.toFixed(1)}%   min_n/yr: ${Math.min(...Object.values(yrN))}`);
console.log("per-year taken:", Object.fromEntries(Object.entries(yrN).sort()));
console.log("\n=== Python champion #1 target: CAGR 129.6% (idx4) / 146% (hof) · DD ~23% · n381-387 ===");
