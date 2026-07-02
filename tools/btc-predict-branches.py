#!/usr/bin/env python3
"""
btc-predict-branches.py — analyze the 15 analog "branches" behind btc-predict.
Median of opposing analogs hides bimodality. This: clusters up/down branches, measures the
divergence the median masks, and tests whether any entry feature DISCRIMINATES the branch
(honest: probably not, base-rate null). Faithful to btc_predict daily aggregation + hist_index.
"""
import json, os, sys, statistics, urllib.request
sys.path.insert(0, os.path.expanduser("~/.claude/skills/btc-predict"))
from btc_predict import aggregate  # exact same daily bucketing

CACHE = os.path.expanduser("~/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json")
RES = json.load(open("/tmp/btc_predict_result.json"))
raw = json.load(open(CACHE))
d1h = aggregate(raw, 24)               # [ts,o,h,l,c,v] per day
cur = RES["cur_close"]
matches = RES["matches"]

def fwd(i, d):
    fi = i + d
    return (d1h[fi][4] / d1h[i][4] - 1) * 100 if fi < len(d1h) else None

# per-analog forward outcomes
for m in matches:
    i = m["hist_index"]
    for d in (7, 14, 30):
        m[f"d{d}"] = fwd(i, d)

print("=== ALL 15 ANALOG BRANCHES (forward % from match day) ===")
print(" date       | event                  | drop | rsi | stochK | +7D    | +14D   | +30D")
for m in sorted(matches, key=lambda x: x.get("d30") or -999):
    print(f" {m['date']} | {m.get('event','')[:22]:<22} | {m['drop']:>4.0f} | {m['rsi']:>3.0f} | {m['stoch_k']:>5.0f} | "
          f"{(m['d7'] or 0):>+5.1f}% | {(m['d14'] or 0):>+5.1f}% | {(m['d30'] or 0):>+5.1f}%")

# ── BRANCH split by +30D ──
up = [m for m in matches if (m.get("d30") or 0) > 2]
dn = [m for m in matches if (m.get("d30") or 0) < -2]
flat = [m for m in matches if -2 <= (m.get("d30") or 0) <= 2]
def med(a, k):
    v = [x[k] for x in a if x.get(k) is not None]
    return statistics.median(v) if v else 0

print(f"\n=== BRANCH SPLIT @ +30D (>{2}% up / <-2% down) ===")
for name, grp in [("🟢 UP", up), ("⚪ FLAT", flat), ("🔴 DOWN", dn)]:
    if not grp: continue
    print(f"{name:<9} n={len(grp):>2} ({len(grp)/len(matches)*100:.0f}%)  median +7D {med(grp,'d7'):+.1f}%  +14D {med(grp,'d14'):+.1f}%  +30D {med(grp,'d30'):+.1f}%")

# divergence the median masks
d30s = [m["d30"] for m in matches if m.get("d30") is not None]
print(f"\n=== ĐỘ PHÂN KỲ +30D (median che giấu) ===")
print(f"  median {statistics.median(d30s):+.1f}%  |  range {min(d30s):+.1f}% → {max(d30s):+.1f}%  |  spread {max(d30s)-min(d30s):.0f}pp  |  stdev {statistics.pstdev(d30s):.1f}pp")
print(f"  → {len(up)}/{len(matches)} lên, {len(dn)}/{len(matches)} xuống → đây là COIN-FLIP, không phải '+3% median'")

# ── DISCRIMINATION TEST: do up vs down branches differ on entry features? ──
print(f"\n=== DISCRIMINATION: feature nào phân biệt nhánh UP vs DOWN? ===")
# current setup
def fetch_daily(limit=90):
    u = f"https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1d&limit={limit}"
    return [[float(x[4]), float(x[2]), float(x[3])] for x in json.loads(urllib.request.urlopen(u).read())]
def rsi(cl, p=14):
    if len(cl) <= p: return None
    d=[cl[i]-cl[i-1] for i in range(1,len(cl))]; ag=sum(max(x,0) for x in d[:p])/p; al=sum(max(-x,0) for x in d[:p])/p
    for x in d[p:]: ag=(ag*(p-1)+max(x,0))/p; al=(al*(p-1)+max(-x,0))/p
    return 100-100/(1+ag/al) if al else 100.0
try:
    liveC = [r[0] for r in fetch_daily()]; cur_rsi = rsi(liveC)
except Exception:
    cur_rsi = None  # local fetch blocked; discrimination still shows separability
cur_feat = {"drop": RES["drop_from_peak"], "rsi": cur_rsi, "pos": RES["pos_in_range"], "stoch_k": None}
print(f"  CURRENT: drop {cur_feat['drop']:+.1f}%  rsi {('%.0f'%cur_rsi) if cur_rsi else 'n/a'}  pos {cur_feat['pos']:.0f}%")
print(f"  {'feature':<8} | UP median | DOWN median | tách được? | current nghiêng")
for k in ("drop", "rsi", "pos", "stoch_k"):
    u_v = [m[k] for m in up if m.get(k) is not None]; d_v = [m[k] for m in dn if m.get(k) is not None]
    if not u_v or not d_v: continue
    um, dm = statistics.median(u_v), statistics.median(d_v)
    sep = abs(um - dm)
    cv = cur_feat.get(k)
    lean = "?" if cv is None else ("UP" if abs(cv-um) < abs(cv-dm) else "DOWN")
    # overlap check: ranges overlap = không tách được
    u_lo,u_hi = min(u_v),max(u_v); d_lo,d_hi = min(d_v),max(d_v)
    overlap = not (u_hi < d_lo or d_hi < u_lo)
    print(f"  {k:<8} | {um:>9.1f} | {dm:>11.1f} | {'KHÔNG (overlap)' if overlap else 'CÓ':<14} | {lean}")
