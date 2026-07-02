#!/usr/bin/env python3
"""AXIS-2: Does any indicator predict forward realized-vol/DD BETTER than trailing-vol?
Burden of proof: a candidate must BEAT the trailing-vol baseline OUT-OF-SAMPLE.
No-lookahead: all features computed on closed bars up to day t; target measured on (t+1..t+H].
Honest: chronological IS(2019-22)->OOS(2023-26) split, Spearman rank-corr + OOS R2 vs baseline.
"""
import json, os, math, datetime as dt

H = json.load(open(os.path.expanduser('~/BTC_PC/btc-dashboard/.cache/binance-1h-7y.json')))
# -> daily OHLC
days = {}
for b in H:
    d = dt.datetime.utcfromtimestamp(b['time']/1000).strftime('%Y-%m-%d')
    o = days.get(d)
    if o is None:
        days[d] = {'o': b['open'], 'h': b['high'], 'l': b['low'], 'c': b['close'], 't': b['time']}
    else:
        o['h'] = max(o['h'], b['high']); o['l'] = min(o['l'], b['low']); o['c'] = b['close']
dl = sorted(days)
O = [days[d]['o'] for d in dl]; Hi = [days[d]['h'] for d in dl]
Lo = [days[d]['l'] for d in dl]; C = [days[d]['c'] for d in dl]
Yr = [int(d[:4]) for d in dl]
n = len(C)
ret = [0.0] + [(C[i]-C[i-1])/C[i-1] for i in range(1, n)]

def sma(x, i, w):
    if i-w+1 < 0: return None
    return sum(x[i-w+1:i+1])/w
def ema(x, w):
    k = 2/(w+1); out=[None]*len(x); e=x[0]
    for i,v in enumerate(x):
        e = v*k + e*(1-k); out[i]=e
    return out
def pstdev(a):
    m=sum(a)/len(a); return math.sqrt(sum((v-m)**2 for v in a)/len(a))

ema20 = ema(C,20); ema50=ema(C,50); ema200=ema(C,200)
# ATR(14) on daily
tr=[0.0]*n
for i in range(1,n):
    tr[i]=max(Hi[i]-Lo[i], abs(Hi[i]-C[i-1]), abs(Lo[i]-C[i-1]))
atr14=[None]*n
for i in range(n):
    if i>=14: atr14[i]=sum(tr[i-13:i+1])/14
# RSI14
def rsi(C,w=14):
    out=[None]*len(C); g=[0]*len(C); l=[0]*len(C)
    for i in range(1,len(C)):
        ch=C[i]-C[i-1]; g[i]=max(ch,0); l[i]=max(-ch,0)
    for i in range(w,len(C)):
        ag=sum(g[i-w+1:i+1])/w; al=sum(l[i-w+1:i+1])/w
        out[i]=100 if al==0 else 100-100/(1+ag/al)
    return out
RSI=rsi(C)
# ADX14 (Wilder simplified)
def adx(Hi,Lo,C,w=14):
    n=len(C); pdm=[0.0]*n; ndm=[0.0]*n
    for i in range(1,n):
        up=Hi[i]-Hi[i-1]; dn=Lo[i-1]-Lo[i]
        pdm[i]=up if (up>dn and up>0) else 0.0
        ndm[i]=dn if (dn>up and dn>0) else 0.0
    out=[None]*n
    for i in range(2*w,n):
        atr=sum(tr[i-w+1:i+1]);
        if atr==0: continue
        pdi=100*sum(pdm[i-w+1:i+1])/atr; ndi=100*sum(ndm[i-w+1:i+1])/atr
        dx=100*abs(pdi-ndi)/(pdi+ndi) if (pdi+ndi)>0 else 0
        out[i]=dx
    return out
ADX=adx(Hi,Lo,C)

# Codex-requested: regime duration/slope features (the remaining plausible bear-control class)
ema200_slope = [None]*n   # 20d % slope of ema200
for i in range(20, n):
    if ema200[i] is not None and ema200[i-20] is not None and ema200[i-20]>0:
        ema200_slope[i] = (ema200[i]-ema200[i-20])/ema200[i-20]*100
days_below = [0]*n        # consecutive days close<ema200
for i in range(1, n):
    days_below[i] = days_below[i-1]+1 if (ema200[i] is not None and C[i]<ema200[i]) else 0
dd_from_ath = [None]*n     # drawdown from trailing all-time-high (closed bars)
ath = C[0]
for i in range(n):
    ath = max(ath, C[i]); dd_from_ath[i] = (ath-C[i])/ath*100

H_FWD = 14  # forward horizon (days)
# Build samples: at day i (closed), features known; target = realized-vol over (i+1..i+H_FWD]
rows=[]
for i in range(220, n-H_FWD):
    fwd_rets=ret[i+1:i+1+H_FWD]
    fwd_vol=pstdev(fwd_rets)*100
    # forward max drawdown over the window (peak-to-trough on close path from C[i])
    path=C[i:i+1+H_FWD]; peak=path[0]; mdd=0.0
    for p in path:
        peak=max(peak,p); mdd=max(mdd,(peak-p)/peak)
    feats={
        'trail_vol': pstdev(ret[i-13:i+1])*100,      # BASELINE (volScale uses this)
        'trail_vol30': pstdev(ret[i-29:i+1])*100,
        'atr_pct': (atr14[i]/C[i]*100) if atr14[i] else None,
        'adx': ADX[i],
        'rsi': RSI[i],
        'ema20_dist': (C[i]-ema20[i])/C[i]*100,
        'ema200_dist': (C[i]-ema200[i])/C[i]*100,
        'below_ema200': 1.0 if C[i]<ema200[i] else 0.0,
        'ret5': (C[i]-C[i-5])/C[i-5]*100,
        'ret20': (C[i]-C[i-20])/C[i-20]*100,
        'ema200_slope': ema200_slope[i],
        'days_below200': float(days_below[i]),
        'dd_from_ath': dd_from_ath[i],
    }
    if any(v is None for v in feats.values()): continue
    rows.append({'i':i,'yr':Yr[i],'fwd_vol':fwd_vol,'fwd_mdd':mdd*100,**feats})

def spearman(x,y):
    n=len(x)
    rx=rank(x); ry=rank(y)
    mx=sum(rx)/n; my=sum(ry)/n
    num=sum((rx[i]-mx)*(ry[i]-my) for i in range(n))
    dx=math.sqrt(sum((v-mx)**2 for v in rx)); dy=math.sqrt(sum((v-my)**2 for v in ry))
    return num/(dx*dy) if dx*dy>0 else 0.0
def rank(a):
    idx=sorted(range(len(a)), key=lambda k:a[k])
    r=[0]*len(a)
    for pos,k in enumerate(idx): r[k]=pos
    return r

IS=[r for r in rows if r['yr']<=2022]
OOS=[r for r in rows if r['yr']>=2023]
print(f"samples: total={len(rows)} IS(<=2022)={len(IS)} OOS(>=2023)={len(OOS)}  H_FWD={H_FWD}d")
print(f"\n{'feature':<14} | {'IS rho(vol)':>11} {'OOS rho(vol)':>12} | {'IS rho(DD)':>10} {'OOS rho(DD)':>11}")
print('-'*70)
feat_keys=['trail_vol','trail_vol30','atr_pct','adx','rsi','ema20_dist','ema200_dist','below_ema200','ret5','ret20','ema200_slope','days_below200','dd_from_ath']
for f in feat_keys:
    isv=spearman([r[f] for r in IS],[r['fwd_vol'] for r in IS])
    oov=spearman([r[f] for r in OOS],[r['fwd_vol'] for r in OOS])
    isd=spearman([r[f] for r in IS],[r['fwd_mdd'] for r in IS])
    ood=spearman([r[f] for r in OOS],[r['fwd_mdd'] for r in OOS])
    star='  <-- BASELINE' if f=='trail_vol' else ''
    print(f"{f:<14} | {isv:>11.3f} {oov:>12.3f} | {isd:>10.3f} {ood:>11.3f}{star}")
print("\nBurden: a candidate BEATS baseline only if |OOS rho| materially > trail_vol's OOS rho (same sign as IS).")
