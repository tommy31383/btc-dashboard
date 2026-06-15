#!/usr/bin/env python3
"""
bear-turning-evolver.py — loop vô hạn TÌM ĐÁY/ĐỈNH bear (focus 2026, validate chéo 2022).
Mục tiêu: rule (SHORT đỉnh + LONG đáy) có ALPHA THẬT trong bear, KHÔNG beta trá hình.
Gate (rút từ bài học upWick = beta medAlpha=−fee):
  - 🔒 RETURN 2026 > 0  VÀ  RETURN 2022 > 0   (2 bear độc lập → general, chống overfit 1 năm)
  - 🔒 medAlpha > 0  (alpha=ret−hold cùng window; mỗi lệnh phải BEAT cầm-im, không chỉ ăn fee)
  - 🔒 drop-top-20% N theo alpha vẫn dương (chống concentration)
  - 🔒 beat RANDOM-entry alpha ≥ pct90 (cùng N, cùng exit, 20 seed)
  - n_2026 ≥ 6 và n_2022 ≥ 6 (đủ mẫu mỗi bear)
Chạy: nohup python3 tools/bear-turning-evolver.py > tools/bear-turning.log 2>&1 &
Dừng: touch tools/bear-turning-STOP
"""
import json,os,random,time,datetime as dt,statistics as st
from collections import defaultdict
HERE=os.path.dirname(os.path.abspath(__file__))
CACHE=os.path.join(HERE,"..",".cache","binance-5m-7y.json")
CHAMP=os.path.join(HERE,"bear-turning-champions.json")
STOP=os.path.join(HERE,"bear-turning-STOP")
FEE=0.0008; random.seed()

def agg(b5,h=24):
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
def sma(x,p):
    o=[None]*len(x)
    for i in range(p-1,len(x)):o[i]=sum(x[i-p+1:i+1])/p
    return o
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
def stochk(c,rp=14,sp=14,ks=3):
    r=rsi(c,rp);n=len(c);rk=[None]*n
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

def build(D):
    n=len(D);C=[b["close"] for b in D];O=[b["open"] for b in D];Hh=[b["high"] for b in D];Ll=[b["low"] for b in D];Vv=[b["vol"] for b in D]
    E50=ema(C,50);E200=ema(C,200);R=rsi(C);K=stochk(C);bbm=sma(C,20);V20=sma(Vv,20)
    tr=[0.0]*n
    for i in range(1,n):tr[i]=max(Hh[i]-Ll[i],abs(Hh[i]-C[i-1]),abs(Ll[i]-C[i-1]))
    A=[None]*n;a=sum(tr[1:15])/14;A[14]=a
    for i in range(15,n):a=(a*13+tr[i])/14;A[i]=a
    keys=["consDown","consUp","lowWick","upWick","body","posRange30","dropFrom20H","riseFrom20L","volRatio","atrPct","vsE50","vsE200","e200slope","rsi","stochK","bbPctB"]
    F={k:[None]*n for k in keys}
    for i in range(n):
        F["rsi"][i]=R[i];F["stochK"][i]=K[i]
        if A[i]:F["atrPct"][i]=A[i]/C[i]*100
        if E50[i]:F["vsE50"][i]=(C[i]/E50[i]-1)*100
        if E200[i]:
            F["vsE200"][i]=(C[i]/E200[i]-1)*100
            if i>=5 and E200[i-5]:F["e200slope"][i]=(E200[i]/E200[i-5]-1)*100
        rb=Hh[i]-Ll[i] or 1
        F["lowWick"][i]=(min(O[i],C[i])-Ll[i])/rb*100
        F["upWick"][i]=(Hh[i]-max(O[i],C[i]))/rb*100
        F["body"][i]=(C[i]-O[i])/rb*100
        cd=cu=0;j=i
        while j>0 and C[j]<C[j-1]:cd+=1;j-=1
        j=i
        while j>0 and C[j]>C[j-1]:cu+=1;j-=1
        F["consDown"][i]=cd;F["consUp"][i]=cu
        if i>=30:
            hh=max(Hh[i-30:i+1]);ll=min(Ll[i-30:i+1]);F["posRange30"][i]=(C[i]-ll)/(hh-ll)*100 if hh>ll else 50
        if i>=20:
            hh=max(Hh[i-20:i+1]);ll=min(Ll[i-20:i+1])
            F["dropFrom20H"][i]=(C[i]/hh-1)*100;F["riseFrom20L"][i]=(C[i]/ll-1)*100
            if V20[i]:F["volRatio"][i]=Vv[i]/V20[i]
        if bbm[i]:
            sd=(sum((C[k]-bbm[i])**2 for k in range(i-19,i+1))/20)**0.5 or 1
            F["bbPctB"][i]=(C[i]-(bbm[i]-2*sd))/(4*sd)*100
    return C,Hh,Ll,A,F,keys

FEATS=["consDown","consUp","lowWick","upWick","body","posRange30","dropFrom20H","riseFrom20L","volRatio","atrPct","vsE50","vsE200","e200slope","rsi","stochK","bbPctB"]
def rand_thr(f,F):
    v=[x for x in F[f] if x is not None];return round(random.choice(v),2) if v else 0
def rand_genome(F):
    return {"dir":random.choice(["LONG","SHORT"]),
            "conds":[[ (f:=random.choice(FEATS)),random.choice(["<",">"]),rand_thr(f,F)] for _ in range(random.randint(1,3))],
            "sl":round(random.uniform(1.2,3.0),1),"trail":round(random.uniform(1.8,4.0),1),"maxhold":random.choice([5,10,15,20,30])}
def mutate(g,F):
    g=json.loads(json.dumps(g));r=random.random()
    if r<0.3 and g["conds"]:c=random.choice(g["conds"]);c[2]=round(c[2]*random.uniform(0.7,1.3),2)
    elif r<0.5:f=random.choice(FEATS);g["conds"].append([f,random.choice(["<",">"]),rand_thr(f,F)]);g["conds"]=g["conds"][:3]
    elif r<0.65 and len(g["conds"])>1:g["conds"].pop(random.randrange(len(g["conds"])))
    elif r<0.8:g["sl"]=round(min(3.0,max(1.2,g["sl"]*random.uniform(0.8,1.2))),1)
    elif r<0.9:g["trail"]=round(min(4.0,max(1.8,g["trail"]*random.uniform(0.8,1.2))),1)
    else:g["maxhold"]=random.choice([5,10,15,20,30])
    return g

def test_sig(D,C,Hh,Ll,A,sigfn,d,sl,tr,mh):
    n=len(C);out=[];i=20
    while i<n-1:
        if A[i] is None:i+=1;continue
        if sigfn(i):
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
            hold=C[k_ex]/e-1  # beta benchmark = cầm BTC cùng window
            out.append({"t":D[i]["time"],"ret":ret,"alpha":ret-hold});i=k_ex+1
        else:i+=1
    return out

def gfn(g,F):
    cs=g["conds"]
    def f(i):
        for ft,op,thr in cs:
            v=F[ft][i]
            if v is None:return False
            if op=="<" and not v<thr:return False
            if op==">" and not v>thr:return False
        return True
    return f

def yr(t):return dt.datetime.utcfromtimestamp(t/1000).year
def gates(g,D,C,Hh,Ll,A,F):
    tr=test_sig(D,C,Hh,Ll,A,gfn(g,F),g["dir"],g["sl"],g["trail"],g["maxhold"])
    if len(tr)<20:return None
    by=defaultdict(list)
    for t in tr:by[yr(t["t"])].append(t)
    t26=by.get(2026,[]);t22=by.get(2022,[])
    if len(t26)<6 or len(t22)<6:return None
    r26=sum(x["ret"] for x in t26);r22=sum(x["ret"] for x in t22)
    if r26<=0 or r22<=0:return None                       # 🔒 2 bear độc lập cùng dương
    alphas=[x["alpha"] for x in tr]
    if st.median(alphas)<=0:return None                   # 🔒 medAlpha>0 (beat hold, không chỉ fee)
    srt=sorted(alphas,reverse=True);cut=max(3,len(alphas)//5)
    if sum(srt[cut:])<=0:return None                      # 🔒 drop-top-20% alpha vẫn dương
    # 🔒 random-null: alpha sum ≥ pct90 random-entry cùng N
    asum=sum(alphas);wins=0
    for seed in range(20):
        rng=random.Random(seed*131+len(tr))
        picks=set(rng.sample(range(20,len(D)-1),min(len(tr),len(D)-25)))
        rt=test_sig(D,C,Hh,Ll,A,lambda i:i in picks,g["dir"],g["sl"],g["trail"],g["maxhold"])
        if asum>sum(x["alpha"] for x in rt):wins+=1
    if wins<18:return None
    w=sum(1 for x in alphas if x>0)
    return {"genome":g,"n":len(tr),"alphaSum":round(asum*100,1),"medAlpha":round(st.median(alphas)*100,3),
            "ret2026":round(r26*100,1),"ret2022":round(r22*100,1),"n26":len(t26),"n22":len(t22),
            "wr":round(w/len(tr)*100,1),"randPct":round(wins/20*100),"ts":int(time.time())}

def score(c):return c["alphaSum"]*(1 if c["ret2026"]>0 and c["ret2022"]>0 else 0)
def sig(c):return (c["genome"]["dir"],frozenset(f for f,_,_ in c["genome"]["conds"]))

def main():
    D=agg(json.load(open(CACHE)));C,Hh,Ll,A,F,_=build(D)
    print(f"[turning] {len(D)} daily bars | tìm đáy/đỉnh bear, gate alpha 2026+2022")
    champs=[]
    if os.path.exists(CHAMP):
        try:champs=json.load(open(CHAMP)).get("champions",[])
        except:pass
    it=found=0
    while not os.path.exists(STOP):
        it+=1
        g=mutate(random.choice(champs)["genome"],F) if (champs and random.random()<0.35) else rand_genome(F)
        res=gates(g,D,C,Hh,Ll,A,F)
        if res:
            s=sig(res);same=[c for c in champs if sig(c)==s]
            ok=False
            if not same:champs.append(res);ok=True
            elif score(res)>score(same[0]):champs.remove(same[0]);champs.append(res);ok=True
            if ok:
                found+=1;champs=sorted(champs,key=score,reverse=True)[:10]
                json.dump({"updated":int(time.time()),"champions":champs},open(CHAMP,"w"),indent=1)
                c=res;cs=' AND '.join(f'{f}{op}{t}' for f,op,t in g["conds"])
                print(f"[turning] it{it} ✓ #{found} {g['dir']} n{c['n']} medA{c['medAlpha']:+.2f}% alphaSum{c['alphaSum']:+.0f}% 26:{c['ret2026']:+.0f}%(n{c['n26']}) 22:{c['ret2022']:+.0f}%(n{c['n22']}) rnd{c['randPct']} | {cs}")
        if it%500==0:print(f"[turning] it{it} champions={len(champs)} found={found}")
    print(f"[turning] STOP {it} iters {found} found")
if __name__=="__main__":main()
