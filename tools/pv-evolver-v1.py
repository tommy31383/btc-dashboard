#!/usr/bin/env python3
"""
PV_EVOLVER_v1 — search space versioned cho signal price-action+volume (CHoCH + volume), OHLCV-only.

NGUYÊN TẮC (spec Tommy 2026-06-11):
  - Selection CHỈ dùng TRAIN/VALIDATION (rolling walk-forward nhiều cửa sổ). KHÔNG đụng OOS trong loop.
  - OOS (2026) FREEZE — chỉ mở 1 lần cho champion đã freeze, ở bước riêng (không nằm trong file này).
  - Score = risk-adjusted trên VALIDATION: mean+median R, positive-window ratio, maxDD penalty,
    min-trade penalty, train→validation degradation penalty.
  - Continuous params bounded + seed reproducible. Diversity constraint cho HOF. Checkpoint atomic,
    resume được, STOP graceful. Không fetch mạng trong loop. Không deploy/ghi production config.

Outputs (pv-evolver-v1/): search-space.json, run-manifest.json, hof.json, champion-frozen.json,
  checkpoint.json (atomic+resume), evolver.log. STOP: touch pv-evolver-v1/STOP.
"""
import json, datetime, os, sys, random, time, hashlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "pv-evolver-v1")
CACHE = os.path.join(HERE, "..", ".cache", "binance-1h-7y.json")
STOP = os.path.join(OUT, "STOP")
os.makedirs(OUT, exist_ok=True)

VERSION = "PV_EVOLVER_v1"
SEED = 20260611
ROUND_CAP = int(os.environ.get("PV_ROUNDS", "1500"))   # smoke=1500; full = lớn hơn
SLEEP_PER_ROUND = 0.004                                  # CPU throttle, no network in loop
HOF_SIZE = 12
MIN_TRADES = 40                                          # tổng val trades tối thiểu
FEE = 0.0005

# ── rolling walk-forward windows (anchored-expanding train + forward validation year) ──
WINDOWS = [
    {"train": (2019, 2021), "val": 2022},
    {"train": (2019, 2022), "val": 2023},
    {"train": (2019, 2023), "val": 2024},
    {"train": (2019, 2024), "val": 2025},
]
OOS_FROZEN = (2026, 2026)   # KHÔNG dùng trong loop

# ── score weights (manifest) ──
W_MEAN, W_MED, W_POS = 0.5, 0.3, 0.2
DD_PEN, DEGR_PEN, TRADE_PEN = 0.4, 8.0, 0.5

# ── search space (bounded) ──
TF_CHOICES = ["1h", "2h", "4h", "6h", "12h", "1d"]
SPACE = {
    "tf": {"type": "categorical", "choices": TF_CHOICES},
    "L": {"type": "int", "min": 2, "max": 6},
    "volMult": {"type": "float", "min": 0.0, "max": 2.5},
    "minRiskPct": {"type": "float", "min": 0.0, "max": 1.5},
    "dir": {"type": "categorical", "choices": ["L", "LS"]},
    "exitMode": {"type": "categorical", "choices": ["flip", "tp"]},
    "tpR": {"type": "float", "min": 1.0, "max": 4.0, "used_if": "exitMode==tp"},
}
TF_MS = {"1h":3600_000,"2h":2*3600_000,"4h":4*3600_000,"6h":6*3600_000,"12h":12*3600_000,"1d":86400_000}

# ── data (load ONCE, aggregate cached — no network in inner loop) ──
RAW = json.load(open(CACHE)); RAW.sort(key=lambda x: x["time"])
DATA_SHA = hashlib.sha256(open(CACHE, "rb").read()).hexdigest()[:16]
_agg = {}
def load_agg(tf):
    if tf in _agg: return _agg[tf]
    ms = TF_MS[tf]; b = {}
    for c in RAW:
        k = c["time"]//ms
        if k not in b: b[k] = {"t": k*ms, "o": c["open"], "h": c["high"], "l": c["low"], "c": c["close"], "v": c["volume"]}
        else:
            o=b[k]; o["h"]=max(o["h"],c["high"]); o["l"]=min(o["l"],c["low"]); o["c"]=c["close"]; o["v"]+=c["volume"]
    bars=[b[k] for k in sorted(b)]
    for x in bars: x["yr"]=datetime.datetime.utcfromtimestamp(x["t"]/1000).year
    _agg[tf]=bars; return bars

_ev = {}
def piv_ev(tf, L):
    ck=(tf,L)
    if ck in _ev: return _ev[ck]
    bars=load_agg(tf); n=len(bars); piv=[None]*n
    for i in range(L,n-L):
        w=range(i-L,i+L+1)
        if all(bars[i]["h"]>=bars[j]["h"] for j in w) and any(bars[i]["h"]>bars[j]["h"] for j in w if j!=i): piv[i]="H"
        elif all(bars[i]["l"]<=bars[j]["l"] for j in w) and any(bars[i]["l"]<bars[j]["l"] for j in w if j!=i): piv[i]="L"
    evs={}; trend="RANGE"; recH=recL=cfH=cfL=None
    for i in range(n):
        j=i-L
        if j>=0 and piv[j]=="H": recH=bars[j]["h"]; cfH=bars[j]["h"]
        if j>=0 and piv[j]=="L": recL=bars[j]["l"]; cfL=bars[j]["l"]
        c=bars[i]["c"]
        if recH and c>recH:
            if trend=="DOWN" and cfL: evs[i]=(+1,cfL)
            trend="UP"; recH=None
        elif recL and c<recL:
            if trend=="UP" and cfH: evs[i]=(-1,cfH)
            trend="DOWN"; recL=None
    # precompute vol avg
    va=[0.0]*n; s=0.0;
    from collections import deque
    dq=deque()
    for i in range(n):
        dq.append(bars[i]["v"]); s+=bars[i]["v"]
        if len(dq)>20: s-=dq.popleft()
        va[i]=s/len(dq)
    _ev[ck]=(bars,evs,va); return _ev[ck]

def run_trades(tf, c):
    bars,evs,va = piv_ev(tf, c["L"]); n=len(bars)
    want = None if c["dir"]=="LS" else +1
    tpR = c["tpR"] if c["exitMode"]=="tp" else 0
    trades=[]; i=0
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
                    oe=evs.get(j);
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
            trades.append((R, bars[i]["yr"])); i=j
        i+=1
    return trades

def wm(trades, lo, hi):
    sub=[r for (r,y) in trades if lo<=y<=hi]
    n=len(sub)
    if n==0: return None
    ss=sorted(sub); med=ss[n//2] if n%2 else (ss[n//2-1]+ss[n//2])/2
    eq=0;pk=0;mdd=0
    for r in sub: eq+=r;pk=max(pk,eq);mdd=max(mdd,pk-eq)
    return {"n":n,"avg":sum(sub)/n,"med":med,"tot":sum(sub),"mdd":mdd,"win":sum(1 for r in sub if r>0)/n*100}

def evaluate(c):
    """Score CHỈ trên train/validation. Trả None nếu không đủ điều kiện. KHÔNG đụng OOS."""
    tf=c["tf"]; trades=run_trades(tf,c)
    wins=[]; degrs=[]; valN=0; maxdd=0; pos=0; means=[]; meds=[]
    for w in WINDOWS:
        tr=wm(trades,w["train"][0],w["train"][1]); vl=wm(trades,w["val"],w["val"])
        if not tr or not vl: return None
        if tr["avg"]<=0: return None            # gate: phải có edge trên train
        means.append(vl["avg"]); meds.append(vl["med"]); valN+=vl["n"]
        maxdd=max(maxdd,vl["mdd"]); pos += 1 if vl["tot"]>0 else 0
        degrs.append(max(0.0, tr["avg"]-vl["avg"]))
        wins.append({"val":w["val"],"trainAvg":round(tr["avg"],3),"valAvg":round(vl["avg"],3),
                     "valMed":round(vl["med"],3),"valN":vl["n"],"valTot":round(vl["tot"],2),
                     "valWin":round(vl["win"],1),"valMdd":round(vl["mdd"],2)})
    meanAvg=sum(means)/len(means); meanMed=sum(meds)/len(meds); posRatio=pos/len(WINDOWS)
    degr=sum(degrs)/len(degrs)
    score = 100*(W_MEAN*meanAvg + W_MED*meanMed + W_POS*posRatio) - DD_PEN*maxdd - DEGR_PEN*degr - TRADE_PEN*max(0, MIN_TRADES-valN)
    return {"params":c, "score":round(score,2), "valMeanAvg":round(meanAvg,3), "valMeanMed":round(meanMed,3),
            "posWinRatio":round(posRatio,2), "valTotN":valN, "valMaxDD":round(maxdd,2),
            "trainValDegr":round(degr,3), "windows":wins}

def rand_cand(rng):
    em = rng.choice(["flip","tp"])
    return {"tf":rng.choice(TF_CHOICES), "L":rng.randint(2,6),
            "volMult":round(rng.uniform(0,2.5),3), "minRiskPct":round(rng.uniform(0,1.5),3),
            "dir":rng.choice(["L","LS"]), "exitMode":em, "tpR":round(rng.uniform(1,4),2) if em=="tp" else 0.0}

def near_dup(a, b):
    return (a["tf"]==b["tf"] and a["dir"]==b["dir"] and a["exitMode"]==b["exitMode"] and a["L"]==b["L"]
            and abs(a["volMult"]-b["volMult"])<0.25 and abs(a["minRiskPct"]-b["minRiskPct"])<0.25)

def hof_add(hof, r):
    # diversity: nếu trùng gần 1 member → chỉ thay khi score cao hơn; else thêm mới
    for idx,m in enumerate(hof):
        if near_dup(r["params"], m["params"]):
            if r["score"]>m["score"]: hof[idx]=r
            return
    hof.append(r)
    hof.sort(key=lambda z:-z["score"]); del hof[HOF_SIZE:]

def atomic_write(path, obj):
    tmp=path+".tmp"; json.dump(obj, open(tmp,"w"), indent=2); os.replace(tmp, path)

def log(msg):
    line=f"{datetime.datetime.utcnow():%Y-%m-%d %H:%M:%S} {msg}"; print(line, flush=True)
    open(os.path.join(OUT,"evolver.log"),"a",encoding="utf-8").write(line+"\n")

def save_checkpoint(rnd, rng, hof, best):
    atomic_write(os.path.join(OUT,"checkpoint.json"),
        {"version":VERSION,"round":rnd,"best":best,"rng":list(rng.getstate()),"hof":hof})

def save_outputs(hof, rnd, started):
    atomic_write(os.path.join(OUT,"hof.json"),
        {"version":VERSION,"selection":"train+validation ONLY (OOS untouched)","rounds":rnd,"hof":hof})
    if hof:
        champ=hof[0]
        atomic_write(os.path.join(OUT,"champion-frozen.json"),
            {"version":VERSION,"frozen_at":f"{datetime.datetime.utcnow():%Y-%m-%dT%H:%M:%SZ}",
             "params":champ["params"],"train_validation":champ,
             "oos":{"window":OOS_FROZEN,"status":"FROZEN — NOT evaluated (open once, separately)"}})

def write_static(started):
    atomic_write(os.path.join(OUT,"search-space.json"),
        {"version":VERSION,"seed":SEED,"space":SPACE,"signal":"CHoCH (close-confirmed) + volume filter, SL=last opposite swing, OHLCV-only"})
    atomic_write(os.path.join(OUT,"run-manifest.json"),
        {"version":VERSION,"seed":SEED,"started":started,"data_file":"binance-1h-7y.json","data_sha256_16":DATA_SHA,
         "round_cap":ROUND_CAP,"sleep_per_round_s":SLEEP_PER_ROUND,"hof_size":HOF_SIZE,"min_val_trades":MIN_TRADES,"fee_per_side":FEE,
         "windows":WINDOWS,"oos_frozen":OOS_FROZEN,"oos_policy":"NOT used for selection; open once for frozen champion only",
         "score_weights":{"mean":W_MEAN,"median":W_MED,"posWinRatio":W_POS,"ddPenalty":DD_PEN,"degrPenalty":DEGR_PEN,"tradePenalty":TRADE_PEN},
         "no_network_in_loop":True,"writes_production":False,"deploys_live":False})

def main():
    started=f"{datetime.datetime.utcnow():%Y-%m-%dT%H:%M:%SZ}"
    if os.path.exists(STOP): os.remove(STOP)
    rng=random.Random(SEED); hof=[]; rnd0=0; best=-1e9
    ckpt=os.path.join(OUT,"checkpoint.json")
    if "--resume" in sys.argv and os.path.exists(ckpt):
        st=json.load(open(ckpt)); rnd0=st["round"]; best=st["best"]; hof=st["hof"]
        s=st["rng"]; rng.setstate((s[0], tuple(s[1]), s[2])); log(f"RESUME từ round {rnd0}, HOF={len(hof)}")
    write_static(started)
    log(f"START {VERSION} seed={SEED} data_sha={DATA_SHA} cap={ROUND_CAP} | selection=TRAIN+VAL, OOS frozen={OOS_FROZEN}")
    rnd=rnd0
    while rnd < ROUND_CAP and not os.path.exists(STOP):
        rnd+=1
        c=rand_cand(rng)
        try: r=evaluate(c)
        except Exception: r=None
        if r:
            hof_add(hof, r)
            if hof[0]["score"]>best:
                best=hof[0]["score"]; w=r if r["score"]==best else hof[0]
                log(f"NEW BEST score={hof[0]['score']:.1f} {hof[0]['params']} | valMeanAvg{hof[0]['valMeanAvg']:+.2f} med{hof[0]['valMeanMed']:+.2f} posWin{hof[0]['posWinRatio']:.2f} valN{hof[0]['valTotN']} DD{hof[0]['valMaxDD']:.1f} degr{hof[0]['trainValDegr']:.2f}")
                save_outputs(hof, rnd, started)
        if rnd % 300 == 0:
            save_checkpoint(rnd, rng, hof, best); log(f"round {rnd}/{ROUND_CAP} | HOF={len(hof)} best={best:.1f}")
        time.sleep(SLEEP_PER_ROUND)
    save_checkpoint(rnd, rng, hof, best); save_outputs(hof, rnd, started)
    reason = "STOP file" if os.path.exists(STOP) else "round cap"
    log(f"DONE ({reason}) round {rnd}. HOF top:")
    for z in hof[:5]:
        log(f"  score{z['score']:.1f} {z['params']} valMeanAvg{z['valMeanAvg']:+.2f} posWin{z['posWinRatio']:.2f} valN{z['valTotN']} DD{z['valMaxDD']:.1f}")
    log("OOS CHƯA mở — champion-frozen.json sẵn sàng cho bước OOS riêng.")

if __name__=="__main__":
    main()
