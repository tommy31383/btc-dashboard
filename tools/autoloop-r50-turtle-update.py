#!/usr/bin/env python3
"""autoloop-r50-turtle-update.py — Round 50: Full portfolio with updated turtle
R49: Turtle DE=20 DX=15 CUT=1.5 BEAR-gate = +0.127+0.093 delta vs C module (CUT=2.0 no gate)
R50: Rerun FULL portfolio with correct H params + updated turtle
IMPORTANT: Using correct run_h01 from r33/r40 (all H params set correctly)
R50A: New turtle (DE=20 DX=15 CUT=1.5 BEAR-gate) 7y + portfolio test
R50B: Portfolio comparison: old turtle (C module) vs new turtle
R50C: Could new turtle push portfolio past Sh+1.91 ceiling?
R50D: If yes → final config update
"""
import importlib.util, datetime, math, os, sys
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
turB_orig=dict(C.tur_mo)  # original C module turtle (CUT=2.0 no BEAR-gate)
cal7=months_between(spanB[0],spanB[1])
cal3=months_between(spanS[0],spanS[1])

def run_h01(cache, adx_thresh=18, sl_init=3.0, sl_trail=3.5, sl_trans=16,
            adx_period=12, atr_break_mult=1.3, vol_mult=1.4, vol_ma=10, max_hold=200):
    H.CACHE=cache
    orig=(H.ADX_THRESH,H.SL_INIT,H.SL_TRAIL,H.SL_TRANS,H.ADX_P,
          H.ATR_BREAK_MULT,H.VOL_MULT,H.VOL_MA,H.MAX_HOLD)
    H.ADX_THRESH=adx_thresh; H.SL_INIT=sl_init; H.SL_TRAIL=sl_trail; H.SL_TRANS=sl_trans
    H.ADX_P=adx_period; H.ATR_BREAK_MULT=atr_break_mult; H.VOL_MULT=vol_mult
    H.VOL_MA=vol_ma; H.MAX_HOLD=max_hold
    bars4h=H.load_tf(H.H4); bars1h=H.load_tf(3600*1000); bars1d=H.load_tf(86400*1000)
    n=len(bars4h); c4=[b["close"] for b in bars4h]
    e50=H.ema_s(c4,H.EMA_FAST); e200=H.ema_s(c4,H.EMA_SLOW)
    atr4=H.atr_series(bars4h); adx4=H.adx_wilder(bars4h,period=H.ADX_P)
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
    (H.ADX_THRESH,H.SL_INIT,H.SL_TRAIL,H.SL_TRANS,H.ADX_P,
     H.ATR_BREAK_MULT,H.VOL_MULT,H.VOL_MA,H.MAX_HOLD)=orig
    return mo

def run_turtle_new(DE=20, DX=15, CUT=1.5, bear_gate=True, cache=None):
    """New turtle with configurable params + BEAR-gate option"""
    H.CACHE=cache or f"{CC}/binance-5m-7y.json"
    bars1d_=H.load_tf(86400*1000)
    BD=bars1d_; nd=len(BD); CC_=[b["close"] for b in BD]
    regime_1d_=H.regime_with_persistence(BD)
    reg_map_={b["time"]//86400000:regime_1d_[i] for i,b in enumerate(BD)}
    def get_reg_(ts): return reg_map_.get(ts//86400000,"RANGE")
    def atr_d(bars):
        out=[None]*len(bars)
        for i in range(1,len(bars)):
            h=bars[i]["high"]; l=bars[i]["low"]; pc=bars[i-1]["close"]
            out[i]=max(h-l,abs(h-pc),abs(l-pc))
        return out
    atrd=atr_d(BD); dhi=[None]*nd; dlo=[None]*nd
    for i in range(DE,nd): dhi[i]=max(BD[j]["high"] for j in range(i-DE,i))
    for i in range(DX,nd): dlo[i]=min(BD[j]["low"] for j in range(i-DX,i))
    tur_mo=defaultdict(float); hold=False; e=0.0; a=0.0
    for i in range(max(DE,DX),nd):
        if bear_gate and get_reg_(BD[i]["time"])=="BEAR":
            if hold: tur_mo[mo_str(BD[i]["time"])]+=(CC_[i]-e)/e-2*H.FEE; hold=False
            continue
        if not hold:
            if dhi[i] and CC_[i]>dhi[i]: e=CC_[i]; a=atrd[i] or 0.01*e; hold=True
        else:
            if atrd[i]: a=atrd[i]
            if BD[i]["low"]<=e-a*CUT: ex=e-a*CUT; tur_mo[mo_str(BD[i]["time"])]+=(ex-e)/e-2*H.FEE; hold=False
            elif dlo[i] and CC_[i]<dlo[i]: tur_mo[mo_str(BD[i]["time"])]+=(CC_[i]-e)/e-2*H.FEE; hold=False
    if hold: tur_mo[mo_str(BD[-1]["time"])]+=(CC_[-1]-e)/e-2*H.FEE
    return tur_mo

print("Loading correct BTC+SOL (full params)...")
moB=run_h01(f"{CC}/binance-5m-7y.json",18); sB3=[moB.get(m,0.0) for m in cal3]
moS=run_h01(f"{CC}/binance-sol-5m-3y.json",15); sS3=[moS.get(m,0.0) for m in cal3]
print("Computing new turtle variants...")
turB_new=run_turtle_new(20,15,1.5,True)
turB_15_no_gate=run_turtle_new(20,10,1.5,False)
turB_15_gate=run_turtle_new(20,10,1.5,True)
turB_20_15_2=run_turtle_new(20,15,2.0,True)

def bk(parts, weights=None, c=None):
    cc=c or cal3; k=len(parts); w=weights or [1]*k; sw=sum(w)
    p=[sum(w[j]*parts[j][i] for j in range(k))/sw for i in range(len(cc))]
    yr=defaultdict(float)
    for i,m in enumerate(cc): yr[int(m[:4])]+=p[i]
    sh=sharpe(p); md=maxdd(p); fl=sum(1 for x in p if abs(x)<1e-9)
    sp=sorted(enumerate(p),key=lambda x:-x[1]); top3={i for i,_ in sp[:3]}
    nt=[x for i,x in enumerate(p) if i not in top3]; sh_nt=sharpe(nt) if len(nt)>2 else 0
    test_m=[m for m in cc if m[:4] in ("2025","2026")]
    sh_te=sharpe([p[cc.index(m)] for m in test_m if m in cc])
    py=" ".join(f"{y%100}:{yr[y]*100:+.0f}" for y in sorted(yr))
    return sh,md,fl,sh_nt,sh_te,py,p

print("="*100)
print("=== R50: Full portfolio with updated turtle ===\n")

# ─── R50A: New turtle 7y metrics ───
print("━"*100)
print("R50A: Turtle variants comparison (7y)")
print(f"  {'Config':<38} {'Sh_7y':>7} {'DD_7y':>6} {'tot%':>7} | per-year (2019+)")
print("  "+"-"*70)
for lbl,tur_ in [
    ("C module (DE20/DX10/CUT2.0 no gate)",turB_orig),
    ("DE20/DX10/CUT1.5 no gate",turB_15_no_gate),
    ("DE20/DX10/CUT1.5 BEAR-gate",turB_15_gate),
    ("DE20/DX15/CUT1.5 BEAR-gate (NEW)",turB_new),
    ("DE20/DX15/CUT2.0 BEAR-gate",turB_20_15_2),
]:
    v7=[tur_.get(m,0.0) for m in cal7]
    sh_=sharpe(v7); md_=maxdd(v7); tot_=sum(v7)*100
    yr_t=defaultdict(float)
    for m,v in tur_.items(): yr_t[int(m[:4])]+=v
    py_=" ".join(f"{y%100}:{yr_t[y]*100:+.0f}" for y in sorted(yr_t) if y>=2019)
    mark="★" if sh_>sharpe([turB_orig.get(m,0.0) for m in cal7])+0.01 else ""
    print(f"  {lbl:<38} {sh_:>+7.3f} {md_:>5.1f}% {tot_:>+6.0f}% | {py_} {mark}")

# ─── R50B: Portfolio comparison ───
print("\n━"*100)
print("R50B: Portfolio comparison — old vs new turtle")
print(f"  {'Config':<55} {'Sh':>6} {'DD':>5} {'flat':>5} {'no-top':>7} {'TEST':>7} | per-year")
print("  "+"-"*95)

def pr(label, tur_dict):
    sTB_=[tur_dict.get(m,0.0) for m in cal3]
    sh_,md_,fl_,nt_,te_,py_,_=bk([sB3,sS3,sTB_])
    ok=sh_>=2.00 and md_<=9.0
    m="✅" if ok else ("⚠️" if sh_>=1.90 else "❌")
    print(f"  {m} {label:<54} Sh{sh_:>+5.2f} DD{md_:>4.1f}% flat{fl_:>3}/35 no-top{nt_:>+5.2f} TE{te_:>+5.2f} | {py_}")
    return sh_,md_,fl_,te_

sh_orig,dd_orig,fl_orig,te_orig=pr("Original (C module DE20/DX10/CUT2.0)",turB_orig)
pr("DE20/DX10/CUT1.5 no gate",turB_15_no_gate)
pr("DE20/DX10/CUT1.5 BEAR-gate (deployed params)",turB_15_gate)
pr("DE20/DX15/CUT2.0 BEAR-gate",turB_20_15_2)
sh_new,dd_new,fl_new,te_new=pr("DE20/DX15/CUT1.5 BEAR-gate (R49 BEST)",turB_new)

# ─── R50C: Can new turtle break Sh+1.91 ceiling? ───
print("\n━"*100)
print("R50C: Turtle config fine-tune — push past ceiling?")
print(f"  {'CUT':>4} {'DX':>3} {'gate':>5} | {'Sh':>7} {'DD':>5} {'flat':>5} {'TEST':>7} {'delta':>7}")
print("  "+"-"*58)
for cut in [1.0,1.5,2.0]:
    for dx in [10,12,15]:
        for gate in [False,True]:
            tur_=run_turtle_new(20,dx,cut,gate)
            sTB_=[tur_.get(m,0.0) for m in cal3]
            sh_,md_,fl_,nt_,te_,py_,_=bk([sB3,sS3,sTB_])
            delta=sh_-sh_orig
            mark="★★" if sh_>2.00 and md_<=9 else ("★" if delta>0.05 else "")
            print(f"  {cut:>4.1f} {dx:>3} {'Y' if gate else 'N':>5} | {sh_:>+7.2f} {md_:>4.1f}% {fl_:>3}/35 {te_:>+7.2f} {delta:>+6.3f} {mark}")

# ─── R50D: Best overall config ───
print("\n━"*100)
print("R50D: Best config determination")
best_tur=None; best_sh=sh_orig
for cut in [1.0,1.5,2.0,2.5]:
    for dx in [8,10,12,15]:
        for gate in [False,True]:
            tur_=run_turtle_new(20,dx,cut,gate)
            sTB_=[tur_.get(m,0.0) for m in cal3]
            sh_,md_,fl_,nt_,te_,py_,_=bk([sB3,sS3,sTB_])
            if sh_>best_sh and md_<=10:
                best_sh=sh_; best_tur=(cut,dx,gate,tur_,sh_,md_,fl_,te_,py_)

if best_tur:
    cut_b,dx_b,gate_b,tur_b,sh_b,md_b,fl_b,te_b,py_b=best_tur
    print(f"  BEST: CUT={cut_b} DX={dx_b} BEAR-gate={gate_b} → Sh{sh_b:+.3f} DD{md_b:.1f}% TEST{te_b:+.3f}")
    print(f"  vs baseline Sh{sh_orig:+.3f}: delta{sh_b-sh_orig:>+.3f}")
    print(f"  Per-year: {py_b}")
    if sh_b>2.00:
        print(f"  ★★ BREAKTHROUGH: Sh{sh_b:+.2f} > 2.00!")
    elif sh_b>sh_orig+0.02:
        print(f"  ★ IMPROVEMENT: +{sh_b-sh_orig:.3f} Sharpe → consider updating backtest reference")
    else:
        print(f"  MARGINAL: delta too small to justify changing deployed config")

print("\n"+"="*100)
print("R50 SUMMARY")
print(f"  Original turtle (C module): Sh{sh_orig:+.3f} DD{dd_orig:.1f}% TEST{te_orig:+.3f}")
print(f"  Best new turtle: {'CUT='+str(best_tur[0])+' DX='+str(best_tur[1])+' gate='+str(best_tur[2]) if best_tur else 'N/A'} → Sh{best_sh:+.3f}")
print(f"  Ceiling still at Sh+1.91? → see R50C above")
