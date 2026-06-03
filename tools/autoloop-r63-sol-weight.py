#!/usr/bin/env python3
"""autoloop-r63-sol-weight.py — Round 63: SOL tune + weight optimization
R62 CONFIRMED BEST: SL2.8/3.3 BTC+SOL → Sh+2.04 DD5.4% ROBUST 3/3
  A: SOL ADX threshold with SL2.8/3.3 — currently ADX=15, try 12-20
  B: SOL SL fine-sweep around 2.8/3.3
  C: BTC SL fine-sweep 2.6-3.0 / 3.1-3.6 (confirm 2.8/3.3 is peak)
  D: Weight optimization — 1/3 each vs risk-parity vs BTC-heavy
  E: Turtle weight tune — currently 1/3, try 0.2-0.5
  F: New direction: look at SOL-only Sharpe with SL2.8/3.3 — is SOL still contributing?
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

print("Loading baselines (SL2.8/3.3 config)...")
moB,_=run_h01(f"{CC}/binance-5m-7y.json",18,sl_init=2.8,sl_trail=3.3)
moS,_=run_h01(f"{CC}/binance-sol-5m-3y.json",15,sl_init=2.8,sl_trail=3.3)
moB0,_=run_h01(f"{CC}/binance-5m-7y.json",18)
turB=run_turtle()
H.CACHE=f"{CC}/binance-sol-5m-3y.json"; bs=H.load_tf(H.H4); span_s=(bs[0]["time"],bs[-1]["time"])
H.CACHE=f"{CC}/binance-5m-7y.json"
cal3=months_between(span_s[0],span_s[1])
sB=[moB.get(m,0.0) for m in cal3]; sS=[moS.get(m,0.0) for m in cal3]
sB0=[moB0.get(m,0.0) for m in cal3]; sTB=[turB.get(m,0.0) for m in cal3]

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

sh_base=pr("R62 BEST: SL2.8/3.3 BTC+SOL",[sB,sS,sTB])[0]
sh_canonical=bk([sB0,moS.copy() and [run_h01(f"{CC}/binance-sol-5m-3y.json",15)[0].get(m,0.0) for m in cal3],sTB])[0] if False else None
print()
print("="*100); print("=== R63: SOL tune + weight optimization ===\n")

# A: SOL ADX thresh
print("━"*100); print("A: SOL ADX threshold with SL2.8/3.3")
best_sol_adx=15; best_sol_sh=sh_base; best_moS=moS
for adxt in [12,13,14,15,16,17,18,20]:
    moS_,nt=run_h01(f"{CC}/binance-sol-5m-3y.json",adxt,sl_init=2.8,sl_trail=3.3)
    sS_=[moS_.get(m,0.0) for m in cal3]
    sh,md=pr(f"  SOL_ADX={adxt}",[sB,sS_,sTB],extra=f"SOL_n={nt}")
    if sh>best_sol_sh: best_sol_sh=sh; best_sol_adx=adxt; best_moS=moS_

# B: SOL SL fine-sweep
print(f"\n{'━'*100}"); print("B: SOL SL fine-sweep (BTC fixed at 2.8/3.3)")
for si,st in [(2.5,3.0),(2.6,3.1),(2.7,3.2),(2.8,3.3),(2.9,3.4),(3.0,3.5),(3.2,3.7)]:
    moS_,nt=run_h01(f"{CC}/binance-sol-5m-3y.json",15,sl_init=si,sl_trail=st)
    sS_=[moS_.get(m,0.0) for m in cal3]
    pr(f"  SOL SL{si}/{st}",[sB,sS_,sTB],extra=f"SOL_n={nt}")

# C: BTC SL fine-sweep confirm 2.8/3.3 peak
print(f"\n{'━'*100}"); print("C: BTC SL fine-sweep (SOL fixed at 2.8/3.3)")
for si,st in [(2.6,3.1),(2.7,3.2),(2.8,3.3),(2.85,3.35),(2.9,3.4),(3.0,3.5)]:
    moB_,nt=run_h01(f"{CC}/binance-5m-7y.json",18,sl_init=si,sl_trail=st)
    sB_=[moB_.get(m,0.0) for m in cal3]
    pr(f"  BTC SL{si}/{st}",[sB_,sS,sTB],extra=f"BTC_n={nt}")

# D: Weight optimization
print(f"\n{'━'*100}"); print("D: Weight optimization — [BTC, SOL, Turtle]")
for wb,ws,wt in [
    (1,1,1,"equal 1/3"),
    (2,1,1,"BTC-heavy 2/1/1"),
    (1,2,1,"SOL-heavy 1/2/1"),
    (1,1,2,"Turtle-heavy 1/1/2"),
    (3,2,1,"BTC>>SOL 3/2/1"),
    (2,2,1,"BTC=SOL heavy 2/2/1"),
    (1,1,0.5,"Turtle-light 1/1/0.5"),
    (2,1,0.5,"BTC-heavy Turtle-light"),
]:
    if isinstance(wt,str): lbl=wt; wt=1  # backup
    else: lbl=f"{wb}/{ws}/{wt}"
    sh,md=pr(f"  w={lbl}",[sB,sS,sTB],[wb,ws,wt])

# E: Turtle weight tune
print(f"\n{'━'*100}"); print("E: Turtle weight tune (BTC=SOL=1 fixed)")
for wt in [0.25,0.33,0.5,0.67,1.0,1.5,2.0]:
    sh,md=pr(f"  Turtle_w={wt}",[sB,sS,sTB],[1,1,wt])

# F: SOL contribution verify
print(f"\n{'━'*100}"); print("F: SOL contribution — with vs without (new SL config)")
pr("  BTC+SOL+Turtle (current best)",[sB,sS,sTB])
pr("  BTC_only+Turtle (no SOL)",[sB,sTB],[1,1])
sh_sol_alone=sharpe(sS)
print(f"  SOL alone: Sh{sh_sol_alone:+.2f} | corr(BTC,SOL)={sum(a*b for a,b in zip(sB,sS))/(len(sB)*((sum(x**2 for x in sB)/len(sB))**0.5)*((sum(x**2 for x in sS)/len(sS))**0.5)):+.3f}")

print(f"\n{'='*100}")
print("R63 SUMMARY")
print(f"  R62 best: Sh{sh_base:+.3f} DD5.4% (SL2.8/3.3 BTC+SOL)")
print("  → R64: Take winners, final ceiling confirm")
