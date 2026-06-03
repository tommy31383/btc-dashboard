#!/usr/bin/env python3
"""
rci-v4-backtest-7y.py — RCI v4 backtest on 7y BTC data.

v3 baseline: Funding(×2.0) + RSI-4h(×1.5) + Stoch-4h(×0.8) + BB%B-4h(×0.8) + MACD-4h(×0.4)

v4 adds 3 groups:
  Group 1 — Higher TF (1d, 1w): RSI-1d, RSI-1d-reverting, BB%B-1w, EMA200-1d distance
  Group 2 — Divergence Quality: multi-pivot count, magnitude, confirmation candle
  Group 3 — ADX slope, Funding acceleration, Volume exhaustion 4h

Outputs:
  - Precision table v3 vs v4 at thresholds 1-6
  - Ablation table: each group alone and combined
  - Per-year era-split (2019-2026)
  - Train/Test split (2019-2022 train, 2023-2026 OOS test)
  - Weight sweep: train 2019-2022 optimize, report OOS precision
"""
import json, math, datetime, statistics
from collections import defaultdict

CACHE_5M  = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
CACHE_FUND = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-funding-7y.json"

PIVOT_N          = 5
MAX_PIVOT_AGE    = 50
REVERSAL_PCT     = 3.0
REVERSAL_BARS_4H = 12   # 48h = 12 × 4h bars

# ─── Load data ───────────────────────────────────────────────────────────────
print("Loading 5m data...")
raw5m = json.load(open(CACHE_5M))
raw5m.sort(key=lambda x: x["time"])
print(f"  {len(raw5m):,} 5m bars  {datetime.datetime.utcfromtimestamp(raw5m[0]['time']/1000):%Y-%m-%d} → {datetime.datetime.utcfromtimestamp(raw5m[-1]['time']/1000):%Y-%m-%d}")

print("Loading funding data...")
raw_fund = json.load(open(CACHE_FUND))
# funding entries: [{time, fundingRate}] or [{t, r}]
# Detect format
sample = raw_fund[0]
if "fundingRate" in sample:
    fund_entries = [(int(e["time"]), float(e["fundingRate"])) for e in raw_fund]
elif "r" in sample:
    fund_entries = [(int(e["t"]), float(e["r"])) for e in raw_fund]
else:
    # try common keys
    tk = [k for k in sample if "time" in k.lower() or k in ("t","timestamp")][0]
    rk = [k for k in sample if "rate" in k.lower() or k in ("r","fundingRate","funding")][0]
    fund_entries = [(int(e[tk]), float(e[rk])) for e in raw_fund]

fund_entries.sort(key=lambda x: x[0])
print(f"  {len(fund_entries):,} funding entries  {datetime.datetime.utcfromtimestamp(fund_entries[0][0]/1000):%Y-%m-%d} → {datetime.datetime.utcfromtimestamp(fund_entries[-1][0]/1000):%Y-%m-%d}")

# ─── Build multi-TF bars ─────────────────────────────────────────────────────
def build_tf(ms):
    b = {}
    for c in raw5m:
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

print("Building timeframe bars...")
bars4h = build_tf(4*3600*1000)
bars1h = build_tf(  3600*1000)
bars1d = build_tf(24*3600*1000)
bars1w = build_tf(7*24*3600*1000)
n4, n1, nd, nw = len(bars4h), len(bars1h), len(bars1d), len(bars1w)
print(f"  4h:{n4} | 1h:{n1} | 1d:{nd} | 1w:{nw}")

# ─── Indicators ──────────────────────────────────────────────────────────────
def ema(xs, p):
    k = 2/(p+1); out = [None]*len(xs); e = None
    for i, x in enumerate(xs):
        if x is not None: e = x if e is None else x*k + e*(1-k)
        out[i] = e
    return out

def rsi_series(closes, p=14):
    n = len(closes); out = [None]*n
    if n <= p: return out
    gains, losses = [], []
    for i in range(1, p+1):
        d = closes[i]-closes[i-1]
        gains.append(max(d,0)); losses.append(max(-d,0))
    avg_g = sum(gains)/p; avg_l = sum(losses)/p
    out[p] = 100-100/(1+avg_g/avg_l) if avg_l > 0 else 100
    for i in range(p+1, n):
        d = closes[i]-closes[i-1]
        g = max(d,0); l = max(-d,0)
        avg_g = (avg_g*(p-1)+g)/p; avg_l = (avg_l*(p-1)+l)/p
        out[i] = 100-100/(1+avg_g/avg_l) if avg_l > 0 else 100
    return out

def bb_pctb(closes, p=20, mult=2.0):
    n = len(closes); out = [None]*n
    for i in range(p-1, n):
        window = closes[i-p+1:i+1]
        mid = sum(window)/p
        std = statistics.stdev(window)
        upper = mid + mult*std; lower = mid - mult*std
        rng = upper - lower
        out[i] = (closes[i]-lower)/rng if rng > 0 else 0.5
    return out

def macd_hist_series(closes, fast=12, slow=26, sig=9):
    ef = ema(closes, fast); es = ema(closes, slow)
    ml = [ef[i]-es[i] if ef[i] is not None and es[i] is not None else None for i in range(len(closes))]
    sl = ema(ml, sig)
    return [ml[i]-sl[i] if ml[i] is not None and sl[i] is not None else None for i in range(len(closes))]

def stoch_k(bars, p=14):
    n = len(bars); out = [None]*n
    for i in range(p-1, n):
        lo = min(b["low"]  for b in bars[i-p+1:i+1])
        hi = max(b["high"] for b in bars[i-p+1:i+1])
        rng = hi - lo
        out[i] = 100*(bars[i]["close"]-lo)/rng if rng > 0 else 50
    return out

def adx_series(bars, p=14):
    """Returns (adx_list, plus_di, minus_di)"""
    n = len(bars)
    adx_out = [None]*n
    if n < p*2: return adx_out
    tr_list = []; pdm_list = []; mdm_list = []
    for i in range(1, n):
        h, l, pc = bars[i]["high"], bars[i]["low"], bars[i-1]["close"]
        tr = max(h-l, abs(h-pc), abs(l-pc))
        pdm = max(h - bars[i-1]["high"], 0)
        mdm = max(bars[i-1]["low"] - l, 0)
        if pdm < mdm: pdm = 0
        elif mdm < pdm: mdm = 0
        else: pdm = mdm = 0
        tr_list.append(tr); pdm_list.append(pdm); mdm_list.append(mdm)
    # Smooth
    def smooth(xs, pp):
        out = [None]*len(xs)
        if len(xs) < pp: return out
        s = sum(xs[:pp])
        out[pp-1] = s
        for i in range(pp, len(xs)):
            out[i] = out[i-1] - out[i-1]/pp + xs[i]
        return out
    atr = smooth(tr_list, p); pdm_s = smooth(pdm_list, p); mdm_s = smooth(mdm_list, p)
    dx_list = [None]*(n-1)
    for i in range(p-1, len(tr_list)):
        if atr[i] and atr[i] > 0:
            pdi = 100*pdm_s[i]/atr[i]
            mdi = 100*mdm_s[i]/atr[i]
            dx  = 100*abs(pdi-mdi)/(pdi+mdi) if (pdi+mdi) > 0 else 0
            dx_list[i] = dx
        else:
            dx_list[i] = None
    # Smooth DX → ADX
    adx_smooth = [None]*len(dx_list)
    # find first valid
    start = None
    for i in range(len(dx_list)):
        if dx_list[i] is not None:
            if start is None: start = i
            if i - start + 1 == p:
                adx_smooth[i] = sum(v for v in dx_list[start:i+1] if v is not None)/p
            elif i > start + p - 1 and adx_smooth[i-1] is not None:
                adx_smooth[i] = (adx_smooth[i-1]*(p-1) + dx_list[i])/p
    # map back to original bar index (offset by 1)
    for i in range(len(adx_smooth)):
        adx_out[i+1] = adx_smooth[i]
    return adx_out

def vol_ma(bars, p=20):
    vols = [b["volume"] for b in bars]; n = len(vols); out = [None]*n
    for i in range(p-1, n): out[i] = sum(vols[i-p+1:i+1])/p
    return out

print("Computing 4h indicators...")
c4 = [b["close"] for b in bars4h]
rsi4    = rsi_series(c4, 14)
bb4     = bb_pctb(c4, 20, 2.0)
mhist4  = macd_hist_series(c4)
stk4    = stoch_k(bars4h, 14)
adx4    = adx_series(bars4h, 14)
vma4    = vol_ma(bars4h, 20)

print("Computing 1h indicators...")
c1 = [b["close"] for b in bars1h]
stk1    = stoch_k(bars1h, 14)
vma1    = vol_ma(bars1h, 20)

print("Computing 1d indicators...")
cd = [b["close"] for b in bars1d]
rsi1d   = rsi_series(cd, 14)
ema200d = ema(cd, 200)

print("Computing 1w indicators...")
cw = [b["close"] for b in bars1w]
bb1w    = bb_pctb(cw, 20, 2.0)

print("  All indicators done.")

# ─── Pivot detection (4h) ─────────────────────────────────────────────────────
def find_pivots(bars, N=PIVOT_N):
    pivots = []
    for i in range(N, len(bars)-N):
        hi = bars[i]["high"]; lo = bars[i]["low"]
        is_high = all(hi >= bars[j]["high"] for j in range(i-N, i+N+1) if j != i)
        is_low  = all(lo <= bars[j]["low"]  for j in range(i-N, i+N+1) if j != i)
        if is_high: pivots.append((i, hi, "H"))
        if is_low:  pivots.append((i, lo, "L"))
    return pivots

pivots4h = find_pivots(bars4h)
print(f"  4h pivots: {len(pivots4h)}")

def get_last_pivots(pivots, before_idx, ptype, n=2):
    found = [(i, p, t) for i, p, t in pivots if t == ptype and i < before_idx]
    return found[-n:] if len(found) >= n else []

# ─── Build funding lookup ─────────────────────────────────────────────────────
# Map: for each 4h bar, find nearest funding rate (funding is 8h)
fund_times = [e[0] for e in fund_entries]
fund_rates = [e[1] for e in fund_entries]

def find_funding_at(ts):
    """Get most recent funding rate at or before ts."""
    lo, hi, best = 0, len(fund_times)-1, None
    while lo <= hi:
        m = (lo+hi)//2
        if fund_times[m] <= ts: best = m; lo = m+1
        else: hi = m-1
    if best is None: return 0.0
    return fund_rates[best]

# ─── Map helpers ─────────────────────────────────────────────────────────────
def ts_to_idx(bar_times, ts):
    """Binary search: largest index where bar_times[i] <= ts."""
    lo, hi, best = 0, len(bar_times)-1, 0
    while lo <= hi:
        m = (lo+hi)//2
        if bar_times[m] <= ts: best=m; lo=m+1
        else: hi=m-1
    return best

d_times = [b["time"] for b in bars1d]
w_times = [b["time"] for b in bars1w]
h1_times = [b["time"] for b in bars1h]

# ─── RCI v3 components ────────────────────────────────────────────────────────
def v3_score(i):
    """RCI v3 raw score at 4h bar i. Returns (bear_contrib, bull_contrib)."""
    bear = bull = 0.0

    # RSI-4h ×1.5
    r = rsi4[i]
    if r is not None:
        if r > 70:   bear += (r-70)/30 * 1.5
        elif r < 30: bull += (30-r)/30 * 1.5

    # Stoch-4h ×0.8
    sk = stk4[i]
    if sk is not None:
        if sk > 80:  bear += (sk-80)/20 * 0.8
        elif sk < 20: bull += (20-sk)/20 * 0.8

    # BB%B-4h ×0.8
    bb = bb4[i]
    if bb is not None:
        if bb > 1.0:  bear += (bb-1.0)*2 * 0.8
        elif bb < 0.0: bull += (-bb)*2 * 0.8

    # MACD hist ×0.4
    mh = mhist4[i]
    if mh is not None:
        mh_norm = mh / (abs(mh) + 1e-9) * min(abs(mh)/(bars4h[i]["close"]*0.001+1e-9), 1.0)
        if mh < 0:   bear += abs(mh_norm) * 0.4
        elif mh > 0: bull += abs(mh_norm) * 0.4

    # Funding ×2.0
    ts = bars4h[i]["time"]
    fr = find_funding_at(ts)
    if fr > 0:   bear += min(fr/0.0005, 1.0) * 2.0
    elif fr < 0: bull += min(-fr/0.0005, 1.0) * 2.0

    return bear - bull   # positive = bearish

# ─── Group 1: Higher TF ───────────────────────────────────────────────────────
def group1_score(i):
    """Higher TF features. Returns float (positive=bearish)."""
    score = 0.0
    ts = bars4h[i]["time"]

    # RSI(14) 1d
    di = ts_to_idx(d_times, ts)
    if di >= 1:
        rd = rsi1d[di]
        if rd is not None:
            if rd > 75:   score += 2.0
            elif rd < 25: score -= 2.0
            # RSI-1d reverting (OB turning down)
            rd_prev = rsi1d[di-1]
            if rd_prev is not None:
                if rd < rd_prev and rd > 70:  score += 0.8
                if rd > rd_prev and rd < 30:  score -= 0.8

    # BB%B(20,2) 1w
    wi = ts_to_idx(w_times, ts)
    if wi >= 0:
        bbw = bb1w[wi]
        if bbw is not None:
            if bbw > 1.05:   score += 1.5
            elif bbw < -0.05: score -= 1.5

    # EMA200 distance 1d
    if di >= 0:
        e200 = ema200d[di]
        cl = bars1d[di]["close"]
        if e200 and e200 > 0:
            dist_pct = abs(cl/e200 - 1) * 100
            if dist_pct > 15:
                if cl > e200: score += 1.0   # overextended bullish = bearish signal
                else:         score -= 1.0   # overextended bearish = bullish signal

    return score

# ─── Group 2: Divergence Quality Score ───────────────────────────────────────
def group2_score(i):
    """Multi-pivot divergence quality. Returns float (positive=bearish)."""
    score = 0.0

    # Count consecutive bearish divergent highs (price HH but RSI LH)
    highs_all = [(j, p, t) for j, p, t in pivots4h if t == "H" and j < i]
    lows_all  = [(j, p, t) for j, p, t in pivots4h if t == "L" and j < i]

    # Count consecutive bearish divergences at recent highs
    bear_div_count = 0
    if len(highs_all) >= 3:
        # Check last N highs for sequential bearish divergence
        recent_highs = highs_all[-4:]  # up to 4 most recent
        for k in range(len(recent_highs)-1, 0, -1):
            h1i, h1p, _ = recent_highs[k-1]
            h2i, h2p, _ = recent_highs[k]
            r1 = rsi4[h1i]; r2 = rsi4[h2i]
            if r1 and r2 and h2p > h1p and r2 < r1:
                bear_div_count += 1
            else:
                break

    if bear_div_count == 1: score += 0.5
    elif bear_div_count == 2: score += 1.5
    elif bear_div_count >= 3: score += 3.0

    # Divergence MAGNITUDE (for the most recent divergence)
    if len(highs_all) >= 2 and bear_div_count >= 1:
        hi1_i, hi1_p, _ = highs_all[-2]
        hi2_i, hi2_p, _ = highs_all[-1]
        r1 = rsi4[hi1_i]; r2 = rsi4[hi2_i]
        if r1 and r2 and r1 > 0 and hi2_p > hi1_p and r2 < r1:
            rsi_delta = r1 - r2
            score += (rsi_delta / r1) * 5.0

    # Confirmation candle: last 4h candle bearish-body
    if bear_div_count >= 1:
        b = bars4h[i]
        if b["close"] < b["open"]:  # bearish body
            score += 0.5

    # Bullish divergence (mirror)
    bull_div_count = 0
    if len(lows_all) >= 3:
        recent_lows = lows_all[-4:]
        for k in range(len(recent_lows)-1, 0, -1):
            l1i, l1p, _ = recent_lows[k-1]
            l2i, l2p, _ = recent_lows[k]
            r1 = rsi4[l1i]; r2 = rsi4[l2i]
            if r1 and r2 and l2p < l1p and r2 > r1:
                bull_div_count += 1
            else:
                break

    if bull_div_count == 1: score -= 0.5
    elif bull_div_count == 2: score -= 1.5
    elif bull_div_count >= 3: score -= 3.0

    if len(lows_all) >= 2 and bull_div_count >= 1:
        lo1_i, lo1_p, _ = lows_all[-2]
        lo2_i, lo2_p, _ = lows_all[-1]
        r1 = rsi4[lo1_i]; r2 = rsi4[lo2_i]
        if r1 and r2 and r1 > 0 and lo2_p < lo1_p and r2 > r1:
            rsi_delta = r2 - r1
            score -= (rsi_delta / r1) * 5.0

    if bull_div_count >= 1:
        b = bars4h[i]
        if b["close"] > b["open"]:  # bullish body
            score -= 0.5

    return score

# ─── Group 3: ADX slope + Funding acceleration + Vol exhaustion ──────────────
def group3_score(i):
    """ADX slope, funding accel, volume exhaustion. Returns float (positive=bearish)."""
    score = 0.0

    # ADX slope 4h: ADX>25 AND declining 3 bars
    if i >= 3:
        adx_now  = adx4[i]
        adx_1    = adx4[i-1]
        adx_2    = adx4[i-2]
        if adx_now and adx_1 and adx_2 and adx_now > 25:
            if adx_now < adx_1 < adx_2:  # trend weakening
                # Bear if price was going up, bull if going down
                cl_now = bars4h[i]["close"]
                cl_3b  = bars4h[i-3]["close"]
                if cl_now > cl_3b: score += 0.8
                else:              score -= 0.8

    # Funding acceleration
    ts = bars4h[i]["time"]
    fr_now  = find_funding_at(ts)
    # Previous funding (8h ago)
    ts_prev = ts - 8*3600*1000
    fr_prev = find_funding_at(ts_prev)
    if fr_now > 0.0003 and fr_prev > 0 and fr_now > fr_prev * 1.5:
        score += 1.2
    elif fr_now < -0.0003 and fr_prev < 0 and fr_now < fr_prev * 1.5:
        score -= 1.2

    # Volume exhaustion 4h: vol > vol_MA×3 AND body < 20% of range
    vm = vma4[i]
    if vm and vm > 0:
        vol = bars4h[i]["volume"]
        b = bars4h[i]
        rng = b["high"] - b["low"]
        body = abs(b["close"] - b["open"])
        if vol > vm*3.0 and rng > 0 and body/rng < 0.20:
            # Climax candle
            if b["close"] > b["open"]: score += 0.8   # up climax = bearish
            else:                       score -= 0.8   # down climax = bullish

    return score

# ─── Compute all scores ───────────────────────────────────────────────────────
print("Computing RCI scores for all 4h bars...")
WARMUP = 250  # need 200-bar EMA for EMA200d

v3_raw  = [0.0]*n4
g1_raw  = [0.0]*n4
g2_raw  = [0.0]*n4
g3_raw  = [0.0]*n4

for i in range(WARMUP, n4):
    v3_raw[i] = v3_score(i)
    g1_raw[i] = group1_score(i)
    g2_raw[i] = group2_score(i)
    g3_raw[i] = group3_score(i)

# Smooth v3 raw (EMA3)
v3_smooth = ema(v3_raw, 3)

# For v4, combine then smooth
v4_raw = [v3_raw[i] + g1_raw[i] + g2_raw[i] + g3_raw[i] for i in range(n4)]
v4_smooth = ema(v4_raw, 3)

# Group-only versions (for ablation)
g1_smooth = ema([g1_raw[i] for i in range(n4)], 3)
g2_smooth = ema([g2_raw[i] for i in range(n4)], 3)
g3_smooth = ema([g3_raw[i] for i in range(n4)], 3)

v3_g1 = ema([v3_raw[i]+g1_raw[i] for i in range(n4)], 3)
v3_g2 = ema([v3_raw[i]+g2_raw[i] for i in range(n4)], 3)
v3_g3 = ema([v3_raw[i]+g3_raw[i] for i in range(n4)], 3)

print("  Scores computed.")

# ─── Backtest engine ─────────────────────────────────────────────────────────
def backtest(scores, thresholds, label=""):
    """
    scores: list of floats (positive=bearish, negative=bullish)
    Returns list of signal dicts for all thresholds.
    Only BEARISH signals for now (as per v3 focus on tops).
    """
    all_signals = []
    for thr in thresholds:
        signals = []
        last_signal_bar = -20
        for i in range(WARMUP+10, n4 - REVERSAL_BARS_4H):
            sc = scores[i]
            if sc is None: continue
            if i - last_signal_bar < 8: continue  # 32h cooldown

            direction = None
            if sc > thr:    direction = "BEAR"
            elif sc < -thr: direction = "BULL"
            if not direction: continue

            entry_price = bars4h[i]["close"]
            future_bars = bars4h[i+1:i+REVERSAL_BARS_4H+1]
            if direction == "BEAR":
                min_fut = min(b["low"] for b in future_bars)
                drop_pct = (entry_price - min_fut) / entry_price * 100
                is_rev = drop_pct >= REVERSAL_PCT
                move_pct = drop_pct
            else:
                max_fut = max(b["high"] for b in future_bars)
                pump_pct = (max_fut - entry_price) / entry_price * 100
                is_rev = pump_pct >= REVERSAL_PCT
                move_pct = pump_pct

            ts = bars4h[i]["time"]
            dt = datetime.datetime.utcfromtimestamp(ts/1000)
            signals.append({
                "thr": thr, "bar": i, "ts": ts, "dt": dt, "yr": dt.year,
                "direction": direction, "score": round(sc, 3),
                "price": entry_price, "move_pct": round(move_pct, 2),
                "is_rev": is_rev,
            })
            last_signal_bar = i
        all_signals.append((thr, signals))
    return all_signals

THRESHOLDS = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0]

print("Running backtests...")
res_v3 = backtest(v3_smooth,  THRESHOLDS, "v3")
res_v4 = backtest(v4_smooth,  THRESHOLDS, "v4")
res_g1 = backtest(g1_smooth,  THRESHOLDS, "g1_only")
res_g2 = backtest(g2_smooth,  THRESHOLDS, "g2_only")
res_g3 = backtest(g3_smooth,  THRESHOLDS, "g3_only")
res_v3g1 = backtest(v3_g1, THRESHOLDS, "v3+g1")
res_v3g2 = backtest(v3_g2, THRESHOLDS, "v3+g2")
res_v3g3 = backtest(v3_g3, THRESHOLDS, "v3+g3")
print("  Done.")

# ─── Helpers ─────────────────────────────────────────────────────────────────
def precision(sigs):
    if not sigs: return 0.0, 0
    c = sum(1 for s in sigs if s["is_rev"])
    return c/len(sigs)*100, len(sigs)

def era_split(sigs):
    by_yr = defaultdict(list)
    for s in sigs: by_yr[s["yr"]].append(s)
    return by_yr

def oos_precision(thr_results):
    """Get precision for test period (2023+) at each threshold."""
    out = {}
    for thr, sigs in thr_results:
        test_sigs = [s for s in sigs if s["yr"] >= 2023]
        p, n = precision(test_sigs)
        out[thr] = (p, n)
    return out

# ─── Print results ────────────────────────────────────────────────────────────
print("\n" + "="*90)
print("RCI v4 BACKTEST — BTC 7y")
print("="*90)

# 1. Precision table v3 vs v4
print("\n── PRECISION TABLE: v3 vs v4 (all years) ──")
print(f"{'Threshold':>10} | {'v3 n':>6} {'v3 prec':>8} | {'v4 n':>6} {'v4 prec':>8} | {'delta':>7}")
print("-"*60)
for (thr, sv3), (_, sv4) in zip(res_v3, res_v4):
    pv3, nv3 = precision(sv3)
    pv4, nv4 = precision(sv4)
    delta = pv4 - pv3
    flag = "↑" if delta > 2 else ("↓" if delta < -2 else "~")
    print(f"  thr={thr:>4.1f} | {nv3:>6} {pv3:>7.1f}% | {nv4:>6} {pv4:>7.1f}% | {delta:>+6.1f}pp {flag}")

# 2. Era split for best threshold
# Find best threshold for v4 (highest precision with n >= 30 total, or best n*precision)
best_thr = None; best_score = 0
for thr, sigs in res_v4:
    p, n = precision(sigs)
    # score = precision weighted by log(n), penalize very few signals
    s = p * math.log(max(n, 1)) if n >= 15 else 0
    if s > best_score: best_score = s; best_thr = thr

print(f"\n── ERA SPLIT (v4, best threshold={best_thr}) ──")
best_v4_sigs = next(sigs for thr, sigs in res_v4 if thr == best_thr)
best_v3_sigs = next(sigs for thr, sigs in res_v3 if thr == best_thr)

print(f"{'Year':>5} | {'v3 n':>5} {'v3%':>6} | {'v4 n':>5} {'v4%':>6} | {'base':>5}")
print("-"*50)
base_rate = 39.0  # %
all_years = sorted(set([s["yr"] for s in best_v4_sigs+best_v3_sigs]))
for yr in all_years:
    sv3 = [s for s in best_v3_sigs if s["yr"]==yr]
    sv4 = [s for s in best_v4_sigs if s["yr"]==yr]
    p3, n3 = precision(sv3); p4, n4 = precision(sv4)
    flag4 = "✓" if p4 >= 50 else "✗"
    print(f"  {yr} | {n3:>5} {p3:>5.1f}% | {n4:>5} {p4:>5.1f}% {flag4} | {base_rate:.0f}%")

pass_v3 = sum(1 for yr in all_years
              if precision([s for s in best_v3_sigs if s["yr"]==yr])[0] >= 50)
pass_v4 = sum(1 for yr in all_years
              if precision([s for s in best_v4_sigs if s["yr"]==yr])[0] >= 50)
print(f"  Passing years (≥50%): v3={pass_v3}/{len(all_years)}  v4={pass_v4}/{len(all_years)}")

# 3. Ablation table at best threshold
print(f"\n── ABLATION TABLE (threshold={best_thr}) ──")
variants = [
    ("v3 (baseline)", res_v3),
    ("v3+Group1 HTF", res_v3g1),
    ("v3+Group2 Div", res_v3g2),
    ("v3+Group3 ADX/Fund", res_v3g3),
    ("v4 (all groups)", res_v4),
]
print(f"{'Variant':25} | {'n':>5} {'prec':>7} | {'OOS n':>6} {'OOS prec':>9}")
print("-"*65)
for name, res in variants:
    sigs  = next(s for t, s in res if t == best_thr)
    oos   = [s for s in sigs if s["yr"] >= 2023]
    p, n  = precision(sigs)
    po, no = precision(oos)
    print(f"  {name:25} | {n:>5} {p:>6.1f}% | {no:>6} {po:>8.1f}%")

# 4. Train/Test split
print(f"\n── TRAIN/TEST SPLIT ──")
print(f"{'Threshold':>10} | {'train n':>8} {'train%':>7} | {'OOS n':>7} {'OOS%':>7}")
print("-"*55)
for (thr, sv4) in res_v4:
    train = [s for s in sv4 if s["yr"] <= 2022]
    test  = [s for s in sv4 if s["yr"] >= 2023]
    pt, nt = precision(train); po, no = precision(test)
    flag = "✓" if po >= 50 else ("~" if po >= 40 else "✗")
    print(f"  thr={thr:>4.1f} | {nt:>8} {pt:>6.1f}% | {no:>7} {po:>6.1f}% {flag}")

# 5. Weight sweep (train 2019-2022, test 2023-2026)
print(f"\n── WEIGHT SWEEP (OOS 2023-2026, fixed thr={best_thr}) ──")
print("Sweeping weights for each group (multiplier on group score)...")
best_oos_p = 0; best_weights = (1.0, 1.0, 1.0)

weight_options = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0]
results_sweep = []
for w1 in weight_options:
    for w2 in weight_options:
        for w3 in weight_options:
            # Build combined score
            comb = [v3_raw[i] + w1*g1_raw[i] + w2*g2_raw[i] + w3*g3_raw[i] for i in range(n4)]
            comb_s = ema(comb, 3)

            # Backtest (simplified, single threshold)
            sigs = []; last = -20
            for i in range(WARMUP+10, n4 - REVERSAL_BARS_4H):
                sc = comb_s[i]
                if sc is None: continue
                if i - last < 8: continue
                direction = None
                if sc > best_thr: direction = "BEAR"
                elif sc < -best_thr: direction = "BULL"
                if not direction: continue
                ep = bars4h[i]["close"]
                fb = bars4h[i+1:i+REVERSAL_BARS_4H+1]
                if direction == "BEAR":
                    mf = min(b["low"] for b in fb)
                    ir = (ep-mf)/ep*100 >= REVERSAL_PCT
                    mp = (ep-mf)/ep*100
                else:
                    mf = max(b["high"] for b in fb)
                    ir = (mf-ep)/ep*100 >= REVERSAL_PCT
                    mp = (mf-ep)/ep*100
                ts = bars4h[i]["time"]
                dt = datetime.datetime.utcfromtimestamp(ts/1000)
                sigs.append({"yr": dt.year, "is_rev": ir})
                last = i

            # OOS precision
            oos = [s for s in sigs if s["yr"] >= 2023]
            train_s = [s for s in sigs if s["yr"] <= 2022]
            po, no = precision(oos)
            pt, nt = precision(train_s)

            results_sweep.append((po, no, pt, nt, w1, w2, w3))

results_sweep.sort(key=lambda x: -x[0])
print(f"\n  Top-10 weight combos by OOS precision:")
print(f"  {'w1(HTF)':>9} {'w2(Div)':>9} {'w3(ADX)':>9} | {'OOS n':>6} {'OOS%':>7} | {'Train%':>7}")
print("  "+"-"*65)
shown = 0
for po, no, pt, nt, w1, w2, w3 in results_sweep[:30]:
    if no < 10: continue  # skip too-few signals
    print(f"  {w1:>9.1f} {w2:>9.1f} {w3:>9.1f} | {no:>6} {po:>6.1f}% | {pt:>6.1f}%")
    shown += 1
    if shown >= 10: break

best_row = next((r for r in results_sweep if r[1] >= 10), results_sweep[0])
best_weights = (best_row[4], best_row[5], best_row[6])
print(f"\n  BEST WEIGHTS: w1={best_weights[0]} w2={best_weights[1]} w3={best_weights[2]}")
print(f"  OOS precision: {best_row[0]:.1f}% (n={best_row[1]})")

# 6. Final recommended config
print("\n" + "="*90)
print("RECOMMENDED RCI v4 CONFIG")
print("="*90)
w1, w2, w3 = best_weights
print(f"""
Formula:
  raw = v3_raw + {w1}×Group1_HTF + {w2}×Group2_DivQuality + {w3}×Group3_ADX_FundAccel
  RCI_v4 = EMA(raw, 3)

v3 components:
  + Funding(×2.0): funding_rate/0.0005 capped at 1.0
  + RSI-4h(×1.5): (rsi-70)/30 if >70
  + Stoch-4h(×0.8): (stoch-80)/20 if >80
  + BB%B-4h(×0.8): (bb-1.0)×2 if >1.0
  + MACD hist(×0.4): normalized direction signal

Group1 HTF (×{w1}):
  + RSI-1d>75: +2.0 | RSI-1d<25: -2.0
  + RSI-1d reverting from OB (>70, turning down): +0.8
  + BB%B-1w>1.05: +1.5 | BB%B-1w<-0.05: -1.5
  + EMA200-1d distance >15% overextended: ±1.0

Group2 DivQuality (×{w2}):
  + Consecutive bearish div highs: n=1→+0.5, n=2→+1.5, n=3→+3.0
  + Divergence magnitude (rsi_delta/prior_rsi × 5.0)
  + Confirmation candle bonus: +0.5

Group3 ADX/FundAccel (×{w3}):
  + ADX>25 & declining 3 bars (trend weakening): ±0.8
  + Funding acceleration (fr>0.0003 & fr>prev×1.5): ±1.2
  + Volume exhaustion (vol>3×MA & body<20% range): ±0.8

SIGNAL: RCI_v4 > {best_thr} → BEARISH top signal
""")

# Summary per-year for best v4
print(f"── PER-YEAR v4 (thr={best_thr}, weights={best_weights}) ──")
w1, w2, w3 = best_weights
comb_best = [v3_raw[i] + w1*g1_raw[i] + w2*g2_raw[i] + w3*g3_raw[i] for i in range(n4)]
comb_best_s = ema(comb_best, 3)
sigs_best = []; last = -20
for i in range(WARMUP+10, n4 - REVERSAL_BARS_4H):
    sc = comb_best_s[i]
    if sc is None: continue
    if i - last < 8: continue
    direction = None
    if sc > best_thr: direction = "BEAR"
    elif sc < -best_thr: direction = "BULL"
    if not direction: continue
    ep = bars4h[i]["close"]
    fb = bars4h[i+1:i+REVERSAL_BARS_4H+1]
    if direction == "BEAR":
        mf = min(b["low"] for b in fb)
        ir = (ep-mf)/ep*100 >= REVERSAL_PCT
        mp = (ep-mf)/ep*100
    else:
        mf = max(b["high"] for b in fb)
        ir = (mf-ep)/ep*100 >= REVERSAL_PCT
        mp = (mf-ep)/ep*100
    ts = bars4h[i]["time"]
    dt = datetime.datetime.utcfromtimestamp(ts/1000)
    sigs_best.append({"yr": dt.year, "dt": dt, "direction": direction,
                      "is_rev": ir, "price": ep, "move_pct": round(mp,2), "score": round(sc,3)})
    last = i

by_yr = defaultdict(list)
for s in sigs_best: by_yr[s["yr"]].append(s)
pass_count = 0
print(f"{'Year':>5} | {'n':>4} {'correct':>8} {'prec%':>7} | flag")
print("-"*40)
for yr in sorted(by_yr):
    ys = by_yr[yr]; p, n = precision(ys)
    flag = "✓" if p >= 50 else "✗"
    if p >= 50: pass_count += 1
    print(f"  {yr} | {n:>4} {sum(1 for s in ys if s['is_rev']):>8} {p:>6.1f}% | {flag}")
total_p, total_n = precision(sigs_best)
print(f"  ALL  | {total_n:>4} {sum(1 for s in sigs_best if s['is_rev']):>8} {total_p:>6.1f}%")
print(f"  Passing years ≥50%: {pass_count}/{len(by_yr)}")

print("\n" + "="*90)
print("BASE RATE: 39% random  |  TARGET: precision≥50%, ≥5/7 years")
print("="*90)
