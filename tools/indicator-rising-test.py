#!/usr/bin/env python3
"""
indicator-rising-test.py
Tìm indicator có trend ROI TĂNG theo năm (2019→2026)
Focus: trend-following, momentum, structure, volatility expansion
Vì market BTC mature → mean-reversion chết → trend-following sống
"""
import json, datetime, math
from collections import defaultdict

CACHE   = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FEE     = 0.05/100; INITIAL = 100_000; POS_PCT = 0.10; SL_ATR = 2.0; MAX_HOLD = 48

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

bars1h = build_tf(3600*1000)
bars4h = build_tf(4*3600*1000)
bars1d = build_tf(86400*1000)

def closes(bars): return [b['close'] for b in bars]
def highs(bars):  return [b['high']  for b in bars]
def lows(bars):   return [b['low']   for b in bars]
def vols(bars):   return [b['volume'] for b in bars]

c1h=closes(bars1h); h1h=highs(bars1h); l1h=lows(bars1h); v1h=vols(bars1h)
c4h=closes(bars4h); h4h=highs(bars4h); l4h=lows(bars4h)
c1d=closes(bars1d)

def ema(src,p):
    out=[None]*len(src); k=2/(p+1); e=None
    for i,x in enumerate(src):
        e=x if e is None else x*k+e*(1-k); out[i]=e
    return out

def sma(src,p):
    out=[None]*len(src)
    for i in range(p-1,len(src)):
        w=[x for x in src[i-p+1:i+1] if x is not None]
        if len(w)==p: out[i]=sum(w)/p
    return out

def atr_w(bars,p=14):
    n=len(bars); trs=[bars[0]['high']-bars[0]['low']]
    for i in range(1,n):
        trs.append(max(bars[i]['high']-bars[i]['low'],
                       abs(bars[i]['high']-bars[i-1]['close']),
                       abs(bars[i]['low'] -bars[i-1]['close'])))
    out=[None]*n; avg=sum(trs[:p])/p; out[p-1]=avg
    for i in range(p,n):
        avg=(avg*(p-1)+trs[i])/p; out[i]=avg
    return out

def adx_build(bars,p=14):
    n=len(bars); adx_out=[None]*n; pdi=[None]*n; mdi=[None]*n
    trs=[bars[0]['high']-bars[0]['low']]; pdm=[0]; mdm=[0]
    for i in range(1,n):
        h,l=bars[i]['high'],bars[i]['low']; ph,pl=bars[i-1]['high'],bars[i-1]['low']
        trs.append(max(h-l,abs(h-bars[i-1]['close']),abs(l-bars[i-1]['close'])))
        up=h-ph; dn=pl-l
        pdm.append(up if up>dn and up>0 else 0)
        mdm.append(dn if dn>up and dn>0 else 0)
    atr_s=sum(trs[:p]); pm_s=sum(pdm[:p]); mm_s=sum(mdm[:p])
    adx_s=None
    for i in range(p,n):
        atr_s=atr_s-atr_s/p+trs[i]; pm_s=pm_s-pm_s/p+pdm[i]; mm_s=mm_s-mm_s/p+mdm[i]
        pd=100*pm_s/atr_s if atr_s else 0; md=100*mm_s/atr_s if atr_s else 0
        pdi[i]=pd; mdi[i]=md
        dx=100*abs(pd-md)/(pd+md) if (pd+md) else 0
        if i==p*2-1: adx_s=dx
        elif adx_s is not None: adx_s=(adx_s*(p-1)+dx)/p
        if adx_s is not None: adx_out[i]=adx_s
    return adx_out,pdi,mdi

def donchian(src_h,src_l,p):
    n=len(src_h); up=[None]*n; dn=[None]*n
    for i in range(p-1,n):
        up[i]=max(src_h[i-p+1:i+1]); dn[i]=min(src_l[i-p+1:i+1])
    return up,dn

def stddev(src,p):
    out=[None]*len(src)
    for i in range(p-1,len(src)):
        w=[x for x in src[i-p+1:i+1] if x is not None]
        if len(w)==p:
            mu=sum(w)/p; out[i]=(sum((x-mu)**2 for x in w)/p)**0.5
    return out

print("Building indicators...")

atr1h = atr_w(bars1h,14)
atr4h_v = atr_w(bars4h,14)
adx1h,pdi1h,mdi1h = adx_build(bars1h,14)
adx4h,pdi4h,mdi4h = adx_build(bars4h,14)

e20_1h=ema(c1h,20); e50_1h=ema(c1h,50); e100_1h=ema(c1h,100); e200_1h=ema(c1h,200)
e9_1h=ema(c1h,9); e21_1h=ema(c1h,21)

don20h,don20l=donchian(h1h,l1h,20)
don10h,don10l=donchian(h1h,l1h,10)
don50h,don50l=donchian(h1h,l1h,50)

std20=stddev(c1h,20)
vol_sma20=sma(v1h,20)

# Map 1d regime to 1h
regime1d=[]
cs1d=c1d
for i in range(len(bars1d)):
    ma200=sum(cs1d[max(0,i-199):i+1])/(min(i+1,200))
    ma50 =sum(cs1d[max(0,i-49):i+1])/(min(i+1,50))
    if cs1d[i]<ma200: regime1d.append('BEAR')
    elif cs1d[i]>ma50 and ma50>ma200: regime1d.append('BULL')
    else: regime1d.append('RANGE')

t1d=[b['time'] for b in bars1d]
def get_regime(ts):
    lo,hi,idx=0,len(t1d)-1,0
    while lo<=hi:
        m=(lo+hi)//2
        if t1d[m]<=ts: idx=m; lo=m+1
        else: hi=m-1
    return regime1d[idx]

# ── Backtest ──────────────────────────────────────────────────────────────────
def run(name, bars, atrvs, sig_fn, ex_fn=None, both_sides=False):
    n=len(bars); eq=INITIAL; pos=None; cd=0
    yp=defaultdict(float); yn=defaultdict(int)
    for i in range(60,n):
        b=bars[i]; ts=b['time']
        try: d=datetime.datetime.fromtimestamp(ts/1000,datetime.timezone.utc)
        except: continue
        if d.year<2019: continue
        px=b['close']; av=atrvs[i]
        if av is None: continue
        if pos:
            side=pos['side']
            hit_sl=(px<=pos['sl'] if side=='L' else px>=pos['sl'])
            hit_ex=ex_fn(i,pos) if ex_fn else False
            max_h=(i-pos['bar'])>=MAX_HOLD
            if hit_sl or hit_ex or max_h:
                ep=pos['sl'] if hit_sl else px
                if side=='L': net=(ep/pos['ep']-1)*pos['n']
                else:         net=(1-ep/pos['ep'])*pos['n']
                net-=pos['n']*FEE*2
                eq=max(eq+net,1); yp[d.year]+=net; yn[d.year]+=1; pos=None; cd=i+1
        if pos is None and i>cd:
            try:
                sig=sig_fn(i)
                if sig in ('L','S') or sig is True:
                    side='L' if sig is True else sig
                    sl=px-av*SL_ATR if side=='L' else px+av*SL_ATR
                    pos={"ep":px,"sl":sl,"n":eq*POS_PCT,"bar":i,"side":side}
            except: pass
    eq_fin=eq; eq_cur=INITIAL; yr_rois={}
    for yr in range(2019,2027):
        pl=yp.get(yr,0); roi=pl/eq_cur*100 if eq_cur>0 else 0
        yr_rois[yr]=roi; eq_cur+=pl
    cagr=(eq_fin/INITIAL)**(1/7)-1
    total_n=sum(yn.values())
    # trend score: slope of per-year ROI (linear regression)
    ys=[yr_rois.get(y,0) for y in range(2019,2027)]
    xs=list(range(8)); mx=sum(xs)/8; my=sum(ys)/8
    slope=sum((xs[i]-mx)*(ys[i]-my) for i in range(8))/sum((x-mx)**2 for x in xs)
    early=sum(yr_rois.get(y,0) for y in [2019,2020,2021])/3
    late =sum(yr_rois.get(y,0) for y in [2023,2024,2025,2026])/4
    return cagr*100, yr_rois, total_n, slope, early, late

results=[]
def add(name,bars,atrvs,sig,ex=None):
    try:
        cagr,yr,nt,slope,early,late=run(name,bars,atrvs,sig,ex)
        results.append((name,cagr,yr,nt,slope,early,late))
    except Exception as e:
        print(f"  {name} error: {e}")

print("Running tests...")

# ── 1. Donchian 20 breakout (turtle-like) ────────────────────────────────────
add("Donchian20 Break", bars1h, atr1h,
    lambda i: 'L' if (don20h[i-1] and c1h[i]>don20h[i-1]) else
              'S' if (don20l[i-1] and c1h[i]<don20l[i-1]) else None,
    lambda i,p: ('L'==p['side'] and don10l[i] and c1h[i]<don10l[i]) or
                ('S'==p['side'] and don10h[i] and c1h[i]>don10h[i]))

# ── 2. Donchian 50 breakout ───────────────────────────────────────────────────
don50h2,don50l2=donchian(h1h,l1h,50)
don25h,don25l=donchian(h1h,l1h,25)
add("Donchian50 Break", bars1h, atr1h,
    lambda i: 'L' if (don50h2[i-1] and c1h[i]>don50h2[i-1]) else
              'S' if (don50l2[i-1] and c1h[i]<don50l2[i-1]) else None,
    lambda i,p: ('L'==p['side'] and don25l[i] and c1h[i]<don25l[i]) or
                ('S'==p['side'] and don25h[i] and c1h[i]>don25h[i]))

# ── 3. ADX momentum — enter khi ADX tăng mạnh + DI confirm ──────────────────
add("ADX Momentum", bars1h, atr1h,
    lambda i: 'L' if (adx1h[i] and adx1h[i-1] and adx1h[i]>25 and adx1h[i]>adx1h[i-1] and pdi1h[i] and mdi1h[i] and pdi1h[i]>mdi1h[i]) else
              'S' if (adx1h[i] and adx1h[i-1] and adx1h[i]>25 and adx1h[i]>adx1h[i-1] and pdi1h[i] and mdi1h[i] and mdi1h[i]>pdi1h[i]) else None,
    lambda i,p: ('L'==p['side'] and pdi1h[i] and mdi1h[i] and mdi1h[i]>pdi1h[i]) or
                ('S'==p['side'] and pdi1h[i] and mdi1h[i] and pdi1h[i]>mdi1h[i]))

# ── 4. Volatility expansion — BB squeeze break ────────────────────────────────
bb_mid2=sma(c1h,20)
std20_2=stddev(c1h,20)
def sig_bbsqz(i):
    if std20_2[i] is None or std20_2[i-5] is None: return None
    expanding = std20_2[i] > std20_2[i-5]*1.3
    if not expanding: return None
    if c1h[i]>bb_mid2[i] and c1h[i-1]<=bb_mid2[i-1]: return 'L'
    if c1h[i]<bb_mid2[i] and c1h[i-1]>=bb_mid2[i-1]: return 'S'
    return None
add("BB Squeeze Break", bars1h, atr1h, sig_bbsqz)

# ── 5. Higher High / Higher Low structure ─────────────────────────────────────
def sig_hhhl(i):
    if i<5: return None
    hh = h1h[i]>h1h[i-1] and h1h[i-1]>h1h[i-2]
    hl = l1h[i]>l1h[i-1] and l1h[i-1]>l1h[i-2]
    lh = h1h[i]<h1h[i-1] and h1h[i-1]<h1h[i-2]
    ll = l1h[i]<l1h[i-1] and l1h[i-1]<l1h[i-2]
    if hh and hl: return 'L'
    if lh and ll: return 'S'
    return None
add("HH/HL Structure", bars1h, atr1h, sig_hhhl)

# ── 6. EMA stack (trend alignment) ───────────────────────────────────────────
def sig_ema_stack(i):
    if None in [e9_1h[i],e21_1h[i],e50_1h[i],e200_1h[i]]: return None
    bull = e9_1h[i]>e21_1h[i]>e50_1h[i]>e200_1h[i] and e9_1h[i-1]<=e21_1h[i-1]
    bear = e9_1h[i]<e21_1h[i]<e50_1h[i]<e200_1h[i] and e9_1h[i-1]>=e21_1h[i-1]
    if bull: return 'L'
    if bear: return 'S'
    return None
add("EMA Stack", bars1h, atr1h, sig_ema_stack,
    lambda i,p: ('L'==p['side'] and e9_1h[i] and e21_1h[i] and e9_1h[i]<e21_1h[i]) or
                ('S'==p['side'] and e9_1h[i] and e21_1h[i] and e9_1h[i]>e21_1h[i]))

# ── 7. New High momentum — close > 48h high ───────────────────────────────────
don48h,don48l=donchian(h1h,l1h,48)
don48lx,_=donchian(l1h,l1h,48)
def sig_newhigh(i):
    if don48h[i-1] is None: return None
    if c1h[i]>don48h[i-1] and c1h[i-1]<=don48h[i-2 if i>1 else i-1]: return 'L'
    if c1h[i]<don48l[i-1] and c1h[i-1]>=don48l[i-2 if i>1 else i-1]: return 'S'
    return None
add("48h New High/Low", bars1h, atr1h, sig_newhigh)

# ── 8. Price vs EMA200 — momentum pull-away ───────────────────────────────────
def sig_ema200_pull(i):
    if e200_1h[i] is None: return None
    dist = (c1h[i]-e200_1h[i])/e200_1h[i]*100
    prev_dist = (c1h[i-1]-e200_1h[i-1])/e200_1h[i-1]*100 if e200_1h[i-1] else dist
    if dist>2 and prev_dist<=2: return 'L'
    if dist<-2 and prev_dist>=-2: return 'S'
    return None
add("EMA200 Pull-away", bars1h, atr1h, sig_ema200_pull)

# ── 9. Volatility breakout — ATR expansion ────────────────────────────────────
atr_sma=sma(atr1h,20)
def sig_atr_exp(i):
    if atr1h[i] is None or atr_sma[i] is None: return None
    if atr1h[i]<atr_sma[i]*1.5: return None
    if c1h[i]>c1h[i-1]: return 'L'
    if c1h[i]<c1h[i-1]: return 'S'
    return None
add("ATR Expansion", bars1h, atr1h, sig_atr_exp)

# ── 10. Inside Bar breakout ────────────────────────────────────────────────────
def sig_inside(i):
    if i<2: return None
    inside = h1h[i-1]<h1h[i-2] and l1h[i-1]>l1h[i-2]
    if not inside: return None
    if c1h[i]>h1h[i-1]: return 'L'
    if c1h[i]<l1h[i-1]: return 'S'
    return None
add("Inside Bar Break", bars1h, atr1h, sig_inside)

# ── 11. Close above/below VWAP-like (daily pivot) ────────────────────────────
def build_daily_pivot():
    t1h_times=[b['time'] for b in bars1h]
    pivots=[None]*len(bars1h)
    for i,b in enumerate(bars1d):
        ts_start=b['time']; ts_end=ts_start+86400*1000
        for j,t in enumerate(t1h_times):
            if ts_start<=t<ts_end:
                pivots[j]=(b['high']+b['low']+b['close'])/3
    return pivots
pivots=build_daily_pivot()
def sig_pivot(i):
    if pivots[i] is None: return None
    if c1h[i-1]<pivots[i] and c1h[i]>=pivots[i]: return 'L'
    if c1h[i-1]>pivots[i] and c1h[i]<=pivots[i]: return 'S'
    return None
add("Daily Pivot Cross", bars1h, atr1h, sig_pivot)

# ── 12. Funding-proxy: sustained directional move ────────────────────────────
def sig_sustained(i):
    if i<6: return None
    up_count=sum(1 for j in range(i-5,i) if c1h[j]>c1h[j-1])
    dn_count=sum(1 for j in range(i-5,i) if c1h[j]<c1h[j-1])
    if up_count>=4 and c1h[i]>c1h[i-1]: return 'L'
    if dn_count>=4 and c1h[i]<c1h[i-1]: return 'S'
    return None
add("Sustained Move(5)", bars1h, atr1h, sig_sustained)

# ── Print results sorted by trend slope ───────────────────────────────────────
results.sort(key=lambda x: x[4], reverse=True)  # sort by slope

years=list(range(2019,2027))
print(f"\n{'Indicator':<22} {'CAGR':>6} {'n':>5} {'slope':>7} {'early':>7} {'late':>7} | " +
      " | ".join(str(y) for y in years) + " | VERDICT")
print("-"*135)

for name,cagr,yr,nt,slope,early,late in results:
    rois=[yr.get(y,0) for y in years]
    roi_str=" | ".join(f"{r:>+5.1f}%" for r in rois)
    if slope>0.3 and late>0: verdict="RISING ✅"
    elif slope>0:             verdict="SLIGHT ↗"
    elif slope>-0.3:          verdict="FLAT ➡"
    else:                     verdict="DECAY 📉"
    print(f"{name:<22} {cagr:>+5.1f}% {nt:>5} {slope:>+7.2f} {early:>+6.1f}% {late:>+6.1f}% | {roi_str} | {verdict}")
