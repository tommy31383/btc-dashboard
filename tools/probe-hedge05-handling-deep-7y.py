#!/usr/bin/env python3
"""DEEP DIVE phương pháp XỬ LÝ lệnh âm cho hedge05 forced-daily (KHÔNG giảm lệnh).
   Phase 1 (script này): ADVERSE-EXCURSION PROFILE — với mọi forced-daily entry, khi xuống −k×ATR
   thì P(gỡ về +TP) bao nhiêu? → biết cut/hold/reverse ở đâu tối ưu (không võ đoán).
   Entry = champion multi-TF direction (1d-trend + ADX/DI-4h + 15m-MACD + vol haircut), forced-daily.
   No-lookahead: bar đã đóng mỗi TF + daily D-1.
"""
import json, datetime, sys
from collections import defaultdict
CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
def argf(n, d):
    for a in sys.argv:
        if a.startswith(f"--{n}="): return float(a.split("=")[1])
    return d
ADX_TREND = argf("adxtrend", 25); ADX_RANGE = argf("adxrange", 20)
DECISIVE = int(argf("decisive", 2)); DEADLINE = int(argf("deadline", 20))
HORIZON = int(argf("horizon", 168))   # giờ (1h bars) profile mỗi lệnh — 7 ngày (xem cả nếu hold lâu có gỡ)
TP_LEVEL = argf("tp", 4.0)            # +TP×ATR = "gỡ thành công"

print("Loading + agg...", file=sys.stderr)
raw = json.load(open(CACHE)); raw.sort(key=lambda x: x["time"])
MS = {"15m": 900_000, "1h": 3600_000, "4h": 4 * 3600_000, "1d": 86400_000}
def agg(bars, ms):
    b = {}
    for c in bars:
        k = c["time"] // ms
        if k not in b: b[k] = {"time": k * ms, "open": c["open"], "high": c["high"], "low": c["low"], "close": c["close"], "volume": c["volume"]}
        else:
            o = b[k]; o["high"] = max(o["high"], c["high"]); o["low"] = min(o["low"], c["low"]); o["close"] = c["close"]; o["volume"] += c["volume"]
    return [b[k] for k in sorted(b)]
B = {tf: agg(raw, ms) for tf, ms in MS.items()}
C = {tf: [x["close"] for x in B[tf]] for tf in B}

def ema(xs, p):
    k = 2 / (p + 1); o = [None] * len(xs); e = None
    for i, x in enumerate(xs): e = x if e is None else x * k + e * (1 - k); o[i] = e
    return o
def _dtr(bars):
    n = len(bars); pdm = [0.] * n; ndm = [0.] * n; tr = [0.] * n
    for i in range(1, n):
        up = bars[i]["high"] - bars[i - 1]["high"]; dn = bars[i - 1]["low"] - bars[i]["low"]
        pdm[i] = up if up > dn and up > 0 else 0; ndm[i] = dn if dn > up and dn > 0 else 0
        tr[i] = max(bars[i]["high"] - bars[i]["low"], abs(bars[i]["high"] - bars[i - 1]["close"]), abs(bars[i]["low"] - bars[i - 1]["close"]))
    return pdm, ndm, tr
def atr_w(bars, p=14):
    _, _, tr = _dtr(bars); n = len(bars); o = [None] * n
    if n <= p: return o
    o[p] = sum(tr[1:p + 1]) / p
    for i in range(p + 1, n): o[i] = (o[i - 1] * (p - 1) + tr[i]) / p
    return o
def adx_di(bars, p=14):
    n = len(bars); pdm, ndm, tr = _dtr(bars); atr = [None] * n; sp = [None] * n; sn = [None] * n
    if n <= 2 * p: return [None] * n, [None] * n, [None] * n
    atr[p] = sum(tr[1:p + 1]); sp[p] = sum(pdm[1:p + 1]); sn[p] = sum(ndm[1:p + 1])
    for i in range(p + 1, n):
        atr[i] = atr[i - 1] - atr[i - 1] / p + tr[i]; sp[i] = sp[i - 1] - sp[i - 1] / p + pdm[i]; sn[i] = sn[i - 1] - sn[i - 1] / p + ndm[i]
    dip = [None] * n; din = [None] * n; dx = [None] * n; adx = [None] * n
    for i in range(p, n):
        if atr[i] and atr[i] > 0:
            dip[i] = 100 * sp[i] / atr[i]; din[i] = 100 * sn[i] / atr[i]; ss = dip[i] + din[i]
            dx[i] = 100 * abs(dip[i] - din[i]) / ss if ss > 0 else 0.0
    adx[2 * p - 1] = sum(dx[p:2 * p]) / p
    for i in range(2 * p, n):
        if dx[i] is not None and adx[i - 1] is not None: adx[i] = (adx[i - 1] * (p - 1) + dx[i]) / p
    return adx, dip, din
def macd_s(cls, f=12, s=26, sig=9):
    ef = ema(cls, f); es = ema(cls, s)
    line = [(ef[i] - es[i]) if ef[i] is not None and es[i] is not None else None for i in range(len(cls))]
    o = [None] * len(cls); k = 2 / (sig + 1); e = None
    for i, x in enumerate(line):
        if x is None: continue
        e = x if e is None else x * k + e * (1 - k); o[i] = e
    return line, o
def vol_ma(bars, p=20):
    o = [None] * len(bars)
    for i in range(p - 1, len(bars)): o[i] = sum(bars[j]["volume"] for j in range(i - p + 1, i + 1)) / p
    return o

print("Indicators...", file=sys.stderr)
a4, dp4, dn4 = adx_di(B["4h"]); ml15, ms15 = macd_s(C["15m"])
IND = {
    "ema50_1d": ema(C["1d"], 50),
    "adx4": a4, "dip4": dp4, "din4": dn4, "atr4": atr_w(B["4h"]), "volma4": vol_ma(B["4h"], 20),
    "macd15": ml15, "macdsig15": ms15,
}
def cidx(tf, t_close):
    bars = B[tf]; ms = MS[tf]; lo, hi, idx = 0, len(bars) - 1, -1
    while lo <= hi:
        m = (lo + hi) // 2
        if bars[m]["time"] + ms <= t_close: idx = m; lo = m + 1
        else: hi = m - 1
    return idx
def utc_day(ts): d = datetime.datetime.utcfromtimestamp(ts / 1000); return d.year * 10000 + d.month * 100 + d.day

def decide(t_close):
    """Champion direction (no mean-rev, no 4h/1h MACD). No-lookahead."""
    i1d = cidx("1d", t_close); i4 = cidx("4h", t_close); i15 = cidx("15m", t_close)
    if i4 < 30 or i1d < 60 or i15 < 40: return None
    atr4 = IND["atr4"][i4]
    if not atr4 or atr4 <= 0: return None
    adx4 = IND["adx4"][i4]
    if IND["ema50_1d"][i1d] is None or adx4 is None or IND["dip4"][i4] is None: return None
    if IND["macd15"][i15] is None or IND["macdsig15"][i15] is None: return None
    trend = 0
    trend += 1 if C["1d"][i1d] > IND["ema50_1d"][i1d] else -1
    if adx4 >= ADX_TREND: trend += 1 if IND["dip4"][i4] > IND["din4"][i4] else -1
    trend += 1 if IND["macd15"][i15] > IND["macdsig15"][i15] else -1
    score = trend if adx4 >= ADX_TREND else (0 if adx4 < ADX_RANGE else trend)
    vm = IND["volma4"][i4]
    if vm is not None and B["4h"][i4]["volume"] < vm * 0.8: score = int(score * 0.5)
    return ("LONG" if score >= 0 else "SHORT"), score, atr4

# ── Generate forced-daily entries (1/ngày, no skip) ──
print("Generate forced-daily entries...", file=sys.stderr)
bars1h = B["1h"]; n1h = len(bars1h)
WARM = cidx("1h", B["1d"][210]["time"])
entries = []  # (i_1h, side, entry_px, atr4)
last_day = -1
for i in range(WARM, n1h - HORIZON):
    bar = bars1h[i]; t_close = bar["time"] + MS["1h"]; px = bar["close"]
    day = utc_day(bar["time"]); hr = datetime.datetime.utcfromtimestamp(bar["time"] / 1000).hour
    if last_day == day: continue
    dec = decide(t_close)
    if dec is None: continue
    direction, score, atr4 = dec
    if abs(score) >= DECISIVE or hr >= DEADLINE:
        entries.append((i, direction, px, atr4)); last_day = day

# ── Phase 1: ADVERSE-EXCURSION RECOVERY PROFILE ──
K = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0]
reached = {k: 0 for k in K}     # số lệnh từng xuống ≥ −k×ATR (trước khi chạm +TP)
recovered = {k: 0 for k in K}   # trong đó, số lệnh sau đó GỠ về +TP
mae_all = []; tp_overall = 0
for (i, side, entry, atr) in entries:
    adv_bar = {k: None for k in K}; tp_bar = None; mae = 0.0
    for h in range(1, HORIZON + 1):
        j = i + h
        if j >= n1h: break
        b = bars1h[j]
        if side == "LONG":
            adv = (entry - b["low"]) / atr; fav = (b["high"] - entry) / atr
        else:
            adv = (b["high"] - entry) / atr; fav = (entry - b["low"]) / atr
        if adv > mae: mae = adv
        for k in K:
            if adv >= k and adv_bar[k] is None: adv_bar[k] = h
        if fav >= TP_LEVEL and tp_bar is None: tp_bar = h
    mae_all.append(mae)
    if tp_bar is not None: tp_overall += 1
    for k in K:
        rk = adv_bar[k]
        if rk is not None and (tp_bar is None or tp_bar > rk):   # từng xuống −k TRƯỚC khi (nếu) thắng
            reached[k] += 1
            if tp_bar is not None: recovered[k] += 1

N = len(entries)
mae_all.sort()
print(f"\n=== ADVERSE-EXCURSION PROFILE — forced-daily champion entries (n={N}, horizon {HORIZON}h, TP +{TP_LEVEL}×ATR) ===")
print(f"  P(lệnh chạm +TP trong horizon) tổng: {tp_overall/N*100:.0f}%  |  MAE median {mae_all[N//2]:.2f}×ATR  p90 {mae_all[int(N*0.9)]:.2f}×ATR")
print(f"\n  Khi đã xuống −k×ATR → P(GỠ về +TP):")
print(f"  {'−k×ATR':>7} | {'n đạt':>6} | {'P(gỡ +TP)':>10} | {'→ ý nghĩa xử lý'}")
print("  " + "-" * 60)
for k in K:
    p = recovered[k] / reached[k] * 100 if reached[k] else 0
    hint = "GIỮ/DCA (gỡ tốt)" if p >= 45 else ("biên — cân nhắc" if p >= 30 else "CẮT/REVERSE (gỡ kém)")
    print(f"  {('-'+str(k)):>7} | {reached[k]:>6} | {p:>9.0f}% | {hint}")
print(f"\n  → Cut tối ưu ≈ ngưỡng P(gỡ) rớt dưới ~break-even. Reverse có lý ở vùng P(gỡ) thấp (xu hướng tiếp diễn ngược).")
print(f"  Phase 2 (tiếp): test thực tế từng phương pháp xử lý (cut@k / reverse@k / DCA@k / hold / trail / hybrid) trên dollars + WF.")
