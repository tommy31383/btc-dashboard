#!/usr/bin/env python3
"""
audit-bottom-24h-multitf.py
Audit đáy 24h BTC — StochRSI K+D đa khung thời gian (15m, 1h, 4h, 1d)
"""
import json, math
from collections import defaultdict

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"

# ── Load & build timeframes ────────────────────────────────────────────────────
print("Loading 5m data...")
raw = json.load(open(CACHE))
raw.sort(key=lambda x: x['time'])
print(f"  {len(raw)} bars loaded")

def build_tf(ms):
    b = {}
    for c in raw:
        k = c["time"] // ms
        if k not in b:
            b[k] = {"time": k*ms, "open": c["open"], "high": c["high"],
                    "low": c["low"], "close": c["close"], "volume": c.get("volume",0)}
        else:
            b[k]["high"] = max(b[k]["high"], c["high"])
            b[k]["low"]  = min(b[k]["low"],  c["low"])
            b[k]["close"] = c["close"]
            b[k]["volume"] += c.get("volume", 0)
    return [b[k] for k in sorted(b)]

MS = {"15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000}
print("Building timeframes...")
TF = {name: build_tf(ms) for name, ms in MS.items()}
for name, bars in TF.items():
    print(f"  {name}: {len(bars)} bars")

# ── Indicators ────────────────────────────────────────────────────────────────
def rsi(closes, period=14):
    out = [None] * len(closes)
    if len(closes) <= period:
        return out
    gains = losses = 0.0
    for i in range(1, period+1):
        d = closes[i] - closes[i-1]
        if d > 0: gains += d
        else: losses -= d
    gains /= period; losses /= period
    out[period] = 100 - 100/(1 + gains/losses) if losses else 100.0
    for i in range(period+1, len(closes)):
        d = closes[i] - closes[i-1]
        gains = (gains*(period-1) + max(d,0)) / period
        losses = (losses*(period-1) + max(-d,0)) / period
        out[i] = 100 - 100/(1 + gains/losses) if losses else 100.0
    return out

def stoch_rsi(closes, rsi_len=14, stoch_len=14, k_smooth=3, d_smooth=3):
    r = rsi(closes, rsi_len)
    n = len(r)
    raw_k = [None] * n
    for i in range(stoch_len-1, n):
        window = [x for x in r[i-stoch_len+1:i+1] if x is not None]
        if len(window) < stoch_len:
            continue
        lo, hi = min(window), max(window)
        raw_k[i] = 50.0 if hi == lo else (r[i] - lo) / (hi - lo) * 100
    # smooth K
    K = [None]*n
    for i in range(k_smooth-1, n):
        w = [x for x in raw_k[i-k_smooth+1:i+1] if x is not None]
        if len(w) == k_smooth: K[i] = sum(w)/k_smooth
    # D = SMA of K
    D = [None]*n
    for i in range(d_smooth-1, n):
        w = [x for x in K[i-d_smooth+1:i+1] if x is not None]
        if len(w) == d_smooth: D[i] = sum(w)/d_smooth
    return K, D

print("Computing StochRSI for all timeframes...")
STOCH = {}
for name, bars in TF.items():
    closes = [b['close'] for b in bars]
    K, D = stoch_rsi(closes)
    STOCH[name] = {"K": K, "D": D, "bars": bars}
    print(f"  {name}: done")

# Build time→index lookup for each TF
IDX = {}
for name, data in STOCH.items():
    IDX[name] = {b['time']: i for i, b in enumerate(data['bars'])}

# ── Detect 24h bottoms on 1h TF ───────────────────────────────────────────────
# Local minima: lowest close in ±12 bar window, drop ≥ 2% from 48h lookback high
bars_1h = TF["1h"]
closes_1h = [b['close'] for b in bars_1h]
n1h = len(bars_1h)

WINDOW = 12      # ±12h
MIN_DROP = 0.02  # 2% drop from recent high
MIN_GAP_MS = 24 * 3600_000  # 24h between bottoms

print("\nDetecting 24h bottoms...")
bottoms = []
for i in range(WINDOW, n1h - WINDOW):
    lo = closes_1h[i]
    # local min in window
    if lo != min(closes_1h[i-WINDOW:i+WINDOW+1]):
        continue
    # drop requirement: ≥2% below max of past 48 bars
    recent_hi = max(closes_1h[max(0,i-48):i+1])
    if recent_hi == 0 or (recent_hi - lo) / recent_hi < MIN_DROP:
        continue
    bottoms.append(i)

# Deduplicate: keep deepest in 24h window
filtered = []
for idx in bottoms:
    t = bars_1h[idx]['time']
    # remove earlier ones within 24h
    filtered = [b for b in filtered if abs(bars_1h[b]['time'] - t) >= MIN_GAP_MS]
    filtered.append(idx)

# Re-deduplicate: among nearby bottoms keep the lowest
deduped = []
used = set()
for idx in sorted(filtered):
    if idx in used: continue
    t = bars_1h[idx]['time']
    cluster = [b for b in filtered if abs(bars_1h[b]['time'] - t) < MIN_GAP_MS]
    best = min(cluster, key=lambda b: closes_1h[b])
    deduped.append(best)
    for b in cluster: used.add(b)

print(f"  Found {len(deduped)} bottoms (24h significant)")

# ── Lookup StochRSI at each bottom ────────────────────────────────────────────
def get_stoch_at_time(tf_name, t_ms):
    """Get K,D at the bar containing time t_ms"""
    bars = STOCH[tf_name]['bars']
    K    = STOCH[tf_name]['K']
    D    = STOCH[tf_name]['D']
    ms   = MS[tf_name]
    bar_t = (t_ms // ms) * ms
    idx = IDX[tf_name].get(bar_t)
    if idx is None:
        # fallback: find nearest
        times = [b['time'] for b in bars]
        diffs = [abs(tt - bar_t) for tt in times]
        idx = diffs.index(min(diffs))
    k = K[idx]; d = D[idx]
    return (round(k,1) if k is not None else None,
            round(d,1) if d is not None else None)

results = []
for i in deduped:
    t_ms = bars_1h[i]['time']
    price = closes_1h[i]
    dt = __import__('datetime').datetime.utcfromtimestamp(t_ms/1000).strftime('%Y-%m-%d %H:%M')
    row = {"date": dt, "price": round(price,1), "t_ms": t_ms}
    for tf in ["15m","1h","4h","1d"]:
        k, d = get_stoch_at_time(tf, t_ms)
        row[f"K_{tf}"] = k
        row[f"D_{tf}"] = d
        row[f"KgtD_{tf}"] = (k > d) if (k is not None and d is not None) else None
    results.append(row)

# ── Print individual bottoms ───────────────────────────────────────────────────
print("\n" + "="*110)
print(f"{'DATE':<17} {'PRICE':>9} | {'K15m':>6} {'D15m':>6} {'Δ':>5} | {'K1h':>6} {'D1h':>6} {'Δ':>5} | {'K4h':>6} {'D4h':>6} {'Δ':>5} | {'K1d':>6} {'D1d':>6} {'Δ':>5}")
print("-"*110)

for r in results:
    def fmt_kd(tf):
        k, d = r[f"K_{tf}"], r[f"D_{tf}"]
        if k is None: return f"{'N/A':>6} {'N/A':>6} {'':>5}"
        delta = round(k-d,1) if d is not None else 0
        arrow = "↑" if delta > 0 else "↓"
        return f"{k:>6.1f} {d:>6.1f} {arrow}{abs(delta):>3.1f}"
    print(f"{r['date']:<17} {r['price']:>9,.0f} | {fmt_kd('15m')} | {fmt_kd('1h')} | {fmt_kd('4h')} | {fmt_kd('1d')}")

# ── Statistics ────────────────────────────────────────────────────────────────
print("\n" + "="*110)
print("THỐNG KÊ TỔNG HỢP")
print("="*110)

TFS = ["15m","1h","4h","1d"]
total = len(results)

for tf in TFS:
    vals_k = [r[f"K_{tf}"] for r in results if r[f"K_{tf}"] is not None]
    vals_d = [r[f"D_{tf}"] for r in results if r[f"D_{tf}"] is not None]
    if not vals_k: continue
    n = len(vals_k)
    avg_k = sum(vals_k)/n
    med_k = sorted(vals_k)[n//2]
    pct_lt5  = sum(1 for v in vals_k if v < 5)  / n * 100
    pct_lt10 = sum(1 for v in vals_k if v < 10) / n * 100
    pct_lt20 = sum(1 for v in vals_k if v < 20) / n * 100
    pct_lt30 = sum(1 for v in vals_k if v < 30) / n * 100
    pct_gt50 = sum(1 for v in vals_k if v > 50) / n * 100
    pct_kgtd = sum(1 for r in results if r[f"KgtD_{tf}"] == True) / n * 100
    avg_d = sum(vals_d)/len(vals_d) if vals_d else 0
    print(f"\n[{tf}] n={n}")
    print(f"  K: avg={avg_k:.1f}  median={med_k:.1f}  D_avg={avg_d:.1f}")
    print(f"  K<5:{pct_lt5:.0f}%  K<10:{pct_lt10:.0f}%  K<20:{pct_lt20:.0f}%  K<30:{pct_lt30:.0f}%  K>50:{pct_gt50:.0f}%")
    print(f"  K>D (bullish cross): {pct_kgtd:.0f}%")

# ── Combo analysis: how many TFs oversold simultaneously ───────────────────────
print("\n" + "="*110)
print("COMBO: số TF có K<20 cùng lúc tại đáy")
print("-"*40)
combo_counts = defaultdict(int)
for r in results:
    cnt = sum(1 for tf in TFS if r[f"K_{tf}"] is not None and r[f"K_{tf}"] < 20)
    combo_counts[cnt] += 1
for cnt in sorted(combo_counts):
    pct = combo_counts[cnt] / total * 100
    bar = "█" * int(pct/2)
    print(f"  {cnt} TF K<20: {combo_counts[cnt]:3d} đáy ({pct:.0f}%) {bar}")

print("\nCOMBO: số TF có K<10 cùng lúc tại đáy")
print("-"*40)
combo10 = defaultdict(int)
for r in results:
    cnt = sum(1 for tf in TFS if r[f"K_{tf}"] is not None and r[f"K_{tf}"] < 10)
    combo10[cnt] += 1
for cnt in sorted(combo10):
    pct = combo10[cnt] / total * 100
    bar = "█" * int(pct/2)
    print(f"  {cnt} TF K<10: {combo10[cnt]:3d} đáy ({pct:.0f}%) {bar}")

# ── Per-year breakdown ─────────────────────────────────────────────────────────
print("\n" + "="*110)
print("PER-YEAR: avg K tại đáy")
print(f"{'Year':<6} {'n':>4} | {'K15m':>6} {'K1h':>6} {'K4h':>6} {'K1d':>6} | {'<K10@15m':>9} {'<K10@1h':>9} {'<K10@4h':>9} {'<K10@1d':>9}")
print("-"*90)
by_year = defaultdict(list)
for r in results:
    yr = r['date'][:4]
    by_year[yr].append(r)
for yr in sorted(by_year):
    rows = by_year[yr]
    n = len(rows)
    def avg_k(tf):
        v = [r[f"K_{tf}"] for r in rows if r[f"K_{tf}"] is not None]
        return f"{sum(v)/len(v):.1f}" if v else "N/A"
    def pct_lt10(tf):
        v = [r[f"K_{tf}"] for r in rows if r[f"K_{tf}"] is not None]
        if not v: return "N/A"
        return f"{sum(1 for x in v if x<10)/len(v)*100:.0f}%"
    print(f"{yr:<6} {n:>4} | {avg_k('15m'):>6} {avg_k('1h'):>6} {avg_k('4h'):>6} {avg_k('1d'):>6} | {pct_lt10('15m'):>9} {pct_lt10('1h'):>9} {pct_lt10('4h'):>9} {pct_lt10('1d'):>9}")

# ── K alignment pattern ────────────────────────────────────────────────────────
print("\n" + "="*110)
print("ALIGNMENT: K_15m vs K_1h vs K_4h vs K_1d — mức phân tầng trung bình tại đáy")
print("-"*60)
for tf in TFS:
    vals = [r[f"K_{tf}"] for r in results if r[f"K_{tf}"] is not None]
    buckets = {"<10":0,"10-20":0,"20-30":0,"30-50":0,">50":0}
    for v in vals:
        if v < 10: buckets["<10"] += 1
        elif v < 20: buckets["10-20"] += 1
        elif v < 30: buckets["20-30"] += 1
        elif v < 50: buckets["30-50"] += 1
        else: buckets[">50"] += 1
    n = len(vals)
    parts = " | ".join(f"{k}:{v/n*100:.0f}%" for k,v in buckets.items())
    print(f"  {tf:4s}: {parts}")

print("\nDone.")
