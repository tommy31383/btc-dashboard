#!/usr/bin/env python3
"""
AUTOLOOP — optimize G15 theo HONEST single-account metric.
Objective: maximize CAGR × stability, HARD constraints DD≤25%, n≥150/yr, no year<-15%.
Sizing: equity-fraction (margin = RISK_FRAC × equity × vol_scale), total margin cap.
Train 2019-2023 / Test 2024-2026 (chronological, anti-overfit).

Usage:
  python3 general-rule-autoloop.py baseline      # verify scorer on G15 config
  python3 general-rule-autoloop.py loop 300       # hill-climb 300 iters, log to autoloop-log.jsonl
"""
import json, datetime, bisect, sys, random, math
from collections import defaultdict

CACHE_5M   = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
CACHE_ETH  = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-eth-5m-7y.json"
CACHE_FUND = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-funding-7y.json"
LOGFILE    = "/Users/lap16116/BTC_PC/btc-dashboard/tools/autoloop-log.jsonl"
BESTFILE   = "/Users/lap16116/BTC_PC/btc-dashboard/tools/autoloop-best.json"
CAPITAL=100_000; LEV=10
random.seed(42)

sys.stderr.write("Loading...\n")
raw_btc=json.load(open(CACHE_5M)); raw_btc.sort(key=lambda x:x["time"])
raw_eth=json.load(open(CACHE_ETH)); raw_eth.sort(key=lambda x:x["time"])
rf=json.load(open(CACHE_FUND))
s=rf[0]; tk=[k for k in s if "time" in k.lower()][0]; rk=[k for k in s if k in ("fundingRate","rate","r","funding")][0]
fund_entries=sorted([(int(e[tk]),float(e[rk])) for e in rf]); ft=[e[0] for e in fund_entries]

def build_tf(ms,raw):
    b={}
    for c in raw:
        k=c["time"]//ms
        if k not in b: b[k]={"time":k*ms,"close":c["close"],"high":c["high"],"low":c["low"],"volume":c["volume"]}
        else: o=b[k]; o["close"]=c["close"]; o["high"]=max(o["high"],c["high"]); o["low"]=min(o["low"],c["low"])
    return [b[k] for k in sorted(b)]
def ema_s(xs,p):
    k=2/(p+1); out=[None]*len(xs); e=None
    for i,x in enumerate(xs): e=x if e is None else x*k+e*(1-k); out[i]=e
    return out
def rsi_s(xs,p=14):
    n=len(xs); out=[None]*n
    if n<=p: return out
    ag=al=0
    for i in range(1,p+1): d=xs[i]-xs[i-1]; ag+=max(d,0); al+=max(-d,0)
    ag/=p; al/=p; out[p]=100-100/(1+ag/al) if al>0 else 100
    for i in range(p+1,n):
        d=xs[i]-xs[i-1]; ag=(ag*(p-1)+max(d,0))/p; al=(al*(p-1)+max(-d,0))/p
        out[i]=100-100/(1+ag/al) if al>0 else 100
    return out
def atr_s(bars,p=14):
    n=len(bars); out=[None]*n
    trs=[max(bars[i]["high"]-bars[i]["low"],abs(bars[i]["high"]-bars[i-1]["close"]),abs(bars[i]["low"]-bars[i-1]["close"])) for i in range(1,n)]
    if len(trs)<p: return out
    a=sum(trs[:p])/p; out[p]=a
    for i in range(p,len(trs)): a=(a*(p-1)+trs[i])/p; out[i+1]=a
    return out
def adx_di_s(bars,p=14):
    n=len(bars); adx_o=[None]*n; pdi_o=[None]*n; mdi_o=[None]*n
    if n<p*3: return adx_o,pdi_o,mdi_o
    tr=[]; pdm=[]; mdm=[]
    for i in range(1,n):
        h,l,pc=bars[i]["high"],bars[i]["low"],bars[i-1]["close"]
        tr.append(max(h-l,abs(h-pc),abs(l-pc)))
        up=h-bars[i-1]["high"]; dn=bars[i-1]["low"]-l
        pdm.append(up if up>dn and up>0 else 0); mdm.append(dn if dn>up and dn>0 else 0)
    def sm(xs):
        out=[None]*len(xs)
        if len(xs)<p: return out
        ss=sum(xs[:p]); out[p-1]=ss
        for i in range(p,len(xs)): out[i]=out[i-1]-out[i-1]/p+xs[i]
        return out
    atr=sm(tr); ps=sm(pdm); ms2=sm(mdm); dx=[None]*len(tr); pl=[None]*len(tr); ml=[None]*len(tr)
    for i in range(p-1,len(tr)):
        if atr[i] and atr[i]>0:
            pdi=100*ps[i]/atr[i]; mdi=100*ms2[i]/atr[i]; pl[i]=pdi; ml[i]=mdi
            dx[i]=100*abs(pdi-mdi)/(pdi+mdi) if (pdi+mdi)>0 else 0
    a=[None]*len(dx); start=None
    for i in range(len(dx)):
        if dx[i] is not None:
            if start is None: start=i
            if i-start+1==p: a[i]=sum(v for v in dx[start:i+1] if v is not None)/p
            elif i>start+p-1 and a[i-1] is not None: a[i]=(a[i-1]*(p-1)+dx[i])/p
    for i in range(len(dx)): adx_o[i+1]=a[i]; pdi_o[i+1]=pl[i]; mdi_o[i+1]=ml[i]
    return adx_o,pdi_o,mdi_o
def fund_at(t): j=bisect.bisect_right(ft,t)-1; return fund_entries[j][1] if j>=0 else 0

# ===== PRECOMPUTE all indicators ONCE (periods fixed; only thresholds tune) =====
sys.stderr.write("Precomputing indicators...\n")
H4=4*3600*1000; H1=3600*1000
def prep(raw, daily_raw):
    b4=build_tf(H4,raw); b1d=build_tf(24*3600*1000,daily_raw)
    c=[x["close"] for x in b4]; h=[x["high"] for x in b4]; l=[x["low"] for x in b4]; t=[x["time"] for x in b4]
    e200=ema_s(c,200); e20=ema_s(c,20); adx,pdi,mdi=adx_di_s(b4,14); rsi=rsi_s(c,14); atr=atr_s(b4,14)
    ap=[None]*len(b4)
    for i in range(200,len(b4)):
        w=[x for x in atr[i-200:i] if x is not None]
        if w and atr[i]: ap[i]=sum(1 for x in w if x<atr[i])/len(w)
    c1d=[x["close"] for x in b1d]; t1d=[x["time"] for x in b1d]; e200d=ema_s(c1d,200)
    return dict(c=c,h=h,l=l,t=t,e200=e200,e20=e20,adx=adx,pdi=pdi,mdi=mdi,rsi=rsi,atr=atr,ap=ap,t1d=t1d,e200d=e200d)
P4=prep(raw_btc, raw_btc)
# BTC 1h
b1=build_tf(H1,raw_btc)
c1=[x["close"] for x in b1]; h1=[x["high"] for x in b1]; l1=[x["low"] for x in b1]; t1=[x["time"] for x in b1]
e200_1=ema_s(c1,200); e20_1=ema_s(c1,20); adx1,pdi1,mdi1=adx_di_s(b1,14); rsi1=rsi_s(c1,14); atr1=atr_s(b1,14)
ap1=[None]*len(b1)
for i in range(200,len(b1)):
    w=[x for x in atr1[i-200:i] if x is not None]
    if w and atr1[i]: ap1[i]=sum(1 for x in w if x<atr1[i])/len(w)
PE=prep(raw_eth, raw_eth)
def e200d_at(P,tms): j=bisect.bisect_right(P["t1d"],tms)-1; return P["e200d"][j] if 0<=j<len(P["e200d"]) else None

# ===== sleeve generators: return trades [(e_ms,x_ms,ret,sl_dist_frac,vol_scale,sleeve)] =====
# ret = price return at exit; margin sized later by scorer (equity-fraction)
def gen_4h(P, ADX_MIN,DI_R,SL_ATR,TP_ATR,HOLD,COOL,MAXPOS,BG,band=None,ETH=False,tag="BTC4h"):
    c,h,l,t=P["c"],P["h"],P["l"],P["t"]; e200,e20,adx,pdi,mdi,rsi,atr,ap=P["e200"],P["e20"],P["adx"],P["pdi"],P["mdi"],P["rsi"],P["atr"],P["ap"]
    pos=[]; out=[]; last=-999
    for i in range(200,len(c)-HOLD-1):
        np_=[]
        for (ei,epx,slpx,tppx,vs,ems) in pos:
            xpx=c[i]; done=False
            if l[i]<=slpx: xpx=slpx; done=True
            elif h[i]>=tppx: xpx=tppx; done=True
            elif e20[i] and c[i]<e20[i] and i-ei>=10: done=True
            elif i-ei>=HOLD: done=True
            if done: out.append((ems,t[i]+H4,(xpx-epx)/epx,vs,tag))
            else: np_.append((ei,epx,slpx,tppx,vs,ems))
        pos=np_
        if len(pos)>=MAXPOS or i-last<COOL: continue
        a=adx[i]; pp=pdi[i]; mm=mdi[i]; r=rsi[i]; e2=e200[i]; at=atr[i]
        if None in (a,pp,mm,r,e2,at): continue
        fr=fund_at(t[i]); price=c[i]; e2d=e200d_at(P,t[i])
        if e2d is None: continue
        ok=False
        if ETH:
            ratio=price/e2d
            if band[0]<=ratio<=band[1] and a>ADX_MIN and pp>mm*DI_R and price>e2 and fr<0.0005 and r<72: ok=True
        else:
            if price>=e2d*BG and a>ADX_MIN and pp>mm*DI_R and price>e2 and fr<0.0005 and r<72: ok=True
        if ok:
            vs=max(0.3,1.0-(ap[i] or 0.5))
            pos.append((i,price,price-SL_ATR*at,price+TP_ATR*at,vs,t[i])); last=i
    return out

def gen_1h(ADX_MIN,DI_R,SL_ATR,TP_ATR,HOLD,COOL,MAXPOS,BG):
    pos=[]; out=[]; last=-999
    for i in range(200,len(c1)-HOLD-1):
        np_=[]
        for (ei,epx,slpx,tppx,vs,ems) in pos:
            xpx=c1[i]; done=False
            if l1[i]<=slpx: xpx=slpx; done=True
            elif h1[i]>=tppx: xpx=tppx; done=True
            elif e20_1[i] and c1[i]<e20_1[i] and i-ei>=4: done=True
            elif i-ei>=HOLD: done=True
            if done: out.append((ems,t1[i]+H1,(xpx-epx)/epx,vs,"BTC1h"))
            else: np_.append((ei,epx,slpx,tppx,vs,ems))
        pos=np_
        if len(pos)>=MAXPOS or i-last<COOL: continue
        a=adx1[i]; pp=pdi1[i]; mm=mdi1[i]; r=rsi1[i]; e2=e200_1[i]; at=atr1[i]
        if None in (a,pp,mm,r,e2,at): continue
        fr=fund_at(t1[i]); price=c1[i]; e2d=e200d_at(P4,t1[i])
        if e2d is None: continue
        j=bisect.bisect_right(P4["t"],t1[i])-1
        if j<0 or P4["adx"][j] is None: continue
        if not (P4["adx"][j]>18 and P4["pdi"][j]>P4["mdi"][j]*0.95 and P4["c"][j]>P4["e200"][j]): continue
        if price>=e2d*BG and a>ADX_MIN and pp>mm*DI_R and price>e2 and fr<0.0005 and r<72:
            vs=max(0.3,1.0-(ap1[i] or 0.5))
            pos.append((i,price,price-SL_ATR*at,price+TP_ATR*at,vs,t1[i])); last=i
    return out

# ===== HONEST scorer: single account, equity-fraction sizing, margin cap =====
def honest_eval(params):
    p=params
    tr4=gen_4h(P4, p["adx4"],p["di4"],p["sl4"],p["tp4"],p["hold4"],p["cool4"],p["pos4"],p["bg"])
    tr1=gen_1h(p["adx1"],p["di1"],p["sl1"],p["tp1"],p["hold1"],p["cool1"],p["pos1"],p["bg"])
    tre=gen_4h(PE, p["adxe"],p["die"],p["sle"],p["tpe"],60,2,5,None,band=(p["eblo"],p["ebhi"]),ETH=True,tag="ETH4h")
    allt=sorted(tr4+tr1+tre, key=lambda x:x[0])
    if not allt: return None
    RISK=p["risk"]; CAP=p["cap"]
    equity=CAPITAL; margin_used=0; open_pos=[]
    ev=sorted(set([x[0] for x in allt]+[x[1] for x in allt]))
    ent=defaultdict(list)
    for x in allt: ent[x[0]].append(x)
    peak=CAPITAL; maxdd=0; taken=0
    yr_pnl=defaultdict(float); yr_n=defaultdict(int); yr_eq_start={}
    for ms in ev:
        still=[]
        for (x_ms,marg,ret) in open_pos:
            if x_ms<=ms:
                pnl=ret*marg*LEV-0.0006*marg; equity+=pnl; margin_used-=marg
                d=datetime.datetime.utcfromtimestamp(x_ms/1000); yr_pnl[d.year]+=pnl; yr_n[d.year]+=1
            else: still.append((x_ms,marg,ret))
        open_pos=still
        if equity>peak: peak=equity
        dd=(peak-equity)/peak*100
        if dd>maxdd: maxdd=dd
        for (e_ms,x_ms,ret,vs,sl) in ent.get(ms,[]):
            d=datetime.datetime.utcfromtimestamp(e_ms/1000)
            if d.year not in yr_eq_start: yr_eq_start[d.year]=equity
            marg=RISK*equity*vs
            if margin_used+marg<=CAP*equity and marg>0:
                margin_used+=marg; open_pos.append((x_ms,marg,ret)); taken+=1
    for (x_ms,marg,ret) in open_pos:
        pnl=ret*marg*LEV-0.0006*marg; equity+=pnl
        d=datetime.datetime.utcfromtimestamp(x_ms/1000); yr_pnl[d.year]+=pnl; yr_n[d.year]+=1
    years=sorted(yr_n.keys())
    yspan=(ev[-1]-ev[0])/(365.25*24*3600*1000)
    cagr=((equity/CAPITAL)**(1/yspan)-1)*100 if yspan>0 and equity>0 else -100
    # per-year ROI on running equity
    yr_roi={}
    for y in years:
        st=yr_eq_start.get(y,CAPITAL); yr_roi[y]=yr_pnl[y]/st*100 if st>0 else 0
    min_n=min((yr_n[y] for y in years if y!=2026), default=0)
    n2026=yr_n.get(2026,0)
    worst_roi=min(yr_roi.values()) if yr_roi else -100
    pos_years=sum(1 for y in years if yr_roi[y]>0)
    return dict(equity=equity,cagr=cagr,maxdd=maxdd,taken=taken,total=len(allt),
                yr_n=dict(yr_n),yr_roi=yr_roi,min_n=min_n,n2026=n2026,worst_roi=worst_roi,
                pos_years=pos_years,nyears=len(years))

def score_of(m, train_years=None):
    """score with hard constraints; returns (score, ok, reason)"""
    if m is None: return (-1e9,False,"no trades")
    if m["maxdd"]>25: return (-1e9,False,f"DD {m['maxdd']:.0f}>25")
    if m["min_n"]<150: return (-1e9,False,f"min_n {m['min_n']}<150")
    if m["n2026"]<60: return (-1e9,False,f"n2026 {m['n2026']}<60")
    if m["worst_roi"]<-15: return (-1e9,False,f"worst yr {m['worst_roi']:.0f}<-15")
    stability=m["pos_years"]/m["nyears"]
    return (m["cagr"]*stability, True, "ok")

# ===== Train/test split eval =====
def split_eval(params):
    """eval full, then check test-period constraints separately"""
    full=honest_eval(params)
    if full is None: return None,None
    # test period sub-metrics (2024-2026)
    test_years=[2024,2025,2026]
    test_n=[full["yr_n"].get(y,0) for y in test_years]
    test_roi=[full["yr_roi"].get(y,0) for y in test_years]
    test_ok = all(n>= (60 if y==2026 else 150) for n,y in zip(test_n,test_years)) and min(test_roi)>=-15
    return full, test_ok

# ===== G15 baseline params =====
G15 = dict(adx4=18,di4=0.95,sl4=1.8,tp4=8.0,hold4=60,cool4=2,pos4=5,
           adx1=18,di1=0.95,sl1=1.8,tp1=8.0,hold1=30,cool1=2,pos1=3,
           adxe=20,die=1.1,sle=1.8,tpe=8.0,eblo=0.85,ebhi=1.05,
           bg=0.85,risk=0.10,cap=1.0)

# perturbation grid (step sizes)
STEPS = dict(adx4=[16,18,20,22,25],di4=[0.9,0.95,1.0,1.05,1.1],sl4=[1.4,1.6,1.8,2.0,2.2],
             tp4=[6,7,8,10,12],hold4=[40,50,60,70,80],cool4=[1,2,3],pos4=[3,4,5,6,7],
             adx1=[16,18,20,22],di1=[0.9,0.95,1.0,1.05],sl1=[1.4,1.6,1.8,2.0],
             tp1=[6,7,8,10],hold1=[20,24,30,36],cool1=[1,2,3],pos1=[2,3,4,5],
             adxe=[18,20,22,25],die=[1.0,1.1,1.2,1.3],sle=[1.4,1.6,1.8,2.0],tpe=[6,8,10,12],
             eblo=[0.80,0.85,0.90],ebhi=[1.02,1.05,1.08,1.10],bg=[0.80,0.85,0.90],
             risk=[0.06,0.08,0.10,0.12,0.15,0.18],cap=[0.8,1.0,1.2])

def perturb(params):
    np_=dict(params); k=random.choice(list(STEPS.keys()))
    np_[k]=random.choice(STEPS[k]); return np_

MODE=sys.argv[1] if len(sys.argv)>1 else "baseline"

if MODE=="baseline":
    m,test_ok=split_eval(G15)
    sc,ok,reason=score_of(m)
    print("="*70); print("BASELINE G15 — HONEST equity-fraction sizing"); print("="*70)
    print(f"RISK_FRAC={G15['risk']}  margin_cap={G15['cap']}×equity")
    print(f"  Final equity: ${m['equity']:,.0f}  CAGR={m['cagr']:.1f}%  MaxDD={m['maxdd']:.1f}%")
    print(f"  Taken {m['taken']}/{m['total']}  min_n(2019-25)={m['min_n']}  n2026={m['n2026']}")
    print(f"  Score={sc:.1f}  constraints_ok={ok} ({reason})  test_ok={test_ok}")
    print(f"\n  {'Yr':>5}{'n':>7}{'ROI%':>10}")
    for y in sorted(m['yr_roi']):
        print(f"  {y:>5}{m['yr_n'][y]:>7}{m['yr_roi'][y]:>+9.1f}%")
    # sweep risk to find feasible
    print("\n  Risk-frac sweep (find DD≤25 + n≥150):")
    for rf_ in [0.04,0.06,0.08,0.10,0.12,0.15]:
        pp=dict(G15); pp["risk"]=rf_
        mm,tok=split_eval(pp); sc2,ok2,rs2=score_of(mm)
        print(f"    risk={rf_:.2f}: CAGR={mm['cagr']:>6.1f}% DD={mm['maxdd']:>5.1f}% min_n={mm['min_n']:>4} score={sc2:>7.1f} ok={ok2} ({rs2})")

elif MODE=="loop":
    N=int(sys.argv[2]) if len(sys.argv)>2 else 300
    # init best = feasible baseline (find risk that passes)
    best=dict(G15); best_m,_=split_eval(best); best_sc,best_ok,_=score_of(best_m)
    # if baseline infeasible, sweep risk to seed feasible
    if not best_ok:
        for rf_ in [0.08,0.06,0.10,0.04,0.12]:
            pp=dict(G15); pp["risk"]=rf_; mm,_=split_eval(pp); sc,ok,_=score_of(mm)
            if ok and sc>best_sc: best=pp; best_m=mm; best_sc=sc; best_ok=True
    open(LOGFILE,"w").close()
    accepted=0
    for it in range(N):
        cand=perturb(best)
        m,test_ok=split_eval(cand)
        sc,ok,reason=score_of(m)
        rec=dict(it=it,score=round(sc,2),ok=ok,test_ok=test_ok,reason=reason,
                 cagr=round(m["cagr"],1) if m else None,dd=round(m["maxdd"],1) if m else None,
                 min_n=m["min_n"] if m else None,params={k:cand[k] for k in cand})
        with open(LOGFILE,"a") as f: f.write(json.dumps(rec)+"\n")
        # accept only if train score improves AND test passes constraints
        if ok and test_ok and sc>best_sc:
            best=cand; best_sc=sc; best_m=m; accepted+=1
            json.dump(dict(score=best_sc,metrics={k:(best_m[k] if k!="yr_roi" and k!="yr_n" else best_m[k]) for k in best_m},params=best),
                      open(BESTFILE,"w"),indent=2,default=str)
            sys.stderr.write(f"[{it}] NEW BEST score={best_sc:.1f} CAGR={best_m['cagr']:.1f}% DD={best_m['maxdd']:.1f}% min_n={best_m['min_n']}\n")
        if it%25==0: sys.stderr.write(f"  iter {it}/{N}  best={best_sc:.1f}  accepted={accepted}\n")
    print(f"DONE {N} iters. Accepted {accepted}. Best score={best_sc:.1f}")
    print(f"Best: CAGR={best_m['cagr']:.1f}% DD={best_m['maxdd']:.1f}% min_n={best_m['min_n']} equity=${best_m['equity']:,.0f}")
    print(f"Best params: {json.dumps(best)}")
    print(f"Per-year:")
    for y in sorted(best_m['yr_roi']): print(f"  {y}: n={best_m['yr_n'][y]:>4} ROI={best_m['yr_roi'][y]:+.1f}%")

# ===== VERIFY mode: train/test segmented CAGR + param ±1 stability =====
if MODE=="verify":
    import math as _m
    best=json.load(open(BESTFILE))["params"]
    def seg_cagr(m, years):
        g=1.0; n=0
        for y in years:
            if y in m["yr_roi"]: g*=(1+m["yr_roi"][y]/100); n+=1
        # annualize: years count (2026 partial ~0.42)
        span=sum(1.0 if y!=2026 else 0.42 for y in years if y in m["yr_roi"])
        return (g**(1/span)-1)*100 if span>0 and g>0 else -100, g
    TRAIN=[2019,2020,2021,2022,2023]; TEST=[2024,2025,2026]
    print("="*72); print("VERIFY — train(2019-23) vs test(2024-26) segmented, + param stability")
    print("="*72)
    for name,prm in [("G15 baseline",G15),("LOOP best",best)]:
        m=honest_eval(prm)
        tr_c,tr_g=seg_cagr(m,TRAIN); te_c,te_g=seg_cagr(m,TEST)
        print(f"\n  {name}:")
        print(f"    Full CAGR={m['cagr']:.1f}%  DD={m['maxdd']:.1f}%  min_n={m['min_n']}")
        print(f"    TRAIN growth ×{tr_g:.1f} (CAGR {tr_c:.1f}%) | TEST growth ×{te_g:.2f} (CAGR {te_c:.1f}%)")
        te_n=[m['yr_n'].get(y,0) for y in TEST]; te_r=[m['yr_roi'].get(y,0) for y in TEST]
        print(f"    TEST per-yr: " + " ".join(f"{y}:n{m['yr_n'].get(y,0)}/{m['yr_roi'].get(y,0):+.0f}%" for y in TEST))
    # param ±1 stability around best
    print(f"\n  PARAM ±1 STABILITY (around LOOP best, CAGR/DD; fragile if CAGR swings hard or DD>25):")
    base_m=honest_eval(best); base_cagr=base_m["cagr"]
    fragile=0; tested=0
    for k in STEPS:
        if k not in best: continue
        vals=STEPS[k]
        try: idx=vals.index(best[k])
        except ValueError: continue
        neigh=[]
        for di in (-1,1):
            j=idx+di
            if 0<=j<len(vals):
                pp=dict(best); pp[k]=vals[j]; mm=honest_eval(pp)
                neigh.append((vals[j],mm["cagr"],mm["maxdd"])); tested+=1
                if mm["maxdd"]>25 or mm["cagr"]<base_cagr*0.6: fragile+=1
        if neigh:
            ns=" ".join(f"{v}:C{c:.0f}/D{d:.0f}" for v,c,d in neigh)
            flag="  <-- FRAGILE" if any(d>25 or c<base_cagr*0.6 for v,c,d in neigh) else ""
            print(f"    {k:6s}={best[k]} (C{base_cagr:.0f}): {ns}{flag}")
    print(f"\n  Stability: {fragile}/{tested} neighbors fragile (DD>25 or CAGR<60% of best)")
    print(f"  → robust if low fragile count + TEST CAGR(best) > TEST CAGR(baseline)")

if MODE=="cmp":
    def seg(m,years):
        g=1.0
        for y in years:
            if y in m["yr_roi"]: g*=(1+m["yr_roi"][y]/100)
        span=sum(1.0 if y!=2026 else 0.42 for y in years if y in m["yr_roi"])
        return (g**(1/span)-1)*100 if span>0 and g>0 else -100
    best=json.load(open(BESTFILE))["params"]
    TRAIN=[2019,2020,2021,2022,2023]; TEST=[2024,2025,2026]
    b04=dict(G15); b04["risk"]=0.04
    print("="*60); print("FAIR COMPARE @ matched DD — TEST(2024-26) generalization")
    print("="*60)
    for name,prm in [("G15 risk=0.04",b04),("LOOP best",best)]:
        m=honest_eval(prm)
        print(f"\n  {name}: DD={m['maxdd']:.1f}% full_CAGR={m['cagr']:.1f}% min_n={m['min_n']}")
        print(f"    TRAIN CAGR={seg(m,TRAIN):.1f}%  TEST CAGR={seg(m,TEST):.1f}%")
        print(f"    TEST: " + " ".join(f"{y}:n{m['yr_n'].get(y,0)}/{m['yr_roi'].get(y,0):+.0f}%" for y in TEST))
