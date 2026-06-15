/**
 * champion-loss-deepdive-7y.mjs — soi lệnh thua champion 4 góc:
 *  A) sweep slAtr (SL chặt/rộng) → N+ROI+DD+Calmar (eqvol sizing, $100k)
 *  B) sweep EMA20-exit (default / disabled / wider) → có cắt non winner không
 *  C) per-sleeve BTC1h vs BTC4h riêng → ROI/DD/N/Calmar
 *  D) whipsaw: trong các SL exit, bao nhiêu % giá quay lại vượt entry trong K bar sau (SL đánh non)
 * Faithful champion BTC4h+BTC1h, skip-BEAR OFF (live). Judge dollars/Calmar, không đẽo 1 số.
 */
import { readFileSync } from "fs";
import { ema, rsi, atr, adxDi, atrPctile, volScale, CHAMPION } from "/Users/lap16116/BTC_PC/btc-trader-server/dist/engine/champion.js";

const C = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/";
const rawBtc = JSON.parse(readFileSync(C + "binance-5m-7y.json")).sort((a, b) => a.time - b.time);
const rf = JSON.parse(readFileSync(C + "binance-funding-7y.json"));
const fk = Object.keys(rf[0]).find(k => k.toLowerCase().includes("time"));
const rk = ["fundingRate", "rate", "r", "funding"].find(k => k in rf[0]);
const fund = rf.map(e => [+e[fk], +e[rk]]).sort((a, b) => a[0] - b[0]); const ftimes = fund.map(x => x[0]);
const fundAt = t => { let lo = 0, hi = ftimes.length - 1, idx = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (ftimes[m] <= t) { idx = m; lo = m + 1; } else hi = m - 1; } return idx >= 0 ? fund[idx][1] : 0; };

const H4 = 4 * 3600e3, H1 = 3600e3, H1D = 24 * 3600e3;
const build = (raw, ms) => { const b = new Map(); for (const c of raw) { const k = Math.floor(c.time / ms); const o = b.get(k); if (!o) b.set(k, { time: k * ms, open: c.open, close: c.close, high: c.high, low: c.low, volume: c.volume }); else { o.high = Math.max(o.high, c.high); o.low = Math.min(o.low, c.low); o.close = c.close; } } return [...b.keys()].sort((a, b) => a - b).map(k => b.get(k)); };
const b4 = build(rawBtc, H4), b1 = build(rawBtc, H1), b1d = build(rawBtc, H1D);
const cd = b1d.map(b => b.close);
const e200dArr = ema(cd, 200);
const e200dAt = t => { let lo = 0, hi = b1d.length - 1, idx = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (b1d[m].time <= t) { idx = m; lo = m + 1; } else hi = m - 1; } return idx >= 0 ? e200dArr[idx] : null; };
const prep = bars => { const c = bars.map(b => b.close); return { bars, c, h: bars.map(b => b.high), l: bars.map(b => b.low), t: bars.map(b => b.time), e200: ema(c, 200), e20: ema(c, 20), rsi: rsi(c, 14), atr: atr(bars, 14), ...adxDi(bars, 14) }; };
const P4 = prep(b4), P1 = prep(b1);

// gen parametrized: slAtrMul override, exitEmaBars (Infinity = disable EMA20 exit)
function gen(P, cfg, { exitEmaBars, gate4h }, sleeve, slAtrOverride) {
  const { c, h, l, t, e200, e20, rsi: R, atr: A, adx, pdi, mdi } = P;
  const slAtr = slAtrOverride ?? cfg.slAtr;
  let pos = [], out = [], last = -999;
  for (let i = 200; i < c.length - cfg.hold - 1; i++) {
    const np = [];
    for (const p of pos) {
      let xpx = c[i], done = false, reason = "";
      if (l[i] <= p.sl) { xpx = p.sl; done = true; reason = "SL"; }
      else if (h[i] >= p.tp) { xpx = p.tp; done = true; reason = "TP"; }
      else if (e20[i] !== null && c[i] < e20[i] && i - p.ei >= exitEmaBars) { done = true; reason = "EMA20"; }
      else if (i - p.ei >= cfg.hold) { done = true; reason = "HOLD"; }
      if (done) out.push({ sleeve, ei: p.ei, eTime: p.ems, ePrice: p.epx, xi: i, xTime: t[i], xPrice: xpx, vs: p.vs, reason });
      else np.push(p);
    }
    pos = np;
    if (pos.length >= cfg.maxpos || i - last < cfg.cool) continue;
    const a = adx[i], pp = pdi[i], mm = mdi[i], r = R[i], e2 = e200[i], at = A[i];
    if ([a, pp, mm, r, e2, at].some(v => v === null || v === undefined)) continue;
    const fr = fundAt(t[i]), price = c[i], e2d = e200dAt(t[i]);
    if (e2d === null) continue;
    if (fr >= CHAMPION.fundingMax || r >= CHAMPION.rsiMax || price <= e2) continue;
    if (!(a > cfg.adx && pp > mm * cfg.diR)) continue;
    if (price < e2d * cfg.bg) continue;
    if (gate4h) { let lo = 0, hi = gate4h.t.length - 1, j = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (gate4h.t[m] <= t[i]) { j = m; lo = m + 1; } else hi = m - 1; } if (j < 0 || gate4h.adx[j] === null) continue; if (!(gate4h.adx[j] > 18 && gate4h.pdi[j] > gate4h.mdi[j] * 0.95 && gate4h.c[j] > gate4h.e200[j])) continue; }
    pos.push({ ei: i, epx: price, sl: price - slAtr * at, tp: price + cfg.tpAtr * at, ems: t[i], vs: volScale(A, i) });
    last = i;
  }
  return out;
}

const FEE = 0.0004;
function simulate(trades) { // eqvol sizing, $100k
  let equity = 100000, openMargin = 0; const open = [];
  const events = [];
  for (const tr of trades) { events.push({ type: "E", t: tr.eTime, tr }); events.push({ type: "X", t: tr.xTime, tr }); }
  events.sort((e1, e2) => e1.t - e2.t || (e1.type === "X" ? -1 : 1));
  const eqPts = [];
  for (const ev of events) {
    if (ev.type === "X") {
      const idx = open.findIndex(o => o.tr === ev.tr); if (idx < 0) continue;
      const o = open[idx]; open.splice(idx, 1); openMargin -= o.margin;
      equity += o.qty * (ev.tr.xPrice - o.ePrice) - o.qty * ev.tr.xPrice * FEE; eqPts.push(equity);
    } else {
      let margin = CHAMPION.risk * equity * ev.tr.vs; const room = CHAMPION.cap * equity - openMargin;
      if (room <= 0) continue; margin = Math.min(margin, room);
      const qty = margin * CHAMPION.lev / ev.tr.ePrice; equity -= qty * ev.tr.ePrice * FEE; openMargin += margin;
      open.push({ tr: ev.tr, margin, qty, ePrice: ev.tr.ePrice });
    }
  }
  let peak = 100000, maxDD = 0; for (const e of eqPts) { if (e > peak) peak = e; const dd = (peak - e) / peak; if (dd > maxDD) maxDD = dd; }
  const years = trades.length ? (trades[trades.length - 1].xTime - trades[0].eTime) / (365.25 * 24 * 3600e3) : 1;
  const cagr = Math.pow(Math.max(equity, 1) / 100000, 1 / years) - 1;
  return { n: trades.length, finalEq: equity, ret: equity / 100000 - 1, maxDD, cagr, calmar: maxDD > 0 ? cagr / maxDD : Infinity };
}
const mk = (slMul, exitEma) => [...gen(P4, CHAMPION.btc4h, { exitEmaBars: exitEma ?? 10 }, "BTC4h", slMul), ...gen(P1, CHAMPION.btc1h, { exitEmaBars: exitEma ?? 4, gate4h: P4 }, "BTC1h", slMul)].sort((a, b) => a.eTime - b.eTime);
const row = (label, r) => `${label.padEnd(18)} | ${String(r.n).padStart(5)} | ${(r.ret * 100).toFixed(0).padStart(8)} | ${(r.cagr * 100).toFixed(0).padStart(5)} | ${(r.maxDD * 100).toFixed(1).padStart(5)} | ${r.calmar.toFixed(2).padStart(6)}`;

console.log("=== A) SWEEP slAtr (eqvol $100k, EMA20-exit default) ===");
console.log("slAtr              |     N | totRet%  | CAGR | maxDD | Calmar");
for (const sl of [1.2, 1.6, 2.0, 2.5, 3.0]) console.log(row(`slAtr=${sl}${sl === CHAMPION.btc4h.slAtr ? " (live4h)" : ""}`, simulate(mk(sl, null))));

console.log("\n=== B) SWEEP EMA20-exit (slAtr live) ===");
console.log("EMA20-exit         |     N | totRet%  | CAGR | maxDD | Calmar");
const mkEma = (e4, e1) => [...gen(P4, CHAMPION.btc4h, { exitEmaBars: e4 }, "BTC4h"), ...gen(P1, CHAMPION.btc1h, { exitEmaBars: e1, gate4h: P4 }, "BTC1h")].sort((a, b) => a.eTime - b.eTime);
console.log(row("default(10/4)", simulate(mkEma(10, 4))));
console.log(row("wider(30/12)", simulate(mkEma(30, 12))));
console.log(row("DISABLED", simulate(mkEma(1e9, 1e9))));

console.log("\n=== C) PER-SLEEVE (eqvol $100k, live params) ===");
console.log("sleeve             |     N | totRet%  | CAGR | maxDD | Calmar");
console.log(row("BTC4h only", simulate(gen(P4, CHAMPION.btc4h, { exitEmaBars: 10 }, "BTC4h").sort((a, b) => a.eTime - b.eTime))));
console.log(row("BTC1h only", simulate(gen(P1, CHAMPION.btc1h, { exitEmaBars: 4, gate4h: P4 }, "BTC1h").sort((a, b) => a.eTime - b.eTime))));
console.log(row("BOTH", simulate(mk(null, null))));

console.log("\n=== D) WHIPSAW check (SL losers — giá quay lại vượt entry trong K bar sau SL?) ===");
const base = mk(null, null);
for (const sleeve of ["BTC4h", "BTC1h"]) {
  const P = sleeve === "BTC4h" ? P4 : P1;
  const sls = base.filter(t => t.sleeve === sleeve && t.reason === "SL");
  for (const K of [6, 12, 24]) {
    let recovered = 0;
    for (const t of sls) { const end = Math.min(t.xi + K, P.h.length - 1); let max = -Infinity; for (let j = t.xi + 1; j <= end; j++) max = Math.max(max, P.h[j]); if (max > t.ePrice) recovered++; }
    console.log(`  ${sleeve} SL n=${sls.length}  trong ${String(K).padStart(2)} bar sau: ${(100 * recovered / sls.length).toFixed(0)}% giá vượt lại entry (whipsaw/đánh non)`);
  }
}
