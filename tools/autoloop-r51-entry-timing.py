#!/usr/bin/env python3
"""autoloop-r51-entry-timing.py — Round 51: Entry timing optimization
Goal: Thay vì enter tại breakout close (S14/S13), thử các cách enter gần đáy hơn:
  A: Limit entry — sau signal, enter tại close-0.5×ATR (trong 6 bars tiếp theo)
  B: Limit entry — sau signal, enter tại close-1.0×ATR (trong 6 bars tiếp theo)
  C: Limit entry — sau signal, enter tại close-1.5×ATR (trong 8 bars tiếp theo)
  D: RSI-dip 1h entry — RANGE+ADX4h>18+RSI1h<35+EMA200-1h bullish
  E: EMA-pullback entry — giá dip về EMA50-4h khi trong trend RANGE+ADX>18
  F: Volume-dip entry — giá dip + volume thấp (<0.7×MA10 = weak selling)

R50 winner: BTC+SOL+Turtle(DE20/DX15/CUT2.0/BEAR-gate) → Sh+2.06 DD5.9%
"""
import importlib.util, datetime, math, os, sys, json
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

# ─── Turtle R50 winner (DE20/DX15/CUT2.0/BEAR-gate) ───
def run_turtle(DE=20, DX=15, CUT=2.0, bear_gate=True, cache=None):
    H.CACHE=cache or f"{CC}/binance-5m-7y.json"
    bars1d=H.load_tf(86400*1000)
    BD=bars1d; nd=len(BD); CC_=[b["close"] for b in BD]
    regime_1d=H.regime_with_persistence(BD)
    reg_map={b["time"]//86400000:regime_1d[i] for i,b in enumerate(BD)}
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

# ─── hedge01 full params (R50 config) ───
def run_h01(cache, adx_thresh=18, sl_init=3.0, sl_trail=3.5, sl_trans=16,
            adx_period=12, atr_break_mult=1.3, vol_mult=1.4, vol_ma=10, max_hold=200,
            entry_dip=0.0, entry_window=0):
    """entry_dip: nếu >0, thay vì enter tại signal_close, place limit = signal_close - entry_dip×ATR
       entry_window: số bars chờ limit fill (0 = market entry ngay)
    """
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
    def sim(ei, ep_override=None):
        ep=ep_override if ep_override else c4[ei]; ae=atr4[ei]
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
    filled=0; skipped=0
    for i in range(250,n-H.MAX_HOLD):
        for sn,(sfn,dov,cd) in sigs.items():
            if sfn(i)!="LONG": continue
            if i-last[sn]<cd: continue
            if dov and not vol_pass(i): continue
            if not filt(i): continue
            # entry logic
            if entry_dip<=0 or entry_window<=0:
                # market entry at signal bar close
                r=sim(i); ep_used=c4[i]
            else:
                # limit entry: wait up to entry_window bars for price to dip
                limit_px=c4[i]-atr4[i]*entry_dip if atr4[i] else c4[i]
                ep_used=None; ei_bar=i
                for fw in range(1, entry_window+1):
                    j=i+fw
                    if j>=n: break
                    if bars4h[j]["low"]<=limit_px:
                        ep_used=limit_px; ei_bar=j; break
                if ep_used is None:
                    skipped+=1; continue  # limit never filled
                r=sim(ei_bar, ep_override=ep_used); filled+=1
            if r is None: continue
            ret,h=r; cts=bars4h[min((ei_bar if entry_dip>0 and entry_window>0 else i)+h,n-1)]["time"]
            mo[mo_str(cts)]+=ret; last[sn]=i
    (H.ADX_THRESH,H.SL_INIT,H.SL_TRAIL,H.SL_TRANS,H.ADX_P,
     H.ATR_BREAK_MULT,H.VOL_MULT,H.VOL_MA,H.MAX_HOLD)=orig
    return mo, filled, skipped

# ─── RSI-dip 1h entry scan ───
def run_rsi_dip(cache, adx_thresh=18, rsi_lb=14, rsi_entry=35, rsi_exit=75,
                sl_init=3.0, sl_trail=3.5, sl_trans=16, max_hold=200):
    """Scan 4h bars: RANGE + ADX>thresh + RSI-4h < rsi_entry → enter
       Exit: RSI-4h > rsi_exit OR ATR trailing"""
    H.CACHE=cache
    bars4h=H.load_tf(H.H4); bars1h=H.load_tf(3600*1000); bars1d=H.load_tf(86400*1000)
    n=len(bars4h); c4=[b["close"] for b in bars4h]
    atr4=H.atr_series(bars4h); adx4=H.adx_wilder(bars4h,period=12)
    e200_1h=H.ema_s([b["close"] for b in bars1h],200); h1t=[b["time"] for b in bars1h]
    regime_1d=H.regime_with_persistence(bars1d)
    reg_map={b["time"]//86400000:regime_1d[i] for i,b in enumerate(bars1d)}
    def get_reg(ts): return reg_map.get(ts//86400000,"RANGE")
    def e200_1h_at(ts):
        lo,hi,idx=0,len(h1t)-1,0
        while lo<=hi:
            m=(lo+hi)//2
            if h1t[m]<=ts: idx=m; lo=m+1
            else: hi=m-1
        return e200_1h[idx]
    # RSI calculation
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
    rsi4=rsi_series(c4, rsi_lb)
    FEE=H.FEE; CD=36
    mo=defaultdict(float); last_entry=0
    for i in range(250, n-max_hold):
        if rsi4[i] is None or adx4[i] is None: continue
        if rsi4[i]>=rsi_entry: continue  # waiting for dip
        if adx4[i]<=adx_thresh: continue  # no trend
        if i-last_entry<CD: continue  # cooldown
        e1h=e200_1h_at(bars4h[i]["time"])
        if e1h is None or c4[i]<e1h: continue  # below 1h EMA200
        if get_reg(bars4h[i]["time"])!="RANGE": continue
        # also require ADX was >thresh on prev bar (sticky)
        if i<1 or adx4[i-1] is None or adx4[i-1]<=adx_thresh: continue
        # entry
        ep=c4[i]; ae=atr4[i]
        if ae is None or ae<=0: continue
        sl_=ep-ae*sl_init; hwm=ep
        for h in range(1,max_hold+1):
            j=i+h
            if j>=n: break
            # check RSI exit
            if rsi4[j] is not None and rsi4[j]>=rsi_exit:
                ret=(c4[j]-ep)/ep-2*FEE; mo[mo_str(bars4h[j]["time"])]+=ret
                last_entry=i; break
            mult=sl_init if h<sl_trans else sl_trail
            if c4[j]>hwm: hwm=c4[j]; sl_=hwm-ae*mult
            elif h>=sl_trans:
                t=hwm-ae*sl_trail
                if t>sl_: sl_=t
            if bars4h[j]["low"]<=sl_:
                ret=(sl_-ep)/ep-2*FEE; mo[mo_str(bars4h[j]["time"])]+=ret
                last_entry=i; break
        else:
            j=min(i+max_hold,n-1); mo[mo_str(bars4h[j]["time"])]+=(c4[j]-ep)/ep-2*FEE
            last_entry=i
    return mo

# ─── EMA50-4h pullback entry ───
def run_ema_pullback(cache, adx_thresh=18, ema_period=50, sl_init=3.0, sl_trail=3.5,
                     sl_trans=16, max_hold=200, max_dev=0.5):
    """Enter khi giá dip về EMA50-4h (trong vòng max_dev×ATR từ EMA50) trong RANGE+trend up"""
    H.CACHE=cache
    bars4h=H.load_tf(H.H4); bars1h=H.load_tf(3600*1000); bars1d=H.load_tf(86400*1000)
    n=len(bars4h); c4=[b["close"] for b in bars4h]
    atr4=H.atr_series(bars4h); adx4=H.adx_wilder(bars4h,period=12)
    e50_4h=H.ema_s(c4,ema_period)
    e200_1h=H.ema_s([b["close"] for b in bars1h],200); h1t=[b["time"] for b in bars1h]
    regime_1d=H.regime_with_persistence(bars1d)
    reg_map={b["time"]//86400000:regime_1d[i] for i,b in enumerate(bars1d)}
    def get_reg(ts): return reg_map.get(ts//86400000,"RANGE")
    def e200_1h_at(ts):
        lo,hi,idx=0,len(h1t)-1,0
        while lo<=hi:
            m=(lo+hi)//2
            if h1t[m]<=ts: idx=m; lo=m+1
            else: hi=m-1
        return e200_1h[idx]
    FEE=H.FEE; CD=24
    mo=defaultdict(float); last_entry=0
    for i in range(250, n-max_hold):
        if e50_4h[i] is None or atr4[i] is None or adx4[i] is None: continue
        if adx4[i]<=adx_thresh: continue
        if i<1 or adx4[i-1] is None or adx4[i-1]<=adx_thresh: continue  # sticky
        if i-last_entry<CD: continue
        e1h=e200_1h_at(bars4h[i]["time"])
        if e1h is None or c4[i]<e1h: continue  # below EMA200-1h
        if get_reg(bars4h[i]["time"])!="RANGE": continue
        # price near EMA50-4h: within max_dev×ATR above EMA50
        dist=c4[i]-e50_4h[i]
        if dist<0 or dist>max_dev*atr4[i]: continue  # too far from EMA50 or below it
        # entry at close
        ep=c4[i]; ae=atr4[i]
        if ae<=0: continue
        sl_=ep-ae*sl_init; hwm=ep
        for h in range(1,max_hold+1):
            j=i+h
            if j>=n: break
            mult=sl_init if h<sl_trans else sl_trail
            if c4[j]>hwm: hwm=c4[j]; sl_=hwm-ae*mult
            elif h>=sl_trans:
                t=hwm-ae*sl_trail
                if t>sl_: sl_=t
            if bars4h[j]["low"]<=sl_:
                ret=(sl_-ep)/ep-2*FEE; mo[mo_str(bars4h[j]["time"])]+=ret
                last_entry=i; break
        else:
            j=min(i+max_hold,n-1); mo[mo_str(bars4h[j]["time"])]+=(c4[j]-ep)/ep-2*FEE
            last_entry=i
    return mo

# ─── Portfolio stats ───
def load_baselines():
    moB,_,_=run_h01(f"{CC}/binance-5m-7y.json",18)
    moS,_,_=run_h01(f"{CC}/binance-sol-5m-3y.json",15)
    turB=run_turtle(20,15,2.0,True)
    _,_,spanS=H.CACHE, None, None
    H.CACHE=f"{CC}/binance-sol-5m-3y.json"
    bars_s=H.load_tf(H.H4); span_s=(bars_s[0]["time"],bars_s[-1]["time"])
    H.CACHE=f"{CC}/binance-5m-7y.json"
    bars_b=H.load_tf(H.H4); span_b=(bars_b[0]["time"],bars_b[-1]["time"])
    cal3=months_between(span_s[0],span_s[1])
    cal7=months_between(span_b[0],span_b[1])
    return moB, moS, turB, cal3, cal7

print("Loading baselines (R50 winner config)...")
moB_base, moS_base, turB, cal3, cal7 = load_baselines()
sB=[moB_base.get(m,0.0) for m in cal3]
sS=[moS_base.get(m,0.0) for m in cal3]
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

def pr(label, parts, weights=None):
    sh,md,fl,te,py=bk(parts,weights)
    ok=sh>=2.10 and md<=10; mark="✅" if ok else ("⚠️" if sh>=2.00 else "")
    print(f"  {mark} {label:<50} Sh{sh:>+5.2f} DD{md:>4.1f}% flat{fl:>3}/35 TE{te:>+5.2f} | {py}")
    return sh,md,fl,te

# BASELINE (R50 winner)
sh_base=pr("BASELINE R50: BTC+SOL+Turtle(DE20/DX15/CUT2)",[sB,sS,sTB])[0]

print(f"\n{'='*100}")
print("=== R51: Entry Timing Optimization ===\n")

# ─── A/B/C: Limit-order dip entry for BTC ───
print("━"*100)
print("A/B/C: Limit-order dip entry — BTC (dip×ATR before entering)")
print(f"  {'Variant':<52} {'Sh':>6} {'DD':>5} {'flat':>5} {'TE':>7} | per-year")
print("  "+"-"*85)

for dip, win, label in [
    (0.0, 0, "BASELINE market entry"),
    (0.3, 4, "limit −0.3×ATR window=4bars"),
    (0.5, 4, "limit −0.5×ATR window=4bars"),
    (0.5, 6, "limit −0.5×ATR window=6bars"),
    (0.5, 8, "limit −0.5×ATR window=8bars"),
    (1.0, 4, "limit −1.0×ATR window=4bars"),
    (1.0, 8, "limit −1.0×ATR window=8bars"),
    (1.0, 12,"limit −1.0×ATR window=12bars"),
    (1.5, 6, "limit −1.5×ATR window=6bars"),
    (1.5, 12,"limit −1.5×ATR window=12bars"),
]:
    moB_,filled,skipped=run_h01(f"{CC}/binance-5m-7y.json",18,entry_dip=dip,entry_window=win)
    sB_=[moB_.get(m,0.0) for m in cal3]
    sh,md,fl,te,py=bk([sB_,sS,sTB])
    delta=sh-sh_base
    mark="★★" if sh>=2.15 else ("★" if delta>0.05 else "")
    fill_info=f"fill={filled},skip={skipped}" if dip>0 else ""
    print(f"  {label:<52} Sh{sh:>+5.2f} DD{md:>4.1f}% flat{fl:>3}/35 TE{te:>+5.2f} delta{delta:>+5.2f} {mark} {fill_info}")

# ─── D: RSI-dip 1h entry (BTC replacement) ───
print(f"\n{'━'*100}")
print("D: RSI-dip 4h entry (replace BTC hedge01 entry with RSI<35 dip scan)")
for rsi_e, rsi_x in [(35,75),(35,70),(30,75),(30,70),(40,75),(40,70)]:
    moRSI=run_rsi_dip(f"{CC}/binance-5m-7y.json",18,rsi_entry=rsi_e,rsi_exit=rsi_x)
    sRSI=[moRSI.get(m,0.0) for m in cal3]
    n_rsi=sum(1 for v in moRSI.values() if abs(v)>1e-9)
    sh,md,fl,te,py=bk([sRSI,sS,sTB])
    delta=sh-sh_base
    mark="★★" if sh>=2.15 else ("★" if delta>0.05 else "")
    print(f"  RSI-entry<{rsi_e} RSI-exit>{rsi_x}: Sh{sh:>+5.2f} DD{md:>4.1f}% flat{fl:>3} TE{te:>+5.2f} delta{delta:>+5.2f} trades≈{n_rsi} {mark}")

# ─── E: EMA50-4h pullback entry ───
print(f"\n{'━'*100}")
print("E: EMA50-4h pullback entry (enter khi giá ≤0.5×ATR phía trên EMA50-4h)")
for dev, ema_p in [(0.3,50),(0.5,50),(0.7,50),(1.0,50),(0.5,21),(0.5,100)]:
    moEMA=run_ema_pullback(f"{CC}/binance-5m-7y.json",18,ema_period=ema_p,max_dev=dev)
    sEMA=[moEMA.get(m,0.0) for m in cal3]
    n_ema=sum(1 for v in moEMA.values() if abs(v)>1e-9)
    sh,md,fl,te,py=bk([sEMA,sS,sTB])
    delta=sh-sh_base
    mark="★★" if sh>=2.15 else ("★" if delta>0.05 else "")
    print(f"  EMA{ema_p} dev≤{dev}×ATR: Sh{sh:>+5.2f} DD{md:>4.1f}% flat{fl:>3} TE{te:>+5.2f} delta{delta:>+5.2f} trades≈{n_ema} {mark}")

# ─── F: Kết hợp best dip-entry + RSI (nếu có winner) ───
print(f"\n{'━'*100}")
print("F: Kết hợp — Limit-entry BTC + Limit-entry SOL cùng dip")
for dip, win in [(0.5,6),(1.0,8),(0.5,4)]:
    moB_,_,_=run_h01(f"{CC}/binance-5m-7y.json",18,entry_dip=dip,entry_window=win)
    moS_,_,_=run_h01(f"{CC}/binance-sol-5m-3y.json",15,entry_dip=dip,entry_window=win)
    sB_=[moB_.get(m,0.0) for m in cal3]; sS_=[moS_.get(m,0.0) for m in cal3]
    sh,md,fl,te,py=bk([sB_,sS_,sTB])
    delta=sh-sh_base
    mark="★★" if sh>=2.15 else ("★" if delta>0.05 else "")
    print(f"  dip={dip}×ATR win={win}: Sh{sh:>+5.2f} DD{md:>4.1f}% flat{fl:>3} TE{te:>+5.2f} delta{delta:>+5.2f} | {py} {mark}")

print(f"\n{'='*100}")
print("R51 SUMMARY")
print(f"  Baseline (R50): Sh{sh_base:+.3f}")
print("  → Xem winner nào phá được Sh+2.06 baseline")
print("  → Next R52: Exit timing optimization (RSI-exit / DI-crossover exit)")
