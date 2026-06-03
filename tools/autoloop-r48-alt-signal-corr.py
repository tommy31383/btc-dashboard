#!/usr/bin/env python3
"""autoloop-r48-alt-signal-corr.py — Round 48: Alt-asset signal correlation vs BTC
R47 breakthrough: Signal corr is the right metric (not price corr or portfolio Sharpe)
BTC↔SOL=-0.148 (diversifier), BTC↔ETH=+0.639 (redundant)
R48: Check all alts for signal-level corr vs BTC → find hidden diversifiers
R48A: Signal corr matrix for all 9 alts
R48B: Best low-corr alt candidates + quality check
R48C: Best low-corr alt portfolio impact
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

def run_h01_mo(cache, adx_thresh=18, max_hold=200):
    H.CACHE=cache
    orig=(H.ADX_THRESH,H.SL_INIT,H.SL_TRAIL,H.SL_TRANS,H.ADX_P,
          H.ATR_BREAK_MULT,H.VOL_MULT,H.VOL_MA,H.MAX_HOLD)
    H.ADX_THRESH=adx_thresh; H.MAX_HOLD=max_hold
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
    s12=lambda i:(None if None in (e50[i],e200[i]) or i<1 or None in (e50[i-1],e200[i-1]) else ("LONG" if e50[i-1]<=e200[i-1] and e50[i]>e200[i] else None))
    s13=lambda i:(None if atr4[i] is None or i<1 else ("LONG" if c4[i]>bars4h[i-1]["close"]+atr4[i]*H.ATR_BREAK_MULT else None))
    s14=lambda i:(None if i<H.DONCHIAN_LB else ("LONG" if c4[i]>max(bars4h[j]["high"] for j in range(i-H.DONCHIAN_LB,i)) else None))
    sigs={"S12":(s12,False,36),"S13":(s13,True,1),"S14":(s14,True,36)}
    mo=defaultdict(float); last={s:0 for s in sigs}; trades=[]
    for i in range(250,n-H.MAX_HOLD):
        for sn,(sfn,dov,cd) in sigs.items():
            if sfn(i)!="LONG": continue
            if i-last[sn]<cd: continue
            if dov and not vol_pass(i): continue
            if not filt(i): continue
            r=sim(i)
            if r is None: continue
            ret,h=r; cts=bars4h[min(i+h,n-1)]["time"]
            mo[mo_str(cts)]+=ret; trades.append((mo_str(cts),sn,ret,h)); last[sn]=i
    (H.ADX_THRESH,H.SL_INIT,H.SL_TRAIL,H.SL_TRANS,H.ADX_P,
     H.ATR_BREAK_MULT,H.VOL_MULT,H.VOL_MA,H.MAX_HOLD)=orig
    return mo,trades

print("Loading BTC baseline...")
moB,trB=run_h01_mo(f"{CC}/binance-5m-7y.json",18)
moS,trS=run_h01_mo(f"{CC}/binance-sol-5m-3y.json",15)
sB=[moB.get(m,0.0) for m in cal3]; sS=[moS.get(m,0.0) for m in cal3]
sh_base=sharpe([(sB[i]+sS[i]+sTB3[i])/3 for i in range(len(cal3))])

ALTS=[("ETH",18),("BNB",18),("AVAX",18),("ADA",18),("XRP",18),
      ("DOGE",18),("DOT",18),("LINK",18),("LTC",18)]

print("Loading all alts...")
alt_data={}
for nm,adxt in ALTS:
    path=f"{CC}/binance-{nm.lower()}-5m-3y.json"
    if os.path.exists(path):
        try:
            mo_,tr_=run_h01_mo(path,adxt); alt_data[nm]=(mo_,tr_)
            print(f"  {nm} loaded ({len(tr_)} trades)")
        except: pass

print("="*100)
print("=== R48: Alt-asset signal correlation matrix ===\n")

# ─── R48A: Signal correlation matrix ───
print("━"*100)
print("R48A: Signal correlation vs BTC (monthly return vectors)")
print(f"  {'Asset':<7} {'BTC_corr':>9} {'SOL_corr':>9} {'n_tr':>5} {'avg_ret%':>9} {'WR%':>6} {'Sh_indiv':>9} | Portfolio impact")
print("  "+"-"*75)
print(f"  {'BTC':<7} {1.0:>9.3f} {-0.148:>9.3f} {len([t for t in trB if t[0]>=cal3[0]]):>5} {'':>9} {'':>6} {'':>9} | baseline")
print(f"  {'SOL':<7} {-0.148:>9.3f} {1.0:>9.3f} {len(trS):>5} {sum(t[2] for t in trS)/len(trS)*100:>+8.1f}% {sum(1 for t in trS if t[2]>0)/len(trS)*100:>5.0f}% {sharpe(sS):>+9.2f} | BASELINE")

candidates=[]
for nm,(mo_,tr_) in alt_data.items():
    sA=[mo_.get(m,0.0) for m in cal3]
    corr_btc=corr(sB,sA); corr_sol=corr(sS,sA)
    n_tr=len(tr_)
    avg_r=sum(t[2] for t in tr_)/n_tr*100 if n_tr>0 else 0
    wr=sum(1 for t in tr_ if t[2]>0)/n_tr*100 if n_tr>0 else 0
    sh_a=sharpe(sA)
    # Portfolio impact (equal weight added alongside BTC+SOL+turtle)
    v_add=[(sB[i]+sA[i]+sS[i]+sTB3[i])/4 for i in range(len(cal3))]
    delta_sh=sharpe(v_add)-sh_base
    flag="✅ DIVERSE" if abs(corr_btc)<0.3 and avg_r>0 else ("⚠️ low-corr" if abs(corr_btc)<0.3 else "")
    print(f"  {nm:<7} {corr_btc:>+9.3f} {corr_sol:>+9.3f} {n_tr:>5} {avg_r:>+8.1f}% {wr:>5.0f}% {sh_a:>+9.2f} | dSh{delta_sh:>+.3f} {flag}")
    if abs(corr_btc)<0.4: candidates.append((nm,corr_btc,avg_r,sh_a,sA))

# ─── R48B: Low-corr candidates ───
print("\n━"*100)
print("R48B: Low-corr candidates (|corr_BTC| < 0.4)")
if not candidates:
    print("  No candidates found with |corr_BTC| < 0.4")
else:
    for nm,cb,avg_r,sh_a,sA in sorted(candidates, key=lambda x:abs(x[1])):
        n_tr=len(alt_data[nm][1])
        wr=sum(1 for t in alt_data[nm][1] if t[2]>0)/n_tr*100 if n_tr>0 else 0
        print(f"  {nm}: corr_BTC={cb:+.3f}, avg_ret={avg_r:+.1f}%, WR={wr:.0f}%, Sh={sh_a:+.2f}")
        # Month-by-month: does it fire when BTC doesn't?
        covers=sum(1 for m in cal3 if sA[cal3.index(m)]>0 and sB[cal3.index(m)]<=0)
        active=sum(1 for m in cal3 if abs(sA[cal3.index(m)])>1e-9)
        if active>0: print(f"    Covers BTC failure: {covers}/{active} active months ({covers/active*100:.0f}%)")

# ─── R48C: Best low-corr alt portfolio impact ───
if candidates:
    print("\n━"*100)
    print("R48C: Low-corr alt portfolio testing (weight sweep)")
    for nm,cb,avg_r,sh_a,sA in sorted(candidates, key=lambda x:abs(x[1]))[:3]:
        print(f"\n  Testing {nm} (corr_BTC={cb:+.3f}):")
        print(f"  {'weight':>7} | {'Sh':>7} {'DD':>5} {'flat':>5} {'delta_Sh':>9}")
        for w in [0.1,0.25,0.5,1.0]:
            v=[(sB[i]+w*sA[i]+sS[i]+sTB3[i])/(3+w) for i in range(len(cal3))]
            sh_=sharpe(v); md_=maxdd(v); fl_=sum(1 for x in v if abs(x)<1e-9)
            mark="★" if sh_>sh_base+0.01 else ""
            print(f"  {w:>7.2f} | {sh_:>+7.2f} {md_:>4.1f}% {fl_:>3}/35 {sh_-sh_base:>+8.3f} {mark}")

print("\n"+"="*100)
print("R48 CONCLUSIONS")
print(f"  Baseline Sh: {sh_base:+.3f}")
print(f"  Known diversifiers: SOL (corr=-0.148 ✅)")
print(f"  Known redundant: ETH (corr=+0.639 ❌)")
if candidates:
    print(f"  New low-corr candidates: {[nm for nm,*_ in candidates]}")
    print(f"  → Check R48C for portfolio impact")
else:
    print(f"  No hidden diversifiers found among 9 alts")
    print(f"  → SOL is UNIQUE as a low-corr diversifier. Framework finalized.")
