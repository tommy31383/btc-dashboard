#!/usr/bin/env python3
"""
rci-integration-iter6.py — RCI INTEGRATION iteration 6: DD REDUCTION.

ITER5 best standalone sleeve = ALL-regime | no funding | no confirm | RCI-top exit | -2.2ATR cut.
  n=137 Sharpe 0.87 +$253k 6/8yrs BUT MaxDD 57% → too risky to size; doubles book DD 13->28.

GOAL: tame the 57% DD toward <30-35% while keeping the edge (Sharpe>=0.7, >=5/8 yrs).

Tasks:
  1. Diagnose the 57% DD — when/which regime (BEAR knife-catch vs BULL early-short).
  2. Regime gating for DD — RANGE / RANGE+BULL / skip-BEAR / ALL; rank by return/DD (Calmar).
  3. DD levers sweep — ATR cut tightness, max-hold cap, 1-position-only, vol-targeting.
  4. Re-test book with tamed sleeve (hedge01+turtle+tamed).
  5. Verdict.

Judge Sharpe + DOLLARS + return/DD (Calmar). >=5/8 yrs positive. Structural. BTC only. No SL removal.
"""
import json, datetime, math
from collections import defaultdict

CACHE   = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FUNDING = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-funding-7y.json"
FEE = 0.05/100
H4  = 4*3600*1000
CAP = 100000

# ── indicator helpers (from iter5) ──
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
bars4h=load_tf(raw,H4); bars1d=load_tf(raw,86400*1000)
n=len(bars4h); c4=[b["close"] for b in bars4h]
atr4=atr_series(bars4h,14)
rsi4=rsi_series(c4,14); stk4=stoch_k(bars4h,14); bb4=bb_pctb(c4,20)
regime_1d=regime_persist(bars1d); reg_map={}
for i,b in enumerate(bars1d): reg_map[b["time"]//86400000]=regime_1d[i]
def get_reg(ts): return reg_map.get(ts//86400000,"RANGE")

# ATR% percentile lookback (for vol-targeting)
def atp(i): return None if atr4[i] is None else atr4[i]/c4[i]
ATP_LB=180  # ~30d of 4h bars
def atp_pctile(i):
    """percentile rank (0-1) of current atr% within last ATP_LB bars."""
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
    """RCI-top exit + ATR(atr_mult) protective stop, hold capped at max_hold bars. Returns (ret_frac, h, reason)."""
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

def run(regimes, atr_mult=2.2, max_hold=200, one_pos=False, vol_target=False, vt_floor=0.40):
    """one_pos: skip new entry while a position is open (no stacking).
       vol_target: scale entry $ by (1 - atp_pctile) clamped to [vt_floor,1] — smaller size in high vol."""
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
            if pc is not None:
                size=max(vt_floor, 1.0-pc)  # high vol pctile -> smaller size
        yr=datetime.datetime.utcfromtimestamp(ts/1000).year
        trades.append({"ret":ret,"sret":ret*size,"size":size,"h":h,"yr":yr,"exit":reason,"bar":i,
                       "reg":get_reg(ts),"ts":ts,"close_mo":mo_of(bars4h[min(i+h,n-1)]["time"])})
        last=i; open_until=i+h
    return trades

def stats(trades,label,use_size=False,silent=False):
    if not trades:
        if not silent: print(f"  [{label}] NO TRADES")
        return None
    key="sret" if use_size else "ret"
    rets=[t[key] for t in trades]; nt=len(rets); mean=sum(rets)/nt
    sd=(sum((r-mean)**2 for r in rets)/nt)**0.5 or 1e-9; ra=mean/sd
    yrs=len(set(t["yr"] for t in trades)); sharpe=ra*math.sqrt(nt/max(yrs,1))
    wr=sum(1 for r in rets if r>0)/nt*100
    roi=sum(rets)*100; dollars=CAP*sum(rets)
    eq=0;peak=0;mdd=0
    for t in sorted(trades,key=lambda x:x["bar"]):
        eq+=t[key]; peak=max(peak,eq); mdd=max(mdd,peak-eq)
    by_yr=defaultdict(float)
    for t in trades: by_yr[t["yr"]]+=t[key]
    pos=sum(1 for v in by_yr.values() if v>0)
    yr_str=" ".join(f"{y}:{by_yr[y]*100:+.0f}" for y in sorted(by_yr))
    mdd_pct=mdd*100
    calmar=roi/mdd_pct if mdd_pct>0 else 0
    if not silent:
        print(f"  [{label}] n={nt} RA={ra:+.3f} Sh={sharpe:+.2f} WR={wr:.0f}% ROI={roi:+.0f}% ${dollars:+,.0f} DD={mdd_pct:.0f}% Calmar={calmar:.2f} stab={pos}/{len(by_yr)}")
        print(f"       yr: {yr_str}")
    return {"n":nt,"ra":ra,"sharpe":sharpe,"wr":wr,"roi":roi,"dollars":dollars,
            "mdd":mdd_pct,"calmar":calmar,"stab":pos,"nyr":len(by_yr),"trades":trades}

# ============================================================
print("\n"+"="*90)
print("TASK 1 — DIAGNOSE THE 57% DD (iter5 best: ALL | no-funding | no-confirm | RCI-top | 2.2ATR)")
print("="*90)
base=run({"RANGE","BEAR","BULL"},atr_mult=2.2,max_hold=200)
bs=stats(base,"ITER5-BASELINE")
# equity path with regime annotation; locate the worst drawdown window
seq=sorted(base,key=lambda x:x["bar"])
eq=0;peak=0;peak_idx=0;worst=0;worst_lo=0;worst_hi=0
running=[]
for k,t in enumerate(seq):
    eq+=t["ret"]; running.append(eq)
    if eq>peak: peak=eq; peak_idx=k
    dd=peak-eq
    if dd>worst:
        worst=dd; worst_lo=k; worst_hi=peak_idx
# trough date / peak date
def dts(k): return datetime.datetime.utcfromtimestamp(seq[k]["ts"]/1000).strftime("%Y-%m-%d")
print(f"\n  WORST DRAWDOWN: {worst*100:.0f}% (R-units)")
print(f"    peak at trade#{worst_hi} {dts(worst_hi)} reg={seq[worst_hi]['reg']} (eq={running[worst_hi]:+.2f})")
print(f"    trough at trade#{worst_lo} {dts(worst_lo)} reg={seq[worst_lo]['reg']} (eq={running[worst_lo]:+.2f})")
# regime breakdown of the trades INSIDE the worst-dd window
dd_trades=seq[worst_hi+1:worst_lo+1]
reg_pnl=defaultdict(float); reg_n=defaultdict(int)
for t in dd_trades:
    reg_pnl[t["reg"]]+=t["ret"]; reg_n[t["reg"]]+=1
print(f"    trades inside DD window: {len(dd_trades)}")
for r in ["BEAR","RANGE","BULL"]:
    if reg_n[r]: print(f"      {r:6}: n={reg_n[r]:3} pnl={reg_pnl[r]*100:+.0f}R")
# regime breakdown overall (where do losses come from)
print("\n  OVERALL pnl by regime (all 7y trades):")
oreg_pnl=defaultdict(float); oreg_n=defaultdict(int); oreg_loss=defaultdict(float)
for t in base:
    oreg_pnl[t["reg"]]+=t["ret"]; oreg_n[t["reg"]]+=1
    if t["ret"]<0: oreg_loss[t["reg"]]+=t["ret"]
for r in ["BEAR","RANGE","BULL"]:
    if oreg_n[r]:
        print(f"      {r:6}: n={oreg_n[r]:3} totpnl={oreg_pnl[r]*100:+5.0f}R  lossSum={oreg_loss[r]*100:+5.0f}R  avg={oreg_pnl[r]/oreg_n[r]*100:+.2f}R")

# ============================================================
print("\n"+"="*90)
print("TASK 2 — REGIME GATING FOR DD (rank by Calmar = ROI/MaxDD)")
print("="*90)
regime_sets=[({"RANGE"},"RANGE-only"),({"RANGE","BULL"},"RANGE+BULL"),
             ({"RANGE","BULL","BEAR"},"ALL"),({"BEAR"},"BEAR-only"),({"BULL"},"BULL-only")]
# skip-BEAR == RANGE+BULL ; included explicitly
t2={}
for rs,lab in regime_sets:
    r=stats(run(rs,2.2,200),lab)
    t2[lab]=r

# ============================================================
print("\n"+"="*90)
print("TASK 3 — DD-REDUCTION LEVERS (on best DD regime; sweep each lever)")
print("="*90)
# pick the regime with DD<35% & positive that has best calmar as the lever base
cands=[(lab,t2[lab]) for lab in t2 if t2[lab] and t2[lab]["dollars"]>0 and t2[lab]["stab"]>=5]
cands.sort(key=lambda kv:-kv[1]["calmar"])
print("\n  Regime candidates (positive,>=5yr) ranked by Calmar:")
for lab,v in cands:
    print(f"    {lab:12} Calmar={v['calmar']:.2f} DD={v['mdd']:.0f}% Sh={v['sharpe']:+.2f} ${v['dollars']:+,.0f} stab={v['stab']}/{v['nyr']}")
base_reg = {"RANGE","BULL"}  # skip-BEAR default lever base (set below after seeing)
base_reg_lab="RANGE+BULL"
# but use the top calmar regime that keeps n reasonable
if cands:
    top=cands[0][0]
    base_reg_lab=top
    base_reg={ "RANGE-only":{"RANGE"},"RANGE+BULL":{"RANGE","BULL"},"ALL":{"RANGE","BULL","BEAR"},
               "BEAR-only":{"BEAR"},"BULL-only":{"BULL"} }[top]
print(f"\n  >> lever base regime = {base_reg_lab}")

print("\n  [3a] ATR cut tightness (max_hold=200):")
for am in [1.5,1.8,2.0,2.2,2.5]:
    stats(run(base_reg,am,200),f"ATR{am}")
print("\n  [3b] Max-hold cap (atr=2.2):  24h=6bars 48h=12 72h=18 96h=24")
for mh,lab in [(6,"24h"),(12,"48h"),(18,"72h"),(24,"96h"),(48,"8d"),(200,"33d")]:
    stats(run(base_reg,2.2,mh),f"hold{lab}")
print("\n  [3c] One-position-only (no stacking) vs allow-stack (atr2.2,hold200):")
stats(run(base_reg,2.2,200,one_pos=False),"stack")
stats(run(base_reg,2.2,200,one_pos=True),"1pos")
print("\n  [3d] Vol-targeting (size down in high ATR% pctile, floor 0.40):")
vt=run(base_reg,2.2,200,vol_target=True)
stats(vt,"voltarget",use_size=True)

print("\n  [3e] COMBO search: regime x atr x hold x 1pos x voltarget — find DD<30 Sh>=0.7 stab>=5")
combos=[]
for rs,rl in [({"RANGE"},"RANGE"),({"RANGE","BULL"},"RANGE+BULL"),({"RANGE","BULL","BEAR"},"ALL")]:
    for am in [1.8,2.0,2.2]:
        for mh,ml in [(12,"48h"),(18,"72h"),(24,"96h"),(48,"8d"),(200,"33d")]:
            for op in [False,True]:
                for vt_ in [False,True]:
                    tr=run(rs,am,mh,one_pos=op,vol_target=vt_)
                    v=stats(tr,"",use_size=vt_,silent=True)
                    if not v or v["n"]<20: continue
                    lab=f"{rl}|atr{am}|{ml}|{'1pos' if op else 'stack'}|{'vt' if vt_ else 'full'}"
                    combos.append((lab,v))
# rank: prefer DD<30, then Calmar, require Sh>=0.7 stab>=5
print("\n  Combos meeting DD<35 & Sh>=0.7 & stab>=5 (top 15 by Calmar):")
ok=[(l,v) for l,v in combos if v["mdd"]<35 and v["sharpe"]>=0.7 and v["stab"]>=5 and v["dollars"]>0]
ok.sort(key=lambda kv:-kv[1]["calmar"])
print(f"    {'config':<40}{'n':>4}{'Sh':>6}{'ROI%':>7}{'$':>11}{'DD%':>6}{'Calm':>6}{'stab':>6}")
for l,v in ok[:15]:
    print(f"    {l:<40}{v['n']:>4}{v['sharpe']:>+6.2f}{v['roi']:>+7.0f}{v['dollars']:>+11,.0f}{v['mdd']:>6.0f}{v['calmar']:>6.2f} {v['stab']}/{v['nyr']}")
if not ok:
    print("    NONE under DD<35 with Sh>=0.7. Loosening to DD<40:")
    ok=[(l,v) for l,v in combos if v["mdd"]<40 and v["sharpe"]>=0.6 and v["stab"]>=5 and v["dollars"]>0]
    ok.sort(key=lambda kv:-kv[1]["calmar"])
    for l,v in ok[:15]:
        print(f"    {l:<40}{v['n']:>4}{v['sharpe']:>+6.2f}{v['roi']:>+7.0f}{v['dollars']:>+11,.0f}{v['mdd']:>6.0f}{v['calmar']:>6.2f} {v['stab']}/{v['nyr']}")

best=ok[0] if ok else None
print("\n  >>> SELECTED TAMED CONFIG:", best[0] if best else "NONE")
if best:
    # rebuild trades for the selected config to get monthly for the book
    l,v=best
    parts=l.split("|")
    rl=parts[0]; am=float(parts[1][3:]); mh={"48h":12,"72h":18,"96h":24,"8d":48,"33d":200}[parts[2]]
    op=parts[3]=="1pos"; vtf=parts[4]=="vt"
    rs={"RANGE":{"RANGE"},"RANGE+BULL":{"RANGE","BULL"},"ALL":{"RANGE","BULL","BEAR"}}[rl]
    tamed=run(rs,am,mh,one_pos=op,vol_target=vtf)
    print("\n  Tamed standalone full stats:")
    tv=stats(tamed,"TAMED",use_size=vtf)
    # emit monthly (size-weighted) for book
    key="sret" if vtf else "ret"
    sleeve_mo=defaultdict(float)
    for t in tamed: sleeve_mo[t["close_mo"]]+=t[key]
    open("/tmp/rci_iter6_mo.txt","w").write("RCI_MONTHLY "+json.dumps(dict(sleeve_mo)))
    print(f"\n  (monthly written to /tmp/rci_iter6_mo.txt — {len(sleeve_mo)} months)")
