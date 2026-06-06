/**
 * champion-live-7y.mjs — Backtest champion ĐÚNG CONFIG LIVE đang deploy:
 *   BTC4h + BTC1h only (ETH bỏ), fixed qty 0.001 BTC/vị thế (degraded min-qty), SKIP-BEAR.
 * Output: per-year + per-month + n lệnh + $ (theo feedback_backtest_report_format).
 */
import { readFileSync } from "fs";
import { ema, rsi, atr, adxDi, CHAMPION } from "/Users/lap16116/BTC_PC/btc-trader-server/dist/engine/champion.js";

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

// daily regime (skip-BEAR) — MA50/MA200/ATR, mirror detectRegime1d
const cd = b1d.map(b => b.close);
function regimeAt(t) {
  let lo = 0, hi = b1d.length - 1, j = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (b1d[m].time <= t) { j = m; lo = m + 1; } else hi = m - 1; }
  if (j < 200) return "RANGE";
  let s200 = 0, s50 = 0; for (let i = j - 199; i <= j; i++) s200 += cd[i]; for (let i = j - 49; i <= j; i++) s50 += cd[i];
  const ma200 = s200 / 200, ma50 = s50 / 50; let ar = 0; for (let i = j - 19; i <= j; i++) ar += (b1d[i].high - b1d[i].low) / b1d[i].close; ar /= 20;
  if (cd[j] < ma200) return "BEAR"; if (cd[j] > ma50 && ma50 > ma200 && ar > 0.04) return "BULL"; return "RANGE";
}
function e200dArr() { const e = ema(cd, 200); return { t: b1d.map(x => x.time), e }; }
const D = e200dArr();
const e200dAt = t => { let lo = 0, hi = D.t.length - 1, idx = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (D.t[m] <= t) { idx = m; lo = m + 1; } else hi = m - 1; } return idx >= 0 ? D.e[idx] : null; };

const prep = bars => { const c = bars.map(b => b.close); return { bars, c, h: bars.map(b => b.high), l: bars.map(b => b.low), t: bars.map(b => b.time), e200: ema(c, 200), e20: ema(c, 20), rsi: rsi(c, 14), atr: atr(bars, 14), ...adxDi(bars, 14) }; };
const P4 = prep(b4), P1 = prep(b1);

const QTY = 0.001; // degraded fixed min-qty (LIVE)
// gen sleeve faithful + skip-BEAR; returns trades [{e,x,pnl}]
function gen(P, cfg, { tf, exitEmaBars, gate4h }, name) {
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
      if (done) out.push({ e: p.ems, x: t[i], pnl: QTY * (xpx - p.epx) });
      else np.push(p);
    }
    pos = np;
    if (pos.length >= cfg.maxpos || i - last < cfg.cool) continue;
    if (process.env.SKIPBEAR !== "0" && regimeAt(t[i]) === "BEAR") continue;  // skip-BEAR toggle
    const a = adx[i], pp = pdi[i], mm = mdi[i], r = R[i], e2 = e200[i], at = A[i];
    if ([a, pp, mm, r, e2, at].some(v => v === null || v === undefined)) continue;
    const fr = fundAt(t[i]), price = c[i], e2d = e200dAt(t[i]);
    if (e2d === null) continue;
    if (fr >= CHAMPION.fundingMax || r >= CHAMPION.rsiMax || price <= e2) continue;
    if (!(a > cfg.adx && pp > mm * cfg.diR)) continue;
    if (price < e2d * cfg.bg) continue;
    if (gate4h) { let lo = 0, hi = gate4h.t.length - 1, j = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (gate4h.t[m] <= t[i]) { j = m; lo = m + 1; } else hi = m - 1; } if (j < 0 || gate4h.adx[j] === null) continue; if (!(gate4h.adx[j] > 18 && gate4h.pdi[j] > gate4h.mdi[j] * 0.95 && gate4h.c[j] > gate4h.e200[j])) continue; }
    pos.push({ ei: i, epx: price, sl: price - cfg.slAtr * at, tp: price + cfg.tpAtr * at, ems: t[i] }); last = i;
  }
  return out;
}
const tr4 = gen(P4, CHAMPION.btc4h, { tf: H4, exitEmaBars: 10 }, "BTC4h");
const tr1 = gen(P1, CHAMPION.btc1h, { tf: H1, exitEmaBars: 4, gate4h: P4 }, "BTC1h");
const all = [...tr4, ...tr1].sort((a, b) => a.e - b.e);

// breakdowns
const ym = {}, yr = {};
for (const tr of all) {
  const d = new Date(tr.x); const y = d.getUTCFullYear(); const m = `${y}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  (yr[y] ??= { n: 0, pnl: 0, w: 0 }); yr[y].n++; yr[y].pnl += tr.pnl; if (tr.pnl > 0) yr[y].w++;
  (ym[m] ??= { n: 0, pnl: 0 }); ym[m].n++; ym[m].pnl += tr.pnl;
}
const tot = all.reduce((a, t) => a + t.pnl, 0); const totW = all.filter(t => t.pnl > 0).length;
console.log("=== CHAMPION LIVE config (BTC4h+BTC1h, qty 0.001, skip-BEAR) — 7y ===");
console.log(`TOTAL: n=${all.length} (BTC4h ${tr4.length} + BTC1h ${tr1.length})  PnL=$${tot.toFixed(2)}  WR=${(100 * totW / all.length).toFixed(0)}%`);
console.log("\n--- PER YEAR ---  year | n | WR% | PnL$");
for (const y of Object.keys(yr).sort()) { const o = yr[y]; console.log(`  ${y} | ${o.n} | ${(100 * o.w / o.n).toFixed(0)}% | ${o.pnl >= 0 ? "+" : ""}${o.pnl.toFixed(2)}`); }
console.log("\n--- PER MONTH ---  month | n | PnL$");
for (const m of Object.keys(ym).sort()) { const o = ym[m]; console.log(`  ${m} | ${o.n} | ${o.pnl >= 0 ? "+" : ""}${o.pnl.toFixed(2)}`); }
