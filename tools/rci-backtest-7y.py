#!/usr/bin/env python3
"""
rci-backtest-7y.py — Reversal Confluence Index backtest trên 7y BTC data.

Layer 1: WDC (Weighted Divergence Composite) — RSI div (4h+1h) + MACD div (4h) + Vol div (1h)
Layer 2: MPC (Multi-Pattern Confirmation) — 5 patterns, threshold ≥ 2
Signal: RCI > +0.8 AND MPC≥2 → BEARISH (top), RCI < -0.8 AND MPC≥2 → BULLISH (bottom)
Validation: reversal thật = giá move ≥ 3% trong 48h
"""
import json, math, datetime
from collections import defaultdict

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FEE   = 0.0005  # 0.05%
PIVOT_N     = 5      # swing pivot detection
MAX_PIVOT_AGE = 50   # bars — divergence decay cutoff
RCI_THRESHOLD = 0.8  # signal threshold
MPC_MIN       = 2    # minimum patterns required
REVERSAL_PCT  = 3.0  # % move để xem là "reversal thật"
REVERSAL_BARS_4H = 12  # 48h = 12 bars×4h

print("Loading data...")
raw = json.load(open(CACHE))
raw.sort(key=lambda x: x["time"])
print(f"  {len(raw):,} 5m bars  {datetime.datetime.utcfromtimestamp(raw[0]['time']/1000):%Y-%m-%d} → {datetime.datetime.utcfromtimestamp(raw[-1]['time']/1000):%Y-%m-%d}")

# ─── Build multi-TF bars ──────────────────────────────────────────────────────
def build_tf(ms):
    b = {}
    for c in raw:
        k = c["time"] // ms
        if k not in b:
            b[k] = {"time": k*ms, "open": c["open"], "high": c["high"],
                    "low": c["low"], "close": c["close"], "volume": c["volume"]}
        else:
            o = b[k]
            o["high"]   = max(o["high"], c["high"])
            o["low"]    = min(o["low"],  c["low"])
            o["close"]  = c["close"]
            o["volume"] += c["volume"]
    return [b[k] for k in sorted(b)]

bars4h = build_tf(4*3600*1000)
bars1h = build_tf(  3600*1000)
n4, n1 = len(bars4h), len(bars1h)
print(f"  4h: {n4} bars | 1h: {n1} bars")

# ─── Indicators ───────────────────────────────────────────────────────────────
def ema(xs, p):
    k = 2 / (p + 1); out = [None]*len(xs); e = None
    for i, x in enumerate(xs):
        if x is not None: e = x if e is None else x*k + e*(1-k)
        out[i] = e
    return out

def rsi_series(closes, p=14):
    n = len(closes); out = [None]*n
    if n <= p: return out
    gains, losses = [], []
    for i in range(1, p+1):
        d = closes[i] - closes[i-1]
        gains.append(max(d, 0)); losses.append(max(-d, 0))
    avg_g = sum(gains)/p; avg_l = sum(losses)/p
    out[p] = 100 - 100/(1 + avg_g/avg_l) if avg_l > 0 else 100
    for i in range(p+1, n):
        d = closes[i] - closes[i-1]
        g = max(d, 0); l = max(-d, 0)
        avg_g = (avg_g*(p-1) + g)/p; avg_l = (avg_l*(p-1) + l)/p
        out[i] = 100 - 100/(1 + avg_g/avg_l) if avg_l > 0 else 100
    return out

def macd_hist_series(closes, fast=12, slow=26, sig=9):
    e_fast = ema(closes, fast); e_slow = ema(closes, slow)
    macd_line = [None]*len(closes)
    for i in range(len(closes)):
        if e_fast[i] is not None and e_slow[i] is not None:
            macd_line[i] = e_fast[i] - e_slow[i]
    sig_line = ema(macd_line, sig)
    hist = [None]*len(closes)
    for i in range(len(closes)):
        if macd_line[i] is not None and sig_line[i] is not None:
            hist[i] = macd_line[i] - sig_line[i]
    return hist

def stoch_k(bars, p=14):
    n = len(bars); out = [None]*n
    for i in range(p-1, n):
        lo = min(b["low"]  for b in bars[i-p+1:i+1])
        hi = max(b["high"] for b in bars[i-p+1:i+1])
        rng = hi - lo
        out[i] = 100*(bars[i]["close"] - lo)/rng if rng > 0 else 50
    return out

def vol_ma(bars, p=20):
    vols = [b["volume"] for b in bars]; n = len(vols)
    out = [None]*n
    for i in range(p-1, n):
        out[i] = sum(vols[i-p+1:i+1])/p
    return out

# Compute indicators on 4h
c4 = [b["close"] for b in bars4h]
rsi4  = rsi_series(c4, 14)
mhist4 = macd_hist_series(c4)
vma4  = vol_ma(bars4h, 20)

# Compute indicators on 1h
c1 = [b["close"] for b in bars1h]
rsi1  = rsi_series(c1, 14)
stk1  = stoch_k(bars1h, 14)
vma1  = vol_ma(bars1h, 20)

print("  Indicators computed.")

# ─── Pivot detection ──────────────────────────────────────────────────────────
def find_pivots(bars, closes, N=PIVOT_N):
    """Returns list of (bar_idx, price, type) where type='H' or 'L'."""
    pivots = []
    for i in range(N, len(bars)-N):
        hi = bars[i]["high"]; lo = bars[i]["low"]
        is_high = all(hi >= bars[j]["high"] for j in range(i-N, i+N+1) if j != i)
        is_low  = all(lo <= bars[j]["low"]  for j in range(i-N, i+N+1) if j != i)
        if is_high: pivots.append((i, hi, "H"))
        if is_low:  pivots.append((i, lo, "L"))
    return pivots

pivots4h = find_pivots(bars4h, c4)
print(f"  4h pivots: {len(pivots4h)}")

# ─── WDC computation ─────────────────────────────────────────────────────────
def get_last_pivot(pivots, before_idx, ptype):
    """Get last 2 pivots of given type before bar index."""
    found = [(i, p, t) for i, p, t in pivots if t == ptype and i < before_idx]
    return found[-2:] if len(found) >= 2 else []

def age_factor(dist):
    return max(0.0, 1.0 - dist / MAX_PIVOT_AGE)

# Map 1h bars to 4h: find closest 1h bar for each 4h bar
h1_times = [b["time"] for b in bars1h]
def h1_idx_at(ts):
    lo, hi, best = 0, len(h1_times)-1, 0
    while lo <= hi:
        m = (lo+hi)//2
        if h1_times[m] <= ts: best=m; lo=m+1
        else: hi=m-1
    return best

rci_raw = [0.0] * n4
wdc_components = []  # for debug

for i in range(50, n4):
    bear_score = bull_score = 0.0

    # ── RSI divergence 4h ──
    highs4 = get_last_pivot(pivots4h, i, "H")
    lows4  = get_last_pivot(pivots4h, i, "L")

    if len(highs4) == 2:
        pi1, pp1, _ = highs4[-2]; pi2, pp2, _ = highs4[-1]
        r1 = rsi4[pi1]; r2 = rsi4[pi2]
        if r1 and r2 and pp2 > pp1 and r2 < r1:  # bearish div
            dist = i - pi2
            bear_score += (r1-r2)/r1 * age_factor(dist) * 0.35

    if len(lows4) == 2:
        pi1, pp1, _ = lows4[-2]; pi2, pp2, _ = lows4[-1]
        r1 = rsi4[pi1]; r2 = rsi4[pi2]
        if r1 and r2 and pp2 < pp1 and r2 > r1:  # bullish div
            dist = i - pi2
            bull_score += (r2-r1)/r1 * age_factor(dist) * 0.35

    # ── MACD hist divergence 4h ──
    if len(highs4) == 2:
        pi1, pp1, _ = highs4[-2]; pi2, pp2, _ = highs4[-1]
        m1 = mhist4[pi1]; m2 = mhist4[pi2]
        if m1 and m2 and pp2 > pp1 and m2 < m1:  # bearish MACD div
            dist = i - pi2
            delta = abs(m1-m2) / (abs(m1)+1e-9)
            bear_score += min(delta, 1.0) * age_factor(dist) * 0.25

    if len(lows4) == 2:
        pi1, pp1, _ = lows4[-2]; pi2, pp2, _ = lows4[-1]
        m1 = mhist4[pi1]; m2 = mhist4[pi2]
        if m1 and m2 and pp2 < pp1 and m2 > m1:  # bullish MACD div
            dist = i - pi2
            delta = abs(m2-m1) / (abs(m1)+1e-9)
            bull_score += min(delta, 1.0) * age_factor(dist) * 0.25

    # ── RSI divergence 1h (map to nearest 4h bar) ──
    h1i = h1_idx_at(bars4h[i]["time"])
    # Find 1h swing highs/lows around this point (±24 bars)
    h1_window = list(range(max(0, h1i-80), min(n1, h1i+1)))
    h1_highs = [j for j in h1_window if j >= 1 and j < n1-1
                and bars1h[j]["high"] >= max(bars1h[k]["high"] for k in range(max(0,j-3), min(n1,j+4)) if k!=j)]
    h1_lows  = [j for j in h1_window if j >= 1 and j < n1-1
                and bars1h[j]["low"] <= min(bars1h[k]["low"] for k in range(max(0,j-3), min(n1,j+4)) if k!=j)]

    if len(h1_highs) >= 2:
        hi1_i, hi2_i = h1_highs[-2], h1_highs[-1]
        p1 = bars1h[hi1_i]["high"]; p2 = bars1h[hi2_i]["high"]
        r1 = rsi1[hi1_i]; r2 = rsi1[hi2_i]
        if r1 and r2 and p2 > p1 and r2 < r1:
            bear_score += (r1-r2)/r1 * 0.25

    if len(h1_lows) >= 2:
        lo1_i, lo2_i = h1_lows[-2], h1_lows[-1]
        p1 = bars1h[lo1_i]["low"]; p2 = bars1h[lo2_i]["low"]
        r1 = rsi1[lo1_i]; r2 = rsi1[lo2_i]
        if r1 and r2 and p2 < p1 and r2 > r1:
            bull_score += (r2-r1)/r1 * 0.25

    # ── Volume divergence 1h ──
    vma_1h = vma1[h1i]
    if vma_1h:
        vol_ratio = bars1h[h1i]["volume"] / vma_1h
        if len(highs4) >= 1 and (i - highs4[-1][0]) <= 3:  # near swing high
            bear_score += max(0, 1 - vol_ratio) * 0.15
        if len(lows4) >= 1 and (i - lows4[-1][0]) <= 3:   # near swing low
            bull_score += max(0, 1 - vol_ratio) * 0.15

    rci_raw[i] = bear_score - bull_score

# Smooth with EMA(3)
rci_line = ema(rci_raw, 3)
print("  WDC computed.")

# ─── MPC computation (5 patterns) ────────────────────────────────────────────
def mpc_score(i, direction):
    """direction: 'BEAR' or 'BULL'. Returns int 0-5."""
    score = 0
    if i < 20: return 0

    # P1: RSI extreme + reverting (4h)
    r = rsi4[i]; rp = rsi4[i-1]
    if r is not None and rp is not None:
        if direction == "BEAR" and rp > 70 and r < rp: score += 1
        if direction == "BULL" and rp < 30 and r > rp: score += 1

    # P2: Stoch cross (1h)
    h1i = h1_idx_at(bars4h[i]["time"])
    if h1i >= 1:
        sk = stk1[h1i]; skp = stk1[h1i-1]
        if sk is not None and skp is not None:
            if direction == "BEAR" and skp <= 80 and sk > 80: score += 1
            if direction == "BULL" and skp >= 20 and sk < 20: score += 1

    # P3: Engulfing candle (4h)
    b = bars4h[i]; bp = bars4h[i-1]
    body    = b["close"]  - b["open"]
    body_p  = bp["close"] - bp["open"]
    if direction == "BEAR" and body < 0 and body_p > 0 and abs(body) > abs(body_p): score += 1
    if direction == "BULL" and body > 0 and body_p < 0 and abs(body) > abs(body_p): score += 1

    # P4: Volume climax (1h)
    vm = vma1[h1i] if h1i and vma1[h1i] else None
    if vm and h1i:
        vol = bars1h[h1i]["volume"]
        close_1h = bars1h[h1i]["close"]; open_1h = bars1h[h1i]["open"]
        if vol > vm * 2.5:
            if direction == "BEAR" and close_1h < open_1h: score += 1
            if direction == "BULL" and close_1h > open_1h: score += 1

    # P5: Liquidity sweep (4h) — wick exceeds 20-bar extreme but closes back
    lb = 20
    if i >= lb:
        lo20 = min(bars4h[j]["low"]  for j in range(i-lb, i))
        hi20 = max(bars4h[j]["high"] for j in range(i-lb, i))
        if direction == "BULL" and b["low"] < lo20 and b["close"] > lo20: score += 1
        if direction == "BEAR" and b["high"] > hi20 and b["close"] < hi20: score += 1

    return score

print("  Computing MPC scores...")

# ─── Signal detection ─────────────────────────────────────────────────────────
signals = []
last_signal_bar = -20  # cooldown

for i in range(60, n4 - REVERSAL_BARS_4H):
    rci = rci_line[i]
    if rci is None: continue
    if i - last_signal_bar < 8: continue  # 32h cooldown between signals

    direction = None
    if rci > RCI_THRESHOLD:   direction = "BEAR"
    elif rci < -RCI_THRESHOLD: direction = "BULL"
    if not direction: continue

    mp = mpc_score(i, direction)
    if mp < MPC_MIN: continue

    # Verify reversal outcome
    entry_price = bars4h[i]["close"]
    future_bars = bars4h[i+1:i+REVERSAL_BARS_4H+1]
    if direction == "BEAR":
        min_fut = min(b["low"] for b in future_bars)
        drop_pct = (entry_price - min_fut) / entry_price * 100
        is_reversal = drop_pct >= REVERSAL_PCT
        move_pct = drop_pct
    else:
        max_fut = max(b["high"] for b in future_bars)
        pump_pct = (max_fut - entry_price) / entry_price * 100
        is_reversal = pump_pct >= REVERSAL_PCT
        move_pct = pump_pct

    ts  = bars4h[i]["time"]
    dt  = datetime.datetime.utcfromtimestamp(ts/1000)
    yr  = dt.year

    signals.append({
        "bar": i, "ts": ts, "dt": dt, "yr": yr,
        "direction": direction,
        "rci": round(rci, 3), "mpc": mp,
        "price": entry_price,
        "move_pct": round(move_pct, 2),
        "is_reversal": is_reversal,
    })
    last_signal_bar = i

print(f"  Signals found: {len(signals)}")

# ─── Results ──────────────────────────────────────────────────────────────────
print("\n" + "="*80)
print("REVERSAL CONFLUENCE INDEX (RCI) — Backtest Results (7y BTC)")
print("="*80)

total = len(signals)
correct = sum(1 for s in signals if s["is_reversal"])
precision = correct/total*100 if total else 0

bear_sigs = [s for s in signals if s["direction"]=="BEAR"]
bull_sigs = [s for s in signals if s["direction"]=="BULL"]
bear_ok = sum(1 for s in bear_sigs if s["is_reversal"])
bull_ok = sum(1 for s in bull_sigs if s["is_reversal"])

print(f"\nOVERALL:")
print(f"  Total signals:  {total}")
print(f"  Correct (≥3%):  {correct}  ({precision:.1f}%)")
print(f"  BEARISH signals: {len(bear_sigs)} → {bear_ok} correct ({bear_ok/len(bear_sigs)*100:.1f}%)" if bear_sigs else "  BEARISH: 0")
print(f"  BULLISH signals: {len(bull_sigs)} → {bull_ok} correct ({bull_ok/len(bull_sigs)*100:.1f}%)" if bull_sigs else "  BULLISH: 0")

# Per-year breakdown
print(f"\nPER-YEAR:")
by_year = defaultdict(list)
for s in signals: by_year[s["yr"]].append(s)
for yr in sorted(by_year):
    yrs = by_year[yr]
    yc  = sum(1 for s in yrs if s["is_reversal"])
    yp  = yc/len(yrs)*100
    bars_yr = [s for s in yrs if s["direction"]=="BEAR"]
    buls_yr = [s for s in yrs if s["direction"]=="BULL"]
    flag = "✓" if yp >= 50 else "✗"
    print(f"  {yr}: {len(yrs):2d} signals  {yc:2d} correct  {yp:5.1f}%  {flag}  (bear={len(bars_yr)} bull={len(buls_yr)})")

passing_years = sum(1 for yr in by_year if sum(1 for s in by_year[yr] if s["is_reversal"])/len(by_year[yr]) >= 0.5)
print(f"\n  Passing years (≥50%): {passing_years}/{len(by_year)}")

# Train/Test split (2019-2022 train, 2023-2026 test)
train = [s for s in signals if s["yr"] <= 2022]
test  = [s for s in signals if s["yr"] >= 2023]
tr_p  = sum(1 for s in train if s["is_reversal"])/len(train)*100 if train else 0
te_p  = sum(1 for s in test  if s["is_reversal"])/len(test)*100  if test  else 0
print(f"\nTRAIN/TEST SPLIT:")
print(f"  Train 2019-2022: {len(train)} signals  {tr_p:.1f}% precision")
print(f"  Test  2023-2026: {len(test)}  signals  {te_p:.1f}% precision (OOS)")

# Signal detail (sample)
print(f"\nSIGNAL SAMPLE (last 20):")
print(f"  {'Date':12} {'Dir':5} {'RCI':6} {'MPC':4} {'Price':8} {'Move%':7} {'OK':3}")
for s in signals[-20:]:
    ok = "✓" if s["is_reversal"] else "✗"
    print(f"  {s['dt'].strftime('%Y-%m-%d'):12} {s['direction']:5} {s['rci']:+.3f} {s['mpc']:4d} {s['price']:8.0f} {s['move_pct']:+7.2f}% {ok}")

# Average move when correct vs wrong
ok_moves   = [s["move_pct"] for s in signals if s["is_reversal"]]
fail_moves = [s["move_pct"] for s in signals if not s["is_reversal"]]
print(f"\nMOVE STATS:")
if ok_moves:   print(f"  Correct signals avg move: {sum(ok_moves)/len(ok_moves):.2f}%")
if fail_moves: print(f"  False signals  avg move: {sum(fail_moves)/len(fail_moves):.2f}%")

# MPC strength breakdown
print(f"\nMPC STRENGTH vs PRECISION:")
for mp in [2, 3, 4, 5]:
    subs = [s for s in signals if s["mpc"] == mp]
    if not subs: continue
    subc = sum(1 for s in subs if s["is_reversal"])
    print(f"  MPC={mp}: {len(subs):3d} signals  {subc:3d} correct  {subc/len(subs)*100:.1f}%")

print("\n" + "="*80)
print("TARGETS:  Precision ≥ 60%  |  8-20 signals/year  |  ≥5/7 years passing")
targets_met = []
if precision >= 60: targets_met.append("Precision ✓")
else: targets_met.append(f"Precision ✗ ({precision:.1f}%)")
avg_per_yr = total / max(len(by_year),1)
if 8 <= avg_per_yr <= 20: targets_met.append(f"Freq ✓ ({avg_per_yr:.1f}/yr)")
else: targets_met.append(f"Freq ✗ ({avg_per_yr:.1f}/yr)")
if passing_years >= 5: targets_met.append(f"Stability ✓ ({passing_years}/7)")
else: targets_met.append(f"Stability ✗ ({passing_years}/7)")
print("VERDICT:  " + "  |  ".join(targets_met))
print("="*80)
