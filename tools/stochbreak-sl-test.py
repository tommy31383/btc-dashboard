#!/usr/bin/env python3
"""
stochbreak-sl-test.py — test Lead-Architect proposal "add protective SL 2.5-3.0xATR" to stochbreak.
Faithful to stochbreak-live-filter-7y.py (LONG + EMA200d filter, K<20, mom4h, hold72, cool12, qty0.001, fee0.04%/side).
Adds intrabar 1h SL check: exit at entry - mult*ATR(14,1h) if any 1h low breaches it before the 72h time-exit.
Compares: none (LIVE) vs SL 3.0x vs SL 2.5x vs SL 2.0x. Judge DOLLARS + per-year + WR + #SL-hits.
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

def atr_series(bars, p=14):
    n = len(bars); out = [None] * n; trs = []
    for i in range(1, n):
        tr = max(bars[i]["high"] - bars[i]["low"], abs(bars[i]["high"] - bars[i-1]["close"]), abs(bars[i]["low"] - bars[i-1]["close"]))
        trs.append(tr)
    if len(trs) < p: return out
    a = sum(trs[:p]) / p; out[p] = a
    for i in range(p, len(trs)):
        a = (a * (p - 1) + trs[i]) / p; out[i + 1] = a
    return out

print("Loading 5m cache..."); bars5 = json.load(open(CACHE))
b1 = agg(bars5, 1); b4 = agg(bars5, 4); b1d = agg(bars5, 24)
c1 = [b["close"] for b in b1]; t1 = [b["time"] for b in b1]; l1 = [b["low"] for b in b1]
c4 = [b["close"] for b in b4]; t4 = [b["time"] for b in b4]
cd = [b["close"] for b in b1d]; td = [b["time"] for b in b1d]
K = stochrsi_k(c1); e200d = ema_series(cd, 200); atr1 = atr_series(b1, 14)

def j4_for(i):
    T = t1[i]; j = bisect.bisect_right(t4, T) - 1
    if j >= 0 and T < t4[j] + 4 * H - H + 1:
        if T < t4[j] + 3 * H: j -= 1
    return j

def ema200d_at(i):
    T = t1[i]; d = bisect.bisect_right(td, T) - 1
    if d >= 0 and T < td[d] + 24 * H - H + 1:
        if T < td[d] + 23 * H: d -= 1
    if d < 0 or e200d[d] is None: return None
    return e200d[d]

def run(sl_mult):
    positions = []; trades = []; lastLongTs = -10**18
    for i in range(len(b1)):
        positions = [p for p in positions if p["exit_idx"] > i]
        j = j4_for(i)
        if j < 5: continue
        mom_bull = c4[j] > c4[j - 5]; Ki = K[i]
        if len(positions) < MAX_CONC and Ki is not None and Ki < L_THR and mom_bull and (t1[i] - lastLongTs) >= L_COOL * H:
            e2d = ema200d_at(i)
            if e2d is None or c1[i] <= e2d: continue
            entry = c1[i]; ex = min(i + L_HOLD, len(b1) - 1)
            exit_px = c1[ex]; reason = "HOLD"
            if sl_mult > 0 and atr1[i] is not None:
                slpx = entry - sl_mult * atr1[i]
                for k in range(i + 1, ex + 1):
                    if l1[k] <= slpx:
                        exit_px = slpx; reason = "SL"; break
            fee = (entry + exit_px) * QTY * TAKER
            pnl = QTY * (exit_px - entry) - fee
            trades.append({"t": t1[i], "pnl": pnl, "reason": reason})
            positions.append({"exit_idx": ex}); lastLongTs = t1[i]
    return trades

print("\n=== STOCHBREAK protective-SL test (LONG+EMA200d filter, 0.001 BTC, fee 0.04%/side, 7y) ===")
print("variant   | n    | PnL$    | WR% | #SL-hit | stab | worst-year$")
for mult in [0.0, 3.0, 2.5, 2.0]:
    trs = run(mult)
    yr = defaultdict(float); n = len(trs); w = sum(1 for t in trs if t["pnl"] > 0)
    pnl = sum(t["pnl"] for t in trs); slhit = sum(1 for t in trs if t["reason"] == "SL")
    for t in trs: yr[dt.datetime.utcfromtimestamp(t["t"]/1000).year] += t["pnl"]
    stab = sum(1 for y in yr if yr[y] > 0); worst = min(yr.values()) if yr else 0
    name = "none(LIVE)" if mult == 0 else f"SL {mult:.1f}x"
    print(f"{name:<9} | {n:>4} | {pnl:>+7.2f} | {w/max(1,n)*100:>3.0f} | {slhit:>7} | {stab}/{len(yr)} | {worst:>+8.2f}")

print("\n--- PER YEAR (none vs SL 3.0x) ---  year | none$ | SL3.0$")
trN = run(0.0); tr3 = run(3.0)
yN = defaultdict(float); y3 = defaultdict(float)
for t in trN: yN[dt.datetime.utcfromtimestamp(t["t"]/1000).year] += t["pnl"]
for t in tr3: y3[dt.datetime.utcfromtimestamp(t["t"]/1000).year] += t["pnl"]
for y in sorted(set(yN) | set(y3)):
    print(f"  {y} | {yN[y]:>+7.2f} | {y3[y]:>+7.2f}")
