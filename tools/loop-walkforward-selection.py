#!/usr/bin/env python3
"""Loop cycle 10: walk-forward ASSET-SELECTION audit (chống look-ahead chọn {BTC,SOL}).
hedge01 structural mọi asset trên common window. Split half. Rank theo NỬA-1 → test NỬA-2.
Q: ranking asset bằng quá khứ có dự đoán tương lai không? (Spearman h1↔h2). Top-2-by-h1 book trên h2 vs all-7 vs bottom-2.
Nếu top-2-h1 nổi lên là BTC/SOL và thắng h2 → selection robust, KHÔNG cherry-pick toàn-data.
"""
import importlib.util, datetime, math, os, sys
def imp(name, path):
    spec = importlib.util.spec_from_file_location(name, path); M = importlib.util.module_from_spec(spec)
    so = sys.stdout; sys.stdout = open(os.devnull, "w"); spec.loader.exec_module(M); sys.stdout = so; return M
T = "/Users/lap16116/BTC_PC/btc-dashboard/tools/"
Hh = imp("Hh", T+"loop-hedge01-crossasset.py"); run = Hh.run_hedge01; CC = Hh.CC
ASSETS = [("BTC",f"{CC}/binance-5m-7y.json"),("ETH",f"{CC}/binance-eth-5m-3y.json"),("SOL",f"{CC}/binance-sol-5m-3y.json"),
          ("BNB",f"{CC}/binance-bnb-5m-3y.json"),("XRP",f"{CC}/binance-xrp-5m-3y.json"),("DOGE",f"{CC}/binance-doge-5m-3y.json"),("AVAX",f"{CC}/binance-avax-5m-3y.json")]
def months_between(t0,t1):
    d0=datetime.datetime.utcfromtimestamp(t0/1000); d1=datetime.datetime.utcfromtimestamp(t1/1000)
    out=[]; y,m=d0.year,d0.month
    while (y,m)<=(d1.year,d1.month):
        out.append(f"{y}-{m:02d}"); m+=1
        if m>12: m=1;y+=1
    return out
def sharpe(v):
    if len(v)<2: return 0.0
    me=sum(v)/len(v); d=(sum((x-me)**2 for x in v)/len(v))**.5 or 1e-9; return me/d*math.sqrt(12)
def maxdd(v):
    cum=peak=mdd=0.0
    for x in v: cum+=x;peak=max(peak,cum);mdd=max(mdd,peak-cum)
    return mdd*100

mo={}; spans=[]
for n,p in ASSETS:
    m,_,_,sp = run(p, skip_cal=False); mo[n]=m; spans.append(sp)
# common window = max start .. min end
cs=max(s[0] for s in spans); ce=min(s[1] for s in spans)
cal=months_between(cs,ce); h=len(cal)//2; h1m,h2m=cal[:h],cal[h:]
print(f"=== Cycle 10: walk-forward asset-selection (common {len(cal)}mo {cal[0]}→{cal[-1]}) ===")
print(f"  half-1 {h1m[0]}→{h1m[-1]} ({len(h1m)}mo) | half-2 {h2m[0]}→{h2m[-1]} ({len(h2m)}mo)")
print(f"\n  {'asset':>5} | {'h1 ret%':>7} {'h1 Sh':>6} | {'h2 ret%':>7} {'h2 Sh':>6}")
rows={}
for n,_ in ASSETS:
    s1=[mo[n].get(x,0.0) for x in h1m]; s2=[mo[n].get(x,0.0) for x in h2m]
    rows[n]=(sum(s1)*100,sharpe(s1),sum(s2)*100,sharpe(s2),s1,s2)
    print(f"  {n:>5} | {rows[n][0]:>+7.0f} {rows[n][1]:>+6.2f} | {rows[n][2]:>+7.0f} {rows[n][3]:>+6.2f}")

# Spearman rank corr h1-return vs h2-return
def rank(d):
    order=sorted(d, key=lambda k:d[k]); return {k:i for i,k in enumerate(order)}
r1=rank({n:rows[n][0] for n in mo}); r2=rank({n:rows[n][2] for n in mo})
names=list(mo); a=[r1[n] for n in names]; b=[r2[n] for n in names]
ma=sum(a)/len(a); mb=sum(b)/len(b)
sp=sum((a[i]-ma)*(b[i]-mb) for i in range(len(a)))/(((sum((x-ma)**2 for x in a))**.5)*((sum((x-mb)**2 for x in b))**.5) or 1e-9)
print(f"\n  Spearman rank-corr (h1-return rank vs h2-return rank) = {sp:+.2f}  [{'past PREDICTS future' if sp>0.3 else 'WEAK/none — selection ko reliable' if sp<0.3 else 'mod'}]")

# books on half-2
def book(names_sel, half):
    ser=[[mo[n].get(x,0.0) for x in half] for n in names_sel]
    p=[sum(s[i] for s in ser)/len(ser) for i in range(len(half))]
    return sum(p)*100, sharpe(p), maxdd(p)
top2=sorted(mo, key=lambda n:rows[n][0], reverse=True)[:2]
bot2=sorted(mo, key=lambda n:rows[n][0])[:2]
print(f"\n  Selected by HALF-1 return → top2={top2}  bottom2={bot2}")
for label,sel in [("top2-by-h1",top2),("bottom2-by-h1",bot2),("all-7",list(mo)),("BTC+SOL (hypothesis)",["BTC","SOL"])]:
    r=book(sel,h2m); print(f"    {label:<22} on HALF-2: ret%{r[0]:>+6.0f} Sh{r[1]:>+5.2f} DD{r[2]:>5.1f}%")
print("\n  → Nếu top2-by-h1 ≈ {BTC,SOL} và thắng bottom2 trên h2 → selection robust, ko look-ahead.")
