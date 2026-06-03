#!/usr/bin/env python3
"""Loop cycle 5: robustness audit cross-asset turtle basket.
Import portfolio-roi-crossasset.py live (reuse series/stats/common). Tests:
 (1) Leave-one-out: drop mỗi asset → basket Sharpe. Nếu drop XRP/DOGE sụp → jackpot-driven.
 (2) Sub-period (theo năm): basket dương MỖI năm hay front-loaded?
 (3) Drop-best-asset floor.
Mục tiêu: ALL-7 (no-selection, honest) có robust không; CORE-3 có phải in-sample cherry-pick.
"""
import importlib.util, os, sys, math, datetime
from collections import defaultdict
P = "/Users/lap16116/BTC_PC/btc-dashboard/tools/portfolio-roi-crossasset.py"
spec = importlib.util.spec_from_file_location("xa", P)
M = importlib.util.module_from_spec(spec)
_so = sys.stdout; sys.stdout = open(os.devnull, "w"); spec.loader.exec_module(M); sys.stdout = _so

series = M.series; common = M.common; names = M.names; stats = M.stats

def basket(al, idxs=None):
    idxs = list(idxs) if idxs is not None else list(range(len(common)))
    if not idxs: return (0,0,0,0,0)
    r = [sum(series[n][i] for n in al)/len(al) for i in idxs]
    return stats(r)  # total, ann, mdd, sharpe, expo

def yr(t): return datetime.datetime.utcfromtimestamp(t/1000).year
idx_year = defaultdict(list)
for i,t in enumerate(common): idx_year[yr(t)].append(i)
years = sorted(idx_year)

print("=== Cycle 5: cross-asset basket ROBUSTNESS ===")
print(f"  common {len(common)}d, years {years} (days/năm: {[len(idx_year[y]) for y in years]})")

BASKETS = {"ALL-7": names, "ALPHA-4": ["BTC","XRP","DOGE","AVAX"], "CORE-3": ["BTC","XRP","DOGE"]}

print("\n--- (1) LEAVE-ONE-OUT (drop 1 asset, basket Sharpe) ---")
for bn, bl in BASKETS.items():
    full = basket(bl)[3]
    loos = []
    for drop in bl:
        sub = [a for a in bl if a != drop]
        if not sub: continue
        loos.append((drop, basket(sub)[3]))
    worst = min(loos, key=lambda x: x[1])
    print(f"  {bn:>8} full Sharpe {full:+.2f} | drop→ " + "  ".join(f"−{d}:{s:+.2f}" for d,s in loos))
    print(f"           → most fragile to dropping {worst[0]} (Sharpe→{worst[1]:+.2f}, Δ{worst[1]-full:+.2f})")

print("\n--- (2) SUB-PERIOD stability (basket Sharpe & ann% mỗi năm) ---")
print(f"  {'basket':>8} | " + " | ".join(f"{y}" for y in years))
for bn, bl in BASKETS.items():
    cells = []
    for y in years:
        s = basket(bl, idx_year[y])
        cells.append(f"Sh{s[3]:+.2f} {s[1]:+4.0f}%")
    print(f"  {bn:>8} | " + " | ".join(cells))
# per-asset by year too (which coin carries which year)
print("\n  per-asset ann% by year (ai gánh năm nào):")
print(f"  {'asset':>5} | " + " | ".join(f"{y:>6}" for y in years))
for n in names:
    cells = [f"{stats([series[n][i] for i in idx_year[y]])[1]:>+5.0f}%" for y in years]
    print(f"  {n:>5} | " + " | ".join(cells))

print("\n--- (3) DROP-BEST-ASSET floor ---")
for bn, bl in BASKETS.items():
    sh = {n: basket([n])[3] for n in bl}
    best = max(sh, key=sh.get)
    sub = [a for a in bl if a != best]
    print(f"  {bn:>8}: best asset {best} (Sh {sh[best]:+.2f}); WITHOUT it basket Sharpe {basket(sub)[3]:+.2f} (full {basket(bl)[3]:+.2f})")
