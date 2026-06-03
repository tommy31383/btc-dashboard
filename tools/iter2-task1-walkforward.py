#!/usr/bin/env python3
"""iter2-task1-walkforward.py — Iteration 2 Task 1:
3-split walk-forward for v0.4.73 config:
ADX=18, ADX_period=12, SL_INIT=3.0, SL_TRAIL=3.5, SL_TRANS=16,
ATR_BREAK=1.3, VOL_MULT=1.4, VOL_MA=16, DLB=18
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

_,_,_,spanB=Hh.run_hedge01(f"{CC}/binance-5m-7y.json",skip_cal=False)
_,_,_,spanS=Hh.run_hedge01(f"{CC}/binance-sol-5m-3y.json",skip_cal=False)
turB=dict(C.tur_mo)
cal=months_between(spanS[0],spanS[1])  # 3y SOL window = common window
sTB=[turB.get(m,0.0) for m in cal]

# v0.4.73 params
V073_BTC=dict(adx_thresh=18, adx_period=12, sl_init=3.0, sl_trail=3.5, sl_trans=16,
              atr_break_mult=1.3, vol_mult=1.4, vol_ma=16, max_hold=200)
V073_SOL_ADX=15  # SOL uses ADX=15 per spec

def run_h01(cache, adx_thresh=18, sl_init=3.0, sl_trail=3.5, sl_trans=16,
            adx_period=12, atr_break_mult=1.3, vol_mult=1.4, vol_ma=16, max_hold=200):
    H.CACHE=cache
    orig=(H.ADX_THRESH,H.SL_INIT,H.SL_TRAIL,H.SL_TRANS,H.ADX_P,
          H.ATR_BREAK_MULT,H.VOL_MULT,H.VOL_MA,H.MAX_HOLD,H.DONCHIAN_LB)
    H.ADX_THRESH=adx_thresh; H.SL_INIT=sl_init; H.SL_TRAIL=sl_trail; H.SL_TRANS=sl_trans
    H.ADX_P=adx_period; H.ATR_BREAK_MULT=atr_break_mult; H.VOL_MULT=vol_mult
    H.VOL_MA=vol_ma; H.MAX_HOLD=max_hold; H.DONCHIAN_LB=18  # DLB=18 per spec

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

def bk(parts, weights=None, subcal=None):
    c=subcal or cal; k=len(parts); w=weights or [1]*k; sw=sum(w)
    p=[sum(w[j]*parts[j].get(m,0.0) if isinstance(parts[j],dict) else w[j]*parts[j][cal.index(m)] if isinstance(parts[j],list) and m in cal else 0.0 for j in range(k))/sw for m in c]
    yr=defaultdict(float)
    for i,m in enumerate(c): yr[int(m[:4])]+=p[i]
    sh=sharpe(p); md=maxdd(p); fl=sum(1 for x in p if abs(x)<1e-9)
    py=" ".join(f"{y%100}:{yr[y]*100:+.0f}" for y in sorted(yr))
    return sh,md,fl,py,p

def bk2(parts_vecs, weights=None, subcal=None):
    """parts_vecs is list of plain lists (aligned to subcal)."""
    c=subcal; k=len(parts_vecs); w=weights or [1]*k; sw=sum(w)
    p=[sum(w[j]*parts_vecs[j][i] for j in range(k))/sw for i in range(len(c))]
    yr=defaultdict(float)
    for i,m in enumerate(c): yr[int(m[:4])]+=p[i]
    sh=sharpe(p); md=maxdd(p); fl=sum(1 for x in p if abs(x)<1e-9)
    py=" ".join(f"{y%100}:{yr[y]*100:+.0f}" for y in sorted(yr))
    return sh,md,fl,py,p

print("="*90)
print("ITERATION 2 TASK 1 — 3-split walk-forward for v0.4.73 config")
print("  BTC: ADX=18 ADX_period=12 SL_INIT=3.0 SL_TRAIL=3.5 SL_TRANS=16")
print("       ATR_BREAK=1.3 VOL_MULT=1.4 VOL_MA=16 DLB=18")
print("  SOL: ADX=15 (same other params)")
print("  Turtle-BTC: DON20/10 CUT1.5 skip-BEAR (from C module)")
print(f"\n  Common window: {cal[0]}→{cal[-1]} ({len(cal)}mo)")

print("\n[1/2] Running v0.4.73 BTC + SOL backtests...")
moB=run_h01(f"{CC}/binance-5m-7y.json",**V073_BTC)
moS=run_h01(f"{CC}/binance-sol-5m-3y.json",adx_thresh=V073_SOL_ADX,
            sl_init=3.0,sl_trail=3.5,sl_trans=16,adx_period=12,
            atr_break_mult=1.3,vol_mult=1.4,vol_ma=16,max_hold=200)
sB=[moB.get(m,0.0) for m in cal]
sS=[moS.get(m,0.0) for m in cal]

# Full period baseline
sh_full,dd_full,fl_full,py_full,pv_full=bk([moB,moS],subcal=cal)
# with turtle
pv_book=[( sB[i]+sS[i]+sTB[i])/3 for i in range(len(cal))]
sh_book=sharpe(pv_book); dd_book=maxdd(pv_book)
yr_book=defaultdict(float)
for i,m in enumerate(cal): yr_book[int(m[:4])]+=pv_book[i]
py_book=" ".join(f"{y%100}:{yr_book[y]*100:+.0f}" for y in sorted(yr_book))
n_trades_btc=sum(1 for v in moB.values() if abs(v)>1e-9)
n_trades_sol=sum(1 for v in moS.values() if abs(v)>1e-9)
print(f"\n  Full-period (BTC+SOL+turtle equal-weight):")
print(f"    Sh{sh_book:+.3f} DD{dd_book:.1f}% flat{fl_full}/35 n_BTC={n_trades_btc}mo n_SOL={n_trades_sol}mo")
print(f"    per-year: {py_book}")

# ─── 3-split walk-forward ───
print("\n[2/2] 3-split walk-forward (train 2/3 → test 1/3, rolling 3 folds)")
n_cal=len(cal)
s1=n_cal//3; s2=2*n_cal//3

# Define 3 folds: each fold = (train_cal, test_cal)
# Fold A: train first 2/3, test last 1/3
# We do proper 3-split: split into 3 equal chunks A B C
# Fold1: train=A+B, test=C  |  Fold2: train=A+C, test=B  |  Fold3: train=B+C, test=A
# But for time-series, we only do FORWARD folds:
# Split1 (n_cal//3 train): test second third
# Split2 (2n_cal//3 train): test last third
# Standard 3-fold forward:
splits=[
    ("Split-1 train→mid", cal[:s1], cal[s1:s2]),
    ("Split-2 train→end", cal[:s2], cal[s2:]),
    ("Split-3 mid→end",   cal[s1:s2], cal[s2:]),
]

oos_shs=[]
print(f"\n  {'Split':<32} {'TRAIN':^18} {'TEST':^18} {'TEST_n':>6}")
print("  "+"-"*76)
for lbl,tr_c,te_c in splits:
    # build vecs for this subcal
    tr_B=[moB.get(m,0.0) for m in tr_c]; tr_S=[moS.get(m,0.0) for m in tr_c]
    tr_T=[sTB[cal.index(m)] if m in cal else 0.0 for m in tr_c]
    te_B=[moB.get(m,0.0) for m in te_c]; te_S=[moS.get(m,0.0) for m in te_c]
    te_T=[sTB[cal.index(m)] if m in cal else 0.0 for m in te_c]
    sh_tr=sharpe([(tr_B[i]+tr_S[i]+tr_T[i])/3 for i in range(len(tr_c))])
    sh_te=sharpe([(te_B[i]+te_S[i]+te_T[i])/3 for i in range(len(te_c))])
    dd_te=maxdd([(te_B[i]+te_S[i]+te_T[i])/3 for i in range(len(te_c))])
    oos_shs.append(sh_te)
    print(f"  {lbl:<32} {tr_c[0]}→{tr_c[-1]} Sh{sh_tr:>+5.2f} | {te_c[0]}→{te_c[-1]} Sh{sh_te:>+5.2f} DD{dd_te:.1f}% | {len(te_c)}mo")

oos_mean=sum(oos_shs)/len(oos_shs)
print(f"\n  OOS Sharpe splits: {[f'{x:+.2f}' for x in oos_shs]}")
print(f"  OOS Sharpe MEAN: {oos_mean:+.3f}")
verdict="STABLE" if oos_mean>=1.0 else ("MARGINAL" if oos_mean>=0.5 else "WEAK")
print(f"  Verdict: {verdict} (target >=1.0 for confidence)")

# Per-year stability
print(f"\n  Per-year P&L (BTC+SOL+turtle book):")
yr_count=0
for y in sorted(yr_book):
    flag="OK" if yr_book[y]>=0 else "BAD"
    print(f"    {y}: {yr_book[y]*100:+.1f}% [{flag}]")
    if yr_book[y]>=0: yr_count+=1
print(f"  Positive years: {yr_count}/{len(yr_book)} (target >=5/8 for 7y, >=2/3 for 3y)")

print("\n"+"="*90)
print("TASK 1 COMPLETE")
print(f"  Full-period book Sh: {sh_book:+.3f}")
print(f"  OOS mean Sh: {oos_mean:+.3f}")
print(f"  Verdict: {verdict}")
