#!/usr/bin/env python3
"""autoloop-r11-walkforward-entry.py — Round 11: Walk-forward ADX18 + Entry signal analysis
R11A: Walk-forward ADX18 — xem OOS Sharpe thay đổi không vs ADX20
R11B: Signal contribution breakdown — S12/S13/S14 mỗi signal đóng góp bao nhiêu
R11C: Signal quality: WR và avg-R của mỗi signal với ADX18
R11D: Re-entry speed — sau khi exit, trung bình bao lâu có entry mới?
"""
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

def run_h01_full(cache, adx_thresh=18, return_trades=False):
    H.CACHE=cache
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
        if adv is None or adv<=adx_thresh: return False
        ap=adx4[i-1] if i>=1 else None
        if ap is None or ap<=adx_thresh: return False
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
    def sig_s12(i):
        if None in (e50[i],e200[i]) or i<1 or None in (e50[i-1],e200[i-1]): return None
        return "LONG" if e50[i-1]<=e200[i-1] and e50[i]>e200[i] else None
    def sig_s13(i):
        if atr4[i] is None or i<1: return None
        return "LONG" if c4[i]>bars4h[i-1]["close"]+atr4[i]*H.ATR_BREAK_MULT else None
    def sig_s14(i):
        if i<H.DONCHIAN_LB: return None
        hi=max(bars4h[j]["high"] for j in range(i-H.DONCHIAN_LB,i))
        return "LONG" if c4[i]>hi else None
    sigs={"S12":sig_s12,"S13":sig_s13,"S14":sig_s14}
    do_vol={"S12":False,"S13":True,"S14":True}
    CD={"S12":36,"S13":1,"S14":36}
    mo=defaultdict(float); trades_by_sig=defaultdict(list); last={s:0 for s in sigs}
    for i in range(250,n-H.MAX_HOLD):
        for sn,sfn in sigs.items():
            if sfn(i)!="LONG": continue
            if i-last[sn]<CD[sn]: continue
            if do_vol[sn] and not vol_pass(i): continue
            if not filt(i): continue
            r=sim(i)
            if r is None: continue
            ret,h=r; cts=bars4h[min(i+h,n-1)]["time"]
            mo[mo_str(cts)]+=ret; last[sn]=i
            trades_by_sig[sn].append((ret,h,bars4h[i]["time"],cts))
    return mo,trades_by_sig

print("="*90)
print("=== Round 11: Walk-forward ADX18 + Signal analysis ===\n")

# ─── R11A: Walk-forward verify ADX18 ───
print("━"*90)
print("R11A: Walk-forward selection test — ADX20 vs ADX18")
print("  Method: split data half1/half2, rank assets by half1 Sharpe → pick top2 → test half2")
print("  (replicates cycle 10 from general-rule doc)\n")

ASSETS=[("BTC",f"{CC}/binance-5m-7y.json"),("SOL",f"{CC}/binance-sol-5m-3y.json"),
        ("ETH",f"{CC}/binance-eth-5m-3y.json"),("BNB",f"{CC}/binance-bnb-5m-3y.json"),
        ("AVAX",f"{CC}/binance-avax-5m-3y.json"),("LINK",f"{CC}/binance-link-5m-3y.json"),
        ("ADA",f"{CC}/binance-ada-5m-3y.json")]

for adx_t in [20,18]:
    print(f"  ADX{adx_t}:")
    momap={}
    for nm,path in ASSETS:
        try:
            mo_,_=run_h01_full(path,adx_thresh=adx_t)
            momap[nm]=mo_
        except: pass
    # find SOL window for half split
    sol_months=sorted(momap.get("SOL",{}).keys()) if "SOL" in momap else []
    if not sol_months: print("  SOL data missing"); continue
    half=len(sol_months)//2
    h1_months=set(sol_months[:half]); h2_months=set(sol_months[half:])
    ranks_h1=[]
    for nm in momap:
        v1=[momap[nm].get(m,0.0) for m in sol_months[:half]]
        sh1=sharpe(v1); ranks_h1.append((sh1,nm))
    ranks_h1.sort(reverse=True)
    top2=[nm for _,nm in ranks_h1[:2]]
    print(f"    Half1 rank: {[(nm,f'{sh:.2f}') for sh,nm in ranks_h1]}")
    print(f"    Top2 selected: {top2}")
    # Half2 OOS performance
    for nm,_ in ranks_h1:
        v2=[momap[nm].get(m,0.0) for m in sol_months[half:]]
        sh2=sharpe(v2); tot2=sum(v2)*100
        mark="★" if nm in top2 else ""
        print(f"      {mark}{nm}: OOS Sh{sh2:+.2f} TOT{tot2:+.0f}%")
    # OOS book if top2 have data
    if len(top2)>=2 and all(nm in momap for nm in top2):
        v2a=[momap[top2[0]].get(m,0.0) for m in sol_months[half:]]
        v2b=[momap[top2[1]].get(m,0.0) for m in sol_months[half:]]
        tB_h2=[turB.get(m,0.0) for m in sol_months[half:]]
        p=[(v2a[i]+v2b[i]+tB_h2[i])/3 for i in range(len(sol_months[half:]))]
        print(f"    OOS book: Sh{sharpe(p):+.2f} TOT{sum(p)*100:+.0f}%")
    print()

# ─── R11B: Signal contribution breakdown ───
print("━"*90)
print("R11B: Signal contribution — S12/S13/S14 breakdown (ADX18, BTC)")
_,trades_20=run_h01_full(f"{CC}/binance-5m-7y.json",adx_thresh=20)
_,trades_18=run_h01_full(f"{CC}/binance-5m-7y.json",adx_thresh=18)
print(f"\n  {'Sig':>4} | {'n-ADX20':>7} | {'WR-ADX20':>8} | {'AvgR-ADX20':>10} | {'n-ADX18':>7} | {'WR-ADX18':>8} | {'AvgR-ADX18':>10}")
print("  "+"-"*75)
for sn in ["S12","S13","S14"]:
    t20=trades_20.get(sn,[]); t18=trades_18.get(sn,[])
    if t20:
        wr20=sum(1 for r,_,_,_ in t20 if r>0)/len(t20)*100
        ar20=sum(r for r,_,_,_ in t20)/len(t20)*100
    else: wr20=ar20=0
    if t18:
        wr18=sum(1 for r,_,_,_ in t18 if r>0)/len(t18)*100
        ar18=sum(r for r,_,_,_ in t18)/len(t18)*100
    else: wr18=ar18=0
    n20=len(t20); n18=len(t18)
    print(f"  {sn:>4} | {n20:>7} | {wr20:>7.0f}% | {ar20:>+9.1f}% | {n18:>7} | {wr18:>7.0f}% | {ar18:>+9.1f}%")

# ─── R11C: Ablation — disable each signal ───
print("\n━"*90)
print("R11C: Signal ablation — remove each signal, see book impact (ADX18)")
for skip_sig in ["S12","S13","S14"]:
    H.CACHE=f"{CC}/binance-5m-7y.json"
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
    def filt(i,adx_t=18):
        adv=adx4[i]
        if adv is None or adv<=adx_t: return False
        ap=adx4[i-1] if i>=1 else None
        if ap is None or ap<=adx_t: return False
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
    sigs_abl={"S12":s12,"S13":s13,"S14":s14}
    del sigs_abl[skip_sig]
    dov={"S12":False,"S13":True,"S14":True}; CD={"S12":36,"S13":1,"S14":36}
    mo_abl=defaultdict(float); last={s:0 for s in sigs_abl}
    for i in range(250,n-H.MAX_HOLD):
        for sn,sfn in sigs_abl.items():
            if sfn(i)!="LONG": continue
            if i-last[sn]<CD[sn]: continue
            if dov[sn] and not vol_pass(i): continue
            if not filt(i): continue
            r=sim(i)
            if r is None: continue
            ret,h=r; cts=bars4h[min(i+h,n-1)]["time"]
            mo_abl[mo_str(cts)]+=ret; last[sn]=i
    H.CACHE=f"{CC}/binance-sol-5m-3y.json"
    bars4h=H.load_tf(H.H4); bars1h=H.load_tf(3600*1000); bars1d=H.load_tf(86400*1000)
    n=len(bars4h); c4=[b["close"] for b in bars4h]
    e50=H.ema_s(c4,H.EMA_FAST); e200=H.ema_s(c4,H.EMA_SLOW)
    atr4=H.atr_series(bars4h); adx4=H.adx_wilder(bars4h)
    e200_1h=H.ema_s([b["close"] for b in bars1h],200); h1t=[b["time"] for b in bars1h]
    regime_1d=H.regime_with_persistence(bars1d)
    reg_map={b["time"]//86400000:regime_1d[i] for i,b in enumerate(bars1d)}
    sigs_abl2={"S12":lambda i:(None if None in (e50[i],e200[i]) or i<1 or None in (e50[i-1],e200[i-1]) else ("LONG" if e50[i-1]<=e200[i-1] and e50[i]>e200[i] else None)),"S13":lambda i:(None if atr4[i] is None or i<1 else ("LONG" if c4[i]>bars4h[i-1]["close"]+atr4[i]*H.ATR_BREAK_MULT else None)),"S14":lambda i:(None if i<H.DONCHIAN_LB else ("LONG" if c4[i]>max(bars4h[j]["high"] for j in range(i-H.DONCHIAN_LB,i)) else None))}
    del sigs_abl2[skip_sig]
    mo_abl_s=defaultdict(float); last2={s:0 for s in sigs_abl2}
    for i in range(250,n-H.MAX_HOLD):
        for sn in sigs_abl2:
            sfn=sigs_abl2[sn]
            if sfn(i)!="LONG": continue
            if i-last2[sn]<CD[sn]: continue
            if dov[sn] and not vol_pass(i): continue
            if not filt(i): continue
            r=sim(i)
            if r is None: continue
            ret,h=r; cts=bars4h[min(i+h,n-1)]["time"]
            mo_abl_s[mo_str(cts)]+=ret; last2[sn]=i
    sb_=[mo_abl.get(m,0.0) for m in cal]; ss_=[mo_abl_s.get(m,0.0) for m in cal]
    p=[(sb_[i]+ss_[i]+sTB[i])/3 for i in range(len(cal))]
    sh=sharpe(p); md=maxdd(p); tot=sum(p)*100; fl=sum(1 for x in p if abs(x)<1e-9)
    diff_sh=sh-1.50; diff_tot=tot-159
    print(f"  Skip {skip_sig}: Sh{sh:+.2f} DD{md:.1f}% TOT{tot:+.0f}% flat{fl}/35 | ΔSh{diff_sh:+.2f} ΔTOT{diff_tot:+.0f}%")
print(f"  [ADX18 full S12+S13+S14]: Sh+1.50 DD10.9% TOT+159% flat10/35")

print("\n"+"="*90)
print("ROUND 11 COMPLETE")
print("  Walk-forward: see above for OOS Sh comparison ADX18 vs ADX20")
print("  Signal ablation: identifies which signals are load-bearing")
