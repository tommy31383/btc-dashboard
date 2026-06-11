/**
 * champion-roi-levers-7y.mjs — 3 đòn bẩy ROI cấu trúc (KHÔNG entry):
 *  (A) ALLOCATION: BTC4h-only vs BTC4h+ETH4h — ETH4h add hay drag Calmar?
 *  (B) CAPITAL SWEEP: ROI% theo ví ($113→$100k) với floor min-qty THẬT (0.001 BTC/ETH step) →
 *      ngưỡng nào volScale bắt đầu express (thoát degraded-min).
 *  (C) BUDGET FRAC: champion 40% budget (share-net) vs 100% (sub-account) — đòn bẩy tách vốn.
 * Entry RULES không đổi. Judge $/Calmar/maxDD. Faithful champion BTC4h+ETH4h TP16 w1.25.
 */
import { readFileSync } from "fs";
import { ema, rsi, atr, adxDi, volScale, CHAMPION } from "/Users/lap16116/BTC_PC/btc-trader-server/dist/engine/champion.js";

const C = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/";
const TP_OVERRIDE = 16, WEIGHT = 1.25, FEE = 0.0004, LEV = CHAMPION.lev;
const H4 = 4 * 3600e3, H1D = 24 * 3600e3;
const load = f => JSON.parse(readFileSync(C + f)).sort((a, b) => a.time - b.time);
const build = (raw, ms) => { const b = new Map(); for (const c of raw) { const k = Math.floor(c.time / ms); const o = b.get(k); if (!o) b.set(k, { time: k * ms, open: c.open, close: c.close, high: c.high, low: c.low }); else { o.high = Math.max(o.high, c.high); o.low = Math.min(o.low, c.low); o.close = c.close; } } return [...b.keys()].sort((a, b) => a - b).map(k => b.get(k)); };
const prep = bars => { const c = bars.map(b => b.close); return { bars, c, h: bars.map(b => b.high), l: bars.map(b => b.low), t: bars.map(b => b.time), e200: ema(c, 200), e20: ema(c, 20), rsi: rsi(c, 14), atr: atr(bars, 14), ...adxDi(bars, 14) }; };
function dailyE200(raw) { const b1d = build(raw, H1D); const e = ema(b1d.map(b => b.close), 200); const t = b1d.map(b => b.time); return time => { let lo = 0, hi = t.length - 1, idx = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (t[m] <= time) { idx = m; lo = m + 1; } else hi = m - 1; } return idx >= 0 ? e[idx] : null; }; }

const rawBtc = load("binance-5m-7y.json"), rawEth = load("binance-eth-5m-7y.json");
const btcE200d = dailyE200(rawBtc), ethE200d = dailyE200(rawEth);
const P4btc = prep(build(rawBtc, H4)), P4eth = prep(build(rawEth, H4));

function gen(P, cfg, e200dAt, sleeve, bandMode) {
  const { c, h, l, t, e200, e20, rsi: R, atr: A, adx, pdi, mdi } = P;
  let pos = [], out = [], last = -999;
  for (let i = 200; i < c.length - cfg.hold - 1; i++) {
    const np = [];
    for (const p of pos) {
      let xpx = c[i], done = false;
      if (l[i] <= p.sl) { xpx = p.sl; done = true; }
      else if (h[i] >= p.tp) { xpx = p.tp; done = true; }
      else if (e20[i] !== null && c[i] < e20[i] && i - p.ei >= 10) done = true;
      else if (i - p.ei >= cfg.hold) done = true;
      if (done) out.push({ sleeve, eTime: p.ems, ePrice: p.epx, xTime: t[i], xPrice: xpx, vs: p.vs });
      else np.push(p);
    }
    pos = np;
    if (pos.length >= cfg.maxpos || i - last < cfg.cool) continue;
    const a = adx[i], pp = pdi[i], mm = mdi[i], r = R[i], e2 = e200[i], at = A[i];
    if ([a, pp, mm, r, e2, at].some(v => v == null)) continue;
    const price = c[i], e2d = e200dAt(t[i]); if (e2d == null) continue;
    if (r >= CHAMPION.rsiMax || price <= e2) continue;
    if (!(a > cfg.adx && pp > mm * cfg.diR)) continue;
    if (bandMode === "band") { const ratio = price / e2d; if (!(ratio >= cfg.bandLo && ratio <= cfg.bandHi)) continue; }
    else if (price < e2d * cfg.bg) continue;
    pos.push({ ei: i, epx: price, sl: price - cfg.slAtr * at, tp: price + TP_OVERRIDE * at, ems: t[i], vs: volScale(A, i) });
    last = i;
  }
  return out;
}
const trBtc = gen(P4btc, CHAMPION.btc4h, btcE200d, "BTC4h", "above");
const trEth = gen(P4eth, CHAMPION.eth4h, ethE200d, "ETH4h", "band");

// sim với floor min-qty + budget frac. mode: 'vol'|'frac'|'fixed'
function simulate(trades, start, budgetFrac, mode, applyFloor) {
  let equity = start, openMargin = 0; const open = []; const events = [];
  for (const tr of trades) { events.push({ type: "E", t: tr.eTime, tr }); events.push({ type: "X", t: tr.xTime, tr }); }
  events.sort((e1, e2) => e1.t - e2.t || (e1.type === "X" ? -1 : 1));
  const eqPts = []; let ruined = false, degradedCnt = 0, capSkip = 0, nOpen = 0;
  for (const ev of events) {
    if (ruined) break;
    const champEquity = equity * budgetFrac;
    if (ev.type === "X") {
      const idx = open.findIndex(o => o.tr === ev.tr); if (idx < 0) continue;
      const o = open[idx]; open.splice(idx, 1); openMargin -= o.margin;
      equity += o.qty * (ev.tr.xPrice - o.ePrice) - o.qty * ev.tr.xPrice * FEE;
      eqPts.push(equity); if (equity <= 0) ruined = true;
    } else {
      const tr = ev.tr;
      let margin = mode === "fixed" ? 0 : CHAMPION.risk * champEquity * WEIGHT * (mode === "vol" ? tr.vs : 1);
      const room = CHAMPION.cap * champEquity - openMargin;
      let qty;
      if (mode === "fixed") { qty = 0.001 * WEIGHT; }
      else {
        if (room <= 0) { capSkip++; continue; }
        margin = Math.min(margin, room);
        qty = margin * LEV / tr.ePrice;
      }
      if (applyFloor) {
        const step = 1000; // 0.001 step cả BTC/ETH (qtyDec 3)
        const fl = Math.floor(qty * step) / step;
        if (fl >= 0.001) qty = fl; else { qty = 0.001; degradedCnt++; }
        margin = (qty * tr.ePrice) / LEV;
        if (mode !== "fixed" && openMargin + margin > CHAMPION.cap * champEquity) { capSkip++; continue; }
      }
      equity -= qty * tr.ePrice * FEE; openMargin += margin; nOpen++;
      open.push({ tr, margin, qty, ePrice: tr.ePrice });
    }
  }
  let peak = start, maxDD = 0; for (const e of eqPts) { if (e > peak) peak = e; const dd = (peak - e) / peak; if (dd > maxDD) maxDD = dd; }
  const years = trades.length ? (trades[trades.length - 1].xTime - trades[0].eTime) / (365.25 * 24 * 3600e3) : 1;
  const cagr = ruined ? -1 : Math.pow(equity / start, 1 / years) - 1;
  return { finalEq: equity, ret: equity / start - 1, maxDD, calmar: maxDD > 0 ? cagr / maxDD : Infinity, cagr, ruined, degradedCnt, capSkip, nOpen };
}

const both = [...trBtc, ...trEth].sort((a, b) => a.eTime - b.eTime);
const btcOnly = [...trBtc].sort((a, b) => a.eTime - b.eTime);

// ── (A) ALLOCATION ─────────────────────────────────────────────────────────
console.log("=== (A) ALLOCATION: ETH4h add hay drag? ($100k, volScale, no floor) ===");
console.log(`${'book'.padEnd(16)} | ${'n'.padStart(5)} | ${'finalEq'.padStart(13)} | ${'CAGR%'.padStart(6)} | ${'maxDD%'.padStart(6)} | Calmar`);
for (const [name, tr] of [["BTC4h-only", btcOnly], ["BTC4h+ETH4h", both]]) {
  const r = simulate(tr, 100000, 1.0, "vol", false);
  console.log(`${name.padEnd(16)} | ${String(tr.length).padStart(5)} | $${r.finalEq.toFixed(0).padStart(12)} | ${(r.cagr * 100).toFixed(0).padStart(6)} | ${(r.maxDD * 100).toFixed(1).padStart(6)} | ${r.calmar.toFixed(2)}`);
}

// ── (B) CAPITAL SWEEP (floor min-qty thật) ─────────────────────────────────
console.log("\n=== (B) CAPITAL SWEEP: ROI% theo ví (volScale + floor 0.001 step) — khi nào express? ===");
console.log(`${'wallet$'.padStart(8)} | ${'finalEq'.padStart(13)} | ${'totRet%'.padStart(9)} | ${'CAGR%'.padStart(6)} | ${'maxDD%'.padStart(6)} | ${'degraded'.padStart(8)} | mode`);
for (const W of [113, 200, 405, 700, 1000, 3000, 10000, 100000]) {
  const r = simulate(both, W, 0.40, "vol", true);
  const pctDeg = (100 * r.degradedCnt / both.length).toFixed(0);
  const m = r.degradedCnt > both.length * 0.5 ? "DEGRADED (qty floored→min)" : r.degradedCnt > both.length * 0.1 ? "partial-express" : "FULL volScale express";
  console.log(`${String(W).padStart(8)} | $${r.finalEq.toFixed(0).padStart(12)} | ${(r.ret * 100).toFixed(0).padStart(9)} | ${(r.cagr * 100).toFixed(0).padStart(6)} | ${(r.maxDD * 100).toFixed(1).padStart(6)} | ${(pctDeg + "%").padStart(8)} | ${m}`);
}

// ── (C) BUDGET FRAC (sub-account proxy) ────────────────────────────────────
console.log("\n=== (C) BUDGET FRAC: share-net 40% vs sub-account 100% ($3k ví, volScale+floor) ===");
console.log(`${'budgetFrac'.padStart(10)} | ${'finalEq'.padStart(13)} | ${'CAGR%'.padStart(6)} | ${'maxDD%'.padStart(6)} | ${'Calmar'.padStart(6)} | capSkip`);
for (const bf of [0.40, 0.70, 1.0]) {
  const r = simulate(both, 3000, bf, "vol", true);
  console.log(`${(bf * 100 + "%").padStart(10)} | $${r.finalEq.toFixed(0).padStart(12)} | ${(r.cagr * 100).toFixed(0).padStart(6)} | ${(r.maxDD * 100).toFixed(1).padStart(6)} | ${r.calmar.toFixed(2).padStart(6)} | ${r.capSkip}`);
}
