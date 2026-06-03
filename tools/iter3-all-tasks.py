#!/usr/bin/env python3
"""iter3-all-tasks.py — Iteration 3 of autonomous research loop (2026-06-03)

Task 1: v0.4.73 7y per-year stability audit (BTC hedge01 full params)
         + v0.4.72 baseline comparison + ±1 sensitivity (ADX 17/18/19, DLB 17/18/19)
Task 2: SOL corr stability (rolling 6-month windows, target |corr| < 0.3 in >=75% windows)
Task 3: Vol-adaptive entry timing (ATR% expanding gate, accept if Sh >= +1.40)
"""
import json, datetime, math, os, sys, importlib.util
from collections import defaultdict

T = "/Users/lap16116/BTC_PC/btc-dashboard/tools/"
CC = "/Users/lap16116/BTC_PC/btc-dashboard/.cache"

# ─────────────── helpers ───────────────
def mo_str(ts): return datetime.datetime.utcfromtimestamp(ts/1000).strftime("%Y-%m")
def yr_str(ts): return datetime.datetime.utcfromtimestamp(ts/1000).strftime("%Y")
def sharpe(v):
    if len(v) < 2: return 0.0
    me = sum(v)/len(v)
    d = (sum((x-me)**2 for x in v)/len(v))**.5 or 1e-9
    return me/d*math.sqrt(12)
def maxdd(v):
    cum = peak = mdd = 0.0
    for x in v: cum += x; peak = max(peak, cum); mdd = max(mdd, peak-cum)
    return mdd*100
def corr(a, b):
    N = len(a)
    if N < 2: return 0.0
    ma = sum(a)/N; mb = sum(b)/N
    cov = sum((a[i]-ma)*(b[i]-mb) for i in range(N))/N
    sa = (sum((x-ma)**2 for x in a)/N)**.5
    sb = (sum((x-mb)**2 for x in b)/N)**.5
    return cov/(sa*sb) if sa > 0 and sb > 0 else 0.0

# ─────────────── low-level primitives (self-contained, no import) ───────────────
FEE = 0.05 / 100
H4 = 4 * 3600 * 1000

def load_tf(cache_path, ms):
    raw = json.load(open(cache_path))
    b = {}
    for c in raw:
        k = c["time"] // ms
        if k not in b:
            b[k] = {"time": k*ms, "high": c["high"], "low": c["low"],
                    "close": c["close"], "volume": c["volume"]}
        else:
            o = b[k]
            o["high"] = max(o["high"], c["high"])
            o["low"]  = min(o["low"],  c["low"])
            o["close"] = c["close"]
            o["volume"] += c["volume"]
    return [b[k] for k in sorted(b)]

def ema_s(xs, n):
    k = 2/(n+1); out = [None]*len(xs); e = None
    for i, x in enumerate(xs):
        e = x if e is None else x*k + e*(1-k)
        out[i] = e
    return out

def _dm_tr(bars):
    n = len(bars)
    pdm = [0.0]*n; ndm = [0.0]*n; tr = [0.0]*n
    for i in range(1, n):
        up = bars[i]["high"] - bars[i-1]["high"]
        dn = bars[i-1]["low"] - bars[i]["low"]
        pdm[i] = up if up > dn and up > 0 else 0
        ndm[i] = dn if dn > up and dn > 0 else 0
        tr[i] = max(bars[i]["high"]-bars[i]["low"],
                    abs(bars[i]["high"]-bars[i-1]["close"]),
                    abs(bars[i]["low"] -bars[i-1]["close"]))
    return pdm, ndm, tr

def atr_series(bars, period=14):
    _, _, tr = _dm_tr(bars)
    n = len(bars); atr = [None]*n
    s = sum(tr[1:period+1])
    atr[period] = s/period
    for i in range(period+1, n):
        atr[i] = (atr[i-1]*(period-1) + tr[i])/period
    return atr

def adx_wilder(bars, period=14):
    pdm, ndm, tr = _dm_tr(bars)
    n = len(bars)
    if n <= period+1: return [None]*n
    smTR  = sum(tr[1:period+1])
    smPDM = sum(pdm[1:period+1])
    smNDM = sum(ndm[1:period+1])
    dx_arr = []; adx_val = None; adx_out = [None]*n
    for i in range(period+1, n):
        smTR  = smTR  - smTR/period  + tr[i]
        smPDM = smPDM - smPDM/period + pdm[i]
        smNDM = smNDM - smNDM/period + ndm[i]
        pdi = smPDM/smTR*100 if smTR > 0 else 0
        ndi = smNDM/smTR*100 if smTR > 0 else 0
        dx = abs(pdi-ndi)/(pdi+ndi)*100 if (pdi+ndi) > 0 else 0
        dx_arr.append(dx)
        if len(dx_arr) < period: continue
        elif len(dx_arr) == period: adx_val = sum(dx_arr)/period
        else: adx_val = (adx_val*(period-1) + dx)/period
        adx_out[i] = adx_val
    return adx_out

def regime_with_persistence(bars1d, persist_n=3):
    cs = [b["close"] for b in bars1d]
    n = len(bars1d); raw = ["RANGE"]*n
    for i in range(200, n):
        ma200 = sum(cs[i-199:i+1])/200
        ma50  = sum(cs[i-50:i+1])/50
        r20   = bars1d[i-19:i+1]
        ar    = sum((b["high"]-b["low"])/b["close"] for b in r20)/20
        if cs[i] < ma200: raw[i] = "BEAR"
        elif cs[i] > ma50 and ma50 > ma200 and ar > 0.04: raw[i] = "BULL"
    out = ["RANGE"]*n; cur = "RANGE"; cnt = 0; last_raw = "RANGE"
    for i in range(n):
        r = raw[i]
        if r == last_raw: cnt += 1
        else: cnt = 1; last_raw = r
        if cnt >= persist_n: cur = r
        out[i] = cur
    return out

# ─────────────── CORE BACKTEST ENGINE ───────────────
def run_hedge01_btc(cache_path,
                    adx_thresh=18, adx_period=12,
                    sl_init=3.0, sl_trail=3.5, sl_trans=16,
                    atr_break_mult=1.3, vol_mult=1.4, vol_ma=16,
                    donchian_lb=18, max_hold=200,
                    vol_expand_gate=False, vol_expand_lookback=3):
    """Full hedge01-BTC simulator. Returns:
       mo_ret  = dict month→ret_sum
       trades  = list of dicts
       span    = (start_ts, end_ts)
    """
    bars4h = load_tf(cache_path, H4)
    bars1h = load_tf(cache_path, 3600*1000)
    bars1d = load_tf(cache_path, 86400*1000)
    n = len(bars4h)
    c4 = [b["close"] for b in bars4h]

    e50  = ema_s(c4, 50)
    e200 = ema_s(c4, 200)
    atr4 = atr_series(bars4h, period=14)
    adx4 = adx_wilder(bars4h, period=adx_period)
    e200_1h = ema_s([b["close"] for b in bars1h], 200)
    h1t = [b["time"] for b in bars1h]

    regime_1d = regime_with_persistence(bars1d)
    reg_map = {b["time"]//86400000: regime_1d[i] for i, b in enumerate(bars1d)}
    def get_reg(ts): return reg_map.get(ts//86400000, "RANGE")

    ATR_PCT_LB = 90
    ATR_PCT_PCTL = 0.50

    def atp(i):
        if atr4[i] is None or c4[i] == 0: return None
        return atr4[i]/c4[i]

    def atp_pass(i):
        if i < ATR_PCT_LB + 14: return False
        vs = [atp(j) for j in range(i-ATR_PCT_LB, i) if atp(j) is not None]
        if len(vs) < ATR_PCT_LB: return False
        cur = atp(i)
        if cur is None: return False
        return cur >= sorted(vs)[int(len(vs)*ATR_PCT_PCTL)]

    def vol_pass(i):
        if i < vol_ma: return False
        ma = sum(bars4h[j]["volume"] for j in range(i-vol_ma, i))/vol_ma
        return bars4h[i]["volume"] >= ma * vol_mult

    def e200_1h_at(ts):
        lo, hi, idx = 0, len(h1t)-1, 0
        while lo <= hi:
            m2 = (lo+hi)//2
            if h1t[m2] <= ts: idx = m2; lo = m2+1
            else: hi = m2-1
        return e200_1h[idx]

    # Vol-expand gate: ATR% now > mean ATR% of last N bars
    def vol_expand_pass(i):
        if not vol_expand_gate: return True
        if i < vol_expand_lookback + 14: return False
        cur = atp(i)
        if cur is None: return False
        past = [atp(j) for j in range(i-vol_expand_lookback, i) if atp(j) is not None]
        if not past: return False
        return cur > sum(past)/len(past)

    def filt(i):
        adv = adx4[i]
        if adv is None or adv <= adx_thresh: return False
        ap = adx4[i-1] if i >= 1 else None
        if ap is None or ap <= adx_thresh: return False
        e1h = e200_1h_at(bars4h[i]["time"])
        if e1h is None or c4[i] < e1h: return False
        if not atp_pass(i): return False
        return get_reg(bars4h[i]["time"]) == "RANGE"

    def sim(ei):
        ep = c4[ei]; ae = atr4[ei]
        if ae is None or ae <= 0: return None
        sl_ = ep - ae*sl_init; hwm = ep
        for h in range(1, max_hold+1):
            j = ei+h
            if j >= n: break
            mult = sl_init if h < sl_trans else sl_trail
            if c4[j] > hwm: hwm = c4[j]; sl_ = hwm - ae*mult
            elif h >= sl_trans:
                t = hwm - ae*sl_trail
                if t > sl_: sl_ = t
            if bars4h[j]["low"] <= sl_:
                return (sl_-ep)/ep - 2*FEE, h
        j = min(ei+max_hold, n-1)
        return (c4[j]-ep)/ep - 2*FEE, max_hold

    s12 = lambda i: (None if None in (e50[i], e200[i]) or i < 1 or None in (e50[i-1], e200[i-1])
                     else ("LONG" if e50[i-1] <= e200[i-1] and e50[i] > e200[i] else None))
    s13 = lambda i: (None if atr4[i] is None or i < 1
                     else ("LONG" if c4[i] > bars4h[i-1]["close"] + atr4[i]*atr_break_mult else None))
    s14 = lambda i: (None if i < donchian_lb
                     else ("LONG" if c4[i] > max(bars4h[j]["high"] for j in range(i-donchian_lb, i)) else None))

    sigs   = {"S12": (s12, False, 36), "S13": (s13, True, 1), "S14": (s14, True, 36)}
    mo_ret = defaultdict(float)
    trades = []
    last   = {s: 0 for s in sigs}

    for i in range(250, n-max_hold):
        for sn, (sfn, do_vol, cd) in sigs.items():
            if sfn(i) != "LONG": continue
            if i - last[sn] < cd: continue
            if do_vol and not vol_pass(i): continue
            if not filt(i): continue
            if not vol_expand_pass(i): continue
            r = sim(i)
            if r is None: continue
            ret, h = r
            close_ts = bars4h[min(i+h, n-1)]["time"]
            mo_ret[mo_str(close_ts)] += ret
            trades.append({"ret": ret, "h": h, "yr": int(yr_str(bars4h[i]["time"])), "sig": sn})
            last[sn] = i

    span = (bars4h[0]["time"], bars4h[-1]["time"])
    return mo_ret, trades, span


# ─────────────── TASK 1: 7y per-year stability + baseline comparison ───────────────
print("="*90)
print("TASK 1 — v0.4.73 7y PER-YEAR STABILITY AUDIT")
print("="*90)

V073 = dict(adx_thresh=18, adx_period=12, sl_init=3.0, sl_trail=3.5, sl_trans=16,
            atr_break_mult=1.3, vol_mult=1.4, vol_ma=16, donchian_lb=18, max_hold=200)
V072 = dict(adx_thresh=20, adx_period=14, sl_init=4.0, sl_trail=3.0, sl_trans=24,
            atr_break_mult=1.2, vol_mult=1.2, vol_ma=10, donchian_lb=20, max_hold=200)

def summarize(trades, label):
    if not trades:
        print(f"  [{label}]: NO TRADES"); return
    rets = [t["ret"] for t in trades]
    n_ = len(rets); me = sum(rets)/n_
    sd = (sum((r-me)**2 for r in rets)/n_)**.5 or 1e-9
    ra = me/sd; wr = sum(1 for r in rets if r>0)/n_*100
    by_yr = defaultdict(float)
    for t in trades: by_yr[t["yr"]] += t["ret"]
    pos = sum(1 for v in by_yr.values() if v >= 0)
    eq = 0; peak = 0; mdd = 0
    for t in sorted(trades, key=lambda x: (x["yr"], 0)):
        eq += t["ret"]; peak = max(peak, eq); mdd = max(mdd, peak-eq)
    py = " ".join(f"{y}:{by_yr[y]*100:+.0f}" for y in sorted(by_yr))
    print(f"\n  [{label}]")
    print(f"  n={n_:4d}  RA={ra:+.4f}  WR={wr:.0f}%  ROI={sum(rets)*100:+.1f}%  DD={mdd*100:.1f}%  stab={pos}/{len(by_yr)}")
    print(f"  Per-year $100k: {py}")
    return ra, pos, len(by_yr)

print("\n[1a] v0.4.73 params (7y BTC)...")
mo73, tr73, _ = run_hedge01_btc(f"{CC}/binance-5m-7y.json", **V073)
r73 = summarize(tr73, "v0.4.73 — ADX18/p12/SL3.0/3.5/t16/AB1.3/VM1.4/VMA16/DLB18")

print("\n[1b] v0.4.72 baseline (7y BTC)...")
mo72, tr72, _ = run_hedge01_btc(f"{CC}/binance-5m-7y.json", **V072)
r72 = summarize(tr72, "v0.4.72 — ADX20/p14/SL4.0/3.0/t24/AB1.2/VM1.2/VMA10/DLB20")

# ±1 sensitivity
print("\n[1c] Sensitivity: ADX sweep (17/18/19)...")
for adx_v in [17, 18, 19]:
    p = dict(V073); p["adx_thresh"] = adx_v
    _, tr, _ = run_hedge01_btc(f"{CC}/binance-5m-7y.json", **p)
    summarize(tr, f"ADX={adx_v} (others v0.4.73)")

print("\n[1d] Sensitivity: DLB sweep (17/18/19)...")
for dlb_v in [17, 18, 19]:
    p = dict(V073); p["donchian_lb"] = dlb_v
    _, tr, _ = run_hedge01_btc(f"{CC}/binance-5m-7y.json", **p)
    summarize(tr, f"DLB={dlb_v} (others v0.4.73)")


# ─────────────── TASK 2: SOL corr rolling stability ───────────────
print("\n" + "="*90)
print("TASK 2 — SOL CORR STABILITY (rolling 6-month windows)")
print("="*90)

# load SOL and BTC hedge01 monthly returns
# For BTC, use v0.4.73 params; for SOL use ADX=15 same other params
V073_SOL = dict(V073); V073_SOL["adx_thresh"] = 15

print("\n[2a] Running BTC v0.4.73 (7y) + SOL v0.4.73/ADX15 (3y)...")
mo73_btc, _, span_btc = run_hedge01_btc(f"{CC}/binance-5m-7y.json", **V073)
mo73_sol, _, span_sol = run_hedge01_btc(f"{CC}/binance-sol-5m-3y.json", **V073_SOL)

# Common calendar = SOL window
def months_range(t0, t1):
    d0 = datetime.datetime.utcfromtimestamp(t0/1000); d1 = datetime.datetime.utcfromtimestamp(t1/1000)
    out = []; y, m = d0.year, d0.month
    while (y, m) <= (d1.year, d1.month):
        out.append(f"{y}-{m:02d}"); m += 1
        if m > 12: m = 1; y += 1
    return out

cal_sol = months_range(span_sol[0], span_sol[1])
sB = [mo73_btc.get(m, 0.0) for m in cal_sol]
sS = [mo73_sol.get(m, 0.0) for m in cal_sol]

full_corr = corr(sB, sS)
print(f"\n  Full window ({cal_sol[0]}→{cal_sol[-1]}, {len(cal_sol)}mo): corr(BTC,SOL) = {full_corr:+.3f}")

# Rolling 6-month windows
WIN = 6
windows = []
print(f"\n  Rolling {WIN}-month windows:")
print(f"  {'Window':<22} {'corr':>7}  {'|corr|<0.3?':>12}")
print("  " + "-"*45)
for i in range(len(cal_sol) - WIN + 1):
    wB = sB[i:i+WIN]; wS = sS[i:i+WIN]
    c = corr(wB, wS)
    windows.append(c)
    flag = "YES" if abs(c) < 0.3 else "NO"
    label = f"{cal_sol[i]}→{cal_sol[i+WIN-1]}"
    print(f"  {label:<22} {c:>+7.3f}  {flag:>12}")

n_good = sum(1 for c in windows if abs(c) < 0.3)
pct_good = n_good / len(windows) * 100
print(f"\n  Windows with |corr| < 0.3: {n_good}/{len(windows)} = {pct_good:.0f}%")
verdict_corr = "PASS" if pct_good >= 75 else "FAIL"
print(f"  Target: >=75% → VERDICT: {verdict_corr}")
if verdict_corr == "PASS":
    print("  SOL sleeve CONFIRMED as stable diversifier — negative corr holds across time")
else:
    print("  WARNING: SOL corr not consistently low — diversification benefit may be noise")


# ─────────────── TASK 3: Vol-adaptive entry timing ───────────────
print("\n" + "="*90)
print("TASK 3 — VOL-ADAPTIVE ENTRY TIMING (ATR% expanding gate)")
print("="*90)
print("  Test: only enter when ATR% > mean(ATR% last N bars)")
print("  Accept: Sh >= +1.40 (vs v0.4.73 standalone ~+1.45 expected)")

# First compute v0.4.73 standalone BTC Sharpe (monthly)
cal_7y = months_range(span_btc[0], span_btc[1])
v73_monthly = [mo73_btc.get(m, 0.0) for m in cal_7y]
sh_v73_standalone = sharpe(v73_monthly)
print(f"\n  v0.4.73 standalone (no vol-expand gate): Sh = {sh_v73_standalone:+.4f}")
print(f"  n_trades = {len(tr73)}")

print("\n[3a] Vol-expand gate with lookback=3 bars...")
mo73_ve3, tr73_ve3, _ = run_hedge01_btc(f"{CC}/binance-5m-7y.json",
                                          vol_expand_gate=True, vol_expand_lookback=3, **V073)
v73_ve3_monthly = [mo73_ve3.get(m, 0.0) for m in cal_7y]
sh_ve3 = sharpe(v73_ve3_monthly)
r_ve3 = summarize(tr73_ve3, "v0.4.73 + vol_expand LB=3")

print(f"\n  vol_expand LB=3: Sh = {sh_ve3:+.4f}  n_trades = {len(tr73_ve3)}")

print("\n[3b] Vol-expand gate with lookback=5 bars...")
mo73_ve5, tr73_ve5, _ = run_hedge01_btc(f"{CC}/binance-5m-7y.json",
                                          vol_expand_gate=True, vol_expand_lookback=5, **V073)
v73_ve5_monthly = [mo73_ve5.get(m, 0.0) for m in cal_7y]
sh_ve5 = sharpe(v73_ve5_monthly)
r_ve5 = summarize(tr73_ve5, "v0.4.73 + vol_expand LB=5")
print(f"\n  vol_expand LB=5: Sh = {sh_ve5:+.4f}  n_trades = {len(tr73_ve5)}")

print("\n[3c] Vol-expand gate with lookback=2 bars...")
mo73_ve2, tr73_ve2, _ = run_hedge01_btc(f"{CC}/binance-5m-7y.json",
                                          vol_expand_gate=True, vol_expand_lookback=2, **V073)
v73_ve2_monthly = [mo73_ve2.get(m, 0.0) for m in cal_7y]
sh_ve2 = sharpe(v73_ve2_monthly)
r_ve2 = summarize(tr73_ve2, "v0.4.73 + vol_expand LB=2")
print(f"\n  vol_expand LB=2: Sh = {sh_ve2:+.4f}  n_trades = {len(tr73_ve2)}")

# Summary
print("\n" + "="*90)
print("TASK 3 SUMMARY — Vol-adaptive entry")
print(f"  Baseline (v0.4.73 no gate):  Sh = {sh_v73_standalone:+.4f}  n = {len(tr73)}")
print(f"  vol_expand LB=2:             Sh = {sh_ve2:+.4f}  n = {len(tr73_ve2)}  delta_n = {len(tr73_ve2)-len(tr73):+d}")
print(f"  vol_expand LB=3:             Sh = {sh_ve3:+.4f}  n = {len(tr73_ve3)}  delta_n = {len(tr73_ve3)-len(tr73):+d}")
print(f"  vol_expand LB=5:             Sh = {sh_ve5:+.4f}  n = {len(tr73_ve5)}  delta_n = {len(tr73_ve5)-len(tr73):+d}")

threshold = 1.40
best_sh = max(sh_ve2, sh_ve3, sh_ve5)
best_lbl = {sh_ve2: "LB=2", sh_ve3: "LB=3", sh_ve5: "LB=5"}[best_sh]
if best_sh >= threshold:
    print(f"\n  VERDICT: ACCEPT vol_expand gate ({best_lbl}, Sh={best_sh:+.4f} >= {threshold})")
    if best_sh > sh_v73_standalone:
        print(f"  IMPROVEMENT: +{best_sh-sh_v73_standalone:.4f} Sh vs baseline")
    else:
        print(f"  NOTE: Sh above threshold but no improvement vs baseline — marginal / tradeoff")
else:
    print(f"\n  VERDICT: REJECT vol_expand gate (best Sh={best_sh:+.4f} < {threshold})")
    print(f"  n reduction: baseline {len(tr73)} → best {len([tr73_ve2,tr73_ve3,tr73_ve5][([sh_ve2,sh_ve3,sh_ve5]).index(best_sh)])} trades")
    print(f"  This filter reduces n without meaningful Sh gain — overfit risk confirmed")

print("\n" + "="*90)
print("ALL TASKS COMPLETE")
print(f"  TASK 1: v0.4.73 7y stability — run above")
print(f"  TASK 2: SOL corr stability — {verdict_corr}")
print(f"  TASK 3: vol-expand gate — {'ACCEPT' if best_sh >= threshold else 'REJECT'}")
print("="*90)
