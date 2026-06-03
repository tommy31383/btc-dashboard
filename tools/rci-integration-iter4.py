#!/usr/bin/env python3
"""
rci-integration-iter4.py — Validate v0.4.76 funding-block (0.05%) on FULL 7y
funding history, esp. the 2021 blowoff. Re-sweep optimal threshold on 7y.

v0.4.76 LIVE: hedge01 funding block threshold 0.05% (0.0005), was 0.08% (0.0008).
Validated only on 3y (n=3 skips). 2021 robustness OPEN.

Task2 — baseline(block 0.08%) vs v0.4.76(block 0.05%) vs no-block, per-year, esp 2021.
Task3 — sweep block 0.03/0.04/0.05/0.06/0.08/0.10%, max 7y Sharpe/$ with stab>=5/8.

Engine = hedge01 live params (ADX18/12, SL3.0/3.5/64h*, ATR_BREAK1.3, VOL1.4/16,
DLB18, RANGE-only LONG, skip SHORT). SL_TRANS=16 4h-bars = 64h.
Judge Sharpe + DOLLARS + per-year stability.
"""
import json, datetime, math
from collections import defaultdict

CACHE   = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FUNDING = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-funding-7y.json"
FEE = 0.05 / 100
H4  = 4 * 3600 * 1000

# hedge01 live v0.4.76 config
SL_INIT=3.0; SL_TRAIL=3.5; SL_TRANS=16; ADX_P=14
ADX_THRESH=18; ADX_THRESH_P=12; VOL_MA=16; VOL_MULT=1.4
ATR_PCT_LB=90; ATR_PCT_PCTL=0.50; DONCHIAN_LB=18; ATR_BREAK_MULT=1.3
EMA_FAST=50; EMA_SLOW=200; MAX_HOLD=200; SKIP_SHORT=True
CD={"S12":36,"S13":1,"S14":36}


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
    print(f"  funding {datetime.datetime.utcfromtimestamp(fund_start/1000):%Y-%m} -> {datetime.datetime.utcfromtimestamp(fund_end/1000):%Y-%m}  n={len(fund)}")

    bars4h=load_tf(raw,H4); bars1h=load_tf(raw,3600*1000); bars1d=load_tf(raw,86400*1000)
    n=len(bars4h); c4=[b["close"] for b in bars4h]
    e50=ema_s(c4,EMA_FAST); e200=ema_s(c4,EMA_SLOW)
    atr4=atr_series(bars4h); adx4=adx_wilder(bars4h)
    e200_1h=ema_s([b["close"] for b in bars1h],200); h1t=[b["time"] for b in bars1h]

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

    # block_thr: funding rate above which a new LONG is SKIPPED. None = no block.
    def run(block_thr):
        trades=[]; last={s:{"LONG":0,"SHORT":0} for s in ["S12","S13","S14"]}
        skipped=[]
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
                fr=funding_at(ts)
                if sig=="LONG" and block_thr is not None and fr is not None and fr>block_thr:
                    # record what the blocked trade WOULD have returned
                    r0=sim(i,sig)
                    yr=datetime.datetime.utcfromtimestamp(ts/1000).year
                    skipped.append({"yr":yr,"funding":fr,"would_ret":r0[0] if r0 else None})
                    last[sn][sig]=i; continue
                r=sim(i,sig)
                if r is None: continue
                ret,h,reason=r
                yr=datetime.datetime.utcfromtimestamp(ts/1000).year
                trades.append({"ret":ret,"h":h,"yr":yr,"side":sig,"setup":sn,
                               "regime":get_reg(ts),"exit":reason,"bar":i,"funding":fr})
                last[sn][sig]=i
        return trades,skipped

    def stats(trades,label,capital=100000,silent=False):
        if not trades:
            if not silent: print(f"\n[{label}] NO TRADES")
            return None
        rets=[t["ret"] for t in trades]; nt=len(rets); mean=sum(rets)/nt
        sd=(sum((r-mean)**2 for r in rets)/nt)**0.5 or 1e-9; ra=mean/sd
        yrs=len(set(t["yr"] for t in trades)); sharpe_ann=ra*math.sqrt(nt/max(yrs,1))
        wr=sum(1 for r in rets if r>0)/nt*100
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
            print(f"  n={nt}  RA={ra:+.3f}  Sharpe(ann)={sharpe_ann:+.2f}  WR={wr:.0f}%")
            print(f"  ROI={roi:+.1f}%  ${dollars:+,.0f}  MaxDD={mdd*100:.1f}% (${capital*mdd:,.0f})  stab={pos}/{len(by_yr)}")
            print(f"  Per-year: {yr_str}")
        return {"n":nt,"ra":ra,"sharpe":sharpe_ann,"wr":wr,"roi":roi,"dollars":dollars,
                "mdd":mdd*100,"mdd_usd":capital*mdd,"stab":pos,"nyr":len(by_yr),
                "by_yr":dict(by_yr)}

    # ════════════════════════════════════════════════════════════════
    print("\n"+"="*78)
    print("TASK 2 — v0.4.76 (block 0.05%) vs baseline(0.08%) vs no-block — FULL 7y")
    print("="*78)
    noblock,_      = run(None)
    b008,sk008     = run(0.0008)
    b005,sk005     = run(0.0005)
    rn  = stats(noblock,"NO-BLOCK (no funding filter)")
    r08 = stats(b008,   "BASELINE block 0.08% (pre-v0.4.76)")
    r05 = stats(b005,   "v0.4.76 block 0.05% (LIVE)")

    print("\n--- Blocked entries per year (block 0.05% = v0.4.76) ---")
    by_yr_sk=defaultdict(lambda:{"n":0,"would":0.0,"losers":0})
    for s in sk005:
        d=by_yr_sk[s["yr"]]; d["n"]+=1
        if s["would_ret"] is not None:
            d["would"]+=s["would_ret"]
            if s["would_ret"]<=0: d["losers"]+=1
    print(f"  {'yr':>6} {'blocked':>8} {'would_ret$':>11} {'losers':>7}")
    tot_n=tot_w=0
    for y in sorted(by_yr_sk):
        d=by_yr_sk[y]; tot_n+=d["n"]; tot_w+=d["would"]
        print(f"  {y:>6} {d['n']:>8} {100000*d['would']:>+10.0f} {d['losers']:>4}/{d['n']}")
    print(f"  {'TOTAL':>6} {tot_n:>8} {100000*tot_w:>+10.0f}  (negative would_ret = block AVOIDED losses = good)")

    print("\n--- 2021 SPOTLIGHT (the blowoff year) ---")
    for lbl,r in [("no-block",rn),("0.08%",r08),("0.05%",r05)]:
        v=r["by_yr"].get(2021,0.0) if r else 0
        print(f"  2021 {lbl:>10}: {v*100:+.1f}%  (${100000*v:+,.0f})")
    n21_05=by_yr_sk.get(2021,{}).get("n",0)
    w21_05=by_yr_sk.get(2021,{}).get("would",0)
    l21_05=by_yr_sk.get(2021,{}).get("losers",0)
    print(f"  2021 blocked by 0.05%: {n21_05} entries, would-be ${100000*w21_05:+,.0f}, {l21_05} losers")

    # ════════════════════════════════════════════════════════════════
    print("\n"+"="*78)
    print("TASK 3 — Re-sweep optimal funding block threshold on FULL 7y")
    print("="*78)
    print(f"  {'block':>7} {'n':>5} {'Sharpe':>7} {'ROI%':>7} {'$':>10} {'MaxDD%':>7} {'stab':>5} {'blocked':>8}")
    sweep=[]
    for thr in [0.0003,0.0004,0.0005,0.0006,0.0008,0.0010,None]:
        tr,sk=run(thr)
        r=stats(tr,"",silent=True)
        lbl=f"{thr*100:.2f}%" if thr is not None else "NONE"
        sweep.append((thr,lbl,r,len(sk)))
        print(f"  {lbl:>7} {r['n']:>5} {r['sharpe']:>+7.2f} {r['roi']:>+7.0f} {r['dollars']:>+10.0f} {r['mdd']:>7.1f} {r['stab']}/{r['nyr']:<2} {len(sk):>8}")

    # pick best by Sharpe with stab>=5/8
    cand=[s for s in sweep if s[2]["stab"]>=5]
    best=max(cand,key=lambda s:s[2]["sharpe"]) if cand else None
    bestdol=max(cand,key=lambda s:s[2]["dollars"]) if cand else None
    print(f"\n  Best Sharpe (stab>=5yr): block {best[1]} Sharpe {best[2]['sharpe']:+.2f} ${best[2]['dollars']:+,.0f}" if best else "  none meet stab>=5")
    print(f"  Best dollars (stab>=5yr): block {bestdol[1]} ${bestdol[2]['dollars']:+,.0f} Sharpe {bestdol[2]['sharpe']:+.2f}" if bestdol else "")

    print("\n"+"="*78); print("VERDICT"); print("="*78)
    print(f"  no-block : Sharpe {rn['sharpe']:+.2f}  ${rn['dollars']:+,.0f}  stab {rn['stab']}/{rn['nyr']}")
    print(f"  0.08%    : Sharpe {r08['sharpe']:+.2f}  ${r08['dollars']:+,.0f}  stab {r08['stab']}/{r08['nyr']}")
    print(f"  0.05%    : Sharpe {r05['sharpe']:+.2f}  ${r05['dollars']:+,.0f}  stab {r05['stab']}/{r05['nyr']}")

if __name__=="__main__":
    main()
