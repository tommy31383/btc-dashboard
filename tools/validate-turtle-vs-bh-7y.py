#!/usr/bin/env python3
"""Validate ③ Turtle ALPHA vs BETA — long-only daily Donchian vs Buy-and-Hold BTC.
   Sharpe (leverage-invariant): turtle Sharpe > B&H Sharpe → timing-alpha THẬT;
   ≈ → chỉ under-levered beta (= cứ hold BTC); < → timing HẠI. + MaxDD (né bear?), exposure, per-year.
   No-lookahead: daily, enter/exit tại close đã đóng; Donchian dùng prior-N (exclude today).
   Flags: --donentry= --donexit= --cut= (ATR stop, 0=off)
"""
import json, datetime, sys, math
from collections import defaultdict
CACHE = next((a.split("=")[1] for a in sys.argv if a.startswith("--cache=")), "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json")
FEE = 0.05 / 100; QTY = 0.003

def argf(n, d):
    for a in sys.argv:
        if a.startswith(f"--{n}="): return float(a.split("=")[1])
    return d
DON_ENTRY = int(argf("donentry", 20)); DON_EXIT = int(argf("donexit", 10)); CUT = argf("cut", 0)

raw = json.load(open(CACHE)); raw.sort(key=lambda x: x["time"])
b = {}
for c in raw:
    k = c["time"] // 86400_000
    if k not in b: b[k] = {"time": k * 86400_000, "high": c["high"], "low": c["low"], "close": c["close"]}
    else:
        o = b[k]; o["high"] = max(o["high"], c["high"]); o["low"] = min(o["low"], c["low"]); o["close"] = c["close"]
BD = [b[k] for k in sorted(b)]; n = len(BD); C = [x["close"] for x in BD]

def atr_w(bars, p=14):
    m = len(bars); tr = [0.] * m
    for i in range(1, m):
        tr[i] = max(bars[i]["high"] - bars[i]["low"], abs(bars[i]["high"] - bars[i - 1]["close"]), abs(bars[i]["low"] - bars[i - 1]["close"]))
    o = [None] * m; o[p] = sum(tr[1:p + 1]) / p
    for i in range(p + 1, m): o[i] = (o[i - 1] * (p - 1) + tr[i]) / p
    return o
atr = atr_w(BD)
dhi_e = [None] * n; dlo_x = [None] * n
for i in range(DON_ENTRY, n): dhi_e[i] = max(BD[j]["high"] for j in range(i - DON_ENTRY, i))
for i in range(DON_EXIT, n): dlo_x[i] = min(BD[j]["low"] for j in range(i - DON_EXIT, i))

# Daily mark-to-market: turtle long-only vs B&H. pnl_t[i]/pnl_b[i] = $ P&L of day i.
# daily regime D-1 (optional skip-BEAR gate)
SKIPBEAR = "--skipbear" in sys.argv
_draw = ["RANGE"] * n
for i in range(200, n):
    ma200 = sum(C[i - 199:i + 1]) / 200; ma50 = sum(C[i - 49:i + 1]) / 50
    arr = sum((BD[j]["high"] - BD[j]["low"]) / BD[j]["close"] for j in range(i - 19, i + 1)) / 20
    if C[i] < ma200: _draw[i] = "BEAR"
    elif C[i] > ma50 and ma50 > ma200 and arr > 0.04: _draw[i] = "BULL"
dreg = ["RANGE"] * n; _cur = "RANGE"; _cnt = 0; _lr = "RANGE"
for i in range(n):
    if _draw[i] == _lr: _cnt += 1
    else: _cnt = 1; _lr = _draw[i]
    if _cnt >= 3: _cur = _draw[i]
    dreg[i] = _cur

WARM = max(DON_ENTRY, 200 if SKIPBEAR else 20)
pnl_t = [0.0] * n; pnl_b = [0.0] * n
holding = False; entry_px = 0.0; entry_atr = 0.0; days_in = 0
for i in range(WARM, n):
    pnl_b[i] = QTY * (C[i] - C[i - 1])   # B&H luôn giữ
    if holding:
        pnl_t[i] = QTY * (C[i] - C[i - 1])   # accrue khi đang giữ
        days_in += 1
        exit_now = False
        if CUT > 0 and BD[i]["low"] <= entry_px - entry_atr * CUT: exit_now = True
        elif dlo_x[i] is not None and C[i] < dlo_x[i]: exit_now = True   # turtle exit: phá đáy M-day
        if exit_now:
            pnl_t[i] -= FEE * C[i] * QTY   # exit fee
            holding = False
    if not holding:
        if dhi_e[i] is not None and C[i] > dhi_e[i] and not (SKIPBEAR and i >= 1 and dreg[i - 1] == "BEAR"):   # entry: phá đỉnh N-day (optional skip BEAR)
            holding = True; entry_px = C[i]; entry_atr = atr[i] or 0
            pnl_t[i] -= FEE * C[i] * QTY   # entry fee

def stats(pnl, lo, hi):
    series = pnl[lo:hi]
    eq = []; s = 0.0
    for x in series: s += x; eq.append(s)
    total = s
    mean = sum(series) / len(series); var = sum((x - mean) ** 2 for x in series) / len(series); sd = var ** 0.5 or 1e-9
    sharpe = mean / sd * math.sqrt(365)
    peak = -1e18; mdd = 0.0
    for v in eq:
        peak = max(peak, v); mdd = max(mdd, peak - v)
    return total, sharpe, mdd

EX2021 = "--ex2021" in sys.argv  # bỏ HẲN 2021 (test "rule 1 lệnh ngu" — turtle còn alpha không nếu mất cú jackpot?)
if EX2021:
    idxs = [i for i in range(WARM, n) if datetime.datetime.utcfromtimestamp(BD[i]["time"] / 1000).year != 2021]
    pt = [pnl_t[i] for i in idxs]; pb = [pnl_b[i] for i in idxs]
    tt, ts, tmdd = stats(pt, 0, len(pt))
    bt, bs, bmdd = stats(pb, 0, len(pb))
else:
    tt, ts, tmdd = stats(pnl_t, WARM, n)
    bt, bs, bmdd = stats(pnl_b, WARM, n)
expo = sum(1 for i in range(WARM, n) if pnl_t[i] != 0) / (n - WARM) * 100
yr_t = defaultdict(float); yr_b = defaultdict(float)
for i in range(WARM, n):
    y = datetime.datetime.utcfromtimestamp(BD[i]["time"] / 1000).year
    yr_t[y] += pnl_t[i]; yr_b[y] += pnl_b[i]

print(f"=== ③ TURTLE long-only (entry{DON_ENTRY}/exit{DON_EXIT} cut{CUT}) vs BUY-AND-HOLD — 7y daily M2M, qty {QTY} ===")
print(f"{'':14} | {'Total$':>8} | {'Sharpe':>7} | {'MaxDD$':>7} | {'exposure':>8}")
print(f"{'TURTLE':14} | {tt:>+8.0f} | {ts:>7.2f} | {tmdd:>7.0f} | {expo:>7.0f}%")
print(f"{'BUY-HOLD':14} | {bt:>+8.0f} | {bs:>7.2f} | {bmdd:>7.0f} | {'100':>7}%")
print(f"\nVERDICT (Sharpe leverage-invariant):")
if ts > bs + 0.10:
    print(f"  turtle Sharpe {ts:.2f} > B&H {bs:.2f} → TIMING-ALPHA THẬT (né risk, không chỉ beta).")
elif ts < bs - 0.10:
    print(f"  turtle Sharpe {ts:.2f} < B&H {bs:.2f} → timing HẠI risk-adjusted (cứ hold BTC tốt hơn).")
else:
    print(f"  turtle Sharpe {ts:.2f} ≈ B&H {bs:.2f} → CHỈ UNDER-LEVERED BETA, timing KHÔNG thêm edge.")
print(f"  MaxDD: turtle ${tmdd:.0f} vs B&H ${bmdd:.0f}  (turtle né bear tốt = {bmdd/max(tmdd,1):.1f}× ít DD hơn)")
print(f"\nPer-year $ (turtle vs B&H):")
for y in sorted(yr_t):
    print(f"  {y}: turtle {yr_t[y]:+7.0f}  |  B&H {yr_b[y]:+7.0f}")
