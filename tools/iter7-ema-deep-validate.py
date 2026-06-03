#!/usr/bin/env python3
"""
iter7-ema-deep-validate.py — Task 1: EMA 40/150 deep validate (7y BTC)
A) Per-year breakdown: EMA40/150 vs EMA50/200
B) Leave-one-year-out holdout: how many holdouts pass?
C) Stability zone: EMA38/145, 40/150, 42/155, 44/160
D) Full baseline run for book Sharpe reference (S12-only since EMA only affects S12)
Accept ONLY if: 7y stable, >=5/7 holdouts, broad stable zone, improvement clear.
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
MAX_HOLD = 200
SKIP_SHORT = True
SKIP_H16 = True
SKIP_THU_SUN = True
CD_S12 = 36


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


def regime_with_persistence(bars1d, persist_n=3):
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


def compute_ra(rets):
    if not rets: return 0.0
    m = sum(rets) / len(rets)
    sd = (sum((r - m) ** 2 for r in rets) / len(rets)) ** 0.5
    return m / sd if sd > 1e-9 else 0.0


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

    atr4 = atr_series(bars4h)
    adx4 = adx_wilder(bars4h)
    e200_1h = ema_s([b["close"] for b in bars1h], 200)
    h1t = [b["time"] for b in bars1h]

    regime_1d = regime_with_persistence(bars1d)
    reg_map = {}
    for i, b in enumerate(bars1d):
        reg_map[b["time"] // 86400000] = regime_1d[i]

    def get_reg(ts):
        return reg_map.get(ts // 86400000, "RANGE")

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
        reg = get_reg(bars4h[i]["time"])
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

    def run_s12(ema_fast, ema_slow, exclude_year=None):
        """Run S12 signal only with given EMA params, optionally excluding a year."""
        ef = ema_s(c4, ema_fast)
        es = ema_s(c4, ema_slow)
        trades = []
        last = 0
        for i in range(250, n - MAX_HOLD):
            yr = datetime.datetime.utcfromtimestamp(bars4h[i]["time"] / 1000).year
            if exclude_year is not None and yr == exclude_year: continue
            # S12: EMA crossover
            if None in (ef[i], es[i]) or i < 1: continue
            if None in (ef[i-1], es[i-1]): continue
            if ef[i-1] <= es[i-1] and ef[i] > es[i]: sig = "LONG"
            elif ef[i-1] > es[i-1] and ef[i] <= es[i]: sig = "SHORT"
            else: continue
            if SKIP_SHORT and sig == "SHORT": continue
            if i - last < CD_S12: continue
            if not filt(i, sig): continue
            r = sim(i, sig)
            if r is None: continue
            ret, h = r
            trades.append({"ret": ret, "h": h, "yr": yr})
            last = i
        return trades

    # =====================================================================
    # SECTION A: Per-year breakdown EMA40/150 vs EMA50/200
    # =====================================================================
    print("\n" + "=" * 70)
    print("SECTION A: Per-year breakdown — EMA40/150 vs EMA50/200")
    print("=" * 70)

    trades_50_200 = run_s12(50, 200)
    trades_40_150 = run_s12(40, 150)

    def per_year_report(trades, label):
        by_yr = defaultdict(list)
        for t in trades: by_yr[t["yr"]].append(t["ret"])
        total_rets = [t["ret"] for t in trades]
        ra = compute_ra(total_rets)
        wr = sum(1 for r in total_rets if r > 0) / len(total_rets) * 100 if total_rets else 0
        stab = sum(1 for y, v in by_yr.items() if sum(v) > 0)
        print(f"\n  [{label}]  n={len(trades)}  RA={ra:+.3f}  WR={wr:.0f}%  stab={stab}/{len(by_yr)}")
        for yr in sorted(by_yr):
            vs = by_yr[yr]
            yr_ra = compute_ra(vs)
            flag = "+" if sum(vs) > 0 else "-"
            print(f"    {yr}: n={len(vs):3d}  ROI={sum(vs)*100:+.0f}%  RA={yr_ra:+.3f}  [{flag}]")
        return ra, stab, len(by_yr), by_yr

    ra_base, stab_base, nyrs_base, by_yr_base = per_year_report(trades_50_200, "EMA50/200 (baseline)")
    ra_new, stab_new, nyrs_new, by_yr_new = per_year_report(trades_40_150, "EMA40/150 (candidate)")

    # Compare year by year
    print(f"\n  Year-by-year comparison (ROI):")
    all_years = sorted(set(by_yr_base.keys()) | set(by_yr_new.keys()))
    wins_ema_new = 0
    for yr in all_years:
        roi_base = sum(by_yr_base.get(yr, []))
        roi_new = sum(by_yr_new.get(yr, []))
        winner = "NEW" if roi_new > roi_base else "BASE"
        if roi_new > roi_base: wins_ema_new += 1
        print(f"    {yr}: base={roi_base*100:+.0f}%  new={roi_new*100:+.0f}%  [{winner}]")
    print(f"  EMA40/150 wins {wins_ema_new}/{len(all_years)} years vs EMA50/200")

    # =====================================================================
    # SECTION B: Leave-one-year-out holdout
    # =====================================================================
    print("\n" + "=" * 70)
    print("SECTION B: Leave-one-year-out holdout comparison")
    print("=" * 70)

    years = sorted(all_years)
    holdout_pass = 0
    print(f"\n  Holdout year | EMA50/200 RA | EMA40/150 RA | Winner | Pass?")
    print(f"  {'-'*65}")
    for excl in years:
        t_base = run_s12(50, 200, exclude_year=excl)
        t_new = run_s12(40, 150, exclude_year=excl)
        ra_b = compute_ra([t["ret"] for t in t_base])
        ra_n = compute_ra([t["ret"] for t in t_new])
        winner = "NEW" if ra_n > ra_b else "BASE"
        passes = ra_n >= ra_b - 0.01  # small tolerance: new must not be worse by >0.01
        if passes: holdout_pass += 1
        flag = "PASS" if passes else "FAIL"
        print(f"  excl {excl}    |  {ra_b:+.3f}       |  {ra_n:+.3f}       | {winner:4s}   | {flag}")

    print(f"\n  Holdout summary: {holdout_pass}/{len(years)} pass (threshold: >=5/7)")
    holdout_verdict = "PASS" if holdout_pass >= 5 else "FAIL"
    print(f"  Holdout verdict: {holdout_verdict}")

    # =====================================================================
    # SECTION C: Stability zone — EMA38/145, 40/150, 42/155, 44/160
    # =====================================================================
    print("\n" + "=" * 70)
    print("SECTION C: EMA stability zone (38/145, 40/150, 42/155, 44/160)")
    print("=" * 70)

    ema_variants = [
        (38, 145, "EMA38/145"),
        (40, 150, "EMA40/150"),
        (42, 155, "EMA42/155"),
        (44, 160, "EMA44/160"),
        (50, 200, "EMA50/200 (base)"),
    ]

    ra_zone = []
    print(f"\n  {'Config':16s} | {'n':>4s} | {'RA':>6s} | {'WR':>5s} | {'stab':>6s}")
    print(f"  {'-'*55}")
    for ef, es, label in ema_variants:
        t = run_s12(ef, es)
        rets = [x["ret"] for x in t]
        ra = compute_ra(rets)
        wr = sum(1 for r in rets if r > 0) / len(rets) * 100 if rets else 0
        by_yr = defaultdict(float)
        for x in t: by_yr[x["yr"]] += x["ret"]
        stab = sum(1 for v in by_yr.values() if v > 0)
        print(f"  {label:16s} | {len(t):>4d} | {ra:>+6.3f} | {wr:>5.0f}% | {stab}/{len(by_yr)}")
        ra_zone.append(ra)

    # Check if 40/150 is narrow peak or broad zone
    ra_variants = ra_zone[:4]  # excl baseline
    ra_min = min(ra_variants)
    ra_max = max(ra_variants)
    ra_range = ra_max - ra_min
    broad_zone = ra_range < 0.05  # all within 0.05 RA = broad/stable

    print(f"\n  Zone RA range: {ra_min:+.3f} to {ra_max:+.3f} (spread {ra_range:.3f})")
    if broad_zone:
        print(f"  Zone verdict: BROAD (spread < 0.05 — not a narrow peak)")
    else:
        print(f"  Zone verdict: NARROW PEAK (spread {ra_range:.3f} >= 0.05 — data-mine risk)")

    # =====================================================================
    # SECTION D: Final verdict
    # =====================================================================
    print("\n" + "=" * 70)
    print("SECTION D: Final verdict")
    print("=" * 70)

    ra_50200 = compute_ra([t["ret"] for t in trades_50_200])
    ra_40150 = compute_ra([t["ret"] for t in trades_40_150])
    improvement = ra_40150 - ra_50200

    print(f"\n  EMA50/200: RA={ra_50200:+.3f}  stab={stab_base}/{nyrs_base}")
    print(f"  EMA40/150: RA={ra_40150:+.3f}  stab={stab_new}/{nyrs_new}")
    print(f"  Improvement: {improvement:+.3f}")
    print(f"  Holdout: {holdout_pass}/{len(years)} pass")
    print(f"  Broad zone: {'YES' if broad_zone else 'NO'}")
    print(f"  stab >=5/7: {'YES' if stab_new >= 5 else 'NO'}")

    accept = (
        stab_new >= 5 and
        holdout_pass >= 5 and
        broad_zone and
        ra_40150 > ra_50200
    )
    print(f"\n  ACCEPT EMA40/150: {'YES — port to live S12 config' if accept else 'NO — keep EMA50/200'}")
    if not accept:
        reasons = []
        if stab_new < 5: reasons.append(f"stab {stab_new}<5")
        if holdout_pass < 5: reasons.append(f"holdout {holdout_pass}<5")
        if not broad_zone: reasons.append("narrow peak")
        if ra_40150 <= ra_50200: reasons.append("no RA improvement")
        print(f"  Reject reasons: {', '.join(reasons)}")

    print("\nDone.")


if __name__ == "__main__":
    main()
