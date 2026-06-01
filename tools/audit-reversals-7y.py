#!/usr/bin/env python3
"""
audit-reversals-7y.py — Catalog tất cả bullish reversal patterns, 7y full cycle.

20 patterns:
  C1: Hammer          C2: Bullish Engulfing   C3: Morning Star (3 bars)
  C4: Dragonfly Doji  C5: Piercing Line
  I1: Stoch(14) cross>20  I2: RSI divergence  I3: MACD divergence
  I4: CCI cross>-100      I5: Williams%R cross>-80
  P1: Liquidity sweep (wick below 20-bar low + close above)
  P2: False breakdown EMA200 1h (low < ema, close > ema)
  P3: Higher low structure (recent 20-bar low > older 20-bar low)
  P4: Round $1000 level rejection
  P5: Donchian 20-bar low touch + bullish close
  V1: Volume climax reversal (vol > MA20×3 + bullish)
  V2: Selling exhaustion (vol spike + long lower wick + close near high)
  V3: Volume dry-up reversal (vol declining then spike + bullish)
  M1: 4h bottom approx (48-bar low touch + long wick)
  M2: 1h EMA50 bounce

Common filter: RANGE regime (1d) | EMA200 1h gate | skip h=16 UTC / Thu / Sun
Entry: next 5m bar open | SL: ATR(14)×2 | TP: ATR(14)×2 | Max hold: 24h | CD: 4h
"""
import json, datetime, collections

CACHE  = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FEE    = 0.05 / 100
MAX_H  = 288    # 24h in 5m bars
CD     = 48     # 4h cooldown
SL_M   = 2.0
TP_M   = 2.0

print("Loading data...")
raw    = json.load(open(CACHE))
bars5m = sorted(raw, key=lambda x: x['time'])
n5     = len(bars5m)
c5     = [b['close'] for b in bars5m]
print(f"5m: {n5:,} bars  {datetime.datetime.utcfromtimestamp(bars5m[0]['time']/1000):%Y-%m-%d} → {datetime.datetime.utcfromtimestamp(bars5m[-1]['time']/1000):%Y-%m-%d}")

# ── Build TF bars ─────────────────────────────────────────────────────────────
def load_tf(ms):
    b = {}
    for c in raw:
        k = c["time"]//ms; ts = k*ms
        if k not in b: b[k] = {"time":ts,"open":c["open"],"high":c["high"],"low":c["low"],"close":c["close"],"volume":c["volume"]}
        else:
            o=b[k]; o["high"]=max(o["high"],c["high"]); o["low"]=min(o["low"],c["low"]); o["close"]=c["close"]; o["volume"]+=c["volume"]
    return [b[k] for k in sorted(b)]

bars1h = load_tf(3600*1000); bars1d = load_tf(86400*1000)
h1t    = [b["time"] for b in bars1h]
print(f"1h: {len(bars1h)} | 1d: {len(bars1d)}")

# ── Indicators ────────────────────────────────────────────────────────────────
def ema_s(xs, p):
    k=2/(p+1); out=[None]*len(xs); e=None
    for i,x in enumerate(xs):
        if x is not None: e = x if e is None else x*k+e*(1-k)
        out[i]=e
    return out

e200_1h = ema_s([b["close"] for b in bars1h], 200)
e50_1h  = ema_s([b["close"] for b in bars1h], 50)

def lookup_1h(arr, ts):
    lo,hi,idx=0,len(h1t)-1,0
    while lo<=hi:
        m=(lo+hi)//2
        if h1t[m]<=ts: idx=m; lo=m+1
        else: hi=m-1
    return arr[idx]

def regime_build():
    cs=[b["close"] for b in bars1d]; nd=len(bars1d); rr=["RANGE"]*nd
    for i in range(200,nd):
        ma200=sum(cs[i-199:i+1])/200; ma50=sum(cs[i-50:i+1])/50
        ar=sum((b["high"]-b["low"])/b["close"] for b in bars1d[i-19:i+1])/20
        if cs[i]<ma200: rr[i]="BEAR"
        elif cs[i]>ma50 and ma50>ma200 and ar>0.04: rr[i]="BULL"
    out=["RANGE"]*nd; cur="RANGE"; cnt=0; lr="RANGE"
    for i in range(nd):
        r=rr[i]
        if r==lr: cnt+=1
        else: cnt=1; lr=r
        if cnt>=3: cur=r
        out[i]=cur
    return {bars1d[i]["time"]//86400000: out[i] for i in range(nd)}

print("Building regime..."); reg_map=regime_build()
def get_reg(ts): return reg_map.get(ts//86400000,"RANGE")

def atr_w(bars,p=14):
    n=len(bars); a=[None]*n; trs=[]
    for i in range(1,n):
        trs.append(max(bars[i]['high']-bars[i]['low'],abs(bars[i]['high']-bars[i-1]['close']),abs(bars[i]['low']-bars[i-1]['close'])))
    if len(trs)<p: return a
    s=sum(trs[:p])/p; a[p]=s
    for i in range(p+1,n): a[i]=(a[i-1]*(p-1)+trs[i-1])/p
    return a

print("ATR 5m..."); atr5=atr_w(bars5m,14)

def rsi_w(bars,p=14):
    n=len(bars); rsi=[None]*n; gains=[]; losses=[]
    for i in range(1,n):
        d=bars[i]['close']-bars[i-1]['close']; gains.append(max(d,0)); losses.append(max(-d,0))
    if len(gains)<p: return rsi
    ag=sum(gains[:p])/p; al=sum(losses[:p])/p
    rsi[p]=100-100/(1+ag/al) if al>0 else 100
    for i in range(p+1,n):
        g=gains[i-1]; l=losses[i-1]
        ag=(ag*(p-1)+g)/p; al=(al*(p-1)+l)/p
        rsi[i]=100-100/(1+ag/al) if al>0 else 100
    return rsi

print("RSI 5m..."); rsi5=rsi_w(bars5m,14)

def stoch_arr(bars,kp=14,dp=3):
    n=len(bars); k=[None]*n; d=[None]*n
    for i in range(kp-1,n):
        lows=[bars[j]['low'] for j in range(i-kp+1,i+1)]; highs=[bars[j]['high'] for j in range(i-kp+1,i+1)]
        ll=min(lows); hh=max(highs); rng=hh-ll
        k[i]=(bars[i]['close']-ll)/rng*100 if rng>0 else 50
    for i in range(kp+dp-2,n):
        vals=[k[j] for j in range(i-dp+1,i+1) if k[j] is not None]
        if len(vals)==dp: d[i]=sum(vals)/dp
    return k,d

print("Stochastic 5m..."); stoch_k5,_=stoch_arr(bars5m,14,3)

ema12_5=ema_s(c5,12); ema26_5=ema_s(c5,26)
macd_l=[a-b if a is not None and b is not None else None for a,b in zip(ema12_5,ema26_5)]
macd_sig=ema_s(macd_l,9)
macd_h=[a-b if a is not None and b is not None else None for a,b in zip(macd_l,macd_sig)]

def cci_arr(bars,p=20):
    n=len(bars); cci=[None]*n
    tps=[(b['high']+b['low']+b['close'])/3 for b in bars]
    for i in range(p-1,n):
        w=tps[i-p+1:i+1]; ma=sum(w)/p; md=sum(abs(x-ma) for x in w)/p
        cci[i]=(tps[i]-ma)/(0.015*md) if md>0 else 0
    return cci

print("CCI 5m..."); cci5=cci_arr(bars5m,20)

def willr_arr(bars,p=14):
    n=len(bars); wr=[None]*n
    for i in range(p-1,n):
        w=bars[i-p+1:i+1]; hh=max(b['high'] for b in w); ll=min(b['low'] for b in w); rng=hh-ll
        wr[i]=(hh-bars[i]['close'])/rng*-100 if rng>0 else -50
    return wr

print("Williams %R 5m..."); willr5=willr_arr(bars5m,14)

def sliding_min_low(bars,p):
    n=len(bars); dl=[None]*n; dq=collections.deque()
    for i,b in enumerate(bars):
        while dq and bars[dq[-1]]['low']>=b['low']: dq.pop()
        dq.append(i)
        while dq[0]<=i-p: dq.popleft()
        if i>=p-1: dl[i]=bars[dq[0]]['low']
    return dl

def vol_ma_arr(bars,p=20):
    n=len(bars); out=[None]*n; dq=collections.deque(); s=0.0
    for i,b in enumerate(bars):
        v=b['volume']; dq.append(v); s+=v
        if len(dq)>p: s-=dq.popleft()
        if len(dq)==p: out[i]=s/p
    return out

print("Donchian & Vol..."); don20=sliding_min_low(bars5m,20); don48=sliding_min_low(bars5m,48)
vol_ma20=vol_ma_arr(bars5m,20)

def utc_h(ts):  return datetime.datetime.utcfromtimestamp(ts/1000).hour
def utc_dw(ts): return datetime.datetime.utcfromtimestamp(ts/1000).weekday()

# ── Simulate ──────────────────────────────────────────────────────────────────
def sim(ei):
    ep=bars5m[ei]['open']; ae=atr5[ei]
    if ae is None or ae<=0: return None
    sl=ep-ae*SL_M; tp=ep+ae*TP_M
    for h in range(1,MAX_H+1):
        j=ei+h
        if j>=n5: break
        b=bars5m[j]
        if b['high']>=tp: return (tp-ep)/ep-2*FEE,h
        if b['low']<=sl:  return (sl-ep)/ep-2*FEE,h
    j=min(ei+MAX_H,n5-1)
    return (bars5m[j]['close']-ep)/ep-2*FEE,MAX_H

# ── Signal functions ──────────────────────────────────────────────────────────
def sig_C1(i):   # Hammer
    b=bars5m[i]; body=abs(b['close']-b['open']); lo_w=min(b['open'],b['close'])-b['low']; up_w=b['high']-max(b['open'],b['close']); tot=b['high']-b['low']
    return tot>0 and body>0 and lo_w>=2*body and up_w<=body*0.5

def sig_C2(i):   # Bullish Engulfing
    if i<1: return False
    c=bars5m[i]; p=bars5m[i-1]
    return c['close']>c['open'] and p['close']<p['open'] and c['open']<=p['close'] and c['close']>=p['open']

def sig_C3(i):   # Morning Star
    if i<2 or atr5[i] is None: return False
    ae=atr5[i]; b0=bars5m[i]; b1=bars5m[i-1]; b2=bars5m[i-2]
    body0=abs(b0['close']-b0['open']); body1=abs(b1['close']-b1['open']); body2=abs(b2['close']-b2['open'])
    mid2=(b2['open']+b2['close'])/2
    return (b2['close']<b2['open'] and body2>ae*0.3 and body1<ae*0.2 and
            b0['close']>b0['open'] and body0>ae*0.3 and b0['close']>mid2)

def sig_C4(i):   # Dragonfly Doji
    b=bars5m[i]; tot=b['high']-b['low']
    if tot==0: return False
    body=abs(b['close']-b['open']); lo_w=min(b['open'],b['close'])-b['low']; up_w=b['high']-max(b['open'],b['close'])
    return body/tot<0.1 and lo_w/tot>0.7 and up_w/tot<0.1

def sig_C5(i):   # Piercing Line
    if i<1: return False
    c=bars5m[i]; p=bars5m[i-1]
    if p['close']>=p['open']: return False
    mid=(p['open']+p['close'])/2
    return c['close']>c['open'] and c['open']<p['close'] and c['close']>mid and c['close']<p['open']

def sig_I1(i):   # Stochastic cross above 20
    if i<1 or stoch_k5[i] is None or stoch_k5[i-1] is None: return False
    return stoch_k5[i-1]<20 and stoch_k5[i]>=20

def sig_I2(i):   # RSI bullish divergence (simplified)
    if i<30 or rsi5[i] is None: return False
    LOOK=25
    window=[(c5[j],j) for j in range(i-LOOK,i-4) if c5[j] is not None]
    if len(window)<10: return False
    _,pl=min(window,key=lambda x:x[0])
    if rsi5[pl] is None: return False
    return c5[i]<=c5[pl]*1.02 and rsi5[i]>rsi5[pl]+3

def sig_I3(i):   # MACD bullish divergence (simplified)
    if i<40 or macd_h[i] is None: return False
    LOOK=25
    window=[(c5[j],j) for j in range(i-LOOK,i-4) if c5[j] is not None]
    if len(window)<10: return False
    _,pl=min(window,key=lambda x:x[0])
    if macd_h[pl] is None: return False
    return c5[i]<=c5[pl]*1.02 and macd_h[i]>macd_h[pl]

def sig_I4(i):   # CCI cross above -100
    if i<1 or cci5[i] is None or cci5[i-1] is None: return False
    return cci5[i-1]<-100 and cci5[i]>=-100

def sig_I5(i):   # Williams %R cross above -80
    if i<1 or willr5[i] is None or willr5[i-1] is None: return False
    return willr5[i-1]<-80 and willr5[i]>=-80

def sig_P1(i):   # Liquidity sweep
    if i<21 or don20[i-1] is None: return False
    b=bars5m[i]; prev_low20=don20[i-1]
    return b['low']<prev_low20 and b['close']>prev_low20

def sig_P2(i):   # False breakdown EMA200 1h (close>e1h from common filter, just check low)
    b=bars5m[i]; e1h=lookup_1h(e200_1h,b['time'])
    return e1h is not None and b['low']<e1h

def sig_P3(i):   # Higher low structure
    if i<42: return False
    lo20=min(bars5m[j]['low'] for j in range(i-20,i))
    lo40=min(bars5m[j]['low'] for j in range(i-42,i-22))
    b=bars5m[i]
    return lo20>lo40*1.002 and b['close']>b['open']

def sig_P4(i):   # Round $1000 level rejection
    b=bars5m[i]; rl=round(b['low']/1000)*1000
    if rl==0: return False
    return abs(b['low']-rl)/b['close']<0.003 and b['close']>rl and b['close']>b['open']

def sig_P5(i):   # Donchian 20-bar low touch + bullish
    if don20[i] is None: return False
    b=bars5m[i]
    return b['low']<=don20[i]*1.001 and b['close']>b['open']

def sig_V1(i):   # Volume climax reversal
    if vol_ma20[i] is None: return False
    b=bars5m[i]
    return b['volume']>vol_ma20[i]*3 and b['close']>b['open']

def sig_V2(i):   # Selling exhaustion
    if vol_ma20[i] is None: return False
    b=bars5m[i]; body=abs(b['close']-b['open']); lo_w=min(b['open'],b['close'])-b['low']; tot=b['high']-b['low']
    return tot>0 and b['volume']>vol_ma20[i]*2 and lo_w>body*2 and (b['high']-b['close'])/tot<0.3

def sig_V3(i):   # Volume dry-up reversal
    if i<6 or vol_ma20[i] is None: return False
    vols=[bars5m[j]['volume'] for j in range(i-5,i)]
    declining=all(vols[j]>=vols[j+1]*0.85 for j in range(4))
    b=bars5m[i]
    return declining and b['volume']>vols[-1]*1.5 and b['volume']>vol_ma20[i]*0.8 and b['close']>b['open']

def sig_M1(i):   # 4h bottom approx (48-bar low touch + long wick)
    if don48[i] is None or atr5[i] is None: return False
    b=bars5m[i]; lo_w=min(b['open'],b['close'])-b['low']
    return b['low']<=don48[i]*1.001 and atr5[i]>0 and lo_w>=atr5[i]*0.5

def sig_M2(i):   # 1h EMA50 bounce
    b=bars5m[i]; e50=lookup_1h(e50_1h,b['time'])
    if e50 is None: return False
    return abs(b['low']-e50)/e50<0.003 and b['close']>b['open'] and b['close']>e50

SIGS = {
    'C1-Hammer':     sig_C1, 'C2-Engulfing':   sig_C2, 'C3-MornStar':  sig_C3,
    'C4-DrgflyDoji': sig_C4, 'C5-Piercing':    sig_C5,
    'I1-Stoch>20':   sig_I1, 'I2-RSI_Div':     sig_I2, 'I3-MACD_Div':  sig_I3,
    'I4-CCI>-100':   sig_I4, 'I5-WillR>-80':   sig_I5,
    'P1-LiqSweep':   sig_P1, 'P2-FalseBreak':  sig_P2, 'P3-HigherLow': sig_P3,
    'P4-RoundLvl':   sig_P4, 'P5-Don20Low':    sig_P5,
    'V1-VolClimax':  sig_V1, 'V2-SellExhaust': sig_V2, 'V3-DryupRev':  sig_V3,
    'M1-4hBottom':   sig_M1, 'M2-EMA50_1h':    sig_M2,
}

# ── Main backtest loop ────────────────────────────────────────────────────────
print(f"\nRunning {len(SIGS)} patterns on {n5:,} bars (RANGE regime + EMA200_1h gate + no h16/Thu/Sun)...")
trades    = {p: [] for p in SIGS}
last_e    = {p: -CD-1 for p in SIGS}
pcount    = 0; WARM=600

for i in range(WARM, n5-MAX_H-2):
    ts=bars5m[i]['time']
    if get_reg(ts)!="RANGE": continue
    e1h=lookup_1h(e200_1h,ts)
    if e1h is None or bars5m[i]['close']<e1h: continue
    if utc_h(ts)==16: continue
    if utc_dw(ts) in (3,6): continue
    if i+1>=n5 or atr5[i+1] is None: continue
    pcount+=1
    for pname,sfn in SIGS.items():
        if i-last_e[pname]<CD: continue
        try:
            if not sfn(i): continue
        except Exception:
            continue
        r=sim(i+1)
        if r is None: continue
        pnl,h=r
        yr=datetime.datetime.utcfromtimestamp(ts/1000).year
        trades[pname].append({'ret':pnl,'h':h,'yr':yr,'ts':ts})
        last_e[pname]=i

print(f"Eligible bars (passed common filter): {pcount:,}")

# ── Stats ─────────────────────────────────────────────────────────────────────
def stats(tl):
    if not tl: return None
    rets=[t['ret'] for t in tl]; nn=len(rets)
    mean=sum(rets)/nn; sd=(sum((r-mean)**2 for r in rets)/nn)**0.5 or 1e-9
    ra=mean/sd; wr=sum(1 for r in rets if r>0)/nn*100; roi=sum(rets)*100
    wins=[r for r in rets if r>0]; loss=[r for r in rets if r<=0]
    rr=(sum(wins)/len(wins))/abs(sum(loss)/len(loss)) if wins and loss else float('nan')
    eq=0; pk=0; mdd=0
    for r in rets:
        eq+=r
        if eq>pk: pk=eq
        if pk-eq>mdd: mdd=pk-eq
    return dict(n=nn,ra=ra,wr=wr,roi=roi,rr=rr,dd=mdd*100,avg_h=sum(t['h'] for t in tl)/nn)

YEARS=[2019,2020,2021,2022,2023,2024,2025,2026]

# ── Summary table ─────────────────────────────────────────────────────────────
print("\n"+"="*105)
print(f"REVERSAL CATALOG — 7y  |  SL:ATR×{SL_M}  TP:ATR×{TP_M}  |  RANGE+EMA200_1h+no_h16/Thu/Sun  |  CD:4h")
print("="*105)
print(f"  {'Pattern':18s}  {'n':>5}  {'RA':>7}  {'WR':>5}  {'R:R':>5}  {'ROI%':>8}  {'DD%':>6}  {'AvgH':>5}  {'Flag':>6}")
print(f"  {'-'*90}")

winners=[]
for pname,tl in trades.items():
    m=stats(tl)
    if m is None:
        print(f"  {pname:18s}  {'—':>5}  no trades"); continue
    flag="✓ WIN" if m['ra']>0.1 else ("△" if m['ra']>0 else "✗")
    print(f"  {pname:18s}  {m['n']:>5}  {m['ra']:>+7.3f}  {m['wr']:>4.0f}%  {m['rr']:>5.2f}  {m['roi']:>+8.1f}%  {m['dd']:>5.1f}%  {m['avg_h']:>5.0f}  {flag}")
    if m['ra']>0.05: winners.append(pname)

# ── Per-year for RA>0 patterns ────────────────────────────────────────────────
if winners:
    print(f"\n"+"="*105)
    print(f"PER-YEAR — Patterns with RA > 0.05")
    print("="*105)
    for pname in winners:
        tl_all=trades[pname]
        m_all=stats(tl_all)
        print(f"\n  ── {pname}  (7y: RA={m_all['ra']:+.3f}, n={m_all['n']}, WR={m_all['wr']:.0f}%) ──")
        print(f"  {'Year':>6}  {'n':>4}  {'RA':>7}  {'WR':>5}  {'ROI%':>8}  {'OK'}")
        print(f"  {'-'*42}")
        pos=0; tot=0
        for yr in YEARS:
            tyr=[t for t in tl_all if t['yr']==yr]
            if not tyr: print(f"  {yr:>6}  {'0':>4}  {'—':>7}  {'—':>5}  {'—':>8}  (skip)"); continue
            m=stats(tyr); tot+=1; ok="✓" if m['roi']>0 else "✗"
            if m['roi']>0: pos+=1
            print(f"  {yr:>6}  {m['n']:>4}  {m['ra']:>+7.3f}  {m['wr']:>4.0f}%  {m['roi']:>+8.1f}%  {ok}")
        print(f"  Stability: {pos}/{tot}")
else:
    print(f"\n  ⚠️  No patterns with RA > 0.05 under these filters.")

print("\nDone.")
