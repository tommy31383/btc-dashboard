#!/usr/bin/env python3
"""
audit-hour-7y.py — Per-hour UTC audit 7y LONG entries (extend L2 methodology).
Tìm thêm giờ xấu ngoài h=8 đã biết.
Config: v0.4.51 LONG only, SL ATR×4→×3, net-of-cost 0.05%/side.
"""
import json, math, datetime
from collections import defaultdict

CACHE="/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FEE=0.05/100; H4=4*3600*1000; MAX_HOLD=200; SL_I=4.0; SL_T=3.0; SL_TR=12
ADX_P=14; VOL_MA=10; VOL_MULT=1.2; ATR_PCT_LB=90; ATR_PCT_PCTL=0.30
DONCHIAN_LB=20; ATR_BM=1.5; EF=50; ES=200

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
    c4=[b["close"] for b in bars4h]; n=len(bars4h)
    e50=ema_s(c4,EF); e200=ema_s(c4,ES); atr4=atr_s(bars4h); adx4=adx_s(bars4h)
    e200_1h=ema_s([b["close"] for b in bars1h],200)
    h1t=[b["time"] for b in bars1h]
    reg_map={}
    for i,b in enumerate(bars1d): reg_map[b["time"]//86400000]=regime_s(bars1d)[i]
    def get_reg(ts): return reg_map.get(ts//86400000,"RANGE")
    def atp(i): return atr4[i]/c4[i] if atr4[i] else None
    def atp_pass(i):
        if i<ATR_PCT_LB: return False
        vs=[atp(j) for j in range(i-ATR_PCT_LB,i) if atp(j)]
        return bool(vs) and atp(i) is not None and atp(i)>=sorted(vs)[int(len(vs)*ATR_PCT_PCTL)]
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
    def filt(i, skip_h=None):
        if adx4[i] is None or adx4[i]<=20: return False
        if i>=1 and (adx4[i-1] is None or adx4[i-1]<=20): return False
        e1h=e200_1h_at(bars4h[i]["time"])
        if e1h is None or c4[i]<e1h: return False
        if not atp_pass(i): return False
        hr=datetime.datetime.utcfromtimestamp(bars4h[i]["time"]/1000).hour
        if hr==8: return False   # always skip h=8
        if skip_h is not None and hr==skip_h: return False
        if get_reg(bars4h[i]["time"])=="BEAR": return False
        return True
    def sig_s12(i):
        if None in (e50[i],e200[i],e50[i-1],e200[i-1]): return False
        return e50[i-1]<=e200[i-1] and e50[i]>e200[i]
    def sig_s13(i):
        return atr4[i] is not None and i>=1 and c4[i]>bars4h[i-1]["close"]+atr4[i]*ATR_BM
    def sig_s14(i):
        if i<DONCHIAN_LB: return False
        return c4[i]>max(bars4h[j]["high"] for j in range(i-DONCHIAN_LB,i))
    def sim(ei):
        ep=c4[ei]; ae=atr4[ei]
        if ae is None or ae<=0: return None
        sl=ep-ae*SL_I; hwm=ep
        for h in range(1,MAX_HOLD+1):
            j=ei+h
            if j>=n: break
            mult=SL_I if h<SL_TR else SL_T
            if c4[j]>hwm: hwm=c4[j]; sl=hwm-ae*mult
            elif h>=SL_TR:
                t=hwm-ae*SL_T;
                if t>sl: sl=t
            if bars4h[j]["low"]<=sl: return (sl-ep)/ep-2*FEE
        return (c4[min(ei+MAX_HOLD,n-1)]-ep)/ep-2*FEE

    # Collect all LONG trades per hour (baseline: skip h=8 only)
    CD={"S12":36,"S13":1,"S14":36}
    hour_trades=defaultdict(list)
    last={"S12":0,"S13":0,"S14":0}
    for i in range(250,n-MAX_HOLD):
        hr=datetime.datetime.utcfromtimestamp(bars4h[i]["time"]/1000).hour
        fired=False
        for sn,sfn,dv in [("S12",sig_s12,False),("S13",sig_s13,True),("S14",sig_s14,True)]:
            if not sfn(i): continue
            if i-last[sn]<CD[sn]: continue
            if dv and not vol_pass(i): continue
            if not filt(i): continue
            r=sim(i)
            if r is None: continue
            hour_trades[hr].append(r)
            last[sn]=i; fired=True
        # Note: multiple setups can fire same bar same hour — tracked per setup above

    print("=== Per-hour LONG performance (baseline, skip h=8) ===")
    print(f"{'Hour':>6} {'n':>5} {'WR':>6} {'mean%':>8} {'RA':>8} {'total%':>9}  verdict")
    print("-"*65)
    SKIP_HOURS=[8]  # already known
    candidates=[]
    all_ra=[]
    for hr in range(24):
        ts=hour_trades[hr]
        if not ts: print(f"  h={hr:02d}  n=  0  —"); continue
        mean=sum(ts)/len(ts); sd=(sum((x-mean)**2 for x in ts)/len(ts))**0.5 or 1e-9
        ra=mean/sd; wr=sum(1 for x in ts if x>0)/len(ts)*100; total=sum(ts)*100
        flag="⚠️ BAD" if ra<-0.05 and len(ts)>=5 else ("" if hr!=8 else "⛔ SKIP(known)")
        print(f"  h={hr:02d}  n={len(ts):3d}  WR={wr:4.0f}%  mean={mean*100:+5.2f}%  RA={ra:+6.3f}  tot={total:+6.1f}%  {flag}")
        if ra<-0.05 and len(ts)>=5 and hr!=8: candidates.append((hr,ra,len(ts),total))
        all_ra.append((hr,ra,len(ts)))

    print(f"\n=== Candidate hours to SKIP (RA<-0.05, n≥5, excl h=8) ===")
    if candidates:
        for hr,ra,n_,tot in sorted(candidates,key=lambda x:x[1]):
            print(f"  h={hr:02d}  RA={ra:+.3f}  n={n_}  total={tot:+.1f}%  → candidate SKIP")
    else:
        print("  Không có candidate nào đủ tiêu chuẩn — h=8 là giờ duy nhất xấu")

