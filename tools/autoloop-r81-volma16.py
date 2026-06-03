#!/usr/bin/env python3
"""autoloop-r81-volma16.py — Round 81: vol_ma=16 verify + turtle CUT + new ideas
R80: vol_ma=16 → Sh+2.32 (+0.009 marginal)
  A: vol_ma=16 robustness — holdout years
  B: Turtle CUT sweep with R79 config (was CUT=2.0 optimal at R67, check now)
  C: ADX_P with R79 config (was 12 optimal, re-confirm)
  D: NEW: DI threshold filter — require DI+>DI- by N points before entry
  E: NEW: ATR_PCT_LB with R79 config (current=90, R59 found LB=30 but fragile)
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

def run_turtle(DX=14, CUT=2.0):
    H.CACHE=f"{CC}/binance-5m-7y.json"
    bars1d=H.load_tf(86400*1000); BD=bars1d; nd=len(BD); CC_=[b["close"] for b in BD]
    regime_1d=H.regime_with_persistence(BD); reg_map={b["time"]//86400000:regime_1d[i] for i,b in enumerate(BD)}
    def get_reg(ts): return reg_map.get(ts//86400000,"RANGE")
    atrd=[None]*nd
    for i in range(1,nd):
        h=BD[i]["high"]; l=BD[i]["low"]; pc=BD[i-1]["close"]
        atrd[i]=max(h-l,abs(h-pc),abs(l-pc))
    dhi=[None]*nd; dlo=[None]*nd; DE=20
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
            if BD[i]["low"]<=e-a*CUT: tur_mo[mo_str(BD[i]["time"])]+=(e-a*CUT-e)/e-2*H.FEE; hold=False
            elif dlo[i] and CC_[i]<dlo[i]: tur_mo[mo_str(BD[i]["time"])]+=(CC_[i]-e)/e-2*H.FEE; hold=False
    if hold: tur_mo[mo_str(BD[-1]["time"])]+=(CC_[-1]-e)/e-2*H.FEE
    return tur_mo

def run_h01(cache, adx_thresh=18, sl_init=3.0, sl_trail=3.5, sl_trans=16,
             adx_period=12, atr_break_mult=1.3, vol_mult=1.4, vol_ma=10, max_hold=200,
             skip_months=None, donchian_lb=18, atr_lb=None, di_min_diff=None):
    H.CACHE=cache
    orig_lb=H.ATR_PCT_LB
    if atr_lb: H.ATR_PCT_LB=atr_lb
    orig=(H.ADX_THRESH,H.SL_INIT,H.SL_TRAIL,H.SL_TRANS,H.ADX_P,H.ATR_BREAK_MULT,H.VOL_MULT,H.VOL_MA,H.MAX_HOLD,H.DONCHIAN_LB)
    H.ADX_THRESH=adx_thresh; H.SL_INIT=sl_init; H.SL_TRAIL=sl_trail; H.SL_TRANS=sl_trans
    H.ADX_P=adx_period; H.ATR_BREAK_MULT=atr_break_mult; H.VOL_MULT=vol_mult; H.VOL_MA=vol_ma; H.MAX_HOLD=max_hold
    H.DONCHIAN_LB=donchian_lb
    bars4h=H.load_tf(H.H4); bars1h=H.load_tf(3600*1000); bars1d=H.load_tf(86400*1000)
    n=len(bars4h); c4=[b["close"] for b in bars4h]
    e50=H.ema_s(c4,H.EMA_FAST); e200=H.ema_s(c4,H.EMA_SLOW)
    atr4=H.atr_series(bars4h); adx4=H.adx_wilder(bars4h,period=adx_period)
    # Compute DI+ and DI- if needed
    pdi4=ndi4=None
    if di_min_diff is not None:
        nb=len(bars4h); tr=[0.]*nb; pdm=[0.]*nb; ndm=[0.]*nb
        for i in range(1,nb):
            h=bars4h[i]["high"]; l=bars4h[i]["low"]; ph=bars4h[i-1]["high"]; pl=bars4h[i-1]["low"]; pc=bars4h[i-1]["close"]
            tr[i]=max(h-l,abs(h-pc),abs(l-pc))
            up=h-ph; dn=pl-l
            pdm[i]=max(up,0) if up>dn else 0; ndm[i]=max(dn,0) if dn>up else 0
        p=adx_period; at=[None]*nb; pd_=[None]*nb; nd_=[None]*nb
        if p<nb:
            at[p]=sum(tr[1:p+1])/p; pv=sum(pdm[1:p+1])/p; nv=sum(ndm[1:p+1])/p
            pd_[p]=(100*pv/at[p]) if at[p]>0 else 0; nd_[p]=(100*nv/at[p]) if at[p]>0 else 0
            for i in range(p+1,nb):
                at[i]=(at[i-1]*(p-1)+tr[i])/p; pv=(pv*(p-1)+pdm[i])/p; nv=(nv*(p-1)+ndm[i])/p
                pd_[i]=(100*pv/at[i]) if at[i]>0 else 0; nd_[i]=(100*nv/at[i]) if at[i]>0 else 0
        pdi4=pd_; ndi4=nd_
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
        if di_min_diff is not None and pdi4 and ndi4:
            if pdi4[i] is None or ndi4[i] is None: return False
            if pdi4[i]-ndi4[i]<di_min_diff: return False
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
    H.ATR_PCT_LB=orig_lb
    return mo, n_tr

print("Loading R79 baselines...")
moB10,_=run_h01(f"{CC}/binance-5m-7y.json",18,sl_init=2.78,sl_trail=3.28,skip_months={8},donchian_lb=18,vol_ma=10)
moB16,_=run_h01(f"{CC}/binance-5m-7y.json",18,sl_init=2.78,sl_trail=3.28,skip_months={8},donchian_lb=18,vol_ma=16)
moS,_=run_h01(f"{CC}/binance-sol-5m-3y.json",15,sl_init=2.9,sl_trail=3.4,sl_trans=24,donchian_lb=20)
turB14=run_turtle(14,2.0)
H.CACHE=f"{CC}/binance-sol-5m-3y.json"; bs=H.load_tf(H.H4); span_s=(bs[0]["time"],bs[-1]["time"])
H.CACHE=f"{CC}/binance-5m-7y.json"
cal3=months_between(span_s[0],span_s[1])
sB10=[moB10.get(m,0.0) for m in cal3]; sB16=[moB16.get(m,0.0) for m in cal3]
sS=[moS.get(m,0.0) for m in cal3]; sTB14=[turB14.get(m,0.0) for m in cal3]; W=[1,1,1.2]

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
    ok=sh>=2.30; mark="✅✅✅" if ok else ("✅✅" if sh>=2.25 else ("✅" if sh>=2.10 else ("⚠️" if sh>=2.00 else "")))
    star="★★★" if sh>=2.35 else ("★★" if sh>=2.30 else ("★" if delta>0.05 else ""))
    print(f"  {mark} {label:<54} Sh{sh:>+5.2f} DD{md:>4.1f}% flat{fl:>3} TE{te:>+5.2f} d{delta:>+.3f} {star} {extra}")
    return sh,md

sh_base,_=pr("R79 BASELINE (vol_ma=10)",[sB10,sS,sTB14])
pr("  vol_ma=16 (R80 find)",[sB16,sS,sTB14])
print(); print("="*100); print("=== R81: vol_ma=16 verify + more ===\n")

# A: vol_ma=16 robustness
print("━"*100); print("A: vol_ma=16 robustness — holdout years")
for yr_exc in [2023,2024,2025]:
    cal_ho=[m for m in cal3 if not m.startswith(str(yr_exc))]
    sB10_ho=[moB10.get(m,0.0) for m in cal_ho]; sB16_ho=[moB16.get(m,0.0) for m in cal_ho]
    sS_ho=[moS.get(m,0.0) for m in cal_ho]; sTB_ho=[turB14.get(m,0.0) for m in cal_ho]
    sh_10,_,_,_,_=bk([sB10_ho,sS_ho,sTB_ho],cal=cal_ho)
    sh_16,_,_,_,_=bk([sB16_ho,sS_ho,sTB_ho],cal=cal_ho)
    robust="✓ ROBUST" if sh_16>sh_10 else "✗ FRAGILE"
    print(f"  Holdout {yr_exc}: vm10 Sh{sh_10:+.2f} → vm16 Sh{sh_16:+.2f} delta{sh_16-sh_10:>+.3f} {robust}")

# B: Turtle CUT sweep with R79 config
print(f"\n{'━'*100}"); print("B: Turtle CUT sweep with R79 config")
for cut in [1.5,1.8,2.0,2.2,2.5,3.0]:
    tur_=run_turtle(14,cut); sTur_=[tur_.get(m,0.0) for m in cal3]
    pr(f"  Turtle CUT={cut}",[sB10,sS,sTur_])

# C: ADX_P re-confirm
print(f"\n{'━'*100}"); print("C: ADX_P sweep with R79 config")
for ap in [10,11,12,13,14,16]:
    moB_,nt=run_h01(f"{CC}/binance-5m-7y.json",18,sl_init=2.78,sl_trail=3.28,skip_months={8},donchian_lb=18,adx_period=ap)
    sB_=[moB_.get(m,0.0) for m in cal3]
    pr(f"  ADX_P={ap}",[sB_,sS,sTB14],extra=f"n={nt}")

# D: DI diff filter (new idea: require DI+>DI- by N points)
print(f"\n{'━'*100}"); print("D: DI diff filter — require DI+−DI− ≥ N (current=no filter)")
for di_diff in [0,2,4,6,8,10]:
    moB_,nt=run_h01(f"{CC}/binance-5m-7y.json",18,sl_init=2.78,sl_trail=3.28,skip_months={8},donchian_lb=18,di_min_diff=di_diff)
    sB_=[moB_.get(m,0.0) for m in cal3]
    pr(f"  DI_diff≥{di_diff}",[sB_,sS,sTB14],extra=f"n={nt}")

# E: ATR_PCT_LB sweep with R79 config
print(f"\n{'━'*100}"); print(f"E: ATR_PCT_LB sweep with R79 config (current={H.ATR_PCT_LB})")
for lb in [25,30,40,60,90]:
    moB_,nt=run_h01(f"{CC}/binance-5m-7y.json",18,sl_init=2.78,sl_trail=3.28,skip_months={8},donchian_lb=18,atr_lb=lb)
    sB_=[moB_.get(m,0.0) for m in cal3]
    pr(f"  ATR_LB={lb}",[sB_,sS,sTB14],extra=f"n={nt}")

print(f"\n{'='*100}")
print(f"R81 SUMMARY — ceiling Sh{sh_base:+.3f}")
