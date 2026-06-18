#!/usr/bin/env python3
"""Faithful backtest for new SHORT rules — mirrors hedge04s.ts + shortBreakdown.ts logic."""
import json, datetime, os
from collections import defaultdict

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
OUT = "/Users/lap16116/BTC_PC/btc-dashboard/assets/backtest_short_rules_faithful_2026.json"
Y0 = datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc).timestamp() * 1000
FEE = 0.05 / 100
CAP = 100_000

raw = json.load(open(CACHE))
raw.sort(key=lambda x: x["time"])

def build_tf(ms):
    b = {}
    for c in raw:
        k = c["time"] // ms
        if k not in b:
            b[k] = {"time": k * ms, "open": c["open"], "high": c["high"],
                    "low": c["low"], "close": c["close"], "volume": c.get("volume", 0)}
        else:
            o = b[k]
            o["high"] = max(o["high"], c["high"])
            o["low"] = min(o["low"], c["low"])
            o["close"] = c["close"]
    return [b[k] for k in sorted(b)]

bars1h = build_tf(3_600_000)
bars4h = build_tf(14_400_000)
bars1d = build_tf(86_400_000)
c1 = [b["close"] for b in bars1h]
h1t = [b["time"] for b in bars1h]
idx4h = {b["time"]: i for i, b in enumerate(bars4h)}

def ema(src, p):
    out = [None] * len(src)
    k = 2 / (p + 1)
    e = None
    for i, x in enumerate(src):
        e = x if e is None else x * k + e * (1 - k)
        out[i] = e
    return out

def sma(src, p):
    out = [None] * len(src)
    for i in range(p - 1, len(src)):
        out[i] = sum(src[i - p + 1:i + 1]) / p
    return out

def atr_bars(bars, p=14):
    out = [None] * len(bars)
    for i, b in enumerate(bars):
        if i == 0:
            tr = b["high"] - b["low"]
        else:
            pc = bars[i - 1]["close"]
            tr = max(b["high"] - b["low"], abs(b["high"] - pc), abs(b["low"] - pc))
        if i >= p - 1:
            if i == p - 1:
                out[i] = sum(max(bars[j]["high"] - bars[j]["low"],
                                 abs(bars[j]["high"] - bars[j - 1]["close"]) if j else 0,
                                 abs(bars[j]["low"] - bars[j - 1]["close"]) if j else 0)
                                 for j in range(1, p + 1)) / p
            else:
                prev = out[i - 1]
                out[i] = (prev * (p - 1) + tr) / p
    return out

def adx_wilder(bars, p=14):
    n = len(bars)
    out = [None] * n
    if n < p * 2 + 2:
        return out
    tr = [0.0] * n
    pdm = [0.0] * n
    ndm = [0.0] * n
    for i in range(1, n):
        up = bars[i]["high"] - bars[i - 1]["high"]
        dn = bars[i - 1]["low"] - bars[i]["low"]
        pdm[i] = up if up > dn and up > 0 else 0
        ndm[i] = dn if dn > up and dn > 0 else 0
        tr[i] = max(bars[i]["high"] - bars[i]["low"],
                    abs(bars[i]["high"] - bars[i - 1]["close"]),
                    abs(bars[i]["low"] - bars[i - 1]["close"]))
    sm_tr = sum(tr[i] for i in range(1, p + 1))
    sm_p = sum(pdm[i] for i in range(1, p + 1))
    sm_n = sum(ndm[i] for i in range(1, p + 1))
    adx = None
    dxs = []
    for i in range(p + 1, n):
        sm_tr = sm_tr - sm_tr / p + tr[i]
        sm_p = sm_p - sm_p / p + pdm[i]
        sm_n = sm_n - sm_n / p + ndm[i]
        pdi = sm_p / sm_tr * 100 if sm_tr else 0
        ndi = sm_n / sm_tr * 100 if sm_tr else 0
        dx = abs(pdi - ndi) / (pdi + ndi) * 100 if (pdi + ndi) else 0
        dxs.append(dx)
        if len(dxs) < p:
            continue
        adx = sum(dxs) / p if adx is None else (adx * (p - 1) + dx) / p
        out[i] = adx
    return out

def regime_map(persist=1):
    cs = [b["close"] for b in bars1d]
    n = len(bars1d)
    raw_r = ["RANGE"] * n
    for i in range(200, n):
        ma200 = sum(cs[i - 199:i + 1]) / 200
        ma50 = sum(cs[i - 50:i + 1]) / 50
        r20 = bars1d[i - 19:i + 1]
        ar = sum((b["high"] - b["low"]) / b["close"] for b in r20) / 20
        if cs[i] < ma200:
            raw_r[i] = "BEAR"
        elif cs[i] > ma50 and ma50 > ma200 and ar > 0.04:
            raw_r[i] = "BULL"
    out = ["RANGE"] * n
    cur, cnt, lr = "RANGE", 0, "RANGE"
    for i in range(n):
        r = raw_r[i]
        cnt = cnt + 1 if r == lr else 1
        lr = r
        if cnt >= persist:
            cur = r
        out[i] = cur
    return {bars1d[i]["time"] // 86_400_000: out[i] for i in range(n)}

reg = regime_map(1)
e200 = ema(c1, 200)
ma20 = sma(c1, 20)
sd20 = [None] * len(c1)
for i in range(19, len(c1)):
    w = c1[i - 19:i + 1]
    m = sum(w) / 20
    sd20[i] = (sum((x - m) ** 2 for x in w) / 20) ** 0.5
atr1 = atr_bars(bars1h, 14)
adx4 = adx_wilder(bars4h, 14)
c4 = [b["close"] for b in bars4h]

def yr(ts):
    return datetime.datetime.utcfromtimestamp(ts / 1000).year

def summarize(trades, name):
    by_yr = defaultdict(float)
    for t in trades:
        by_yr[t["yr"]] += t["ret"] * CAP
    t26 = [t for t in trades if t["yr"] == 2026]
    pos = sum(1 for v in by_yr.values() if v > 0)
    return {
        "name": name,
        "n2026": len(t26),
        "wr2026": round(sum(1 for t in t26 if t["ret"] > 0) / len(t26) * 100, 1) if t26 else 0,
        "pnl_2026": round(sum(t["ret"] for t in t26) * CAP, 0),
        "pnl_7y": round(sum(t["ret"] for t in trades) * CAP, 0),
        "stab": f"{pos}/{len(by_yr)}",
        "by_yr": {str(k): round(v) for k, v in sorted(by_yr.items())},
    }

# hedge04s faithful
h04s = []
last_bb = 0
for i in range(220, len(bars1h) - 30):
    ts = bars1h[i]["time"]
    if reg.get(ts // 86_400_000) != "BEAR":
        continue
    j4 = max(k for k, b in enumerate(bars4h) if b["time"] <= ts)
    if adx4[j4] is None or adx4[j4] <= 20 or adx4[j4 - 1] is None or adx4[j4 - 1] <= 20:
        continue
    if e200[i] is None or c1[i] > e200[i]:
        continue
    ae = atr1[i]
    if ae is None or ae <= 0:
        continue
    b = bars1h[i]
    if not (ma20[i] and sd20[i]):
        continue
    bb_hi = ma20[i] + 2 * sd20[i]
    if b["high"] < bb_hi or b["close"] >= b["open"] or ts - last_bb < 2 * 3600_000:
        continue
    last_bb = ts
    ep = c1[i]
    sl, tp = ep + ae * 2, ep - ae * 1.5
    ret = None
    for h in range(1, 25):
        j = i + h
        if j >= len(bars1h):
            break
        bh = bars1h[j]
        if bh["high"] >= sl:
            ret = (ep - sl) / ep - 2 * FEE
            break
        if bh["low"] <= tp:
            ret = (ep - tp) / ep - 2 * FEE
            break
    if ret is None:
        j = min(i + 24, len(bars1h) - 1)
        ret = (ep - c1[j]) / ep - 2 * FEE
    h04s.append({"yr": yr(ts), "ret": ret})

# shortBreakdown faithful
sbd = []
last_bd = 0
LB, HOLD, COOL = 3, 9, 6
for i in range(25, len(bars1h) - HOLD - 2):
    ts = bars1h[i]["time"]
    if ts - last_bd < COOL * 3600_000:
        continue
    price = c1[i]
    if price >= min(c1[i - LB:i]):
        continue
    if c1[i] >= bars1h[i]["open"]:
        continue
    bt = (ts // 14_400_000) * 14_400_000
    j4 = idx4h.get(bt)
    if j4 is None or j4 < 5:
        continue
    lb4 = max(1, LB // 4)
    if c4[j4] >= c4[j4 - lb4] or c4[j4] >= c4[j4 - 5]:
        continue
    ep = price
    ret = (ep - c1[i + HOLD]) / ep - 2 * FEE if i + HOLD < len(c1) else None
    if ret is None:
        continue
    last_bd = ts
    sbd.append({"yr": yr(ts), "ret": ret})

out = {
    "generated": datetime.datetime.utcnow().isoformat() + "Z",
    "note": "Faithful mirror of hedge04s.ts + shortBreakdown.ts",
    "results": [summarize(h04s, "hedge04s faithful"), summarize(sbd, "shortBreakdown faithful")],
}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
json.dump(out, open(OUT, "w"), indent=2)
for r in out["results"]:
    print(f"{r['name']}: 2026 n={r['n2026']} WR={r['wr2026']}% PnL=${r['pnl_2026']:,.0f} | 7y=${r['pnl_7y']:,.0f} stab={r['stab']}")
print(f"Wrote {OUT}")