#!/usr/bin/env python3
"""
upwick-alpha-crossasset.py — backtest rule upWick-band LONG với lăng kính ALPHA:
  - raw return vs ALPHA (= ret_lệnh − B&H cùng holding window)  → beta hay alpha?
  - cross-asset BTC / ETH / SOL                                  → general?
  - so RANDOM-entry baseline (cùng N, cùng exit)                 → có hơn ngẫu nhiên?
Rule: LONG upWick∈(30,43), SL2.7×ATR, trail2.8×ATR, hold10.
"""
import json, datetime as dt, statistics as st, random
random.seed(42)
ASSETS={"BTC":"/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json",
        "ETH":"/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-eth-5m-7y.json",
        "SOL":"/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-sol-5m-3y.json"}
SL,TR,HOLD,FEE=2.7,2.8,10,0.0008
UPLO,UPHI=30,43

def agg(b5):
    out=[];span=24*3600*1000;cur=None
    for b in b5:
        bk=(b["time"]//span)*span
        if cur is None or bk!=cur["time"]:
            if cur:out.append(cur)
            cur=dict(time=bk,open=b["open"],high=b["high"],low=b["low"],close=b["close"])
        else:
            cur["high"]=max(cur["high"],b["high"]);cur["low"]=min(cur["low"],b["low"]);cur["close"]=b["close"]
    if cur:out.append(cur)
    return out
def atr(D,p=14):
    n=len(D);tr=[0.0]*n
    for i in range(1,n):tr[i]=max(D[i]["high"]-D[i]["low"],abs(D[i]["high"]-D[i-1]["close"]),abs(D[i]["low"]-D[i-1]["close"]))
    o=[None]*n;a=sum(tr[1:p+1])/p;o[p]=a
    for i in range(p+1,n):a=(a*(p-1)+tr[i])/p;o[i]=a
    return o
def upwick(b):
    rb=b["high"]-b["low"] or 1
    return (b["high"]-max(b["open"],b["close"]))/rb*100

def run(D, signal):
    """signal(i)->bool. Trả trades với ret + alpha (ret − B&H cùng window)."""
    n=len(D);A=atr(D);C=[b["close"] for b in D];trades=[];i=20
    while i<n-1:
        if A[i] is None:i+=1;continue
        if signal(i):
            entry=C[i];stop=entry-SL*A[i];peak=entry;expx=None;k_ex=None
            for k in range(i+1,min(i+1+HOLD,n)):
                if D[k]["low"]<=stop:expx=stop;k_ex=k;break
                peak=max(peak,C[k])
                if C[k]<=peak-TR*A[i]:expx=C[k];k_ex=k;break
            else:
                k_ex=min(i+HOLD,n-1);expx=C[k_ex]
            ret=(expx/entry-1)-FEE
            bh=C[k_ex]/entry-1            # beta cùng window (buy-hold)
            trades.append({"t":D[i]["time"],"ret":ret,"alpha":ret-bh})
            i=k_ex+1
        else:i+=1
    return trades

def stats(trades):
    if not trades:return None
    r=[t["ret"] for t in trades];a=[t["alpha"] for t in trades]
    yr=defaultdict(list)
    for t in trades:yr[dt.datetime.utcfromtimestamp(t["t"]/1000).year].append(t["alpha"])
    posY=sum(1 for y in yr if sum(yr[y])>0)
    return dict(n=len(trades),wr=round(sum(1 for x in r if x>0)/len(r)*100),
                sumRet=round(sum(r)*100),sumAlpha=round(sum(a)*100),
                medAlpha=round(st.median(a)*100,2),alphaStab=f"{posY}/{len(yr)}")
from collections import defaultdict

print(f"Rule: LONG upWick∈({UPLO},{UPHI}) SL{SL} trail{TR} hold{HOLD}\n")
print(f"{'Asset':<5} {'n':>4} {'WR':>4} {'sumRet':>8} {'sumALPHA':>9} {'medAlpha':>9} {'alphaStab':>9}  | random sumRet (30 seed)")
for name,path in ASSETS.items():
    try:D=agg(json.load(open(path)))
    except Exception as e:print(f"{name}: load fail {e}");continue
    ups=[upwick(b) for b in D]
    s=stats(run(D, lambda i: UPLO<ups[i]<UPHI))
    # random-entry baseline: same number of entries, random days
    rnds=[]
    for seed in range(30):
        rng=random.Random(seed)
        picks=set(rng.sample(range(20,len(D)-1), min(s["n"],len(D)-25)))
        rs=stats(run(D, lambda i: i in picks))
        rnds.append(rs["sumRet"] if rs else 0)
    rmean=round(st.mean(rnds));rmax=round(max(rnds))
    pct=round(sum(1 for x in rnds if x< s["sumRet"])/len(rnds)*100)
    print(f"{name:<5} {s['n']:>4} {s['wr']:>3}% {s['sumRet']:>7}% {s['sumAlpha']:>8}% {s['medAlpha']:>8}% {s['alphaStab']:>9}  | mean {rmean}% max {rmax}% → rule ở pct{pct}")
print("\nĐọc: sumALPHA<0 hoặc medAlpha<0 = BETA (thua chính buy-hold cùng kỳ). pct<95 = không hơn random.")
