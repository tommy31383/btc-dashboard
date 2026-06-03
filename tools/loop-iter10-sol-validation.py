#!/usr/bin/env python3
"""Loop iter10: SOL hedge01 re-validation with DEPLOYED-SAFE params (solPaperLogger v0.4.77)
vs the REJECTED R87-overfit params. Reuses engine helpers from backtest-bull-regime-reaudit-7y.py.

Deployed-safe SOL params (src/engine/solPaperLogger.ts):
  ADX_THRESH=15, ADX_PERIOD=12 (ATR also uses period 12), SL_INIT=3.0, SL_TRAIL=3.5,
  SL_TRANS=64 bars, ATR_BREAK=1.3, VOL_MA=16, VOL_MULT=1.4, DLB=18, RANGE-only,
  EMA200-1h gate, ATR%ile>=50th/90, MAX_HOLD=200, CD S12/S14=36 S13=1. NO funding gate.
R87-overfit (prior general-rule doc): ADX=15, ABM=1.5, SL_TRANS=20, VOL_MA=16, SL_INIT/TRAIL same-ish.
"""
import importlib.util, datetime, math, json
from collections import defaultdict

HP = "/Users/lap16116/BTC_PC/btc-dashboard/tools/backtest-bull-regime-reaudit-7y.py"
spec = importlib.util.spec_from_file_location("H", HP)
H = importlib.util.module_from_spec(spec); spec.loader.exec_module(H)
FEE = H.FEE
CC = "/Users/lap16116/BTC_PC/btc-dashboard/.cache"
SOL = f"{CC}/binance-sol-5m-3y.json"
BTC = f"{CC}/binance-5m-7y.json"

def mo_of(ts): return datetime.datetime.utcfromtimestamp(ts/1000).strftime("%Y-%m")
def yr_of(ts): return datetime.datetime.utcfromtimestamp(ts/1000).year


def run_hedge01(cache, P):
    """P = dict of params. Returns (monthly, yearly, trades)."""
    H.CACHE = cache
    bars4h = H.load_tf(H.H4); bars1h = H.load_tf(3600*1000); bars1d = H.load_tf(86400*1000)
    n = len(bars4h); c4 = [b["close"] for b in bars4h]
    e50 = H.ema_s(c4, 50); e200 = H.ema_s(c4, 200)
    atr4 = H.atr_series(bars4h, P["ATR_P"])
    adx4 = H.adx_wilder(bars4h, P["ADX_P"])
    e200_1h = H.ema_s([b["close"] for b in bars1h], 200); h1t = [b["time"] for b in bars1h]
    regime_1d = H.regime_with_persistence(bars1d)
    reg_map = {b["time"]//86400000: regime_1d[i] for i, b in enumerate(bars1d)}
    def get_reg(ts): return reg_map.get(ts//86400000, "RANGE")
    def atp(i): return None if atr4[i] is None else atr4[i]/c4[i]
    def atp_pass(i):
        if i < 90+14: return False
        vs = [atp(j) for j in range(i-90, i) if atp(j) is not None]
        if len(vs) < 90: return False
        cur = atp(i); return cur is not None and cur >= sorted(vs)[int(len(vs)*0.50)]
    def vol_pass(i):
        if i < P["VOL_MA"]: return False
        ma = sum(bars4h[j]["volume"] for j in range(i-P["VOL_MA"], i))/P["VOL_MA"]
        return bars4h[i]["volume"] >= ma*P["VOL_MULT"]
    def e200_1h_at(ts):
        lo, hi, idx = 0, len(h1t)-1, 0
        while lo <= hi:
            m = (lo+hi)//2
            if h1t[m] <= ts: idx = m; lo = m+1
            else: hi = m-1
        return e200_1h[idx]
    def filt(i):
        adv = adx4[i]
        if adv is None or adv <= P["ADX_THRESH"]: return False
        ap = adx4[i-1] if i >= 1 else None
        if ap is None or ap <= P["ADX_THRESH"]: return False
        e1h = e200_1h_at(bars4h[i]["time"])
        if e1h is None or c4[i] < e1h: return False
        if not atp_pass(i): return False
        return get_reg(bars4h[i]["time"]) == "RANGE"
    def sim(ei):
        ep = c4[ei]; ae = atr4[ei]
        if ae is None or ae <= 0: return None
        sl = ep - ae*P["SL_INIT"]; hwm = ep
        for h in range(1, P["MAX_HOLD"]+1):
            j = ei+h
            if j >= n: break
            mult = P["SL_INIT"] if h < P["SL_TRANS"] else P["SL_TRAIL"]
            if c4[j] > hwm: hwm = c4[j]; sl = hwm - ae*mult
            elif h >= P["SL_TRANS"]:
                t = hwm - ae*P["SL_TRAIL"]
                if t > sl: sl = t
            if bars4h[j]["low"] <= sl: return (sl-ep)/ep - 2*FEE, h
        j = min(ei+P["MAX_HOLD"], n-1)
        return (c4[j]-ep)/ep - 2*FEE, P["MAX_HOLD"]
    def sig_s12(i):
        if None in (e50[i], e200[i]) or i < 1 or None in (e50[i-1], e200[i-1]): return None
        return "LONG" if e50[i-1] <= e200[i-1] and e50[i] > e200[i] else None
    def sig_s13(i):
        if atr4[i] is None or i < 1: return None
        return "LONG" if c4[i] > bars4h[i-1]["close"]+atr4[i]*P["ATR_BREAK"] else None
    def sig_s14(i):
        if i < P["DLB"]: return None
        hi = max(bars4h[j]["high"] for j in range(i-P["DLB"], i))
        return "LONG" if c4[i] > hi else None
    sigs = {"S12": sig_s12, "S13": sig_s13, "S14": sig_s14}
    do_vol = {"S12": False, "S13": True, "S14": True}
    CD = {"S12": 36, "S13": 1, "S14": 36}
    mo = defaultdict(float); yrr = defaultdict(float); trades = []; last = {s: 0 for s in sigs}
    for i in range(250, n-P["MAX_HOLD"]):
        for sn in ("S12", "S13", "S14"):
            if sigs[sn](i) != "LONG": continue
            if i-last[sn] < CD[sn]: continue
            if do_vol[sn] and not vol_pass(i): continue
            if not filt(i): continue
            r = sim(i)
            if r is None: continue
            ret, h = r; cts = bars4h[min(i+h, n-1)]["time"]
            mo[mo_of(cts)] += ret; yrr[yr_of(cts)] += ret
            trades.append((ret, yr_of(cts), mo_of(cts)))
            last[sn] = i
    return mo, yrr, trades


def stats(mo, yrr, trades, label):
    if not trades:
        print(f"  {label}: NO TRADES"); return None
    tot = sum(t[0] for t in trades)*100
    wr = sum(1 for t in trades if t[0] > 0)/len(trades)*100
    vals = list(mo.values())
    m = sum(vals)/len(vals); d = (sum((v-m)**2 for v in vals)/len(vals))**0.5 or 1e-9
    sharpe = m/d*math.sqrt(12)
    # equity curve maxDD on monthly cum
    cum = 0; peak = 0; mdd = 0
    for k in sorted(mo):
        cum += mo[k]*100; peak = max(peak, cum); mdd = min(mdd, cum-peak)
    print(f"  {label}")
    print(f"    n={len(trades)}  ret%tot={tot:+.0f}  WR={wr:.0f}%  monthlySharpe(x√12)={sharpe:+.2f}  maxDD={mdd:+.0f}%")
    py = " ".join(f"{y}:{yrr[y]*100:+.0f}%" for y in sorted(yrr))
    print(f"    per-year: {py}")
    pos = sum(1 for y in yrr if yrr[y] > 0)
    print(f"    years-positive: {pos}/{len(yrr)}")
    return {"n": len(trades), "tot": tot, "wr": wr, "sharpe": sharpe, "mdd": mdd,
            "yrr": {y: yrr[y]*100 for y in yrr}, "mo": dict(mo)}


SAFE = dict(ADX_THRESH=15, ADX_P=12, ATR_P=12, SL_INIT=3.0, SL_TRAIL=3.5, SL_TRANS=64,
            ATR_BREAK=1.3, VOL_MA=16, VOL_MULT=1.4, DLB=18, MAX_HOLD=200)
R87 = dict(ADX_THRESH=15, ADX_P=14, ATR_P=14, SL_INIT=3.0, SL_TRAIL=3.5, SL_TRANS=20,
           ATR_BREAK=1.5, VOL_MA=16, VOL_MULT=1.4, DLB=20, MAX_HOLD=200)

print("="*80)
print("TASK 1+2: SOL hedge01 — DEPLOYED-SAFE vs R87-OVERFIT params")
print("="*80)
sol_safe = run_hedge01(SOL, SAFE)
r_safe = stats(*sol_safe, "SOL deployed-SAFE (ADX15/12, SL3.0/3.5/64, ABM1.3, DLB18)")
print()
sol_r87 = run_hedge01(SOL, R87)
r_r87 = stats(*sol_r87, "SOL R87-overfit (ADX15/14, SL3.0/3.5/20, ABM1.5, DLB20)")

# Jackpot analysis on SAFE
print("\n" + "="*80)
print("TASK 2b: JACKPOT DEPENDENCE (deployed-SAFE)")
print("="*80)
mo, yrr, trades = sol_safe
tot = sum(t[0] for t in trades)*100
# exclude best year
byr = max(yrr, key=lambda y: yrr[y])
tot_exbest_yr = (sum(t[0] for t in trades) - yrr[byr])*100
# exclude best trade
bt = max(t[0] for t in trades)
tot_exbest_tr = tot - bt*100
# top trade contribution
srt = sorted([t[0] for t in trades], reverse=True)
top1 = srt[0]*100; top3 = sum(srt[:3])*100; top5 = sum(srt[:5])*100
print(f"  total ret% = {tot:+.0f}")
print(f"  best year = {byr} ({yrr[byr]*100:+.0f}%) → ex-best-year total = {tot_exbest_yr:+.0f}%  (survives>0? {'YES' if tot_exbest_yr>0 else 'NO'})")
print(f"  best single trade = {bt*100:+.1f}% → ex-best-trade total = {tot_exbest_tr:+.0f}%")
print(f"  top1 trade = {top1/tot*100:.0f}% of total | top3 = {top3/tot*100:.0f}% | top5 = {top5/tot*100:.0f}%")
per_yr_share = {y: yrr[y]*100/tot*100 for y in yrr}
print(f"  per-year share of total: " + " ".join(f"{y}:{per_yr_share[y]:.0f}%" for y in sorted(yrr)))

# ============ TASK 3: BTC hedge01 + turtle monthly, correlation, book ============
print("\n" + "="*80)
print("TASK 3: CORRELATION + BOOK IMPACT")
print("="*80)
btc_mo, btc_yrr, btc_tr = run_hedge01(BTC, dict(
    ADX_THRESH=20, ADX_P=14, ATR_P=14, SL_INIT=4.0, SL_TRAIL=3.0, SL_TRANS=24,
    ATR_BREAK=1.2, VOL_MA=10, VOL_MULT=1.2, DLB=20, MAX_HOLD=200))
# but BTC live also has calendar filters (h16/Thu-Sun) — engine run_hedge01 here omits them.
# For book-additivity purposes structural monthly stream is sufficient (corr & risk-parity).

# Turtle on BTC daily
H.CACHE = BTC
BD = H.load_tf(86400000); nd = len(BD); CCl = [b["close"] for b in BD]
DE, DX, CUT = 20, 10, 2.0
def atr_d(bars, p=14):
    m = len(bars); tr = [0.]*m
    for i in range(1, m): tr[i] = max(bars[i]["high"]-bars[i]["low"], abs(bars[i]["high"]-bars[i-1]["close"]), abs(bars[i]["low"]-bars[i-1]["close"]))
    o = [None]*m; o[p] = sum(tr[1:p+1])/p
    for i in range(p+1, m): o[i] = (o[i-1]*(p-1)+tr[i])/p
    return o
atrd = atr_d(BD); dhi = [None]*nd; dlo = [None]*nd
for i in range(DE, nd): dhi[i] = max(BD[j]["high"] for j in range(i-DE, i))
for i in range(DX, nd): dlo[i] = min(BD[j]["low"] for j in range(i-DX, i))
tur_mo = defaultdict(float); hold = False; e = 0.; a = 0.
for i in range(max(DE, 20), nd):
    if hold:
        ex = None
        if BD[i]["low"] <= e-a*CUT: ex = e-a*CUT
        elif dlo[i] is not None and CCl[i] < dlo[i]: ex = CCl[i]
        if ex is not None:
            tur_mo[mo_of(BD[i]["time"])] += (ex-e)/e - 2*FEE; hold = False
    if not hold and dhi[i] is not None and CCl[i] > dhi[i]:
        hold = True; e = CCl[i]; a = atrd[i] or 0

sol_mo = sol_safe[0]

def corr(a, b):
    keys = sorted(set(a) | set(b))
    xs = [a.get(k, 0.) for k in keys]; ys = [b.get(k, 0.) for k in keys]
    N = len(keys); mx = sum(xs)/N; my = sum(ys)/N
    cov = sum((xs[i]-mx)*(ys[i]-my) for i in range(N))/N
    sx = (sum((v-mx)**2 for v in xs)/N)**0.5; sy = (sum((v-my)**2 for v in ys)/N)**0.5
    return cov/(sx*sy) if sx > 0 and sy > 0 else 0

# restrict to overlapping SOL window (2023-05 onward) for fair corr
solkeys = set(sol_mo)
def restrict(d): return {k: v for k, v in d.items() if k >= min(solkeys)}
btc_r = restrict(btc_mo); tur_r = restrict(tur_mo)
print(f"  (corr window restricted to SOL span: {min(solkeys)} → {max(solkeys)})")
print(f"  monthly corr  SOL-hedge01 vs BTC-hedge01 = {corr(sol_mo, btc_r):+.3f}")
print(f"  monthly corr  SOL-hedge01 vs turtle-BTC   = {corr(sol_mo, tur_r):+.3f}")
print(f"  monthly corr  BTC-hedge01 vs turtle-BTC   = {corr(btc_r, tur_r):+.3f}")

def sharpe_of(mo, keys):
    vals = [mo.get(k, 0.) for k in keys]
    m = sum(vals)/len(vals); d = (sum((v-m)**2 for v in vals)/len(vals))**0.5 or 1e-9
    return m/d*math.sqrt(12)

def book_sharpe(streams, keys):
    # risk-parity: each stream normalized by its own std, equal weight
    norm = []
    for s in streams:
        vals = [s.get(k, 0.) for k in keys]
        m = sum(vals)/len(vals); sd = (sum((v-m)**2 for v in vals)/len(vals))**0.5 or 1e-9
        norm.append((vals, sd))
    comb = []
    for idx in range(len(keys)):
        comb.append(sum(v[idx]/sd for v, sd in norm)/len(norm))
    m = sum(comb)/len(comb); d = (sum((v-m)**2 for v in comb)/len(comb))**0.5 or 1e-9
    return m/d*math.sqrt(12)

keys = sorted(solkeys | set(btc_r) | set(tur_r))
print()
print(f"  --- BOOK Sharpe (risk-parity, SOL-window {len(keys)} months) ---")
print(f"  BTC-hedge01 alone         : {sharpe_of(btc_r, keys):+.2f}")
print(f"  turtle-BTC alone          : {sharpe_of(tur_r, keys):+.2f}")
print(f"  SOL-hedge01 alone         : {sharpe_of(sol_mo, keys):+.2f}")
b2 = book_sharpe([btc_r, tur_r], keys)
b3 = book_sharpe([btc_r, tur_r, sol_mo], keys)
print(f"  BOOK: BTC-h01 + turtle    : {b2:+.2f}")
print(f"  BOOK: BTC-h01 + turtle + SOL: {b3:+.2f}   (delta {b3-b2:+.2f})")

# ROI uplift: book ret% dollars at equal-risk weight. Use SOL-window totals.
def winsum(mo, keys): return sum(mo.get(k, 0.) for k in keys)*100
print()
print(f"  --- ROI (ret% over SOL window, equal notional per sleeve) ---")
print(f"  BTC-h01: {winsum(btc_r, keys):+.0f}%  turtle: {winsum(tur_r, keys):+.0f}%  SOL: {winsum(sol_mo, keys):+.0f}%")
print(f"  2-sleeve book sum ret%: {winsum(btc_r, keys)+winsum(tur_r, keys):+.0f}%")
print(f"  3-sleeve book sum ret%: {winsum(btc_r, keys)+winsum(tur_r, keys)+winsum(sol_mo, keys):+.0f}%")
uplift = winsum(sol_mo, keys)/(winsum(btc_r, keys)+winsum(tur_r, keys))*100
print(f"  SOL ROI uplift over 2-sleeve (equal weight): {uplift:+.0f}%")

# dump for MD
print("\nJSON_SAFE " + json.dumps(r_safe))
print("JSON_R87 " + json.dumps(r_r87))
