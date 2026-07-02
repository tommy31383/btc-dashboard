#!/usr/bin/env python3
"""PLATEAU-ENSEMBLE test (Grok #2, Codex-picked). Question: at EQUAL total capital, does splitting
across N detuned champion configs beat all-in the single-best config? Honest metric = risk-adjusted
(Calmar=NET/maxDD) + drop-top-20% + IS/OOS, NOT raw NET (4 configs summed = 4x capital, unfair).
Ensemble = each config at 1/N capital (net*1/N), merged by exitTime -> combined equity curve.
"""
import json, datetime as dt, glob

CFGS = ['C1_base','C2_loose','C3_strict','C4_emalong']
def load(tag):
    return json.load(open(f'/tmp/ens_{tag}.json'))

def metrics(trades):
    # trades: list of (exitTime, net). equity by exit order.
    s = sorted(trades, key=lambda t: t[0])
    eq=0; peak=0; mdd=0
    for _,net in s:
        eq+=net; peak=max(peak,eq); mdd=max(mdd, peak-eq)
    nets=[n for _,n in s]; tot=sum(nets)
    sd=sorted(nets, reverse=True); drop20=sum(sd[int(len(sd)*0.2):])
    cal = tot/mdd if mdd>0 else float('inf')
    return tot, -mdd, drop20, cal, len(nets)

def split_is_oos(trades):
    IS=[(t,n) for t,n in trades if dt.datetime.utcfromtimestamp(t/1000).year<=2022]
    OOS=[(t,n) for t,n in trades if dt.datetime.utcfromtimestamp(t/1000).year>=2023]
    return sum(n for _,n in IS), sum(n for _,n in OOS)

print(f"{'config':<12} {'NET':>9} {'maxDD':>9} {'drop20':>10} {'Calmar':>7} {'IS':>8} {'OOS':>8}  n")
print('-'*78)
percfg={}
for tag in CFGS:
    tr=[(t['exitTime'], t['net']) for t in load(tag)]
    tot,mdd,d20,cal,n=metrics(tr); IS,OOS=split_is_oos(tr)
    percfg[tag]=(tot,mdd,d20,cal,tr)
    print(f"{tag:<12} {tot:>9.2f} {mdd:>9.2f} {d20:>10.2f} {cal:>7.2f} {IS:>8.1f} {OOS:>8.1f}  {n}")

# single-best by Calmar
best=max(percfg, key=lambda k: percfg[k][3])
print(f"\nsingle-BEST by Calmar = {best}")

# ENSEMBLE: each config 1/N capital -> net*1/N, merge
N=len(CFGS)
ens=[]
for tag in CFGS:
    ens += [(t, net/N) for t,net in percfg[tag][4]]
tot,mdd,d20,cal,n=metrics(ens); IS,OOS=split_is_oos(ens)
print(f"\n{'ENSEMBLE 1/N':<12} {tot:>9.2f} {mdd:>9.2f} {d20:>10.2f} {cal:>7.2f} {IS:>8.1f} {OOS:>8.1f}  {n}")
bt=percfg[best]
print(f"{'vs BEST('+best[:6]+')':<12} {bt[0]:>9.2f} {bt[1]:>9.2f} {bt[2]:>10.2f} {bt[3]:>7.2f}")
print(f"\nVERDICT: ensemble wins only if Calmar > best ({cal:.2f} vs {bt[3]:.2f}) AND drop20 less-neg ({d20:.0f} vs {bt[2]:.0f}) AND OOS holds.")
print("(equal total capital: ensemble NET≈avg-config, must earn its keep via LOWER maxDD/drop20 = diversification)")
