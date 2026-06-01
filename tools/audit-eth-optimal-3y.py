#!/usr/bin/env python3
"""
audit-eth-optimal-3y.py — Test ETH-optimal config sau ablation

Ablation findings:
  ✅ HELP: remove SKIP_H16 (+0.107), ATR 40th (+0.048), remove SKIP_THU_SUN (+0.037)
  ❌ HURT: SHORT (-0.194), SKIP_H8 (-0.080), ATR 30th (-0.035)
  ≈ neutral: remove RANGE_ONLY (-0.023)

ETH-optimal hypothesis (LONG-only, RANGE-only):
  RANGE_ONLY=True (keep — neutral/slight help vs remove)
  SKIP_SHORT=True (keep — SHORT badly hurts ETH with current regime filter)
  ATR_PCT=0.40 (relax from 50th → 40th)
  SKIP_H16=False (remove — inverse BTC pattern, h=16 GOOD for ETH)
  SKIP_THU_SUN=False (remove — neutral→slight help for ETH)
  SKIP_H8=False (keep off — skip would hurt ETH, confirmed)

Test matrix (all RANGE-only, LONG-only):
  OPT_A: ATR40 + no_H16 + no_ThuSun  (all 3 improvements combined)
  OPT_B: ATR50 + no_H16 + no_ThuSun  (just hour/dow change)
  OPT_C: ATR40 + no_H16 + ThuSun     (ATR40 + h16 only)
  OPT_D: ATR40 + H16 + no_ThuSun     (ATR40 + ThuSun only)
  CURRENT: ATR50 + H16 + ThuSun      (baseline v0.4.56)

Accept criteria: RA >= 0.35, stab 3/3, DD manageable
"""
import json, datetime
from collections import defaultdict

CACHE_ETH = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-eth-5m-3y.json"
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
CD = {"S13": 1, "S14": 36}


def load_tf(ms):
    raw = json.load(open(CACHE_ETH))
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


def main():
    bars4h = load_tf(H4)
    bars1h = load_tf(3600 * 1000)
    bars1d = load_tf(86400 * 1000)
    n = len(bars4h)
    c4 = [b["close"] for b in bars4h]

    print(f"ETH 4h bars: {n}  "
          f"{datetime.datetime.utcfromtimestamp(bars4h[0]['time']/1000):%Y-%m-%d} → "
          f"{datetime.datetime.utcfromtimestamp(bars4h[-1]['time']/1000):%Y-%m-%d}")

    e200_4h = ema_s(c4, EMA_SLOW)
    e50_4h = ema_s(c4, EMA_FAST)
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
        side = "LONG"
        adv = adx4[i]
        if adv is None or adv <= ADX_THRESH: return False
        adv_prev = adx4[i - 1] if i >= 1 else None
        if adv_prev is None or adv_prev <= ADX_THRESH: return False
        e1h = e200_1h_at(bars4h[i]["time"])
        if e1h is None: return False
        if c4[i] < e1h: return False
        if not atp_pass(i, cfg["atr_pct"]): return False
        h = utc_hour(bars4h[i]["time"])
        if cfg["skip_h16"] and h == 16: return False
        if cfg["skip_thu_sun"]:
            dw = utc_dow(bars4h[i]["time"])
            if dw == 3 or dw == 6: return False
        reg = get_reg(bars4h[i]["time"])
        if reg != "RANGE": return False  # RANGE_ONLY always True
        return True

    def sim(ei):
        ep = c4[ei]; ae = atr4[ei]
        if ae is None or ae <= 0: return None
        sl = ep - ae * SL_INIT; hwm = ep
        for h in range(1, MAX_HOLD + 1):
            j = ei + h
            if j >= n: break
            mult = SL_INIT if h < SL_TRANS else SL_TRAIL
            if c4[j] > hwm: hwm = c4[j]; sl = hwm - ae * mult
            elif h >= SL_TRANS:
                t = hwm - ae * SL_TRAIL
                if t > sl: sl = t
            if bars4h[j]["low"] <= sl: return (sl - ep) / ep - 2 * FEE, h
        j = min(ei + MAX_HOLD, n - 1)
        return (c4[j] - ep) / ep - 2 * FEE, MAX_HOLD

    def sig_s13(i):
        if atr4[i] is None or i < 1: return None
        if c4[i] > bars4h[i - 1]["close"] + atr4[i] * ATR_BREAK_MULT: return "LONG"
        return None

    def sig_s14(i):
        if i < DONCHIAN_LB: return None
        hi20 = max(bars4h[j]["high"] for j in range(i - DONCHIAN_LB, i))
        if c4[i] > hi20: return "LONG"
        return None

    sigs = {"S13": (sig_s13, True), "S14": (sig_s14, True)}

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
                r = sim(i)
                if r is None: continue
                ret, h = r
                yr = datetime.datetime.utcfromtimestamp(bars4h[i]["time"] / 1000).year
                trades.append({"ret": ret, "h": h, "yr": yr, "setup": sn})
                last[sn] = i
        return trades

    def report(trades, label):
        if not trades:
            print(f"  {label:50s} NO TRADES"); return None
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
        by_setup = defaultdict(list)
        for t in trades: by_setup[t["setup"]].append(t["ret"])
        setup_str = "  ".join(
            f"{s} n={len(v)} RA={( sum(v)/len(v) / ((sum((r-sum(v)/len(v))**2 for r in v)/len(v))**0.5 or 1e-9) ):+.3f}"
            for s, v in sorted(by_setup.items())
        )
        print(f"  {label:50s} n={n_:3d} RA={ra:+.3f} WR={wr:.0f}% R:R={rr:.2f} DD={max_dd*100:.0f}% stab={pos}/{len(by_yr)}")
        print(f"    yr: {yr_str}")
        print(f"    setup: {setup_str}")
        return {"ra": ra, "n": n_, "stab": pos, "stab_n": len(by_yr), "dd": max_dd, "wr": wr, "rr": rr}

    configs = [
        ("CURRENT  (ATR50 + H16 + ThuSun)",        {"atr_pct": 0.50, "skip_h16": True,  "skip_thu_sun": True}),
        ("OPT_A    (ATR40 + no_H16 + no_ThuSun)",  {"atr_pct": 0.40, "skip_h16": False, "skip_thu_sun": False}),
        ("OPT_B    (ATR50 + no_H16 + no_ThuSun)",  {"atr_pct": 0.50, "skip_h16": False, "skip_thu_sun": False}),
        ("OPT_C    (ATR40 + no_H16 + ThuSun)",     {"atr_pct": 0.40, "skip_h16": False, "skip_thu_sun": True}),
        ("OPT_D    (ATR40 + H16 + no_ThuSun)",     {"atr_pct": 0.40, "skip_h16": True,  "skip_thu_sun": False}),
        ("OPT_E    (ATR50 + no_H16 + ThuSun)",     {"atr_pct": 0.50, "skip_h16": False, "skip_thu_sun": True}),
    ]

    print("\n" + "=" * 70)
    print("ETH OPTIMAL CONFIG TEST (RANGE-only, LONG-only, S12 off, S13+S14)")
    print("=" * 70)

    results = []
    for label, cfg in configs:
        r = report(run(cfg), label)
        if r: results.append((label, cfg, r))

    print("\n" + "=" * 70)
    print("RANKING by RA")
    print("=" * 70)
    results_sorted = sorted(results, key=lambda x: x[2]["ra"], reverse=True)
    for label, cfg, r in results_sorted:
        flag = " ⭐" if r == results_sorted[0][2] else ""
        print(f"  {label:50s} RA={r['ra']:+.3f} n={r['n']:3d} stab={r['stab']}/{r['stab_n']} DD={r['dd']*100:.0f}%{flag}")

    # Best config
    best_label, best_cfg, best_r = results_sorted[0]
    base_r = next((r for l, c, r in results if "CURRENT" in l), None)

    print(f"\n  BEST: {best_label}")
    if base_r:
        print(f"  vs CURRENT: RA {base_r['ra']:+.3f} → {best_r['ra']:+.3f} (Δ{best_r['ra']-base_r['ra']:+.3f})")
        print(f"  vs CURRENT: n  {base_r['n']:3d}  → {best_r['n']:3d} (Δ{best_r['n']-base_r['n']:+d})")
        print(f"  vs CURRENT: DD {base_r['dd']*100:.0f}% → {best_r['dd']*100:.0f}%")

    print(f"\n  Accept criteria: RA >= 0.35, stab=3/3")
    verdict = "✅ ACCEPT — ETH has viable config" if best_r["ra"] >= 0.35 and best_r["stab"] == 3 else \
              "⚠️  MARGINAL — RA ok but watch stab" if best_r["ra"] >= 0.25 else \
              "❌ REJECT — ETH edge too weak for deployment"
    print(f"  VERDICT: {verdict}")

    print(f"\n  → Env overrides needed for ETH instance:")
    print(f"     RULE_SKIP_HOUR_16=false   (h=16 is good for ETH, bad for BTC)")
    if not best_cfg["skip_thu_sun"]:
        print(f"     RULE_SKIP_THU_SUN=false   (Thu/Sun neutral→positive for ETH)")
    if best_cfg["atr_pct"] != 0.50:
        print(f"     RULE_ATR_PCT={int(best_cfg['atr_pct']*100)}            (ETH optimal {int(best_cfg['atr_pct']*100)}th vs BTC 50th)")


if __name__ == "__main__":
    main()
