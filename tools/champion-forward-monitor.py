#!/usr/bin/env python3
"""
champion-forward-monitor.py — doc champion-forward-SIGNALS.jsonl, tong hop tien do
paper forward-test vs backtest expectation + sizing gate.

Backtest champion (Calmar 7.16): WR ~40%, R:R ~2.5, 3 sleeve BTC4h/BTC1h/ETH.
Sizing gate (truoc khi size that):
  1. >=3 thang live AND >=30 closed trades
  2. live WR trong [32%,50%] (quanh backtest 40%)
  3. paper equity > start (khong thua rong)
  4. khong trade nao > 30% tong PnL (khong may rui)
  5. tung qua >=1 doan sut (survived drawdown)
Usage: python3 champion-forward-monitor.py [--file=path]
"""
import json,sys,os,datetime
from collections import defaultdict
TOOLS=os.path.dirname(os.path.abspath(__file__))
LOG=os.path.join(TOOLS,"champion-forward-SIGNALS.jsonl")
for a in sys.argv:
    if a.startswith("--file="): LOG=a.split("=",1)[1]

rows=[json.loads(l) for l in open(LOG)] if os.path.exists(LOG) else []
print("="*66); print("CHAMPION (Calmar 7.16) — paper forward-test vs sizing gate"); print("="*66)
if not rows: print("Chua co data — logger vua khoi dong."); sys.exit(0)
start=[r for r in rows if r["event"]=="START"]
ent=[r for r in rows if r["event"]=="ENTRY"]
ex=[r for r in rows if r["event"]=="EXIT"]
hb=[r for r in rows if r["event"]=="HEARTBEAT"]
t0=start[0]["time"] if start else min(r["time"] for r in rows)
t1=max(r["time"] for r in rows)
days=(t1-t0)/86400_000
d0=datetime.datetime.fromtimestamp(t0/1000,datetime.UTC).strftime("%Y-%m-%d")
eq=hb[-1]["equity"] if hb else (start[0]["equity"] if start else 100000)
print(f"  Start {d0} → +{days:.1f}d | equity ${eq:,.0f} (start $100,000, {(eq/100000-1)*100:+.1f}%)")
print(f"  Entries={len(ent)} Closed={len(ex)} OpenNow={len(ent)-len(ex)}")
# per-sleeve
bys=defaultdict(lambda:[0,0,0.0])
for e in ex:
    s=e["sleeve"]; bys[s][0]+=1; bys[s][2]+=e.get("pnlUsd",0)
    if e.get("pnlUsd",0)>0: bys[s][1]+=1
if ex:
    print("\n  Per-sleeve (closed):")
    for s,(n,w,p) in sorted(bys.items()):
        print(f"    {s:6s}: n={n:3d} WR={w/n*100 if n else 0:4.0f}% PnL=${p:+,.0f}")
if not ex:
    print("\n  0 closed trades — chua co gi de cham. Can >=30. Tiep tuc cho.")
    print(f"\n  GATE 1 (>=3mo & >=30 trades): ✗ ({days:.0f}d, 0 trades)"); sys.exit(0)
pnls=[e.get("pnlUsd",0) for e in ex]; total=sum(pnls); wins=[p for p in pnls if p>0]
wr=len(wins)/len(pnls)*100; maxshare=max(abs(p)/abs(total)*100 for p in pnls) if total else 0
print(f"\n  Closed PnL ${total:+,.0f} | WR {wr:.0f}% (backtest ~40%) | biggest trade {maxshare:.0f}% of |PnL|")
print("\n  SIZING GATE:")
c1=days>=90 and len(ex)>=30
c2=32<=wr<=50
c3=eq>100000
c4=maxshare<=30
print(f"   1. >=3mo & >=30 trades : {'✓' if c1 else '✗'} ({days:.0f}d, {len(ex)} trades)")
print(f"   2. WR in [32,50]%      : {'✓' if c2 else '✗'} ({wr:.0f}%)")
print(f"   3. equity > start      : {'✓' if c3 else '✗'} (${eq:,.0f})")
print(f"   4. no trade >30% PnL   : {'✓' if c4 else '✗'} ({maxshare:.0f}%)")
print(f"   5. survived a drawdown : (manual — xem equity dips)")
print(f"\n  → {'GATE 1-4 PASS — review 5 roi can nhac size' if (c1 and c2 and c3 and c4) else 'CHUA size-ready — giu paper'}")
