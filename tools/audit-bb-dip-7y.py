#!/usr/bin/env python3
"""
audit-bb-dip-7y.py — PA2: Bollinger Band lower touch + bullish close dip entry 5m, 7y full cycle.

Signal: low <= lower_BB(20,2) on 5m AND close > open (bullish/hammer close) AND vol > MA10×1.5
Filters: RANGE regime (1d MA200/MA50 + range vol, persist 3 bars)
         EMA200 1h gate (close > EMA200_1h)
         Skip h=16 UTC | Skip Thu (3) + Sun (6)
Entry:   open của bar 5m tiếp theo sau signal
SL:      ATR(14)_5m × 2.0 below entry
TP grid: ATR×1.5, ATR×2.0, ATR×3.0, or BB midline (MA20)
Max hold: 24h = 288 bars 5m
Cooldown: 4h = 48 bars 5m
"""
import json, datetime
from collections import defaultdict

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FEE = 0.05 / 100
MAX_HOLD = 288   # 24h
CD_BARS = 48     # 4h cooldown
SL_MULT = 2.0
BB_PERIOD = 20
BB_MULT   = 2.0
VOL_MA    = 10
VOL_MULT  = 1.5

print("Loading data...")
raw = json.load(open(CACHE))
bars5m = sorted(raw, key=lambda x: x['time'])
n5 = len(bars5m)
print(f"5m bars: {n5} ({datetime.datetime.utcfromtimestamp(bars5m[0]['time']/1000):%Y-%m-%d} → {datetime.datetime.utcfromtimestamp(bars5m[-1]['time']/1000):%Y-%m-%d})")

def load_tf(ms):
    b = {}
    for c in raw:
        k = c["time"] // ms; ts = k * ms
        if k not in b:
            b[k] = {"time": ts, "open": c["open"], "high": c["high"],
                    "low": c["low"], "close": c["close"], "volume": c["volume"]}
        else:
            o = b[k]
            o["high"] = max(o["high"], c["high"]); o["low"] = min(o["low"], c["low"])
            o["close"] = c["close"]; o["volume"] += c["volume"]
    return [b[k] for k in sorted(b)]

bars1h = load_tf(3600 * 1000)
bars1d = load_tf(86400 * 1000)

def ema_s(xs, p):
    k = 2 / (p + 1); out = [None] * len(xs); e = None
    for i, x in enumerate(xs):
        e = x if e is None else x * k + e * (1 - k); out[i] = e
    return out

e200_1h = ema_s([b["close"] for b in bars1h], 200)
h1t = [b["time"] for b in bars1h]

def e200_1h_at(ts):
    lo, hi, idx = 0, len(h1t) - 1, 0
    while lo <= hi:
        m = (lo + hi) // 2
        if h1t[m] <= ts: idx = m; lo = m + 1
        else: hi = m - 1
    return e200_1h[idx]

def regime_build():
    cs = [b["close"] for b in bars1d]; nd = len(bars1d); rr = ["RANGE"] * nd
    for i in range(200, nd):
        ma200 = sum(cs[i-199:i+1]) / 200; ma50 = sum(cs[i-50:i+1]) / 50
        ar = sum((b["high"] - b["low"]) / b["close"] for b in bars1d[i-19:i+1]) / 20
        if cs[i] < ma200: rr[i] = "BEAR"
        elif cs[i] > ma50 and ma50 > ma200 and ar > 0.04: rr[i] = "BULL"
    out = ["RANGE"] * nd; cur = "RANGE"; cnt = 0; lr = "RANGE"
    for i in range(nd):
        r = rr[i]
        if r == lr: cnt += 1
        else: cnt = 1; lr = r
        if cnt >= 3: cur = r
        out[i] = cur
    return {bars1d[i]["time"] // 86400000: out[i] for i in range(nd)}

print("Building regime map...")
reg_map = regime_build()
def get_reg(ts): return reg_map.get(ts // 86400000, "RANGE")

# ── ATR Wilder 5m ─────────────────────────────────────────────────────────────
def atr_wilder_arr(bars, period=14):
    n = len(bars); atr = [None] * n; trs = []
    for i in range(1, n):
        tr = max(bars[i]['high'] - bars[i]['low'],
                 abs(bars[i]['high'] - bars[i-1]['close']),
                 abs(bars[i]['low']  - bars[i-1]['close']))
        trs.append(tr)
    if len(trs) < period: return atr
    s = sum(trs[:period]) / period; atr[period] = s
    for i in range(period + 1, n): atr[i] = (atr[i-1] * (period - 1) + trs[i-1]) / period
    return atr

print("Computing ATR 5m...")
atr5 = atr_wilder_arr(bars5m, 14)

# ── Bollinger Bands 5m (sliding window O(n)) ──────────────────────────────────
def bb_arr(bars, period=20, mult=2.0):
    n = len(bars)
    bb_mid = [None] * n; bb_low = [None] * n
    window = []; s = 0.0; s2 = 0.0
    for i, b in enumerate(bars):
        c = b['close']
        window.append(c); s += c; s2 += c * c
        if len(window) > period:
            old = window.pop(0); s -= old; s2 -= old * old
        if len(window) == period:
            ma = s / period
            var = max(s2 / period - ma * ma, 0)
            std = var ** 0.5
            bb_mid[i] = ma
            bb_low[i] = ma - mult * std
    return bb_mid, bb_low

print("Computing BB 5m...")
bb_mid5, bb_low5 = bb_arr(bars5m, BB_PERIOD, BB_MULT)

# ── Volume MA10 5m ────────────────────────────────────────────────────────────
def vol_ma_arr(bars, period=10):
    n = len(bars); out = [None] * n; window = []; s = 0.0
    for i, b in enumerate(bars):
        v = b['volume']; window.append(v); s += v
        if len(window) > period:
            old = window.pop(0); s -= old
        if len(window) == period:
            out[i] = s / period
    return out

print("Computing Vol MA10 5m...")
vol_ma5 = vol_ma_arr(bars5m, VOL_MA)

def utc_h(ts):  return datetime.datetime.utcfromtimestamp(ts/1000).hour
def utc_dw(ts): return datetime.datetime.utcfromtimestamp(ts/1000).weekday()

# ── Simulate single trade ─────────────────────────────────────────────────────
def sim5m_tp_fixed(entry_idx, sl_mult, tp_mult):
    ep = bars5m[entry_idx]['open']
    ae = atr5[entry_idx]
    if ae is None or ae <= 0: return None
    sl = ep - ae * sl_mult
    tp = ep + ae * tp_mult
    for h in range(1, MAX_HOLD + 1):
        j = entry_idx + h
        if j >= n5: break
        b = bars5m[j]
        if b['high'] >= tp: return (tp - ep) / ep - 2 * FEE, h
        if b['low'] <= sl:  return (sl - ep) / ep - 2 * FEE, h
    j = min(entry_idx + MAX_HOLD, n5 - 1)
    return (bars5m[j]['close'] - ep) / ep - 2 * FEE, MAX_HOLD

def sim5m_tp_midline(entry_idx, sl_mult, midline_price):
    ep = bars5m[entry_idx]['open']
    ae = atr5[entry_idx]
    if ae is None or ae <= 0: return None
    sl = ep - ae * sl_mult
    tp = midline_price  # BB midline tại thời điểm signal
    if tp <= ep:  # midline below entry → skip
        return None
    for h in range(1, MAX_HOLD + 1):
        j = entry_idx + h
        if j >= n5: break
        b = bars5m[j]
        if b['high'] >= tp: return (tp - ep) / ep - 2 * FEE, h
        if b['low'] <= sl:  return (sl - ep) / ep - 2 * FEE, h
    j = min(entry_idx + MAX_HOLD, n5 - 1)
    return (bars5m[j]['close'] - ep) / ep - 2 * FEE, MAX_HOLD

# ── Backtest ──────────────────────────────────────────────────────────────────
def run(tp_mode, tp_mult=None, yr_filter=None):
    """tp_mode: 'fixed' (uses tp_mult) or 'midline' (TP = BB midline at signal)"""
    trades = []; last_entry = -CD_BARS - 1
    WARM = 600
    for i in range(WARM, n5 - MAX_HOLD - 2):
        if i - last_entry < CD_BARS: continue
        ts = bars5m[i]['time']
        yr = datetime.datetime.utcfromtimestamp(ts/1000).year
        if yr_filter and yr != yr_filter: continue

        # BB lower touch signal
        if bb_low5[i] is None or bb_mid5[i] is None: continue
        if bars5m[i]['low'] > bb_low5[i]: continue      # must touch lower BB
        if bars5m[i]['close'] <= bars5m[i]['open']: continue  # must be bullish close

        # Volume spike
        if vol_ma5[i] is None or bars5m[i]['volume'] < vol_ma5[i] * VOL_MULT: continue

        # RANGE regime
        if get_reg(ts) != "RANGE": continue

        # EMA200 1h gate
        e1h = e200_1h_at(ts)
        if e1h is None or bars5m[i]['close'] < e1h: continue

        # Skip h=16 UTC + Thu/Sun
        if utc_h(ts) == 16: continue
        if utc_dw(ts) in (3, 6): continue

        # Entry bar checks
        if i + 1 >= n5 or atr5[i+1] is None: continue

        if tp_mode == 'fixed':
            r = sim5m_tp_fixed(i + 1, SL_MULT, tp_mult)
        else:  # midline
            r = sim5m_tp_midline(i + 1, SL_MULT, bb_mid5[i])
        if r is None: continue
        pnl, h = r
        trades.append({'ret': pnl, 'h': h, 'yr': yr, 'ts': ts})
        last_entry = i
    return trades

def stats(trades):
    if not trades: return None
    rets = [t['ret'] for t in trades]; nn = len(rets)
    mean = sum(rets) / nn
    sd = (sum((r - mean)**2 for r in rets) / nn) ** 0.5 or 1e-9
    ra = mean / sd
    wr = sum(1 for r in rets if r > 0) / nn * 100
    roi = sum(rets) * 100
    wins = [r for r in rets if r > 0]; losses = [r for r in rets if r <= 0]
    rr = (sum(wins)/len(wins)) / abs(sum(losses)/len(losses)) if wins and losses else float('nan')
    eq = 0; peak = 0; max_dd = 0
    for r in rets:
        eq += r
        if eq > peak: peak = eq
        dd = peak - eq
        if dd > max_dd: max_dd = dd
    avg_h = sum(t['h'] for t in trades) / nn
    return dict(n=nn, ra=ra, wr=wr, roi=roi, rr=rr, dd=max_dd*100, avg_h=avg_h)

YEARS = [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]

print("\n" + "="*90)
print("PA2: BB DIP ENTRY — lower_BB(20,2) touch + bullish close + vol>MA10×1.5 on 5m")
print(f"RANGE regime | EMA200 1h gate | SL: ATR×{SL_MULT} | Max hold: {MAX_HOLD} bars (24h)")
print("="*90)

# Grid search TP (fixed ATR multiples)
print(f"\n── TP = Fixed ATR multiples ──")
print(f"  {'TP':>12}  {'n':>5}  {'RA':>7}  {'WR':>5}  {'R:R':>5}  {'ROI%':>8}  {'DD%':>6}  {'AvgH':>6}")
print(f"  {'-'*70}")

TP_GRID = [1.5, 2.0, 3.0, 4.0]
best_ra = None; best_tp = 2.0
for tp in TP_GRID:
    print(f"  Testing TP={tp}x...", end="\r")
    trades = run('fixed', tp_mult=tp)
    m = stats(trades)
    if m is None:
        print(f"  {'ATR×'+str(tp):>12}  {'—':>5}  no trades")
        continue
    marker = " ← best" if (best_ra is None or m['ra'] > best_ra) else ""
    if best_ra is None or m['ra'] > best_ra:
        best_ra = m['ra']; best_tp = tp
    print(f"  {'ATR×'+str(tp):>12}  {m['n']:>5}  {m['ra']:>+7.3f}  {m['wr']:>4.0f}%  {m['rr']:>5.2f}  {m['roi']:>+8.1f}%  {m['dd']:>5.1f}%  {m['avg_h']:>5.0f}{marker}")

# Midline TP
print(f"\n  Testing TP=BB midline...", end="\r")
trades_mid = run('midline')
m_mid = stats(trades_mid)
if m_mid:
    print(f"  {'BB midline':>12}  {m_mid['n']:>5}  {m_mid['ra']:>+7.3f}  {m_mid['wr']:>4.0f}%  {m_mid['rr']:>5.2f}  {m_mid['roi']:>+8.1f}%  {m_mid['dd']:>5.1f}%  {m_mid['avg_h']:>5.0f}")
else:
    print(f"  {'BB midline':>12}  no trades")

# Per-year for best fixed TP
print(f"\n── Per-year breakdown (best TP=ATR×{best_tp}) ──")
print(f"  {'Year':>6}  {'n':>5}  {'RA':>7}  {'WR':>5}  {'ROI%':>8}  {'Result':>8}")
print(f"  {'-'*55}")
pos_yrs = 0; data_yrs = 0
for yr in YEARS:
    trades_yr = run('fixed', tp_mult=best_tp, yr_filter=yr)
    if not trades_yr:
        print(f"  {yr:>6}  {'0':>5}  {'—':>7}  {'—':>5}  {'—':>8}  (no signal)")
        continue
    m = stats(trades_yr)
    data_yrs += 1
    ok = "✓" if m['roi'] > 0 else "✗"
    if m['roi'] > 0: pos_yrs += 1
    print(f"  {yr:>6}  {m['n']:>5}  {m['ra']:>+7.3f}  {m['wr']:>4.0f}%  {m['roi']:>+8.1f}%  {ok:>8}")
print(f"\n  Stability: {pos_yrs}/{data_yrs} positive years")

# Per-year for midline TP
if m_mid:
    print(f"\n── Per-year breakdown (TP=BB midline) ──")
    print(f"  {'Year':>6}  {'n':>5}  {'RA':>7}  {'WR':>5}  {'ROI%':>8}  {'Result':>8}")
    print(f"  {'-'*55}")
    pos_m = 0; data_m = 0
    for yr in YEARS:
        trades_yr = run('midline', yr_filter=yr)
        if not trades_yr:
            print(f"  {yr:>6}  {'0':>5}  {'—':>7}  {'—':>5}  {'—':>8}  (no signal)")
            continue
        m = stats(trades_yr)
        data_m += 1
        ok = "✓" if m['roi'] > 0 else "✗"
        if m['roi'] > 0: pos_m += 1
        print(f"  {yr:>6}  {m['n']:>5}  {m['ra']:>+7.3f}  {m['wr']:>4.0f}%  {m['roi']:>+8.1f}%  {ok:>8}")
    print(f"\n  Stability: {pos_m}/{data_m} positive years")

# Sample trades
print(f"\n── Sample trades (best TP=ATR×{best_tp}) ──")
sample = run('fixed', tp_mult=best_tp)
print(f"  {'Date':>16}  {'PnL%':>7}  {'Hold(bars)':>10}  {'Result':>8}")
print(f"  {'-'*50}")
for t in sample[:20]:
    dt = datetime.datetime.utcfromtimestamp(t['ts']/1000).strftime('%Y-%m-%d %H:%M')
    ok = "WIN ✓" if t['ret'] > 0 else "LOSS ✗"
    print(f"  {dt:>16}  {t['ret']*100:>+7.2f}%  {t['h']:>10}  {ok:>8}")

print(f"\nTotal trades: {len(sample)}")
print("\nDone.")
