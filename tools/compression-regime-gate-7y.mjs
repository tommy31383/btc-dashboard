/**
 * compression-regime-gate-7y.mjs
 * Honest test: "tích lũy đi ngang LÂU (volatility compression)" làm REGIME-GATE cho champion.
 * KHÔNG dùng nến nén để VÀO lệnh (entry-alpha = null đã chứng minh). Chỉ hỏi:
 *   champion (trend-follow) nên BẬT hay TẮT khi thị trường đang nén tích lũy lâu?
 *
 * Compression metric (4h bars): BBwidth = 4*std20/SMA20. "Nén" = BBwidth nằm dưới
 *   percentile P trong cửa sổ trailing W bars. "Nén LÂU" = nén liên tục >= K bars.
 * Modes:
 *   baseline        = LIVE (không gate)
 *   skip-compress   = KHÔNG entry khi đang nén-lâu (tránh whipsaw)
 *   compress-only   = CHỈ entry khi đang nén-lâu
 *   post-breakout   = CHỈ entry trong M bars NGAY SAU khi nén-lâu kết thúc (breakout)
 * Judge: DOLLARS NET per-year + drop-top-20% (bỏ 20% lệnh lãi nhất → còn dương?).
 * Cross-asset BTC/ETH/SOL champion-method. Closed bars only, fill tại close[i] (faithful harness).
 */
import { readFileSync } from "fs";
import { ema, rsi, atr, adxDi, volScale, CHAMPION } from "/Users/lap16116/BTC_PC/btc-trader-server/dist/engine/champion.js";
const C = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/";
const TP_OVERRIDE = 16, WEIGHT = 1.25, FEE = 0.0004;
const H4 = 4 * 3600e3, H1D = 24 * 3600e3;
// compression params
const BBW_PCTL = 0.25;   // nén = BBwidth dưới percentile này
const BBW_WIN = 180;     // cửa sổ trailing (4h bars) ~30 ngày
const COMPRESS_K = 12;   // nén "LÂU" = >=12 bars 4h liên tục (~2 ngày)
const POST_M = 12;       // post-breakout = trong 12 bars sau khi nén kết thúc

const load = f => JSON.parse(readFileSync(C + f)).sort((a, b) => a.time - b.time);
const build = (raw, ms) => { const b = new Map(); for (const c of raw) { const k = Math.floor(c.time / ms); const o = b.get(k); if (!o) b.set(k, { time: k * ms, open: c.open, close: c.close, high: c.high, low: c.low }); else { o.high = Math.max(o.high, c.high); o.low = Math.min(o.low, c.low); o.close = c.close; } } return [...b.keys()].sort((a, b) => a - b).map(k => b.get(k)); };
const prep = bars => { const c = bars.map(b => b.close); return { bars, c, h: bars.map(b => b.high), l: bars.map(b => b.low), t: bars.map(b => b.time), e200: ema(c, 200), e20: ema(c, 20), rsi: rsi(c, 14), atr: atr(bars, 14), ...adxDi(bars, 14) }; };
function dailyE200(raw) { const b1d = build(raw, H1D); const cd = b1d.map(b => b.close); const e = ema(cd, 200); const t = b1d.map(b => b.time); return time => { let lo = 0, hi = t.length - 1, idx = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (t[m] <= time) { idx = m; lo = m + 1; } else hi = m - 1; } return idx >= 0 ? e[idx] : null; }; }

// compression state per 4h bar index: boolean "đang nén-lâu", + barsSinceCompressEnd
function compressionFlags(P) {
  const { c } = P; const n = c.length;
  // BBwidth = 4*std20/SMA20
  const bbw = new Array(n).fill(null);
  for (let i = 19; i < n; i++) {
    let s = 0; for (let k = i - 19; k <= i; k++) s += c[k]; const m = s / 20;
    let v = 0; for (let k = i - 19; k <= i; k++) v += (c[k] - m) ** 2; const sd = Math.sqrt(v / 20);
    bbw[i] = (4 * sd) / m;
  }
  // nén thời điểm i: bbw[i] dưới percentile P trong [i-WIN, i]
  const compressed = new Array(n).fill(false);
  for (let i = BBW_WIN; i < n; i++) {
    if (bbw[i] === null) continue;
    const win = []; for (let k = i - BBW_WIN; k <= i; k++) if (bbw[k] !== null) win.push(bbw[k]);
    win.sort((a, b) => a - b); const thr = win[Math.floor(win.length * BBW_PCTL)];
    compressed[i] = bbw[i] <= thr;
  }
  // nén-LÂU: compressed liên tục >= K bars tới i
  const compressLong = new Array(n).fill(false);
  let run = 0;
  for (let i = 0; i < n; i++) { run = compressed[i] ? run + 1 : 0; compressLong[i] = run >= COMPRESS_K; }
  // barsSinceCompressEnd: số bar kể từ lần cuối compressLong=true
  const sinceEnd = new Array(n).fill(9999);
  let last = -9999;
  for (let i = 0; i < n; i++) { if (compressLong[i]) last = i; sinceEnd[i] = i - last; }
  return { compressLong, sinceEnd };
}

function gen(P, cfg, e200dAt, comp, mode) {
  const { c, h, l, t, e200, e20, rsi: R, atr: A, adx, pdi, mdi } = P;
  let pos = [], out = [], last = -999;
  for (let i = 200; i < c.length - cfg.hold - 1; i++) {
    const np = [];
    for (const p of pos) {
      let xpx = c[i], done = false;
      if (l[i] <= p.sl) { xpx = p.sl; done = true; }
      else if (h[i] >= p.tp) { xpx = p.tp; done = true; }
      else if (e20[i] !== null && c[i] < e20[i] && i - p.ei >= 10) { done = true; }
      else if (i - p.ei >= cfg.hold) { done = true; }
      if (done) out.push({ eTime: p.ems, ePrice: p.epx, xTime: t[i], xPrice: xpx, vs: p.vs, pnl: xpx - p.epx }); else np.push(p);
    }
    pos = np;
    if (pos.length >= cfg.maxpos || i - last < cfg.cool) continue;
    const a = adx[i], pp = pdi[i], mm = mdi[i], r = R[i], e2 = e200[i], at = A[i];
    if ([a, pp, mm, r, e2, at].some(v => v === null || v === undefined)) continue;
    const price = c[i], e2d = e200dAt(t[i]); if (e2d === null) continue;
    if (r >= CHAMPION.rsiMax || price <= e2) continue;
    if (!(a > cfg.adx && pp > mm * cfg.diR)) continue;
    if (price < e2d * cfg.bg) continue;
    // ── COMPRESSION REGIME GATE ──
    const isLong = comp.compressLong[i], since = comp.sinceEnd[i];
    if (mode === "skip-compress" && isLong) continue;
    if (mode === "compress-only" && !isLong) continue;
    if (mode === "post-breakout" && !(since >= 1 && since <= POST_M)) continue;
    pos.push({ ei: i, epx: price, sl: price - cfg.slAtr * at, tp: price + TP_OVERRIDE * at, ems: t[i], vs: volScale(A, i) });
    last = i;
  }
  return out;
}

function simEqvol(trades) {
  if (!trades.length) return { finalEq: 100000, cagr: 0, maxDD: 0, calmar: 0, n: 0, yr: {} };
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

// drop-top-20%: bỏ 20% lệnh có pnl-per-unit cao nhất, tính tổng pnl-per-unit còn lại (chữ ký fat-tail)
function dropTop20(trades) {
  if (!trades.length) return { full: 0, dropped: 0 };
  const sorted = [...trades].sort((a, b) => b.pnl - a.pnl);
  const cut = Math.floor(sorted.length * 0.2);
  const full = trades.reduce((s, t) => s + t.pnl / t.ePrice, 0); // normalize % để cross-asset so sánh
  const dropped = sorted.slice(cut).reduce((s, t) => s + t.pnl / t.ePrice, 0);
  return { full, dropped };
}

const ASSETS = [
  { name: "BTC", file: "binance-5m-7y.json" },
  { name: "ETH", file: "binance-eth-5m-7y.json" },
  { name: "SOL", file: "binance-sol-5m-3y.json" },
];
const MODES = ["baseline", "skip-compress", "compress-only", "post-breakout"];

console.log(`=== COMPRESSION REGIME-GATE honest test (champion-method, eqvol $100k) ===`);
console.log(`params: BBW_PCTL=${BBW_PCTL} WIN=${BBW_WIN} K=${COMPRESS_K}bars(~2d) POST_M=${POST_M}\n`);

for (const asset of ASSETS) {
  let raw;
  try { raw = load(asset.file); } catch { console.log(`${asset.name}: NO DATA`); continue; }
  const e200d = dailyE200(raw);
  const P4 = prep(build(raw, H4));
  const comp = compressionFlags(P4);
  const yrs = new Set();
  console.log(`── ${asset.name} ──`);
  console.log(`mode           |   n  | finalEq  | CAGR% | maxDD% | Calmar | dropTop20%(full→drop)`);
  const yearRows = {};
  for (const mode of MODES) {
    const tr = gen(P4, CHAMPION.btc4h, e200d, comp, mode);
    const r = simEqvol(tr);
    const d = dropTop20(tr);
    Object.keys(r.yr).forEach(y => yrs.add(+y));
    yearRows[mode] = r.yr;
    const sign = d.dropped >= 0 ? "+" : "";
    console.log(`${mode.padEnd(14)} | ${String(r.n).padStart(4)} | ${Math.round(r.finalEq).toString().padStart(8)} | ${(r.cagr * 100).toFixed(0).padStart(5)} | ${(r.maxDD * 100).toFixed(1).padStart(6)} | ${r.calmar.toFixed(2).padStart(6)} | ${(d.full * 100).toFixed(0)}% → ${sign}${(d.dropped * 100).toFixed(0)}%`);
  }
  // per-year dollars table
  const ys = [...yrs].sort();
  console.log(`\n  per-year $ (net):  ` + ys.join("      "));
  for (const mode of MODES) {
    const row = ys.map(y => { const v = Math.round(yearRows[mode][y] || 0); return (v >= 0 ? "+" : "") + v; });
    console.log(`  ${mode.padEnd(14)} ` + row.map(x => x.padStart(6)).join(" "));
  }
  console.log("");
}
