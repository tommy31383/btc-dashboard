#!/usr/bin/env python3
"""autoloop-r52-exit-timing.py — Round 52: Exit timing optimization
R51 conclusion: Entry at breakout close = OPTIMAL. Limit/dip entry ALL WORSE.
Goal R52: tối ưu điểm CHỐT gần đỉnh hơn — thay vì chờ ATR trailing stop hit.
  A: RSI-4h exit — khi trong trade và RSI-4h >75/80/85 → close
  B: DI exit — khi DI- > DI+ → close (momentum flip bearish)
  C: ADX-peak exit — khi ADX bắt đầu giảm từ peak (ADX[i] < ADX[i-1]) → close
  D: RSI + trailing combo — RSI exit VÀ trailing (whichever first)
  E: DI + trailing combo
  F: Take-profit fixed: khi profit ≥ N×ATR (TP fixed, không trailing)
  G: Breakeven fast: sau X bars nếu đang lỗ → close ngay (cut loser sớm)

Baseline R50: BTC+SOL+Turtle(DE20/DX15/CUT2.0/BEAR-gate) → Sh+2.05 DD5.9%
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

def run_turtle(DE=20,DX=15,CUT=2.0,bear_gate=True):
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
        if bear_gate and get_reg(BD[i]["time"])=="BEAR":
            if hold: tur_mo[mo_str(BD[i]["time"])]+=(CC_[i]-e)/e-2*H.FEE; hold=False
            continue
        if not hold:
            if dhi[i] and CC_[i]>dhi[i]: e=CC_[i]; a=atrd[i] or 0.01*e; hold=True
        else:
            if atrd[i]: a=atrd[i]
            if BD[i]["low"]<=e-a*CUT: ex=e-a*CUT; tur_mo[mo_str(BD[i]["time"])]+=(ex-e)/e-2*H.FEE; hold=False
            elif dlo[i] and CC_[i]<dlo[i]: tur_mo[mo_str(BD[i]["time"])]+=(CC_[i]-e)/e-2*H.FEE; hold=False
    if hold: tur_mo[mo_str(BD[-1]["time"])]+=(CC_[-1]-e)/e-2*H.FEE
    return tur_mo

def rsi_series(closes, period=14):
    out=[None]*len(closes)
    gains=[0.0]*len(closes); losses=[0.0]*len(closes)
    for i in range(1,len(closes)):
        d=closes[i]-closes[i-1]
        gains[i]=max(d,0.0); losses[i]=max(-d,0.0)
    if period>=len(closes): return out
    ag=sum(gains[1:period+1])/period; al=sum(losses[1:period+1])/period
    if al==0: out[period]=100.0
    else: rs=ag/al; out[period]=100-100/(1+rs)
    for i in range(period+1,len(closes)):
        ag=(ag*(period-1)+gains[i])/period; al=(al*(period-1)+losses[i])/period
        if al==0: out[i]=100.0
        else: rs=ag/al; out[i]=100-100/(1+rs)
    return out

def run_h01_exit(cache, adx_thresh=18, sl_init=3.0, sl_trail=3.5, sl_trans=16,
                  adx_period=12, atr_break_mult=1.3, vol_mult=1.4, vol_ma=10, max_hold=200,
                  rsi_exit=None, di_exit=False, adx_peak_exit=False,
                  tp_atr=None, early_cut_bars=None, early_cut_loss=None):
    """
    exit variants:
    - rsi_exit: close when RSI-4h >= rsi_exit (overrides trailing if hit first)
    - di_exit: close when DI- > DI+ (momentum flip)
    - adx_peak_exit: close when ADX starts declining after ≥ adx_peak_thresh
    - tp_atr: take profit at ep + tp_atr × entry_ATR
    - early_cut: cut trade if still losing after early_cut_bars bars by more than early_cut_loss×ATR
    """
    H.CACHE=cache
    orig=(H.ADX_THRESH,H.SL_INIT,H.SL_TRAIL,H.SL_TRANS,H.ADX_P,H.ATR_BREAK_MULT,H.VOL_MULT,H.VOL_MA,H.MAX_HOLD)
    H.ADX_THRESH=adx_thresh; H.SL_INIT=sl_init; H.SL_TRAIL=sl_trail; H.SL_TRANS=sl_trans
    H.ADX_P=adx_period; H.ATR_BREAK_MULT=atr_break_mult; H.VOL_MULT=vol_mult; H.VOL_MA=vol_ma; H.MAX_HOLD=max_hold
    bars4h=H.load_tf(H.H4); bars1h=H.load_tf(3600*1000); bars1d=H.load_tf(86400*1000)
    n=len(bars4h); c4=[b["close"] for b in bars4h]
    e50=H.ema_s(c4,H.EMA_FAST); e200=H.ema_s(c4,H.EMA_SLOW)
    atr4=H.atr_series(bars4h); adx4=H.adx_wilder(bars4h,period=adx_period)
    # DI+ and DI- (Wilder)
    def di_series(bars, period=14):
        """Returns (plus_di, minus_di) arrays"""
        nb=len(bars); tr=[0.]*nb; pdm=[0.]*nb; ndm=[0.]*nb
        for i in range(1,nb):
            h=bars[i]["high"]; l=bars[i]["low"]; ph=bars[i-1]["high"]; pl=bars[i-1]["low"]; pc=bars[i-1]["close"]
            tr[i]=max(h-l,abs(h-pc),abs(l-pc))
            up=h-ph; dn=pl-l
            pdm[i]=max(up,0) if up>dn else 0
            ndm[i]=max(dn,0) if dn>up else 0
        atr_=[None]*nb; pdi=[None]*nb; ndi=[None]*nb
        if period<nb:
            atr_[period]=sum(tr[1:period+1])/period
            p_=sum(pdm[1:period+1])/period; n_=sum(ndm[1:period+1])/period
            pdi[period]=(100*p_/atr_[period]) if atr_[period]>0 else 0
            ndi[period]=(100*n_/atr_[period]) if atr_[period]>0 else 0
            for i in range(period+1,nb):
                atr_[i]=(atr_[i-1]*(period-1)+tr[i])/period
                p_=(p_*(period-1)+pdm[i])/period; n_=(n_*(period-1)+ndm[i])/period
                pdi[i]=(100*p_/atr_[i]) if atr_[i]>0 else 0
                ndi[i]=(100*n_/atr_[i]) if atr_[i]>0 else 0
        return pdi, ndi
    rsi4=rsi_series(c4) if (rsi_exit is not None) else None
    pdi4, ndi4 = di_series(bars4h) if (di_exit or adx_peak_exit) else (None,None)
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
    def sim_exit(ei):
        ep=c4[ei]; ae=atr4[ei]
        if ae is None or ae<=0: return None
        sl_=ep-ae*H.SL_INIT; hwm=ep; tp_px=ep+ae*tp_atr if tp_atr else None
        for h in range(1,H.MAX_HOLD+1):
            j=ei+h
            if j>=n: break
            bar_j=bars4h[j]
            # early cut: if still losing after N bars
            if early_cut_bars and h==early_cut_bars and early_cut_loss:
                if c4[j]<ep-ae*early_cut_loss:
                    return (c4[j]-ep)/ep-2*H.FEE, h
            # RSI exit
            if rsi_exit and rsi4 and rsi4[j] is not None and rsi4[j]>=rsi_exit:
                return (c4[j]-ep)/ep-2*H.FEE, h
            # DI exit: DI- crosses above DI+
            if di_exit and pdi4 and pdi4[j] is not None and ndi4[j] is not None:
                if ndi4[j]>pdi4[j]:
                    return (c4[j]-ep)/ep-2*H.FEE, h
            # ADX peak exit: ADX declining from peak
            if adx_peak_exit and adx4[j] is not None and j>0 and adx4[j-1] is not None:
                if adx4[j]>35 and adx4[j]<adx4[j-1]:  # ADX was high, now declining
                    return (c4[j]-ep)/ep-2*H.FEE, h
            # TP fixed
            if tp_px and bar_j["high"]>=tp_px:
                return (tp_px-ep)/ep-2*H.FEE, h
            # ATR trailing stop
            mult=H.SL_INIT if h<H.SL_TRANS else H.SL_TRAIL
            if c4[j]>hwm: hwm=c4[j]; sl_=hwm-ae*mult
            elif h>=H.SL_TRANS:
                t=hwm-ae*H.SL_TRAIL
                if t>sl_: sl_=t
            if bar_j["low"]<=sl_: return (sl_-ep)/ep-2*H.FEE, h
        j=min(ei+H.MAX_HOLD,n-1); return (c4[j]-ep)/ep-2*H.FEE, H.MAX_HOLD
    s12=lambda i:(None if None in (e50[i],e200[i]) or i<1 or None in (e50[i-1],e200[i-1]) else ("LONG" if e50[i-1]<=e200[i-1] and e50[i]>e200[i] else None))
    s13=lambda i:(None if atr4[i] is None or i<1 else ("LONG" if c4[i]>bars4h[i-1]["close"]+atr4[i]*H.ATR_BREAK_MULT else None))
    s14=lambda i:(None if i<H.DONCHIAN_LB else ("LONG" if c4[i]>max(bars4h[j]["high"] for j in range(i-H.DONCHIAN_LB,i)) else None))
    sigs={"S12":(s12,False,36),"S13":(s13,True,1),"S14":(s14,True,36)}
    mo=defaultdict(float); last={s:0 for s in sigs}; n_trades=0
    for i in range(250,n-H.MAX_HOLD):
        for sn,(sfn,dov,cd) in sigs.items():
            if sfn(i)!="LONG": continue
            if i-last[sn]<cd: continue
            if dov and not vol_pass(i): continue
            if not filt(i): continue
            r=sim_exit(i)
            if r is None: continue
            ret,h=r; cts=bars4h[min(i+h,n-1)]["time"]
            mo[mo_str(cts)]+=ret; last[sn]=i; n_trades+=1
    (H.ADX_THRESH,H.SL_INIT,H.SL_TRAIL,H.SL_TRANS,H.ADX_P,H.ATR_BREAK_MULT,H.VOL_MULT,H.VOL_MA,H.MAX_HOLD)=orig
    return mo, n_trades

# ─── setup ───
print("Loading baselines...")
moB0,_=run_h01_exit(f"{CC}/binance-5m-7y.json",18)
moS0,_=run_h01_exit(f"{CC}/binance-sol-5m-3y.json",15)
turB=run_turtle()
H.CACHE=f"{CC}/binance-sol-5m-3y.json"; bars_s=H.load_tf(H.H4); span_s=(bars_s[0]["time"],bars_s[-1]["time"])
H.CACHE=f"{CC}/binance-5m-7y.json"
cal3=months_between(span_s[0],span_s[1])
sB=[moB0.get(m,0.0) for m in cal3]; sS=[moS0.get(m,0.0) for m in cal3]
sTB=[turB.get(m,0.0) for m in cal3]

def bk(parts, weights=None):
    k=len(parts); w=weights or [1]*k; sw=sum(w)
    p=[sum(w[j]*parts[j][i] for j in range(k))/sw for i in range(len(cal3))]
    yr=defaultdict(float)
    for i,m in enumerate(cal3): yr[int(m[:4])]+=p[i]
    sh=sharpe(p); md=maxdd(p); fl=sum(1 for x in p if abs(x)<1e-9)
    test_m=[m for m in cal3 if m[:4] in ("2025","2026")]
    sh_te=sharpe([p[cal3.index(m)] for m in test_m if m in cal3])
    py=" ".join(f"{y%100}:{yr[y]*100:+.0f}" for y in sorted(yr))
    return sh,md,fl,sh_te,py

def pr(label, parts, weights=None, n_tr=""):
    sh,md,fl,te,py=bk(parts,weights)
    delta=sh-sh_base if 'sh_base' in globals() else 0
    ok=sh>=2.10 and md<=10; mark="✅" if ok else ("⚠️" if sh>=2.00 else "")
    star="★★" if sh>=2.15 else ("★" if delta>0.05 else "")
    print(f"  {mark} {label:<54} Sh{sh:>+5.2f} DD{md:>4.1f}% flat{fl:>3} TE{te:>+5.2f} {star} {n_tr}")
    return sh

sh_base=pr("BASELINE (trailing stop only)",[sB,sS,sTB])

print(f"\n{'='*100}")
print("=== R52: Exit Timing Optimization ===\n")

# ─── A: RSI-4h exit ───
print("━"*100)
print("A: RSI-4h exit — close when RSI ≥ threshold (vẫn giữ trailing as backup)")
for rsi_t in [70,72,75,78,80,85]:
    moB_,nt=run_h01_exit(f"{CC}/binance-5m-7y.json",18,rsi_exit=rsi_t)
    sB_=[moB_.get(m,0.0) for m in cal3]
    pr(f"  RSI-exit≥{rsi_t} (BTC)",[sB_,sS,sTB],n_tr=f"BTC_trades≈{nt}")

# ─── B: DI- > DI+ exit ───
print(f"\n{'━'*100}")
print("B: DI exit — close when DI- crosses above DI+ (momentum flip)")
for di_e in [True]:
    moB_,nt=run_h01_exit(f"{CC}/binance-5m-7y.json",18,di_exit=True)
    sB_=[moB_.get(m,0.0) for m in cal3]
    pr(f"  DI-exit BTC",[sB_,sS,sTB],n_tr=f"BTC_trades≈{nt}")
    moS_,nt=run_h01_exit(f"{CC}/binance-sol-5m-3y.json",15,di_exit=True)
    sS_=[moS_.get(m,0.0) for m in cal3]
    pr(f"  DI-exit BTC+SOL",[sB_,sS_,sTB])

# ─── C: ADX-peak exit ───
print(f"\n{'━'*100}")
print("C: ADX-peak exit — close when ADX>35 then starts declining")
moB_,nt=run_h01_exit(f"{CC}/binance-5m-7y.json",18,adx_peak_exit=True)
sB_=[moB_.get(m,0.0) for m in cal3]
pr(f"  ADX-peak-exit BTC",[sB_,sS,sTB],n_tr=f"BTC_trades≈{nt}")
moS_,_=run_h01_exit(f"{CC}/binance-sol-5m-3y.json",15,adx_peak_exit=True)
sS_=[moS_.get(m,0.0) for m in cal3]
pr(f"  ADX-peak-exit BTC+SOL",[sB_,sS_,sTB])

# ─── D: TP fixed (N×ATR từ entry) ───
print(f"\n{'━'*100}")
print("D: Fixed TP at N×entry_ATR — crystallize gains at target")
for tp in [3.0,4.0,5.0,6.0,8.0,10.0]:
    moB_,nt=run_h01_exit(f"{CC}/binance-5m-7y.json",18,tp_atr=tp)
    sB_=[moB_.get(m,0.0) for m in cal3]
    pr(f"  TP={tp}×ATR BTC",[sB_,sS,sTB],n_tr=f"BTC_trades≈{nt}")

# ─── E: RSI exit combo ───
print(f"\n{'━'*100}")
print("E: Best RSI + DI combos (BTC+SOL both exit)")
for rsi_t in [75,80]:
    moB_,_=run_h01_exit(f"{CC}/binance-5m-7y.json",18,rsi_exit=rsi_t)
    moS_,_=run_h01_exit(f"{CC}/binance-sol-5m-3y.json",15,rsi_exit=rsi_t)
    sB_=[moB_.get(m,0.0) for m in cal3]; sS_=[moS_.get(m,0.0) for m in cal3]
    pr(f"  RSI-exit≥{rsi_t} BTC+SOL",[sB_,sS_,sTB])

# ─── F: Early cut (cut loser fast) ───
print(f"\n{'━'*100}")
print("F: Early cut — nếu sau N bars vẫn lỗ >X×ATR → close ngay")
for bars_c, loss_c in [(12,0.5),(24,0.5),(12,1.0),(24,1.0),(6,0.5)]:
    moB_,nt=run_h01_exit(f"{CC}/binance-5m-7y.json",18,early_cut_bars=bars_c,early_cut_loss=loss_c)
    sB_=[moB_.get(m,0.0) for m in cal3]
    pr(f"  early-cut {bars_c}bars loss≥{loss_c}×ATR BTC",[sB_,sS,sTB],n_tr=f"BTC_trades≈{nt}")

# ─── G: Combo best ───
print(f"\n{'━'*100}")
print("G: Combo — best exit signals together")
for rsi_t,di_e,tp_ in [(75,False,8.0),(80,True,None),(75,True,None),(80,False,None)]:
    label=f"RSI≥{rsi_t}"+("+DI" if di_e else "")+("" if not tp_ else f"+TP{tp_}")
    moB_,_=run_h01_exit(f"{CC}/binance-5m-7y.json",18,rsi_exit=rsi_t,di_exit=di_e,tp_atr=tp_)
    sB_=[moB_.get(m,0.0) for m in cal3]
    moS_,_=run_h01_exit(f"{CC}/binance-sol-5m-3y.json",15,rsi_exit=rsi_t,di_exit=di_e,tp_atr=tp_)
    sS_=[moS_.get(m,0.0) for m in cal3]
    pr(f"  {label} BTC+SOL",[sB_,sS_,sTB])

print(f"\n{'='*100}")
print("R52 SUMMARY")
print(f"  Baseline Sh{sh_base:+.3f} DD5.9%")
print("  → Nếu exit timing cải thiện → R53 combine best entry+exit")
print("  → Nếu không → R53 test ADD new entry signal (swing-low, higher-low)")
