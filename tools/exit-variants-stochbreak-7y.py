#!/usr/bin/env python3
"""
exit-variants-stochbreak-7y.py — Test EXIT variants cho stochbreak LONG (faithful, entry y nguyên).
Baseline LIVE = pure time-exit hold 72h (KHÔNG TP/SL/trail). Test thêm:
  - ATR-SL fixed (cắt loser sớm)  [CẤM no-SL: baseline vốn không có SL, đây là THÊM SL]
  - ATR-trailing (chandelier)
  - fixed TP ATR
Judge dollars, per-year, MaxDD, Calmar, n. Walk-forward 19-22 / 23-26.
"""
import json, datetime as dt, bisect
from collections import defaultdict
CACHE="/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
QTY=0.001; L_THR,L_HOLD,L_COOL=20,72,12; MAX_CONC=4; TAKER=0.0004; H=3600*1000

def agg(b5,hrs):
    out=[];span=hrs*3600*1000;cur=None
    for b in b5:
        bk=(b["time"]//span)*span
        if cur is None or bk!=cur["time"]:
            if cur:out.append(cur)
            cur={"time":bk,"open":b["open"],"high":b["high"],"low":b["low"],"close":b["close"]}
        else:cur["high"]=max(cur["high"],b["high"]);cur["low"]=min(cur["low"],b["low"]);cur["close"]=b["close"]
    if cur:out.append(cur)
    return out
def rsi_s(c,p=14):
    n=len(c);o=[None]*n
    if n<p+1:return o
    g=l=0.0
    for i in range(1,p+1):ch=c[i]-c[i-1];g+=max(ch,0);l+=max(-ch,0)
    ag=g/p;al=l/p;o[p]=100.0 if al==0 else 100-100/(1+ag/al)
    for i in range(p+1,n):
        ch=c[i]-c[i-1];ag=(ag*(p-1)+max(ch,0))/p;al=(al*(p-1)+max(-ch,0))/p
        o[i]=100.0 if al==0 else 100-100/(1+ag/al)
    return o
def stochk(c,rp=14,sp=14,ks=3):
    rsi=rsi_s(c,rp);n=len(c);rawk=[None]*n
    for i in range(n):
        if rsi[i] is None:continue
        w=[rsi[j] for j in range(max(0,i-sp+1),i+1) if rsi[j] is not None]
        if len(w)<sp:continue
        lo=min(w);hi=max(w);rawk[i]=100.0 if hi==lo else (rsi[i]-lo)/(hi-lo)*100
    k=[None]*n
    for i in range(n):
        w=[rawk[j] for j in range(max(0,i-ks+1),i+1) if rawk[j] is not None]
        if len(w)==ks:k[i]=sum(w)/ks
    return k
def atr_s(b,p=14):
    n=len(b);o=[None]*n
    if n<p+1:return o
    trs=[b[i]["high"]-b[i]["low"] if i==0 else max(b[i]["high"]-b[i]["low"],abs(b[i]["high"]-b[i-1]["close"]),abs(b[i]["low"]-b[i-1]["close"])) for i in range(n)]
    a=sum(trs[1:p+1])/p;o[p]=a
    for i in range(p+1,n):a=(a*(p-1)+trs[i])/p;o[i]=a
    return o

print("load...");b5=json.load(open(CACHE))
b1=agg(b5,1);b4=agg(b5,4)
c1=[b["close"] for b in b1];h1=[b["high"] for b in b1];l1=[b["low"] for b in b1];t1=[b["time"] for b in b1]
c4=[b["close"] for b in b4];t4=[b["time"] for b in b4]
K=stochk(c1);A1=atr_s(b1)
def j4(i):
    T=t1[i];j=bisect.bisect_right(t4,T)-1
    if j>=0 and T<t4[j]+4*H-H+1:
        if T<t4[j]+3*H:j-=1
    return j

def run(exit):
    """exit: dict mode in {time, atrsl, trail, tp}; params slAtr/tpAtr/trailAtr"""
    pos=[];trades=[];lastL=-10**18
    for i in range(len(b1)):
        np=[]
        for p in pos:
            if h1[i]>p["hw"]:p["hw"]=h1[i]
            xpx=None
            if exit["mode"]=="trail":
                tr=p["hw"]-exit["trailAtr"]*p["atr0"]
                if tr>p["sl"]:p["sl"]=tr
            if p.get("sl") is not None and l1[i]<=p["sl"]:xpx=p["sl"]
            elif p.get("tp") is not None and h1[i]>=p["tp"]:xpx=p["tp"]
            elif i>=p["exit_idx"]:xpx=c1[i]
            if xpx is not None:
                fee=(p["entry"]+xpx)*QTY*TAKER
                trades.append({"t":p["t"],"pnl":QTY*(xpx-p["entry"])-fee})
            else:np.append(p)
        pos=np
        j=j4(i)
        if j<5:continue
        if len(pos)<MAX_CONC and K[i] is not None and K[i]<L_THR and c4[j]>c4[j-5] and (t1[i]-lastL)>=L_COOL*H:
            at=A1[i] or 0
            ex=min(i+L_HOLD,len(b1)-1)
            p={"t":t1[i],"entry":c1[i],"exit_idx":ex,"hw":h1[i],"atr0":at,"sl":None,"tp":None}
            if exit["mode"]=="atrsl":p["sl"]=c1[i]-exit["slAtr"]*at
            if exit["mode"]=="trail":p["sl"]=c1[i]-exit["slAtr"]*at
            if exit["mode"]=="tp":p["sl"]=c1[i]-exit["slAtr"]*at;p["tp"]=c1[i]+exit["tpAtr"]*at
            pos.append(p);lastL=t1[i]
    cum=peak=mdd=0.0;yr=defaultdict(float)
    for tr in sorted(trades,key=lambda x:x["t"]):
        cum+=tr["pnl"];peak=max(peak,cum);mdd=max(mdd,peak-cum)
        yr[dt.datetime.utcfromtimestamp(tr["t"]/1000).year]+=tr["pnl"]
    cal=cum/mdd if mdd>0 else float('inf')
    train=sum(v for y,v in yr.items() if y<=2022);test=sum(v for y,v in yr.items() if y>=2023)
    return {"total":cum,"mdd":mdd,"cal":cal,"n":len(trades),"yr":dict(yr),"train":train,"test":test}

variants=[("BASELINE time-exit72h",{"mode":"time"})]
for sl in [2,3,4]:variants.append((f"+ATR-SL {sl}",{"mode":"atrsl","slAtr":sl}))
for sl,tr in [(3,4),(3,6),(4,6)]:variants.append((f"+trail sl{sl}/tr{tr}",{"mode":"trail","slAtr":sl,"trailAtr":tr}))
for sl,tp in [(2,6),(2,10),(3,8)]:variants.append((f"+SL{sl}/TP{tp}",{"mode":"tp","slAtr":sl,"tpAtr":tp}))

print("\n=== STOCHBREAK LONG exit variants (NET fee, entry y nguyên) ===")
print("variant | total$ | MaxDD$ | Calmar | n | train$ | test$ | per-year")
res=[]
for nm,ex in variants:
    r=run(ex);res.append((nm,r))
    ys=" ".join(f"{y}:{r['yr'][y]:+.1f}" for y in sorted(r['yr']))
    print(f"{nm:<22} | {r['total']:>7.2f} | {r['mdd']:>6.2f} | {('inf' if r['cal']==float('inf') else f'{r['cal']:.2f}'):>6} | {r['n']:>4} | {r['train']:>6.2f} | {r['test']:>6.2f} | {ys}")
base=res[0][1]
print(f"\n--- vs BASELINE (total ${base['total']:.2f}, test ${base['test']:.2f}, Calmar {base['cal']:.2f}) ---")
w=[(nm,r) for nm,r in res[1:] if r['total']>base['total'] and r['test']>base['test']]
if not w:print("KHÔNG variant nào beat baseline ở CẢ total$ lẫn WF-test$.")
for nm,r in w:print(f"  {nm}: total {r['total']-base['total']:+.2f}$ test {r['test']-base['test']:+.2f}$ Calmar {r['cal']:.2f}")
