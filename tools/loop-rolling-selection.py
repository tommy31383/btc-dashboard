#!/usr/bin/env python3
"""Loop cycle 15: rolling-window selection STABILITY (hardening procedure trong deliverable).
Rolling 12-mo window step 3mo. Mỗi window rank 7 asset theo hedge01 window-return → top-2.
Stable = {BTC,SOL} (hoặc gần) xuất hiện top-2 đa số window. Noisy = nhảy lung tung → procedure không tin được.
"""
import importlib.util, datetime, math, os, sys
from collections import Counter
def imp(name, path):
    spec=importlib.util.spec_from_file_location(name,path); M=importlib.util.module_from_spec(spec)
    so=sys.stdout; sys.stdout=open(os.devnull,"w"); spec.loader.exec_module(M); sys.stdout=so; return M
Hh=imp("Hh","/Users/lap16116/BTC_PC/btc-dashboard/tools/loop-hedge01-crossasset.py"); run=Hh.run_hedge01; CC=Hh.CC
ASSETS=[("BTC",f"{CC}/binance-5m-7y.json"),("ETH",f"{CC}/binance-eth-5m-3y.json"),("SOL",f"{CC}/binance-sol-5m-3y.json"),
        ("BNB",f"{CC}/binance-bnb-5m-3y.json"),("XRP",f"{CC}/binance-xrp-5m-3y.json"),("DOGE",f"{CC}/binance-doge-5m-3y.json"),("AVAX",f"{CC}/binance-avax-5m-3y.json")]
def mb(t0,t1):
    d0=datetime.datetime.utcfromtimestamp(t0/1000); d1=datetime.datetime.utcfromtimestamp(t1/1000)
    out=[];y,m=d0.year,d0.month
    while (y,m)<=(d1.year,d1.month):
        out.append(f"{y}-{m:02d}");m+=1
        if m>12:m=1;y+=1
    return out
def sh(v):
    if len(v)<2: return 0.0
    me=sum(v)/len(v);d=(sum((x-me)**2 for x in v)/len(v))**.5 or 1e-9;return me/d*math.sqrt(12)
mo={}
for n,p in ASSETS: mo[n],_,_,_=run(p,skip_cal=False)
cal=mb(1688169600000,1748736000000)  # 2023-07→2026-05
WIN=12; STEP=3
print("=== Cycle 15: rolling-window (12mo, step 3mo) asset-selection stability ===")
print(f"  {'window':>18} | ranked by hedge01 window-return (top→bottom) | top-2")
top2_counter=Counter(); n_win=0
for s in range(0, len(cal)-WIN+1, STEP):
    w=cal[s:s+WIN]; n_win+=1
    rets={n: sum(mo[n].get(mm,0.0) for mm in w)*100 for n,_ in ASSETS}
    order=sorted(rets, key=lambda k:rets[k], reverse=True)
    t2=order[:2]; top2_counter.update(t2)
    rk=" ".join(f"{n}{rets[n]:+.0f}" for n in order)
    print(f"  {w[0]}→{w[-1]} | {rk} | {t2}")
print(f"\n  Top-2 appearance over {n_win} windows: " + ", ".join(f"{k}:{v}/{n_win}" for k,v in top2_counter.most_common()))
btc_sol = top2_counter['BTC']+top2_counter['SOL']
print(f"  {{BTC,SOL}} chiếm {btc_sol}/{2*n_win} suất top-2 ({btc_sol/(2*n_win)*100:.0f}%) → {'STABLE selection' if btc_sol/(2*n_win)>0.5 else 'noisy'}")
print("  (Procedure: re-rank định kỳ; nếu {BTC,SOL} thống trị top-2 → selection đáng tin, ít churn.)")
