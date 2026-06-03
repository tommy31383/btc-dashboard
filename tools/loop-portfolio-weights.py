#!/usr/bin/env python3
"""Loop cycle 3: portfolio weighting sweep hedge01+turtle (vol-normalized risk budget).
w = fraction risk budget cho hedge01; (1-w) cho turtle. port[i] = w*(x/sx) + (1-w)*(y/sy).
Tìm w tối ưu Sharpe dưới FULL và ex-2021 (jackpot-robust). Nếu argmax = w=1.0 → turtle vô ích robust.
"""
import importlib.util, os, sys, math
P = "/Users/lap16116/BTC_PC/btc-dashboard/tools/correlation-turtle-hedge01-7y.py"
spec = importlib.util.spec_from_file_location("corr", P)
C = importlib.util.module_from_spec(spec)
_so = sys.stdout; sys.stdout = open(os.devnull, "w"); spec.loader.exec_module(C); sys.stdout = _so

allmo = C.allmo
def series(months):
    return [C.h01_mo.get(m, 0.0) for m in months], [C.tur_mo.get(m, 0.0) for m in months]
def stat(vals):
    n=len(vals); m=sum(vals)/n; d=(sum((v-m)**2 for v in vals)/n)**0.5 or 1e-9
    return m, d
def sharpe(vals): m,d=stat(vals); return m/d*math.sqrt(12)
def maxdd(vals):
    cum=peak=mdd=0.0
    for v in vals:
        cum+=v; peak=max(peak,cum); mdd=max(mdd,peak-cum)
    return mdd

def sweep(name, months):
    xs,ys = series(months)
    _,sx = stat(xs); _,sy = stat(ys)
    xn=[v/sx for v in xs]; yn=[v/sy for v in ys]
    print(f"\n  {name} (n={len(months)} months)")
    print(f"    {'w_h01':>6} {'Sharpe':>7} {'maxDD(norm)':>12}   ret%(raw blend by w)")
    best=(-9,None)
    for w in [1.0,0.85,0.75,0.6,0.5,0.25,0.0]:
        port=[w*xn[i]+(1-w)*yn[i] for i in range(len(months))]
        sh=sharpe(port); dd=maxdd(port)
        raw=[w*xs[i]+(1-w)*ys[i] for i in range(len(months))]
        ret=sum(raw)*100
        if sh>best[0]: best=(sh,w)
        print(f"    {w:>6.2f} {sh:>+7.2f} {dd:>12.2f}   {ret:>+7.0f}")
    print(f"    → argmax Sharpe = w_h01 {best[1]:.2f} (Sharpe {best[0]:+.2f})  {'⇒ turtle vô ích robust' if best[1]==1.0 else '⇒ turtle sleeve giúp'}")
    return best

print("=== Cycle 3: portfolio weighting sweep (risk budget w_h01) ===")
sweep("FULL", allmo)
sweep("ex-2021 (jackpot year)", [m for m in allmo if not m.startswith("2021")])
sweep("ex-2021-03 only", [m for m in allmo if m!="2021-03"])
