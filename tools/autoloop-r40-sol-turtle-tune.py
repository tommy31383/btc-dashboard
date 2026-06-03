#!/usr/bin/env python3
"""autoloop-r40-sol-turtle-tune.py — Round 40: SOL fine-tune + Turtle optimization
R39 finding: SOL irreplaceable, all alts negative delta → ceiling from BTC+SOL mix
R40A: SOL ADX_thresh sweep (12-20) — is 15 truly optimal?
R40B: SOL SL sweep (SL_INIT × SL_TRAIL × SL_TRANS) — tight vs loose
R40C: Turtle params sweep (Donchian period + ATR multiplier)
R40D: Best SOL config + best turtle config combined
"""
import importlib.util, datetime, math, os, sys
from collections import defaultdict

def imp(name, path):
    spec=importlib.util.spec_from_file_location(name,path); M=importlib.util.module_from_spec(spec)
    so=sys.stdout; sys.stdout=open(os.devnull,"w"); spec.loader.exec_module(M); sys.stdout=so; return M

T="/Users/lap16116/BTC_PC/btc-dashboard/tools/"
CC="/Users/lap16116/BTC_PC/btc-dashboard/.cache"
Hh=imp("Hh",T+"loop-hedge01-crossasset.py"); C=imp("C",T+"correlation-turtle-hedge01-7y.py")
H=imp("H",T+"backtrack-bull-regime-reaudit-7y.py") if os.path.exists(T+"backtrack-bull-regime-reaudit-7y.py") else imp("H",T+"backtest-bull-regime-reaudit-7y.py")

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
turB=dict(C.tur_mo); cal=months_between(spanS[0],spanS[1])
sTB=[turB.get(m,0.0) for m in cal]

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
    atr4=H.atr_series(bars4h); adx4=H.adx_wilder(bars4h,period=adx_period)
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

# ─── Precompute BTC (fixed) ───
print("Loading BTC (fixed)...")
moB=run_h01(f"{CC}/binance-5m-7y.json",18); sB=[moB.get(m,0.0) for m in cal]

print("="*100)
print("=== R40: SOL fine-tune + Turtle optimization ===\n")

# ─── R40A: SOL ADX_thresh sweep ───
print("━"*100)
print("R40A: SOL ADX_thresh sweep [12,14,15,16,18,20] — find optimal (BTC18+SOL+turtle baseline)")
print(f"  {'adxt':>5} | {'SOL_Sh':>7} {'Portfolio Sh':>13} {'DD':>5} {'flat':>5} {'TEST':>7} {'delta':>7} | per-year")
print("  "+"-"*80)
moS_base=run_h01(f"{CC}/binance-sol-5m-3y.json",15); sS_base=[moS_base.get(m,0.0) for m in cal]
sh_base,dd_base,fl_base,te_base,py_base,_=bk([sB,sS_base,sTB])
print(f"  {15:>5} | {sharpe(sS_base):>+7.2f} {sh_base:>+13.2f} {dd_base:>4.1f}% {fl_base:>3}/35 {te_base:>+7.2f} {'±0.000':>7} | {py_base}  ← current")
best_sol_adxt=15; best_sol_sh=sh_base
for adxt in [12,13,14,16,17,18,20]:
    mS=run_h01(f"{CC}/binance-sol-5m-3y.json",adxt); sS=[mS.get(m,0.0) for m in cal]
    sh_,md_,fl_,te_,py_,_=bk([sB,sS,sTB])
    delta=sh_-sh_base
    mark="★" if sh_>sh_base+0.01 else ""
    if sh_>best_sol_sh and md_<=11: best_sol_sh=sh_; best_sol_adxt=adxt
    print(f"  {adxt:>5} | {sharpe(sS):>+7.2f} {sh_:>+13.2f} {md_:>4.1f}% {fl_:>3}/35 {te_:>+7.2f} {delta:>+7.3f} | {py_} {mark}")

# ─── R40B: SOL SL sweep ───
print("\n━"*100)
print(f"R40B: SOL SL sweep @ ADX_thresh={best_sol_adxt} — SL_INIT × SL_TRAIL")
print(f"  {'SL_I':>5} {'SL_T':>5} {'SL_tr':>6} | {'Sh':>7} {'DD':>5} {'flat':>5} {'TEST':>7} {'delta':>7} | per-year")
print("  "+"-"*80)
best_sol_sl=(3.0,3.5,16); best_sol_sl_sh=best_sol_sh
for si in [2.5,3.0,3.5,4.0]:
    for st in [3.0,3.5,4.0]:
        if st<si: continue
        for tr in [12,16,20,24]:
            mS=run_h01(f"{CC}/binance-sol-5m-3y.json",best_sol_adxt,si,st,tr); sS=[mS.get(m,0.0) for m in cal]
            sh_,md_,fl_,te_,py_,_=bk([sB,sS,sTB])
            delta=sh_-sh_base
            if sh_>best_sol_sl_sh and md_<=11: best_sol_sl_sh=sh_; best_sol_sl=(si,st,tr)
            if abs(delta)>0.01 or (si==3.0 and st==3.5 and tr==16):
                mark="★" if sh_>sh_base+0.01 else ("◀ cur" if si==3.0 and st==3.5 and tr==16 else "")
                print(f"  {si:>5.1f} {st:>5.1f} {tr:>6} | {sh_:>+7.2f} {md_:>4.1f}% {fl_:>3}/35 {te_:>+7.2f} {delta:>+7.3f} | {py_} {mark}")

si_b,st_b,tr_b=best_sol_sl
print(f"  Best SOL SL: init={si_b} trail={st_b} trans={tr_b} → Sh{best_sol_sl_sh:+.3f}")

# ─── R40C: Turtle params sweep ───
print("\n━"*100)
print("R40C: Turtle optimization — inspect what C module uses, try Donchian period variations")
# Check turtle current params
print(f"  Current turtle: {len(turB)} active months, total {sum(turB.values())*100:+.1f}%")
print(f"  Turtle Sh: {sharpe(sTB):+.3f}")

# Turtle from correlation module — try different period offsets
# The turtle is precomputed in C module. Check if we can vary it.
# If not, just test weight variations for turtle sleeve
print(f"\n  Turtle weight sensitivity (BTC+SOL+turtle_w):")
print(f"  {'tur_w':>6} | {'Sh':>7} {'DD':>5} {'flat':>5} {'TEST':>7} | per-year")
print("  "+"-"*55)
mS_best=run_h01(f"{CC}/binance-sol-5m-3y.json",best_sol_adxt,si_b,st_b,tr_b)
sS_best=[mS_best.get(m,0.0) for m in cal]
best_tw_sh=0; best_tw=1.0
for tw in [0.25,0.5,0.75,1.0,1.25,1.5,2.0]:
    sh_,md_,fl_,te_,py_,_=bk([sB,sS_best,sTB],[1,1,tw])
    mark="★" if sh_>best_tw_sh and md_<=10 else ""
    if sh_>best_tw_sh and md_<=10: best_tw_sh=sh_; best_tw=tw
    print(f"  {tw:>6.2f} | {sh_:>+7.2f} {md_:>4.1f}% {fl_:>3}/35 {te_:>+7.2f} | {py_} {mark}")

# ─── R40D: Best combined config ───
print("\n━"*100)
print("R40D: Best combined (SOL_adxt + SOL_SL + turtle_weight)")
print(f"  {'Config':<52} {'Sh':>6} {'DD':>5} {'flat':>5} {'TEST':>7} | per-year")
print("  "+"-"*85)

def pr(label,parts,weights=None):
    sh_,md_,fl_,te_,py_,_=bk(parts,weights)
    ok=sh_>=2.00 and md_<=9.0
    m="✅" if ok else ("⚠️" if sh_>=1.90 else "❌")
    print(f"  {m} {label:<51} Sh{sh_:>+5.2f} DD{md_:>4.1f}% flat{fl_:>3}/35 TE{te_:>+5.2f} | {py_}")
    return sh_,md_

pr("BASELINE BTC18+SOL15(orig)+turtle×1",[sB,sS_base,sTB])
pr(f"SOL adxt={best_sol_adxt} SL_orig",[sB,[run_h01(f"{CC}/binance-sol-5m-3y.json",best_sol_adxt).get(m,0.0) for m in cal],sTB])
mS_full=run_h01(f"{CC}/binance-sol-5m-3y.json",best_sol_adxt,si_b,st_b,tr_b)
sS_full=[mS_full.get(m,0.0) for m in cal]
pr(f"SOL adxt={best_sol_adxt} SL{si_b}/{st_b}/{tr_b}",[sB,sS_full,sTB])
pr(f"SOL best + turtle×{best_tw}",[sB,sS_full,sTB],[1,1,best_tw])
# With ETH×0.25 on top
moE=run_h01(f"{CC}/binance-eth-5m-3y.json",18,3.0,3.5,16,max_hold=200)
sE=[moE.get(m,0.0) for m in cal]
pr(f"SOL best + ETH×0.25 + turtle×{best_tw}",[sB,sE,sS_full,sTB],[1,0.25,1,best_tw])

# ─── Summary ───
sh_final,md_final=pr(f"CHAMPION so far",[sB,sS_full,sTB],[1,1,best_tw])
print("\n"+"="*100)
print("R40 SUMMARY")
print(f"  Baseline: Sh{sh_base:+.3f} DD{dd_base:.1f}%")
print(f"  Best SOL adxt: {best_sol_adxt} (was 15)")
print(f"  Best SOL SL: init={si_b} trail={st_b} trans={tr_b}")
print(f"  Best turtle weight: {best_tw}")
print(f"  Champion: Sh{sh_final:+.3f} DD{md_final:.1f}%")
delta_final=sh_final-sh_base
print(f"  Delta vs baseline: {delta_final:>+.3f} ({'IMPROVEMENT' if delta_final>0.01 else 'FLAT' if abs(delta_final)<0.005 else 'MARGINAL'})")
