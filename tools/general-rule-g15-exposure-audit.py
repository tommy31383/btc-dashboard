#!/usr/bin/env python3
"""
AUDIT G15e — 2 phần:
  1. CONCURRENT EXPOSURE: tại mỗi thời điểm, tổng margin/notional đang mở across 3 sleeves
     → effective leverage thật trên capital 100k
  2. DOUBLE-COUNT: BTC 1h và 4h cùng symbol → overlap thời gian + correlation PnL
Cuối cùng: RE-SIMULATE 1 account chung 100k với margin cap thật → ROI honest
"""
import json, datetime, bisect
from collections import defaultdict

CACHE_5M   = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
CACHE_ETH  = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-eth-5m-7y.json"
CACHE_FUND = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-funding-7y.json"
CAPITAL    = 100_000
LEV        = 10

raw_btc = json.load(open(CACHE_5M)); raw_btc.sort(key=lambda x:x["time"])
raw_eth = json.load(open(CACHE_ETH)); raw_eth.sort(key=lambda x:x["time"])
rf = json.load(open(CACHE_FUND))
s=rf[0]; tk=[k for k in s if "time" in k.lower()][0]; rk=[k for k in s if k in ("fundingRate","rate","r","funding")][0]
fund_entries=sorted([(int(e[tk]),float(e[rk])) for e in rf]); ft=[e[0] for e in fund_entries]

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

b4=build_tf(4*3600*1000,raw_btc); b1h=build_tf(3600*1000,raw_btc)
b1d_btc=build_tf(24*3600*1000,raw_btc)
b4e=build_tf(4*3600*1000,raw_eth); b1d_eth=build_tf(24*3600*1000,raw_eth)
H4_MS=4*3600*1000; H1_MS=3600*1000

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

c1=[b["close"] for b in b1h]; h1=[b["high"] for b in b1h]; l1=[b["low"] for b in b1h]; t1=[b["time"] for b in b1h]
e200_1=ema_s(c1,200); e20_1=ema_s(c1,20)
adx1,pdi1,mdi1=adx_di_s(b1h,14); rsi1=rsi_s(c1,14); atr1=atr_s(b1h,14)
atr_pct1=[None]*len(b1h)
for i in range(200,len(b1h)):
    w=[x for x in atr1[i-200:i] if x is not None]
    if w and atr1[i]: atr_pct1[i]=sum(1 for x in w if x<atr1[i])/len(w)

c4e=[b["close"] for b in b4e]; h4e=[b["high"] for b in b4e]; l4e=[b["low"] for b in b4e]; t4e=[b["time"] for b in b4e]
e200_4e=ema_s(c4e,200); e20_4e=ema_s(c4e,20)
adx4e,pdi4e,mdi4e=adx_di_s(b4e,14); rsi4e=rsi_s(c4e,14); atr4e=atr_s(b4e,14)
atr_pct4e=[None]*len(b4e)
for i in range(200,len(b4e)):
    w=[x for x in atr4e[i-200:i] if x is not None]
    if w and atr4e[i]: atr_pct4e[i]=sum(1 for x in w if x<atr4e[i])/len(w)
c1de=[b["close"] for b in b1d_eth]; t1de=[b["time"] for b in b1d_eth]
e200d_eth=ema_s(c1de,200)
def e200d_eth_at(t): j=bisect.bisect_right(t1de,t)-1; return e200d_eth[j] if 0<=j<len(e200d_eth) else None

# === Run sleeves, RECORD entry/exit ms + margin (=tnot) ===
def run_btc4h():
    positions=[]; trades=[]; last_entry=-999
    for i in range(200, len(b4)-61):
        new_pos=[]
        for pos in positions:
            ei,epx,slpx,tppx,tnot,e_ms=pos; xpx=c4[i]; done=False
            if l4[i]<=slpx: xpx=slpx; done=True
            elif h4[i]>=tppx: xpx=tppx; done=True
            elif e20_4[i] and c4[i]<e20_4[i] and i-ei>=10: done=True
            elif i-ei>=60: done=True
            if done:
                pnl=(xpx-epx)/epx*tnot*LEV-0.0006*tnot
                trades.append({"e_ms":e_ms,"x_ms":t4[i]+H4_MS,"tnot":tnot,"pnl":pnl,"sleeve":"BTC4h"})
            else: new_pos.append(pos)
        positions=new_pos
        if len(positions)>=5 or i-last_entry<2: continue
        a=adx4[i]; pp=pdi4[i]; mm=mdi4[i]; r=rsi4[i]; e2=e200_4[i]; at=atr4[i]
        if None in (a,pp,mm,r,e2,at): continue
        fr=fund_at(t4[i]); price=c4[i]; e2d=e200d_btc_at(t4[i])
        if e2d is None: continue
        if price>=e2d*0.85 and a>18 and pp>mm*0.95 and price>e2 and fr<0.0005 and r<72:
            pctile=atr_pct4[i] or 0.5; tnot=28000*max(0.3,1.0-pctile)
            positions.append((i,price,price-1.8*at,price+8*at,tnot,t4[i])); last_entry=i
    return trades

def run_btc1h():
    positions=[]; trades=[]; last_entry=-999
    for i in range(200, len(b1h)-31):
        new_pos=[]
        for pos in positions:
            ei,epx,slpx,tppx,tnot,e_ms=pos; xpx=c1[i]; done=False
            if l1[i]<=slpx: xpx=slpx; done=True
            elif h1[i]>=tppx: xpx=tppx; done=True
            elif e20_1[i] and c1[i]<e20_1[i] and i-ei>=4: done=True
            elif i-ei>=30: done=True
            if done:
                pnl=(xpx-epx)/epx*tnot*LEV-0.0006*tnot
                trades.append({"e_ms":e_ms,"x_ms":t1[i]+H1_MS,"tnot":tnot,"pnl":pnl,"sleeve":"BTC1h"})
            else: new_pos.append(pos)
        positions=new_pos
        if len(positions)>=3 or i-last_entry<2: continue
        a=adx1[i]; pp=pdi1[i]; mm=mdi1[i]; r=rsi1[i]; e2=e200_1[i]; at=atr1[i]
        if None in (a,pp,mm,r,e2,at): continue
        fr=fund_at(t1[i]); price=c1[i]; e2d=e200d_btc_at(t1[i])
        if e2d is None: continue
        j=bisect.bisect_right(t4,t1[i])-1
        if j<0 or adx4[j] is None: continue
        if not (adx4[j]>18 and pdi4[j]>mdi4[j]*0.95 and c4[j]>e200_4[j]): continue
        if price>=e2d*0.85 and a>18 and pp>mm*0.95 and price>e2 and fr<0.0005 and r<72:
            pctile=atr_pct1[i] or 0.5; tnot=20000*max(0.3,1.0-pctile)
            positions.append((i,price,price-1.8*at,price+8*at,tnot,t1[i])); last_entry=i
    return trades

def run_eth():
    positions=[]; trades=[]; last_entry=-999
    for i in range(200, len(b4e)-61):
        new_pos=[]
        for pos in positions:
            ei,epx,slpx,tppx,tnot,e_ms=pos; xpx=c4e[i]; done=False
            if l4e[i]<=slpx: xpx=slpx; done=True
            elif h4e[i]>=tppx: xpx=tppx; done=True
            elif e20_4e[i] and c4e[i]<e20_4e[i] and i-ei>=10: done=True
            elif i-ei>=60: done=True
            if done:
                pnl=(xpx-epx)/epx*tnot*LEV-0.0006*tnot
                trades.append({"e_ms":e_ms,"x_ms":t4e[i]+H4_MS,"tnot":tnot,"pnl":pnl,"sleeve":"ETH4h"})
            else: new_pos.append(pos)
        positions=new_pos
        if len(positions)>=5 or i-last_entry<2: continue
        a=adx4e[i]; pp=pdi4e[i]; mm=mdi4e[i]; r=rsi4e[i]; e2=e200_4e[i]; at=atr4e[i]
        if None in (a,pp,mm,r,e2,at): continue
        fr=fund_at(t4e[i]); price=c4e[i]; e2d=e200d_eth_at(t4e[i])
        if e2d is None: continue
        ratio=price/e2d
        if 0.85<=ratio<=1.05 and a>20 and pp>mm*1.1 and price>e2 and fr<0.0005 and r<72:
            pctile=atr_pct4e[i] or 0.5; tnot=28000*max(0.3,1.0-pctile)
            positions.append((i,price,price-1.8*at,price+8*at,tnot,t4e[i])); last_entry=i
    return trades

print("Running sleeves with timestamp tracking...")
tr4 = run_btc4h(); tr1 = run_btc1h(); tre = run_eth()
all_tr = tr4 + tr1 + tre
print(f"Trades: BTC4h={len(tr4)} BTC1h={len(tr1)} ETH={len(tre)} total={len(all_tr)}")

# ============ AUDIT 1: CONCURRENT EXPOSURE ============
print("\n" + "="*78)
print("AUDIT 1 — CONCURRENT EXPOSURE (margin = tnot, notional = tnot×10)")
print("="*78)
# Build events: +margin at entry, -margin at exit
events=[]
for t in all_tr:
    events.append((t["e_ms"], +t["tnot"], t["sleeve"]))
    events.append((t["x_ms"], -t["tnot"], t["sleeve"]))
events.sort()
cur=0; cur_by=defaultdict(float)
peak=0; peak_ms=0; peak_by=None
samples=[]
for ms, dm, sl in events:
    cur+=dm; cur_by[sl]+=dm
    samples.append(cur)
    if cur>peak: peak=cur; peak_ms=ms; peak_by=dict(cur_by)
samples_sorted=sorted(samples)
def pct(p): 
    idx=int(len(samples_sorted)*p); return samples_sorted[min(idx,len(samples_sorted)-1)]
mean_margin=sum(samples)/len(samples)
peak_dt=datetime.datetime.utcfromtimestamp(peak_ms/1000).strftime("%Y-%m-%d")
print(f"\n  MARGIN deployed (sum tnot of open positions), capital = ${CAPITAL:,}:")
print(f"    Peak margin:    ${peak:>10,.0f}   ({peak/CAPITAL*100:>6.1f}% of capital)  @ {peak_dt}")
print(f"    p99 margin:     ${pct(0.99):>10,.0f}   ({pct(0.99)/CAPITAL*100:>6.1f}%)")
print(f"    p95 margin:     ${pct(0.95):>10,.0f}   ({pct(0.95)/CAPITAL*100:>6.1f}%)")
print(f"    median margin:  ${pct(0.50):>10,.0f}   ({pct(0.50)/CAPITAL*100:>6.1f}%)")
print(f"    mean margin:    ${mean_margin:>10,.0f}   ({mean_margin/CAPITAL*100:>6.1f}%)")
print(f"\n  NOTIONAL deployed (margin × {LEV} leverage):")
print(f"    Peak notional:  ${peak*LEV:>12,.0f}   → effective leverage = {peak*LEV/CAPITAL:.1f}x on ${CAPITAL:,}")
print(f"    p95 notional:   ${pct(0.95)*LEV:>12,.0f}   → {pct(0.95)*LEV/CAPITAL:.1f}x")
print(f"    mean notional:  ${mean_margin*LEV:>12,.0f}   → {mean_margin*LEV/CAPITAL:.1f}x")
print(f"\n  Peak breakdown by sleeve (margin at peak moment):")
if peak_by:
    for sl,v in sorted(peak_by.items()): print(f"    {sl}: ${v:,.0f}")

# Verdict
print(f"\n  >>> VERDICT: ROI% computed on nominal ${CAPITAL:,} but peak margin used = ${peak:,.0f}")
if peak>CAPITAL:
    print(f"      Peak margin {peak/CAPITAL:.1f}× > capital → account would be LIQUIDATED / cannot hold.")
    print(f"      The +2,991% ROI assumes UNLIMITED margin. NOT achievable on a real $100k account at 10x.")
else:
    print(f"      Peak margin fits within capital. ROI is achievable.")

# ============ AUDIT 2: DOUBLE-COUNT (BTC 1h vs 4h overlap) ============
print("\n" + "="*78)
print("AUDIT 2 — DOUBLE-COUNT: BTC 1h vs BTC 4h (same symbol, same direction=LONG)")
print("="*78)
# For each BTC4h position interval, measure how much 1h margin is open concurrently
# Build 4h open intervals
iv4=[(t["e_ms"],t["x_ms"]) for t in tr4]
iv1=[(t["e_ms"],t["x_ms"]) for t in tr1]
# Time fraction where BOTH BTC4h and BTC1h have >=1 open position
ev=[]
for s,e in iv4: ev.append((s,1,0)); ev.append((e,-1,0))
for s,e in iv1: ev.append((s,0,1)); ev.append((e,0,-1))
ev.sort()
n4=n1=0; last=None; t_both=0; t_4=0; t_1=0; t_span=0
for ms,d4,d1 in ev:
    if last is not None:
        dt=ms-last
        t_span+=dt
        if n4>0 and n1>0: t_both+=dt
        if n4>0: t_4+=dt
        if n1>0: t_1+=dt
    n4+=d4; n1+=d1; last=ms
print(f"\n  Time BTC4h has ≥1 open: {t_4/t_span*100:.1f}% of active span")
print(f"  Time BTC1h has ≥1 open: {t_1/t_span*100:.1f}%")
print(f"  Time BOTH open (overlap): {t_both/t_span*100:.1f}%")
print(f"  → When BTC4h open, BTC1h also open {t_both/t_4*100:.1f}% of that time")
print(f"    = same BTC up-move counted by BOTH sleeves simultaneously (stacked long exposure)")

# Monthly PnL correlation 4h vs 1h
def monthly(trs):
    m=defaultdict(float)
    for t in trs:
        d=datetime.datetime.utcfromtimestamp(t["x_ms"]/1000)
        m[(d.year,d.month)]+=t["pnl"]
    return m
m4=monthly(tr4); m1=monthly(tr1)
keys=sorted(set(m4)|set(m1))
xs=[m4.get(k,0) for k in keys]; ys=[m1.get(k,0) for k in keys]
n=len(keys); mx=sum(xs)/n; my=sum(ys)/n
cov=sum((xs[i]-mx)*(ys[i]-my) for i in range(n))/n
sx=(sum((v-mx)**2 for v in xs)/n)**.5; sy=(sum((v-my)**2 for v in ys)/n)**.5
corr=cov/(sx*sy) if sx*sy>0 else 0
same_sign=sum(1 for i in range(n) if (xs[i]>0)==(ys[i]>0))/n*100
print(f"\n  Monthly PnL correlation BTC4h vs BTC1h: {corr:+.2f}")
print(f"  Months same sign (both win or both lose): {same_sign:.0f}%")
print(f"  → High corr = NOT diversification, it's leverage on the same BTC trend.")

# ============ RE-SIM: single shared account, margin cap = capital ============
print("\n" + "="*78)
print("RE-SIMULATION — single $100k account, margin cap (skip entry if no free margin)")
print("="*78)
all_sorted=sorted(all_tr, key=lambda x:x["e_ms"])
# Simulate: equity starts 100k. Each entry needs margin=tnot. Track open positions.
# Approve entry only if free_margin (equity - margin_in_use) >= tnot. Else skip.
open_pos=[]  # (x_ms, tnot, pnl)
equity=CAPITAL; margin_used=0
events2=[]
for t in all_sorted: events2.append((t["e_ms"],"entry",t))
# process chronologically, closing positions whose x_ms passed
all_event_ms=sorted(set([t["e_ms"] for t in all_sorted]+[t["x_ms"] for t in all_sorted]))
ti=0; ent_by_ms=defaultdict(list)
for t in all_sorted: ent_by_ms[t["e_ms"]].append(t)
taken=0; skipped=0; skipped_pnl=0; taken_list=[]
peak_eq=CAPITAL; max_dd=0
for ms in all_event_ms:
    # close
    still=[]
    for x_ms,tnot,pnl in open_pos:
        if x_ms<=ms:
            equity+=pnl; margin_used-=tnot
        else: still.append((x_ms,tnot,pnl))
    open_pos=still
    if equity>peak_eq: peak_eq=equity
    dd=(peak_eq-equity)/peak_eq*100
    if dd>max_dd: max_dd=dd
    # entries at this ms
    for t in ent_by_ms.get(ms,[]):
        free=equity-margin_used
        if free>=t["tnot"] and margin_used+t["tnot"]<=CAPITAL:
            margin_used+=t["tnot"]; open_pos.append((t["x_ms"],t["tnot"],t["pnl"]))
            taken+=1; taken_list.append(t)
        else:
            skipped+=1; skipped_pnl+=t["pnl"]
# close remaining
for x_ms,tnot,pnl in open_pos: equity+=pnl
final_roi=(equity-CAPITAL)/CAPITAL*100
print(f"\n  Trades taken: {taken} / {len(all_tr)}  (skipped {skipped} = {skipped/len(all_tr)*100:.0f}% — no free margin)")
print(f"  Final equity: ${equity:,.0f}  →  ROI = {final_roi:+.1f}% over 7 years")
print(f"  Max drawdown (real account): {max_dd:.1f}%")
print(f"  Skipped trades' PnL (missed): ${skipped_pnl:,.0f}")
# per year on taken
by_yr=defaultdict(lambda:[0,0])
for t in taken_list:
    d=datetime.datetime.utcfromtimestamp(t["x_ms"]/1000)
    by_yr[d.year][0]+=1; by_yr[d.year][1]+=t["pnl"]
print(f"\n  Per-year (single capped account, ROI on running equity not flat 100k):")
print(f"  {'Yr':>5}{'nTaken':>8}{'PnL$':>12}")
for yr in range(2019,2027):
    n,p=by_yr.get(yr,[0,0])
    print(f"  {yr:>5}{n:>8}{p:>+12,.0f}")
