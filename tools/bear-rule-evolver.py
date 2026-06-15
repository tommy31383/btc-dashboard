#!/usr/bin/env python3
"""
bear-rule-evolver.py — daemon loop vô hạn: khám phá rule entry MỚI (SHORT đỉnh +
LONG đáy) từ feature library, backtest, qua CỔNG chống-mirage, giữ champion.
Bài học: chống in-sample fit (OOS), concentration (drop-top-winners), long-beta
(beat B&H + EMA200-proxy theo SHARPE risk-adjusted, không compound thô).
Chạy: nohup python3 tools/bear-rule-evolver.py > tools/bear-evolver.log 2>&1 &
Dừng: touch tools/bear-evolver-STOP
"""
import json, os, random, math, time, datetime as dt
from collections import defaultdict

HERE=os.path.dirname(os.path.abspath(__file__))
CACHE=os.path.join(HERE,"..",".cache","binance-5m-7y.json")
CHAMP=os.path.join(HERE,"bear-evolver-champions.json")
STOP=os.path.join(HERE,"bear-evolver-STOP")
FEE=0.0008
random.seed()

# ── data ──
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
    E50=ema(C,50);E200=ema(C,200);R=rsi(C);K=stochk(C)
    tr=[0.0]*n
    for i in range(1,n):tr[i]=max(Hh[i]-Ll[i],abs(Hh[i]-C[i-1]),abs(Ll[i]-C[i-1]))
    A=[None]*n;a=sum(tr[1:15])/14;A[14]=a
    for i in range(15,n):a=(a*13+tr[i])/14;A[i]=a
    V20=sma(Vv,20)
    F={k:[None]*n for k in ["consDown","consUp","lowWick","upWick","body","posRange30","dropFrom20H","riseFrom20L","volRatio","atrPct","vsE50","vsE200","e200slope","rsi","stochK","bbPctB"]}
    bbm=sma(C,20)
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
            hh=max(Hh[i-30:i+1]);ll=min(Ll[i-30:i+1])
            F["posRange30"][i]=(C[i]-ll)/(hh-ll)*100 if hh>ll else 50
        if i>=20:
            hh=max(Hh[i-20:i+1]);ll=min(Ll[i-20:i+1])
            F["dropFrom20H"][i]=(C[i]/hh-1)*100;F["riseFrom20L"][i]=(C[i]/ll-1)*100
            if V20[i]:F["volRatio"][i]=Vv[i]/V20[i]
        if bbm[i]:
            sd=(sum((C[k]-bbm[i])**2 for k in range(i-19,i+1))/20)**0.5 or 1
            F["bbPctB"][i]=(C[i]-(bbm[i]-2*sd))/(4*sd)*100
    return C,Hh,Ll,A,F

FEATS=["consDown","consUp","lowWick","upWick","body","posRange30","dropFrom20H","riseFrom20L","volRatio","atrPct","vsE50","vsE200","e200slope","rsi","stochK","bbPctB"]

# ── genome ──
def rand_thr(f,F):
    vals=[x for x in F[f] if x is not None]
    if not vals:return 0
    return round(random.choice(vals),2)
def rand_genome(F):
    d=random.choice(["LONG","SHORT"])
    nc=random.randint(1,3)
    conds=[]
    for _ in range(nc):
        f=random.choice(FEATS);op=random.choice(["<",">"]);conds.append([f,op,rand_thr(f,F)])
    return {"dir":d,"conds":conds,"sl":round(random.uniform(1.2,3.0),1),
            "trail":round(random.uniform(1.8,4.0),1),"maxhold":random.choice([10,15,20,30,45])}
def mutate(g,F):
    g=json.loads(json.dumps(g))
    r=random.random()
    if r<0.3 and g["conds"]:
        c=random.choice(g["conds"]);c[2]=round(c[2]*random.uniform(0.7,1.3),2)
    elif r<0.5:
        f=random.choice(FEATS);g["conds"].append([f,random.choice(["<",">"]),rand_thr(f,F)])
        g["conds"]=g["conds"][:3]
    elif r<0.65 and len(g["conds"])>1:
        g["conds"].pop(random.randrange(len(g["conds"])))
    elif r<0.8:g["sl"]=round(min(3.0,max(1.2,g["sl"]*random.uniform(0.8,1.2))),1)
    elif r<0.9:g["trail"]=round(min(4.0,max(1.8,g["trail"]*random.uniform(0.8,1.2))),1)
    else:g["maxhold"]=random.choice([10,15,20,30,45])
    return g

# ── backtest ──
def test(g,C,Hh,Ll,A,F):
    n=len(C);trades=[];eq_d=[0.0]*n;i=200;d=g["dir"]
    def ok(i):
        for f,op,thr in g["conds"]:
            v=F[f][i]
            if v is None:return False
            if op=="<" and not v<thr:return False
            if op==">" and not v>thr:return False
        return True
    while i<n-1:
        if A[i] is None:i+=1;continue
        if ok(i):
            entry=C[i];atr=A[i]
            if d=="LONG":stop=entry-g["sl"]*atr;peak=entry
            else:stop=entry+g["sl"]*atr;peak=entry
            ex=None;k_ex=None;expx=None
            for k in range(i+1,min(i+1+g["maxhold"],n)):
                if d=="LONG":
                    if Ll[k]<=stop:expx=stop;k_ex=k;break
                    peak=max(peak,C[k])
                    if C[k]<=peak-g["trail"]*atr:expx=C[k];k_ex=k;break
                else:
                    if Hh[k]>=stop:expx=stop;k_ex=k;break
                    peak=min(peak,C[k])
                    if C[k]>=peak+g["trail"]*atr:expx=C[k];k_ex=k;break
            else:
                k_ex=min(i+g["maxhold"],n-1);expx=C[k_ex]
            ret=((expx/entry-1) if d=="LONG" else (entry/expx-1))-FEE
            trades.append({"t":i,"ret":ret})
            # FIX: daily M2M equity THẬT (đổi giá từng ngày theo chiều), comparable B&H.
            for kk in range(i+1,k_ex+1):
                dr=(C[kk]/C[kk-1]-1) if d=="LONG" else (C[kk-1]/C[kk]-1)
                eq_d[kk]+=dr
            eq_d[i+1]-=FEE  # phí vào ở ngày đầu
            i=k_ex+1
        else:i+=1
    return trades,eq_d

def sharpe(rets):
    r=[x for x in rets]
    if len(r)<2:return 0
    m=sum(r)/len(r);sd=(sum((x-m)**2 for x in r)/len(r))**0.5
    return m/sd*math.sqrt(365) if sd>1e-9 else 0

def benchmarks(C):
    bh=[(C[i]/C[i-1]-1) for i in range(1,len(C))]
    # EMA200-long proxy: long khi close>EMA200d else flat
    E=ema(C,200);px=[0.0]*len(C)
    for i in range(1,len(C)):
        if E[i-1] and C[i-1]>E[i-1]:px[i]=C[i]/C[i-1]-1
    return sharpe(bh),sharpe(px[1:])

def years(D):return [dt.datetime.utcfromtimestamp(b["time"]/1000).year for b in D]

def gates(g,trades,eq_d,D,F,bhS,pxS):
    if len(trades)<25:return None
    rets=[t["ret"] for t in trades]
    # G1 drop-top-3-winners còn dương (chống concentration)
    srt=sorted(rets,reverse=True);drop3=srt[3:]
    if sum(drop3)<=0:return None
    # G2 SHARPE M2M thật > B&H và > EMA200-proxy (alpha không beta)
    ruleS=sharpe([eq_d[i] for i in range(1,len(eq_d))])
    if not(ruleS>bhS and ruleS>pxS):return None
    # G3 BEAR gate: phải DƯƠNG trong giai đoạn bear (close<EMA200d) — giết long-beta,
    #    đúng focus "tìm edge ở bear nơi rule cũ phế".
    bear_rets=[t["ret"] for t in trades if (F["vsE200"][t["t"]] is not None and F["vsE200"][t["t"]]<0)]
    if len(bear_rets)<5 or sum(bear_rets)<=0:return None
    # per-year stability ≥60%
    yr=defaultdict(list);Y=years(D)
    for t in trades:yr[Y[t["t"]]].append(t["ret"])
    posY=sum(1 for y in yr if sum(yr[y])>0)
    if len(yr)<4 or posY/len(yr)<0.6:return None
    if len(trades)/max(1,len(yr))<3:return None  # min entries/năm
    # OOS walk-forward: 2 nửa thời gian cùng dương
    mid=len(D)//2
    h1=[t["ret"] for t in trades if t["t"]<mid];h2=[t["ret"] for t in trades if t["t"]>=mid]
    if not h1 or not h2 or sum(h1)<=0 or sum(h2)<=0:return None
    w=sum(1 for r in rets if r>0)
    return {"genome":g,"n":len(trades),"wr":round(w/len(trades)*100,1),
            "sumRet":round(sum(rets)*100,1),"sharpe":round(ruleS,2),
            "stab":f"{posY}/{len(yr)}","drop3":round(sum(drop3)*100,1),
            "bearRet":round(sum(bear_rets)*100,1),"nBear":len(bear_rets),
            "byYear":{y:round(sum(yr[y])*100,1) for y in sorted(yr)},
            "ts":int(time.time())}

# score ưu tiên: bear-performance × sharpe × stability (KHÔNG dùng compound thô)
def score(c):return c["bearRet"]*c["sharpe"]*(int(c["stab"].split("/")[0]))
# dedup theo HÀNH VI THẬT (dir + per-year profile bucket 10%) → điều kiện non-binding
# / jitter threshold cho cùng kết quả sẽ collapse; pool ép 10 rule KHÁC HÀNH VI thật.
def sig(c):
    return (c["genome"]["dir"], frozenset(f for f,_,_ in c["genome"]["conds"]))

def main():
    print(f"[evolver] loading {CACHE}")
    D=agg(json.load(open(CACHE)))
    C,Hh,Ll,A,F=build(D)
    bhS,pxS=benchmarks(C)
    print(f"[evolver] {len(D)} daily bars | B&H Sharpe {bhS:.2f} | EMA200-proxy Sharpe {pxS:.2f}")
    champs=[]
    if os.path.exists(CHAMP):
        try:champs=json.load(open(CHAMP)).get("champions",[])
        except:pass
    MAXC=10;it=0;found=0
    while not os.path.exists(STOP):
        it+=1
        # Tăng exploration: 35% mutate champion (refine) / 65% random (tìm pattern MỚI).
        # → loop không kẹt jitter 1 rule, liên tục thử combo feature khác.
        if champs and random.random()<0.35:
            g=mutate(random.choice(champs)["genome"],F)
        else:
            g=rand_genome(F)
        trades,eq_d=test(g,C,Hh,Ll,A,F)
        res=gates(g,trades,eq_d,D,F,bhS,pxS)
        if res:
            s=sig(res)
            same=[c for c in champs if sig(c)==s]
            improved=False
            if not same:
                champs.append(res);improved=True
            elif score(res)>score(same[0]):  # cùng cấu trúc → giữ bản tốt hơn
                champs.remove(same[0]);champs.append(res);improved=True
            if improved:
                found+=1
                champs=sorted(champs,key=score,reverse=True)[:MAXC]
                json.dump({"updated":int(time.time()),"bhSharpe":round(bhS,2),"pxSharpe":round(pxS,2),"champions":champs},open(CHAMP,"w"),indent=1)
                c=res
                print(f"[evolver] it{it} ✓CHAMP #{found} {c['genome']['dir']} n{c['n']} WR{c['wr']}% sum{c['sumRet']:+.0f}% bear{c['bearRet']:+.0f}%(n{c['nBear']}) Sh{c['sharpe']} stab{c['stab']} | {len(c['genome']['conds'])}cond")
        if it%2000==0:print(f"[evolver] it{it} | champions={len(champs)} found={found}")
    print(f"[evolver] STOP after {it} iters, {found} champions found")

if __name__=="__main__":main()
