#!/usr/bin/env python3
"""autoloop-r53-earlycut-newentry.py — Round 53: Early-cut optimization + new entry signals
R52 findings:
  - RSI/DI/ADX-peak exit: ALL WORSE — trailing stop IS best top-exit
  - Early-cut 24bars/0.5ATR: Sh+2.09 (marginal win, cut losers faster)
  - TP fixed 6×ATR: Sh+2.01 (below baseline)

R53 goals:
  A: Early-cut param sweep (bars=8-48, loss=0.3-1.5×ATR) → find best
  B: Apply best early-cut to SOL too
  C: NEW ENTRY SIGNAL — swing-low-bounce: trong RANGE+trend-up, sau dip ≥2×ATR, price bật lên → enter
  D: NEW ENTRY SIGNAL — 1h-breakout trong 4h-trend: dùng 1h bars cho signal, 4h cho filter → nhiều entry hơn
  E: NEW ENTRY SIGNAL — Bollinger squeeze breakout trên 4h

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

def run_h01_ec(cache, adx_thresh=18, sl_init=3.0, sl_trail=3.5, sl_trans=16,
               adx_period=12, atr_break_mult=1.3, vol_mult=1.4, vol_ma=10, max_hold=200,
               ec_bars=None, ec_loss=None):
    """ec_bars: early-cut bars, ec_loss: loss multiple of ATR to trigger cut"""
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
        return get_reg(bars4h[i]["time"])=="RANGE"
    def sim(ei):
        ep=c4[ei]; ae=atr4[ei]
        if ae is None or ae<=0: return None
        sl_=ep-ae*H.SL_INIT; hwm=ep
        for h in range(1,H.MAX_HOLD+1):
            j=ei+h
            if j>=n: break
            # early cut
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
    return mo, n_tr

# ─── Swing-low bounce entry ───
def run_swing_bounce(cache, adx_thresh=18, dip_mult=2.0, bounce_mult=0.5,
                     sl_init=3.0, sl_trail=3.5, sl_trans=16, max_hold=200, cd=24):
    """Trong RANGE+trend: sau dip ≥ dip_mult×ATR từ recent high, price bật lên bounce_mult×ATR → enter
       Idea: mua sau khi giá dip rõ ràng + bắt đầu phục hồi (gần đáy thật hơn)
    """
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
    FEE=H.FEE; mo=defaultdict(float); last_e=0
    for i in range(50, n-max_hold):
        if adx4[i] is None or atr4[i] is None: continue
        if adx4[i]<=adx_thresh: continue
        if i<1 or adx4[i-1] is None or adx4[i-1]<=adx_thresh: continue  # sticky ADX
        e1h=e200_1h_at(bars4h[i]["time"])
        if e1h is None or c4[i]<e1h: continue
        if get_reg(bars4h[i]["time"])!="RANGE": continue
        if i-last_e<cd: continue
        ae=atr4[i]
        # find recent high in last 10 bars
        rh=max(bars4h[j]["high"] for j in range(max(0,i-10),i+1))
        # check if current price dipped ≥ dip_mult×ATR from recent high
        if rh-c4[i]<dip_mult*ae: continue
        # check bounce: current close > previous close (price bắt đầu phục hồi)
        if i<1 or c4[i]<=c4[i-1]: continue
        # also: previous bar was lower (we're bouncing from low)
        prev_low=bars4h[i]["low"]; prev_bar_low=bars4h[i-1]["low"]
        if prev_low>prev_bar_low: continue  # didn't make new low recently
        # entry
        ep=c4[i]; sl_=ep-ae*sl_init; hwm=ep
        for h in range(1,max_hold+1):
            j=i+h
            if j>=n: break
            mult=sl_init if h<sl_trans else sl_trail
            if c4[j]>hwm: hwm=c4[j]; sl_=hwm-ae*mult
            elif h>=sl_trans:
                t=hwm-ae*sl_trail
                if t>sl_: sl_=t
            if bars4h[j]["low"]<=sl_:
                ret=(sl_-ep)/ep-2*FEE; mo[mo_str(bars4h[j]["time"])]+=ret; last_e=i; break
        else:
            j=min(i+max_hold,n-1); mo[mo_str(bars4h[j]["time"])]+=(c4[j]-ep)/ep-2*FEE; last_e=i
    return mo

# ─── 1h-breakout within 4h-trend (more frequent entries) ───
def run_1h_breakout(cache, adx_thresh4h=18, donchian_1h=10, sl_init=3.0, sl_trail=3.5,
                    sl_trans=48, max_hold=600, cd=6):
    """Signal: 1h Donchian breakout + 4h filter (ADX>thresh, EMA200, RANGE)
       Kỳ vọng: nhiều entry hơn 4h vì 1h có nhiều bar hơn, nhưng vẫn filter bằng 4h quality
    """
    H.CACHE=cache
    bars1h=H.load_tf(3600*1000); bars4h=H.load_tf(H.H4); bars1d=H.load_tf(86400*1000)
    n1=len(bars1h); c1=[b["close"] for b in bars1h]
    atr1=H.atr_series(bars1h); t1=[b["time"] for b in bars1h]
    # 4h derived values for filtering
    c4=[b["close"] for b in bars4h]; t4=[b["time"] for b in bars4h]
    adx4=H.adx_wilder(bars4h,period=12)
    e200_1h=H.ema_s(c1,200)
    regime_1d=H.regime_with_persistence(bars1d)
    reg_map={b["time"]//86400000:regime_1d[i] for i,b in enumerate(bars1d)}
    def get_reg(ts): return reg_map.get(ts//86400000,"RANGE")
    # map 1h bar → 4h ADX
    def get_adx4(ts):
        # find the 4h bar that contains this 1h ts
        k=ts//(H.H4); k4=next((j for j,b in enumerate(bars4h) if b["time"]//H.H4==k),None)
        if k4 is None: return None
        # use previous 4h bar's ADX (already closed)
        return adx4[k4-1] if k4>0 else None
    FEE=H.FEE; mo=defaultdict(float); last_e=0
    for i in range(donchian_1h+200, n1-max_hold):
        if atr1[i] is None or e200_1h[i] is None: continue
        if c1[i]<e200_1h[i]: continue  # below 1h EMA200
        if get_reg(bars1h[i]["time"])!="RANGE": continue
        if i-last_e<cd: continue  # cooldown
        adv4=get_adx4(bars1h[i]["time"])
        if adv4 is None or adv4<=adx_thresh4h: continue  # 4h ADX filter
        # 1h Donchian breakout
        hi=max(bars1h[j]["high"] for j in range(i-donchian_1h,i))
        if c1[i]<=hi: continue  # not a breakout
        # check volume
        if i<10: continue
        vol_ma=sum(bars1h[j]["volume"] for j in range(i-10,i))/10
        if bars1h[i]["volume"]<vol_ma*1.2: continue
        # entry
        ep=c1[i]; ae=atr1[i]
        if ae is None or ae<=0: continue
        sl_=ep-ae*sl_init; hwm=ep
        for h in range(1,max_hold+1):
            j=i+h
            if j>=n1: break
            mult=sl_init if h<sl_trans else sl_trail
            if c1[j]>hwm: hwm=c1[j]; sl_=hwm-ae*mult
            elif h>=sl_trans:
                t=hwm-ae*sl_trail
                if t>sl_: sl_=t
            if bars1h[j]["low"]<=sl_:
                ret=(sl_-ep)/ep-2*FEE; mo[mo_str(bars1h[j]["time"])]+=ret; last_e=i; break
        else:
            j=min(i+max_hold,n1-1); mo[mo_str(bars1h[j]["time"])]+=(c1[j]-ep)/ep-2*FEE; last_e=i
    return mo

# ─── Bollinger squeeze + breakout ───
def run_bb_squeeze(cache, adx_thresh=18, bb_period=20, bb_std=2.0,
                   squeeze_mult=0.8, sl_init=3.0, sl_trail=3.5, sl_trans=16, max_hold=200, cd=24):
    """Bollinger Band squeeze: bandwidth < squeeze_mult×recent_avg → signal compressed
       Breakout: price > upper BB AND ADX>thresh → enter
    """
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
    # Bollinger Bands
    def bb(closes, p, s):
        out=[]
        for i in range(len(closes)):
            if i<p-1: out.append((None,None,None)); continue
            sl_=closes[i-p+1:i+1]; mu=sum(sl_)/p
            std=(sum((x-mu)**2 for x in sl_)/p)**0.5
            out.append((mu-s*std, mu, mu+s*std))
        return out
    bb4=bb(c4,bb_period,bb_std)
    FEE=H.FEE; mo=defaultdict(float); last_e=0
    bw_window=50  # look back for avg bandwidth
    for i in range(bb_period+bw_window+1, n-max_hold):
        if bb4[i][0] is None or adx4[i] is None or atr4[i] is None: continue
        lb,mb,ub=bb4[i]; bw=ub-lb
        # avg bandwidth over last bw_window bars
        bws=[bb4[j][2]-bb4[j][0] for j in range(i-bw_window,i) if bb4[j][0] is not None]
        if len(bws)<bw_window//2: continue
        avg_bw=sum(bws)/len(bws)
        # squeeze: current BW < squeeze_mult × avg_bw (compression)
        prev_lb,prev_mb,prev_ub=bb4[i-1] if bb4[i-1][0] else (None,None,None)
        if prev_ub is None: continue
        was_squeeze=(prev_ub-prev_lb)<avg_bw*squeeze_mult
        if not was_squeeze: continue
        # breakout: current close > upper BB
        if c4[i]<=ub: continue
        if adx4[i]<=adx_thresh: continue
        if i<1 or adx4[i-1] is None or adx4[i-1]<=adx_thresh: continue
        e1h=e200_1h_at(bars4h[i]["time"])
        if e1h is None or c4[i]<e1h: continue
        if get_reg(bars4h[i]["time"])!="RANGE": continue
        if i-last_e<cd: continue
        # entry
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
                ret=(sl_-ep)/ep-2*FEE; mo[mo_str(bars4h[j]["time"])]+=ret; last_e=i; break
        else:
            j=min(i+max_hold,n-1); mo[mo_str(bars4h[j]["time"])]+=(c4[j]-ep)/ep-2*FEE; last_e=i
    return mo

# ─── Setup ───
print("Loading baselines...")
moB,_=run_h01_ec(f"{CC}/binance-5m-7y.json",18)
moS,_=run_h01_ec(f"{CC}/binance-sol-5m-3y.json",15)
turB=run_turtle()
H.CACHE=f"{CC}/binance-sol-5m-3y.json"; bs=H.load_tf(H.H4); span_s=(bs[0]["time"],bs[-1]["time"])
H.CACHE=f"{CC}/binance-5m-7y.json"; bb_=H.load_tf(H.H4); span_b=(bb_[0]["time"],bb_[-1]["time"])
cal3=months_between(span_s[0],span_s[1]); cal7=months_between(span_b[0],span_b[1])
sB=[moB.get(m,0.0) for m in cal3]; sS=[moS.get(m,0.0) for m in cal3]; sTB=[turB.get(m,0.0) for m in cal3]

def bk(parts, weights=None):
    k=len(parts); w=weights or [1]*k; sw=sum(w)
    p=[sum(w[j]*parts[j][i] for j in range(k))/sw for i in range(len(cal3))]
    yr=defaultdict(float)
    for i,m in enumerate(cal3): yr[int(m[:4])]+=p[i]
    sh=sharpe(p); md=maxdd(p); fl=sum(1 for x in p if abs(x)<1e-9)
    test_m=[m for m in cal3 if m[:4] in ("2025","2026")]
    sh_te=sharpe([p[cal3.index(m)] for m in test_m if m in cal3])
    n_pos=sum(1 for x in p if x>1e-9)
    py=" ".join(f"{y%100}:{yr[y]*100:+.0f}" for y in sorted(yr))
    return sh,md,fl,sh_te,n_pos,py

def pr(label, parts, weights=None, extra=""):
    sh,md,fl,te,n_pos,py=bk(parts,weights)
    delta=sh-sh_base if 'sh_base' in globals() else 0
    ok=sh>=2.10; mark="✅" if ok else ("⚠️" if sh>=2.00 else "")
    star="★★" if sh>=2.15 else ("★" if delta>0.05 else "")
    print(f"  {mark} {label:<54} Sh{sh:>+5.2f} DD{md:>4.1f}% flat{fl:>3} TE{te:>+5.2f} pos={n_pos} {star} {extra}")
    return sh

sh_base=pr("BASELINE R50",[sB,sS,sTB])

print(f"\n{'='*100}")
print("=== R53: Early-cut sweep + New entry signals ===\n")

# ─── A: Early-cut param sweep ───
print("━"*100)
print("A: Early-cut BTC — param sweep (bars × loss_ATR)")
print(f"  {'bars':>5} {'loss':>5} {'Sh':>7} {'delta':>7} | TE")
print("  "+"-"*55)
best_ec=None; best_ec_sh=sh_base
for bars_c in [8,12,16,20,24,32,48]:
    for loss_c in [0.3,0.5,0.8,1.0,1.5]:
        moB_,_=run_h01_ec(f"{CC}/binance-5m-7y.json",18,ec_bars=bars_c,ec_loss=loss_c)
        sB_=[moB_.get(m,0.0) for m in cal3]
        sh,md,fl,te,np_,py=bk([sB_,sS,sTB])
        delta=sh-sh_base
        star="★★" if sh>=2.15 else ("★" if delta>0.05 else "")
        print(f"  {bars_c:>5} {loss_c:>5.1f} {sh:>+7.3f} {delta:>+7.3f} | TE{te:>+5.2f} {star}")
        if sh>best_ec_sh and md<=10: best_ec_sh=sh; best_ec=(bars_c,loss_c)

# ─── B: Apply best early-cut to BTC+SOL ───
print(f"\n{'━'*100}")
print("B: Apply best early-cut to both BTC + SOL")
if best_ec:
    bars_b,loss_b=best_ec
    print(f"  Best early-cut: bars={bars_b}, loss={loss_b}×ATR → Sh{best_ec_sh:+.3f}")
    for (b_bars,b_loss,s_bars,s_loss) in [
        (bars_b,loss_b,bars_b,loss_b),
        (bars_b,loss_b,bars_b*2,loss_b),
        (bars_b,loss_b,None,None),
    ]:
        moB_,_=run_h01_ec(f"{CC}/binance-5m-7y.json",18,ec_bars=b_bars,ec_loss=b_loss)
        moS_,_=run_h01_ec(f"{CC}/binance-sol-5m-3y.json",15,ec_bars=s_bars,ec_loss=s_loss)
        sB_=[moB_.get(m,0.0) for m in cal3]; sS_=[moS_.get(m,0.0) for m in cal3]
        lbl=f"BTC ec={b_bars}/{b_loss} | SOL ec={s_bars}/{s_loss}"
        pr(lbl,[sB_,sS_,sTB])
else:
    print("  No early-cut winner found")

# ─── C: Swing-low bounce entry ───
print(f"\n{'━'*100}")
print("C: Swing-low bounce — ADD to portfolio (BTC+SOL+swing+turtle)")
for dip_m, bounce_m in [(1.5,0.3),(2.0,0.5),(2.5,0.5),(2.0,0.3),(3.0,0.5)]:
    moSW=run_swing_bounce(f"{CC}/binance-5m-7y.json",18,dip_mult=dip_m,bounce_mult=bounce_m)
    sSW=[moSW.get(m,0.0) for m in cal3]
    n_sw=sum(1 for v in moSW.values() if abs(v)>1e-9)
    sh,md,fl,te,np_,py=bk([sB,sS,sTB,sSW])
    delta=sh-sh_base; star="★★" if sh>=2.15 else ("★" if delta>0.05 else "")
    sh_sw=sharpe([moSW.get(m,0.0) for m in cal7])
    print(f"  dip≥{dip_m}×ATR bounce≥{bounce_m}×ATR: portfolio Sh{sh:>+5.2f} delta{delta:>+.3f} swing_alone Sh{sh_sw:+.2f} trades≈{n_sw} {star}")

# ─── D: 1h breakout within 4h trend (ADD to portfolio) ───
print(f"\n{'━'*100}")
print("D: 1h breakout (ADD as extra signal) — Donchian-1h + 4h-ADX filter")
for dc_1h in [6,10,15,20]:
    mo1h=run_1h_breakout(f"{CC}/binance-5m-7y.json",18,donchian_1h=dc_1h)
    s1h=[mo1h.get(m,0.0) for m in cal3]
    n_1h=sum(1 for v in mo1h.values() if abs(v)>1e-9)
    sh_1h_alone=sharpe([mo1h.get(m,0.0) for m in cal7])
    # ADD to portfolio
    sh_p,md_p,fl_p,te_p,np_p,py_p=bk([sB,sS,sTB,s1h])
    delta=sh_p-sh_base; star="★★" if sh_p>=2.15 else ("★" if delta>0.05 else "")
    print(f"  Donchian-1h={dc_1h}: portfolio Sh{sh_p:>+5.2f} delta{delta:>+.3f} 1h_alone Sh{sh_1h_alone:+.2f} trades≈{n_1h} {star}")

# ─── E: Bollinger squeeze + breakout ───
print(f"\n{'━'*100}")
print("E: Bollinger Band squeeze breakout (4h) — ADD to portfolio")
for bb_p,bb_s,sq_m in [(20,2.0,0.8),(20,1.5,0.8),(20,2.0,0.6),(15,2.0,0.8)]:
    moBB=run_bb_squeeze(f"{CC}/binance-5m-7y.json",18,bb_period=bb_p,bb_std=bb_s,squeeze_mult=sq_m)
    sBB=[moBB.get(m,0.0) for m in cal3]
    n_bb=sum(1 for v in moBB.values() if abs(v)>1e-9)
    sh_bb=sharpe([moBB.get(m,0.0) for m in cal7])
    sh_p,md_p,fl_p,te_p,np_p,py_p=bk([sB,sS,sTB,sBB])
    delta=sh_p-sh_base; star="★★" if sh_p>=2.15 else ("★" if delta>0.05 else "")
    print(f"  BB({bb_p},{bb_s}) sq≤{sq_m}×avg: portfolio Sh{sh_p:>+5.2f} delta{delta:>+.3f} bb_alone Sh{sh_bb:+.2f} trades≈{n_bb} {star}")

print(f"\n{'='*100}")
print("R53 SUMMARY")
print(f"  Baseline Sh{sh_base:+.3f}")
if best_ec:
    print(f"  Best early-cut: bars={best_ec[0]} loss={best_ec[1]}×ATR → Sh{best_ec_sh:+.3f}")
print("  Winners → R54: combine best, add new signal to portfolio")
print("  No winners → conclude: portfolio ceiling confirmed, focus forward-test")
