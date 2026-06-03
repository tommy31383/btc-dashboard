#!/usr/bin/env python3
"""
iter7-ema1h-deep-validate.py — Task 1 CORRECTED: EMA1h=150 deep validate (7y BTC)
Iteration 6 finding: replacing EMA1h=200 filter with EMA1h=150 → +46% entries, WR 63.2%, Sh+51%.
Now deep-validate this 1h EMA filter change:

A) Per-year breakdown 7y: EMA1h=150 vs EMA1h=200 per-year RA/WR
B) Leave-one-year-out holdout: how many holdouts pass?
C) Stability zone: EMA1h=120, 130, 140, 150, 160, 170, 180 — broad zone or narrow peak?
D) Full book impact: BTC-only RA (all signals S12+S13+S14)

Accept ONLY if: 7y stab >=5/7, >=5/7 holdouts, broad zone (range <0.10 RA), improvement clear.
Uses same live config params: ADX_P=12, ADX_THRESH=18, SL_INIT=2.78, SL_TRAIL=3.28, VOL_MULT=1.4
"""
import json, datetime
from collections import defaultdict

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FEE = 0.05 / 100
H4 = 4 * 3600 * 1000

SL_INIT = 2.78
SL_TRAIL = 3.28
SL_TRANS = 16        # from autoloop r76
ADX_P = 12           # key: r76 uses period=12
ADX_THRESH = 18
VOL_MA = 10
VOL_MULT = 1.4
ATR_PCT_LB = 90
ATR_PCT_PCTL = 0.50
DONCHIAN_LB = 18
ATR_BREAK_MULT = 1.3
EMA_FAST = 50        # S12 4h crossover (unchanged)
EMA_SLOW = 200
MAX_HOLD = 200
SKIP_SHORT = True
CD = {"S12": 36, "S13": 1, "S14": 36}
SKIP_MONTHS = {8}    # August skip (from r76)


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

    e50 = ema_s(c4, EMA_FAST)
    e200 = ema_s(c4, EMA_SLOW)
    atr4 = atr_series(bars4h)
    adx4 = adx_wilder(bars4h, period=ADX_P)
    h1_closes = [b["close"] for b in bars1h]
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

    def build_e1h(period):
        """Build EMA-period for 1h bars."""
        return ema_s(h1_closes, period)

    def e1h_at(e1h_arr, ts):
        lo, hi, idx = 0, len(h1t) - 1, 0
        while lo <= hi:
            m = (lo + hi) // 2
            if h1t[m] <= ts: idx = m; lo = m + 1
            else: hi = m - 1
        return e1h_arr[idx]

    def utc_hour(ts): return datetime.datetime.utcfromtimestamp(ts / 1000).hour
    def utc_dow(ts): return datetime.datetime.utcfromtimestamp(ts / 1000).weekday()
    def utc_month(ts): return datetime.datetime.utcfromtimestamp(ts / 1000).month

    def filt(i, side, e1h_arr):
        adv = adx4[i]
        if adv is None or adv <= ADX_THRESH: return False
        adv_prev = adx4[i - 1] if i >= 1 else None
        if adv_prev is None or adv_prev <= ADX_THRESH: return False
        e1h = e1h_at(e1h_arr, bars4h[i]["time"])
        if e1h is None: return False
        if side == "LONG" and c4[i] < e1h: return False
        if side == "SHORT" and c4[i] > e1h: return False
        if not atp_pass(i): return False
        if utc_month(bars4h[i]["time"]) in SKIP_MONTHS: return False
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

    def sig_s12(i):
        if None in (e50[i], e200[i]) or i < 1: return None
        if None in (e50[i - 1], e200[i - 1]): return None
        if e50[i - 1] <= e200[i - 1] and e50[i] > e200[i]: return "LONG"
        return None

    def sig_s13(i):
        if atr4[i] is None or i < 1: return None
        if c4[i] > bars4h[i - 1]["close"] + atr4[i] * ATR_BREAK_MULT: return "LONG"
        return None

    def sig_s14(i):
        if i < DONCHIAN_LB: return None
        hi20 = max(bars4h[j]["high"] for j in range(i - DONCHIAN_LB, i))
        if c4[i] > hi20: return "LONG"
        return None

    sigs = {"S12": (sig_s12, False, CD["S12"]),
            "S13": (sig_s13, True, CD["S13"]),
            "S14": (sig_s14, True, CD["S14"])}

    def run_all(e1h_period, exclude_year=None):
        """Run all signals with given 1h EMA period, optionally excluding a year."""
        e1h_arr = build_e1h(e1h_period)
        trades = []
        last = {s: 0 for s in sigs}
        for i in range(250, n - MAX_HOLD):
            yr = datetime.datetime.utcfromtimestamp(bars4h[i]["time"] / 1000).year
            if exclude_year is not None and yr == exclude_year: continue
            for sn, (sfn, dov, cd) in sigs.items():
                sig = sfn(i)
                if sig != "LONG": continue
                if i - last[sn] < cd: continue
                if dov and not vol_pass(i): continue
                if not filt(i, "LONG", e1h_arr): continue
                r = sim(i, "LONG")
                if r is None: continue
                ret, h = r
                trades.append({"ret": ret, "h": h, "yr": yr, "setup": sn})
                last[sn] = i
        return trades

    # =====================================================================
    # SECTION A: Per-year breakdown EMA1h=150 vs EMA1h=200
    # =====================================================================
    print("\n" + "=" * 70)
    print("SECTION A: Per-year breakdown — EMA1h=150 vs EMA1h=200")
    print("=" * 70)

    print("  Running EMA1h=200 (baseline)...")
    trades_200 = run_all(200)
    print("  Running EMA1h=150 (candidate)...")
    trades_150 = run_all(150)

    def per_year_report(trades, label):
        by_yr = defaultdict(list)
        for t in trades: by_yr[t["yr"]].append(t["ret"])
        total_rets = [t["ret"] for t in trades]
        ra = compute_ra(total_rets)
        wr = sum(1 for r in total_rets if r > 0) / len(total_rets) * 100 if total_rets else 0
        stab = sum(1 for y, v in by_yr.items() if sum(v) > 0)
        by_setup = defaultdict(list)
        for t in trades: by_setup[t["setup"]].append(t["ret"])
        print(f"\n  [{label}]  n={len(trades)}  RA={ra:+.3f}  WR={wr:.0f}%  stab={stab}/{len(by_yr)}")
        for yr in sorted(by_yr):
            vs = by_yr[yr]
            yr_ra = compute_ra(vs)
            flag = "+" if sum(vs) > 0 else "-"
            print(f"    {yr}: n={len(vs):3d}  ROI={sum(vs)*100:+.0f}%  RA={yr_ra:+.3f}  [{flag}]")
        setup_str = "  ".join(
            f"{s}:n={len(v)},RA={compute_ra(v):+.3f}" for s, v in sorted(by_setup.items()) if v
        )
        print(f"    Per-signal: {setup_str}")
        return ra, stab, len(by_yr), by_yr

    ra_base, stab_base, nyrs_base, by_yr_base = per_year_report(trades_200, "EMA1h=200 (baseline)")
    ra_new, stab_new, nyrs_new, by_yr_new = per_year_report(trades_150, "EMA1h=150 (candidate)")

    all_years = sorted(set(by_yr_base.keys()) | set(by_yr_new.keys()))
    print(f"\n  Year-by-year ROI comparison:")
    wins_new = 0
    for yr in all_years:
        roi_base = sum(by_yr_base.get(yr, []))
        roi_new = sum(by_yr_new.get(yr, []))
        winner = "NEW" if roi_new > roi_base else "BASE"
        if roi_new > roi_base: wins_new += 1
        print(f"    {yr}: base={roi_base*100:+.0f}%  new={roi_new*100:+.0f}%  [{winner}]")
    print(f"  EMA1h=150 wins {wins_new}/{len(all_years)} years")

    # =====================================================================
    # SECTION B: Leave-one-year-out holdout
    # =====================================================================
    print("\n" + "=" * 70)
    print("SECTION B: Leave-one-year-out holdout comparison")
    print("=" * 70)

    holdout_pass = 0
    print(f"\n  Holdout year | EMA1h=200 RA | EMA1h=150 RA | Winner | Pass?")
    print(f"  {'-'*65}")
    for excl in all_years:
        t_base = run_all(200, exclude_year=excl)
        t_new = run_all(150, exclude_year=excl)
        ra_b = compute_ra([t["ret"] for t in t_base])
        ra_n = compute_ra([t["ret"] for t in t_new])
        winner = "NEW" if ra_n > ra_b else "BASE"
        passes = ra_n >= ra_b - 0.02
        if passes: holdout_pass += 1
        flag = "PASS" if passes else "FAIL"
        print(f"  excl {excl}    |  {ra_b:+.3f}       |  {ra_n:+.3f}       | {winner:4s}   | {flag}")

    print(f"\n  Holdout summary: {holdout_pass}/{len(all_years)} pass (threshold: >=5/7)")
    holdout_verdict = "PASS" if holdout_pass >= 5 else "FAIL"
    print(f"  Holdout verdict: {holdout_verdict}")

    # =====================================================================
    # SECTION C: Stability zone sweep
    # =====================================================================
    print("\n" + "=" * 70)
    print("SECTION C: EMA1h stability zone (120–200)")
    print("=" * 70)

    ema_variants = [100, 110, 120, 130, 140, 150, 160, 170, 180, 200]
    ra_vals = []
    print(f"\n  {'EMA1h':8s} | {'n':>4s} | {'RA':>6s} | {'WR':>5s} | {'stab':>6s}")
    print(f"  {'-'*45}")
    for ep in ema_variants:
        t = run_all(ep)
        rets = [x["ret"] for x in t]
        ra = compute_ra(rets)
        wr = sum(1 for r in rets if r > 0) / len(rets) * 100 if rets else 0
        by_yr = defaultdict(float)
        for x in t: by_yr[x["yr"]] += x["ret"]
        stab = sum(1 for v in by_yr.values() if v > 0)
        marker = " <-- candidate" if ep == 150 else (" <-- baseline" if ep == 200 else "")
        print(f"  {ep:8d} | {len(t):>4d} | {ra:>+6.3f} | {wr:>5.0f}% | {stab}/{len(by_yr)}{marker}")
        ra_vals.append((ep, ra, stab))

    # Is 150 a narrow peak or broad zone?
    # Zone = all variants within ±5 of 150 (140–160) don't degrade >0.05 RA vs 150
    ra_at = {ep: ra for ep, ra, _ in ra_vals}
    ra_150 = ra_at.get(150, 0)
    ra_200 = ra_at.get(200, 0)
    zone_ras = [ra for ep, ra in ra_at.items() if 130 <= ep <= 170]
    zone_range = max(zone_ras) - min(zone_ras) if zone_ras else 999
    broad_zone = zone_range < 0.08

    print(f"\n  Zone 130–170 RA range: {min(zone_ras):+.3f} to {max(zone_ras):+.3f} (spread {zone_range:.3f})")
    if broad_zone:
        print(f"  Zone verdict: BROAD (spread < 0.08 — stable zone, not narrow peak)")
    else:
        print(f"  Zone verdict: NARROW PEAK (spread {zone_range:.3f} >= 0.08 — data-mine risk)")

    # =====================================================================
    # SECTION D: Final verdict
    # =====================================================================
    print("\n" + "=" * 70)
    print("SECTION D: Final verdict")
    print("=" * 70)

    improvement = ra_new - ra_base
    n_gain = len(trades_150) - len(trades_200)

    print(f"\n  EMA1h=200: RA={ra_base:+.3f}  n={len(trades_200)}  stab={stab_base}/{nyrs_base}")
    print(f"  EMA1h=150: RA={ra_new:+.3f}  n={len(trades_150)}  stab={stab_new}/{nyrs_new}")
    print(f"  Improvement: RA delta={improvement:+.3f}  n_gain={n_gain:+d}")
    print(f"  Holdout: {holdout_pass}/{len(all_years)} pass")
    print(f"  Broad zone (130-170): {'YES' if broad_zone else 'NO'}")

    accept = (
        stab_new >= 5 and
        holdout_pass >= 5 and
        broad_zone and
        ra_new > ra_base
    )
    print(f"\n  ACCEPT EMA1h=150: {'YES — update 1h trend filter from 200→150' if accept else 'NO — keep EMA1h=200'}")
    if not accept:
        reasons = []
        if stab_new < 5: reasons.append(f"stab {stab_new}<5")
        if holdout_pass < 5: reasons.append(f"holdout {holdout_pass}<5")
        if not broad_zone: reasons.append("narrow peak")
        if ra_new <= ra_base: reasons.append("no RA improvement")
        print(f"  Reject reasons: {', '.join(reasons)}")

    print("\nDone.")


if __name__ == "__main__":
    main()
