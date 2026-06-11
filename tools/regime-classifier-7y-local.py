#!/usr/bin/env python3
"""
regime-classifier-7y-local.py — 7y local run of regime-classifier-upgrade, fed from
binance-1h-7y.json (aggregates to 4h/1d). Faithful hedge01 v0.4.79 + turtle, classifier
gating on the BEAR definition. Adds an E-threshold sweep (drawdown classifier).

Classifiers (BULL identical; only BEAR def changes):
  A   close<MA200                      (current regime.ts baseline)
  B   close<MA200 & close<MA50
  C   close<MA200 & MA50<MA200         (death-cross)
  D   close<MA200 & MA200 slope<0
  E   drawdown>20%   E15 >15%  E25 >25%  E30 >30%

Guard: 2022 & 2026 (real bears) must stay near baseline A (protection). Improvement must
come from false-bear years 2019/2020/2021/2023/2024/2025.
"""
import json, datetime, math, os
from collections import defaultdict

CACHE = os.path.join(os.path.dirname(__file__), "..", ".cache", "binance-1h-7y.json")
FUNDING = os.path.join(os.path.dirname(__file__), "..", ".cache", "binance-funding-7y.json")
H4 = 4*3600*1000; DAY = 86400000

SL_INIT=3.0; SL_TRAIL=3.5; SL_TRANS=16
ADX_P=14; ADX_THRESH=18; ADX_PREV_THRESH=12
VOL_MA=16; VOL_MULT=1.4
ATR_PCT_LB=90; ATR_PCT_PCTL=0.50
DONCHIAN_LB=18; ATR_BREAK_MULT=1.3
EMA_FAST=50; EMA_SLOW=200; MAX_HOLD=200
FUNDING_BLOCK=0.0005
CD={"S12":36,"S13":1,"S14":36}
FEE=0.0005; WALLET=100000.0
T_DON_ENTRY=20; T_DON_EXIT=10; T_CUT=1.5; T_FEE=0.0005; T_QTY=0.003
PERSIST=3; SLOPE_LB=30
E_THR={"E":0.20,"E15":0.15,"E25":0.25,"E30":0.30}

def load_tf(raw, ms):
    b={}
    for c in raw:
        k=c["time"]//ms
        if k not in b: b[k]={"time":k*ms,"high":c["high"],"low":c["low"],"close":c["close"],"volume":c["volume"]}
        else:
            o=b[k]; o["high"]=max(o["high"],c["high"]); o["low"]=min(o["low"],c["low"]); o["close"]=c["close"]; o["volume"]+=c["volume"]
    return [b[k] for k in sorted(b)]

def ema_s(xs,n):
    k=2/(n+1); out=[None]*len(xs); e=None
    for i,x in enumerate(xs): e=x if e is None else x*k+e*(1-k); out[i]=e
    return out

def _dm_tr(bars):
    n=len(bars); pdm=[0.]*n; ndm=[0.]*n; tr=[0.]*n
    for i in range(1,n):
        up=bars[i]["high"]-bars[i-1]["high"]; dn=bars[i-1]["low"]-bars[i]["low"]
        pdm[i]=up if up>dn and up>0 else 0; ndm[i]=dn if dn>up and dn>0 else 0
        tr[i]=max(bars[i]["high"]-bars[i]["low"],abs(bars[i]["high"]-bars[i-1]["close"]),abs(bars[i]["low"]-bars[i-1]["close"]))
    return pdm,ndm,tr

def adx_wilder(bars,period=ADX_P):
    pdm,ndm,tr=_dm_tr(bars); n=len(bars)
    if n<=period+1: return [None]*n
    smTR=sum(tr[1:period+1]); smPDM=sum(pdm[1:period+1]); smNDM=sum(ndm[1:period+1])
    dx=[]; adx=None; out=[None]*n
    for i in range(period+1,n):
        smTR+=-smTR/period+tr[i]; smPDM+=-smPDM/period+pdm[i]; smNDM+=-smNDM/period+ndm[i]
        pdi=smPDM/smTR*100 if smTR>0 else 0; ndi=smNDM/smTR*100 if smTR>0 else 0
        d=abs(pdi-ndi)/(pdi+ndi)*100 if (pdi+ndi)>0 else 0; dx.append(d)
        if len(dx)<period: continue
        elif len(dx)==period: adx=sum(dx)/period
        else: adx=(adx*(period-1)+d)/period
        out[i]=adx
    return out

def atr_series(bars,period=ADX_P):
    _,_,tr=_dm_tr(bars); n=len(bars); a=[None]*n; a[period]=sum(tr[1:period+1])/period
    for i in range(period+1,n): a[i]=(a[i-1]*(period-1)+tr[i])/period
    return a

def atr_w_daily(bars,p=14):
    m=len(bars); tr=[0.]*m
    for i in range(1,m): tr[i]=max(bars[i]["high"]-bars[i]["low"],abs(bars[i]["high"]-bars[i-1]["close"]),abs(bars[i]["low"]-bars[i-1]["close"]))
    o=[None]*m; o[p]=sum(tr[1:p+1])/p
    for i in range(p+1,m): o[i]=(o[i-1]*(p-1)+tr[i])/p
    return o

def _persist(raw,pn=PERSIST):
    n=len(raw); out=["RANGE"]*n; cur="RANGE"; cnt=0; lr="RANGE"
    for i in range(n):
        if raw[i]==lr: cnt+=1
        else: cnt=1; lr=raw[i]
        if cnt>=pn: cur=raw[i]
        out[i]=cur
    return out

def classify(b1d,mode,persist=PERSIST):
    cs=[b["close"] for b in b1d]; n=len(b1d); raw=["RANGE"]*n; rh=[None]*n
    for i in range(n): rh[i]=max(cs[max(0,i-365):i+1])
    for i in range(200,n):
        ma200=sum(cs[i-199:i+1])/200; ma50=sum(cs[i-49:i+1])/50
        r20=b1d[i-19:i+1]; ar=sum((x["high"]-x["low"])/x["close"] for x in r20)/20
        ma200p=sum(cs[i-199-SLOPE_LB:i+1-SLOPE_LB])/200 if i>=199+SLOPE_LB else ma200
        dd=(rh[i]-cs[i])/rh[i]
        bull=cs[i]>ma50 and ma50>ma200 and ar>0.04
        if mode=="A": bear=cs[i]<ma200
        elif mode=="B": bear=cs[i]<ma200 and cs[i]<ma50
        elif mode=="C": bear=cs[i]<ma200 and ma50<ma200
        elif mode=="D": bear=cs[i]<ma200 and ma200<ma200p
        elif mode in E_THR: bear=dd>E_THR[mode]
        else: raise ValueError(mode)
        if bear: raw[i]="BEAR"
        elif bull: raw[i]="BULL"
    return _persist(raw,persist)

print("Loading 1h 7y -> 4h/1h/1d...")
RAW=json.load(open(CACHE)); RAW.sort(key=lambda x:x["time"])
bars4h=load_tf(RAW,H4); bars1h=load_tf(RAW,3600*1000); bars1d=load_tf(RAW,DAY)
n=len(bars4h); c4=[b["close"] for b in bars4h]
try: fr=sorted(json.load(open(FUNDING)),key=lambda x:x["time"]); print(f"  funding {len(fr)} pts")
except Exception as e: fr=[]; print(f"  funding MISSING ({e})")
ft=[f["time"] for f in fr]; frate=[f["rate"] for f in fr]
def funding_at(ts):
    lo,hi,idx=0,len(ft)-1,0
    while lo<=hi:
        m=(lo+hi)//2
        if ft[m]<=ts: idx=m; lo=m+1
        else: hi=m-1
    return frate[idx] if ft else 0.0

e50=ema_s(c4,EMA_FAST); e200=ema_s(c4,EMA_SLOW); atr4=atr_series(bars4h); adx4=adx_wilder(bars4h)
e200_1h=ema_s([b["close"] for b in bars1h],200); h1t=[b["time"] for b in bars1h]
BD=bars1d; nd=len(BD); CD_=[x["close"] for x in BD]; atr_d=atr_w_daily(BD)
dhi_e=[None]*nd; dlo_x=[None]*nd
for i in range(T_DON_ENTRY,nd): dhi_e[i]=max(BD[j]["high"] for j in range(i-T_DON_ENTRY,i))
for i in range(T_DON_EXIT,nd):  dlo_x[i]=min(BD[j]["low"] for j in range(i-T_DON_EXIT,i))
print(f"4h bars: {n}  {datetime.datetime.utcfromtimestamp(bars4h[0]['time']/1000):%Y-%m-%d} -> {datetime.datetime.utcfromtimestamp(bars4h[-1]['time']/1000):%Y-%m-%d}")

CLASSIFIERS=["A","B","C","D","E","E15","E25","E30"]
LABELS={m:classify(bars1d,m) for m in CLASSIFIERS}
REGMAP={m:{BD[i]["time"]//DAY:LABELS[m][i] for i in range(nd)} for m in CLASSIFIERS}
def get_reg(m,ts): return REGMAP[m].get(ts//DAY,"RANGE")

def atp(i): return None if atr4[i] is None else atr4[i]/c4[i]
def atp_pass(i):
    if i<ATR_PCT_LB+14: return False
    vs=[atp(j) for j in range(i-ATR_PCT_LB,i) if atp(j) is not None]
    if len(vs)<ATR_PCT_LB: return False
    cur=atp(i)
    return cur is not None and cur>=sorted(vs)[int(len(vs)*ATR_PCT_PCTL)]
def vol_pass(i):
    if i<VOL_MA: return False
    ma=sum(bars4h[j]["volume"] for j in range(i-VOL_MA,i))/VOL_MA
    return bars4h[i]["volume"]>=ma*VOL_MULT
def e200_1h_at(ts):
    lo,hi,idx=0,len(h1t)-1,0
    while lo<=hi:
        m=(lo+hi)//2
        if h1t[m]<=ts: idx=m; lo=m+1
        else: hi=m-1
    return e200_1h[idx]
def uh(ts): return datetime.datetime.utcfromtimestamp(ts/1000).hour
def ud(ts): return datetime.datetime.utcfromtimestamp(ts/1000).weekday()
def filt(i,mode):
    a=adx4[i]
    if a is None or a<=ADX_THRESH: return False
    ap=adx4[i-1] if i>=1 else None
    if ap is None or ap<=ADX_PREV_THRESH: return False
    e1=e200_1h_at(bars4h[i]["time"])
    if e1 is None or c4[i]<e1: return False
    if not atp_pass(i): return False
    if uh(bars4h[i]["time"])==16: return False
    dw=ud(bars4h[i]["time"])
    if dw in (3,6): return False
    if get_reg(mode,bars4h[i]["time"])=="BEAR": return False
    if funding_at(bars4h[i]["time"])>FUNDING_BLOCK: return False
    return True
def s12(i):
    if None in (e50[i],e200[i]) or i<1 or None in (e50[i-1],e200[i-1]): return None
    return "LONG" if (e50[i-1]<=e200[i-1] and e50[i]>e200[i]) else None
def s13(i):
    if atr4[i] is None or i<1: return None
    return "LONG" if c4[i]>bars4h[i-1]["close"]+atr4[i]*ATR_BREAK_MULT else None
def s14(i):
    if i<DONCHIAN_LB: return None
    return "LONG" if c4[i]>max(bars4h[j]["high"] for j in range(i-DONCHIAN_LB,i)) else None
sigs={"S12":s12,"S13":s13,"S14":s14}; do_vol={"S12":False,"S13":True,"S14":True}
def h1_sim(ei):
    ep=c4[ei]; ae=atr4[ei]
    if ae is None or ae<=0: return None
    sl=ep-ae*SL_INIT; hwm=ep
    for h in range(1,MAX_HOLD+1):
        j=ei+h
        if j>=n: break
        mult=SL_INIT if h<SL_TRANS else SL_TRAIL
        if c4[j]>hwm: hwm=c4[j]; sl=hwm-ae*mult
        elif h>=SL_TRANS:
            t=hwm-ae*SL_TRAIL
            if t>sl: sl=t
        if bars4h[j]["low"]<=sl: return (sl-ep)/ep-2*FEE,h,j
    j=min(ei+MAX_HOLD,n-1); return (c4[j]-ep)/ep-2*FEE,MAX_HOLD,j
def run_h01(mode):
    tr=[]; last={s:0 for s in CD}
    for i in range(250,n-MAX_HOLD):
        for sn in ["S12","S13","S14"]:
            if sigs[sn](i)!="LONG": continue
            if i-last[sn]<CD[sn]: continue
            if do_vol[sn] and not vol_pass(i): continue
            if not filt(i,mode): continue
            r=h1_sim(i)
            if r is None: continue
            ret,h,_=r
            tr.append({"ret":ret,"yr":datetime.datetime.utcfromtimestamp(bars4h[i]["time"]/1000).year,"t_in":bars4h[i]["time"]}); last[sn]=i
    return tr
def h1_stats(t):
    r=[x["ret"] for x in t]; nn=len(r)
    if nn==0: return dict(n=0,sharpe=0,ra=0,wr=0,roi=0,dollars=0,mdd=0,by_yr={},stab=0,ny=0)
    mean=sum(r)/nn; sd=(sum((x-mean)**2 for x in r)/nn)**0.5 or 1e-9; ra=mean/sd
    yrs=(t[-1]["t_in"]-t[0]["t_in"])/(365.25*DAY) or 1; sharpe=ra*math.sqrt(nn/yrs)
    eq=0;pk=0;mdd=0
    for x in r: eq+=x;pk=max(pk,eq);mdd=max(mdd,pk-eq)
    by=defaultdict(float)
    for x in t: by[x["yr"]]+=x["ret"]
    return dict(n=nn,sharpe=sharpe,ra=ra,wr=sum(1 for x in r if x>0)/nn*100,roi=sum(r)*100,
                dollars=sum(r)*WALLET,mdd=mdd*100,by_yr=dict(by),stab=sum(1 for v in by.values() if v>0),ny=len(by))
def run_turtle(mode):
    W=max(T_DON_ENTRY,200); pnl=[0.0]*nd; hold=False; ep=0;ea=0
    for i in range(W,nd):
        if hold:
            pnl[i]=T_QTY*(CD_[i]-CD_[i-1]); ex=False
            if T_CUT>0 and BD[i]["low"]<=ep-ea*T_CUT: ex=True
            elif dlo_x[i] is not None and CD_[i]<dlo_x[i]: ex=True
            if ex: pnl[i]-=T_FEE*CD_[i]*T_QTY; hold=False
        if not hold:
            pb=(i>=1 and LABELS[mode][i-1]=="BEAR")
            if dhi_e[i] is not None and CD_[i]>dhi_e[i] and not pb:
                hold=True; ep=CD_[i]; ea=atr_d[i] or 0; pnl[i]-=T_FEE*CD_[i]*T_QTY
    return pnl,W
def t_stats(pnl,W):
    s=pnl[W:nd]; eq=[];a=0.0
    for x in s: a+=x; eq.append(a)
    mean=sum(s)/len(s); sd=(sum((x-mean)**2 for x in s)/len(s))**0.5 or 1e-9
    pk=-1e18;mdd=0
    for v in eq: pk=max(pk,v); mdd=max(mdd,pk-v)
    by=defaultdict(float)
    for i in range(W,nd): by[datetime.datetime.utcfromtimestamp(BD[i]["time"]/1000).year]+=pnl[i]
    return dict(total=a,sharpe=mean/sd*math.sqrt(365),mdd=mdd,by_yr=dict(by),stab=sum(1 for v in by.values() if v>0),ny=len(by))

# windows
labA=LABELS["A"]; wins=[]; i=0
while i<nd:
    if labA[i]=="BEAR":
        j=i
        while j<nd and labA[j]=="BEAR": j+=1
        wins.append((i,j-1)); i=j
    else: i+=1
def realbear(s,e):
    p0=CD_[s]; lo=min(CD_[s:min(s+60,nd-1)+1]); return (p0-lo)/p0>=0.20
real=[w for w in wins if w[1]-w[0]+1>=3 and realbear(*w)]
false=[w for w in wins if w[1]-w[0]+1>=3 and not realbear(*w)]
rd=set(k for s,e in real for k in range(s,e+1)); fd=set(k for s,e in false for k in range(s,e+1))

print("\n"+"="*84); print("TASK A — classifier A (MA200) BEAR windows: real vs false"); print("="*84)
for s,e in wins:
    if e-s+1<3: continue
    d0=datetime.datetime.utcfromtimestamp(BD[s]["time"]/1000).strftime("%Y-%m-%d")
    d1=datetime.datetime.utcfromtimestamp(BD[e]["time"]/1000).strftime("%Y-%m-%d")
    print(f"  {d0}->{d1} ({e-s+1:>3}d)  {'REAL bear' if realbear(s,e) else 'false (recover)'}")
print(f"\n  real-bear days={len(rd)}  false-bear days={len(fd)}")
print(f"\n  {'cls':>4} | {'BEARd':>6} | {'realCaught':>12} | {'falseKept':>10} | {'falseCut':>8}")
for m in CLASSIFIERS:
    lab=LABELS[m]; tb=sum(1 for i in range(nd) if lab[i]=="BEAR")
    rc=sum(1 for k in rd if lab[k]=="BEAR"); fk=sum(1 for k in fd if lab[k]=="BEAR")
    print(f"  {m:>4} | {tb:>6} | {rc:>4}/{len(rd):<6} | {fk:>4}/{len(fd):<5} | {len(fd)-fk:>8}")

res={}
for m in CLASSIFIERS:
    h=h1_stats(run_h01(m)); pt,W=run_turtle(m); res[m]=(h,t_stats(pt,W))

print("\n"+"="*84); print("TASK B — hedge01 v0.4.79 under each classifier (7y)"); print("="*84)
print(f"  {'cls':>4} | {'n':>4} | {'Sharpe':>7} | {'WR':>4} | {'$(100k)':>10} | {'MaxDD%':>7} | {'stab':>6}")
for m in CLASSIFIERS:
    h=res[m][0]; print(f"  {m:>4} | {h['n']:>4} | {h['sharpe']:>7.2f} | {h['wr']:>3.0f}% | {h['dollars']:>+10,.0f} | {h['mdd']:>6.0f}% | {h['stab']}/{h['ny']}")
print("\n  hedge01 per-year ROI%:")
for m in CLASSIFIERS:
    h=res[m][0]; print(f"   {m:>4}: " + " ".join(f"{y}:{h['by_yr'].get(y,0)*100:+.0f}" for y in sorted(h['by_yr'])))

print(f"\n--- turtle (Don20/10 cut1.5 skip-BEAR) ---")
print(f"  {'cls':>4} | {'Total$':>8} | {'Sharpe':>7} | {'MaxDD$':>8} | {'stab':>6}")
for m in CLASSIFIERS:
    t=res[m][1]; print(f"  {m:>4} | {t['total']:>+8.0f} | {t['sharpe']:>7.2f} | {t['mdd']:>8.0f} | {t['stab']}/{t['ny']}")
print("\n  turtle per-year $:")
for m in CLASSIFIERS:
    t=res[m][1]; print(f"   {m:>4}: " + " ".join(f"{y}:{t['by_yr'].get(y,0):+.0f}" for y in sorted(t['by_yr'])))

print("\n"+"="*84); print("TASK C — delta vs baseline A + REAL-BEAR GUARD (2022 & 2026)"); print("="*84)
hA,tA=res["A"]
print(f"  baseline A: hedge01 ${hA['dollars']:+,.0f} (Sh {hA['sharpe']:.2f}) + turtle ${tA['total']:+,.0f} (Sh {tA['sharpe']:.2f})")
print(f"\n  {'cls':>4} | {'h01 dSh':>8} | {'h01 d$':>10} | {'turt d$':>8} | {'22 h01':>7} | {'26 h01':>7} | {'22 turt':>8} | {'26 turt':>8}")
for m in CLASSIFIERS:
    if m=="A": continue
    h,t=res[m]
    print(f"  {m:>4} | {h['sharpe']-hA['sharpe']:>+8.2f} | {h['dollars']-hA['dollars']:>+10,.0f} | {t['total']-tA['total']:>+8.0f} | "
          f"{h['by_yr'].get(2022,0)*100:>+6.0f}% | {h['by_yr'].get(2026,0)*100:>+6.0f}% | {t['by_yr'].get(2022,0):>+8.0f} | {t['by_yr'].get(2026,0):>+8.0f}")
print("\n  GUARD: 2022 & 2026 must stay near A. Pumping them => re-entering real bear => REJECT.")

print("\n"+"="*84); print("TASK D — persistBars sweep (classifier A): 1 vs 2 vs 3 daily-bar debounce"); print("="*84)
print("  Cảnh báo Tommy: ĐỪNG mặc định 3 ngày tốt hơn — đo thực tế. (persistBars = số daily-close")
print("  liên tiếp cần để LẬT regime. 1 = lật ngay; 3 = chậm ~3 ngày.)\n")
print(f"  {'pBars':>5} | {'h01 n':>5} | {'h01 Sh':>7} | {'h01 $':>10} | {'h01 MaxDD%':>10} | {'turt $':>7} | {'turt Sh':>7}")
for pb in (1, 2, 3):
    key = f"Apb{pb}"
    LABELS[key] = classify(bars1d, "A", pb)
    REGMAP[key] = {BD[i]["time"]//DAY: LABELS[key][i] for i in range(nd)}
    h = h1_stats(run_h01(key)); pt, W = run_turtle(key); t = t_stats(pt, W)
    print(f"  {pb:>5} | {h['n']:>5} | {h['sharpe']:>7.2f} | {h['dollars']:>+10,.0f} | {h['mdd']:>9.0f}% | {t['total']:>+7.0f} | {t['sharpe']:>7.2f}")
print("\n  hedge01 per-year ROI% theo persistBars:")
for pb in (1, 2, 3):
    h = h1_stats(run_h01(f"Apb{pb}"))
    print(f"   pb={pb}: " + " ".join(f"{y}:{h['by_yr'].get(y,0)*100:+.0f}" for y in sorted(h['by_yr'])))

# ===================== TASK E: TRAIN/OOS split =====================
# Tommy: "chốt tham số bằng TRAIN rồi mới mở OOS; không tune trên toàn 7y."
TRAIN_LO, TRAIN_HI = 2019, 2023
OOS_LO, OOS_HI = 2024, 2026
def h1_range(trades, lo, hi):
    return h1_stats([t for t in trades if lo <= t["yr"] <= hi])
def t_range(pnl, lo, hi):
    W = max(T_DON_ENTRY, 200)
    idx = [i for i in range(W, nd) if lo <= datetime.datetime.utcfromtimestamp(BD[i]["time"]/1000).year <= hi]
    series = [pnl[i] for i in idx]
    if not series: return dict(total=0, sharpe=0)
    s = sum(series); mean = s/len(series); sd = (sum((x-mean)**2 for x in series)/len(series))**0.5 or 1e-9
    return dict(total=s, sharpe=mean/sd*math.sqrt(365))

print("\n"+"="*84); print(f"TASK E — TRAIN ({TRAIN_LO}-{TRAIN_HI}) vs OOS ({OOS_LO}-{OOS_HI})"); print("="*84)
print("  Chọn tham số trên TRAIN, xác nhận trên OOS. Không chốt bằng full-7y in-sample.\n")
print("  persistBars (classifier A) — h01 Sharpe & $ :")
print(f"  {'pBars':>5} | {'TRAIN Sh':>8} | {'TRAIN $':>9} | {'OOS Sh':>7} | {'OOS $':>9}")
for pb in (1, 2, 3):
    tr = run_h01(f"Apb{pb}")
    htr = h1_range(tr, TRAIN_LO, TRAIN_HI); hoos = h1_range(tr, OOS_LO, OOS_HI)
    print(f"  {pb:>5} | {htr['sharpe']:>8.2f} | {htr['dollars']:>+9,.0f} | {hoos['sharpe']:>7.2f} | {hoos['dollars']:>+9,.0f}")

print("\n  classifier A-E (persistBars=3) — h01 Sharpe & $ :")
print(f"  {'cls':>4} | {'TRAIN Sh':>8} | {'TRAIN $':>9} | {'OOS Sh':>7} | {'OOS $':>9}")
for m in ["A", "B", "C", "D", "E", "E15", "E25", "E30"]:
    tr = run_h01(m)
    htr = h1_range(tr, TRAIN_LO, TRAIN_HI); hoos = h1_range(tr, OOS_LO, OOS_HI)
    print(f"  {m:>4} | {htr['sharpe']:>8.2f} | {htr['dollars']:>+9,.0f} | {hoos['sharpe']:>7.2f} | {hoos['dollars']:>+9,.0f}")
print("\n  (E* = drawdown variants = RESEARCH-ONLY, không đưa live. C/D = rejected.)")
