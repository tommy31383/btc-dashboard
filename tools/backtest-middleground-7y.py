#!/usr/bin/env python3
"""
backtest-middleground-7y.py — Middle ground giữa CURRENT và SIMPLIFIED

CURRENT (ATR50+h16+ThuSun): n=107, RA=0.515, DD=20.7%, decay=-22%
SIMPLIFIED (ATR30,no h16,no ThuSun): n=177, RA=0.349, DD=54.6%, decay=-19%

Test bỏ từng filter một để tìm sweet spot:
  n ~130-150, DD < 35%, RA > 0.40, walk-forward decay < -25%
"""
import json, datetime
from collections import defaultdict

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FEE = 0.05 / 100
H4 = 4 * 3600 * 1000
SL_INIT=4.0; SL_TRAIL=3.0; SL_TRANS=24
ADX_P=14; ADX_THRESH=20; VOL_MA=10; VOL_MULT=1.2
ATR_PCT_LB=90; DONCHIAN_LB=20; ATR_BREAK_MULT=1.2
EMA_FAST=50; EMA_SLOW=200; MAX_HOLD=200
CD={"S12":36,"S13":1,"S14":36}
WF_CUT = int(datetime.datetime(2023,1,1).timestamp()*1000)

VARIANTS = [
    ("CURRENT  (ATR50+h16+ThuSun)",     {"atr":0.50,"h16":True, "ts":True }),
    ("V1  bỏ ThuSun        (ATR50+h16)",{"atr":0.50,"h16":True, "ts":False}),
    ("V2  bỏ h16           (ATR50+ThuSun)",{"atr":0.50,"h16":False,"ts":True }),
    ("V3  ATR40            (ATR40+h16+ThuSun)",{"atr":0.40,"h16":True, "ts":True }),
    ("V4  ATR40+bỏ ThuSun  (ATR40+h16)",{"atr":0.40,"h16":True, "ts":False}),
    ("V5  ATR40+bỏ h16     (ATR40+ThuSun)",{"atr":0.40,"h16":False,"ts":True }),
    ("SIMPLIFIED(ATR30,no h16,no ThuSun)",{"atr":0.30,"h16":False,"ts":False}),
]

def load_tf(ms):
    raw=json.load(open(CACHE)); b={}
    for c in raw:
        k=c["time"]//ms
        if k not in b: b[k]={"time":k*ms,"high":c["high"],"low":c["low"],"close":c["close"],"volume":c["volume"]}
        else: o=b[k];o["high"]=max(o["high"],c["high"]);o["low"]=min(o["low"],c["low"]);o["close"]=c["close"];o["volume"]+=c["volume"]
    return [b[k] for k in sorted(b)]

def ema_s(xs,n):
    k=2/(n+1);out=[None]*len(xs);e=None
    for i,x in enumerate(xs): e=x if e is None else x*k+e*(1-k);out[i]=e
    return out

def _dm_tr(bars):
    n=len(bars);pdm=[0.0]*n;ndm=[0.0]*n;tr=[0.0]*n
    for i in range(1,n):
        up=bars[i]["high"]-bars[i-1]["high"];dn=bars[i-1]["low"]-bars[i]["low"]
        pdm[i]=up if up>dn and up>0 else 0;ndm[i]=dn if dn>up and dn>0 else 0
        tr[i]=max(bars[i]["high"]-bars[i]["low"],abs(bars[i]["high"]-bars[i-1]["close"]),abs(bars[i]["low"]-bars[i-1]["close"]))
    return pdm,ndm,tr

def adx_wilder(bars,period=ADX_P):
    pdm,ndm,tr=_dm_tr(bars);n=len(bars)
    if n<=period+1: return [None]*n
    smTR=sum(tr[1:period+1]);smPDM=sum(pdm[1:period+1]);smNDM=sum(ndm[1:period+1])
    dx_arr=[];adx_val=None;adx_out=[None]*n
    for i in range(period+1,n):
        smTR=smTR-smTR/period+tr[i];smPDM=smPDM-smPDM/period+pdm[i];smNDM=smNDM-smNDM/period+ndm[i]
        pdi=smPDM/smTR*100 if smTR>0 else 0;ndi=smNDM/smTR*100 if smTR>0 else 0
        dx=abs(pdi-ndi)/(pdi+ndi)*100 if (pdi+ndi)>0 else 0;dx_arr.append(dx)
        if len(dx_arr)<period: continue
        elif len(dx_arr)==period: adx_val=sum(dx_arr)/period
        else: adx_val=(adx_val*(period-1)+dx)/period
        adx_out[i]=adx_val
    return adx_out

def atr_series(bars,period=ADX_P):
    _,_,tr=_dm_tr(bars);n=len(bars);atr=[None]*n
    s=sum(tr[1:period+1]);atr[period]=s/period
    for i in range(period+1,n): atr[i]=(atr[i-1]*(period-1)+tr[i])/period
    return atr

def regime_wp(bars1d,persist_n=3):
    cs=[b["close"] for b in bars1d];n=len(bars1d);raw=["RANGE"]*n
    for i in range(200,n):
        ma200=sum(cs[i-199:i+1])/200;ma50=sum(cs[i-50:i+1])/50
        r20=bars1d[i-19:i+1];ar=sum((b["high"]-b["low"])/b["close"] for b in r20)/20
        if cs[i]<ma200: raw[i]="BEAR"
        elif cs[i]>ma50 and ma50>ma200 and ar>0.04: raw[i]="BULL"
    out=["RANGE"]*n;cur="RANGE";cnt=0;last_raw="RANGE"
    for i in range(n):
        r=raw[i]
        if r==last_raw: cnt+=1
        else: cnt=1;last_raw=r
        if cnt>=persist_n: cur=r
        out[i]=cur
    return out

def main():
    print("Loading..."); bars4h=load_tf(H4);bars1h=load_tf(3600*1000);bars1d=load_tf(86400*1000)
    n=len(bars4h);c4=[b["close"] for b in bars4h]
    print(f"4h bars: {n}  {datetime.datetime.utcfromtimestamp(bars4h[0]['time']/1000):%Y-%m-%d} → {datetime.datetime.utcfromtimestamp(bars4h[-1]['time']/1000):%Y-%m-%d}")

    e50=ema_s(c4,EMA_FAST);e200=ema_s(c4,EMA_SLOW)
    atr4=atr_series(bars4h);adx4=adx_wilder(bars4h)
    e200_1h=ema_s([b["close"] for b in bars1h],200);h1t=[b["time"] for b in bars1h]
    reg1d=regime_wp(bars1d);reg_map={}
    for i,b in enumerate(bars1d): reg_map[b["time"]//86400000]=reg1d[i]
    def get_reg(ts): return reg_map.get(ts//86400000,"RANGE")

    def atp(i): return atr4[i]/c4[i] if atr4[i] else None
    def atp_pass(i,pct):
        if i<ATR_PCT_LB+14: return False
        vs=[atp(j) for j in range(i-ATR_PCT_LB,i) if atp(j) is not None]
        if len(vs)<ATR_PCT_LB: return False
        cur=atp(i); return cur is not None and cur>=sorted(vs)[int(len(vs)*pct)]
    def vol_pass(i):
        if i<VOL_MA: return False
        return bars4h[i]["volume"]>=sum(bars4h[j]["volume"] for j in range(i-VOL_MA,i))/VOL_MA*VOL_MULT
    def e1h_at(ts):
        lo,hi,idx=0,len(h1t)-1,0
        while lo<=hi:
            m=(lo+hi)//2
            if h1t[m]<=ts: idx=m;lo=m+1
            else: hi=m-1
        return e200_1h[idx]
    def utc_h(ts): return datetime.datetime.utcfromtimestamp(ts/1000).hour
    def utc_dow(ts): return datetime.datetime.utcfromtimestamp(ts/1000).weekday()

    def filt(i,cfg):
        adv=adx4[i];adv_p=adx4[i-1] if i>=1 else None
        if adv is None or adv<=ADX_THRESH: return False
        if adv_p is None or adv_p<=ADX_THRESH: return False
        e1h=e1h_at(bars4h[i]["time"])
        if e1h is None or c4[i]<e1h: return False
        if not atp_pass(i,cfg["atr"]): return False
        h=utc_h(bars4h[i]["time"])
        if cfg["h16"] and h==16: return False
        if cfg["ts"]:
            dw=utc_dow(bars4h[i]["time"])
            if dw==3 or dw==6: return False
        return get_reg(bars4h[i]["time"])=="RANGE"

    def sig_s12(i):
        if None in (e50[i],e200[i]) or i<1: return None
        if None in (e50[i-1],e200[i-1]): return None
        return "LONG" if e50[i-1]<=e200[i-1] and e50[i]>e200[i] else None
    def sig_s13(i):
        if atr4[i] is None or i<1: return None
        return "LONG" if c4[i]>bars4h[i-1]["close"]+atr4[i]*ATR_BREAK_MULT else None
    def sig_s14(i):
        if i<DONCHIAN_LB: return None
        hi20=max(bars4h[j]["high"] for j in range(i-DONCHIAN_LB,i))
        return "LONG" if c4[i]>hi20 else None

    sigs={"S12":(sig_s12,False),"S13":(sig_s13,True),"S14":(sig_s14,True)}

    def run(cfg):
        trades=[];last={s:0 for s in sigs}
        for i in range(250,n-MAX_HOLD):
            for sn,(sig_fn,use_vol) in sigs.items():
                if sig_fn(i)!="LONG": continue
                if i-last[sn]<CD[sn]: continue
                if use_vol and not vol_pass(i): continue
                if not filt(i,cfg): continue
                ep=c4[i];ae=atr4[i]
                if ae is None or ae<=0: continue
                sl=ep-ae*SL_INIT;hwm=ep;ret=None
                for h in range(1,MAX_HOLD+1):
                    j=i+h
                    if j>=n: break
                    mult=SL_INIT if h<SL_TRANS else SL_TRAIL
                    if c4[j]>hwm: hwm=c4[j];sl=hwm-ae*mult
                    elif h>=SL_TRANS:
                        t=hwm-ae*SL_TRAIL
                        if t>sl: sl=t
                    if bars4h[j]["low"]<=sl: ret=(sl-ep)/ep-2*FEE;break
                if ret is None: ret=(c4[min(i+MAX_HOLD,n-1)]-ep)/ep-2*FEE
                ts=bars4h[i]["time"];yr=datetime.datetime.utcfromtimestamp(ts/1000).year
                period="test" if ts>=WF_CUT else "train"
                trades.append({"ret":ret,"yr":yr,"period":period,"setup":sn})
                last[sn]=i
        return trades

    def calc_ra(t):
        if not t: return None
        r=[x["ret"] for x in t];m=sum(r)/len(r);sd=(sum((x-m)**2 for x in r)/len(r))**0.5
        return m/sd if sd>0 else 0

    def report(trades,label):
        if not trades: print(f"  {label}: NO TRADES"); return None
        rets=[t["ret"] for t in trades];n_=len(rets)
        mean=sum(rets)/n_;sd=(sum((r-mean)**2 for r in rets)/n_)**0.5 or 1e-9
        ra=mean/sd;wr=sum(1 for r in rets if r>0)/n_*100
        wins=[r for r in rets if r>0];losses=[r for r in rets if r<=0]
        rr=(sum(wins)/len(wins) if wins else 0)/abs(sum(losses)/len(losses) if losses else 1e-9)
        by_yr=defaultdict(float)
        for t in trades: by_yr[t["yr"]]+=t["ret"]
        pos=sum(1 for v in by_yr.values() if v>0)
        eq=0;pk=0;dd=0
        for t in sorted(trades,key=lambda x:x["yr"]): eq+=t["ret"];pk=max(pk,eq);dd=max(dd,pk-eq)
        yr_str=" ".join(f"{y}:{by_yr[y]*100:+.0f}%" for y in sorted(by_yr))
        train=[t for t in trades if t["period"]=="train"];test=[t for t in trades if t["period"]=="test"]
        ra_tr=calc_ra(train);ra_te=calc_ra(test)
        decay=(ra_te-ra_tr)/abs(ra_tr)*100 if ra_tr else None
        decay_flag="✅" if decay and decay>=-30 else "⚠️"
        print(f"\n  {label}")
        print(f"  n={n_:4d}  RA={ra:+.3f}  WR={wr:.0f}%  R:R={rr:.2f}  DD={dd*100:.1f}%  stab={pos}/{len(by_yr)}")
        print(f"  yr: {yr_str}")
        if ra_tr and ra_te:
            print(f"  WF:  TRAIN RA={ra_tr:+.3f}(n={len(train)}) → TEST RA={ra_te:+.3f}(n={len(test)}) decay={decay:+.0f}% {decay_flag}")
        return {"ra":ra,"n":n_,"dd":dd,"stab":pos,"stab_n":len(by_yr),"ra_tr":ra_tr,"ra_te":ra_te,"decay":decay}

    print("\n"+"="*65)
    results=[]
    for label,cfg in VARIANTS:
        r=report(run(cfg),label)
        if r: results.append((label,r))

    print("\n"+"="*65)
    print("RANKING — sorted by TEST RA (out-of-sample performance)")
    print("="*65)
    results_sorted=sorted(results,key=lambda x:x[1]["ra_te"] or 0,reverse=True)
    print(f"\n  {'Config':45s}  {'n':>5}  {'RA':>7}  {'TEST_RA':>9}  {'DD':>6}  {'decay':>7}")
    for label,r in results_sorted:
        flag=" ⭐" if r==results_sorted[0][1] else ""
        print(f"  {label:45s}  {r['n']:>5}  {r['ra']:>+7.3f}  {r['ra_te']:>+9.3f}  {r['dd']*100:>5.1f}%  {r['decay']:>+6.0f}%{flag}")

    print(f"\n  Sweet spot target: n ~130-150, DD <35%, RA >0.40, decay >-25%")
    good=[l for l,r in results if r['n']>=120 and r['dd']<0.35 and r['ra']>=0.40]
    if good:
        print(f"  ✅ Candidates: {', '.join(good)}")
    else:
        print(f"  ⚠️  Không có config nào đạt tất cả criteria — xem ranking above")


if __name__ == "__main__":
    main()
