#!/usr/bin/env python3
"""autoloop-r87-sol-st.py — Round 87: SOL SL_TRANS=20 verify
R86: SOL SL_TRANS=20 → Sh+2.48 DD4.6% (+0.046 ★★★★)
  A: SOL SL_TRANS fine sweep 14-28 — confirm 20 peak
  B: SOL SL_TRANS=20 robustness — holdout years
  C: BTC SL_TRANS sweep with R86 config (was 16 optimal, check with new SOL)
  D: Combine all: SOL ST=20 + all R85 params
  E: SOL SL + ST interaction (tight ST → might want looser SL?)
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
    dhi=[None]*nd; dlo=[None]*nd; DE=20; DX=14
    for i in range(DE,nd): dhi[i]=max(BD[j]["high"] for j in range(i-DE,i))
    for i in range(DX,nd): dlo[i]=min(BD[j]["low"] for j in range(i-DX,i))
    tur_mo=defaultdict(float); hold=False; e=0.0; a=0.0
    for i in range(max(DE,DX),nd):
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
             skip_months=None, donchian_lb=18):
    H.CACHE=cache
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
    def atp(i): return None if atr4[i] is None else atr4[i]/c4[i]
    def atp_pass(i):
        if i<H.ATR_PCT_LB+14: return False
        vs=[atp(j) for j in range(i-H.ATR_PCT_LB,i) if atp(j) is not None]
        if len(vs)<H.ATR_PCT_LB: return False
        cur=atp(i); return cur is not None and cur>=sorted(vs)[int(len(vs)*H.ATR_PCT_PCTL)]
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
        if get_reg(bars4h[i]["time"])!="RANGE": return False
        if skip_months:
            ts_dt=datetime.datetime.utcfromtimestamp(bars4h[i]["time"]/1000)
            if ts_dt.month in skip_months: return False
        return True
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
    return mo, n_tr

print("Loading baselines...")
moB,_=run_h01(f"{CC}/binance-5m-7y.json",18,sl_init=2.78,sl_trail=3.28,skip_months={8},donchian_lb=18,vol_ma=16)
moS24,_=run_h01(f"{CC}/binance-sol-5m-3y.json",15,sl_init=2.9,sl_trail=3.4,sl_trans=24,donchian_lb=20,vol_ma=16,atr_break_mult=1.5)
moS20,_=run_h01(f"{CC}/binance-sol-5m-3y.json",15,sl_init=2.9,sl_trail=3.4,sl_trans=20,donchian_lb=20,vol_ma=16,atr_break_mult=1.5)
turB14=run_turtle()
H.CACHE=f"{CC}/binance-sol-5m-3y.json"; bs=H.load_tf(H.H4); span_s=(bs[0]["time"],bs[-1]["time"])
H.CACHE=f"{CC}/binance-5m-7y.json"
cal3=months_between(span_s[0],span_s[1])
sB=[moB.get(m,0.0) for m in cal3]; sS24=[moS24.get(m,0.0) for m in cal3]
sS20=[moS20.get(m,0.0) for m in cal3]; sTB14=[turB14.get(m,0.0) for m in cal3]; W=[1,1,1.2]

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
    ok=sh>=2.46; mark="✅✅✅✅✅" if ok else ("✅✅✅✅" if sh>=2.42 else ("✅✅✅" if sh>=2.35 else ("✅✅" if sh>=2.25 else ("✅" if sh>=2.10 else ("⚠️" if sh>=2.00 else "")))))
    star="★★★★★" if sh>=2.52 else ("★★★★" if sh>=2.50 else ("★★★" if sh>=2.47 else ("★★" if sh>=2.44 else ("★" if delta>0.05 else ""))))
    print(f"  {mark} {label:<54} Sh{sh:>+5.2f} DD{md:>4.1f}% flat{fl:>3} TE{te:>+5.2f} d{delta:>+.3f} {star} {extra}")
    return sh,md

sh_base,_=pr("R85 BASELINE (SOL ST=24)",[sB,sS24,sTB14])
pr("  SOL ST=20 (R86 find)",[sB,sS20,sTB14])
print(); print("="*100); print("=== R87: SOL ST=20 verify ===\n")

# A: SOL ST fine sweep
print("━"*100); print("A: SOL SL_TRANS fine sweep 14-28 — confirm 20 peak")
best_st=24; best_st_sh=sh_base; best_moS=moS24
for st_ in [14,16,17,18,19,20,21,22,24,26,28]:
    moS_,nt=run_h01(f"{CC}/binance-sol-5m-3y.json",15,sl_init=2.9,sl_trail=3.4,sl_trans=st_,donchian_lb=20,vol_ma=16,atr_break_mult=1.5)
    sS_=[moS_.get(m,0.0) for m in cal3]
    sh,md=pr(f"  SOL ST={st_}",[sB,sS_,sTB14],extra=f"n={nt}")
    if sh>best_st_sh: best_st_sh=sh; best_st=st_; best_moS=moS_
print(f"\n  → Best SOL ST={best_st} Sh{best_st_sh:+.3f}")

# B: SOL ST=20 robustness
print(f"\n{'━'*100}"); print("B: SOL ST=20 vs ST=24 robustness — holdout years")
for yr_exc in [2023,2024,2025]:
    cal_ho=[m for m in cal3 if not m.startswith(str(yr_exc))]
    sB_ho=[moB.get(m,0.0) for m in cal_ho]
    sS24_ho=[moS24.get(m,0.0) for m in cal_ho]; sS20_ho=[moS20.get(m,0.0) for m in cal_ho]
    sTB_ho=[turB14.get(m,0.0) for m in cal_ho]
    sh_24,_,_,_,_=bk([sB_ho,sS24_ho,sTB_ho],cal=cal_ho)
    sh_20,md_20,_,_,_=bk([sB_ho,sS20_ho,sTB_ho],cal=cal_ho)
    delta=sh_20-sh_24
    robust="✓ ROBUST" if delta>0 else "✗ FRAGILE"
    print(f"  Holdout {yr_exc}: ST24 Sh{sh_24:+.2f} → ST20 Sh{sh_20:+.2f} DD{md_20:.1f}% delta{delta:>+.3f} {robust}")

# C: BTC SL_TRANS with SOL ST=20
print(f"\n{'━'*100}"); print("C: BTC SL_TRANS sweep with SOL ST=20")
sBest_S=[best_moS.get(m,0.0) for m in cal3]
for st_ in [8,10,12,14,16,18,20]:
    moB_,nt=run_h01(f"{CC}/binance-5m-7y.json",18,sl_init=2.78,sl_trail=3.28,skip_months={8},donchian_lb=18,vol_ma=16,sl_trans=st_)
    sB_=[moB_.get(m,0.0) for m in cal3]
    pr(f"  BTC ST={st_}",[sB_,sBest_S,sTB14],extra=f"n={nt}")

# D: Full combine
print(f"\n{'━'*100}"); print("D: Full combine — SOL ST=20 all params")
pr("  R85 (SOL ST=24)",[sB,sS24,sTB14])
pr(f"  R87 (SOL ST={best_st})",[sB,sBest_S,sTB14])

# E: SOL SL with ST=20
print(f"\n{'━'*100}"); print("E: SOL SL micro with ST=20")
for si,st in [(2.85,3.35),(2.88,3.38),(2.90,3.40),(2.92,3.42)]:
    moS_,nt=run_h01(f"{CC}/binance-sol-5m-3y.json",15,sl_init=si,sl_trail=st,sl_trans=best_st,donchian_lb=20,vol_ma=16,atr_break_mult=1.5)
    sS_=[moS_.get(m,0.0) for m in cal3]
    pr(f"  SOL SL{si}/{st} ST{best_st}",[sB,sS_,sTB14],extra=f"n={nt}")

print(f"\n{'='*100}")
print(f"R87 SUMMARY — Ceiling Sh{sh_base:+.3f}")
print(f"  Best SOL ST: {best_st} → Sh{best_st_sh:+.3f}")
print(f"  SOL ST=20 ROBUST? → see section B")
