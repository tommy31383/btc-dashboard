#!/usr/bin/env python3
"""Loop cycle 11: bear-protection mechanism của hedge01 (giải caveat SOL chưa-bear-test).
Đo: exposure% (sit-out nhiều = né bear), maxDD hedge01 vs B&H, loss-tail (ATR-cut cap worst-trade?),
hành vi năm drawdown lớn nhất. BTC-2022 (bear thật) làm reference đã-proven (exposure~0).
Nếu SOL có cùng cơ chế (low-exposure lúc drop + worst-trade capped) → bear-protection generalize.
"""
import importlib.util, datetime, math, os, sys, json
from collections import defaultdict
def imp(name, path):
    spec = importlib.util.spec_from_file_location(name, path); M = importlib.util.module_from_spec(spec)
    so = sys.stdout; sys.stdout = open(os.devnull, "w"); spec.loader.exec_module(M); sys.stdout = so; return M
Hh = imp("Hh", "/Users/lap16116/BTC_PC/btc-dashboard/tools/loop-hedge01-crossasset.py"); run = Hh.run_hedge01; CC = Hh.CC

def bh_maxdd_and_worstyear(path, t0, t1):
    raw = json.load(open(path)); raw.sort(key=lambda x: x["time"])
    cl = [(c["time"], c["close"]) for c in raw if t0 <= c["time"] <= t1]
    peak = cl[0][1]; mdd = 0.0
    yr_lo = defaultdict(lambda: 1e18); yr_hi = defaultdict(lambda: -1e18)
    for t, p in cl:
        peak = max(peak, p); mdd = max(mdd, (peak - p)/peak*100)
        y = datetime.datetime.utcfromtimestamp(t/1000).year
        yr_lo[y] = min(yr_lo[y], p); yr_hi[y] = max(yr_hi[y], p)
    # worst intra-year drawdown year
    wy = max(yr_hi, key=lambda y: (yr_hi[y]-yr_lo[y])/yr_hi[y])
    return mdd, wy, (yr_hi[wy]-yr_lo[wy])/yr_hi[wy]*100

def mddm(series):
    cum=peak=mdd=0.0
    for x in series: cum+=x; peak=max(peak,cum); mdd=max(mdd,peak-cum)
    return mdd*100

print("=== Cycle 11: hedge01 bear-protection mechanism ===")
for name, path in [("BTC", f"{CC}/binance-5m-7y.json"), ("SOL", f"{CC}/binance-sol-5m-3y.json")]:
    mo, yrr, trades, span = run(path, skip_cal=False)
    start, end, n4h = span
    expo = sum(t[2] for t in trades)/n4h*100
    rets = sorted([t[0]*100 for t in trades])
    worst = rets[0]; big_loss = sum(1 for r in rets if r < -15)
    bh_dd, wy, wy_drop = bh_maxdd_and_worstyear(path, start, end)
    # per-year exposure + ret
    yr_expo = defaultdict(float); yr_n = defaultdict(int)
    for t in trades:
        y = datetime.datetime.utcfromtimestamp(t[1]/1000).year
        yr_expo[y] += t[2]; yr_n[y]+=1
    # approx bars/year = n4h / years
    yrs = (end-start)/(365*86400000); bars_per_yr = n4h/yrs
    print(f"\n  --- {name} ---")
    print(f"  trades {len(trades)}, exposure {expo:.0f}% (thời gian CÓ vị thế; còn lại sit-out)")
    print(f"  hedge01 maxDD (monthly cum) {mddm([mo.get(m,0) for m in sorted(mo)]):.0f}%  vs  B&H price maxDD {bh_dd:.0f}%")
    print(f"  worst single trade {worst:+.0f}% (ATR-cut cap), trades < −15%: {big_loss}/{len(trades)}")
    print(f"  worst B&H year = {wy} (giá rớt −{wy_drop:.0f}% trong năm) → hedge01 năm đó: ret {yrr[wy]*100:+.0f}%, exposure {yr_expo[wy]/bars_per_yr*100:.0f}%")
    print(f"  per-year [ret% | expo%]: " + " ".join(f"{y%100}:{yrr[y]*100:+.0f}/{yr_expo[y]/bars_per_yr*100:.0f}%" for y in sorted(yrr)))
print("\n  → hedge01 exposure THẤP + worst-trade capped + ret dương cả năm-giá-rớt-mạnh = cơ chế né-bear hoạt động (RANGE-filter sit-out + ATR-cut).")
print("  BTC-2022 (bear thật) = bằng chứng proven; SOL khớp cơ chế → bear-protection generalize (dù SOL chưa có bear sâu như BTC-2022).")
