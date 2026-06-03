#!/usr/bin/env python3
"""Loop cycle 9: CANONICAL calendar-basis characterization of the converged book.
Sửa lỗi cycle 8 (active-months → lạc quan). Calendar-basis: mọi tháng trong SOL-window, 0-fill flat months.
Books: BTC-alone / BTC+SOL / BTC+SOL+turtleBTC. Sharpe/DD/ROI/per-year + risk-parity check + dollar $100k illustration.
"""
import importlib.util, datetime, math, os, sys
from collections import defaultdict
def imp(name, path):
    spec = importlib.util.spec_from_file_location(name, path); M = importlib.util.module_from_spec(spec)
    so = sys.stdout; sys.stdout = open(os.devnull, "w"); spec.loader.exec_module(M); sys.stdout = so; return M
T = "/Users/lap16116/BTC_PC/btc-dashboard/tools/"
Hh = imp("Hh", T+"loop-hedge01-crossasset.py"); C = imp("C", T+"correlation-turtle-hedge01-7y.py")
run = Hh.run_hedge01; CC = Hh.CC

def mo_str(ts): return datetime.datetime.utcfromtimestamp(ts/1000).strftime("%Y-%m")
def months_between(t0,t1):
    d0=datetime.datetime.utcfromtimestamp(t0/1000); d1=datetime.datetime.utcfromtimestamp(t1/1000)
    out=[]; y,m=d0.year,d0.month
    while (y,m)<=(d1.year,d1.month):
        out.append(f"{y}-{m:02d}"); m+=1
        if m>12: m=1;y+=1
    return out
def sharpe(v):
    if len(v)<2: return 0.0
    me=sum(v)/len(v); d=(sum((x-me)**2 for x in v)/len(v))**.5 or 1e-9; return me/d*math.sqrt(12)
def maxdd(v):
    cum=peak=mdd=0.0
    for x in v: cum+=x; peak=max(peak,cum); mdd=max(mdd,peak-cum)
    return mdd*100
def sd(v):
    me=sum(v)/len(v); return (sum((x-me)**2 for x in v)/len(v))**.5 or 1e-9

moB,_,_,spanB = run(f"{CC}/binance-5m-7y.json", skip_cal=False)
moS,_,trS,spanS = run(f"{CC}/binance-sol-5m-3y.json", skip_cal=False)
turB = dict(C.tur_mo)

# CANONICAL window = SOL live span (calendar, 0-fill)
cal = months_between(spanS[0], spanS[1])
sB=[moB.get(m,0.0) for m in cal]; sS=[moS.get(m,0.0) for m in cal]; sT=[turB.get(m,0.0) for m in cal]
print(f"=== Cycle 9: CANONICAL calendar-basis ({len(cal)} months {cal[0]}→{cal[-1]}, 0-fill flat) ===")
print("  (Sửa cycle 8 active-basis. RA/Sharpe hợp lệ ở đây: book equal-weight static, size KHÔNG đổi theo win/loss → no DCA-distortion)")

def book(label, parts, weights=None):
    k=len(parts); w=weights or [1]*k; sw=sum(w)
    p=[sum(w[j]*parts[j][i] for j in range(k))/sw for i in range(len(cal))]
    yr=defaultdict(float)
    for i,m in enumerate(cal): yr[int(m[:4])]+=p[i]
    py=" ".join(f"{y%100}:{yr[y]*100:+.0f}" for y in sorted(yr))
    print(f"  {label:<30} ROI%{sum(p)*100:>+6.0f} Sh{sharpe(p):>+5.2f} DD{maxdd(p):>5.1f}% ROI/DD{sum(p)*100/max(maxdd(p),1):>5.2f} | {py}")
    return p

print("\n--- Books (equal-weight, calendar-basis) ---")
book("BTC-h01 alone", [sB])
pBS=book("BTC+SOL h01", [sB,sS])
p3=book("BTC+SOL h01 +turtle-BTC", [sB,sS,sT])
# risk-parity weights (1/sd)
wrp=[1/sd(sB),1/sd(sS),1/sd(sT)]
book("3-way RISK-PARITY", [sB,sS,sT], wrp)

print("\n--- Context: BTC-h01 alone trên FULL 7y (so window ngắn) ---")
calF=months_between(spanB[0],spanB[1]); sBf=[moB.get(m,0.0) for m in calF]
yrF=defaultdict(float)
for m in calF: yrF[int(m[:4])]+=moB.get(m,0.0)
print(f"  BTC-h01 7y: ROI%{sum(sBf)*100:+.0f} Sh{sharpe(sBf):+.2f} DD{maxdd(sBf):.1f}% | "+" ".join(f"{y%100}:{yrF[y]*100:+.0f}" for y in sorted(yrF)))

print("\n--- Dollar illustration ($100k, 1x, equal-split 3 sleeve, compound monthly) ---")
print("  ⚠️ minh hoạ: return-% (R-mult/cap-%) coi như monthly return trên capital allocated mỗi sleeve. Đơn vị mix → illustrative, KHÔNG precise.")
cap0=100000/3; eqs=[cap0,cap0,cap0]; parts=[sB,sS,sT]; tot_curve=[]
peak=tot=0
for i in range(len(cal)):
    for j in range(3): eqs[j]*=(1+parts[j][i])
    tot=sum(eqs); tot_curve.append(tot)
peakv=100000; mddv=0
for v in tot_curve:
    peakv=max(peakv,v); mddv=max(mddv,(peakv-v)/peakv*100)
print(f"  Final ${tot:,.0f} (từ $100k) = {(tot/100000-1)*100:+.0f}% over {len(cal)/12:.1f}y → ~{((tot/100000)**(12/len(cal))-1)*100:+.0f}%/yr | maxDD {mddv:.1f}%")
print(f"  vs BTC B&H same window: scale theo leverage anh dùng (1x ở đây).")
