#!/usr/bin/env python3
"""
audit-partial-tp-deep-7y.py — Audit kỹ V2 partial TP.

1. Per-year, per-setup breakdown baseline vs V2
2. Sensitivity: TP mult (ATR×2/3/4/5) × fraction (30/40/50/60/70%)
3. Hold-time distribution: partial TP fire sau bao nhiêu bars?
4. Win/loss distribution baseline vs V2
5. Walk-forward train/test
"""
import json, datetime, statistics
from collections import defaultdict

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FEE = 0.05/100; H4 = 4*3600*1000

SL_INIT=4.0; SL_TRAIL=3.0; SL_TRANS=24
ADX_P=14; ADX_T=20; VOL_MA=10; VOL_MULT=1.2
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
    n=len(bars); pdm=[0.0]*n; ndm=[0.0]*n; tr=[0.0]*n
    for i in range(1,n):
        up=bars[i]["high"]-bars[i-1]["high"]; dn=bars[i-1]["low"]-bars[i]["low"]
        pdm[i]=up if up>dn and up>0 else 0; ndm[i]=dn if dn>up and dn>0 else 0
        tr[i]=max(bars[i]["high"]-bars[i]["low"],abs(bars[i]["high"]-bars[i-1]["close"]),abs(bars[i]["low"]-bars[i-1]["close"]))
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
e200_1h=ema_s([b["close"] for b in bars1h],200); h1t=[b["time"] for b in bars1h]

def regime_build():
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

def sim(ei, tp_mult=None, tp_frac=0.5):
    ep=c4[ei]; ae=atr4[ei]
    if ae is None or ae<=0: return None
    sl=ep-ae*SL_INIT; hwm=ep; partial_done=False; partial_price=None; partial_bar=None
    for h in range(1,MAX_HOLD+1):
        j=ei+h
        if j>=n: break
        if tp_mult and not partial_done and bars4h[j]["high"]>=ep+ae*tp_mult:
            partial_price=ep+ae*tp_mult; partial_done=True; partial_bar=h
        mult=SL_INIT if h<SL_TRANS else SL_TRAIL
        if c4[j]>hwm: hwm=c4[j]; sl=hwm-ae*mult
        elif h>=SL_TRANS:
            t=hwm-ae*SL_TRAIL
            if t>sl: sl=t
        if bars4h[j]["low"]<=sl:
            ex=sl
            if partial_done: return tp_frac*(partial_price-ep)/ep+(1-tp_frac)*(ex-ep)/ep-2*FEE, h, partial_bar
            return (ex-ep)/ep-2*FEE, h, None
    j=min(ei+MAX_HOLD,n-1); ex=c4[j]
    if partial_done: return tp_frac*(partial_price-ep)/ep+(1-tp_frac)*(ex-ep)/ep-2*FEE, MAX_HOLD, partial_bar
    return (ex-ep)/ep-2*FEE, MAX_HOLD, None

def run(tp_mult=None, tp_frac=0.5, yr_range=None):
    trades=[]; last={s:0 for s in ["S12","S13","S14"]}
    for i in range(250, n-MAX_HOLD-1):
        ts=bars4h[i]["time"]
        if yr_range:
            yr=datetime.datetime.utcfromtimestamp(ts/1000).year
            if yr<yr_range[0] or yr>yr_range[1]: continue
        if not base_filt(i): continue
        for sn in ["S12","S13","S14"]:
            if i-last[sn]<CD[sn]: continue
            if not sigs[sn](i): continue
            if do_vol[sn] and not vol_pass(i): continue
            r=sim(i, tp_mult, tp_frac)
            if r is None: continue
            ret,h,pb=r
            yr=datetime.datetime.utcfromtimestamp(ts/1000).year
            trades.append({"ret":ret,"h":h,"yr":yr,"sn":sn,"pb":pb,"ep":c4[i],"ae":atr4[i]})
            last[sn]=i
    return trades

def stats(trades):
    if not trades: return None
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
    return dict(n=n_,ra=ra,wr=wr,rr=rr,roi=sum(rets)*100,dd=max_dd*100,
                stab=f"{pos}/{len(by_yr)}",by_yr=by_yr,wins=wins,losses=losses)

# ── 1. BASELINE vs V2 per-year per-setup ───────────────────────────────────
print("\n" + "="*70)
print("1. PER-YEAR BREAKDOWN")
print("="*70)
t_base=run(); t_v2=run(tp_mult=3.0, tp_frac=0.5)
s_base=stats(t_base); s_v2=stats(t_v2)

by_yr_base=s_base["by_yr"]; by_yr_v2=s_v2["by_yr"]
all_yrs=sorted(set(list(by_yr_base.keys())+list(by_yr_v2.keys())))
print(f"  {'Year':>6}  {'BASE%':>8}  {'V2%':>8}  {'Δ%':>7}  {'Winner':>8}")
print(f"  {'-'*45}")
for yr in all_yrs:
    b=by_yr_base.get(yr,0)*100; v=by_yr_v2.get(yr,0)*100; d=v-b
    w="V2 ✓" if v>b else ("BASE" if b>v else "=")
    print(f"  {yr:>6}  {b:>+8.1f}%  {v:>+8.1f}%  {d:>+7.1f}%  {w:>8}")
print(f"  {'TOTAL':>6}  {s_base['roi']:>+8.1f}%  {s_v2['roi']:>+8.1f}%  {s_v2['roi']-s_base['roi']:>+7.1f}%")
print(f"  {'RA':>6}  {s_base['ra']:>+8.3f}   {s_v2['ra']:>+8.3f}   {s_v2['ra']-s_base['ra']:>+7.3f}")
print(f"  {'WR':>6}  {s_base['wr']:>8.0f}%  {s_v2['wr']:>8.0f}%")
print(f"  {'Stab':>6}  {s_base['stab']:>8}   {s_v2['stab']:>8}")

# ── 2. PER-SETUP ─────────────────────────────────────────────────────────────
print("\n" + "="*70)
print("2. PER-SETUP BREAKDOWN")
print("="*70)
print(f"  {'Setup':>6}  {'BASE n':>7}  {'BASE RA':>8}  {'V2 n':>6}  {'V2 RA':>8}  {'ΔRA':>7}")
for sn in ["S12","S13","S14"]:
    tb=[t for t in t_base if t["sn"]==sn]; tv=[t for t in t_v2 if t["sn"]==sn]
    sb=stats(tb); sv=stats(tv)
    if sb and sv:
        print(f"  {sn:>6}  {sb['n']:>7}  {sb['ra']:>+8.3f}  {sv['n']:>6}  {sv['ra']:>+8.3f}  {sv['ra']-sb['ra']:>+7.3f}")

# ── 3. WIN/LOSS DISTRIBUTION ─────────────────────────────────────────────────
print("\n" + "="*70)
print("3. WIN/LOSS DISTRIBUTION")
print("="*70)
for label,s in [("BASELINE",s_base),("V2 partial",s_v2)]:
    wins=s["wins"]; losses=s["losses"]
    avg_win=sum(wins)/len(wins)*100 if wins else 0
    avg_loss=sum(losses)/len(losses)*100 if losses else 0
    max_win=max(wins)*100 if wins else 0; max_loss=min(losses)*100 if losses else 0
    print(f"  {label}: avg_win={avg_win:+.2f}%  avg_loss={avg_loss:+.2f}%  max_win={max_win:+.2f}%  max_loss={max_loss:+.2f}%")

# ── 4. PARTIAL TP FIRE STATS ─────────────────────────────────────────────────
print("\n" + "="*70)
print("4. PARTIAL TP FIRE STATS (V2, tp_mult=3.0)")
print("="*70)
fired=[t for t in t_v2 if t["pb"] is not None]
not_fired=[t for t in t_v2 if t["pb"] is None]
print(f"  Partial TP fired: {len(fired)}/{len(t_v2)} trades ({len(fired)/len(t_v2)*100:.0f}%)")
if fired:
    pb_bars=[t["pb"] for t in fired]
    print(f"  Fire timing: mean={statistics.mean(pb_bars):.1f} bars, median={statistics.median(pb_bars):.0f}, min={min(pb_bars)}, max={max(pb_bars)}")
    ret_fired=[t["ret"] for t in fired]; ret_notfired=[t["ret"] for t in not_fired]
    print(f"  When fired:  avg ret={sum(ret_fired)/len(ret_fired)*100:+.2f}%  WR={sum(1 for r in ret_fired if r>0)/len(ret_fired)*100:.0f}%")
    if not_fired:
        print(f"  Not fired:   avg ret={sum(ret_notfired)/len(ret_notfired)*100:+.2f}%  WR={sum(1 for r in ret_notfired if r>0)/len(ret_notfired)*100:.0f}%")

# ── 5. SENSITIVITY — TP MULT ─────────────────────────────────────────────────
print("\n" + "="*70)
print("5. SENSITIVITY — TP MULT (fraction=0.5 fixed)")
print("="*70)
print(f"  {'Mult':>6}  {'n':>5}  {'RA':>7}  {'WR':>5}  {'ROI%':>8}  {'DD%':>6}  {'Stab':>6}  {'ΔRA':>7}  fired%")
for mult in [None, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0]:
    t=run(tp_mult=mult, tp_frac=0.5); s=stats(t)
    if s:
        dra=f"{s['ra']-s_base['ra']:+.3f}" if mult else "—"
        label=f"×{mult:.1f}" if mult else "BASELINE"
        fired_pct=f"{sum(1 for x in t if x['pb'])/len(t)*100:.0f}%" if mult else "—"
        print(f"  {label:>6}  {s['n']:>5}  {s['ra']:>+7.3f}  {s['wr']:>5.0f}%  {s['roi']:>+8.1f}%  {s['dd']:>6.1f}%  {s['stab']:>6}  {dra:>7}  {fired_pct}")

# ── 6. SENSITIVITY — FRACTION ─────────────────────────────────────────────────
print("\n" + "="*70)
print("6. SENSITIVITY — FRACTION (tp_mult=3.0 fixed)")
print("="*70)
print(f"  {'Frac':>6}  {'n':>5}  {'RA':>7}  {'WR':>5}  {'ROI%':>8}  {'DD%':>6}  {'Stab':>6}  {'ΔRA':>7}")
for frac in [0.30, 0.40, 0.50, 0.60, 0.70]:
    t=run(tp_mult=3.0, tp_frac=frac); s=stats(t)
    if s:
        dra=f"{s['ra']-s_base['ra']:+.3f}"
        print(f"  {frac:.2f}    {s['n']:>5}  {s['ra']:>+7.3f}  {s['wr']:>5.0f}%  {s['roi']:>+8.1f}%  {s['dd']:>6.1f}%  {s['stab']:>6}  {dra:>7}")

# ── 7. WALK-FORWARD TRAIN/TEST ────────────────────────────────────────────────
print("\n" + "="*70)
print("7. WALK-FORWARD TRAIN(2019-22) / TEST(2023-26)")
print("="*70)
for label,tp_mult,tp_frac in [("BASELINE",None,0.5),("V2 x3.0 50%",3.0,0.5)]:
    tr=run(tp_mult=tp_mult,tp_frac=tp_frac,yr_range=(2019,2022))
    te=run(tp_mult=tp_mult,tp_frac=tp_frac,yr_range=(2023,2026))
    str_=stats(tr); ste=stats(te)
    if str_ and ste:
        print(f"  {label}:")
        print(f"    TRAIN 2019-22: n={str_['n']} RA={str_['ra']:+.3f} ROI={str_['roi']:+.1f}% stab={str_['stab']}")
        print(f"    TEST  2023-26: n={ste['n']} RA={ste['ra']:+.3f} ROI={ste['roi']:+.1f}% stab={ste['stab']}")

# ── 8. VERDICT ────────────────────────────────────────────────────────────────
print("\n" + "="*70)
print("8. VERDICT")
print("="*70)
