/** turtle-live-7y.mjs — turtle LIVE config per-trade: Donchian 20/10 long + cut1.5 ATR + skip-BEAR, qty 0.003. year+month+n. */
import { readFileSync } from "fs";
const raw = JSON.parse(readFileSync("/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json")).sort((a, b) => a.time - b.time);
const H1D = 24 * 3600e3;
const b = new Map();
for (const c of raw) { const k = Math.floor(c.time / H1D); const o = b.get(k); if (!o) b.set(k, { time: k * H1D, open: c.open, close: c.close, high: c.high, low: c.low }); else { o.high = Math.max(o.high, c.high); o.low = Math.min(o.low, c.low); o.close = c.close; } }
const BD = [...b.keys()].sort((a, b) => a - b).map(k => b.get(k));
const C = BD.map(x => x.close), Hh = BD.map(x => x.high), Ll = BD.map(x => x.low);
const DON_E = 20, DON_X = 10, CUT = 1.5, QTY = 0.003, FEE = 0.0004;
// ATR(14) Wilder
const atr = new Array(BD.length).fill(null);
{ const tr = []; for (let i = 1; i < BD.length; i++) tr.push(Math.max(Hh[i] - Ll[i], Math.abs(Hh[i] - C[i - 1]), Math.abs(Ll[i] - C[i - 1]))); let a = tr.slice(0, 14).reduce((x, y) => x + y, 0) / 14; atr[14] = a; for (let i = 14; i < tr.length; i++) { a = (a * 13 + tr[i]) / 14; atr[i + 1] = a; } }
// MA200 regime
const ma200 = i => { if (i < 199) return null; let s = 0; for (let j = i - 199; j <= i; j++) s += C[j]; return s / 200; };
const trades = [];
let holding = false, epx = 0, eatr = 0, ets = 0;
for (let i = Math.max(DON_E, 200); i < BD.length; i++) {
  if (holding) {
    let exit = false, xpx = C[i];
    if (Ll[i] <= epx - eatr * CUT) { exit = true; xpx = epx - eatr * CUT; }
    else { let dlo = Infinity; for (let j = i - DON_X; j < i; j++) dlo = Math.min(dlo, Ll[j]); if (C[i] < dlo) exit = true; }
    if (exit) { trades.push({ e: ets, x: BD[i].time, pnl: QTY * (xpx - epx) - FEE * C[i] * QTY }); holding = false; }
  }
  if (!holding) {
    let dhi = -Infinity; for (let j = i - DON_E; j < i; j++) dhi = Math.max(dhi, Hh[j]);
    const m = ma200(i - 1); const bear = process.env.SKIPBEAR !== "0" && m !== null && C[i - 1] < m;
    if (C[i] > dhi && !bear) { holding = true; epx = C[i]; eatr = atr[i] || 0; ets = BD[i].time; }
  }
}
const yr = {}, ym = {};
for (const t of trades) { const d = new Date(t.x); const y = d.getUTCFullYear(); const m = `${y}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; (yr[y] ??= { n: 0, pnl: 0, w: 0 }); yr[y].n++; yr[y].pnl += t.pnl; if (t.pnl > 0) yr[y].w++; (ym[m] ??= { n: 0, pnl: 0 }); ym[m].n++; ym[m].pnl += t.pnl; }
const tot = trades.reduce((a, t) => a + t.pnl, 0), w = trades.filter(t => t.pnl > 0).length;
console.log("=== TURTLE LIVE (Donchian 20/10 long + cut1.5 + skip-BEAR, qty 0.003) — 7y ===");
console.log(`TOTAL: n=${trades.length}  PnL=$${tot.toFixed(2)}  WR=${(100 * w / trades.length).toFixed(0)}%`);
console.log("\n--- PER YEAR ---  year | n | WR% | PnL$");
for (const y of Object.keys(yr).sort()) { const o = yr[y]; console.log(`  ${y} | ${o.n} | ${(100 * o.w / o.n).toFixed(0)}% | ${o.pnl >= 0 ? "+" : ""}${o.pnl.toFixed(2)}`); }
console.log("\n--- PER MONTH (chỉ tháng có lệnh) ---  month | n | PnL$");
for (const m of Object.keys(ym).sort()) { const o = ym[m]; console.log(`  ${m} | ${o.n} | ${o.pnl >= 0 ? "+" : ""}${o.pnl.toFixed(2)}`); }
