#!/usr/bin/env python3
"""
audit-1h-breakout-7y.py — Breakout signals trên 1h timeframe, 7y full cycle.

Ý tưởng: S12/S13/S14 (4h) có edge nhưng chỉ ~1.5 entries/tháng.
Test cùng logic nhưng trên 1h → lý thuyết nhiều entries hơn, giữ RANGE regime.

Signals (1h bars):
  S12_1h: EMA50/200 cross trên 1h
  S13_1h: ATR breakout ×1.2 trên 1h (close > prev_close + ATR×1.2)
  S14_1h: Donchian(20) breakout trên 1h (close > max 20-bar 1h highs)

Simulate trên 1h bars (faster, SL/TP in 1h ATR units).
Filters: RANGE regime (1d) | EMA200 1h gate | ADX(14)>20 sticky 1h | ATR%ile≥50th (90-bar) | Vol>MA10×1.2
         Skip h=16 UTC | Skip Thu+Sun
SL: ATR_1h × 4 init → ATR_1h × 3 trail (transition 24h) — same ratio as hedge01
TP configs: baseline (no TP), OPT_A (50%@ATR×2 + trail 50%), OPT_B (33%@ATR×2 + 33%@ATR×5 + trail 33%)
Max hold: 200 bars 1h (~8 days) | Cooldown: S12=12h, S13=1h, S14=12h
"""
import json, datetime

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FEE = 0.05 / 100

SL_INIT  = 4.0; SL_TRAIL = 3.0; SL_TRANS = 24   # bars 1h
MAX_HOLD = 200
ADX_T    = 20; ATR_PCT_LB = 90; ATR_PCT_PCTL = 0.50
VOL_MA   = 10; VOL_MULT  = 1.2
DON_LB   = 20; ATR_BREAK = 1.2; CD = {"S12":12,"S13":1,"S14":12}

TPS_BASE = []
TPS_A    = [(2.0, 0.50), (4.0, 0.25)]
TPS_B    = [(2.0, 0.33), (5.0, 0.33)]
CONFIGS  = [("BASELINE", TPS_BASE), ("OPT_A ×2/×4 50/25", TPS_A), ("OPT_B ×2/×5 33/33", TPS_B)]

print("Loading data...")
raw = json.load(open(CACHE))

def load_tf(ms):
    b = {}
    for c in raw:
        k = c["time"] // ms; ts = k * ms
        if k not in b:
            b[k] = {"time":ts,"open":c["open"],"high":c["high"],"low":c["low"],"close":c["close"],"volume":c["volume"]}
        else:
            o = b[k]; o["high"]=max(o["high"],c["high"]); o["low"]=min(o["low"],c["low"])
            o["close"]=c["close"]; o["volume"]+=c["volume"]
    return [b[k] for k in sorted(b)]

bars1h = load_tf(3600*1000)
bars1d = load_tf(86400*1000)
n1h = len(bars1h)
c1h = [b["close"] for b in bars1h]
print(f"1h: {n1h} bars | 1d: {len(bars1d)} bars")
print(f"Range: {datetime.datetime.utcfromtimestamp(bars1h[0]['time']/1000):%Y-%m-%d} → {datetime.datetime.utcfromtimestamp(bars1h[-1]['time']/1000):%Y-%m-%d}")

# ── Indicators ────────────────────────────────────────────────────────────────
def ema_s(xs, p):
    k = 2/(p+1); out = [None]*len(xs); e = None
    for i, x in enumerate(xs):
        e = x if e is None else x*k+e*(1-k); out[i] = e
    return out

def _dm_tr(bars):
    nn=len(bars); pdm=[0.0]*nn; ndm=[0.0]*nn; tr=[0.0]*nn
    for i in range(1,nn):
        up=bars[i]["high"]-bars[i-1]["high"]; dn=bars[i-1]["low"]-bars[i]["low"]
        pdm[i]=up if up>dn and up>0 else 0; ndm[i]=dn if dn>up and dn>0 else 0
        tr[i]=max(bars[i]["high"]-bars[i]["low"],abs(bars[i]["high"]-bars[i-1]["close"]),abs(bars[i]["low"]-bars[i-1]["close"]))
    return pdm,ndm,tr

def adx_w(bars, period=14):
    pdm,ndm,tr=_dm_tr(bars); nn=len(bars)
    if nn<=period+1: return [None]*nn
    smTR=sum(tr[1:period+1]); smP=sum(pdm[1:period+1]); smN=sum(ndm[1:period+1])
    dx_arr=[]; av=None; out=[None]*nn
    for i in range(period+1,nn):
        smTR=smTR-smTR/period+tr[i]; smP=smP-smP/period+pdm[i]; smN=smN-smN/period+ndm[i]
        pdi=smP/smTR*100 if smTR>0 else 0; ndi=smN/smTR*100 if smTR>0 else 0
        dx=abs(pdi-ndi)/(pdi+ndi)*100 if (pdi+ndi)>0 else 0
        dx_arr.append(dx)
        if len(dx_arr)<period: continue
        elif len(dx_arr)==period: av=sum(dx_arr)/period
        else: av=(av*(period-1)+dx)/period
        out[i]=av
    return out

def atr_s(bars, period=14):
    _,_,tr=_dm_tr(bars); nn=len(bars); atr=[None]*nn
    s=sum(tr[1:period+1]); atr[period]=s/period
    for i in range(period+1,nn): atr[i]=(atr[i-1]*(period-1)+tr[i])/period
    return atr

e50_1h  = ema_s(c1h, 50)
e200_1h = ema_s(c1h, 200)
atr1h   = atr_s(bars1h)
adx1h   = adx_w(bars1h)

# ── Regime 1d ─────────────────────────────────────────────────────────────────
def regime_build():
    cs=[b["close"] for b in bars1d]; nd=len(bars1d); rr=["RANGE"]*nd
    for i in range(200,nd):
        ma200=sum(cs[i-199:i+1])/200; ma50=sum(cs[i-50:i+1])/50
        ar=sum((b["high"]-b["low"])/b["close"] for b in bars1d[i-19:i+1])/20
        if cs[i]<ma200: rr[i]="BEAR"
        elif cs[i]>ma50 and ma50>ma200 and ar>0.04: rr[i]="BULL"
    out=["RANGE"]*nd; cur="RANGE"; cnt=0; lr="RANGE"
    for i in range(nd):
        r=rr[i]
        if r==lr: cnt+=1
        else: cnt=1; lr=r
        if cnt>=3: cur=r
        out[i]=cur
    return {bars1d[i]["time"]//86400000: out[i] for i in range(nd)}

print("Building regime..."); reg_map=regime_build()
def get_reg(ts): return reg_map.get(ts//86400000,"RANGE")

# ── ATR percentile filter ─────────────────────────────────────────────────────
def atp(i): return atr1h[i]/c1h[i] if atr1h[i] and c1h[i] else None
def atp_pass(i):
    if i < ATR_PCT_LB+14: return False
    vs = [atp(j) for j in range(i-ATR_PCT_LB,i) if atp(j)]
    if len(vs) < ATR_PCT_LB: return False
    cur = atp(i); return cur is not None and cur >= sorted(vs)[int(len(vs)*ATR_PCT_PCTL)]

def vol_pass(i):
    if i < VOL_MA: return False
    ma = sum(bars1h[j]["volume"] for j in range(i-VOL_MA,i))/VOL_MA
    return bars1h[i]["volume"] >= ma*VOL_MULT

def utc_h(ts):  return datetime.datetime.utcfromtimestamp(ts/1000).hour
def utc_dw(ts): return datetime.datetime.utcfromtimestamp(ts/1000).weekday()

def base_filt(i):
    if adx1h[i] is None or adx1h[i] <= ADX_T: return False
    if i < 1 or adx1h[i-1] is None or adx1h[i-1] <= ADX_T: return False  # sticky 2 bars
    if e200_1h[i] is None or c1h[i] < e200_1h[i]: return False
    if not atp_pass(i): return False
    ts = bars1h[i]["time"]
    if utc_h(ts) == 16: return False
    if utc_dw(ts) in (3, 6): return False
    return get_reg(ts) == "RANGE"

# ── Signals ────────────────────────────────────────────────────────────────────
def sig_s12(i):
    if i < 1 or None in (e50_1h[i],e200_1h[i],e50_1h[i-1],e200_1h[i-1]): return False
    return e50_1h[i-1] <= e200_1h[i-1] and e50_1h[i] > e200_1h[i]

def sig_s13(i):
    return bool(atr1h[i] and i >= 1 and c1h[i] > bars1h[i-1]["close"] + atr1h[i]*ATR_BREAK)

def sig_s14(i):
    if i < DON_LB: return False
    return c1h[i] > max(bars1h[j]["high"] for j in range(i-DON_LB, i))

sigs = {"S12":sig_s12, "S13":sig_s13, "S14":sig_s14}
do_vol = {"S12":False, "S13":True, "S14":True}

# ── Simulate on 1h bars ───────────────────────────────────────────────────────
def sim_1h(ei, tps):
    ep = c1h[ei]; ae = atr1h[ei]
    if ae is None or ae <= 0: return None
    sl = ep - ae*SL_INIT; hwm = ep; remaining = 1.0; locked = 0.0; tp_idx = 0
    for h in range(1, MAX_HOLD+1):
        j = ei+h
        if j >= n1h: break
        while tp_idx < len(tps):
            tm, tf = tps[tp_idx]
            if bars1h[j]["high"] >= ep+ae*tm:
                locked += tf*(ae*tm)/ep; remaining -= tf; tp_idx += 1
            else: break
        mult = SL_INIT if h < SL_TRANS else SL_TRAIL
        if c1h[j] > hwm: hwm = c1h[j]; sl = hwm - ae*mult
        elif h >= SL_TRANS:
            t = hwm - ae*SL_TRAIL
            if t > sl: sl = t
        if bars1h[j]["low"] <= sl:
            return locked + remaining*(sl-ep)/ep - 2*FEE, h
    j = min(ei+MAX_HOLD, n1h-1)
    return locked + remaining*(c1h[j]-ep)/ep - 2*FEE, MAX_HOLD

# ── Run ────────────────────────────────────────────────────────────────────────
def run_range(tps, yr_from, yr_to):
    trades = []; last = {s:0 for s in ["S12","S13","S14"]}
    for i in range(250, n1h-MAX_HOLD-1):
        ts = bars1h[i]["time"]
        yr = datetime.datetime.utcfromtimestamp(ts/1000).year
        if yr < yr_from or yr > yr_to: continue
        if not base_filt(i): continue
        for sn in ["S12","S13","S14"]:
            if i - last[sn] < CD[sn]: continue
            if not sigs[sn](i): continue
            if do_vol[sn] and not vol_pass(i): continue
            r = sim_1h(i, tps)
            if r is None: continue
            ret, h = r
            trades.append({"ret":ret,"h":h,"sn":sn,"yr":yr})
            last[sn] = i
    return trades

def run_yr(tps, yr):
    return run_range(tps, yr, yr)

def stats(trades):
    if not trades: return None
    rets = [t["ret"] for t in trades]; nn = len(rets)
    mean = sum(rets)/nn; sd = (sum((r-mean)**2 for r in rets)/nn)**0.5 or 1e-9
    ra = mean/sd; wr = sum(1 for r in rets if r>0)/nn*100; roi = sum(rets)*100
    wins=[r for r in rets if r>0]; loss=[r for r in rets if r<=0]
    rr=(sum(wins)/len(wins))/abs(sum(loss)/len(loss)) if wins and loss else float('nan')
    eq=0; pk=0; mdd=0
    for r in rets:
        eq+=r
        if eq>pk: pk=eq
        if pk-eq>mdd: mdd=pk-eq
    return dict(n=nn,ra=ra,wr=wr,roi=roi,rr=rr,dd=mdd*100,avg_h=sum(t["h"] for t in trades)/nn)

YEARS = [2019,2020,2021,2022,2023,2024,2025,2026]

# ── Aggregate comparison (3 TP configs) ──────────────────────────────────────
print("\n"+"="*90)
print("1h BREAKOUT — S12(EMA cross) + S13(ATR×1.2) + S14(Donchian 20) — 7y full")
print("Filters: RANGE + EMA200_1h gate + ADX(14)>20 sticky + ATR%ile≥50 + Vol>MA10×1.2")
print("         skip h=16 UTC + Thu + Sun")
print("SL: ATR×4→×3 (24h trans) | Max hold: 200 bars 1h (~8 days) | CD: S12=12h S13=1h S14=12h")
print("="*90)

print(f"\n── 7y AGGREGATE — 3 TP configs ──")
print(f"  {'Config':22s}  {'n':>5}  {'RA':>7}  {'WR':>5}  {'R:R':>5}  {'ROI%':>8}  {'DD%':>6}  {'AvgH':>6}")
print(f"  {'-'*75}")

best_cfg = None
for label, tps in CONFIGS:
    print(f"  Running {label}...", end="\r")
    trades = run_range(tps, 2019, 2026)
    m = stats(trades)
    if m is None:
        print(f"  {label:22s}  no trades"); continue
    flag = " ← best" if (best_cfg is None or m['ra'] > (stats(run_range(best_cfg[1],2019,2026)) or {}).get('ra',-99)) else ""
    print(f"  {label:22s}  {m['n']:>5}  {m['ra']:>+7.3f}  {m['wr']:>4.0f}%  {m['rr']:>5.2f}  {m['roi']:>+8.1f}%  {m['dd']:>5.1f}%  {m['avg_h']:>5.0f}")
    if best_cfg is None: best_cfg = (label, tps)

# ── Per-setup breakdown ───────────────────────────────────────────────────────
print(f"\n── Per-setup (1h) — BASELINE ──")
print(f"  {'Setup':8s}  {'n':>5}  {'RA':>7}  {'WR':>5}  {'ROI%':>8}")
print(f"  {'-'*40}")
all_trades = run_range(TPS_BASE, 2019, 2026)
for sn in ["S12","S13","S14"]:
    t = [x for x in all_trades if x['sn']==sn]
    m = stats(t)
    if m: print(f"  {sn:8s}  {m['n']:>5}  {m['ra']:>+7.3f}  {m['wr']:>4.0f}%  {m['roi']:>+8.1f}%")
    else: print(f"  {sn:8s}  no trades")

# ── Compare: 1h vs 4h baseline ────────────────────────────────────────────────
print(f"\n── Comparison: 1h vs 4h BASELINE ──")
m_1h = stats(run_range(TPS_BASE,2019,2026))
print(f"  {'TF':6s}  {'n':>5}  {'RA':>7}  {'WR':>5}  {'R:R':>5}  {'ROI%':>8}  {'DD%':>6}  {'n/month':>8}")
print(f"  {'-'*65}")
if m_1h:
    n_months = 88  # Jan 2019 to May 2026
    print(f"  {'1h':6s}  {m_1h['n']:>5}  {m_1h['ra']:>+7.3f}  {m_1h['wr']:>4.0f}%  {m_1h['rr']:>5.2f}  {m_1h['roi']:>+8.1f}%  {m_1h['dd']:>5.1f}%  {m_1h['n']/n_months:>8.1f}")
print(f"  {'4h':6s}  {107:>5}  {'+0.515':>7}  {'64%':>5}  {'2.44':>5}  {'+396%':>8}  {'20.7%':>6}  {'1.2':>8}  (from reference)")

# ── Per-year breakdown (all 3 configs) ───────────────────────────────────────
for label, tps in CONFIGS:
    print(f"\n── Per-year: {label} ──")
    print(f"  {'Year':>6}  {'n':>5}  {'RA':>7}  {'WR':>5}  {'ROI%':>8}  {'Result':>8}")
    print(f"  {'-'*52}")
    pos=0; tot=0
    for yr in YEARS:
        t = run_yr(tps, yr)
        if not t:
            print(f"  {yr:>6}  {'0':>5}  {'—':>7}  {'—':>5}  {'—':>8}  (skip)")
            continue
        m = stats(t); tot+=1; ok="✓" if m['roi']>0 else "✗"
        if m['roi']>0: pos+=1
        print(f"  {yr:>6}  {m['n']:>5}  {m['ra']:>+7.3f}  {m['wr']:>4.0f}%  {m['roi']:>+8.1f}%  {ok:>8}")
    print(f"  Stability: {pos}/{tot}")

print("\nDone.")
