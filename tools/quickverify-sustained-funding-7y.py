#!/usr/bin/env python3
"""
quickverify-sustained-funding-7y.py — DỌN HÒM mũi ② (Sustained Funding Gate 24h).
Câu hỏi: khi funding > 0.05% DUY TRÌ liên tục ≥3 chu kỳ (24h), forward-return của BTC sau 48/72h
là DƯƠNG (parabolic FOMO → cấm/đóng LONG = giết profit) hay ÂM (exhaustion → gate có edge)?
So median forward-return của trigger vs baseline random. Honest: cần edge > fee để gate đáng làm.
"""
import json, bisect, statistics as st

C = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/"
btc = sorted(json.load(open(C + "binance-5m-7y.json")), key=lambda x: x["time"])
rf = json.load(open(C + "binance-funding-7y.json"))
fk = next(k for k in rf[0] if "time" in k.lower())
rk = next(k for k in ("fundingRate", "rate", "r", "funding") if k in rf[0])
fund = sorted(([int(e[fk]), float(e[rk])] for e in rf), key=lambda x: x[0])
ft = [x[0] for x in fund]

# BTC price lookup (5m close at/just-before t)
pt = [b["time"] for b in btc]; pc = [b["close"] for b in btc]
def price_at(t):
    i = bisect.bisect_right(pt, t) - 1
    return pc[i] if i >= 0 else None

H = 3600 * 1000
THR = 0.0005   # 0.05%
SUSTAIN = 3    # 3 chu kỳ 8h = 24h liên tục

# triggers: funding[i] và 2 chu kỳ trước đều > THR
trig_rets = {48: [], 72: []}
n_trig = 0
for i in range(SUSTAIN - 1, len(fund)):
    if all(fund[i - k][1] > THR for k in range(SUSTAIN)):
        t0 = fund[i][0]; p0 = price_at(t0)
        if p0 is None: continue
        n_trig += 1
        for h in (48, 72):
            pf = price_at(t0 + h * H)
            if pf is not None: trig_rets[h].append((pf - p0) / p0 * 100)

# baseline: random funding-period times (same count, deterministic stride)
base_rets = {48: [], 72: []}
seed = 7919
def rnd(n):
    global seed
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed % n
for _ in range(max(n_trig, 200)):
    j = rnd(len(fund)); t0 = fund[j][0]; p0 = price_at(t0)
    if p0 is None: continue
    for h in (48, 72):
        pf = price_at(t0 + h * H)
        if pf is not None: base_rets[h].append((pf - p0) / p0 * 100)

print("=== QUICK-VERIFY ② Sustained-Funding (>0.05% liên tục 24h) — forward BTC return 7y ===")
print(f"n triggers = {n_trig}  (funding>0.05% sustained 3×8h)")
print(f"{'horizon':>8} | {'med TRIG%':>10} | {'med BASE%':>10} | {'Δ(trig-base)%':>13} | verdict")
for h in (48, 72):
    mt = st.median(trig_rets[h]) if trig_rets[h] else 0
    mb = st.median(base_rets[h]) if base_rets[h] else 0
    d = mt - mb
    # gate cấm-LONG có edge nếu trigger forward ÂM rõ vs base (exhaustion). Nếu ≈0/dương → gate HẠI.
    v = "exhaustion (gate may help)" if d < -1.0 else ("FOMO continues — gate HẠI/null" if d > -1.0 else "")
    print(f"{h:>6}h | {mt:>+10.2f} | {mb:>+10.2f} | {d:>+13.2f} | {v}")
print("\nMean cũng kiểm tra (fat-tail):")
for h in (48, 72):
    mt = sum(trig_rets[h]) / len(trig_rets[h]) if trig_rets[h] else 0
    mb = sum(base_rets[h]) / len(base_rets[h]) if base_rets[h] else 0
    print(f"  {h}h: mean trig {mt:+.2f}% vs base {mb:+.2f}% → Δ {mt-mb:+.2f}%")
