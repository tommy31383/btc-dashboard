#!/usr/bin/env python3
"""
capitulation-bottom-7y.py — Rule từ chữ ký data-driven (góc B).
ENTRY (daily close): down day + chuỗi giảm ≥CONS + nến hammer (lowWick≥WICK%)
                     + sâu ≤DEPTH% dưới đỉnh 20d.
EXIT: stop = entry - SL×ATR | trail = peakClose - TR×ATR | time MAXHOLD ngày.
Report % return (asset-agnostic) + per-year + robustness sweep.
"""
import json, datetime as dt, statistics as st, sys
CACHE=sys.argv[1] if len(sys.argv)>1 else "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
# params
CONS=3; WICK=35; DEPTH=-8; SL=2.0; TR=2.5; MAXHOLD=20
FEE=0.0008  # round-trip taker

def agg(b5,h=24):
    out=[];span=h*3600*1000;cur=None
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

def backtest(D, cons=CONS,wick=WICK,depth=DEPTH,sl=SL,tr=TR,maxhold=MAXHOLD):
    n=len(D);A=atr(D);trades=[];i=20
    while i<n-1:
        if A[i] is None:i+=1;continue
        o,c,h,l=D[i]["open"],D[i]["close"],D[i]["high"],D[i]["low"]
        # features at close of bar i
        streak=0;j=i
        while j>0 and D[j]["close"]<D[j-1]["close"]:streak+=1;j-=1
        rngbar=h-l or 1; loww=(min(o,c)-l)/rngbar*100
        hh20=max(D[k]["high"] for k in range(i-20,i+1))
        dep=(c/hh20-1)*100
        if c<o and streak>=cons and loww>=wick and dep<=depth:
            entry=c; stop=entry - sl*A[i]; peak=c; ex=None;expx=None
            for k in range(i+1, min(i+1+maxhold, n)):
                # stop check on low
                if D[k]["low"]<=stop:
                    expx=stop; ex="STOP"; k_ex=k; break
                # update trail on close
                if D[k]["close"]>peak:peak=D[k]["close"]
                trail=peak - tr*A[i]
                if D[k]["close"]<=trail and D[k]["close"]>entry*0.5:
                    expx=D[k]["close"]; ex="TRAIL"; k_ex=k; break
            else:
                k_ex=min(i+maxhold,n-1); expx=D[k_ex]["close"]; ex="TIME"
            ret=(expx/entry-1)-FEE
            trades.append(dict(t=D[i]["time"],ret=ret,reason=ex,entry=entry,exit=expx))
            i=k_ex+1  # no overlap (1 pos at a time)
        else:
            i+=1
    return trades

def report(name,trades):
    if not trades:print(f"### {name}: 0 trades");return None
    yr={}
    for tr_ in trades:
        y=dt.datetime.utcfromtimestamp(tr_["t"]/1000).year;yr.setdefault(y,[]).append(tr_["ret"])
    n=len(trades);rets=[t["ret"] for t in trades]
    eq=1.0
    for r in rets:eq*=(1+r)
    w=sum(1 for r in rets if r>0)
    aw=st.mean([r for r in rets if r>0]) if w else 0
    al=st.mean([r for r in rets if r<=0]) if (n-w) else 0
    exp=st.mean(rets)
    posY=sum(1 for y in yr if sum(yr[y])>0)
    print(f"\n### {name}: n={n} WR={w/n*100:.0f}% | compound={(eq-1)*100:+.0f}% | exp/trade={exp*100:+.2f}% | avgW {aw*100:+.1f}% avgL {al*100:+.1f}% | stab {posY}/{len(yr)}")
    print("   "+" ".join(f"{y}:{sum(yr[y])*100:+.0f}%(n{len(yr[y])})" for y in sorted(yr)))
    return dict(n=n,wr=round(w/n*100,1),compound=round((eq-1)*100,1),exp=round(exp*100,3),stab=f"{posY}/{len(yr)}")

print("Loading BTC..."); D=agg(json.load(open(CACHE)))
print(f"  {len(D)} daily bars\n=== CAPITULATION-BOTTOM 7y BTC (cons≥{CONS}, wick≥{WICK}%, depth≤{DEPTH}%, SL {SL}×ATR, trail {TR}×ATR) ===")
base=report("BASE", backtest(D))
print("\n--- ROBUSTNESS sweep (±1 mỗi param) ---")
for cons in (2,3,4):
    report(f"cons={cons}", backtest(D,cons=cons))
for wick in (25,35,45):
    report(f"wick={wick}", backtest(D,wick=wick))
for sl in (1.5,2.0,2.5):
    report(f"SL={sl}", backtest(D,sl=sl))
for tr in (2.0,2.5,3.0):
    report(f"trail={tr}", backtest(D,tr=tr))
json.dump({"base":base},open("/tmp/capit_bottom.json","w"),indent=1)
print("\n→ /tmp/capit_bottom.json")
