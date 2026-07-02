#!/usr/bin/env python3
"""
sweep-reversal-honest.py — Nhóm A (Tommy): NẾN QUÉT THỊ TRƯỜNG (liquidity sweep / stop-hunt).
Công thức theo Codex. Test 1h + 4h, honest-gate (drop-top-20% + cross-asset + random-null).

LONG down-sweep (quét đáy N-bar rồi đóng ngược lên):
  low[i] < LN - 0.05*ATR  &  close[i] > LN  &  lowerBody-wick/range >= 0.35
  &  closePos >= 0.45  &  range/ATR >= 1.0
Entry next bar open. Exit: stop=entry-SL*ATR, TP=entry+TPx*ATR, time=HOLD bars.
Cost RT = fee 0.08% + slip 2*0.02% = 0.12%.
"""
import json, datetime as dt, statistics as st, random
N=20; SL=1.5; TPx=3.0; HOLD=48; COST=0.0012
random.seed(7)
FILES={'BTC':'binance-1h-7y.json','ETH':'binance-eth-1h-7y.json','SOL':'binance-sol-5m-3y.json'}
BASE='/Users/lap16116/BTC_PC/btc-dashboard/.cache/'

def agg(b,h):
    out=[];span=h*3600*1000;cur=None
    for x in b:
        bk=(x["time"]//span)*span
        if cur is None or bk!=cur["time"]:
            if cur:out.append(cur)
            cur=dict(time=bk,open=x["open"],high=x["high"],low=x["low"],close=x["close"])
        else:
            cur["high"]=max(cur["high"],x["high"]);cur["low"]=min(cur["low"],x["low"]);cur["close"]=x["close"]
    if cur:out.append(cur)
    return out

def atr(D,p=14):
    n=len(D);tr=[0.0]*n
    for i in range(1,n):tr[i]=max(D[i]["high"]-D[i]["low"],abs(D[i]["high"]-D[i-1]["close"]),abs(D[i]["low"]-D[i-1]["close"]))
    o=[None]*n
    for i in range(15,n):o[i]=sum(tr[i-14:i])/14.0
    return o

def yr(ts):return dt.datetime.utcfromtimestamp(ts/1000).year

def exit_long(D,i,entry,a,sl,tp,hold):
    n=len(D);stop=entry-sl*a;tgt=entry+tp*a
    for k in range(i+1,min(i+1+hold,n)):
        if D[k]["low"]<=stop:return (stop/entry-1)-COST,k-i
        if D[k]["high"]>=tgt:return (tgt/entry-1)-COST,k-i
    ke=min(i+hold,n-1);return (D[ke]["close"]/entry-1)-COST,ke-i

def backtest(D,lo=None,hi=None):
    n=len(D);A=atr(D);tr=[];i=max(N,15);lo=lo or i;hi=hi or (n-1);i=max(i,lo)
    while i<hi:
        a=A[i]
        if a is None or a<=0:i+=1;continue
        LN=min(D[k]["low"] for k in range(i-N,i))
        o,c,h,l=D[i]["open"],D[i]["close"],D[i]["high"],D[i]["low"]
        rng=h-l or 1
        lowerwick=(min(o,c)-l)/rng
        closepos=(c-l)/rng
        if l<LN-0.05*a and c>LN and lowerwick>=0.35 and closepos>=0.45 and rng/a>=1.0 and i+1<n:
            entry=D[i+1]["open"]
            ret,hold=exit_long(D,i+1,entry,a,SL,TPx,HOLD)
            tr.append(dict(t=D[i]["time"],ret=ret,hold=hold,i=i+1))
            i+=hold+1
        else:i+=1
    return tr,A

def summ(t):
    if not t:return dict(n=0)
    r=[x["ret"] for x in t];n=len(r);w=sum(1 for x in r if x>0)
    srt=sorted(r,reverse=True);cut=int(n*0.2);drop20=sum(srt[cut:])
    ys={}
    for x in t:ys.setdefault(yr(x["t"]),[]).append(x["ret"])
    posY=sum(1 for y in ys if sum(ys[y])>0)
    return dict(n=n,wr=round(w/n*100),sumret=round(sum(r)*100,1),drop20=round(drop20*100,1),posY=f"{posY}/{len(ys)}")

def rnull(D,A,ne,sl,tp,hold,it=300):
    n=len(D);valid=[i for i in range(N,n-1) if A[i] and A[i]>0];out=[]
    for _ in range(it):
        s=0.0
        for _ in range(ne):
            i=random.choice(valid)
            if i+1>=n:continue
            ret,_=exit_long(D,i+1,D[i+1]["open"],A[i],sl,tp,hold);s+=ret
        out.append(s)
    return out

print("="*70)
print("NHÓM A — NẾN QUÉT (liquidity sweep / stop-hunt) honest-gate | 1h + 4h")
print("="*70)
for tf,h in (("1h",1),("4h",4)):
    print(f"\n──────── TF={tf} ────────")
    for sym in ('BTC','ETH','SOL'):
        raw=json.load(open(BASE+FILES[sym]))
        D=agg(raw,h)
        t,A=backtest(D)
        s=summ(t)
        if s['n']<5:print(f"  [{sym}] n={s['n']} (quá ít)");continue
        null=rnull(D,A,s['n'],SL,TPx,HOLD)
        edge=sum(x['ret'] for x in t);p=sum(1 for x in null if x>=edge)/len(null)
        nm=st.median(null)*100
        g=(s['drop20']>0) and (p<0.05) and ('/' in s['posY'])
        print(f"  [{sym}] n={s['n']} WR={s['wr']}% sumret={s['sumret']}% drop20={s['drop20']}% posY={s['posY']} "
              f"| null-med={nm:+.0f}% p={p:.3f} {'<<<qua' if p<0.05 else 'truot'}")
