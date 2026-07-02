#!/usr/bin/env python3
"""
stochrsi-multitf-honest.py — Tommy hypothesis: StochRSI oversold ĐA-KHUNG-LỚN → long edge?
Honest-gate đầy đủ: drop-top-20% + cross-asset BTC/ETH/SOL + random-null + vs-B&H/ngày + per-year.

Định nghĩa StochRSI chuẩn: RSI(14) → Stoch(RSI,14) → %K=SMA3.
Multi-TF: tính %K trên 1d/4h/12h, map về daily index KHÔNG lookahead (sub-bar closed <= day close).
Entry = next daily open. Exit = fixed hold N ngày. Cost RT 0.12%.
"""
import json, datetime as dt, statistics as st, random
random.seed(11)
FILES={'BTC':('binance-1h-7y.json',1),'ETH':('binance-eth-1h-7y.json',1),'SOL':('binance-sol-5m-3y.json',5)}
BASE='/Users/lap16116/BTC_PC/btc-dashboard/.cache/'
COST=0.0012

def load(sym):
    fn,_=FILES[sym]
    d=json.load(open(BASE+fn))
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

def exit_fixed(D,i,hold):
    n=len(D)
    if i+1>=n: return None,0
    k=min(i+hold,n-1)
    return (D[k]['close']/D[i+1]['open']-1)-COST, k-i

def signals(sym, tfs, thr, need_cross_up=False, bear_only=False):
    bars=load(sym); D=agg(bars,24); cD=[b['close'] for b in D]
    Kd=stochrsi_k(cD); e200=emad(cD,200); Kmap={'1d':Kd}
    for tf,h in (('4h',4),('12h',12)):
        if tf in tfs:
            S=agg(bars,h); Kmap[tf]=map_subtf_to_daily(D,S,stochrsi_k([b['close'] for b in S]))
    sig=[]
    for i in range(20,len(D)-1):
        ks=[Kmap[tf][i] for tf in tfs]
        if any(k is None for k in ks): continue
        cond=all(k<thr for k in ks)
        if cond and need_cross_up and not (Kd[i] is not None and Kd[i-1] is not None and Kd[i]>Kd[i-1]): cond=False
        if cond and bear_only and not (cD[i]<e200[i]): cond=False
        if cond: sig.append(i)
    return D,sig,cD

def gate(sym,tfs,thr,hold=10,**kw):
    D,sig,cD=signals(sym,tfs,thr,**kw)
    trades=[]; last_exit=-1
    for i in sig:
        if i<=last_exit: continue
        ret,h=exit_fixed(D,i,hold)
        if ret is None: continue
        trades.append(dict(t=D[i]['time'],ret=ret)); last_exit=i+h
    if not trades: return dict(n=0)
    rets=[t['ret'] for t in trades]; n=len(rets); w=sum(1 for r in rets if r>0)
    srt=sorted(rets,reverse=True); cut=int(n*0.2); drop20=sum(srt[cut:])
    ys={}
    for t in trades: ys.setdefault(yr(t['t']),[]).append(t['ret'])
    posY=sum(1 for y in ys if sum(ys[y])>0)
    valid=[i for i in range(20,len(D)-1-hold)]; nulls=[]
    for _ in range(300):
        s=0.0
        for _ in range(n):
            i=random.choice(valid); r,_=exit_fixed(D,i,hold); s+=r if r else 0
        nulls.append(s)
    edge=sum(rets); p=sum(1 for x in nulls if x>=edge)/len(nulls)
    bh_tot=cD[-1]/cD[0]-1; bh_day=bh_tot/len(D); rule_day=edge/(n*hold)
    return dict(n=n,wr=round(w/n*100),sumret=round(edge*100,1),drop20=round(drop20*100,1),
                posY=f"{posY}/{len(ys)}",p=round(p,3),
                rule_per_day=round(rule_day*100,3),bh_per_day=round(bh_day*100,3),
                beats_bh=rule_day>bh_day,beats_random=p<0.05,drop20_pos=drop20>0)

VARIANTS=[
    ("1d only K<20",        ['1d'],20,10,{}),
    ("1d only K<10 deep",   ['1d'],10,10,{}),
    ("1d+4h K<20",          ['1d','4h'],20,10,{}),
    ("1d+12h K<20",         ['1d','12h'],20,10,{}),
    ("1d+4h+12h K<20",      ['1d','4h','12h'],20,10,{}),
    ("1d+4h K<20 +crossUp", ['1d','4h'],20,10,{'need_cross_up':True}),
    ("1d+4h K<20 BEAR-only",['1d','4h'],20,10,{'bear_only':True}),
    ("1d+4h K<20 hold20",   ['1d','4h'],20,20,{}),
]

print("="*104)
print("StochRSI multi-TF oversold -> LONG | honest-gate | cost RT 0.12% | entry next-day-open")
print("ALPHA = drop20>0 & beats_random(p<.05) & beats_B&H/ngay. BETA/MIRAGE = thua B&H. MARGINAL = qua B&H nhung yeu.")
print("="*104)
print(f"{'variant':<24}{'sym':<5}{'n':>4}{'wr':>4}{'sumret':>8}{'drop20':>9}{'posY':>6}{'p':>6}{'r/day':>7}{'bh/day':>7}{'verdict':>13}")
for name,tfs,thr,hold,kw in VARIANTS:
    for sym in ('BTC','ETH','SOL'):
        try: r=gate(sym,tfs,thr,hold=hold,**kw)
        except Exception as e:
            print(f"{name:<24}{sym:<5} ERR {repr(e)[:50]}"); continue
        if r.get('n',0)<3:
            print(f"{name:<24}{sym:<5}{r.get('n',0):>4}  (n nho)"); continue
        v="ALPHA" if (r['drop20_pos'] and r['beats_random'] and r['beats_bh']) else ("BETA/MIRAGE" if not r['beats_bh'] else "MARGINAL")
        print(f"{name:<24}{sym:<5}{r['n']:>4}{r['wr']:>4}{r['sumret']:>8}{r['drop20']:>9}{r['posY']:>6}{r['p']:>6}{r['rule_per_day']:>7}{r['bh_per_day']:>7}{v:>13}")
    print()
