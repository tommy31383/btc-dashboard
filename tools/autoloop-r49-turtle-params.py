#!/usr/bin/env python3
"""autoloop-r49-turtle-params.py — Round 49: Turtle parameter optimization
R48: SOL confirmed as only valid diversifier. Framework locked.
Last untested component: Turtle (Donchian 20/10 CUT=2.0)
Deployed turtleLogger uses CUT=1.5 — backtest uses 2.0. Discrepancy!
R49A: Turtle CUT sweep (1.0, 1.5, 2.0, 2.5, 3.0)
R49B: Turtle DE/DX sweep (entry/exit period)
R49C: Turtle BEAR-gate test (skip BEAR months — already deployed as skip-BEAR)
R49D: Portfolio impact of turtle param changes
"""
import importlib.util, datetime, math, os, sys
from collections import defaultdict

def imp(name, path):
    spec=importlib.util.spec_from_file_location(name,path); M=importlib.util.module_from_spec(spec)
    so=sys.stdout; sys.stdout=open(os.devnull,"w"); spec.loader.exec_module(M); sys.stdout=so; return M

T="/Users/lap16116/BTC_PC/btc-dashboard/tools/"
CC="/Users/lap16116/BTC_PC/btc-dashboard/.cache"
Hh=imp("Hh",T+"loop-hedge01-crossasset.py")
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
cal7=months_between(spanB[0],spanB[1])
cal3=months_between(spanS[0],spanS[1])

# BTC hedge01 signals (fixed)
H.CACHE=f"{CC}/binance-5m-7y.json"
H.ADX_THRESH=18; H.MAX_HOLD=200
bars4h_b=H.load_tf(H.H4); bars1h_b=H.load_tf(3600*1000); bars1d_b=H.load_tf(86400*1000)

def run_h01_btc():
    n=len(bars4h_b); c4=[b["close"] for b in bars4h_b]
    e50=H.ema_s(c4,H.EMA_FAST); e200=H.ema_s(c4,H.EMA_SLOW)
    atr4=H.atr_series(bars4h_b); adx4=H.adx_wilder(bars4h_b)
    e200_1h=H.ema_s([b["close"] for b in bars1h_b],200); h1t=[b["time"] for b in bars1h_b]
    regime_1d=H.regime_with_persistence(bars1d_b)
    reg_map={b["time"]//86400000:regime_1d[i] for i,b in enumerate(bars1d_b)}
    def get_reg(ts): return reg_map.get(ts//86400000,"RANGE")
    def atp(i): return None if atr4[i] is None else atr4[i]/c4[i]
    def atp_pass(i):
        if i<H.ATR_PCT_LB+14: return False
        vs=[atp(j) for j in range(i-H.ATR_PCT_LB,i) if atp(j) is not None]
        if len(vs)<H.ATR_PCT_LB: return False
        cur=atp(i); return cur is not None and cur>=sorted(vs)[int(len(vs)*H.ATR_PCT_PCTL)]
    def vol_pass(i):
        if i<H.VOL_MA: return False
        ma=sum(bars4h_b[j]["volume"] for j in range(i-H.VOL_MA,i))/H.VOL_MA
        return bars4h_b[i]["volume"]>=ma*H.VOL_MULT
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
        e1h=e200_1h_at(bars4h_b[i]["time"])
        if e1h is None or c4[i]<e1h: return False
        if not atp_pass(i): return False
        return get_reg(bars4h_b[i]["time"])=="RANGE"
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
            if bars4h_b[j]["low"]<=sl_: return (sl_-ep)/ep-2*H.FEE,h
        j=min(ei+H.MAX_HOLD,n-1); return (c4[j]-ep)/ep-2*H.FEE,H.MAX_HOLD
    s12=lambda i:(None if None in (e50[i],e200[i]) or i<1 or None in (e50[i-1],e200[i-1]) else ("LONG" if e50[i-1]<=e200[i-1] and e50[i]>e200[i] else None))
    s13=lambda i:(None if atr4[i] is None or i<1 else ("LONG" if c4[i]>bars4h_b[i-1]["close"]+atr4[i]*H.ATR_BREAK_MULT else None))
    s14=lambda i:(None if i<H.DONCHIAN_LB else ("LONG" if c4[i]>max(bars4h_b[j]["high"] for j in range(i-H.DONCHIAN_LB,i)) else None))
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
            ret,h=r; mo[mo_str(bars4h_b[min(i+h,n-1)]["time"])]+=ret; last[sn]=i
    return mo

def run_turtle(DE=20, DX=10, CUT=2.0, bear_gate=False):
    """Run turtle on BTC daily data"""
    BD=bars1d_b; nd=len(BD); CC=[b["close"] for b in BD]
    def atr_d(bars):
        out=[None]*len(bars)
        for i in range(1,len(bars)):
            h=bars[i]["high"]; l=bars[i]["low"]; pc=bars[i-1]["close"]
            out[i]=max(h-l,abs(h-pc),abs(l-pc))
        return out
    regime_1d_tur=H.regime_with_persistence(BD)
    reg_map_tur={b["time"]//86400000:regime_1d_tur[i] for i,b in enumerate(BD)}
    def get_reg_tur(ts): return reg_map_tur.get(ts//86400000,"RANGE")
    atrd=atr_d(BD); dhi=[None]*nd; dlo=[None]*nd
    for i in range(DE,nd): dhi[i]=max(BD[j]["high"] for j in range(i-DE,i))
    for i in range(DX,nd): dlo[i]=min(BD[j]["low"] for j in range(i-DX,i))
    tur_mo=defaultdict(float); hold=False; e=0.0; a=0.0
    for i in range(max(DE,DX),nd):
        if bear_gate and get_reg_tur(BD[i]["time"])=="BEAR":
            if hold: tur_mo[mo_str(BD[i]["time"])]+=(CC[i]-e)/e-2*H.FEE; hold=False
            continue
        if not hold:
            if dhi[i] and CC[i]>dhi[i]: e=CC[i]; a=atrd[i] or 0.01*e; hold=True
        else:
            if atrd[i]: a=atrd[i]
            if BD[i]["low"]<=e-a*CUT: ex=e-a*CUT; tur_mo[mo_str(BD[i]["time"])]+=(ex-e)/e-2*H.FEE; hold=False
            elif dlo[i] and CC[i]<dlo[i]: tur_mo[mo_str(BD[i]["time"])]+=(CC[i]-e)/e-2*H.FEE; hold=False
    if hold: tur_mo[mo_str(BD[-1]["time"])]+=(CC[-1]-e)/e-2*H.FEE
    return tur_mo

print("Loading BTC hedge01 signals...")
moB=run_h01_btc(); sB7=[moB.get(m,0.0) for m in cal7]; sB3=[moB.get(m,0.0) for m in cal3]

# SOL (simplified - use same monthly returns from earlier analysis)
H.CACHE=f"{CC}/binance-sol-5m-3y.json"; H.ADX_THRESH=15; H.MAX_HOLD=200
bars4h_s=H.load_tf(H.H4); bars1h_s=H.load_tf(3600*1000); bars1d_s=H.load_tf(86400*1000)

def run_h01_sol():
    n=len(bars4h_s); c4=[b["close"] for b in bars4h_s]
    e50=H.ema_s(c4,H.EMA_FAST); e200=H.ema_s(c4,H.EMA_SLOW)
    atr4=H.atr_series(bars4h_s); adx4=H.adx_wilder(bars4h_s)
    e200_1h=H.ema_s([b["close"] for b in bars1h_s],200); h1t=[b["time"] for b in bars1h_s]
    regime_1d_s=H.regime_with_persistence(bars1d_s)
    reg_map_s={b["time"]//86400000:regime_1d_s[i] for i,b in enumerate(bars1d_s)}
    def get_reg_s(ts): return reg_map_s.get(ts//86400000,"RANGE")
    def atp(i): return None if atr4[i] is None else atr4[i]/c4[i]
    def atp_pass(i):
        if i<H.ATR_PCT_LB+14: return False
        vs=[atp(j) for j in range(i-H.ATR_PCT_LB,i) if atp(j) is not None]
        if len(vs)<H.ATR_PCT_LB: return False
        cur=atp(i); return cur is not None and cur>=sorted(vs)[int(len(vs)*H.ATR_PCT_PCTL)]
    def vol_pass(i):
        if i<H.VOL_MA: return False
        ma=sum(bars4h_s[j]["volume"] for j in range(i-H.VOL_MA,i))/H.VOL_MA
        return bars4h_s[i]["volume"]>=ma*H.VOL_MULT
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
        e1h=e200_1h_at(bars4h_s[i]["time"])
        if e1h is None or c4[i]<e1h: return False
        if not atp_pass(i): return False
        return get_reg_s(bars4h_s[i]["time"])=="RANGE"
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
            if bars4h_s[j]["low"]<=sl_: return (sl_-ep)/ep-2*H.FEE,h
        j=min(ei+H.MAX_HOLD,n-1); return (c4[j]-ep)/ep-2*H.FEE,H.MAX_HOLD
    s12=lambda i:(None if None in (e50[i],e200[i]) or i<1 or None in (e50[i-1],e200[i-1]) else ("LONG" if e50[i-1]<=e200[i-1] and e50[i]>e200[i] else None))
    s13=lambda i:(None if atr4[i] is None or i<1 else ("LONG" if c4[i]>bars4h_s[i-1]["close"]+atr4[i]*H.ATR_BREAK_MULT else None))
    s14=lambda i:(None if i<H.DONCHIAN_LB else ("LONG" if c4[i]>max(bars4h_s[j]["high"] for j in range(i-H.DONCHIAN_LB,i)) else None))
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
            ret,h=r; mo[mo_str(bars4h_s[min(i+h,n-1)]["time"])]+=ret; last[sn]=i
    return mo

# Reset H params for BTC after SOL load
H.CACHE=f"{CC}/binance-5m-7y.json"; H.ADX_THRESH=18; H.MAX_HOLD=200

print("Loading SOL signals...")
moS=run_h01_sol(); sS3=[moS.get(m,0.0) for m in cal3]

# Baseline turtle
tur_base=run_turtle(20,10,2.0)
sTB_base7=[tur_base.get(m,0.0) for m in cal7]
sTB_base3=[tur_base.get(m,0.0) for m in cal3]
sh_base=sharpe([(sB3[i]+sS3[i]+sTB_base3[i])/3 for i in range(len(cal3))])

print("="*100)
print("=== R49: Turtle parameter optimization ===\n")
print(f"  Baseline turtle (DE=20 DX=10 CUT=2.0): Sh{sharpe(sTB_base7):+.3f} (7y)")
print(f"  Portfolio baseline: Sh{sh_base:+.3f}")
print(f"  Deployed CUT=1.5 vs backtest CUT=2.0 — checking discrepancy\n")

# ─── R49A: CUT sweep ───
print("━"*100)
print("R49A: Turtle CUT sweep (ATR stop multiplier) — 7y turtle Sh + 3y portfolio Sh")
print(f"  {'CUT':>5} | {'Tur_7y_Sh':>10} {'Tur_7y_tot%':>12} {'Port_Sh':>9} {'delta_Sh':>9} | per-year 7y (partial)")
print("  "+"-"*70)
best_cut=2.0; best_cut_sh=sh_base
for cut in [1.0,1.5,2.0,2.5,3.0,4.0]:
    tur_=run_turtle(20,10,cut)
    sTB_7=[tur_.get(m,0.0) for m in cal7]
    sTB_3=[tur_.get(m,0.0) for m in cal3]
    sh_tur7=sharpe(sTB_7); tot_tur7=sum(sTB_7)*100
    sh_port=sharpe([(sB3[i]+sS3[i]+sTB_3[i])/3 for i in range(len(cal3))])
    delta=sh_port-sh_base
    yr_tur=defaultdict(float)
    for m,v in tur_.items(): yr_tur[int(m[:4])]+=v
    py=" ".join(f"{y%100}:{yr_tur[y]*100:+.0f}" for y in sorted(yr_tur) if y>=2022)
    mark="★" if sh_port>sh_base+0.01 else ("◀ cur" if cut==2.0 else ("◀ deployed" if cut==1.5 else ""))
    if sh_port>best_cut_sh: best_cut_sh=sh_port; best_cut=cut
    print(f"  {cut:>5.1f} | {sh_tur7:>+10.3f} {tot_tur7:>+11.0f}% {sh_port:>+9.3f} {delta:>+8.3f} | {py} {mark}")

# ─── R49B: DE/DX period sweep ───
print("\n━"*100)
print("R49B: Turtle DE/DX period sweep (entry/exit Donchian period)")
print(f"  {'DE':>4} {'DX':>4} | {'Tur_7y_Sh':>10} {'Port_Sh':>9} {'delta':>8} | per-year 7y (2022+)")
print("  "+"-"*65)
best_de_dx=(20,10); best_dedx_sh=sh_base
for de in [10,15,20,25,30]:
    for dx in [5,10,15]:
        if dx>=de: continue
        tur_=run_turtle(de,dx,best_cut)
        sTB_3=[tur_.get(m,0.0) for m in cal3]
        sTB_7=[tur_.get(m,0.0) for m in cal7]
        sh_tur7=sharpe(sTB_7)
        sh_port=sharpe([(sB3[i]+sS3[i]+sTB_3[i])/3 for i in range(len(cal3))])
        delta=sh_port-sh_base
        if sh_port>best_dedx_sh: best_dedx_sh=sh_port; best_de_dx=(de,dx)
        yr_tur=defaultdict(float)
        for m,v in tur_.items(): yr_tur[int(m[:4])]+=v
        py=" ".join(f"{y%100}:{yr_tur[y]*100:+.0f}" for y in sorted(yr_tur) if y>=2022)
        mark="★" if delta>0.01 else ("◀ baseline" if de==20 and dx==10 else "")
        print(f"  {de:>4} {dx:>4} | {sh_tur7:>+10.3f} {sh_port:>+9.3f} {delta:>+7.3f} | {py} {mark}")

# ─── R49C: BEAR gate ───
print("\n━"*100)
print("R49C: Turtle BEAR-gate test (skip entries in BEAR regime)")
tur_bg=run_turtle(20,10,best_cut,bear_gate=True)
sTB_bg7=[tur_bg.get(m,0.0) for m in cal7]
sTB_bg3=[tur_bg.get(m,0.0) for m in cal3]
sh_bg7=sharpe(sTB_bg7); tot_bg7=sum(sTB_bg7)*100
sh_bg_port=sharpe([(sB3[i]+sS3[i]+sTB_bg3[i])/3 for i in range(len(cal3))])
yr_bg=defaultdict(float)
for m,v in tur_bg.items(): yr_bg[int(m[:4])]+=v
py_bg=" ".join(f"{y%100}:{yr_bg[y]*100:+.0f}" for y in sorted(yr_bg))
print(f"  Without BEAR gate (CUT={best_cut}): Tur_7y Sh{sharpe(sTB_base7):+.3f} tot{sum(sTB_base7)*100:+.0f}% Port Sh{sh_base:+.3f}")
print(f"  With BEAR gate:                   Tur_7y Sh{sh_bg7:+.3f} tot{tot_bg7:+.0f}% Port Sh{sh_bg_port:+.3f}")
print(f"  Delta: Turtle{sh_bg7-sharpe(sTB_base7):+.3f} Portfolio{sh_bg_port-sh_base:+.3f}")
print(f"  Per-year (bear-gate): {py_bg}")

# ─── R49D: Best combo ───
print("\n━"*100)
print("R49D: Best turtle config portfolio impact")
de_b,dx_b=best_de_dx
tur_best=run_turtle(de_b,dx_b,best_cut)
sTB_best3=[tur_best.get(m,0.0) for m in cal3]
sTB_best7=[tur_best.get(m,0.0) for m in cal7]
sh_best=sharpe([(sB3[i]+sS3[i]+sTB_best3[i])/3 for i in range(len(cal3))])
yr_best=defaultdict(float)
for m,v in tur_best.items(): yr_best[int(m[:4])]+=v

def bk_py(sB_,sS_,sT_,c_):
    v=[(sB_[i]+sS_[i]+sT_[i])/3 for i in range(len(c_))]
    yr=defaultdict(float)
    for i,m in enumerate(c_): yr[int(m[:4])]+=v[i]
    sh=sharpe(v); md=maxdd(v); fl=sum(1 for x in v if abs(x)<1e-9)
    test=[m for m in c_ if m[:4] in ("2025","2026")]
    te=sharpe([v[c_.index(m)] for m in test if m in c_])
    py=" ".join(f"{y%100}:{yr[y]*100:+.0f}" for y in sorted(yr))
    return sh,md,fl,te,py

def pr(label,sB_,sS_,sT_,c_):
    sh_,md_,fl_,te_,py_=bk_py(sB_,sS_,sT_,c_)
    ok=sh_>=2.00 and md_<=9.0
    m="✅" if ok else ("⚠️" if sh_>=1.90 else "❌")
    print(f"  {m} {label:<52} Sh{sh_:>+5.2f} DD{md_:>4.1f}% flat{fl_:>3}/35 TE{te_:>+5.2f} | {py_}")
    return sh_,md_

pr("Baseline: BTC18+SOL15+Turtle(20/10/CUT2.0)",sB3,sS3,sTB_base3,cal3)
pr(f"Best turtle: DE={de_b} DX={dx_b} CUT={best_cut}",sB3,sS3,sTB_best3,cal3)
pr(f"BEAR-gated turtle: DE={de_b} DX={dx_b} CUT={best_cut}",sB3,sS3,sTB_bg3,cal3)

print("\n"+"="*100)
print("R49 SUMMARY")
print(f"  Best CUT: {best_cut} (delta_portfolio{best_cut_sh-sh_base:>+.3f})")
print(f"  Best DE/DX: {best_de_dx} (delta_portfolio{best_dedx_sh-sh_base:>+.3f})")
print(f"  BEAR gate: delta_portfolio{sh_bg_port-sh_base:>+.3f}")
print(f"  Deployed CUT=1.5 vs backtest CUT=2.0: check R49A for which is better")
