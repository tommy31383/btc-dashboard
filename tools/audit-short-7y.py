#!/usr/bin/env python3
"""
audit-short-7y.py — Audit SHORT performance S12/S13/S14 trên 7y.

Câu hỏi: SHORT (S12/S13/S14) đang thắng hay thua net-of-cost?
Nếu thua → candidate disable SHORT, simplify bot, RA có thể tăng.

Engine sim sát live (4h, config v0.4.50):
  - S12: EMA50 cross dưới EMA200 (SHORT)
  - S13: close < prev_close - ATR×1.5 (SHORT)
  - S14: close < 20-bar low (Donchian SHORT)
  - Filters: ADX>20 sticky, EMA200 1h (SHORT: close < EMA200), ATR%ile 30th,
             vol MA10×1.2 (S13/S14), skip h=8 UTC, regime ≠ BULL, funding not block SHORT
  - SL: ATR×4 (48h) → ATR×3 trailing. No fixed TP.
  - Fee: 0.05%/side net-of-cost.
  - maxHold: 200 bar (800h = ~33 ngày).

So LONG vs SHORT side-by-side.
"""
import json, math, datetime
from collections import defaultdict

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FEE = 0.05/100
H4 = 4*3600*1000
MAX_HOLD = 200   # bars
SL_INIT_MULT = 4.0
SL_TRAIL_MULT = 3.0
SL_TRANS_BARS = 12  # 48h @ 4h bars
ATR_PERIOD = 14
ADX_PERIOD = 14
EMA_FAST = 50
EMA_SLOW = 200
ATR_BREAK_MULT = 1.5
DONCHIAN_LB = 20
VOL_MA = 10
VOL_MULT = 1.2
ATR_PCT_LB = 90
ATR_PCT_PCTL = 0.30

def load_tf(ms):
    raw = json.load(open(CACHE)); b = {}
    for c in raw:
        k = c["time"]//ms
        if k not in b: b[k] = {"time":k*ms,"open":c["open"],"high":c["high"],"low":c["low"],"close":c["close"],"volume":c["volume"]}
        else: o=b[k]; o["high"]=max(o["high"],c["high"]); o["low"]=min(o["low"],c["low"]); o["close"]=c["close"]; o["volume"]+=c["volume"]
    return [b[k] for k in sorted(b)]

def ema_series(xs, n):
    k=2/(n+1); out=[None]*len(xs); e=None
    for i,x in enumerate(xs):
        e = x if e is None else x*k+e*(1-k); out[i]=e
    return out

def atr_series(bars):
    tr=[0.0]*len(bars)
    for i in range(1,len(bars)):
        hl=bars[i]["high"]-bars[i]["low"]
        hc=abs(bars[i]["high"]-bars[i-1]["close"])
        lc=abs(bars[i]["low"]-bars[i-1]["close"])
        tr[i]=max(hl,hc,lc)
    atr=[None]*len(bars)
    for i in range(ATR_PERIOD,len(bars)):
        atr[i]=sum(tr[i-ATR_PERIOD+1:i+1])/ATR_PERIOD
    return atr

def adx_series(bars):
    n=len(bars); pdm=[0.0]*n; ndm=[0.0]*n; tr=[0.0]*n
    for i in range(1,n):
        up=bars[i]["high"]-bars[i-1]["high"]; dn=bars[i-1]["low"]-bars[i]["low"]
        pdm[i]=up if up>dn and up>0 else 0
        ndm[i]=dn if dn>up and dn>0 else 0
        hl=bars[i]["high"]-bars[i]["low"]; hc=abs(bars[i]["high"]-bars[i-1]["close"]); lc=abs(bars[i]["low"]-bars[i-1]["close"])
        tr[i]=max(hl,hc,lc)
    adx_out=[None]*n; p_di=[None]*n; m_di=[None]*n
    for i in range(28,n):
        atrv=sum(tr[i-ADX_PERIOD+1:i+1])/ADX_PERIOD
        if not atrv: continue
        pdi=100*sum(pdm[i-ADX_PERIOD+1:i+1])/ADX_PERIOD/atrv
        ndi=100*sum(ndm[i-ADX_PERIOD+1:i+1])/ADX_PERIOD/atrv
        p_di[i]=pdi; m_di[i]=ndi
        dx_vals=[]
        for j in range(i-ADX_PERIOD+1,i+1):
            a2=sum(tr[j-ADX_PERIOD+1:j+1])/ADX_PERIOD if j>=ADX_PERIOD else None
            if not a2: dx_vals.append(0); continue
            p2=100*sum(pdm[j-ADX_PERIOD+1:j+1])/ADX_PERIOD/a2
            n2=100*sum(ndm[j-ADX_PERIOD+1:j+1])/ADX_PERIOD/a2
            dx_vals.append(100*abs(p2-n2)/((p2+n2) or 1e-9))
        adx_out[i]=sum(dx_vals)/len(dx_vals)
    return adx_out, p_di, m_di

def regime_series(bars_1d):
    closes=[b["close"] for b in bars_1d]; n=len(bars_1d)
    regs=["RANGE"]*n
    for i in range(200,n):
        ma200=sum(closes[i-199:i+1])/200
        ma50=sum(closes[i-50:i+1])/50
        r20=bars_1d[i-19:i+1]; avgRange=sum((b["high"]-b["low"])/b["close"] for b in r20)/20
        if closes[i]<ma200: regs[i]="BEAR"
        elif closes[i]>ma50 and ma50>ma200 and avgRange>0.04: regs[i]="BULL"
        else: regs[i]="RANGE"
    return regs

def main():
    bars4h = load_tf(H4)
    bars1h = load_tf(3600*1000)
    bars1d = load_tf(86400*1000)
    closes4h = [b["close"] for b in bars4h]; n = len(bars4h)
    print(f"4h bars: {n}  {datetime.datetime.utcfromtimestamp(bars4h[0]['time']/1000):%Y-%m-%d} → {datetime.datetime.utcfromtimestamp(bars4h[-1]['time']/1000):%Y-%m-%d}")

    # Precompute indicators
    e50  = ema_series(closes4h, EMA_FAST)
    e200 = ema_series(closes4h, EMA_SLOW)
    atr4 = atr_series(bars4h)
    adx4, pdi4, mdi4 = adx_series(bars4h)
    e200_1h = ema_series([b["close"] for b in bars1h], 200)

    # Regime map: 4h bar time → regime (1d)
    reg_map = {}
    for i,b in enumerate(bars1d): reg_map[b["time"]//86400000] = None
    reg_list = regime_series(bars1d)
    for i,b in enumerate(bars1d): reg_map[b["time"]//86400000] = reg_list[i]
    def get_regime(ts): return reg_map.get(ts//86400000, "RANGE") or "RANGE"

    # ATR% series for percentile gate
    def atr_pct(i):
        if atr4[i] is None: return None
        return atr4[i]/closes4h[i]
    def atr_pct_pass(i):
        if i < ATR_PCT_LB: return False
        vals=[atr_pct(j) for j in range(i-ATR_PCT_LB,i) if atr_pct(j) is not None]
        if not vals: return False
        threshold = sorted(vals)[int(len(vals)*ATR_PCT_PCTL)]
        cur = atr_pct(i)
        return cur is not None and cur >= threshold

    # Vol filter (S13/S14)
    def vol_pass(i):
        if i < VOL_MA: return False
        vols=[bars4h[j]["volume"] for j in range(i-VOL_MA,i)]
        ma = sum(vols)/VOL_MA
        return bars4h[i]["volume"] >= ma * VOL_MULT

    # EMA200 1h: map 4h bar to nearest 1h bar
    h1_time = [b["time"] for b in bars1h]
    h1_close = [b["close"] for b in bars1h]
    def ema200_1h_at(ts):
        # find last 1h bar <= ts
        lo,hi=0,len(h1_time)-1; idx=0
        while lo<=hi:
            m=(lo+hi)//2
            if h1_time[m]<=ts: idx=m; lo=m+1
            else: hi=m-1
        return e200_1h[idx]

    # Signal detection
    def sig_s12(i):
        if None in (e50[i],e200[i],e50[i-1],e200[i-1]): return None
        if e50[i-1]>e200[i-1] and e50[i]<=e200[i]: return "SHORT"
        if e50[i-1]<=e200[i-1] and e50[i]>e200[i]: return "LONG"
        return None
    def sig_s13(i):
        if atr4[i] is None or i<1: return None
        if closes4h[i] > bars4h[i-1]["close"] + atr4[i]*ATR_BREAK_MULT: return "LONG"
        if closes4h[i] < bars4h[i-1]["close"] - atr4[i]*ATR_BREAK_MULT: return "SHORT"
        return None
    def sig_s14(i):
        if i<DONCHIAN_LB: return None
        hi20=max(bars4h[j]["high"] for j in range(i-DONCHIAN_LB,i))
        lo20=min(bars4h[j]["low"]  for j in range(i-DONCHIAN_LB,i))
        if closes4h[i]>hi20: return "LONG"
        if closes4h[i]<lo20: return "SHORT"
        return None

    def filters_pass(i, side):
        if adx4[i] is None or adx4[i]<=20: return False
        if i>=1 and (adx4[i-1] is None or adx4[i-1]<=20): return False  # sticky
        e1h = ema200_1h_at(bars4h[i]["time"])
        if e1h is None: return False
        if side=="LONG" and closes4h[i]<e1h: return False
        if side=="SHORT" and closes4h[i]>e1h: return False
        if not atr_pct_pass(i): return False
        # skip h=8
        if datetime.datetime.utcfromtimestamp(bars4h[i]["time"]/1000).hour == 8: return False
        reg = get_regime(bars4h[i]["time"])
        if side=="LONG" and reg=="BEAR": return False
        if side=="SHORT" and reg=="BULL": return False
        return True

    # Simulate one trade
    def sim_trade(entry_i, side):
        entry_px = closes4h[entry_i]
        atr_e = atr4[entry_i]
        if atr_e is None or atr_e<=0: return None
        sl = entry_px - atr_e*SL_INIT_MULT if side=="LONG" else entry_px + atr_e*SL_INIT_MULT
        hwm = entry_px if side=="LONG" else entry_px
        for h in range(1, MAX_HOLD+1):
            j = entry_i+h
            if j>=n: break
            mult = SL_INIT_MULT if h < SL_TRANS_BARS else SL_TRAIL_MULT
            if side=="LONG":
                if closes4h[j]>hwm:
                    hwm=closes4h[j]
                    sl=hwm-atr_e*mult
                elif h>=SL_TRANS_BARS:
                    target=hwm-atr_e*SL_TRAIL_MULT
                    if target>sl: sl=target
                if bars4h[j]["low"]<=sl:
                    ret = (sl-entry_px)/entry_px - 2*FEE
                    return ret, h, "SL"
            else:
                if closes4h[j]<hwm:
                    hwm=closes4h[j]
                    sl=hwm+atr_e*mult
                elif h>=SL_TRANS_BARS:
                    target=hwm+atr_e*SL_TRAIL_MULT
                    if target<sl: sl=target
                if bars4h[j]["high"]>=sl:
                    ret = (entry_px-sl)/entry_px - 2*FEE
                    return ret, h, "SL"
        # timeout
        j=min(entry_i+MAX_HOLD,n-1)
        if side=="LONG": ret=(closes4h[j]-entry_px)/entry_px-2*FEE
        else: ret=(entry_px-closes4h[j])/entry_px-2*FEE
        return ret, MAX_HOLD, "TIMEOUT"

    # Collect trades
    trades = {"S12":{"LONG":[],"SHORT":[]},"S13":{"LONG":[],"SHORT":[]},"S14":{"LONG":[],"SHORT":[]}}
    last_ts = {"S12":{"LONG":0,"SHORT":0},"S13":{"LONG":0,"SHORT":0},"S14":{"LONG":0,"SHORT":0}}
    CD = {"S12":12*3,"S13":4*1,"S14":12*3}  # in 4h bars

    for i in range(250, n-MAX_HOLD):
        ts=bars4h[i]["time"]
        for sname, sfn, do_vol in [("S12",sig_s12,False),("S13",sig_s13,True),("S14",sig_s14,True)]:
            sig = sfn(i)
            if sig is None: continue
            if i - last_ts[sname][sig] < CD[sname]: continue
            if do_vol and not vol_pass(i): continue
            if not filters_pass(i, sig): continue
            res = sim_trade(i, sig)
            if res is None: continue
            ret, h, reason = res
            yr = datetime.datetime.utcfromtimestamp(ts/1000).year
            trades[sname][sig].append({"ret":ret,"h":h,"reason":reason,"year":yr,"i":i})
            last_ts[sname][sig] = i

    # Report
    def stats(trds, label):
        if not trds:
            print(f"  {label:18s} n=   0 — NO TRADES"); return 0
        rets=[t["ret"] for t in trds]
        wins=sum(1 for r in rets if r>0); n_=len(rets)
        wr=wins/n_*100; mean=sum(rets)/n_
        sd=(sum((r-mean)**2 for r in rets)/n_)**0.5 or 1e-9
        ra=mean/sd
        awins=[r for r in rets if r>0]; alosses=[r for r in rets if r<0]
        rr=( sum(awins)/len(awins) if awins else 0) / abs(sum(alosses)/len(alosses) if alosses else 1e-9)
        total=sum(rets)*100
        by_yr=defaultdict(float)
        for t in trds: by_yr[t["year"]]+=t["ret"]
        pos_yrs=sum(1 for v in by_yr.values() if v>0)
        yr_str=" ".join(f"{y}:{by_yr[y]*100:+.0f}" for y in sorted(by_yr))
        print(f"  {label:18s} n={n_:4d} WR={wr:4.0f}% RA={ra:+.3f} R:R={rr:.2f} total={total:+6.1f}% stab={pos_yrs}/{len(by_yr)} | {yr_str}")
        return ra

    print("\n" + "="*90)
    print("AUDIT SHORT vs LONG — S12/S13/S14 trên 7y (net-of-cost 0.05%/side, SL ATR×4→×3)")
    print("="*90)
    for sname in ["S12","S13","S14"]:
        print(f"\n{sname}:")
        ra_l = stats(trades[sname]["LONG"],  "LONG ")
        ra_s = stats(trades[sname]["SHORT"], "SHORT")
        if trades[sname]["SHORT"]:
            verdict = "✅ KEEP SHORT" if ra_s > 0.05 else "❌ KILL SHORT"
            print(f"  → {verdict} (RA={ra_s:+.3f})")

    # Combined
    print("\n" + "="*90)
    print("COMBINED (tất cả setup):")
    all_long  = [t for s in trades.values() for t in s["LONG"]]
    all_short = [t for s in trades.values() for t in s["SHORT"]]
    stats(all_long,  "ALL LONG ")
    stats(all_short, "ALL SHORT")

    # Key insight
    print("\n" + "="*90)
    print("VERDICT:")
    total_short_pnl = sum(t["ret"] for s in trades.values() for t in s["SHORT"])
    if total_short_pnl < 0:
        print(f"  SHORT tổng PnL = {total_short_pnl*100:+.1f}% → ĐỀ XUẤT DISABLE SHORT hoàn toàn")
        print(f"  → Xem xét V040_ENABLE_SHORT = false cho tất cả S12/S13/S14")
    else:
        print(f"  SHORT tổng PnL = {total_short_pnl*100:+.1f}% → SHORT có edge, KEEP")

if __name__=="__main__":
    main()
