#!/usr/bin/env python3
"""
timeadd-champion-faithful-backtest.py — FAITHFUL backtest variant "time-add (E)"
execution áp lên ENTRY của CHAMPION (BTC4h dip-buy ADX trend), so:
    A baseline  = full-entry (vào trọn Nf 1 lần)
    B probe-react = vào 1/3, add 2/3 khi giá confirm K×ATR trong W nến (nếu chưa confirm tới W → exit)
    E time-add   = vào 1/3, add 2/3 sau X nến nếu CHƯA chạm SL (bất kể thuận/nghịch)

KHÔNG đổi entry SIGNAL. Chỉ đổi cách VÀO. SL/TP/exit-EMA20/hold = giống hệt champion.
Sizing = exposure-fraction compounding trên $100k mô phỏng (judge %ROI + DOLLARS, scale-free).
Matched-DD: bơm exposure variant tới khi MaxDD ≈ MaxDD baseline → so $ công bằng
            (rule cứng Tommy: judge DOLLARS khi sizing thay đổi).

CHAMPION BTC4h config (từ dist/engine/champion.js, verified):
   adx>18, pdi>mdi*0.9, slAtr=1.6, tpAtr=12, hold=70, cool=2, maxpos=7, bg(EMA200d band)=0.8
   + gate: funding<fundingMax(=1 inert), rsi<rsiMax(=101 inert), price>EMA200(4h), price>=EMA200d*0.8
   + skip-BEAR (daily MA200/MA50/ATR regime), exit EMA20(4h) sau 10 nến, hold 70.
ETH/SOL: ÁP CÙNG config BTC4h (cross-asset generalize test), funding=0 (gate inert).

Robustness gate: time-add với X∈{2,3,4} — thắng phải robust ±1, KHÔNG đỉnh nhọn X=3.
Walk-forward: BTC/ETH train 2019-2022 vs test 2023-2026; SOL train 2023-2024 vs test 2025-2026.
Report: per-year $ + n, per-month $ + n, total/MaxDD/Calmar, WF, Δ$ time-add vs baseline mỗi năm.
"""
import json, datetime, bisect
from collections import defaultdict

CACHE = {
    "BTC": "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json",
    "ETH": "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-eth-5m-7y.json",
    "SOL": "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-sol-5m-3y.json",
}
FUND = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-funding-7y.json"

CAPITAL = 100_000
LEV = 10            # champion lev
FEE_RT = 0.0008     # round-trip taker ~0.04%/side ×2 (faithful conservative)
# CHAMPION BTC4h sleeve params (NO-TUNE — copied from live config)
ADX_MIN = 18
DI_R    = 0.9
SL_ATR  = 1.6
TP_ATR  = 12
HOLD    = 70
COOL    = 2
MAXPOS  = 7
BG      = 0.8       # EMA200d band gate
EXIT_EMA_BARS = 10
# Execution params (FIXED, no-tune)
K = 1.0             # probe-react confirm ATR threshold
W = 6               # probe-react confirm window bars
X_DEFAULT = 3       # time-add: add after X bars

H4 = 4*3600*1000; H1D = 24*3600*1000

def build(raw5, ms):
    b = {}
    for c in raw5:
        k = c["time"] // ms
        if k not in b:
            b[k] = {"time": k*ms, "open": c["open"], "close": c["close"], "high": c["high"], "low": c["low"]}
        else:
            o = b[k]; o["high"]=max(o["high"],c["high"]); o["low"]=min(o["low"],c["low"]); o["close"]=c["close"]
    return [b[k] for k in sorted(b)]

def ema_s(xs, p):
    k = 2/(p+1); out=[None]*len(xs); e=None
    for i,x in enumerate(xs): e = x if e is None else x*k+e*(1-k); out[i]=e
    return out

def sma_arr(xs, p):
    out=[None]*len(xs); s=0
    for i,x in enumerate(xs):
        s+=x
        if i>=p: s-=xs[i-p]
        if i>=p-1: out[i]=s/p
    return out

def rsi_s(xs, p=14):
    n=len(xs); out=[None]*n
    if n<=p: return out
    ag=al=0
    for i in range(1,p+1): d=xs[i]-xs[i-1]; ag+=max(d,0); al+=max(-d,0)
    ag/=p; al/=p; out[p]=100-100/(1+ag/al) if al>0 else 100
    for i in range(p+1,n):
        d=xs[i]-xs[i-1]; ag=(ag*(p-1)+max(d,0))/p; al=(al*(p-1)+max(-d,0))/p
        out[i]=100-100/(1+ag/al) if al>0 else 100
    return out

def atr_s(bars, p=14):
    n=len(bars); out=[None]*n
    trs=[max(bars[i]["high"]-bars[i]["low"],abs(bars[i]["high"]-bars[i-1]["close"]),abs(bars[i]["low"]-bars[i-1]["close"])) for i in range(1,n)]
    if len(trs)<p: return out
    a=sum(trs[:p])/p; out[p]=a
    for i in range(p,len(trs)): a=(a*(p-1)+trs[i])/p; out[i+1]=a
    return out

def adx_di_s(bars, p=14):
    n=len(bars); adx_o=[None]*n; pdi_o=[None]*n; mdi_o=[None]*n
    if n<p*3: return adx_o,pdi_o,mdi_o
    tr=[];pdm=[];mdm=[]
    for i in range(1,n):
        h,l,pc=bars[i]["high"],bars[i]["low"],bars[i-1]["close"]
        tr.append(max(h-l,abs(h-pc),abs(l-pc)))
        up=h-bars[i-1]["high"]; dn=bars[i-1]["low"]-l
        pdm.append(up if up>dn and up>0 else 0); mdm.append(dn if dn>up and dn>0 else 0)
    def sm(xs):
        out=[None]*len(xs)
        if len(xs)<p: return out
        s=sum(xs[:p]); out[p-1]=s
        for i in range(p,len(xs)): out[i]=out[i-1]-out[i-1]/p+xs[i]
        return out
    atr=sm(tr); ps=sm(pdm); ms2=sm(mdm); dx=[None]*len(tr); pl=[None]*len(tr); ml=[None]*len(tr)
    for i in range(p-1,len(tr)):
        if atr[i] and atr[i]>0:
            pdi=100*ps[i]/atr[i]; mdi=100*ms2[i]/atr[i]; pl[i]=pdi; ml[i]=mdi
            dx[i]=100*abs(pdi-mdi)/(pdi+mdi) if (pdi+mdi)>0 else 0
    a=[None]*len(dx); start=None
    for i in range(len(dx)):
        if dx[i] is not None:
            if start is None: start=i
            if i-start+1==p: a[i]=sum(v for v in dx[start:i+1] if v is not None)/p
            elif i>start+p-1 and a[i-1] is not None: a[i]=(a[i-1]*(p-1)+dx[i])/p
    for i in range(len(dx)): adx_o[i+1]=a[i]; pdi_o[i+1]=pl[i]; mdi_o[i+1]=ml[i]
    return adx_o,pdi_o,mdi_o

# ── funding (BTC only) ──
rf=json.load(open(FUND))
s=rf[0]; tk=[k for k in s if "time" in k.lower()][0]; rk=[k for k in s if k in ("fundingRate","rate","r","funding")][0]
fund_entries=sorted([(int(e[tk]),float(e[rk])) for e in rf]); ft=[e[0] for e in fund_entries]
def fund_at(t):
    j=bisect.bisect_right(ft,t)-1
    return fund_entries[j][1] if j>=0 else 0.0

def idx_le(times, t):
    j=bisect.bisect_right(times,t)-1
    return j

def load_coin(coin):
    raw=json.load(open(CACHE[coin])); raw.sort(key=lambda x:x["time"])
    b4=build(raw,H4)
    c4=[b["close"] for b in b4]
    e200=ema_s(c4,200); e20=ema_s(c4,20); rsi4=rsi_s(c4,14); atr4=atr_s(b4,14)
    adx4,pdi4,mdi4=adx_di_s(b4,14)
    # daily regime arrays
    b1d=build(raw,H1D); cd=[b["close"] for b in b1d]; td=[b["time"] for b in b1d]
    e200d=ema_s(cd,200)
    ma200=sma_arr(cd,200); ma50=sma_arr(cd,50)
    # daily atr-range ratio (20d avg of (h-l)/c)
    rng=[(b1d[i]["high"]-b1d[i]["low"])/b1d[i]["close"] for i in range(len(b1d))]
    rng20=sma_arr(rng,20)
    return {"b4":b4,"c4":c4,"h4":[b["high"] for b in b4],"l4":[b["low"] for b in b4],
            "t4":[b["time"] for b in b4],"e200":e200,"e20":e20,"rsi4":rsi4,"atr4":atr4,
            "adx4":adx4,"pdi4":pdi4,"mdi4":mdi4,
            "td":td,"cd":cd,"ma200":ma200,"ma50":ma50,"rng20":rng20,"e200d":e200d,
            "funded":(coin=="BTC")}

def regime_at(P, t):
    j=idx_le(P["td"],t)
    if j<200 or P["ma200"][j] is None or P["ma50"][j] is None or P["rng20"][j] is None:
        return "RANGE"
    cd=P["cd"][j]; ma200=P["ma200"][j]; ma50=P["ma50"][j]; ar=P["rng20"][j]
    if cd<ma200: return "BEAR"
    if cd>ma50 and ma50>ma200 and ar>0.04: return "BULL"
    return "RANGE"

def e200d_at(P, t):
    j=idx_le(P["td"],t)
    return P["e200d"][j] if j>=0 else None

def champion_signal(P, i, use_fund):
    """Faithful champion BTC4h ENTRY signal. Returns (sl,tp,atr,entryPx) or None."""
    if i<200: return None
    a=P["adx4"][i]; pp=P["pdi4"][i]; mm=P["mdi4"][i]; r=P["rsi4"][i]
    e2=P["e200"][i]; at=P["atr4"][i]; t=P["t4"][i]
    if None in (a,pp,mm,r,e2,at): return None
    if regime_at(P,t)=="BEAR": return None
    fr=fund_at(t) if use_fund else 0.0
    price=P["c4"][i]; e2d=e200d_at(P,t)
    if e2d is None: return None
    # champion gates: fundingMax=1 / rsiMax=101 inert; price>e200; price>=e2d*bg
    if fr>=1 or r>=101 or price<=e2: return None
    if not (a>ADX_MIN and pp>mm*DI_R): return None
    if price < e2d*BG: return None
    return (price-SL_ATR*at, price+TP_ATR*at, at, price)

def fee(n): return FEE_RT*n
def leg_pnl(e, x, n):  # LONG only
    return (x-e)/e*n*LEV - fee(n)
def fav_long(ep, atr, mult, hi): return hi>=ep+mult*atr

def run(P, variant, exposure, X_add=X_DEFAULT):
    """variant: A baseline / B probe-react / E time-add. LONG-only champion."""
    equity=CAPITAL; positions=[]; cooldown=0; last=-999; trades=[]; eq=[equity]
    n=len(P["b4"])
    for i in range(200, n-HOLD-1):
        hi=P["h4"][i]; lo=P["l4"][i]; px=P["c4"][i]; e20=P["e20"][i]; t=P["t4"][i]
        keep=[]
        for p in positions:
            held=i-p["i0"]; close=False; xpx=px
            if lo<=p["sl"]: close=True; xpx=p["sl"]
            elif hi>=p["tp"]: close=True; xpx=p["tp"]
            elif variant=="B" and (not p["confirmed"]) and held>=W: close=True; xpx=px
            elif e20 is not None and px<e20 and held>=EXIT_EMA_BARS: close=True; xpx=px
            elif held>=HOLD: close=True; xpx=px
            if close:
                pnl=sum(leg_pnl(lp["px"],xpx,lp["n"]) for lp in p["legs"])
                equity+=pnl; eq.append(equity)
                trades.append({"yr":p["yr"],"mo":p["mo"],"pnl":pnl}); continue
            # add-leg logic (only while open, not closing)
            ep=p["entry"]; at=p["atr"]; Nf=p["Nf"]
            if variant=="B" and not p["confirmed"]:
                if fav_long(ep,at,K,hi):
                    apx=ep+K*at; p["legs"].append({"px":apx,"n":Nf*2/3}); p["confirmed"]=True
            elif variant=="E" and not p["added"] and held>=X_add:
                p["legs"].append({"px":px,"n":Nf*2/3}); p["added"]=True
            keep.append(p)
        positions=keep
        if cooldown>0: cooldown-=1
        if len(positions)>=MAXPOS or (i-last)<COOL or cooldown>0: continue
        sig=champion_signal(P,i,P["funded"])
        if sig:
            sl,tp,at,epx=sig
            Nf=exposure*equity
            d=datetime.datetime.utcfromtimestamp(t/1000); yr=d.year; mo=d.month
            if variant=="B":
                legs=[{"px":epx,"n":Nf/3}]; conf=False; added=False
            elif variant=="E":
                legs=[{"px":epx,"n":Nf/3}]; conf=True; added=False
            else:
                legs=[{"px":epx,"n":Nf}]; conf=True; added=True
            positions.append({"i0":i,"entry":epx,"sl":sl,"tp":tp,"atr":at,"yr":yr,"mo":mo,
                              "legs":legs,"confirmed":conf,"added":added,"Nf":Nf})
            last=i; cooldown=COOL
    return trades, eq

def metrics(trades, eq):
    final=eq[-1]; peak=eq[0]; mdd=0
    for e in eq:
        peak=max(peak,e); mdd=max(mdd,(peak-e)/peak if peak>0 else 0)
    return final-CAPITAL, mdd, final

def per_year(trades):
    by=defaultdict(lambda:[0.0,0])
    for t in trades: by[t["yr"]][0]+=t["pnl"]; by[t["yr"]][1]+=1
    return by

def per_month(trades):
    bm=defaultdict(lambda:[0.0,0])
    for t in trades: bm[(t["yr"],t["mo"])][0]+=t["pnl"]; bm[(t["yr"],t["mo"])][1]+=1
    return bm

def split_net(trades, y0, y1):
    return sum(t["pnl"] for t in trades if y0<=t["yr"]<=y1), sum(1 for t in trades if y0<=t["yr"]<=y1)

def matched_exposure(P, variant, target_dd, X_add=X_DEFAULT):
    best=None
    for exp in [round(0.02+0.01*k,3) for k in range(29)]:  # 0.02..0.30
        t,e=run(P,variant,exp,X_add); net,dd,fin=metrics(t,e)
        err=abs(dd-target_dd)
        if best is None or err<best[0]:
            best=(err,exp,net,dd,fin,t)
    return best

COIN_YEARS = {"BTC":(2019,2026),"ETH":(2019,2026),"SOL":(2023,2026)}
COIN_WF    = {"BTC":((2019,2022),(2023,2026)),"ETH":((2019,2022),(2023,2026)),
              "SOL":((2023,2024),(2025,2026))}
MONTHS=["01","02","03","04","05","06","07","08","09","10","11","12"]

def fmt_year_table(label, trades, y0, y1):
    by=per_year(trades)
    print(f"  {label} per-year:")
    print(f"    {'year':6s}{'n':>5}{'PnL$':>14}")
    for y in range(y0,y1+1):
        p,n=by.get(y,[0.0,0])
        print(f"    {y:<6}{n:>5}{p:>+14,.0f}")

def fmt_month_table(label, trades, y0, y1):
    bm=per_month(trades)
    print(f"  {label} per-month $ (year × month):")
    hdr="    yr   "+"".join(f"{m:>9}" for m in MONTHS)+f"{'TOT':>11}"
    print(hdr)
    for y in range(y0,y1+1):
        row=f"    {y} "
        tot=0
        for mi in range(1,13):
            p,n=bm.get((y,mi),[0.0,0]); tot+=p
            row+=f"{p:>9,.0f}" if n>0 else f"{'·':>9}"
        row+=f"{tot:>+11,.0f}"
        print(row)
    print(f"  {label} per-month n (year × month):")
    print("    yr   "+"".join(f"{m:>6}" for m in MONTHS)+f"{'TOT':>7}")
    for y in range(y0,y1+1):
        row=f"    {y} "; tn=0
        for mi in range(1,13):
            p,n=bm.get((y,mi),[0.0,0]); tn+=n
            row+=f"{n:>6}" if n>0 else f"{'·':>6}"
        row+=f"{tn:>7}"
        print(row)

def main():
    print("Loading coins (build 4h+1d, champion indicators)... ~1min")
    coins={c:load_coin(c) for c in CACHE}
    print("done.\n")
    summary=[]
    for coin,P in coins.items():
        y0,y1=COIN_YEARS[coin]; (tr0,tr1),(te0,te1)=COIN_WF[coin]
        # baseline at exp 8% (compounding); matched-DD target
        tA,eA=run(P,"A",0.08); netA,ddA,finA=metrics(tA,eA)
        print("\n"+"#"*96)
        print(f"# {coin}  CHAMPION entry — baseline DD target = {ddA*100:.1f}%  (years {y0}-{y1})")
        print("#"*96)
        variants=[("A","baseline-full",None),("B","probe-react K1/W6",None),
                  ("E","time-add X3",3),("E","time-add X2",2),("E","time-add X4",4)]
        coinrows={}
        for vk,vname,xa in variants:
            if vk=="A":
                t,e=tA,eA; net,dd,fin=netA,ddA,finA; exp=0.08
            else:
                err,exp,net,dd,fin,t=matched_exposure(P,vk,ddA,X_add=(xa or X_DEFAULT))
            cal=(net/CAPITAL)/dd if dd>0 else 0
            trn,ntrn=split_net(t,tr0,tr1); ten,nten=split_net(t,te0,te1)
            coinrows[vname]={"t":t,"net":net,"dd":dd,"cal":cal,"exp":exp,
                             "train":trn,"test":ten,"ntr":ntrn,"nte":nten,"vk":vk,"xa":xa}
            print(f"\n[{vk}] {vname:20s} exp={exp*100:.0f}%  n={len(t)}  "
                  f"net=${net:,.0f}  Δ${net-netA:+,.0f}  MaxDD={dd*100:.1f}%  Calmar={cal:.2f}")
            print(f"     WF train({tr0}-{tr1})=${trn:+,.0f}(n{ntrn})  test({te0}-{te1})=${ten:+,.0f}(n{nten}) {'WIN' if ten>0 else 'LOSS'}")
        # detailed tables: baseline + winning time-add (X3) + probe-react
        print("\n--- PER-YEAR (n + $) all variants ---")
        for vname in ["baseline-full","probe-react K1/W6","time-add X2","time-add X3","time-add X4"]:
            fmt_year_table(vname, coinrows[vname]["t"], y0, y1)
        print("\n--- PER-MONTH (baseline + time-add X3) ---")
        fmt_month_table("baseline-full", coinrows["baseline-full"]["t"], y0, y1)
        fmt_month_table("time-add X3", coinrows["time-add X3"]["t"], y0, y1)
        # Δ$ time-add X3 vs baseline per-year
        print("\n--- Δ$ time-add X3 vs baseline (per-year) ---")
        byA=per_year(coinrows["baseline-full"]["t"]); byE=per_year(coinrows["time-add X3"]["t"])
        print(f"    {'year':6s}{'baseline$':>14}{'timeadd$':>14}{'Δ$':>14}")
        for y in range(y0,y1+1):
            a=byA.get(y,[0,0])[0]; e=byE.get(y,[0,0])[0]
            print(f"    {y:<6}{a:>+14,.0f}{e:>+14,.0f}{e-a:>+14,.0f}")
        summary.append((coin,coinrows,netA,ddA))
    # ── VERDICT ──
    print("\n\n"+"#"*96)
    print("# CROSS-ASSET VERDICT — matched-DD, Δnet vs baseline; robustness X2/X3/X4; WF test")
    print("#"*96)
    print(f"{'coin':6s}{'X':>4}{'Δnet$':>14}{'MaxDD%':>9}{'Calmar':>8}{'WFtest$':>12}{'verdict':>10}")
    for coin,rows,netA,ddA in summary:
        for xa,vname in [(2,"time-add X2"),(3,"time-add X3"),(4,"time-add X4")]:
            r=rows[vname]; dnet=r["net"]-netA
            v="HELP" if (dnet>0 and r["test"]>0) else ("hurt" if dnet<0 else "flat")
            print(f"{coin:6s}{xa:>4}{dnet:>+14,.0f}{r['dd']*100:>9.1f}{r['cal']:>8.2f}{r['test']:>+12,.0f}{v:>10}")
    print("\nGate: HELP nếu Δnet>0 + WF-test>0; robust nếu X2/X3/X4 cùng dấu (không đỉnh nhọn X3).")

if __name__=="__main__":
    main()
