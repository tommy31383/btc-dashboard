#!/usr/bin/env python3
"""2026 YTD backtest — top 5 distinctive-entry candidates. Output JSON + print table."""
import json, datetime, os, sys
from collections import defaultdict

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
OUT = "/Users/lap16116/BTC_PC/btc-dashboard/assets/backtest_2026_ytd_top5.json"
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

def yr(ts): return datetime.datetime.utcfromtimestamp(ts / 1000).year
def in_2026(ts): return ts >= Y0 and yr(ts) == 2026

# ── indicators ──
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
    if len(src) < p + 1: return out
    g = l = 0.0
    for i in range(1, p + 1):
        d = src[i] - src[i - 1]
        if d > 0: g += d
        else: l -= d
    g /= p; l /= p
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
    if n < p * 2 + 2: return out
    pdm = [0.0] * n; ndm = [0.0] * n; tr = [0.0] * n
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
        if len(dxs) < p: continue
        if adx is None:
            adx = sum(dxs) / p
        else:
            adx = (adx * (p - 1) + dx) / p
        out[i] = adx
    return out

# regime A + persistBars=1 (match regime.ts / REGIME_CLASSIFIER_v1)
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
    cur = "RANGE"; cnt = 0; last_raw = "RANGE"
    for i in range(n):
        r = raw[i]
        if r == last_raw: cnt += 1
        else: cnt = 1; last_raw = r
        if cnt >= persist_n: cur = r
        out[i] = cur
    return {bars1d[i]["time"] // 86_400_000: out[i] for i in range(n)}

reg_map = regime_with_persistence(1)

def get_regime(ts):
    return reg_map.get(ts // 86_400_000, "RANGE")

def htf_flat_1h(i):
    """4h + 1d both flat: |close-EMA20|/EMA20 < 0.3% on 4h and 1d proxy."""
    t = bars1h[i]["time"]
    # find 4h idx
    j = max(k for k, b in enumerate(bars4h) if b["time"] <= t)
    c4 = [b["close"] for b in bars4h]
    e20_4 = ema(c4, 20)[j]
    if e20_4 is None: return False
    flat4 = abs(c4[j] - e20_4) / e20_4 < 0.003
    reg = get_regime(t)
    return flat4 and reg == "RANGE"

def summarize(name, entry_sig, trades):
    t2026 = [t for t in trades if in_2026(t["entry_ts"])]
    if not t2026:
        return {"name": name, "entry": entry_sig, "n2026": 0, "wr": 0, "pnl_usd": 0, "pnl_pct": 0, "note": "no 2026 entries"}
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
    }

results = []

# ── 1. hedge01 S13/S14 RANGE (4h) ──
print("Running hedge01 trend...")
c4 = [b["close"] for b in bars4h]
e50 = ema(c4, 50); e200 = ema(c4, 200)
atr4 = atr_bars(bars4h, 12)
adx4 = adx_wilder(bars4h, 12)
c1h = [b["close"] for b in bars1h]
e200_1h = ema(c1h, 200)
h1t = [b["time"] for b in bars1h]

def e200_1h_at(ts):
    lo, hi, idx = 0, len(h1t) - 1, 0
    while lo <= hi:
        m = (lo + hi) // 2
        if h1t[m] <= ts: idx = m; lo = m + 1
        else: hi = m - 1
    return e200_1h[idx]

h01_trades = []
last = {"S13": 0, "S14": 0}
for i in range(250, len(bars4h) - 50):
    ts = bars4h[i]["time"]
    if get_regime(ts) != "RANGE": continue
    adx = adx4[i]; adxp = adx4[i - 1] if i else None
    if adx is None or adx <= 18 or adxp is None or adxp <= 18: continue
    e1h = e200_1h_at(ts)
    if e1h is None or c4[i] < e1h: continue
    dw = datetime.datetime.utcfromtimestamp(ts / 1000).weekday()
    if dw in (3, 6): continue
    sig = None
    if atr4[i] and c4[i] > bars4h[i - 1]["close"] + atr4[i] * 1.3:
        sig = "S13"
    elif i >= 18:
        hi = max(bars4h[j]["high"] for j in range(i - 18, i))
        if c4[i] > hi: sig = "S14"
    if not sig or i - last[sig] < (1 if sig == "S13" else 36): continue
    ep = c4[i]; ae = atr4[i] or ep * 0.01
    sl = ep - ae * 3.0; hwm = ep; ret = None
    for h in range(1, 71):
        j = i + h
        if j >= len(bars4h): break
        mult = 3.0 if h < 64 else 3.5
        if c4[j] > hwm: hwm = c4[j]; sl = hwm - ae * mult
        if bars4h[j]["low"] <= sl:
            ret = (sl - ep) / ep - 2 * FEE; break
    if ret is None:
        j = min(i + 70, len(bars4h) - 1)
        ret = (c4[j] - ep) / ep - 2 * FEE
    h01_trades.append({"entry_ts": ts, "ret": ret, "setup": sig})
    last[sig] = i
results.append(summarize("hedge01 S13/S14 RANGE", "4h ATR breakout / Donchian18 + RANGE+ADX+EMA200", h01_trades))

# ── 2. hedge04 S04B/S04R/S04K (1h) ──
print("Running hedge04...")
c1 = c1h
rsi1 = rsi(c1, 14)
stk1 = stoch_k(c1, 14)
atr1 = atr_bars(bars1h, 14)
adx4h = adx_wilder(bars4h, 14)
ma20_1h = sma(c1, 20)
sd20 = [None] * len(c1)
for i in range(19, len(c1)):
    w = c1[i - 19:i + 1]
    m = sum(w) / 20
    sd20[i] = (sum((x - m) ** 2 for x in w) / 20) ** 0.5

h04_trades = []
last_cd = {"BB": 0, "RSI": 0, "STK": 0}
for i in range(220, len(bars1h) - 30):
    ts = bars1h[i]["time"]
    if not in_2026(ts) and ts < Y0 - 86_400_000 * 30:  # still sim all for filter
        pass
    if get_regime(ts) != "RANGE": continue
    j4 = max(k for k, b in enumerate(bars4h) if b["time"] <= ts)
    adx = adx4h[j4]; adxp = adx4h[j4 - 1] if j4 else None
    if adx is None or adx <= 20 or adxp is None or adxp <= 20: continue
    e1h = e200_1h_at(ts)
    if e1h is None or c1[i] < e1h: continue
    ae = atr1[i]
    if ae is None or ae <= 0: continue
    sig = None
    b = bars1h[i]
    if ma20_1h[i] and sd20[i]:
        bb_lo = ma20_1h[i] - 2 * sd20[i]
        if b["low"] <= bb_lo and b["close"] > b["open"] and ts - last_cd["BB"] >= 2 * 3600_000:
            sig = ("BB", 2.0, 1.5); last_cd["BB"] = ts
    if sig is None and rsi1[i - 1] is not None and rsi1[i] is not None:
        if rsi1[i - 1] < 40 and rsi1[i] >= 40 and ts - last_cd["RSI"] >= 2 * 3600_000:
            sig = ("RSI", 2.0, 1.0); last_cd["RSI"] = ts
    if sig is None and stk1[i - 1] is not None and stk1[i] is not None:
        if stk1[i - 1] < 20 and stk1[i] >= 20 and ts - last_cd["STK"] >= 2 * 3600_000:
            sig = ("STK", 2.0, 1.0); last_cd["STK"] = ts
    if not sig: continue
    _, slm, tpm = sig
    ep = c1[i]; sl = ep - ae * slm; tp = ep + ae * tpm; ret = None
    for h in range(1, 25):
        j = i + h
        if j >= len(bars1h): break
        bh = bars1h[j]
        if bh["low"] <= sl: ret = (sl - ep) / ep - 2 * FEE; break
        if bh["high"] >= tp: ret = (tp - ep) / ep - 2 * FEE; break
    if ret is None:
        j = min(i + 24, len(bars1h) - 1)
        ret = (c1[j] - ep) / ep - 2 * FEE
    h04_trades.append({"entry_ts": ts, "ret": ret})

results.append(summarize("hedge04 triple", "RANGE+ADX: BB lower / RSI40 cross / Stoch20 cross (1h)", h04_trades))

# ── 3. GOLD SILENT atrLow + HTF FLAT (1h) ──
print("Running GOLD silent...")
atr_pct = []
for i, b in enumerate(bars1h):
    a = atr1[i]
    atr_pct.append((a / c1[i] * 100) if a else None)
macd_line = ema(ema(c1, 12), 26)  # simplified — use EMA spread proxy
ema20_1h = ema(c1, 20)

gold_trades = []
for i in range(220, len(bars1h) - 100):
    ts = bars1h[i]["time"]
    if atr_pct[i] is None or atr_pct[i] >= 0.3: continue
    if not htf_flat_1h(i): continue
    ep = c1[i]; tp = ep * 1.05; sl = ep * 0.98; ret = None
    for h in range(1, 101):
        j = i + h
        if j >= len(bars1h): break
        bh = bars1h[j]
        if bh["low"] <= sl: ret = (sl - ep) / ep - 2 * FEE; break
        if bh["high"] >= tp: ret = (tp - ep) / ep - 2 * FEE; break
    if ret is None:
        j = min(i + 100, len(bars1h) - 1)
        ret = (c1[j] - ep) / ep - 2 * FEE
    gold_trades.append({"entry_ts": ts, "ret": ret})
results.append(summarize("GOLD SILENT 1h", "atrLow<0.3% + HTF RANGE flat (4h EMA20)", gold_trades))

# ── 4. hedge06 champion params (1h RSI5/Stoch10) ──
print("Running hedge06...")
r5 = rsi(c1, 5)
stk10 = stoch_k(c1, 10)
adx1h = adx_wilder(bars1h, 14)
h06_trades = []
for i in range(50, len(bars1h) - 40):
    ts = bars1h[i]["time"]
    if adx1h[i] is None or adx1h[i] < 20: continue
    ae = atr1[i]
    if ae is None: continue
    long_sig = stk10[i] is not None and stk10[i] < 10
    short_sig = stk10[i] is not None and stk10[i] > 97
    if not long_sig and not short_sig: continue
    side = "LONG" if long_sig else "SHORT"
    ep = c1[i]
    if side == "LONG":
        sl = ep - ae; tp = ep + ae * 3
    else:
        sl = ep + ae; tp = ep - ae * 3
    ret = None
    for h in range(1, 41):
        j = i + h
        if j >= len(bars1h): break
        bh = bars1h[j]
        if side == "LONG":
            if bh["low"] <= sl: ret = (sl - ep) / ep - 2 * FEE; break
            if bh["high"] >= tp: ret = (tp - ep) / ep - 2 * FEE; break
        else:
            if bh["high"] >= sl: ret = (ep - sl) / ep - 2 * FEE; break
            if bh["low"] <= tp: ret = (ep - tp) / ep - 2 * FEE; break
    if ret is None:
        j = min(i + 40, len(bars1h) - 1)
        ret = ((c1[j] - ep) / ep if side == "LONG" else (ep - c1[j]) / ep) - 2 * FEE
    h06_trades.append({"entry_ts": ts, "ret": ret, "side": side})
results.append(summarize("hedge06 evolver", "StochK(10)<10 LONG / >97 SHORT + ADX>20 (1h)", h06_trades))

# ── 5. turtle Donchian daily ──
print("Running turtle...")
c1d_b = [b["close"] for b in bars1d]
h1d = [b["high"] for b in bars1d]
l1d = [b["low"] for b in bars1d]
tur_trades = []
for i in range(25, len(bars1d) - 15):
    ts = bars1d[i]["time"]
    if get_regime(ts) == "BEAR": continue
    hi20 = max(h1d[j] for j in range(i - 20, i))
    if c1d_b[i] <= hi20: continue
    ep = c1d_b[i]
    # simplified SL 1.5 ATR daily
    ae = atr_bars(bars1d, 14)[i] or ep * 0.02
    sl = ep - ae * 1.5
    ret = None
    for h in range(1, 16):
        j = i + h
        if j >= len(bars1d): break
        if l1d[j] <= sl:
            ret = (sl - ep) / ep - 2 * FEE; break
        lo12 = min(c1d_b[k] for k in range(j - 12, j)) if j >= 12 else c1d_b[j]
        if c1d_b[j] < lo12:
            ret = (c1d_b[j] - ep) / ep - 2 * FEE; break
    if ret is None:
        j = min(i + 15, len(bars1d) - 1)
        ret = (c1d_b[j] - ep) / ep - 2 * FEE
    tur_trades.append({"entry_ts": ts, "ret": ret})
results.append(summarize("turtle Donchian20", "daily close > DC20 + skip BEAR", tur_trades))

# regime stats 2026
reg_2026 = defaultdict(int)
for b in bars4h:
    if in_2026(b["time"]):
        reg_2026[get_regime(b["time"])] += 1

# ── 6. hedge04 NO regime gate (diagnostic) ──
h04_all = []
for i in range(220, len(bars1h) - 30):
    ts = bars1h[i]["time"]
    ae = atr1[i]
    if ae is None or ae <= 0: continue
    sig = None
    b = bars1h[i]
    if ma20_1h[i] and sd20[i]:
        bb_lo = ma20_1h[i] - 2 * sd20[i]
        if b["low"] <= bb_lo and b["close"] > b["open"]:
            sig = (2.0, 1.5)
    if sig is None and rsi1[i - 1] is not None and rsi1[i] is not None:
        if rsi1[i - 1] < 40 and rsi1[i] >= 40: sig = (2.0, 1.0)
    if sig is None and stk1[i - 1] is not None and stk1[i] is not None:
        if stk1[i - 1] < 20 and stk1[i] >= 20: sig = (2.0, 1.0)
    if not sig: continue
    slm, tpm = sig
    ep = c1[i]; sl = ep - ae * slm; tp = ep + ae * tpm; ret = None
    for h in range(1, 25):
        j = i + h
        if j >= len(bars1h): break
        bh = bars1h[j]
        if bh["low"] <= sl: ret = (sl - ep) / ep - 2 * FEE; break
        if bh["high"] >= tp: ret = (tp - ep) / ep - 2 * FEE; break
    if ret is None:
        j = min(i + 24, len(bars1h) - 1)
        ret = (c1[j] - ep) / ep - 2 * FEE
    h04_all.append({"entry_ts": ts, "ret": ret})
results.append(summarize("hedge04 BB only (no gate)", "S04B only, no RANGE/ADX gate — diagnostic", h04_all))

# sort by 2026 pnl
results.sort(key=lambda x: x.get("pnl_usd", 0), reverse=True)
out = {
    "generated": datetime.datetime.utcnow().isoformat() + "Z",
    "capital": CAP,
    "period": "2026 YTD entry",
    "regime_2026_4h_bars": dict(reg_2026),
    "note": "Faithful RANGE-only rules blocked when classifier A = BEAR (2026 slow grind)",
    "audit_ref_trend_only_2026": {"entries": 69, "pnl_usd": 232, "source": "backtest_h01_v0438_7y_audit.json trend-only scenario"},
    "results": results,
}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
json.dump(out, open(OUT, "w"), indent=2)

print("\n=== 2026 YTD TOP 5 BACKTEST ===")
print(f"{'Rule':<22} | {'n':>3} | {'WR%':>5} | {'PnL$':>8} | Entry")
for r in results:
    print(f"{r['name']:<22} | {r['n2026']:>3} | {r.get('wr',0):>5.1f} | {r.get('pnl_usd',0):>+8.0f} | {r['entry'][:50]}")
print(f"\nWrote {OUT}")