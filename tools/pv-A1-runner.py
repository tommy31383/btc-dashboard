#!/usr/bin/env python3
"""
pv-A1-runner.py — chạy A1 (Effort vs Result) ĐÚNG prereg-A1-effort-result.md (đã khóa).
FEATURE TRIAGE, dev data ≤2026-06. Không TP/SL/sizing/structure/S-R/multi-TF-gate.
"""
import json, os, importlib.util, statistics, math, sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("pvev1", os.path.join(HERE, "pv-evolver-v1.py"))
pv1 = importlib.util.module_from_spec(spec); spec.loader.exec_module(pv1)

HORIZONS = [1, 3, 6, 12]
STATES = ["EXHAUSTION", "ABSORPTION", "DEMAND", "SUPPLY"]
N_TESTS = len(STATES) * len(HORIZONS)         # 16 → Bonferroni
ALPHA = 0.05; BONF = ALPHA / N_TESTS
MIN_FULL = 200; MIN_YEAR = 30

def rmed(vals, i, lb):
    lo = max(0, i-lb+1); return statistics.median(vals[lo:i+1])

def classify(bars, lb=50, volHi=1.5, volEx=2.0, rngEx=1.8, rngAb=0.8):
    rngs=[b["h"]-b["l"] for b in bars]; vols=[b["v"] for b in bars]; out=[]
    for i,b in enumerate(bars):
        mR=rmed(rngs,i,lb); mV=rmed(vols,i,lb); rng=b["h"]-b["l"]
        if rng<=0 or mR<=0 or mV<=0: out.append("NEUTRAL"); continue
        cp=(b["c"]-b["l"])/rng; rr=rng/mR; vr=b["v"]/mV
        if rr>=rngEx and vr>=volEx: out.append("EXHAUSTION")
        elif vr>=volHi and rr<=rngAb: out.append("ABSORPTION")
        elif vr>=volHi and cp>=0.66: out.append("DEMAND")
        elif vr>=volHi and cp<=0.34: out.append("SUPPLY")
        else: out.append("NEUTRAL")
    return out, rngs

def fwd(bars,i,h):
    j=i+h; return (bars[j]["c"]-bars[i]["c"])/bars[i]["c"]*100 if j<len(bars) else None

def excursions(bars,i,h):
    c=bars[i]["c"]; hh=max(bars[i+k]["h"] for k in range(1,h+1)) if i+h<len(bars) else None
    if hh is None: return None
    ll=min(bars[i+k]["l"] for k in range(1,h+1))
    return (hh-c)/c*100, (ll-c)/c*100, (hh-ll)  # upMFE%, dnMAE%, rawRange

def avg_ranks(xs):
    idx=sorted(range(len(xs)), key=lambda k:xs[k]); ranks=[0.0]*len(xs); i=0
    while i<len(xs):
        j=i
        while j+1<len(xs) and xs[idx[j+1]]==xs[idx[i]]: j+=1
        r=(i+j)/2+1
        for k in range(i,j+1): ranks[idx[k]]=r
        i=j+1
    return ranks

def mann_whitney(a,b):
    n1,n2=len(a),len(b)
    if n1==0 or n2==0: return None,None
    ranks=avg_ranks(a+b); R1=sum(ranks[:n1]); U1=R1-n1*(n1+1)/2
    rb=2*U1/(n1*n2)-1
    mu=n1*n2/2; sd=math.sqrt(n1*n2*(n1+n2+1)/12) or 1e-9; z=(U1-mu)/sd
    p=2*(1-0.5*(1+math.erf(abs(z)/math.sqrt(2))))
    return round(rb,3), p

def yr(bars,i): import datetime; return datetime.datetime.utcfromtimestamp(bars[i]["t"]/1000).year

def run(tf):
    bars=pv1.load_agg(tf); n=len(bars); states,rngs=classify(bars)
    mRall=[rmed(rngs,i,50) for i in range(n)]
    # gom forward metrics theo state
    res={}
    for st in STATES+["NEUTRAL"]:
        idxs=[i for i in range(n) if states[i]==st]
        res[st]={"n":len(idxs),"idxs":idxs}
    report={"tf":tf,"n":n,"bonferroni_p":round(BONF,5),"n_hypotheses":N_TESTS,
            "status":"DEVELOPMENT FEATURE TRIAGE — NOT OOS validation, NOT a strategy. All data <=2026-06 already seen.",
            "prereg":"prereg-A1-effort-result.md (locked before run)","states":{}}
    neutral_idx=res["NEUTRAL"]["idxs"]
    for st in STATES:
        idxs=res[st]["idxs"]; report["states"][st]={"n_total":len(idxs),"horizons":{}}
        for h in HORIZONS:
            sret=[fwd(bars,i,h) for i in idxs if fwd(bars,i,h) is not None]
            nret=[fwd(bars,i,h) for i in neutral_idx if fwd(bars,i,h) is not None]
            if len(sret)<MIN_FULL:
                report["states"][st]["horizons"][h]={"n":len(sret),"note":"<MIN_FULL(200) — không báo cáo chính"}; continue
            rb,p=mann_whitney(sret,nret)
            # excursions + range expansion
            ex=[excursions(bars,i,h) for i in idxs if excursions(bars,i,h) is not None]
            upMFE=sum(e[0] for e in ex)/len(ex); dnMAE=sum(e[1] for e in ex)/len(ex)
            rexp=[ (e[2]/mRall[i]) for i,e in zip([k for k in idxs if excursions(bars,k,h)], ex) if mRall[i]>0]
            rangeExp=sum(rexp)/len(rexp) if rexp else None
            # per-year sign consistency
            byyr=defaultdict(list)
            for i in idxs:
                v=fwd(bars,i,h)
                if v is not None: byyr[yr(bars,i)].append(v)
            yrs=[(y,sum(vs)/len(vs)) for y,vs in byyr.items() if len(vs)>=MIN_YEAR]
            overall=sum(sret)/len(sret); same=sum(1 for _,m in yrs if (m>0)==(overall>0))
            report["states"][st]["horizons"][h]={
                "n":len(sret),"mean":round(overall,4),"median":round(statistics.median(sret),4),
                "hitrate":round(sum(1 for x in sret if x>0)/len(sret)*100,1),
                "upMFE":round(upMFE,3),"dnMAE":round(dnMAE,3),"rangeExp":round(rangeExp,3) if rangeExp else None,
                "rank_biserial":rb,"p":round(p,5),"bonferroni_pass":p<BONF,
                "year_sign_consistency":f"{same}/{len(yrs)}"}
    return report,bars,states

def neighborhood(bars):
    """Stability: rb của mỗi state@h=6 qua LB & threshold lân cận — giữ dấu không?"""
    grids=[("LB40",dict(lb=40)),("LB60",dict(lb=60)),("vol+.2",dict(volHi=1.7,volEx=2.2)),
           ("vol-.2",dict(volHi=1.3,volEx=1.8)),("rng±.2",dict(rngEx=1.6,rngAb=1.0))]
    n=len(bars); base_states,_=classify(bars); neutral=[i for i in range(n) if base_states[i]=="NEUTRAL"]
    out={}
    for st in STATES:
        signs=[]
        for name,kw in grids:
            s2,_=classify(bars,**kw); idx=[i for i in range(n) if s2[i]==st]
            sret=[fwd(bars,i,6) for i in idx if fwd(bars,i,6) is not None]
            nret=[fwd(bars,i,6) for i in [k for k in range(n) if s2[k]=="NEUTRAL"] if fwd(bars,i,6) is not None]
            if len(sret)>=100 and nret:
                rb,_=mann_whitney(sret,nret); signs.append((name,rb))
        out[st]=signs
    return out

if __name__=="__main__":
    tf=sys.argv[1] if len(sys.argv)>1 else "4h"
    rep,bars,states=run(tf)
    nb=neighborhood(bars); rep["neighborhood_h6_rankbiserial"]=nb
    import datetime
    d0=datetime.datetime.utcfromtimestamp(bars[0]["t"]/1000); d1=datetime.datetime.utcfromtimestamp(bars[-1]["t"]/1000)
    print(f"A1 Effort-vs-Result | {tf} {rep['n']} bars {d0:%Y-%m-%d}..{d1:%Y-%m-%d} | Bonferroni p<{rep['bonferroni_p']}")
    for st in STATES:
        s=rep["states"][st]; print(f"\n{st} (n_total={s['n_total']}):")
        print(f"  {'h':>3} | {'n':>5} | {'mean%':>7} | {'med%':>7} | {'hit%':>5} | {'upMFE':>6} | {'dnMAE':>6} | {'rExp':>5} | {'rb':>6} | {'p':>8} | Bonf | yrSign")
        for h in HORIZONS:
            d=s["horizons"][h]
            if "note" in d: print(f"  {h:>3} | {d['n']:>5} | {d['note']}"); continue
            print(f"  {h:>3} | {d['n']:>5} | {d['mean']:>+7.3f} | {d['median']:>+7.3f} | {d['hitrate']:>5.1f} | {d['upMFE']:>+6.2f} | {d['dnMAE']:>+6.2f} | {d['rangeExp'] if d['rangeExp'] else 0:>5.2f} | {d['rank_biserial']:>+6.3f} | {d['p']:>8.5f} | {'Y' if d['bonferroni_pass'] else 'n'} | {d['year_sign_consistency']}")
    print("\nNeighborhood rb@h6 (giữ dấu = stable):")
    for st,sg in nb.items(): print(f"  {st}: " + " ".join(f"{nm}{rb:+.2f}" for nm,rb in sg))
    json.dump(rep, open(os.path.join(HERE,"pv-A1-result.json"),"w"), indent=2)
    # triage verdict
    print("\n=== TRIAGE (KEEP cần |rb|≥0.1 + Bonferroni-pass + dấu nhất quán + stable neighborhood) ===")
    for st in STATES:
        hs=[h for h in HORIZONS if "rank_biserial" in rep["states"][st]["horizons"][h]]
        keep=any(abs(rep["states"][st]["horizons"][h]["rank_biserial"])>=0.1 and rep["states"][st]["horizons"][h]["bonferroni_pass"] for h in hs)
        print(f"  {st}: {'KEEP-candidate' if keep else 'DROP'} (xem stability trước khi chốt)")
    print("\n⚠️ TRIAGE trên development data — không phải validation/strategy. Không xuất confidence.")
