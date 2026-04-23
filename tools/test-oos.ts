/**
 * test-oos.ts
 *
 * Out-of-sample test cho 3 rule flipped top tier + tính maxDD + consLosses.
 * Hold-out: 90 ngày gần nhất (từ 2026-01-22 → nay, xấp xỉ).
 *
 * Rules test:
 *   - 4h flipped-from-4h-rank2  (forceSide SHORT, no HTF, +3/-10, WR claim 63.6%)
 *   - 1d flipped-from-1d-rank1  (forceSide SHORT, no HTF, +10/-10, WR claim 55%)
 *   - 1h flipped-from-1h-rank19 (forceSide LONG, HTF far_match invertedFromFlip, +1.5/-10, WR claim 68.6%)
 *
 * Note: HTF invertedFromFlip → want = OPPOSITE side trend (replicate backtest semantic).
 */
import { readFileSync } from "fs";
import { join } from "path";
import { calcMACDSeries, calcEMASeries, calcRSISeriesAligned } from "../utils/indicators";

const BINANCE = "https://api.binance.com/api/v3";
const OOS_DAYS = 90;
const NOW = Date.now();
const OOS_START = NOW - OOS_DAYS * 24 * 3600 * 1000;

interface Candle { time:number; open:number; high:number; low:number; close:number; volume:number; }

async function fetchKlines(interval: string, total: number): Promise<Candle[]> {
  const all: Candle[] = []; let endTime: number | undefined;
  while (all.length < total) {
    const limit = Math.min(1000, total - all.length);
    const params = new URLSearchParams({ symbol: "BTCUSDT", interval, limit: String(limit) });
    if (endTime) params.set("endTime", String(endTime));
    const res = await fetch(`${BINANCE}/klines?${params}`);
    const data: any[] = await res.json();
    if (!Array.isArray(data) || !data.length) break;
    const batch = data.map((k:any)=>({time:+k[0],open:+k[1],high:+k[2],low:+k[3],close:+k[4],volume:+k[5]}));
    all.unshift(...batch); endTime = batch[0].time-1;
    await new Promise(r=>setTimeout(r,80));
  }
  const m = new Map<number,Candle>(); for (const c of all) m.set(c.time,c);
  return [...m.values()].sort((a,b)=>a.time-b.time);
}
function trendFromEMA(price:number, ema:number|null): "UP"|"DOWN"|"FLAT" {
  if (ema==null) return "FLAT";
  const d = (price-ema)/ema*100;
  return d>0.3 ? "UP" : d<-0.3 ? "DOWN" : "FLAT";
}
function idxAt(arr:Candle[], t:number):number {
  let lo=0, hi=arr.length-1, ans=-1;
  while (lo<=hi) { const m=(lo+hi)>>1; if (arr[m].time<=t) { ans=m; lo=m+1; } else hi=m-1; }
  return ans;
}
function simulate(c:Candle[], idx:number, entry:number, side:"LONG"|"SHORT", tp:number, sl:number, maxHold=100) {
  const tpP = side==="LONG" ? entry*(1+tp/100) : entry*(1-tp/100);
  const slP = side==="LONG" ? entry*(1-sl/100) : entry*(1+sl/100);
  for (let i=idx+1; i<Math.min(idx+1+maxHold, c.length); i++) {
    if (side==="LONG") { if (c[i].low<=slP) return "LOSS"; if (c[i].high>=tpP) return "WIN"; }
    else              { if (c[i].high>=slP) return "LOSS"; if (c[i].low<=tpP) return "WIN"; }
  }
  return "TIMEOUT";
}

// Tính maxDD + maxConsecutiveLosses từ chuỗi kết quả trade
function seriesStats(results: ("WIN"|"LOSS"|"TIMEOUT")[], tp:number, sl:number, lev:number) {
  let equity = 0, peak = 0, maxDD = 0, consL = 0, maxConsL = 0;
  const fee = 0.08 * lev;
  for (const r of results) {
    const pnl = r==="WIN" ? tp*lev - fee : r==="LOSS" ? -sl*lev - fee : -fee;
    equity += pnl;
    peak = Math.max(peak, equity);
    maxDD = Math.min(maxDD, equity - peak);
    if (r==="LOSS") { consL++; maxConsL = Math.max(maxConsL, consL); }
    else if (r==="WIN") consL = 0;
  }
  return { maxDD: Math.round(maxDD), maxConsL, finalEquity: Math.round(equity) };
}

async function computeDivergence(closes: number[], period = 14): Promise<(("BULL"|"BEAR"|null))[]> {
  const rsi = calcRSISeriesAligned(closes, period);
  const out: (("BULL"|"BEAR"|null))[] = new Array(closes.length).fill(null);
  for (let i=period+5; i<closes.length; i++) {
    // simple div: price makes new low but rsi doesn't (bull); or price new high but rsi doesn't (bear)
    const lookback = 10;
    let priceLow = Infinity, priceHigh = -Infinity, rsiLow = Infinity, rsiHigh = -Infinity;
    for (let j=i-lookback; j<i; j++) {
      if (closes[j] < priceLow) priceLow = closes[j];
      if (closes[j] > priceHigh) priceHigh = closes[j];
      if (rsi[j]!==null) {
        if (rsi[j]! < rsiLow) rsiLow = rsi[j]!;
        if (rsi[j]! > rsiHigh) rsiHigh = rsi[j]!;
      }
    }
    if (rsi[i]===null) continue;
    if (closes[i] < priceLow && rsi[i]! > rsiLow) out[i] = "BULL";
    else if (closes[i] > priceHigh && rsi[i]! < rsiHigh) out[i] = "BEAR";
  }
  return out;
}

async function testRule(
  name: string, tfKey: string, rule: any,
  candles: Candle[], htfNear: Candle[], htfFar: Candle[]
) {
  const cfg = rule.config;
  const side: "LONG"|"SHORT" = cfg.forceSide;
  const tp = cfg.targetPct, sl = cfg.stopPct, lev = cfg.leverage || 10, maxHold = cfg.maxHoldBars || 100;
  const required: string[] = cfg.requiredConditions || [];

  // HTF filter (with invertedFromFlip)
  const htfMode = cfg.htfTrendFilter?.mode;
  const htfInv = cfg.htfTrendFilter?.invertedFromFlip === true;
  const htfBaseWantSide: "LONG"|"SHORT" = side;
  const htfWantSide: "LONG"|"SHORT" = htfInv ? (side==="LONG"?"SHORT":"LONG") : htfBaseWantSide;
  const htfWant = htfWantSide==="LONG" ? "UP" : "DOWN";

  // candleReversalFilter (with invertedFromFlip)
  const crf = cfg.candleReversalFilter;
  const crfInv = crf?.invertedFromFlip === true;
  const crfBaseWant = side==="LONG" ? "UP_REVERSAL" : "DOWN_REVERSAL";
  const crfWant = crfInv ? (crfBaseWant==="UP_REVERSAL"?"DOWN_REVERSAL":"UP_REVERSAL") : crfBaseWant;

  // emaPosFilter (side-agnostic)
  const emaPos = cfg.emaPosFilter; // "above" | "below" | undefined

  // origSide for required-condition semantics (divergence/macdCross was originally coded for origSide)
  const isFlipped = !!rule.stats?.flippedFrom;
  const origSide: "LONG"|"SHORT" = isFlipped ? (side==="LONG"?"SHORT":"LONG") : side;

  const closes = candles.map(x=>x.close);
  const macd = calcMACDSeries(closes);
  const ema50 = calcEMASeries(closes, 50);
  const ema50Near = calcEMASeries(htfNear.map(x=>x.close), 50);
  const ema50Far = calcEMASeries(htfFar.map(x=>x.close), 50);
  const div = required.includes("divergence") ? await computeDivergence(closes, 14) : null;

  const TF_MIN: Record<string, number> = { "1h":60, "4h":240, "1d":1440 };
  const tfMin = TF_MIN[tfKey] || 60;

  const results: ("WIN"|"LOSS"|"TIMEOUT")[] = [];
  let entries = 0, totalBars = 0;
  const skipReasons = { crf:0, ema:0, macd:0, div:0, htf:0 };

  for (let i=50; i<candles.length-maxHold; i++) {
    const c = candles[i];
    if (c.time < OOS_START) continue;
    totalBars++;
    const price = closes[i];

    // candleReversalFilter — 2 candles back
    if (crf) {
      if (i < 1) continue;
      const prev = candles[i-1], curr = candles[i];
      const prevBull = prev.close >= prev.open;
      const currBull = curr.close >= curr.open;
      const rev = prevBull===currBull ? null : (!prevBull && currBull ? "UP_REVERSAL" : "DOWN_REVERSAL");
      if (rev !== crfWant) { skipReasons.crf++; continue; }
    }

    // emaPosFilter
    if (emaPos && ema50[i]!=null) {
      const above = price >= ema50[i]!;
      if (emaPos==="above" && !above) { skipReasons.ema++; continue; }
      if (emaPos==="below" && above)  { skipReasons.ema++; continue; }
    }

    // Required conditions (use origSide semantic because backtest generated entries on origSide)
    if (required.includes("macdCross")) {
      const cur = macd.histogram[i], prev = i>0 ? macd.histogram[i-1] : null;
      if (cur===null || prev===null) { skipReasons.macd++; continue; }
      if (origSide==="LONG" && !(prev<0 && cur>=0)) { skipReasons.macd++; continue; }
      if (origSide==="SHORT" && !(prev>0 && cur<=0)) { skipReasons.macd++; continue; }
    }
    if (required.includes("divergence") && div) {
      const d = div[i];
      if (origSide==="LONG" && d!=="BULL") { skipReasons.div++; continue; }
      if (origSide==="SHORT" && d!=="BEAR") { skipReasons.div++; continue; }
    }

    // HTF filter
    if (htfMode) {
      const t = c.time + tfMin*60*1000 - 1;
      const ni = idxAt(htfNear, t), fi = idxAt(htfFar, t);
      if (ni<0 || fi<0) continue;
      const nt = trendFromEMA(htfNear[ni].close, ema50Near[ni]);
      const ft = trendFromEMA(htfFar[fi].close, ema50Far[fi]);
      if (htfMode==="near_match" && nt!==htfWant) { skipReasons.htf++; continue; }
      if (htfMode==="far_match" && ft!==htfWant)   { skipReasons.htf++; continue; }
      if (htfMode==="both_match" && (nt!==htfWant || ft!==htfWant)) { skipReasons.htf++; continue; }
    }

    entries++;
    const rs = simulate(candles, i, price, side, tp, sl, maxHold);
    results.push(rs as any);
  }

  const w = results.filter(r=>r==="WIN").length;
  const l = results.filter(r=>r==="LOSS").length;
  const t = results.filter(r=>r==="TIMEOUT").length;
  const n = results.length;
  const wr = n>0 ? w/n*100 : 0;
  const pf = l>0 ? (w*tp)/(l*sl) : (w>0?999:0);
  const ss = seriesStats(results, tp, sl, lev);
  const beWR = sl/(tp+sl)*100;

  console.log(`\n╔═══ ${name} ═══`);
  console.log(`  Rule: ${tfKey} ${side} +${tp}/-${sl} lev${lev}`);
  console.log(`  Filters: CRF=${crf?`${crfWant}${crfInv?'(inv)':''}`:'-'} emaPos=${emaPos||'-'} req=[${required.join(',')}] HTF=${htfMode||'-'}${htfInv?'(inv)':''}`);
  console.log(`  Skip reasons: CRF=${skipReasons.crf} ema=${skipReasons.ema} macd=${skipReasons.macd} div=${skipReasons.div} htf=${skipReasons.htf}`);
  console.log(`  OOS bars:        ${totalBars}`);
  console.log(`  Entries qualified: ${entries}`);
  console.log(`  Trades (N):      ${n}`);
  console.log(`  Wins/Losses/TO:  ${w} / ${l} / ${t}`);
  console.log(`  WR:              ${wr.toFixed(1)}% (BE-WR ${beWR.toFixed(1)}%, edge ${(wr-beWR).toFixed(1)}%)`);
  console.log(`  PF:              ${pf.toFixed(2)}`);
  console.log(`  Final equity:    ${ss.finalEquity>=0?'+':''}${ss.finalEquity}%`);
  console.log(`  Max drawdown:    ${ss.maxDD}%`);
  console.log(`  Max consec loss: ${ss.maxConsL}`);
}

async function run() {
  console.log(`=== OOS Test — last ${OOS_DAYS} days (from ${new Date(OOS_START).toISOString().slice(0,10)}) ===`);
  const hardPath = join(__dirname, "..", "assets", "hard_rules.json");
  const h = JSON.parse(readFileSync(hardPath, "utf8"));

  // Pick 3 flipped rules (skip disabled)
  const picks: Array<{name:string, tfKey:string, htfNear:string, htfFar:string}> = [
    { name: "4h flipped rank10 SHORT (was rank2 LONG) GOLD", tfKey: "4h", htfNear: "1d", htfFar: "1w" },
    { name: "1d flipped rank9 SHORT (was rank1 LONG) SILVER", tfKey: "1d", htfNear: "1w", htfFar: "1w" },
    { name: "1h flipped rank41 LONG (was rank19 SHORT) GOLD", tfKey: "1h", htfNear: "4h", htfFar: "1d" },
  ];

  const neededTF = new Set<string>();
  for (const p of picks) { neededTF.add(p.tfKey); neededTF.add(p.htfNear); neededTF.add(p.htfFar); }
  const TF_MIN: Record<string, number> = { "1h":60, "4h":240, "1d":1440, "1w":10080 };
  const klines: Record<string, Candle[]> = {};
  for (const tf of neededTF) {
    const count = Math.max(500, Math.ceil((OOS_DAYS * 24 * 60 / TF_MIN[tf]) + 200));
    console.log(`Fetching ${tf} (${count} candles)...`);
    klines[tf] = await fetchKlines(tf, count);
  }

  for (const p of picks) {
    const rules = h.tfs[p.tfKey].rules;
    const rule = rules.find((r:any)=> r.source && r.source.startsWith("flipped-from-") && !r.config?.disabled);
    if (!rule) { console.log(`\n⏭️  ${p.name} — no active flipped rule found`); continue; }
    await testRule(p.name, p.tfKey, rule, klines[p.tfKey], klines[p.htfNear], klines[p.htfFar]);
  }
}

run().catch(e=>{ console.error(e); process.exit(1); });
