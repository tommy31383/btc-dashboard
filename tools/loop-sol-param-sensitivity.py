#!/usr/bin/env python3
"""Loop cycle 14: hedge01 param-sensitivity TRÊN SOL (SOL dùng param tuned-cho-BTC).
Perturb từng param ±1 step (monkeypatch H constants), đo SOL total ret% + Sharpe + n.
Robust = SOL dương qua CẢ neighborhood; knife-edge = flip âm khi ±1 → overfit warning.
BTC làm reference (default phải khớp các cycle trước).
"""
import importlib.util, math, os, sys
def imp(name, path):
    spec=importlib.util.spec_from_file_location(name,path); M=importlib.util.module_from_spec(spec)
    so=sys.stdout; sys.stdout=open(os.devnull,"w"); spec.loader.exec_module(M); sys.stdout=so; return M
Hh=imp("Hh","/Users/lap16116/BTC_PC/btc-dashboard/tools/loop-hedge01-crossasset.py"); H=Hh.H; run=Hh.run_hedge01; CC=Hh.CC
def sharpe(mo):
    v=list(mo.values())
    if len(v)<2: return 0.0
    me=sum(v)/len(v); d=(sum((x-me)**2 for x in v)/len(v))**.5 or 1e-9; return me/d*math.sqrt(12)
SOL=f"{CC}/binance-sol-5m-3y.json"; BTC=f"{CC}/binance-5m-7y.json"
def metric(path):
    mo,_,tr,_=run(path,skip_cal=False); return sum(t[0] for t in tr)*100, sharpe(mo), len(tr)

DEFAULTS={k:getattr(H,k) for k in ["ADX_THRESH","SL_INIT","SL_TRAIL","SL_TRANS","ATR_PCT_PCTL","DONCHIAN_LB","ATR_BREAK_MULT","VOL_MULT"]}
SWEEPS={
  "ADX_THRESH":[16,18,20,22,24], "SL_INIT":[3.0,4.0,5.0], "SL_TRAIL":[2.0,3.0,4.0],
  "ATR_PCT_PCTL":[0.30,0.50,0.70], "DONCHIAN_LB":[15,20,25], "ATR_BREAK_MULT":[1.0,1.2,1.5], "VOL_MULT":[1.0,1.2,1.4],
}
print("=== Cycle 14: hedge01 param-sensitivity on SOL (BTC-tuned params) ===")
print(f"  default SOL: ret%/Sh/n = {metric(SOL)}  |  BTC (sanity +385): {metric(BTC)[0]:+.0f}")
print(f"\n  {'param':>16} | sweep → SOL ret%(Sharpe,n)   [robust nếu dương cả dòng]")
for k,vals in SWEEPS.items():
    setattr(H,k,DEFAULTS[k])
    cells=[]
    for v in vals:
        setattr(H,k,v)
        r,s,n=metric(SOL)
        star="*" if v==DEFAULTS[k] else " "
        cells.append(f"{k.split('_')[0][:4]}{v}{star}:{r:+.0f}({s:+.1f},{n})")
    setattr(H,k,DEFAULTS[k])
    flip = "⚠️ FLIP âm" if any(metric_v<0 for metric_v in [ (lambda vv:(setattr(H,k,vv),metric(SOL)[0])[1])(v) for v in vals]) else "✅ robust"
    setattr(H,k,DEFAULTS[k])
    print(f"  {k:>16} | " + "  ".join(cells) + f"   [{flip}]")
print("\n  (* = default BTC-tuned value). Robust = SOL ret% dương qua cả neighborhood → param không overfit cho SOL.")
