#!/usr/bin/env python3
"""
adaptive-rule-evolver.py — search rule ADAPTIVE chống phai: thay ngưỡng TĨNH bằng
ngưỡng TỰ CHUẨN HOÁ theo regime (z-score cuộn / percentile-rank cuộn của indicator).
→ rule tự recalibrate → "đúng mọi năm + không phai".
Gate khắt nhất: mọi năm 2019-2026 (≥3 lệnh) net>0 + recent-4y ≥25% (không phai)
                + drop-top3 dương + beat random 19/20.
"""
import importlib.util,os,sys,contextlib,random,datetime as dt
from collections import defaultdict
with contextlib.redirect_stdout(open(os.devnull,"w")):
    spec=importlib.util.spec_from_file_location("ns","tools/novel-indicators-screen.py")
    ns=importlib.util.module_from_spec(spec);spec.loader.exec_module(ns)
D,C,Hh,Ll,IND=ns.D,ns.C,ns.Hh,ns.Ll,ns.IND
n=len(D)
tr=[0.0]*n
for i in range(1,n):tr[i]=max(Hh[i]-Ll[i],abs(Hh[i]-C[i-1]),abs(Ll[i]-C[i-1]))
A=[None]*n;a=sum(tr[1:15])/14;A[14]=a
for i in range(15,n):a=(a*13+tr[i])/14;A[i]=a
yr=lambda i:dt.datetime.utcfromtimestamp(D[i]["time"]/1000).year
FEE=0.0008
NAMES=[k for k in IND if sum(1 for x in IND[k] if x is not None)>1500]
print(f"[adaptive] {len(NAMES)} indicator usable")

# ── precompute biến đổi ADAPTIVE: z-score cuộn + percentile-rank cuộn ──
def zscore(arr,W):
    o=[None]*n
    for i in range(W,n):
        seg=[arr[j] for j in range(i-W,i) if arr[j] is not None]
        if len(seg)<W*0.7 or arr[i] is None:continue
        m=sum(seg)/len(seg);sd=(sum((x-m)**2 for x in seg)/len(seg))**0.5
        if sd>1e-12:o[i]=(arr[i]-m)/sd
    return o
def pctrank(arr,W):
    o=[None]*n
    for i in range(W,n):
        seg=[arr[j] for j in range(i-W,i) if arr[j] is not None]
        if len(seg)<W*0.7 or arr[i] is None:continue
        o[i]=sum(1 for x in seg if x<arr[i])/len(seg)
    return o
TRANS={}  # (name,kind,W) -> series
for name in NAMES:
    for W in [40,80]:
        TRANS[(name,"z",W)]=zscore(IND[name],W)
        TRANS[(name,"pct",W)]=pctrank(IND[name],W)
print(f"[adaptive] {len(TRANS)} adaptive transforms precomputed")

def backtest(arr,op,thr,d,sl,trl,mh):
    out=[];i=50
    while i<n-1:
        if A[i] is None or arr[i] is None:i+=1;continue
        fire=(arr[i]>thr) if op==">" else (arr[i]<thr)
        if fire:
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
            out.append((i,((ex/e-1) if d=="LONG" else (e/ex-1))-FEE));i=k_ex+1
        else:i+=1
    return out
def rand_null(d,sl,trl,mh,nt,asum):
    w=0
    for s in range(20):
        rng=random.Random(s*97+nt);picks=sorted(rng.sample(range(50,n-1),min(nt,n-55)));rs=0
        for i in picks:
            if A[i] is None:continue
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
            rs+=((ex/e-1) if d=="LONG" else (e/ex-1))-FEE
        if asum>rs:w+=1
    return w
YALL=[2019,2020,2021,2022,2023,2024,2025,2026]
MGMT=[(1.5,3.0,12),(2.0,3.5,20),(2.5,2.5,10),(1.8,2.8,8)]
keys=list(TRANS.keys())
found=[];it=0
import time
t0=time.time()
while time.time()-t0<240 and len(found)<15:   # 4 phút hoặc 15 rule
    it+=1
    key=random.choice(keys);arr=TRANS[key];kind=key[1]
    op=random.choice(["<",">"])
    thr=round(random.uniform(-2.5,2.5),2) if kind=="z" else round(random.uniform(0.05,0.95),2)
    d=random.choice(["LONG","SHORT"]);sl,trl,mh=random.choice(MGMT)
    trd=backtest(arr,op,thr,d,sl,trl,mh)
    if len(trd)<50:continue
    rets=[r for _,r in trd];s=sum(rets)
    if s<=0:continue
    by=defaultdict(float);byn=defaultdict(int)
    for i,r in trd:by[yr(i)]+=r;byn[yr(i)]+=1
    if any(byn.get(y,0)<3 for y in YALL):continue
    if any(by.get(y,0)<=0 for y in YALL):continue
    if sum(by.get(y,0) for y in [2023,2024,2025,2026])<0.25*s:continue
    srt=sorted(rets,reverse=True)
    if sum(srt[3:])<=0:continue
    if rand_null(d,sl,trl,mh,len(trd),s)<19:continue
    found.append((key,op,thr,d,sl,trl,mh,len(trd),round(s*100),{y:round(by[y]*100) for y in sorted(by)}))
    k=key
    print(f"[adaptive] ✓ {d} {k[0]}.{k[1]}{k[2]} {op}{thr} sl{sl}tr{trl}h{mh} | n{len(trd)} sum{round(s*100):+}% | "+" ".join(f"{y}:{round(by[y]*100):+}" for y in sorted(by)))
print(f"\n[adaptive] DONE {it} candidates, {len(found)} rule adaptive qua gate khắt nhất (đúng mọi năm + không phai + robust)")
