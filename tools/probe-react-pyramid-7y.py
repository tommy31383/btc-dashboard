#!/usr/bin/env python3
"""
probe-react-pyramid-7y.py — Test entry-handling: Baseline vs Probe→react vs Inverse-pyramid.

Isolate biến ENTRY-HANDLING: cùng signal (G1 BTC 4h) + cùng SL (2×ATR) + cùng max-hold,
chỉ đổi CÁCH VÀO LỆNH. Judge bằng DOLLARS + DrawDown + per-year (theo lesson "judge dollar").

Variants:
  A. BASELINE      — vào full notional ngay khi signal fire (hiện tại).
  B. PROBE→REACT   — vào 1/3 (probe). Nếu giá đi thuận ≥ K×ATR trong W nến → add 2/3 lên full.
                     Nếu chạm probe-SL hoặc hết W nến chưa confirm → cắt phần đang mở (thua rẻ ⅓).
  C. INVERSE-PYRAMID — vào full ngay → add ½N tại +1×ATR, ¼N tại +2×ATR (thuận tiếp). Margin-cap 1.75N.

PnL USD = pnl_pct × notional × LEV − fee. Equity curve chronological → MaxDD $.
"""
import json, datetime, statistics, sys, bisect
from collections import defaultdict

CACHE_5M   = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
CACHE_FUND = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-funding-7y.json"

CAPITAL    = 100_000
TRADE_NOTIONAL = 10_000   # "full" size N
LEV        = 5
ATR_SL     = 2.0
MAX_HOLD_4H = 60
FEE_RT     = 0.0006       # 0.06% round-trip (per unit notional opened+closed)

print("Loading data...")
raw5m = json.load(open(CACHE_5M)); raw5m.sort(key=lambda x:x["time"])
rf    = json.load(open(CACHE_FUND))
s=rf[0]; tk=[k for k in s if "time" in k.lower()][0]; rk=[k for k in s if k in ("fundingRate","rate","r","funding")][0]
fund_entries=sorted([(int(e[tk]),float(e[rk])) for e in rf]); ft=[e[0] for e in fund_entries]
print(f"  5m:{len(raw5m):,}  funding:{len(fund_entries)}")

def build(ms):
    b={}
    for c in raw5m:
        k=c["time"]//ms
        if k not in b: b[k]={"time":k*ms,"open":c["open"],"close":c["close"],"high":c["high"],"low":c["low"],"volume":c["volume"]}
        else: o=b[k]; o["high"]=max(o["high"],c["high"]); o["low"]=min(o["low"],c["low"]); o["close"]=c["close"]; o["volume"]+=c["volume"]
    return [b[k] for k in sorted(b)]

bars4h=build(4*3600*1000)
c4=[b["close"] for b in bars4h]; h4=[b["high"] for b in bars4h]; l4=[b["low"] for b in bars4h]
print(f"  4h:{len(bars4h)}")

def fund_at(t):
    j=bisect.bisect_right(ft,t)-1
    return fund_entries[j][1] if j>=0 else 0

def ema_s(xs,p):
    k=2/(p+1); out=[None]*len(xs); e=None
    for i,x in enumerate(xs): e=x if e is None else x*k+e*(1-k); out[i]=e
    return out

def rsi_s(xs,p=14):
    n=len(xs); out=[None]*n
    if n<=p: return out
    ag=al=0
    for i in range(1,p+1): d=xs[i]-xs[i-1]; ag+=max(d,0); al+=max(-d,0)
    ag/=p; al/=p; out[p]=100-100/(1+ag/al) if al>0 else 100
    for i in range(p+1,n):
        d=xs[i]-xs[i-1]; ag=(ag*(p-1)+max(d,0))/p; al=(al*(p-1)+max(-d,0))/p
        out[i]=100-100/(1+ag/al) if al>0 else 100
    return out

def atr_s(bars,p=14):
    n=len(bars); out=[None]*n
    trs=[max(bars[i]["high"]-bars[i]["low"],abs(bars[i]["high"]-bars[i-1]["close"]),abs(bars[i]["low"]-bars[i-1]["close"])) for i in range(1,n)]
    if len(trs)<p: return out
    a=sum(trs[:p])/p; out[p]=a
    for i in range(p,len(trs)): a=(a*(p-1)+trs[i])/p; out[i+1]=a
    return out

def adx_di_s(bars,p=14):
    n=len(bars); adx_o=[None]*n; pdi_o=[None]*n; mdi_o=[None]*n
    if n<p*3: return adx_o,pdi_o,mdi_o
    tr=[]; pdm=[]; mdm=[]
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

print("Computing indicators 4h...")
e200=ema_s(c4,200); e50=ema_s(c4,50)
rsi4=rsi_s(c4,14); atr4=atr_s(bars4h,14)
adx4,pdi4,mdi4=adx_di_s(bars4h,14)

def signal_G1(i):
    """G1: 4h ADX momentum dip-buy + funding gate. Returns (side, sl_px, atr_at_entry)."""
    if i<50: return None,None,None
    a=adx4[i]; pp=pdi4[i]; mm=mdi4[i]; r=rsi4[i]; e2=e200[i]; e5=e50[i]; at=atr4[i]; fr=fund_at(bars4h[i]["time"])
    if None in (a,pp,mm,r,e2,e5,at): return None,None,None
    price=c4[i]
    if a>20 and pp>mm and 28<=r<=52 and price>e2 and price>e5 and fr<0.0003:
        return "LONG", price-ATR_SL*at, at
    if a>20 and mm>pp and 48<=r<=72 and price<e2 and price<e5 and fr>0.0001:
        return "SHORT", price+ATR_SL*at, at
    return None,None,None

# ─── ENGINE ──────────────────────────────────────────────────────────────────
def fee(notional): return FEE_RT*notional

def leg_pnl(side, entry_px, exit_px, notional):
    """PnL USD of one leg (fee = round-trip on this leg's notional)."""
    pct=(exit_px-entry_px)/entry_px*(1 if side=="LONG" else -1)
    return pct*notional*LEV - fee(notional)

def favorable_reached(side, entry_px, atr, mult, bar_hi, bar_lo):
    """Did price move >= mult×ATR in favor within this bar?"""
    if side=="LONG":  return bar_hi >= entry_px + mult*atr
    else:             return bar_lo <= entry_px - mult*atr

def hit_sl(side, sl_px, bar_hi, bar_lo):
    if side=="LONG":  return bar_lo <= sl_px
    else:             return bar_hi >= sl_px

def run(variant, K=1.0, W=6):
    """Returns list of closed trades (each = one signal instance, pnl_usd aggregated over legs)."""
    trades=[]; pos=None; cooldown=0
    for i in range(50, len(bars4h)-MAX_HOLD_4H-1):
        yr=datetime.datetime.utcfromtimestamp(bars4h[i]["time"]/1000).year
        if pos:
            side=pos["side"]; bhi=h4[i]; blo=l4[i]; px=c4[i]; held=i-pos["i0"]
            # --- exit conditions (SL checked first, conservative) ---
            close_now=False; exit_px=None
            if hit_sl(side, pos["sl"], bhi, blo):
                close_now=True; exit_px=pos["sl"]
            # variant B: reject if no confirm within W bars and still in probe-only state
            elif variant=="B" and not pos["confirmed"] and held>=W:
                close_now=True; exit_px=px  # cut probe at market (cheap loss/scratch)
            elif held>=MAX_HOLD_4H:
                close_now=True; exit_px=px
            if close_now:
                pnl=sum(leg_pnl(side,lp["px"],exit_px,lp["notional"]) for lp in pos["legs"])
                peakN=pos["peakN"]
                trades.append({"yr":pos["yr"],"side":side,"pnl_usd":pnl,"held":held,
                               "sl":exit_px==pos["sl"],"confirmed":pos.get("confirmed",True),
                               "nlegs":len(pos["legs"]),"peakN":peakN})
                pos=None; cooldown=2; continue
            # --- add logic (only if not closing) ---
            if variant=="B" and not pos["confirmed"]:
                if favorable_reached(side,pos["entry_px"],pos["atr"],K,bhi,blo):
                    add_px=pos["entry_px"]+ (K*pos["atr"] if side=="LONG" else -K*pos["atr"])
                    pos["legs"].append({"px":add_px,"notional":TRADE_NOTIONAL*2/3})
                    pos["confirmed"]=True
                    pos["peakN"]=sum(lp["notional"] for lp in pos["legs"])
            elif variant=="C":
                # add ½N at +1ATR, ¼N at +2ATR (favorable), cap reached when both done
                ep=pos["entry_px"]; at=pos["atr"]
                if pos["adds"]<1 and favorable_reached(side,ep,at,1.0,bhi,blo):
                    ap=ep+(1.0*at if side=="LONG" else -1.0*at)
                    pos["legs"].append({"px":ap,"notional":TRADE_NOTIONAL*0.5}); pos["adds"]=1
                    pos["peakN"]=sum(lp["notional"] for lp in pos["legs"])
                if pos["adds"]<2 and favorable_reached(side,ep,at,2.0,bhi,blo):
                    ap=ep+(2.0*at if side=="LONG" else -2.0*at)
                    pos["legs"].append({"px":ap,"notional":TRADE_NOTIONAL*0.25}); pos["adds"]=2
                    pos["peakN"]=sum(lp["notional"] for lp in pos["legs"])
            continue
        if cooldown>0: cooldown-=1; continue
        sig,sl_px,at=signal_G1(i)
        if sig:
            ep=c4[i]
            if variant=="A":
                legs=[{"px":ep,"notional":TRADE_NOTIONAL}]; conf=True
            elif variant=="B":
                legs=[{"px":ep,"notional":TRADE_NOTIONAL/3}]; conf=False
            else:  # C
                legs=[{"px":ep,"notional":TRADE_NOTIONAL}]; conf=True
            pos={"i0":i,"side":sig,"entry_px":ep,"sl":sl_px,"atr":at,"yr":yr,
                 "legs":legs,"confirmed":conf,"adds":0,
                 "peakN":sum(lp["notional"] for lp in legs)}
    return trades

def equity_dd(trades):
    """MaxDD in $ from chronological cumulative equity (trades already chronological)."""
    eq=0; peak=0; maxdd=0
    for t in trades:
        eq+=t["pnl_usd"]; peak=max(peak,eq); maxdd=max(maxdd, peak-eq)
    return maxdd

def report(trades, tag):
    by_yr=defaultdict(list)
    for t in trades: by_yr[t["yr"]].append(t)
    tot=sum(t["pnl_usd"] for t in trades); n=len(trades)
    wr=100*sum(1 for t in trades if t["pnl_usd"]>0)/n if n else 0
    dd=equity_dd(trades)
    peakN=max((t["peakN"] for t in trades), default=0)
    print(f"\n[{tag}]  n={n}  netPnL=${tot:,.0f}  WR={wr:.0f}%  MaxDD=${dd:,.0f}  peakNotional=${peakN:,.0f}")
    pos_yrs=0
    line=[]
    for yr in range(2019,2027):
        ts=by_yr.get(yr,[]); yn=len(ts); ypnl=sum(t["pnl_usd"] for t in ts)
        if ypnl>0: pos_yrs+=1
        line.append(f"{yr}:${ypnl:,.0f}(n{yn})")
    print("   "+"  ".join(line))
    print(f"   pos_years={pos_yrs}/8   return_on_cap={tot/CAPITAL*100:+.0f}%")
    return {"tag":tag,"n":n,"net":tot,"wr":wr,"dd":dd,"pos_yrs":pos_yrs,"peakN":peakN}

MODE = sys.argv[1] if len(sys.argv)>1 else "full"

# ─── HONEST COMPOUNDING ENGINE (size = % equity, single account, compound) ────
EXPOSURE = 0.10   # full notional = 10% of running equity (≈ $10k on $100k start)

def run_honest(variant, K=1.0, W=6):
    """Compounding single-account: notional_full = EXPOSURE×equity each entry.
    Returns (trades_with_equity, equity_curve)."""
    equity=CAPITAL; pos=None; cooldown=0; trades=[]; eqcurve=[equity]
    for i in range(50, len(bars4h)-MAX_HOLD_4H-1):
        yr=datetime.datetime.utcfromtimestamp(bars4h[i]["time"]/1000).year
        if pos:
            side=pos["side"]; bhi=h4[i]; blo=l4[i]; px=c4[i]; held=i-pos["i0"]
            close_now=False; exit_px=None
            if hit_sl(side,pos["sl"],bhi,blo): close_now=True; exit_px=pos["sl"]
            elif variant=="B" and not pos["confirmed"] and held>=W: close_now=True; exit_px=px
            elif held>=MAX_HOLD_4H: close_now=True; exit_px=px
            if close_now:
                pnl=sum(leg_pnl(side,lp["px"],exit_px,lp["notional"]) for lp in pos["legs"])
                equity+=pnl; eqcurve.append(equity)
                trades.append({"yr":pos["yr"],"pnl_usd":pnl,"equity":equity}); pos=None; cooldown=2; continue
            if variant=="B" and not pos["confirmed"]:
                if favorable_reached(side,pos["entry_px"],pos["atr"],K,bhi,blo):
                    add_px=pos["entry_px"]+(K*pos["atr"] if side=="LONG" else -K*pos["atr"])
                    pos["legs"].append({"px":add_px,"notional":pos["Nfull"]*2/3}); pos["confirmed"]=True
            elif variant=="C":
                ep=pos["entry_px"]; at=pos["atr"]
                if pos["adds"]<1 and favorable_reached(side,ep,at,1.0,bhi,blo):
                    ap=ep+(at if side=="LONG" else -at); pos["legs"].append({"px":ap,"notional":pos["Nfull"]*0.5}); pos["adds"]=1
                if pos["adds"]<2 and favorable_reached(side,ep,at,2.0,bhi,blo):
                    ap=ep+(2*at if side=="LONG" else -2*at); pos["legs"].append({"px":ap,"notional":pos["Nfull"]*0.25}); pos["adds"]=2
            continue
        if cooldown>0: cooldown-=1; continue
        sig,sl_px,at=signal_G1(i)
        if sig:
            ep=c4[i]; Nfull=EXPOSURE*equity
            if variant=="B": legs=[{"px":ep,"notional":Nfull/3}]; conf=False
            else: legs=[{"px":ep,"notional":Nfull}]; conf=True
            pos={"i0":i,"side":sig,"entry_px":ep,"sl":sl_px,"atr":at,"yr":yr,
                 "legs":legs,"confirmed":conf,"adds":0,"Nfull":Nfull}
    return trades, eqcurve

def cagr_dd(trades, eqcurve):
    final=eqcurve[-1]; yrs=7.4
    cagr=(final/CAPITAL)**(1/yrs)-1
    peak=eqcurve[0]; maxdd=0
    for e in eqcurve:
        peak=max(peak,e); maxdd=max(maxdd,(peak-e)/peak)
    return cagr, maxdd, final

if MODE=="matched":
    print("\n"+"="*78)
    print("MATCHED-DD — bơm size B/C tới khi MaxDD ≈ A baseline (17.4%), so DOLLAR công bằng")
    print("="*78)
    EXPOSURE=0.10; tA,eA=run_honest("A"); cA,dA,fA=cagr_dd(tA,eA)
    print(f"\n  A baseline @exp10%: CAGR={cA*100:.1f}% DD={dA*100:.1f}% final=${fA:,.0f}")
    print(f"\n  Bơm B (K1.0/W6) tới DD≈{dA*100:.1f}%:")
    for exp in (0.10,0.13,0.15,0.17,0.19,0.21):
        EXPOSURE=exp; t,e=run_honest("B"); c,d,f=cagr_dd(t,e)
        flag=" ← matched" if abs(d-dA)<0.015 else ""
        print(f"    exp={exp*100:.0f}%  CAGR={c*100:.1f}%  DD={d*100:.1f}%  final=${f:,.0f}  Calmar={c/d if d>0 else 0:.2f}{flag}")
    print(f"\n  Bơm C tới DD≈{dA*100:.1f}%:")
    for exp in (0.06,0.07,0.08,0.10):
        EXPOSURE=exp; t,e=run_honest("C"); c,d,f=cagr_dd(t,e)
        flag=" ← matched" if abs(d-dA)<0.02 else ""
        print(f"    exp={exp*100:.0f}%  CAGR={c*100:.1f}%  DD={d*100:.1f}%  final=${f:,.0f}  Calmar={c/d if d>0 else 0:.2f}{flag}")
    sys.exit(0)

if MODE=="honest":
    print("\n"+"="*78)
    print("HONEST COMPOUNDING — size=10%×equity, single account, lãi kép. K=1.0 W=6 (FIXED, no-tune)")
    print("="*78)
    for v,lbl in [("A","A BASELINE full"),("B","B PROBE→REACT K1.0/W6"),("C","C INVERSE-PYRAMID")]:
        t,eq=run_honest(v); cagr,dd,fin=cagr_dd(t,eq)
        byyr=defaultdict(float)
        for x in t: byyr[x["yr"]]+=x["pnl_usd"]
        posy=sum(1 for yr in range(2019,2027) if byyr.get(yr,0)>0)
        print(f"\n[{lbl}]  finalEq=${fin:,.0f}  CAGR={cagr*100:.1f}%  MaxDD={dd*100:.1f}%  Calmar={cagr/dd if dd>0 else 0:.2f}  pos_yrs={posy}/8")
    sys.exit(0)


def split_metrics(trades, y0, y1):
    ts=[t for t in trades if y0<=t["yr"]<=y1]
    net=sum(t["pnl_usd"] for t in ts); dd=equity_dd(ts); n=len(ts)
    posy=len({t["yr"] for t in ts if True}) and sum(1 for yr in range(y0,y1+1) if sum(x["pnl_usd"] for x in ts if x["yr"]==yr)>0)
    return {"net":net,"dd":dd,"n":n,"posy":posy,"rdd":net/dd if dd>0 else float('inf')}

if MODE=="wf":
    print("\n"+"="*78)
    print("WALK-FORWARD — train 2019-2023 chọn K/W (theo return/DD), test 2024-2026 OOS")
    print("="*78)
    A=run("A")
    Am_tr=split_metrics(A,2019,2023); Am_te=split_metrics(A,2024,2026)
    # select best B by TRAIN return/DD
    cells=[]
    for K in (0.5,1.0,1.5):
        for W in (3,6,12):
            t=run("B",K=K,W=W); tr=split_metrics(t,2019,2023); te=split_metrics(t,2024,2026)
            cells.append((K,W,tr,te))
    cells.sort(key=lambda x:-x[2]["rdd"])
    print(f"\n  TRAIN ranking (by return/DD):")
    for K,W,tr,te in cells:
        print(f"    K={K} W={W:>2}  TRAIN net=${tr['net']:,.0f} DD=${tr['dd']:,.0f} rDD={tr['rdd']:.2f}  |  TEST net=${te['net']:,.0f} DD=${te['dd']:,.0f} rDD={te['rdd']:.2f}")
    bK,bW,btr,bte=cells[0]
    C=run("C"); Cm_tr=split_metrics(C,2019,2023); Cm_te=split_metrics(C,2024,2026)
    print(f"\n  ── OOS TEST 2024-2026 (chọn từ train) ──")
    print(f"    A baseline:        TRAIN rDD={Am_tr['rdd']:.2f}  →  TEST net=${Am_te['net']:,.0f} DD=${Am_te['dd']:,.0f} rDD={Am_te['rdd']:.2f}")
    print(f"    B picked K={bK}/W={bW}: TRAIN rDD={btr['rdd']:.2f}  →  TEST net=${bte['net']:,.0f} DD=${bte['dd']:,.0f} rDD={bte['rdd']:.2f}")
    print(f"    C inv-pyramid:     TRAIN rDD={Cm_tr['rdd']:.2f}  →  TEST net=${Cm_te['net']:,.0f} DD=${Cm_te['dd']:,.0f} rDD={Cm_te['rdd']:.2f}")
    print(f"\n    OOS verdict: B picked có giữ được rDD > A trên TEST không? "
          f"{'CÓ ✅' if bte['rdd']>Am_te['rdd'] else 'KHÔNG ❌'}  (B {bte['rdd']:.2f} vs A {Am_te['rdd']:.2f})")
    sys.exit(0)

print("\n"+"="*78)
print("ENTRY-HANDLING TEST — signal=G1 BTC 4h, SL 2×ATR, maxhold 60 (10d)")
print("="*78)

res=[]
res.append(report(run("A"), "A BASELINE full-entry"))
# B sweep
best_b=None
for K in (0.5,1.0,1.5):
    for W in (3,6,12):
        t=run("B",K=K,W=W)
        r=report(t, f"B PROBE→REACT K={K} W={W}")
        r["K"]=K; r["W"]=W
        if best_b is None or r["net"]>best_b["net"]: best_b=r
res.append(report(run("C"), "C INVERSE-PYRAMID full+½+¼"))

print("\n"+"="*78)
print("SUMMARY vs BASELINE A")
print("="*78)
A=res[0]
print(f"  A baseline:      net=${A['net']:,.0f}  DD=${A['dd']:,.0f}  WR={A['wr']:.0f}%  pos_yrs={A['pos_yrs']}/8")
print(f"  B best(K={best_b['K']},W={best_b['W']}): net=${best_b['net']:,.0f}  DD=${best_b['dd']:,.0f}  WR={best_b['wr']:.0f}%  pos_yrs={best_b['pos_yrs']}/8")
C=res[-1]
print(f"  C inv-pyramid:   net=${C['net']:,.0f}  DD=${C['dd']:,.0f}  WR={C['wr']:.0f}%  pos_yrs={C['pos_yrs']}/8  peakN=${C['peakN']:,.0f}")
print(f"\n  Δnet B-A = ${best_b['net']-A['net']:,.0f}   ΔDD B-A = ${best_b['dd']-A['dd']:,.0f}")
print(f"  Δnet C-A = ${C['net']-A['net']:,.0f}   ΔDD C-A = ${C['dd']-A['dd']:,.0f}")
print(f"  Verdict: judge DOLLARS — B/C chỉ thắng nếu Δnet>0 mà ΔDD không xấu hơn tương ứng.")
