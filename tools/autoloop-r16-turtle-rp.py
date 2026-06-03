#!/usr/bin/env python3
"""autoloop-r16-turtle-rp.py — Round 16: Turtle-BTC optimization + Risk-parity weights
R16A: Turtle-BTC với winner SL insight (ATR_CUT analog = trail analog)
R16B: Risk-parity weights winner book (1/σ weighting)
R16C: Asymmetric weights — hedge01 vs turtle
R16D: Regime persistence tuning (persist_n 2-5)
"""
import importlib.util, datetime, math, os, sys, json
from collections import defaultdict

def imp(name, path):
    spec=importlib.util.spec_from_file_location(name,path); M=importlib.util.module_from_spec(spec)
    so=sys.stdout; sys.stdout=open(os.devnull,"w"); spec.loader.exec_module(M); sys.stdout=so; return M

T="/Users/lap16116/BTC_PC/btc-dashboard/tools/"
CC="/Users/lap16116/BTC_PC/btc-dashboard/.cache"
Hh=imp("Hh",T+"loop-hedge01-crossasset.py"); C=imp("C",T+"correlation-turtle-hedge01-7y.py")
H=imp("H",T+"backtest-bull-regime-reaudit-7y.py")

def mo_str(ts): return datetime.datetime.utcfromtimestamp(ts/1000).strftime("%Y-%m")
def months_between(t0,t1):
    d0=datetime.datetime.utcfromtimestamp(t0/1000); d1=datetime.datetime.utcfromtimestamp(t1/1000)
    out=[]; y,m=d0.year,d0.month
    while (y,m)<=(d1.year,d1.month):
        out.append(f"{y}-{m:02d}"); m+=1
        if m>12: m=1;y+=1
    return out
def sharpe(v):
    if len(v)<2: return 0.0
    me=sum(v)/len(v); d=(sum((x-me)**2 for x in v)/len(v))**.5 or 1e-9; return me/d*math.sqrt(12)
def maxdd(v):
    cum=peak=mdd=0.0
    for x in v: cum+=x; peak=max(peak,cum); mdd=max(mdd,peak-cum)
    return mdd*100
def sd(v):
    me=sum(v)/len(v); return (sum((x-me)**2 for x in v)/len(v))**.5 or 1e-9

_,_,_,spanB=Hh.run_hedge01(f"{CC}/binance-5m-7y.json",skip_cal=False)
_,_,_,spanS=Hh.run_hedge01(f"{CC}/binance-sol-5m-3y.json",skip_cal=False)
turB=dict(C.tur_mo)
cal=months_between(spanS[0],spanS[1])
cal7=months_between(spanB[0],spanB[1])

def run_h01(cache, adx_thresh=18, sl_init=3.0, sl_trail=3.5, sl_trans=16, skip_s14=False):
    H.CACHE=cache
    orig_adx=H.ADX_THRESH; orig_si=H.SL_INIT; orig_st=H.SL_TRAIL; orig_tr=H.SL_TRANS
    H.ADX_THRESH=adx_thresh; H.SL_INIT=sl_init; H.SL_TRAIL=sl_trail; H.SL_TRANS=sl_trans
    bars4h=H.load_tf(H.H4); bars1h=H.load_tf(3600*1000); bars1d=H.load_tf(86400*1000)
    n=len(bars4h); c4=[b["close"] for b in bars4h]
    e50=H.ema_s(c4,H.EMA_FAST); e200=H.ema_s(c4,H.EMA_SLOW)
    atr4=H.atr_series(bars4h); adx4=H.adx_wilder(bars4h)
    e200_1h=H.ema_s([b["close"] for b in bars1h],200); h1t=[b["time"] for b in bars1h]
    regime_1d=H.regime_with_persistence(bars1d)
    reg_map={b["time"]//86400000:regime_1d[i] for i,b in enumerate(bars1d)}
    def get_reg(ts): return reg_map.get(ts//86400000,"RANGE")
    def atp(i): return None if atr4[i] is None else atr4[i]/c4[i]
    def atp_pass(i):
        if i<H.ATR_PCT_LB+14: return False
        vs=[atp(j) for j in range(i-H.ATR_PCT_LB,i) if atp(j) is not None]
        if len(vs)<H.ATR_PCT_LB: return False
        cur=atp(i); return cur is not None and cur>=sorted(vs)[int(len(vs)*H.ATR_PCT_PCTL)]
    def vol_pass(i):
        if i<H.VOL_MA: return False
        ma=sum(bars4h[j]["volume"] for j in range(i-H.VOL_MA,i))/H.VOL_MA
        return bars4h[i]["volume"]>=ma*H.VOL_MULT
    def e200_1h_at(ts):
        lo,hi,idx=0,len(h1t)-1,0
        while lo<=hi:
            m=(lo+hi)//2
            if h1t[m]<=ts: idx=m; lo=m+1
            else: hi=m-1
        return e200_1h[idx]
    def filt(i):
        adv=adx4[i]
        if adv is None or adv<=H.ADX_THRESH: return False
        ap=adx4[i-1] if i>=1 else None
        if ap is None or ap<=H.ADX_THRESH: return False
        e1h=e200_1h_at(bars4h[i]["time"])
        if e1h is None or c4[i]<e1h: return False
        if not atp_pass(i): return False
        return get_reg(bars4h[i]["time"])=="RANGE"
    def sim(ei):
        ep=c4[ei]; ae=atr4[ei]
        if ae is None or ae<=0: return None
        sl_=ep-ae*H.SL_INIT; hwm=ep
        for h in range(1,H.MAX_HOLD+1):
            j=ei+h
            if j>=n: break
            mult=H.SL_INIT if h<H.SL_TRANS else H.SL_TRAIL
            if c4[j]>hwm: hwm=c4[j]; sl_=hwm-ae*mult
            elif h>=H.SL_TRANS:
                t=hwm-ae*H.SL_TRAIL
                if t>sl_: sl_=t
            if bars4h[j]["low"]<=sl_: return (sl_-ep)/ep-2*H.FEE,h
        j=min(ei+H.MAX_HOLD,n-1); return (c4[j]-ep)/ep-2*H.FEE,H.MAX_HOLD
    s12=lambda i:(None if None in (e50[i],e200[i]) or i<1 or None in (e50[i-1],e200[i-1]) else ("LONG" if e50[i-1]<=e200[i-1] and e50[i]>e200[i] else None))
    s13=lambda i:(None if atr4[i] is None or i<1 else ("LONG" if c4[i]>bars4h[i-1]["close"]+atr4[i]*H.ATR_BREAK_MULT else None))
    s14=lambda i:(None if i<H.DONCHIAN_LB else ("LONG" if c4[i]>max(bars4h[j]["high"] for j in range(i-H.DONCHIAN_LB,i)) else None))
    sigs={"S12":(s12,False,36),"S13":(s13,True,1)}
    if not skip_s14: sigs["S14"]=(s14,True,36)
    mo=defaultdict(float); last={s:0 for s in sigs}
    for i in range(250,n-H.MAX_HOLD):
        for sn,(sfn,dov,cd) in sigs.items():
            if sfn(i)!="LONG": continue
            if i-last[sn]<cd: continue
            if dov and not vol_pass(i): continue
            if not filt(i): continue
            r=sim(i)
            if r is None: continue
            ret,h=r; cts=bars4h[min(i+h,n-1)]["time"]
            mo[mo_str(cts)]+=ret; last[sn]=i
    H.ADX_THRESH=orig_adx; H.SL_INIT=orig_si; H.SL_TRAIL=orig_st; H.SL_TRANS=orig_tr
    return mo

def run_turtle_btc(fast=20, atr_cut=1.5, persist_n=3):
    raw=json.load(open(f"{CC}/binance-5m-7y.json"))
    H4=4*3600*1000; D=86400*1000
    bk={}
    for c in raw:
        k=c["time"]//H4
        if k not in bk: bk[k]={"time":k*H4,"high":c["high"],"low":c["low"],"close":c["close"],"volume":c["volume"]}
        else: o=bk[k]; o["high"]=max(o["high"],c["high"]); o["low"]=min(o["low"],c["low"]); o["close"]=c["close"]; o["volume"]+=c["volume"]
    bars4h=[bk[k] for k in sorted(bk)]
    dk={}
    for c in raw:
        k=c["time"]//D
        if k not in dk: dk[k]={"time":k*D,"high":c["high"],"low":c["low"],"close":c["close"],"volume":c["volume"]}
        else: o=dk[k]; o["high"]=max(o["high"],c["high"]); o["low"]=min(o["low"],c["low"]); o["close"]=c["close"]; o["volume"]+=c["volume"]
    bars1d=[dk[k] for k in sorted(dk)]
    n=len(bars4h); c4=[b["close"] for b in bars4h]
    def atr_s(bars,p=14):
        tr=[0.0]*len(bars)
        for i in range(1,len(bars)): tr[i]=max(bars[i]["high"]-bars[i]["low"],abs(bars[i]["high"]-bars[i-1]["close"]),abs(bars[i]["low"]-bars[i-1]["close"]))
        atr=[None]*len(bars); s=sum(tr[1:p+1]); atr[p]=s/p
        for i in range(p+1,len(bars)): atr[i]=(atr[i-1]*(p-1)+tr[i])/p
        return atr
    atr4=atr_s(bars4h)
    # regime with custom persist_n
    regime_1d=H.regime_with_persistence(bars1d, persist_n=persist_n)
    reg_map={b["time"]//86400000:regime_1d[i] for i,b in enumerate(bars1d)}
    def get_reg(ts): return reg_map.get(ts//86400000,"RANGE")
    FEE=0.05/100; slow=fast//2
    mo=defaultdict(float); in_trade=False; ep=ae=sl=hwm=None
    for i in range(fast,n):
        reg=get_reg(bars4h[i]["time"])
        if reg=="BEAR":
            if in_trade: mo[mo_str(bars4h[i]["time"])]+=(bars4h[i]["low"]-ep)/ep-2*FEE; in_trade=False
            continue
        if in_trade:
            if c4[i]>hwm: hwm=c4[i]; sl=hwm-ae*1.0
            t=hwm-ae*atr_cut
            if t>sl: sl=t
            if bars4h[i]["low"]<=sl: mo[mo_str(bars4h[i]["time"])]+=(sl-ep)/ep-2*FEE; in_trade=False
        if not in_trade:
            hi_fast=max(bars4h[j]["high"] for j in range(i-fast,i))
            if c4[i]>hi_fast and atr4[i] is not None:
                in_trade=True; ep=c4[i]; ae=atr4[i]; sl=ep-ae*atr_cut; hwm=ep
    return mo

# Winner sleeves
moB=run_h01(f"{CC}/binance-5m-7y.json",18,3.0,3.5,16)
moS=run_h01(f"{CC}/binance-sol-5m-3y.json",15,3.0,3.5,16)
sB=[moB.get(m,0.0) for m in cal]; sS=[moS.get(m,0.0) for m in cal]

def bk_w(sb,ss,st,weights=None):
    w=weights or [1,1,1]; sw=sum(w)
    p=[sum(w[j]*[sb,ss,st][j][i] for j in range(3))/sw for i in range(len(cal))]
    yr=defaultdict(float)
    for i,m in enumerate(cal): yr[int(m[:4])]+=p[i]
    sh=sharpe(p); md=maxdd(p); tot=sum(p)*100; fl=sum(1 for x in p if abs(x)<1e-9)
    sp=sorted(enumerate(p),key=lambda x:-x[1]); top3={i for i,_ in sp[:3]}
    nt=[x for i,x in enumerate(p) if i not in top3]; sh_nt=sharpe(nt) if len(nt)>2 else 0
    py=" ".join(f"{y%100}:{yr[y]*100:+.0f}" for y in sorted(yr))
    return sh,md,tot,fl,sh_nt,py,p

print("="*95)
print("=== Round 16: Turtle-BTC optimization + Risk-parity + Regime tuning ===\n")

# Default turtle
turB_def=dict(C.tur_mo)
sTB_def=[turB_def.get(m,0.0) for m in cal]

print("━"*95)
print("R16A: Turtle-BTC param sweep with WINNER hedge01 sleeves")
print(f"  {'FAST':>5} {'ATR_CUT':>8} | {'Sh-book':>7} {'DD':>5} {'no-top':>7} | per-year")
print("  "+"-"*65)
best_sh=1.82; best_tur=None
for fast in [10,15,20,25,30]:
    for cut in [1.0,1.25,1.5,1.75,2.0,2.5,3.0]:
        mt=run_turtle_btc(fast=fast,atr_cut=cut)
        st_=[mt.get(m,0.0) for m in cal]
        sh_,md_,tot_,fl_,sh_nt_,py_,_=bk_w(sB,sS,st_)
        if sh_>best_sh+0.02: best_sh=sh_; best_tur=(fast,cut,st_)
        if sh_>=1.84:
            print(f"  F{fast:>3}  CUT{cut:.2f}  | {sh_:>+7.2f} {md_:>4.1f}% {sh_nt_:>+7.2f} | {py_}")
print(f"  [baseline turtle F20/CUT1.5]: Sh+1.82 (winner hedge01 + baseline turtle)")
if best_tur:
    f,c,st_=best_tur
    print(f"  ★ BEST turtle: F{f}/CUT{c:.2f} → Sh{best_sh:+.2f}")
else:
    print(f"  → No turtle improvement over baseline turtle with winner hedge01")

print("\n━"*95)
print("R16B: Risk-parity weighting (1/σ for each sleeve)")
weights_eq=[1,1,1]
w_rp=[1/sd(sB),1/sd(sS),1/sd(sTB_def)]
sw=sum(w_rp); w_rp_n=[w/sw*3 for w in w_rp]
print(f"  RP weights (normalized): BTC={w_rp_n[0]:.2f} SOL={w_rp_n[1]:.2f} turtle={w_rp_n[2]:.2f}")
for lbl,wts in [
    ("Equal weight [1,1,1]",weights_eq),
    (f"Risk-parity [1/σ]",w_rp),
    ("Hedge01 heavy [2,2,1]",[2,2,1]),
    ("Hedge01 heavy [3,2,1]",[3,2,1]),
    ("Turtle light [1,1,0.5]",[1,1,0.5]),
]:
    sh_,md_,tot_,fl_,sh_nt_,py_,_=bk_w(sB,sS,sTB_def,wts)
    print(f"  {lbl:<35} Sh{sh_:>+5.2f} DD{md_:>4.1f}% flat{fl_:>3}/35 no-top{sh_nt_:>+5.2f} | {py_}")

print("\n━"*95)
print("R16C: Regime persist_n tuning (default=3)")
for pn in [1,2,3,4,5]:
    mt=run_turtle_btc(persist_n=pn)
    st_=[mt.get(m,0.0) for m in cal]
    sh_,md_,tot_,fl_,sh_nt_,py_,_=bk_w(sB,sS,st_)
    mark="◀ default" if pn==3 else ""
    print(f"  persist_n={pn}: turtle Sh{sharpe(st_):+.2f} | book Sh{sh_:>+5.2f} DD{md_:>4.1f}% flat{fl_:>3}/35 | {py_} {mark}")

print("\n"+"="*95)
print("ROUND 16 SUMMARY")
print("  Turtle optimization: see above for any improvement")
print("  Risk-parity: check if any weight improves vs equal-weight")
print("  Regime persist: default=3 likely optimal")
