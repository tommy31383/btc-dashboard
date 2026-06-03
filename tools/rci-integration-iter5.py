#!/usr/bin/env python3
"""
rci-integration-iter5.py — RCI INTEGRATION iteration 5.

NEW DIRECTION (meta-lesson iter1-4): stop bolting RCI onto hedge01 (trend rule).
Build a STANDALONE mean-reversion LONG sleeve ("RCI-reversal"):
  Entry = oversold composite (RSI<30 4h + Stoch<20 + BB%B<0.05 [+ funding<0])
          AND confirmation that bounce STARTED (close>prior close).  <- key vs iter1
  Exit  = test {fixed TP 3/5/8%, RCI-top, ATR-stop}.
  Regime variants: RANGE-only vs ALL-regime.

Tasks:
  1. Backtest 7y BTC, sweep entry strictness × exit × regime. n/Sharpe/ROI/DD/WR/per-yr.
  2. Profitable standalone? >=5/8 yrs positive else REJECT.
  3. If profitable: monthly-return corr vs hedge01 & turtle; 3-way risk-parity book.

Judge DOLLARS + Sharpe. BTC only. No SL removal. Structural, no data-mine.
Funding 7y starts 2019-09 → entries before that simply have funding=None (ignored term).
"""
import json, datetime, math
from collections import defaultdict

CACHE   = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FUNDING = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-funding-7y.json"
FEE = 0.05/100
H4  = 4*3600*1000
CAP = 100000

# ── indicator helpers (from iter2) ──
def load_tf(raw, ms):
    b={}
    for c in raw:
        k=c["time"]//ms
        if k not in b: b[k]={"time":k*ms,"open":c["open"],"high":c["high"],"low":c["low"],"close":c["close"],"volume":c["volume"]}
        else:
            o=b[k]; o["high"]=max(o["high"],c["high"]); o["low"]=min(o["low"],c["low"]); o["close"]=c["close"]; o["volume"]+=c["volume"]
    return [b[k] for k in sorted(b)]
def ema_s(xs,n):
    k=2/(n+1); out=[None]*len(xs); e=None
    for i,x in enumerate(xs):
        if x is None: out[i]=e; continue
        e=x if e is None else x*k+e*(1-k); out[i]=e
    return out
def _dm_tr(bars):
    n=len(bars); tr=[0.0]*n
    for i in range(1,n):
        tr[i]=max(bars[i]["high"]-bars[i]["low"],abs(bars[i]["high"]-bars[i-1]["close"]),abs(bars[i]["low"]-bars[i-1]["close"]))
    return tr
def atr_series(bars,period=14):
    tr=_dm_tr(bars); n=len(bars); atr=[None]*n
    if n<=period: return atr
    atr[period]=sum(tr[1:period+1])/period
    for i in range(period+1,n): atr[i]=(atr[i-1]*(period-1)+tr[i])/period
    return atr
def rsi_series(closes,p=14):
    n=len(closes); out=[None]*n
    if n<=p: return out
    g=l=0
    for i in range(1,p+1):
        d=closes[i]-closes[i-1]; g+=max(d,0); l+=max(-d,0)
    ag=g/p; al=l/p
    out[p]=100-100/(1+ag/al) if al>0 else 100
    for i in range(p+1,n):
        d=closes[i]-closes[i-1]; ag=(ag*(p-1)+max(d,0))/p; al=(al*(p-1)+max(-d,0))/p
        out[i]=100-100/(1+ag/al) if al>0 else 100
    return out
def stoch_k(bars,p=14):
    n=len(bars); out=[None]*n
    for i in range(p-1,n):
        lo=min(b["low"] for b in bars[i-p+1:i+1]); hi=max(b["high"] for b in bars[i-p+1:i+1])
        rng=hi-lo; out[i]=100*(bars[i]["close"]-lo)/rng if rng>0 else 50
    return out
def bb_pctb(closes,p=20,mult=2.0):
    n=len(closes); out=[None]*n
    for i in range(p-1,n):
        w=closes[i-p+1:i+1]; m=sum(w)/p; sd=(sum((x-m)**2 for x in w)/p)**0.5
        up=m+mult*sd; dn=m-mult*sd; rng=up-dn
        out[i]=(closes[i]-dn)/rng if rng>0 else 0.5
    return out
def regime_persist(bars1d,persist_n=3):
    cs=[b["close"] for b in bars1d]; n=len(bars1d); raw=["RANGE"]*n
    for i in range(200,n):
        ma200=sum(cs[i-199:i+1])/200; ma50=sum(cs[i-50:i+1])/50
        r20=bars1d[i-19:i+1]; ar=sum((b["high"]-b["low"])/b["close"] for b in r20)/20
        if cs[i]<ma200: raw[i]="BEAR"
        elif cs[i]>ma50 and ma50>ma200 and ar>0.04: raw[i]="BULL"
    out=["RANGE"]*n; cur="RANGE"; cnt=0; lastr="RANGE"
    for i in range(n):
        r=raw[i]
        if r==lastr: cnt+=1
        else: cnt=1; lastr=r
        if cnt>=persist_n: cur=r
        out[i]=cur
    return out
def mo_of(ts): return datetime.datetime.utcfromtimestamp(ts/1000).strftime("%Y-%m")

print("Loading...")
raw=json.load(open(CACHE)); raw.sort(key=lambda x:x["time"])
fund=json.load(open(FUNDING)); fund.sort(key=lambda x:x["time"])
fund=[f for f in fund if f.get("rate") is not None]
ftimes=[f["time"] for f in fund]; frates=[f["rate"] for f in fund]
def funding_at(ts):
    lo,hi,idx=0,len(ftimes)-1,-1
    while lo<=hi:
        m=(lo+hi)//2
        if ftimes[m]<=ts: idx=m; lo=m+1
        else: hi=m-1
    return frates[idx] if idx>=0 else None

bars4h=load_tf(raw,H4); bars1d=load_tf(raw,86400*1000)
n=len(bars4h); c4=[b["close"] for b in bars4h]
atr4=atr_series(bars4h,14)
rsi4=rsi_series(c4,14); stk4=stoch_k(bars4h,14); bb4=bb_pctb(c4,20)
e9=ema_s(c4,9)
regime_1d=regime_persist(bars1d); reg_map={}
for i,b in enumerate(bars1d): reg_map[b["time"]//86400000]=regime_1d[i]
def get_reg(ts): return reg_map.get(ts//86400000,"RANGE")

# RCI-top proxy for exit (oversold mirror): overbought composite
def is_rci_top(i):
    if None in (rsi4[i],stk4[i],bb4[i]): return False
    return rsi4[i]>70 and stk4[i]>80 and bb4[i]>0.95

MAX_HOLD=200  # 4h bars ~33 days
COOLDOWN=12   # bars between entries (avoid stacking same dip)

def oversold(i, use_funding):
    if None in (rsi4[i],stk4[i],bb4[i]): return False
    if not (rsi4[i]<30 and stk4[i]<20 and bb4[i]<0.05): return False
    if use_funding:
        fr=funding_at(bars4h[i]["time"])
        if fr is not None and fr>=0: return False  # require funding<0 (longs flushed)
    return True

def confirm(i, mode):
    # bounce started
    if mode=="none": return True
    if mode=="close":  # current close > prior close
        return c4[i]>c4[i-1]
    if mode=="ema9":   # reclaim ema9
        return e9[i] is not None and c4[i]>e9[i]
    return True

def sim(ei, exit_mode):
    ep=c4[ei]; ae=atr4[ei]
    if ae is None or ae<=0: return None
    tp_pct=None; atr_stop=None
    if exit_mode.startswith("tp"):
        tp_pct=float(exit_mode[2:])/100.0
        atr_stop=ep-ae*2.2   # always carry a protective stop
    elif exit_mode=="rcitop":
        atr_stop=ep-ae*2.2
    elif exit_mode=="atr":
        atr_stop=ep-ae*2.2
    for h in range(1,MAX_HOLD+1):
        j=ei+h
        if j>=n: break
        # stop first (conservative)
        if atr_stop is not None and bars4h[j]["low"]<=atr_stop:
            return (atr_stop-ep)/ep-2*FEE,h,"SL"
        if tp_pct is not None and bars4h[j]["high"]>=ep*(1+tp_pct):
            return tp_pct-2*FEE,h,"TP"
        if exit_mode=="rcitop" and is_rci_top(j):
            return (c4[j]-ep)/ep-2*FEE,h,"RCITOP"
        if exit_mode=="atr":
            # trail: raise stop to close-2.2ATR if higher (use entry ATR)
            t=c4[j]-ae*2.2
            if t>atr_stop: atr_stop=t
    j=min(ei+MAX_HOLD,n-1)
    return (c4[j]-ep)/ep-2*FEE,MAX_HOLD,"MAXHOLD"

def run(use_funding, confirm_mode, exit_mode, regimes):
    trades=[]; last=-10**9
    for i in range(250,n-1):
        ts=bars4h[i]["time"]
        if get_reg(ts) not in regimes: continue
        if not oversold(i,use_funding): continue
        if not confirm(i,confirm_mode): continue
        if i-last<COOLDOWN: continue
        r=sim(i,exit_mode)
        if r is None: continue
        ret,h,reason=r
        yr=datetime.datetime.utcfromtimestamp(ts/1000).year
        trades.append({"ret":ret,"h":h,"yr":yr,"exit":reason,"bar":i,
                       "close_mo":mo_of(bars4h[min(i+h,n-1)]["time"])})
        last=i
    return trades

def stats(trades,label,silent=False):
    if not trades:
        if not silent: print(f"  [{label}] NO TRADES")
        return None
    rets=[t["ret"] for t in trades]; nt=len(rets); mean=sum(rets)/nt
    sd=(sum((r-mean)**2 for r in rets)/nt)**0.5 or 1e-9; ra=mean/sd
    yrs=len(set(t["yr"] for t in trades)); sharpe=ra*math.sqrt(nt/max(yrs,1))
    wr=sum(1 for r in rets if r>0)/nt*100
    roi=sum(rets)*100; dollars=CAP*sum(rets)
    eq=0;peak=0;mdd=0
    for t in sorted(trades,key=lambda x:x["bar"]):
        eq+=t["ret"]; peak=max(peak,eq); mdd=max(mdd,peak-eq)
    by_yr=defaultdict(float)
    for t in trades: by_yr[t["yr"]]+=t["ret"]
    pos=sum(1 for v in by_yr.values() if v>0)
    yr_str=" ".join(f"{y}:{by_yr[y]*100:+.0f}" for y in sorted(by_yr))
    if not silent:
        print(f"  [{label}] n={nt} RA={ra:+.3f} Sh={sharpe:+.2f} WR={wr:.0f}% ROI={roi:+.0f}% ${dollars:+,.0f} DD={mdd*100:.0f}% stab={pos}/{len(by_yr)}")
        print(f"       yr: {yr_str}")
    return {"n":nt,"ra":ra,"sharpe":sharpe,"wr":wr,"roi":roi,"dollars":dollars,
            "mdd":mdd*100,"stab":pos,"nyr":len(by_yr),"trades":trades}

print("\n"+"="*80)
print("TASK 1 — RCI-REVERSAL sleeve sweep (7y BTC)")
print("="*80)
print("Entry strictness: oversold = RSI<30 & Stoch<20 & BB%B<0.05  [+funding<0 variant]")
print(f"  raw oversold bars (no confirm/regime): {sum(1 for i in range(250,n) if oversold(i,False))}")
print(f"  oversold+funding<0 bars:               {sum(1 for i in range(250,n) if oversold(i,True))}")

results={}
for regimes,rlabel in [({"RANGE"},"RANGE"),({"RANGE","BEAR"},"RANGE+BEAR"),({"RANGE","BEAR","BULL"},"ALL")]:
    for use_f in [False,True]:
        for cmode in ["none","close","ema9"]:
            for emode in ["tp3","tp5","tp8","rcitop","atr"]:
                key=f"{rlabel}|f{int(use_f)}|{cmode}|{emode}"
                t=run(use_f,cmode,emode,regimes)
                r=stats(t,key,silent=True)
                results[key]=r

# print top configs by dollars among those with n>=15
print("\nTop 15 configs by $ (n>=15):")
ranked=sorted([ (k,v) for k,v in results.items() if v and v["n"]>=15], key=lambda kv:-kv[1]["dollars"])
print(f"  {'config':<32}{'n':>4}{'Sh':>7}{'WR':>5}{'ROI%':>7}{'$':>11}{'DD%':>6}{'stab':>6}")
for k,v in ranked[:15]:
    print(f"  {k:<32}{v['n']:>4}{v['sharpe']:>+7.2f}{v['wr']:>5.0f}{v['roi']:>+7.0f}{v['dollars']:>+11,.0f}{v['mdd']:>6.0f}{v['stab']}/{v['nyr']}")

# best profitable config with stab>=5
print("\nBest config meeting gate (>=5/yrs positive, n>=15, positive $):")
gated=[ (k,v) for k,v in ranked if v["stab"]>=5 and v["dollars"]>0 ]
gated.sort(key=lambda kv:-kv[1]["sharpe"])
best=None
if gated:
    best=gated[0]
    k,v=best
    print(f"  WINNER: {k}")
    stats(v["trades"],k)
else:
    print("  NONE — no config has >=5/8 positive years with positive dollars.")

print("\n"+"="*80)
print("TASK 2 — Profitable standalone?")
print("="*80)
if best is None:
    print("  VERDICT: REJECT. Mean-reversion sleeve fails >=5/8 positive-year gate.")
    print("  (Best-$ config shown above for the record.)")
    if ranked:
        k,v=ranked[0]
        print(f"  Best-$ config {k}: ${v['dollars']:+,.0f} stab {v['stab']}/{v['nyr']} Sh {v['sharpe']:+.2f}")
else:
    print(f"  VERDICT: PROFITABLE candidate = {best[0]}")
    # Task 3 only if profitable
    print("\n"+"="*80)
    print("TASK 3 — Correlation vs hedge01 & turtle + 3-way book")
    print("="*80)
    # build sleeve monthly
    sleeve_mo=defaultdict(float)
    for t in best[1]["trades"]: sleeve_mo[t["close_mo"]]+=t["ret"]
    print("RCI_MONTHLY "+json.dumps(dict(sleeve_mo)))
