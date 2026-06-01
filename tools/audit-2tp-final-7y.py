#!/usr/bin/env python3
"""
audit-2tp-final-7y.py — Audit kỹ 2 candidates vs baseline.

OPT_A: close 50% @ ATR×2, close 25% @ ATR×4, trail 25%  (max RA)
OPT_B: close 33% @ ATR×2, close 33% @ ATR×5, trail 33%  (balance RA+ROI)

Checks: per-year, per-setup, win/loss dist, sensitivity ±1 param,
        walk-forward train/test, per-year stability count.
"""
import json, datetime, statistics
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
                locked+=tf*(ep+ae*tm-ep)/ep; remaining-=tf; tp_idx+=1
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

def run(tps, yr_range=None, setup_only=None):
    trades=[]; last={s:0 for s in ["S12","S13","S14"]}
    for i in range(250,n-MAX_HOLD-1):
        ts=bars4h[i]["time"]
        if yr_range:
            yr=datetime.datetime.utcfromtimestamp(ts/1000).year
            if yr<yr_range[0] or yr>yr_range[1]: continue
        if not base_filt(i): continue
        for sn in ["S12","S13","S14"]:
            if setup_only and sn!=setup_only: continue
            if i-last[sn]<CD[sn]: continue
            if not sigs[sn](i): continue
            if do_vol[sn] and not vol_pass(i): continue
            r=sim(i,tps)
            if r is None: continue
            ret,h=r
            yr=datetime.datetime.utcfromtimestamp(ts/1000).year
            trades.append({"ret":ret,"h":h,"yr":yr,"sn":sn})
            last[sn]=i
    return trades

def stats(trades):
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
    avg_win=sum(wins)/len(wins)*100 if wins else 0
    avg_loss=sum(losses)/len(losses)*100 if losses else 0
    return dict(n=nn,ra=ra,wr=wr,rr=rr,roi=sum(rets)*100,dd=max_dd*100,
                stab=f"{pos}/{len(by_yr)}",by_yr=by_yr,
                avg_win=avg_win,avg_loss=avg_loss,wins=wins,losses=losses)

# ── Configs ───────────────────────────────────────────────────────────────────
TPS_BASE = []
TPS_A    = [(2.0,0.50),(4.0,0.25)]   # close 50% @×2, 25% @×4, trail 25%
TPS_B    = [(2.0,0.33),(5.0,0.33)]   # close 33% @×2, 33% @×5, trail 33%
CONFIGS  = [("BASELINE",TPS_BASE), ("OPT_A ×2/×4 50/25",TPS_A), ("OPT_B ×2/×5 33/33",TPS_B)]

t_base=run(TPS_BASE); t_a=run(TPS_A); t_b=run(TPS_B)
s_base=stats(t_base); s_a=stats(t_a); s_b=stats(t_b)

# ── 1. SUMMARY ────────────────────────────────────────────────────────────────
print("\n" + "="*80)
print("1. SUMMARY")
print("="*80)
print(f"  {'':20s}  {'n':>5}  {'RA':>7}  {'WR':>5}  {'R:R':>5}  {'ROI%':>8}  {'DD%':>6}  {'Stab':>6}")
for label,s in [("BASELINE",s_base),("OPT_A",s_a),("OPT_B",s_b)]:
    print(f"  {label:20s}  {s['n']:>5}  {s['ra']:>+7.3f}  {s['wr']:>5.0f}%  {s['rr']:>5.2f}  {s['roi']:>+8.1f}%  {s['dd']:>6.1f}%  {s['stab']:>6}")

# ── 2. PER-YEAR ───────────────────────────────────────────────────────────────
print("\n" + "="*80)
print("2. PER-YEAR BREAKDOWN")
print("="*80)
all_yrs=sorted(set(list(s_base['by_yr'])+list(s_a['by_yr'])+list(s_b['by_yr'])))
print(f"  {'Year':>6}  {'BASE%':>8}  {'OPT_A%':>8}  {'OPT_B%':>8}  {'ΔA':>7}  {'ΔB':>7}  {'Best':>6}")
for yr in all_yrs:
    b=s_base['by_yr'].get(yr,0)*100; a=s_a['by_yr'].get(yr,0)*100; bv=s_b['by_yr'].get(yr,0)*100
    da=a-b; db=bv-b
    best="A" if (a>=bv and a>=b) else ("B" if bv>=b else "BASE")
    print(f"  {yr:>6}  {b:>+8.1f}%  {a:>+8.1f}%  {bv:>+8.1f}%  {da:>+7.1f}%  {db:>+7.1f}%  {best:>6}")
print(f"  {'TOTAL':>6}  {s_base['roi']:>+8.1f}%  {s_a['roi']:>+8.1f}%  {s_b['roi']:>+8.1f}%")
print(f"  {'A wins':>6}  {sum(1 for yr in all_yrs if s_a['by_yr'].get(yr,0)>s_base['by_yr'].get(yr,0))}/{len(all_yrs)} years over BASE")
print(f"  {'B wins':>6}  {sum(1 for yr in all_yrs if s_b['by_yr'].get(yr,0)>s_base['by_yr'].get(yr,0))}/{len(all_yrs)} years over BASE")

# ── 3. PER-SETUP ──────────────────────────────────────────────────────────────
print("\n" + "="*80)
print("3. PER-SETUP")
print("="*80)
print(f"  {'Setup':>6}  {'BASE n':>7} {'BASE RA':>8}  {'A n':>5} {'A RA':>8}  {'B n':>5} {'B RA':>8}  {'ΔA RA':>7}  {'ΔB RA':>7}")
for sn in ["S12","S13","S14"]:
    sb=stats([t for t in t_base if t["sn"]==sn])
    sa=stats([t for t in t_a   if t["sn"]==sn])
    sv=stats([t for t in t_b   if t["sn"]==sn])
    if sb and sa and sv:
        print(f"  {sn:>6}  {sb['n']:>7} {sb['ra']:>+8.3f}  {sa['n']:>5} {sa['ra']:>+8.3f}  {sv['n']:>5} {sv['ra']:>+8.3f}  {sa['ra']-sb['ra']:>+7.3f}  {sv['ra']-sb['ra']:>+7.3f}")

# ── 4. WIN/LOSS ───────────────────────────────────────────────────────────────
print("\n" + "="*80)
print("4. WIN/LOSS DISTRIBUTION")
print("="*80)
for label,s in [("BASELINE",s_base),("OPT_A",s_a),("OPT_B",s_b)]:
    print(f"  {label}: avg_win={s['avg_win']:+.2f}%  avg_loss={s['avg_loss']:+.2f}%  "
          f"max_win={max(s['wins'])*100:+.2f}%  max_loss={min(s['losses'])*100:+.2f}%  "
          f"n_win={len(s['wins'])}  n_loss={len(s['losses'])}")

# ── 5. SENSITIVITY A — TP1 mult ±0.5 ─────────────────────────────────────────
print("\n" + "="*80)
print("5. SENSITIVITY OPT_A — vary TP1 mult (TP2×4 50/25 fixed)")
print("="*80)
print(f"  {'TP1×':>5}  {'RA':>7}  {'WR':>5}  {'ROI%':>8}  {'DD%':>6}  {'Stab':>6}  {'ΔRA':>7}")
for m1 in [1.0,1.5,2.0,2.5,3.0]:
    t=run([(m1,0.50),(4.0,0.25)]); s=stats(t)
    if s: print(f"  {m1:>5.1f}  {s['ra']:>+7.3f}  {s['wr']:>5.0f}%  {s['roi']:>+8.1f}%  {s['dd']:>6.1f}%  {s['stab']:>6}  {s['ra']-s_base['ra']:>+7.3f}")

print("\n5b. SENSITIVITY OPT_A — vary TP2 mult (TP1×2 50/25 fixed)")
print(f"  {'TP2×':>5}  {'RA':>7}  {'WR':>5}  {'ROI%':>8}  {'DD%':>6}  {'Stab':>6}  {'ΔRA':>7}")
for m2 in [3.0,4.0,5.0,6.0,7.0]:
    t=run([(2.0,0.50),(m2,0.25)]); s=stats(t)
    if s: print(f"  {m2:>5.1f}  {s['ra']:>+7.3f}  {s['wr']:>5.0f}%  {s['roi']:>+8.1f}%  {s['dd']:>6.1f}%  {s['stab']:>6}  {s['ra']-s_base['ra']:>+7.3f}")

# ── 6. SENSITIVITY B ──────────────────────────────────────────────────────────
print("\n" + "="*80)
print("6. SENSITIVITY OPT_B — vary TP2 mult (TP1×2 33/33 fixed)")
print("="*80)
print(f"  {'TP2×':>5}  {'RA':>7}  {'WR':>5}  {'ROI%':>8}  {'DD%':>6}  {'Stab':>6}  {'ΔRA':>7}")
for m2 in [3.0,4.0,5.0,6.0,7.0]:
    t=run([(2.0,0.33),(m2,0.33)]); s=stats(t)
    if s: print(f"  {m2:>5.1f}  {s['ra']:>+7.3f}  {s['wr']:>5.0f}%  {s['roi']:>+8.1f}%  {s['dd']:>6.1f}%  {s['stab']:>6}  {s['ra']-s_base['ra']:>+7.3f}")

# ── 7. WALK-FORWARD ───────────────────────────────────────────────────────────
print("\n" + "="*80)
print("7. WALK-FORWARD TRAIN(2019-22) / TEST(2023-26)")
print("="*80)
print(f"  {'Config':24s}  {'TRA n':>6}  {'TRA RA':>7}  {'TRA stab':>9}  {'TST n':>6}  {'TST RA':>7}  {'TST stab':>9}  {'Degrade':>8}  {'PASS?':>6}")
for label,tps in CONFIGS:
    tr=stats(run(tps,yr_range=(2019,2022))); te=stats(run(tps,yr_range=(2023,2026)))
    if tr and te:
        deg=(te['ra']-tr['ra'])/abs(tr['ra'])*100 if tr['ra']!=0 else 0
        ok="✓" if (te['ra']>s_base['ra']+0.03 and "3/3" in te['stab'] and deg>-35) else "✗"
        print(f"  {label:24s}  {tr['n']:>6}  {tr['ra']:>+7.3f}  {tr['stab']:>9}  {te['n']:>6}  {te['ra']:>+7.3f}  {te['stab']:>9}  {deg:>+8.1f}%  {ok:>6}")

# ── 8. PER-YEAR STABILITY COUNT ───────────────────────────────────────────────
print("\n" + "="*80)
print("8. PER-YEAR POSITIVE COUNT (consistency check)")
print("="*80)
for label,s in [("BASELINE",s_base),("OPT_A",s_a),("OPT_B",s_b)]:
    yrs_pos=[yr for yr,v in s['by_yr'].items() if v>0]
    yrs_neg=[yr for yr,v in s['by_yr'].items() if v<=0]
    print(f"  {label}: pos={sorted(yrs_pos)}  neg={sorted(yrs_neg)}  stab={s['stab']}")

# ── 9. VERDICT ────────────────────────────────────────────────────────────────
print("\n" + "="*80)
print("9. VERDICT")
print("="*80)
tr_a=stats(run(TPS_A,yr_range=(2019,2022))); te_a=stats(run(TPS_A,yr_range=(2023,2026)))
tr_b=stats(run(TPS_B,yr_range=(2019,2022))); te_b=stats(run(TPS_B,yr_range=(2023,2026)))

def verdict(label,s7y,s_tr,s_te,s_base):
    checks=[]
    checks.append(("RA 7y > BASE+0.05", s7y['ra']>s_base['ra']+0.05))
    checks.append(("Stab 7y ≥ 6/6",     "6/6" in s7y['stab']))
    checks.append(("DD 7y < BASE DD",   s7y['dd']<s_base['dd']))
    checks.append(("TEST RA > BASE RA", s_te['ra']>s_base['ra'] if s_te else False))
    checks.append(("TEST stab 3/3",     "3/3" in s_te['stab'] if s_te else False))
    deg=(s_te['ra']-s_tr['ra'])/abs(s_tr['ra'])*100 if (s_tr and s_tr['ra']!=0) else 0
    checks.append(("Degrade < 35%",     deg>-35))
    passed=sum(1 for _,v in checks if v)
    print(f"\n  [{label}]")
    for name,ok in checks: print(f"    {'✓' if ok else '✗'} {name}")
    result="✅ ACCEPT" if passed>=5 else ("⚠️  CONDITIONAL" if passed>=4 else "❌ REJECT")
    print(f"    → {result} ({passed}/6 checks passed)")

verdict("OPT_A ×2/×4 50/25",s_a,tr_a,te_a,s_base)
verdict("OPT_B ×2/×5 33/33",s_b,tr_b,te_b,s_base)
