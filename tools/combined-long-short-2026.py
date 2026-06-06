#!/usr/bin/env python3
"""
combined-long-short-2026.py
Combine 2 rule 2026-optimized trên 1 equity account:
  LONG:  K_1h < 15 + multitf_mom bull + hold=36h + cooldown=12h
  SHORT: close < min(3h) + bearish + 4h confirm + multitf_mom bear + hold=9h + cooldown=6h

Test: 7y per-year, margin conflict, đồng thời LONG+SHORT không?
"""
import json, datetime, math
from collections import defaultdict

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
INITIAL = 100_000; POS_PCT = 0.10; FEE = 0.05/100

print("Loading...")
raw = json.load(open(CACHE)); raw.sort(key=lambda x: x['time'])

def build_tf(ms):
    b = {}
    for c in raw:
        k = c["time"]//ms
        if k not in b:
            b[k]={"time":k*ms,"open":c["open"],"high":c["high"],
                  "low":c["low"],"close":c["close"],"volume":c.get("volume",0)}
        else:
            b[k]["high"]=max(b[k]["high"],c["high"]); b[k]["low"]=min(b[k]["low"],c["low"])
            b[k]["close"]=c["close"]; b[k]["volume"]+=c.get("volume",0)
    return [b[k] for k in sorted(b)]

bars1h = build_tf(3_600_000)
bars4h = build_tf(14_400_000)

def sma(src,p):
    out=[None]*len(src)
    for i in range(p-1,len(src)):
        w=[x for x in src[i-p+1:i+1] if x is not None]
        if len(w)==p: out[i]=sum(w)/p
    return out

def ema_ind(src,p):
    out=[None]*len(src); k=2/(p+1); e=None
    for i,x in enumerate(src):
        e=x if e is None else x*k+e*(1-k); out[i]=e
    return out

def rsi(src,p=14):
    out=[None]*len(src)
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
    return K

print("Computing indicators...")
c1h = [b['close'] for b in bars1h]
o1h = [b['open']  for b in bars1h]
v1h = [b['volume'] for b in bars1h]
c4h = [b['close'] for b in bars4h]
K1h = stochrsi(c1h)
vol_ma = sma(v1h, 20)
idx4h  = {b['time']:i for i,b in enumerate(bars4h)}

def yr(t): return datetime.datetime.utcfromtimestamp(t/1000).strftime('%Y')
def mo(t): return datetime.datetime.utcfromtimestamp(t/1000).strftime('%Y-%m')
def dt_s(t): return datetime.datetime.utcfromtimestamp(t/1000).strftime('%m-%d %H:%M')
def sep(c='─',w=115): print(c*w)

def get_i4(t):
    bt=(t//14_400_000)*14_400_000
    return idx4h.get(bt)

# ══════════════════════════════════════════════════════════════
# 1. INDIVIDUAL BACKTESTS (standalone equity)
# ══════════════════════════════════════════════════════════════

def run_long(thr=15, hold_h=36, cool_h=12):
    equity=INITIAL; trades=[]; last_t=-999999999; n=len(bars1h)
    for i in range(40,n-hold_h-2):
        k=K1h[i]
        if k is None: continue
        t=bars1h[i]['time']
        if t-last_t < cool_h*3_600_000: continue
        if k > thr: continue
        i4=get_i4(t)
        if i4 is None or i4<5: continue
        if c4h[i4] <= c4h[i4-5]: continue   # bull gate
        entry=c1h[i]; ei=i+hold_h
        if ei>=n: continue
        pct=(c1h[ei]-entry)/entry
        pnl=equity*POS_PCT*pct - equity*POS_PCT*FEE*2
        equity+=pnl
        trades.append({"t":t,"side":"LONG","entry":entry,"exit":c1h[ei],
                        "pnl":pnl,"pct":pct,"win":pnl>0,"yr":yr(t),"mo":mo(t),
                        "hold":hold_h,"i":i,"ei":ei})
        last_t=t
    return trades

def run_short(lb=3, hold_h=9, cool_h=6):
    equity=INITIAL; trades=[]; last_t=-999999999; n=len(bars1h)
    for i in range(max(lb+5,25),n-hold_h-2):
        t=bars1h[i]['time']
        if t-last_t < cool_h*3_600_000: continue
        price=c1h[i]
        if price >= min(c1h[i-lb:i]): continue
        if price >= o1h[i]: continue
        i4=get_i4(t)
        if i4 is None or i4<5: continue
        if c4h[i4] >= c4h[i4-5]: continue   # bear gate
        # 4h confirm
        lb4=max(1,lb//4)
        if i4<lb4: continue
        if c4h[i4] >= c4h[i4-lb4]: continue
        entry=price; ei=i+hold_h
        if ei>=n: continue
        pct=(entry-c1h[ei])/entry
        pnl=equity*POS_PCT*pct - equity*POS_PCT*FEE*2
        equity+=pnl
        trades.append({"t":t,"side":"SHORT","entry":entry,"exit":c1h[ei],
                        "pnl":pnl,"pct":pct,"win":pnl>0,"yr":yr(t),"mo":mo(t),
                        "hold":hold_h,"i":i,"ei":ei})
        last_t=t
    return trades

def stats(trades, label=""):
    if not trades: return
    by_yr=defaultdict(float)
    for tr in trades: by_yr[tr['yr']]+=tr['pnl']
    pos=sum(1 for v in by_yr.values() if v>0)
    tot=sum(tr['pnl'] for tr in trades)
    wr=sum(1 for tr in trades if tr['win'])/len(trades)
    peak=eq=INITIAL; mdd=0
    for tr in sorted(trades,key=lambda x:x['t']):
        eq+=tr['pnl']; peak=max(peak,eq); mdd=max(mdd,peak-eq)
    ra=tot/mdd if mdd>0 else 0
    stab=pos/len(by_yr) if by_yr else 0
    print(f"  {label:<28} PnL=${tot:>9,.0f}  WR={wr:.1%}  n={len(trades):>5}  "
          f"RA={ra:>6.2f}  stab={stab:.0%} ({pos}/{len(by_yr)})")
    yr_s=" | ".join(f"{y}:{'✓' if v>0 else '✗'}${abs(v/1000):.0f}k" for y,v in sorted(by_yr.items()))
    print(f"  {' '*28} {yr_s}")
    return {"pnl":tot,"wr":wr,"n":len(trades),"ra":ra,"stab":stab,"by_yr":dict(by_yr),"mdd":mdd}

print("Running individual strategies...")
long_trades  = run_long()
short_trades = run_short()

sep('═')
print("1. STANDALONE PERFORMANCE")
sep('═')
sl = stats(long_trades,  "LONG  (K<15 hold36h cool12h)")
ss = stats(short_trades, "SHORT (lb3h hold9h cool6h)")

# ══════════════════════════════════════════════════════════════
# 2. COMBINED — SHARED EQUITY, 1 ACCOUNT
#    Conflict check: LONG open khi SHORT fire và ngược lại
# ══════════════════════════════════════════════════════════════

print()
sep('═')
print("2. COMBINED — SHARED EQUITY (cả 2 trên 1 account, check conflict)")
sep('═')

# Merge tất cả tín hiệu, sort by time, replay trên 1 equity
# Conflict = LONG đang open mà SHORT muốn vào (hoặc ngược lại)
# Policy: allow cả 2 (hedge), hoặc skip nếu opposite open

def run_combined(allow_hedge=False):
    """
    allow_hedge=True: vào cả LONG+SHORT cùng lúc (hedge mode)
    allow_hedge=False: skip SHORT khi LONG đang open và ngược lại
    """
    n=len(bars1h)
    # Build signal lists
    long_sigs=[]; last_lt=-999999999
    for i in range(40,n-36-2):
        k=K1h[i]
        if k is None: continue
        t=bars1h[i]['time']
        if t-last_lt < 12*3_600_000: continue
        if k > 15: continue
        i4=get_i4(t)
        if i4 is None or i4<5: continue
        if c4h[i4] <= c4h[i4-5]: continue
        long_sigs.append({"t":t,"i":i,"side":"LONG","hold":36})
        last_lt=t

    short_sigs=[]; last_st=-999999999
    for i in range(10,n-9-2):
        t=bars1h[i]['time']
        if t-last_st < 6*3_600_000: continue
        price=c1h[i]
        if price >= min(c1h[i-3:i]): continue
        if price >= o1h[i]: continue
        i4=get_i4(t)
        if i4 is None or i4<5: continue
        if c4h[i4] >= c4h[i4-5]: continue
        lb4=1
        if i4<lb4: continue
        if c4h[i4] >= c4h[i4-lb4]: continue
        short_sigs.append({"t":t,"i":i,"side":"SHORT","hold":9})
        last_st=t

    # Merge + replay
    all_sigs = sorted(long_sigs+short_sigs, key=lambda x: x['t'])
    equity=INITIAL; trades=[]; open_trades=[]

    for sig in all_sigs:
        t=sig['t']; i=sig['i']; side=sig['side']; hold=sig['hold']
        ei=i+hold
        if ei>=n: continue

        # Check open trades — close any that have expired
        still_open=[]
        for ot in open_trades:
            if t >= ot['exit_t']:
                pass  # expired before this signal — already counted
            else:
                still_open.append(ot)
        open_trades=still_open

        if not allow_hedge:
            # Skip if opposite side open
            opposite=[ot for ot in open_trades if ot['side']!=side]
            if opposite: continue

        entry=c1h[i]; exit_p=c1h[ei]
        if side=="LONG":
            pct=(exit_p-entry)/entry
        else:
            pct=(entry-exit_p)/entry
        pnl=equity*POS_PCT*pct - equity*POS_PCT*FEE*2
        equity+=pnl

        open_trades.append({"side":side,"exit_t":bars1h[ei]['time']})
        trades.append({"t":t,"side":side,"entry":entry,"exit":exit_p,
                        "pnl":pnl,"pct":pct,"win":pnl>0,
                        "yr":yr(t),"mo":mo(t)})

    return trades

trades_hedge   = run_combined(allow_hedge=True)
trades_nohedge = run_combined(allow_hedge=False)

print("  [Hedge mode: LONG+SHORT cùng lúc OK]")
sc = stats(trades_hedge, "combined hedge")
print()
print("  [No-hedge: skip opposite khi có open]")
snh = stats(trades_nohedge, "combined no-hedge")

# ══════════════════════════════════════════════════════════════
# 3. CONFLICT ANALYSIS — Bao nhiêu % LONG+SHORT overlap?
# ══════════════════════════════════════════════════════════════
sep('═')
print("3. OVERLAP ANALYSIS — LONG open khi SHORT fire (và ngược lại)")
sep('═')

# Build open intervals
long_intervals  = [(tr['t'], tr['t']+36*3_600_000) for tr in long_trades]
short_intervals = [(tr['t'], tr['t']+9*3_600_000)  for tr in short_trades]

# Count SHORT signals that overlap a LONG open
short_during_long=0
for str_t,_ in short_intervals:
    for lo,hi in long_intervals:
        if lo <= str_t < hi:
            short_during_long+=1; break

long_during_short=0
for lt,_ in long_intervals:
    for so,shi in short_intervals:
        if so <= lt < shi:
            long_during_short+=1; break

print(f"  SHORT signals while LONG open: {short_during_long}/{len(short_trades)} "
      f"({short_during_long/len(short_trades):.1%})")
print(f"  LONG signals while SHORT open: {long_during_short}/{len(long_trades)} "
      f"({long_during_short/len(long_trades):.1%})")

# Hedge những cái overlap — did they win or lose?
overlap_short=[]; overlap_long=[]
for tr in short_trades:
    for lo,hi in long_intervals:
        if lo <= tr['t'] < hi:
            overlap_short.append(tr); break
for tr in long_trades:
    for so,shi in short_intervals:
        if so <= tr['t'] < shi:
            overlap_long.append(tr); break

if overlap_short:
    wr_os=sum(1 for t in overlap_short if t['win'])/len(overlap_short)
    pnl_os=sum(t['pnl'] for t in overlap_short)
    print(f"\n  SHORT during LONG: n={len(overlap_short)}  WR={wr_os:.1%}  PnL=${pnl_os:,.0f}")
if overlap_long:
    wr_ol=sum(1 for t in overlap_long if t['win'])/len(overlap_long)
    pnl_ol=sum(t['pnl'] for t in overlap_long)
    print(f"  LONG during SHORT: n={len(overlap_long)}  WR={wr_ol:.1%}  PnL=${pnl_ol:,.0f}")

# ══════════════════════════════════════════════════════════════
# 4. PER-YEAR BREAKDOWN COMBINED vs INDIVIDUAL
# ══════════════════════════════════════════════════════════════
sep('═')
print("4. PER-YEAR SO SÁNH: LONG standalone vs SHORT standalone vs COMBINED")
sep('═')
def by_yr_map(trades):
    d=defaultdict(float)
    for tr in trades: d[tr['yr']]+=tr['pnl']
    return d

bl=by_yr_map(long_trades)
bs=by_yr_map(short_trades)
bc=by_yr_map(trades_hedge)

years=sorted(set(list(bl.keys())+list(bs.keys())))
print(f"  {'Year':<6} {'LONG':>9} {'SHORT':>9} {'SUM':>9} {'COMBINED':>10} {'Δ':>9}")
sep('─')
for y in years:
    l=bl.get(y,0); s=bs.get(y,0); c=bc.get(y,0)
    delta=c-(l+s)
    sign="+" if delta>=0 else ""
    print(f"  {y:<6} {l:>9,.0f} {s:>9,.0f} {l+s:>9,.0f} {c:>10,.0f}  {sign}{delta:,.0f}")

total_l=sum(bl.values()); total_s=sum(bs.values()); total_c=sum(bc.values())
print(f"  {'TOTAL':<6} {total_l:>9,.0f} {total_s:>9,.0f} {total_l+total_s:>9,.0f} {total_c:>10,.0f}  {total_c-(total_l+total_s):+,.0f}")

# ══════════════════════════════════════════════════════════════
# 5. MONTHLY 2026 BREAKDOWN
# ══════════════════════════════════════════════════════════════
sep('═')
print("5. MONTHLY 2026 — LONG vs SHORT vs COMBINED")
sep('═')

def by_mo_map(trades, focus_yr="2026"):
    d=defaultdict(lambda:{"pnl":0,"n":0,"win":0})
    for tr in trades:
        if tr['yr']!=focus_yr: continue
        d[tr['mo']]["pnl"]+=tr['pnl']; d[tr['mo']]["n"]+=1
        d[tr['mo']]["win"]+=(1 if tr['win'] else 0)
    return d

ml=by_mo_map(long_trades)
ms_=by_mo_map(short_trades)
mc=by_mo_map(trades_hedge)

months=sorted(set(list(ml.keys())+list(ms_.keys())))
print(f"  {'Month':<9} {'LONG$':>9} {'SHORT$':>8} {'COMBINED$':>10} | LONG_WR  SHORT_WR")
sep('─')
for m in months:
    l=ml[m]; s=ms_[m]; c=mc[m]
    lwr=f"{l['win']/l['n']:.0%}" if l['n'] else "  —"
    swr=f"{s['win']/s['n']:.0%}" if s['n'] else "  —"
    print(f"  {m:<9} {l['pnl']:>9,.0f} {s['pnl']:>8,.0f} {c['pnl']:>10,.0f} | {lwr:>7}  {swr:>8}")

# ══════════════════════════════════════════════════════════════
# 6. EQUITY CURVE 2026
# ══════════════════════════════════════════════════════════════
sep('═')
print("6. EQUITY CURVE 2026 — trade-by-trade cumulative PnL")
sep('═')

all_2026 = sorted(
    [tr for tr in trades_hedge if tr['yr']=="2026"],
    key=lambda x: x['t']
)
cum=0
print(f"  {'#':>3} {'Date':<14} {'Side':<6} {'Entry':>9} {'Exit':>9} {'PnL%':>7} {'PnL$':>8} {'Cum$':>9} R")
sep('─')
for idx_t, tr in enumerate(all_2026):
    cum+=tr['pnl']
    res="✓" if tr['win'] else "✗"
    bar=("▲"*min(15,int(abs(tr['pct'])*100))) if tr['side']=="LONG" else ("▼"*min(15,int(abs(tr['pct'])*100)))
    if not tr['win']: bar=bar.replace("▲","▽").replace("▼","△")
    print(f"  {idx_t+1:>3} {dt_s(tr['t']):<14} {tr['side']:<6} {tr['entry']:>9,.0f} "
          f"{tr['exit']:>9,.0f} {tr['pct']*100:>+7.2f}% {tr['pnl']:>8,.0f} "
          f"{cum:>9,.0f}  {res} {bar}")

sep('─')
print(f"  {'':3} {'2026 total':<14} {'':6} {'':9} {'':9} {'':7} {'':8} {cum:>9,.0f}")

sep('═')
print(f"""
SUMMARY TABLE
{'Strategy':<32} {'7y PnL':>10} {'2026':>8} {'WR':>6} {'RA':>7} {'stab':>6}
{'─'*70}
  LONG standalone             {total_l:>10,.0f} {bl.get('2026',0):>8,.0f}  {sum(1 for t in long_trades if t['win'])/len(long_trades):>5.1%} {sl['ra']:>7.2f}  {sl['stab']:>5.0%}
  SHORT standalone            {total_s:>10,.0f} {bs.get('2026',0):>8,.0f}  {sum(1 for t in short_trades if t['win'])/len(short_trades):>5.1%} {ss['ra']:>7.2f}  {ss['stab']:>5.0%}
  SUM (nếu tách account)      {total_l+total_s:>10,.0f} {bl.get('2026',0)+bs.get('2026',0):>8,.0f}
  COMBINED hedge (1 account)  {total_c:>10,.0f} {bc.get('2026',0):>8,.0f}
""")
print("Done.")
