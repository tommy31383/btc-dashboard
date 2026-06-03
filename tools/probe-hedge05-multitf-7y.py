#!/usr/bin/env python3
"""PROBE multi-TF multi-indicator DECISION — forced-daily (KHÔNG skip), tìm PHƯƠNG PHÁP XỬ LÝ
   bằng chỉ số phụ (MACD / ADX+DI / volume / VWAP) + nhiều khung thời gian (15m/1h/4h/1d).
   No-lookahead: mỗi TF dùng bar ĐÃ ĐÓNG tại thời điểm quyết định; daily D-1.
   Direction = regime-adaptive score: ADX cao → FOLLOW trend; ADX thấp → FADE mean-rev; mixed → tổng.
   Management: cut@-CUT×ATR + fixed TP + time-stop. Ablation: --no1d --noadx --nomacd --nomeanrev --novol --no15m."""
import json, datetime, sys
from collections import defaultdict
CACHE="/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FEE=0.05/100; BASE_QTY=0.003
def argf(n,d):
    for a in sys.argv:
        if a.startswith(f"--{n}="): return float(a.split("=")[1])
    return d
CUT=argf("cut",3.0); TP_M=argf("tp",2.5); TS_H=int(argf("ts",72))
ADX_TREND=argf("adxtrend",25); ADX_RANGE=argf("adxrange",20); DEADLINE=int(argf("deadline",20))
DECISIVE=int(argf("decisive",2))   # |score|>=DECISIVE thì vào ngay, không thì chờ tới deadline (vẫn vào — no skip)
CONVSIZE=argf("convsize",1)   # conviction-sizing: qty = BASE × min(max(1,|score|), CONVSIZE) — tin cao (nhiều TF confirm) đánh TO
TRAIL=argf("trail",0)   # >0 → trailing exit (HWM-TRAIL×ATR) thay fixed TP — cho trend winner chạy xa
USE_1D="--no1d" not in sys.argv; USE_ADX="--noadx" not in sys.argv; USE_MACD="--nomacd" not in sys.argv
USE_MEANREV="--nomeanrev" not in sys.argv; USE_VOL="--novol" not in sys.argv; USE_15M="--no15m" not in sys.argv
USE_OBV="--obv" in sys.argv; USE_VWAP="--vwap" in sys.argv; USE_CCI="--cci" in sys.argv; USE_5M="--5m" in sys.argv; USE_1W="--1w" in sys.argv
NOFORCE="--noforce" in sys.argv  # conviction-gated: chỉ vào khi |score|>=DECISIVE, SKIP ngày yếu (bỏ forced-deadline)
FLIP="--flip" in sys.argv  # reverse-v2: khi CẮT (SL), nếu vote multi-TF flip decisive NGƯỢC lại → đảo chiều luôn (biến loser → lệnh đảo có xác nhận)
REGADAPT="--regadapt" in sys.argv  # regime-adaptive TP: TREND→tp×1.5 (để trend chạy), RANGE/MIX→tp×0.7 (chốt nhanh chop)
FLIPDEC=int(argf("flipdec",0))  # flip confirm strength (0=dùng DECISIVE; >0 = yêu cầu |score|>=FLIPDEC mới đảo, lọc flip ẩu)
REGCUT="--regcut" in sys.argv   # ① regime-adaptive cut: TREND→cut×1.3 (cho trend thở), RANGE/MIX→cut×0.85 (chop cắt nhanh)
FLIPCAP=int(argf("flipcap",0))  # ② max flip/ngày (0=unbounded) — test giá trị flip-chain
FLIPSTRICT="--flipstrict" in sys.argv  # AUDIT: flip causal hoàn toàn — decide ở bar i-1 (đã đóng trước SL) + vào tại giá SL xp (không within-bar lookahead)
ANTITOP=argf("antitop",0)  # (a) chống mua đỉnh: score-entry rơi vào vùng đỉnh(LONG)/đáy(SHORT) range20-4h → CHỜ giá tốt hơn trong ngày (deadline vẫn vào, giữ lệnh)

print("Loading + agg...", file=sys.stderr)
raw=json.load(open(CACHE)); raw.sort(key=lambda x:x["time"])
def agg(bars,ms):
    b={}
    for c in bars:
        k=c["time"]//ms
        if k not in b: b[k]={"time":k*ms,"open":c["open"],"high":c["high"],"low":c["low"],"close":c["close"],"volume":c["volume"]}
        else:
            o=b[k];o["high"]=max(o["high"],c["high"]);o["low"]=min(o["low"],c["low"]);o["close"]=c["close"];o["volume"]+=c["volume"]
    return [b[k] for k in sorted(b)]
MS={"5m":300_000,"15m":900_000,"1h":3600_000,"4h":4*3600_000,"1d":86400_000,"1w":604_800_000}
B={tf:agg(raw,ms) for tf,ms in MS.items()}

def ema(xs,p):
    k=2/(p+1);o=[None]*len(xs);e=None
    for i,x in enumerate(xs): e=x if e is None else x*k+e*(1-k);o[i]=e
    return o
def rsi_s(cls,n=14):
    o=[None]*len(cls);ag=al=0.
    if len(cls)<=n: return o
    for i in range(1,n+1):
        d=cls[i]-cls[i-1]
        if d>0: ag+=d
        else: al-=d
    ag/=n;al/=n;o[n]=100-100/(1+ag/al) if al>0 else 100
    for i in range(n+1,len(cls)):
        d=cls[i]-cls[i-1];g=max(d,0);l=max(-d,0)
        ag=(ag*(n-1)+g)/n;al=(al*(n-1)+l)/n
        o[i]=100-100/(1+ag/al) if al>0 else 100
    return o
def _dtr(bars):
    n=len(bars);pdm=[0.]*n;ndm=[0.]*n;tr=[0.]*n
    for i in range(1,n):
        up=bars[i]["high"]-bars[i-1]["high"];dn=bars[i-1]["low"]-bars[i]["low"]
        pdm[i]=up if up>dn and up>0 else 0;ndm[i]=dn if dn>up and dn>0 else 0
        tr[i]=max(bars[i]["high"]-bars[i]["low"],abs(bars[i]["high"]-bars[i-1]["close"]),abs(bars[i]["low"]-bars[i-1]["close"]))
    return pdm,ndm,tr
def atr_w(bars,p=14):
    _,_,tr=_dtr(bars);n=len(bars);o=[None]*n
    if n<=p:return o
    s=sum(tr[1:p+1]);o[p]=s/p
    for i in range(p+1,n):o[i]=(o[i-1]*(p-1)+tr[i])/p
    return o
def adx_di(bars,p=14):
    n=len(bars);pdm,ndm,tr=_dtr(bars)
    atr=[None]*n;sp=[None]*n;sn=[None]*n
    if n<=2*p: return [None]*n,[None]*n,[None]*n
    atr[p]=sum(tr[1:p+1]);sp[p]=sum(pdm[1:p+1]);sn[p]=sum(ndm[1:p+1])
    for i in range(p+1,n):
        atr[i]=atr[i-1]-atr[i-1]/p+tr[i]; sp[i]=sp[i-1]-sp[i-1]/p+pdm[i]; sn[i]=sn[i-1]-sn[i-1]/p+ndm[i]
    dip=[None]*n;din=[None]*n;dx=[None]*n;adx=[None]*n
    for i in range(p,n):
        if atr[i] and atr[i]>0:
            dip[i]=100*sp[i]/atr[i];din[i]=100*sn[i]/atr[i]
            ss=dip[i]+din[i]; dx[i]=100*abs(dip[i]-din[i])/ss if ss>0 else 0.0
    adx[2*p-1]=sum(dx[p:2*p])/p
    for i in range(2*p,n):
        if dx[i] is not None and adx[i-1] is not None: adx[i]=(adx[i-1]*(p-1)+dx[i])/p
    return adx,dip,din
def macd_s(cls,f=12,s=26,sig=9):
    ef=ema(cls,f);es=ema(cls,s)
    line=[(ef[i]-es[i]) if ef[i] is not None and es[i] is not None else None for i in range(len(cls))]
    o=[None]*len(cls);k=2/(sig+1);e=None
    for i,x in enumerate(line):
        if x is None: continue
        e=x if e is None else x*k+e*(1-k);o[i]=e
    return line,o
def bb_lower(cls,n=20,k=2.):
    l=[None]*len(cls)
    for i in range(n-1,len(cls)):
        w=cls[i-n+1:i+1];m=sum(w)/n;sd=(sum((x-m)**2 for x in w)/n)**0.5; l[i]=m-k*sd
    return l
def stoch_s(bars,n=14):
    o=[None]*len(bars)
    for i in range(n-1,len(bars)):
        hi=max(b["high"] for b in bars[i-n+1:i+1]);lo=min(b["low"] for b in bars[i-n+1:i+1])
        o[i]=100*(bars[i]["close"]-lo)/(hi-lo) if hi>lo else 50
    return o
def vol_ma(bars,p=20):
    o=[None]*len(bars)
    for i in range(p-1,len(bars)): o[i]=sum(bars[j]["volume"] for j in range(i-p+1,i+1))/p
    return o
def obv_s(bars):
    o=[0.]*len(bars)
    for i in range(1,len(bars)):
        if bars[i]["close"]>bars[i-1]["close"]: o[i]=o[i-1]+bars[i]["volume"]
        elif bars[i]["close"]<bars[i-1]["close"]: o[i]=o[i-1]-bars[i]["volume"]
        else: o[i]=o[i-1]
    return o
def vwap_roll(bars,p=24):
    o=[None]*len(bars)
    for i in range(p-1,len(bars)):
        num=den=0.
        for j in range(i-p+1,i+1):
            tp=(bars[j]["high"]+bars[j]["low"]+bars[j]["close"])/3; num+=tp*bars[j]["volume"]; den+=bars[j]["volume"]
        o[i]=num/den if den>0 else None
    return o
def cci_s(bars,p=20):
    o=[None]*len(bars)
    for i in range(p-1,len(bars)):
        typ=[(bars[j]["high"]+bars[j]["low"]+bars[j]["close"])/3 for j in range(i-p+1,i+1)]
        sma=sum(typ)/p; md=sum(abs(t-sma) for t in typ)/p
        o[i]=(typ[-1]-sma)/(0.015*md) if md>0 else 0
    return o

print("Indicators per TF...", file=sys.stderr)
C={tf:[b["close"] for b in B[tf]] for tf in B}
IND={}
IND["1d"]={"close":C["1d"],"ema50":ema(C["1d"],50),"ema200":ema(C["1d"],200)}
a4,dp4,dn4=adx_di(B["4h"]); ml4,ms4=macd_s(C["4h"])
IND["4h"]={"close":C["4h"],"adx":a4,"dip":dp4,"din":dn4,"macd":ml4,"macdsig":ms4,
           "ema50":ema(C["4h"],50),"atr":atr_w(B["4h"]),"volma":vol_ma(B["4h"],20)}
ml1,ms1=macd_s(C["1h"])
IND["1h"]={"close":C["1h"],"rsi":rsi_s(C["1h"]),"stoch":stoch_s(B["1h"]),"bbl":bb_lower(C["1h"]),
           "ema200":ema(C["1h"],200),"macd":ml1,"macdsig":ms1}
_m15=macd_s(C["15m"]); IND["15m"]={"close":C["15m"],"macd":_m15[0],"macdsig":_m15[1]}
IND["4h"]["obv"]=obv_s(B["4h"]); IND["4h"]["obvema"]=ema(IND["4h"]["obv"],20); IND["4h"]["cci"]=cci_s(B["4h"])
IND["1h"]["vwap"]=vwap_roll(B["1h"],24)
IND["5m"]={"close":C["5m"],"ema20":ema(C["5m"],20)}
IND["1w"]={"close":C["1w"],"ema10":ema(C["1w"],10)}

def cidx(tf,t_close):
    bars=B[tf];ms=MS[tf];lo,hi,idx=0,len(bars)-1,-1
    while lo<=hi:
        m=(lo+hi)//2
        if bars[m]["time"]+ms<=t_close: idx=m;lo=m+1
        else: hi=m-1
    return idx
def utc_day(ts): d=datetime.datetime.utcfromtimestamp(ts/1000); return d.year*10000+d.month*100+d.day

def decide(t_close):
    """Trả (direction, score, atr4, regime_tag). No-lookahead."""
    i1d=cidx("1d",t_close)-0; i4=cidx("4h",t_close); i1=cidx("1h",t_close); i15=cidx("15m",t_close); i5=cidx("5m",t_close); iw=cidx("1w",t_close)
    if i4<30 or i1<200 or i1d<200: return None
    # daily D-1 (bar đã đóng) — cidx đã trả bar đã đóng nên dùng luôn
    atr4=IND["4h"]["atr"][i4]
    if not atr4 or atr4<=0: return None
    adx4=IND["4h"]["adx"][i4]
    trend=0
    if USE_1D and IND["1d"]["ema50"][i1d] is not None:
        trend += 1 if IND["1d"]["close"][i1d] > IND["1d"]["ema50"][i1d] else -1
    if USE_ADX and adx4 is not None and adx4>=ADX_TREND and IND["4h"]["dip"][i4] is not None:
        trend += 1 if IND["4h"]["dip"][i4] > IND["4h"]["din"][i4] else -1
    if USE_MACD:
        if IND["4h"]["macd"][i4] is not None and IND["4h"]["macdsig"][i4] is not None:
            trend += 1 if IND["4h"]["macd"][i4] > IND["4h"]["macdsig"][i4] else -1
        if IND["1h"]["macd"][i1] is not None and IND["1h"]["macdsig"][i1] is not None:
            trend += 1 if IND["1h"]["macd"][i1] > IND["1h"]["macdsig"][i1] else -1
    mr=0
    if USE_MEANREV:
        r=IND["1h"]["rsi"][i1]; st=IND["1h"]["stoch"][i1]; bbl=IND["1h"]["bbl"][i1]; px=IND["1h"]["close"][i1]
        if r is not None: mr += 1 if r<35 else (-1 if r>65 else 0)
        if st is not None: mr += 1 if st<20 else (-1 if st>80 else 0)
        if bbl is not None and px is not None: mr += 1 if px<=bbl else 0
    if USE_15M:  # 15m momentum confirm (chỉ số phụ TF nhỏ)
        if IND["15m"]["macd"][i15] is not None and IND["15m"]["macdsig"][i15] is not None:
            trend += 1 if IND["15m"]["macd"][i15] > IND["15m"]["macdsig"][i15] else -1
    if USE_OBV and IND["4h"]["obv"][i4] is not None and IND["4h"]["obvema"][i4] is not None:
        trend += 1 if IND["4h"]["obv"][i4] > IND["4h"]["obvema"][i4] else -1      # OBV: dòng tiền volume
    if USE_VWAP and IND["1h"]["vwap"][i1] is not None:
        trend += 1 if IND["1h"]["close"][i1] > IND["1h"]["vwap"][i1] else -1       # VWAP: giá trên/dưới value
    if USE_CCI and IND["4h"]["cci"][i4] is not None:
        cc=IND["4h"]["cci"][i4]; trend += 1 if cc>100 else (-1 if cc<-100 else 0)  # CCI: trend strength
    if USE_5M and i5>=20 and IND["5m"]["ema20"][i5] is not None:
        trend += 1 if IND["5m"]["close"][i5] > IND["5m"]["ema20"][i5] else -1       # 5m: timing momentum
    if USE_1W and iw>=10 and IND["1w"]["ema10"][iw] is not None:
        trend += 1 if IND["1w"]["close"][iw] > IND["1w"]["ema10"][iw] else -1       # 1w: trend cấp cao
    if adx4 is not None and adx4>=ADX_TREND: score=trend; tag="TREND"
    elif adx4 is not None and adx4<ADX_RANGE: score=mr; tag="RANGE"
    else: score=trend+mr; tag="MIX"
    if USE_VOL and IND["4h"]["volma"][i4] is not None and B["4h"][i4]["volume"]<IND["4h"]["volma"][i4]*0.8:
        score=int(score*0.5)  # volume yếu → giảm độ tin (không skip, chỉ kém decisive)
    return ("LONG" if score>=0 else "SHORT"), score, atr4, tag

# ── Simulate forced-daily ──
camps=[]; camp=None; last_day=-1; flip_day=-1; flip_n=0
bars1h=B["1h"]; n1h=len(bars1h)
WARM=cidx("1h", B["1d"][210]["time"])
for i in range(WARM,n1h):
    bar=bars1h[i]; t_close=bar["time"]+MS["1h"]; px=bar["close"]; day=utc_day(bar["time"]); hr=datetime.datetime.utcfromtimestamp(bar["time"]/1000).hour
    if camp is not None:
        c=camp; side=c["side"]; atr0=c["atr0"]; entry=c["entry"]
        tpm=(TP_M*1.5 if c["tag"]=="TREND" else TP_M*0.7) if REGADAPT else TP_M
        cutm=(CUT*1.3 if c["tag"]=="TREND" else CUT*0.85) if REGCUT else CUT
        if bar["high"]>c["hwm"]: c["hwm"]=bar["high"]
        if bar["low"]<c["lwm"]: c["lwm"]=bar["low"]
        closed=False; ex=None
        # SL first (anti-optimism)
        if side=="LONG":
            if bar["low"]<=entry-atr0*cutm: ex=(entry-atr0*cutm,"SL"); closed=True
            elif TRAIL>0:
                trp=c["hwm"]-atr0*TRAIL
                if bar["low"]<=trp and trp>=entry: ex=(trp,"TRAIL"); closed=True   # trail chỉ khi đã lãi
                elif bar["high"]>=entry+atr0*tpm: ex=(entry+atr0*tpm,"TP"); closed=True  # backstop TP rộng
            elif bar["high"]>=entry+atr0*tpm: ex=(entry+atr0*tpm,"TP"); closed=True
        else:
            if bar["high"]>=entry+atr0*cutm: ex=(entry+atr0*cutm,"SL"); closed=True
            elif TRAIL>0:
                trp=c["lwm"]+atr0*TRAIL
                if bar["high"]>=trp and trp<=entry: ex=(trp,"TRAIL"); closed=True
                elif bar["low"]<=entry-atr0*tpm: ex=(entry-atr0*tpm,"TP"); closed=True
            elif bar["low"]<=entry-atr0*tpm: ex=(entry-atr0*tpm,"TP"); closed=True
        if not closed and (i-c["open_i"])>=TS_H: ex=(px,"TIME"); closed=True
        if closed:
            xp,rs=ex; q=c["qty"]; fees=FEE*entry*q+FEE*xp*q
            pnl=q*(xp-entry) if side=="LONG" else q*(entry-xp)
            usd=pnl-fees; d=datetime.datetime.utcfromtimestamp(bar["time"]/1000)
            camps.append({"ret":usd/(entry*q),"usd":usd,"yr":d.year,"mo":d.strftime("%Y-%m"),"reason":rs,"side":side,"tag":c["tag"],"trig":c.get("trig","?"),
                          "ets":bars1h[c["open_i"]]["time"],"epx":entry,"xts":bar["time"],"xpx":xp})
            camp=None
            if FLIP and rs=="SL":   # reverse-v2: cắt xong, nếu vote multi-TF flip decisive ngược → đảo chiều luôn
                _tc=(bars1h[i-1]["time"]+MS["1h"]) if (FLIPSTRICT and i>=1) else t_close  # AUDIT: strict dùng bar i-1 đã đóng trước SL
                dec2=decide(_tc)
                if dec2 is not None:
                    d2,sc2,a2,tag2=dec2
                    if FLIPCAP>0 and day!=flip_day: flip_day=day; flip_n=0
                    capok=(FLIPCAP<=0) or (flip_n<FLIPCAP)
                    if d2!=side and abs(sc2)>=(FLIPDEC or DECISIVE) and a2 and a2>0 and capok:
                        if FLIPCAP>0: flip_n+=1
                        q2=BASE_QTY*min(max(1,abs(sc2)),CONVSIZE)
                        _e=xp if FLIPSTRICT else px  # AUDIT: strict vào tại giá SL (causal) thay vì bar-close
                        camp={"side":d2,"entry":_e,"atr0":a2,"open_i":i,"hwm":_e,"lwm":_e,"tag":tag2,"qty":q2,"trig":"flip"}; last_day=day
        continue
    if last_day==day: continue
    dec=decide(t_close)
    if dec is None: continue
    direction,score,atr4,tag=dec
    # no skip: vào khi decisive HOẶC tới deadline (luôn có 1 lệnh/ngày)
    if abs(score)>=DECISIVE or (not NOFORCE and hr>=DEADLINE):
        if ANTITOP>0 and hr<DEADLINE:   # (a) chống đu đỉnh: chờ giá tốt hơn trong ngày (deadline vẫn vào)
            i4a=cidx("4h",t_close)
            if i4a>=20:
                rec=B["4h"][i4a-20:i4a]; _lo=min(x["low"] for x in rec); _hi=max(x["high"] for x in rec)
                _pos=(px-_lo)/(_hi-_lo) if _hi>_lo else 0.5
                if (direction=="LONG" and _pos>ANTITOP) or (direction=="SHORT" and _pos<1-ANTITOP): continue
        q=BASE_QTY*min(max(1,abs(score)),CONVSIZE)
        camp={"side":direction,"entry":px,"atr0":atr4,"open_i":i,"hwm":px,"lwm":px,"tag":tag,"qty":q,"trig":("score" if abs(score)>=DECISIVE else "deadline")}; last_day=day
if camp is not None:
    d=datetime.datetime.utcfromtimestamp(bars1h[-1]["time"]/1000)
    xp=bars1h[-1]["close"]; side=camp["side"]; entry=camp["entry"]; q=camp["qty"]
    usd=(q*(xp-entry) if side=="LONG" else q*(entry-xp))-2*FEE*entry*q
    camps.append({"ret":usd/(entry*q),"usd":usd,"yr":d.year,"mo":d.strftime("%Y-%m"),"reason":"EOD","side":side,"tag":camp["tag"],"trig":camp.get("trig","?"),
                  "ets":bars1h[camp["open_i"]]["time"],"epx":entry,"xts":bars1h[-1]["time"],"xpx":xp})

# ── Report ──
n=len(camps)
rets=[c["ret"] for c in camps]; mean=sum(rets)/n; sd=(sum((r-mean)**2 for r in rets)/n)**0.5 or 1e-9
ra=mean/sd; wr=sum(1 for r in rets if r>0)/n*100
by_yr=defaultdict(float)
for c in camps: by_yr[c["yr"]]+=c["usd"]
stab=sum(1 for y in by_yr if by_yr[y]>0)
tr=[c["ret"] for c in camps if c["yr"]<2023]; te=[c["ret"] for c in camps if c["yr"]>=2023]
def raf(x):
    if len(x)<5: return 0
    m=sum(x)/len(x); s=(sum((v-m)**2 for v in x)/len(x))**0.5; return m/s if s>0 else 0
toggles=" ".join(t for t,u in [("1d",USE_1D),("adx",USE_ADX),("macd",USE_MACD),("meanrev",USE_MEANREV),("vol",USE_VOL),("15m",USE_15M),("obv",USE_OBV),("vwap",USE_VWAP),("cci",USE_CCI),("5m",USE_5M),("1w",USE_1W)] if u)
print(f"  [ON: {toggles} | cut{CUT} tp{TP_M} ts{TS_H} decisive{DECISIVE}]")
print(f"  n={n} ({n//(len(by_yr) or 1)}/yr)  WR={wr:.0f}%  RA={ra:.3f}")
print(f"  DOLLAR: ${sum(c['usd'] for c in camps):+.0f} /7y  |  recent 2023-26: ${sum(c['usd'] for c in camps if c['yr']>=2023):+.0f}")
print(f"  $-stab {stab}/{len(by_yr)}yr  |  WF TRAIN RA={raf(tr):.3f} TEST RA={raf(te):.3f}")
for sd_ in ("LONG","SHORT"):
    cs=[c for c in camps if c["side"]==sd_]
    if cs: print(f"    {sd_:5s}: n={len(cs):4d} WR={sum(1 for c in cs if c['ret']>0)/len(cs)*100:.0f}% $among={sum(c['usd'] for c in cs):+.0f}")
for tg in ("TREND","RANGE","MIX"):
    cs=[c for c in camps if c["tag"]==tg]
    if cs: print(f"    regime {tg:5s}: n={len(cs):4d} WR={sum(1 for c in cs if c['ret']>0)/len(cs)*100:.0f}% $among={sum(c['usd'] for c in cs):+.0f}")
print("  per-year $: " + "  ".join(f"{y}:{by_yr[y]:+.0f}" for y in sorted(by_yr)))
_bt=defaultdict(lambda:[0,0.0,0])
for c in camps:
    k=c.get("trig","?"); _bt[k][0]+=1; _bt[k][1]+=c["usd"]; _bt[k][2]+=(1 if c["ret"]>0 else 0)
print("  THEO TRIGGER ENTRY: " + " | ".join(f"{k}: n={v[0]} ${v[1]:+.0f} WR{v[2]/max(v[0],1)*100:.0f}%" for k,v in sorted(_bt.items())))
_fdmo=defaultdict(float); _fdct=defaultdict(int)
for c in camps: _fdmo[c["mo"]]+=c["ret"]; _fdct[c["mo"]]+=1
print("FD_MONTHLY " + json.dumps(dict(_fdmo)))
_cts=[_fdct[m] for m in sorted(_fdct)]
print(f"TRADES/THÁNG: {sum(_cts)} lệnh / {len(_cts)} tháng = TB {sum(_cts)/len(_cts):.1f}/tháng (min {min(_cts)}, max {max(_cts)})")
_byym=defaultdict(lambda: defaultdict(int))
for c in camps: y,m=c["mo"].split("-"); _byym[int(y)][int(m)]+=1
print("Count năm×tháng:")
print("year " + "".join(f"{('M'+str(m)):>4}" for m in range(1,13)) + "  TOT")
for y in sorted(_byym):
    row=_byym[y]; tot=sum(row.values())
    print(f"{y} " + "".join(f"{(row[m] if m in row else 0):>4}" for m in range(1,13)) + f"  {tot:>4}")
with open("/tmp/general_trades.json","w") as _f:
    json.dump([{k:c.get(k) for k in ("ets","epx","xts","xpx","side","reason","ret")} for c in camps], _f)
print(f"DUMPED {len(camps)} trades -> /tmp/general_trades.json")
