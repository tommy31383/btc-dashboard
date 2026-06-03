#!/usr/bin/env python3
"""
general-rule-backtest.py — General Rule: target ≥50 entry/yr, ROI>50%/yr, stable 2019-2026.

KPI:
  - n_entry/year >= 50
  - ROI/year > 50% (on $100k capital, leverage 5x → notional $500k position)
  - Stable: ≥6/8 years both KPIs met

Approach multi-signal:
  G1: ADX momentum dip-buy (4h):
    LONG: ADX>20 + DI+>DI- (uptrend) + RSI dip 30-50 (pullback) + price > EMA200
         + funding < 0.03% (not crowded) + ATR stop 2×
    SHORT: ADX>20 + DI->DI+ + RSI bounce 50-70 + price < EMA200
           + funding < -0.01% (crowded shorts) + ATR stop 2×

  G2: Donchian momentum (1d) + funding gate:
    LONG: 10-day high breakout + ADX>18 + funding<0.03%
    Exit: 5-day low OR ATR×2

Capital: $100k, each trade = $10k notional ($2k equity at 5× leverage).
ROI = net PnL / $100k per year.
"""
import json, datetime, statistics, sys
from collections import defaultdict

CACHE_5M   = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
CACHE_FUND = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-funding-7y.json"

CAPITAL    = 100_000   # $100k
TRADE_NOTIONAL = 10_000  # $10k per trade notional (5× leverage = $2k equity)
LEV        = 5
ATR_SL     = 2.0       # SL = 2×ATR from entry
MAX_HOLD_4H = 60       # 10 days max hold
FEE_RT     = 0.0006    # 0.06% round-trip

print("Loading data...")
raw5m = json.load(open(CACHE_5M)); raw5m.sort(key=lambda x:x["time"])
rf    = json.load(open(CACHE_FUND))
s=rf[0]; tk=[k for k in s if "time" in k.lower()][0]; rk=[k for k in s if k in ("fundingRate","rate","r","funding")][0]
fund_entries=sorted([(int(e[tk]),float(e[rk])) for e in rf])
ft=[e[0] for e in fund_entries]
print(f"  5m:{len(raw5m):,}  funding:{len(fund_entries)}")

def build(ms):
    b={}
    for c in raw5m:
        k=c["time"]//ms
        if k not in b: b[k]={"time":k*ms,"open":c["open"],"close":c["close"],"high":c["high"],"low":c["low"],"volume":c["volume"]}
        else: o=b[k]; o["high"]=max(o["high"],c["high"]); o["low"]=min(o["low"],c["low"]); o["close"]=c["close"]; o["volume"]+=c["volume"]
    return [b[k] for k in sorted(b)]

bars4h=build(4*3600*1000); bars1d=build(24*3600*1000)
c4=[b["close"] for b in bars4h]; h4=[b["high"] for b in bars4h]; l4=[b["low"] for b in bars4h]
c1d=[b["close"] for b in bars1d]; h1d=[b["high"] for b in bars1d]; l1d=[b["low"] for b in bars1d]
print(f"  4h:{len(bars4h)} 1d:{len(bars1d)}")

import bisect
def fund_at(t):
    j=bisect.bisect_right(ft,t)-1
    return fund_entries[j][1] if j>=0 else 0

def ema_s(xs,p):
    k=2/(p+1); out=[None]*len(xs); e=None
    for i,x in enumerate(xs): e=x if e is None else x*k+e*(1-k); out[i]=e
    return out

def rsi_s(xs,p=14):
    n=len(xs); out=[None]*n
    if n<=p: return out
    ag=al=0
    for i in range(1,p+1): d=xs[i]-xs[i-1]; ag+=max(d,0); al+=max(-d,0)
    ag/=p; al/=p; out[p]=100-100/(1+ag/al) if al>0 else 100
    for i in range(p+1,n):
        d=xs[i]-xs[i-1]; ag=(ag*(p-1)+max(d,0))/p; al=(al*(p-1)+max(-d,0))/p
        out[i]=100-100/(1+ag/al) if al>0 else 100
    return out

def atr_s(bars,p=14):
    n=len(bars); out=[None]*n
    trs=[max(bars[i]["high"]-bars[i]["low"],abs(bars[i]["high"]-bars[i-1]["close"]),abs(bars[i]["low"]-bars[i-1]["close"])) for i in range(1,n)]
    if len(trs)<p: return out
    a=sum(trs[:p])/p; out[p]=a
    for i in range(p,len(trs)): a=(a*(p-1)+trs[i])/p; out[i+1]=a
    return out

def adx_di_s(bars,p=14):
    n=len(bars); adx_o=[None]*n; pdi_o=[None]*n; mdi_o=[None]*n
    if n<p*3: return adx_o,pdi_o,mdi_o
    tr=[]; pdm=[]; mdm=[]
    for i in range(1,n):
        h,l,pc=bars[i]["high"],bars[i]["low"],bars[i-1]["close"]
        tr.append(max(h-l,abs(h-pc),abs(l-pc)))
        up=h-bars[i-1]["high"]; dn=bars[i-1]["low"]-l
        pdm.append(up if up>dn and up>0 else 0); mdm.append(dn if dn>up and dn>0 else 0)
    def sm(xs):
        out=[None]*len(xs)
        if len(xs)<p: return out
        s=sum(xs[:p]); out[p-1]=s
        for i in range(p,len(xs)): out[i]=out[i-1]-out[i-1]/p+xs[i]
        return out
    atr=sm(tr); ps=sm(pdm); ms2=sm(mdm); dx=[None]*len(tr); pl=[None]*len(tr); ml=[None]*len(tr)
    for i in range(p-1,len(tr)):
        if atr[i] and atr[i]>0:
            pdi=100*ps[i]/atr[i]; mdi=100*ms2[i]/atr[i]; pl[i]=pdi; ml[i]=mdi
            dx[i]=100*abs(pdi-mdi)/(pdi+mdi) if (pdi+mdi)>0 else 0
    a=[None]*len(dx); start=None
    for i in range(len(dx)):
        if dx[i] is not None:
            if start is None: start=i
            if i-start+1==p: a[i]=sum(v for v in dx[start:i+1] if v is not None)/p
            elif i>start+p-1 and a[i-1] is not None: a[i]=(a[i-1]*(p-1)+dx[i])/p
    for i in range(len(dx)): adx_o[i+1]=a[i]; pdi_o[i+1]=pl[i]; mdi_o[i+1]=ml[i]
    return adx_o,pdi_o,mdi_o

print("Computing indicators 4h...")
e200=ema_s(c4,200); e50=ema_s(c4,50); e20=ema_s(c4,20)
rsi4=rsi_s(c4,14); atr4=atr_s(bars4h,14)
adx4,pdi4,mdi4=adx_di_s(bars4h,14)

print("Computing indicators 1d...")
adx1d,pdi1d,mdi1d=adx_di_s(bars1d,14); atr1d=atr_s(bars1d,14); e50d=ema_s(c1d,50)

def signal_G4(i):
    """G4: Lower threshold — ADX>15, RSI 25-60 dip LONG, funding<0.05%, EMA200 gate.
    No stacking — chỉ nới lỏng điều kiện để tăng n."""
    if i<50: return None,None
    a=adx4[i]; pp=pdi4[i]; mm=mdi4[i]; r=rsi4[i]; e2=e200[i]; at=atr4[i]
    if None in (a,pp,mm,r,e2,at): return None,None
    fr=fund_at(bars4h[i]["time"]); price=c4[i]
    if a>15 and pp>mm*1.05 and 25<=r<=60 and price>e2 and fr<0.0005:
        return "LONG", price-ATR_SL*at
    if a>15 and mm>pp*1.05 and 40<=r<=75 and price<e2 and fr>0.00005:
        return "SHORT", price+ATR_SL*at
    return None,None

def signal_G5(i):
    """G5: Multi-signal union — fire if ANY of 3 conditions met + EMA200 + funding gate.
    Điều kiện: (RSI dip OR Stoch dip OR EMA cross) AND ADX>15 AND not crowded."""
    if i<60: return None,None
    a=adx4[i]; pp=pdi4[i]; mm=mdi4[i]; r=rsi4[i]; e2=e200[i]; e5=e50[i]; e2h=e20[i]; at=atr4[i]
    if None in (a,pp,mm,r,e2,e5,e2h,at): return None,None
    fr=fund_at(bars4h[i]["time"]); price=c4[i]
    # Stoch
    sl=bars4h[max(0,i-13):i+1]; hi=max(b["high"] for b in sl); lo=min(b["low"] for b in sl)
    stk=100*(price-lo)/(hi-lo) if hi>lo else 50
    prev_e2h=e20[i-1] if i>0 else e2h; prev_e5=e50[i-1] if i>0 else e5
    if None in (prev_e2h,prev_e5): return None,None
    # LONG conditions
    rsi_dip = 25<=r<=55
    stoch_dip = stk<35
    ema_cross = e2h>e5 and (prev_e2h<=prev_e5 or r<50)
    if a>15 and pp>mm and price>e2 and fr<0.0005 and (rsi_dip or stoch_dip or ema_cross):
        return "LONG", price-ATR_SL*at
    # SHORT conditions
    rsi_bounce = 45<=r<=75
    stoch_bounce = stk>65
    ema_cross_dn = e2h<e5 and (prev_e2h>=prev_e5 or r>50)
    if a>15 and mm>pp and price<e2 and fr>0.00005 and (rsi_bounce or stoch_bounce or ema_cross_dn):
        return "SHORT", price+ATR_SL*at
    return None,None

VARIANT = sys.argv[1] if len(sys.argv)>1 else "G1"

# ─── STRATEGY DEFINITIONS ──────────────────────────────────────────────────
def signal_G1(i):
    """G1: 4h ADX momentum dip-buy + funding gate. Returns ('LONG'|'SHORT'|None, sl_price)."""
    if i<50: return None,None
    a=adx4[i]; pp=pdi4[i]; mm=mdi4[i]; r=rsi4[i]; e2=e200[i]; e5=e50[i]; at=atr4[i]; fr=fund_at(bars4h[i]["time"])
    if None in (a,pp,mm,r,e2,e5,at): return None,None
    price=c4[i]
    # LONG: uptrend + dip pullback + not crowded
    if a>20 and pp>mm and 28<=r<=52 and price>e2 and price>e5 and fr<0.0003:
        return "LONG", price-ATR_SL*at
    # SHORT: downtrend + bounce + crowded shorts inverse
    if a>20 and mm>pp and 48<=r<=72 and price<e2 and price<e5 and fr>0.0001:
        return "SHORT", price+ATR_SL*at
    return None,None

def signal_G2(i):
    """G2: 4h multi-TF: EMA20 cross EMA50 + ADX>18 + funding gate + RSI confirm."""
    if i<60: return None,None
    a=adx4[i]; pp=pdi4[i]; mm=mdi4[i]; r=rsi4[i]; e2=e200[i]; e5=e50[i]; e2h=e20[i]; at=atr4[i]; fr=fund_at(bars4h[i]["time"])
    if None in (a,pp,mm,r,e2,e5,e2h,at): return None,None
    price=c4[i]
    prev_e2h=e20[i-1]; prev_e5=e50[i-1]
    if None in (prev_e2h,prev_e5): return None,None
    # EMA20 cross above EMA50 (fresh) + uptrend confirm + pullback RSI
    ema_cross_up = e2h>e5 and prev_e2h<=prev_e5
    ema_riding = e2h>e5 and r<55  # riding uptrend with dip
    if (ema_cross_up or ema_riding) and a>18 and pp>mm and price>e2 and fr<0.0003:
        return "LONG", price-ATR_SL*at
    ema_cross_dn = e2h<e5 and prev_e2h>=prev_e5
    ema_riding_dn = e2h<e5 and r>45
    if (ema_cross_dn or ema_riding_dn) and a>18 and mm>pp and price<e2 and fr>0.0001:
        return "SHORT", price+ATR_SL*at
    return None,None

def signal_G3(i):
    """G3: 4h Stoch-dip in uptrend (Stoch<30 while ADX>18 DI+ dominant + above EMA200)."""
    if i<50: return None,None
    a=adx4[i]; pp=pdi4[i]; mm=mdi4[i]; e2=e200[i]; at=atr4[i]; fr=fund_at(bars4h[i]["time"])
    if None in (a,pp,mm,e2,at): return None,None
    # Stoch K (price-based)
    prd=14
    if i<prd: return None,None
    sl=bars4h[i-prd:i+1]; hi=max(b["high"] for b in sl); lo=min(b["low"] for b in sl)
    stk=100*(c4[i]-lo)/(hi-lo) if hi>lo else 50
    price=c4[i]
    # LONG: stoch oversold in uptrend
    if a>18 and pp>mm and stk<30 and price>e2 and fr<0.0003:
        return "LONG", price-ATR_SL*at
    if a>18 and mm>pp and stk>70 and price<e2 and fr>0.0001:
        return "SHORT", price+ATR_SL*at
    return None,None

SIGNALS = {"G1": signal_G1, "G2": signal_G2, "G3": signal_G3,
           "G4": signal_G4, "G5": signal_G5, "ALL": None}

# ─── BACKTEST ENGINE ────────────────────────────────────────────────────────
def run_strategy(sig_fn, tag, verbose=False):
    trades=[]; open_pos=None; cooldown=0
    for i in range(50, len(bars4h)-MAX_HOLD_4H-1):
        yr=datetime.datetime.utcfromtimestamp(bars4h[i]["time"]/1000).year
        # Check exit first
        if open_pos:
            entry_i, side, entry_px, sl_px, entry_yr = open_pos
            price=c4[i]; hit_sl=False
            if side=="LONG" and l4[i]<=sl_px: hit_sl=True; exit_px=sl_px
            elif side=="SHORT" and h4[i]>=sl_px: hit_sl=True; exit_px=sl_px
            held=i-entry_i
            # Exit: SL hit or max hold
            if hit_sl or held>=MAX_HOLD_4H:
                if not hit_sl: exit_px=price
                pnl_pct=(exit_px-entry_px)/entry_px*(1 if side=="LONG" else -1)
                pnl_usd=pnl_pct*TRADE_NOTIONAL*LEV - FEE_RT*TRADE_NOTIONAL
                trades.append({"yr":entry_yr,"side":side,"pnl_pct":pnl_pct*LEV*100,
                                "pnl_usd":pnl_usd,"held_bars":held,"sl":hit_sl})
                open_pos=None; cooldown=2  # 8h cooldown after exit
        if cooldown>0: cooldown-=1; continue
        if open_pos: continue  # 1 position max
        # Check entry
        sig, sl_px = sig_fn(i)
        if sig:
            open_pos=(i,sig,c4[i],sl_px,yr)
    # Close any open at end
    if open_pos:
        entry_i,side,entry_px,sl_px,entry_yr=open_pos
        exit_px=c4[-1-MAX_HOLD_4H]
        pnl_pct=(exit_px-entry_px)/entry_px*(1 if side=="LONG" else -1)
        pnl_usd=pnl_pct*TRADE_NOTIONAL*LEV - FEE_RT*TRADE_NOTIONAL
        trades.append({"yr":entry_yr,"side":side,"pnl_pct":pnl_pct*LEV*100,"pnl_usd":pnl_usd,"held_bars":i-entry_i,"sl":False})
    return trades

def report(trades, tag):
    by_yr=defaultdict(list)
    for t in trades: by_yr[t["yr"]].append(t)
    print(f"\n{'='*65}")
    print(f"STRATEGY [{tag}]  total:{len(trades)} trades")
    print(f"{'Year':>6}{'n':>5}{'ROI%':>8}{'WR%':>7}{'avgPnL':>9}{'KPI_n':>7}{'KPI_roi':>9}")
    kpi_n=0; kpi_roi=0; years=sorted(by_yr)
    for yr in range(2019,2027):
        ts=by_yr.get(yr,[])
        n=len(ts)
        roi=sum(t["pnl_usd"] for t in ts)/CAPITAL*100 if ts else 0
        wr=100*sum(1 for t in ts if t["pnl_usd"]>0)/n if n else 0
        avg=sum(t["pnl_usd"] for t in ts)/n if ts else 0
        ok_n="✓" if n>=50 else f"✗({n})"
        ok_roi="✓" if roi>=50 else f"✗({roi:.0f}%)"
        if n>=50: kpi_n+=1
        if roi>=50: kpi_roi+=1
        print(f"  {yr}{n:>5}{roi:>+8.1f}%{wr:>7.0f}%{avg:>+9.0f}  {ok_n:>8} {ok_roi:>10}")
    tot_roi=sum(t["pnl_usd"] for t in trades)/CAPITAL*100
    tot_n=len(trades); tot_wr=100*sum(1 for t in trades if t["pnl_usd"]>0)/tot_n if tot_n else 0
    print(f"  {'TOTAL':>4}{tot_n:>5}{tot_roi:>+8.1f}%{tot_wr:>7.0f}%")
    print(f"\n  KPI n≥50/yr:   {kpi_n}/8 years = {kpi_n/8*100:.0f}%")
    print(f"  KPI roi>50%/yr:{kpi_roi}/8 years = {kpi_roi/8*100:.0f}%")
    print(f"  COMBINED KPI:  {min(kpi_n,kpi_roi)}/8 = {min(kpi_n,kpi_roi)/8*100:.0f}%")
    return {"kpi_n":kpi_n,"kpi_roi":kpi_roi,"n_total":tot_n,"roi_total":tot_roi}

if VARIANT=="ALL":
    for v,fn in [("G4",signal_G4),("G5",signal_G5)]:
        trades=run_strategy(fn,v)
        report(trades,v)
else:
    fn={"G1":signal_G1,"G2":signal_G2,"G3":signal_G3,"G4":signal_G4,"G5":signal_G5}[VARIANT]
    trades=run_strategy(fn,VARIANT)
    res=report(trades,VARIANT)
    print(f"\nSUMMARY[{VARIANT}] n_kpi={res['kpi_n']}/8 roi_kpi={res['kpi_roi']}/8")
