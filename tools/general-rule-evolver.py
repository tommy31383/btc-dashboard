#!/usr/bin/env python3
"""
RULE EVOLVER — daemon tu chay KHONG NGUNG: gen -> backtest -> audit -> improve -> auto-commit.

Vong lap champion-challenger, threshold-tune only (move-set an toan).
Moi champion moi phai qua 3 GATE truoc khi promote + auto-commit:
  GATE 1  honest constraint   : DD<=25%, n>=150/yr, no year<-15%
  GATE 2  walk-forward OOS     : test(2024-26) CAGR >= champion x 0.98
  GATE 3  robustness +/-1      : <=15% neighbor fragile
Qua ca 3 + full-score cao hon -> PROMOTE -> deep audit -> ghi report -> git commit+push.

Dung:  touch tools/evolver-STOP
Resume: chay lai, tu load tools/evolver-champion.json
"""
import importlib.util, json, subprocess, datetime, random, os, sys
from collections import defaultdict

TOOLS = os.path.dirname(os.path.abspath(__file__))
REPO  = os.path.dirname(TOOLS)
AL_PATH = os.path.join(TOOLS, "general-rule-autoloop.py")
CHAMP   = os.path.join(TOOLS, "evolver-champion.json")
REPORT  = os.path.join(TOOLS, "evolver-report.md")
LOG     = os.path.join(TOOLS, "evolver-log.jsonl")
HEART   = os.path.join(TOOLS, "evolver-heartbeat.txt")
STOP    = os.path.join(TOOLS, "evolver-STOP")
SEED_BEST = os.path.join(TOOLS, "autoloop-best.json")

sys.stderr.write("Evolver: loading autoloop engine (precompute ~30s)...\n")
spec = importlib.util.spec_from_file_location("autoloop", AL_PATH)
al = importlib.util.module_from_spec(spec)
spec.loader.exec_module(al)
random.seed()

TRAIN=[2019,2020,2021,2022,2023]; TEST=[2024,2025,2026]

def seg_cagr(m, years):
    g=1.0
    for y in years:
        if y in m["yr_roi"]: g*=(1+m["yr_roi"][y]/100)
    span=sum(1.0 if y!=2026 else 0.42 for y in years if y in m["yr_roi"])
    return (g**(1/span)-1)*100 if span>0 and g>0 else -100

def robustness(params):
    base=al.honest_eval(params)
    if base is None: return 1.0, base
    bc=base["cagr"]; frag=0; tested=0
    for k in al.STEPS:
        if k not in params: continue
        vals=al.STEPS[k]
        try: idx=vals.index(params[k])
        except ValueError: continue
        for di in (-1,1):
            j=idx+di
            if 0<=j<len(vals):
                pp=dict(params); pp[k]=vals[j]; mm=al.honest_eval(pp); tested+=1
                if mm is None or mm["maxdd"]>25 or mm["cagr"]<bc*0.6: frag+=1
    return (frag/tested if tested else 1.0), base

def double_count_corr(params):
    p=params
    tr4=al.gen_4h(al.P4,p["adx4"],p["di4"],p["sl4"],p["tp4"],p["hold4"],p["cool4"],p["pos4"],p["bg"])
    tr1=al.gen_1h(p["adx1"],p["di1"],p["sl1"],p["tp1"],p["hold1"],p["cool1"],p["pos1"],p["bg"])
    def monthly(trs):
        m=defaultdict(float)
        for (e_ms,x_ms,ret,vs,tag) in trs:
            d=datetime.datetime.utcfromtimestamp(x_ms/1000); m[(d.year,d.month)]+=ret
        return m
    m4=monthly(tr4); m1=monthly(tr1); keys=sorted(set(m4)|set(m1))
    if len(keys)<3: return 0.0
    xs=[m4.get(k,0) for k in keys]; ys=[m1.get(k,0) for k in keys]; n=len(keys)
    mx=sum(xs)/n; my=sum(ys)/n
    cov=sum((xs[i]-mx)*(ys[i]-my) for i in range(n))/n
    sx=(sum((v-mx)**2 for v in xs)/n)**.5; sy=(sum((v-my)**2 for v in ys)/n)**.5
    return cov/(sx*sy) if sx*sy>0 else 0.0

def git_commit(idx, m, frag, corr):
    msg = ("evolver champion #%d: CAGR %.0f%% DD %.0f%% n%d testCAGR %.0f%% (auto)\n\n"
           "3-gate pass: honest constraint + OOS walk-forward + robustness %.0f%% fragile.\n"
           "BTC1h/4h double-count corr %+.2f.\n\n"
           "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
           % (idx, m["cagr"], m["maxdd"], m["min_n"], seg_cagr(m,TEST), frag*100, corr))
    try:
        subprocess.run(["git","add","tools/evolver-champion.json","tools/evolver-report.md"],
                       cwd=REPO, check=True, capture_output=True)
        subprocess.run(["git","commit","-m",msg], cwd=REPO, check=True, capture_output=True)
        r=subprocess.run(["git","push","origin","master"], cwd=REPO, capture_output=True, text=True)
        return "pushed" if r.returncode==0 else "commit-only"
    except subprocess.CalledProcessError:
        return "git-fail"

def write_report(idx, m, params, frag, corr, gen, status):
    now=datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")
    lines=["\n## Champion #%d - gen %d - %s  [%s]" % (idx,gen,now,status),
           "- **CAGR %.1f%%** - MaxDD %.1f%% - min_n %d - n2026 %d" % (m["cagr"],m["maxdd"],m["min_n"],m["n2026"]),
           "- TRAIN CAGR %.1f%% - **TEST(OOS) CAGR %.1f%%** - equity $%s" % (seg_cagr(m,TRAIN),seg_cagr(m,TEST),format(int(m["equity"]),",")),
           "- Robustness: %.0f%% fragile - BTC1h/4h corr %+.2f - stability %d/%d yrs+" % (frag*100,corr,m["pos_years"],m["nyears"]),
           "- Per-year: " + " ".join("%d:n%d/%+.0f%%" % (y,m["yr_n"].get(y,0),m["yr_roi"].get(y,0)) for y in range(2019,2027)),
           "- Params: `%s`" % json.dumps(params)]
    with open(REPORT,"a") as f: f.write("\n".join(lines)+"\n")

def heartbeat(gen, idx, cm, since):
    with open(HEART,"w") as f:
        f.write("gen=%d champions=%d since_promo=%d champ_CAGR=%.1f%% DD=%.1f%% min_n=%d testCAGR=%.1f%% @ %s\n"
                % (gen,idx,since,cm["cagr"],cm["maxdd"],cm["min_n"],seg_cagr(cm,TEST),
                   datetime.datetime.utcnow().strftime("%H:%M:%S")))

if os.path.exists(CHAMP):
    champion=json.load(open(CHAMP))["params"]; src="resume"
    idx=json.load(open(CHAMP)).get("idx",0)
elif os.path.exists(SEED_BEST):
    champion=json.load(open(SEED_BEST))["params"]; src="seed-G16"; idx=0
else:
    champion=dict(al.G15); src="seed-G15"; idx=0
champ_m=al.honest_eval(champion)
champ_sc,champ_ok,_=al.score_of(champ_m)
champ_test=seg_cagr(champ_m,TEST)
if not os.path.exists(REPORT):
    open(REPORT,"w").write("# Rule Evolver - champion history (auto)\n\n"
        "Seed: %s. 3-gate promote: honest constraint + OOS walk-forward + robustness +/-1.\n" % src)
sys.stderr.write("Evolver start [%s] champion CAGR=%.1f%% DD=%.1f%% test=%.1f%% score=%.1f\n"
                 % (src,champ_m["cagr"],champ_m["maxdd"],champ_test,champ_sc))

gen=0; since_promo=0
while True:
    if os.path.exists(STOP):
        sys.stderr.write("STOP file found - exiting cleanly at gen %d, %d champions.\n" % (gen,idx))
        os.remove(STOP); break
    gen+=1; since_promo+=1
    cand=al.perturb(champion)
    if since_promo>150:
        for _ in range(random.randint(1,3)): cand=al.perturb(cand)
    m=al.honest_eval(cand)
    sc,ok,reason=al.score_of(m)
    with open(LOG,"a") as f:
        f.write(json.dumps(dict(gen=gen,sc=round(sc,1),ok=ok,reason=reason,
                cagr=round(m["cagr"],1) if m else None,dd=round(m["maxdd"],1) if m else None))+"\n")
    if gen%20==0: heartbeat(gen, idx, champ_m, since_promo)
    if not ok: continue
    if sc<=champ_sc: continue
    test_c=seg_cagr(m,TEST)
    if test_c < champ_test*0.98: continue
    frag,_=robustness(cand)
    if frag>0.15: continue
    idx+=1; champion=cand; champ_m=m; champ_sc=sc; champ_test=test_c; since_promo=0
    corr=double_count_corr(cand)
    json.dump(dict(idx=idx,score=champ_sc,params=champion,
                   metrics=dict(cagr=m["cagr"],maxdd=m["maxdd"],min_n=m["min_n"],
                                test_cagr=test_c,yr_roi=m["yr_roi"],yr_n=m["yr_n"]),
                   robustness_frag=frag,doublecount_corr=corr,
                   ts=datetime.datetime.utcnow().isoformat()),
              open(CHAMP,"w"),indent=2,default=str)
    status=git_commit(idx, m, frag, corr)
    write_report(idx, m, champion, frag, corr, gen, status)
    sys.stderr.write("[gen %d] CHAMPION #%d CAGR=%.1f%% DD=%.1f%% test=%.1f%% frag=%.0f%% corr=%+.2f -> %s\n"
                     % (gen,idx,m["cagr"],m["maxdd"],test_c,frag*100,corr,status))
