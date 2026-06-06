#!/usr/bin/env python3
"""
indicator-decay-test.py
Test từng indicator riêng lẻ trên 1h, LONG only, simple entry/exit
So sánh per-year ROI để xem indicator nào đang decay vs còn edge

Indicators:
  1. StochRSI(5,10,1) — baseline
  2. RSI(14) oversold cross
  3. Bollinger Bands lower touch
  4. MACD cross up
  5. EMA crossover (fast/slow)
  6. Volume spike + close up
  7. ATR breakout (momentum)
  8. Williams %R oversold
  9. CCI oversold
  10. Price vs EMA bounce
"""
import json, datetime
from collections import defaultdict

CACHE   = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FEE     = 0.05/100
INITIAL = 100_000
POS_PCT = 0.10
SL_ATR  = 1.5
MAX_HOLD = 24  # bars 1h

print("Loading...")
raw = json.load(open(CACHE)); raw.sort(key=lambda x: x['time'])

def build_tf(ms):
    b = {}
    for c in raw:
        k = c["time"]//ms
        if k not in b:
            b[k] = {"time":k*ms,"open":c["open"],"high":c["high"],
                    "low":c["low"],"close":c["close"],"volume":c.get("volume",0)}
        else:
            b[k]["high"]   = max(b[k]["high"], c["high"])
            b[k]["low"]    = min(b[k]["low"],  c["low"])
            b[k]["close"]  = c["close"]
            b[k]["volume"] += c.get("volume", 0)
    return [b[k] for k in sorted(b)]

bars = build_tf(3600*1000)
closes  = [b['close']  for b in bars]
highs   = [b['high']   for b in bars]
lows    = [b['low']    for b in bars]
volumes = [b['volume'] for b in bars]
n = len(bars)

def dt(b): return datetime.datetime.utcfromtimestamp(b['time']/1000)

# ── Indicator builders ────────────────────────────────────────────────────────
def ema(src, p):
    out=[None]*len(src); k=2/(p+1); e=None
    for i,x in enumerate(src):
        e = x if e is None else x*k+e*(1-k); out[i]=e
    return out

def sma(src, p):
    out=[None]*len(src)
    for i in range(p-1,len(src)):
        w=[x for x in src[i-p+1:i+1] if x is not None]
        if len(w)==p: out[i]=sum(w)/p
    return out

def rsi(src, p=14):
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

def stoch(src, p):
    out=[None]*len(src)
    for i in range(p-1,len(src)):
        w=[x for x in src[i-p+1:i+1] if x is not None]
        if len(w)<p or src[i] is None: continue
        lo,hi=min(w),max(w)
        out[i]=(src[i]-lo)/(hi-lo)*100 if hi!=lo else 50
    return out

def smth_sma(src, p):
    return sma(src, p)

def atr_ind(p=14):
    trs=[highs[0]-lows[0]]
    for i in range(1,n):
        trs.append(max(highs[i]-lows[i],abs(highs[i]-closes[i-1]),abs(lows[i]-closes[i-1])))
    out=[None]*n; avg=sum(trs[:p])/p; out[p-1]=avg
    for i in range(p,n):
        avg=(avg*(p-1)+trs[i])/p; out[i]=avg
    return out

def bollinger(p=20, k=2):
    mid=sma(closes,p)
    upper=[None]*n; lower=[None]*n
    for i in range(p-1,n):
        mu=mid[i]; std=(sum((closes[j]-mu)**2 for j in range(i-p+1,i+1))/p)**0.5
        upper[i]=mu+k*std; lower[i]=mu-k*std
    return mid, upper, lower

def williams_r(p=14):
    out=[None]*n
    for i in range(p-1,n):
        hi=max(highs[i-p+1:i+1]); lo=min(lows[i-p+1:i+1])
        out[i]=(hi-closes[i])/(hi-lo)*-100 if hi!=lo else -50
    return out

def cci(p=20):
    out=[None]*n
    for i in range(p-1,n):
        tp=[(highs[j]+lows[j]+closes[j])/3 for j in range(i-p+1,i+1)]
        mu=sum(tp)/p; mad=sum(abs(x-mu) for x in tp)/p
        out[i]=(tp[-1]-mu)/(0.015*mad) if mad else 0
    return out

atrv = atr_ind(14)

# ── Backtest runner ────────────────────────────────────────────────────────────
def backtest_signal(signal_fn, exit_fn=None, name=""):
    """
    signal_fn(i) -> True nếu LONG entry tại bar i
    exit_fn(i, pos) -> True nếu exit tại bar i (ngoài SL/maxhold)
    """
    eq=INITIAL; pos=None; cd=0
    yp=defaultdict(float); yn=defaultdict(int)
    for i in range(50, n):
        b=bars[i]; d=dt(b); px=closes[i]; av=atrv[i]
        if d.year<2019 or av is None: continue
        if pos:
            hit_sl = px<=pos['sl']
            hit_ex = exit_fn(i,pos) if exit_fn else False
            max_h  = (i-pos['bar'])>=MAX_HOLD
            if hit_sl or hit_ex or max_h:
                ep = pos['sl'] if hit_sl else px
                net=(ep/pos['ep']-1)*pos['n'] - pos['n']*FEE*2
                eq=max(eq+net,1); yp[d.year]+=net; yn[d.year]+=1; pos=None; cd=i+2
        if pos is None and i>cd:
            try:
                if signal_fn(i):
                    notional=eq*POS_PCT
                    pos={"ep":px,"sl":px-av*SL_ATR,"n":notional,"bar":i}
            except: pass
    # summary
    total_n=sum(yn.values())
    eq_cur=INITIAL
    yr_rois={}
    for yr in range(2019,2027):
        pl=yp.get(yr,0); roi=pl/eq_cur*100 if eq_cur>0 else 0
        yr_rois[yr]=roi; eq_cur+=pl
    cagr=(eq_cur/INITIAL)**(1/7)-1
    return cagr*100, yr_rois, total_n

# ── Build all indicators ──────────────────────────────────────────────────────
print("Building indicators...")

# 1. StochRSI
rsi5   = rsi(closes, 5)
stch10 = stoch(rsi5, 10)
srsi_k = smth_sma(stch10, 1)

# 2. RSI(14)
rsi14  = rsi(closes, 14)

# 3. Bollinger Bands
bb_mid, bb_up, bb_lo = bollinger(20, 2)

# 4. MACD
ema12  = ema(closes, 12); ema26 = ema(closes, 26)
macd   = [None if ema12[i] is None or ema26[i] is None else ema12[i]-ema26[i] for i in range(n)]
signal_macd = ema(macd, 9)

# 5. EMA crossover
ema9   = ema(closes, 9); ema21  = ema(closes, 21)

# 6. Volume SMA
vol_sma = sma(volumes, 20)

# 7. ATR breakout (close > prev high + ATR)
# 8. Williams %R
wpr    = williams_r(14)

# 9. CCI
cci20  = cci(20)

# 10. EMA200 bounce
ema200 = ema(closes, 200)
ema50  = ema(closes, 50)

print("Running backtests...\n")

results = []

# ── 1. StochRSI ───────────────────────────────────────────────────────────────
def sig_stochrsi(i):
    return srsi_k[i-1] is not None and srsi_k[i] is not None and srsi_k[i-1]<10 and srsi_k[i]>=10
def ex_stochrsi(i,pos):
    return srsi_k[i] is not None and srsi_k[i]>=90
cagr,yr,nt = backtest_signal(sig_stochrsi, ex_stochrsi, "StochRSI")
results.append(("StochRSI(5,10)", cagr, yr, nt))

# ── 2. RSI oversold ───────────────────────────────────────────────────────────
def sig_rsi(i):
    return rsi14[i-1] is not None and rsi14[i-1]<30 and rsi14[i]>=30
def ex_rsi(i,pos):
    return rsi14[i] is not None and rsi14[i]>=70
cagr,yr,nt = backtest_signal(sig_rsi, ex_rsi, "RSI")
results.append(("RSI(14) OS/OB", cagr, yr, nt))

# ── 3. Bollinger Band lower touch ─────────────────────────────────────────────
def sig_bb(i):
    return bb_lo[i] is not None and closes[i-1]>bb_lo[i-1] and closes[i]<=bb_lo[i]
def ex_bb(i,pos):
    return bb_mid[i] is not None and closes[i]>=bb_mid[i]
cagr,yr,nt = backtest_signal(sig_bb, ex_bb, "BB")
results.append(("BB Lower Touch", cagr, yr, nt))

# ── 4. MACD cross up ─────────────────────────────────────────────────────────
def sig_macd(i):
    if macd[i] is None or signal_macd[i] is None: return False
    return macd[i-1]<signal_macd[i-1] and macd[i]>=signal_macd[i] and macd[i]<0
def ex_macd(i,pos):
    if macd[i] is None or signal_macd[i] is None: return False
    return macd[i]<signal_macd[i]
cagr,yr,nt = backtest_signal(sig_macd, ex_macd, "MACD")
results.append(("MACD Cross Up", cagr, yr, nt))

# ── 5. EMA9 cross EMA21 ───────────────────────────────────────────────────────
def sig_ema(i):
    if ema9[i] is None or ema21[i] is None: return False
    return ema9[i-1]<ema21[i-1] and ema9[i]>=ema21[i]
def ex_ema(i,pos):
    if ema9[i] is None or ema21[i] is None: return False
    return ema9[i]<ema21[i]
cagr,yr,nt = backtest_signal(sig_ema, ex_ema, "EMA")
results.append(("EMA9xEMA21", cagr, yr, nt))

# ── 6. Volume spike + close green ────────────────────────────────────────────
def sig_vol(i):
    if vol_sma[i] is None: return False
    return (volumes[i] > vol_sma[i]*2.0 and
            closes[i] > closes[i-1] and
            closes[i] > (highs[i]+lows[i])/2)
cagr,yr,nt = backtest_signal(sig_vol, None, "Vol")
results.append(("Volume Spike", cagr, yr, nt))

# ── 7. ATR Momentum breakout ─────────────────────────────────────────────────
def sig_atr_break(i):
    if atrv[i] is None: return False
    return closes[i] > highs[i-1] + atrv[i]*0.5
cagr,yr,nt = backtest_signal(sig_atr_break, None, "ATR")
results.append(("ATR Breakout", cagr, yr, nt))

# ── 8. Williams %R oversold ───────────────────────────────────────────────────
def sig_wpr(i):
    return wpr[i-1] is not None and wpr[i-1]<-80 and wpr[i]>=-80
def ex_wpr(i,pos):
    return wpr[i] is not None and wpr[i]>=-20
cagr,yr,nt = backtest_signal(sig_wpr, ex_wpr, "WPR")
results.append(("Williams %R", cagr, yr, nt))

# ── 9. CCI oversold ──────────────────────────────────────────────────────────
def sig_cci(i):
    return cci20[i-1] is not None and cci20[i-1]<-100 and cci20[i]>=-100
def ex_cci(i,pos):
    return cci20[i] is not None and cci20[i]>=100
cagr,yr,nt = backtest_signal(sig_cci, ex_cci, "CCI")
results.append(("CCI OS/OB", cagr, yr, nt))

# ── 10. EMA200 bounce ────────────────────────────────────────────────────────
def sig_ema200(i):
    if ema200[i] is None or ema50[i] is None: return False
    # price dips to within 1% of EMA200 then bounces
    near = abs(closes[i]-ema200[i])/ema200[i] < 0.01
    bounce = closes[i]>closes[i-1]
    above50 = closes[i]>ema50[i]
    return near and bounce and above50
cagr,yr,nt = backtest_signal(sig_ema200, None, "EMA200")
results.append(("EMA200 Bounce", cagr, yr, nt))

# ── Print table ───────────────────────────────────────────────────────────────
years = list(range(2019,2027))
header = f"{'Indicator':<18} {'CAGR':>6} {'n':>5} | " + " | ".join(f"{y}" for y in years) + " | TREND"
print(header)
print("-"*120)

for name,cagr,yr,nt in results:
    rois = [yr.get(y,0) for y in years]
    # trend: compare avg 2019-2021 vs avg 2023-2026
    early = sum(yr.get(y,0) for y in [2019,2020,2021])/3
    late  = sum(yr.get(y,0) for y in [2023,2024,2025,2026])/4
    trend = "DECAY 📉" if late < early*0.5 else ("STABLE ➡" if late >= early*0.8 else "FADE ⚠")
    roi_str = " | ".join(f"{r:>+5.1f}%" for r in rois)
    print(f"{name:<18} {cagr:>+5.1f}% {nt:>5} | {roi_str} | {trend}")
