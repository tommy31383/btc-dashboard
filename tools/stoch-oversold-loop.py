#!/usr/bin/env python3
"""
stoch-oversold-loop.py
Full grid: K_1h oversold + 6 regime gates
Regime: none | ema200 | adx | price_struct | funding | multitf_mom
"""
import json, datetime, itertools
from collections import defaultdict

CACHE   = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FUNDING = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/funding-rate-7y.json"
INITIAL = 100_000; POS_PCT = 0.10; FEE = 0.05/100

print("Loading...")
raw = json.load(open(CACHE)); raw.sort(key=lambda x: x['time'])
fnd = json.load(open(FUNDING)); fnd.sort(key=lambda x: x['fundingTime'])

def build_tf(ms):
    b = {}
    for c in raw:
        k = c["time"]//ms
        if k not in b: b[k]={"time":k*ms,"open":c["open"],"high":c["high"],
                              "low":c["low"],"close":c["close"],"volume":c.get("volume",0)}
        else:
            b[k]["high"]=max(b[k]["high"],c["high"]); b[k]["low"]=min(b[k]["low"],c["low"])
            b[k]["close"]=c["close"]; b[k]["volume"]+=c.get("volume",0)
    return [b[k] for k in sorted(b)]

bars1h = build_tf(3_600_000)
bars4h = build_tf(14_400_000)
print(f"  1h:{len(bars1h)}  4h:{len(bars4h)}")

# ── Indicators ────────────────────────────────────────────────────────────────
def rsi(src, p=14):
    out=[None]*len(src)
    if len(src)<=p: return out
    g=l=0.0
    for i in range(1,p+1):
        d=src[i]-src[i-1]
        if d>0: g+=d
        else: l-=d
    g/=p; l/=p; out[p]=100-100/(1+g/l) if l else 100.0
    for i in range(p+1,len(src)):
        d=src[i]-src[i-1]
        g=(g*(p-1)+max(d,0))/p; l=(l*(p-1)+max(-d,0))/p
        out[i]=100-100/(1+g/l) if l else 100.0
    return out

def stochrsi(src):
    r=rsi(src,14); n=len(r); rk=[None]*n
    for i in range(13,n):
        w=[x for x in r[i-13:i+1] if x is not None]
        if len(w)<14: continue
        lo,hi=min(w),max(w)
        rk[i]=50.0 if hi==lo else (r[i]-lo)/(hi-lo)*100
    K=[None]*n
    for i in range(2,n):
        w=[x for x in rk[i-2:i+1] if x is not None]
        if len(w)==3: K[i]=sum(w)/3
    D=[None]*n
    for i in range(2,n):
        w=[x for x in K[i-2:i+1] if x is not None]
        if len(w)==3: D[i]=sum(w)/3
    return K

def ema_ind(src, p):
    out=[None]*len(src); k=2/(p+1); e=None
    for i,x in enumerate(src):
        e=x if e is None else x*k+e*(1-k); out[i]=e
    return out

def adx_ind(blist, p=14):
    n=len(blist); pdm_sm=ndm_sm=tr_sm=0.0
    plus_di=[None]*n; minus_di=[None]*n; adx_out=[None]*n
    for i in range(1,n):
        h=blist[i]['high']; l=blist[i]['low']
        ph=blist[i-1]['high']; pl=blist[i-1]['low']; pc=blist[i-1]['close']
        tr=max(h-l, abs(h-pc), abs(l-pc))
        pdm=max(h-ph,0) if (h-ph)>(pl-l) else 0
        ndm=max(pl-l,0) if (pl-l)>(h-ph) else 0
        if i<=p:
            tr_sm+=tr; pdm_sm+=pdm; ndm_sm+=ndm
            if i==p:
                plus_di[i]=pdm_sm/tr_sm*100 if tr_sm else 0
                minus_di[i]=ndm_sm/tr_sm*100 if tr_sm else 0
        else:
            tr_sm=tr_sm-tr_sm/p+tr
            pdm_sm=pdm_sm-pdm_sm/p+pdm
            ndm_sm=ndm_sm-ndm_sm/p+ndm
            plus_di[i]=pdm_sm/tr_sm*100 if tr_sm else 0
            minus_di[i]=ndm_sm/tr_sm*100 if tr_sm else 0
    dx=[None]*n
    for i in range(p,n):
        if plus_di[i] is not None:
            s=plus_di[i]+minus_di[i]
            dx[i]=abs(plus_di[i]-minus_di[i])/s*100 if s else 0
    # smooth ADX
    adx_sm=[None]*n; sm=0; cnt=0
    for i in range(n):
        if dx[i] is None: continue
        cnt+=1; sm+=dx[i]
        if cnt==p: adx_out[i]=sm/p
        elif cnt>p:
            adx_out[i]=(adx_out[i-1]*(p-1)+dx[i])/p if adx_out[i-1] else dx[i]
    return adx_out, plus_di, minus_di

def sma(src,p):
    out=[None]*len(src)
    for i in range(p-1,len(src)):
        w=[x for x in src[i-p+1:i+1] if x is not None]
        if len(w)==p: out[i]=sum(w)/p
    return out

print("Computing indicators...")
c1h=[b['close'] for b in bars1h]; v1h=[b['volume'] for b in bars1h]
c4h=[b['close'] for b in bars4h]
K1h         = stochrsi(c1h)
K4h         = stochrsi(c4h)
ema200_1h   = ema_ind(c1h, 200)
adx_1h, pdi_1h, ndi_1h = adx_ind(bars1h, 14)
vol_ma1h    = sma(v1h, 20)
print("  done")

# Funding lookup: nearest funding at time t
fnd_times = [f['fundingTime'] for f in fnd]
fnd_rates = [f['fundingRate'] for f in fnd]
import bisect
def get_funding(t_ms):
    idx = bisect.bisect_right(fnd_times, t_ms) - 1
    if idx < 0: return None
    return fnd_rates[idx]

idx4h_map = {b['time']:i for i,b in enumerate(bars4h)}
def get_k4h(t_ms):
    bt=(t_ms//14_400_000)*14_400_000; i=idx4h_map.get(bt)
    return K4h[i] if i is not None else None

# ── Backtest ──────────────────────────────────────────────────────────────────
def backtest(thr1h, hold_h, cooldown_h, regime):
    equity=INITIAL; trades=[]; last_t=-999_999_999
    n=len(bars1h)
    WARM=220  # warmup bars

    for i in range(WARM, n - hold_h - 2):
        k=K1h[i]
        if k is None or k >= thr1h: continue
        t=bars1h[i]['time']
        if t - last_t < cooldown_h*3_600_000: continue

        price=bars1h[i]['close']

        # ── Regime gate ─────────────────────────────────────────────────────
        if regime == 'ema200':
            e=ema200_1h[i]
            if e is None or price < e: continue

        elif regime == 'adx':
            adx=adx_1h[i]; pd=pdi_1h[i]; nd=ndi_1h[i]
            if adx is None or pd is None: continue
            if adx < 20 or pd <= nd: continue

        elif regime == 'both_legacy':
            e=ema200_1h[i]
            if e is None or price < e: continue
            adx=adx_1h[i]; pd=pdi_1h[i]; nd=ndi_1h[i]
            if adx is None or pd is None: continue
            if adx < 20 or pd <= nd: continue

        elif regime == 'price_struct':
            # HH/HL: close > close 20h ago AND low > low 20h ago
            if i < 20: continue
            if price <= c1h[i-20]: continue
            if bars1h[i]['low'] <= bars1h[i-20]['low']: continue

        elif regime == 'funding':
            fr=get_funding(t)
            if fr is None: continue
            try: fr=float(fr)
            except: continue
            if fr <= 0: continue   # skip nếu funding âm/zero

        elif regime == 'multitf_mom':
            # 4h close > 4h close 5 bars ago (momentum 20h)
            k4t=(t//14_400_000)*14_400_000
            i4=idx4h_map.get(k4t)
            if i4 is None or i4 < 5: continue
            if c4h[i4] <= c4h[i4-5]: continue   # 4h đang xuống → skip

        # elif regime == 'none': pass (no filter)

        entry_price = price
        exit_i = i + hold_h
        if exit_i >= n: continue
        exit_price = bars1h[exit_i]['close']

        pnl = equity * POS_PCT * (exit_price-entry_price)/entry_price - equity*POS_PCT*FEE*2
        equity += pnl
        yr = datetime.datetime.utcfromtimestamp(t/1000).strftime('%Y')
        trades.append({"pnl":pnl,"win":pnl>0,"yr":yr})
        last_t = t

    if len(trades) < 15: return None
    total=sum(tr['pnl'] for tr in trades); wr=sum(1 for tr in trades if tr['win'])/len(trades)
    by_yr=defaultdict(float)
    for tr in trades: by_yr[tr['yr']]+=tr['pnl']
    pos_yrs=sum(1 for v in by_yr.values() if v>0); n_yrs=len(by_yr)
    stab=pos_yrs/n_yrs if n_yrs else 0
    peak=eq=INITIAL; max_dd=0
    for tr in trades:
        eq+=tr['pnl']; peak=max(peak,eq); max_dd=max(max_dd,peak-eq)
    ra=total/max_dd if max_dd>0 else 0
    return {"pnl":round(total,0),"wr":round(wr,3),"n":len(trades),
            "ra":round(ra,3),"stab":round(stab,2),"yr":dict(by_yr),
            "pos_yrs":pos_yrs,"n_yrs":n_yrs}

import math
def score(r):
    if r is None: return -999
    if r['n'] < 15 or r['stab'] < 0.625: return -999
    return r['pnl'] * r['stab'] * math.sqrt(r['n']/100)

# ── Parameter grid ────────────────────────────────────────────────────────────
THR1H    = [5, 8, 10, 12, 15, 20]
HOLD_H   = [24, 48, 72, 96]
COOLDOWN = [12, 24, 48, 72]
REGIMES  = ['none','ema200','adx','both_legacy','price_struct','funding','multitf_mom']

all_params = list(itertools.product(THR1H, HOLD_H, COOLDOWN, REGIMES))
print(f"Total combos: {len(all_params)}")

# ── Run full grid, track champion per regime ───────────────────────────────────
best_per_regime = {r: (None, -999) for r in REGIMES}
overall_champ   = (None, None, -999)
tested = 0

print(f"\n{'Iter':>5} {'thr':>4} {'hold':>5} {'cool':>5} {'regime':<14} | "
      f"{'PnL':>9} {'WR':>5} {'n':>5} {'RA':>6} {'stab':>5}")
print("-"*80)

for params in all_params:
    thr1h, hold_h, cooldown_h, regime = params
    r = backtest(thr1h, hold_h, cooldown_h, regime)
    s = score(r)
    tested += 1

    # track per regime
    if s > best_per_regime[regime][1]:
        best_per_regime[regime] = (params, s, r)
        if r:
            print(f"{tested:>5} {thr1h:>4} {hold_h:>5} {cooldown_h:>5} {regime:<14} | "
                  f"{r['pnl']:>9,.0f} {r['wr']:>5.1%} {r['n']:>5} {r['ra']:>6.2f} {r['stab']:>5.0%}  ← {regime}")

    # overall champ
    if s > overall_champ[2]:
        overall_champ = (params, r, s)

    if tested % 500 == 0:
        print(f"  ... {tested}/{len(all_params)}")

# ── Summary per regime ────────────────────────────────────────────────────────
print("\n" + "═"*100)
print("TỔNG KẾT — BEST COMBO CHO MỖI REGIME (stab ≥ 62.5%)")
print("═"*100)
print(f"{'Regime':<16} {'thr':>4} {'hold':>5} {'cool':>5} | {'PnL':>9} {'WR':>5} {'n':>5} {'RA':>6} {'stab':>5} | Per-year")
print("-"*100)

for regime in REGIMES:
    val = best_per_regime[regime]
    if val[0] is None or val[1]==-999:
        print(f"{regime:<16}  — no valid combo found")
        continue
    params, s, r = val
    thr1h, hold_h, cooldown_h, _ = params
    yr_str = " | ".join(f"{yr}:{'✓' if v>0 else '✗'}${abs(v/1000):.0f}k"
                         for yr,v in sorted(r['yr'].items()))
    print(f"{regime:<16} {thr1h:>4} {hold_h:>5} {cooldown_h:>5} | "
          f"{r['pnl']:>9,.0f} {r['wr']:>5.1%} {r['n']:>5} {r['ra']:>6.2f} {r['stab']:>5.0%} | {yr_str}")

print("\n" + "═"*100)
print("OVERALL CHAMPION")
print("═"*100)
params, r, s = overall_champ
if r:
    thr1h, hold_h, cooldown_h, regime = params
    print(f"  Regime={regime}  K_1h<{thr1h}  Hold={hold_h}h  Cooldown={cooldown_h}h")
    print(f"  PnL=${r['pnl']:,.0f}  WR={r['wr']:.1%}  n={r['n']}  RA={r['ra']:.3f}  Stab={r['stab']:.0%}")
    print(f"\n  Per-year:")
    for yr in sorted(r['yr']):
        v=r['yr'][yr]; sign="✓" if v>0 else "✗"
        print(f"    {yr}: {sign} ${v:>10,.0f}")
    print(f"\n  Năm dương: {r['pos_yrs']}/{r['n_yrs']}")

print(f"\nTổng tested: {tested}/{len(all_params)}")
print("Done.")
