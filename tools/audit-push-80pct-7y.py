#!/usr/bin/env python3
"""
audit-push-80pct-7y.py — Push từ 76% → 80% monthly win

Từ analysis:
- Best hiện tại: BB+RSI+STOCH CD=2h ATR40 = 76% (34/45)
- Loss months còn lại: [201905,202002,202302,202305,202307,202311,202401,202410]
- Cần fix 2 thêm → 80%

Patterns trong loss months:
  202302: W=6/16 (37.5% WR) — terrible month, chop + false signals
  202410: W=5/8 (62.5% WR) — close, just -2%
  202305,202307: 1-2 signals, very low n
  202401: 1/3 wins

Approaches để push:
  1. Mixed TP per signal type (BB→TP×2, RSI→TP×1.5, STOCH→TP×1.0)
  2. Extend max_hold 24h→36h
  3. Add max_hold per regime (longer in stronger trend)
  4. Try TP×1.5 cho tất cả signals
  5. Test SL tighter khi nhiều signals cùng lúc
  6. Filter: chỉ vào khi VMA > MA20 (vol confirmation)
"""
import json, datetime
from collections import defaultdict

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FEE   = 0.05 / 100

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

print("Computing indicators...")
atr4=atr_w(bars4h); adx4=adx_w(bars4h)
atr1h=atr_w(bars1h); rsi1h=rsi_s(c1h); stk1h=stoch_s(bars1h)
e200_1h=ema(c1h,200); vma20=vol_ma(bars1h,20)
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

print("Precomputing contexts...")
def ctx4h_ok(i4h, pct=0.40):
    if i4h<50: return False
    if reg_map.get(bars4h[i4h]["time"]//86400000,"RANGE")!="RANGE": return False
    adv=adx4[i4h];adv_p=adx4[i4h-1] if i4h>0 else None
    if adv is None or adv<=20 or adv_p is None or adv_p<=20: return False
    if pct>0:
        if i4h<ATR_LB+14: return False
        vs=[atr4[j]/c4h[j] for j in range(i4h-ATR_LB,i4h) if atr4[j] and c4h[j]]
        if len(vs)<ATR_LB: return False
        cur=atr4[i4h]/c4h[i4h] if atr4[i4h] and c4h[i4h] else None
        return cur is not None and cur>=sorted(vs)[int(len(vs)*pct)]
    return True
ctx40=[ctx4h_ok(i,0.40) for i in range(n4h)]

def filt1h(i, ctx):
    e1h=e200_1h[i]
    if e1h and c1h[i]<e1h: return False
    i4h=get_4h_idx(bars1h[i]["time"])
    return 0<=i4h<n4h and ctx[i4h]

def sig_bb(i): return bbl[i] and bars1h[i]["low"]<=bbl[i] and c1h[i]>bars1h[i]["open"]
def sig_rsi(i): return rsi1h[i] and rsi1h[i-1] and rsi1h[i-1]<40 and rsi1h[i]>=40
def sig_stoch(i): return stk1h[i] and stk1h[i-1] and stk1h[i-1]<20 and stk1h[i]>=20

def sim(i, sl_m, tp_m, max_h=24):
    ep=c1h[i];ae=atr1h[i]
    if ae is None or ae<=0: return None
    sl=ep-ae*sl_m; tp=ep+ae*tp_m
    for h in range(1,max_h+1):
        j=i+h
        if j>=n1h: break
        if bars1h[j]["low"]<=sl: return (sl-ep)/ep-2*FEE
        if bars1h[j]["high"]>=tp: return (tp-ep)/ep-2*FEE
    j2=min(i+max_h,n1h-1)
    return (c1h[j2]-ep)/ep-2*FEE

def run(tp_bb, tp_rsi, tp_stoch, sl_m=2., cd_h=2, max_h_bb=24, max_h_rsi=24, max_h_stoch=24,
        vol_filt=False, ctx=None):
    if ctx is None: ctx=ctx40
    trades=[]; last_bb=-cd_h; last_rsi=-cd_h; last_stoch=-cd_h
    for i in range(50,n1h-48):
        if not filt1h(i,ctx): continue
        if vol_filt and (vma20[i] is None or bars1h[i]["volume"]<vma20[i]*1.2): continue
        ts=bars1h[i]["time"]; yr=datetime.datetime.utcfromtimestamp(ts/1000).year
        mo=yr*100+datetime.datetime.utcfromtimestamp(ts/1000).month
        if sig_bb(i) and i-last_bb>=cd_h:
            r=sim(i,sl_m,tp_bb,max_h_bb)
            if r is not None: trades.append({"ret":r,"mo":mo,"yr":yr,"sig":"BB"}); last_bb=i
        if sig_rsi(i) and i-last_rsi>=cd_h:
            r=sim(i,sl_m,tp_rsi,max_h_rsi)
            if r is not None: trades.append({"ret":r,"mo":mo,"yr":yr,"sig":"RSI"}); last_rsi=i
        if sig_stoch(i) and i-last_stoch>=cd_h:
            r=sim(i,sl_m,tp_stoch,max_h_stoch)
            if r is not None: trades.append({"ret":r,"mo":mo,"yr":yr,"sig":"STOCH"}); last_stoch=i
    return trades

def stats(trades, label):
    if not trades: return None
    by_mo=defaultdict(list)
    for t in trades: by_mo[t["mo"]].append(t["ret"])
    mos=sorted(by_mo.keys()); wm=[m for m in mos if sum(by_mo[m])>0]; lm=[m for m in mos if sum(by_mo[m])<=0]
    win_pct=len(wm)/len(mos)*100
    rets=[t["ret"] for t in trades]; n_=len(rets)
    mean=sum(rets)/n_; sd=(sum((r-mean)**2 for r in rets)/n_)**0.5 or 1e-9
    ra=mean/sd; wr=sum(1 for r in rets if r>0)/n_*100
    by_yr=defaultdict(float)
    for t in trades: by_yr[t["yr"]]+=t["ret"]
    stab=sum(1 for v in by_yr.values() if v>0)
    flag="✅" if win_pct>=80 else ("⚠️" if win_pct>=76 else "")
    print(f"  {label:55s}: {win_pct:.0f}%({len(wm)}/{len(mos)}) n={n_//7}/yr RA={ra:+.3f} WR={wr:.0f}% stab={stab}/6 {flag}")
    if win_pct>=76:
        print(f"    loss: {lm[:6]}")
    return {"label":label,"win_pct":win_pct,"win_mo":len(wm),"tot_mo":len(mos),"ra":ra,"wr":wr,"stab":stab,"n":n_,"lm":lm}

print("\n" + "="*75)
print("PUSH TO 80% — Mixed TP per signal type")
print("Baseline: BB+RSI+STOCH CD=2h ATR40 = 76% (34/45)")
print("="*75)

results=[]
print("\n[A] Mixed TP (BB wider for mean-reversion, STOCH tight):")
for tp_bb,tp_rsi,tp_st in [
    (2.0,1.0,1.0),(1.5,1.0,1.0),(2.0,1.5,1.0),(2.0,2.0,1.0),
    (1.5,1.5,1.0),(2.0,1.5,1.5),(1.5,1.0,0.8),(2.0,1.0,0.8)
]:
    r=stats(run(tp_bb,tp_rsi,tp_st,cd_h=2), f"BB×{tp_bb} RSI×{tp_rsi} STOCH×{tp_st}")
    if r: results.append(r)

print("\n[B] Extended max_hold:")
for mh in [30,36,48]:
    r=stats(run(1.0,1.0,1.0,max_h_bb=mh,max_h_rsi=mh,max_h_stoch=mh,cd_h=2), f"TP×1 hold={mh}h CD=2h")
    if r: results.append(r)
for mh in [36,48]:
    r=stats(run(1.5,1.5,1.0,max_h_bb=mh,max_h_rsi=mh,max_h_stoch=mh,cd_h=2), f"BB×1.5 RSI×1.5 STOCH×1 hold={mh}h")
    if r: results.append(r)

print("\n[C] Vol filter (only enter when vol confirms):")
r=stats(run(1.0,1.0,1.0,cd_h=2,vol_filt=True), "TP×1 +vol>MA20×1.2 CD=2h")
if r: results.append(r)
r=stats(run(1.5,1.5,1.0,cd_h=2,vol_filt=True), "BB×1.5 RSI×1.5 +vol CD=2h")
if r: results.append(r)

print("\n[D] Tighter SL — higher WR:")
for sl in [1.0,1.5]:
    r=stats(run(2.0,1.5,1.0,sl_m=sl,cd_h=2), f"SL×{sl} BB×2 RSI×1.5 STOCH×1")
    if r: results.append(r)

print("\n[E] CD=1h (more entries per month):")
r=stats(run(1.0,1.0,1.0,cd_h=1), "TP×1 CD=1h")
if r: results.append(r)
r=stats(run(1.5,1.0,1.0,cd_h=1), "BB×1.5 RSI×1 STOCH×1 CD=1h")
if r: results.append(r)
r=stats(run(2.0,1.5,1.0,cd_h=1), "BB×2 RSI×1.5 STOCH×1 CD=1h")
if r: results.append(r)

print("\n[F] Per-signal hold tuning (BB short hold=mean-revert, RSI longer=recovery):")
r=stats(run(1.5,2.0,1.0,max_h_bb=12,max_h_rsi=36,max_h_stoch=12,cd_h=2),
        "BB×1.5 hold12h | RSI×2 hold36h | STOCH×1 hold12h")
if r: results.append(r)
r=stats(run(1.0,1.5,1.0,max_h_bb=16,max_h_rsi=32,max_h_stoch=16,cd_h=2),
        "BB×1 h16 | RSI×1.5 h32 | STOCH×1 h16")
if r: results.append(r)
r=stats(run(2.0,2.0,1.0,max_h_bb=24,max_h_rsi=48,max_h_stoch=24,cd_h=2),
        "BB×2 h24 | RSI×2 h48 | STOCH×1 h24")
if r: results.append(r)

print("\n" + "="*75)
print("FINAL RANKING — all configs ≥ 75%")
print("="*75)
results.sort(key=lambda x:x["win_pct"],reverse=True)
for r in results:
    if r["win_pct"]>=75:
        flag="✅ 80% ACHIEVED!" if r["win_pct"]>=80 else "⚠️"
        yr_str=" ".join(f"{y}:{v*100:+.0f}%" for y,v in sorted(defaultdict(float,{
            t["yr"]:sum(t2["ret"] for t2 in [] if t2["yr"]==y) for t in []}.items())))
        print(f"  {r['label']:55s}: {r['win_pct']:.0f}%({r['win_mo']}/{r['tot_mo']}) n={r['n']//7}/yr RA={r['ra']:+.3f} {flag}")
        if r['lm']: print(f"    remaining loss: {r['lm'][:6]}")

best=results[0]
print(f"\n  ⭐ BEST OVERALL: {best['label']}")
print(f"     {best['win_pct']:.0f}% ({best['win_mo']}/{best['tot_mo']} months positive)")
print(f"     n={best['n']//7}/yr  RA={best['ra']:+.3f}  WR={best['wr']:.0f}%  stab={best['stab']}/6")
if best['win_pct']>=80:
    print(f"     ✅ MỤC TIÊU 80% ĐẠT ĐƯỢC!")
    print(f"     Config: BB_low SL×2 TP×{best['label'][:3]}... + RSI40 + STOCH, CD=2h, ATR40")
else:
    print(f"     Ceiling hiện tại = {best['win_pct']:.0f}%")
    print(f"     Còn loss months: {best['lm']}")
