#!/usr/bin/env python3
"""
new-diversified-rule-search.py
Tìm 1 RULE MỚI uncorrelated để thêm vào book (diversification = edge thật).
KHÔNG sửa entry-selector. Mọi candidate = trend-follow + ATR-cut + asymmetry exit.

Candidates (cấu trúc KHÁC book hiện tại để decorrelate):
  C1 Donchian 4h breakout (turtle chỉ daily)  -> TP-wide + ATR trail
  C2 Donchian weekly breakout
  C3 Momentum pullback continuation (EMA200 uptrend + pullback->reclaim) cut chặt
  C4 Volatility breakout NR7/squeeze -> range breakout
  C5 Cross-asset rotation: long coin mạnh nhất (trend-strength rank), ATR-cut

HONEST GATE: dollars + Calmar + per-year(>=5/8) + n>=3/yr + drop-top-20%>0
            + walk-forward(train19-22/test23-26 unseen) + cross-asset>=2/3
            + CORR monthly với book < 0.4 (tiêu chí quan trọng nhất)

Book proxy = turtle(daily Donchian 20/10 long+ATRcut) + champion(4h ADX trend tp-wide)
            + hedge01-ish(RANGE trend) — dùng monthly returns để tính corr.
Gross PnL no fee như champion/turtle scripts; ATR-cut + TP modeled bằng intrabar.
"""
import json, math, statistics
from datetime import datetime, timezone

CACHE="/Users/lap16116/BTC_PC/btc-dashboard/.cache"
FILES={"BTC":f"{CACHE}/binance-5m-7y.json","ETH":f"{CACHE}/binance-eth-5m-7y.json","SOL":f"{CACHE}/binance-sol-5m-3y.json"}
TAKER=0.0004
START_EQ=100000.0
RISK_FRAC=0.01   # risk 1% equity per trade (vol-target via ATR stop distance)

def load(sym):
    return json.load(open(FILES[sym]))

def agg(bars5, hours):
    out=[]; span=hours*3600*1000; cur=None
    for b in bars5:
        bk=(b["time"]//span)*span
        if cur is None or bk!=cur["time"]:
            if cur: out.append(cur)
            cur={"time":bk,"open":b["open"],"high":b["high"],"low":b["low"],"close":b["close"]}
        else:
            cur["high"]=max(cur["high"],b["high"]); cur["low"]=min(cur["low"],b["low"]); cur["close"]=b["close"]
    if cur: out.append(cur)
    return out

def ema(vals,p):
    out=[None]*len(vals); k=2/(p+1); e=None
    for i,v in enumerate(vals):
        e=v if e is None else v*k+e*(1-k)
        out[i]=e
    return out

def atr(bars,p=14):
    n=len(bars); out=[None]*n; trs=[]
    for i in range(n):
        if i==0: tr=bars[i]["high"]-bars[i]["low"]
        else:
            pc=bars[i-1]["close"]
            tr=max(bars[i]["high"]-bars[i]["low"],abs(bars[i]["high"]-pc),abs(bars[i]["low"]-pc))
        trs.append(tr)
        if i>=p: out[i]=sum(trs[i-p+1:i+1])/p
        elif i==p-1: out[i]=sum(trs)/p
    return out

def yr(ms): return datetime.fromtimestamp(ms/1000,timezone.utc).year
def ym(ms):
    d=datetime.fromtimestamp(ms/1000,timezone.utc); return d.year*12+d.month

# ---- generic long trend-follow engine: signal->entry, ATR stop trail, TP-wide ----
def run_engine(bars, signals, atr_arr, sl_mult, tp_mult, trail=True):
    """signals[i]=True -> enter long at bars[i] close. Exit: stop (sl_mult*ATR trailing),
    or TP (tp_mult*ATR). Returns list of trades dict(entry_ms, ret_pct, pnl, year)."""
    trades=[]; i=0; n=len(bars)
    while i<n-1:
        if signals[i] and atr_arr[i]:
            entry=bars[i]["close"]; a=atr_arr[i]
            stop=entry-sl_mult*a; tp=entry+tp_mult*a; peak=entry
            j=i+1; exitp=None
            while j<n:
                hi=bars[j]["high"]; lo=bars[j]["low"]
                # stop first (conservative)
                if lo<=stop: exitp=stop; break
                if hi>=tp: exitp=tp; break
                if trail and hi>peak:
                    peak=hi; stop=max(stop,peak-sl_mult*a)
                j+=1
            if exitp is None: exitp=bars[-1]["close"]
            ret=(exitp-entry)/entry
            # position sized to risk RISK_FRAC at stop distance sl_mult*a/entry
            stop_dist=sl_mult*a/entry
            notional=(RISK_FRAC/stop_dist)*START_EQ if stop_dist>0 else 0
            notional=min(notional,5*START_EQ)  # leverage cap 5x
            pnl=notional*ret - notional*TAKER*2
            trades.append({"ms":bars[i]["time"],"ret":ret,"pnl":pnl,"year":yr(bars[i]["time"])})
            i=j+1
        else:
            i+=1
    return trades

# ---- candidate signal generators ----
def sig_donchian(bars, lookback):
    n=len(bars); sig=[False]*n
    for i in range(lookback,n):
        hh=max(b["high"] for b in bars[i-lookback:i])
        if bars[i]["close"]>hh: sig[i]=True
    return sig

def sig_mom_pullback(bars):
    closes=[b["close"] for b in bars]; e200=ema(closes,200); e20=ema(closes,20)
    n=len(bars); sig=[False]*n
    for i in range(201,n):
        if e200[i] and closes[i]>e200[i]:
            # pullback to e20 then reclaim: prev low touched below e20, now close>e20 and rising
            if bars[i-1]["low"]<e20[i-1] and closes[i]>e20[i] and closes[i]>closes[i-1]:
                sig[i]=True
    return sig

def sig_volbreakout(bars):
    n=len(bars); sig=[False]*n
    rng=[b["high"]-b["low"] for b in bars]
    for i in range(8,n):
        nr7 = rng[i-1]==min(rng[i-7:i])  # prev bar narrowest of 7 (squeeze)
        hh=max(b["high"] for b in bars[i-7:i])
        if nr7 and bars[i]["close"]>hh: sig[i]=True
    return sig

def stats(trades, years_present):
    if not trades: return None
    pnls=[t["pnl"] for t in trades]
    total=sum(pnls)
    # equity curve for maxDD/Calmar
    eq=START_EQ; peak=eq; mdd=0
    for p in pnls:
        eq+=p; peak=max(peak,eq); mdd=max(mdd,(peak-eq)/peak if peak>0 else 0)
    by_year={}
    for t in trades: by_year.setdefault(t["year"],0); by_year[t["year"]]+=t["pnl"]
    pos_years=sum(1 for y in years_present if by_year.get(y,0)>0)
    nyr=len(years_present)
    cagr_dollars=total/nyr
    calmar=(cagr_dollars/START_EQ)/mdd if mdd>0 else float('inf')
    # drop top 20%
    s=sorted(pnls,reverse=True); k=int(len(s)*0.2)
    drop20=sum(s[k:])
    n_per_yr=len(trades)/nyr
    return {"total":total,"calmar":calmar,"mdd":mdd,"pos_years":pos_years,"nyr":nyr,
            "n":len(trades),"n_per_yr":n_per_yr,"drop20":drop20,"by_year":by_year}

def monthly_returns(trades):
    m={}
    for t in trades:
        m.setdefault(ym(t["ms"]),0); m[ym(t["ms"])]+=t["pnl"]
    return m

def corr(a,b):
    keys=sorted(set(a)|set(b))
    xa=[a.get(k,0) for k in keys]; xb=[b.get(k,0) for k in keys]
    if len(keys)<6: return None
    ma=statistics.mean(xa); mb=statistics.mean(xb)
    num=sum((x-ma)*(y-mb) for x,y in zip(xa,xb))
    da=math.sqrt(sum((x-ma)**2 for x in xa)); db=math.sqrt(sum((y-mb)**2 for y in xb))
    if da==0 or db==0: return None
    return num/(da*db)

# ---- BOOK proxies (for corr baseline) ----
def book_turtle(bars_d, a_d):
    return run_engine(bars_d, sig_donchian(bars_d,20), a_d, 2.0, 8.0, trail=True)

def book_champion(bars_4h, a_4h):
    # ADX-ish trend: close>EMA50 and EMA50>EMA200, enter on new 20-bar high; tp wide 12:1.6 ratio
    closes=[b["close"] for b in bars_4h]; e50=ema(closes,50); e200=ema(closes,200)
    n=len(bars_4h); sig=[False]*n
    don=sig_donchian(bars_4h,20)
    for i in range(200,n):
        if e50[i] and e200[i] and closes[i]>e50[i] and e50[i]>e200[i] and don[i]:
            sig[i]=True
    return run_engine(bars_4h, sig, a_4h, 1.6, 12.0, trail=True)

def book_hedge01(bars_15m, a_15m):
    # RANGE-only trend proxy: enter on 50-bar high when EMA200 flat-ish; tight tp
    closes=[b["close"] for b in bars_15m]; e200=ema(closes,200)
    n=len(bars_15m); sig=[False]*n; don=sig_donchian(bars_15m,48)
    for i in range(201,n):
        # RANGE: EMA200 slope small
        if e200[i] and e200[i-48]:
            slope=abs(e200[i]-e200[i-48])/e200[i]
            if slope<0.03 and don[i] and closes[i]>e200[i]: sig[i]=True
    return run_engine(bars_15m, sig, a_15m, 2.0, 3.0, trail=False)

def fmt(s):
    if not s: return "  (no trades)"
    return (f"  ${s['total']:>10,.0f} | Calmar {s['calmar']:>5.2f} | mdd {s['mdd']*100:4.1f}% | "
            f"pos {s['pos_years']}/{s['nyr']} | n {s['n']:>4} ({s['n_per_yr']:.1f}/yr) | drop20 ${s['drop20']:>9,.0f}")

def main():
    print("Loading data...")
    data5={s:load(s) for s in FILES}
    # build TFs per coin
    BARS={}
    for s in FILES:
        BARS[s]={
            "15m":agg(data5[s],0.25) if False else agg_15(data5[s]),
            "4h":agg(data5[s],4),
            "1d":agg(data5[s],24),
            "1w":agg(data5[s],24*7),
        }
    ATRS={s:{tf:atr(BARS[s][tf]) for tf in BARS[s]} for s in BARS}

    # ---- build BOOK proxy on BTC (corr baseline) ----
    print("\nBuilding book proxy (BTC)...")
    bt_turtle=book_turtle(BARS["BTC"]["1d"],ATRS["BTC"]["1d"])
    bt_champ=book_champion(BARS["BTC"]["4h"],ATRS["BTC"]["4h"])
    bt_hedge=book_hedge01(BARS["BTC"]["15m"],ATRS["BTC"]["15m"])
    book_m={}
    for tr in (bt_turtle+bt_champ+bt_hedge):
        book_m.setdefault(ym(tr["ms"]),0); book_m[ym(tr["ms"])]+=tr["pnl"]
    print(f"  turtle n={len(bt_turtle)} champ n={len(bt_champ)} hedge n={len(bt_hedge)}")

    candidates={
        "C1_donch4h":   lambda s:(BARS[s]["4h"], sig_donchian(BARS[s]["4h"],50), ATRS[s]["4h"],2.0,10.0,True),
        "C2_donchWk":   lambda s:(BARS[s]["1w"], sig_donchian(BARS[s]["1w"],10), ATRS[s]["1w"],2.0,8.0,True),
        "C3_mompull4h": lambda s:(BARS[s]["4h"], sig_mom_pullback(BARS[s]["4h"]), ATRS[s]["4h"],1.8,9.0,True),
        "C4_volbrk4h":  lambda s:(BARS[s]["4h"], sig_volbreakout(BARS[s]["4h"]), ATRS[s]["4h"],1.8,9.0,True),
    }

    print("\n"+"="*100)
    for cname,gen in candidates.items():
        print(f"\n### {cname}")
        for s in FILES:
            bars,sig,a,sl,tp,tr=gen(s)
            yrs=sorted(set(yr(b["time"]) for b in bars))
            trades=run_engine(bars,sig,a,sl,tp,tr)
            st=stats(trades,yrs)
            print(f" {s}: {fmt(st)}")
            if st and s=="BTC":
                cm=monthly_returns(trades)
                c=corr(cm,book_m)
                print(f"      CORR(monthly) vs book = {c if c is None else round(c,3)}")
                # walk-forward
                tr_tr=[t for t in trades if t['year']<=2022]; te=[t for t in trades if t['year']>=2023]
                yt=[y for y in yrs if y<=2022]; ye=[y for y in yrs if y>=2023]
                stt=stats(tr_tr,yt); ste=stats(te,ye)
                print(f"      WF train19-22: {('$%.0f'%stt['total']) if stt else 'none'} | "
                      f"test23-26 UNSEEN: {('$%.0f Calmar %.2f pos %d/%d'%(ste['total'],ste['calmar'],ste['pos_years'],ste['nyr'])) if ste else 'none'}")

    # ---- C5 cross-asset rotation (BTC/ETH/SOL) ----
    print("\n### C5_rotation (long strongest trend coin, daily, ATR-cut)")
    c5=run_rotation(BARS,ATRS)
    yrs_all=sorted(set(t['year'] for t in c5)) if c5 else []
    st=stats(c5,yrs_all)
    print(f" PORT: {fmt(st)}")
    if st:
        cm=monthly_returns(c5); print(f"      CORR(monthly) vs book = {round(corr(cm,book_m),3) if corr(cm,book_m) is not None else None}")
        te=[t for t in c5 if t['year']>=2023]; ye=[y for y in yrs_all if y>=2023]
        ste=stats(te,ye)
        print(f"      WF test23-26: {('$%.0f Calmar %.2f pos %d/%d'%(ste['total'],ste['calmar'],ste['pos_years'],ste['nyr'])) if ste else 'none'}")

def agg_15(bars5):
    out=[]; span=15*60*1000; cur=None
    for b in bars5:
        bk=(b["time"]//span)*span
        if cur is None or bk!=cur["time"]:
            if cur: out.append(cur)
            cur={"time":bk,"open":b["open"],"high":b["high"],"low":b["low"],"close":b["close"]}
        else:
            cur["high"]=max(cur["high"],b["high"]); cur["low"]=min(cur["low"],b["low"]); cur["close"]=b["close"]
    if cur: out.append(cur)
    return out

def run_rotation(BARS,ATRS):
    """Each daily bar: rank coins by 20d momentum; hold long the strongest if its
    trend up (close>EMA50). ATR trailing stop exits. One position at a time."""
    # align on BTC daily timeline; SOL only 3y -> include when present
    syms=list(FILES)
    closesD={s:[b["close"] for b in BARS[s]["1d"]] for s in syms}
    e50={s:ema(closesD[s],50) for s in syms}
    idxbytime={s:{b["time"]:i for i,b in enumerate(BARS[s]["1d"])} for s in syms}
    btc_d=BARS["BTC"]["1d"]
    trades=[]; pos=None  # pos=dict(sym, entry, stop, atr, peak, ms)
    for k in range(60,len(btc_d)):
        t=btc_d[k]["time"]
        # current position management
        if pos:
            s=pos["sym"]; i=idxbytime[s].get(t)
            if i is not None:
                bar=BARS[s]["1d"][i]
                if bar["low"]<=pos["stop"]:
                    ret=(pos["stop"]-pos["entry"])/pos["entry"]
                    trades.append(mk(pos,ret)); pos=None
                else:
                    if bar["high"]>pos["peak"]:
                        pos["peak"]=bar["high"]; pos["stop"]=max(pos["stop"],pos["peak"]-2.0*pos["atr"])
        if pos: continue
        # pick strongest momentum coin with uptrend
        best=None; bestmom=-9
        for s in syms:
            i=idxbytime[s].get(t)
            if i is None or i<20: continue
            if not e50[s][i] or closesD[s][i]<=e50[s][i]: continue
            mom=(closesD[s][i]-closesD[s][i-20])/closesD[s][i-20]
            if mom>bestmom and mom>0: bestmom=mom; best=(s,i)
        if best:
            s,i=best; a=ATRS[s]["1d"][i]
            if not a: continue
            entry=closesD[s][i]
            pos={"sym":s,"entry":entry,"stop":entry-2.0*a,"atr":a,"peak":entry,"ms":t}
    if pos:
        s=pos["sym"]; last=BARS[s]["1d"][-1]["close"]
        trades.append(mk(pos,(last-pos["entry"])/pos["entry"]))
    return trades

def mk(pos,ret):
    stop_dist=2.0*pos["atr"]/pos["entry"]
    notional=min((RISK_FRAC/stop_dist)*START_EQ,5*START_EQ) if stop_dist>0 else 0
    pnl=notional*ret-notional*TAKER*2
    return {"ms":pos["ms"],"ret":ret,"pnl":pnl,"year":yr(pos["ms"])}

if __name__=="__main__":
    main()
