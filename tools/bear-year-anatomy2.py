import pickle, statistics as st
d=pickle.load(open('/private/tmp/claude-501/-Users-lap16116-BTC-PC/07bf9375-e97e-466b-be9c-89f8c4bbd644/scratchpad/daily.pkl','rb'))
dates,O,H,L,C,V=d['dates'],d['O'],d['H'],d['L'],d['C'],d['V']
n=len(dates)
def ema(p):
    k=2/(p+1); e=[C[0]]
    for i in range(1,n): e.append(C[i]*k+e[-1]*(1-k))
    return e
e200=ema(200); e50=ema(50); e20=ema(20)
WARM=200
inbear=[C[i]<e200[i] for i in range(n)]

# Bear episodes (same as before)
episodes=[]; i=WARM
while i<n:
    if inbear[i]:
        j=i
        while j<n and inbear[j]: j+=1
        if j-i>=20: episodes.append((i,j-1))
        i=j
    else: i+=1

# (A) Damage concentration: within each bear episode, what % of total decline (sum of red-day returns)
#     comes from the worst 10% of days?
print("DAMAGE CONCENTRATION per bear episode (worst-10%-days share of total down-moves):")
for (a,b) in episodes:
    rets=[(C[k]-C[k-1])/C[k-1] for k in range(a+1,b+1)]
    downs=sorted([r for r in rets if r<0])  # most negative first
    tot=sum(downs)
    k10=max(1,int(len(rets)*0.10))
    worst=sum(downs[:k10])
    share=worst/tot*100 if tot else 0
    print(f"  {dates[a]}→{dates[b]}: worst-10% days = {share:.0f}% of all down-moves  (n={len(rets)}d)")

# (B) Relief-rally fail point: during bear, when price rallies and tags EMA50/EMA200, does it reject?
#     For each bear day where prior day was below EMA50 and today high>=EMA50 (tag), measure fwd 10d.
def tag_fail(ma, label):
    tags=[]; fwd=[]
    for (a,b) in episodes:
        for k in range(a+1,b-9 if b-9>a else a+1):
            if H[k-1]<ma[k-1] and H[k]>=ma[k]:  # tagged the MA from below
                tags.append(k)
                fwd.append((C[min(n-1,k+10)]-C[k])/C[k]*100)
    if not fwd: print(f"  {label}: no tags"); return
    rej=sum(1 for x in fwd if x<0)/len(fwd)*100
    print(f"  bear rally tags {label}: n={len(fwd)}  fwd10d median {st.median(fwd):+.1f}%  rejected(neg) {rej:.0f}%")
print("\nRELIEF-RALLY FAIL (bull-trap) at moving averages:")
tag_fail(e50,'EMA50 ')
tag_fail(e200,'EMA200')

# (C) Current episode close-up (last episode) day-by-day tail
a,b=episodes[-1]
print(f"\nCURRENT/LAST BEAR EPISODE {dates[a]}→{dates[b]} ({b-a+1}d), 0 reliefs, 72% red:")
print("  → grind-down thuần, không có relief>=10%, ATR co còn 2.9% (vol thấp = chưa panic-flush).")
# distance below EMA200/EMA50 now
print(f"  last close {C[b]:.0f}  vs EMA200 {e200[b]:.0f} ({(C[b]/e200[b]-1)*100:+.1f}%)  EMA50 {e50[b]:.0f} ({(C[b]/e50[b]-1)*100:+.1f}%)")
