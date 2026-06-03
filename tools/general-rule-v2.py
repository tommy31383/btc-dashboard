#!/usr/bin/env python3
"""
general-rule-v2.py — General Rule iteration 2.
Target: ≥50 entry/yr, ROI>50%/yr, stable 2019-2026.

Key fix from v1:
  - Multi-position (max 3 concurrent) → more entries per year
  - 1h timeframe signals → faster entries, more frequency
  - Shorter hold (max 24h = 24 bar 1h) → faster turnover
  - Tighter ATR filter (1.5×) → better WR
  - Multiple signal sources run simultaneously
  - Capital: $100k, $5k notional/trade (20 trades capacity), LEV 5×
"""
import json, datetime, statistics, bisect, sys
from collections import defaultdict

CACHE_5M   = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
CACHE_FUND = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-funding-7y.json"

CAPITAL    = 100_000
TRADE_NOT  = 5_000   # $5k notional per trade
LEV        = 5
ATR_SL     = 1.5
ATR_TP     = 3.0     # TP = 3×ATR → R:R = 2:1
MAX_HOLD   = 48      # 2 days max hold
FEE_RT     = 0.0006
MAX_POS    = 3
COOLDOWN   = 4

print("Loading...")
raw5m = json.load(open(CACHE_5M)); raw5m.sort(key=lambda x:x["time"])
rf = json.load(open(CACHE_FUND))
s=rf[0]; tk=[k for k in s if "time" in k.lower()][0]; rk=[k for k in s if k in ("fundingRate","rate","r","funding")][0]
fund_entries=sorted([(int(e[tk]),float(e[rk])) for e in rf])
ft=[e[0] for e in fund_entries]

def build(ms):
    b={}
    for c in raw5m:
        k=c["time"]//ms
        if k not in b: b[k]={"time":k*ms,"close":c["close"],"high":c["high"],"low":c["low"],"volume":c["volume"]}
        else: o=b[k]; o["close"]=c["close"]; o["high"]=max(o["high"],c["high"]); o["low"]=min(o["low"],c["low"])
    return [b[k] for k in sorted(b)]

bars1h=build(3600*1000); bars4h=build(4*3600*1000)
c1=[b["close"] for b in bars1h]; h1=[b["high"] for b in bars1h]; l1=[b["low"] for b in bars1h]
c4=[b["close"] for b in bars4h]
print(f"  1h:{len(bars1h)} 4h:{len(bars4h)}")

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

print("Computing 1h indicators...")
rsi1=rsi_s(c1,14); atr1=atr_s(bars1h,14)
e200_1h=ema_s(c1,200); e50_1h=ema_s(c1,50); e20_1h=ema_s(c1,20)
adx1,pdi1,mdi1=adx_di_s(bars1h,14)
# Stoch 1h
stk1=[None]*len(bars1h)
for i in range(13,len(bars1h)):
    sl=bars1h[i-13:i+1]; hi=max(b["high"] for b in sl); lo=min(b["low"] for b in sl)
    stk1[i]=100*(c1[i]-lo)/(hi-lo) if hi>lo else 50

VARIANT = sys.argv[1] if len(sys.argv)>1 else "H1"

def signal_H1(i):
    """H1: 1h ADX>18 + DI confirm + RSI/Stoch dip LONG + EMA200_1h + funding<0.05%"""
    if i<50: return None,None
    a=adx1[i]; pp=pdi1[i]; mm=mdi1[i]; r=rsi1[i]; sk=stk1[i]
    e2=e200_1h[i]; at=atr1[i]
    if None in (a,pp,mm,r,sk,e2,at): return None,None
    fr=fund_at(bars1h[i]["time"]); price=c1[i]
    if a>18 and pp>mm*1.1 and (r<45 or sk<30) and price>e2 and fr<0.0005:
        return "LONG", price-ATR_SL*at
    if a>18 and mm>pp*1.1 and (r>55 or sk>70) and price<e2 and fr>0.00005:
        return "SHORT", price+ATR_SL*at
    return None,None

def signal_H2(i):
    """H2: 1h EMA20 > EMA50 uptrend + price touches EMA20 (pullback) + ADX>15 + funding<0.05%"""
    if i<60: return None,None
    a=adx1[i]; pp=pdi1[i]; mm=mdi1[i]
    e2=e200_1h[i]; e5=e50_1h[i]; e2h=e20_1h[i]; at=atr1[i]
    if None in (a,pp,mm,e2,e5,e2h,at): return None,None
    fr=fund_at(bars1h[i]["time"]); price=c1[i]
    # Pullback to EMA20 in uptrend
    near_ema20_up = e2h>e5 and price<=e2h*1.003 and price>=e2h*0.997
    near_ema20_dn = e2h<e5 and price>=e2h*0.997 and price<=e2h*1.003
    if a>15 and pp>mm and near_ema20_up and price>e2 and fr<0.0005:
        return "LONG", price-ATR_SL*at
    if a>15 and mm>pp and near_ema20_dn and price<e2 and fr>0.00005:
        return "SHORT", price+ATR_SL*at
    return None,None

def signal_H3(i):
    """H3: Stoch oversold bounce in 1h uptrend (ADX>15, DI+>DI-). Wide filter."""
    if i<50: return None,None
    a=adx1[i]; pp=pdi1[i]; mm=mdi1[i]; sk=stk1[i]
    e2=e200_1h[i]; at=atr1[i]
    if None in (a,pp,mm,sk,e2,at): return None,None
    fr=fund_at(bars1h[i]["time"]); price=c1[i]
    sk_prev=stk1[i-1] if i>0 and stk1[i-1] is not None else sk
    # Stoch bounce: was<25, now rising
    stoch_long = sk<30 and sk>sk_prev-5
    stoch_short = sk>70 and sk<sk_prev+5
    if a>15 and pp>mm and stoch_long and price>e2 and fr<0.0005:
        return "LONG", price-ATR_SL*at
    if a>15 and mm>pp and stoch_short and price<e2 and fr>0.00005:
        return "SHORT", price+ATR_SL*at
    return None,None

# Union signal: fire if any sub-signal fires
def signal_UNION(i):
    for fn in [signal_H1, signal_H2, signal_H3]:
        sig,sl=fn(i)
        if sig: return sig,sl
    return None,None

def run_multi(sig_fn, tag):
    """Multi-position engine: up to MAX_POS concurrent, per-trade tracking."""
    positions=[]  # list of (entry_i, side, entry_px, sl_px, yr)
    trades=[]
    last_long=last_short=-999
    for i in range(60, len(bars1h)-MAX_HOLD-1):
        yr=datetime.datetime.utcfromtimestamp(bars1h[i]["time"]/1000).year
        # Check exits
        new_pos=[]
        for pos in positions:
            entry_i,side,entry_px,sl_px,tp_px,pyr=pos
            price=c1[i]; hit_sl=False; hit_tp=False
            if side=="LONG":
                if l1[i]<=sl_px: hit_sl=True; exit_px=sl_px
                elif h1[i]>=tp_px: hit_tp=True; exit_px=tp_px
            else:
                if h1[i]>=sl_px: hit_sl=True; exit_px=sl_px
                elif l1[i]<=tp_px: hit_tp=True; exit_px=tp_px
            held=i-entry_i
            if hit_sl or hit_tp or held>=MAX_HOLD:
                if not hit_sl: exit_px=price
                pnl_pct=(exit_px-entry_px)/entry_px*(1 if side=="LONG" else -1)
                pnl_usd=pnl_pct*TRADE_NOT*LEV - FEE_RT*TRADE_NOT
                trades.append({"yr":pyr,"side":side,"pnl_usd":pnl_usd,"held":held,"sl":hit_sl,"tp":hit_tp})
            else:
                new_pos.append(pos)
        positions=new_pos
        # Check entry
        if len(positions)>=MAX_POS: continue
        sig,sl_px=sig_fn(i)
        if not sig: continue
        if sig=="LONG" and i-last_long<COOLDOWN: continue
        if sig=="SHORT" and i-last_short<COOLDOWN: continue
        # Check no same-direction position open
        sides_open=[p[1] for p in positions]
        if sides_open.count(sig)>=2: continue  # max 2 same side
        at=atr1[i] or 0.01
        tp_px = c1[i]+ATR_TP*at if sig=="LONG" else c1[i]-ATR_TP*at
        positions.append((i,sig,c1[i],sl_px,tp_px,yr))
        if sig=="LONG": last_long=i
        else: last_short=i
    # Close remaining
    for pos in positions:
        entry_i,side,entry_px,sl_px,tp_px,pyr=pos
        exit_px=c1[min(entry_i+MAX_HOLD,len(c1)-1)]
        pnl_pct=(exit_px-entry_px)/entry_px*(1 if side=="LONG" else -1)
        pnl_usd=pnl_pct*TRADE_NOT*LEV - FEE_RT*TRADE_NOT
        trades.append({"yr":pyr,"side":side,"pnl_usd":pnl_usd,"held":MAX_HOLD,"sl":False,"tp":False})
    return trades

def report(trades, tag):
    by_yr=defaultdict(list)
    for t in trades: by_yr[t["yr"]].append(t)
    print(f"\n{'='*70}")
    print(f"STRATEGY [{tag}]  total:{len(trades)}  $5k/trade, 5× lev, $100k capital")
    print(f"{'Year':>6}{'n':>5}{'ROI%':>8}{'WR%':>7}{'avgPnL$':>9}  KPI_n  KPI_roi")
    kn=0; kr=0
    for yr in range(2019,2027):
        ts=by_yr.get(yr,[])
        n=len(ts); roi=sum(t["pnl_usd"] for t in ts)/CAPITAL*100 if ts else 0
        wr=100*sum(1 for t in ts if t["pnl_usd"]>0)/n if n else 0
        avg=sum(t["pnl_usd"] for t in ts)/n if ts else 0
        ok_n="✓" if n>=50 else f"✗({n})"
        ok_r="✓" if roi>=50 else f"✗({roi:.0f}%)"
        if n>=50: kn+=1
        if roi>=50: kr+=1
        print(f"  {yr}{n:>5}{roi:>+8.1f}%{wr:>7.0f}%{avg:>+9.0f}  {ok_n:>8} {ok_r:>10}")
    tot=sum(t["pnl_usd"] for t in trades)/CAPITAL*100
    wr_t=100*sum(1 for t in trades if t["pnl_usd"]>0)/len(trades) if trades else 0
    print(f"  TOTAL{len(trades):>5}{tot:>+8.1f}%{wr_t:>7.0f}%")
    print(f"\n  KPI n≥50/yr:    {kn}/8 = {kn/8*100:.0f}%")
    print(f"  KPI roi>50%/yr: {kr}/8 = {kr/8*100:.0f}%")
    print(f"  ★ COMBINED KPI: {min(kn,kr)}/8 = {min(kn,kr)/8*100:.0f}%")
    return kn,kr

fns={"H1":signal_H1,"H2":signal_H2,"H3":signal_H3,"UNION":signal_UNION}
if VARIANT=="ALL":
    for v,fn in fns.items():
        trades=run_multi(fn,v); report(trades,v)
else:
    trades=run_multi(fns[VARIANT],VARIANT); report(trades,VARIANT)
