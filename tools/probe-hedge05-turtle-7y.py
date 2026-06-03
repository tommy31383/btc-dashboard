#!/usr/bin/env python3
"""PROBE hedge05 KIND ③ — DAILY DONCHIAN TURTLE (hold-until-reverse).
   Thesis: BTC có trend nhiều-tháng fat-tail. Donchian-high(N) breakout DAILY + HOLD,
   thoát khi close phá Donchian đối nghịch(M) hoặc ATR-stop. Ít lệnh, winner to ride trọn sóng.
   No-lookahead: daily-native, decide+enter tại CLOSED day i, manage từ i+1.
   Dollar-faithful: usd = qty*Δprice - fee(2 chiều), fixed qty (NO DCA).
   Flags: --donentry= --donexit= --cut= (ATR stop, 0=off) --ts= (max hold days, 0=off)
          --long-only --short-only
"""
import json, datetime, sys
from collections import defaultdict
CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FEE = 0.05 / 100; BASE_QTY = 0.003

def argf(n, d):
    for a in sys.argv:
        if a.startswith(f"--{n}="): return float(a.split("=")[1])
    return d
DON_ENTRY = int(argf("donentry", 20)); DON_EXIT = int(argf("donexit", 10))
CUT = argf("cut", 0)   # ATR stop mult (0 = off, turtle dùng ~2N)
TS_D = int(argf("ts", 0))   # max hold days (0 = off)
LONG_ONLY = "--long-only" in sys.argv; SHORT_ONLY = "--short-only" in sys.argv
ENTRYNEXT = "--entrynext" in sys.argv  # AUDIT: vào tại OPEN ngày KẾ (causal — sau khi breakout-bar đã đóng) thay vì close-của-breakout-bar

raw = json.load(open(CACHE)); raw.sort(key=lambda x: x["time"])
def agg(bars, ms):
    b = {}
    for c in bars:
        k = c["time"] // ms
        if k not in b: b[k] = {"time": k * ms, "open": c["open"], "high": c["high"], "low": c["low"], "close": c["close"]}
        else:
            o = b[k]; o["high"] = max(o["high"], c["high"]); o["low"] = min(o["low"], c["low"]); o["close"] = c["close"]
    return [b[k] for k in sorted(b)]
BD = agg(raw, 86400_000); n = len(BD)
C = [b["close"] for b in BD]

def atr_w(bars, p=14):
    m = len(bars); tr = [0.] * m
    for i in range(1, m):
        tr[i] = max(bars[i]["high"] - bars[i]["low"], abs(bars[i]["high"] - bars[i - 1]["close"]), abs(bars[i]["low"] - bars[i - 1]["close"]))
    o = [None] * m
    if m <= p: return o
    o[p] = sum(tr[1:p + 1]) / p
    for i in range(p + 1, m): o[i] = (o[i - 1] * (p - 1) + tr[i]) / p
    return o
atr = atr_w(BD)
# Donchian channels (prior N days, EXCLUDE current — no lookahead)
dhi_e = [None] * n; dlo_e = [None] * n; dhi_x = [None] * n; dlo_x = [None] * n
for i in range(DON_ENTRY, n):
    dhi_e[i] = max(BD[j]["high"] for j in range(i - DON_ENTRY, i))
    dlo_e[i] = min(BD[j]["low"] for j in range(i - DON_ENTRY, i))
for i in range(DON_EXIT, n):
    dhi_x[i] = max(BD[j]["high"] for j in range(i - DON_EXIT, i))
    dlo_x[i] = min(BD[j]["low"] for j in range(i - DON_EXIT, i))

WARM = max(DON_ENTRY, 20)
trades = []; pos = None
for i in range(WARM, n):
    if pos is not None:
        side = pos["side"]; e = pos["e"]; a = pos["a"]; bar = BD[i]; ex = None
        if side == "LONG":
            if CUT > 0 and bar["low"] <= e - a * CUT: ex = e - a * CUT
            elif dlo_x[i] is not None and bar["close"] < dlo_x[i]: ex = bar["close"]   # turtle exit: phá đáy M-day
        else:
            if CUT > 0 and bar["high"] >= e + a * CUT: ex = e + a * CUT
            elif dhi_x[i] is not None and bar["close"] > dhi_x[i]: ex = bar["close"]
        if ex is None and TS_D > 0 and (i - pos["i"]) >= TS_D: ex = bar["close"]
        if ex is not None:
            q = BASE_QTY; pnl = q * (ex - e) if side == "LONG" else q * (e - ex); usd = pnl - FEE * e * q - FEE * ex * q
            yr = datetime.datetime.utcfromtimestamp(bar["time"] / 1000).year
            trades.append({"usd": usd, "ret": usd / (e * q), "yr": yr, "side": side, "hold": i - pos["i"]})
            pos = None
        # sau khi thoát, cho phép vào lại NGAY trong bar này nếu có entry signal đối nghịch (stop-and-reverse)
        if pos is None:
            pass
    if pos is None:
        bar = BD[i]; sig = None
        if dhi_e[i] is not None and bar["close"] > dhi_e[i]: sig = "LONG"
        elif dlo_e[i] is not None and bar["close"] < dlo_e[i]: sig = "SHORT"
        if sig and not (LONG_ONLY and sig == "SHORT") and not (SHORT_ONLY and sig == "LONG"):
            if ENTRYNEXT:
                if i + 1 < n: pos = {"side": sig, "e": BD[i + 1]["open"], "a": atr[i] or 0, "i": i + 1}
            else:
                pos = {"side": sig, "e": bar["close"], "a": atr[i] or 0, "i": i}
if pos is not None:
    bar = BD[-1]; e = pos["e"]; ex = bar["close"]; q = BASE_QTY; side = pos["side"]
    pnl = q * (ex - e) if side == "LONG" else q * (e - ex); usd = pnl - 2 * FEE * e * q
    yr = datetime.datetime.utcfromtimestamp(bar["time"] / 1000).year
    trades.append({"usd": usd, "ret": usd / (e * q), "yr": yr, "side": side, "hold": (n - 1) - pos["i"]})

N = len(trades)
if N == 0:
    print("NO TRADES"); sys.exit()
rets = [t["ret"] for t in trades]; mean = sum(rets) / N; sd = (sum((r - mean) ** 2 for r in rets) / N) ** 0.5 or 1e-9
ra = mean / sd; wr = sum(1 for r in rets if r > 0) / N * 100
byyr = defaultdict(float)
for t in trades: byyr[t["yr"]] += t["usd"]
stab = sum(1 for y in byyr if byyr[y] > 0)
tot = sum(t["usd"] for t in trades); recent = sum(t["usd"] for t in trades if t["yr"] >= 2023)
trn = [t["ret"] for t in trades if t["yr"] < 2023]; te = [t["ret"] for t in trades if t["yr"] >= 2023]
avg_hold = sum(t["hold"] for t in trades) / N
def raf(x):
    if len(x) < 5: return 0
    m = sum(x) / len(x); s = (sum((v - m) ** 2 for v in x) / len(x)) ** 0.5; return m / s if s > 0 else 0
print(f"[TURTLE donentry{DON_ENTRY} donexit{DON_EXIT} cut{CUT} ts{TS_D}d]")
print(f"  n={N} ({N // (len(byyr) or 1)}/yr)  WR={wr:.0f}%  RA={ra:.3f}  avgHold={avg_hold:.0f}d")
print(f"  DOLLAR: ${tot:+.0f}/7y  |  recent 23-26: ${recent:+.0f}")
print(f"  $-stab {stab}/{len(byyr)}yr  |  WF TRAIN RA={raf(trn):.3f} TEST RA={raf(te):.3f}")
for s in ("LONG", "SHORT"):
    cs = [t for t in trades if t["side"] == s]
    if cs: print(f"    {s:5s} n={len(cs):4d} WR={sum(1 for t in cs if t['ret'] > 0) / len(cs) * 100:.0f}% ${sum(t['usd'] for t in cs):+.0f}")
print("  per-year $: " + "  ".join(f"{y}:{byyr[y]:+.0f}" for y in sorted(byyr)))
