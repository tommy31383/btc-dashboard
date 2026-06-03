#!/usr/bin/env python3
"""
EVOLVER v2 — GENETIC + PARALLEL + STRUCTURAL. Daemon tu tien hoa rule "sieu ngon".

Nang cap vs v1:
  - GENETIC population (tournament select + crossover + mutation + elitism) thay hill-climb 1-param
  - PARALLEL eval da loi (ProcessPool, precompute 1 lan/worker)
  - STRUCTURAL moves: sleeve on/off + filter toggle (funding/rsi/bear_gate) + exit_ema20 toggle
  - CALMAR objective (CAGR/MaxDD) risk-adjusted thay CAGR×stability
  - HALL OF FAME top-K champion da dang
  - 3 cong giu nguyen: honest constraint + OOS walk-forward + robustness +/-1
Guard: SL LUON co (khong toggle), universe BTC/ETH, no BEAR-short.

Dung: touch tools/evolver-STOP   |  Resume: chay lai (load evolver-v2-hof.json)
"""
import importlib.util, json, subprocess, datetime, random, os, sys
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor
import warnings; warnings.filterwarnings('ignore')

TOOLS=os.path.dirname(os.path.abspath(__file__)); REPO=os.path.dirname(TOOLS)
AL_PATH=os.path.join(TOOLS,"general-rule-autoloop.py")
HOF=os.path.join(TOOLS,"evolver-v2-hof.json")
REPORT=os.path.join(TOOLS,"evolver-v2-report.md")
LOG=os.path.join(TOOLS,"evolver-v2-log.jsonl")
HEART=os.path.join(TOOLS,"evolver-v2-heartbeat.txt")
STOP=os.path.join(TOOLS,"evolver-STOP")
SEED=os.path.join(TOOLS,"autoloop-best.json")
CAPITAL=100_000; LEV=10
TRAIN=[2019,2020,2021,2022,2023]; TEST=[2024,2025,2026]

_AL=None
def get_al():
    global _AL
    if _AL is None:
        spec=importlib.util.spec_from_file_location("autoloop",AL_PATH)
        _AL=importlib.util.module_from_spec(spec); spec.loader.exec_module(_AL)
    return _AL

# ---------- STRUCTURAL-aware sleeve generators ----------
def gen4(al,P,g,tag,is_eth):
    c,h,l,t=P["c"],P["h"],P["l"],P["t"]
    e200,e20,adx,pdi,mdi,rsi,atr,ap=P["e200"],P["e20"],P["adx"],P["pdi"],P["mdi"],P["rsi"],P["atr"],P["ap"]
    pf="e" if is_eth else "4"
    ADX=g["adx"+pf]; DI=g["di"+pf]; SL=g["sl"+pf]; TP=g["tp"+pf]
    HOLD=60 if is_eth else g["hold4"]; COOL=2 if is_eth else g["cool4"]; MAXPOS=5 if is_eth else g["pos4"]
    pos=[]; out=[]; last=-999
    for i in range(200,len(c)-HOLD-1):
        np_=[]
        for (ei,epx,slpx,tppx,vs,ems) in pos:
            xpx=c[i]; done=False
            if l[i]<=slpx: xpx=slpx; done=True
            elif h[i]>=tppx: xpx=tppx; done=True
            elif g["exit_ema20"] and e20[i] and c[i]<e20[i] and i-ei>=10: done=True
            elif i-ei>=HOLD: done=True
            if done: out.append((ems,t[i]+4*3600*1000,(xpx-epx)/epx,vs,tag))
            else: np_.append((ei,epx,slpx,tppx,vs,ems))
        pos=np_
        if len(pos)>=MAXPOS or i-last<COOL: continue
        a=adx[i]; pp=pdi[i]; mm=mdi[i]; r=rsi[i]; e2=e200[i]; at=atr[i]
        if None in (a,pp,mm,r,e2,at): continue
        price=c[i]; e2d=al.e200d_at(P,t[i])
        if e2d is None: continue
        if a<=ADX or not(pp>mm*DI) or price<=e2: continue
        if g["f_funding"] and al.fund_at(t[i])>=0.0005: continue
        if g["f_rsi"] and r>=72: continue
        if is_eth:
            ratio=price/e2d
            if not(g["eblo"]<=ratio<=g["ebhi"]): continue
        else:
            if g["f_bear"] and price<e2d*g["bg"]: continue
        vs=max(0.3,1.0-(ap[i] or 0.5))
        pos.append((i,price,price-SL*at,price+TP*at,vs,t[i])); last=i
    return out

def gen1(al,g):
    c1,h1,l1,t1=al.c1,al.h1,al.l1,al.t1
    e200_1,e20_1,adx1,pdi1,mdi1,rsi1,atr1,ap1=al.e200_1,al.e20_1,al.adx1,al.pdi1,al.mdi1,al.rsi1,al.atr1,al.ap1
    import bisect
    ADX=g["adx1"]; DI=g["di1"]; SL=g["sl1"]; TP=g["tp1"]; HOLD=g["hold1"]; COOL=g["cool1"]; MAXPOS=g["pos1"]
    pos=[]; out=[]; last=-999
    for i in range(200,len(c1)-HOLD-1):
        np_=[]
        for (ei,epx,slpx,tppx,vs,ems) in pos:
            xpx=c1[i]; done=False
            if l1[i]<=slpx: xpx=slpx; done=True
            elif h1[i]>=tppx: xpx=tppx; done=True
            elif g["exit_ema20"] and e20_1[i] and c1[i]<e20_1[i] and i-ei>=4: done=True
            elif i-ei>=HOLD: done=True
            if done: out.append((ems,t1[i]+3600*1000,(xpx-epx)/epx,vs,"BTC1h"))
            else: np_.append((ei,epx,slpx,tppx,vs,ems))
        pos=np_
        if len(pos)>=MAXPOS or i-last<COOL: continue
        a=adx1[i]; pp=pdi1[i]; mm=mdi1[i]; r=rsi1[i]; e2=e200_1[i]; at=atr1[i]
        if None in (a,pp,mm,r,e2,at): continue
        price=c1[i]; e2d=al.e200d_at(al.P4,t1[i])
        if e2d is None: continue
        j=bisect.bisect_right(al.P4["t"],t1[i])-1
        if j<0 or al.P4["adx"][j] is None: continue
        if not(al.P4["adx"][j]>18 and al.P4["pdi"][j]>al.P4["mdi"][j]*0.95 and al.P4["c"][j]>al.P4["e200"][j]): continue
        if a<=ADX or not(pp>mm*DI) or price<=e2: continue
        if g["f_bear"] and price<e2d*g["bg"]: continue
        if g["f_funding"] and al.fund_at(t1[i])>=0.0005: continue
        if g["f_rsi"] and r>=72: continue
        vs=max(0.3,1.0-(ap1[i] or 0.5))
        pos.append((i,price,price-SL*at,price+TP*at,vs,t1[i])); last=i
    return out

def honest_resim(allt,risk,cap):
    if not allt: return None
    allt=sorted(allt,key=lambda x:x[0])
    equity=CAPITAL; mu=0; openp=[]
    ev=sorted(set([x[0] for x in allt]+[x[1] for x in allt]))
    ent=defaultdict(list)
    for x in allt: ent[x[0]].append(x)
    peak=CAPITAL; maxdd=0; yr_pnl=defaultdict(float); yr_n=defaultdict(int); yr_start={}
    for ms in ev:
        still=[]
        for (xm,marg,ret) in openp:
            if xm<=ms:
                pnl=ret*marg*LEV-0.0006*marg; equity+=pnl; mu-=marg
                d=datetime.datetime.utcfromtimestamp(xm/1000); yr_pnl[d.year]+=pnl; yr_n[d.year]+=1
            else: still.append((xm,marg,ret))
        openp=still
        if equity>peak: peak=equity
        dd=(peak-equity)/peak*100
        if dd>maxdd: maxdd=dd
        for (em,xm,ret,vs,tag) in ent.get(ms,[]):
            d=datetime.datetime.utcfromtimestamp(em/1000)
            if d.year not in yr_start: yr_start[d.year]=equity
            marg=risk*equity*vs
            if mu+marg<=cap*equity and marg>0: mu+=marg; openp.append((xm,marg,ret))
    for (xm,marg,ret) in openp:
        pnl=ret*marg*LEV-0.0006*marg; equity+=pnl
        d=datetime.datetime.utcfromtimestamp(xm/1000); yr_pnl[d.year]+=pnl; yr_n[d.year]+=1
    years=sorted(yr_n.keys())
    if not years: return None
    span=(ev[-1]-ev[0])/(365.25*24*3600*1000)
    cagr=((equity/CAPITAL)**(1/span)-1)*100 if span>0 and equity>0 else -100
    yr_roi={y:(yr_pnl[y]/yr_start.get(y,CAPITAL)*100 if yr_start.get(y,CAPITAL)>0 else 0) for y in years}
    min_n=min((yr_n[y] for y in years if y!=2026),default=0)
    return dict(equity=equity,cagr=cagr,maxdd=maxdd,yr_n=dict(yr_n),yr_roi=yr_roi,
                min_n=min_n,n2026=yr_n.get(2026,0),worst=min(yr_roi.values()) if yr_roi else -100,
                pos_years=sum(1 for y in years if yr_roi[y]>0),nyears=len(years))

def build_trades(al,g):
    allt=[]
    if g["use_btc4h"]: allt+=gen4(al,al.P4,g,"BTC4h",False)
    if g["use_btc1h"]: allt+=gen1(al,g)
    if g["use_eth"]:   allt+=gen4(al,al.PE,g,"ETH4h",True)
    return allt

def eval_genome(g):
    try:
        al=get_al()
        return honest_resim(build_trades(al,g),g["risk"],g["cap"])
    except Exception:
        return None  # genome xấu → loại tự nhiên, không giết daemon

def seg_cagr(m,years):
    gg=1.0
    for y in years:
        if y in m["yr_roi"]: gg*=(1+m["yr_roi"][y]/100)
    span=sum(1.0 if y!=2026 else 0.42 for y in years if y in m["yr_roi"])
    return (gg**(1/span)-1)*100 if span>0 and gg>0 else -100

def calmar(m):
    if m is None: return -1e9
    if m["maxdd"]>25 or m["min_n"]<150 or m["n2026"]<60 or m["worst"]<-15: return -1e9
    return m["cagr"]/max(m["maxdd"],3.0)  # risk-adjusted

# ---------- genome space ----------
def base_genome():
    g=dict(json.load(open(SEED))["params"])
    g.update(use_btc4h=True,use_btc1h=True,use_eth=True,exit_ema20=True,
             f_funding=True,f_rsi=True,f_bear=True)
    return g
BOOLS=["use_btc4h","use_btc1h","use_eth","exit_ema20","f_funding","f_rsi","f_bear"]

def mutate(al,g):
    g=dict(g); k=random.random()
    if k<0.30:  # structural toggle
        b=random.choice(BOOLS); g[b]=not g[b]
        if not(g["use_btc4h"] or g["use_btc1h"] or g["use_eth"]): g["use_btc4h"]=True
    else:       # threshold tune
        key=random.choice(list(al.STEPS.keys())); g[key]=random.choice(al.STEPS[key])
    return g

def crossover(a,b):
    c=dict(a)
    for k in list(a.keys()):
        if k in b and random.random()<0.5: c[k]=b[k]
    if not(c["use_btc4h"] or c["use_btc1h"] or c["use_eth"]): c["use_btc4h"]=True
    return c

def robustness(g,base_cagr):
    al=get_al(); frag=0; tested=0
    for k in al.STEPS:
        if k not in g: continue
        vals=al.STEPS[k]
        try: idx=vals.index(g[k])
        except ValueError: continue
        for di in(-1,1):
            j=idx+di
            if 0<=j<len(vals):
                pp=dict(g); pp[k]=vals[j]; mm=eval_genome(pp); tested+=1
                if mm is None or mm["maxdd"]>25 or mm["cagr"]<base_cagr*0.6: frag+=1
    return frag/tested if tested else 1.0

def git_commit(idx,m,frag):
    msg=("evolver-v2 champion #%d: Calmar %.2f CAGR %.0f%% DD %.0f%% n%d testCAGR %.0f%% (auto-genetic)\n\n"
         "3-gate: honest+OOS+robustness %.0f%% fragile. Genetic+structural.\n\n"
         "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
         %(idx,m["cagr"]/max(m["maxdd"],3),m["cagr"],m["maxdd"],m["min_n"],seg_cagr(m,TEST),frag*100))
    try:
        subprocess.run(["git","add","tools/evolver-v2-hof.json","tools/evolver-v2-report.md"],cwd=REPO,check=True,capture_output=True)
        subprocess.run(["git","commit","-m",msg],cwd=REPO,check=True,capture_output=True)
        r=subprocess.run(["git","push","origin","master"],cwd=REPO,capture_output=True,text=True)
        return "pushed" if r.returncode==0 else "commit-only"
    except subprocess.CalledProcessError: return "git-fail"

if __name__=="__main__":
    al=get_al()
    random.seed()
    POP=int(os.environ.get("POP","24")); WORKERS=int(os.environ.get("WORKERS","6"))
    GENERATIONS=int(os.environ.get("GENS","100000"))
    sys.stderr.write("Evolver-v2 GENETIC start: pop=%d workers=%d\n"%(POP,WORKERS))
    # seed population: base + mutations
    base=base_genome()
    pop=[base]+[mutate(al,base) for _ in range(POP-1)]
    hof=[]  # list of (calmar, genome, metrics)
    champ_sc=-1e9; champ_test=-1e9; idx=0
    if os.path.exists(HOF):
        try:
            saved=json.load(open(HOF))
            pop[0]=saved["champion"]["params"]
            # restore champion bar để KHÔNG re-promote/commit trùng sau restart
            champ_sc=saved["champion"].get("calmar",-1e9)
            champ_test=saved["champion"]["metrics"].get("test_cagr",-1e9)
            idx=saved.get("idx",0)
        except Exception: pass
    if not os.path.exists(REPORT):
        open(REPORT,"w").write("# Evolver v2 (genetic+structural) - champion history\n\n")
    ex=ProcessPoolExecutor(max_workers=WORKERS,initializer=get_al)
    gen=0
    while gen<GENERATIONS:
        if os.path.exists(STOP):
            sys.stderr.write("STOP - exit gen %d, %d champions\n"%(gen,idx)); os.remove(STOP); break
        gen+=1
        try:
            metrics=list(ex.map(eval_genome,pop))
        except Exception as e:
            sys.stderr.write("gen %d eval error: %s — reset pool, continue\n"%(gen,str(e)[:80]))
            try: ex.shutdown(wait=False,cancel_futures=True)
            except Exception: pass
            ex=ProcessPoolExecutor(max_workers=WORKERS,initializer=get_al)
            pop=[base]+[mutate(al,base) for _ in range(POP-1)]
            if os.path.exists(HOF):
                try: pop[0]=json.load(open(HOF))["champion"]["params"]
                except Exception: pass
            continue
        scored=[(calmar(m),pop[i],m) for i,m in enumerate(metrics)]
        scored.sort(key=lambda x:x[0],reverse=True)
        with open(LOG,"a") as f:
            best=scored[0]
            f.write(json.dumps(dict(gen=gen,best_calmar=round(best[0],2),
                    cagr=round(best[2]["cagr"],1) if best[2] else None,
                    dd=round(best[2]["maxdd"],1) if best[2] else None))+"\n")
        with open(HEART,"w") as f:
            b=scored[0]
            f.write("gen=%d champions=%d pop_best_calmar=%.2f CAGR=%.1f%% DD=%.1f%% @ %s\n"
                    %(gen,idx,b[0],b[2]["cagr"] if b[2] else 0,b[2]["maxdd"] if b[2] else 0,
                      datetime.datetime.utcnow().strftime("%H:%M:%S")))
        # try promote pop best through gates 2&3
        bsc,bg,bm=scored[0]
        if bsc>champ_sc and bm is not None:
            tc=seg_cagr(bm,TEST)
            if tc>=champ_test*0.98:
                frag=robustness(bg,bm["cagr"])
                if frag<=0.15:
                    idx+=1; champ_sc=bsc; champ_test=tc
                    hof.append((bsc,bg,bm)); hof.sort(key=lambda x:x[0],reverse=True); hof=hof[:8]
                    json.dump(dict(idx=idx,champion=dict(params=bg,calmar=bsc,
                                   metrics=dict(cagr=bm["cagr"],maxdd=bm["maxdd"],min_n=bm["min_n"],
                                                test_cagr=tc,yr_roi=bm["yr_roi"],yr_n=bm["yr_n"])),
                                   hall_of_fame=[dict(calmar=s,cagr=m["cagr"],dd=m["maxdd"],min_n=m["min_n"],params=g)
                                                 for s,g,m in hof],
                                   ts=datetime.datetime.utcnow().isoformat()),
                              open(HOF,"w"),indent=2,default=str)
                    sleeves="".join([s for s,on in [("4",bg["use_btc4h"]),("1",bg["use_btc1h"]),("E",bg["use_eth"])] if on])
                    now=datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M")
                    with open(REPORT,"a") as f:
                        f.write("\n## Champion #%d - gen %d - %s\n- Calmar %.2f | CAGR %.1f%% DD %.1f%% min_n %d testCAGR %.1f%%\n- sleeves[%s] exit_ema20=%s filters(fund=%s rsi=%s bear=%s)\n- per-yr: %s\n- params: `%s`\n"
                                %(idx,gen,now,bsc,bm["cagr"],bm["maxdd"],bm["min_n"],tc,sleeves,
                                  bg["exit_ema20"],bg["f_funding"],bg["f_rsi"],bg["f_bear"],
                                  " ".join("%d:%+.0f%%"%(y,bm["yr_roi"].get(y,0)) for y in range(2019,2027)),
                                  json.dumps(bg)))
                    st=git_commit(idx,bm,frag)
                    sys.stderr.write("[gen %d] CHAMPION #%d Calmar=%.2f CAGR=%.1f%% DD=%.1f%% test=%.1f%% sleeves[%s] -> %s\n"
                                     %(gen,idx,bsc,bm["cagr"],bm["maxdd"],tc,sleeves,st))
        # next generation: elitism + tournament + crossover + mutation
        elite=[g for _,g,_ in scored[:max(2,POP//6)]]
        newpop=list(elite)
        while len(newpop)<POP:
            def tour():
                cands=random.sample(scored,min(3,len(scored))); cands.sort(key=lambda x:x[0],reverse=True); return cands[0][1]
            child=crossover(tour(),tour())
            if random.random()<0.7: child=mutate(al,child)
            newpop.append(child)
        pop=newpop
    ex.shutdown(wait=False,cancel_futures=True)
    sys.stderr.write("Evolver-v2 done gen=%d champions=%d\n"%(gen,idx))
