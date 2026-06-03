#!/usr/bin/env python3
"""
rci-audit-2026-06-03.py — 5 new ideas audit OOS 2023-26

Ideas:
  1. REVERSAL_PCT thresholds: 2%, 2.5%, 3% (current), 3.5%
  2. FundAccel ratio: 1.3x, 1.5x (current), 2.0x — threshold fr>0.0003
  3. Funding TIME LAG: current vs 8h-ago vs 16h-ago
  4. Volume spike + funding combo: vol>2xMA + funding>0.05%
  5. VolExhaust lower threshold: vol>2xMA (vs current 3x), body<20%
"""
import json, math, datetime, statistics
from collections import defaultdict

CACHE_5M   = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
CACHE_FUND = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-funding-7y.json"

print("Loading data...")
raw5m = json.load(open(CACHE_5M)); raw5m.sort(key=lambda x: x["time"])
raw_fund = json.load(open(CACHE_FUND))
s=raw_fund[0]
tk=[k for k in s if "time" in k.lower() or k=="t"][0]
rk=[k for k in s if k in ("fundingRate","rate","r","funding")][0]
fund_map={int(e[tk]):float(e[rk]) for e in raw_fund}

def build_tf(ms):
    b = {}
    for c in raw5m:
        k = c["time"] // ms
        if k not in b: b[k] = {"time": k*ms, "open": c["open"], "high": c["high"], "low": c["low"], "close": c["close"], "volume": c["volume"]}
        else: o=b[k]; o["high"]=max(o["high"],c["high"]); o["low"]=min(o["low"],c["low"]); o["close"]=c["close"]; o["volume"]+=c["volume"]
    return [b[k] for k in sorted(b)]

bars4h = build_tf(4*3600*1000)
c4 = [b["close"] for b in bars4h]
print(f"  4h bars: {len(bars4h)}")

# Precompute funding per 4h bar (all at once for speed)
fund_times = sorted(fund_map.keys())
fund_rates = [fund_map[t] for t in fund_times]

def fund_at_time(t_ms):
    # binary search for closest funding <= t_ms
    lo, hi = 0, len(fund_times)-1
    while lo <= hi:
        mid = (lo+hi)//2
        if fund_times[mid] <= t_ms: lo = mid+1
        else: hi = mid-1
    if hi < 0: return None
    return fund_rates[hi], hi  # return (rate, index)

print("Mapping funding with time index...")
fund_by_bar = []       # current funding rate per 4h bar
fund_idx_by_bar = []   # index into fund_times for each bar
for b in bars4h:
    res = fund_at_time(b["time"])
    if res is None:
        fund_by_bar.append(None)
        fund_idx_by_bar.append(None)
    else:
        fund_by_bar.append(res[0])
        fund_idx_by_bar.append(res[1])

def get_fund_n_periods_ago(bar_i, n_8h_periods):
    """Get funding rate N*8h before bar i's funding timestamp."""
    fi = fund_idx_by_bar[bar_i]
    if fi is None or fi - n_8h_periods < 0: return None
    return fund_rates[fi - n_8h_periods]

def test_component(name, signal_fn, labels, base_rate, era="OOS", bars=bars4h):
    sigs=[]
    for i in range(50, len(bars)-12):
        yr=datetime.datetime.utcfromtimestamp(bars[i]["time"]/1000).year
        if era=="OOS" and yr<2023: continue
        if era=="TRAIN" and yr>=2023: continue
        s=signal_fn(i)
        if not s: continue
        sigs.append(labels[i])
    n=len(sigs); prec=100*sum(1 for x in sigs if x)/n if n else 0
    base=100*base_rate; flag="✓✓" if prec>base+5 else "✓" if prec>base+3 else "✗✗" if prec<base-5 else "✗" if prec<base-3 else "~"
    print(f"  {name:<45} n={n:>5}  prec={prec:.1f}%  base={base:.1f}%  {flag}")
    return prec, n

# ═══════════════════════════════════════════════════════════════════
# IDEA 1: REVERSAL_PCT thresholds
# ═══════════════════════════════════════════════════════════════════
print("\n" + "="*70)
print("IDEA 1: REVERSAL_PCT thresholds (current=3.0%)")
print("="*70)

for pct in [2.0, 2.5, 3.0, 3.5]:
    REVERSAL_BARS = 12
    labels = [None]*len(bars4h)
    for i in range(len(bars4h)-REVERSAL_BARS):
        p0=c4[i]; future=c4[i+1:i+REVERSAL_BARS+1]
        labels[i] = any(f/p0-1 <= -pct/100 for f in future)
    base = sum(1 for l in labels if l is True) / sum(1 for l in labels if l is not None)
    print(f"\n  pct={pct}% base_rate={base:.1%}")
    test_component(f"Funding>0.05% (pct={pct}%)", lambda i: (fund_by_bar[i] or 0)>0.0005, labels, base)
    test_component(f"Funding>0.03% (pct={pct}%)", lambda i: (fund_by_bar[i] or 0)>0.0003, labels, base)

# Use pct=3% for remaining tests
REVERSAL_PCT = 3.0
REVERSAL_BARS = 12
labels_3pct = [None]*len(bars4h)
for i in range(len(bars4h)-REVERSAL_BARS):
    p0=c4[i]; future=c4[i+1:i+REVERSAL_BARS+1]
    labels_3pct[i] = any(f/p0-1 <= -REVERSAL_PCT/100 for f in future)
base_3pct = sum(1 for l in labels_3pct if l is True) / sum(1 for l in labels_3pct if l is not None)
print(f"\n  Using REVERSAL_PCT=3% base_rate={base_3pct:.1%} for remaining tests")

# ═══════════════════════════════════════════════════════════════════
# IDEA 2: FundAccel ratio
# ═══════════════════════════════════════════════════════════════════
print("\n" + "="*70)
print("IDEA 2: FundAccel ratio (current: fr>0.0003 AND fr>prev*1.5)")
print("="*70)

for ratio in [1.3, 1.5, 2.0]:
    def make_accel(r=ratio):
        def fn(i):
            fr = fund_by_bar[i]
            pfr = get_fund_n_periods_ago(i, 1)  # 1 funding period ago (8h)
            if fr is None or pfr is None: return False
            return fr > 0.0003 and pfr > 0 and fr > pfr * r
        return fn
    test_component(f"FundAccel ratio={ratio}x (fr>0.03%)", make_accel(ratio), labels_3pct, base_3pct)

# Also test with lower threshold 0.0002
for ratio in [1.3, 1.5, 2.0]:
    def make_accel2(r=ratio):
        def fn(i):
            fr = fund_by_bar[i]
            pfr = get_fund_n_periods_ago(i, 1)
            if fr is None or pfr is None: return False
            return fr > 0.0002 and pfr > 0 and fr > pfr * r
        return fn
    test_component(f"FundAccel ratio={ratio}x (fr>0.02%)", make_accel2(ratio), labels_3pct, base_3pct)

# ═══════════════════════════════════════════════════════════════════
# IDEA 3: Funding TIME LAG (current = funding at bar time)
#   0 = current (default), 1 = 1 period ago (8h), 2 = 2 periods ago (16h)
# ═══════════════════════════════════════════════════════════════════
print("\n" + "="*70)
print("IDEA 3: Funding time lag (0=current, 1=8h-ago, 2=16h-ago)")
print("="*70)

for lag in [0, 1, 2]:
    def make_lag(n=lag):
        def fn(i):
            if n == 0:
                fr = fund_by_bar[i]
            else:
                fr = get_fund_n_periods_ago(i, n)
            return fr is not None and fr > 0.0005
        return fn
    test_component(f"Funding>0.05% lag={lag}*8h", make_lag(lag), labels_3pct, base_3pct)

for lag in [0, 1, 2]:
    def make_lag2(n=lag):
        def fn(i):
            if n == 0:
                fr = fund_by_bar[i]
            else:
                fr = get_fund_n_periods_ago(i, n)
            return fr is not None and fr > 0.0003
        return fn
    test_component(f"Funding>0.03% lag={lag}*8h", make_lag2(lag), labels_3pct, base_3pct)

# ═══════════════════════════════════════════════════════════════════
# IDEA 4: Volume spike + funding combo
# ═══════════════════════════════════════════════════════════════════
print("\n" + "="*70)
print("IDEA 4: Volume spike + funding combo")
print("="*70)

def vol_ma(i, n=20):
    if i < n: return None
    return sum(b["volume"] for b in bars4h[i-n:i]) / n

# Vol>2x alone
test_component("Vol>2xMA alone", lambda i: (vm:=vol_ma(i)) is not None and bars4h[i]["volume"] > vm*2, labels_3pct, base_3pct)
test_component("Vol>3xMA alone", lambda i: (vm:=vol_ma(i)) is not None and bars4h[i]["volume"] > vm*3, labels_3pct, base_3pct)

# Vol spike + funding
test_component("Vol>2xMA AND Fund>0.05%", lambda i: (vm:=vol_ma(i)) is not None and bars4h[i]["volume"] > vm*2 and (fund_by_bar[i] or 0)>0.0005, labels_3pct, base_3pct)
test_component("Vol>2xMA AND Fund>0.03%", lambda i: (vm:=vol_ma(i)) is not None and bars4h[i]["volume"] > vm*2 and (fund_by_bar[i] or 0)>0.0003, labels_3pct, base_3pct)
test_component("Vol>3xMA AND Fund>0.03%", lambda i: (vm:=vol_ma(i)) is not None and bars4h[i]["volume"] > vm*3 and (fund_by_bar[i] or 0)>0.0003, labels_3pct, base_3pct)

# Vol-up-spike (body check): close > open + high vol
def vol_up_spike(i, vol_mult=2.0):
    vm = vol_ma(i)
    if vm is None: return False
    b = bars4h[i]
    rng = b["high"] - b["low"]
    body = abs(b["close"] - b["open"])
    return b["volume"] > vm*vol_mult and rng > 0 and body/rng < 0.25 and b["close"] > b["open"]

test_component("VolUpSpike(2x,body<25%) alone", lambda i: vol_up_spike(i,2.0), labels_3pct, base_3pct)
test_component("VolUpSpike(2x,body<25%)+Fund>0.03%", lambda i: vol_up_spike(i,2.0) and (fund_by_bar[i] or 0)>0.0003, labels_3pct, base_3pct)

# ═══════════════════════════════════════════════════════════════════
# IDEA 5: VolExhaust with lower threshold
# ═══════════════════════════════════════════════════════════════════
print("\n" + "="*70)
print("IDEA 5: VolExhaust — vol threshold variants, body threshold variants")
print("="*70)

def vol_exhaust(i, vol_mult=3.0, body_pct=0.20):
    vm = vol_ma(i)
    if vm is None or i == 0: return False
    last = bars4h[i]; prev = bars4h[i-1]
    rng = last["high"] - last["low"]
    body = abs(last["close"] - prev["close"])
    if last["volume"] > vm*vol_mult and rng > 0 and body/rng < body_pct:
        return last["close"] > prev["close"]  # bearish signal: up-close climax
    return False

# Grid: vol_mult x body_pct
for vm in [2.0, 2.5, 3.0]:
    for bp in [0.15, 0.20, 0.25]:
        def make_ve(v=vm, b=bp):
            return lambda i: vol_exhaust(i, v, b)
        test_component(f"VolExhaust vol>{vm}x body<{int(bp*100)}%", make_ve(), labels_3pct, base_3pct)

# ═══════════════════════════════════════════════════════════════════
# BEST COMBOS — combine top performers
# ═══════════════════════════════════════════════════════════════════
print("\n" + "="*70)
print("BEST COMBOS — Funding(current) + best new component")
print("="*70)

# FundAccel with best ratio combined with vol
def fund_accel_15x(i):
    fr = fund_by_bar[i]; pfr = get_fund_n_periods_ago(i, 1)
    return fr is not None and pfr is not None and fr > 0.0003 and pfr > 0 and fr > pfr * 1.5

def fund_accel_13x(i):
    fr = fund_by_bar[i]; pfr = get_fund_n_periods_ago(i, 1)
    return fr is not None and pfr is not None and fr > 0.0003 and pfr > 0 and fr > pfr * 1.3

test_component("Fund>0.05% OR FundAccel1.5x", lambda i: (fund_by_bar[i] or 0)>0.0005 or fund_accel_15x(i), labels_3pct, base_3pct)
test_component("Fund>0.05% AND FundAccel1.5x", lambda i: (fund_by_bar[i] or 0)>0.0005 and fund_accel_15x(i), labels_3pct, base_3pct)
test_component("Fund>0.03% AND FundAccel1.3x", lambda i: (fund_by_bar[i] or 0)>0.0003 and fund_accel_13x(i), labels_3pct, base_3pct)
test_component("Fund>0.05% + Vol>2x", lambda i: (fund_by_bar[i] or 0)>0.0005 and (vm:=vol_ma(i)) is not None and bars4h[i]["volume"] > vm*2, labels_3pct, base_3pct)
test_component("FundAccel1.5x + Vol>2x", lambda i: fund_accel_15x(i) and (vm:=vol_ma(i)) is not None and bars4h[i]["volume"] > vm*2, labels_3pct, base_3pct)

# ═══════════════════════════════════════════════════════════════════
# PER-YEAR STABILITY of best signals (to compare with current v5)
# ═══════════════════════════════════════════════════════════════════
print("\n" + "="*70)
print("PER-YEAR STABILITY — top candidates (2019-2026)")
print("="*70)

candidates = [
    ("Fund>0.05% current", lambda i: (fund_by_bar[i] or 0)>0.0005),
    ("FundAccel1.5x(0.03%)", fund_accel_15x),
    ("FundAccel1.3x(0.03%)", fund_accel_13x),
    ("Fund>0.05%+Accel1.5x", lambda i: (fund_by_bar[i] or 0)>0.0005 and fund_accel_15x(i)),
    ("Fund>0.05%+Vol>2x", lambda i: (fund_by_bar[i] or 0)>0.0005 and (vm:=vol_ma(i)) is not None and bars4h[i]["volume"] > vm*2),
]

for name, fn in candidates:
    print(f"\n  {name}:")
    by_yr = defaultdict(list)
    for i in range(50, len(bars4h)-12):
        if fn(i) and labels_3pct[i] is not None:
            yr = datetime.datetime.utcfromtimestamp(bars4h[i]["time"]/1000).year
            by_yr[yr].append(labels_3pct[i])
    stable = 0
    for yr in sorted(by_yr):
        xs = by_yr[yr]; n = len(xs)
        prec = 100*sum(1 for x in xs if x)/n if n else 0
        base = 100*base_3pct; flag = "✓" if prec > base else "✗"
        if prec > base: stable += 1
        print(f"    {yr}: prec={prec:.0f}% n={n:>4}  {flag}")
    total = len(by_yr)
    print(f"  stable: {stable}/{total}")

print("\nDone.")
