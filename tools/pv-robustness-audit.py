#!/usr/bin/env python3
"""
pv-robustness-audit.py — Robustness audit của champion PV_EVOLVER_v2 ĐÃ FREEZE.

KHÔNG đổi search space, KHÔNG search mới. Chỉ audit quanh champion đã freeze:
  1. Neighborhood grid quanh champion cho mọi tham số liên tục (volMult, minRiskPct) + L(int ±1).
  2. Plateau score: median + worst-quartile (q25) của neighborhood.
  3. % hàng xóm pass freeze gates (freq + concentration) — yêu cầu ≥70%.
  4. Cluster theo BEHAVIOR (Jaccard tập timestamp lệnh) → cluster ổn định, không 1 điểm.
  5. Bootstrap theo trade + block-bootstrap theo thời gian → CI expectancy.
  6. Stress fee/slippage 1x/1.5x/2x.
Verdict: REJECT (giữ RESEARCH_ONLY_FRAGILE) nếu CI expectancy chứa âm đáng kể, hoặc cluster chỉ
sống 1 điểm, hoặc <70% hàng xóm pass, hoặc q25 plateau<0, hoặc fee2x expectancy<0.
Chỉ PLATEAU_ROBUST mới đáng tạo paper logger.
"""
import json, os, importlib.util, random, math

HERE = os.path.dirname(os.path.abspath(__file__))
OUTDIR = os.path.join(HERE, "pv-evolver-v2")
spec = importlib.util.spec_from_file_location("pvev2", os.path.join(HERE, "pv-evolver-v2.py"))
pv2 = importlib.util.module_from_spec(spec); spec.loader.exec_module(pv2)
random.seed(20260611)

champ = json.load(open(os.path.join(OUTDIR, "champion-frozen.json")))["params"]
BASE_FEE = pv2.FEE

def val_Rs(c):
    tr = pv2.run_v2(c["tf"], c)
    sub = [(r, t) for (r, y, t) in tr if 2022 <= y <= 2026]
    return [r for r, _ in sub], [t for _, t in sub]

def quant(xs, q):
    if not xs: return None
    s = sorted(xs); i = q*(len(s)-1); lo = int(i); frac = i-lo
    return s[lo] if lo+1 >= len(s) else s[lo]*(1-frac)+s[lo+1]*frac

# ── 1. neighborhood grid ──
vols = [round(champ["volMult"]+d, 3) for d in (-0.3,-0.2,-0.1,0,0.1,0.2,0.3) if 0 <= champ["volMult"]+d <= 2.5]
mrs  = [round(champ["minRiskPct"]+d, 3) for d in (-0.3,-0.2,-0.1,0,0.1,0.2,0.3) if 0 <= champ["minRiskPct"]+d <= 1.5]
Ls   = [L for L in (champ["L"]-1, champ["L"], champ["L"]+1) if 2 <= L <= 6]
neighbors = []
for v in vols:
    for m in mrs:
        for L in Ls:
            cc = dict(champ); cc["volMult"]=v; cc["minRiskPct"]=m; cc["L"]=L
            r = pv2.evaluate(cc)
            if r: neighbors.append(r)
scores = [n["score"] for n in neighbors]
passes = [n for n in neighbors if n["freezeEligible"]]
passRate = len(passes)/len(neighbors) if neighbors else 0
plateau = {"n_neighbors":len(neighbors), "median":round(quant(scores,0.5),2),
           "q25_worst":round(quant(scores,0.25),2), "min":round(min(scores),2), "max":round(max(scores),2),
           "passRate_gates":round(passRate,2)}

# ── 4. behavior cluster (union-find theo Jaccard timestamps) ──
def jac(a,b):
    sa,sb=set(a),set(b); return len(sa&sb)/len(sa|sb) if (sa|sb) else 0
N=len(neighbors); parent=list(range(N))
def find(x):
    while parent[x]!=x: parent[x]=parent[parent[x]]; x=parent[x]
    return x
for i in range(N):
    for j in range(i+1,N):
        if jac(neighbors[i]["_ts"], neighbors[j]["_ts"])>0.6:
            parent[find(i)]=find(j)
from collections import Counter, defaultdict
groups=defaultdict(list)
for i in range(N): groups[find(i)].append(i)
sizes=sorted((len(g) for g in groups.values()), reverse=True)
# champion = điểm gần nhất (v=champ exact đã nằm trong grid vì d=0)
champ_idx=min(range(N), key=lambda i: abs(neighbors[i]["params"]["volMult"]-champ["volMult"])+abs(neighbors[i]["params"]["minRiskPct"]-champ["minRiskPct"])+abs(neighbors[i]["params"]["L"]-champ["L"]))
champ_cluster=[i for i in groups[find(champ_idx)]]
cluster = {"largest_cluster":sizes[0] if sizes else 0, "n_clusters":len(groups),
           "champion_cluster_size":len(champ_cluster), "champion_cluster_frac":round(len(champ_cluster)/N,2),
           "champion_cluster_scores_median":round(quant([neighbors[i]["score"] for i in champ_cluster],0.5),2)}

# ── 5. bootstrap expectancy (champion val trades) ──
Rs, Ts = val_Rs(champ)
def boot_trade(Rs,B=2000):
    n=len(Rs); means=[sum(random.choice(Rs) for _ in range(n))/n for _ in range(B)]
    return round(quant(means,0.025),3), round(quant(means,0.5),3), round(quant(means,0.975),3)
def boot_block(Rs,Ts,B=2000,blk=5):
    order=[r for _,r in sorted(zip(Ts,Rs))]; n=len(order); means=[]
    for _ in range(B):
        out=[]
        while len(out)<n:
            s=random.randint(0,max(0,n-blk)); out+=order[s:s+blk]
        means.append(sum(out[:n])/n)
    return round(quant(means,0.025),3), round(quant(means,0.5),3), round(quant(means,0.975),3)
bt=boot_trade(Rs); bb=boot_block(Rs,Ts)
boot={"trade_CI":{"lo":bt[0],"med":bt[1],"hi":bt[2]}, "block_CI":{"lo":bb[0],"med":bb[1],"hi":bb[2]}, "n_val_trades":len(Rs)}

# ── 6. fee/slippage stress ──
def expectancy_at_fee(mult):
    pv2.FEE=BASE_FEE*mult; pv2._ev={}  # clear cache để re-run với fee mới
    R,_=val_Rs(champ); pv2.FEE=BASE_FEE; pv2._ev={}
    if not R: return None
    g=sum(x for x in R if x>0); l=-sum(x for x in R if x<0)
    return {"mult":mult,"n":len(R),"mean":round(sum(R)/len(R),3),"PF":round(g/l,2) if l>0 else None}
fee_stress=[expectancy_at_fee(m) for m in (1.0,1.5,2.0)]

# ── verdict ──
reasons=[]
if bt[0] < -0.05: reasons.append(f"trade-bootstrap CI_lo {bt[0]} < -0.05 (chứa âm đáng kể)")
if bb[0] < -0.05: reasons.append(f"block-bootstrap CI_lo {bb[0]} < -0.05")
if passRate < 0.70: reasons.append(f"chỉ {passRate*100:.0f}% hàng xóm pass gates (<70%)")
if quant(scores,0.25) < 0: reasons.append(f"q25 plateau {quant(scores,0.25):.1f} < 0 (sườn dốc)")
if cluster["champion_cluster_frac"] < 0.5: reasons.append(f"champion cluster chỉ {cluster['champion_cluster_frac']*100:.0f}% (<50% — sống 1 điểm)")
if fee_stress[-1] and fee_stress[-1]["mean"] <= 0: reasons.append("fee 2x → expectancy ≤0")
verdict = "PLATEAU_ROBUST" if not reasons else "RESEARCH_ONLY_FRAGILE"

out={"audit_of":"PV_EVOLVER_v2 frozen champion","champion":champ,"plateau":plateau,"cluster":cluster,
     "bootstrap":boot,"fee_slippage_stress":fee_stress,"verdict":verdict,"reject_reasons":reasons,
     "note":"Audit của v2 đã freeze; KHÔNG đổi search space. PLATEAU_ROBUST mới đủ điều kiện tạo paper logger."}
json.dump(out, open(os.path.join(OUTDIR,"robustness-audit.json"),"w"), indent=2, default=str)

print(f"champion {champ}")
print(f"plateau: median {plateau['median']} q25 {plateau['q25_worst']} min {plateau['min']} max {plateau['max']} | passRate {plateau['passRate_gates']}")
print(f"cluster: champion {cluster['champion_cluster_size']}/{plateau['n_neighbors']} ({cluster['champion_cluster_frac']}) | largest {cluster['largest_cluster']} | {cluster['n_clusters']} clusters")
print(f"bootstrap trade CI: [{bt[0]}, {bt[2]}] med {bt[1]} | block CI: [{bb[0]}, {bb[2]}] | n={len(Rs)}")
print("fee stress:", fee_stress)
print(f"VERDICT: {verdict}")
for r in reasons: print("  reject:", r)
