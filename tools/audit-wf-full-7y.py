#!/usr/bin/env python3
"""
audit-wf-full-7y.py — Walk-forward đầy đủ cho BASELINE, OPT_A, OPT_B.

Expanding window: mỗi fold train trên tất cả data đến năm T, test năm T+1.
Folds: test 2020, 2021, 2022, 2023, 2024, 2025, 2026.
Metrics per fold + aggregate: mean test RA, % folds positive, consistency score.
"""
import json, datetime
from collections import defaultdict

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FEE=0.05/100; H4=4*3600*1000
SL_INIT=4.0; SL_TRAIL=3.0; SL_TRANS=24
ADX_T=20; VOL_MA=10; VOL_MULT=1.2
ATR_PCT_LB=90; ATR_PCT_PCTL=0.50
DON_LB=20; ATR_BREAK=1.2; EMA_FAST=50; EMA_SLOW=200
MAX_HOLD=200; CD={"S12":36,"S13":1,"S14":36}

print("Loading..."); raw=json.load(open(CACHE))
def load_tf(ms):
    b={}
    for c in raw:
        k=c["time"]//ms; ts=k*ms
        if k not in b: b[k]={"time":ts,"open":c["open"],"high":c["high"],"low":c["low"],"close":c["close"],"volume":c["volume"]}
        else:
            o=b[k]; o["high"]=max(o["high"],c["high"]); o["low"]=min(o["low"],c["low"]); o["close"]=c["close"]; o["volume"]+=c["volume"]
    return [b[k] for k in sorted(b)]

bars4h=load_tf(H4); bars1d=load_tf(86400*1000); bars1h=load_tf(3600*1000)
n=len(bars4h); c4=[b["close"] for b in bars4h]

def ema_s(xs,p):
    k=2/(p+1); out=[None]*len(xs); e=None
    for i,x in enumerate(xs): e=x if e is None else x*k+e*(1-k); out[i]=e
    return out
def _dm_tr(bars):
    nn=len(bars); pdm=[0.0]*nn; ndm=[0.0]*nn; tr=[0.0]*nn
    for i in range(1,nn):
        up=bars[i]["high"]-bars[i-1]["high"]; dn=bars[i-1]["low"]-bars[i]["low"]
        pdm[i]=up if up>dn and up>0 else 0; ndm[i]=dn if dn>up and dn>0 else 0
        tr[i]=max(bars[i]["high"]-bars[i]["low"],abs(bars[i]["high"]-bars[i-1]["close"]),abs(bars[i]["low"]-bars[i-1]["close"]))
    return pdm,ndm,tr
def adx_w(bars,period=14):
    pdm,ndm,tr=_dm_tr(bars); nn=len(bars)
    if nn<=period+1: return [None]*nn
    smTR=sum(tr[1:period+1]); smP=sum(pdm[1:period+1]); smN=sum(ndm[1:period+1])
    dx_arr=[]; av=None; out=[None]*nn
    for i in range(period+1,nn):
        smTR=smTR-smTR/period+tr[i]; smP=smP-smP/period+pdm[i]; smN=smN-smN/period+ndm[i]
        pdi=smP/smTR*100 if smTR>0 else 0; ndi=smN/smTR*100 if smTR>0 else 0
        dx=abs(pdi-ndi)/(pdi+ndi)*100 if (pdi+ndi)>0 else 0
        dx_arr.append(dx)
        if len(dx_arr)<period: continue
        elif len(dx_arr)==period: av=sum(dx_arr)/period
        else: av=(av*(period-1)+dx)/period
        out[i]=av
    return out
def atr_s(bars,period=14):
    _,_,tr=_dm_tr(bars); nn=len(bars); atr=[None]*nn
    s=sum(tr[1:period+1]); atr[period]=s/period
    for i in range(period+1,nn): atr[i]=(atr[i-1]*(period-1)+tr[i])/period
    return atr

e50=ema_s(c4,EMA_FAST); e200=ema_s(c4,EMA_SLOW)
atr4=atr_s(bars4h); adx4=adx_w(bars4h)
e200_1h=ema_s([b["close"] for b in bars1h],200); h1t=[b["time"] for b in bars1h]

def regime_build():
    cs=[b["close"] for b in bars1d]; nd=len(bars1d); rr=["RANGE"]*nd
    for i in range(200,nd):
        ma200=sum(cs[i-199:i+1])/200; ma50=sum(cs[i-50:i+1])/50
        ar=sum((b["high"]-b["low"])/b["close"] for b in bars1d[i-19:i+1])/20
        if cs[i]<ma200: rr[i]="BEAR"
        elif cs[i]>ma50 and ma50>ma200 and ar>0.04: rr[i]="BULL"
    out=["RANGE"]*nd; cur="RANGE"; cnt=0; lr="RANGE"
    for i in range(nd):
        r=rr[i]
        if r==lr: cnt+=1
        else: cnt=1; lr=r
        if cnt>=3: cur=r
        out[i]=cur
    return {bars1d[i]["time"]//86400000: out[i] for i in range(nd)}

reg_map=regime_build()
def get_reg(ts): return reg_map.get(ts//86400000,"RANGE")
def atp(i): return atr4[i]/c4[i] if atr4[i] and c4[i] else None
def atp_pass(i):
    if i<ATR_PCT_LB+14: return False
    vs=[atp(j) for j in range(i-ATR_PCT_LB,i) if atp(j)]
    if len(vs)<ATR_PCT_LB: return False
    cur=atp(i); return cur is not None and cur>=sorted(vs)[int(len(vs)*ATR_PCT_PCTL)]
def vol_pass(i):
    if i<VOL_MA: return False
    ma=sum(bars4h[j]["volume"] for j in range(i-VOL_MA,i))/VOL_MA
    return bars4h[i]["volume"]>=ma*VOL_MULT
def e200_1h_at(ts):
    lo,hi,idx=0,len(h1t)-1,0
    while lo<=hi:
        m=(lo+hi)//2
        if h1t[m]<=ts: idx=m; lo=m+1
        else: hi=m-1
    return e200_1h[idx]
def utc_h(ts): return datetime.datetime.utcfromtimestamp(ts/1000).hour
def utc_dw(ts): return datetime.datetime.utcfromtimestamp(ts/1000).weekday()
def base_filt(i):
    adv=adx4[i]; adv_p=adx4[i-1] if i>=1 else None
    if adv is None or adv<=ADX_T or adv_p is None or adv_p<=ADX_T: return False
    e1h=e200_1h_at(bars4h[i]["time"])
    if e1h is None or c4[i]<e1h: return False
    if not atp_pass(i): return False
    if utc_h(bars4h[i]["time"])==16 or utc_dw(bars4h[i]["time"]) in (3,6): return False
    return get_reg(bars4h[i]["time"])=="RANGE"
def sig_s12(i):
    if i<1 or None in (e50[i],e200[i],e50[i-1],e200[i-1]): return False
    return e50[i-1]<=e200[i-1] and e50[i]>e200[i]
def sig_s13(i): return bool(atr4[i] and i>=1 and c4[i]>bars4h[i-1]["close"]+atr4[i]*ATR_BREAK)
def sig_s14(i):
    if i<DON_LB: return False
    return c4[i]>max(bars4h[j]["high"] for j in range(i-DON_LB,i))
sigs={"S12":sig_s12,"S13":sig_s13,"S14":sig_s14}
do_vol={"S12":False,"S13":True,"S14":True}

def sim(ei, tps):
    ep=c4[ei]; ae=atr4[ei]
    if ae is None or ae<=0: return None
    sl=ep-ae*SL_INIT; hwm=ep; remaining=1.0; locked=0.0; tp_idx=0
    for h in range(1,MAX_HOLD+1):
        j=ei+h
        if j>=n: break
        while tp_idx<len(tps):
            tm,tf=tps[tp_idx]
            if bars4h[j]["high"]>=ep+ae*tm:
                locked+=tf*(ae*tm)/ep; remaining-=tf; tp_idx+=1
            else: break
        mult=SL_INIT if h<SL_TRANS else SL_TRAIL
        if c4[j]>hwm: hwm=c4[j]; sl=hwm-ae*mult
        elif h>=SL_TRANS:
            t=hwm-ae*SL_TRAIL
            if t>sl: sl=t
        if bars4h[j]["low"]<=sl:
            return locked+remaining*(sl-ep)/ep-2*FEE, h
    j=min(ei+MAX_HOLD,n-1)
    return locked+remaining*(c4[j]-ep)/ep-2*FEE, MAX_HOLD

def run_yr(tps, yr):
    trades=[]; last={s:0 for s in ["S12","S13","S14"]}
    for i in range(250,n-MAX_HOLD-1):
        ts=bars4h[i]["time"]
        if datetime.datetime.utcfromtimestamp(ts/1000).year!=yr: continue
        if not base_filt(i): continue
        for sn in ["S12","S13","S14"]:
            if i-last[sn]<CD[sn]: continue
            if not sigs[sn](i): continue
            if do_vol[sn] and not vol_pass(i): continue
            r=sim(i,tps)
            if r is None: continue
            ret,h=r
            trades.append({"ret":ret,"h":h,"sn":sn})
            last[sn]=i
    return trades

def run_range(tps, yr_from, yr_to):
    trades=[]; last={s:0 for s in ["S12","S13","S14"]}
    for i in range(250,n-MAX_HOLD-1):
        ts=bars4h[i]["time"]
        yr=datetime.datetime.utcfromtimestamp(ts/1000).year
        if yr<yr_from or yr>yr_to: continue
        if not base_filt(i): continue
        for sn in ["S12","S13","S14"]:
            if i-last[sn]<CD[sn]: continue
            if not sigs[sn](i): continue
            if do_vol[sn] and not vol_pass(i): continue
            r=sim(i,tps)
            if r is None: continue
            ret,h=r
            yr_=datetime.datetime.utcfromtimestamp(ts/1000).year
            trades.append({"ret":ret,"h":h,"sn":sn,"yr":yr_})
            last[sn]=i
    return trades

def stats(trades):
    if not trades: return None
    rets=[t["ret"] for t in trades]; nn=len(rets)
    mean=sum(rets)/nn; sd=(sum((r-mean)**2 for r in rets)/nn)**0.5 or 1e-9
    ra=mean/sd; wr=sum(1 for r in rets if r>0)/nn*100
    roi=sum(rets)*100
    return dict(n=nn,ra=ra,wr=wr,roi=roi,pos=roi>0)

TPS_BASE=[]; TPS_A=[(2.0,0.50),(4.0,0.25)]; TPS_B=[(2.0,0.33),(5.0,0.33)]
CONFIGS=[("BASELINE",TPS_BASE),("OPT_A ×2/×4 50/25",TPS_A),("OPT_B ×2/×5 33/33",TPS_B)]

TEST_YEARS=[2020,2021,2022,2023,2024,2025,2026]

# ── Walk-forward per fold ─────────────────────────────────────────────────────
print("\n" + "="*110)
print("WALK-FORWARD — Expanding window, per-fold detail")
print("Train: all years up to T-1 | Test: year T")
print("="*110)

all_results = {label: [] for label,_ in CONFIGS}

for label, tps in CONFIGS:
    print(f"\n  [{label}]")
    print(f"  {'Test yr':>8}  {'Train range':>14}  {'Tr n':>5}  {'Tr RA':>7}  {'Tst n':>5}  {'Tst RA':>7}  {'Tst ROI%':>9}  {'Degrade':>9}  {'Tst+':>5}")
    print(f"  {'-'*95}")
    fold_results = []
    for test_yr in TEST_YEARS:
        train_from = 2019; train_to = test_yr - 1
        if train_to < train_from: continue
        tr_trades = run_range(tps, train_from, train_to)
        te_trades = run_yr(tps, test_yr)
        tr = stats(tr_trades); te = stats(te_trades)
        if te is None:
            print(f"  {test_yr:>8}  {train_from}-{train_to:>4}        {'—':>5}  {'—':>7}  {'0':>5}  {'—':>7}  {'n/a (0 trades)':>9}")
            fold_results.append(None)
            continue
        tr_ra = tr['ra'] if tr else float('nan')
        deg = (te['ra']-tr_ra)/abs(tr_ra)*100 if (tr and tr_ra!=0) else float('nan')
        pos = "✓" if te['pos'] else "✗"
        tr_n = tr['n'] if tr else 0; tr_ra_s = f"{tr_ra:+.3f}" if tr else "—"
        print(f"  {test_yr:>8}  {train_from}-{train_to:>4}          {tr_n:>5}  {tr_ra_s:>7}  {te['n']:>5}  {te['ra']:>+7.3f}  {te['roi']:>+9.1f}%  {deg:>+9.1f}%  {pos:>5}")
        fold_results.append(te)
    all_results[label] = fold_results

# ── Aggregate stats ───────────────────────────────────────────────────────────
print("\n" + "="*110)
print("AGGREGATE — across all test folds with trades")
print("="*110)
print(f"  {'Config':26s}  {'folds':>6}  {'pos folds':>10}  {'mean Tst RA':>12}  {'min Tst RA':>11}  {'max Tst RA':>11}  {'consistency':>13}")
for label, tps in CONFIGS:
    folds = [f for f in all_results[label] if f is not None]
    if not folds: continue
    ras = [f['ra'] for f in folds]
    pos = sum(1 for f in folds if f['pos'])
    mean_ra = sum(ras)/len(ras)
    consistency = pos/len(folds)*100
    print(f"  {label:26s}  {len(folds):>6}  {pos:>4}/{len(folds):<5}  {mean_ra:>+12.3f}  {min(ras):>+11.3f}  {max(ras):>+11.3f}  {consistency:>12.0f}%")

# ── Year-by-year comparison ───────────────────────────────────────────────────
print("\n" + "="*110)
print("YEAR-BY-YEAR TEST COMPARISON (test RA side-by-side)")
print("="*110)
print(f"  {'Test yr':>8}  {'n':>4}  {'BASE RA':>9}  {'OPT_A RA':>10}  {'OPT_B RA':>10}  {'Δ A-BASE':>10}  {'Δ B-BASE':>10}  {'Best':>6}")
for idx, test_yr in enumerate(TEST_YEARS):
    fb = all_results["BASELINE"][idx]
    fa = all_results["OPT_A ×2/×4 50/25"][idx]
    fbb= all_results["OPT_B ×2/×5 33/33"][idx]
    if fb is None and fa is None and fbb is None:
        print(f"  {test_yr:>8}  {'—':>4}  {'no trades':>9}"); continue
    n_  = fb['n'] if fb else 0
    bra = fb['ra'] if fb else float('nan')
    ara = fa['ra'] if fa else float('nan')
    bvra= fbb['ra'] if fbb else float('nan')
    da  = ara-bra if (fa and fb) else float('nan')
    db  = bvra-bra if (fbb and fb) else float('nan')
    best= "A" if (fa and fb and ara>bvra and ara>bra) else ("B" if (fbb and fb and bvra>bra) else "BASE")
    bra_s  = f"{bra:+.3f}"  if fb  else "—"
    ara_s  = f"{ara:+.3f}"  if fa  else "—"
    bvra_s = f"{bvra:+.3f}" if fbb else "—"
    da_s   = f"{da:+.3f}"   if (fa and fb) else "—"
    db_s   = f"{db:+.3f}"   if (fbb and fb) else "—"
    print(f"  {test_yr:>8}  {n_:>4}  {bra_s:>9}  {ara_s:>10}  {bvra_s:>10}  {da_s:>10}  {db_s:>10}  {best:>6}")

# ── Final verdict ─────────────────────────────────────────────────────────────
print("\n" + "="*110)
print("FINAL VERDICT")
print("="*110)
for label, tps in CONFIGS:
    folds=[f for f in all_results[label] if f is not None]
    if not folds: continue
    ras=[f['ra'] for f in folds]; pos=sum(1 for f in folds if f['pos'])
    mean_ra=sum(ras)/len(ras)
    checks=[]
    b_folds=[f for f in all_results["BASELINE"] if f is not None]
    b_ras=[f['ra'] for f in b_folds]; b_mean=sum(b_ras)/len(b_ras)
    checks.append(("mean test RA > BASELINE mean",  mean_ra>b_mean))
    checks.append(("min test RA > -1.0 (no blow-up)",min(ras)>-1.0))
    checks.append(("pos folds ≥ 4/7",               pos>=4))
    checks.append(("pos folds > BASELINE pos folds", pos>sum(1 for f in b_folds if f['pos'])))
    passed=sum(1 for _,v in checks if v)
    result="✅ ACCEPT" if passed>=3 else ("⚠️  MARGINAL" if passed>=2 else "❌ REJECT")
    print(f"\n  [{label}]  mean_test_RA={mean_ra:+.3f}  pos_folds={pos}/{len(folds)}")
    for name,ok in checks: print(f"    {'✓' if ok else '✗'} {name}")
    print(f"    → {result} ({passed}/4 checks)")
