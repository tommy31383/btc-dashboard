#!/usr/bin/env python3
"""autoloop-r41-btc-sl-filter.py — Round 41: BTC SL params + ATR/vol filter sweep
R40 result: SOL params at ceiling, turtle weight optimal at 1.0
R41A: BTC SL_INIT × SL_TRAIL × SL_TRANS sweep
R41B: ATR_PCT_PCTL filter sweep (volatility percentile gate)
R41C: VOL_MULT filter sweep (volume gate)
R41D: BTC+SOL combined best filter config
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
turB=dict(C.tur_mo); cal=months_between(spanS[0],spanS[1])
sTB=[turB.get(m,0.0) for m in cal]

def run_h01(cache, adx_thresh=18, sl_init=3.0, sl_trail=3.5, sl_trans=16,
            adx_period=12, atr_break_mult=1.3, vol_mult=1.4, vol_ma=10, max_hold=200,
            atr_pct_pctl=None, atr_pct_lb=None):
    H.CACHE=cache
    orig=(H.ADX_THRESH,H.SL_INIT,H.SL_TRAIL,H.SL_TRANS,H.ADX_P,
          H.ATR_BREAK_MULT,H.VOL_MULT,H.VOL_MA,H.MAX_HOLD)
    orig_pctl=H.ATR_PCT_PCTL; orig_lb=H.ATR_PCT_LB
    H.ADX_THRESH=adx_thresh; H.SL_INIT=sl_init; H.SL_TRAIL=sl_trail; H.SL_TRANS=sl_trans
    H.ADX_P=adx_period; H.ATR_BREAK_MULT=atr_break_mult; H.VOL_MULT=vol_mult
    H.VOL_MA=vol_ma; H.MAX_HOLD=max_hold
    if atr_pct_pctl is not None: H.ATR_PCT_PCTL=atr_pct_pctl
    if atr_pct_lb is not None: H.ATR_PCT_LB=atr_pct_lb
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
     H.ATR_BREAK_MULT,H.VOL_MULT,H.VOL_MA,H.MAX_HOLD)=orig
    H.ATR_PCT_PCTL=orig_pctl; H.ATR_PCT_LB=orig_lb
    return mo

def bk(parts, weights=None):
    k=len(parts); w=weights or [1]*k; sw=sum(w)
    p=[sum(w[j]*parts[j][i] for j in range(k))/sw for i in range(len(cal))]
    yr=defaultdict(float)
    for i,m in enumerate(cal): yr[int(m[:4])]+=p[i]
    sh=sharpe(p); md=maxdd(p); fl=sum(1 for x in p if abs(x)<1e-9)
    test_m=[m for m in cal if m[:4] in ("2025","2026")]
    sh_te=sharpe([p[cal.index(m)] for m in test_m if m in cal])
    py=" ".join(f"{y%100}:{yr[y]*100:+.0f}" for y in sorted(yr))
    return sh,md,fl,sh_te,py,p

# ─── Precompute SOL (fixed) ───
print("Loading SOL+BTC+turtle...")
moS=run_h01(f"{CC}/binance-sol-5m-3y.json",15); sS=[moS.get(m,0.0) for m in cal]
moB_base=run_h01(f"{CC}/binance-5m-7y.json",18); sB_base=[moB_base.get(m,0.0) for m in cal]
sh_base,dd_base,fl_base,te_base,py_base,_=bk([sB_base,sS,sTB])

print("="*100)
print(f"=== R41: BTC SL params + ATR/vol filter sweep ===")
print(f"  Baseline: Sh{sh_base:+.3f} DD{dd_base:.1f}% flat{fl_base}/35 TEST{te_base:+.2f}\n")
print(f"  H.ATR_PCT_PCTL={H.ATR_PCT_PCTL}, H.ATR_PCT_LB={H.ATR_PCT_LB}, H.VOL_MULT={H.VOL_MULT}")

# ─── R41A: BTC SL sweep ───
print("\n━"*100)
print("R41A: BTC SL sweep (SOL fixed) — SL_INIT × SL_TRAIL × SL_TRANS")
print(f"  {'SL_I':>5} {'SL_T':>5} {'SL_tr':>6} | {'BTC_Sh':>7} {'Port_Sh':>8} {'DD':>5} {'flat':>5} {'TEST':>7} {'delta':>7}")
print("  "+"-"*72)
best_btc_sl=(3.0,3.5,16); best_btc_sh=sh_base
for si in [2.5,3.0,3.5,4.0,4.5]:
    for st in [3.0,3.5,4.0,4.5]:
        if st<si: continue
        for tr in [12,16,20,24]:
            mB=run_h01(f"{CC}/binance-5m-7y.json",18,si,st,tr); sB=[mB.get(m,0.0) for m in cal]
            sh_,md_,fl_,te_,py_,_=bk([sB,sS,sTB])
            delta=sh_-sh_base
            if sh_>best_btc_sh and md_<=9.5: best_btc_sh=sh_; best_btc_sl=(si,st,tr)
            if abs(delta)>0.005 or (si==3.0 and st==3.5 and tr==16):
                mark="★" if delta>0.01 else ("◀ cur" if si==3.0 and st==3.5 and tr==16 else "")
                btc_sh=sharpe(sB)
                print(f"  {si:>5.1f} {st:>5.1f} {tr:>6} | {btc_sh:>+7.2f} {sh_:>+8.2f} {md_:>4.1f}% {fl_:>3}/35 {te_:>+7.2f} {delta:>+7.3f} {mark}")

si_b,st_b,tr_b=best_btc_sl
print(f"  Best BTC SL: init={si_b} trail={st_b} trans={tr_b} → Sh{best_btc_sh:+.3f} (delta{best_btc_sh-sh_base:+.3f})")

# ─── R41B: ATR_PCT_PCTL filter sweep ───
print("\n━"*100)
print("R41B: ATR percentile filter sweep — how strict should volatility gate be?")
print(f"  {'pctl':>6} {'lb':>5} | {'BTC_Sh':>7} {'Port_Sh':>8} {'DD':>5} {'flat':>5} {'TEST':>7} {'delta':>7}")
print("  "+"-"*65)
best_pctl=H.ATR_PCT_PCTL; best_lb=H.ATR_PCT_LB; best_pctl_sh=sh_base
cur_pctl=H.ATR_PCT_PCTL; cur_lb=H.ATR_PCT_LB
for pctl in [0.2,0.3,0.4,0.5,0.6,0.7]:
    for lb in [20,30,40,50]:
        mB=run_h01(f"{CC}/binance-5m-7y.json",18,atr_pct_pctl=pctl,atr_pct_lb=lb)
        sB=[mB.get(m,0.0) for m in cal]
        sh_,md_,fl_,te_,py_,_=bk([sB,sS,sTB])
        delta=sh_-sh_base
        if sh_>best_pctl_sh and md_<=9.5: best_pctl_sh=sh_; best_pctl=pctl; best_lb=lb
        mark="★" if delta>0.01 else ("◀ cur" if abs(pctl-cur_pctl)<0.01 and lb==cur_lb else "")
        if abs(delta)>0.005 or (abs(pctl-cur_pctl)<0.01 and lb==cur_lb):
            print(f"  {pctl:>6.2f} {lb:>5} | {sharpe(sB):>+7.2f} {sh_:>+8.2f} {md_:>4.1f}% {fl_:>3}/35 {te_:>+7.2f} {delta:>+7.3f} {mark}")

print(f"  Best ATR filter: pctl={best_pctl} lb={best_lb} → Sh{best_pctl_sh:+.3f} (delta{best_pctl_sh-sh_base:+.3f})")

# ─── R41C: VOL_MULT sweep ───
print("\n━"*100)
print("R41C: VOL_MULT sweep for BTC — volume gate strictness")
print(f"  {'vol_m':>6} | {'BTC_Sh':>7} {'Port_Sh':>8} {'DD':>5} {'flat':>5} {'TEST':>7} {'delta':>7}")
print("  "+"-"*58)
cur_vm=H.VOL_MULT; best_vm=cur_vm; best_vm_sh=sh_base
for vm in [1.0,1.1,1.2,1.3,1.4,1.5,1.6,1.8,2.0]:
    mB=run_h01(f"{CC}/binance-5m-7y.json",18,vol_mult=vm); sB=[mB.get(m,0.0) for m in cal]
    sh_,md_,fl_,te_,py_,_=bk([sB,sS,sTB])
    delta=sh_-sh_base
    if sh_>best_vm_sh and md_<=9.5: best_vm_sh=sh_; best_vm=vm
    mark="★" if delta>0.01 else ("◀ cur" if abs(vm-cur_vm)<0.05 else "")
    print(f"  {vm:>6.1f} | {sharpe(sB):>+7.2f} {sh_:>+8.2f} {md_:>4.1f}% {fl_:>3}/35 {te_:>+7.2f} {delta:>+7.3f} {mark}")

# ─── R41D: Best combined ───
print("\n━"*100)
print("R41D: Best combined BTC config")
print(f"  {'Config':<52} {'Sh':>6} {'DD':>5} {'flat':>5} {'TEST':>7} | per-year")
print("  "+"-"*88)

def pr(label,parts,weights=None):
    sh_,md_,fl_,te_,py_,_=bk(parts,weights)
    ok=sh_>=2.00 and md_<=9.0
    m="✅" if ok else ("⚠️" if sh_>=1.90 else "❌")
    print(f"  {m} {label:<51} Sh{sh_:>+5.2f} DD{md_:>4.1f}% flat{fl_:>3}/35 TE{te_:>+5.2f} | {py_}")
    return sh_,md_

pr("BASELINE BTC18+SOL15+turtle (orig)",[sB_base,sS,sTB])
si_b,st_b,tr_b=best_btc_sl
mB_sl=run_h01(f"{CC}/binance-5m-7y.json",18,si_b,st_b,tr_b)
sB_sl=[mB_sl.get(m,0.0) for m in cal]
pr(f"BTC SL{si_b}/{st_b}/{tr_b}",[sB_sl,sS,sTB])
mB_pf=run_h01(f"{CC}/binance-5m-7y.json",18,atr_pct_pctl=best_pctl,atr_pct_lb=best_lb)
sB_pf=[mB_pf.get(m,0.0) for m in cal]
pr(f"BTC ATR_pctl={best_pctl} lb={best_lb}",[sB_pf,sS,sTB])
mB_vm=run_h01(f"{CC}/binance-5m-7y.json",18,vol_mult=best_vm)
sB_vm=[mB_vm.get(m,0.0) for m in cal]
pr(f"BTC vol_mult={best_vm}",[sB_vm,sS,sTB])
# Combined best
mB_comb=run_h01(f"{CC}/binance-5m-7y.json",18,si_b,st_b,tr_b,vol_mult=best_vm,atr_pct_pctl=best_pctl,atr_pct_lb=best_lb)
sB_comb=[mB_comb.get(m,0.0) for m in cal]
sh_comb,md_comb=pr(f"BTC combined best",[sB_comb,sS,sTB])

print("\n"+"="*100)
print("R41 SUMMARY")
print(f"  Baseline: Sh{sh_base:+.3f} DD{dd_base:.1f}%")
print(f"  Best BTC SL: {best_btc_sl} → delta{best_btc_sh-sh_base:+.3f}")
print(f"  Best ATR filter: pctl={best_pctl} lb={best_lb} → delta{best_pctl_sh-sh_base:+.3f}")
print(f"  Best vol_mult: {best_vm} → delta{best_vm_sh-sh_base:+.3f}")
print(f"  Combined: Sh{sh_comb:+.3f} DD{md_comb:.1f}% → delta{sh_comb-sh_base:+.3f}")
print(f"  Status: {'BREAKTHROUGH ★★' if sh_comb>sh_base+0.02 else 'MARGINAL' if sh_comb>sh_base+0.005 else 'FLAT'}")
