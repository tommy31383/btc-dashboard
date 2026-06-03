#!/usr/bin/env python3
"""autoloop-r62-final-combine.py — Round 62: Final combine + ceiling report
R61 breakthrough: SL 2.8/3.3 BTC+SOL → Sh+2.04 DD5.4% ROBUST (3/3 holdouts)
  A: Full combine — SL2.8/3.3 + ec + best turtle + BTC+SOL
  B: SL2.8/3.3 BTC+SOL robustness — 3x holdout verify
  C: SL2.8/3.3 + LB=30 robustness (vs fragile at LB=90?)
  D: 7y verify — SL2.8/3.3 vs canonical on full 7y BTC data
  E: Final config head-to-head comparison
  F: New direction: ADX_P (ADX period) — currently 12, try 10-14
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
             ec_bars=24, ec_loss=0.5, atr_pctl=0.70, donchian_lb=20, atr_lb=None):
    H.CACHE=cache
    orig_pctl=H.ATR_PCT_PCTL; orig_lb_=H.ATR_PCT_LB
    H.ATR_PCT_PCTL=atr_pctl
    if atr_lb: H.ATR_PCT_LB=atr_lb
    orig=(H.ADX_THRESH,H.SL_INIT,H.SL_TRAIL,H.SL_TRANS,H.ADX_P,H.ATR_BREAK_MULT,H.VOL_MULT,H.VOL_MA,H.MAX_HOLD,H.DONCHIAN_LB)
    H.ADX_THRESH=adx_thresh; H.SL_INIT=sl_init; H.SL_TRAIL=sl_trail; H.SL_TRANS=sl_trans
    H.ADX_P=adx_period; H.ATR_BREAK_MULT=atr_break_mult; H.VOL_MULT=vol_mult; H.VOL_MA=vol_ma; H.MAX_HOLD=max_hold
    H.DONCHIAN_LB=donchian_lb
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
        return bars4h[i]["volume"]>=ma*vol_mult
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
            if ec_bars and h==ec_bars and ec_loss:
                if c4[j]<ep-ae*ec_loss: return (c4[j]-ep)/ep-2*H.FEE, h
            mult=H.SL_INIT if h<H.SL_TRANS else H.SL_TRAIL
            if c4[j]>hwm: hwm=c4[j]; sl_=hwm-ae*mult
            elif h>=H.SL_TRANS:
                t=hwm-ae*H.SL_TRAIL
                if t>sl_: sl_=t
            if bars4h[j]["low"]<=sl_: return (sl_-ep)/ep-2*H.FEE, h
        j=min(ei+H.MAX_HOLD,n-1); return (c4[j]-ep)/ep-2*H.FEE, H.MAX_HOLD
    s12=lambda i:(None if None in (e50[i],e200[i]) or i<1 or None in (e50[i-1],e200[i-1]) else ("LONG" if e50[i-1]<=e200[i-1] and e50[i]>e200[i] else None))
    s13=lambda i:(None if atr4[i] is None or i<1 else ("LONG" if c4[i]>bars4h[i-1]["close"]+atr4[i]*atr_break_mult else None))
    s14=lambda i:(None if i<donchian_lb else ("LONG" if c4[i]>max(bars4h[j]["high"] for j in range(i-donchian_lb,i)) else None))
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
    (H.ADX_THRESH,H.SL_INIT,H.SL_TRAIL,H.SL_TRANS,H.ADX_P,H.ATR_BREAK_MULT,H.VOL_MULT,H.VOL_MA,H.MAX_HOLD,H.DONCHIAN_LB)=orig
    H.ATR_PCT_PCTL=orig_pctl; H.ATR_PCT_LB=orig_lb_
    return mo, n_tr

print("Loading baselines...")
moB,_=run_h01(f"{CC}/binance-5m-7y.json",18)
moS,_=run_h01(f"{CC}/binance-sol-5m-3y.json",15)
turB=run_turtle()
H.CACHE=f"{CC}/binance-sol-5m-3y.json"; bs=H.load_tf(H.H4); span_s=(bs[0]["time"],bs[-1]["time"])
H.CACHE=f"{CC}/binance-5m-7y.json"; bb_=H.load_tf(H.H4); span_b=(bb_[0]["time"],bb_[-1]["time"])
cal3=months_between(span_s[0],span_s[1]); cal7=months_between(span_b[0],span_b[1])
sB=[moB.get(m,0.0) for m in cal3]; sS=[moS.get(m,0.0) for m in cal3]; sTB=[turB.get(m,0.0) for m in cal3]

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
    ok=sh>=2.10; mark="✅" if ok else ("⚠️" if sh>=2.00 else "")
    star="★★" if sh>=2.15 else ("★" if delta>0.05 else "")
    print(f"  {mark} {label:<52} Sh{sh:>+5.2f} DD{md:>4.1f}% flat{fl:>3} TE{te:>+5.2f} d{delta:>+.3f} {star} {extra}")
    return sh,md

sh_base=pr("BASELINE canonical R50",[sB,sS,sTB])[0]
print()
print("="*100); print("=== R62: Final combine + ceiling report ===\n")

# A: Full combine
print("━"*100); print("A: Full combine — SL2.8/3.3 BTC+SOL + turtle + ec")
moB28,_=run_h01(f"{CC}/binance-5m-7y.json",18,sl_init=2.8,sl_trail=3.3)
moS28,_=run_h01(f"{CC}/binance-sol-5m-3y.json",15,sl_init=2.8,sl_trail=3.3)
sB28=[moB28.get(m,0.0) for m in cal3]; sS28=[moS28.get(m,0.0) for m in cal3]

combos=[
    ("BTC_SL28+SOL_SL28+Turtle",sB28,sS28),
    ("BTC_SL28+SOL_orig+Turtle",sB28,sS),
    ("BTC_orig+SOL_SL28+Turtle",sB,sS28),
]
for lbl,sB_,sS_ in combos:
    pr(f"  {lbl}",[sB_,sS_,sTB])

# B: SL2.8/3.3 BTC+SOL robustness
print(f"\n{'━'*100}"); print("B: SL2.8/3.3 BTC+SOL — holdout years")
for yr_exc in [2023,2024,2025]:
    cal_ho=[m for m in cal3 if not m.startswith(str(yr_exc))]
    sB_ho=[moB.get(m,0.0) for m in cal_ho]; sB28_ho=[moB28.get(m,0.0) for m in cal_ho]
    sS_ho=[moS.get(m,0.0) for m in cal_ho]; sS28_ho=[moS28.get(m,0.0) for m in cal_ho]
    sTB_ho=[turB.get(m,0.0) for m in cal_ho]
    sh_o,_,_,_,_=bk([sB_ho,sS_ho,sTB_ho],cal=cal_ho)
    sh_n,_,_,_,_=bk([sB28_ho,sS28_ho,sTB_ho],cal=cal_ho)
    robust="✓ ROBUST" if sh_n>sh_o else "✗ FRAGILE"
    print(f"  Holdout {yr_exc}: base Sh{sh_o:+.2f} → SL2.8/3.3 Sh{sh_n:+.2f} delta{sh_n-sh_o:>+.3f} {robust}")

# C: SL2.8/3.3 + LB=30 robustness
print(f"\n{'━'*100}"); print("C: SL2.8/3.3 BTC + LB=30 BTC robustness")
moB28lb30,_=run_h01(f"{CC}/binance-5m-7y.json",18,sl_init=2.8,sl_trail=3.3,atr_lb=30)
sB28lb30=[moB28lb30.get(m,0.0) for m in cal3]
pr("  SL2.8/3.3+LB30 BTC + SOL_orig",[sB28lb30,sS,sTB])
for yr_exc in [2023,2024,2025]:
    cal_ho=[m for m in cal3 if not m.startswith(str(yr_exc))]
    sB_ho=[moB.get(m,0.0) for m in cal_ho]; sB_lb_ho=[moB28lb30.get(m,0.0) for m in cal_ho]
    sS_ho=[moS.get(m,0.0) for m in cal_ho]; sTB_ho=[turB.get(m,0.0) for m in cal_ho]
    sh_o,_,_,_,_=bk([sB_ho,sS_ho,sTB_ho],cal=cal_ho)
    sh_n,_,_,_,_=bk([sB_lb_ho,sS_ho,sTB_ho],cal=cal_ho)
    robust="✓ ROBUST" if sh_n>sh_o else "✗ FRAGILE"
    print(f"  Holdout {yr_exc}: base Sh{sh_o:+.2f} → SL28+LB30 Sh{sh_n:+.2f} delta{sh_n-sh_o:>+.3f} {robust}")

# D: 7y BTC verify
print(f"\n{'━'*100}"); print("D: 7y BTC Sharpe — canonical vs SL2.8/3.3")
H.CACHE=f"{CC}/binance-5m-7y.json"
moB7,_=run_h01(f"{CC}/binance-5m-7y.json",18)
moB28_7,_=run_h01(f"{CC}/binance-5m-7y.json",18,sl_init=2.8,sl_trail=3.3)
sB7=[moB7.get(m,0.0) for m in cal7]; sB28_7=[moB28_7.get(m,0.0) for m in cal7]
sTB7=[turB.get(m,0.0) for m in cal7]
sh_7=sharpe(sB7); sh_28_7=sharpe(sB28_7); md_7=maxdd(sB7); md_28_7=maxdd(sB28_7)
print(f"  BTC alone 7y: canonical Sh{sh_7:+.2f} DD{md_7:.1f}%  |  SL2.8/3.3 Sh{sh_28_7:+.2f} DD{md_28_7:.1f}%")

# E: ADX_P sweep (new direction)
print(f"\n{'━'*100}"); print("E: ADX_PERIOD sweep (currently=12)")
for adxp in [8,10,11,12,13,14,16]:
    moB_,nt=run_h01(f"{CC}/binance-5m-7y.json",18,adx_period=adxp,sl_init=2.8,sl_trail=3.3)
    sB_=[moB_.get(m,0.0) for m in cal3]
    pr(f"  ADX_P={adxp} SL2.8/3.3",[sB_,sS28,sTB],extra=f"n={nt}")

# F: FINAL CONFIG HEAD-TO-HEAD
print(f"\n{'━'*100}"); print("F: FINAL CONFIG comparison")
print(f"  {'Config':<54} {'Sh':>6} {'DD':>5} {'flat':>5} {'TE':>7} {'delta':>8}")
print("  "+"-"*85)
final_configs=[
    ("R50 canonical (ref)", moB, moS, "ref"),
    ("R50 + ec24/0.5", None, None, "ec"),
    ("R61: BTC+SOL SL2.8/3.3", moB28, moS28, "sl"),
    ("R61+ec: SL2.8/3.3 + ec24/0.5", None, None, "sl+ec"),
]
for lbl,mB_,mS_,tag in final_configs:
    if mB_ is None:
        mB__,_=run_h01(f"{CC}/binance-5m-7y.json",18,sl_init=2.8 if tag!="ec" else 3.0,
                         sl_trail=3.3 if tag!="ec" else 3.5,ec_bars=24,ec_loss=0.5)
        mS__,_=run_h01(f"{CC}/binance-sol-5m-3y.json",15,sl_init=2.8 if tag!="ec" else 3.0,sl_trail=3.3 if tag!="ec" else 3.5,ec_bars=24,ec_loss=0.5)
        mB_=[mB__.get(m,0.0) for m in cal3]; mS_=[mS__.get(m,0.0) for m in cal3]
    else:
        mB_=[mB_.get(m,0.0) for m in cal3]; mS_=[mS_.get(m,0.0) for m in cal3]
    sh,md,fl,te,py=bk([mB_,mS_,sTB])
    delta=sh-sh_base
    ok="✅" if sh>=2.10 else ("⚠️" if sh>=2.00 else "")
    star="★★" if sh>=2.15 else ("★" if delta>0.05 else "")
    print(f"  {ok}{star} {lbl:<52} Sh{sh:>+5.2f} DD{md:>4.1f}% flat{fl:>3} TE{te:>+5.2f} delta{delta:>+6.3f}")

print(f"\n{'='*100}")
print("R62 CEILING REPORT")
print(f"  R50-R62 optimization history:")
print(f"    R50: Turtle DE20/DX15/CUT2.0 → Sh+2.06 (major, +0.15 vs R49)")
print(f"    R51-R56: Entry/exit/new-signal exhausted → nothing beats trailing/breakout")
print(f"    R57: D_LB=18 marginal at pctl=0.50 only")
print(f"    R58: ATR_LB=30 → +0.07 but fragile 2025")
print(f"    R61: SL2.8/3.3 BTC+SOL → +0.12 ROBUST (3/3 holdouts)")
print(f"  BEST CURRENT: SL2.8/3.3 BTC+SOL → Sh~+2.04 DD5.4%")
print(f"  → R63: Continue with new direction or confirm FINAL")
