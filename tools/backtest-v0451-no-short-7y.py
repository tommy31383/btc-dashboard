#!/usr/bin/env python3
"""
backtest-v0451-no-short-7y.py — Verify v0.4.51 (disable SHORT) vs baseline.

So sánh:
  BASELINE: S12/S13/S14 LONG + SHORT (config hiện tại)
  V0451:    S12/S13/S14 LONG only (SHORT disabled)

Metrics: RA, ROI%, WR, R:R, per-year stability, max DD.
Accept nếu: RA tăng, stability không tệ đi, DD không tăng.
"""
import json, math, datetime
from collections import defaultdict

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FEE = 0.05/100; H4 = 4*3600*1000
MAX_HOLD=200; SL_INIT=4.0; SL_TRAIL=3.0; SL_TRANS=24  # 96h=24×4h bars
ADX_P=14; VOL_MA=10; VOL_MULT=1.2; ATR_PCT_LB=90; ATR_PCT_PCTL=0.50  # hedge01 prod: 50th pctl
DONCHIAN_LB=20; ATR_BREAK_MULT=1.5; EMA_FAST=50; EMA_SLOW=200

def load_tf(ms):
    raw=json.load(open(CACHE)); b={}
    for c in raw:
        k=c["time"]//ms
        if k not in b: b[k]={"time":k*ms,"high":c["high"],"low":c["low"],"close":c["close"],"volume":c["volume"]}
        else: o=b[k]; o["high"]=max(o["high"],c["high"]); o["low"]=min(o["low"],c["low"]); o["close"]=c["close"]; o["volume"]+=c["volume"]
    return [b[k] for k in sorted(b)]

def ema_s(xs,n):
    k=2/(n+1); out=[None]*len(xs); e=None
    for i,x in enumerate(xs): e=x if e is None else x*k+e*(1-k); out[i]=e
    return out

def atr_s(bars):
    tr=[0.0]*len(bars)
    for i in range(1,len(bars)):
        hl=bars[i]["high"]-bars[i]["low"]; hc=abs(bars[i]["high"]-bars[i-1]["close"]); lc=abs(bars[i]["low"]-bars[i-1]["close"])
        tr[i]=max(hl,hc,lc)
    atr=[None]*len(bars)
    for i in range(ADX_P,len(bars)): atr[i]=sum(tr[i-ADX_P+1:i+1])/ADX_P
    return atr

def adx_s(bars):
    n=len(bars); pdm=[0.0]*n; ndm=[0.0]*n; tr=[0.0]*n
    for i in range(1,n):
        up=bars[i]["high"]-bars[i-1]["high"]; dn=bars[i-1]["low"]-bars[i]["low"]
        pdm[i]=up if up>dn and up>0 else 0; ndm[i]=dn if dn>up and dn>0 else 0
        hl=bars[i]["high"]-bars[i]["low"]; hc=abs(bars[i]["high"]-bars[i-1]["close"]); lc=abs(bars[i]["low"]-bars[i-1]["close"])
        tr[i]=max(hl,hc,lc)
    adx=[None]*n
    for i in range(28,n):
        atrv=sum(tr[i-ADX_P+1:i+1])/ADX_P
        if not atrv: continue
        dx_vals=[]
        for j in range(i-ADX_P+1,i+1):
            a2=sum(tr[j-ADX_P+1:j+1])/ADX_P if j>=ADX_P else None
            if not a2: dx_vals.append(0); continue
            p2=100*sum(pdm[j-ADX_P+1:j+1])/ADX_P/a2; n2=100*sum(ndm[j-ADX_P+1:j+1])/ADX_P/a2
            dx_vals.append(100*abs(p2-n2)/((p2+n2) or 1e-9))
        adx[i]=sum(dx_vals)/len(dx_vals)
    return adx

def regime_s(bars1d):
    cs=[b["close"] for b in bars1d]; n=len(bars1d); out=["RANGE"]*n
    for i in range(200,n):
        ma200=sum(cs[i-199:i+1])/200; ma50=sum(cs[i-50:i+1])/50
        r20=bars1d[i-19:i+1]; ar=sum((b["high"]-b["low"])/b["close"] for b in r20)/20
        if cs[i]<ma200: out[i]="BEAR"
        elif cs[i]>ma50 and ma50>ma200 and ar>0.04: out[i]="BULL"
    return out

def main():
    bars4h=load_tf(H4); bars1h=load_tf(3600*1000); bars1d=load_tf(86400*1000)
    c4=[ b["close"] for b in bars4h]; n=len(bars4h)
    print(f"4h bars: {n}  {datetime.datetime.utcfromtimestamp(bars4h[0]['time']/1000):%Y-%m-%d} → {datetime.datetime.utcfromtimestamp(bars4h[-1]['time']/1000):%Y-%m-%d}")

    e50=ema_s(c4,EMA_FAST); e200=ema_s(c4,EMA_SLOW)
    atr4=atr_s(bars4h); adx4=adx_s(bars4h)
    e200_1h=ema_s([b["close"] for b in bars1h],200)
    h1t=[b["time"] for b in bars1h]

    reg_map={}
    for i,b in enumerate(bars1d): reg_map[b["time"]//86400000]=regime_s(bars1d)[i]
    def get_reg(ts): return reg_map.get(ts//86400000,"RANGE")

    def atp(i):
        if atr4[i] is None: return None
        return atr4[i]/c4[i]
    def atp_pass(i):
        if i<ATR_PCT_LB: return False
        vs=[atp(j) for j in range(i-ATR_PCT_LB,i) if atp(j) is not None]
        if not vs: return False
        return atp(i) is not None and atp(i)>=sorted(vs)[int(len(vs)*ATR_PCT_PCTL)]
    def vol_pass(i):
        if i<VOL_MA: return False
        return bars4h[i]["volume"]>=sum(bars4h[j]["volume"] for j in range(i-VOL_MA,i))/VOL_MA*VOL_MULT

    def e200_1h_at(ts):
        lo,hi=0,len(h1t)-1; idx=0
        while lo<=hi:
            m=(lo+hi)//2
            if h1t[m]<=ts: idx=m; lo=m+1
            else: hi=m-1
        return e200_1h[idx]

    def filt(i,side):
        if adx4[i] is None or adx4[i]<=20: return False
        if i>=1 and (adx4[i-1] is None or adx4[i-1]<=20): return False
        e1h=e200_1h_at(bars4h[i]["time"])
        if e1h is None: return False
        if side=="LONG" and c4[i]<e1h: return False
        if side=="SHORT" and c4[i]>e1h: return False
        if not atp_pass(i): return False
        if datetime.datetime.utcfromtimestamp(bars4h[i]["time"]/1000).hour==8: return False
        reg=get_reg(bars4h[i]["time"])
        if side=="LONG" and reg=="BEAR": return False
        if side=="SHORT" and reg=="BULL": return False
        return True

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
                    t=hwm-ae*SL_TRAIL;
                    if t>sl: sl=t
                if bars4h[j]["low"]<=sl: return (sl-ep)/ep-2*FEE,h
            else:
                if c4[j]<hwm: hwm=c4[j]; sl=hwm+ae*mult
                elif h>=SL_TRANS:
                    t=hwm+ae*SL_TRAIL;
                    if t<sl: sl=t
                if bars4h[j]["high"]>=sl: return (ep-sl)/ep-2*FEE,h
        j=min(ei+MAX_HOLD,n-1)
        r=(c4[j]-ep)/ep if side=="LONG" else (ep-c4[j])/ep
        return r-2*FEE,MAX_HOLD

    def sig_s12(i):
        if None in (e50[i],e200[i],e50[i-1],e200[i-1]): return None
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
        hi20=max(bars4h[j]["high"] for j in range(i-DONCHIAN_LB,i))
        lo20=min(bars4h[j]["low"]  for j in range(i-DONCHIAN_LB,i))
        if c4[i]>hi20: return "LONG"
        if c4[i]<lo20: return "SHORT"
        return None

    CD={"S12":36,"S13":1,"S14":36}
    sigs={"S12":sig_s12,"S13":sig_s13,"S14":sig_s14}
    do_vol={"S12":False,"S13":True,"S14":True}

    def run(disable_short):
        trades=[]; last={s:{"LONG":0,"SHORT":0} for s in ["S12","S13","S14"]}
        for i in range(250,n-MAX_HOLD):
            for sn in ["S12","S13","S14"]:
                sig=sigs[sn](i)
                if sig is None: continue
                if disable_short and sig=="SHORT": continue
                if i-last[sn][sig]<CD[sn]: continue
                if do_vol[sn] and not vol_pass(i): continue
                if not filt(i,sig): continue
                r=sim(i,sig)
                if r is None: continue
                ret,h=r
                yr=datetime.datetime.utcfromtimestamp(bars4h[i]["time"]/1000).year
                trades.append({"ret":ret,"h":h,"yr":yr,"side":sig,"setup":sn})
                last[sn][sig]=i
        return trades

    def report(trades, label):
        if not trades: print(f"  {label}: NO TRADES"); return {}
        rets=[t["ret"] for t in trades]; n_=len(rets)
        mean=sum(rets)/n_; sd=(sum((r-mean)**2 for r in rets)/n_)**0.5 or 1e-9
        ra=mean/sd; wr=sum(1 for r in rets if r>0)/n_*100
        wins=[r for r in rets if r>0]; losses=[r for r in rets if r<0]
        rr=(sum(wins)/len(wins) if wins else 0)/abs(sum(losses)/len(losses) if losses else 1e-9)
        by_yr=defaultdict(float)
        for t in trades: by_yr[t["yr"]]+=t["ret"]
        pos=sum(1 for v in by_yr.values() if v>0)
        # max DD
        equity=0; peak=0; max_dd=0
        for t in sorted(trades,key=lambda x:x["yr"]):
            equity+=t["ret"]; peak=max(peak,equity); max_dd=max(max_dd,peak-equity)
        yr_str=" ".join(f"{y}:{by_yr[y]*100:+.0f}" for y in sorted(by_yr))
        print(f"  {label:25s} n={n_:4d} RA={ra:+.3f} WR={wr:.0f}% R:R={rr:.2f} ROI={sum(rets)*100:+.1f}% DD={max_dd*100:.1f}% stab={pos}/{len(by_yr)}")
        print(f"  {'':25s} {yr_str}")
        return {"ra":ra,"wr":wr,"rr":rr,"roi":sum(rets)*100,"dd":max_dd*100,"stab":pos,"yrs":len(by_yr)}

    print("\n" + "="*80)
    print("BASELINE (LONG + SHORT):")
    base = run(disable_short=False)
    b = report(base, "BASELINE LONG+SHORT")

    print("\nV0.4.51 (LONG only, SHORT disabled):")
    new_ = run(disable_short=True)
    v = report(new_, "V0451 LONG only")

    print("\n" + "="*80)
    print("DELTA (v0451 − baseline):")
    if b and v:
        print(f"  RA:    {b['ra']:+.3f} → {v['ra']:+.3f}  Δ={v['ra']-b['ra']:+.3f}  {'✅' if v['ra']>b['ra'] else '❌'}")
        print(f"  WR:    {b['wr']:.0f}% → {v['wr']:.0f}%")
        print(f"  R:R:   {b['rr']:.2f} → {v['rr']:.2f}  Δ={v['rr']-b['rr']:+.2f}")
        print(f"  ROI:   {b['roi']:+.1f}% → {v['roi']:+.1f}%  Δ={v['roi']-b['roi']:+.1f}%")
        print(f"  DD:    {b['dd']:.1f}% → {v['dd']:.1f}%  Δ={v['dd']-b['dd']:+.1f}%  {'✅' if v['dd']<=b['dd'] else '❌'}")
        print(f"  Stab:  {b['stab']}/{b['yrs']} → {v['stab']}/{v['yrs']}  {'✅' if v['stab']>=b['stab'] else '❌'}")
        ok = v['ra']>b['ra'] and v['stab']>=b['stab'] and v['dd']<=b['dd']+0.5
        print(f"\n  4-METRIC ACCEPT: {'✅ SHIP v0.4.51' if ok else '❌ REJECT — review'}")

if __name__=="__main__":
    main()
