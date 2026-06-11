#!/usr/bin/env python3
"""
PV_EVOLVER_v2 — nested/rolling walk-forward trên TOÀN BỘ development data (2019..2026-06).

NGUYÊN TẮC (spec Tommy 2026-06-11):
  - 2026 đã bị nhìn → KHÔNG còn "OOS" trong dữ liệu hiện có. Tất cả ≤2026-06 = DEVELOPMENT
    walk-forward. Validation THẬT tiếp theo = LIVE-FORWARD PAPER sau ngày freeze (≥6 tháng / 30 trades).
  - Frequency constraints/validation-window: ≥8 trades/năm quy đổi, ≥5 trades/window, không năm 0 trade.
  - Score = SHRINKAGE expectancy về 0 theo sample size (mean·n/(n+K)), KHÔNG mean R thô.
  - Concentration penalty: 1 trade không quá 30% tổng validation R.
  - Báo median R, profit factor, maxDD, stability giữa windows, sensitivity quanh tham số.
  - HOF diversity theo BEHAVIOR (tập timestamp lệnh), không chỉ khoảng cách tham số.
  - Freeze chỉ khi ≥40 validation trades tổng VÀ mọi frequency constraint pass VÀ concentration ≤30%.
  - Không deploy REAL. Không ghi production.

Outputs (pv-evolver-v2/): search-space.json, run-manifest.json, hof.json, champion-frozen.json,
  checkpoint.json (gitignore), evolver.log (gitignore). STOP: touch pv-evolver-v2/STOP.
"""
import json, os, sys, random, time, datetime, importlib.util, math

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "pv-evolver-v2"); os.makedirs(OUT, exist_ok=True)
STOP = os.path.join(OUT, "STOP")
spec = importlib.util.spec_from_file_location("pvev1", os.path.join(HERE, "pv-evolver-v1.py"))
pv1 = importlib.util.module_from_spec(spec); spec.loader.exec_module(pv1)   # reuse data + piv_ev (no drift)

VERSION = "PV_EVOLVER_v2"; SEED = 20260611
ROUND_CAP = int(os.environ.get("PV_ROUNDS", "30000"))
SLEEP = 0.003; HOF_SIZE = 12; FEE = pv1.FEE
SHRINK_K = 10.0                      # expectancy shrink: mean·n/(n+K)
MIN_VAL_TRADES = 40                  # freeze gate (tổng val)
MIN_PER_WINDOW = 5                   # freeze gate
MIN_PER_YEAR = 8                     # trades/năm quy đổi
CONC_MAX = 0.30                      # 1 trade ≤30% tổng val R
DD_PEN, DEGR_PEN, CONC_PEN, FREQ_PEN = 0.3, 6.0, 60.0, 25.0

# nested rolling walk-forward — anchored-expanding train + forward val year (2026 = dev fold)
WINDOWS = [
    {"train": (2019, 2021), "val": 2022},
    {"train": (2019, 2022), "val": 2023},
    {"train": (2019, 2023), "val": 2024},
    {"train": (2019, 2024), "val": 2025},
    {"train": (2019, 2025), "val": 2026},
]
YEAR_COVER = {2026: 0.45}            # 2026 chỉ ~Jan-Jun → quy đổi năm
DEV_YEARS = list(range(2019, 2027))

TF_CHOICES = pv1.TF_CHOICES
SPACE = {"tf":{"type":"categorical","choices":TF_CHOICES},"L":{"type":"int","min":2,"max":6},
         "volMult":{"type":"float","min":0.0,"max":2.5},"minRiskPct":{"type":"float","min":0.0,"max":1.5},
         "dir":{"type":"categorical","choices":["L","LS"]},"exitMode":{"type":"categorical","choices":["flip","tp"]},
         "tpR":{"type":"float","min":1.0,"max":4.0,"used_if":"exitMode==tp"}}

def run_v2(tf, c):
    """Trả trades: list (R, year, entry_ms). Tái dùng piv_ev của v1."""
    bars, evs, va = pv1.piv_ev(tf, c["L"]); n=len(bars)
    want = None if c["dir"]=="LS" else +1
    tpR = c["tpR"] if c["exitMode"]=="tp" else 0
    out=[]; i=0
    while i<n:
        e=evs.get(i)
        if e and (want is None or e[0]==want):
            direction, sl = e
            if c["volMult"]>0 and bars[i]["v"] < va[i]*c["volMult"]: i+=1; continue
            entry=bars[i]["c"]; risk=abs(entry-sl)
            if risk<=0 or risk/entry*100 < c["minRiskPct"]: i+=1; continue
            exit_px=None; j=i+1
            while j<n:
                if direction==+1:
                    if bars[j]["l"]<=sl: exit_px=sl; break
                    if tpR and bars[j]["h"]>=entry+tpR*risk: exit_px=entry+tpR*risk; break
                    oe=evs.get(j)
                    if oe and oe[0]==-1: exit_px=bars[j]["c"]; break
                else:
                    if bars[j]["h"]>=sl: exit_px=sl; break
                    if tpR and bars[j]["l"]<=entry-tpR*risk: exit_px=entry-tpR*risk; break
                    oe=evs.get(j)
                    if oe and oe[0]==+1: exit_px=bars[j]["c"]; break
                j+=1
            if exit_px is None: exit_px=bars[min(j,n-1)]["c"]
            raw=(exit_px-entry)/risk if direction==+1 else (entry-exit_px)/risk
            R=raw-(entry+exit_px)*FEE/risk
            out.append((R, bars[i]["yr"], bars[i]["t"])); i=j
        i+=1
    return out

def win_stats(trades, lo, hi):
    sub=[(r,t) for (r,y,t) in trades if lo<=y<=hi]
    n=len(sub)
    if n==0: return None
    Rs=[r for r,_ in sub]; ss=sorted(Rs)
    med = ss[n//2] if n%2 else (ss[n//2-1]+ss[n//2])/2
    eq=0;pk=0;mdd=0
    for r in Rs: eq+=r;pk=max(pk,eq);mdd=max(mdd,pk-eq)
    return {"n":n,"mean":sum(Rs)/n,"med":med,"tot":sum(Rs),"mdd":mdd,
            "win":sum(1 for r in Rs if r>0)/n*100,"ts":[t for _,t in sub],"Rs":Rs}

def profit_factor(Rs):
    g=sum(r for r in Rs if r>0); l=-sum(r for r in Rs if r<0)
    return (g/l) if l>0 else (float('inf') if g>0 else 0.0)

def evaluate(c):
    trades=run_v2(c["tf"], c)
    per=[]; degrs=[]; shrunks=[]; pos=0
    valRs=[]; valTs=[]
    for w in WINDOWS:
        tr=win_stats(trades,w["train"][0],w["train"][1]); vl=win_stats(trades,w["val"],w["val"])
        if not tr or not vl: return None
        shrunk = vl["mean"]*vl["n"]/(vl["n"]+SHRINK_K)
        shrunks.append(shrunk); degrs.append(max(0.0, tr["mean"]-vl["mean"]))
        pos += 1 if vl["tot"]>0 else 0
        valRs += vl["Rs"]; valTs += vl["ts"]
        yrs = YEAR_COVER.get(w["val"], 1.0); ann = vl["n"]/yrs
        per.append({"val":w["val"],"n":vl["n"],"ann":round(ann,1),"mean":round(vl["mean"],3),
                    "med":round(vl["med"],3),"tot":round(vl["tot"],2),"win":round(vl["win"],1),
                    "mdd":round(vl["mdd"],2),"trainMean":round(tr["mean"],3),"shrunk":round(shrunk,3)})
    N=len(valRs)
    if N==0: return None
    # pooled validation metrics
    eq=0;pk=0;mdd=0
    order=sorted(range(N), key=lambda k:valTs[k])
    for k in order: eq+=valRs[k]; pk=max(pk,eq); mdd=max(mdd,pk-eq)
    ss=sorted(valRs); med=ss[N//2] if N%2 else (ss[N//2-1]+ss[N//2])/2
    pf=profit_factor(valRs); netR=sum(valRs)
    conc = (max(valRs)/netR) if netR>0 else 1.0      # 1 trade chiếm bao nhiêu % net val R
    aggShrunk=sum(shrunks)/len(shrunks); posRatio=pos/len(WINDOWS); degr=sum(degrs)/len(degrs)
    # year-coverage (không năm nào 0 trade)
    yr_counts={y:0 for y in DEV_YEARS}
    for (_,y,_) in trades:
        if y in yr_counts: yr_counts[y]+=1
    zero_years=[y for y,ccnt in yr_counts.items() if ccnt==0]
    # frequency constraints (freeze gate)
    okN = N>=MIN_VAL_TRADES
    okWin = all(p["n"]>=MIN_PER_WINDOW for p in per)
    okAnn = all(p["ann"]>=MIN_PER_YEAR for p in per)
    okZero = len(zero_years)==0
    okConc = conc<=CONC_MAX
    freeze_ok = okN and okWin and okAnn and okZero and okConc
    # score (ranking): shrunk expectancy + stability, phạt DD/degr/concentration/freq-miss
    freq_miss = (0 if okWin else 1)+(0 if okAnn else 1)+(0 if okZero else 1)+(0 if okN else 1)
    score = 100*aggShrunk + 12*posRatio + 4*math.log(max(pf,0.01)) - DD_PEN*mdd - DEGR_PEN*degr \
            - CONC_PEN*max(0,conc-CONC_MAX) - FREQ_PEN*freq_miss
    return {"params":c,"score":round(score,2),"aggShrunk":round(aggShrunk,3),"posWinRatio":round(posRatio,2),
            "valN":N,"medR":round(med,3),"profitFactor":round(pf,2) if pf!=float('inf') else None,
            "valMaxDD":round(mdd,2),"concentration":round(conc,3),"trainValDegr":round(degr,3),
            "zeroYears":zero_years,"freezeEligible":freeze_ok,
            "freqPass":{"totalN>=40":okN,"perWindow>=5":okWin,"annualized>=8":okAnn,"noZeroYear":okZero,"conc<=0.30":okConc},
            "windows":per,"_ts":sorted(set(valTs))}

def jaccard(a,b):
    if not a or not b: return 0.0
    sa,sb=set(a),set(b); return len(sa&sb)/len(sa|sb)

def hof_add(hof, r):
    for idx,m in enumerate(hof):
        if jaccard(r["_ts"], m["_ts"])>0.6:          # behavior near-dup
            if r["score"]>m["score"]: hof[idx]=r
            return
    hof.append(r); hof.sort(key=lambda z:-z["score"]); del hof[HOF_SIZE:]

def strip(r):
    q=dict(r); q.pop("_ts",None); return q

def atomic(path,obj): tmp=path+".tmp"; json.dump(obj,open(tmp,"w"),indent=2,default=str); os.replace(tmp,path)
def log(m):
    line=f"{datetime.datetime.utcnow():%Y-%m-%d %H:%M:%S} {m}"; print(line,flush=True)
    open(os.path.join(OUT,"evolver.log"),"a",encoding="utf-8").write(line+"\n")

def sensitivity(champ):
    """Đo độ nhạy quanh champion: ±10% volMult & ±1 L → score thay đổi bao nhiêu."""
    base=champ["score"]; c=champ["params"]; out=[]
    for dv in (-0.2,0.2):
        cc=dict(c); cc["volMult"]=round(max(0,min(2.5,c["volMult"]+dv)),3); r=evaluate(cc)
        out.append({"perturb":f"volMult{dv:+}","score":r["score"] if r else None})
    for dl in (-1,1):
        cc=dict(c); cc["L"]=max(2,min(6,c["L"]+dl)); r=evaluate(cc)
        out.append({"perturb":f"L{dl:+}","score":r["score"] if r else None})
    return {"base":base,"neighbors":out}

def save(hof, rnd, started):
    atomic(os.path.join(OUT,"hof.json"),
        {"version":VERSION,"selection":"development walk-forward ONLY (no held-out OOS — 2026 already seen)",
         "rounds":rnd,"hof":[strip(z) for z in hof]})
    elig=[z for z in hof if z["freezeEligible"]]
    champ = elig[0] if elig else None
    obj={"version":VERSION,"frozen_at":f"{datetime.datetime.utcnow():%Y-%m-%dT%H:%M:%SZ}",
         "true_validation":"LIVE-FORWARD PAPER starting AFTER freeze date; ≥6 months or ≥30 trades; NO REAL.",
         "development_data":"2019-01..2026-06 (all seen → dev only, NOT OOS)"}
    if champ:
        obj["params"]=champ["params"]; obj["development_metrics"]=strip(champ)
        obj["sensitivity"]=sensitivity(champ)
    else:
        obj["params"]=None; obj["status"]="NO freeze-eligible candidate (frequency/concentration gates not met)"
    atomic(os.path.join(OUT,"champion-frozen.json"), obj)

def save_ckpt(rnd,rng,hof,best): atomic(os.path.join(OUT,"checkpoint.json"),
    {"version":VERSION,"round":rnd,"best":best,"rng":list(rng.getstate()),"hof":[strip(z)|{"_ts":z["_ts"]} for z in hof]})

def write_static(started):
    atomic(os.path.join(OUT,"search-space.json"),
        {"version":VERSION,"seed":SEED,"space":SPACE,"signal":"CHoCH(close-confirmed)+volume, SL=last opposite swing, OHLCV-only"})
    atomic(os.path.join(OUT,"run-manifest.json"),
        {"version":VERSION,"seed":SEED,"started":started,"data_file":"binance-1h-7y.json","data_sha256_16":pv1.DATA_SHA,
         "round_cap":ROUND_CAP,"hof_size":HOF_SIZE,"fee_per_side":FEE,"shrink_K":SHRINK_K,
         "windows":WINDOWS,"year_cover":YEAR_COVER,"dev_data":"2019..2026-06 ALL (no OOS; 2026 already seen)",
         "freeze_gates":{"min_val_trades":MIN_VAL_TRADES,"min_per_window":MIN_PER_WINDOW,"min_per_year":MIN_PER_YEAR,
                          "no_zero_year":True,"max_concentration":CONC_MAX},
         "score":{"shrinkage":"mean*n/(n+K)","posWinRatio":12,"logPF":4,"ddPen":DD_PEN,"degrPen":DEGR_PEN,"concPen":CONC_PEN,"freqPen":FREQ_PEN},
         "diversity":"behavior (Jaccard of validation trade timestamps >0.6 = near-dup)",
         "true_validation":"LIVE-FORWARD PAPER after freeze (>=6mo or >=30 trades). NO REAL deploy. No production writes."})

def main():
    started=f"{datetime.datetime.utcnow():%Y-%m-%dT%H:%M:%SZ}"
    if os.path.exists(STOP): os.remove(STOP)
    rng=random.Random(SEED); hof=[]; best=-1e9; rnd=0
    write_static(started); log(f"START {VERSION} seed={SEED} cap={ROUND_CAP} | DEV walk-forward, true-val=live-forward-paper")
    while rnd<ROUND_CAP and not os.path.exists(STOP):
        rnd+=1; c=pv1.rand_cand(rng)  # cùng sampler bounded của v1
        try: r=evaluate(c)
        except Exception: r=None
        if r:
            hof_add(hof,r)
            if hof[0]["score"]>best:
                best=hof[0]["score"]; h=hof[0]
                log(f"NEW BEST {h['score']:.1f} {h['params']} | shrunk{h['aggShrunk']:+.2f} PF{h['profitFactor']} valN{h['valN']} DD{h['valMaxDD']:.1f} conc{h['concentration']:.2f} freeze={h['freezeEligible']}")
                save(hof,rnd,started)
        if rnd%500==0: save_ckpt(rnd,rng,hof,best); log(f"round {rnd}/{ROUND_CAP} best={best:.1f} eligible={sum(1 for z in hof if z['freezeEligible'])}")
        time.sleep(SLEEP)
    save_ckpt(rnd,rng,hof,best); save(hof,rnd,started)
    elig=[z for z in hof if z["freezeEligible"]]
    log(f"DONE round {rnd}. freeze-eligible in HOF: {len(elig)}")
    for z in hof[:5]:
        log(f"  {z['score']:.1f} {z['params']} shrunk{z['aggShrunk']:+.2f} PF{z['profitFactor']} valN{z['valN']} conc{z['concentration']:.2f} freeze={z['freezeEligible']}")
    log("True validation = LIVE-FORWARD PAPER sau freeze. KHÔNG mở 'OOS' từ data cũ. KHÔNG deploy REAL.")

if __name__=="__main__":
    main()
