#!/usr/bin/env python3
"""
iter7-regime-boundary.py — Task 2: Regime freshness / boundary analysis
When hedge01 entry fires, what is distribution of bars-since-RANGE-switch?
Hypothesis: entries with regime_age < 3 bars (still transitioning) → lower WR.
If confirmed → add structural "regime freshness" guard.
7y BTC, RANGE-only config matching v0.4.74 live params.
"""
import json, datetime
from collections import defaultdict

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FEE = 0.05 / 100
H4 = 4 * 3600 * 1000

SL_INIT = 4.0
SL_TRAIL = 3.0
SL_TRANS = 24
ADX_P = 14
ADX_THRESH = 18   # live config v0.4.74
VOL_MA = 10
VOL_MULT = 1.4    # live config v0.4.74
ATR_PCT_LB = 90
ATR_PCT_PCTL = 0.50
DONCHIAN_LB = 18  # DLB18 live config
ATR_BREAK_MULT = 1.3  # ATR_BREAK1.3 live config
EMA_FAST = 50
EMA_SLOW = 200
MAX_HOLD = 200
SKIP_SHORT = True
SKIP_H16 = True
SKIP_THU_SUN = True
CD = {"S12": 36, "S13": 1, "S14": 36}


def load_tf(ms):
    raw = json.load(open(CACHE))
    b = {}
    for c in raw:
        k = c["time"] // ms
        if k not in b:
            b[k] = {"time": k * ms, "high": c["high"], "low": c["low"],
                    "close": c["close"], "volume": c["volume"]}
        else:
            o = b[k]
            o["high"] = max(o["high"], c["high"])
            o["low"] = min(o["low"], c["low"])
            o["close"] = c["close"]
            o["volume"] += c["volume"]
    return [b[k] for k in sorted(b)]


def ema_s(xs, n):
    k = 2 / (n + 1); out = [None] * len(xs); e = None
    for i, x in enumerate(xs):
        e = x if e is None else x * k + e * (1 - k)
        out[i] = e
    return out


def _dm_tr(bars):
    n = len(bars)
    pdm = [0.0] * n; ndm = [0.0] * n; tr = [0.0] * n
    for i in range(1, n):
        up = bars[i]["high"] - bars[i - 1]["high"]
        dn = bars[i - 1]["low"] - bars[i]["low"]
        pdm[i] = up if up > dn and up > 0 else 0
        ndm[i] = dn if dn > up and dn > 0 else 0
        tr[i] = max(
            bars[i]["high"] - bars[i]["low"],
            abs(bars[i]["high"] - bars[i - 1]["close"]),
            abs(bars[i]["low"] - bars[i - 1]["close"])
        )
    return pdm, ndm, tr


def adx_wilder(bars, period=ADX_P):
    pdm, ndm, tr = _dm_tr(bars)
    n = len(bars)
    if n <= period + 1:
        return [None] * n
    smTR = sum(tr[1:period + 1])
    smPDM = sum(pdm[1:period + 1])
    smNDM = sum(ndm[1:period + 1])
    dx_arr = []; adx_val = None; adx_out = [None] * n
    for i in range(period + 1, n):
        smTR = smTR - smTR / period + tr[i]
        smPDM = smPDM - smPDM / period + pdm[i]
        smNDM = smNDM - smNDM / period + ndm[i]
        pdi = smPDM / smTR * 100 if smTR > 0 else 0
        ndi = smNDM / smTR * 100 if smTR > 0 else 0
        dx = abs(pdi - ndi) / (pdi + ndi) * 100 if (pdi + ndi) > 0 else 0
        dx_arr.append(dx)
        if len(dx_arr) < period: continue
        elif len(dx_arr) == period: adx_val = sum(dx_arr) / period
        else: adx_val = (adx_val * (period - 1) + dx) / period
        adx_out[i] = adx_val
    return adx_out


def atr_series(bars, period=ADX_P):
    _, _, tr = _dm_tr(bars)
    n = len(bars)
    atr = [None] * n
    s = sum(tr[1:period + 1])
    atr[period] = s / period
    for i in range(period + 1, n):
        atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period
    return atr


def regime_with_persistence_daily(bars1d, persist_n=3):
    cs = [b["close"] for b in bars1d]
    n = len(bars1d)
    raw = ["RANGE"] * n
    for i in range(200, n):
        ma200 = sum(cs[i - 199:i + 1]) / 200
        ma50 = sum(cs[i - 50:i + 1]) / 50
        r20 = bars1d[i - 19:i + 1]
        ar = sum((b["high"] - b["low"]) / b["close"] for b in r20) / 20
        if cs[i] < ma200: raw[i] = "BEAR"
        elif cs[i] > ma50 and ma50 > ma200 and ar > 0.04: raw[i] = "BULL"
    out = ["RANGE"] * n
    cur = "RANGE"; cnt = 0; last_raw = "RANGE"
    for i in range(n):
        r = raw[i]
        if r == last_raw: cnt += 1
        else: cnt = 1; last_raw = r
        if cnt >= persist_n: cur = r
        out[i] = cur
    return out


def main():
    print("Loading data...")
    bars4h = load_tf(H4)
    bars1h = load_tf(3600 * 1000)
    bars1d = load_tf(86400 * 1000)
    n = len(bars4h)
    c4 = [b["close"] for b in bars4h]

    print(f"4h bars: {n}  "
          f"{datetime.datetime.utcfromtimestamp(bars4h[0]['time']/1000):%Y-%m-%d} -> "
          f"{datetime.datetime.utcfromtimestamp(bars4h[-1]['time']/1000):%Y-%m-%d}")

    e50 = ema_s(c4, EMA_FAST)
    e200 = ema_s(c4, EMA_SLOW)
    atr4 = atr_series(bars4h)
    adx4 = adx_wilder(bars4h)
    e200_1h = ema_s([b["close"] for b in bars1h], 200)
    h1t = [b["time"] for b in bars1h]

    # Build daily regime series
    regime_1d_list = regime_with_persistence_daily(bars1d)
    reg_map = {}  # day_key -> (regime, age_in_bars_of_this_regime)
    cur = "RANGE"; age = 0
    for i, b in enumerate(bars1d):
        r = regime_1d_list[i]
        if r == cur:
            age += 1
        else:
            cur = r; age = 1
        reg_map[b["time"] // 86400000] = (r, age)

    def get_reg_age(ts):
        """Return (regime, age_days_since_switch) at timestamp ts."""
        dk = ts // 86400000
        return reg_map.get(dk, ("RANGE", 999))

    def atp(i):
        if atr4[i] is None: return None
        return atr4[i] / c4[i]

    def atp_pass(i):
        if i < ATR_PCT_LB + 14: return False
        vs = [atp(j) for j in range(i - ATR_PCT_LB, i) if atp(j) is not None]
        if len(vs) < ATR_PCT_LB: return False
        cur = atp(i)
        if cur is None: return False
        return cur >= sorted(vs)[int(len(vs) * ATR_PCT_PCTL)]

    def vol_pass(i):
        if i < VOL_MA: return False
        ma = sum(bars4h[j]["volume"] for j in range(i - VOL_MA, i)) / VOL_MA
        return bars4h[i]["volume"] >= ma * VOL_MULT

    def e200_1h_at(ts):
        lo, hi, idx = 0, len(h1t) - 1, 0
        while lo <= hi:
            m = (lo + hi) // 2
            if h1t[m] <= ts: idx = m; lo = m + 1
            else: hi = m - 1
        return e200_1h[idx]

    def utc_hour(ts): return datetime.datetime.utcfromtimestamp(ts / 1000).hour
    def utc_dow(ts): return datetime.datetime.utcfromtimestamp(ts / 1000).weekday()

    def filt(i, side):
        adv = adx4[i]
        if adv is None or adv <= ADX_THRESH: return False
        adv_prev = adx4[i - 1] if i >= 1 else None
        if adv_prev is None or adv_prev <= ADX_THRESH: return False
        e1h = e200_1h_at(bars4h[i]["time"])
        if e1h is None: return False
        if side == "LONG" and c4[i] < e1h: return False
        if side == "SHORT" and c4[i] > e1h: return False
        if not atp_pass(i): return False
        h = utc_hour(bars4h[i]["time"])
        if SKIP_H16 and h == 16: return False
        if SKIP_THU_SUN:
            dw = utc_dow(bars4h[i]["time"])
            if dw == 3 or dw == 6: return False
        reg, _ = get_reg_age(bars4h[i]["time"])
        if reg != "RANGE": return False
        return True

    def sim(ei, side):
        ep = c4[ei]
        ae = atr4[ei]
        if ae is None or ae <= 0: return None
        sl = ep - ae * SL_INIT if side == "LONG" else ep + ae * SL_INIT
        hwm = ep
        for h in range(1, MAX_HOLD + 1):
            j = ei + h
            if j >= n: break
            mult = SL_INIT if h < SL_TRANS else SL_TRAIL
            if side == "LONG":
                if c4[j] > hwm:
                    hwm = c4[j]; sl = hwm - ae * mult
                elif h >= SL_TRANS:
                    t = hwm - ae * SL_TRAIL
                    if t > sl: sl = t
                if bars4h[j]["low"] <= sl:
                    return (sl - ep) / ep - 2 * FEE, h
            else:
                if c4[j] < hwm:
                    hwm = c4[j]; sl = hwm + ae * mult
                elif h >= SL_TRANS:
                    t = hwm + ae * SL_TRAIL
                    if t < sl: sl = t
                if bars4h[j]["high"] >= sl:
                    return (ep - sl) / ep - 2 * FEE, h
        j = min(ei + MAX_HOLD, n - 1)
        r = (c4[j] - ep) / ep if side == "LONG" else (ep - c4[j]) / ep
        return r - 2 * FEE, MAX_HOLD

    def sig_s12(i):
        if None in (e50[i], e200[i]) or i < 1: return None
        if None in (e50[i - 1], e200[i - 1]): return None
        if e50[i - 1] <= e200[i - 1] and e50[i] > e200[i]: return "LONG"
        if e50[i - 1] > e200[i - 1] and e50[i] <= e200[i]: return "SHORT"
        return None

    def sig_s13(i):
        if atr4[i] is None or i < 1: return None
        if c4[i] > bars4h[i - 1]["close"] + atr4[i] * ATR_BREAK_MULT: return "LONG"
        if c4[i] < bars4h[i - 1]["close"] - atr4[i] * ATR_BREAK_MULT: return "SHORT"
        return None

    def sig_s14(i):
        if i < DONCHIAN_LB: return None
        hi20 = max(bars4h[j]["high"] for j in range(i - DONCHIAN_LB, i))
        lo20 = min(bars4h[j]["low"] for j in range(i - DONCHIAN_LB, i))
        if c4[i] > hi20: return "LONG"
        if c4[i] < lo20: return "SHORT"
        return None

    sigs = {"S12": sig_s12, "S13": sig_s13, "S14": sig_s14}
    do_vol = {"S12": False, "S13": True, "S14": True}

    print("\nRunning 7y RANGE-only backtest with regime age tracking...")
    trades = []
    last = {s: {"LONG": 0, "SHORT": 0} for s in ["S12", "S13", "S14"]}
    for i in range(250, n - MAX_HOLD):
        for sn in ["S12", "S13", "S14"]:
            sig = sigs[sn](i)
            if sig is None: continue
            if SKIP_SHORT and sig == "SHORT": continue
            if i - last[sn][sig] < CD[sn]: continue
            if do_vol[sn] and not vol_pass(i): continue
            if not filt(i, sig): continue
            r = sim(i, sig)
            if r is None: continue
            ret, h = r
            yr = datetime.datetime.utcfromtimestamp(bars4h[i]["time"] / 1000).year
            _, age = get_reg_age(bars4h[i]["time"])
            trades.append({"ret": ret, "h": h, "yr": yr, "setup": sn, "regime_age": age})
            last[sn][sig] = i

    print(f"Total trades: {len(trades)}")

    # =====================================================================
    # Regime age distribution analysis
    # =====================================================================
    print("\n" + "=" * 70)
    print("REGIME FRESHNESS ANALYSIS: WR and avg_pnl by bars-since-RANGE-switch")
    print("=" * 70)

    # Buckets: 1, 2, 3, 4-7, 8-14, 15+
    buckets = [
        ("age=1 (brand new)", lambda a: a == 1),
        ("age=2",             lambda a: a == 2),
        ("age=3",             lambda a: a == 3),
        ("age=4-7",           lambda a: 4 <= a <= 7),
        ("age=8-14",          lambda a: 8 <= a <= 14),
        ("age=15-30",         lambda a: 15 <= a <= 30),
        ("age=31+",           lambda a: a >= 31),
    ]

    print(f"\n  {'Bucket':20s} | {'n':>5s} | {'WR':>6s} | {'avg_pnl':>8s} | {'RA':>6s} | flag")
    print(f"  {'-'*65}")

    bucket_data = []
    for label, pred in buckets:
        subset = [t for t in trades if pred(t["regime_age"])]
        if not subset:
            print(f"  {label:20s} | {'0':>5s} | {'—':>6s} | {'—':>8s} | {'—':>6s} |")
            bucket_data.append((label, 0, 0, 0, 0))
            continue
        rets = [t["ret"] for t in subset]
        wr = sum(1 for r in rets if r > 0) / len(rets) * 100
        avg_pnl = sum(rets) / len(rets) * 100
        m = sum(rets) / len(rets)
        sd = (sum((r - m) ** 2 for r in rets) / len(rets)) ** 0.5
        ra = m / sd if sd > 1e-9 else 0.0
        flag = ""
        if wr < 45 or avg_pnl < -0.1: flag = "WEAK"
        elif wr > 60 and avg_pnl > 0.2: flag = "STRONG"
        print(f"  {label:20s} | {len(subset):>5d} | {wr:>5.0f}% | {avg_pnl:>+7.2f}% | {ra:>+6.3f} | {flag}")
        bucket_data.append((label, len(subset), wr, avg_pnl, ra))

    # Overall stats
    rets_all = [t["ret"] for t in trades]
    wr_all = sum(1 for r in rets_all if r > 0) / len(rets_all) * 100
    avg_all = sum(rets_all) / len(rets_all) * 100
    m = sum(rets_all) / len(rets_all)
    sd = (sum((r - m) ** 2 for r in rets_all) / len(rets_all)) ** 0.5
    ra_all = m / sd if sd > 1e-9 else 0.0
    print(f"  {'OVERALL':20s} | {len(trades):>5d} | {wr_all:>5.0f}% | {avg_all:>+7.2f}% | {ra_all:>+6.3f} |")

    # Detailed per-age-bucket per-signal breakdown
    print("\n\n  Per-signal breakdown for young regimes (age<=3):")
    young = [t for t in trades if t["regime_age"] <= 3]
    old = [t for t in trades if t["regime_age"] > 3]
    print(f"  Young (age<=3): n={len(young)}  WR={sum(1 for t in young if t['ret']>0)/len(young)*100:.0f}%  avg={sum(t['ret'] for t in young)/len(young)*100:+.2f}%")
    print(f"  Old   (age>3):  n={len(old)}   WR={sum(1 for t in old if t['ret']>0)/len(old)*100:.0f}%  avg={sum(t['ret'] for t in old)/len(old)*100:+.2f}%")

    by_setup_young = defaultdict(list)
    by_setup_old = defaultdict(list)
    for t in young: by_setup_young[t["setup"]].append(t["ret"])
    for t in old: by_setup_old[t["setup"]].append(t["ret"])
    for sn in ["S12", "S13", "S14"]:
        yv = by_setup_young.get(sn, [])
        ov = by_setup_old.get(sn, [])
        yw = sum(1 for r in yv if r > 0) / len(yv) * 100 if yv else 0
        ow = sum(1 for r in ov if r > 0) / len(ov) * 100 if ov else 0
        print(f"    {sn}: young n={len(yv):3d} WR={yw:.0f}%  old n={len(ov):3d} WR={ow:.0f}%")

    # =====================================================================
    # Verdict: is freshness guard warranted?
    # =====================================================================
    print("\n" + "=" * 70)
    print("VERDICT: Is regime freshness guard warranted?")
    print("=" * 70)

    young_wr = sum(1 for t in young if t["ret"] > 0) / len(young) * 100 if young else 0
    old_wr = sum(1 for t in old if t["ret"] > 0) / len(old) * 100 if old else 0
    young_avg = sum(t["ret"] for t in young) / len(young) * 100 if young else 0
    old_avg = sum(t["ret"] for t in old) / len(old) * 100 if old else 0

    wr_gap = old_wr - young_wr
    pnl_gap = old_avg - young_avg
    n_young = len(young)

    print(f"\n  Young (age<=3): n={n_young}  WR={young_wr:.0f}%  avg={young_avg:+.2f}%")
    print(f"  Old   (age>3):  n={len(old)}  WR={old_wr:.0f}%  avg={old_avg:+.2f}%")
    print(f"  Gap: WR_gap={wr_gap:+.0f}pp  avg_gap={pnl_gap:+.2f}%")

    if wr_gap >= 10 and pnl_gap >= 0.15 and n_young >= 15:
        print(f"\n  WARRANT GUARD: YES — young entries significantly weaker")
        print(f"  Recommendation: add regime_age >= 3 days filter (structural, not data-mine)")
        print(f"  Expected: remove ~{n_young} trades ({n_young/len(trades)*100:.0f}% of book)")
    elif wr_gap >= 5 and pnl_gap >= 0.05:
        print(f"\n  WARRANT GUARD: MARGINAL — small gap, insufficient evidence")
        print(f"  Recommendation: monitor forward — do NOT add filter yet")
    else:
        print(f"\n  WARRANT GUARD: NO — young/old entries not significantly different")
        print(f"  Recommendation: skip freshness filter — no edge")

    print("\nDone.")


if __name__ == "__main__":
    main()
