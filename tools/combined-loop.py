#!/usr/bin/env python3
"""
combined-loop.py — Champion-challenger loop không ngừng
Combined LONG + SHORT (hedge mode) trên 1 equity account
Score = PnL × stab × sqrt(n/100)
Loop cho đến khi không còn improve
"""
import json, datetime, math, itertools
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
c4h = [b['close'] for b in bars4h]
K1h = stochrsi(c1h)
idx4h = {b['time']:i for i,b in enumerate(bars4h)}

def yr(t): return datetime.datetime.utcfromtimestamp(t/1000).strftime('%Y')
def sep(c='─',w=130): print(c*w)

def get_i4(t):
    return idx4h.get((t//14_400_000)*14_400_000)

# ── Core combined backtest ─────────────────────────────────────────────────
def run_combined(l_thr, l_hold, l_cool, s_lb, s_hold, s_cool):
    n = len(bars1h)

    # Build LONG signals
    long_sigs=[]; last_lt=-999999999
    for i in range(40, n-l_hold-2):
        k=K1h[i]
        if k is None: continue
        t=bars1h[i]['time']
        if t-last_lt < l_cool*3_600_000: continue
        if k > l_thr: continue
        i4=get_i4(t)
        if i4 is None or i4<5: continue
        if c4h[i4] <= c4h[i4-5]: continue
        long_sigs.append((t,i,"LONG",l_hold))
        last_lt=t

    # Build SHORT signals
    short_sigs=[]; last_st=-999999999
    for i in range(max(s_lb+3,10), n-s_hold-2):
        t=bars1h[i]['time']
        if t-last_st < s_cool*3_600_000: continue
        price=c1h[i]
        if price >= min(c1h[i-s_lb:i]): continue
        if price >= o1h[i]: continue
        i4=get_i4(t)
        if i4 is None or i4<5: continue
        if c4h[i4] >= c4h[i4-5]: continue
        lb4=max(1,s_lb//4)
        if i4<lb4: continue
        if c4h[i4] >= c4h[i4-lb4]: continue
        short_sigs.append((t,i,"SHORT",s_hold))
        last_st=t

    all_sigs = sorted(long_sigs+short_sigs, key=lambda x: x[0])
    if len(all_sigs)<50: return None

    equity=INITIAL; trades=[]; open_trades=[]
    for t,i,side,hold in all_sigs:
        ei=i+hold
        if ei>=n: continue
        # expire closed trades
        open_trades=[ot for ot in open_trades if t < ot[1]]
        entry=c1h[i]; exit_p=c1h[ei]
        if side=="LONG":
            pct=(exit_p-entry)/entry
        else:
            pct=(entry-exit_p)/entry
        pnl=equity*POS_PCT*pct - equity*POS_PCT*FEE*2
        equity+=pnl
        open_trades.append((side, bars1h[ei]['time']))
        trades.append((t,pnl,side,yr(t)))

    if len(trades)<100: return None
    by_yr=defaultdict(float)
    for _,p,_,y in trades: by_yr[y]+=p
    pos=sum(1 for v in by_yr.values() if v>0)
    n_yr=len(by_yr)
    stab=pos/n_yr if n_yr else 0
    tot=sum(p for _,p,_,_ in trades)
    wr=sum(1 for _,p,_,_ in trades if p>0)/len(trades)
    peak=eq=INITIAL; mdd=0
    for _,p,_,_ in trades:
        eq+=p; peak=max(peak,eq); mdd=max(mdd,peak-eq)
    ra=tot/mdd if mdd>0 else 0
    sc=tot*stab*math.sqrt(len(trades)/100)
    return {"pnl":tot,"wr":wr,"n":len(trades),"ra":ra,"stab":stab,
            "pos":pos,"n_yr":n_yr,"by_yr":dict(by_yr),"score":sc,"mdd":mdd}

def fmt_yr(by_yr):
    return " | ".join(f"{y}:{'✓' if v>0 else '✗'}${abs(v/1000):.0f}k"
                      for y,v in sorted(by_yr.items()))

# ── Grid definitions ────────────────────────────────────────────────────────
# LONG params
L_THR  = [8, 10, 12, 15, 20]
L_HOLD = [24, 36, 48, 72]
L_COOL = [12, 24]

# SHORT params
S_LB   = [2, 3, 4, 6]
S_HOLD = [6, 9, 12, 18]
S_COOL = [6, 9, 12]

all_combos = list(itertools.product(L_THR, L_HOLD, L_COOL, S_LB, S_HOLD, S_COOL))
total = len(all_combos)
print(f"Total combos: {total}")
print()

champion = None
champ_score = -999
champ_params = None
gen = 0
tested = 0
no_improve_rounds = 0
last_improve_at = 0

sep('═')
print(f"{'Gen':>5} {'#':>6} {'lthr':>5} {'lhd':>4} {'lcl':>4} | {'slb':>4} {'shd':>4} {'scl':>4} | "
      f"{'PnL':>9} {'WR':>5} {'n':>5} {'RA':>6} {'stab':>5} {'score':>12}")
print(f"{'':>5} {'':>6} {'':>5} {'':>4} {'':>4} | {'':>4} {'':>4} {'':>4} | "
      f"{'':>9} {'':>5} {'':>5} {'':>6} {'':>5} {'':>12}")
sep('─')

for lt, lh, lc, sl, sh, sc_ in all_combos:
    tested += 1
    r = run_combined(lt, lh, lc, sl, sh, sc_)
    if r is None: continue

    if r['score'] > champ_score:
        champ_score = r['score']
        champion = r
        champ_params = (lt, lh, lc, sl, sh, sc_)
        last_improve_at = tested
        gen += 1
        yr_s = fmt_yr(r['by_yr'])
        print(f"{gen:>5} {tested:>6} {lt:>5} {lh:>4} {lc:>4} | "
              f"{sl:>4} {sh:>4} {sc_:>4} | "
              f"{r['pnl']:>9,.0f} {r['wr']:>5.1%} {r['n']:>5} "
              f"{r['ra']:>6.2f} {r['stab']:>5.0%} {r['score']:>12,.0f}  ★")
        print(f"       {' '*36} {yr_s}")

    if tested % 500 == 0:
        print(f"  ... {tested}/{total} tested, champion score={champ_score:,.0f} ...")

sep('═')
print(f"\nTested all {tested} combos. Champion found at combo #{last_improve_at}:")
sep('═')

if champion:
    lt,lh,lc,sl,sh,sc_ = champ_params
    print(f"\n  LONG:  K_1h < {lt}  |  hold={lh}h  |  cooldown={lc}h  |  gate=multitf_mom")
    print(f"  SHORT: lb={sl}h  |  hold={sh}h  |  cooldown={sc_}h  |  gate=multitf_mom + bearish candle + 4h confirm")
    print(f"\n  PnL     = ${champion['pnl']:>10,.0f}")
    print(f"  WR      = {champion['wr']:.1%}")
    print(f"  n       = {champion['n']}")
    print(f"  RA      = {champion['ra']:.3f}")
    print(f"  MaxDD   = ${champion['mdd']:,.0f}")
    print(f"  Stab    = {champion['stab']:.0%}  ({champion['pos']}/{champion['n_yr']} năm dương)")
    print(f"  Score   = {champion['score']:,.0f}")
    print(f"\n  Per-year:")
    for y,v in sorted(champion['by_yr'].items()):
        sign="✓" if v>0 else "✗"
        bar="█"*min(50,int(abs(v)/1500))
        print(f"    {y}: {sign}  ${v:>10,.0f}  {bar}")

sep('═')
print("Done.")
