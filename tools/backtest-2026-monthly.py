#!/usr/bin/env python3
"""
backtest-2026-monthly.py — Tung từng tháng 2026
Champion: LONG K<20 hold72 cool12 | SHORT lb2 hold6 cool6 | gate=multitf_mom
Per-tháng: từng lệnh + stats + equity curve ASCII
"""
import json, datetime, math
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
    out=[None]*len(src); g=l=0.0
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
idx1h={b['time']:i for i,b in enumerate(bars1h)}

def ts(t): return datetime.datetime.utcfromtimestamp(t/1000)
def dts(t): return ts(t).strftime('%m-%d %H:%M')
def get_i4(t): return idx4h.get((t//14_400_000)*14_400_000)

# Champion params
LT,LH,LC = 20,72,12
SL,SH,SC  = 2,6,6

# Build ALL signals 2026 (entry trong 2026, exit có thể tràn sang 2027)
n=len(bars1h)
long_sigs=[]; last_lt=-999999999
for i in range(40,n-LH-2):
    t=bars1h[i]['time']
    if ts(t).year<2026: continue
    if ts(t).year>2026: break
    if t-last_lt < LC*3_600_000: continue
    k=K1h[i]
    if k is None or k>LT: continue
    i4=get_i4(t)
    if i4 is None or i4<5: continue
    if c4h[i4]<=c4h[i4-5]: continue
    long_sigs.append((t,i,"LONG",LH)); last_lt=t

short_sigs=[]; last_st=-999999999
for i in range(max(SL+3,10),n-SH-2):
    t=bars1h[i]['time']
    if ts(t).year<2026: continue
    if ts(t).year>2026: break
    if t-last_st < SC*3_600_000: continue
    price=c1h[i]
    if price>=min(c1h[i-SL:i]): continue
    if price>=o1h[i]: continue
    i4=get_i4(t)
    if i4 is None or i4<5: continue
    if c4h[i4]>=c4h[i4-5]: continue
    if i4<1: continue
    if c4h[i4]>=c4h[i4-1]: continue
    short_sigs.append((t,i,"SHORT",SH)); last_st=t

all_sigs=sorted(long_sigs+short_sigs,key=lambda x:x[0])

# Replay trên equity chung
equity=INITIAL; open_trades=[]
trades_all=[]
for t,i,side,hold in all_sigs:
    ei=i+hold
    if ei>=n: continue
    open_trades=[ot for ot in open_trades if t<ot]
    entry=c1h[i]; exit_p=c1h[ei]
    exit_t=bars1h[ei]['time']
    pct=((exit_p-entry)/entry) if side=="LONG" else ((entry-exit_p)/entry)
    pnl=equity*POS_PCT*pct - equity*POS_PCT*FEE*2
    equity+=pnl
    open_trades.append(exit_t)
    mo=ts(t).strftime('%Y-%m')
    trades_all.append({
        "t":t,"side":side,"entry":entry,"exit":exit_p,"exit_t":exit_t,
        "pct":pct,"pnl":pnl,"win":pnl>0,"mo":mo,
        "k1h": K1h[i]
    })

# Group by month
by_mo=defaultdict(list)
for tr in trades_all: by_mo[tr['mo']].append(tr)

MNAMES={"01":"January","02":"February","03":"March","04":"April","05":"May",
        "06":"June","07":"July","08":"August","09":"September",
        "10":"October","11":"November","12":"December"}

def mini_equity_curve(trades,width=60):
    """ASCII equity curve"""
    if not trades: return ""
    cum=[0]
    for tr in trades: cum.append(cum[-1]+tr['pnl'])
    hi=max(cum); lo=min(cum); rng=hi-lo if hi!=lo else 1
    h=6; rows=[]
    for row in range(h,0,-1):
        thresh=lo+(rng*(row/h))
        line="  "
        for v in cum[1:]:
            if v>=thresh: line+="█"
            else: line+=" "
        rows.append(line)
    rows.append("  "+"─"*len(cum[1:]))
    return "\n".join(rows)

def sep(c='─',w=115): print(c*w)

cum_2026=0
sep('═')
print("BACKTEST 2026 — TỪNG THÁNG CHI TIẾT")
print(f"Champion: LONG K<20 hold={LH}h cool={LC}h  |  SHORT lb={SL}h hold={SH}h cool={SC}h  |  gate=multitf_mom")
sep('═')

for mo in sorted(by_mo.keys()):
    mm=mo[5:]; mn=MNAMES.get(mm,mm)
    trs=by_mo[mo]
    if not trs: continue

    long_trs =[tr for tr in trs if tr['side']=="LONG"]
    short_trs=[tr for tr in trs if tr['side']=="SHORT"]
    mo_pnl=sum(tr['pnl'] for tr in trs)
    cum_2026+=mo_pnl
    wr=sum(1 for tr in trs if tr['win'])/len(trs)
    l_pnl=sum(tr['pnl'] for tr in long_trs)
    s_pnl=sum(tr['pnl'] for tr in short_trs)
    l_wr=sum(1 for tr in long_trs if tr['win'])/(len(long_trs) or 1)
    s_wr=sum(1 for tr in short_trs if tr['win'])/(len(short_trs) or 1)

    sign="✓" if mo_pnl>=0 else "✗"
    sep('═')
    print(f"{sign} {mn} 2026  |  PnL=${mo_pnl:>+9,.0f}  (cum=${cum_2026:>+9,.0f})  "
          f"WR={wr:.0%}  n={len(trs)}  [LONG n={len(long_trs)} ${l_pnl:+,.0f} WR={l_wr:.0%} | "
          f"SHORT n={len(short_trs)} ${s_pnl:+,.0f} WR={s_wr:.0%}]")
    sep('─')
    print(f"  {'#':>3} {'Date':<14} {'Side':<6} {'Entry':>9} {'Exit':>9} "
          f"{'Hold':>5} {'PnL%':>7} {'PnL$':>8} {'CumMo$':>9}  K1h")
    sep('─')
    cum_mo=0
    for idx_t,tr in enumerate(sorted(trs,key=lambda x:x['t'])):
        cum_mo+=tr['pnl']
        res="✓" if tr['win'] else "✗"
        hold_h=round((tr['exit_t']-tr['t'])/3_600_000)
        k=f"{tr['k1h']:.1f}" if tr['k1h'] is not None else "?"
        # bar
        if tr['win']:
            bar="▲"*min(12,max(1,int(abs(tr['pct'])*100))) if tr['side']=="LONG" else "▼"*min(12,max(1,int(abs(tr['pct'])*100)))
        else:
            bar="▽"*min(12,max(1,int(abs(tr['pct'])*100))) if tr['side']=="LONG" else "△"*min(12,max(1,int(abs(tr['pct'])*100)))
        print(f"  {idx_t+1:>3} {dts(tr['t']):<14} {tr['side']:<6} {tr['entry']:>9,.0f} "
              f"{tr['exit']:>9,.0f} {hold_h:>5}h {tr['pct']*100:>+7.2f}% "
              f"{tr['pnl']:>8,.0f} {cum_mo:>9,.0f}  {k:>5} {res}{bar}")

    # ASCII equity curve tháng này
    print()
    print(mini_equity_curve(sorted(trs,key=lambda x:x['t'])))
    print()

sep('═')
print(f"2026 YTD TOTAL: ${cum_2026:>+,.0f}")
sep('═')

# Summary table
print()
sep('─')
print(f"  {'Month':<11} {'n':>4} {'L_n':>4} {'S_n':>4} {'PnL$':>10} {'LONG$':>9} {'SHORT$':>9} {'WR':>5} {'Cum$':>10}")
sep('─')
cum=0
for mo in sorted(by_mo.keys()):
    mm=mo[5:]; mn=MNAMES.get(mm,mo)[:3]
    trs=by_mo[mo]
    if not trs: continue
    ltrs=[t for t in trs if t['side']=="LONG"]
    strs=[t for t in trs if t['side']=="SHORT"]
    p=sum(t['pnl'] for t in trs)
    lp=sum(t['pnl'] for t in ltrs); sp=sum(t['pnl'] for t in strs)
    wr=sum(1 for t in trs if t['win'])/len(trs)
    cum+=p
    sign="✓" if p>=0 else "✗"
    print(f"  {sign} {mn:<9} {len(trs):>4} {len(ltrs):>4} {len(strs):>4} "
          f"{p:>10,.0f} {lp:>9,.0f} {sp:>9,.0f} {wr:>5.0%} {cum:>10,.0f}")
sep('─')
print(f"  {'TOTAL':<11} {len(trades_all):>4} "
      f"{sum(1 for t in trades_all if t['side']=='LONG'):>4} "
      f"{sum(1 for t in trades_all if t['side']=='SHORT'):>4} "
      f"{cum_2026:>10,.0f}")

print("\nDone.")
