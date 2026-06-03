#!/usr/bin/env python3
"""MUA khi GIẢM / BÁN khi TĂNG (mean-reversion) — gate CHỈ RANGE regime (nơi dip bật lại).
   dev = (close-EMA50_4h)/ATR. RANGE + dev<=-K → BUY (mua dip). RANGE + dev>=+K → SELL (bán rip).
   Exit: về EMA (mean) hoặc cut -CUT×ATR. Test BTC 7y. Judge ROI + Sharpe-vs-BH + per-year + WF.
"""
import json, datetime, sys, math
from collections import defaultdict
CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
def argf(n, d):
    for a in sys.argv:
        if a.startswith(f"--{n}="): return float(a.split("=")[1])
    return d
K = argf("k", 2.0); CUT = argf("cut", 3.0); TS = int(argf("ts", 48)); CD = int(argf("cd", 1))
TOMEAN = "--notomean" not in sys.argv  # default: thoát về EMA. --notomean = dùng TP×ATR
TP = argf("tp", 2.0)
FEE = 0.0005
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
# regime daily: BEAR c<MA200 / BULL c>MA50&MA50>MA200&trending / else RANGE
DC = [x["c"] for x in BD]; nd = len(BD); dreg = ["RANGE"] * nd
for i in range(200, nd):
    ma200 = sum(DC[i - 199:i + 1]) / 200; ma50 = sum(DC[i - 49:i + 1]) / 50
    ar = sum((BD[j]["h"] - BD[j]["l"]) / BD[j]["c"] for j in range(i - 19, i + 1)) / 20
    if DC[i] < ma200: dreg[i] = "BEAR"
    elif DC[i] > ma50 and ma50 > ma200 and ar > 0.04: dreg[i] = "BULL"
import bisect
DT = [x["t"] for x in BD]
def regime(ts):
    di = bisect.bisect_right(DT, ts) - 2   # D-1 đã đóng
    return dreg[di] if 0 <= di < nd else "RANGE"

trades = []; pos = None; last = -10**9
for i in range(60, n - 1):
    if pos is not None:
        e, a, sd = pos["e"], pos["a"], pos["s"]; bar = B4[i]; ex = None
        if sd == "LONG":
            if bar["l"] <= e - a * CUT: ex = e - a * CUT
            elif TOMEAN and e50[i] is not None and bar["h"] >= e50[i]: ex = e50[i]   # về mean
            elif (not TOMEAN) and bar["h"] >= e + a * TP: ex = e + a * TP
        else:
            if bar["h"] >= e + a * CUT: ex = e + a * CUT
            elif TOMEAN and e50[i] is not None and bar["l"] <= e50[i]: ex = e50[i]
            elif (not TOMEAN) and bar["l"] <= e - a * TP: ex = e - a * TP
        if ex is None and (i - pos["i"]) >= TS // 4: ex = C4[i]
        if ex is not None:
            r = (ex - e) / e if sd == "LONG" else (e - ex) / e; r -= 2 * FEE
            trades.append({"r": r, "yr": datetime.datetime.utcfromtimestamp(bar["t"] / 1000).year, "s": sd}); pos = None
        continue
    if i - last < CD or e50[i] is None or atr4[i] is None or atr4[i] <= 0: continue
    if regime(B4[i]["t"]) != "RANGE": continue   # CHỈ mean-rev trong RANGE
    dev = (C4[i] - e50[i]) / atr4[i]; sig = None
    if dev <= -K: sig = "LONG"      # mua khi GIẢM (dip dưới mean)
    elif dev >= K: sig = "SHORT"    # bán khi TĂNG (rip trên mean)
    if sig: pos = {"e": C4[i], "a": atr4[i], "s": sig, "i": i}; last = i

N = len(trades)
if N == 0: print("NO TRADES"); sys.exit()
rets = [t["r"] for t in trades]; mean = sum(rets) / N; sd = (sum((r - mean) ** 2 for r in rets) / N) ** 0.5 or 1e-9
ra = mean / sd; wr = sum(1 for r in rets if r > 0) / N * 100
byyr = defaultdict(float)
for t in trades: byyr[t["yr"]] += t["r"] * 100
stab = sum(1 for y in byyr if byyr[y] > 0); tot = sum(rets) * 100
trn = [t["r"] for t in trades if t["yr"] < 2023]; te = [t["r"] for t in trades if t["yr"] >= 2023]
raf = lambda x: (sum(x) / len(x)) / ((sum((v - sum(x) / len(x)) ** 2 for v in x) / len(x)) ** 0.5 or 1e-9) if len(x) >= 5 else 0
print(f"[RANGE MEAN-REV (mua giảm/bán tăng) K={K} cut{CUT} {'toMean' if TOMEAN else f'TP{TP}'} ts{TS}h]")
print(f"  n={N} ({N // 8}/yr)  WR={wr:.0f}%  RA={ra:.3f}  ROI-sum={tot:+.0f}%  stab={stab}/{len(byyr)}  WF TRAIN={raf(trn):.3f} TEST={raf(te):.3f}")
for s in ("LONG", "SHORT"):
    cs = [t for t in trades if t["s"] == s]
    if cs: print(f"    {s}: n={len(cs)} WR={sum(1 for t in cs if t['r'] > 0) / len(cs) * 100:.0f}% ROI={sum(t['r'] for t in cs) * 100:+.0f}%")
print("  per-year ROI%: " + " ".join(f"{y}:{byyr[y]:+.0f}" for y in sorted(byyr)))
