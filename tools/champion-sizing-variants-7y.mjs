/**
 * champion-sizing-variants-7y.mjs
 * Faithful champion entries (BTC4h+BTC1h, skip-BEAR toggle as live=OFF) — compare 3 SIZING modes
 * on a $100k start with compounding + margin-cap (cap×equity) + concurrency + taker fee 0.04%/side:
 *   1) FIXED-QTY  : qty=0.001 always (DEGRADED, = what's live now)
 *   2) EQ-FRAC    : margin = risk × equity         (flat equity-fraction)
 *   3) EQ-FRAC×VOL: margin = risk × equity × volScale  (vol-target, already coded in champion.ts but bypassed live)
 * Entry RULES are IDENTICAL across variants — only $ weight differs. Judge: $/CAGR + maxDD + Calmar + per-year.
 * Plus a one-time RANDOM-NULL sanity on champion entries (does the entry have edge beyond beta?).
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
function regimeAt(t) {
  let lo = 0, hi = b1d.length - 1, j = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (b1d[m].time <= t) { j = m; lo = m + 1; } else hi = m - 1; }
  if (j < 200) return "RANGE";
  let s200 = 0, s50 = 0; for (let i = j - 199; i <= j; i++) s200 += cd[i]; for (let i = j - 49; i <= j; i++) s50 += cd[i];
  const ma200 = s200 / 200, ma50 = s50 / 50; let ar = 0; for (let i = j - 19; i <= j; i++) ar += (b1d[i].high - b1d[i].low) / b1d[i].close; ar /= 20;
  if (cd[j] < ma200) return "BEAR"; if (cd[j] > ma50 && ma50 > ma200 && ar > 0.04) return "BULL"; return "RANGE";
}
const e200dArr = () => { const e = ema(cd, 200); return { t: b1d.map(x => x.time), e }; };
const D = e200dArr();
const e200dAt = t => { let lo = 0, hi = D.t.length - 1, idx = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (D.t[m] <= t) { idx = m; lo = m + 1; } else hi = m - 1; } return idx >= 0 ? D.e[idx] : null; };

const prep = bars => { const c = bars.map(b => b.close); return { bars, c, h: bars.map(b => b.high), l: bars.map(b => b.low), t: bars.map(b => b.time), e200: ema(c, 200), e20: ema(c, 20), rsi: rsi(c, 14), atr: atr(bars, 14), ...adxDi(bars, 14) }; };
const P4 = prep(b4), P1 = prep(b1);

// faithful entry gen — returns rich trades {sleeve, eTime, ePrice, xTime, xPrice, ei, atrArr ref via vs}
function gen(P, cfg, { exitEmaBars, gate4h }, sleeve) {
  const { c, h, l, t, e200, e20, rsi: R, atr: A, adx, pdi, mdi } = P;
  let pos = [], out = [], last = -999;
  for (let i = 200; i < c.length - cfg.hold - 1; i++) {
    const np = [];
    for (const p of pos) {
      let xpx = c[i], done = false, reason = "";
      if (l[i] <= p.sl) { xpx = p.sl; done = true; reason = "SL"; }
      else if (h[i] >= p.tp) { xpx = p.tp; done = true; reason = "TP"; }
      else if (e20[i] !== null && c[i] < e20[i] && i - p.ei >= exitEmaBars) { done = true; reason = "EMA20"; }
      else if (i - p.ei >= cfg.hold) { done = true; reason = "HOLD"; }
      if (done) out.push({ sleeve, ei: p.ei, eTime: p.ems, ePrice: p.epx, xTime: t[i], xPrice: xpx, vs: p.vs, reason, holdBars: i - p.ei, ...p.feat });
      else np.push(p);
    }
    pos = np;
    if (pos.length >= cfg.maxpos || i - last < cfg.cool) continue;
    // live champion = NO regime filter (skip-BEAR removed 2026-06-04). SKIPBEAR=1 to test the old gate.
    if (SKIP_BEAR && regimeAt(t[i]) === "BEAR") continue;
    const a = adx[i], pp = pdi[i], mm = mdi[i], r = R[i], e2 = e200[i], at = A[i];
    if ([a, pp, mm, r, e2, at].some(v => v === null || v === undefined)) continue;
    const fr = fundAt(t[i]), price = c[i], e2d = e200dAt(t[i]);
    if (e2d === null) continue;
    if (fr >= CHAMPION.fundingMax || r >= CHAMPION.rsiMax || price <= e2) continue;
    if (!(a > cfg.adx && pp > mm * cfg.diR)) continue;
    if (price < e2d * cfg.bg) continue;
    if (gate4h) { let lo = 0, hi = gate4h.t.length - 1, j = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (gate4h.t[m] <= t[i]) { j = m; lo = m + 1; } else hi = m - 1; } if (j < 0 || gate4h.adx[j] === null) continue; if (!(gate4h.adx[j] > 18 && gate4h.pdi[j] > gate4h.mdi[j] * 0.95 && gate4h.c[j] > gate4h.e200[j])) continue; }
    pos.push({ ei: i, epx: price, sl: price - cfg.slAtr * at, tp: price + cfg.tpAtr * at, ems: t[i], vs: volScale(A, i),
      feat: { adx: a, diRatio: pp / mm, funding: fr, regime: regimeAt(t[i]), distE200d: price / e2d - 1, atrPct: at / price, year: new Date(t[i]).getUTCFullYear() } });
    last = i;
  }
  return out;
}

// live champion has skip-BEAR REMOVED -> default faithful = SKIP_BEAR false. SKIPBEAR=1 tests old gate.
const SKIP_BEAR = process.env.SKIPBEAR === "1";
const SKIP = SKIP_BEAR;
const tr4 = gen(P4, CHAMPION.btc4h, { exitEmaBars: 10 }, "BTC4h");
const tr1 = gen(P1, CHAMPION.btc1h, { exitEmaBars: 4, gate4h: P4 }, "BTC1h");
const trades = [...tr4, ...tr1].sort((a, b) => a.eTime - b.eTime);

// ── Equity simulator ──────────────────────────────────────────────────────────
const FEE = 0.0004; // taker per side
function simulate(mode) { // mode: 'fixed' | 'eqfrac' | 'eqvol'
  let equity = 100000, openMargin = 0;
  const open = []; // {margin, qty, ePrice, xTime, xPrice}
  const events = [];
  for (const tr of trades) { events.push({ type: "E", t: tr.eTime, tr }); events.push({ type: "X", t: tr.xTime, tr }); }
  events.sort((e1, e2) => e1.t - e2.t || (e1.type === "X" ? -1 : 1)); // exits first at same ts
  const eqPts = []; const yr = {};
  let ruined = false;
  for (const ev of events) {
    if (ruined) break;
    if (ev.type === "X") {
      const idx = open.findIndex(o => o.tr === ev.tr);
      if (idx < 0) continue;
      const o = open[idx]; open.splice(idx, 1); openMargin -= o.margin;
      const gross = o.qty * (ev.tr.xPrice - o.ePrice);
      const feeOut = o.qty * ev.tr.xPrice * FEE;
      equity += gross - feeOut;
      const y = new Date(ev.tr.xTime).getUTCFullYear();
      (yr[y] ??= { n: 0, pnl: 0, w: 0 }); yr[y].n++; yr[y].pnl += gross - feeOut - o.feeIn; if (gross - feeOut - o.feeIn > 0) yr[y].w++;
      eqPts.push(equity);
      if (equity <= 0) { ruined = true; }
    } else {
      const tr = ev.tr;
      let margin;
      if (mode === "fixed") {
        const qty = 0.001; const feeIn = qty * tr.ePrice * FEE; equity -= feeIn;
        open.push({ tr, margin: 0, qty, ePrice: tr.ePrice, feeIn });
        continue;
      } else if (mode === "eqfrac") margin = CHAMPION.risk * equity;
      else margin = CHAMPION.risk * equity * tr.vs; // eqvol
      const room = CHAMPION.cap * equity - openMargin;
      if (room <= 0) continue; // no margin room -> skip (faithful cap)
      margin = Math.min(margin, room);
      const notional = margin * CHAMPION.lev;
      const qty = notional / tr.ePrice;
      const feeIn = qty * tr.ePrice * FEE; equity -= feeIn;
      openMargin += margin;
      open.push({ tr, margin, qty, ePrice: tr.ePrice, feeIn });
    }
  }
  // maxDD on equity curve
  let peak = 100000, maxDD = 0; for (const e of eqPts) { if (e > peak) peak = e; const dd = (peak - e) / peak; if (dd > maxDD) maxDD = dd; }
  const years = (trades.length ? (trades[trades.length - 1].xTime - trades[0].eTime) / (365.25 * 24 * 3600e3) : 1);
  const cagr = ruined ? -1 : Math.pow(equity / 100000, 1 / years) - 1;
  return { mode, finalEq: equity, ret: equity / 100000 - 1, maxDD, calmar: maxDD > 0 ? cagr / maxDD : Infinity, cagr, ruined, yr };
}

const modes = ["fixed", "eqfrac", "eqvol"];
const res = modes.map(simulate);

console.log(`=== CHAMPION SIZING VARIANTS — 7y faithful (skip-BEAR=${SKIP ? "ON" : "OFF"}, BTC4h+BTC1h) ===`);
console.log(`n trades=${trades.length} (BTC4h ${tr4.length} + BTC1h ${tr1.length})  start $100k  fee ${FEE * 2 * 100}% round-trip\n`);
console.log("mode        | finalEq      | totRet%  | CAGR%  | maxDD% | Calmar | ruined");
for (const r of res) {
  console.log(`${r.mode.padEnd(11)} | $${r.finalEq.toFixed(0).padStart(11)} | ${(r.ret * 100).toFixed(0).padStart(7)} | ${(r.cagr * 100).toFixed(0).padStart(5)} | ${(r.maxDD * 100).toFixed(1).padStart(5)} | ${(r.calmar).toFixed(2).padStart(6)} | ${r.ruined}`);
}
console.log("\n--- PER YEAR PnL$ (year | fixed | eqfrac | eqvol) ---");
const allYrs = [...new Set(res.flatMap(r => Object.keys(r.yr)))].sort();
for (const y of allYrs) {
  const cells = res.map(r => { const o = r.yr[y]; return o ? `${o.pnl >= 0 ? "+" : ""}${o.pnl.toFixed(0)}` : "—"; });
  const ns = res[0].yr[y] ? res[0].yr[y].n : 0;
  console.log(`  ${y} (n=${ns}) | ${cells[0].padStart(10)} | ${cells[1].padStart(12)} | ${cells[2].padStart(12)}`);
}

// ── RANDOM-NULL sanity: does champion ENTRY beat random entries of same horizon? (one-time, all variants share)
// per-trade raw long return; compare median vs median of N random-entry windows of matched bar-duration.
function medianOf(xs) { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; }
const tradeRets = trades.map(tr => (tr.xPrice - tr.ePrice) / tr.ePrice * 100);
const medTrade = medianOf(tradeRets);
// random null: for each trade, pick a random start in same sleeve series, hold same #bars
function holdBars(tr) { return Math.max(1, Math.round((tr.xTime - tr.eTime) / (tr.sleeve === "BTC4h" ? H4 : H1))); }
const seriesC = { BTC4h: P4.c, BTC1h: P1.c };
const randRets = [];
let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
for (const tr of trades) {
  const c = seriesC[tr.sleeve]; const hb = holdBars(tr);
  for (let k = 0; k < 3; k++) { const s = 200 + Math.floor(rnd() * (c.length - 200 - hb - 1)); randRets.push((c[s + hb] - c[s]) / c[s] * 100); }
}
const medRand = medianOf(randRets);
console.log(`\n--- RANDOM-NULL sanity (champion entry edge, sizing-independent) ---`);
console.log(`  median champion-entry raw return = ${medTrade.toFixed(3)}% over its hold`);
console.log(`  median RANDOM-entry return (matched hold, x3 null) = ${medRand.toFixed(3)}%`);
console.log(`  medAlpha (entry - random) = ${(medTrade - medRand).toFixed(3)}%  (fee round-trip ${(FEE * 2 * 100).toFixed(2)}%) -> ${medTrade - medRand > FEE * 2 * 100 ? "edge>fee" : "NO net edge over random"}`);

// ── SOI LỆNH THUA ───────────────────────────────────────────────────────────
const withRet = trades.map(t => ({ ...t, ret: (t.xPrice - t.ePrice) / t.ePrice * 100 }));
const losers = withRet.filter(t => t.ret <= 0), winners = withRet.filter(t => t.ret > 0);
console.log(`\n=== SOI LỆNH THUA (champion entries, n=${trades.length}) ===`);
console.log(`  winners=${winners.length} (${(100 * winners.length / trades.length).toFixed(0)}%)  losers=${losers.length} (${(100 * losers.length / trades.length).toFixed(0)}%)`);
console.log(`  median loser ret=${medianOf(losers.map(t => t.ret)).toFixed(2)}%  median winner ret=${medianOf(winners.map(t => t.ret)).toFixed(2)}%  (lev ${CHAMPION.lev}x → ×${CHAMPION.lev} trên equity)`);
const sumW = winners.reduce((a, t) => a + t.ret, 0), sumL = losers.reduce((a, t) => a + t.ret, 0);
console.log(`  ΣwinnerRet=+${sumW.toFixed(0)}%  ΣloserRet=${sumL.toFixed(0)}%  net=${(sumW + sumL).toFixed(0)}%  payoff(ΣW/|ΣL|)=${(sumW / Math.abs(sumL)).toFixed(2)}`);

// breakdown lý do thoát
const byReason = {};
for (const t of withRet) { (byReason[t.reason] ??= { n: 0, sum: 0, loss: 0 }); byReason[t.reason].n++; byReason[t.reason].sum += t.ret; if (t.ret <= 0) byReason[t.reason].loss++; }
console.log(`\n  --- lý do THOÁT (reason | n | %tổng | ΣRet% | %thua trong nhóm) ---`);
for (const r of Object.keys(byReason).sort((a, b) => byReason[b].n - byReason[a].n)) { const o = byReason[r]; console.log(`    ${r.padEnd(6)} | ${String(o.n).padStart(4)} | ${(100 * o.n / trades.length).toFixed(0).padStart(3)}% | ${(o.sum >= 0 ? "+" : "") + o.sum.toFixed(0)} | ${(100 * o.loss / o.n).toFixed(0)}%`);
}

// loser breakdown theo regime / sleeve / year
const grp = (key, fmt = x => x) => { const m = {}; for (const t of losers) { const k = fmt(t[key]); (m[k] ??= { n: 0, sum: 0 }); m[k].n++; m[k].sum += t.ret; } return m; };
const showGrp = (label, m) => { console.log(`\n  --- LOSER theo ${label} (k | n | ΣloserRet%) ---`); for (const k of Object.keys(m).sort()) console.log(`    ${String(k).padEnd(8)} | ${String(m[k].n).padStart(4)} | ${m[k].sum.toFixed(0)}`); };
showGrp("regime", grp("regime"));
showGrp("sleeve", grp("sleeve"));
showGrp("year", grp("year"));

// đặc điểm ENTRY: loser vs winner (có gì tách được không?)
const meanOf = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
console.log(`\n  --- ENTRY feature: LOSER vs WINNER (mean) — có tách được để filter không? ---`);
console.log(`    feat        | loser  | winner`);
for (const [f, fmt] of [["adx", x => x.toFixed(1)], ["diRatio", x => x.toFixed(2)], ["funding", x => (x * 100).toFixed(3) + "%"], ["distE200d", x => (x * 100).toFixed(1) + "%"], ["atrPct", x => (x * 100).toFixed(2) + "%"], ["holdBars", x => x.toFixed(0)]]) {
  console.log(`    ${f.padEnd(11)} | ${fmt(meanOf(losers.map(t => t[f]))).padStart(6)} | ${fmt(meanOf(winners.map(t => t[f]))).padStart(6)}`);
}
