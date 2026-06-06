#!/usr/bin/env python3
"""
stoch-overbought-short-loop.py
Backtest SHORT: K_4h > thr4h + K_1h > thr1h + K_1h < D_1h (momentum turn)
Full grid — judge PnL + WR + per-year stability
"""
import json, datetime, itertools
from collections import defaultdict

CACHE   = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
INITIAL = 100_000; POS_PCT = 0.10; FEE = 0.05/100

print("Loading...")
raw = json.load(open(CACHE)); raw.sort(key=lambda x: x['time'])

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
    return K, D

print("Computing indicators...")
c1h=[b['close'] for b in bars1h]
c4h=[b['close'] for b in bars4h]
K1h, D1h = stochrsi(c1h)
K4h, D4h = stochrsi(c4h)
print("  done")

idx4h={b['time']:i for i,b in enumerate(bars4h)}
def get_k4h(t_ms):
    bt=(t_ms//14_400_000)*14_400_000
    i=idx4h.get(bt)
    return K4h[i] if i is not None else None

import math

def backtest(thr1h_ob, thr4h_ob, require_kltd, hold_h, cooldown_h):
    """
    SHORT signal:
      K_1h > thr1h_ob  (overbought)
      K_4h > thr4h_ob  (confirm multi-TF)
      K_1h < D_1h      (momentum đang turn xuống) — nếu require_kltd=True
    Entry: short at close, exit after hold_h bars
    PnL = (entry - exit) / entry (short profit khi giá xuống)
    """
    equity=INITIAL; trades=[]; last_t=-999_999_999
    n=len(bars1h)

    for i in range(40, n - hold_h - 2):
        k1=K1h[i]; d1=D1h[i]
        if k1 is None: continue
        t=bars1h[i]['time']
        if t - last_t < cooldown_h*3_600_000: continue

        # K_1h overbought
        if k1 <= thr1h_ob: continue

        # K_4h overbought
        k4=get_k4h(t)
        if k4 is None or k4 <= thr4h_ob: continue

        # Momentum turn: K < D (đang quay đầu xuống)
        if require_kltd:
            if d1 is None or k1 >= d1: continue

        entry_price = bars1h[i]['close']
        exit_i = i + hold_h
        if exit_i >= n: continue
        exit_price = bars1h[exit_i]['close']

        # SHORT: profit khi giá xuống
        pnl_pct = (entry_price - exit_price) / entry_price
        pnl = equity * POS_PCT * pnl_pct - equity * POS_PCT * FEE * 2
        equity += pnl

        yr = datetime.datetime.utcfromtimestamp(t/1000).strftime('%Y')
        trades.append({"pnl":pnl,"win":pnl>0,"yr":yr,"t":t,
                        "entry":entry_price,"exit":exit_price,"pnl_pct":pnl_pct})
        last_t = t

    if len(trades) < 15: return None
    total=sum(tr['pnl'] for tr in trades)
    wr=sum(1 for tr in trades if tr['win'])/len(trades)
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
            "pos_yrs":pos_yrs,"n_yrs":n_yrs,"trades":trades}

def score(r):
    if r is None: return -999
    if r['n'] < 10: return -999
    # không filter stab — show thật để anh Tommy thấy
    return r['pnl'] * r['stab'] * math.sqrt(r['n']/100)

# ── Grid ──────────────────────────────────────────────────────────────────────
THR1H_OB  = [70, 75, 80, 85, 90]
THR4H_OB  = [70, 75, 80]
KLTD      = [True, False]          # require K < D
HOLD_H    = [12, 24, 48, 72]
COOLDOWN  = [12, 24, 48]

all_params = list(itertools.product(THR1H_OB, THR4H_OB, KLTD, HOLD_H, COOLDOWN))
print(f"Total combos: {len(all_params)}")

champion = (None, None, -999)
tested = 0

print(f"\n{'Iter':>5} {'K1h>':>5} {'K4h>':>5} {'K<D':>4} {'hold':>5} {'cool':>5} | "
      f"{'PnL':>9} {'WR':>5} {'n':>5} {'RA':>6} {'stab':>5}")
print("-"*75)

for params in all_params:
    thr1h, thr4h, kltd, hold_h, cool_h = params
    r = backtest(thr1h, thr4h, kltd, hold_h, cool_h)
    s = score(r)
    tested += 1

    if s > champion[2]:
        champion = (params, r, s)
        if r:
            print(f"{tested:>5} {thr1h:>5} {thr4h:>5} {'Y' if kltd else 'N':>4} "
                  f"{hold_h:>5} {cool_h:>5} | "
                  f"{r['pnl']:>9,.0f} {r['wr']:>5.1%} {r['n']:>5} "
                  f"{r['ra']:>6.2f} {r['stab']:>5.0%}  ★")

# ── Per-param summary: K<D vs không K<D ──────────────────────────────────────
print("\n" + "═"*90)
print("SO SÁNH: K<D (require turn) vs K>D (no turn filter)")
print("─"*90)
print(f"{'K<D':>4} {'K1h>':>5} {'K4h>':>5} {'hold':>5} {'cool':>5} | "
      f"{'PnL':>9} {'WR':>5} {'n':>5} {'RA':>6} {'stab':>5}")
print("-"*75)

best_kltd  = (None, -999)
best_nokltd = (None, -999)
for params in all_params:
    thr1h, thr4h, kltd, hold_h, cool_h = params
    r = backtest(thr1h, thr4h, kltd, hold_h, cool_h)
    s = score(r)
    if kltd and s > best_kltd[1]:  best_kltd  = (params, s, r)
    if not kltd and s > best_nokltd[1]: best_nokltd = (params, s, r)

for label, val in [("K<D=Y", best_kltd), ("K<D=N", best_nokltd)]:
    if val[0] is None: continue
    params, s, r = val
    thr1h, thr4h, kltd, hold_h, cool_h = params
    print(f"{label:>6} {thr1h:>5} {thr4h:>5} {hold_h:>5} {cool_h:>5} | "
          f"{r['pnl']:>9,.0f} {r['wr']:>5.1%} {r['n']:>5} {r['ra']:>6.2f} {r['stab']:>5.0%}")

# ── Champion report ───────────────────────────────────────────────────────────
print("\n" + "═"*90)
print("CHAMPION — BEST SHORT RULE")
print("═"*90)
params, r, s = champion
if r:
    thr1h, thr4h, kltd, hold_h, cool_h = params
    print(f"  K_1h > {thr1h}  +  K_4h > {thr4h}  +  K<D={'YES (turn)' if kltd else 'NO'}")
    print(f"  Hold={hold_h}h  Cooldown={cool_h}h")
    print(f"\n  PnL=${r['pnl']:,.0f}  WR={r['wr']:.1%}  n={r['n']}  RA={r['ra']:.3f}  Stab={r['stab']:.0%}")
    print(f"\n  Per-year:")
    for yr in sorted(r['yr']):
        v=r['yr'][yr]; sign="✓" if v>0 else "✗"
        bar="█"*min(40,int(abs(v)/1500))
        print(f"    {yr}: {sign} ${v:>10,.0f}  {bar}")
    print(f"\n  Năm dương: {r['pos_yrs']}/{r['n_yrs']}")

    # 2022 + 2026 detail
    for focus_yr in ["2022","2026"]:
        yr_trades=[tr for tr in r['trades'] if tr['yr']==focus_yr]
        if not yr_trades: continue
        wr_yr=sum(1 for tr in yr_trades if tr['win'])/len(yr_trades)
        pnl_yr=sum(tr['pnl'] for tr in yr_trades)
        print(f"\n  [{focus_yr}] n={len(yr_trades)}  WR={wr_yr:.1%}  PnL=${pnl_yr:,.0f}")
        print(f"  {'Date':<12} {'Entry':>9} {'Exit':>9} {'PnL%':>7} {'Result'}")
        print(f"  {'-'*55}")
        for tr in yr_trades[:30]:
            dt=datetime.datetime.utcfromtimestamp(tr['t']/1000).strftime('%Y-%m-%d %H:%M')
            res="WIN ✓" if tr['win'] else "LOSS✗"
            print(f"  {dt:<12} {tr['entry']:>9,.0f} {tr['exit']:>9,.0f} "
                  f"{tr['pnl_pct']*100:>+7.2f}% {res}")

print(f"\nTổng tested: {tested}/{len(all_params)}")
print("Done.")
