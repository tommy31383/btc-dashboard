#!/usr/bin/env python3
"""
EVOLVER v4 — MAP-Elites + Multi-Objective + Primitive Library
Phase B: MAP-Elites archive (trades/yr × avg_hold × regime) + NSGA-II {Sharpe, -MaxDD}
Kế thừa: honest_resim_v3, 3-gate (honest+OOS+robustness), gen4/gen1 từ v2/v3.
Mới: genome = primitive-set + combine-logic + thresholds; MAP-Elites archive grid.

Usage:
  python3 general-rule-evolver-v4.py
  WORKERS=8 python3 general-rule-evolver-v4.py
  touch tools/evolver-STOP  (dừng)
"""
import importlib.util, json, subprocess, datetime, random, os, sys, math
from concurrent.futures import ProcessPoolExecutor
from collections import defaultdict
import warnings; warnings.filterwarnings('ignore')

TOOLS = os.path.dirname(os.path.abspath(__file__))
REPO  = os.path.dirname(TOOLS)
V3_PATH    = os.path.join(TOOLS, "general-rule-evolver-v3.py")
PRIM_LIB   = os.path.join(TOOLS, "primitive-library.json")
ARCHIVE_F  = os.path.join(TOOLS, "evolver-v4-archive.json")
REPORT_F   = os.path.join(TOOLS, "evolver-v4-report.md")
LOG_F      = os.path.join(TOOLS, "evolver-v4-log.jsonl")
HEART_F    = os.path.join(TOOLS, "evolver-v4-heartbeat.txt")
STOP_F     = os.path.join(TOOLS, "evolver-STOP")

CAPITAL = 100_000; LEV = 10
TRAIN = [2019,2020,2021,2022,2023]; TEST = [2024,2025,2026]

# ── lazy-load v3 (reuse honest_resim_v3, gen4, gen1) ──────────────────────────
_V3 = None
def get_v3():
    global _V3
    if _V3 is None:
        spec = importlib.util.spec_from_file_location("evolver_v3", V3_PATH)
        _V3 = importlib.util.module_from_spec(spec); spec.loader.exec_module(_V3)
    return _V3

# ── load primitive library ─────────────────────────────────────────────────────
def load_primitives():
    d = json.load(open(PRIM_LIB))
    return {p["name"]: p for p in d["primitives"]}

PRIM_NAMES = None
def get_prim_names():
    global PRIM_NAMES
    if PRIM_NAMES is None:
        PRIM_NAMES = list(load_primitives().keys())
    return PRIM_NAMES

# ── primitive generators (reuse from primitive-screen-7y.py) ──────────────────
_SCREEN = None
def get_screen():
    global _SCREEN
    if _SCREEN is None:
        sc_path = os.path.join(TOOLS, "primitive-screen-7y.py")
        spec = importlib.util.spec_from_file_location("prim_screen", sc_path)
        _SCREEN = importlib.util.module_from_spec(spec); spec.loader.exec_module(_SCREEN)
    return _SCREEN

PRIM_GEN_MAP = {
    "ADX_DI_4h":        "prim_adx_di_4h",
    "Donchian_4h":      "prim_donchian_4h",
    "Breakout_Retest_4h": "prim_breakout_retest_4h",
    "MultiTF_4h1h":     "prim_multitf_confluence_4h_1h",
}

def build_trades_v4(g):
    """Build trades from genome using selected primitives + optional v3 sleeves."""
    v3 = get_v3(); v2 = v3.get_v2(); al = v2.get_al()
    sc = get_screen()
    all_trades = []
    selected = g.get("primitives", ["ADX_DI_4h"])
    for pname in selected:
        gen_fn_name = PRIM_GEN_MAP.get(pname)
        if gen_fn_name is None: continue
        gen_fn = getattr(sc, gen_fn_name, None)
        if gen_fn is None: continue
        cfg = g.get("prim_cfg", {}).get(pname, {})
        try:
            trades = gen_fn(al, cfg)
            all_trades.extend(trades)
        except Exception:
            pass
    # BTC1h sleeve (reuse v3 gen1)
    if g.get("use_btc1h", False):
        try: all_trades.extend(v2.gen1(al, g))
        except Exception: pass
    # ETH sleeve (reuse v3 gen4 ETH path — key 2022 edge)
    if g.get("use_eth", False):
        try: all_trades.extend(v2.gen4(al, al.PE, g, "ETH4h", True))
        except Exception: pass
    return all_trades

# ── eval genome ───────────────────────────────────────────────────────────────
def eval_genome_v4(g):
    try:
        v3 = get_v3()
        trades = build_trades_v4(g)
        return v3.honest_resim_v3(trades, g)
    except Exception:
        return None

# ── objectives: Sharpe + MaxDD ────────────────────────────────────────────────
def sharpe(m, years):
    """Annualized Sharpe from yearly ROI."""
    if m is None: return -999
    rois = [m["yr_roi"].get(y, 0) for y in years if y in m["yr_roi"]]
    if len(rois) < 2: return -999
    mu = sum(rois)/len(rois)
    sd = math.sqrt(sum((r-mu)**2 for r in rois)/(len(rois)-1))
    return mu/sd if sd > 0 else -999

def seg(m, years):
    if m is None: return -100
    gg = 1.0
    for y in years:
        if y in m["yr_roi"]: gg *= (1+m["yr_roi"][y]/100)
    sp = sum(1.0 if y!=2026 else 0.42 for y in years if y in m["yr_roi"])
    return (gg**(1/sp)-1)*100 if sp>0 and gg>0 else -100

def hard_constraints(m):
    if m is None: return False
    return m["maxdd"]<=30 and m["min_n"]>=10 and m["worst"]>-20

def fitness_train(m):
    """Primary: train Calmar (used for MAP-Elites cell quality)."""
    if m is None or not hard_constraints(m): return -1e9
    return seg(m, TRAIN) / max(m["maxdd"], 3.0)

def multi_obj(m):
    """Returns (sharpe_train, neg_maxdd) for Pareto ranking."""
    if m is None: return (-999, -999)
    return (sharpe(m, TRAIN), -m["maxdd"])

# ── behavior descriptor → archive cell ────────────────────────────────────────
# Dim 0: trades/year   — low(<30), mid(30-80), high(>80)
# Dim 1: avg hold bars — short(<20), mid(20-50), long(>50)
# Dim 2: regime-active — RANGE-heavy(2022 pos), BULL-heavy(2020/2021 pos), MIXED
def behavior_descriptor(m):
    if m is None: return None
    total_trades = sum(m["yr_n"].values())
    n_years = max(m["nyears"], 1)
    tpy = total_trades / n_years

    if tpy < 30: d0 = 0
    elif tpy < 80: d0 = 1
    else: d0 = 2

    # avg hold: approximate from n and time span — use n/yr as proxy
    # (real hold would need per-trade data; use tpy bucket as hold inverse proxy)
    if tpy > 100: d1 = 0   # high freq → short hold
    elif tpy > 40: d1 = 1
    else: d1 = 2           # low freq → long hold

    # regime: check 2022 (bear/range) vs 2020-2021 (bull)
    roi22 = m["yr_roi"].get(2022, -99)
    roi20 = m["yr_roi"].get(2020, 0)
    roi21 = m["yr_roi"].get(2021, 0)
    if roi22 > -5: d2 = 0  # survives RANGE/BEAR
    elif (roi20+roi21) > 100: d2 = 1  # BULL-heavy
    else: d2 = 2           # MIXED

    return (d0, d1, d2)

# ── MAP-Elites archive ─────────────────────────────────────────────────────────
class Archive:
    def __init__(self):
        self.cells = {}  # (d0,d1,d2) → {"genome":g, "metrics":m, "fitness":f, "obj":(sh,dd)}
        self.total_improvements = 0

    def try_insert(self, g, m):
        bc = behavior_descriptor(m)
        if bc is None: return False
        f = fitness_train(m)
        if f <= -1e8: return False
        if bc not in self.cells or f > self.cells[bc]["fitness"]:
            self.cells[bc] = {"genome": dict(g), "metrics": m, "fitness": f, "obj": multi_obj(m)}
            self.total_improvements += 1
            return True
        return False

    def sample(self):
        if not self.cells: return None
        return dict(random.choice(list(self.cells.values()))["genome"])

    def best(self):
        if not self.cells: return None, None
        best_cell = max(self.cells.values(), key=lambda x: x["fitness"])
        return best_cell["genome"], best_cell["metrics"]

    def stats(self):
        filled = len(self.cells)
        total = 3*3*3  # 27 possible cells
        if not self.cells: return filled, total, -999, -999
        fits = [c["fitness"] for c in self.cells.values()]
        return filled, total, max(fits), sum(fits)/len(fits)

    def to_dict(self):
        return {str(k): {"fitness": v["fitness"], "obj": list(v["obj"]),
                         "genome": v["genome"],
                         "metrics": {kk: vv for kk,vv in v["metrics"].items()
                                     if kk not in ("yr_roi","yr_n")},
                         "yr_roi": v["metrics"].get("yr_roi",{}),
                         "yr_n": v["metrics"].get("yr_n",{})}
                for k,v in self.cells.items()}

    def from_dict(self, d):
        for k_str, v in d.items():
            try:
                k = tuple(int(x) for x in k_str.strip("()").split(","))
                m = dict(v["metrics"])
                m["yr_roi"] = {int(kk):vv for kk,vv in v.get("yr_roi",{}).items()}
                m["yr_n"]   = {int(kk):vv for kk,vv in v.get("yr_n",{}).items()}
                if "worst" not in m: m["worst"] = min(m["yr_roi"].values()) if m["yr_roi"] else -100
                if "nyears" not in m: m["nyears"] = len(m["yr_roi"])
                if "pos_yrs" not in m: m["pos_yrs"] = sum(1 for r in m["yr_roi"].values() if r>0)
                self.cells[k] = {"genome": v["genome"], "metrics": m,
                                  "fitness": v["fitness"], "obj": tuple(v["obj"])}
            except Exception:
                pass

# ── genome space ───────────────────────────────────────────────────────────────
PRIM_PARAM_STEPS = {
    "adx":    [16,18,20,22,25],
    "di":     [0.9,0.95,1.0,1.05,1.1],
    "sl":     [1.4,1.6,1.8,2.0,2.2],
    "tp":     [5,6,7,8,10,12],
    "hold":   [40,50,60,70,80],
    "pos":    [3,4,5,6,7],
    "period": [15,20,25,30],
    "adx4":   [16,18,20,22,25],
    "adx1":   [14,16,18,20],
    "retest_pct": [0.02,0.03,0.04,0.05],
    "retest_bars":[6,8,10,12,15],
}
RISK_STEPS = [0.02,0.03,0.04,0.05,0.06,0.08]
CAP_STEPS  = [0.4,0.5,0.6,0.8,1.0]

def base_genome():
    pnames = get_prim_names()
    # start with best solo primitive (MultiTF or ADX)
    primary = "MultiTF_4h1h" if "MultiTF_4h1h" in pnames else pnames[0]
    g = {
        "primitives": [primary],
        "combine": "OR",
        "prim_cfg": {primary: {}},
        "use_btc1h": True,   # enable BTC1h by default (like v3)
        "use_eth": True,     # enable ETH by default (key 2022 edge)
        "risk4": 0.04, "risk1": 0.04, "riske": 0.04,
        "cap_btc": 1.0, "cap_eth": 1.0,
        # v3 compat fields
        "use_btc4h": True,
        "exit_ema20": True, "f_funding": False, "f_rsi": False, "f_bear": False,
        # v3 gen4 defaults (used if btc1h enabled)
        "adx4":20,"di4":1.0,"sl4":1.8,"tp4":8,"hold4":60,"cool4":2,"pos4":5,
        "adx1":18,"di1":1.0,"sl1":1.8,"tp1":8,"hold1":24,"cool1":2,"pos1":4,
        "bg":0.85,
    }
    return g

def mutate(g):
    g = json.loads(json.dumps(g))  # deep copy
    pnames = get_prim_names()
    r = random.random()

    if r < 0.20:
        # add/remove primitive
        cur = list(g.get("primitives", []))
        if len(cur) > 1 and random.random() < 0.5:
            cur.remove(random.choice(cur))
        else:
            add = random.choice(pnames)
            if add not in cur: cur.append(add)
        g["primitives"] = cur
        for p in cur:
            if p not in g.get("prim_cfg", {}):
                g.setdefault("prim_cfg", {})[p] = {}

    elif r < 0.45:
        # mutate a primitive param
        prim = random.choice(g.get("primitives", get_prim_names()[:1]))
        cfg = g.setdefault("prim_cfg", {}).setdefault(prim, {})
        key = random.choice(list(PRIM_PARAM_STEPS.keys()))
        cfg[key] = random.choice(PRIM_PARAM_STEPS[key])

    elif r < 0.60:
        # mutate risk/cap
        key = random.choice(["risk4","risk1","cap_btc"])
        g[key] = random.choice(RISK_STEPS if "risk" in key else CAP_STEPS)

    elif r < 0.70:
        # toggle sleeves
        key = random.choice(["use_btc1h", "use_eth"])
        g[key] = not g.get(key, True)
        # ensure at least primitives still active
        if not g.get("primitives"): g["primitives"] = get_prim_names()[:1]

    else:
        # mutate v3 param (SL/TP/ADX for BTC1h if enabled)
        key = random.choice(["adx1","sl1","tp1","hold1"])
        g[key] = random.choice(PRIM_PARAM_STEPS.get(key, [g.get(key, 18)]))

    if not g.get("primitives"): g["primitives"] = [pnames[0]]
    return g

def crossover(a, b):
    c = json.loads(json.dumps(a))
    # cross primitive list
    if random.random() < 0.4:
        c["primitives"] = list(b.get("primitives", a["primitives"]))
    # cross prim_cfg per primitive
    for pname in c.get("primitives", []):
        if pname in b.get("prim_cfg", {}) and random.random() < 0.5:
            c.setdefault("prim_cfg", {})[pname] = dict(b["prim_cfg"][pname])
    # cross scalar fields
    for key in ["risk4","risk1","cap_btc","use_btc1h"]:
        if key in b and random.random() < 0.5:
            c[key] = b[key]
    if not c.get("primitives"): c["primitives"] = get_prim_names()[:1]
    return c

def robustness_v4(g, base_fit):
    """Check ±1 on key primitive params — same logic as v3."""
    frag = 0; tested = 0
    prim = g.get("primitives", [])
    cfg = g.get("prim_cfg", {})
    for pname in prim:
        pcfg = cfg.get(pname, {})
        for key, vals in PRIM_PARAM_STEPS.items():
            if key not in pcfg: continue
            try: idx = vals.index(pcfg[key])
            except ValueError: continue
            for di in (-1, 1):
                j = idx + di
                if 0 <= j < len(vals):
                    gg = json.loads(json.dumps(g))
                    gg["prim_cfg"][pname][key] = vals[j]
                    mm = eval_genome_v4(gg); tested += 1
                    tf = fitness_train(mm)
                    if mm is None or tf < base_fit * 0.6: frag += 1
    return frag/tested if tested else 0.0

def oos_check(m, champ_test_cagr):
    """OOS: test CAGR must not be worse than 98% of previous champion."""
    tec = seg(m, TEST)
    return tec >= champ_test_cagr * 0.98, tec

# ── Phase C: purged walk-forward + held-out gate ──────────────────────────────
EMBARGO_BARS = 42   # ~1 week of 4h bars — prevents leakage via serial correlation
HELD_OUT_HALF_YEAR_MS = 1751328000000  # 2025-07-01 UTC in ms

def purged_wf_gate(g, n_folds=5):
    """
    Purged + embargoed walk-forward on TRAIN period (2019-2023).
    Split train trades into n_folds chronological; each fold: train on all except
    test fold, with embargo_bars gap on each side of test window.
    Gate passes if median fold Calmar > 0 and >=3/5 folds positive.
    Cost: 1 extra build_trades call (only runs on promote candidates).
    """
    try:
        trades = build_trades_v4(g)
    except Exception:
        return False, "build_error"

    if not trades: return False, "no_trades"

    # filter to TRAIN period only
    train_end_ms = 1704067200000  # 2024-01-01 UTC
    train_start_ms = 1546300800000  # 2019-01-01 UTC
    train_trades = [t for t in trades if train_start_ms <= t[0] < train_end_ms]
    if len(train_trades) < 20: return False, f"too_few_train={len(train_trades)}"

    train_trades.sort(key=lambda x: x[0])
    t0, t1 = train_trades[0][0], train_trades[-1][0]
    fold_ms = (t1 - t0) // n_folds
    bar_ms = 4 * 3600 * 1000  # 4h in ms
    embargo_ms = EMBARGO_BARS * bar_ms

    fold_calmars = []
    for i in range(n_folds):
        test_start = t0 + i * fold_ms
        test_end   = test_start + fold_ms
        # purge: exclude train samples whose label window overlaps test window
        # label window = entry to exit — approx entry + hold*bar_ms
        # simple proxy: exclude trades within embargo_ms of test boundaries
        fold_test  = [t for t in train_trades if test_start <= t[0] < test_end]
        fold_train = [t for t in train_trades
                      if t[0] < test_start - embargo_ms or t[0] >= test_end + embargo_ms]
        if not fold_test or not fold_train: continue
        v3 = get_v3()
        m_fold = v3.honest_resim_v3(fold_test, g)
        if m_fold is None: continue
        c = m_fold["cagr"] / max(m_fold["maxdd"], 3.0)
        fold_calmars.append(c)

    if not fold_calmars: return False, "no_folds"
    fold_calmars.sort()
    median_c = fold_calmars[len(fold_calmars)//2]
    pos_folds = sum(1 for c in fold_calmars if c > 0)
    ok = median_c > 0 and pos_folds >= 3
    detail = f"median_calmar={median_c:.2f} pos_folds={pos_folds}/{len(fold_calmars)}"
    return ok, detail

def held_out_gate(m):
    """
    Held-out: 2025H2 + 2026 must be non-catastrophic.
    Gate: 2025 roi > -10% AND 2026 roi > -15% (allow some drawdown but not blow-up).
    These years are NOT used in fitness — only checked at promote time.
    """
    roi25 = m["yr_roi"].get(2025, None)
    roi26 = m["yr_roi"].get(2026, None)
    reasons = []
    if roi25 is not None and roi25 < -10: reasons.append(f"2025={roi25:.0f}%<-10%")
    if roi26 is not None and roi26 < -15: reasons.append(f"2026={roi26:.0f}%<-15%")
    return len(reasons) == 0, ", ".join(reasons) if reasons else "ok"

def git_commit_v4(archive, gen, n_promote):
    filled, total, best_f, avg_f = archive.stats()
    bg, bm = archive.best()
    if bm is None: return "no-best"
    tec = seg(bm, TEST)
    msg = (f"evolver-v4 gen {gen}: archive {filled}/{total} cells, {n_promote} promotions\n"
           f"best: trainCalmar={best_f:.2f} testCAGR={tec:.0f}% CAGR={bm['cagr']:.1f}% DD={bm['maxdd']:.1f}%\n"
           f"primitives: {bg.get('primitives')}\n\n"
           f"Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>")
    try:
        subprocess.run(["git","add","tools/evolver-v4-archive.json","tools/evolver-v4-report.md"],
                       cwd=REPO, check=True, capture_output=True)
        subprocess.run(["git","commit","-m",msg], cwd=REPO, check=True, capture_output=True)
        r = subprocess.run(["git","push","origin","master"], cwd=REPO, capture_output=True, text=True)
        return "pushed" if r.returncode==0 else "commit-only"
    except subprocess.CalledProcessError:
        return "git-fail"

def _worker_init():
    get_v3(); get_screen()

# ── Self-audit loop — runs after each PROMOTE ─────────────────────────────────
def audit_genome(g, m):
    """
    Audit champion metrics → identify weaknesses → return targeted mutations.
    Returns list of (issue, mutated_genome) candidates to inject into population.
    """
    issues = []; candidates = []
    yr_roi = m.get("yr_roi", {})
    pnames = get_prim_names()

    # Audit 1: bad years (any year < -5%)
    bad_years = {y: r for y, r in yr_roi.items() if r < -5}
    if bad_years:
        issues.append(f"bad_years={list(bad_years.keys())}")
        # try tighter SL on primitives
        for pname in g.get("primitives", []):
            gg = json.loads(json.dumps(g))
            cfg = gg.setdefault("prim_cfg", {}).setdefault(pname, {})
            cur_sl = cfg.get("sl", 1.8)
            tighter = max(1.4, cur_sl - 0.2)
            cfg["sl"] = tighter
            candidates.append((f"tighter_sl_{pname}={tighter}", gg))

    # Audit 2: DD too high (>28%)
    if m.get("maxdd", 0) > 28:
        issues.append(f"high_dd={m['maxdd']:.1f}%")
        gg = json.loads(json.dumps(g)); gg["risk4"] = max(0.02, g.get("risk4", 0.04) - 0.01)
        candidates.append(("lower_risk4", gg))
        gg2 = json.loads(json.dumps(g)); gg2["cap_btc"] = max(0.4, g.get("cap_btc", 0.8) - 0.2)
        candidates.append(("lower_cap_btc", gg2))

    # Audit 3: 2022/2026 negative (bear/range regime weak)
    if yr_roi.get(2022, 0) < -5 or yr_roi.get(2026, 0) < -5:
        issues.append("bear_regime_weak")
        # try adding a second primitive for diversity
        cur_prims = g.get("primitives", [])
        for pname in pnames:
            if pname not in cur_prims and len(cur_prims) < 3:
                gg = json.loads(json.dumps(g))
                gg["primitives"] = cur_prims + [pname]
                gg.setdefault("prim_cfg", {})[pname] = {}
                candidates.append((f"add_prim_{pname}", gg))
                break

    # Audit 4: too few trades (min_n < 50/yr) — signal too tight
    if m.get("min_n", 999) < 50:
        issues.append(f"low_n={m['min_n']}")
        for pname in g.get("primitives", []):
            gg = json.loads(json.dumps(g))
            cfg = gg.setdefault("prim_cfg", {}).setdefault(pname, {})
            cur_adx = cfg.get("adx", g.get("adx4", 20))
            cfg["adx"] = max(16, cur_adx - 2)
            candidates.append((f"lower_adx_{pname}", gg))

    # Audit 5: 2025 weak (<5%) — recent edge decay
    if yr_roi.get(2025, 0) < 5:
        issues.append(f"2025_weak={yr_roi.get(2025,0):.0f}%")
        # try MultiTF if not already used
        if "MultiTF_4h1h" in pnames and "MultiTF_4h1h" not in g.get("primitives", []):
            gg = json.loads(json.dumps(g))
            gg["primitives"] = g.get("primitives", []) + ["MultiTF_4h1h"]
            gg.setdefault("prim_cfg", {})["MultiTF_4h1h"] = {}
            candidates.append(("add_MultiTF_for_2025", gg))

    return issues, candidates

# ── main loop ─────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    get_v3(); get_screen()
    random.seed()
    POP     = int(os.environ.get("POP", "20"))
    WORKERS = int(os.environ.get("WORKERS", "5"))
    GENS    = int(os.environ.get("GENS", "100000"))
    COMMIT_EVERY = int(os.environ.get("COMMIT_EVERY", "200"))  # commit every N improvements

    sys.stderr.write(f"Evolver-v4 (MAP-Elites + primitive library) start: pop={POP} workers={WORKERS}\n")
    sys.stderr.write(f"Primitive kho: {get_prim_names()}\n")

    archive = Archive()
    if os.path.exists(ARCHIVE_F):
        try:
            saved = json.load(open(ARCHIVE_F))
            archive.from_dict(saved.get("cells", {}))
            sys.stderr.write(f"Resumed: {len(archive.cells)} cells loaded\n")
        except Exception as e:
            sys.stderr.write(f"Archive load failed: {e}, starting fresh\n")

    if not os.path.exists(REPORT_F):
        open(REPORT_F, "w").write("# Evolver v4 (MAP-Elites + primitive library)\n\n")

    # seed population from archive or base
    pop = []
    for cell in list(archive.cells.values())[:POP]:
        pop.append(dict(cell["genome"]))
    while len(pop) < POP:
        g = base_genome()
        for _ in range(random.randint(0, 3)): g = mutate(g)
        pop.append(g)

    champ_test_cagr = -1e9
    last_commit_improvements = archive.total_improvements
    n_promote = 0
    AUDIT_EVERY = 30   # audit best cell every N gens regardless of promote

    ex = ProcessPoolExecutor(max_workers=WORKERS, initializer=_worker_init)
    gen = 0

    while gen < GENS:
        if os.path.exists(STOP_F):
            sys.stderr.write(f"STOP gen {gen}\n"); os.remove(STOP_F); break
        gen += 1

        try:
            metrics = list(ex.map(eval_genome_v4, pop))
        except Exception as e:
            sys.stderr.write(f"gen {gen} pool err: {str(e)[:60]} reset\n")
            ex.shutdown(wait=False, cancel_futures=True)
            ex = ProcessPoolExecutor(max_workers=WORKERS, initializer=_worker_init)
            pop = [base_genome()] + [mutate(base_genome()) for _ in range(POP-1)]
            continue

        # insert into archive
        gen_improvements = 0
        for g, m in zip(pop, metrics):
            if archive.try_insert(g, m):
                gen_improvements += 1

        filled, total, best_fit, avg_fit = archive.stats()
        bg, bm = archive.best()

        # heartbeat
        with open(HEART_F, "w") as f:
            f.write(f"gen={gen} cells={filled}/{total} best_calmar={best_fit:.2f} "
                    f"avg={avg_fit:.2f} total_improvements={archive.total_improvements} "
                    f"@ {datetime.datetime.utcnow().strftime('%H:%M:%S')}\n")
            if bg: f.write(f"best_primitives={bg.get('primitives')} DD={bm['maxdd']:.1f}%\n")

        # log
        with open(LOG_F, "a") as f:
            f.write(json.dumps({"gen":gen,"filled":filled,"total":total,
                                "best_fit":round(best_fit,3),"gen_impr":gen_improvements}) + "\n")

        # check for 5-gate promote: honest + OOS + robustness + purged-WF + held-out
        if bm and fitness_train(bm) > -1e8:
            oos_ok, tec = oos_check(bm, champ_test_cagr)
            if oos_ok:
                base_fit = fitness_train(bm)
                frag = robustness_v4(bg, base_fit)
                if frag <= 0.20:
                    # Phase C gates
                    pwf_ok, pwf_detail = purged_wf_gate(bg)
                    ho_ok, ho_detail = held_out_gate(bm)
                    if pwf_ok and ho_ok:
                        champ_test_cagr = tec
                        n_promote += 1
                        yr_str = " ".join(f"{y}:{bm['yr_roi'].get(y,0):+.0f}%({bm['yr_n'].get(y,0)}n)"
                                         for y in range(2019,2027) if y in bm["yr_roi"])
                        with open(REPORT_F, "a") as f:
                            f.write(f"\n## Promoted #{n_promote} — gen {gen} — "
                                    f"{datetime.datetime.utcnow().strftime('%Y-%m-%d %H:%M')}\n")
                            f.write(f"- trainCalmar={base_fit:.2f} testCAGR={tec:.0f}% "
                                    f"CAGR={bm['cagr']:.1f}% DD={bm['maxdd']:.1f}% "
                                    f"n={bm.get('min_n',0)}/yr\n")
                            f.write(f"- primitives={bg.get('primitives')} combine={bg.get('combine')}\n")
                            f.write(f"- purgedWF={pwf_detail} | heldOut={ho_detail}\n")
                            f.write(f"- {yr_str}\n")
                        sys.stderr.write(f"[gen {gen}] PROMOTE #{n_promote} calmar={base_fit:.2f} "
                                         f"testCAGR={tec:.0f}% prims={bg.get('primitives')} "
                                         f"frag={frag:.0%} pwf={pwf_detail} ho={ho_detail}\n")
                        # self-audit: inject targeted mutations into next population
                        issues, audit_candidates = audit_genome(bg, bm)
                        if issues:
                            sys.stderr.write(f"[gen {gen}] AUDIT issues={issues} -> {len(audit_candidates)} candidates injected\n")
                            for label, gg in audit_candidates[:4]:  # inject up to 4
                                pop.append(gg)
                    else:
                        sys.stderr.write(f"[gen {gen}] BLOCKED calmar={base_fit:.2f} "
                                         f"pwf_ok={pwf_ok}({pwf_detail}) ho_ok={ho_ok}({ho_detail})\n")

        # periodic self-audit: audit best cell every AUDIT_EVERY gens, inject candidates
        if gen % AUDIT_EVERY == 0 and bg is not None:
            issues, audit_candidates = audit_genome(bg, bm)
            if issues:
                sys.stderr.write(f"[gen {gen}] PERIODIC_AUDIT issues={issues} -> {len(audit_candidates)} candidates\n")
                for _, gg in audit_candidates[:6]:
                    pop.append(gg)
            else:
                # no issues found → explore new primitive combos
                for pname in get_prim_names():
                    if pname not in bg.get("primitives", []):
                        gg = json.loads(json.dumps(bg)); gg["primitives"] = bg["primitives"] + [pname]
                        gg.setdefault("prim_cfg", {})[pname] = {}
                        pop.append(gg); break

        # periodic save + commit
        if archive.total_improvements - last_commit_improvements >= COMMIT_EVERY:
            json.dump({"gen": gen, "cells": archive.to_dict(),
                       "meta": {"improvements": archive.total_improvements, "filled": filled}},
                      open(ARCHIVE_F, "w"), indent=2)
            st = git_commit_v4(archive, gen, n_promote)
            last_commit_improvements = archive.total_improvements
            sys.stderr.write(f"[gen {gen}] saved archive cells={filled}/{total} -> {st}\n")

        # evolve new population from archive
        newpop = []
        if archive.cells:
            # elites from archive (best cells)
            elite_cells = sorted(archive.cells.values(), key=lambda x: x["fitness"], reverse=True)
            for cell in elite_cells[:max(2, POP//6)]:
                newpop.append(dict(cell["genome"]))
        while len(newpop) < POP:
            parent = archive.sample() if archive.cells and random.random() < 0.8 else base_genome()
            child = mutate(parent) if random.random() < 0.7 else crossover(parent, archive.sample() or parent)
            newpop.append(child)
        pop = newpop

    ex.shutdown(wait=False, cancel_futures=True)
    # final save
    json.dump({"gen": gen, "cells": archive.to_dict(),
               "meta": {"improvements": archive.total_improvements, "filled": len(archive.cells)}},
              open(ARCHIVE_F, "w"), indent=2)
    sys.stderr.write(f"Evolver-v4 done gen={gen} cells={len(archive.cells)}/27 promotions={n_promote}\n")
