#!/usr/bin/env python3
"""Loop iter13: cross-asset lead-lag & relative-strength rotation among BTC/ETH/SOL.
Task1 lead-lag xcorr (BTC vs ETH/SOL, 4h), Task2 RS-rotation, Task3 beta-timing alt-longs on BTC regime.
Era-split per-year, ETH/SOL 3y -> require >=3/4 yrs positive. Judge Sharpe + dollars + corr<0.3 additive.
"""
import importlib.util, datetime, math
from collections import defaultdict
HP = "/Users/lap16116/BTC_PC/btc-dashboard/tools/backtest-bull-regime-reaudit-7y.py"
spec = importlib.util.spec_from_file_location("H", HP)
H = importlib.util.module_from_spec(spec); spec.loader.exec_module(H)
FEE = H.FEE
CC = "/Users/lap16116/BTC_PC/btc-dashboard/.cache"
PATHS = {"BTC": f"{CC}/binance-5m-7y.json", "ETH": f"{CC}/binance-eth-5m-3y.json", "SOL": f"{CC}/binance-sol-5m-3y.json"}

def yr_of(ts): return datetime.datetime.utcfromtimestamp(ts/1000).year

def load4h(name):
    H.CACHE = PATHS[name]
    return H.load_tf(H.H4)

# ---- align all 3 assets on common 4h timestamps (intersection) ----
def aligned():
    bars = {n: load4h(n) for n in PATHS}
    idx = {n: {b["time"]: b for b in bars[n]} for n in PATHS}
    common = sorted(set(idx["BTC"]) & set(idx["ETH"]) & set(idx["SOL"]))
    out = {n: [idx[n][t] for t in common] for n in PATHS}
    return common, out

def rets(closes):
    return [None] + [(closes[i]/closes[i-1]-1) for i in range(1, len(closes))]

def pearson(xs, ys):
    pairs = [(a, b) for a, b in zip(xs, ys) if a is not None and b is not None]
    if len(pairs) < 10: return 0.0
    n = len(pairs); mx = sum(a for a, _ in pairs)/n; my = sum(b for _, b in pairs)/n
    sx = sum((a-mx)**2 for a, _ in pairs); sy = sum((b-my)**2 for _, b in pairs)
    if sx <= 0 or sy <= 0: return 0.0
    cov = sum((a-mx)*(b-my) for a, b in pairs)
    return cov/math.sqrt(sx*sy)

def sharpe_mo(mo):
    vals = list(mo.values())
    if len(vals) < 2: return 0.0
    m = sum(vals)/len(vals); d = (sum((v-m)**2 for v in vals)/len(vals))**0.5 or 1e-9
    return m/d*math.sqrt(12)

# ================= TASK 1: lead-lag cross-correlation =================
def task1(common, bars):
    print("\n" + "="*78)
    print("=== TASK 1: lead-lag cross-correlation (4h returns) ===")
    btc_r = rets([b["close"] for b in bars["BTC"]])
    times = [b["time"] for b in bars["BTC"]]
    lags = [0, 1, 2, 3, 6, 12]
    for alt in ("ETH", "SOL"):
        alt_r = rets([b["close"] for b in bars[alt]])
        print(f"\n  BTC -> {alt}  (positive lag = BTC leads {alt} by L bars; corr of BTC[t-L] vs {alt}[t])")
        print(f"    {'lag':>4} | {'corr_all':>8} | per-year")
        for L in lags:
            # BTC return at t-L vs ALT return at t
            x = [None]*len(alt_r); y = [None]*len(alt_r)
            for t in range(L, len(alt_r)):
                x[t] = btc_r[t-L]; y[t] = alt_r[t]
            call = pearson(x, y)
            # per-year
            pyr = {}
            for yr in (2023, 2024, 2025, 2026):
                xy = [(x[t], y[t]) for t in range(len(alt_r)) if yr_of(times[t]) == yr]
                if len(xy) > 50:
                    pyr[yr] = pearson([a for a, _ in xy], [b for _, b in xy])
            ps = " ".join(f"{yr%100}:{v:+.2f}" for yr, v in sorted(pyr.items()))
            print(f"    {L:>4} | {call:>+8.3f} | {ps}")

# ================= TASK 2: relative-strength rotation =================
def task2(common, bars):
    print("\n" + "="*78)
    print("=== TASK 2: relative-strength rotation (hold strongest trailing-N-bar momentum) ===")
    closes = {n: [b["close"] for b in bars[n]] for n in PATHS}
    times = [b["time"] for b in bars["BTC"]]
    N = len(times)
    # bar-level fwd returns
    fwd = {n: rets(closes[n]) for n in PATHS}  # fwd[n][t] = return over [t-1,t]
    # rotation rebalanced every REBAL bars based on trailing LB-bar momentum
    for LB, REBAL in [(42, 42), (42, 6), (180, 42), (90, 30)]:  # ~7d/7d, 7d/1d, 30d/7d, 15d/5d (4h bars: 6/day)
        print(f"\n  --- LB={LB}bar (~{LB/6:.0f}d) trailing mom, rebal every {REBAL}bar (~{REBAL/6:.1f}d) ---")
        strategies = {
            "ROT": defaultdict(float),  # hold leader
            "EW": defaultdict(float),   # equal weight BTC+ETH+SOL
            "BTC": defaultdict(float),
        }
        held = None
        for t in range(LB+1, N):
            mo_key = datetime.datetime.utcfromtimestamp(times[t]/1000).strftime("%Y-%m")
            # choose leader at rebalance points
            if (t-LB-1) % REBAL == 0:
                mom = {n: closes[n][t-1]/closes[n][t-1-LB]-1 for n in PATHS}
                newlead = max(mom, key=mom.get)
                if newlead != held:
                    strategies["ROT"][mo_key] -= 2*FEE  # switch cost (round-trip)
                    held = newlead
            if held:
                strategies["ROT"][mo_key] += fwd[held][t]
            for n in PATHS:
                strategies["EW"][mo_key] += fwd[n][t]/3.0
            strategies["BTC"][mo_key] += fwd["BTC"][t]
        # report
        print(f"    {'strat':>5} | {'ret%tot':>8} | {'Sharpe':>6} | per-year ret%")
        rotmo = strategies["ROT"]
        for s in ("ROT", "EW", "BTC"):
            mo = strategies[s]
            tot = sum(mo.values())*100
            yrr = defaultdict(float)
            for k, v in mo.items(): yrr[int(k[:4])] += v
            pyr = " ".join(f"{y%100}:{yrr[y]*100:+.0f}" for y in sorted(yrr))
            print(f"    {s:>5} | {tot:>+8.0f} | {sharpe_mo(mo):>+6.2f} | {pyr}")

# ================= TASK 3: beta-timing alt-longs gated on BTC regime ====
def task3():
    print("\n" + "="*78)
    print("=== TASK 3: beta-timing — hedge01 alt-longs gated on BTC regime/ADX-rising ===")
    # Build BTC regime + ADX-rising gate on BTC's own 4h bars, then run hedge01 on ETH/SOL
    # only allowing entries when BTC gate passes at that timestamp.
    H.CACHE = PATHS["BTC"]
    btc4 = H.load_tf(H.H4); btc1d = H.load_tf(86400*1000)
    btc_c = [b["close"] for b in btc4]
    btc_adx = H.adx_wilder(btc4)
    btc_reg1d = H.regime_with_persistence(btc1d)
    reg_map = {b["time"]//86400000: btc_reg1d[i] for i, b in enumerate(btc1d)}
    btc_adx_at = {}
    for i, b in enumerate(btc4):
        rising = btc_adx[i] is not None and btc_adx[i-1] is not None and btc_adx[i] > btc_adx[i-1]
        reg = reg_map.get(b["time"]//86400000, "RANGE")
        btc_adx_at[b["time"]] = (reg in ("RANGE", "BULL")) and rising

    def run_alt(name, btc_gate):
        H.CACHE = PATHS[name]
        bars4h = H.load_tf(H.H4); bars1h = H.load_tf(3600*1000); bars1d = H.load_tf(86400*1000)
        n = len(bars4h); c4 = [b["close"] for b in bars4h]
        e50 = H.ema_s(c4, H.EMA_FAST); e200 = H.ema_s(c4, H.EMA_SLOW)
        atr4 = H.atr_series(bars4h); adx4 = H.adx_wilder(bars4h)
        e200_1h = H.ema_s([b["close"] for b in bars1h], 200); h1t = [b["time"] for b in bars1h]
        regime_1d = H.regime_with_persistence(bars1d)
        reg_m = {b["time"]//86400000: regime_1d[i] for i, b in enumerate(bars1d)}
        def get_reg(ts): return reg_m.get(ts//86400000, "RANGE")
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
            if get_reg(bars4h[i]["time"]) != "RANGE": return False
            if btc_gate and not btc_adx_at.get(bars4h[i]["time"], False): return False
            return True
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
                    tgt = hwm - ae*H.SL_TRAIL
                    if tgt > sl: sl = tgt
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
        sigs = {"S12": sig_s12, "S13": sig_s13, "S14": sig_s14}; do_vol = {"S12": False, "S13": True, "S14": True}
        CD = {"S12": 36, "S13": 1, "S14": 36}
        mo = defaultdict(float); yrr = defaultdict(float); trades = []; last = {s: 0 for s in sigs}
        for i in range(250, n-H.MAX_HOLD):
            for sn in ("S12", "S13", "S14"):
                if sigs[sn](i) != "LONG": continue
                if i-last[sn] < CD[sn]: continue
                if do_vol[sn] and not vol_pass(i): continue
                if not filt(i): continue
                r = sim(i)
                if r is None: continue
                ret, h = r; cts = bars4h[min(i+h, n-1)]["time"]
                k = datetime.datetime.utcfromtimestamp(cts/1000).strftime("%Y-%m")
                mo[k] += ret; yrr[yr_of(cts)] += ret; trades.append((ret, bars4h[i]["time"], h))
                last[sn] = i
        return mo, yrr, trades

    print(f"  {'asset':>5} {'gate':>10} | {'trades':>6} | {'ret%tot':>7} | {'WR%':>4} | {'Sharpe':>6} | per-year ret%")
    results = {}
    for name in ("ETH", "SOL"):
        for gate, lbl in [(False, "standalone"), (True, "BTC-gated")]:
            mo, yrr, trades = run_alt(name, gate)
            results[(name, gate)] = trades
            tot = sum(t[0] for t in trades)*100
            wr = sum(1 for t in trades if t[0] > 0)/max(len(trades), 1)*100
            pyr = " ".join(f"{y%100}:{yrr[y]*100:+.0f}" for y in sorted(yrr))
            print(f"  {name:>5} {lbl:>10} | {len(trades):>6} | {tot:>+7.0f} | {wr:>4.0f} | {sharpe_mo(mo):>+6.2f} | {pyr}")
    return results

if __name__ == "__main__":
    print("=== Loop iter13: cross-asset lead-lag & rotation BTC/ETH/SOL ===")
    common, bars = aligned()
    import datetime as _dt
    print(f"Aligned 4h bars: {len(common)}  {_dt.datetime.utcfromtimestamp(common[0]/1000).date()} -> {_dt.datetime.utcfromtimestamp(common[-1]/1000).date()}")
    task1(common, bars)
    task2(common, bars)
    task3()
