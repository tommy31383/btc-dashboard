#!/usr/bin/env python3
"""
bear-short-retest-7y.py — RIGOROUS re-test: does SHORTING BTC in confirmed BEAR regime
have a tradeable edge?

Tommy challenged why the book sits 100% out of BEAR (all of 2026 Jan-May = BEAR, 0 trades,
while price dropped). Prior kill (audit-short-7y.py) only tested inverted trend-breakout
setups. This tests 4 DEDICATED bear-short methods, all gated to regime=BEAR.

Methods (all gated regime==BEAR):
  M1 Donchian breakdown short (mirror turtle inverted): daily close < Donchian-low(20).
     Exit: close > Donchian-high(10) OR +1.5 ATR stop.
  M2 Rally-short: in BEAR, price rallies to falling EMA(50) on 4h then rolls over
     (close back below EMA). ATR trailing stop. Shorts strength not weakness.
  M3 hedge01 inverted (4h breakdown short): close < prev_close - ATR*1.3 OR Donchian-low(18)
     break, ADX>18, EMA200-1h below. ATR stop 3.0/3.5 trailing.
  M4 Momentum-continuation short: BEAR + ADX>25 rising + DI- > DI+. Hold while trend
     persists, exit when ADX falls or DI cross.

Cost model:
  - Flat round-trip 0.1% (0.05%/side) — fee+slippage.
  - Funding: Binance convention — rate>0 means longs pay shorts, so a SHORT EARNS funding.
    BTC funding is +0.0108%/8h mean, positive 85% of time → shorts earn on average.
    We apply realized funding per held 8h interval (short earns +rate). Reported as
    'with-funding'. Also a CONSERVATIVE variant flips sign (short PAYS) to stress-test.

Judge: Sharpe + DOLLARS ($100k notional/trade equiv via % compounding) + per-year.
Era-robust = BOTH real bears (2022 AND 2026) positive.
"""
import json, datetime
from collections import defaultdict

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FUNDING = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-funding-7y.json"
FEE = 0.05 / 100          # per side -> 0.1% RT
H4 = 4 * 3600 * 1000
H1 = 3600 * 1000
D1 = 86400 * 1000
ADX_P = 14
ATR_P = 14
MAX_HOLD_4H = 200         # ~33 days
MAX_HOLD_1D = 60          # days for daily methods


# ---------- loaders / indicators ----------
def load_tf(ms):
    raw = json.load(open(CACHE))
    b = {}
    for c in raw:
        k = c["time"] // ms
        if k not in b:
            b[k] = {"time": k * ms, "open": c["open"], "high": c["high"],
                    "low": c["low"], "close": c["close"], "volume": c["volume"]}
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
    n = len(bars); pdm = [0.0] * n; ndm = [0.0] * n; tr = [0.0] * n
    for i in range(1, n):
        up = bars[i]["high"] - bars[i - 1]["high"]
        dn = bars[i - 1]["low"] - bars[i]["low"]
        pdm[i] = up if up > dn and up > 0 else 0
        ndm[i] = dn if dn > up and dn > 0 else 0
        tr[i] = max(bars[i]["high"] - bars[i]["low"],
                    abs(bars[i]["high"] - bars[i - 1]["close"]),
                    abs(bars[i]["low"] - bars[i - 1]["close"]))
    return pdm, ndm, tr


def adx_di(bars, period=ADX_P):
    """Wilder ADX + DI+ / DI- arrays."""
    pdm, ndm, tr = _dm_tr(bars)
    n = len(bars)
    adx = [None] * n; pdi_o = [None] * n; ndi_o = [None] * n
    if n <= period + 1:
        return adx, pdi_o, ndi_o
    smTR = sum(tr[1:period + 1]); smPDM = sum(pdm[1:period + 1]); smNDM = sum(ndm[1:period + 1])
    dx_arr = []; adx_val = None
    for i in range(period + 1, n):
        smTR = smTR - smTR / period + tr[i]
        smPDM = smPDM - smPDM / period + pdm[i]
        smNDM = smNDM - smNDM / period + ndm[i]
        pdi = smPDM / smTR * 100 if smTR > 0 else 0
        ndi = smNDM / smTR * 100 if smTR > 0 else 0
        pdi_o[i] = pdi; ndi_o[i] = ndi
        dx = abs(pdi - ndi) / (pdi + ndi) * 100 if (pdi + ndi) > 0 else 0
        dx_arr.append(dx)
        if len(dx_arr) < period: continue
        elif len(dx_arr) == period: adx_val = sum(dx_arr) / period
        else: adx_val = (adx_val * (period - 1) + dx) / period
        adx[i] = adx_val
    return adx, pdi_o, ndi_o


def atr_series(bars, period=ATR_P):
    _, _, tr = _dm_tr(bars)
    n = len(bars); atr = [None] * n
    if n <= period: return atr
    s = sum(tr[1:period + 1]); atr[period] = s / period
    for i in range(period + 1, n):
        atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period
    return atr


def regime_persist(bars1d, persist_n=3):
    cs = [b["close"] for b in bars1d]; n = len(bars1d)
    raw = ["RANGE"] * n
    for i in range(200, n):
        ma200 = sum(cs[i - 199:i + 1]) / 200
        ma50 = sum(cs[i - 50:i + 1]) / 50
        r20 = bars1d[i - 19:i + 1]
        ar = sum((b["high"] - b["low"]) / b["close"] for b in r20) / 20
        if cs[i] < ma200: raw[i] = "BEAR"
        elif cs[i] > ma50 and ma50 > ma200 and ar > 0.04: raw[i] = "BULL"
    out = ["RANGE"] * n; cur = "RANGE"; cnt = 0; last = "RANGE"
    for i in range(n):
        r = raw[i]
        if r == last: cnt += 1
        else: cnt = 1; last = r
        if cnt >= persist_n: cur = r
        out[i] = cur
    return out


# ---------- funding ----------
def load_funding():
    f = json.load(open(FUNDING))
    return [(x["time"], x["rate"]) for x in f if x["rate"] is not None]


def funding_pnl(fund, t0, t1, sign_short_earns=True):
    """Sum funding over [t0,t1]. Binance: rate>0 -> longs pay shorts -> short earns +rate.
    Returns total fractional pnl applied to short (positive = gain to short)."""
    tot = 0.0
    for ts, rate in fund:
        if ts < t0: continue
        if ts > t1: break
        tot += rate if sign_short_earns else -rate
    return tot


# ---------- metrics ----------
def metrics(trades):
    if not trades:
        return None
    rets = [t["ret"] for t in trades]
    n = len(rets)
    mean = sum(rets) / n
    sd = (sum((r - mean) ** 2 for r in rets) / n) ** 0.5 or 1e-9
    sharpe_pertrade = mean / sd
    wr = sum(1 for r in rets if r > 0) / n * 100
    wins = [r for r in rets if r > 0]; losses = [r for r in rets if r <= 0]
    avg_w = sum(wins) / len(wins) if wins else 0
    avg_l = sum(losses) / len(losses) if losses else 0
    # compounded equity ($100k start) + maxDD
    eq = 100000.0; peak = eq; mdd = 0.0
    for t in sorted(trades, key=lambda x: x["entry_ts"]):
        eq *= (1 + t["ret"])
        peak = max(peak, eq)
        mdd = max(mdd, (peak - eq) / peak)
    total_roi = (eq / 100000.0 - 1) * 100
    by_yr = defaultdict(float)
    for t in trades:
        by_yr[t["yr"]] += t["ret"]
    pos_yrs = sum(1 for v in by_yr.values() if v > 0)
    # squeeze accounting
    n_stop = sum(1 for t in trades if t["reason"] == "STOP")
    n_target = sum(1 for t in trades if t["reason"] == "TARGET")
    n_timeout = sum(1 for t in trades if t["reason"] == "TIMEOUT")
    return {
        "n": n, "sharpe": sharpe_pertrade, "wr": wr, "avg_w": avg_w, "avg_l": avg_l,
        "total_roi": total_roi, "mdd": mdd * 100, "pos_yrs": pos_yrs, "n_yrs": len(by_yr),
        "by_yr": dict(by_yr), "final_eq": eq,
        "n_stop": n_stop, "n_target": n_target, "n_timeout": n_timeout,
    }


def print_report(name, trades, fund):
    m = metrics(trades)
    print(f"\n{'='*78}\n{name}\n{'='*78}")
    if m is None:
        print("  NO TRADES")
        return None
    print(f"  n={m['n']}  Sharpe(per-trade)={m['sharpe']:+.3f}  WR={m['wr']:.0f}%  "
          f"avgWin={m['avg_w']*100:+.2f}%  avgLoss={m['avg_l']*100:+.2f}%")
    print(f"  TotalROI(compound $100k)={m['total_roi']:+.1f}%  finalEq=${m['final_eq']:,.0f}  "
          f"MaxDD={m['mdd']:.1f}%  stab={m['pos_yrs']}/{m['n_yrs']}")
    print(f"  Exits: STOP(squeezed)={m['n_stop']}  TARGET={m['n_target']}  TIMEOUT={m['n_timeout']}"
          f"   (squeeze rate={m['n_stop']/m['n']*100:.0f}%)")
    yr_str = "  ".join(f"{y}:{m['by_yr'][y]*100:+.0f}%" for y in sorted(m['by_yr']))
    print(f"  Per-year: {yr_str}")
    # explicit 2022 + 2026
    b22 = m['by_yr'].get(2022, None); b26 = m['by_yr'].get(2026, None)
    def fmt(v): return "n/a" if v is None else f"{v*100:+.1f}%"
    robust = (b22 is not None and b22 > 0) and (b26 is not None and b26 > 0)
    print(f"  >> 2022 bear: {fmt(b22)}   2026 bear: {fmt(b26)}   "
          f"ERA-ROBUST(both bears+)={'YES' if robust else 'NO'}")
    return m


# ===================================================================
def main():
    print("Loading data...")
    b4 = load_tf(H4); b1h = load_tf(H1); b1d = load_tf(D1)
    fund = load_funding()
    c4 = [b["close"] for b in b4]; n4 = len(b4)
    c1d = [b["close"] for b in b1d]; n1d = len(b1d)
    print(f"4h bars: {n4}  1d bars: {n1d}  funding pts: {len(fund)}")
    print(f"Range: {datetime.datetime.utcfromtimestamp(b4[0]['time']/1000):%Y-%m-%d} -> "
          f"{datetime.datetime.utcfromtimestamp(b4[-1]['time']/1000):%Y-%m-%d}")

    # indicators 4h
    e50_4 = ema_s(c4, 50)
    atr4 = atr_series(b4)
    adx4, pdi4, ndi4 = adx_di(b4)
    # 1h ema200
    e200_1h = ema_s([b["close"] for b in b1h], 200)
    h1t = [b["time"] for b in b1h]
    # daily indicators
    atr1d = atr_series(b1d)

    # regime
    reg1d = regime_persist(b1d)
    reg_map = {b["time"] // D1: reg1d[i] for i, b in enumerate(b1d)}
    def get_reg(ts): return reg_map.get(ts // D1, "RANGE")

    def e200_1h_at(ts):
        lo, hi, idx = 0, len(h1t) - 1, 0
        while lo <= hi:
            m = (lo + hi) // 2
            if h1t[m] <= ts: idx = m; lo = m + 1
            else: hi = m - 1
        return e200_1h[idx]

    def yr_of(ts): return datetime.datetime.utcfromtimestamp(ts / 1000).year

    # ----- short trade simulators -----
    def sim_short_4h(ei, atr_mult_init, atr_mult_trail, trans_bars, exit_fn=None,
                     use_funding=True, fund_short_earns=True):
        """SHORT on 4h bars. exit_fn(j) optional -> True means take-profit/structural exit.
        Returns dict trade or None."""
        ep = c4[ei]; ae = atr4[ei]
        if ae is None or ae <= 0: return None
        sl = ep + ae * atr_mult_init
        hwm = ep  # lowest price reached (best for short)
        for h in range(1, MAX_HOLD_4H + 1):
            j = ei + h
            if j >= n4: break
            mult = atr_mult_init if h < trans_bars else atr_mult_trail
            if c4[j] < hwm:
                hwm = c4[j]; sl = hwm + ae * mult
            elif h >= trans_bars:
                t = hwm + ae * atr_mult_trail
                if t < sl: sl = t
            # stop (price rises = squeeze)
            if b4[j]["high"] >= sl:
                raw = (ep - sl) / ep
                reason = "STOP"
                return _mk_short(ei, j, ep, sl, raw, reason, use_funding, fund_short_earns)
            # structural exit
            if exit_fn is not None and exit_fn(j):
                px = c4[j]; raw = (ep - px) / ep; reason = "TARGET"
                return _mk_short(ei, j, ep, px, raw, reason, use_funding, fund_short_earns)
        j = min(ei + MAX_HOLD_4H, n4 - 1)
        px = c4[j]; raw = (ep - px) / ep
        return _mk_short(ei, j, ep, px, raw, "TIMEOUT", use_funding, fund_short_earns)

    def _mk_short(ei, j, ep, xp, raw, reason, use_funding, fund_short_earns):
        t0 = b4[ei]["time"]; t1 = b4[j]["time"]
        f = funding_pnl(fund, t0, t1, fund_short_earns) if use_funding else 0.0
        ret = raw - 2 * FEE + f
        return {"ret": ret, "raw": raw, "fund": f, "reason": reason,
                "yr": yr_of(t0), "entry_ts": t0, "exit_ts": t1, "h": j - ei}

    # daily short sim (M1)
    def sim_short_1d(ei, atr_mult, donch_hi_n, use_funding=True, fund_short_earns=True):
        ep = c1d[ei]; ae = atr1d[ei]
        if ae is None or ae <= 0: return None
        sl = ep + ae * atr_mult
        for h in range(1, MAX_HOLD_1D + 1):
            j = ei + h
            if j >= n1d: break
            # +ATR stop (price rising against short)
            if b1d[j]["high"] >= sl:
                raw = (ep - sl) / ep
                return _mk_short_1d(ei, j, ep, sl, raw, "STOP", use_funding, fund_short_earns)
            # structural exit: close > Donchian-high(donch_hi_n)
            if j >= donch_hi_n:
                dhi = max(b1d[k]["high"] for k in range(j - donch_hi_n, j))
                if c1d[j] > dhi:
                    px = c1d[j]; raw = (ep - px) / ep
                    return _mk_short_1d(ei, j, ep, px, raw, "TARGET", use_funding, fund_short_earns)
        j = min(ei + MAX_HOLD_1D, n1d - 1)
        px = c1d[j]; raw = (ep - px) / ep
        return _mk_short_1d(ei, j, ep, px, raw, "TIMEOUT", use_funding, fund_short_earns)

    def _mk_short_1d(ei, j, ep, xp, raw, reason, use_funding, fund_short_earns):
        t0 = b1d[ei]["time"]; t1 = b1d[j]["time"]
        f = funding_pnl(fund, t0, t1, fund_short_earns) if use_funding else 0.0
        ret = raw - 2 * FEE + f
        return {"ret": ret, "raw": raw, "fund": f, "reason": reason,
                "yr": yr_of(t0), "entry_ts": t0, "exit_ts": t1, "h": j - ei}

    # =========== METHOD 1: Donchian breakdown short (daily) ===========
    def run_m1(use_funding=True, fund_short_earns=True):
        trades = []; last = -999; DLB = 20; CD = 5
        for i in range(210, n1d - 1):
            if get_reg(b1d[i]["time"]) != "BEAR": continue
            lo20 = min(b1d[k]["low"] for k in range(i - DLB, i))
            if c1d[i] < lo20:
                if i - last < CD: continue
                tr = sim_short_1d(i, 1.5, 10, use_funding, fund_short_earns)
                if tr: trades.append(tr); last = i
        return trades

    # =========== METHOD 2: Rally-short to falling EMA50 (4h) ===========
    def run_m2(use_funding=True, fund_short_earns=True):
        trades = []; last = -999; CD = 18  # 3 days
        for i in range(260, n4 - MAX_HOLD_4H):
            if get_reg(b4[i]["time"]) != "BEAR": continue
            if e50_4[i] is None or e50_4[i - 5] is None: continue
            if e50_4[i] >= e50_4[i - 5]: continue          # EMA must be falling
            # rally up to/above EMA then roll back below: prev close >= ema, now close < ema
            if c4[i - 1] >= e50_4[i - 1] and c4[i] < e50_4[i]:
                if i - last < CD: continue
                tr = sim_short_4h(i, 1.5, 3.0, 12, exit_fn=None,
                                  use_funding=use_funding, fund_short_earns=fund_short_earns)
                if tr: trades.append(tr); last = i
        return trades

    # =========== METHOD 3: hedge01 inverted (4h breakdown) ===========
    def run_m3(use_funding=True, fund_short_earns=True):
        trades = []; last = -999; CD = 4; DLB = 18
        for i in range(260, n4 - MAX_HOLD_4H):
            if get_reg(b4[i]["time"]) != "BEAR": continue
            if atr4[i] is None or adx4[i] is None: continue
            if adx4[i] <= 18: continue
            e1h = e200_1h_at(b4[i]["time"])
            if e1h is None or c4[i] > e1h: continue        # must be below 1h ema200
            brk_atr = c4[i] < b4[i - 1]["close"] - atr4[i] * 1.3
            lo18 = min(b4[k]["low"] for k in range(i - DLB, i))
            brk_don = c4[i] < lo18
            if not (brk_atr or brk_don): continue
            if i - last < CD: continue
            tr = sim_short_4h(i, 3.5, 3.0, 12, exit_fn=None,
                              use_funding=use_funding, fund_short_earns=fund_short_earns)
            if tr: trades.append(tr); last = i
        return trades

    # =========== METHOD 4: Momentum-continuation short (4h) ===========
    def run_m4(use_funding=True, fund_short_earns=True):
        trades = []; last = -999; CD = 6
        for i in range(260, n4 - MAX_HOLD_4H):
            if get_reg(b4[i]["time"]) != "BEAR": continue
            if adx4[i] is None or adx4[i - 1] is None: continue
            if pdi4[i] is None or ndi4[i] is None: continue
            if adx4[i] <= 25: continue
            if adx4[i] <= adx4[i - 1]: continue            # rising ADX
            if ndi4[i] <= pdi4[i]: continue                # downtrend strength
            if i - last < CD: continue
            # exit when ADX falls or DI cross back
            def exit_fn(j, _e=ndi4, _p=pdi4, _a=adx4):
                if _a[j] is None or _a[j - 1] is None: return False
                if _p[j] is None or _e[j] is None: return False
                return _a[j] < _a[j - 1] * 0.9 or _p[j] > _e[j]
            tr = sim_short_4h(i, 3.5, 3.0, 12, exit_fn=exit_fn,
                              use_funding=use_funding, fund_short_earns=fund_short_earns)
            if tr: trades.append(tr); last = i
        return trades

    methods = [
        ("M1 — Donchian breakdown short (daily, BEAR-gated)", run_m1),
        ("M2 — Rally-short to falling EMA50 (4h, BEAR-gated)", run_m2),
        ("M3 — hedge01 inverted breakdown short (4h, BEAR-gated)", run_m3),
        ("M4 — Momentum-continuation short (4h ADX/DI, BEAR-gated)", run_m4),
    ]

    print("\n" + "#" * 78)
    print("# PRIMARY RESULTS — funding modeled CORRECTLY (short EARNS when rate>0, Binance)")
    print("# Cost: 0.1% RT (fee+slip) + realized funding")
    print("#" * 78)
    results = {}
    for name, fn in methods:
        tr = fn(use_funding=True, fund_short_earns=True)
        m = print_report(name, tr, fund)
        results[name] = (tr, m)

    print("\n" + "#" * 78)
    print("# STRESS TEST — funding sign FLIPPED (short PAYS funding, pessimistic)")
    print("#" * 78)
    for name, fn in methods:
        tr = fn(use_funding=True, fund_short_earns=False)
        m = metrics(tr)
        if m is None:
            print(f"\n{name}: NO TRADES"); continue
        b22 = m['by_yr'].get(2022); b26 = m['by_yr'].get(2026)
        print(f"\n{name}")
        print(f"  n={m['n']} Sharpe={m['sharpe']:+.3f} ROI={m['total_roi']:+.1f}% "
              f"MaxDD={m['mdd']:.1f}% stab={m['pos_yrs']}/{m['n_yrs']} "
              f"2022={'n/a' if b22 is None else f'{b22*100:+.0f}%'} "
              f"2026={'n/a' if b26 is None else f'{b26*100:+.0f}%'}")

    # ---- benchmark: what did sitting-out cash forgo? BTC price change in bears ----
    print("\n" + "#" * 78)
    print("# BENCHMARK — BTC price move during BEAR regime windows (what a perfect short captures)")
    print("#" * 78)
    bear_yrs = defaultdict(lambda: [None, None])  # yr -> [first_close, last_close]
    for i in range(n1d):
        if get_reg(b1d[i]["time"]) == "BEAR":
            y = yr_of(b1d[i]["time"])
            if bear_yrs[y][0] is None:
                bear_yrs[y][0] = c1d[i]
            bear_yrs[y][1] = c1d[i]
    for y in sorted(bear_yrs):
        f0, f1 = bear_yrs[y]
        move = (f1 - f0) / f0 * 100
        print(f"  {y}: BEAR window price move = {move:+.1f}%  (perfect short upper bound, no timing)")

    # ---- final verdict ----
    print("\n" + "#" * 78)
    print("# VERDICT")
    print("#" * 78)
    any_robust = False
    for name, (tr, m) in results.items():
        if m is None: continue
        b22 = m['by_yr'].get(2022); b26 = m['by_yr'].get(2026)
        robust = (b22 is not None and b22 > 0) and (b26 is not None and b26 > 0)
        net = m['total_roi'] > 0
        any_robust = any_robust or (robust and net)
        tag = name.split(" — ")[0]
        print(f"  {tag}: net7y={'+' if net else '-'} ({m['total_roi']:+.0f}%)  "
              f"Sharpe={m['sharpe']:+.3f}  "
              f"2022={'n/a' if b22 is None else f'{b22*100:+.0f}%'}  "
              f"2026={'n/a' if b26 is None else f'{b26*100:+.0f}%'}  "
              f"era-robust={'YES' if robust else 'NO'}")
    print(f"\n  ANY method net-positive AND era-robust (both 2022+2026)? "
          f"{'YES -> consider deploy' if any_robust else 'NO -> sit-out-cash confirmed'}")


if __name__ == "__main__":
    main()
