#!/usr/bin/env python3
"""
HONEST AUDIT of hedge04s (BB-only SHORT in BEAR) — the rule Grok armed LIVE.

Checks vs Grok's backtest-hedge04-short-bear-2026.py:
  FIX-1 regime lookahead: use PRIOR completed daily bar (Grok used same-day close).
  FIX-2 4h ADX lookahead: use last CLOSED 4h bar (Grok used forming 4h bar).
  FIX-3 slippage: add per-side slippage on top of fee (Grok modeled fee only).
  GATE-A drop-top-20%: remove top 20% winners → does 7y flip negative? (fat-tail test)
  GATE-B cross-asset: BTC / ETH / SOL (mirage if BTC-only).
Judge DOLLARS + per-year stability.
"""
import json, datetime, sys
from collections import defaultdict

CACHES = {
    "BTC": "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json",
    "ETH": "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-eth-5m-7y.json",
    "SOL": "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-sol-5m-3y.json",
}
FEE = 0.05 / 100
CAP = 100_000
Y0 = datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc).timestamp() * 1000

def build_tf(raw, ms):
    b = {}
    for c in raw:
        k = c["time"] // ms
        if k not in b:
            b[k] = {"time": k * ms, "open": c["open"], "high": c["high"],
                    "low": c["low"], "close": c["close"]}
        else:
            o = b[k]; o["high"] = max(o["high"], c["high"]); o["low"] = min(o["low"], c["low"]); o["close"] = c["close"]
    return [b[k] for k in sorted(b)]

def ema(src, p):
    out=[None]*len(src); k=2/(p+1); e=None
    for i,x in enumerate(src):
        e=x if e is None else x*k+e*(1-k); out[i]=e
    return out

def sma(src,p):
    out=[None]*len(src)
    for i in range(p-1,len(src)): out[i]=sum(src[i-p+1:i+1])/p
    return out

def atr_bars(bars,p=14):
    out=[None]*len(bars); trs=[]
    for i,b in enumerate(bars):
        tr=b["high"]-b["low"] if i==0 else max(b["high"]-b["low"],abs(b["high"]-bars[i-1]["close"]),abs(b["low"]-bars[i-1]["close"]))
        trs.append(tr)
        if i>=p-1:
            out[i]=sum(trs[:p])/p if i==p-1 else (out[i-1]*(p-1)+tr)/p
    return out

def adx_wilder(bars,p=14):
    n=len(bars); out=[None]*n
    if n<p*2+2: return out
    pdm=[0.0]*n; ndm=[0.0]*n; tr=[0.0]*n
    for i in range(1,n):
        up=bars[i]["high"]-bars[i-1]["high"]; dn=bars[i-1]["low"]-bars[i]["low"]
        pdm[i]=up if up>dn and up>0 else 0; ndm[i]=dn if dn>up and dn>0 else 0
        tr[i]=max(bars[i]["high"]-bars[i]["low"],abs(bars[i]["high"]-bars[i-1]["close"]),abs(bars[i]["low"]-bars[i-1]["close"]))
    sm_tr=sum(tr[1:p+1]); sm_p=sum(pdm[1:p+1]); sm_n=sum(ndm[1:p+1]); adx=None; dxs=[]
    for i in range(p+1,n):
        sm_tr=sm_tr-sm_tr/p+tr[i]; sm_p=sm_p-sm_p/p+pdm[i]; sm_n=sm_n-sm_n/p+ndm[i]
        pdi=sm_p/sm_tr*100 if sm_tr else 0; ndi=sm_n/sm_tr*100 if sm_tr else 0
        dx=abs(pdi-ndi)/(pdi+ndi)*100 if (pdi+ndi) else 0; dxs.append(dx)
        if len(dxs)<p: continue
        adx=sum(dxs)/p if adx is None else (adx*(p-1)+dx)/p
        out[i]=adx
    return out

def regime_prior_day(bars1d, persist_n=1):
    """BEAR if close<ma200. persistBars. Returns map day->regime, then read PRIOR day (no same-day lookahead)."""
    cs=[b["close"] for b in bars1d]; n=len(bars1d); raw=["RANGE"]*n
    for i in range(200,n):
        ma200=sum(cs[i-199:i+1])/200; ma50=sum(cs[i-50:i+1])/50
        ar=sum((b["high"]-b["low"])/b["close"] for b in bars1d[i-19:i+1])/20
        if cs[i]<ma200: raw[i]="BEAR"
        elif cs[i]>ma50 and ma50>ma200 and ar>0.04: raw[i]="BULL"
    out=["RANGE"]*n; cur="RANGE"; cnt=0; last="RANGE"
    for i in range(n):
        r=raw[i]
        if r==last: cnt+=1
        else: cnt=1; last=r
        if cnt>=persist_n: cur=r
        out[i]=cur
    return {bars1d[i]["time"]//86_400_000: out[i] for i in range(n)}

def yr(ts): return datetime.datetime.utcfromtimestamp(ts/1000).year

def run(asset, raw, fix_lookahead=True, slip_per_side=0.0):
    raw.sort(key=lambda x:x["time"])
    bars1h=build_tf(raw,3_600_000); bars4h=build_tf(raw,14_400_000); bars1d=build_tf(raw,86_400_000)
    c1=[b["close"] for b in bars1h]; h1t=[b["time"] for b in bars1h]
    atr1=atr_bars(bars1h,14); adx4h=adx_wilder(bars4h,14); e200=ema(c1,200); ma20=sma(c1,20)
    sd20=[None]*len(c1)
    for i in range(19,len(c1)):
        w=c1[i-19:i+1]; m=sum(w)/20; sd20[i]=(sum((x-m)**2 for x in w)/20)**0.5
    reg=regime_prior_day(bars1d,1)
    def get_reg(ts):
        day=ts//86_400_000
        return reg.get(day-1 if fix_lookahead else day,"RANGE")  # FIX-1: prior completed day
    # 4h index
    t4=[b["time"] for b in bars4h]
    def j4_at(ts):
        # FIX-2: last CLOSED 4h bar (bar.time + 4h <= ts); else forming bar
        lo,hi,idx=0,len(t4)-1,0
        while lo<=hi:
            m=(lo+hi)//2
            cond=(t4[m]+14_400_000<=ts) if fix_lookahead else (t4[m]<=ts)
            if cond: idx=m; lo=m+1
            else: hi=m-1
        return idx
    trades=[]; last_cd=0
    for i in range(220,len(bars1h)-30):
        ts=bars1h[i]["time"]
        if get_reg(ts)!="BEAR": continue
        j=j4_at(ts); adx=adx4h[j]; adxp=adx4h[j-1] if j else None
        if adx is None or adx<=20 or adxp is None or adxp<=20: continue
        if e200[i] is None or c1[i]>e200[i]: continue
        ae=atr1[i]
        if ae is None or ae<=0: continue
        if not (ma20[i] and sd20[i]): continue
        bb_hi=ma20[i]+2*sd20[i]; b=bars1h[i]
        if not (b["high"]>=bb_hi and b["close"]<b["open"] and ts-last_cd>=2*3600_000): continue
        last_cd=ts
        ep=c1[i]; sl=ep+ae*2.0; tp=ep-ae*1.5
        cost=2*FEE+2*slip_per_side  # entry+exit fee + slippage
        ret=None
        for h in range(1,25):
            k=i+h
            if k>=len(bars1h): break
            if bars1h[k]["high"]>=sl: ret=(ep-sl)/ep-cost; break
            if bars1h[k]["low"]<=tp: ret=(ep-tp)/ep-cost; break
        if ret is None:
            k=min(i+24,len(bars1h)-1); ret=(ep-c1[k])/ep-cost
        trades.append({"ts":ts,"ret":ret,"yr":yr(ts)})
    return trades

def stats(trades):
    by=defaultdict(float)
    for t in trades: by[t["yr"]]+=t["ret"]*CAP
    pos=sum(1 for v in by.values() if v>0)
    tot=sum(t["ret"] for t in trades)*CAP
    n2026=sum(1 for t in trades if t["ts"]>=Y0)
    p2026=sum(t["ret"] for t in trades if t["ts"]>=Y0)*CAP
    wr2026=(sum(1 for t in trades if t["ts"]>=Y0 and t["ret"]>0)/n2026*100) if n2026 else 0
    return dict(n=len(trades),tot=round(tot),stab=f"{pos}/{len(by)}",by={k:round(v) for k,v in sorted(by.items())},
                n2026=n2026,p2026=round(p2026),wr2026=round(wr2026,1))

def drop_top(trades, pct=0.20):
    s=sorted(trades,key=lambda t:t["ret"],reverse=True)
    cut=int(len(s)*pct)
    return s[cut:]

print("="*78)
print("HONEST AUDIT — hedge04s BB-only SHORT in BEAR")
print("="*78)
data={a:json.load(open(p)) for a,p in CACHES.items()}

# 1) reproduce Grok (no fix, fee-only) vs faithful (lookahead fixed) on BTC
g=run("BTC",[dict(x) for x in data["BTC"]],fix_lookahead=False,slip_per_side=0.0)
f0=run("BTC",[dict(x) for x in data["BTC"]],fix_lookahead=True,slip_per_side=0.0)
f1=run("BTC",[dict(x) for x in data["BTC"]],fix_lookahead=True,slip_per_side=0.03/100)
print("\n[BTC] Grok-repro (lookahead, fee-only):    ", stats(g))
print("[BTC] FAITHFUL (lookahead FIXED, fee-only):", stats(f0))
print("[BTC] FAITHFUL + slippage 0.03%/side:      ", stats(f1))

# 2) drop-top-20% on faithful BTC (fat-tail mirage test)
dt=drop_top(f1,0.20)
print("\n[BTC] GATE-A drop-top-20% (faithful+slip): ", stats(dt))

# 3) cross-asset (faithful + slippage)
print("\n[GATE-B cross-asset] faithful + slippage 0.03%/side:")
for a in ("BTC","ETH","SOL"):
    tr=run(a,[dict(x) for x in data[a]],fix_lookahead=True,slip_per_side=0.03/100)
    st=stats(tr); dtt=stats(drop_top(tr,0.20))
    print(f"  {a}: 7y ${st['tot']:>+8} stab {st['stab']:>4} n={st['n']:>4} | 2026 ${st['p2026']:>+7} WR {st['wr2026']:>4}% n{st['n2026']:>3} | drop20 ${dtt['tot']:>+8}")
print("\nby-year faithful BTC+slip:", stats(f1)["by"])
