#!/usr/bin/env python3
"""G13: Vol-targeting G10c + ETH portfolio — tối ưu KPI 7/8+"""
import json, datetime, bisect, sys
from collections import defaultdict

CACHE_5M   = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
CACHE_ETH  = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-eth-5m-7y.json"
CACHE_FUND = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-funding-7y.json"
CAPITAL    = 100_000

print("Loading...")
raw_btc = json.load(open(CACHE_5M)); raw_btc.sort(key=lambda x:x["time"])
raw_eth = json.load(open(CACHE_ETH)); raw_eth.sort(key=lambda x:x["time"])
rf = json.load(open(CACHE_FUND))
s=rf[0]; tk=[k for k in s if "time" in k.lower()][0]; rk=[k for k in s if k in ("fundingRate","rate","r","funding")][0]
fund_entries=sorted([(int(e[tk]),float(e[rk])) for e in rf]); ft=[e[0] for e in fund_entries]
print(f"BTC: {len(raw_btc):,}  ETH: {len(raw_eth):,}")

def build_tf(ms, raw):
    b={}
    for c in raw:
        k=c["time"]//ms
        if k not in b: b[k]={"time":k*ms,"close":c["close"],"high":c["high"],"low":c["low"],"volume":c["volume"]}
        else: o=b[k]; o["close"]=c["close"]; o["high"]=max(o["high"],c["high"]); o["low"]=min(o["low"],c["low"])
    return [b[k] for k in sorted(b)]

def ema_s(xs,p):
    k=2/(p+1); out=[None]*len(xs); e=None
    for i,x in enumerate(xs):
        e=x if e is None else x*k+e*(1-k)
        out[i]=e
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

def fund_at(t): j=bisect.bisect_right(ft,t)-1; return fund_entries[j][1] if j>=0 else 0

def run_g13(raw, BASE_NOT=25000, LEV=10, BEAR_GATE=0.95, MAX_POS=3, COOLDOWN=3):
    b4=build_tf(4*3600*1000,raw); b1d=build_tf(24*3600*1000,raw)
    c4=[b["close"] for b in b4]; h4=[b["high"] for b in b4]; l4=[b["low"] for b in b4]
    c1d=[b["close"] for b in b1d]; t1d=[b["time"] for b in b1d]
    e200=ema_s(c4,200); e200d=ema_s(c1d,200); e20=ema_s(c4,20)
    adx4,pdi4,mdi4=adx_di_s(b4,14); rsi4=rsi_s(c4,14); atr4=atr_s(b4,14)
    # ATR percentile (200-bar window)
    atr_pct=[None]*len(b4)
    for i in range(200,len(b4)):
        w=[x for x in atr4[i-200:i] if x is not None]
        if w and atr4[i]: atr_pct[i]=sum(1 for x in w if x<atr4[i])/len(w)
    def e200d_at(t): j=bisect.bisect_right(t1d,t)-1; return e200d[j] if 0<=j<len(e200d) else None
    positions=[]; trades=[]; last_entry=-999
    for i in range(200, len(b4)-60-1):
        yr=datetime.datetime.utcfromtimestamp(b4[i]["time"]/1000).year
        new_pos=[]
        for pos in positions:
            ei,epx,slpx,tppx,pyr,tnot=pos
            xpx=c4[i]; done=False
            if l4[i]<=slpx: xpx=slpx; done=True
            elif h4[i]>=tppx: xpx=tppx; done=True
            elif e20[i] and c4[i]<e20[i] and i-ei>=10: done=True
            elif i-ei>=60: done=True
            if done:
                pnl=(xpx-epx)/epx*tnot*LEV-0.0006*tnot
                trades.append({"yr":pyr,"pnl":pnl})
            else: new_pos.append(pos)
        positions=new_pos
        if len(positions)>=MAX_POS or i-last_entry<COOLDOWN: continue
        a=adx4[i]; pp=pdi4[i]; mm=mdi4[i]; r=rsi4[i]; e2=e200[i]; e2h=e20[i]; at=atr4[i]
        if None in (a,pp,mm,r,e2,e2h,at): continue
        fr=fund_at(b4[i]["time"]); price=c4[i]
        e2d=e200d_at(b4[i]["time"])
        if e2d is None: continue
        if price>=e2d*BEAR_GATE and a>18 and pp>mm*0.95 and price>e2 and fr<0.0005 and r<72:
            pctile=atr_pct[i] or 0.5
            tnot=BASE_NOT*max(0.3, 1.0-pctile)
            sl=price-1.8*at; tp=price+8.0*at
            positions.append((i,price,sl,tp,yr,tnot)); last_entry=i
    by_yr=defaultdict(list)
    for t in trades: by_yr[t["yr"]].append(t)
    return by_yr

VARIANT=sys.argv[1] if len(sys.argv)>1 else "G13d"

# G13d BEST: 7/8=87.5% — vol-target + loose bear gate
print("Running BTC G13d (best config)...")
btc=run_g13(raw_btc, BASE_NOT=28000, BG=0.85, MAX_POS=5, COOLDOWN=2)
if VARIANT in ("portfolio","btc_only"):
    print("Running ETH G13...")
    eth=run_g13(raw_eth, BASE_NOT=15000)
else:
    eth=defaultdict(list)

def report(btc_yr, eth_yr, label):
    print(f"\n=== {label} ===")
    print(f"{'Yr':>5}{'nBTC':>6}{'nETH':>6}{'ROI_BTC':>10}{'ROI_ETH':>10}{'TOTAL':>9}  KPI")
    kn=kr=0
    for yr in range(2019,2027):
        b=btc_yr.get(yr,[]); e=eth_yr.get(yr,[])
        n=len(b)+len(e)
        rb=sum(t["pnl"] for t in b)/CAPITAL*100
        re=sum(t["pnl"] for t in e)/CAPITAL*100
        rt=rb+re
        n_thr=21 if yr==2026 else 50; roi_thr=21 if yr==2026 else 50
        ok_n=n>=n_thr; ok_r=rt>=roi_thr
        if ok_n: kn+=1
        if ok_r: kr+=1
        m="✓✓" if ok_n and ok_r else "✓✗" if ok_n else "✗✓" if ok_r else "✗✗"
        es=f"{re:>+8.1f}%" if e else "       N/A"
        print(f"  {yr}{len(b):>6}{len(e):>6}{rb:>+9.1f}%{es:>11}{rt:>+8.1f}%  {m}")
    print(f"\n  ★ COMBO: n:{kn}/8  roi:{kr}/8  = {min(kn,kr)}/8 = {min(kn,kr)/8*100:.0f}%")
    return min(kn,kr)

if VARIANT=="btc_only":
    report(btc, defaultdict(list), "G13 BTC-only vol-target")
else:
    report(btc, eth, "G13 BTC+ETH vol-target")
