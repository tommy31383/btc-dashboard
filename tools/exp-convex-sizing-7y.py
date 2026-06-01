#!/usr/bin/env python3
"""
exp-convex-sizing-7y.py — Test ĐỀ XUẤT #1-convex (top-decile conviction boost).

Câu hỏi: trên TẬP trend-LONG entry thật (EMA50>200 cross ~ setup #12), sizing-up
các entry conviction CỰC CAO (top-decile bullProb) có cải thiện expectancy/RA net-of-cost
KHÔNG — so với flat qty? Đây là relative test (cùng tập trade) nên robust với engine approx.

Engine sim (4h, gần config live):
  - Entry LONG khi EMA50 cross lên EMA200 (setup #12) + ADX(14)>20 (sticky 2 bar).
  - SL = entry - ATR×4 (initial), tighten ATR×3 sau 48h (12 bar 4h). TP = +10% (TP_PCT live).
  - Fee 0.05%/side (net-of-cost).
  - maxHold 100 bar.
So 3 sizing scheme trên CÙNG entry set:
  (FLAT)  qty=1 mọi trade
  (LIN)   qty ∝ bullProb (đã biết fail #1)
  (CVX)   qty=1, nhưng top-decile bullProb → qty=2 (convex boost)
Đo: total PnL (qty-weighted, net), RA = mean/std per-trade, per-year stability.
"""
import json, math, datetime
from collections import defaultdict

CACHE="/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FEE=0.05/100; H4=4*3600*1000

def load_tf(ms):
    raw=json.load(open(CACHE)); b={}
    for c in raw:
        k=c["time"]//ms
        if k not in b: b[k]={"time":k*ms,"high":c["high"],"low":c["low"],"close":c["close"]}
        else: o=b[k]; o["high"]=max(o["high"],c["high"]); o["low"]=min(o["low"],c["low"]); o["close"]=c["close"]
    return [b[k] for k in sorted(b)]

def ema_series(xs,n):
    k=2/(n+1); out=[None]*len(xs); e=None
    for i,x in enumerate(xs):
        e=x if e is None else x*k+e*(1-k); out[i]=e
    return out

def main():
    bars=load_tf(H4); closes=[x["close"] for x in bars]; n=len(bars)
    print(f"4h bars: {n}  {datetime.datetime.utcfromtimestamp(bars[0]['time']/1000):%Y-%m-%d} → {datetime.datetime.utcfromtimestamp(bars[-1]['time']/1000):%Y-%m-%d}")
    e50=ema_series(closes,50); e200=ema_series(closes,200)

    # ATR(14) and ADX(14)
    tr=[0.0]*n; pdm=[0.0]*n; ndm=[0.0]*n
    for i in range(1,n):
        up=bars[i]["high"]-bars[i-1]["high"]; dn=bars[i-1]["low"]-bars[i]["low"]
        pdm[i]=up if (up>dn and up>0) else 0.0; ndm[i]=dn if (dn>up and dn>0) else 0.0
        hl=bars[i]["high"]-bars[i]["low"]; hc=abs(bars[i]["high"]-closes[i-1]); lc=abs(bars[i]["low"]-closes[i-1])
        tr[i]=max(hl,hc,lc)
    def wilder(xs,p,i):
        if i<p: return None
        return sum(xs[i-p+1:i+1])/p
    atr=[None]*n
    for i in range(n): atr[i]=wilder(tr,14,i)
    # ADX (simplified Wilder)
    adx=[None]*n
    for i in range(28,n):
        atrv=wilder(tr,14,i)
        if not atrv: continue
        pdi=100*wilder(pdm,14,i)/atrv; ndi=100*wilder(ndm,14,i)/atrv
        dx=100*abs(pdi-ndi)/((pdi+ndi) or 1e-9)
        # smooth dx over 14
        dxs=[]
        for j in range(i-13,i+1):
            a2=wilder(tr,14,j)
            if not a2: dxs.append(0); continue
            p2=100*wilder(pdm,14,j)/a2; n2=100*wilder(ndm,14,j)/a2
            dxs.append(100*abs(p2-n2)/((p2+n2) or 1e-9))
        adx[i]=sum(dxs)/len(dxs)

    # bullProb (same as exp #1)
    def bull_prob(i):
        if i<200: return None
        w=closes[i-199:i+1]; mean=sum(w)/200; std=(sum((x-mean)**2 for x in w)/200)**0.5 or 1.0
        z=(closes[i]-mean)/std
        s50p=e50[i-5] if i>=5 else None
        slope=(e50[i]-s50p)/e50[i] if s50p else 0
        return 1/(1+math.exp(-(1.2*z+30*slope)))

    # generate trend-LONG entries
    trades=[]  # (entryIdx, entryPx, prob, year)
    adx_ok=0
    for i in range(201,n-1):
        if None in (e50[i],e200[i],e50[i-1],e200[i-1],atr[i],adx[i]): continue
        cross = e50[i-1]<=e200[i-1] and e50[i]>e200[i]
        if not cross: continue
        if adx[i]<20: continue   # ADX>20 gate (sticky approx: require current bar)
        pb=bull_prob(i)
        if pb is None: continue
        trades.append({"i":i,"px":closes[i],"prob":pb,
                       "year":datetime.datetime.utcfromtimestamp(bars[i]["time"]/1000).year})
    print(f"Trend-LONG entries (EMA cross + ADX>20): {len(trades)}")

    # simulate each trade: SL ATR×4→×3 @48h(12bar), TP +10%, maxHold 100
    def sim(t):
        ei=t["i"]; entry=t["px"]; a=atr[ei]
        tp=entry*1.10
        for h in range(1,101):
            j=ei+h
            if j>=n: break
            slmult=4 if h<12 else 3
            sl=entry - a*slmult
            lo=bars[j]["low"]; hi=bars[j]["high"]
            if lo<=sl:  # SL hit
                ret=(sl-entry)/entry; return ret, h
            if hi>=tp:
                ret=(tp-entry)/entry; return ret, h
        # timeout
        j=min(ei+100,n-1); return (closes[j]-entry)/entry, 100
    for t in trades:
        r,h=sim(t); t["ret"]=r - 2*FEE   # net both sides

    # conviction deciles
    probs=sorted(t["prob"] for t in trades)
    d9=probs[int(len(probs)*0.9)] if probs else 1.0
    for t in trades:
        t["cvx_qty"]= 2.0 if t["prob"]>=d9 else 1.0
        t["lin_qty"]= t["prob"]/0.5

    def report(name, qf):
        rets=[t["ret"] for t in trades]
        qs=[qf(t) for t in trades]
        # qty-weighted PnL (sum qty*ret) and per-trade RA on qty-weighted return
        pnl=sum(q*r for q,r in zip(qs,rets))
        wr=sum(1 for r in rets if r>0)/len(rets)*100
        m=pnl/sum(qs);
        wret=[q*r for q,r in zip(qs,rets)]
        mm=sum(wret)/len(wret); sd=(sum((x-mm)**2 for x in wret)/len(wret))**0.5 or 1e-9
        ra=mm/sd
        # per-year
        by=defaultdict(float)
        for t in trades: by[t["year"]]+=qf(t)*t["ret"]
        yrs=sorted(by); pos=sum(1 for y in yrs if by[y]>0)
        print(f"  {name:5s} PnL(qty·ret)={pnl*100:+7.2f}%  WR={wr:.0f}%  RA={ra:+.4f}  stability={pos}/{len(yrs)}  byYear=" + " ".join(f"{y}:{by[y]*100:+.0f}" for y in yrs))

    print("\n=== Sizing scheme comparison (cùng entry set, net-of-cost) ===")
    report("FLAT", lambda t:1.0)
    report("LIN",  lambda t:t["lin_qty"])
    report("CVX",  lambda t:t["cvx_qty"])
    print("\n  CVX win = PnL & RA cao hơn FLAT RÕ + stability không tệ đi. Nếu không → #1-convex KILL.")

if __name__=="__main__":
    main()
