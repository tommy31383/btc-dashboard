#!/usr/bin/env python3
"""
Screen entry-timing ALPHA tren timeframe NGAN (1h, 15m) cho BTC + cross-asset ETH.
HONEST-GATE: medAlpha-vs-HOLD, random-null, drop-top-20%, cross-asset, walk-forward, >=3/yr, per-year.
Exit CO DINH (hold N bars) de co lap entry quality. LONG-only. Fee 0.08% round-trip + slip.
"""
import json, numpy as np
from datetime import datetime, timezone

FEE_RT = 0.0008  # 0.08% round trip
SLIP   = 0.0004  # extra slippage estimate
COST   = FEE_RT + SLIP

def load(path):
    d = json.load(open(path))
    t = np.array([x['time'] for x in d], dtype=np.int64)
    o = np.array([x['open'] for x in d]); h=np.array([x['high'] for x in d])
    l = np.array([x['low'] for x in d]);  c=np.array([x['close'] for x in d])
    v = np.array([x['volume'] for x in d])
    return t,o,h,l,c,v

def resample(t,o,h,l,c,v,group):
    n=(len(t)//group)*group
    t=t[:n].reshape(-1,group); o=o[:n].reshape(-1,group); h=h[:n].reshape(-1,group)
    l=l[:n].reshape(-1,group); c=c[:n].reshape(-1,group); v=v[:n].reshape(-1,group)
    return (t[:,0], o[:,0], h.max(1), l.min(1), c[:,-1], v.sum(1))

def years(t):
    return np.array([datetime.fromtimestamp(x/1000,tz=timezone.utc).year for x in t])

def rsi(c,p=14):
    d=np.diff(c); up=np.where(d>0,d,0); dn=np.where(d<0,-d,0)
    ru=np.zeros(len(c)); rd=np.zeros(len(c))
    ru[p]=up[:p].mean(); rd[p]=dn[:p].mean()
    for i in range(p+1,len(c)):
        ru[i]=(ru[i-1]*(p-1)+up[i-1])/p; rd[i]=(rd[i-1]*(p-1)+dn[i-1])/p
    rs=ru/(rd+1e-12); r=100-100/(1+rs); r[:p]=50; return r

def ema(c,p):
    a=2/(p+1); e=np.zeros(len(c)); e[0]=c[0]
    for i in range(1,len(c)): e[i]=a*c[i]+(1-a)*e[i-1]
    return e

def atr(h,l,c,p=14):
    tr=np.maximum(h[1:]-l[1:], np.maximum(abs(h[1:]-c[:-1]),abs(l[1:]-c[:-1])))
    a=np.zeros(len(c)); a[p]=tr[:p].mean()
    for i in range(p+1,len(c)): a[i]=(a[i-1]*(p-1)+tr[i-1])/p
    a[:p]=a[p]; return a

# trade return at fixed hold N bars, entry at close[i], exit at close[i+N]
def trade_rets(c, idx, N):
    idx=idx[idx+N < len(c)]
    entry=c[idx]; exit_=c[idx+N]
    raw=(exit_/entry)-1.0
    net=raw-COST
    # HOLD baseline over same window = same thing for buy&hold of asset -> alpha vs hold:
    # "hold" benchmark = market return over same N bars from a RANDOM/ALL-bar perspective.
    return idx, raw, net

def alpha_vs_hold(c, idx, raw, N):
    # alpha = trade raw return minus the AVERAGE N-bar forward return across all bars (the beta baseline)
    allf=(c[N:]/c[:-N])-1.0
    base=np.median(allf)  # median forward N-bar return = "hold" expectation
    return raw - base, base

def report_signal(name, c, h, l, yrs, idx, N):
    idx, raw, net = trade_rets(c, idx, N)
    if len(idx)<20: return None
    a, base = alpha_vs_hold(c, idx, raw, N)
    medAlpha = np.median(a)
    medNet   = np.median(net)
    # drop-top-20%
    srt=np.sort(net)[::-1]
    keep=srt[int(len(srt)*0.2):]
    drop20_sum=keep.sum()
    full_sum=net.sum()
    # per-year
    yidx=yrs[idx]
    yrs_u=sorted(set(yidx))
    pos_years=0; ny=0
    per_year={}
    for y in yrs_u:
        m=yidx==y
        if m.sum()<1: continue
        s=net[m].sum(); per_year[y]=(m.sum(),s)
        ny+=1
        if s>0: pos_years+=1
    n_per_yr = len(idx)/max(ny,1)
    # random-null: random entries same count, same N, median net
    rng=np.random.default_rng(42)
    rand_med=[]
    for _ in range(200):
        ridx=rng.integers(0,len(c)-N,size=len(idx))
        rr=(c[ridx+N]/c[ridx]-1.0)-COST
        rand_med.append(np.median(rr))
    rand_med=np.array(rand_med)
    beat_random = (medNet - np.median(rand_med))
    rand_pctile = (medNet > rand_med).mean()
    return dict(name=name,N=N,n=len(idx),n_per_yr=n_per_yr,medAlpha=medAlpha,medNet=medNet,
                full_sum=full_sum,drop20_sum=drop20_sum,pos_years=pos_years,ny=ny,
                beat_random=beat_random,rand_pctile=rand_pctile,per_year=per_year)

def walkforward(c,h,l,yrs,idx,N):
    # train years <=2022, test >=2023
    yidx=yrs[idx]
    tr=idx[yidx<=2022]; te=idx[yidx>=2023]
    def med(ix):
        ix=ix[ix+N<len(c)]
        if len(ix)<10: return None
        return np.median((c[ix+N]/c[ix]-1.0)-COST)
    return med(tr), med(te)

def build_signals(o,h,l,c,v):
    """Return dict name->boolean entry mask aligned to c (LONG entries)."""
    sig={}
    r=rsi(c,14)
    e50=ema(c,50); e200=ema(c,200)
    a=atr(h,l,c,14)
    n=len(c)
    # rolling helpers
    def roll_max(x,w):
        out=np.full(len(x),np.nan)
        for i in range(w,len(x)): out[i]=x[i-w:i].max()
        return out
    def roll_min(x,w):
        out=np.full(len(x),np.nan)
        for i in range(w,len(x)): out[i]=x[i-w:i].min()
        return out
    def roll_mean(x,w):
        out=np.full(len(x),np.nan)
        cs=np.cumsum(np.insert(x,0,0))
        out[w:]=(cs[w:-0 if False else len(x)]-cs[:len(x)-w])[1:] if False else np.nan
        # simpler:
        out=np.full(len(x),np.nan)
        for i in range(w,len(x)): out[i]=x[i-w:i].mean()
        return out
    def roll_std(x,w):
        out=np.full(len(x),np.nan)
        for i in range(w,len(x)): out[i]=x[i-w:i].std()
        return out

    # 1. RSI oversold bounce
    sig['rsi<30']=(r<30)
    sig['rsi<25']=(r<25)
    sig['rsi<30+up']=(r<30)&(c>o)
    # 2. Range breakout (close > prior 24-bar high)
    rh24=roll_max(h,24)
    sig['brk_hi24']=(c>rh24)
    rh48=roll_max(h,48)
    sig['brk_hi48']=(c>rh48)
    # 3. Momentum: close > ema50 cross up
    sig['ema50_xup']=(c>e50)&(np.r_[False,c[:-1]<=e50[:-1]])
    # 4. Volume spike + up candle
    vma=roll_mean(v,20)
    sig['volspike2x_up']=(v>2*vma)&(c>o)
    sig['volspike3x_up']=(v>3*vma)&(c>o)
    # 5. Bollinger lower touch (mean-reversion)
    m20=roll_mean(c,20); s20=roll_std(c,20)
    sig['bb_lower']=(c<(m20-2*s20))
    sig['bb_lower_up']=(c<(m20-2*s20))&(c>o)
    # 6. Trend + pullback: above ema200, rsi dip <40
    sig['trend_pullback']=(c>e200)&(r<40)
    sig['trend_rsi35']=(c>e200)&(r<35)
    # 7. Mean-reversion: down N bars in row
    down3=np.r_[[False]*3,[(c[i]<c[i-1] and c[i-1]<c[i-2] and c[i-2]<c[i-3]) for i in range(3,n)]]
    sig['down3bars']=down3
    # 8. ATR-normalized dip: close dropped >2*ATR below prior close
    drop=np.r_[False,(c[1:]<c[:-1]-2*a[1:])]
    sig['atr_dip2']=drop
    # 9. Breakout retest: new 48 high then close back above ema50
    sig['brk_hi24_trend']=(c>rh24)&(c>e200)
    return sig

def run_asset(path, label, group, tfname):
    t,o,h,l,c,v=load(path)
    t,o,h,l,c,v=resample(t,o,h,l,c,v,group)
    yrs=years(t)
    sig=build_signals(o,h,l,c,v)
    res={}
    Nmap={'1h':24,'15m':16}  # hold N bars (~1 day for 1h, ~4h for 15m)
    N=Nmap[tfname]
    for name,mask in sig.items():
        idx=np.where(mask)[0]
        rr=report_signal(name,c,h,l,yrs,idx,N)
        if rr is None: continue
        wf_tr,wf_te=walkforward(c,h,l,yrs,idx,N)
        rr['wf_train']=wf_tr; rr['wf_test']=wf_te
        res[name]=rr
    return res, c, h, l, yrs, N, sig

if __name__=='__main__':
    import sys
    tf=sys.argv[1] if len(sys.argv)>1 else '1h'
    group={'1h':12,'15m':3}[tf]
    print(f"=== TF={tf} (group {group} of 5m), hold N=({'24bars=1d' if tf=='1h' else '16bars=4h'}) ===\n")
    btc,cB,hB,lB,yB,N,sigB=run_asset('.cache/binance-5m-7y.json','BTC',group,tf)
    eth,cE,hE,lE,yE,_,sigE=run_asset('.cache/binance-eth-5m-7y.json','ETH',group,tf)
    print(f"{'signal':16} {'n/yr':>5} {'medAlpha%':>9} {'medNet%':>8} {'full$sum':>8} {'drop20':>8} {'pos/yr':>7} {'vsRand%':>8} {'randPct':>7} {'wfTest%':>8} | ETHmedNet% ETHdrop20")
    for name in btc:
        b=btc[name]; e=eth.get(name)
        wf=b['wf_test']
        ethnet = e['medNet']*100 if e else None
        ethdrop = e['drop20_sum'] if e else None
        d20alive = 'ALIVE' if b['drop20_sum']>0 else 'DEAD'
        print(f"{name:16} {b['n_per_yr']:5.0f} {b['medAlpha']*100:9.3f} {b['medNet']*100:8.3f} "
              f"{b['full_sum']:8.2f} {b['drop20_sum']:8.2f} {b['pos_years']:3d}/{b['ny']:<3d} "
              f"{b['beat_random']*100:8.3f} {b['rand_pctile']:7.2f} "
              f"{(wf*100 if wf is not None else float('nan')):8.3f} | "
              f"{(ethnet if ethnet is not None else float('nan')):9.3f} {d20alive} ETH:{('ALIVE' if (ethdrop and ethdrop>0) else 'DEAD')}")
