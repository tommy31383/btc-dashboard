#!/usr/bin/env python3
"""
pv-A3-runner.py — A3 Structure Context, SINGLE-EVENT layer, ĐÚNG prereg-A3-structure-context.md.

Conditional layer (event × A1/A2) BỎ vì A1 & A2 đều DROP → KHÔNG có KEEP-feature để condition.
Đây là PRE-SPECIFIED DEPENDENCY OUTCOME (prereg ghi A3 conditional chỉ chạy nếu A1/A2 có baseline KEEP),
KHÔNG phải sửa protocol hậu nghiệm. Không condition A1/A2, không thêm volume gate. Dev data ≤2026-06.
"""
import json, os, importlib.util, statistics, math, sys, datetime
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("pvev1", os.path.join(HERE, "pv-evolver-v1.py"))
pv1 = importlib.util.module_from_spec(spec); spec.loader.exec_module(pv1)

L=2; HORIZONS=[1,3,6,12]
EVENTS=["BOS_UP","BOS_DOWN","CHOCH_UP","CHOCH_DOWN"]
N_TESTS=len(EVENTS)*len(HORIZONS)  # 16
ALPHA=0.05; BONF=ALPHA/N_TESTS
MIN_FULL=150; MIN_YEAR=20

def avg_ranks(xs):
    idx=sorted(range(len(xs)),key=lambda k:xs[k]); r=[0.0]*len(xs); i=0
    while i<len(xs):
        j=i
        while j+1<len(xs) and xs[idx[j+1]]==xs[idx[i]]: j+=1
        rr=(i+j)/2+1
        for k in range(i,j+1): r[idx[k]]=rr
        i=j+1
    return r
def mw(a,b):
    n1,n2=len(a),len(b)
    if n1==0 or n2==0: return None,None
    rk=avg_ranks(a+b); U1=sum(rk[:n1])-n1*(n1+1)/2; rb=2*U1/(n1*n2)-1
    sd=math.sqrt(n1*n2*(n1+n2+1)/12) or 1e-9; z=(U1-n1*n2/2)/sd
    p=2*(1-0.5*(1+math.erf(abs(z)/math.sqrt(2)))); return round(rb,3),p

def structure(bars, L=L):
    n=len(bars); piv=[None]*n
    for i in range(L,n-L):
        w=range(i-L,i+L+1)
        if all(bars[i]["h"]>=bars[j]["h"] for j in w) and any(bars[i]["h"]>bars[j]["h"] for j in w if j!=i): piv[i]="H"
        elif all(bars[i]["l"]<=bars[j]["l"] for j in w) and any(bars[i]["l"]<bars[j]["l"] for j in w if j!=i): piv[i]="L"
    events=[]; trend="RANGE"; recH=recHb=recL=recLb=None
    for i in range(n):
        j=i-L  # pivot tại j chỉ ĐƯỢC BIẾT tại i=j+L (cần L nến phải) → no lookahead
        if j>=0 and piv[j]=="H": recH=bars[j]["h"]; recHb=j
        if j>=0 and piv[j]=="L": recL=bars[j]["l"]; recLb=j
        c=bars[i]["c"]
        if recH is not None and c>recH:
            typ="CHOCH_UP" if trend=="DOWN" else "BOS_UP"
            events.append({"i":i,"type":typ,"pivotBar":recHb,"delay":i-recHb}); trend="UP"; recH=None
        elif recL is not None and c<recL:
            typ="CHOCH_DOWN" if trend=="UP" else "BOS_DOWN"
            events.append({"i":i,"type":typ,"pivotBar":recLb,"delay":i-recLb}); trend="DOWN"; recL=None
    return events

def fwd(bars,i,h): j=i+h; return (bars[j]["c"]-bars[i]["c"])/bars[i]["c"]*100 if j<len(bars) else None
def excursion(bars,i,h):
    if i+h>=len(bars): return None
    c=bars[i]["c"]; hh=max(bars[i+k]["h"] for k in range(1,h+1)); ll=min(bars[i+k]["l"] for k in range(1,h+1))
    return (hh-c)/c*100,(ll-c)/c*100

def run(tf, Lp=L):
    bars=pv1.load_agg(tf); n=len(bars); evs=structure(bars,Lp)
    evset={e["i"] for e in evs}
    rep={"tf":tf,"n":n,"L_rightBars":Lp,"pivot_confirm_delay_bars":Lp,"n_hypotheses":N_TESTS,"bonferroni_p":round(BONF,5),
         "status":"DEVELOPMENT FEATURE TRIAGE — NOT OOS validation, NOT a strategy. All data <=2026-06 already seen.",
         "conditional_layer":"SKIPPED — pre-specified dependency outcome (A1 & A2 both DROP, no KEEP-feature to condition on). NOT a post-hoc protocol change.",
         "prereg":"prereg-A3-structure-context.md (locked)","events":{}}
    for et in EVENTS:
        idx=[e["i"] for e in evs if e["type"]==et]
        delays=[e["delay"] for e in evs if e["type"]==et]
        rep["events"][et]={"n_total":len(idx),"mean_pivot_to_confirm_delay":round(sum(delays)/len(delays),2) if delays else None,"horizons":{}}
        for h in HORIZONS:
            sret=[fwd(bars,i,h) for i in idx if fwd(bars,i,h) is not None]
            ctrl=[fwd(bars,i,h) for i in range(n) if i not in evset and fwd(bars,i,h) is not None]
            if len(sret)<MIN_FULL:
                rep["events"][et]["horizons"][h]={"n":len(sret),"note":f"<MIN_FULL({MIN_FULL}) — không báo cáo chính"}; continue
            rb,p=mw(sret,ctrl)
            ex=[excursion(bars,i,h) for i in idx if excursion(bars,i,h) is not None]
            upMFE=sum(e[0] for e in ex)/len(ex); dnMAE=sum(e[1] for e in ex)/len(ex)
            byyr=defaultdict(list)
            for i in idx:
                v=fwd(bars,i,h)
                if v is not None: byyr[datetime.datetime.utcfromtimestamp(bars[i]["t"]/1000).year].append(v)
            yrs=[(y,sum(vs)/len(vs)) for y,vs in byyr.items() if len(vs)>=MIN_YEAR]
            ov=sum(sret)/len(sret); same=sum(1 for _,m in yrs if (m>0)==(ov>0))
            rep["events"][et]["horizons"][h]={"n":len(sret),"mean":round(ov,4),"median":round(statistics.median(sret),4),
                "hitrate":round(sum(1 for x in sret if x>0)/len(sret)*100,1),"upMFE":round(upMFE,3),"dnMAE":round(dnMAE,3),
                "rank_biserial":rb,"p":round(p,5),"bonferroni_pass":p<BONF,"year_sign":f"{same}/{len(yrs)}"}
    return rep,bars

def neighborhood(bars):
    out={}
    for Lp in (2,3):
        evs=structure(bars,Lp); out[f"L{Lp}"]={}
        for et in EVENTS:
            idx=[e["i"] for e in evs if e["type"]==et]; evset={e["i"] for e in evs}
            sret=[fwd(bars,i,6) for i in idx if fwd(bars,i,6) is not None]
            ctrl=[fwd(bars,i,6) for i in range(len(bars)) if i not in evset and fwd(bars,i,6) is not None]
            out[f"L{Lp}"][et]=mw(sret,ctrl)[0] if len(sret)>=100 else None
    return out

if __name__=="__main__":
    tf=sys.argv[1] if len(sys.argv)>1 else "4h"
    rep,bars=run(tf); rep["neighborhood_h6_rb"]=neighborhood(bars)
    d0=datetime.datetime.utcfromtimestamp(bars[0]["t"]/1000); d1=datetime.datetime.utcfromtimestamp(bars[-1]["t"]/1000)
    print(f"A3 Structure single-event | {tf} {rep['n']} bars {d0:%Y-%m-%d}..{d1:%Y-%m-%d} | rightBars={rep['L_rightBars']} (pivot-confirm delay={rep['pivot_confirm_delay_bars']}) | Bonferroni p<{rep['bonferroni_p']}")
    print("conditional layer: SKIPPED (pre-specified dependency outcome — A1&A2 DROP)")
    for et in EVENTS:
        e=rep["events"][et]; print(f"\n{et} (n_total={e['n_total']}, mean pivot→confirm delay={e['mean_pivot_to_confirm_delay']} bar):")
        print(f"  {'h':>3} | {'n':>4} | {'mean%':>7} | {'med%':>7} | {'hit%':>5} | {'upMFE':>6} | {'dnMAE':>6} | {'rb':>6} | {'p':>8} | Bonf | yrSign")
        for h in HORIZONS:
            d=e["horizons"][h]
            if "note" in d: print(f"  {h:>3} | {d['n']:>4} | {d['note']}"); continue
            print(f"  {h:>3} | {d['n']:>4} | {d['mean']:>+7.3f} | {d['median']:>+7.3f} | {d['hitrate']:>5.1f} | {d['upMFE']:>+6.2f} | {d['dnMAE']:>+6.2f} | {d['rank_biserial']:>+6.3f} | {d['p']:>8.5f} | {'Y' if d['bonferroni_pass'] else 'n'} | {d['year_sign']}")
    print("\nNeighborhood rb@h6:", json.dumps(rep["neighborhood_h6_rb"]))
    json.dump(rep, open(os.path.join(HERE,"pv-A3-result.json"),"w"), indent=2)
    print("\n=== TRIAGE: KEEP cần |rb|≥0.1 + Bonferroni-pass + dấu nhất quán + stable ===")
    for et in EVENTS:
        hs=[h for h in HORIZONS if "rank_biserial" in rep["events"][et]["horizons"][h]]
        keep=any(abs(rep["events"][et]["horizons"][h]["rank_biserial"])>=0.1 and rep["events"][et]["horizons"][h]["bonferroni_pass"] for h in hs)
        print(f"  {et}: {'KEEP-candidate' if keep else 'DROP'}")
    print("\n⚠️ DEVELOPMENT TRIAGE. Nếu KEEP → chỉ ghi candidate cho live-forward tương lai, KHÔNG tạo strategy/evolver.")
