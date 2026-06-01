#!/usr/bin/env python3
"""compare-3rules-monthly-7y.py — Per-month n + ROI% cho hedge01 / hedge04 / hedge05"""
import json, datetime
from collections import defaultdict

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FEE   = 0.05 / 100

raw = json.load(open(CACHE)); raw.sort(key=lambda x: x["time"])

# ── Aggregate 5m → TF ────────────────────────────────────────────────────────
def agg(bars, ms):
    b = {}
    for c in bars:
        k = c["time"] // ms
        if k not in b:
            b[k] = {"time": k*ms, "open": c["open"], "high": c["high"],
                    "low": c["low"], "close": c["close"], "volume": c["volume"]}
        else:
            o = b[k]; o["high"] = max(o["high"],c["high"]); o["low"] = min(o["low"],c["low"])
            o["close"] = c["close"]; o["volume"] += c["volume"]
    return [b[k] for k in sorted(b)]

bars1h = agg(raw, 3600*1000)
bars4h = agg(raw, 4*3600*1000)
bars1d = agg(raw, 86400*1000)
n1h = len(bars1h); n4h = len(bars4h)
c1h = [b["close"] for b in bars1h]; c4h = [b["close"] for b in bars4h]

# ── Indicators ────────────────────────────────────────────────────────────────
def ema(xs, p):
    k=2/(p+1); out=[None]*len(xs); e=None
    for i,x in enumerate(xs): e=x if e is None else x*k+e*(1-k); out[i]=e
    return out

def _dtr(bars):
    n=len(bars); pdm=[0.]*n; ndm=[0.]*n; tr=[0.]*n
    for i in range(1,n):
        up=bars[i]["high"]-bars[i-1]["high"]; dn=bars[i-1]["low"]-bars[i]["low"]
        pdm[i]=up if up>dn and up>0 else 0; ndm[i]=dn if dn>up and dn>0 else 0
        tr[i]=max(bars[i]["high"]-bars[i]["low"],
                  abs(bars[i]["high"]-bars[i-1]["close"]),
                  abs(bars[i]["low"] -bars[i-1]["close"]))
    return pdm, ndm, tr

def adx_w(bars, p=14):
    pdm,ndm,tr=_dtr(bars); n=len(bars)
    smTR=sum(tr[1:p+1]); smPDM=sum(pdm[1:p+1]); smNDM=sum(ndm[1:p+1])
    dx_arr=[]; adv=None; out=[None]*n
    for i in range(p+1,n):
        smTR=smTR-smTR/p+tr[i]; smPDM=smPDM-smPDM/p+pdm[i]; smNDM=smNDM-smNDM/p+ndm[i]
        pdi=smPDM/smTR*100 if smTR>0 else 0; ndi=smNDM/smTR*100 if smTR>0 else 0
        dx=abs(pdi-ndi)/(pdi+ndi)*100 if (pdi+ndi)>0 else 0; dx_arr.append(dx)
        if len(dx_arr)<p: continue
        elif len(dx_arr)==p: adv=sum(dx_arr)/p
        else: adv=(adv*(p-1)+dx)/p
        out[i]=adv
    return out

def atr_w(bars, p=14):
    _,_,tr=_dtr(bars); n=len(bars); out=[None]*n
    s=sum(tr[1:p+1]); out[p]=s/p
    for i in range(p+1,n): out[i]=(out[i-1]*(p-1)+tr[i])/p
    return out

def rsi_s(cls, n=14):
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

def stoch_s(bars, n=14):
    out=[None]*len(bars)
    for i in range(n-1,len(bars)):
        hi=max(b["high"] for b in bars[i-n+1:i+1]); lo=min(b["low"] for b in bars[i-n+1:i+1])
        out[i]=100*(bars[i]["close"]-lo)/(hi-lo) if hi>lo else 50
    return out

def bb_s(cls, n=20, k=2.):
    u=[None]*len(cls); l=[None]*len(cls)
    for i in range(n-1,len(cls)):
        w=cls[i-n+1:i+1]; m=sum(w)/n; s=(sum((x-m)**2 for x in w)/n)**0.5
        u[i]=m+k*s; l[i]=m-k*s
    return u, l

def vol_ma(bars, p=10):
    out=[None]*len(bars)
    for i in range(p-1,len(bars)):
        out[i]=sum(bars[j]["volume"] for j in range(i-p+1,i+1))/p
    return out

def regime_wp(bars1d, persist=3):
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

def don_hi(bars, p=20):
    out=[None]*len(bars)
    for i in range(p,len(bars)): out[i]=max(bars[j]["high"] for j in range(i-p,i))
    return out

print("Computing indicators...")
adx4  = adx_w(bars4h); atr4 = atr_w(bars4h)
e50_4h = ema(c4h,50); e200_4h = ema(c4h,200)
dh20_4h = don_hi(bars4h,20); vma10_4h = vol_ma(bars4h,10)
atr1h  = atr_w(bars1h); rsi1h = rsi_s(c1h); stk1h = stoch_s(bars1h)
e200_1h = ema(c1h,200); bbu, bbl = bb_s(c1h)
rsi1h_arr = rsi_s(c1h)
# 1d EMA200 for bear gate (hedge05)
e200_1d = ema([b["close"] for b in bars1d], 200)
reg1d  = regime_wp(bars1d)
reg_map = {}
for i,b in enumerate(bars1d): reg_map[b["time"]//86400000] = reg1d[i]
ATR_LB = 90
ts4h_arr = [b["time"] for b in bars4h]
ts1h_arr = [b["time"] for b in bars1h]

def get_reg(ts): return reg_map.get(ts//86400000, "RANGE")

def get_4h_idx(ts):
    k=ts//(4*3600*1000); lo,hi,idx=0,len(ts4h_arr)-1,0
    while lo<=hi:
        m=(lo+hi)//2
        if ts4h_arr[m]//(4*3600*1000)<=k: idx=m; lo=m+1
        else: hi=m-1
    return idx

def e200_1h_at(ts):
    lo,hi,idx=0,len(ts1h_arr)-1,0
    while lo<=hi:
        m=(lo+hi)//2
        if ts1h_arr[m]<=ts: idx=m; lo=m+1
        else: hi=m-1
    return e200_1h[idx]

# 4h context: RANGE + ADX>20 sticky + ATR>=pct-ile + EMA200_1h
def ctx4h_ok(i4h, pct=0.50):
    if i4h < 50: return False
    if get_reg(bars4h[i4h]["time"]) != "RANGE": return False
    adv=adx4[i4h]; adv_p=adx4[i4h-1] if i4h>0 else None
    if adv is None or adv<=20 or adv_p is None or adv_p<=20: return False
    if pct > 0:
        if i4h < ATR_LB+14: return False
        vs=[atr4[j]/c4h[j] for j in range(i4h-ATR_LB,i4h) if atr4[j] and c4h[j]]
        if len(vs) < ATR_LB: return False
        cur=atr4[i4h]/c4h[i4h] if atr4[i4h] and c4h[i4h] else None
        return cur is not None and cur>=sorted(vs)[int(len(vs)*pct)]
    return True

print("Precomputing 4h contexts...")
ctx50 = [ctx4h_ok(i,0.50) for i in range(n4h)]
ctx35 = [ctx4h_ok(i,0.35) for i in range(n4h)]

def filt_1h(i, ctx):
    e1h = e200_1h[i]
    if e1h and c1h[i] < e1h: return False
    i4h = get_4h_idx(bars1h[i]["time"])
    return 0 <= i4h < n4h and ctx[i4h]

def ts_to_mo(ts):
    dt = datetime.datetime.utcfromtimestamp(ts/1000)
    return dt.year*100 + dt.month, dt.year

# ── hedge01: S12/S13/S14 RANGE+ADX+ATR50 trailing SL ────────────────────────
def sim_trail_4h(ei):
    ep=c4h[ei]; ae=atr4[ei]
    if not ae or ae<=0: return None
    sl=ep-ae*4.; hwm=ep
    for h in range(1,201):
        j=ei+h
        if j>=n4h: break
        mult = 4. if h < 24 else 3.
        if c4h[j] > hwm: hwm=c4h[j]; sl=hwm-ae*mult
        elif h >= 24:
            t=hwm-ae*3.
            if t > sl: sl=t
        if bars4h[j]["low"] <= sl: return (sl-ep)/ep-2*FEE
    j2=min(ei+200, n4h-1)
    return (c4h[j2]-ep)/ep-2*FEE

def run_hedge01():
    trades = []; last = {"S12":-200,"S13":-1,"S14":-200}
    dh20 = don_hi(bars4h, 20)
    for i in range(100, n4h-200):
        if not ctx50[i]: continue
        e1h = e200_1h_at(bars4h[i]["time"])
        if e1h and c4h[i] < e1h: continue
        ts=bars4h[i]["time"]; mo,yr=ts_to_mo(ts)
        # S13 ATR breakout
        if atr4[i] and i>0 and c4h[i]>bars4h[i-1]["close"]+atr4[i]*1.2 and i-last["S13"]>=1:
            if vma10_4h[i] and bars4h[i]["volume"]>=vma10_4h[i]*1.2:
                r=sim_trail_4h(i)
                if r is not None: trades.append({"ret":r,"mo":mo,"yr":yr}); last["S13"]=i
        # S14 Donchian
        if dh20[i] and c4h[i]>dh20[i] and i-last["S14"]>=200:
            r=sim_trail_4h(i)
            if r is not None: trades.append({"ret":r,"mo":mo,"yr":yr}); last["S14"]=i
        # S12 EMA cross
        if e50_4h[i] and e200_4h[i] and e50_4h[i-1] and e200_4h[i-1]:
            if e50_4h[i-1]<=e200_4h[i-1] and e50_4h[i]>e200_4h[i] and i-last["S12"]>=200:
                r=sim_trail_4h(i)
                if r is not None: trades.append({"ret":r,"mo":mo,"yr":yr}); last["S12"]=i
    return trades

# ── hedge04: 1h BB+RSI+Stoch  RANGE+ADX+ATR35+EMA200_1h ─────────────────────
def sim_long_1h(i, sl_m, tp_m, max_h=24):
    ep=c1h[i]; ae=atr1h[i]
    if ae is None or ae<=0: return None
    sl=ep-ae*sl_m; tp=ep+ae*tp_m
    for h in range(1, max_h+1):
        j=i+h
        if j>=n1h: break
        if bars1h[j]["low"]<=sl: return (sl-ep)/ep-2*FEE
        if bars1h[j]["high"]>=tp: return (tp-ep)/ep-2*FEE
    j2=min(i+max_h, n1h-1)
    return (c1h[j2]-ep)/ep-2*FEE

def run_hedge04():
    trades=[]; lb=-2; lr=-2; ls=-2
    for i in range(50, n1h-48):
        if not filt_1h(i, ctx35): continue
        ts=bars1h[i]["time"]; mo,yr=ts_to_mo(ts)
        # S04B: BB lower touch + bullish close
        if bbl[i] and bars1h[i]["low"]<=bbl[i] and c1h[i]>bars1h[i]["open"] and i-lb>=2:
            r=sim_long_1h(i, 2., 1.5)
            if r is not None: trades.append({"ret":r,"mo":mo,"yr":yr}); lb=i
        # S04R: RSI cross above 40
        if rsi1h[i] and rsi1h[i-1] and rsi1h[i-1]<40 and rsi1h[i]>=40 and i-lr>=2:
            r=sim_long_1h(i, 2., 1.0)
            if r is not None: trades.append({"ret":r,"mo":mo,"yr":yr}); lr=i
        # S04K: Stoch cross above 20
        if stk1h[i] and stk1h[i-1] and stk1h[i-1]<20 and stk1h[i]>=20 and i-ls>=2:
            r=sim_long_1h(i, 2., 1.0)
            if r is not None: trades.append({"ret":r,"mo":mo,"yr":yr}); ls=i
    return trades

# ── hedge05: RSI<35 cross → grid rescue, NOT-BEAR regime gate ────────────────
# Params from probe-hedge05-rescue-7y.mjs GRID_FLAT winner (RA+1.03)
G    = 1.2   # arithmetic grid spacing (×ATR per level)
N    = 3     # max adds (4 total legs)
TP2  = 0.3   # TP = avg_cost + TP2×ATR_at_entry
H    = 7.0   # hard stop = first_entry - H×ATR_at_entry

def run_hedge05():
    trades = []
    active = None   # current open campaign
    for i in range(50, n1h-1):
        bar  = bars1h[i]
        ts   = bar["time"]
        mo, yr = ts_to_mo(ts)
        price  = bar["close"]
        atr    = atr1h[i]
        if atr is None or atr <= 0: continue

        # ── Close open campaign ──────────────────────────────────────────
        if active is not None:
            a = active
            # Recompute TP from current avg_cost
            tp_px  = a["avg_cost"] + TP2 * a["atr0"]
            sl_px  = a["first_entry"] - H * a["atr0"]
            # Check hard-stop (bar low)
            if bar["low"] <= sl_px:
                pnl_pct = (sl_px - a["avg_cost"]) / a["first_entry"] - 2*FEE*a["n_legs"]
                trades.append({"ret": pnl_pct, "mo": a["mo"], "yr": a["yr"]})
                active = None; continue
            # Check TP hit
            if bar["high"] >= tp_px:
                pnl_pct = (tp_px - a["avg_cost"]) / a["first_entry"] - 2*FEE*a["n_legs"]
                trades.append({"ret": pnl_pct, "mo": a["mo"], "yr": a["yr"]})
                active = None; continue
            # Check grid add levels (bar low touches next level)
            while a["adds"] < N:
                next_lvl = a["first_entry"] - (a["adds"]+1) * G * a["atr0"]
                if bar["low"] <= next_lvl:
                    a["total_cost"] += next_lvl
                    a["n_legs"]     += 1
                    a["adds"]       += 1
                    a["avg_cost"]    = a["total_cost"] / a["n_legs"]
                else:
                    break
            continue  # campaign still open

        # ── Open new campaign on RSI<35 cross ────────────────────────────
        # Gate: NOT BEAR regime only (no EMA200 1h — oversold entry should allow dips below EMA)
        if get_reg(ts) == "BEAR": continue
        # RSI cross below 35 (prev >= 35, cur < 35)
        if rsi1h_arr[i] is None or rsi1h_arr[i-1] is None: continue
        if rsi1h_arr[i-1] < 35 or rsi1h_arr[i] >= 35: continue
        # Open campaign
        active = {
            "first_entry": price,
            "avg_cost":    price,
            "total_cost":  price,
            "n_legs":      1,
            "adds":        0,
            "atr0":        atr,
            "mo":          mo,
            "yr":          yr,
        }

    return trades

# ── Run all 3 ────────────────────────────────────────────────────────────────
print("Running hedge01..."); h01 = run_hedge01()
print("Running hedge04..."); h04 = run_hedge04()
print("Running hedge05..."); h05 = run_hedge05()

# ── Per-month aggregation ─────────────────────────────────────────────────────
def by_month(trades):
    d = defaultdict(list)
    for t in trades: d[t["mo"]].append(t["ret"])
    return d

mo01 = by_month(h01); mo04 = by_month(h04); mo05 = by_month(h05)
all_months = sorted(set(list(mo01.keys()) + list(mo04.keys()) + list(mo05.keys())))

MN = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]

print()
print("="*110)
print("COMPARISON: hedge01 (4h trend) | hedge04 (1h mean-rev) | hedge05 (1h grid rescue)")
print("="*110)
print(f"{'':10s}  {'── H01 ──':>14s}  {'── H04 ──':>14s}  {'── H05 ──':>14s}  {'Combined':>9s}")
print(f"{'Yr Mon':10s}  {'n':>3s} {'ROI%':>8s}  {'n':>3s} {'ROI%':>8s}  {'n':>3s} {'ROI%':>8s}  {'ROI%':>9s}")
print("─"*110)

by_yr = defaultdict(lambda: {"h01":0,"h04":0,"h05":0,"comb":0,"n01":0,"n04":0,"n05":0,"mo_win":0,"mo_tot":0})

for mo in all_months:
    yr = mo // 100; mn = mo % 100
    t01=mo01.get(mo,[]); t04=mo04.get(mo,[]); t05=mo05.get(mo,[])
    r01=sum(t01)*100; r04=sum(t04)*100; r05=sum(t05)*100
    comb = r01 + r04 + r05
    s = by_yr[yr]
    s["h01"]+=r01; s["h04"]+=r04; s["h05"]+=r05; s["comb"]+=comb
    s["n01"]+=len(t01); s["n04"]+=len(t04); s["n05"]+=len(t05)
    s["mo_win"]+=(1 if comb>0 else 0); s["mo_tot"]+=1

    flag01="✅" if r01>0 else ("❌" if t01 else "  ")
    flag04="✅" if r04>0 else ("❌" if t04 else "  ")
    flag05="✅" if r05>0 else ("❌" if t05 else "  ")
    flagC ="✅" if comb>0 else ("❌" if (t01 or t04 or t05) else "  ")
    print(f"  {yr:4d} {MN[mn-1]:>3s}  "
          f"{len(t01):>3d} {r01:>+7.1f}%{flag01}  "
          f"{len(t04):>3d} {r04:>+7.1f}%{flag04}  "
          f"{len(t05):>3d} {r05:>+7.1f}%{flag05}  "
          f"{comb:>+8.1f}%{flagC}")

print("─"*110)
print(f"\n{'Year':>6s}  {'H01_n':>6s} {'H01_ROI':>8s}  {'H04_n':>6s} {'H04_ROI':>8s}  {'H05_n':>6s} {'H05_ROI':>8s}  {'Combined':>9s}  {'MonthlyWin':>10s}")
for yr in sorted(by_yr):
    s=by_yr[yr]
    print(f"  {yr:4d}   {s['n01']:5d}  {s['h01']:>+7.1f}%   {s['n04']:5d}  {s['h04']:>+7.1f}%   {s['n05']:5d}  {s['h05']:>+7.1f}%   {s['comb']:>+8.1f}%   {s['mo_win']:2d}/{s['mo_tot']:2d} ({s['mo_win']/s['mo_tot']*100:.0f}%)")

# Totals
t01_all=len(h01); t04_all=len(h04); t05_all=len(h05)
r01_t=sum(t["ret"] for t in h01)*100; r04_t=sum(t["ret"] for t in h04)*100; r05_t=sum(t["ret"] for t in h05)*100
total_mo = len(all_months); win_mo=sum(1 for mo in all_months if sum(mo01.get(mo,[])+mo04.get(mo,[])+mo05.get(mo,[]))>0)
n_yrs = len(by_yr)
print(f"\n{'─'*110}")
print(f"  TOTAL  n={t01_all}({t01_all//n_yrs}/yr) ROI={r01_t:+.1f}% | n={t04_all}({t04_all//n_yrs}/yr) ROI={r04_t:+.1f}% | n={t05_all}({t05_all//n_yrs}/yr) ROI={r05_t:+.1f}%")
print(f"  COMBINED ROI: {r01_t+r04_t+r05_t:+.1f}%  |  Monthly win: {win_mo}/{total_mo} = {win_mo/total_mo*100:.0f}%")

# Per-rule RA
def ra(trades):
    if len(trades)<5: return None
    r=[t["ret"] for t in trades]; m=sum(r)/len(r); s=(sum((x-m)**2 for x in r)/len(r))**0.5
    return m/s if s>0 else 0

print(f"  RA: H01={ra(h01):.3f}  H04={ra(h04):.3f}  H05={ra(h05):.3f}")
