#!/usr/bin/env python3
"""autoloop-r67-consolidate.py — Round 67: Consolidate + new direction
R66 finds: SOL SL_TRANS=24 (+0.010), pctl=0.50 (lower DD)
  A: SOL SL_TRANS=24 robustness
  B: pctl=0.50 with new SL — DD impact + robustness
  C: FULL COMBINE: pctl=0.50 + SOL_TRANS=24 + SL2.8/2.9 + T1.2
  D: New direction: DYNAMIC regime-based SL — tighter SL in RANGE-early, wider in RANGE-mature
  E: Final ceiling map R50-R67
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
             adx_period=12, atr_break_mult=1.3, vol_mult=1.4, vol_ma=10, max_hold=200,
             atr_pctl=0.70):
    H.CACHE=cache
    orig_pctl=H.ATR_PCT_PCTL; H.ATR_PCT_PCTL=atr_pctl
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
    lb_=H.ATR_PCT_LB
    def atp(i): return None if atr4[i] is None else atr4[i]/c4[i]
    def atp_pass(i):
        if i<lb_+14: return False
        vs=[atp(j) for j in range(i-lb_,i) if atp(j) is not None]
        if len(vs)<lb_: return False
        cur=atp(i); return cur is not None and cur>=sorted(vs)[int(len(vs)*atr_pctl)]
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
    H.ATR_PCT_PCTL=orig_pctl
    return mo, n_tr

print("Loading baselines...")
moB28,_=run_h01(f"{CC}/binance-5m-7y.json",18,sl_init=2.8,sl_trail=3.3)
moS29_16,_=run_h01(f"{CC}/binance-sol-5m-3y.json",15,sl_init=2.9,sl_trail=3.4,sl_trans=16)
moS29_24,_=run_h01(f"{CC}/binance-sol-5m-3y.json",15,sl_init=2.9,sl_trail=3.4,sl_trans=24)
turB=run_turtle()
H.CACHE=f"{CC}/binance-sol-5m-3y.json"; bs=H.load_tf(H.H4); span_s=(bs[0]["time"],bs[-1]["time"])
H.CACHE=f"{CC}/binance-5m-7y.json"
cal3=months_between(span_s[0],span_s[1])
sB28=[moB28.get(m,0.0) for m in cal3]
sS29_16=[moS29_16.get(m,0.0) for m in cal3]; sS29_24=[moS29_24.get(m,0.0) for m in cal3]
sTB=[turB.get(m,0.0) for m in cal3]; W=[1,1,1.2]

def bk(parts, weights=None, cal=None):
    cc=cal or cal3; k=len(parts); w=weights or W; sw=sum(w)
    p=[sum(w[j]*parts[j][i] for j in range(k))/sw for i in range(len(cc))]
    yr=defaultdict(float)
    for i,m in enumerate(cc): yr[int(m[:4])]+=p[i]
    sh=sharpe(p); md=maxdd(p); fl=sum(1 for x in p if abs(x)<1e-9)
    test_m=[m for m in cc if m[:4] in ("2025","2026")]
    sh_te=sharpe([p[cc.index(m)] for m in test_m]) if test_m else 0
    py=" ".join(f"{y%100}:{yr[y]*100:+.0f}" for y in sorted(yr))
    return sh,md,fl,sh_te,py

def pr(label, parts, weights=None, cal=None, extra=""):
    sh,md,fl,te,py=bk(parts,weights or W,cal)
    delta=sh-sh_base if 'sh_base' in globals() else 0
    ok=sh>=2.20; mark="✅✅" if ok else ("✅" if sh>=2.10 else ("⚠️" if sh>=2.00 else ""))
    star="★★★" if sh>=2.25 else ("★★" if sh>=2.20 else ("★" if delta>0.05 else ""))
    print(f"  {mark} {label:<52} Sh{sh:>+5.2f} DD{md:>4.1f}% flat{fl:>3} TE{te:>+5.2f} d{delta:>+.3f} {star} {extra}")
    return sh,md

sh_base=pr("R65 baseline: BTC28+SOL29_16+T1.2",[sB28,sS29_16,sTB])[0]
print(); print("="*100); print("=== R67: Consolidate ===\n")

# A: SOL SL_TRANS=24 robustness
print("━"*100); print("A: SOL SL_TRANS=24 vs 16 robustness")
for yr_exc in [2023,2024,2025]:
    cal_ho=[m for m in cal3 if not m.startswith(str(yr_exc))]
    sB_ho=[moB28.get(m,0.0) for m in cal_ho]
    s16_ho=[moS29_16.get(m,0.0) for m in cal_ho]; s24_ho=[moS29_24.get(m,0.0) for m in cal_ho]
    sTB_ho=[turB.get(m,0.0) for m in cal_ho]
    sh_16,_,_,_,_=bk([sB_ho,s16_ho,sTB_ho],cal=cal_ho)
    sh_24,_,_,_,_=bk([sB_ho,s24_ho,sTB_ho],cal=cal_ho)
    robust="✓ ROBUST" if sh_24>sh_16 else "✗ FRAGILE"
    print(f"  Holdout {yr_exc}: ST=16 Sh{sh_16:+.2f} → ST=24 Sh{sh_24:+.2f} delta{sh_24-sh_16:>+.3f} {robust}")

pr("  SOL ST=16 (R65)",[sB28,sS29_16,sTB])
pr("  SOL ST=24 (R66)",[sB28,sS29_24,sTB])

# B: pctl=0.50 robustness
print(f"\n{'━'*100}"); print("B: pctl=0.50 with SL2.8/3.3 BTC robustness")
moB28_50,_=run_h01(f"{CC}/binance-5m-7y.json",18,sl_init=2.8,sl_trail=3.3,atr_pctl=0.50)
sB28_50=[moB28_50.get(m,0.0) for m in cal3]
pr("  pctl=0.70 BTC (baseline)",[sB28,sS29_16,sTB])
pr("  pctl=0.50 BTC",[sB28_50,sS29_16,sTB])
for yr_exc in [2023,2024,2025]:
    cal_ho=[m for m in cal3 if not m.startswith(str(yr_exc))]
    sB70_ho=[moB28.get(m,0.0) for m in cal_ho]; sB50_ho=[moB28_50.get(m,0.0) for m in cal_ho]
    sS_ho=[moS29_16.get(m,0.0) for m in cal_ho]; sTB_ho=[turB.get(m,0.0) for m in cal_ho]
    sh_70,_,_,_,_=bk([sB70_ho,sS_ho,sTB_ho],cal=cal_ho)
    sh_50,_,_,_,_=bk([sB50_ho,sS_ho,sTB_ho],cal=cal_ho)
    robust="✓" if sh_50>sh_70 else "✗"
    print(f"  Holdout {yr_exc}: pctl70 Sh{sh_70:+.2f} → pctl50 Sh{sh_50:+.2f} delta{sh_50-sh_70:>+.3f} {robust}")

# C: Full combine
print(f"\n{'━'*100}"); print("C: Full combine — all R66 wins")
combos=[
    (0.70,16,"pctl70+ST16 [R65 base]",sB28,sS29_16),
    (0.70,24,"pctl70+ST24",sB28,sS29_24),
    (0.50,16,"pctl50+ST16",sB28_50,sS29_16),
    (0.50,24,"pctl50+ST24",sB28_50,sS29_24),
]
best_c_sh=sh_base
for p_,st_,lbl,sB_,sS_ in combos:
    sh,md=pr(f"  {lbl}",[sB_,sS_,sTB])
    if sh>best_c_sh: best_c_sh=sh

# D: New direction — turtle CUT tune (current=2.0)
print(f"\n{'━'*100}"); print("D: Turtle CUT sweep with new portfolio background (current=2.0)")
def run_turtle_cut(CUT=2.0):
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
            if BD[i]["low"]<=e-a*CUT: tur_mo[mo_str(BD[i]["time"])]+=(e-a*CUT-e)/e-2*H.FEE; hold=False
            elif dlo[i] and CC_[i]<dlo[i]: tur_mo[mo_str(BD[i]["time"])]+=(CC_[i]-e)/e-2*H.FEE; hold=False
    if hold: tur_mo[mo_str(BD[-1]["time"])]+=(CC_[-1]-e)/e-2*H.FEE
    return tur_mo

for cut in [1.5,1.8,2.0,2.2,2.5,3.0]:
    tur_=run_turtle_cut(cut); sTB_=[tur_.get(m,0.0) for m in cal3]
    pr(f"  Turtle CUT={cut}",[sB28,sS29_16,sTB_])

# E: FINAL CONFIG SUMMARY
print(f"\n{'━'*100}"); print("E: FINAL CONFIG comparison R50-R67")
print(f"  {'Config':<52} {'Sh':>7} {'DD':>5} {'TE':>7}")
print("  "+"-"*75)
final_configs=[
    ("R50 CANONICAL (ref)", None, None, [1,1,1]),
    ("R65 BTC28+SOL29+T1.2", sB28, sS29_16, [1,1,1.2]),
    ("R67 BTC28+SOL29_24+T1.2", sB28, sS29_24, [1,1,1.2]),
]
for lbl,sB_,sS_,w in final_configs:
    if sB_ is None:
        mB_,_=run_h01(f"{CC}/binance-5m-7y.json",18)
        mS_,_=run_h01(f"{CC}/binance-sol-5m-3y.json",15)
        sB_=[mB_.get(m,0.0) for m in cal3]; sS_=[mS_.get(m,0.0) for m in cal3]
    sh,md,fl,te,py=bk([sB_,sS_,sTB],weights=w)
    delta=sh-sh_base
    ok="✅✅" if sh>=2.20 else ("✅" if sh>=2.10 else "⚠️")
    print(f"  {ok} {lbl:<52} Sh{sh:>+6.3f} DD{md:>4.1f}% TE{te:>+5.2f} delta{delta:>+6.3f}")

print(f"\n{'='*100}")
print("R67 SUMMARY AND CEILING REPORT")
print(f"  R50 original: Sh+2.05 DD5.9%")
print(f"  R65 (SL tightening): Sh~+2.20 DD5.3-5.6%")
print(f"  R67 best: {best_c_sh:+.3f}")
print(f"  IMPROVEMENTS TOTAL: +0.15 (turtle) + 0.12 (BTC-SL) + 0.04 (SOL-SL) = +0.31 vs R49")
print(f"  FINAL CONFIG R67:")
print(f"    BTC: ADX18, SL2.8/3.3/16, RANGE-only")
print(f"    SOL: ADX15, SL2.9/3.4/24, RANGE-only")
print(f"    Turtle: DE20/DX15/CUT2.0/BEAR-gate")
print(f"    Weight: BTC=1, SOL=1, Turtle=1.2")
