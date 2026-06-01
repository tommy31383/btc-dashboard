#!/usr/bin/env python3
"""
exp-cpd-edge-7y.py — Edge-discovery cho ĐỀ XUẤT #2 (changepoint detection).

Premise (Oxford-Man Wood/Roberts/Zohren): gần changepoint, momentum underperform,
mean-reversion outperform. CPD severity dùng để (a) GATE bớt trend entry lúc disequilibrium,
(b) OVERLAY mean-reversion flip.

Test 4h (đúng timeframe trend setup #12/#13/#14) trên 7y. KHÔNG đụng code live.
CPD severity = |mean(short window) - mean(long window)| / std(long)  (CUSUM-like, rẻ, O(N)).

Đo: trend-signal forward edge & mean-reversion forward edge, bucket theo CPD severity decile.
Nếu trend-edge KHÔNG degrade ở high-CPD và MR KHÔNG flip dương → #2 cũng vô nghĩa cho BTC.
"""
import json, math, datetime
from collections import defaultdict

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"

def load_tf(ms):
    raw = json.load(open(CACHE))
    buckets = {}
    for c in raw:
        k = c["time"] // ms
        if k not in buckets:
            buckets[k] = {"time": k*ms, "open": c["open"], "high": c["high"], "low": c["low"], "close": c["close"]}
        else:
            o = buckets[k]; o["high"]=max(o["high"],c["high"]); o["low"]=min(o["low"],c["low"]); o["close"]=c["close"]
    return [buckets[k] for k in sorted(buckets)]

def ema(xs, n):
    k = 2/(n+1); out=[None]*len(xs); e=None
    for i,x in enumerate(xs):
        e = x if e is None else x*k+e*(1-k); out[i]=e
    return out

def main():
    H4 = 4*3600*1000
    bars = load_tf(H4)
    closes = [b["close"] for b in bars]
    n = len(bars)
    print(f"4h bars: {n}  {datetime.datetime.utcfromtimestamp(bars[0]['time']/1000):%Y-%m-%d} → {datetime.datetime.utcfromtimestamp(bars[-1]['time']/1000):%Y-%m-%d}")

    e50 = ema(closes, 50); e200 = ema(closes, 200)
    SHORT, LONG = 10, 50
    rows=[]
    for i in range(n):
        if i < LONG+1 or e200[i] is None: continue
        ws = closes[i-SHORT+1:i+1]; wl = closes[i-LONG+1:i+1]
        ms_ = sum(ws)/SHORT; ml = sum(wl)/LONG
        sd = (sum((x-ml)**2 for x in wl)/LONG)**0.5 or 1e-9
        cpd = abs(ms_-ml)/sd                       # changepoint severity (CUSUM-like)
        trendSig = 1 if e50[i] > e200[i] else -1   # trend-follow signal (EMA cross proxy ~ setup #12)
        # mean-reversion signal: fade short-term move vs long mean
        mrSig = 1 if closes[i] < ml else -1
        rows.append({"i": i, "cpd": cpd, "trendSig": trendSig, "mrSig": mrSig})

    def fwd(i, h):  # forward return over h 4h-bars
        if i+h >= n: return None
        return (closes[i+h]-closes[i])/closes[i]

    H = 30  # 30 * 4h = 5 days fwd
    print(f"\nForward horizon = {H} bars (~{H*4/24:.0f}d). Strategy return = signal * fwd_return.\n")

    # bucket by CPD severity decile
    srt = sorted(rows, key=lambda r: r["cpd"])
    dec = [srt[j*len(srt)//10:(j+1)*len(srt)//10] for j in range(10)]
    print("=== Trend-follow vs Mean-reversion strategy return by CPD-severity decile ===")
    print("    (premise #2: trend ↓ và MR ↑ khi CPD cao)")
    print(f"    {'decile':6s} {'cpd~':>6s} {'n':>5s} {'TREND mean':>11s} {'TREND shrp':>11s} {'MR mean':>9s} {'MR shrp':>8s}")
    for j,grp in enumerate(dec):
        tv = [r["trendSig"]*fwd(r["i"],H) for r in grp if fwd(r["i"],H) is not None]
        mv = [r["mrSig"]*fwd(r["i"],H) for r in grp if fwd(r["i"],H) is not None]
        if not tv: continue
        tm=sum(tv)/len(tv); tsd=(sum((x-tm)**2 for x in tv)/len(tv))**0.5 or 1e-9
        mm=sum(mv)/len(mv); msd=(sum((x-mm)**2 for x in mv)/len(mv))**0.5 or 1e-9
        cpdm=sum(r["cpd"] for r in grp)/len(grp)
        print(f"    D{j+1:<5d} {cpdm:6.2f} {len(tv):5d} {tm*100:+10.2f}% {tm/tsd:+11.3f} {mm*100:+8.2f}% {mm/msd:+8.3f}")

    # top vs bottom CPD comparison
    lowT=[r["trendSig"]*fwd(r["i"],H) for r in dec[0]+dec[1] if fwd(r["i"],H) is not None]
    hiT =[r["trendSig"]*fwd(r["i"],H) for r in dec[8]+dec[9] if fwd(r["i"],H) is not None]
    hiMR=[r["mrSig"]*fwd(r["i"],H) for r in dec[8]+dec[9] if fwd(r["i"],H) is not None]
    def shrp(v): m=sum(v)/len(v); s=(sum((x-m)**2 for x in v)/len(v))**0.5 or 1e-9; return m/s
    print(f"\n=== Premise check ===")
    print(f"  TREND sharpe: low-CPD(D1-2)={shrp(lowT):+.3f}  vs  high-CPD(D9-10)={shrp(hiT):+.3f}  (degrade nếu high<low)")
    print(f"  MR    sharpe high-CPD(D9-10)={shrp(hiMR):+.3f}  (overlay value nếu >0 rõ)")
    if shrp(hiT) < shrp(lowT) - 0.05 and shrp(hiMR) > 0.05:
        print("  → CÓ DẤU HIỆU edge: trend degrade + MR flip ở high-CPD. Đáng build #2 + backtest net-of-cost.")
    else:
        print("  → KHÔNG rõ edge: CPD không tách trend/MR. #2 rủi ro cao, cân nhắc KILL.")

if __name__ == "__main__":
    main()
