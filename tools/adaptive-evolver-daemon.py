#!/usr/bin/env python3
"""
adaptive-evolver-daemon.py — LOOP VÔ HẠN tìm rule ADAPTIVE sáng tạo (chống phai).
Genome = 1-2 điều kiện adaptive (z-score/pct-rank cuộn của indicator) + management.
Gate khắt nhất: mọi năm 2019-2026 (≥3 lệnh) net>0 + recent-4y≥25% (không phai)
                + drop-top3 dương + beat random 19/20.
Chạy: nohup python3 -u tools/adaptive-evolver-daemon.py > tools/adaptive.log 2>&1 &
Dừng: touch tools/adaptive-STOP
"""
import importlib.util,os,contextlib,random,json,time,datetime as dt
from collections import defaultdict
HERE=os.path.dirname(os.path.abspath(__file__))
CHAMP=os.path.join(HERE,"adaptive-champions.json")
def awrite(obj):
    t=CHAMP+".tmp";json.dump(obj,open(t,"w"),indent=1);os.replace(t,CHAMP)
STOP=os.path.join(HERE,"adaptive-STOP")
POOL=os.path.join(HERE,"adaptive-pool.jsonl")
_poolseen=set()
if os.path.exists(POOL):
    for ln in open(POOL):
        try:
            _poolseen.add(json.loads(ln)["key"])
        except:
            pass
def gkey(g):return json.dumps([g["dir"],sorted([[list(k),op,thr] for k,op,thr in g["preds"]]),g["mgmt"]],sort_keys=True)
def pool_add(res):
    k=gkey(res["genome"])
    if k in _poolseen:return False
    _poolseen.add(k);open(POOL,"a").write(json.dumps({"key":k,**res})+"\n");return True
with contextlib.redirect_stdout(open(os.devnull,"w")):
    spec=importlib.util.spec_from_file_location("ns",os.path.join(HERE,"novel-indicators-screen.py"))
    ns=importlib.util.module_from_spec(spec);spec.loader.exec_module(ns)
D,C,Hh,Ll,IND=ns.D,ns.C,ns.Hh,ns.Ll,ns.IND
n=len(D);FEE=0.0008
tr=[0.0]*n
for i in range(1,n):tr[i]=max(Hh[i]-Ll[i],abs(Hh[i]-C[i-1]),abs(Ll[i]-C[i-1]))
A=[None]*n;a=sum(tr[1:15])/14;A[14]=a
for i in range(15,n):a=(a*13+tr[i])/14;A[i]=a
yr=lambda i:dt.datetime.utcfromtimestamp(D[i]["time"]/1000).year
NAMES=[k for k in IND if sum(1 for x in IND[k] if x is not None)>1500]
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
print(f"[adaptive] precomputing transforms cho {len(NAMES)} indicator...")
TRANS={}
for name in NAMES:
    for W in [20,30,60,120]:
        TRANS[(name,"z",W)]=zscore(IND[name],W)
        TRANS[(name,"pct",W)]=pctrank(IND[name],W)
KEYS=list(TRANS.keys())
print(f"[adaptive] {len(TRANS)} adaptive transforms · loop vô hạn (combo 1-2 đk)")

def exit_sim(i,d,sl,trl,mh):
    e=C[i];stop=e-sl*A[i] if d=="LONG" else e+sl*A[i];pk=e
    for k in range(i+1,min(i+1+mh,n)):
        if d=="LONG":
            if Ll[k]<=stop:return k,stop
            pk=max(pk,C[k])
            if C[k]<=pk-trl*A[i]:return k,C[k]
        else:
            if Hh[k]>=stop:return k,stop
            pk=min(pk,C[k])
            if C[k]>=pk+trl*A[i]:return k,C[k]
    k=min(i+mh,n-1);return k,C[k]
def backtest(preds,d,sl,trl,mh):
    out=[];i=50
    while i<n-1:
        if A[i] is None:i+=1;continue
        ok=True
        for arr,op,thr in preds:
            v=arr[i]
            if v is None or (op==">" and not v>thr) or (op=="<" and not v<thr):ok=False;break
        if ok:
            k_ex,ex=exit_sim(i,d,sl,trl,mh);e=C[i]
            out.append((i,((ex/e-1) if d=="LONG" else (e/ex-1))-FEE));i=k_ex+1
        else:i+=1
    return out
def rand_null(d,sl,trl,mh,nt,asum):
    w=0
    for s in range(20):
        rng=random.Random(s*97+nt);picks=sorted(rng.sample(range(50,n-1),min(nt,n-55)));rs=0
        for i in picks:
            if A[i] is None:continue
            k_ex,ex=exit_sim(i,d,sl,trl,mh);e=C[i];rs+=((ex/e-1) if d=="LONG" else (e/ex-1))-FEE
        if asum>rs:w+=1
    return w
YALL=[2019,2020,2021,2022,2023,2024,2025,2026];MGMT=[(1.5,3.0,12),(2.0,3.5,20),(2.5,2.5,10),(1.8,2.8,8)]
def rand_pred():
    key=random.choice(KEYS);kind=key[1]
    op=random.choice(["<",">"]);thr=round(random.uniform(-2.5,2.5),2) if kind=="z" else round(random.uniform(0.05,0.95),2)
    return [key,op,thr]
def rand_genome():
    return {"dir":random.choice(["LONG","SHORT"]),"preds":[rand_pred() for _ in range(random.randint(1,2))],
            "mgmt":list(random.choice(MGMT))}
def mutate(g):
    g=json.loads(json.dumps(g));r=random.random()
    if r<0.4:g["preds"][random.randrange(len(g["preds"]))][2]=round(g["preds"][random.randrange(len(g["preds"]))][2]*random.uniform(0.7,1.3),2)
    elif r<0.6 and len(g["preds"])<2:g["preds"].append(rand_pred())
    elif r<0.7 and len(g["preds"])>1:g["preds"].pop()
    else:g["mgmt"]=list(random.choice(MGMT))
    return g
def evalg(g):
    preds=[(TRANS[tuple(k)],op,thr) for k,op,thr in g["preds"]]
    d=g["dir"];sl,trl,mh=g["mgmt"]
    trd=backtest(preds,d,sl,trl,mh)
    if len(trd)<50:return None
    rets=[r for _,r in trd];s=sum(rets)
    if s<=0:return None
    by=defaultdict(float);byn=defaultdict(int)
    for i,r in trd:by[yr(i)]+=r;byn[yr(i)]+=1
    if any(byn.get(y,0)<3 for y in YALL):return None
    if any(by.get(y,0)<=0 for y in YALL):return None
    rec=sum(by.get(y,0) for y in [2023,2024,2025,2026])
    if rec<0.25*s:return None
    srt=sorted(rets,reverse=True)
    if sum(srt[3:])<=0:return None
    if rand_null(d,sl,trl,mh,len(trd),s)<19:return None
    return {"genome":g,"n":len(trd),"sumRet":round(s*100,1),"recentPct":round(rec/s*100),
            "byYear":{y:round(by[y]*100,1) for y in sorted(by)},"dropTop3":round(sum(srt[3:])*100),"ts":int(time.time())}
def sig(c):return (c["genome"]["dir"],frozenset((k[0],k[1]) for k,_,_ in c["genome"]["preds"]))
def score(c):return c["sumRet"]*(c["recentPct"]/100)  # ưu tiên sum cao + recent đậm (chống phai)

champs=[]
if os.path.exists(CHAMP):
    try:champs=json.load(open(CHAMP)).get("champions",[])
    except:pass
it=found=0
while not os.path.exists(STOP):
    it+=1
    g=mutate(random.choice(champs)["genome"]) if (champs and random.random()<0.22) else rand_genome()
    res=evalg(g)
    if res:
        ispool=pool_add(res)  # cày pool: lưu mọi rule distinct qua gate
        s=sig(res);same=[c for c in champs if sig(c)==s];isnew=not same
        if not same:champs.append(res)
        elif score(res)>score(same[0]):champs.remove(same[0]);champs.append(res)
        else:
            continue
        # diversity: tối đa 3 champion chứa cùng 1 indicator
        from collections import Counter as _Ct
        champs=sorted(champs,key=score,reverse=True)
        kept=[];cnt=_Ct()
        for c in champs:
            inds=set(k[0] for k,_,_ in c["genome"]["preds"])
            if all(cnt[x]<3 for x in inds):
                kept.append(c)
                for x in inds:cnt[x]+=1
            if len(kept)>=40:break
        champs=kept
        awrite({"updated":int(time.time()),"champions":champs})
        if isnew:
            found+=1;g=res["genome"];pr=" AND ".join(f"{k[0]}.{k[1]}{k[2]}{op}{thr}" for k,op,thr in g["preds"])
            print(f"[adaptive] ✓#{found} {g['dir']} n{res['n']} sum{res['sumRet']:+.0f}% recent{res['recentPct']}% | {pr}")
    if it%5000==0:print(f"[adaptive] it{it} champions={len(champs)} POOL={len(_poolseen)} found={found}")
print(f"[adaptive] STOP {it} iters {found} found")
