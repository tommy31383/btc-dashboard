/**
 * champion-extend-7y.mjs — 2 góc mở rộng:
 *  E) sweep tpAtr (8/10/12/14/16) trên BTC both sleeves — TP rộng/hẹp đổi N+ROI+DD+Calmar sao
 *  F) thêm sleeve ETH4h (CHAMPION.eth4h, band gate) — BTC-both vs BTC-both+ETH4h (diversify?)
 * eqvol sizing shared equity $100k, fee 0.04%/side. Judge Calmar/dollars.
 */
import { readFileSync } from "fs";
import { ema, rsi, atr, adxDi, volScale, CHAMPION } from "/Users/lap16116/BTC_PC/btc-trader-server/dist/engine/champion.js";

const C = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/";
const load = f => JSON.parse(readFileSync(C + f)).sort((a, b) => a.time - b.time);
const rawBtc = load("binance-5m-7y.json");
const rawEth = load("binance-eth-5m-7y.json");
const rf = JSON.parse(readFileSync(C + "binance-funding-7y.json"));
const fk = Object.keys(rf[0]).find(k => k.toLowerCase().includes("time"));
const rk = ["fundingRate", "rate", "r", "funding"].find(k => k in rf[0]);
const fund = rf.map(e => [+e[fk], +e[rk]]).sort((a, b) => a[0] - b[0]); const ftimes = fund.map(x => x[0]);
const fundAt = t => { let lo = 0, hi = ftimes.length - 1, idx = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (ftimes[m] <= t) { idx = m; lo = m + 1; } else hi = m - 1; } return idx >= 0 ? fund[idx][1] : 0; };

const H4 = 4 * 3600e3, H1 = 3600e3, H1D = 24 * 3600e3;
const build = (raw, ms) => { const b = new Map(); for (const c of raw) { const k = Math.floor(c.time / ms); const o = b.get(k); if (!o) b.set(k, { time: k * ms, open: c.open, close: c.close, high: c.high, low: c.low, volume: c.volume }); else { o.high = Math.max(o.high, c.high); o.low = Math.min(o.low, c.low); o.close = c.close; } } return [...b.keys()].sort((a, b) => a - b).map(k => b.get(k)); };
const b4 = build(rawBtc, H4), b1 = build(rawBtc, H1), b1d = build(rawBtc, H1D);
const e4 = build(rawEth, H4), e1d = build(rawEth, H1D);

const e200dArrOf = bd => { const e = ema(bd.map(b => b.close), 200); return t => { let lo = 0, hi = bd.length - 1, idx = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (bd[m].time <= t) { idx = m; lo = m + 1; } else hi = m - 1; } return idx >= 0 ? e[idx] : null; }; };
const e200dBtc = e200dArrOf(b1d), e200dEth = e200dArrOf(e1d);
const prep = bars => { const c = bars.map(b => b.close); return { bars, c, h: bars.map(b => b.high), l: bars.map(b => b.low), t: bars.map(b => b.time), e200: ema(c, 200), e20: ema(c, 20), rsi: rsi(c, 14), atr: atr(bars, 14), ...adxDi(bars, 14) }; };
const P4 = prep(b4), P1 = prep(b1), PE4 = prep(e4);

// gen: kind 'btc' (bg gate) or 'eth' (band gate). tpAtrOverride for sweep.
function gen(P, cfg, { exitEmaBars, gate4h, kind, e200d }, sleeve, tpAtrOverride) {
  const { c, h, l, t, e200, e20, rsi: R, atr: A, adx, pdi, mdi } = P;
  const tpAtr = tpAtrOverride ?? cfg.tpAtr;
  let pos = [], out = [], last = -999;
  for (let i = 200; i < c.length - cfg.hold - 1; i++) {
    const np = [];
    for (const p of pos) {
      let xpx = c[i], done = false;
      if (l[i] <= p.sl) { xpx = p.sl; done = true; }
      else if (h[i] >= p.tp) { xpx = p.tp; done = true; }
      else if (e20[i] !== null && c[i] < e20[i] && i - p.ei >= exitEmaBars) done = true;
      else if (i - p.ei >= cfg.hold) done = true;
      if (done) out.push({ sleeve, eTime: p.ems, ePrice: p.epx, xTime: t[i], xPrice: xpx, vs: p.vs });
      else np.push(p);
    }
    pos = np;
    if (pos.length >= cfg.maxpos || i - last < cfg.cool) continue;
    const a = adx[i], pp = pdi[i], mm = mdi[i], r = R[i], e2 = e200[i], at = A[i];
    if ([a, pp, mm, r, e2, at].some(v => v === null || v === undefined)) continue;
    const fr = fundAt(t[i]), price = c[i], e2d = e200d(t[i]);
    if (e2d === null) continue;
    if (fr >= CHAMPION.fundingMax || r >= CHAMPION.rsiMax || price <= e2) continue;
    if (!(a > cfg.adx && pp > mm * cfg.diR)) continue;
    if (kind === "eth") { const ratio = price / e2d; if (!(ratio >= cfg.bandLo && ratio <= cfg.bandHi)) continue; }
    else { if (price < e2d * cfg.bg) continue; }
    if (gate4h) { let lo = 0, hi = gate4h.t.length - 1, j = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (gate4h.t[m] <= t[i]) { j = m; lo = m + 1; } else hi = m - 1; } if (j < 0 || gate4h.adx[j] === null) continue; if (!(gate4h.adx[j] > 18 && gate4h.pdi[j] > gate4h.mdi[j] * 0.95 && gate4h.c[j] > gate4h.e200[j])) continue; }
    pos.push({ ei: i, epx: price, sl: price - cfg.slAtr * at, tp: price + tpAtr * at, ems: t[i], vs: volScale(A, i) });
    last = i;
  }
  return out;
}

const FEE = 0.0004;
function simulate(trades) {
  let equity = 100000, openMargin = 0; const open = [];
  const events = [];
  for (const tr of trades) { events.push({ type: "E", t: tr.eTime, tr }); events.push({ type: "X", t: tr.xTime, tr }); }
  events.sort((a, b) => a.t - b.t || (a.type === "X" ? -1 : 1));
  const eqPts = [];
  for (const ev of events) {
    if (ev.type === "X") { const idx = open.findIndex(o => o.tr === ev.tr); if (idx < 0) continue; const o = open[idx]; open.splice(idx, 1); openMargin -= o.margin; equity += o.qty * (ev.tr.xPrice - o.ePrice) - o.qty * ev.tr.xPrice * FEE; eqPts.push(equity); }
    else { let margin = CHAMPION.risk * equity * ev.tr.vs; const room = CHAMPION.cap * equity - openMargin; if (room <= 0) continue; margin = Math.min(margin, room); const qty = margin * CHAMPION.lev / ev.tr.ePrice; equity -= qty * ev.tr.ePrice * FEE; openMargin += margin; open.push({ tr: ev.tr, margin, qty, ePrice: ev.tr.ePrice }); }
  }
  let peak = 100000, maxDD = 0; for (const e of eqPts) { if (e > peak) peak = e; const dd = (peak - e) / peak; if (dd > maxDD) maxDD = dd; }
  const years = trades.length ? (trades[trades.length - 1].xTime - trades[0].eTime) / (365.25 * 24 * 3600e3) : 1;
  const cagr = Math.pow(Math.max(equity, 1) / 100000, 1 / years) - 1;
  return { n: trades.length, ret: equity / 100000 - 1, maxDD, cagr, calmar: maxDD > 0 ? cagr / maxDD : Infinity };
}
const srt = a => a.sort((x, y) => x.eTime - y.eTime);
const btc4 = tp => gen(P4, CHAMPION.btc4h, { exitEmaBars: 10, kind: "btc", e200d: e200dBtc }, "BTC4h", tp);
const btc1 = tp => gen(P1, CHAMPION.btc1h, { exitEmaBars: 4, gate4h: P4, kind: "btc", e200d: e200dBtc }, "BTC1h", tp);
const eth4 = () => gen(PE4, CHAMPION.eth4h, { exitEmaBars: 10, kind: "eth", e200d: e200dEth }, "ETH4h");
const row = (label, r) => `${label.padEnd(22)} | ${String(r.n).padStart(5)} | ${(r.ret * 100).toFixed(0).padStart(8)} | ${(r.cagr * 100).toFixed(0).padStart(5)} | ${(r.maxDD * 100).toFixed(1).padStart(5)} | ${r.calmar.toFixed(2).padStart(6)}`;

console.log("=== E) SWEEP tpAtr (BTC both, eqvol $100k; live=12) ===");
console.log("config                 |     N | totRet%  | CAGR | maxDD | Calmar");
for (const tp of [8, 10, 12, 14, 16]) console.log(row(`tpAtr=${tp}${tp === 12 ? " (live4h)" : ""}`, simulate(srt([...btc4(tp), ...btc1(tp)]))));

console.log("\n=== F) ADD ETH4h sleeve (diversify?) ===");
console.log("config                 |     N | totRet%  | CAGR | maxDD | Calmar");
console.log(row("BTC-both (live)", simulate(srt([...btc4(), ...btc1()]))));
console.log(row("ETH4h only", simulate(srt([...eth4()]))));
console.log(row("BTC-both + ETH4h", simulate(srt([...btc4(), ...btc1(), ...eth4()]))));

// per-year helper (eqvol, returns per-year pnl$)
function perYear(trades) {
  let equity = 100000, openMargin = 0; const open = []; const yr = {};
  const events = []; for (const tr of trades) { events.push({ type: "E", t: tr.eTime, tr }); events.push({ type: "X", t: tr.xTime, tr }); }
  events.sort((a, b) => a.t - b.t || (a.type === "X" ? -1 : 1));
  for (const ev of events) {
    if (ev.type === "X") { const idx = open.findIndex(o => o.tr === ev.tr); if (idx < 0) continue; const o = open[idx]; open.splice(idx, 1); openMargin -= o.margin; const pnl = o.qty * (ev.tr.xPrice - o.ePrice) - o.qty * ev.tr.xPrice * FEE - o.feeIn; equity += o.qty * (ev.tr.xPrice - o.ePrice) - o.qty * ev.tr.xPrice * FEE; const y = new Date(ev.tr.xTime).getUTCFullYear(); (yr[y] ??= { n: 0, pnl: 0 }); yr[y].n++; yr[y].pnl += pnl; }
    else { let margin = CHAMPION.risk * equity * ev.tr.vs; const room = CHAMPION.cap * equity - openMargin; if (room <= 0) continue; margin = Math.min(margin, room); const qty = margin * CHAMPION.lev / ev.tr.ePrice; const feeIn = qty * ev.tr.ePrice * FEE; equity -= feeIn; openMargin += margin; open.push({ tr: ev.tr, margin, qty, ePrice: ev.tr.ePrice, feeIn }); }
  }
  return yr;
}
console.log("\n=== E2) tpAtr GRID rộng (tìm điểm quay đầu) ===");
console.log("config                 |     N | totRet%  | CAGR | maxDD | Calmar");
for (const tp of [16, 20, 24, 30, 40]) console.log(row(`tpAtr=${tp}`, simulate(srt([...btc4(tp), ...btc1(tp)]))));

console.log("\n=== PER-YEAR (pnl$, eqvol) — kiểm định ổn định ===");
const cfgs = { "live(tp12)": srt([...btc4(), ...btc1()]), "tp16": srt([...btc4(16), ...btc1(16)]), "BTC+ETH4h": srt([...btc4(), ...btc1(), ...eth4()]) };
const yrs = {}; for (const k in cfgs) yrs[k] = perYear(cfgs[k]);
const allY = [...new Set(Object.values(yrs).flatMap(y => Object.keys(y)))].sort();
console.log("year   | " + Object.keys(cfgs).map(k => k.padStart(14)).join(" | "));
for (const y of allY) console.log(`${y}   | ` + Object.keys(cfgs).map(k => { const o = yrs[k][y]; return (o ? (o.pnl >= 0 ? "+" : "") + o.pnl.toFixed(0) : "—").padStart(14); }).join(" | "));
console.log("posYrs | " + Object.keys(cfgs).map(k => { const ys = Object.values(yrs[k]); return `${ys.filter(o => o.pnl > 0).length}/${ys.length}`.padStart(14); }).join(" | "));

// ── VALIDATION GATES for BTC+ETH4h ──────────────────────────────────────────
const both = srt([...btc4(), ...btc1(), ...eth4()]);
const btcOnly = srt([...btc4(), ...btc1()]);
const splitTs = new Date(Date.UTC(2023, 0, 1)).getTime();
const simSub = trs => simulate(trs); // simulate resets equity to 100k internally
console.log("\n=== GATE 1: OOS (train 2019-22 vs test 2023-26) ===");
console.log("config                 |     N | totRet%  | CAGR | maxDD | Calmar");
for (const [lbl, set] of [["BTC+ETH train", both.filter(t => t.eTime < splitTs)], ["BTC+ETH test", both.filter(t => t.eTime >= splitTs)], ["BTConly train", btcOnly.filter(t => t.eTime < splitTs)], ["BTConly test", btcOnly.filter(t => t.eTime >= splitTs)]])
  console.log(row(lbl, simSub(set)));

console.log("\n=== GATE 2: drop-top-20% (raw trade returns) ===");
const median = xs => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; };
for (const [lbl, set] of [["BTC-both", btcOnly], ["BTC+ETH4h", both]]) {
  const rets = set.map(t => (t.xPrice - t.ePrice) / t.ePrice * 100).sort((a, b) => b - a);
  const cut = Math.floor(rets.length * 0.2); const trimmed = rets.slice(cut);
  const sumAll = rets.reduce((a, b) => a + b, 0), sumTrim = trimmed.reduce((a, b) => a + b, 0);
  console.log(`  ${lbl.padEnd(12)} sumRet=${sumAll.toFixed(0)}%  drop-top20%=${sumTrim.toFixed(0)}%  medTrim=${median(trimmed).toFixed(2)}% -> ${sumTrim > 0 ? "SỐNG" : "CHẾT(fat-tail)"}`);
}

console.log("\n=== GATE 3: ETH4h decorrelation (monthly pnl Pearson vs BTC-both) ===");
const monthly = trades => { const m = {}; const yr = perYear; const ev = []; for (const tr of trades) ev.push(tr); // use simple per-trade pnl proxy: raw ret × vs (sizing-neutral relative)
  for (const tr of trades) { const k = new Date(tr.xTime).toISOString().slice(0, 7); m[k] = (m[k] ?? 0) + ((tr.xPrice - tr.ePrice) / tr.ePrice); } return m; };
const mE = monthly(srt([...eth4()])), mB = monthly(btcOnly);
const keys = [...new Set([...Object.keys(mE), ...Object.keys(mB)])].sort();
const ae = keys.map(k => mE[k] ?? 0), ab = keys.map(k => mB[k] ?? 0);
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const me = mean(ae), mb = mean(ab); let cov = 0, ve = 0, vb = 0;
for (let i = 0; i < keys.length; i++) { cov += (ae[i] - me) * (ab[i] - mb); ve += (ae[i] - me) ** 2; vb += (ab[i] - mb) ** 2; }
console.log(`  Pearson(ETH4h monthly, BTC-both monthly) = ${(cov / Math.sqrt(ve * vb)).toFixed(3)}  (thấp = diversify thật; cao = trùng beta)`);
console.log(`  ETH4h months active=${Object.keys(mE).length}/${keys.length}`);
