import json, statistics as st, datetime as dt, os
T=json.load(open('/tmp/bt_trades_champion_BEST_BTConly_BTC4h_TP16_champFr.json'))
# daily closes for trailing vol (use 1h-7y -> daily)
h=json.load(open(os.path.expanduser('~/BTC_PC/btc-dashboard/.cache/binance-1h-7y.json')))
days={}
for b in h:
    t=b.get('time') or b.get('openTime')
    d=dt.datetime.utcfromtimestamp(t/1000).strftime('%Y-%m-%d')
    days[d]=b['close']  # last close of day
dl=sorted(days); dC=[days[d] for d in dl]
# map date-> index
didx={d:i for i,d in enumerate(dl)}
def trailing_vol(ts_ms, N=14):
    d=dt.datetime.utcfromtimestamp(ts_ms/1000).strftime('%Y-%m-%d')
    # find last daily index strictly before this date
    i=didx.get(d, None)
    if i is None:
        # nearest earlier
        ds=[x for x in dl if x< d]
        if not ds: return None
        i=didx[ds[-1]]
    i=max(i-1,0)  # strictly before entry day to avoid lookahead
    if i< N+1: return None
    rets=[(dC[j]-dC[j-1])/dC[j-1]*100 for j in range(i-N+1,i+1)]
    return st.pstdev(rets)

# attach trailing vol + year to each trade
for tr in T:
    tr['vol']=trailing_vol(tr['entryTime'])
    tr['yr']=dt.datetime.utcfromtimestamp(tr['entryTime']/1000).year
T=[tr for tr in T if tr['vol'] and tr['vol']>0]
print(f"trades with vol: {len(T)}  base sum net ${sum(t['net'] for t in T):.2f}")

def metrics(nets):
    tot=sum(nets); eq=0; peak=0; mdd=0
    for x in nets:
        eq+=x; peak=max(peak,eq); mdd=max(mdd, peak-eq)
    return tot, mdd, (tot/mdd if mdd>0 else float('inf'))

base_nets=[t['net'] for t in T]
bt,bd,br=metrics(base_nets)
print(f"\nBASELINE fixed-qty: tot ${bt:.1f}  maxDD ${bd:.1f}  ret/DD {br:.2f}")

# ---- VOL-TARGET OVERLAY: multiplier = clamp(targetVol/trailingVol, lo, hi). targetVol = median(vol) from IS only.
IS=[t for t in T if t['yr']<=2022]; OOS=[t for t in T if t['yr']>=2023]
targetVol=st.median([t['vol'] for t in IS])  # set from IS, no OOS lookahead
print(f"targetVol(IS median) = {targetVol:.2f}%")
for LO,HI in [(0.5,2.0),(0.33,3.0),(0.5,1.5)]:
    def scaled(ts):
        out=[]
        for t in ts:
            m=max(LO,min(HI, targetVol/t['vol']))
            out.append(t['net']*m)
        return out
    for lab,ts in [('ALL',T),('IS',IS),('OOS',OOS)]:
        n=scaled(ts); tt,dd,rr=metrics(n)
        if lab=='ALL': print(f"\n VOLTARGET clamp[{LO},{HI}]: ALL tot ${tt:.1f} maxDD ${dd:.1f} ret/DD {rr:.2f}  (vs base {br:.2f})")
        else: print(f"    {lab}: tot ${tt:.1f} maxDD ${dd:.1f} ret/DD {rr:.2f}")

# ---- COST-GATE: bucket by trailing vol terciles -> net/trade. Gate out net-negative buckets.
print("\n--- COST/VOL GATE: net by trailing-vol tercile (does skipping low-vol help?) ---")
sv=sorted(T,key=lambda t:t['vol']); k=len(sv)//3
for lab,grp in [('LOW-vol',sv[:k]),('MID-vol',sv[k:2*k]),('HIGH-vol',sv[2*k:])]:
    nets=[t['net'] for t in grp]
    isn=[t['net'] for t in grp if t['yr']<=2022]; oosn=[t['net'] for t in grp if t['yr']>=2023]
    print(f"  {lab}: n={len(grp)} tot ${sum(nets):+.1f} med ${st.median(nets):+.3f} WR {sum(1 for x in nets if x>0)/len(nets)*100:.0f}% | IS ${sum(isn):+.1f} OOS ${sum(oosn):+.1f}")
