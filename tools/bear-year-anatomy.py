import pickle, statistics as st
d=pickle.load(open('/private/tmp/claude-501/-Users-lap16116-BTC-PC/07bf9375-e97e-466b-be9c-89f8c4bbd644/scratchpad/daily.pkl','rb'))
dates,O,H,L,C,V=d['dates'],d['O'],d['H'],d['L'],d['C'],d['V']
n=len(dates)
def ema(p):
    k=2/(p+1); e=[C[0]]
    for i in range(1,n): e.append(C[i]*k+e[-1]*(1-k))
    return e
e200=ema(200); e50=ema(50)
def atr(i,p=14):
    trs=[max(H[j]-L[j],abs(H[j]-C[j-1]),abs(L[j]-C[j-1])) for j in range(max(1,i-p+1),i+1)]
    return sum(trs)/len(trs)

# Regime: bear = close<ema200. Find contiguous bear episodes (>=20 days) after warmup.
WARM=200
inbear=[C[i]<e200[i] for i in range(n)]
episodes=[]; i=WARM
while i<n:
    if inbear[i]:
        j=i
        while j<n and inbear[j]: j+=1
        if j-i>=20: episodes.append((i,j-1))
        i=j
    else: i+=1
print("BTC BEAR EPISODES (close<EMA200d, >=20d):")
print(f"{'span':27}{'days':>5}{'peak→trough':>13}{'reliefs':>8}{'maxRelief':>10}{'atr%':>6}{'%redDays':>9}")
allbear_dd=[]
for (a,b) in episodes:
    span=f"{dates[a]}→{dates[b]}"
    days=b-a+1
    # peak before bear start (trailing 90d high), trough = min low in episode
    peak=max(H[max(0,a-90):a+1]); trough=min(L[a:b+1])
    dd=(trough-peak)/peak*100; allbear_dd.append(dd)
    # relief rallies: count up-swings >=10% from a local low within episode
    reliefs=[]; lo=C[a]; loi=a; peakr=C[a]
    for k in range(a,b+1):
        if L[k]<lo: lo=L[k]; loi=k; peakr=C[k]
        if H[k]>peakr: peakr=H[k]
        r=(peakr-lo)/lo
        if r>=0.10:
            reliefs.append(r*100); lo=H[k]; peakr=H[k]  # reset after counting a relief
    nrel=len(reliefs); maxr=max(reliefs) if reliefs else 0
    atrp=st.mean([atr(k)/C[k]*100 for k in range(a,b+1)])
    redpct=sum(1 for k in range(a,b+1) if C[k]<O[k])/days*100
    print(f"{span:27}{days:>5}{dd:>12.1f}%{nrel:>8}{maxr:>9.1f}%{atrp:>5.1f}%{redpct:>8.0f}%")

# Bull (close>=ema200) vs Bear daily behavior comparison
def daystats(mask):
    rets=[(C[i]-C[i-1])/C[i-1]*100 for i in range(WARM,n) if mask[i]]
    atrp=[atr(i)/C[i]*100 for i in range(WARM,n) if mask[i]]
    up=sum(1 for r in rets if r>0)/len(rets)*100
    worst=sorted(rets)[:int(len(rets)*0.05)]
    return dict(nd=len(rets),meanret=st.mean(rets),medret=st.median(rets),up=up,atr=st.mean(atrp),
                vol=st.pstdev(rets),tail5=st.mean(worst))
bear=daystats(inbear); bull=daystats([not x for x in inbear])
print("\nREGIME DAILY BEHAVIOR (since warmup):")
print(f"{'':6}{'days':>6}{'meanRet':>9}{'medRet':>8}{'up%':>6}{'dailyVol':>9}{'atr%':>6}{'tail5%(avg worst5%)':>20}")
for nm,s in (('BULL',bull),('BEAR',bear)):
    print(f"{nm:6}{s['nd']:>6}{s['meanret']:>8.2f}%{s['medret']:>7.2f}%{s['up']:>5.0f}%{s['vol']:>8.2f}%{s['atr']:>5.1f}%{s['tail5']:>18.2f}%")

# EMA200 reclaim-and-fail behavior in bear: how often does a cross-above fail back within 10d?
crosses=0; fails=0
for i in range(WARM+1,n):
    if C[i-1]<e200[i-1] and C[i]>=e200[i]:  # reclaim
        crosses+=1
        if any(C[j]<e200[j] for j in range(i+1,min(n,i+10))): fails+=1
print(f"\nEMA200 reclaim attempts: {crosses}, failed-back-within-10d: {fails} ({fails/crosses*100:.0f}%)")
print(f"Bear episode median drawdown: {st.median(allbear_dd):.1f}%  (range {min(allbear_dd):.0f}..{max(allbear_dd):.0f})")
