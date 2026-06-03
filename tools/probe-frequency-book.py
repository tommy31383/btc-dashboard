#!/usr/bin/env python3
"""probe-frequency-book.py — Tăng frequency của 3-way book mà KHÔNG thêm token mới.
Baseline: hedge01-BTC + hedge01-SOL + turtle-BTC (11 tháng flat / 35 tháng)
Probe các hướng:
  V1: Thêm turtle-SOL sleeve (4-way book)
  V2: hedge01 RANGE+BULL (bỏ skip-BULL, giữ skip-BEAR)
  V3: Giảm ATR_PCT_PCTL 50→30 (nới vol filter)
  V4: Giảm cooldown S12/S14 36→20
  V5: Bỏ vol_pass cho S14 Donchian
  V6: Combo tốt nhất
  V7: hedge01 RANGE+BULL + turtle-SOL (V1+V2)
Mỗi variant: monthly table, Sharpe, DD, flat-months count.
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

# ─── BASELINE DATA ───
moB,_,_,spanB=run_h01(f"{CC}/binance-5m-7y.json", skip_cal=False)
moS,_,_,spanS=run_h01(f"{CC}/binance-sol-5m-3y.json", skip_cal=False)
turB=dict(C.tur_mo)
cal=months_between(spanS[0],spanS[1])
sB=[moB.get(m,0.0) for m in cal]
sS=[moS.get(m,0.0) for m in cal]
sTB=[turB.get(m,0.0) for m in cal]

# ─── TURTLE ON SOL ───
def run_turtle_sol():
    """Port turtle harness sang SOL data."""
    raw=json.load(open(f"{CC}/binance-sol-5m-3y.json"))
    H4=4*3600*1000; D=86400*1000
    bk={}
    for c in raw:
        k=c["time"]//H4
        if k not in bk: bk[k]={"time":k*H4,"high":c["high"],"low":c["low"],"close":c["close"],"volume":c["volume"]}
        else: o=bk[k]; o["high"]=max(o["high"],c["high"]); o["low"]=min(o["low"],c["low"]); o["close"]=c["close"]; o["volume"]+=c["volume"]
    bars4h=[bk[k] for k in sorted(bk)]
    # daily for regime
    dk={}
    for c in raw:
        k=c["time"]//D
        if k not in dk: dk[k]={"time":k*D,"high":c["high"],"low":c["low"],"close":c["close"],"volume":c["volume"]}
        else: o=dk[k]; o["high"]=max(o["high"],c["high"]); o["low"]=min(o["low"],c["low"]); o["close"]=c["close"]; o["volume"]+=c["volume"]
    bars1d=[dk[k] for k in sorted(dk)]
    n=len(bars4h); c4=[b["close"] for b in bars4h]
    def atr_s(bars,p=14):
        tr=[0.0]*len(bars)
        for i in range(1,len(bars)):
            tr[i]=max(bars[i]["high"]-bars[i]["low"],abs(bars[i]["high"]-bars[i-1]["close"]),abs(bars[i]["low"]-bars[i-1]["close"]))
        atr=[None]*len(bars); s=sum(tr[1:p+1]); atr[p]=s/p
        for i in range(p+1,len(bars)): atr[i]=(atr[i-1]*(p-1)+tr[i])/p
        return atr
    atr4=atr_s(bars4h)
    regime_1d=H.regime_with_persistence(bars1d)
    reg_map={b["time"]//86400000:regime_1d[i] for i,b in enumerate(bars1d)}
    def get_reg(ts): return reg_map.get(ts//86400000,"RANGE")
    FAST=20; SLOW=10; ATR_CUT=1.5; SKIP_BEAR=True; FEE=0.05/100
    mo=defaultdict(float); trades=[]
    in_trade=False; ep=ae=sl=hwm=None
    for i in range(FAST,n):
        reg=get_reg(bars4h[i]["time"])
        if SKIP_BEAR and reg=="BEAR":
            if in_trade: mo[mo_str(bars4h[i]["time"])]+=(bars4h[i]["low"]-ep)/ep-2*FEE; in_trade=False
            continue
        if in_trade:
            if c4[i]>hwm: hwm=c4[i]; sl=hwm-ae*1.0
            t=hwm-ae*ATR_CUT
            if t>sl: sl=t
            if bars4h[i]["low"]<=sl:
                ret=(sl-ep)/ep-2*FEE; ts_exit=bars4h[i]["time"]
                mo[mo_str(ts_exit)]+=ret; trades.append(ret); in_trade=False
        if not in_trade:
            hi_fast=max(bars4h[j]["high"] for j in range(i-FAST,i))
            if c4[i]>hi_fast and atr4[i] is not None:
                in_trade=True; ep=c4[i]; ae=atr4[i]; sl=ep-ae*ATR_CUT; hwm=ep
    return mo

turS=dict(run_turtle_sol())
sTS=[turS.get(m,0.0) for m in cal]

# ─── hedge01 RANGE+BULL variant ───
def run_h01_bull(cache):
    """hedge01 mở RANGE+BULL (bỏ skip-BULL). Giữ skip-BEAR."""
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
        reg=get_reg(bars4h[i]["time"])
        return reg in ("RANGE","BULL")  # KEY: mở BULL
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
                t=hwm-ae*H.SL_TRAIL
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
    CD={"S12":36,"S13":1,"S14":36}
    mo=defaultdict(float); trades=[]; last={s:0 for s in sigs}
    for i in range(250,n-H.MAX_HOLD):
        for sn in ("S12","S13","S14"):
            if sigs[sn](i)!="LONG": continue
            if i-last[sn]<CD[sn]: continue
            if do_vol[sn] and not vol_pass(i): continue
            if not filt(i): continue
            r=sim(i)
            if r is None: continue
            ret,h=r; cts=bars4h[min(i+h,n-1)]["time"]
            mo[mo_str(cts)]+=ret; trades.append((ret,0,h)); last[sn]=i
    return mo

# ─── hedge01 với ATR_PCT_PCTL 30 (nới vol) ───
def run_h01_atr30(cache):
    """hedge01 với ATR_PCT_PCTL giảm 50→30 (nới volatile filter)."""
    orig=H.ATR_PCT_PCTL; H.ATR_PCT_PCTL=0.30
    mo,_,_,span=run_h01(cache,skip_cal=False)
    H.ATR_PCT_PCTL=orig
    return mo

# ─── hedge01 với cooldown giảm S12/S14 36→20 ───
def run_h01_cd20(cache):
    """hedge01 với S12/S14 cooldown 36→20."""
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
                t=hwm-ae*H.SL_TRAIL
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
    CD={"S12":20,"S13":1,"S14":20}  # KEY: giảm cooldown
    mo=defaultdict(float); trades=[]; last={s:0 for s in sigs}
    for i in range(250,n-H.MAX_HOLD):
        for sn in ("S12","S13","S14"):
            if sigs[sn](i)!="LONG": continue
            if i-last[sn]<CD[sn]: continue
            if do_vol[sn] and not vol_pass(i): continue
            if not filt(i): continue
            r=sim(i)
            if r is None: continue
            ret,h=r; cts=bars4h[min(i+h,n-1)]["time"]
            mo[mo_str(cts)]+=ret; trades.append((ret,0,h)); last[sn]=i
    return mo

# ─── STATS HELPER ───
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

def print_stats(label, parts, weights=None):
    sh,md,tot,flat,active,wins,py,p=stats(parts,weights)
    wr=wins/active*100 if active>0 else 0
    print(f"  {label:<38} Sh{sh:>+5.2f} DD{md:>5.1f}% TOT{tot:>+5.0f}% flat{flat:>3}/{len(cal)} WR{wr:>3.0f}% | {py}")
    return p

# ─── RUN ALL VARIANTS ───
print("="*90)
print("=== probe-frequency-book.py — Tăng frequency 3-way book (không thêm token) ===")
print(f"=== Calendar window: {cal[0]} → {cal[-1]} ({len(cal)} tháng) ===\n")

print("--- BASELINE (3 sleeve) ---")
print_stats("BASELINE BTC+SOL+turtleBTC", [sB,sS,sTB])

print("\n--- V1: Thêm turtle-SOL sleeve (4-way book) ---")
print(f"  Corr(turBTC,turSOL): {sum(a*b for a,b in zip(sTB,sTS))/len(sTB)/(sd(sTB)*sd(sTS) or 1e-9):.2f}")
print_stats("V1 BTC+SOL+turBTC+turSOL (equal)", [sB,sS,sTB,sTS])

print("\n--- V2: hedge01 RANGE+BULL (mở BULL entries) ---")
print("  Computing hedge01-BULL BTC...", end=" ", flush=True)
moBull=run_h01_bull(f"{CC}/binance-5m-7y.json"); sBull=[moBull.get(m,0.0) for m in cal]
print(f"done BTC")
print("  Computing hedge01-BULL SOL...", end=" ", flush=True)
moBullS=run_h01_bull(f"{CC}/binance-sol-5m-3y.json"); sBullS=[moBullS.get(m,0.0) for m in cal]
print(f"done SOL")
print_stats("V2 BTC-BULL+SOL-BULL+turBTC", [sBull,sBullS,sTB])
print_stats("  → vs hedge01 RANGE-only BTC delta", [sB])
print_stats("  → BTC-BULL alone", [sBull])
print_stats("  → SOL-BULL alone", [sBullS])

print("\n--- V3: ATR_PCT_PCTL 50→30 (nới volatile filter) ---")
print("  Computing ATR30 BTC...", end=" ", flush=True)
moA30B=run_h01_atr30(f"{CC}/binance-5m-7y.json"); sA30B=[moA30B.get(m,0.0) for m in cal]
print(f"done BTC")
print("  Computing ATR30 SOL...", end=" ", flush=True)
moA30S=run_h01_atr30(f"{CC}/binance-sol-5m-3y.json"); sA30S=[moA30S.get(m,0.0) for m in cal]
print(f"done SOL")
print_stats("V3 BTC-ATR30+SOL-ATR30+turBTC", [sA30B,sA30S,sTB])

print("\n--- V4: Cooldown S12/S14 giảm 36→20 ---")
print("  Computing CD20 BTC...", end=" ", flush=True)
moCD20B=run_h01_cd20(f"{CC}/binance-5m-7y.json"); sCD20B=[moCD20B.get(m,0.0) for m in cal]
print(f"done BTC")
print("  Computing CD20 SOL...", end=" ", flush=True)
moCD20S=run_h01_cd20(f"{CC}/binance-sol-5m-3y.json"); sCD20S=[moCD20S.get(m,0.0) for m in cal]
print(f"done SOL")
print_stats("V4 BTC-CD20+SOL-CD20+turBTC", [sCD20B,sCD20S,sTB])

print("\n--- V5: V1+V2 Combo: 4-way + RANGE+BULL ---")
print_stats("V5 BTC-BULL+SOL-BULL+turBTC+turSOL", [sBull,sBullS,sTB,sTS])

print("\n--- V6: V1+V3 Combo: 4-way + ATR30 ---")
print_stats("V6 BTC-ATR30+SOL-ATR30+turBTC+turSOL", [sA30B,sA30S,sTB,sTS])

print("\n--- V7: Risk-parity tốt nhất ---")
best=[sB,sS,sTB,sTS]
wrp=[1/sd(x) for x in best]
print_stats("V7 4-way RISK-PARITY (BTC+SOL+turBTC+turSOL)", best, wrp)

print("\n--- MONTHLY DETAIL: V1 vs BASELINE ---")
sh1,md1,tot1,fl1,act1,w1,py1,p1=stats([sB,sS,sTB,sTS])
sh0,md0,tot0,fl0,act0,w0,py0,p0=stats([sB,sS,sTB])
print(f"  {'Tháng':>8} | {'BAS':>7} | {'V1-4way':>7} | {'DIFF':>7}")
print("  "+"-"*42)
for i,m in enumerate(cal):
    d=p1[i]-p0[i]
    mark=" ← flat→active" if abs(p0[i])<1e-9 and abs(p1[i])>1e-9 else ""
    if abs(p1[i])>1e-9 or abs(p0[i])>1e-9:
        print(f"  {m:>8} | {p0[i]*100:>+6.1f} | {p1[i]*100:>+6.1f} | {d*100:>+6.1f}{mark}")
    else:
        print(f"  {m:>8} |       . |       . |      0")

print(f"\n  BASELINE: Sharpe {sh0:+.2f} DD{md0:.0f}% flat={fl0}/35")
print(f"  V1 4-way: Sharpe {sh1:+.2f} DD{md1:.0f}% flat={fl1}/35")
print(f"  Tháng flat giảm từ {fl0} → {fl1} (−{fl0-fl1} tháng)")
