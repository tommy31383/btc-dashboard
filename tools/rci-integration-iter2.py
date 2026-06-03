#!/usr/bin/env python3
"""
rci-integration-iter2.py — RCI INTEGRATION iteration 2.

Iter1 bug: composite RCI scaled ~16x too hot (RCI>4.0 fired 420x/3y vs the
precision-study regime funding>0.0005 firing 26x/3y ~ 8.7/yr).

Iter2:
  Task1 — Recalibrate composite RCI: find threshold matching rare-extreme regime
          (top ~2-5% of bars = funding>0.0005 frequency).
  Task2 — PURE FUNDING skip-entry filter (the real 64% edge): hedge01 breakout
          fires AND funding>0.05% → SKIP new LONG (don't buy into crowding).
  Task3 — Funding size-down: funding>0.03% → half size; funding>0.05% → skip.
  Task4 — Funding turtle exit: exit turtle LONG when funding>0.05%.

Judge Sharpe + DOLLARS. Window = 3y (funding available). hedge01 v0.4.75 config.
"""
import json, datetime, math
from collections import defaultdict

CACHE   = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FUNDING = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-funding-3y.json"
FEE = 0.05 / 100
H4  = 4 * 3600 * 1000

# ─── hedge01 live v0.4.75 config ──────────────────────────────────
SL_INIT=3.0; SL_TRAIL=3.5; SL_TRANS=16; ADX_P=14
ADX_THRESH=18; ADX_THRESH_P=12; VOL_MA=16; VOL_MULT=1.4
ATR_PCT_LB=90; ATR_PCT_PCTL=0.50; DONCHIAN_LB=18; ATR_BREAK_MULT=1.3
EMA_FAST=50; EMA_SLOW=200; MAX_HOLD=200; SKIP_SHORT=True
CD={"S12":36,"S13":1,"S14":36}

# funding thresholds (precision study)
FUND_HOT  = 0.0005   # 0.05%/8h — crowded LONGs, top likely (skip)
FUND_WARM = 0.0003   # 0.03%/8h — elevated (half size)


def load_tf(raw, ms):
    b={}
    for c in raw:
        k=c["time"]//ms
        if k not in b:
            b[k]={"time":k*ms,"open":c["open"],"high":c["high"],"low":c["low"],"close":c["close"],"volume":c["volume"]}
        else:
            o=b[k]; o["high"]=max(o["high"],c["high"]); o["low"]=min(o["low"],c["low"]); o["close"]=c["close"]; o["volume"]+=c["volume"]
    return [b[k] for k in sorted(b)]

def ema_s(xs,n):
    k=2/(n+1); out=[None]*len(xs); e=None
    for i,x in enumerate(xs):
        if x is None: out[i]=e; continue
        e=x if e is None else x*k+e*(1-k); out[i]=e
    return out

def _dm_tr(bars):
    n=len(bars); pdm=[0.0]*n; ndm=[0.0]*n; tr=[0.0]*n
    for i in range(1,n):
        up=bars[i]["high"]-bars[i-1]["high"]; dn=bars[i-1]["low"]-bars[i]["low"]
        pdm[i]=up if up>dn and up>0 else 0; ndm[i]=dn if dn>up and dn>0 else 0
        tr[i]=max(bars[i]["high"]-bars[i]["low"],abs(bars[i]["high"]-bars[i-1]["close"]),abs(bars[i]["low"]-bars[i-1]["close"]))
    return pdm,ndm,tr

def adx_wilder(bars,period=ADX_P):
    pdm,ndm,tr=_dm_tr(bars); n=len(bars)
    if n<=period+1: return [None]*n
    smTR=sum(tr[1:period+1]); smP=sum(pdm[1:period+1]); smN=sum(ndm[1:period+1])
    dx_arr=[]; adx=None; out=[None]*n
    for i in range(period+1,n):
        smTR=smTR-smTR/period+tr[i]; smP=smP-smP/period+pdm[i]; smN=smN-smN/period+ndm[i]
        pdi=smP/smTR*100 if smTR>0 else 0; ndi=smN/smTR*100 if smTR>0 else 0
        dx=abs(pdi-ndi)/(pdi+ndi)*100 if (pdi+ndi)>0 else 0
        dx_arr.append(dx)
        if len(dx_arr)<period: continue
        elif len(dx_arr)==period: adx=sum(dx_arr)/period
        else: adx=(adx*(period-1)+dx)/period
        out[i]=adx
    return out

def atr_series(bars,period=ADX_P):
    _,_,tr=_dm_tr(bars); n=len(bars); atr=[None]*n
    atr[period]=sum(tr[1:period+1])/period
    for i in range(period+1,n): atr[i]=(atr[i-1]*(period-1)+tr[i])/period
    return atr

def rsi_series(closes,p=14):
    n=len(closes); out=[None]*n
    if n<=p: return out
    g=l=0
    for i in range(1,p+1):
        d=closes[i]-closes[i-1]; g+=max(d,0); l+=max(-d,0)
    ag=g/p; al=l/p
    out[p]=100-100/(1+ag/al) if al>0 else 100
    for i in range(p+1,n):
        d=closes[i]-closes[i-1]; ag=(ag*(p-1)+max(d,0))/p; al=(al*(p-1)+max(-d,0))/p
        out[i]=100-100/(1+ag/al) if al>0 else 100
    return out

def stoch_k(bars,p=14):
    n=len(bars); out=[None]*n
    for i in range(p-1,n):
        lo=min(b["low"] for b in bars[i-p+1:i+1]); hi=max(b["high"] for b in bars[i-p+1:i+1])
        rng=hi-lo; out[i]=100*(bars[i]["close"]-lo)/rng if rng>0 else 50
    return out

def bb_pctb(closes,p=20,mult=2.0):
    n=len(closes); out=[None]*n
    for i in range(p-1,n):
        w=closes[i-p+1:i+1]; m=sum(w)/p; sd=(sum((x-m)**2 for x in w)/p)**0.5
        up=m+mult*sd; dn=m-mult*sd; rng=up-dn
        out[i]=(closes[i]-dn)/rng if rng>0 else 0.5
    return out

def macd_hist(closes,fast=12,slow=26,sig=9):
    ef=ema_s(closes,fast); es=ema_s(closes,slow); ml=[None]*len(closes)
    for i in range(len(closes)):
        if ef[i] is not None and es[i] is not None: ml[i]=ef[i]-es[i]
    sl=ema_s(ml,sig); h=[None]*len(closes)
    for i in range(len(closes)):
        if ml[i] is not None and sl[i] is not None: h[i]=ml[i]-sl[i]
    return h

def regime_persist(bars1d,persist_n=3):
    cs=[b["close"] for b in bars1d]; n=len(bars1d); raw=["RANGE"]*n
    for i in range(200,n):
        ma200=sum(cs[i-199:i+1])/200; ma50=sum(cs[i-50:i+1])/50
        r20=bars1d[i-19:i+1]; ar=sum((b["high"]-b["low"])/b["close"] for b in r20)/20
        if cs[i]<ma200: raw[i]="BEAR"
        elif cs[i]>ma50 and ma50>ma200 and ar>0.04: raw[i]="BULL"
    out=["RANGE"]*n; cur="RANGE"; cnt=0; lastr="RANGE"
    for i in range(n):
        r=raw[i]
        if r==lastr: cnt+=1
        else: cnt=1; lastr=r
        if cnt>=persist_n: cur=r
        out[i]=cur
    return out


def main():
    print("Loading data...")
    raw=json.load(open(CACHE)); raw.sort(key=lambda x:x["time"])
    fund=json.load(open(FUNDING)); fund.sort(key=lambda x:x["time"])
    fund=[f for f in fund if f["rate"] is not None]
    fund_start=fund[0]["time"]; fund_end=fund[-1]["time"]

    bars4h=load_tf(raw,H4); bars1h=load_tf(raw,3600*1000); bars1d=load_tf(raw,86400*1000)
    n=len(bars4h); c4=[b["close"] for b in bars4h]

    e50=ema_s(c4,EMA_FAST); e200=ema_s(c4,EMA_SLOW)
    atr4=atr_series(bars4h); adx4=adx_wilder(bars4h)
    e200_1h=ema_s([b["close"] for b in bars1h],200); h1t=[b["time"] for b in bars1h]
    rsi4=rsi_series(c4,14); stk4=stoch_k(bars4h,14); bb4=bb_pctb(c4,20); mh4=macd_hist(c4)
    c1=[b["close"] for b in bars1h]; rsi1=rsi_series(c1,14); stk1=stoch_k(bars1h,14)

    regime_1d=regime_persist(bars1d); reg_map={}
    for i,b in enumerate(bars1d): reg_map[b["time"]//86400000]=regime_1d[i]
    def get_reg(ts): return reg_map.get(ts//86400000,"RANGE")

    ftimes=[f["time"] for f in fund]; frates=[f["rate"] for f in fund]
    def funding_at(ts):
        lo,hi,idx=0,len(ftimes)-1,-1
        while lo<=hi:
            m=(lo+hi)//2
            if ftimes[m]<=ts: idx=m; lo=m+1
            else: hi=m-1
        return frates[idx] if idx>=0 else None
    def h1_idx(ts):
        lo,hi,idx=0,len(h1t)-1,0
        while lo<=hi:
            m=(lo+hi)//2
            if h1t[m]<=ts: idx=m; lo=m+1
            else: hi=m-1
        return idx

    # ─── composite RCI v3 (same formula as iter1) ───
    def rci_raw_at(i):
        ts=bars4h[i]["time"]; score=0.0
        fr=funding_at(ts)
        if fr is not None: score+=(fr/0.0005)*2.0
        if rsi4[i] is not None: score+=((rsi4[i]-50)/20.0)*1.5
        h1i=h1_idx(ts)
        if rsi1[h1i] is not None: score+=((rsi1[h1i]-50)/20.0)*1.5*0.5
        if stk4[i] is not None: score+=((stk4[i]-50)/40.0)*0.8
        if stk1[h1i] is not None: score+=((stk1[h1i]-50)/40.0)*0.8*0.5
        if bb4[i] is not None: score+=((bb4[i]-0.5)*2.0)*0.8
        return score
    rci_raw=[None]*n
    for i in range(250,n): rci_raw[i]=rci_raw_at(i)
    rci=[None]*n; e=None; k=2/(3+1)
    for i in range(n):
        if rci_raw[i] is None: continue
        e=rci_raw[i] if e is None else rci_raw[i]*k+e*(1-k); rci[i]=e

    # ════════════════════════════════════════════════════════════════
    # TASK 1 — RECALIBRATE composite RCI
    # ════════════════════════════════════════════════════════════════
    print("\n"+"="*78); print("TASK 1 — RECALIBRATE composite RCI to rare-extreme regime"); print("="*78)
    valid=[rci[i] for i in range(n) if rci[i] is not None and fund_start<=bars4h[i]["time"]<=fund_end]
    valid.sort(); vn=len(valid)
    fr3=sorted(frates)
    target_per_yr = sum(1 for r in fr3 if r>FUND_HOT)/3.0
    print(f"  Composite RCI over funding window: n={vn} bars")
    print(f"  Precision-study regime (funding>0.05%) fires {sum(1 for r in fr3 if r>FUND_HOT)}x/3y = {target_per_yr:.1f}/yr")
    print(f"  → want RCI threshold firing ~5-15/yr = top ~{(1-(1-target_per_yr*3/vn))*100:.1f}% of bars\n")
    print(f"  {'pctl':>6} {'RCI_thr':>9} {'fires/3y':>9} {'fires/yr':>9}")
    recal_thr=None
    for p in [0.95,0.97,0.98,0.99,0.992,0.995,0.997,0.998,0.999]:
        t=valid[min(int(vn*p),vn-1)]
        cnt=sum(1 for v in valid if v>=t); fy=cnt/3
        mark=""
        if 5<=fy<=15 and recal_thr is None: recal_thr=t; mark="  <-- MATCH (5-15/yr)"
        print(f"  {p*100:>5.1f}% {t:>9.2f} {cnt:>9} {fy:>9.1f}{mark}")
    # exact threshold to fire ~target_per_yr/yr
    want_cnt=int(round(target_per_yr*3))
    exact_thr=valid[max(0,vn-want_cnt)]
    print(f"\n  iter1 used RCI>4.0 → fires {sum(1 for v in valid if v>4.0)}x/3y = {sum(1 for v in valid if v>4.0)/3:.0f}/yr (MISCALIBRATED, ~16x too hot)")
    print(f"  RECALIBRATED: RCI>{exact_thr:.2f} fires ~{want_cnt}x/3y = {want_cnt/3:.1f}/yr (matches funding>0.05% regime)")
    print(f"  Approx percentile of recalibrated threshold: {(1-want_cnt/vn)*100:.2f}%")

    # ─── shared hedge01 helpers ───
    def atp(i):
        if atr4[i] is None: return None
        return atr4[i]/c4[i]
    def atp_pass(i):
        if i<ATR_PCT_LB+14: return False
        vs=[atp(j) for j in range(i-ATR_PCT_LB,i) if atp(j) is not None]
        if len(vs)<ATR_PCT_LB: return False
        cur=atp(i)
        if cur is None: return False
        return cur>=sorted(vs)[int(len(vs)*ATR_PCT_PCTL)]
    def vol_pass(i):
        if i<VOL_MA: return False
        ma=sum(bars4h[j]["volume"] for j in range(i-VOL_MA,i))/VOL_MA
        return bars4h[i]["volume"]>=ma*VOL_MULT
    def e200_1h_at(ts): return e200_1h[h1_idx(ts)]
    def filt(i,side,allowed_regimes):
        adv=adx4[i]
        if adv is None or adv<=ADX_THRESH: return False
        advp=adx4[i-1] if i>=1 else None
        if advp is None or advp<=ADX_THRESH_P: return False
        e1h=e200_1h_at(bars4h[i]["time"])
        if e1h is None: return False
        if side=="LONG" and c4[i]<e1h: return False
        if not atp_pass(i): return False
        reg=get_reg(bars4h[i]["time"])
        if reg not in allowed_regimes: return False
        return True
    def sig_s12(i):
        if None in (e50[i],e200[i]) or i<1: return None
        if None in (e50[i-1],e200[i-1]): return None
        if e50[i-1]<=e200[i-1] and e50[i]>e200[i]: return "LONG"
        if e50[i-1]>e200[i-1] and e50[i]<=e200[i]: return "SHORT"
        return None
    def sig_s13(i):
        if atr4[i] is None or i<1: return None
        if c4[i]>bars4h[i-1]["close"]+atr4[i]*ATR_BREAK_MULT: return "LONG"
        if c4[i]<bars4h[i-1]["close"]-atr4[i]*ATR_BREAK_MULT: return "SHORT"
        return None
    def sig_s14(i):
        if i<DONCHIAN_LB: return None
        hi=max(bars4h[j]["high"] for j in range(i-DONCHIAN_LB,i))
        lo=min(bars4h[j]["low"] for j in range(i-DONCHIAN_LB,i))
        if c4[i]>hi: return "LONG"
        if c4[i]<lo: return "SHORT"
        return None
    sigs={"S12":sig_s12,"S13":sig_s13,"S14":sig_s14}
    do_vol={"S12":False,"S13":True,"S14":True}

    def sim(ei,side):
        ep=c4[ei]; ae=atr4[ei]
        if ae is None or ae<=0: return None
        sl=ep-ae*SL_INIT if side=="LONG" else ep+ae*SL_INIT
        hwm=ep
        for h in range(1,MAX_HOLD+1):
            j=ei+h
            if j>=n: break
            mult=SL_INIT if h<SL_TRANS else SL_TRAIL
            if side=="LONG":
                if c4[j]>hwm: hwm=c4[j]; sl=hwm-ae*mult
                elif h>=SL_TRANS:
                    t=hwm-ae*SL_TRAIL
                    if t>sl: sl=t
                if bars4h[j]["low"]<=sl: return (sl-ep)/ep-2*FEE,h,"SL"
            else:
                if c4[j]<hwm: hwm=c4[j]; sl=hwm+ae*mult
                elif h>=SL_TRANS:
                    t=hwm+ae*SL_TRAIL
                    if t<sl: sl=t
                if bars4h[j]["high"]>=sl: return (ep-sl)/ep-2*FEE,h,"SL"
        j=min(ei+MAX_HOLD,n-1)
        r=(c4[j]-ep)/ep if side=="LONG" else (ep-c4[j])/ep
        return r-2*FEE,MAX_HOLD,"MAXHOLD"

    # run engine with funding entry policy: 'none' | 'skip' | 'sizedown'
    def run(fund_policy="none"):
        trades=[]; last={s:{"LONG":0,"SHORT":0} for s in ["S12","S13","S14"]}
        skipped=0; halved=0
        for i in range(250,n-MAX_HOLD):
            ts=bars4h[i]["time"]
            if ts<fund_start or ts>fund_end: continue
            for sn in ["S12","S13","S14"]:
                sig=sigs[sn](i)
                if sig is None: continue
                if SKIP_SHORT and sig=="SHORT": continue
                if i-last[sn][sig]<CD[sn]: continue
                if do_vol[sn] and not vol_pass(i): continue
                if not filt(i,sig,{"RANGE"}): continue
                # funding policy applies to NEW LONG entries only
                size=1.0
                fr=funding_at(ts)
                if sig=="LONG" and fr is not None:
                    if fund_policy=="skip" and fr>FUND_HOT:
                        skipped+=1; last[sn][sig]=i; continue
                    if fund_policy=="sizedown":
                        if fr>FUND_HOT: skipped+=1; last[sn][sig]=i; continue
                        elif fr>FUND_WARM: size=0.5; halved+=1
                r=sim(i,sig)
                if r is None: continue
                ret,h,reason=r
                yr=datetime.datetime.utcfromtimestamp(ts/1000).year
                trades.append({"ret":ret*size,"raw_ret":ret,"size":size,"h":h,"yr":yr,
                               "side":sig,"setup":sn,"regime":get_reg(ts),"exit":reason,"bar":i,
                               "funding":fr})
                last[sn][sig]=i
        return trades,skipped,halved

    def stats(trades,label,capital=100000,silent=False):
        if not trades:
            if not silent: print(f"\n[{label}] NO TRADES")
            return None
        rets=[t["ret"] for t in trades]; nt=len(rets); mean=sum(rets)/nt
        sd=(sum((r-mean)**2 for r in rets)/nt)**0.5 or 1e-9; ra=mean/sd
        yrs=len(set(t["yr"] for t in trades)); sharpe_ann=ra*math.sqrt(nt/max(yrs,1))
        wr=sum(1 for r in rets if r>0)/nt*100
        wins=[r for r in rets if r>0]; losses=[r for r in rets if r<=0]
        avgw=sum(wins)/len(wins)*100 if wins else 0; avgl=sum(losses)/len(losses)*100 if losses else 0
        roi=sum(rets)*100; dollars=capital*sum(rets)
        eq=0; peak=0; mdd=0
        for t in sorted(trades,key=lambda x:x["bar"]):
            eq+=t["ret"]; peak=max(peak,eq); mdd=max(mdd,peak-eq)
        by_yr=defaultdict(float)
        for t in trades: by_yr[t["yr"]]+=t["ret"]
        pos=sum(1 for v in by_yr.values() if v>0)
        yr_str=" ".join(f"{y}:{by_yr[y]*100:+.0f}%" for y in sorted(by_yr))
        if not silent:
            print(f"\n[{label}]")
            print(f"  n={nt}  RA={ra:+.3f}  Sharpe(ann)={sharpe_ann:+.2f}  WR={wr:.0f}%  avgW={avgw:+.2f}% avgL={avgl:+.2f}%")
            print(f"  ROI={roi:+.1f}%  ${dollars:+,.0f}  MaxDD={mdd*100:.1f}% (${capital*mdd:,.0f})  stab={pos}/{len(by_yr)}")
            print(f"  Per-year: {yr_str}")
        return {"n":nt,"ra":ra,"sharpe":sharpe_ann,"wr":wr,"roi":roi,"dollars":dollars,
                "mdd":mdd*100,"mdd_usd":capital*mdd,"stab":f"{pos}/{len(by_yr)}",
                "avgw":avgw,"avgl":avgl}

    print("\n"+"="*78); print("BASELINE hedge01 v0.4.75 (3y funding window, RANGE-only LONG)"); print("="*78)
    base,_,_=run("none"); rb=stats(base,"BASELINE")

    # how many baseline LONG entries had funding>0.05% / >0.03% ?
    nfh=sum(1 for t in base if t["side"]=="LONG" and t["funding"] and t["funding"]>FUND_HOT)
    nfw=sum(1 for t in base if t["side"]=="LONG" and t["funding"] and FUND_WARM<t["funding"]<=FUND_HOT)
    print(f"\n  Of {len(base)} baseline entries: {nfh} fired into funding>0.05% (crowded), {nfw} into 0.03-0.05%")
    if nfh:
        hot_trades=[t for t in base if t["side"]=="LONG" and t["funding"] and t["funding"]>FUND_HOT]
        hr=[t["ret"] for t in hot_trades]
        print(f"  Those {nfh} crowded-entry trades: avg ret {sum(hr)/len(hr)*100:+.2f}%  WR {sum(1 for r in hr if r>0)/len(hr)*100:.0f}%  total ${100000*sum(hr):+,.0f}")
    if nfw:
        warm_trades=[t for t in base if t["side"]=="LONG" and t["funding"] and FUND_WARM<t["funding"]<=FUND_HOT]
        wr_=[t["ret"] for t in warm_trades]
        print(f"  Those {nfw} elevated 0.03-0.05% trades: avg ret {sum(wr_)/len(wr_)*100:+.2f}%  WR {sum(1 for r in wr_ if r>0)/len(wr_)*100:.0f}%  total ${100000*sum(wr_):+,.0f}")

    print("\n"+"="*78); print("TASK 2 — FUNDING SKIP-ENTRY filter (funding>0.05% → skip new LONG)"); print("="*78)
    skip_t,nskip,_=run("skip"); rs=stats(skip_t,"hedge01 + SKIP-crowded-entry")
    print(f"  ({nskip} entries skipped due to funding>0.05%)")

    print("\n"+"="*78); print("TASK 3 — FUNDING SIZE-DOWN (>0.03% half, >0.05% skip)"); print("="*78)
    sd_t,nsd_skip,nsd_half=run("sizedown"); rsd=stats(sd_t,"hedge01 + SIZE-DOWN")
    print(f"  ({nsd_skip} skipped >0.05%, {nsd_half} half-sized 0.03-0.05%)")

    # ─── deltas ───
    print("\n"+"="*78); print("DELTA SUMMARY vs baseline (hedge01)"); print("="*78)
    def delta(a,b,name):
        if not a or not b: print(f"  {name}: n/a"); return
        print(f"  {name}: n {a['n']}->{b['n']}  Sharpe {a['sharpe']:+.2f}->{b['sharpe']:+.2f} ({b['sharpe']-a['sharpe']:+.2f})  "
              f"ROI {a['roi']:+.0f}%->{b['roi']:+.0f}% ({b['roi']-a['roi']:+.0f}pp)  $ {b['dollars']-a['dollars']:+,.0f}  "
              f"DD {a['mdd']:.1f}%->{b['mdd']:.1f}% ({b['mdd']-a['mdd']:+.1f}pp)  WR {a['wr']:.0f}%->{b['wr']:.0f}%")
    delta(rb,rs,"SKIP-ENTRY ")
    delta(rb,rsd,"SIZE-DOWN  ")

    print("\n"+"="*78); print("VERDICTS (hedge01)"); print("="*78)
    def verdict(rb,rx,name):
        if not rb or not rx: print(f"  {name}: n/a"); return
        sh_up=rx['sharpe']>rb['sharpe']+0.05
        dd_down=rx['mdd']<rb['mdd']-0.5
        roi_ok=rx['roi']>=rb['roi']*0.90  # ROI maintained within 10%
        acc=(sh_up or dd_down) and roi_ok
        print(f"  {name}: {'ACCEPT' if acc else 'REJECT'}  "
              f"(Sharpe {rx['sharpe']-rb['sharpe']:+.2f}, DD {rx['mdd']-rb['mdd']:+.1f}pp, ROI {rx['roi']-rb['roi']:+.0f}pp, $ {rx['dollars']-rb['dollars']:+,.0f})")
    verdict(rb,rs,"TASK2 SKIP-ENTRY")
    verdict(rb,rsd,"TASK3 SIZE-DOWN ")

    # ════════════════════════════════════════════════════════════════
    # TASK 4 — FUNDING as TURTLE exit
    # ════════════════════════════════════════════════════════════════
    print("\n"+"="*78); print("TASK 4 — FUNDING turtle exit (exit turtle LONG when funding>0.05%)"); print("="*78)
    turtle_funding_exit(bars1d, fund_start, fund_end, funding_at)

    return {"baseline":rb,"skip":rs,"sizedown":rsd,"recal_thr":exact_thr,"want_cnt":want_cnt,
            "nfh":nfh,"nfw":nfw,"nskip":nskip}


def turtle_funding_exit(bars1d, fund_start, fund_end, funding_at):
    """Daily Donchian FAST 20/10 long-only + ATR cut (turtle alpha config) with optional
       funding>0.05% exit. Restricted to 3y funding window. qty 0.003, fee, daily M2M."""
    QTY=0.003; CUT=2.0; DON_ENTRY=20; DON_EXIT=10
    BD=[b for b in bars1d]; n=len(BD); C=[x["close"] for x in BD]
    def atr_w(bars,p=14):
        m=len(bars); tr=[0.]*m
        for i in range(1,m):
            tr[i]=max(bars[i]["high"]-bars[i]["low"],abs(bars[i]["high"]-bars[i-1]["close"]),abs(bars[i]["low"]-bars[i-1]["close"]))
        o=[None]*m; o[p]=sum(tr[1:p+1])/p
        for i in range(p+1,m): o[i]=(o[i-1]*(p-1)+tr[i])/p
        return o
    atr=atr_w(BD)
    dhi_e=[None]*n; dlo_x=[None]*n
    for i in range(DON_ENTRY,n): dhi_e[i]=max(BD[j]["high"] for j in range(i-DON_ENTRY,i))
    for i in range(DON_EXIT,n): dlo_x[i]=min(BD[j]["low"] for j in range(i-DON_EXIT,i))
    WARM=max(DON_ENTRY,20)

    def run(use_funding_exit):
        pnl=[0.0]*n; holding=False; ep=0.0; eatr=0.0; nexit_f=0; ntrades=0
        for i in range(WARM,n):
            ts=BD[i]["time"]
            if ts<fund_start or ts>fund_end: continue
            if holding:
                pnl[i]=QTY*(C[i]-C[i-1]); exit_now=False; reason=""
                if use_funding_exit:
                    fr=funding_at(ts)
                    if fr is not None and fr>0.0005: exit_now=True; reason="FUND"; nexit_f+=1
                if not exit_now and CUT>0 and BD[i]["low"]<=ep-eatr*CUT: exit_now=True; reason="CUT"
                if not exit_now and dlo_x[i] is not None and C[i]<dlo_x[i]: exit_now=True; reason="DON"
                if exit_now:
                    pnl[i]-=FEE*C[i]*QTY; holding=False
            if not holding:
                if dhi_e[i] is not None and C[i]>dhi_e[i]:
                    holding=True; ep=C[i]; eatr=atr[i] or 0; pnl[i]-=FEE*C[i]*QTY; ntrades+=1
        return pnl,nexit_f,ntrades

    def stats(pnl):
        series=[pnl[i] for i in range(WARM,n) if fund_start<=BD[i]["time"]<=fund_end]
        eq=[]; s=0.0
        for x in series: s+=x; eq.append(s)
        total=s; mean=sum(series)/len(series); sd=(sum((x-mean)**2 for x in series)/len(series))**0.5 or 1e-9
        sharpe=mean/sd*math.sqrt(365)
        peak=-1e18; mdd=0.0
        for v in eq: peak=max(peak,v); mdd=max(mdd,peak-v)
        yr=defaultdict(float)
        for i in range(WARM,n):
            if fund_start<=BD[i]["time"]<=fund_end:
                y=datetime.datetime.utcfromtimestamp(BD[i]["time"]/1000).year; yr[y]+=pnl[i]
        return total,sharpe,mdd,dict(yr)

    p0,_,nt0=run(False); p1,nfe,nt1=run(True)
    t0,s0,d0,y0=stats(p0); t1,s1,d1,y1=stats(p1)
    print(f"  {'':22} | {'Total$':>9} | {'Sharpe':>7} | {'MaxDD$':>8} | trades")
    print(f"  {'turtle baseline':22} | {t0:>+9.0f} | {s0:>7.2f} | {d0:>8.0f} | {nt0}")
    print(f"  {'turtle + funding-exit':22} | {t1:>+9.0f} | {s1:>7.2f} | {d1:>8.0f} | {nt1} ({nfe} funding exits)")
    print(f"  Per-year $ (base vs fund-exit):")
    for y in sorted(set(y0)|set(y1)):
        print(f"    {y}: base {y0.get(y,0):+7.0f}  |  fund-exit {y1.get(y,0):+7.0f}")
    sh_up=s1>s0+0.05; dd_down=d1<d0*0.95; dol_ok=t1>=t0*0.90
    acc=(sh_up or dd_down) and dol_ok
    print(f"\n  TASK4 TURTLE funding-exit: {'ACCEPT' if acc else 'REJECT'}  "
          f"(Sharpe {s1-s0:+.2f}, DD ${d1-d0:+.0f}, $ {t1-t0:+.0f})")
    return {"base":(t0,s0,d0),"fundexit":(t1,s1,d1),"nfe":nfe}


if __name__=="__main__":
    main()
