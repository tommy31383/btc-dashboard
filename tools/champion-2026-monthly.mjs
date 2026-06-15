/**
 * champion-2026-monthly.mjs — 2026 monthly deep-dive of CHAMPION LIVE book.
 * Reuses the exact gen logic of champion-live-faithful-7y.mjs.
 * Splits BTC4h (REAL money) vs ETH4h (now PAPER). Per-month raw return% + WR + exit-reason.
 */
import { readFileSync } from "fs";
import { ema, rsi, atr, adxDi, volScale, CHAMPION } from "/Users/lap16116/BTC_PC/btc-trader-server/dist/engine/champion.js";

const C = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/";
const TP_OVERRIDE = 16, FEE = 0.0004;
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
      if (done) out.push({ sleeve, eTime: p.ems, ePrice: p.epx, xTime: t[i], xPrice: xpx, reason, ret: (xpx - p.epx) / p.epx * 100 });
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
    pos.push({ ei: i, epx: price, sl: price - cfg.slAtr * at, tp: price + TP_OVERRIDE * at, ems: t[i] });
    last = i;
  }
  return out;
}
const tr4 = gen(P4btc, CHAMPION.btc4h, btcE200d, "BTC4h", "above");
const trE = gen(P4eth, CHAMPION.eth4h, ethE200d, "ETH4h", "band");

const ym = ms => { const d = new Date(ms); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };
const in2026 = t => new Date(t.eTime).getUTCFullYear() === 2026;

console.log("=== CHAMPION 2026 DEEP-DIVE (entry year = 2026) ===\n");
for (const [name, list] of [["BTC4h (REAL money)", tr4], ["ETH4h (now PAPER)", trE]]) {
  const tr = list.filter(in2026);
  console.log(`--- ${name} --- n=${tr.length} ${tr.length ? "" : "(no entries in 2026)"}`);
  if (!tr.length) { console.log(); continue; }
  const months = {};
  for (const t of tr) { const k = ym(t.eTime); (months[k] ??= []).push(t); }
  console.log("  month   | n | WR% | ΣnetRet% | reasons");
  let tot = 0, totN = 0, totW = 0;
  for (const k of Object.keys(months).sort()) {
    const m = months[k]; const nets = m.map(t => t.ret - FEE * 200); // ~2 fees in %-of-notional approx
    const s = nets.reduce((a, b) => a + b, 0), w = nets.filter(x => x > 0).length;
    const rc = {}; m.forEach(t => rc[t.reason] = (rc[t.reason] || 0) + 1);
    console.log(`  ${k} | ${String(m.length).padStart(1)} | ${String(Math.round(100 * w / m.length)).padStart(3)} | ${(s >= 0 ? "+" : "") + s.toFixed(1).padStart(7)} | ${Object.entries(rc).map(([r, c]) => `${r}:${c}`).join(" ")}`);
    tot += s; totN += m.length; totW += w;
  }
  console.log(`  TOTAL   | ${totN} | ${Math.round(100 * totW / totN)}% | ${(tot >= 0 ? "+" : "") + tot.toFixed(1)}% (raw, qty=1 normalized)\n`);
}
