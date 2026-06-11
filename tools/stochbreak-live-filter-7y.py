#!/usr/bin/env python3
"""
stochbreak-live-filter-7y.py — stochBreak LONG + EMA200d trendFilter (LIVE v0.4.100 faithful).
= stochbreak-live-7y.py + gate: chỉ vào LONG khi 1h close > EMA200(daily). Fail-closed nếu thiếu data 1d.
Khớp live: STOCHBREAK_TREND_FILTER on (sit-out bear 2026). SHORT=OFF. qty 0.001 BTC, fee 0.04%/side.
"""
import json, datetime as dt, bisect
from collections import defaultdict

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
QTY = 0.001
L_THR, L_HOLD, L_COOL = 20, 72, 12
MAX_CONC = 4
TAKER = 0.0004
H = 3600 * 1000

def agg(bars5, hours):
    out = []; span = hours * 3600 * 1000; cur = None
    for b in bars5:
        bucket = (b["time"] // span) * span
        if cur is None or bucket != cur["time"]:
            if cur: out.append(cur)
            cur = {"time": bucket, "open": b["open"], "high": b["high"], "low": b["low"], "close": b["close"]}
        else:
            cur["high"] = max(cur["high"], b["high"]); cur["low"] = min(cur["low"], b["low"]); cur["close"] = b["close"]
    if cur: out.append(cur)
    return out

def rsi_series(closes, p=14):
    n = len(closes); out = [None] * n
    if n < p + 1: return out
    g = l = 0.0
    for i in range(1, p + 1):
        ch = closes[i] - closes[i - 1]; g += max(ch, 0); l += max(-ch, 0)
    ag = g / p; al = l / p; out[p] = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
    for i in range(p + 1, n):
        ch = closes[i] - closes[i - 1]; ag = (ag * (p - 1) + max(ch, 0)) / p; al = (al * (p - 1) + max(-ch, 0)) / p
        out[i] = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
    return out

def stochrsi_k(closes, rp=14, sp=14, ks=3):
    rsi = rsi_series(closes, rp); n = len(closes); rawk = [None] * n
    for i in range(n):
        if rsi[i] is None: continue
        w = [rsi[j] for j in range(max(0, i - sp + 1), i + 1) if rsi[j] is not None]
        if len(w) < sp: continue
        lo = min(w); hi = max(w); rawk[i] = 100.0 if hi == lo else (rsi[i] - lo) / (hi - lo) * 100
    k = [None] * n
    for i in range(n):
        w = [rawk[j] for j in range(max(0, i - ks + 1), i + 1) if rawk[j] is not None]
        if len(w) == ks: k[i] = sum(w) / ks
    return k

def ema_series(xs, p):
    n = len(xs); out = [None] * n; e = None; k = 2 / (p + 1)
    for i in range(n):
        e = xs[i] if e is None else xs[i] * k + e * (1 - k); out[i] = e
    return out

print("Loading 5m cache..."); bars5 = json.load(open(CACHE))
print(f"  {len(bars5)} 5m bars")
b1 = agg(bars5, 1); b4 = agg(bars5, 4); b1d = agg(bars5, 24)
print(f"  1h={len(b1)} 4h={len(b4)} 1d={len(b1d)}")
c1 = [b["close"] for b in b1]; t1 = [b["time"] for b in b1]
c4 = [b["close"] for b in b4]; t4 = [b["time"] for b in b4]
cd = [b["close"] for b in b1d]; td = [b["time"] for b in b1d]
K = stochrsi_k(c1)
e200d = ema_series(cd, 200)

def j4_for(i):
    T = t1[i]; j = bisect.bisect_right(t4, T) - 1
    if j >= 0 and T < t4[j] + 4 * H - H + 1:
        if T < t4[j] + 3 * H: j -= 1
    return j

def ema200d_at(i):
    # latest CLOSED daily bar at 1h time t1[i]: daily bar ending at td[d]+24h <= t1[i]
    T = t1[i]; d = bisect.bisect_right(td, T) - 1
    # the containing daily bar [td[d],td[d]+24h) is closed only at its last hour → use d-1 if not closed
    if d >= 0 and T < td[d] + 24 * H - H + 1:
        if T < td[d] + 23 * H: d -= 1
    if d < 0 or e200d[d] is None: return None
    return e200d[d]

positions = []; trades = []; lastLongTs = -10**18
for i in range(len(b1)):
    positions = [p for p in positions if p["exit_idx"] > i]
    j = j4_for(i)
    if j < 5: continue
    mom_bull = c4[j] > c4[j - 5]
    Ki = K[i]
    if len(positions) < MAX_CONC and Ki is not None and Ki < L_THR and mom_bull and (t1[i] - lastLongTs) >= L_COOL * H:
        e2d = ema200d_at(i)
        if e2d is None: continue           # fail-closed: thiếu data 1d → skip
        if c1[i] <= e2d: continue           # trendFilter: chỉ LONG khi 1h close > EMA200d
        ex = min(i + L_HOLD, len(b1) - 1)
        fee = (c1[i] + c1[ex]) * QTY * TAKER
        pnl = QTY * (c1[ex] - c1[i]) - fee
        trades.append({"t": t1[i], "side": "LONG", "pnl": pnl})
        positions.append({"exit_idx": ex}); lastLongTs = t1[i]

yr = defaultdict(lambda: {"n": 0, "w": 0, "pnl": 0.0}); tot = {"n": 0, "w": 0, "pnl": 0.0}
for tr in trades:
    y = dt.datetime.utcfromtimestamp(tr["t"] / 1000).year
    for d in (yr[y], tot):
        d["n"] += 1; d["pnl"] += tr["pnl"]; d["w"] += 1 if tr["pnl"] > 0 else 0
print(f"\n=== STOCHBREAK + EMA200d filter 7y (NET fee {TAKER*100:.2f}%/side, 0.001 BTC, LONG-only=live v0.4.100) ===")
print(f"TOTAL: n={tot['n']}  PnL=${tot['pnl']:.2f}  WR={tot['w']/max(1,tot['n'])*100:.0f}%")
print("\n--- PER YEAR ---  year | n | WR% | PnL$")
for y in sorted(yr):
    d = yr[y]; print(f"  {y} | {d['n']:>4} | {d['w']/max(1,d['n'])*100:>3.0f}% | {d['pnl']:>+8.2f}")
posY = sum(1 for y in yr if yr[y]["pnl"] > 0)
print(f"\nStability: {posY}/{len(yr)} năm dương")
