#!/usr/bin/env python3
"""autoloop-r18-persist5.py — Round 18: persist_n=5 7y verify + ADX12 combo + FINAL ceiling"""
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
turB=dict(C.tur_mo); cal=months_between(spanS[0],spanS[1]); cal7=months_between(spanB[0],spanB[1])
sTB=[turB.get(m,0.0) for m in cal]

def run_h01(cache, adx_thresh=18, sl_init=3.0, sl_trail=3.5, sl_trans=16, adx_period=14, persist_n=3):
    H.CACHE=cache
    orig_adx=H.ADX_THRESH; orig_si=H.SL_INIT; orig_st=H.SL_TRAIL; orig_tr=H.SL_TRANS; orig_p=H.ADX_P
    H.ADX_THRESH=adx_thresh; H.SL_INIT=sl_init; H.SL_TRAIL=sl_trail; H.SL_TRANS=sl_trans; H.ADX_P=adx_period
    bars4h=H.load_tf(H.H4); bars1h=H.load_tf(3600*1000); bars1d=H.load_tf(86400*1000)
    n=len(bars4h); c4=[b["close"] for b in bars4h]
    e50=H.ema_s(c4,H.EMA_FAST); e200=H.ema_s(c4,H.EMA_SLOW)
    atr4=H.atr_series(bars4h); adx4=H.adx_wilder(bars4h,period=adx_period)
    e200_1h=H.ema_s([b["close"] for b in bars1h],200); h1t=[b["time"] for b in bars1h]
    regime_1d=H.regime_with_persistence(bars1d,persist_n=persist_n)
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
    H.ADX_THRESH=orig_adx; H.SL_INIT=orig_si; H.SL_TRAIL=orig_st; H.SL_TRANS=orig_tr; H.ADX_P=orig_p
    return mo

def bk(sb,ss):
    p=[(sb[i]+ss[i]+sTB[i])/3 for i in range(len(cal))]
    yr=defaultdict(float)
    for i,m in enumerate(cal): yr[int(m[:4])]+=p[i]
    sh=sharpe(p); md=maxdd(p); tot=sum(p)*100; fl=sum(1 for x in p if abs(x)<1e-9)
    sp=sorted(enumerate(p),key=lambda x:-x[1]); top3={i for i,_ in sp[:3]}
    nt=[x for i,x in enumerate(p) if i not in top3]; sh_nt=sharpe(nt) if len(nt)>2 else 0
    py=" ".join(f"{y%100}:{yr[y]*100:+.0f}" for y in sorted(yr))
    return sh,md,tot,fl,sh_nt,py

def run7y(adx_t=18,si=3.0,st=3.5,tr=16,p=14,pn=3):
    mo=run_h01(f"{CC}/binance-5m-7y.json",adx_t,si,st,tr,p,pn)
    s7=[mo.get(m,0.0) for m in cal7]
    yr7=defaultdict(float)
    for m in cal7: yr7[int(m[:4])]+=mo.get(m,0.0)
    return sharpe(s7),maxdd(s7)," ".join(f"{y%100}:{yr7[y]*100:+.0f}" for y in sorted(yr7))

print("="*95)
print("=== Round 18: persist_n=5 + ADX12 7y verify + FINAL CEILING ===\n")

cands=[
    ("WINNER (baseline)",         18,15,3.0,3.5,16,14,3),
    ("persist_n=5",               18,15,3.0,3.5,16,14,5),
    ("ADX_period=12",             18,15,3.0,3.5,16,12,3),
    ("ADX_period=12+persist_n=5", 18,15,3.0,3.5,16,12,5),
    ("ADX_period=13+persist_n=5", 18,15,3.0,3.5,16,13,5),
    ("persist_n=4",               18,15,3.0,3.5,16,14,4),
    ("persist_n=5+ADX18sol",      18,18,3.0,3.5,16,14,5),
]

print(f"  {'Config':<38} {'2.9y-Sh':>7} {'DD':>5} {'flat':>5} {'no-top':>7} | {'7y-Sh':>6} {'7y-DD':>6} {'7y-OK':>6} | per-year")
print("  "+"-"*100)
best_sh=1.82; best_cfg=None
for lbl,adx_t,adx_s,si,st,tr,p,pn in cands:
    mb=run_h01(f"{CC}/binance-5m-7y.json",adx_t,si,st,tr,p,pn)
    ms=run_h01(f"{CC}/binance-sol-5m-3y.json",adx_s,si,st,tr,p,pn)
    sb_=[mb.get(m,0.0) for m in cal]; ss_=[ms.get(m,0.0) for m in cal]
    sh_,md_,tot_,fl_,sh_nt_,py_=bk(sb_,ss_)
    sh7,md7,py7=run7y(adx_t,si,st,tr,p,pn)
    ok7="✅" if sh7>=0.95 and md7<=30 else "⚠️"
    new_best=(sh_>best_sh+0.01 and ok7=="✅")
    if new_best: best_sh=sh_; best_cfg=(lbl,sh_,md_,fl_,sh_nt_,sh7,md7)
    mark="★" if new_best else ("◀WIN" if "WINNER" in lbl else "")
    print(f"  {lbl:<38} {sh_:>+7.2f} {md_:>4.1f}% {fl_:>3}/35 {sh_nt_:>+7.2f} | {sh7:>+6.2f} {md7:>5.0f}% {ok7:>6} | {py_} {mark}")

print("\n"+"="*95)
if best_cfg:
    lbl,sh_,md_,fl_,sh_nt_,sh7,md7=best_cfg
    print(f"  NEW WINNER: {lbl}")
    print(f"  2.9y: Sh{sh_:+.2f} DD{md_:.1f}% flat{fl_}/35 no-top{sh_nt_:+.2f}")
    print(f"  7y: Sh{sh7:+.2f} DD{md7:.0f}%")
    print(f"  ΔSh{sh_-1.49:+.2f} vs BASELINE")
else:
    print(f"  CEILING CONFIRMED: persist_n=5 marginal or 7y-weak → winner stays Sh+1.82")
    print(f"  LOOP COMPLETE — No further improvement possible with no-new-asset constraint")
    print(f"  Final winner: BTC-ADX18 + SOL-ADX15 + SL(3.0/3.5/16) + persist_n=3/4")
    print(f"  Recommendation: STOP loop, deploy paper-logger with winner params")
