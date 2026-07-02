#!/usr/bin/env python3
"""ORTHOGONAL SLEEVE first-pass (Codex/Grok lead): maker-native mean-reversion RANGE sleeve.
Thesis: NOT MR-alpha (that's null). Value = (a) trades when champion SITS OUT (range/chop),
(b) maker-native (MR rests limits = real maker fills, unlike trend), (c) structurally
anti-correlated with trend champion (champion wins breakout, MR wins chop). Test: standalone NET
under honest costs + CORRELATION with champion PnL + combined-book Calmar/drop20 + OOS.
Honest priors: MR entry-edge proven null before -> expect standalone weak; the ONLY justification
would be low/negative correlation improving the BOOK. Judge dollars + correlation.
"""
import json, os, math, datetime as dt

H = json.load(open(os.path.expanduser('~/BTC_PC/btc-dashboard/.cache/binance-1h-7y.json')))
# resample 1h -> 4h (champion sleeve TF)
bars4=[]
cur=None
for b in H:
    t=b['time']; h4=(t//(4*3600*1000))*(4*3600*1000)
    if cur is None or cur['t']!=h4:
        if cur: bars4.append(cur)
        cur={'t':h4,'o':b['open'],'h':b['high'],'l':b['low'],'c':b['close']}
    else:
        cur['h']=max(cur['h'],b['high']); cur['l']=min(cur['l'],b['low']); cur['c']=b['close']
if cur: bars4.append(cur)
n=len(bars4); C=[b['c'] for b in bars4]; Hi=[b['h'] for b in bars4]; Lo=[b['l'] for b in bars4]; O=[b['o'] for b in bars4]
def ema(x,w):
    k=2/(w+1); o=[None]*len(x); e=x[0]
    for i,v in enumerate(x): e=v*k+e*(1-k); o[i]=e
    return o
e20=ema(C,20); e50=ema(C,50); e200=ema(C,200)
# ATR(14) 4h
tr=[0.0]*n
for i in range(1,n): tr[i]=max(Hi[i]-Lo[i],abs(Hi[i]-C[i-1]),abs(Lo[i]-C[i-1]))
atr=[None]*n
for i in range(n):
    if i>=14: atr[i]=sum(tr[i-13:i+1])/14
# ADX(14) 4h (simplified Wilder)
def adx(w=14):
    pdm=[0.0]*n; ndm=[0.0]*n; o=[None]*n
    for i in range(1,n):
        up=Hi[i]-Hi[i-1]; dn=Lo[i-1]-Lo[i]
        pdm[i]=up if(up>dn and up>0)else 0; ndm[i]=dn if(dn>up and dn>0)else 0
    for i in range(2*w,n):
        a=sum(tr[i-w+1:i+1]);
        if a==0: continue
        pdi=100*sum(pdm[i-w+1:i+1])/a; ndi=100*sum(ndm[i-w+1:i+1])/a
        o[i]=100*abs(pdi-ndi)/(pdi+ndi) if(pdi+ndi)>0 else 0
    return o
ADX=adx()
# Bollinger(20,2)
def boll(i):
    if i<19: return None,None,None
    w=C[i-19:i+1]; m=sum(w)/20; sd=math.sqrt(sum((x-m)**2 for x in w)/20)
    return m-2*sd, m, m+2*sd

FEE_MAKER=0.0002; FEE_TAKER=0.0004; SLIP=0.0002; ADVERSE=0.0003  # realistic maker adverse from exp.1
QTY=0.001; SL_ATR=1.5; TP_ATR=2.0; TIME_STOP=24  # bars (4 days)

def run(maker=True, adx_max=20, dip_atr=0.5):
    trades=[]; pos=None
    for i in range(210,n-1):
        if atr[i] is None or e200[i] is None or ADX[i] is None: continue
        lo_b,mid_b,up_b=boll(i)
        if lo_b is None: continue
        # manage open
        if pos:
            held=i-pos['i']
            hit_sl = Lo[i+1] <= pos['sl']; hit_tp = Hi[i+1] >= pos['tp']
            exit_px=None; rsn=None
            if hit_sl and hit_tp: exit_px=pos['sl']; rsn='SL'   # pessimistic
            elif hit_sl: exit_px=pos['sl']; rsn='SL'
            elif hit_tp: exit_px=pos['tp']; rsn='TP'
            elif held>=TIME_STOP: exit_px=O[i+1]; rsn='TIME'
            elif C[i]>=mid_b: exit_px=O[i+1]; rsn='MEAN'  # revert to mean -> exit at next open (market)
            if exit_px is not None:
                ex=exit_px*(1-SLIP)  # exits market/taker
                gross=QTY*(ex-pos['px']); fee=(pos['px']*pos['fr']+ex*FEE_TAKER)*QTY
                trades.append({'entryTime':pos['t'],'exitTime':bars4[i]['t'],'net':gross-fee,'reason':rsn})
                pos=None
        if pos: continue
        # RANGE regime: low ADX (no strong trend) + price not far from EMA200 (not deep bear/bull)
        in_range = ADX[i]<adx_max and abs(C[i]-e200[i])/C[i] < 0.15
        # MR LONG entry: dip below lower-band (oversold in range)
        if in_range and C[i] <= lo_b:
            limit = O[i+1]*(1-dip_atr*0.0) if False else None
            if maker:
                limitpx=O[i+1]*(1-0.0005)
                if Lo[i+1] <= limitpx: px=limitpx*(1+ADVERSE); fr=FEE_MAKER
                else: px=O[i+2]*(1+SLIP) if i+2<n else None; fr=FEE_TAKER  # taker fallback
                if px is None: continue
            else:
                px=O[i+1]*(1+SLIP); fr=FEE_TAKER
            pos={'i':i,'t':bars4[i+1]['t'],'px':px,'fr':fr,'sl':px-SL_ATR*atr[i],'tp':px+TP_ATR*atr[i]}
    return trades

def metrics(T):
    nets=[t['net'] for t in T]; tot=sum(nets); eq=0;pk=0;mdd=0
    for x in nets: eq+=x;pk=max(pk,eq);mdd=max(mdd,pk-eq)
    sd=sorted(nets,reverse=True); d20=sum(sd[int(len(sd)*0.2):]) if nets else 0
    wins=sum(1 for x in nets if x>0)
    return tot,-mdd,d20,(100*wins/len(nets) if nets else 0),len(nets)

for tag,mk in [("MR taker",False),("MR maker",True)]:
    T=run(maker=mk)
    tot,mdd,d20,wr,nn=metrics(T)
    # per-year
    yr={}
    for t in T:
        y=dt.datetime.utcfromtimestamp(t['exitTime']/1000).year; yr.setdefault(y,0); yr[y]+=t['net']
    IS=sum(v for y,v in yr.items() if y<=2022); OOS=sum(v for y,v in yr.items() if y>=2023)
    print(f"[{tag}] NET=${tot:.2f} maxDD=${mdd:.2f} drop20=${d20:.2f} WR={wr:.1f}% n={nn}  IS=${IS:.1f} OOS=${OOS:.1f}")
    if mk:
        # correlation with champion (C1) monthly PnL
        champ=json.load(open('/tmp/ens_C1_base.json'))
        def monthly(TT):
            m={}
            for t in TT:
                k=dt.datetime.utcfromtimestamp(t['exitTime']/1000).strftime('%Y-%m'); m.setdefault(k,0); m[k]+=t['net']
            return m
        mc=monthly(champ); mm=monthly(T)
        keys=sorted(set(mc)|set(mm)); a=[mc.get(k,0) for k in keys]; b=[mm.get(k,0) for k in keys]
        ma=sum(a)/len(a); mb=sum(b)/len(b)
        cov=sum((a[i]-ma)*(b[i]-mb) for i in range(len(a)))
        sa=math.sqrt(sum((x-ma)**2 for x in a)); sb=math.sqrt(sum((x-mb)**2 for x in b))
        corr=cov/(sa*sb) if sa*sb>0 else 0
        print(f"        corr(MR, champion) monthly PnL = {corr:+.3f}  (orthogonal if ~0 or negative)")
        # combined book equal-capital
        comb=[(t['exitTime'],t['net']/2) for t in champ]+[(t['exitTime'],t['net']/2) for t in T]
        comb.sort()
        eq=0;pk=0;mdd=0
        for _,x in comb: eq+=x;pk=max(pk,eq);mdd=max(mdd,pk-eq)
        ctot=sum(x for _,x in comb)
        print(f"        BOOK 50/50 (champ+MR): NET=${ctot:.2f} maxDD=${-mdd:.2f} Calmar={ctot/mdd if mdd>0 else 0:.2f}")
        print(f"        vs champion-only:      NET=$472.01 maxDD=$-80.05 Calmar=5.90")
