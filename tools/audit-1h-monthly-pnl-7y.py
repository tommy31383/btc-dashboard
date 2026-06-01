#!/usr/bin/env python3
"""
audit-1h-monthly-pnl-7y.py — Per-month PnL của 1h BB_low + RSI_x40
Mục tiêu: tối ưu config để MAX monthly win% (tháng dương)

Test matrix:
  SL/TP variants: TP×1.0, TP×1.5, TP×2.0, TP×3.0 (SL cố định ×2)
  Filter variants: baseline, +vol, +ema9>ema21 trend confirm, +both
  Signal variants: BB only, RSI only, BB+RSI

Report: từng tháng ROI + tổng win months / total months
"""
import json, datetime
from collections import defaultdict

CACHE  = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FEE    = 0.05 / 100
WF_CUT = int(datetime.datetime(2023,1,1).timestamp()*1000)

print("Loading data...")
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

def bb_s(cls,n=20,k=2.):
    u=[None]*len(cls);l=[None]*len(cls)
    for i in range(n-1,len(cls)):
        w=cls[i-n+1:i+1];m=sum(w)/n;s=(sum((x-m)**2 for x in w)/n)**0.5
        u[i]=m+k*s;l[i]=m-k*s
    return u,l

def vol_ma(bars,n):
    out=[None]*len(bars)
    for i in range(n-1,len(bars)): out[i]=sum(bars[j]["volume"] for j in range(i-n+1,i+1))/n
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

def atp4_pass(i,pct=.5):
    if i<ATR_LB+14: return False
    vs=[atr4[i2]/c4h[i2] for i2 in range(i-ATR_LB,i) if atr4[i2] and c4h[i2]]
    if len(vs)<ATR_LB: return False
    cur=atr4[i]/c4h[i] if atr4[i] and c4h[i] else None
    return cur is not None and cur>=sorted(vs)[int(len(vs)*pct)]

print("Computing indicators...")
atr4=atr_w(bars4h); adx4=adx_w(bars4h)
atr1h=atr_w(bars1h); rsi1h=rsi_s(c1h)
e200_1h=ema(c1h,200); e9_1h=ema(c1h,9); e21_1h=ema(c1h,21); e50_1h=ema(c1h,50)
bbu,bbl=bb_s(c1h); vma20_1h=vol_ma(bars1h,20)
reg1d=regime_wp(bars1d); reg_map={}
for i,b in enumerate(bars1d): reg_map[b["time"]//86400000]=reg1d[i]
def get_reg(ts): return reg_map.get(ts//86400000,"RANGE")
ATR_LB=90
ts4h=[b["time"] for b in bars4h]
def get_4h_idx(ts):
    k=ts//(4*3600*1000);lo,hi,idx=0,len(ts4h)-1,0
    while lo<=hi:
        m=(lo+hi)//2
        if ts4h[m]//(4*3600*1000)<=k: idx=m;lo=m+1
        else: hi=m-1
    return idx

def ctx4h_ok(i4h):
    if i4h<50: return False
    if get_reg(bars4h[i4h]["time"])!="RANGE": return False
    adv=adx4[i4h];adv_p=adx4[i4h-1] if i4h>0 else None
    if adv is None or adv<=20 or adv_p is None or adv_p<=20: return False
    return atp4_pass(i4h,.5)

print("Precomputing 4h context...")
ctx4h=[ctx4h_ok(i) for i in range(n4h)]

def filt1h_base(i):
    e1h=e200_1h[i]
    if e1h and c1h[i]<e1h: return False
    i4h=get_4h_idx(bars1h[i]["time"])
    return 0<=i4h<n4h and ctx4h[i4h]

def sig_bb(i):
    return bbl[i] is not None and bars1h[i]["low"]<=bbl[i] and bars1h[i]["close"]>bars1h[i]["open"]

def sig_rsi(i):
    return rsi1h[i] is not None and rsi1h[i-1] is not None and rsi1h[i-1]<40 and rsi1h[i]>=40

def sim(i,sl_m,tp_m,max_h=48):
    ep=c1h[i];ae=atr1h[i]
    if ae is None or ae<=0: return None
    sl=ep-ae*sl_m;tp=ep+ae*tp_m
    for h in range(1,max_h+1):
        j=i+h
        if j>=n1h: break
        if bars1h[j]["low"]<=sl: return (sl-ep)/ep-2*FEE,h,"SL"
        if bars1h[j]["high"]>=tp: return (tp-ep)/ep-2*FEE,h,"TP"
    j2=min(i+max_h,n1h-1)
    return (c1h[j2]-ep)/ep-2*FEE,max_h,"HOLD"

def run(sl_m,tp_m,use_bb,use_rsi,extra_filt=None,cd=4):
    trades=[];last_bb=-cd;last_rsi=-cd
    for i in range(50,n1h-50):
        if not filt1h_base(i): continue
        if extra_filt and not extra_filt(i): continue
        ts=bars1h[i]["time"]
        yr=datetime.datetime.utcfromtimestamp(ts/1000).year
        mo=yr*100+datetime.datetime.utcfromtimestamp(ts/1000).month
        if use_bb and sig_bb(i) and i-last_bb>=cd:
            r=sim(i,sl_m,tp_m)
            if r: ret,h,rsn=r; trades.append({"ret":ret,"mo":mo,"yr":yr,"sig":"BB","rsn":rsn}); last_bb=i
        if use_rsi and sig_rsi(i) and i-last_rsi>=cd:
            r=sim(i,sl_m,tp_m)
            if r: ret,h,rsn=r; trades.append({"ret":ret,"mo":mo,"yr":yr,"sig":"RSI","rsn":rsn}); last_rsi=i
    return trades

def monthly_table(trades, label, verbose=True):
    if not trades: return None
    by_mo=defaultdict(list)
    for t in trades: by_mo[t["mo"]].append(t["ret"])
    months_sorted=sorted(by_mo.keys())
    win_mo=[m for m in months_sorted if sum(by_mo[m])>0]
    loss_mo=[m for m in months_sorted if sum(by_mo[m])<=0]
    total_mo=len(months_sorted)
    win_pct=len(win_mo)/total_mo*100 if total_mo else 0
    rets=[t["ret"] for t in trades];n_=len(rets)
    mean=sum(rets)/n_;sd=(sum((r-mean)**2 for r in rets)/n_)**0.5 or 1e-9
    ra=mean/sd;wr=sum(1 for r in rets if r>0)/n_*100
    by_yr=defaultdict(float)
    for t in trades: by_yr[t["yr"]]+=t["ret"]
    stab=sum(1 for v in by_yr.values() if v>0)
    print(f"\n{'─'*70}")
    print(f"  {label}")
    print(f"  n={n_:4d}(~{n_//7}/yr) RA={ra:+.3f} WR={wr:.0f}% stab={stab}/{len(by_yr)}")
    print(f"  MONTHLY WIN: {len(win_mo)}/{total_mo} ({win_pct:.0f}%) ← {'✅' if win_pct>=70 else '⚠️' if win_pct>=60 else '✗'}")
    if verbose:
        # Per-year table
        by_yr_mo=defaultdict(dict)
        for m in months_sorted:
            yr=m//100; mn=m%100
            by_yr_mo[yr][mn]=sum(by_mo[m])
        print(f"\n  {'Yr':>4} {'Jan':>6} {'Feb':>6} {'Mar':>6} {'Apr':>6} {'May':>6} {'Jun':>6} {'Jul':>6} {'Aug':>6} {'Sep':>6} {'Oct':>6} {'Nov':>6} {'Dec':>6}  {'Win/Tot':>8}")
        for yr in sorted(by_yr_mo):
            row=""
            win=tot=0
            for mn in range(1,13):
                v=by_yr_mo[yr].get(mn)
                if v is None: row+=f"{'   —':>7}"
                else:
                    tot+=1; win+=(1 if v>0 else 0)
                    row+=f"{v*100:>+6.0f}%"
            print(f"  {yr:4d}{row}  {win}/{tot}")
        print(f"\n  Loss months: {sorted(loss_mo)}")
    return {"label":label,"n":n_,"ra":ra,"wr":wr,"win_mo":len(win_mo),"tot_mo":total_mo,"win_pct":win_pct,"stab":stab}

# Extra filters
def filt_vol(i): return vma20_1h[i] is not None and bars1h[i]["volume"]>vma20_1h[i]*1.5
def filt_trend(i): return e9_1h[i] and e21_1h[i] and e9_1h[i]>e21_1h[i]  # EMA9>EMA21 uptrend 1h
def filt_e50(i): return e50_1h[i] and c1h[i]>e50_1h[i]  # price above EMA50 1h
def filt_both(i): return filt_vol(i) and filt_trend(i)

print("\n" + "="*70)
print("PER-MONTH ANALYSIS — 1h BB_low + RSI_x40 (4h context)")
print("="*70)

results = []

# 1. Baseline variants (SL×2, TP×1/1.5/2/3)
for tp in [1.0, 1.5, 2.0, 3.0]:
    label=f"BB+RSI  SL×2 TP×{tp}"
    r=monthly_table(run(2.,tp,True,True), label, verbose=(tp==2.0))
    if r: results.append(r)

# 2. BB only vs RSI only
print("\n\n=== Signal isolation ===")
r=monthly_table(run(2.,2.,True,False), "BB_only  SL×2 TP×2", verbose=False)
if r: results.append(r)
r=monthly_table(run(2.,2.,False,True), "RSI_only  SL×2 TP×2", verbose=False)
if r: results.append(r)

# 3. Extra filters
print("\n\n=== Extra filters on BB+RSI SL×2 TP×2 ===")
r=monthly_table(run(2.,2.,True,True,filt_trend), "BB+RSI +trend(EMA9>21)", verbose=False)
if r: results.append(r)
r=monthly_table(run(2.,2.,True,True,filt_vol), "BB+RSI +vol>MA20×1.5", verbose=False)
if r: results.append(r)
r=monthly_table(run(2.,2.,True,True,filt_e50), "BB+RSI +price>EMA50_1h", verbose=False)
if r: results.append(r)
r=monthly_table(run(2.,2.,True,True,filt_both), "BB+RSI +trend+vol", verbose=False)
if r: results.append(r)

# 4. Tight TP sweep with best filter
print("\n\n=== TP sweep with trend filter ===")
for tp in [1.0, 1.5, 2.0]:
    r=monthly_table(run(2.,tp,True,True,filt_trend), f"BB+RSI +trend SL×2 TP×{tp}", verbose=False)
    if r: results.append(r)

# 5. Longer cooldown (less trades, higher quality)
print("\n\n=== Cooldown sweep ===")
for cd in [2, 4, 8, 12]:
    r=monthly_table(run(2.,2.,True,True,cd=cd), f"BB+RSI CD={cd}h SL×2 TP×2", verbose=False)
    if r: results.append(r)

# RANKING
print("\n\n" + "="*70)
print("RANKING — sorted by monthly win% (goal: maximize positive months)")
print("="*70)
results.sort(key=lambda x: (x["win_pct"],-abs(x["ra"])), reverse=True)
print(f"\n  {'Config':45s}  {'win%':>6}  {'mo+/tot':>8}  {'n/yr':>6}  {'RA':>7}  {'stab':>6}")
for r in results:
    flag="✅" if r["win_pct"]>=70 else ("⚠️" if r["win_pct"]>=60 else "✗")
    print(f"  {r['label']:45s}  {r['win_pct']:>5.0f}%  {r['win_mo']:>3}/{r['tot_mo']:<4}  {r['n']//7:>6}  {r['ra']:>+7.3f}  {r['stab']}/{len([1])*6}  {flag}")

best=[r for r in results if r["win_pct"]>=70]
if best:
    b=best[0]
    print(f"\n  ⭐ BEST: {b['label']}")
    print(f"     Monthly win: {b['win_mo']}/{b['tot_mo']} ({b['win_pct']:.0f}%)")
    print(f"     RA={b['ra']:+.3f}  n={b['n']//7}/yr  stab={b['stab']}/6")
else:
    b=results[0]
    print(f"\n  Best đạt được: {b['label']} — {b['win_pct']:.0f}% monthly win")
    print(f"  Chưa đạt 70%+ — xem detail per-year ở trên để hiểu tháng nào lỗ")
