#!/usr/bin/env python3
"""
hurst-crossasset-walkforward.py — phong vương hay xử trảm hurst_rs_30 làm Trend-Quality Gate v0.5.0.
1) CROSS-ASSET: quintile spread forward-5d (top − bot) + consistency per-year trên BTC/ETH/SOL.
   Nếu ETH/SOL đảo màu liên tục (consist<5/8) → overfit BTC → DẸP.
2) WALK-FORWARD: ngưỡng p20/p80 của Hurst theo từng năm độc lập — lệch nhiều = non-stationary nguy.
Data: BTC 7y, ETH 7y, SOL 3y (honest: SOL cửa sổ ngắn). KHÔNG đụng env live.
"""
import json, math, statistics as st, datetime as dt
from collections import defaultdict

FWD = 5
def agg(b5, h=24):
    out = []; span = h*3600*1000; cur = None
    for b in b5:
        bk = (b["time"]//span)*span
        if cur is None or bk != cur["time"]:
            if cur: out.append(cur)
            cur = dict(time=bk, close=b["close"])
        else: cur["close"] = b["close"]
    if cur: out.append(cur)
    return out

def hurst_series(C):
    n = len(C); out = [None]*n
    ret = [0.0]+[math.log(C[i]/C[i-1]) for i in range(1, n)]
    for i in range(35, n):
        seg = ret[i-29:i+1]
        mean = sum(seg)/len(seg); dev = [x-mean for x in seg]
        cum = []; s = 0
        for x in dev: s += x; cum.append(s)
        R = (max(cum) or 1e-9)-(min(cum) or 0); S = st.pstdev(seg) or 1e-9
        out[i] = math.log((R/S)+1e-9)/math.log(30)
    return out

def analyze(path, label):
    D = agg(json.load(open(path))); n = len(D); C = [b["close"] for b in D]
    yr = lambda i: dt.datetime.utcfromtimestamp(D[i]["time"]/1000).year
    fwd = lambda i: C[i+FWD]/C[i]-1 if i+FWD < n else None
    H = hurst_series(C)
    pairs = [(H[i], fwd(i), yr(i)) for i in range(40, n-FWD) if H[i] is not None and fwd(i) is not None]
    pairs.sort(key=lambda x: x[0]); q = len(pairs)//5
    bot, top = pairs[:q], pairs[-q:]
    sb = sum(p[1] for p in bot)/len(bot)*100; stp = sum(p[1] for p in top)/len(top)*100
    yb = defaultdict(list); yt = defaultdict(list)
    for v, f, y in bot: yb[y].append(f)
    for v, f, y in top: yt[y].append(f)
    yrs = sorted(set(yb) & set(yt))
    peryr = {}
    same = 0
    for y in yrs:
        if not (yb[y] and yt[y]): continue
        spy = sum(yt[y])/len(yt[y])*100 - sum(yb[y])/len(yb[y])*100
        peryr[y] = spy
        if (spy > 0) == (stp-sb > 0): same += 1
    # walk-forward: p20/p80 theo từng năm độc lập
    by_year_vals = defaultdict(list)
    for i in range(40, n-FWD):
        if H[i] is not None: by_year_vals[yr(i)].append(H[i])
    thr = {}
    for y, vs in by_year_vals.items():
        vs.sort(); thr[y] = (vs[int(len(vs)*0.2)], vs[int(len(vs)*0.8)])
    return dict(label=label, n=len(pairs), agg_spread=stp-sb, topRet=stp, botRet=sb,
                consist=f"{same}/{len(yrs)}", peryr=peryr, thr=thr, yrs=yrs)

ASSETS = [(".cache/binance-5m-7y.json", "BTC(7y)"),
          (".cache/binance-eth-5m-7y.json", "ETH(7y)"),
          (".cache/binance-sol-5m-3y.json", "SOL(3y)")]

print("="*82)
print("HURST_RS_30 CROSS-ASSET — forward-5d quintile spread (top trend-sạch − bot chợ-nát)")
print("="*82)
results = []
for path, lab in ASSETS:
    try: r = analyze(path, lab); results.append(r)
    except Exception as e: print(f"  {lab}: LỖI {e}"); continue

allyrs = sorted(set().union(*[set(r["peryr"]) for r in results]))
print(f"\n{'asset':>8} | {'aggSpread':>9} | {'consist':>8} | per-year spread%")
for r in results:
    cells = " ".join(f"{y%100:02d}:{r['peryr'].get(y,0):+.1f}" for y in allyrs if y in r['peryr'])
    print(f"{r['label']:>8} | {r['agg_spread']:>+8.2f}% | {r['consist']:>8} | {cells}")

print("\n--- VERDICT cross-asset ---")
btc = next(r for r in results if r['label'].startswith('BTC'))
for r in results:
    same_btc = sum(1 for y in r['peryr'] if y in btc['peryr'] and (r['peryr'][y]>0)==(btc['peryr'][y]>0))
    tot = sum(1 for y in r['peryr'] if y in btc['peryr'])
    print(f"  {r['label']}: aggSpread {r['agg_spread']:+.2f}% consist {r['consist']} · đồng-màu-với-BTC {same_btc}/{tot}")

print("\n" + "="*82)
print("WALK-FORWARD: ngưỡng Hurst p20/p80 theo từng năm (non-stationary nếu lệch nhiều)")
print("="*82)
for r in results:
    print(f"\n{r['label']}:  year | p20(chợ-nát) | p80(trend-sạch)")
    p20s = []; p80s = []
    for y in sorted(r['thr']):
        a, b = r['thr'][y]; p20s.append(a); p80s.append(b)
        print(f"   {y} |  {a:.3f}  |  {b:.3f}")
    print(f"   → p20 range [{min(p20s):.3f},{max(p20s):.3f}] spread {max(p20s)-min(p20s):.3f} · "
          f"p80 range [{min(p80s):.3f},{max(p80s):.3f}] spread {max(p80s)-min(p80s):.3f}")
