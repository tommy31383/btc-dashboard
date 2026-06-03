#!/usr/bin/env python3
"""
general-rule-eth-g10c.py
Run G10c strategy on ETH 7y data + combine with BTC G10c for portfolio analysis.
G10c params: ADX>18, DI+>DI-*0.95, RSI<72, EMA200_4h+1d gate, funding<0.05%,
             SL=1.8xATR TP=8xATR EMA20 trail, $10k/trade LEV10x (ETH), $15k BTC
"""
import json, datetime, statistics, bisect, sys
from collections import defaultdict

CACHE_BTC  = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
CACHE_ETH  = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-eth-5m-7y.json"
CACHE_FUND = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-funding-7y.json"
CAPITAL    = 100_000

print("Loading BTC data...")
raw_btc = json.load(open(CACHE_BTC)); raw_btc.sort(key=lambda x:x["time"])
print("Loading ETH data...")
raw_eth = json.load(open(CACHE_ETH)); raw_eth.sort(key=lambda x:x["time"])
print("Loading funding data...")
rf = json.load(open(CACHE_FUND))
s=rf[0]; tk=[k for k in s if "time" in k.lower()][0]; rk=[k for k in s if k in ("fundingRate","rate","r","funding")][0]
fund_entries=sorted([(int(e[tk]),float(e[rk])) for e in rf])
ft=[e[0] for e in fund_entries]

def fund_at(t):
    j=bisect.bisect_right(ft,t)-1
    return fund_entries[j][1] if j>=0 else 0

def build(raw5m, ms):
    b={}
    for c in raw5m:
        k=c["time"]//ms
        if k not in b: b[k]={"time":k*ms,"close":c["close"],"high":c["high"],"low":c["low"],"volume":c["volume"]}
        else: o=b[k]; o["close"]=c["close"]; o["high"]=max(o["high"],c["high"]); o["low"]=min(o["low"],c["low"])
    return [b[k] for k in sorted(b)]

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

def build_indicators(raw5m):
    bars4h = build(raw5m, 4*3600*1000)
    c4=[b["close"] for b in bars4h]; h4=[b["high"] for b in bars4h]; l4=[b["low"] for b in bars4h]
    e200=ema_s(c4,200); e20=ema_s(c4,20)
    rsi4=rsi_s(c4,14); atr4=atr_s(bars4h,14)
    adx4,pdi4,mdi4=adx_di_s(bars4h,14)
    # 1d EMA200
    bars1d=build(raw5m,24*3600*1000); c1d=[b["close"] for b in bars1d]
    e200d=ema_s(c1d,200); t1d=[b["time"] for b in bars1d]
    def e200d_at(t):
        j=bisect.bisect_right(t1d,t)-1
        return e200d[j] if 0<=j<len(e200d) else None
    return bars4h, c4, h4, l4, e200, e20, rsi4, atr4, adx4, pdi4, mdi4, e200d_at

def backtest_G10c(bars4h, c4, h4, l4, e200, e20, rsi4, atr4, adx4, pdi4, mdi4, e200d_at,
                  TRADE_NOT=15000, LEV=10, ATR_SL=1.8, ATR_TP=8.0, MAX_HOLD=60,
                  COOLDOWN=3, ADX_THR=18, BEAR_GATE=0.95, MAX_POS=3, RSI_MAX=72, DI_MARGIN=0.95):
    positions=[]; trades=[]; last_entry=-999
    for i in range(60, len(bars4h)-MAX_HOLD-1):
        yr=datetime.datetime.fromtimestamp(bars4h[i]["time"]/1000, datetime.timezone.utc).year
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
        if len(positions)>=MAX_POS: continue
        if i-last_entry<COOLDOWN: continue
        a=adx4[i]; pp=pdi4[i]; mm=mdi4[i]; r=rsi4[i]; e2=e200[i]; e2h=e20[i]; at=atr4[i]
        if None in (a,pp,mm,r,e2,e2h,at): continue
        fr=fund_at(bars4h[i]["time"]); price=c4[i]
        e2d=e200d_at(bars4h[i]["time"])
        if e2d is None: continue
        bear_market = price < e2d * BEAR_GATE
        if not bear_market and a>ADX_THR and pp>mm*DI_MARGIN and price>e2 and fr<0.0005 and r<RSI_MAX:
            sl=price-ATR_SL*at; tp=price+ATR_TP*at
            positions.append((i,"LONG",price,sl,tp,yr)); last_entry=i
        elif bear_market and a>ADX_THR and mm>pp and price<e2 and fr>0.0001 and r>32:
            sl=price+ATR_SL*at; tp=price-ATR_TP*at
            positions.append((i,"SHORT",price,sl,tp,yr)); last_entry=i
    return trades

def report(trades, tag, capital=CAPITAL, n_threshold=50, roi_threshold=50, pro_rate_2026=21/50):
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
        # 2026 pro-rate: 21/50 threshold
        thr_n = int(n_threshold * pro_rate_2026) if yr==2026 else n_threshold
        thr_r = roi_threshold * pro_rate_2026 if yr==2026 else roi_threshold
        ok_n="✓" if n>=thr_n else f"✗({n})"
        ok_r="✓" if roi>=thr_r else f"✗({roi:.0f}%)"
        if n>=thr_n: kn+=1
        if roi>=thr_r: kr+=1
        print(f"  {yr}{n:>5}{roi:>+8.1f}%{wr:>7.0f}%{avg:>+9.0f}  {ok_n:>8} {ok_r:>10}")
    tot=sum(t["pnl_usd"] for t in trades)/capital*100
    wr_t=100*sum(1 for t in trades if t["pnl_usd"]>0)/len(trades) if trades else 0
    print(f"  TOTAL{len(trades):>5}{tot:>+8.1f}%{wr_t:>7.0f}%")
    print(f"\n  KPI n≥thr/yr:    {kn}/8 = {kn/8*100:.0f}%")
    print(f"  KPI roi>thr/yr:  {kr}/8 = {kr/8*100:.0f}%")
    print(f"  ★ COMBINED KPI: {min(kn,kr)}/8 = {min(kn,kr)/8*100:.0f}%")
    return kn, kr, by_yr

# --- BTC G10c ($15k/trade) ---
print("\nBuilding BTC indicators...")
btc_bars4h,btc_c4,btc_h4,btc_l4,btc_e200,btc_e20,btc_rsi4,btc_atr4,btc_adx4,btc_pdi4,btc_mdi4,btc_e200d_at = build_indicators(raw_btc)
print(f"  BTC 4h bars: {len(btc_bars4h)}")
print("Running BTC G10c...")
btc_trades = backtest_G10c(btc_bars4h,btc_c4,btc_h4,btc_l4,btc_e200,btc_e20,btc_rsi4,btc_atr4,btc_adx4,btc_pdi4,btc_mdi4,btc_e200d_at,
                            TRADE_NOT=15000, LEV=10)
kn_btc, kr_btc, btc_by_yr = report(btc_trades, "BTC G10c ($15k/trade)")

# --- ETH G10c ($10k/trade) ---
print("\nBuilding ETH indicators...")
eth_bars4h,eth_c4,eth_h4,eth_l4,eth_e200,eth_e20,eth_rsi4,eth_atr4,eth_adx4,eth_pdi4,eth_mdi4,eth_e200d_at = build_indicators(raw_eth)
print(f"  ETH 4h bars: {len(eth_bars4h)}")
print("Running ETH G10c...")
eth_trades = backtest_G10c(eth_bars4h,eth_c4,eth_h4,eth_l4,eth_e200,eth_e20,eth_rsi4,eth_atr4,eth_adx4,eth_pdi4,eth_mdi4,eth_e200d_at,
                            TRADE_NOT=10000, LEV=10)
kn_eth, kr_eth, eth_by_yr = report(eth_trades, "ETH G10c ($10k/trade)")

# --- PORTFOLIO: BTC+ETH combined ---
print("\n" + "="*72)
print("PORTFOLIO: BTC G10c ($15k) + ETH G10c ($10k) on same $100k capital")
print(f"{'Year':>6}{'n_btc':>7}{'n_eth':>7}{'n_tot':>7}{'ROI%':>9}{'KPI_n':>8}{'KPI_roi':>10}")

kn_p=0; kr_p=0
portfolio_by_yr = {}
for yr in range(2019,2027):
    tb = btc_by_yr.get(yr,[])
    te = eth_by_yr.get(yr,[])
    n_btc=len(tb); n_eth=len(te); n_tot=n_btc+n_eth
    roi=(sum(t["pnl_usd"] for t in tb)+sum(t["pnl_usd"] for t in te))/CAPITAL*100
    thr_n = int(50*21/50) if yr==2026 else 50
    thr_r = 50*21/50 if yr==2026 else 50
    ok_n="✓" if n_tot>=thr_n else f"✗({n_tot})"
    ok_r="✓" if roi>=thr_r else f"✗({roi:.0f}%)"
    if n_tot>=thr_n: kn_p+=1
    if roi>=thr_r: kr_p+=1
    portfolio_by_yr[yr] = {"n_btc":n_btc,"n_eth":n_eth,"n_tot":n_tot,"roi_pct":roi}
    print(f"  {yr}{n_btc:>7}{n_eth:>7}{n_tot:>7}{roi:>+9.1f}%{ok_n:>8}{ok_r:>10}")

total_roi=(sum(t["pnl_usd"] for t in btc_trades)+sum(t["pnl_usd"] for t in eth_trades))/CAPITAL*100
n_total=len(btc_trades)+len(eth_trades)
print(f"  TOTAL{len(btc_trades):>7}{len(eth_trades):>7}{n_total:>7}{total_roi:>+9.1f}%")
print(f"\n  Portfolio KPI n≥thr/yr:    {kn_p}/8 = {kn_p/8*100:.0f}%")
print(f"  Portfolio KPI roi>thr/yr:  {kr_p}/8 = {kr_p/8*100:.0f}%")
print(f"  ★ PORTFOLIO COMBINED KPI: {min(kn_p,kr_p)}/8 = {min(kn_p,kr_p)/8*100:.0f}%")

# Save results for doc
import json as _json
results = {
    "btc": {"kpi_n": kn_btc, "kpi_roi": kr_btc, "combined": min(kn_btc,kr_btc), "by_yr": {str(k):{"n":len(v),"roi":sum(t["pnl_usd"] for t in v)/CAPITAL*100} for k,v in btc_by_yr.items()}},
    "eth": {"kpi_n": kn_eth, "kpi_roi": kr_eth, "combined": min(kn_eth,kr_eth), "by_yr": {str(k):{"n":len(v),"roi":sum(t["pnl_usd"] for t in v)/CAPITAL*100} for k,v in eth_by_yr.items()}},
    "portfolio": {"kpi_n": kn_p, "kpi_roi": kr_p, "combined": min(kn_p,kr_p), "by_yr": {str(k):v for k,v in portfolio_by_yr.items()}}
}
with open("/tmp/g10c_results.json","w") as f:
    _json.dump(results, f, indent=2)
print("\nResults saved to /tmp/g10c_results.json")
