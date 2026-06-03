#!/usr/bin/env python3
"""Bảng backtest TỪNG THÁNG của book: hedge01-BTC, hedge01-SOL, turtle-BTC, book 3-way + cumulative.
return% = R-multiple (hedge01) / capital-% (turtle). Book = equal-weight 3 sleeve.
"""
import importlib.util, datetime, math, os, sys
def imp(name, path):
    spec=importlib.util.spec_from_file_location(name,path); M=importlib.util.module_from_spec(spec)
    so=sys.stdout; sys.stdout=open(os.devnull,"w"); spec.loader.exec_module(M); sys.stdout=so; return M
Hh=imp("Hh","/Users/lap16116/BTC_PC/btc-dashboard/tools/loop-hedge01-crossasset.py"); C=imp("C","/Users/lap16116/BTC_PC/btc-dashboard/tools/correlation-turtle-hedge01-7y.py")
run=Hh.run_hedge01; CC=Hh.CC
def mb(t0,t1):
    d0=datetime.datetime.utcfromtimestamp(t0/1000); d1=datetime.datetime.utcfromtimestamp(t1/1000)
    out=[];y,m=d0.year,d0.month
    while (y,m)<=(d1.year,d1.month):
        out.append(f"{y}-{m:02d}");m+=1
        if m>12:m=1;y+=1
    return out
moB,_,_,spanS_unused=run(f"{CC}/binance-5m-7y.json",skip_cal=False)
moS,_,_,spanS=run(f"{CC}/binance-sol-5m-3y.json",skip_cal=False)
turB=dict(C.tur_mo)
cal=mb(spanS[0],spanS[1])

print("=== BACKTEST TỪNG THÁNG — book {hedge01-BTC, hedge01-SOL, turtle-BTC} ===")
print("    (số = return% tháng đó; '.'=flat/không trade; Book=trung bình 3 sleeve; Cum=cộng dồn book)\n")
print(f"  {'Tháng':>8} | {'BTC':>7} | {'SOL':>7} | {'turtle':>7} | {'BOOK':>7} | {'Cum':>7}")
print("  " + "-"*60)
cum=0.0; yr_book={}
def cell(v): return f"{v*100:+.1f}" if abs(v)>1e-9 else "   ."
for m in cal:
    b=moB.get(m,0.0); s=moS.get(m,0.0); t=turB.get(m,0.0)
    book=(b+s+t)/3; cum+=book
    yr_book.setdefault(m[:4],0.0); yr_book[m[:4]]+=book
    mark=""
    if m[5:7]=="12" or m==cal[-1]: mark="  ← hết năm" if m[5:7]=="12" else ""
    print(f"  {m:>8} | {cell(b):>7} | {cell(s):>7} | {cell(t):>7} | {book*100:>+6.1f} | {cum*100:>+6.1f}{mark}")
print("  " + "-"*60)
print(f"\n  TỔNG theo năm (book%): " + "  ".join(f"{y}:{v*100:+.0f}%" for y,v in sorted(yr_book.items())))
# stats
ser=[(moB.get(m,0)+moS.get(m,0)+turB.get(m,0))/3 for m in cal]
me=sum(ser)/len(ser); sd=(sum((x-me)**2 for x in ser)/len(ser))**.5
peak=c=mdd=0.0
for x in ser: c+=x;peak=max(peak,c);mdd=max(mdd,peak-c)
wins=sum(1 for x in ser if x>1e-9); active=sum(1 for x in ser if abs(x)>1e-9)
print(f"  {len(cal)} tháng | active {active} | tháng dương {wins}/{active} ({wins/active*100:.0f}%) | tháng âm nhất {min(ser)*100:+.1f}% | Sharpe {me/sd*math.sqrt(12):+.2f} | maxDD {mdd*100:.0f}%")
print(f"  Tổng book {cum*100:+.0f}% / {len(cal)/12:.1f}y | $100k→${100000*(1+cum):,.0f} (cộng dồn đơn giản, 1x)")
