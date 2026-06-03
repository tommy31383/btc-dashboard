#!/usr/bin/env python3
"""
Iteration 5 Task 3: Risk-Parity vs Equal-Weight for 3-way book
Book: hedge01-BTC + turtle-BTC + (SOL placeholder)
Since SOL data is limited, test BTC+turtle book only (2 asset):
  A) Equal weight: 50/50 hedge01/turtle monthly returns
  B) Risk-parity: inverse-vol weight using last 12-month ATR% monthly vol

Accept criteria: Sharpe gain >= 0.05 AND DD reduction >= 1pp
"""
import json, datetime, importlib.util, math, sys
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

def mo_of(ts): return datetime.datetime.utcfromtimestamp(ts/1000).strftime("%Y-%m")
def yr_of(ts): return datetime.datetime.utcfromtimestamp(ts/1000).year

def get_hedge01_monthly():
    """Run hedge01 and return monthly returns dict."""
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
    def atp(i): return atr4[i]/c4[i] if atr4[i] is not None else None
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
            last[sn] = i
    return dict(mo)

def get_turtle_monthly():
    """Run turtle Donchian 20/10 CUT=1.5 skip-BEAR on daily bars, return monthly returns."""
    H.CACHE = CACHE
    bars1d = H.load_tf(86400*1000)
    n = len(bars1d)
    cs = [b["close"] for b in bars1d]

    # Daily ATR
    atr_d = H.atr_series(bars1d, 14)

    regime_1d = H.regime_with_persistence(bars1d)

    CUT = 1.5
    DON_ENTRY = 20
    DON_EXIT = 10

    mo = defaultdict(float)
    i = DON_ENTRY
    active = None  # {ep, ae, hwm, sl}

    while i < n-1:
        yr = yr_of(bars1d[i]["time"])
        reg = regime_1d[i]

        # Exit check
        if active:
            price = bars1d[i]["close"]
            low = bars1d[i]["low"]
            if low <= active["sl"]:
                ret = (active["sl"] - active["ep"]) / active["ep"] - 2*FEE
                mo[mo_of(bars1d[i]["time"])] += ret
                active = None
            else:
                # Trail with exit channel
                exit_low = min(bars1d[j]["low"] for j in range(i-DON_EXIT, i))
                if price < exit_low:
                    ret = (price - active["ep"]) / active["ep"] - 2*FEE
                    mo[mo_of(bars1d[i]["time"])] += ret
                    active = None
                else:
                    # Update HWM and sl
                    if price > active["hwm"]:
                        active["hwm"] = price
                        active["sl"] = active["hwm"] - active["ae"] * CUT
            i += 1
            continue

        # Entry: Donchian breakout, skip BEAR
        if reg == "BEAR":
            i += 1
            continue

        hi20 = max(bars1d[j]["high"] for j in range(i-DON_ENTRY, i))
        if cs[i] > hi20 and atr_d[i] is not None:
            ep = cs[i]
            ae = atr_d[i]
            sl = ep - ae * CUT
            active = {"ep": ep, "ae": ae, "hwm": ep, "sl": sl}
        i += 1

    return dict(mo)

def sharpe_mo(mo_dict):
    vals = list(mo_dict.values())
    if len(vals) < 2: return 0.0
    m = sum(vals)/len(vals)
    d = (sum((v-m)**2 for v in vals)/len(vals))**0.5 or 1e-9
    return m/d*math.sqrt(12)

def max_dd(monthly_returns):
    """Max drawdown from cumulative sum of returns."""
    cum = 0; peak = 0; max_draw = 0
    for v in monthly_returns:
        cum += v
        if cum > peak: peak = cum
        dd = peak - cum
        if dd > max_draw: max_draw = dd
    return max_draw

def combine_equal(mo_h01, mo_tur, w1=0.5, w2=0.5):
    """Combine two monthly return dicts with fixed weights."""
    all_months = sorted(set(mo_h01) | set(mo_tur))
    mo_comb = {}
    for m in all_months:
        v1 = mo_h01.get(m, 0.0)
        v2 = mo_tur.get(m, 0.0)
        mo_comb[m] = v1 * w1 + v2 * w2
    return mo_comb

def combine_risk_parity(mo_h01, mo_tur, window=12):
    """Combine using risk-parity (inverse-vol weights), rolling window."""
    all_months = sorted(set(mo_h01) | set(mo_tur))
    mo_comb = {}
    h01_list = [mo_h01.get(m, 0.0) for m in all_months]
    tur_list = [mo_tur.get(m, 0.0) for m in all_months]

    weights_h01 = []
    weights_tur = []

    for i, m in enumerate(all_months):
        if i < window:
            # Not enough history, equal weight
            w1, w2 = 0.5, 0.5
        else:
            # Rolling vol
            window_h01 = h01_list[i-window:i]
            window_tur = tur_list[i-window:i]
            std_h01 = (sum((v - sum(window_h01)/window)**2 for v in window_h01)/window)**0.5 or 1e-9
            std_tur = (sum((v - sum(window_tur)/window)**2 for v in window_tur)/window)**0.5 or 1e-9
            # Inverse-vol weights
            inv_h01 = 1/std_h01
            inv_tur = 1/std_tur
            total = inv_h01 + inv_tur
            w1 = inv_h01 / total
            w2 = inv_tur / total

        v1 = h01_list[i]
        v2 = tur_list[i]
        mo_comb[m] = v1 * w1 + v2 * w2
        weights_h01.append(w1)
        weights_tur.append(w2)

    avg_w_h01 = sum(weights_h01)/len(weights_h01)
    avg_w_tur = sum(weights_tur)/len(weights_tur)
    return mo_comb, avg_w_h01, avg_w_tur

def print_by_yr(mo_dict, label):
    yrr = defaultdict(float)
    for m, v in mo_dict.items():
        yr = int(m[:4])
        yrr[yr] += v
    print(f"  [{label}] per-year: " + " ".join(f"{y%100}:{yrr[y]*100:+.0f}" for y in sorted(yrr)))

def main():
    print("Running hedge01 monthly returns...")
    mo_h01 = get_hedge01_monthly()
    print(f"  hedge01: {len(mo_h01)} months")

    print("Running turtle monthly returns...")
    mo_tur = get_turtle_monthly()
    print(f"  turtle: {len(mo_tur)} months")

    # --- Individual Sharpes ---
    sh_h01 = sharpe_mo(mo_h01)
    sh_tur = sharpe_mo(mo_tur)
    print(f"\n=== Individual Sharpes ===")
    print(f"  hedge01 Sharpe: {sh_h01:+.3f}")
    print(f"  turtle  Sharpe: {sh_tur:+.3f}")

    # --- Overlap months (common months) ---
    common = sorted(set(mo_h01) & set(mo_tur))
    print(f"  Common months: {len(common)}")

    # Pearson on common months
    if len(common) >= 5:
        v1 = [mo_h01[m] for m in common]
        v2 = [mo_tur[m] for m in common]
        mean1 = sum(v1)/len(v1); mean2 = sum(v2)/len(v2)
        num = sum((a-mean1)*(b-mean2) for a,b in zip(v1,v2))
        d1 = (sum((a-mean1)**2 for a in v1))**0.5
        d2 = (sum((b-mean2)**2 for b in v2))**0.5
        corr = num/(d1*d2) if d1*d2 > 0 else 0
        print(f"  Pearson correlation: {corr:+.3f}")

    # --- A) Equal weight ---
    mo_eq = combine_equal(mo_h01, mo_tur, 0.5, 0.5)
    sh_eq = sharpe_mo(mo_eq)
    dd_eq = max_dd(list(mo_eq.values()))

    # --- B) Risk-parity ---
    mo_rp, avg_w1, avg_w2 = combine_risk_parity(mo_h01, mo_tur)
    sh_rp = sharpe_mo(mo_rp)
    dd_rp = max_dd(list(mo_rp.values()))

    print(f"\n=== Task 3: Risk-Parity vs Equal-Weight ===")
    print(f"  {'Scheme':>20} | {'Sharpe':>7} | {'MaxDD%':>7} | {'Sh gain':>8} | {'DDreduc':>8}")
    print(f"  {'A) Equal (50/50)':>20} | {sh_eq:>+7.3f} | {dd_eq*100:>7.2f} | {'--':>8} | {'--':>8}")
    print(f"  {'B) Risk-parity':>20} | {sh_rp:>+7.3f} | {dd_rp*100:>7.2f} | {sh_rp-sh_eq:>+8.3f} | {(dd_eq-dd_rp)*100:>+8.2f}pp")
    print(f"  Avg RP weights: hedge01={avg_w1:.2f} turtle={avg_w2:.2f}")

    # Accept threshold
    sh_gain = sh_rp - sh_eq
    dd_reduc_pp = (dd_eq - dd_rp) * 100
    accept = sh_gain >= 0.05 and dd_reduc_pp >= 1.0
    print(f"\n  Threshold: Sh gain >= 0.05 AND DD reduction >= 1pp")
    print(f"  VERDICT: {'ACCEPT risk-parity' if accept else 'REJECT — keep equal weight'}")
    if not accept:
        reasons = []
        if sh_gain < 0.05: reasons.append(f"Sh gain {sh_gain:+.3f} < 0.05")
        if dd_reduc_pp < 1.0: reasons.append(f"DD reduction {dd_reduc_pp:+.2f}pp < 1pp")
        print(f"  Reasons: {', '.join(reasons)}")

    print_by_yr(mo_eq, "Equal")
    print_by_yr(mo_rp, "RiskParity")

    print("\nDone.")

if __name__ == "__main__":
    main()
