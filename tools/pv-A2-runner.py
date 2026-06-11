#!/usr/bin/env python3
"""
pv-A2-runner.py — chạy A2 (Auction Acceptance) ĐÚNG prereg-A2-auction-acceptance.md (đã khóa).
KHÔNG sửa protocol theo kết quả A1. FEATURE TRIAGE, dev data ≤2026-06. Volume chỉ phân tầng.
"""
import json, os, importlib.util, statistics, math, sys, datetime
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("pvev1", os.path.join(HERE, "pv-evolver-v1.py"))
pv1 = importlib.util.module_from_spec(spec); spec.loader.exec_module(pv1)

W=20; X=4.0; K=2; LB=50
HORIZONS=[1,3,6,12]
N_TESTS=16; ALPHA=0.05; BONF=ALPHA/N_TESTS          # locked 2 group ×4h ×2 dir
MIN_GROUP=150; MIN_YEAR=30

def rmed(vals,i,lb=LB): lo=max(0,i-lb+1); return statistics.median(vals[lo:i+1])
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

def detect(bars, W=W, X=X, K=K):
    n=len(bars); rngs=[b["h"]-b["l"] for b in bars]; vols=[b["v"] for b in bars]
    events=[]; i=W
    while i<n-K:
        hi=max(bars[k]["h"] for k in range(i-W,i)); lo=min(bars[k]["l"] for k in range(i-W,i))
        if (hi-lo) > X*rmed(rngs,i-1):  # không balanced
            i+=1; continue
        c=bars[i]["c"]; up=c>hi; dn=c<lo
        if not(up or dn): i+=1; continue
        direction="up" if up else "dn"
        label="ACCEPT"
        for k in range(1,K+1):
            ck=bars[i+k]["c"]
            if lo<=ck<=hi: label="REJECT"; break
        volR=bars[i]["v"]/(rmed(vols,i) or 1e-9)
        tier="hi" if volR>1.5 else ("lo" if volR<0.8 else "mid")
        events.append({"i":i,"baseIdx":i+K,"dir":direction,"label":label,"volTier":tier,
                       "yr":datetime.datetime.utcfromtimestamp(bars[i]["t"]/1000).year})
        i=i+K+1
    return events

def fwd(bars,base,h): j=base+h; return (bars[j]["c"]-bars[base]["c"])/bars[base]["c"]*100 if j<len(bars) else None

def run(tf):
    bars=pv1.load_agg(tf); n=len(bars); evs=detect(bars)
    rep={"tf":tf,"n":n,"n_hypotheses":N_TESTS,"bonferroni_p":round(BONF,5),
         "status":"DEVELOPMENT FEATURE TRIAGE — NOT OOS validation, NOT a strategy. All data <=2026-06 already seen.",
         "prereg":"prereg-A2-auction-acceptance.md (locked before run)","params":{"W":W,"X":X,"K":K},
         "counts":{},"by_direction":{}, "vol_tier_dist":{}}
    for d in ("up","dn"):
        acc=[e for e in evs if e["dir"]==d and e["label"]=="ACCEPT"]
        rej=[e for e in evs if e["dir"]==d and e["label"]=="REJECT"]
        rep["counts"][d]={"ACCEPT":len(acc),"REJECT":len(rej)}
        rep["by_direction"][d]={}
        for h in HORIZONS:
            a=[fwd(bars,e["baseIdx"],h) for e in acc if fwd(bars,e["baseIdx"],h) is not None]
            r=[fwd(bars,e["baseIdx"],h) for e in rej if fwd(bars,e["baseIdx"],h) is not None]
            cell={"nAcc":len(a),"nRej":len(r)}
            if len(a)>=MIN_GROUP and len(r)>=MIN_GROUP:
                rb,p=mw(a,r)
                cell.update({"acc_mean":round(sum(a)/len(a),4),"acc_med":round(statistics.median(a),4),
                             "acc_hit":round(sum(1 for x in a if x>0)/len(a)*100,1),
                             "rej_mean":round(sum(r)/len(r),4),"rej_hit":round(sum(1 for x in r if x>0)/len(r)*100,1),
                             "rank_biserial":rb,"p":round(p,5),"bonferroni_pass":p<BONF})
            else:
                cell["note"]=f"group<{MIN_GROUP} (acc{len(a)}/rej{len(r)}) — không báo cáo chính"
            rep["by_direction"][d][h]=cell
    rep["vol_tier_dist"]={t:sum(1 for e in evs if e["volTier"]==t) for t in ("lo","mid","hi")}
    rep["total_events"]=len(evs)
    return rep,bars,evs

def neighborhood(bars):
    out={}
    for name,kw in [("W15",dict(W=15)),("W30",dict(W=30)),("X3",dict(X=3.0)),("X5",dict(X=5.0)),("K1",dict(K=1)),("K3",dict(K=3))]:
        evs=detect(bars,**{**dict(W=W,X=X,K=K),**kw})
        # rb cho up-breakout @h6
        acc=[e for e in evs if e["dir"]=="up" and e["label"]=="ACCEPT"]; rej=[e for e in evs if e["dir"]=="up" and e["label"]=="REJECT"]
        a=[fwd(bars,e["baseIdx"],6) for e in acc if fwd(bars,e["baseIdx"],6) is not None]
        r=[fwd(bars,e["baseIdx"],6) for e in rej if fwd(bars,e["baseIdx"],6) is not None]
        rb=mw(a,r)[0] if (len(a)>=50 and len(r)>=50) else None
        out[name]={"rb_up_h6":rb,"nAcc":len(acc),"nRej":len(rej)}
    return out

if __name__=="__main__":
    tf=sys.argv[1] if len(sys.argv)>1 else "4h"
    rep,bars,evs=run(tf); rep["neighborhood_up_h6"]=neighborhood(bars)
    d0=datetime.datetime.utcfromtimestamp(bars[0]["t"]/1000); d1=datetime.datetime.utcfromtimestamp(bars[-1]["t"]/1000)
    print(f"A2 Auction-Acceptance | {tf} {rep['n']} bars {d0:%Y-%m-%d}..{d1:%Y-%m-%d} | W{W} X{X} K{K} | Bonferroni p<{rep['bonferroni_p']}")
    print(f"total balance-breakout events: {rep['total_events']} | volTier {rep['vol_tier_dist']}")
    for d in ("up","dn"):
        c=rep["counts"][d]; print(f"\n{d.upper()}-breakout: ACCEPT {c['ACCEPT']} / REJECT {c['REJECT']}")
        print(f"  {'h':>3} | {'nAcc':>4}/{'nRej':<4} | {'accMean%':>8} | {'accHit':>6} | {'rejMean%':>8} | {'rejHit':>6} | {'rb(acc-rej)':>11} | {'p':>8} | Bonf")
        for h in HORIZONS:
            x=rep["by_direction"][d][h]
            if "note" in x: print(f"  {h:>3} | {x['nAcc']:>4}/{x['nRej']:<4} | {x['note']}"); continue
            print(f"  {h:>3} | {x['nAcc']:>4}/{x['nRej']:<4} | {x['acc_mean']:>+8.3f} | {x['acc_hit']:>5.1f}% | {x['rej_mean']:>+8.3f} | {x['rej_hit']:>5.1f}% | {x['rank_biserial']:>+11.3f} | {x['p']:>8.5f} | {'Y' if x['bonferroni_pass'] else 'n'}")
    print("\nNeighborhood rb(up,h6):", {k:v["rb_up_h6"] for k,v in rep["neighborhood_up_h6"].items()})
    json.dump(rep, open(os.path.join(HERE,"pv-A2-result.json"),"w"), indent=2)
    print("\n=== TRIAGE: KEEP cần |rb|≥0.1 + Bonferroni-pass + dấu nhất quán + stable ===")
    for d in ("up","dn"):
        hs=[h for h in HORIZONS if "rank_biserial" in rep["by_direction"][d][h]]
        keep=any(abs(rep["by_direction"][d][h]["rank_biserial"])>=0.1 and rep["by_direction"][d][h]["bonferroni_pass"] for h in hs)
        print(f"  {d}-breakout ACCEPT-vs-REJECT: {'KEEP-candidate' if keep else 'DROP'}")
    print("\n⚠️ DEVELOPMENT TRIAGE — không phải validation/strategy. Không xuất confidence.")
