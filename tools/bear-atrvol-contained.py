#!/usr/bin/env python3
"""CONTAINED test (Codex-requested): does atr_pct beat close-stdev as the vol input to a
vol-target overlay on champion? CAUSAL (target_vol = median of IS-2019-22 vol, fixed, no OOS-own-mean
ex-post norm that caused the prior overclaim). Judge NET / maxDD / drop-top20, IS+OOS split.
Scaled net ≈ net × sizeMult (gross & fees scale ~linearly with qty). Comparison atr-vs-stdev is
robust to that approximation since both scale identically. Guard: report per-year + drop-top20 to
catch "improvement only from shrinking size into the big winners."
"""
import json, os, math, datetime as dt

TR = json.load(open('/tmp/bt_trades_champion_BEST_BTConly_BTC4h_TP16_champFr.json'))
H = json.load(open(os.path.expanduser('~/BTC_PC/btc-dashboard/.cache/binance-1h-7y.json')))

# daily OHLC
days = {}
for b in H:
    d = dt.datetime.utcfromtimestamp(b['time']/1000).strftime('%Y-%m-%d')
    o = days.get(d)
    if o is None: days[d] = {'h':b['high'],'l':b['low'],'c':b['close']}
    else: o['h']=max(o['h'],b['high']); o['l']=min(o['l'],b['low']); o['c']=b['close']
dl = sorted(days); didx = {d:i for i,d in enumerate(dl)}
C=[days[d]['c'] for d in dl]; Hi=[days[d]['h'] for d in dl]; Lo=[days[d]['l'] for d in dl]
n=len(C); ret=[0.0]+[(C[i]-C[i-1])/C[i-1] for i in range(1,n)]
tr=[0.0]*n
for i in range(1,n): tr[i]=max(Hi[i]-Lo[i],abs(Hi[i]-C[i-1]),abs(Lo[i]-C[i-1]))
def pstd(a):
    m=sum(a)/len(a); return math.sqrt(sum((v-m)**2 for v in a)/len(a))
# daily vol estimators (value AT day i, using bars up to i inclusive)
vol_std=[None]*n; vol_atr=[None]*n
for i in range(n):
    if i>=14:
        vol_std[i]=pstd(ret[i-13:i+1])*100
        vol_atr[i]=(sum(tr[i-13:i+1])/14)/C[i]*100

def day_idx_before(ts_ms):
    d=dt.datetime.utcfromtimestamp(ts_ms/1000).strftime('%Y-%m-%d')
    i=didx.get(d)
    if i is None:
        ds=[x for x in dl if x<d]; i=didx[ds[-1]] if ds else None
        return i
    return max(i-1,0)  # strictly before entry day

# IS-period (2019-22) medians = causal target_vol reference
def median(a):
    s=sorted(a); m=len(s); return s[m//2] if m%2 else (s[m//2-1]+s[m//2])/2
is_std=[vol_std[i] for i in range(n) if vol_std[i] and int(dl[i][:4])<=2022]
is_atr=[vol_atr[i] for i in range(n) if vol_atr[i] and int(dl[i][:4])<=2022]
TGT_STD=median(is_std); TGT_ATR=median(is_atr)

LO,HI=0.5,2.0  # size multiplier clamp (Codex: cannot just shrink into winners → bounded)
def clamp(x): return max(LO,min(HI,x))

rows=[]
for t in TR:
    i=day_idx_before(t['entryTime'])
    if i is None or vol_std[i] is None: continue
    yr=dt.datetime.utcfromtimestamp(t['entryTime']/1000).year
    s_std=clamp(TGT_STD/vol_std[i]); s_atr=clamp(TGT_ATR/vol_atr[i]); s_bl=0.5*s_std+0.5*s_atr
    rows.append({'yr':yr,'net':t['net'],'s_std':s_std,'s_atr':s_atr,'s_bl':s_bl})

def metrics(nets):
    tot=sum(nets); eq=0;peak=0;mdd=0
    for x in nets:
        eq+=x;peak=max(peak,eq);mdd=max(mdd,peak-eq)
    s=sorted(nets,reverse=True); drop20=sum(s[int(len(s)*0.2):])  # remove best 20%
    return tot,-mdd,drop20

def report(label, key):
    for lo,hi,tag in [(2019,2022,'IS'),(2023,2099,'OOS'),(2019,2099,'ALL')]:
        nets=[r['net']*(1 if key is None else r[key]) for r in rows if lo<=r['yr']<=hi]
        tot,mdd,d20=metrics(nets)
        print(f"  {label:<16} {tag:<4} NET=${tot:8.2f}  maxDD=${mdd:8.2f}  drop20=${d20:9.2f}  n={len(nets)}")

print(f"trades={len(rows)}  TGT_STD={TGT_STD:.3f}%  TGT_ATR={TGT_ATR:.3f}%  clamp[{LO},{HI}]")
print("(scaled net ≈ net×sizeMult; atr-vs-stdev comparison robust to this approx)\n")
report("baseline", None)
print()
report("VT close-stdev", 's_std')
print()
report("VT atr_pct", 's_atr')
print()
report("VT blend 50/50", 's_bl')
print("\nGuard: if a VT variant's NET gain comes with drop20 getting MORE negative vs baseline,")
print("it's shrinking-into-winners (fat-tail rebalanced into the scaled trades), not real risk-adj.")
