#!/usr/bin/env python3
"""
audit-bidirectional-7y.py — Rule general ăn mọi loại thị trường

Strategy: regime-aware mean reversion cả 2 chiều
  RANGE  → LONG  on dip (BB_low, RSI_x40, STOCH_x20) — đã proven RA+0.162
  BEAR   → SHORT on bounce (BB_high, RSI_x60_down, STOCH_x80_down) — fade rally
  BULL   → SHORT on rally (overbought fade) OR LONG on dip (trend follow)

Mục tiêu: cover 2022 (all BEAR), 2021 Jun-Jul (BEAR), tháng downtrend

Report: per-month breakdown với LONG + SHORT combined
"""
import json, datetime
from collections import defaultdict

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FEE   = 0.05 / 100

print("Loading...")
raw = json.load(open(CACHE)); raw.sort(key=lambda x: x["time"])

def agg(bars,ms):
    b={}
    for c in bars:
        k=c["time"]//ms
        if k not in b:
            b[k]={"time":k*ms,"open":c["open"],"high":c["high"],"low":c["low"],"close":c["close"],"volume":c["volume"]}
        else:
            o=b[k];o["high"]=max(o["high"],c["high"]);o["low"]=min(o["low"],c["low"]);o["close"]=c["close"];o["volume"]+=c["volume"]
    return [b[k] for k in sorted(b)]

bars1h=agg(raw,3600*1000); bars4h=agg(raw,4*3600*1000); bars1d=agg(raw,86400*1000)
n1h=len(bars1h); n4h=len(bars4h)
c1h=[b["close"] for b in bars1h]; c4h=[b["close"] for b in bars4h]

def ema(xs,p):
    k=2/(p+1);out=[None]*len(xs);e=None
    for i,x in enumerate(xs): e=x if e is None else x*k+e*(1-k);out[i]=e
    return out
def _dtr(bars):
    n=len(bars);tr=[0.]*n
    for i in range(1,n): tr[i]=max(bars[i]["high"]-bars[i]["low"],abs(bars[i]["high"]-bars[i-1]["close"]),abs(bars[i]["low"]-bars[i-1]["close"]))
    return tr
def adx_w(bars,p=14):
    n=len(bars);pdm=[0.]*n;ndm=[0.]*n;tr=_dtr(bars)
    for i in range(1,n):
        up=bars[i]["high"]-bars[i-1]["high"];dn=bars[i-1]["low"]-bars[i]["low"]
        pdm[i]=up if up>dn and up>0 else 0;ndm[i]=dn if dn>up and dn>0 else 0
    smTR=sum(tr[1:p+1]);smPDM=sum(pdm[1:p+1]);smNDM=sum(ndm[1:p+1])
    dx_arr=[];adv=None;out=[None]*n
    for i in range(p+1,n):
        smTR=smTR-smTR/p+tr[i];smPDM=smPDM-smPDM/p+pdm[i];smNDM=smNDM-smNDM/p+ndm[i]
        pdi=smPDM/smTR*100 if smTR>0 else 0;ndi=smNDM/smTR*100 if smTR>0 else 0
        dx=abs(pdi-ndi)/(pdi+ndi)*100 if (pdi+ndi)>0 else 0;dx_arr.append(dx)
        if len(dx_arr)<p: continue
        elif len(dx_arr)==p: adv=sum(dx_arr)/p
        else: adv=(adv*(p-1)+dx)/p
        out[i]=adv
    return out
def atr_w(bars,p=14):
    tr=_dtr(bars);n=len(bars);out=[None]*n;s=sum(tr[1:p+1]);out[p]=s/p
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
        d=cls[i]-cls[i-1];g=max(d,0);l=max(-d,0);ag=(ag*(n-1)+g)/n;al=(al*(n-1)+l)/n
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
        w=cls[i-n+1:i+1];m=sum(w)/n;s=(sum((x-m)**2 for x in w)/n)**0.5;u[i]=m+k*s;l[i]=m-k*s
    return u,l
def regime_wp(bars1d,persist=3):
    cs=[b["close"] for b in bars1d];n=len(bars1d);raw=["RANGE"]*n
    for i in range(200,n):
        m200=sum(cs[i-199:i+1])/200;m50=sum(cs[i-50:i+1])/50
        ar=sum((b["high"]-b["low"])/b["close"] for b in bars1d[i-19:i+1])/20
        if cs[i]<m200: raw[i]="BEAR"
        elif cs[i]>m50 and m50>m200 and ar>0.04: raw[i]="BULL"
    out=["RANGE"]*n;cur="RANGE";cnt=0;lr="RANGE"
    for i in range(n):
        r=raw[i]
        if r==lr: cnt+=1
        else: cnt=1;lr=r
        if cnt>=persist: cur=r
        out[i]=cur
    return out

print("Computing indicators...")
adx4=adx_w(bars4h); atr4=atr_w(bars4h)
atr1h=atr_w(bars1h); rsi1h=rsi_s(c1h); stk1h=stoch_s(bars1h)
e200_1h=ema(c1h,200); e200_4h=ema(c4h,200)
bbu,bbl=bb_s(c1h)
reg1d=regime_wp(bars1d); reg_map={}
for i,b in enumerate(bars1d): reg_map[b["time"]//86400000]=reg1d[i]
ATR_LB=90; ts4h=[b["time"] for b in bars4h]

def get_4h_idx(ts):
    k=ts//(4*3600*1000);lo,hi,idx=0,len(ts4h)-1,0
    while lo<=hi:
        m=(lo+hi)//2
        if ts4h[m]//(4*3600*1000)<=k: idx=m;lo=m+1
        else: hi=m-1
    return idx

def ctx_adx_atr(i4h, pct=0.35):
    if i4h<50: return False
    adv=adx4[i4h];adv_p=adx4[i4h-1] if i4h>0 else None
    if adv is None or adv<=20 or adv_p is None or adv_p<=20: return False
    if pct>0:
        if i4h<ATR_LB+14: return False
        vs=[atr4[j]/c4h[j] for j in range(i4h-ATR_LB,i4h) if atr4[j] and c4h[j]]
        if len(vs)<ATR_LB: return False
        cur=atr4[i4h]/c4h[i4h] if atr4[i4h] and c4h[i4h] else None
        return cur is not None and cur>=sorted(vs)[int(len(vs)*pct)]
    return True

print("Precomputing ADX+ATR context...")
ctx_adxatr=[ctx_adx_atr(i) for i in range(n4h)]

def get_regime(ts): return reg_map.get(ts//86400000,"RANGE")

def sim_long(i,sl_m=2.,tp_m=1.5,max_h=24):
    ep=c1h[i];ae=atr1h[i]
    if not ae or ae<=0: return None
    sl=ep-ae*sl_m; tp=ep+ae*tp_m
    for h in range(1,max_h+1):
        j=i+h
        if j>=n1h: break
        if bars1h[j]["low"]<=sl: return (sl-ep)/ep-2*FEE
        if bars1h[j]["high"]>=tp: return (tp-ep)/ep-2*FEE
    return (c1h[min(i+max_h,n1h-1)]-ep)/ep-2*FEE

def sim_short(i,sl_m=2.,tp_m=1.5,max_h=24):
    ep=c1h[i];ae=atr1h[i]
    if not ae or ae<=0: return None
    sl=ep+ae*sl_m; tp=ep-ae*tp_m
    for h in range(1,max_h+1):
        j=i+h
        if j>=n1h: break
        if bars1h[j]["high"]>=sl: return (ep-sl)/ep-2*FEE
        if bars1h[j]["low"]<=tp: return (ep-tp)/ep-2*FEE
    return (ep-c1h[min(i+max_h,n1h-1)])/ep-2*FEE

# ── CONFIGS ────────────────────────────────────────────────────────────────
# Config A: LONG only in RANGE (baseline winner)
# Config B: + SHORT in BEAR (BB_high + RSI fall + STOCH fall)
# Config C: + SHORT in BULL (fade overextension)
# Config D: + LONG in BEAR (contrarian bottom)

def run_bidir(long_in_range=True, short_in_bear=False, short_in_bull=False,
              long_in_bull=False, long_in_bear=False, cd_h=2):
    trades=[]
    last_L_bb=-cd_h; last_L_rsi=-cd_h; last_L_stoch=-cd_h
    last_S_bb=-cd_h; last_S_rsi=-cd_h; last_S_stoch=-cd_h

    for i in range(50, n1h-48):
        ts=bars1h[i]["time"]
        yr=datetime.datetime.utcfromtimestamp(ts/1000).year
        mo=yr*100+datetime.datetime.utcfromtimestamp(ts/1000).month
        reg=get_regime(ts)
        i4h=get_4h_idx(ts)
        adx_ok=ctx_adxatr[i4h] if 0<=i4h<n4h else False
        e1h=e200_1h[i]

        # ── LONG signals (RANGE regime) ────────────────────────────────────
        if long_in_range and reg=="RANGE" and adx_ok:
            long_gate = e1h is None or c1h[i]>=e1h
            if long_gate:
                if bbl[i] and bars1h[i]["low"]<=bbl[i] and c1h[i]>bars1h[i]["open"] and i-last_L_bb>=cd_h:
                    r=sim_long(i,2.,1.5); last_L_bb=i
                    if r is not None: trades.append({"ret":r,"mo":mo,"yr":yr,"dir":"L","sig":"BB","reg":reg})
                if rsi1h[i] and rsi1h[i-1] and rsi1h[i-1]<40 and rsi1h[i]>=40 and i-last_L_rsi>=cd_h:
                    r=sim_long(i,2.,1.0); last_L_rsi=i
                    if r is not None: trades.append({"ret":r,"mo":mo,"yr":yr,"dir":"L","sig":"RSI","reg":reg})
                if stk1h[i] and stk1h[i-1] and stk1h[i-1]<20 and stk1h[i]>=20 and i-last_L_stoch>=cd_h:
                    r=sim_long(i,2.,1.0); last_L_stoch=i
                    if r is not None: trades.append({"ret":r,"mo":mo,"yr":yr,"dir":"L","sig":"STK","reg":reg})

        # ── SHORT signals (BEAR regime — fade bounces) ─────────────────────
        if short_in_bear and reg=="BEAR" and adx_ok:
            short_gate = e1h is None or c1h[i]<=e1h
            if short_gate:
                if bbu[i] and bars1h[i]["high"]>=bbu[i] and c1h[i]<bars1h[i]["open"] and i-last_S_bb>=cd_h:
                    r=sim_short(i,2.,1.5); last_S_bb=i
                    if r is not None: trades.append({"ret":r,"mo":mo,"yr":yr,"dir":"S","sig":"BB_H","reg":reg})
                if rsi1h[i] and rsi1h[i-1] and rsi1h[i-1]>60 and rsi1h[i]<=60 and i-last_S_rsi>=cd_h:
                    r=sim_short(i,2.,1.0); last_S_rsi=i
                    if r is not None: trades.append({"ret":r,"mo":mo,"yr":yr,"dir":"S","sig":"RSI_D","reg":reg})
                if stk1h[i] and stk1h[i-1] and stk1h[i-1]>80 and stk1h[i]<=80 and i-last_S_stoch>=cd_h:
                    r=sim_short(i,2.,1.0); last_S_stoch=i
                    if r is not None: trades.append({"ret":r,"mo":mo,"yr":yr,"dir":"S","sig":"STK_D","reg":reg})

        # ── SHORT in BULL (fade overextension) ─────────────────────────────
        if short_in_bull and reg=="BULL" and adx_ok:
            if bbu[i] and bars1h[i]["high"]>=bbu[i] and c1h[i]<bars1h[i]["open"] and i-last_S_bb>=cd_h:
                r=sim_short(i,2.,1.5); last_S_bb=i
                if r is not None: trades.append({"ret":r,"mo":mo,"yr":yr,"dir":"S","sig":"BB_H_BULL","reg":reg})
            if rsi1h[i] and rsi1h[i-1] and rsi1h[i-1]>70 and rsi1h[i]<=70 and i-last_S_rsi>=cd_h:
                r=sim_short(i,2.,1.0); last_S_rsi=i
                if r is not None: trades.append({"ret":r,"mo":mo,"yr":yr,"dir":"S","sig":"RSI_D_BULL","reg":reg})

        # ── LONG in BEAR (contrarian) ───────────────────────────────────────
        if long_in_bear and reg=="BEAR":
            if bbl[i] and bars1h[i]["low"]<=bbl[i] and c1h[i]>bars1h[i]["open"] and i-last_L_bb>=cd_h:
                r=sim_long(i,2.,1.5); last_L_bb=i
                if r is not None: trades.append({"ret":r,"mo":mo,"yr":yr,"dir":"L_BEAR","sig":"BB","reg":reg})

    return trades

def stats_full(trades, label):
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
    active_yrs=sorted(by_yr.keys())
    yr_str=" ".join(f"{y}:{by_yr[y]*100:+.0f}%" for y in active_yrs)
    flag="✅" if win_pct>=80 and stab==len(active_yrs) else ("⚠️" if win_pct>=70 else "✗")
    print(f"\n  [{label}]")
    print(f"  n={n_:4d}({n_//7}/yr) RA={ra:+.3f} WR={wr:.0f}% monthly={win_mo}/{len(mos)}({win_pct:.0f}%) stab={stab}/{len(active_yrs)} {flag}")
    print(f"  yr: {yr_str}")
    # Dir breakdown
    by_dir=defaultdict(list)
    for t in trades: by_dir[t["dir"]].append(t["ret"])
    for dr,rs in sorted(by_dir.items()):
        m=sum(rs)/len(rs);sd2=(sum((r-m)**2 for r in rs)/len(rs))**0.5 or 1e-9
        print(f"    {dr}: n={len(rs):4d} WR={sum(1 for r in rs if r>0)/len(rs)*100:.0f}% RA={m/sd2:+.3f} ROI={sum(rs)*100:+.0f}%")
    return {"label":label,"win_pct":win_pct,"win_mo":win_mo,"tot_mo":len(mos),"ra":ra,"wr":wr,"stab":stab,"stab_n":len(active_yrs),"n":n_,"by_yr":by_yr,"by_mo":by_mo}

print("\n" + "="*70)
print("BIDIRECTIONAL RULE — ăn mọi regime")
print("="*70)

print("\n[A] BASELINE: LONG only in RANGE")
rA=stats_full(run_bidir(long_in_range=True), "A: LONG-RANGE only")

print("\n[B] + SHORT in BEAR (fade bounces)")
rB=stats_full(run_bidir(long_in_range=True, short_in_bear=True), "B: LONG-RANGE + SHORT-BEAR")

print("\n[C] + SHORT in BULL (fade overextension)")
rC=stats_full(run_bidir(long_in_range=True, short_in_bull=True), "C: LONG-RANGE + SHORT-BULL")

print("\n[D] LONG-RANGE + SHORT-BEAR + SHORT-BULL")
rD=stats_full(run_bidir(long_in_range=True, short_in_bear=True, short_in_bull=True), "D: LONG-RANGE + SHORT-BEAR + SHORT-BULL")

print("\n[E] LONG in BEAR (contrarian — testing only)")
rE=stats_full(run_bidir(long_in_bear=True), "E: LONG-BEAR only (contrarian)")

print("\n[F] SHORT in BEAR only")
rF=stats_full(run_bidir(short_in_bear=True, long_in_range=False), "F: SHORT-BEAR only")

# Coverage check
print("\n" + "="*70)
print("COVERAGE ANALYSIS — months covered by each config")
print("="*70)
for label,r in [("A LONG-RANGE",rA),("B +SHORT-BEAR",rB),("D FULL-BIDIR",rD)]:
    if not r: continue
    print(f"\n  [{label}]: {r['win_mo']}/{r['tot_mo']} months | {r['stab']}/{r['stab_n']} years")
    print(f"  Active years: {sorted(r['by_yr'].keys())}")
    loss=[m for m in sorted(r['by_mo'].keys()) if sum(t['ret'] for t in r['by_mo'][m])<=0]
    print(f"  Loss months: {loss}")

if rD:
    print(f"\n  FULL BIDIR per-year detail:")
    MN=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
    by_mo=rD["by_mo"]
    by_yr_mo=defaultdict(dict)
    for mo,ts in by_mo.items(): by_yr_mo[mo//100][mo%100]=sum(t["ret"] for t in ts)
    for yr in sorted(by_yr_mo):
        ms=by_yr_mo[yr]; win=sum(1 for v in ms.values() if v>0); tot=len(ms)
        row="".join(f"{ms.get(mn,0)*100:>+6.0f}%" if mn in ms else "     —" for mn in range(1,13))
        flag="✅" if sum(ms.values())>0 else "❌"
        print(f"  {yr}: [{row}]  {win}/{tot}  {flag}")
