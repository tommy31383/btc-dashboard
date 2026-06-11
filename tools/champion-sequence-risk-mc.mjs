/**
 * champion-sequence-risk-mc.mjs — STRESS-TEST mốc "volScale express ở $113/$200".
 * Băm cái may-mắn Sequence-Return-Luck: nếu backtest gốc sống vì lệnh đầu 2019 trúng win-streak
 * kéo ví qua $200 nhanh, thì xáo thứ tự / ném chuỗi-thua-lên-đầu sẽ lòi ra ruin/DD nặng.
 *
 * MODEL: serial no-overlap compounding (chuẩn cho Monte-Carlo thứ-tự-lệnh). Mỗi lệnh:
 *   margin = risk0.04 × (E×budgetFrac) × w1.25 × volScale; qty = floor(margin×lev/price, 0.001);
 *   nếu qty<0.001 → 0.001 (OVER-sized degraded). pnl = qty×(xP−eP) − fee 2 đầu. E += pnl.
 * CAVEAT: serial bỏ qua concurrency (gốc cho 12 lệnh mở song song) → tổng return KHÁC sim gốc;
 *   nhưng ĐÚNG công cụ đo sequence-risk (phân phối DD khi đảo thứ tự). Judge: ruin% + DD p50/p95/max.
 *
 * 3 kịch bản: (1) chronological baseline, (2) 500 random shuffle, (3) WORST-FIRST (loser lên đầu).
 * + Sizing-mutilation audit: % lệnh mà toán bảo bóp <0.001 nhưng sàn ép 0.001 (oversized), khi ví nhỏ.
 */
import { readFileSync } from "fs";
import { ema, rsi, atr, adxDi, volScale, CHAMPION } from "/Users/lap16116/BTC_PC/btc-trader-server/dist/engine/champion.js";

const C = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/";
const TP = 16, W = 1.25, FEE = 0.0004, LEV = CHAMPION.lev, BF = 0.40;
const H4 = 4 * 3600e3, H1D = 24 * 3600e3;
const load = f => JSON.parse(readFileSync(C + f)).sort((a, b) => a.time - b.time);
const build = (raw, ms) => { const b = new Map(); for (const c of raw) { const k = Math.floor(c.time / ms); const o = b.get(k); if (!o) b.set(k, { time: k * ms, open: c.open, close: c.close, high: c.high, low: c.low }); else { o.high = Math.max(o.high, c.high); o.low = Math.min(o.low, c.low); o.close = c.close; } } return [...b.keys()].sort((a, b) => a - b).map(k => b.get(k)); };
const prep = bars => { const c = bars.map(b => b.close); return { bars, c, h: bars.map(b => b.high), l: bars.map(b => b.low), t: bars.map(b => b.time), e200: ema(c, 200), e20: ema(c, 20), rsi: rsi(c, 14), atr: atr(bars, 14), ...adxDi(bars, 14) }; };
function dailyE200(raw) { const b = build(raw, H1D); const e = ema(b.map(x => x.close), 200); const t = b.map(x => x.time); return time => { let lo = 0, hi = t.length - 1, idx = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (t[m] <= time) { idx = m; lo = m + 1; } else hi = m - 1; } return idx >= 0 ? e[idx] : null; }; }

const rawBtc = load("binance-5m-7y.json"), rawEth = load("binance-eth-5m-7y.json");
const bE = dailyE200(rawBtc), eE = dailyE200(rawEth);
const Pb = prep(build(rawBtc, H4)), Pe = prep(build(rawEth, H4));
function gen(P, cfg, e2dAt, sleeve, band) {
  const { c, h, l, t, e200, e20, rsi: R, atr: A, adx, pdi, mdi } = P; let pos = [], out = [], last = -999;
  for (let i = 200; i < c.length - cfg.hold - 1; i++) {
    const np = [];
    for (const p of pos) { let xp = c[i], d = false; if (l[i] <= p.sl) { xp = p.sl; d = true; } else if (h[i] >= p.tp) { xp = p.tp; d = true; } else if (e20[i] !== null && c[i] < e20[i] && i - p.ei >= 10) d = true; else if (i - p.ei >= cfg.hold) d = true; if (d) out.push({ eT: p.ems, eP: p.epx, xP: xp, vs: p.vs }); else np.push(p); }
    pos = np; if (pos.length >= cfg.maxpos || i - last < cfg.cool) continue;
    const a = adx[i], pp = pdi[i], mm = mdi[i], r = R[i], e2 = e200[i], at = A[i];
    if ([a, pp, mm, r, e2, at].some(v => v == null)) continue;
    const price = c[i], e2d = e2dAt(t[i]); if (e2d == null) continue;
    if (r >= CHAMPION.rsiMax || price <= e2) continue; if (!(a > cfg.adx && pp > mm * cfg.diR)) continue;
    if (band === "band") { const ra = price / e2d; if (!(ra >= cfg.bandLo && ra <= cfg.bandHi)) continue; } else if (price < e2d * cfg.bg) continue;
    pos.push({ ei: i, epx: price, sl: price - cfg.slAtr * at, tp: price + TP * at, ems: t[i], vs: volScale(A, i) }); last = i;
  }
  return out;
}
const trades = [...gen(Pb, CHAMPION.btc4h, bE, "BTC4h", "above"), ...gen(Pe, CHAMPION.eth4h, eE, "ETH4h", "band")].sort((a, b) => a.eT - b.eT);

// serial compounding sim over an ORDER of trades
function serial(order, start) {
  let E = start, peak = start, maxDD = 0, ruin = false, degraded = 0;
  for (const tr of order) {
    const margin = CHAMPION.risk * (E * BF) * W * tr.vs;
    let qty = Math.floor(margin * LEV / tr.eP * 1000) / 1000;
    if (qty < 0.001) { qty = 0.001; degraded++; }
    const pnl = qty * (tr.xP - tr.eP) - qty * tr.eP * FEE - qty * tr.xP * FEE;
    E += pnl; if (E <= 0) { ruin = true; break; }
    if (E > peak) peak = E; const dd = (peak - E) / peak; if (dd > maxDD) maxDD = dd;
  }
  return { finalEq: E, ret: E / start - 1, maxDD, ruin, degraded };
}
// seeded RNG
let seed = 424242; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const shuffle = arr => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; } return a; };
const worstFirst = arr => [...arr].sort((x, y) => (x.xP - x.eP) / x.eP - (y.xP - y.eP) / y.eP);
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

console.log(`=== SEQUENCE-RISK MONTE CARLO (champion BTC4h+ETH4h, n=${trades.length}, serial no-overlap) ===\n`);
for (const start of [113, 200, 500]) {
  const chrono = serial(trades, start);
  const wf = serial(worstFirst(trades), start);
  const mc = []; let ruins = 0;
  for (let k = 0; k < 500; k++) { const r = serial(shuffle(trades), start); mc.push(r.maxDD); if (r.ruin) ruins++; }
  console.log(`--- Ví $${start} ---`);
  console.log(`  CHRONOLOGICAL : ret ${(chrono.ret * 100).toFixed(0)}%  maxDD ${(chrono.maxDD * 100).toFixed(1)}%  ruin=${chrono.ruin}  degraded=${chrono.degraded}/${trades.length}`);
  console.log(`  WORST-FIRST   : ret ${(wf.ret * 100).toFixed(0)}%  maxDD ${(wf.maxDD * 100).toFixed(1)}%  ruin=${wf.ruin}  (chuỗi-thua ném vạch xuất phát)`);
  console.log(`  MC 500 shuffle: maxDD p50=${(pct(mc, 0.5) * 100).toFixed(1)}%  p95=${(pct(mc, 0.95) * 100).toFixed(1)}%  max=${(Math.max(...mc) * 100).toFixed(1)}%  ruin-rate=${(100 * ruins / 500).toFixed(1)}%\n`);
}

// ── SIZING-MUTILATION AUDIT (ví nhỏ: lệnh toán bảo bóp <0.001 nhưng sàn ép 0.001) ──
console.log("=== SIZING-MUTILATION AUDIT — % lệnh bị floor ép oversized khi ví < $500 (chronological) ===");
for (const start of [113, 200]) {
  let E = start, mut = 0, seen = 0, minQtyTarget = 1e9, exMinVs = null;
  for (const tr of trades) {
    if (E >= 500) break; seen++;
    const margin = CHAMPION.risk * (E * BF) * W * tr.vs;
    const qtyTarget = margin * LEV / tr.eP;
    if (qtyTarget < minQtyTarget) { minQtyTarget = qtyTarget; exMinVs = tr.vs; }
    if (qtyTarget < 0.001) mut++;
    let qty = Math.floor(qtyTarget * 1000) / 1000; if (qty < 0.001) qty = 0.001;
    E += qty * (tr.xP - tr.eP) - qty * tr.eP * FEE - qty * tr.xP * FEE; if (E <= 0) break;
  }
  console.log(`  $${start}: ${seen} lệnh khi ví<$500 · mutilation ${mut}/${seen} (${(100 * mut / Math.max(1, seen)).toFixed(0)}%) · qty-target nhỏ nhất=${minQtyTarget.toFixed(5)} BTC (volScale=${exMinVs?.toFixed(2)}) → bị ép 0.001`);
}
