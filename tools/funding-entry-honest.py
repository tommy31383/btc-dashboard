#!/usr/bin/env python3
"""
Funding-rate AS ENTRY TRIGGER — honest-gate screen.
Hypothesis: funding extreme = contrarian entry edge.
  funding < pct10 / negative  -> short crowded -> LONG bounce (priority)
  funding > pct90             -> long crowded  -> SHORT / avoid-long (secondary)
  funding cross zero, funding delta (reversal), + momentum gate.

DATA: BTCUSDT funding 8h 7y only (no ETH funding). ETH price tested with BTC
funding as MACRO PROXY only (limitation noted).

EXIT: fixed horizon (no trailing) to isolate ENTRY. Fee 0.08% + slip 0.02% = 0.10%/side.

GATES (all must pass):
 1. medAlpha vs HOLD > fee 0.1%
 2. random-null beat (entry beats N random-time entries same exit)
 3. drop-top-20% still positive (kills fat-tail mirage)
 4. cross-asset (BTC; ETH-proxy noted)
 5. walk-forward train 2019-22 / test 2023-26
 6. >=3 trades/yr
 7. per-year >=5/8 positive
"""
import json, numpy as np
from datetime import datetime, timezone

FEE = 0.0010  # per side (0.08 fee + 0.02 slip)
RT  = 2*FEE   # round trip
np.random.seed(42)

def load_funding():
    d = json.load(open('.cache/binance-funding-7y.json'))
    rows = [(r['time'], float(r['rate'])) for r in d if r['rate'] is not None]
    rows.sort()
    return np.array([t for t,_ in rows]), np.array([r for _,r in rows])

def load_price_5m(path):
    d = json.load(open(path))
    # autodetect format
    if isinstance(d, dict):
        d = d.get('candles') or d.get('data') or list(d.values())[0]
    arr = []
    for c in d:
        if isinstance(c, dict):
            t = c.get('time') or c.get('openTime') or c.get('t')
            cl = c.get('close') or c.get('c')
            arr.append((int(t), float(cl)))
        else:
            arr.append((int(c[0]), float(c[4])))
    arr.sort()
    return np.array([t for t,_ in arr]), np.array([p for _,p in arr])

def price_at(pt, pp, ts):
    """price at funding time ts via searchsorted (first bar >= ts)."""
    i = np.searchsorted(pt, ts)
    if i >= len(pp): return None
    return pp[i], pt[i]

def fwd_return(pt, pp, ts, horizon_ms):
    """long fwd return entry@ts exit@ts+horizon, fee deducted."""
    e = price_at(pt, pp, ts)
    x = price_at(pt, pp, ts+horizon_ms)
    if e is None or x is None: return None
    raw = x[0]/e[0] - 1.0
    return raw

def yr(ts): return datetime.fromtimestamp(ts/1000, tz=timezone.utc).year

H8 = 8*3600*1000
DAY = 24*3600*1000

def hold_ret(pt, pp, ts, days, direction):
    r = fwd_return(pt, pp, ts, days*DAY)
    if r is None: return None
    if direction=='short': r = -r
    return r - RT  # net of round-trip fee

def baseline_hold(pt, pp, ts, days):
    """buy-and-hold same horizon (no fee, the reference move)."""
    r = fwd_return(pt, pp, ts, days*DAY)
    return r

def eval_candidate(name, ft, fr, pt, pp, mask, days, direction, label_asset):
    idx = np.where(mask)[0]
    trades=[]; years={}
    holdrefs=[]
    for i in idx:
        ts = ft[i]
        r = hold_ret(pt, pp, ts, days, direction)
        if r is None: continue
        h = baseline_hold(pt, pp, ts, days)
        if direction=='short': h=-h
        trades.append(r); holdrefs.append(h)
        years.setdefault(yr(ts),[]).append(r)
    if len(trades)<10:
        return None
    trades=np.array(trades); holdrefs=np.array(holdrefs)
    nyr = len(years)
    n_per_yr = len(trades)/max(nyr,1)
    # medAlpha vs hold: median(trade_net) - median(hold_ref_net). hold ref net = h - RT (fair compare)
    alpha = np.median(trades - (holdrefs - RT))
    med = np.median(trades)
    sumret = trades.sum()
    # drop top 20%
    k = int(len(trades)*0.2)
    dropped = np.sort(trades)[:len(trades)-k] if k>0 else trades
    drop_sum = dropped.sum()
    # per-year positive
    yr_pos = sum(1 for y,v in years.items() if np.sum(v)>0)
    # random-null: sample len(trades) random funding times, same direction/exit
    nulls=[]
    valid_i = np.arange(len(ft))
    for _ in range(300):
        samp = np.random.choice(valid_i, len(trades), replace=False)
        rr=[]
        for i in samp:
            r=hold_ret(pt,pp,ft[i],days,direction)
            if r is not None: rr.append(r)
        if rr: nulls.append(np.median(rr))
    null_med = np.median(nulls) if nulls else 0
    null_pct = (np.array(nulls) < med).mean() if nulls else 0  # frac of random worse than candidate
    return dict(name=name, asset=label_asset, n=len(trades), n_per_yr=round(n_per_yr,1),
                med=med, alpha=alpha, sumret=sumret, drop_sum=drop_sum,
                yr_pos=f"{yr_pos}/{nyr}", null_med=null_med, null_beat=round(null_pct,2),
                years=years, days=days, dir=direction)

def walk_forward(ft, fr, pt, pp, mask, days, direction):
    tr_m = mask & (np.array([yr(t) for t in ft])<=2022)
    te_m = mask & (np.array([yr(t) for t in ft])>=2023)
    def run(m):
        rs=[]
        for i in np.where(m)[0]:
            r=hold_ret(pt,pp,ft[i],days,direction)
            if r is not None: rs.append(r)
        return np.array(rs)
    tr=run(tr_m); te=run(te_m)
    return (np.median(tr) if len(tr) else None, len(tr),
            np.median(te) if len(te) else None, len(te))

def main():
    ft, fr = load_funding()
    print(f"Funding: n={len(fr)}  range {yr(ft[0])}-{yr(ft[-1])}")
    print(f"  rate stats: min={fr.min():.5f} p10={np.percentile(fr,10):.5f} "
          f"med={np.median(fr):.5f} p90={np.percentile(fr,90):.5f} max={fr.max():.5f} "
          f"neg%={(fr<0).mean()*100:.1f}")
    btc = load_price_5m('.cache/binance-5m-7y.json')
    eth = load_price_5m('.cache/binance-eth-5m-7y.json')

    p10=np.percentile(fr,10); p90=np.percentile(fr,90)
    p05=np.percentile(fr,5);  p95=np.percentile(fr,95)
    # momentum gate: price now vs 24h ago (3 funding periods)
    def mom_up(i):
        if i<3: return False
        e=price_at(pt,pp,ft[i]); a=price_at(pt,pp,ft[i-3])
        if e is None or a is None: return False
        return e[0]>a[0]

    candidates_def = [
        # (name, mask_fn, days, direction)
        ("fund<p10 LONG",       lambda: fr<p10,                 2, 'long'),
        ("fund<p10 LONG h5d",   lambda: fr<p10,                 5, 'long'),
        ("fund<p05 LONG",       lambda: fr<p05,                 2, 'long'),
        ("fund<0 (neg) LONG",   lambda: fr<0,                   2, 'long'),
        ("fund<0 LONG h5d",     lambda: fr<0,                   5, 'long'),
        ("fund<p10 +momUp LONG",lambda: fr<p10,                 2, 'long'),  # mom applied below
        ("fund>p90 SHORT",      lambda: fr>p90,                 2, 'short'),
        ("fund>p95 SHORT",      lambda: fr>p95,                 2, 'short'),
        ("fund>p90 SHORT h5d",  lambda: fr>p90,                 5, 'short'),
        ("fund cross<0 LONG",   lambda: np.concatenate([[False],(fr[1:]<0)&(fr[:-1]>=0)]), 3,'long'),
        ("fund delta-down LONG",lambda: np.concatenate([[False],(fr[1:]<fr[:-1])&(fr[1:]<p10)]),3,'long'),
    ]

    results=[]
    for name, mfn, days, direction in candidates_def:
        for asset_name, (pt,pp) in [('BTC',btc),('ETHproxy',eth)]:
            m = mfn()
            if 'momUp' in name:
                mm = np.array([mom_up(i) for i in range(len(ft))])
                m = m & mm
            r = eval_candidate(name, ft, fr, pt, pp, m, days, direction, asset_name)
            if r is None: continue
            wf = walk_forward(ft, fr, pt, pp, m, days, direction)
            r['wf']=wf
            results.append(r)

    # Report
    print("\n=== CANDIDATE TABLE (net of fee) ===")
    hdr=f"{'candidate':<24}{'asset':<9}{'n':>5}{'n/yr':>6}{'medAlpha%':>10}{'med%':>8}{'sumRet':>9}{'dropTop20':>11}{'nullBeat':>9}{'perYr':>7}{'WF tr/te med%':>16}"
    print(hdr); print('-'*len(hdr))
    for r in results:
        tr_m,tr_n,te_m,te_n=r['wf']
        wfstr=f"{(tr_m*100 if tr_m is not None else 0):+.2f}/{(te_m*100 if te_m is not None else 0):+.2f}"
        print(f"{r['name']:<24}{r['asset']:<9}{r['n']:>5}{r['n_per_yr']:>6}"
              f"{r['alpha']*100:>+10.3f}{r['med']*100:>+8.2f}{r['sumret']*100:>+9.1f}"
              f"{r['drop_sum']*100:>+11.1f}{r['null_beat']:>9.2f}{r['yr_pos']:>7}{wfstr:>16}")

    print("\n=== GATE PASS CHECK (BTC primary) ===")
    for r in results:
        if r['asset']!='BTC': continue
        tr_m,_,te_m,_=r['wf']
        g1 = r['alpha']>FEE
        g2 = r['null_beat']>=0.90
        g3 = r['drop_sum']>0
        g5 = (te_m is not None and te_m>0)
        g6 = r['n_per_yr']>=3
        try: yp=int(r['yr_pos'].split('/')[0]); yt=int(r['yr_pos'].split('/')[1]); g7=yp>=5 and yt>=8
        except: g7=False
        passed=sum([g1,g2,g3,g5,g6,g7])
        flag='*** PASS ALL ***' if all([g1,g2,g3,g5,g6,g7]) else ''
        print(f"{r['name']:<24} medAlpha>{FEE}:{g1} nullBeat:{g2} dropTop20+:{g3} "
              f"WFtest+:{g5} n/yr>=3:{g6} perYr>=5/8:{g7}  [{passed}/6] {flag}")

if __name__=='__main__':
    main()
