/**
 * champion-capital-payoff-7y.mjs — CAPITAL PAYOFF CURVE for the volScale sizing lever.
 *
 * Faithful to LIVE championEngine.ts:394-420 sizing:
 *   championEquity = E (compounding pool; sub-account frac=1.0, shared frac=0.40)
 *   margin    = CHAMPION.risk(0.04) × E × volScale         [sizeQty]
 *   if margin<=0 || marginUsed+margin > cap(1.0)×E → qty_raw=0
 *   qty_raw   = margin × lev(10) / price
 *   weighted  = qty_raw × RISK_WEIGHT(1.25)
 *   floored   = floor(weighted × step)/step  (step 1000 BTC / 100 ETH)
 *   floored>=minQty ? qty=floored (eqfrac-vol) : qty=minQty (degraded-min)
 *   cap: marginUsed + qty×price/lev > E → SKIP_CAP
 *   fee 0.04%/side. Compound champion realized PnL into E.
 *
 * Answers: at what equity does volScale start expressing (degraded→eqfrac-vol)?
 *          Calmar/DD/CAGR/%mode at each equity level. Judge in DOLLARS + Calmar.
 */
import { readFileSync } from "fs";
import { ema, rsi, atr, adxDi, volScale, CHAMPION } from "/Users/lap16116/BTC_PC/btc-trader-server/dist/engine/champion.js";

const C = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/";
const TP_OVERRIDE = 16, WEIGHT = 1.25, FEE = 0.0004, LEV = 10, RISK = 0.04, CAP = 1.0;
const H4 = 4 * 3600e3, H1D = 24 * 3600e3;
const load = f => JSON.parse(readFileSync(C + f)).sort((a, b) => a.time - b.time);
const rawBtc = load("binance-5m-7y.json"), rawEth = load("binance-eth-5m-7y.json");
const build = (raw, ms) => { const b = new Map(); for (const c of raw) { const k = Math.floor(c.time / ms); const o = b.get(k); if (!o) b.set(k, { time: k * ms, open: c.open, close: c.close, high: c.high, low: c.low }); else { o.high = Math.max(o.high, c.high); o.low = Math.min(o.low, c.low); o.close = c.close; } } return [...b.keys()].sort((a, b) => a - b).map(k => b.get(k)); };
const prep = bars => { const c = bars.map(b => b.close); return { bars, c, h: bars.map(b => b.high), l: bars.map(b => b.low), t: bars.map(b => b.time), e200: ema(c, 200), e20: ema(c, 20), rsi: rsi(c, 14), atr: atr(bars, 14), ...adxDi(bars, 14) }; };
function dailyE200(raw) { const b1d = build(raw, H1D); const cd = b1d.map(b => b.close); const e = ema(cd, 200); const t = b1d.map(b => b.time); return time => { let lo = 0, hi = t.length - 1, idx = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (t[m] <= time) { idx = m; lo = m + 1; } else hi = m - 1; } return idx >= 0 ? e[idx] : null; }; }
const btcE200d = dailyE200(rawBtc), ethE200d = dailyE200(rawEth);
const P4btc = prep(build(rawBtc, H4)), P4eth = prep(build(rawEth, H4));

function gen(P, cfg, e200dAt, sleeve, bandMode) {
  const { c, h, l, t, e200, e20, rsi: R, atr: A, adx, pdi, mdi } = P;
  const exitEmaBars = 10; let pos = [], out = [], last = -999;
  for (let i = 200; i < c.length - cfg.hold - 1; i++) {
    const np = [];
    for (const p of pos) {
      let xpx = c[i], done = false, reason = "";
      if (l[i] <= p.sl) { xpx = p.sl; done = true; reason = "SL"; }
      else if (h[i] >= p.tp) { xpx = p.tp; done = true; reason = "TP"; }
      else if (e20[i] !== null && c[i] < e20[i] && i - p.ei >= exitEmaBars) { done = true; reason = "EMA20"; }
      else if (i - p.ei >= cfg.hold) { done = true; reason = "HOLD"; }
      if (done) out.push({ sleeve, eTime: p.ems, ePrice: p.epx, xTime: t[i], xPrice: xpx, vs: p.vs, reason });
      else np.push(p);
    }
    pos = np;
    if (pos.length >= cfg.maxpos || i - last < cfg.cool) continue;
    const a = adx[i], pp = pdi[i], mm = mdi[i], r = R[i], e2 = e200[i], at = A[i];
    if ([a, pp, mm, r, e2, at].some(v => v === null || v === undefined)) continue;
    const price = c[i], e2d = e200dAt(t[i]); if (e2d === null) continue;
    if (r >= CHAMPION.rsiMax || price <= e2) continue;
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

// Faithful sizing sim. trades = list; E0 = starting champion equity. Compounds champion PnL.
function simulate(trades, E0) {
  let equity = E0;
  const open = []; const events = [];
  for (const tr of trades) { events.push({ type: "E", t: tr.eTime, tr }); events.push({ type: "X", t: tr.xTime, tr }); }
  events.sort((e1, e2) => e1.t - e2.t || (e1.type === "X" ? -1 : 1));
  const eqPts = [E0]; let ruined = false, openMargin = 0;
  let nEq = 0, nDeg = 0, nSkipCap = 0, nFilled = 0;
  const yr = {};
  for (const ev of events) {
    if (ruined) break;
    if (ev.type === "X") {
      const idx = open.findIndex(o => o.tr === ev.tr); if (idx < 0) continue;
      const o = open[idx]; open.splice(idx, 1); openMargin -= o.margin;
      const gross = o.qty * (ev.tr.xPrice - o.ePrice); const feeOut = o.qty * ev.tr.xPrice * FEE;
      const net = gross - feeOut - o.feeIn; equity += gross - feeOut;
      const y = new Date(ev.tr.xTime).getUTCFullYear(); (yr[y] ??= { n: 0, pnl: 0 }); yr[y].n++; yr[y].pnl += net;
      eqPts.push(equity); if (equity <= 0) { ruined = true; }
    } else {
      const tr = ev.tr, price = tr.ePrice, vs = tr.vs;
      // sizeQty (faithful)
      let mEq = RISK * equity * vs;
      let qtyRaw;
      if (mEq <= 0 || openMargin + mEq > CAP * equity) qtyRaw = 0;
      else qtyRaw = (mEq * LEV) / price;
      const weighted = qtyRaw * WEIGHT;
      const step = tr.sleeve === "ETH4h" ? 100 : 1000;
      const minQty = tr.sleeve === "ETH4h" ? 0.01 : 0.001;
      const floored = Math.floor(weighted * step) / step;
      let qty, margin, mode;
      if (floored >= minQty) { qty = floored; margin = qty * price / LEV; mode = "eq"; }
      else { qty = minQty; margin = qty * price / LEV; mode = "deg"; }
      if (openMargin + margin > CAP * equity) { nSkipCap++; continue; } // SKIP_CAP
      const feeIn = qty * price * FEE; equity -= feeIn; openMargin += margin;
      open.push({ tr, margin, qty, ePrice: price, feeIn });
      if (mode === "eq") nEq++; else nDeg++; nFilled++;
    }
  }
  let peak = E0, maxDD = 0; for (const e of eqPts) { if (e > peak) peak = e; const dd = (peak - e) / peak; if (dd > maxDD) maxDD = dd; }
  const span = (trades[trades.length - 1].xTime - trades[0].eTime) / (365.25 * 24 * 3600e3);
  const cagr = ruined ? -1 : Math.pow(Math.max(equity, 1e-9) / E0, 1 / span) - 1;
  return { E0, finalEq: equity, ret: equity / E0 - 1, cagr, maxDD, calmar: maxDD > 0 ? cagr / maxDD : Infinity, ruined, nFilled, nEq, nDeg, nSkipCap, pctEq: nFilled ? 100 * nEq / nFilled : 0, yr };
}

const priceBtcNow = P4btc.c[P4btc.c.length - 1];   // current BTC price (last 4h close in data)
const priceEthNow = P4eth.c[P4eth.c.length - 1];
const tr2026btc = tr4.filter(t => new Date(t.eTime).getUTCFullYear() === 2026);
const tr2026all = [...tr4, ...trE].filter(t => new Date(t.eTime).getUTCFullYear() === 2026).sort((a, b) => a.eTime - b.eTime);
const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const vsMed2026 = med(tr2026btc.map(t => t.vs));

// ── SECTION 1: NGƯỠNG express TẠI GIÁ HIỆN TẠI ─────────────────────────────
// eqfrac-vol khi: 0.5 × E × volScale / price ≥ 0.001  →  E × volScale ≥ 0.002 × price
//   needed_vs = 0.002 × price / E   (express được nếu needed_vs ≤ volScale thực, cap 1.0)
console.log("=== [1] NGƯỠNG volScale EXPRESS TẠI GIÁ HIỆN TẠI ===");
console.log(`BTC price=$${priceBtcNow.toFixed(0)}  volScale median(2026)=${vsMed2026.toFixed(2)}  (volScale∈[0.3,1.0])`);
console.log(`Điều kiện: champEquity × volScale ≥ 0.002 × price = $${(0.002 * priceBtcNow).toFixed(0)}\n`);
console.log("champEq$ | walletShared$ | walletSub$ | vs cần (≤1.0?) | express khi vs=1.0(calm)? | express khi vs=med? ");
for (const E of [70, 100, 130, 160, 200, 260, 300, 400, 500, 650, 1000]) {
  const needed = 0.002 * priceBtcNow / E;
  const calm = needed <= 1.0 ? "✅ CÓ" : "❌ KHÔNG (cần vs>1)";
  const atMed = needed <= vsMed2026 ? "✅ CÓ" : "❌ KHÔNG";
  console.log(`${String(E).padStart(8)} | ${String(Math.round(E / 0.40)).padStart(13)} | ${String(E).padStart(10)} | ${needed.toFixed(2).padStart(13)} | ${calm.padStart(24)} | ${atMed.padStart(11)}`);
}
console.log(`\n→ Ví HIỆN TẠI $176 shared → champEq=$70 → cần vs=${(0.002 * priceBtcNow / 70).toFixed(2)} (>1.0 BẤT KHẢ) → 100% DEGRADED.`);
console.log(`→ Để express lúc CALM (vs=1.0): champEq ≥ $${(0.002 * priceBtcNow).toFixed(0)} = ví shared $${Math.round(0.002 * priceBtcNow / 0.40)} HOẶC sub-account $${(0.002 * priceBtcNow).toFixed(0)}.`);
console.log(`→ Để express ở vol TRUNG BÌNH (vs=${vsMed2026.toFixed(2)}): champEq ≥ $${(0.002 * priceBtcNow / vsMed2026).toFixed(0)} = ví shared $${Math.round(0.002 * priceBtcNow / vsMed2026 / 0.40)} HOẶC sub $${(0.002 * priceBtcNow / vsMed2026).toFixed(0)}.`);

// ── SECTION 2: SIM CHỈ 2026 (regime giá cao = thực tế bây giờ) ──────────────
console.log("\n\n=== [2] SIM CHỈ 2026 (giá cao = thực tế HÔM NAY) — degraded vs eqfrac + DD oversizing ===");
for (const [name, trades] of [["BTC4h only (REAL)", tr2026btc], ["BTC4h+ETH4h (BEST book)", tr2026all]]) {
  console.log(`\n--- ${name} (n=${trades.length}, 2026) ---`);
  console.log("champEq$ | walletShared$ | finalEq$ | ret% | maxDD% | n | %eqfrac-vol | degraded | skipCap");
  for (const E0 of [70, 130, 200, 300, 500, 1000, 2000]) {
    const r = simulate(trades, E0);
    console.log(`${String(E0).padStart(8)} | ${String(Math.round(E0 / 0.40)).padStart(13)} | ${r.finalEq.toFixed(0).padStart(8)} | ${(r.ret * 100).toFixed(1).padStart(6)} | ${(r.maxDD * 100).toFixed(1).padStart(6)} | ${String(r.nFilled).padStart(3)} | ${r.pctEq.toFixed(0).padStart(11)} | ${String(r.nDeg).padStart(8)} | ${String(r.nSkipCap).padStart(7)}`);
  }
}

// ── SECTION 3: FULL-CYCLE 7y (tham chiếu — chứng minh lever payoff cả chu kỳ nếu start sớm) ──
console.log("\n\n=== [3] FULL-CYCLE 7y (tham chiếu, start từ 2019 giá thấp → 100% express + compound) ===");
for (const [name, trades] of [["BTC4h only", tr4], ["BTC4h+ETH4h", [...tr4, ...trE].sort((a, b) => a.eTime - b.eTime)]]) {
  console.log(`\n--- ${name} (n=${trades.length}, 7y) ---`);
  console.log("champEq0$ | finalEq$ | CAGR% | maxDD% | Calmar | %eqfrac-vol | ruin");
  for (const E0 of [70, 200, 1000]) {
    const r = simulate(trades, E0);
    console.log(`${String(E0).padStart(9)} | ${r.finalEq.toFixed(0).padStart(8)} | ${(r.cagr * 100).toFixed(0).padStart(5)} | ${(r.maxDD * 100).toFixed(1).padStart(6)} | ${r.calmar.toFixed(2).padStart(6)} | ${r.pctEq.toFixed(0).padStart(11)} | ${r.ruined ? "YES" : "no"}`);
  }
}
