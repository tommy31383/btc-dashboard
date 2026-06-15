#!/usr/bin/env python3
"""
stochbreak-variants-7y.py — test 2 variant dựa phân tích đỉnh/đáy 2026:
  BASE : LONG-only (K1h<20 + mom4h_bull) hold72/cool12          [= live v0.4.96]
  V1   : BASE + EMA200d-gate (chỉ LONG khi price > EMA200d)      [skip-BEAR cho LONG]
  V2   : SHORT-on-overbought (daily StochK>90 + price<EMA200d)   [bắt đỉnh downtrend]
Sizing 0.001 BTC, NET fee 0.04%/side. Per-year so sánh.
"""
import json, datetime as dt, bisect
from collections import defaultdict
CACHE="/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
QTY=0.001; TAKER=0.0004; H=3600*1000
L_THR,L_HOLD,L_COOL=20,72,12
S_DK_THR,S_HOLD,S_COOL=90,48,24   # V2: daily StochK>90, hold 48h, cool 24h

def agg(b5,h):
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
def rsi_s(c,p=14):
    n=len(c);o=[None]*n
    if n<p+1:return o
    g=l=0.0
    for i in range(1,p+1):ch=c[i]-c[i-1];g+=max(ch,0);l+=max(-ch,0)
    ag=g/p;al=l/p;o[p]=100-100/(1+ag/al) if al else 100.0
    for i in range(p+1,n):
        ch=c[i]-c[i-1];ag=(ag*(p-1)+max(ch,0))/p;al=(al*(p-1)+max(-ch,0))/p
        o[i]=100-100/(1+ag/al) if al else 100.0
    return o
def stk(c,rp=14,sp=14,ks=3):
    r=rsi_s(c,rp);n=len(c);rk=[None]*n
    for i in range(n):
        if r[i] is None:continue
        w=[r[j] for j in range(max(0,i-sp+1),i+1) if r[j] is not None]
        if len(w)<sp:continue
        lo=min(w);hi=max(w);rk[i]=100.0 if hi==lo else (r[i]-lo)/(hi-lo)*100
    k=[None]*n
    for i in range(n):
        w=[rk[j] for j in range(max(0,i-ks+1),i+1) if rk[j] is not None]
        if len(w)==ks:k[i]=sum(w)/ks
    return k
def ema(c,p):
    o=[None]*len(c);k=2/(p+1);e=c[0]
    for i in range(len(c)):e=c[i]*k+e*(1-k);o[i]=e
    return o

print("Loading + aggregating...")
b5=json.load(open(CACHE))
b1=agg(b5,1);b4=agg(b5,4);bD=agg(b5,24)
c1=[b["close"] for b in b1];t1=[b["time"] for b in b1]
c4=[b["close"] for b in b4];t4=[b["time"] for b in b4]
cD=[b["close"] for b in bD];tD=[b["time"] for b in bD]
K1=stk(c1)
KD=stk(cD); E2D=ema(cD,200)
def j4(i):
    T=t1[i];j=bisect.bisect_right(t4,T)-1
    if j>=0 and T<t4[j]+3*H:j-=1
    return j
def jD(i):  # latest CLOSED daily bar at 1h bar i
    T=t1[i];j=bisect.bisect_right(tD,T)-1
    if j>=0 and T<tD[j]+24*H-H+1:  # daily bar closes at tD[j]+24h; closed only at last hour
        if T<tD[j]+23*H:j-=1
    return j

def run(mode):
    pos=[];trades=[];lastL=lastS=-10**18
    for i in range(len(b1)):
        pos=[p for p in pos if p["ex"]>i]
        j=j4(i); jd=jD(i)
        if j<5 or jd<1 or E2D[jd] is None:continue
        mom_bull=c4[j]>c4[j-5]; mom_bear=c4[j]<c4[j-5]
        above200=c1[i]>E2D[jd]
        # LONG (BASE + optional EMA gate)
        if mode in("BASE","V1") and len(pos)<4 and K1[i] is not None and K1[i]<L_THR and mom_bull and (t1[i]-lastL)>=L_COOL*H:
            gate = above200 if mode=="V1" else True
            if gate:
                ex=min(i+L_HOLD,len(b1)-1);fee=(c1[i]+c1[ex])*QTY*TAKER
                trades.append({"t":t1[i],"side":"LONG","pnl":QTY*(c1[ex]-c1[i])-fee})
                pos.append({"ex":ex});lastL=t1[i]
        # V2 SHORT overbought under EMA200d
        if mode=="V2" and len(pos)<4 and KD[jd] is not None and KD[jd]>S_DK_THR and (not above200) and (t1[i]-lastS)>=S_COOL*H:
            ex=min(i+S_HOLD,len(b1)-1);fee=(c1[i]+c1[ex])*QTY*TAKER
            trades.append({"t":t1[i],"side":"SHORT","pnl":QTY*(c1[i]-c1[ex])-fee})
            pos.append({"ex":ex});lastS=t1[i]
    return trades

def report(name,trades):
    yr=defaultdict(lambda:{"n":0,"w":0,"p":0.0})
    for tr in trades:
        y=dt.datetime.utcfromtimestamp(tr["t"]/1000).year;d=yr[y]
        d["n"]+=1;d["p"]+=tr["pnl"];d["w"]+=1 if tr["pnl"]>0 else 0
    n=len(trades);p=sum(t["pnl"] for t in trades);w=sum(1 for t in trades if t["pnl"]>0)
    posY=sum(1 for y in yr if yr[y]["p"]>0)
    print(f"\n### {name}: n={n} WR={w/max(1,n)*100:.0f}% PnL=${p:.2f} stab={posY}/{len(yr)}")
    print("   "+" ".join(f"{y}:${yr[y]['p']:+.0f}(n{yr[y]['n']})" for y in sorted(yr)))
    return {"name":name,"n":n,"pnl":round(p,2),"wr":round(w/max(1,n)*100,1),"stab":f"{posY}/{len(yr)}",
            "byYear":{y:round(yr[y]['p'],2) for y in yr}}

print("="*70)
res=[report("BASE (LONG-only, live)",run("BASE")),
     report("V1 (LONG + EMA200d gate)",run("V1")),
     report("V2 (SHORT overbought<EMA200d)",run("V2"))]
json.dump(res,open("/tmp/sb_variants.json","w"),indent=1)
print("\n→ /tmp/sb_variants.json")
