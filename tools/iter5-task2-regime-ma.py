#!/usr/bin/env python3
"""
Iteration 5 Task 2: Regime MA Period Sensitivity
Test MA combos: (30,200), (50,200), (50,150), (100,200)
vs baseline (50,200) = current
Judge: Sharpe + total ret% + n trades
"""
import json, datetime, importlib.util, math
from collections import defaultdict

HP = "/Users/lap16116/BTC_PC/btc-dashboard/tools/backtest-bull-regime-reaudit-7y.py"
spec = importlib.util.spec_from_file_location("H", HP)
H = importlib.util.module_from_spec(spec); spec.loader.exec_module(H)

# v0.4.73 params
H.ADX_THRESH = 18
H.ADX_P = 12
H.SL_INIT = 3.0
H.SL_TRAIL = 3.5
H.SL_TRANS = 64
H.ATR_BREAK_MULT = 1.3
H.VOL_MULT = 1.4
H.VOL_MA = 16
H.DONCHIAN_LB = 18
H.SKIP_SHORT = True
H.SKIP_H16 = True
H.SKIP_THU_SUN = True

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FEE = H.FEE

def yr_of(ts): return datetime.datetime.utcfromtimestamp(ts/1000).year
def mo_of(ts): return datetime.datetime.utcfromtimestamp(ts/1000).strftime("%Y-%m")

def regime_with_ma(bars1d, fast_n, slow_n, persist_n=3):
    """Same as H.regime_with_persistence but parameterized MA periods."""
    cs = [b["close"] for b in bars1d]
    n = len(bars1d)
    raw = ["RANGE"] * n
    for i in range(slow_n, n):
        ma_slow = sum(cs[i-slow_n+1:i+1]) / slow_n
        ma_fast = sum(cs[i-fast_n+1:i+1]) / fast_n
        r20 = bars1d[i-19:i+1]
        ar = sum((b["high"]-b["low"])/b["close"] for b in r20)/20
        if cs[i] < ma_slow: raw[i] = "BEAR"
        elif cs[i] > ma_fast and ma_fast > ma_slow and ar > 0.04: raw[i] = "BULL"
    out = ["RANGE"] * n
    cur = "RANGE"; cnt = 0; last_raw = "RANGE"
    for i in range(n):
        r = raw[i]
        if r == last_raw: cnt += 1
        else: cnt = 1; last_raw = r
        if cnt >= persist_n: cur = r
        out[i] = cur
    return out

def run_hedge01_with_regime(bars4h, bars1h, bars1d, atr4, adx4, e50, e200, e200_1h, h1t, c4, n, reg_map):
    """Run hedge01 RANGE-only using provided reg_map."""
    def get_reg(ts): return reg_map.get(ts//86400000, "RANGE")

    def atp(i):
        if atr4[i] is None: return None
        return atr4[i]/c4[i]

    def atp_pass(i):
        if i < H.ATR_PCT_LB+H.ADX_P: return False
        vs = [atp(j) for j in range(i-H.ATR_PCT_LB, i) if atp(j) is not None]
        if len(vs) < H.ATR_PCT_LB: return False
        cur = atp(i)
        return cur is not None and cur >= sorted(vs)[int(len(vs)*H.ATR_PCT_PCTL)]

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

    def uhour(ts): return datetime.datetime.utcfromtimestamp(ts/1000).hour
    def udow(ts): return datetime.datetime.utcfromtimestamp(ts/1000).weekday()

    def filt(i):
        adv = adx4[i]
        if adv is None or adv <= H.ADX_THRESH: return False
        ap = adx4[i-1] if i >= 1 else None
        if ap is None or ap <= H.ADX_THRESH: return False
        e1h = e200_1h_at(bars4h[i]["time"])
        if e1h is None or c4[i] < e1h: return False
        if not atp_pass(i): return False
        if H.SKIP_H16 and uhour(bars4h[i]["time"]) == 16: return False
        if H.SKIP_THU_SUN:
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
    CD = {"S12": 36, "S13": 1, "S14": 36}

    mo = defaultdict(float)
    yrr = defaultdict(float)
    trades = []
    last = {s: 0 for s in sigs}

    for i in range(250, n-H.MAX_HOLD):
        for sn in ("S12", "S13", "S14"):
            if sigs[sn](i) != "LONG": continue
            if i-last[sn] < CD[sn]: continue
            if do_vol[sn] and not vol_pass(i): continue
            if not filt(i): continue
            r = sim(i)
            if r is None: continue
            ret, h = r
            cts = bars4h[min(i+h, n-1)]["time"]
            mo[mo_of(cts)] += ret
            yrr[yr_of(cts)] += ret
            trades.append({"ret": ret, "yr": yr_of(bars4h[i]["time"])})
            last[sn] = i

    return trades, mo, yrr

def sharpe_mo(mo):
    vals = list(mo.values())
    if len(vals) < 2: return 0.0
    m = sum(vals)/len(vals)
    d = (sum((v-m)**2 for v in vals)/len(vals))**0.5 or 1e-9
    return m/d*math.sqrt(12)

def main():
    print("Loading data...")
    H.CACHE = CACHE
    bars4h = H.load_tf(H.H4)
    bars1h = H.load_tf(3600*1000)
    bars1d = H.load_tf(86400*1000)
    n = len(bars4h)
    c4 = [b["close"] for b in bars4h]

    e50 = H.ema_s(c4, H.EMA_FAST)
    e200 = H.ema_s(c4, H.EMA_SLOW)
    atr4 = H.atr_series(bars4h, H.ADX_P)
    adx4 = H.adx_wilder(bars4h, H.ADX_P)
    e200_1h = H.ema_s([b["close"] for b in bars1h], 200)
    h1t = [b["time"] for b in bars1h]

    MA_COMBOS = [
        (50, 200, "BASELINE (50,200)"),
        (30, 200, "FAST (30,200)"),
        (50, 150, "SHORT_SLOW (50,150)"),
        (100, 200, "SLOW (100,200)"),
    ]

    print(f"\n=== Task 2: Regime MA Period Sensitivity ===")
    print(f"  {'Config':>22} | {'N':>4} | {'WR%':>4} | {'ret%':>7} | {'Sh(mo)':>7} | {'stab':>5} | per-year")

    for fast_n, slow_n, label in MA_COMBOS:
        regime_1d = regime_with_ma(bars1d, fast_n, slow_n)
        reg_map = {b["time"]//86400000: regime_1d[i] for i, b in enumerate(bars1d)}

        # Count regime distribution
        regime_counts = defaultdict(int)
        for i, b in enumerate(bars1d):
            regime_counts[regime_1d[i]] += 1

        trades, mo, yrr = run_hedge01_with_regime(
            bars4h, bars1h, bars1d, atr4, adx4, e50, e200, e200_1h, h1t, c4, n, reg_map
        )

        if not trades:
            print(f"  {label:>22} | NO TRADES")
            continue

        rets = [t["ret"] for t in trades]
        tot = sum(rets)*100
        wr = sum(1 for r in rets if r > 0)/len(rets)*100
        sh = sharpe_mo(mo)
        stab = sum(1 for y in sorted(yrr) if yrr[y] > 0)
        pyr = " ".join(f"{y%100}:{yrr[y]*100:+.0f}" for y in sorted(yrr))

        total_bear = regime_counts["BEAR"]
        total_bull = regime_counts["BULL"]
        total_range = regime_counts["RANGE"]
        total_days = sum(regime_counts.values())

        print(f"  {label:>22} | {len(trades):>4} | {wr:>4.0f} | {tot:>+7.1f} | {sh:>+7.3f} | {stab:>4}/8 | {pyr}")
        print(f"    Regime distribution (daily): RANGE={total_range/total_days*100:.1f}% BULL={total_bull/total_days*100:.1f}% BEAR={total_bear/total_days*100:.1f}%")

    print("\nDone.")

if __name__ == "__main__":
    main()
