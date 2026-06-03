#!/usr/bin/env python3
"""Loop iter12: PORTFOLIO SIZING / ALLOCATION for the book.
Sleeves: hedge01-BTC (7y), turtle-BTC (7y), hedge01-SOL (3y window, deployed-SAFE params).
Reuses run_hedge01 + turtle block from loop-iter10-sol-validation.py / backtest engine.

Tasks: (1) 3-sleeve monthly matrix + standalone stats + 3x3 corr,
(2) allocation scheme comparison (EW / risk-parity / RP-capped / Sharpe-wt / min-var),
(3) OOS walk-forward weight robustness, (4) DD-budget + leverage -> recommended tables.
Judge: Sharpe + dollars + Calmar. Prefer SIMPLE robust over overfit-optimized.
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

# ---- pull run_hedge01 from iter10 (identical engine wrapper) ----
IP = "/Users/lap16116/BTC_PC/btc-dashboard/tools/loop-iter10-sol-validation.py"
# iter10 runs at import (prints). We only want run_hedge01; re-implement minimal turtle + reuse via exec of the function.
# Simpler: re-declare run_hedge01 here (copied, no side effects).
def mo_of(ts): return datetime.datetime.utcfromtimestamp(ts/1000).strftime("%Y-%m")
def yr_of(ts): return datetime.datetime.utcfromtimestamp(ts/1000).year

def run_hedge01(cache, P):
    H.CACHE = cache
    bars4h = H.load_tf(H.H4); bars1h = H.load_tf(3600*1000); bars1d = H.load_tf(86400*1000)
    n = len(bars4h); c4 = [b["close"] for b in bars4h]
    e50 = H.ema_s(c4, 50); e200 = H.ema_s(c4, 200)
    atr4 = H.atr_series(bars4h, P["ATR_P"]); adx4 = H.adx_wilder(bars4h, P["ADX_P"])
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
    mo = defaultdict(float); last = {s: 0 for s in sigs}
    for i in range(250, n-P["MAX_HOLD"]):
        for sn in ("S12", "S13", "S14"):
            if sigs[sn](i) != "LONG": continue
            if i-last[sn] < CD[sn]: continue
            if do_vol[sn] and not vol_pass(i): continue
            if not filt(i): continue
            r = sim(i)
            if r is None: continue
            ret, h = r; cts = bars4h[min(i+h, n-1)]["time"]
            mo[mo_of(cts)] += ret; last[sn] = i
    return dict(mo)

def run_turtle(cache):
    H.CACHE = cache
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
    return dict(tur_mo)

SAFE = dict(ADX_THRESH=15, ADX_P=12, ATR_P=12, SL_INIT=3.0, SL_TRAIL=3.5, SL_TRANS=64,
            ATR_BREAK=1.3, VOL_MA=16, VOL_MULT=1.4, DLB=18, MAX_HOLD=200)
BTCP = dict(ADX_THRESH=20, ADX_P=14, ATR_P=14, SL_INIT=4.0, SL_TRAIL=3.0, SL_TRANS=24,
            ATR_BREAK=1.2, VOL_MA=10, VOL_MULT=1.2, DLB=20, MAX_HOLD=200)

print("Building sleeves...")
btc_mo = run_hedge01(BTC, BTCP)
tur_mo = run_turtle(BTC)
sol_mo = run_hedge01(SOL, SAFE)

# ---------------- helpers ----------------
def series(mo, keys): return [mo.get(k, 0.) for k in keys]
def mean(v): return sum(v)/len(v)
def std(v):
    m = mean(v); return (sum((x-m)**2 for x in v)/len(v))**0.5 or 1e-12
def sharpe(v): return mean(v)/std(v)*math.sqrt(12)
def roi(v): return sum(v)*100  # additive ret% over window (small-month approx)
def maxdd(v):
    cum=0.; peak=0.; mdd=0.
    for x in v:
        cum += x*100; peak=max(peak,cum); mdd=min(mdd,cum-peak)
    return mdd  # negative %
def calmar(v):
    dd = maxdd(v); mo_n=len(v)
    ann = sum(v)/ (mo_n/12) *100
    return ann/abs(dd) if dd<0 else float('inf')
def corr(a,b):
    ma,mb=mean(a),mean(b); sa,sb=std(a),std(b)
    return sum((a[i]-ma)*(b[i]-mb) for i in range(len(a)))/(len(a)*sa*sb)

def combine(sleeves, w):
    n=len(sleeves[0]); return [sum(w[j]*sleeves[j][i] for j in range(len(sleeves))) for i in range(n)]

def book_stats(sleeves, w):
    bk = combine(sleeves, w)
    return dict(sharpe=sharpe(bk), roi=roi(bk), mdd=maxdd(bk), calmar=calmar(bk),
                retdd=roi(bk)/abs(maxdd(bk)) if maxdd(bk)<0 else float('inf'))

# ---- weight schemes (return weights summing to 1) ----
def w_equal(sleeves): k=len(sleeves); return [1/k]*k
def w_riskparity(sleeves):
    iv=[1/std(s) for s in sleeves]; t=sum(iv); return [x/t for x in iv]
def w_rp_capped(sleeves, cap):
    w=w_riskparity(sleeves)
    for _ in range(50):
        over=[i for i in range(len(w)) if w[i]>cap+1e-9]
        if not over: break
        excess=sum(w[i]-cap for i in over)
        for i in over: w[i]=cap
        under=[i for i in range(len(w)) if w[i]<cap-1e-9]
        tu=sum(w[i] for i in under) or 1e-9
        for i in under: w[i]+=excess*w[i]/tu
    s=sum(w); return [x/s for x in w]
def w_sharpe(sleeves):
    sh=[max(sharpe(s),0.01) for s in sleeves]; t=sum(sh); return [x/t for x in sh]
def w_minvar(sleeves):
    # long-only min-variance via projected coordinate descent on cov matrix
    k=len(sleeves); m=[mean(s) for s in sleeves]
    cov=[[sum((sleeves[a][i]-m[a])*(sleeves[b][i]-m[b]) for i in range(len(sleeves[0])))/len(sleeves[0]) for b in range(k)] for a in range(k)]
    w=[1/k]*k
    for _ in range(2000):
        for a in range(k):
            # optimize w[a] holding others, then renorm (long-only)
            rest=sum(cov[a][b]*w[b] for b in range(k) if b!=a)
            wa=-rest/cov[a][a] if cov[a][a]>0 else 0
            w[a]=max(0.,wa)
            s=sum(w) or 1e-9; w=[x/s for x in w]
    return w

SCHEMES = [
    ("Equal (1/3)", lambda sl: w_equal(sl)),
    ("Risk-parity (inv-vol)", lambda sl: w_riskparity(sl)),
    ("RP capped 40%", lambda sl: w_rp_capped(sl,0.40)),
    ("RP capped 50%", lambda sl: w_rp_capped(sl,0.50)),
    ("Sharpe-weighted", lambda sl: w_sharpe(sl)),
    ("Min-variance (LO)", lambda sl: w_minvar(sl)),
]

# ============ TASK 1: matrix on common (SOL) window ============
print("="*80); print("TASK 1 — 3-sleeve monthly matrix (common = SOL window)"); print("="*80)
solkeys=sorted(sol_mo)
keys=[k for k in sorted(set(btc_mo)|set(tur_mo)|set(sol_mo)) if k>=solkeys[0] and k<=solkeys[-1]]
print(f"  common window: {keys[0]} -> {keys[-1]}  ({len(keys)} months)")
S_btc=series(btc_mo,keys); S_tur=series(tur_mo,keys); S_sol=series(sol_mo,keys)
sleeves=[S_btc,S_tur,S_sol]; names=["BTC-h01","turtle","SOL-h01"]
print("\n  Standalone (common window):")
print(f"  {'sleeve':12} {'Sharpe':>8} {'vol%mo':>8} {'MaxDD%':>8} {'ROI%':>8}")
for nm,s in zip(names,sleeves):
    print(f"  {nm:12} {sharpe(s):>+8.2f} {std(s)*100:>8.1f} {maxdd(s):>+8.0f} {roi(s):>+8.0f}")
print("\n  3x3 correlation:")
print("  "+" "*10+"".join(f"{n:>10}" for n in names))
for i,n in enumerate(names):
    print("  "+f"{n:10}"+"".join(f"{corr(sleeves[i],sleeves[j]):>+10.3f}" for j in range(3)))

# ============ TASK 2: scheme comparison (full common window) ============
print("\n"+"="*80); print("TASK 2 — Allocation scheme comparison (full common window)"); print("="*80)
print(f"  {'scheme':24} {'weights(B/T/S)':22} {'Sharpe':>7} {'ROI%':>7} {'MaxDD%':>7} {'Calmar':>7} {'ret/DD':>7}")
results={}
for nm,fn in SCHEMES:
    w=fn(sleeves); bs=book_stats(sleeves,w); results[nm]=(w,bs)
    wt=f"{w[0]*100:.0f}/{w[1]*100:.0f}/{w[2]*100:.0f}"
    print(f"  {nm:24} {wt:22} {bs['sharpe']:>+7.2f} {bs['roi']:>+7.0f} {bs['mdd']:>+7.0f} {bs['calmar']:>+7.2f} {bs['retdd']:>+7.2f}")

# ============ TASK 3: OOS walk-forward weight robustness ============
print("\n"+"="*80); print("TASK 3 — OOS weight robustness (optimize H1, apply H2)"); print("="*80)
half=len(keys)//2
def sub(s,a,b): return s[a:b]
sl1=[sub(s,0,half) for s in sleeves]; sl2=[sub(s,half,len(keys))]  # placeholder
sl2=[sub(s,half,len(keys)) for s in sleeves]
print(f"  H1: {keys[0]}..{keys[half-1]} ({half}m)   H2: {keys[half]}..{keys[-1]} ({len(keys)-half}m)")
print(f"  {'scheme':24} {'wH1(B/T/S)':18} {'H2 Sharpe':>10} {'H2 ROI%':>8} {'H2 MaxDD%':>9} {'H2 ret/DD':>9}")
oos={}
for nm,fn in SCHEMES:
    w=fn(sl1)  # weights from first half
    bs=book_stats(sl2,w)  # applied OOS
    oos[nm]=(w,bs)
    wt=f"{w[0]*100:.0f}/{w[1]*100:.0f}/{w[2]*100:.0f}"
    print(f"  {nm:24} {wt:18} {bs['sharpe']:>+10.2f} {bs['roi']:>+8.0f} {bs['mdd']:>+9.0f} {bs['retdd']:>+9.2f}")
# weight drift: full-sample vs H1 weights
print("\n  Weight drift (full-sample w vs H1 w) — high drift = overfit-prone:")
for nm,_ in SCHEMES:
    wf=results[nm][0]; w1=oos[nm][0]
    drift=sum(abs(wf[i]-w1[i]) for i in range(3))/2*100  # L1/2 -> % turnover
    print(f"    {nm:24} turnover={drift:>5.0f}%")

# ============ TASK 4: DD-budget + leverage ============
print("\n"+"="*80); print("TASK 4 — DD-budget + leverage (target book MaxDD = 15%)"); print("="*80)
TARGET_DD=15.0
def lever_for_dd(sleeves_, w, target):
    bs=book_stats(sleeves_,w); base_dd=abs(bs['mdd'])
    if base_dd<1e-6: return 1.0, bs
    lev=target/base_dd
    return lev, bs
# (a) NOW: BTC+turtle only, FULL 7y window (both have it)
keys7=[k for k in sorted(set(btc_mo)|set(tur_mo))]
B7=series(btc_mo,keys7); T7=series(tur_mo,keys7)
sl_now=[B7,T7]
def rp2(sl): iv=[1/std(s) for s in sl]; t=sum(iv); return [x/t for x in iv]
for label,wf in [("Equal 50/50",[0.5,0.5]),("Risk-parity",rp2(sl_now)),("RP cap40",None)]:
    if wf is None:
        w=rp2(sl_now); cap=0.6
        w=[min(x,cap) for x in w]; s=sum(w); w=[x/s for x in w]; wf=w
    bs=book_stats(sl_now,wf); lev,_=lever_for_dd(sl_now,wf,TARGET_DD)
    print(f"  NOW(7y BTC+turtle) {label:14} w={wf[0]*100:.0f}/{wf[1]*100:.0f}  Sharpe={bs['sharpe']:+.2f} DD={bs['mdd']:+.0f}% -> lever x{lev:.2f} for {TARGET_DD:.0f}%DD, ROI@lev={bs['roi']*lev:+.0f}%")

print("\n  FUTURE (3-sleeve, common SOL window) DD-budget:")
for nm in ["Equal (1/3)","RP capped 40%","Risk-parity (inv-vol)"]:
    w=results[nm][0]; bs=results[nm][1]; lev,_=lever_for_dd(sleeves,w,TARGET_DD)
    print(f"    {nm:24} w={w[0]*100:.0f}/{w[1]*100:.0f}/{w[2]*100:.0f}  Sharpe={bs['sharpe']:+.2f} DD={bs['mdd']:+.0f}% -> lever x{lev:.2f}, ROI@lev={bs['roi']*lev:+.0f}%")

# dump JSON
out=dict(
  window=[keys[0],keys[-1]], n=len(keys),
  standalone={nm:dict(sharpe=sharpe(s),vol=std(s)*100,mdd=maxdd(s),roi=roi(s)) for nm,s in zip(names,sleeves)},
  corr=[[corr(sleeves[i],sleeves[j]) for j in range(3)] for i in range(3)],
  schemes={nm:dict(w=results[nm][0],**results[nm][1]) for nm,_ in SCHEMES},
  oos={nm:dict(wH1=oos[nm][0],**oos[nm][1]) for nm,_ in SCHEMES},
  now7y=dict(keys=[keys7[0],keys7[-1]],n=len(keys7)),
)
print("\nJSON "+json.dumps(out))
