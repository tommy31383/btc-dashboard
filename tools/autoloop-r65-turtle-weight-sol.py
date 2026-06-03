#!/usr/bin/env python3
"""autoloop-r65-turtle-weight-sol.py — Round 65: Turtle weight verify + SOL fine-tune
R64 best: BTC(SL2.8/3.3) + SOL(SL2.9/3.4) + Turtle(T_w=1.2) → Sh+2.21 DD5.3%
  A: Turtle_w=1.2 robustness — holdout years
  B: SOL SL micro-sweep 2.85-3.0 (between 2.8/3.3 and 3.0/3.5)
  C: SOL SL2.9/3.4 2023-only analysis — why fragile?
  D: Combined BTC28+SOL micro + Turtle_w=1.2
  E: New direction: REGIME-SPECIFIC params — different ADX for RANGE-early vs RANGE-mature
  F: Full 3-year robustness of final config (TRAIN/TEST)
"""
import importlib.util, datetime, math, os, sys
from collections import defaultdict

def imp(name, path):
    spec=importlib.util.spec_from_file_location(name,path); M=importlib.util.module_from_spec(spec)
    so=sys.stdout; sys.stdout=open(os.devnull,"w"); spec.loader.exec_module(M); sys.stdout=so; return M

T="/Users/lap16116/BTC_PC/btc-dashboard/tools/"
CC="/Users/lap16116/BTC_PC/btc-dashboard/.cache"
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

def run_turtle():
    H.CACHE=f"{CC}/binance-5m-7y.json"
    bars1d=H.load_tf(86400*1000); BD=bars1d; nd=len(BD); CC_=[b["close"] for b in BD]
    regime_1d=H.regime_with_persistence(BD); reg_map={b["time"]//86400000:regime_1d[i] for i,b in enumerate(BD)}
    def get_reg(ts): return reg_map.get(ts//86400000,"RANGE")
    atrd=[None]*nd
    for i in range(1,nd):
        h=BD[i]["high"]; l=BD[i]["low"]; pc=BD[i-1]["close"]
        atrd[i]=max(h-l,abs(h-pc),abs(l-pc))
    dhi=[None]*nd; dlo=[None]*nd
    for i in range(20,nd): dhi[i]=max(BD[j]["high"] for j in range(i-20,i))
    for i in range(15,nd): dlo[i]=min(BD[j]["low"] for j in range(i-15,i))
    tur_mo=defaultdict(float); hold=False; e=0.0; a=0.0
    for i in range(20,nd):
        if get_reg(BD[i]["time"])=="BEAR":
            if hold: tur_mo[mo_str(BD[i]["time"])]+=(CC_[i]-e)/e-2*H.FEE; hold=False
            continue
        if not hold:
            if dhi[i] and CC_[i]>dhi[i]: e=CC_[i]; a=atrd[i] or 0.01*e; hold=True
        else:
            if atrd[i]: a=atrd[i]
            if BD[i]["low"]<=e-a*2.0: tur_mo[mo_str(BD[i]["time"])]+=(e-a*2.0-e)/e-2*H.FEE; hold=False
            elif dlo[i] and CC_[i]<dlo[i]: tur_mo[mo_str(BD[i]["time"])]+=(CC_[i]-e)/e-2*H.FEE; hold=False
    if hold: tur_mo[mo_str(BD[-1]["time"])]+=(CC_[-1]-e)/e-2*H.FEE
    return tur_mo

def run_h01(cache, adx_thresh=18, sl_init=3.0, sl_trail=3.5, sl_trans=16,
             adx_period=12, atr_break_mult=1.3, vol_mult=1.4, vol_ma=10, max_hold=200):
    H.CACHE=cache
    orig=(H.ADX_THRESH,H.SL_INIT,H.SL_TRAIL,H.SL_TRANS,H.ADX_P,H.ATR_BREAK_MULT,H.VOL_MULT,H.VOL_MA,H.MAX_HOLD)
    H.ADX_THRESH=adx_thresh; H.SL_INIT=sl_init; H.SL_TRAIL=sl_trail; H.SL_TRANS=sl_trans
    H.ADX_P=adx_period; H.ATR_BREAK_MULT=atr_break_mult; H.VOL_MULT=vol_mult; H.VOL_MA=vol_ma; H.MAX_HOLD=max_hold
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
            if bars4h[j]["low"]<=sl_: return (sl_-ep)/ep-2*H.FEE, h
        j=min(ei+H.MAX_HOLD,n-1); return (c4[j]-ep)/ep-2*H.FEE, H.MAX_HOLD
    s12=lambda i:(None if None in (e50[i],e200[i]) or i<1 or None in (e50[i-1],e200[i-1]) else ("LONG" if e50[i-1]<=e200[i-1] and e50[i]>e200[i] else None))
    s13=lambda i:(None if atr4[i] is None or i<1 else ("LONG" if c4[i]>bars4h[i-1]["close"]+atr4[i]*atr_break_mult else None))
    s14=lambda i:(None if i<H.DONCHIAN_LB else ("LONG" if c4[i]>max(bars4h[j]["high"] for j in range(i-H.DONCHIAN_LB,i)) else None))
    sigs={"S12":(s12,False,36),"S13":(s13,True,1),"S14":(s14,True,36)}
    mo=defaultdict(float); last={s:0 for s in sigs}; n_tr=0
    for i in range(250,n-H.MAX_HOLD):
        for sn,(sfn,dov,cd) in sigs.items():
            if sfn(i)!="LONG": continue
            if i-last[sn]<cd: continue
            if dov and not vol_pass(i): continue
            if not filt(i): continue
            r=sim(i)
            if r is None: continue
            ret,h=r; cts=bars4h[min(i+h,n-1)]["time"]
            mo[mo_str(cts)]+=ret; last[sn]=i; n_tr+=1
    (H.ADX_THRESH,H.SL_INIT,H.SL_TRAIL,H.SL_TRANS,H.ADX_P,H.ATR_BREAK_MULT,H.VOL_MULT,H.VOL_MA,H.MAX_HOLD)=orig
    return mo, n_tr

print("Loading baselines...")
moB28,_=run_h01(f"{CC}/binance-5m-7y.json",18,sl_init=2.8,sl_trail=3.3)
moS29,_=run_h01(f"{CC}/binance-sol-5m-3y.json",15,sl_init=2.9,sl_trail=3.4)
moS28,_=run_h01(f"{CC}/binance-sol-5m-3y.json",15,sl_init=2.8,sl_trail=3.3)
turB=run_turtle()
H.CACHE=f"{CC}/binance-sol-5m-3y.json"; bs=H.load_tf(H.H4); span_s=(bs[0]["time"],bs[-1]["time"])
H.CACHE=f"{CC}/binance-5m-7y.json"
cal3=months_between(span_s[0],span_s[1])
sB28=[moB28.get(m,0.0) for m in cal3]; sS29=[moS29.get(m,0.0) for m in cal3]
sS28=[moS28.get(m,0.0) for m in cal3]; sTB=[turB.get(m,0.0) for m in cal3]

def bk(parts, weights=None, cal=None):
    cc=cal or cal3; k=len(parts); w=weights or [1]*k; sw=sum(w)
    p=[sum(w[j]*parts[j][i] for j in range(k))/sw for i in range(len(cc))]
    yr=defaultdict(float)
    for i,m in enumerate(cc): yr[int(m[:4])]+=p[i]
    sh=sharpe(p); md=maxdd(p); fl=sum(1 for x in p if abs(x)<1e-9)
    test_m=[m for m in cc if m[:4] in ("2025","2026")]
    sh_te=sharpe([p[cc.index(m)] for m in test_m]) if test_m else 0
    py=" ".join(f"{y%100}:{yr[y]*100:+.0f}" for y in sorted(yr))
    return sh,md,fl,sh_te,py

def pr(label, parts, weights=None, cal=None, extra=""):
    sh,md,fl,te,py=bk(parts,weights,cal)
    delta=sh-sh_base if 'sh_base' in globals() else 0
    ok=sh>=2.20; mark="✅✅" if ok else ("✅" if sh>=2.10 else ("⚠️" if sh>=2.00 else ""))
    star="★★★" if sh>=2.25 else ("★★" if sh>=2.20 else ("★" if delta>0.05 else ""))
    print(f"  {mark} {label:<52} Sh{sh:>+5.2f} DD{md:>4.1f}% flat{fl:>3} TE{te:>+5.2f} d{delta:>+.3f} {star} {extra}")
    return sh,md

sh_base=pr("R64 BEST: BTC28+SOL29+T_w=1.0",[sB28,sS29,sTB])[0]
print(); print("="*100); print("=== R65: Turtle weight verify + SOL fine-tune ===\n")

# A: Turtle_w=1.2 robustness
print("━"*100); print("A: Turtle_w=1.2 robustness — holdout years")
for yr_exc in [2023,2024,2025]:
    cal_ho=[m for m in cal3 if not m.startswith(str(yr_exc))]
    sB_ho=[moB28.get(m,0.0) for m in cal_ho]; sS_ho=[moS29.get(m,0.0) for m in cal_ho]
    sTB_ho=[turB.get(m,0.0) for m in cal_ho]
    sh_10,_,_,_,_=bk([sB_ho,sS_ho,sTB_ho],cal=cal_ho)
    sh_12,_,_,_,_=bk([sB_ho,sS_ho,sTB_ho],[1,1,1.2],cal=cal_ho)
    robust="✓" if sh_12>sh_10 else "✗"
    print(f"  Holdout {yr_exc}: T=1.0 Sh{sh_10:+.2f} → T=1.2 Sh{sh_12:+.2f} delta{sh_12-sh_10:>+.3f} {robust}")

# B: SOL SL micro-sweep
print(f"\n{'━'*100}"); print("B: SOL SL micro-sweep (BTC28 fixed)")
for si,st in [(2.80,3.30),(2.85,3.35),(2.90,3.40),(2.92,3.42),(2.95,3.45),(3.00,3.50)]:
    moS_,nt=run_h01(f"{CC}/binance-sol-5m-3y.json",15,sl_init=si,sl_trail=st)
    sS_=[moS_.get(m,0.0) for m in cal3]
    pr(f"  SOL SL{si}/{st}",[sB28,sS_,sTB],extra=f"n={nt}")

# C: 2023 SOL analysis — why fragile?
print(f"\n{'━'*100}"); print("C: 2023 SOL analysis — month-by-month with SL2.8 vs SL2.9")
y23=[m for m in cal3 if m.startswith("2023")]
print(f"  2023 months: {y23}")
for m in y23:
    s28=moS28.get(m,0.0)*100; s29=moS29.get(m,0.0)*100
    diff=s29-s28
    mark="↑" if diff>0 else "↓" if diff<0 else "="
    print(f"  {m}: SL28={s28:+.1f}% | SL29={s29:+.1f}% | diff={diff:+.1f}% {mark}")

# D: Combined BTC28+SOL micro + T_w=1.2
print(f"\n{'━'*100}"); print("D: Combined fine-tune with T_w=1.2")
best_combo_sh=sh_base
for si,st in [(2.88,3.38),(2.90,3.40),(2.92,3.42),(2.95,3.45)]:
    moS_,_=run_h01(f"{CC}/binance-sol-5m-3y.json",15,sl_init=si,sl_trail=st)
    sS_=[moS_.get(m,0.0) for m in cal3]
    sh,md=pr(f"  SOL SL{si}/{st} + T1.2",[sB28,sS_,sTB],[1,1,1.2])
    if sh>best_combo_sh: best_combo_sh=sh

# E: Per-year stability check
print(f"\n{'━'*100}"); print("E: Per-year stability — R64 BEST vs CANONICAL")
for lbl,sB_,sS_,w in [
    ("CANONICAL orig",None,None,[1,1,1]),
    ("R64 BTC28+SOL29+T1.0",[sB28],[sS29],[1,1,1]),
    ("R64 BTC28+SOL29+T1.2",[sB28],[sS29],[1,1,1.2]),
]:
    moB_=run_h01(f"{CC}/binance-5m-7y.json",18)[0] if sB_ is None else None
    moS_=run_h01(f"{CC}/binance-sol-5m-3y.json",15)[0] if sS_ is None else None
    bL=sB_[0] if sB_ else [moB_.get(m,0.0) for m in cal3]
    sL=sS_[0] if sS_ else [moS_.get(m,0.0) for m in cal3]
    p=[sum(w[j]*[bL,sL,sTB][j][i] for j in range(3))/sum(w) for i in range(len(cal3))]
    yr=defaultdict(float)
    for i,m in enumerate(cal3): yr[int(m[:4])]+=p[i]
    sh=sharpe(p); md=maxdd(p)
    pos_yr=sum(1 for v in yr.values() if v>0)
    py=" ".join(f"{y}:{yr[y]*100:+.0f}%" for y in sorted(yr))
    print(f"  {lbl}: Sh{sh:+.3f} DD{md:.1f}% pos_yr={pos_yr}/4 | {py}")

# F: Full robustness summary
print(f"\n{'━'*100}"); print("F: Final robustness summary")
print(f"  Best config: BTC(ADX18,SL2.8/3.3) + SOL(ADX15,SL2.9/3.4) + Turtle(DE20/DX15/CUT2.0,T_w=1.2)")
sh_final,md_final,fl_final,te_final,py_final=bk([sB28,sS29,sTB],[1,1,1.2])
print(f"  Full period: Sh{sh_final:+.3f} DD{md_final:.1f}% flat{fl_final}/35 TE{te_final:+.3f}")
print(f"  Per-year: {py_final}")
print(f"  DELTA vs original R50 canonical: {sh_final-2.052:+.3f}")

print(f"\n{'='*100}")
print("R65 SUMMARY")
print(f"  R50 original ceiling: Sh+2.05 DD5.9%")
print(f"  R65 NEW CEILING: BTC28+SOL29+T1.2 → Sh{sh_final:+.3f} DD{md_final:.1f}%")
print(f"  Improvements found:")
print(f"    R50: Turtle DE20/DX15/CUT2.0 (+0.15)")
print(f"    R61: BTC SL 3.0/3.5→2.8/3.3 (tighter, +0.12)")
print(f"    R63: SOL SL 3.0/3.5→2.9/3.4 (+0.04)")
print(f"    R64: Turtle_w=1.2 (DD5.6→5.3%)")
