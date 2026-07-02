#!/usr/bin/env python3
"""
btc-match-quality.py — improve analog matching: magnitude-anchored PATH distance + match-quality %.
Compares CURRENT method (drop+pos gate, shape=soft bonus) vs IMPROVED (path RMSE primary, mag-aware).
Path = close % from window-start → RMSE captures BOTH shape AND magnitude (−18% crash ≠ −4% drift).
"""
import os, sys, json, math, statistics
sys.path.insert(0, os.path.expanduser("~/.claude/skills/btc-predict"))
from btc_predict import (aggregate, fetch_binance, parse_kline, ema, rsi_val, atr_val,
                         pearson_corr, LOOK_BACK, LOOK_FWD, CACHE_PATH)

raw = json.load(open(CACHE_PATH))
hist = aggregate(raw, 24)                       # [ts,o,h,l,c,v]
live = [parse_kline(k) for k in fetch_binance('1d', 90)]
W = LOOK_BACK
cur = live[-W-1:]                               # W+1 closes → W steps; anchor c[0]
curC = [b[4] for b in cur]
cur_path = [(c / curC[0] - 1) * 100 for c in curC]      # % from window start
cur_drop = (curC[-1] - max(b[2] for b in live[-W:])) / max(b[2] for b in live[-W:]) * 100
cur_atrpct = (atr_val(cur, 14) or 1) / curC[-1] * 100   # cur = 15 bar (W+1) → ATR14 valid, khớp hist win
print(f"CURRENT: close=${curC[-1]:,.0f}  14D drop={cur_drop:+.1f}%  ATR%={cur_atrpct:.2f}  path∈[{min(cur_path):+.1f},{max(cur_path):+.1f}]%")

def quality(rmse):       # 0-100; rmse in pp. ~2pp→78%, 5pp→43%, 10pp→19%
    return round(100 * math.exp(-rmse / 8), 1)

rows = []
for i in range(W, len(hist) - LOOK_FWD - 1):
    win = hist[i - W:i + 1]
    wc = [b[4] for b in win]
    path = [(c / wc[0] - 1) * 100 for c in wc]
    rmse = math.sqrt(sum((a - b) ** 2 for a, b in zip(cur_path, path)) / len(path))
    drop = (wc[-1] - max(b[2] for b in win[1:])) / max(b[2] for b in win[1:]) * 100
    atrpct = (atr_val(win, 14) or 1) / wc[-1] * 100
    corr = pearson_corr([cur_path[j]-cur_path[j-1] for j in range(1,len(cur_path))],
                        [path[j]-path[j-1] for j in range(1,len(path))])
    d30 = round((hist[i+30][4]/wc[-1]-1)*100,1) if i+30 < len(hist) else None
    from datetime import datetime, timezone
    dt = datetime.fromtimestamp(hist[i][0]/1000, tz=timezone.utc).strftime('%Y-%m-%d')
    rows.append({'i':i,'date':dt,'drop':round(drop,1),'atrpct':round(atrpct,2),'rmse':round(rmse,2),
                 'q':quality(rmse),'corr':round(corr,2),'d30':d30})

# IMPROVED: magnitude gate (drop within 6pp + ATR-vol ratio 0.5-2.0x) then rank by path RMSE
gated = [r for r in rows if abs(r['drop']-cur_drop)<=6 and 0.5 <= r['atrpct']/cur_atrpct <= 2.0]
# dedup 14d
def dedup(sorted_rows):
    out=[]
    for r in sorted_rows:
        if not any(abs(r['i']-p['i'])<14 for p in out): out.append(r)
        if len(out)>=15: break
    return out
improved = dedup(sorted(gated, key=lambda r:r['rmse']))

print(f"\n=== IMPROVED matching (mag-anchored path RMSE) — {len(gated)} qua gate → top 15 ===")
print(" date       | drop  | ATR% | RMSE | match% | shapeCorr | +30D")
for r in improved:
    print(f" {r['date']} | {r['drop']:>+5.1f} | {r['atrpct']:>4.2f} | {r['rmse']:>4.1f} | {r['q']:>5.1f}% | {r['corr']:>+5.2f} | {('%+.1f%%'%r['d30']) if r['d30'] is not None else '—'}")
print(f"  → avg match quality: {statistics.mean(r['q'] for r in improved):.0f}%  | avg RMSE {statistics.mean(r['rmse'] for r in improved):.1f}pp")

# CURRENT method matches (from last btc_predict run) — score their REAL path quality
try:
    cm = json.load(open("/tmp/btc_predict_result.json"))['matches']
    byi = {r['i']: r for r in rows}
    cur_q = [byi[m['hist_index']]['q'] for m in cm if m['hist_index'] in byi]
    cur_r = [byi[m['hist_index']]['rmse'] for m in cm if m['hist_index'] in byi]
    print(f"\n=== CURRENT method's 15 matches — đo lại bằng path RMSE thật ===")
    print(f"  avg match quality: {statistics.mean(cur_q):.0f}%  | avg RMSE {statistics.mean(cur_r):.1f}pp  (cao hơn = match LỎNG hơn)")
    over = set(m['hist_index'] for m in cm) & set(r['i'] for r in improved)
    print(f"  overlap với IMPROVED: {len(over)}/15 case")
except Exception as e:
    print("  (no current result to compare:", e, ")")
