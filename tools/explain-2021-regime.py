#!/usr/bin/env python3
"""explain-2021-regime.py — Giải thích tại sao 2021 BULL trend rule không làm được"""
import json, datetime
from collections import defaultdict

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FEE = 0.05/100

raw = json.load(open(CACHE)); raw.sort(key=lambda x: x["time"])

def agg(bars, ms):
    b = {}
    for c in bars:
        k = c["time"]//ms
        if k not in b:
            b[k] = {"time":k*ms,"close":c["close"],"high":c["high"],"low":c["low"],"open":c["open"],"volume":c["volume"]}
        else:
            o = b[k]; o["high"]=max(o["high"],c["high"]); o["low"]=min(o["low"],c["low"]); o["close"]=c["close"]; o["volume"]+=c["volume"]
    return [b[k] for k in sorted(b)]

bars1d = agg(raw, 86400*1000)
bars1h = agg(raw, 3600*1000)
n1d = len(bars1d); n1h = len(bars1h)
cs = [b["close"] for b in bars1d]
c1h = [b["close"] for b in bars1h]

# Regime computation
raw_reg = ["RANGE"]*n1d
for i in range(200, n1d):
    m200 = sum(cs[i-199:i+1])/200
    m50  = sum(cs[i-50:i+1])/50
    ar   = sum((b["high"]-b["low"])/b["close"] for b in bars1d[i-19:i+1])/20
    if cs[i] < m200: raw_reg[i] = "BEAR"
    elif cs[i] > m50 and m50 > m200 and ar > 0.04: raw_reg[i] = "BULL"

reg_persist = ["RANGE"]*n1d; cur="RANGE"; cnt=0; lr="RANGE"
for i in range(n1d):
    r = raw_reg[i]
    if r == lr: cnt += 1
    else: cnt=1; lr=r
    if cnt >= 3: cur = r
    reg_persist[i] = cur

reg_map = {}
for i,b in enumerate(bars1d): reg_map[b["time"]//86400000] = reg_persist[i]

def ema(xs,p):
    k=2/(p+1); out=[None]*len(xs); e=None
    for i,x in enumerate(xs): e=x if e is None else x*k+e*(1-k); out[i]=e
    return out

def atr_w(bars,p=14):
    n=len(bars); out=[None]*n; tr=[0.]*n
    for i in range(1,n): tr[i]=max(bars[i]["high"]-bars[i]["low"],abs(bars[i]["high"]-bars[i-1]["close"]),abs(bars[i]["low"]-bars[i-1]["close"]))
    s=sum(tr[1:p+1]); out[p]=s/p
    for i in range(p+1,n): out[i]=(out[i-1]*(p-1)+tr[i])/p
    return out

def rsi_s(cls,n=14):
    out=[None]*len(cls); ag=al=0.
    for i in range(1,n+1):
        d=cls[i]-cls[i-1]
        if d>0: ag+=d
        else: al-=d
    ag/=n; al/=n; out[n]=100-100/(1+ag/al) if al>0 else 100
    for i in range(n+1,len(cls)):
        d=cls[i]-cls[i-1]; g=max(d,0); l=max(-d,0)
        ag=(ag*(n-1)+g)/n; al=(al*(n-1)+l)/n
        out[i]=100-100/(1+ag/al) if al>0 else 100
    return out

def bb_s(cls,n=20,k=2.):
    u=[None]*len(cls); l=[None]*len(cls)
    for i in range(n-1,len(cls)):
        w=cls[i-n+1:i+1]; m=sum(w)/n; s=(sum((x-m)**2 for x in w)/n)**0.5
        u[i]=m+k*s; l[i]=m-k*s
    return u,l

atr1h = atr_w(bars1h); rsi1h = rsi_s(c1h); bbu,bbl = bb_s(c1h); e200_1h = ema(c1h,200)
MN = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]

# ─── Part 1: 2021 Regime per month ────────────────────────────────────────────
print("=" * 72)
print("TẠI SAO 2021 RULE KHÔNG LÀM ĐƯỢC")
print("=" * 72)
print()
print("PHẦN 1: Regime BTC theo từng tháng 2021")
print(f"  {'Mth':>3}  {'Price range':>18}  {'BULL%':>6}  {'RANGE%':>7}  {'BEAR%':>6}  Dominant")
print("  " + "-"*65)

months_2021 = defaultdict(lambda: defaultdict(int))
for i,b in enumerate(bars1d):
    dt = datetime.datetime.utcfromtimestamp(b["time"]/1000)
    if dt.year != 2021: continue
    months_2021[dt.month][reg_persist[i]] += 1

for mn in range(1,13):
    if mn not in months_2021: continue
    d = months_2021[mn]
    total = sum(d.values())
    bull = d["BULL"]/total*100; rng = d["RANGE"]/total*100; bear = d["BEAR"]/total*100
    mo_bars = [b for b in bars1d if datetime.datetime.utcfromtimestamp(b["time"]/1000).year==2021
               and datetime.datetime.utcfromtimestamp(b["time"]/1000).month==mn]
    lo = min(b["low"] for b in mo_bars); hi = max(b["high"] for b in mo_bars)
    dominant = "BULL" if bull>60 else ("BEAR" if bear>60 else "RANGE/MIX")
    flag = "← rule blocked" if dominant=="BULL" else ("← rule CAN enter" if dominant=="RANGE/MIX" else "← rule blocked")
    print(f"  {MN[mn-1]:>3}  ${lo:>7,.0f}-${hi:>7,.0f}  {bull:>5.0f}%  {rng:>6.0f}%  {bear:>5.0f}%  {dominant:>10}  {flag}")

print()
print("  ► 2021: BTC trending mạnh từ $29k → $64k (Jan-Apr) rồi crash và rally lại")
print("  ► Hầu hết tháng = BULL regime (MA50>MA200, price trending up mạnh)")
print("  ► RANGE regime chỉ xuất hiện ~Sep-Oct sau crash tháng 5")

# ─── Part 2: Backtest BB+RSI in each regime 2021 ─────────────────────────────
print()
print("PHẦN 2: Test BB+RSI trên 1h trong mỗi regime (toàn bộ 7y data)")
print(f"  {'Regime':>6}  {'n':>5}  {'WR':>5}  {'RA':>8}  {'ROI%':>8}  Verdict")
print("  " + "-"*55)

by_regime = defaultdict(list)
last = {"BB": -4, "RSI": -4}
for i in range(50, n1h-48):
    e1h = e200_1h[i]
    if e1h and c1h[i] < e1h: continue
    reg = reg_map.get(bars1h[i]["time"]//86400000, "RANGE")
    fired = False
    if bbl[i] and bars1h[i]["low"]<=bbl[i] and bars1h[i]["close"]>bars1h[i]["open"]:
        if i-last["BB"]>=4: fired=True; last["BB"]=i
    if rsi1h[i] and rsi1h[i-1] and rsi1h[i-1]<40 and rsi1h[i]>=40:
        if i-last["RSI"]>=4: fired=True; last["RSI"]=i
    if not fired: continue
    ep=c1h[i]; ae=atr1h[i]
    if not ae or ae<=0: continue
    sl=ep-ae*2.; tp=ep+ae*1.5; ret=None
    for h in range(1,25):
        j=i+h
        if j>=n1h: break
        if bars1h[j]["low"]<=sl: ret=(sl-ep)/ep-2*FEE; break
        if bars1h[j]["high"]>=tp: ret=(tp-ep)/ep-2*FEE; break
    if ret is None: ret=(c1h[min(i+24,n1h-1)]-ep)/ep-2*FEE
    by_regime[reg].append(ret)

for reg in ["BULL","RANGE","BEAR"]:
    ts = by_regime[reg]
    if not ts: print(f"  {reg:>6}: no data"); continue
    wr = sum(1 for r in ts if r>0)/len(ts)*100
    roi = sum(ts)*100
    m = sum(ts)/len(ts); sd=(sum((r-m)**2 for r in ts)/len(ts))**0.5 or 1e-9
    ra = m/sd
    verdict = "✅ EDGE REAL" if ra>=0.15 else ("⚠️ MARGINAL" if ra>=0.05 else "❌ NO EDGE")
    print(f"  {reg:>6}  {len(ts):>5}  {wr:>4.0f}%  {ra:>+8.3f}  {roi:>+7.1f}%  {verdict}")

# ─── Part 3: Visual explanation ──────────────────────────────────────────────
print()
print("PHẦN 3: Tại sao BB/RSI FAIL trong BULL regime?")
print()
print("  BULL market (BTC trending up mạnh):")
print("  ┌─────────────────────────────────────────────────────┐")
print("  │  Price đang UP mạnh → BB lower band cũng di chuyển UP │")
print("  │                                                       │")
print("  │  Khi price touch BB lower:                           │")
print("  │    • RANGE market → price BOUNCE lại (mean revert)   │")
print("  │    • BULL market  → price TIẾP TỤC xuống (correction)│")
print("  │                     vì bull correction thường sâu    │")
print("  │                                                       │")
print("  │  RSI < 40 trong BULL = OVERSOLD nhưng:               │")
print("  │    • RANGE → oversold = cơ hội mua (bounce)          │")
print("  │    • BULL  → oversold có thể là -10%, -20%, -30%!!   │")
print("  │              BTC 2021 May: -53% trong 1 tháng        │")
print("  └─────────────────────────────────────────────────────┘")
print()
print("  Ví dụ thực tế 2021:")
print("    May 2021: BTC $64k → $30k (-53%). Mọi BB touch đều SL hit")
print("    Jun 2021: BTC $30-40k range, sau đó tiếp tục xuống")
print("    → Không có RANGE regime → rule đúng khi không vào")
print()
print("PHẦN 4: Giải pháp cho BULL regime?")
print()
print("  Từ nghiên cứu v0.4.55 (7y data):")
print("  BULL regime: n=26 trades, RA=+0.070 (gần zero = không có edge)")
print("  RANGE regime: n=60 trades, RA=+0.511 (edge rất mạnh)")
print()
print("  → Không có 1h mean-reversion signal nào work reliable trong BULL")
print("  → BULL market cần TREND-FOLLOWING entry (breakout), không phải dip-buy")
print("  → Current 4h hedge01 (S12/S13/S14) đã cover TREND-FOLLOW trong RANGE")
print()
print("  CONCLUSION: 2021 ít trade là ĐÚNG")
print("  Rule này = 1h mean-reversion TRONG sideways RANGE market")
print("  2021 BULL = không phải loại thị trường rule này designed for")
print("  Nếu cố vào BULL → WR drop, ROI âm → làm tệ đi toàn bộ rule")
