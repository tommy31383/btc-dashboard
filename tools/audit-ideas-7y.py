#!/usr/bin/env python3
"""
audit-ideas-7y.py — Test 5 hướng cải tiến vs baseline v0.4.55c (7y full cycle).

Variants:
  BASELINE : current config
  V1       : next-bar open entry (tránh bar-close spike)
  V2       : partial TP 50% tại ATR×3, phần còn trail ATR×3
  V3       : 4h regime (faster MA200/MA50 trên 4h bars thay vì 1d)
  V4       : continuous vol scale qty × clamp(vol/MA, 0.8, 2.0) (no binary)
  V1+V2    : combo
  V1+V3    : combo
  V2+V3    : combo
  V1+V2+V3 : combo
"""
import json, datetime
from collections import defaultdict

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FEE = 0.05 / 100; H4 = 4*3600*1000

# v0.4.55c config
SL_INIT=4.0; SL_TRAIL=3.0; SL_TRANS=24
ADX_P=14; ADX_T=20; VOL_MA=10; VOL_MULT=1.2
ATR_PCT_LB=90; ATR_PCT_PCTL=0.50
DON_LB=20; ATR_BREAK=1.2; EMA_FAST=50; EMA_SLOW=200
MAX_HOLD=200; CD={"S12":36,"S13":1,"S14":36}

print("Loading data...")
raw = json.load(open(CACHE))

def load_tf(ms, buy_flag=False):
    b={}
    for c in raw:
        k=c["time"]//ms; ts=k*ms
        if k not in b:
            b[k]={"time":ts,"open":c["open"],"high":c["high"],"low":c["low"],
                  "close":c["close"],"volume":c["volume"]}
        else:
            o=b[k]; o["high"]=max(o["high"],c["high"]); o["low"]=min(o["low"],c["low"])
            o["close"]=c["close"]; o["volume"]+=c["volume"]
    return [b[k] for k in sorted(b)]

bars4h=load_tf(H4); bars1d=load_tf(86400*1000); bars1h=load_tf(3600*1000)
n=len(bars4h); c4=[b["close"] for b in bars4h]
print(f"4h: {n}  {datetime.datetime.utcfromtimestamp(bars4h[0]['time']/1000):%Y-%m-%d} → {datetime.datetime.utcfromtimestamp(bars4h[-1]['time']/1000):%Y-%m-%d}")

# ── Indicators ──────────────────────────────────────────────────────────────
def ema_s(xs,p):
    k=2/(p+1); out=[None]*len(xs); e=None
    for i,x in enumerate(xs): e=x if e is None else x*k+e*(1-k); out[i]=e
    return out

def _dm_tr(bars):
    n=len(bars); pdm=[0.0]*n; ndm=[0.0]*n; tr=[0.0]*n
    for i in range(1,n):
        up=bars[i]["high"]-bars[i-1]["high"]; dn=bars[i-1]["low"]-bars[i]["low"]
        pdm[i]=up if up>dn and up>0 else 0; ndm[i]=dn if dn>up and dn>0 else 0
        tr[i]=max(bars[i]["high"]-bars[i]["low"],
                  abs(bars[i]["high"]-bars[i-1]["close"]),
                  abs(bars[i]["low"]-bars[i-1]["close"]))
    return pdm,ndm,tr

def adx_w(bars,period=14):
    pdm,ndm,tr=_dm_tr(bars); n=len(bars)
    if n<=period+1: return [None]*n
    smTR=sum(tr[1:period+1]); smP=sum(pdm[1:period+1]); smN=sum(ndm[1:period+1])
    dx_arr=[]; av=None; out=[None]*n
    for i in range(period+1,n):
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
    _,_,tr=_dm_tr(bars); n=len(bars); atr=[None]*n
    s=sum(tr[1:period+1]); atr[period]=s/period
    for i in range(period+1,n): atr[i]=(atr[i-1]*(period-1)+tr[i])/period
    return atr

e50=ema_s(c4,EMA_FAST); e200=ema_s(c4,EMA_SLOW)
atr4=atr_s(bars4h); adx4=adx_w(bars4h)
e200_1h=ema_s([b["close"] for b in bars1h],200)
h1t=[b["time"] for b in bars1h]

# ── Regime 1d (baseline) ────────────────────────────────────────────────────
def regime_1d_build():
    cs=[b["close"] for b in bars1d]; nd=len(bars1d); raw_r=["RANGE"]*nd
    for i in range(200,nd):
        ma200=sum(cs[i-199:i+1])/200; ma50=sum(cs[i-50:i+1])/50
        ar=sum((b["high"]-b["low"])/b["close"] for b in bars1d[i-19:i+1])/20
        if cs[i]<ma200: raw_r[i]="BEAR"
        elif cs[i]>ma50 and ma50>ma200 and ar>0.04: raw_r[i]="BULL"
    out=["RANGE"]*nd; cur="RANGE"; cnt=0; lr="RANGE"
    for i in range(nd):
        r=raw_r[i]
        if r==lr: cnt+=1
        else: cnt=1; lr=r
        if cnt>=3: cur=r
        out[i]=cur
    reg_map={bars1d[i]["time"]//86400000: out[i] for i in range(nd)}
    return reg_map

# ── Regime 4h (V3) ──────────────────────────────────────────────────────────
def regime_4h_build():
    # Use 4h bars: MA200(4h)=33d, MA50(4h)=8d — faster but noisier
    cs=[b["close"] for b in bars4h]; n4=len(bars4h); raw_r=["RANGE"]*n4
    for i in range(200,n4):
        ma200=sum(cs[i-199:i+1])/200; ma50=sum(cs[i-49:i+1])/50
        ar=sum((b["high"]-b["low"])/b["close"] for b in bars4h[i-19:i+1])/20
        if cs[i]<ma200: raw_r[i]="BEAR"
        elif cs[i]>ma50 and ma50>ma200 and ar>0.01: raw_r[i]="BULL"  # lower ar thresh for 4h
    out=["RANGE"]*n4; cur="RANGE"; cnt=0; lr="RANGE"
    for i in range(n4):
        r=raw_r[i]
        if r==lr: cnt+=1
        else: cnt=1; lr=r
        if cnt>=3: cur=r
        out[i]=cur
    return out  # index-aligned with bars4h

print("Building regimes..."); reg_map_1d=regime_1d_build(); reg_4h=regime_4h_build()

def get_reg_1d(ts): return reg_map_1d.get(ts//86400000,"RANGE")
def get_reg_4h(i): return reg_4h[i] if i<len(reg_4h) else "RANGE"

# ── Helpers ──────────────────────────────────────────────────────────────────
def atp(i):
    return atr4[i]/c4[i] if atr4[i] and c4[i] else None
def atp_pass(i):
    if i<ATR_PCT_LB+14: return False
    vs=[atp(j) for j in range(i-ATR_PCT_LB,i) if atp(j)]
    if len(vs)<ATR_PCT_LB: return False
    cur=atp(i); return cur is not None and cur>=sorted(vs)[int(len(vs)*ATR_PCT_PCTL)]
def vol_pass(i):
    if i<VOL_MA: return False
    ma=sum(bars4h[j]["volume"] for j in range(i-VOL_MA,i))/VOL_MA
    return bars4h[i]["volume"]>=ma*VOL_MULT
def vol_scale(i):
    if i<VOL_MA: return 1.0
    ma=sum(bars4h[j]["volume"] for j in range(i-VOL_MA,i))/VOL_MA
    if ma<=0: return 1.0
    return min(max(bars4h[i]["volume"]/ma, 0.8), 2.0)
def e200_1h_at(ts):
    lo,hi,idx=0,len(h1t)-1,0
    while lo<=hi:
        m=(lo+hi)//2
        if h1t[m]<=ts: idx=m; lo=m+1
        else: hi=m-1
    return e200_1h[idx]
def utc_h(ts): return datetime.datetime.utcfromtimestamp(ts/1000).hour
def utc_dw(ts): return datetime.datetime.utcfromtimestamp(ts/1000).weekday()

def base_filter(i, use_4h_regime=False):
    adv=adx4[i]; adv_p=adx4[i-1] if i>=1 else None
    if adv is None or adv<=ADX_T: return False
    if adv_p is None or adv_p<=ADX_T: return False
    e1h=e200_1h_at(bars4h[i]["time"])
    if e1h is None or c4[i]<e1h: return False
    if not atp_pass(i): return False
    h=utc_h(bars4h[i]["time"]); dw=utc_dw(bars4h[i]["time"])
    if h==16 or dw in (3,6): return False
    reg=get_reg_4h(i) if use_4h_regime else get_reg_1d(bars4h[i]["time"])
    return reg=="RANGE"

def sig_s12(i):
    if i<1 or None in (e50[i],e200[i],e50[i-1],e200[i-1]): return False
    return e50[i-1]<=e200[i-1] and e50[i]>e200[i]
def sig_s13(i):
    return bool(atr4[i] and i>=1 and c4[i]>bars4h[i-1]["close"]+atr4[i]*ATR_BREAK)
def sig_s14(i):
    if i<DON_LB: return False
    hi20=max(bars4h[j]["high"] for j in range(i-DON_LB,i))
    return c4[i]>hi20

sigs={"S12":sig_s12,"S13":sig_s13,"S14":sig_s14}
do_vol_filter={"S12":False,"S13":True,"S14":True}

# ── Simulation ────────────────────────────────────────────────────────────────
def sim(ei, next_bar=False, partial_tp=False):
    if next_bar:
        if ei+1>=n: return None
        ep=bars4h[ei+1]["open"]; ae=atr4[ei]; start=ei+1
    else:
        ep=c4[ei]; ae=atr4[ei]; start=ei
    if ae is None or ae<=0: return None
    sl=ep-ae*SL_INIT; hwm=ep; partial_done=False; partial_price=None
    for h in range(1,MAX_HOLD+1):
        j=start+h
        if j>=n: break
        if partial_tp and not partial_done and bars4h[j]["high"]>=ep+ae*3:
            partial_price=ep+ae*3; partial_done=True
        mult=SL_INIT if h<SL_TRANS else SL_TRAIL
        if c4[j]>hwm: hwm=c4[j]; sl=hwm-ae*mult
        elif h>=SL_TRANS:
            t=hwm-ae*SL_TRAIL
            if t>sl: sl=t
        if bars4h[j]["low"]<=sl:
            ex=sl
            if partial_done:
                return 0.5*(partial_price-ep)/ep + 0.5*(ex-ep)/ep - 2*FEE, h
            return (ex-ep)/ep - 2*FEE, h
    j=min(start+MAX_HOLD,n-1); ex=c4[j]
    if partial_done:
        return 0.5*(partial_price-ep)/ep + 0.5*(ex-ep)/ep - 2*FEE, MAX_HOLD
    return (ex-ep)/ep - 2*FEE, MAX_HOLD

def run(next_bar=False, partial_tp=False, use_4h_regime=False, cont_vol=False):
    trades=[]; last={s:0 for s in ["S12","S13","S14"]}
    for i in range(250, n-MAX_HOLD-2):
        if not base_filter(i, use_4h_regime): continue
        for sn in ["S12","S13","S14"]:
            if i-last[sn]<CD[sn]: continue
            if not sigs[sn](i): continue
            # Vol gate
            if do_vol_filter[sn]:
                if cont_vol:
                    vs=vol_scale(i)
                    if vs<0.8: continue  # skip extreme low vol
                else:
                    if not vol_pass(i): continue
            r=sim(i, next_bar=next_bar, partial_tp=partial_tp)
            if r is None: continue
            ret,h=r
            if cont_vol and do_vol_filter[sn]: ret*=vol_scale(i)  # scale notional
            yr=datetime.datetime.utcfromtimestamp(bars4h[i]["time"]/1000).year
            trades.append({"ret":ret,"h":h,"yr":yr,"sn":sn})
            last[sn]=i
    return trades

def metrics(trades, label):
    if not trades: print(f"  {label:20s}: NO TRADES"); return None
    rets=[t["ret"] for t in trades]; n_=len(rets)
    mean=sum(rets)/n_; sd=(sum((r-mean)**2 for r in rets)/n_)**0.5 or 1e-9
    ra=mean/sd; wr=sum(1 for r in rets if r>0)/n_*100
    wins=[r for r in rets if r>0]; losses=[r for r in rets if r<=0]
    rr=(sum(wins)/len(wins) if wins else 0)/abs(sum(losses)/len(losses) if losses else 1e-9)
    by_yr=defaultdict(float)
    for t in trades: by_yr[t["yr"]]+=t["ret"]
    pos=sum(1 for v in by_yr.values() if v>0)
    equity=0; peak=0; max_dd=0
    for t in sorted(trades,key=lambda x:x["yr"]):
        equity+=t["ret"]; peak=max(peak,equity); max_dd=max(max_dd,peak-equity)
    yr_str=" ".join(f"{y}:{by_yr[y]*100:+.0f}" for y in sorted(by_yr))
    return {"label":label,"n":n_,"ra":ra,"wr":wr,"rr":rr,
            "roi":sum(rets)*100,"dd":max_dd*100,"stab":f"{pos}/{len(by_yr)}","yr":yr_str}

variants=[
    ("BASELINE",   dict()),
    ("V1 next-bar",dict(next_bar=True)),
    ("V2 partial", dict(partial_tp=True)),
    ("V3 4h-reg",  dict(use_4h_regime=True)),
    ("V4 vol-scale",dict(cont_vol=True)),
    ("V1+V2",      dict(next_bar=True,partial_tp=True)),
    ("V1+V3",      dict(next_bar=True,use_4h_regime=True)),
    ("V2+V3",      dict(partial_tp=True,use_4h_regime=True)),
    ("V1+V2+V3",   dict(next_bar=True,partial_tp=True,use_4h_regime=True)),
]

print("\n" + "="*105)
print(f"  {'Variant':20s}  {'n':>5}  {'RA':>7}  {'WR':>5}  {'R:R':>5}  {'ROI%':>8}  {'DD%':>6}  {'Stab':>6}  {'ΔRA':>7}")
print("="*105)
base=None
results=[]
for label, kwargs in variants:
    print(f"  Running {label}...", end="\r")
    trades=run(**kwargs)
    m=metrics(trades, label)
    if m:
        dra=f"{m['ra']-base['ra']:+.3f}" if base else "—"
        print(f"  {m['label']:20s}  {m['n']:>5}  {m['ra']:>+7.3f}  {m['wr']:>5.0f}%  {m['rr']:>5.2f}  {m['roi']:>+8.1f}%  {m['dd']:>6.1f}%  {m['stab']:>6}  {dra:>7}")
        print(f"    {m['yr']}")
        if base is None: base=m
        results.append(m)

print("="*105)
if results:
    best=max(results,key=lambda x:x['ra'])
    print(f"\n  🏆 BEST: {best['label']} — RA={best['ra']:+.3f}, n={best['n']}, stab={best['stab']}, DD={best['dd']:.1f}%")
    accept=[m for m in results[1:] if m['ra']>base['ra']+0.02 and m['stab']>=base['stab']]
    if accept:
        print(f"  ✅ ACCEPT candidates (RA > baseline+0.02, stab không giảm):")
        for m in accept: print(f"     {m['label']:20s} RA={m['ra']:+.3f} ({m['ra']-base['ra']:+.3f})")
    else:
        print(f"  ❌ Không có variant nào vượt ngưỡng accept (RA > baseline+0.02)")
