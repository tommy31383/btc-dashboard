#!/usr/bin/env python3
"""autoloop-r38-eth-adxperiod-final.py — Round 38: ETH adx_period sweep + final verify
R38A: ETH adx_period sweep [10,12,14,16,18,20] @ MH=200 (R37 winner)
R38B: ETH adx_period × adx_thresh 3×3 cross
R38C: Final 3-asset verify (BTC+ETH×0.25+SOL+turtle) champion config
R38D: Monthly detail + per-year stability

Context from previous rounds:
- R33: 3-asset ETH×0.25 → Sh+1.99 DD7.7%
- R36: ETH-ADX thresh 14-22 all stable (1.97-1.99)
- R37: ETH MH200 → Sh+2.00 flat6/35
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
def sd(v):
    me=sum(v)/len(v); return (sum((x-me)**2 for x in v)/len(v))**.5 or 1e-9

_,_,_,spanB=Hh.run_hedge01(f"{CC}/binance-5m-7y.json",skip_cal=False)
_,_,_,spanS=Hh.run_hedge01(f"{CC}/binance-sol-5m-3y.json",skip_cal=False)
turB=dict(C.tur_mo); cal=months_between(spanS[0],spanS[1])
sTB=[turB.get(m,0.0) for m in cal]

def run_h01(cache, adx_thresh=18, sl_init=3.0, sl_trail=3.5, sl_trans=16,
            adx_period=12, atr_break_mult=1.3, vol_mult=1.4, vol_ma=10, max_hold=100):
    H.CACHE=cache
    orig=H.ADX_THRESH,H.SL_INIT,H.SL_TRAIL,H.SL_TRANS,H.ADX_P,H.ATR_BREAK_MULT,H.VOL_MULT,H.VOL_MA,H.MAX_HOLD
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
    H.ADX_THRESH,H.SL_INIT,H.SL_TRAIL,H.SL_TRANS,H.ADX_P,H.ATR_BREAK_MULT,H.VOL_MULT,H.VOL_MA,H.MAX_HOLD=orig
    return mo

def bk(parts, weights=None):
    k=len(parts); w=weights or [1]*k; sw=sum(w)
    p=[sum(w[j]*parts[j][i] for j in range(k))/sw for i in range(len(cal))]
    yr=defaultdict(float)
    for i,m in enumerate(cal): yr[int(m[:4])]+=p[i]
    sh=sharpe(p); md=maxdd(p); fl=sum(1 for x in p if abs(x)<1e-9)
    train_m=[m for m in cal if m[:4] in ("2023","2024")]
    test_m=[m for m in cal if m[:4] in ("2025","2026")]
    sh_tr=sharpe([p[cal.index(m)] for m in train_m if m in cal])
    sh_te=sharpe([p[cal.index(m)] for m in test_m if m in cal])
    py=" ".join(f"{y%100}:{yr[y]*100:+.0f}" for y in sorted(yr))
    return sh,md,fl,sh_tr,sh_te,py,p

# ─── Precompute BTC + SOL (fixed) ───
print("Loading BTC+SOL+turtle (fixed)...")
moB=run_h01(f"{CC}/binance-5m-7y.json",18); sB=[moB.get(m,0.0) for m in cal]
moS=run_h01(f"{CC}/binance-sol-5m-3y.json",15); sS=[moS.get(m,0.0) for m in cal]

# Baseline R37 winner: ETH ADX18 SL3.0/3.5/16 MH200 weight=0.25
ETH_CACHE=f"{CC}/binance-eth-5m-3y.json"
ETH_ADX_THRESH=18; ETH_SL_INIT=3.0; ETH_SL_TRAIL=3.5; ETH_SL_TRANS=16; ETH_WEIGHT=0.25

print("="*100)
print("=== R38: ETH adx_period sweep + final 3-asset verify ===\n")

# ─── R38A: ETH adx_period sweep @ MH=200 ───
print("━"*100)
print("R38A: ETH adx_period sweep [10,12,14,16,18,20] — MH=200, ADX_thresh=18, SL3.0/3.5/16, w=0.25")
print(f"  {'adx_p':>6} | {'ETH_Sh':>7} {'3-asset_Sh':>11} {'DD':>5} {'flat':>5} {'TEST':>7} | per-year")
print("  "+"-"*80)
best_adxp=12; best_adxp_sh=0.0
for adxp in [10,12,14,16,18,20]:
    me=run_h01(ETH_CACHE,ETH_ADX_THRESH,ETH_SL_INIT,ETH_SL_TRAIL,ETH_SL_TRANS,adxp,max_hold=200)
    se=[me.get(m,0.0) for m in cal]
    sh_e=sharpe(se)
    sh_,md_,fl_,sh_tr,sh_te,py_,_=bk([sB,se,sS,sTB],[1,ETH_WEIGHT,1,1])
    mark="★" if sh_>2.00 and md_<=9 else ("✅" if sh_>=1.97 else "")
    if sh_>best_adxp_sh: best_adxp_sh=sh_; best_adxp=adxp
    print(f"  {adxp:>6} | {sh_e:>+7.2f} {sh_:>+11.2f} {md_:>4.1f}% {fl_:>3}/35 {sh_te:>+7.2f} | {py_} {mark}")

# ─── R38B: adx_period × adx_thresh cross (3×3) ───
print("\n━"*100)
print("R38B: ETH adx_period × adx_thresh — best 3-asset Sh (MH=200, SL3.0/3.5/16, w=0.25)")
thresh_vals=[16,18,20]; period_vals=[10,12,14]
header="  adxP\\adxT  " + "".join(f"  thresh={t:>2}" for t in thresh_vals)
print(header); print("  "+"-"*55)
best_cross_sh=0.0; best_cross=(12,18)
for adxp in period_vals:
    row=f"  period={adxp:>2}  "
    for adxt in thresh_vals:
        me=run_h01(ETH_CACHE,adxt,ETH_SL_INIT,ETH_SL_TRAIL,ETH_SL_TRANS,adxp,max_hold=200)
        se=[me.get(m,0.0) for m in cal]
        sh_,md_,fl_,sh_tr,sh_te,py_,_=bk([sB,se,sS,sTB],[1,ETH_WEIGHT,1,1])
        if sh_>best_cross_sh and md_<=9: best_cross_sh=sh_; best_cross=(adxp,adxt)
        row+=f"  {sh_:>+5.2f}/{md_:>3.1f}"
    print(row)
print(f"  Best cross: adxP={best_cross[0]} adxT={best_cross[1]} Sh{best_cross_sh:+.2f}")

# ─── R38C: Final 3-asset champion verify ───
print("\n━"*100)
print("R38C: Final 3-asset portfolio comparison — champion configs")
print(f"  {'Config':<55} {'Sh':>6} {'DD':>5} {'flat':>5} {'TRAIN':>7} {'TEST':>7}")
print("  "+"-"*90)

# Recompute key configs
def pr(label, parts, weights=None):
    sh_,md_,fl_,sh_tr,sh_te,py_,_=bk(parts,weights)
    ok=sh_>=2.00 and md_<=9.0
    m="✅" if ok else ("⚠️" if sh_>=1.95 else "❌")
    print(f"  {m} {label:<54} Sh{sh_:>+5.2f} DD{md_:>4.1f}% flat{fl_:>3}/35 TR{sh_tr:>+5.2f} TE{sh_te:>+5.2f} | {py_}")
    return sh_,md_,fl_,sh_te

# Baseline 2-asset
pr("2-asset BASELINE BTC18+SOL15+turtle",[sB,sS,sTB])

# R33 winner: ETH×0.25 ADX18 SL3.0/3.5/16 MH100
moE_r33=run_h01(ETH_CACHE,18,3.0,3.5,16,max_hold=100)
sE_r33=[moE_r33.get(m,0.0) for m in cal]
pr("R33 winner: +ETH×0.25 MH100",[sB,sE_r33,sS,sTB],[1,0.25,1,1])

# R37 winner: MH200
moE_r37=run_h01(ETH_CACHE,18,3.0,3.5,16,max_hold=200)
sE_r37=[moE_r37.get(m,0.0) for m in cal]
pr("R37 winner: +ETH×0.25 MH200",[sB,sE_r37,sS,sTB],[1,0.25,1,1])

# R38 best adx_period
moE_r38=run_h01(ETH_CACHE,ETH_ADX_THRESH,ETH_SL_INIT,ETH_SL_TRAIL,ETH_SL_TRANS,best_adxp,max_hold=200)
sE_r38=[moE_r38.get(m,0.0) for m in cal]
pr(f"R38 best: +ETH×0.25 adxP={best_adxp} MH200",[sB,sE_r38,sS,sTB],[1,0.25,1,1])

# Best cross if different
if best_cross!=(best_adxp,18):
    moE_cx=run_h01(ETH_CACHE,best_cross[1],ETH_SL_INIT,ETH_SL_TRAIL,ETH_SL_TRANS,best_cross[0],max_hold=200)
    sE_cx=[moE_cx.get(m,0.0) for m in cal]
    pr(f"R38 cross best: ETH adxP={best_cross[0]} adxT={best_cross[1]} MH200",[sB,sE_cx,sS,sTB],[1,0.25,1,1])

# ─── R38D: Monthly detail — champion config ───
print("\n━"*100)
print("R38D: Monthly detail — R37 champion (ETH×0.25 MH200 ADX18) vs 2-asset baseline")
print(f"  {'Month':<9} {'2-asset':>8} {'3-asset':>8} {'delta':>7} {'ETH_contrib':>12} {'BTC':>7} {'SOL':>7} {'TUR':>7}")
print("  "+"-"*75)

p2vec=bk([sB,sS,sTB])[6]
_,_,_,_,_,_,p3vec=bk([sB,sE_r37,sS,sTB],[1,0.25,1,1])

for i,m in enumerate(cal):
    p2=p2vec[i]; p3=p3vec[i]; dlt=p3-p2
    eth_c=sE_r37[i]*0.25/4  # ETH contrib to 4-part portfolio
    btc=sB[i]; sol=sS[i]; tur=sTB[i]
    flag=""
    if abs(dlt)>0.005: flag="◀ delta"
    elif abs(sE_r37[i])>0.02: flag="ETH active"
    if flag or abs(p3)>0.005:
        print(f"  {m:<9} {p2*100:>+7.1f}% {p3*100:>+7.1f}% {dlt*100:>+6.1f}% {eth_c*100:>+11.1f}% {btc*100:>+6.1f}% {sol*100:>+6.1f}% {tur*100:>+6.1f}% {flag}")

# Per-year stability
print(f"\n  Per-year 3-asset (ETH×0.25 MH200):")
yr3=defaultdict(float); yr2=defaultdict(float)
for i,m in enumerate(cal):
    yr3[int(m[:4])]+=p3vec[i]; yr2[int(m[:4])]+=p2vec[i]
for y in sorted(yr3):
    d3=yr3[y]*100; d2=yr2[y]*100; dlt=(d3-d2)*100
    mark="✅" if d3>0 else "❌"
    print(f"    {mark} {y}: 3-asset {d3:>+6.1f}% | 2-asset {d2:>+6.1f}% | delta {dlt:>+5.1f}bp")

# ─── Summary ───
sh_champ,md_champ,fl_champ,_,sh_te_champ,_,_=bk([sB,sE_r37,sS,sTB],[1,0.25,1,1])
sh_base,md_base,fl_base,_,sh_te_base,_,_=bk([sB,sS,sTB])
print("\n"+"="*100)
print("R38 SUMMARY")
print(f"  2-asset baseline:           Sh{sh_base:>+5.2f} DD{md_base:.1f}% flat{fl_base}/35 TEST{sh_te_base:>+5.2f}")
print(f"  3-asset champion (ETH MH200): Sh{sh_champ:>+5.2f} DD{md_champ:.1f}% flat{fl_champ}/35 TEST{sh_te_champ:>+5.2f}")
print(f"  adx_period stable? → R38A sweep above")
print(f"  NEXT → if adx_period robust: FINALIZE 3-asset book config")
print(f"         if cherry-pick: stick with 2-asset")
