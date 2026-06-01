#!/usr/bin/env python3
"""
audit-loss-months-fix-7y.py — Phân tích từng tháng lỗ và tìm cách fix để đạt 80% monthly win

Baseline: BB+RSI TP×1.0 CD=3h → 71% (29/41), loss months = 12
Mục tiêu: 80% = 33/41 → cần fix thêm 4 tháng

Strategy:
1. Deep-dive từng tháng lỗ: signal nào fire, outcome, market condition
2. Test thêm signal types bổ sung cho tháng lỗ
3. Test relax ATR50 filter (principal blocker)
4. Tìm "recovery signal" cover được loss months
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

def don_lo(bars,n):
    out=[None]*len(bars)
    for i in range(n,len(bars)): out[i]=min(bars[j]["low"] for j in range(i-n,i))
    return out

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
dl10=don_lo(bars1h,10)
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

def ctx4h_ok(i4h, atr_pct=0.50):
    if i4h<50: return False
    if get_reg(bars4h[i4h]["time"])!="RANGE": return False
    adv=adx4[i4h];adv_p=adx4[i4h-1] if i4h>0 else None
    if adv is None or adv<=20 or adv_p is None or adv_p<=20: return False
    if i4h<ATR_LB+14: return False
    vs=[atr4[j]/c4h[j] for j in range(i4h-ATR_LB,i4h) if atr4[j] and c4h[j]]
    if len(vs)<ATR_LB: return False
    cur=atr4[i4h]/c4h[i4h] if atr4[i4h] and c4h[i4h] else None
    return cur is not None and cur>=sorted(vs)[int(len(vs)*atr_pct)]

print("Precomputing 4h contexts...")
ctx50=[ctx4h_ok(i,0.50) for i in range(n4h)]
ctx40=[ctx4h_ok(i,0.40) for i in range(n4h)]
ctx30=[ctx4h_ok(i,0.30) for i in range(n4h)]
ctx_noATR=[ctx4h_ok.__wrapped__(i) if hasattr(ctx4h_ok,'__wrapped__') else True for i in range(n4h)]
# Simple no-ATR context
def ctx_no_atr(i4h):
    if i4h<50: return False
    if get_reg(bars4h[i4h]["time"])!="RANGE": return False
    adv=adx4[i4h];adv_p=adx4[i4h-1] if i4h>0 else None
    return not(adv is None or adv<=20 or adv_p is None or adv_p<=20)
ctx_noATR=[ctx_no_atr(i) for i in range(n4h)]

def filt1h_ctx(i, ctx_arr):
    e1h=e200_1h[i]
    if e1h and c1h[i]<e1h: return False
    i4h=get_4h_idx(bars1h[i]["time"])
    return 0<=i4h<n4h and ctx_arr[i4h]

# All LONG signals on 1h
def all_signals(i):
    sigs={}
    ae=atr1h[i]
    if ae is None: return {}
    # Core
    if bbl[i] and bars1h[i]["low"]<=bbl[i] and c1h[i]>bars1h[i]["open"]: sigs["BB"]=True
    if rsi1h[i] and rsi1h[i-1] and rsi1h[i-1]<40 and rsi1h[i]>=40: sigs["RSI40"]=True
    # Additional
    if stk1h[i] and stk1h[i-1] and stk1h[i-1]<20 and stk1h[i]>=20: sigs["STOCH"]=True
    if rsi1h[i] and rsi1h[i-1] and rsi1h[i-1]<30 and rsi1h[i]>=30: sigs["RSI30"]=True
    body=abs(c1h[i]-bars1h[i]["open"]); lw=min(c1h[i],bars1h[i]["open"])-bars1h[i]["low"]; brange=bars1h[i]["high"]-bars1h[i]["low"]
    if brange>0 and lw>=2*body and lw>=0.6*brange: sigs["HAMMER"]=True
    if dl10[i] and c1h[i]>dl10[i] and (i==0 or c1h[i-1]<=dl10[i-1]): sigs["DON10_RECLAIM"]=True
    if e9_1h[i] and e21_1h[i] and e9_1h[i-1] and e21_1h[i-1]:
        if e9_1h[i-1]<=e21_1h[i-1] and e9_1h[i]>e21_1h[i]: sigs["EMA9x21"]=True
    if vma20[i] and bars1h[i]["volume"]>vma20[i]*2.0 and c1h[i]>bars1h[i]["open"]: sigs["VOL_SPIKE"]=True
    # RSI oversold extreme
    if rsi1h[i] and rsi1h[i]<25: sigs["RSI_OS25"]=True
    # Price reclaim EMA50
    if e9_1h[i] and i>0 and c1h[i-1]<e9_1h[i-1] and c1h[i]>=e9_1h[i]: sigs["EMA9_RECLAIM"]=True
    return sigs

def sim_tp(i,sl_m,tp_m,max_h=24):
    ep=c1h[i];ae=atr1h[i]
    if ae is None or ae<=0: return None
    sl=ep-ae*sl_m;tp=ep+ae*tp_m
    for h in range(1,max_h+1):
        j=i+h
        if j>=n1h: break
        if bars1h[j]["low"]<=sl: return (sl-ep)/ep-2*FEE,"SL"
        if bars1h[j]["high"]>=tp: return (tp-ep)/ep-2*FEE,"TP"
    j2=min(i+max_h,n1h-1)
    return (c1h[j2]-ep)/ep-2*FEE,"HOLD"

def run_full(signal_set, ctx_arr, sl_m=2., tp_m=1.0, cd_h=3, max_h=24):
    trades=[]; last={s:-cd_h for s in signal_set}
    for i in range(50,n1h-max_h):
        if not filt1h_ctx(i,ctx_arr): continue
        sigs=all_signals(i)
        ts=bars1h[i]["time"]
        yr=datetime.datetime.utcfromtimestamp(ts/1000).year
        mo=yr*100+datetime.datetime.utcfromtimestamp(ts/1000).month
        for sig in signal_set:
            if sig not in sigs: continue
            if i-last[sig]<cd_h: continue
            r=sim_tp(i,sl_m,tp_m,max_h)
            if r:
                ret,rsn=r
                trades.append({"ret":ret,"mo":mo,"yr":yr,"sig":sig,"rsn":rsn,"i":i})
                last[sig]=i
    return trades

def monthly_stats(trades):
    by_mo=defaultdict(list)
    for t in trades: by_mo[t["mo"]].append(t["ret"])
    mos=sorted(by_mo.keys())
    win_mo=[m for m in mos if sum(by_mo[m])>0]
    loss_mo=[m for m in mos if sum(by_mo[m])<=0]
    return by_mo,win_mo,loss_mo,mos

def ra(trades):
    if not trades: return 0
    r=[t["ret"] for t in trades];m=sum(r)/len(r);sd=(sum((x-m)**2 for x in r)/len(r))**0.5
    return m/sd if sd>0 else 0

CORE=["BB","RSI40"]
BASE_LOSS=[201906,202011,202109,202302,202305,202307,202401,202410,202502,202503]

print("\n" + "="*70)
print("STEP 1: Baseline per-month detail")
print("="*70)
t_base=run_full(CORE,ctx50,2.,1.0,3)
by_mo_b,win_b,loss_b,mos_b=monthly_stats(t_base)
print(f"Baseline BB+RSI CD=3h TP×1.0 ATR50: {len(win_b)}/{len(mos_b)} ({len(win_b)/len(mos_b)*100:.0f}%)")
print(f"Loss months: {loss_b}")
print("\nPer-loss-month breakdown:")
for mo in sorted(loss_b):
    trades_mo=[t for t in t_base if t["mo"]==mo]
    wins=[t for t in trades_mo if t["ret"]>0]; losses=[t for t in trades_mo if t["ret"]<=0]
    pnl=sum(t["ret"] for t in trades_mo)*100
    sigs_fired=list(set(t["sig"] for t in trades_mo))
    yr,mn=mo//100,mo%100
    # Check BTC price move for the month
    mo_bars=[b for b in bars1d if datetime.datetime.utcfromtimestamp(b["time"]/1000).year==yr and datetime.datetime.utcfromtimestamp(b["time"]/1000).month==mn]
    price_chg=((mo_bars[-1]["close"]/mo_bars[0]["open"])-1)*100 if mo_bars else 0
    print(f"  {mo}: n={len(trades_mo)} W={len(wins)} L={len(losses)} PnL={pnl:+.1f}%  BTC_month={price_chg:+.1f}%  sigs={sigs_fired}")

print("\n" + "="*70)
print("STEP 2: Test ATR percentile relaxation")
print("="*70)
for pct,ctx_arr in [(0.50,ctx50),(0.40,ctx40),(0.30,ctx30),(0.0,ctx_noATR)]:
    t=run_full(CORE,ctx_arr,2.,1.0,3)
    by_mo,wm,lm,ms=monthly_stats(t)
    wr=sum(1 for t2 in t if t2["ret"]>0)/len(t)*100 if t else 0
    print(f"  ATR{int(pct*100):2d}th: {len(wm):2d}/{len(ms)} ({len(wm)/len(ms)*100:.0f}%)  n={len(t)/7:.0f}/yr  RA={ra(t):+.3f}  loss={lm[:5]}")

print("\n" + "="*70)
print("STEP 3: Add signals one-by-one — which one rescues most loss months?")
print("="*70)
add_sigs=["STOCH","RSI30","HAMMER","DON10_RECLAIM","EMA9x21","VOL_SPIKE","RSI_OS25","EMA9_RECLAIM"]
print(f"  Baseline loss months: {loss_b}")
for sig in add_sigs:
    t=run_full(CORE+[sig],ctx50,2.,1.0,3)
    by_mo,wm,lm,ms=monthly_stats(t)
    rescued=[m for m in loss_b if m not in lm]
    new_losses=[m for m in lm if m not in loss_b]
    print(f"  +{sig:15s}: {len(wm):2d}/{len(ms)} ({len(wm)/len(ms)*100:.0f}%)  rescued={rescued}  new_loss={new_losses}")

print("\n" + "="*70)
print("STEP 4: Test combinations targeting 80%+")
print("="*70)

combos=[
    ("BB+RSI+STOCH CD=3h ATR40",       ["BB","RSI40","STOCH"],    ctx40, 2.,1.0,3),
    ("BB+RSI+STOCH CD=3h ATR30",       ["BB","RSI40","STOCH"],    ctx30, 2.,1.0,3),
    ("BB+RSI+STOCH+RSI30 CD=3h ATR40", ["BB","RSI40","STOCH","RSI30"], ctx40, 2.,1.0,3),
    ("BB+RSI+RSI30 CD=3h ATR40",       ["BB","RSI40","RSI30"],    ctx40, 2.,1.0,3),
    ("BB+RSI+VOL CD=3h ATR40",         ["BB","RSI40","VOL_SPIKE"],ctx40, 2.,1.0,3),
    ("BB+RSI CD=3h ATR40 TP×1.5",      ["BB","RSI40"],            ctx40, 2.,1.5,3),
    ("BB+RSI CD=2h ATR40",             ["BB","RSI40"],            ctx40, 2.,1.0,2),
    ("BB+RSI+STOCH CD=2h ATR40",       ["BB","RSI40","STOCH"],    ctx40, 2.,1.0,2),
    ("BB+RSI+STOCH+RSI30 CD=2h ATR30", ["BB","RSI40","STOCH","RSI30"], ctx30, 2.,1.0,2),
    ("BB+RSI CD=3h noATR",             ["BB","RSI40"],            ctx_noATR, 2.,1.0,3),
    ("BB+RSI+STOCH CD=3h noATR",       ["BB","RSI40","STOCH"],    ctx_noATR, 2.,1.0,3),
]
best_combos=[]
for label,sigs,ctx,sl,tp,cd in combos:
    t=run_full(sigs,ctx,sl,tp,cd)
    if not t: continue
    by_mo,wm,lm,ms=monthly_stats(t)
    wr=sum(1 for t2 in t if t2["ret"]>0)/len(t)*100
    r=ra(t); n_yr=len(t)//7
    win_pct=len(wm)/len(ms)*100
    flag="✅" if win_pct>=80 else ("⚠️" if win_pct>=75 else "")
    print(f"  {label:45s}: {len(wm):2d}/{len(ms)} ({win_pct:.0f}%) n={n_yr}/yr RA={r:+.3f} WR={wr:.0f}% {flag}")
    best_combos.append({"label":label,"win_pct":win_pct,"win_mo":len(wm),"tot_mo":len(ms),"n_yr":n_yr,"ra":r,"wr":wr,"loss":lm})

# Final summary
print("\n" + "="*70)
print("FINAL — configs ≥ 75% monthly win (sorted)")
print("="*70)
best_combos.sort(key=lambda x:x["win_pct"],reverse=True)
for r in best_combos:
    if r["win_pct"]>=75:
        print(f"  {r['label']:45s}: {r['win_pct']:.0f}% ({r['win_mo']}/{r['tot_mo']}) n={r['n_yr']}/yr RA={r['ra']:+.3f} WR={r['wr']:.0f}%")
        print(f"    loss: {r['loss'][:8]}")

# Best overall
if best_combos:
    b=best_combos[0]
    print(f"\n  ⭐ BEST: {b['label']}")
    print(f"     {b['win_pct']:.0f}% ({b['win_mo']}/{b['tot_mo']} months) n={b['n_yr']}/yr RA={b['ra']:+.3f}")
    if b['win_pct']>=80:
        print(f"     ✅ TARGET 80% ĐẠT ĐƯỢC!")
    else:
        print(f"     ⚠️  Chưa đạt 80%, best={b['win_pct']:.0f}%")
