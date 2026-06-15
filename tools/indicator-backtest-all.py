#!/usr/bin/env python3
"""
indicator-backtest-all.py — backtest TẤT CẢ indicator mới (mọi chiều/ngưỡng/management),
LỌC cái có giá trị TĂNG DẦN từng năm (mỗi năm net>0 = equity monotonic up, KHÔNG concentration)
+ beat random-null (anti-beta). Xuất survivors để audit/improve.
"""
import importlib.util,json,statistics as st,random,datetime as dt
from collections import defaultdict
spec=importlib.util.spec_from_file_location("ns","tools/novel-indicators-screen.py")
ns=importlib.util.module_from_spec(spec);spec.loader.exec_module(ns)  # tính IND (in screen, bỏ qua)
D,C,Hh,Ll,IND=ns.D,ns.C,ns.Hh,ns.Ll,ns.IND
n=len(D);FEE=0.0008
# ATR
tr=[0.0]*n
for i in range(1,n):tr[i]=max(Hh[i]-Ll[i],abs(Hh[i]-C[i-1]),abs(Ll[i]-C[i-1]))
A=[None]*n;a=sum(tr[1:15])/14;A[14]=a
for i in range(15,n):a=(a*13+tr[i])/14;A[i]=a
def yr(i):return dt.datetime.utcfromtimestamp(D[i]["time"]/1000).year
MGMT=[(1.5,3.0,12),(2.0,3.5,20),(2.5,2.5,10)]
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
            ret=((ex/e-1) if d=="LONG" else (e/ex-1))-FEE
            out.append((i,ret));i=k_ex+1
        else:i+=1
    return out
def rand_null(d,sl,trl,mh,nt,asum):
    w=0
    for s in range(20):
        rng=random.Random(s*97+nt);picks=sorted(rng.sample(range(50,n-1),min(nt,n-55)))
        rs=0
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
def pct(vals,q):
    v=sorted(x for x in vals if x is not None);return v[int(len(v)*q/100)] if v else 0

survivors=[]
for name,arr in IND.items():
    vals=[x for x in arr if x is not None]
    if len(vals)<800:continue
    t20=pct(vals,20);t80=pct(vals,80)
    for op,thr in [(">",t80),("<",t20)]:
        for d in ["LONG","SHORT"]:
            for sl,trl,mh in MGMT:
                trd=backtest(arr,op,thr,d,sl,trl,mh)
                if len(trd)<50:continue
                rets=[r for _,r in trd];s=sum(rets)
                if s<=0:continue
                by=defaultdict(float);byn=defaultdict(int)
                for i,r in trd:by[yr(i)]+=r;byn[yr(i)]+=1
                yrs=[y for y in by if byn[y]>=3]
                # KHÔNG NÉ NĂM NÀO: mọi năm 2019-2026 phải trade ≥3 lệnh VÀ net>0.
                YALL=[2019,2020,2021,2022,2023,2024,2025,2026]
                if any(byn.get(y,0)<3 for y in YALL):continue   # phải fire ≥3 MỖI năm (không né)
                if any(by.get(y,0)<=0 for y in YALL):continue    # MỌI năm net>0 (đúng mọi năm)
                # KHÔNG PHAI: 4 năm gần (2023-2026) phải đóng góp ≥25% tổng (không chỉ ăn 2019-21)
                if sum(by.get(y,0) for y in [2023,2024,2025,2026])<0.25*s:continue
                # anti-concentration: drop-top-3 lệnh vẫn dương
                srt=sorted(rets,reverse=True)
                if sum(srt[3:])<=0:continue
                # random-null 19/20 (chống multiple-testing)
                w=rand_null(d,sl,trl,mh,len(trd),s)
                if w<19:continue
                tr1=sum(r for i,r in trd if yr(i)<=2022);tr2=sum(r for i,r in trd if yr(i)>=2023)
                survivors.append({"name":name,"op":op,"thr":round(thr,5),"dir":d,"sl":sl,"trail":trl,"hold":mh,
                                  "n":len(trd),"sumRet":round(s*100,1),"randWin":w,
                                  "byYear":{y:round(by[y]*100,1) for y in sorted(yrs)},
                                  "minYear":round(min(by[y] for y in yrs)*100,1),
                                  "oosTrain":round(tr1*100),"oosTest":round(tr2*100),
                                  "ret2026":round(sum(r for i,r in trd if yr(i)==2026)*100,1),
                                  "dropTop3":round(sum(srt[3:])*100)})
survivors.sort(key=lambda x:(-x["oosTest"]))
print(f"=== BACKTEST ALL {len(IND)} indicator → SURVIVORS (OOS train+test dương · 2026≥0 · drop-top3 · rand19/20) ===")
print(f"Tổng survivors: {len(survivors)}\n")
for s in survivors[:25]:
    yrstr=" ".join(f"{y}:{v:+.0f}" for y,v in s["byYear"].items())
    print(f"{s['dir']} {s['name']}{s['op']}{s['thr']} sl{s['sl']}tr{s['trail']}h{s['hold']} | n{s['n']} sum{s['sumRet']:+.0f}% rand{s['randWin']}/20")
    print(f"   OOS train{s['oosTrain']:+.0f}%/test{s['oosTest']:+.0f}% · 2026:{s['ret2026']:+.0f}% · dropTop3{s['dropTop3']:+.0f}% | {yrstr}")
json.dump(survivors,open("/tmp/indicator_survivors.json","w"),indent=1)
print(f"\n→ /tmp/indicator_survivors.json ({len(survivors)} survivors)")
