#!/usr/bin/env python3
"""
hedge04 SHORT arm in BEAR context — mirror of hedge04 LONG/RANGE.
Direction 2 from MSG-005 exploration.

Entry signals (1h bars, SHORT only):
  S04B-S: BB(20,2) upper touch + bearish close → SL×2 TP×1.5 ATR_1h
  S04R-S: RSI(14) cross below 60 (prev>=60 cur<60) → SL×2 TP×1.0 ATR_1h
  S04K-S: Stoch K(14) cross below 80 (prev>=80 cur<80) → SL×2 TP×1.0 ATR_1h

4h Context gate (ALL required):
  - Regime = BEAR (classifier A, persistBars=1)
  - ADX(14) 4h > 20 sticky (current + prev bar)
  - Price <= EMA200 1h (inverse of LONG hedge04)

Also tests: BB-only diagnostic (no gate), and 7y stability.
"""
import json, datetime, os, math
from collections import defaultdict

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
OUT = "/Users/lap16116/BTC_PC/btc-dashboard/assets/backtest_hedge04_short_bear_2026.json"
Y0 = datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc).timestamp() * 1000
FEE = 0.05 / 100
CAP = 100_000

print("Loading 5m cache...")
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
            o["volume"] += c.get("volume", 0)
    return [b[k] for k in sorted(b)]

bars1h = build_tf(3_600_000)
bars4h = build_tf(14_400_000)
bars1d = build_tf(86_400_000)

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

def rsi(src, p=14):
    out = [None] * len(src)
    if len(src) < p + 1:
        return out
    g = l = 0.0
    for i in range(1, p + 1):
        d = src[i] - src[i - 1]
        if d > 0:
            g += d
        else:
            l -= d
    g /= p
    l /= p
    out[p] = 100 - 100 / (1 + g / l) if l else 100
    for i in range(p + 1, len(src)):
        d = src[i] - src[i - 1]
        g = (g * (p - 1) + max(d, 0)) / p
        l = (l * (p - 1) + max(-d, 0)) / p
        out[i] = 100 - 100 / (1 + g / l) if l else 100
    return out

def stoch_k(src, p=14):
    out = [None] * len(src)
    for i in range(p - 1, len(src)):
        w = src[i - p + 1:i + 1]
        lo, hi = min(w), max(w)
        out[i] = 50 if hi == lo else (src[i] - lo) / (hi - lo) * 100
    return out

def atr_bars(bars, p=14):
    out = [None] * len(bars)
    trs = []
    for i, b in enumerate(bars):
        if i == 0:
            tr = b["high"] - b["low"]
        else:
            pc = bars[i - 1]["close"]
            tr = max(b["high"] - b["low"], abs(b["high"] - pc), abs(b["low"] - pc))
        trs.append(tr)
        if i >= p - 1:
            if i == p - 1:
                out[i] = sum(trs[:p]) / p
            else:
                out[i] = (out[i - 1] * (p - 1) + tr) / p
    return out

def adx_wilder(bars, p=14):
    n = len(bars)
    out = [None] * n
    if n < p * 2 + 2:
        return out
    pdm = [0.0] * n
    ndm = [0.0] * n
    tr = [0.0] * n
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
        if adx is None:
            adx = sum(dxs) / p
        else:
            adx = (adx * (p - 1) + dx) / p
        out[i] = adx
    return out

def regime_with_persistence(persist_n=1):
    cs = [b["close"] for b in bars1d]
    n = len(bars1d)
    raw = ["RANGE"] * n
    for i in range(200, n):
        ma200 = sum(cs[i - 199:i + 1]) / 200
        ma50 = sum(cs[i - 50:i + 1]) / 50
        r20 = bars1d[i - 19:i + 1]
        ar = sum((b["high"] - b["low"]) / b["close"] for b in r20) / 20
        if cs[i] < ma200:
            raw[i] = "BEAR"
        elif cs[i] > ma50 and ma50 > ma200 and ar > 0.04:
            raw[i] = "BULL"
    out = ["RANGE"] * n
    cur = "RANGE"
    cnt = 0
    last_raw = "RANGE"
    for i in range(n):
        r = raw[i]
        if r == last_raw:
            cnt += 1
        else:
            cnt = 1
            last_raw = r
        if cnt >= persist_n:
            cur = r
        out[i] = cur
    return {bars1d[i]["time"] // 86_400_000: out[i] for i in range(n)}

reg_map = regime_with_persistence(1)

def get_regime(ts):
    return reg_map.get(ts // 86_400_000, "RANGE")

def yr(ts):
    return datetime.datetime.utcfromtimestamp(ts / 1000).year

def in_2026(ts):
    return ts >= Y0 and yr(ts) == 2026

c1 = [b["close"] for b in bars1h]
h1t = [b["time"] for b in bars1h]
rsi1 = rsi(c1, 14)
stk1 = stoch_k(c1, 14)
atr1 = atr_bars(bars1h, 14)
adx4h = adx_wilder(bars4h, 14)
e200_1h = ema(c1, 200)
ma20_1h = sma(c1, 20)
sd20 = [None] * len(c1)
for i in range(19, len(c1)):
    w = c1[i - 19:i + 1]
    m = sum(w) / 20
    sd20[i] = (sum((x - m) ** 2 for x in w) / 20) ** 0.5

def e200_1h_at(ts):
    lo, hi, idx = 0, len(h1t) - 1, 0
    while lo <= hi:
        m = (lo + hi) // 2
        if h1t[m] <= ts:
            idx = m
            lo = m + 1
        else:
            hi = m - 1
    return e200_1h[idx]

def run_short_backtest(bear_gate=True, adx_gate=True, ema_gate=True, signals=("BB", "RSI", "STK")):
    trades = []
    last_cd = {"BB": 0, "RSI": 0, "STK": 0}
    for i in range(220, len(bars1h) - 30):
        ts = bars1h[i]["time"]
        if bear_gate and get_regime(ts) != "BEAR":
            continue
        j4 = max(k for k, b in enumerate(bars4h) if b["time"] <= ts)
        if adx_gate:
            adx = adx4h[j4]
            adxp = adx4h[j4 - 1] if j4 else None
            if adx is None or adx <= 20 or adxp is None or adxp <= 20:
                continue
        if ema_gate:
            e1h = e200_1h_at(ts)
            if e1h is None or c1[i] > e1h:
                continue
        ae = atr1[i]
        if ae is None or ae <= 0:
            continue
        sig = None
        kind = None
        slm, tpm = 2.0, 1.5
        b = bars1h[i]
        if "BB" in signals and ma20_1h[i] and sd20[i]:
            bb_hi = ma20_1h[i] + 2 * sd20[i]
            if b["high"] >= bb_hi and b["close"] < b["open"] and ts - last_cd["BB"] >= 2 * 3600_000:
                sig = True
                kind = "S04B-S"
                slm, tpm = 2.0, 1.5
                last_cd["BB"] = ts
        if sig is None and "RSI" in signals and rsi1[i - 1] is not None and rsi1[i] is not None:
            if rsi1[i - 1] >= 60 and rsi1[i] < 60 and ts - last_cd["RSI"] >= 2 * 3600_000:
                sig = True
                kind = "S04R-S"
                slm, tpm = 2.0, 1.0
                last_cd["RSI"] = ts
        if sig is None and "STK" in signals and stk1[i - 1] is not None and stk1[i] is not None:
            if stk1[i - 1] >= 80 and stk1[i] < 80 and ts - last_cd["STK"] >= 2 * 3600_000:
                sig = True
                kind = "S04K-S"
                slm, tpm = 2.0, 1.0
                last_cd["STK"] = ts
        if not sig:
            continue
        ep = c1[i]
        sl = ep + ae * slm
        tp = ep - ae * tpm
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
        trades.append({"entry_ts": ts, "ret": ret, "kind": kind, "yr": yr(ts)})
    return trades

def summarize(name, entry_sig, trades):
    t2026 = [t for t in trades if in_2026(t["entry_ts"])]
    by_yr = defaultdict(float)
    by_yr_n = defaultdict(int)
    for t in trades:
        by_yr[t["yr"]] += t["ret"] * CAP
        by_yr_n[t["yr"]] += 1
    pos_yrs = sum(1 for v in by_yr.values() if v > 0)
    stab = pos_yrs / len(by_yr) if by_yr else 0
    if not t2026:
        return {
            "name": name, "entry": entry_sig, "n2026": 0, "wr": 0,
            "pnl_usd": 0, "pnl_pct": 0, "n7y": len(trades),
            "pnl_7y_usd": round(sum(t["ret"] for t in trades) * CAP, 0),
            "stab": round(stab, 2), "pos_yrs": pos_yrs, "by_yr": {str(k): round(v) for k, v in sorted(by_yr.items())},
            "note": "no 2026 entries",
        }
    rets = [t["ret"] for t in t2026]
    wins = sum(1 for r in rets if r > 0)
    pnl_pct = sum(rets) * 100
    pnl_usd = sum(rets) * CAP
    return {
        "name": name,
        "entry": entry_sig,
        "n2026": len(t2026),
        "wins": wins,
        "wr": round(wins / len(t2026) * 100, 1),
        "pnl_pct": round(pnl_pct, 2),
        "pnl_usd": round(pnl_usd, 0),
        "avg_ret_pct": round(pnl_pct / len(t2026), 3),
        "n7y": len(trades),
        "pnl_7y_usd": round(sum(t["ret"] for t in trades) * CAP, 0),
        "stab": round(stab, 2),
        "pos_yrs": pos_yrs,
        "by_yr": {str(k): round(v) for k, v in sorted(by_yr.items())},
    }

print("Running hedge04 SHORT variants...")
variants = [
    ("hedge04-S BEAR full", "BEAR+ADX+EMA200↓: BB upper / RSI60↓ / Stoch80↓",
     run_short_backtest(bear_gate=True, adx_gate=True, ema_gate=True)),
    ("hedge04-S BB only BEAR", "S04B-S only, BEAR+ADX+EMA200↓",
     run_short_backtest(bear_gate=True, adx_gate=True, ema_gate=True, signals=("BB",))),
    ("hedge04-S BB no gate", "S04B-S only, no regime/ADX gate — diagnostic",
     run_short_backtest(bear_gate=False, adx_gate=False, ema_gate=False, signals=("BB",))),
    ("hedge04-S BEAR no ADX", "BEAR+EMA200↓ only, all 3 signals",
     run_short_backtest(bear_gate=True, adx_gate=False, ema_gate=True)),
]

results = [summarize(n, e, t) for n, e, t in variants]

# Monthly 2026 breakdown for best variant
best_trades = variants[0][2]
months = defaultdict(lambda: {"n": 0, "wins": 0, "pnl": 0.0})
for t in best_trades:
    if not in_2026(t["entry_ts"]):
        continue
    m = datetime.datetime.utcfromtimestamp(t["entry_ts"] / 1000).strftime("%Y-%m")
    months[m]["n"] += 1
    months[m]["wins"] += 1 if t["ret"] > 0 else 0
    months[m]["pnl"] += t["ret"] * CAP

monthly = {m: {"n": d["n"], "wr": round(d["wins"] / d["n"] * 100, 1) if d["n"] else 0,
               "pnl_usd": round(d["pnl"], 0)} for m, d in sorted(months.items())}

out = {
    "generated": datetime.datetime.utcnow().isoformat() + "Z",
    "capital": CAP,
    "period": "hedge04 SHORT BEAR mirror — direction 2",
    "regime_note": "Classifier A persistBars=1 — 2026 = 100% BEAR",
    "monthly_2026_full": monthly,
    "results": sorted(results, key=lambda x: x.get("pnl_usd", 0), reverse=True),
}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
json.dump(out, open(OUT, "w"), indent=2)

print("\n=== hedge04 SHORT BEAR 2026 ===")
print(f"{'Rule':<28} | {'n26':>4} | {'WR%':>5} | {'PnL26$':>9} | {'7y$':>9} | {'stab':>4}")
for r in out["results"]:
    print(f"{r['name']:<28} | {r['n2026']:>4} | {r.get('wr',0):>5.1f} | "
          f"{r.get('pnl_usd',0):>+9.0f} | {r.get('pnl_7y_usd',0):>+9.0f} | {r.get('stab',0):>4.0%}")
print(f"\nWrote {OUT}")