/**
 * gate-now.mjs — fetch LIVE Binance futures klines, evaluate why each live rule isn't entering.
 * champion BTC4h gate + stochbreak EMA200d filter + hedge01 regime. Uses real current indicator values.
 */
import { ema, rsi, atr, adxDi, CHAMPION } from "/Users/lap16116/BTC_PC/btc-trader-server/dist/engine/champion.js";

async function kl(sym, interval, limit) {
  const u = `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${interval}&limit=${limit}`;
  const r = await fetch(u);
  if (!r.ok) throw new Error(`fetch ${interval} ${r.status}`);
  const j = await r.json();
  return j.map(c => ({ time: c[0], open: +c[1], high: +c[2], low: +c[3], close: +c[4] }));
}
const lastClosed = a => a.slice(0, -1); // drop forming bar

const b4all = await kl("BTCUSDT", "4h", 400);
const b1dall = await kl("BTCUSDT", "1d", 300);
const b1all = await kl("BTCUSDT", "1h", 300);
const b4 = lastClosed(b4all), b1d = lastClosed(b1dall), b1 = lastClosed(b1all);

const c4 = b4.map(b => b.close);
const e200_4 = ema(c4, 200), e20_4 = ema(c4, 20);
const A = atr(b4, 14), { adx, pdi, mdi } = adxDi(b4, 14);
const i = c4.length - 1;
const cd = b1d.map(b => b.close); const e200d = ema(cd, 200);
const e2d = e200d[e200d.length - 1];
const price = c4[i];

console.log(`=== GATE NOW (live Binance futures) — ${new Date().toISOString().slice(0,16)} ===`);
console.log(`BTC 4h close=$${price.toFixed(0)}  EMA200(4h)=$${e200_4[i].toFixed(0)}  EMA200(1d)=$${e2d.toFixed(0)}  ADX=${adx[i]?.toFixed(1)}  +DI=${pdi[i]?.toFixed(1)} -DI=${mdi[i]?.toFixed(1)}\n`);

const cfg = CHAMPION.btc4h;
console.log("--- CHAMPION BTC4h gate (cần PASS HẾT mới vào) ---");
const checks = [
  [`close > EMA200(4h)`, price > e200_4[i], `${price.toFixed(0)} > ${e200_4[i].toFixed(0)}`],
  [`close >= EMA200d × ${cfg.bg}`, price >= e2d * cfg.bg, `${price.toFixed(0)} >= ${(e2d*cfg.bg).toFixed(0)}`],
  [`ADX > ${cfg.adx}`, adx[i] > cfg.adx, `${adx[i]?.toFixed(1)} > ${cfg.adx}`],
  [`+DI > -DI × ${cfg.diR}`, pdi[i] > mdi[i] * cfg.diR, `${pdi[i]?.toFixed(1)} > ${(mdi[i]*cfg.diR).toFixed(1)}`],
];
for (const [name, pass, detail] of checks) console.log(`  ${pass ? "✅" : "❌"} ${name}  (${detail})`);
console.log(`  => champion ${checks.every(c=>c[1]) ? "WOULD ENTER" : "SIT OUT (gate fail)"}\n`);

// stochbreak filter: 1h close > EMA200(daily)
const c1last = b1[b1.length-1].close;
console.log("--- STOCHBREAK trend filter (chỉ LONG khi 1h close > EMA200d) ---");
console.log(`  ${c1last > e2d ? "✅ pass" : "❌ BLOCK"} 1h close ${c1last.toFixed(0)} ${c1last>e2d?">":"<="} EMA200d ${e2d.toFixed(0)}`);
console.log(`  => stochbreak ${c1last>e2d ? "có thể LONG nếu K<20+mom" : "SIT OUT (dưới EMA200d → filter chặn mọi LONG)"}\n`);

// regime (hedge01 RANGE-only): detectRegime on daily
const sma = (arr,n,p)=>{if(n<p-1)return null;let s=0;for(let k=n-p+1;k<=n;k++)s+=arr[k];return s/p;};
const nD = cd.length-1; const ma200=sma(cd,nD,200), ma50=sma(cd,nD,50);
let ar=0; for(let k=nD-19;k<=nD;k++) ar+=(b1d[k].high-b1d[k].low)/b1d[k].close; ar/=20;
let regime = cd[nD]<ma200?"BEAR":(cd[nD]>ma50&&ma50>ma200&&ar>0.04?"BULL":"RANGE");
console.log("--- HEDGE01 regime (RANGE-only mới LONG) ---");
console.log(`  daily close=${cd[nD].toFixed(0)} MA200=${ma200.toFixed(0)} MA50=${ma50.toFixed(0)} avgRange20=${(ar*100).toFixed(2)}% → regime=${regime}`);
console.log(`  => hedge01 ${regime==="RANGE" ? "có thể LONG (nếu ADX/EMA/ATR/vol gate pass)" : "SIT OUT (không phải RANGE)"}`);
