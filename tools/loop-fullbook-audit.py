#!/usr/bin/env python3
"""Loop cycle 8: (A) SOL jackpot-check, (B) corr BTC-SOL sub-period stable?, (C) full book assembly.
hedge01-BTC + hedge01-SOL (structural) + turtle-BTC sleeve. Đo Sharpe/DD/per-year, weight sweep.
Câu hỏi: hedge01-SOL có dominate turtle-BTC làm diversifier không (corr −0.00 vs +0.04, edge mạnh hơn)?
"""
import importlib.util, datetime, math, os, sys
from collections import defaultdict
def imp(name, path, suppress=True):
    spec = importlib.util.spec_from_file_location(name, path); M = importlib.util.module_from_spec(spec)
    if suppress:
        so = sys.stdout; sys.stdout = open(os.devnull, "w"); spec.loader.exec_module(M); sys.stdout = so
    else: spec.loader.exec_module(M)
    return M
T = "/Users/lap16116/BTC_PC/btc-dashboard/tools/"
Hh = imp("Hh", T+"loop-hedge01-crossasset.py")           # run_hedge01
C = imp("C", T+"correlation-turtle-hedge01-7y.py")        # tur_mo = turtle-BTC monthly (7y)
run = Hh.run_hedge01; CC = Hh.CC

def mo_of(ts): return datetime.datetime.utcfromtimestamp(ts/1000).strftime("%Y-%m")
def yr_of(m): return int(m[:4])
def sharpe(v):
    if len(v)<2: return 0.0
    me=sum(v)/len(v); d=(sum((x-me)**2 for x in v)/len(v))**.5 or 1e-9; return me/d*math.sqrt(12)
def maxdd(v):
    cum=peak=mdd=0.0
    for x in v: cum+=x; peak=max(peak,cum); mdd=max(mdd,peak-cum)
    return mdd*100
def corr(a,b):
    N=len(a); ma=sum(a)/N; mb=sum(b)/N
    cov=sum((a[i]-ma)*(b[i]-mb) for i in range(N))/N
    sa=(sum((x-ma)**2 for x in a)/N)**.5; sb=(sum((x-mb)**2 for x in b)/N)**.5
    return cov/(sa*sb) if sa>0 and sb>0 else 0

# hedge01 structural
moB,_,trB,_ = run(f"{CC}/binance-5m-7y.json", skip_cal=False)
moS,_,trS,_ = run(f"{CC}/binance-sol-5m-3y.json", skip_cal=False)
turB = dict(C.tur_mo)  # turtle-BTC monthly

# ---- (A) SOL jackpot-check ----
print("=== Cycle 8 ===\n--- (A) SOL hedge01 jackpot-check (trade-level) ---")
rets = sorted([t[0]*100 for t in trS], reverse=True)
tot = sum(rets)
print(f"  {len(trS)} trades, total ret% {tot:+.0f}, WR {sum(1 for r in rets if r>0)/len(rets)*100:.0f}%")
print(f"  top5: {[f'{r:+.0f}' for r in rets[:5]]}  bottom5: {[f'{r:+.0f}' for r in rets[-5:]]}")
print(f"  ex-best1 {tot-rets[0]:+.0f}  ex-top3 {tot-sum(rets[:3]):+.0f}  (best1 = {rets[0]/tot*100:.0f}% of total)")
tr2025 = [t[0]*100 for t in trS if mo_of(t[1]).startswith("2025")]
print(f"  2025 trades: {len(tr2025)}, sum {sum(tr2025):+.0f}, vals {[f'{r:+.0f}' for r in sorted(tr2025,reverse=True)]}")

# ---- (B) corr BTC-SOL sub-period ----
common = sorted(set(m for m in moB) & set(m for m in moS) | (set(moS)))  # align on SOL window
common = sorted(set(moS.keys()) | {m for m in moB if m >= min(moS.keys())})
common = sorted({m for m in (set(moB)|set(moS)) if m >= min(moS.keys()) and m <= max(max(moB),max(moS))})
sB=[moB.get(m,0.0) for m in common]; sS=[moS.get(m,0.0) for m in common]; sT=[turB.get(m,0.0) for m in common]
print(f"\n--- (B) corr BTC-SOL sub-period (common {len(common)}mo {common[0]}→{common[-1]}) ---")
h=len(common)//2
print(f"  full {corr(sB,sS):+.2f} | 1st-half {corr(sB[:h],sS[:h]):+.2f} | 2nd-half {corr(sB[h:],sS[h:]):+.2f}")

# ---- (C) full book ----
print(f"\n--- (C) FULL BOOK assembly (common window, equal-weight raw monthly) ---")
print(f"  corr: BTC-SOL {corr(sB,sS):+.2f}  BTC-turtleBTC {corr(sB,sT):+.2f}  SOL-turtleBTC {corr(sS,sT):+.2f}")
def book(label, series):
    k=len(series); p=[sum(s[i] for s in series)/k for i in range(len(common))]
    yr=defaultdict(float)
    for i,m in enumerate(common): yr[yr_of(m)]+=p[i]
    py=" ".join(f"{y%100}:{yr[y]*100:+.0f}" for y in sorted(yr))
    print(f"  {label:<28} ret%{sum(p)*100:>+6.0f} Sh{sharpe(p):>+5.2f} DD{maxdd(p):>5.1f}% ROI/DD{sum(p)*100/max(maxdd(p),1):>5.2f} | {py}")
book("h01-BTC alone", [sB])
book("h01-BTC+SOL", [sB,sS])
book("h01-BTC+SOL +turtleBTC", [sB,sS,sT])
book("h01-BTC +turtleBTC (no SOL)", [sB,sT])
# weight sweep 3-way (does turtle add on top of BTC+SOL?)
print("  weight sweep h01BTC:h01SOL:turtleBTC (Sharpe):")
for wt in [(1,1,0),(1,1,0.5),(1,1,1),(2,2,1),(1,1,0.25)]:
    p=[(wt[0]*sB[i]+wt[1]*sS[i]+wt[2]*sT[i])/sum(wt) for i in range(len(common))]
    print(f"    {wt} → Sh{sharpe(p):+.2f} DD{maxdd(p):.0f}% ret{sum(p)*100:+.0f}")
