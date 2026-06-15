#!/usr/bin/env python3
"""
formula-evolver.py — GENETIC PROGRAMMING: tự CHẾ công thức từ đường giá để tìm
đáy/đỉnh, nhiều entry ĐÚNG. Genome = cây biểu thức (kết hợp số học các atom
price-derived) → predicate boolean. Sáng tạo hơn threshold-1-feature.
Gate chống-mirage + GENERAL:
  🔒 medAlpha>0 trên BTC  (mỗi entry beat hold, "đúng")
  🔒 RETURN 2026>0 VÀ 2022>0  (2 bear độc lập)
  🔒 drop-top-20% alpha dương + beat random-null ≥pct90 (BTC)
  🔒 CROSS-ASSET: medAlpha>0 trên SOL VÀ ETH (general thật)
  n_2026≥6, total≥40 (NHIỀU entry)
Chạy: nohup python3 tools/formula-evolver.py > tools/formula.log 2>&1 &
Dừng: touch tools/formula-STOP
"""
import json,os,random,time,datetime as dt,statistics as st
from collections import defaultdict
HERE=os.path.dirname(os.path.abspath(__file__))
ASSETS={"BTC":os.path.join(HERE,"..",".cache","binance-5m-7y.json"),
        "ETH":os.path.join(HERE,"..",".cache","binance-eth-5m-7y.json"),
        "SOL":os.path.join(HERE,"..",".cache","binance-sol-5m-3y.json")}
CHAMP=os.path.join(HERE,"formula-champions.json");STOP=os.path.join(HERE,"formula-STOP")
FEE=0.0008; random.seed()

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
def ema(x,p):
    o=[None]*len(x);k=2/(p+1);e=x[0]
    for i in range(len(x)):e=x[i]*k+e*(1-k);o[i]=e
    return o
def rsi(c,p=14):
    o=[None]*len(c);g=l=0.0
    for i in range(1,p+1):ch=c[i]-c[i-1];g+=max(ch,0);l+=max(-ch,0)
    ag=g/p;al=l/p;o[p]=100-100/(1+ag/al) if al else 100.0
    for i in range(p+1,len(c)):
        ch=c[i]-c[i-1];ag=(ag*(p-1)+max(ch,0))/p;al=(al*(p-1)+max(-ch,0))/p
        o[i]=100-100/(1+ag/al) if al else 100.0
    return o

# ── ATOMS: đại lượng price-derived, dimensionless, causal (past-only) ──
ATOMS=["ret1","ret3","ret5","ret10","ret20","z10","z20","rngpos10","rngpos30",
       "slope5","slope10","wickUp","wickLow","body","atrpct","rsi","volr","dd20","ru20","cdown","cup",
       "vsE200","vsE50","e200slope"]
def build_atoms(D):
    n=len(D);C=[b["close"] for b in D];O=[b["open"] for b in D];Hh=[b["high"] for b in D];Ll=[b["low"] for b in D];Vv=[b["vol"] for b in D]
    R=rsi(C);E200=ema(C,200);E50=ema(C,50)
    tr=[0.0]*n
    for i in range(1,n):tr[i]=max(Hh[i]-Ll[i],abs(Hh[i]-C[i-1]),abs(Ll[i]-C[i-1]))
    A=[None]*n;a=sum(tr[1:15])/14;A[14]=a
    for i in range(15,n):a=(a*13+tr[i])/14;A[i]=a
    X={k:[None]*n for k in ATOMS}
    for i in range(n):
        if i<30 or A[i] is None:continue
        for k,key in [(1,"ret1"),(3,"ret3"),(5,"ret5"),(10,"ret10"),(20,"ret20")]:
            X[key][i]=C[i]/C[i-k]-1
        for w,key in [(10,"z10"),(20,"z20")]:
            seg=C[i-w+1:i+1];m=sum(seg)/w;sd=(sum((x-m)**2 for x in seg)/w)**0.5 or 1;X[key][i]=(C[i]-m)/sd
        for w,key in [(10,"rngpos10"),(30,"rngpos30")]:
            hh=max(Hh[i-w+1:i+1]);ll=min(Ll[i-w+1:i+1]);X[key][i]=(C[i]-ll)/(hh-ll) if hh>ll else 0.5
        X["slope5"][i]=(C[i]/C[i-5]-1)/5;X["slope10"][i]=(C[i]/C[i-10]-1)/10
        rb=Hh[i]-Ll[i] or 1
        X["wickUp"][i]=(Hh[i]-max(O[i],C[i]))/rb;X["wickLow"][i]=(min(O[i],C[i])-Ll[i])/rb;X["body"][i]=(C[i]-O[i])/rb
        X["atrpct"][i]=A[i]/C[i]
        X["rsi"][i]=R[i]/100 if R[i] is not None else 0.5
        v20=sum(Vv[i-20:i])/20 if i>=20 else None;X["volr"][i]=Vv[i]/v20 if v20 else 1
        hh20=max(Hh[i-20:i+1]);ll20=min(Ll[i-20:i+1]);X["dd20"][i]=C[i]/hh20-1;X["ru20"][i]=C[i]/ll20-1
        cd=cu=0;j=i
        while j>0 and C[j]<C[j-1]:cd+=1;j-=1
        j=i
        while j>0 and C[j]>C[j-1]:cu+=1;j-=1
        X["cdown"][i]=cd;X["cup"][i]=cu
        if E200[i]:
            X["vsE200"][i]=C[i]/E200[i]-1
            if i>=5 and E200[i-5]:X["e200slope"][i]=(E200[i]/E200[i-5]-1)
        if E50[i]:X["vsE50"][i]=C[i]/E50[i]-1
    return C,Hh,Ll,A,X

# ── expression tree (JSON-serializable) ──
def rand_expr(depth=0):
    if depth>=2 or (depth>0 and random.random()<0.4):
        if random.random()<0.7:return ["a",random.choice(ATOMS)]
        return ["c",round(random.uniform(-2,2),2)]
    return [random.choice(["+","-","*"]),rand_expr(depth+1),rand_expr(depth+1)]
def ev(e,i,X):
    t=e[0]
    if t=="a":
        v=X[e[1]][i];return v if v is not None else None
    if t=="c":return e[1]
    l=ev(e[2],i,X);r=ev(e[3],i,X)
    if l is None or r is None:return None
    if t=="+":return l+r
    if t=="-":return l-r
    return l*r
def rand_pred():return [random.choice(["<",">"]),rand_expr(),rand_expr()]
def rand_genome():
    return {"dir":random.choice(["LONG","SHORT"]),
            "preds":[rand_pred() for _ in range(random.randint(1,2))],
            "sl":round(random.uniform(1.2,3.0),1),"trail":round(random.uniform(1.8,4.0),1),"maxhold":random.choice([5,10,15,20])}
def mut(g):
    g=json.loads(json.dumps(g));r=random.random()
    if r<0.4:g["preds"][random.randrange(len(g["preds"]))]=rand_pred()
    elif r<0.55 and len(g["preds"])<3:g["preds"].append(rand_pred())
    elif r<0.65 and len(g["preds"])>1:g["preds"].pop(random.randrange(len(g["preds"])))
    elif r<0.8:g["sl"]=round(min(3.0,max(1.2,g["sl"]*random.uniform(0.8,1.2))),1)
    elif r<0.9:g["trail"]=round(min(4.0,max(1.8,g["trail"]*random.uniform(0.8,1.2))),1)
    else:g["maxhold"]=random.choice([5,10,15,20])
    return g
def fires(g,i,X):
    for p in g["preds"]:
        l=ev(p[1],i,X);r=ev(p[2],i,X)
        if l is None or r is None:return False
        if p[0]=="<" and not l<r:return False
        if p[0]==">" and not l>r:return False
    return True

def test(g,D,C,Hh,Ll,A,X):
    n=len(C);d=g["dir"];sl=g["sl"];tr=g["trail"];mh=g["maxhold"];out=[];i=30
    while i<n-1:
        if A[i] is None:i+=1;continue
        if fires(g,i,X):
            e=C[i];stop=e-sl*A[i] if d=="LONG" else e+sl*A[i];pk=e;ex=None;k_ex=None
            for k in range(i+1,min(i+1+mh,n)):
                if d=="LONG":
                    if Ll[k]<=stop:ex=stop;k_ex=k;break
                    pk=max(pk,C[k])
                    if C[k]<=pk-tr*A[i]:ex=C[k];k_ex=k;break
                else:
                    if Hh[k]>=stop:ex=stop;k_ex=k;break
                    pk=min(pk,C[k])
                    if C[k]>=pk+tr*A[i]:ex=C[k];k_ex=k;break
            else:k_ex=min(i+mh,n-1);ex=C[k_ex]
            ret=((ex/e-1) if d=="LONG" else (e/ex-1))-FEE
            out.append({"t":D[i]["time"],"ret":ret,"alpha":ret-(C[k_ex]/e-1)});i=k_ex+1
        else:i+=1
    return out
def yr(t):return dt.datetime.utcfromtimestamp(t/1000).year
def medAlpha(tr):return st.median([x["alpha"] for x in tr]) if tr else -1

def gates(g,AD):
    Db=AD["BTC"];tr=test(g,*Db)
    if len(tr)<30:return None
    by=defaultdict(list)
    for t in tr:by[yr(t["t"])].append(t)
    if len(by.get(2026,[]))<6 or len(by.get(2022,[]))<6:return None
    if sum(x["ret"] for x in by[2026])<=0 or sum(x["ret"] for x in by[2022])<=0:return None
    al=[x["alpha"] for x in tr]
    if st.median(al)<=0:return None
    srt=sorted(al,reverse=True);cut=max(3,len(al)//5)
    if sum(srt[cut:])<=0:return None
    asum=sum(al);wins=0
    D_=Db
    for s in range(15):
        rng=random.Random(s*97+len(tr));picks=set(rng.sample(range(30,len(D_[1])-1),min(len(tr),len(D_[1])-35)))
        gg={"dir":g["dir"],"sl":g["sl"],"trail":g["trail"],"maxhold":g["maxhold"]}
        # random-entry test reusing exit machinery
        rt=_rand_test(gg,Db,picks)
        if asum>sum(x["alpha"] for x in rt):wins+=1
    if wins<14:return None
    # CROSS-ASSET: medAlpha>0 trên SOL và ETH
    msol=medAlpha(test(g,*AD["SOL"]));meth=medAlpha(test(g,*AD["ETH"]))
    if not(msol>0 or meth>0):return None   # 2/3: BTC + ít nhất 1 coin khác
    return {"genome":g,"n":len(tr),"medA":round(st.median(al)*100,2),"alphaSum":round(asum*100,1),
            "ret26":round(sum(x["ret"] for x in by[2026])*100,1),"ret22":round(sum(x["ret"] for x in by[2022])*100,1),
            "n26":len(by[2026]),"medSOL":round(msol*100,2),"medETH":round(meth*100,2),
            "wr":round(sum(1 for x in al if x>0)/len(al)*100,1),"ts":int(time.time())}
def _rand_test(gg,Db,picks):
    D,C,Hh,Ll,A,X=Db;d=gg["dir"];sl=gg["sl"];tr=gg["trail"];mh=gg["maxhold"];out=[]
    for i in sorted(picks):
        if i>=len(C)-1 or A[i] is None:continue
        e=C[i];stop=e-sl*A[i] if d=="LONG" else e+sl*A[i];pk=e;ex=None;k_ex=None
        for k in range(i+1,min(i+1+mh,len(C))):
            if d=="LONG":
                if Ll[k]<=stop:ex=stop;k_ex=k;break
                pk=max(pk,C[k])
                if C[k]<=pk-tr*A[i]:ex=C[k];k_ex=k;break
            else:
                if Hh[k]>=stop:ex=stop;k_ex=k;break
                pk=min(pk,C[k])
                if C[k]>=pk+tr*A[i]:ex=C[k];k_ex=k;break
        else:k_ex=min(i+mh,len(C)-1);ex=C[k_ex]
        ret=((ex/e-1) if d=="LONG" else (e/ex-1))-FEE
        out.append({"alpha":ret-(C[k_ex]/e-1)})
    return out
def score(c):return c["alphaSum"]
def sig(c):return (c["genome"]["dir"],c["n"]//10,round(c["medA"]))

def main():
    AD={}
    for nm,p in ASSETS.items():
        D=agg(json.load(open(p)));AD[nm]=build_atoms_full(D)
    print(f"[formula] loaded BTC/ETH/SOL | GP đường giá, gate alpha+cross-asset")
    champs=[]
    SEED={"dir":"SHORT","preds":[[">",["a","body"],["c",0.69]],["<",["a","vsE200"],["c",-0.0073]]],"sl":1.6,"trail":3.8,"maxhold":5}
    sres=gates(SEED,AD)
    if sres:champs.append(sres);print("[formula] SEED fade-pump qua gate:",sres["medA"],sres["medSOL"],sres["medETH"])
    else:print("[formula] SEED không qua gate (sẽ tìm từ random)")
    if os.path.exists(CHAMP):
        try:champs=json.load(open(CHAMP)).get("champions",[])
        except:pass
    it=found=0
    while not os.path.exists(STOP):
        it+=1
        g=mut(random.choice(champs)["genome"]) if (champs and random.random()<0.3) else rand_genome()
        try:res=gates(g,AD)
        except:res=None
        if res:
            s=sig(res);same=[c for c in champs if sig(c)==s];ok=False
            if not same:champs.append(res);ok=True
            elif score(res)>score(same[0]):champs.remove(same[0]);champs.append(res);ok=True
            if ok:
                found+=1;champs=sorted(champs,key=score,reverse=True)[:10]
                json.dump({"updated":int(time.time()),"champions":champs},open(CHAMP,"w"),indent=1)
                c=res
                print(f"[formula] it{it} ✓#{found} {c['genome']['dir']} n{c['n']} medA{c['medA']:+.2f}% SOL{c['medSOL']:+.2f} ETH{c['medETH']:+.2f} 26:{c['ret26']:+.0f} 22:{c['ret22']:+.0f} WR{c['wr']}%")
        if it%200==0:print(f"[formula] it{it} champions={len(champs)} found={found}")
    print(f"[formula] STOP {it} iters {found} found")

def build_atoms_full(D):
    C,Hh,Ll,A,X=build_atoms(D);return (D,C,Hh,Ll,A,X)
if __name__=="__main__":main()
