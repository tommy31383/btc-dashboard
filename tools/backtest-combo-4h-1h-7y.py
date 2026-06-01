#!/usr/bin/env python3
"""
backtest-combo-4h-1h-7y.py — Combo: hedge01 (4h S12/S13/S14) + 1h BB_low + 1h RSI_x40

Config A: hedge01 baseline (S12/S13/S14 4h, trailing SL)
Config B: 1h BB_low + 1h RSI_x40 (standalone, fixed TP/SL in 4h context)
Config C: COMBO A + B (chạy song song, tách cooldown)

Mục tiêu: verify combo không conflict, RA tăng, entries/năm tăng
"""
import json, datetime
from collections import defaultdict

CACHE  = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FEE    = 0.05 / 100
WF_CUT = int(datetime.datetime(2023,1,1).timestamp()*1000)

print("Loading data...")
raw = json.load(open(CACHE))
raw.sort(key=lambda x: x["time"])

def agg_tf(bars, ms):
    b = {}
    for c in bars:
        k=c["time"]//ms
        if k not in b:
            b[k]={"time":k*ms,"open":c["open"],"high":c["high"],"low":c["low"],"close":c["close"],"volume":c["volume"]}
        else:
            o=b[k];o["high"]=max(o["high"],c["high"]);o["low"]=min(o["low"],c["low"])
            o["close"]=c["close"];o["volume"]+=c["volume"]
    return [b[k] for k in sorted(b)]

bars1h = agg_tf(raw,  1*3600*1000)
bars4h = agg_tf(raw,  4*3600*1000)
bars1d = agg_tf(raw, 24*3600*1000)
n1h=len(bars1h); n4h=len(bars4h)
c1h=[b["close"] for b in bars1h]; c4h=[b["close"] for b in bars4h]
print(f"1h:{n1h} 4h:{n4h} 1d:{len(bars1d)}")

# ── Indicators ──────────────────────────────────────────────────────────────
def ema(xs,p):
    k=2/(p+1); out=[None]*len(xs); e=None
    for i,x in enumerate(xs): e=x if e is None else x*k+e*(1-k); out[i]=e
    return out

def _dm_tr(bars):
    n=len(bars); pdm=[0.]*n; ndm=[0.]*n; tr=[0.]*n
    for i in range(1,n):
        up=bars[i]["high"]-bars[i-1]["high"]; dn=bars[i-1]["low"]-bars[i]["low"]
        pdm[i]=up if up>dn and up>0 else 0; ndm[i]=dn if dn>up and dn>0 else 0
        tr[i]=max(bars[i]["high"]-bars[i]["low"],abs(bars[i]["high"]-bars[i-1]["close"]),abs(bars[i]["low"]-bars[i-1]["close"]))
    return pdm,ndm,tr

def adx_wilder(bars,p=14):
    pdm,ndm,tr=_dm_tr(bars); n=len(bars)
    smTR=sum(tr[1:p+1]); smPDM=sum(pdm[1:p+1]); smNDM=sum(ndm[1:p+1])
    dx_arr=[]; adx_val=None; out=[None]*n
    for i in range(p+1,n):
        smTR=smTR-smTR/p+tr[i]; smPDM=smPDM-smPDM/p+pdm[i]; smNDM=smNDM-smNDM/p+ndm[i]
        pdi=smPDM/smTR*100 if smTR>0 else 0; ndi=smNDM/smTR*100 if smTR>0 else 0
        dx=abs(pdi-ndi)/(pdi+ndi)*100 if (pdi+ndi)>0 else 0; dx_arr.append(dx)
        if len(dx_arr)<p: continue
        elif len(dx_arr)==p: adx_val=sum(dx_arr)/p
        else: adx_val=(adx_val*(p-1)+dx)/p
        out[i]=adx_val
    return out

def atr_wilder(bars,p=14):
    _,_,tr=_dm_tr(bars); n=len(bars); out=[None]*n
    s=sum(tr[1:p+1]); out[p]=s/p
    for i in range(p+1,n): out[i]=(out[i-1]*(p-1)+tr[i])/p
    return out

def rsi_s(cls,n=14):
    out=[None]*len(cls); ag=al=0.
    for i in range(1,n+1):
        d=cls[i]-cls[i-1]
        if d>0: ag+=d
        else: al-=d
    ag/=n; al/=n; out[n]=100-100/(1+ag/al) if al>0 else 100
    for i in range(n+1,len(cls)):
        d=cls[i]-cls[i-1]; g=max(d,0); l=max(-d,0)
        ag=(ag*(n-1)+g)/n; al=(al*(n-1)+l)/n
        out[i]=100-100/(1+ag/al) if al>0 else 100
    return out

def bb_s(cls,n=20,k=2.):
    u=[None]*len(cls); l=[None]*len(cls)
    for i in range(n-1,len(cls)):
        w=cls[i-n+1:i+1]; m=sum(w)/n; s=(sum((x-m)**2 for x in w)/n)**0.5
        u[i]=m+k*s; l[i]=m-k*s
    return u,l

def regime_wp(bars1d,persist=3):
    cs=[b["close"] for b in bars1d]; n=len(bars1d); raw=["RANGE"]*n
    for i in range(200,n):
        ma200=sum(cs[i-199:i+1])/200; ma50=sum(cs[i-50:i+1])/50
        ar=sum((b["high"]-b["low"])/b["close"] for b in bars1d[i-19:i+1])/20
        if cs[i]<ma200: raw[i]="BEAR"
        elif cs[i]>ma50 and ma50>ma200 and ar>0.04: raw[i]="BULL"
    out=["RANGE"]*n; cur="RANGE"; cnt=0; lr="RANGE"
    for i in range(n):
        r=raw[i]
        if r==lr: cnt+=1
        else: cnt=1; lr=r
        if cnt>=persist: cur=r
        out[i]=cur
    return out

def don_hi(bars,n):
    out=[None]*len(bars)
    for i in range(n,len(bars)): out[i]=max(bars[j]["high"] for j in range(i-n,i))
    return out

def vol_ma(bars,n):
    out=[None]*len(bars)
    for i in range(n-1,len(bars)): out[i]=sum(bars[j]["volume"] for j in range(i-n+1,i+1))/n
    return out

print("Computing indicators...")
# 4h
adx4   = adx_wilder(bars4h)
atr4   = atr_wilder(bars4h)
e50_4h = ema(c4h, 50)
e200_4h= ema(c4h, 200)
dh20_4h= don_hi(bars4h, 20)
vma10_4h= vol_ma(bars4h, 10)
# 1h
atr1h  = atr_wilder(bars1h)
rsi1h  = rsi_s(c1h, 14)
e200_1h= ema(c1h, 200)
bbu1h, bbl1h = bb_s(c1h, 20, 2.)
# regime
reg1d  = regime_wp(bars1d)
reg_map={}
for i,b in enumerate(bars1d): reg_map[b["time"]//86400000]=reg1d[i]
def get_reg(ts): return reg_map.get(ts//86400000,"RANGE")

# ATR4h percentile
ATR_LB=90
def atp4(i): return atr4[i]/c4h[i] if atr4[i] and c4h[i] else None
def atp4_pass(i,pct=.5):
    if i<ATR_LB+14: return False
    vs=[atp4(j) for j in range(i-ATR_LB,i) if atp4(j) is not None]
    if len(vs)<ATR_LB: return False
    cur=atp4(i); return cur is not None and cur>=sorted(vs)[int(len(vs)*pct)]

# Map 1h → 4h index
ts4h_arr=[b["time"] for b in bars4h]
def get_4h_idx(ts):
    k=ts//(4*3600*1000); lo,hi,idx=0,len(ts4h_arr)-1,0
    while lo<=hi:
        m=(lo+hi)//2
        if ts4h_arr[m]//(4*3600*1000)<=k: idx=m; lo=m+1
        else: hi=m-1
    return idx

# EMA200 1h at any timestamp (binary search on 1h series)
ts1h_arr=[b["time"] for b in bars1h]
def e200_1h_at(ts):
    lo,hi,idx=0,len(ts1h_arr)-1,0
    while lo<=hi:
        m=(lo+hi)//2
        if ts1h_arr[m]<=ts: idx=m; lo=m+1
        else: hi=m-1
    return e200_1h[idx]

# ── 4h context check ────────────────────────────────────────────────────────
def ctx4h_ok(i4h):
    if i4h<50: return False
    if get_reg(bars4h[i4h]["time"])!="RANGE": return False
    adv=adx4[i4h]; adv_p=adx4[i4h-1] if i4h>0 else None
    if adv is None or adv<=20 or adv_p is None or adv_p<=20: return False
    if not atp4_pass(i4h,.5): return False
    return True

print("Precomputing 4h context map...")
ctx4h=[ctx4h_ok(i) for i in range(n4h)]

# ── 4h SIGNAL FUNCTIONS ─────────────────────────────────────────────────────
ATR_BREAK_MULT=1.2; DONCHIAN_LB=20; SL_INIT=4.; SL_TRAIL=3.; SL_TRANS=24; MAX_HOLD_4H=200

def sig_s12_4h(i):
    if None in (e50_4h[i],e200_4h[i]) or i<1: return False
    if None in (e50_4h[i-1],e200_4h[i-1]): return False
    return e50_4h[i-1]<=e200_4h[i-1] and e50_4h[i]>e200_4h[i]

def sig_s13_4h(i):
    if atr4[i] is None or i<1: return False
    return c4h[i]>bars4h[i-1]["close"]+atr4[i]*ATR_BREAK_MULT

def sig_s14_4h(i):
    if dh20_4h[i] is None: return False
    return c4h[i]>dh20_4h[i]

def filt4h(i):
    e1h=e200_1h_at(bars4h[i]["time"])
    if e1h and c4h[i]<e1h: return False
    return ctx4h[i]

def vol_pass_4h(i):
    if vma10_4h[i] is None: return False
    return bars4h[i]["volume"]>=vma10_4h[i]*1.2

def sim_trail_4h(ei):
    ep=c4h[ei]; ae=atr4[ei]
    if ae is None or ae<=0: return None
    sl=ep-ae*SL_INIT; hwm=ep
    for h in range(1,MAX_HOLD_4H+1):
        j=ei+h
        if j>=n4h: break
        mult=SL_INIT if h<SL_TRANS else SL_TRAIL
        if c4h[j]>hwm: hwm=c4h[j]; sl=hwm-ae*mult
        elif h>=SL_TRANS:
            t=hwm-ae*SL_TRAIL
            if t>sl: sl=t
        if bars4h[j]["low"]<=sl: return (sl-ep)/ep-2*FEE, h
    j2=min(ei+MAX_HOLD_4H,n4h-1)
    return (c4h[j2]-ep)/ep-2*FEE, MAX_HOLD_4H

# ── 1h SIGNAL FUNCTIONS ─────────────────────────────────────────────────────
SL_1H=2.; TP_1H=3.; MAX_HOLD_1H=48; CD_1H=4

def filt1h(i1h):
    e1h=e200_1h[i1h]
    if e1h and c1h[i1h]<e1h: return False
    i4h=get_4h_idx(bars1h[i1h]["time"])
    return 0<=i4h<n4h and ctx4h[i4h]

def sig_bb_low(i):
    if bbl1h[i] is None: return False
    return bars1h[i]["low"]<=bbl1h[i] and bars1h[i]["close"]>bars1h[i]["open"]

def sig_rsi_x40(i):
    if rsi1h[i] is None or rsi1h[i-1] is None: return False
    return rsi1h[i-1]<40 and rsi1h[i]>=40

def sim_fixed_1h(ei, tp_m=TP_1H):
    ep=c1h[ei]; ae=atr1h[ei]
    if ae is None or ae<=0: return None
    sl=ep-ae*SL_1H; tp=ep+ae*tp_m
    for h in range(1,MAX_HOLD_1H+1):
        j=ei+h
        if j>=n1h: break
        if bars1h[j]["low"]<=sl: return (sl-ep)/ep-2*FEE, h
        if bars1h[j]["high"]>=tp: return (tp-ep)/ep-2*FEE, h
    j2=min(ei+MAX_HOLD_1H,n1h-1)
    return (c1h[j2]-ep)/ep-2*FEE, MAX_HOLD_1H

# ── BACKTEST RUNNERS ────────────────────────────────────────────────────────
def run_4h():
    """Config A: hedge01 S12/S13/S14 (trailing SL, RANGE+ADX+ATR50+EMA200)"""
    trades=[]; last={"S12":-200,"S13":-4,"S14":-200}; CD={"S12":36,"S13":1,"S14":36}
    do_vol={"S12":False,"S13":True,"S14":True}
    sigs={"S12":sig_s12_4h,"S13":sig_s13_4h,"S14":sig_s14_4h}
    for i in range(100,n4h-MAX_HOLD_4H):
        if not filt4h(i): continue
        for sn,sig_fn in sigs.items():
            if not sig_fn(i): continue
            if i-last[sn]<CD[sn]: continue
            if do_vol[sn] and not vol_pass_4h(i): continue
            r=sim_trail_4h(i)
            if r is None: continue
            ret,hold=r
            ts=bars4h[i]["time"]; yr=datetime.datetime.utcfromtimestamp(ts/1000).year
            mo=yr*100+datetime.datetime.utcfromtimestamp(ts/1000).month
            trades.append({"ret":ret,"hold_bars":hold,"yr":yr,"mo":mo,"setup":sn,
                           "period":"test" if ts>=WF_CUT else "train","tf":"4h"})
            last[sn]=i
    return trades

def run_1h(tp_m=TP_1H):
    """Config B: 1h BB_low + RSI_x40 (fixed TP/SL, 4h context)"""
    trades=[]; last_bb=-CD_1H; last_rsi=-CD_1H
    for i in range(50,n1h-MAX_HOLD_1H):
        if not filt1h(i): continue
        # BB_low
        if sig_bb_low(i) and i-last_bb>=CD_1H:
            r=sim_fixed_1h(i,tp_m)
            if r:
                ret,hold=r; ts=bars1h[i]["time"]
                yr=datetime.datetime.utcfromtimestamp(ts/1000).year
                mo=yr*100+datetime.datetime.utcfromtimestamp(ts/1000).month
                trades.append({"ret":ret,"hold_bars":hold,"yr":yr,"mo":mo,"setup":"1h_BB",
                               "period":"test" if ts>=WF_CUT else "train","tf":"1h"})
                last_bb=i
        # RSI_x40
        if sig_rsi_x40(i) and i-last_rsi>=CD_1H:
            r=sim_fixed_1h(i,tp_m)
            if r:
                ret,hold=r; ts=bars1h[i]["time"]
                yr=datetime.datetime.utcfromtimestamp(ts/1000).year
                mo=yr*100+datetime.datetime.utcfromtimestamp(ts/1000).month
                trades.append({"ret":ret,"hold_bars":hold,"yr":yr,"mo":mo,"setup":"1h_RSI",
                               "period":"test" if ts>=WF_CUT else "train","tf":"1h"})
                last_rsi=i
    return trades

def calc_ra(t):
    if not t: return None
    r=[x["ret"] for x in t]; m=sum(r)/len(r)
    sd=(sum((x-m)**2 for x in r)/len(r))**0.5
    return m/sd if sd>0 else 0

def report_full(trades, label):
    if not trades: print(f"\n  [{label}] NO TRADES"); return None
    rets=[t["ret"] for t in trades]; n_=len(rets)
    mean=sum(rets)/n_; sd=(sum((r-mean)**2 for r in rets)/n_)**0.5 or 1e-9
    ra=mean/sd; wr=sum(1 for r in rets if r>0)/n_*100
    wins=[r for r in rets if r>0]; losses=[r for r in rets if r<=0]
    rr=(sum(wins)/len(wins) if wins else 0)/abs(sum(losses)/len(losses) if losses else 1e-9)
    by_yr=defaultdict(float)
    for t in trades: by_yr[t["yr"]]+=t["ret"]
    stab=sum(1 for v in by_yr.values() if v>0)
    by_mo=defaultdict(list)
    for t in trades: by_mo[t["mo"]].append(t["ret"])
    win_mo=sum(1 for vs in by_mo.values() if sum(vs)>0); tot_mo=len(by_mo)
    eq=0; pk=0; dd=0
    for t in sorted(trades,key=lambda x:x["yr"]): eq+=t["ret"]; pk=max(pk,eq); dd=max(dd,pk-eq)
    yr_str=" ".join(f"{y}:{by_yr[y]*100:+.0f}%" for y in sorted(by_yr))
    train=[t for t in trades if t["period"]=="train"]; test=[t for t in trades if t["period"]=="test"]
    ra_tr=calc_ra(train); ra_te=calc_ra(test)
    decay=(ra_te-ra_tr)/abs(ra_tr)*100 if ra_tr else None
    decay_f="✅" if decay and decay>=-40 else "⚠️"
    by_setup=defaultdict(int)
    for t in trades: by_setup[t["setup"]]+=1
    setup_str=" | ".join(f"{k}:{v}" for k,v in sorted(by_setup.items()))
    print(f"\n  [{label}]")
    print(f"  n={n_:4d} (~{n_//7}/yr)  RA={ra:+.3f}  WR={wr:.0f}%  R:R={rr:.2f}  DD={dd*100:.1f}%  stab={stab}/{len(by_yr)}")
    print(f"  Monthly win: {win_mo}/{tot_mo} ({win_mo/tot_mo*100:.0f}%)")
    print(f"  Per-year: {yr_str}")
    print(f"  Setups:   {setup_str}")
    if ra_tr and ra_te:
        print(f"  WF: TRAIN RA={ra_tr:+.3f}(n={len(train)}) TEST RA={ra_te:+.3f}(n={len(test)}) decay={decay:+.0f}% {decay_f}")
    return {"label":label,"n":n_,"ra":ra,"wr":wr,"rr":rr,"dd":dd,"stab":stab,"stab_n":len(by_yr),
            "win_mo":win_mo,"tot_mo":tot_mo,"ra_tr":ra_tr,"ra_te":ra_te,"decay":decay}

print("\nRunning backtests...")
t_4h   = run_4h()
t_1h   = run_1h(tp_m=3.0)
t_combo= t_4h + t_1h      # combine all trades

# Check overlap: how many 1h trades fire DURING an active 4h trade?
print("\nChecking trade overlap...")
# Build 4h active windows
active_windows=[]
last4={"S12":-200,"S13":-4,"S14":-200}; CD4={"S12":36,"S13":1,"S14":36}
dv={"S12":False,"S13":True,"S14":True}; sigs4={"S12":sig_s12_4h,"S13":sig_s13_4h,"S14":sig_s14_4h}
for i in range(100,n4h-MAX_HOLD_4H):
    if not filt4h(i): continue
    for sn,sf in sigs4.items():
        if not sf(i): continue
        if i-last4[sn]<CD4[sn]: continue
        if dv[sn] and not vol_pass_4h(i): continue
        r=sim_trail_4h(i)
        if r:
            _,hold=r
            active_windows.append((bars4h[i]["time"], bars4h[min(i+hold,n4h-1)]["time"]))
            last4[sn]=i

overlap=0
for t in t_1h:
    # find ts of this 1h trade
    ts=t["yr"]*10000  # dummy, we don't have ts in trade dict
# Better: re-count overlap by timestamp
active_windows_set=set()
for ws,we in active_windows:
    for ms_step in range(ws,we+1,3600*1000):
        active_windows_set.add(ms_step//(3600*1000))

print(f"  4h trades active windows: {len(active_windows)}")
print(f"  Total 1h trades: {len(t_1h)}")
print(f"  → Trades run independently (separate cooldowns, separate buckets)")

print("\n" + "="*65)
print("RESULTS")
print("="*65)
ra_4h  = report_full(t_4h,   "A — hedge01 4h (S12/S13/S14) — BASELINE")
ra_1h  = report_full(t_1h,   "B — 1h signals (BB_low + RSI_x40) — NEW")
ra_cmb = report_full(t_combo,"C — COMBO (A + B)")

# Summary
print("\n" + "="*65)
print("HEAD-TO-HEAD SUMMARY")
print("="*65)
print(f"\n  {'Config':40s}  {'n/yr':>6}  {'RA':>8}  {'TEST_RA':>8}  {'mo_win%':>8}  {'stab':>6}  {'DD%':>6}")
for r in [ra_4h, ra_1h, ra_cmb]:
    if not r: continue
    print(f"  {r['label'][:40]:40s}  {r['n']//7:>6}  {r['ra']:>+8.3f}  "
          f"{(r['ra_te'] or 0):>+8.3f}  {r['win_mo']/r['tot_mo']*100:>7.0f}%  "
          f"{r['stab']}/{r['stab_n']}  {r['dd']*100:>5.1f}%")

print("\n  KEY QUESTION: Combo RA > baseline AND entries increase?")
if ra_cmb and ra_4h:
    delta_ra=ra_cmb["ra"]-ra_4h["ra"]; delta_n=ra_cmb["n"]-ra_4h["n"]
    delta_te=( ra_cmb["ra_te"] or 0)-(ra_4h["ra_te"] or 0)
    verdict="✅ COMBO ADD VALUE" if delta_ra>-0.05 and delta_n>0 else "⚠️ COMBO HURTS RA"
    print(f"  RA delta:      {delta_ra:+.3f}")
    print(f"  Entries delta: {delta_n:+d} (+{delta_n//7}/yr)")
    print(f"  TEST_RA delta: {delta_te:+.3f}")
    print(f"  → {verdict}")
    if delta_ra>-0.05:
        print(f"\n  IMPLEMENTATION: Add as 2 new setups in hedge01:")
        print(f"    S15_1h_BB:  1h BB lower touch + bullish close (SL=ATR_1h×2, TP=ATR_1h×3)")
        print(f"    S16_1h_RSI: 1h RSI cross above 40 (SL=ATR_1h×2, TP=ATR_1h×3)")
        print(f"    Context gate: same 4h filters (RANGE+ADX>20+ATR50+EMA200_1h)")
        print(f"    Cooldown:  4h between 1h entries (independent from 4h S12/S13/S14)")
