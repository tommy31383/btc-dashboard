#!/usr/bin/env python3
"""
stoch-oversold-chart-2026.py
Vẽ BTC 2026 + entry points từ K_1h < 20 (champion rule)
"""
import json, datetime
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
from matplotlib.patches import FancyArrowPatch
import numpy as np

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
HOLD_H = 72; COOLDOWN_H = 120; THR1H = 10

print("Loading...")
raw = json.load(open(CACHE)); raw.sort(key=lambda x: x['time'])

def build_tf(ms):
    b = {}
    for c in raw:
        k = c["time"]//ms
        if k not in b: b[k]={"time":k*ms,"open":c["open"],"high":c["high"],
                              "low":c["low"],"close":c["close"],"volume":c.get("volume",0)}
        else:
            b[k]["high"]=max(b[k]["high"],c["high"]); b[k]["low"]=min(b[k]["low"],c["low"])
            b[k]["close"]=c["close"]; b[k]["volume"]+=c.get("volume",0)
    return [b[k] for k in sorted(b)]

bars_1h = build_tf(3_600_000)
c1h = [b['close'] for b in bars_1h]
v1h = [b['volume'] for b in bars_1h]

def rsi(src, p=14):
    out=[None]*len(src)
    if len(src)<=p: return out
    g=l=0.0
    for i in range(1,p+1):
        d=src[i]-src[i-1]
        if d>0: g+=d
        else: l-=d
    g/=p; l/=p
    out[p]=100-100/(1+g/l) if l else 100.0
    for i in range(p+1,len(src)):
        d=src[i]-src[i-1]
        g=(g*(p-1)+max(d,0))/p; l=(l*(p-1)+max(-d,0))/p
        out[i]=100-100/(1+g/l) if l else 100.0
    return out

def stochrsi(src):
    r=rsi(src,14); n=len(r); rk=[None]*n
    for i in range(13,n):
        w=[x for x in r[i-13:i+1] if x is not None]
        if len(w)<14: continue
        lo,hi=min(w),max(w)
        rk[i]=50.0 if hi==lo else (r[i]-lo)/(hi-lo)*100
    K=[None]*n
    for i in range(2,n):
        w=[x for x in rk[i-2:i+1] if x is not None]
        if len(w)==3: K[i]=sum(w)/3
    D=[None]*n
    for i in range(2,n):
        w=[x for x in K[i-2:i+1] if x is not None]
        if len(w)==3: D[i]=sum(w)/3
    return K,D

K1h, D1h = stochrsi(c1h)

# Filter 2026
START_MS = datetime.datetime(2026,1,1).timestamp()*1000
END_MS   = datetime.datetime(2026,6,6).timestamp()*1000

idx_2026 = [(i,b) for i,b in enumerate(bars_1h)
            if START_MS <= b['time'] <= END_MS]

# Generate signals (same logic as backtest)
signals = []
last_t = -999_999_999
n1h = len(bars_1h)
for i, b in idx_2026:
    k = K1h[i]
    if k is None: continue
    t = b['time']
    if t - last_t < COOLDOWN_H * 3_600_000: continue
    if k >= THR1H: continue

    entry_price = b['close']
    exit_i = i + HOLD_H
    if exit_i >= n1h: continue
    exit_price = bars_1h[exit_i]['close']
    pnl_pct = (exit_price - entry_price)/entry_price*100
    win = pnl_pct > 0
    signals.append({
        "t_entry": t,
        "t_exit":  bars_1h[exit_i]['time'],
        "price_entry": entry_price,
        "price_exit":  exit_price,
        "pnl_pct": round(pnl_pct,2),
        "K": round(k,1),
        "win": win
    })
    last_t = t

print(f"2026 signals: {len(signals)}")
wins   = sum(1 for s in signals if s['win'])
losses = len(signals) - wins
print(f"  WIN={wins}  LOSS={losses}  WR={wins/len(signals)*100:.0f}%")

# ── Plot ────────────────────────────────────────────────────────────────────
times_2026  = [datetime.datetime.utcfromtimestamp(b['time']/1000) for _,b in idx_2026]
prices_2026 = [b['close'] for _,b in idx_2026]
k_2026      = [K1h[i] for i,_ in idx_2026]
d_2026      = [D1h[i] for i,_ in idx_2026]

fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(18, 10),
                                 gridspec_kw={'height_ratios': [3, 1]},
                                 sharex=True)
fig.patch.set_facecolor('#0d1117')
for ax in [ax1, ax2]:
    ax.set_facecolor('#0d1117')
    ax.tick_params(colors='#aaaaaa', labelsize=9)
    for spine in ax.spines.values(): spine.set_edgecolor('#333333')
    ax.grid(True, color='#1e2533', linewidth=0.5, linestyle='--', alpha=0.7)

# ── Price ──
ax1.plot(times_2026, prices_2026, color='#58a6ff', linewidth=1.0, alpha=0.9, zorder=2)
ax1.set_ylabel('BTC Price (USDT)', color='#aaaaaa', fontsize=10)
ax1.yaxis.set_major_formatter(plt.FuncFormatter(lambda x,_: f'${x:,.0f}'))

# Entry/Exit lines + arrows
for s in signals:
    dt_entry = datetime.datetime.utcfromtimestamp(s['t_entry']/1000)
    dt_exit  = datetime.datetime.utcfromtimestamp(s['t_exit']/1000)
    p_entry  = s['price_entry']
    p_exit   = s['price_exit']
    color    = '#3fb950' if s['win'] else '#f85149'

    # Vertical entry line
    ax1.axvline(dt_entry, color=color, linewidth=0.8, alpha=0.4, linestyle='-', zorder=1)

    # Entry arrow (pointing up = LONG)
    ax1.annotate('', xy=(dt_entry, p_entry * 1.008),
                 xytext=(dt_entry, p_entry * 0.992),
                 arrowprops=dict(arrowstyle='->', color=color, lw=1.5), zorder=5)

    # Label: K value + pnl
    label = f"K={s['K']}\n{s['pnl_pct']:+.1f}%"
    ax1.annotate(label,
                 xy=(dt_entry, p_entry),
                 xytext=(0, -38), textcoords='offset points',
                 fontsize=6.5, color=color, ha='center',
                 bbox=dict(boxstyle='round,pad=0.2', fc='#0d1117', ec=color, alpha=0.8, lw=0.7))

    # Dashed line entry→exit
    ax1.plot([dt_entry, dt_exit], [p_entry, p_exit],
             color=color, linewidth=0.8, linestyle=':', alpha=0.5, zorder=3)
    # Exit dot
    ax1.scatter([dt_exit], [p_exit], color=color, s=25, zorder=6, alpha=0.7)

# Legend box
wr = wins/len(signals)*100 if signals else 0
total_pnl = sum(s['pnl_pct'] for s in signals)
info = f"K_1h < {THR1H} | Hold {HOLD_H}h | Cooldown {COOLDOWN_H}h\n"
info += f"n={len(signals)} signals | WR={wr:.0f}% ({wins}W/{losses}L) | ΣPnL={total_pnl:+.1f}%"
ax1.text(0.01, 0.98, info, transform=ax1.transAxes,
         fontsize=9, color='#e6edf3', va='top', ha='left',
         bbox=dict(boxstyle='round,pad=0.5', fc='#161b22', ec='#30363d', alpha=0.9))
ax1.set_title(f'BTC 2026 — StochRSI K_1h < {THR1H} Entry Points  (▲ xanh=WIN  ▲ đỏ=LOSS)',
              color='#e6edf3', fontsize=12, pad=10)

# ── StochRSI panel ──
k_valid = [(t,k) for t,k in zip(times_2026, k_2026) if k is not None]
d_valid = [(t,d) for t,d in zip(times_2026, d_2026) if d is not None]

if k_valid:
    kt, kv = zip(*k_valid)
    ax2.plot(kt, kv, color='#79c0ff', linewidth=0.9, label='K', zorder=3)
if d_valid:
    dt2, dv = zip(*d_valid)
    ax2.plot(dt2, dv, color='#f78166', linewidth=0.9, label='D', alpha=0.7, zorder=3)

ax2.axhline(THR1H, color='#f85149', linewidth=1.0, linestyle='--', alpha=0.8, label=f'K={THR1H}')
ax2.axhline(10, color='#d29922', linewidth=0.8, linestyle=':', alpha=0.6, label='K=10')
ax2.fill_between([times_2026[0], times_2026[-1]], 0, THR1H,
                  alpha=0.08, color='#f85149', zorder=0)
ax2.set_ylim(-5, 105)
ax2.set_ylabel('StochRSI K', color='#aaaaaa', fontsize=9)
ax2.legend(loc='upper right', fontsize=8, framealpha=0.7,
           facecolor='#161b22', edgecolor='#30363d', labelcolor='#aaaaaa')

# Entry lines on K panel
for s in signals:
    dt_entry = datetime.datetime.utcfromtimestamp(s['t_entry']/1000)
    color = '#3fb950' if s['win'] else '#f85149'
    ax2.axvline(dt_entry, color=color, linewidth=0.8, alpha=0.5, linestyle='-')

ax2.xaxis.set_major_formatter(mdates.DateFormatter('%b %d'))
ax2.xaxis.set_major_locator(mdates.WeekdayLocator(interval=2))
plt.xticks(rotation=30, ha='right', color='#aaaaaa')

plt.tight_layout(h_pad=0.3)
out = "/Users/lap16116/BTC_PC/btc-dashboard/tools/stoch-oversold-2026.png"
plt.savefig(out, dpi=150, bbox_inches='tight', facecolor='#0d1117')
print(f"Saved: {out}")
plt.show()
