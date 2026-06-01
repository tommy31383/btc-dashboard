/**
 * probe-hedge05-grid-sens-7y.mjs  (anh Tommy 2026-06-01)
 * VALIDATE GRID_FLAT rescue: sweep g/N/tp2/H — vùng phẳng robust hay góc overfit?
 * + per-year (2022 bear sống sao) + tail (worst campaign, hardStops, max qty multiple).
 * PASS = RA>0 & WF retain≥40% & recent ROI>0 & worst > -2000 (tail bounded).
 */
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const INITIAL = 100000, FEE_SIDE = 0.05 / 100, Q0 = 0.03, HOUR = 3600000;
const c5 = JSON.parse(readFileSync(join(__dirname, "..", ".cache", "binance-5m-7y.json"), "utf8"));
const hMap = new Map();
for (let i = 0; i < c5.length; i++) { const b = c5[i], k = Math.floor(b.time / HOUR); let h = hMap.get(k); if (!h) hMap.set(k, { t: k * HOUR, o: b.open, h: b.high, l: b.low, c: b.close }); else { if (b.high > h.h) h.h = b.high; if (b.low < h.l) h.l = b.low; h.c = b.close; } }
const C1 = [...hMap.values()].sort((a, b) => a.t - b.t);
const M = C1.length, H = C1.map(x => x.h), L = C1.map(x => x.l), CL = C1.map(x => x.c);
function rsiS(c, p) { const o = new Array(c.length).fill(null); if (c.length <= p) return o; let g = 0, l = 0; for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; if (d >= 0) g += d; else l -= d; } let ag = g / p, al = l / p; o[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); for (let i = p + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; ag = (ag * (p - 1) + Math.max(d, 0)) / p; al = (al * (p - 1) + Math.max(-d, 0)) / p; o[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); } return o; }
function atrS(p) { const tr = new Array(M).fill(0); for (let i = 1; i < M; i++) tr[i] = Math.max(H[i] - L[i], Math.abs(H[i] - CL[i - 1]), Math.abs(L[i] - CL[i - 1])); const o = new Array(M).fill(null); let s = 0; for (let i = 1; i <= p; i++) s += tr[i]; o[p] = s / p; for (let i = p + 1; i < M; i++) o[i] = (o[i - 1] * (p - 1) + tr[i]) / p; return o; }
const RSI = rsiS(CL, 14), ATR = atrS(14), WARM = 50;
const isEntry = i => RSI[i - 1] != null && RSI[i - 1] >= 35 && RSI[i] < 35;
function sim(g, N, tp2, Hh, iStart, iEnd) {
  let wallet = INITIAL, peak = INITIAL, trough = INITIAL, lastEntry = -1e9, camp = 0, campWin = 0, worst = 0, hardStops = 0, maxQtyMult = 1; const perYear = {};
  let a = null;
  for (let i = Math.max(iStart, WARM); i < iEnd; i++) {
    const bar = C1[i], price = bar.c, atr = ATR[i] || 0, yr = new Date(bar.t).getUTCFullYear();
    if (a) {
      const nextLvl = a.firstEntry - (a.adds + 1) * g * a.atr0;
      if (a.adds < N && bar.l <= nextLvl) { a.cost += Q0 * nextLvl; a.qty += Q0; a.adds++; wallet -= Q0 * nextLvl * FEE_SIDE; if (a.qty / Q0 > maxQtyMult) maxQtyMult = a.qty / Q0; }
      const avg = a.cost / a.qty, tpPx = avg + tp2 * a.atr0, hardPx = a.firstEntry - Hh * a.atr0;
      let cx = null, hard = false;
      if (bar.l <= hardPx) { cx = hardPx; hard = true; } else if (bar.h >= tpPx) cx = tpPx;
      if (cx != null) { const pnl = a.qty * (cx - avg) - a.qty * cx * FEE_SIDE; wallet += pnl; camp++; if (pnl >= 0) campWin++; if (pnl < worst) worst = pnl; if (hard) hardStops++; perYear[yr] = (perYear[yr] || 0) + pnl; a = null; }
    }
    if (!a && atr > 0 && (i - lastEntry >= 2) && isEntry(i)) { lastEntry = i; a = { firstEntry: price, cost: Q0 * price, qty: Q0, adds: 0, atr0: atr }; wallet -= Q0 * price * FEE_SIDE; }
    let up = a ? a.qty * (price - a.cost / a.qty) : 0; const eq = wallet + up; if (eq > peak) peak = eq; if (eq < trough) trough = eq;
  }
  if (a) { wallet += a.qty * (CL[iEnd - 1] - a.cost / a.qty); }
  const roi = (wallet - INITIAL) / INITIAL * 100, ddPct = peak > trough ? (peak - trough) / peak * 100 : 0;
  const yrsPos = Object.values(perYear).filter(v => v >= 0).length, yrs = Object.keys(perYear).length;
  return { roi, ddPct, ra: ddPct > 0 ? roi / ddPct : roi, wr: camp ? campWin / camp * 100 : 0, camp, worst, hardStops, maxQtyMult, perYear, yrsPos, yrs };
}
const split = Math.floor(M * 0.7), recentTs = Date.UTC(2025, 0, 1);
let recentIdx = C1.findIndex(x => x.t >= recentTs);
console.log(`\n=== VALIDATE GRID_FLAT rescue · sweep · BTC 7y ===`);
console.log(`PASS = RA>0 & WF retain≥40% & recent>0 & worst>-$2000 (đuôi bounded)\n`);
let pass = 0, total = 0; const passed = [];
for (const g of [0.8, 1.2, 1.6]) for (const N of [3, 5, 7]) for (const tp2 of [0.3, 0.5, 0.8]) for (const Hh of [6, 8, 10]) {
  total++;
  const full = sim(g, N, tp2, Hh, 0, M), trn = sim(g, N, tp2, Hh, 0, split), tst = sim(g, N, tp2, Hh, split, M), rec = sim(g, N, tp2, Hh, recentIdx, M);
  const retain = trn.ra > 0 ? tst.ra / trn.ra : (tst.ra >= 0 ? 1 : 0);
  const ok = full.ra > 0 && retain >= 0.4 && rec.roi > 0 && full.worst > -2000;
  if (ok) { pass++; passed.push({ g, N, tp2, Hh, full, retain, rec }); }
}
console.log(`→ ${pass}/${total} cấu hình PASS (${(pass / total * 100).toFixed(0)}%). ${pass >= total * 0.5 ? "✅ VÙNG PHẲNG ROBUST" : pass >= total * 0.25 ? "⚠️ BÁN-ỔN" : "❌ GÓC OVERFIT"}\n`);
console.log(`Top 8 PASS theo RA:`);
console.log(`g   | N | tp2 | H  | RA full | DD%  | WR%  | worst$ | hardSL | maxQ× | stab | retain | recROI`);
console.log(`----|---|-----|----|---------|------|------|--------|--------|-------|------|--------|-------`);
for (const p of passed.sort((a, b) => b.full.ra - a.full.ra).slice(0, 8))
  console.log(`${p.g.toFixed(1)} | ${p.N} | ${p.tp2.toFixed(1)} | ${String(p.Hh).padStart(2)} | ${(p.full.ra >= 0 ? "+" : "")}${p.full.ra.toFixed(3).padStart(6)} | ${p.full.ddPct.toFixed(1).padStart(4)} | ${p.full.wr.toFixed(0).padStart(4)} | ${p.full.worst.toFixed(0).padStart(6)} | ${String(p.full.hardStops).padStart(6)} | ${p.full.maxQtyMult.toFixed(0).padStart(4)}× | ${p.full.yrsPos}/${p.full.yrs}  | ${(p.retain * 100).toFixed(0).padStart(5)}% | ${(p.rec.roi >= 0 ? "+" : "")}${p.rec.roi.toFixed(1)}%`);
// per-year center
const c = sim(1.2, 5, 0.5, 8, 0, M);
console.log(`\nCenter (g1.2/N5/tp0.5/H8) per-year (đặc biệt 2022 bear):`);
console.log("  " + Object.entries(c.perYear).map(([y, v]) => `${y}:${v >= 0 ? "+" : ""}$${(v / 1000).toFixed(1)}k`).join("  "));
console.log(`  worst campaign -$${(-c.worst).toFixed(0)} · hardStops ${c.hardStops}/7y · max qty ${c.maxQtyMult}× base · DD ${c.ddPct.toFixed(1)}%`);
console.log(`\n⚠️ Lưu ý fill: backtest grid LẠC QUAN (add+TP cùng bar, không slippage trên add). Live sẽ tệ hơn chút.`);
console.log(`[done]`);
