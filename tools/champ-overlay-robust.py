import json, statistics as st, datetime as dt, os
T0=json.load(open('/tmp/bt_trades_champion_BEST_BTConly_BTC4h_TP16_champFr.json'))
h=json.load(open(os.path.expanduser('~/BTC_PC/btc-dashboard/.cache/binance-1h-7y.json')))
days={}
for b in h:
    t=b.get('time') or b.get('openTime'); d=dt.datetime.utcfromtimestamp(t/1000).strftime('%Y-%m-%d'); days[d]=b['close']
dl=sorted(days); dC=[days[d] for d in dl]; didx={d:i for i,d in enumerate(dl)}
def tvol(ts,N):
    d=dt.datetime.utcfromtimestamp(ts/1000).strftime('%Y-%m-%d'); i=didx.get(d)
    if i is None:
        ds=[x for x in dl if x<d]; i=didx[ds[-1]] if ds else None
    if i is None: return None
    i=max(i-1,0)
    if i<N+1: return None
    return st.pstdev([(dC[j]-dC[j-1])/dC[j-1]*100 for j in range(i-N+1,i+1)])
def metrics(nets):
    tot=sum(nets);eq=0;peak=0;mdd=0
    for x in nets: eq+=x;peak=max(peak,eq);mdd=max(mdd,peak-eq)
    return tot,mdd,(tot/mdd if mdd>0 else 0)
print("ROBUSTNESS vol-window N (exposure-neutral clamp[0.33,3], targetVol=IS-median):")
print(f"{'N':>3} | {'OOS base ret/DD':>15} {'OOS VT ret/DD':>14} {'OOS DD base→VT':>16} | {'ALL base→VT':>14}")
for N in (7,14,21,30):
    T=[dict(t) for t in T0]
    for t in T: t['vol']=tvol(t['entryTime'],N); t['yr']=dt.datetime.utcfromtimestamp(t['entryTime']/1000).year
    T=[t for t in T if t['vol'] and t['vol']>0]
    IS=[t for t in T if t['yr']<=2022]; OOS=[t for t in T if t['yr']>=2023]
    tv=st.median([t['vol'] for t in IS])
    def vt(ts):
        raw=[max(0.33,min(3.0,tv/t['vol'])) for t in ts]; m=st.mean(raw)
        return [t['net']*(r/m) for t,r in zip(ts,raw)]
    ob=metrics([t['net'] for t in OOS]); ov=metrics(vt(OOS))
    ab=metrics([t['net'] for t in T]); av=metrics(vt(T))
    print(f"{N:>3} | {ob[2]:>15.2f} {ov[2]:>14.2f} {('$'+format(ob[1],'.0f')+'→$'+format(ov[1],'.0f')):>16} | {(format(ab[2],'.2f')+'→'+format(av[2],'.2f')):>14}")
