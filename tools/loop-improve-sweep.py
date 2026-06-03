#!/usr/bin/env python3
"""Loop cycle 13: marginal improvement sweep — quyết bằng OOS (half-2), KHÔNG in-sample.
Candidates: +AVAX, +ETH, ETH-thay-turtle, 4-asset, turtle-weight. Kill-criteria:
"improve" CHỈ KHI h2-Sharpe > current 3-way +0.10 VÀ h2-DD không tệ hơn. Else → book hiện tại là TRẦN.
"""
import importlib.util, datetime, math, os, sys
def imp(name, path):
    spec = importlib.util.spec_from_file_location(name, path); M = importlib.util.module_from_spec(spec)
    so = sys.stdout; sys.stdout = open(os.devnull, "w"); spec.loader.exec_module(M); sys.stdout = so; return M
T = "/Users/lap16116/BTC_PC/btc-dashboard/tools/"
Hh = imp("Hh", T+"loop-hedge01-crossasset.py"); C = imp("C", T+"correlation-turtle-hedge01-7y.py")
run = Hh.run_hedge01; CC = Hh.CC
def months_between(t0,t1):
    d0=datetime.datetime.utcfromtimestamp(t0/1000); d1=datetime.datetime.utcfromtimestamp(t1/1000)
    out=[];y,m=d0.year,d0.month
    while (y,m)<=(d1.year,d1.month):
        out.append(f"{y}-{m:02d}");m+=1
        if m>12:m=1;y+=1
    return out
def sharpe(v):
    if len(v)<2: return 0.0
    me=sum(v)/len(v);d=(sum((x-me)**2 for x in v)/len(v))**.5 or 1e-9;return me/d*math.sqrt(12)
def mdd(v):
    cum=peak=m=0.0
    for x in v: cum+=x;peak=max(peak,cum);m=max(m,peak-cum)
    return m*100

comp = {}
for n,p in [("BTC",f"{CC}/binance-5m-7y.json"),("SOL",f"{CC}/binance-sol-5m-3y.json"),
            ("ETH",f"{CC}/binance-eth-5m-3y.json"),("AVAX",f"{CC}/binance-avax-5m-3y.json")]:
    mo,_,_,_ = run(p, skip_cal=False); comp[n]=mo
comp["turtleBTC"] = dict(C.tur_mo)

FULL = months_between(1688169600000, 1748736000000)  # ~2023-07 → 2026-05 (35mo region)
H2 = [m for m in FULL if m >= "2024-12"]  # OOS half
def blend(parts, weights, months):
    w=weights; sw=sum(w)
    return [sum(w[j]*comp[parts[j]].get(months[i],0.0) for j in range(len(parts)))/sw for i in range(len(months))]
def ev(parts, weights=None):
    w=weights or [1]*len(parts)
    pf=blend(parts,w,FULL); ph=blend(parts,w,H2)
    return sharpe(pf),mdd(pf),sharpe(ph),mdd(ph),sum(ph)*100

CUR = ["BTC","SOL","turtleBTC"]
cf_sh,cf_dd,ch_sh,ch_dd,ch_ret = ev(CUR)
print("=== Cycle 13: improvement sweep (DECIDE by OOS h2) ===")
print(f"  CURRENT 3-way {CUR}: FULL Sh{cf_sh:+.2f}/DD{cf_dd:.0f}% | H2(OOS) Sh{ch_sh:+.2f}/DD{ch_dd:.0f}%/ret{ch_ret:+.0f}")
print(f"  KILL-CRITERIA: candidate 'win' iff H2-Sharpe > {ch_sh+0.10:+.2f} AND H2-DD ≤ {ch_dd:.0f}%\n")
print(f"  {'candidate':<34} | {'FULL Sh/DD':>12} | {'H2 Sh/DD/ret':>16} | verdict")
cands = {
  "BTC+SOL (2-way)": (["BTC","SOL"],None),
  "BTC+SOL+turtle (CURRENT)": (CUR,None),
  "BTC+SOL+ETH": (["BTC","SOL","ETH"],None),
  "BTC+SOL+ETH+turtle (4-way)": (["BTC","SOL","ETH","turtleBTC"],None),
  "BTC+SOL+AVAX": (["BTC","SOL","AVAX"],None),
  "BTC+SOL+turtle+AVAX": (["BTC","SOL","turtleBTC","AVAX"],None),
  "ETH replaces turtle": (["BTC","SOL","ETH"],None),
  "turtle weight 0.5": (["BTC","SOL","turtleBTC"],[1,1,0.5]),
  "turtle weight 2.0": (["BTC","SOL","turtleBTC"],[1,1,2]),
  "SOL weight 1.5 (lean winner)": (["BTC","SOL","turtleBTC"],[1,1.5,1]),
}
for label,(parts,w) in cands.items():
    fs,fd,hs,hd,hr = ev(parts,w)
    win = (hs > ch_sh+0.10) and (hd <= ch_dd+0.5)
    v = "✅ IMPROVES" if win else ("≈ tie" if abs(hs-ch_sh)<0.1 else "✗ worse")
    print(f"  {label:<34} | {fs:>+5.2f}/{fd:>4.0f}% | {hs:>+5.2f}/{hd:>4.0f}%/{hr:>+5.0f} | {v}")
print("\n  → Nếu KHÔNG candidate nào ✅ IMPROVES → book hiện tại là TRẦN (đừng đẽo thêm = overfit).")
