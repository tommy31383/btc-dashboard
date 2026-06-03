#!/usr/bin/env python3
"""
Iteration 5 Task 1: 2026 YTD Drawdown Analysis
- Count hedge01 entries in 2026
- Regime distribution in 2026 (how many 4h bars RANGE/BULL/BEAR)
- Why 2026 = -$2k?
Uses v0.4.73 params: ADX=18/12, SL=3.0/3.5/64h, ATR_BREAK=1.3, VOL=1.4/16, DLB=18, RANGE-only
"""
import json, datetime, importlib.util, sys
from collections import defaultdict

HP = "/Users/lap16116/BTC_PC/btc-dashboard/tools/backtest-bull-regime-reaudit-7y.py"
spec = importlib.util.spec_from_file_location("H", HP)
H = importlib.util.module_from_spec(spec); spec.loader.exec_module(H)

# Override v0.4.73 params
H.ADX_THRESH = 18
H.ADX_P = 12   # ADX period=12 for faster signal
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
    regime_1d = H.regime_with_persistence(bars1d)
    reg_map = {b["time"]//86400000: regime_1d[i] for i, b in enumerate(bars1d)}

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
            if bars4h[j]["low"] <= sl: return (sl-ep)/ep - 2*FEE, h, bars4h[j]["time"]
        j = min(ei+H.MAX_HOLD, n-1)
        return (c4[j]-ep)/ep - 2*FEE, H.MAX_HOLD, bars4h[j]["time"]

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

    # --- Count 4h bars by regime for 2026 ---
    regime_2026 = defaultdict(int)
    for b in bars4h:
        if yr_of(b["time"]) == 2026:
            reg = get_reg(b["time"])
            regime_2026[reg] += 1

    total_2026_bars = sum(regime_2026.values())
    print(f"\n=== 2026 YTD 4h Bar Regime Distribution ===")
    print(f"  Total 4h bars: {total_2026_bars}")
    for reg in ["RANGE", "BULL", "BEAR"]:
        cnt = regime_2026[reg]
        pct = cnt/total_2026_bars*100 if total_2026_bars else 0
        print(f"  {reg}: {cnt} bars ({pct:.1f}%)")

    # --- Count trades in 2026 ---
    all_trades = []
    last = {s: 0 for s in sigs}
    for i in range(250, n-H.MAX_HOLD):
        for sn in ("S12", "S13", "S14"):
            if sigs[sn](i) != "LONG": continue
            if i-last[sn] < CD[sn]: continue
            if do_vol[sn] and not vol_pass(i): continue
            if not filt(i): continue
            r = sim(i)
            if r is None: continue
            ret, h, exit_ts = r
            entry_ts = bars4h[i]["time"]
            entry_yr = yr_of(entry_ts)
            exit_yr = yr_of(exit_ts)
            all_trades.append({
                "ret": ret, "h": h,
                "entry_ts": entry_ts,
                "exit_ts": exit_ts,
                "entry_yr": entry_yr,
                "exit_yr": exit_yr,
                "setup": sn,
                "regime": get_reg(entry_ts),
                "entry_price": c4[i],
            })
            last[sn] = i

    # 7y per-year summary
    by_yr = defaultdict(list)
    for t in all_trades:
        by_yr[t["entry_yr"]].append(t)

    print(f"\n=== 7y Per-Year Trades Summary (entry year) ===")
    print(f"  {'Year':>4} | {'N':>3} | {'Wins':>4} | {'WR%':>4} | {'ret%':>7} | {'$PnL':>7}")
    for yr in sorted(by_yr):
        ts = by_yr[yr]
        rets = [t["ret"] for t in ts]
        wins = sum(1 for r in rets if r > 0)
        tot_ret = sum(rets)*100
        dollar = sum(rets)*100000  # $100k capital
        wr = wins/len(rets)*100 if rets else 0
        print(f"  {yr:>4} | {len(ts):>3} | {wins:>4} | {wr:>4.0f} | {tot_ret:>+7.1f} | {dollar:>+7.0f}")

    # Focus 2026 entries
    trades_2026_entry = [t for t in all_trades if t["entry_yr"] == 2026]
    trades_2026_exit = [t for t in all_trades if t["exit_yr"] == 2026]  # active in 2026

    print(f"\n=== 2026 YTD Detailed (entry in 2026) ===")
    print(f"  N entries: {len(trades_2026_entry)}")
    if trades_2026_entry:
        for t in trades_2026_entry:
            dt = datetime.datetime.utcfromtimestamp(t["entry_ts"]/1000).strftime("%Y-%m-%d %H:%M")
            ex = datetime.datetime.utcfromtimestamp(t["exit_ts"]/1000).strftime("%Y-%m-%d")
            sign = "W" if t["ret"] > 0 else "L"
            print(f"    [{sign}] {dt} | {t['setup']} | ret={t['ret']*100:+.2f}% | hold={t['h']}bars | exit={ex}")

    # Why -$2k? Let's see how many RANGE bars vs entries
    range_2026 = regime_2026["RANGE"]
    print(f"\n=== Diagnosis: Why 2026 underperformed? ===")
    print(f"  RANGE bars in 2026: {range_2026} / {total_2026_bars} total = {range_2026/total_2026_bars*100:.1f}%")
    print(f"  Trades ENTERED in 2026: {len(trades_2026_entry)}")
    if len(trades_2026_entry) > 0:
        losses_2026 = [t for t in trades_2026_entry if t["ret"] < 0]
        wins_2026 = [t for t in trades_2026_entry if t["ret"] > 0]
        print(f"  Wins: {len(wins_2026)}, Losses: {len(losses_2026)}")
        total_ret_2026 = sum(t["ret"] for t in trades_2026_entry)*100
        total_dollar = sum(t["ret"] for t in trades_2026_entry)*100000
        print(f"  Total ret%: {total_ret_2026:+.2f}%  Dollar ($100k): {total_dollar:+,.0f}")

    print("\nDone.")

if __name__ == "__main__":
    main()
