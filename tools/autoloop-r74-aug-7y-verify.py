#!/usr/bin/env python3
"""autoloop-r74-aug-7y-verify.py — Round 74: August skip 7y verify
R73 CONCERN: August skip Sh+2.25-2.28 looks amazing but n=3 months only.
R74: Verify on full 7y BTC data — if August consistently bad on 7y, then REAL.
  A: Aug skip on 7y BTC alone (n=7 Augusts) — does it help?
  B: 7y monthly breakdown — which months are consistently bad on 7y scale?
  C: Full portfolio Aug-skip robustness on 7y window (if SOL data existed)
  D: Nov-Dec skip (both also had low WR in 3y analysis)
  E: Structural reason test — compare BTC returns in Aug vs other months (7y)
  F: FINAL DECISION: accept Aug skip as structural (7y confirmed) or reject as overfit?
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
             skip_months=None):
    H.CACHE=cache
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
        cur=atp(i); return cur is not None and cur>=sorted(vs)[int(len(vs)*H.ATR_PCT_PCTL)]
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

print("Loading 7y BTC data...")
moB7,_=run_h01(f"{CC}/binance-5m-7y.json",18,sl_init=2.78,sl_trail=3.28)
moB7_noaug,_=run_h01(f"{CC}/binance-5m-7y.json",18,sl_init=2.78,sl_trail=3.28,skip_months={8})
moB7_can,_=run_h01(f"{CC}/binance-5m-7y.json",18)
moB7_can_noaug,_=run_h01(f"{CC}/binance-5m-7y.json",18,skip_months={8})
turB14=run_turtle(14)
H.CACHE=f"{CC}/binance-sol-5m-3y.json"; bs=H.load_tf(H.H4); span_s=(bs[0]["time"],bs[-1]["time"])
H.CACHE=f"{CC}/binance-5m-7y.json"; bb_=H.load_tf(H.H4); span_b=(bb_[0]["time"],bb_[-1]["time"])
cal3=months_between(span_s[0],span_s[1]); cal7=months_between(span_b[0],span_b[1])
moS29,_=run_h01(f"{CC}/binance-sol-5m-3y.json",15,sl_init=2.9,sl_trail=3.4,sl_trans=24)
sS29=[moS29.get(m,0.0) for m in cal3]; sTB14=[turB14.get(m,0.0) for m in cal3]; W=[1,1,1.2]

def bk3(parts, weights=None, cal=None):
    cc=cal or cal3; k=len(parts); w=weights or W; sw=sum(w)
    p=[sum(w[j]*parts[j][i] for j in range(k))/sw for i in range(len(cc))]
    yr=defaultdict(float)
    for i,m in enumerate(cc): yr[int(m[:4])]+=p[i]
    sh=sharpe(p); md=maxdd(p); fl=sum(1 for x in p if abs(x)<1e-9)
    test_m=[m for m in cc if m[:4] in ("2025","2026")]
    sh_te=sharpe([p[cc.index(m)] for m in test_m]) if test_m else 0
    py=" ".join(f"{y%100}:{yr[y]*100:+.0f}" for y in sorted(yr))
    return sh,md,fl,sh_te,py

def pr3(label, parts, weights=None, extra=""):
    sh,md,fl,te,py=bk3(parts,weights)
    delta=sh-sh_base if 'sh_base' in globals() else 0
    ok=sh>=2.20; mark="✅✅" if ok else ("✅" if sh>=2.10 else ("⚠️" if sh>=2.00 else ""))
    star="★★★" if sh>=2.25 else ("★★" if sh>=2.20 else ("★" if delta>0.05 else ""))
    print(f"  {mark} {label:<52} Sh{sh:>+5.2f} DD{md:>4.1f}% flat{fl:>3} TE{te:>+5.2f} d{delta:>+.3f} {star} {extra}")
    return sh

sB78_3=[moB7.get(m,0.0) for m in cal3]
sB78_noaug_3=[moB7_noaug.get(m,0.0) for m in cal3]
sh_base=pr3("R70 BASELINE: BTC78+SOL29+DX14+T1.2",[sB78_3,sS29,sTB14])
pr3("  + Aug skip BTC78",[sB78_noaug_3,sS29,sTB14])
print(); print("="*100); print("=== R74: August skip 7y verify ===\n")

# A: 7y BTC Aug skip
print("━"*100); print("A: 7y BTC — August skip verify (n=7 Augusts)")
sB7=[moB7.get(m,0.0) for m in cal7]; sB7_na=[moB7_noaug.get(m,0.0) for m in cal7]
sTB7=[turB14.get(m,0.0) for m in cal7]
sh_7=sharpe(sB7); sh_7na=sharpe(sB7_na)
md_7=maxdd(sB7); md_7na=maxdd(sB7_na)
print(f"  BTC78 7y NO-skip: Sh{sh_7:+.3f} DD{md_7:.1f}% tot={sum(sB7)*100:+.0f}%")
print(f"  BTC78 7y AUG-skip: Sh{sh_7na:+.3f} DD{md_7na:.1f}% tot={sum(sB7_na)*100:+.0f}%")
print(f"  Delta: Sh{sh_7na-sh_7:+.3f} DD{md_7na-md_7:+.1f}%")

# August months detail
print(f"\n  August months (7y BTC78):")
for m in cal7:
    if m[5:7]=="08":
        v=moB7.get(m,0.0); vna=moB7_noaug.get(m,0.0)
        print(f"    {m}: {v*100:>+6.1f}% (skipped={vna==0})")

# B: Full 7y monthly breakdown with Aug skip
print(f"\n{'━'*100}"); print("B: 7y monthly breakdown — hedge01 BTC78 by month")
by_mo7=defaultdict(list)
for m in cal7: by_mo7[int(m[5:7])].append(moB7.get(m,0.0))
print(f"  {'Mo':<4} {'n':>3} {'WR':>6} {'avg%':>7} {'Sh':>7} {'verdict'}")
bad_months=[]; good_months=[]
for mo_n in range(1,13):
    vals=by_mo7[mo_n]
    if not vals: continue
    wr=sum(1 for v in vals if v>0)/len(vals)*100; avg=sum(vals)/len(vals)*100
    sh_m=sharpe(vals) if len(vals)>1 else 0
    verdict="BAD(SKIP?)" if wr<25 and avg<0 else ("WEAK" if wr<35 else ("OK" if wr<55 else "GOOD"))
    if verdict=="BAD(SKIP?)": bad_months.append(mo_n)
    print(f"  {mo_n:<4} {len(vals):>3} {wr:>5.0f}% {avg:>+6.1f}% {sh_m:>+6.2f} {verdict}")

print(f"\n  Bad months (WR<25% AND avg<0): {bad_months}")

# C: Multiple bad months skip
print(f"\n{'━'*100}"); print("C: Skip multiple bad months vs skip Aug only")
for skip_set in [{8},{8,9},{3,8,9},{1,3,8,9}]:
    moB_,nt=run_h01(f"{CC}/binance-5m-7y.json",18,sl_init=2.78,sl_trail=3.28,skip_months=skip_set)
    sB_=[moB_.get(m,0.0) for m in cal3]
    sh_7_=sharpe([moB_.get(m,0.0) for m in cal7])
    pr3(f"  skip={skip_set}",[sB_,sS29,sTB14],extra=f"7y_BTC_Sh{sh_7_:+.2f} n={nt}")

# D: Canonical (SL3.0/3.5) Aug skip 7y
print(f"\n{'━'*100}"); print("D: Canonical BTC Aug skip 7y verify")
sB7_can=[moB7_can.get(m,0.0) for m in cal7]; sB7_can_na=[moB7_can_noaug.get(m,0.0) for m in cal7]
sh_can=sharpe(sB7_can); sh_can_na=sharpe(sB7_can_na)
print(f"  BTC canonical 7y: Sh{sh_can:+.3f} DD{maxdd(sB7_can):.1f}%")
print(f"  BTC canonical 7y Aug-skip: Sh{sh_can_na:+.3f} DD{maxdd(sB7_can_na):.1f}%")
print(f"  Delta 7y: Sh{sh_can_na-sh_can:+.3f}")

# Per-August canonical
print(f"\n  August months canonical BTC:")
for m in cal7:
    if m[5:7]=="08":
        v=moB7_can.get(m,0.0)
        print(f"    {m}: {v*100:>+6.1f}%")

# E: Final verdict
print(f"\n{'━'*100}"); print("E: VERDICT — is August skip structural or overfit?")
aug_vals_7=[moB7.get(m,0.0) for m in cal7 if m[5:7]=="08"]
aug_vals_can=[moB7_can.get(m,0.0) for m in cal7 if m[5:7]=="08"]
aug_wr=sum(1 for v in aug_vals_7 if v>0)/len(aug_vals_7)*100 if aug_vals_7 else 0
print(f"  BTC78 August 7y: n={len(aug_vals_7)} WR={aug_wr:.0f}% avg={sum(aug_vals_7)/len(aug_vals_7)*100:+.1f}%")
aug_wr_can=sum(1 for v in aug_vals_can if v>0)/len(aug_vals_can)*100 if aug_vals_can else 0
print(f"  BTC canonical August 7y: n={len(aug_vals_can)} WR={aug_wr_can:.0f}% avg={sum(aug_vals_can)/len(aug_vals_can)*100:+.1f}%")
print()
print(f"  7y Sharpe delta with Aug skip: BTC78={sh_7na-sh_7:+.3f} | canonical={sh_can_na-sh_can:+.3f}")
if sh_7na-sh_7>0.05 and sh_can_na-sh_can>0.05:
    print(f"  ✅ STRUCTURAL: Both configs confirm Aug skip helps on 7y → ADOPT")
elif sh_7na-sh_7>0 or sh_can_na-sh_can>0:
    print(f"  ⚠️ MARGINAL: One or both confirm → cautious")
else:
    print(f"  ❌ OVERFIT: 7y does NOT confirm → REJECT Aug skip")

# F: Portfolio final with Aug skip (if structural)
print(f"\n{'━'*100}"); print("F: Portfolio final — BTC78 Aug-skip + SOL29 + DX14")
pr3("  R70 BTC78+SOL29+DX14+T1.2",[sB78_3,sS29,sTB14])
pr3("  +Aug-skip BTC78",[sB78_noaug_3,sS29,sTB14])

# SOL Aug analysis
moS_noaug,_=run_h01(f"{CC}/binance-sol-5m-3y.json",15,sl_init=2.9,sl_trail=3.4,sl_trans=24,skip_months={8})
sS_na=[moS_noaug.get(m,0.0) for m in cal3]
aug_sol=[moS29.get(m,0.0) for m in cal3 if m[5:7]=="08"]
aug_mo=[m for m in cal3 if m[5:7]=="08"]
print(f"\n  SOL August months (3y): {[(m,round(moS29.get(m,0.0)*100,1)) for m in aug_mo]}")
pr3("  +Aug-skip BTC78+SOL",[sB78_noaug_3,sS_na,sTB14])

print(f"\n{'='*100}")
print("R74 DECISION FRAMEWORK:")
print("  IF 7y Aug skip STRUCTURAL (both configs positive >+0.05):")
print("    → ADOPT: BTC78+SOL29+DX14+T1.2+Aug-skip → best config")
print("  IF MARGINAL or OVERFIT:")
print("    → KEEP R70: BTC28+SOL29+DX14+T1.2 → ceiling Sh+2.17")
print("  FROM FEEDBACK: data-scan filters (monthly) = risky. n<20/year = red flag.")
print("  Aug n=7 in 7y data → borderline but getting above red flag threshold.")
