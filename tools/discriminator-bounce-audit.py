#!/usr/bin/env python3
"""
HONEST AUDIT — discriminator BOUNCE vs CONTINUATION trong setup "drop sâu + oversold".

Population: mọi ngày thỏa drop từ 14D-high <= -10% AND oversold (RSI<35 hoặc StochK<25).
Label: forward d14/d30 return. bounce nếu > +THR, continuation nếu < -THR (đối xứng).
Feature đo TẠI setup (no lookahead). Đo separating power = AUC + WR-split.
Honest gate: walk-forward (train 2019-2022 / test 2023-2026) + cross-asset ETH/SOL.

Usage: python3 discriminator-bounce-audit.py
"""
import json, math
from datetime import datetime, timezone

BTC = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
ETH = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-eth-5m-7y.json"
SOL = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-sol-5m-3y.json"

# ── aggregate 5m -> 1d ──────────────────────────────────────────────────────
def agg_1d(raw):
    ms = 24*3600*1000
    bk = {}
    for b in raw:
        ts = b['time']; key = (ts//ms)*ms
        if key not in bk:
            bk[key] = [key, b['open'], b['high'], b['low'], b['close'], b['volume']]
        else:
            bk[key][2] = max(bk[key][2], b['high'])
            bk[key][3] = min(bk[key][3], b['low'])
            bk[key][4] = b['close']
            bk[key][5] += b['volume']
    return [bk[k] for k in sorted(bk)]

# ── indicators (vectorized over full series) ────────────────────────────────
def ema_series(vals, period):
    if len(vals) < period: return [None]*len(vals)
    k = 2/(period+1); out=[None]*(period-1)
    e = sum(vals[:period])/period; out.append(e)
    for v in vals[period:]:
        e = v*k + e*(1-k); out.append(e)
    return out

def rsi_series(closes, period=14):
    out=[None]*period
    if len(closes) <= period: return out
    d=[closes[i]-closes[i-1] for i in range(1,len(closes))]
    ag=sum(max(x,0) for x in d[:period])/period
    al=sum(max(-x,0) for x in d[:period])/period
    out.append(100 - 100/(1+ag/al) if al else 100.0)
    for x in d[period:]:
        ag=(ag*(period-1)+max(x,0))/period
        al=(al*(period-1)+max(-x,0))/period
        out.append(100 - 100/(1+ag/al) if al else 100.0)
    return out

def stochrsi_k_series(closes, rsi_p=14, stoch_p=14, k_s=3):
    rs = rsi_series(closes, rsi_p)
    valid_idx = [i for i,v in enumerate(rs) if v is not None]
    valid = [rs[i] for i in valid_idx]
    rawk=[None]*len(rs)
    for j in range(stoch_p-1, len(valid)):
        w=valid[j-stoch_p+1:j+1]; lo,hi=min(w),max(w)
        rawk[valid_idx[j]] = (valid[j]-lo)/(hi-lo)*100 if hi!=lo else 50
    # smooth K
    ks=[None]*len(rs)
    buf=[]
    for i in range(len(rs)):
        if rawk[i] is None:
            buf=[]; continue
        buf.append(rawk[i])
        if len(buf)>=k_s: ks[i]=sum(buf[-k_s:])/k_s
    return ks

def atr_series(bars, period=14):
    trs=[None]
    for i in range(1,len(bars)):
        h,l,pc=bars[i][2],bars[i][3],bars[i-1][4]
        trs.append(max(h-l,abs(h-pc),abs(l-pc)))
    out=[None]*len(bars)
    if len(trs) <= period: return out
    a=sum(trs[1:period+1])/period; out[period]=a
    for i in range(period+1,len(bars)):
        a=(a*(period-1)+trs[i])/period; out[i]=a
    return out

def bb_pctb_series(closes, period=20, m=2.0):
    out=[None]*len(closes)
    for i in range(period-1,len(closes)):
        w=closes[i-period+1:i+1]; mid=sum(w)/period
        std=(sum((x-mid)**2 for x in w)/period)**0.5
        up,lo=mid+m*std,mid-m*std
        out[i]=(closes[i]-lo)/(up-lo) if up!=lo else 0.5
    return out

# ── build population for one asset ──────────────────────────────────────────
def build_pop(bars, label_thr, horizon):
    closes=[b[4] for b in bars]
    rsi=rsi_series(closes,14)
    stk=stochrsi_k_series(closes)
    ema200=ema_series(closes,200)
    ema50=ema_series(closes,50)
    atr=atr_series(bars,14)
    bbpb=bb_pctb_series(closes,20)
    W=14
    pop=[]
    for i in range(max(W,200), len(bars)-horizon):
        h14=max(b[2] for b in bars[i-W:i+1])
        l14=min(b[3] for b in bars[i-W:i+1])
        close=closes[i]
        drop=(close-h14)/h14*100
        if drop > -10: continue
        r=rsi[i]; k=stk[i]
        if r is None: continue
        oversold = (r<35) or (k is not None and k<25)
        if not oversold: continue
        # forward
        fwd=(closes[i+horizon]-close)/close*100
        if abs(fwd) < label_thr: continue   # neutral, skip for clean binary
        y = 1 if fwd > 0 else 0  # 1=bounce
        # ── features at setup (no lookahead) ──
        e200=ema200[i]; e50=ema50[i]
        feat={}
        feat['regime_above_ema200'] = 1.0 if (e200 and close>e200) else 0.0
        feat['ema200_gap_pct'] = (close-e200)/e200*100 if e200 else 0.0
        feat['ema50_gap_pct'] = (close-e50)/e50*100 if e50 else 0.0
        feat['rsi'] = r
        feat['rsi_slope'] = (r - rsi[i-3]) if rsi[i-3] is not None else 0.0
        feat['stochk'] = k if k is not None else 50.0
        feat['bb_pctb'] = bbpb[i] if bbpb[i] is not None else 0.5
        feat['atr_pct'] = (atr[i]/close*100) if atr[i] else 0.0
        vols=[b[5] for b in bars[i-20:i]]
        feat['vol_ratio'] = bars[i][5]/(sum(vols)/len(vols)) if vols and sum(vols)>0 else 1.0
        # red streak
        cnt=0
        for b in reversed(bars[max(0,i-30):i+1]):
            if b[4] < b[1]: cnt+=1
            else: break
        feat['red_streak']=cnt
        # position in 14d range
        feat['pos_in_range'] = (close-l14)/(h14-l14)*100 if h14!=l14 else 50.0
        feat['drop_mag']=drop
        # drop duration: bars since 14d-peak
        peak_i=max(range(i-W,i+1), key=lambda j: bars[j][2])
        feat['drop_duration']=i-peak_i
        # weekly trend: close vs close 7d ago
        feat['weekly_ret'] = (close-closes[i-7])/closes[i-7]*100 if i>=7 else 0.0
        pop.append({'i':i,'year':datetime.fromtimestamp(bars[i][0]/1000,tz=timezone.utc).year,
                    'y':y,'fwd':fwd,'feat':feat})
    return pop

# ── AUC (Mann-Whitney) ──────────────────────────────────────────────────────
def auc(scores, labels):
    pos=[s for s,l in zip(scores,labels) if l==1]
    neg=[s for s,l in zip(scores,labels) if l==0]
    if not pos or not neg: return None
    # rank-based
    paired=sorted(zip(scores,labels))
    # count concordant
    n=len(scores); ranks={}
    sv=sorted(scores)
    # use simple O(n^2) (n small)
    c=0
    for p in pos:
        for ng in neg:
            if p>ng: c+=1
            elif p==ng: c+=0.5
    return c/(len(pos)*len(neg))

FEATURES=['regime_above_ema200','ema200_gap_pct','ema50_gap_pct','rsi','rsi_slope',
          'stochk','bb_pctb','atr_pct','vol_ratio','red_streak','pos_in_range',
          'drop_mag','drop_duration','weekly_ret']

def auc_for_feature(pop, fname):
    sc=[p['feat'][fname] for p in pop]
    lb=[p['y'] for p in pop]
    a=auc(sc,lb)
    if a is None: return None
    # orient so AUC>=0.5 (report directed AUC kept as-is to check OOS sign consistency)
    return a

def base_rate(pop):
    n=len(pop); b=sum(p['y'] for p in pop)
    return b,n

def run(asset_name, bars, thr, horizon):
    pop=build_pop(bars,thr,horizon)
    train=[p for p in pop if p['year']<=2022]
    test =[p for p in pop if p['year']>=2023]
    print(f"\n### {asset_name}  d{horizon} thr±{thr}%  n_total={len(pop)}  train={len(train)} test={len(test)}")
    if len(train)<15 or len(test)<15:
        print("  (mẫu quá nhỏ cho walk-forward)");
    btr=base_rate(train); bte=base_rate(test)
    print(f"  base-rate bounce: train {btr[0]}/{btr[1]}={btr[0]/btr[1]*100:.0f}%  test {bte[0]}/{bte[1]}={bte[0]/bte[1]*100:.0f}%" if btr[1] and bte[1] else "  base-rate n/a")
    rows=[]
    for f in FEATURES:
        atr_=auc_for_feature(train,f) if len(train)>5 else None
        ate=auc_for_feature(test,f) if len(test)>5 else None
        rows.append((f,atr_,ate))
    return pop,train,test,rows

def fmt(a): return f"{a:.3f}" if a is not None else "  -  "

if __name__=='__main__':
    print("Loading caches...")
    btc=agg_1d(json.load(open(BTC)))
    eth=agg_1d(json.load(open(ETH)))
    sol=agg_1d(json.load(open(SOL)))
    print(f"days BTC={len(btc)} ETH={len(eth)} SOL={len(sol)}")

    for horizon in (14,30):
        for thr in (3,):  # symmetric neutral band ±3%
            poB,trB,teB,rowsB=run("BTC",btc,thr,horizon)
            poE,_,_,rowsE=run("ETH",eth,thr,horizon)
            poS,_,_,rowsS=run("SOL",sol,thr,horizon)
            # cross-asset full-period AUC (SOL only 3y, use full)
            eauc={f:auc_for_feature(poE,f) for f in FEATURES}
            sauc={f:auc_for_feature(poS,f) for f in FEATURES}
            print(f"\n{'='*92}\nDISCRIMINATOR TABLE  horizon=d{horizon}  (AUC>0.5 = feature-HIGH favors bounce)")
            print(f"{'feature':<22}{'AUCtrain':>9}{'AUCtest':>9}{'ETHfull':>9}{'SOLfull':>9}  verdict")
            print('-'*92)
            for (f,atr_,ate),_ in zip(rowsB,rowsB):
                ea=eauc[f]; sa=sauc[f]
                verdict="noise"
                if atr_ and ate:
                    # real: train and test same side >0.55, and ETH same side
                    tr_side=1 if atr_>0.5 else -1
                    te_side=1 if ate>0.5 else -1
                    strong = abs(atr_-0.5)>0.05 and abs(ate-0.5)>0.05
                    eth_ok = ea is not None and ((ea>0.5)==(atr_>0.5))
                    if tr_side==te_side and strong and eth_ok:
                        verdict="REAL?"
                    elif tr_side==te_side and strong:
                        verdict="BTC-only"
                print(f"{f:<22}{fmt(atr_):>9}{fmt(ate):>9}{fmt(ea):>9}{fmt(sa):>9}  {verdict}")
