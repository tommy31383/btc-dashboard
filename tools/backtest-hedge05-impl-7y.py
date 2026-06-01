#!/usr/bin/env python3
"""
backtest-hedge05-impl-7y.py — Backtest ĐÚNG logic hedge05.ts đã implement
(regime-first daily + DCA/cut/reverse), KHÔNG phải grid concept cũ.

Replicate faithfully:
  Entry: 1 lệnh/ngày. BULL→ATR breakout/Donchian 4h; RANGE→BB/RSI/Stoch 1h + EMA200_1h gate;
         BEAR→RSI cross<60 / ATR breakdown 4h short; fallback ≥20h UTC → close>EMA9 4h LONG.
  Manage (mỗi 1h bar, ATR_4h tại entry): BULL trail ×3 / RANGE-BEAR fixed TP ±2×ATR /
         hard SL ±4×ATR / time stop 48h / regime reverse (cut+flip) / soft flip (cut) /
         DCA ×2 (loss -1/-2×ATR, regime unchanged) — close+reopen fee model như TS.
  Regime: 1d 3-bar persistence.
Capital $100k, FEE 0.05%/side. Per-campaign return% = PnL_usd / capital_deployed, net fees.
"""
import json, datetime, sys
from collections import defaultdict

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FEE   = 0.05 / 100

# hedge05 constants (mirror hedge05.ts)
BASE_QTY      = 0.003
DCA_MAX       = 0 if "--nodca" in sys.argv else 2   # --nodca: disable DCA (test rescue thesis)
HARD_SL_MULT  = 4.0
RANGE_TP_MULT = 2.0
BULL_TRAIL_MULT = 3.0
BULL_TP_MULT  = 5.0
TIME_STOP_H   = 48          # 48h in 1h bars
REVERSE_CD_H  = 2
DEADLINE_HOUR = 20
DCA1_ATR = 1.0
DCA2_ATR = 2.0
CUT_ATR  = 4.0

raw = json.load(open(CACHE)); raw.sort(key=lambda x: x["time"])

def agg(bars, ms):
    b = {}
    for c in bars:
        k = c["time"] // ms
        if k not in b:
            b[k] = {"time": k*ms, "open": c["open"], "high": c["high"], "low": c["low"], "close": c["close"], "volume": c["volume"]}
        else:
            o = b[k]; o["high"]=max(o["high"],c["high"]); o["low"]=min(o["low"],c["low"]); o["close"]=c["close"]; o["volume"]+=c["volume"]
    return [b[k] for k in sorted(b)]

bars1h = agg(raw, 3600*1000); bars4h = agg(raw, 4*3600*1000); bars1d = agg(raw, 86400*1000)
n1h = len(bars1h); n4h = len(bars4h)
c1h = [b["close"] for b in bars1h]; c4h = [b["close"] for b in bars4h]

def ema(xs, p):
    k=2/(p+1); out=[None]*len(xs); e=None
    for i,x in enumerate(xs): e=x if e is None else x*k+e*(1-k); out[i]=e
    return out
def _dtr(bars):
    n=len(bars); pdm=[0.]*n; ndm=[0.]*n; tr=[0.]*n
    for i in range(1,n):
        up=bars[i]["high"]-bars[i-1]["high"]; dn=bars[i-1]["low"]-bars[i]["low"]
        pdm[i]=up if up>dn and up>0 else 0; ndm[i]=dn if dn>up and dn>0 else 0
        tr[i]=max(bars[i]["high"]-bars[i]["low"], abs(bars[i]["high"]-bars[i-1]["close"]), abs(bars[i]["low"]-bars[i-1]["close"]))
    return pdm,ndm,tr
def atr_w(bars, p=14):
    _,_,tr=_dtr(bars); n=len(bars); out=[None]*n
    s=sum(tr[1:p+1]); out[p]=s/p
    for i in range(p+1,n): out[i]=(out[i-1]*(p-1)+tr[i])/p
    return out
def rsi_s(cls, n=14):
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
def stoch_s(bars, n=14):
    out=[None]*len(bars)
    for i in range(n-1,len(bars)):
        hi=max(b["high"] for b in bars[i-n+1:i+1]); lo=min(b["low"] for b in bars[i-n+1:i+1])
        out[i]=100*(bars[i]["close"]-lo)/(hi-lo) if hi>lo else 50
    return out
def bb_lower(cls, n=20, k=2.):
    l=[None]*len(cls)
    for i in range(n-1,len(cls)):
        w=cls[i-n+1:i+1]; m=sum(w)/n; s=(sum((x-m)**2 for x in w)/n)**0.5
        l[i]=m-k*s
    return l
def don_hi(bars, p=20):
    out=[None]*len(bars)
    for i in range(p,len(bars)): out[i]=max(bars[j]["high"] for j in range(i-p,i))
    return out
def vol_ma(bars, p=10):
    out=[None]*len(bars)
    for i in range(p-1,len(bars)): out[i]=sum(bars[j]["volume"] for j in range(i-p+1,i+1))/p
    return out
def regime_wp(bars1d, persist=3):
    cs=[b["close"] for b in bars1d]; n=len(bars1d); rw=["RANGE"]*n
    for i in range(200,n):
        ma200=sum(cs[i-199:i+1])/200; ma50=sum(cs[i-50:i+1])/50
        ar=sum((b["high"]-b["low"])/b["close"] for b in bars1d[i-19:i+1])/20
        if cs[i]<ma200: rw[i]="BEAR"
        elif cs[i]>ma50 and ma50>ma200 and ar>0.04: rw[i]="BULL"
    out=["RANGE"]*n; cur="RANGE"; cnt=0; lr="RANGE"
    for i in range(n):
        r=rw[i]
        if r==lr: cnt+=1
        else: cnt=1; lr=r
        if cnt>=persist: cur=r
        out[i]=cur
    return out

print("Computing indicators...")
atr4=atr_w(bars4h); e50_4h=ema(c4h,50); e200_4h=ema(c4h,200)
e9_4h=ema(c4h,9); dh20_4h=don_hi(bars4h,20); vma10_4h=vol_ma(bars4h,10)
atr1h=atr_w(bars1h); rsi1h=rsi_s(c1h); stk1h=stoch_s(bars1h)
e200_1h=ema(c1h,200); bbl1h=bb_lower(c1h)
reg1d=regime_wp(bars1d); reg_map={}
for i,b in enumerate(bars1d): reg_map[b["time"]//86400000]=reg1d[i]

ts4h=[b["time"] for b in bars4h]
def reg_at(ts): return reg_map.get(ts//86400000, "RANGE")
def idx4h(ts):
    k=ts//(4*3600*1000); lo,hi,idx=0,len(ts4h)-1,0
    while lo<=hi:
        m=(lo+hi)//2
        if ts4h[m]//(4*3600*1000)<=k: idx=m; lo=m+1
        else: hi=m-1
    return idx
def utc_day(ts):
    d=datetime.datetime.utcfromtimestamp(ts/1000)
    return d.year*10000+d.month*100+d.day

# ── Signal detection at a 1h bar i ──────────────────────────────────────────────
def signal_at(i, regime):
    """Return (side, ) if a fresh entry signal fires given regime. None = no signal."""
    ts=bars1h[i]["time"]; j4=idx4h(ts); hr=datetime.datetime.utcfromtimestamp(ts/1000).hour
    if j4 < 21 or atr4[j4] is None: return None
    if regime=="BEAR":
        # short: RSI cross<60 OR ATR breakdown 4h
        rsi_cross = rsi1h[i] is not None and rsi1h[i-1] is not None and rsi1h[i-1]>=60 and rsi1h[i]<60
        brk = c4h[j4] < c4h[j4-1] - atr4[j4]*1.2
        if rsi_cross or brk: return "SHORT"
        return None
    if regime=="BULL":
        vmok = vma10_4h[j4] is not None and bars4h[j4]["volume"]>=vma10_4h[j4]*1.2
        brk  = c4h[j4] > c4h[j4-1] + atr4[j4]*1.2
        if brk and vmok: return "LONG"
        if dh20_4h[j4] is not None and c4h[j4]>dh20_4h[j4]: return "LONG"
        # fallback
        if hr>=DEADLINE_HOUR and e9_4h[j4] is not None and c4h[j4]>e9_4h[j4]: return "LONG"
        return None
    # RANGE
    if e200_1h[i] is not None and c1h[i] < e200_1h[i]: return None  # EMA200 1h gate
    bb = bbl1h[i] is not None and bars1h[i]["low"]<=bbl1h[i] and c1h[i]>bars1h[i]["open"]
    rc = rsi1h[i] is not None and rsi1h[i-1] is not None and rsi1h[i-1]<40 and rsi1h[i]>=40
    sc = stk1h[i] is not None and stk1h[i-1] is not None and stk1h[i-1]<20 and stk1h[i]>=20
    if bb or rc or sc: return "LONG"
    if hr>=DEADLINE_HOUR and e9_4h[j4] is not None and c4h[j4]>e9_4h[j4]: return "LONG"
    return None

# ── Simulate ────────────────────────────────────────────────────────────────────
campaigns=[]   # closed campaign results
camp=None      # active: {side, avg, qty, atr0, open_i, dca, regAt, hwm, fees, ts_open}
last_entry_day=-1
last_reverse_i=-10**9
pending_reverse=None   # side to open
n_dca_total=0; n_reverse_total=0; n_cut_total=0

def open_campaign(i, side, regime):
    global camp, last_entry_day
    ts=bars1h[i]["time"]; j4=idx4h(ts); a=atr4[j4]
    if a is None or a<=0: return False
    px=c1h[i]
    camp={"side":side,"avg":px,"qty":BASE_QTY,"atr0":a,"open_i":i,"dca":0,
          "regAt":regime,"hwm":px,"fees":FEE*px*BASE_QTY,"ts_open":ts,
          "entry_px":px}
    last_entry_day=utc_day(ts)
    return True

def close_campaign(i, exit_px, reason):
    global camp, campaigns
    c=camp; side=c["side"]
    c["fees"] += FEE*exit_px*c["qty"]   # close fee
    pnl = c["qty"]*(exit_px-c["avg"]) if side=="LONG" else c["qty"]*(c["avg"]-exit_px)
    pnl_usd = pnl - c["fees"]
    deployed = c["avg"]*c["qty"]
    ret = pnl_usd/deployed
    ts=bars1h[i]["time"]; d=datetime.datetime.utcfromtimestamp(ts/1000)
    campaigns.append({"ret":ret,"pnl_usd":pnl_usd,"mo":d.year*100+d.month,"yr":d.year,
                      "reason":reason,"dca":c["dca"],"side":side,"deployed":deployed})
    camp=None

WARM=210*24  # ~210 days of 1h bars for regime warmup
for i in range(WARM, n1h):
    bar=bars1h[i]; ts=bar["time"]; px=bar["close"]; day=utc_day(ts)
    regime=reg_at(ts)

    # ── Manage open campaign ─────────────────────────────────────────────────
    if camp is not None:
        c=camp; side=c["side"]; avg=c["avg"]; atr0=c["atr0"]; regAt=c["regAt"]
        loss = (avg-px)/atr0 if side=="LONG" else (px-avg)/atr0
        # flip classification
        flip="none"
        if regAt!=regime:
            if side=="LONG":  flip="reverse" if regime=="BEAR" else "soft"
            else:             flip="reverse" if regime!="BEAR" else "soft"
        closed=False
        # 1. BULL trailing (LONG)
        if regAt=="BULL" and side=="LONG":
            if bar["high"]>c["hwm"]: c["hwm"]=bar["high"]
            trail=c["hwm"]-atr0*BULL_TRAIL_MULT
            if bar["low"]<=trail:
                close_campaign(i, trail, "SL"); closed=True
        # 2. RANGE/BEAR fixed TP
        if not closed and regAt in ("RANGE","BEAR"):
            if side=="LONG":
                tp=avg+atr0*RANGE_TP_MULT
                if bar["high"]>=tp: close_campaign(i, tp, "TP"); closed=True
            else:
                tp=avg-atr0*RANGE_TP_MULT
                if bar["low"]<=tp: close_campaign(i, tp, "TP"); closed=True
        # 3. Hard SL
        if not closed:
            if side=="LONG":
                sl=avg-atr0*CUT_ATR
                if bar["low"]<=sl: close_campaign(i, sl, "HARDSL"); closed=True
            else:
                sl=avg+atr0*CUT_ATR
                if bar["high"]>=sl: close_campaign(i, sl, "HARDSL"); closed=True
        # 4. Time stop
        if not closed and (i - c["open_i"]) >= TIME_STOP_H:
            close_campaign(i, px, "TIME"); closed=True
        # 5. Reverse
        if not closed and flip=="reverse":
            n_reverse_total+=1
            close_campaign(i, px, "REVERSE")
            pending_reverse = "SHORT" if side=="LONG" else "LONG"
            last_reverse_i=i
            closed=True
        # 6. Soft flip
        if not closed and flip=="soft":
            n_cut_total+=1
            close_campaign(i, px, "CUT"); closed=True
        # 7. DCA (close+reopen fee model)
        if not closed:
            thr = DCA1_ATR if c["dca"]==0 else DCA2_ATR
            if c["dca"]<DCA_MAX and loss>=thr:
                oldq=c["qty"]; newq=oldq+BASE_QTY
                c["fees"] += FEE*px*oldq          # close old (TS close-reopen)
                c["fees"] += FEE*px*newq          # reopen new total
                c["avg"]=(oldq*avg+BASE_QTY*px)/newq
                c["qty"]=newq; c["dca"]+=1; n_dca_total+=1
        continue  # one action per bar while managing

    # ── Pending reverse: open opposite immediately ──────────────────────────
    if pending_reverse is not None:
        if open_campaign(i, pending_reverse, regime):
            pending_reverse=None
        continue

    # ── Reverse cooldown ────────────────────────────────────────────────────
    if i - last_reverse_i < REVERSE_CD_H: continue
    # ── Daily constraint ────────────────────────────────────────────────────
    if last_entry_day == day: continue
    # ── Fresh entry signal ──────────────────────────────────────────────────
    sig = signal_at(i, regime)
    if sig is not None:
        open_campaign(i, sig, regime)

# Close trailing open campaign at end
if camp is not None:
    close_campaign(n1h-1, c1h[-1], "EOD")

# ── Report ───────────────────────────────────────────────────────────────────
by_mo=defaultdict(list); by_yr=defaultdict(list)
for c in campaigns: by_mo[c["mo"]].append(c); by_yr[c["yr"]].append(c)

MN=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
print("="*92)
print("HEDGE05 (implemented logic) — Regime-First Daily + DCA/cut/reverse — 7y")
print("="*92)
print(f"\n{'Yr Mon':10s} {'n':>3s} {'ROI%':>8s} {'TP':>3s} {'SL':>3s} {'CUT':>3s} {'REV':>3s} {'DCA':>3s}  St")
print("-"*92)
yr_sum=defaultdict(lambda:{"n":0,"roi":0,"win_mo":0,"tot_mo":0})
for mo in sorted(by_mo):
    cs=by_mo[mo]; yr=mo//100; mn=mo%100
    roi=sum(c["ret"] for c in cs)*100
    tp=sum(1 for c in cs if c["reason"]=="TP"); sl=sum(1 for c in cs if c["reason"] in ("SL","HARDSL"))
    cut=sum(1 for c in cs if c["reason"]=="CUT"); rev=sum(1 for c in cs if c["reason"]=="REVERSE")
    dca=sum(c["dca"] for c in cs)
    st="OK" if roi>0 else "XX"
    print(f"  {yr:4d} {MN[mn-1]:>3s} {len(cs):>3d} {roi:>+7.1f}% {tp:>3d} {sl:>3d} {cut:>3d} {rev:>3d} {dca:>3d}  {st}")
    s=yr_sum[yr]; s["n"]+=len(cs); s["roi"]+=roi; s["win_mo"]+=(1 if roi>0 else 0); s["tot_mo"]+=1
print("-"*92)
print(f"\n{'Year':>6s} {'n/yr':>5s} {'ROI%':>8s} {'WinMonths':>11s}")
for yr in sorted(yr_sum):
    s=yr_sum[yr]
    print(f"  {yr:4d} {s['n']:>5d} {s['roi']:>+7.1f}% {s['win_mo']:>4d}/{s['tot_mo']:<2d} ({s['win_mo']/s['tot_mo']*100:.0f}%)")

rets=[c["ret"] for c in campaigns]; n=len(rets)
mean=sum(rets)/n; sd=(sum((r-mean)**2 for r in rets)/n)**0.5 or 1e-9
ra=mean/sd; wr=sum(1 for r in rets if r>0)/n*100
wins=[r for r in rets if r>0]; losses=[r for r in rets if r<=0]
rr=(sum(wins)/len(wins) if wins else 0)/abs(sum(losses)/len(losses) if losses else 1e-9)
yrs=len(by_yr); stab=sum(1 for yr in by_yr if sum(c["ret"] for c in by_yr[yr])>0)
total_mo=len(by_mo); win_mo=sum(1 for mo in by_mo if sum(c["ret"] for c in by_mo[mo])>0)
total_fees=sum((c["deployed"]*0+ (c.get("fees") or 0)) for c in campaigns) if False else None
print(f"\n{'='*92}")
print(f"  n={n} ({n//yrs}/yr)  WR={wr:.0f}%  R:R={rr:.2f}  RA={ra:.3f}")
print(f"  ROI sum={sum(rets)*100:+.1f}%  per-campaign avg={mean*100:+.2f}%")
print(f"  Yearly stab={stab}/{yrs}  Monthly win={win_mo}/{total_mo} ({win_mo/total_mo*100:.0f}%)")
# reason + DCA breakdown
from collections import Counter
rc=Counter(c["reason"] for c in campaigns)
print(f"  Exits: " + "  ".join(f"{k}={v}" for k,v in sorted(rc.items(), key=lambda x:-x[1])))
print(f"  Total DCA adds={n_dca_total}  Reverses={n_reverse_total}  Cuts={n_cut_total}")
dca_camps=[c for c in campaigns if c["dca"]>0]
if dca_camps:
    dca_wr=sum(1 for c in dca_camps if c["ret"]>0)/len(dca_camps)*100
    print(f"  Campaigns w/ DCA: {len(dca_camps)} ({len(dca_camps)/n*100:.0f}%)  their WR={dca_wr:.0f}%  their ROI={sum(c['ret'] for c in dca_camps)*100:+.1f}%")
# walk-forward
cut_ts=datetime.datetime(2023,1,1).year
tr=[c for c in campaigns if c["yr"]<2023]; te=[c for c in campaigns if c["yr"]>=2023]
def ra_of(cs):
    if len(cs)<5: return None
    r=[c["ret"] for c in cs]; m=sum(r)/len(r); s=(sum((x-m)**2 for x in r)/len(r))**0.5
    return m/s if s>0 else 0
print(f"  Walk-forward: TRAIN(2019-22) RA={ra_of(tr):.3f} (n={len(tr)})  TEST(2023-26) RA={ra_of(te):.3f} (n={len(te)})")
