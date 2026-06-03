#!/usr/bin/env python3
"""PROBE redesign hedge05 — DIP-BUY (pullback) forced-daily, NO DCA, asymmetric exit.
   LIVE-FAITHFUL: entry eval tại CLOSE 1h bar i (enter = c1h[i]); regime D-1 (no lookahead);
   day-open known tại day start; SL-check-TRƯỚC-TP (conservative, chống intrabar optimism).
   Variants: A1 long-only / A2 symmetric (BEAR short-the-rip) / A3 long-only trail let-run.
   JUDGE BẰNG DOLLARS (size 0.003 BTC cố định), KHÔNG bằng RA% (size cố định nên ở đây % ~ $).
   Baseline old breakout no-dca (faithful) = -$114/7y; lean = -$88.  Usage: --variant=A1 --sweep"""
import json, datetime, sys
from collections import defaultdict

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FEE   = 0.05/100
BASE_QTY = 0.003

def argf(name, d):
    for a in sys.argv:
        if a.startswith(f"--{name}="): return float(a.split("=")[1])
    return d
DEADLINE_HOUR = int(argf("deadline", 20))
SWEEP = "--sweep" in sys.argv
NOFB_G = "--nofb" in sys.argv

print("Loading + aggregating...", file=sys.stderr)
raw = json.load(open(CACHE)); raw.sort(key=lambda x: x["time"])
def agg(bars, ms):
    b={}
    for c in bars:
        k=c["time"]//ms
        if k not in b: b[k]={"time":k*ms,"open":c["open"],"high":c["high"],"low":c["low"],"close":c["close"],"volume":c["volume"]}
        else:
            o=b[k]; o["high"]=max(o["high"],c["high"]); o["low"]=min(o["low"],c["low"]); o["close"]=c["close"]; o["volume"]+=c["volume"]
    return [b[k] for k in sorted(b)]
bars1h = agg(raw, 3600*1000); bars1d = agg(raw, 86400*1000)
n1h = len(bars1h); c1h=[b["close"] for b in bars1h]

def atr_w(bars, p=14):
    n=len(bars); tr=[0.]*n
    for i in range(1,n):
        tr[i]=max(bars[i]["high"]-bars[i]["low"], abs(bars[i]["high"]-bars[i-1]["close"]), abs(bars[i]["low"]-bars[i-1]["close"]))
    out=[None]*n
    if n<=p: return out
    s=sum(tr[1:p+1]); out[p]=s/p
    for i in range(p+1,n): out[i]=(out[i-1]*(p-1)+tr[i])/p
    return out
def rsi_s(cls, n=14):
    out=[None]*len(cls); ag=al=0.
    if len(cls)<=n: return out
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
def regime_wp(b1d, persist=3):
    cs=[b["close"] for b in b1d]; n=len(b1d); rw=["RANGE"]*n
    for i in range(200,n):
        ma200=sum(cs[i-199:i+1])/200; ma50=sum(cs[i-50:i+1])/50
        ar=sum((b["high"]-b["low"])/b["close"] for b in b1d[i-19:i+1])/20
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

print("Computing indicators...", file=sys.stderr)
atr1h = atr_w(bars1h); rsi1h = rsi_s(c1h)
reg1d = regime_wp(bars1d); reg_map={}
for i,b in enumerate(bars1d): reg_map[b["time"]//86400000]=reg1d[i]
dopen={}
for b in bars1d: dopen[b["time"]//86400000]=b["open"]
def reg_at(ts): return reg_map.get(ts//86400000 - 1, "RANGE")   # D-1 = no lookahead
def day_open(ts): return dopen.get(ts//86400000)                # open của ngày D, biết từ 00:00 UTC
def utc_day(ts):
    d=datetime.datetime.utcfromtimestamp(ts/1000); return d.year*10000+d.month*100+d.day

WARM = 210*24

def run(variant, dip, rsi_os, rsi_ob, tp, sl, ts_h, trail, nofb):
    camps=[]; camp=None; last_day=-1
    is_trail = (variant=="A3")
    for i in range(WARM, n1h):
        bar=bars1h[i]; tms=bar["time"]; px=bar["close"]; day=utc_day(tms); a=atr1h[i]
        # ── manage ──
        if camp is not None:
            c=camp; side=c["side"]; atr0=c["atr0"]; entry=c["entry"]
            if bar["high"]>c["hwm"]: c["hwm"]=bar["high"]
            if bar["low"] <c["lwm"]: c["lwm"]=bar["low"]
            closed=False
            # 1. SL FIRST (anti-optimism: nếu bar straddle cả SL+TP, SL thắng)
            if side=="LONG":
                slpx=entry-atr0*sl
                if bar["low"]<=slpx: c["ex"]=(slpx,"SL"); closed=True
            else:
                slpx=entry+atr0*sl
                if bar["high"]>=slpx: c["ex"]=(slpx,"SL"); closed=True
            # 2. TP (A1/A2 fixed) | Trail (A3)
            if not closed and not is_trail:
                if side=="LONG":
                    tppx=entry+atr0*tp
                    if bar["high"]>=tppx: c["ex"]=(tppx,"TP"); closed=True
                else:
                    tppx=entry-atr0*tp
                    if bar["low"]<=tppx: c["ex"]=(tppx,"TP"); closed=True
            if not closed and is_trail:   # long-only trailing
                trpx=c["hwm"]-atr0*trail
                if bar["low"]<=trpx: c["ex"]=(trpx,"TRAIL"); closed=True
            # 3. time stop
            if not closed and (i-c["open_i"])>=ts_h:
                c["ex"]=(px,"TIME"); closed=True
            if closed:
                ex_px,reason=c["ex"]
                fees=FEE*entry*BASE_QTY + FEE*ex_px*BASE_QTY
                pnl=BASE_QTY*(ex_px-entry) if side=="LONG" else BASE_QTY*(entry-ex_px)
                usd=pnl-fees; dep=entry*BASE_QTY
                d=datetime.datetime.utcfromtimestamp(tms/1000)
                camps.append({"ret":usd/dep,"usd":usd,"yr":d.year,"reason":reason,"side":side,"held":i-c["open_i"]})
                camp=None
            continue
        # ── entry (camp is None) ──
        if last_day==day: continue
        if a is None or a<=0: continue
        do=day_open(tms)
        if do is None: continue
        regime=reg_at(tms); hr=datetime.datetime.utcfromtimestamp(tms/1000).hour
        side="SHORT" if (variant=="A2" and regime=="BEAR") else "LONG"
        sig=False
        if side=="LONG":
            if (px<=do-a*dip) and (rsi1h[i] is not None and rsi1h[i]<rsi_os) and (bar["close"]>bar["open"]): sig=True
        else:
            if (px>=do+a*dip) and (rsi1h[i] is not None and rsi1h[i]>rsi_ob) and (bar["close"]<bar["open"]): sig=True
        is_fb=False
        if not sig and hr>=DEADLINE_HOUR and not nofb: sig=True; is_fb=True
        if sig:
            camp={"side":side,"entry":px,"atr0":a,"open_i":i,"hwm":px,"lwm":px,"fb":is_fb}
            last_day=day
    # report stats
    n=len(camps)
    if n==0: return None
    rets=[c["ret"] for c in camps]; mean=sum(rets)/n
    sd=(sum((r-mean)**2 for r in rets)/n)**0.5 or 1e-9
    ra=mean/sd; wr=sum(1 for r in rets if r>0)/n*100
    wins=[r for r in rets if r>0]; losses=[r for r in rets if r<=0]
    rr=(sum(wins)/len(wins) if wins else 0)/abs(sum(losses)/len(losses) if losses else 1e-9)
    by_yr=defaultdict(float)
    for c in camps: by_yr[c["yr"]]+=c["usd"]
    stab=sum(1 for y in by_yr if by_yr[y]>0)
    usd7=sum(c["usd"] for c in camps); usdR=sum(c["usd"] for c in camps if c["yr"]>=2023)
    reasons=defaultdict(lambda:[0,0.0])
    for c in camps: reasons[c["reason"]][0]+=1; reasons[c["reason"]][1]+=c["usd"]
    return {"n":n,"wr":wr,"rr":rr,"ra":ra,"usd7":usd7,"usdR":usdR,"stab":stab,"nyr":len(by_yr),
            "reasons":dict(reasons),"by_yr":dict(by_yr)}

VARIANT = next((a.split("=")[1] for a in sys.argv if a.startswith("--variant=")), "A1")

def line(tag, p):
    if p is None: print(f"  {tag:34s} n=0"); return
    rs="  ".join(f"{k}:{v[0]}(${v[1]:+.0f})" for k,v in sorted(p["reasons"].items(), key=lambda x:-x[1][1]))
    print(f"  {tag:34s} n={p['n']:4d} WR={p['wr']:2.0f}% R:R={p['rr']:.2f} RA={p['ra']:+.3f} | ${p['usd7']:+5.0f}/7y ${p['usdR']:+5.0f}rec | stab{p['stab']}/{p['nyr']} | {rs}")

print("="*120)
print(f"DIP-BUY redesign probe — variant={VARIANT}  (DOLLARS = sự thật; baseline old-breakout no-dca = -$114, lean -$88)")
print("="*120)
if SWEEP:
    print(f"{'[dip tp sl ts]':34s} {'stats':>30s}")
    for sl in (1.0, 1.5):
        for tp in (1.5, 2.0, 2.5):
            for dip in (0.3, 0.5):
                p=run(VARIANT, dip, argf("rsios",35), argf("rsiob",65), tp, sl, int(argf("ts",48)), argf("trail",3.0), NOFB_G)
                line(f"dip{dip} tp{tp} sl{sl} ts48", p)
        print("  " + "-"*100)
else:
    p=run(VARIANT, argf("dip",0.5), argf("rsios",35), argf("rsiob",65), argf("tp",2.0),
          argf("sl",1.5), int(argf("ts",48)), argf("trail",3.0), NOFB_G)
    line(f"{VARIANT} dip{argf('dip',0.5)} tp{argf('tp',2.0)} sl{argf('sl',1.5)}", p)
    if p: print(f"    per-year $: " + "  ".join(f"{y}:${p['by_yr'][y]:+.0f}" for y in sorted(p['by_yr'])))
