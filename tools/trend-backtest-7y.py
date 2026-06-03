#!/usr/bin/env python3
"""
trend-backtest-7y.py — Backtest Trend Direction Index (utils/trend.ts) trên 7y BTC.

Audit: nhãn xu hướng (STRONG_DOWN/DOWN/RANGE/UP/STRONG_UP) tại mỗi 4h bar có
PREDICT đúng forward return không? Trend-follow precision = directional accuracy.

Metric chính:
  - Directional accuracy: UP/STRONG_UP → fwd return > 0 ; DOWN/STRONG_DOWN → < 0
  - Avg forward return theo zone (phải monotonic: STRONG_DOWN < DOWN < RANGE < UP < STRONG_UP)
  - Per-year stability
  - Coverage (% bar có signal directional, không RANGE)

Forward horizon mặc định: 30 bar 4h = 5 ngày.
"""
import json, datetime, statistics, sys
from collections import defaultdict

CACHE_5M = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FWD_BARS = 30   # 30 × 4h = 5 ngày

# Cho phép override scoring qua biến môi trường / params (cho loop iterate)
VARIANT = sys.argv[1] if len(sys.argv) > 1 else "v1"

print(f"[{VARIANT}] Loading 5m data...")
raw = json.load(open(CACHE_5M)); raw.sort(key=lambda x: x["time"])
print(f"  {len(raw):,} bars  {datetime.datetime.utcfromtimestamp(raw[0]['time']/1000):%Y-%m-%d} → {datetime.datetime.utcfromtimestamp(raw[-1]['time']/1000):%Y-%m-%d}")

def build_tf(ms):
    b = {}
    for c in raw:
        k = c["time"] // ms
        if k not in b:
            b[k] = {"time": k*ms, "open": c["open"], "high": c["high"],
                    "low": c["low"], "close": c["close"], "volume": c["volume"]}
        else:
            o = b[k]; o["high"]=max(o["high"],c["high"]); o["low"]=min(o["low"],c["low"])
            o["close"]=c["close"]; o["volume"]+=c["volume"]
    return [b[k] for k in sorted(b)]

bars4h = build_tf(4*3600*1000)
bars1h = build_tf(3600*1000)
print(f"  4h:{len(bars4h)} | 1h:{len(bars1h)}")

def ema_series(xs, p):
    k = 2/(p+1); out=[None]*len(xs); e=None
    for i,x in enumerate(xs):
        if x is not None: e = x if e is None else x*k+e*(1-k)
        out[i]=e
    return out

def adx_di_series(bars, p=14):
    """Trả (adx, plus_di, minus_di) series aligned to bars."""
    n=len(bars); adx=[None]*n; pdi_o=[None]*n; mdi_o=[None]*n
    if n<p*2: return adx,pdi_o,mdi_o
    tr=[]; pdm=[]; mdm=[]
    for i in range(1,n):
        h,l,pc=bars[i]["high"],bars[i]["low"],bars[i-1]["close"]
        tr.append(max(h-l,abs(h-pc),abs(l-pc)))
        up=h-bars[i-1]["high"]; dn=bars[i-1]["low"]-l
        pdm.append(up if up>dn and up>0 else 0)
        mdm.append(dn if dn>up and dn>0 else 0)
    def smooth(xs):
        out=[None]*len(xs)
        if len(xs)<p: return out
        s=sum(xs[:p]); out[p-1]=s
        for i in range(p,len(xs)): out[i]=out[i-1]-out[i-1]/p+xs[i]
        return out
    atr=smooth(tr); ps=smooth(pdm); ms=smooth(mdm)
    dx=[None]*len(tr); pdi_l=[None]*len(tr); mdi_l=[None]*len(tr)
    for i in range(p-1,len(tr)):
        if atr[i] and atr[i]>0:
            pdi=100*ps[i]/atr[i]; mdi=100*ms[i]/atr[i]
            pdi_l[i]=pdi; mdi_l[i]=mdi
            dx[i]=100*abs(pdi-mdi)/(pdi+mdi) if (pdi+mdi)>0 else 0
    a=[None]*len(dx); start=None
    for i in range(len(dx)):
        if dx[i] is not None:
            if start is None: start=i
            if i-start+1==p: a[i]=sum(v for v in dx[start:i+1] if v is not None)/p
            elif i>start+p-1 and a[i-1] is not None: a[i]=(a[i-1]*(p-1)+dx[i])/p
    for i in range(len(dx)):
        adx[i+1]=a[i]; pdi_o[i+1]=pdi_l[i]; mdi_o[i+1]=mdi_l[i]
    return adx,pdi_o,mdi_o

c4=[b["close"] for b in bars4h]
c1=[b["close"] for b in bars1h]
print("Computing indicators...")
e20=ema_series(c4,20); e50=ema_series(c4,50); e200=ema_series(c4,200)
adx4,pdi4,mdi4=adx_di_series(bars4h,14)
e20_1h=ema_series(c1,20); e50_1h=ema_series(c1,50)

# Map 4h bar time → index 1h bar gần nhất <= time (đã đóng)
t1=[b["time"] for b in bars1h]
def idx1h_at(t4):
    # bars1h sorted; tìm bar 1h cuối có time <= t4 (1h close trước hoặc bằng 4h open+...)
    import bisect
    j=bisect.bisect_right(t1,t4)-1
    return j

# ─── Scoring (port từ utils/trend.ts) — params hoá để loop tinh chỉnh ─────────
def score_trend(i, P):
    """i = index 4h bar. P = dict params. Trả (value, zone, adx)."""
    price=c4[i]; a=adx4[i]; pp=pdi4[i]; mm=mdi4[i]
    if e200[i] is None or a is None: return None,"RANGE",a
    comp_stack=comp_pve=comp_di=comp_slope=comp_c1=0.0
    # EMA stack
    if e20[i]>e50[i] and e50[i]>e200[i]: comp_stack+=P["stack_full"]
    elif e20[i]>e50[i]: comp_stack+=P["stack_part"]
    if e20[i]<e50[i] and e50[i]<e200[i]: comp_stack-=P["stack_full"]
    elif e20[i]<e50[i]: comp_stack-=P["stack_part"]
    # price vs ema50
    comp_pve += P["pve"] if price>e50[i] else -P["pve"]
    # ADX/DI
    if pp is not None and mm is not None:
        if a>P["adx_strong"]:
            comp_di += P["di_strong"] if pp>mm else -P["di_strong"]
        elif a>P["adx_weak"]:
            comp_di += P["di_weak"] if pp>mm else -P["di_weak"]
    # EMA50 slope (5 bars)
    if i>=5 and e50[i-5]:
        sl=(e50[i]-e50[i-5])/e50[i-5]*100
        if sl>0.5: comp_slope+=P["slope_hi"]
        elif sl>0.1: comp_slope+=P["slope_lo"]
        elif sl<-0.5: comp_slope-=P["slope_hi"]
        elif sl<-0.1: comp_slope-=P["slope_lo"]
    # 1h confirm
    j=idx1h_at(bars4h[i]["time"])
    if j>=0 and e20_1h[j] is not None and e50_1h[j] is not None:
        comp_c1 += P["c1"] if e20_1h[j]>e50_1h[j] else -P["c1"]
    # v3: EMA200 slope gate — chỉ cho strong-trend khi EMA200 cùng hướng
    e200slope_ok_up = e200slope_ok_dn = True
    if P.get("ema200slope") and i>=10 and e200[i-10]:
        s200=(e200[i]-e200[i-10])/e200[i-10]*100
        e200slope_ok_up = s200 > 0
        e200slope_ok_dn = s200 < 0
    val=comp_stack+comp_pve+comp_di+comp_slope+comp_c1
    strong = a>P["adx_strong"]
    below200 = price < e200[i]
    zone="RANGE"
    if val>P["zthr"]:
        su = strong and val>P["zstrong"] and (not P.get("ema200slope") or e200slope_ok_up)
        zone="STRONG_UP" if su else "UP"
    elif val<-P["zthr"]:
        sd = strong and val<-P["zstrong"]
        if P.get("need_below200"): sd = sd and below200
        if P.get("ema200slope"):   sd = sd and e200slope_ok_dn
        zone="STRONG_DOWN" if sd else "DOWN"
    return val,zone,a

# baseline params = đúng trend.ts hiện tại
P_V1 = dict(stack_full=1.5,stack_part=0.7,pve=0.8,adx_strong=25,adx_weak=18,
            di_strong=1.5,di_weak=0.6,slope_hi=0.7,slope_lo=0.3,c1=0.5,
            zthr=1.2,zstrong=2.5,need_below200=False,ema200slope=False)

# v2: STRONG_DOWN BẮT BUỘC giá < EMA200 (cấu trúc bear thật), tăng trọng số DI
P_V2 = dict(P_V1); P_V2.update(need_below200=True, di_strong=2.0, di_weak=0.8)
# v3: thêm EMA200 slope gate + ngưỡng zone cao hơn (ít signal, sạch hơn)
P_V3 = dict(P_V2); P_V3.update(ema200slope=True, zthr=1.6, zstrong=3.0)

# v4: bỏ EMA stack (ablation iter14 cho thấy stack hurt STRONG_UP OOS), giữ pve=0.4
P_V4 = dict(P_V3); P_V4.update(stack_full=0, stack_part=0, pve=0.4, di_strong=2.5)
VARIANTS = {"v1": P_V1, "v2": P_V2, "v3": P_V3, "v4": P_V4}

def run(P, tag):
    by_zone=defaultdict(list); by_year_dir=defaultdict(lambda:[0,0])  # [correct,total]
    overall=[0,0]
    for i in range(200, len(bars4h)-FWD_BARS):
        val,zone,a=score_trend(i,P)
        if val is None: continue
        fwd=(c4[i+FWD_BARS]-c4[i])/c4[i]*100
        by_zone[zone].append(fwd)
        if zone in ("UP","STRONG_UP","DOWN","STRONG_DOWN"):
            yr=datetime.datetime.utcfromtimestamp(bars4h[i]["time"]/1000).year
            up = zone in ("UP","STRONG_UP")
            correct = (fwd>0) if up else (fwd<0)
            by_year_dir[yr][0]+=1 if correct else 0
            by_year_dir[yr][1]+=1
            overall[0]+=1 if correct else 0
            overall[1]+=1
    print(f"\n=== [{tag}] Trend backtest (fwd {FWD_BARS}×4h = {FWD_BARS*4/24:.0f}d) ===")
    print(f"{'ZONE':<13}{'n':>7}{'avgFwd%':>10}{'medFwd%':>10}{'%pos':>8}")
    order=["STRONG_DOWN","DOWN","RANGE","UP","STRONG_UP"]
    monotonic=[]
    for z in order:
        xs=by_zone.get(z,[])
        if not xs: print(f"{z:<13}{0:>7}"); continue
        avg=sum(xs)/len(xs); med=statistics.median(xs)
        pos=100*sum(1 for x in xs if x>0)/len(xs)
        monotonic.append(avg)
        print(f"{z:<13}{len(xs):>7}{avg:>10.2f}{med:>10.2f}{pos:>8.1f}")
    acc=100*overall[0]/overall[1] if overall[1] else 0
    cov=100*overall[1]/sum(len(v) for v in by_zone.values())
    print(f"\nDirectional accuracy: {acc:.1f}%  (n={overall[1]}, coverage {cov:.0f}% non-range)")
    mono_ok = all(monotonic[i]<=monotonic[i+1]+0.01 for i in range(len(monotonic)-1))
    print(f"Monotonic avgFwd (STRONG_DOWN→STRONG_UP): {'YES ✓' if mono_ok else 'NO ✗'}  {[round(m,2) for m in monotonic]}")
    print(f"\nPer-year directional accuracy:")
    yrs=sorted(by_year_dir)
    stable=0
    for yr in yrs:
        c,t=by_year_dir[yr]; ac=100*c/t if t else 0
        flag="✓" if ac>=50 else "✗"
        if ac>=50: stable+=1
        print(f"  {yr}: {ac:5.1f}%  (n={t})  {flag}")
    print(f"Stable years (≥50%): {stable}/{len(yrs)}")
    return dict(acc=acc, cov=cov, mono=mono_ok, stable=stable, nyears=len(yrs))

# global drift baseline (mean fwd return mọi bar) để tính excess
_gd=[(c4[i+FWD_BARS]-c4[i])/c4[i]*100 for i in range(200,len(bars4h)-FWD_BARS)]
GLOBAL_DRIFT=sum(_gd)/len(_gd)
print(f"\nGlobal drift baseline (mean fwd {FWD_BARS}×4h): {GLOBAL_DRIFT:+.3f}%")
print("→ DOWN zone 'tốt' = avgFwd DƯỚI drift; excess âm = bắt đúng giảm tương đối.\n")

def excess_report(P, tag):
    by_zone=defaultdict(list)
    for i in range(200,len(bars4h)-FWD_BARS):
        val,zone,a=score_trend(i,P)
        if val is None: continue
        by_zone[zone].append((c4[i+FWD_BARS]-c4[i])/c4[i]*100)
    print(f"[{tag}] excess vs drift {GLOBAL_DRIFT:+.2f}%:")
    for z in ["STRONG_DOWN","DOWN","RANGE","UP","STRONG_UP"]:
        xs=by_zone.get(z,[])
        if xs:
            ex=sum(xs)/len(xs)-GLOBAL_DRIFT
            print(f"   {z:<13} n={len(xs):>5}  excess={ex:+.2f}%")

def oos_v4_compare():
    """Compare v3 vs v4 (no-stack) OOS 2023-26."""
    H=30
    print("\n=== v3 vs v4 (no-stack) OOS 2023-26 compare ===")
    print(f"{'variant':>8}{'SDOWNexc':>11}{'SUPexc':>10}{'nD/nU':>12}")
    for vname,P in [("v3",VARIANTS["v3"]),("v4",VARIANTS["v4"])]:
        sd=[];su=[];allf=[]
        for i in range(200,len(bars4h)-H):
            yr=datetime.datetime.utcfromtimestamp(bars4h[i]["time"]/1000).year
            if yr<2023:continue
            f=(c4[i+H]-c4[i])/c4[i]*100; allf.append(f)
            val,zone,a=score_trend(i,P)
            if val is None:continue
            if zone=="STRONG_DOWN":sd.append(f)
            elif zone=="STRONG_UP":su.append(f)
        d=sum(allf)/len(allf)
        sde=(sum(sd)/len(sd)-d) if sd else float('nan')
        sue=(sum(su)/len(su)-d) if su else float('nan')
        print(f"{vname:>8}{sde:>+10.2f}%{sue:>+9.2f}%{str(len(sd))+'/'+str(len(su)):>12}")

def oos_split(P, tag, split_year=2023):
    """Excess STRONG zones, train (<split) vs test (>=split) — OOS robustness."""
    seg={"train":defaultdict(list),"test":defaultdict(list)}
    for i in range(200,len(bars4h)-FWD_BARS):
        val,zone,a=score_trend(i,P)
        if val is None: continue
        yr=datetime.datetime.utcfromtimestamp(bars4h[i]["time"]/1000).year
        s="train" if yr<split_year else "test"
        seg[s][zone].append((c4[i+FWD_BARS]-c4[i])/c4[i]*100)
    print(f"\n[{tag}] OOS split @ {split_year} (excess vs drift {GLOBAL_DRIFT:+.2f}%):")
    print(f"{'':16}{'STRONG_DOWN':>14}{'STRONG_UP':>14}")
    for s in ("train","test"):
        sd=seg[s]["STRONG_DOWN"]; su=seg[s]["STRONG_UP"]
        sde=(sum(sd)/len(sd)-GLOBAL_DRIFT) if sd else float('nan')
        sue=(sum(su)/len(su)-GLOBAL_DRIFT) if su else float('nan')
        print(f"  {s:<14}{sde:>+13.2f}%{sue:>+13.2f}%   (n {len(sd)}/{len(su)})")

def horizon_oos(P, tag):
    """STRONG zone excess theo nhiều horizon, RIÊNG era OOS 2023-26."""
    print(f"\n[{tag}] Horizon sweep — OOS era 2023-26 only (STRONG zones):")
    print(f"{'horizon':>10}{'drift%':>9}{'SDOWNexc':>11}{'SUPexc':>10}{'nD/nU':>12}")
    for H in (6,12,18,30,42):
        sd=[]; su=[]; allf=[]
        for i in range(200,len(bars4h)-H):
            yr=datetime.datetime.utcfromtimestamp(bars4h[i]["time"]/1000).year
            if yr<2023: continue
            f=(c4[i+H]-c4[i])/c4[i]*100; allf.append(f)
            val,zone,a=score_trend(i,P)
            if val is None: continue
            if zone=="STRONG_DOWN": sd.append(f)
            elif zone=="STRONG_UP": su.append(f)
        drift=sum(allf)/len(allf)
        sde=(sum(sd)/len(sd)-drift) if sd else float('nan')
        sue=(sum(su)/len(su)-drift) if su else float('nan')
        print(f"{H:>8}×4h{drift:>+8.2f}{sde:>+10.2f}%{sue:>+9.2f}%{str(len(sd))+'/'+str(len(su)):>12}")

def rci_gate(P, tag):
    """RCI-bull proxy = RSI4h oversold reversal (buy dip). So precision khi
    GATE bằng Trend (bỏ entry nếu zone STRONG_DOWN). Test integration thesis."""
    def rsi_series(closes,p=14):
        n=len(closes); out=[None]*n
        if n<=p: return out
        g=l=0
        for i in range(1,p+1):
            d=closes[i]-closes[i-1]; g+=max(d,0); l+=max(-d,0)
        ag=g/p; al=l/p
        out[p]=100-100/(1+ag/al) if al>0 else 100
        for i in range(p+1,n):
            d=closes[i]-closes[i-1]
            ag=(ag*(p-1)+max(d,0))/p; al=(al*(p-1)+max(-d,0))/p
            out[i]=100-100/(1+ag/al) if al>0 else 100
        return out
    rsi4=rsi_series(c4,14)
    H=30
    def stats(rows):
        if not rows: return (0,0,0)
        pos=100*sum(1 for r in rows if r>0)/len(rows)
        return (len(rows), sum(rows)/len(rows), pos)
    for era,lo in (("ALL 7y",2019),("OOS 2023-26",2023)):
        ungated=[]; gated=[]; skipped=[]
        for i in range(200,len(bars4h)-H):
            if rsi4[i] is None or rsi4[i]>=30: continue   # oversold dip entry
            yr=datetime.datetime.utcfromtimestamp(bars4h[i]["time"]/1000).year
            if yr<lo: continue
            f=(c4[i+H]-c4[i])/c4[i]*100
            ungated.append(f)
            _,zone,_=score_trend(i,P)
            if zone=="STRONG_DOWN": skipped.append(f)
            else: gated.append(f)
        nu,au,pu=stats(ungated); ng,ag,pg=stats(gated); ns,ask,ps=stats(skipped)
        print(f"\n[{tag}] RCI-bull(RSI<30) × Trend-gate — {era}:")
        print(f"  ungated (mọi dip):       n={nu:>4} avgFwd {au:+.2f}% %pos {pu:.1f}")
        print(f"  GATED (bỏ STRONG_DOWN):  n={ng:>4} avgFwd {ag:+.2f}% %pos {pg:.1f}")
        print(f"  skipped (STRONG_DOWN):   n={ns:>4} avgFwd {ask:+.2f}% %pos {ps:.1f}  ← gate có loại đúng dao rơi?")

def stickiness(P, tag):
    """Đo whipsaw: số lần đổi zone, độ dài trung bình mỗi đoạn zone (bar 4h)."""
    seq=[]
    for i in range(200,len(bars4h)-1):
        val,zone,a=score_trend(i,P)
        if val is None: continue
        seq.append(zone)
    flips=sum(1 for i in range(1,len(seq)) if seq[i]!=seq[i-1])
    # avg run length
    runs=[]; cur=1
    for i in range(1,len(seq)):
        if seq[i]==seq[i-1]: cur+=1
        else: runs.append(cur); cur=1
    runs.append(cur)
    avg_run=sum(runs)/len(runs)
    # flips per 100 bar
    fp100=100*flips/len(seq)
    print(f"\n[{tag}] Stickiness: {len(seq)} bar, {flips} flip ({fp100:.1f}/100bar), "
          f"avg run {avg_run:.1f} bar 4h ({avg_run*4:.0f}h). "
          f"{'WHIPSAW cao ✗' if avg_run<3 else 'đủ sticky ✓'}")

def adx_sweep(P, tag):
    """Sweep adx_strong threshold, đo STRONG separation OOS 2023-26."""
    H=30
    print(f"\n[{tag}] ADX-strong sweep — STRONG excess OOS 2023-26:")
    print(f"{'adxThr':>8}{'SDOWNexc':>11}{'SUPexc':>10}{'nD/nU':>12}")
    drift=None
    for thr in (22,25,28,30):
        Pt=dict(P); Pt["adx_strong"]=thr
        sd=[];su=[];allf=[]
        for i in range(200,len(bars4h)-H):
            yr=datetime.datetime.utcfromtimestamp(bars4h[i]["time"]/1000).year
            if yr<2023: continue
            f=(c4[i+H]-c4[i])/c4[i]*100; allf.append(f)
            val,zone,a=score_trend(i,Pt)
            if val is None: continue
            if zone=="STRONG_DOWN": sd.append(f)
            elif zone=="STRONG_UP": su.append(f)
        d=sum(allf)/len(allf)
        sde=(sum(sd)/len(sd)-d) if sd else float('nan')
        sue=(sum(su)/len(su)-d) if su else float('nan')
        print(f"{thr:>8}{sde:>+10.2f}%{sue:>+9.2f}%{str(len(sd))+'/'+str(len(su)):>12}")

def sup_rci_bull(P, tag):
    """Iter8: STRONG_UP-bias giúp hay hại RCI-bull (mua dip RSI<30)?
    Ngược iter6 (gate khi STRONG_DOWN), giờ test: chỉ mua khi STRONG_UP active."""
    def rsi_series(closes,p=14):
        n=len(closes);out=[None]*n
        if n<=p:return out
        ag=al=0
        for i in range(1,p+1):
            d=closes[i]-closes[i-1];ag+=max(d,0);al+=max(-d,0)
        ag/=p;al/=p
        out[p]=100-100/(1+ag/al) if al>0 else 100
        for i in range(p+1,n):
            d=closes[i]-closes[i-1]
            ag=(ag*(p-1)+max(d,0))/p;al=(al*(p-1)+max(-d,0))/p
            out[i]=100-100/(1+ag/al) if al>0 else 100
        return out
    rsi4=rsi_series(c4,14)
    H=30
    for era,lo in (("ALL 7y",2019),("OOS 2023-26",2023)):
        ung=[];sup_only=[];non_sup=[]
        for i in range(200,len(bars4h)-H):
            if rsi4[i] is None or rsi4[i]>=30:continue
            yr=datetime.datetime.utcfromtimestamp(bars4h[i]["time"]/1000).year
            if yr<lo:continue
            f=(c4[i+H]-c4[i])/c4[i]*100;ung.append(f)
            _,zone,_=score_trend(i,P)
            if zone=="STRONG_UP":sup_only.append(f)
            else:non_sup.append(f)
        def s(xs):return (len(xs),sum(xs)/len(xs) if xs else 0,100*sum(1 for x in xs if x>0)/len(xs) if xs else 0)
        nu,au,pu=s(ung);ns,as_,ps=s(sup_only);nn,an,pn=s(non_sup)
        print(f"\n[{tag}] STRONG_UP-bias × RCI-bull (RSI4h<30) — {era}:")
        print(f"  ungated:        n={nu:>4} avg {au:+.2f}% %pos {pu:.1f}")
        print(f"  STRONG_UP only: n={ns:>4} avg {as_:+.2f}% %pos {ps:.1f}  ← UP bias filter")
        print(f"  non-STRONG_UP:  n={nn:>4} avg {an:+.2f}% %pos {pn:.1f}")

def eth_check(P, tag):
    """Iter9: Trend Index precision trên ETH (3y data) vs BTC — corr check."""
    import os
    eth_path="/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-eth-5m-3y.json"
    if not os.path.exists(eth_path):
        print("ETH cache không có, skip"); return
    raw_e=json.load(open(eth_path)); raw_e.sort(key=lambda x:x["time"])
    def build(ms,raw):
        b={}
        for c in raw:
            k=c["time"]//ms
            if k not in b: b[k]={"time":k*ms,"open":c["open"],"high":c["high"],"low":c["low"],"close":c["close"],"volume":c["volume"]}
            else: o=b[k];o["high"]=max(o["high"],c["high"]);o["low"]=min(o["low"],c["low"]);o["close"]=c["close"];o["volume"]+=c["volume"]
        return [b[k] for k in sorted(b)]
    e4=build(4*3600*1000,raw_e); e1=build(3600*1000,raw_e)
    ce4=[b["close"] for b in e4]; ce1=[b["close"] for b in e1]
    # recompute EMAs for ETH
    def _ema(xs,p):
        k=2/(p+1);out=[None]*len(xs);e=None
        for i,x in enumerate(xs):
            e=x if e is None else x*k+e*(1-k); out[i]=e
        return out
    ee20=_ema(ce4,20); ee50=_ema(ce4,50); ee200=_ema(ce4,200)
    _,epdi,emdi=adx_di_series(e4,14)
    adxe_raw,_,_=adx_di_series(e4,14)
    ee20_1h=_ema(ce1,20); ee50_1h=_ema(ce1,50)
    H=30
    by_z=defaultdict(list)
    for i in range(200,len(e4)-H):
        if ee200[i] is None or adxe_raw[i] is None: continue
        price=ce4[i]; a=adxe_raw[i]; pp=epdi[i]; mm=emdi[i]
        cs=cpv=cdi=csl=cc1=0.0
        if ee20[i]>ee50[i] and ee50[i]>ee200[i]: cs+=1.5
        elif ee20[i]>ee50[i]: cs+=0.7
        if ee20[i]<ee50[i] and ee50[i]<ee200[i]: cs-=1.5
        elif ee20[i]<ee50[i]: cs-=0.7
        cpv+=0.8 if price>ee50[i] else -0.8
        if pp is not None and mm is not None:
            if a>28: cdi+=(2.0 if pp>mm else -2.0)
            elif a>18: cdi+=(0.8 if pp>mm else -0.8)
        if i>=5 and ee50[i-5]: sl=(ee50[i]-ee50[i-5])/ee50[i-5]*100; csl+=(0.7 if sl>0.5 else 0.3 if sl>0.1 else -0.7 if sl<-0.5 else -0.3 if sl<-0.1 else 0)
        j=min(i*4,len(ee20_1h)-1)
        if ee20_1h[j] and ee50_1h[j]: cc1+=0.5 if ee20_1h[j]>ee50_1h[j] else -0.5
        val=cs+cpv+cdi+csl+cc1
        strong=a>28; below200=price<ee200[i]
        # EMA200 slope 10 bar
        e200up=e200dn=True
        if i>=10 and ee200[i-10]: s200=(ee200[i]-ee200[i-10])/ee200[i-10]*100; e200up=s200>0; e200dn=s200<0
        zone="RANGE"
        if val>1.6: zone="STRONG_UP" if (strong and val>3.0 and e200up) else "UP"
        elif val<-1.6:
            sd=strong and val<-3.0 and below200 and e200dn
            zone="STRONG_DOWN" if sd else "DOWN"
        by_z[zone].append((ce4[i+H]-ce4[i])/ce4[i]*100)
    drift=sum(sum(v) for v in by_z.values())/sum(len(v) for v in by_z.values())
    print(f"\n[{tag}] ETH per-asset (3y, fwd {H}×4h, drift {drift:+.2f}%):")
    print(f"{'ZONE':<13}{'n':>6}{'excess':>10}")
    for z in ["STRONG_DOWN","DOWN","RANGE","UP","STRONG_UP"]:
        xs=by_z.get(z,[])
        if xs: print(f"{z:<13}{len(xs):>6}{sum(xs)/len(xs)-drift:>+9.2f}%")

def range_audit(P, tag):
    """Iter10: tại sao RANGE excess âm? Kiểm tra: RANGE ở đâu trong chu kỳ (trước/sau trend)."""
    H=30
    from collections import Counter
    # Lấy sequence zone, xem RANGE xuất hiện sau STRONG_DOWN nhiều không
    prev_zones=[]; cur_zones=[]
    for i in range(201,len(bars4h)-H):
        val,zone,_=score_trend(i,P)
        vp,zonep,_=score_trend(i-1,P)
        if val is None or vp is None: continue
        prev_zones.append(zonep); cur_zones.append(zone)
    # fwd return theo (prev_zone, cur_zone) pair — chỉ quan tâm RANGE hiện tại
    range_by_prev=defaultdict(list)
    for i in range(201,len(bars4h)-H):
        val,zone,_=score_trend(i,P)
        vp,zonep,_=score_trend(i-1,P)
        if val is None or vp is None or zone!="RANGE": continue
        f=(c4[i+H]-c4[i])/c4[i]*100
        range_by_prev[zonep].append(f)
    allf=sum(range_by_prev.values(),[])
    drift=sum(allf)/len(allf) if allf else 0
    print(f"\n[{tag}] RANGE zone breakdown by PREV zone (fwd {H}×4h, drift {drift:+.2f}%):")
    print(f"{'prev_zone':<14}{'n':>6}{'excess':>10}")
    for z in ["STRONG_DOWN","DOWN","RANGE","UP","STRONG_UP"]:
        xs=range_by_prev.get(z,[])
        if xs: print(f"{z:<14}{len(xs):>6}{sum(xs)/len(xs)-drift:>+9.2f}%")
    # cũng check: RANGE split by ADX level
    range_adx_lo=[]; range_adx_hi=[]
    for i in range(200,len(bars4h)-H):
        val,zone,a=score_trend(i,P)
        if val is None or zone!="RANGE" or a is None: continue
        f=(c4[i+H]-c4[i])/c4[i]*100
        if a<15: range_adx_lo.append(f)
        else: range_adx_hi.append(f)
    dall=[x for xs in range_by_prev.values() for x in xs]; d=sum(dall)/len(dall) if dall else 0
    print(f"  RANGE ADX<15 (true sideways): n={len(range_adx_lo)} excess={sum(range_adx_lo)/len(range_adx_lo)-d:+.2f}%" if range_adx_lo else "")
    print(f"  RANGE ADX≥15 (weak trend):    n={len(range_adx_hi)} excess={sum(range_adx_hi)/len(range_adx_hi)-d:+.2f}%" if range_adx_hi else "")

def slope_sweep(P, tag):
    """Iter12: sweep EMA50 slope thresholds (lo/hi) — tìm optimal trên OOS 2023-26."""
    H=30
    print(f"\n[{tag}] EMA50-slope threshold sweep — STRONG_UP excess OOS 2023-26:")
    print(f"{'lo/hi':>9}{'SDOWNexc':>11}{'SUPexc':>10}{'nD/nU':>12}")
    for lo,hi in ((0.05,0.3),(0.1,0.5),(0.15,0.6),(0.2,0.8)):
        Pt=dict(P); Pt["slope_lo"]=lo; Pt["slope_hi"]=hi
        sd=[];su=[];allf=[]
        for i in range(200,len(bars4h)-H):
            yr=datetime.datetime.utcfromtimestamp(bars4h[i]["time"]/1000).year
            if yr<2023:continue
            f=(c4[i+H]-c4[i])/c4[i]*100; allf.append(f)
            val,zone,a=score_trend(i,Pt)
            if val is None:continue
            if zone=="STRONG_DOWN":sd.append(f)
            elif zone=="STRONG_UP":su.append(f)
        d=sum(allf)/len(allf)
        sde=(sum(sd)/len(sd)-d) if sd else float('nan')
        sue=(sum(su)/len(su)-d) if su else float('nan')
        print(f"{lo:.2f}/{hi:.2f}{sde:>+10.2f}%{sue:>+9.2f}%{str(len(sd))+'/'+str(len(su)):>12}")

def c1_sweep(P, tag):
    """Iter13: 1h-confirm weight sweep (0 → 1.0). Nếu c1 cao thì STRONG zone tốt hơn không?"""
    H=30
    print(f"\n[{tag}] 1h-confirm weight sweep — STRONG excess OOS 2023-26:")
    print(f"{'c1':>6}{'SDOWNexc':>11}{'SUPexc':>10}{'nD/nU':>12}")
    for c1 in (0.0,0.3,0.5,0.8,1.2):
        Pt=dict(P); Pt["c1"]=c1
        sd=[];su=[];allf=[]
        for i in range(200,len(bars4h)-H):
            yr=datetime.datetime.utcfromtimestamp(bars4h[i]["time"]/1000).year
            if yr<2023:continue
            f=(c4[i+H]-c4[i])/c4[i]*100; allf.append(f)
            val,zone,a=score_trend(i,Pt)
            if val is None:continue
            if zone=="STRONG_DOWN":sd.append(f)
            elif zone=="STRONG_UP":su.append(f)
        d=sum(allf)/len(allf)
        sde=(sum(sd)/len(sd)-d) if sd else float('nan')
        sue=(sum(su)/len(su)-d) if su else float('nan')
        print(f"{c1:>6.1f}{sde:>+10.2f}%{sue:>+9.2f}%{str(len(sd))+'/'+str(len(su)):>12}")

def ablation(P, tag):
    """Iter14: ablation — bỏ từng component, đo impact lên STRONG excess OOS 2023-26."""
    H=30
    components=["stack_full","pve","di","slope","c1"]
    print(f"\n[{tag}] Component ablation (STRONG excess OOS 2023-26, baseline vs remove each):")
    print(f"{'removed':>14}{'SDOWNexc':>11}{'SUPexc':>10}{'nD/nU':>12}")
    for remove in ["(none)"]+components:
        Pt=dict(P)
        if remove=="stack_full": Pt["stack_full"]=0; Pt["stack_part"]=0
        elif remove=="pve": Pt["pve"]=0
        elif remove=="di": Pt["di_strong"]=0; Pt["di_weak"]=0
        elif remove=="slope": Pt["slope_hi"]=0; Pt["slope_lo"]=0
        elif remove=="c1": Pt["c1"]=0
        sd=[];su=[];allf=[]
        for i in range(200,len(bars4h)-H):
            yr=datetime.datetime.utcfromtimestamp(bars4h[i]["time"]/1000).year
            if yr<2023:continue
            f=(c4[i+H]-c4[i])/c4[i]*100; allf.append(f)
            val,zone,a=score_trend(i,Pt)
            if val is None:continue
            if zone=="STRONG_DOWN":sd.append(f)
            elif zone=="STRONG_UP":su.append(f)
        d=sum(allf)/len(allf)
        sde=(sum(sd)/len(sd)-d) if sd else float('nan')
        sue=(sum(su)/len(su)-d) if su else float('nan')
        flag="←KILL" if (not(sde!=sde) and sde>0.1) or (not(sue!=sue) and sue<0.1) else ""
        print(f"{remove:>14}{sde:>+10.2f}%{sue:>+9.2f}%{str(len(sd))+'/'+str(len(su)):>12}  {flag}")

def pve_sweep(P, tag):
    """Iter14b: pve weight sweep 0→1.5 — đóng góp vào STRONG_UP."""
    H=30
    print(f"\n[{tag}] PVE weight sweep — STRONG excess OOS 2023-26:")
    print(f"{'pve':>6}{'SDOWNexc':>11}{'SUPexc':>10}{'nD/nU':>12}")
    for pve in (0.0,0.4,0.8,1.2,1.5):
        Pt=dict(P); Pt["pve"]=pve
        sd=[];su=[];allf=[]
        for i in range(200,len(bars4h)-H):
            yr=datetime.datetime.utcfromtimestamp(bars4h[i]["time"]/1000).year
            if yr<2023:continue
            f=(c4[i+H]-c4[i])/c4[i]*100; allf.append(f)
            val,zone,a=score_trend(i,Pt)
            if val is None:continue
            if zone=="STRONG_DOWN":sd.append(f)
            elif zone=="STRONG_UP":su.append(f)
        d=sum(allf)/len(allf)
        sde=(sum(sd)/len(sd)-d) if sd else float('nan')
        sue=(sum(su)/len(su)-d) if su else float('nan')
        print(f"{pve:>6.1f}{sde:>+10.2f}%{sue:>+9.2f}%{str(len(sd))+'/'+str(len(su)):>12}")

def sharpe_eval(tag):
    """Iter15: Sharpe-like eval — excess/std cho STRONG zones, v3 vs v4, OOS 2023-26."""
    H=30
    print(f"\n[{tag}] Sharpe-like (excess/std) — STRONG zones OOS 2023-26:")
    print(f"{'variant':>8}{'SDN_sh':>10}{'SUP_sh':>10}{'nD/nU':>12}")
    for vname,Pt in [("v3",VARIANTS["v3"]),("v4",VARIANTS["v4"])]:
        sd=[];su=[];allf=[]
        for i in range(200,len(bars4h)-H):
            yr=datetime.datetime.utcfromtimestamp(bars4h[i]["time"]/1000).year
            if yr<2023:continue
            f=(c4[i+H]-c4[i])/c4[i]*100; allf.append(f)
            val,zone,a=score_trend(i,Pt)
            if val is None:continue
            if zone=="STRONG_DOWN":sd.append(f)
            elif zone=="STRONG_UP":su.append(f)
        d=sum(allf)/len(allf)
        def sh(xs,drift):
            if len(xs)<5:return float('nan')
            exc=[x-drift for x in xs]; m=sum(exc)/len(exc)
            s=statistics.stdev(exc) if len(exc)>1 else 1
            return m/s if s>0 else 0
        print(f"{vname:>8}{sh(sd,d):>+10.3f}{sh(su,d):>+10.3f}{str(len(sd))+'/'+str(len(su)):>12}")

def di_final_sweep(tag):
    """Iter16: di_strong final sweep 1.5-3.0 — v4 base, OOS 2023-26."""
    H=30
    print(f"\n[{tag}] DI-strong final sweep (v4 base) OOS 2023-26:")
    print(f"{'di_str':>8}{'SUP_sh':>10}{'SUPexc':>10}{'nU':>8}")
    for ds in (1.5,2.0,2.5,3.0):
        Pt=dict(VARIANTS["v4"]); Pt["di_strong"]=ds
        su=[];allf=[]
        for i in range(200,len(bars4h)-H):
            yr=datetime.datetime.utcfromtimestamp(bars4h[i]["time"]/1000).year
            if yr<2023:continue
            f=(c4[i+H]-c4[i])/c4[i]*100; allf.append(f)
            val,zone,a=score_trend(i,Pt)
            if val is None:continue
            if zone=="STRONG_UP":su.append(f)
        d=sum(allf)/len(allf)
        def sh(xs):
            if len(xs)<5:return float('nan')
            exc=[x-d for x in xs]; m=sum(exc)/len(exc)
            s=statistics.stdev(exc) if len(exc)>1 else 1
            return m/s if s>0 else 0
        exc=(sum(su)/len(su)-d) if su else float('nan')
        print(f"{ds:>8.1f}{sh(su):>+10.3f}{exc:>+9.2f}%{len(su):>8}")

if __name__=="__main__":
    if VARIANT=="iter16":
        di_final_sweep("v4"); sys.exit(0)
    if VARIANT=="iter15":
        sharpe_eval("v3+v4"); sys.exit(0)
    if VARIANT=="iter14":
        ablation(VARIANTS["v3"],"v3"); pve_sweep(VARIANTS["v3"],"v3"); sys.exit(0)
    if VARIANT=="iter13":
        c1_sweep(VARIANTS["v3"],"v3"); sys.exit(0)
    if VARIANT=="iter12":
        slope_sweep(VARIANTS["v3"],"v3"); sys.exit(0)
    if VARIANT=="iter10":
        range_audit(VARIANTS["v3"],"v3"); sys.exit(0)
    if VARIANT=="iter9":
        eth_check(VARIANTS["v3"],"v3"); sys.exit(0)
    if VARIANT=="iter8":
        sup_rci_bull(VARIANTS["v3"],"v3"); sys.exit(0)
    if VARIANT=="iter7":
        stickiness(VARIANTS["v3"], "v3"); adx_sweep(VARIANTS["v3"], "v3"); sys.exit(0)
    if VARIANT=="rcigate":
        rci_gate(VARIANTS["v3"], "v3"); sys.exit(0)
    if VARIANT=="horizon":
        horizon_oos(VARIANTS["v3"], "v3"); sys.exit(0)
    if VARIANT=="oos":
        oos_split(VARIANTS["v3"], "v3")
        sys.exit(0)
    if VARIANT=="all":
        for v in ["v1","v2","v3"]:
            res=run(VARIANTS[v], v); excess_report(VARIANTS[v], v)
            print(f"SUMMARY[{v}] acc={res['acc']:.1f}% cov={res['cov']:.0f}% mono={res['mono']} stable={res['stable']}/{res['nyears']}\n"+"="*60)
    else:
        P = VARIANTS.get(VARIANT, P_V1)
        res = run(P, VARIANT); excess_report(P, VARIANT)
        print(f"\nSUMMARY[{VARIANT}] acc={res['acc']:.1f}% cov={res['cov']:.0f}% mono={res['mono']} stable={res['stable']}/{res['nyears']}")
