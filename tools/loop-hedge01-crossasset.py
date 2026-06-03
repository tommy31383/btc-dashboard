#!/usr/bin/env python3
"""Loop cycle 6: hedge01-METHOD có generalize cross-asset không?
Port faithful hedge01 (RANGE-breakout 4h LONG: S12 EMA-cross / S13 ATR-break / S14 Donchian,
filt = ADX>20 ×2bar + close>EMA200-1h + ATR%ile + RANGE-regime, sim = ATR trailing SL)
từ correlation-turtle-hedge01-7y.py, monkeypatch H.CACHE để chạy asset khác. BTC-params AS-IS.
Sanity: BTC phải khớp +396 return-% (cycle 1). Test 2 bản: as-is (calendar filter) + structural (bỏ h16/Thu-Sun).
"""
import importlib.util, datetime, math, sys, os
from collections import defaultdict
HP = "/Users/lap16116/BTC_PC/btc-dashboard/tools/backtest-bull-regime-reaudit-7y.py"
spec = importlib.util.spec_from_file_location("H", HP)
H = importlib.util.module_from_spec(spec); spec.loader.exec_module(H)
FEE = H.FEE
CC = "/Users/lap16116/BTC_PC/btc-dashboard/.cache"
ASSETS = [("BTC", f"{CC}/binance-5m-7y.json"), ("ETH", f"{CC}/binance-eth-5m-3y.json"),
          ("SOL", f"{CC}/binance-sol-5m-3y.json"), ("BNB", f"{CC}/binance-bnb-5m-3y.json"),
          ("XRP", f"{CC}/binance-xrp-5m-3y.json"), ("DOGE", f"{CC}/binance-doge-5m-3y.json"),
          ("AVAX", f"{CC}/binance-avax-5m-3y.json")]

def mo_of(ts): return datetime.datetime.utcfromtimestamp(ts/1000).strftime("%Y-%m")
def yr_of(ts): return datetime.datetime.utcfromtimestamp(ts/1000).year
def uhour(ts): return datetime.datetime.utcfromtimestamp(ts/1000).hour
def udow(ts): return datetime.datetime.utcfromtimestamp(ts/1000).weekday()

def run_hedge01(cache, skip_cal=True):
    H.CACHE = cache  # monkeypatch — load_tf reads global each call
    bars4h = H.load_tf(H.H4); bars1h = H.load_tf(3600*1000); bars1d = H.load_tf(86400*1000)
    n = len(bars4h); c4 = [b["close"] for b in bars4h]
    e50 = H.ema_s(c4, H.EMA_FAST); e200 = H.ema_s(c4, H.EMA_SLOW)
    atr4 = H.atr_series(bars4h); adx4 = H.adx_wilder(bars4h)
    e200_1h = H.ema_s([b["close"] for b in bars1h], 200); h1t = [b["time"] for b in bars1h]
    regime_1d = H.regime_with_persistence(bars1d)
    reg_map = {b["time"]//86400000: regime_1d[i] for i, b in enumerate(bars1d)}
    def get_reg(ts): return reg_map.get(ts//86400000, "RANGE")
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
        if skip_cal and H.SKIP_H16 and uhour(bars4h[i]["time"]) == 16: return False
        if skip_cal and H.SKIP_THU_SUN:
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
            ret, h = r; ets = bars4h[i]["time"]; cts = bars4h[min(i+h, n-1)]["time"]
            mo[mo_of(cts)] += ret; yrr[yr_of(cts)] += ret; trades.append((ret, ets, h))
            last[sn] = i
    return mo, yrr, trades, (bars4h[250]["time"], bars4h[-1]["time"], n)

def sharpe_mo(mo):
    vals = list(mo.values());
    if len(vals) < 2: return 0.0
    m = sum(vals)/len(vals); d = (sum((v-m)**2 for v in vals)/len(vals))**0.5 or 1e-9
    return m/d*math.sqrt(12)

def report(label, skip_cal):
    print(f"\n{'='*78}\n=== hedge01-method {label} ===")
    print(f"  {'asset':>5} | {'trades':>6} | {'tr/yr':>5} | {'ret%tot':>7} | {'WR%':>4} | {'Sharpe':>6} | per-year ret%")
    for name, path in ASSETS:
        mo, yrr, trades, span = run_hedge01(path, skip_cal)
        if not trades:
            print(f"  {name:>5} | {'0':>6} | (no trades)"); continue
        yrs = (span[1]-span[0])/(365*86400000)
        tot = sum(t[0] for t in trades)*100
        wr = sum(1 for t in trades if t[0] > 0)/len(trades)*100
        pyr = " ".join(f"{y%100}:{yrr[y]*100:+.0f}" for y in sorted(yrr))
        print(f"  {name:>5} | {len(trades):>6} | {len(trades)/yrs:>5.1f} | {tot:>+7.0f} | {wr:>4.0f} | {sharpe_mo(mo):>+6.2f} | {pyr}")

if __name__ == "__main__":
    print("=== Cycle 6: hedge01-method generalization cross-asset ===")
    print("(BTC ret% phải ≈ +396 = sanity port faithful; alt 5m-3y nên per-year ít năm)")
    report("AS-IS (calendar filter h16/Thu-Sun ON)", skip_cal=True)
    report("STRUCTURAL (bỏ calendar filter — fair generality)", skip_cal=False)
