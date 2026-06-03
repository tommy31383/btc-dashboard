#!/usr/bin/env python3
"""
loop-iter11-exec-risk-7y.py — EXECUTION & RISK HARDENING for deployed hedge01-BTC (v0.4.77).

Self-contained re-implementation of the hedge01 RANGE-only LONG engine with the
DEPLOYED v0.4.77 config (NOT the old reaudit defaults), parameterized for:
  - round-trip cost (FEE per side)               -> Task 1
  - entry slippage (enter at close*(1+X) adverse) -> Task 2
  - SL slippage    (fill at stop*(1-Y) adverse)   -> Task 3
Also emits tail-risk stats (worst day/7d/consec-loss/flat) -> Task 4.

v0.4.77 config (from deployment spec):
  RANGE-only LONG, setups S12/S13/S14
  ADX 18 (entry), ADX-prev 12 (rising gate)
  SL_INIT 3.0 xATR, SL_TRAIL 3.5 xATR, SL_TRANS 64h (=16 bars @4h)
  ATR_BREAK 1.3, VOL MA16 x1.4, DONCHIAN 18, funding-block 0.05% (LONG)
  EMA50/200 4h stack-ish + EMA200 1h gate, ATR%ile 50th, skip h16 + Thu/Sun
"""
import json, datetime, math
from collections import defaultdict

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FUNDING = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-funding-7y.json"
H4 = 4 * 3600 * 1000

# ---- v0.4.77 DEPLOYED CONFIG ----
SL_INIT = 3.0
SL_TRAIL = 3.5
SL_TRANS = 16          # 64h / 4h = 16 bars
ADX_P = 14
ADX_THRESH = 18        # entry gate
ADX_PREV_THRESH = 12   # rising gate (prev bar)
VOL_MA = 16
VOL_MULT = 1.4
ATR_PCT_LB = 90
ATR_PCT_PCTL = 0.50
DONCHIAN_LB = 18
ATR_BREAK_MULT = 1.3
EMA_FAST = 50
EMA_SLOW = 200
MAX_HOLD = 200
FUNDING_BLOCK = 0.0005   # 0.05% block LONG
CD = {"S12": 36, "S13": 1, "S14": 36}
WALLET = 100000.0        # $100k notional sim (memory: judge % ROI; scales)


def load_tf(raw, ms):
    b = {}
    for c in raw:
        k = c["time"] // ms
        if k not in b:
            b[k] = {"time": k * ms, "high": c["high"], "low": c["low"],
                    "close": c["close"], "volume": c["volume"]}
        else:
            o = b[k]
            o["high"] = max(o["high"], c["high"]); o["low"] = min(o["low"], c["low"])
            o["close"] = c["close"]; o["volume"] += c["volume"]
    return [b[k] for k in sorted(b)]


def ema_s(xs, n):
    k = 2 / (n + 1); out = [None] * len(xs); e = None
    for i, x in enumerate(xs):
        e = x if e is None else x * k + e * (1 - k); out[i] = e
    return out


def _dm_tr(bars):
    n = len(bars); pdm = [0.0]*n; ndm = [0.0]*n; tr = [0.0]*n
    for i in range(1, n):
        up = bars[i]["high"] - bars[i-1]["high"]; dn = bars[i-1]["low"] - bars[i]["low"]
        pdm[i] = up if up > dn and up > 0 else 0; ndm[i] = dn if dn > up and dn > 0 else 0
        tr[i] = max(bars[i]["high"]-bars[i]["low"], abs(bars[i]["high"]-bars[i-1]["close"]),
                    abs(bars[i]["low"]-bars[i-1]["close"]))
    return pdm, ndm, tr


def adx_wilder(bars, period=ADX_P):
    pdm, ndm, tr = _dm_tr(bars); n = len(bars)
    if n <= period + 1: return [None]*n
    smTR = sum(tr[1:period+1]); smPDM = sum(pdm[1:period+1]); smNDM = sum(ndm[1:period+1])
    dx_arr = []; adx_val = None; out = [None]*n
    for i in range(period+1, n):
        smTR += -smTR/period + tr[i]; smPDM += -smPDM/period + pdm[i]; smNDM += -smNDM/period + ndm[i]
        pdi = smPDM/smTR*100 if smTR > 0 else 0; ndi = smNDM/smTR*100 if smTR > 0 else 0
        dx = abs(pdi-ndi)/(pdi+ndi)*100 if (pdi+ndi) > 0 else 0
        dx_arr.append(dx)
        if len(dx_arr) < period: continue
        elif len(dx_arr) == period: adx_val = sum(dx_arr)/period
        else: adx_val = (adx_val*(period-1)+dx)/period
        out[i] = adx_val
    return out


def atr_series(bars, period=ADX_P):
    _, _, tr = _dm_tr(bars); n = len(bars); atr = [None]*n
    atr[period] = sum(tr[1:period+1])/period
    for i in range(period+1, n):
        atr[i] = (atr[i-1]*(period-1)+tr[i])/period
    return atr


def regime_with_persistence(bars1d, persist_n=3):
    cs = [b["close"] for b in bars1d]; n = len(bars1d); raw = ["RANGE"]*n
    for i in range(200, n):
        ma200 = sum(cs[i-199:i+1])/200; ma50 = sum(cs[i-50:i+1])/50
        r20 = bars1d[i-19:i+1]; ar = sum((b["high"]-b["low"])/b["close"] for b in r20)/20
        if cs[i] < ma200: raw[i] = "BEAR"
        elif cs[i] > ma50 and ma50 > ma200 and ar > 0.04: raw[i] = "BULL"
    out = ["RANGE"]*n; cur = "RANGE"; cnt = 0; last_raw = "RANGE"
    for i in range(n):
        r = raw[i]
        if r == last_raw: cnt += 1
        else: cnt = 1; last_raw = r
        if cnt >= persist_n: cur = r
        out[i] = cur
    return out


print("Loading data...")
RAW = json.load(open(CACHE))
bars4h = load_tf(RAW, H4)
bars1h = load_tf(RAW, 3600*1000)
bars1d = load_tf(RAW, 86400*1000)
n = len(bars4h); c4 = [b["close"] for b in bars4h]

# funding: nearest <= bar time
fund_raw = sorted(json.load(open(FUNDING)), key=lambda x: x["time"])
ft = [f["time"] for f in fund_raw]; frate = [f["rate"] for f in fund_raw]
def funding_at(ts):
    lo, hi, idx = 0, len(ft)-1, 0
    while lo <= hi:
        m = (lo+hi)//2
        if ft[m] <= ts: idx = m; lo = m+1
        else: hi = m-1
    return frate[idx] if ft else 0.0

e50 = ema_s(c4, EMA_FAST); e200 = ema_s(c4, EMA_SLOW)
atr4 = atr_series(bars4h); adx4 = adx_wilder(bars4h)
e200_1h = ema_s([b["close"] for b in bars1h], 200); h1t = [b["time"] for b in bars1h]
regime_1d = regime_with_persistence(bars1d)
reg_map = {b["time"]//86400000: regime_1d[i] for i, b in enumerate(bars1d)}
def get_reg(ts): return reg_map.get(ts//86400000, "RANGE")
def atp(i):
    if atr4[i] is None: return None
    return atr4[i]/c4[i]
def atp_pass(i):
    if i < ATR_PCT_LB+14: return False
    vs = [atp(j) for j in range(i-ATR_PCT_LB, i) if atp(j) is not None]
    if len(vs) < ATR_PCT_LB: return False
    cur = atp(i)
    if cur is None: return False
    return cur >= sorted(vs)[int(len(vs)*ATR_PCT_PCTL)]
def vol_pass(i):
    if i < VOL_MA: return False
    ma = sum(bars4h[j]["volume"] for j in range(i-VOL_MA, i))/VOL_MA
    return bars4h[i]["volume"] >= ma*VOL_MULT
def e200_1h_at(ts):
    lo, hi, idx = 0, len(h1t)-1, 0
    while lo <= hi:
        m = (lo+hi)//2
        if h1t[m] <= ts: idx = m; lo = m+1
        else: hi = m-1
    return e200_1h[idx]
def utc_hour(ts): return datetime.datetime.utcfromtimestamp(ts/1000).hour
def utc_dow(ts): return datetime.datetime.utcfromtimestamp(ts/1000).weekday()

def filt(i):
    adv = adx4[i]
    if adv is None or adv <= ADX_THRESH: return False
    adv_prev = adx4[i-1] if i >= 1 else None
    if adv_prev is None or adv_prev <= ADX_PREV_THRESH: return False
    e1h = e200_1h_at(bars4h[i]["time"])
    if e1h is None or c4[i] < e1h: return False
    if not atp_pass(i): return False
    h = utc_hour(bars4h[i]["time"])
    if h == 16: return False
    dw = utc_dow(bars4h[i]["time"])
    if dw == 3 or dw == 6: return False
    if get_reg(bars4h[i]["time"]) != "RANGE": return False
    if funding_at(bars4h[i]["time"]) > FUNDING_BLOCK: return False  # block crowded-long
    return True

def sig_s12(i):
    if None in (e50[i], e200[i]) or i < 1: return None
    if None in (e50[i-1], e200[i-1]): return None
    return "LONG" if (e50[i-1] <= e200[i-1] and e50[i] > e200[i]) else None
def sig_s13(i):
    if atr4[i] is None or i < 1: return None
    return "LONG" if c4[i] > bars4h[i-1]["close"] + atr4[i]*ATR_BREAK_MULT else None
def sig_s14(i):
    if i < DONCHIAN_LB: return None
    hi = max(bars4h[j]["high"] for j in range(i-DONCHIAN_LB, i))
    return "LONG" if c4[i] > hi else None
sigs = {"S12": sig_s12, "S13": sig_s13, "S14": sig_s14}
do_vol = {"S12": False, "S13": True, "S14": True}

def sim(ei, fee, entry_slip, sl_slip):
    """LONG only. entry_slip: enter at close*(1+entry_slip) adverse.
       sl_slip: SL fills at stop*(1-sl_slip) adverse. Returns (net_ret, holdbars, exit_idx)."""
    ep = c4[ei] * (1 + entry_slip)
    ae = atr4[ei]
    if ae is None or ae <= 0: return None
    sl = ep - ae*SL_INIT; hwm = ep
    for h in range(1, MAX_HOLD+1):
        j = ei + h
        if j >= n: break
        mult = SL_INIT if h < SL_TRANS else SL_TRAIL
        if c4[j] > hwm:
            hwm = c4[j]; sl = hwm - ae*mult
        elif h >= SL_TRANS:
            t = hwm - ae*SL_TRAIL
            if t > sl: sl = t
        if bars4h[j]["low"] <= sl:
            fill = sl * (1 - sl_slip)            # adverse SL fill
            return (fill-ep)/ep - 2*fee, h, j
    j = min(ei+MAX_HOLD, n-1)
    return (c4[j]-ep)/ep - 2*fee, MAX_HOLD, j

def run(fee=0.0005, entry_slip=0.0, sl_slip=0.0):
    trades = []
    last = {s: 0 for s in CD}
    for i in range(250, n-MAX_HOLD):
        for sn in ["S12", "S13", "S14"]:
            if sigs[sn](i) != "LONG": continue
            if i - last[sn] < CD[sn]: continue
            if do_vol[sn] and not vol_pass(i): continue
            if not filt(i): continue
            r = sim(i, fee, entry_slip, sl_slip)
            if r is None: continue
            ret, h, xj = r
            trades.append({"ret": ret, "h": h, "ei": i,
                           "t_in": bars4h[i]["time"], "t_out": bars4h[xj]["time"],
                           "yr": datetime.datetime.utcfromtimestamp(bars4h[i]["time"]/1000).year,
                           "setup": sn})
            last[sn] = i
    return trades

def stats(trades):
    rets = [t["ret"] for t in trades]; nn = len(rets)
    if nn == 0: return None
    mean = sum(rets)/nn; sd = (sum((r-mean)**2 for r in rets)/nn)**0.5 or 1e-9
    ra = mean/sd
    # per-trade Sharpe annualized via trade freq (~trades/yr)
    yrs = (trades[-1]["t_in"]-trades[0]["t_in"])/(365.25*86400*1000) or 1
    tpy = nn/yrs
    sharpe = ra*math.sqrt(tpy)
    wr = sum(1 for r in rets if r > 0)/nn*100
    roi = sum(rets)*100
    dollars = sum(rets)*WALLET
    eq = 0; peak = 0; mdd = 0
    for r in rets:
        eq += r; peak = max(peak, eq); mdd = max(mdd, peak-eq)
    return dict(n=nn, ra=ra, sharpe=sharpe, wr=wr, roi=roi, dollars=dollars, mdd=mdd*100, tpy=tpy)


def tail_risk(trades):
    """Worst single day, worst rolling 7d, max consec loss, longest flat (days no closed trade)."""
    by_day = defaultdict(float)
    for t in trades:
        d = t["t_out"]//86400000
        by_day[d] += t["ret"]
    days = sorted(by_day)
    worst_day = min(by_day.values())*100
    worst_day_d = datetime.datetime.utcfromtimestamp(min(by_day, key=by_day.get)*86400).strftime("%Y-%m-%d")
    # rolling 7d on close dates
    worst7 = 0
    for i, d in enumerate(days):
        s = sum(by_day[dd] for dd in days if d-7 < dd <= d)
        worst7 = min(worst7, s)
    worst7 *= 100
    # max consec losing trades (chronological by exit)
    ch = sorted(trades, key=lambda x: x["t_out"])
    mc = c = 0
    for t in ch:
        if t["ret"] <= 0: c += 1; mc = max(mc, c)
        else: c = 0
    # longest flat = max gap between consecutive entries (no new trade) in days
    ent = sorted(t["t_in"] for t in trades)
    gap = 0
    for i in range(1, len(ent)):
        gap = max(gap, (ent[i]-ent[i-1])/86400000)
    return dict(worst_day=worst_day, worst_day_d=worst_day_d, worst7=worst7,
                max_consec_loss=mc, longest_flat_days=gap)


print(f"4h bars: {n}  {datetime.datetime.utcfromtimestamp(bars4h[0]['time']/1000):%Y-%m-%d} -> {datetime.datetime.utcfromtimestamp(bars4h[-1]['time']/1000):%Y-%m-%d}")
print("\n=== BASELINE (v0.4.77, FEE 0.05%/side = RT 0.10%, no slip) ===")
base = run()
bs = stats(base)
print(f"  n={bs['n']}  Sharpe={bs['sharpe']:.2f}  RA={bs['ra']:+.3f}  WR={bs['wr']:.0f}%  ROI={bs['roi']:+.0f}%  ${bs['dollars']:+,.0f}  MaxDD={bs['mdd']:.0f}%  trades/yr={bs['tpy']:.0f}")

# ---- TASK 1: fee/cost stress ----
print("\n=== TASK 1: round-trip cost stress ===")
print(f"  {'RT cost':>8} | {'fee/side':>8} | {'n':>4} | {'Sharpe':>7} | {'WR':>4} | {'ROI%':>7} | {'$ (100k)':>11} | {'MaxDD%':>7}")
for rt in [0.0010, 0.0015, 0.0020, 0.0030, 0.0040, 0.0050]:
    fee = rt/2
    s = stats(run(fee=fee))
    print(f"  {rt*100:>6.2f}% | {fee*100:>6.3f}% | {s['n']:>4} | {s['sharpe']:>7.2f} | {s['wr']:>3.0f}% | {s['roi']:>+7.0f} | {s['dollars']:>+11,.0f} | {s['mdd']:>6.0f}%")

# ---- TASK 2: entry slippage ----
print("\n=== TASK 2: entry slippage (adverse, FEE held at RT 0.10%) ===")
print(f"  {'entry slip':>10} | {'n':>4} | {'Sharpe':>7} | {'ROI%':>7} | {'$ (100k)':>11} | {'MaxDD%':>7}")
for es in [0.0, 0.0005, 0.0010, 0.0020]:
    s = stats(run(entry_slip=es))
    print(f"  {es*100:>+9.2f}% | {s['n']:>4} | {s['sharpe']:>7.2f} | {s['roi']:>+7.0f} | {s['dollars']:>+11,.0f} | {s['mdd']:>6.0f}%")

# ---- TASK 3: SL slippage ----
print("\n=== TASK 3: SL execution slippage (adverse fill below stop, FEE RT 0.10%) ===")
print(f"  {'SL slip':>10} | {'n':>4} | {'Sharpe':>7} | {'ROI%':>7} | {'$ (100k)':>11} | {'MaxDD%':>7}")
for ys in [0.0, 0.001, 0.003, 0.005]:
    s = stats(run(sl_slip=ys))
    print(f"  {ys*100:>+9.2f}% | {s['n']:>4} | {s['sharpe']:>7.2f} | {s['roi']:>+7.0f} | {s['dollars']:>+11,.0f} | {s['mdd']:>6.0f}%")

# ---- combined realistic stress ----
print("\n=== COMBINED realistic stress (RT 0.20% + entry slip 0.10% + SL slip 0.30%) ===")
s = stats(run(fee=0.001, entry_slip=0.001, sl_slip=0.003))
print(f"  n={s['n']}  Sharpe={s['sharpe']:.2f}  ROI={s['roi']:+.0f}%  ${s['dollars']:+,.0f}  MaxDD={s['mdd']:.0f}%")
print("=== HARSH stress (RT 0.40% + entry slip 0.20% + SL slip 0.50%) ===")
s = stats(run(fee=0.002, entry_slip=0.002, sl_slip=0.005))
print(f"  n={s['n']}  Sharpe={s['sharpe']:.2f}  ROI={s['roi']:+.0f}%  ${s['dollars']:+,.0f}  MaxDD={s['mdd']:.0f}%")

# ---- TASK 4: tail risk on baseline ----
print("\n=== TASK 4: tail-risk stats (baseline config) ===")
tr = tail_risk(base)
print(f"  Worst single day:     {tr['worst_day']:+.1f}%  (${tr['worst_day']/100*WALLET:+,.0f})  on {tr['worst_day_d']}")
print(f"  Worst rolling 7-day:  {tr['worst7']:+.1f}%  (${tr['worst7']/100*WALLET:+,.0f})")
print(f"  Max consec losses:    {tr['max_consec_loss']}")
print(f"  Longest flat (no new entry): {tr['longest_flat_days']:.0f} days")
# per-year for context
by_yr = defaultdict(float)
for t in base: by_yr[t["yr"]] += t["ret"]
print("  Per-year ROI: " + " ".join(f"{y}:{by_yr[y]*100:+.0f}%" for y in sorted(by_yr)))
