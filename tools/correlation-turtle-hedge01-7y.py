#!/usr/bin/env python3
"""Correlation hedge01 (RANGE-breakout 4h LONG) vs ③ Turtle (daily Donchian 20/10 + ATR cut2) — additive?
   Monthly realized return-% Pearson + concordance + combined equal-risk Sharpe.
   Reuse proven helpers từ backtest-bull-regime-reaudit-7y.py (importlib). No-lookahead (cả 2 đã validate).
"""
import importlib.util, datetime, math
from collections import defaultdict
spec = importlib.util.spec_from_file_location("re", "/Users/lap16116/BTC_PC/btc-dashboard/tools/backtest-bull-regime-reaudit-7y.py")
H = importlib.util.module_from_spec(spec); spec.loader.exec_module(H)
FEE = H.FEE

bars4h = H.load_tf(H.H4); bars1h = H.load_tf(3600 * 1000); bars1d = H.load_tf(86400 * 1000)
n = len(bars4h); c4 = [b["close"] for b in bars4h]
e50 = H.ema_s(c4, H.EMA_FAST); e200 = H.ema_s(c4, H.EMA_SLOW)
atr4 = H.atr_series(bars4h); adx4 = H.adx_wilder(bars4h)
e200_1h = H.ema_s([b["close"] for b in bars1h], 200); h1t = [b["time"] for b in bars1h]
regime_1d = H.regime_with_persistence(bars1d)
reg_map = {b["time"] // 86400000: regime_1d[i] for i, b in enumerate(bars1d)}
def get_reg(ts): return reg_map.get(ts // 86400000, "RANGE")
def mo_of(ts): return datetime.datetime.utcfromtimestamp(ts / 1000).strftime("%Y-%m")

def atp(i):
    return None if atr4[i] is None else atr4[i] / c4[i]
def atp_pass(i):
    if i < H.ATR_PCT_LB + 14: return False
    vs = [atp(j) for j in range(i - H.ATR_PCT_LB, i) if atp(j) is not None]
    if len(vs) < H.ATR_PCT_LB: return False
    cur = atp(i)
    return cur is not None and cur >= sorted(vs)[int(len(vs) * H.ATR_PCT_PCTL)]
def vol_pass(i):
    if i < H.VOL_MA: return False
    ma = sum(bars4h[j]["volume"] for j in range(i - H.VOL_MA, i)) / H.VOL_MA
    return bars4h[i]["volume"] >= ma * H.VOL_MULT
def e200_1h_at(ts):
    lo, hi, idx = 0, len(h1t) - 1, 0
    while lo <= hi:
        m = (lo + hi) // 2
        if h1t[m] <= ts: idx = m; lo = m + 1
        else: hi = m - 1
    return e200_1h[idx]
def uhour(ts): return datetime.datetime.utcfromtimestamp(ts / 1000).hour
def udow(ts): return datetime.datetime.utcfromtimestamp(ts / 1000).weekday()

def filt(i):  # LONG, RANGE-only (live hedge01)
    adv = adx4[i]
    if adv is None or adv <= H.ADX_THRESH: return False
    ap = adx4[i - 1] if i >= 1 else None
    if ap is None or ap <= H.ADX_THRESH: return False
    e1h = e200_1h_at(bars4h[i]["time"])
    if e1h is None or c4[i] < e1h: return False
    if not atp_pass(i): return False
    if H.SKIP_H16 and uhour(bars4h[i]["time"]) == 16: return False
    if H.SKIP_THU_SUN:
        dw = udow(bars4h[i]["time"])
        if dw == 3 or dw == 6: return False
    return get_reg(bars4h[i]["time"]) == "RANGE"
def sim(ei):  # LONG ATR trailing SL
    ep = c4[ei]; ae = atr4[ei]
    if ae is None or ae <= 0: return None
    sl = ep - ae * H.SL_INIT; hwm = ep
    for h in range(1, H.MAX_HOLD + 1):
        j = ei + h
        if j >= n: break
        mult = H.SL_INIT if h < H.SL_TRANS else H.SL_TRAIL
        if c4[j] > hwm: hwm = c4[j]; sl = hwm - ae * mult
        elif h >= H.SL_TRANS:
            t = hwm - ae * H.SL_TRAIL
            if t > sl: sl = t
        if bars4h[j]["low"] <= sl: return (sl - ep) / ep - 2 * FEE, h
    j = min(ei + H.MAX_HOLD, n - 1)
    return (c4[j] - ep) / ep - 2 * FEE, H.MAX_HOLD
def sig_s12(i):
    if None in (e50[i], e200[i]) or i < 1 or None in (e50[i - 1], e200[i - 1]): return None
    return "LONG" if e50[i - 1] <= e200[i - 1] and e50[i] > e200[i] else None
def sig_s13(i):
    if atr4[i] is None or i < 1: return None
    return "LONG" if c4[i] > bars4h[i - 1]["close"] + atr4[i] * H.ATR_BREAK_MULT else None
def sig_s14(i):
    if i < H.DONCHIAN_LB: return None
    hi = max(bars4h[j]["high"] for j in range(i - H.DONCHIAN_LB, i))
    return "LONG" if c4[i] > hi else None
sigs = {"S12": sig_s12, "S13": sig_s13, "S14": sig_s14}; do_vol = {"S12": False, "S13": True, "S14": True}
CD = {"S12": 36, "S13": 1, "S14": 36}

h01_mo = defaultdict(float); last = {s: 0 for s in sigs}
for i in range(250, n - H.MAX_HOLD):
    for sn in ("S12", "S13", "S14"):
        if sigs[sn](i) != "LONG": continue
        if i - last[sn] < CD[sn]: continue
        if do_vol[sn] and not vol_pass(i): continue
        if not filt(i): continue
        r = sim(i)
        if r is None: continue
        ret, h = r
        h01_mo[mo_of(bars4h[min(i + h, n - 1)]["time"])] += ret
        last[sn] = i

# Turtle daily Donchian 20/10 long-only + ATR cut2
DE, DX, CUT = 20, 10, 2.0; BD = bars1d; nd = len(BD); CC = [b["close"] for b in BD]
def atr_d(bars, p=14):
    m = len(bars); tr = [0.] * m
    for i in range(1, m): tr[i] = max(bars[i]["high"] - bars[i]["low"], abs(bars[i]["high"] - bars[i - 1]["close"]), abs(bars[i]["low"] - bars[i - 1]["close"]))
    o = [None] * m; o[p] = sum(tr[1:p + 1]) / p
    for i in range(p + 1, m): o[i] = (o[i - 1] * (p - 1) + tr[i]) / p
    return o
atrd = atr_d(BD); dhi = [None] * nd; dlo = [None] * nd
for i in range(DE, nd): dhi[i] = max(BD[j]["high"] for j in range(i - DE, i))
for i in range(DX, nd): dlo[i] = min(BD[j]["low"] for j in range(i - DX, i))
tur_mo = defaultdict(float); hold = False; e = 0.0; a = 0.0
for i in range(max(DE, 20), nd):
    if hold:
        ex = None
        if BD[i]["low"] <= e - a * CUT: ex = e - a * CUT
        elif dlo[i] is not None and CC[i] < dlo[i]: ex = CC[i]
        if ex is not None:
            tur_mo[mo_of(BD[i]["time"])] += (ex - e) / e - 2 * FEE; hold = False
    if not hold and dhi[i] is not None and CC[i] > dhi[i]:
        hold = True; e = CC[i]; a = atrd[i] or 0
if hold: tur_mo[mo_of(BD[-1]["time"])] += (CC[-1] - e) / e - 2 * FEE

allmo = sorted(set(h01_mo) | set(tur_mo))
xs = [h01_mo.get(m, 0.0) for m in allmo]; ys = [tur_mo.get(m, 0.0) for m in allmo]
N = len(allmo); mx = sum(xs) / N; my = sum(ys) / N
cov = sum((xs[i] - mx) * (ys[i] - my) for i in range(N)) / N
sx = (sum((v - mx) ** 2 for v in xs) / N) ** 0.5; sy = (sum((v - my) ** 2 for v in ys) / N) ** 0.5
r = cov / (sx * sy) if sx > 0 and sy > 0 else 0
both = [i for i in range(N) if xs[i] != 0 and ys[i] != 0]
same = sum(1 for i in both if (xs[i] > 0) == (ys[i] > 0))
tur_saves = sum(1 for i in range(N) if ys[i] > 0 and xs[i] < 0)
h01_saves = sum(1 for i in range(N) if xs[i] > 0 and ys[i] < 0)
def sh(s):
    m = sum(s) / N; d = (sum((v - m) ** 2 for v in s) / N) ** 0.5 or 1e-9; return m / d * math.sqrt(12)
comb = [(xs[i] / (sx or 1) + ys[i] / (sy or 1)) / 2 for i in range(N)]
verdict = "LOW → DIVERSIFY THẬT" if abs(r) < 0.3 else ("MODERATE" if abs(r) < 0.6 else "HIGH → redundant")
print("=== hedge01 (RANGE-breakout 4h) vs ③ Turtle (daily Donchian+cut2) — monthly 7y ===")
print(f"  months={N}  hedge01 active {sum(1 for v in xs if v != 0)}  turtle active {sum(1 for v in ys if v != 0)}")
print(f"  PEARSON r = {r:+.3f}   [{verdict}]")
print(f"  both-active {len(both)} tháng: same-sign {same}/{len(both)} ({same / max(len(both), 1) * 100:.0f}%)")
print(f"  turtle DƯƠNG khi hedge01 âm/0: {tur_saves} tháng | hedge01 DƯƠNG khi turtle âm/0: {h01_saves} tháng")
print(f"  monthly Sharpe(×√12): hedge01 {sh(xs):+.2f}  turtle {sh(ys):+.2f}  COMBINED(equal-risk) {sh(comb):+.2f}")
print(f"  → combined > max riêng lẻ ({max(sh(xs), sh(ys)):+.2f})? {'YES, diversify giúp' if sh(comb) > max(sh(xs), sh(ys)) else 'no'}")

# === BẢNG LƯỚI NĂM × THÁNG (return-% = tổng return mỗi lệnh đóng trong tháng, R-multiple) ===
def grid(name, mo):
    print(f"\n=== MONTHLY return-% — {name}  (· = không có lệnh) ===")
    print("year |" + "".join(f"{('M' + str(m)):>6}" for m in range(1, 13)) + " |   TOTAL")
    gtot = 0.0
    for y in range(2019, 2027):
        cells = []; tot = 0.0
        for m in range(1, 13):
            k = f"{y}-{m:02d}"
            if k in mo:
                v = mo[k] * 100; tot += v; cells.append(f"{v:>+6.0f}")
            else:
                cells.append(f"{'·':>6}")
        gtot += tot
        print(f"{y} |" + "".join(cells) + f" | {tot:>+8.0f}")
    print(f"7y TOTAL return-%: {gtot:+.0f}")

grid("hedge01 (live: RANGE-breakout 4h LONG)", h01_mo)
grid("hedge05/turtle (daily Donchian 20/10 + ATR cut2)", tur_mo)
print("\nGhi chú: return-% = tổng % return mỗi lệnh đóng trong tháng (R-multiple trên notional lệnh), KHÔNG phải % vốn acc. Cả 2 cùng đơn vị → so trực tiếp được.")
import json as _json
print("H01_MONTHLY " + _json.dumps(dict(h01_mo)))
print("TUR_MONTHLY " + _json.dumps(dict(tur_mo)))
