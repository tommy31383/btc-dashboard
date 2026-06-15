#!/usr/bin/env python3
"""
funding-filter-test.py — Test trường phái 3 (derivatives): funding rate làm RISK-FILTER.
Idea: funding quá cao (FOMO) -> cấm LONG né long-squeeze.

KHÁC test cũ (funding làm entry-TRIGGER = null). Lần này funding làm FILTER.

Honest-gate:
  - Filter chỉ "thắng" nếu tập entry-bị-cấm có medAlpha ÂM (entry xấu thật) +
    phần còn lại có Calmar/DD tốt hơn.
  - drop-top-20% + walk-forward (train 2019-22 / test 2023-26) + per-year.

Funding: BTC 8h. ETH dùng BTC-funding như macro proxy (báo rõ giới hạn).
"""
import json, datetime as dt, statistics as st

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/"

def load_px(f):
    d = json.load(open(CACHE+f))
    return [(b['time'], b['open'], b['high'], b['low'], b['close']) for b in d]

def load_funding():
    d = json.load(open(CACHE+"binance-funding-7y.json"))
    return [(x['time'], x['rate']) for x in d if x['rate'] is not None]

def yr(ms): return dt.datetime.utcfromtimestamp(ms/1000).year

# ---- build hourly close from 5m for return measurement ----
def hourly_from_5m(px):
    # px sorted by time, 5m bars. group to 1h close + index by hour-start ts
    out = {}  # hour_ts -> close
    seq = []
    for t,o,h,l,c in px:
        hts = (t//3600000)*3600000
        out[hts] = c  # last close in hour wins (iterate ascending)
    seq = sorted(out.items())
    return out, seq

def fwd_ret(hmap, seq, ts, hours):
    # return from close at/just-before ts to close +hours later
    hts0 = (ts//3600000)*3600000
    hts1 = hts0 + hours*3600000
    c0 = hmap.get(hts0)
    c1 = hmap.get(hts1)
    if c0 is None or c1 is None or c0<=0: return None
    return (c1-c0)/c0

def pct(vals, p):
    s = sorted(vals);
    if not s: return None
    i = int(p/100*(len(s)-1))
    return s[i]

def median(v): return st.median(v) if v else None

# =====================================================================
print("="*70)
print("PART 1: funding-extreme -> forward LONG return có tệ hơn? (long-squeeze)")
print("="*70)

px = load_px("binance-5m-7y.json")
px.sort(key=lambda x:x[0])
hmap, seq = hourly_from_5m(px)
fund = load_funding(); fund.sort(key=lambda x:x[0])
rates = [r for _,r in fund]
print(f"Funding n={len(fund)}  rate min={min(rates):.5f} max={max(rates):.5f} median={median(rates):.5f}")
for p in [50,75,90,95,99]:
    print(f"  pct{p} = {pct(rates,p):.5f}")

# forward returns of LONG entering at each funding timestamp
HORIZONS = [8, 24, 72]  # hours (~ next funding, 1d, 3d)
print("\nForward LONG return sau MỖI funding stamp, phân tầng theo ngưỡng funding:")
print("ngưỡng        | n     | medRet8h  medRet24h medRet72h")
def fmt(x): return f"{x*100:+6.2f}%" if x is not None else "  n/a "
thresholds = [("ALL", -9), ("pct90 (%.4f)"%pct(rates,90), pct(rates,90)),
              ("pct95 (%.4f)"%pct(rates,95), pct(rates,95)),
              ("pct99 (%.4f)"%pct(rates,99), pct(rates,99)),
              (">0.0003", 0.0003), (">0.0005", 0.0005), (">0.0010", 0.0010)]
for name, th in thresholds:
    sel = [(t,r) for t,r in fund if r>=th]
    row = {}
    for H in HORIZONS:
        rr = [fwd_ret(hmap,seq,t,H) for t,_ in sel]
        rr = [x for x in rr if x is not None]
        row[H] = median(rr)
    n = len([1 for t,_ in sel if fwd_ret(hmap,seq,t,8) is not None])
    print(f"{name:13s} | {n:5d} | {fmt(row[8])}  {fmt(row[24])}  {fmt(row[72])}")

# baseline: ALL funding stamps unconditional already = ALL row above
# medAlpha of "high funding" set = its medRet minus medRet of allowed (low) set
print("\nmedAlpha tập-CẤM (funding>=th) vs tập-CHO-PHÉP (funding<th), horizon 24h:")
print("ngưỡng        | n_cấm | medRet_cấm | medRet_cho | Δ(cấm-cho)  <0 = filter ĐÚNG")
for name, th in thresholds[1:]:
    cam  = [fwd_ret(hmap,seq,t,24) for t,r in fund if r>=th]
    cho  = [fwd_ret(hmap,seq,t,24) for t,r in fund if r<th]
    cam=[x for x in cam if x is not None]; cho=[x for x in cho if x is not None]
    mc, mh = median(cam), median(cho)
    d = (mc-mh) if (mc is not None and mh is not None) else None
    print(f"{name:13s} | {len(cam):5d} | {fmt(mc)}    | {fmt(mh)}   | {fmt(d)}")

# =====================================================================
print("\n"+"="*70)
print("PART 2: SHORT-after-high-funding có edge? (verify prior: short crypto 0 edge)")
print("="*70)
print("ngưỡng        | n     | medSHORTret24h | medSHORTret72h (short = -long)")
for name, th in thresholds[1:]:
    sel = [t for t,r in fund if r>=th]
    r24 = [fwd_ret(hmap,seq,t,24) for t in sel]; r24=[-x for x in r24 if x is not None]
    r72 = [fwd_ret(hmap,seq,t,72) for t in sel]; r72=[-x for x in r72 if x is not None]
    print(f"{name:13s} | {len(r24):5d} | {fmt(median(r24))}       | {fmt(median(r72))}")

# =====================================================================
print("\n"+"="*70)
print("PART 3: Áp funding-filter lên rule LONG (trend-LONG proxy) — PnL/DD/Calmar")
print("="*70)
# Proxy LONG rule: hedge01/champion đều = trend-following LONG. Mô phỏng đơn giản:
# vào LONG mỗi funding-stamp khi giá > EMA200(1d) [trend filter giống live],
# giữ 72h, $100k equal-frac. So có/không funding-filter cấm khi funding>=th.

# build daily EMA200 on close
def daily_ema200(px):
    days={}
    for t,o,h,l,c in px:
        d=(t//86400000)*86400000; days[d]=c
    ds=sorted(days.items())
    ema=None; k=2/(200+1); out={}
    for d,c in ds:
        ema = c if ema is None else c*k+ema*(1-k)
        out[d]=ema
    return out
ema=daily_ema200(px)
def above_ema(ts):
    d=(ts//86400000)*86400000
    e=ema.get(d)
    c0=hmap.get((ts//3600000)*3600000)
    return e is not None and c0 is not None and c0>e

def run_book(filter_th=None):
    # returns list of (year, pnl_pct) per trade + equity curve
    trades=[]
    for t,r in fund:
        if not above_ema(t): continue          # trend gate (LONG only in uptrend)
        if filter_th is not None and r>=filter_th: continue  # funding filter
        ret = fwd_ret(hmap,seq,t,72)
        if ret is None: continue
        trades.append((yr(t), ret, r))
    return trades

def equity_stats(trades):
    # equal-frac 2% risk-free compounding via per-trade ret * frac; use frac=1 sequential
    eq=100000.0; peak=eq; maxdd=0; curve=[]
    for _,ret,_ in trades:
        eq*= (1+ret*0.25)  # 25% allocation per concurrent-ish trade to tame
        peak=max(peak,eq); dd=(peak-eq)/peak; maxdd=max(maxdd,dd); curve.append(eq)
    total=(eq-100000)/100000
    cagr=(eq/100000)**(1/7)-1
    calmar=cagr/maxdd if maxdd>0 else float('inf')
    return total, maxdd, cagr, calmar, eq

print("\nVariant         | n_trades | totalRet | maxDD  | CAGR   | Calmar")
base=run_book(None)
tb=equity_stats(base)
print(f"NO-FILTER       | {len(base):8d} | {tb[0]*100:+7.1f}% | {tb[1]*100:5.1f}% | {tb[2]*100:+5.1f}% | {tb[3]:.2f}")
for name, th in [("pct90",pct(rates,90)),("pct95",pct(rates,95)),("pct99",pct(rates,99)),
                 (">0.0003",0.0003),(">0.0005",0.0005),(">0.0010",0.0010)]:
    tr=run_book(th); s=equity_stats(tr)
    print(f"filter {name:8s} | {len(tr):8d} | {s[0]*100:+7.1f}% | {s[1]*100:5.1f}% | {s[2]*100:+5.1f}% | {s[3]:.2f}")

# medAlpha of the entries REMOVED by each filter
print("\nmedAlpha tập entry-BỊ-CẤM bởi filter (trong trend-LONG, 72h ret):")
print("ngưỡng   | n_cấm | medRet_cấm | medRet_giữ | verdict")
allset=run_book(None)
for name, th in [("pct90",pct(rates,90)),("pct95",pct(rates,95)),("pct99",pct(rates,99)),
                 (">0.0005",0.0005),(">0.0010",0.0010)]:
    cam=[ret for y,ret,r in allset if r>=th]
    keep=[ret for y,ret,r in allset if r<th]
    mc,mk=median(cam),median(keep)
    v="filter ĐÚNG (cấm xấu)" if (mc is not None and mk is not None and mc<mk) else "filter SAI (cấm tốt)"
    print(f"{name:8s} | {len(cam):5d} | {fmt(mc)}    | {fmt(mk)}    | {v}")

# =====================================================================
print("\n"+"="*70)
print("PART 4: drop-top-20% (bỏ 20% trade lời nhất) — beta hay edge?")
print("="*70)
print("Variant     | totalRet full | totalRet drop-top20% | còn dương?")
def droptop(trades):
    rets=sorted([ret for _,ret,_ in trades], reverse=True)
    cut=int(len(rets)*0.2)
    kept=rets[cut:]
    eq=100000.0
    for ret in kept: eq*=(1+ret*0.25)
    return (eq-100000)/100000
for name, th in [("NO-FILTER",None),("pct95",pct(rates,95)),(">0.0005",0.0005)]:
    tr=run_book(th)
    full=equity_stats(tr)[0]
    dt20=droptop(tr)
    print(f"{name:11s} | {full*100:+8.1f}%    | {dt20*100:+8.1f}%          | {'CÓ' if dt20>0 else 'KHÔNG'}")

# =====================================================================
print("\n"+"="*70)
print("PART 5: WALK-FORWARD (train 2019-2022 chọn ngưỡng / test 2023-2026)")
print("="*70)
allset=run_book(None)
def stats_subset(trades):
    if not trades: return (0,0,0)
    eq=100000.0; peak=eq; maxdd=0
    for _,ret,_ in trades:
        eq*=(1+ret*0.25); peak=max(peak,eq); maxdd=max(maxdd,(peak-eq)/peak)
    return ((eq-100000)/100000, maxdd, (((eq/100000)**(1/4)-1)/maxdd if maxdd>0 else float('inf')))
train=[(y,ret,r) for y,ret,r in allset if y<=2022]
test =[(y,ret,r) for y,ret,r in allset if y>=2023]
print("TRAIN 2019-22: chọn ngưỡng tối ưu Calmar")
best=None
for name, th in [("NONE",None),("pct90",pct(rates,90)),("pct95",pct(rates,95)),
                 (">0.0005",0.0005),(">0.0010",0.0010)]:
    sub=[x for x in train if (th is None or x[2]<th)]
    s=stats_subset(sub)
    print(f"  {name:8s}: ret {s[0]*100:+6.1f}% dd {s[1]*100:4.1f}% calmar {s[2]:.2f}")
    if best is None or s[2]>best[1]: best=(name,s[2],th)
print(f"  => TRAIN best = {best[0]}")
print("TEST 2023-26 áp ngưỡng train-best vs NO-FILTER:")
for label, th in [("NO-FILTER",None),(f"train-best({best[0]})",best[2])]:
    sub=[x for x in test if (th is None or x[2]<th)]
    s=stats_subset(sub)
    print(f"  {label:20s}: ret {s[0]*100:+6.1f}% dd {s[1]*100:4.1f}% calmar {s[2]:.2f}")

# =====================================================================
print("\n"+"="*70)
print("PART 6: PER-YEAR (NO-FILTER vs filter pct95) totalRet")
print("="*70)
allset=run_book(None)
years=sorted(set(y for y,_,_ in allset))
th95=pct(rates,95)
print("year | n | ret NO-FILTER | n | ret filter-pct95")
for y in years:
    a=[ret for yy,ret,r in allset if yy==y]
    f=[ret for yy,ret,r in allset if yy==y and r<th95]
    ea=100000.0
    for ret in a: ea*=(1+ret*0.25)
    ef=100000.0
    for ret in f: ef*=(1+ret*0.25)
    print(f"{y} | {len(a):4d} | {(ea/100000-1)*100:+7.1f}% | {len(f):4d} | {(ef/100000-1)*100:+7.1f}%")

print("\nDONE.")
