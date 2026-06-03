#!/usr/bin/env python3
"""Loop cycle 16: fee/slippage sensitivity (deployment-readiness).
Backtest dùng FEE 0.05% (RT 0.10%). SOL kém thanh khoản → slippage thật cao hơn.
Monkeypatch H.FEE = 0.05/0.10/0.20/0.30% → đo hedge01-BTC, hedge01-SOL, book ret%/Sharpe.
Book sống nếu Sharpe/ret còn dương ở fee thực tế (0.10-0.20% reasonable cho alt market-order).
"""
import importlib.util, datetime, math, os, sys
def imp(name, path):
    spec=importlib.util.spec_from_file_location(name,path); M=importlib.util.module_from_spec(spec)
    so=sys.stdout; sys.stdout=open(os.devnull,"w"); spec.loader.exec_module(M); sys.stdout=so; return M
Hh=imp("Hh","/Users/lap16116/BTC_PC/btc-dashboard/tools/loop-hedge01-crossasset.py"); H=Hh.H; run=Hh.run_hedge01; CC=Hh.CC
def mb(t0,t1):
    d0=datetime.datetime.utcfromtimestamp(t0/1000); d1=datetime.datetime.utcfromtimestamp(t1/1000)
    out=[];y,m=d0.year,d0.month
    while (y,m)<=(d1.year,d1.month):
        out.append(f"{y}-{m:02d}");m+=1
        if m>12:m=1;y+=1
    return out
def sh(v):
    if len(v)<2: return 0.0
    me=sum(v)/len(v);d=(sum((x-me)**2 for x in v)/len(v))**.5 or 1e-9;return me/d*math.sqrt(12)
def mdd(v):
    cum=peak=m=0.0
    for x in v: cum+=x;peak=max(peak,cum);m=max(m,peak-cum)
    return m*100
cal=mb(1688169600000,1748736000000)
BTC=f"{CC}/binance-5m-7y.json"; SOL=f"{CC}/binance-sol-5m-3y.json"
DEF=Hh.FEE  # sim() đọc module-global Hh.FEE (capture từ H.FEE lúc import), KHÔNG phải H.FEE
print("=== Cycle 16: fee/slippage sensitivity (hedge01 sleeves) ===")
print(f"  {'fee/side':>8} (RT) | {'BTC ret%/Sh':>14} | {'SOL ret%/Sh':>14} | {'BTC+SOL book ret%/Sh/DD':>22}")
for fee in [0.0005, 0.001, 0.002, 0.003]:
    Hh.FEE = fee
    moB,_,trB,_ = run(BTC, skip_cal=False); moS,_,trS,_ = run(SOL, skip_cal=False)
    sB=[moB.get(m,0.0) for m in cal]; sS=[moS.get(m,0.0) for m in cal]
    book=[(sB[i]+sS[i])/2 for i in range(len(cal))]
    rB=sum(t[0] for t in trB)*100; rS=sum(t[0] for t in trS)*100
    print(f"  {fee*100:>5.2f}% ({fee*200:.1f}%) | {rB:>+7.0f}/{sh(sB):>+4.1f} | {rS:>+7.0f}/{sh(sS):>+4.1f} | {sum(book)*100:>+7.0f}/{sh(book):>+4.1f}/{mdd(book):>4.0f}%")
Hh.FEE = DEF
print("\n  → fee thực tế alt market-order ~0.10-0.20%/side (RT 0.2-0.4%). Book sống nếu vẫn dương ở mức đó.")
print("  hedge01 selective (BTC ~20/yr, SOL ~13/yr) nên fee-drag thấp; turtle daily càng ít. Per-trade avg lớn (SOL +5.6%) >> cost.")
