import json, datetime as dt
from collections import defaultdict

CACHE = __import__('os').path.expanduser('~/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json')
bars = json.load(open(CACHE))

# resample 5m -> daily OHLC
days = {}
for b in bars:
    d = dt.datetime.utcfromtimestamp(b['time']/1000).strftime('%Y-%m-%d')
    if d not in days:
        days[d] = {'o':b['open'],'h':b['high'],'l':b['low'],'c':b['close'],'v':b['volume']}
    else:
        x=days[d]; x['h']=max(x['h'],b['high']); x['l']=min(x['l'],b['low']); x['c']=b['close']; x['v']+=b['volume']
dates = sorted(days)
O=[days[d]['o'] for d in dates]; H=[days[d]['h'] for d in dates]
L=[days[d]['l'] for d in dates]; C=[days[d]['c'] for d in dates]; V=[days[d]['v'] for d in dates]
n=len(dates)
print(f"daily bars: {n}  {dates[0]} -> {dates[-1]}")

# ATR14 daily
def atr(i,p=14):
    if i<1: return H[i]-L[i]
    trs=[]
    for j in range(max(1,i-p+1),i+1):
        tr=max(H[j]-L[j], abs(H[j]-C[j-1]), abs(L[j]-C[j-1])); trs.append(tr)
    return sum(trs)/len(trs)

# Define major bottoms = local min of close over +-30 day window AND drawdown from trailing-180d peak >= 25%
def trailing_peak(i,w=180):
    return max(H[max(0,i-w):i+1])
bottoms=[]
W=30
for i in range(W, n-W):
    lo = min(L[i-W:i+W+1])
    if L[i]==lo:  # is the lowest low in +-30d window
        pk = trailing_peak(i)
        dd = (C[i]-pk)/pk
        if dd <= -0.25:
            bottoms.append(i)
# collapse bottoms within 45 days, keep the lowest
filtered=[]
for i in bottoms:
    if filtered and dates_to_idx_gap(dates[filtered[-1]],dates[i]) if False else (filtered and (i-filtered[-1])<45):
        if L[i] < L[filtered[-1]]: filtered[-1]=i
    else:
        filtered.append(i)
print("\nMAJOR BEAR BOTTOMS (DD>=25% from 180d peak, local min +-30d):")
print(f"{'date':12} {'low':>9} {'DDfromPeak':>11} {'RSI14':>6} {'StochK':>7} {'ATR%':>6}")

def rsi(i,p=14):
    if i<p: return 50.0
    gains=losses=0
    for j in range(i-p+1,i+1):
        ch=C[j]-C[j-1]
        if ch>=0: gains+=ch
        else: losses-=ch
    if losses==0: return 100.0
    rs=(gains/p)/(losses/p); return 100-100/(1+rs)

for i in filtered:
    pk=trailing_peak(i); dd=(L[i]-pk)/pk*100
    a=atr(i); atrp=a/C[i]*100
    print(f"{dates[i]:12} {L[i]:>9.0f} {dd:>10.1f}% {rsi(i):>6.1f} {'-':>7} {atrp:>5.1f}%")

# Save for next step
import pickle
pickle.dump({'dates':dates,'O':O,'H':H,'L':L,'C':C,'V':V,'bottoms':filtered}, open('/private/tmp/claude-501/-Users-lap16116-BTC-PC/07bf9375-e97e-466b-be9c-89f8c4bbd644/scratchpad/daily.pkl','wb'))
