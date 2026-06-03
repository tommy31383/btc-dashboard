#!/usr/bin/env python3
"""ROI-based eval phương pháp general (turtle trend+ATR-cut+skip-BEAR) — cross-asset + PORTFOLIO.
   Đo bằng ROI% trên vốn (1x leverage, return% khi đang giữ vị thế, 0 khi flat) + MaxDD% + annualized.
   Portfolio = equal-weight rổ asset trên CHUNG period. So vs Buy-and-Hold.
"""
import json, datetime, sys, math
CC = "/Users/lap16116/BTC_PC/btc-dashboard/.cache"
ASSETS = [("BTC", f"{CC}/binance-5m-7y.json"), ("ETH", f"{CC}/binance-eth-5m-3y.json"),
          ("SOL", f"{CC}/binance-sol-5m-3y.json"), ("BNB", f"{CC}/binance-bnb-5m-3y.json"),
          ("XRP", f"{CC}/binance-xrp-5m-3y.json"), ("DOGE", f"{CC}/binance-doge-5m-3y.json"),
          ("AVAX", f"{CC}/binance-avax-5m-3y.json")]
DON_E, DON_X, CUT, FEE = 20, 10, 1.5, 0.0005

def daily(path):
    raw = json.load(open(path)); raw.sort(key=lambda x: x["time"]); b = {}
    for c in raw:
        k = c["time"] // 86400_000
        if k not in b: b[k] = {"t": k * 86400_000, "h": c["high"], "l": c["low"], "c": c["close"]}
        else:
            o = b[k]; o["h"] = max(o["h"], c["high"]); o["l"] = min(o["l"], c["low"]); o["c"] = c["close"]
    return [b[k] for k in sorted(b)]
def atr_w(B, p=14):
    n = len(B); tr = [0.] * n
    for i in range(1, n): tr[i] = max(B[i]["h"] - B[i]["l"], abs(B[i]["h"] - B[i - 1]["c"]), abs(B[i]["l"] - B[i - 1]["c"]))
    o = [None] * n
    if n <= p: return o
    o[p] = sum(tr[1:p + 1]) / p
    for i in range(p + 1, n): o[i] = (o[i - 1] * (p - 1) + tr[i]) / p
    return o

def turtle_daily_ret(B):
    """Trả dict {day_ms: strategy_return%} — 1x leverage, return% khi giữ (cut1.5 + Donchian-exit + skip-BEAR LONG)."""
    n = len(B); C = [x["c"] for x in B]; atr = atr_w(B)
    dhi = [None] * n; dlo = [None] * n
    for i in range(DON_E, n): dhi[i] = max(B[j]["h"] for j in range(i - DON_E, i))
    for i in range(DON_X, n): dlo[i] = min(B[j]["l"] for j in range(i - DON_X, i))
    # regime skip-BEAR (close<MA200)
    bear = [False] * n
    for i in range(200, n):
        ma200 = sum(C[i - 199:i + 1]) / 200
        bear[i] = C[i] < ma200
    ret = {}; hold = False; e = 0.0; a = 0.0
    for i in range(max(DON_E, 200), n):
        r = 0.0
        if hold:
            # daily M2M return (1x) từ close hôm trước
            ex = None
            if B[i]["l"] <= e - a * CUT: ex = e - a * CUT          # cut intrabar
            elif dlo[i] is not None and C[i] < dlo[i]: ex = C[i]    # Donchian exit
            if ex is not None:
                r = (ex - C[i - 1]) / C[i - 1] - FEE; hold = False  # exit return + fee
            else:
                r = (C[i] - C[i - 1]) / C[i - 1]
        if not hold and dhi[i] is not None and C[i] > dhi[i] and not bear[i]:
            hold = True; e = C[i]; a = atr[i] or 0; r -= FEE        # entry fee (vào cuối ngày, return ngày sau)
        ret[B[i]["t"]] = r
    return ret, C, [x["t"] for x in B]

def stats(rets):
    """rets: list daily return% (decimal). Trả (total_ROI%, annualized%, maxDD%, sharpe, exposure%)."""
    if not rets: return (0, 0, 0, 0, 0)
    eq = 1.0; peak = 1.0; mdd = 0.0; curve = []
    for x in rets:
        eq *= (1 + x); peak = max(peak, eq); mdd = max(mdd, (peak - eq) / peak); curve.append(eq)
    total = (eq - 1) * 100
    yrs = len(rets) / 365
    ann = ((eq) ** (1 / yrs) - 1) * 100 if yrs > 0 and eq > 0 else 0
    m = sum(rets) / len(rets); sd = (sum((v - m) ** 2 for v in rets) / len(rets)) ** 0.5 or 1e-9
    sharpe = m / sd * math.sqrt(365)
    expo = sum(1 for x in rets if x != 0) / len(rets) * 100
    return (total, ann, mdd * 100, sharpe, expo)

print("Loading assets...", file=sys.stderr)
data = {}
for name, path in ASSETS:
    B = daily(path); rmap, C, T = turtle_daily_ret(B)
    bh = {T[i]: (C[i] - C[i - 1]) / C[i - 1] for i in range(1, len(C))}  # buy-hold daily return
    data[name] = {"turtle": rmap, "bh": bh, "days": set(rmap.keys())}

# common period (giao của mọi asset)
common = set.intersection(*[d["days"] for d in data.values()])
common = sorted(common)
print(f"\nCommon period: {len(common)} days ({datetime.datetime.utcfromtimestamp(common[0]/1000).date()} → {datetime.datetime.utcfromtimestamp(common[-1]/1000).date()})")

print(f"\n=== PER-ASSET (turtle 1x, full data mỗi coin) — ROI% ===")
print(f"  {'asset':>5} | {'ROI%tot':>8} | {'ann%':>6} | {'MaxDD%':>6} | {'expo%':>5} | {'Sharpe':>6} || {'BH ann%':>7} {'BH DD%':>6}")
for name, _ in ASSETS:
    tr = [data[name]["turtle"][t] for t in sorted(data[name]["turtle"])]
    bh = [data[name]["bh"][t] for t in sorted(data[name]["bh"]) if t in data[name]["turtle"]]
    tt = stats(tr); bb = stats(bh)
    print(f"  {name:>5} | {tt[0]:>+8.0f} | {tt[1]:>+6.1f} | {tt[2]:>6.1f} | {tt[4]:>5.0f} | {tt[3]:>+6.2f} || {bb[1]:>+7.1f} {bb[2]:>6.1f}")

# PORTFOLIO (equal-weight) trên common period
port_turtle = [sum(data[n]["turtle"][t] for n, _ in ASSETS) / len(ASSETS) for t in common]
port_bh = [sum(data[n]["bh"].get(t, 0) for n, _ in ASSETS) / len(ASSETS) for t in common]
pt = stats(port_turtle); pb = stats(port_bh)
print(f"\n=== PORTFOLIO equal-weight 7 coin (common {len(common)}d ~{len(common)/365:.1f}y), 1x leverage ===")
print(f"  {'':14} | {'ROI%tot':>8} | {'ann ROI%':>8} | {'MaxDD%':>6} | {'Sharpe':>6} | {'ROI/DD':>6}")
print(f"  {'TURTLE basket':14} | {pt[0]:>+8.0f} | {pt[1]:>+8.1f} | {pt[2]:>6.1f} | {pt[3]:>+6.2f} | {pt[1]/max(pt[2],1):>6.2f}")
print(f"  {'BUY-HOLD basket':14} | {pb[0]:>+8.0f} | {pb[1]:>+8.1f} | {pb[2]:>6.1f} | {pb[3]:>+6.2f} | {pb[1]/max(pb[2],1):>6.2f}")
print(f"\n  → Diversify giảm DD? portfolio MaxDD {pt[2]:.0f}% vs BTC đơn lẻ. ROI/DD (return-on-risk) cao hơn = vốn hiệu quả hơn.")
print(f"  Lưu ý: 1x leverage. ROI thật scale theo leverage anh dùng (vd 3x → ×3 cả ROI lẫn DD).")

# === COMMON-PERIOD: Sharpe từng coin vs RỔ + correlation (chứng minh diversify) ===
names = [n for n, _ in ASSETS]
series = {n: [data[n]["turtle"][t] for t in common] for n in names}
def corr(a, b):
    N = len(a); ma = sum(a) / N; mb = sum(b) / N
    cov = sum((a[i] - ma) * (b[i] - mb) for i in range(N)) / N
    sa = (sum((x - ma) ** 2 for x in a) / N) ** .5; sb = (sum((x - mb) ** 2 for x in b) / N) ** .5
    return cov / (sa * sb) if sa > 0 and sb > 0 else 0
print(f"\n=== COMMON-PERIOD ({len(common)/365:.1f}y) — Sharpe TỪNG coin (fair compare) ===")
indiv = {}
for n in names:
    s = stats(series[n]); indiv[n] = s[3]
    print(f"    {n:>5}: Sharpe {s[3]:+.2f}  ann {s[1]:+5.0f}%  DD {s[2]:4.0f}%")
best_ind = max(indiv.values()); best_name = max(indiv, key=indiv.get)
print(f"\n  Correlation turtle-returns (common):")
print("        " + " ".join(f"{n:>5}" for n in names))
for n in names:
    print(f"  {n:>5} " + " ".join(f"{corr(series[n], series[m]):>5.2f}" for m in names))
avg_corr = sum(corr(series[a], series[b]) for i, a in enumerate(names) for b in names[i + 1:]) / (len(names) * (len(names) - 1) / 2)
print(f"  avg pairwise corr = {avg_corr:.2f}  ({'THẤP → diversify mạnh' if avg_corr < 0.3 else 'TRUNG BÌNH' if avg_corr < 0.5 else 'CAO → diversify yếu'})")

baskets = {"ALL-7": names, "ALPHA-4 (BTC XRP DOGE AVAX)": ["BTC", "XRP", "DOGE", "AVAX"], "CORE-3 (BTC XRP DOGE)": ["BTC", "XRP", "DOGE"]}
print(f"\n  RỔ equal-weight vs BEST individual ({best_name} {best_ind:+.2f}):")
for bn, bl in baskets.items():
    r = [sum(series[n][i] for n in bl) / len(bl) for i in range(len(common))]
    s = stats(r)
    flag = "✅ > best individual!" if s[3] > best_ind + 0.02 else ("≈ best" if s[3] > best_ind - 0.1 else "< best")
    print(f"    {bn:>26}: Sharpe {s[3]:+.2f}  ann {s[1]:+5.0f}%  DD {s[2]:4.0f}%  ROI/DD {s[1]/max(s[2],1):.2f}  [{flag}]")
