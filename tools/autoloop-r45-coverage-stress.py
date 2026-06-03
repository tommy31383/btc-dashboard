#!/usr/bin/env python3
"""autoloop-r45-coverage-stress.py — Round 45: Coverage thesis + stress test
KEY THESIS: BTC/SOL signals (RANGE-only) + Turtle (BULL-dominant) = full cycle coverage
R45A: Regime-conditional returns — prove BTC vs Turtle complement
R45B: Book return by market regime type (BULL/BEAR/RANGE)
R45C: Drawdown stress — worst 6-month rolling window per config
R45D: Comparison vs B&H and simple HODL strategies
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

_,_,_,spanB=Hh.run_hedge01(f"{CC}/binance-5m-7y.json",skip_cal=False)
_,_,_,spanS=Hh.run_hedge01(f"{CC}/binance-sol-5m-3y.json",skip_cal=False)
turB=dict(C.tur_mo)
cal7=months_between(spanB[0],spanB[1])
cal3=months_between(spanS[0],spanS[1])

def run_h01(cache, adx_thresh=18, sl_init=3.0, sl_trail=3.5, sl_trans=16,
            adx_period=12, atr_break_mult=1.3, vol_mult=1.4, vol_ma=10, max_hold=200):
    H.CACHE=cache
    orig=(H.ADX_THRESH,H.SL_INIT,H.SL_TRAIL,H.SL_TRANS,H.ADX_P,
          H.ATR_BREAK_MULT,H.VOL_MULT,H.VOL_MA,H.MAX_HOLD)
    H.ADX_THRESH=adx_thresh; H.SL_INIT=sl_init; H.SL_TRAIL=sl_trail; H.SL_TRANS=sl_trans
    H.ADX_P=adx_period; H.ATR_BREAK_MULT=atr_break_mult; H.VOL_MULT=vol_mult
    H.VOL_MA=vol_ma; H.MAX_HOLD=max_hold
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
    # Get regime per month
    regime_mo=defaultdict(lambda:defaultdict(int))
    for b in bars1d:
        m_=mo_str(b["time"]); rg=get_reg(b["time"])
        regime_mo[m_][rg]+=1
    (H.ADX_THRESH,H.SL_INIT,H.SL_TRAIL,H.SL_TRANS,H.ADX_P,
     H.ATR_BREAK_MULT,H.VOL_MULT,H.VOL_MA,H.MAX_HOLD)=orig
    return mo,regime_mo

# ─── Load data ───
print("Loading BTC 7y + SOL 3y...")
moB7,reg7=run_h01_full=run_h01(f"{CC}/binance-5m-7y.json",18)
moS3,_=run_h01(f"{CC}/binance-sol-5m-3y.json",15)

# Load BTC price for B&H
H.CACHE=f"{CC}/binance-5m-7y.json"
bars1mo_btc=H.load_tf(H.H4)

# BTC monthly price returns (B&H proxy using 4h close at month boundaries)
btc_mo_ret={}
month_closes=defaultdict(list)
for b in bars1mo_btc:
    m_=mo_str(b["time"]); month_closes[m_].append(b["close"])
prev_close=None
for m_ in sorted(month_closes.keys()):
    closes=month_closes[m_]
    open_=closes[0]; close_=closes[-1]
    if prev_close:
        btc_mo_ret[m_]=(close_-prev_close)/prev_close
    prev_close=close_

print("="*100)
print("=== R45: Coverage thesis + stress test + B&H comparison ===\n")

# ─── R45A: Regime-conditional returns ───
print("━"*100)
print("R45A: BTC signal returns vs Turtle by dominant regime")
regime_btc=defaultdict(list); regime_tur=defaultdict(list); regime_book=defaultdict(list)
regime_bah=defaultdict(list)
for m in cal7:
    regs=reg7.get(m,{})
    dom_reg=max(regs,key=regs.get) if regs else "RANGE"
    btc_r=moB7.get(m,0.0); tur_r=turB.get(m,0.0); book_r=(btc_r+tur_r)/2
    bah_r=btc_mo_ret.get(m,0.0)
    regime_btc[dom_reg].append(btc_r); regime_tur[dom_reg].append(tur_r)
    regime_book[dom_reg].append(book_r); regime_bah[dom_reg].append(bah_r)

print(f"  {'Regime':<8} {'n_mo':>5} {'BTC_ret':>9} {'Tur_ret':>9} {'Book_ret':>9} {'B&H_ret':>9}")
print("  "+"-"*55)
for reg in ["RANGE","BULL","BEAR"]:
    if not regime_btc[reg]: continue
    n=len(regime_btc[reg])
    btc_avg=sum(regime_btc[reg])/n*100
    tur_avg=sum(regime_tur[reg])/n*100
    book_avg=sum(regime_book[reg])/n*100
    bah_avg=sum(regime_bah[reg])/n*100
    print(f"  {reg:<8} {n:>5} {btc_avg:>+8.1f}% {tur_avg:>+8.1f}% {book_avg:>+8.1f}% {bah_avg:>+8.1f}%")
print()
print("  COVERAGE THESIS: BTC signals should dominate RANGE, Turtle should dominate BULL")

# ─── R45B: Book return by regime type ───
print("\n━"*100)
print("R45B: Full 3y book (BTC+SOL+turtle) by regime")
moS3_dict=moS3; sTB3={m:turB.get(m,0.0) for m in cal3}
regime_book3=defaultdict(list)
for m in cal3:
    regs=reg7.get(m,{})
    dom_reg=max(regs,key=regs.get) if regs else "RANGE"
    btc_r=moB7.get(m,0.0); sol_r=moS3.get(m,0.0); tur_r=turB.get(m,0.0)
    book_r=(btc_r+sol_r+tur_r)/3
    regime_book3[dom_reg].append((m,book_r,btc_r,sol_r,tur_r))

for reg in ["RANGE","BULL","BEAR"]:
    items=regime_book3[reg]
    if not items: continue
    n=len(items)
    avg=sum(x[1] for x in items)/n*100
    pos=sum(1 for x in items if x[1]>0)
    sh_=sharpe([x[1] for x in items])
    print(f"  {reg:<8}: {n:>3} months, avg{avg:>+5.1f}% WR{pos/n*100:.0f}% Sh{sh_:+.2f}")
    bad=[x for x in items if x[1]<-0.01]
    if bad:
        print(f"    Worst months in {reg}:")
        for m_,book_r,btc_r,sol_r,tur_r in sorted(bad,key=lambda x:x[1])[:3]:
            print(f"      {m_}: book{book_r*100:+.1f}% (BTC{btc_r*100:+.1f} SOL{sol_r*100:+.1f} TUR{tur_r*100:+.1f})")

# ─── R45C: Rolling 6-month max drawdown ───
print("\n━"*100)
print("R45C: Worst rolling 6-month window (stress test)")
# Build cumulative monthly returns for book
book3_v=[(moB7.get(m,0.0)+moS3.get(m,0.0)+turB.get(m,0.0))/3 for m in cal3]
# Rolling 6-month windows
worst_6m=1.0; worst_6m_start=""
for i in range(len(cal3)-5):
    window=book3_v[i:i+6]
    cum=1.0
    for r in window: cum*=(1+r)
    if cum<worst_6m: worst_6m=cum; worst_6m_start=cal3[i]
print(f"  Worst 6-month window: starts {worst_6m_start}, return {(worst_6m-1)*100:+.1f}%")

# ─── R45D: B&H comparison ───
print("\n━"*100)
print("R45D: Book vs B&H vs simple HODL — 7y calendar (BTC component only for fair comparison)")
sB7=[moB7.get(m,0.0) for m in cal7]
sTB7=[turB.get(m,0.0) for m in cal7]
bah7=[btc_mo_ret.get(m,0.0) for m in cal7 if m in btc_mo_ret]

btc_sh=sharpe(sB7); btc_dd=maxdd(sB7)
tur_sh=sharpe(sTB7); tur_dd=maxdd(sTB7)
book7_v=[(sB7[i]+sTB7[i])/2 for i in range(len(cal7))]
book7_sh=sharpe(book7_v); book7_dd=maxdd(book7_v)
bah_sh=sharpe(bah7); bah_dd=maxdd(bah7)

yr_book7=defaultdict(float); yr_bah=defaultdict(float)
for i,m in enumerate(cal7):
    yr_book7[int(m[:4])]+=book7_v[i]
    yr_bah[int(m[:4])]+=btc_mo_ret.get(m,0.0)

print(f"  {'Strategy':<25} {'Sh':>7} {'DD':>6} {'Total%':>8} | per-year (approx)")
print("  "+"-"*70)
def py7(yr):
    return " ".join(f"{y%100}:{yr[y]*100:+.0f}" for y in sorted(yr))
print(f"  {'BTC B&H':<25} {bah_sh:>+7.2f} {bah_dd:>5.0f}% {sum(bah7)*100:>+7.0f}% | {py7(yr_bah)}")
print(f"  {'BTC signals only':<25} {btc_sh:>+7.2f} {btc_dd:>5.0f}% {sum(sB7)*100:>+7.0f}% | {py7(defaultdict(float,{int(m[:4]):moB7.get(m,0.0) for m in cal7}))}")
print(f"  {'Turtle only':<25} {tur_sh:>+7.2f} {tur_dd:>5.0f}% {sum(sTB7)*100:>+7.0f}%")
print(f"  {'BTC+Turtle (7y book)':<25} {book7_sh:>+7.2f} {book7_dd:>5.0f}% {sum(book7_v)*100:>+7.0f}% | {py7(yr_book7)}")

print("\n"+"="*100)
print("R45 COVERAGE THESIS VERDICT")
print("  → See R45A for RANGE/BULL/BEAR avg returns per strategy")
print("  → If BTC>0 in RANGE and Turtle>0 in BULL → COMPLEMENTARY coverage ✅")
print("  → Book+7y vs B&H: see R45D — should have higher Sh and lower DD")
