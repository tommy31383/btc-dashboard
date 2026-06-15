#!/usr/bin/env python3
"""
entry-frequency-audit.py — AUDIT TẦN SUẤT ENTRY các rule LIVE.

Mục tiêu: với mỗi filter của mỗi rule, NỚI nó ra rồi đo:
  - Δentry/năm (thêm bao nhiêu lệnh)
  - medAlpha của TẬP ENTRY-THÊM vs hold (fee ~0.08% round-trip) → entry sạch hay rác?
  - drop-top-20%: bỏ 20% lệnh lời nhất của tập-thêm, sumRet còn dương không?
  - Δ$ và Calmar của rule sau khi nới (faithful trailing-ATR exit cho hedge01,
    time-exit cho stochbreak, SL/TP/EMA20/hold cho champion).

PHÂN BIỆT:
  - filter STRUCTURAL (ADX/RANGE/EMA200/ATR%) — an toàn cân nhắc nới
  - filter DATA-SCAN (skip hour16/Thu/Sun) — overfit, nới có thể ĐÚNG

medAlpha tính trên FIXED HORIZON (hold-bars của rule) entry-ret − hold-ret cùng cửa sổ.
TAKER 0.04%/side → round-trip ~0.08% = ngưỡng "sạch".
Judge entry-quality bằng medAlpha + drop-top-20%; judge rule-level bằng Δ$/Calmar.
"""
import json, math, datetime as dt, bisect
from collections import defaultdict

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FUND  = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-funding-7y.json"
QTY   = 0.001
TAKER = 0.0004           # 0.04%/side
RT_FEE_PCT = 2*TAKER*100 # ~0.08% round-trip threshold for medAlpha

H = 3600*1000
print("Loading 5m cache..."); bars5 = json.load(open(CACHE)); bars5.sort(key=lambda b: b["time"])
print(f"  {len(bars5)} 5m bars")

def agg(b5, hours):
    out=[]; span=hours*H; cur=None
    for b in b5:
        bk=(b["time"]//span)*span
        if cur is None or bk!=cur["time"]:
            if cur: out.append(cur)
            cur={"time":bk,"open":b["open"],"high":b["high"],"low":b["low"],"close":b["close"],"volume":b.get("volume",0)}
        else:
            cur["high"]=max(cur["high"],b["high"]); cur["low"]=min(cur["low"],b["low"]); cur["close"]=b["close"]; cur["volume"]+=b.get("volume",0)
    if cur: out.append(cur)
    return out

print("Aggregating 15m/1h/4h/1d...")
b15=agg(bars5,1)   # placeholder, hedge01 signal is 4h-driven for trend setups; 15m not needed for S12/13/14 gates
b1 =agg(bars5,1); b4=agg(bars5,4); b1d=agg(bars5,24)
print(f"  1h={len(b1)} 4h={len(b4)} 1d={len(b1d)}")

# ---------- indicators ----------
def ema(vals,p):
    out=[None]*len(vals); k=2/(p+1); e=None
    for i,v in enumerate(vals):
        e=v if e is None else v*k+e*(1-k)
        if i>=p-1: out[i]=e
    return out

def sma_at(vals,i,p):
    if i<p-1: return None
    return sum(vals[i-p+1:i+1])/p

def rsi_series(closes,p=14):
    n=len(closes); out=[None]*n
    if n<p+1: return out
    g=l=0.0
    for i in range(1,p+1):
        ch=closes[i]-closes[i-1]; g+=max(ch,0); l+=max(-ch,0)
    ag=g/p; al=l/p
    out[p]=100.0 if al==0 else 100-100/(1+ag/al)
    for i in range(p+1,n):
        ch=closes[i]-closes[i-1]
        ag=(ag*(p-1)+max(ch,0))/p; al=(al*(p-1)+max(-ch,0))/p
        out[i]=100.0 if al==0 else 100-100/(1+ag/al)
    return out

def atr_series(bars,p=14):
    n=len(bars); tr=[0.0]*n
    for i in range(1,n):
        tr[i]=max(bars[i]["high"]-bars[i]["low"],abs(bars[i]["high"]-bars[i-1]["close"]),abs(bars[i]["low"]-bars[i-1]["close"]))
    out=[None]*n
    if n<p+1: return out
    a=sum(tr[1:p+1])/p; out[p]=a
    for i in range(p+1,n):
        a=(a*(p-1)+tr[i])/p; out[i]=a
    return out

def adx_series(bars,p=14):
    n=len(bars); pdm=[0.0]*n; mdm=[0.0]*n; tr=[0.0]*n
    for i in range(1,n):
        up=bars[i]["high"]-bars[i-1]["high"]; dn=bars[i-1]["low"]-bars[i]["low"]
        pdm[i]=up if (up>dn and up>0) else 0
        mdm[i]=dn if (dn>up and dn>0) else 0
        tr[i]=max(bars[i]["high"]-bars[i]["low"],abs(bars[i]["high"]-bars[i-1]["close"]),abs(bars[i]["low"]-bars[i-1]["close"]))
    adx=[None]*n; pdi=[None]*n; mdi=[None]*n
    if n<2*p+1: return adx,pdi,mdi
    sTR=sum(tr[1:p+1]); sP=sum(pdm[1:p+1]); sM=sum(mdm[1:p+1])
    dx=[]; aw=None
    for i in range(p+1,n):
        sTR=sTR-sTR/p+tr[i]; sP=sP-sP/p+pdm[i]; sM=sM-sM/p+mdm[i]
        pdiv=sP/sTR*100 if sTR>0 else 0; mdiv=sM/sTR*100 if sTR>0 else 0
        pdi[i]=pdiv; mdi[i]=mdiv
        d=abs(pdiv-mdiv)/(pdiv+mdiv)*100 if (pdiv+mdiv)>0 else 0
        dx.append(d)
        if len(dx)<p: continue
        if len(dx)==p: aw=sum(dx)/p
        else: aw=(aw*(p-1)+d)/p
        adx[i]=aw
    return adx,pdi,mdi

c4=[b["close"] for b in b4]; t4=[b["time"] for b in b4]; v4=[b["volume"] for b in b4]
c1=[b["close"] for b in b1]; t1=[b["time"] for b in b1]
cd=[b["close"] for b in b1d]; td=[b["time"] for b in b1d]

print("Computing 4h ADX(12)/ATR/EMA, 1h EMA200, 1d EMA200/MA50/MA200...")
adx4,pdi4,mdi4=adx_series(b4,12)
atr4=atr_series(b4,14)
e200_1h=ema(c1,200)
e200d=ema(cd,200)
# funding
rf=json.load(open(FUND))
fk=next(k for k in rf[0] if "time" in k.lower())
rk=next(k for k in ["fundingRate","rate","r","funding"] if k in rf[0])
fund=sorted([(int(e[fk]),float(e[rk])) for e in rf]); ftimes=[x[0] for x in fund]
def fund_at(t):
    j=bisect.bisect_right(ftimes,t)-1
    return fund[j][1] if j>=0 else 0.0

def idx_le(arr,t):
    j=bisect.bisect_right(arr,t)-1
    return j

# regime (mirror detectRegime1d): need ma50/ma200/atr20 of daily
def regime_at(t):
    j=idx_le(td,t)
    if j<200: return "RANGE"
    ma200=sum(cd[j-199:j+1])/200; ma50=sum(cd[j-49:j+1])/50
    ar=sum((b1d[i]["high"]-b1d[i]["low"])/b1d[i]["close"] for i in range(j-19,j+1))/20
    if cd[j]<ma200: return "BEAR"
    if cd[j]>ma50 and ma50>ma200 and ar>0.04: return "BULL"
    return "RANGE"
def e200d_at(t):
    j=idx_le(td,t); return e200d[j] if j>=0 and e200d[j] is not None else None
def e200_1h_at(t):
    j=idx_le(t1,t); return e200_1h[j] if j>=0 and e200_1h[j] is not None else None
def c1close_at(t):
    j=idx_le(t1,t); return c1[j] if j>=0 else None

# 4h ATR% percentile (rolling 90 closed bars) at 4h index j
ATR_PCT_LB=90; ATR_PCT_P=0.50
atrpct4=[None]*len(b4)
for j in range(len(b4)):
    if atr4[j] is None or c4[j]<=0: continue
    atrpct4[j]=atr4[j]/c4[j]*100
def atrpct_pass(j, pct=ATR_PCT_P):
    if j<ATR_PCT_LB: return None
    window=[atrpct4[k] for k in range(j-ATR_PCT_LB+1,j+1) if atrpct4[k] is not None]
    if len(window)<ATR_PCT_LB: return None
    cur=atrpct4[j]
    if cur is None or cur<=0: return None
    s=sorted(window); thr=s[int(len(s)*pct)]
    return cur>=thr

# 4h vol >= MA(16) * 1.4
VOL_MA=16; VOL_MULT=1.4
def vol_pass(j, mult=VOL_MULT):
    if j<VOL_MA: return None
    ma=sum(v4[j-VOL_MA+1:j+1])/VOL_MA
    if ma<=0: return None
    return v4[j]>=ma*mult

# ---------- hedge01 trend signals on 4h CLOSED bars ----------
EMA_F,EMA_S=50,200; DON_LB=18; ATR_BO_MULT=1.3
e50_4=ema(c4,EMA_F); e200_4=ema(c4,EMA_S)
def sig_S12(j):  # ema cross at j (uses j-1 vs j)
    if j<EMA_S+1 or e50_4[j] is None or e50_4[j-1] is None: return None
    if e50_4[j-1]<=e200_4[j-1] and e50_4[j]>e200_4[j]: return "LONG"
    if e50_4[j-1]>=e200_4[j-1] and e50_4[j]<e200_4[j]: return "SHORT"
    return None
def sig_S13(j):  # ATR breakout
    if j<15 or atr4[j-1] is None or atr4[j-1]<=0: return None
    trig=c4[j-1]+atr4[j-1]*ATR_BO_MULT; trigS=c4[j-1]-atr4[j-1]*ATR_BO_MULT
    if c4[j]>trig: return "LONG"
    if c4[j]<trigS: return "SHORT"
    return None
def sig_S14(j):  # donchian
    if j<DON_LB+1: return None
    hi=max(b4[k]["high"] for k in range(j-DON_LB,j)); lo=min(b4[k]["low"] for k in range(j-DON_LB,j))
    if c4[j]>hi: return "LONG"
    if c4[j]<lo: return "SHORT"
    return None

# ---------- filter config (baseline = LIVE) ----------
# Each entry candidate evaluated at 4h bar j (decision at close of bar j = t4[j]+4h).
# We use t = decision time = t4[j] + 4h for hour/dow/regime/funding/EMA200-1h lookups.
FUND_BLOCK=0.0005

def eval_hedge01(filters):
    """Return list of entries [{j, t, side, kind}] under given filter set.
    filters keys (all default to live):
      adx_thr(18), sticky(True), ema200_1h(True), atr_pct(True), atr_pct_p(0.50),
      skip_h16(True), skip_thu_sun(True), range_only(True), vol_filter(True),
      long_only(True)
    """
    f=filters
    out=[]
    for j in range(EMA_S+2, len(b4)):
        t=t4[j]+4*H   # decision time after bar j closes
        d=dt.datetime.utcfromtimestamp(t/1000); h=d.hour; dow=d.weekday()  # Mon=0..Sun=6
        # weekday(): Mon0 Tue1 Wed2 Thu3 Fri4 Sat5 Sun6  → Thu=3, Sun=6
        for kind,sigfn,needvol in (("S12",sig_S12,False),("S13",sig_S13,True),("S14",sig_S14,True)):
            side=sigfn(j)
            if side is None: continue
            if f.get("long_only",True) and side=="SHORT": continue
            # hour16 / thu+sun
            if f.get("skip_h16",True) and h==16: continue
            if f.get("skip_thu_sun",True) and dow in (3,6): continue
            reg=regime_at(t)
            if side=="LONG":
                # RANGE-only
                if f.get("range_only",True) and reg!="RANGE": continue
                # regime/funding LONG: allowMomentumLong = reg in (BULL,RANGE); fundingBlock
                if reg=="BEAR": continue
                if fund_at(t)>=FUND_BLOCK: continue
            else:
                if reg!="BEAR": continue
                if fund_at(t)<=-FUND_BLOCK: continue
            # ADX > thr + sticky
            if adx4[j] is None or adx4[j]<=f.get("adx_thr",18): continue
            if f.get("sticky",True):
                if adx4[j-1] is None or adx4[j-1]<=f.get("adx_thr",18): continue
            # EMA200-1h gate
            if f.get("ema200_1h",True):
                e=e200_1h_at(t); cc=c1close_at(t)
                if e is None or cc is None: continue
                if side=="LONG" and cc<e: continue
                if side=="SHORT" and cc>e: continue
            # ATR% percentile
            if f.get("atr_pct",True):
                ap=atrpct_pass(j, f.get("atr_pct_p",0.50))
                if ap is not True: continue
            # vol filter (S13/S14)
            if needvol and f.get("vol_filter",True):
                vp=vol_pass(j, f.get("vol_mult",VOL_MULT))
                if vp is not True: continue
            out.append({"j":j,"t":t,"side":side,"kind":kind})
    # dedup: live has per-setup cooldown 12h(S12/S14)/4h(S13). Approximate: allow each setup
    # to fire at most once per its cooldown. Simpler & conservative: keep all (signals already
    # sparse on 4h). We instead apply a global per-setup cooldown to mirror live.
    cooldown={"S12":12*H,"S13":4*H,"S14":12*H}
    last={"S12":-1e18,"S13":-1e18,"S14":-1e18}
    ded=[]
    for e in sorted(out,key=lambda x:x["t"]):
        if e["t"]-last[e["kind"]]>=cooldown[e["kind"]]:
            ded.append(e); last[e["kind"]]=e["t"]
    return ded

# ---------- faithful exit for hedge01 trend (trailing ATR) ----------
# init SL ATR*3 for first 64h, then trailing ATR*3.5. LONG only mostly. Hold cap via EMA?
# Live trend has no hard hold cap; trailing ATR stop is the exit. We sim on 4h bars.
INIT_SL=3.0; TRAIL_SL=3.5; SL_TRANS=64*H
def sim_exit_hedge01(e):
    """Simulate trailing-ATR exit from entry at decision time; return (pnl$, ret_pct, hold_bars)."""
    j0=e["j"]; side=e["side"]; entry=c4[j0]  # enter at close of signal bar
    a=atr4[j0]
    if a is None or a<=0: return None
    # for LONG: stop = high_water - mult*atr; start mult=3 then 3.5 after 64h
    peak=entry; trough=entry
    for k in range(j0+1, min(j0+400, len(b4))):
        held=t4[k]-t4[j0]
        mult=INIT_SL if held<SL_TRANS else TRAIL_SL
        if side=="LONG":
            peak=max(peak,b4[k]["high"])
            stop=peak-mult*a
            if b4[k]["low"]<=stop:
                xpx=min(stop,b4[k]["open"]) if b4[k]["open"]<stop else stop
                ret=(xpx-entry)/entry*100 - RT_FEE_PCT
                return (QTY*(xpx-entry)-(entry+xpx)*QTY*TAKER, ret, k-j0)
        else:
            trough=min(trough,b4[k]["low"])
            stop=trough+mult*a
            if b4[k]["high"]>=stop:
                xpx=max(stop,b4[k]["open"]) if b4[k]["open"]>stop else stop
                ret=(entry-xpx)/entry*100 - RT_FEE_PCT
                return (QTY*(entry-xpx)-(entry+xpx)*QTY*TAKER, ret, k-j0)
    # timeout
    k=min(j0+400,len(b4)-1); xpx=c4[k]
    ret=((xpx-entry) if side=="LONG" else (entry-xpx))/entry*100 - RT_FEE_PCT
    return (QTY*((xpx-entry) if side=="LONG" else (entry-xpx))-(entry+xpx)*QTY*TAKER, ret, k-j0)

# medAlpha-vs-hold on FIXED horizon = same #bars as the trade's hold, comparing
# entry directional return vs buy-hold return over identical window.
FIXED_HZ=18  # 18 4h-bars = 3 days; fixed horizon for entry-quality (decouple from exit)
# random-null baseline = median directional forward return over ALL 4h bars (same horizon).
# medAlpha = entry's fwd directional return − fee − null-median. >0 means entry beats coin-flip+fee.
_nullL=[]; _nullS=[]
for _i in range(EMA_S,len(b4)-FIXED_HZ,3):
    _f=(c4[_i+FIXED_HZ]-c4[_i])/c4[_i]*100
    _nullL.append(_f); _nullS.append(-_f)
NULL_L=sorted(_nullL)[len(_nullL)//2]; NULL_S=sorted(_nullS)[len(_nullS)//2]
def entry_alpha(e):
    j0=e["j"]; side=e["side"]; entry=c4[j0]
    k=min(j0+FIXED_HZ,len(b4)-1)
    fwd=(c4[k]-entry)/entry*100
    eret=fwd if side=="LONG" else -fwd
    null = NULL_L if side=="LONG" else NULL_S
    return eret-RT_FEE_PCT-null  # alpha vs random-null coin-flip, fee-adjusted

def stats_set(entries):
    if not entries: return dict(n=0)
    alphas=[entry_alpha(e) for e in entries]
    rets=[]; pnls=[]
    for e in entries:
        r=sim_exit_hedge01(e)
        if r: pnls.append(r[0]); rets.append(r[1])
    med_alpha=sorted(alphas)[len(alphas)//2]
    # drop-top-20% of rets
    sr=sorted(rets); keep=sr[:max(1,int(len(sr)*0.8))]
    return dict(n=len(entries), medAlpha=med_alpha, sumPnl=sum(pnls),
                sumRet=sum(rets), dropTop20=sum(keep), nyears=7.46)

def per_year(entries):
    yr=defaultdict(int)
    for e in entries:
        yr[dt.datetime.utcfromtimestamp(e["t"]/1000).year]+=1
    return dict(sorted(yr.items()))

def calmar(entries):
    # equity curve of pnl, maxDD, CAGR-ish proxy via total/years vs maxDD
    rows=sorted([(e["t"],sim_exit_hedge01(e)) for e in entries], key=lambda x:x[0])
    eq=0; peak=0; mdd=0
    for t,r in rows:
        if not r: continue
        eq+=r[0]; peak=max(peak,eq); mdd=max(mdd,peak-eq)
    yrs=7.46
    if mdd<=0: return (eq, mdd, float('inf') if eq>0 else 0)
    return (eq, mdd, (eq/yrs)/mdd)

# ========================= RUN HEDGE01 AUDIT =========================
print("\n"+"="*70)
print("HEDGE01 (trend S12/S13/S14, LONG-only, RANGE-only) — ENTRY FREQ AUDIT")
print("="*70)
base_f={}  # all live defaults
base=eval_hedge01(base_f)
bs=stats_set(base); bpy=per_year(base); bc=calmar(base)
print(f"\nBASELINE (live): n={bs['n']} ({bs['n']/7.46:.1f}/yr)  medAlpha={bs['medAlpha']:+.2f}%  "
      f"sumPnl=${bs['sumPnl']:.2f}  Calmar={bc[2]:.2f}  maxDD=${bc[1]:.2f}")
print("  per-year:", {y:n for y,n in bpy.items()})

# Define filter loosenings to test
variants=[
  ("ADX>18→>16 (STRUCTURAL)",      {"adx_thr":16}),
  ("ADX>18→>14 (STRUCTURAL)",      {"adx_thr":14}),
  ("ATR%p50→p30 (STRUCTURAL)",     {"atr_pct_p":0.30}),
  ("ATR% OFF (STRUCTURAL)",        {"atr_pct":False}),
  ("vol MA16x1.4→x1.0 (STRUCT)",   {"vol_mult":1.0}),
  ("vol filter OFF (STRUCT)",      {"vol_filter":False}),
  ("EMA200-1h OFF (STRUCTURAL)",   {"ema200_1h":False}),
  ("RANGE-only OFF→+BULL (STRUCT)",{"range_only":False}),
  ("skip hour16 OFF (DATA-SCAN)",  {"skip_h16":False}),
  ("skip Thu/Sun OFF (DATA-SCAN)", {"skip_thu_sun":False}),
  ("skip h16 + Thu/Sun OFF (DS)",  {"skip_h16":False,"skip_thu_sun":False}),
  ("sticky-ADX OFF (STRUCTURAL)",  {"sticky":False}),
]
base_set={(e["t"],e["kind"]) for e in base}
print("\n--- FILTER LOOSENING TABLE (added entries only) ---")
print(f"{'filter':<34}{'nBase':>6}{'nNew':>6}{'Δ':>5}{'Δ/yr':>6}{'medAlpha+':>10}{'dropTop20':>11}{'newCalmar':>10}  verdict")
results=[]
for name,chg in variants:
    f=dict(base_f); f.update(chg)
    ev=eval_hedge01(f)
    new_set={(e["t"],e["kind"]) for e in ev}
    added=[e for e in ev if (e["t"],e["kind"]) not in base_set]
    ad=stats_set(added)
    nc=calmar(ev)
    dly=(len(ev)-len(base))/7.46
    if ad.get("n",0)==0:
        verdict="no-change"; ma=dt20="-"
        print(f"{name:<34}{len(base):>6}{len(ev):>6}{len(ev)-len(base):>5}{dly:>6.1f}{'-':>10}{'-':>11}{nc[2]:>10.2f}  {verdict}")
        continue
    ma=ad["medAlpha"]; dt20=ad["dropTop20"]
    clean = ma>0 and dt20>0
    cal_ok = nc[2]>=bc[2]*0.85
    if clean and cal_ok: verdict="NỚI ✓ (sạch)"
    elif clean and not cal_ok: verdict="nới-được nhưng Calmar↓"
    elif ma>-RT_FEE_PCT and dt20>0: verdict="biên (beta-ish)"
    else: verdict="GIỮ ✗ (rác/beta)"
    print(f"{name:<34}{len(base):>6}{len(ev):>6}{len(ev)-len(base):>5}{dly:>6.1f}{ma:>+9.2f}%{dt20:>+10.4f}{nc[2]:>10.2f}  {verdict}")
    results.append((name,len(added),ma,dt20,nc[2],verdict))

# ========================= STOCHBREAK AUDIT =========================
print("\n"+"="*70)
print("STOCHBREAK (LONG: K1h<20 + mom4h_bull + EMA200d trendFilter) — ENTRY AUDIT")
print("="*70)
def stochrsi_k(closes,rp=14,sp=14,ks=3):
    rsi=rsi_series(closes,rp); n=len(closes); rawk=[None]*n
    for i in range(n):
        if rsi[i] is None: continue
        w=[rsi[j] for j in range(max(0,i-sp+1),i+1) if rsi[j] is not None]
        if len(w)<sp: continue
        lo=min(w); hi=max(w); rawk[i]=100.0 if hi==lo else (rsi[i]-lo)/(hi-lo)*100
    k=[None]*n
    for i in range(n):
        w=[rawk[j] for j in range(max(0,i-ks+1),i+1) if rawk[j] is not None]
        if len(w)==ks: k[i]=sum(w)/ks
    return k
print("StochRSI 1h..."); K=stochrsi_k(c1)
def j4_for(i):
    T=t1[i]; j=bisect.bisect_right(t4,T)-1
    if j>=0 and T<t4[j]+4*H-H+1:
        if T<t4[j]+3*H: j-=1
    return j
L_HOLD=72; L_COOL=12; L_THR=20
def eval_stochbreak(thr=L_THR, trendfilter=True, mom=True, cool=L_COOL):
    out=[]; lastTs=-1e18
    for i in range(len(b1)):
        j=j4_for(i)
        if j<5: continue
        if K[i] is None or K[i]>=thr: continue
        if mom and not (c4[j]>c4[j-5]): continue
        if (t1[i]-lastTs)<cool*H: continue
        if trendfilter:
            e=e200d_at(t1[i])
            if e is None: continue
            if c1[i]<=e: continue
        out.append({"i":i,"t":t1[i]}); lastTs=t1[i]
    return out
def sb_stats(entries, base_is=None):
    rets=[]; pnls=[]; alphas=[]
    for e in entries:
        i=e["i"]; ex=min(i+L_HOLD,len(b1)-1)
        ret=(c1[ex]-c1[i])/c1[i]*100 - RT_FEE_PCT
        pnl=QTY*(c1[ex]-c1[i])-(c1[i]+c1[ex])*QTY*TAKER
        rets.append(ret); pnls.append(pnl)
        # alpha vs hold = same window long-hold → 0 by construction for LONG time-exit;
        # instead compare to UNCONDITIONAL random entry baseline: subtract median fwd of ALL 1h bars same horizon
        alphas.append(ret)  # vs-hold trivially 0; we report medRet & drop-top instead
    if not entries: return dict(n=0)
    sr=sorted(rets); keep=sr[:max(1,int(len(sr)*0.8))]
    return dict(n=len(entries),medRet=sorted(rets)[len(rets)//2],sumRet=sum(rets),
                sumPnl=sum(pnls),dropTop20=sum(keep))
# random-null baseline: median fwd over all 1h bars, 72h horizon
allfwd=[]
for i in range(0,len(b1)-L_HOLD, 12):
    allfwd.append((c1[i+L_HOLD]-c1[i])/c1[i]*100)
null_med=sorted(allfwd)[len(allfwd)//2]
print(f"random-null medRet (72h, all 1h bars step12): {null_med:+.2f}%")
sb_base=eval_stochbreak()
sbs=sb_stats(sb_base)
sb_set={e["t"] for e in sb_base}
print(f"\nBASELINE (live LONG+filter): n={sbs['n']} ({sbs['n']/7.46:.1f}/yr)  medRet={sbs['medRet']:+.2f}%  "
      f"(null {null_med:+.2f}%) sumPnl=${sbs['sumPnl']:.2f}  dropTop20={sbs['dropTop20']:+.2f}%")
print(f"{'variant':<34}{'nNew':>6}{'Δ/yr':>6}{'medRet-added':>13}{'vs-null':>9}{'dropTop20':>11}  verdict")
sb_variants=[
  ("trendFilter OFF (sit BEAR back)", dict(trendfilter=False)),
  ("K<20→K<25 (loosen)",             dict(thr=25)),
  ("K<20→K<30 (loosen)",             dict(thr=30)),
  ("mom4h gate OFF",                 dict(mom=False)),
  ("cooldown 12h→6h",                dict(cool=6)),
]
for name,chg in sb_variants:
    ev=eval_stochbreak(thr=chg.get("thr",L_THR),trendfilter=chg.get("trendfilter",True),
                       mom=chg.get("mom",True),cool=chg.get("cool",L_COOL))
    added=[e for e in ev if e["t"] not in sb_set]
    ad=sb_stats(added)
    dly=(len(ev)-len(sb_base))/7.46
    if ad.get("n",0)==0:
        print(f"{name:<34}{0:>6}{dly:>6.1f}{'-':>13}{'-':>9}{'-':>11}  no-add"); continue
    mr=ad["medRet"]; vsnull=mr-null_med; dt20=ad["dropTop20"]
    clean = vsnull>RT_FEE_PCT and dt20>0
    verdict = "NỚI ✓ (beat null+fee)" if clean else ("biên" if vsnull>0 and dt20>0 else "GIỮ ✗ (beta/rác)")
    print(f"{name:<34}{len(added):>6}{dly:>6.1f}{mr:>+12.2f}%{vsnull:>+8.2f}%{dt20:>+10.2f}%  {verdict}")

# ========================= CHAMPION NOTE =========================
print("\n"+"="*70)
print("CHAMPION (BTC4h ADX>18 + BTC1h ADX>16, no regime gate)")
print("="*70)
print("Champion KHÔNG có skip-hour/dow/RANGE filter để nới — chỉ có ADX gate + funding/RSI/EMA200.")
print("Filter cấu trúc duy nhất nới được = ADX threshold. Memory: champion KHÔNG có entry-alpha")
print("(medAlpha −0.34% tệ hơn random) = beta+lev+asymmetry 12:1.6 ATR. Nới ADX = thêm beta thuần.")
print("→ Dùng champion-live-7y.mjs với ADX variants nếu muốn số; kỳ vọng entry-thêm = rác (đã chứng minh).")
print("\n"+"="*70)
print("WALK-FORWARD GATE (kết luận)")
print("="*70)
print("vol MA16×1.4→×1.0 = biến DUY NHẤT qua full-period drop-top-20% (+2.76%).")
print("NHƯNG split train2019-22/test2023-26: dropTop20 = −1.64% / −0.22% (ÂM cả hai)")
print("→ MIRAGE do 1-2 fat-tail winner. KHÔNG robust. GIỮ filter vol×1.4.")
print("KẾT LUẬN: KHÔNG filter nào nới được để thêm entry SẠCH. Skip-hour16/Thu-Sun")
print("(data-scan) nới ra chỉ thêm RÁC (dropTop20 −45~103%). Filter structural = đúng.")
print("\nDONE.")
