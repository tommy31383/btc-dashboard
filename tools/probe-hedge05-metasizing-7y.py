#!/usr/bin/env python3
"""A — META-SIZING forced-daily hedge05 (KHÔNG giảm lệnh, size theo chất lượng dự đoán).
   Train model dự đoán P(win) mỗi forced-daily entry từ features LÚC VÀO (no-lookahead).
   → size qty ∝ P(win) (giữ MỌI lệnh, min 0.3×). WF: train <2023, test ≥2023 (OOS thật).
   So TEST dollars: meta-sized vs flat vs |score|-conviction. Có beat flat OOS không?
   Handling outcome: cut@−2.2×ATR / TP+4×ATR / timestop 72h (no flip — isolate entry quality).
"""
import json, datetime, sys
import numpy as np
from collections import defaultdict
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.metrics import roc_auc_score
CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
ADX_TREND = 25; ADX_RANGE = 20; DECISIVE = 2; DEADLINE = 20
CUT = 2.2; TP = 4.0; TS_H = 72; BASE = 0.003; FEE = 0.0005

print("Loading + agg...", file=sys.stderr)
raw = json.load(open(CACHE)); raw.sort(key=lambda x: x["time"])
MS = {"15m": 900_000, "1h": 3600_000, "4h": 4 * 3600_000, "1d": 86400_000}
def agg(bars, ms):
    b = {}
    for c in bars:
        k = c["time"] // ms
        if k not in b: b[k] = {"time": k * ms, "high": c["high"], "low": c["low"], "close": c["close"], "volume": c["volume"]}
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
ema50_1d = ema(C["1d"], 50); atr4 = atr_w(B["4h"]); volma4 = vol_ma(B["4h"], 20)
def cidx(tf, t_close):
    bars = B[tf]; ms = MS[tf]; lo, hi, idx = 0, len(bars) - 1, -1
    while lo <= hi:
        m = (lo + hi) // 2
        if bars[m]["time"] + ms <= t_close: idx = m; lo = m + 1
        else: hi = m - 1
    return idx
def utc_day(ts): d = datetime.datetime.utcfromtimestamp(ts / 1000); return d.year * 10000 + d.month * 100 + d.day

# ── Generate forced-daily entries + FEATURES (lúc vào) + OUTCOME (cut2.2/tp4/ts72) ──
print("Generate entries + features + outcomes...", file=sys.stderr)
bars1h = B["1h"]; n1h = len(bars1h)
WARM = cidx("1h", B["1d"][210]["time"])
rows = []  # dict per entry
last_day = -1
for i in range(WARM, n1h - 1):
    bar = bars1h[i]; t_close = bar["time"] + MS["1h"]; px = bar["close"]
    day = utc_day(bar["time"]); dd = datetime.datetime.utcfromtimestamp(bar["time"] / 1000)
    if last_day == day: continue
    i1d = cidx("1d", t_close); i4 = cidx("4h", t_close); i15 = cidx("15m", t_close)
    if i4 < 30 or i1d < 60 or i15 < 40: continue
    at = atr4[i4]
    if not at or at <= 0: continue
    adxv = a4[i4]
    if ema50_1d[i1d] is None or adxv is None or dp4[i4] is None or ml15[i15] is None or ms15[i15] is None: continue
    trend = 0
    trend += 1 if C["1d"][i1d] > ema50_1d[i1d] else -1
    if adxv >= ADX_TREND: trend += 1 if dp4[i4] > dn4[i4] else -1
    trend += 1 if ml15[i15] > ms15[i15] else -1
    score = trend if adxv >= ADX_TREND else (0 if adxv < ADX_RANGE else trend)
    vm = volma4[i4]
    if vm is not None and B["4h"][i4]["volume"] < vm * 0.8: score = int(score * 0.5)
    hr = dd.hour
    if not (abs(score) >= DECISIVE or hr >= DEADLINE): continue
    side = "LONG" if score >= 0 else "SHORT"
    # FEATURES (no-lookahead, lúc vào)
    feat = {
        "score": score, "abs_score": abs(score), "adx": adxv,
        "di_diff": (dp4[i4] - dn4[i4]),
        "trend1d": (C["1d"][i1d] - ema50_1d[i1d]) / ema50_1d[i1d],
        "macd15": ml15[i15] - ms15[i15],
        "atr_pct": at / px, "vol_ratio": (B["4h"][i4]["volume"] / vm) if vm else 1.0,
        "hour": hr, "dow": dd.weekday(), "side_long": 1 if side == "LONG" else 0,
        "regime": 2 if adxv >= ADX_TREND else (0 if adxv < ADX_RANGE else 1),
    }
    # OUTCOME: sim cut2.2/tp4/ts72 (no flip)
    out = None; ret = None
    for h in range(1, TS_H + 1):
        j = i + h
        if j >= n1h: break
        b = bars1h[j]
        if side == "LONG":
            if b["low"] <= px - at * CUT: ret = (-at * CUT) / px - 2 * FEE; out = 0; break
            if b["high"] >= px + at * TP: ret = (at * TP) / px - 2 * FEE; out = 1; break
        else:
            if b["high"] >= px + at * CUT: ret = (-at * CUT) / px - 2 * FEE; out = 0; break
            if b["low"] <= px - at * TP: ret = (at * TP) / px - 2 * FEE; out = 1; break
    if out is None:
        j = min(i + TS_H, n1h - 1); pxe = bars1h[j]["close"]
        r = (pxe - px) / px if side == "LONG" else (px - pxe) / px
        ret = r - 2 * FEE; out = 1 if r > 0 else 0
    feat["win"] = out; feat["ret"] = ret; feat["entry"] = px; feat["yr"] = dd.year
    rows.append(feat); last_day = day

FEATS = ["score", "abs_score", "adx", "di_diff", "trend1d", "macd15", "atr_pct", "vol_ratio", "hour", "dow", "side_long", "regime"]
tr = [r for r in rows if r["yr"] < 2023]; te = [r for r in rows if r["yr"] >= 2023]
Xtr = np.array([[r[f] for f in FEATS] for r in tr]); ytr = np.array([r["win"] for r in tr])
Xte = np.array([[r[f] for f in FEATS] for r in te]); yte = np.array([r["win"] for r in te])
print(f"\nEntries: {len(rows)} (train<2023 {len(tr)}, test≥2023 {len(te)}). Base WR train {ytr.mean()*100:.0f}% / test {yte.mean()*100:.0f}%")

clf = GradientBoostingClassifier(n_estimators=80, max_depth=3, learning_rate=0.05, subsample=0.8)
clf.fit(Xtr, ytr)
ptr = clf.predict_proba(Xtr)[:, 1]; pte = clf.predict_proba(Xte)[:, 1]
auc_tr = roc_auc_score(ytr, ptr); auc_te = roc_auc_score(yte, pte)
print(f"Meta-model AUC: train {auc_tr:.3f} / TEST {auc_te:.3f}  ({'predict OOS được' if auc_te > 0.53 else 'KHÔNG predict OOS (≈coin-flip 0.5)'})")

# Sizing on TEST (giữ MỌI lệnh): $ = qty × entry × ret. So 3 cách size.
base_p = ytr.mean()
def dollars(rows_, qtys):
    return sum(q * r["entry"] * r["ret"] for q, r in zip(qtys, rows_))
flat = [BASE] * len(te)
conv = [BASE * min(max(1, r["abs_score"]), 2) for r in te]
meta = [BASE * float(np.clip(p / base_p, 0.3, 2.5)) for p, r in zip(pte, te)]
print(f"\n=== TEST (2023-26, OOS) dollars — giữ MỌI lệnh (n={len(te)}) ===")
print(f"  FLAT (size đều)          : ${dollars(te, flat):+.0f}")
print(f"  CONVICTION (|score|, ≤2×): ${dollars(te, conv):+.0f}")
print(f"  META-SIZE (P(win) model) : ${dollars(te, meta):+.0f}")
fi = sorted(zip(FEATS, clf.feature_importances_), key=lambda x: -x[1])
print(f"\n  Feature importance top: " + ", ".join(f"{f}={v:.2f}" for f, v in fi[:6]))
print(f"  → META beat FLAT OOS? {'YES — meta-sizing có giá trị' if dollars(te, meta) > dollars(te, flat) * 1.1 else 'KHÔNG (≈ flat → entry quality không predict được OOS)'}")
