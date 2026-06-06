#!/usr/bin/env python3
"""
stochrsi-delay-grid.py
Grid test: entry_k (0,2,3,5,8,10,15,20) × delay (0,1,2,3,5,8,12,24)
Mỗi combo: per-year ROI 2019-2026 + tổng metrics
Focus LONG side (StochRSI gần 0)
"""
import json, datetime
from collections import defaultdict

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FEE=0.05/100; INITIAL=100_000; POS_PCT=0.10; MAX_HOLD=24

print("Loading...")
raw = json.load(open(CACHE)); raw.sort(key=lambda x: x['time'])

def build_tf(ms):
    b={}
    for c in raw:
        k=c["time"]//ms
        if k not in b: b[k]={"time":k*ms,"open":c["open"],"high":c["high"],
                              "low":c["low"],"close":c["close"]}
        else:
            b[k]["high"]=max(b[k]["high"],c["high"]); b[k]["low"]=min(b[k]["low"],c["low"])
            b[k]["close"]=c["close"]
    return [b[k] for k in sorted(b)]

bars=build_tf(3600*1000)
c1h=[b['close'] for b in bars]; h1h=[b['high'] for b in bars]; l1h=[b['low'] for b in bars]
n=len(bars)

def ema(src,p):
    out=[None]*len(src); k=2/(p+1); e=None
    for i,x in enumerate(src):
        e=x if e is None else x*k+e*(1-k); out[i]=e
    return out

def sma(src,p):
    out=[None]*len(src)
    for i in range(p-1,len(src)):
        w=[x for x in src[i-p+1:i+1] if x is not None]
        if len(w)==p: out[i]=sum(w)/p
    return out

def rsi_fn(src,p):
    out=[None]*len(src); ag=al=0.0
    for i in range(1,p+1):
        d=src[i]-src[i-1]
        if d>0: ag+=d
        else: al-=d
    ag/=p; al/=p; out[p]=100-100/(1+ag/al) if al else 100
    for i in range(p+1,len(src)):
        d=src[i]-src[i-1]
        ag=(ag*(p-1)+max(d,0))/p; al=(al*(p-1)+max(-d,0))/p
        out[i]=100-100/(1+ag/al) if al else 100
    return out

def stoch_fn(src,p):
    out=[None]*len(src)
    for i in range(p-1,len(src)):
        w=[x for x in src[i-p+1:i+1] if x is not None]
        if len(w)<p or src[i] is None: continue
        lo,hi=min(w),max(w)
        out[i]=(src[i]-lo)/(hi-lo)*100 if hi!=lo else 50
    return out

def atr_fn(p=14):
    trs=[h1h[0]-l1h[0]]
    for i in range(1,n):
        trs.append(max(h1h[i]-l1h[i],abs(h1h[i]-c1h[i-1]),abs(l1h[i]-c1h[i-1])))
    out=[None]*n; avg=sum(trs[:p])/p; out[p-1]=avg
    for i in range(p,n):
        avg=(avg*(p-1)+trs[i])/p; out[i]=avg
    return out

atrv=atr_fn()

# Precompute StochRSI variants: (rsi_p, stoch_p, smooth) → k_line
# Test các variants RSI period ngắn hơn
VARIANTS = {
    "SR(5,10,1)":  (5, 10, 1),
    "SR(5,14,1)":  (5, 14, 1),
    "SR(5,14,3)":  (5, 14, 3),
    "SR(7,14,1)":  (7, 14, 1),
    "SR(7,14,3)":  (7, 14, 3),
    "SR(14,14,1)": (14,14, 1),
    "SR(14,14,3)": (14,14, 3),
}

print("Building StochRSI variants...")
K_LINES = {}
for name,(rp,sp,sm) in VARIANTS.items():
    r=rsi_fn(c1h,rp); st=stoch_fn(r,sp); k=sma(st,sm) if sm>1 else st
    K_LINES[name]=k
    # Count how many times k touches near 0
    near0=sum(1 for v in k if v is not None and v<5)
    print(f"  {name}: near-0 bars={near0}")

# Exit options
EXIT_K   = [80, 90, 95, 100]   # exit when K >= this
SL_MULTS = [1.5, 2.0, 2.5]
DELAYS   = [0, 1, 2, 3, 5, 8, 12]
ENTRY_KS = [0, 2, 3, 5, 8, 10, 15, 20]

def backtest(k_line, entry_k, delay, exit_k, sl_mult):
    eq=INITIAL; pos=None; pending=None; cd=0
    yp=defaultdict(float); yn=defaultdict(int)
    for i in range(60,n):
        b=bars[i]; ts=b['time']
        d=datetime.datetime.fromtimestamp(ts/1000,datetime.timezone.utc)
        if d.year<2019: continue
        px=c1h[i]; av=atrv[i]
        if av is None: continue
        kc=k_line[i]; kp=k_line[i-1] if i>0 else None
        if kc is None or kp is None: continue

        # Manage position
        if pos:
            hit_sl=px<=pos['sl']
            hit_ex=kc>=exit_k
            max_h=(i-pos['bar'])>=MAX_HOLD
            if hit_sl or hit_ex or max_h:
                ep=pos['sl'] if hit_sl else px
                net=(ep/pos['ep']-1)*pos['n']-pos['n']*FEE*2
                eq=max(eq+net,1); yp[d.year]+=net; yn[d.year]+=1
                pos=None; pending=None; cd=i+1

        # Execute pending
        if pos is None and pending and i>=pending['eb']:
            sl=px-av*sl_mult
            pos={"ep":px,"sl":sl,"n":eq*POS_PCT,"bar":i}
            pending=None

        # New signal
        if pos is None and pending is None and i>cd:
            cross=(kp>entry_k and kc<=entry_k) if entry_k>0 else (kp>0 and kc==0)
            if entry_k==0: cross=(kc==0 or kc<0.5)
            else: cross=(kp>entry_k and kc<=entry_k)
            if cross:
                pending={"eb":i+delay}

    eq_fin=eq; eq_cur=INITIAL; yr_rois={}
    for yr in range(2019,2027):
        pl=yp.get(yr,0); roi=pl/eq_cur*100; yr_rois[yr]=roi; eq_cur+=pl
    cagr=(eq_fin/INITIAL)**(1/7)-1
    nt=sum(yn.values())
    late=sum(yr_rois.get(y,0) for y in [2023,2024,2025,2026])/4
    early=sum(yr_rois.get(y,0) for y in [2019,2020,2021])/3
    ys=[yr_rois.get(y,0) for y in range(2019,2027)]
    xs=list(range(8)); mx=4; my=sum(ys)/8
    slope=sum((xs[i]-mx)*(ys[i]-my) for i in range(8))/28
    return cagr*100, yr_rois, nt, slope, early, late

# ── Run focused grid: best variant × all delays × key entry_k ────────────────
print("\nRunning grid (SR(5,10,1), all delay × entry_k)...")
print()

YRS=list(range(2019,2027))
hdr=f"{'Variant':<14} {'ek':>3} {'delay':>5} {'exit':>5} {'CAGR':>6} {'n':>5} {'slope':>6} | " + " | ".join(str(y)[2:] for y in YRS) + " | TREND"
print(hdr)
print("-"*130)

best_results=[]
variant_name="SR(5,10,1)"
k_line=K_LINES[variant_name]

for entry_k in ENTRY_KS:
    for delay in DELAYS:
        for exit_k in [90, 95]:
            cagr,yr,nt,slope,early,late=backtest(k_line,entry_k,delay,exit_k,2.0)
            if nt<50: continue
            rois=[yr.get(y,0) for y in YRS]
            roi_str=" | ".join(f"{r:>+4.0f}%" for r in rois)
            trend="RISE✅" if slope>0.2 and late>0 else ("↗" if slope>0 else ("➡" if slope>-0.2 else "📉"))
            flag=" ◄" if slope>0 and late>early*0.5 else ""
            print(f"{variant_name:<14} {entry_k:>3} {delay:>5} {exit_k:>5} {cagr:>+5.1f}% {nt:>5} {slope:>+5.2f} | {roi_str} | {trend}{flag}")
            best_results.append((slope,cagr,entry_k,delay,exit_k,yr,nt,variant_name))

# ── Also test SR(14,14,3) for comparison ──────────────────────────────────────
print()
print("--- SR(14,14,3) comparison ---")
k2=K_LINES["SR(14,14,3)"]
for entry_k in [5,8,10,15]:
    for delay in [0,2,5]:
        cagr,yr,nt,slope,early,late=backtest(k2,entry_k,delay,90,2.0)
        if nt<50: continue
        rois=[yr.get(y,0) for y in YRS]
        roi_str=" | ".join(f"{r:>+4.0f}%" for r in rois)
        trend="RISE✅" if slope>0.2 and late>0 else ("↗" if slope>0 else "📉")
        print(f"SR(14,14,3)    {entry_k:>3} {delay:>5}    90 {cagr:>+5.1f}% {nt:>5} {slope:>+5.2f} | {roi_str} | {trend}")

# ── Top 10 by slope ───────────────────────────────────────────────────────────
print()
print("="*60)
print("TOP 10 by slope (ít decay nhất / trend tốt nhất):")
print("="*60)
best_results.sort(key=lambda x: x[0], reverse=True)
for slope,cagr,ek,delay,exit_k,yr,nt,vname in best_results[:10]:
    rois=[yr.get(y,0) for y in YRS]
    late=sum(yr.get(y,0) for y in [2023,2024,2025,2026])/4
    print(f"  {vname} ek={ek} delay={delay} exit={exit_k} | slope={slope:+.2f} CAGR={cagr:+.1f}% late={late:+.1f}% n={nt}")
    print(f"    " + "  ".join(f"{y}:{yr.get(y,0):+.1f}%" for y in YRS))
