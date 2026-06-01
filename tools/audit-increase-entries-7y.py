#!/usr/bin/env python3
"""
audit-increase-entries-7y.py — Tăng entries/tháng mà giữ 80%+ monthly win

Baseline winner: BB×1.5 + RSI×1.0 + STOCH×1.0 | CD=2h | ATR40 = 82% (94/yr, ~8/mo)
Tháng ít entry nhất: 2021-Sep(4), 2023-Mar(1), 2024-Jul(1), 2025-Feb(1), 2025-Mar(3)

Approaches:
  1. CD=1h (giảm cooldown)
  2. ATR 30th/35th (relax volatility filter)
  3. Thêm signal: RSI30, EMA9_reclaim, Don10
  4. Mixed CD per signal (mỗi signal có CD riêng nhỏ hơn)
  5. Combo tốt nhất
"""
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
def don_lo(bars,n):
    out=[None]*len(bars)
    for i in range(n,len(bars)): out[i]=min(bars[j]["low"] for j in range(i-n,i))
    return out
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

print("Computing indicators...")
atr4=atr_w(bars4h); adx4=adx_w(bars4h)
atr1h=atr_w(bars1h); rsi1h=rsi_s(c1h); stk1h=stoch_s(bars1h)
e200_1h=ema(c1h,200); e9_1h=ema(c1h,9)
bbu,bbl=bb_s(c1h); dl10=don_lo(bars1h,10)
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

print("Precomputing contexts...")
def make_ctx(atr_pct):
    out=[False]*n4h
    for i4h in range(50,n4h):
        if reg_map.get(bars4h[i4h]["time"]//86400000,"RANGE")!="RANGE": continue
        adv=adx4[i4h];adv_p=adx4[i4h-1] if i4h>0 else None
        if adv is None or adv<=20 or adv_p is None or adv_p<=20: continue
        if atr_pct>0:
            if i4h<ATR_LB+14: continue
            vs=[atr4[j]/c4h[j] for j in range(i4h-ATR_LB,i4h) if atr4[j] and c4h[j]]
            if len(vs)<ATR_LB: continue
            cur=atr4[i4h]/c4h[i4h] if atr4[i4h] and c4h[i4h] else None
            if cur is None or cur<sorted(vs)[int(len(vs)*atr_pct)]: continue
        out[i4h]=True
    return out

ctx40=make_ctx(0.40); ctx35=make_ctx(0.35); ctx30=make_ctx(0.30); ctx25=make_ctx(0.25)

def filt1h(i, ctx):
    e1h=e200_1h[i]
    if e1h and c1h[i]<e1h: return False
    i4h=get_4h_idx(bars1h[i]["time"])
    return 0<=i4h<n4h and ctx[i4h]

# Signals
def sig_bb(i): return bbl[i] and bars1h[i]["low"]<=bbl[i] and c1h[i]>bars1h[i]["open"]
def sig_rsi40(i): return rsi1h[i] and rsi1h[i-1] and rsi1h[i-1]<40 and rsi1h[i]>=40
def sig_rsi30(i): return rsi1h[i] and rsi1h[i-1] and rsi1h[i-1]<30 and rsi1h[i]>=30
def sig_stoch(i): return stk1h[i] and stk1h[i-1] and stk1h[i-1]<20 and stk1h[i]>=20
def sig_ema9r(i): return e9_1h[i] and e9_1h[i-1] and c1h[i-1]<e9_1h[i-1] and c1h[i]>=e9_1h[i]
def sig_don10r(i): return dl10[i] and c1h[i]>dl10[i] and (i==0 or c1h[i-1]<=dl10[i-1])

SIG_MAP = {
    "BB":   (sig_bb,   2., 1.5, 24),
    "RSI40":(sig_rsi40,2., 1.0, 24),
    "RSI30":(sig_rsi30,2., 1.0, 24),
    "STOCH":(sig_stoch,2., 1.0, 24),
    "EMA9R":(sig_ema9r,2., 1.5, 24),
    "DON10":(sig_don10r,2.,1.5, 24),
}

def sim(i,sl_m,tp_m,max_h=24):
    ep=c1h[i];ae=atr1h[i]
    if ae is None or ae<=0: return None
    sl=ep-ae*sl_m;tp=ep+ae*tp_m
    for h in range(1,max_h+1):
        j=i+h
        if j>=n1h: break
        if bars1h[j]["low"]<=sl: return (sl-ep)/ep-2*FEE
        if bars1h[j]["high"]>=tp: return (tp-ep)/ep-2*FEE
    return (c1h[min(i+max_h,n1h-1)]-ep)/ep-2*FEE

def run(signal_cds, ctx):
    """signal_cds: dict of sig_name → cooldown_h"""
    trades=[]; last={s:-cd for s,cd in signal_cds.items()}
    for i in range(50,n1h-48):
        if not filt1h(i,ctx): continue
        ts=bars1h[i]["time"]; yr=datetime.datetime.utcfromtimestamp(ts/1000).year
        mo=yr*100+datetime.datetime.utcfromtimestamp(ts/1000).month
        for sig,(sig_fn,sl_m,tp_m,max_h) in SIG_MAP.items():
            if sig not in signal_cds: continue
            cd=signal_cds[sig]
            if not sig_fn(i): continue
            if i-last[sig]<cd: continue
            r=sim(i,sl_m,tp_m,max_h)
            if r is not None:
                trades.append({"ret":r,"mo":mo,"yr":yr,"sig":sig}); last[sig]=i
    return trades

def stats(trades, label, show_table=False):
    if not trades: return None
    by_mo=defaultdict(list)
    for t in trades: by_mo[t["mo"]].append(t)
    mos=sorted(by_mo.keys()); win_mo=sum(1 for m in mos if sum(t["ret"] for t in by_mo[m])>0)
    win_pct=win_mo/len(mos)*100
    rets=[t["ret"] for t in trades]; n_=len(rets)
    mean=sum(rets)/n_; sd=(sum((r-mean)**2 for r in rets)/n_)**0.5 or 1e-9
    ra=mean/sd; wr=sum(1 for r in rets if r>0)/n_*100
    by_yr=defaultdict(float)
    for t in trades: by_yr[t["yr"]]+=t["ret"]
    stab=sum(1 for v in by_yr.values() if v>0)
    n_mo=n_/len(mos)
    flag="✅" if win_pct>=80 else ("⚠️" if win_pct>=75 else "✗")
    print(f"  {label:55s}: {win_pct:.0f}%({win_mo}/{len(mos)}) {n_//7}/yr({n_mo:.0f}/mo) RA={ra:+.3f} WR={wr:.0f}% stab={stab}/6 {flag}")
    if show_table and win_pct>=80:
        print(f"\n  Per-month detail:")
        MN=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
        for mo in mos:
            ts_mo=by_mo[mo]; yr=mo//100; mn=mo%100
            roi=sum(t["ret"] for t in ts_mo)*100; n_m=len(ts_mo); w=sum(1 for t in ts_mo if t["ret"]>0)
            st="✅" if roi>0 else "❌"
            print(f"    {yr} {MN[mn-1]:>3}: n={n_m:3d} W={w:2d} ROI={roi:+5.1f}% {st}")
    return {"label":label,"win_pct":win_pct,"win_mo":win_mo,"tot_mo":len(mos),"n":n_,"ra":ra,"wr":wr,"stab":stab,"n_mo":n_mo}

BASE = {"BB":2,"RSI40":2,"STOCH":2}  # baseline

print("\n" + "="*75)
print("INCREASE ENTRIES PER MONTH")
print(f"Baseline: BB+RSI40+STOCH CD=2h ATR40 = 82% (94/yr ~8/mo)")
print("="*75)

results=[]
print("\n[A] Reduce cooldown]")
for cd in [1,2,3]:
    r=stats(run({s:cd for s in BASE},ctx40), f"ALL CD={cd}h ATR40")
    if r: results.append(r)

print("\n[B] Per-signal different CD]")
for cd_bb,cd_rsi,cd_stoch in [(1,2,1),(1,1,1),(1,2,2),(2,1,1)]:
    r=stats(run({"BB":cd_bb,"RSI40":cd_rsi,"STOCH":cd_stoch},ctx40),
            f"BB={cd_bb}h RSI={cd_rsi}h STOCH={cd_stoch}h ATR40")
    if r: results.append(r)

print("\n[C] Relax ATR filter]")
for pct,ctx in [(0.35,ctx35),(0.30,ctx30),(0.25,ctx25)]:
    r=stats(run({s:2 for s in BASE},ctx), f"CD=2h ATR{int(pct*100)}th")
    if r: results.append(r)

print("\n[D] Add more signal types]")
for extra_sigs,name in [
    ({"BB":2,"RSI40":2,"RSI30":2,"STOCH":2},"+RSI30 CD=2h ATR40"),
    ({"BB":2,"RSI40":2,"STOCH":2,"EMA9R":2},"+ EMA9_reclaim CD=2h ATR40"),
    ({"BB":2,"RSI40":2,"STOCH":2,"DON10":2},"+ DON10_reclaim CD=2h ATR40"),
    ({"BB":1,"RSI40":1,"STOCH":1,"RSI30":1},"ALL4 CD=1h ATR40"),
    ({"BB":2,"RSI40":2,"STOCH":2,"RSI30":2,"EMA9R":2},"ALL5 CD=2h ATR40"),
]:
    r=stats(run(extra_sigs,ctx40), name)
    if r: results.append(r)

print("\n[E] Combined best: CD=1h + ATR35 + more signals]")
for combo,ctx,name in [
    ({"BB":1,"RSI40":1,"STOCH":1},ctx35,"CD=1h ATR35"),
    ({"BB":1,"RSI40":1,"STOCH":1},ctx30,"CD=1h ATR30"),
    ({"BB":1,"RSI40":1,"RSI30":1,"STOCH":1},ctx35,"BB+RSI40+RSI30+STOCH CD=1h ATR35"),
    ({"BB":1,"RSI40":1,"RSI30":1,"STOCH":1},ctx30,"BB+RSI40+RSI30+STOCH CD=1h ATR30"),
    ({"BB":1,"RSI40":1,"STOCH":1,"EMA9R":1},ctx35,"BB+RSI40+STOCH+EMA9R CD=1h ATR35"),
    ({"BB":2,"RSI40":1,"STOCH":1,"RSI30":2},ctx35,"BB=2h RSI40=1h STOCH=1h RSI30=2h ATR35"),
]:
    r=stats(run(combo,ctx), name)
    if r: results.append(r)

# RANKING
print("\n" + "="*75)
print("RANKING — giữ 80%+, nhiều entry nhất")
print("="*75)
results.sort(key=lambda x: (x["win_pct"]>=80, x["n_mo"]), reverse=True)
print(f"\n  {'Config':55s}  {'win%':>6}  {'n/yr':>6}  {'n/mo':>6}  {'RA':>7}  {'WR':>5}")
for r in results[:15]:
    flag="✅" if r["win_pct"]>=80 else ("⚠️" if r["win_pct"]>=75 else "")
    print(f"  {r['label']:55s}  {r['win_pct']:>5.0f}%  {r['n']//7:>6}  {r['n_mo']:>5.1f}  {r['ra']:>+7.3f}  {r['wr']:>4.0f}%  {flag}")

# Show best 80%+ config in detail
best80=[r for r in results if r["win_pct"]>=80]
if best80:
    best80.sort(key=lambda x:x["n_mo"],reverse=True)
    b=best80[0]
    print(f"\n  ⭐ BEST (80%+ với nhiều entry nhất): {b['label']}")
    print(f"     {b['win_pct']:.0f}% monthly win | {b['n']//7}/yr ({b['n_mo']:.0f}/mo avg) | RA={b['ra']:+.3f}")
    # Re-run to show full monthly table
    print(f"\n  Full monthly table for best config:")
    # Parse config from label to re-run
