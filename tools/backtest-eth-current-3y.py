#!/usr/bin/env python3
"""
backtest-eth-current-3y.py — PA1: ETH instance với full config v0.4.56 (3y)

ETH E1 config: drop S12 EMA cross (E1 tweak — BTC golden / ETH loser WR 43%).
Các filter khác giữ nguyên như BTC:
  RANGE_ONLY=True, SKIP_SHORT=True, SKIP_H16=True, SKIP_THU_SUN=True
  ATR_PCT_PCTL=0.50, ADX_THRESH=20, VOL_MA=10, VOL_MULT=1.2
  SL_INIT=4, SL_TRAIL=3, SL_TRANS=24 bars (96h)
  ATR_BREAK_MULT=1.2, ADX Wilder

So sánh:
  A: ETH E1 (S12 OFF) — current proposed config
  B: BTC 3y với cùng config — reference

Lesson từ memory: ETH RA 1.01 > BTC 0.99 (3y), 2025 ETH +$422 vs BTC +$34 (diversify mạnh)
NOTE: ETH dùng 3y data nên output 3y.
"""
import json, datetime
from collections import defaultdict

CACHE_ETH = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-eth-5m-3y.json"
CACHE_BTC = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
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
ATR_PCT_PCTL = 0.50
DONCHIAN_LB = 20
ATR_BREAK_MULT = 1.2
EMA_FAST = 50
EMA_SLOW = 200
MAX_HOLD = 200
RANGE_ONLY = True
SKIP_SHORT = True
SKIP_H16 = True
SKIP_THU_SUN = True
CD = {"S12": 36, "S13": 1, "S14": 36}


def load_tf(cache, ms):
    raw = json.load(open(cache))
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


def run_symbol(cache, symbol, enable_s12=True):
    print(f"\nLoading {symbol}...")
    bars4h = load_tf(cache, H4)
    bars1h = load_tf(cache, 3600 * 1000)
    bars1d = load_tf(cache, 86400 * 1000)
    n = len(bars4h)
    c4 = [b["close"] for b in bars4h]

    # BTC 7y → filter last 3y to match ETH
    if symbol == "BTC":
        cutoff_ms = bars4h[-1]["time"] - 3 * 365 * 24 * 3600 * 1000
        start_idx = next((i for i, b in enumerate(bars4h) if b["time"] >= cutoff_ms), 0)
    else:
        start_idx = 0

    print(f"  4h bars: {n}  "
          f"{datetime.datetime.utcfromtimestamp(bars4h[0]['time']/1000):%Y-%m-%d} → "
          f"{datetime.datetime.utcfromtimestamp(bars4h[-1]['time']/1000):%Y-%m-%d}")
    print(f"  Backtest window: {datetime.datetime.utcfromtimestamp(bars4h[start_idx]['time']/1000):%Y-%m-%d} → end  (3y match)")

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
        if RANGE_ONLY and side == "LONG" and reg != "RANGE": return False
        if side == "SHORT" and reg == "BULL": return False
        if side == "LONG" and reg == "BEAR": return False
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

    sigs_all = {"S12": sig_s12, "S13": sig_s13, "S14": sig_s14}
    active_sigs = {k: v for k, v in sigs_all.items() if k != "S12" or enable_s12}
    do_vol = {"S12": False, "S13": True, "S14": True}

    trades = []
    last = {s: {"LONG": 0, "SHORT": 0} for s in active_sigs}
    for i in range(max(250, start_idx), n - MAX_HOLD):
        for sn, sig_fn in active_sigs.items():
            sig = sig_fn(i)
            if sig is None: continue
            if SKIP_SHORT and sig == "SHORT": continue
            if i - last[sn][sig] < CD[sn]: continue
            if do_vol.get(sn, False) and not vol_pass(i): continue
            if not filt(i, sig): continue
            r = sim(i, sig)
            if r is None: continue
            ret, h = r
            yr = datetime.datetime.utcfromtimestamp(bars4h[i]["time"] / 1000).year
            trades.append({"ret": ret, "h": h, "yr": yr, "side": sig, "setup": sn})
            last[sn][sig] = i

    if not trades:
        print(f"  NO TRADES for {symbol}")
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
    by_setup = defaultdict(list)
    for t in trades: by_setup[t["setup"]].append(t["ret"])
    setup_str = "  ".join(
        f"{s} n={len(v)} RA={( sum(v)/len(v) / ((sum((r-sum(v)/len(v))**2 for r in v)/len(v))**0.5 or 1e-9) ):+.3f}"
        for s, v in sorted(by_setup.items())
    )
    label = f"{symbol} {'E1 (S12 OFF)' if not enable_s12 else 'full (S12 ON)'} — 3y"
    print(f"\n  [{label}]")
    print(f"  n={n_:4d}  RA={ra:+.3f}  WR={wr:.0f}%  R:R={rr:.2f}  ROI={sum(rets)*100:+.1f}%  DD={max_dd*100:.1f}%  stab={pos}/{len(by_yr)}")
    print(f"  Per-year:  {yr_str}")
    print(f"  Per-setup: {setup_str}")
    return {"n": n_, "ra": ra, "wr": wr, "rr": rr, "roi": sum(rets), "dd": max_dd,
            "stab": pos, "stab_total": len(by_yr)}


def main():
    print("=" * 60)
    print("PA1: ETH instance backtest (full config v0.4.56, 3y)")
    print("=" * 60)

    # ETH E1 (S12 OFF) — proposed config
    eth_e1 = run_symbol(CACHE_ETH, "ETH", enable_s12=False)

    # BTC 3y reference (same config, last 3y of 7y data)
    btc_3y = run_symbol(CACHE_BTC, "BTC", enable_s12=True)

    print("\n" + "=" * 60)
    print("SUMMARY — ETH E1 vs BTC 3y reference")
    print(f"  {'Symbol':>12}  {'n':>5}  {'RA':>8}  {'WR':>5}  {'R:R':>5}  {'ROI%':>8}  {'DD%':>6}  {'stab':>6}")
    for sym, r in [("ETH E1", eth_e1), ("BTC 3y", btc_3y)]:
        if r:
            print(f"  {sym:>12}  {r['n']:>5}  {r['ra']:>+8.3f}  {r['wr']:>4.0f}%  {r['rr']:>5.2f}  {r['roi']*100:>+7.1f}%  {r['dd']*100:>5.1f}%  {r['stab']}/{r['stab_total']}")

    if eth_e1 and btc_3y:
        print(f"\n  Portfolio note: BTC + ETH add ~{eth_e1['n']} ETH entries on top of BTC 3y {btc_3y['n']}")
        print(f"  ETH ROI {eth_e1['roi']*100:+.1f}% vs BTC {btc_3y['roi']*100:+.1f}% (diversification)")
        verdict = "✅ DEPLOY ETH instance" if eth_e1["ra"] > 0.3 and eth_e1["stab"] >= 2 else "⚠️ Check per-year — may not be strong enough"
        print(f"\n  VERDICT: {verdict}")
        if eth_e1["ra"] > 0.3:
            print(f"  Wallet requirement: >= $5k trước khi enable ETH instance (DD {eth_e1['dd']*100:.0f}% risk)")


if __name__ == "__main__":
    main()
