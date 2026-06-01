#!/usr/bin/env python3
"""
compare-all-rules-7y.py — So sánh tất cả rules đã research

Metrics đồng nhất: RA, WR, R:R, DD, stab, monthly_win%, n/yr, TEST_RA, decay
Walk-forward: TRAIN 2019-2022, TEST 2023-2026
"""
import json, datetime
from collections import defaultdict

CACHE  = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FEE    = 0.05 / 100
WF_CUT = int(datetime.datetime(2023,1,1).timestamp()*1000)

raw = json.load(open(CACHE)); raw.sort(key=lambda x: x["time"])

def agg(bars,ms):
    b={}
    for c in bars:
        k=c["time"]//ms
        if k not in b:
            b[k]={"time":k*ms,"open":c["open"],"high":c["high"],"low":c["low"],"close":c["close"],"volume":c["volume"]}
        else:
            o=b[k];o["high"]=max(o["high"],c["high"]);o["low"]=min(o["low"],c["low"]);o["close"]=c["close"];o["volume"]+=c["volume"]
    return [b[k] for k in sorted(b)]

bars1h=agg(raw,3600*1000); bars4h=agg(raw,4*3600*1000); bars1d=agg(raw,86400*1000)
n1h=len(bars1h); n4h=len(bars4h)
c1h=[b["close"] for b in bars1h]; c4h=[b["close"] for b in bars4h]

def ema(xs,p):
    k=2/(p+1);out=[None]*len(xs);e=None
    for i,x in enumerate(xs): e=x if e is None else x*k+e*(1-k);out[i]=e
    return out
def _dtr(bars):
    n=len(bars);pdm=[0.]*n;ndm=[0.]*n;tr=[0.]*n
    for i in range(1,n):
        up=bars[i]["high"]-bars[i-1]["high"];dn=bars[i-1]["low"]-bars[i]["low"]
        pdm[i]=up if up>dn and up>0 else 0;ndm[i]=dn if dn>up and dn>0 else 0
        tr[i]=max(bars[i]["high"]-bars[i]["low"],abs(bars[i]["high"]-bars[i-1]["close"]),abs(bars[i]["low"]-bars[i-1]["close"]))
    return pdm,ndm,tr
def adx_w(bars,p=14):
    pdm,ndm,tr=_dtr(bars);n=len(bars)
    smTR=sum(tr[1:p+1]);smPDM=sum(pdm[1:p+1]);smNDM=sum(ndm[1:p+1])
    dx_arr=[];adv=None;out=[None]*n
    for i in range(p+1,n):
        smTR=smTR-smTR/p+tr[i];smPDM=smPDM-smPDM/p+pdm[i];smNDM=smNDM-smNDM/p+ndm[i]
        pdi=smPDM/smTR*100 if smTR>0 else 0;ndi=smNDM/smTR*100 if smTR>0 else 0
        dx=abs(pdi-ndi)/(pdi+ndi)*100 if (pdi+ndi)>0 else 0;dx_arr.append(dx)
        if len(dx_arr)<p: continue
        elif len(dx_arr)==p: adv=sum(dx_arr)/p
        else: adv=(adv*(p-1)+dx)/p
        out[i]=adv
    return out
def atr_w(bars,p=14):
    _,_,tr=_dtr(bars);n=len(bars);out=[None]*n
    s=sum(tr[1:p+1]);out[p]=s/p
    for i in range(p+1,n): out[i]=(out[i-1]*(p-1)+tr[i])/p
    return out
def rsi_s(cls,n=14):
    out=[None]*len(cls);ag=al=0.
    for i in range(1,n+1):
        d=cls[i]-cls[i-1]
        if d>0: ag+=d
        else: al-=d
    ag/=n;al/=n;out[n]=100-100/(1+ag/al) if al>0 else 100
    for i in range(n+1,len(cls)):
        d=cls[i]-cls[i-1];g=max(d,0);l=max(-d,0);ag=(ag*(n-1)+g)/n;al=(al*(n-1)+l)/n
        out[i]=100-100/(1+ag/al) if al>0 else 100
    return out
def stoch_s(bars,n=14):
    out=[None]*len(bars)
    for i in range(n-1,len(bars)):
        hi=max(b["high"] for b in bars[i-n+1:i+1]);lo=min(b["low"] for b in bars[i-n+1:i+1])
        out[i]=100*(bars[i]["close"]-lo)/(hi-lo) if hi>lo else 50
    return out
def bb_s(cls,n=20,k=2.):
    u=[None]*len(cls);l=[None]*len(cls)
    for i in range(n-1,len(cls)):
        w=cls[i-n+1:i+1];m=sum(w)/n;s=(sum((x-m)**2 for x in w)/n)**0.5;u[i]=m+k*s;l[i]=m-k*s
    return u,l
def don_hi(bars,n):
    out=[None]*len(bars)
    for i in range(n,len(bars)): out[i]=max(bars[j]["high"] for j in range(i-n,i))
    return out
def vol_ma(bars,n):
    out=[None]*len(bars)
    for i in range(n-1,len(bars)): out[i]=sum(bars[j]["volume"] for j in range(i-n+1,i+1))/n
    return out
def regime_wp(bars1d,p=3):
    cs=[b["close"] for b in bars1d];n=len(bars1d);raw=["RANGE"]*n
    for i in range(200,n):
        m200=sum(cs[i-199:i+1])/200;m50=sum(cs[i-50:i+1])/50
        ar=sum((b["high"]-b["low"])/b["close"] for b in bars1d[i-19:i+1])/20
        if cs[i]<m200: raw[i]="BEAR"
        elif cs[i]>m50 and m50>m200 and ar>0.04: raw[i]="BULL"
    out=["RANGE"]*n;cur="RANGE";cnt=0;lr="RANGE"
    for i in range(n):
        r=raw[i]
        if r==lr: cnt+=1
        else: cnt=1;lr=r
        if cnt>=p: cur=r
        out[i]=cur
    return out

print("Computing indicators...")
adx4=adx_w(bars4h); atr4=atr_w(bars4h)
e50_4h=ema(c4h,50); e200_4h=ema(c4h,200); dh20_4h=don_hi(bars4h,20); vma10_4h=vol_ma(bars4h,10)
atr1h=atr_w(bars1h); rsi1h=rsi_s(c1h); stk1h=stoch_s(bars1h)
e200_1h_s=ema(c1h,200); bbu,bbl=bb_s(c1h); e9_1h=ema(c1h,9); e21_1h=ema(c1h,21)
reg1d=regime_wp(bars1d); reg_map={}
for i,b in enumerate(bars1d): reg_map[b["time"]//86400000]=reg1d[i]
ATR_LB=90; ts4h_arr=[b["time"] for b in bars4h]; ts1h_arr=[b["time"] for b in bars1h]
def get_reg(ts): return reg_map.get(ts//86400000,"RANGE")
def get_4h_idx(ts):
    k=ts//(4*3600*1000);lo,hi,idx=0,len(ts4h_arr)-1,0
    while lo<=hi:
        m=(lo+hi)//2
        if ts4h_arr[m]//(4*3600*1000)<=k: idx=m;lo=m+1
        else: hi=m-1
    return idx
def e200_1h_at(ts):
    lo,hi,idx=0,len(ts1h_arr)-1,0
    while lo<=hi:
        m=(lo+hi)//2
        if ts1h_arr[m]<=ts: idx=m;lo=m+1
        else: hi=m-1
    return e200_1h_s[idx]

def ctx4h_ok(i4h, pct):
    if i4h<50: return False
    if get_reg(bars4h[i4h]["time"])!="RANGE": return False
    adv=adx4[i4h];adv_p=adx4[i4h-1] if i4h>0 else None
    if adv is None or adv<=20 or adv_p is None or adv_p<=20: return False
    if pct>0:
        if i4h<ATR_LB+14: return False
        vs=[atr4[j]/c4h[j] for j in range(i4h-ATR_LB,i4h) if atr4[j] and c4h[j]]
        if len(vs)<ATR_LB: return False
        cur=atr4[i4h]/c4h[i4h] if atr4[i4h] and c4h[i4h] else None
        return cur is not None and cur>=sorted(vs)[int(len(vs)*pct)]
    return True

print("Precomputing contexts...")
ctx50=[ctx4h_ok(i,0.50) for i in range(n4h)]
ctx40=[ctx4h_ok(i,0.40) for i in range(n4h)]
ctx35=[ctx4h_ok(i,0.35) for i in range(n4h)]

def filt_1h(i,ctx):
    e1h=e200_1h_s[i]
    if e1h and c1h[i]<e1h: return False
    i4h=get_4h_idx(bars1h[i]["time"])
    return 0<=i4h<n4h and ctx[i4h]

def sim_long(bars,c,atr,ei,sl,tp,max_h):
    ep=c[ei];ae=atr[ei]
    if not ae or ae<=0: return None
    s=ep-ae*sl; t=ep+ae*tp
    for h in range(1,max_h+1):
        j=ei+h
        if j>=len(bars): break
        if bars[j]["low"]<=s: return (s-ep)/ep-2*FEE,h
        if bars[j]["high"]>=t: return (t-ep)/ep-2*FEE,h
    j2=min(ei+max_h,len(c)-1)
    return (c[j2]-ep)/ep-2*FEE,max_h

def sim_trail_4h(ei):
    ep=c4h[ei];ae=atr4[ei]
    if not ae or ae<=0: return None
    sl=ep-ae*4.;hwm=ep
    for h in range(1,201):
        j=ei+h
        if j>=n4h: break
        mult=4. if h<24 else 3.
        if c4h[j]>hwm: hwm=c4h[j];sl=hwm-ae*mult
        elif h>=24:
            t=hwm-ae*3.
            if t>sl: sl=t
        if bars4h[j]["low"]<=sl: return (sl-ep)/ep-2*FEE,h
    j2=min(ei+200,n4h-1)
    return (c4h[j2]-ep)/ep-2*FEE,200

def calc_ra(t):
    if not t: return None
    r=[x["ret"] for x in t];m=sum(r)/len(r);sd=(sum((x-m)**2 for x in r)/len(r))**0.5
    return m/sd if sd>0 else 0

def evaluate(trades, name):
    if not trades: return None
    rets=[t["ret"] for t in trades]; n_=len(rets)
    mean=sum(rets)/n_; sd=(sum((r-mean)**2 for r in rets)/n_)**0.5 or 1e-9
    ra=mean/sd; wr=sum(1 for r in rets if r>0)/n_*100
    wins=[r for r in rets if r>0]; losses=[r for r in rets if r<=0]
    rr=(sum(wins)/len(wins) if wins else 0)/abs(sum(losses)/len(losses) if losses else 1e-9)
    by_yr=defaultdict(float)
    for t in trades: by_yr[t["yr"]]+=t["ret"]
    stab=sum(1 for v in by_yr.values() if v>0); n_yrs=len(by_yr)
    eq=0;pk=0;dd=0
    for t in sorted(trades,key=lambda x:x["yr"]): eq+=t["ret"];pk=max(pk,eq);dd=max(dd,pk-eq)
    by_mo=defaultdict(list)
    for t in trades: by_mo[t["mo"]].append(t["ret"])
    win_mo=sum(1 for vs in by_mo.values() if sum(vs)>0); tot_mo=len(by_mo)
    train=[t for t in trades if t["ts"]<WF_CUT]; test=[t for t in trades if t["ts"]>=WF_CUT]
    ra_tr=calc_ra(train); ra_te=calc_ra(test)
    decay=(ra_te-ra_tr)/abs(ra_tr)*100 if ra_tr else None
    return {"name":name,"n":n_,"n_yr":n_//7,"ra":ra,"wr":wr,"rr":rr,"dd":dd,
            "stab":stab,"n_yrs":n_yrs,"win_mo":win_mo,"tot_mo":tot_mo,
            "ra_tr":ra_tr,"ra_te":ra_te,"decay":decay,
            "roi":sum(rets)*100}

def make_trade(ret,h,ts,yr):
    mo=yr*100+datetime.datetime.utcfromtimestamp(ts/1000).month
    return {"ret":ret,"yr":yr,"mo":mo,"ts":ts}

# ════════════════════════════════════════════════════════════════════════════
#  RULE 1: hedge01 v0.4.56 (S12+S13+S14, RANGE+LONG+ATR50, trailing SL)
# ════════════════════════════════════════════════════════════════════════════
def run_hedge01():
    trades=[]; last={"S12":-200,"S13":-1,"S14":-200}; CD={"S12":36,"S13":1,"S14":36}
    dh20=[None]*n4h
    for i in range(20,n4h): dh20[i]=max(bars4h[j]["high"] for j in range(i-20,i))
    for i in range(100,n4h-200):
        if not ctx50[i]: continue
        e1h=e200_1h_at(bars4h[i]["time"])
        if e1h and c4h[i]<e1h: continue
        ts=bars4h[i]["time"]; yr=datetime.datetime.utcfromtimestamp(ts/1000).year
        # S13 ATR breakout
        if atr4[i] and i>0 and c4h[i]>bars4h[i-1]["close"]+atr4[i]*1.2 and i-last["S13"]>=1:
            if vma10_4h[i] and bars4h[i]["volume"]>=vma10_4h[i]*1.2:
                r=sim_trail_4h(i)
                if r: trades.append(make_trade(r[0],r[1],ts,yr)); last["S13"]=i
        # S14 Donchian
        if dh20[i] and c4h[i]>dh20[i] and i-last["S14"]>=200:
            r=sim_trail_4h(i)
            if r: trades.append(make_trade(r[0],r[1],ts,yr)); last["S14"]=i
        # S12 EMA cross
        if e50_4h[i] and e200_4h[i] and e50_4h[i-1] and e200_4h[i-1]:
            if e50_4h[i-1]<=e200_4h[i-1] and e50_4h[i]>e200_4h[i] and i-last["S12"]>=200:
                r=sim_trail_4h(i)
                if r: trades.append(make_trade(r[0],r[1],ts,yr)); last["S12"]=i
    return trades

# ════════════════════════════════════════════════════════════════════════════
#  RULE 2: 1h BB+RSI+STOCH, SL2 BB×1.5 RSI×1 STK×1, CD=2h, ATR40 — WINNER
# ════════════════════════════════════════════════════════════════════════════
def run_1h_winner(ctx=ctx40, tp_bb=1.5, tp_rsi=1.0, tp_stk=1.0, cd=2):
    trades=[]; lb=-cd; lr=-cd; ls=-cd
    for i in range(50,n1h-48):
        if not filt_1h(i,ctx): continue
        ts=bars1h[i]["time"]; yr=datetime.datetime.utcfromtimestamp(ts/1000).year
        if bbl[i] and bars1h[i]["low"]<=bbl[i] and c1h[i]>bars1h[i]["open"] and i-lb>=cd:
            r=sim_long(bars1h,c1h,atr1h,i,2.,tp_bb,24)
            if r: trades.append(make_trade(r[0],r[1],ts,yr)); lb=i
        if rsi1h[i] and rsi1h[i-1] and rsi1h[i-1]<40 and rsi1h[i]>=40 and i-lr>=cd:
            r=sim_long(bars1h,c1h,atr1h,i,2.,tp_rsi,24)
            if r: trades.append(make_trade(r[0],r[1],ts,yr)); lr=i
        if stk1h[i] and stk1h[i-1] and stk1h[i-1]<20 and stk1h[i]>=20 and i-ls>=cd:
            r=sim_long(bars1h,c1h,atr1h,i,2.,tp_stk,24)
            if r: trades.append(make_trade(r[0],r[1],ts,yr)); ls=i
    return trades

# ════════════════════════════════════════════════════════════════════════════
#  RULE 3: 1h BB+RSI (no STOCH), SL2 TP2, CD=4h, ATR50 — simple version
# ════════════════════════════════════════════════════════════════════════════
def run_1h_simple():
    trades=[]; lb=-4; lr=-4
    for i in range(50,n1h-48):
        if not filt_1h(i,ctx50): continue
        ts=bars1h[i]["time"]; yr=datetime.datetime.utcfromtimestamp(ts/1000).year
        if bbl[i] and bars1h[i]["low"]<=bbl[i] and c1h[i]>bars1h[i]["open"] and i-lb>=4:
            r=sim_long(bars1h,c1h,atr1h,i,2.,2.,24)
            if r: trades.append(make_trade(r[0],r[1],ts,yr)); lb=i
        if rsi1h[i] and rsi1h[i-1] and rsi1h[i-1]<40 and rsi1h[i]>=40 and i-lr>=4:
            r=sim_long(bars1h,c1h,atr1h,i,2.,2.,24)
            if r: trades.append(make_trade(r[0],r[1],ts,yr)); lr=i
    return trades

# ════════════════════════════════════════════════════════════════════════════
#  RULE 4: 1h breakout (S13+S14 on 1h) — same logic as hedge01 but 1h
# ════════════════════════════════════════════════════════════════════════════
def run_1h_breakout():
    trades=[]; last_s13=-1; last_s14=-12
    dh10_1h=[None]*n1h
    for i in range(10,n1h): dh10_1h[i]=max(bars1h[j]["high"] for j in range(i-10,i))
    for i in range(50,n1h-48):
        if not filt_1h(i,ctx50): continue
        ts=bars1h[i]["time"]; yr=datetime.datetime.utcfromtimestamp(ts/1000).year
        if atr1h[i] and i>0 and c1h[i]>bars1h[i-1]["close"]+atr1h[i]*1.2 and i-last_s13>=1:
            r=sim_long(bars1h,c1h,atr1h,i,4.,6.,200)
            if r: trades.append(make_trade(r[0],r[1],ts,yr)); last_s13=i
        if dh10_1h[i] and c1h[i]>dh10_1h[i] and i-last_s14>=12:
            r=sim_long(bars1h,c1h,atr1h,i,4.,6.,200)
            if r: trades.append(make_trade(r[0],r[1],ts,yr)); last_s14=i
    return trades

# ════════════════════════════════════════════════════════════════════════════
#  RULE 5: EMA 9/21 cross 4h (most consistent per-month)
# ════════════════════════════════════════════════════════════════════════════
def run_ema9x21():
    trades=[]; last=-200
    for i in range(60,n4h-200):
        if e9_1h is None: continue
        # map to 4h e9/e21
        e9=ema(c4h,9); e21=ema(c4h,21)
        break
    e9_4h=ema(c4h,9); e21_4h=ema(c4h,21)
    for i in range(60,n4h-200):
        if not ctx40[i]: continue
        e1h=e200_1h_at(bars4h[i]["time"])
        if e1h and c4h[i]<e1h: continue
        if None in (e9_4h[i],e21_4h[i],e9_4h[i-1],e21_4h[i-1]): continue
        if e9_4h[i-1]<=e21_4h[i-1] and e9_4h[i]>e21_4h[i] and i-last>=12:
            r=sim_long(bars4h,c4h,atr4,i,2.,1.5,48)
            if r:
                ts=bars4h[i]["time"]; yr=datetime.datetime.utcfromtimestamp(ts/1000).year
                trades.append(make_trade(r[0],r[1],ts,yr)); last=i
    return trades

# ════════════════════════════════════════════════════════════════════════════
#  RUN ALL
# ════════════════════════════════════════════════════════════════════════════
print("\nRunning all rules...")
results=[]
rules=[
    ("R1: hedge01 v0.4.56\n    (4h S12+S13+S14, RANGE+ADX+ATR50, trail SL)", run_hedge01),
    ("R2: 1h BB×1.5+RSI×1+STOCH×1 CD=2h ATR40\n    (WINNER — 82% monthly win)", lambda: run_1h_winner(ctx40,1.5,1.,1.,2)),
    ("R3: 1h BB×1.5+RSI×1+STOCH×1 CD=2h ATR35\n    (more entries — 80% monthly win)", lambda: run_1h_winner(ctx35,1.5,1.,1.,2)),
    ("R4: 1h BB+RSI SL×2 TP×2 CD=4h ATR50\n    (simple 2-signal)", run_1h_simple),
    ("R5: 1h S13+S14 breakout ATR50\n    (hedge01 logic on 1h)", run_1h_breakout),
    ("R6: 4h EMA9×21 cross ATR40\n    (60% monthly consistent)", run_ema9x21),
]
for name,fn in rules:
    print(f"  Running {name.split(chr(10))[0]}...")
    t=fn(); r=evaluate(t,name)
    if r: results.append(r)

# ════════════════════════════════════════════════════════════════════════════
#  COMPARISON TABLE
# ════════════════════════════════════════════════════════════════════════════
print("\n" + "="*100)
print("COMPARISON — ALL RULES (7y, walk-forward TRAIN:2019-22 / TEST:2023-26)")
print("="*100)
print(f"\n  {'Rule':50s}  {'n/yr':>5}  {'RA':>7}  {'WR':>5}  {'R:R':>5}  {'DD':>6}  {'stab':>5}  {'mo%':>5}  {'TEST_RA':>8}  {'decay':>7}")
print("  " + "─"*95)
for r in results:
    name_short=r["name"].split("\n")[0]
    sub=r["name"].split("\n")[1].strip() if "\n" in r["name"] else ""
    decay_str=f"{r['decay']:>+6.0f}%" if r["decay"] else "  N/A"
    mo_pct=r["win_mo"]/r["tot_mo"]*100 if r["tot_mo"] else 0
    te=r["ra_te"] or 0
    print(f"  {name_short:50s}  {r['n_yr']:>5}  {r['ra']:>+7.3f}  {r['wr']:>4.0f}%  {r['rr']:>5.2f}  {r['dd']*100:>5.1f}%  {r['stab']}/{r['n_yrs']}  {mo_pct:>4.0f}%  {te:>+8.3f}  {decay_str}")
    print(f"    {sub}")

print("\n" + "─"*100)
print("LEGEND:")
print("  n/yr   = entries per year")
print("  RA     = Risk-Adjusted return (full 7y)")
print("  stab   = N positive years / total active years")
print("  mo%    = % months profitable (monthly consistency)")
print("  TEST_RA= RA on out-of-sample 2023-2026 (generalizability)")
print("  decay  = (TEST_RA - TRAIN_RA) / |TRAIN_RA| × 100%")
print("           Positive = IMPROVING out-of-sample (good)")
print("           Negative > -30% = concern")

print("\n" + "─"*100)
print("SUMMARY for hedge04 selection:")
print("─"*100)
for r in results:
    name_short=r["name"].split("\n")[0]
    pros=[]; cons=[]
    if r["ra"]>=0.3: pros.append(f"RA={r['ra']:+.3f} excellent")
    elif r["ra"]>=0.15: pros.append(f"RA={r['ra']:+.3f} good")
    if r["win_mo"]/r["tot_mo"]>=0.80: pros.append(f"monthly {r['win_mo']/r['tot_mo']*100:.0f}% ✅")
    if r["stab"]==r["n_yrs"]: pros.append(f"stab {r['stab']}/{r['n_yrs']} (all years pos)")
    if r["n_yr"]>=50: pros.append(f"~{r['n_yr']}/yr (high freq)")
    if r["ra_te"] and r["ra_te"]>0.2: pros.append(f"TEST_RA={r['ra_te']:+.3f} strong")
    if r["dd"]>0.4: cons.append(f"DD={r['dd']*100:.0f}% high")
    if r["decay"] and r["decay"]<-40: cons.append(f"decay={r['decay']:+.0f}% concern")
    if r["n_yr"]<20: cons.append(f"only {r['n_yr']}/yr (low freq)")
    print(f"\n  {name_short}")
    if pros: print(f"    ✅ {' | '.join(pros)}")
    if cons: print(f"    ⚠️  {' | '.join(cons)}")
