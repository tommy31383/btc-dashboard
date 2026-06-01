#!/usr/bin/env python3
"""report-monthly-detail-winner.py — Per-month n + ROI cho config winner"""
import json, datetime
from collections import defaultdict

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FEE   = 0.05 / 100

raw = json.load(open(CACHE)); raw.sort(key=lambda x: x["time"])

def agg_tf(bars,ms):
    b={}
    for c in bars:
        k=c["time"]//ms
        if k not in b:
            b[k]={"time":k*ms,"open":c["open"],"high":c["high"],"low":c["low"],"close":c["close"],"volume":c["volume"]}
        else:
            o=b[k];o["high"]=max(o["high"],c["high"]);o["low"]=min(o["low"],c["low"]);o["close"]=c["close"];o["volume"]+=c["volume"]
    return [b[k] for k in sorted(b)]

bars1h=agg_tf(raw,3600*1000); bars4h=agg_tf(raw,4*3600*1000); bars1d=agg_tf(raw,86400*1000)
n1h=len(bars1h); n4h=len(bars4h)
c1h=[b["close"] for b in bars1h]; c4h=[b["close"] for b in bars4h]

def ema(xs,p):
    k=2/(p+1);out=[None]*len(xs);e=None
    for i,x in enumerate(xs): e=x if e is None else x*k+e*(1-k);out[i]=e
    return out
def _dm_tr(bars):
    n=len(bars);pdm=[0.]*n;ndm=[0.]*n;tr=[0.]*n
    for i in range(1,n):
        up=bars[i]["high"]-bars[i-1]["high"];dn=bars[i-1]["low"]-bars[i]["low"]
        pdm[i]=up if up>dn and up>0 else 0;ndm[i]=dn if dn>up and dn>0 else 0
        tr[i]=max(bars[i]["high"]-bars[i]["low"],abs(bars[i]["high"]-bars[i-1]["close"]),abs(bars[i]["low"]-bars[i-1]["close"]))
    return pdm,ndm,tr
def adx_w(bars,p=14):
    pdm,ndm,tr=_dm_tr(bars);n=len(bars)
    smTR=sum(tr[1:p+1]);smPDM=sum(pdm[1:p+1]);smNDM=sum(ndm[1:p+1])
    dx_arr=[];adx_val=None;out=[None]*n
    for i in range(p+1,n):
        smTR=smTR-smTR/p+tr[i];smPDM=smPDM-smPDM/p+pdm[i];smNDM=smNDM-smNDM/p+ndm[i]
        pdi=smPDM/smTR*100 if smTR>0 else 0;ndi=smNDM/smTR*100 if smTR>0 else 0
        dx=abs(pdi-ndi)/(pdi+ndi)*100 if (pdi+ndi)>0 else 0;dx_arr.append(dx)
        if len(dx_arr)<p: continue
        elif len(dx_arr)==p: adx_val=sum(dx_arr)/p
        else: adx_val=(adx_val*(p-1)+dx)/p
        out[i]=adx_val
    return out
def atr_w(bars,p=14):
    _,_,tr=_dm_tr(bars);n=len(bars);out=[None]*n
    s=sum(tr[1:p+1]);out[p]=s/p
    for i in range(p+1,n): out[i]=(out[i-1]*(p-1)+tr[i])/p
    return out
def rsi_s(cls,n=14):
    out=[None]*len(cls);ag=al=0.
    for i in range(1,n+1):
        d=cls[i]-cls[i-1]
        if d>0: ag+=d
        else: al-=d
    ag/=n;al/=n;out[n]=100-100/(1+ag/al) if al>0 else 100
    for i in range(n+1,len(cls)):
        d=cls[i]-cls[i-1];g=max(d,0);l=max(-d,0)
        ag=(ag*(n-1)+g)/n;al=(al*(n-1)+l)/n
        out[i]=100-100/(1+ag/al) if al>0 else 100
    return out
def stoch_s(bars,n=14):
    out=[None]*len(bars)
    for i in range(n-1,len(bars)):
        hi=max(b["high"] for b in bars[i-n+1:i+1]);lo=min(b["low"] for b in bars[i-n+1:i+1])
        out[i]=100*(bars[i]["close"]-lo)/(hi-lo) if hi>lo else 50
    return out
def bb_s(cls,n=20,k=2.):
    u=[None]*len(cls);l=[None]*len(cls)
    for i in range(n-1,len(cls)):
        w=cls[i-n+1:i+1];m=sum(w)/n;s=(sum((x-m)**2 for x in w)/n)**0.5
        u[i]=m+k*s;l[i]=m-k*s
    return u,l
def regime_wp(bars1d,persist=3):
    cs=[b["close"] for b in bars1d];n=len(bars1d);raw=["RANGE"]*n
    for i in range(200,n):
        ma200=sum(cs[i-199:i+1])/200;ma50=sum(cs[i-50:i+1])/50
        ar=sum((b["high"]-b["low"])/b["close"] for b in bars1d[i-19:i+1])/20
        if cs[i]<ma200: raw[i]="BEAR"
        elif cs[i]>ma50 and ma50>ma200 and ar>0.04: raw[i]="BULL"
    out=["RANGE"]*n;cur="RANGE";cnt=0;lr="RANGE"
    for i in range(n):
        r=raw[i]
        if r==lr: cnt+=1
        else: cnt=1;lr=r
        if cnt>=persist: cur=r
        out[i]=cur
    return out

atr4=atr_w(bars4h); adx4=adx_w(bars4h)
atr1h=atr_w(bars1h); rsi1h=rsi_s(c1h); stk1h=stoch_s(bars1h)
e200_1h=ema(c1h,200)
bbu,bbl=bb_s(c1h)
reg1d=regime_wp(bars1d); reg_map={}
for i,b in enumerate(bars1d): reg_map[b["time"]//86400000]=reg1d[i]
ATR_LB=90
ts4h=[b["time"] for b in bars4h]
def get_4h_idx(ts):
    k=ts//(4*3600*1000);lo,hi,idx=0,len(ts4h)-1,0
    while lo<=hi:
        m=(lo+hi)//2
        if ts4h[m]//(4*3600*1000)<=k: idx=m;lo=m+1
        else: hi=m-1
    return idx
def ctx40_ok(i4h):
    if i4h<50: return False
    if reg_map.get(bars4h[i4h]["time"]//86400000,"RANGE")!="RANGE": return False
    adv=adx4[i4h];adv_p=adx4[i4h-1] if i4h>0 else None
    if adv is None or adv<=20 or adv_p is None or adv_p<=20: return False
    if i4h<ATR_LB+14: return False
    vs=[atr4[j]/c4h[j] for j in range(i4h-ATR_LB,i4h) if atr4[j] and c4h[j]]
    if len(vs)<ATR_LB: return False
    cur=atr4[i4h]/c4h[i4h] if atr4[i4h] and c4h[i4h] else None
    return cur is not None and cur>=sorted(vs)[int(len(vs)*.4)]
ctx40=[ctx40_ok(i) for i in range(n4h)]

def filt1h(i):
    e1h=e200_1h[i]
    if e1h and c1h[i]<e1h: return False
    i4h=get_4h_idx(bars1h[i]["time"])
    return 0<=i4h<n4h and ctx40[i4h]

def sig_bb(i): return bbl[i] and bars1h[i]["low"]<=bbl[i] and c1h[i]>bars1h[i]["open"]
def sig_rsi(i): return rsi1h[i] and rsi1h[i-1] and rsi1h[i-1]<40 and rsi1h[i]>=40
def sig_stoch(i): return stk1h[i] and stk1h[i-1] and stk1h[i-1]<20 and stk1h[i]>=20

def sim(i,sl_m,tp_m,max_h=24):
    ep=c1h[i];ae=atr1h[i]
    if ae is None or ae<=0: return None
    sl=ep-ae*sl_m;tp=ep+ae*tp_m
    for h in range(1,max_h+1):
        j=i+h
        if j>=n1h: break
        if bars1h[j]["low"]<=sl: return (sl-ep)/ep-2*FEE
        if bars1h[j]["high"]>=tp: return (tp-ep)/ep-2*FEE
    j2=min(i+max_h,n1h-1)
    return (c1h[j2]-ep)/ep-2*FEE

# WINNER CONFIG
trades=[]; last_bb=-2; last_rsi=-2; last_stoch=-2
for i in range(50,n1h-48):
    if not filt1h(i): continue
    ts=bars1h[i]["time"]
    yr=datetime.datetime.utcfromtimestamp(ts/1000).year
    mo=yr*100+datetime.datetime.utcfromtimestamp(ts/1000).month
    if sig_bb(i) and i-last_bb>=2:
        r=sim(i,2.,1.5)
        if r is not None: trades.append({"ret":r,"mo":mo,"yr":yr,"sig":"BB"}); last_bb=i
    if sig_rsi(i) and i-last_rsi>=2:
        r=sim(i,2.,1.0)
        if r is not None: trades.append({"ret":r,"mo":mo,"yr":yr,"sig":"RSI"}); last_rsi=i
    if sig_stoch(i) and i-last_stoch>=2:
        r=sim(i,2.,1.0)
        if r is not None: trades.append({"ret":r,"mo":mo,"yr":yr,"sig":"STOCH"}); last_stoch=i

# Per-month stats
by_mo=defaultdict(list)
for t in trades: by_mo[t["mo"]].append(t)

MN=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]

print("="*100)
print("WINNER: BB×1.5 + RSI×1.0 + STOCH×1.0  |  SL×2 ATR  |  CD=2h  |  ATR40 + RANGE + ADX + EMA200_1h")
print("="*100)
print(f"\n{'Yr':>4} {'Mth':>3} {'n':>4} {'BB':>3} {'RSI':>3} {'STK':>3} {'W':>3} {'L':>3} {'WR':>5} {'ROI%':>7}  Status")
print("─"*100)

months_sorted=sorted(by_mo.keys())
by_yr_summary=defaultdict(lambda:{"n":0,"roi":0,"win_mo":0,"tot_mo":0})

for mo in months_sorted:
    ts_mo=by_mo[mo]
    yr=mo//100; mn=mo%100
    n_mo=len(ts_mo)
    bb_n=sum(1 for t in ts_mo if t["sig"]=="BB")
    rsi_n=sum(1 for t in ts_mo if t["sig"]=="RSI")
    stk_n=sum(1 for t in ts_mo if t["sig"]=="STOCH")
    wins=sum(1 for t in ts_mo if t["ret"]>0)
    losses=n_mo-wins
    wr=wins/n_mo*100 if n_mo else 0
    roi=sum(t["ret"] for t in ts_mo)*100
    status="✅" if roi>0 else "❌"
    print(f"  {yr:4d} {MN[mn-1]:>3}  {n_mo:3d}  {bb_n:2d}  {rsi_n:2d}  {stk_n:2d}  {wins:2d}  {losses:2d}  {wr:4.0f}%  {roi:+6.1f}%  {status}")
    by_yr_summary[yr]["n"]+=n_mo; by_yr_summary[yr]["roi"]+=roi
    by_yr_summary[yr]["win_mo"]+=(1 if roi>0 else 0); by_yr_summary[yr]["tot_mo"]+=1

print("─"*100)

# Per-year summary
print(f"\n{'Year':>6}  {'n/yr':>6}  {'ROI%':>8}  {'Win months':>12}  {'Avg n/mo':>10}")
for yr in sorted(by_yr_summary):
    s=by_yr_summary[yr]
    avg_n=s["n"]/s["tot_mo"] if s["tot_mo"] else 0
    flag="✅" if s["roi"]>0 else "❌"
    print(f"  {yr:4d}    {s['n']:5d}    {s['roi']:+7.1f}%    {s['win_mo']:2d}/{s['tot_mo']:2d} ({s['win_mo']/s['tot_mo']*100:.0f}%)       {avg_n:.1f}/mo  {flag}")

# Overall
total_mo=len(months_sorted)
win_mo=sum(1 for mo in months_sorted if sum(t["ret"] for t in by_mo[mo])>0)
total_n=len(trades)
total_roi=sum(t["ret"] for t in trades)*100
wins_all=sum(1 for t in trades if t["ret"]>0)
wr_all=wins_all/total_n*100

print(f"\n{'─'*100}")
print(f"  TOTAL: {total_n} trades ({total_n//7}/yr avg)  WR={wr_all:.0f}%  ROI={total_roi:+.1f}%")
print(f"  MONTHLY WIN: {win_mo}/{total_mo} = {win_mo/total_mo*100:.0f}%")
print(f"  YEARLY STAB: {sum(1 for s in by_yr_summary.values() if s['roi']>0)}/{len(by_yr_summary)} years positive")

# Signal breakdown
print(f"\n  Per-signal:")
for sig,tp in [("BB","×1.5"),("RSI","×1.0"),("STOCH","×1.0")]:
    ts=[t for t in trades if t["sig"]==sig]
    if not ts: continue
    r=sum(t["ret"] for t in ts)*100; w=sum(1 for t in ts if t["ret"]>0)
    print(f"    {sig:5s} TP{tp}: n={len(ts):4d}  WR={w/len(ts)*100:.0f}%  ROI={r:+.1f}%  avg/mo={len(ts)//7:.1f}")
