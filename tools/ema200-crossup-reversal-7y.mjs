/**
 * ema200-crossup-reversal-7y.mjs
 * Câu hỏi Tommy: khi BTC cắt LÊN EMA200 (daily, từ bear sang), market có ĐẢO CHIỀU thật
 * (trend tăng bền) hay chỉ whipsaw (cắt lên rồi rớt lại)? = đo chất lượng tín hiệu re-entry champion.
 *
 * Event = close[i-1] < ema200[i-1] && close[i] >= ema200[i] (cross-up trên CLOSED bar).
 * Đo per event:
 *   - forward return close→close +7/+14/+30/+60/+90d
 *   - "giữ được" = sau N ngày close VẪN ≥ ema200? (bền vs whipsaw)
 *   - thời gian tới lần rớt lại dưới ema200 (survival)
 * So với BASE RATE (forward return ngẫu nhiên mọi ngày) → cross-up có hơn random không.
 * Cross-asset BTC/ETH/SOL. Honest: KHÔNG cherry-pick, report cả median + win-rate + base-rate.
 */
import { readFileSync } from "fs";
const C = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/";
const H1D = 24 * 3600e3;
const load = f => JSON.parse(readFileSync(C + f)).sort((a, b) => a.time - b.time);
const build = (raw, ms) => { const b = new Map(); for (const c of raw) { const k = Math.floor(c.time / ms); const o = b.get(k); if (!o) b.set(k, { time: k * ms, open: c.open, close: c.close, high: c.high, low: c.low }); else { o.high = Math.max(o.high, c.high); o.low = Math.min(o.low, c.low); o.close = c.close; } } return [...b.keys()].sort((a, b) => a - b).map(k => b.get(k)); };
function ema(arr, p) { const k = 2 / (p + 1); const o = new Array(arr.length).fill(null); let prev; for (let i = 0; i < arr.length; i++) { if (i < p - 1) continue; if (prev === undefined) { let s = 0; for (let j = i - p + 1; j <= i; j++) s += arr[j]; prev = s / p; } else prev = arr[i] * k + prev * (1 - k); o[i] = prev; } return o; }
const median = a => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;

const HOR = [7, 14, 30, 60, 90];
const ASSETS = [
  { name: "BTC", file: "binance-1h-7y.json" },
  { name: "ETH", file: "binance-eth-1h-7y.json" },
  { name: "SOL", file: "binance-sol-5m-3y.json" },
];

for (const asset of ASSETS) {
  let raw; try { raw = load(asset.file); } catch { console.log(`${asset.name}: NO DATA\n`); continue; }
  const b = build(raw, H1D);
  const c = b.map(x => x.close);
  const e = ema(c, 200);
  // events
  const events = [];
  for (let i = 1; i < c.length; i++) {
    if (e[i] === null || e[i - 1] === null) continue;
    if (c[i - 1] < e[i - 1] && c[i] >= e[i]) events.push(i);
  }
  // base rate: forward return mọi ngày (có ema)
  const baseStart = e.findIndex(x => x !== null);
  console.log(`══ ${asset.name} ══  (${b.length} ngày, ${events.length} lần cắt-lên EMA200)`);
  console.log(`horizon | crossUp medRet  meanRet  winRate | BASE medRet winRate | giữ≥EMA200 sau N ngày`);
  for (const h of HOR) {
    const cr = [], hold = [];
    for (const i of events) {
      if (i + h >= c.length) continue;
      cr.push((c[i + h] - c[i]) / c[i] * 100);
      hold.push(c[i + h] >= e[i + h] ? 1 : 0);
    }
    // base
    const base = [];
    for (let i = baseStart; i + h < c.length; i++) base.push((c[i + h] - c[i]) / c[i] * 100);
    const wr = a => (a.filter(x => x > 0).length / a.length * 100);
    const holdPct = hold.length ? (mean(hold) * 100) : NaN;
    console.log(
      `+${String(h).padStart(2)}d   | ` +
      `${median(cr).toFixed(1).padStart(7)}% ${mean(cr).toFixed(1).padStart(7)}% ${wr(cr).toFixed(0).padStart(4)}%  | ` +
      `${median(base).toFixed(1).padStart(6)}% ${wr(base).toFixed(0).padStart(4)}%  | ` +
      `${holdPct.toFixed(0)}%`
    );
  }
  // survival: bao lâu tới khi rớt lại dưới ema200
  const surv = [];
  for (const i of events) {
    let d = 0; for (let j = i + 1; j < c.length; j++) { if (c[j] < e[j]) break; d++; }
    surv.push(d);
  }
  console.log(`survival tới lần rớt lại dưới EMA200: median ${median(surv)}d, mean ${mean(surv).toFixed(0)}d, max ${Math.max(...surv)}d`);
  // whipsaw: % event rớt lại dưới ema200 trong ≤7 ngày
  const whip = surv.filter(d => d <= 7).length / surv.length * 100;
  console.log(`whipsaw (rớt lại ≤7d) = ${whip.toFixed(0)}% | bền (giữ >30d) = ${(surv.filter(d => d > 30).length / surv.length * 100).toFixed(0)}%\n`);
}
