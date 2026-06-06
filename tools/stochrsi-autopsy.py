#!/usr/bin/env python3
"""
stochrsi-autopsy.py
Phân tích từng lệnh StochRSI:
- Signal xảy ra ở bar nào?
- Giá thật đáy/đỉnh ở bar nào SAU signal? (delay thật)
- Context tại thời điểm signal: funding, volume, ATR, regime, EMA...
- WIN vs LOSS khác nhau ở chỗ nào?
"""
import json, datetime
from collections import defaultdict

CACHE   = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FUNDING = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/funding-rate-7y.json"
FEE=0.05/100; INITIAL=100_000; POS_PCT=0.10; SL_ATR=2.0; MAX_HOLD=48

print("Loading...")
raw = json.load(open(CACHE)); raw.sort(key=lambda x: x['time'])
fnd = json.load(open(FUNDING)); fnd.sort(key=lambda x: x['fundingTime'])

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

bars=build_tf(3600*1000)
c1h=[b['close'] for b in bars]; h1h=[b['high'] for b in bars]
l1h=[b['low'] for b in bars]; v1h=[b['volume'] for b in bars]
n=len(bars)

# ── Indicators ────────────────────────────────────────────────────────────────
def ema(src,p):
    out=[None]*len(src); k=2/(p+1); e=None
    for i,x in enumerate(src):
        e=x if e is None else x*k+e*(1-k); out[i]=e
    return out

def sma(src,p):
    out=[None]*len(src)
    for i in range(p-1,len(src)):
        w=[x for x in src[i-p+1:i+1] if x is not None]
        if len(w)==p: out[i]=sum(w)/p
    return out

def rsi(src,p=5):
    out=[None]*len(src); ag=al=0.0
    for i in range(1,p+1):
        d=src[i]-src[i-1]
        if d>0: ag+=d
        else: al-=d
    ag/=p; al/=p; out[p]=100-100/(1+ag/al) if al else 100
    for i in range(p+1,len(src)):
        d=src[i]-src[i-1]
        ag=(ag*(p-1)+max(d,0))/p; al=(al*(p-1)+max(-d,0))/p
        out[i]=100-100/(1+ag/al) if al else 100
    return out

def stoch(src,p):
    out=[None]*len(src)
    for i in range(p-1,len(src)):
        w=[x for x in src[i-p+1:i+1] if x is not None]
        if len(w)<p or src[i] is None: continue
        lo,hi=min(w),max(w)
        out[i]=(src[i]-lo)/(hi-lo)*100 if hi!=lo else 50
    return out

def atr_w(p=14):
    trs=[bars[0]['high']-bars[0]['low']]
    for i in range(1,n):
        trs.append(max(h1h[i]-l1h[i],abs(h1h[i]-c1h[i-1]),abs(l1h[i]-c1h[i-1])))
    out=[None]*n; avg=sum(trs[:p])/p; out[p-1]=avg
    for i in range(p,n):
        avg=(avg*(p-1)+trs[i])/p; out[i]=avg
    return out

def adx_build(p=14):
    trs=[h1h[0]-l1h[0]]; pdm=[0]; mdm=[0]
    for i in range(1,n):
        h,l=h1h[i],l1h[i]; ph,pl=h1h[i-1],l1h[i-1]
        trs.append(max(h-l,abs(h-c1h[i-1]),abs(l-c1h[i-1])))
        up=h-ph; dn=pl-l
        pdm.append(up if up>dn and up>0 else 0)
        mdm.append(dn if dn>up and dn>0 else 0)
    atr_s=sum(trs[:p]); pm_s=sum(pdm[:p]); mm_s=sum(mdm[:p])
    adx_out=[None]*n; pdi_out=[None]*n; mdi_out=[None]*n; adx_s=None
    for i in range(p,n):
        atr_s=atr_s-atr_s/p+trs[i]; pm_s=pm_s-pm_s/p+pdm[i]; mm_s=mm_s-mm_s/p+mdm[i]
        pd=100*pm_s/atr_s if atr_s else 0; md=100*mm_s/atr_s if atr_s else 0
        pdi_out[i]=pd; mdi_out[i]=md
        dx=100*abs(pd-md)/(pd+md) if (pd+md) else 0
        if i==p*2-1: adx_s=dx
        elif adx_s is not None: adx_s=(adx_s*(p-1)+dx)/p
        if adx_s is not None: adx_out[i]=adx_s
    return adx_out,pdi_out,mdi_out

print("Building indicators...")
rsi5=rsi(c1h,5); stch=stoch(rsi5,10); k_line=sma(stch,1)
atrv=atr_w(); adxv,pdiv,mdiv=adx_build()
e20=ema(c1h,20); e50=ema(c1h,50); e200=ema(c1h,200)
vol_sma=sma(v1h,20)

# Funding lookup
ft=[f['fundingTime'] for f in fnd]; fr=[float(f['fundingRate']) for f in fnd]
def get_fund(ts):
    lo,hi,idx=0,len(ft)-1,0
    while lo<=hi:
        m=(lo+hi)//2
        if ft[m]<=ts: idx=m; lo=m+1
        else: hi=m-1
    return fr[idx] if idx<len(fr) else 0

# 1d regime
bars1d=build_tf(86400*1000); c1d=[b['close'] for b in bars1d]; t1d=[b['time'] for b in bars1d]
regime1d=[]
for i in range(len(bars1d)):
    ma200=sum(c1d[max(0,i-199):i+1])/min(i+1,200)
    ma50=sum(c1d[max(0,i-49):i+1])/min(i+1,50)
    if c1d[i]<ma200: regime1d.append('BEAR')
    elif c1d[i]>ma50 and ma50>ma200: regime1d.append('BULL')
    else: regime1d.append('RANGE')
def get_regime(ts):
    lo,hi,idx=0,len(t1d)-1,0
    while lo<=hi:
        m=(lo+hi)//2
        if t1d[m]<=ts: idx=m; lo=m+1
        else: hi=m-1
    return regime1d[idx]

# ── Collect all signals + trade outcomes ──────────────────────────────────────
print("Collecting signals...")
trades=[]

for i in range(60, n-MAX_HOLD-1):
    b=bars[i]; ts=b['time']
    d=datetime.datetime.fromtimestamp(ts/1000,datetime.timezone.utc)
    if d.year<2019: continue

    kc=k_line[i]; kp=k_line[i-1]
    if kc is None or kp is None: continue

    signal_long  = kp<10 and kc>=10
    signal_short = kp>90 and kc<=90

    for sig,side in [(signal_long,'LONG'),(signal_short,'SHORT')]:
        if not sig: continue

        entry_px=c1h[i]; av=atrv[i]
        if av is None: continue

        sl = entry_px - av*SL_ATR if side=='LONG' else entry_px + av*SL_ATR

        # Find actual bottom/top after signal (within 48 bars)
        future_lows  = l1h[i:i+MAX_HOLD+1]
        future_highs = h1h[i:i+MAX_HOLD+1]
        future_close = c1h[i:i+MAX_HOLD+1]

        if side=='LONG':
            # Actual bottom: lowest low after signal
            actual_bottom = min(future_lows)
            bottom_bar    = future_lows.index(actual_bottom)
            # How far price went down before recovering
            max_adverse   = (entry_px - actual_bottom) / entry_px * 100
        else:
            actual_top  = max(future_highs)
            bottom_bar  = future_highs.index(actual_top)
            max_adverse = (actual_top - entry_px) / entry_px * 100

        # Simulate trade
        exit_bar=None; exit_px=None; reason=None
        for j in range(1, min(MAX_HOLD+1, n-i)):
            px=c1h[i+j]; low=l1h[i+j]; high=h1h[i+j]
            if side=='LONG':
                if low<=sl: exit_px=sl; exit_bar=j; reason='SL'; break
                if k_line[i+j] is not None and k_line[i+j]>=90:
                    exit_px=px; exit_bar=j; reason='EXIT_K'; break
            else:
                if high>=sl: exit_px=sl; exit_bar=j; reason='SL'; break
                if k_line[i+j] is not None and k_line[i+j]<=10:
                    exit_px=px; exit_bar=j; reason='EXIT_K'; break
        if exit_bar is None:
            exit_bar=MAX_HOLD; exit_px=c1h[i+MAX_HOLD]; reason='MAXHOLD'

        if side=='LONG':
            pnl=(exit_px/entry_px-1)*100
        else:
            pnl=(1-exit_px/entry_px)*100
        pnl -= FEE*2*100
        win = pnl>0

        # Context at signal bar
        fund = get_fund(ts)
        regime = get_regime(ts)
        adx_val = adxv[i] or 0
        pdi_val = pdiv[i] or 0
        mdi_val = mdiv[i] or 0
        atr_pct = av/entry_px*100
        vol_ratio = v1h[i]/vol_sma[i] if vol_sma[i] else 1
        ema200_dist = (entry_px-e200[i])/e200[i]*100 if e200[i] else 0
        ema50_dist  = (entry_px-e50[i])/e50[i]*100 if e50[i] else 0
        hour = d.hour
        dow  = d.weekday()

        trades.append({
            "year": d.year, "month": d.month, "hour": hour, "dow": dow,
            "side": side, "win": win, "pnl": pnl,
            "entry_px": entry_px, "exit_px": exit_px, "exit_bar": exit_bar,
            "reason": reason, "max_adverse_pct": max_adverse,
            "bottom_bar": bottom_bar,  # bars sau signal mới chạm đáy/đỉnh thật
            "fund": fund, "regime": regime,
            "adx": adx_val, "pdi": pdi_val, "mdi": mdi_val,
            "atr_pct": atr_pct, "vol_ratio": vol_ratio,
            "ema200_dist": ema200_dist, "ema50_dist": ema50_dist,
        })

print(f"Total signals: {len(trades)}")
longs =[t for t in trades if t['side']=='LONG']
shorts=[t for t in trades if t['side']=='SHORT']
wins  =[t for t in trades if t['win']]
losses=[t for t in trades if not t['win']]

print(f"LONG: {len(longs)}  SHORT: {len(shorts)}")
print(f"WIN: {len(wins)} ({len(wins)/len(trades)*100:.0f}%)  LOSS: {len(losses)}")

# ── KEY ANALYSIS: bottom_bar distribution ────────────────────────────────────
print("\n" + "="*60)
print("  ĐIỂM QUAY ĐẦU THẬT — bottom_bar sau signal (bar)")
print("="*60)

def avg(lst): return sum(lst)/len(lst) if lst else 0
def pct(lst, total): return len(lst)/total*100 if total else 0

# Per year - bottom bar delay
print("\nPer-year: avg bars đến đáy/đỉnh thật sau signal (LONG)")
yr_data=defaultdict(list)
for t in longs:
    yr_data[t['year']].append(t['bottom_bar'])

for yr in range(2019,2027):
    if yr not in yr_data: continue
    bb=yr_data[yr]
    print(f"  {yr}: avg={avg(bb):.1f}bars  median={sorted(bb)[len(bb)//2]:.0f}  "
          f"<=2bars={pct([x for x in bb if x<=2],len(bb)):.0f}%  "
          f"<=5bars={pct([x for x in bb if x<=5],len(bb)):.0f}%  "
          f"n={len(bb)}")

# ── WIN vs LOSS differences ────────────────────────────────────────────────────
print("\n" + "="*60)
print("  WIN vs LOSS — context analysis (LONG)")
print("="*60)

wl=[t for t in longs if t['win']]
ll=[t for t in longs if not t['win']]

def compare(key, label):
    wv=[t[key] for t in wl if t[key] is not None]
    lv=[t[key] for t in ll if t[key] is not None]
    print(f"  {label:<20} WIN={avg(wv):>+7.2f}  LOSS={avg(lv):>+7.2f}  diff={avg(wv)-avg(lv):>+7.2f}")

compare('bottom_bar',  'Delay đến đáy (bars)')
compare('max_adverse_pct', 'Max adverse %')
compare('adx',         'ADX')
compare('atr_pct',     'ATR% of price')
compare('vol_ratio',   'Volume ratio')
compare('fund',        'Funding rate')
compare('ema200_dist', 'EMA200 dist%')
compare('exit_bar',    'Exit bar')

print(f"\n  Regime (WIN): " + str({r: sum(1 for t in wl if t['regime']==r) for r in ['BULL','BEAR','RANGE']}))
print(f"  Regime (LOSS): " + str({r: sum(1 for t in ll if t['regime']==r) for r in ['BULL','BEAR','RANGE']}))

# ── Per-hour WR ───────────────────────────────────────────────────────────────
print("\n" + "="*60)
print("  WIN RATE theo GIỜ (UTC) — LONG signals")
print("="*60)
hr_w=defaultdict(int); hr_n=defaultdict(int)
for t in longs:
    hr_n[t['hour']]+=1
    if t['win']: hr_w[t['hour']]+=1
for h in range(24):
    if hr_n[h]<10: continue
    wr=hr_w[h]/hr_n[h]*100
    bar='█'*int(wr/5)
    print(f"  {h:02d}h: {wr:>4.0f}% {bar} n={hr_n[h]}")

# ── Funding rate buckets ───────────────────────────────────────────────────────
print("\n" + "="*60)
print("  WIN RATE theo FUNDING RATE — LONG signals")
print("="*60)
buckets=[(-999,-0.001,'< -0.1%'),(-0.001,-0.0003,'-0.1~-0.03%'),
         (-0.0003,0.0003,'-0.03~+0.03%'),(0.0003,0.001,'+0.03~+0.1%'),(0.001,999,'> +0.1%')]
for lo,hi,label in buckets:
    bt=[t for t in longs if lo<=t['fund']<hi]
    if not bt: continue
    wr=sum(1 for t in bt if t['win'])/len(bt)*100
    avg_pnl=avg([t['pnl'] for t in bt])
    print(f"  {label:<18} WR={wr:>4.0f}%  avgPnL={avg_pnl:>+5.2f}%  n={len(bt)}")

# ── ADX buckets ───────────────────────────────────────────────────────────────
print("\n" + "="*60)
print("  WIN RATE theo ADX — LONG signals")
print("="*60)
for lo,hi,label in [(0,15,'ADX<15'),(15,25,'ADX 15-25'),(25,35,'ADX 25-35'),(35,999,'ADX>35')]:
    bt=[t for t in longs if lo<=t['adx']<hi]
    if not bt: continue
    wr=sum(1 for t in bt if t['win'])/len(bt)*100
    avg_pnl=avg([t['pnl'] for t in bt])
    print(f"  {label:<18} WR={wr:>4.0f}%  avgPnL={avg_pnl:>+5.2f}%  n={len(bt)}")

# ── bottom_bar distribution overall ──────────────────────────────────────────
print("\n" + "="*60)
print("  DISTRIBUTION: bao nhiêu bars sau signal mới chạm đáy thật (LONG)")
print("="*60)
all_bb=[t['bottom_bar'] for t in longs]
for delay in [0,1,2,3,5,8,12,24,48]:
    pct_val=sum(1 for x in all_bb if x<=delay)/len(all_bb)*100
    print(f"  <=  {delay:2d} bars: {pct_val:>4.0f}% đã chạm đáy")

# ── Per-year bottom bar + WR + avg pnl ───────────────────────────────────────
print("\n" + "="*60)
print("  PER-YEAR SUMMARY — decay analysis")
print("="*60)
print(f"  {'Year'} {'WR':>5} {'avgPnL':>7} {'avgDelay':>9} {'avgAdverse':>11} {'n':>5}")
for yr in range(2019,2027):
    yt=[t for t in longs if t['year']==yr]
    if not yt: continue
    wr=sum(1 for t in yt if t['win'])/len(yt)*100
    ap=avg([t['pnl'] for t in yt])
    ad=avg([t['bottom_bar'] for t in yt])
    aa=avg([t['max_adverse_pct'] for t in yt])
    print(f"  {yr}  {wr:>4.0f}%  {ap:>+6.2f}%  {ad:>8.1f}bars  {aa:>10.2f}%  n={len(yt)}")
