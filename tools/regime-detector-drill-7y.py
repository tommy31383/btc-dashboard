#!/usr/bin/env python3
"""
regime-detector-drill-7y.py — khảo cổ định lượng 3 con quái vật cho v0.5.0 Regime-Detector.
volOfVol_20, volRegimeShift, hurst_rs_30 — per-year spread forward-return (top-q vs bot-q) +
consistency, KHÔNG phải entry. + volRegimeShift>p90 → forward-DD (cứu mạng volScale). + hurst
H>0.65 vs H<0.35 spread per-year. Chỉ phân tích, KHÔNG đổi env live.
"""
import json, math, statistics as st, datetime as dt
from collections import defaultdict

def agg(b5, h=24):
    out = []; span = h*3600*1000; cur = None
    for b in b5:
        bk = (b["time"]//span)*span
        if cur is None or bk != cur["time"]:
            if cur: out.append(cur)
            cur = dict(time=bk, open=b["open"], high=b["high"], low=b["low"], close=b["close"], vol=b.get("volume", 0))
        else:
            cur["high"] = max(cur["high"], b["high"]); cur["low"] = min(cur["low"], b["low"]); cur["close"] = b["close"]; cur["vol"] += b.get("volume", 0)
    if cur: out.append(cur)
    return out

D = agg(json.load(open(".cache/binance-5m-7y.json")))
n = len(D); C = [b["close"] for b in D]; Hh = [b["high"] for b in D]; Ll = [b["low"] for b in D]
ret = [0.0] + [C[i]/C[i-1]-1 for i in range(1, n)]
def yr(i): return dt.datetime.utcfromtimestamp(D[i]["time"]/1000).year

def r2(seg):
    m = len(seg); xs = list(range(m)); mx = sum(xs)/m; my = sum(seg)/m
    sxx = sum((x-mx)**2 for x in xs) or 1; syy = sum((y-my)**2 for y in seg) or 1e-12
    sxy = sum((xs[k]-mx)*(seg[k]-my) for k in range(m))
    return sxy*sxy/(sxx*syy)

# ── 3 indicator (faithful copy từ novel-indicators-screen.py) ──
def volOfVol_20(i): return st.pstdev([abs(ret[j]) for j in range(i-19, i+1)])
def volRegimeShift(i): return (sum(abs(ret[j]) for j in range(i-9, i+1))/10)/((sum(abs(ret[j]) for j in range(i-49, i-9))/40) or 1e-9)
def hurst_rs_30(i):
    seg = [math.log(C[j]/C[j-1]) for j in range(i-29, i+1)]
    mean = sum(seg)/len(seg); dev = [x-mean for x in seg]
    cum = []; s = 0
    for x in dev: s += x; cum.append(s)
    R = (max(cum) or 1e-9) - (min(cum) or 0)
    S = st.pstdev(seg) or 1e-9
    return math.log((R/S) + 1e-9) / math.log(30)   # H ≈ log(R/S)/log(n)

IND = {"volOfVol_20": (volOfVol_20, 25), "volRegimeShift": (volRegimeShift, 55), "hurst_rs_30": (hurst_rs_30, 35)}
FWD = 5
def fwd(i): return C[i+FWD]/C[i]-1 if i+FWD < n else None
def fwd_dd(i, h=20):   # forward max drawdown trong h ngày tới (peak-to-trough từ close i)
    if i+h >= n: return None
    peak = C[i]; mdd = 0
    for k in range(i+1, i+h+1):
        if C[k] > peak: peak = C[k]
        dd = (peak - Ll[k]) / peak
        if dd > mdd: mdd = dd
    return mdd

print("="*78)
print("REGIME-DETECTOR DRILL 7y — forward-5d spread (top-quintile − bottom-quintile)")
print("="*78)
for name, (fn, w0) in IND.items():
    arr = [None]*n
    for i in range(w0, n):
        try:
            v = fn(i); arr[i] = v if math.isfinite(v) else None
        except: arr[i] = None
    pairs = [(arr[i], fwd(i), yr(i)) for i in range(60, n-FWD) if arr[i] is not None and fwd(i) is not None]
    pairs.sort(key=lambda x: x[0]); q = len(pairs)//5
    bot, top = pairs[:q], pairs[-q:]
    sb = sum(p[1] for p in bot)/len(bot)*100; stp = sum(p[1] for p in top)/len(top)*100
    print(f"\n── {name}  (n={len(pairs)}, top/bot quintile threshold)")
    print(f"   AGG: topRet {stp:+.2f}% · botRet {sb:+.2f}% · spread {stp-sb:+.2f}%")
    yb = defaultdict(list); yt = defaultdict(list)
    for v, f, y in bot: yb[y].append(f)
    for v, f, y in top: yt[y].append(f)
    yrs = sorted(set(yb) & set(yt))
    print(f"   {'year':>6} | {'topRet%':>8} | {'botRet%':>8} | {'spread%':>8} | dấu")
    same = 0
    for y in yrs:
        if not (yb[y] and yt[y]): continue
        t = sum(yt[y])/len(yt[y])*100; b = sum(yb[y])/len(yb[y])*100; sp = t-b
        if (sp > 0) == (stp-sb > 0): same += 1
        print(f"   {y:>6} | {t:>+8.2f} | {b:>+8.2f} | {sp:>+8.2f} | {'✓' if (sp>0)==(stp-sb>0) else '✗ ĐỔI MÀU'}")
    print(f"   → consistency {same}/{len(yrs)} năm cùng dấu (phai mòn nếu nhiều ✗)")

# ── volRegimeShift > p90 → forward DD (cứu mạng volScale) ──
print("\n" + "="*78)
print("volRegimeShift > p90 → FORWARD 20d MAX-DRAWDOWN (gốc của volScale bóp size)")
print("="*78)
arr = [None]*n
for i in range(55, n):
    try: arr[i] = volRegimeShift(i)
    except: arr[i] = None
vals = sorted(v for v in arr if v is not None)
p90 = vals[int(len(vals)*0.90)]; p50 = vals[int(len(vals)*0.50)]
print(f"p50={p50:.2f} · p90={p90:.2f}  (vol10d/vol40d ratio)")
hi_dd = [fwd_dd(i) for i in range(55, n-20) if arr[i] is not None and arr[i] >= p90 and fwd_dd(i) is not None]
lo_dd = [fwd_dd(i) for i in range(55, n-20) if arr[i] is not None and arr[i] < p50 and fwd_dd(i) is not None]
print(f"  Khi >p90 (panic regime): forward-20d maxDD median {st.median(hi_dd)*100:.1f}% · mean {sum(hi_dd)/len(hi_dd)*100:.1f}% · p90 {sorted(hi_dd)[int(len(hi_dd)*0.9)]*100:.1f}% (n={len(hi_dd)})")
print(f"  Khi <p50 (calm regime) : forward-20d maxDD median {st.median(lo_dd)*100:.1f}% · mean {sum(lo_dd)/len(lo_dd)*100:.1f}% (n={len(lo_dd)})")
print(f"  → Panic regime DD median GẤP {st.median(hi_dd)/max(st.median(lo_dd),1e-9):.1f}× calm → volScale bóp size lúc này = cứu mạng.")

# ── hurst H>0.65 vs H<0.35 forward-5d (trend-persist vs mean-revert) ──
print("\n" + "="*78)
print("hurst_rs_30: H>0.65 (trend-persist) vs H<0.35 (mean-revert) → forward-5d return")
print("="*78)
arr = [None]*n
for i in range(35, n):
    try: arr[i] = hurst_rs_30(i)
    except: arr[i] = None
hp = defaultdict(list); hm = defaultdict(list)
for i in range(35, n-FWD):
    if arr[i] is None or fwd(i) is None: continue
    if arr[i] > 0.65: hp[yr(i)].append(fwd(i))
    elif arr[i] < 0.35: hm[yr(i)].append(fwd(i))
print(f"   {'year':>6} | {'H>0.65 ret%':>11} (n) | {'H<0.35 ret%':>11} (n)")
for y in sorted(set(hp)|set(hm)):
    a = sum(hp[y])/len(hp[y])*100 if hp[y] else 0
    b = sum(hm[y])/len(hm[y])*100 if hm[y] else 0
    print(f"   {y:>6} | {a:>+8.2f} ({len(hp[y]):>4}) | {b:>+8.2f} ({len(hm[y]):>4})")
