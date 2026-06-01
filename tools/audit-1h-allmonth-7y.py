#!/usr/bin/env python3
"""
audit-1h-allmonth-7y.py — Push monthly win% → 100%

Nguyên lý: WR per trade × số lệnh/tháng → monthly win%
Nếu WR=78% và có 10 trades/tháng → P(tháng dương) = 1 - P(all loss) ≈ 99.8%

Approach:
  1. Giảm cooldown (CD=1h → nhiều lệnh hơn)
  2. TP tight (×1.0) để WR cao nhất
  3. Thêm signals mới để cover nhiều context hơn
  4. Test portfolio: 4h hedge01 + 1h BB/RSI (xem combined monthly win)

Report: per-month PnL table + monthly win statistics
"""
import json, datetime, math
from collections import defaultdict

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FEE   = 0.05 / 100
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
e200_1h=ema(c1h,200); e9_1h=ema(c1h,9); e21_1h=ema(c1h,21)
bbu,bbl=bb_s(c1h); vma20=vol_ma(bars1h,20)
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
    if i4h<ATR_LB+14: return False
    vs=[atr4[j]/c4h[j] for j in range(i4h-ATR_LB,i4h) if atr4[j] and c4h[j]]
    if len(vs)<ATR_LB: return False
    cur=atr4[i4h]/c4h[i4h] if atr4[i4h] and c4h[i4h] else None
    return cur is not None and cur>=sorted(vs)[int(len(vs)*.5)]

print("Precomputing 4h context...")
ctx4h=[ctx4h_ok(i) for i in range(n4h)]

def filt1h(i):
    e1h=e200_1h[i]
    if e1h and c1h[i]<e1h: return False
    i4h=get_4h_idx(bars1h[i]["time"])
    return 0<=i4h<n4h and ctx4h[i4h]

# All signal types on 1h
def all_signals(i):
    sigs=[]
    c=c1h[i]; ae=atr1h[i]
    if ae is None: return []
    # BB lower touch + bullish
    if bbl[i] and bars1h[i]["low"]<=bbl[i] and c>bars1h[i]["open"]: sigs.append("BB")
    # RSI cross 40
    if rsi1h[i] and rsi1h[i-1] and rsi1h[i-1]<40 and rsi1h[i]>=40: sigs.append("RSI40")
    # RSI cross 30 (deeper)
    if rsi1h[i] and rsi1h[i-1] and rsi1h[i-1]<30 and rsi1h[i]>=30: sigs.append("RSI30")
    # Stoch cross 20
    if stk1h[i] and stk1h[i-1] and stk1h[i-1]<20 and stk1h[i]>=20: sigs.append("STOCH")
    # EMA9 cross EMA21
    if e9_1h[i] and e21_1h[i] and e9_1h[i-1] and e21_1h[i-1]:
        if e9_1h[i-1]<=e21_1h[i-1] and e9_1h[i]>e21_1h[i]: sigs.append("EMA9x21")
    # Hammer
    body=abs(c-bars1h[i]["open"]); lw=min(c,bars1h[i]["open"])-bars1h[i]["low"]; brange=bars1h[i]["high"]-bars1h[i]["low"]
    if brange>0 and lw>=2*body and lw>=0.6*brange: sigs.append("HAMMER")
    # ATR mini-breakout (0.5×)
    if i>0 and c>bars1h[i-1]["close"]+ae*0.5: sigs.append("ATR05")
    return sigs

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

def run(sl_m, tp_m, signal_set, cd_h, max_h=24):
    """signal_set: subset of signal names to use"""
    trades=[]; last={s:-cd_h for s in signal_set}
    for i in range(50,n1h-max_h):
        if not filt1h(i): continue
        fired=[s for s in all_signals(i) if s in signal_set]
        ts=bars1h[i]["time"]
        yr=datetime.datetime.utcfromtimestamp(ts/1000).year
        mo=yr*100+datetime.datetime.utcfromtimestamp(ts/1000).month
        for sig in fired:
            if i-last[sig]<cd_h: continue
            r=sim(i,sl_m,tp_m,max_h)
            if r is not None:
                trades.append({"ret":r,"mo":mo,"yr":yr,"sig":sig})
                last[sig]=i
    return trades

def analyze(trades, label):
    if not trades: return None
    by_mo=defaultdict(list)
    for t in trades: by_mo[t["mo"]].append(t["ret"])
    mos=sorted(by_mo.keys())
    win_mo=sum(1 for m in mos if sum(by_mo[m])>0)
    tot_mo=len(mos)
    win_pct=win_mo/tot_mo*100

    rets=[t["ret"] for t in trades];n_=len(rets)
    mean=sum(rets)/n_;sd=(sum((r-mean)**2 for r in rets)/n_)**0.5 or 1e-9
    ra=mean/sd; wr=sum(1 for r in rets if r>0)/n_*100

    # Avg trades per active month
    avg_n_mo=n_/tot_mo

    by_yr=defaultdict(float)
    for t in trades: by_yr[t["yr"]]+=t["ret"]
    stab=sum(1 for v in by_yr.values() if v>0)

    loss_months=[m for m in mos if sum(by_mo[m])<=0]

    flag="✅✅" if win_pct>=90 else ("✅" if win_pct>=75 else ("⚠️" if win_pct>=65 else "✗"))
    print(f"  {label:50s}  win={win_pct:.0f}%({win_mo}/{tot_mo}) n/mo={avg_n_mo:.1f} RA={ra:+.3f} WR={wr:.0f}% stab={stab}/6  {flag}")
    return {"label":label,"win_pct":win_pct,"win_mo":win_mo,"tot_mo":tot_mo,"n":n_,"ra":ra,"wr":wr,
            "stab":stab,"loss_months":loss_months,"avg_n_mo":avg_n_mo,"by_mo":by_mo,"by_yr":by_yr}

print("\n" + "="*75)
print("PUSH MONTHLY WIN% → 100%")
print("  Key: more trades/month → higher monthly consistency")
print("="*75)

ALL_SIGS=["BB","RSI40","RSI30","STOCH","EMA9x21","HAMMER","ATR05"]
CORE_SIGS=["BB","RSI40"]

results=[]
print("\n[A] Vary cooldown — more trades/month]")
for cd in [1,2,3,4,6]:
    r=analyze(run(2.,1.0,CORE_SIGS,cd), f"BB+RSI40  TP×1.0 CD={cd}h")
    if r: results.append(r)

print("\n[B] Expand signal set — more signal types]")
for sigs,name in [
    (["BB","RSI40","STOCH"],"BB+RSI+STOCH"),
    (["BB","RSI40","RSI30","STOCH"],"BB+RSI+RSI30+STOCH"),
    (["BB","RSI40","HAMMER"],"BB+RSI+HAMMER"),
    (ALL_SIGS[:5],"BB+RSI+STOCH+EMA+HAMMER"),
    (ALL_SIGS,"ALL_7_SIGNALS"),
]:
    r=analyze(run(2.,1.0,sigs,2), f"{name} TP×1.0 CD=2h")
    if r: results.append(r)

print("\n[C] Best combo + tight TP]")
for tp in [0.7, 1.0, 1.5]:
    r=analyze(run(2.,tp,ALL_SIGS,1), f"ALL_7 TP×{tp} CD=1h")
    if r: results.append(r)

print("\n[D] SL tighter → higher WR (SL×1)]")
for tp in [1.0, 1.5, 2.0]:
    r=analyze(run(1.,tp,CORE_SIGS,2), f"BB+RSI SL×1 TP×{tp} CD=2h")
    if r: results.append(r)

print("\n[E] Combined 4h+1h portfolio (separate buckets)]")
# 4h trades from file we already have
def run_4h_simple():
    """Simplified 4h run for combo check."""
    from collections import defaultdict
    # Use same logic but simplified for month-tracking
    trades=[]; last={"S13":-4,"S14":-200}
    ATR_BREAK_MULT=1.2
    dh20=[None]*n4h
    for i in range(20,n4h): dh20[i]=max(bars4h[j]["high"] for j in range(i-20,i))
    vma10=[None]*n4h
    for i in range(9,n4h): vma10[i]=sum(bars4h[j]["volume"] for j in range(i-10,i))/10
    e200_4h=ema(c4h,200); e50_4h=ema(c4h,50)

    for i in range(100,n4h-50):
        if not ctx4h[i]: continue
        e1h=e200_1h[get_4h_idx(bars4h[i]["time"])] if False else None  # skip for speed
        # S13 ATR breakout
        if atr4[i] and i>0 and c4h[i]>bars4h[i-1]["close"]+atr4[i]*ATR_BREAK_MULT and i-last["S13"]>=1:
            if vma10[i] and bars4h[i]["volume"]>=vma10[i]*1.2:
                ep=c4h[i]; ae=atr4[i]
                if ae:
                    sl=ep-ae*4; hwm=ep; ret=None
                    for h in range(1,200):
                        j=i+h
                        if j>=n4h: break
                        mult=4 if h<24 else 3
                        if c4h[j]>hwm: hwm=c4h[j]; sl=hwm-ae*mult
                        elif h>=24:
                            t=hwm-ae*3
                            if t>sl: sl=t
                        if bars4h[j]["low"]<=sl: ret=(sl-ep)/ep-2*FEE; break
                    if ret is None: ret=(c4h[min(i+200,n4h-1)]-ep)/ep-2*FEE
                    ts=bars4h[i]["time"]; yr=datetime.datetime.utcfromtimestamp(ts/1000).year
                    mo=yr*100+datetime.datetime.utcfromtimestamp(ts/1000).month
                    trades.append({"ret":ret,"mo":mo,"yr":yr,"sig":"S13"})
                    last["S13"]=i
        # S14 Donchian
        if dh20[i] and c4h[i]>dh20[i] and i-last["S14"]>=200:
            ep=c4h[i]; ae=atr4[i]
            if ae:
                sl=ep-ae*4; hwm=ep; ret=None
                for h in range(1,200):
                    j=i+h
                    if j>=n4h: break
                    mult=4 if h<24 else 3
                    if c4h[j]>hwm: hwm=c4h[j]; sl=hwm-ae*mult
                    elif h>=24:
                        t=hwm-ae*3
                        if t>sl: sl=t
                    if bars4h[j]["low"]<=sl: ret=(sl-ep)/ep-2*FEE; break
                if ret is None: ret=(c4h[min(i+200,n4h-1)]-ep)/ep-2*FEE
                ts=bars4h[i]["time"]; yr=datetime.datetime.utcfromtimestamp(ts/1000).year
                mo=yr*100+datetime.datetime.utcfromtimestamp(ts/1000).month
                trades.append({"ret":ret,"mo":mo,"yr":yr,"sig":"S14"})
                last["S14"]=i
    return trades

t4h=run_4h_simple()
t1h_best=run(2.,1.0,CORE_SIGS,2)
combo=t4h+t1h_best

# Per-month combo (sum both)
by_mo_4h=defaultdict(float)
for t in t4h: by_mo_4h[t["mo"]]+=t["ret"]
by_mo_1h=defaultdict(float)
for t in t1h_best: by_mo_1h[t["mo"]]+=t["ret"]
all_months=sorted(set(list(by_mo_4h.keys())+list(by_mo_1h.keys())))
combined_mo={m: by_mo_4h.get(m,0)+by_mo_1h.get(m,0) for m in all_months}
win_combo=sum(1 for v in combined_mo.values() if v>0)
print(f"\n  4h S13+S14 standalone:  {sum(1 for v in by_mo_4h.values() if v>0)}/{len(by_mo_4h)} months positive")
print(f"  1h BB+RSI standalone:   {sum(1 for v in by_mo_1h.values() if v>0)}/{len(by_mo_1h)} months positive")
print(f"  COMBINED portfolio:     {win_combo}/{len(all_months)} months positive ← key number")
print(f"\n  Per-year combined:")
by_yr=defaultdict(dict)
for m,v in combined_mo.items(): by_yr[m//100][m%100]=v
for yr in sorted(by_yr):
    ms=by_yr[yr]; win=sum(1 for v in ms.values() if v>0); tot=len(ms)
    row="".join(f"{ms.get(mn,0)*100:>+6.0f}%" if mn in ms else "     —" for mn in range(1,13))
    print(f"  {yr}: [{row}]  {win}/{tot}")

r_combo=analyze(combo,"PORTFOLIO: 4h(S13+S14) + 1h(BB+RSI)")
if r_combo: results.append(r_combo)

# FINAL RANKING
print("\n" + "="*75)
print("FINAL RANKING — sorted by monthly win%")
print("="*75)
results.sort(key=lambda x:x["win_pct"],reverse=True)
print(f"\n  {'Config':50s}  {'mo_win':>7}  {'n/mo':>5}  {'RA':>7}  {'WR':>5}")
for r in results[:20]:
    flag="✅✅" if r["win_pct"]>=90 else ("✅" if r["win_pct"]>=75 else ("⚠️" if r["win_pct"]>=65 else "✗"))
    print(f"  {r['label']:50s}  {r['win_pct']:>5.0f}%({r['win_mo']}/{r['tot_mo']})  {r['avg_n_mo']:>4.1f}  {r['ra']:>+7.3f}  {r['wr']:>4.0f}%  {flag}")

best=results[0]
print(f"\n  ⭐ BEST: {best['label']}")
print(f"     Monthly win: {best['win_mo']}/{best['tot_mo']} ({best['win_pct']:.0f}%)")
print(f"     Avg {best['avg_n_mo']:.1f} trades/month, WR={best['wr']:.0f}%, RA={best['ra']:+.3f}")
if best["loss_months"]:
    print(f"     Still loss months: {best['loss_months'][:10]}")
    print(f"     → Những tháng này market condition đặc biệt, không thể cover hoàn toàn")
