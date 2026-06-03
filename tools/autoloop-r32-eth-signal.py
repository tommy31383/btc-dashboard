#!/usr/bin/env python3
"""autoloop-r32-eth-signal.py — Round 32: ETH + regime sensitivity + volume-ratio signal
Scope mới: BTC + ETH + SOL (Tommy approved 2026-06-03)
R32A: Winner params trên ETH standalone verify
R32B: 3-asset book (BTC+ETH+SOL+turtle) vs 2-asset baseline
R32C: Regime detection sensitivity — thay đổi AR threshold + MA windows
R32D: Volume ratio signal (NEW) — vol tăng đột biến so với MA → potential breakout confirm
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
def sd(v):
    me=sum(v)/len(v); return (sum((x-me)**2 for x in v)/len(v))**.5 or 1e-9

_,_,_,spanB=Hh.run_hedge01(f"{CC}/binance-5m-7y.json",skip_cal=False)
_,_,_,spanS=Hh.run_hedge01(f"{CC}/binance-sol-5m-3y.json",skip_cal=False)
turB=dict(C.tur_mo)
cal=months_between(spanS[0],spanS[1])
cal7=months_between(spanB[0],spanB[1])
sTB=[turB.get(m,0.0) for m in cal]

def run_h01(cache, adx_thresh=18, sl_init=3.0, sl_trail=3.5, sl_trans=16,
            adx_period=12, atr_break_mult=1.3, vol_mult=1.4,
            vol_ma=10, max_hold=100, ar_thresh=0.04, ma_slow=200, ma_fast=50,
            extra_signal=None):
    H.CACHE=cache
    orig_adx=H.ADX_THRESH; orig_si=H.SL_INIT; orig_st=H.SL_TRAIL; orig_tr=H.SL_TRANS
    orig_p=H.ADX_P; orig_abm=H.ATR_BREAK_MULT; orig_vm=H.VOL_MULT
    orig_vma=H.VOL_MA; orig_mh=H.MAX_HOLD
    H.ADX_THRESH=adx_thresh; H.SL_INIT=sl_init; H.SL_TRAIL=sl_trail; H.SL_TRANS=sl_trans
    H.ADX_P=adx_period; H.ATR_BREAK_MULT=atr_break_mult; H.VOL_MULT=vol_mult
    H.VOL_MA=vol_ma; H.MAX_HOLD=max_hold

    bars4h=H.load_tf(H.H4); bars1h=H.load_tf(3600*1000); bars1d=H.load_tf(86400*1000)
    n=len(bars4h); c4=[b["close"] for b in bars4h]
    e50=H.ema_s(c4,ma_fast); e200=H.ema_s(c4,ma_slow)
    atr4=H.atr_series(bars4h); adx4=H.adx_wilder(bars4h,period=adx_period)
    e200_1h=H.ema_s([b["close"] for b in bars1h],ma_slow); h1t=[b["time"] for b in bars1h]

    # custom regime with ar_thresh
    def regime_custom(bars1d_):
        cs=[b["close"] for b in bars1d_]; n_=len(bars1d_)
        raw=["RANGE"]*n_
        for i in range(200,n_):
            ma200=sum(cs[i-199:i+1])/200; ma50=sum(cs[i-50:i+1])/50
            r20=bars1d_[i-19:i+1]
            ar=sum((b["high"]-b["low"])/b["close"] for b in r20)/20
            if cs[i]<ma200: raw[i]="BEAR"
            elif cs[i]>ma50 and ma50>ma200 and ar>ar_thresh: raw[i]="BULL"
        out=["RANGE"]*n_; cur="RANGE"; cnt=0; last_raw="RANGE"
        for i in range(n_):
            r=raw[i]
            if r==last_raw: cnt+=1
            else: cnt=1; last_raw=r
            if cnt>=3: cur=r
            out[i]=cur
        return out

    regime_1d=regime_custom(bars1d)
    reg_map={bars1d[i]["time"]//86400000:regime_1d[i] for i in range(len(bars1d))}
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

    # NEW: Volume ratio signal (S18)
    # Fires when: (1) volume spike > MA(5)×2.5, (2) price closes UP, (3) baseline S13/S14 pass filt
    def vol_ratio_pass(i, ratio=2.5, lb=5):
        if i<lb: return False
        ma_v=sum(bars4h[j]["volume"] for j in range(i-lb,i))/lb
        if ma_v<=0: return False
        return bars4h[i]["volume"]>=ma_v*ratio and c4[i]>bars4h[i-1]["close"]

    sigs={"S12":(s12,False,36),"S13":(s13,True,1),"S14":(s14,True,36)}
    if extra_signal=="S18_volratio":
        sigs["S18"]=(lambda i: "LONG" if vol_ratio_pass(i) else None, False, 4)

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
    H.ADX_THRESH=orig_adx; H.SL_INIT=orig_si; H.SL_TRAIL=orig_st; H.SL_TRANS=orig_tr
    H.ADX_P=orig_p; H.ATR_BREAK_MULT=orig_abm; H.VOL_MULT=orig_vm
    H.VOL_MA=orig_vma; H.MAX_HOLD=orig_mh
    return mo

def bk(parts, weights=None):
    k=len(parts); w=weights or [1]*k; sw=sum(w)
    p=[sum(w[j]*parts[j][i] for j in range(k))/sw for i in range(len(cal))]
    yr=defaultdict(float)
    for i,m in enumerate(cal): yr[int(m[:4])]+=p[i]
    sh=sharpe(p); md=maxdd(p); tot=sum(p)*100; fl=sum(1 for x in p if abs(x)<1e-9)
    sp=sorted(enumerate(p),key=lambda x:-x[1]); top3={i for i,_ in sp[:3]}
    nt=[x for i,x in enumerate(p) if i not in top3]; sh_nt=sharpe(nt) if len(nt)>2 else 0
    py=" ".join(f"{y%100}:{yr[y]*100:+.0f}" for y in sorted(yr))
    return sh,md,tot,fl,sh_nt,py,p

def pr(label,parts,weights=None):
    sh,md,tot,fl,sh_nt,py,_=bk(parts,weights)
    ok=sh>=1.90 and md<=10.0 and sh_nt>=1.50
    m="✅" if ok else ("⚠️" if sh>=1.70 else "❌")
    print(f"  {m} {label:<46} Sh{sh:>+5.2f} DD{md:>5.1f}% flat{fl:>3}/35 no-top{sh_nt:>+5.2f} | {py}")
    return sh,md,fl,sh_nt

# ─── Baseline winner sleeves ───
moB=run_h01(f"{CC}/binance-5m-7y.json",18); sB=[moB.get(m,0.0) for m in cal]
moS=run_h01(f"{CC}/binance-sol-5m-3y.json",15); sS=[moS.get(m,0.0) for m in cal]

print("="*100)
print("=== R32: ETH + Regime sensitivity + Volume-ratio signal (BTC/ETH/SOL) ===")
print(f"=== Window {cal[0]}→{cal[-1]} | WINNER baseline: Sh+1.96 DD8.3% flat10/35 ===\n")

# ─── R32A: ETH với winner params ───
print("━"*100)
print("R32A: ETH standalone với winner params (ADX18/SL3.0/3.5/16/ADX12/ABM1.3/VM1.4/MH100)")
ETH_ADXS=[14,15,16,17,18,19,20]
best_eth_sh=0; best_eth_adx=18; best_eth_mo=None
for adx_e in ETH_ADXS:
    me=run_h01(f"{CC}/binance-eth-5m-3y.json",adx_e)
    se=[me.get(m,0.0) for m in cal]
    sh_e=sharpe(se); tot_e=sum(se)*100; md_e=maxdd(se)
    n_e=sum(1 for v in me.values() if abs(v)>1e-9)
    yr_e=defaultdict(float)
    for m in cal: yr_e[int(m[:4])]+=me.get(m,0.0)
    py_e=" ".join(f"{y%100}:{yr_e[y]*100:+.0f}" for y in sorted(yr_e))
    if sh_e>best_eth_sh: best_eth_sh=sh_e; best_eth_adx=adx_e; best_eth_mo=me
    print(f"  ETH ADX{adx_e}: Sh{sh_e:>+5.2f} DD{md_e:>4.1f}% TOT{tot_e:>+5.0f}% n={n_e} | {py_e}")

print(f"  → Best ETH ADX: {best_eth_adx} Sh{best_eth_sh:+.2f}")

# ─── R32B: 3-asset book ───
print("\n━"*100)
print("R32B: 3-asset book BTC+ETH+SOL+turtle vs 2-asset baseline")
sE_best=[best_eth_mo.get(m,0.0) for m in cal]

# 2-asset winner baseline
pr("WINNER 2-asset BTC18+SOL15+turtle",[sB,sS,sTB])

# 3-asset variants
for lbl,adx_e in [(f"3-asset BTC+ETH{best_eth_adx}+SOL+turtle",best_eth_adx),
                   ("3-asset BTC+ETH18+SOL+turtle",18),
                   ("3-asset BTC+ETH16+SOL+turtle",16)]:
    me=run_h01(f"{CC}/binance-eth-5m-3y.json",adx_e)
    se=[me.get(m,0.0) for m in cal]
    pr(lbl,[sB,se,sS,sTB])

# risk-parity 3-asset
me_best=[best_eth_mo.get(m,0.0) for m in cal]
wrp=[1/sd(sB),1/sd(me_best),1/sd(sS),1/sd(sTB)]
pr(f"3-asset RISK-PARITY BTC+ETH{best_eth_adx}+SOL+turtle",[sB,me_best,sS,sTB],wrp)

# check correlation
print(f"\n  Correlations (2.9y monthly):")
def corr(a,b):
    ma=sum(a)/len(a); mb=sum(b)/len(b)
    num=sum((a[i]-ma)*(b[i]-mb) for i in range(len(a)))
    den=(sum((x-ma)**2 for x in a)*sum((x-mb)**2 for x in b))**.5 or 1e-9
    return num/den
print(f"  corr(BTC,ETH)={corr(sB,me_best):+.3f}")
print(f"  corr(BTC,SOL)={corr(sB,sS):+.3f}")
print(f"  corr(ETH,SOL)={corr(me_best,sS):+.3f}")
print(f"  corr(BTC,turtle)={corr(sB,sTB):+.3f}")

# ─── R32C: Regime detection sensitivity ───
print("\n━"*100)
print("R32C: Regime AR threshold sensitivity (định nghĩa BULL: ar>thresh)")
print("  (baseline AR=0.04, ma=200/50, persist=3)")
for ar_t in [0.02,0.03,0.04,0.05,0.06,0.08]:
    mb=run_h01(f"{CC}/binance-5m-7y.json",18,ar_thresh=ar_t)
    ms=run_h01(f"{CC}/binance-sol-5m-3y.json",15,ar_thresh=ar_t)
    sb_=[mb.get(m,0.0) for m in cal]; ss_=[ms.get(m,0.0) for m in cal]
    sh_,md_,fl_,sh_nt_=pr(f"AR={ar_t:.2f}",[sb_,ss_,sTB])

print("\n  MA window for RANGE/BULL detection (ma_slow, baseline=200):")
for ms_win in [100,150,200,250,300]:
    mb=run_h01(f"{CC}/binance-5m-7y.json",18,ma_slow=ms_win)
    ms=run_h01(f"{CC}/binance-sol-5m-3y.json",15,ma_slow=ms_win)
    sb_=[mb.get(m,0.0) for m in cal]; ss_=[ms.get(m,0.0) for m in cal]
    pr(f"MA_slow={ms_win}",[sb_,ss_,sTB])

# ─── R32D: Volume-ratio signal (NEW) ───
print("\n━"*100)
print("R32D: Volume-ratio signal S18 (spike vol > MA(5)×2.5 + price closes up)")
print("  Hypothesis: vol spike = institutional activity → higher quality breakout confirm")
mb_s18=run_h01(f"{CC}/binance-5m-7y.json",18,extra_signal="S18_volratio")
ms_s18=run_h01(f"{CC}/binance-sol-5m-3y.json",15,extra_signal="S18_volratio")
sb18=[mb_s18.get(m,0.0) for m in cal]; ss18=[ms_s18.get(m,0.0) for m in cal]
pr("WINNER + S18 volratio",[sb18,ss18,sTB])
# S18 standalone contribution
n_s18=sum(1 for v in mb_s18.values() if abs(v)>1e-9)
print(f"  S18 BTC trades: {n_s18}/35mo")

# vary S18 thresholds
for ratio,lb in [(2.0,5),(2.5,5),(3.0,5),(2.5,3),(2.5,10)]:
    def make_s18(r_,l_):
        def _s18(bars4h_,c4_,i_):
            if i_<l_: return False
            ma_v=sum(bars4h_[j]["volume"] for j in range(i_-l_,i_))/l_
            return ma_v>0 and bars4h_[i_]["volume"]>=ma_v*r_ and c4_[i_]>bars4h_[i_-1]["close"]
        return _s18
    # simple version: patch via run with modified vol ratio
    H_orig_vm=H.VOL_MULT
    mb2=run_h01(f"{CC}/binance-5m-7y.json",18,extra_signal="S18_volratio")
    H.VOL_MULT=H_orig_vm
    print(f"  S18 ratio={ratio} lb={lb}: (requires harness refactor — skip, use above)")
    break  # just test one variant for now

# ─── SUMMARY ───
print("\n"+"="*100)
print("R32 SUMMARY")
print("  ETH: best ADX for winner params?")
print("  3-asset book: does ETH add value vs 2-asset?")
print("  Regime AR: is 0.04 still optimal?")
print("  S18 vol-ratio: does volume spike improve signal quality?")
