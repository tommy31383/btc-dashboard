#!/usr/bin/env python3
"""cross-asset test top adaptive candidates (retSkewSign family) trên BTC/ETH/SOL + alpha."""
import json,datetime as dt,statistics as st
from collections import defaultdict
ASSETS={"BTC":".cache/binance-5m-7y.json","ETH":".cache/binance-eth-5m-7y.json","SOL":".cache/binance-sol-5m-3y.json"}
FEE=0.0008
def agg(b5,h=24):
    out=[];span=h*3600*1000;cur=None
    for b in b5:
        bk=(b["time"]//span)*span
        if cur is None or bk!=cur["time"]:
            if cur:out.append(cur)
            cur=dict(time=bk,open=b["open"],high=b["high"],low=b["low"],close=b["close"],vol=b.get("volume",0))
        else:cur["high"]=max(cur["high"],b["high"]);cur["low"]=min(cur["low"],b["low"]);cur["close"]=b["close"];cur["vol"]+=b.get("volume",0)
    if cur:out.append(cur)
    return out
def build(D):
    n=len(D);C=[b["close"] for b in D];O=[b["open"] for b in D];Hh=[b["high"] for b in D];Ll=[b["low"] for b in D]
    ret=[0.0]+[C[i]/C[i-1]-1 for i in range(1,n)]
    tr=[0.0]*n
    for i in range(1,n):tr[i]=max(Hh[i]-Ll[i],abs(Hh[i]-C[i-1]),abs(Ll[i]-C[i-1]))
    A=[None]*n;a=sum(tr[1:15])/14;A[14]=a
    for i in range(15,n):a=(a*13+tr[i])/14;A[i]=a
    IND={}
    # retSkewSign_30
    rss=[None]*n
    for i in range(30,n):
        up=sum(1 for j in range(i-29,i+1) if ret[j]>0)/30
        negm=sum(abs(ret[j]) for j in range(i-29,i+1) if ret[j]<0);tot=sum(abs(ret[j]) for j in range(i-29,i+1)) or 1e-9
        rss[i]=up-negm/tot
    IND["retSkewSign_30"]=rss
    for W in [40,60]:
        ts=[None]*n
        for i in range(W,n):ts[i]=(i-max(range(i-W+1,i+1),key=lambda j:Hh[j]))/W
        IND[f"timeSinceHigh_{W}"]=ts
    # closeAccel_5
    ca=[None]*n
    for i in range(10,n):ca[i]=((C[i]-C[i-5])-(C[i-5]-C[i-10]))/C[i]
    IND["closeAccel_5"]=ca
    return C,Hh,Ll,A,IND
def ztr(arr,W,n):
    o=[None]*n
    for i in range(W,n):
        seg=[arr[j] for j in range(i-W,i) if arr[j] is not None]
        if len(seg)<W*0.7 or arr[i] is None:continue
        m=sum(seg)/len(seg);sd=(sum((x-m)**2 for x in seg)/len(seg))**0.5
        if sd>1e-12:o[i]=(arr[i]-m)/sd
    return o
def ptr(arr,W,n):
    o=[None]*n
    for i in range(W,n):
        seg=[arr[j] for j in range(i-W,i) if arr[j] is not None]
        if len(seg)<W*0.7 or arr[i] is None:continue
        o[i]=sum(1 for x in seg if x<arr[i])/len(seg)
    return o
def tf(IND,name,kind,W,n):
    return ztr(IND[name],W,n) if kind=="z" else ptr(IND[name],W,n)
def bt(preds,d,sl,trl,mh,C,Hh,Ll,A,D):
    n=len(C);out=[];i=50
    while i<n-1:
        if A[i] is None:i+=1;continue
        ok=all(arr[i] is not None and ((arr[i]>thr) if op==">" else (arr[i]<thr)) for arr,op,thr in preds)
        if ok:
            e=C[i];stop=e-sl*A[i] if d=="LONG" else e+sl*A[i];pk=e;ex=None;k_ex=None
            for k in range(i+1,min(i+1+mh,n)):
                if d=="LONG":
                    if Ll[k]<=stop:ex=stop;k_ex=k;break
                    pk=max(pk,C[k])
                    if C[k]<=pk-trl*A[i]:ex=C[k];k_ex=k;break
                else:
                    if Hh[k]>=stop:ex=stop;k_ex=k;break
                    pk=min(pk,C[k])
                    if C[k]>=pk+trl*A[i]:ex=C[k];k_ex=k;break
            else:k_ex=min(i+mh,n-1);ex=C[k_ex]
            ret=((ex/e-1) if d=="LONG" else (e/ex-1))-FEE;hold=C[k_ex]/e-1
            out.append((D[i]["time"],ret,ret-hold));i=k_ex+1
        else:i+=1
    return out
# top candidates (retSkewSign family)
CANDS=[
 ("R1: retSkew.z30>0.88 AND tSinceHigh40.pct30<0.85","LONG",[("retSkewSign_30","z",30,">",0.88),("timeSinceHigh_40","pct",30,"<",0.85)],2.0,3.5,20),
 ("R2: retSkew.z30>0.92","LONG",[("retSkewSign_30","z",30,">",0.92)],1.8,2.8,8),
 ("R3: retSkew.z30>0.74 AND tSinceHigh60.pct30<0.8","LONG",[("retSkewSign_30","z",30,">",0.74),("timeSinceHigh_60","pct",30,"<",0.8)],2.0,3.5,20),
 ("R4: retSkew.z30>0.92 AND closeAccel5.z30<2.01","LONG",[("retSkewSign_30","z",30,">",0.92),("closeAccel_5","z",30,"<",2.01)],1.8,2.8,8),
]
data={nm:build(agg(json.load(open(p)))) for nm,p in ASSETS.items()}
print("=== CROSS-ASSET adaptive candidates (alpha=ret-hold) ===\n")
for cn,d,preds,sl,trl,mh in CANDS:
    print(cn)
    for asset in ["BTC","ETH","SOL"]:
        C,Hh,Ll,A,IND=data[asset];n=len(C)
        pr=[(tf(IND,nm,kind,W,n),op,thr) for nm,kind,W,op,thr in preds]
        t=bt(pr,d,sl,trl,mh,C,Hh,Ll,A,data[asset][0] and None or None) if False else bt(pr,d,sl,trl,mh,C,Hh,Ll,A,[{"time":b} for b in [0]]) if False else None
        # need D for time; rebuild
        Draw=agg(json.load(open(ASSETS[asset])))
        t=bt(pr,d,sl,trl,mh,C,Hh,Ll,A,Draw)
        if not t:print(f"   {asset}: 0 lệnh");continue
        r=[x[1] for x in t];a=[x[2] for x in t]
        by=defaultdict(float)
        for tm,rr,aa in t:by[dt.datetime.utcfromtimestamp(tm/1000).year]+=aa
        posA=sum(1 for y in by if by[y]>0)
        print(f"   {asset}: n{len(t)} sumRet{sum(r)*100:+.0f}% medAlpha{st.median(a)*100:+.2f}% alphaSum{sum(a)*100:+.0f}% alphaYr{posA}/{len(by)}")
    print()
