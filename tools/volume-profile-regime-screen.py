#!/usr/bin/env python3
"""
Volume Profile / POC / Value Area (VA) as a REGIME-GATE for crypto.

Hypothesis: price IN Value Area = range/accumulation -> enable mean-reversion;
price BREAKOUT above/below VA + volume confirm = trend -> enable trend-following.

Honest gates:
- Judge DOLLARS + Calmar (not RA%)
- drop-top-20% (kill fat-tail mirage)
- walk-forward: train 2019-2022 -> test UNSEEN 2023-2026
- cross-asset BTC+ETH+SOL (>=2/3)
- random-gate baseline (same on/off frequency)
- regime classification accuracy: does "trend regime" actually trend (big |move|, low reverse)
  vs "range regime" actually mean-revert.
"""
import json, math, sys
import numpy as np

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache"
FILES = {
    "BTC": f"{CACHE}/binance-5m-7y.json",
    "ETH": f"{CACHE}/binance-eth-5m-7y.json",
    "SOL": f"{CACHE}/binance-sol-5m-3y.json",
}

def load(sym):
    d = json.load(open(FILES[sym]))
    t = np.array([x["time"] for x in d], dtype=np.int64)
    o = np.array([x["open"] for x in d], float)
    h = np.array([x["high"] for x in d], float)
    l = np.array([x["low"] for x in d], float)
    c = np.array([x["close"] for x in d], float)
    v = np.array([x["volume"] for x in d], float)
    return t, o, h, l, c, v

def aggregate(t, o, h, l, c, v, mins):
    """Aggregate 5m bars to mins-minute bars."""
    bucket = mins * 60 * 1000
    grp = t // bucket
    out_t, out_o, out_h, out_l, out_c, out_v = [], [], [], [], [], []
    i = 0
    n = len(t)
    while i < n:
        j = i
        g = grp[i]
        while j < n and grp[j] == g:
            j += 1
        out_t.append(int(grp[i] * bucket))
        out_o.append(o[i]); out_h.append(h[i:j].max()); out_l.append(l[i:j].min())
        out_c.append(c[j-1]); out_v.append(v[i:j].sum())
        i = j
    return (np.array(out_t), np.array(out_o), np.array(out_h),
            np.array(out_l), np.array(out_c), np.array(out_v))

def year_of(ts):
    import datetime
    return datetime.datetime.utcfromtimestamp(ts/1000).year

# ---------- Volume Profile ----------
def vp_regime(h, l, c, v, lookback=200, nbins=50, va_pct=0.70):
    """
    Rolling volume profile. For each bar i (using bars i-lookback..i-1),
    build price-volume histogram, find POC + Value Area (va_pct of volume around POC).
    Classify current close vs VA:
      0 = inside VA (range), +1 = above VAH (breakout up), -1 = below VAL (breakout down)
    Also return va width (as proxy for compression).
    """
    n = len(c)
    regime = np.zeros(n, dtype=int)
    vah = np.full(n, np.nan); val = np.full(n, np.nan); poc = np.full(n, np.nan)
    for i in range(lookback, n):
        ph = h[i-lookback:i]; pl = l[i-lookback:i]; pv = v[i-lookback:i]
        lo = pl.min(); hi = ph.max()
        if hi <= lo:
            continue
        edges = np.linspace(lo, hi, nbins+1)
        mid = (edges[:-1] + edges[1:]) / 2
        # distribute each bar's volume across the bins it spans (typical price proxy)
        tp = (ph + pl) / 2  # use typical price per bar -> assign to bin
        idx = np.clip(((tp - lo) / (hi - lo) * nbins).astype(int), 0, nbins-1)
        hist = np.zeros(nbins)
        np.add.at(hist, idx, pv)
        if hist.sum() <= 0:
            continue
        poc_bin = int(hist.argmax())
        poc[i] = mid[poc_bin]
        # expand VA around POC until va_pct of total volume
        total = hist.sum()
        target = total * va_pct
        lo_b = hi_b = poc_bin
        acc = hist[poc_bin]
        while acc < target and (lo_b > 0 or hi_b < nbins-1):
            down = hist[lo_b-1] if lo_b > 0 else -1
            up = hist[hi_b+1] if hi_b < nbins-1 else -1
            if up >= down:
                hi_b += 1; acc += hist[hi_b]
            else:
                lo_b -= 1; acc += hist[lo_b]
        vah[i] = edges[hi_b+1]; val[i] = edges[lo_b]
        px = c[i]
        if px > vah[i]:
            regime[i] = 1
        elif px < val[i]:
            regime[i] = -1
        else:
            regime[i] = 0
    return regime, poc, vah, val

def vol_confirm(v, lookback=20, mult=1.2):
    """current bar volume > mult * rolling mean -> True"""
    n = len(v); out = np.zeros(n, dtype=bool)
    csum = np.cumsum(v)
    for i in range(lookback, n):
        m = (csum[i-1] - csum[i-lookback-1]) / lookback if i-lookback-1 >= 0 else v[i-lookback:i].mean()
        out[i] = v[i] > mult * m
    return out

# ---------- baselines ----------
def adx_ema(h, l, c, period=14, ema_n=200):
    n = len(c)
    tr = np.zeros(n); plus_dm = np.zeros(n); minus_dm = np.zeros(n)
    for i in range(1, n):
        up = h[i]-h[i-1]; dn = l[i-1]-l[i]
        plus_dm[i] = up if (up > dn and up > 0) else 0
        minus_dm[i] = dn if (dn > up and dn > 0) else 0
        tr[i] = max(h[i]-l[i], abs(h[i]-c[i-1]), abs(l[i]-c[i-1]))
    def rma(x):
        out = np.zeros(n); out[period] = x[1:period+1].mean()
        for i in range(period+1, n):
            out[i] = (out[i-1]*(period-1)+x[i])/period
        return out
    atr = rma(tr); pdi = 100*rma(plus_dm)/np.where(atr==0,1e-9,atr)
    mdi = 100*rma(minus_dm)/np.where(atr==0,1e-9,atr)
    dx = 100*np.abs(pdi-mdi)/np.where((pdi+mdi)==0,1e-9,(pdi+mdi))
    adx = rma(dx)
    ema = np.zeros(n); ema[0]=c[0]; a=2/(ema_n+1)
    for i in range(1,n): ema[i]=a*c[i]+(1-a)*ema[i-1]
    return adx, ema

# ---------- regime accuracy ----------
def regime_accuracy(regime, c, fwd=12):
    """For each regime label, measure forward log-return magnitude & reversal rate.
    trend regimes should have large |fwd ret|; range regime small + mean-revert."""
    n = len(c)
    logc = np.log(c)
    res = {}
    for label, name in [(1,'breakUp'), (-1,'breakDn'), (0,'inVA')]:
        idx = np.where(regime[:n-fwd] == label)[0]
        idx = idx[idx >= 0]
        if len(idx) < 30:
            res[name] = None; continue
        fr = logc[idx+fwd] - logc[idx]   # forward return
        absmove = np.abs(fr)
        # for breakouts, "correct" = move continues in breakout direction
        if label == 1:
            cont = (fr > 0).mean()
        elif label == -1:
            cont = (fr < 0).mean()
        else:
            cont = None
        res[name] = dict(n=len(idx), median_absmove=float(np.median(absmove)),
                         mean_fr=float(fr.mean()), cont_rate=(float(cont) if cont is not None else None))
    return res

# ---------- simple gated backtest ----------
def atr_arr(h,l,c,period=14):
    n=len(c); tr=np.zeros(n)
    for i in range(1,n):
        tr[i]=max(h[i]-l[i],abs(h[i]-c[i-1]),abs(l[i]-c[i-1]))
    atr=np.zeros(n); atr[period]=tr[1:period+1].mean()
    for i in range(period+1,n): atr[i]=(atr[i-1]*(period-1)+tr[i])/period
    return atr

def backtest(t,o,h,l,c,v, gate_fn, direction='trend', tp_atr=3.0, sl_atr=1.5,
             ema_for_dir=None, hold_max=24):
    """
    direction='trend': LONG on breakUp regime (gate True) when close>EM200; judge dollars.
    direction='range': LONG when inVA + close below POC-ish (buy dip in range).
    Faithful-ish: one position at a time, ATR TP/SL, fee 0.04%/side.
    gate_fn(i)->bool decides if entry allowed.
    Returns list of trade pnl (in $ on $100k notional w/ qty sized to fixed risk).
    """
    n=len(c); atr=atr_arr(h,l,c)
    fee=0.0004
    trades=[]; years=[]
    i=200; pos=None
    capital=100000.0
    while i<n-1:
        if pos is None:
            if atr[i]>0 and gate_fn(i):
                # entry long
                entry=c[i]; risk=sl_atr*atr[i]
                if risk<=0: i+=1; continue
                qty=(capital*0.01)/risk  # 1% risk per trade
                pos=dict(entry=entry, qty=qty, tp=entry+tp_atr*atr[i], sl=entry-sl_atr*atr[i],
                         bar=i, yr=year_of(t[i]))
            i+=1; continue
        else:
            px_h=h[i]; px_l=l[i]
            exit_px=None
            if px_l<=pos['sl']: exit_px=pos['sl']
            elif px_h>=pos['tp']: exit_px=pos['tp']
            elif i-pos['bar']>=hold_max: exit_px=c[i]
            if exit_px is not None:
                pnl=(exit_px-pos['entry'])*pos['qty']
                pnl-=fee*(pos['entry']+exit_px)*pos['qty']
                trades.append(pnl); years.append(pos['yr'])
                pos=None
            i+=1
    return np.array(trades), np.array(years)

def metrics(trades):
    if len(trades)==0: return dict(n=0,total=0,calmar=0,dt20=0)
    total=trades.sum()
    eq=np.cumsum(trades)
    peak=np.maximum.accumulate(eq); dd=(peak-eq); maxdd=dd.max() if len(dd) else 0
    calmar=total/maxdd if maxdd>0 else (total if total>0 else 0)
    # drop top 20% winners
    srt=np.sort(trades)[::-1]
    k=int(len(srt)*0.2)
    dt20=srt[k:].sum()
    return dict(n=len(trades),total=float(total),maxdd=float(maxdd),
                calmar=float(calmar),dt20=float(dt20))

def run_asset(sym, tf_min=240, lookback=120, verbose=True):
    t,o,h,l,c,v = load(sym)
    t,o,h,l,c,v = aggregate(t,o,h,l,c,v,tf_min)
    regime,poc,vah,val = vp_regime(h,l,c,v,lookback=lookback)
    vc = vol_confirm(v)
    adx,ema = adx_ema(h,l,c)
    years = np.array([year_of(x) for x in t])

    # regime accuracy
    fwd = max(6, int(48/(tf_min/60)))  # ~2 days forward
    acc = regime_accuracy(regime, c, fwd=fwd)

    # ---- gates ----
    # VA-trend gate: breakUp + volume confirm + above EMA200
    def g_va_trend(i): return regime[i]==1 and vc[i] and c[i]>ema[i]
    # ADX-baseline trend gate
    def g_adx_trend(i): return adx[i]>18 and c[i]>ema[i]
    # random gate matched freq to VA-trend
    rng=np.random.default_rng(42)
    va_freq = np.mean([g_va_trend(i) for i in range(200,len(c))])
    rand_mask = rng.random(len(c)) < va_freq
    def g_rand(i): return bool(rand_mask[i]) and c[i]>ema[i]

    out={}
    for name,g in [('VA-trend',g_va_trend),('ADX18',g_adx_trend),('RANDOM',g_rand)]:
        tr,yr = backtest(t,o,h,l,c,v,g,direction='trend')
        m=metrics(tr)
        # per-year
        py={}
        for Y in sorted(set(yr.tolist())):
            py[Y]=round(float(tr[yr==Y].sum()),0)
        m['per_year']=py
        # walk-forward split
        train_mask = yr<=2022; test_mask=yr>2022
        m['train']=round(float(tr[train_mask].sum()),0)
        m['test_OOS']=round(float(tr[test_mask].sum()),0)
        out[name]=m
    return acc, out, va_freq

if __name__=="__main__":
    np.seterr(all='ignore')
    assets = ['BTC','ETH','SOL']
    tf = int(sys.argv[1]) if len(sys.argv)>1 else 240
    lb = int(sys.argv[2]) if len(sys.argv)>2 else 120
    print(f"=== Volume Profile Regime Screen | TF={tf}m lookback={lb} ===\n")
    for sym in assets:
        acc,out,vaf = run_asset(sym, tf_min=tf, lookback=lb)
        print(f"\n##### {sym}  (VA-trend gate fire freq={vaf:.3f}) #####")
        print(" Regime accuracy (fwd ret):")
        for k,r in acc.items():
            if r is None: print(f"   {k}: <30 samples"); continue
            print(f"   {k:8s} n={r['n']:5d} med|move|={r['median_absmove']*100:5.2f}% "
                  f"meanFR={r['mean_fr']*100:+5.2f}% cont={r['cont_rate']}")
        print(" Gated backtest (LONG trend, $100k 1%risk, ATR 3:1.5):")
        print(f"   {'gate':10s} {'n':>5s} {'total$':>10s} {'maxDD$':>9s} {'Calmar':>7s} {'dropTop20$':>11s} {'train$':>9s} {'OOS$':>9s}")
        for name,m in out.items():
            if m['n']==0: print(f"   {name:10s}  no trades"); continue
            print(f"   {name:10s} {m['n']:5d} {m['total']:10.0f} {m['maxdd']:9.0f} {m['calmar']:7.2f} {m['dt20']:11.0f} {m['train']:9.0f} {m['test_OOS']:9.0f}")
            print(f"      per-year: {m['per_year']}")
