#!/usr/bin/env python3
"""
stochbreak-live-7y.py — faithful 7y backtest của stochBreakEngine (LIVE REAL).
Khớp params engine:
  LONG : K_1h<20 + mom4h_bull (c4[-1]>c4[-6]) | hold 72h | cooldown 12h | time-exit
  SHORT: close<min(c1h[-3],c1h[-2]) + bearish(close<open) + c4_confirm(c4[-1]<c4[-2])
         + mom4h_bear (c4[-1]<c4[-6]) | hold 6h | cooldown 6h | time-exit
  StochRSI 14/14/3/3 · sizing 0.001 BTC (degraded) · max 4 concurrent (combined).
Gross PnL (no fees) — đồng nhất với champion/hedge01 scripts.
"""
import json, datetime as dt

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
QTY = 0.001
L_THR, L_HOLD, L_COOL = 20, 72, 12
S_LB, S_HOLD, S_COOL = 2, 6, 6
MAX_CONC = 4
TAKER = 0.0004          # v0.4.96: fee taker 0.04%/side (round-trip ~0.08%)
ENABLE_SHORT = False    # v0.4.96: SHORT tắt trên live (loser) → backtest LONG-only mặc định

def agg(bars5, hours):
    """Aggregate 5m bars → Nh bars aligned to UTC boundaries."""
    out = []
    span = hours*3600*1000
    cur = None
    for b in bars5:
        bucket = (b["time"]//span)*span
        if cur is None or bucket != cur["time"]:
            if cur: out.append(cur)
            cur = {"time":bucket,"open":b["open"],"high":b["high"],"low":b["low"],"close":b["close"]}
        else:
            cur["high"]=max(cur["high"],b["high"]); cur["low"]=min(cur["low"],b["low"]); cur["close"]=b["close"]
    if cur: out.append(cur)
    return out

def rsi_series(closes, p=14):
    n=len(closes); out=[None]*n
    if n<p+1: return out
    gains=losses=0.0
    for i in range(1,p+1):
        ch=closes[i]-closes[i-1]; gains+=max(ch,0); losses+=max(-ch,0)
    ag=gains/p; al=losses/p
    out[p]=100.0 if al==0 else 100-100/(1+ag/al)
    for i in range(p+1,n):
        ch=closes[i]-closes[i-1]
        ag=(ag*(p-1)+max(ch,0))/p; al=(al*(p-1)+max(-ch,0))/p
        out[i]=100.0 if al==0 else 100-100/(1+ag/al)
    return out

def stochrsi_k(closes, rp=14, sp=14, ks=3, ds=3):
    """Return K series (matches calcStochRSISeries)."""
    rsi=rsi_series(closes,rp); n=len(closes)
    rawk=[None]*n
    for i in range(n):
        if rsi[i] is None: continue
        window=[rsi[j] for j in range(max(0,i-sp+1),i+1) if rsi[j] is not None]
        if len(window)<sp: continue
        lo=min(window); hi=max(window)
        rawk[i]=100.0 if hi==lo else (rsi[i]-lo)/(hi-lo)*100
    # smooth K = SMA(ks) of rawk
    k=[None]*n
    for i in range(n):
        w=[rawk[j] for j in range(max(0,i-ks+1),i+1) if rawk[j] is not None]
        if len(w)==ks: k[i]=sum(w)/ks
    return k

print("Loading 5m cache..."); bars5=json.load(open(CACHE))
print(f"  {len(bars5)} 5m bars");
print("Aggregating 1h + 4h..."); b1=agg(bars5,1); b4=agg(bars5,4)
print(f"  1h={len(b1)} 4h={len(b4)}")
c1=[b["close"] for b in b1]; o1=[b["open"] for b in b1]; t1=[b["time"] for b in b1]
c4=[b["close"] for b in b4]; t4=[b["time"] for b in b4]
print("StochRSI 1h..."); K=stochrsi_k(c1)

# map each 1h bar → index of latest CLOSED 4h bar (4h bar whose close-time <= 1h bar close-time)
# 4h bar at t4[j] covers [t4[j], t4[j]+4h); it's "closed" once 1h bar time >= t4[j]+4h
def latest_closed_4h(t1h):
    # binary-ish: 4h bar j closed when t1h >= t4[j]+4h. We want largest j with t4[j]+4h <= t1h+1h...
    # engine c4h = closed 4h bars at decision; at 1h bar close time T, closed 4h bars have t4[j]+4h <= T+1h (the 4h bar ending at T)
    pass

H=3600*1000
# precompute 4h index for each 1h bar: largest j s.t. t4[j] <= t1[i] (the 4h bar containing this hour);
# but need CLOSED 4h → use j-1 if the containing 4h bar not yet closed at this hour.
import bisect
def j4_for(i):
    T=t1[i]
    # 4h bar containing T:
    j=bisect.bisect_right(t4,T)-1
    # closed 4h bars: those with t4[jj]+4h <= T+1h  → bar ending at or before this hour's end
    # the containing bar [t4[j],t4[j]+4h) is closed only when current hour is its last hour (T == t4[j]+3h)
    if j>=0 and T < t4[j]+4*H - H + 1:  # not the last hour of the 4h bar
        # if not last hour, the containing bar isn't fully closed → use previous
        if T < t4[j]+3*H: j-=1
    return j

positions=[]  # list of dict {exit_idx, side, entry}
trades=[]
lastLongTs=lastShortTs=-10**18
for i in range(len(b1)):
    # close expired
    positions=[p for p in positions if p["exit_idx"]>i]
    j=j4_for(i)
    if j<5: continue
    mom_bull = c4[j] > c4[j-5]
    mom_bear = c4[j] < c4[j-5]
    conc=len(positions)
    Ki=K[i]
    # LONG
    if conc<MAX_CONC and Ki is not None and Ki<L_THR and mom_bull and (t1[i]-lastLongTs)>=L_COOL*H:
        ex=min(i+L_HOLD,len(b1)-1)
        fee=(c1[i]+c1[ex])*QTY*TAKER
        pnl=QTY*(c1[ex]-c1[i])-fee
        trades.append({"t":t1[i],"side":"LONG","entry":c1[i],"exit":c1[ex],"pnl":pnl})
        positions.append({"exit_idx":ex,"side":"LONG"}); lastLongTs=t1[i]
    # SHORT
    if ENABLE_SHORT and conc<MAX_CONC and mom_bear and i>=3 and (t1[i]-lastShortTs)>=S_COOL*H:
        recentMin=min(c1[i-2],c1[i-1])
        bear = c1[i] < o1[i]
        c4conf = c4[j] < c4[j-1]
        if c1[i]<recentMin and bear and c4conf:
            ex=min(i+S_HOLD,len(b1)-1)
            fee=(c1[i]+c1[ex])*QTY*TAKER
            pnl=QTY*(c1[i]-c1[ex])-fee
            trades.append({"t":t1[i],"side":"SHORT","entry":c1[i],"exit":c1[ex],"pnl":pnl})
            positions.append({"exit_idx":ex,"side":"SHORT"}); lastShortTs=t1[i]

# report
from collections import defaultdict
yr=defaultdict(lambda:{"n":0,"w":0,"pnl":0.0,"L":0,"S":0})
tot={"n":0,"w":0,"pnl":0.0,"L":0,"S":0}
for tr in trades:
    y=dt.datetime.utcfromtimestamp(tr["t"]/1000).year
    for d in (yr[y],tot):
        d["n"]+=1; d["pnl"]+=tr["pnl"]; d["w"]+= 1 if tr["pnl"]>0 else 0
        d["L"]+= 1 if tr["side"]=="LONG" else 0; d["S"]+= 1 if tr["side"]=="SHORT" else 0
print(f"\n=== STOCHBREAK 7y (NET fee {TAKER*100:.2f}%/side, 0.001 BTC, SHORT={'ON' if ENABLE_SHORT else 'OFF=live v0.4.96'}) ===")
print(f"TOTAL: n={tot['n']} (LONG {tot['L']} + SHORT {tot['S']})  PnL=${tot['pnl']:.2f}  WR={tot['w']/max(1,tot['n'])*100:.0f}%")
print("\n--- PER YEAR ---  year | n | WR% | PnL$ | L/S")
out={"total":tot,"byYear":{}}
for y in sorted(yr):
    d=yr[y]; wr=d["w"]/max(1,d["n"])*100
    print(f"  {y} | {d['n']:>4} | {wr:>3.0f}% | {d['pnl']:>+8.2f} | {d['L']}/{d['S']}")
    out["byYear"][y]={"n":d["n"],"wr":round(wr,1),"pnl":round(d["pnl"],2),"long":d["L"],"short":d["S"]}
# per-sleeve split
sl=defaultdict(lambda:{"n":0,"w":0,"pnl":0.0,"yr":defaultdict(float)})
for tr in trades:
    d=sl[tr["side"]]; d["n"]+=1; d["pnl"]+=tr["pnl"]; d["w"]+= 1 if tr["pnl"]>0 else 0
    d["yr"][dt.datetime.utcfromtimestamp(tr["t"]/1000).year]+=tr["pnl"]
print("\n--- PER SLEEVE ---")
for s in ("LONG","SHORT"):
    d=sl[s]; py=sum(1 for y in d["yr"] if d["yr"][y]>0)
    print(f"  {s}: n={d['n']} WR={d['w']/max(1,d['n'])*100:.0f}% PnL=${d['pnl']:.2f} stab={py}/{len(d['yr'])}")
    yrs=d["yr"]
    print("       per-year: "+" ".join("%d:%+.1f"%(y,yrs[y]) for y in sorted(yrs)))
    out.setdefault("bySleeve",{})[s]={"n":d["n"],"wr":round(d['w']/max(1,d['n'])*100,1),"pnl":round(d["pnl"],2),"byYear":{y:round(v,2) for y,v in d['yr'].items()}}
posY=sum(1 for y in yr if yr[y]["pnl"]>0)
print(f"\nStability: {posY}/{len(yr)} năm dương")
out["stability"]=f"{posY}/{len(yr)}"
json.dump(out,open("/tmp/stochbreak_7y.json","w"),indent=1)
print("→ /tmp/stochbreak_7y.json")
