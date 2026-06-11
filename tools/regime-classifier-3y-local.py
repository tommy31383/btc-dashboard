#!/usr/bin/env python3
"""
regime-classifier-3y-local.py — LOCAL 3y adaptation of regime-classifier-upgrade-7y.py.

Same engines + classifiers, but:
  - CACHE = local binance-5m-3y.json (Windows path)
  - FUNDING optional (no local funding cache → funding gate disabled, funding_at=0)

LIMITATION: 3y window (2023-04 .. 2026-06) covers the 2026 real-bear + 2023/24/25
false-bears, but NOT the 2022 real-bear. Real-bear protection guard is therefore
PARTIAL (2026 only). Treat as directional signal, confirm on 7y before deploy.

Classifiers (BEAR definition is the research variable; BULL identical across all):
  A) close<MA200                       (current regime.ts baseline)
  B) close<MA200 AND close<MA50        (reclaim-MA50 exits bear fast)
  C) close<MA200 AND MA50<MA200        (death-cross dual-confirm)   <- ~ #6 redesign
  D) close<MA200 AND MA200 slope<0     (slope filter, 30d)          <- ~ #6 redesign
  E) drawdown-from-rolling-high > 20%  (sustained)
"""
import json, datetime, math, sys
from collections import defaultdict

CACHE = r"E:\AI\BTC\btc-dashboard\.cache\binance-5m-3y.json"
FUNDING = r"E:\AI\BTC\btc-dashboard\.cache\binance-funding-7y.json"  # optional
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
    cs=[b["close"] for b in bars1d]; n=len(bars1d); raw=["RANGE"]*n
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
            bear = cs[i]<ma200 and cs[i]<ma50
        elif mode=="C":
            bear = cs[i]<ma200 and ma50<ma200
        elif mode=="D":
            bear = cs[i]<ma200 and ma200<ma200_prev
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
try:
    fund_raw=sorted(json.load(open(FUNDING)),key=lambda x:x["time"])
    print(f"  funding loaded: {len(fund_raw)} pts")
except Exception as e:
    fund_raw=[]; print(f"  funding cache MISSING ({e}) -> funding gate DISABLED (funding_at=0)")
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

BD=bars1d; nd=len(BD); CD_=[x["close"] for x in BD]
atr_d=atr_w_daily(BD)
dhi_e=[None]*nd; dlo_x=[None]*nd
for i in range(T_DON_ENTRY,nd): dhi_e[i]=max(BD[j]["high"] for j in range(i-T_DON_ENTRY,i))
for i in range(T_DON_EXIT,nd):  dlo_x[i]=min(BD[j]["low"]  for j in range(i-T_DON_EXIT,i))

print(f"4h bars: {n}  {datetime.datetime.utcfromtimestamp(bars4h[0]['time']/1000):%Y-%m-%d} -> "
      f"{datetime.datetime.utcfromtimestamp(bars4h[-1]['time']/1000):%Y-%m-%d}")

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
    if nn==0: return dict(n=0,ra=0,sharpe=0,wr=0,roi=0,dollars=0,mdd=0,tpy=0,by_yr={},stab=0,ny=0)
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
    WARM=max(T_DON_ENTRY,200)
    pnl=[0.0]*nd; pnl_b=[0.0]*nd
    holding=False; entry_px=0.0; entry_atr=0.0
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


# ===================== TASK 2: classifier separation quality =====================
labA=LABELS["A"]
windows=[]; i=0
while i<nd:
    if labA[i]=="BEAR":
        j=i
        while j<nd and labA[j]=="BEAR": j+=1
        windows.append((i,j-1)); i=j
    else: i+=1
def realbear_check(s,e):
    p0=CD_[s]; lo=p0; end=min(s+60,nd-1)
    for k in range(s,end+1): lo=min(lo,CD_[k])
    return (p0-lo)/p0>=0.20
real_wins=[]; false_wins=[]
for (s,e) in windows:
    if e-s+1<3: continue
    (real_wins if realbear_check(s,e) else false_wins).append((s,e))
real_dayset=set(k for (s,e) in real_wins for k in range(s,e+1))
false_dayset=set(k for (s,e) in false_wins for k in range(s,e+1))

print("\n"+"="*78)
print("TASK A — current MA200 (classifier A) BEAR windows, real vs false")
print("="*78)
for (s,e) in windows:
    if e-s+1<3: continue
    d0=datetime.datetime.utcfromtimestamp(BD[s]["time"]/1000).strftime("%Y-%m-%d")
    d1=datetime.datetime.utcfromtimestamp(BD[e]["time"]/1000).strftime("%Y-%m-%d")
    v="REAL bear" if realbear_check(s,e) else "FALSE (dip+recover)"
    print(f"  {d0}->{d1}  ({e-s+1}d)  {v}")
print(f"\n  real-bear days={len(real_dayset)}  false-bear days={len(false_dayset)}")
print(f"\n  {'cls':>3} | {'totalBEARd':>10} | {'realCaught':>12} | {'falseKept':>10} | {'falseCut':>8}")
for m in CLASSIFIERS:
    lab=LABELS[m]
    tb=sum(1 for i in range(nd) if lab[i]=="BEAR")
    rc=sum(1 for k in real_dayset if lab[k]=="BEAR")
    fk=sum(1 for k in false_dayset if lab[k]=="BEAR")
    print(f"  {m:>3} | {tb:>10} | {rc:>4}/{len(real_dayset):<6} | {fk:>3}/{len(false_dayset):<5} | {len(false_dayset)-fk:>8}")


# ===================== TASK 3: book under each classifier =====================
ptW=max(T_DON_ENTRY,200)
results={}
for m in CLASSIFIERS:
    h=h1_stats(run_hedge01(m))
    pt,_,_=run_turtle(m); t=turtle_stats(pt,ptW)
    results[m]=(h,t)

print("\n"+"="*78)
print("TASK B — hedge01 v0.4.79 under each classifier")
print("="*78)
print(f"  {'cls':>3} | {'n':>4} | {'Sharpe':>7} | {'RA':>7} | {'WR':>4} | {'ROI%':>7} | "
      f"{'$(100k)':>10} | {'MaxDD%':>7} | {'stab':>5}")
for m in CLASSIFIERS:
    h=results[m][0]
    print(f"  {m:>3} | {h['n']:>4} | {h['sharpe']:>7.2f} | {h['ra']:>+7.3f} | {h['wr']:>3.0f}% | "
          f"{h['roi']:>+7.0f} | {h['dollars']:>+10,.0f} | {h['mdd']:>6.0f}% | {h['stab']}/{h['ny']}")
print("\n  hedge01 per-year ROI%:")
for m in CLASSIFIERS:
    h=results[m][0]
    print(f"    {m}: " + " ".join(f"{y}:{h['by_yr'].get(y,0)*100:+.0f}" for y in sorted(h['by_yr'])))

print(f"\n--- turtle (Daily Don20/10 + cut1.5, skip-BEAR) ---")
print(f"  {'cls':>3} | {'Total$':>9} | {'Sharpe':>7} | {'MaxDD$':>8} | {'stab':>5}")
for m in CLASSIFIERS:
    t=results[m][1]
    print(f"  {m:>3} | {t['total']:>+9.0f} | {t['sharpe']:>7.2f} | {t['mdd']:>8.0f} | {t['stab']}/{t['ny']}")
print("\n  turtle per-year $:")
for m in CLASSIFIERS:
    t=results[m][1]
    print(f"    {m}: " + " ".join(f"{y}:{t['by_yr'].get(y,0):+.0f}" for y in sorted(t['by_yr'])))

print("\n"+"="*78)
print("TASK C — delta vs baseline A  (2026 = real-bear protection guard; 3y has NO 2022)")
print("="*78)
hA,tA=results["A"]
print(f"  baseline A: hedge01 ${hA['dollars']:+,.0f} (Sh {hA['sharpe']:.2f}) + turtle ${tA['total']:+,.0f} (Sh {tA['sharpe']:.2f})")
print(f"\n  {'cls':>3} | {'h01 dSharpe':>11} | {'h01 d$':>10} | {'turtle d$':>10} | {'2026 h01':>9} | {'2026 turt':>10}")
for m in CLASSIFIERS:
    if m=="A": continue
    h,t=results[m]
    print(f"  {m:>3} | {h['sharpe']-hA['sharpe']:>+11.2f} | {h['dollars']-hA['dollars']:>+10,.0f} | "
          f"{t['total']-tA['total']:>+10,.0f} | {h['by_yr'].get(2026,0)*100:>+8.0f}% | {t['by_yr'].get(2026,0):>+10.0f}")
print("\n  GUARD: 2026 (real bear) must stay near baseline A. If a classifier pumps 2026 entries")
print("  => re-entering real bear => REJECT. Improvement must come from 2023/2024/2025 false-bears.")
