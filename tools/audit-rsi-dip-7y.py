#!/usr/bin/env python3
"""
audit-rsi-dip-7y.py — PA1: Mean-reversion RSI oversold dip entry 5m, 7y full cycle.

Signal: RSI(14) 5m cross above 30 (prev_rsi < 30 → cur_rsi >= 30)
Filters: RANGE regime (1d MA200/MA50 + range vol, persist 3 bars)
         EMA200 1h gate (close > EMA200_1h)
         Skip h=16 UTC | Skip Thu (3) + Sun (6)
Entry:   open của bar 5m tiếp theo sau signal
SL:      ATR(14)_5m × 2.0 below entry
TP:      ATR(14)_5m × grid (1.0, 1.5, 2.0, 3.0, 4.0) above entry
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

print("Loading data...")
raw = json.load(open(CACHE))
bars5m = sorted(raw, key=lambda x: x['time'])
n5 = len(bars5m)
print(f"5m bars: {n5} ({datetime.datetime.utcfromtimestamp(bars5m[0]['time']/1000):%Y-%m-%d} → {datetime.datetime.utcfromtimestamp(bars5m[-1]['time']/1000):%Y-%m-%d})")

# ── Build higher TF bars ──────────────────────────────────────────────────────
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

# ── EMA 200 on 1h ─────────────────────────────────────────────────────────────
def ema_s(xs, p):
    k = 2 / (p + 1); out = [None] * len(xs); e = None
    for i, x in enumerate(xs):
        e = x if e is None else x * k + e * (1 - k)
        out[i] = e
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

# ── Regime 1d ─────────────────────────────────────────────────────────────────
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

# ── ATR Wilder 5m ────────────────────────────────────────────────────────────
def atr_wilder_arr(bars, period=14):
    n = len(bars); atr = [None] * n
    trs = []
    for i in range(1, n):
        tr = max(bars[i]['high'] - bars[i]['low'],
                 abs(bars[i]['high'] - bars[i-1]['close']),
                 abs(bars[i]['low']  - bars[i-1]['close']))
        trs.append(tr)
    if len(trs) < period: return atr
    s = sum(trs[:period]) / period
    atr[period] = s
    for i in range(period + 1, n):
        atr[i] = (atr[i-1] * (period - 1) + trs[i-1]) / period
    return atr

print("Computing ATR 5m...")
atr5 = atr_wilder_arr(bars5m, 14)

# ── RSI Wilder 5m ─────────────────────────────────────────────────────────────
def rsi_arr(bars, period=14):
    n = len(bars); rsi = [None] * n
    if n < period + 1: return rsi
    gains = []; losses = []
    for i in range(1, n):
        d = bars[i]['close'] - bars[i-1]['close']
        gains.append(max(d, 0)); losses.append(max(-d, 0))
    if len(gains) < period: return rsi
    ag = sum(gains[:period]) / period
    al = sum(losses[:period]) / period
    rs = ag / al if al > 0 else 100
    rsi[period] = 100 - 100 / (1 + rs)
    for i in range(period + 1, n):
        g = gains[i-1]; l = losses[i-1]
        ag = (ag * (period - 1) + g) / period
        al = (al * (period - 1) + l) / period
        rs = ag / al if al > 0 else 100
        rsi[i] = 100 - 100 / (1 + rs)
    return rsi

print("Computing RSI 5m...")
rsi5 = rsi_arr(bars5m, 14)

def utc_h(ts):  return datetime.datetime.utcfromtimestamp(ts/1000).hour
def utc_dw(ts): return datetime.datetime.utcfromtimestamp(ts/1000).weekday()

# ── Simulate single trade ─────────────────────────────────────────────────────
def sim5m(entry_idx, sl_mult, tp_mult):
    ep = bars5m[entry_idx]['open']
    ae = atr5[entry_idx]
    if ae is None or ae <= 0: return None
    sl = ep - ae * sl_mult
    tp = ep + ae * tp_mult
    for h in range(1, MAX_HOLD + 1):
        j = entry_idx + h
        if j >= n5: break
        b = bars5m[j]
        if b['high'] >= tp:
            return (tp - ep) / ep - 2 * FEE, h
        if b['low'] <= sl:
            return (sl - ep) / ep - 2 * FEE, h
    j = min(entry_idx + MAX_HOLD, n5 - 1)
    return (bars5m[j]['close'] - ep) / ep - 2 * FEE, MAX_HOLD

# ── Backtest ──────────────────────────────────────────────────────────────────
def run(tp_mult, yr_filter=None):
    trades = []; last_entry = -CD_BARS - 1
    WARM = 500
    for i in range(WARM, n5 - MAX_HOLD - 2):
        if i - last_entry < CD_BARS: continue
        ts = bars5m[i]['time']
        yr = datetime.datetime.utcfromtimestamp(ts/1000).year
        if yr_filter and yr != yr_filter: continue
        if rsi5[i] is None or rsi5[i-1] is None: continue
        if not (rsi5[i-1] < 30 and rsi5[i] >= 30): continue
        if get_reg(ts) != "RANGE": continue
        e1h = e200_1h_at(ts)
        if e1h is None or bars5m[i]['close'] < e1h: continue
        if utc_h(ts) == 16: continue
        if utc_dw(ts) in (3, 6): continue
        if i + 1 >= n5 or atr5[i+1] is None: continue
        r = sim5m(i + 1, SL_MULT, tp_mult)
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

TP_GRID = [1.0, 1.5, 2.0, 3.0, 4.0]
YEARS   = [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]

# ── Grid search ───────────────────────────────────────────────────────────────
print("\n" + "="*90)
print("PA1: RSI DIP ENTRY — RSI(14) 5m cross above 30 | RANGE regime | EMA200 1h gate")
print(f"SL: ATR×{SL_MULT} | Max hold: {MAX_HOLD} bars (24h) | Cooldown: {CD_BARS} bars (4h)")
print("="*90)
print(f"\n  {'TP':>5}  {'n':>5}  {'RA':>7}  {'WR':>5}  {'R:R':>5}  {'ROI%':>8}  {'DD%':>6}  {'AvgH':>6}")
print(f"  {'-'*60}")

best_ra = None; best_tp = 2.0
for tp in TP_GRID:
    print(f"  Running TP={tp}x...", end="\r")
    trades = run(tp)
    m = stats(trades)
    if m is None:
        print(f"  {tp:>5.1f}  {'—':>5}  no trades")
        continue
    marker = " ← best" if (best_ra is None or m['ra'] > best_ra) else ""
    if best_ra is None or m['ra'] > best_ra:
        best_ra = m['ra']; best_tp = tp
    print(f"  {tp:>5.1f}  {m['n']:>5}  {m['ra']:>+7.3f}  {m['wr']:>4.0f}%  {m['rr']:>5.2f}  {m['roi']:>+8.1f}%  {m['dd']:>5.1f}%  {m['avg_h']:>5.0f}{marker}")

# ── Per-year for best TP ──────────────────────────────────────────────────────
print(f"\n── Per-year breakdown (best TP={best_tp}×, SL={SL_MULT}×) ──")
print(f"  {'Year':>6}  {'n':>5}  {'RA':>7}  {'WR':>5}  {'ROI%':>8}  {'Regime?':>10}")
print(f"  {'-'*55}")
pos_yrs = 0; data_yrs = 0
for yr in YEARS:
    trades_yr = run(best_tp, yr_filter=yr)
    if not trades_yr:
        print(f"  {yr:>6}  {'0':>5}  {'—':>7}  {'—':>5}  {'—':>8}  (no signal)")
        continue
    m = stats(trades_yr)
    data_yrs += 1
    ok = "✓" if m['roi'] > 0 else "✗"
    if m['roi'] > 0: pos_yrs += 1
    print(f"  {yr:>6}  {m['n']:>5}  {m['ra']:>+7.3f}  {m['wr']:>4.0f}%  {m['roi']:>+8.1f}%  {ok:>10}")

print(f"\n  Stability: {pos_yrs}/{data_yrs} positive years")

# ── Sample trades (first 20) ──────────────────────────────────────────────────
print(f"\n── Sample trades (best TP={best_tp}×) ──")
sample = run(best_tp)
print(f"  {'Date':>16}  {'PnL%':>7}  {'Hold(bars)':>10}  {'Result':>8}")
print(f"  {'-'*50}")
for t in sample[:20]:
    dt = datetime.datetime.utcfromtimestamp(t['ts']/1000).strftime('%Y-%m-%d %H:%M')
    ok = "WIN ✓" if t['ret'] > 0 else "LOSS ✗"
    print(f"  {dt:>16}  {t['ret']*100:>+7.2f}%  {t['h']:>10}  {ok:>8}")

print(f"\nTotal trades: {len(sample)}")
print("\nDone.")
