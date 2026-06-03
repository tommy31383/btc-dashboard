#!/usr/bin/env python3
"""
rci-integration-iter1.py — RCI INTEGRATION iteration 1.

Apply RCI v3 (funding + technical) to hedge01-BTC live rule (v0.4.75 config).

Task1: RCI as EXIT overlay  — holding LONG + RCI>+4.0 (BEAR_STRONG) → exit now.
Task2: RCI as ENTRY boost  — RCI<-2.5 (BULL_STRONG) + RANGE + ADX>18 → enter LONG (no breakout).
Task3: hedge01 3y baseline numbers.

Judge: Sharpe + DOLLARS. Window = 3y (funding available).
RCI v3 formula (per doc rci-indicator-research-2026-06-03):
  raw = Funding(x2.0) + RSI(x1.5) + Stoch(x0.8) + BB(x0.8) + MACD(x0.4), 4h primary + 1h secondary
  RCI = EMA(raw, 3)
"""
import json, datetime, math
from collections import defaultdict

CACHE   = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FUNDING = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-funding-3y.json"
FEE = 0.05 / 100
H4  = 4 * 3600 * 1000

# ─── hedge01 live v0.4.75 config (per task) ──────────────────────────────────
SL_INIT  = 3.0      # 3.0/3.5 trailing
SL_TRAIL = 3.5
SL_TRANS = 16       # 64h = 16 bars * 4h
ADX_P    = 14
ADX_THRESH   = 18   # ADX18/12
ADX_THRESH_P = 12   # prev-bar gate
VOL_MA   = 16
VOL_MULT = 1.4
ATR_PCT_LB = 90
ATR_PCT_PCTL = 0.50
DONCHIAN_LB  = 18   # DLB18
ATR_BREAK_MULT = 1.3
EMA_FAST = 50
EMA_SLOW = 200
MAX_HOLD = 200
SKIP_SHORT  = True
CD = {"S12": 36, "S13": 1, "S14": 36}

# RCI thresholds
RCI_BEAR_STRONG = 4.0   # exit-overlay trigger
RCI_BULL_STRONG = -2.5  # entry-boost trigger
RCI_ENTRY_ADX   = 18
CD_RCI_ENTRY    = 36    # cooldown for rci entries

START_TS = None  # set to funding window start


def load_tf(raw, ms):
    b = {}
    for c in raw:
        k = c["time"] // ms
        if k not in b:
            b[k] = {"time": k * ms, "open": c["open"], "high": c["high"],
                    "low": c["low"], "close": c["close"], "volume": c["volume"]}
        else:
            o = b[k]
            o["high"] = max(o["high"], c["high"])
            o["low"]  = min(o["low"], c["low"])
            o["close"] = c["close"]
            o["volume"] += c["volume"]
    return [b[k] for k in sorted(b)]


def ema_s(xs, n):
    k = 2 / (n + 1); out = [None] * len(xs); e = None
    for i, x in enumerate(xs):
        if x is None:
            out[i] = e; continue
        e = x if e is None else x * k + e * (1 - k)
        out[i] = e
    return out


def _dm_tr(bars):
    n = len(bars)
    pdm = [0.0]*n; ndm = [0.0]*n; tr = [0.0]*n
    for i in range(1, n):
        up = bars[i]["high"] - bars[i-1]["high"]
        dn = bars[i-1]["low"] - bars[i]["low"]
        pdm[i] = up if up > dn and up > 0 else 0
        ndm[i] = dn if dn > up and dn > 0 else 0
        tr[i] = max(bars[i]["high"]-bars[i]["low"],
                    abs(bars[i]["high"]-bars[i-1]["close"]),
                    abs(bars[i]["low"]-bars[i-1]["close"]))
    return pdm, ndm, tr


def adx_wilder(bars, period=ADX_P):
    pdm, ndm, tr = _dm_tr(bars); n = len(bars)
    if n <= period+1: return [None]*n
    smTR=sum(tr[1:period+1]); smP=sum(pdm[1:period+1]); smN=sum(ndm[1:period+1])
    dx_arr=[]; adx=None; out=[None]*n
    for i in range(period+1, n):
        smTR=smTR-smTR/period+tr[i]; smP=smP-smP/period+pdm[i]; smN=smN-smN/period+ndm[i]
        pdi=smP/smTR*100 if smTR>0 else 0; ndi=smN/smTR*100 if smTR>0 else 0
        dx=abs(pdi-ndi)/(pdi+ndi)*100 if (pdi+ndi)>0 else 0
        dx_arr.append(dx)
        if len(dx_arr)<period: continue
        elif len(dx_arr)==period: adx=sum(dx_arr)/period
        else: adx=(adx*(period-1)+dx)/period
        out[i]=adx
    return out


def atr_series(bars, period=ADX_P):
    _,_,tr=_dm_tr(bars); n=len(bars); atr=[None]*n
    atr[period]=sum(tr[1:period+1])/period
    for i in range(period+1,n):
        atr[i]=(atr[i-1]*(period-1)+tr[i])/period
    return atr


def rsi_series(closes, p=14):
    n=len(closes); out=[None]*n
    if n<=p: return out
    g=l=0
    for i in range(1,p+1):
        d=closes[i]-closes[i-1]; g+=max(d,0); l+=max(-d,0)
    ag=g/p; al=l/p
    out[p]=100-100/(1+ag/al) if al>0 else 100
    for i in range(p+1,n):
        d=closes[i]-closes[i-1]
        ag=(ag*(p-1)+max(d,0))/p; al=(al*(p-1)+max(-d,0))/p
        out[i]=100-100/(1+ag/al) if al>0 else 100
    return out


def stoch_k(bars, p=14):
    n=len(bars); out=[None]*n
    for i in range(p-1,n):
        lo=min(b["low"] for b in bars[i-p+1:i+1]); hi=max(b["high"] for b in bars[i-p+1:i+1])
        rng=hi-lo; out[i]=100*(bars[i]["close"]-lo)/rng if rng>0 else 50
    return out


def bb_pctb(closes, p=20, mult=2.0):
    n=len(closes); out=[None]*n
    for i in range(p-1,n):
        w=closes[i-p+1:i+1]; m=sum(w)/p
        sd=(sum((x-m)**2 for x in w)/p)**0.5
        up=m+mult*sd; dn=m-mult*sd; rng=up-dn
        out[i]=(closes[i]-dn)/rng if rng>0 else 0.5
    return out


def macd_hist(closes, fast=12, slow=26, sig=9):
    ef=ema_s(closes,fast); es=ema_s(closes,slow)
    ml=[None]*len(closes)
    for i in range(len(closes)):
        if ef[i] is not None and es[i] is not None: ml[i]=ef[i]-es[i]
    sl=ema_s(ml,sig)
    h=[None]*len(closes)
    for i in range(len(closes)):
        if ml[i] is not None and sl[i] is not None: h[i]=ml[i]-sl[i]
    return h


def regime_persist(bars1d, persist_n=3):
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
    raw = json.load(open(CACHE)); raw.sort(key=lambda x:x["time"])
    fund = json.load(open(FUNDING)); fund.sort(key=lambda x:x["time"])
    fund = [f for f in fund if f["rate"] is not None]
    fund_start = fund[0]["time"]
    fund_end   = fund[-1]["time"]

    bars4h = load_tf(raw, H4)
    bars1h = load_tf(raw, 3600*1000)
    bars1d = load_tf(raw, 86400*1000)
    n = len(bars4h)
    c4 = [b["close"] for b in bars4h]

    print(f"4h bars: {n}  {datetime.datetime.utcfromtimestamp(bars4h[0]['time']/1000):%Y-%m-%d} -> {datetime.datetime.utcfromtimestamp(bars4h[-1]['time']/1000):%Y-%m-%d}")
    print(f"Funding window: {datetime.datetime.utcfromtimestamp(fund_start/1000):%Y-%m-%d} -> {datetime.datetime.utcfromtimestamp(fund_end/1000):%Y-%m-%d}  ({len(fund)} entries)")

    # ─── indicators ───
    e50=ema_s(c4,EMA_FAST); e200=ema_s(c4,EMA_SLOW)
    atr4=atr_series(bars4h); adx4=adx_wilder(bars4h)
    e200_1h=ema_s([b["close"] for b in bars1h],200)
    h1t=[b["time"] for b in bars1h]

    rsi4=rsi_series(c4,14); stk4=stoch_k(bars4h,14); bb4=bb_pctb(c4,20); mh4=macd_hist(c4)
    c1=[b["close"] for b in bars1h]; rsi1=rsi_series(c1,14); stk1=stoch_k(bars1h,14)

    regime_1d=regime_persist(bars1d)
    reg_map={}
    for i,b in enumerate(bars1d): reg_map[b["time"]//86400000]=regime_1d[i]
    def get_reg(ts): return reg_map.get(ts//86400000,"RANGE")

    # funding lookup: latest funding rate at or before 4h bar time
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

    # ─── RCI v3 raw score per 4h bar ───
    # Bearish-positive components (POSITIVE = bearish/top pressure).
    def rci_raw_at(i):
        ts=bars4h[i]["time"]
        score=0.0
        # Funding x2.0 : >0.0005 strongly bearish. scale around 0.0005.
        fr=funding_at(ts)
        if fr is not None:
            # normalize: 0.0005 -> +1.0 ; 0 -> 0 ; negative -> bullish
            score += (fr/0.0005) * 2.0
        # RSI x1.5 : 4h primary (>70 bear, <30 bull), 1h secondary
        if rsi4[i] is not None:
            score += ((rsi4[i]-50)/20.0) * 1.5      # +1 at RSI70, -1 at RSI30
        h1i=h1_idx(ts)
        if rsi1[h1i] is not None:
            score += ((rsi1[h1i]-50)/20.0) * 1.5 * 0.5  # 1h secondary half weight
        # Stoch x0.8 : 4h + 1h
        if stk4[i] is not None:
            score += ((stk4[i]-50)/40.0) * 0.8       # +1 at 90, -1 at 10
        if stk1[h1i] is not None:
            score += ((stk1[h1i]-50)/40.0) * 0.8 * 0.5
        # BB %B x0.8 : >1 bear, <0 bull
        if bb4[i] is not None:
            score += ((bb4[i]-0.5)*2.0) * 0.8        # +1 at %B=1, -1 at %B=0
        # MACD hist declining x0.4 (bear if hist<0 & falling)
        if mh4[i] is not None and i>=1 and mh4[i-1] is not None:
            dh=mh4[i]-mh4[i-1]
            # bearish when hist positive but falling OR negative; sign of -slope normalized
            score += (-dh/(abs(mh4[i])+1e-6)) * 0.4 * (1 if mh4[i]>0 else -1) * 0  # keep small/neutral
        return score

    rci_raw=[None]*n
    for i in range(250,n):
        rci_raw[i]=rci_raw_at(i)
    # EMA(3) smoothing only over valid region
    rci=[None]*n; e=None; k=2/(3+1)
    for i in range(n):
        if rci_raw[i] is None: continue
        e=rci_raw[i] if e is None else rci_raw[i]*k+e*(1-k)
        rci[i]=e

    # quick RCI distribution (in funding window)
    valid=[rci[i] for i in range(n) if rci[i] is not None and bars4h[i]["time"]>=fund_start]
    valid.sort()
    if valid:
        vn=len(valid)
        print(f"RCI dist (funding window, n={vn}): min={valid[0]:.2f} p50={valid[vn//2]:.2f} p95={valid[int(vn*0.95)]:.2f} max={valid[-1]:.2f}")
        print(f"  RCI>4.0: {sum(1 for v in valid if v>4.0)}  RCI>3.0: {sum(1 for v in valid if v>3.0)}  RCI<-2.5: {sum(1 for v in valid if v<-2.5)}")

    # ─── helpers ───
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
    def e200_1h_at(ts):
        return e200_1h[h1_idx(ts)]

    def filt(i, side, allowed_regimes):
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

    # ─── sim with optional RCI exit ───
    def sim(ei, side, rci_exit=False):
        ep=c4[ei]; ae=atr4[ei]
        if ae is None or ae<=0: return None
        sl=ep-ae*SL_INIT if side=="LONG" else ep+ae*SL_INIT
        hwm=ep
        for h in range(1,MAX_HOLD+1):
            j=ei+h
            if j>=n: break
            # RCI exit check at bar j (LONG only): BEAR_STRONG -> exit at close
            if rci_exit and side=="LONG" and rci[j] is not None and rci[j]>RCI_BEAR_STRONG:
                return (c4[j]-ep)/ep - 2*FEE, h, "RCI"
            mult=SL_INIT if h<SL_TRANS else SL_TRAIL
            if side=="LONG":
                if c4[j]>hwm: hwm=c4[j]; sl=hwm-ae*mult
                elif h>=SL_TRANS:
                    t=hwm-ae*SL_TRAIL
                    if t>sl: sl=t
                if bars4h[j]["low"]<=sl: return (sl-ep)/ep-2*FEE, h, "SL"
            else:
                if c4[j]<hwm: hwm=c4[j]; sl=hwm+ae*mult
                elif h>=SL_TRANS:
                    t=hwm+ae*SL_TRAIL
                    if t<sl: sl=t
                if bars4h[j]["high"]>=sl: return (ep-sl)/ep-2*FEE, h, "SL"
        j=min(ei+MAX_HOLD,n-1)
        r=(c4[j]-ep)/ep if side=="LONG" else (ep-c4[j])/ep
        return r-2*FEE, MAX_HOLD, "MAXHOLD"

    # ─── run engine ───
    def run(rci_exit=False, rci_entry=False, allowed={"RANGE"}):
        trades=[]; last={s:{"LONG":0,"SHORT":0} for s in ["S12","S13","S14"]}
        last_rci_entry=-9999
        for i in range(250,n-MAX_HOLD):
            ts=bars4h[i]["time"]
            if ts<fund_start or ts>fund_end: continue
            entered=False
            for sn in ["S12","S13","S14"]:
                sig=sigs[sn](i)
                if sig is None: continue
                if SKIP_SHORT and sig=="SHORT": continue
                if i-last[sn][sig]<CD[sn]: continue
                if do_vol[sn] and not vol_pass(i): continue
                if not filt(i,sig,allowed): continue
                r=sim(i,sig,rci_exit=rci_exit)
                if r is None: continue
                ret,h,reason=r
                yr=datetime.datetime.utcfromtimestamp(ts/1000).year
                trades.append({"ret":ret,"h":h,"yr":yr,"side":sig,"setup":sn,
                               "regime":get_reg(ts),"exit":reason,"bar":i})
                last[sn][sig]=i; entered=True
            # RCI bottom entry boost
            if rci_entry and not entered:
                if rci[i] is not None and rci[i]<RCI_BULL_STRONG:
                    reg=get_reg(ts); adv=adx4[i]
                    if reg=="RANGE" and adv is not None and adv>RCI_ENTRY_ADX:
                        if i-last_rci_entry>=CD_RCI_ENTRY:
                            r=sim(i,"LONG",rci_exit=rci_exit)
                            if r is not None:
                                ret,h,reason=r
                                yr=datetime.datetime.utcfromtimestamp(ts/1000).year
                                trades.append({"ret":ret,"h":h,"yr":yr,"side":"LONG",
                                               "setup":"RCI","regime":reg,"exit":reason,"bar":i})
                                last_rci_entry=i
        return trades

    def stats(trades, label, capital=100000):
        if not trades:
            print(f"\n[{label}] NO TRADES"); return None
        rets=[t["ret"] for t in trades]; nt=len(rets)
        mean=sum(rets)/nt
        sd=(sum((r-mean)**2 for r in rets)/nt)**0.5 or 1e-9
        ra=mean/sd
        # annualized-ish Sharpe (per-trade RA * sqrt(trades/yr)); window ~3y
        yrs=len(set(t["yr"] for t in trades))
        sharpe_ann = ra * math.sqrt(nt/max(yrs,1))
        wr=sum(1 for r in rets if r>0)/nt*100
        wins=[r for r in rets if r>0]; losses=[r for r in rets if r<=0]
        avgw=sum(wins)/len(wins)*100 if wins else 0
        avgl=sum(losses)/len(losses)*100 if losses else 0
        roi=sum(rets)*100
        dollars=capital*sum(rets)
        # equity DD on chronological order
        eq=0; peak=0; mdd=0
        for t in sorted(trades,key=lambda x:x["bar"]):
            eq+=t["ret"]; peak=max(peak,eq); mdd=max(mdd,peak-eq)
        by_yr=defaultdict(float)
        for t in trades: by_yr[t["yr"]]+=t["ret"]
        pos=sum(1 for v in by_yr.values() if v>0)
        yr_str=" ".join(f"{y}:{by_yr[y]*100:+.0f}%" for y in sorted(by_yr))
        print(f"\n[{label}]")
        print(f"  n={nt}  RA={ra:+.3f}  Sharpe(ann)={sharpe_ann:+.2f}  WR={wr:.0f}%  avgW={avgw:+.2f}% avgL={avgl:+.2f}%")
        print(f"  ROI={roi:+.1f}%  ${dollars:+,.0f}  MaxDD={mdd*100:.1f}% (${capital*mdd:,.0f})  stab={pos}/{len(by_yr)}")
        print(f"  Per-year: {yr_str}")
        ex=defaultdict(int)
        for t in trades: ex[t["exit"]]+=1
        print(f"  Exits: {dict(ex)}")
        return {"n":nt,"ra":ra,"sharpe":sharpe_ann,"wr":wr,"roi":roi,"dollars":dollars,
                "mdd":mdd*100,"mdd_usd":capital*mdd,"stab":f"{pos}/{len(by_yr)}",
                "avgw":avgw,"avgl":avgl,"yr":dict(by_yr)}

    print("\n"+"="*78)
    print("TASK 3 — BASELINE hedge01 (3y funding window, RANGE-only LONG)")
    print("="*78)
    base=run(rci_exit=False, rci_entry=False)
    rb=stats(base,"BASELINE hedge01 v0.4.75")

    print("\n"+"="*78)
    print("TASK 1 — RCI EXIT overlay (LONG + RCI>+4.0 -> exit now)")
    print("="*78)
    exit_t=run(rci_exit=True, rci_entry=False)
    re=stats(exit_t,"hedge01 + RCI-EXIT")

    print("\n"+"="*78)
    print("TASK 2 — RCI ENTRY boost (RCI<-2.5 + RANGE + ADX>18 -> LONG)")
    print("="*78)
    entry_t=run(rci_exit=False, rci_entry=True)
    ren=stats(entry_t,"hedge01 + RCI-ENTRY")
    rci_only=[t for t in entry_t if t["setup"]=="RCI"]
    if rci_only:
        stats(rci_only,"  (isolated RCI-entry trades only)")

    # ─── deltas / verdicts ───
    print("\n"+"="*78); print("DELTA SUMMARY vs baseline"); print("="*78)
    def delta(a,b,name):
        if not a or not b: print(f"  {name}: n/a"); return
        print(f"  {name}:")
        print(f"    n      {a['n']} -> {b['n']} ({b['n']-a['n']:+d})")
        print(f"    Sharpe {a['sharpe']:+.2f} -> {b['sharpe']:+.2f} ({b['sharpe']-a['sharpe']:+.2f})")
        print(f"    ROI    {a['roi']:+.1f}% -> {b['roi']:+.1f}% ({b['roi']-a['roi']:+.1f}pp)")
        print(f"    $      ${a['dollars']:+,.0f} -> ${b['dollars']:+,.0f} (${b['dollars']-a['dollars']:+,.0f})")
        print(f"    MaxDD  {a['mdd']:.1f}% -> {b['mdd']:.1f}% ({b['mdd']-a['mdd']:+.1f}pp)")
        print(f"    WR     {a['wr']:.0f}% -> {b['wr']:.0f}%")
    delta(rb,re,"RCI-EXIT")
    delta(rb,ren,"RCI-ENTRY")

    print("\n"+"="*78); print("VERDICTS"); print("="*78)
    if rb and re:
        acc = (re['sharpe']>rb['sharpe']+0.01) or (abs(re['roi']-rb['roi'])<2 and re['mdd']<rb['mdd']-0.5)
        print(f"  TASK1 RCI-EXIT:  {'ACCEPT' if acc else 'REJECT'}  "
              f"(Sharpe {re['sharpe']-rb['sharpe']:+.2f}, ROI {re['roi']-rb['roi']:+.1f}pp, DD {re['mdd']-rb['mdd']:+.1f}pp, $ {re['dollars']-rb['dollars']:+,.0f})")
    if rb and ren:
        more = ren['n']>rb['n']
        keep_sh = ren['sharpe']>=rb['sharpe']-0.05
        acc2 = more and keep_sh
        print(f"  TASK2 RCI-ENTRY: {'ACCEPT' if acc2 else 'REJECT'}  "
              f"(+{ren['n']-rb['n']} trades, Sharpe {ren['sharpe']-rb['sharpe']:+.2f}, $ {ren['dollars']-rb['dollars']:+,.0f})")

    return rb, re, ren


if __name__ == "__main__":
    main()
