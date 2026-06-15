#!/usr/bin/env python3
"""
HMM Regime-Gate Test (trường phái 2: ML Regime Switching)
=========================================================
Mục tiêu: regime-classifier ML (HMM) gate rule trend-following có TĂNG accuracy
(giảm DD / sit-out regime xấu) hơn baseline ADX>18 / EMA200d / random-gate không?

HONEST-GATE:
  - Judge DOLLARS + Calmar + maxDD
  - drop-top-20%: bỏ 20% lệnh lời to nhất -> còn dương?
  - Walk-forward: FIT HMM trên train 2019-2022, áp params CỐ ĐỊNH lên test 2023-2026 (UNSEEN, cấm refit)
  - Cross-asset BTC/ETH/SOL
  - So RANDOM-gate cùng tần suất

Base rule (chung cho mọi gate): trend-following LONG trên 4h
  - entry: close > EMA50 (momentum up) -- 1 setup đơn giản, KHÔNG tự nó là alpha
  - exit: TP 12*ATR / SL 1.6*ATR (champion-style asymmetry) HOẶC flip momentum
  Gate chỉ quyết ĐƯỢC PHÉP mở lệnh long hay không tại mỗi bar.
  -> So sánh thuần tác động của REGIME-GATE, giữ entry/exit cố định.
"""
import json, os, numpy as np
from hmmlearn import hmm

np.random.seed(42)
CACHE = os.path.join(os.path.dirname(__file__), '..', '.cache')

def load(fn):
    return json.load(open(os.path.join(CACHE, fn)))

def agg(bars, tf_min):
    """Aggregate 5m bars -> tf_min bars."""
    step = tf_min // 5
    out = []
    for i in range(0, len(bars) - step + 1, step):
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

def atr(bars, n=14):
    tr = [bars[0]['high'] - bars[0]['low']]
    for i in range(1, len(bars)):
        h, l, pc = bars[i]['high'], bars[i]['low'], bars[i-1]['close']
        tr.append(max(h-l, abs(h-pc), abs(l-pc)))
    out = [None]*len(bars); s = sum(tr[:n])/n
    for i in range(len(bars)):
        if i < n: out[i] = s
        else:
            s = (s*(n-1) + tr[i]) / n; out[i] = s
    return out

def ema(vals, n):
    k = 2/(n+1); out=[vals[0]]
    for v in vals[1:]: out.append(out[-1] + k*(v-out[-1]))
    return out

def adx(bars, n=14):
    """Wilder ADX."""
    plus_dm=[0]; minus_dm=[0]; tr=[bars[0]['high']-bars[0]['low']]
    for i in range(1,len(bars)):
        up = bars[i]['high']-bars[i-1]['high']
        dn = bars[i-1]['low']-bars[i]['low']
        plus_dm.append(up if (up>dn and up>0) else 0)
        minus_dm.append(dn if (dn>up and dn>0) else 0)
        h,l,pc = bars[i]['high'],bars[i]['low'],bars[i-1]['close']
        tr.append(max(h-l,abs(h-pc),abs(l-pc)))
    def smooth(x):
        out=[None]*len(x); s=sum(x[:n])
        for i in range(len(x)):
            if i<n: out[i]=s
            else: s = s - s/n + x[i]; out[i]=s
        return out
    str_=smooth(tr); spdm=smooth(plus_dm); smdm=smooth(minus_dm)
    pdi=[]; mdi=[]
    for i in range(len(bars)):
        t = str_[i] if str_[i] else 1e-9
        pdi.append(100*spdm[i]/t); mdi.append(100*smdm[i]/t)
    dx=[]
    for i in range(len(bars)):
        s = pdi[i]+mdi[i]; s = s if s else 1e-9
        dx.append(100*abs(pdi[i]-mdi[i])/s)
    out=[None]*len(bars); s=sum(dx[:n])/n
    for i in range(len(bars)):
        if i<n: out[i]=s
        else: s=(s*(n-1)+dx[i])/n; out[i]=s
    return out

def year_of(ms):
    import datetime
    return datetime.datetime.utcfromtimestamp(ms/1000).year

# ---------------- feature build for HMM ----------------
def build_features(bars):
    closes=[b['close'] for b in bars]
    a=atr(bars)
    e50=ema(closes,50); e200=ema(closes,200)
    feats=[]
    for i in range(len(bars)):
        if i<1:
            feats.append([0,0,0]); continue
        ret=np.log(closes[i]/closes[i-1])
        vol=a[i]/closes[i]                       # ATR%
        slope=(e50[i]-e200[i])/closes[i]         # trend slope (EMA spread)
        feats.append([ret, vol, slope])
    return np.array(feats)

# ---------------- base trend rule ----------------
def run_rule(bars, gate_allows, tp_mult=12.0, sl_mult=1.6):
    """gate_allows[i] = bool: được phép mở long tại bar i.
       Returns list of trade pnl (per $ of notional move, sizing eq qty=1)."""
    closes=[b['close'] for b in bars]
    a=atr(bars); e50=ema(closes,50)
    trades=[]; eq=[0.0]; pos=None
    for i in range(200, len(bars)-1):
        price=closes[i]
        if pos is None:
            if gate_allows[i] and closes[i]>e50[i] and closes[i-1]<=e50[i-1]:
                pos={'entry':price,'tp':price+tp_mult*a[i],'sl':price-sl_mult*a[i],'i':i}
        else:
            hi=bars[i]['high']; lo=bars[i]['low']
            exit_p=None
            if lo<=pos['sl']: exit_p=pos['sl']
            elif hi>=pos['tp']: exit_p=pos['tp']
            elif closes[i]<e50[i]: exit_p=price
            if exit_p is not None:
                pnl=(exit_p-pos['entry'])/pos['entry'] - 0.0008  # ~fee+slip both sides
                trades.append(pnl); eq.append(eq[-1]+pnl); pos=None
    return trades, eq

def metrics(trades):
    if not trades: return dict(n=0,total=0,calmar=0,maxdd=0,drop20=0)
    arr=np.array(trades); cum=np.cumsum(arr)
    peak=np.maximum.accumulate(cum); dd=cum-peak; maxdd=-dd.min()
    total=cum[-1]
    yrs=7
    cagr=total/yrs
    calmar=cagr/maxdd if maxdd>1e-9 else 0
    k=max(1,int(len(arr)*0.2))
    drop20=np.sort(arr)[:-k].sum() if len(arr)>k else 0
    return dict(n=len(arr),total=total,calmar=calmar,maxdd=maxdd,drop20=drop20)

# ---------------- gates ----------------
def gate_hmm_states(feats, model, good_states):
    states=model.predict(feats)
    return [s in good_states for s in states], states

def main():
    assets={
      'BTC':'binance-5m-7y.json',
      'ETH':'binance-eth-5m-7y.json',
      'SOL':'binance-sol-5m-3y.json',
    }
    results={}
    for name,fn in assets.items():
        print(f"\n===== {name} =====")
        raw=load(fn)
        bars=agg(raw,240)  # 4h
        feats=build_features(bars)
        closes=[b['close'] for b in bars]
        e200=ema(closes,200); adxv=adx(bars); a=atr(bars)
        years=[year_of(b['time']) for b in bars]

        # ---- WALK-FORWARD: train HMM on first ~57% bars, fixed params on rest ----
        n=len(bars)
        split=int(n*0.57)  # ~2019-2022 for BTC/ETH
        # standardize using TRAIN stats only
        mu=feats[1:split].mean(axis=0); sd=feats[1:split].std(axis=0)+1e-9
        ftr=(feats-mu)/sd
        model=hmm.GaussianHMM(n_components=3, covariance_type='diag',
                              n_iter=200, random_state=42)
        model.fit(ftr[1:split])
        # identify "good" (trend-up) state on TRAIN: highest mean slope+ret
        means=model.means_  # [state x [ret,vol,slope]]
        # good = state with positive ret & positive slope (trend up bull)
        score=means[:,0]+means[:,2]  # ret+slope
        good_states={int(np.argmax(score))}
        # allow top-state only (sit out chop/down)
        print(f"  HMM means(ret,vol,slope): {np.round(means,4).tolist()} good={good_states}")

        gate_all=[True]*len(bars)
        gate_hmm,states=gate_hmm_states(ftr,model,good_states)
        gate_adx=[ (adxv[i] is not None and adxv[i]>18) for i in range(len(bars))]
        gate_ema=[ closes[i]>e200[i] for i in range(len(bars))]
        # random gate matching HMM frequency
        freq=np.mean(gate_hmm)
        rng=np.random.RandomState(7)
        gate_rnd=[ rng.rand()<freq for _ in range(len(bars))]

        gates={'ALL(no-gate)':gate_all,'HMM':gate_hmm,'ADX>18':gate_adx,
               'EMA200d':gate_ema,'RANDOM':gate_rnd}

        res={}
        # full-period metrics + per-trade year tag for walk-forward split
        for gname,g in gates.items():
            trades,eq=run_rule(bars,g)
            # recompute trades with year tag for WF
            res[gname]=metrics(trades)
            # walk-forward: trades only in test window (bar index>=split)
            tw=run_trades_window(bars,g,split)
            res[gname]['wf_test']=metrics(tw)['total']
            res[gname]['freq']=np.mean(g)
        results[name]=res
        print_table(name,res)
    print_cross(results)

def run_trades_window(bars,gate_allows,split,tp_mult=12.0,sl_mult=1.6):
    closes=[b['close'] for b in bars]; a=atr(bars); e50=ema(closes,50)
    trades=[]; pos=None
    for i in range(200,len(bars)-1):
        price=closes[i]
        if pos is None:
            if gate_allows[i] and closes[i]>e50[i] and closes[i-1]<=e50[i-1] and i>=split:
                pos={'entry':price,'tp':price+tp_mult*a[i],'sl':price-sl_mult*a[i]}
        else:
            hi=bars[i]['high']; lo=bars[i]['low']; exit_p=None
            if lo<=pos['sl']: exit_p=pos['sl']
            elif hi>=pos['tp']: exit_p=pos['tp']
            elif closes[i]<e50[i]: exit_p=price
            if exit_p is not None:
                trades.append((exit_p-pos['entry'])/pos['entry']-0.0008); pos=None
    return trades

def print_table(name,res):
    print(f"  {'gate':<14}{'n':>5}{'total%':>9}{'Calmar':>8}{'maxDD%':>8}{'drop20%':>9}{'WFtest%':>9}{'freq':>6}")
    for g,m in res.items():
        print(f"  {g:<14}{m['n']:>5}{m['total']*100:>9.1f}{m['calmar']:>8.2f}"
              f"{m['maxdd']*100:>8.1f}{m['drop20']*100:>9.1f}{m['wf_test']*100:>9.1f}{m['freq']:>6.2f}")

def print_cross(results):
    print("\n===== CROSS-ASSET SUMMARY (total% / drop20% / WFtest%) =====")
    gates=['ALL(no-gate)','HMM','ADX>18','EMA200d','RANDOM']
    print(f"  {'gate':<14}"+"".join(f"{a:>22}" for a in results))
    for g in gates:
        row=f"  {g:<14}"
        for a in results:
            m=results[a][g]
            row+=f"{m['total']*100:>7.0f}/{m['drop20']*100:>6.0f}/{m['wf_test']*100:>5.0f}"
        print(row)

if __name__=='__main__':
    main()
