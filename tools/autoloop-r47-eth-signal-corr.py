#!/usr/bin/env python3
"""autoloop-r47-eth-signal-corr.py — Round 47: ETH signal correlation + re-evaluate ETH
R46 breakthrough: SOL monthly signal corr = -0.148 (fires in DIFFERENT months from BTC!)
R47: Check ETH signal correlation vs BTC. If ETH also independent → ETH worth adding.
R47A: ETH monthly signal corr vs BTC + signal quality (S12/S13/S14)
R47B: ETH contribution breakdown month-by-month (like R46A for SOL)
R47C: Optimal ETH config given signal-independence (weight, MH)
R47D: 3-asset final verdict with signal-level reasoning
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
def corr(a,b):
    n=min(len(a),len(b)); a=a[:n]; b=b[:n]
    ma=sum(a)/n; mb=sum(b)/n
    num=sum((a[i]-ma)*(b[i]-mb) for i in range(n))
    da=(sum((x-ma)**2 for x in a)/n)**.5; db=(sum((x-mb)**2 for x in b)/n)**.5
    return num/(n*da*db) if da*db>0 else 0.0

_,_,_,spanB=Hh.run_hedge01(f"{CC}/binance-5m-7y.json",skip_cal=False)
_,_,_,spanS=Hh.run_hedge01(f"{CC}/binance-sol-5m-3y.json",skip_cal=False)
turB=dict(C.tur_mo); cal3=months_between(spanS[0],spanS[1])
sTB3=[turB.get(m,0.0) for m in cal3]

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
    mo=defaultdict(float); mo_cnt=defaultdict(int); last={s:0 for s in sigs}
    trades_detail=[]
    for i in range(250,n-H.MAX_HOLD):
        for sn,(sfn,dov,cd) in sigs.items():
            if sfn(i)!="LONG": continue
            if i-last[sn]<cd: continue
            if dov and not vol_pass(i): continue
            if not filt(i): continue
            r=sim(i)
            if r is None: continue
            ret,h=r; cts=bars4h[min(i+h,n-1)]["time"]
            m_=mo_str(cts); mo[m_]+=ret; mo_cnt[m_]+=1
            trades_detail.append((m_,sn,ret,h))
            last[sn]=i
    (H.ADX_THRESH,H.SL_INIT,H.SL_TRAIL,H.SL_TRANS,H.ADX_P,
     H.ATR_BREAK_MULT,H.VOL_MULT,H.VOL_MA,H.MAX_HOLD)=orig
    return mo,mo_cnt,trades_detail

print("Loading BTC+SOL+ETH...")
moB,cntB,trB=run_h01(f"{CC}/binance-5m-7y.json",18)
moS,cntS,trS=run_h01(f"{CC}/binance-sol-5m-3y.json",15)
moE,cntE,trE=run_h01(f"{CC}/binance-eth-5m-3y.json",18,max_hold=200)
sB=[moB.get(m,0.0) for m in cal3]; sS=[moS.get(m,0.0) for m in cal3]
sE=[moE.get(m,0.0) for m in cal3]

print("="*100)
print("=== R47: ETH signal correlation + re-evaluate ETH inclusion ===\n")

# ─── R47A: ETH signal quality vs BTC/SOL ───
print("━"*100)
print("R47A: ETH signal quality vs BTC+SOL")
print(f"  {'Asset':<6} {'n_trades':>9} {'avg_ret%':>9} {'WR%':>6} {'avg_hold':>9} | S12   S13   S14")
print("  "+"-"*65)
for nm,mo_,tr_ in [("BTC",moB,trB),("SOL",moS,trS),("ETH",moE,trE)]:
    tr_3y=[t for t in tr_ if t[0]>=cal3[0]]
    if not tr_3y: continue
    avg_r=sum(t[2] for t in tr_3y)/len(tr_3y)*100
    wr=sum(1 for t in tr_3y if t[2]>0)/len(tr_3y)*100
    avg_h=sum(t[3] for t in tr_3y)/len(tr_3y)
    sig_stats={}
    for sn in ["S12","S13","S14"]:
        ts_=[t for t in tr_3y if t[1]==sn]
        sig_stats[sn]=f"+{sum(t[2] for t in ts_)*100:.0f}%({len(ts_)}t)" if ts_ else "—"
    print(f"  {nm:<6} {len(tr_3y):>9} {avg_r:>+8.1f}% {wr:>5.0f}% {avg_h:>9.0f}bars | {sig_stats['S12']:<8} {sig_stats['S13']:<8} {sig_stats['S14']}")

# Correlations
corr_bs=corr(sB,sS); corr_be=corr(sB,sE); corr_se=corr(sS,sE)
print(f"\n  Monthly signal correlations:")
print(f"  BTC↔SOL: {corr_bs:+.3f} | BTC↔ETH: {corr_be:+.3f} | SOL↔ETH: {corr_se:+.3f}")

# ─── R47B: ETH month-by-month contribution ───
print("\n━"*100)
print("R47B: ETH contribution — does ETH fire in different months than BTC?")
print(f"  {'Month':<9} {'BTC':>7} {'ETH':>7} {'SOL':>7} {'same_BE':>8} {'ETH_unique':>10}")
print("  "+"-"*60)
eth_fires=[m for m in cal3 if abs(moE.get(m,0.0))>1e-9]
eth_covers_btc_fail=0; eth_adds_when_btc_good=0
for m in cal3:
    btc=moB.get(m,0.0); eth=moE.get(m,0.0); sol=moS.get(m,0.0)
    if abs(eth)<1e-9: continue  # skip inactive months
    sd="✅" if (btc>0)==(eth>0) or btc==0 else "❌"
    eth_unique=eth>0 and btc<=0  # ETH positive when BTC not
    if eth_unique: eth_covers_btc_fail+=1
    if eth>0 and btc>0: eth_adds_when_btc_good+=1
    mark="← covers BTC fail" if btc<0 and eth>0 else ""
    print(f"  {m:<9} {btc*100:>+6.1f}% {eth*100:>+6.1f}% {sol*100:>+6.1f}% {sd:>8} {'★' if eth_unique else ' ':>10} {mark}")

print(f"\n  ETH active months: {len(eth_fires)}/{len(cal3)}")
print(f"  ETH unique positive (BTC≤0): {eth_covers_btc_fail}/{len(eth_fires)} ({eth_covers_btc_fail/len(eth_fires)*100:.0f}% of ETH active months)")
print(f"  Both BTC+ETH positive: {eth_adds_when_btc_good}/{len(eth_fires)}")

# ─── R47C: Optimal ETH weight given signal independence ───
print("\n━"*100)
print("R47C: ETH weight optimization — with signal-independence understanding")
print(f"  {'eth_w':>7} | {'Sh':>7} {'DD':>5} {'flat':>5} {'TEST':>7} | corr_improvement")
print("  "+"-"*60)

# Baseline (no ETH)
def bk_sh(parts, weights=None, c=None):
    cc=c or cal3; k=len(parts); w=weights or [1]*k; sw=sum(w)
    p=[sum(w[j]*parts[j][i] for j in range(k))/sw for i in range(len(cc))]
    yr=defaultdict(float)
    for i,m in enumerate(cc): yr[int(m[:4])]+=p[i]
    sh=sharpe(p); md=maxdd(p); fl=sum(1 for x in p if abs(x)<1e-9)
    test_m=[m for m in cc if m[:4] in ("2025","2026")]
    sh_te=sharpe([p[cc.index(m)] for m in test_m if m in cc])
    py=" ".join(f"{y%100}:{yr[y]*100:+.0f}" for y in sorted(yr))
    return sh,md,fl,sh_te,py,p

sh_b,md_b,fl_b,te_b,py_b,_=bk_sh([sB,sS,sTB3])
print(f"  {'0 (no ETH)':>7} | {sh_b:>+7.2f} {md_b:>4.1f}% {fl_b:>3}/35 {te_b:>+7.2f} | baseline")
best_w=0; best_sh=sh_b
for ew in [0.1,0.15,0.2,0.25,0.3,0.4,0.5,0.75,1.0]:
    sh_,md_,fl_,te_,py_,_=bk_sh([sB,sE,sS,sTB3],[1,ew,1,1])
    delta_sh=sh_-sh_b; delta_dd=md_-md_b
    if sh_>best_sh: best_sh=sh_; best_w=ew
    mark="★" if sh_>sh_b+0.01 else ("✅" if delta_dd<-0.3 and sh_>=sh_b-0.02 else "")
    print(f"  {ew:>7.2f} | {sh_:>+7.2f} {md_:>4.1f}% {fl_:>3}/35 {te_:>+7.2f} | dSh{delta_sh:>+.3f} dDD{delta_dd:>+.1f}% {mark}")

# ─── R47D: Final 3-asset verdict ───
print("\n━"*100)
print("R47D: Final 3-asset verdict")
print(f"  {'Config':<48} {'Sh':>6} {'DD':>5} {'flat':>5} {'TEST':>7} {'corr_BTC-alt':>13} | per-year")
print("  "+"-"*95)

def pr(label, parts, weights=None, corr_label=""):
    sh_,md_,fl_,te_,py_,_=bk_sh(parts,weights)
    ok=sh_>=2.00 and md_<=9.0
    m="✅" if ok else ("⚠️" if sh_>=1.90 else "❌")
    print(f"  {m} {label:<47} Sh{sh_:>+5.2f} DD{md_:>4.1f}% flat{fl_:>3}/35 TE{te_:>+5.2f} {corr_label:>13} | {py_}")
    return sh_,md_

pr("2-asset BTC+SOL+turtle (baseline)",[sB,sS,sTB3],"",f"BTC↔SOL={corr_bs:+.3f}")
pr(f"3-asset ETH×0.25 (from R33)",[sB,sE,sS,sTB3],[1,0.25,1,1],f"BTC↔ETH={corr_be:+.3f}")
if best_w>0:
    sh_opt,md_opt=pr(f"3-asset ETH×{best_w:.2f} (R47 optimal)",[sB,sE,sS,sTB3],[1,best_w,1,1],"")

# Signal independence summary
print(f"\n  Signal independence summary:")
print(f"  BTC↔SOL monthly corr: {corr_bs:+.3f} ({'INDEPENDENT ✅' if abs(corr_bs)<0.3 else 'CORRELATED'})")
print(f"  BTC↔ETH monthly corr: {corr_be:+.3f} ({'INDEPENDENT ✅' if abs(corr_be)<0.3 else 'CORRELATED'})")
print(f"  SOL↔ETH monthly corr: {corr_se:+.3f} ({'INDEPENDENT ✅' if abs(corr_se)<0.3 else 'CORRELATED'})")
print()
print("  KEY FINDING: If ETH has LOW corr with BTC → ETH adds real diversification value")
print("  even if Sharpe improvement is marginal — DD reduction + independent signal months = real value")

print("\n"+"="*100)
print("R47 CONCLUSION")
