#!/usr/bin/env python3
"""
backtest-simplified-7y.py — Simplified config vs current v0.4.56

Hypothesis: bỏ các filter "nhặt từ data" (h16/ThuSun/ATR50) → generalizable hơn.

Config A (CURRENT v0.4.56):  ATR 50th + skip h16 + skip ThuSun
Config B (SIMPLIFIED):        ATR 30th + no h16 skip + no ThuSun skip

Cả hai đều giữ structural filters: ADX>20 sticky, EMA200 1h, RANGE-only, LONG-only

Walk-forward split:
  TRAIN: 2019-2022  (4 năm in-sample)
  TEST:  2023-2026  (3 năm out-of-sample, NOT used to tune filters)

Accept: TEST RA không decay quá 30% so với TRAIN.
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
ADX_THRESH = 20
VOL_MA = 10
VOL_MULT = 1.2
ATR_PCT_LB = 90
DONCHIAN_LB = 20
ATR_BREAK_MULT = 1.2
EMA_FAST = 50
EMA_SLOW = 200
MAX_HOLD = 200
CD = {"S12": 36, "S13": 1, "S14": 36}

CONFIGS = {
    "CURRENT v0.4.56": {"atr_pct": 0.50, "skip_h16": True,  "skip_thu_sun": True},
    "SIMPLIFIED":      {"atr_pct": 0.30, "skip_h16": False, "skip_thu_sun": False},
}


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
    if n <= period + 1: return [None] * n
    smTR = sum(tr[1:period + 1]); smPDM = sum(pdm[1:period + 1]); smNDM = sum(ndm[1:period + 1])
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


def calc_ra(trades):
    if not trades: return None
    rets = [t["ret"] for t in trades]
    mean = sum(rets) / len(rets)
    sd = (sum((r - mean) ** 2 for r in rets) / len(rets)) ** 0.5
    return mean / sd if sd > 0 else 0


def main():
    print("Loading data...")
    bars4h = load_tf(H4)
    bars1h = load_tf(3600 * 1000)
    bars1d = load_tf(86400 * 1000)
    n = len(bars4h)
    c4 = [b["close"] for b in bars4h]

    print(f"4h bars: {n}  "
          f"{datetime.datetime.utcfromtimestamp(bars4h[0]['time']/1000):%Y-%m-%d} → "
          f"{datetime.datetime.utcfromtimestamp(bars4h[-1]['time']/1000):%Y-%m-%d}")

    e50 = ema_s(c4, EMA_FAST)
    e200 = ema_s(c4, EMA_SLOW)
    atr4 = atr_series(bars4h)
    adx4 = adx_wilder(bars4h)
    e200_1h = ema_s([b["close"] for b in bars1h], 200)
    h1t = [b["time"] for b in bars1h]

    regime_1d = regime_with_persistence(bars1d)
    reg_map = {}
    for i, b in enumerate(bars1d):
        reg_map[b["time"] // 86400000] = regime_1d[i]

    def get_reg(ts): return reg_map.get(ts // 86400000, "RANGE")

    def atp(i):
        if atr4[i] is None: return None
        return atr4[i] / c4[i]

    def atp_pass(i, pct):
        if i < ATR_PCT_LB + 14: return False
        vs = [atp(j) for j in range(i - ATR_PCT_LB, i) if atp(j) is not None]
        if len(vs) < ATR_PCT_LB: return False
        cur = atp(i)
        if cur is None: return False
        return cur >= sorted(vs)[int(len(vs) * pct)]

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

    def filt(i, cfg):
        adv = adx4[i]
        if adv is None or adv <= ADX_THRESH: return False
        adv_prev = adx4[i - 1] if i >= 1 else None
        if adv_prev is None or adv_prev <= ADX_THRESH: return False
        e1h = e200_1h_at(bars4h[i]["time"])
        if e1h is None: return False
        if c4[i] < e1h: return False          # LONG only, must be above EMA200 1h
        if not atp_pass(i, cfg["atr_pct"]): return False
        h = utc_hour(bars4h[i]["time"])
        if cfg["skip_h16"] and h == 16: return False
        if cfg["skip_thu_sun"]:
            dw = utc_dow(bars4h[i]["time"])
            if dw == 3 or dw == 6: return False
        reg = get_reg(bars4h[i]["time"])
        if reg != "RANGE": return False        # RANGE-only always
        return True

    def sig_s12(i):
        if None in (e50[i], e200[i], e50[i-1], e200[i-1]): return None
        if e50[i-1] <= e200[i-1] and e50[i] > e200[i]: return "LONG"
        return None

    def sig_s13(i):
        if atr4[i] is None or i < 1: return None
        if c4[i] > bars4h[i-1]["close"] + atr4[i] * ATR_BREAK_MULT: return "LONG"
        return None

    def sig_s14(i):
        if i < DONCHIAN_LB: return None
        hi20 = max(bars4h[j]["high"] for j in range(i - DONCHIAN_LB, i))
        if c4[i] > hi20: return "LONG"
        return None

    sigs = {"S12": (sig_s12, False), "S13": (sig_s13, True), "S14": (sig_s14, True)}

    # Walk-forward cutoff: 2023-01-01
    wf_cut = int(datetime.datetime(2023, 1, 1).timestamp() * 1000)

    def run(cfg):
        trades = []
        last = {s: 0 for s in sigs}
        for i in range(250, n - MAX_HOLD):
            for sn, (sig_fn, use_vol) in sigs.items():
                sig = sig_fn(i)
                if sig is None: continue
                if i - last[sn] < CD[sn]: continue
                if use_vol and not vol_pass(i): continue
                if not filt(i, cfg): continue
                ep = c4[i]; ae = atr4[i]
                if ae is None or ae <= 0: continue
                sl = ep - ae * SL_INIT; hwm = ep
                ret = None
                for h in range(1, MAX_HOLD + 1):
                    j = i + h
                    if j >= n: break
                    mult = SL_INIT if h < SL_TRANS else SL_TRAIL
                    if c4[j] > hwm: hwm = c4[j]; sl = hwm - ae * mult
                    elif h >= SL_TRANS:
                        t = hwm - ae * SL_TRAIL
                        if t > sl: sl = t
                    if bars4h[j]["low"] <= sl:
                        ret = (sl - ep) / ep - 2 * FEE; break
                if ret is None:
                    j2 = min(i + MAX_HOLD, n - 1)
                    ret = (c4[j2] - ep) / ep - 2 * FEE
                ts = bars4h[i]["time"]
                yr = datetime.datetime.utcfromtimestamp(ts / 1000).year
                trades.append({"ret": ret, "yr": yr, "setup": sn,
                                "period": "test" if ts >= wf_cut else "train"})
                last[sn] = i
        return trades

    def report_full(trades, label):
        if not trades:
            print(f"  [{label}] NO TRADES"); return None
        rets = [t["ret"] for t in trades]
        n_ = len(rets)
        mean = sum(rets) / n_
        sd = (sum((r - mean) ** 2 for r in rets) / n_) ** 0.5 or 1e-9
        ra = mean / sd
        wr = sum(1 for r in rets if r > 0) / n_ * 100
        wins = [r for r in rets if r > 0]
        losses = [r for r in rets if r <= 0]
        rr = (sum(wins) / len(wins) if wins else 0) / abs(sum(losses) / len(losses) if losses else 1e-9)
        by_yr = defaultdict(float)
        for t in trades: by_yr[t["yr"]] += t["ret"]
        pos = sum(1 for v in by_yr.values() if v > 0)
        equity = 0; peak = 0; max_dd = 0
        for t in sorted(trades, key=lambda x: x["yr"]):
            equity += t["ret"]; peak = max(peak, equity); max_dd = max(max_dd, peak - equity)
        yr_str = " ".join(f"{y}:{by_yr[y]*100:+.0f}%" for y in sorted(by_yr))

        # Walk-forward split
        train = [t for t in trades if t["period"] == "train"]
        test  = [t for t in trades if t["period"] == "test"]
        ra_tr = calc_ra(train)
        ra_te = calc_ra(test)
        decay = (ra_te - ra_tr) / abs(ra_tr) * 100 if ra_tr else None

        print(f"\n  [{label}]")
        print(f"  FULL  n={n_:4d}  RA={ra:+.3f}  WR={wr:.0f}%  R:R={rr:.2f}  ROI={sum(rets)*100:+.1f}%  DD={max_dd*100:.1f}%  stab={pos}/{len(by_yr)}")
        print(f"  Per-year: {yr_str}")
        if ra_tr and ra_te:
            decay_flag = "✅ ROBUST" if decay >= -30 else "⚠️ DECAY"
            print(f"  Walk-fwd: TRAIN(2019-22) RA={ra_tr:+.3f} n={len(train)} | TEST(2023-26) RA={ra_te:+.3f} n={len(test)} | decay={decay:+.0f}% {decay_flag}")
        return {"ra": ra, "n": n_, "stab": pos, "stab_n": len(by_yr), "dd": max_dd,
                "ra_train": ra_tr, "ra_test": ra_te, "n_train": len(train), "n_test": len(test)}

    print("\n" + "=" * 65)
    print("SIMPLIFIED vs CURRENT — BTC 7y (LONG-only, RANGE-only)")
    print("=" * 65)

    results = {}
    for label, cfg in CONFIGS.items():
        results[label] = report_full(run(cfg), label)

    # Head-to-head
    cur = results.get("CURRENT v0.4.56")
    sim = results.get("SIMPLIFIED")
    print("\n" + "=" * 65)
    print("HEAD-TO-HEAD SUMMARY")
    print("=" * 65)
    if cur and sim:
        print(f"\n  {'Metric':25s}  {'CURRENT':>12}  {'SIMPLIFIED':>12}  {'Δ':>10}")
        print(f"  {'n (7y)':25s}  {cur['n']:>12}  {sim['n']:>12}  {sim['n']-cur['n']:>+10}")
        print(f"  {'RA (full)':25s}  {cur['ra']:>+12.3f}  {sim['ra']:>+12.3f}  {sim['ra']-cur['ra']:>+10.3f}")
        print(f"  {'stab':25s}  {str(cur['stab'])+'/'+str(cur['stab_n']):>12}  {str(sim['stab'])+'/'+str(sim['stab_n']):>12}")
        print(f"  {'DD':25s}  {cur['dd']*100:>11.1f}%  {sim['dd']*100:>11.1f}%")
        if cur['ra_train'] and sim['ra_train']:
            print(f"  {'RA TRAIN (2019-22)':25s}  {cur['ra_train']:>+12.3f}  {sim['ra_train']:>+12.3f}")
            print(f"  {'RA TEST (2023-26)':25s}  {cur['ra_test']:>+12.3f}  {sim['ra_test']:>+12.3f}")
            cur_decay = (cur['ra_test'] - cur['ra_train']) / abs(cur['ra_train']) * 100
            sim_decay = (sim['ra_test'] - sim['ra_train']) / abs(sim['ra_train']) * 100
            print(f"  {'TEST/TRAIN decay':25s}  {cur_decay:>+11.0f}%  {sim_decay:>+11.0f}%")

        print(f"\n  KEY QUESTION: SIMPLIFIED decay ít hơn CURRENT?")
        if sim_decay > cur_decay:
            print(f"  → SIMPLIFIED generalizes BETTER ({sim_decay:+.0f}% vs {cur_decay:+.0f}%)")
            print(f"     Evidence: anh Tommy's hypothesis ĐÚNG — fewer filters = more robust")
        elif sim_decay < cur_decay - 5:
            print(f"  → CURRENT generalizes BETTER ({cur_decay:+.0f}% vs {sim_decay:+.0f}%)")
            print(f"     Evidence: filters are real, not just data-mine")
        else:
            print(f"  → Tương đương ({cur_decay:+.0f}% vs {sim_decay:+.0f}%)")

        # Entries per year
        n_per_yr_cur = cur['n'] / 7
        n_per_yr_sim = sim['n'] / 7
        print(f"\n  Entry rate: CURRENT ~{n_per_yr_cur:.0f}/năm → SIMPLIFIED ~{n_per_yr_sim:.0f}/năm")


if __name__ == "__main__":
    main()
