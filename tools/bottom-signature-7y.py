#!/usr/bin/env python3
"""
bottom-signature-7y.py — Góc B: để DATA nói.
Quét 7y daily, tìm MỌI đáy/đỉnh TRADEABLE (local extrema + rally/drop thật sau),
đo chữ ký indicator THẬT (past-only, causal) tại đó vs baseline → tìm tín hiệu đáy thật.
"""
import json, datetime as dt, statistics as st
CACHE="/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
b5=json.load(open(CACHE))
def agg(b5,h):
    out=[];span=h*3600*1000;cur=None
    for b in b5:
        bk=(b["time"]//span)*span
        if cur is None or bk!=cur["time"]:
            if cur:out.append(cur)
            cur=dict(time=bk,open=b["open"],high=b["high"],low=b["low"],close=b["close"],vol=b.get("volume",0))
        else:
            cur["high"]=max(cur["high"],b["high"]);cur["low"]=min(cur["low"],b["low"]);cur["close"]=b["close"];cur["vol"]+=b.get("volume",0)
    if cur:out.append(cur)
    return out
D=agg(b5,24)
C=[b["close"] for b in D];Hh=[b["high"] for b in D];Ll=[b["low"] for b in D];O=[b["open"] for b in D];V=[b["vol"] for b in D]
n=len(D)
def rsi(c,p=14):
    o=[None]*len(c);g=l=0.0
    for i in range(1,p+1):ch=c[i]-c[i-1];g+=max(ch,0);l+=max(-ch,0)
    ag=g/p;al=l/p;o[p]=100-100/(1+ag/al) if al else 100.0
    for i in range(p+1,len(c)):
        ch=c[i]-c[i-1];ag=(ag*(p-1)+max(ch,0))/p;al=(al*(p-1)+max(-ch,0))/p
        o[i]=100-100/(1+ag/al) if al else 100.0
    return o
def stk(c,rp=14,sp=14,ks=3):
    r=rsi(c,rp);N=len(c);rk=[None]*N
    for i in range(N):
        if r[i] is None:continue
        w=[r[j] for j in range(max(0,i-sp+1),i+1) if r[j] is not None]
        if len(w)<sp:continue
        lo=min(w);hi=max(w);rk[i]=100.0 if hi==lo else (r[i]-lo)/(hi-lo)*100
    k=[None]*N
    for i in range(N):
        w=[rk[j] for j in range(max(0,i-ks+1),i+1) if rk[j] is not None]
        if len(w)==ks:k[i]=sum(w)/ks
    return k
def ema(c,p):
    o=[None]*len(c);k=2/(p+1);e=c[0]
    for i in range(len(c)):e=c[i]*k+e*(1-k);o[i]=e
    return o
def atr(p=14):
    tr=[0.0]*n
    for i in range(1,n):tr[i]=max(Hh[i]-Ll[i],abs(Hh[i]-C[i-1]),abs(Ll[i]-C[i-1]))
    o=[None]*n;a=sum(tr[1:p+1])/p;o[p]=a
    for i in range(p+1,n):a=(a*(p-1)+tr[i])/p;o[i]=a
    return o
R=rsi(C);K=stk(C);E50=ema(C,50);E200=ema(C,200);A=atr(14);V20=[None]*n
for i in range(n):
    if i>=20:V20[i]=sum(V[i-20:i])/20

def feats(i):
    """past-only indicator state tại bar i."""
    if i<200 or A[i] is None or V20[i] in (None,0):return None
    hh30=max(Hh[i-30:i+1]);ll30=min(Ll[i-30:i+1])
    rng=(C[i]-ll30)/(hh30-ll30)*100 if hh30>ll30 else 50
    body=C[i]-O[i];lowwick=(min(O[i],C[i])-Ll[i]);rngbar=Hh[i]-Ll[i] or 1
    cons=0  # consecutive down closes
    j=i
    while j>0 and C[j]<C[j-1]:cons+=1;j-=1
    return dict(
        rsi=R[i], stochK=K[i] if K[i] is not None else 50,
        posRange=rng,                         # vị trí trong range 30d
        vsE200=(C[i]/E200[i]-1)*100,
        vsE50=(C[i]/E50[i]-1)*100,
        atrPct=A[i]/C[i]*100,                 # vol
        dropFrom20H=(C[i]/hh30-1)*100,        # drop từ đỉnh 30d
        volRatio=V[i]/V20[i],                 # volume spike
        lowWickRatio=lowwick/rngbar*100,      # bóng dưới (hammer?)
        consDown=cons,
    )

# ── swing detection: local extremum ±W + tradeable (rally/drop ≥ THR trong FWD ngày) ──
W=7; FWD=20; THR=0.10
lows=[];highs=[]
for i in range(W, n-FWD):
    win=D[i-W:i+W+1]
    fwd=D[i+1:i+FWD+1]
    if Ll[i]==min(x["low"] for x in win):
        rally=(max(x["high"] for x in fwd)-Ll[i])/Ll[i]
        if rally>=THR: lows.append(i)
    if Hh[i]==max(x["high"] for x in win):
        drop=(Hh[i]-min(x["low"] for x in fwd))/Hh[i]
        if drop>=THR: highs.append(i)

FK=["rsi","stochK","posRange","vsE200","vsE50","atrPct","dropFrom20H","volRatio","lowWickRatio","consDown"]
def collect(idxs):
    out={k:[] for k in FK}
    for i in idxs:
        f=feats(i)
        if f:
            for k in FK:out[k].append(f[k])
    return out
allf=collect(range(200,n-FWD)); lowf=collect(lows); highf=collect(highs)
print(f"=== DATA-DRIVEN SIGNATURE 7y (swing ±{W}d, tradeable rally/drop ≥{THR*100:.0f}% trong {FWD}d) ===")
print(f"  Đáy tradeable: {len(lows)} | Đỉnh tradeable: {len(highs)} | baseline bars: {len(allf['rsi'])}\n")
print(f"  {'Feature':<14} | {'ĐÁY(med)':>9} | {'baseline':>9} | {'ĐỈNH(med)':>9} | discrimination đáy")
for k in FK:
    md=st.median(lowf[k]); mb=st.median(allf[k]); mh=st.median(highf[k])
    sd=st.pstdev(allf[k]) or 1
    z=(md-mb)/sd  # how many baseline-std the bottom-median sits from baseline
    flag=" <<<" if abs(z)>=0.5 else ""
    print(f"  {k:<14} | {md:>9.1f} | {mb:>9.1f} | {mh:>9.1f} | z={z:+.2f}{flag}")
# how often is StochK<20 at real bottoms?
import numpy as np
lk=[x for x in lowf["stochK"]]
print(f"\n  StochK<20 tại đáy thật: {sum(1 for x in lk if x<20)}/{len(lk)} = {sum(1 for x in lk if x<20)/len(lk)*100:.0f}%  (rule live giả định cái này)")
print(f"  RSI<35 tại đáy thật:    {sum(1 for x in lowf['rsi'] if x<35)}/{len(lowf['rsi'])} = {sum(1 for x in lowf['rsi'] if x<35)/len(lowf['rsi'])*100:.0f}%")
print(f"  volRatio>1.5 tại đáy:   {sum(1 for x in lowf['volRatio'] if x>1.5)}/{len(lowf['volRatio'])} = {sum(1 for x in lowf['volRatio'] if x>1.5)/len(lowf['volRatio'])*100:.0f}%")
print(f"  consDown≥3 tại đáy:     {sum(1 for x in lowf['consDown'] if x>=3)}/{len(lowf['consDown'])} = {sum(1 for x in lowf['consDown'] if x>=3)/len(lowf['consDown'])*100:.0f}%")
print(f"  lowWick>40% tại đáy:    {sum(1 for x in lowf['lowWickRatio'] if x>40)}/{len(lowf['lowWickRatio'])} = {sum(1 for x in lowf['lowWickRatio'] if x>40)/len(lowf['lowWickRatio'])*100:.0f}%")
json.dump({"lows":len(lows),"highs":len(highs),
           "low_med":{k:round(st.median(lowf[k]),2) for k in FK},
           "base_med":{k:round(st.median(allf[k]),2) for k in FK},
           "high_med":{k:round(st.median(highf[k]),2) for k in FK}},open("/tmp/bottom_sig.json","w"),indent=1)
print("\n→ /tmp/bottom_sig.json")
