#!/usr/bin/env python3
"""iter2-task2-eth-sleeve.py — Iteration 2 Task 2:
ETH sleeve analysis: hedge01 on ETH with R22+DLB18+vm16 params.
Question: does ETH×0.25 add Sh gain worth the complexity?
"""
import importlib.util, datetime, math, os, sys
from collections import defaultdict

def imp(name, path):
    spec=importlib.util.spec_from_file_location(name,path); M=importlib.util.module_from_spec(spec)
    so=sys.stdout; sys.stdout=open(os.devnull,"w"); spec.loader.exec_module(M); sys.stdout=so; return M

T="/Users/lap16116/BTC_PC/btc-dashboard/tools/"
CC="/Users/lap16116/BTC_PC/btc-dashboard/.cache"
Hh=imp("Hh",T+"loop-hedge01-crossasset.py")
C=imp("C",T+"correlation-turtle-hedge01-7y.py")
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
def corr(a,b):
    ma=sum(a)/len(a); mb=sum(b)/len(b)
    num=sum((a[i]-ma)*(b[i]-mb) for i in range(len(a)))
    den=(sum((x-ma)**2 for x in a)*sum((x-mb)**2 for x in b))**.5 or 1e-9
    return num/den
def sd(v):
    me=sum(v)/len(v); return (sum((x-me)**2 for x in v)/len(v))**.5 or 1e-9

_,_,_,spanB=Hh.run_hedge01(f"{CC}/binance-5m-7y.json",skip_cal=False)
_,_,_,spanS=Hh.run_hedge01(f"{CC}/binance-sol-5m-3y.json",skip_cal=False)
turB=dict(C.tur_mo)
cal=months_between(spanS[0],spanS[1])
sTB=[turB.get(m,0.0) for m in cal]

def run_h01(cache, adx_thresh=18, sl_init=3.0, sl_trail=3.5, sl_trans=16,
            adx_period=12, atr_break_mult=1.3, vol_mult=1.4, vol_ma=16, max_hold=200, dlb=18):
    H.CACHE=cache
    orig=(H.ADX_THRESH,H.SL_INIT,H.SL_TRAIL,H.SL_TRANS,H.ADX_P,
          H.ATR_BREAK_MULT,H.VOL_MULT,H.VOL_MA,H.MAX_HOLD,H.DONCHIAN_LB)
    H.ADX_THRESH=adx_thresh; H.SL_INIT=sl_init; H.SL_TRAIL=sl_trail; H.SL_TRANS=sl_trans
    H.ADX_P=adx_period; H.ATR_BREAK_MULT=atr_break_mult; H.VOL_MULT=vol_mult
    H.VOL_MA=vol_ma; H.MAX_HOLD=max_hold; H.DONCHIAN_LB=dlb
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
     H.ATR_BREAK_MULT,H.VOL_MULT,H.VOL_MA,H.MAX_HOLD,H.DONCHIAN_LB)=orig
    return mo

print("="*90)
print("ITERATION 2 TASK 2 — ETH sleeve analysis: hedge01 on ETH (R22+DLB18+vm16)")
print(f"  Window: {cal[0]}→{cal[-1]} ({len(cal)}mo)")

# Load baseline BTC + SOL
print("\n[1/3] Loading BTC + SOL baselines (v0.4.73 params)...")
moB=run_h01(f"{CC}/binance-5m-7y.json")
moS=run_h01(f"{CC}/binance-sol-5m-3y.json",adx_thresh=15)
sB=[moB.get(m,0.0) for m in cal]
sS=[moS.get(m,0.0) for m in cal]

# Baseline book metrics
pv_base=[(sB[i]+sS[i]+sTB[i])/3 for i in range(len(cal))]
sh_base=sharpe(pv_base); dd_base=maxdd(pv_base)
yr_base=defaultdict(float)
for i,m in enumerate(cal): yr_base[int(m[:4])]+=pv_base[i]
py_base=" ".join(f"{y%100}:{yr_base[y]*100:+.0f}" for y in sorted(yr_base))

print(f"  Baseline BTC+SOL+turtle: Sh{sh_base:+.3f} DD{dd_base:.1f}%")
print(f"    per-year: {py_base}")

# ETH sweep — find best ADX for ETH
print("\n[2/3] ETH sweep (ADX 14-20, R22+DLB18+vm16 params)...")
print(f"\n  {'ETH config':<30} {'Sh':>6} {'DD':>5} {'n':>4} {'per-year'}")
print("  "+"-"*80)
best_eth_sh=0; best_eth_adx=18; best_eth_mo=None
for adx_e in [14,15,16,17,18,19,20]:
    moE=run_h01(f"{CC}/binance-eth-5m-3y.json",adx_thresh=adx_e)
    sE=[moE.get(m,0.0) for m in cal]
    sh_e=sharpe(sE); dd_e=maxdd(sE)
    n_e=sum(1 for v in moE.values() if abs(v)>1e-9)
    yr_e=defaultdict(float)
    for m in cal: yr_e[int(m[:4])]+=moE.get(m,0.0)
    py_e=" ".join(f"{y%100}:{yr_e[y]*100:+.0f}" for y in sorted(yr_e))
    print(f"  ETH ADX{adx_e:<3} DLB18 vm16     {sh_e:>+6.3f} {dd_e:>5.1f}% {n_e:>4}mo | {py_e}")
    if sh_e>best_eth_sh: best_eth_sh=sh_e; best_eth_adx=adx_e; best_eth_mo=moE
print(f"  → Best ETH: ADX{best_eth_adx} Sh{best_eth_sh:+.3f}")

# ETH correlations
sE_best=[best_eth_mo.get(m,0.0) for m in cal]
print(f"\n  Correlations (monthly):")
print(f"    corr(BTC,ETH)={corr(sB,sE_best):+.3f}")
print(f"    corr(BTC,SOL)={corr(sB,sS):+.3f}")
print(f"    corr(ETH,SOL)={corr(sE_best,sS):+.3f}")
print(f"    corr(ETH,turtle)={corr(sE_best,sTB):+.3f}")

# Book with ETH at various weights
print("\n[3/3] ETH sleeve portfolio impact (BTC+ETH×w+SOL+turtle)...")
print(f"\n  {'Config':<48} {'Sh':>6} {'DD':>5} {'DeltaSh':>8} {'per-year'}")
print("  "+"-"*90)

def book_with_eth(w_eth):
    """Equal weight BTC + w_eth×ETH + SOL + turtle (normalized by 3+w_eth)"""
    sw=3+w_eth
    pv=[(sB[i]+w_eth*sE_best[i]+sS[i]+sTB[i])/sw for i in range(len(cal))]
    yr_=defaultdict(float)
    for i,m in enumerate(cal): yr_[int(m[:4])]+=pv[i]
    sh_=sharpe(pv); dd_=maxdd(pv)
    py_=" ".join(f"{y%100}:{yr_[y]*100:+.0f}" for y in sorted(yr_))
    return sh_,dd_,py_,pv

sh_base_book=sharpe(pv_base); dd_base_book=maxdd(pv_base)
print(f"  {'Baseline: BTC+SOL+turtle (no ETH)':<48} {sh_base_book:>+6.3f} {dd_base_book:>5.1f}% {'—':>8} | {py_base}")
for w in [0.10,0.15,0.20,0.25,0.30,0.50]:
    sh_,dd_,py_,_=book_with_eth(w)
    delta=sh_-sh_base_book
    print(f"  {f'BTC+ETH×{w:.2f}+SOL+turtle':<48} {sh_:>+6.3f} {dd_:>5.1f}% {delta:>+8.3f} | {py_}")

# Walk-forward for ETH×0.25 option
print(f"\n  Walk-forward check for ETH×0.25 (train/test splits):")
s1=len(cal)//3; s2=2*len(cal)//3
splits=[
    ("Split-1 train→mid", cal[:s1], cal[s1:s2]),
    ("Split-2 train→end", cal[:s2], cal[s2:]),
]
w_eth=0.25
for lbl,tr_c,te_c in splits:
    sw=3+w_eth
    tr_pv=[(sB[cal.index(m)]+w_eth*sE_best[cal.index(m)]+sS[cal.index(m)]+sTB[cal.index(m)])/sw for m in tr_c if m in cal]
    te_pv=[(sB[cal.index(m)]+w_eth*sE_best[cal.index(m)]+sS[cal.index(m)]+sTB[cal.index(m)])/sw for m in te_c if m in cal]
    sh_tr=sharpe(tr_pv); sh_te=sharpe(te_pv)
    print(f"    {lbl}: TRAIN Sh{sh_tr:+.2f} | TEST Sh{sh_te:+.2f}")

# Summary verdict
sh_025,dd_025,py_025,_=book_with_eth(0.25)
delta_025=sh_025-sh_base_book
print(f"\n  VERDICT:")
print(f"    ETH standalone best (ADX{best_eth_adx}): Sh{best_eth_sh:+.3f}")
print(f"    corr(BTC,ETH)={corr(sB,sE_best):+.3f} — {'HIGH CORRELATION, low diversif value' if abs(corr(sB,sE_best))>0.4 else 'MODERATE correlation, some diversif'}")
if delta_025>0.05 and abs(corr(sB,sE_best))<0.5:
    verdict="ACCEPT — Sh gain meaningful AND correlation moderate"
elif delta_025>0.02 and abs(corr(sB,sE_best))>0.4:
    verdict="MARGINAL — small Sh gain but high corr = complexity not worth it"
else:
    verdict="REJECT — net Sh gain too small or correlation too high"
print(f"    ETH×0.25 book delta: {delta_025:+.3f} Sh → {verdict}")
print(f"    ETH×0.25 book full: Sh{sh_025:+.3f} DD{dd_025:.1f}% | {py_025}")
print("\n"+"="*90)
print("TASK 2 COMPLETE")
