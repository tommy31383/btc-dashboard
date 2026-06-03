#!/usr/bin/env python3
"""autoloop-r19-signal-params.py — Round 19: Signal param tuning
R19A: ATR_BREAK_MULT sweep (S13 trigger sensitivity) 0.8-2.0
R19B: VOL_MULT sweep (volume filter) 1.0-1.8
R19C: EMA params sweep (EMA_FAST 20-100)
R19D: ADX12 + best signal params combo
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

_,_,_,spanB=Hh.run_hedge01(f"{CC}/binance-5m-7y.json",skip_cal=False)
_,_,_,spanS=Hh.run_hedge01(f"{CC}/binance-sol-5m-3y.json",skip_cal=False)
turB=dict(C.tur_mo); cal=months_between(spanS[0],spanS[1]); cal7=months_between(spanB[0],spanB[1])
sTB=[turB.get(m,0.0) for m in cal]

def run_h01(cache, adx_thresh=18, sl_init=3.0, sl_trail=3.5, sl_trans=16,
            adx_period=12, atr_break_mult=1.2, vol_mult=1.2, ema_fast=50):
    H.CACHE=cache
    orig_adx=H.ADX_THRESH; orig_si=H.SL_INIT; orig_st=H.SL_TRAIL; orig_tr=H.SL_TRANS
    orig_p=H.ADX_P; orig_abm=H.ATR_BREAK_MULT; orig_vm=H.VOL_MULT; orig_ef=H.EMA_FAST
    H.ADX_THRESH=adx_thresh; H.SL_INIT=sl_init; H.SL_TRAIL=sl_trail; H.SL_TRANS=sl_trans
    H.ADX_P=adx_period; H.ATR_BREAK_MULT=atr_break_mult; H.VOL_MULT=vol_mult; H.EMA_FAST=ema_fast
    bars4h=H.load_tf(H.H4); bars1h=H.load_tf(3600*1000); bars1d=H.load_tf(86400*1000)
    n=len(bars4h); c4=[b["close"] for b in bars4h]
    e50=H.ema_s(c4,H.EMA_FAST); e200=H.ema_s(c4,H.EMA_SLOW)
    atr4=H.atr_series(bars4h); adx4=H.adx_wilder(bars4h,period=adx_period)
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
    sigs={"S12":(s12,False,36),"S13":(s13,True,1),"S14":(s14,True,36)}
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
    H.ADX_P=orig_p; H.ATR_BREAK_MULT=orig_abm; H.VOL_MULT=orig_vm; H.EMA_FAST=orig_ef
    return mo

def bk(sb,ss):
    p=[(sb[i]+ss[i]+sTB[i])/3 for i in range(len(cal))]
    yr=defaultdict(float)
    for i,m in enumerate(cal): yr[int(m[:4])]+=p[i]
    sh=sharpe(p); md=maxdd(p); fl=sum(1 for x in p if abs(x)<1e-9)
    sp=sorted(enumerate(p),key=lambda x:-x[1]); top3={i for i,_ in sp[:3]}
    nt=[x for i,x in enumerate(p) if i not in top3]; sh_nt=sharpe(nt) if len(nt)>2 else 0
    py=" ".join(f"{y%100}:{yr[y]*100:+.0f}" for y in sorted(yr))
    return sh,md,fl,sh_nt,py

def r7(adx_t=18,si=3.0,st=3.5,tr=16,p=12,abm=1.2,vm=1.2,ef=50):
    mo=run_h01(f"{CC}/binance-5m-7y.json",adx_t,si,st,tr,p,abm,vm,ef)
    s7=[mo.get(m,0.0) for m in cal7]; return sharpe(s7),maxdd(s7)

print("="*90)
print("=== Round 19: Signal param tuning (ATR_BREAK_MULT, VOL_MULT, EMA_FAST) ===")
print("=== Base: winner ADX12 params ===\n")

# ─── R19A: ATR_BREAK_MULT ───
print("━"*90)
print("R19A: ATR_BREAK_MULT sweep (S13 trigger: c4>prev_c+atr×MULT)")
print(f"  {'MULT':>7} | {'Sh':>6} {'DD':>5} {'flat':>5} {'no-top':>7} | {'7y-Sh':>6} | per-year")
print("  "+"-"*75)
best_abm_sh=1.83; best_abm=None
for abm in [0.6,0.8,1.0,1.1,1.2,1.3,1.4,1.6,1.8,2.0]:
    mb=run_h01(f"{CC}/binance-5m-7y.json",18,3.0,3.5,16,12,abm)
    ms=run_h01(f"{CC}/binance-sol-5m-3y.json",15,3.0,3.5,16,12,abm)
    sb_=[mb.get(m,0.0) for m in cal]; ss_=[ms.get(m,0.0) for m in cal]
    sh_,md_,fl_,sh_nt_,py_=bk(sb_,ss_)
    sh7,md7=r7(abm=abm)
    if sh_>best_abm_sh+0.01 and sh7>=0.95 and md7<=30:
        best_abm_sh=sh_; best_abm=abm
    mark="◀ default" if abm==1.2 else ("★" if sh_>1.84 and sh7>=0.95 and md7<=30 else "")
    print(f"  {abm:>7.1f} | {sh_:>+6.2f} {md_:>4.1f}% {fl_:>3}/35 {sh_nt_:>+7.2f} | {sh7:>+6.2f} | {py_} {mark}")
if best_abm: print(f"  ★ BEST ATR_BREAK_MULT: {best_abm} → Sh{best_abm_sh:+.2f}")
else: print(f"  → ATR_BREAK_MULT 1.2 is optimal")

# ─── R19B: VOL_MULT ───
print("\n━"*90)
print("R19B: VOL_MULT sweep (volume confirmation for S13/S14)")
print(f"  {'MULT':>7} | {'Sh':>6} {'DD':>5} {'flat':>5} {'no-top':>7} | per-year")
print("  "+"-"*65)
best_vm_sh=1.83; best_vm=None
for vm in [0.8,0.9,1.0,1.1,1.2,1.3,1.4,1.5,1.6,1.8]:
    mb=run_h01(f"{CC}/binance-5m-7y.json",18,3.0,3.5,16,12,1.2,vm)
    ms=run_h01(f"{CC}/binance-sol-5m-3y.json",15,3.0,3.5,16,12,1.2,vm)
    sb_=[mb.get(m,0.0) for m in cal]; ss_=[ms.get(m,0.0) for m in cal]
    sh_,md_,fl_,sh_nt_,py_=bk(sb_,ss_)
    sh7,md7=r7(vm=vm)
    if sh_>best_vm_sh+0.01 and sh7>=0.95 and md7<=30:
        best_vm_sh=sh_; best_vm=vm
    mark="◀ default" if vm==1.2 else ("★" if sh_>1.84 and sh7>=0.95 and md7<=30 else "")
    print(f"  {vm:>7.1f} | {sh_:>+6.2f} {md_:>4.1f}% {fl_:>3}/35 {sh_nt_:>+7.2f} | {py_} {mark}")
if best_vm: print(f"  ★ BEST VOL_MULT: {best_vm} → Sh{best_vm_sh:+.2f}")
else: print(f"  → VOL_MULT 1.2 is optimal")

# ─── R19C: EMA_FAST ───
print("\n━"*90)
print("R19C: EMA_FAST sweep (S12 signal: EMA_FAST crosses EMA_SLOW=200)")
print(f"  {'EMA_F':>7} | {'Sh':>6} {'DD':>5} {'flat':>5} | per-year")
print("  "+"-"*60)
for ef in [20,30,50,75,100,150]:
    mb=run_h01(f"{CC}/binance-5m-7y.json",18,3.0,3.5,16,12,1.2,1.2,ef)
    ms=run_h01(f"{CC}/binance-sol-5m-3y.json",15,3.0,3.5,16,12,1.2,1.2,ef)
    sb_=[mb.get(m,0.0) for m in cal]; ss_=[ms.get(m,0.0) for m in cal]
    sh_,md_,fl_,_,py_=bk(sb_,ss_)
    mark="◀ default" if ef==50 else ("★" if sh_>1.84 else "")
    print(f"  {ef:>7} | {sh_:>+6.2f} {md_:>4.1f}% {fl_:>3}/35 | {py_} {mark}")

# ─── R19D: Best combo ───
print("\n━"*90)
print("R19D: ADX12 + best params combo (if any improvement found)")
abm_use=best_abm or 1.2; vm_use=best_vm or 1.2
for lbl,adx_t,abm,vm in [
    ("ADX12/winner (base)", 18, 1.2, 1.2),
    (f"ADX12+ABM{abm_use}", 18, abm_use, 1.2),
    (f"ADX12+VM{vm_use}", 18, 1.2, vm_use),
    (f"ADX12+ABM{abm_use}+VM{vm_use}", 18, abm_use, vm_use),
]:
    mb=run_h01(f"{CC}/binance-5m-7y.json",adx_t,3.0,3.5,16,12,abm,vm)
    ms=run_h01(f"{CC}/binance-sol-5m-3y.json",15,3.0,3.5,16,12,abm,vm)
    sb_=[mb.get(m,0.0) for m in cal]; ss_=[ms.get(m,0.0) for m in cal]
    sh_,md_,fl_,sh_nt_,py_=bk(sb_,ss_)
    sh7,md7=r7(adx_t,abm=abm,vm=vm)
    ok7="✅" if sh7>=0.95 and md7<=30 else "⚠️"
    print(f"  {lbl:<35} Sh{sh_:>+5.2f} DD{md_:>4.1f}% no-top{sh_nt_:>+5.2f} | 7y:{sh7:>+5.2f} DD{md7:.0f}% {ok7} | {py_}")

print("\n"+"="*90)
print("R19 COMPLETE")
print("  If no improvement > +0.02 Sh over ADX12 winner → FULL CEILING CONFIRMED")
