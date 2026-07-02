#!/usr/bin/env python3
"""
stochrsi-exit-regime-honest.py
Tommy: StochRSI multi-TF dead as ENTRY. Test the OTHER side:
  1) EXIT/risk: overbought-aligned (1d & 4h %K>80) -> forward return ÂM/thấp = good profit-take?
  2) REGIME-scale: long-always vs long-only-when-1d-NOT-overbought -> dollars/DD better?
  3) MR ngắn: oversold-aligned -> +2/+3d forward dương đủ ăn cost?
Reuse StochRSI/agg/cost from stochrsi-multitf-honest.py. Honest: drop-top-20% + cross-asset BTC/ETH.
"""
import json, datetime as dt, statistics as st, random
random.seed(11)
FILES={'BTC':('binance-1h-7y.json',1),'ETH':('binance-eth-1h-7y.json',1),'SOL':('binance-sol-5m-3y.json',5)}
BASE='/Users/lap16116/BTC_PC/btc-dashboard/.cache/'
COST=0.0012

def load(sym):
    fn,_=FILES[sym]; d=json.load(open(BASE+fn))
    return [dict(time=int(k['time']),open=k['open'],high=k['high'],low=k['low'],close=k['close']) for k in d]

def agg(bars,hours):
    span=hours*3600*1000; out=[]; cur=None
    for b in bars:
        bk=(b['time']//span)*span
        if cur is None or bk!=cur['time']:
            if cur: out.append(cur)
            cur=dict(time=bk,open=b['open'],high=b['high'],low=b['low'],close=b['close'])
        else:
            cur['high']=max(cur['high'],b['high']); cur['low']=min(cur['low'],b['low']); cur['close']=b['close']
    if cur: out.append(cur)
    return out

def rsi(v,p=14):
    g=[0.0];l=[0.0]
    for i in range(1,len(v)): ch=v[i]-v[i-1]; g.append(max(ch,0)); l.append(max(-ch,0))
    o=[None]*len(v)
    if len(v)>p:
        ag=sum(g[1:p+1])/p; al=sum(l[1:p+1])/p
        o[p]=100-100/(1+ag/al) if al else 100
        for i in range(p+1,len(v)):
            ag=(ag*(p-1)+g[i])/p; al=(al*(p-1)+l[i])/p
            o[i]=100-100/(1+ag/al) if al else 100
    return o

def stochrsi_k(closes,rp=14,sp=14,ksm=3):
    r=rsi(closes,rp); sr=[None]*len(r)
    for i in range(len(r)):
        w=[x for x in r[i-sp+1:i+1] if x is not None]
        if len(w)==sp and r[i] is not None:
            mn=min(w);mx=max(w); sr[i]=(r[i]-mn)/(mx-mn)*100 if mx>mn else 0
    K=[None]*len(sr)
    for i in range(len(sr)):
        w=[x for x in sr[i-ksm+1:i+1] if x is not None]
        if len(w)==ksm: K[i]=sum(w)/ksm
    return K

def emad(v,p):
    k=2/(p+1); o=[v[0]]
    for x in v[1:]: o.append(x*k+o[-1]*(1-k))
    return o

def map_subtf_to_daily(daily, sub, subK):
    out=[None]*len(daily); j=0
    subspan=(sub[1]['time']-sub[0]['time']) if len(sub)>1 else 3600000
    for i,d in enumerate(daily):
        day_close=d['time']+86400000-1
        while j+1<len(sub) and sub[j+1]['time']+subspan-1 <= day_close: j+=1
        out[i]=subK[j] if j<len(subK) else None
    return out

def yr(ts): return dt.datetime.utcfromtimestamp(ts/1000).year

def prep(sym):
    bars=load(sym); D=agg(bars,24); cD=[b['close'] for b in D]
    Kd=stochrsi_k(cD); e200=emad(cD,200)
    S4=agg(bars,4); K4=map_subtf_to_daily(D,S4,stochrsi_k([b['close'] for b in S4]))
    return D,cD,Kd,K4,e200

# ---------- ANGLE 1: overbought-aligned forward return (exit signal quality) ----------
def angle1(sym,thr=80,horizons=(2,3,5)):
    D,cD,Kd,K4,e200=prep(sym)
    n=len(D); res={}
    for H in horizons:
        ob_f=[]; base_f=[]  # forward return entering next-day-open, hold H days, RAW (no cost; measuring drift)
        for i in range(20,n-1-H):
            fr=cD[i+1+H-1]/D[i+1]['open']-1 if i+1+H-1<n else None
            if fr is None: continue
            base_f.append(fr)
            if Kd[i] is not None and K4[i] is not None and Kd[i]>thr and K4[i]>thr:
                ob_f.append(fr)
        if len(ob_f)<10: res[H]=dict(n=len(ob_f)); continue
        # drop-top-20% on the OB-forward set: if overbought=good-exit then mean should be <= base & ideally <0
        res[H]=dict(n=len(ob_f), ob_mean=round(st.mean(ob_f)*100,3), ob_med=round(st.median(ob_f)*100,3),
                    base_mean=round(st.mean(base_f)*100,3), base_med=round(st.median(base_f)*100,3),
                    ob_neg_frac=round(sum(1 for r in ob_f if r<0)/len(ob_f),3))
    return res

# ---------- ANGLE 2: regime-scale long-always vs long-only-when-1d-NOT-overbought ----------
# Long-flat strategy: each day, decide be-long-or-flat for next day. Equity = product of daily returns when long.
def angle2(sym,thr=80):
    D,cD,Kd,K4,e200=prep(sym)
    n=len(D)
    # daily next-day close-to-close return
    def run(filt):
        eq=1.0; peak=1.0; mdd=0.0; days_long=0; prev_long=False
        curve=[]
        for i in range(20,n-1):
            be_long = filt(i)
            if be_long:
                r=cD[i+1]/cD[i]-1
                eq*=(1+r); days_long+=1
                if be_long!=prev_long: eq*=(1-COST/2)  # entry cost on switch-on (half RT, switch-off pays other half)
            else:
                if prev_long: eq*=(1-COST/2)
            prev_long=be_long
            curve.append(eq)
            peak=max(peak,eq); dd=(peak-eq)/peak; mdd=max(mdd,dd)
        return dict(final=round((eq-1)*100,1), mdd=round(mdd*100,1), days_long=days_long,
                    calmar=round(((eq-1))/(mdd if mdd>0 else 1e9),2))
    always=run(lambda i: True)
    no_ob =run(lambda i: not (Kd[i] is not None and Kd[i]>thr))      # skip when 1d overbought
    no_ob_aligned=run(lambda i: not (Kd[i] is not None and K4[i] is not None and Kd[i]>thr and K4[i]>thr))
    return dict(always=always,no_ob_1d=no_ob,no_ob_align=no_ob_aligned)

# ---------- ANGLE 3: short MR oversold-aligned +2/+3d net of cost ----------
def angle3(sym,thr=20,horizons=(2,3)):
    D,cD,Kd,K4,e200=prep(sym)
    n=len(D); res={}
    for H in horizons:
        trades=[]; last=-1
        for i in range(20,n-1-H):
            if i<=last: continue
            if Kd[i] is not None and K4[i] is not None and Kd[i]<thr and K4[i]<thr:
                r=cD[i+1+H-1]/D[i+1]['open']-1-COST
                trades.append((D[i]['time'],r)); last=i+H
        if len(trades)<5: res[H]=dict(n=len(trades)); continue
        rets=[t[1] for t in trades]; m=len(rets)
        srt=sorted(rets,reverse=True); cut=int(m*0.2); drop20=sum(srt[cut:])
        res[H]=dict(n=m, sumret=round(sum(rets)*100,1), mean=round(st.mean(rets)*100,3),
                    wr=round(sum(1 for r in rets if r>0)/m*100), drop20=round(drop20*100,1),
                    drop20_pos=drop20>0)
    return res

print("="*100)
print("ANGLE 1 — OVERBOUGHT-aligned (1d&4h %K>80) forward return. Good-EXIT iff ob_mean<base & ideally<0.")
print("RAW drift (no cost) — measuring whether OB predicts weakness vs unconditional base.")
print("="*100)
print(f"{'sym':<5}{'H':>3}{'n':>5}{'ob_mean':>9}{'base_mean':>10}{'ob_med':>8}{'base_med':>9}{'ob_neg%':>8}  signal")
for sym in ('BTC','ETH','SOL'):
    r=angle1(sym)
    for H,d in r.items():
        if d.get('n',0)<10: print(f"{sym:<5}{H:>3}{d.get('n',0):>5}  (n nho)"); continue
        worse = d['ob_mean']<d['base_mean']
        sig = "OB weaker (exit OK)" if worse else "OB NOT weaker"
        print(f"{sym:<5}{H:>3}{d['n']:>5}{d['ob_mean']:>9}{d['base_mean']:>10}{d['ob_med']:>8}{d['base_med']:>9}{d['ob_neg_frac']*100:>7.0f}%  {sig}")
print()

print("="*100)
print("ANGLE 2 — REGIME long/flat: long-always vs long-only-when-1d-NOT-overbought. Better = more $ AND/OR less DD.")
print("Daily c2c, switch cost RT 0.12% split. Calmar = ret/maxDD.")
print("="*100)
print(f"{'sym':<5}{'variant':<16}{'final%':>9}{'maxDD%':>8}{'calmar':>8}{'days_long':>11}")
for sym in ('BTC','ETH','SOL'):
    r=angle2(sym)
    for k in ('always','no_ob_1d','no_ob_align'):
        d=r[k]
        print(f"{sym:<5}{k:<16}{d['final']:>9}{d['mdd']:>8}{d['calmar']:>8}{d['days_long']:>11}")
    print()

print("="*100)
print("ANGLE 3 — OVERSOLD-aligned (1d&4h %K<20) short MR +2/+3d NET cost. Edge iff sumret>0 & drop20>0 & cross-asset.")
print("="*100)
print(f"{'sym':<5}{'H':>3}{'n':>5}{'sumret':>8}{'mean':>8}{'wr':>4}{'drop20':>9}  verdict")
for sym in ('BTC','ETH','SOL'):
    r=angle3(sym)
    for H,d in r.items():
        if d.get('n',0)<5: print(f"{sym:<5}{H:>3}{d.get('n',0):>5}  (n nho)"); continue
        v="EDGE?" if (d['sumret']>0 and d['drop20_pos']) else ("drop20-DEAD" if d['sumret']>0 else "NEG")
        print(f"{sym:<5}{H:>3}{d['n']:>5}{d['sumret']:>8}{d['mean']:>8}{d['wr']:>4}{d['drop20']:>9}  {v}")
    print()
