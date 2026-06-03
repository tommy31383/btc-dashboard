#!/usr/bin/env python3
"""autoloop-r39-alt-sweep.py — Round 39: All alt-assets as 3rd slot
R39A: Each alt as 3rd asset (BTC+ALT+SOL+turtle) — find best Sharpe lift
R39B: Best alt replace SOL (BTC+ALT+turtle) — is SOL the best partner?
R39C: Best 2-alt combo (BTC+ALT1+ALT2+turtle, drop SOL)
R39D: Weight sweep for best combo
Context: ceiling Sh+1.96~1.97 for 3-asset. Try fresh assets to break ceiling.
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
def sd(v):
    me=sum(v)/len(v); return (sum((x-me)**2 for x in v)/len(v))**.5 or 1e-9

_,_,_,spanB=Hh.run_hedge01(f"{CC}/binance-5m-7y.json",skip_cal=False)
_,_,_,spanS=Hh.run_hedge01(f"{CC}/binance-sol-5m-3y.json",skip_cal=False)
turB=dict(C.tur_mo); cal=months_between(spanS[0],spanS[1])
sTB=[turB.get(m,0.0) for m in cal]

def run_h01(cache, adx_thresh=18, sl_init=3.0, sl_trail=3.5, sl_trans=16,
            adx_period=12, max_hold=200):
    H.CACHE=cache
    orig=H.ADX_THRESH,H.SL_INIT,H.SL_TRAIL,H.SL_TRANS,H.ADX_P,H.ATR_BREAK_MULT,H.VOL_MULT,H.VOL_MA,H.MAX_HOLD
    H.ADX_THRESH=adx_thresh; H.SL_INIT=sl_init; H.SL_TRAIL=sl_trail; H.SL_TRANS=sl_trans
    H.ADX_P=adx_period; H.MAX_HOLD=max_hold
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
    H.ADX_THRESH,H.SL_INIT,H.SL_TRAIL,H.SL_TRANS,H.ADX_P,H.ATR_BREAK_MULT,H.VOL_MULT,H.VOL_MA,H.MAX_HOLD=orig
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

# ─── Precompute fixed assets ───
print("Loading fixed assets (BTC+SOL+turtle)...")
moB=run_h01(f"{CC}/binance-5m-7y.json",18); sB=[moB.get(m,0.0) for m in cal]
moS=run_h01(f"{CC}/binance-sol-5m-3y.json",15); sS=[moS.get(m,0.0) for m in cal]
sh_base,dd_base,fl_base,te_base,py_base,p_base=bk([sB,sS,sTB])

ALTS=[("ETH",18),("BNB",18),("AVAX",18),("ADA",18),("XRP",18),
      ("DOGE",18),("DOT",18),("LINK",18),("LTC",18)]

print("Loading all alt-assets...")
moA={}
for nm,adxt in ALTS:
    path=f"{CC}/binance-{nm.lower()}-5m-3y.json"
    if os.path.exists(path):
        try: moA[nm]=run_h01(path,adxt); print(f"  {nm} loaded")
        except Exception as e: print(f"  {nm} FAIL: {e}")

print("="*100)
print("=== R39: Alt-asset sweep — find best 3rd asset ===\n")

# ─── R39A: Each alt as 3rd asset (BTC+ALT+SOL+turtle) ───
print("━"*100)
print("R39A: BTC18+ALT+SOL15+turtle — alt weight=0.5 (equal), MH200")
print(f"  {'Asset':<7} {'IndivSh':>8} {'3-asset Sh':>11} {'DD':>5} {'flat':>5} {'TEST':>7} {'vs_base':>8} | per-year")
print("  "+"-"*85)
print(f"  {'BASELINE':<7} {'':>8} {sh_base:>+11.2f} {dd_base:>4.1f}% {fl_base:>3}/35 {te_base:>+7.2f} {'':>8} | {py_base}")
print("  "+"-"*85)
best39a_sh=sh_base; best39a_nm=None
for nm,(adxt) in [(n,a) for n,a in ALTS if n in moA]:
    sA=[moA[nm].get(m,0.0) for m in cal]
    sh_a=sharpe(sA)
    sh_,md_,fl_,te_,py_,_=bk([sB,sA,sS,sTB])
    delta=sh_-sh_base
    mark="★★" if sh_>2.00 and md_<=9 else ("★" if sh_>sh_base+0.02 else ("✅" if sh_>sh_base else ""))
    if sh_>best39a_sh and md_<=10: best39a_sh=sh_; best39a_nm=nm
    print(f"  {nm:<7} {sh_a:>+8.2f} {sh_:>+11.2f} {md_:>4.1f}% {fl_:>3}/35 {te_:>+7.2f} {delta:>+7.3f}  | {py_} {mark}")

# ─── R39B: Alt REPLACES SOL (BTC+ALT+turtle) ───
print("\n━"*100)
print("R39B: BTC18+ALT+turtle — alt replaces SOL (2-asset alt book)")
print(f"  {'Asset':<7} {'Sh':>7} {'DD':>5} {'flat':>5} {'TEST':>7} | per-year")
print("  "+"-"*70)
print(f"  {'SOL(ref)':<7} {sh_base:>+7.2f} {dd_base:>4.1f}% {fl_base:>3}/35 {te_base:>+7.2f} | {py_base}")
best39b_sh=0; best39b_nm=None
for nm,(adxt) in [(n,a) for n,a in ALTS if n in moA and n!="ETH"]:
    sA=[moA[nm].get(m,0.0) for m in cal]
    sh_,md_,fl_,te_,py_,_=bk([sB,sA,sTB])
    mark="★" if sh_>sh_base and md_<=9 else ""
    if sh_>best39b_sh: best39b_sh=sh_; best39b_nm=nm
    print(f"  {nm:<7} {sh_:>+7.2f} {md_:>4.1f}% {fl_:>3}/35 {te_:>+7.2f} | {py_} {mark}")

# ─── R39C: Best 2-alt combo (drop SOL, replace with 2 alts) ───
print("\n━"*100)
print("R39C: BTC18+ALT1+ALT2+turtle — best 2-alt combos (top candidates from R39A/B)")
top_candidates=[nm for nm in moA if nm!="ETH"][:6]
# Also include ETH
all_candidates=["ETH"]+top_candidates
print(f"  Candidates: {all_candidates}")
print(f"  {'Combo':<18} {'Sh':>7} {'DD':>5} {'flat':>5} {'TEST':>7} | per-year")
print("  "+"-"*70)
best39c_sh=sh_base; best39c_combo=None
results_c=[]
for i,nm1 in enumerate(all_candidates):
    if nm1 not in moA: continue
    sA1=[moA[nm1].get(m,0.0) for m in cal]
    for nm2 in all_candidates[i+1:]:
        if nm2 not in moA: continue
        sA2=[moA[nm2].get(m,0.0) for m in cal]
        sh_,md_,fl_,te_,py_,_=bk([sB,sA1,sA2,sTB])
        results_c.append((sh_,md_,fl_,te_,py_,nm1,nm2))

results_c.sort(reverse=True)
for sh_,md_,fl_,te_,py_,nm1,nm2 in results_c[:10]:
    delta=sh_-sh_base
    mark="★★" if sh_>2.00 and md_<=9 else ("★" if delta>0.03 else "")
    if sh_>best39c_sh and md_<=10: best39c_sh=sh_; best39c_combo=(nm1,nm2)
    print(f"  {nm1+'+'+nm2:<18} {sh_:>+7.2f} {md_:>4.1f}% {fl_:>3}/35 {te_:>+7.2f} {delta:>+7.3f} | {py_} {mark}")

# ─── R39D: Weight sweep for best combo ───
if best39c_combo:
    nm1,nm2=best39c_combo
    sA1=[moA[nm1].get(m,0.0) for m in cal]
    sA2=[moA[nm2].get(m,0.0) for m in cal]
    print(f"\n━"*100)
    print(f"R39D: Weight sweep — best combo {nm1}+{nm2} (drop SOL)")
    print(f"  {'w1':>5} {'w2':>5} | {'Sh':>7} {'DD':>5} {'flat':>5} {'TEST':>7} | per-year")
    print("  "+"-"*65)
    best39d_sh=0; best39d_w=None
    for w1 in [0.5,0.75,1.0,1.25,1.5]:
        for w2 in [0.5,0.75,1.0,1.25,1.5]:
            sh_,md_,fl_,te_,py_,_=bk([sB,sA1,sA2,sTB],[1,w1,w2,1])
            if sh_>best39d_sh and md_<=10: best39d_sh=sh_; best39d_w=(w1,w2)
            mark="★" if sh_>best39c_sh+0.02 else ""
            if w1 in [0.5,1.0] and w2 in [0.5,1.0]:
                print(f"  {w1:>5.2f} {w2:>5.2f} | {sh_:>+7.2f} {md_:>4.1f}% {fl_:>3}/35 {te_:>+7.2f} | {py_} {mark}")
    if best39d_w:
        w1,w2=best39d_w
        sh_,md_,fl_,te_,py_,_=bk([sB,sA1,sA2,sTB],[1,w1,w2,1])
        print(f"  BEST: w({nm1})={w1} w({nm2})={w2} → Sh{sh_:+.2f} DD{md_:.1f}% TEST{te_:+.2f}")

# ─── Summary ───
print("\n"+"="*100)
print("R39 SUMMARY")
print(f"  Baseline 2-asset (BTC+SOL+turtle): Sh{sh_base:>+5.2f} DD{dd_base:.1f}% flat{fl_base}/35 TEST{te_base:>+5.2f}")
if best39a_nm:
    sA=[moA[best39a_nm].get(m,0.0) for m in cal]
    sh_,md_,fl_,te_,py_,_=bk([sB,sA,sS,sTB])
    print(f"  Best 3rd asset added: {best39a_nm} → Sh{sh_:>+5.2f} DD{md_:.1f}% TEST{te_:>+5.2f} (delta{sh_-sh_base:>+.3f})")
if best39c_combo:
    nm1,nm2=best39c_combo
    sA1=[moA[nm1].get(m,0.0) for m in cal]; sA2=[moA[nm2].get(m,0.0) for m in cal]
    sh_,md_,fl_,te_,py_,_=bk([sB,sA1,sA2,sTB])
    print(f"  Best 2-alt combo (no SOL): {nm1}+{nm2} → Sh{sh_:>+5.2f} DD{md_:.1f}% TEST{te_:>+5.2f} (delta{sh_-sh_base:>+.3f})")
print(f"  Ceiling Sh+1.96 broken? → see ★★ above")
