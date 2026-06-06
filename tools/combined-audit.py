#!/usr/bin/env python3
"""
combined-audit.py — Audit kĩ champion combined LONG+SHORT
Champion: LONG K<20 hold72 cool12 | SHORT lb2 hold6 cool6

3 cổng audit:
A. Robustness — param ±1 bước xung quanh champion
B. OOS Walk-forward — train 2019-2022, test 2023-2026
C. Stability — per-year distribution, không có năm nào quá dominant
"""
import json, datetime, math, itertools
from collections import defaultdict

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
INITIAL = 100_000; POS_PCT = 0.10; FEE = 0.05/100

print("Loading...")
raw = json.load(open(CACHE)); raw.sort(key=lambda x: x['time'])

def build_tf(ms):
    b={}
    for c in raw:
        k=c["time"]//ms
        if k not in b:
            b[k]={"time":k*ms,"open":c["open"],"high":c["high"],
                  "low":c["low"],"close":c["close"],"volume":c.get("volume",0)}
        else:
            b[k]["high"]=max(b[k]["high"],c["high"]); b[k]["low"]=min(b[k]["low"],c["low"])
            b[k]["close"]=c["close"]; b[k]["volume"]+=c.get("volume",0)
    return [b[k] for k in sorted(b)]

bars1h = build_tf(3_600_000)
bars4h = build_tf(14_400_000)

def rsi(src,p=14):
    out=[None]*len(src)
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
    return K

print("Computing indicators...")
c1h=[b['close'] for b in bars1h]
o1h=[b['open']  for b in bars1h]
c4h=[b['close'] for b in bars4h]
K1h=stochrsi(c1h)
idx4h={b['time']:i for i,b in enumerate(bars4h)}

def yr(t): return datetime.datetime.utcfromtimestamp(t/1000).strftime('%Y')
def sep(c='─',w=125): print(c*w)

def get_i4(t):
    return idx4h.get((t//14_400_000)*14_400_000)

# ── Core backtest (combined hedge) ─────────────────────────────────────────
def run(lt, lh, lc, sl, sh, sc, year_filter=None):
    n=len(bars1h)
    long_sigs=[]; last_lt=-999999999
    for i in range(40,n-lh-2):
        k=K1h[i]
        if k is None: continue
        t=bars1h[i]['time']
        if year_filter and yr(t) not in year_filter: continue
        if t-last_lt < lc*3_600_000: continue
        if k > lt: continue
        i4=get_i4(t)
        if i4 is None or i4<5: continue
        if c4h[i4]<=c4h[i4-5]: continue
        long_sigs.append((t,i,"LONG",lh)); last_lt=t

    short_sigs=[]; last_st=-999999999
    for i in range(max(sl+3,10),n-sh-2):
        t=bars1h[i]['time']
        if year_filter and yr(t) not in year_filter: continue
        if t-last_st < sc*3_600_000: continue
        price=c1h[i]
        if price>=min(c1h[i-sl:i]): continue
        if price>=o1h[i]: continue
        i4=get_i4(t)
        if i4 is None or i4<5: continue
        if c4h[i4]>=c4h[i4-5]: continue
        lb4=max(1,sl//4)
        if i4<lb4: continue
        if c4h[i4]>=c4h[i4-lb4]: continue
        short_sigs.append((t,i,"SHORT",sh)); last_st=t

    all_sigs=sorted(long_sigs+short_sigs,key=lambda x:x[0])
    if len(all_sigs)<20: return None

    equity=INITIAL; trades=[]; open_trades=[]
    for t,i,side,hold in all_sigs:
        ei=i+hold
        if ei>=n: continue
        open_trades=[ot for ot in open_trades if t<ot[1]]
        entry=c1h[i]; exit_p=c1h[ei]
        pct=((exit_p-entry)/entry) if side=="LONG" else ((entry-exit_p)/entry)
        pnl=equity*POS_PCT*pct - equity*POS_PCT*FEE*2
        equity+=pnl
        open_trades.append((side,bars1h[ei]['time']))
        trades.append((t,pnl,side,yr(t)))

    if len(trades)<20: return None
    by_yr=defaultdict(float)
    for _,p,_,y in trades: by_yr[y]+=p
    pos=sum(1 for v in by_yr.values() if v>0)
    n_yr=len(by_yr); stab=pos/n_yr if n_yr else 0
    tot=sum(p for _,p,_,_ in trades)
    wr=sum(1 for _,p,_,_ in trades if p>0)/len(trades)
    peak=eq=INITIAL; mdd=0
    for _,p,_,_ in trades:
        eq+=p; peak=max(peak,eq); mdd=max(mdd,peak-eq)
    ra=tot/mdd if mdd>0 else 0
    sc2=tot*stab*math.sqrt(len(trades)/100)
    return {"pnl":tot,"wr":wr,"n":len(trades),"ra":ra,"stab":stab,
            "pos":pos,"n_yr":n_yr,"by_yr":dict(by_yr),"score":sc2,"mdd":mdd}

# Champion params
CL = (20, 72, 12)   # lt, lh, lc
CS = (2,  6,  6)    # sl, sh, sc

print("Running champion...")
champ = run(*CL, *CS)
print(f"  Champion: PnL=${champ['pnl']:,.0f}  RA={champ['ra']:.2f}  stab={champ['stab']:.0%}")

# ══════════════════════════════════════════════════════════════════════════════
# A. ROBUSTNESS — param ±1 xung quanh champion
# ══════════════════════════════════════════════════════════════════════════════
sep('═')
print("A. ROBUSTNESS TEST — param ±1 xung quanh champion")
print("   Champion: LONG(K<20, hold=72, cool=12) | SHORT(lb=2, hold=6, cool=6)")
sep('═')

# A1: SHORT lb vary (most sensitive)
print("\nA1. SHORT lb (lookback hours) — LONG fixed at champion")
print(f"  {'lb':>4} {'hold':>5} {'cool':>5} | {'PnL':>10} {'WR':>6} {'n':>5} {'RA':>7} {'stab':>6} | per-year")
sep('─')
for sl in [1,2,3,4,5,6]:
    r=run(*CL, sl, CS[1], CS[2])
    if r is None: print(f"  {sl:>4}  — no result"); continue
    yr_s=" ".join(f"{y}:{'✓' if v>0 else '✗'}" for y,v in sorted(r['by_yr'].items()))
    flag="★" if sl==CS[0] else ""
    print(f"  {sl:>4} {CS[1]:>5} {CS[2]:>5} | {r['pnl']:>10,.0f} {r['wr']:>6.1%} {r['n']:>5} "
          f"{r['ra']:>7.2f} {r['stab']:>6.0%} | {yr_s} {flag}")

# A2: SHORT hold vary
print("\nA2. SHORT hold — LONG fixed, lb=2")
print(f"  {'lb':>4} {'hold':>5} {'cool':>5} | {'PnL':>10} {'WR':>6} {'n':>5} {'RA':>7} {'stab':>6} | per-year")
sep('─')
for sh in [3,4,5,6,7,8,9,12]:
    r=run(*CL, CS[0], sh, CS[2])
    if r is None: continue
    yr_s=" ".join(f"{y}:{'✓' if v>0 else '✗'}" for y,v in sorted(r['by_yr'].items()))
    flag="★" if sh==CS[1] else ""
    print(f"  {CS[0]:>4} {sh:>5} {CS[2]:>5} | {r['pnl']:>10,.0f} {r['wr']:>6.1%} {r['n']:>5} "
          f"{r['ra']:>7.2f} {r['stab']:>6.0%} | {yr_s} {flag}")

# A3: SHORT cooldown vary
print("\nA3. SHORT cooldown — LONG fixed, lb=2 hold=6")
sep('─')
for sc in [3,4,5,6,7,8,9,12]:
    r=run(*CL, CS[0], CS[1], sc)
    if r is None: continue
    yr_s=" ".join(f"{y}:{'✓' if v>0 else '✗'}" for y,v in sorted(r['by_yr'].items()))
    flag="★" if sc==CS[2] else ""
    print(f"  {CS[0]:>4} {CS[1]:>5} {sc:>5} | {r['pnl']:>10,.0f} {r['wr']:>6.1%} {r['n']:>5} "
          f"{r['ra']:>7.2f} {r['stab']:>6.0%} | {yr_s} {flag}")

# A4: LONG thr vary
print("\nA4. LONG thr — SHORT fixed at champion")
sep('─')
for lt in [8,10,12,15,20,25,30]:
    r=run(lt, CL[1], CL[2], *CS)
    if r is None: continue
    yr_s=" ".join(f"{y}:{'✓' if v>0 else '✗'}" for y,v in sorted(r['by_yr'].items()))
    flag="★" if lt==CL[0] else ""
    print(f"  {lt:>4} {CL[1]:>5} {CL[2]:>5} | {r['pnl']:>10,.0f} {r['wr']:>6.1%} {r['n']:>5} "
          f"{r['ra']:>7.2f} {r['stab']:>6.0%} | {yr_s} {flag}")

# A5: LONG hold vary
print("\nA5. LONG hold — SHORT fixed at champion")
sep('─')
for lh in [24,36,48,60,72,84,96]:
    r=run(CL[0], lh, CL[2], *CS)
    if r is None: continue
    yr_s=" ".join(f"{y}:{'✓' if v>0 else '✗'}" for y,v in sorted(r['by_yr'].items()))
    flag="★" if lh==CL[1] else ""
    print(f"  {CL[0]:>4} {lh:>5} {CL[2]:>5} | {r['pnl']:>10,.0f} {r['wr']:>6.1%} {r['n']:>5} "
          f"{r['ra']:>7.2f} {r['stab']:>6.0%} | {yr_s} {flag}")

# A6: 2D grid lb × hold (quan trọng nhất)
print("\nA6. 2D GRID — SHORT lb × hold (LONG fixed champion, cool=6)")
print(f"  {'lb\\hold':>8} | ", end="")
HOLDS=[4,5,6,7,8,9,12]
for h in HOLDS: print(f"{'hd='+str(h):>10}", end="")
print()
sep('─')
for sl in [1,2,3,4,5,6]:
    print(f"  lb={sl:<5} | ", end="")
    for sh in HOLDS:
        r=run(*CL, sl, sh, CS[2])
        if r is None:
            print(f"{'—':>10}", end="")
        else:
            flag="★" if sl==CS[0] and sh==CS[1] else ""
            print(f"{r['pnl']/1000:>9.0f}k{flag}", end="")
    print()

# Robustness score: bao nhiêu % param ±1 vẫn stab≥87.5% (7/8)
print("\nA7. ROBUSTNESS SCORE — % combos xung quanh champion còn stab ≥7/8")
neighbors=[]
for sl in [1,2,3]:
    for sh in [5,6,7]:
        for sc in [5,6,7]:
            r=run(*CL, sl, sh, sc)
            if r: neighbors.append(r)
robust=sum(1 for r in neighbors if r['stab']>=0.875)/len(neighbors)*100 if neighbors else 0
pos_all=sum(1 for r in neighbors if r['pnl']>0)/len(neighbors)*100 if neighbors else 0
print(f"  Tested {len(neighbors)} neighbor combos (lb=[1-3] hold=[5-7] cool=[5-7])")
print(f"  stab≥87.5%: {robust:.0f}%  |  PnL>0: {pos_all:.0f}%")

# ══════════════════════════════════════════════════════════════════════════════
# B. WALK-FORWARD OOS
# ══════════════════════════════════════════════════════════════════════════════
sep('═')
print("B. OOS WALK-FORWARD TEST")
sep('═')

# B1: Train 2019-2022 (4y), Test 2023-2026 (4y)
TRAIN = {"2019","2020","2021","2022"}
TEST  = {"2023","2024","2025","2026"}

r_train = run(*CL, *CS, year_filter=TRAIN)
r_test  = run(*CL, *CS, year_filter=TEST)

def pct_equity(pnl): return pnl/INITIAL*100

print(f"\nChampion params: LONG(K<20,h72,c12) | SHORT(lb2,h6,c6)")
print(f"\n  TRAIN 2019-2022: PnL=${r_train['pnl']:,.0f} (+{pct_equity(r_train['pnl']):.0f}%)  "
      f"WR={r_train['wr']:.1%}  RA={r_train['ra']:.2f}  stab={r_train['stab']:.0%}")
print(f"  TEST  2023-2026: PnL=${r_test['pnl']:,.0f} (+{pct_equity(r_test['pnl']):.0f}%)  "
      f"WR={r_test['wr']:.1%}  RA={r_test['ra']:.2f}  stab={r_test['stab']:.0%}")

# B2: Rolling window walk-forward
print("\nB2. Rolling 3y train → 1y test:")
print(f"  {'Train':>14} → {'Test':>5} | {'Train PnL':>10} {'Test PnL':>10} {'Test RA':>8} {'stab':>5}")
sep('─')
ALL_YEARS=["2019","2020","2021","2022","2023","2024","2025","2026"]
for start_i in range(len(ALL_YEARS)-3):
    train_yrs=set(ALL_YEARS[start_i:start_i+3])
    test_yr=ALL_YEARS[start_i+3]
    rt=run(*CL,*CS,year_filter=train_yrs)
    rv=run(*CL,*CS,year_filter={test_yr})
    if rt and rv:
        ty="+".join(sorted(train_yrs))
        print(f"  {ty:>14} → {test_yr:>5} | {rt['pnl']:>10,.0f} {rv['pnl']:>10,.0f} "
              f"{rv['ra']:>8.2f} {'✓' if rv['pnl']>0 else '✗'}")

# B3: Compare với baseline (no gate, K<20 only LONG, no gate SHORT)
print("\nB3. BASELINE vs CHAMPION trên OOS 2023-2026:")
def run_no_gate(lt=20, lh=72, lc=12, sl=2, sh=6, sc=6, year_filter=None):
    """Không có multitf_mom gate"""
    n=len(bars1h)
    long_sigs=[]; last_lt=-999999999
    for i in range(40,n-lh-2):
        k=K1h[i]
        if k is None: continue
        t=bars1h[i]['time']
        if year_filter and yr(t) not in year_filter: continue
        if t-last_lt<lc*3_600_000: continue
        if k>lt: continue
        long_sigs.append((t,i,"LONG",lh)); last_lt=t
    short_sigs=[]; last_st=-999999999
    for i in range(max(sl+3,10),n-sh-2):
        t=bars1h[i]['time']
        if year_filter and yr(t) not in year_filter: continue
        if t-last_st<sc*3_600_000: continue
        price=c1h[i]
        if price>=min(c1h[i-sl:i]): continue
        if price>=o1h[i]: continue
        short_sigs.append((t,i,"SHORT",sh)); last_st=t
    all_sigs=sorted(long_sigs+short_sigs,key=lambda x:x[0])
    if len(all_sigs)<20: return None
    equity=INITIAL; trades=[]; open_trades=[]
    for t,i,side,hold in all_sigs:
        ei=i+hold
        if ei>=n: continue
        open_trades=[ot for ot in open_trades if t<ot[1]]
        entry=c1h[i]; exit_p=c1h[ei]
        pct=((exit_p-entry)/entry) if side=="LONG" else ((entry-exit_p)/entry)
        pnl=equity*POS_PCT*pct - equity*POS_PCT*FEE*2
        equity+=pnl
        open_trades.append((side,bars1h[ei]['time']))
        trades.append((t,pnl,side,yr(t)))
    if len(trades)<20: return None
    by_yr=defaultdict(float)
    for _,p,_,y in trades: by_yr[y]+=p
    pos=sum(1 for v in by_yr.values() if v>0)
    n_yr=len(by_yr); stab=pos/n_yr if n_yr else 0
    tot=sum(p for _,p,_,_ in trades); wr=sum(1 for _,p,_,_ in trades if p>0)/len(trades)
    peak=eq=INITIAL; mdd=0
    for _,p,_,_ in trades:
        eq+=p; peak=max(peak,eq); mdd=max(mdd,peak-eq)
    ra=tot/mdd if mdd>0 else 0
    return {"pnl":tot,"wr":wr,"n":len(trades),"ra":ra,"stab":stab,"by_yr":dict(by_yr),"mdd":mdd}

rb_train = run_no_gate(year_filter=TRAIN)
rb_test  = run_no_gate(year_filter=TEST)
print(f"  {'':25} {'TRAIN 2019-22':>14} {'TEST 2023-26':>14}")
sep('─')
print(f"  {'No-gate baseline':<25} {rb_train['pnl']:>14,.0f} {rb_test['pnl']:>14,.0f}")
print(f"  {'Champion (multitf_mom)':<25} {r_train['pnl']:>14,.0f} {r_test['pnl']:>14,.0f}")
if rb_train['pnl']>0 and rb_test['pnl']>0:
    lift_train=(r_train['pnl']-rb_train['pnl'])/rb_train['pnl']*100
    lift_test =(r_test['pnl'] -rb_test['pnl']) /rb_test['pnl'] *100
    print(f"  {'Gate lift':<25} {lift_train:>+13.0f}% {lift_test:>+13.0f}%")

# ══════════════════════════════════════════════════════════════════════════════
# C. STABILITY ANALYSIS
# ══════════════════════════════════════════════════════════════════════════════
sep('═')
print("C. STABILITY ANALYSIS — Không có năm nào dominant bất thường")
sep('═')

r_full=run(*CL,*CS)
tot=r_full['pnl']
by_yr=r_full['by_yr']

print(f"\n  Total 7y PnL = ${tot:,.0f}")
print(f"\n  {'Year':>6} {'PnL':>10} {'%total':>8} {'%equity':>9} {'flag':>6}")
sep('─')
for y in sorted(by_yr):
    v=by_yr[y]
    pct_tot=v/tot*100
    pct_eq =v/INITIAL*100
    flag=""
    if abs(pct_tot)>25: flag="⚠ DOMINANT"
    if v<0: flag="✗ LOSS"
    print(f"  {y:>6} {v:>10,.0f} {pct_tot:>8.1f}% {pct_eq:>9.1f}%  {flag}")

# Monthly distribution
print("\n  Per-month PnL (2019-2026 aggregate):")
by_mo=defaultdict(float)
# rebuild trades
n=len(bars1h)
long_sigs=[]; last_lt=-999999999
for i in range(40,n-CL[1]-2):
    k=K1h[i]
    if k is None: continue
    t=bars1h[i]['time']
    if t-last_lt<CL[2]*3_600_000: continue
    if k>CL[0]: continue
    i4=get_i4(t)
    if i4 is None or i4<5: continue
    if c4h[i4]<=c4h[i4-5]: continue
    long_sigs.append((t,i,"LONG",CL[1])); last_lt=t
short_sigs=[]; last_st=-999999999
for i in range(max(CS[0]+3,10),n-CS[1]-2):
    t=bars1h[i]['time']
    if t-last_st<CS[2]*3_600_000: continue
    price=c1h[i]
    if price>=min(c1h[i-CS[0]:i]): continue
    if price>=o1h[i]: continue
    i4=get_i4(t)
    if i4 is None or i4<5: continue
    if c4h[i4]>=c4h[i4-5]: continue
    lb4=max(1,CS[0]//4)
    if i4<lb4: continue
    if c4h[i4]>=c4h[i4-lb4]: continue
    short_sigs.append((t,i,"SHORT",CS[1])); last_st=t

all_sigs=sorted(long_sigs+short_sigs,key=lambda x:x[0])
equity=INITIAL; open_trades=[]
by_mo_detail=defaultdict(lambda:{"pnl":0,"n":0,"win":0,"long_pnl":0,"short_pnl":0})
for t,i,side,hold in all_sigs:
    ei=i+hold
    if ei>=n: continue
    open_trades=[ot for ot in open_trades if t<ot[1]]
    entry=c1h[i]; exit_p=c1h[ei]
    pct=((exit_p-entry)/entry) if side=="LONG" else ((entry-exit_p)/entry)
    pnl=equity*POS_PCT*pct-equity*POS_PCT*FEE*2
    equity+=pnl
    open_trades.append((side,bars1h[ei]['time']))
    m=datetime.datetime.utcfromtimestamp(t/1000).strftime('%m')
    by_mo_detail[m]["pnl"]+=pnl; by_mo_detail[m]["n"]+=1
    by_mo_detail[m]["win"]+=(1 if pnl>0 else 0)
    if side=="LONG": by_mo_detail[m]["long_pnl"]+=pnl
    else: by_mo_detail[m]["short_pnl"]+=pnl

MNAMES={"01":"Jan","02":"Feb","03":"Mar","04":"Apr","05":"May","06":"Jun",
         "07":"Jul","08":"Aug","09":"Sep","10":"Oct","11":"Nov","12":"Dec"}
print(f"  {'Mo':>5} {'Pnl$':>9} {'WR':>5} {'n':>5} {'LONG$':>9} {'SHORT$':>9}")
sep('─')
for m in sorted(by_mo_detail):
    d=by_mo_detail[m]
    wr=d['win']/d['n'] if d['n'] else 0
    print(f"  {MNAMES[m]:>5} {d['pnl']:>9,.0f} {wr:>5.1%} {d['n']:>5} "
          f"{d['long_pnl']:>9,.0f} {d['short_pnl']:>9,.0f}")

# C2. Drawdown analysis
print("\nC2. DRAWDOWN DEEP-DIVE:")
equity=INITIAL; peak=INITIAL; running=[]; drawdowns=[]
eq_curve=[]
dd_start=None; dd_peak_val=0
for t,i,side,hold in sorted(long_sigs+short_sigs,key=lambda x:x[0]):
    ei=i+hold
    if ei>=n: continue
    open_trades=[ot for ot in open_trades if t<ot[1]]
    entry=c1h[i]; exit_p=c1h[ei]
    pct=((exit_p-entry)/entry) if side=="LONG" else ((entry-exit_p)/entry)
    pnl=equity*POS_PCT*pct-equity*POS_PCT*FEE*2
    equity+=pnl
    eq_curve.append((t,equity,side))
    if equity>peak:
        if dd_start is not None:
            drawdowns.append({"start":dd_start,"end":t,"depth":dd_peak_val-equity,"pct":(dd_peak_val-equity)/dd_peak_val*100})
        peak=equity; dd_start=None
    else:
        if dd_start is None: dd_start=t; dd_peak_val=peak

print(f"  Max DD: ${r_full['mdd']:,.0f}  ({r_full['mdd']/INITIAL*100:.1f}% equity)")
# Longest consecutive loss streak
streak=0; max_streak=0; streak_pnl=0; max_streak_pnl=0
for t,i,side,hold in sorted(long_sigs+short_sigs,key=lambda x:x[0]):
    ei=i+hold
    if ei>=n: continue
    entry=c1h[i]; exit_p=c1h[ei]
    pct=((exit_p-entry)/entry) if side=="LONG" else ((entry-exit_p)/entry)
    pnl=INITIAL*POS_PCT*pct
    if pnl<0:
        streak+=1; streak_pnl+=pnl
        if streak>max_streak: max_streak=streak; max_streak_pnl=streak_pnl
    else:
        streak=0; streak_pnl=0
print(f"  Max consec loss streak: {max_streak} trades  (streak loss=${max_streak_pnl:,.0f})")

sep('═')
print("""
AUDIT VERDICT:
  PASS nếu:
    Robustness: lb±1, hold±1 đều stab≥87.5%
    OOS TEST 2023-2026: PnL > 0 và RA > 5
    Không có năm nào chiếm >25% tổng PnL
    Gate lift OOS: champion > no-gate trên OOS set
  FAIL nếu:
    lb=2 là điểm cô lập (lb=1 và lb=3 đều kém xa)
    OOS test tệ hơn train >50%
    1 năm chiếm >35% tổng PnL
""")
print("Done.")
