#!/usr/bin/env python3
"""
stochbreak-2026-analysis.py — Lấy đỉnh/đáy 1D 2026 + overlay lệnh LONG stochbreak
để chẩn đoán vì sao LONG thua 2026.
"""
import json, datetime as dt
from collections import defaultdict

CACHE="/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
QTY=0.001; TAKER=0.0004
L_THR,L_HOLD,L_COOL=20,72,12
H=3600*1000

def agg(bars5,hours):
    out=[];span=hours*3600*1000;cur=None
    for b in bars5:
        bk=(b["time"]//span)*span
        if cur is None or bk!=cur["time"]:
            if cur:out.append(cur)
            cur={"time":bk,"open":b["open"],"high":b["high"],"low":b["low"],"close":b["close"]}
        else:
            cur["high"]=max(cur["high"],b["high"]);cur["low"]=min(cur["low"],b["low"]);cur["close"]=b["close"]
    if cur:out.append(cur)
    return out

def rsi_series(c,p=14):
    n=len(c);o=[None]*n
    if n<p+1:return o
    g=l=0.0
    for i in range(1,p+1):
        ch=c[i]-c[i-1];g+=max(ch,0);l+=max(-ch,0)
    ag=g/p;al=l/p
    o[p]=100.0 if al==0 else 100-100/(1+ag/al)
    for i in range(p+1,n):
        ch=c[i]-c[i-1];ag=(ag*(p-1)+max(ch,0))/p;al=(al*(p-1)+max(-ch,0))/p
        o[i]=100.0 if al==0 else 100-100/(1+ag/al)
    return o

def stochk(c,rp=14,sp=14,ks=3):
    r=rsi_series(c,rp);n=len(c);rk=[None]*n
    for i in range(n):
        if r[i] is None:continue
        w=[r[j] for j in range(max(0,i-sp+1),i+1) if r[j] is not None]
        if len(w)<sp:continue
        lo=min(w);hi=max(w);rk[i]=100.0 if hi==lo else (r[i]-lo)/(hi-lo)*100
    k=[None]*n
    for i in range(n):
        w=[rk[j] for j in range(max(0,i-ks+1),i+1) if rk[j] is not None]
        if len(w)==ks:k[i]=sum(w)/ks
    return k

print("Loading cache..."); bars5=json.load(open(CACHE))
b1=agg(bars5,1); b4=agg(bars5,4); bD=agg(bars5,24)
c1=[b["close"] for b in b1]; t1=[b["time"] for b in b1]
c4=[b["close"] for b in b4]; t4=[b["time"] for b in b4]
K=stochk(c1)
import bisect
def j4(i):
    T=t1[i];j=bisect.bisect_right(t4,T)-1
    if j>=0 and T<t4[j]+3*H:j-=1
    return j

# ── replay LONG entries (LONG-only, like v0.4.96) ──
positions=[];trades=[];lastL=-10**18
for i in range(len(b1)):
    positions=[p for p in positions if p["ex"]>i]
    j=j4(i)
    if j<5:continue
    mom_bull=c4[j]>c4[j-5]
    if len(positions)<4 and K[i] is not None and K[i]<L_THR and mom_bull and (t1[i]-lastL)>=L_COOL*H:
        ex=min(i+L_HOLD,len(b1)-1)
        fee=(c1[i]+c1[ex])*QTY*TAKER
        pnl=QTY*(c1[ex]-c1[i])-fee
        trades.append({"t":t1[i],"entry":c1[i],"exit":c1[ex],"pnl":pnl,"K":K[i],
                       "edate":dt.datetime.utcfromtimestamp(t1[i]/1000).strftime("%m-%d %H:%M"),
                       "xdate":dt.datetime.utcfromtimestamp(t1[ex]/1000).strftime("%m-%d")})
        positions.append({"ex":ex});lastL=t1[i]

# ── 2026 daily + swing peaks/troughs ──
d2026=[b for b in bD if dt.datetime.utcfromtimestamp(b["time"]/1000).year==2026]
def swings(bars,w=5):
    pk=[];tr=[]
    for i in range(w,len(bars)-w):
        win=bars[i-w:i+w+1]
        if bars[i]["high"]==max(x["high"] for x in win):pk.append(i)
        if bars[i]["low"]==min(x["low"] for x in win):tr.append(i)
    return pk,tr
pk,tr=swings(d2026,5)
def ds(b):return dt.datetime.utcfromtimestamp(b["time"]/1000).strftime("%Y-%m-%d")
print("\n=== 2026 DAILY STRUCTURE ===")
print(f"  Range: {ds(d2026[0])} ${d2026[0]['close']:,.0f} → {ds(d2026[-1])} ${d2026[-1]['close']:,.0f}")
hi=max(d2026,key=lambda b:b["high"]);lo=min(d2026,key=lambda b:b["low"])
print(f"  Đỉnh năm: ${hi['high']:,.0f} ({ds(hi)}) | Đáy năm: ${lo['low']:,.0f} ({ds(lo)})")
print(f"  Biên độ: {(hi['high']-lo['low'])/lo['low']*100:.1f}% | YTD: {(d2026[-1]['close']-d2026[0]['open'])/d2026[0]['open']*100:+.1f}%")
print("\n  ĐỈNH (swing highs):")
for i in pk:print(f"    {ds(d2026[i])}  ${d2026[i]['high']:,.0f}")
print("  ĐÁY (swing lows):")
for i in tr:print(f"    {ds(d2026[i])}  ${d2026[i]['low']:,.0f}")

# ── 2026 LONG trades diagnostic ──
t26=[x for x in trades if dt.datetime.utcfromtimestamp(x["t"]/1000).year==2026]
print(f"\n=== STOCHBREAK LONG 2026: {len(t26)} lệnh ===")
wins=[x for x in t26 if x["pnl"]>0];loss=[x for x in t26 if x["pnl"]<=0]
print(f"  WR {len(wins)}/{len(t26)} = {len(wins)/max(1,len(t26))*100:.0f}% | PnL net ${sum(x['pnl'] for x in t26):.2f}")
print(f"  Avg win ${sum(x['pnl'] for x in wins)/max(1,len(wins)):.3f} | Avg loss ${sum(x['pnl'] for x in loss)/max(1,len(loss)):.3f}")
# entry relative to 2026 high/low
print(f"\n  Lệnh LONG 2026 (entry→exit, %):")
for x in t26:
    chg=(x["exit"]-x["entry"])/x["entry"]*100
    # vị trí entry trong range năm
    posr=(x["entry"]-lo["low"])/(hi["high"]-lo["low"])*100
    print(f"    {x['edate']} entry ${x['entry']:,.0f} (pos {posr:.0f}% range) → exit ${x['exit']:,.0f} ({chg:+.1f}%) pnl ${x['pnl']:+.3f}")
# diagnose: how many entered in upper half (buying high) vs lower
upper=[x for x in t26 if (x["entry"]-lo["low"])/(hi["high"]-lo["low"])>0.5]
print(f"\n  Chẩn đoán: {len(upper)}/{len(t26)} lệnh vào ở NỬA TRÊN range năm (mua đỉnh trong downtrend).")
json.dump({"trades2026":[{k:v for k,v in x.items() if k!='t'} for x in t26],
           "year_high":hi["high"],"year_low":lo["low"]},open("/tmp/sb2026.json","w"),indent=1)
print("→ /tmp/sb2026.json")
