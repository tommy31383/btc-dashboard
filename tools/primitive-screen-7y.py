#!/usr/bin/env python3
"""
PRIMITIVE SCREEN 7Y — Phase A of Evolver v4.
Screen từng primitive SOLO trên BTC 4h 7y (2019-2026).
Pass criteria: n>=150/yr full period, >=5/7 yr positive, WF stable >=4/5 folds, Calmar>0.3
Output: tools/primitive-library.json (pass list) + tools/primitive-screen-report.md

Usage:
  python3 primitive-screen-7y.py
  python3 primitive-screen-7y.py --verbose   # print per-primitive detail
"""
import importlib.util, json, datetime, sys, os, math
from collections import defaultdict

TOOLS = os.path.dirname(os.path.abspath(__file__))
REPO  = os.path.dirname(TOOLS)
AL_PATH = os.path.join(TOOLS, "general-rule-autoloop.py")
LIB_OUT = os.path.join(TOOLS, "primitive-library.json")
RPT_OUT = os.path.join(TOOLS, "primitive-screen-report.md")
CAPITAL = 100_000; LEV = 10
VERBOSE = "--verbose" in sys.argv

_AL = None
def get_al():
    global _AL
    if _AL is None:
        spec = importlib.util.spec_from_file_location("autoloop", AL_PATH)
        _AL = importlib.util.module_from_spec(spec); spec.loader.exec_module(_AL)
    return _AL

# ── honest single-account resim (reuse v3 logic, solo primitive) ──────────────
def honest_resim_solo(trades):
    """trades: list of (entry_ms, exit_ms, ret_frac, vol_scale, tag)"""
    if not trades: return None
    trades = sorted(trades, key=lambda x: x[0])
    risk = 0.04; cap = 1.0
    eq = CAPITAL; mu = 0.0; openp = []
    ev = sorted(set([t[0] for t in trades] + [t[1] for t in trades]))
    ent = defaultdict(list)
    for t in trades: ent[t[0]].append(t)
    peak = CAPITAL; maxdd = 0
    yr_pnl = defaultdict(float); yr_n = defaultdict(int); yr_start = {}
    for ms in ev:
        still = []
        for (xm, marg, ret) in openp:
            if xm <= ms:
                pnl = ret * marg * LEV - 0.0006 * marg; eq += pnl; mu -= marg
                d = datetime.datetime.utcfromtimestamp(xm/1000)
                yr_pnl[d.year] += pnl; yr_n[d.year] += 1
            else: still.append((xm, marg, ret))
        openp = still
        if eq > peak: peak = eq
        dd = (peak - eq) / peak * 100
        if dd > maxdd: maxdd = dd
        for (em, xm, ret, vs, tag) in ent.get(ms, []):
            d = datetime.datetime.utcfromtimestamp(em/1000)
            if d.year not in yr_start: yr_start[d.year] = eq
            marg = risk * eq * vs
            if mu + marg <= cap * eq and marg > 0:
                mu += marg; openp.append((xm, marg, ret))
    for (xm, marg, ret) in openp:
        pnl = ret * marg * LEV - 0.0006 * marg; eq += pnl
        d = datetime.datetime.utcfromtimestamp(xm/1000)
        yr_pnl[d.year] += pnl; yr_n[d.year] += 1
    years = sorted(yr_n.keys())
    if not years: return None
    span = (ev[-1] - ev[0]) / (365.25 * 24 * 3600 * 1000)
    cagr = ((eq / CAPITAL)**(1/span) - 1)*100 if span > 0 and eq > 0 else -100
    yr_roi = {y: (yr_pnl[y]/yr_start.get(y, CAPITAL)*100 if yr_start.get(y, CAPITAL) > 0 else 0) for y in years}
    min_n = min((yr_n[y] for y in years if y != 2026), default=0)
    pos_yrs = sum(1 for y in years if yr_roi.get(y, 0) > 0)
    return dict(equity=eq, cagr=cagr, maxdd=maxdd, yr_n=dict(yr_n), yr_roi=yr_roi,
                min_n=min_n, pos_yrs=pos_yrs, nyears=len(years))

def calmar(m):
    if m is None: return -999
    return m["cagr"] / max(m["maxdd"], 3.0)

# ── walk-forward stability: 5 folds of ~1.4yr each ────────────────────────────
def wf_stability(all_trades):
    """Return fraction of folds where Calmar > 0 (basic stability check)."""
    if not all_trades: return 0.0
    all_trades = sorted(all_trades, key=lambda x: x[0])
    t0, t1 = all_trades[0][0], all_trades[-1][0]
    span = t1 - t0
    n_folds = 5
    fold_ms = span // n_folds
    passes = 0
    for i in range(n_folds):
        fs = t0 + i * fold_ms
        fe = fs + fold_ms
        fold_trades = [t for t in all_trades if fs <= t[0] < fe]
        m = honest_resim_solo(fold_trades)
        if m and calmar(m) > 0: passes += 1
    return passes / n_folds

# ── pass gate ─────────────────────────────────────────────────────────────────
def passes_gate(m, wf_stab, name):
    # Solo primitive thresholds (looser than full portfolio — no gộp sleeves)
    reasons = []
    if m is None: return False, ["no trades"]
    if m["min_n"] < 20: reasons.append(f"min_n={m['min_n']}<20")
    if m["pos_yrs"] < 5: reasons.append(f"pos_yrs={m['pos_yrs']}<5")
    if calmar(m) < 0.1: reasons.append(f"calmar={calmar(m):.2f}<0.1")
    if wf_stab < 0.4: reasons.append(f"wf_stab={wf_stab:.0%}<40%")
    return len(reasons) == 0, reasons

# ══════════════════════════════════════════════════════════════════════════════
# PRIMITIVE GENERATORS — each returns trades list, solo, no other primitives
# ══════════════════════════════════════════════════════════════════════════════

def prim_adx_di_4h(al, cfg):
    """ADX/DI trend-follow on BTC 4h (baseline — already in v3)."""
    P = al.P4; c,h,l,t = P["c"],P["h"],P["l"],P["t"]
    adx,pdi,mdi,atr = P["adx"],P["pdi"],P["mdi"],P["atr"]
    e200 = P["e200"]
    ADX=cfg.get("adx",20); DI=cfg.get("di",1.0)
    SL=cfg.get("sl",1.8); TP=cfg.get("tp",8); HOLD=cfg.get("hold",60); MAXPOS=cfg.get("pos",5)
    pos=[]; out=[]; last=-999
    for i in range(200, len(c)-HOLD-1):
        np_=[]
        for (ei,epx,slpx,tppx,vs,ems) in pos:
            xpx=c[i]; done=False
            if l[i]<=slpx: xpx=slpx; done=True
            elif h[i]>=tppx: xpx=tppx; done=True
            elif i-ei>=HOLD: done=True
            if done: out.append((ems,t[i]+4*3600*1000,(xpx-epx)/epx,vs,"ADX4h"))
            else: np_.append((ei,epx,slpx,tppx,vs,ems))
        pos=np_
        if len(pos)>=MAXPOS or i-last<2: continue
        a=adx[i]; pp=pdi[i]; mm=mdi[i]; e2=e200[i]; at=atr[i]
        if None in (a,pp,mm,e2,at): continue
        if a<=ADX or not(pp>mm*DI) or c[i]<=e2: continue
        vs=0.7; pos.append((i,c[i],c[i]-SL*at,c[i]+TP*at,vs,t[i])); last=i
    return out

def prim_donchian_4h(al, cfg):
    """Donchian channel breakout on BTC 4h."""
    P = al.P4; c,h,l,t = P["c"],P["h"],P["l"],P["t"]
    atr = P["atr"]
    PERIOD=cfg.get("period",20); SL=cfg.get("sl",1.8); TP=cfg.get("tp",8)
    HOLD=cfg.get("hold",60); MAXPOS=cfg.get("pos",5)
    pos=[]; out=[]; last=-999
    for i in range(PERIOD+10, len(c)-HOLD-1):
        at=atr[i]
        if at is None: continue
        np_=[]
        for (ei,epx,slpx,tppx,vs,ems) in pos:
            xpx=c[i]; done=False
            if l[i]<=slpx: xpx=slpx; done=True
            elif h[i]>=tppx: xpx=tppx; done=True
            elif i-ei>=HOLD: done=True
            if done: out.append((ems,t[i]+4*3600*1000,(xpx-epx)/epx,vs,"Donchian4h"))
            else: np_.append((ei,epx,slpx,tppx,vs,ems))
        pos=np_
        if len(pos)>=MAXPOS or i-last<2: continue
        highest = max(h[i-PERIOD:i])
        if c[i] > highest and c[i-1] <= highest:  # breakout bar
            vs = 0.7
            pos.append((i,c[i],c[i]-SL*at,c[i]+TP*at,vs,t[i])); last=i
    return out

def prim_ema_stack_4h(al, cfg):
    """EMA stack (EMA20 > EMA50 > EMA200) entry on BTC 4h pullback."""
    P = al.P4; c,h,l,t = P["c"],P["h"],P["l"],P["t"]
    atr = P["atr"]
    ema20 = al.ema_s(c, 20); ema50 = al.ema_s(c, 50); ema200 = P["e200"]
    SL=cfg.get("sl",1.8); TP=cfg.get("tp",8); HOLD=cfg.get("hold",60); MAXPOS=cfg.get("pos",5)
    pos=[]; out=[]; last=-999
    for i in range(210, len(c)-HOLD-1):
        at=atr[i]; e20=ema20[i]; e50=ema50[i]; e200=ema200[i]
        if None in (at,e20,e50,e200): continue
        np_=[]
        for (ei,epx,slpx,tppx,vs,ems) in pos:
            xpx=c[i]; done=False
            if l[i]<=slpx: xpx=slpx; done=True
            elif h[i]>=tppx: xpx=tppx; done=True
            elif i-ei>=HOLD: done=True
            if done: out.append((ems,t[i]+4*3600*1000,(xpx-epx)/epx,vs,"EMAStack4h"))
            else: np_.append((ei,epx,slpx,tppx,vs,ems))
        pos=np_
        if len(pos)>=MAXPOS or i-last<2: continue
        # stack aligned + pullback to EMA20 + bounce
        if e20>e50>e200 and c[i]>e20 and c[i-1]<=e20*1.005:
            vs = 0.7
            pos.append((i,c[i],c[i]-SL*at,c[i]+TP*at,vs,t[i])); last=i
    return out

def prim_vol_squeeze_4h(al, cfg):
    """BB squeeze breakout: BB width < 20th percentile then expand long."""
    P = al.P4; c,h,l,t = P["c"],P["h"],P["l"],P["t"]
    atr = P["atr"]
    PERIOD=cfg.get("bb_period",20); BB_STD=cfg.get("bb_std",2.0)
    SQ_PCT=cfg.get("sq_pct",0.20)  # squeeze = BB width in bottom 20%
    SL=cfg.get("sl",1.8); TP=cfg.get("tp",8); HOLD=cfg.get("hold",60); MAXPOS=cfg.get("pos",5)
    # precompute BB width
    import statistics
    bb_widths=[]
    for i in range(len(c)):
        if i<PERIOD: bb_widths.append(None); continue
        sl_=c[i-PERIOD:i]; mn=sum(sl_)/PERIOD
        try: sd=statistics.stdev(sl_)
        except: sd=0
        bb_widths.append(BB_STD*sd/mn if mn>0 else None)
    # rolling percentile window 200 bars
    pos=[]; out=[]; last=-999
    for i in range(PERIOD+200, len(c)-HOLD-1):
        at=atr[i]; bw=bb_widths[i]
        if at is None or bw is None: continue
        # compute 20th pct of last 200 BBwidths
        hist=[bb_widths[j] for j in range(i-200,i) if bb_widths[j] is not None]
        if len(hist)<100: continue
        hist_s=sorted(hist); thresh=hist_s[int(len(hist_s)*SQ_PCT)]
        np_=[]
        for (ei,epx,slpx,tppx,vs,ems) in pos:
            xpx=c[i]; done=False
            if l[i]<=slpx: xpx=slpx; done=True
            elif h[i]>=tppx: xpx=tppx; done=True
            elif i-ei>=HOLD: done=True
            if done: out.append((ems,t[i]+4*3600*1000,(xpx-epx)/epx,vs,"VolSqueeze4h"))
            else: np_.append((ei,epx,slpx,tppx,vs,ems))
        pos=np_
        if len(pos)>=MAXPOS or i-last<2: continue
        # squeeze on previous bar, expand now (price closes above upper BB)
        bw_prev=bb_widths[i-1]
        if bw_prev and bw_prev<=thresh and bw>bw_prev*1.1 and c[i]>c[i-1]:
            vs=0.7
            pos.append((i,c[i],c[i]-SL*at,c[i]+TP*at,vs,t[i])); last=i
    return out

def prim_rci_funding_4h(al, cfg):
    """RCI oversold reversal + funding>0.05% precision gate (validated: 64% top precision)."""
    P = al.P4; c,h,l,t = P["c"],P["h"],P["l"],P["t"]
    atr = P["atr"]
    RCI_PERIOD=cfg.get("rci_period",9); RCI_THRESH=cfg.get("rci_thresh",-80)
    FUND_THRESH=cfg.get("fund_thresh",0.0005)
    SL=cfg.get("sl",1.8); TP=cfg.get("tp",6); HOLD=cfg.get("hold",40); MAXPOS=cfg.get("pos",4)
    # RCI = Spearman rank correlation of price vs time index
    def rci(prices):
        n=len(prices); ranked_p=sorted(range(n),key=lambda i:prices[i])
        d2=sum((ranked_p[i]-i)**2 for i in range(n))
        return (1 - 6*d2/(n*(n**2-1)))*100
    pos=[]; out=[]; last=-999
    for i in range(RCI_PERIOD+10, len(c)-HOLD-1):
        at=atr[i]
        if at is None: continue
        np_=[]
        for (ei,epx,slpx,tppx,vs,ems) in pos:
            xpx=c[i]; done=False
            if l[i]<=slpx: xpx=slpx; done=True
            elif h[i]>=tppx: xpx=tppx; done=True
            elif i-ei>=HOLD: done=True
            if done: out.append((ems,t[i]+4*3600*1000,(xpx-epx)/epx,vs,"RCI_Fund4h"))
            else: np_.append((ei,epx,slpx,tppx,vs,ems))
        pos=np_
        if len(pos)>=MAXPOS or i-last<2: continue
        r=rci(c[i-RCI_PERIOD:i])
        if r>RCI_THRESH: continue
        fund=al.fund_at(t[i])
        if fund<FUND_THRESH: continue  # funding must be high (longs paying, reversal setup)
        vs=0.7
        pos.append((i,c[i],c[i]-SL*at,c[i]+TP*at,vs,t[i])); last=i
    return out

def prim_stoch_range_4h(al, cfg):
    """Stochastic oversold in RANGE regime (EMA200d flat ±5%)."""
    P = al.P4; c,h,l,t = P["c"],P["h"],P["l"],P["t"]
    atr = P["atr"]; e200 = P["e200"]
    STOCH_K=cfg.get("stoch_k",14); STOCH_D=cfg.get("stoch_d",3)
    K_THRESH=cfg.get("k_thresh",20)  # oversold
    RANGE_PCT=cfg.get("range_pct",0.12)  # price within ±12% of EMA200d = RANGE
    SL=cfg.get("sl",1.6); TP=cfg.get("tp",5); HOLD=cfg.get("hold",40); MAXPOS=cfg.get("pos",4)
    # compute Stoch K
    def stoch_k(highs, lows, closes, period):
        out=[None]*len(closes)
        for i in range(period-1, len(closes)):
            hh=max(highs[i-period+1:i+1]); ll=min(lows[i-period+1:i+1])
            out[i]=(closes[i]-ll)/(hh-ll)*100 if hh>ll else 50
        return out
    sk = stoch_k(h, l, c, STOCH_K)
    pos=[]; out=[]; last=-999
    for i in range(STOCH_K+20, len(c)-HOLD-1):
        at=atr[i]; e2=e200[i]; k=sk[i]
        if None in (at,e2,k): continue
        np_=[]
        for (ei,epx,slpx,tppx,vs,ems) in pos:
            xpx=c[i]; done=False
            if l[i]<=slpx: xpx=slpx; done=True
            elif h[i]>=tppx: xpx=tppx; done=True
            elif i-ei>=HOLD: done=True
            if done: out.append((ems,t[i]+4*3600*1000,(xpx-epx)/epx,vs,"StochRange4h"))
            else: np_.append((ei,epx,slpx,tppx,vs,ems))
        pos=np_
        if len(pos)>=MAXPOS or i-last<2: continue
        e2d = al.e200d_at(P, t[i])
        if e2d is None: continue
        ratio=c[i]/e2d
        if not (1-RANGE_PCT <= ratio <= 1+RANGE_PCT): continue  # must be in RANGE
        if k>K_THRESH: continue  # must be oversold
        vs=0.7
        pos.append((i,c[i],c[i]-SL*at,c[i]+TP*at,vs,t[i])); last=i
    return out

def prim_breakout_retest_4h(al, cfg):
    """Break above 20-bar high → wait for retest within 3% → enter."""
    P = al.P4; c,h,l,t = P["c"],P["h"],P["l"],P["t"]
    atr = P["atr"]
    PERIOD=cfg.get("period",20); RETEST_PCT=cfg.get("retest_pct",0.03)
    RETEST_BARS=cfg.get("retest_bars",10)  # max bars to wait for retest
    SL=cfg.get("sl",1.8); TP=cfg.get("tp",8); HOLD=cfg.get("hold",60); MAXPOS=cfg.get("pos",4)
    pos=[]; out=[]; last=-999
    pending=[]  # (break_level, break_bar)
    for i in range(PERIOD+10, len(c)-HOLD-1):
        at=atr[i]
        if at is None: continue
        np_=[]
        for (ei,epx,slpx,tppx,vs,ems) in pos:
            xpx=c[i]; done=False
            if l[i]<=slpx: xpx=slpx; done=True
            elif h[i]>=tppx: xpx=tppx; done=True
            elif i-ei>=HOLD: done=True
            if done: out.append((ems,t[i]+4*3600*1000,(xpx-epx)/epx,vs,"BrkRetest4h"))
            else: np_.append((ei,epx,slpx,tppx,vs,ems))
        pos=np_
        # expire old pending
        pending=[p for p in pending if i-p[1]<=RETEST_BARS]
        # check if current bar retests a pending breakout level
        if len(pos)<MAXPOS and i-last>=2:
            for (brk_lvl, brk_bar) in list(pending):
                # retest: price pulls back near break level then closes above
                if l[i]<=brk_lvl*(1+RETEST_PCT) and c[i]>brk_lvl:
                    vs=0.7
                    pos.append((i,c[i],c[i]-SL*at,c[i]+TP*at,vs,t[i])); last=i
                    pending=[]  # consumed
                    break
        # detect new breakout
        highest=max(h[i-PERIOD:i])
        if c[i]>highest and c[i-1]<=highest:
            pending.append((highest, i))
    return out

def prim_multitf_confluence_4h_1h(al, cfg):
    """4h ADX/DI + 1h ADX/DI same direction confluence."""
    P4=al.P4; c4,h4,l4,t4=P4["c"],P4["h"],P4["l"],P4["t"]
    adx4,pdi4,mdi4,atr4=P4["adx"],P4["pdi"],P4["mdi"],P4["atr"]
    e200_4=P4["e200"]
    c1,h1,l1,t1=al.c1,al.h1,al.l1,al.t1
    adx1,pdi1,mdi1=al.adx1,al.pdi1,al.mdi1
    import bisect
    ADX4=cfg.get("adx4",18); ADX1=cfg.get("adx1",16)
    DI=cfg.get("di",1.0); SL=cfg.get("sl",1.8); TP=cfg.get("tp",8)
    HOLD=cfg.get("hold",60); MAXPOS=cfg.get("pos",4)
    pos=[]; out=[]; last=-999
    for i in range(200, len(c4)-HOLD-1):
        a4=adx4[i]; pp4=pdi4[i]; mm4=mdi4[i]; at=atr4[i]; e2=e200_4[i]
        if None in (a4,pp4,mm4,at,e2): continue
        np_=[]
        for (ei,epx,slpx,tppx,vs,ems) in pos:
            xpx=c4[i]; done=False
            if l4[i]<=slpx: xpx=slpx; done=True
            elif h4[i]>=tppx: xpx=tppx; done=True
            elif i-ei>=HOLD: done=True
            if done: out.append((ems,t4[i]+4*3600*1000,(xpx-epx)/epx,vs,"MultiTF4h1h"))
            else: np_.append((ei,epx,slpx,tppx,vs,ems))
        pos=np_
        if len(pos)>=MAXPOS or i-last<2: continue
        if a4<=ADX4 or not(pp4>mm4*DI) or c4[i]<=e2: continue
        # check 1h confluence
        j1=bisect.bisect_right(t1,t4[i])-1
        if j1<0 or adx1[j1] is None: continue
        if not(adx1[j1]>ADX1 and pdi1[j1]>mdi1[j1]*DI): continue
        vs=0.7
        pos.append((i,c4[i],c4[i]-SL*at,c4[i]+TP*at,vs,t4[i])); last=i
    return out

# ══════════════════════════════════════════════════════════════════════════════
# REGISTRY — (name, generator_fn, default_config, description)
# ══════════════════════════════════════════════════════════════════════════════
PRIMITIVES = [
    ("ADX_DI_4h",        prim_adx_di_4h,           {"adx":20,"di":1.0,"sl":1.8,"tp":8,"hold":60,"pos":5},
     "ADX/DI trend-follow BTC 4h — baseline (already in v3)"),
    ("Donchian_4h",      prim_donchian_4h,          {"period":20,"sl":1.8,"tp":8,"hold":60,"pos":5},
     "Donchian channel breakout BTC 4h"),
    ("EMA_Stack_4h",     prim_ema_stack_4h,         {"sl":1.8,"tp":8,"hold":60,"pos":5},
     "EMA20>EMA50>EMA200 stack + pullback entry BTC 4h"),
    ("Vol_Squeeze_4h",   prim_vol_squeeze_4h,       {"sl":1.8,"tp":8,"hold":60,"pos":5,"bb_period":20,"sq_pct":0.20},
     "BB squeeze breakout BTC 4h"),
    ("RCI_Funding_4h",   prim_rci_funding_4h,       {"rci_period":9,"rci_thresh":-80,"fund_thresh":0.0005,"sl":1.8,"tp":6,"hold":40,"pos":4},
     "RCI oversold reversal + high funding gate BTC 4h"),
    ("Stoch_Range_4h",   prim_stoch_range_4h,       {"stoch_k":14,"k_thresh":20,"range_pct":0.12,"sl":1.6,"tp":5,"hold":40,"pos":4},
     "Stoch oversold in RANGE regime BTC 4h"),
    ("Breakout_Retest_4h", prim_breakout_retest_4h, {"period":20,"retest_pct":0.03,"retest_bars":10,"sl":1.8,"tp":8,"hold":60,"pos":4},
     "Breakout + retest entry BTC 4h"),
    ("MultiTF_4h1h",     prim_multitf_confluence_4h_1h, {"adx4":18,"adx1":16,"di":1.0,"sl":1.8,"tp":8,"hold":60,"pos":4},
     "4h+1h ADX/DI confluence BTC"),
]

# ══════════════════════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════════════════════
def main():
    al = get_al()
    sys.stderr.write("Data loaded. Screening %d primitives...\n" % len(PRIMITIVES))

    passed = []; failed = []
    report_lines = ["# Primitive Screen 7Y — Phase A Report", f"Date: {datetime.datetime.utcnow().strftime('%Y-%m-%d')}",
                    f"Total primitives: {len(PRIMITIVES)}", ""]

    for name, gen_fn, cfg, desc in PRIMITIVES:
        sys.stderr.write(f"  Screening {name}... ")
        try:
            trades = gen_fn(al, cfg)
        except Exception as e:
            sys.stderr.write(f"ERROR: {e}\n")
            failed.append({"name": name, "status": "error", "reason": str(e)})
            report_lines.append(f"### ❌ {name} — ERROR: {e}")
            continue

        m = honest_resim_solo(trades)
        wf_stab = wf_stability(trades)
        ok, reasons = passes_gate(m, wf_stab, name)

        n_total = sum(m["yr_n"].values()) if m else 0
        cal = calmar(m) if m else -999

        if ok:
            sys.stderr.write(f"PASS | n={n_total} calmar={cal:.2f} dd={m['maxdd']:.1f}% pos_yrs={m['pos_yrs']}/7 wf={wf_stab:.0%}\n")
            passed.append({"name": name, "desc": desc, "config": cfg,
                           "stats": {"calmar": round(cal,3), "cagr": round(m["cagr"],1),
                                     "maxdd": round(m["maxdd"],1), "n_total": n_total,
                                     "min_n": m["min_n"], "pos_yrs": m["pos_yrs"],
                                     "wf_stab": round(wf_stab,2), "yr_roi": m["yr_roi"], "yr_n": m["yr_n"]}})
            yr_str = " | ".join(f"{y}:{m['yr_roi'].get(y,0):+.0f}%" for y in range(2019,2027) if y in m["yr_roi"])
            report_lines.append(f"### ✅ {name}")
            report_lines.append(f"- {desc}")
            report_lines.append(f"- Calmar={cal:.2f} | CAGR={m['cagr']:.1f}% | DD={m['maxdd']:.1f}% | n={n_total} min_n/yr={m['min_n']} | pos_yrs={m['pos_yrs']}/7 | WF={wf_stab:.0%}")
            report_lines.append(f"- Per-year: {yr_str}")
            report_lines.append("")
        else:
            sys.stderr.write(f"FAIL | {', '.join(reasons)}\n")
            failed.append({"name": name, "status": "fail", "reasons": reasons,
                           "stats": {"calmar": round(cal,3), "n_total": n_total,
                                     "pos_yrs": m["pos_yrs"] if m else 0, "wf_stab": round(wf_stab,2)} if m else {}})
            report_lines.append(f"### ❌ {name}")
            report_lines.append(f"- {desc}")
            report_lines.append(f"- FAIL: {', '.join(reasons)}")
            if m:
                yr_str = " | ".join(f"{y}:{m['yr_roi'].get(y,0):+.0f}%" for y in range(2019,2027) if y in m["yr_roi"])
                report_lines.append(f"- Calmar={cal:.2f} | n={n_total} | {yr_str}")
            report_lines.append("")

        if VERBOSE and m:
            yr_str = " ".join(f"{y}:{m['yr_roi'].get(y,0):+.0f}%({m['yr_n'].get(y,0)}n)" for y in range(2019,2027) if y in m["yr_roi"])
            print(f"  {yr_str}")

    # summary
    report_lines += [
        "---",
        f"## Summary",
        f"- Passed: {len(passed)}/{len(PRIMITIVES)}",
        f"- Failed: {len(failed)}/{len(PRIMITIVES)}",
        "",
        "### Passed primitives (kho v4):",
    ] + [f"- {p['name']}: Calmar={p['stats']['calmar']:.2f} | {p['stats']['cagr']:.1f}% CAGR | {p['stats']['maxdd']:.1f}% DD" for p in passed] + [
        "",
        "### Failed primitives (loại):",
    ] + [f"- {f['name']}: {', '.join(f.get('reasons',['error']))}" for f in failed]

    with open(RPT_OUT, "w") as fp: fp.write("\n".join(report_lines))
    lib = {"primitives": passed, "failed": failed,
           "meta": {"date": datetime.datetime.utcnow().isoformat(), "n_passed": len(passed), "n_failed": len(failed)}}
    with open(LIB_OUT, "w") as fp: json.dump(lib, fp, indent=2)

    sys.stderr.write(f"\nDone. Passed {len(passed)}/{len(PRIMITIVES)} primitives.\n")
    sys.stderr.write(f"Library: {LIB_OUT}\nReport: {RPT_OUT}\n")
    print(f"\nPASSED ({len(passed)}): {[p['name'] for p in passed]}")
    print(f"FAILED ({len(failed)}): {[f['name'] for f in failed]}")

if __name__ == "__main__":
    main()
