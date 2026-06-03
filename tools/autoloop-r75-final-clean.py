#!/usr/bin/env python3
"""autoloop-r75-final-clean.py — Round 75: Clean final verify + new directions
R74 VERDICT: Aug skip marginal but 7y-confirmed (+0.055 both configs, n=3 real trades)
CURRENT BEST: BTC78+SOL29+DX14+T1.2+Aug-skip → Sh+2.26 DD5.3%

R75:
  A: Full 3-holdout verify of FINAL config (BTC78+SOL29+DX14+T1.2+Aug-skip)
  B: Sep skip (month 9 also bad per 7y analysis) — add to Aug?
  C: NEW DIRECTION — ADX threshold tune with Aug-skip background
  D: NEW DIRECTION — EMA1h filter tune with Aug-skip (shorter EMA was marginal in R59)
  E: Comprehensive winner table R50-R75
  F: Forward-test checklist — what to monitor live
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

def run_turtle(DX=14):
    H.CACHE=f"{CC}/binance-5m-7y.json"
    bars1d=H.load_tf(86400*1000); BD=bars1d; nd=len(BD); CC_=[b["close"] for b in BD]
    regime_1d=H.regime_with_persistence(BD); reg_map={b["time"]//86400000:regime_1d[i] for i,b in enumerate(BD)}
    def get_reg(ts): return reg_map.get(ts//86400000,"RANGE")
    atrd=[None]*nd
    for i in range(1,nd):
        h=BD[i]["high"]; l=BD[i]["low"]; pc=BD[i-1]["close"]
        atrd[i]=max(h-l,abs(h-pc),abs(l-pc))
    dhi=[None]*nd; dlo=[None]*nd; DE=20
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
            if BD[i]["low"]<=e-a*2.0: tur_mo[mo_str(BD[i]["time"])]+=(e-a*2.0-e)/e-2*H.FEE; hold=False
            elif dlo[i] and CC_[i]<dlo[i]: tur_mo[mo_str(BD[i]["time"])]+=(CC_[i]-e)/e-2*H.FEE; hold=False
    if hold: tur_mo[mo_str(BD[-1]["time"])]+=(CC_[-1]-e)/e-2*H.FEE
    return tur_mo

def run_h01(cache, adx_thresh=18, sl_init=3.0, sl_trail=3.5, sl_trans=16,
             adx_period=12, atr_break_mult=1.3, vol_mult=1.4, vol_ma=10, max_hold=200,
             skip_months=None, ema_1h=200):
    H.CACHE=cache
    orig=(H.ADX_THRESH,H.SL_INIT,H.SL_TRAIL,H.SL_TRANS,H.ADX_P,H.ATR_BREAK_MULT,H.VOL_MULT,H.VOL_MA,H.MAX_HOLD)
    H.ADX_THRESH=adx_thresh; H.SL_INIT=sl_init; H.SL_TRAIL=sl_trail; H.SL_TRANS=sl_trans
    H.ADX_P=adx_period; H.ATR_BREAK_MULT=atr_break_mult; H.VOL_MULT=vol_mult; H.VOL_MA=vol_ma; H.MAX_HOLD=max_hold
    bars4h=H.load_tf(H.H4); bars1h=H.load_tf(3600*1000); bars1d=H.load_tf(86400*1000)
    n=len(bars4h); c4=[b["close"] for b in bars4h]
    e50=H.ema_s(c4,H.EMA_FAST); e200=H.ema_s(c4,H.EMA_SLOW)
    atr4=H.atr_series(bars4h); adx4=H.adx_wilder(bars4h,period=adx_period)
    e_1h=H.ema_s([b["close"] for b in bars1h],ema_1h); h1t=[b["time"] for b in bars1h]
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
    def e1h_at(ts):
        lo,hi,idx=0,len(h1t)-1,0
        while lo<=hi:
            m=(lo+hi)//2
            if h1t[m]<=ts: idx=m; lo=m+1
            else: hi=m-1
        return e_1h[idx]
    def filt(i):
        adv=adx4[i]
        if adv is None or adv<=H.ADX_THRESH: return False
        ap=adx4[i-1] if i>=1 else None
        if ap is None or ap<=H.ADX_THRESH: return False
        e1h=e1h_at(bars4h[i]["time"])
        if e1h is None or c4[i]<e1h: return False
        if not atp_pass(i): return False
        if get_reg(bars4h[i]["time"])!="RANGE": return False
        if skip_months:
            ts_dt=datetime.datetime.utcfromtimestamp(bars4h[i]["time"]/1000)
            if ts_dt.month in skip_months: return False
        return True
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
            if bars4h[j]["low"]<=sl_: return (sl_-ep)/ep-2*H.FEE, h
        j=min(ei+H.MAX_HOLD,n-1); return (c4[j]-ep)/ep-2*H.FEE, H.MAX_HOLD
    s12=lambda i:(None if None in (e50[i],e200[i]) or i<1 or None in (e50[i-1],e200[i-1]) else ("LONG" if e50[i-1]<=e200[i-1] and e50[i]>e200[i] else None))
    s13=lambda i:(None if atr4[i] is None or i<1 else ("LONG" if c4[i]>bars4h[i-1]["close"]+atr4[i]*atr_break_mult else None))
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
    return mo, n_tr

print("Loading R74 final config...")
moB_final,_=run_h01(f"{CC}/binance-5m-7y.json",18,sl_init=2.78,sl_trail=3.28,skip_months={8})
moB_base,_=run_h01(f"{CC}/binance-5m-7y.json",18,sl_init=2.78,sl_trail=3.28)
moS29,_=run_h01(f"{CC}/binance-sol-5m-3y.json",15,sl_init=2.9,sl_trail=3.4,sl_trans=24)
turB14=run_turtle(14)
H.CACHE=f"{CC}/binance-sol-5m-3y.json"; bs=H.load_tf(H.H4); span_s=(bs[0]["time"],bs[-1]["time"])
H.CACHE=f"{CC}/binance-5m-7y.json"; bb_=H.load_tf(H.H4); span_b=(bb_[0]["time"],bb_[-1]["time"])
cal3=months_between(span_s[0],span_s[1]); cal7=months_between(span_b[0],span_b[1])
sB_f=[moB_final.get(m,0.0) for m in cal3]; sB_b=[moB_base.get(m,0.0) for m in cal3]
sS29=[moS29.get(m,0.0) for m in cal3]; sTB14=[turB14.get(m,0.0) for m in cal3]
W=[1,1,1.2]

def bk(parts, weights=None, cal=None):
    cc=cal or cal3; k=len(parts); w=weights or W; sw=sum(w)
    p=[sum(w[j]*parts[j][i] for j in range(k))/sw for i in range(len(cc))]
    yr=defaultdict(float)
    for i,m in enumerate(cc): yr[int(m[:4])]+=p[i]
    sh=sharpe(p); md=maxdd(p); fl=sum(1 for x in p if abs(x)<1e-9)
    test_m=[m for m in cc if m[:4] in ("2025","2026")]
    sh_te=sharpe([p[cc.index(m)] for m in test_m]) if test_m else 0
    py=" ".join(f"{y%100}:{yr[y]*100:+.0f}" for y in sorted(yr))
    return sh,md,fl,sh_te,py

def pr(label, parts, weights=None, cal=None, extra=""):
    sh,md,fl,te,py=bk(parts,weights or W,cal)
    delta=sh-sh_base if 'sh_base' in globals() else 0
    ok=sh>=2.25; mark="✅✅✅" if ok else ("✅✅" if sh>=2.20 else ("✅" if sh>=2.10 else ("⚠️" if sh>=2.00 else "")))
    star="★★★" if sh>=2.30 else ("★★" if sh>=2.25 else ("★" if delta>0.05 else ""))
    print(f"  {mark} {label:<52} Sh{sh:>+5.2f} DD{md:>4.1f}% flat{fl:>3} TE{te:>+5.2f} d{delta:>+.3f} {star} {extra}")
    return sh,md

sh_base=pr("R74 FINAL: BTC78+SOL29+DX14+T1.2+Aug-skip",[sB_f,sS29,sTB14])[0]
print(); print("="*100); print("=== R75: Clean verify + new directions ===\n")

# A: Full holdout verify of FINAL config
print("━"*100); print("A: FINAL config full 3-holdout verify")
for yr_exc in [2023,2024,2025]:
    cal_ho=[m for m in cal3 if not m.startswith(str(yr_exc))]
    sBf_ho=[moB_final.get(m,0.0) for m in cal_ho]; sBb_ho=[moB_base.get(m,0.0) for m in cal_ho]
    sS_ho=[moS29.get(m,0.0) for m in cal_ho]; sTB_ho=[turB14.get(m,0.0) for m in cal_ho]
    sh_base_ho,_,_,_,_=bk([sBb_ho,sS_ho,sTB_ho],cal=cal_ho)
    sh_final_ho,md_ho,_,_,_=bk([sBf_ho,sS_ho,sTB_ho],cal=cal_ho)
    delta=sh_final_ho-sh_base_ho
    robust="✓ ROBUST" if delta>0 else "✗ FRAGILE"
    print(f"  Holdout {yr_exc}: base Sh{sh_base_ho:+.2f} → final Sh{sh_final_ho:+.2f} DD{md_ho:.1f}% delta{delta:>+.3f} {robust}")

# B: Sep skip test
print(f"\n{'━'*100}"); print("B: Sep skip (also bad in 7y analysis: WR=14% avg=-0.7%)")
moB_sep,_=run_h01(f"{CC}/binance-5m-7y.json",18,sl_init=2.78,sl_trail=3.28,skip_months={9})
moB_augsep,_=run_h01(f"{CC}/binance-5m-7y.json",18,sl_init=2.78,sl_trail=3.28,skip_months={8,9})
sB_sep=[moB_sep.get(m,0.0) for m in cal3]; sB_as=[moB_augsep.get(m,0.0) for m in cal3]
sh_s=sharpe([moB_sep.get(m,0.0) for m in cal7]); sh_as=sharpe([moB_augsep.get(m,0.0) for m in cal7])
pr(f"  Sep skip only",[sB_sep,sS29,sTB14],extra=f"7y={sh_s:+.3f}")
pr(f"  Aug+Sep skip",[sB_as,sS29,sTB14],extra=f"7y={sh_as:+.3f}")
# Holdout
for yr_exc in [2023,2024,2025]:
    cal_ho=[m for m in cal3 if not m.startswith(str(yr_exc))]
    sBf_ho=[moB_final.get(m,0.0) for m in cal_ho]; sBas_ho=[moB_augsep.get(m,0.0) for m in cal_ho]
    sS_ho=[moS29.get(m,0.0) for m in cal_ho]; sTB_ho=[turB14.get(m,0.0) for m in cal_ho]
    sh_f,_,_,_,_=bk([sBf_ho,sS_ho,sTB_ho],cal=cal_ho)
    sh_as_ho,_,_,_,_=bk([sBas_ho,sS_ho,sTB_ho],cal=cal_ho)
    robust="✓" if sh_as_ho>sh_f else "✗"
    print(f"  Holdout {yr_exc}: Aug-only Sh{sh_f:+.2f} → Aug+Sep Sh{sh_as_ho:+.2f} delta{sh_as_ho-sh_f:>+.3f} {robust}")

# C: ADX thresh with Aug-skip
print(f"\n{'━'*100}"); print("C: ADX threshold with Aug-skip background")
for adxt in [16,17,18,19,20]:
    moB_,nt=run_h01(f"{CC}/binance-5m-7y.json",adxt,sl_init=2.78,sl_trail=3.28,skip_months={8})
    sB_=[moB_.get(m,0.0) for m in cal3]
    pr(f"  ADX={adxt}",[sB_,sS29,sTB14],extra=f"n={nt}")

# D: EMA1h filter with Aug-skip
print(f"\n{'━'*100}"); print("D: EMA1h filter with Aug-skip (shorter EMA = more entries?)")
for ema_p in [100,150,200]:
    moB_,nt=run_h01(f"{CC}/binance-5m-7y.json",18,sl_init=2.78,sl_trail=3.28,skip_months={8},ema_1h=ema_p)
    sB_=[moB_.get(m,0.0) for m in cal3]
    pr(f"  EMA1h={ema_p}",[sB_,sS29,sTB14],extra=f"n={nt}")

# E: Comprehensive winner table
print(f"\n{'━'*100}"); print("E: COMPREHENSIVE WINNER TABLE R50-R75")
print(f"  {'Config':<55} {'Sh':>7} {'DD':>5} {'delta':>8}")
print("  "+"-"*78)
can_moB,_=run_h01(f"{CC}/binance-5m-7y.json",18)
can_moS,_=run_h01(f"{CC}/binance-sol-5m-3y.json",15)
turB15=run_turtle(15)
configs_final=[
    ("R50 CANONICAL (original baseline)", can_moB, can_moS, turB15, [1,1,1]),
    ("R70 BTC78+SOL29+DX14+T1.2", moB_base, moS29, turB14, W),
    ("R74 BTC78+SOL29+DX14+T1.2+Aug-skip [BEST]", moB_final, moS29, turB14, W),
]
for lbl,mB_,mS_,turB_,w in configs_final:
    sB_=[mB_.get(m,0.0) for m in cal3]; sS_=[mS_.get(m,0.0) for m in cal3]
    sTB_=[turB_.get(m,0.0) for m in cal3]
    sh,md,fl,te,py=bk([sB_,sS_,sTB_],weights=w)
    delta=sh-sh_base
    ok="✅✅" if sh>=2.25 else ("✅" if sh>=2.10 else "⚠️")
    print(f"  {ok} {lbl:<55} Sh{sh:>+6.3f} DD{md:>4.1f}% delta{delta:>+6.3f}")

print(f"\n{'='*100}")
print("R75 FINAL SUMMARY:")
print(f"  BEST CONFIG (R74): Sh{sh_base:+.3f} DD5.3%")
print(f"  BTC: ADX18, SL2.78/3.28/16, RANGE-only, skip August")
print(f"  SOL: ADX15, SL2.9/3.4/24, RANGE-only")
print(f"  Turtle: DE20/DX14/CUT2.0/BEAR-gate")
print(f"  Weight: BTC=1, SOL=1, Turtle=1.2")
print(f"")
print(f"  IMPROVEMENT vs R50 canonical: +0.21 Sh, -0.6% DD")
print(f"  Key improvements: Turtle(+0.15) + BTC-SL(+0.12) + SOL-SL(+0.04) + Aug-skip(+0.08)")
print(f"")
print(f"  STATUS: Forward-test recommended. Aug skip has n=3 real trades (caveat).")
print(f"  Aug skip 7y confirmed on both BTC78(+0.055) and canonical(+0.049).")
