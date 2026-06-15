/**
 * exit-variants-faithful-7y.mjs — Quét EXIT variants cho champion (faithful, giữ ENTRY nguyên).
 *
 * Baseline LIVE: BTC4h tpAtr12/slAtr1.6/hold70 + BTC1h tpAtr8/slAtr2.0/hold24, qty 0.001, skip-BEAR.
 * Exit hiện tại = SL fixed + TP fixed + EMA20-exit + time-exit.
 *
 * Variants (CHỈ đổi exit, entry y nguyên):
 *   - TP multiple sweep
 *   - chandelier trailing (ATR-trail từ high-water) thay EMA-exit
 *   - breakeven move sau X*ATR profit
 *   - partial scale-out 50% @ TP1 rồi trail phần còn lại
 *
 * Judge: tổng$ 7y, MaxDD, Calmar, per-year$, n. Walk-forward (2019-22 tune / 2023-26 test) + robust±1.
 * CẤM bỏ SL.
 */
import { readFileSync } from "fs";
import { ema, rsi, atr, adxDi, CHAMPION } from "/Users/lap16116/BTC_PC/btc-trader-server/dist/engine/champion.js";

const C = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/";
const COIN = process.env.COIN || "BTC"; // BTC | ETH
const rawCoin = JSON.parse(readFileSync(C + (COIN === "ETH" ? "binance-eth-5m-7y.json" : "binance-5m-7y.json"))).sort((a, b) => a.time - b.time);
const rawBtc = COIN === "BTC" ? rawCoin : JSON.parse(readFileSync(C + "binance-5m-7y.json")).sort((a, b) => a.time - b.time);

const H4 = 4 * 3600e3, H1 = 3600e3, H1D = 24 * 3600e3;
const build = (raw, ms) => { const b = new Map(); for (const c of raw) { const k = Math.floor(c.time / ms); const o = b.get(k); if (!o) b.set(k, { time: k * ms, open: c.open, close: c.close, high: c.high, low: c.low, volume: c.volume }); else { o.high = Math.max(o.high, c.high); o.low = Math.min(o.low, c.low); o.close = c.close; } } return [...b.keys()].sort((a, b) => a - b).map(k => b.get(k)); };

// daily regime (skip-BEAR) + EMA200d — dùng BTC daily cho regime nếu COIN=BTC, dùng coin riêng cho ETH
const b1d = build(rawCoin, H1D);
const cd = b1d.map(b => b.close);
function regimeAt(t) {
  let lo = 0, hi = b1d.length - 1, j = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (b1d[m].time <= t) { j = m; lo = m + 1; } else hi = m - 1; }
  if (j < 200) return "RANGE";
  let s200 = 0, s50 = 0; for (let i = j - 199; i <= j; i++) s200 += cd[i]; for (let i = j - 49; i <= j; i++) s50 += cd[i];
  const ma200 = s200 / 200, ma50 = s50 / 50; let ar = 0; for (let i = j - 19; i <= j; i++) ar += (b1d[i].high - b1d[i].low) / b1d[i].close; ar /= 20;
  if (cd[j] < ma200) return "BEAR"; if (cd[j] > ma50 && ma50 > ma200 && ar > 0.04) return "BULL"; return "RANGE";
}
const e200d = ema(cd, 200);
const e200dT = b1d.map(x => x.time);
const e200dAt = t => { let lo = 0, hi = e200dT.length - 1, idx = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (e200dT[m] <= t) { idx = m; lo = m + 1; } else hi = m - 1; } return idx >= 0 ? e200d[idx] : null; };

const prep = bars => { const c = bars.map(b => b.close); return { bars, c, h: bars.map(b => b.high), l: bars.map(b => b.low), t: bars.map(b => b.time), e200: ema(c, 200), e20: ema(c, 20), rsi: rsi(c, 14), atr: atr(bars, 14), ...adxDi(bars, 14) }; };
const P4 = prep(build(rawCoin, H4));
const P1 = prep(build(rawCoin, H1));
const QTY = 0.001;

/**
 * Sinh trades cho 1 sleeve với EXIT cấu hình hóa.
 * exit = { tpAtr, slAtr, hold, mode, trailAtr, beAtr, exitEmaBars, partialFrac }
 *   mode: 'fixed' (baseline EMA+TP+SL), 'chandelier' (ATR-trail high-water, no EMA), 'partial' (scale-out 50% @ tpAtr1 rồi trail)
 */
function gen(P, cfg, opt, exit) {
  const { c, h, l, t, e200, e20, rsi: R, atr: A, adx, pdi, mdi } = P;
  const { tf, gate4h, isEth } = opt;
  let pos = [], out = [], last = -999;
  const maxHold = exit.hold;
  for (let i = 200; i < c.length - 1; i++) {
    const np = [];
    for (const p of pos) {
      const at0 = p.atr0;
      let xpx = null, realized = 0;
      // update high-water
      if (h[i] > p.hw) p.hw = h[i];
      // breakeven move
      if (exit.beAtr && !p.beDone && h[i] >= p.epx + exit.beAtr * at0) { p.sl = Math.max(p.sl, p.epx); p.beDone = true; }
      // chandelier / trailing stop update
      if (exit.mode === "chandelier" || (exit.mode === "partial" && p.scaled)) {
        const trail = p.hw - exit.trailAtr * at0;
        if (trail > p.sl) p.sl = trail;
      }
      // partial TP1 hit (scale out 50%)
      if (exit.mode === "partial" && !p.scaled && h[i] >= p.tp1) {
        realized += p.qty * exit.partialFrac * (p.tp1 - p.epx);
        p.qty *= (1 - exit.partialFrac); p.scaled = true;
        // start trailing from here
        const trail = p.hw - exit.trailAtr * at0; if (trail > p.sl) p.sl = trail;
      }
      // exit checks (SL first = conservative)
      if (l[i] <= p.sl) xpx = p.sl;
      else if (exit.mode === "fixed" && h[i] >= p.tp) xpx = p.tp;
      else if (exit.mode === "partial" && p.scaled === false && h[i] >= p.tpFinal) xpx = p.tpFinal; // safety cap before scale (won't trigger, tp1<tpFinal)
      else if (exit.mode === "fixed" && exit.exitEmaBars && e20[i] !== null && c[i] < e20[i] && i - p.ei >= exit.exitEmaBars) xpx = c[i];
      else if (i - p.ei >= maxHold) xpx = c[i];
      if (xpx !== null) {
        realized += p.qty * (xpx - p.epx);
        out.push({ e: p.ems, x: t[i], pnl: realized });
      } else { p.realizedPartial = (p.realizedPartial || 0) + realized; if (realized) out.push({ e: p.ems, x: t[i], pnl: realized, partial: true }); np.push(p); }
    }
    pos = np;
    if (pos.length >= cfg.maxpos || i - last < cfg.cool) continue;
    if (process.env.SKIPBEAR !== "0" && regimeAt(t[i]) === "BEAR") continue;
    const a = adx[i], pp = pdi[i], mm = mdi[i], r = R[i], e2 = e200[i], at = A[i];
    if ([a, pp, mm, r, e2, at].some(v => v === null || v === undefined)) continue;
    const price = c[i], e2d = e200dAt(t[i]);
    if (e2d === null) continue;
    if (r >= CHAMPION.rsiMax || price <= e2) continue;
    if (!(a > cfg.adx && pp > mm * cfg.diR)) continue;
    if (isEth) { if (!(price >= e2d * cfg.bandLo && price <= e2d * cfg.bandHi)) continue; }
    else { if (price < e2d * cfg.bg) continue; }
    if (gate4h) { let lo = 0, hi = gate4h.t.length - 1, j = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (gate4h.t[m] <= t[i]) { j = m; lo = m + 1; } else hi = m - 1; } if (j < 0 || gate4h.adx[j] === null) continue; if (!(gate4h.adx[j] > 18 && gate4h.pdi[j] > gate4h.mdi[j] * 0.95 && gate4h.c[j] > gate4h.e200[j])) continue; }
    const p = { ei: i, epx: price, atr0: at, hw: price, qty: QTY, ems: t[i], scaled: false, beDone: false,
      sl: price - exit.slAtr * at,
      tp: price + exit.tpAtr * at,
      tp1: price + (exit.tp1Atr || exit.tpAtr) * at,
      tpFinal: price + 999 * at };
    pos.push(p); last = i;
  }
  return out;
}

// ── runner: combine sleeves, compute $/year, MaxDD, Calmar ──────────────
function runConfig(exitBtc4, exitBtc1, exitEth4) {
  let trades;
  if (COIN === "ETH") {
    trades = gen(P4, CHAMPION.eth4h, { tf: H4, isEth: true }, exitEth4);
  } else {
    const tr4 = gen(P4, CHAMPION.btc4h, { tf: H4 }, exitBtc4);
    const tr1 = gen(P1, CHAMPION.btc1h, { tf: H1, gate4h: P4 }, exitBtc1);
    trades = [...tr4, ...tr1];
  }
  trades.sort((a, b) => a.x - b.x);
  // equity curve by exit time → MaxDD on cumulative
  let cum = 0, peak = 0, maxdd = 0;
  const yr = {};
  for (const tr of trades) {
    cum += tr.pnl; if (cum > peak) peak = cum; const dd = peak - cum; if (dd > maxdd) maxdd = dd;
    const y = new Date(tr.x).getUTCFullYear();
    (yr[y] ??= { pnl: 0, n: 0 }); yr[y].pnl += tr.pnl; if (!tr.partial) yr[y].n++;
  }
  const total = cum;
  const n = trades.filter(t => !t.partial).length;
  const calmar = maxdd > 0 ? total / maxdd : Infinity;
  return { total, maxdd, calmar, n, yr };
}

// window total for walk-forward
function windowTotal(res, lo, hi) { let s = 0; for (const y of Object.keys(res.yr)) { const yy = +y; if (yy >= lo && yy <= hi) s += res.yr[y].pnl; } return s; }

// ── define variants ──────────────────────────────────────────────
// baseline exits
const BASE4 = { mode: "fixed", tpAtr: 12, slAtr: 1.6, hold: 70, exitEmaBars: 10 };
const BASE1 = { mode: "fixed", tpAtr: 8, slAtr: 2.0, hold: 24, exitEmaBars: 4 };
const BASEE = { mode: "fixed", tpAtr: 12, slAtr: 1.4, hold: 60, exitEmaBars: 10 };

const variants = [];
const add = (name, e4, e1, ee) => variants.push({ name, e4, e1, ee });

add("BASELINE (live)", BASE4, BASE1, BASEE);

// TP sweep (BTC4h tpAtr; BTC1h scaled proportionally 8/12; keep others fixed)
for (const tp of [8, 10, 12, 14, 16, 20, 24]) {
  if (tp === 12) continue; // = baseline
  add(`TP=${tp}ATR`, { ...BASE4, tpAtr: tp }, { ...BASE1, tpAtr: Math.round(tp * 8 / 12) }, { ...BASEE, tpAtr: tp });
}
// chandelier trailing only (no fixed TP, no EMA-exit) — SL kept (CẤM no-SL: initial SL ATR vẫn có, trail siết)
for (const tr of [2, 3, 4, 5]) {
  add(`CHANDELIER trail=${tr}ATR`,
    { mode: "chandelier", slAtr: 1.6, trailAtr: tr, hold: 70 },
    { mode: "chandelier", slAtr: 2.0, trailAtr: tr, hold: 24 },
    { mode: "chandelier", slAtr: 1.4, trailAtr: tr, hold: 60 });
}
// breakeven move (baseline + BE after 3 ATR profit)
for (const be of [2, 3, 4]) {
  add(`BASE + BE@${be}ATR`, { ...BASE4, beAtr: be }, { ...BASE1, beAtr: be }, { ...BASEE, beAtr: be });
}
// partial scale-out 50% @ tp1, trail rest
for (const tp1 of [4, 6, 8]) {
  for (const tr of [3, 4]) {
    add(`PARTIAL 50%@${tp1}ATR trail${tr}`,
      { mode: "partial", slAtr: 1.6, tp1Atr: tp1, partialFrac: 0.5, trailAtr: tr, hold: 70, tpAtr: 12 },
      { mode: "partial", slAtr: 2.0, tp1Atr: Math.round(tp1 * 8 / 12), partialFrac: 0.5, trailAtr: tr, hold: 24, tpAtr: 8 },
      { mode: "partial", slAtr: 1.4, tp1Atr: tp1, partialFrac: 0.5, trailAtr: tr, hold: 60, tpAtr: 12 });
  }
}

// ── run all ──────────────────────────────────────────────────────
console.log(`\n=== EXIT VARIANTS — COIN=${COIN} (faithful champion, giữ ENTRY nguyên) ===`);
console.log(`variant | total$ | MaxDD$ | Calmar | n | WF-train(19-22)$ | WF-test(23-26)$ | per-year$`);
const results = [];
for (const v of variants) {
  const r = runConfig(v.e4, v.e1, v.ee);
  const train = windowTotal(r, 2019, 2022), test = windowTotal(r, 2023, 2026);
  results.push({ v, r, train, test });
  const yrs = Object.keys(r.yr).sort().map(y => `${y}:${r.yr[y].pnl >= 0 ? "+" : ""}${r.yr[y].pnl.toFixed(0)}`).join(" ");
  console.log(`${v.name.padEnd(26)} | ${r.total.toFixed(1).padStart(8)} | ${r.maxdd.toFixed(1).padStart(7)} | ${(r.calmar === Infinity ? "inf" : r.calmar.toFixed(2)).padStart(6)} | ${String(r.n).padStart(4)} | ${train.toFixed(1).padStart(8)} | ${test.toFixed(1).padStart(8)} | ${yrs}`);
}

// summary vs baseline
const base = results[0];
console.log(`\n--- vs BASELINE (total $${base.r.total.toFixed(1)}, test $${base.test.toFixed(1)}, Calmar ${base.r.calmar.toFixed(2)}) ---`);
const winners = results.slice(1).filter(x => x.r.total > base.r.total && x.test > base.test);
if (!winners.length) console.log("KHÔNG variant nào beat baseline ở CẢ total$ lẫn WF-test$.");
for (const w of winners) console.log(`  ${w.v.name}: total ${w.r.total > base.r.total ? "+" : ""}${(w.r.total - base.r.total).toFixed(0)}$ | test ${w.test > base.test ? "+" : ""}${(w.test - base.test).toFixed(0)}$ | Calmar ${w.r.calmar.toFixed(2)}`);
