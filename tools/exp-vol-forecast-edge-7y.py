#!/usr/bin/env python3
"""
exp-vol-forecast-edge-7y.py — Edge-discovery cho ĐỀ XUẤT #3 (vol nowcast → dynamic SL).

Câu hỏi: vol forecast (EWMA / HAR-RV) có dự báo realized vol TỐT HƠN ATR hiện tại không?
Nếu KHÔNG beat ATR → #3 vô nghĩa (ATR đã là vol proxy đủ tốt). Tier-1 HAR-RV trước,
foundation model chỉ nếu Tier-1 thắng.

Test 4h trên 7y. So predictor cho realized vol kỳ tới (next 6 bars = 1 ngày):
  (A) ATR%(14)        — baseline bot đang dùng
  (B) EWMA vol (lambda 0.94, RiskMetrics)
  (C) HAR-RV (realized vol daily/weekly/monthly components)
Đo: corr với realized fwd vol + MAE. Beat = corr cao hơn rõ + MAE thấp hơn.
"""
import json, math, datetime

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"

def load_tf(ms):
    raw = json.load(open(CACHE)); b={}
    for c in raw:
        k=c["time"]//ms
        if k not in b: b[k]={"time":k*ms,"high":c["high"],"low":c["low"],"close":c["close"],"prevc":None}
        else: o=b[k]; o["high"]=max(o["high"],c["high"]); o["low"]=min(o["low"],c["low"]); o["close"]=c["close"]
    return [b[k] for k in sorted(b)]

def main():
    H4=4*3600*1000
    bars=load_tf(H4); closes=[x["close"] for x in bars]; n=len(bars)
    print(f"4h bars: {n}  {datetime.datetime.utcfromtimestamp(bars[0]['time']/1000):%Y-%m-%d} → {datetime.datetime.utcfromtimestamp(bars[-1]['time']/1000):%Y-%m-%d}")
    rets=[0.0]+[ (closes[i]-closes[i-1])/closes[i-1] for i in range(1,n) ]

    # True Range % for ATR
    tr=[0.0]*n
    for i in range(1,n):
        hl=bars[i]["high"]-bars[i]["low"]
        hc=abs(bars[i]["high"]-closes[i-1]); lc=abs(bars[i]["low"]-closes[i-1])
        tr[i]=max(hl,hc,lc)/closes[i]
    def atr(i,p=14):
        if i<p: return None
        return sum(tr[i-p+1:i+1])/p

    # EWMA vol (RiskMetrics lambda=0.94)
    lam=0.94; ewma=[None]*n; v=None
    for i in range(1,n):
        v = rets[i]**2 if v is None else lam*v+(1-lam)*rets[i]**2
        ewma[i]=math.sqrt(v)

    # realized vol over window
    def rv(i,w):
        if i-w<0: return None
        seg=rets[i-w+1:i+1]; m=sum(seg)/w
        return math.sqrt(sum((x-m)**2 for x in seg)/w)

    # HAR-RV components: daily(6 bars), weekly(42), monthly(180)
    FWD=6  # forecast realized vol next 6 bars (~1 day)
    A=[];E=[];H=[];Y=[]  # predictors + target
    for i in range(200, n-FWD):
        a=atr(i); e=ewma[i]; rvd=rv(i,6); rvw=rv(i,42); rvm=rv(i,180)
        if None in (a,e,rvd,rvw,rvm): continue
        har=0.4*rvd+0.4*rvw+0.2*rvm   # simple fixed-weight HAR proxy (no regression fit → no lookahead)
        fwd=rv(i+FWD,FWD)             # realized vol of next window
        if fwd is None: continue
        A.append(a);E.append(e);H.append(har);Y.append(fwd)

    def corr(x,y):
        m=len(x); mx=sum(x)/m; my=sum(y)/m
        cov=sum((x[k]-mx)*(y[k]-my) for k in range(m))
        sx=math.sqrt(sum((x[k]-mx)**2 for k in range(m))); sy=math.sqrt(sum((y[k]-my)**2 for k in range(m)))
        return cov/(sx*sy) if sx*sy else 0
    def scale_mae(pred,tgt):  # scale pred to tgt mean then MAE (fair comparison of shape)
        s=(sum(tgt)/len(tgt))/(sum(pred)/len(pred))
        return sum(abs(pred[k]*s-tgt[k]) for k in range(len(tgt)))/len(tgt)

    print(f"\nn={len(Y)}  target=realized vol next {FWD} bars (~1d)")
    print(f"  {'predictor':10s} {'corr↑':>8s} {'MAE↓(scaled)':>13s}")
    for name,p in (("ATR%(14)",A),("EWMA.94",E),("HAR-RV",H)):
        print(f"  {name:10s} {corr(p,Y):+8.4f} {scale_mae(p,Y)*100:12.4f}%")

    cA=corr(A,Y); cBest=max(corr(E,Y),corr(H,Y))
    print(f"\n=== Verdict #3 ===")
    if cBest > cA + 0.03:
        print(f"  Vol-forecast (corr {cBest:+.3f}) BEAT ATR (corr {cA:+.3f}) → đáng test dynamic SL dùng vol-forecast.")
    else:
        print(f"  ATR (corr {cA:+.3f}) đã ~ bằng vol-forecast (corr {cBest:+.3f}) → #3 marginal, ATR đủ tốt. Cân nhắc KILL.")

if __name__ == "__main__":
    main()
