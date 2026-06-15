#!/usr/bin/env python3
"""
probe-react-deepen-crossasset.py — ĐÀO SÂU entry-execution (KHÔNG tìm signal mới).

Mở rộng probe-react-pyramid-7y.py theo 3 trục:
  (1) CROSS-ASSET: BTC + ETH (7y) + SOL (3y) — probe-react generalize hay chỉ BTC?
  (2) RULE THẬT: signal-source = stochbreak LONG (K_1h<20 + mom4h) ngoài G1 dip-buy.
  (3) VARIANT MỚI: ngoài A baseline / B probe-react, thêm
        D scale-IN-on-winner (chỉ add khi vị thế ĐANG LÃI, trailing favorable, KHÔNG add khi adverse)
        E time-based add  (add sau X nến nếu chưa chạm SL — bất kể thuận/nghịch)

JUDGE: DOLLARS + Calmar + matched-DD (bơm exposure tới khi DD ≈ baseline → so $ công bằng,
       vì probe ít vốn ban đầu → DD nhỏ tự nhiên, không fair nếu so thô).
Walk-forward: train 2019-2023 / test 2024-2026 (SOL: 2023H2-2024 / 2025-2026).
K/W/X FIXED (no-tune, theo cảnh báo overfit). Report per-year.
"""
import json, datetime, bisect, sys
from collections import defaultdict

CACHE = {
    "BTC": "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json",
    "ETH": "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-eth-5m-7y.json",
    "SOL": "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-sol-5m-3y.json",
}
FUND = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-funding-7y.json"

CAPITAL = 100_000
LEV = 5
ATR_SL = 2.0
MAX_HOLD_4H = 60
FEE_RT = 0.0006
# Fixed execution params (NO-TUNE — validated defaults from probe-react-pyramid)
K = 1.0          # probe-react: confirm threshold ATR
W = 6            # probe-react: confirm window bars
X_ADD = 3        # time-based: add after X bars if not stopped

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

def stochrsi_k(closes, rp=14, sp=14, ks=3):
    rsi=rsi_s(closes,rp); n=len(closes); rawk=[None]*n
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

# ── funding (BTC only; ETH/SOL → 0, gate becomes inert) ──
rf=json.load(open(FUND))
s=rf[0]; tk=[k for k in s if "time" in k.lower()][0]; rk=[k for k in s if k in ("fundingRate","rate","r","funding")][0]
fund_entries=sorted([(int(e[tk]),float(e[rk])) for e in rf]); ft=[e[0] for e in fund_entries]
def fund_at(t):
    j=bisect.bisect_right(ft,t)-1
    return fund_entries[j][1] if j>=0 else 0.0

# ── per-coin indicator bundle ──
def load_coin(coin):
    raw=json.load(open(CACHE[coin])); raw.sort(key=lambda x:x["time"])
    b4=build(raw,4*3600*1000)
    c4=[b["close"] for b in b4]; h4=[b["high"] for b in b4]; l4=[b["low"] for b in b4]
    e200=ema_s(c4,200); e50=ema_s(c4,50); rsi4=rsi_s(c4,14); atr4=atr_s(b4,14)
    adx4,pdi4,mdi4=adx_di_s(b4,14)
    # 1h for stochbreak signal
    b1=build(raw,3600*1000)
    c1=[b["close"] for b in b1]; t1=[b["time"] for b in b1]
    K1=stochrsi_k(c1)
    # map 4h idx → for stochbreak we evaluate on 4h cadence using K1 sampled at 4h close
    return {"b4":b4,"c4":c4,"h4":h4,"l4":l4,"e200":e200,"e50":e50,"rsi4":rsi4,
            "atr4":atr4,"adx4":adx4,"pdi4":pdi4,"mdi4":mdi4,
            "c1":c1,"t1":t1,"K1":K1,"funded":(coin=="BTC")}

# ── SIGNAL SOURCES (LONG-only for clean cross-asset; SHORT no-edge per memory) ──
def sig_G1(P, i, use_fund):
    """G1 dip-buy: ADX>20 + DI bull + RSI 28-52 + price>EMA200/50 + funding gate."""
    if i<50: return None
    a=P["adx4"][i]; pp=P["pdi4"][i]; mm=P["mdi4"][i]; r=P["rsi4"][i]
    e2=P["e200"][i]; e5=P["e50"][i]; at=P["atr4"][i]
    if None in (a,pp,mm,r,e2,e5,at): return None
    price=P["c4"][i]
    fr=fund_at(P["b4"][i]["time"]) if use_fund else 0.0
    if a>20 and pp>mm and 28<=r<=52 and price>e2 and price>e5 and fr<0.0003:
        return ("LONG", price-ATR_SL*at, at, price)
    return None

def k1_at_4h(P, i):
    """StochRSI K_1h at the close of 4h bar i (latest closed 1h within that 4h)."""
    T=P["b4"][i]["time"]+4*3600*1000-1
    j=bisect.bisect_right(P["t1"],T)-1
    return P["K1"][j] if j>=0 else None

def sig_stochbreak(P, i, use_fund):
    """stochbreak LONG: K_1h<20 + mom4h_bull (c4[i]>c4[i-5]). SL 2xATR for execution test."""
    if i<6: return None
    at=P["atr4"][i]
    if at is None: return None
    ki=k1_at_4h(P,i)
    if ki is None or not (ki<20): return None
    if not (P["c4"][i] > P["c4"][i-5]): return None
    price=P["c4"][i]
    return ("LONG", price-ATR_SL*at, at, price)

# ── EXECUTION ENGINE (compounding, single account) ──
def fee(n): return FEE_RT*n
def leg_pnl(side, e, x, n):
    pct=(x-e)/e*(1 if side=="LONG" else -1)
    return pct*n*LEV - fee(n)
def fav(side, ep, atr, mult, hi, lo):
    return hi>=ep+mult*atr if side=="LONG" else lo<=ep-mult*atr
def hit_sl(side, sl, hi, lo):
    return lo<=sl if side=="LONG" else hi>=sl

def run(P, sigfn, variant, exposure):
    """variant: A baseline / B probe-react / D scalein-winner / E timeadd.
    Returns (trades[pnl,yr], eqcurve)."""
    equity=CAPITAL; pos=None; cooldown=0; trades=[]; eq=[equity]
    n=len(P["b4"])
    for i in range(50, n-MAX_HOLD_4H-1):
        yr=datetime.datetime.utcfromtimestamp(P["b4"][i]["time"]/1000).year
        if pos:
            side=pos["side"]; hi=P["h4"][i]; lo=P["l4"][i]; px=P["c4"][i]; held=i-pos["i0"]
            close=False; xpx=None
            if hit_sl(side,pos["sl"],hi,lo): close=True; xpx=pos["sl"]
            elif variant=="B" and not pos["confirmed"] and held>=W: close=True; xpx=px
            elif held>=MAX_HOLD_4H: close=True; xpx=px
            if close:
                pnl=sum(leg_pnl(side,lp["px"],xpx,lp["n"]) for lp in pos["legs"])
                equity+=pnl; eq.append(equity)
                trades.append({"yr":pos["yr"],"pnl":pnl}); pos=None; cooldown=2; continue
            ep=pos["entry"]; at=pos["atr"]; Nf=pos["Nf"]
            if variant=="B" and not pos["confirmed"]:
                if fav(side,ep,at,K,hi,lo):
                    apx=ep+(K*at if side=="LONG" else -K*at)
                    pos["legs"].append({"px":apx,"n":Nf*2/3}); pos["confirmed"]=True
            elif variant=="D":
                # scale-in-on-WINNER: add 2/3 ONLY when position already in profit
                # (current bar low/high still above entry in favorable sense) AND fav K reached.
                if not pos["added"] and fav(side,ep,at,K,hi,lo):
                    # require still-winning: bar close on favorable side of entry
                    winning = px>ep if side=="LONG" else px<ep
                    if winning:
                        apx=ep+(K*at if side=="LONG" else -K*at)
                        pos["legs"].append({"px":apx,"n":Nf*2/3}); pos["added"]=True
            elif variant=="E":
                # time-based add: add 2/3 after X bars if not stopped (regardless of fav)
                if not pos["added"] and held>=X_ADD:
                    pos["legs"].append({"px":px,"n":Nf*2/3}); pos["added"]=True
            continue
        if cooldown>0: cooldown-=1; continue
        sig=sigfn(P,i,P["funded"])
        if sig:
            side,sl,at,epx=sig
            Nf=exposure*equity
            if variant=="B":
                legs=[{"px":epx,"n":Nf/3}]; conf=False
            elif variant in ("D","E"):
                legs=[{"px":epx,"n":Nf/3}]; conf=True
            else:
                legs=[{"px":epx,"n":Nf}]; conf=True
            pos={"i0":i,"side":side,"entry":epx,"sl":sl,"atr":at,"yr":yr,
                 "legs":legs,"confirmed":conf,"added":False,"Nf":Nf}
    return trades, eq

def metrics(trades, eq):
    final=eq[-1]
    peak=eq[0]; mdd=0
    for e in eq:
        peak=max(peak,e); mdd=max(mdd,(peak-e)/peak)
    net=final-CAPITAL
    return net, mdd, final

def per_year(trades):
    by=defaultdict(float)
    for t in trades: by[t["yr"]]+=t["pnl"]
    return by

def split_net(trades, y0, y1):
    return sum(t["pnl"] for t in trades if y0<=t["yr"]<=y1)

# matched-DD: find exposure for variant so DD ≈ baseline DD
def matched_exposure(P, sigfn, variant, target_dd, base_exp=0.10):
    best=None
    for exp in [round(0.05+0.02*k,3) for k in range(13)]:  # 0.05..0.29
        t,e=run(P,sigfn,variant,exp); net,dd,fin=metrics(t,e)
        if best is None or abs(dd-target_dd)<best[0]:
            best=(abs(dd-target_dd),exp,net,dd,fin,t)
    return best  # (err,exp,net,dd,fin,trades)

COIN_YEARS = {"BTC":(2019,2026),"ETH":(2019,2026),"SOL":(2023,2026)}
COIN_WF = {"BTC":(2019,2023,2024,2026),"ETH":(2019,2023,2024,2026),"SOL":(2023,2024,2025,2026)}

VARIANTS=[("A","baseline-full"),("B","probe-react K1/W6"),("D","scalein-winner"),("E","time-add X3")]
SIGS=[("G1","G1 dip-buy"),("SB","stochbreak LONG")]

def main():
    print("Loading coins (build 4h+1h, indicators)... ~1-2min")
    coins={c:load_coin(c) for c in CACHE}
    print("done.\n")
    rows=[]
    for sigkey,signame in SIGS:
        sigfn = sig_G1 if sigkey=="G1" else sig_stochbreak
        for coin,P in coins.items():
            # baseline DD at exp 10%
            tA,eA=run(P,sigfn,"A",0.10); netA,ddA,finA=metrics(tA,eA)
            y0,y1=COIN_YEARS[coin]
            tr0,tr1,te0,te1=COIN_WF[coin]
            print(f"\n{'='*86}\n{signame} | {coin} | baseline DD target={ddA*100:.1f}%")
            print(f"{'='*86}")
            for vk,vname in VARIANTS:
                if vk=="A":
                    t,e=tA,eA; net,dd,fin=netA,ddA,finA; exp=0.10
                else:
                    err,exp,net,dd,fin,t=matched_exposure(P,sigfn,vk,ddA)
                cal = (net/CAPITAL)/dd if dd>0 else 0
                by=per_year(t)
                tr=split_net(t,tr0,tr1); te=split_net(t,te0,te1)
                dnet = net-netA
                pyline=" ".join(f"{y}:{by.get(y,0):+.0f}" for y in range(y0,y1+1))
                wf = "+" if te>0 else "-"
                print(f"  [{vk}] {vname:20s} exp={exp*100:.0f}% n={len(t):4d} net=${net:>10,.0f} "
                      f"Δ${dnet:>+9,.0f} DD={dd*100:4.1f}% Calmar={cal:5.2f} WF_te=${te:>+8,.0f}{wf}")
                print(f"       per-yr: {pyline}")
                rows.append({"sig":signame,"coin":coin,"variant":vname,"exp":exp,"net":net,
                             "dnet":dnet,"dd":dd,"calmar":cal,"train":tr,"test":te,"n":len(t)})
    # ── cross-asset verdict per variant×signal ──
    print(f"\n\n{'#'*86}\nCROSS-ASSET VERDICT (matched-DD, Δnet vs baseline-A)\n{'#'*86}")
    print(f"{'signal':18s}{'variant':22s}{'BTC':>10}{'ETH':>10}{'SOL':>10}  coins_help(Δ>0 & test>0)")
    for sigkey,signame in SIGS:
        for vk,vname in VARIANTS:
            if vk=="A": continue
            d={}
            for r in rows:
                if r["sig"]==signame and r["variant"]==vname: d[r["coin"]]=r
            cells=[]; helps=0
            for c in ("BTC","ETH","SOL"):
                if c in d:
                    cells.append(f"{d[c]['dnet']:>+10,.0f}")
                    if d[c]["dnet"]>0 and d[c]["test"]>0: helps+=1
                else: cells.append(f"{'--':>10}")
            print(f"{signame:18s}{vname:22s}{cells[0]}{cells[1]}{cells[2]}   {helps}/3")
    print("\nGate: variant đáng LIVE nếu Δnet>0 + test(WF)>0 ở ≥2/3 coin. K/W/X FIXED no-tune.")

if __name__=="__main__":
    main()
