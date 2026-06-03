#!/usr/bin/env python3
"""iter7 Tasks 2/3/4 — TAMED reversal sleeve on ETH & SOL (3y), + multi-asset reversal book.

EXACT tamed config from iter6 = ALL-regime | atr2.0 | maxhold=200(33d) | 1pos | vol-target floor0.40.
Technical-only RCI (the selected tamed config uses no funding). BTC run on matched 3y window for fair corr.

Judge: Sharpe + DOLLARS + Calmar. >=4/6 half-years... here per-YEAR with 3y => need >=2/3 (loose) but
we report all years honestly. Corr of ETH/SOL reversal vs BTC reversal monthly.
"""
import json, datetime, math
from collections import defaultdict

FEE=0.05/100; H4=4*3600*1000; CAP=100000
COOLDOWN=12; ATP_LB=180

def load_tf(raw, ms):
    b={}
    for c in raw:
        k=c["time"]//ms
        if k not in b: b[k]={"time":k*ms,"open":c["open"],"high":c["high"],"low":c["low"],"close":c["close"],"volume":c["volume"]}
        else:
            o=b[k]; o["high"]=max(o["high"],c["high"]); o["low"]=min(o["low"],c["low"]); o["close"]=c["close"]; o["volume"]+=c["volume"]
    return [b[k] for k in sorted(b)]
def _tr(bars):
    n=len(bars); tr=[0.0]*n
    for i in range(1,n):
        tr[i]=max(bars[i]["high"]-bars[i]["low"],abs(bars[i]["high"]-bars[i-1]["close"]),abs(bars[i]["low"]-bars[i-1]["close"]))
    return tr
def atr_series(bars,period=14):
    tr=_tr(bars); n=len(bars); atr=[None]*n
    if n<=period: return atr
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
def mo_of(ts): return datetime.datetime.utcfromtimestamp(ts/1000).strftime("%Y-%m")

class Asset:
    def __init__(self,path,name):
        raw=json.load(open(path)); raw.sort(key=lambda x:x["time"])
        self.name=name
        self.bars4h=load_tf(raw,H4); bars1d=load_tf(raw,86400*1000)
        self.n=len(self.bars4h); self.c4=[b["close"] for b in self.bars4h]
        self.atr4=atr_series(self.bars4h,14)
        self.rsi4=rsi_series(self.c4,14); self.stk4=stoch_k(self.bars4h,14); self.bb4=bb_pctb(self.c4,20)
        regime_1d=regime_persist(bars1d)
        self.reg_map={b["time"]//86400000:regime_1d[i] for i,b in enumerate(bars1d)}
    def get_reg(self,ts): return self.reg_map.get(ts//86400000,"RANGE")
    def atp(self,i): return None if self.atr4[i] is None else self.atr4[i]/self.c4[i]
    def atp_pctile(self,i):
        if i<ATP_LB+14: return None
        cur=self.atp(i)
        if cur is None: return None
        vs=[self.atp(j) for j in range(i-ATP_LB,i) if self.atp(j) is not None]
        if len(vs)<ATP_LB//2: return None
        return sum(1 for v in vs if v<cur)/len(vs)
    def is_rci_top(self,i):
        if None in (self.rsi4[i],self.stk4[i],self.bb4[i]): return False
        return self.rsi4[i]>70 and self.stk4[i]>80 and self.bb4[i]>0.95
    def oversold(self,i):
        if None in (self.rsi4[i],self.stk4[i],self.bb4[i]): return False
        return self.rsi4[i]<30 and self.stk4[i]<20 and self.bb4[i]<0.05
    def sim(self,ei,atr_mult,max_hold):
        ep=self.c4[ei]; ae=self.atr4[ei]
        if ae is None or ae<=0: return None
        stop=ep-ae*atr_mult
        for h in range(1,max_hold+1):
            j=ei+h
            if j>=self.n: break
            if self.bars4h[j]["low"]<=stop: return (stop-ep)/ep-2*FEE,h,"SL"
            if self.is_rci_top(j): return (self.c4[j]-ep)/ep-2*FEE,h,"RCITOP"
        j=min(ei+max_hold,self.n-1)
        return (self.c4[j]-ep)/ep-2*FEE,max_hold,"MAXHOLD"
    def run(self,regimes={"RANGE","BULL","BEAR"},atr_mult=2.0,max_hold=200,one_pos=True,vol_target=True,vt_floor=0.40):
        trades=[]; last=-10**9; open_until=-1
        for i in range(250,self.n-1):
            ts=self.bars4h[i]["time"]
            if self.get_reg(ts) not in regimes: continue
            if not self.oversold(i): continue
            if i-last<COOLDOWN: continue
            if one_pos and i<open_until: continue
            r=self.sim(i,atr_mult,max_hold)
            if r is None: continue
            ret,h,reason=r
            size=1.0
            if vol_target:
                pc=self.atp_pctile(i)
                if pc is not None: size=max(vt_floor,1.0-pc)
            yr=datetime.datetime.utcfromtimestamp(ts/1000).year
            trades.append({"ret":ret,"sret":ret*size,"size":size,"h":h,"yr":yr,"exit":reason,"bar":i,
                           "ts":ts,"close_mo":mo_of(self.bars4h[min(i+h,self.n-1)]["time"])})
            last=i; open_until=i+h
        return trades

def stats(trades,label,use_size=True):
    if not trades:
        print(f"  [{label}] NO TRADES"); return None
    key="sret" if use_size else "ret"
    rets=[t[key] for t in trades]; nt=len(rets); mean=sum(rets)/nt
    sd=(sum((r-mean)**2 for r in rets)/nt)**0.5 or 1e-9; ra=mean/sd
    yrs=len(set(t["yr"] for t in trades)); sharpe=ra*math.sqrt(nt/max(yrs,1))
    wr=sum(1 for r in rets if r>0)/nt*100
    roi=sum(rets)*100; dollars=CAP*sum(rets)
    eq=0;peak=0;mdd=0
    for t in sorted(trades,key=lambda x:x["bar"]):
        eq+=t[key]; peak=max(peak,eq); mdd=max(mdd,peak-eq)
    by_yr=defaultdict(float)
    for t in trades: by_yr[t["yr"]]+=t[key]
    pos=sum(1 for v in by_yr.values() if v>0)
    yr_str=" ".join(f"{y}:{by_yr[y]*100:+.0f}" for y in sorted(by_yr))
    mdd_pct=mdd*100; calmar=roi/mdd_pct if mdd_pct>0 else 0
    print(f"  [{label}] n={nt} RA={ra:+.3f} Sh={sharpe:+.2f} WR={wr:.0f}% ROI={roi:+.0f}% ${dollars:+,.0f} DD={mdd_pct:.0f}% Calmar={calmar:.2f} stab={pos}/{len(by_yr)}")
    print(f"       yr: {yr_str}")
    return {"n":nt,"ra":ra,"sharpe":sharpe,"wr":wr,"roi":roi,"dollars":dollars,"mdd":mdd_pct,"calmar":calmar,"stab":pos,"nyr":len(by_yr),"trades":trades}

def monthly(trades):
    mo=defaultdict(float)
    for t in trades: mo[t["close_mo"]]+=t["sret"]
    return mo
def pearson(x,y):
    n=len(x); mx=sum(x)/n; my=sum(y)/n
    cov=sum((x[i]-mx)*(y[i]-my) for i in range(n))/n
    sx=(sum((v-mx)**2 for v in x)/n)**0.5; sy=(sum((v-my)**2 for v in y)/n)**0.5
    return cov/(sx*sy) if sx>0 and sy>0 else 0
def msharpe(s):
    n=len(s); m=sum(s)/n; d=(sum((v-m)**2 for v in s)/n)**0.5 or 1e-9; return m/d*math.sqrt(12)
def msd(s):
    n=len(s); m=sum(s)/n; return (sum((v-m)**2 for v in s)/n)**0.5 or 1e-9
def mmdd(s):
    eq=0;peak=0;d=0
    for v in s: eq+=v; peak=max(peak,eq); d=max(d,peak-eq)
    return d*100

C=".cache/"
print("Loading assets (BTC 7y, ETH 3y, SOL 3y)...")
btc=Asset(C+"binance-5m-7y.json","BTC")
eth=Asset(C+"binance-eth-5m-3y.json","ETH")
sol=Asset(C+"binance-sol-5m-3y.json","SOL")

print("\n"+"="*80)
print("TAMED reversal sleeve (ALL|atr2.0|33d|1pos|vt) per asset")
print("="*80)
print("\n-- BTC full 7y (reference) --")
btc_full=btc.run(); stats(btc_full,"BTC-7y")
# BTC restricted to ETH/SOL window (2023-05->) for fair corr
WIN_START=eth.bars4h[250]["time"]
btc_3y=[t for t in btc_full if t["ts"]>=WIN_START]
print("\n-- BTC 3y window (matched to ETH/SOL) --"); stats(btc_3y,"BTC-3y")
print("\n-- ETH 3y (Task 2) --"); ethr=eth.run(); ev=stats(ethr,"ETH-3y")
print("\n-- SOL 3y (Task 3) --"); solr=sol.run(); sv=stats(solr,"SOL-3y")

# correlations on common months (3y window)
mB=monthly(btc_3y); mE=monthly(ethr); mS=monthly(solr)
allmo=sorted(set(mB)|set(mE)|set(mS))
B=[mB.get(m,0) for m in allmo]; E=[mE.get(m,0) for m in allmo]; S=[mS.get(m,0) for m in allmo]
print("\n"+"="*80); print("CORRELATIONS (monthly, 3y window)"); print("="*80)
print(f"  ETH-rev vs BTC-rev: {pearson(E,B):+.3f}")
print(f"  SOL-rev vs BTC-rev: {pearson(S,B):+.3f}")
print(f"  ETH-rev vs SOL-rev: {pearson(E,S):+.3f}")

print("\n"+"="*80); print("TASK 4 — MULTI-ASSET REVERSAL BOOK (risk-parity across assets)"); print("="*80)
def book(series,labels,title):
    n=len(series[0]); sds=[msd(s) for s in series]; w=[1/x for x in sds]; sw=sum(w); w=[x/sw for x in w]
    comb=[sum(w[k]*series[k][i] for k in range(len(series))) for i in range(n)]
    print(f"  {title}")
    print(f"    weights: "+" ".join(f"{labels[k]}={w[k]:.2f}" for k in range(len(labels))))
    print(f"    Sharpe {msharpe(comb):+.2f}  MaxDD {mmdd(comb):.0f}  totalR {sum(comb)*100:+.0f}%")
    return comb
print()
book([B],["BTC"],"BTC-only reversal (baseline standalone, 3y window):")
print()
book([B,E],["BTC","ETH"],"BTC+ETH reversal:")
print()
ma=book([B,E,S],["BTC","ETH","SOL"],"BTC+ETH+SOL reversal (multi-asset sleeve):")
print()
print("  Compare standalone monthly Sharpe / DD:")
print(f"    BTC-rev alone : Sharpe {msharpe(B):+.2f}  DD {mmdd(B):.0f}")
print(f"    ETH-rev alone : Sharpe {msharpe(E):+.2f}  DD {mmdd(E):.0f}")
print(f"    SOL-rev alone : Sharpe {msharpe(S):+.2f}  DD {mmdd(S):.0f}")
print(f"    Multi-asset   : Sharpe {msharpe(ma):+.2f}  DD {mmdd(ma):.0f}")
