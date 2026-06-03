#!/usr/bin/env python3
"""
general-rule-v3.py — General Rule v3: Aggressive trend-follow với edge thật.
Target: ≥50 entry/yr, ROI>50%/yr 2019-2026.

Insight từ v1/v2:
  - WR 35-42% không đủ → cần WR>55% HOẶC R:R>3:1
  - 1h signal: tạo nhiều entry nhưng WR thấp → giảm ROI
  - Từ lesson: ADX/DI king + EMA200 regime + ATR cut = nguồn alpha thật
  - Turtle: WR thấp nhưng big winners → R:R cao

New approach — G6 "Trend Pulse":
  Timeframe: 4h (balance giữa signal quality và frequency)
  Entry: ADX>20 + DI+>DI- + price pullback >0.5% từ EMA20 + EMA200 above + funding<0.05%
         Staggered: entry 3 bậc (base + add thêm nếu setup confirm tiếp)
  Exit: Trail stop EMA20 (đóng nếu close < EMA20 1 bar)
        OR SL cứng 2×ATR
        OR TP 5×ATR
  Capital: $100k, $10k/trade, LEV 5× → mỗi entry = $50k exposure
  Multi-pos: max 3 trades open (thay vì LONG-only)

G7 "Breakout + Confirm":
  Entry: 4h close > 20-bar high + ADX>15 + funding<0.03% + not extreme overbought
  Add: nếu tiếp tục hold > 5 bar, add thêm 1 trade
  Exit: ATR trail 2× hoặc max hold 10 days
"""
import json, datetime, statistics, bisect, sys
from collections import defaultdict

CACHE_5M   = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
CACHE_FUND = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-funding-7y.json"
CAPITAL    = 100_000

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

bars4h=build(4*3600*1000)
c4=[b["close"] for b in bars4h]; h4=[b["high"] for b in bars4h]; l4=[b["low"] for b in bars4h]
print(f"  4h:{len(bars4h)}")

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

print("Computing indicators...")
e200=ema_s(c4,200); e50=ema_s(c4,50); e20=ema_s(c4,20)
rsi4=rsi_s(c4,14); atr4=atr_s(bars4h,14)
adx4,pdi4,mdi4=adx_di_s(bars4h,14)

VARIANT = sys.argv[1] if len(sys.argv)>1 else "G6"

def backtest_G6(TRADE_NOT=10000, LEV=5, ATR_SL=2.0, ATR_TP=6.0, MAX_HOLD=60, COOLDOWN=4, ADX_THR=20):
    """G6: 4h Trend Pulse — ADX>ADX_THR + DI + EMA20 pullback + EMA200 regime."""
    positions=[]; trades=[]; last_entry=-999
    for i in range(60, len(bars4h)-MAX_HOLD-1):
        yr=datetime.datetime.utcfromtimestamp(bars4h[i]["time"]/1000).year
        # Exits
        new_pos=[]
        for pos in positions:
            ei,side,epx,slpx,tppx,pyr=pos
            hit_sl=hit_tp=False
            if side=="LONG":
                if l4[i]<=slpx: hit_sl=True; xpx=slpx
                elif h4[i]>=tppx: hit_tp=True; xpx=tppx
                # EMA20 trail: close < EMA20 → exit
                elif e20[i] and c4[i]<e20[i] and i-ei>=8: hit_tp=False; xpx=c4[i]
                else: new_pos.append(pos); continue
            else:
                if h4[i]>=slpx: hit_sl=True; xpx=slpx
                elif l4[i]<=tppx: hit_tp=True; xpx=tppx
                elif e20[i] and c4[i]>e20[i] and i-ei>=8: xpx=c4[i]
                else: new_pos.append(pos); continue
            pnl_pct=(xpx-epx)/epx*(1 if side=="LONG" else -1)
            pnl_usd=pnl_pct*TRADE_NOT*LEV - 0.0006*TRADE_NOT
            trades.append({"yr":pyr,"side":side,"pnl_usd":pnl_usd,"held":i-ei,"sl":hit_sl,"tp":hit_tp})
        positions=new_pos
        if len(positions)>=3: continue
        if i-last_entry<COOLDOWN: continue
        a=adx4[i]; pp=pdi4[i]; mm=mdi4[i]; r=rsi4[i]; e2=e200[i]; e2h=e20[i]; at=atr4[i]
        if None in (a,pp,mm,r,e2,e2h,at): continue
        fr=fund_at(bars4h[i]["time"]); price=c4[i]
        # LONG: trend up + pullback to EMA20 + not overbought
        near_e20 = abs(price-e2h)/e2h < 0.005  # within 0.5% of EMA20
        if a>ADX_THR and pp>mm*1.1 and price>e2 and r<65 and fr<0.0005 and (near_e20 or r<45):
            sl=price-ATR_SL*at; tp=price+ATR_TP*at
            positions.append((i,"LONG",price,sl,tp,yr)); last_entry=i
        elif a>ADX_THR and mm>pp*1.1 and price<e2 and r>35 and fr>0.00005 and (near_e20 or r>55):
            sl=price+ATR_SL*at; tp=price-ATR_TP*at
            positions.append((i,"SHORT",price,sl,tp,yr)); last_entry=i
    return trades

def backtest_G7(TRADE_NOT=8000, LEV=5, MAX_HOLD=60, COOLDOWN=6):
    """G7: 4h Donchian 15-bar breakout + ADX>15 + funding gate + short-term trail."""
    positions=[]; trades=[]; last_entry=-999
    for i in range(25, len(bars4h)-MAX_HOLD-1):
        yr=datetime.datetime.utcfromtimestamp(bars4h[i]["time"]/1000).year
        # Exits: EMA20 trail
        new_pos=[]
        for pos in positions:
            ei,side,epx,slpx,pyr=pos
            at=atr4[i] or 0.01
            # Update trail stop
            if side=="LONG": new_sl=max(slpx, c4[i]-2*at)
            else: new_sl=min(slpx, c4[i]+2*at)
            hit_sl=False
            if side=="LONG" and l4[i]<=new_sl: hit_sl=True; xpx=new_sl
            elif side=="SHORT" and h4[i]>=new_sl: hit_sl=True; xpx=new_sl
            held=i-ei
            if hit_sl or held>=MAX_HOLD:
                if not hit_sl: xpx=c4[i]
                pnl_pct=(xpx-epx)/epx*(1 if side=="LONG" else -1)
                pnl_usd=pnl_pct*TRADE_NOT*LEV - 0.0006*TRADE_NOT
                trades.append({"yr":pyr,"side":side,"pnl_usd":pnl_usd,"held":held,"sl":hit_sl,"tp":False})
            else: new_pos.append((ei,side,epx,new_sl,pyr))
        positions=new_pos
        if len(positions)>=3: continue
        if i-last_entry<COOLDOWN: continue
        a=adx4[i]; pp=pdi4[i]; mm=mdi4[i]; e2=e200[i]; r=rsi4[i]; at=atr4[i]
        if None in (a,pp,mm,e2,r,at): continue
        fr=fund_at(bars4h[i]["time"]); price=c4[i]
        # 15-bar high breakout
        high15=max(h4[max(0,i-15):i])
        low15=min(l4[max(0,i-15):i])
        if price>high15 and a>15 and pp>mm and price>e2 and fr<0.0003 and r<75:
            sl=price-2*at; positions.append((i,"LONG",price,sl,yr)); last_entry=i
        elif price<low15 and a>15 and mm>pp and price<e2 and fr>0.00005 and r>25:
            sl=price+2*at; positions.append((i,"SHORT",price,sl,yr)); last_entry=i
    return trades

def report(trades, tag, capital=CAPITAL):
    by_yr=defaultdict(list)
    for t in trades: by_yr[t["yr"]].append(t)
    print(f"\n{'='*72}")
    tp_rate=100*sum(1 for t in trades if t.get("tp"))/len(trades) if trades else 0
    sl_rate=100*sum(1 for t in trades if t.get("sl"))/len(trades) if trades else 0
    print(f"STRATEGY [{tag}]  total:{len(trades)}  TP:{tp_rate:.0f}% SL:{sl_rate:.0f}%")
    print(f"{'Year':>6}{'n':>5}{'ROI%':>8}{'WR%':>7}{'avgPnL$':>9}  KPI_n  KPI_roi")
    kn=0; kr=0
    for yr in range(2019,2027):
        ts=by_yr.get(yr,[])
        n=len(ts); roi=sum(t["pnl_usd"] for t in ts)/capital*100 if ts else 0
        wr=100*sum(1 for t in ts if t["pnl_usd"]>0)/n if n else 0
        avg=sum(t["pnl_usd"] for t in ts)/n if ts else 0
        ok_n="✓" if n>=50 else f"✗({n})"
        ok_r="✓" if roi>=50 else f"✗({roi:.0f}%)"
        if n>=50: kn+=1
        if roi>=50: kr+=1
        print(f"  {yr}{n:>5}{roi:>+8.1f}%{wr:>7.0f}%{avg:>+9.0f}  {ok_n:>8} {ok_r:>10}")
    tot=sum(t["pnl_usd"] for t in trades)/capital*100
    wr_t=100*sum(1 for t in trades if t["pnl_usd"]>0)/len(trades) if trades else 0
    print(f"  TOTAL{len(trades):>5}{tot:>+8.1f}%{wr_t:>7.0f}%")
    print(f"\n  KPI n≥50/yr:    {kn}/8 = {kn/8*100:.0f}%")
    print(f"  KPI roi>50%/yr: {kr}/8 = {kr/8*100:.0f}%")
    print(f"  ★ COMBINED KPI: {min(kn,kr)}/8 = {min(kn,kr)/8*100:.0f}%")
    return kn,kr

def backtest_G8(TRADE_NOT=20000, LEV=10, ATR_SL=1.8, ATR_TP=8.0, MAX_HOLD=60, COOLDOWN=3, ADX_THR=18):
    """G8: G6 + EMA200_1d BEAR gate + nới lỏng RSI/EMA20 để tăng n."""
    # Build 1d EMA200
    bars1d=build(24*3600*1000); c1d=[b["close"] for b in bars1d]
    e200d=ema_s(c1d,200); t1d=[b["time"] for b in bars1d]
    def e200d_at(t):
        j=bisect.bisect_right(t1d,t)-1
        return e200d[j] if 0<=j<len(e200d) else None

    positions=[]; trades=[]; last_entry=-999
    for i in range(60, len(bars4h)-MAX_HOLD-1):
        yr=datetime.datetime.utcfromtimestamp(bars4h[i]["time"]/1000).year
        new_pos=[]
        for pos in positions:
            ei,side,epx,slpx,tppx,pyr=pos
            hit_sl=hit_tp=False
            if side=="LONG":
                if l4[i]<=slpx: hit_sl=True; xpx=slpx
                elif h4[i]>=tppx: hit_tp=True; xpx=tppx
                elif e20[i] and c4[i]<e20[i] and i-ei>=10: xpx=c4[i]
                else: new_pos.append(pos); continue
            else:
                if h4[i]>=slpx: hit_sl=True; xpx=slpx
                elif l4[i]<=tppx: hit_tp=True; xpx=tppx
                elif e20[i] and c4[i]>e20[i] and i-ei>=10: xpx=c4[i]
                else: new_pos.append(pos); continue
            pnl_pct=(xpx-epx)/epx*(1 if side=="LONG" else -1)
            pnl_usd=pnl_pct*TRADE_NOT*LEV - 0.0006*TRADE_NOT
            trades.append({"yr":pyr,"side":side,"pnl_usd":pnl_usd,"held":i-ei,"sl":hit_sl,"tp":hit_tp})
        positions=new_pos
        if len(positions)>=3: continue
        if i-last_entry<COOLDOWN: continue
        a=adx4[i]; pp=pdi4[i]; mm=mdi4[i]; r=rsi4[i]; e2=e200[i]; e2h=e20[i]; at=atr4[i]
        if None in (a,pp,mm,r,e2,e2h,at): continue
        fr=fund_at(bars4h[i]["time"]); price=c4[i]
        # 1d EMA200 regime gate
        e2d=e200d_at(bars4h[i]["time"])
        if e2d is None: continue
        bear_market = price < e2d * 0.95  # price >5% below 1d EMA200
        # LONG: not BEAR + uptrend + dip
        if not bear_market and a>ADX_THR and pp>mm and price>e2 and fr<0.0005 and r<68:
            sl=price-ATR_SL*at; tp=price+ATR_TP*at
            positions.append((i,"LONG",price,sl,tp,yr)); last_entry=i
        # SHORT: confirmed BEAR only (strict)
        elif bear_market and a>ADX_THR and mm>pp and price<e2 and fr>0.0001 and r>32:
            sl=price+ATR_SL*at; tp=price-ATR_TP*at
            positions.append((i,"SHORT",price,sl,tp,yr)); last_entry=i
    return trades

if VARIANT=="G6":
    trades=backtest_G6(); report(trades,"G6")
elif VARIANT=="G7":
    trades=backtest_G7(); report(trades,"G7")
elif VARIANT=="G6X":
    # Aggressive sizing: $20k notional, LEV 10×
    trades=backtest_G6(TRADE_NOT=20000,LEV=10,ATR_SL=1.5,ATR_TP=4.0,COOLDOWN=2,ADX_THR=18)
    report(trades,"G6-agg")
elif VARIANT=="G8":
    trades=backtest_G8(); report(trades,"G8")
elif VARIANT=="ALL":
    for v,fn in [("G6-agg",lambda:backtest_G6(TRADE_NOT=20000,LEV=10,ATR_SL=1.5,ATR_TP=4.0,COOLDOWN=2,ADX_THR=18)),
                 ("G8",lambda:backtest_G8())]:
        trades=fn(); report(trades,v)
