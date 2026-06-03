#!/usr/bin/env python3
"""Loop cycle 17: hedge01 generality + selection trên UNIVERSE 11 COIN (thêm LINK/ADA/DOT/LTC).
(A) per-coin hedge01 structural: ret%/Sharpe/per-year → coin nào hedge01-fit.
(B) walk-forward h1→h2 selection trên 11 coin: {BTC,SOL} còn nổi không? coin mới phân loại winner/loser?
Củng cố claim: method generality + selection procedure robust trên universe rộng hơn.
"""
import importlib.util, datetime, math, os, sys
from collections import Counter
def imp(name, path):
    spec=importlib.util.spec_from_file_location(name,path); M=importlib.util.module_from_spec(spec)
    so=sys.stdout; sys.stdout=open(os.devnull,"w"); spec.loader.exec_module(M); sys.stdout=so; return M
Hh=imp("Hh","/Users/lap16116/BTC_PC/btc-dashboard/tools/loop-hedge01-crossasset.py"); run=Hh.run_hedge01; CC=Hh.CC
U=[("BTC","binance-5m-7y"),("ETH","binance-eth-5m-3y"),("SOL","binance-sol-5m-3y"),("BNB","binance-bnb-5m-3y"),
   ("XRP","binance-xrp-5m-3y"),("DOGE","binance-doge-5m-3y"),("AVAX","binance-avax-5m-3y"),
   ("LINK","binance-link-5m-3y"),("ADA","binance-ada-5m-3y"),("DOT","binance-dot-5m-3y"),("LTC","binance-ltc-5m-3y")]
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

print("=== Cycle 17: hedge01 on UNIVERSE 11 coin ===")
data={}
print(f"\n--- (A) per-coin hedge01 structural ---")
print(f"  {'coin':>5} | {'ret%':>6} {'Sh':>5} {'n':>4} | per-year")
for name,f in U:
    mo,yrr,tr,_=run(f"{CC}/{f}.json", skip_cal=False); data[name]=mo
    tot=sum(t[0] for t in tr)*100
    py=" ".join(f"{y%100}:{yrr[y]*100:+.0f}" for y in sorted(yrr))
    tag="✅" if tot>50 and sh(list(mo.values()))>0.5 else ("~" if tot>0 else "✗")
    print(f"  {name:>5} | {tot:>+6.0f} {sh(list(mo.values())):>+5.1f} {len(tr):>4} | {py}  {tag}")

# (B) walk-forward on 11 coin
cal=mb(1688169600000,1748736000000); h=len(cal)//2; h1,h2=cal[:h],cal[h:]
print(f"\n--- (B) walk-forward 11-coin (h1 {h1[0]}→{h1[-1]} | h2 {h2[0]}→{h2[-1]}) ---")
r1={n:sum(data[n].get(m,0)for m in h1)*100 for n,_ in U}
r2={n:sum(data[n].get(m,0)for m in h2)*100 for n,_ in U}
o1=sorted(r1,key=lambda k:r1[k],reverse=True)
print("  rank by h1: "+" ".join(f"{n}{r1[n]:+.0f}" for n in o1))
print("  same coins h2: "+" ".join(f"{n}{r2[n]:+.0f}" for n in o1))
# spearman
def rk(d):
    o=sorted(d,key=lambda k:d[k]); return {k:i for i,k in enumerate(o)}
a=[rk(r1)[n] for n,_ in U]; b=[rk(r2)[n] for n,_ in U]; ma=sum(a)/len(a); mb_=sum(b)/len(b)
spr=sum((a[i]-ma)*(b[i]-mb_) for i in range(len(a)))/(((sum((x-ma)**2 for x in a))**.5)*((sum((x-mb_)**2 for x in b))**.5) or 1e-9)
print(f"  Spearman h1→h2 = {spr:+.2f}")
def book(sel,half):
    p=[sum(data[n].get(half[i],0) for n in sel)/len(sel) for i in range(len(half))]; return sum(p)*100,sh(p)
for k in (2,3):
    top=o1[:k]; bot=o1[-k:]
    bt=book(top,h2); bb=book(bot,h2)
    print(f"  top{k}-by-h1={top} → h2 ret{bt[0]:+.0f}/Sh{bt[1]:+.2f} | bottom{k}={bot} → h2 ret{bb[0]:+.0f}/Sh{bb[1]:+.2f}")
print("\n  → method generality holds nếu winner/loser tách sạch + selection vẫn top {BTC,SOL}-ish + top>>bottom OOS.")
