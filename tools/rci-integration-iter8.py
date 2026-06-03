#!/usr/bin/env python3
"""
rci-integration-iter8.py — RCI INTEGRATION iteration 8: ERA / REGIME ROBUSTNESS.

FINAL validation of the tamed reversal sleeve before trusting the deployed paper logger.

Tamed config (from iter6 SELECTED): ALL regime | RCI-top exit | ATR cut 2.0x |
  max-hold 200 bars (33d) | one_pos=True | vol_target=True.

RED FLAG from iter7: BTC reversal edge looks carried by 2019-2021. On recent 3y alone
  Sharpe ~0.39, only 2/4 yrs positive. Is it structural or a 2019-21 dip-buy artifact?

Tasks:
  1. Era split: 2019-20 / 2021 / 2022 / 2023-24 / 2025-26. Where does edge live?
  2. Bull vs Bear vs Range performance (tag by 1d regime at entry).
  3. Recent-window (2023-26) honest expectancy.
  4. Robustness verdict: (a) structural edge worth sizing OR (b) 2019-21 artifact.

Judge Sharpe + DOLLARS per era. Structural. BTC only.
"""
import json, datetime, math
from collections import defaultdict

CACHE   = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FEE = 0.05/100
H4  = 4*3600*1000
CAP = 100000

def load_tf(raw, ms):
    b={}
    for c in raw:
        k=c["time"]//ms
        if k not in b: b[k]={"time":k*ms,"open":c["open"],"high":c["high"],"low":c["low"],"close":c["close"],"volume":c["volume"]}
        else:
            o=b[k]; o["high"]=max(o["high"],c["high"]); o["low"]=min(o["low"],c["low"]); o["close"]=c["close"]; o["volume"]+=c["volume"]
    return [b[k] for k in sorted(b)]
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
bars4h=load_tf(raw,H4); bars1d=load_tf(raw,86400*1000)
n=len(bars4h); c4=[b["close"] for b in bars4h]
atr4=atr_series(bars4h,14)
rsi4=rsi_series(c4,14); stk4=stoch_k(bars4h,14); bb4=bb_pctb(c4,20)
regime_1d=regime_persist(bars1d); reg_map={}
for i,b in enumerate(bars1d): reg_map[b["time"]//86400000]=regime_1d[i]
def get_reg(ts): return reg_map.get(ts//86400000,"RANGE")

def atp(i): return None if atr4[i] is None else atr4[i]/c4[i]
ATP_LB=180
def atp_pctile(i):
    if i<ATP_LB+14: return None
    cur=atp(i)
    if cur is None: return None
    vs=[atp(j) for j in range(i-ATP_LB,i) if atp(j) is not None]
    if len(vs)<ATP_LB//2: return None
    below=sum(1 for v in vs if v<cur)
    return below/len(vs)

def is_rci_top(i):
    if None in (rsi4[i],stk4[i],bb4[i]): return False
    return rsi4[i]>70 and stk4[i]>80 and bb4[i]>0.95
COOLDOWN=12
def oversold(i):
    if None in (rsi4[i],stk4[i],bb4[i]): return False
    return rsi4[i]<30 and stk4[i]<20 and bb4[i]<0.05

def sim(ei, atr_mult, max_hold):
    ep=c4[ei]; ae=atr4[ei]
    if ae is None or ae<=0: return None
    atr_stop=ep-ae*atr_mult
    for h in range(1,max_hold+1):
        j=ei+h
        if j>=n: break
        if bars4h[j]["low"]<=atr_stop:
            return (atr_stop-ep)/ep-2*FEE,h,"SL"
        if is_rci_top(j):
            return (c4[j]-ep)/ep-2*FEE,h,"RCITOP"
    j=min(ei+max_hold,n-1)
    return (c4[j]-ep)/ep-2*FEE,max_hold,"MAXHOLD"

# TAMED config: ALL | atr2.0 | hold200 | 1pos | voltarget
TAMED=dict(regimes={"RANGE","BULL","BEAR"},atr_mult=2.0,max_hold=200,one_pos=True,vol_target=True,vt_floor=0.40)

def run(regimes,atr_mult,max_hold,one_pos,vol_target,vt_floor=0.40):
    trades=[]; last=-10**9; open_until=-1
    for i in range(250,n-1):
        ts=bars4h[i]["time"]
        if get_reg(ts) not in regimes: continue
        if not oversold(i): continue
        if i-last<COOLDOWN: continue
        if one_pos and i<open_until: continue
        r=sim(i,atr_mult,max_hold)
        if r is None: continue
        ret,h,reason=r
        size=1.0
        if vol_target:
            pc=atp_pctile(i)
            if pc is not None: size=max(vt_floor,1.0-pc)
        yr=datetime.datetime.utcfromtimestamp(ts/1000).year
        trades.append({"ret":ret,"sret":ret*size,"size":size,"h":h,"yr":yr,"exit":reason,"bar":i,
                       "reg":get_reg(ts),"ts":ts,"close_mo":mo_of(bars4h[min(i+h,n-1)]["time"])})
        last=i; open_until=i+h
    return trades

def metrics(trades,use_size=True):
    """Return dict of metrics for a trade list. sret = size-weighted return (the sizing actually deployed)."""
    if not trades: return None
    key="sret" if use_size else "ret"
    rets=[t[key] for t in trades]; nt=len(rets); mean=sum(rets)/nt
    sd=(sum((r-mean)**2 for r in rets)/nt)**0.5 or 1e-9; ra=mean/sd
    yrs=len(set(t["yr"] for t in trades)); sharpe=ra*math.sqrt(nt/max(yrs,1))
    wins=[r for r in rets if r>0]; losses=[r for r in rets if r<=0]
    wr=len(wins)/nt*100
    roi=sum(rets)*100; dollars=CAP*sum(rets)
    eq=0;peak=0;mdd=0
    for t in sorted(trades,key=lambda x:x["bar"]):
        eq+=t[key]; peak=max(peak,eq); mdd=max(mdd,peak-eq)
    aw=sum(wins)/len(wins)*100 if wins else 0
    al=sum(losses)/len(losses)*100 if losses else 0
    by_yr=defaultdict(float)
    for t in trades: by_yr[t["yr"]]+=t[key]
    pos=sum(1 for v in by_yr.values() if v>0)
    return {"n":nt,"ra":ra,"sharpe":sharpe,"wr":wr,"roi":roi,"dollars":dollars,
            "mdd":mdd*100,"avgwin":aw,"avgloss":al,"stab":pos,"nyr":len(by_yr),
            "by_yr":dict(by_yr)}

# generate the full tamed sleeve once
ALL=run(**TAMED)
print(f"\nTamed sleeve total trades 7y: {len(ALL)}")
full=metrics(ALL)
print(f"FULL 7y: n={full['n']} Sh={full['sharpe']:+.2f} ROI={full['roi']:+.0f}% ${full['dollars']:+,.0f} "
      f"DD={full['mdd']:.0f}% WR={full['wr']:.0f}% avgW={full['avgwin']:+.2f}% avgL={full['avgloss']:+.2f}% stab={full['stab']}/{full['nyr']}")

# ============================================================
print("\n"+"="*92)
print("TASK 1 — ERA SPLIT (size-weighted, the sleeve as deployed)")
print("="*92)
ERAS=[("2019-2020",{2019,2020}),("2021",{2021}),("2022",{2022}),
      ("2023-2024",{2023,2024}),("2025-2026",{2025,2026})]
print(f"  {'era':<12}{'n':>4}{'Sh':>7}{'ROI%':>8}{'$':>11}{'WR%':>6}{'DD%':>6}{'avgW%':>7}{'avgL%':>7}{'posYr':>7}")
era_rows=[]
for lab,yrs in ERAS:
    tr=[t for t in ALL if t["yr"] in yrs]
    m=metrics(tr)
    if not m:
        print(f"  {lab:<12}  NO TRADES"); era_rows.append((lab,None)); continue
    print(f"  {lab:<12}{m['n']:>4}{m['sharpe']:>+7.2f}{m['roi']:>+8.0f}{m['dollars']:>+11,.0f}{m['wr']:>6.0f}{m['mdd']:>6.0f}{m['avgwin']:>+7.2f}{m['avgloss']:>+7.2f}{m['stab']:>4}/{m['nyr']}")
    era_rows.append((lab,m))

# per-year detail
print("\n  Per-year size-weighted ROI%:")
by_yr_all=defaultdict(lambda:[0.0,0])
for t in ALL: by_yr_all[t["yr"]][0]+=t["sret"]; by_yr_all[t["yr"]][1]+=1
for y in sorted(by_yr_all):
    v,c=by_yr_all[y]; print(f"    {y}: ROI={v*100:+6.1f}%  n={c}")

# ============================================================
print("\n"+"="*92)
print("TASK 2 — REGIME BREAKDOWN (1d regime at entry)")
print("="*92)
print(f"  {'regime':<8}{'n':>4}{'Sh':>7}{'ROI%':>8}{'$':>11}{'WR%':>6}{'avgW%':>7}{'avgL%':>7}{'expectancy%':>12}")
reg_rows=[]
for rg in ["BULL","RANGE","BEAR"]:
    tr=[t for t in ALL if t["reg"]==rg]
    m=metrics(tr)
    if not m:
        print(f"  {rg:<8}  NO TRADES"); reg_rows.append((rg,None)); continue
    exp=m['roi']/m['n']  # avg sret % per trade
    print(f"  {rg:<8}{m['n']:>4}{m['sharpe']:>+7.2f}{m['roi']:>+8.0f}{m['dollars']:>+11,.0f}{m['wr']:>6.0f}{m['avgwin']:>+7.2f}{m['avgloss']:>+7.2f}{exp:>+12.3f}")
    reg_rows.append((rg,m))

# regime within the recent window only
print("\n  Regime breakdown 2023-2026 ONLY (forward-relevant):")
print(f"  {'regime':<8}{'n':>4}{'Sh':>7}{'ROI%':>8}{'$':>11}{'WR%':>6}{'expectancy%':>12}")
recent_tr=[t for t in ALL if t["yr"]>=2023]
reg_recent=[]
for rg in ["BULL","RANGE","BEAR"]:
    tr=[t for t in recent_tr if t["reg"]==rg]
    m=metrics(tr)
    if not m:
        print(f"  {rg:<8}  NO TRADES"); reg_recent.append((rg,None)); continue
    exp=m['roi']/m['n']
    print(f"  {rg:<8}{m['n']:>4}{m['sharpe']:>+7.2f}{m['roi']:>+8.0f}{m['dollars']:>+11,.0f}{m['wr']:>6.0f}{exp:>+12.3f}")
    reg_recent.append((rg,m))

# ============================================================
print("\n"+"="*92)
print("TASK 3 — RECENT-WINDOW (2023-2026) HONEST EXPECTANCY")
print("="*92)
m=metrics(recent_tr)
yrs_recent=sorted(set(t["yr"] for t in recent_tr))
nyr=len(yrs_recent)
print(f"  n={m['n']} over {nyr} yrs ({min(yrs_recent)}-{max(yrs_recent)})")
print(f"  Sharpe={m['sharpe']:+.2f}  ROI(total)={m['roi']:+.0f}%  ${m['dollars']:+,.0f}  DD={m['mdd']:.0f}%")
print(f"  WR={m['wr']:.0f}%  avgWin={m['avgwin']:+.2f}%  avgLoss={m['avgloss']:+.2f}%")
print(f"  per-trade expectancy = {m['roi']/m['n']:+.3f}% (size-weighted)")
print(f"  trades/yr ~ {m['n']/nyr:.0f}  ->  expected annual ROI ~ {m['roi']/nyr:+.1f}%")
print(f"  stability: {m['stab']}/{m['nyr']} yrs positive")
print(f"  per-year: "+" ".join(f"{y}:{m['by_yr'].get(y,0)*100:+.0f}%" for y in yrs_recent))
# expectancy on $100k book at 10% sleeve sizing
sleeve_cap=0.10*CAP
print(f"\n  AT 10% SLEEVE SIZING (${sleeve_cap:,.0f} of $100k book):")
print(f"    expected annual sleeve PnL ~ {m['roi']/nyr/100*sleeve_cap:+,.0f}  (= {m['roi']/nyr:.1f}% of sleeve cap)")
print(f"    contribution to book ROI ~ {m['roi']/nyr*0.10:+.2f}%/yr")

# ============================================================
print("\n"+"="*92)
print("TASK 4 — ROBUSTNESS VERDICT")
print("="*92)
# concentration: what fraction of total $ comes from 2019-21?
early=[t for t in ALL if t["yr"]<=2021]; late=[t for t in ALL if t["yr"]>=2022]
e_d=CAP*sum(t["sret"] for t in early); l_d=CAP*sum(t["sret"] for t in late)
tot_d=e_d+l_d
print(f"  $ from 2019-2021: ${e_d:+,.0f}  ({e_d/tot_d*100:.0f}% of total)")
print(f"  $ from 2022-2026: ${l_d:+,.0f}  ({l_d/tot_d*100:.0f}% of total)")
recent3=[t for t in ALL if t["yr"]>=2023]
r_d=CAP*sum(t["sret"] for t in recent3)
print(f"  $ from 2023-2026: ${r_d:+,.0f}  ({r_d/tot_d*100:.0f}% of total)")
print(f"\n  Sharpe full 7y = {full['sharpe']:+.2f} ; Sharpe 2023-26 = {metrics(recent3)['sharpe']:+.2f}")
