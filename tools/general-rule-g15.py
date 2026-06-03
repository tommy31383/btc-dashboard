#!/usr/bin/env python3
"""
G15: BTC 4h + 1h addon + ETH retest-zone [0.85-1.05]×EMA200d
8/8 = 100% KPI, avg_n=488-546 (vs G14 avg_n=180)

G15a: 1h NOT=14k, COOL=1, HOLD=24 → avg_n=546
G15e: 1h NOT=20k, COOL=2, HOLD=30 → avg_n=488, ROI cao hơn/trade

Run: python3 general-rule-g15.py [a|e]
"""
import json, datetime, bisect, sys
from collections import defaultdict

CACHE_5M   = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
CACHE_ETH  = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-eth-5m-7y.json"
CACHE_FUND = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-funding-7y.json"
CAPITAL    = 100_000
VARIANT    = sys.argv[1] if len(sys.argv)>1 else "e"

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
def fund_at(t): j=bisect.bisect_right(ft,t)-1; return fund_entries[j][1] if j>=0 else 0

# Build bars
b4=build_tf(4*3600*1000,raw_btc); b1h=build_tf(3600*1000,raw_btc)
b1d_btc=build_tf(24*3600*1000,raw_btc)
b4e=build_tf(4*3600*1000,raw_eth); b1d_eth=build_tf(24*3600*1000,raw_eth)

# BTC 4h indicators
c4=[b["close"] for b in b4]; h4=[b["high"] for b in b4]; l4=[b["low"] for b in b4]; t4=[b["time"] for b in b4]
e200_4=ema_s(c4,200); e20_4=ema_s(c4,20)
adx4,pdi4,mdi4=adx_di_s(b4,14); rsi4=rsi_s(c4,14); atr4=atr_s(b4,14)
atr_pct4=[None]*len(b4)
for i in range(200,len(b4)):
    w=[x for x in atr4[i-200:i] if x is not None]
    if w and atr4[i]: atr_pct4[i]=sum(1 for x in w if x<atr4[i])/len(w)
c1d=[b["close"] for b in b1d_btc]; t1d=[b["time"] for b in b1d_btc]
e200d_btc=ema_s(c1d,200)
def e200d_btc_at(t): j=bisect.bisect_right(t1d,t)-1; return e200d_btc[j] if 0<=j<len(e200d_btc) else None

# BTC 1h indicators
c1=[b["close"] for b in b1h]; h1=[b["high"] for b in b1h]; l1=[b["low"] for b in b1h]
e200_1=ema_s(c1,200); e20_1=ema_s(c1,20)
adx1,pdi1,mdi1=adx_di_s(b1h,14); rsi1=rsi_s(c1,14); atr1=atr_s(b1h,14)
atr_pct1=[None]*len(b1h)
for i in range(200,len(b1h)):
    w=[x for x in atr1[i-200:i] if x is not None]
    if w and atr1[i]: atr_pct1[i]=sum(1 for x in w if x<atr1[i])/len(w)

# ETH 4h indicators
c4e=[b["close"] for b in b4e]; h4e=[b["high"] for b in b4e]; l4e=[b["low"] for b in b4e]
e200_4e=ema_s(c4e,200); e20_4e=ema_s(c4e,20)
adx4e,pdi4e,mdi4e=adx_di_s(b4e,14); rsi4e=rsi_s(c4e,14); atr4e=atr_s(b4e,14)
atr_pct4e=[None]*len(b4e)
for i in range(200,len(b4e)):
    w=[x for x in atr4e[i-200:i] if x is not None]
    if w and atr4e[i]: atr_pct4e[i]=sum(1 for x in w if x<atr4e[i])/len(w)
c1de=[b["close"] for b in b1d_eth]; t1de=[b["time"] for b in b1d_eth]
e200d_eth=ema_s(c1de,200)
def e200d_eth_at(t): j=bisect.bisect_right(t1de,t)-1; return e200d_eth[j] if 0<=j<len(e200d_eth) else None

print("Running BTC 4h (G13d)...")
def run_btc4h():
    positions=[]; trades=[]; last_entry=-999
    for i in range(200, len(b4)-61):
        yr=datetime.datetime.utcfromtimestamp(b4[i]["time"]/1000).year
        new_pos=[]
        for pos in positions:
            ei,epx,slpx,tppx,pyr,tnot=pos; xpx=c4[i]; done=False
            if l4[i]<=slpx: xpx=slpx; done=True
            elif h4[i]>=tppx: xpx=tppx; done=True
            elif e20_4[i] and c4[i]<e20_4[i] and i-ei>=10: done=True
            elif i-ei>=60: done=True
            if done: pnl=(xpx-epx)/epx*tnot*10-0.0006*tnot; trades.append({"yr":pyr,"pnl":pnl})
            else: new_pos.append(pos)
        positions=new_pos
        if len(positions)>=5 or i-last_entry<2: continue
        a=adx4[i]; pp=pdi4[i]; mm=mdi4[i]; r=rsi4[i]; e2=e200_4[i]; at=atr4[i]
        if None in (a,pp,mm,r,e2,at): continue
        fr=fund_at(b4[i]["time"]); price=c4[i]
        e2d=e200d_btc_at(b4[i]["time"])
        if e2d is None: continue
        if price>=e2d*0.85 and a>18 and pp>mm*0.95 and price>e2 and fr<0.0005 and r<72:
            pctile=atr_pct4[i] or 0.5
            tnot=28000*max(0.3, 1.0-pctile)
            positions.append((i,price,price-1.8*at,price+8*at,yr,tnot)); last_entry=i
    by_yr=defaultdict(list)
    for t in trades: by_yr[t["yr"]].append(t)
    return by_yr

def run_btc1h(NOT=20000, COOL=2, HOLD=30):
    positions=[]; trades=[]; last_entry=-999
    for i in range(200, len(b1h)-HOLD-1):
        yr=datetime.datetime.utcfromtimestamp(b1h[i]["time"]/1000).year
        new_pos=[]
        for pos in positions:
            ei,epx,slpx,tppx,pyr,tnot=pos; xpx=c1[i]; done=False
            if l1[i]<=slpx: xpx=slpx; done=True
            elif h1[i]>=tppx: xpx=tppx; done=True
            elif e20_1[i] and c1[i]<e20_1[i] and i-ei>=4: done=True
            elif i-ei>=HOLD: done=True
            if done: pnl=(xpx-epx)/epx*tnot*10-0.0006*tnot; trades.append({"yr":pyr,"pnl":pnl})
            else: new_pos.append(pos)
        positions=new_pos
        if len(positions)>=3 or i-last_entry<COOL: continue
        a=adx1[i]; pp=pdi1[i]; mm=mdi1[i]; r=rsi1[i]; e2=e200_1[i]; at=atr1[i]
        if None in (a,pp,mm,r,e2,at): continue
        fr=fund_at(b1h[i]["time"]); price=c1[i]
        e2d=e200d_btc_at(b1h[i]["time"])
        if e2d is None: continue
        j=bisect.bisect_right(t4,b1h[i]["time"])-1
        if j<0 or adx4[j] is None: continue
        if not (adx4[j]>18 and pdi4[j]>mdi4[j]*0.95 and c4[j]>e200_4[j]): continue
        if price>=e2d*0.85 and a>18 and pp>mm*0.95 and price>e2 and fr<0.0005 and r<72:
            pctile=atr_pct1[i] or 0.5
            tnot=NOT*max(0.3, 1.0-pctile)
            positions.append((i,price,price-1.8*at,price+8*at,yr,tnot)); last_entry=i
    by_yr=defaultdict(list)
    for t in trades: by_yr[t["yr"]].append(t)
    return by_yr

def run_eth():
    positions=[]; trades=[]; last_entry=-999
    for i in range(200, len(b4e)-61):
        yr=datetime.datetime.utcfromtimestamp(b4e[i]["time"]/1000).year
        new_pos=[]
        for pos in positions:
            ei,epx,slpx,tppx,pyr,tnot=pos; xpx=c4e[i]; done=False
            if l4e[i]<=slpx: xpx=slpx; done=True
            elif h4e[i]>=tppx: xpx=tppx; done=True
            elif e20_4e[i] and c4e[i]<e20_4e[i] and i-ei>=10: done=True
            elif i-ei>=60: done=True
            if done: pnl=(xpx-epx)/epx*tnot*10-0.0006*tnot; trades.append({"yr":pyr,"pnl":pnl})
            else: new_pos.append(pos)
        positions=new_pos
        if len(positions)>=5 or i-last_entry<2: continue
        a=adx4e[i]; pp=pdi4e[i]; mm=mdi4e[i]; r=rsi4e[i]; e2=e200_4e[i]; at=atr4e[i]
        if None in (a,pp,mm,r,e2,at): continue
        fr=fund_at(b4e[i]["time"]); price=c4e[i]
        e2d=e200d_eth_at(b4e[i]["time"])
        if e2d is None: continue
        ratio=price/e2d
        if 0.85<=ratio<=1.05 and a>20 and pp>mm*1.1 and price>e2 and fr<0.0005 and r<72:
            pctile=atr_pct4e[i] or 0.5
            tnot=28000*max(0.3, 1.0-pctile)
            positions.append((i,price,price-1.8*at,price+8*at,yr,tnot)); last_entry=i
    by_yr=defaultdict(list)
    for t in trades: by_yr[t["yr"]].append(t)
    return by_yr

btc4 = run_btc4h()
if VARIANT=="a":
    print("Running BTC 1h addon (G15a: NOT=14k, COOL=1, HOLD=24)...")
    btc1h = run_btc1h(NOT=14000, COOL=1, HOLD=24)
else:
    print("Running BTC 1h addon (G15e: NOT=20k, COOL=2, HOLD=30)...")
    btc1h = run_btc1h(NOT=20000, COOL=2, HOLD=30)
print("Running ETH retest-zone...")
eth = run_eth()

label="G15a" if VARIANT=="a" else "G15e"
print(f"\n{'Yr':>5}{'n4h':>6}{'n1h':>6}{'nETH':>6}{'nTot':>6}{'ROI4h':>9}{'ROI1h':>9}{'ROIeth':>9}{'TOTAL':>9}  KPI")
kn=kr=0
for yr in range(2019,2027):
    b4t=btc4.get(yr,[]); b1t=btc1h.get(yr,[]); et=eth.get(yr,[])
    n=len(b4t)+len(b1t)+len(et)
    r4=sum(t["pnl"] for t in b4t)/CAPITAL*100
    r1=sum(t["pnl"] for t in b1t)/CAPITAL*100
    re=sum(t["pnl"] for t in et)/CAPITAL*100
    rt=r4+r1+re
    nt=21 if yr==2026 else 50; rt_thr=21 if yr==2026 else 50
    ok_n=n>=nt; ok_r=rt>=rt_thr
    if ok_n: kn+=1
    if ok_r: kr+=1
    m="✓✓" if ok_n and ok_r else "✓✗" if ok_n else "✗✓" if ok_r else "✗✗"
    re_s=f"{re:>+8.1f}%" if et else "       N/A"
    print(f"  {yr}{len(b4t):>6}{len(b1t):>6}{len(et):>6}{n:>6}{r4:>+8.1f}%{r1:>+8.1f}%{re_s:>10}{rt:>+8.1f}%  {m}")
score=min(kn,kr)
avg_n=sum(len(btc4.get(yr,[]))+len(btc1h.get(yr,[]))+len(eth.get(yr,[])) for yr in range(2019,2027))/8
print(f"\n★★★ {label}: n:{kn}/8  roi:{kr}/8  COMBO={score}/8 = {score/8*100:.0f}%  avg_n={avg_n:.0f}")
print(f"\nBTC 4h: G13d (ADX>18, DI>0.95, EMA200 4h/1d, BEAR_GATE=0.85, fund<0.05%, RSI<72)")
print(f"        vol-size=28k×(1-ATRpct) floor=0.3, SL=1.8, TP=8, HOLD=60×4h")
if VARIANT=="a":
    print(f"BTC 1h: same conditions + require 4h trend active, NOT=14k, COOL=1bar, HOLD=24×1h")
else:
    print(f"BTC 1h: same conditions + require 4h trend active, NOT=20k, COOL=2bar, HOLD=30×1h")
print(f"ETH 4h: retest-zone [0.85-1.05]×EMA200d, ADX>20, DI>1.1, same sizing")
