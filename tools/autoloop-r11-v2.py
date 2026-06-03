#!/usr/bin/env python3
"""autoloop-r11-v2.py — Round 11: Walk-forward ADX18 + Signal ablation (fixed)"""
import importlib.util, datetime, math, os, sys, json
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

_,_,_,spanB=Hh.run_hedge01(f"{CC}/binance-5m-7y.json",skip_cal=False)
_,_,_,spanS=Hh.run_hedge01(f"{CC}/binance-sol-5m-3y.json",skip_cal=False)
turB=dict(C.tur_mo)
cal=months_between(spanS[0],spanS[1])
sTB=[turB.get(m,0.0) for m in cal]

def run_h01_with_trades(cache, adx_thresh=18):
    H.CACHE=cache; orig=H.ADX_THRESH; H.ADX_THRESH=adx_thresh
    bars4h=H.load_tf(H.H4); bars1h=H.load_tf(3600*1000); bars1d=H.load_tf(86400*1000)
    n=len(bars4h); c4=[b["close"] for b in bars4h]
    e50=H.ema_s(c4,H.EMA_FAST); e200=H.ema_s(c4,H.EMA_SLOW)
    atr4=H.atr_series(bars4h); adx4=H.adx_wilder(bars4h)
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
    def s12(i):
        if None in (e50[i],e200[i]) or i<1 or None in (e50[i-1],e200[i-1]): return None
        return "LONG" if e50[i-1]<=e200[i-1] and e50[i]>e200[i] else None
    def s13(i):
        if atr4[i] is None or i<1: return None
        return "LONG" if c4[i]>bars4h[i-1]["close"]+atr4[i]*H.ATR_BREAK_MULT else None
    def s14(i):
        if i<H.DONCHIAN_LB: return None
        hi=max(bars4h[j]["high"] for j in range(i-H.DONCHIAN_LB,i))
        return "LONG" if c4[i]>hi else None
    ALL_SIGS={"S12":(s12,False,36),"S13":(s13,True,1),"S14":(s14,True,36)}
    mo=defaultdict(float); trades_sig=defaultdict(list); last={s:0 for s in ALL_SIGS}
    for i in range(250,n-H.MAX_HOLD):
        for sn,(sfn,dov,cd) in ALL_SIGS.items():
            if sfn(i)!="LONG": continue
            if i-last[sn]<cd: continue
            if dov and not vol_pass(i): continue
            if not filt(i): continue
            r=sim(i)
            if r is None: continue
            ret,h=r; cts=bars4h[min(i+h,n-1)]["time"]
            mo[mo_str(cts)]+=ret; last[sn]=i
            trades_sig[sn].append((ret,h))
    H.ADX_THRESH=orig
    return mo, trades_sig

ASSETS=[
    ("BTC", f"{CC}/binance-5m-7y.json"),
    ("SOL", f"{CC}/binance-sol-5m-3y.json"),
    ("ETH", f"{CC}/binance-eth-5m-3y.json"),
    ("BNB", f"{CC}/binance-bnb-5m-3y.json"),
    ("AVAX",f"{CC}/binance-avax-5m-3y.json"),
    ("LINK",f"{CC}/binance-link-5m-3y.json"),
    ("ADA", f"{CC}/binance-ada-5m-3y.json"),
]

print("="*90)
print("=== Round 11: Walk-forward ADX18 + Signal analysis ===\n")

# ─── R11A: Walk-forward ───
print("━"*90)
print("R11A: Walk-forward selection — ADX20 vs ADX18 (7 assets)")
sol_months=sorted(months_between(spanS[0],spanS[1]))
half=len(sol_months)//2
h1=sol_months[:half]; h2=sol_months[half:]
print(f"  Half1: {h1[0]}→{h1[-1]} ({len(h1)}mo) | Half2: {h2[0]}→{h2[-1]} ({len(h2)}mo)\n")

for adx_t in [20,18]:
    print(f"  ADX{adx_t}:")
    momap={}
    for nm,path in ASSETS:
        try:
            mo_,_=run_h01_with_trades(path,adx_thresh=adx_t)
            momap[nm]=mo_
        except Exception as e:
            print(f"    {nm}: error {e}")
    # rank by half1
    ranks=[]
    for nm,mo_ in momap.items():
        v1=[mo_.get(m,0.0) for m in h1]
        sh1=sharpe(v1); ranks.append((sh1,nm))
    ranks.sort(reverse=True)
    top2=[nm for _,nm in ranks[:2]]
    print(f"    Half1 rank: {[(nm,f'{sh:.2f}') for sh,nm in ranks]}")
    print(f"    Top2 → {top2}")
    # OOS half2
    for sh_,nm_ in ranks:
        if nm_ not in momap: continue
        v2=[momap[nm_].get(m,0.0) for m in h2]
        sh2=sharpe(v2); tot2=sum(v2)*100
        mark="★" if nm_ in top2 else " "
        print(f"    {mark} {nm_:<6}: OOS Sh{sh2:+.2f} TOT{tot2:+.0f}%")
    if len(top2)==2 and all(nm_ in momap for nm_ in top2):
        v2a=[momap[top2[0]].get(m,0.0) for m in h2]
        v2b=[momap[top2[1]].get(m,0.0) for m in h2]
        tB_h2=[turB.get(m,0.0) for m in h2]
        p=[(v2a[i]+v2b[i]+tB_h2[i])/3 for i in range(len(h2))]
        print(f"    OOS book {top2[0]}+{top2[1]}+turBTC: Sh{sharpe(p):+.2f} TOT{sum(p)*100:+.0f}%")
    print()

# ─── R11B: Signal breakdown BTC ADX18 ───
print("━"*90)
print("R11B: Signal breakdown BTC (ADX18 vs ADX20)")
for adx_t in [20,18]:
    _,tsig=run_h01_with_trades(f"{CC}/binance-5m-7y.json",adx_thresh=adx_t)
    print(f"  ADX{adx_t}:")
    for sn in ["S12","S13","S14"]:
        t=tsig.get(sn,[])
        if not t: print(f"    {sn}: 0 trades"); continue
        wr=sum(1 for r,_ in t if r>0)/len(t)*100
        ar=sum(r for r,_ in t)/len(t)*100
        avg_h=sum(h for _,h in t)/len(t)
        print(f"    {sn}: n={len(t):>4} WR{wr:>5.0f}% avgR{ar:>+6.1f}% avgHold{avg_h:>5.0f}bars")
    print()

# ─── R11C: Signal ablation BTC+SOL ADX18 ───
print("━"*90)
print("R11C: Signal ablation — skip each signal (ADX18 book)")

def run_h01_skip(cache, skip_sig, adx_thresh=18):
    H.CACHE=cache; orig=H.ADX_THRESH; H.ADX_THRESH=adx_thresh
    bars4h=H.load_tf(H.H4); bars1h=H.load_tf(3600*1000); bars1d=H.load_tf(86400*1000)
    n=len(bars4h); c4=[b["close"] for b in bars4h]
    e50=H.ema_s(c4,H.EMA_FAST); e200=H.ema_s(c4,H.EMA_SLOW)
    atr4=H.atr_series(bars4h); adx4=H.adx_wilder(bars4h)
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
    def s12(i):
        if None in (e50[i],e200[i]) or i<1 or None in (e50[i-1],e200[i-1]): return None
        return "LONG" if e50[i-1]<=e200[i-1] and e50[i]>e200[i] else None
    def s13(i):
        if atr4[i] is None or i<1: return None
        return "LONG" if c4[i]>bars4h[i-1]["close"]+atr4[i]*H.ATR_BREAK_MULT else None
    def s14(i):
        if i<H.DONCHIAN_LB: return None
        hi=max(bars4h[j]["high"] for j in range(i-H.DONCHIAN_LB,i))
        return "LONG" if c4[i]>hi else None
    all_s={"S12":(s12,False,36),"S13":(s13,True,1),"S14":(s14,True,36)}
    if skip_sig in all_s: del all_s[skip_sig]
    mo=defaultdict(float); last={s:0 for s in all_s}
    for i in range(250,n-H.MAX_HOLD):
        for sn,(sfn,dov,cd) in all_s.items():
            if sfn(i)!="LONG": continue
            if i-last[sn]<cd: continue
            if dov and not vol_pass(i): continue
            if not filt(i): continue
            r=sim(i)
            if r is None: continue
            ret,h=r; cts=bars4h[min(i+h,n-1)]["time"]
            mo[mo_str(cts)]+=ret; last[sn]=i
    H.ADX_THRESH=orig
    return mo

moB18f,_=run_h01_with_trades(f"{CC}/binance-5m-7y.json",adx_thresh=18)
moS18f,_=run_h01_with_trades(f"{CC}/binance-sol-5m-3y.json",adx_thresh=18)
sB18=[moB18f.get(m,0.0) for m in cal]; sS18=[moS18f.get(m,0.0) for m in cal]
p_full=[(sB18[i]+sS18[i]+sTB[i])/3 for i in range(len(cal))]
sh_full=sharpe(p_full); tot_full=sum(p_full)*100

print(f"  Full ADX18 book: Sh{sh_full:+.2f} TOT{tot_full:+.0f}%")
for skip_s in ["S12","S13","S14"]:
    mb=run_h01_skip(f"{CC}/binance-5m-7y.json",skip_s)
    ms=run_h01_skip(f"{CC}/binance-sol-5m-3y.json",skip_s)
    sb_=[mb.get(m,0.0) for m in cal]; ss_=[ms.get(m,0.0) for m in cal]
    p=[(sb_[i]+ss_[i]+sTB[i])/3 for i in range(len(cal))]
    sh=sharpe(p); tot=sum(p)*100; md=maxdd(p)
    delta_sh=sh-sh_full; delta_tot=tot-tot_full
    print(f"  Skip {skip_s}: Sh{sh:+.2f} DD{md:.1f}% TOT{tot:+.0f}% | ΔSh{delta_sh:+.2f} ΔTOT{delta_tot:+.0f}% (neg=that sig added value)")

print("\n"+"="*90)
print("R11 COMPLETE")
print("  Walk-forward: {BTC,SOL} ổn định top-2 vs ADX18/ADX20?")
print("  Signal ablation: signal nào load-bearing nhất?")
