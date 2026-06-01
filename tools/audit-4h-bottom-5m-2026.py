#!/usr/bin/env python3
"""
audit-4h-bottom-5m-2026.py — Tìm cây 5m tạo ra đáy của 4h bar trong 2026.

Flow:
  1. Với mỗi 4h bar → tìm cây 5m có low = low của 4h bar (bottom candle)
  2. Phân tích features của cây 5m đó: wick, body, volume, momentum
  3. Phân loại: bottom 4h sau đó BOUNCE (4h close > open của 4h tiếp theo 2 bars)
                 vs FAIL (tiếp tục giảm)
  4. So sánh features BOUNCE vs FAIL → tìm discriminating pattern
"""
import json, datetime, math, statistics
from collections import defaultdict

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"

print("Loading data...")
raw = json.load(open(CACHE))

# Build 5m bars
bars5m = sorted(raw, key=lambda x: x['time'])
ts5m   = [b['time'] for b in bars5m]
n5 = len(bars5m)

# Build 4h bars (keep all 5m indices inside each 4h)
H4 = 4 * 3600 * 1000
b4h = {}
for idx, c in enumerate(bars5m):
    k = c['time'] // H4
    if k not in b4h:
        b4h[k] = {'time': k*H4, 'open': c['open'], 'high': c['high'],
                  'low': c['low'], 'close': c['close'], 'volume': c['volume'],
                  'low_idx': idx, 'idx_start': idx, 'idx_end': idx}
    else:
        o = b4h[k]
        o['high']   = max(o['high'], c['high'])
        if c['low'] < o['low']:
            o['low'] = c['low']; o['low_idx'] = idx
        o['close']  = c['close']; o['volume'] += c['volume']
        o['idx_end'] = idx

bars4h = [b4h[k] for k in sorted(b4h)]
n4 = len(bars4h)

# Filter 2026 bars4h
bars2026 = [(i, b) for i, b in enumerate(bars4h)
            if datetime.datetime.utcfromtimestamp(b['time']/1000).year == 2026]
print(f"4h bars 2026: {len(bars2026)}")

# SMA helper
def sma(arr, period):
    if len(arr) < period: return None
    return sum(arr[-period:]) / period

# RSI
def rsi(closes, period=14):
    if len(closes) < period + 1: return None
    gains, losses = [], []
    for i in range(1, len(closes)):
        d = closes[i] - closes[i-1]
        gains.append(max(d, 0)); losses.append(max(-d, 0))
    ag = sum(gains[-period:]) / period
    al = sum(losses[-period:]) / period
    if al == 0: return 100
    rs = ag / al; return 100 - 100 / (1 + rs)

# ATR Wilder
def atr_val(bars5, period=14):
    if len(bars5) < period + 1: return None
    trs = []
    for i in range(1, len(bars5)):
        trs.append(max(bars5[i]['high'] - bars5[i]['low'],
                       abs(bars5[i]['high'] - bars5[i-1]['close']),
                       abs(bars5[i]['low']  - bars5[i-1]['close'])))
    if len(trs) < period: return None
    a = sum(trs[:period]) / period
    for t in trs[period:]: a = (a * 13 + t) / 14
    return a

# ── Main analysis ─────────────────────────────────────────────────────────────
LOOKBACK_5M = 60   # 5h lookback for indicators on 5m
FORWARD_4H  = 2    # check nếu 4h sau đó tăng (bounce)

results = []

for pos4h, (i4, b4) in enumerate(bars2026):
    # Global index trong bars4h
    gi4 = i4

    # Cây 5m tạo đáy của 4h bar này
    low_idx5 = b4['low_idx']
    bot5 = bars5m[low_idx5]

    # Cần đủ lookback cho indicators
    if low_idx5 < LOOKBACK_5M + 20: continue

    # 5m context window (CLOSED bars trước bot5)
    ctx = bars5m[low_idx5 - LOOKBACK_5M : low_idx5 + 1]
    if len(ctx) < LOOKBACK_5M: continue

    closes5 = [b['close'] for b in ctx]
    vols5   = [b['volume'] for b in ctx]
    last5   = ctx[-1]  # = bot5

    # ── Features của cây 5m đáy ──────────────────────────────────────────────

    # 1. Wick và body
    body_pct  = abs(last5['close'] - last5['open']) / last5['open'] * 100
    dn_wick   = (min(last5['open'], last5['close']) - last5['low']) / last5['open'] * 100
    up_wick   = (last5['high'] - max(last5['open'], last5['close'])) / last5['open'] * 100
    is_bull5  = last5['close'] > last5['open']  # cây tăng hay giảm

    # 2. Volume ratio vs MA20
    vol_ma20  = sma(vols5[:-1], 20)   # không bao gồm chính cây đáy
    vol_ratio = (last5['volume'] / vol_ma20) if vol_ma20 and vol_ma20 > 0 else None

    # 3. RSI(14) 5m
    rsi14 = rsi(closes5[:-1], 14)   # dùng closes trước cây đáy

    # 4. Momentum (mom trên 5m)
    mom5  = (closes5[-1] - closes5[-6])  / closes5[-6]  * 100 if len(closes5) >= 6  else None
    mom20 = (closes5[-1] - closes5[-21]) / closes5[-21] * 100 if len(closes5) >= 21 else None
    mom60 = (closes5[-1] - closes5[-61]) / closes5[-61] * 100 if len(closes5) >= 61 else None

    # 5. ATR ratio: range cây đáy / ATR(14) 5m
    atr14_5m = atr_val(ctx[:-1], 14)
    atr_ratio5 = ((last5['high'] - last5['low']) / atr14_5m) if atr14_5m and atr14_5m > 0 else None

    # 6. Position trong 4h bar: đáy xuất hiện ở đầu/giữa/cuối bar
    idx_start = b4['idx_start']; idx_end = b4['idx_end']
    bar_len = max(1, idx_end - idx_start)
    pos_in_bar = (low_idx5 - idx_start) / bar_len  # 0=đầu bar, 1=cuối bar

    # 7. Dist từ MA (5m MA50 và MA200)
    ma50_5  = sma(closes5[:-1], 50)
    ma200_5 = sma(closes5[:-1], min(200, len(closes5)-1))
    dist_ma50  = (closes5[-1] - ma50_5)  / ma50_5  * 100 if ma50_5  else None
    dist_ma200 = (closes5[-1] - ma200_5) / ma200_5 * 100 if ma200_5 else None

    # ── Outcome: BOUNCE hay FAIL ──────────────────────────────────────────────
    # BOUNCE = 4h bar tiếp theo close > open (bullish), tức là BTC tăng sau đáy
    if gi4 + 1 < n4:
        next4h = bars4h[gi4 + 1]
        bounce = next4h['close'] > next4h['open']
        next_pct = (next4h['close'] - next4h['open']) / next4h['open'] * 100
    else:
        bounce = None; next_pct = None

    results.append({
        'dt':       datetime.datetime.utcfromtimestamp(bot5['time']/1000),
        'low':      last5['low'],
        'body':     body_pct,
        'dn_wick':  dn_wick,
        'up_wick':  up_wick,
        'is_bull5': is_bull5,
        'vol_r':    vol_ratio,
        'rsi14':    rsi14,
        'mom5':     mom5,
        'mom20':    mom20,
        'mom60':    mom60,
        'atr_r':    atr_ratio5,
        'pos_bar':  pos_in_bar,
        'dist_ma50':dist_ma50,
        'dist_ma200':dist_ma200,
        'bounce':   bounce,
        'next_pct': next_pct,
    })

print(f"Total 4h bottoms analyzed: {len(results)}")
bounces = [r for r in results if r['bounce'] == True]
fails   = [r for r in results if r['bounce'] == False]
print(f"  BOUNCE (next 4h bullish): {len(bounces)} ({len(bounces)/len(results)*100:.0f}%)")
print(f"  FAIL   (next 4h bearish): {len(fails)}   ({len(fails)/len(results)*100:.0f}%)")

# ── So sánh features BOUNCE vs FAIL ──────────────────────────────────────────
def avg(lst): return sum(lst)/len(lst) if lst else float('nan')
def pct_true(lst): return sum(1 for x in lst if x)*100/len(lst) if lst else float('nan')

print("\n" + "="*80)
print("FEATURE COMPARISON — BOUNCE vs FAIL (5m bottom candle features)")
print("="*80)
print(f"  {'Feature':20s}  {'BOUNCE':>10}  {'FAIL':>10}  {'Δ':>8}  {'Signal?':>10}")
print(f"  {'-'*65}")

def compare(name, b_vals, f_vals, higher_is_bounce=True, decimals=2):
    bv = [x for x in b_vals if x is not None]
    fv = [x for x in f_vals if x is not None]
    ba = avg(bv); fa = avg(fv); delta = ba - fa
    signal = "✓ BOUNCE" if (delta > 0) == higher_is_bounce and abs(delta) > 0.1 else "—"
    print(f"  {name:20s}  {ba:>10.{decimals}f}  {fa:>10.{decimals}f}  {delta:>+8.{decimals}f}  {signal:>10}")

compare("dn_wick%",    [r['dn_wick']   for r in bounces], [r['dn_wick']   for r in fails], True,  2)
compare("body%",       [r['body']      for r in bounces], [r['body']      for r in fails], True,  2)
compare("is_bull5",    [float(r['is_bull5']) for r in bounces],[float(r['is_bull5']) for r in fails],True,2)
compare("vol_ratio",   [r['vol_r']     for r in bounces], [r['vol_r']     for r in fails], True,  2)
compare("atr_ratio5m", [r['atr_r']     for r in bounces], [r['atr_r']     for r in fails], True,  2)
compare("RSI14_5m",    [r['rsi14']     for r in bounces], [r['rsi14']     for r in fails], False, 1)
compare("mom5%",       [r['mom5']      for r in bounces], [r['mom5']      for r in fails], True,  2)
compare("mom20%",      [r['mom20']     for r in bounces], [r['mom20']     for r in fails], True,  2)
compare("mom60%",      [r['mom60']     for r in bounces], [r['mom60']     for r in fails], True,  2)
compare("pos_in_bar",  [r['pos_bar']   for r in bounces], [r['pos_bar']   for r in fails], False, 2)
compare("dist_ma50%",  [r['dist_ma50'] for r in bounces if r['dist_ma50']], [r['dist_ma50'] for r in fails if r['dist_ma50']], False, 2)

# ── Raw table: mỗi 4h đáy + features ────────────────────────────────────────
print("\n" + "="*80)
print("RAW TABLE — mỗi 4h đáy trong 2026 (cây 5m bottom)")
print("="*80)
print(f"  {'Date-Time':16s}  {'Low$':>8}  {'dnWk%':>6}  {'body%':>6}  {'bull':>4}  {'volR':>5}  {'RSI':>5}  {'mom60':>7}  {'posBar':>6}  {'Next4h':>8}  {'Out':>6}")
print(f"  {'-'*95}")
for r in results:
    dt_s = r['dt'].strftime('%m-%d %H:%M')
    bull = "Y" if r['is_bull5'] else "N"
    vol  = f"{r['vol_r']:.1f}" if r['vol_r'] else "—"
    rsi_ = f"{r['rsi14']:.0f}" if r['rsi14'] else "—"
    m60  = f"{r['mom60']:+.1f}%" if r['mom60'] else "—"
    nxt  = f"{r['next_pct']:+.2f}%" if r['next_pct'] is not None else "—"
    out  = "BOUNCE✓" if r['bounce'] else ("FAIL✗" if r['bounce']==False else "—")
    print(f"  {dt_s:16s}  {r['low']:>8.0f}  {r['dn_wick']:>6.2f}  {r['body']:>6.2f}  {bull:>4}  {vol:>5}  {rsi_:>5}  {m60:>7}  {r['pos_bar']:>6.2f}  {nxt:>8}  {out:>6}")

# ── Pattern rules từ analysis ─────────────────────────────────────────────────
print("\n" + "="*80)
print("PATTERN RULES — Tổng hợp dấu hiệu nhận biết BOUNCE tại đáy 4h")
print("="*80)
# Dynamic thresholds
b_dn = [r['dn_wick'] for r in bounces if r['dn_wick'] is not None]
f_dn = [r['dn_wick'] for r in fails   if r['dn_wick'] is not None]
b_rsi= [r['rsi14']   for r in bounces if r['rsi14'] is not None]
f_rsi= [r['rsi14']   for r in fails   if r['rsi14'] is not None]
b_vol= [r['vol_r']   for r in bounces if r['vol_r'] is not None]
f_vol= [r['vol_r']   for r in fails   if r['vol_r'] is not None]
b_m60= [r['mom60']   for r in bounces if r['mom60'] is not None]
f_m60= [r['mom60']   for r in fails   if r['mom60'] is not None]

print(f"\n  dn_wick%:  BOUNCE avg={avg(b_dn):.2f}%  FAIL avg={avg(f_dn):.2f}%")
print(f"  RSI14:     BOUNCE avg={avg(b_rsi):.1f}    FAIL avg={avg(f_rsi):.1f}")
print(f"  vol_ratio: BOUNCE avg={avg(b_vol):.2f}x   FAIL avg={avg(f_vol):.2f}x")
print(f"  mom60:     BOUNCE avg={avg(b_m60):+.2f}%  FAIL avg={avg(f_m60):+.2f}%")

# Test simple rule: dn_wick > X AND vol > Y
print("\n  Rule test: dn_wick >= 0.3% AND vol_ratio >= 1.5")
rule_bounce=sum(1 for r in results if r['dn_wick']>=0.3 and (r['vol_r'] or 0)>=1.5 and r['bounce']==True)
rule_total =sum(1 for r in results if r['dn_wick']>=0.3 and (r['vol_r'] or 0)>=1.5)
if rule_total>0: print(f"    Fires: {rule_total}, WR: {rule_bounce/rule_total*100:.0f}%")

print("\n  Rule test: dn_wick >= 0.5% AND vol_ratio >= 1.5")
rule_bounce=sum(1 for r in results if r['dn_wick']>=0.5 and (r['vol_r'] or 0)>=1.5 and r['bounce']==True)
rule_total =sum(1 for r in results if r['dn_wick']>=0.5 and (r['vol_r'] or 0)>=1.5)
if rule_total>0: print(f"    Fires: {rule_total}, WR: {rule_bounce/rule_total*100:.0f}%")

print("\n  Rule test: RSI14 < 40 AND dn_wick >= 0.3%")
rule_bounce=sum(1 for r in results if (r['rsi14'] or 99)<40 and r['dn_wick']>=0.3 and r['bounce']==True)
rule_total =sum(1 for r in results if (r['rsi14'] or 99)<40 and r['dn_wick']>=0.3)
if rule_total>0: print(f"    Fires: {rule_total}, WR: {rule_bounce/rule_total*100:.0f}%")
else: print("    No fires")

print("\n  Rule test: mom60 < -3% (oversold 5h) AND dn_wick >= 0.3%")
rule_bounce=sum(1 for r in results if (r['mom60'] or 0)<-3 and r['dn_wick']>=0.3 and r['bounce']==True)
rule_total =sum(1 for r in results if (r['mom60'] or 0)<-3 and r['dn_wick']>=0.3)
if rule_total>0: print(f"    Fires: {rule_total}, WR: {rule_bounce/rule_total*100:.0f}%")
else: print("    No fires")
