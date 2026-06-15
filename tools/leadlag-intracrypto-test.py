#!/usr/bin/env python3
"""
Lead-lag NỘI-BỘ crypto: BTC có dẫn ETH/SOL vài phút (5m bar) không?
- Cross-corr có-trễ corr(BTC ret @t, ALT ret @t+k), k=1..12 (5m..1h)
- So lag-corr vs đồng-thời-corr (k=0). Lag > k=0 mới tradeable.
- Rule: BTC move >X% trong N bar -> LONG ALT bar kế. PnL sau fee taker 0.04%/side.
- drop-top-20%, walk-forward (train 2019-22 / test 2023-26), per-year.
- Granger-causality BTC->ALT.
"""
import json, numpy as np
from datetime import datetime, timezone

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache"
FEE = 0.0004  # taker/side
SLIP = 0.0002 # slippage/side est

def load(fn):
    d = json.load(open(f"{CACHE}/{fn}"))
    return {b['time']: b for b in d}

print("Loading...")
btc = load("binance-5m-7y.json")
eth = load("binance-eth-5m-7y.json")
sol = load("binance-sol-5m-3y.json")

def align(a, b):
    ts = sorted(set(a) & set(b))
    return ts

def rets(book, ts):
    c = np.array([book[t]['close'] for t in ts])
    r = np.zeros(len(c))
    r[1:] = np.log(c[1:]/c[:-1])
    return c, r

def year(t):
    return datetime.fromtimestamp(t/1000, tz=timezone.utc).year

def analyze(name, altbook):
    ts = align(btc, altbook)
    print(f"\n===== BTC -> {name} =====  aligned bars: {len(ts)}  "
          f"({year(ts[0])}..{year(ts[-1])})")
    _, rb = rets(btc, ts)
    _, ra = rets(altbook, ts)
    yrs = np.array([year(t) for t in ts])

    # 1) cross-corr lag k: corr(BTC@t, ALT@t+k)
    print(f"  lag k |   corr   | (k=0 contemp baseline)")
    c0 = np.corrcoef(rb, ra)[0,1]
    corrs = {}
    for k in range(0, 13):
        if k == 0:
            c = c0
        else:
            c = np.corrcoef(rb[:-k], ra[k:])[0,1]
        corrs[k] = c
        flag = ""
        if k>0 and c > c0: flag = "  <-- > contemp (potential lead)"
        print(f"   {k:3d}  | {c:+.4f}  {flag}")

    # 2) Granger-ish: does BTC ret improve prediction of ALT ret @t+1 beyond ALT autoreg?
    # OLS: alt[t+1] ~ alt[t] + btc[t]  vs  alt[t+1] ~ alt[t]
    x_alt = ra[:-1]; y = ra[1:]; x_btc = rb[:-1]
    # restricted
    A_r = np.column_stack([np.ones_like(x_alt), x_alt])
    beta_r,_,_,_ = np.linalg.lstsq(A_r, y, rcond=None)
    rss_r = np.sum((y - A_r@beta_r)**2)
    # full
    A_f = np.column_stack([np.ones_like(x_alt), x_alt, x_btc])
    beta_f,_,_,_ = np.linalg.lstsq(A_f, y, rcond=None)
    rss_f = np.sum((y - A_f@beta_f)**2)
    n = len(y)
    F = ((rss_r - rss_f)/1) / (rss_f/(n-3))
    print(f"  Granger BTC->{name} (1 lag): F={F:.1f}  btc_coef={beta_f[2]:+.4f}  "
          f"R2_gain={(rss_r-rss_f)/rss_r*100:.3f}%")

    # 3) Rule PnL: BTC cum-move over N bars > X% -> LONG ALT next bar, hold H bars
    print(f"  --- Rule backtest (LONG ALT after BTC surge) ---")
    cost = 2*(FEE+SLIP)  # round trip
    best = None
    for N in (1,2,3):
        # btc cum ret over trailing N bars at signal time
        btc_cum = np.copy(rb)
        if N>1:
            btc_cum = np.convolve(rb, np.ones(N), 'full')[:len(rb)]
            # btc_cum[t] = sum rb[t-N+1..t]
            btc_cum = np.array([np.sum(rb[max(0,i-N+1):i+1]) for i in range(len(rb))])
        for X in (0.003,0.005,0.008,0.012):
            for H in (1,2,3):
                # signal at t (BTC surged), enter ALT at t+1 open->t+1+H close
                sig = btc_cum > X
                idx = np.where(sig)[0]
                idx = idx[(idx+1+H) < len(ra)]
                if len(idx) < 50: continue
                # alt return from t+1 to t+1+H (use close-to-close approx via sum log rets)
                trade_ret = np.array([np.sum(ra[i+1:i+1+H+1]) for i in idx]) - cost
                pnl = trade_ret  # per-$1 notional
                tot = np.sum(pnl)
                # drop top 20%
                srt = np.sort(pnl)
                drop = np.sum(srt[:int(len(srt)*0.8)])
                # walk-forward
                tr_mask = yrs[idx] <= 2022
                te_mask = yrs[idx] >= 2023
                tr = np.sum(pnl[tr_mask]); te = np.sum(pnl[te_mask])
                rec = (tot, drop, tr, te, len(idx), N, X, H)
                if best is None or tot > best[0]:
                    best = rec
    if best:
        tot,drop,tr,te,n_,N,X,H = best
        wr = None
        print(f"    BEST cfg: N={N}bar X>{X*100:.1f}% H={H}bar  n={n_}")
        print(f"      total sumRet (after fee) = {tot*100:+.2f}% notional-units")
        print(f"      drop-top-20%             = {drop*100:+.2f}%   "
              f"{'(SỐNG)' if drop>0 else '(CHẾT - fat-tail)'}")
        print(f"      walk-forward train(<=2022)={tr*100:+.2f}%  test(>=2023)={te*100:+.2f}%")
        # per-year for best cfg
        btc_cum = np.array([np.sum(rb[max(0,i-N+1):i+1]) for i in range(len(rb))]) if N>1 else rb
        sig = btc_cum > X
        idx = np.where(sig)[0]; idx = idx[(idx+1+H)<len(ra)]
        pnl = np.array([np.sum(ra[i+1:i+1+H+1]) for i in idx]) - cost
        print(f"      per-year:")
        for y_ in sorted(set(yrs)):
            m = yrs[idx]==y_
            if m.sum()>0:
                print(f"        {y_}: n={m.sum():5d}  sumRet={np.sum(pnl[m])*100:+7.2f}%")
    return corrs, c0

analyze("ETH", eth)
analyze("SOL", sol)
print("\nDONE.")
