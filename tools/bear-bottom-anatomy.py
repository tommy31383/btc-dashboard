import pickle
d=pickle.load(open('/private/tmp/claude-501/-Users-lap16116-BTC-PC/07bf9375-e97e-466b-be9c-89f8c4bbd644/scratchpad/daily.pkl','rb'))
dates,O,H,L,C,V,bots=d['dates'],d['O'],d['H'],d['L'],d['C'],d['V'],d['bottoms']
n=len(dates)
def atr(i,p=14):
    if i<1: return H[i]-L[i]
    trs=[max(H[j]-L[j],abs(H[j]-C[j-1]),abs(L[j]-C[j-1])) for j in range(max(1,i-p+1),i+1)]
    return sum(trs)/len(trs)
def ret(i,k):
    j=min(n-1,i+k); return (C[j]-L[i])/L[i]*100

# label the macro/notable ones
LBL={'2019-12-18':'2019 post-rally','2020-03-13':'COVID crash','2021-06-22':'May21 China',
     '2022-06-18':'LUNA/3AC capit','2022-11-21':'FTX cycle-low','2024-08-05':'JPY carry unwind',
     '2025-04-07':'2025 tariff','2025-11-21':'late-2025 bear','2026-02-06':'2026 bear low'}

print(f"{'date':11}{'label':18}{'capitD':>7}{'wick%':>6}{'volX':>5}{'atrTrend':>9}{'retest':>14}{'+7d':>6}{'+30d':>6}{'+90d':>6}{'lowerLL?':>9}")
for i in bots:
    dd_day=dates[i]
    # capitulation: biggest single-day % drop in [-10,0]
    capit=min((C[j]-O[j])/O[j]*100 for j in range(max(1,i-10),i+1))
    # wick rejection on bottom day: how far close recovered off low
    rng=H[i]-L[i]; wick=(C[i]-L[i])/rng*100 if rng>0 else 0
    # volume spike: bottom-day vol / 30d avg before
    vavg=sum(V[max(0,i-30):i])/max(1,len(V[max(0,i-30):i])); volx=V[i]/vavg if vavg else 0
    # atr trend: atr at bottom vs atr 20d before (expansion>1 = vol still rising into low)
    a0=atr(i); a1=atr(max(1,i-20)); atrtr=a0/a1 if a1 else 0
    # retest: within +5..+45d, did price come back within 5% of the low? (double-bottom)
    rt='no'
    for j in range(i+5,min(n,i+45)):
        if L[j] <= L[i]*1.05:
            rt=f'+{j-i}d {((L[j]-L[i])/L[i]*100):+.1f}%'; break
    # lower low after within 90d (false bottom)
    ll='YES' if any(L[j]<L[i] for j in range(i+1,min(n,i+90))) else 'no'
    lab=LBL.get(dd_day,'')
    print(f"{dd_day:11}{lab:18}{capit:>6.1f}%{wick:>5.0f}%{volx:>4.1f}x{atrtr:>8.2f}x{rt:>14}{ret(i,7):>5.0f}%{ret(i,30):>5.0f}%{ret(i,90):>5.0f}%{ll:>9}")
