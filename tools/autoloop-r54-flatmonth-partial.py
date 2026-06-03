#!/usr/bin/env python3
"""autoloop-r54-flatmonth-diagnosis.py — Round 54: Flat month diagnosis + partial TP
R51: Limit/dip entry = WORSE. Breakout close = optimal.
R52: RSI/DI/ADX exit = ALL WORSE. Trailing = optimal top-exit.
R53: Swing/1h/BB new signals = ALL WORSE (-0.15 to -0.20). Early-cut marginal +0.04 (noise?).

R54 goals:
  A: Early-cut robustness — ablation (random year holdout) → real or overfit?
  B: Partial TP — close 50% at 3×ATR, let 50% ride trailing → better Sharpe?
  C: Flat month diagnosis — tháng nào flat? regime gì? lý do gì? có window nào missed?
  D: BULL-regime add-on — hedge01 currently RANGE-only → add simplified signal for BULL
  E: Wider ATR stop on BTC (SL_INIT 2.5 → allow entry on smaller pullback within position)

Baseline: BTC+SOL+Turtle(DE20/DX15/CUT2.0/BEAR-gate) → Sh+2.05 DD5.9%
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
    def atr_d(bars):
        out=[None]*len(bars)
        for i in range(1,len(bars)):
            h=bars[i]["high"]; l=bars[i]["low"]; pc=bars[i-1]["close"]
            out[i]=max(h-l,abs(h-pc),abs(l-pc))
        return out
    atrd=atr_d(BD); dhi=[None]*nd; dlo=[None]*nd
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

def run_h01_v(cache, adx_thresh=18, sl_init=3.0, sl_trail=3.5, sl_trans=16,
              adx_period=12, atr_break_mult=1.3, vol_mult=1.4, vol_ma=10, max_hold=200,
              ec_bars=None, ec_loss=None, partial_tp=None, bull_gate=False):
    """
    partial_tp: if set, close 50% at ep+partial_tp×ATR, trail remaining
    bull_gate: if True, include BULL regime in addition to RANGE
    ec_bars/ec_loss: early cut
    """
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
        reg=get_reg(bars4h[i]["time"])
        if bull_gate: return reg in ("RANGE","BULL")
        return reg=="RANGE"
    def sim(ei):
        ep=c4[ei]; ae=atr4[ei]
        if ae is None or ae<=0: return None
        sl_=ep-ae*H.SL_INIT; hwm=ep
        half_tp=ep+ae*partial_tp if partial_tp else None
        half_closed=False; half_ret=0.0
        for h in range(1,H.MAX_HOLD+1):
            j=ei+h
            if j>=n: break
            bar_j=bars4h[j]
            # early cut
            if ec_bars and h==ec_bars and ec_loss:
                if c4[j]<ep-ae*ec_loss:
                    full_ret=(c4[j]-ep)/ep-2*H.FEE
                    if half_closed: return 0.5*half_ret+0.5*full_ret, h
                    return full_ret, h
            # partial TP
            if half_tp and not half_closed and bar_j["high"]>=half_tp:
                half_ret=(half_tp-ep)/ep-H.FEE; half_closed=True
                sl_=half_tp-ae*H.SL_TRAIL  # trail from TP point
            mult=H.SL_INIT if h<H.SL_TRANS else H.SL_TRAIL
            if c4[j]>hwm: hwm=c4[j]; sl_=hwm-ae*mult
            elif h>=H.SL_TRANS:
                t=hwm-ae*H.SL_TRAIL
                if t>sl_: sl_=t
            if bar_j["low"]<=sl_:
                trail_ret=(sl_-ep)/ep-H.FEE
                if half_closed: return 0.5*half_ret+0.5*trail_ret, h
                return (sl_-ep)/ep-2*H.FEE, h
        j=min(ei+H.MAX_HOLD,n-1); trail_ret=(c4[j]-ep)/ep-H.FEE
        if half_closed: return 0.5*half_ret+0.5*trail_ret, H.MAX_HOLD
        return (c4[j]-ep)/ep-2*H.FEE, H.MAX_HOLD
    s12=lambda i:(None if None in (e50[i],e200[i]) or i<1 or None in (e50[i-1],e200[i-1]) else ("LONG" if e50[i-1]<=e200[i-1] and e50[i]>e200[i] else None))
    s13=lambda i:(None if atr4[i] is None or i<1 else ("LONG" if c4[i]>bars4h[i-1]["close"]+atr4[i]*H.ATR_BREAK_MULT else None))
    s14=lambda i:(None if i<H.DONCHIAN_LB else ("LONG" if c4[i]>max(bars4h[j]["high"] for j in range(i-H.DONCHIAN_LB,i)) else None))
    sigs={"S12":(s12,False,36),"S13":(s13,True,1),"S14":(s14,True,36)}
    mo=defaultdict(float); last={s:0 for s in sigs}; n_tr=0; mo_detail=defaultdict(list)
    for i in range(250,n-H.MAX_HOLD):
        for sn,(sfn,dov,cd) in sigs.items():
            if sfn(i)!="LONG": continue
            if i-last[sn]<cd: continue
            if dov and not vol_pass(i): continue
            if not filt(i): continue
            r=sim(i)
            if r is None: continue
            ret,h=r; cts=bars4h[min(i+h,n-1)]["time"]
            m=mo_str(cts); mo[m]+=ret; mo_detail[m].append((sn,ret,bars4h[i]["time"])); last[sn]=i; n_tr+=1
    (H.ADX_THRESH,H.SL_INIT,H.SL_TRAIL,H.SL_TRANS,H.ADX_P,H.ATR_BREAK_MULT,H.VOL_MULT,H.VOL_MA,H.MAX_HOLD)=orig
    return mo, n_tr, mo_detail

# ─── Setup ───
print("Loading baselines...")
moB,_,detB=run_h01_v(f"{CC}/binance-5m-7y.json",18)
moS,_,detS=run_h01_v(f"{CC}/binance-sol-5m-3y.json",15)
turB=run_turtle()
H.CACHE=f"{CC}/binance-sol-5m-3y.json"; bs=H.load_tf(H.H4); span_s=(bs[0]["time"],bs[-1]["time"])
H.CACHE=f"{CC}/binance-5m-7y.json"; bb_=H.load_tf(H.H4); span_b=(bb_[0]["time"],bb_[-1]["time"])
cal3=months_between(span_s[0],span_s[1]); cal7=months_between(span_b[0],span_b[1])
sB=[moB.get(m,0.0) for m in cal3]; sS=[moS.get(m,0.0) for m in cal3]; sTB=[turB.get(m,0.0) for m in cal3]

def bk(parts, weights=None, cal=None):
    c=cal or cal3; k=len(parts); w=weights or [1]*k; sw=sum(w)
    p=[sum(w[j]*parts[j][i] for j in range(k))/sw for i in range(len(c))]
    yr=defaultdict(float)
    for i,m in enumerate(c): yr[int(m[:4])]+=p[i]
    sh=sharpe(p); md=maxdd(p); fl=sum(1 for x in p if abs(x)<1e-9)
    test_m=[m for m in c if m[:4] in ("2025","2026")]
    sh_te=sharpe([p[c.index(m)] for m in test_m if m in c])
    py=" ".join(f"{y%100}:{yr[y]*100:+.0f}" for y in sorted(yr))
    return sh,md,fl,sh_te,py

def pr(label, parts, weights=None, cal=None, extra=""):
    sh,md,fl,te,py=bk(parts,weights,cal)
    delta=sh-sh_base if 'sh_base' in globals() else 0
    ok=sh>=2.10; mark="✅" if ok else ("⚠️" if sh>=2.00 else "")
    star="★★" if sh>=2.15 else ("★" if delta>0.05 else "")
    print(f"  {mark} {label:<54} Sh{sh:>+5.2f} DD{md:>4.1f}% flat{fl:>3} TE{te:>+5.2f} {star} {extra}")
    return sh

sh_base=pr("BASELINE R50",[sB,sS,sTB])

print(f"\n{'='*100}")
print("=== R54: Early-cut robustness + Partial TP + Flat diagnosis + BULL add-on ===\n")

# ─── A: Early-cut robustness — hold-out years ───
print("━"*100)
print("A: Early-cut robustness — hold-out year test (ec=24bars, 0.5×ATR)")
print("   Nếu delta NHẤT QUÁN qua mọi year holdout → signal THẬT. Nếu không → overfit noise.")
# ec winner
moB_ec,_,_=run_h01_v(f"{CC}/binance-5m-7y.json",18,ec_bars=24,ec_loss=0.5)
sB_ec=[moB_ec.get(m,0.0) for m in cal3]
sh_ec=pr("EC_24_0.5 BTC (full 3y)",[sB_ec,sS,sTB])
# Holdout 1 year at a time
for yr_exclude in [2023,2024,2025]:
    cal_ho=[m for m in cal3 if not m.startswith(str(yr_exclude))]
    sB_ho=[moB.get(m,0.0) for m in cal_ho]; sB_ec_ho=[moB_ec.get(m,0.0) for m in cal_ho]
    sS_ho=[moS.get(m,0.0) for m in cal_ho]; sTB_ho=[turB.get(m,0.0) for m in cal_ho]
    sh_orig,_,_,_,_=bk([sB_ho,sS_ho,sTB_ho],cal=cal_ho)
    sh_ec_ho,_,_,_,_=bk([sB_ec_ho,sS_ho,sTB_ho],cal=cal_ho)
    delta_ho=sh_ec_ho-sh_orig
    robust="✓ ROBUST" if delta_ho>0 else "✗ FRAGILE"
    print(f"  Holdout {yr_exclude}: base Sh{sh_orig:+.2f} → ec Sh{sh_ec_ho:+.2f} delta{delta_ho:>+.3f} {robust}")
print(f"  Verdict: {'KEEP if all 3 positive' if True else ''}")

# ─── B: Partial TP ───
print(f"\n{'━'*100}")
print("B: Partial TP — close 50% at N×ATR, trail 50% (BTC)")
for ptp in [2.0,3.0,4.0,5.0,6.0]:
    moBp,_,_=run_h01_v(f"{CC}/binance-5m-7y.json",18,partial_tp=ptp)
    sBp=[moBp.get(m,0.0) for m in cal3]
    pr(f"  partial-TP {ptp}×ATR BTC 50/50",[sBp,sS,sTB])

# ─── C: Flat month diagnosis ───
print(f"\n{'━'*100}")
print("C: Flat month diagnosis — tháng nào portfolio=0? Regime? BTC/SOL/turtle đều miss?")
portfolio=[sB[i]+sS[i]+sTB[i] for i in range(len(cal3))]
# load regime
H.CACHE=f"{CC}/binance-5m-7y.json"; bars1d=H.load_tf(86400*1000)
regime_1d=H.regime_with_persistence(bars1d); reg_map={bars1d[i]["time"]//86400000:regime_1d[i] for i in range(len(bars1d))}
def get_reg_month(ym):
    y,m=int(ym[:4]),int(ym[5:7])
    mid_ts=int(datetime.datetime(y,m,15).timestamp())*1000
    return reg_map.get(mid_ts//86400000,"?")
flat_months=[cal3[i] for i in range(len(cal3)) if abs(portfolio[i])<1e-9]
print(f"  Flat months ({len(flat_months)}): {flat_months}")
print()
print(f"  {'Month':<10} {'Regime':>8} {'BTC':>8} {'SOL':>8} {'Turtle':>8} {'Reason'}")
print("  "+"-"*70)
for m in flat_months:
    reg=get_reg_month(m)
    btc_ret=moB.get(m,0.0)*100; sol_ret=moS.get(m,0.0)*100; tur_ret=turB.get(m,0.0)*100
    reason=[]
    if reg=="BEAR": reason.append("BEAR-skip(correct)")
    elif btc_ret==0 and sol_ret==0 and tur_ret==0: reason.append("all no-signal")
    elif btc_ret==0 and sol_ret==0: reason.append("h01 no-signal; turtle flat")
    else: reason.append("mixed-flat")
    print(f"  {m:<10} {reg:>8} {btc_ret:>+7.1f}% {sol_ret:>+7.1f}% {tur_ret:>+7.1f}% {' + '.join(reason)}")

# Also show positive months for context
pos_months=[(cal3[i],portfolio[i]*100) for i in range(len(cal3)) if portfolio[i]>0.001]
print(f"\n  Active positive months: {len(pos_months)}/35 = {len(pos_months)/35*100:.0f}% active")
yr_active=defaultdict(int)
for m,_ in pos_months: yr_active[int(m[:4])]+=1
print(f"  Per-year active: {' '.join(f'{y%100}:{yr_active[y]}/12' for y in sorted(yr_active))}")

# ─── D: BULL-regime add-on ───
print(f"\n{'━'*100}")
print("D: BULL-regime — allow hedge01 to trade in BULL (currently RANGE-only gate)")
moB_bull,nt_bull,_=run_h01_v(f"{CC}/binance-5m-7y.json",18,bull_gate=True)
sBull=[moB_bull.get(m,0.0) for m in cal3]
n_bull_trades=sum(1 for v in moB_bull.values() if abs(v)>1e-9)
sh_bull_alone=sharpe([moB_bull.get(m,0.0) for m in cal7])
pr(f"  hedge01-RANGE+BULL BTC (replace)",[sBull,sS,sTB],extra=f"trades={n_bull_trades}")
# How many extra trades in BULL months?
n_range_only=sum(1 for v in moB.values() if abs(v)>1e-9)
print(f"  RANGE-only BTC trades: {n_range_only}, RANGE+BULL: {n_bull_trades} (+{n_bull_trades-n_range_only})")
# Month-by-month comparison for BULL months
H.CACHE=f"{CC}/binance-5m-7y.json"; bars1d_=H.load_tf(86400*1000)
reg1d=H.regime_with_persistence(bars1d_); rm={bars1d_[i]["time"]//86400000:reg1d[i] for i in range(len(bars1d_))}
def get_r(ym):
    y,m=int(ym[:4]),int(ym[5:7]); mid=int(datetime.datetime(y,m,15).timestamp())*1000; return rm.get(mid//86400000,"?")
bull_months=[m for m in cal7 if get_r(m)=="BULL"]
print(f"\n  BULL months ({len(bull_months)}): {'  '.join(bull_months[:15])}{'...' if len(bull_months)>15 else ''}")
bull_only_ret=sum(moB_bull.get(m,0.0)-moB.get(m,0.0) for m in bull_months)
print(f"  Extra return from BULL trades: {bull_only_ret*100:+.1f}%")

# ─── E: Sensitivity confirm of R50 winner ───
print(f"\n{'━'*100}")
print("E: Turtle sensitivity confirm (R50 winner DE20/DX15/CUT2.0) — ±1 param robustness")
for DE,DX,CUT in [(20,15,2.0),(19,15,2.0),(21,15,2.0),(20,14,2.0),(20,16,2.0),(20,15,1.8),(20,15,2.2)]:
    tur_=run_turtle(DE,DX,CUT)
    sTur_=[tur_.get(m,0.0) for m in cal3]
    pr(f"  Turtle DE={DE} DX={DX} CUT={CUT}",[sB,sS,sTur_])

print(f"\n{'='*100}")
print("R54 SUMMARY")
print(f"  Baseline Sh{sh_base:+.3f} DD5.9%")
print("  → If BULL helps → R55: BULL-mode tune")
print("  → If early-cut fragile → confirm ceiling at Sh+2.05-2.10")
print("  → Flat month diagnosis → check if structural or tuneable")
