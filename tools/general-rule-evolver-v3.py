#!/usr/bin/env python3
"""
EVOLVER v3 — v2 (genetic+parallel+structural BTC/ETH) + 3 nang cap:
  1. WALK-FORWARD: fitness = TRAIN(2019-23) Calmar; promote chi khi TEST(2024-26) khong te hon
     -> bo bull-bias full-period (audit nghi overfit train).
  2. PER-SLEEVE RISK: GA tune risk rieng risk4/risk1/riske (thay uniform 0.04).
  3. CORR-AWARE: per-asset margin cap (BTC 4h+1h chung cap_btc, ETH cap_eth)
     -> fix double-count (audit: 1h+4h cung BTC = leverage tra hinh, corr +0.58).
Reuse gen functions da test cua v2. Universe BTC/ETH (Tommy chot, khong SOL).
3 cong giu: honest constraint + OOS walk-forward + robustness +/-1. Auto-commit champion.
Dung: touch tools/evolver-STOP
"""
import importlib.util, json, subprocess, datetime, random, os, sys
from concurrent.futures import ProcessPoolExecutor
import warnings; warnings.filterwarnings('ignore')
from collections import defaultdict

TOOLS=os.path.dirname(os.path.abspath(__file__)); REPO=os.path.dirname(TOOLS)
V2_PATH=os.path.join(TOOLS,"general-rule-evolver-v2.py")
HOF=os.path.join(TOOLS,"evolver-v3-hof.json")
REPORT=os.path.join(TOOLS,"evolver-v3-report.md")
LOG=os.path.join(TOOLS,"evolver-v3-log.jsonl")
HEART=os.path.join(TOOLS,"evolver-v3-heartbeat.txt")
STOP=os.path.join(TOOLS,"evolver-STOP")
V2_SEED=os.path.join(TOOLS,"evolver-v2-hof.json")
CAPITAL=100000; LEV=10
TRAIN=[2019,2020,2021,2022,2023]; TEST=[2024,2025,2026]

_V2=None
def get_v2():
    global _V2
    if _V2 is None:
        spec=importlib.util.spec_from_file_location("evolver_v2",V2_PATH)
        _V2=importlib.util.module_from_spec(spec); spec.loader.exec_module(_V2)
    return _V2

def build_trades(g):
    V2=get_v2(); AL=V2.get_al(); allt=[]
    if g["use_btc4h"]: allt+=V2.gen4(AL,AL.P4,g,"BTC4h",False)
    if g["use_btc1h"]: allt+=V2.gen1(AL,g)
    if g["use_eth"]:   allt+=V2.gen4(AL,AL.PE,g,"ETH4h",True)
    return allt

def risk_of(g,tag):
    if "ETH" in tag: return g["riske"]
    if tag=="BTC1h": return g["risk1"]
    return g["risk4"]

def honest_resim_v3(allt,g):
    if not allt: return None
    allt=sorted(allt,key=lambda x:x[0])
    eq=CAPITAL; mu_btc=0.0; mu_eth=0.0; openp=[]
    ev=sorted(set([x[0] for x in allt]+[x[1] for x in allt]))
    ent=defaultdict(list)
    for x in allt: ent[x[0]].append(x)
    peak=CAPITAL; maxdd=0; yr_pnl=defaultdict(float); yr_n=defaultdict(int); yr_start={}
    cap_btc=g["cap_btc"]; cap_eth=g["cap_eth"]
    for ms in ev:
        still=[]
        for (xm,marg,ret,asset) in openp:
            if xm<=ms:
                pnl=ret*marg*LEV-0.0006*marg; eq+=pnl
                if asset=="BTC": mu_btc-=marg
                else: mu_eth-=marg
                d=datetime.datetime.utcfromtimestamp(xm/1000); yr_pnl[d.year]+=pnl; yr_n[d.year]+=1
            else: still.append((xm,marg,ret,asset))
        openp=still
        if eq>peak: peak=eq
        dd=(peak-eq)/peak*100
        if dd>maxdd: maxdd=dd
        for (em,xm,ret,vs,tag) in ent.get(ms,[]):
            d=datetime.datetime.utcfromtimestamp(em/1000)
            if d.year not in yr_start: yr_start[d.year]=eq
            asset="ETH" if "ETH" in tag else "BTC"
            marg=risk_of(g,tag)*eq*vs
            mu_a=mu_eth if asset=="ETH" else mu_btc
            cap_a=cap_eth if asset=="ETH" else cap_btc
            # per-asset cap (corr-aware) + global cap
            if marg>0 and mu_a+marg<=cap_a*eq and (mu_btc+mu_eth+marg)<=eq:
                if asset=="BTC": mu_btc+=marg
                else: mu_eth+=marg
                openp.append((xm,marg,ret,asset))
    for (xm,marg,ret,asset) in openp:
        pnl=ret*marg*LEV-0.0006*marg; eq+=pnl
        d=datetime.datetime.utcfromtimestamp(xm/1000); yr_pnl[d.year]+=pnl; yr_n[d.year]+=1
    years=sorted(yr_n.keys())
    if not years: return None
    span=(ev[-1]-ev[0])/(365.25*24*3600*1000)
    cagr=((eq/CAPITAL)**(1/span)-1)*100 if span>0 and eq>0 else -100
    yr_roi={y:(yr_pnl[y]/yr_start.get(y,CAPITAL)*100 if yr_start.get(y,CAPITAL)>0 else 0) for y in years}
    min_n=min((yr_n[y] for y in years if y!=2026),default=0)
    return dict(equity=eq,cagr=cagr,maxdd=maxdd,yr_n=dict(yr_n),yr_roi=yr_roi,
                min_n=min_n,n2026=yr_n.get(2026,0),worst=min(yr_roi.values()) if yr_roi else -100,
                pos_years=sum(1 for y in years if yr_roi[y]>0),nyears=len(years))

def eval_genome(g):
    try: return honest_resim_v3(build_trades(g),g)
    except Exception: return None

def seg(m,years):
    if m is None: return -100
    gg=1.0
    for y in years:
        if y in m["yr_roi"]: gg*=(1+m["yr_roi"][y]/100)
    sp=sum(1.0 if y!=2026 else 0.42 for y in years if y in m["yr_roi"])
    return (gg**(1/sp)-1)*100 if sp>0 and gg>0 else -100

def fitness(m):
    """WALK-FORWARD: train Calmar, hard constraints tren FULL"""
    if m is None: return -1e9
    if m["maxdd"]>25 or m["min_n"]<150 or m["n2026"]<60 or m["worst"]<-15: return -1e9
    return seg(m,TRAIN)/max(m["maxdd"],3.0)

# ---- genome ----
RISKS=[0.02,0.03,0.04,0.05,0.06,0.08]; CAPS=[0.4,0.5,0.6,0.8,1.0]
BOOLS=["use_btc4h","use_btc1h","use_eth","exit_ema20","f_funding","f_rsi","f_bear"]
def base_genome():
    V2=get_v2()
    g=dict(json.load(open(V2_SEED))["champion"]["params"])
    # convert uniform → per-sleeve risk + per-asset cap
    r=g.pop("risk",0.04); c=g.pop("cap",1.0)
    g.update(risk4=r,risk1=r,riske=r,cap_btc=c,cap_eth=c)
    for b in BOOLS: g.setdefault(b,True)
    return g
def mutate(g):
    V2=get_v2(); AL=V2.get_al(); g=dict(g); k=random.random()
    if k<0.20:
        b=random.choice(BOOLS); g[b]=not g[b]
        if not(g["use_btc4h"] or g["use_btc1h"] or g["use_eth"]): g["use_btc4h"]=True
    elif k<0.45:
        key=random.choice(["risk4","risk1","riske"]); g[key]=random.choice(RISKS)
    elif k<0.60:
        key=random.choice(["cap_btc","cap_eth"]); g[key]=random.choice(CAPS)
    else:
        key=random.choice(list(AL.STEPS.keys())); g[key]=random.choice(AL.STEPS[key])
    return g
def crossover(a,b):
    c=dict(a)
    for k in a:
        if k in b and random.random()<0.5: c[k]=b[k]
    if not(c["use_btc4h"] or c["use_btc1h"] or c["use_eth"]): c["use_btc4h"]=True
    return c
def robustness(g,base_train_calmar):
    V2=get_v2(); AL=V2.get_al(); frag=0; tested=0
    keys=["risk4","risk1","riske","cap_btc","cap_eth"]+list(AL.STEPS.keys())
    pools={**{k:RISKS for k in["risk4","risk1","riske"]},**{k:CAPS for k in["cap_btc","cap_eth"]},**AL.STEPS}
    for k in keys:
        if k not in g or k not in pools: continue
        vals=pools[k]
        try: idx=vals.index(g[k])
        except ValueError: continue
        for di in(-1,1):
            j=idx+di
            if 0<=j<len(vals):
                pp=dict(g); pp[k]=vals[j]; mm=eval_genome(pp); tested+=1
                tc=seg(mm,TRAIN)/max(mm["maxdd"],3) if mm else -1e9
                if mm is None or mm["maxdd"]>25 or tc<base_train_calmar*0.6: frag+=1
    return frag/tested if tested else 1.0

def git_commit(idx,m,tcal,tecal,frag):
    msg=("evolver-v3 champion #%d: trainCalmar %.2f CAGR %.0f%% DD %.0f%% n%d testCAGR %.0f%% (walk-forward+per-sleeve-risk+corr-aware)\n\n"
         "3-gate: honest + OOS(test not worse) + robustness %.0f%% fragile.\n\n"
         "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"%(idx,tcal,m["cagr"],m["maxdd"],m["min_n"],tecal,frag*100))
    try:
        subprocess.run(["git","add","tools/evolver-v3-hof.json","tools/evolver-v3-report.md"],cwd=REPO,check=True,capture_output=True)
        subprocess.run(["git","commit","-m",msg],cwd=REPO,check=True,capture_output=True)
        r=subprocess.run(["git","push","origin","master"],cwd=REPO,capture_output=True,text=True)
        return "pushed" if r.returncode==0 else "commit-only"
    except subprocess.CalledProcessError: return "git-fail"

if __name__=="__main__":
    get_v2(); random.seed()
    POP=int(os.environ.get("POP","24")); WORKERS=int(os.environ.get("WORKERS","5"))
    GENS=int(os.environ.get("GENS","100000"))
    sys.stderr.write("Evolver-v3 (walk-forward+per-sleeve-risk+corr-aware) start: pop=%d workers=%d\n"%(POP,WORKERS))
    base=base_genome()
    pop=[base]+[mutate(base) for _ in range(POP-1)]
    champ_fit=-1e9; champ_test=-1e9; idx=0
    if os.path.exists(HOF):
        try:
            s=json.load(open(HOF)); pop[0]=s["champion"]["params"]
            champ_fit=s["champion"].get("train_calmar",-1e9); champ_test=s["champion"]["metrics"].get("test_cagr",-1e9); idx=s.get("idx",0)
        except Exception: pass
    if not os.path.exists(REPORT): open(REPORT,"w").write("# Evolver v3 (walk-forward + per-sleeve risk + corr-aware) — champion history\n\n")
    ex=ProcessPoolExecutor(max_workers=WORKERS,initializer=get_v2)
    gen=0
    while gen<GENS:
        if os.path.exists(STOP):
            sys.stderr.write("STOP gen %d, %d champions\n"%(gen,idx)); os.remove(STOP); break
        gen+=1
        try: metrics=list(ex.map(eval_genome,pop))
        except Exception as e:
            sys.stderr.write("gen %d pool err: %s reset\n"%(gen,str(e)[:60]))
            ex.shutdown(wait=False,cancel_futures=True); ex=ProcessPoolExecutor(max_workers=WORKERS,initializer=get_v2)
            pop=[base]+[mutate(base) for _ in range(POP-1)]; continue
        scored=sorted([(fitness(m),pop[i],m) for i,m in enumerate(metrics)],key=lambda x:x[0],reverse=True)
        bf,bg,bm=scored[0]
        with open(LOG,"a") as f: f.write(json.dumps(dict(gen=gen,fit=round(bf,2),cagr=round(bm["cagr"],1) if bm else None,dd=round(bm["maxdd"],1) if bm else None))+"\n")
        with open(HEART,"w") as f: f.write("gen=%d champions=%d pop_best_trainCalmar=%.2f CAGR=%.1f%% DD=%.1f%% @ %s\n"%(gen,idx,bf,bm["cagr"] if bm else 0,bm["maxdd"] if bm else 0,datetime.datetime.utcnow().strftime("%H:%M:%S")))
        if bf>champ_fit and bm is not None:
            tec=seg(bm,TEST)
            if tec>=champ_test*0.98:
                frag=robustness(bg,bf)
                if frag<=0.15:
                    idx+=1; champ_fit=bf; champ_test=tec
                    json.dump(dict(idx=idx,champion=dict(params=bg,train_calmar=bf,
                        metrics=dict(cagr=bm["cagr"],maxdd=bm["maxdd"],min_n=bm["min_n"],test_cagr=tec,
                        train_cagr=seg(bm,TRAIN),yr_roi=bm["yr_roi"],yr_n=bm["yr_n"])),
                        ts=datetime.datetime.utcnow().isoformat()),open(HOF,"w"),indent=2,default=str)
                    sl="".join([s for s,o in[("4",bg["use_btc4h"]),("1",bg["use_btc1h"]),("E",bg["use_eth"])] if o])
                    with open(REPORT,"a") as f:
                        f.write("\n## Champion #%d - gen %d - %s\n- trainCalmar %.2f | CAGR %.1f%% DD %.1f%% n%d | trainCAGR %.0f%% **testCAGR %.0f%%**\n- sleeves[%s] risk(4h=%.2f 1h=%.2f eth=%.2f) cap(btc=%.1f eth=%.1f) | fund=%s rsi=%s bear=%s\n- per-yr: %s\n- params: `%s`\n"%(idx,gen,datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M"),bf,bm["cagr"],bm["maxdd"],bm["min_n"],seg(bm,TRAIN),tec,sl,bg["risk4"],bg["risk1"],bg["riske"],bg["cap_btc"],bg["cap_eth"],bg["f_funding"],bg["f_rsi"],bg["f_bear"]," ".join("%d:%+.0f%%"%(y,bm["yr_roi"].get(y,0)) for y in range(2019,2027)),json.dumps(bg)))
                    st=git_commit(idx,bm,bf,tec,frag)
                    sys.stderr.write("[gen %d] CHAMPION #%d trainCalmar=%.2f CAGR=%.1f%% DD=%.1f%% test=%.1f%% sleeves[%s] -> %s\n"%(gen,idx,bf,bm["cagr"],bm["maxdd"],tec,sl,st))
        elite=[g for _,g,_ in scored[:max(2,POP//6)]]; newpop=list(elite)
        while len(newpop)<POP:
            def tour():
                c=random.sample(scored,min(3,len(scored))); c.sort(key=lambda x:x[0],reverse=True); return c[0][1]
            ch=crossover(tour(),tour())
            if random.random()<0.7: ch=mutate(ch)
            newpop.append(ch)
        pop=newpop
    ex.shutdown(wait=False,cancel_futures=True)
    sys.stderr.write("Evolver-v3 done gen=%d champions=%d\n"%(gen,idx))
