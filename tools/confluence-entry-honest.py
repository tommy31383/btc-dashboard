#!/usr/bin/env python3
"""
Confluence-entry honest screen.
Hypothesis: requiring 3-4 simultaneous conditions (regime+momentum+level+volume+candle)
filters out beta that single signals can't. Test it seriously with anti-mirage gates.

GATES (all must pass):
  1. medAlpha vs HOLD > fee (0.1%)
  2. beat random-null
  3. drop-top-20% still positive AND beats hold
  4. cross-asset BTC+ETH(+SOL)
  5. walk-forward train2019-22 / test2023-26 unseen
  6. >=3 trades/year (else reject: can't trust, dodges bad years)
  7. per-year >=5/8 positive

Entry isolated with FIXED-bars exit (no trailing). Fee 0.08% + slip 0.02% per side.
Long-only priority.
"""
import json, math, datetime as dt
import numpy as np

FEE = 0.0008
SLIP = 0.0002
RT_COST = 2*(FEE+SLIP)   # round-trip cost ~0.2%
HOLD_BARS = 12           # exit after 12 bars on the entry TF (isolate entry)

def load(path):
    return json.load(open(path))

def resample(bars, tf_min):
    """resample 5m bars to tf_min minute candles."""
    out=[]
    step = tf_min//5
    for i in range(0, len(bars)-step+1, step):
        chunk = bars[i:i+step]
        out.append({
            'time': chunk[0]['time'],
            'open': chunk[0]['open'],
            'high': max(c['high'] for c in chunk),
            'low': min(c['low'] for c in chunk),
            'close': chunk[-1]['close'],
            'volume': sum(c['volume'] for c in chunk),
        })
    return out

def to_np(bars):
    return (np.array([b['time'] for b in bars],dtype=np.int64),
            np.array([b['open'] for b in bars]),
            np.array([b['high'] for b in bars]),
            np.array([b['low'] for b in bars]),
            np.array([b['close'] for b in bars]),
            np.array([b['volume'] for b in bars]))

def ema(x, n):
    a=2/(n+1); out=np.empty_like(x); out[0]=x[0]
    for i in range(1,len(x)): out[i]=a*x[i]+(1-a)*out[i-1]
    return out

def rsi(c, n=14):
    d=np.diff(c, prepend=c[0])
    up=np.where(d>0,d,0); dn=np.where(d<0,-d,0)
    ru=np.empty_like(c); rd=np.empty_like(c); ru[0]=up[0]; rd[0]=dn[0]
    a=1/n
    for i in range(1,len(c)):
        ru[i]=a*up[i]+(1-a)*ru[i-1]; rd[i]=a*dn[i]+(1-a)*rd[i-1]
    rs=ru/(rd+1e-12); return 100-100/(1+rs)

def stochrsi_k(c, n=14):
    r=rsi(c,n)
    k=np.empty_like(r)
    for i in range(len(r)):
        lo=max(0,i-n+1); w=r[lo:i+1]
        mn,mx=w.min(),w.max()
        k[i]=(r[i]-mn)/(mx-mn+1e-12)*100
    return k

def atr(h,l,c,n=14):
    tr=np.maximum(h-l, np.maximum(np.abs(h-np.roll(c,1)), np.abs(l-np.roll(c,1))))
    tr[0]=h[0]-l[0]
    out=np.empty_like(tr); out[0]=tr[0]; a=1/n
    for i in range(1,len(tr)): out[i]=a*tr[i]+(1-a)*out[i-1]
    return out

def year_of(ms):
    return dt.datetime.utcfromtimestamp(ms/1000).year

def build_indicators(bars, tf_min):
    t,o,h,l,c,v = to_np(bars)
    e200 = ema(c, 200)
    e50  = ema(c, 50)
    r    = rsi(c,14)
    k    = stochrsi_k(c,14)
    a    = atr(h,l,c,14)
    vma  = np.convolve(v, np.ones(20)/20, mode='same')
    # daily EMA200 trend proxy: ema over ~ (1440/tf_min)*200 bars
    bars_per_day = 1440//tf_min
    e200d = ema(c, 200*bars_per_day)
    return dict(t=t,o=o,h=h,l=l,c=c,v=v,e200=e200,e50=e50,rsi=r,k=k,atr=a,vma=vma,e200d=e200d)

# ---- confluence condition primitives (boolean arrays aligned to bar index) ----
def conds(ind):
    c=ind['c']; o=ind['o']; h=ind['h']; l=ind['l']; v=ind['v']
    out={}
    out['trend_up']   = c > ind['e200d']              # regime: daily uptrend
    out['above_e200'] = c > ind['e200']
    out['mom_rsi']    = ind['rsi'] > 50               # momentum positive
    out['rsi_dip']    = ind['rsi'] < 40               # pullback (mean-rev flavor)
    out['stoch_os']   = ind['k'] < 25                 # oversold stoch
    out['stoch_mom']  = ind['k'] > 50                 # stoch momentum
    out['near_e50']   = np.abs(c-ind['e50'])/c < 0.01 # at support EMA50
    out['retest_e200']= (c>=ind['e200d']*0.97)&(c<=ind['e200d']*1.05)  # retest zone
    out['vol_spike']  = v > ind['vma']*1.3            # volume spike
    out['bull_candle']= c > o                          # bullish close
    out['big_bull']   = (c-o)/o > 0.003               # strong bull candle
    # multi-tf momentum proxy: close > close 12 bars ago AND > 48 bars ago
    c12 = np.roll(c,12); c48=np.roll(c,48)
    out['multitf_mom']= (c>c12)&(c>c48)
    return out

# define confluence sets (theory-driven, long-only)
CONFLUENCES = {
 'C1_trend_dip_vol':      ['trend_up','rsi_dip','vol_spike'],
 'C2_trend_stochos_bull': ['trend_up','stoch_os','bull_candle'],
 'C3_trend_e50_mom':      ['trend_up','near_e50','mom_rsi'],
 'C4_trend_retest_vol':   ['trend_up','retest_e200','vol_spike'],
 'C5_trend_stochmom_vol_bull':['trend_up','stoch_mom','vol_spike','bull_candle'],
 'C6_trend_multitf_dip':  ['trend_up','multitf_mom','rsi_dip'],
 'C7_above200_stochos_volbull':['above_e200','stoch_os','vol_spike','bull_candle'],
 'C8_trend_e50_stochos':  ['trend_up','near_e50','stoch_os'],
 'C9_trend_multitf_vol_bigbull':['trend_up','multitf_mom','vol_spike','big_bull'],
 'C10_trend_retest_stochos_bull':['trend_up','retest_e200','stoch_os','bull_candle'],
 'C11_above200_mom_vol':  ['above_e200','mom_rsi','vol_spike'],
 'C12_trend_e50_volbull': ['trend_up','near_e50','vol_spike','bull_candle'],
}

def run_confluence(ind, cond_arr, names, hold=HOLD_BARS):
    c=ind['c']; t=ind['t']
    mask = np.ones(len(c), dtype=bool)
    for nm in names: mask &= cond_arr[nm]
    # entries: rising edge only, must have hold bars ahead, skip warmup
    warm = 300
    trades=[]  # (year, ret_after_cost, hold_ret)
    i=warm
    n=len(c)
    last_exit=0
    while i < n-hold:
        if mask[i] and i>=last_exit:
            entry=c[i]; ex=c[i+hold]
            ret = ex/entry - 1 - RT_COST
            trades.append((year_of(t[i]), ret))
            last_exit=i+hold
        i+=1
    return trades

def hold_return_per_trade(ind, trades_times=None, hold=HOLD_BARS):
    """baseline: average hold return over same horizon across all bars."""
    c=ind['c']
    fwd = c[hold:]/c[:-hold]-1
    return np.median(fwd)

def median_alpha(trades, ind, hold=HOLD_BARS):
    if not trades: return None
    rets=np.array([r for _,r in trades])
    base = hold_return_per_trade(ind, hold=hold)  # market median hold (no cost)
    return np.median(rets) - base

def random_null(ind, n_trades, hold=HOLD_BARS, iters=200):
    """median return of n random entries, distribution."""
    c=ind['c']; N=len(c)
    warm=300
    meds=[]
    rng=np.random.default_rng(42)
    for _ in range(iters):
        idx=rng.integers(warm, N-hold, size=n_trades)
        rets=c[idx+hold]/c[idx]-1-RT_COST
        meds.append(np.median(rets))
    return np.array(meds)

def evaluate(asset_label, ind):
    cond_arr = conds(ind)
    base_hold = hold_return_per_trade(ind)
    n_years = len(set(year_of(t) for t in ind['t'][::5000]))
    results={}
    for cname, names in CONFLUENCES.items():
        trades = run_confluence(ind, cond_arr, names)
        ntot=len(trades)
        years=sorted(set(y for y,_ in trades))
        if ntot==0:
            results[cname]=dict(n=0); continue
        rets=np.array([r for _,r in trades])
        # per year
        yr_pos=0; yr_tot=0; yr_counts={}
        all_years=sorted(set(year_of(t) for t in ind['t']))
        for y in all_years:
            yr=[r for yy,r in trades if yy==y]
            yr_counts[y]=len(yr)
            if yr:
                yr_tot+=1
                if sum(yr)>0: yr_pos+=1
        nyr = max(1, len(all_years))
        n_per_yr = ntot/nyr
        med = np.median(rets)
        medAlpha = med - base_hold
        sumret = rets.sum()
        # drop top 20%
        k=max(1,int(len(rets)*0.2))
        kept = np.sort(rets)[:-k] if len(rets)>k else np.array([])
        drop_sum = kept.sum() if len(kept) else float('nan')
        drop_med = np.median(kept) if len(kept) else float('nan')
        # random null
        nulls = random_null(ind, ntot)
        beat_random = med > np.percentile(nulls,95)
        # walk-forward
        tr_train=[r for y,r in trades if y<=2022]
        tr_test =[r for y,r in trades if y>=2023]
        wf_train = np.median(tr_train) - base_hold if tr_train else None
        wf_test  = np.median(tr_test) - base_hold if tr_test else None
        results[cname]=dict(
            n=ntot, n_per_yr=round(n_per_yr,1), medAlpha=round(medAlpha*100,3),
            sumret=round(sumret*100,1),
            drop20_sum=round(drop_sum*100,1) if not math.isnan(drop_sum) else None,
            drop20_med=round(drop_med*100,3) if not math.isnan(drop_med) else None,
            beat_random=bool(beat_random),
            null_p95=round(np.percentile(nulls,95)*100,3),
            wf_train=round(wf_train*100,3) if wf_train is not None else None,
            wf_test=round(wf_test*100,3) if wf_test is not None else None,
            yr_pos=f"{yr_pos}/{yr_tot}",
            yr_counts=yr_counts,
            base_hold=round(base_hold*100,3),
        )
    return results

def main():
    print("Loading + resampling to 4h...")
    btc5 = load('.cache/binance-5m-7y.json')
    eth5 = load('.cache/binance-eth-5m-7y.json')
    sol5 = load('.cache/binance-sol-5m-3y.json')
    TF=240  # 4h
    assets={
      'BTC': build_indicators(resample(btc5,TF),TF),
      'ETH': build_indicators(resample(eth5,TF),TF),
      'SOL': build_indicators(resample(sol5,TF),TF),
    }
    all_res={a:evaluate(a,ind) for a,ind in assets.items()}

    # print table per confluence, BTC primary
    print("\n=== CONFLUENCE SCREEN (4h, hold=12 bars=48h, long-only) ===")
    hdr=f"{'confluence':<28}{'n/yr':>6}{'medAlpha%':>10}{'drop20sum%':>11}{'beatRnd':>8}{'wfTest%':>9}{'per-yr':>8}"
    for asset in ['BTC','ETH','SOL']:
        print(f"\n--- {asset} (base hold med {list(all_res[asset].values())[0].get('base_hold','?') if all_res[asset] else '?'}%) ---")
        print(hdr)
        for cname in CONFLUENCES:
            r=all_res[asset][cname]
            if r.get('n',0)==0:
                print(f"{cname:<28}{'0':>6}  (no trades)")
                continue
            print(f"{cname:<28}{r['n_per_yr']:>6}{r['medAlpha']:>10}{str(r['drop20_sum']):>11}{str(r['beat_random']):>8}{str(r['wf_test']):>9}{r['yr_pos']:>8}")

    # GATE evaluation on BTC, then require cross-asset
    print("\n\n=== HONEST-GATE VERDICT ===")
    for cname in CONFLUENCES:
        b=all_res['BTC'][cname]
        if b.get('n',0)==0:
            print(f"{cname}: FAIL (no BTC trades)"); continue
        gates=[]
        g1 = b['medAlpha']>0.1
        g3 = (b['drop20_sum'] is not None and b['drop20_sum']>0 and b['drop20_med'] is not None and b['drop20_med']>b['base_hold'])
        g2 = b['beat_random']
        g5 = (b['wf_test'] is not None and b['wf_test']>0.1)
        g6 = b['n_per_yr']>=3
        yp,yt=map(int,b['yr_pos'].split('/'))
        g7 = (yt>0 and yp/yt>=0.625)  # >=5/8
        # cross asset: ETH must also have medAlpha>fee and drop20>0
        e=all_res['ETH'][cname]
        s=all_res['SOL'][cname]
        g4 = (e.get('n',0)>0 and e['medAlpha']>0.1 and (e['drop20_sum'] or -1)>0)
        passed = all([g1,g2,g3,g4,g5,g6,g7])
        fails=[]
        if not g1: fails.append('medAlpha')
        if not g2: fails.append('random')
        if not g3: fails.append('drop20')
        if not g4: fails.append('crossasset')
        if not g5: fails.append('walkfwd')
        if not g6: fails.append('n<3/yr')
        if not g7: fails.append('per-yr')
        verdict='*** PASS ALL ***' if passed else 'FAIL: '+','.join(fails)
        print(f"{cname:<30} {verdict}  [BTC medA={b['medAlpha']} drop20={b['drop20_sum']} wfTest={b['wf_test']} n/yr={b['n_per_yr']} | ETH medA={e.get('medAlpha')} drop20={e.get('drop20_sum')}]")

if __name__=='__main__':
    main()
