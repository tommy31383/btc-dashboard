#!/usr/bin/env python3
"""Task 3: SOL 12-month rolling corr with BTC-hedge01.
Uses H01_MONTHLY data from correlation-turtle-hedge01-7y + SOL from loop-hedge01-crossasset.
Computes BTC-hedge01 monthly returns and SOL-hedge01 monthly returns, then 12-month rolling Pearson.
"""
import importlib.util, datetime, math, sys
from collections import defaultdict

HP = "/Users/lap16116/BTC_PC/btc-dashboard/tools/backtest-bull-regime-reaudit-7y.py"
spec = importlib.util.spec_from_file_location("H", HP)
H = importlib.util.module_from_spec(spec); spec.loader.exec_module(H)
FEE = H.FEE
CC = "/Users/lap16116/BTC_PC/btc-dashboard/.cache"

def mo_of(ts): return datetime.datetime.utcfromtimestamp(ts/1000).strftime("%Y-%m")
def yr_of(ts): return datetime.datetime.utcfromtimestamp(ts/1000).year
def uhour(ts): return datetime.datetime.utcfromtimestamp(ts/1000).hour
def udow(ts): return datetime.datetime.utcfromtimestamp(ts/1000).weekday()

def run_hedge01(cache, skip_cal=True):
    H.CACHE = cache
    bars4h = H.load_tf(H.H4); bars1h = H.load_tf(3600*1000); bars1d = H.load_tf(86400*1000)
    n = len(bars4h); c4 = [b["close"] for b in bars4h]
    e50 = H.ema_s(c4, H.EMA_FAST); e200 = H.ema_s(c4, H.EMA_SLOW)
    atr4 = H.atr_series(bars4h); adx4 = H.adx_wilder(bars4h)
    e200_1h = H.ema_s([b["close"] for b in bars1h], 200); h1t = [b["time"] for b in bars1h]
    regime_1d = H.regime_with_persistence(bars1d)
    reg_map = {b["time"]//86400000: regime_1d[i] for i, b in enumerate(bars1d)}
    def get_reg(ts): return reg_map.get(ts//86400000, "RANGE")
    def atp(i): return None if atr4[i] is None else atr4[i]/c4[i]
    def atp_pass(i):
        if i < H.ATR_PCT_LB+14: return False
        vs = [atp(j) for j in range(i-H.ATR_PCT_LB, i) if atp(j) is not None]
        if len(vs) < H.ATR_PCT_LB: return False
        cur = atp(i); return cur is not None and cur >= sorted(vs)[int(len(vs)*H.ATR_PCT_PCTL)]
    def vol_pass(i):
        if i < H.VOL_MA: return False
        ma = sum(bars4h[j]["volume"] for j in range(i-H.VOL_MA, i))/H.VOL_MA
        return bars4h[i]["volume"] >= ma*H.VOL_MULT
    def e200_1h_at(ts):
        lo, hi, idx = 0, len(h1t)-1, 0
        while lo <= hi:
            m = (lo+hi)//2
            if h1t[m] <= ts: idx = m; lo = m+1
            else: hi = m-1
        return e200_1h[idx]
    def filt(i):
        adv = adx4[i]
        if adv is None or adv <= H.ADX_THRESH: return False
        ap = adx4[i-1] if i >= 1 else None
        if ap is None or ap <= H.ADX_THRESH: return False
        e1h = e200_1h_at(bars4h[i]["time"])
        if e1h is None or c4[i] < e1h: return False
        if not atp_pass(i): return False
        if skip_cal and H.SKIP_H16 and uhour(bars4h[i]["time"]) == 16: return False
        if skip_cal and H.SKIP_THU_SUN:
            dw = udow(bars4h[i]["time"])
            if dw == 3 or dw == 6: return False
        return get_reg(bars4h[i]["time"]) == "RANGE"
    def sim(ei):
        ep = c4[ei]; ae = atr4[ei]
        if ae is None or ae <= 0: return None
        sl = ep - ae*H.SL_INIT; hwm = ep
        for h in range(1, H.MAX_HOLD+1):
            j = ei+h
            if j >= n: break
            mult = H.SL_INIT if h < H.SL_TRANS else H.SL_TRAIL
            if c4[j] > hwm: hwm = c4[j]; sl = hwm - ae*mult
            elif h >= H.SL_TRANS:
                t = hwm - ae*H.SL_TRAIL
                if t > sl: sl = t
            if bars4h[j]["low"] <= sl: return (sl-ep)/ep - 2*FEE, h
        j = min(ei+H.MAX_HOLD, n-1)
        return (c4[j]-ep)/ep - 2*FEE, H.MAX_HOLD
    def sig_s12(i):
        if None in (e50[i], e200[i]) or i < 1 or None in (e50[i-1], e200[i-1]): return None
        return "LONG" if e50[i-1] <= e200[i-1] and e50[i] > e200[i] else None
    def sig_s13(i):
        if atr4[i] is None or i < 1: return None
        return "LONG" if c4[i] > bars4h[i-1]["close"]+atr4[i]*H.ATR_BREAK_MULT else None
    def sig_s14(i):
        if i < H.DONCHIAN_LB: return None
        hi = max(bars4h[j]["high"] for j in range(i-H.DONCHIAN_LB, i))
        return "LONG" if c4[i] > hi else None
    sigs = {"S12": sig_s12, "S13": sig_s13, "S14": sig_s14}
    do_vol = {"S12": False, "S13": True, "S14": True}
    CD_map = {"S12": 36, "S13": 1, "S14": 36}
    mo = defaultdict(float); last = {s: 0 for s in sigs}
    for i in range(250, n-H.MAX_HOLD):
        for sn in ("S12", "S13", "S14"):
            if sigs[sn](i) != "LONG": continue
            if i-last[sn] < CD_map[sn]: continue
            if do_vol[sn] and not vol_pass(i): continue
            if not filt(i): continue
            r = sim(i)
            if r is None: continue
            ret, h = r; cts = bars4h[min(i+h, n-1)]["time"]
            mo[mo_of(cts)] += ret
            last[sn] = i
    return mo

print("Running BTC-hedge01...")
btc_mo = run_hedge01(f"{CC}/binance-5m-7y.json")
print("Running SOL-hedge01...")
sol_mo = run_hedge01(f"{CC}/binance-sol-5m-3y.json")

# All months in common window (SOL 3y data)
all_months = sorted(set(btc_mo) | set(sol_mo))
print(f"\nBTC months: {len(btc_mo)}, SOL months: {len(sol_mo)}, union: {len(all_months)}")
print(f"SOL window: {min(sol_mo) if sol_mo else 'N/A'} → {max(sol_mo) if sol_mo else 'N/A'}")

# Build aligned series (common window only — SOL has 3y)
sol_start = min(sol_mo) if sol_mo else None
common_months = [m for m in all_months if m >= (sol_start or "")]

def pearson(xs, ys):
    n = len(xs)
    if n < 2: return 0.0
    mx = sum(xs)/n; my = sum(ys)/n
    cov = sum((xs[i]-mx)*(ys[i]-my) for i in range(n))/n
    sx = (sum((v-mx)**2 for v in xs)/n)**0.5
    sy = (sum((v-my)**2 for v in ys)/n)**0.5
    if sx < 1e-9 or sy < 1e-9: return 0.0
    return cov/(sx*sy)

# 12-month rolling windows (step = 1 month)
print("\n=== 12-month rolling corr(BTC-hedge01, SOL-hedge01) ===")
print(f"  Window (end) | corr | n_active | flag")
high_corr_windows = []
all_corrs = []
for i in range(12, len(common_months)+1):
    window = common_months[i-12:i]
    xs = [btc_mo.get(m, 0.0) for m in window]
    ys = [sol_mo.get(m, 0.0) for m in window]
    # Only count windows where at least one is active
    btc_active = sum(1 for m in window if btc_mo.get(m, 0.0) != 0.0)
    sol_active = sum(1 for m in window if sol_mo.get(m, 0.0) != 0.0)
    r = pearson(xs, ys)
    all_corrs.append(r)
    flag = "*** HIGH ***" if abs(r) > 0.5 else ""
    print(f"  {window[-1]} | {r:+.3f} | BTC:{btc_active} SOL:{sol_active} | {flag}")
    if abs(r) > 0.5:
        high_corr_windows.append((window[0], window[-1], r))

if all_corrs:
    sorted_corrs = sorted(all_corrs)
    n = len(sorted_corrs)
    median = sorted_corrs[n//2]
    print(f"\nSummary:")
    print(f"  Total windows: {n}")
    print(f"  Median |corr|: {sum(abs(v) for v in all_corrs)/n:.3f}")
    print(f"  Median corr: {median:+.3f}")
    print(f"  Windows |corr| > 0.5: {len(high_corr_windows)}")
    print(f"  Max corr: {max(all_corrs):+.3f}  Min corr: {min(all_corrs):+.3f}")
    verdict = "STABLE" if sum(abs(v) for v in all_corrs)/n < 0.3 else "UNSTABLE"
    print(f"\nVERDICT: {verdict} (median |corr| {'<' if sum(abs(v) for v in all_corrs)/n < 0.3 else '>='} 0.3)")
    if high_corr_windows:
        print("\nHigh-corr windows (|corr| > 0.5):")
        for s, e, r in high_corr_windows:
            print(f"  {s} → {e}: {r:+.3f}")
