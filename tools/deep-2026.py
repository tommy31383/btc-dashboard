#!/usr/bin/env python3
"""
deep-2026.py — Đào sâu 2026 toàn diện
A. SHORT 2026 trade audit + so sánh 2022 breakdown structure
B. Cấu trúc giá 2026 theo tháng (BULL/BEAR/RANGE, breakdown events, WR/tháng)
C. Optimize SHORT param riêng cho 2026-style (giữ 7y stab)
D. LONG oversold 2026 audit — tại sao âm, thử relaxed confirm
"""
import json, datetime, math
from collections import defaultdict

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
INITIAL = 100_000; POS_PCT = 0.10; FEE = 0.05/100

print("Loading 5m data...")
raw = json.load(open(CACHE)); raw.sort(key=lambda x: x['time'])

def build_tf(ms):
    b = {}
    for c in raw:
        k = c["time"]//ms
        if k not in b:
            b[k] = {"time":k*ms,"open":c["open"],"high":c["high"],
                    "low":c["low"],"close":c["close"],"volume":c.get("volume",0)}
        else:
            b[k]["high"] = max(b[k]["high"],c["high"])
            b[k]["low"]  = min(b[k]["low"], c["low"])
            b[k]["close"] = c["close"]
            b[k]["volume"] += c.get("volume",0)
    return [b[k] for k in sorted(b)]

bars1h = build_tf(3_600_000)
bars4h = build_tf(14_400_000)
bars1d = build_tf(86_400_000)

def sma(src, p):
    out = [None]*len(src)
    for i in range(p-1, len(src)):
        w = [x for x in src[i-p+1:i+1] if x is not None]
        if len(w)==p: out[i] = sum(w)/p
    return out

def ema_ind(src, p):
    out=[None]*len(src); k=2/(p+1); e=None
    for i,x in enumerate(src):
        e = x if e is None else x*k+e*(1-k); out[i]=e
    return out

def rsi(src, p=14):
    out=[None]*len(src)
    if len(src)<=p: return out
    g=l=0.0
    for i in range(1,p+1):
        d=src[i]-src[i-1]
        if d>0: g+=d
        else: l-=d
    g/=p; l/=p; out[p]=100-100/(1+g/l) if l else 100.0
    for i in range(p+1,len(src)):
        d=src[i]-src[i-1]
        g=(g*(p-1)+max(d,0))/p; l=(l*(p-1)+max(-d,0))/p
        out[i]=100-100/(1+g/l) if l else 100.0
    return out

def stochrsi(src):
    r=rsi(src,14); n=len(r); rk=[None]*n
    for i in range(13,n):
        w=[x for x in r[i-13:i+1] if x is not None]
        if len(w)<14: continue
        lo,hi=min(w),max(w)
        rk[i]=50.0 if hi==lo else (r[i]-lo)/(hi-lo)*100
    K=[None]*n
    for i in range(2,n):
        w=[x for x in rk[i-2:i+1] if x is not None]
        if len(w)==3: K[i]=sum(w)/3
    D=[None]*n
    for i in range(2,n):
        w=[x for x in K[i-2:i+1] if x is not None]
        if len(w)==3: D[i]=sum(w)/3
    return K, D

print("Computing indicators...")
c1h  = [b['close'] for b in bars1h]
o1h  = [b['open']  for b in bars1h]
v1h  = [b['volume'] for b in bars1h]
c4h  = [b['close'] for b in bars4h]
c1d  = [b['close'] for b in bars1d]
vol_ma1h  = sma(v1h, 20)
ema200_1h = ema_ind(c1h, 200)
K1h, D1h  = stochrsi(c1h)
idx4h = {b['time']:i for i,b in enumerate(bars4h)}
idx1h = {b['time']:i for i,b in enumerate(bars1h)}

def yr(t): return datetime.datetime.utcfromtimestamp(t/1000).strftime('%Y')
def mo(t): return datetime.datetime.utcfromtimestamp(t/1000).strftime('%Y-%m')
def dt(t): return datetime.datetime.utcfromtimestamp(t/1000).strftime('%m-%d %H:%M')
def sep(c='─',w=110): print(c*w)

# ══════════════════════════════════════════════════════════════════════════════
# SHARED BACKTEST FUNCTIONS
# ══════════════════════════════════════════════════════════════════════════════

def get_c4h_idx(t_ms):
    bt=(t_ms//14_400_000)*14_400_000
    return idx4h.get(bt)

def backtest_short(lookback_h=6, vol_mult=0, require_bearish=True,
                   confirm_4h=True, hold_h=12, cooldown_h=12):
    """Champion SHORT params — multitf_mom regime"""
    equity=INITIAL; trades=[]; last_t=-999_999_999
    n=len(bars1h)
    for i in range(max(lookback_h+5,25), n-hold_h-2):
        t = bars1h[i]['time']
        if t-last_t < cooldown_h*3_600_000: continue
        price = c1h[i]
        recent_min = min(c1h[i-lookback_h:i])
        if price >= recent_min: continue
        if vol_mult>0:
            vm=vol_ma1h[i]
            if vm is None or v1h[i] < vol_mult*vm: continue
        if require_bearish and price >= o1h[i]: continue
        if confirm_4h:
            i4=get_c4h_idx(t)
            if i4 is None or i4<1: continue
            # 4h close cũng break
            lb4 = max(1, lookback_h//4)
            if i4<lb4: continue
            if c4h[i4] >= c4h[i4-lb4]: continue
        # multitf_mom bear gate
        i4=get_c4h_idx(t)
        if i4 is None or i4<5: continue
        if c4h[i4] >= c4h[i4-5]: continue
        entry = price
        exit_i = i+hold_h
        if exit_i>=n: continue
        exit_p = c1h[exit_i]
        pnl_pct = (entry-exit_p)/entry
        pnl = equity*POS_PCT*pnl_pct - equity*POS_PCT*FEE*2
        equity+=pnl
        trades.append({"t":t,"entry":entry,"exit":exit_p,
                        "pnl":pnl,"pnl_pct":pnl_pct,"win":pnl>0,
                        "yr":yr(t),"mo":mo(t)})
        last_t=t
    return trades

def backtest_long(thr=20, hold_h=72, cooldown_h=12):
    """Champion LONG params — multitf_mom regime"""
    equity=INITIAL; trades=[]; last_t=-999_999_999
    n=len(bars1h)
    for i in range(40, n-hold_h-2):
        k=K1h[i]
        if k is None: continue
        t=bars1h[i]['time']
        if t-last_t < cooldown_h*3_600_000: continue
        if k > thr: continue
        # multitf_mom bull gate
        i4=get_c4h_idx(t)
        if i4 is None or i4<5: continue
        if c4h[i4] <= c4h[i4-5]: continue
        entry=c1h[i]
        exit_i=i+hold_h
        if exit_i>=n: continue
        exit_p=c1h[exit_i]
        pnl_pct=(exit_p-entry)/entry
        pnl=equity*POS_PCT*pnl_pct - equity*POS_PCT*FEE*2
        equity+=pnl
        trades.append({"t":t,"entry":entry,"exit":exit_p,
                        "pnl":pnl,"pnl_pct":pnl_pct,"win":pnl>0,
                        "yr":yr(t),"mo":mo(t)})
        last_t=t
    return trades

print("Running backtests...")
short_trades = backtest_short()
long_trades  = backtest_long()

# ══════════════════════════════════════════════════════════════════════════════
# A. SHORT TRADE AUDIT — 2026 vs 2022
# ══════════════════════════════════════════════════════════════════════════════
sep('═')
print("A. SHORT TRADE AUDIT — 2022 vs 2026")
sep('═')

for focus in ["2022","2026"]:
    ft=[tr for tr in short_trades if tr['yr']==focus]
    if not ft: continue
    wr=sum(1 for tr in ft if tr['win'])/len(ft)
    pnl=sum(tr['pnl'] for tr in ft)
    avg_win  = sum(tr['pnl_pct'] for tr in ft if tr['win'])/(sum(1 for tr in ft if tr['win']) or 1)*100
    avg_loss = sum(tr['pnl_pct'] for tr in ft if not tr['win'])/(sum(1 for tr in ft if not tr['win']) or 1)*100
    big_win  = max((tr['pnl_pct'] for tr in ft), default=0)*100
    big_loss = min((tr['pnl_pct'] for tr in ft), default=0)*100
    sep('─')
    print(f"[{focus}]  n={len(ft)}  WR={wr:.1%}  PnL=${pnl:,.0f}")
    print(f"  avg_win={avg_win:+.2f}%  avg_loss={avg_loss:+.2f}%  "
          f"best={big_win:+.2f}%  worst={big_loss:+.2f}%")
    print(f"\n  {'Date':<14} {'Entry':>9} {'Exit':>9} {'PnL%':>7} {'Pnl$':>8} {'R'}")
    for tr in ft:
        res="✓" if tr['win'] else "✗"
        bar="+"*min(20,int(abs(tr['pnl_pct'])*200)) if tr['win'] else "-"*min(20,int(abs(tr['pnl_pct'])*200))
        print(f"  {dt(tr['t']):<14} {tr['entry']:>9,.0f} {tr['exit']:>9,.0f} "
              f"{tr['pnl_pct']*100:>+7.2f}% {tr['pnl']:>8,.0f}  {res} {bar}")

# Hold analysis: phân phối % change sau 1h/3h/6h/12h/24h từ entry SHORT
sep('─')
print("\nA2. HOLD DURATION ANALYSIS — 2026 SHORT (entry sau breakdown)")
print("    Nếu exit sớm hơn 12h có tốt hơn không?")

def analyze_hold_durations(focus_yr, trades_all):
    ft=[tr for tr in trades_all if tr['yr']==focus_yr]
    # Rebuild với nhiều hold
    for hold in [3,6,9,12,18,24]:
        wins=0; pnl_sum=0; cnt=0
        for tr in ft:
            i=idx1h.get(tr['t'])
            if i is None: continue
            ei=i+hold
            if ei>=len(c1h): continue
            pct=(tr['entry']-c1h[ei])/tr['entry']
            wins+=1 if pct>0 else 0
            pnl_sum+=pct; cnt+=1
        if cnt:
            print(f"  hold={hold:>2}h  WR={wins/cnt:.1%}  avg_pnl={pnl_sum/cnt*100:+.3f}%  n={cnt}")

analyze_hold_durations("2026", short_trades)
print()
analyze_hold_durations("2022", short_trades)

# ══════════════════════════════════════════════════════════════════════════════
# B. CẤU TRÚC 2026 THEO THÁNG
# ══════════════════════════════════════════════════════════════════════════════
sep('═')
print("B. CẤU TRÚC GIÁ 2026 — THÁNG × REGIME × SHORT/LONG PERFORMANCE")
sep('═')

# Phân loại mỗi ngày 2026: BULL/BEAR/RANGE theo multitf_mom 4h
def day_regime(t_close_ms):
    """4h bar tại close ngày"""
    i4=get_c4h_idx(t_close_ms)
    if i4 is None or i4<5: return "?"
    if c4h[i4] > c4h[i4-5]: return "BULL"
    if c4h[i4] < c4h[i4-5]: return "BEAR"
    return "FLAT"

months_2026 = defaultdict(lambda: {"n":0,"bull":0,"bear":0,"flat":0,
    "range_pct_sum":0,"short_n":0,"short_win":0,"short_pnl":0,
    "long_n":0,"long_win":0,"long_pnl":0,"breakdown_n":0})

for bar in bars1d:
    if yr(bar['time']) != "2026": continue
    m = mo(bar['time'])
    months_2026[m]["n"] += 1
    rng = (bar['high']-bar['low'])/bar['low']*100
    months_2026[m]["range_pct_sum"] += rng
    reg = day_regime(bar['time']+86_400_000-1)
    if reg=="BULL": months_2026[m]["bull"]+=1
    elif reg=="BEAR": months_2026[m]["bear"]+=1
    else: months_2026[m]["flat"]+=1

for tr in short_trades:
    if tr['yr']!="2026": continue
    m=tr['mo']
    months_2026[m]["short_n"]+=1
    months_2026[m]["short_win"]+=(1 if tr['win'] else 0)
    months_2026[m]["short_pnl"]+=tr['pnl']

for tr in long_trades:
    if tr['yr']!="2026": continue
    m=tr['mo']
    months_2026[m]["long_n"]+=1
    months_2026[m]["long_win"]+=(1 if tr['win'] else 0)
    months_2026[m]["long_pnl"]+=tr['pnl']

# breakdown events per month (no regime gate)
last_bd=-999999999
for i in range(25, len(bars1h)-2):
    t=bars1h[i]['time']
    if yr(t)!="2026": continue
    if t-last_bd < 12*3_600_000: continue
    price=c1h[i]
    recent_min=min(c1h[i-6:i])
    if price >= recent_min: continue
    if price >= o1h[i]: continue
    months_2026[mo(t)]["breakdown_n"]+=1
    last_bd=t

sep('─')
print(f"{'Month':<9} {'Days':>4} {'BULL':>5} {'BEAR':>5} {'FLAT':>5} {'Rng%':>5} | "
      f"{'BDs':>4} {'SHORT_n':>7} {'WR':>5} {'PnL':>8} | "
      f"{'LONG_n':>6} {'WR':>5} {'PnL':>8}")
sep('─')
for m in sorted(months_2026):
    d=months_2026[m]; n=d['n'] or 1
    sw=f"{d['short_win']/d['short_n']:.0%}" if d['short_n'] else "  —"
    lw=f"{d['long_win']/d['long_n']:.0%}" if d['long_n'] else "  —"
    print(f"{m:<9} {d['n']:>4} {d['bull']:>5} {d['bear']:>5} {d['flat']:>5} "
          f"{d['range_pct_sum']/n:>5.1f}% | "
          f"{d['breakdown_n']:>4} {d['short_n']:>7} {sw:>5} {d['short_pnl']:>8,.0f} | "
          f"{d['long_n']:>6} {lw:>5} {d['long_pnl']:>8,.0f}")

# ── So sánh phase 2022 Jan-Jun vs 2026 Jan-Jun
sep('─')
print("\nB2. SO SÁNH PHASE 2022 Jan-Jun vs 2026 Jan-Jun")
print(f"  {'Month':<7} | {'2022 SHORT WR':>13} {'PnL':>8} | {'2026 SHORT WR':>13} {'PnL':>8}")
sep('─')
months_2022 = defaultdict(lambda:{"short_n":0,"short_win":0,"short_pnl":0})
for tr in short_trades:
    if tr['yr']!="2022": continue
    m=tr['mo']
    months_2022[m]["short_n"]+=1
    months_2022[m]["short_win"]+=(1 if tr['win'] else 0)
    months_2022[m]["short_pnl"]+=tr['pnl']

for mm in ["01","02","03","04","05","06"]:
    m22=f"2022-{mm}"; m26=f"2026-{mm}"
    d22=months_2022[m22]; d26=months_2026[m26]
    sw22=f"{d22['short_win']/d22['short_n']:.0%}" if d22['short_n'] else "  —"
    sw26=f"{d26['short_win']/d26['short_n']:.0%}" if d26['short_n'] else "  —"
    print(f"  {mm:<7} | {sw22:>13} {d22['short_pnl']:>8,.0f} | {sw26:>13} {d26['short_pnl']:>8,.0f}")

# ══════════════════════════════════════════════════════════════════════════════
# C. OPTIMIZE SHORT — 2026-STYLE PARAMS (CHECK 7Y STAB)
# ══════════════════════════════════════════════════════════════════════════════
sep('═')
print("C. OPTIMIZE SHORT — 2026-STYLE (hold ngắn hơn, lookback nhỏ hơn)")
print("   Tìm param tốt cho 2026 mà vẫn giữ ≥5/8 năm dương")
sep('═')

import itertools

def backtest_short_full(lookback_h, hold_h, cooldown_h, confirm_4h=True):
    equity=INITIAL; trades=[]; last_t=-999_999_999
    n=len(bars1h)
    for i in range(max(lookback_h+5,25), n-hold_h-2):
        t=bars1h[i]['time']
        if t-last_t < cooldown_h*3_600_000: continue
        price=c1h[i]
        recent_min=min(c1h[i-lookback_h:i])
        if price >= recent_min: continue
        if price >= o1h[i]: continue
        if confirm_4h:
            i4=get_c4h_idx(t)
            if i4 is None or i4<1: continue
            lb4=max(1,lookback_h//4)
            if i4<lb4: continue
            if c4h[i4]>=c4h[i4-lb4]: continue
        i4=get_c4h_idx(t)
        if i4 is None or i4<5: continue
        if c4h[i4]>=c4h[i4-5]: continue
        entry=price; exit_i=i+hold_h
        if exit_i>=n: continue
        exit_p=c1h[exit_i]
        pnl_pct=(entry-exit_p)/entry
        pnl=equity*POS_PCT*pnl_pct-equity*POS_PCT*FEE*2
        equity+=pnl
        trades.append({"t":t,"pnl":pnl,"win":pnl>0,"yr":yr(t),"mo":mo(t),
                        "entry":entry,"exit":exit_p,"pnl_pct":pnl_pct})
        last_t=t
    return trades

LOOKBACK=[3,4,6,8,12]
HOLD=[6,9,12,18,24]
COOL=[6,9,12]
results_c=[]
for lb,hd,cl in itertools.product(LOOKBACK,HOLD,COOL):
    trs=backtest_short_full(lb,hd,cl)
    if len(trs)<50: continue
    by_yr=defaultdict(float)
    for tr in trs: by_yr[tr['yr']]+=tr['pnl']
    pos_yrs=sum(1 for v in by_yr.values() if v>0)
    stab=pos_yrs/len(by_yr) if by_yr else 0
    pnl_2026=by_yr.get("2026",0)
    pnl_tot=sum(by_yr.values())
    wr=sum(1 for tr in trs if tr['win'])/len(trs)
    peak=eq=INITIAL; mdd=0
    for tr in trs:
        eq+=tr['pnl']; peak=max(peak,eq); mdd=max(mdd,peak-eq)
    ra=pnl_tot/mdd if mdd>0 else 0
    score=pnl_2026*stab*math.sqrt(len(trs)/100)
    results_c.append({"lb":lb,"hd":hd,"cl":cl,"pnl":pnl_tot,"pnl_2026":pnl_2026,
                       "wr":wr,"n":len(trs),"ra":ra,"stab":stab,"pos_yrs":pos_yrs,
                       "by_yr":dict(by_yr),"score":score})

# Sort by 2026 PnL (primary) × stab ≥5/8
results_c.sort(key=lambda x: x['pnl_2026'] if x['pos_yrs']>=5 else -999999, reverse=True)

print(f"{'lb':>4} {'hd':>4} {'cl':>4} | {'PnL_tot':>9} {'PnL_2026':>9} {'WR':>5} {'n':>5} {'RA':>6} {'stab':>5} | Per-year 2026+")
sep('─')
for r in results_c[:20]:
    yr_tag=" | ".join(f"{y}:{'✓' if v>0 else '✗'}${abs(v/1000):.0f}k"
                      for y,v in sorted(r['by_yr'].items()))
    print(f"{r['lb']:>4} {r['hd']:>4} {r['cl']:>4} | "
          f"{r['pnl']:>9,.0f} {r['pnl_2026']:>9,.0f} {r['wr']:>5.1%} "
          f"{r['n']:>5} {r['ra']:>6.2f} {r['stab']:>5.0%} | {yr_tag}")

if results_c:
    best=results_c[0]
    sep('─')
    print(f"\n★ BEST 2026-optimized: lb={best['lb']}h hold={best['hd']}h cool={best['cl']}h")
    print(f"  7y total=${best['pnl']:,.0f}  2026=${best['pnl_2026']:,.0f}  "
          f"WR={best['wr']:.1%}  RA={best['ra']:.2f}  stab={best['stab']:.0%} ({best['pos_yrs']}/8)")

# ══════════════════════════════════════════════════════════════════════════════
# D. LONG OVERSOLD 2026 — AUDIT + RELAXED CONFIRM
# ══════════════════════════════════════════════════════════════════════════════
sep('═')
print("D. LONG OVERSOLD 2026 — AUDIT TẠI SAO ÂM + THỬ RELAXED")
sep('═')

# Champion long 2026 trades
lt26=[tr for tr in long_trades if tr['yr']=="2026"]
pnl26=sum(tr['pnl'] for tr in lt26)
wr26=sum(1 for tr in lt26 if tr['win'])/(len(lt26) or 1)
print(f"Champion LONG 2026: n={len(lt26)}  WR={wr26:.1%}  PnL=${pnl26:,.0f}")
print(f"\n  {'Date':<14} {'Entry':>9} {'Exit':>9} {'PnL%':>7} {'Pnl$':>8} {'K1h':>5} {'R'}")
sep('─')
for tr in lt26:
    i=idx1h.get(tr['t'])
    k=f"{K1h[i]:.1f}" if i and K1h[i] else "?"
    res="✓" if tr['win'] else "✗"
    print(f"  {dt(tr['t']):<14} {tr['entry']:>9,.0f} {tr['exit']:>9,.0f} "
          f"{tr['pnl_pct']*100:>+7.2f}% {tr['pnl']:>8,.0f}  {k:>5}  {res}")

# Hold duration analysis for LONG 2026
sep('─')
print("\nD1. HOLD DURATION ANALYSIS — LONG 2026 (exit tại giờ nào tốt nhất?)")
for hold in [12,24,36,48,72,96,120]:
    wins=0; pnl_sum=0; cnt=0
    for tr in lt26:
        i=idx1h.get(tr['t'])
        if i is None: continue
        ei=i+hold
        if ei>=len(c1h): continue
        pct=(c1h[ei]-tr['entry'])/tr['entry']
        wins+=1 if pct>FEE*2 else 0
        pnl_sum+=pct; cnt+=1
    if cnt:
        print(f"  hold={hold:>3}h  WR={wins/cnt:.1%}  avg_pnl={pnl_sum/cnt*100:+.3f}%  n={cnt}")

# Relaxed confirm: bỏ multitf_mom gate, thử ema200 thay thế
sep('─')
print("\nD2. LONG 2026 — THAY REGIME GATE: 'price > EMA200_1h' (không cần 4h up)")
def backtest_long_ema200(thr=20, hold_h=72, cooldown_h=12):
    equity=INITIAL; trades=[]; last_t=-999_999_999
    n=len(bars1h)
    for i in range(220, n-hold_h-2):
        k=K1h[i]
        if k is None: continue
        t=bars1h[i]['time']
        if t-last_t < cooldown_h*3_600_000: continue
        if k > thr: continue
        e200=ema200_1h[i]
        if e200 is None or c1h[i] < e200: continue
        entry=c1h[i]; exit_i=i+hold_h
        if exit_i>=n: continue
        exit_p=c1h[exit_i]
        pnl_pct=(exit_p-entry)/entry
        pnl=equity*POS_PCT*pnl_pct-equity*POS_PCT*FEE*2
        equity+=pnl
        trades.append({"t":t,"pnl":pnl,"win":pnl>0,"yr":yr(t),"mo":mo(t)})
        last_t=t
    return trades

def backtest_long_no_gate(thr=20, hold_h=72, cooldown_h=12):
    equity=INITIAL; trades=[]; last_t=-999_999_999
    n=len(bars1h)
    for i in range(40, n-hold_h-2):
        k=K1h[i]
        if k is None: continue
        t=bars1h[i]['time']
        if t-last_t < cooldown_h*3_600_000: continue
        if k > thr: continue
        entry=c1h[i]; exit_i=i+hold_h
        if exit_i>=n: continue
        exit_p=c1h[exit_i]
        pnl_pct=(exit_p-entry)/entry
        pnl=equity*POS_PCT*pnl_pct-equity*POS_PCT*FEE*2
        equity+=pnl
        trades.append({"t":t,"pnl":pnl,"win":pnl>0,"yr":yr(t),"mo":mo(t)})
        last_t=t
    return trades

def backtest_long_bear_ok(thr=20, hold_h=72, cooldown_h=12):
    """Cho phép vào ngay cả khi 4h xuống (oversold trong bear = contrarian)"""
    equity=INITIAL; trades=[]; last_t=-999_999_999
    n=len(bars1h)
    for i in range(40, n-hold_h-2):
        k=K1h[i]
        if k is None: continue
        t=bars1h[i]['time']
        if t-last_t < cooldown_h*3_600_000: continue
        if k > 10: continue  # strict: K<10 only
        entry=c1h[i]; exit_i=i+hold_h
        if exit_i>=n: continue
        exit_p=c1h[exit_i]
        pnl_pct=(exit_p-entry)/entry
        pnl=equity*POS_PCT*pnl_pct-equity*POS_PCT*FEE*2
        equity+=pnl
        trades.append({"t":t,"pnl":pnl,"win":pnl>0,"yr":yr(t),"mo":mo(t)})
        last_t=t
    return trades

variants = [
    ("champion (K<20+multitf_mom)", long_trades),
    ("ema200 gate (K<20+above_ema200)", backtest_long_ema200(20)),
    ("no gate (K<20 only)", backtest_long_no_gate(20)),
    ("K<10 no gate (strict threshold)", backtest_long_bear_ok(10)),
]

print(f"\n  {'Variant':<38} {'2026$':>8} {'7y$':>8} {'WR':>5} {'n':>5} {'stab':>5}")
sep('─')
for name, trs in variants:
    by_yr=defaultdict(float)
    for tr in trs: by_yr[tr['yr']]+=tr['pnl']
    pos_yrs=sum(1 for v in by_yr.values() if v>0)
    pnl_2026=by_yr.get("2026",0)
    pnl_tot=sum(by_yr.values())
    wr=sum(1 for tr in trs if tr['win'])/(len(trs) or 1)
    stab=pos_yrs/len(by_yr) if by_yr else 0
    print(f"  {name:<38} {pnl_2026:>8,.0f} {pnl_tot:>8,.0f} {wr:>5.1%} {len(trs):>5} {stab:>5.0%}")

# D3. Thử K<10 + multitf_mom + hold 48h cho 2026 (give more room)
sep('─')
print("\nD3. LONG — vary hold/thr/cooldown cho 2026 (vẫn multitf_mom gate)")
results_d=[]
for thr,hd,cl in itertools.product([8,10,12,15,20],[24,36,48,72,96],[12,24]):
    equity=INITIAL; trs=[]; last_t=-999_999_999
    n=len(bars1h)
    for i in range(40,n-hd-2):
        k=K1h[i]
        if k is None: continue
        t=bars1h[i]['time']
        if t-last_t < cl*3_600_000: continue
        if k > thr: continue
        i4=get_c4h_idx(t)
        if i4 is None or i4<5: continue
        if c4h[i4]<=c4h[i4-5]: continue
        entry=c1h[i]; ei=i+hd
        if ei>=n: continue
        exit_p=c1h[ei]
        pnl_pct=(exit_p-entry)/entry
        pnl=equity*POS_PCT*pnl_pct-equity*POS_PCT*FEE*2
        equity+=pnl
        trs.append({"t":t,"pnl":pnl,"win":pnl>0,"yr":yr(t)})
        last_t=t
    if len(trs)<30: continue
    by_yr=defaultdict(float)
    for tr in trs: by_yr[tr['yr']]+=tr['pnl']
    pos_yrs=sum(1 for v in by_yr.values() if v>0)
    pnl_2026=by_yr.get("2026",0)
    pnl_tot=sum(by_yr.values())
    wr=sum(1 for tr in trs if tr['win'])/len(trs)
    stab=pos_yrs/len(by_yr) if by_yr else 0
    peak=eq=INITIAL; mdd=0
    for tr in trs:
        eq+=tr['pnl']; peak=max(peak,eq); mdd=max(mdd,peak-eq)
    ra=pnl_tot/mdd if mdd>0 else 0
    results_d.append({"thr":thr,"hd":hd,"cl":cl,"pnl":pnl_tot,"pnl_2026":pnl_2026,
                       "wr":wr,"n":len(trs),"ra":ra,"stab":stab,"pos_yrs":pos_yrs,
                       "by_yr":dict(by_yr)})

results_d.sort(key=lambda x: (x['pos_yrs']>=5)*x['pnl_2026'], reverse=True)
print(f"  {'thr':>4} {'hd':>4} {'cl':>4} | {'2026$':>8} {'7y$':>9} {'WR':>5} {'n':>5} {'RA':>6} {'stab':>5}")
sep('─')
for r in results_d[:15]:
    print(f"  {r['thr']:>4} {r['hd']:>4} {r['cl']:>4} | "
          f"{r['pnl_2026']:>8,.0f} {r['pnl']:>9,.0f} {r['wr']:>5.1%} "
          f"{r['n']:>5} {r['ra']:>6.2f} {r['stab']:>5.0%} ({r['pos_yrs']}/8)")

sep('═')
print("DONE — deep-2026.py")
