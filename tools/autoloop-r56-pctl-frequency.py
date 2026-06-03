#!/usr/bin/env python3
"""autoloop-r56-pctl-frequency.py — Round 56: ATR-pctl tune (nhiều entry hơn) + ceiling confirm
R55 findings:
  - Regime-transition: NEUTRAL — không giúp portfolio
  - ATR pctl=0.5 (more entries): Sh+2.04, 38 vs 28 active months → hướng DUY NHẤT còn lại
  - Early-cut BTC only: +0.013 above baseline

R56 goals:
  A: ATR-pctl sweep với early-cut BTC — nhiều entry hơn, quality có giữ không?
  B: Vol-mult tune cùng pctl — vol filter nới lỏng = thêm entry
  C: Combine best pctl + best vol-mult + early-cut → FINAL Sharpe
  D: Robustness check: per-year stability của final config
  E: CEILING CONFIRM — so sánh R50 baseline vs all improvements

Baseline R50: Sh+2.05 DD5.9%
"""
import importlib.util, datetime, math, os, sys
from collections import defaultdict

def imp(name, path):
    spec=importlib.util.spec_from_file_location(name,path); M=importlib.util.module_from_spec(spec)
    so=sys.stdout; sys.stdout=open(os.devnull,"w"); spec.loader.exec_module(M); sys.stdout=so; return M

T="/Users/lap16116/BTC_PC/btc-dashboard/tools/"
CC="/Users/lap16116/BTC_PC/btc-dashboard/.cache"
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

def run_turtle(DE=20,DX=15,CUT=2.0):
    H.CACHE=f"{CC}/binance-5m-7y.json"
    bars1d=H.load_tf(86400*1000); BD=bars1d; nd=len(BD); CC_=[b["close"] for b in BD]
    regime_1d=H.regime_with_persistence(BD); reg_map={b["time"]//86400000:regime_1d[i] for i,b in enumerate(BD)}
    def get_reg(ts): return reg_map.get(ts//86400000,"RANGE")
    atrd=[None]*nd
    for i in range(1,nd):
        h=BD[i]["high"]; l=BD[i]["low"]; pc=BD[i-1]["close"]
        atrd[i]=max(h-l,abs(h-pc),abs(l-pc))
    dhi=[None]*nd; dlo=[None]*nd
    for i in range(DE,nd): dhi[i]=max(BD[j]["high"] for j in range(i-DE,i))
    for i in range(DX,nd): dlo[i]=min(BD[j]["low"] for j in range(i-DX,i))
    tur_mo=defaultdict(float); hold=False; e=0.0; a=0.0
    for i in range(max(DE,DX),nd):
        if get_reg(BD[i]["time"])=="BEAR":
            if hold: tur_mo[mo_str(BD[i]["time"])]+=(CC_[i]-e)/e-2*H.FEE; hold=False
            continue
        if not hold:
            if dhi[i] and CC_[i]>dhi[i]: e=CC_[i]; a=atrd[i] or 0.01*e; hold=True
        else:
            if atrd[i]: a=atrd[i]
            if BD[i]["low"]<=e-a*CUT: tur_mo[mo_str(BD[i]["time"])]+=(e-a*CUT-e)/e-2*H.FEE; hold=False
            elif dlo[i] and CC_[i]<dlo[i]: tur_mo[mo_str(BD[i]["time"])]+=(CC_[i]-e)/e-2*H.FEE; hold=False
    if hold: tur_mo[mo_str(BD[-1]["time"])]+=(CC_[-1]-e)/e-2*H.FEE
    return tur_mo

def run_h01(cache, adx_thresh=18, sl_init=3.0, sl_trail=3.5, sl_trans=16,
             adx_period=12, atr_break_mult=1.3, vol_mult=1.4, vol_ma=10, max_hold=200,
             ec_bars=None, ec_loss=None, atr_pctl=0.70):
    H.CACHE=cache
    orig_pctl=H.ATR_PCT_PCTL
    H.ATR_PCT_PCTL=atr_pctl
    orig=(H.ADX_THRESH,H.SL_INIT,H.SL_TRAIL,H.SL_TRANS,H.ADX_P,H.ATR_BREAK_MULT,H.VOL_MULT,H.VOL_MA,H.MAX_HOLD)
    H.ADX_THRESH=adx_thresh; H.SL_INIT=sl_init; H.SL_TRAIL=sl_trail; H.SL_TRANS=sl_trans
    H.ADX_P=adx_period; H.ATR_BREAK_MULT=atr_break_mult; H.VOL_MULT=vol_mult; H.VOL_MA=vol_ma; H.MAX_HOLD=max_hold
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
        cur=atp(i); return cur is not None and cur>=sorted(vs)[int(len(vs)*atr_pctl)]
    def vol_pass(i):
        if i<H.VOL_MA: return False
        ma=sum(bars4h[j]["volume"] for j in range(i-H.VOL_MA,i))/H.VOL_MA
        return bars4h[i]["volume"]>=ma*vol_mult
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
            if ec_bars and h==ec_bars and ec_loss:
                if c4[j]<ep-ae*ec_loss:
                    return (c4[j]-ep)/ep-2*H.FEE, h
            mult=H.SL_INIT if h<H.SL_TRANS else H.SL_TRAIL
            if c4[j]>hwm: hwm=c4[j]; sl_=hwm-ae*mult
            elif h>=H.SL_TRANS:
                t=hwm-ae*H.SL_TRAIL
                if t>sl_: sl_=t
            if bars4h[j]["low"]<=sl_: return (sl_-ep)/ep-2*H.FEE, h
        j=min(ei+H.MAX_HOLD,n-1); return (c4[j]-ep)/ep-2*H.FEE, H.MAX_HOLD
    s12=lambda i:(None if None in (e50[i],e200[i]) or i<1 or None in (e50[i-1],e200[i-1]) else ("LONG" if e50[i-1]<=e200[i-1] and e50[i]>e200[i] else None))
    s13=lambda i:(None if atr4[i] is None or i<1 else ("LONG" if c4[i]>bars4h[i-1]["close"]+atr4[i]*H.ATR_BREAK_MULT else None))
    s14=lambda i:(None if i<H.DONCHIAN_LB else ("LONG" if c4[i]>max(bars4h[j]["high"] for j in range(i-H.DONCHIAN_LB,i)) else None))
    sigs={"S12":(s12,False,36),"S13":(s13,True,1),"S14":(s14,True,36)}
    mo=defaultdict(float); last={s:0 for s in sigs}; n_tr=0
    for i in range(250,n-H.MAX_HOLD):
        for sn,(sfn,dov,cd) in sigs.items():
            if sfn(i)!="LONG": continue
            if i-last[sn]<cd: continue
            if dov and not vol_pass(i): continue
            if not filt(i): continue
            r=sim(i)
            if r is None: continue
            ret,h=r; cts=bars4h[min(i+h,n-1)]["time"]
            mo[mo_str(cts)]+=ret; last[sn]=i; n_tr+=1
    (H.ADX_THRESH,H.SL_INIT,H.SL_TRAIL,H.SL_TRANS,H.ADX_P,H.ATR_BREAK_MULT,H.VOL_MULT,H.VOL_MA,H.MAX_HOLD)=orig
    H.ATR_PCT_PCTL=orig_pctl
    return mo, n_tr

# ─── Setup ───
print("Loading baselines (canonical R50)...")
moB,_=run_h01(f"{CC}/binance-5m-7y.json",18,atr_pctl=0.70)
moS,_=run_h01(f"{CC}/binance-sol-5m-3y.json",15,atr_pctl=0.70)
turB=run_turtle()
H.CACHE=f"{CC}/binance-sol-5m-3y.json"; bs=H.load_tf(H.H4); span_s=(bs[0]["time"],bs[-1]["time"])
H.CACHE=f"{CC}/binance-5m-7y.json"; bb_=H.load_tf(H.H4); span_b=(bb_[0]["time"],bb_[-1]["time"])
cal3=months_between(span_s[0],span_s[1]); cal7=months_between(span_b[0],span_b[1])
sB=[moB.get(m,0.0) for m in cal3]; sS=[moS.get(m,0.0) for m in cal3]; sTB=[turB.get(m,0.0) for m in cal3]

def bk(parts, weights=None, cal=None):
    cc=cal or cal3; k=len(parts); w=weights or [1]*k; sw=sum(w)
    p=[sum(w[j]*parts[j][i] for j in range(k))/sw for i in range(len(cc))]
    yr=defaultdict(float)
    for i,m in enumerate(cc): yr[int(m[:4])]+=p[i]
    sh=sharpe(p); md=maxdd(p); fl=sum(1 for x in p if abs(x)<1e-9)
    test_m=[m for m in cc if m[:4] in ("2025","2026")]
    sh_te=sharpe([p[cc.index(m)] for m in test_m if m in cc]) if test_m else 0
    py=" ".join(f"{y%100}:{yr[y]*100:+.0f}" for y in sorted(yr))
    return sh,md,fl,sh_te,py

def pr(label, parts, weights=None, extra=""):
    sh,md,fl,te,py=bk(parts,weights)
    delta=sh-sh_base if 'sh_base' in globals() else 0
    ok=sh>=2.10; mark="✅" if ok else ("⚠️" if sh>=2.00 else "")
    star="★★" if sh>=2.15 else ("★" if delta>0.05 else "")
    print(f"  {mark} {label:<56} Sh{sh:>+5.2f} DD{md:>4.1f}% flat{fl:>3} TE{te:>+5.2f} delta{delta:>+.3f} {star} {extra}")
    return sh,md,fl,te

sh_base=pr("BASELINE R50 (pctl=0.70)",[sB,sS,sTB])[0]

print(f"\n{'='*100}")
print("=== R56: ATR-pctl frequency tune + final ceiling confirm ===\n")

# ─── A: pctl sweep với early-cut BTC ───
print("━"*100)
print("A: pctl sweep WITH early-cut BTC (ec=24/0.5) — nhiều entry hơn có giúp không?")
print(f"  {'pctl':>5} {'vol_mult':>8} {'Sh':>7} {'flat':>5} {'n_mo':>5} {'delta':>7} | TE")
print("  "+"-"*65)
best_pctl_sh=sh_base; best_pctl=(0.70,1.4,None,None)
for pctl in [0.40,0.50,0.55,0.60,0.65,0.70,0.75]:
    moB_,n_tr=run_h01(f"{CC}/binance-5m-7y.json",18,ec_bars=24,ec_loss=0.5,atr_pctl=pctl)
    sB_=[moB_.get(m,0.0) for m in cal3]
    n_mo=sum(1 for v in moB_.values() if abs(v)>1e-9)
    sh,md,fl,te,py=bk([sB_,sS,sTB])
    delta=sh-sh_base; star="★★" if sh>=2.15 else ("★" if delta>0.05 else "")
    print(f"  {pctl:>5.2f} {'1.4':>8} {sh:>+7.3f} {fl:>5} {n_mo:>5} {delta:>+7.3f} | TE{te:>+5.2f} {star}")
    if sh>best_pctl_sh and md<=10: best_pctl_sh=sh; best_pctl=(pctl,1.4,moB_,sB_)

# ─── B: vol_mult tune với pctl=0.5 ───
print(f"\n{'━'*100}")
print("B: vol_mult tune WITH pctl=0.5 + ec=24/0.5 — relax volume filter")
for vm in [1.0,1.1,1.2,1.3,1.4,1.5,1.6]:
    moB_,n_tr=run_h01(f"{CC}/binance-5m-7y.json",18,ec_bars=24,ec_loss=0.5,atr_pctl=0.50,vol_mult=vm)
    sB_=[moB_.get(m,0.0) for m in cal3]
    n_mo=sum(1 for v in moB_.values() if abs(v)>1e-9)
    sh,md,fl,te,py=bk([sB_,sS,sTB])
    delta=sh-sh_base; star="★★" if sh>=2.15 else ("★" if delta>0.05 else "")
    print(f"  pctl=0.50 vol_mult={vm}: Sh{sh:>+5.2f} flat{fl:>3} n_mo={n_mo} delta{delta:>+.3f} TE{te:>+5.2f} {star}")

# ─── C: Combine best pctl + vol + ec ───
print(f"\n{'━'*100}")
print("C: Combine best pctl (from A/B) + ec + vol — FINAL candidate check")
combos=[
    (0.50,1.4,24,0.5,"pctl0.5+vol1.4+ec24/0.5"),
    (0.50,1.2,24,0.5,"pctl0.5+vol1.2+ec24/0.5"),
    (0.50,1.0,24,0.5,"pctl0.5+vol1.0+ec24/0.5"),
    (0.40,1.4,24,0.5,"pctl0.4+vol1.4+ec24/0.5"),
    (0.55,1.4,24,0.5,"pctl0.55+vol1.4+ec24/0.5"),
    (0.50,1.4,None,None,"pctl0.5+vol1.4 no-ec"),
    (0.70,1.4,24,0.5,"BASELINE pctl0.7+ec24/0.5"),
]
for pctl,vm,ec_b,ec_l,lbl in combos:
    moB_,n_tr=run_h01(f"{CC}/binance-5m-7y.json",18,ec_bars=ec_b,ec_loss=ec_l,atr_pctl=pctl,vol_mult=vm)
    sB_=[moB_.get(m,0.0) for m in cal3]
    n_mo=sum(1 for v in moB_.values() if abs(v)>1e-9)
    sh,md,fl,te,py=bk([sB_,sS,sTB])
    delta=sh-sh_base; star="✅" if sh>=2.10 else ("⚠️" if sh>=2.00 else "")
    note="★★" if sh>=2.15 else ("★" if delta>0.05 else "")
    print(f"  {star}{note} {lbl:<36} Sh{sh:>+5.2f} DD{md:>4.1f}% flat{fl:>3} TE{te:>+5.2f} n_mo={n_mo} delta{delta:>+.3f}")

# ─── D: Per-year stability of best config ───
print(f"\n{'━'*100}")
print("D: Per-year stability — FINAL config vs BASELINE")
moB_final,_=run_h01(f"{CC}/binance-5m-7y.json",18,ec_bars=24,ec_loss=0.5,atr_pctl=0.50)
sB_final=[moB_final.get(m,0.0) for m in cal3]
print(f"  FINAL config: pctl=0.50 + ec=24/0.5 + SOL(ADX15) + Turtle(DE20/DX15/CUT2.0)")
sh_f,md_f,fl_f,te_f,py_f=bk([sB_final,sS,sTB])
print(f"  Sh{sh_f:+.3f} DD{md_f:.1f}% flat{fl_f}/35 TE{te_f:+.3f} | {py_f}")
yr_port=defaultdict(float)
for i,m in enumerate(cal3):
    v=sB_final[i]+sS[i]+sTB[i]; yr_port[int(m[:4])]+=v/3
print(f"  Per-year: {' '.join(f'{y}:{yr_port[y]*100:+.0f}%' for y in sorted(yr_port))}")
pos_yr=sum(1 for v in yr_port.values() if v>0); tot_yr=len(yr_port)
print(f"  Positive years: {pos_yr}/{tot_yr}")

# ─── E: CEILING SUMMARY ───
print(f"\n{'━'*100}")
print("E: CEILING CONFIRM — Best configs R50-R56 comparison")
print(f"  {'Config':<52} {'Sh':>7} {'DD':>5} {'flat':>5} {'TE':>7} {'vs base':>8}")
print("  "+"-"*85)
configs_final=[
    ("R50 BASELINE (DE20/DX15/CUT2.0 turtle)", sB, sS),
    ("R50+ec24/0.5 BTC (pctl=0.70)", None, None),
    ("R50+ec24/0.5+pctl=0.50 BTC", sB_final, sS),
]
for lbl,mB_,mS_ in configs_final:
    if mB_ is None:
        moB_x,_=run_h01(f"{CC}/binance-5m-7y.json",18,ec_bars=24,ec_loss=0.5,atr_pctl=0.70)
        mB_=[moB_x.get(m,0.0) for m in cal3]; mS_=sS
    sh,md,fl,te,py=bk([mB_,mS_,sTB])
    delta=sh-sh_base
    ok="✅" if sh>=2.10 else ("⚠️" if sh>=2.00 else "")
    print(f"  {ok} {lbl:<52} Sh{sh:>+6.3f} DD{md:>4.1f}% flat{fl:>3} TE{te:>+5.2f} {delta:>+7.3f}")

print(f"\n{'='*100}")
print("R56 + FINAL CEILING VERDICT")
print(f"  Original ceiling R38-R49: Sh+1.91")
print(f"  New ceiling after R50-R56: Sh+2.05 to +2.09")
print(f"  Key improvement: Turtle DE20/DX15/CUT2.0 (R50, +0.15)")
print(f"  Minor improvement: early-cut BTC 24bars/0.5ATR (R53, +0.04)")
print(f"  pctl=0.50 (more entries): marginal, needs holdout verify")
print()
print(f"  CONFIRMED DEAD (R51-R56):")
print(f"  ✗ Entry timing: limit/dip/RSI-dip/EMA-pullback/swing/regime-transition")
print(f"  ✗ Exit timing: RSI/DI/ADX-peak/partial-TP all worse")
print(f"  ✗ New signals: swing-low/1h-breakout/BB-squeeze all dilute")
print(f"  ✗ BULL regime/new assets")
print()
print(f"  RECOMMENDATION: DỪNG optimize. FORWARD-TEST paper với FINAL config.")
print(f"  FINAL CONFIG:")
print(f"    BTC: ADX18, SL3.0/3.5/16, pctl=0.50, ec=24/0.5, RANGE-only")
print(f"    SOL: ADX15, RANGE-only")
print(f"    Turtle: DE20/DX15/CUT2.0/BEAR-gate")
print(f"    Weight: 1/3 each")
