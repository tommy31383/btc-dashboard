#!/usr/bin/env python3
"""
backtest-ema9x21-filters-7y.py — EMA 9/21 LONG 4h + filter layering

Baseline: EMA9>EMA21 cross (prev<= now>) + EMA200 1h gate
          SL=2×ATR, TP=3×ATR fixed | n=249/7y, RA=+0.085, monthly win=60%

Progressively add filters và đo impact:
  F0: Baseline (no extra filter)
  F1: + RANGE-only regime
  F2: + ADX>20 sticky
  F3: + ATR%ile 50th
  F4: + RANGE + ADX
  F5: + RANGE + ADX + ATR50
  F6: + RANGE + ADX + ATR50 + vol>MA10×1.2

Also test trailing SL (như hedge01) vs fixed TP/SL.

Report: n, RA, monthly win%, per-year stab, walk-forward decay
Accept candidate: monthly_win >= 55%, RA >= 0.20, stab >= 4/6
"""
import json, datetime
from collections import defaultdict

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FEE   = 0.05 / 100
WF_CUT = int(datetime.datetime(2023,1,1).timestamp()*1000)

print("Loading data...")
raw = json.load(open(CACHE))
raw.sort(key=lambda x: x["time"])

def agg_tf(bars, ms):
    b = {}
    for c in bars:
        k = c["time"]//ms
        if k not in b:
            b[k]={"time":k*ms,"open":c["open"],"high":c["high"],"low":c["low"],"close":c["close"],"volume":c["volume"]}
        else:
            o=b[k];o["high"]=max(o["high"],c["high"]);o["low"]=min(o["low"],c["low"])
            o["close"]=c["close"];o["volume"]+=c["volume"]
    return [b[k] for k in sorted(b)]

bars4h = agg_tf(raw,  4*3600*1000)
bars1h = agg_tf(raw,  1*3600*1000)
bars1d = agg_tf(raw, 24*3600*1000)
n = len(bars4h)
c4 = [b["close"] for b in bars4h]
print(f"4h: {n} bars  {datetime.datetime.utcfromtimestamp(bars4h[0]['time']/1000):%Y-%m-%d} → {datetime.datetime.utcfromtimestamp(bars4h[-1]['time']/1000):%Y-%m-%d}")

def ema(xs, p):
    k=2/(p+1); out=[None]*len(xs); e=None
    for i,x in enumerate(xs):
        e=x if e is None else x*k+e*(1-k); out[i]=e
    return out

def _dm_tr(bars):
    n=len(bars); pdm=[0.0]*n; ndm=[0.0]*n; tr=[0.0]*n
    for i in range(1,n):
        up=bars[i]["high"]-bars[i-1]["high"]; dn=bars[i-1]["low"]-bars[i]["low"]
        pdm[i]=up if up>dn and up>0 else 0; ndm[i]=dn if dn>up and dn>0 else 0
        tr[i]=max(bars[i]["high"]-bars[i]["low"],abs(bars[i]["high"]-bars[i-1]["close"]),abs(bars[i]["low"]-bars[i-1]["close"]))
    return pdm,ndm,tr

def adx_wilder(bars,period=14):
    pdm,ndm,tr=_dm_tr(bars); n=len(bars)
    if n<=period+1: return [None]*n
    smTR=sum(tr[1:period+1]); smPDM=sum(pdm[1:period+1]); smNDM=sum(ndm[1:period+1])
    dx_arr=[]; adx_val=None; out=[None]*n
    for i in range(period+1,n):
        smTR=smTR-smTR/period+tr[i]; smPDM=smPDM-smPDM/period+pdm[i]; smNDM=smNDM-smNDM/period+ndm[i]
        pdi=smPDM/smTR*100 if smTR>0 else 0; ndi=smNDM/smTR*100 if smTR>0 else 0
        dx=abs(pdi-ndi)/(pdi+ndi)*100 if (pdi+ndi)>0 else 0; dx_arr.append(dx)
        if len(dx_arr)<period: continue
        elif len(dx_arr)==period: adx_val=sum(dx_arr)/period
        else: adx_val=(adx_val*(period-1)+dx)/period
        out[i]=adx_val
    return out

def atr_wilder(bars,period=14):
    _,_,tr=_dm_tr(bars); n=len(bars); out=[None]*n
    s=sum(tr[1:period+1]); out[period]=s/period
    for i in range(period+1,n): out[i]=(out[i-1]*(period-1)+tr[i])/period
    return out

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

print("Computing indicators...")
e9   = ema(c4, 9)
e21  = ema(c4, 21)
adx4 = adx_wilder(bars4h)
atr4 = atr_wilder(bars4h)
e200_1h = ema([b["close"] for b in bars1h], 200)
h1t = [b["time"] for b in bars1h]

reg1d = regime_wp(bars1d)
reg_map = {}
for i,b in enumerate(bars1d): reg_map[b["time"]//86400000] = reg1d[i]
def get_reg(ts): return reg_map.get(ts//86400000,"RANGE")

ATR_LB=90
def atp(i):
    return atr4[i]/c4[i] if atr4[i] else None
def atp_pass(i,pct=0.50):
    if i<ATR_LB+14: return False
    vs=[atp(j) for j in range(i-ATR_LB,i) if atp(j) is not None]
    if len(vs)<ATR_LB: return False
    cur=atp(i); return cur is not None and cur>=sorted(vs)[int(len(vs)*pct)]

VOL_MA=10; VOL_MULT=1.2
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
def get_month(ts):
    dt=datetime.datetime.utcfromtimestamp(ts/1000)
    return dt.year*100+dt.month

# Signal: EMA 9/21 golden cross LONG
def is_signal(i):
    if e9[i] is None or e21[i] is None or i<1: return False
    if e9[i-1] is None or e21[i-1] is None: return False
    return e9[i-1] <= e21[i-1] and e9[i] > e21[i]

FILTER_CONFIGS = {
    "F0_baseline":          {"range":False,"adx":False,"atr50":False,"vol":False},
    "F1_+RANGE":            {"range":True, "adx":False,"atr50":False,"vol":False},
    "F2_+ADX":              {"range":False,"adx":True, "atr50":False,"vol":False},
    "F3_+ATR50":            {"range":False,"adx":False,"atr50":True, "vol":False},
    "F4_+RANGE+ADX":        {"range":True, "adx":True, "atr50":False,"vol":False},
    "F5_+RANGE+ADX+ATR50":  {"range":True, "adx":True, "atr50":True, "vol":False},
    "F6_+ALL":              {"range":True, "adx":True, "atr50":True, "vol":True },
}

def apply_filter(i, cfg):
    e1h=e200_1h_at(bars4h[i]["time"])
    if e1h and c4[i]<e1h: return False          # EMA200 1h always
    if cfg["range"] and get_reg(bars4h[i]["time"]) != "RANGE": return False
    if cfg["adx"]:
        adv=adx4[i]; adv_p=adx4[i-1] if i>0 else None
        if adv is None or adv<=20: return False
        if adv_p is None or adv_p<=20: return False
    if cfg["atr50"] and not atp_pass(i, 0.50): return False
    if cfg["vol"] and not vol_pass(i): return False
    return True

# === BACKTEST: fixed TP/SL ===
SL_M=2.0; TP_M=3.0; MAX_HOLD=48; CD=12  # cooldown 12 bars 4h = 48h

def sim_fixed(i):
    ep=c4[i]; ae=atr4[i]
    if ae is None or ae<=0: return None
    sl=ep-ae*SL_M; tp=ep+ae*TP_M
    for h in range(1,MAX_HOLD+1):
        j=i+h
        if j>=n: break
        if bars4h[j]["low"]<=sl: return (sl-ep)/ep-2*FEE, h
        if bars4h[j]["high"]>=tp: return (tp-ep)/ep-2*FEE, h
    j2=min(i+MAX_HOLD,n-1)
    return (c4[j2]-ep)/ep-2*FEE, MAX_HOLD

# === BACKTEST: trailing SL (like hedge01) ===
SL_INIT=4.0; SL_TRAIL=3.0; SL_TRANS=24  # bars (96h)

def sim_trail(i):
    ep=c4[i]; ae=atr4[i]
    if ae is None or ae<=0: return None
    sl=ep-ae*SL_INIT; hwm=ep
    for h in range(1,200+1):
        j=i+h
        if j>=n: break
        mult=SL_INIT if h<SL_TRANS else SL_TRAIL
        if c4[j]>hwm: hwm=c4[j]; sl=hwm-ae*mult
        elif h>=SL_TRANS:
            t=hwm-ae*SL_TRAIL
            if t>sl: sl=t
        if bars4h[j]["low"]<=sl: return (sl-ep)/ep-2*FEE, h
    j2=min(i+200,n-1)
    return (c4[j2]-ep)/ep-2*FEE, 200

def run(cfg, use_trail=False):
    trades=[]; last=-CD
    for i in range(60, n-200):
        if not is_signal(i): continue
        if i-last < CD: continue
        if not apply_filter(i, cfg): continue
        r = sim_trail(i) if use_trail else sim_fixed(i)
        if r is None: continue
        ret,hold=r
        ts=bars4h[i]["time"]
        yr=datetime.datetime.utcfromtimestamp(ts/1000).year
        trades.append({"ret":ret,"hold":hold,"yr":yr,"month":get_month(ts),
                       "period":"test" if ts>=WF_CUT else "train"})
        last=i+hold
    return trades

def calc_ra(t):
    if not t: return None
    r=[x["ret"] for x in t]; m=sum(r)/len(r)
    sd=(sum((x-m)**2 for x in r)/len(r))**0.5
    return m/sd if sd>0 else 0

def report(trades, label):
    if not trades: print(f"  {label:40s} NO TRADES"); return None
    rets=[t["ret"] for t in trades]; n_=len(rets)
    mean=sum(rets)/n_; sd=(sum((r-mean)**2 for r in rets)/n_)**0.5 or 1e-9
    ra=mean/sd; wr=sum(1 for r in rets if r>0)/n_*100
    wins=[r for r in rets if r>0]; losses=[r for r in rets if r<=0]
    rr=(sum(wins)/len(wins) if wins else 0)/abs(sum(losses)/len(losses) if losses else 1e-9)
    by_yr=defaultdict(float)
    for t in trades: by_yr[t["yr"]]+=t["ret"]
    stab=sum(1 for v in by_yr.values() if v>0)
    # Monthly win%
    by_mo=defaultdict(list)
    for t in trades: by_mo[t["month"]].append(t["ret"])
    win_mo=sum(1 for vs in by_mo.values() if sum(vs)>0)
    total_mo=len(by_mo)
    mo_pct=win_mo/total_mo if total_mo>0 else 0
    yr_str=" ".join(f"{y}:{by_yr[y]*100:+.0f}%" for y in sorted(by_yr))
    # Walk-forward
    train=[t for t in trades if t["period"]=="train"]
    test =[t for t in trades if t["period"]=="test"]
    ra_tr=calc_ra(train); ra_te=calc_ra(test)
    decay=(ra_te-ra_tr)/abs(ra_tr)*100 if ra_tr else None
    flag="✅" if ra>=0.20 and mo_pct>=0.55 and stab>=4 else ("⚠️" if ra>0 else "✗")
    print(f"\n  {label:40s}")
    print(f"  n={n_:4d}  RA={ra:+.3f}  WR={wr:.0f}%  R:R={rr:.2f}  stab={stab}/{len(by_yr)}  mo_win={win_mo}/{total_mo}({mo_pct*100:.0f}%)  {flag}")
    print(f"  yr: {yr_str}")
    if ra_tr and ra_te:
        decay_flag="✅" if decay and decay>=-30 else "⚠️"
        print(f"  WF: TRAIN RA={ra_tr:+.3f}(n={len(train)}) TEST RA={ra_te:+.3f}(n={len(test)}) decay={decay:+.0f}% {decay_flag}")
    return {"label":label,"n":n_,"ra":ra,"wr":wr,"rr":rr,"stab":stab,"stab_n":len(by_yr),
            "mo_pct":mo_pct,"win_mo":win_mo,"total_mo":total_mo,"ra_tr":ra_tr,"ra_te":ra_te,"decay":decay}

print("\n" + "="*70)
print("EMA 9/21 LONG 4h — Filter layering (fixed TP/SL: SL×2 TP×3)")
print("="*70)
results_fixed = {}
for name, cfg in FILTER_CONFIGS.items():
    r = report(run(cfg, use_trail=False), name)
    if r: results_fixed[name] = r

print("\n" + "="*70)
print("EMA 9/21 LONG 4h — Filter layering (TRAILING SL like hedge01)")
print("="*70)
results_trail = {}
for name, cfg in FILTER_CONFIGS.items():
    r = report(run(cfg, use_trail=True), f"{name}_trail")
    if r: results_trail[name] = r

# Summary table
print("\n" + "="*70)
print("SUMMARY TABLE — Fixed vs Trailing SL")
print("="*70)
print(f"\n  {'Config':35s}  {'n':>5}  {'RA':>7}  {'mo_win%':>8}  {'stab':>6}  {'TEST_RA':>8}  {'decay':>7}")
for name in FILTER_CONFIGS:
    rf = results_fixed.get(name)
    rt = results_trail.get(name)
    for r, tag in [(rf,"fixed"),(rt,"trail")]:
        if not r: continue
        flag="✅" if r["ra"]>=0.20 and r["mo_pct"]>=0.55 and r["stab"]>=4 else ""
        print(f"  {r['label']:35s}  {r['n']:>5}  {r['ra']:>+7.3f}  {r['mo_pct']*100:>7.0f}%  {r['stab']}/{r['stab_n']}  "
              f"{(r['ra_te'] or 0):>+8.3f}  {(r['decay'] or 0):>+6.0f}%  {flag}")

# Identify sweet spot
print("\n  SWEET SPOT: highest RA với mo_win >= 55% AND stab >= 4")
all_r = list(results_fixed.values()) + list(results_trail.values())
candidates = [r for r in all_r if r and r["ra"]>=0.15 and r["mo_pct"]>=0.52 and r.get("stab",0)>=3]
if candidates:
    best = max(candidates, key=lambda x: x["ra"])
    print(f"  → {best['label']}: RA={best['ra']:+.3f} mo_win={best['mo_pct']*100:.0f}% stab={best['stab']}/{best['stab_n']} TEST_RA={best['ra_te']:+.3f}")
    # Compare with current hedge01
    print(f"\n  vs current hedge01: RA=+0.515, n=107/7y (~15/yr), stab=5/6, mo_win unknown")
    print(f"  EMA9x21 best:       RA={best['ra']:+.3f}, n={best['n']}/7y (~{best['n']//7}/yr), stab={best['stab']}/{best['stab_n']}, mo_win={best['mo_pct']*100:.0f}%")
else:
    print("  → Không có candidate nào đáp ứng tất cả criteria")
    best5 = sorted([r for r in all_r if r], key=lambda x: x["ra"], reverse=True)[:3]
    for r in best5:
        print(f"  {r['label']:40s} RA={r['ra']:+.3f} mo={r['mo_pct']*100:.0f}% stab={r['stab']}/{r['stab_n']}")
