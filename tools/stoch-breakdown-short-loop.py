#!/usr/bin/env python3
"""
stoch-breakdown-short-loop.py
SHORT theo price breakdown:
  close < lowest close của N bars trước (break support)
  + optional: volume spike, bearish candle, 4h confirm
Full grid — judge PnL + WR + per-year
"""
import json, datetime, itertools
from collections import defaultdict
import math

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
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

def sma(src, p):
    out=[None]*len(src)
    for i in range(p-1,len(src)):
        w=[x for x in src[i-p+1:i+1] if x is not None]
        if len(w)==p: out[i]=sum(w)/p
    return out

FUNDING = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/funding-rate-7y.json"
fnd = json.load(open(FUNDING)); fnd.sort(key=lambda x: x['fundingTime'])
fnd_times=[f['fundingTime'] for f in fnd]; fnd_rates=[f['fundingRate'] for f in fnd]
import bisect
def get_funding(t):
    i=bisect.bisect_right(fnd_times,t)-1
    if i<0: return None
    try: return float(fnd_rates[i])
    except: return None

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
        tr=max(h-l,abs(h-pc),abs(l-pc))
        pdm=max(h-ph,0) if (h-ph)>(pl-l) else 0
        ndm=max(pl-l,0) if (pl-l)>(h-ph) else 0
        if i<=p:
            tr_sm+=tr; pdm_sm+=pdm; ndm_sm+=ndm
            if i==p:
                plus_di[i]=pdm_sm/tr_sm*100 if tr_sm else 0
                minus_di[i]=ndm_sm/tr_sm*100 if tr_sm else 0
        else:
            tr_sm=tr_sm-tr_sm/p+tr; pdm_sm=pdm_sm-pdm_sm/p+pdm; ndm_sm=ndm_sm-ndm_sm/p+ndm
            plus_di[i]=pdm_sm/tr_sm*100 if tr_sm else 0
            minus_di[i]=ndm_sm/tr_sm*100 if tr_sm else 0
    dx=[None]*n
    for i in range(p,n):
        if plus_di[i] is not None:
            s2=plus_di[i]+minus_di[i]; dx[i]=abs(plus_di[i]-minus_di[i])/s2*100 if s2 else 0
    adx_s=[None]*n; sm2=cnt=0
    for i in range(n):
        if dx[i] is None: continue
        cnt+=1; sm2+=dx[i]
        if cnt==p: adx_s[i]=sm2/p
        elif cnt>p: adx_s[i]=(adx_s[i-1]*(p-1)+dx[i])/p if adx_s[i-1] else dx[i]
    return adx_s, plus_di, minus_di

print("Computing indicators...")
c1h=[b['close'] for b in bars1h]
v1h=[b['volume'] for b in bars1h]
o1h=[b['open']  for b in bars1h]
c4h=[b['close'] for b in bars4h]
vol_ma    = sma(v1h, 20)
ema200_1h = ema_ind(c1h, 200)
adx_1h, pdi_1h, ndi_1h = adx_ind(bars1h)
idx4h  = {b['time']:i for i,b in enumerate(bars4h)}
print("  done")

def get_c4h(t_ms):
    bt=(t_ms//14_400_000)*14_400_000
    i=idx4h.get(bt)
    return c4h[i] if i is not None else None

def get_c4h_n(t_ms, n):
    bt=(t_ms//14_400_000)*14_400_000
    i=idx4h.get(bt)
    if i is None or i<n: return None
    return c4h[i-n]

def backtest(lookback_h, vol_mult, require_bearish, confirm_4h, hold_h, cooldown_h, regime='none'):
    """
    Signal SHORT:
      close_1h < min(close của lookback_h bars trước)  → break support
      vol_mult > 0: volume > vol_mult × MA20
      require_bearish: close < open (nến đỏ)
      confirm_4h: close_4h < close_4h[lookback_h//4 bars trước]
    """
    equity=INITIAL; trades=[]; last_t=-999_999_999
    n=len(bars1h)

    for i in range(max(lookback_h+5, 25), n - hold_h - 2):
        t=bars1h[i]['time']
        if t - last_t < cooldown_h*3_600_000: continue

        price = c1h[i]

        # Break support: close < min của lookback_h bars trước
        recent_min = min(c1h[i-lookback_h:i])
        if price >= recent_min: continue

        # Volume spike
        if vol_mult > 0:
            vm = vol_ma[i]
            if vm is None or v1h[i] < vol_mult * vm: continue

        # Bearish candle
        if require_bearish and price >= o1h[i]: continue

        # 4h confirm: 4h close cũng break
        if confirm_4h:
            c4_now = get_c4h(t)
            c4_prev = get_c4h_n(t, max(1, lookback_h//4))
            if c4_now is None or c4_prev is None: continue
            if c4_now >= c4_prev: continue

        # ── Regime gate (BEAR) ──────────────────────────────────────────────
        if regime == 'ema200':
            e=ema200_1h[i]
            if e is None or price > e: continue        # skip if above EMA200

        elif regime == 'adx_bear':
            adx=adx_1h[i]; pd=pdi_1h[i]; nd=ndi_1h[i]
            if adx is None or nd is None: continue
            if adx < 20 or nd <= pd: continue          # skip if weak or bullish DI

        elif regime == 'price_struct':
            # Lower High + Lower Low: price < 20h ago AND high < high 20h ago
            if i < 20: continue
            if price >= c1h[i-20]: continue
            if bars1h[i]['high'] >= bars1h[i-20]['high']: continue

        elif regime == 'multitf_mom':
            # 4h đang xuống: close_4h < close_4h 5 bars trước
            bt=(bars1h[i]['time']//14_400_000)*14_400_000
            i4=idx4h.get(bt)
            if i4 is None or i4 < 5: continue
            if c4h[i4] >= c4h[i4-5]: continue

        elif regime == 'funding_neg':
            fr=get_funding(bars1h[i]['time'])
            if fr is None or fr >= 0: continue        # skip nếu funding dương

        entry_price = price
        exit_i = i + hold_h
        if exit_i >= n: continue
        exit_price = c1h[exit_i]

        pnl_pct = (entry_price - exit_price) / entry_price
        pnl = equity * POS_PCT * pnl_pct - equity * POS_PCT * FEE * 2
        equity += pnl

        yr = datetime.datetime.utcfromtimestamp(t/1000).strftime('%Y')
        trades.append({"pnl":pnl,"win":pnl>0,"yr":yr,"t":t,
                        "entry":entry_price,"exit":exit_price,"pnl_pct":pnl_pct})
        last_t = t

    if len(trades) < 10: return None
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
    return r['pnl'] * r['stab'] * math.sqrt(r['n']/50)

LOOKBACK  = [6, 12, 24]
VOL_MULT  = [0, 1.5, 2.0]
BEARISH   = [True, False]
C4H       = [True, False]
HOLD_H    = [12, 24, 48]
COOLDOWN  = [12, 24]
REGIMES   = ['none','ema200','adx_bear','price_struct','multitf_mom','funding_neg']

all_params = list(itertools.product(LOOKBACK, VOL_MULT, BEARISH, C4H, HOLD_H, COOLDOWN, REGIMES))
print(f"Total combos: {len(all_params)}")

best_per_regime = {r: (None, -999) for r in REGIMES}
champion = (None, None, -999)
tested = 0

print(f"\n{'Iter':>5} {'lb':>4} {'vol':>5} {'br':>3} {'4h':>3} {'hd':>4} {'cl':>4} {'regime':<14} | "
      f"{'PnL':>9} {'WR':>5} {'n':>5} {'RA':>6} {'stab':>5}")
print("-"*90)

for params in all_params:
    lb, vol, bear, c4h_flag, hold_h, cool_h, regime = params
    r = backtest(lb, vol, bear, c4h_flag, hold_h, cool_h, regime)
    s = score(r)
    tested += 1

    if s > best_per_regime[regime][1]:
        best_per_regime[regime] = (params, s, r)

    if s > champion[2]:
        champion = (params, r, s)
        if r:
            print(f"{tested:>5} {lb:>4} {vol:>5} {'Y' if bear else 'N':>3} "
                  f"{'Y' if c4h_flag else 'N':>3} {hold_h:>4} {cool_h:>4} {regime:<14} | "
                  f"{r['pnl']:>9,.0f} {r['wr']:>5.1%} {r['n']:>5} "
                  f"{r['ra']:>6.2f} {r['stab']:>5.0%}  ★")

# ── Per-regime summary ───────────────────────────────────────────────────────
print("\n"+"═"*100)
print("BEST COMBO MỖI REGIME")
print(f"{'Regime':<16} {'lb':>4} {'vol':>5} {'br':>3} {'4h':>3} {'hd':>4} {'cl':>4} | "
      f"{'PnL':>9} {'WR':>5} {'n':>5} {'RA':>6} {'stab':>5} | Per-year")
print("-"*100)
for regime in REGIMES:
    val=best_per_regime[regime]
    if val[0] is None or val[1]==-999:
        print(f"{regime:<16}  — no valid combo"); continue
    params,s,r=val
    lb,vol,bear,c4h_flag,hold_h,cool_h,_=params
    yr_s=" | ".join(f"{yr}:{'✓' if v>0 else '✗'}${abs(v/1000):.0f}k"
                    for yr,v in sorted(r['yr'].items()))
    print(f"{regime:<16} {lb:>4} {vol:>5} {'Y' if bear else 'N':>3} {'Y' if c4h_flag else 'N':>3} "
          f"{hold_h:>4} {cool_h:>4} | "
          f"{r['pnl']:>9,.0f} {r['wr']:>5.1%} {r['n']:>5} {r['ra']:>6.2f} {r['stab']:>5.0%} | {yr_s}")

# ── Champion ──────────────────────────────────────────────────────────────────
print("\n"+"═"*90)
print("CHAMPION — SHORT BREAKDOWN")
print("═"*90)
params, r, s = champion
if r:
    lb, vol, bear, c4h_flag, hold_h, cool_h, regime = params
    print(f"  Break support: close < min(close, {lb}h lookback)")
    print(f"  Vol spike:  {'> '+str(vol)+'× MA20' if vol>0 else 'không dùng'}")
    print(f"  Bearish candle: {'YES' if bear else 'NO'}")
    print(f"  4h confirm: {'YES' if c4h_flag else 'NO'}")
    print(f"  Hold={hold_h}h  Cooldown={cool_h}h")
    print(f"\n  PnL=${r['pnl']:,.0f}  WR={r['wr']:.1%}  n={r['n']}  RA={r['ra']:.3f}  Stab={r['stab']:.0%}")
    print(f"\n  Per-year:")
    for yr in sorted(r['yr']):
        v=r['yr'][yr]; sign="✓" if v>0 else "✗"
        bar="█"*min(40,int(abs(v)/1200))
        print(f"    {yr}: {sign} ${v:>10,.0f}  {bar}")
    print(f"\n  Năm dương: {r['pos_yrs']}/{r['n_yrs']}")

    for fy in ["2022","2026"]:
        ftr=[tr for tr in r['trades'] if tr['yr']==fy]
        if not ftr: continue
        wr_y=sum(1 for tr in ftr if tr['win'])/len(ftr)
        pnl_y=sum(tr['pnl'] for tr in ftr)
        print(f"\n  [{fy}] n={len(ftr)}  WR={wr_y:.1%}  PnL=${pnl_y:,.0f}")
        for tr in ftr[:20]:
            dt=datetime.datetime.utcfromtimestamp(tr['t']/1000).strftime('%m-%d %H:%M')
            res="✓" if tr['win'] else "✗"
            print(f"    {dt}  entry={tr['entry']:>8,.0f}  exit={tr['exit']:>8,.0f}  "
                  f"{tr['pnl_pct']*100:>+6.2f}%  {res}")

print(f"\nTổng tested: {tested}/{len(all_params)}")
print("Done.")
