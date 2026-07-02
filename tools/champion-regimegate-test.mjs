/**
 * champion-regimegate-test.mjs — test the Lead-Architect proposal "add regime gate (skip BEAR)" to champion.
 * Faithful to champion-live-faithful (BTC4h+ETH4h, TP16, w1.25, eqvol sizing). Compares:
 *   baseline (no regime gate, = LIVE)  vs  skip-BEAR  vs  RANGE-only.
 * Regime per regime.ts detectRegime on DAILY bars: BEAR if close<SMA200; BULL if close>SMA50>SMA200 & 20d avg(H-L)/C>4%; else RANGE.
 * Judge: Calmar + maxDD + CAGR (eqvol $100k). Prior claim: skip-BEAR HURTS (Calmar 3.09->2.32).
 */
import { readFileSync } from "fs";
import { ema, rsi, atr, adxDi, volScale, CHAMPION } from "/Users/lap16116/BTC_PC/btc-trader-server/dist/engine/champion.js";
const C = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/";
const TP_OVERRIDE = 16, WEIGHT = 1.25, FEE = 0.0004;
const H4 = 4 * 3600e3, H1D = 24 * 3600e3;
const load = f => JSON.parse(readFileSync(C + f)).sort((a, b) => a.time - b.time);
const rawBtc = load("binance-5m-7y.json"), rawEth = load("binance-eth-5m-7y.json");
const build = (raw, ms) => { const b = new Map(); for (const c of raw) { const k = Math.floor(c.time / ms); const o = b.get(k); if (!o) b.set(k, { time: k * ms, open: c.open, close: c.close, high: c.high, low: c.low }); else { o.high = Math.max(o.high, c.high); o.low = Math.min(o.low, c.low); o.close = c.close; } } return [...b.keys()].sort((a, b) => a - b).map(k => b.get(k)); };
const prep = bars => { const c = bars.map(b => b.close); return { bars, c, h: bars.map(b => b.high), l: bars.map(b => b.low), t: bars.map(b => b.time), e200: ema(c, 200), e20: ema(c, 20), rsi: rsi(c, 14), atr: atr(bars, 14), ...adxDi(bars, 14) }; };
function dailyE200(raw) { const b1d = build(raw, H1D); const cd = b1d.map(b => b.close); const e = ema(cd, 200); const t = b1d.map(b => b.time); return time => { let lo = 0, hi = t.length - 1, idx = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (t[m] <= time) { idx = m; lo = m + 1; } else hi = m - 1; } return idx >= 0 ? e[idx] : null; }; }
// daily regime lookup (detectRegime faithful: SMA200/SMA50 + 20d avg range)
function dailyRegime(raw) {
  const b = build(raw, H1D); const cl = b.map(x => x.close); const t = b.map(x => x.time);
  const sma = (arr, i, p) => { if (i < p - 1) return null; let s = 0; for (let k = i - p + 1; k <= i; k++) s += arr[k]; return s / p; };
  const reg = b.map((_, i) => {
    const ma200 = sma(cl, i, 200), ma50 = sma(cl, i, 50); if (ma200 === null || ma50 === null) return "RANGE";
    const close = cl[i];
    if (close < ma200) return "BEAR";
    let ar = 0, n = 0; for (let k = Math.max(0, i - 19); k <= i; k++) { ar += (b[k].high - b[k].low) / b[k].close; n++; } ar /= n;
    if (close > ma50 && ma50 > ma200 && ar > 0.04) return "BULL";
    return "RANGE";
  });
  return time => { let lo = 0, hi = t.length - 1, idx = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (t[m] <= time) { idx = m; lo = m + 1; } else hi = m - 1; } return idx >= 0 ? reg[idx] : "RANGE"; };
}
const btcE200d = dailyE200(rawBtc), ethE200d = dailyE200(rawEth);
const btcReg = dailyRegime(rawBtc), ethReg = dailyRegime(rawEth);
const P4btc = prep(build(rawBtc, H4)), P4eth = prep(build(rawEth, H4));

function gen(P, cfg, e200dAt, regAt, sleeve, bandMode, mode) {
  const { c, h, l, t, e200, e20, rsi: R, atr: A, adx, pdi, mdi } = P;
  let pos = [], out = [], last = -999;
  for (let i = 200; i < c.length - cfg.hold - 1; i++) {
    const np = [];
    for (const p of pos) {
      let xpx = c[i], done = false, reason = "";
      if (l[i] <= p.sl) { xpx = p.sl; done = true; reason = "SL"; }
      else if (h[i] >= p.tp) { xpx = p.tp; done = true; reason = "TP"; }
      else if (e20[i] !== null && c[i] < e20[i] && i - p.ei >= 10) { done = true; reason = "EMA20"; }
      else if (i - p.ei >= cfg.hold) { done = true; reason = "HOLD"; }
      if (done) out.push({ sleeve, eTime: p.ems, ePrice: p.epx, xTime: t[i], xPrice: xpx, vs: p.vs }); else np.push(p);
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
    // ── REGIME GATE (the proposal under test) ──
    const rg = regAt(t[i]);
    if (mode === "skipbear" && rg === "BEAR") continue;
    if (mode === "rangeonly" && rg !== "RANGE") continue;
    pos.push({ ei: i, epx: price, sl: price - cfg.slAtr * at, tp: price + TP_OVERRIDE * at, ems: t[i], vs: volScale(A, i) });
    last = i;
  }
  return out;
}
function simEqvol(trades) {
  let equity = 100000, openMargin = 0; const open = []; const events = [];
  for (const tr of trades) { events.push({ type: "E", t: tr.eTime, tr }); events.push({ type: "X", t: tr.xTime, tr }); }
  events.sort((e1, e2) => e1.t - e2.t || (e1.type === "X" ? -1 : 1));
  const eqPts = []; const yr = {};
  for (const ev of events) {
    if (ev.type === "X") {
      const idx = open.findIndex(o => o.tr === ev.tr); if (idx < 0) continue;
      const o = open[idx]; open.splice(idx, 1); openMargin -= o.margin;
      const gross = o.qty * (ev.tr.xPrice - o.ePrice); equity += gross - o.qty * ev.tr.xPrice * FEE;
      const y = new Date(ev.tr.xTime).getUTCFullYear(); (yr[y] ??= 0); yr[y] += gross - o.qty * ev.tr.xPrice * FEE - o.feeIn;
      eqPts.push(equity);
    } else {
      const tr = ev.tr; let margin = CHAMPION.risk * equity * tr.vs * WEIGHT;
      const room = CHAMPION.cap * equity - openMargin; if (room <= 0) continue; margin = Math.min(margin, room);
      const qty = margin * CHAMPION.lev / tr.ePrice; const feeIn = qty * tr.ePrice * FEE; equity -= feeIn;
      openMargin += margin; open.push({ tr, margin, qty, ePrice: tr.ePrice, feeIn });
    }
  }
  let peak = 100000, maxDD = 0; for (const e of eqPts) { if (e > peak) peak = e; const dd = (peak - e) / peak; if (dd > maxDD) maxDD = dd; }
  const span = (trades[trades.length - 1].xTime - trades[0].eTime) / (365.25 * 24 * 3600e3);
  const cagr = Math.pow(equity / 100000, 1 / span) - 1;
  return { finalEq: equity, cagr, maxDD, calmar: maxDD > 0 ? cagr / maxDD : Infinity, n: trades.length, yr };
}
console.log("=== CHAMPION regime-gate test (BTC4h+ETH4h BEST book, eqvol $100k) — Lead-Architect proposal ===\n");
console.log("mode       | n    | CAGR% | maxDD% | Calmar | 2022$ | 2026$");
for (const mode of ["baseline", "skipbear", "rangeonly"]) {
  const tr4 = gen(P4btc, CHAMPION.btc4h, btcE200d, btcReg, "BTC4h", "above", mode);
  const trE = gen(P4eth, CHAMPION.eth4h, ethE200d, ethReg, "ETH4h", "band", mode);
  const all = [...tr4, ...trE].sort((a, b) => a.eTime - b.eTime);
  const r = simEqvol(all);
  console.log(`${mode.padEnd(10)} | ${String(r.n).padStart(4)} | ${(r.cagr * 100).toFixed(0).padStart(5)} | ${(r.maxDD * 100).toFixed(1).padStart(6)} | ${r.calmar.toFixed(2).padStart(6)} | ${(r.yr[2022] || 0 >= 0 ? "+" : "") + Math.round(r.yr[2022] || 0)} | ${(r.yr[2026] >= 0 ? "+" : "") + Math.round(r.yr[2026] || 0)}`);
}
