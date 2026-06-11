/**
 * champion-live-faithful-7y.mjs — CHAMPION BEST book LIVE v0.4.105 faithful.
 * Sleeves = BTC4h + ETH4h (NO BTC1h). TP override = 16×ATR (cả 2 sleeve). risk weight = 1.25.
 * ETH sleeve: band ratio=price/EMA200d(ETH) ∈ [0.85,1.10] + ADX>18 + DI+>DI-×1.3 + price>EMA200(4h ETH).
 * Funding/RSI filter OFF (engine). Sizing: fixed / eqfrac / eqvol(volScale) × weight 1.25. fee 0.04%/side.
 */
import { readFileSync } from "fs";
import { ema, rsi, atr, adxDi, volScale, CHAMPION } from "/Users/lap16116/BTC_PC/btc-trader-server/dist/engine/champion.js";

const C = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/";
const TP_OVERRIDE = 16, WEIGHT = 1.25, FEE = 0.0004;
const H4 = 4 * 3600e3, H1D = 24 * 3600e3;

const load = f => JSON.parse(readFileSync(C + f)).sort((a, b) => a.time - b.time);
const rawBtc = load("binance-5m-7y.json");
const rawEth = load("binance-eth-5m-7y.json");

const build = (raw, ms) => { const b = new Map(); for (const c of raw) { const k = Math.floor(c.time / ms); const o = b.get(k); if (!o) b.set(k, { time: k * ms, open: c.open, close: c.close, high: c.high, low: c.low }); else { o.high = Math.max(o.high, c.high); o.low = Math.min(o.low, c.low); o.close = c.close; } } return [...b.keys()].sort((a, b) => a - b).map(k => b.get(k)); };

const prep = bars => { const c = bars.map(b => b.close); return { bars, c, h: bars.map(b => b.high), l: bars.map(b => b.low), t: bars.map(b => b.time), e200: ema(c, 200), e20: ema(c, 20), rsi: rsi(c, 14), atr: atr(bars, 14), ...adxDi(bars, 14) }; };

// daily EMA200 lookup builder per asset
function dailyE200(raw) {
  const b1d = build(raw, H1D); const cd = b1d.map(b => b.close); const e = ema(cd, 200); const t = b1d.map(b => b.time);
  return time => { let lo = 0, hi = t.length - 1, idx = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (t[m] <= time) { idx = m; lo = m + 1; } else hi = m - 1; } return idx >= 0 ? e[idx] : null; };
}
const btcE200d = dailyE200(rawBtc), ethE200d = dailyE200(rawEth);

const P4btc = prep(build(rawBtc, H4));
const P4eth = prep(build(rawEth, H4));

// Generic champion gen. bandMode: 'above' (BTC: price>=e2d*bg) | 'band' (ETH: ratio in [lo,hi])
function gen(P, cfg, e200dAt, sleeve, bandMode) {
  const { c, h, l, t, e200, e20, rsi: R, atr: A, adx, pdi, mdi } = P;
  const exitEmaBars = 10; // both are 4h sleeves
  let pos = [], out = [], last = -999;
  for (let i = 200; i < c.length - cfg.hold - 1; i++) {
    const np = [];
    for (const p of pos) {
      let xpx = c[i], done = false, reason = "";
      if (l[i] <= p.sl) { xpx = p.sl; done = true; reason = "SL"; }
      else if (h[i] >= p.tp) { xpx = p.tp; done = true; reason = "TP"; }
      else if (e20[i] !== null && c[i] < e20[i] && i - p.ei >= exitEmaBars) { done = true; reason = "EMA20"; }
      else if (i - p.ei >= cfg.hold) { done = true; reason = "HOLD"; }
      if (done) out.push({ sleeve, eTime: p.ems, ePrice: p.epx, xTime: t[i], xPrice: xpx, vs: p.vs, reason, holdBars: i - p.ei, year: new Date(p.ems).getUTCFullYear() });
      else np.push(p);
    }
    pos = np;
    if (pos.length >= cfg.maxpos || i - last < cfg.cool) continue;
    const a = adx[i], pp = pdi[i], mm = mdi[i], r = R[i], e2 = e200[i], at = A[i];
    if ([a, pp, mm, r, e2, at].some(v => v === null || v === undefined)) continue;
    const price = c[i], e2d = e200dAt(t[i]);
    if (e2d === null) continue;
    if (r >= CHAMPION.rsiMax || price <= e2) continue;                 // funding OFF; price>EMA200(TF)
    if (!(a > cfg.adx && pp > mm * cfg.diR)) continue;
    if (bandMode === "band") { const ratio = price / e2d; if (!(ratio >= cfg.bandLo && ratio <= cfg.bandHi)) continue; }
    else { if (price < e2d * cfg.bg) continue; }
    pos.push({ ei: i, epx: price, sl: price - cfg.slAtr * at, tp: price + TP_OVERRIDE * at, ems: t[i], vs: volScale(A, i) });
    last = i;
  }
  return out;
}

const tr4 = gen(P4btc, CHAMPION.btc4h, btcE200d, "BTC4h", "above");
const trE = gen(P4eth, CHAMPION.eth4h, ethE200d, "ETH4h", "band");
const trades = [...tr4, ...trE].sort((a, b) => a.eTime - b.eTime);

function simulate(mode) {
  let equity = 100000, openMargin = 0;
  const open = []; const events = [];
  for (const tr of trades) { events.push({ type: "E", t: tr.eTime, tr }); events.push({ type: "X", t: tr.xTime, tr }); }
  events.sort((e1, e2) => e1.t - e2.t || (e1.type === "X" ? -1 : 1));
  const eqPts = []; const yr = {}; let ruined = false;
  for (const ev of events) {
    if (ruined) break;
    if (ev.type === "X") {
      const idx = open.findIndex(o => o.tr === ev.tr); if (idx < 0) continue;
      const o = open[idx]; open.splice(idx, 1); openMargin -= o.margin;
      const gross = o.qty * (ev.tr.xPrice - o.ePrice); const feeOut = o.qty * ev.tr.xPrice * FEE;
      equity += gross - feeOut;
      const y = new Date(ev.tr.xTime).getUTCFullYear(); (yr[y] ??= { n: 0, pnl: 0, w: 0 });
      const net = gross - feeOut - o.feeIn; yr[y].n++; yr[y].pnl += net; if (net > 0) yr[y].w++;
      eqPts.push(equity); if (equity <= 0) ruined = true;
    } else {
      const tr = ev.tr; let margin;
      if (mode === "fixed") { const qty = 0.001 * WEIGHT; const feeIn = qty * tr.ePrice * FEE; equity -= feeIn; open.push({ tr, margin: 0, qty, ePrice: tr.ePrice, feeIn }); continue; }
      else if (mode === "eqfrac") margin = CHAMPION.risk * equity * WEIGHT;
      else margin = CHAMPION.risk * equity * tr.vs * WEIGHT;
      const room = CHAMPION.cap * equity - openMargin; if (room <= 0) continue;
      margin = Math.min(margin, room);
      const qty = margin * CHAMPION.lev / tr.ePrice; const feeIn = qty * tr.ePrice * FEE; equity -= feeIn;
      openMargin += margin; open.push({ tr, margin, qty, ePrice: tr.ePrice, feeIn });
    }
  }
  let peak = 100000, maxDD = 0; for (const e of eqPts) { if (e > peak) peak = e; const dd = (peak - e) / peak; if (dd > maxDD) maxDD = dd; }
  const years = trades.length ? (trades[trades.length - 1].xTime - trades[0].eTime) / (365.25 * 24 * 3600e3) : 1;
  const cagr = ruined ? -1 : Math.pow(equity / 100000, 1 / years) - 1;
  return { mode, finalEq: equity, ret: equity / 100000 - 1, maxDD, calmar: maxDD > 0 ? cagr / maxDD : Infinity, cagr, ruined, yr };
}

const res = ["fixed", "eqfrac", "eqvol"].map(simulate);
console.log(`=== CHAMPION BEST book LIVE faithful 7y (BTC4h+ETH4h, TP16, w1.25, no BTC1h) ===`);
console.log(`n trades=${trades.length} (BTC4h ${tr4.length} + ETH4h ${trE.length})  start $100k  fee ${FEE * 2 * 100}% round-trip\n`);
console.log("mode        | finalEq      | totRet%  | CAGR%  | maxDD% | Calmar | ruined");
for (const r of res) console.log(`${r.mode.padEnd(11)} | $${r.finalEq.toFixed(0).padStart(11)} | ${(r.ret * 100).toFixed(0).padStart(7)} | ${(r.cagr * 100).toFixed(0).padStart(5)} | ${(r.maxDD * 100).toFixed(1).padStart(5)} | ${(r.calmar).toFixed(2).padStart(6)} | ${r.ruined}`);

console.log("\n--- PER YEAR (year | n | WR% | fixed$ | eqfrac$ | eqvol$) ---");
const allYrs = [...new Set(res.flatMap(r => Object.keys(r.yr)))].sort();
for (const y of allYrs) {
  const o0 = res[0].yr[y]; const wr = o0 ? (100 * o0.w / o0.n).toFixed(0) : "0";
  const cells = res.map(r => { const o = r.yr[y]; return o ? `${o.pnl >= 0 ? "+" : ""}${o.pnl.toFixed(0)}` : "—"; });
  console.log(`  ${y} | n=${String(o0 ? o0.n : 0).padStart(3)} | ${wr.padStart(3)}% | ${cells[0].padStart(8)} | ${cells[1].padStart(11)} | ${cells[2].padStart(11)}`);
}

// per-sleeve raw stats (gross, no compounding) for honest split
console.log("\n--- PER SLEEVE (raw, qty=1 normalized return%) ---");
for (const [name, list] of [["BTC4h", tr4], ["ETH4h", trE]]) {
  const rets = list.map(t => (t.xPrice - t.ePrice) / t.ePrice * 100);
  const w = rets.filter(x => x > 0).length;
  const byYr = {}; list.forEach((t, k) => { (byYr[t.year] ??= 0); byYr[t.year] += rets[k]; });
  const stab = Object.values(byYr).filter(v => v > 0).length;
  console.log(`  ${name}: n=${list.length} WR=${(100 * w / list.length).toFixed(0)}% ΣRet=${rets.reduce((a, b) => a + b, 0).toFixed(0)}% stab=${stab}/${Object.keys(byYr).length}`);
  console.log(`     per-year ΣRet%: ${Object.keys(byYr).sort().map(y => `${y}:${byYr[y] >= 0 ? "+" : ""}${byYr[y].toFixed(0)}`).join(" ")}`);
}
