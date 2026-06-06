#!/usr/bin/env python3
"""
indicator-evolver.py — Tìm indicator có edge TĂNG 2023-2026
Score = late_roi * 3 + slope * 20 + cagr * 0.5
(ưu tiên recent performance, penalize decay)
Stop: touch tools/indicator-evolver-STOP
Champion: tools/indicator-champion.json
Log: tools/indicator-evolver.log
"""
import json, random, datetime, os, math
from collections import defaultdict

CACHE   = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
STOP    = "/Users/lap16116/BTC_PC/btc-dashboard/tools/indicator-evolver-STOP"
CHAMP   = "/Users/lap16116/BTC_PC/btc-dashboard/tools/indicator-champion.json"
LOG     = "/Users/lap16116/BTC_PC/btc-dashboard/tools/indicator-evolver.log"
FEE=0.05/100; INITIAL=100_000; POS_PCT=0.10

def log(msg):
    ts=datetime.datetime.now().strftime("%H:%M:%S")
    line=f"[{ts}] {msg}"
    print(line,flush=True)
    open(LOG,"a").write(line+"\n")

log("Loading data...")
raw=json.load(open(CACHE)); raw.sort(key=lambda x: x['time'])

def build_tf(ms):
    b={}
    for c in raw:
        k=c["time"]//ms
        if k not in b: b[k]={"time":k*ms,"open":c["open"],"high":c["high"],
                              "low":c["low"],"close":c["close"],"volume":c.get("volume",0)}
        else:
            b[k]["high"]=max(b[k]["high"],c["high"]); b[k]["low"]=min(b[k]["low"],c["low"])
            b[k]["close"]=c["close"]; b[k]["volume"]+=c.get("volume",0)
    return [b[k] for k in sorted(b)]

bars15m=build_tf(900*1000)
bars1h =build_tf(3600*1000)
bars4h =build_tf(4*3600*1000)
bars1d =build_tf(86400*1000)
ALL_BARS={"15m":bars15m,"1h":bars1h,"4h":bars4h,"1d":bars1d}
log(f"TFs: 15m={len(bars15m)} 1h={len(bars1h)} 4h={len(bars4h)} 1d={len(bars1d)}")

# ── Indicator library ─────────────────────────────────────────────────────────
def ema_fn(src,p):
    out=[None]*len(src); k=2/(p+1); e=None
    for i,x in enumerate(src):
        e=x if e is None else x*k+e*(1-k); out[i]=e
    return out

def sma_fn(src,p):
    out=[None]*len(src)
    for i in range(p-1,len(src)):
        w=[x for x in src[i-p+1:i+1] if x is not None]
        if len(w)==p: out[i]=sum(w)/p
    return out

def rsi_fn(src,p):
    out=[None]*len(src); ag=al=0.0
    for i in range(1,p+1):
        d=src[i]-src[i-1]
        if d>0: ag+=d
        else: al-=d
    ag/=p; al/=p
    out[p]=100-100/(1+ag/al) if al else 100
    for i in range(p+1,len(src)):
        d=src[i]-src[i-1]
        ag=(ag*(p-1)+max(d,0))/p; al=(al*(p-1)+max(-d,0))/p
        out[i]=100-100/(1+ag/al) if al else 100
    return out

def stoch_fn(src,p):
    out=[None]*len(src)
    for i in range(p-1,len(src)):
        w=[x for x in src[i-p+1:i+1] if x is not None]
        if len(w)<p or src[i] is None: continue
        lo,hi=min(w),max(w)
        out[i]=(src[i]-lo)/(hi-lo)*100 if hi!=lo else 50
    return out

def atr_fn(bars,p=14):
    n=len(bars); trs=[bars[0]['high']-bars[0]['low']]
    for i in range(1,n):
        trs.append(max(bars[i]['high']-bars[i]['low'],
                       abs(bars[i]['high']-bars[i-1]['close']),
                       abs(bars[i]['low'] -bars[i-1]['close'])))
    out=[None]*n; avg=sum(trs[:p])/p; out[p-1]=avg
    for i in range(p,n):
        avg=(avg*(p-1)+trs[i])/p; out[i]=avg
    return out

def adx_fn(bars,p=14):
    n=len(bars); adx_out=[None]*n; pdi=[None]*n; mdi=[None]*n
    trs=[bars[0]['high']-bars[0]['low']]; pdm=[0]; mdm=[0]
    for i in range(1,n):
        h,l=bars[i]['high'],bars[i]['low']; ph,pl=bars[i-1]['high'],bars[i-1]['low']
        trs.append(max(h-l,abs(h-bars[i-1]['close']),abs(l-bars[i-1]['close'])))
        up=h-ph; dn=pl-l
        pdm.append(up if up>dn and up>0 else 0)
        mdm.append(dn if dn>up and dn>0 else 0)
    atr_s=sum(trs[:p]); pm_s=sum(pdm[:p]); mm_s=sum(mdm[:p]); adx_s=None
    for i in range(p,n):
        atr_s=atr_s-atr_s/p+trs[i]; pm_s=pm_s-pm_s/p+pdm[i]; mm_s=mm_s-mm_s/p+mdm[i]
        pd=100*pm_s/atr_s if atr_s else 0; md=100*mm_s/atr_s if atr_s else 0
        pdi[i]=pd; mdi[i]=md
        dx=100*abs(pd-md)/(pd+md) if (pd+md) else 0
        if i==p*2-1: adx_s=dx
        elif adx_s is not None: adx_s=(adx_s*(p-1)+dx)/p
        if adx_s is not None: adx_out[i]=adx_s
    return adx_out,pdi,mdi

def don_fn(highs,lows,p):
    n=len(highs); uh=[None]*n; dl=[None]*n
    for i in range(p-1,n):
        uh[i]=max(highs[i-p+1:i+1]); dl[i]=min(lows[i-p+1:i+1])
    return uh,dl

def bb_fn(closes,p,k):
    mid=sma_fn(closes,p); n=len(closes); up=[None]*n; lo=[None]*n
    for i in range(p-1,n):
        mu=mid[i]; std=(sum((closes[j]-mu)**2 for j in range(i-p+1,i+1))/p)**0.5
        up[i]=mu+k*std; lo[i]=mu-k*std
    return mid,up,lo

def stddev_fn(src,p):
    out=[None]*len(src)
    for i in range(p-1,len(src)):
        w=[x for x in src[i-p+1:i+1] if x is not None]
        if len(w)==p:
            mu=sum(w)/p; out[i]=(sum((x-mu)**2 for x in w)/p)**0.5
    return out

# Precompute per TF
log("Precomputing indicators per TF...")
TF_DATA={}
for tf,bars in ALL_BARS.items():
    c=[b['close'] for b in bars]; h=[b['high'] for b in bars]
    l=[b['low'] for b in bars]; v=[b['volume'] for b in bars]
    atrv=atr_fn(bars,14)
    adxv,pdiv,mdiv=adx_fn(bars,14)
    TF_DATA[tf]={"bars":bars,"c":c,"h":h,"l":l,"v":v,
                 "atr":atrv,"adx":adxv,"pdi":pdiv,"mdi":mdiv,
                 "n":len(bars)}
log("Done.")

# 1d regime
c1d=[b['close'] for b in bars1d]; t1d=[b['time'] for b in bars1d]
reg1d=[]
for i in range(len(bars1d)):
    ma200=sum(c1d[max(0,i-199):i+1])/min(i+1,200)
    ma50=sum(c1d[max(0,i-49):i+1])/min(i+1,50)
    if c1d[i]<ma200: reg1d.append('BEAR')
    elif c1d[i]>ma50 and ma50>ma200: reg1d.append('BULL')
    else: reg1d.append('RANGE')

def get_regime(ts):
    lo,hi,idx=0,len(t1d)-1,0
    while lo<=hi:
        m=(lo+hi)//2
        if t1d[m]<=ts: idx=m; lo=m+1
        else: hi=m-1
    return reg1d[idx]

# ── Param space ───────────────────────────────────────────────────────────────
INDICATOR_TYPES = [
    "stochrsi","rsi","donchian","adx","ema_cross",
    "bb_squeeze","momentum","hh_hl","atr_expand","macd",
]

PARAM_SPACE = {
    "indicator":    INDICATOR_TYPES,
    "tf":           ["15m","1h","4h","1d"],
    "side":         ["LONG","SHORT","BOTH"],
    # StochRSI
    "sr_rsi_p":     [3,5,7,10,14],
    "sr_stoch_p":   [5,8,10,14,20],
    "sr_smooth":    [1,2,3,5],
    "sr_entry":     [0,2,3,5,8,10,15,20],
    "sr_exit":      [80,85,90,95,100],
    # RSI
    "rsi_p":        [5,7,10,14,21],
    "rsi_os":       [20,25,30,35],
    "rsi_ob":       [65,70,75,80],
    # Donchian
    "don_entry_p":  [10,15,20,30,50,100],
    "don_exit_p":   [5,8,10,15,20],
    # ADX
    "adx_min":      [15,20,25,30,35],
    "adx_entry":    ["cross","level"],
    # EMA cross
    "ema_fast":     [5,8,9,12,21],
    "ema_slow":     [20,21,30,50,100,200],
    # BB
    "bb_p":         [10,14,20,30],
    "bb_k":         [1.5,2.0,2.5],
    # Momentum
    "mom_p":        [5,8,10,14,20],
    "mom_thresh":   [0.5,1.0,1.5,2.0,3.0],
    # Risk
    "sl_atr":       [1.0,1.5,2.0,2.5,3.0],
    "tp_atr":       [0.0,2.0,3.0,4.0,6.0],
    "max_hold":     [8,12,16,24,36,48,72],
    "delay":        [0,1,2,3,5,8,12],
    # Filters
    "regime_filter":["none","skip_bear","skip_bull","range_only"],
    "adx_gate":     [0,15,20,25],
    "vol_gate":     [0.0,1.2,1.5,2.0],
    "ema200_gate":  [False,True],
}

DEFAULT = {
    "indicator":"stochrsi","tf":"1h","side":"BOTH",
    "sr_rsi_p":5,"sr_stoch_p":10,"sr_smooth":1,"sr_entry":8,"sr_exit":90,
    "rsi_p":14,"rsi_os":30,"rsi_ob":70,
    "don_entry_p":20,"don_exit_p":10,
    "adx_min":20,"adx_entry":"cross",
    "ema_fast":9,"ema_slow":21,
    "bb_p":20,"bb_k":2.0,
    "mom_p":10,"mom_thresh":1.0,
    "sl_atr":2.0,"tp_atr":0.0,"max_hold":24,"delay":0,
    "regime_filter":"none","adx_gate":0,"vol_gate":0.0,"ema200_gate":False,
}

# ── Backtest engine ───────────────────────────────────────────────────────────
def backtest(p):
    tf=p.get("tf","1h"); d=TF_DATA[tf]
    bars=d["bars"]; c=d["c"]; h=d["h"]; l=d["l"]; v=d["v"]
    atrv=d["atr"]; adxv=d["adx"]; pdiv=d["pdi"]; mdiv=d["mdi"]; n=d["n"]

    ind=p["indicator"]
    sl_mult=p["sl_atr"]; tp_mult=p["tp_atr"]; max_hold=p["max_hold"]; delay=p["delay"]
    side_mode=p["side"]

    # Build signals array: +1=LONG, -1=SHORT, 0=none
    sig=[0]*n

    if ind=="stochrsi":
        rp=p["sr_rsi_p"]; sp=p["sr_stoch_p"]; sm=p["sr_smooth"]
        ek=p["sr_entry"]; xk=p["sr_exit"]
        rv=rsi_fn(c,rp); st=stoch_fn(rv,sp)
        k=sma_fn(st,sm) if sm>1 else st
        for i in range(1,n):
            if k[i] is None or k[i-1] is None: continue
            if k[i-1]>ek and k[i]<=ek: sig[i]=1
            if k[i-1]<(100-ek) and k[i]>=(100-ek): sig[i]=-1
        # exit signal
        exit_sig=[0]*n
        for i in range(n):
            if k[i] is None: continue
            if k[i]>=xk: exit_sig[i]=1   # exit LONG
            if k[i]<=(100-xk): exit_sig[i]=-1  # exit SHORT

    elif ind=="rsi":
        rp=p["rsi_p"]; os_=p["rsi_os"]; ob_=p["rsi_ob"]
        rv=rsi_fn(c,rp)
        for i in range(1,n):
            if rv[i] is None or rv[i-1] is None: continue
            if rv[i-1]>os_ and rv[i]<=os_: sig[i]=1
            if rv[i-1]<ob_ and rv[i]>=ob_: sig[i]=-1
        exit_sig=[0]*n
        for i in range(n):
            if rv[i] is None: continue
            if rv[i]>=ob_: exit_sig[i]=1
            if rv[i]<=os_: exit_sig[i]=-1

    elif ind=="donchian":
        ep=p["don_entry_p"]; xp=p["don_exit_p"]
        uh,dl=don_fn(h,l,ep); exh,exl=don_fn(h,l,xp)
        for i in range(1,n):
            if uh[i-1] is None: continue
            if c[i]>uh[i-1]: sig[i]=1
            if c[i]<dl[i-1]: sig[i]=-1
        exit_sig=[0]*n
        for i in range(n):
            if exl[i] is None: continue
            if c[i]<exl[i]: exit_sig[i]=1  # exit LONG
            if c[i]>exh[i]: exit_sig[i]=-1  # exit SHORT

    elif ind=="adx":
        am=p["adx_min"]
        for i in range(1,n):
            if adxv[i] is None or pdiv[i] is None: continue
            if p["adx_entry"]=="cross":
                if adxv[i]>am and pdiv[i]>mdiv[i] and (adxv[i-1] is None or adxv[i-1]<=am): sig[i]=1
                if adxv[i]>am and mdiv[i]>pdiv[i] and (adxv[i-1] is None or adxv[i-1]<=am): sig[i]=-1
            else:
                if adxv[i]>am and pdiv[i]>mdiv[i] and pdiv[i]>pdiv[i-1]: sig[i]=1
                if adxv[i]>am and mdiv[i]>pdiv[i] and mdiv[i]>mdiv[i-1]: sig[i]=-1
        exit_sig=[0]*n
        for i in range(n):
            if pdiv[i] is None: continue
            if pdiv[i]<mdiv[i]: exit_sig[i]=1
            if mdiv[i]<pdiv[i]: exit_sig[i]=-1

    elif ind=="ema_cross":
        ef=p["ema_fast"]; es=p["ema_slow"]
        ef_v=ema_fn(c,ef); es_v=ema_fn(c,es)
        for i in range(1,n):
            if ef_v[i] is None or es_v[i] is None: continue
            if ef_v[i-1]<=es_v[i-1] and ef_v[i]>es_v[i]: sig[i]=1
            if ef_v[i-1]>=es_v[i-1] and ef_v[i]<es_v[i]: sig[i]=-1
        exit_sig=[0]*n
        for i in range(n):
            if ef_v[i] is None: continue
            if ef_v[i]<es_v[i]: exit_sig[i]=1
            if ef_v[i]>es_v[i]: exit_sig[i]=-1

    elif ind=="bb_squeeze":
        bp=p["bb_p"]; bk=p["bb_k"]
        mid,bup,blo=bb_fn(c,bp,bk)
        std=stddev_fn(c,bp); std_sma=sma_fn(std,bp)
        for i in range(1,n):
            if std[i] is None or std_sma[i] is None: continue
            expanding=std[i]>std_sma[i]*1.2
            if not expanding: continue
            if c[i]>mid[i] and c[i-1]<=mid[i-1]: sig[i]=1
            if c[i]<mid[i] and c[i-1]>=mid[i-1]: sig[i]=-1
        exit_sig=[0]*n
        for i in range(n):
            if bup[i] is None: continue
            if c[i]>=bup[i]: exit_sig[i]=1
            if c[i]<=blo[i]: exit_sig[i]=-1

    elif ind=="momentum":
        mp=p["mom_p"]; mt=p["mom_thresh"]
        mom=[None]*n
        for i in range(mp,n):
            mom[i]=(c[i]/c[i-mp]-1)*100
        for i in range(1,n):
            if mom[i] is None or mom[i-1] is None: continue
            if mom[i-1]<-mt and mom[i]>=-mt: sig[i]=1
            if mom[i-1]>mt  and mom[i]<=mt:  sig[i]=-1
        exit_sig=[0]*n
        for i in range(n):
            if mom[i] is None: continue
            if mom[i]>mt:  exit_sig[i]=1
            if mom[i]<-mt: exit_sig[i]=-1

    elif ind=="hh_hl":
        for i in range(3,n):
            hh=h[i]>h[i-1]>h[i-2]; hl=l[i]>l[i-1]>l[i-2]
            lh=h[i]<h[i-1]<h[i-2]; ll=l[i]<l[i-1]<l[i-2]
            if hh and hl: sig[i]=1
            elif lh and ll: sig[i]=-1
        exit_sig=[0]*n

    elif ind=="atr_expand":
        atr_sma=sma_fn(atrv,20)
        for i in range(1,n):
            if atrv[i] is None or atr_sma[i] is None: continue
            if atrv[i]>atr_sma[i]*1.5:
                sig[i]=1 if c[i]>c[i-1] else -1
        exit_sig=[0]*n

    elif ind=="macd":
        ef=ema_fn(c,12); es=ema_fn(c,26)
        macd=[None if ef[i] is None or es[i] is None else ef[i]-es[i] for i in range(n)]
        sg=ema_fn(macd,9)
        for i in range(1,n):
            if macd[i] is None or sg[i] is None: continue
            if macd[i-1]<sg[i-1] and macd[i]>=sg[i] and macd[i]<0: sig[i]=1
            if macd[i-1]>sg[i-1] and macd[i]<=sg[i] and macd[i]>0: sig[i]=-1
        exit_sig=[0]*n
        for i in range(n):
            if macd[i] is None: continue
            if macd[i]<sg[i]: exit_sig[i]=1
            if macd[i]>sg[i]: exit_sig[i]=-1
    else:
        exit_sig=[0]*n

    # Precompute optional filters
    adg=p["adx_gate"]; vg=p["vol_gate"]; rf=p["regime_filter"]
    e200_gate=p["ema200_gate"]
    e200=ema_fn(c,200) if e200_gate else None
    vol_sma=sma_fn(v,20) if vg>0 else None

    # ── Simulate ──────────────────────────────────────────────────────────────
    eq=INITIAL; pos=None; pending=None; cd=0
    yp=defaultdict(float); yn=defaultdict(int)

    for i in range(60,n):
        b=bars[i]; ts=b['time']
        dobj=datetime.datetime.fromtimestamp(ts/1000,datetime.timezone.utc)
        if dobj.year<2019: continue
        px=c[i]; av=atrv[i]
        if av is None: continue

        # Manage position
        if pos:
            side=pos['side']
            hit_sl=(px<=pos['sl'] if side==1 else px>=pos['sl'])
            hit_ex=(exit_sig[i]==1 if side==1 else exit_sig[i]==-1) if 'exit_sig' in dir() else False
            try: hit_ex=(exit_sig[i]==1 if side==1 else exit_sig[i]==-1)
            except: hit_ex=False
            max_h=(i-pos['bar'])>=max_hold
            if hit_sl or hit_ex or max_h:
                ep=pos['sl'] if hit_sl else px
                net=((ep/pos['ep']-1) if side==1 else (1-ep/pos['ep']))*pos['n']-pos['n']*FEE*2
                eq=max(eq+net,1); yp[dobj.year]+=net; yn[dobj.year]+=1
                pos=None; pending=None; cd=i+1

        # Execute pending after delay
        if pos is None and pending and i>=pending['eb']:
            av2=atrv[i]
            if av2:
                sd=pending['side']
                sl=px-av2*sl_mult if sd==1 else px+av2*sl_mult
                tp=(px+av2*tp_mult if sd==1 else px-av2*tp_mult) if tp_mult>0 else (1e18 if sd==1 else 0)
                pos={"ep":px,"sl":sl,"tp":tp,"n":eq*POS_PCT,"bar":i,"side":sd}
            pending=None

        # New signal
        if pos is None and pending is None and i>cd and sig[i]!=0:
            s=sig[i]
            if side_mode=="LONG" and s==-1: continue
            if side_mode=="SHORT" and s==1: continue
            # Regime filter
            if rf!="none":
                rg=get_regime(ts)
                if rf=="skip_bear" and rg=='BEAR': continue
                if rf=="skip_bull" and rg=='BULL': continue
                if rf=="range_only" and rg!='RANGE': continue
            # ADX gate
            if adg>0 and (adxv[i] is None or adxv[i]<adg): continue
            # Volume gate
            if vg>0 and vol_sma and vol_sma[i] and v[i]<vol_sma[i]*vg: continue
            # EMA200 gate (LONG only)
            if e200_gate and e200 and e200[i] and s==1 and px<e200[i]: continue
            pending={"side":s,"eb":i+delay}

    eq_fin=eq; eq_cur=INITIAL; yr_rois={}
    for yr in range(2019,2027):
        pl=yp.get(yr,0); roi=pl/eq_cur*100; yr_rois[yr]=roi; eq_cur+=pl
    cagr=(eq_fin/INITIAL)**(1/7)-1
    nt=sum(yn.values())
    ys=[yr_rois.get(y,0) for y in range(2019,2027)]
    xs=list(range(8)); mx=3.5; my=sum(ys)/8
    denom=sum((x-mx)**2 for x in xs)
    slope=sum((xs[i]-mx)*(ys[i]-my) for i in range(8))/denom if denom else 0
    early=sum(yr_rois.get(y,0) for y in [2019,2020,2021])/3
    late =sum(yr_rois.get(y,0) for y in [2023,2024,2025,2026])/4
    pos_yrs=sum(1 for y in range(2019,2027) if yr_rois.get(y,0)>0)
    return cagr*100, yr_rois, nt, slope, early, late, pos_yrs

# ── Score ─────────────────────────────────────────────────────────────────────
def score(cagr,yr_rois,nt,slope,early,late,pos_yrs):
    if nt<80: return -9999
    if late<-2: return -9999
    # Ưu tiên: late performance + slope + pos_years
    s = (late  * 3.0      # recent ROI quan trọng nhất
       + slope * 20.0     # trend tăng/giảm
       + cagr  * 0.3      # tổng CAGR
       + pos_yrs * 2.0)   # số năm dương
    return s

# ── Mutate ────────────────────────────────────────────────────────────────────
def mutate(p, strength=2):
    c=dict(p)
    keys=random.sample(list(PARAM_SPACE.keys()), min(strength,len(PARAM_SPACE)))
    for k in keys:
        c[k]=random.choice(PARAM_SPACE[k])
    return c

# ── Load champion ─────────────────────────────────────────────────────────────
champ_score=-9999; champ_params=dict(DEFAULT); champion=None
if os.path.exists(CHAMP):
    try:
        sv=json.load(open(CHAMP))
        champ_params=sv.get("params",DEFAULT)
        champ_score=sv.get("score",-9999)
        champion=sv.get("metrics")
        log(f"Loaded champion: score={champ_score:.1f}")
    except: pass

log("="*60)
log("  INDICATOR EVOLVER — tìm edge TĂNG 2023-2026")
log(f"  Stop: {STOP}")
log("="*60)

gen=0; hof=[]
while True:
    gen+=1
    if os.path.exists(STOP):
        log("STOP. Exiting."); break

    # Pick candidate
    if not hof or random.random()<0.7:
        candidate=mutate(champ_params, random.randint(1,4))
    elif len(hof)>=2 and random.random()<0.3:
        p1=random.choice(hof)['params']; p2=random.choice(hof)['params']
        candidate={k:(p1.get(k,DEFAULT[k]) if random.random()<0.5 else p2.get(k,DEFAULT[k])) for k in DEFAULT}
        candidate=mutate(candidate,1)
    else:
        candidate=mutate(random.choice(hof)['params'], random.randint(1,3))

    try:
        cagr,yr,nt,slope,early,late,pos_yrs=backtest(candidate)
        s=score(cagr,yr,nt,slope,early,late,pos_yrs)
    except Exception as e:
        continue

    if s>champ_score:
        champ_score=s; champ_params=candidate
        champion={"cagr":round(cagr,2),"slope":round(slope,3),
                  "early":round(early,2),"late":round(late,2),
                  "n":nt,"pos_yrs":pos_yrs,
                  "yr_roi":{str(k):round(v,2) for k,v in yr.items()}}
        ind=candidate['indicator']; tf=candidate['tf']; sd=candidate['side']
        log(f"★ Gen {gen:5d} NEW CHAMPION score={s:.1f} | {ind}/{tf}/{sd} | "
            f"CAGR={cagr:.1f}% slope={slope:+.2f} late={late:+.1f}% pos={pos_yrs}/8 n={nt}")
        log(f"  yr: " + " ".join(f"{y}:{yr.get(y,0):+.0f}%" for y in range(2019,2027)))

        hof.append({"score":s,"params":dict(candidate),"metrics":champion})
        hof.sort(key=lambda x:x['score'],reverse=True); hof=hof[:8]
        json.dump({"gen":gen,"score":champ_score,"params":champ_params,
                   "metrics":champion,"ts":datetime.datetime.now().isoformat()},
                  open(CHAMP,"w"),indent=2)
    else:
        if gen%200==0:
            log(f"  Gen {gen:5d} | best={champ_score:.1f} | last: {candidate['indicator']}/{candidate['tf']} score={s:.1f}")
