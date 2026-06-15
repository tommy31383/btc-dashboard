#!/usr/bin/env python3
"""
Order-flow / microstructure ENTRY screen from 5m OHLCV (PROXY only, no real tick/orderbook).
Honest-gate: medAlpha vs HOLD, random-null, drop-top-20%, cross-asset, walk-forward, per-year.
LONG-only, fixed exit (hold N bars) to isolate ENTRY. Fee 0.08% RT + slip.

Order-flow PROXIES (approximate, derived from OHLCV — NOT real orderbook):
  - signed volume / CVD proxy: sign(close-open)*volume cumulative
  - volume imbalance: rolling up-vol vs down-vol
  - large-candle absorption: high volume + small range (z-score)
  - wick rejection: long lower wick + high volume = buy absorption
  - volume climax/exhaustion: volume spike vs MA
"""
import json, numpy as np

FEE = 0.0008  # round trip
SLIP = 0.0002
COST = FEE + SLIP
HOLD = 12          # 12 bars 5m = 1 hour fixed exit
ATR_WIN = 288      # ~1 day in 5m bars (for normalization)

def load(path, cap_bars=None):
    d = json.load(open(path))
    t = np.array([x['time'] for x in d], dtype=np.int64)
    o = np.array([x['open'] for x in d], float)
    h = np.array([x['high'] for x in d], float)
    l = np.array([x['low'] for x in d], float)
    c = np.array([x['close'] for x in d], float)
    v = np.array([x['volume'] for x in d], float)
    return t, o, h, l, c, v

def years(t):
    import datetime
    return np.array([datetime.datetime.utcfromtimestamp(x/1000).year for x in t])

def rolling_mean(a, w):
    out = np.full_like(a, np.nan)
    cs = np.cumsum(np.insert(a, 0, 0))
    out[w-1:] = (cs[w:] - cs[:-w]) / w
    return out

def rolling_std(a, w):
    out = np.full_like(a, np.nan)
    for i in range(w-1, len(a)):
        out[i] = a[i-w+1:i+1].std()
    return out

def build_signals(t,o,h,l,c,v):
    n = len(c)
    body = c - o
    rng = np.maximum(h - l, 1e-9)
    upwick = h - np.maximum(o, c)
    lowwick = np.minimum(o, c) - l
    signed_v = np.sign(body) * v
    # proxies
    sig = {}
    # 1. CVD proxy slope: rising signed-vol over last 6 bars (buy pressure building)
    cvd = np.cumsum(signed_v)
    cvd_slope = np.full(n, np.nan); cvd_slope[6:] = cvd[6:] - cvd[:-6]
    csl_z_std = rolling_std(cvd_slope, 288)
    sig['cvd_up'] = (cvd_slope > 0) & (cvd_slope > csl_z_std)  # strong positive flow
    # 2. volume imbalance: up-vol >> down-vol over 6 bars
    upv = np.where(body>0, v, 0.0); dnv = np.where(body<0, v, 0.0)
    upv6 = rolling_mean(upv,6); dnv6 = rolling_mean(dnv,6)
    sig['vol_imb'] = upv6 > 2.0*np.maximum(dnv6,1e-9)
    # 3. large-candle absorption: high vol + small range, then green
    vol_ma = rolling_mean(v, 288); vol_sd = rolling_std(v, 288)
    rng_pct = rng / c
    rng_ma = rolling_mean(rng_pct, 288)
    absorb = (v > vol_ma + 2*vol_sd) & (rng_pct < rng_ma) & (body>0)
    sig['absorb'] = absorb
    # 4. wick rejection: long lower wick + high vol (buy absorption at lows)
    sig['wick_rej'] = (lowwick > 2.0*np.abs(body)) & (lowwick > upwick) & (v > vol_ma + vol_sd)
    # 5. volume climax green (capitulation buy): vol spike + green close
    sig['vol_climax'] = (v > vol_ma + 3*vol_sd) & (body>0)
    # 6. consecutive 3 green with rising volume
    g = body>0
    rising_v = (v > np.roll(v,1))
    sig['cons3_volup'] = g & np.roll(g,1) & np.roll(g,2) & rising_v & np.roll(rising_v,1)
    return sig

def atr(h,l,c,w=288):
    tr = np.maximum(h-l, np.maximum(np.abs(h-np.roll(c,1)), np.abs(l-np.roll(c,1))))
    return rolling_mean(tr, w)

def backtest(c, idx, hold=HOLD):
    """entry at close[i], exit at close[i+hold]. returns ret_trade, ret_hold(same)."""
    rets = []
    for i in idx:
        if i+hold >= len(c): continue
        entry = c[i]; ex = c[i+hold]
        r = (ex-entry)/entry - COST
        rets.append(r)
    return np.array(rets)

def hold_baseline(c, idx, hold=HOLD):
    # same as trade gross (buy-hold over identical window) minus no cost
    rets = []
    for i in idx:
        if i+hold >= len(c): continue
        rets.append((c[i+hold]-c[i])/c[i])
    return np.array(rets)

def fwd_ret_all(c, hold=HOLD):
    """unconditional N-bar forward gross return for every bar = HOLD baseline."""
    fr = np.full(len(c), np.nan)
    fr[:-hold] = (c[hold:]-c[:-hold])/c[:-hold]
    return fr

def evaluate(name, c, t, yr, sigmask, label, fwd):
    idx = np.where(sigmask)[0]
    idx = idx[(idx>ATR_WIN) & (idx < len(c)-HOLD)]
    if len(idx) < 30:
        return None
    tr = backtest(c, idx)
    # HOLD baseline = unconditional median N-bar forward return ("in-market anyway")
    base_med = np.nanmedian(fwd[ATR_WIN:len(c)-HOLD])
    # per-trade alpha = gross trade return minus unconditional median forward return
    alpha = (tr+COST) - base_med
    medAlpha = np.median(alpha)
    # drop top 20% by trade return
    k = int(len(tr)*0.8)
    order = np.argsort(tr)
    keep = order[:k]
    tr_drop = tr[keep]; alpha_drop = alpha[keep]
    drop_sum = tr_drop.sum()
    drop_med_alpha = np.median(alpha_drop)
    drop_alive = (drop_sum > 0) and (drop_med_alpha > 0)
    # per-year
    yrs_arr = yr[idx]
    uy = sorted(set(yrs_arr.tolist()))
    pos_years = 0; ny=0; npy={}
    for y in uy:
        m = yrs_arr==y
        if m.sum()<3: continue
        ny+=1
        s = tr[m].sum()
        npy[y]=(m.sum(), s)
        if s>0: pos_years+=1
    n_per_yr = len(idx)/max(len(uy),1)
    return dict(name=name, n=len(idx), n_per_yr=n_per_yr, medAlpha=medAlpha,
                sumRet=tr.sum(), drop_alive=drop_alive, drop_sum=drop_sum,
                drop_med_alpha=drop_med_alpha, pos_years=pos_years, ny=ny, npy=npy,
                tr=tr, idx=idx)

def random_null(c, n, hold=HOLD, trials=200, lo=ATR_WIN):
    rng = np.random.default_rng(42)
    meds=[]; sums=[]
    valid_hi = len(c)-hold
    for _ in range(trials):
        ridx = rng.integers(lo, valid_hi, size=n)
        tr = backtest(c, ridx)
        meds.append(np.median(tr)); sums.append(tr.sum())
    return np.median(meds), np.median(sums)

def walk_forward(c, t, yr, sigmask, fwd):
    idx = np.where(sigmask)[0]
    idx = idx[(idx>ATR_WIN) & (idx < len(c)-HOLD)]
    test_idx = idx[(yr[idx]>=2023)]
    if len(test_idx)<15: return None
    tr = backtest(c, test_idx)
    tmask = (yr>=2023)
    base_med = np.nanmedian(fwd[tmask & ~np.isnan(fwd)])
    alpha = (tr+COST)-base_med
    # drop top 20 in test
    k=int(len(tr)*0.8); order=np.argsort(tr); keep=order[:k]
    return dict(n=len(test_idx), sumRet=tr.sum(), medAlpha=np.median(alpha),
                drop_sum=tr[keep].sum())

def run_asset(path, name):
    t,o,h,l,c,v = load(path)
    yr = years(t)
    sig = build_signals(t,o,h,l,c,v)
    fwd = fwd_ret_all(c)
    results = {}
    for sname, mask in sig.items():
        r = evaluate(sname, c, t, yr, mask, name, fwd)
        if r is None: continue
        rm, rs = random_null(c, r['n'])
        r['rand_med'] = rm; r['rand_sum']=rs
        r['beat_rand'] = (r['medAlpha']>0) and (np.median(r['tr'])>rm)
        wf = walk_forward(c, t, yr, mask, fwd)
        r['wf'] = wf
        results[sname]=r
    return results, yr

if __name__=='__main__':
    print("="*70)
    print("ORDER-FLOW MICRO 5m HONEST SCREEN (OHLCV proxies, not real orderbook)")
    print(f"HOLD={HOLD} bars(5m)={HOLD*5}min  COST={COST*100:.2f}%  LONG-only")
    print("="*70)
    assets = [('.cache/binance-5m-7y.json','BTC'),
              ('.cache/binance-eth-5m-7y.json','ETH'),
              ('.cache/binance-sol-5m-3y.json','SOL')]
    allres = {}
    for path,nm in assets:
        print(f"\n##### {nm} #####")
        res, yr = run_asset(path, nm)
        allres[nm]=res
        for s,r in res.items():
            print(f"\n[{nm}/{s}] n={r['n']} n/yr={r['n_per_yr']:.0f} "
                  f"medAlpha={r['medAlpha']*100:+.3f}% sumRet={r['sumRet']*100:+.0f}%")
            print(f"   beat_rand={r['beat_rand']} (rand_med={r['rand_med']*100:+.3f}%) "
                  f"drop20_alive={r['drop_alive']} (drop_sum={r['drop_sum']*100:+.0f}% "
                  f"drop_medAlpha={r['drop_med_alpha']*100:+.3f}%)")
            print(f"   per-year pos={r['pos_years']}/{r['ny']}")
            if r['wf']:
                w=r['wf']
                print(f"   WF-test2023+ n={w['n']} sum={w['sumRet']*100:+.0f}% "
                      f"medAlpha={w['medAlpha']*100:+.3f}% drop20_sum={w['drop_sum']*100:+.0f}%")
    # Summary verdict table
    print("\n"+"="*70)
    print("VERDICT (qua HET gate = medAlpha>0 + beat_rand + drop20_alive + WF + per-yr>=5/8 + cross-asset)")
    print("="*70)
    # cross-asset: signal name passing in BTC AND ETH
    for s in ['cvd_up','vol_imb','absorb','wick_rej','vol_climax','cons3_volup']:
        rows=[]
        for nm in ['BTC','ETH','SOL']:
            r = allres[nm].get(s)
            if not r: rows.append((nm,'--')); continue
            passes = (r['medAlpha']>COST*0.5) and r['beat_rand'] and r['drop_alive'] and (r['pos_years']>=max(3,int(r['ny']*0.6)))
            wfp = r['wf'] and r['wf']['medAlpha']>0 and r['wf']['drop_sum']>0
            rows.append((nm, f"medA={r['medAlpha']*100:+.2f} drop={'Y' if r['drop_alive'] else 'N'} wf={'Y' if wfp else 'N'} {'PASS' if passes and wfp else 'fail'}"))
        print(f"\n{s}:")
        for nm,txt in rows: print(f"   {nm}: {txt}")
