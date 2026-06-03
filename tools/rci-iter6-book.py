#!/usr/bin/env python3
"""Book impact of TAMED RCI-reversal sleeve (iter6) vs hedge01+turtle. Corr + risk-parity 2-way vs 3-way."""
import json, math
from collections import defaultdict

rci = json.loads(open("/tmp/rci_iter6_mo.txt").read().split("RCI_MONTHLY ",1)[1])
h01=tur=None
for line in open("/tmp/h01_tur.txt"):
    if line.startswith("H01_MONTHLY"): h01=json.loads(line.split("H01_MONTHLY ",1)[1])
    elif line.startswith("TUR_MONTHLY"): tur=json.loads(line.split("TUR_MONTHLY ",1)[1])

allmo=sorted(set(rci)|set(h01)|set(tur)); N=len(allmo)
R=[rci.get(m,0.0) for m in allmo]; H=[h01.get(m,0.0) for m in allmo]; T=[tur.get(m,0.0) for m in allmo]

def pearson(x,y):
    n=len(x); mx=sum(x)/n; my=sum(y)/n
    cov=sum((x[i]-mx)*(y[i]-my) for i in range(n))/n
    sx=(sum((v-mx)**2 for v in x)/n)**0.5; sy=(sum((v-my)**2 for v in y)/n)**0.5
    return cov/(sx*sy) if sx>0 and sy>0 else 0
def sharpe(s):
    n=len(s); m=sum(s)/n; d=(sum((v-m)**2 for v in s)/n)**0.5 or 1e-9; return m/d*math.sqrt(12)
def sd(s):
    n=len(s); m=sum(s)/n; return (sum((v-m)**2 for v in s)/n)**0.5 or 1e-9
def mdd(s):
    eq=0;peak=0;d=0
    for v in s: eq+=v; peak=max(peak,eq); d=max(d,peak-eq)
    return d*100

print(f"months={N}  (common to all 3)")
print(f"  corr TAMED-RCI vs hedge01 : {pearson(R,H):+.3f}")
print(f"  corr TAMED-RCI vs turtle  : {pearson(R,T):+.3f}")
print(f"  corr hedge01 vs turtle    : {pearson(H,T):+.3f}")
print()
print(f"  monthly Sharpe(xsqrt12): RCI {sharpe(R):+.2f}  hedge01 {sharpe(H):+.2f}  turtle {sharpe(T):+.2f}")
print(f"  monthly MaxDD(R%):       RCI {mdd(R):.0f}    hedge01 {mdd(H):.0f}    turtle {mdd(T):.0f}")
print()
sR,sH,sT=sd(R),sd(H),sd(T)
def book(weights,series,label):
    comb=[sum(weights[k]*series[k][i] for k in range(len(series))) for i in range(N)]
    tot=sum(comb)*100
    print(f"  {label}: Sharpe {sharpe(comb):+.2f}  MaxDD {mdd(comb):.0f}  totalR {tot:+.0f}% (book units)")
    return sharpe(comb),mdd(comb)
wH=1/sH; wT=1/sT; s2=wH+wT
sh2,dd2=book([wH/s2,wT/s2],[H,T],"BOOK 2-way hedge01+turtle (risk-parity) ")
wR=1/sR; s3=wH+wT+wR
sh3,dd3=book([wH/s3,wT/s3,wR/s3],[H,T,R],"BOOK 3-way +TAMED-RCI (risk-parity)     ")
print()
print(f"  DELTA: Sharpe {sh2:+.2f} -> {sh3:+.2f} ({sh3-sh2:+.2f})   MaxDD {dd2:.0f} -> {dd3:.0f} ({dd3-dd2:+.0f}pp)")
print(f"  Gate: Sharpe UP and DD increase < +3pp ? {'PASS' if sh3>sh2 and (dd3-dd2)<3 else 'FAIL'}")
