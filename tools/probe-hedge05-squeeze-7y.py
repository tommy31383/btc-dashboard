#!/usr/bin/env python3
"""PROBE hedge05 KIND ① — VOL-SQUEEZE BREAKOUT (volatility regime transition).
   Thesis: BTC vol clusters. Sau giai đoạn NÉN (BB bandwidth percentile thấp), breakout
   (close exits BB) thường mở 1 nhịp directional. Bidirectional, event-driven (KHÔNG forced).
   No-lookahead: 4h-native, decide+enter tại CLOSED bar i, manage từ i+1; regime daily D-1.
   Dollar-faithful: usd = qty*Δprice - fee(2 chiều), fixed qty (NO DCA).
   Flags: --cut= --tp= --ts= --sqpctl= --bblb= --cd= --adxmin= --trail= --long-only --short-only
"""
import json, datetime, sys
from collections import defaultdict
CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FEE = 0.05 / 100; BASE_QTY = 0.003

def argf(n, d):
    for a in sys.argv:
        if a.startswith(f"--{n}="): return float(a.split("=")[1])
    return d

CUT = argf("cut", 2.0); TP_M = argf("tp", 4.0); TS_H = int(argf("ts", 18))   # 18 × 4h = 72h
SQ_PCTL = argf("sqpctl", 0.25)   # squeeze = BB bandwidth <= percentile này của rolling window
BB_LB = int(argf("bblb", 100))   # lookback cho bandwidth percentile (4h bars)
CD = int(argf("cd", 2))          # cooldown bars per side
ADX_MIN = argf("adxmin", 0)      # optional: yêu cầu ADX>=này tại breakout (0=off)
TRAIL = argf("trail", 0)
LONG_ONLY = "--long-only" in sys.argv; SHORT_ONLY = "--short-only" in sys.argv
MODE = next((a.split("=")[1] for a in sys.argv if a.startswith("--mode=")), "squeeze")  # squeeze | bearshort
DON_LB = int(argf("donlb", 20))

raw = json.load(open(CACHE)); raw.sort(key=lambda x: x["time"])
def agg(bars, ms):
    b = {}
    for c in bars:
        k = c["time"] // ms
        if k not in b: b[k] = {"time": k * ms, "high": c["high"], "low": c["low"], "close": c["close"], "volume": c["volume"]}
        else:
            o = b[k]; o["high"] = max(o["high"], c["high"]); o["low"] = min(o["low"], c["low"]); o["close"] = c["close"]; o["volume"] += c["volume"]
    return [b[k] for k in sorted(b)]
MS4 = 4 * 3600_000; MSD = 86400_000
B4 = agg(raw, MS4); BD = agg(raw, MSD)
C4 = [b["close"] for b in B4]; n = len(B4)

def sma(xs, p):
    o = [None] * len(xs); s = 0.0
    for i, x in enumerate(xs):
        s += x
        if i >= p: s -= xs[i - p]
        if i >= p - 1: o[i] = s / p
    return o
def _dtr(bars):
    m = len(bars); pdm = [0.] * m; ndm = [0.] * m; tr = [0.] * m
    for i in range(1, m):
        up = bars[i]["high"] - bars[i - 1]["high"]; dn = bars[i - 1]["low"] - bars[i]["low"]
        pdm[i] = up if up > dn and up > 0 else 0; ndm[i] = dn if dn > up and dn > 0 else 0
        tr[i] = max(bars[i]["high"] - bars[i]["low"], abs(bars[i]["high"] - bars[i - 1]["close"]), abs(bars[i]["low"] - bars[i - 1]["close"]))
    return pdm, ndm, tr
def atr_w(bars, p=14):
    _, _, tr = _dtr(bars); m = len(bars); o = [None] * m
    if m <= p: return o
    o[p] = sum(tr[1:p + 1]) / p
    for i in range(p + 1, m): o[i] = (o[i - 1] * (p - 1) + tr[i]) / p
    return o
def adx_w(bars, p=14):
    m = len(bars); pdm, ndm, tr = _dtr(bars)
    atr = [None] * m; sp = [None] * m; sn = [None] * m; adx = [None] * m
    if m <= 2 * p: return adx
    atr[p] = sum(tr[1:p + 1]); sp[p] = sum(pdm[1:p + 1]); sn[p] = sum(ndm[1:p + 1])
    for i in range(p + 1, m):
        atr[i] = atr[i - 1] - atr[i - 1] / p + tr[i]; sp[i] = sp[i - 1] - sp[i - 1] / p + pdm[i]; sn[i] = sn[i - 1] - sn[i - 1] / p + ndm[i]
    dx = [None] * m
    for i in range(p, m):
        if atr[i] and atr[i] > 0:
            dip = 100 * sp[i] / atr[i]; din = 100 * sn[i] / atr[i]; ss = dip + din
            dx[i] = 100 * abs(dip - din) / ss if ss > 0 else 0.0
    if 2 * p - 1 < m and all(dx[i] is not None for i in range(p, 2 * p)): adx[2 * p - 1] = sum(dx[p:2 * p]) / p
    for i in range(2 * p, m):
        if dx[i] is not None and adx[i - 1] is not None: adx[i] = (adx[i - 1] * (p - 1) + dx[i]) / p
    return adx

# Bollinger(20,2) + bandwidth trên 4h closes
BBP = 20; BBK = 2.0
mid = sma(C4, BBP); bbw = [None] * n; bbu = [None] * n; bbl = [None] * n
for i in range(BBP - 1, n):
    w = C4[i - BBP + 1:i + 1]; m_ = mid[i]; sd = (sum((x - m_) ** 2 for x in w) / BBP) ** 0.5
    bbu[i] = m_ + BBK * sd; bbl[i] = m_ - BBK * sd; bbw[i] = (bbu[i] - bbl[i]) / m_ if m_ > 0 else None
atr4 = atr_w(B4); adx4 = adx_w(B4)

# Daily regime D-1 (BEAR close<MA200 / BULL close>MA50&MA50>MA200&ar>0.04 / RANGE), persistence 3
DCS = [b["close"] for b in BD]; nd = len(BD); draw = ["RANGE"] * nd
for i in range(200, nd):
    ma200 = sum(DCS[i - 199:i + 1]) / 200; ma50 = sum(DCS[i - 49:i + 1]) / 50
    ar = sum((BD[j]["high"] - BD[j]["low"]) / BD[j]["close"] for j in range(i - 19, i + 1)) / 20
    if DCS[i] < ma200: draw[i] = "BEAR"
    elif DCS[i] > ma50 and ma50 > ma200 and ar > 0.04: draw[i] = "BULL"
dreg = ["RANGE"] * nd; cur = "RANGE"; cnt = 0; last = "RANGE"
for i in range(nd):
    r = draw[i]
    if r == last: cnt += 1
    else: cnt = 1; last = r
    if cnt >= 3: cur = r
    dreg[i] = cur
d_idx = {BD[i]["time"] // MSD: i for i in range(nd)}
def regime_at(ts):  # D-1 = ngày đã đóng trước ts
    di = d_idx.get(ts // MSD - 1)
    return dreg[di] if di is not None else "RANGE"

def signal(i):
    if i < BB_LB + BBP or bbw[i] is None or atr4[i] is None or atr4[i] <= 0: return None
    win = [bbw[j] for j in range(i - BB_LB, i) if bbw[j] is not None]
    if len(win) < BB_LB * 0.7: return None
    thr = sorted(win)[int(len(win) * SQ_PCTL)]
    if bbw[i - 1] is None or bbw[i - 1] > thr: return None   # bar trước phải đang NÉN
    if ADX_MIN > 0 and (adx4[i] is None or adx4[i] < ADX_MIN): return None
    if bbu[i] is not None and C4[i] > bbu[i]: return "LONG"   # breakout lên
    if bbl[i] is not None and C4[i] < bbl[i]: return "SHORT"  # breakout xuống
    return None

# ② BEAR/SHORT complement: regime BEAR (D-1) + breakdown Donchian-low(20) → SHORT (lấp blind spot hedge01)
donlow = [None] * n
for i in range(DON_LB, n):
    donlow[i] = min(B4[j]["low"] for j in range(i - DON_LB, i))
def signal_bear(i):
    if i < BB_LB + BBP or atr4[i] is None or atr4[i] <= 0 or donlow[i] is None: return None
    if regime_at(B4[i]["time"]) != "BEAR": return None
    if ADX_MIN > 0 and (adx4[i] is None or adx4[i] < ADX_MIN): return None
    if C4[i] < donlow[i]: return "SHORT"   # phá đáy 20-bar trong BEAR confirmed
    return None

# Dollar sim 4h-native: enter tại close[i], manage từ i+1, SL-first
trades = []; pos = None; lastL = -10**9; lastS = -10**9
for i in range(BB_LB + BBP, n - 1):
    if pos is not None:
        side = pos["side"]; e = pos["e"]; a = pos["a"]; bar = B4[i]
        if bar["high"] > pos["hwm"]: pos["hwm"] = bar["high"]
        if bar["low"] < pos["lwm"]: pos["lwm"] = bar["low"]
        ex = None
        if side == "LONG":
            if bar["low"] <= e - a * CUT: ex = e - a * CUT
            elif TRAIL > 0 and (pos["hwm"] - a * TRAIL) >= e and bar["low"] <= pos["hwm"] - a * TRAIL: ex = pos["hwm"] - a * TRAIL
            elif bar["high"] >= e + a * TP_M: ex = e + a * TP_M
        else:
            if bar["high"] >= e + a * CUT: ex = e + a * CUT
            elif TRAIL > 0 and (pos["lwm"] + a * TRAIL) <= e and bar["high"] >= pos["lwm"] + a * TRAIL: ex = pos["lwm"] + a * TRAIL
            elif bar["low"] <= e - a * TP_M: ex = e - a * TP_M
        if ex is None and (i - pos["i"]) >= TS_H: ex = bar["close"]
        if ex is not None:
            q = BASE_QTY; pnl = q * (ex - e) if side == "LONG" else q * (e - ex); usd = pnl - FEE * e * q - FEE * ex * q
            yr = datetime.datetime.utcfromtimestamp(B4[i]["time"] / 1000).year
            trades.append({"usd": usd, "ret": usd / (e * q), "yr": yr, "side": side, "reg": pos["reg"]})
            pos = None
        continue
    sig = signal(i) if MODE == "squeeze" else signal_bear(i)
    if sig is None: continue
    if LONG_ONLY and sig == "SHORT": continue
    if SHORT_ONLY and sig == "LONG": continue
    if sig == "LONG" and i - lastL < CD: continue
    if sig == "SHORT" and i - lastS < CD: continue
    pos = {"side": sig, "e": C4[i], "a": atr4[i], "i": i, "hwm": C4[i], "lwm": C4[i], "reg": regime_at(B4[i]["time"])}
    if sig == "LONG": lastL = i
    else: lastS = i
if pos is not None:
    e = pos["e"]; ex = C4[-1]; q = BASE_QTY; side = pos["side"]
    pnl = q * (ex - e) if side == "LONG" else q * (e - ex); usd = pnl - 2 * FEE * e * q
    yr = datetime.datetime.utcfromtimestamp(B4[-1]["time"] / 1000).year
    trades.append({"usd": usd, "ret": usd / (e * q), "yr": yr, "side": side, "reg": pos["reg"]})

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
def raf(x):
    if len(x) < 5: return 0
    m = sum(x) / len(x); s = (sum((v - m) ** 2 for v in x) / len(x)) ** 0.5; return m / s if s > 0 else 0
print(f"[SQUEEZE cut{CUT} tp{TP_M} ts{TS_H} sqpctl{SQ_PCTL} bblb{BB_LB} cd{CD} adxmin{ADX_MIN} trail{TRAIL}]")
print(f"  n={N} ({N // (len(byyr) or 1)}/yr)  WR={wr:.0f}%  RA={ra:.3f}")
print(f"  DOLLAR: ${tot:+.0f}/7y  |  recent 23-26: ${recent:+.0f}")
print(f"  $-stab {stab}/{len(byyr)}yr  |  WF TRAIN RA={raf(trn):.3f} TEST RA={raf(te):.3f}")
for s in ("LONG", "SHORT"):
    cs = [t for t in trades if t["side"] == s]
    if cs: print(f"    {s:5s} n={len(cs):4d} WR={sum(1 for t in cs if t['ret'] > 0) / len(cs) * 100:.0f}% ${sum(t['usd'] for t in cs):+.0f}")
for rg in ("BULL", "RANGE", "BEAR"):
    cs = [t for t in trades if t["reg"] == rg]
    if cs: print(f"    {rg:5s} n={len(cs):4d} WR={sum(1 for t in cs if t['ret'] > 0) / len(cs) * 100:.0f}% ${sum(t['usd'] for t in cs):+.0f}")
print("  per-year $: " + "  ".join(f"{y}:{byyr[y]:+.0f}" for y in sorted(byyr)))
