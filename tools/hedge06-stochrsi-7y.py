#!/usr/bin/env python3
"""
hedge06-stochrsi-7y.py
Rule: StochRSI(14,14,3,3) trên 4h
  - LONG khi StochRSI_K cross lên từ 0 (prev_k == 0 → cur_k > 0, hoặc prev_k < 5 → cur_k >= 5)
  - EXIT khi StochRSI_K chạm 100 (cur_k > 95)
  - SL: ATR(14)_4h × 2.0
  - Max hold: 30 bars 4h = 120h
  - Fee: 0.05% mỗi chiều
  - Capital: $100,000 / pos size: 10% equity per trade (no leverage model)
  - Backtest: 2019-01-01 → 2026-05-31
"""
import json, datetime
from collections import defaultdict

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FEE = 0.05 / 100
MAX_HOLD = 30       # bars 4h
INITIAL_CAP = 100_000
POS_SIZE_PCT = 0.10  # 10% equity per trade

print("Loading data...")
raw = json.load(open(CACHE))
raw.sort(key=lambda x: x['time'])
print(f"5m bars: {len(raw)}")

# ── Build 4h bars ─────────────────────────────────────────────────────────────
def load_tf(ms):
    b = {}
    for c in raw:
        k = c["time"] // ms
        ts = k * ms
        if k not in b:
            b[k] = {"time": ts, "open": c["open"], "high": c["high"],
                    "low": c["low"], "close": c["close"], "volume": c["volume"]}
        else:
            o = b[k]
            o["high"] = max(o["high"], c["high"])
            o["low"]  = min(o["low"],  c["low"])
            o["close"] = c["close"]
            o["volume"] += c["volume"]
    return [b[k] for k in sorted(b)]

bars4h = load_tf(4 * 3600 * 1000)
print(f"4h bars: {len(bars4h)}")

# ── Indicators ────────────────────────────────────────────────────────────────
def rsi(closes, period=14):
    out = [None] * len(closes)
    gains = losses = 0.0
    for i in range(1, period + 1):
        d = closes[i] - closes[i-1]
        if d > 0: gains += d
        else: losses -= d
    avg_g = gains / period
    avg_l = losses / period
    out[period] = 100 - 100 / (1 + avg_g / avg_l) if avg_l != 0 else 100
    for i in range(period + 1, len(closes)):
        d = closes[i] - closes[i-1]
        g = max(d, 0); l = max(-d, 0)
        avg_g = (avg_g * (period - 1) + g) / period
        avg_l = (avg_l * (period - 1) + l) / period
        out[i] = 100 - 100 / (1 + avg_g / avg_l) if avg_l != 0 else 100
    return out

def stoch_of(vals, period=14):
    """Stochastic of a series"""
    out = [None] * len(vals)
    for i in range(period - 1, len(vals)):
        window = [x for x in vals[i - period + 1: i + 1] if x is not None]
        if len(window) < period:
            continue
        lo = min(window)
        hi = max(window)
        if vals[i] is None:
            continue
        if hi == lo:
            out[i] = 50.0
        else:
            out[i] = (vals[i] - lo) / (hi - lo) * 100
    return out

def sma(vals, period):
    out = [None] * len(vals)
    for i in range(len(vals)):
        window = [v for v in vals[max(0, i-period+1):i+1] if v is not None]
        if len(window) == period:
            out[i] = sum(window) / period
    return out

def atr(bars, period=14):
    out = [None] * len(bars)
    trs = []
    for i in range(len(bars)):
        if i == 0:
            trs.append(bars[i]['high'] - bars[i]['low'])
        else:
            tr = max(bars[i]['high'] - bars[i]['low'],
                     abs(bars[i]['high'] - bars[i-1]['close']),
                     abs(bars[i]['low']  - bars[i-1]['close']))
            trs.append(tr)
    # Wilder smoothing
    avg = sum(trs[:period]) / period
    out[period-1] = avg
    for i in range(period, len(bars)):
        avg = (avg * (period - 1) + trs[i]) / period
        out[i] = avg
    return out

closes4h = [b['close'] for b in bars4h]

print("Computing indicators...")
rsi14     = rsi(closes4h, 14)
stoch_rsi = stoch_of(rsi14, 14)    # StochRSI raw (0-100)
k_line    = sma(stoch_rsi, 3)      # %K smoothed
d_line    = sma(k_line, 3)         # %D
atr14     = atr(bars4h, 14)

# ── Backtest ──────────────────────────────────────────────────────────────────
equity  = INITIAL_CAP
trades  = []
position = None   # None or dict

yr_pnl  = defaultdict(float)
yr_n    = defaultdict(int)
mo_pnl  = defaultdict(float)

def bar_date(b):
    return datetime.datetime.utcfromtimestamp(b['time'] / 1000)

print("Running backtest...")
for i in range(30, len(bars4h)):
    bar  = bars4h[i]
    pbar = bars4h[i-1]
    dt   = bar_date(bar)
    if dt.year < 2019:
        continue

    k_cur  = k_line[i]
    k_prev = k_line[i-1]
    atr_v  = atr14[i]

    if k_cur is None or k_prev is None or atr_v is None:
        continue

    # ── Manage open position ──────────────────────────────────────────────────
    if position is not None:
        price  = bar['close']
        hit_sl = price <= position['sl']
        hit_tp = k_cur >= 95           # StochRSI chạm 100 → exit
        max_hd = (i - position['entry_bar']) >= MAX_HOLD

        if hit_sl or hit_tp or max_hd:
            exit_price = position['sl'] if hit_sl else price
            pnl = (exit_price / position['entry_price'] - 1) * position['notional']
            fee = position['notional'] * FEE * 2
            net = pnl - fee
            equity += net

            reason = "SL" if hit_sl else ("TP_STOCHRSI" if hit_tp else "MAXHOLD")
            yr  = position['entry_dt'].year
            mo  = f"{position['entry_dt'].year}-{position['entry_dt'].month:02d}"
            yr_pnl[yr]  += net
            yr_n[yr]    += 1
            mo_pnl[mo]  += net

            trades.append({
                "entry_dt":   position['entry_dt'].strftime("%Y-%m-%d %H:%M"),
                "exit_dt":    dt.strftime("%Y-%m-%d %H:%M"),
                "entry_px":   round(position['entry_price'], 2),
                "exit_px":    round(exit_price, 2),
                "sl":         round(position['sl'], 2),
                "notional":   round(position['notional'], 2),
                "pnl_usd":    round(net, 2),
                "pnl_pct":    round(net / position['notional'] * 100, 2),
                "reason":     reason,
                "k_entry":    round(position['k_entry'], 2),
                "k_exit":     round(k_cur, 2),
                "equity":     round(equity, 2),
            })
            position = None

    # ── Entry signal: StochRSI K cross up from 0 zone (prev < 5, cur >= 5) ──
    if position is None:
        signal = (k_prev is not None and k_prev < 5 and k_cur >= 5)
        if signal:
            entry_price = bar['close']
            sl_price    = entry_price - atr_v * 2.0
            notional    = equity * POS_SIZE_PCT
            position = {
                "entry_price": entry_price,
                "sl":          sl_price,
                "notional":    notional,
                "entry_bar":   i,
                "entry_dt":    dt,
                "k_entry":     k_cur,
            }

# close any open position at end
if position is not None:
    last = bars4h[-1]
    exit_price = last['close']
    pnl = (exit_price / position['entry_price'] - 1) * position['notional']
    fee = position['notional'] * FEE * 2
    net = pnl - fee
    equity += net
    yr  = position['entry_dt'].year
    mo  = f"{position['entry_dt'].year}-{position['entry_dt'].month:02d}"
    yr_pnl[yr]  += net
    yr_n[yr]    += 1
    mo_pnl[mo]  += net
    trades.append({
        "entry_dt": position['entry_dt'].strftime("%Y-%m-%d %H:%M"),
        "exit_dt":  bar_date(last).strftime("%Y-%m-%d %H:%M"),
        "entry_px": round(position['entry_price'], 2),
        "exit_px":  round(exit_price, 2),
        "sl":       round(position['sl'], 2),
        "notional": round(position['notional'], 2),
        "pnl_usd":  round(net, 2),
        "pnl_pct":  round(net / position['notional'] * 100, 2),
        "reason":   "END",
        "k_entry":  round(position['k_entry'], 2),
        "k_exit":   0,
        "equity":   round(equity, 2),
    })

# ── Report ────────────────────────────────────────────────────────────────────
total_net = equity - INITIAL_CAP
roi_pct   = total_net / INITIAL_CAP * 100
n_trades  = len(trades)
wins      = [t for t in trades if t['pnl_usd'] > 0]
losses    = [t for t in trades if t['pnl_usd'] <= 0]
wr        = len(wins) / n_trades * 100 if n_trades else 0

# CAGR 2019-05-31 to 2026-05-31 = 7 years
import math
years = 7.0
cagr  = (equity / INITIAL_CAP) ** (1 / years) - 1

# Max DD
peak = INITIAL_CAP
max_dd = 0.0
eq_curve = [INITIAL_CAP]
run_eq = INITIAL_CAP
for t in trades:
    run_eq += t['pnl_usd']  # approximate; actual used equity field
    # use equity from trade
eq_curve = [INITIAL_CAP] + [t['equity'] for t in trades]
peak = eq_curve[0]
for e in eq_curve:
    if e > peak: peak = e
    dd = (peak - e) / peak * 100
    if dd > max_dd: max_dd = dd

print()
print("=" * 60)
print("  HEDGE06 — StochRSI(14,14,3,3) — 4h — 2019-2026")
print("=" * 60)
print(f"  Capital:      ${INITIAL_CAP:,.0f}  →  ${equity:,.0f}")
print(f"  Total PnL:    ${total_net:+,.0f}  ({roi_pct:+.1f}%)")
print(f"  CAGR (~7y):   {cagr*100:.1f}%")
print(f"  Max DD:       {max_dd:.1f}%")
print(f"  Trades:       {n_trades}  |  WR: {wr:.1f}%")
print(f"  Wins: {len(wins)}  Losses: {len(losses)}")
if wins:   print(f"  Avg win:   ${sum(t['pnl_usd'] for t in wins)/len(wins):,.0f}")
if losses: print(f"  Avg loss:  ${sum(t['pnl_usd'] for t in losses)/len(losses):,.0f}")
print()
print("  Per-year:")
for yr in range(2019, 2027):
    n  = yr_n.get(yr, 0)
    pl = yr_pnl.get(yr, 0)
    print(f"    {yr}: ${pl:+,.0f}  n={n}")

print()
print("  Per-month (last 24mo):")
for mo in sorted(mo_pnl.keys())[-24:]:
    print(f"    {mo}: ${mo_pnl[mo]:+,.0f}")

# ── Save results ──────────────────────────────────────────────────────────────
import os
out_dir = "/Users/lap16116/BTC_PC/btc-dashboard/docs"
result = {
    "rule": "hedge06-stochrsi",
    "config": {
        "indicator": "StochRSI(14,14,3,3)",
        "timeframe": "4h",
        "entry": "StochRSI_K cross up from 0 zone (prev<5 → cur>=5)",
        "exit":  "StochRSI_K >= 95 (chạm 100) hoặc SL hoặc max_hold=30bars",
        "sl":    "ATR(14)_4h × 2.0",
        "pos_size": "10% equity per trade",
        "fee":   "0.05% each side",
    },
    "summary": {
        "initial_capital": INITIAL_CAP,
        "final_equity":    round(equity, 2),
        "total_pnl_usd":   round(total_net, 2),
        "roi_pct":         round(roi_pct, 2),
        "cagr_pct":        round(cagr * 100, 2),
        "max_dd_pct":      round(max_dd, 2),
        "n_trades":        n_trades,
        "win_rate_pct":    round(wr, 2),
    },
    "yr_pnl":  {str(k): round(v, 2) for k, v in yr_pnl.items()},
    "yr_n":    {str(k): v for k, v in yr_n.items()},
    "mo_pnl":  {k: round(v, 2) for k, v in mo_pnl.items()},
    "trades":  trades,
}

out_path = os.path.join(out_dir, "hedge06-stochrsi-backtest-2026-06-05.json")
with open(out_path, "w") as f:
    json.dump(result, f, indent=2)
print(f"\n  Saved: {out_path}")
