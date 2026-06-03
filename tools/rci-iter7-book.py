#!/usr/bin/env python3
"""iter7 Task1 — WEIGHT-CAP the reversal sleeve in the hedge01+turtle+RCI book.

iter6 issue: full 3-way risk-parity over-allocates to the low-vol RCI sleeve
(its tiny sd => huge 1/sd weight), normalization shrinks hedge01/turtle =>
book totalR collapses 443 -> 214 even though Sharpe rises 1.16 -> 1.48.

Fix: keep hedge01+turtle at their risk-parity weights (the proven 2-way book),
then ADD the RCI sleeve as a capped fraction w_cap of total book exposure.
   book = (1-w_cap) * [2way risk-parity hedge01+turtle] + w_cap * RCI
Sweep w_cap and find the value that keeps totalR near 443 AND captures Sharpe lift.
"""
import json, math
from collections import defaultdict

rci = json.loads(open("/tmp/rci_iter6_mo.txt").read().split("RCI_MONTHLY ",1)[1])
h01=tur=None
for line in open("/tmp/h01_tur.txt"):
    if line.startswith("H01_MONTHLY"): h01=json.loads(line.split("H01_MONTHLY ",1)[1])
    elif line.startswith("TUR_MONTHLY"): tur=json.loads(line.split("TUR_MONTHLY ",1)[1])

allmo=sorted(set(rci)|set(h01)|set(tur)); N=len(allmo)
R=[rci.get(m,0.0) for m in allmo]; H=[h01.get(m,0.0) for m in allmo]; T=[tur.get(m,0.0) for m in allmo]

def sharpe(s):
    n=len(s); m=sum(s)/n; d=(sum((v-m)**2 for v in s)/n)**0.5 or 1e-9; return m/d*math.sqrt(12)
def sd(s):
    n=len(s); m=sum(s)/n; return (sum((v-m)**2 for v in s)/n)**0.5 or 1e-9
def mdd(s):
    eq=0;peak=0;d=0
    for v in s: eq+=v; peak=max(peak,eq); d=max(d,peak-eq)
    return d*100
def tot(s): return sum(s)*100

# 2-way risk-parity core (the proven book) -- normalized to weights summing 1
sH,sT,sR=sd(H),sd(T),sd(R)
wH=1/sH; wT=1/sT; s2=wH+wT
core=[(wH/s2)*H[i]+(wT/s2)*T[i] for i in range(N)]
print(f"months={N}")
print(f"  CORE 2-way (hedge01+turtle risk-parity): Sharpe {sharpe(core):+.2f}  DD {mdd(core):.0f}  totalR {tot(core):+.0f}%")
print(f"  RCI sleeve standalone:                   Sharpe {sharpe(R):+.2f}  DD {mdd(R):.0f}  totalR {tot(R):+.0f}%")
print()
print("  WEIGHT-CAP SWEEP: book = (1-w)*CORE + w*RCI")
print(f"    {'w_cap':>6}{'Sharpe':>8}{'DD%':>6}{'totalR%':>9}{'Calmar':>8}")
base_tot=tot(core)
rows=[]
for w in [0.0,0.10,0.15,0.20,0.25,0.33]:
    bk=[(1-w)*core[i]+w*R[i] for i in range(N)]
    sh=sharpe(bk); dd=mdd(bk); tr=tot(bk); cal=tr/dd if dd>0 else 0
    rows.append((w,sh,dd,tr,cal))
    print(f"    {w:>6.2f}{sh:>+8.2f}{dd:>6.0f}{tr:>+9.0f}{cal:>8.2f}")

# pick best: maximize Sharpe while totalR >= 90% of core totalR and DD <= core DD +1pp
core_dd=mdd(core)
elig=[r for r in rows if r[0]>0 and r[3]>=0.90*base_tot and r[2]<=core_dd+1.0]
if elig:
    best=max(elig,key=lambda r:r[1])
    print(f"\n  >> OPTIMAL w_cap = {best[0]:.2f}  (Sharpe {best[1]:+.2f}, DD {best[2]:.0f}%, totalR {best[3]:+.0f}%, Calmar {best[4]:.2f})")
    print(f"     keeps totalR >= 90% of core ({base_tot:+.0f}%) and DD <= core+1pp")
else:
    # relax: best Sharpe with totalR >= 80% core
    elig=[r for r in rows if r[0]>0 and r[3]>=0.80*base_tot]
    best=max(elig,key=lambda r:r[1])
    print(f"\n  >> OPTIMAL w_cap = {best[0]:.2f} (relaxed totalR>=80% core): Sharpe {best[1]:+.2f} DD {best[2]:.0f}% totalR {best[3]:+.0f}%")
