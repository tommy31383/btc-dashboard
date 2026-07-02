/**
 * catastrophic-floor-calc.mjs — tính khoảng-cách-giá STOP_MARKET thật của catastrophicStop.ts
 * và đối chiếu lịch sử BTC để xem ruin-floor có fire NHẦM trong biến động thường không.
 * Logic code: dist = wallet*RUIN_PCT/qty ; stopPrice=entry-dist (LONG) ; dist% = floorUsd/notional.
 */
import { readFileSync } from "fs";
const C = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/";
const WALLET = 102, PRICE = 105000;
const raw = JSON.parse(readFileSync(C + "binance-1h-7y.json")).sort((a, b) => a.time - b.time);

// ── 1. dist% table theo qty × RUIN_PCT ──
console.log(`Ví $${WALLET}, BTC ~$${PRICE}. STOP đặt CÁCH entry bao nhiêu % (=floorUsd/notional):\n`);
console.log(`qty(BTC) notional   | floor10%($10.2) floor15%($15.3) floor20%($20.4)`);
for (const qty of [0.001, 0.002, 0.004, 0.008, 0.012, 0.02, 0.024]) {
  const notional = qty * PRICE;
  const row = [0.10, 0.15, 0.20].map(r => {
    const distPct = (WALLET * r) / notional * 100;
    return `${distPct.toFixed(1)}%`.padStart(8);
  });
  console.log(`${qty.toFixed(3)}   $${notional.toFixed(0).padStart(5)}    |   ${row[0]}        ${row[1]}        ${row[2]}`);
}

// ── 2. Lịch sử BTC: tần suất rớt ≥X% trong cửa sổ hold (champion 4h×70=~280h, hedge01 trailing ~vài ngày) ──
// Đo: từ MỖI giờ, trong 168h tới (7 ngày), max drop từ giá entry = bao nhiêu? Phân phối.
const c = raw.map(b => b.close), lo = raw.map(b => b.low);
const WIN = 168; // 7 ngày (rộng hơn hold champion)
const drops = [];
for (let i = 0; i < c.length - WIN; i++) {
  let mn = c[i];
  for (let k = i + 1; k <= i + WIN; k++) if (lo[k] < mn) mn = lo[k];
  drops.push((c[i] - mn) / c[i] * 100);
}
drops.sort((a, b) => a - b);
const pct = p => drops[Math.floor(drops.length * p)].toFixed(1);
console.log(`\nLịch sử BTC 7y — max drawdown từ 1 entry bất kỳ trong 7 ngày tới (n=${drops.length}):`);
console.log(`  median ${pct(0.5)}%  | p75 ${pct(0.75)}%  | p90 ${pct(0.90)}%  | p95 ${pct(0.95)}%  | p99 ${pct(0.99)}%  | max ${drops[drops.length-1].toFixed(1)}%`);
// P(drop >= threshold)
for (const th of [10, 15, 20, 25, 30]) {
  const f = drops.filter(d => d >= th).length / drops.length * 100;
  console.log(`  P(drop ≥ ${th}% trong 7 ngày) = ${f.toFixed(1)}%  → STOP đặt ở ${th}% sẽ fire trong ${f.toFixed(1)}% số entry`);
}
