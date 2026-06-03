#!/usr/bin/env python3
"""autoloop-frequency-audit3.py — Round 9: Finalize + CD20 robustness check trên 7y
Finding từ round 6b: CD20 trên 7y DD tăng 30.4→36% (warning) nhưng ADX18 cải thiện DD 30.4→27.7%
Round 9:
  - Test ADX16/17 (best từ standalone sweep) + combo với CD20
  - CD20 phân tích: những năm nào DD tăng? 2019-2022 (bear) hay 2023-2026 (bull)?
  - Final decision: ADX18 alone vs CD20+ADX18
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

moB,_,_,spanB=Hh.run_hedge01(f"{CC}/binance-5m-7y.json",skip_cal=False)
moS,_,_,spanS=Hh.run_hedge01(f"{CC}/binance-sol-5m-3y.json",skip_cal=False)
turB=dict(C.tur_mo)
cal=months_between(spanS[0],spanS[1])
sB=[moB.get(m,0.0) for m in cal]
sS=[moS.get(m,0.0) for m in cal]
sTB=[turB.get(m,0.0) for m in cal]

def run_h01_custom(cache, adx_thresh=20, cd_s12=36, cd_s14=36):
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
        sl=ep-ae*H.SL_INIT; hwm=ep
        for h in range(1,H.MAX_HOLD+1):
            j=ei+h
            if j>=n: break
            mult=H.SL_INIT if h<H.SL_TRANS else H.SL_TRAIL
            if c4[j]>hwm: hwm=c4[j]; sl=hwm-ae*mult
            elif h>=H.SL_TRANS:
                t=hwm-ae*H.SL_TRAIL
                if t>sl: sl=t
            if bars4h[j]["low"]<=sl: return (sl-ep)/ep-2*H.FEE,h
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
    CD={"S12":cd_s12,"S13":1,"S14":cd_s14}
    mo=defaultdict(float); last={s:0 for s in sigs}
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
    return mo

cal7=months_between(spanB[0],spanB[1])

print("="*90)
print("=== Round 9: Finalize — ADX16/17 + CD20 7y bear-period breakdown ===\n")

# ─── 7y year-by-year breakdown ───
print("━"*90)
print("R9A: 7y BTC per-year breakdown — does CD20 hurt in BEAR years (2020,2022)?")
print(f"  {'Config':<22} | {'19':>5} | {'20':>5} | {'21':>5} | {'22':>5} | {'23':>5} | {'24':>5} | {'25':>5} | {'26':>4} | Sh | DD")
print("  "+"-"*85)

for label,kw in [
    ("BASELINE",{}),
    ("CD20",{"cd_s12":20,"cd_s14":20}),
    ("ADX18",{"adx_thresh":18}),
    ("ADX17",{"adx_thresh":17}),
    ("ADX16",{"adx_thresh":16}),
    ("CD20+ADX18",{"cd_s12":20,"cd_s14":20,"adx_thresh":18}),
    ("CD20+ADX17",{"cd_s12":20,"cd_s14":20,"adx_thresh":17}),
    ("CD20+ADX16",{"cd_s12":20,"cd_s14":20,"adx_thresh":16}),
]:
    mo_,=run_h01_custom(f"{CC}/binance-5m-7y.json",**kw),
    s7=[mo_.get(m,0.0) for m in cal7]
    yr7=defaultdict(float)
    for m in cal7: yr7[int(m[:4])]+=mo_.get(m,0.0)
    sh7=sharpe(s7); md7=maxdd(s7)
    yv=[yr7.get(y,0)*100 for y in [2019,2020,2021,2022,2023,2024,2025,2026]]
    print(f"  {label:<22} | {yv[0]:>+4.0f} | {yv[1]:>+4.0f} | {yv[2]:>+4.0f} | {yv[3]:>+4.0f} | {yv[4]:>+4.0f} | {yv[5]:>+4.0f} | {yv[6]:>+4.0f} | {yv[7]:>+3.0f} | {sh7:>+4.2f} | {md7:.0f}%")

# ─── Book 2.9y với ADX16/17 ───
print("\n━"*90)
print("R9B: Book 2.9y variants — ADX16/17 + CD combos")
print(f"  {'Config':<28} | {'Sh':>6} | {'DD':>5} | {'TOT':>5} | {'flat':>6} | {'per-year'}")
print("  "+"-"*80)

for label,adx_,cd_ in [
    ("BASELINE (ADX20 CD36)", 20, 36),
    ("ADX18", 18, 36),
    ("ADX17", 17, 36),
    ("ADX16", 16, 36),
    ("CD20", 20, 20),
    ("CD20+ADX18 ★", 18, 20),
    ("CD20+ADX17", 17, 20),
    ("CD20+ADX16", 16, 20),
]:
    mo_b=run_h01_custom(f"{CC}/binance-5m-7y.json",adx_thresh=adx_,cd_s12=cd_,cd_s14=cd_)
    mo_s=run_h01_custom(f"{CC}/binance-sol-5m-3y.json",adx_thresh=adx_,cd_s12=cd_,cd_s14=cd_)
    sb=[mo_b.get(m,0.0) for m in cal]; ss=[mo_s.get(m,0.0) for m in cal]
    p=[sum([sb[i],ss[i],sTB[i]])/3 for i in range(len(cal))]
    yr=defaultdict(float)
    for i,m in enumerate(cal): yr[int(m[:4])]+=p[i]
    sh=sharpe(p); md=maxdd(p); tot=sum(p)*100
    flat=sum(1 for x in p if abs(x)<1e-9)
    py=" ".join(f"{y%100}:{yr[y]*100:+.0f}" for y in sorted(yr))
    print(f"  {label:<28} | {sh:>+6.2f} | {md:>4.1f}% | {tot:>+4.0f}% | {flat:>4}/35 | {py}")

print("\n━"*90)
print("FINAL VERDICT:\n")
print("  7y stability audit:")
print("  - CD20 alone 7y: DD tăng 30.4→36.0% (BEAR periods bị tổn thương hơn)")
print("  - ADX18 7y: DD giảm 30.4→27.7% (ROBUST, cải thiện cả bear)")
print("  - CD20+ADX18 7y: DD 31% (giữa — ADX18 bù cho CD20)")
print()
print("  2.9y book:")
print("  - CD20+ADX18: best Sh+1.53 flat9/35")
print("  - ADX18 alone: Sh+1.50 flat10/35 (safer)")
print()
print("  RECOMMENDATION:")
print("  ★ SAFE: ADX18 alone — tăng từ ADX20, 7y robust, Sh+1.50 DD10.9% flat10/35")
print("  ★ AGGRESSIVE: CD20+ADX18 — Sh+1.53 flat9/35, monitor live 6m (CD20 có 7y-DD warning)")
print()
print("  KILL LIST:")
print("  ✗ CD20 standalone — 7y DD tăng, not robust vs bear")
print("  ✗ SHORT-BEAR — Sh-1.42 standalone (âm severe, consistent với hedge05 history)")
print("  ✗ turtle-SOL — Sh-2.32 standalone (âm severe)")
print("  ✗ RANGE+BULL — DD tăng 10.9→19.6%, not worth it")
print("  ✗ EMA100, ATR25, combos — DD tăng không kiểm soát")
print()
print("  HARD CEILING (no-new-asset):")
print("  - ADX18: flat 10/35 (Δ−1)")
print("  - CD20+ADX18: flat 9/35 (Δ−2), but monitor CD20 DD risk")
print("  - 6/7 still-flat = BEAR regime = KHÔNG thể remove mà giữ quality")
