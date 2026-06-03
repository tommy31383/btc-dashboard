#!/usr/bin/env python3
"""
rci-oos-recalibrate.py — Iter19-20: RCI v4 OOS audit + recalibrate.

Phát hiện iter19: RCI v4 ALL groups OOS 2023-26 chỉ 32% < base rate 39%.
Funding-only (v3) OOS 41.8% — tốt nhất nhưng vẫn yếu.

Iter20: sweep từng component riêng lẻ trên OOS 2023-26 để tìm cái còn sống.
Metric: precision vs base rate (% reversal trong 12 bar 4h = 48h).
"""
import json, math, datetime, statistics
from collections import defaultdict

CACHE_5M   = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
CACHE_FUND = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-funding-7y.json"
REVERSAL_PCT  = 3.0
REVERSAL_BARS = 12   # 48h window

print("Loading...")
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
bars1h = build_tf(3600*1000)
c4 = [b["close"] for b in bars4h]
print(f"  4h: {len(bars4h)}")

def ema_s(xs, p):
    k=2/(p+1); out=[None]*len(xs); e=None
    for i,x in enumerate(xs):
        if x is not None: e = x if e is None else x*k+e*(1-k)
        out[i]=e
    return out

def rsi_s(closes, p=14):
    n=len(closes); out=[None]*n
    if n<=p: return out
    ag=al=0
    for i in range(1,p+1):
        d=closes[i]-closes[i-1]; ag+=max(d,0); al+=max(-d,0)
    ag/=p; al/=p
    out[p]=100-100/(1+ag/al) if al>0 else 100
    for i in range(p+1,n):
        d=closes[i]-closes[i-1]; ag=(ag*(p-1)+max(d,0))/p; al=(al*(p-1)+max(-d,0))/p
        out[i]=100-100/(1+ag/al) if al>0 else 100
    return out

def stoch_s(bars, p=14):
    n=len(bars); out=[None]*n
    for i in range(p-1,n):
        lo=min(b["low"] for b in bars[i-p+1:i+1]); hi=max(b["high"] for b in bars[i-p+1:i+1])
        out[i]=100*(bars[i]["close"]-lo)/(hi-lo) if hi>lo else 50
    return out

def bb_pctb_s(closes, p=20, mult=2.0):
    n=len(closes); out=[None]*n
    for i in range(p-1,n):
        w=closes[i-p+1:i+1]; mid=sum(w)/p; std=statistics.stdev(w)
        rng=(mid+mult*std)-(mid-mult*std)
        out[i]=(closes[i]-(mid-mult*std))/rng if rng>0 else 0.5
    return out

def fund_at(t4h_ms):
    # closest funding <= t4h_ms
    best=None
    for ft,fr in fund_map.items():
        if ft<=t4h_ms and (best is None or ft>best[0]): best=(ft,fr)
    return best[1] if best else None

# Precompute funding per 4h bar
print("Mapping funding...")
fund_by_bar = []
for b in bars4h:
    fund_by_bar.append(fund_at(b["time"]))

# Labels: did price reverse ≥3% within next 12 bars?
print("Labeling reversals...")
labels = [None]*len(bars4h)
for i in range(len(bars4h)-REVERSAL_BARS):
    p0=c4[i]; future=c4[i+1:i+REVERSAL_BARS+1]
    # BEAR label: top signal — price drops ≥3%
    labels[i] = any(f/p0-1 <= -REVERSAL_PCT/100 for f in future)

base_rate = sum(1 for l in labels if l is True) / sum(1 for l in labels if l is not None)
print(f"Base rate (reversal ≥{REVERSAL_PCT}% down / 48h): {base_rate:.1%}")

# Indicators
print("Computing indicators...")
rsi4   = rsi_s(c4, 14)
stk4   = stoch_s(bars4h, 14)
bb4    = bb_pctb_s(c4, 20, 2.0)

# Component-by-component OOS sweep
def test_component(name, signal_fn, era="OOS"):
    """signal_fn(i) → True if bearish signal at bar i. Compute precision OOS."""
    sigs=[]
    for i in range(50, len(bars4h)-REVERSAL_BARS):
        yr=datetime.datetime.utcfromtimestamp(bars4h[i]["time"]/1000).year
        if era=="OOS" and yr<2023: continue
        if era=="TRAIN" and yr>=2023: continue
        s=signal_fn(i)
        if s is None or s is False: continue
        sigs.append(labels[i])
    n=len(sigs); prec=100*sum(1 for x in sigs if x)/n if n else 0
    base=100*base_rate
    flag="✓" if prec>base+3 else "✗" if prec<base-3 else "~"
    print(f"  {name:<30} n={n:>5}  prec={prec:.1f}%  base={base:.1f}%  {flag}")
    return prec, n

print(f"\n── COMPONENT SWEEP OOS 2023-26 (base rate {base_rate:.1%}) ──")

# Funding thresholds
for thr in (0.0001, 0.0003, 0.0005, 0.001):
    test_component(f"Funding>{thr*100:.3f}%", lambda i,t=thr: fund_by_bar[i] is not None and fund_by_bar[i]>t)

# RSI overbought
for lv in (70, 75, 80):
    test_component(f"RSI4h>{lv}", lambda i,l=lv: rsi4[i] is not None and rsi4[i]>l)

# Stoch overbought
for lv in (80, 85, 90):
    test_component(f"Stoch4h>{lv}", lambda i,l=lv: stk4[i] is not None and stk4[i]>l)

# BB%B
for lv in (0.95, 1.0, 1.1):
    test_component(f"BB%B>{lv}", lambda i,l=lv: bb4[i] is not None and bb4[i]>l)

# Combos
test_component("Fund>0.05% AND RSI>70", lambda i: (fund_by_bar[i] or 0)>0.0005 and (rsi4[i] or 0)>70)
test_component("Fund>0.05% AND Stoch>80", lambda i: (fund_by_bar[i] or 0)>0.0005 and (stk4[i] or 0)>80)
test_component("RSI>70 AND Stoch>80", lambda i: (rsi4[i] or 0)>70 and (stk4[i] or 0)>80)
test_component("RSI>70 AND BB>0.95", lambda i: (rsi4[i] or 0)>70 and (bb4[i] or 0)>0.95)
test_component("Fund>0.05% AND RSI>70 AND Stoch>80", lambda i: (fund_by_bar[i] or 0)>0.0005 and (rsi4[i] or 0)>70 and (stk4[i] or 0)>80)

print(f"\n── RCI COMPOSITE SCORE (v4 vs v5-weights) OOS 2023-26 ──")
print("Sim composite: trigger when score > threshold, measure reversal precision")
def composite_score(i, use_v5=False):
    fr=fund_by_bar[i] or 0; r4=rsi4[i] or 50; sk=stk4[i] or 50; bb=bb4[i] or 0.5
    # funding
    fs=2.0*min(fr/0.0005,1.0) if fr>0 else 0
    # rsi overbought
    rw=0.7 if use_v5 else 1.5
    rs=(rw if r4>75 else rw*0.6 if r4>70 else 0)
    # stoch
    sw=0.4 if use_v5 else 0.8
    ss=(sw if sk>80 else 0)
    # bb
    bw=0.4 if use_v5 else 0.8
    bs=(bw if bb>1.1 else bw*0.5 if bb>0.95 else 0)
    return fs+rs+ss+bs

for label,v5 in (("v4-weights",False),("v5-weights",True)):
    for thr in (1.0,1.5,2.0,2.5):
        sigs=[]
        for i in range(50,len(bars4h)-REVERSAL_BARS):
            yr=datetime.datetime.utcfromtimestamp(bars4h[i]["time"]/1000).year
            if yr<2023: continue
            if composite_score(i,v5)>thr: sigs.append(labels[i])
        n=len(sigs); prec=100*sum(1 for x in sigs if x)/n if n else 0
        base=100*base_rate; flag="✓" if prec>base+3 else "✗" if prec<base-3 else "~"
        print(f"  {label} thr={thr:.1f}  n={n:>5}  prec={prec:.1f}%  base={base:.1f}%  {flag}")

print(f"\n── ITER22: v5 per-year stability (thr=2.0 vs 2.5) ALL 7y ──")
for thr in (2.0, 2.5):
    by_yr = defaultdict(list)
    for i in range(50, len(bars4h)-REVERSAL_BARS):
        if composite_score(i, True) > thr:
            yr = datetime.datetime.utcfromtimestamp(bars4h[i]["time"]/1000).year
            by_yr[yr].append(labels[i])
    stable = 0; total = 0
    print(f"\n  v5 thr={thr}:")
    for yr in sorted(by_yr):
        xs = by_yr[yr]; n = len(xs)
        prec = 100*sum(1 for x in xs if x)/n if n else 0
        base = 100*base_rate; flag = "✓" if prec > base else "✗"
        if prec > base: stable += 1
        total += 1
        print(f"    {yr}: prec={prec:.0f}% n={n:>4}  {flag}")
    print(f"  stable ≥base: {stable}/{total}")

print(f"\n── SAME COMPONENTS TRAIN 2019-22 ──")
for thr in (0.0005,):
    test_component(f"Funding>0.05%", lambda i: fund_by_bar[i] is not None and fund_by_bar[i]>thr, "TRAIN")
test_component("RSI4h>70", lambda i: rsi4[i] is not None and rsi4[i]>70, "TRAIN")
test_component("Fund>0.05% AND RSI>70", lambda i: (fund_by_bar[i] or 0)>0.0005 and (rsi4[i] or 0)>70, "TRAIN")
test_component("RSI>70 AND Stoch>80", lambda i: (rsi4[i] or 0)>70 and (stk4[i] or 0)>80, "TRAIN")
