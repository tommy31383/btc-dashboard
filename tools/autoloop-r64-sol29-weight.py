#!/usr/bin/env python3
"""autoloop-r64-sol29-weight.py — Round 64: SOL SL2.9/3.4 verify + weight
R63 finding: SOL SL2.9/3.4 → Sh+2.20 DD5.6% (vs baseline 2.16)
  A: Verify SOL SL2.9/3.4 robustness — holdout
  B: BTC SL sweep with SOL SL2.9/3.4 — maybe different BTC SL now?
  C: Weight optimization [BTC, SOL, Turtle]
  D: Turtle weight tune
  E: Combine best SL + best weight → FINAL
  F: Walk-forward verify of final config
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
moB0,_=run_h01(f"{CC}/binance-5m-7y.json",18)
moS0,_=run_h01(f"{CC}/binance-sol-5m-3y.json",15)
turB=run_turtle()
H.CACHE=f"{CC}/binance-sol-5m-3y.json"; bs=H.load_tf(H.H4); span_s=(bs[0]["time"],bs[-1]["time"])
H.CACHE=f"{CC}/binance-5m-7y.json"
cal3=months_between(span_s[0],span_s[1])
sB28=[moB28.get(m,0.0) for m in cal3]; sS29=[moS29.get(m,0.0) for m in cal3]
sS28=[moS28.get(m,0.0) for m in cal3]; sB0=[moB0.get(m,0.0) for m in cal3]
sS0=[moS0.get(m,0.0) for m in cal3]; sTB=[turB.get(m,0.0) for m in cal3]

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
    star="★★★" if sh>=2.25 else ("★★" if sh>=2.15 else ("★" if delta>0.05 else ""))
    print(f"  {mark} {label:<50} Sh{sh:>+5.2f} DD{md:>4.1f}% flat{fl:>3} TE{te:>+5.2f} d{delta:>+.3f} {star} {extra}")
    return sh,md

sh_base=pr("R63 BEST: BTC28+SOL29+Turtle",[sB28,sS29,sTB])[0]
print(); print("="*100); print("=== R64: SOL2.9/3.4 verify + weight ===\n")

# A: Verify SOL2.9/3.4 robustness
print("━"*100); print("A: SOL SL2.9/3.4 robustness — holdout years")
for yr_exc in [2023,2024,2025]:
    cal_ho=[m for m in cal3 if not m.startswith(str(yr_exc))]
    sB28_ho=[moB28.get(m,0.0) for m in cal_ho]
    sS28_ho=[moS28.get(m,0.0) for m in cal_ho]; sS29_ho=[moS29.get(m,0.0) for m in cal_ho]
    sTB_ho=[turB.get(m,0.0) for m in cal_ho]
    sh_28,_,_,_,_=bk([sB28_ho,sS28_ho,sTB_ho],cal=cal_ho)
    sh_29,_,_,_,_=bk([sB28_ho,sS29_ho,sTB_ho],cal=cal_ho)
    robust="✓ ROBUST" if sh_29>sh_28 else "✗ FRAGILE"
    print(f"  Holdout {yr_exc}: SOL28 Sh{sh_28:+.2f} → SOL29 Sh{sh_29:+.2f} delta{sh_29-sh_28:>+.3f} {robust}")

# B: BTC SL with SOL29
print(f"\n{'━'*100}"); print("B: BTC SL sweep with SOL SL2.9/3.4")
for si,st in [(2.7,3.2),(2.8,3.3),(2.9,3.4),(3.0,3.5)]:
    moB_,nt=run_h01(f"{CC}/binance-5m-7y.json",18,sl_init=si,sl_trail=st)
    sB_=[moB_.get(m,0.0) for m in cal3]
    pr(f"  BTC SL{si}/{st} + SOL2.9",[sB_,sS29,sTB],extra=f"n={nt}")

# C: Weight optimization
print(f"\n{'━'*100}"); print("C: Weight [BTC, SOL, Turtle] — current best SL config")
weights_list=[
    ([1,1,1],"equal 1/1/1"),
    ([1.5,1,1],"BTC 1.5x"),
    ([2,1,1],"BTC 2x"),
    ([1,1.5,1],"SOL 1.5x"),
    ([1,2,1],"SOL 2x"),
    ([1,1,0.5],"Turtle 0.5x"),
    ([1,1,1.5],"Turtle 1.5x"),
    ([1,1,2],"Turtle 2x"),
    ([2,1,0.5],"BTC2+T0.5"),
    ([1.5,1.5,1],"BTC=SOL 1.5x"),
    ([2,2,1],"BTC=SOL 2x"),
    ([3,2,1],"BTC 3 / SOL 2 / T 1"),
]
best_w_sh=sh_base; best_w=None
for w,lbl in weights_list:
    sh,md=pr(f"  {lbl}",[sB28,sS29,sTB],weights=w)
    if sh>best_w_sh: best_w_sh=sh; best_w=(w,lbl)

# D: Turtle weight fine tune
print(f"\n{'━'*100}"); print("D: Turtle weight fine sweep")
for wt in [0.25,0.33,0.5,0.67,0.8,1.0,1.2,1.5]:
    sh,md=pr(f"  Turtle_w={wt}",[sB28,sS29,sTB],[1,1,wt])
    if sh>best_w_sh: best_w_sh=sh; best_w=([1,1,wt],f"T={wt}")

# E: Best combo
print(f"\n{'━'*100}"); print("E: BEST COMBO confirmation")
pr("  CANONICAL (original SL3.0/3.5 equal)",[sB0,sS0,sTB])
pr("  R50 SL R62: BTC28+SOL28 equal",[sB28,sS28,sTB])
pr("  R63 BEST: BTC28+SOL29 equal",[sB28,sS29,sTB])
if best_w:
    w_b,lbl_b=best_w
    pr(f"  R64 BEST: BTC28+SOL29 + weight {lbl_b}",[sB28,sS29,sTB],weights=w_b)

# F: Walk-forward verify
print(f"\n{'━'*100}"); print("F: Walk-forward (70/30 split)")
n_cal=len(cal3); split=int(n_cal*0.7)
cal_train=cal3[:split]; cal_test=cal3[split:]
print(f"  TRAIN: {cal_train[0]}→{cal_train[-1]} | TEST: {cal_test[0]}→{cal_test[-1]}")
for lbl,moB_,moS_ in [("CANONICAL",moB0,moS0),("BTC28+SOL29",moB28,moS29)]:
    sB_=[moB_.get(m,0.0) for m in cal3]; sS_=[moS_.get(m,0.0) for m in cal3]
    sB_tr=[sB_[cal3.index(m)] for m in cal_train]; sS_tr=[sS_[cal3.index(m)] for m in cal_train]; sTB_tr=[sTB[cal3.index(m)] for m in cal_train]
    sB_te=[sB_[cal3.index(m)] for m in cal_test]; sS_te=[sS_[cal3.index(m)] for m in cal_test]; sTB_te=[sTB[cal3.index(m)] for m in cal_test]
    sh_tr,md_tr,_,_,_=bk([sB_tr,sS_tr,sTB_tr],cal=cal_train)
    sh_te,md_te,_,_,_=bk([sB_te,sS_te,sTB_te],cal=cal_test)
    print(f"  {lbl:<20}: TRAIN Sh{sh_tr:>+5.2f} DD{md_tr:>4.1f}% | TEST Sh{sh_te:>+5.2f} DD{md_te:>4.1f}% (decay{sh_tr-sh_te:>+.3f})")

print(f"\n{'='*100}")
print("R64 SUMMARY")
print(f"  R64 best: Sh{sh_base:+.3f} (BTC SL2.8/3.3 + SOL SL2.9/3.4)")
if best_w:
    print(f"  Best weight: {best_w[1]} → Sh{best_w_sh:+.3f}")
print("  → R65: Take winners + explore new direction")
