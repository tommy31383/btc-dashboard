#!/usr/bin/env python3
"""autoloop-r57-signal-depth.py — Round 57: Signal parameter deep-dive
R50-R56 conclusion: Entry/exit timing exhausted. Ceiling ~Sh+2.04.
New direction: tune SIGNAL params (S13/S14/S12) that haven't been swept since R19-R22.
  A: ATR_BREAK_MULT sweep (S13 signal) — currently 1.3, how sensitive?
  B: DONCHIAN_LB sweep (S14 signal) — currently 20, try 8-40
  C: S12 re-enable with different CD — golden cross was killed early (CD=20)
  D: S13+S14 dual-confirm — only enter when BOTH fire within 3 bars (higher quality)
  E: ADX sticky=1 bar (current) vs 2 bars vs 3 bars — more confirmation = better?

Config: BTC(ADX18,SL3/3.5/16,pctl=0.50,ec24/0.5) + SOL(ADX15) + Turtle(DE20/DX15/CUT2.0)
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

def run_turtle():
    H.CACHE=f"{CC}/binance-5m-7y.json"
    bars1d=H.load_tf(86400*1000); BD=bars1d; nd=len(BD); CC_=[b["close"] for b in BD]
    regime_1d=H.regime_with_persistence(BD); reg_map={b["time"]//86400000:regime_1d[i] for i,b in enumerate(BD)}
    def get_reg(ts): return reg_map.get(ts//86400000,"RANGE")
    atrd=[None]*nd
    for i in range(1,nd):
        h=BD[i]["high"]; l=BD[i]["low"]; pc=BD[i-1]["close"]
        atrd[i]=max(h-l,abs(h-pc),abs(l-pc))
    dhi=[None]*nd; dlo=[None]*nd
    for i in range(20,nd): dhi[i]=max(BD[j]["high"] for j in range(i-20,i))
    for i in range(15,nd): dlo[i]=min(BD[j]["low"] for j in range(i-15,i))
    tur_mo=defaultdict(float); hold=False; e=0.0; a=0.0
    for i in range(20,nd):
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
             ec_bars=24, ec_loss=0.5, atr_pctl=0.50, donchian_lb=20,
             adx_sticky=1, s12_cd=36, use_s12=True, use_s13=True, use_s14=True,
             dual_confirm_window=0):
    """dual_confirm_window: if >0, only enter S13/S14 when both fire within this many bars"""
    H.CACHE=cache
    orig_pctl=H.ATR_PCT_PCTL; H.ATR_PCT_PCTL=atr_pctl
    orig=(H.ADX_THRESH,H.SL_INIT,H.SL_TRAIL,H.SL_TRANS,H.ADX_P,H.ATR_BREAK_MULT,H.VOL_MULT,H.VOL_MA,H.MAX_HOLD,H.DONCHIAN_LB)
    H.ADX_THRESH=adx_thresh; H.SL_INIT=sl_init; H.SL_TRAIL=sl_trail; H.SL_TRANS=sl_trans
    H.ADX_P=adx_period; H.ATR_BREAK_MULT=atr_break_mult; H.VOL_MULT=vol_mult; H.VOL_MA=vol_ma; H.MAX_HOLD=max_hold
    H.DONCHIAN_LB=donchian_lb
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
    def adx_sticky_ok(i):
        if adx4[i] is None or adx4[i]<=adx_thresh: return False
        for k in range(1, adx_sticky+1):
            if i-k<0 or adx4[i-k] is None or adx4[i-k]<=adx_thresh: return False
        return True
    def filt(i):
        if not adx_sticky_ok(i): return False
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
                if c4[j]<ep-ae*ec_loss: return (c4[j]-ep)/ep-2*H.FEE, h
            mult=H.SL_INIT if h<H.SL_TRANS else H.SL_TRAIL
            if c4[j]>hwm: hwm=c4[j]; sl_=hwm-ae*mult
            elif h>=H.SL_TRANS:
                t=hwm-ae*H.SL_TRAIL
                if t>sl_: sl_=t
            if bars4h[j]["low"]<=sl_: return (sl_-ep)/ep-2*H.FEE, h
        j=min(ei+H.MAX_HOLD,n-1); return (c4[j]-ep)/ep-2*H.FEE, H.MAX_HOLD
    s12fn=lambda i:(None if None in (e50[i],e200[i]) or i<1 or None in (e50[i-1],e200[i-1]) else ("LONG" if e50[i-1]<=e200[i-1] and e50[i]>e200[i] else None))
    s13fn=lambda i:(None if atr4[i] is None or i<1 else ("LONG" if c4[i]>bars4h[i-1]["close"]+atr4[i]*atr_break_mult else None))
    s14fn=lambda i:(None if i<donchian_lb else ("LONG" if c4[i]>max(bars4h[j]["high"] for j in range(i-donchian_lb,i)) else None))
    # Build signal config
    sigs={}
    if use_s12: sigs["S12"]=(s12fn,False,s12_cd)
    if use_s13: sigs["S13"]=(s13fn,True,1)
    if use_s14: sigs["S14"]=(s14fn,True,36)
    mo=defaultdict(float); last={s:0 for s in sigs}; n_tr=0
    # For dual-confirm: track last S13/S14 fire
    last_s13=last_s14=-9999
    for i in range(250,n-H.MAX_HOLD):
        for sn,(sfn,dov,cd) in sigs.items():
            if sfn(i)!="LONG": continue
            if i-last[sn]<cd: continue
            if dov and not vol_pass(i): continue
            if not filt(i): continue
            # dual confirm check
            if dual_confirm_window>0 and sn in ("S13","S14"):
                if sn=="S13": last_s13=i
                else: last_s14=i
                # only proceed if partner also fired within window
                partner_last=last_s14 if sn=="S13" else last_s13
                if abs(i-partner_last)>dual_confirm_window: continue
            r=sim(i)
            if r is None: continue
            ret,h=r; cts=bars4h[min(i+h,n-1)]["time"]
            mo[mo_str(cts)]+=ret; last[sn]=i; n_tr+=1
    (H.ADX_THRESH,H.SL_INIT,H.SL_TRAIL,H.SL_TRANS,H.ADX_P,H.ATR_BREAK_MULT,H.VOL_MULT,H.VOL_MA,H.MAX_HOLD,H.DONCHIAN_LB)=orig
    H.ATR_PCT_PCTL=orig_pctl
    return mo, n_tr

# ─── Setup ───
print("Loading baseline...")
moB0,nt0=run_h01(f"{CC}/binance-5m-7y.json",18)
moS0,_=run_h01(f"{CC}/binance-sol-5m-3y.json",15)
turB=run_turtle()
H.CACHE=f"{CC}/binance-sol-5m-3y.json"; bs=H.load_tf(H.H4); span_s=(bs[0]["time"],bs[-1]["time"])
H.CACHE=f"{CC}/binance-5m-7y.json"
cal3=months_between(span_s[0],span_s[1]); cal7=months_between(1546300800000, span_s[1])
sB=[moB0.get(m,0.0) for m in cal3]; sS=[moS0.get(m,0.0) for m in cal3]; sTB=[turB.get(m,0.0) for m in cal3]

def bk(parts, weights=None):
    k=len(parts); w=weights or [1]*k; sw=sum(w)
    p=[sum(w[j]*parts[j][i] for j in range(k))/sw for i in range(len(cal3))]
    yr=defaultdict(float)
    for i,m in enumerate(cal3): yr[int(m[:4])]+=p[i]
    sh=sharpe(p); md=maxdd(p); fl=sum(1 for x in p if abs(x)<1e-9)
    test_m=[m for m in cal3 if m[:4] in ("2025","2026")]
    sh_te=sharpe([p[cal3.index(m)] for m in test_m])
    py=" ".join(f"{y%100}:{yr[y]*100:+.0f}" for y in sorted(yr))
    return sh,md,fl,sh_te,py

def pr(label, parts, weights=None, extra=""):
    sh,md,fl,te,py=bk(parts,weights)
    delta=sh-sh_base if 'sh_base' in globals() else 0
    ok=sh>=2.10; mark="✅" if ok else ("⚠️" if sh>=2.00 else "")
    star="★★" if sh>=2.15 else ("★" if delta>0.05 else "")
    print(f"  {mark} {label:<54} Sh{sh:>+5.2f} DD{md:>4.1f}% flat{fl:>3} TE{te:>+5.2f} d{delta:>+.3f} {star} {extra}")
    return sh

sh_base=pr("BASELINE R56 (pctl=0.50,ec24/0.5)",[sB,sS,sTB])
print(f"  BTC trades: {nt0}\n")

print("="*100)
print("=== R57: Signal parameter deep-dive ===\n")

# ─── A: ATR_BREAK_MULT (S13) sweep ───
print("━"*100)
print("A: ATR_BREAK_MULT sweep (S13 signal) — current=1.3")
for abm in [0.8,0.9,1.0,1.1,1.2,1.3,1.4,1.5,1.6,1.8,2.0]:
    moB_,nt=run_h01(f"{CC}/binance-5m-7y.json",18,atr_break_mult=abm)
    sB_=[moB_.get(m,0.0) for m in cal3]
    sh=pr(f"  ABM={abm}",[sB_,sS,sTB],extra=f"n={nt}")

# ─── B: DONCHIAN_LB (S14) sweep ───
print(f"\n{'━'*100}")
print("B: DONCHIAN_LB sweep (S14 signal) — current=20")
for dlb in [8,10,12,15,18,20,24,28,32,40]:
    moB_,nt=run_h01(f"{CC}/binance-5m-7y.json",18,donchian_lb=dlb)
    sB_=[moB_.get(m,0.0) for m in cal3]
    sh=pr(f"  D_LB={dlb}",[sB_,sS,sTB],extra=f"n={nt}")

# ─── C: S12 sensitivity (cooldown) ───
print(f"\n{'━'*100}")
print("C: S12 (golden cross) cooldown sweep — current CD=36")
for cd12 in [1,8,12,16,20,24,36,48]:
    moB_,nt=run_h01(f"{CC}/binance-5m-7y.json",18,s12_cd=cd12)
    sB_=[moB_.get(m,0.0) for m in cal3]
    sh=pr(f"  S12_CD={cd12}",[sB_,sS,sTB],extra=f"n={nt}")

# S12 disabled (only S13+S14)
moB_nos12,nt=run_h01(f"{CC}/binance-5m-7y.json",18,use_s12=False)
sB_nos12=[moB_nos12.get(m,0.0) for m in cal3]
pr("  S12 DISABLED (S13+S14 only)",[sB_nos12,sS,sTB],extra=f"n={nt}")

# ─── D: Dual-confirm S13+S14 ───
print(f"\n{'━'*100}")
print("D: Dual-confirm — enter only when S13+S14 both fire within N bars")
for dcw in [3,5,8,12,20]:
    moB_,nt=run_h01(f"{CC}/binance-5m-7y.json",18,dual_confirm_window=dcw)
    sB_=[moB_.get(m,0.0) for m in cal3]
    pr(f"  dual_window={dcw}",[sB_,sS,sTB],extra=f"n={nt}")

# ─── E: ADX sticky bars ───
print(f"\n{'━'*100}")
print("E: ADX sticky bars — require ADX>thresh for N consecutive bars (current=1)")
for sticky in [1,2,3,4]:
    moB_,nt=run_h01(f"{CC}/binance-5m-7y.json",18,adx_sticky=sticky)
    sB_=[moB_.get(m,0.0) for m in cal3]
    pr(f"  sticky={sticky}bars",[sB_,sS,sTB],extra=f"n={nt}")

print(f"\n{'='*100}")
print("R57 SUMMARY — best signal params to combine in R58")
