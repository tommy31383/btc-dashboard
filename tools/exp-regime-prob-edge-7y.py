#!/usr/bin/env python3
"""
exp-regime-prob-edge-7y.py — Edge-discovery cho ĐỀ XUẤT #1 (regime-probability sizing).

Câu hỏi: regime-probability (continuous) có phân tách forward return/vol của BTC không?
Nếu KHÔNG → #1 vô nghĩa (kill rẻ trước khi build full integration).

Test trên 7y 1d (resample từ 5m-7y). KHÔNG đụng code live.
So sánh:
  (A) binary regime hiện tại (detectRegime: BEAR nếu close<MA200; BULL nếu close>MA50>MA200 & avgRange>4%)
  (B) continuous bullProb = sigmoid của (z-score close vs MA200 + slope MA50 + trend strength)
Đo: forward 5d/20d LONG return & realized vol, bucket theo regime và theo bullProb-decile.
"""
import json, math, datetime
from collections import defaultdict

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"

def load_1d():
    raw = json.load(open(CACHE))
    # resample 5m -> 1d
    days = {}
    for c in raw:
        d = c["time"] // 86400000
        if d not in days:
            days[d] = {"time": d*86400000, "open": c["open"], "high": c["high"],
                       "low": c["low"], "close": c["close"], "volume": c["volume"]}
        else:
            o = days[d]
            o["high"] = max(o["high"], c["high"]); o["low"] = min(o["low"], c["low"])
            o["close"] = c["close"]; o["volume"] += c["volume"]
    return [days[k] for k in sorted(days)]

def sma(xs, i, n):
    if i+1 < n: return None
    return sum(xs[i-n+1:i+1]) / n

def main():
    bars = load_1d()
    closes = [b["close"] for b in bars]
    n = len(bars)
    print(f"1d bars: {n}  {datetime.datetime.utcfromtimestamp(bars[0]['time']/1000):%Y-%m-%d} → {datetime.datetime.utcfromtimestamp(bars[-1]['time']/1000):%Y-%m-%d}")

    # rolling std of close for z-score (window 200)
    rows = []
    for i in range(n):
        ma200 = sma(closes, i, 200); ma50 = sma(closes, i, 50)
        if ma200 is None or ma50 is None or i < 200: continue
        # std of last 200 closes
        w = closes[i-199:i+1]; mean = sum(w)/200
        std = math.sqrt(sum((x-mean)**2 for x in w)/200) or 1.0
        z = (closes[i] - ma200) / std
        slope50 = (ma50 - sma(closes, i-5, 50)) / ma50 if sma(closes, i-5, 50) else 0
        # avg daily range last 20
        r20 = bars[i-19:i+1]; avgRange = sum((b["high"]-b["low"])/b["close"] for b in r20)/20
        # --- (A) binary regime (replicate detectRegime) ---
        if closes[i] < ma200: reg = "BEAR"
        elif closes[i] > ma50 and ma50 > ma200 and avgRange > 0.04: reg = "BULL"
        else: reg = "RANGE"
        # --- (B) continuous bullProb: sigmoid(combo) ---
        score = 1.2*z + 30*slope50  # z + slope tilt
        bullProb = 1/(1+math.exp(-score))
        rows.append({"i": i, "close": closes[i], "reg": reg, "bullProb": bullProb,
                     "year": datetime.datetime.utcfromtimestamp(bars[i]["time"]/1000).year})

    # forward returns
    def fwd_ret(i, h):
        if i+h >= n: return None
        return (closes[i+h] - closes[i]) / closes[i]

    # bucket by binary regime
    print("\n=== (A) Forward LONG return by BINARY regime ===")
    for h in (5, 20):
        agg = defaultdict(list)
        for r in rows:
            fr = fwd_ret(r["i"], h)
            if fr is not None: agg[r["reg"]].append(fr)
        print(f"  horizon {h}d:")
        for reg in ("BULL","RANGE","BEAR"):
            v = agg[reg]
            if not v: continue
            mean = sum(v)/len(v); sd = (sum((x-mean)**2 for x in v)/len(v))**0.5 or 1e-9
            print(f"    {reg:6s} n={len(v):5d} mean={mean*100:+6.2f}%  sharpe(per-step)={mean/sd:+.3f}  win={sum(1 for x in v if x>0)/len(v)*100:.0f}%")

    # bucket by bullProb decile
    print("\n=== (B) Forward LONG return by bullProb DECILE (monotonic = có edge) ===")
    for h in (5, 20):
        srt = sorted(rows, key=lambda r: r["bullProb"])
        dec = [srt[j*len(srt)//10:(j+1)*len(srt)//10] for j in range(10)]
        print(f"  horizon {h}d:")
        for j,grp in enumerate(dec):
            v = [fwd_ret(r["i"], h) for r in grp]; v = [x for x in v if x is not None]
            if not v: continue
            mean = sum(v)/len(v); sd = (sum((x-mean)**2 for x in v)/len(v))**0.5 or 1e-9
            pr = sum(r["bullProb"] for r in grp)/len(grp)
            print(f"    D{j+1} prob~{pr:.2f} n={len(v):4d} mean={mean*100:+6.2f}% sharpe={mean/sd:+.3f} win={sum(1 for x in v if x>0)/len(v)*100:.0f}%")

    # Spearman-ish: does bullProb rank-correlate with fwd 20d return?
    h=20
    pairs = [(r["bullProb"], fwd_ret(r["i"], h)) for r in rows if fwd_ret(r["i"],h) is not None]
    pr = [p for p,_ in pairs]; fr = [f for _,f in pairs]
    def rank(xs):
        order = sorted(range(len(xs)), key=lambda k: xs[k]); rk=[0]*len(xs)
        for pos,k in enumerate(order): rk[k]=pos
        return rk
    rp, rf = rank(pr), rank(fr); m=len(rp)
    mp=sum(rp)/m; mf=sum(rf)/m
    cov=sum((rp[k]-mp)*(rf[k]-mf) for k in range(m))
    sp=math.sqrt(sum((rp[k]-mp)**2 for k in range(m))); sf=math.sqrt(sum((rf[k]-mf)**2 for k in range(m)))
    rho = cov/(sp*sf) if sp*sf else 0
    print(f"\n=== Spearman rank-corr(bullProb, fwd{h}d return) = {rho:+.4f} ===")
    print("    |rho|<0.05 → bullProb KHÔNG có sức phân tách → #1 vô nghĩa, KILL.")

if __name__ == "__main__":
    main()
