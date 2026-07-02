import json, statistics as st, datetime as dt, os
T=json.load(open('/tmp/bt_trades_champion_BEST_BTConly_BTC4h_TP16_champFr.json'))
h=json.load(open(os.path.expanduser('~/BTC_PC/btc-dashboard/.cache/binance-1h-7y.json')))
days={}
for b in h:
    t=b.get('time') or b.get('openTime'); d=dt.datetime.utcfromtimestamp(t/1000).strftime('%Y-%m-%d'); days[d]=b['close']
dl=sorted(days); dC=[days[d] for d in dl]; didx={d:i for i,d in enumerate(dl)}
def tvol(ts,N=14):
    d=dt.datetime.utcfromtimestamp(ts/1000).strftime('%Y-%m-%d'); i=didx.get(d)
    if i is None:
        ds=[x for x in dl if x<d]; i=didx[ds[-1]] if ds else None
    if i is None: return None
    i=max(i-1,0)
    if i<N+1: return None
    return st.pstdev([(dC[j]-dC[j-1])/dC[j-1]*100 for j in range(i-N+1,i+1)])
for t in T: t['vol']=tvol(t['entryTime']); t['yr']=dt.datetime.utcfromtimestamp(t['entryTime']/1000).year
T=[t for t in T if t['vol'] and t['vol']>0]
def metrics(nets):
    tot=sum(nets);eq=0;peak=0;mdd=0
    for x in nets: eq+=x;peak=max(peak,eq);mdd=max(mdd,peak-eq)
    return tot,mdd,(tot/mdd if mdd>0 else 0)
IS=[t for t in T if t['yr']<=2022]; OOS=[t for t in T if t['yr']>=2023]
def show(lab,ts):
    t,d,r=metrics([x['net'] for x in ts]); return f"{lab} tot ${t:.1f} DD ${d:.1f} ret/DD {r:.2f}"
print("BASELINE:")
print("  ",show("ALL",T)); print("  ",show("IS",IS)); print("  ",show("OOS",OOS))

targetVol=st.median([t['vol'] for t in IS])
def voltarget_neutral(ts, LO, HI):
    # raw multipliers then normalize so MEAN=1 (exposure-neutral: no net leverage)
    raw=[max(LO,min(HI,targetVol/t['vol'])) for t in ts]
    mean=st.mean(raw)
    return [t['net']*(m/mean) for t,m in zip(ts,raw)]
print("\nVOL-TARGET (EXPOSURE-NEUTRAL, mean mult=1 → pure timing, NO leverage):")
for LO,HI in [(0.5,2.0),(0.33,3.0)]:
    # normalize each segment by its OWN mean so exposure-neutral within segment
    for lab,ts in [('ALL',T),('IS',IS),('OOS',OOS)]:
        n=voltarget_neutral(ts,LO,HI); t,d,r=metrics(n)
        if lab=='ALL': print(f"  clamp[{LO},{HI}]:")
        print(f"     {lab}: tot ${t:.1f} DD ${d:.1f} ret/DD {r:.2f}")
