#!/usr/bin/env python3
"""loop-iter9-coverage-gaps.py — ITER9: book coverage diagnosis + BULL pullback-continuation sleeve.

Reuses hedge01 engine helpers from backtest-bull-regime-reaudit-7y.py (importlib).

TASK 1: % time book (hedge01 RANGE-only + turtle daily) is in a position; zero-exposure regimes;
        missed large-move $ during sat-out periods.
TASK 2: BULL-only pullback-continuation LONG sleeve (pull back to rising EMA50 4h then close back above),
        ATR trailing stop. ERA-SPLIT (2019-20 / 2021 / 2022 / 2023-24 / 2025-26). Corr vs hedge01+turtle.
TASK 3: squeeze already DEAD (hedge05 research) — re-confirm pointer only, no re-run here.

Era bar: >=4/5 eras positive. Additive bar: |corr|<0.3. Judge dollars + Sharpe + era-robust.
"""
import importlib.util, datetime, math
from collections import defaultdict

spec = importlib.util.spec_from_file_location("re", "/Users/lap16116/BTC_PC/btc-dashboard/tools/backtest-bull-regime-reaudit-7y.py")
H = importlib.util.module_from_spec(spec); spec.loader.exec_module(H)
FEE = H.FEE
BASE_QTY = 0.003  # fixed qty, dollar-faithful, NO DCA

bars4h = H.load_tf(H.H4); bars1h = H.load_tf(3600 * 1000); bars1d = H.load_tf(86400 * 1000)
n = len(bars4h); c4 = [b["close"] for b in bars4h]
e50 = H.ema_s(c4, H.EMA_FAST); e200 = H.ema_s(c4, H.EMA_SLOW)
atr4 = H.atr_series(bars4h); adx4 = H.adx_wilder(bars4h)
e200_1h = H.ema_s([b["close"] for b in bars1h], 200); h1t = [b["time"] for b in bars1h]
regime_1d = H.regime_with_persistence(bars1d)
reg_map = {b["time"] // 86400000: regime_1d[i] for i, b in enumerate(bars1d)}
def get_reg(ts): return reg_map.get(ts // 86400000, "RANGE")

# EMA20 on 4h for pullback sleeve
e20 = H.ema_s(c4, 20)

def yr(ts): return datetime.datetime.utcfromtimestamp(ts / 1000).year
def era_of(ts):
    y = yr(ts)
    if y <= 2020: return "2019-20"
    if y == 2021: return "2021"
    if y == 2022: return "2022"
    if y <= 2024: return "2023-24"
    return "2025-26"
ERAS = ["2019-20", "2021", "2022", "2023-24", "2025-26"]

# ---------- hedge01 helpers (live RANGE-only LONG) ----------
def atp(i): return None if atr4[i] is None else atr4[i] / c4[i]
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
def filt_h01(i):
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
def sim_h01(ei):
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
        if bars4h[j]["low"] <= sl: return (sl - ep) / ep - 2 * FEE, h, j
    j = min(ei + H.MAX_HOLD, n - 1)
    return (c4[j] - ep) / ep - 2 * FEE, H.MAX_HOLD, j
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
sigs = {"S12": sig_s12, "S13": sig_s13, "S14": sig_s14}
do_vol = {"S12": False, "S13": True, "S14": True}
CD = {"S12": 36, "S13": 1, "S14": 36}

# Run hedge01: collect trades AND occupied bar-intervals (entry..exit) for coverage
h01_trades = []   # dicts: entry_i, exit_j, ret
last = {s: 0 for s in sigs}
for i in range(250, n - H.MAX_HOLD):
    for sn in ("S12", "S13", "S14"):
        if sigs[sn](i) != "LONG": continue
        if i - last[sn] < CD[sn]: continue
        if do_vol[sn] and not vol_pass(i): continue
        if not filt_h01(i): continue
        r = sim_h01(i)
        if r is None: continue
        ret, h, j = r
        h01_trades.append({"ei": i, "ej": j, "ret": ret, "ts": bars4h[i]["time"], "exit_ts": bars4h[j]["time"]})
        last[sn] = i

# ---------- turtle daily (live: Donchian 20/12 LONG, skip-BEAR, ATR cut) ----------
DE, DX, CUT = 20, 12, 2.0
BD = bars1d; nd = len(BD); CC = [b["close"] for b in BD]
def atr_d(bars, p=14):
    m = len(bars); tr = [0.] * m
    for i in range(1, m): tr[i] = max(bars[i]["high"] - bars[i]["low"], abs(bars[i]["high"] - bars[i - 1]["close"]), abs(bars[i]["low"] - bars[i - 1]["close"]))
    o = [None] * m; o[p] = sum(tr[1:p + 1]) / p
    for i in range(p + 1, m): o[i] = (o[i - 1] * (p - 1) + tr[i]) / p
    return o
atrd = atr_d(BD); dhi = [None] * nd; dlo = [None] * nd
for i in range(DE, nd): dhi[i] = max(BD[j]["high"] for j in range(i - DE, i))
for i in range(DX, nd): dlo[i] = min(BD[j]["low"] for j in range(i - DX, i))
def reg_d(i): return get_reg(BD[i]["time"])
tur_trades = []  # dicts entry_day, exit_day ts
hold = False; e = 0.0; a = 0.0; e_ts = 0
for i in range(max(DE, 20), nd):
    if hold:
        ex = None
        if BD[i]["low"] <= e - a * CUT: ex = e - a * CUT
        elif dlo[i] is not None and CC[i] < dlo[i]: ex = CC[i]
        if ex is not None:
            tur_trades.append({"ret": (ex - e) / e - 2 * FEE, "ts": e_ts, "exit_ts": BD[i]["time"]}); hold = False
    if not hold and dhi[i] is not None and CC[i] > dhi[i] and reg_d(i) != "BEAR":
        hold = True; e = CC[i]; a = atrd[i] or 0; e_ts = BD[i]["time"]
if hold: tur_trades.append({"ret": (CC[-1] - e) / e - 2 * FEE, "ts": e_ts, "exit_ts": BD[-1]["time"]})

# ========== TASK 1: COVERAGE ==========
# Build per-4h-bar occupancy: 1 if hedge01 OR turtle holds during that bar
occ = [0] * n
ts4 = [b["time"] for b in bars4h]
def bar_idx(ts):
    lo, hi, idx = 0, n - 1, 0
    while lo <= hi:
        m = (lo + hi) // 2
        if ts4[m] <= ts: idx = m; lo = m + 1
        else: hi = m - 1
    return idx
for t in h01_trades:
    for k in range(t["ei"], min(t["ej"], n - 1) + 1): occ[k] = 1
for t in tur_trades:
    a0 = bar_idx(t["ts"]); a1 = bar_idx(t["exit_ts"])
    for k in range(a0, min(a1, n - 1) + 1): occ[k] = 1

# valid bars = those with regime computed (after warmup)
start = 250
total_bars = n - start
occ_bars = sum(occ[start:])
print("=" * 70)
print("TASK 1 — BOOK COVERAGE (hedge01 RANGE-only + turtle daily, 7y 4h bars)")
print("=" * 70)
print(f"  total bars (post-warmup): {total_bars}  | occupied: {occ_bars} ({occ_bars/total_bars*100:.1f}%) | FLAT: {(total_bars-occ_bars)/total_bars*100:.1f}%")

# occupancy by regime
reg_total = defaultdict(int); reg_occ = defaultdict(int)
for k in range(start, n):
    rg = get_reg(ts4[k]); reg_total[rg] += 1
    if occ[k]: reg_occ[rg] += 1
print("  occupancy by regime:")
for rg in ("BULL", "RANGE", "BEAR"):
    tt = reg_total[rg]
    print(f"    {rg:6s}: {reg_total[rg]/total_bars*100:5.1f}% of time | occupied {reg_occ[rg]/tt*100 if tt else 0:5.1f}% of {rg} | FLAT in {rg}: {(tt-reg_occ[rg])/tt*100 if tt else 0:5.1f}%")

# missed move $: for each FLAT contiguous run, measure abs price move; tally per regime
flat_moves = defaultdict(float)  # regime -> sum abs % move during flat runs
k = start
while k < n:
    if occ[k] == 0:
        s = k
        while k < n and occ[k] == 0: k += 1
        ev = c4[k - 1]; sv = c4[s]
        mv = (ev - sv) / sv
        flat_moves[get_reg(ts4[s])] += abs(mv) * 100
    else: k += 1
print("  cumulative ABS price move during FLAT runs (missed directional energy, %):")
for rg in ("BULL", "RANGE", "BEAR"):
    print(f"    {rg:6s}: {flat_moves[rg]:+.0f}% abs")

# ========== TASK 2: BULL PULLBACK-CONTINUATION SLEEVE ==========
# Entry: regime BULL, EMA50 rising (e50[i] > e50[i-6]), prior bar dipped to/below EMA20
# (low_{i-1} <= e20_{i-1}), current bar closes back above EMA20 (resume). ADX>18 gate. LONG.
print()
print("=" * 70)
print("TASK 2 — BULL PULLBACK-CONTINUATION SLEEVE (4h, LONG, ATR trailing)")
print("=" * 70)
def e50_rising(i): return e50[i] is not None and e50[i - 6] is not None and e50[i] > e50[i - 6]
def sig_pb(i):
    if i < 60: return None
    if get_reg(ts4[i]) != "BULL": return None
    if not e50_rising(i): return None
    if e20[i] is None or e20[i - 1] is None: return None
    adv = adx4[i]
    if adv is None or adv <= 18: return None
    # pullback: prior bar low touched/below EMA20
    if bars4h[i - 1]["low"] > e20[i - 1]: return None
    # resume: current close back above EMA20 AND above prior close
    if c4[i] <= e20[i]: return None
    if c4[i] <= bars4h[i - 1]["close"]: return None
    return "LONG"
pb_trades = []
last_pb = -999
CD_PB = 6
for i in range(250, n - H.MAX_HOLD):
    if sig_pb(i) != "LONG": continue
    if i - last_pb < CD_PB: continue
    r = sim_h01(i)  # same ATR-trailing exit engine
    if r is None: continue
    ret, h, j = r
    pb_trades.append({"ei": i, "ej": j, "ret": ret, "ts": ts4[i], "exit_ts": ts4[j]})
    last_pb = i

def stats(trades, label):
    if not trades:
        print(f"  [{label}] NO TRADES"); return None
    rets = [t["ret"] for t in trades]; N = len(rets)
    mean = sum(rets) / N; sd = (sum((r - mean) ** 2 for r in rets) / N) ** 0.5 or 1e-9
    ra = mean / sd; wr = sum(1 for r in rets if r > 0) / N * 100
    usd = sum(BASE_QTY * c4[t["ei"]] * t["ret"] for t in trades)  # dollar-faithful approx
    # era split
    era = defaultdict(list)
    for t in trades: era[era_of(t["ts"])].append(t["ret"])
    pos = 0
    era_cells = []
    for ek in ERAS:
        vs = era.get(ek, [])
        if not vs: era_cells.append(f"{ek}:n0"); continue
        s = sum(vs); p = s > 0; pos += p
        era_cells.append(f"{ek}:n{len(vs)} {s*100:+.0f}% {'+' if p else '-'}")
    print(f"  [{label}] n={N} RA={ra:+.3f} WR={wr:.0f}% ROI={sum(rets)*100:+.0f}% ~USD={usd:+.0f}")
    print(f"    eras ({pos}/5 pos): " + " | ".join(era_cells))
    return {"trades": trades, "ra": ra, "era_pos": pos}

pb = stats(pb_trades, "BULL pullback-continuation")

# ========== Correlation pb vs hedge01 & turtle (monthly) ==========
def monthly(trades):
    mo = defaultdict(float)
    for t in trades: mo[datetime.datetime.utcfromtimestamp(t["exit_ts"]/1000).strftime("%Y-%m")] += t["ret"]
    return mo
def pearson(a, b):
    keys = sorted(set(a) | set(b))
    xs = [a.get(k, 0.0) for k in keys]; ys = [b.get(k, 0.0) for k in keys]
    N = len(keys); mx = sum(xs)/N; my = sum(ys)/N
    cov = sum((xs[i]-mx)*(ys[i]-my) for i in range(N))/N
    sx = (sum((v-mx)**2 for v in xs)/N)**0.5; sy = (sum((v-my)**2 for v in ys)/N)**0.5
    return cov/(sx*sy) if sx>0 and sy>0 else 0
if pb_trades:
    pb_mo = monthly(pb_trades); h01_mo = monthly(h01_trades); tur_mo = monthly(tur_trades)
    r_h = pearson(pb_mo, h01_mo); r_t = pearson(pb_mo, tur_mo)
    print(f"  monthly corr  pb vs hedge01 = {r_h:+.3f}  | pb vs turtle = {r_t:+.3f}  (additive bar |r|<0.3)")

# ========== TASK 3 pointer ==========
print()
print("=" * 70)
print("TASK 3 — VOL-SQUEEZE: KNOWN-DEAD (hedge05-turtle-research-2026-06-02 §①).")
print("  probe-hedge05-squeeze-7y.py: default RA0.021 TEST-0.007, WR42%, all variants neg.")
print("  Direction after compression = coin-flip + false-breakout. NOT re-run. Skip.")
print("  BEAR/SHORT (§②) also DEAD: all variants RA neg. hedge01 skip-BEAR is correct.")
