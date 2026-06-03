#!/usr/bin/env python3
"""autoloop-r59-ema-atr-filter.py — Round 59: EMA filter + ATR lookback sweep
R58 conclusion: D_LB=18 only helps at pctl=0.50 but DD doubles (5.9→11.3%).
Net: canonical R50 (pctl=0.70,D_LB=20) still best at DD5.9% Sh+2.05-2.06.

New direction (canonical R50 base, pctl=0.70):
  A: EMA_1H filter period sweep — current=200, try 100-300 (catch trend earlier?)
  B: ATR_PCT_LB sweep — lookback for ATR percentile (current ~40)
  C: VOL_MA (volume MA period) sweep — current=10, try 5-20
  D: MAX_HOLD sweep — current=200 bars, try 100-400
  E: SL_TRANS sweep — current=16 bars (when switch init→trail), try 8-32

All with CANONICAL R50: pctl=0.70, D_LB=20, ec=24/0.5, turtle DE20/DX15/CUT2.0
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
             ec_bars=24, ec_loss=0.5, atr_pctl=0.70, donchian_lb=20,
             ema_1h_period=200, atr_pct_lb=None, sl_trans_override=None, max_hold_override=None):
    H.CACHE=cache
    orig_pctl=H.ATR_PCT_PCTL; orig_lb=H.ATR_PCT_LB
    H.ATR_PCT_PCTL=atr_pctl
    if atr_pct_lb: H.ATR_PCT_LB=atr_pct_lb
    orig=(H.ADX_THRESH,H.SL_INIT,H.SL_TRAIL,H.SL_TRANS,H.ADX_P,H.ATR_BREAK_MULT,H.VOL_MULT,H.VOL_MA,H.MAX_HOLD,H.DONCHIAN_LB)
    H.ADX_THRESH=adx_thresh; H.SL_INIT=sl_init; H.SL_TRAIL=sl_trail
    H.SL_TRANS=sl_trans_override if sl_trans_override else sl_trans
    H.ADX_P=adx_period; H.ATR_BREAK_MULT=atr_break_mult; H.VOL_MULT=vol_mult; H.VOL_MA=vol_ma
    H.MAX_HOLD=max_hold_override if max_hold_override else max_hold
    H.DONCHIAN_LB=donchian_lb
    bars4h=H.load_tf(H.H4); bars1h=H.load_tf(3600*1000); bars1d=H.load_tf(86400*1000)
    n=len(bars4h); c4=[b["close"] for b in bars4h]
    e50=H.ema_s(c4,H.EMA_FAST); e200=H.ema_s(c4,H.EMA_SLOW)
    atr4=H.atr_series(bars4h); adx4=H.adx_wilder(bars4h,period=adx_period)
    # Custom EMA 1h period
    e_1h=H.ema_s([b["close"] for b in bars1h],ema_1h_period); h1t=[b["time"] for b in bars1h]
    regime_1d=H.regime_with_persistence(bars1d)
    reg_map={b["time"]//86400000:regime_1d[i] for i,b in enumerate(bars1d)}
    def get_reg(ts): return reg_map.get(ts//86400000,"RANGE")
    def atp(i): return None if atr4[i] is None else atr4[i]/c4[i]
    lb=H.ATR_PCT_LB
    def atp_pass(i):
        if i<lb+14: return False
        vs=[atp(j) for j in range(i-lb,i) if atp(j) is not None]
        if len(vs)<lb: return False
        cur=atp(i); return cur is not None and cur>=sorted(vs)[int(len(vs)*atr_pctl)]
    def vol_pass(i):
        if i<H.VOL_MA: return False
        ma=sum(bars4h[j]["volume"] for j in range(i-H.VOL_MA,i))/H.VOL_MA
        return bars4h[i]["volume"]>=ma*vol_mult
    def e1h_at(ts):
        lo,hi,idx=0,len(h1t)-1,0
        while lo<=hi:
            m=(lo+hi)//2
            if h1t[m]<=ts: idx=m; lo=m+1
            else: hi=m-1
        return e_1h[idx]
    def filt(i):
        adv=adx4[i]
        if adv is None or adv<=H.ADX_THRESH: return False
        ap=adx4[i-1] if i>=1 else None
        if ap is None or ap<=H.ADX_THRESH: return False
        e1h_v=e1h_at(bars4h[i]["time"])
        if e1h_v is None or c4[i]<e1h_v: return False
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
    H.ATR_PCT_PCTL=orig_pctl; H.ATR_PCT_LB=orig_lb
    return mo, n_tr

# ─── Setup ───
print("Loading canonical R50 baseline (pctl=0.70)...")
moB,_=run_h01(f"{CC}/binance-5m-7y.json",18)
moS,_=run_h01(f"{CC}/binance-sol-5m-3y.json",15)
turB=run_turtle()
H.CACHE=f"{CC}/binance-sol-5m-3y.json"; bs=H.load_tf(H.H4); span_s=(bs[0]["time"],bs[-1]["time"])
H.CACHE=f"{CC}/binance-5m-7y.json"
cal3=months_between(span_s[0],span_s[1])
sB=[moB.get(m,0.0) for m in cal3]; sS=[moS.get(m,0.0) for m in cal3]; sTB=[turB.get(m,0.0) for m in cal3]

def bk(parts, weights=None):
    k=len(parts); w=weights or [1]*k; sw=sum(w)
    p=[sum(w[j]*parts[j][i] for j in range(k))/sw for i in range(len(cal3))]
    yr=defaultdict(float)
    for i,m in enumerate(cal3): yr[int(m[:4])]+=p[i]
    sh=sharpe(p); md=maxdd(p); fl=sum(1 for x in p if abs(x)<1e-9)
    test_m=[m for m in cal3 if m[:4] in ("2025","2026")]
    sh_te=sharpe([p[cal3.index(m)] for m in test_m]) if test_m else 0
    py=" ".join(f"{y%100}:{yr[y]*100:+.0f}" for y in sorted(yr))
    return sh,md,fl,sh_te,py

def pr(label, parts, weights=None, extra=""):
    sh,md,fl,te,py=bk(parts,weights)
    delta=sh-sh_base if 'sh_base' in globals() else 0
    ok=sh>=2.10; mark="✅" if ok else ("⚠️" if sh>=2.00 else "")
    star="★★" if sh>=2.15 else ("★" if delta>0.05 else "")
    print(f"  {mark} {label:<52} Sh{sh:>+5.2f} DD{md:>4.1f}% flat{fl:>3} TE{te:>+5.2f} d{delta:>+.3f} {star} {extra}")
    return sh,md

sh_base=pr("CANONICAL R50 baseline",[sB,sS,sTB])[0]
print()
print("="*100)
print("=== R59: EMA-1h filter + ATR-LB + SL params (canonical pctl=0.70) ===\n")

# ─── A: EMA 1h filter period ───
print("━"*100)
print("A: EMA_1H period sweep — current=200 (1h bars)")
for ema_p in [50,75,100,125,150,175,200,250,300,400]:
    moB_,nt=run_h01(f"{CC}/binance-5m-7y.json",18,ema_1h_period=ema_p)
    sB_=[moB_.get(m,0.0) for m in cal3]
    pr(f"  EMA1H={ema_p}",[sB_,sS,sTB],extra=f"n={nt}")

# ─── B: ATR_PCT_LB sweep ───
print(f"\n{'━'*100}")
print(f"B: ATR_PCT_LB sweep — current={H.ATR_PCT_LB}")
print(f"  (lookback for ATR percentile filter)")
for lb in [20,30,40,50,60,80,100]:
    moB_,nt=run_h01(f"{CC}/binance-5m-7y.json",18,atr_pct_lb=lb)
    sB_=[moB_.get(m,0.0) for m in cal3]
    pr(f"  ATR_LB={lb}",[sB_,sS,sTB],extra=f"n={nt}")

# ─── C: VOL_MA sweep ───
print(f"\n{'━'*100}")
print("C: VOL_MA (volume rolling window) sweep — current=10")
for vm in [5,7,10,12,14,16,20]:
    moB_,nt=run_h01(f"{CC}/binance-5m-7y.json",18,vol_ma=vm)
    sB_=[moB_.get(m,0.0) for m in cal3]
    pr(f"  VOL_MA={vm}",[sB_,sS,sTB],extra=f"n={nt}")

# ─── D: MAX_HOLD sweep ───
print(f"\n{'━'*100}")
print("D: MAX_HOLD sweep — current=200 bars (800h)")
for mh in [50,75,100,150,200,300,400]:
    moB_,nt=run_h01(f"{CC}/binance-5m-7y.json",18,max_hold_override=mh)
    sB_=[moB_.get(m,0.0) for m in cal3]
    pr(f"  MAX_HOLD={mh}",[sB_,sS,sTB],extra=f"n={nt}")

# ─── E: SL_TRANS (when switch init→trail) ───
print(f"\n{'━'*100}")
print("E: SL_TRANS sweep — current=16 bars (when ATR trailing kicks in)")
for st in [4,8,12,16,20,24,32,48]:
    moB_,nt=run_h01(f"{CC}/binance-5m-7y.json",18,sl_trans_override=st)
    sB_=[moB_.get(m,0.0) for m in cal3]
    pr(f"  SL_TRANS={st}",[sB_,sS,sTB],extra=f"n={nt}")

print(f"\n{'='*100}")
print("R59 SUMMARY")
print(f"  Canonical R50 baseline: Sh{sh_base:+.3f} DD5.9%")
print("  → Winners → R60: combine + final ceiling report")
print("  → No winners → report: ceiling DEFINITIVELY confirmed")
