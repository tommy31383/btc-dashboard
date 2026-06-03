#!/usr/bin/env python3
"""probe-frequency-loop2.py — Loop 2: Deep dive sau loop 1.
Findings loop 1:
  V1 turtle-SOL: flat 11→7 nhưng Sharpe 1.49→0.96 (TurSOL drag performance)
  V3 ATR30: no effect (neutral)
  V4 CD20: Sh1.49→1.52 DD không đổi, flat 11→10 (marginal win)

Loop 2 probe:
  A1: turtle-SOL tune (FAST 20→10 nhanh hơn)
  A2: turtle-SOL tune (ATR_CUT 1.5→1.0 tighter)
  A3: turtle-SOL skip-BEAR=False
  A4: 4-way với turtle-SOL weight 0.5x (lighter)
  A5: 4-way với turtle-SOL weight 0.25x (very light)
  A6: V4+turSOL (CD20 + 4-way)
  A7: Nguyên nhân still-flat (regime map tháng flat)
"""
import importlib.util, datetime, math, os, sys, json
from collections import defaultdict

def imp(name, path):
    spec=importlib.util.spec_from_file_location(name,path); M=importlib.util.module_from_spec(spec)
    so=sys.stdout; sys.stdout=open(os.devnull,"w"); spec.loader.exec_module(M); sys.stdout=so; return M

T="/Users/lap16116/BTC_PC/btc-dashboard/tools/"
CC="/Users/lap16116/BTC_PC/btc-dashboard/.cache"
Hh=imp("Hh",T+"loop-hedge01-crossasset.py"); C=imp("C",T+"correlation-turtle-hedge01-7y.py")
H=imp("H",T+"backtest-bull-regime-reaudit-7y.py")
run_h01=Hh.run_hedge01

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

moB,_,_,spanB=run_h01(f"{CC}/binance-5m-7y.json",skip_cal=False)
moS,_,_,spanS=run_h01(f"{CC}/binance-sol-5m-3y.json",skip_cal=False)
turB=dict(C.tur_mo)
cal=months_between(spanS[0],spanS[1])
sB=[moB.get(m,0.0) for m in cal]
sS=[moS.get(m,0.0) for m in cal]
sTB=[turB.get(m,0.0) for m in cal]

def run_turtle_sol_params(fast=20,slow=10,atr_cut=1.5,skip_bear=True):
    raw=json.load(open(f"{CC}/binance-sol-5m-3y.json"))
    H4=4*3600*1000; D=86400*1000
    bk={}
    for c in raw:
        k=c["time"]//H4
        if k not in bk: bk[k]={"time":k*H4,"high":c["high"],"low":c["low"],"close":c["close"],"volume":c["volume"]}
        else: o=bk[k]; o["high"]=max(o["high"],c["high"]); o["low"]=min(o["low"],c["low"]); o["close"]=c["close"]; o["volume"]+=c["volume"]
    bars4h=[bk[k] for k in sorted(bk)]
    dk={}
    for c in raw:
        k=c["time"]//D
        if k not in dk: dk[k]={"time":k*D,"high":c["high"],"low":c["low"],"close":c["close"],"volume":c["volume"]}
        else: o=dk[k]; o["high"]=max(o["high"],c["high"]); o["low"]=min(o["low"],c["low"]); o["close"]=c["close"]; o["volume"]+=c["volume"]
    bars1d=[dk[k] for k in sorted(dk)]
    n=len(bars4h); c4=[b["close"] for b in bars4h]
    def atr_s(bars,p=14):
        tr=[0.0]*len(bars)
        for i in range(1,len(bars)): tr[i]=max(bars[i]["high"]-bars[i]["low"],abs(bars[i]["high"]-bars[i-1]["close"]),abs(bars[i]["low"]-bars[i-1]["close"]))
        atr=[None]*len(bars); s=sum(tr[1:p+1]); atr[p]=s/p
        for i in range(p+1,len(bars)): atr[i]=(atr[i-1]*(p-1)+tr[i])/p
        return atr
    atr4=atr_s(bars4h)
    regime_1d=H.regime_with_persistence(bars1d)
    reg_map={b["time"]//86400000:regime_1d[i] for i,b in enumerate(bars1d)}
    def get_reg(ts): return reg_map.get(ts//86400000,"RANGE")
    FEE=0.05/100
    mo=defaultdict(float); trades=[]
    in_trade=False; ep=ae=sl=hwm=None
    for i in range(fast,n):
        reg=get_reg(bars4h[i]["time"])
        if skip_bear and reg=="BEAR":
            if in_trade: mo[mo_str(bars4h[i]["time"])]+=(bars4h[i]["low"]-ep)/ep-2*FEE; in_trade=False
            continue
        if in_trade:
            if c4[i]>hwm: hwm=c4[i]; sl=hwm-ae*1.0
            t=hwm-ae*atr_cut
            if t>sl: sl=t
            if bars4h[i]["low"]<=sl:
                ret=(sl-ep)/ep-2*FEE; mo[mo_str(bars4h[i]["time"])]+=ret; trades.append(ret); in_trade=False
        if not in_trade:
            hi_fast=max(bars4h[j]["high"] for j in range(i-fast,i))
            if c4[i]>hi_fast and atr4[i] is not None:
                in_trade=True; ep=c4[i]; ae=atr4[i]; sl=ep-ae*atr_cut; hwm=ep
    return mo

def run_h01_cd20(cache):
    """hedge01 cooldown S12/S14 36→20."""
    H.CACHE=cache
    bars4h=H.load_tf(H.H4); bars1h=H.load_tf(3600*1000); bars1d=H.load_tf(86400*1000)
    n=len(bars4h); c4=[b["close"] for b in bars4h]
    e50=H.ema_s(c4,H.EMA_FAST); e200=H.ema_s(c4,H.EMA_SLOW)
    atr4=H.atr_series(bars4h); adx4=H.adx_wilder(bars4h)
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
        sl=ep-ae*H.SL_INIT; hwm=ep
        for h in range(1,H.MAX_HOLD+1):
            j=ei+h
            if j>=n: break
            mult=H.SL_INIT if h<H.SL_TRANS else H.SL_TRAIL
            if c4[j]>hwm: hwm=c4[j]; sl=hwm-ae*mult
            elif h>=H.SL_TRANS:
                t=hwm-ae*H.SL_TRAIL;
                if t>sl: sl=t
            if bars4h[j]["low"]<=sl: return (sl-ep)/ep-2*H.FEE,h
        j=min(ei+H.MAX_HOLD,n-1); return (c4[j]-ep)/ep-2*H.FEE,H.MAX_HOLD
    def sig_s12(i):
        if None in (e50[i],e200[i]) or i<1 or None in (e50[i-1],e200[i-1]): return None
        return "LONG" if e50[i-1]<=e200[i-1] and e50[i]>e200[i] else None
    def sig_s13(i):
        if atr4[i] is None or i<1: return None
        return "LONG" if c4[i]>bars4h[i-1]["close"]+atr4[i]*H.ATR_BREAK_MULT else None
    def sig_s14(i):
        if i<H.DONCHIAN_LB: return None
        hi=max(bars4h[j]["high"] for j in range(i-H.DONCHIAN_LB,i))
        return "LONG" if c4[i]>hi else None
    sigs={"S12":sig_s12,"S13":sig_s13,"S14":sig_s14}; do_vol={"S12":False,"S13":True,"S14":True}
    CD={"S12":20,"S13":1,"S14":20}
    mo=defaultdict(float); last={s:0 for s in sigs}
    for i in range(250,n-H.MAX_HOLD):
        for sn in ("S12","S13","S14"):
            if sigs[sn](i)!="LONG": continue
            if i-last[sn]<CD[sn]: continue
            if do_vol[sn] and not vol_pass(i): continue
            if not filt(i): continue
            r=sim(i)
            if r is None: continue
            ret,h=r; cts=bars4h[min(i+h,n-1)]["time"]
            mo[mo_str(cts)]+=ret; last[sn]=i
    return mo

def stats(parts, weights=None):
    k=len(parts); w=weights or [1]*k; sw=sum(w)
    p=[sum(w[j]*parts[j][i] for j in range(k))/sw for i in range(len(cal))]
    yr=defaultdict(float)
    for i,m in enumerate(cal): yr[int(m[:4])]+=p[i]
    sh=sharpe(p); md=maxdd(p); tot=sum(p)*100
    flat=sum(1 for x in p if abs(x)<1e-9)
    active=sum(1 for x in p if abs(x)>1e-9)
    wins=sum(1 for x in p if x>1e-9)
    py=" ".join(f"{y%100}:{yr[y]*100:+.0f}" for y in sorted(yr))
    return sh,md,tot,flat,active,wins,py,p

def ps(label, parts, weights=None):
    sh,md,tot,flat,act,w,py,p=stats(parts,weights)
    wr=w/act*100 if act>0 else 0
    print(f"  {label:<42} Sh{sh:>+5.2f} DD{md:>5.1f}% TOT{tot:>+5.0f}% flat{flat:>3}/35 WR{wr:>3.0f}% | {py}")
    return p,sh,md,tot,flat

print("="*95)
print("=== Loop 2: Turtle-SOL tuning + combo variants ===\n")

print("--- BASELINE ---")
ps("BAS: BTC+SOL+turBTC (3-way)",[sB,sS,sTB])

# ─── A1: Turtle-SOL FAST=10 (nhanh hơn) ───
print("\n--- A: Turtle-SOL param variants ---")
for fast,slow,cut,skb,label in [
    (20,10,1.5,True,"turSOL baseline (F20/S10/cut1.5/skipBEAR)"),
    (10,5,1.5,True,"turSOL FAST F10/S5/cut1.5"),
    (20,10,1.0,True,"turSOL tighter cut1.0"),
    (20,10,2.0,True,"turSOL wider cut2.0"),
    (20,10,1.5,False,"turSOL no-skipBEAR"),
    (10,5,1.0,True,"turSOL F10 cut1.0"),
]:
    mo=run_turtle_sol_params(fast,slow,cut,skb)
    ts=[mo.get(m,0.0) for m in cal]
    p,sh,md,tot,fl=ps(f"  {label}",[[x for x in ts]])
    # corr with turBTC
    c=sum(a*b for a,b in zip(sTB,ts))/(len(sTB)*(sd(sTB)*sd(ts) or 1e-9))
    trades_count=sum(1 for v in mo.values() if abs(v)>1e-9)
    print(f"    → corr(turBTC,turSOL)={c:+.2f} | trades≈{trades_count}")

# Pick best turSOL for 4-way
print("\n--- B: 4-way book with best turSOL variants ---")
moTS_f10=run_turtle_sol_params(10,5,1.5,True)
sTS_f10=[moTS_f10.get(m,0.0) for m in cal]
moTS_nb=run_turtle_sol_params(20,10,1.5,False)
sTS_nb=[moTS_nb.get(m,0.0) for m in cal]
moTS_def=run_turtle_sol_params(20,10,1.5,True)
sTS_def=[moTS_def.get(m,0.0) for m in cal]

ps("B1 BTC+SOL+turBTC+turSOL-F10 (equal)",[sB,sS,sTB,sTS_f10])
ps("B2 BTC+SOL+turBTC+turSOL-noBEAR (equal)",[sB,sS,sTB,sTS_nb])

# Weight variants: turSOL 0.5x, 0.25x
print("\n--- C: Asymmetric weights turSOL ---")
# [BTC, SOL, turBTC, turSOL] weights
ps("C1 equal(1,1,1,1)",[sB,sS,sTB,sTS_def],[1,1,1,1])
ps("C2 turSOL 0.5x (1,1,1,0.5)",[sB,sS,sTB,sTS_def],[1,1,1,0.5])
ps("C3 turSOL 0.25x (1,1,1,0.25)",[sB,sS,sTB,sTS_def],[1,1,1,0.25])
ps("C4 turSOL F10 0.5x",[sB,sS,sTB,sTS_f10],[1,1,1,0.5])
ps("C5 turSOL F10 0.25x",[sB,sS,sTB,sTS_f10],[1,1,1,0.25])

# ─── D: V4 CD20 combo ───
print("\n--- D: CD20 + 4-way ---")
moCD20B=run_h01_cd20(f"{CC}/binance-5m-7y.json"); sCD20B=[moCD20B.get(m,0.0) for m in cal]
moCD20S=run_h01_cd20(f"{CC}/binance-sol-5m-3y.json"); sCD20S=[moCD20S.get(m,0.0) for m in cal]
ps("D1 CD20 BTC+SOL+turBTC (3-way)",[sCD20B,sCD20S,sTB])
ps("D2 CD20 BTC+SOL+turBTC+turSOL (4-way)",[sCD20B,sCD20S,sTB,sTS_def])
ps("D3 CD20+turSOL-F10 (4-way)",[sCD20B,sCD20S,sTB,sTS_f10])
ps("D4 CD20+turSOL-F10 0.25x",[sCD20B,sCD20S,sTB,sTS_f10],[1,1,1,0.25])

# ─── E: Regime diagnosis — tháng still-flat ───
print("\n--- E: Tháng still-flat sau V1 (4-way default) ---")
_,_,_,_,_,_,_,p4=stats([sB,sS,sTB,sTS_def])
still_flat=[cal[i] for i in range(len(cal)) if abs(p4[i])<1e-9]
print(f"  Still flat (7): {still_flat}")

# Regime check từng tháng flat
print("\n  Regime BTC cho từng tháng flat:")
raw_btc=json.load(open(f"{CC}/binance-5m-7y.json"))
D=86400*1000
dk={}
for c in raw_btc:
    k=c["time"]//D
    if k not in dk: dk[k]={"time":k*D,"high":c["high"],"low":c["low"],"close":c["close"],"volume":c["volume"]}
    else: o=dk[k]; o["high"]=max(o["high"],c["high"]); o["low"]=min(o["low"],c["low"]); o["close"]=c["close"]; o["volume"]+=c["volume"]
bars1d_btc=[dk[k] for k in sorted(dk)]
regime_btc=H.regime_with_persistence(bars1d_btc)
reg_map_btc={bars1d_btc[i]["time"]//86400000:regime_btc[i] for i in range(len(bars1d_btc))}
def get_regime_month(ym):
    # Lấy regime giữa tháng
    y,m=int(ym[:4]),int(ym[5:7])
    mid_day=datetime.datetime(y,m,15).timestamp()*1000
    return reg_map_btc.get(int(mid_day)//86400000,"?")

for m in still_flat:
    reg=get_regime_month(m)
    btc_mo=moB.get(m,0.0); sol_mo=moS.get(m,0.0)
    tb_mo=turB.get(m,0.0); ts_mo=moTS_def.get(m,0.0)
    print(f"  {m}: BTC-regime={reg} | h01BTC={btc_mo*100:+.1f}% SOL={sol_mo*100:+.1f}% turBTC={tb_mo*100:+.1f}% turSOL={ts_mo*100:+.1f}%")

print("\n--- SUMMARY ---")
print("  BASELINE Sh1.49 DD11% flat=11/35")
ps("BEST-V4 CD20 3-way",[sCD20B,sCD20S,sTB])
ps("4-way default equal",[sB,sS,sTB,sTS_def])
ps("C5 4-way turSOL-F10 0.25x",[sB,sS,sTB,sTS_f10],[1,1,1,0.25])
ps("D4 CD20 4-way turSOL-F10 0.25x",[sCD20B,sCD20S,sTB,sTS_f10],[1,1,1,0.25])
