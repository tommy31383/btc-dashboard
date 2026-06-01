/**
 * backtest-rules-quaidij.ts — backtest 3 rules "quái dị" trên 2 năm BTC data.
 *
 * Rules:
 *   omni01: 8 micro-signals (TimeOfDay, RoundNumber, VWAP, 5-Candle Fade, VolSpike, Weekend, BB Compress, VolSqueeze)
 *   chaos01: Multi-TF fractal confirmation (1m/5m/15m/1h/4h, score 3-5)
 *   kraken01: 5-strategy ensemble vote (Trend/MeanRev/Breakout/Momentum/Vol)
 *
 * Period: 2 năm cuối (2024-04 → 2026-04) cho relevance market hiện tại
 * Capital: $100k, fee 0.05% taker, ATR-based qty sizing
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const INITIAL_CAPITAL = 100_000;
const FEE_PCT = 0.05;
const SLICE_2Y_BARS_5M = 288 * 365 * 2;  // 5m bars in 2 years

interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; }
interface Trade {
  entryTs: number; exitTs: number;
  side: "LONG" | "SHORT"; entry: number; exit: number; qty: number; pnl: number;
  reason: string; signal: string;
}

function loadCache(tf: string): Candle[] {
  return JSON.parse(readFileSync(join(__dirname, "..", ".cache", `binance-${tf}-3y.json`), "utf8"));
}
function calcSMA(a: number[], p: number): (number | null)[] {
  const o: (number | null)[] = new Array(a.length).fill(null); if (a.length < p) return o;
  let s = 0; for (let i = 0; i < p; i++) s += a[i]; o[p - 1] = s / p;
  for (let i = p; i < a.length; i++) { s += a[i] - a[i - p]; o[i] = s / p; } return o;
}
function calcEMA(a: number[], p: number): (number | null)[] {
  const o: (number | null)[] = new Array(a.length).fill(null); if (a.length < p) return o;
  const k = 2 / (p + 1); let e = 0;
  for (let i = 0; i < p; i++) e += a[i]; e /= p; o[p - 1] = e;
  for (let i = p; i < a.length; i++) { e = a[i] * k + e * (1 - k); o[i] = e; } return o;
}
function calcStdev(a: number[], p: number, sma: (number | null)[]): (number | null)[] {
  const o: (number | null)[] = new Array(a.length).fill(null);
  for (let i = p - 1; i < a.length; i++) {
    const m = sma[i]; if (m === null) continue;
    let sq = 0; for (let j = i - p + 1; j <= i; j++) sq += (a[j] - m) ** 2; o[i] = Math.sqrt(sq / p);
  } return o;
}
function calcRSI(c: number[], p: number): (number | null)[] {
  const o: (number | null)[] = new Array(c.length).fill(null); if (c.length <= p) return o;
  let g = 0, l = 0; for (let i = 1; i <= p; i++) { const ch = c[i] - c[i - 1]; if (ch >= 0) g += ch; else l -= ch; }
  let ag = g / p, al = l / p; o[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = p + 1; i < c.length; i++) {
    const ch = c[i] - c[i - 1];
    ag = (ag * (p - 1) + Math.max(ch, 0)) / p; al = (al * (p - 1) + Math.max(-ch, 0)) / p;
    o[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  } return o;
}
function calcStochK(c: Candle[], p: number): (number | null)[] {
  const o: (number | null)[] = new Array(c.length).fill(null);
  for (let i = p - 1; i < c.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - p + 1; j <= i; j++) { if (c[j].high > hi) hi = c[j].high; if (c[j].low < lo) lo = c[j].low; }
    o[i] = hi === lo ? 50 : ((c[i].close - lo) / (hi - lo)) * 100;
  } return o;
}
function calcATR(c: Candle[], p: number): (number | null)[] {
  const o: (number | null)[] = new Array(c.length).fill(null); if (c.length <= p) return o;
  const tr: number[] = new Array(c.length).fill(0);
  for (let i = 1; i < c.length; i++) tr[i] = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
  let s = 0; for (let i = 1; i <= p; i++) s += tr[i]; o[p] = s / p;
  for (let i = p + 1; i < c.length; i++) o[i] = (o[i - 1]! * (p - 1) + tr[i]) / p; return o;
}
function calcMACDHist(c: number[]): (number | null)[] {
  const e12 = calcEMA(c, 12), e26 = calcEMA(c, 26);
  const macd: (number | null)[] = c.map((_, i) => (e12[i] != null && e26[i] != null) ? e12[i]! - e26[i]! : null);
  const v: number[] = [], m: number[] = [];
  for (let i = 0; i < macd.length; i++) if (macd[i] !== null) { v.push(macd[i]!); m.push(i); }
  const sigEma = calcEMA(v, 9);
  const signal: (number | null)[] = new Array(c.length).fill(null);
  for (let k = 0; k < sigEma.length; k++) if (sigEma[k] !== null) signal[m[k]] = sigEma[k];
  return c.map((_, i) => (macd[i] != null && signal[i] != null) ? macd[i]! - signal[i]! : null);
}
function findIdx(arr: Candle[], ts: number, hint: number = 0): number {
  let lo = hint, hi = arr.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (arr[mid].time <= ts) lo = mid; else hi = mid - 1; }
  return lo;
}

function summarize(name: string, trades: Trade[], finalWallet: number, hwm: number, lowest: number): any {
  const roi = (finalWallet - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100;
  const dd = (hwm - lowest) / hwm * 100;
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  const wr = trades.length > 0 ? wins.length / trades.length * 100 : 0;
  const avgW = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgL = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  const ra = dd > 0 ? roi / dd : (roi > 0 ? 999 : 0);
  const exp = trades.length > 0 ? (wr / 100 * avgW + (1 - wr / 100) * avgL) : 0;
  const byYear: Record<string, number> = {};
  const bySignal: Record<string, { count: number; pnl: number; wr: number }> = {};
  for (const t of trades) {
    const y = new Date(t.exitTs).toISOString().slice(0, 4);
    byYear[y] = (byYear[y] ?? 0) + t.pnl;
    if (!bySignal[t.signal]) bySignal[t.signal] = { count: 0, pnl: 0, wr: 0 };
    bySignal[t.signal].count++;
    bySignal[t.signal].pnl += t.pnl;
    if (t.pnl > 0) bySignal[t.signal].wr++;
  }
  for (const k of Object.keys(bySignal)) {
    bySignal[k].pnl = Math.round(bySignal[k].pnl);
    bySignal[k].wr = +(bySignal[k].wr / bySignal[k].count * 100).toFixed(1);
  }
  return {
    name, roi: +roi.toFixed(2), dd: +dd.toFixed(2), ra: +ra.toFixed(2),
    trades: trades.length, wr: +wr.toFixed(2),
    avgW: +avgW.toFixed(2), avgL: +avgL.toFixed(2),
    rr: avgL < 0 ? +(avgW / -avgL).toFixed(2) : 0,
    exp: +exp.toFixed(2),
    byYear: Object.fromEntries(Object.entries(byYear).map(([k, v]) => [k, Math.round(v)])),
    bySignal,
  };
}

// === Generic engine: simulate entries + ATR-based exits ===
interface Position {
  id: string; signal: string; side: "LONG" | "SHORT";
  entry: number; qty: number; entryTs: number;
  tpPx: number; slPx: number;
  expireTs?: number;  // time stop (optional)
}

function processClose(positions: Position[], bar: Candle, trades: Trade[], wallet: { w: number; hwm: number; lowest: number }): Position[] {
  const remaining: Position[] = [];
  for (const p of positions) {
    let exit = false; let reason = "";
    if (p.side === "LONG") {
      if (bar.high >= p.tpPx) { exit = true; reason = "TP"; }
      else if (bar.low <= p.slPx) { exit = true; reason = "SL"; }
    } else {
      if (bar.low <= p.tpPx) { exit = true; reason = "TP"; }
      else if (bar.high >= p.slPx) { exit = true; reason = "SL"; }
    }
    if (!exit && p.expireTs && bar.time >= p.expireTs) { exit = true; reason = "TIME"; }
    if (exit) {
      const exitPx = reason === "TP" ? p.tpPx : reason === "SL" ? p.slPx : bar.close;
      const pnl = (p.side === "LONG" ? exitPx - p.entry : p.entry - exitPx) * p.qty;
      const fee = p.qty * (p.entry + exitPx) * FEE_PCT / 100;
      const net = pnl - fee;
      wallet.w += net;
      if (wallet.w > wallet.hwm) wallet.hwm = wallet.w;
      if (wallet.w < wallet.lowest) wallet.lowest = wallet.w;
      trades.push({
        entryTs: p.entryTs, exitTs: bar.time, side: p.side,
        entry: p.entry, exit: exitPx, qty: p.qty, pnl: net,
        reason, signal: p.signal,
      });
    } else remaining.push(p);
  }
  return remaining;
}

function openPos(positions: Position[], signal: string, side: "LONG" | "SHORT", entry: number, qty: number, ts: number, tpPct: number, slPct: number, expireBarsAfter?: number): void {
  const tpPx = side === "LONG" ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100);
  const slPx = side === "LONG" ? entry * (1 - slPct / 100) : entry * (1 + slPct / 100);
  const expireTs = expireBarsAfter ? ts + expireBarsAfter * 5 * 60_000 : undefined;
  positions.push({
    id: `${signal}_${ts}`, signal, side, entry, qty, entryTs: ts,
    tpPx, slPx, expireTs,
  });
}

// === Rule 1: omni01 — 8 micro-signals ===
function runOmni01(c5: Candle[], c1h: Candle[], c4h: Candle[], startIdx: number): { trades: Trade[]; wallet: number; hwm: number; lowest: number } {
  const wallet = { w: INITIAL_CAPITAL, hwm: INITIAL_CAPITAL, lowest: INITIAL_CAPITAL };
  const trades: Trade[] = [];
  let positions: Position[] = [];

  // Indicators pre-compute
  const close5 = c5.map(b => b.close);
  const atr5 = calcATR(c5, 14);
  const ma20_5 = calcSMA(close5, 20);
  const sd20_5 = calcStdev(close5, 20, ma20_5);
  // VWAP rolling 12 bars (1h on 5m) — sum(price*vol)/sum(vol)
  const vwap1h: (number | null)[] = new Array(c5.length).fill(null);
  for (let i = 11; i < c5.length; i++) {
    let pv = 0, vv = 0;
    for (let j = i - 11; j <= i; j++) { const v = c5[j].volume ?? 0; pv += ((c5[j].high + c5[j].low + c5[j].close) / 3) * v; vv += v; }
    if (vv > 0) vwap1h[i] = pv / vv;
  }

  // Realized vol 1h (std of 1h returns over last 24h)
  let idx1h = 0;
  const cooldowns: Record<string, number> = {};
  const CD = (key: string) => (c5[0].time + 0); // placeholder, use last fire ts
  const lastFire: Record<string, number> = {};

  for (let i = Math.max(startIdx, 200); i < c5.length; i++) {
    const bar = c5[i]; const ts = bar.time; const mark = bar.close;
    positions = processClose(positions, bar, trades, wallet);
    const dateUTC = new Date(ts);
    const hour = dateUTC.getUTCHours();
    const dayOfWeek = dateUTC.getUTCDay();  // 0=Sun, 6=Sat

    // Signal 1: TimeOfDay Asian session 04-06 UTC LONG (1 fire per day max, qty 0.001, hold 4h ~ 48 bars)
    if (hour >= 4 && hour < 6) {
      const lastFireTs = lastFire["timeOfDay"] ?? 0;
      if (ts - lastFireTs > 24 * 60 * 60_000) {
        const atr = atr5[i]; if (atr && atr > 0) {
          openPos(positions, "timeOfDay", "LONG", mark, 0.05, ts, 1.5, 1.0, 48);
          lastFire["timeOfDay"] = ts;
        }
      }
    }

    // Signal 2: RoundNumber fade (±0.1% từ round $1k) — fade last 5m direction
    const nearRound = Math.abs(mark % 1000) < mark * 0.001 || Math.abs(mark % 1000 - 1000) < mark * 0.001;
    if (nearRound && i > 0) {
      const lastFireTs = lastFire["roundNum"] ?? 0;
      if (ts - lastFireTs > 60 * 60_000) {
        const prevClose = c5[i - 1].close;
        const direction5m = mark > prevClose ? "UP" : "DOWN";
        const atr = atr5[i]; if (atr && atr > 0) {
          if (direction5m === "UP") openPos(positions, "roundNum", "SHORT", mark, 0.05, ts, 0.8, 0.6, 12);
          else openPos(positions, "roundNum", "LONG", mark, 0.05, ts, 0.8, 0.6, 12);
          lastFire["roundNum"] = ts;
        }
      }
    }

    // Signal 3: VWAP extreme
    const vwap = vwap1h[i];
    if (vwap !== null) {
      const ratio = mark / vwap;
      const lastFireTs = lastFire["vwapExt"] ?? 0;
      if (ts - lastFireTs > 30 * 60_000) {
        if (ratio > 1.015) { openPos(positions, "vwapExt", "SHORT", mark, 0.05, ts, 1.0, 0.7, 24); lastFire["vwapExt"] = ts; }
        else if (ratio < 0.985) { openPos(positions, "vwapExt", "LONG", mark, 0.05, ts, 1.0, 0.7, 24); lastFire["vwapExt"] = ts; }
      }
    }

    // Signal 4: 5-candle same-color fade
    if (i >= 5) {
      let allBull = true, allBear = true;
      for (let j = i - 4; j <= i; j++) {
        if (c5[j].close <= c5[j].open) allBull = false;
        if (c5[j].close >= c5[j].open) allBear = false;
      }
      const lastFireTs = lastFire["5cFade"] ?? 0;
      if (ts - lastFireTs > 30 * 60_000) {
        if (allBull) { openPos(positions, "5cFade", "SHORT", mark, 0.1, ts, 0.8, 0.6, 12); lastFire["5cFade"] = ts; }
        else if (allBear) { openPos(positions, "5cFade", "LONG", mark, 0.1, ts, 0.8, 0.6, 12); lastFire["5cFade"] = ts; }
      }
    }

    // Signal 5: VolSpike fade — realized vol last 12 bars (1h) > 3%
    if (i >= 12) {
      let rangeSum = 0;
      for (let j = i - 11; j <= i; j++) rangeSum += (c5[j].high - c5[j].low) / c5[j].close * 100;
      const avgRangePct = rangeSum / 12;
      const lastFireTs = lastFire["volSpike"] ?? 0;
      if (avgRangePct > 0.3 && ts - lastFireTs > 60 * 60_000) {
        const prev5 = c5[i - 5]?.close ?? mark;
        const change5 = (mark - prev5) / prev5 * 100;
        const atr = atr5[i]; if (atr && atr > 0) {
          if (change5 > 1) { openPos(positions, "volSpike", "SHORT", mark, 0.05, ts, 1.0, 0.7, 24); lastFire["volSpike"] = ts; }
          else if (change5 < -1) { openPos(positions, "volSpike", "LONG", mark, 0.05, ts, 1.0, 0.7, 24); lastFire["volSpike"] = ts; }
        }
      }
    }

    // Signal 6: Weekend mean reversion fade spike
    if ((dayOfWeek === 0 || dayOfWeek === 6) && i >= 12) {
      const prev1h = c5[i - 12]?.close ?? mark;
      const change1h = (mark - prev1h) / prev1h * 100;
      const lastFireTs = lastFire["weekend"] ?? 0;
      if (Math.abs(change1h) > 2 && ts - lastFireTs > 4 * 60 * 60_000) {
        if (change1h > 2) { openPos(positions, "weekend", "SHORT", mark, 0.05, ts, 1.0, 0.7, 24); lastFire["weekend"] = ts; }
        else { openPos(positions, "weekend", "LONG", mark, 0.05, ts, 1.0, 0.7, 24); lastFire["weekend"] = ts; }
      }
    }

    // Signal 7: BB compression breakout
    if (sd20_5[i] !== null && ma20_5[i] !== null && i >= 30) {
      const bbWidth = sd20_5[i]! / ma20_5[i]! * 100;
      // 30-day rolling threshold approx: compare với recent 30 bars × 288 ~ skip, dùng absolute threshold 0.3%
      const lastFireTs = lastFire["bbCompress"] ?? 0;
      if (bbWidth < 0.15 && ts - lastFireTs > 4 * 60 * 60_000) {
        // Breakout = current close beyond BB
        const upper = ma20_5[i]! + 2 * sd20_5[i]!;
        const lower = ma20_5[i]! - 2 * sd20_5[i]!;
        if (mark > upper) { openPos(positions, "bbCompress", "LONG", mark, 0.1, ts, 2.0, 1.0, 48); lastFire["bbCompress"] = ts; }
        else if (mark < lower) { openPos(positions, "bbCompress", "SHORT", mark, 0.1, ts, 2.0, 1.0, 48); lastFire["bbCompress"] = ts; }
      }
    }

    // Signal 8: Volume squeeze — high vol but low price movement
    if (i >= 20) {
      const vols20 = c5.slice(i - 20, i + 1).map(b => b.volume ?? 0);
      const avgVol = vols20.reduce((s, v) => s + v, 0) / 21;
      const curVol = c5[i].volume ?? 0;
      const rangePct = (bar.high - bar.low) / mark * 100;
      const lastFireTs = lastFire["volSqueeze"] ?? 0;
      if (curVol > avgVol * 2 && rangePct < 0.1 && ts - lastFireTs > 60 * 60_000) {
        // Wait next bar direction — simplified: fire LONG and SHORT each
        // For backtest simplicity, fade — assume compression → reversal
        const prev1h = c5[i - 12]?.close ?? mark;
        if (mark > prev1h) { openPos(positions, "volSqueeze", "SHORT", mark, 0.05, ts, 1.5, 1.0, 24); lastFire["volSqueeze"] = ts; }
        else { openPos(positions, "volSqueeze", "LONG", mark, 0.05, ts, 1.5, 1.0, 24); lastFire["volSqueeze"] = ts; }
      }
    }
  }

  // Force close remaining
  const last = c5[c5.length - 1];
  for (const p of positions) {
    const pnl = (p.side === "LONG" ? last.close - p.entry : p.entry - last.close) * p.qty;
    wallet.w += pnl;
    trades.push({ entryTs: p.entryTs, exitTs: last.time, side: p.side, entry: p.entry, exit: last.close, qty: p.qty, pnl, reason: "FORCE", signal: p.signal });
  }
  return { trades, wallet: wallet.w, hwm: wallet.hwm, lowest: wallet.lowest };
}

// === Rule 2: chaos01 — Multi-TF fractal confirmation ===
function runChaos01(c5: Candle[], c15: Candle[], c1h: Candle[], c4h: Candle[], startIdx: number): { trades: Trade[]; wallet: number; hwm: number; lowest: number } {
  const wallet = { w: INITIAL_CAPITAL, hwm: INITIAL_CAPITAL, lowest: INITIAL_CAPITAL };
  const trades: Trade[] = [];
  let positions: Position[] = [];

  // Indicators per TF
  const close5 = c5.map(b => b.close);
  const close15 = c15.map(b => b.close);
  const close1h = c1h.map(b => b.close);
  const close4h = c4h.map(b => b.close);
  const rsi5 = calcRSI(close5, 14);  // 1m proxy → use 5m for "1m" signal
  const ma10_5 = calcSMA(close5, 10);
  const ma20_5 = calcSMA(close5, 20);
  const ma10_15 = calcSMA(close15, 10);
  const ma20_15 = calcSMA(close15, 20);
  const ma20_1h = calcSMA(close1h, 20);  // BB middle
  const sd20_1h = calcStdev(close1h, 20, ma20_1h);
  const macdH1h = calcMACDHist(close1h);
  const stoch4h = calcStochK(c4h, 14);
  const atr5 = calcATR(c5, 14);

  let idx15 = 0, idx1h = 0, idx4h = 0;
  let lastFireMs = 0;
  const COOLDOWN_MS = 4 * 60 * 60_000;

  for (let i = Math.max(startIdx, 100); i < c5.length; i++) {
    const bar = c5[i]; const ts = bar.time; const mark = bar.close;
    positions = processClose(positions, bar, trades, wallet);
    idx15 = findIdx(c15, ts, idx15);
    idx1h = findIdx(c1h, ts, idx1h);
    idx4h = findIdx(c4h, ts, idx4h);
    const idx15c = idx15 - 1; const idx1hc = idx1h - 1; const idx4hc = idx4h - 1;
    if (idx15c < 25 || idx1hc < 25 || idx4hc < 15) continue;

    let scoreLong = 0, scoreShort = 0;
    // TF1: 5m RSI cross 50
    const r5 = rsi5[i - 1]; const r5p = rsi5[i - 2];
    if (r5 !== null && r5p !== null) {
      if (r5p < 50 && r5 >= 50) scoreLong++;
      if (r5p > 50 && r5 <= 50) scoreShort++;
    }
    // TF2: 5m MA10 cross MA20
    const m10 = ma10_5[i - 1]; const m20 = ma20_5[i - 1]; const m10p = ma10_5[i - 2]; const m20p = ma20_5[i - 2];
    if (m10 !== null && m20 !== null && m10p !== null && m20p !== null) {
      if (m10p <= m20p && m10 > m20) scoreLong++;
      if (m10p >= m20p && m10 < m20) scoreShort++;
    }
    // TF3: 15m MA10 cross MA20
    const m10_15 = ma10_15[idx15c]; const m20_15 = ma20_15[idx15c];
    const m10_15p = ma10_15[idx15c - 1]; const m20_15p = ma20_15[idx15c - 1];
    if (m10_15 !== null && m20_15 !== null && m10_15p !== null && m20_15p !== null) {
      if (m10_15p <= m20_15p && m10_15 > m20_15) scoreLong++;
      if (m10_15p >= m20_15p && m10_15 < m20_15) scoreShort++;
    }
    // TF4: 1h BB middle cross + MACD direction
    const m20_1h = ma20_1h[idx1hc];
    if (m20_1h !== null) {
      const c1hClose = c1h[idx1hc].close;
      if (c1hClose > m20_1h && (macdH1h[idx1hc] ?? 0) > 0) scoreLong++;
      if (c1hClose < m20_1h && (macdH1h[idx1hc] ?? 0) < 0) scoreShort++;
    }
    // TF5: 4h Stoch K cross 50
    const sk = stoch4h[idx4hc]; const skp = stoch4h[idx4hc - 1];
    if (sk !== null && skp !== null) {
      if (skp < 50 && sk >= 50) scoreLong++;
      if (skp > 50 && sk <= 50) scoreShort++;
    }

    if (ts - lastFireMs < COOLDOWN_MS) continue;
    const atr = atr5[i];
    if (!atr || atr <= 0) continue;

    let qty = 0, side: "LONG" | "SHORT" | null = null;
    if (scoreLong >= 3) { qty = scoreLong === 5 ? 0.5 : scoreLong === 4 ? 0.3 : 0.1; side = "LONG"; }
    else if (scoreShort >= 3) { qty = scoreShort === 5 ? 0.5 : scoreShort === 4 ? 0.3 : 0.1; side = "SHORT"; }
    if (side) {
      // ATR×2 SL, ATR×3 TP → R:R 1.5
      const slPct = (atr * 2) / mark * 100;
      const tpPct = (atr * 3) / mark * 100;
      openPos(positions, `score${scoreLong + scoreShort}_${side}`, side, mark, qty, ts, tpPct, slPct, 48);
      lastFireMs = ts;
    }
  }

  const last = c5[c5.length - 1];
  for (const p of positions) {
    const pnl = (p.side === "LONG" ? last.close - p.entry : p.entry - last.close) * p.qty;
    wallet.w += pnl;
    trades.push({ entryTs: p.entryTs, exitTs: last.time, side: p.side, entry: p.entry, exit: last.close, qty: p.qty, pnl, reason: "FORCE", signal: p.signal });
  }
  return { trades, wallet: wallet.w, hwm: wallet.hwm, lowest: wallet.lowest };
}

// === Rule 3: kraken01 — 5-strategy ensemble vote ===
function runKraken01(c5: Candle[], c15: Candle[], c1h: Candle[], c4h: Candle[], startIdx: number): { trades: Trade[]; wallet: number; hwm: number; lowest: number } {
  const wallet = { w: INITIAL_CAPITAL, hwm: INITIAL_CAPITAL, lowest: INITIAL_CAPITAL };
  const trades: Trade[] = [];
  let positions: Position[] = [];

  const close4h = c4h.map(b => b.close);
  const close15 = c15.map(b => b.close);
  const close1h = c1h.map(b => b.close);
  const ema50_4h = calcEMA(close4h, 50);
  const ema200_4h = calcEMA(close4h, 200);
  const rsi15 = calcRSI(close15, 14);
  const atr4h = calcATR(c4h, 14);
  const atr5 = calcATR(c5, 14);
  // Donchian high/low precomputed on 4h
  const donHi: (number | null)[] = new Array(c4h.length).fill(null);
  const donLo: (number | null)[] = new Array(c4h.length).fill(null);
  for (let i = 20; i < c4h.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - 20; j < i; j++) { if (c4h[j].high > hi) hi = c4h[j].high; if (c4h[j].low < lo) lo = c4h[j].low; }
    donHi[i] = hi; donLo[i] = lo;
  }

  let idx15 = 0, idx1h = 0, idx4h = 0;
  let lastFireMs = 0;
  const COOLDOWN_MS = 4 * 60 * 60_000;

  for (let i = Math.max(startIdx, 100); i < c5.length; i++) {
    const bar = c5[i]; const ts = bar.time; const mark = bar.close;
    positions = processClose(positions, bar, trades, wallet);
    idx15 = findIdx(c15, ts, idx15); idx1h = findIdx(c1h, ts, idx1h); idx4h = findIdx(c4h, ts, idx4h);
    const idx15c = idx15 - 1; const idx1hc = idx1h - 1; const idx4hc = idx4h - 1;
    if (idx15c < 14 || idx1hc < 20 || idx4hc < 200) continue;

    let voteLong = 0, voteShort = 0;
    // Strategy 1: Trend (EMA 50 vs 200 4h)
    const e50 = ema50_4h[idx4hc]; const e200 = ema200_4h[idx4hc];
    if (e50 !== null && e200 !== null) {
      if (e50 > e200) voteLong++; else voteShort++;
    }
    // Strategy 2: MeanRev (RSI 15m)
    const r15 = rsi15[idx15c];
    if (r15 !== null) {
      if (r15 < 30) voteLong++; if (r15 > 70) voteShort++;
    }
    // Strategy 3: Breakout (Donchian 20-bar 4h)
    const hi = donHi[idx4hc]; const lo = donLo[idx4hc];
    if (hi !== null && lo !== null) {
      const c4hClose = c4h[idx4hc].close;
      if (c4hClose > hi) voteLong++;
      if (c4hClose < lo) voteShort++;
    }
    // Strategy 4: Momentum 1h (close[0] vs close[5,10,20])
    if (idx1hc >= 20) {
      const cnow = c1h[idx1hc].close;
      const mom5 = (cnow - c1h[idx1hc - 5].close) / c1h[idx1hc - 5].close * 100;
      const mom10 = (cnow - c1h[idx1hc - 10].close) / c1h[idx1hc - 10].close * 100;
      const mom20 = (cnow - c1h[idx1hc - 20].close) / c1h[idx1hc - 20].close * 100;
      if (mom5 > 0 && mom10 > 0 && mom20 > 0) voteLong++;
      if (mom5 < 0 && mom10 < 0 && mom20 < 0) voteShort++;
    }
    // Strategy 5: Vol — ATR rank percentile last 100 4h bars
    if (idx4hc >= 100) {
      const curAtr = atr4h[idx4hc];
      const recentAtrs = atr4h.slice(idx4hc - 100, idx4hc).filter(v => v !== null) as number[];
      recentAtrs.sort((a, b) => a - b);
      if (curAtr !== null && recentAtrs.length > 0) {
        const rank = recentAtrs.filter(v => v < curAtr).length / recentAtrs.length;
        // Fade extreme: rank > 0.9 → fade direction of last 5m
        if (rank > 0.9) {
          const prev5m = c5[i - 1]?.close ?? mark;
          if (mark > prev5m) voteShort++;
          else voteLong++;
        }
      }
    }

    if (ts - lastFireMs < COOLDOWN_MS) continue;
    const atr = atr5[i];
    if (!atr || atr <= 0) continue;

    let qty = 0, side: "LONG" | "SHORT" | null = null;
    if (voteLong >= 3 && voteLong > voteShort) { qty = voteLong === 5 ? 0.5 : 0.3; side = "LONG"; }
    else if (voteShort >= 3 && voteShort > voteLong) { qty = voteShort === 5 ? 0.5 : 0.3; side = "SHORT"; }
    if (side) {
      openPos(positions, `vote${voteLong + voteShort}_${side}`, side, mark, qty, ts, 5, 3, 96);
      lastFireMs = ts;
    }
  }

  const last = c5[c5.length - 1];
  for (const p of positions) {
    const pnl = (p.side === "LONG" ? last.close - p.entry : p.entry - last.close) * p.qty;
    wallet.w += pnl;
    trades.push({ entryTs: p.entryTs, exitTs: last.time, side: p.side, entry: p.entry, exit: last.close, qty: p.qty, pnl, reason: "FORCE", signal: p.signal });
  }
  return { trades, wallet: wallet.w, hwm: wallet.hwm, lowest: wallet.lowest };
}

function main() {
  console.log("[quaidij] Loading 3y caches → slice 2y (last)...");
  const c5all = loadCache("5m");
  const c15all = loadCache("15m");
  const c1hall = loadCache("1h");
  const c4hall = loadCache("4h");

  // Slice 2 năm cuối
  const startIdx5 = Math.max(0, c5all.length - SLICE_2Y_BARS_5M);
  const startTs = c5all[startIdx5].time;
  console.log(`[quaidij] Period: ${new Date(startTs).toISOString()} → ${new Date(c5all[c5all.length - 1].time).toISOString()}`);
  console.log(`[quaidij]   5m bars: ${c5all.length - startIdx5}/${c5all.length}`);

  const results: any[] = [];

  console.log("\n[quaidij] Running omni01...");
  const r1 = runOmni01(c5all, c1hall, c4hall, startIdx5);
  results.push(summarize("omni01", r1.trades, r1.wallet, r1.hwm, r1.lowest));

  console.log("[quaidij] Running chaos01...");
  const r2 = runChaos01(c5all, c15all, c1hall, c4hall, startIdx5);
  results.push(summarize("chaos01", r2.trades, r2.wallet, r2.hwm, r2.lowest));

  console.log("[quaidij] Running kraken01...");
  const r3 = runKraken01(c5all, c15all, c1hall, c4hall, startIdx5);
  results.push(summarize("kraken01", r3.trades, r3.wallet, r3.hwm, r3.lowest));

  console.log("\n=== QUAI-DI RULES COMPARISON (2y, capital $100k, ATR-based qty) ===");
  console.log("Rule       | ROI%    | DD%    | RA    | Trades | WR%   | AvgW    | AvgL    | R:R  | Exp/trade");
  console.log("-".repeat(110));
  for (const r of results) {
    console.log(`${r.name.padEnd(10)} | ${String(r.roi).padStart(7)} | ${String(r.dd).padStart(6)} | ${String(r.ra).padStart(5)} | ${String(r.trades).padStart(6)} | ${String(r.wr).padStart(5)} | ${String(r.avgW).padStart(7)} | ${String(r.avgL).padStart(7)} | ${String(r.rr).padStart(4)} | ${String(r.exp).padStart(8)}`);
  }

  console.log("\n=== PER-YEAR ===");
  console.log("Rule       | 2024      | 2025      | 2026");
  console.log("-".repeat(60));
  for (const r of results) {
    const y24 = r.byYear["2024"] ?? "-";
    const y25 = r.byYear["2025"] ?? "-";
    const y26 = r.byYear["2026"] ?? "-";
    console.log(`${r.name.padEnd(10)} | ${String(y24).padStart(9)} | ${String(y25).padStart(9)} | ${String(y26).padStart(9)}`);
  }

  console.log("\n=== PER-SIGNAL BREAKDOWN ===");
  for (const r of results) {
    console.log(`\n${r.name}:`);
    const sigs = Object.entries(r.bySignal).sort(([, a]: any, [, b]: any) => b.count - a.count);
    for (const [sig, info] of sigs) {
      const i: any = info;
      console.log(`  ${sig.padEnd(20)} count=${String(i.count).padStart(4)}  pnl=$${String(i.pnl).padStart(7)}  wr=${i.wr}%`);
    }
  }

  writeFileSync(join(__dirname, "..", "assets", "backtest_rules_quaidij.json"), JSON.stringify(results, null, 2));
  console.log(`\nWritten assets/backtest_rules_quaidij.json`);
}

main();
