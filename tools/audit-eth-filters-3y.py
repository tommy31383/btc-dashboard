#!/usr/bin/env python3
"""
audit-eth-filters-3y.py — Per-filter ablation cho ETH (3y)

ETH với config BTC v0.4.56 chỉ RA=+0.225 (vs RA 1.01 thời v0.4.46).
Mục tiêu: tìm filter nào HURT ETH, filter nào HELP → ETH-optimal config.

Ablation matrix:
  BASELINE: restore v0.4.46 ETH config (SHORT on, RANGE_ONLY off, ATR 30th, no SKIP_H16, no SKIP_THU_SUN)
  Current:  v0.4.56 full (SHORT off, RANGE_ONLY, ATR 50th, SKIP_H16, SKIP_THU_SUN)

  F1: Toggle RANGE_ONLY (ETH có edge trong BULL không?)
  F2: Toggle SKIP_SHORT (ETH SHORT có edge không? — trước test v0.4.46: WR 52%)
  F3: ATR 50th vs 30th (ETH optimal percentile)
  F4: Toggle SKIP_H16 (h=16 có pattern cho ETH không?)
  F5: Toggle SKIP_THU_SUN (Thu/Sun filter apply cho ETH?)
  F6: Toggle SKIP_H8 (ETH inverse pattern — skip hurt ETH -17% per v0.4.47)

  COMBO_A: Best inferred (ETH-specific optimal)
"""
import json, datetime
from collections import defaultdict

CACHE_ETH = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-eth-5m-3y.json"
FEE = 0.05 / 100
H4 = 4 * 3600 * 1000

SL_INIT = 4.0
SL_TRAIL = 3.0
SL_TRANS = 24       # bars 4h = 96h
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
# S12 OFF for ETH (E1 tweak — BTC golden, ETH loser WR 43%)
ENABLE_S12 = False
CD = {"S12": 36, "S13": 1, "S14": 36}


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
    print("Loading ETH 3y data...")
    bars4h = load_tf(H4)
    bars1h = load_tf(3600 * 1000)
    bars1d = load_tf(86400 * 1000)
    n = len(bars4h)
    c4 = [b["close"] for b in bars4h]

    print(f"ETH 4h bars: {n}  "
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

    def filt(i, side, cfg):
        adv = adx4[i]
        if adv is None or adv <= ADX_THRESH: return False
        adv_prev = adx4[i - 1] if i >= 1 else None
        if adv_prev is None or adv_prev <= ADX_THRESH: return False
        e1h = e200_1h_at(bars4h[i]["time"])
        if e1h is None: return False
        if side == "LONG" and c4[i] < e1h: return False
        if side == "SHORT" and c4[i] > e1h: return False
        if not atp_pass(i, cfg["atr_pct"]): return False
        h = utc_hour(bars4h[i]["time"])
        if cfg["skip_h16"] and h == 16: return False
        if cfg["skip_h8"] and h == 8: return False
        if cfg["skip_thu_sun"]:
            dw = utc_dow(bars4h[i]["time"])
            if dw == 3 or dw == 6: return False
        reg = get_reg(bars4h[i]["time"])
        if cfg["range_only"] and side == "LONG" and reg != "RANGE": return False
        if side == "SHORT" and reg == "BULL": return False
        if side == "LONG" and reg == "BEAR": return False
        return True

    def sim(ei, side):
        ep = c4[ei]; ae = atr4[ei]
        if ae is None or ae <= 0: return None
        sl = ep - ae * SL_INIT if side == "LONG" else ep + ae * SL_INIT
        hwm = ep
        for h in range(1, MAX_HOLD + 1):
            j = ei + h
            if j >= n: break
            mult = SL_INIT if h < SL_TRANS else SL_TRAIL
            if side == "LONG":
                if c4[j] > hwm: hwm = c4[j]; sl = hwm - ae * mult
                elif h >= SL_TRANS:
                    t = hwm - ae * SL_TRAIL
                    if t > sl: sl = t
                if bars4h[j]["low"] <= sl: return (sl - ep) / ep - 2 * FEE, h
            else:
                if c4[j] < hwm: hwm = c4[j]; sl = hwm + ae * mult
                elif h >= SL_TRANS:
                    t = hwm + ae * SL_TRAIL
                    if t < sl: sl = t
                if bars4h[j]["high"] >= sl: return (ep - sl) / ep - 2 * FEE, h
        j = min(ei + MAX_HOLD, n - 1)
        r = (c4[j] - ep) / ep if side == "LONG" else (ep - c4[j]) / ep
        return r - 2 * FEE, MAX_HOLD

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

    sigs = {"S13": sig_s13, "S14": sig_s14}
    do_vol = {"S13": True, "S14": True}

    def run(cfg):
        trades = []
        last = {s: {"LONG": 0, "SHORT": 0} for s in sigs}
        for i in range(250, n - MAX_HOLD):
            for sn, sig_fn in sigs.items():
                sig = sig_fn(i)
                if sig is None: continue
                if cfg["skip_short"] and sig == "SHORT": continue
                if i - last[sn][sig] < CD[sn]: continue
                if do_vol.get(sn, False) and not vol_pass(i): continue
                if not filt(i, sig, cfg): continue
                r = sim(i, sig)
                if r is None: continue
                ret, h = r
                yr = datetime.datetime.utcfromtimestamp(bars4h[i]["time"] / 1000).year
                reg = get_reg(bars4h[i]["time"])
                trades.append({"ret": ret, "h": h, "yr": yr, "side": sig, "setup": sn, "regime": reg})
                last[sn][sig] = i
        return trades

    def report(trades, label):
        if not trades:
            print(f"  {label:45s} NO TRADES")
            return None
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
        by_side = defaultdict(list)
        for t in trades: by_side[t["side"]].append(t["ret"])
        by_reg = defaultdict(list)
        for t in trades: by_reg[t["regime"]].append(t["ret"])
        long_ra = (lambda v: (sum(v)/len(v)) / ((sum((r-sum(v)/len(v))**2 for r in v)/len(v))**0.5 or 1e-9))(by_side.get("LONG",[0])) if by_side.get("LONG") else None
        short_ra = (lambda v: (sum(v)/len(v)) / ((sum((r-sum(v)/len(v))**2 for r in v)/len(v))**0.5 or 1e-9))(by_side.get("SHORT",[0])) if by_side.get("SHORT") else None
        ls_str = f"L:{len(by_side.get('LONG',[]))}({'N/A' if long_ra is None else f'{long_ra:+.2f}'}) S:{len(by_side.get('SHORT',[]))}({'N/A' if short_ra is None else f'{short_ra:+.2f}'})"
        reg_str = " ".join(
            f"{rg}:{len(v)}({'+'if sum(v)>0 else '-'})"
            for rg, v in sorted(by_reg.items())
        )
        print(f"  {label:50s} n={n_:3d} RA={ra:+.3f} WR={wr:.0f}% R:R={rr:.2f} DD={max_dd*100:.0f}% stab={pos}/{len(by_yr)}")
        print(f"    yr: {yr_str}")
        print(f"    L/S: {ls_str}  regime: {reg_str}")
        return {"ra": ra, "n": n_, "stab": pos, "stab_n": len(by_yr), "dd": max_dd, "wr": wr, "rr": rr}

    # Base configs
    cfg_current = {
        "range_only": True, "skip_short": True, "atr_pct": 0.50,
        "skip_h16": True, "skip_h8": False, "skip_thu_sun": True
    }
    cfg_old = {
        "range_only": False, "skip_short": False, "atr_pct": 0.30,
        "skip_h16": False, "skip_h8": False, "skip_thu_sun": False
    }

    print("\n" + "=" * 70)
    print("ETH PER-FILTER ABLATION (3y, S12 OFF = E1)")
    print("=" * 70)

    print("\n[REFERENCE]")
    r_current = report(run(cfg_current), "CURRENT v0.4.56 (all BTC filters)")
    r_old = report(run(cfg_old),     "OLD v0.4.46 (no RANGE/no skip/ATR30)")

    print("\n[F1] RANGE_ONLY toggle")
    r_f1a = report(run({**cfg_current, "range_only": False}), "F1A: RANGE_ONLY=False (allow BULL+RANGE)")
    r_f1b = report(run({**cfg_old, "range_only": True}),   "F1B: RANGE_ONLY=True on old base")

    print("\n[F2] SHORT toggle")
    r_f2a = report(run({**cfg_current, "skip_short": False}), "F2A: SHORT enabled (current base)")
    r_f2b = report(run({**cfg_old, "skip_short": True}),   "F2B: SHORT disabled (old base)")

    print("\n[F3] ATR percentile")
    r_f3a = report(run({**cfg_current, "atr_pct": 0.30}), "F3A: ATR 30th on current base")
    r_f3b = report(run({**cfg_current, "atr_pct": 0.40}), "F3B: ATR 40th on current base")
    r_f3c = report(run({**cfg_old, "atr_pct": 0.50}),   "F3C: ATR 50th on old base")

    print("\n[F4] Hour 16 skip")
    r_f4  = report(run({**cfg_current, "skip_h16": False}), "F4:  SKIP_H16=False (current base)")

    print("\n[F5] Thu+Sun skip")
    r_f5  = report(run({**cfg_current, "skip_thu_sun": False}), "F5:  SKIP_THU_SUN=False (current base)")

    print("\n[F6] Hour 8 skip (inverse pattern — known hurt ETH)")
    r_f6a = report(run({**cfg_current, "skip_h8": True}), "F6A: SKIP_H8=True (current base)")
    r_f6b = report(run({**cfg_old, "skip_h8": True}),    "F6B: SKIP_H8=True (old base)")

    print("\n[COMBO] Build ETH-specific optimal")
    # Based on ablation results, try combinations
    # Hypothesis: ETH needs RANGE_ONLY=False, SHORT=True, ATR=30th, rest same
    cfg_combo_a = {
        "range_only": False, "skip_short": False, "atr_pct": 0.30,
        "skip_h16": True, "skip_h8": False, "skip_thu_sun": True
    }
    cfg_combo_b = {
        "range_only": False, "skip_short": False, "atr_pct": 0.50,
        "skip_h16": True, "skip_h8": False, "skip_thu_sun": True
    }
    cfg_combo_c = {
        "range_only": True, "skip_short": False, "atr_pct": 0.30,
        "skip_h16": True, "skip_h8": False, "skip_thu_sun": True
    }
    cfg_combo_d = {
        "range_only": False, "skip_short": False, "atr_pct": 0.30,
        "skip_h16": False, "skip_h8": False, "skip_thu_sun": False
    }

    print()
    r_ca = report(run(cfg_combo_a), "COMBO_A: no-RANGE + SHORT + ATR30 + h16 + ThuSun")
    r_cb = report(run(cfg_combo_b), "COMBO_B: no-RANGE + SHORT + ATR50 + h16 + ThuSun")
    r_cc = report(run(cfg_combo_c), "COMBO_C: RANGE + SHORT + ATR30 + h16 + ThuSun")
    r_cd = report(run(cfg_combo_d), "COMBO_D: no-RANGE + SHORT + ATR30 (no h16/ThuSun)")

    print("\n" + "=" * 70)
    print("SUMMARY — which filters HELP vs HURT ETH?")
    print("=" * 70)
    baseline_ra = r_current["ra"] if r_current else 0
    comparisons = [
        ("F1A: remove RANGE_ONLY", r_f1a),
        ("F2A: enable SHORT", r_f2a),
        ("F3A: ATR 30th", r_f3a),
        ("F3B: ATR 40th", r_f3b),
        ("F4:  remove SKIP_H16", r_f4),
        ("F5:  remove SKIP_THU_SUN", r_f5),
        ("F6A: add SKIP_H8", r_f6a),
    ]
    for name, r in comparisons:
        if r:
            delta = r["ra"] - baseline_ra
            verdict = "✅ HELP" if delta >= 0.03 else ("❌ HURT" if delta <= -0.03 else "≈ neutral")
            print(f"  {name:40s} RA={r['ra']:+.3f}  Δ={delta:+.3f}  {verdict}")

    print("\n[COMBO winners vs baselines]")
    for name, r in [("COMBO_A (no-RANGE+SHORT+ATR30+h16+ThuSun)", r_ca),
                    ("COMBO_B (no-RANGE+SHORT+ATR50+h16+ThuSun)", r_cb),
                    ("COMBO_C (RANGE+SHORT+ATR30+h16+ThuSun)", r_cc),
                    ("COMBO_D (no-RANGE+SHORT+ATR30,minimal)", r_cd),
                    ("OLD v0.4.46 baseline", r_old),
                    ("CURRENT v0.4.56 baseline", r_current)]:
        if r:
            print(f"  {name:50s} RA={r['ra']:+.3f} n={r['n']:3d} stab={r['stab']}/{r['stab_n']} DD={r['dd']*100:.0f}%")

    # Best combo
    all_results = [(name, r) for name, r in [
        ("COMBO_A", r_ca), ("COMBO_B", r_cb), ("COMBO_C", r_cc), ("COMBO_D", r_cd)] if r]
    if all_results:
        best_name, best_r = max(all_results, key=lambda x: x[1]["ra"])
        print(f"\n  ⭐ BEST COMBO: {best_name}  RA={best_r['ra']:+.3f} n={best_r['n']} stab={best_r['stab']}/{best_r['stab_n']}")


if __name__ == "__main__":
    main()
