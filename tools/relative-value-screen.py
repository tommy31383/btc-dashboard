#!/usr/bin/env python3
"""
Relative-value / market-neutral edge screen: BTC / ETH / SOL.
Long one coin, short another (dollar-neutral) -> kills market beta.
HONEST gates: fee+funding net, drop-top-20%, walk-forward, per-year, beta~0, random-null.

Families:
 1. Ratio mean-reversion (z-score on A/B ratio)
 2. Spread/cointegration mean-reversion (rolling OLS residual)
 3. Cross-sectional momentum/reversal (rank N-day return, L/S top-bottom)
"""
import json, math, statistics
from collections import defaultdict

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/"
FEE_RT = 0.0016   # round-trip both legs ~0.16% (taker 0.04%/side * 4 fills)

def load(f):
    return json.load(open(CACHE+f))

def to_daily(rows):
    """5m -> daily close keyed by day-start ms (UTC)."""
    DAY = 86400000
    out = {}
    for r in rows:
        d = (r['time']//DAY)*DAY
        out[d] = r['close']   # last close of day wins (rows sorted asc)
    return out

print("Loading...")
btc = to_daily(load('binance-5m-7y.json'))
eth = to_daily(load('binance-eth-5m-7y.json'))
sol = to_daily(load('binance-sol-5m-3y.json'))
funding = load('binance-funding-7y.json')

# funding: avg daily funding rate (3 settlements/day) for BTC as proxy for short-leg drag
fmap = defaultdict(list)
DAY=86400000
for r in funding:
    if r['symbol']!='BTCUSDT': continue
    if r['rate'] is None: continue
    fmap[(r['time']//DAY)*DAY].append(r['rate'])
# daily funding = sum of settlements that day (short receives +rate when rate>0; pays when <0)
fund_daily = {d: sum(v) for d,v in fmap.items()}
# typical magnitude
allf=[abs(x) for x in fund_daily.values()]
print(f"BTC funding daily |rate| median={statistics.median(allf)*100:.4f}% n={len(allf)}")

def aligned(*coins):
    days = sorted(set.intersection(*[set(c.keys()) for c in coins]))
    return days

def year(ms):
    import datetime; return datetime.datetime.utcfromtimestamp(ms/1000).year

def sharpe(rets):
    if len(rets)<2: return 0.0
    m=statistics.mean(rets); s=statistics.pstdev(rets)
    return (m/s*math.sqrt(365)) if s>0 else 0.0

def drop_top20_survives(pnls):
    if not pnls: return False, 0
    s=sorted(pnls, reverse=True)
    k=int(len(s)*0.2)
    rest=s[k:]
    return (sum(rest)>0), sum(rest)

def beta_to_btc(strat_rets, btc_rets):
    """OLS slope of strat daily ret vs btc daily ret."""
    n=len(strat_rets)
    if n<5: return None
    mx=statistics.mean(btc_rets); my=statistics.mean(strat_rets)
    cov=sum((btc_rets[i]-mx)*(strat_rets[i]-my) for i in range(n))/n
    var=sum((b-mx)**2 for b in btc_rets)/n
    return cov/var if var>0 else None

def fund_for(d):
    return fund_daily.get(d, 0.0)

# ============================================================
# FAMILY 1 & 2: pairwise ratio / spread mean-reversion
# A/B ratio z-score. When z>+thr: A rich -> short A long B. z<-thr: long A short B.
# Hold until z reverts to 0 (or flips). Daily mark-to-market spread return.
# Spread return per day = ret_long - ret_short  (dollar-neutral).
# Funding: short leg pays/receives funding. Approx with BTC funding as market proxy.
# ============================================================

def run_pair(nameA, A, nameB, B, lookback=30, thr=1.5, mode='ratio'):
    days = aligned(A,B)
    if len(days)<lookback+50: return None
    closeA=[A[d] for d in days]; closeB=[B[d] for d in days]
    # build signal series
    series=[]
    for i in range(len(days)):
        if mode=='ratio':
            series.append(closeA[i]/closeB[i])
        else: # log spread vs rolling beta hedge
            series.append(math.log(closeA[i]))
    # daily returns
    retA=[0.0]+[closeA[i]/closeA[i-1]-1 for i in range(1,len(days))]
    retB=[0.0]+[closeB[i]/closeB[i-1]-1 for i in range(1,len(days))]
    btc_days_ret=[0.0]
    for i in range(1,len(days)):
        bd=days[i];
        btc_days_ret.append((btc[bd]/btc[days[i-1]]-1) if bd in btc and days[i-1] in btc else 0.0)

    pos=0  # +1 = long A short B, -1 = long B short A
    daily_pnl=[]      # spread return per day (net fee+funding)
    daily_strat=[]    # for beta calc (gross spread)
    trade_pnls=[]; cur=0.0; n_trades=0; trade_year=[]
    yearp=defaultdict(float)

    for i in range(lookback, len(days)):
        win=series[i-lookback:i]
        m=statistics.mean(win); s=statistics.pstdev(win)
        if s==0:
            daily_pnl.append(0); daily_strat.append(0); continue
        z=(series[i]-m)/s
        # realize today's pnl from yesterday's position
        if pos!=0:
            if mode=='ratio':
                # long A short B if pos=+1 means betting ratio A/B UP
                spread_ret = pos*(retA[i]-retB[i])
            else:
                spread_ret = pos*(retA[i]-retB[i])
            fund = fund_for(days[i])
            # short leg funding drag: when long A short B, short B pays funding if positive.
            # net funding cost approx: -|fund|*0  -> use market funding sign on short notional
            # conservative: short leg pays funding cost when funding>0 -> cost = fund (positive=cost)
            fdrag = abs(fund)*0.5   # conservative half-magnitude drag on one short leg
            net = spread_ret - fdrag
            daily_pnl.append(net); daily_strat.append(spread_ret)
            cur += net
            yearp[year(days[i])]+=net
        else:
            daily_pnl.append(0); daily_strat.append(0)
        # decide new position (entry on extreme, exit on revert)
        newpos=pos
        if z>thr: newpos=-1   # A rich -> bet ratio down -> long B short A
        elif z<-thr: newpos=+1
        elif abs(z)<0.3: newpos=0
        if newpos!=pos:
            if pos!=0:  # closing -> fee + book trade
                cur-=FEE_RT; daily_pnl[-1]-=FEE_RT
                trade_pnls.append(cur); trade_year.append(year(days[i])); cur=0.0; n_trades+=1
            if newpos!=0:
                cur-=FEE_RT; daily_pnl[-1]-=FEE_RT
            pos=newpos

    if n_trades<5: return None
    yrs=sorted(yearp); pos_yrs=sum(1 for y in yrs if yearp[y]>0)
    surv,rest=drop_top20_survives(trade_pnls)
    b=beta_to_btc(daily_strat, btc_days_ret)
    # walk-forward: split days by 2023 boundary
    split_ms=1672531200000  # 2023-01-01
    test_pnls=[trade_pnls[i] for i in range(len(trade_pnls)) if trade_year[i]>=2023]
    wf_test=sum(test_pnls)
    return {
        'name':f"{nameA}/{nameB} {mode} lb{lookback} z{thr}",
        'n':n_trades,'n_per_yr':n_trades/max(1,len(yrs)),
        'sharpe':sharpe([p for p in daily_pnl if p!=0]),
        'total':sum(trade_pnls),'medAlpha_trade':statistics.median(trade_pnls),
        'drop20_surv':surv,'drop20_rest':rest,
        'beta':b,'wf_test':wf_test,'pos_yrs':pos_yrs,'n_yrs':len(yrs),
        'yearp':dict(yearp)
    }

# ============================================================
# FAMILY 3: cross-sectional momentum / reversal (3 coins, SOL period only)
# rank by past-N-day return; long best short worst (or reverse). dollar-neutral.
# ============================================================
def run_xsec(lookback=7, reversal=False, hold=7):
    days = aligned(btc,eth,sol)
    if len(days)<lookback+hold+20: return None
    px={'BTC':[btc[d] for d in days],'ETH':[eth[d] for d in days],'SOL':[sol[d] for d in days]}
    coins=list(px)
    daily_pnl=[]; daily_strat=[]; trade_pnls=[]; trade_year=[]
    btc_ret=[0.0]+[btc[days[i]]/btc[days[i-1]]-1 for i in range(1,len(days))]
    yearp=defaultdict(float); n_trades=0
    i=lookback
    while i+hold<len(days):
        perf={c:px[c][i]/px[c][i-lookback]-1 for c in coins}
        order=sorted(coins,key=lambda c:perf[c])
        if reversal:
            longc, shortc = order[0], order[-1]   # long loser short winner
        else:
            longc, shortc = order[-1], order[0]   # long winner short loser
        seg=0.0
        for j in range(i,i+hold):
            rl=px[longc][j+1]/px[longc][j]-1
            rs=px[shortc][j+1]/px[shortc][j]-1
            sr=rl-rs
            fdrag=abs(fund_for(days[j+1]))*0.5
            net=sr-fdrag
            daily_pnl.append(net); daily_strat.append(sr); seg+=net
            yearp[year(days[j+1])]+=net
        seg-=FEE_RT; daily_pnl[-1]-=FEE_RT
        trade_pnls.append(seg); trade_year.append(year(days[i])); n_trades+=1
        i+=hold
    if n_trades<5: return None
    yrs=sorted(yearp); pos_yrs=sum(1 for y in yrs if yearp[y]>0)
    surv,rest=drop_top20_survives(trade_pnls)
    b=beta_to_btc(daily_strat, btc_ret[1:len(daily_strat)+1] if len(btc_ret)>len(daily_strat) else btc_ret[:len(daily_strat)])
    test_pnls=[trade_pnls[k] for k in range(len(trade_pnls)) if trade_year[k]>=2024]
    return {
        'name':f"XSEC {'REV' if reversal else 'MOM'} lb{lookback} hold{hold}",
        'n':n_trades,'n_per_yr':n_trades/max(1,len(yrs)),
        'sharpe':sharpe([p for p in daily_pnl if p!=0]),
        'total':sum(trade_pnls),'medAlpha_trade':statistics.median(trade_pnls),
        'drop20_surv':surv,'drop20_rest':rest,'beta':b,
        'wf_test':sum(test_pnls),'pos_yrs':pos_yrs,'n_yrs':len(yrs),'yearp':dict(yearp)
    }

# ============================================================
results=[]
pairs=[('ETH',eth,'BTC',btc),('SOL',sol,'BTC',btc),('SOL',sol,'ETH',eth)]
for nA,A,nB,B in pairs:
    for lb in [20,30,60]:
        for thr in [1.5,2.0,2.5]:
            r=run_pair(nA,A,nB,B,lookback=lb,thr=thr,mode='ratio')
            if r: results.append(r)
for lb in [3,7,14,30]:
    for hold in [3,7,14]:
        for rev in [False,True]:
            r=run_xsec(lookback=lb,reversal=rev,hold=hold)
            if r: results.append(r)

def fmt(r):
    b='%.2f'%r['beta'] if r['beta'] is not None else 'NA'
    return (f"{r['name']:<28} n={r['n']:>3} n/yr={r['n_per_yr']:>4.1f} "
            f"Sh={r['sharpe']:>6.2f} tot={r['total']*100:>7.1f}% "
            f"medA={r['medAlpha_trade']*100:>6.2f}% "
            f"drop20={'OK' if r['drop20_surv'] else 'DEAD':<4}({r['drop20_rest']*100:>6.1f}%) "
            f"beta={b:>5} WF_test={r['wf_test']*100:>7.1f}% "
            f"yrs={r['pos_yrs']}/{r['n_yrs']}")

print("\n=== ALL CONFIGS (net fee+funding, spread returns) ===")
for r in sorted(results,key=lambda x:-x['sharpe']):
    print(fmt(r))

# survivors of ALL gates
print("\n=== GATE SURVIVORS (Sh>0.5, medA>0, drop20 OK, |beta|<0.3, WF>0, pos_yrs>=ceil(N*0.6)) ===")
any_surv=False
for r in results:
    if (r['sharpe']>0.5 and r['medAlpha_trade']>0 and r['drop20_surv']
        and r['beta'] is not None and abs(r['beta'])<0.3
        and r['wf_test']>0 and r['pos_yrs']>=math.ceil(r['n_yrs']*0.6) and r['n_per_yr']>=3):
        print("SURVIVOR:",fmt(r));
        print("   per-year:",{k:round(v*100,1) for k,v in sorted(r['yearp'].items())})
        any_surv=True
if not any_surv: print("NONE survived all gates.")
