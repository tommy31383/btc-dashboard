#!/usr/bin/env python3
"""
audit-multi-tp-7y.py — Test multi-level SL/TP vs baseline v0.4.55c (7y).

Configs tested:
  BASELINE : trailing SL only
  1TP      : best from previous audit (×2.0, 50%)
  2TP_A    : close 33% @ ATR×2, close 33% @ ATR×4, trail 33%
  2TP_B    : close 50% @ ATR×2, close 25% @ ATR×4, trail 25%
  2TP_C    : close 25% @ ATR×2, close 50% @ ATR×4, trail 25%
  2TP_D    : close 33% @ ATR×1.5, close 33% @ ATR×3, trail 33%
  2TP_E    : close 50% @ ATR×1.5, close 25% @ ATR×3, trail 25%
  GRID     : sweep TP1 mult × TP2 mult × fraction (top 5 by RA)
"""
import json, datetime
from collections import defaultdict
from itertools import product

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

# ── Core sim: supports 0, 1, or 2 TP levels ──────────────────────────────────
def sim(ei, tps=None):
    """
    tps: list of (atr_mult, fraction) sorted by mult ascending.
    e.g. [(2.0, 0.5)] = 1 TP: close 50% at ATR×2, trail rest
         [(2.0, 0.33), (4.0, 0.33)] = 2 TP: close 33% at ×2, 33% at ×4, trail 33%
    """
    ep=c4[ei]; ae=atr4[ei]
    if ae is None or ae<=0: return None
    sl=ep-ae*SL_INIT; hwm=ep
    remaining=1.0  # fraction still open
    locked_pnl=0.0  # locked P&L from partial closes
    tp_idx=0; tp_list=tps or []

    for h in range(1,MAX_HOLD+1):
        j=ei+h
        if j>=n: break
        # Check TP levels in order
        while tp_idx<len(tp_list):
            tp_mult,tp_frac=tp_list[tp_idx]
            tp_price=ep+ae*tp_mult
            if bars4h[j]["high"]>=tp_price:
                locked_pnl+=tp_frac*(tp_price-ep)/ep
                remaining-=tp_frac; tp_idx+=1
            else: break
        mult=SL_INIT if h<SL_TRANS else SL_TRAIL
        if c4[j]>hwm: hwm=c4[j]; sl=hwm-ae*mult
        elif h>=SL_TRANS:
            t=hwm-ae*SL_TRAIL
            if t>sl: sl=t
        if bars4h[j]["low"]<=sl:
            trail_ret=remaining*(sl-ep)/ep
            return locked_pnl+trail_ret-2*FEE, h
    j=min(ei+MAX_HOLD,n-1)
    trail_ret=remaining*(c4[j]-ep)/ep
    return locked_pnl+trail_ret-2*FEE, MAX_HOLD

def run(tps=None):
    trades=[]; last={s:0 for s in ["S12","S13","S14"]}
    for i in range(250,n-MAX_HOLD-1):
        if not base_filt(i): continue
        for sn in ["S12","S13","S14"]:
            if i-last[sn]<CD[sn]: continue
            if not sigs[sn](i): continue
            if do_vol[sn] and not vol_pass(i): continue
            r=sim(i, tps)
            if r is None: continue
            ret,h=r
            yr=datetime.datetime.utcfromtimestamp(bars4h[i]["time"]/1000).year
            trades.append({"ret":ret,"h":h,"yr":yr,"sn":sn})
            last[sn]=i
    return trades

def metrics(trades):
    if not trades: return None
    rets=[t["ret"] for t in trades]; nn=len(rets)
    mean=sum(rets)/nn; sd=(sum((r-mean)**2 for r in rets)/nn)**0.5 or 1e-9
    ra=mean/sd; wr=sum(1 for r in rets if r>0)/nn*100
    wins=[r for r in rets if r>0]; losses=[r for r in rets if r<=0]
    rr=(sum(wins)/len(wins) if wins else 0)/abs(sum(losses)/len(losses) if losses else 1e-9)
    by_yr=defaultdict(float)
    for t in trades: by_yr[t["yr"]]+=t["ret"]
    pos=sum(1 for v in by_yr.values() if v>0)
    equity=0; peak=0; max_dd=0
    for t in sorted(trades,key=lambda x:x["yr"]):
        equity+=t["ret"]; peak=max(peak,equity); max_dd=max(max_dd,peak-equity)
    yr_str=" ".join(f"{y}:{by_yr[y]*100:+.0f}" for y in sorted(by_yr))
    return dict(nn=nn,ra=ra,wr=wr,rr=rr,roi=sum(rets)*100,dd=max_dd*100,
                stab=f"{pos}/{len(by_yr)}",yr=yr_str)

# ── Named variants ────────────────────────────────────────────────────────────
variants=[
    ("BASELINE",    None),
    ("1TP ×2 50%",  [(2.0,0.50)]),
    ("1TP ×3 50%",  [(3.0,0.50)]),
    ("2TP A ×2/×4 33/33", [(2.0,0.33),(4.0,0.33)]),
    ("2TP B ×2/×4 50/25", [(2.0,0.50),(4.0,0.25)]),
    ("2TP C ×2/×4 25/50", [(2.0,0.25),(4.0,0.50)]),
    ("2TP D ×1.5/×3 33/33",[(1.5,0.33),(3.0,0.33)]),
    ("2TP E ×1.5/×3 50/25",[(1.5,0.50),(3.0,0.25)]),
    ("2TP F ×2/×5 33/33", [(2.0,0.33),(5.0,0.33)]),
]

print("\n" + "="*115)
print(f"  {'Config':28s}  {'n':>5}  {'RA':>7}  {'WR':>5}  {'R:R':>5}  {'ROI%':>8}  {'DD%':>6}  {'Stab':>6}  {'ΔRA':>7}")
print("="*115)
base_ra=None; results=[]
for label,tps in variants:
    t=run(tps); m=metrics(t)
    if m:
        dra=f"{m['ra']-base_ra:+.3f}" if base_ra else "—"
        print(f"  {label:28s}  {m['nn']:>5}  {m['ra']:>+7.3f}  {m['wr']:>5.0f}%  {m['rr']:>5.2f}  {m['roi']:>+8.1f}%  {m['dd']:>6.1f}%  {m['stab']:>6}  {dra:>7}")
        print(f"    {m['yr']}")
        if base_ra is None: base_ra=m['ra']
        results.append((label,m,tps))

# ── Grid search 2TP ──────────────────────────────────────────────────────────
print("\n" + "="*115)
print("GRID SEARCH — 2TP: TP1_mult × TP2_mult × frac1 (frac2=frac1, trail=1-2×frac1)")
print("="*115)
print(f"  {'TP1×':>5}  {'TP2×':>5}  {'frac':>5}  {'n':>5}  {'RA':>7}  {'WR':>5}  {'ROI%':>8}  {'DD%':>6}  {'Stab':>6}  {'ΔRA':>7}")

grid_results=[]
tp1_mults=[1.5, 2.0, 2.5, 3.0]
tp2_mults=[3.0, 4.0, 5.0, 6.0]
fracs=[0.25, 0.33, 0.40]

for m1,m2,f in product(tp1_mults, tp2_mults, fracs):
    if m1>=m2: continue
    if 2*f>=1.0: continue  # trail must be positive
    tps=[(m1,f),(m2,f)]
    t=run(tps); m=metrics(t)
    if m: grid_results.append((m['ra'],m1,m2,f,m))

grid_results.sort(reverse=True)
print(f"  Top 10 by RA:")
for ra,m1,m2,f,m in grid_results[:10]:
    dra=f"{m['ra']-base_ra:+.3f}"
    trail=1-2*f
    print(f"  {m1:>5.1f}  {m2:>5.1f}  {f:>5.2f}  {m['nn']:>5}  {m['ra']:>+7.3f}  {m['wr']:>5.0f}%  {m['roi']:>+8.1f}%  {m['dd']:>6.1f}%  {m['stab']:>6}  {dra:>7}  trail={trail:.2f}")
    print(f"    {m['yr']}")

# ── Walk-forward top picks ───────────────────────────────────────────────────
print("\n" + "="*115)
print("WALK-FORWARD — top 3 grid picks vs baseline")
print("="*115)

def run_yr(tps, yr_range):
    trades=[]; last={s:0 for s in ["S12","S13","S14"]}
    for i in range(250,n-MAX_HOLD-1):
        yr=datetime.datetime.utcfromtimestamp(bars4h[i]["time"]/1000).year
        if yr<yr_range[0] or yr>yr_range[1]: continue
        if not base_filt(i): continue
        for sn in ["S12","S13","S14"]:
            if i-last[sn]<CD[sn]: continue
            if not sigs[sn](i): continue
            if do_vol[sn] and not vol_pass(i): continue
            r=sim(i, tps)
            if r is None: continue
            ret,h=r
            trades.append({"ret":ret,"h":h,"yr":yr,"sn":sn})
            last[sn]=i
    return trades

candidates=[(None,"BASELINE")]+[(grid_results[k][4],f"2TP ×{grid_results[k][1]}/×{grid_results[k][2]} {grid_results[k][3]:.2f}/{grid_results[k][3]:.2f}") for k in range(3)]
# Also add 1TP best
candidates.insert(1,([(2.0,0.50)],"1TP ×2 50%"))

print(f"  {'Config':30s}  {'TRAIN RA':>9}  {'TRAIN stab':>11}  {'TEST RA':>8}  {'TEST stab':>10}  {'Degrade':>8}")
for tps_or_m, label in candidates:
    if isinstance(tps_or_m, dict): continue
    tps=tps_or_m
    tr=metrics(run_yr(tps,(2019,2022))); te=metrics(run_yr(tps,(2023,2026)))
    if tr and te:
        deg=f"{(te['ra']-tr['ra'])/abs(tr['ra'])*100:+.0f}%" if tr['ra']!=0 else "—"
        print(f"  {label:30s}  {tr['ra']:>+9.3f}  {tr['stab']:>11}  {te['ra']:>+8.3f}  {te['stab']:>10}  {deg:>8}")

print("\n  Accept rule: RA > baseline+0.03 AND stab TEST ≥ 3/3 AND degrade < 30%")
