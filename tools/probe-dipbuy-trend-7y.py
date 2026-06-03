#!/usr/bin/env python3
"""Phương pháp XÁC ĐỊNH đáy/đỉnh: giá lệch K×ATR dưới EMA50-4h (oversold=đáy) + 1d-uptrend → BUY;
   lệch lên trong 1d-downtrend → SELL. Cut+TP. Test BTC 7y. Judge dollars + Sharpe-vs-BH + per-year.
"""
import json, datetime, sys, math
from collections import defaultdict
CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
def argf(n, d):
    for a in sys.argv:
        if a.startswith(f"--{n}="): return float(a.split("=")[1])
    return d
K = argf("k", 2.0); CUT = argf("cut", 2.0); TP = argf("tp", 3.0); TS = int(argf("ts", 48)); CD = int(argf("cd", 2))
FEE = 0.0005; QTY = 0.003
raw = json.load(open(CACHE)); raw.sort(key=lambda x: x["time"])
def agg(ms):
    b = {}
    for c in raw:
        k = c["time"] // ms
        if k not in b: b[k] = {"t": k * ms, "h": c["high"], "l": c["low"], "c": c["close"]}
        else:
            o = b[k]; o["h"] = max(o["h"], c["high"]); o["l"] = min(o["l"], c["low"]); o["c"] = c["close"]
    return [b[k] for k in sorted(b)]
B4 = agg(4 * 3600_000); BD = agg(86400_000); n = len(B4); C4 = [x["c"] for x in B4]
def ema(xs, p):
    k = 2 / (p + 1); o = [None] * len(xs); e = None
    for i, x in enumerate(xs): e = x if e is None else x * k + e * (1 - k); o[i] = e
    return o
def atr_w(B, p=14):
    m = len(B); tr = [0.] * m
    for i in range(1, m): tr[i] = max(B[i]["h"] - B[i]["l"], abs(B[i]["h"] - B[i - 1]["c"]), abs(B[i]["l"] - B[i - 1]["c"]))
    o = [None] * m; o[p] = sum(tr[1:p + 1]) / p
    for i in range(p + 1, m): o[i] = (o[i - 1] * (p - 1) + tr[i]) / p
    return o
e50 = ema(C4, 50); atr4 = atr_w(B4)
ema50d = ema([x["c"] for x in BD], 50)
import bisect
DT = [x["t"] for x in BD]
def trend_up(ts):
    di = bisect.bisect_right(DT, ts) - 2  # daily D-1 (đã đóng)
    if di < 0 or ema50d[di] is None: return None
    return BD[di]["c"] > ema50d[di]

trades = []; pos = None; last = -10**9
for i in range(60, n - 1):
    if pos is not None:
        e, a, sd = pos["e"], pos["a"], pos["s"]; bar = B4[i]; ex = None
        if sd == "LONG":
            if bar["l"] <= e - a * CUT: ex = e - a * CUT
            elif bar["h"] >= e + a * TP: ex = e + a * TP
        else:
            if bar["h"] >= e + a * CUT: ex = e + a * CUT
            elif bar["l"] <= e - a * TP: ex = e - a * TP
        if ex is None and (i - pos["i"]) >= TS // 4: ex = C4[i]
        if ex is not None:
            r = (ex - e) / e if sd == "LONG" else (e - ex) / e; r -= 2 * FEE
            trades.append({"r": r, "yr": datetime.datetime.utcfromtimestamp(bar["t"] / 1000).year, "s": sd}); pos = None
        continue
    if i - last < CD or e50[i] is None or atr4[i] is None or atr4[i] <= 0: continue
    dev = (C4[i] - e50[i]) / atr4[i]; tu = trend_up(B4[i]["t"])
    if tu is None: continue
    sig = None
    if dev <= -K and tu: sig = "LONG"        # đáy xác định trong uptrend
    elif dev >= K and not tu: sig = "SHORT"   # đỉnh xác định trong downtrend
    if sig: pos = {"e": C4[i], "a": atr4[i], "s": sig, "i": i}; last = i

N = len(trades)
if N == 0: print("NO TRADES"); sys.exit()
# daily M2M Sharpe-vs-BH (xấp xỉ: dùng per-trade return làm series)
rets = [t["r"] for t in trades]; mean = sum(rets) / N; sd = (sum((r - mean) ** 2 for r in rets) / N) ** 0.5 or 1e-9
ra = mean / sd; wr = sum(1 for r in rets if r > 0) / N * 100
byyr = defaultdict(float)
for t in trades: byyr[t["yr"]] += t["r"] * 100
stab = sum(1 for y in byyr if byyr[y] > 0)
tot = sum(rets) * 100
trn = [t["r"] for t in trades if t["yr"] < 2023]; te = [t["r"] for t in trades if t["yr"] >= 2023]
raf = lambda x: (sum(x) / len(x)) / ((sum((v - sum(x) / len(x)) ** 2 for v in x) / len(x)) ** 0.5 or 1e-9) if len(x) >= 5 else 0
print(f"[DIP-BUY/RIP-SELL  K={K} cut{CUT} tp{TP} ts{TS}h]")
print(f"  n={N} ({N // 8}/yr)  WR={wr:.0f}%  RA={ra:.3f}  ROI-sum={tot:+.0f}%  stab={stab}/{len(byyr)}")
print(f"  WF TRAIN RA={raf(trn):.3f}  TEST RA={raf(te):.3f}")
for s in ("LONG", "SHORT"):
    cs = [t for t in trades if t["s"] == s]
    if cs: print(f"    {s}: n={len(cs)} WR={sum(1 for t in cs if t['r'] > 0) / len(cs) * 100:.0f}% ROI={sum(t['r'] for t in cs) * 100:+.0f}%")
print("  per-year ROI%: " + " ".join(f"{y}:{byyr[y]:+.0f}" for y in sorted(byyr)))
