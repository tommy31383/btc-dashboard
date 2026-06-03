#!/usr/bin/env python3
"""
regime-classifier-upgrade-7y.py — Can a BETTER regime classifier distinguish REAL bear
from bull-market-dip faster than the current MA200 rule, to improve the LONG book's
re-entry timing after false-bear dips?

Motivated by docs/bear-short-retest-2026-06-03.md:
  Over 7y the MA200 "BEAR" label was a REAL sustained bear only in 2022 and 2026.
  2019/2020/2021/2023/2024/2025 = false-bears (bull-market dips that V-recover).
  When a bull-dip is mislabeled BEAR, the LONG book (hedge01 RANGE-only + turtle skip-BEAR)
  SITS OUT and misses the recovery re-entry. We size that missed prize, then test whether a
  structural classifier upgrade captures it WITHOUT degrading real-bear protection (2022/2026).

Engines re-implemented faithfully:
  hedge01 v0.4.79  (= deployed v0.4.77 params: ADX18/12, SL3.0/3.5/64h, ATR_BREAK1.3,
                    VOL MA16x1.4, Donchian18, EMA gates, ATR%ile50, skip h16+Thu/Sun,
                    funding-block 0.05%, RANGE-only LONG)
  turtle           (Daily Donchian entry20/exit10 long-only + ATR-cut 1.5, skip-BEAR)

Classifiers (era-robust, STRUCTURAL only — no specific-date skips):
  A) Current MA200            : BEAR if close<MA200  (baseline)
  B) Faster re-entry          : like A, but EXIT BEAR as soon as close reclaims MA50
  C) Death-cross dual-confirm : BEAR only if close<MA200 AND MA50<MA200
  D) Slope filter (principled): BEAR only if close<MA200 AND MA200 slope<0 (30d)
  E) Drawdown-based           : BEAR if drawdown-from-rolling-high > 20% (sustained)

For hedge01 the regime only GATES (RANGE-only). To let "faster re-entry / fewer false bears"
help, the gate is: allow LONG when regime is RANGE OR (was-BEAR-now-recovering per classifier).
Concretely each classifier yields a 1d label in {BEAR, RANGE, BULL}; hedge01 trades when label
!= BEAR-as-defined-by-that-classifier AND (RANGE or BULL). i.e. the classifier decides which
days are "blocked BEAR". Fewer false-bear days => more RANGE/BULL days => more eligible entries.

For turtle the regime gates entry (skip-BEAR). Same: skip entry only on classifier-BEAR days.

Judge: Sharpe + DOLLARS + per-year era-robustness. Real-bear protection (2022/2026 stay flat/
cash, low DD) must NOT degrade. A classifier that just curve-fits the 4 false-bear windows or
re-enters into 2022/2026 is REJECTED.
"""
import json, datetime, math, sys
from collections import defaultdict

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FUNDING = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-funding-7y.json"
H4 = 4 * 3600 * 1000
DAY = 86400000

# ---- hedge01 v0.4.79 (=v0.4.77 deployed) CONFIG ----
SL_INIT = 3.0; SL_TRAIL = 3.5; SL_TRANS = 16
ADX_P = 14; ADX_THRESH = 18; ADX_PREV_THRESH = 12
VOL_MA = 16; VOL_MULT = 1.4
ATR_PCT_LB = 90; ATR_PCT_PCTL = 0.50
DONCHIAN_LB = 18; ATR_BREAK_MULT = 1.3
EMA_FAST = 50; EMA_SLOW = 200; MAX_HOLD = 200
FUNDING_BLOCK = 0.0005
CD = {"S12": 36, "S13": 1, "S14": 36}
FEE = 0.0005
WALLET = 100000.0

# ---- turtle config ----
T_DON_ENTRY = 20; T_DON_EXIT = 10; T_CUT = 1.5; T_FEE = 0.0005; T_QTY = 0.003

PERSIST = 3
DD_BEAR_THRESH = 0.20      # classifier E
SLOPE_LB = 30              # classifier D: MA200 slope lookback (days)


# ===================== shared infra =====================
def load_tf(raw, ms):
    b = {}
    for c in raw:
        k = c["time"] // ms
        if k not in b:
            b[k] = {"time": k*ms, "high": c["high"], "low": c["low"],
                    "close": c["close"], "volume": c["volume"]}
        else:
            o = b[k]; o["high"]=max(o["high"],c["high"]); o["low"]=min(o["low"],c["low"])
            o["close"]=c["close"]; o["volume"]+=c["volume"]
    return [b[k] for k in sorted(b)]

def ema_s(xs, n):
    k = 2/(n+1); out=[None]*len(xs); e=None
    for i,x in enumerate(xs):
        e = x if e is None else x*k+e*(1-k); out[i]=e
    return out

def _dm_tr(bars):
    n=len(bars); pdm=[0.]*n; ndm=[0.]*n; tr=[0.]*n
    for i in range(1,n):
        up=bars[i]["high"]-bars[i-1]["high"]; dn=bars[i-1]["low"]-bars[i]["low"]
        pdm[i]=up if up>dn and up>0 else 0; ndm[i]=dn if dn>up and dn>0 else 0
        tr[i]=max(bars[i]["high"]-bars[i]["low"], abs(bars[i]["high"]-bars[i-1]["close"]),
                  abs(bars[i]["low"]-bars[i-1]["close"]))
    return pdm,ndm,tr

def adx_wilder(bars, period=ADX_P):
    pdm,ndm,tr=_dm_tr(bars); n=len(bars)
    if n<=period+1: return [None]*n
    smTR=sum(tr[1:period+1]); smPDM=sum(pdm[1:period+1]); smNDM=sum(ndm[1:period+1])
    dx_arr=[]; adx_val=None; out=[None]*n
    for i in range(period+1,n):
        smTR+=-smTR/period+tr[i]; smPDM+=-smPDM/period+pdm[i]; smNDM+=-smNDM/period+ndm[i]
        pdi=smPDM/smTR*100 if smTR>0 else 0; ndi=smNDM/smTR*100 if smTR>0 else 0
        dx=abs(pdi-ndi)/(pdi+ndi)*100 if (pdi+ndi)>0 else 0
        dx_arr.append(dx)
        if len(dx_arr)<period: continue
        elif len(dx_arr)==period: adx_val=sum(dx_arr)/period
        else: adx_val=(adx_val*(period-1)+dx)/period
        out[i]=adx_val
    return out

def atr_series(bars, period=ADX_P):
    _,_,tr=_dm_tr(bars); n=len(bars); atr=[None]*n
    atr[period]=sum(tr[1:period+1])/period
    for i in range(period+1,n):
        atr[i]=(atr[i-1]*(period-1)+tr[i])/period
    return atr

def atr_w_daily(bars, p=14):
    m=len(bars); tr=[0.]*m
    for i in range(1,m):
        tr[i]=max(bars[i]["high"]-bars[i]["low"], abs(bars[i]["high"]-bars[i-1]["close"]),
                  abs(bars[i]["low"]-bars[i-1]["close"]))
    o=[None]*m; o[p]=sum(tr[1:p+1])/p
    for i in range(p+1,m): o[i]=(o[i-1]*(p-1)+tr[i])/p
    return o


# ===================== regime classifiers =====================
def _persist(raw, persist_n=PERSIST):
    n=len(raw); out=["RANGE"]*n; cur="RANGE"; cnt=0; lr="RANGE"
    for i in range(n):
        if raw[i]==lr: cnt+=1
        else: cnt=1; lr=raw[i]
        if cnt>=persist_n: cur=raw[i]
        out[i]=cur
    return out

def classify(bars1d, mode):
    """Return persisted 1d regime labels {BEAR,RANGE,BULL}. BULL def is identical across
    classifiers (only the BEAR definition changes — that's the research variable)."""
    cs=[b["close"] for b in bars1d]; n=len(bars1d); raw=["RANGE"]*n
    # rolling-high for drawdown classifier
    roll_high=[None]*n
    for i in range(n):
        lo=max(0,i-365)
        roll_high[i]=max(cs[lo:i+1])
    for i in range(200,n):
        ma200=sum(cs[i-199:i+1])/200; ma50=sum(cs[i-49:i+1])/50
        r20=bars1d[i-19:i+1]; ar=sum((b["high"]-b["low"])/b["close"] for b in r20)/20
        ma200_prev = sum(cs[i-199-SLOPE_LB:i+1-SLOPE_LB])/200 if i>=199+SLOPE_LB else ma200
        dd = (roll_high[i]-cs[i])/roll_high[i]
        bull = cs[i]>ma50 and ma50>ma200 and ar>0.04
        if mode=="A":
            bear = cs[i]<ma200
        elif mode=="B":
            # same BEAR trigger as A, but recovery exits BEAR fast when close reclaims MA50.
            # implement as: bear only if close<MA200 AND close<MA50 (reclaiming MA50 -> not bear)
            bear = cs[i]<ma200 and cs[i]<ma50
        elif mode=="C":
            bear = cs[i]<ma200 and ma50<ma200
        elif mode=="D":
            bear = cs[i]<ma200 and ma200<ma200_prev   # MA200 slope negative
        elif mode=="E":
            bear = dd>DD_BEAR_THRESH
        else:
            raise ValueError(mode)
        if bear: raw[i]="BEAR"
        elif bull: raw[i]="BULL"
    return _persist(raw)


# ===================== load =====================
print("Loading data...")
RAW=json.load(open(CACHE)); RAW.sort(key=lambda x:x["time"])
bars4h=load_tf(RAW,H4); bars1h=load_tf(RAW,3600*1000); bars1d=load_tf(RAW,DAY)
n=len(bars4h); c4=[b["close"] for b in bars4h]
fund_raw=sorted(json.load(open(FUNDING)),key=lambda x:x["time"])
ft=[f["time"] for f in fund_raw]; frate=[f["rate"] for f in fund_raw]
def funding_at(ts):
    lo,hi,idx=0,len(ft)-1,0
    while lo<=hi:
        m=(lo+hi)//2
        if ft[m]<=ts: idx=m; lo=m+1
        else: hi=m-1
    return frate[idx] if ft else 0.0

e50=ema_s(c4,EMA_FAST); e200=ema_s(c4,EMA_SLOW)
atr4=atr_series(bars4h); adx4=adx_wilder(bars4h)
e200_1h=ema_s([b["close"] for b in bars1h],200); h1t=[b["time"] for b in bars1h]

# daily arrays for turtle
BD=bars1d; nd=len(BD); CD_=[x["close"] for x in BD]
atr_d=atr_w_daily(BD)
dhi_e=[None]*nd; dlo_x=[None]*nd
for i in range(T_DON_ENTRY,nd): dhi_e[i]=max(BD[j]["high"] for j in range(i-T_DON_ENTRY,i))
for i in range(T_DON_EXIT,nd):  dlo_x[i]=min(BD[j]["low"]  for j in range(i-T_DON_EXIT,i))

print(f"4h bars: {n}  {datetime.datetime.utcfromtimestamp(bars4h[0]['time']/1000):%Y-%m-%d} -> "
      f"{datetime.datetime.utcfromtimestamp(bars4h[-1]['time']/1000):%Y-%m-%d}")

# precompute all classifier label maps (day-key -> label)
CLASSIFIERS=["A","B","C","D","E"]
LABELS={m: classify(bars1d,m) for m in CLASSIFIERS}
REGMAP={m: {BD[i]["time"]//DAY: LABELS[m][i] for i in range(nd)} for m in CLASSIFIERS}
def get_reg(m,ts): return REGMAP[m].get(ts//DAY,"RANGE")


# ===================== hedge01 engine =====================
def atp(i):
    if atr4[i] is None: return None
    return atr4[i]/c4[i]
def atp_pass(i):
    if i<ATR_PCT_LB+14: return False
    vs=[atp(j) for j in range(i-ATR_PCT_LB,i) if atp(j) is not None]
    if len(vs)<ATR_PCT_LB: return False
    cur=atp(i)
    if cur is None: return False
    return cur>=sorted(vs)[int(len(vs)*ATR_PCT_PCTL)]
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
def utc_hour(ts): return datetime.datetime.utcfromtimestamp(ts/1000).hour
def utc_dow(ts): return datetime.datetime.utcfromtimestamp(ts/1000).weekday()

def filt(i, mode):
    adv=adx4[i]
    if adv is None or adv<=ADX_THRESH: return False
    adv_prev=adx4[i-1] if i>=1 else None
    if adv_prev is None or adv_prev<=ADX_PREV_THRESH: return False
    e1h=e200_1h_at(bars4h[i]["time"])
    if e1h is None or c4[i]<e1h: return False
    if not atp_pass(i): return False
    h=utc_hour(bars4h[i]["time"])
    if h==16: return False
    dw=utc_dow(bars4h[i]["time"])
    if dw==3 or dw==6: return False
    # REGIME GATE: trade only when NOT classifier-BEAR (RANGE or BULL).
    if get_reg(mode,bars4h[i]["time"])=="BEAR": return False
    if funding_at(bars4h[i]["time"])>FUNDING_BLOCK: return False
    return True

def sig_s12(i):
    if None in (e50[i],e200[i]) or i<1: return None
    if None in (e50[i-1],e200[i-1]): return None
    return "LONG" if (e50[i-1]<=e200[i-1] and e50[i]>e200[i]) else None
def sig_s13(i):
    if atr4[i] is None or i<1: return None
    return "LONG" if c4[i]>bars4h[i-1]["close"]+atr4[i]*ATR_BREAK_MULT else None
def sig_s14(i):
    if i<DONCHIAN_LB: return None
    hi=max(bars4h[j]["high"] for j in range(i-DONCHIAN_LB,i))
    return "LONG" if c4[i]>hi else None
sigs={"S12":sig_s12,"S13":sig_s13,"S14":sig_s14}
do_vol={"S12":False,"S13":True,"S14":True}

def h1_sim(ei):
    ep=c4[ei]; ae=atr4[ei]
    if ae is None or ae<=0: return None
    sl=ep-ae*SL_INIT; hwm=ep
    for h in range(1,MAX_HOLD+1):
        j=ei+h
        if j>=n: break
        mult=SL_INIT if h<SL_TRANS else SL_TRAIL
        if c4[j]>hwm: hwm=c4[j]; sl=hwm-ae*mult
        elif h>=SL_TRANS:
            t=hwm-ae*SL_TRAIL
            if t>sl: sl=t
        if bars4h[j]["low"]<=sl:
            return (sl-ep)/ep-2*FEE, h, j
    j=min(ei+MAX_HOLD,n-1)
    return (c4[j]-ep)/ep-2*FEE, MAX_HOLD, j

def run_hedge01(mode):
    trades=[]; last={s:0 for s in CD}
    for i in range(250,n-MAX_HOLD):
        for sn in ["S12","S13","S14"]:
            if sigs[sn](i)!="LONG": continue
            if i-last[sn]<CD[sn]: continue
            if do_vol[sn] and not vol_pass(i): continue
            if not filt(i,mode): continue
            r=h1_sim(i)
            if r is None: continue
            ret,h,xj=r
            trades.append({"ret":ret,"h":h,"t_in":bars4h[i]["time"],
                           "yr":datetime.datetime.utcfromtimestamp(bars4h[i]["time"]/1000).year,
                           "setup":sn})
            last[sn]=i
    return trades

def h1_stats(trades):
    rets=[t["ret"] for t in trades]; nn=len(rets)
    if nn==0: return None
    mean=sum(rets)/nn; sd=(sum((r-mean)**2 for r in rets)/nn)**0.5 or 1e-9
    ra=mean/sd
    yrs=(trades[-1]["t_in"]-trades[0]["t_in"])/(365.25*DAY) or 1
    tpy=nn/yrs; sharpe=ra*math.sqrt(tpy)
    wr=sum(1 for r in rets if r>0)/nn*100; roi=sum(rets)*100; dollars=sum(rets)*WALLET
    eq=0;peak=0;mdd=0
    for r in rets:
        eq+=r;peak=max(peak,eq);mdd=max(mdd,peak-eq)
    by_yr=defaultdict(float)
    for t in trades: by_yr[t["yr"]]+=t["ret"]
    pos=sum(1 for v in by_yr.values() if v>0)
    return dict(n=nn,ra=ra,sharpe=sharpe,wr=wr,roi=roi,dollars=dollars,mdd=mdd*100,
                tpy=tpy,by_yr=dict(by_yr),stab=pos,ny=len(by_yr))


# ===================== turtle engine =====================
def run_turtle(mode):
    """Daily long-only Donchian 20/10 + ATR-cut 1.5, skip classifier-BEAR on entry.
    Returns daily pnl array (M2M) plus per-year + B&H ref."""
    WARM=max(T_DON_ENTRY,200)
    pnl=[0.0]*nd; pnl_b=[0.0]*nd
    holding=False; entry_px=0.0; entry_atr=0.0
    daykey=lambda i: BD[i]["time"]//DAY
    for i in range(WARM,nd):
        pnl_b[i]=T_QTY*(CD_[i]-CD_[i-1])
        if holding:
            pnl[i]=T_QTY*(CD_[i]-CD_[i-1])
            exit_now=False
            if T_CUT>0 and BD[i]["low"]<=entry_px-entry_atr*T_CUT: exit_now=True
            elif dlo_x[i] is not None and CD_[i]<dlo_x[i]: exit_now=True
            if exit_now:
                pnl[i]-=T_FEE*CD_[i]*T_QTY; holding=False
        if not holding:
            prev_bear = (i>=1 and LABELS[mode][i-1]=="BEAR")
            if dhi_e[i] is not None and CD_[i]>dhi_e[i] and not prev_bear:
                holding=True; entry_px=CD_[i]; entry_atr=atr_d[i] or 0
                pnl[i]-=T_FEE*CD_[i]*T_QTY
    return pnl,pnl_b,WARM

def turtle_stats(pnl,WARM):
    series=pnl[WARM:nd]
    eq=[];s=0.0
    for x in series: s+=x; eq.append(s)
    total=s
    mean=sum(series)/len(series); sd=(sum((x-mean)**2 for x in series)/len(series))**0.5 or 1e-9
    sharpe=mean/sd*math.sqrt(365)
    peak=-1e18;mdd=0.0
    for v in eq:
        peak=max(peak,v); mdd=max(mdd,peak-v)
    by_yr=defaultdict(float)
    for i in range(WARM,nd):
        y=datetime.datetime.utcfromtimestamp(BD[i]["time"]/1000).year
        by_yr[y]+=pnl[i]
    pos=sum(1 for v in by_yr.values() if v>0)
    return dict(total=total,sharpe=sharpe,mdd=mdd,by_yr=dict(by_yr),stab=pos,ny=len(by_yr))


# ===================== TASK 1: false-bear windows + cost =====================
print("\n"+"="*78)
print("TASK 1 — BEAR windows (classifier A / current MA200) + false-vs-real + missed prize")
print("="*78)

# identify contiguous A-BEAR windows on daily labels
labA=LABELS["A"]
windows=[]; i=0
while i<nd:
    if labA[i]=="BEAR":
        j=i
        while j<nd and labA[j]=="BEAR": j+=1
        windows.append((i,j-1)); i=j
    else: i+=1

def realbear_check(s,e):
    """real if price continues down >=20% within 60d of window start, else false (recover)."""
    p0=CD_[s]; lo=p0
    end=min(s+60,nd-1)
    for k in range(s,end+1): lo=min(lo,CD_[k])
    drop=(p0-lo)/p0
    # also overall move across the whole window
    move=(CD_[e]-CD_[s])/CD_[s]
    real = drop>=0.20
    return real, drop, move

print(f"\n  {'window':27} | {'days':>4} | {'maxDrop60d':>10} | {'winMove':>8} | verdict")
real_days=0; false_days=0; real_wins=[]; false_wins=[]
for (s,e) in windows:
    days=e-s+1
    if days<3: continue
    real,drop,move=realbear_check(s,e)
    d0=datetime.datetime.utcfromtimestamp(BD[s]["time"]/1000).strftime("%Y-%m-%d")
    d1=datetime.datetime.utcfromtimestamp(BD[e]["time"]/1000).strftime("%Y-%m-%d")
    v="REAL bear" if real else "FALSE (dip+recover)"
    print(f"  {d0}->{d1} | {days:>4} | {drop*100:>9.0f}% | {move*100:>+7.0f}% | {v}")
    if real: real_days+=days; real_wins.append((s,e))
    else: false_days+=days; false_wins.append((s,e))
print(f"\n  REAL-bear days: {real_days}   FALSE-bear days: {false_days}")
print(f"  => {false_days} long-book entry-days were blocked by FALSE-bear mislabeling (classifier A).")

# Forgone return: run hedge01 + turtle with classifier A and a hypothetical "perfect" classifier
# that only labels REAL-bear windows BEAR (everything else RANGE/BULL). The delta over the
# FALSE-bear windows = the prize available. (Perfect = oracle upper bound, not deployable.)
def oracle_label():
    raw=["RANGE"]*nd
    cs=CD_
    for i in range(200,nd):
        ma200=sum(cs[i-199:i+1])/200; ma50=sum(cs[i-49:i+1])/50
        r20=BD[i-19:i+1]; ar=sum((b["high"]-b["low"])/b["close"] for b in r20)/20
        if cs[i]>ma50 and ma50>ma200 and ar>0.04: raw[i]="BULL"
    for (s,e) in real_wins:
        for k in range(s,e+1): raw[k]="BEAR"
    return _persist(raw)

LABELS["ORACLE"]=oracle_label()
REGMAP["ORACLE"]={BD[i]["time"]//DAY:LABELS["ORACLE"][i] for i in range(nd)}

print("\n  -- Prize sizing: hedge01+turtle under A (baseline) vs ORACLE (only real-bears blocked) --")
hA=h1_stats(run_hedge01("A")); hO=h1_stats(run_hedge01("ORACLE"))
ptA,pbA,W=run_turtle("A"); tA=turtle_stats(ptA,W)
ptO,_,_=run_turtle("ORACLE"); tO=turtle_stats(ptO,W)
print(f"  hedge01  A: n={hA['n']}  Sharpe={hA['sharpe']:.2f}  ${hA['dollars']:+,.0f}  | "
      f"ORACLE: n={hO['n']}  Sharpe={hO['sharpe']:.2f}  ${hO['dollars']:+,.0f}  "
      f"=> prize ${hO['dollars']-hA['dollars']:+,.0f} / {hO['n']-hA['n']:+d} entries")
print(f"  turtle   A: ${tA['total']:+,.0f}  Sharpe={tA['sharpe']:.2f}  | "
      f"ORACLE: ${tO['total']:+,.0f}  Sharpe={tO['sharpe']:.2f}  "
      f"=> prize ${tO['total']-tA['total']:+,.0f}")
print("  (ORACLE = un-achievable upper bound; real classifiers below must approach it WITHOUT"
      "\n   re-entering 2022/2026 real bears.)")


# ===================== TASK 2: classifier separation quality =====================
print("\n"+"="*78)
print("TASK 2 — Classifier separation: false-bear days reduced? real-bear still caught?")
print("="*78)
# 'real-bear day' = day inside a real_win window; 'false-bear day' = inside a false_win window.
real_dayset=set()
for (s,e) in real_wins:
    for k in range(s,e+1): real_dayset.add(k)
false_dayset=set()
for (s,e) in false_wins:
    for k in range(s,e+1): false_dayset.add(k)

print(f"\n  Reference (classifier A windows): real-bear days={len(real_dayset)}  "
      f"false-bear days={len(false_dayset)}")
print(f"\n  {'cls':>3} | {'totalBEARd':>10} | {'realBEARcaught':>14} | {'falseBEARkept':>13} | "
      f"{'falseDaysCut':>12}")
for m in CLASSIFIERS:
    lab=LABELS[m]
    total_bear=sum(1 for i in range(nd) if lab[i]=="BEAR")
    real_caught=sum(1 for k in real_dayset if lab[k]=="BEAR")
    false_kept=sum(1 for k in false_dayset if lab[k]=="BEAR")
    false_cut=len(false_dayset)-false_kept
    print(f"  {m:>3} | {total_bear:>10} | {real_caught:>6}/{len(real_dayset):<7} | "
          f"{false_kept:>5}/{len(false_dayset):<7} | {false_cut:>12}")
print("\n  Interpretation: want HIGH realBEARcaught (protect 2022/2026) + HIGH falseDaysCut"
      "\n  (stop sitting out bull dips). A classifier that cuts false days by dropping real-bear"
      "\n  protection is DANGEROUS, not better.")


# ===================== TASK 3: apply each classifier to the book =====================
print("\n"+"="*78)
print("TASK 3 — LONG book under each classifier (hedge01 v0.4.79 + turtle)")
print("="*78)

years=sorted({datetime.datetime.utcfromtimestamp(BD[i]['time']/1000).year for i in range(W,nd)})
results={}
for m in CLASSIFIERS:
    h=h1_stats(run_hedge01(m))
    pt,_,_=run_turtle(m); t=turtle_stats(pt,W)
    results[m]=(h,t)

print(f"\n--- hedge01 v0.4.79 ---")
print(f"  {'cls':>3} | {'n':>4} | {'Sharpe':>7} | {'RA':>7} | {'WR':>4} | {'ROI%':>7} | "
      f"{'$(100k)':>10} | {'MaxDD%':>7} | {'stab':>5}")
for m in CLASSIFIERS:
    h=results[m][0]
    print(f"  {m:>3} | {h['n']:>4} | {h['sharpe']:>7.2f} | {h['ra']:>+7.3f} | {h['wr']:>3.0f}% | "
          f"{h['roi']:>+7.0f} | {h['dollars']:>+10,.0f} | {h['mdd']:>6.0f}% | {h['stab']}/{h['ny']}")
print("\n  hedge01 per-year ROI%:")
for m in CLASSIFIERS:
    h=results[m][0]
    s=" ".join(f"{y}:{h['by_yr'].get(y,0)*100:+.0f}" for y in sorted(h['by_yr']))
    print(f"    {m}: {s}")

print(f"\n--- turtle (Daily Don20/10 + cut1.5, skip-BEAR) ---")
print(f"  {'cls':>3} | {'Total$':>9} | {'Sharpe':>7} | {'MaxDD$':>8} | {'stab':>5}")
for m in CLASSIFIERS:
    t=results[m][1]
    print(f"  {m:>3} | {t['total']:>+9.0f} | {t['sharpe']:>7.2f} | {t['mdd']:>8.0f} | {t['stab']}/{t['ny']}")
print("\n  turtle per-year $:")
for m in CLASSIFIERS:
    t=results[m][1]
    s=" ".join(f"{y}:{t['by_yr'].get(y,0):+.0f}" for y in sorted(t['by_yr']))
    print(f"    {m}: {s}")

# ===================== TASK 4: book-combined + verdict helpers =====================
print("\n"+"="*78)
print("TASK 4 — Combined book delta vs baseline A (era-robustness check)")
print("="*78)
hA,tA=results["A"]
print(f"\n  baseline A: hedge01 ${hA['dollars']:+,.0f} (Sh {hA['sharpe']:.2f}) + "
      f"turtle ${tA['total']:+,.0f} (Sh {tA['sharpe']:.2f})")
print(f"\n  {'cls':>3} | {'h01 dSharpe':>11} | {'h01 d$':>10} | {'turtle d$':>10} | "
      f"{'2022 h01':>9} | {'2026 h01':>9} | {'2022 turt':>10} | {'2026 turt':>10}")
for m in CLASSIFIERS:
    if m=="A": continue
    h,t=results[m]
    print(f"  {m:>3} | {h['sharpe']-hA['sharpe']:>+11.2f} | {h['dollars']-hA['dollars']:>+10,.0f} | "
          f"{t['total']-tA['total']:>+10,.0f} | "
          f"{h['by_yr'].get(2022,0)*100:>+8.0f}% | {h['by_yr'].get(2026,0)*100:>+8.0f}% | "
          f"{t['by_yr'].get(2022,0):>+10.0f} | {t['by_yr'].get(2026,0):>+10.0f}")
print("\n  REAL-BEAR PROTECTION GUARD: 2022 & 2026 hedge01/turtle must stay ~flat (near baseline A).")
print("  If a classifier pumps 2022/2026 entries (re-enters real bear) => REJECT (protection lost).")
print("  Improvement must come from false-bear YEARS (2019/2023/2024/2025), spread across years,")
print("  not a single curve-fit window.")
