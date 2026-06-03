#!/usr/bin/env python3
"""Loop cycle 7: hedge01-method trên {BTC, SOL, ETH} — sub-period stability + portfolio.
Verify complementarity KHÔNG phải in-sample: mỗi asset, mỗi NỬA data có dương không?
+ corr(hedge01-BTC, hedge01-SOL) + combined portfolio Sharpe/maxDD vs hedge01-BTC-alone (cùng common window).
Structural (skip_cal=False, bỏ calendar-overfit). Honest: turtle-side (DOGE/XRP) đã chứng minh 2024-only ở cycle 5.
"""
import importlib.util, datetime, math, sys, os
from collections import defaultdict
spec = importlib.util.spec_from_file_location("Hh", "/Users/lap16116/BTC_PC/btc-dashboard/tools/loop-hedge01-crossasset.py")
Hh = importlib.util.module_from_spec(spec); spec.loader.exec_module(Hh)
run = Hh.run_hedge01

def months_between(t0, t1):
    d0 = datetime.datetime.utcfromtimestamp(t0/1000); d1 = datetime.datetime.utcfromtimestamp(t1/1000)
    out = []; y, m = d0.year, d0.month
    while (y, m) <= (d1.year, d1.month):
        out.append(f"{y}-{m:02d}")
        m += 1
        if m > 12: m = 1; y += 1
    return out
def sharpe(vals):
    if len(vals) < 2: return 0.0
    me = sum(vals)/len(vals); d = (sum((v-me)**2 for v in vals)/len(vals))**0.5 or 1e-9
    return me/d*math.sqrt(12)
def maxdd(vals):
    cum=peak=mdd=0.0
    for v in vals:
        cum+=v; peak=max(peak,cum); mdd=max(mdd,peak-cum)
    return mdd*100
def corr(a, b):
    N=len(a); ma=sum(a)/N; mb=sum(b)/N
    cov=sum((a[i]-ma)*(b[i]-mb) for i in range(N))/N
    sa=(sum((x-ma)**2 for x in a)/N)**.5; sb=(sum((x-mb)**2 for x in b)/N)**.5
    return cov/(sa*sb) if sa>0 and sb>0 else 0

ASSETS = {"BTC": f"{Hh.CC}/binance-5m-7y.json", "SOL": f"{Hh.CC}/binance-sol-5m-3y.json", "ETH": f"{Hh.CC}/binance-eth-5m-3y.json"}
print("=== Cycle 7: hedge01-method {BTC,SOL,ETH} stability + portfolio (structural) ===")
data = {}
for name, path in ASSETS.items():
    mo, yrr, trades, span = run(path, skip_cal=False)
    cal = months_between(span[0], span[1])
    ser = [mo.get(mm, 0.0) for mm in cal]
    data[name] = {"mo": mo, "cal": cal, "ser": ser, "trades": trades}

print("\n--- (1) SUB-PERIOD stability (mỗi NỬA data: ret% + Sharpe + n-active) ---")
print(f"  {'asset':>5} | {'1st-half ret% Sh nA':>22} | {'2nd-half ret% Sh nA':>22} | stable?")
for name in ASSETS:
    ser = data[name]["ser"]; h = len(ser)//2
    a, b = ser[:h], ser[h:]
    sa, sb = sum(a)*100, sum(b)*100
    na, nb = sum(1 for v in a if v!=0), sum(1 for v in b if v!=0)
    stable = "✅ both +" if sa>0 and sb>0 else ("⚠️ 1 half" if sa>0 or sb>0 else "❌ both ≤0")
    print(f"  {name:>5} | {sa:>+8.0f} Sh{sharpe(a):>+5.2f} n{na:>2} | {sb:>+8.0f} Sh{sharpe(b):>+5.2f} n{nb:>2} | {stable}")

# (2) corr + portfolio on common months (intersection of BTC & SOL & ETH ranges = SOL/ETH ~2023+)
common = sorted(set(data["BTC"]["cal"]) & set(data["SOL"]["cal"]) & set(data["ETH"]["cal"]))
print(f"\n--- (2) PORTFOLIO trên common {len(common)} tháng ({common[0]}→{common[-1]}) ---")
sB = [data["BTC"]["mo"].get(m,0.0) for m in common]
sS = [data["SOL"]["mo"].get(m,0.0) for m in common]
sE = [data["ETH"]["mo"].get(m,0.0) for m in common]
print(f"  corr(BTC,SOL)={corr(sB,sS):+.2f}  corr(BTC,ETH)={corr(sB,sE):+.2f}  corr(SOL,ETH)={corr(sS,sE):+.2f}")
def port_stats(label, series_list):
    # equal-weight raw blend (same method → same unit, fair)
    k = len(series_list)
    p = [sum(s[i] for s in series_list)/k for i in range(len(common))]
    print(f"  {label:<26} ret%{sum(p)*100:>+6.0f}  Sharpe {sharpe(p):>+5.2f}  maxDD {maxdd(p):>5.1f}%  ROI/DD {sum(p)*100/max(maxdd(p),1):>4.2f}")
print("  (cùng common window — fair compare vs BTC-alone)")
port_stats("BTC-alone", [sB])
port_stats("BTC+SOL", [sB, sS])
port_stats("BTC+SOL+ETH", [sB, sS, sE])
