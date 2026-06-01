#!/usr/bin/env python3
"""
backtest-1h-in-4h-context-7y.py — 1h entry signals TRONG 4h trend context

Ý tưởng: dùng 4h filters để xác định "chất lượng thị trường"
         rồi entry theo 1h signal khi context active → nhiều entry hơn, quality vẫn ok

4h Context (LONG bias active khi TẤT CẢ pass):
  - Regime = RANGE (1d)
  - ADX(14) 4h > 20 sticky (2 bars)
  - Price > EMA200 1h
  - ATR 4h percentile > 50th

1h Entry signals (fire khi context active):
  A: 1h RSI cross above 40 (pullback recovery trong uptrend)
  B: 1h Stoch K cross above 30 (oversold recovery)
  C: 1h EMA9 cross above EMA21 (momentum turn)
  D: 1h ATR breakout × 1.0 (small breakout aligned with 4h)
  E: 1h Donchian 10-bar high (mini-breakout)
  F: 1h Hammer (rejection wick, bullish body)
  G: 1h BB lower touch + bullish close (mean rev in trend)
  H: 1h price cross above EMA50 1h (reclaim MA)

Exit: SL = ATR_1h × 2, TP = ATR_1h × [2, 3, 4] OR trailing SL
Max hold: 48h = 48 bars 1h
Cooldown: 4h between entries

Compare vs 4h standalone (S13+S14 in same context): reference
"""
import json, datetime
from collections import defaultdict

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FEE   = 0.05 / 100
WF_CUT = int(datetime.datetime(2023,1,1).timestamp()*1000)

print("Loading data...")
raw = json.load(open(CACHE))
raw.sort(key=lambda x: x["time"])

def agg_tf(bars, ms):
    b = {}
    for c in bars:
        k=c["time"]//ms
        if k not in b:
            b[k]={"time":k*ms,"open":c["open"],"high":c["high"],"low":c["low"],"close":c["close"],"volume":c["volume"]}
        else:
            o=b[k];o["high"]=max(o["high"],c["high"]);o["low"]=min(o["low"],c["low"])
            o["close"]=c["close"];o["volume"]+=c["volume"]
    return [b[k] for k in sorted(b)]

bars1h = agg_tf(raw,  1*3600*1000)
bars4h = agg_tf(raw,  4*3600*1000)
bars1d = agg_tf(raw, 24*3600*1000)
n1h = len(bars1h); n4h = len(bars4h)
c1h = [b["close"] for b in bars1h]
c4h = [b["close"] for b in bars4h]
print(f"1h:{n1h} 4h:{n4h} 1d:{len(bars1d)}")

def ema(xs,p):
    k=2/(p+1);out=[None]*len(xs);e=None
    for i,x in enumerate(xs): e=x if e is None else x*k+e*(1-k);out[i]=e
    return out

def _dm_tr(bars):
    n=len(bars);pdm=[0.0]*n;ndm=[0.0]*n;tr=[0.0]*n
    for i in range(1,n):
        up=bars[i]["high"]-bars[i-1]["high"];dn=bars[i-1]["low"]-bars[i]["low"]
        pdm[i]=up if up>dn and up>0 else 0;ndm[i]=dn if dn>up and dn>0 else 0
        tr[i]=max(bars[i]["high"]-bars[i]["low"],abs(bars[i]["high"]-bars[i-1]["close"]),abs(bars[i]["low"]-bars[i-1]["close"]))
    return pdm,ndm,tr

def adx_wilder(bars,p=14):
    pdm,ndm,tr=_dm_tr(bars);n=len(bars)
    if n<=p+1: return [None]*n
    smTR=sum(tr[1:p+1]);smPDM=sum(pdm[1:p+1]);smNDM=sum(ndm[1:p+1])
    dx_arr=[];adx_val=None;out=[None]*n
    for i in range(p+1,n):
        smTR=smTR-smTR/p+tr[i];smPDM=smPDM-smPDM/p+pdm[i];smNDM=smNDM-smNDM/p+ndm[i]
        pdi=smPDM/smTR*100 if smTR>0 else 0;ndi=smNDM/smTR*100 if smTR>0 else 0
        dx=abs(pdi-ndi)/(pdi+ndi)*100 if (pdi+ndi)>0 else 0;dx_arr.append(dx)
        if len(dx_arr)<p: continue
        elif len(dx_arr)==p: adx_val=sum(dx_arr)/p
        else: adx_val=(adx_val*(p-1)+dx)/p
        out[i]=adx_val
    return out

def atr_wilder(bars,p=14):
    _,_,tr=_dm_tr(bars);n=len(bars);out=[None]*n
    s=sum(tr[1:p+1]);out[p]=s/p
    for i in range(p+1,n): out[i]=(out[i-1]*(p-1)+tr[i])/p
    return out

def rsi_s(closes,n=14):
    out=[None]*len(closes);ag=al=0.0
    for i in range(1,n+1):
        d=closes[i]-closes[i-1]
        if d>0: ag+=d
        else: al-=d
    ag/=n;al/=n;out[n]=100-100/(1+ag/al) if al>0 else 100
    for i in range(n+1,len(closes)):
        d=closes[i]-closes[i-1];g=max(d,0);l=max(-d,0)
        ag=(ag*(n-1)+g)/n;al=(al*(n-1)+l)/n
        out[i]=100-100/(1+ag/al) if al>0 else 100
    return out

def stoch_s(bars,n=14):
    out=[None]*len(bars)
    for i in range(n-1,len(bars)):
        hi=max(b["high"] for b in bars[i-n+1:i+1]);lo=min(b["low"] for b in bars[i-n+1:i+1])
        out[i]=100*(bars[i]["close"]-lo)/(hi-lo) if hi>lo else 50
    return out

def don_hi(bars,n):
    out=[None]*len(bars)
    for i in range(n,len(bars)): out[i]=max(bars[j]["high"] for j in range(i-n,i))
    return out

def bb_s(closes,n=20,k=2.0):
    u=[None]*len(closes);l=[None]*len(closes)
    for i in range(n-1,len(closes)):
        w=closes[i-n+1:i+1];m=sum(w)/n;s=(sum((x-m)**2 for x in w)/n)**0.5
        u[i]=m+k*s;l[i]=m-k*s
    return u,l

def regime_wp(bars1d,persist=3):
    cs=[b["close"] for b in bars1d];n=len(bars1d);raw=["RANGE"]*n
    for i in range(200,n):
        ma200=sum(cs[i-199:i+1])/200;ma50=sum(cs[i-50:i+1])/50
        ar=sum((b["high"]-b["low"])/b["close"] for b in bars1d[i-19:i+1])/20
        if cs[i]<ma200: raw[i]="BEAR"
        elif cs[i]>ma50 and ma50>ma200 and ar>0.04: raw[i]="BULL"
    out=["RANGE"]*n;cur="RANGE";cnt=0;lr="RANGE"
    for i in range(n):
        r=raw[i]
        if r==lr: cnt+=1
        else: cnt=1;lr=r
        if cnt>=persist: cur=r
        out[i]=cur
    return out

print("Computing indicators...")
# 4h indicators
adx4  = adx_wilder(bars4h)
atr4  = atr_wilder(bars4h)
# 1h indicators
atr1h  = atr_wilder(bars1h)
rsi1h  = rsi_s(c1h, 14)
stk1h  = stoch_s(bars1h, 14)
e9_1h  = ema(c1h, 9)
e21_1h = ema(c1h, 21)
e50_1h = ema(c1h, 50)
e200_1h= ema(c1h, 200)
dh10_1h= don_hi(bars1h, 10)
bbu1h, bbl1h = bb_s(c1h, 20, 2.0)
reg1d  = regime_wp(bars1d)
reg_map={}
for i,b in enumerate(bars1d): reg_map[b["time"]//86400000]=reg1d[i]
def get_reg(ts): return reg_map.get(ts//86400000,"RANGE")

# ATR4h percentile check
ATR_LB=90
def atp4h(i):
    return atr4[i]/c4h[i] if atr4[i] and c4h[i] else None
def atp4h_pass(i,pct=0.50):
    if i<ATR_LB+14: return False
    vs=[atp4h(j) for j in range(i-ATR_LB,i) if atp4h(j) is not None]
    if len(vs)<ATR_LB: return False
    cur=atp4h(i); return cur is not None and cur>=sorted(vs)[int(len(vs)*pct)]

# Map 1h index → nearest 4h index
ts4h = [b["time"] for b in bars4h]
def get_4h_idx(ts1h):
    # find which 4h bar this 1h bar belongs to
    k = ts1h // (4*3600*1000)
    # binary search
    lo,hi,idx=0,len(ts4h)-1,0
    while lo<=hi:
        m=(lo+hi)//2
        if ts4h[m]//( 4*3600*1000)<=k: idx=m;lo=m+1
        else: hi=m-1
    return idx

# === 4h CONTEXT CHECK ===
def context_ok_4h(i4h):
    """Returns True if 4h bar i4h has LONG quality context."""
    if i4h < 50: return False
    # Regime
    if get_reg(bars4h[i4h]["time"]) != "RANGE": return False
    # ADX sticky
    adv=adx4[i4h]; adv_p=adx4[i4h-1] if i4h>0 else None
    if adv is None or adv<=20: return False
    if adv_p is None or adv_p<=20: return False
    # ATR percentile
    if not atp4h_pass(i4h, 0.50): return False
    return True

# Precompute 4h context for speed
print("Precomputing 4h context...")
ctx4h = [context_ok_4h(i) for i in range(n4h)]

# Map each 1h bar to its 4h context
print("Mapping 1h → 4h context...")
ctx_at_1h = [False]*n1h
for i1h in range(n1h):
    i4h = get_4h_idx(bars1h[i1h]["time"])
    if 0 <= i4h < n4h:
        # EMA200 1h gate (from 1h series)
        e1h_val = e200_1h[i1h]
        if e1h_val and c1h[i1h] < e1h_val: continue
        ctx_at_1h[i1h] = ctx4h[i4h]

active_1h = sum(ctx_at_1h)
print(f"1h bars with 4h context active: {active_1h}/{n1h} ({active_1h/n1h*100:.1f}%)")

# === 1h SIGNAL FUNCTIONS ===
def signals_1h(i):
    """Return list of signal names that fire at 1h bar i."""
    if not ctx_at_1h[i]: return []
    sigs = []
    c=c1h[i]
    if rsi1h[i] is not None and rsi1h[i-1] is not None:
        if rsi1h[i-1]<40 and rsi1h[i]>=40: sigs.append("A_RSI_x40")
        if rsi1h[i-1]<30 and rsi1h[i]>=30: sigs.append("A2_RSI_x30")
    if stk1h[i] and stk1h[i-1]:
        if stk1h[i-1]<30 and stk1h[i]>=30: sigs.append("B_Stoch_x30")
        if stk1h[i-1]<20 and stk1h[i]>=20: sigs.append("B2_Stoch_x20")
    if e9_1h[i] and e21_1h[i] and e9_1h[i-1] and e21_1h[i-1]:
        if e9_1h[i-1]<=e21_1h[i-1] and e9_1h[i]>e21_1h[i]: sigs.append("C_EMA9x21")
    if atr1h[i] and i>0:
        if c>bars1h[i-1]["close"]+atr1h[i]*1.0: sigs.append("D_ATRbrk1.0")
        if c>bars1h[i-1]["close"]+atr1h[i]*0.7: sigs.append("D2_ATRbrk0.7")
    if dh10_1h[i] and c>dh10_1h[i]: sigs.append("E_Don10")
    # Hammer
    o=bars1h[i]["open"]; hi=bars1h[i]["high"]; lo=bars1h[i]["low"]
    body=abs(c-o); lw=min(c,o)-lo; brange=hi-lo
    if brange>0 and lw>=2*body and lw>=0.6*brange: sigs.append("F_Hammer")
    # BB lower
    if bbl1h[i] and lo<=bbl1h[i] and c>o: sigs.append("G_BB_low")
    # EMA50 cross
    if e50_1h[i] and e50_1h[i-1]:
        if bars1h[i-1]["close"]<=e50_1h[i-1] and c>e50_1h[i]: sigs.append("H_EMA50_cross")
    return sigs

# === BACKTEST ===
SL_M=2.0; MAX_HOLD=48; CD=4  # 4h cooldown between entries

def sim(i1h, tp_m):
    ep=c1h[i1h]; ae=atr1h[i1h]
    if ae is None or ae<=0: return None
    sl=ep-ae*SL_M; tp=ep+ae*tp_m
    for h in range(1,MAX_HOLD+1):
        j=i1h+h
        if j>=n1h: break
        if bars1h[j]["low"]<=sl: return (sl-ep)/ep-2*FEE, h
        if bars1h[j]["high"]>=tp: return (tp-ep)/ep-2*FEE, h
    j2=min(i1h+MAX_HOLD,n1h-1)
    return (c1h[j2]-ep)/ep-2*FEE, MAX_HOLD

def calc_ra(trades):
    if not trades: return None
    r=[t["ret"] for t in trades];m=sum(r)/len(r);sd=(sum((x-m)**2 for x in r)/len(r))**0.5
    return m/sd if sd>0 else 0

print("\nRunning 1h signal backtests in 4h context...")
# Collect all trades per signal
SIG_NAMES = ["A_RSI_x40","A2_RSI_x30","B_Stoch_x30","B2_Stoch_x20",
             "C_EMA9x21","D_ATRbrk1.0","D2_ATRbrk0.7","E_Don10",
             "F_Hammer","G_BB_low","H_EMA50_cross"]
TP_VARIANTS = [2.0, 3.0, 4.0]

all_trades = {s:{tp:[] for tp in TP_VARIANTS} for s in SIG_NAMES}
last_entry = {s: -CD for s in SIG_NAMES}

for i in range(50, n1h-MAX_HOLD):
    fired = signals_1h(i)
    for sig in fired:
        if sig not in SIG_NAMES: continue
        if i - last_entry[sig] < CD: continue
        for tp in TP_VARIANTS:
            r = sim(i, tp)
            if r is None: continue
            ret,hold=r
            ts=bars1h[i]["time"]
            yr=datetime.datetime.utcfromtimestamp(ts/1000).year
            mo=yr*100+datetime.datetime.utcfromtimestamp(ts/1000).month
            all_trades[sig][tp].append({"ret":ret,"hold":hold,"yr":yr,"mo":mo,
                                         "period":"test" if ts>=WF_CUT else "train"})
        last_entry[sig] = i

# === REPORT ===
def report(trades, label):
    if len(trades)<5: return None
    rets=[t["ret"] for t in trades];n_=len(rets)
    m=sum(rets)/n_;sd=(sum((r-m)**2 for r in rets)/n_)**0.5 or 1e-9
    ra=m/sd;wr=sum(1 for r in rets if r>0)/n_*100
    wins=[r for r in rets if r>0];losses=[r for r in rets if r<=0]
    rr=(sum(wins)/len(wins) if wins else 0)/abs(sum(losses)/len(losses) if losses else 1e-9)
    by_yr=defaultdict(float)
    for t in trades: by_yr[t["yr"]]+=t["ret"]
    stab=sum(1 for v in by_yr.values() if v>0)
    by_mo=defaultdict(list)
    for t in trades: by_mo[t["mo"]].append(t["ret"])
    win_mo=sum(1 for vs in by_mo.values() if sum(vs)>0)
    mo_pct=win_mo/len(by_mo) if by_mo else 0
    train=[t for t in trades if t["period"]=="train"]
    test =[t for t in trades if t["period"]=="test"]
    ra_tr=calc_ra(train);ra_te=calc_ra(test)
    decay=(ra_te-ra_tr)/abs(ra_tr)*100 if ra_tr else None
    yr_str=" ".join(f"{y}:{by_yr[y]*100:+.0f}%" for y in sorted(by_yr))
    flag="✅" if ra>=0.20 and mo_pct>=0.50 and stab>=4 else ("⚠️" if ra>=0.10 else "✗")
    print(f"  {label:50s} n={n_:4d} RA={ra:+.3f} WR={wr:.0f}% R:R={rr:.2f} stab={stab}/{len(by_yr)} mo={win_mo}/{len(by_mo)}({mo_pct*100:.0f}%) {flag}")
    if flag in ("✅","⚠️"):
        print(f"    yr: {yr_str}")
        if ra_tr and ra_te:
            df="✅" if decay and decay>=-40 else "⚠️"
            print(f"    WF: TRAIN RA={ra_tr:+.3f}(n={len(train)}) TEST RA={ra_te:+.3f}(n={len(test)}) decay={decay:+.0f}% {df}")
    return {"label":label,"n":n_,"ra":ra,"wr":wr,"rr":rr,"stab":stab,"stab_n":len(by_yr),
            "mo_pct":mo_pct,"win_mo":win_mo,"total_mo":len(by_mo),"ra_tr":ra_tr,"ra_te":ra_te,"decay":decay}

results = []
print(f"\n{'='*75}")
print(f"  1h SIGNALS IN 4h CONTEXT — per signal × TP variant")
print(f"  4h context: RANGE + ADX>20 + EMA200 1h + ATR50th")
print(f"  SL: ATR_1h×{SL_M}  Max hold: {MAX_HOLD}h  Cooldown: {CD}h")
print(f"{'='*75}")
for sig in SIG_NAMES:
    for tp in TP_VARIANTS:
        trades = all_trades[sig][tp]
        r = report(trades, f"{sig}_TP{tp}")
        if r: results.append(r)

# === FINAL RANKING ===
print(f"\n{'='*75}")
print("RANKING — sorted by TEST RA (out-of-sample 2023+)")
print(f"{'='*75}")
accepted = [r for r in results if r["ra"]>=0.15 and r["n"]>=20]
accepted.sort(key=lambda x: (x["ra_te"] or -99), reverse=True)
if accepted:
    print(f"\n  {'Signal':50s}  {'n':>5}  {'RA':>7}  {'TEST_RA':>8}  {'mo%':>5}  {'stab':>5}")
    for r in accepted[:15]:
        print(f"  {r['label']:50s}  {r['n']:>5}  {r['ra']:>+7.3f}  {(r['ra_te'] or 0):>+8.3f}  "
              f"{r['mo_pct']*100:>4.0f}%  {r['stab']}/{r.get('stab_n','?')}")

    best = accepted[0]
    print(f"\n  ⭐ BEST: {best['label']}")
    print(f"     RA={best['ra']:+.3f}  TEST_RA={best['ra_te']:+.3f}  n={best['n']}/7y (~{best['n']//7}/yr)")
    print(f"     Monthly win: {best['win_mo']}/{best['total_mo']} ({best['mo_pct']*100:.0f}%)")

    print(f"\n  Reference — current hedge01 (4h S13+S14):")
    print(f"     RA=+0.515  TEST_RA=+0.460  n=107/7y (~15/yr)  stab=5/6")
else:
    print("  ⚠️  Không có signal nào đủ mạnh (RA>=0.15, n>=20)")
    top3 = sorted([r for r in results if r], key=lambda x:x["ra"],reverse=True)[:5]
    for r in top3:
        print(f"    {r['label']:50s} RA={r['ra']:+.3f} n={r['n']}")

print(f"\n  Total combinations tested: {len(results)}")
