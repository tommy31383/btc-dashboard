#!/usr/bin/env python3
"""autoloop-r46-sol-contribution-frequency.py — Round 46: SOL contribution + signal frequency
R46A: SOL contribution to RANGE regime returns (does SOL enhance BTC's RANGE alpha?)
R46B: BTC vs SOL signal correlation — independence check
R46C: Signal frequency analysis — entries/month, cooldown gaps
R46D: Forward-test calibration — expected signal frequency per month
"""
import importlib.util, datetime, math, os, sys
from collections import defaultdict

def imp(name, path):
    spec=importlib.util.spec_from_file_location(name,path); M=importlib.util.module_from_spec(spec)
    so=sys.stdout; sys.stdout=open(os.devnull,"w"); spec.loader.exec_module(M); sys.stdout=so; return M

T="/Users/lap16116/BTC_PC/btc-dashboard/tools/"
CC="/Users/lap16116/BTC_PC/btc-dashboard/.cache"
Hh=imp("Hh",T+"loop-hedge01-crossasset.py"); C=imp("C",T+"correlation-turtle-hedge01-7y.py")
H=imp("H",T+"backtest-bull-regime-reaudit-7y.py")

def mo_str(ts): return datetime.datetime.utcfromtimestamp(ts/1000).strftime("%Y-%m")
def months_between(t0,t1):
    d0=datetime.datetime.utcfromtimestamp(t0/1000); d1=datetime.datetime.utcfromtimestamp(t1/1000)
    out=[]; y,m=d0.year,d0.month
    while (y,m)<=(d1.year,d1.month):
        out.append(f"{y}-{m:02d}"); m+=1
        if m>12: m=1;y+=1
    return out
def sharpe(v):
    if len(v)<2: return 0.0
    me=sum(v)/len(v); d=(sum((x-me)**2 for x in v)/len(v))**.5 or 1e-9; return me/d*math.sqrt(12)
def corr(a,b):
    n=min(len(a),len(b)); a=a[:n]; b=b[:n]
    ma=sum(a)/n; mb=sum(b)/n
    num=sum((a[i]-ma)*(b[i]-mb) for i in range(n))
    da=(sum((x-ma)**2 for x in a)/n)**.5; db=(sum((x-mb)**2 for x in b)/n)**.5
    return num/(n*da*db) if da*db>0 else 0.0

_,_,_,spanB=Hh.run_hedge01(f"{CC}/binance-5m-7y.json",skip_cal=False)
_,_,_,spanS=Hh.run_hedge01(f"{CC}/binance-sol-5m-3y.json",skip_cal=False)
turB=dict(C.tur_mo); cal3=months_between(spanS[0],spanS[1])
sTB3=[turB.get(m,0.0) for m in cal3]

def run_h01(cache, adx_thresh=18, sl_init=3.0, sl_trail=3.5, sl_trans=16,
            adx_period=12, atr_break_mult=1.3, vol_mult=1.4, vol_ma=10, max_hold=200):
    H.CACHE=cache
    orig=(H.ADX_THRESH,H.SL_INIT,H.SL_TRAIL,H.SL_TRANS,H.ADX_P,
          H.ATR_BREAK_MULT,H.VOL_MULT,H.VOL_MA,H.MAX_HOLD)
    H.ADX_THRESH=adx_thresh; H.SL_INIT=sl_init; H.SL_TRAIL=sl_trail; H.SL_TRANS=sl_trans
    H.ADX_P=adx_period; H.ATR_BREAK_MULT=atr_break_mult; H.VOL_MULT=vol_mult
    H.VOL_MA=vol_ma; H.MAX_HOLD=max_hold
    bars4h=H.load_tf(H.H4); bars1h=H.load_tf(3600*1000); bars1d=H.load_tf(86400*1000)
    n=len(bars4h); c4=[b["close"] for b in bars4h]
    e50=H.ema_s(c4,H.EMA_FAST); e200=H.ema_s(c4,H.EMA_SLOW)
    atr4=H.atr_series(bars4h); adx4=H.adx_wilder(bars4h,period=H.ADX_P)
    e200_1h=H.ema_s([b["close"] for b in bars1h],200); h1t=[b["time"] for b in bars1h]
    regime_1d=H.regime_with_persistence(bars1d)
    reg_map={b["time"]//86400000:regime_1d[i] for i,b in enumerate(bars1d)}
    def get_reg(ts): return reg_map.get(ts//86400000,"RANGE")
    def atp(i): return None if atr4[i] is None else atr4[i]/c4[i]
    def atp_pass(i):
        if i<H.ATR_PCT_LB+14: return False
        vs=[atp(j) for j in range(i-H.ATR_PCT_LB,i) if atp(j) is not None]
        if len(vs)<H.ATR_PCT_LB: return False
        cur=atp(i); return cur is not None and cur>=sorted(vs)[int(len(vs)*H.ATR_PCT_PCTL)]
    def vol_pass(i):
        if i<H.VOL_MA: return False
        ma=sum(bars4h[j]["volume"] for j in range(i-H.VOL_MA,i))/H.VOL_MA
        return bars4h[i]["volume"]>=ma*H.VOL_MULT
    def e200_1h_at(ts):
        lo,hi,idx=0,len(h1t)-1,0
        while lo<=hi:
            m=(lo+hi)//2
            if h1t[m]<=ts: idx=m; lo=m+1
            else: hi=m-1
        return e200_1h[idx]
    def filt(i):
        adv=adx4[i]
        if adv is None or adv<=H.ADX_THRESH: return False
        ap=adx4[i-1] if i>=1 else None
        if ap is None or ap<=H.ADX_THRESH: return False
        e1h=e200_1h_at(bars4h[i]["time"])
        if e1h is None or c4[i]<e1h: return False
        if not atp_pass(i): return False
        return get_reg(bars4h[i]["time"])=="RANGE"
    def sim(ei):
        ep=c4[ei]; ae=atr4[ei]
        if ae is None or ae<=0: return None
        sl_=ep-ae*H.SL_INIT; hwm=ep
        for h in range(1,H.MAX_HOLD+1):
            j=ei+h
            if j>=n: break
            mult=H.SL_INIT if h<H.SL_TRANS else H.SL_TRAIL
            if c4[j]>hwm: hwm=c4[j]; sl_=hwm-ae*mult
            elif h>=H.SL_TRANS:
                t=hwm-ae*H.SL_TRAIL
                if t>sl_: sl_=t
            if bars4h[j]["low"]<=sl_: return (sl_-ep)/ep-2*H.FEE,h
        j=min(ei+H.MAX_HOLD,n-1); return (c4[j]-ep)/ep-2*H.FEE,H.MAX_HOLD
    s12=lambda i:(None if None in (e50[i],e200[i]) or i<1 or None in (e50[i-1],e200[i-1]) else ("LONG" if e50[i-1]<=e200[i-1] and e50[i]>e200[i] else None))
    s13=lambda i:(None if atr4[i] is None or i<1 else ("LONG" if c4[i]>bars4h[i-1]["close"]+atr4[i]*H.ATR_BREAK_MULT else None))
    s14=lambda i:(None if i<H.DONCHIAN_LB else ("LONG" if c4[i]>max(bars4h[j]["high"] for j in range(i-H.DONCHIAN_LB,i)) else None))
    sigs={"S12":(s12,False,36),"S13":(s13,True,1),"S14":(s14,True,36)}
    mo=defaultdict(float); mo_cnt=defaultdict(int)
    sig_mo=defaultdict(lambda:defaultdict(float)); last={s:0 for s in sigs}
    trades_detail=[]
    for i in range(250,n-H.MAX_HOLD):
        for sn,(sfn,dov,cd) in sigs.items():
            if sfn(i)!="LONG": continue
            if i-last[sn]<cd: continue
            if dov and not vol_pass(i): continue
            if not filt(i): continue
            r=sim(i)
            if r is None: continue
            ret,h=r; cts=bars4h[min(i+h,n-1)]["time"]
            m_=mo_str(cts); mo[m_]+=ret; mo_cnt[m_]+=1; sig_mo[sn][m_]+=ret
            trades_detail.append((m_,sn,ret,h,bars4h[i]["time"]))
            last[sn]=i
    regime_mo=defaultdict(lambda:defaultdict(int))
    for b in bars1d:
        m_=mo_str(b["time"]); rg=get_reg(b["time"])
        regime_mo[m_][rg]+=1
    (H.ADX_THRESH,H.SL_INIT,H.SL_TRAIL,H.SL_TRANS,H.ADX_P,
     H.ATR_BREAK_MULT,H.VOL_MULT,H.VOL_MA,H.MAX_HOLD)=orig
    return mo,mo_cnt,sig_mo,trades_detail,regime_mo

print("Loading BTC+SOL 3y detailed...")
moB,cntB,sigB,trB,regB=run_h01(f"{CC}/binance-5m-7y.json",18)
moS,cntS,sigS,trS,regS=run_h01(f"{CC}/binance-sol-5m-3y.json",15)
sB=[moB.get(m,0.0) for m in cal3]; sS=[moS.get(m,0.0) for m in cal3]

print("="*100)
print("=== R46: SOL contribution + signal frequency analysis ===\n")

# ─── R46A: SOL contribution in RANGE months ───
print("━"*100)
print("R46A: SOL vs BTC contribution in each RANGE month (3y)")
print(f"  {'Month':<9} {'BTC':>7} {'SOL':>7} {'TUR':>7} {'PORT':>7} {'same_dir':>9} {'SOL_add':>8}")
print("  "+"-"*65)
range_months=[m for m in cal3 if max(regB.get(m,{"RANGE":1}),key=regB.get(m,{"RANGE":1}).get)=="RANGE"]
same_dir=0; sol_adds=0
for m in range_months:
    btc=moB.get(m,0.0); sol=moS.get(m,0.0); tur=turB.get(m,0.0)
    port=(btc+sol+tur)/3
    sd="✅" if (btc>0)==(sol>0) else "❌"
    if (btc>0)==(sol>0): same_dir+=1
    sol_lift=(btc+sol+tur)/3-(btc+tur)/2
    if sol_lift>0: sol_adds+=1
    print(f"  {m:<9} {btc*100:>+6.1f}% {sol*100:>+6.1f}% {tur*100:>+6.1f}% {port*100:>+6.1f}% {sd:>9} {sol_lift*100:>+7.1f}%")

n_range=len(range_months)
print(f"\n  RANGE months: {n_range} | BTC+SOL same direction: {same_dir}/{n_range} ({same_dir/n_range*100:.0f}%)")
print(f"  SOL adds value (vs BTC-only): {sol_adds}/{n_range} months ({sol_adds/n_range*100:.0f}%)")
corr_bs=corr(sB,sS); print(f"  Corr(BTC,SOL) monthly: {corr_bs:+.3f}")

# ─── R46B: Independence check ───
print("\n━"*100)
print("R46B: BTC vs SOL signal independence")
both_active=[m for m in cal3 if moB.get(m,0.0)!=0 and moS.get(m,0.0)!=0]
btc_only=[m for m in cal3 if moB.get(m,0.0)!=0 and moS.get(m,0.0)==0]
sol_only=[m for m in cal3 if moB.get(m,0.0)==0 and moS.get(m,0.0)!=0]
neither=[m for m in cal3 if moB.get(m,0.0)==0 and moS.get(m,0.0)==0]

print(f"  Both active: {len(both_active)} months | BTC only: {len(btc_only)} | SOL only: {len(sol_only)} | Neither: {len(neither)}")
if both_active:
    avg_ba=sum((moB.get(m,0.0)+moS.get(m,0.0))/2 for m in both_active)/len(both_active)*100
    print(f"  Both-active months avg book ret: {avg_ba:+.1f}%")
if btc_only:
    avg_bo=sum((moB.get(m,0.0)+sTB3[cal3.index(m)])/2 for m in btc_only)/len(btc_only)*100
    print(f"  BTC-only months avg (BTC+turtle/2): {avg_bo:+.1f}%")
if sol_only:
    avg_so=sum((moS.get(m,0.0)+sTB3[cal3.index(m)])/2 for m in sol_only)/len(sol_only)*100
    print(f"  SOL-only months avg (SOL+turtle/2): {avg_so:+.1f}%")

# ─── R46C: Signal frequency ───
print("\n━"*100)
print("R46C: Signal frequency analysis")
print(f"\n  BTC (3y on SOL calendar):")
btc_trades_3y=[t for t in trB if t[0]>=cal3[0]]
print(f"  Total trades: {len(btc_trades_3y)} in {len(cal3)} months = {len(btc_trades_3y)/len(cal3):.1f} trades/month")
for sn in ["S12","S13","S14"]:
    ts_sn=[t for t in btc_trades_3y if t[1]==sn]
    if ts_sn:
        avg_r=sum(t[2] for t in ts_sn)/len(ts_sn)*100
        avg_h=sum(t[3] for t in ts_sn)/len(ts_sn)
        wr=sum(1 for t in ts_sn if t[2]>0)/len(ts_sn)*100
        print(f"    {sn}: {len(ts_sn)} trades avg{avg_r:+.1f}% WR{wr:.0f}% avg_hold{avg_h:.0f}bars")

print(f"\n  SOL (3y):")
print(f"  Total trades: {len(trS)} in {len(cal3)} months = {len(trS)/len(cal3):.1f} trades/month")
for sn in ["S12","S13","S14"]:
    ts_sn=[t for t in trS if t[1]==sn]
    if ts_sn:
        avg_r=sum(t[2] for t in ts_sn)/len(ts_sn)*100
        avg_h=sum(t[3] for t in ts_sn)/len(ts_sn)
        wr=sum(1 for t in ts_sn if t[2]>0)/len(ts_sn)*100
        print(f"    {sn}: {len(ts_sn)} trades avg{avg_r:+.1f}% WR{wr:.0f}% avg_hold{avg_h:.0f}bars")

# ─── R46D: Forward-test calibration ───
print("\n━"*100)
print("R46D: Forward-test calibration — expected metrics per month")
active_mo_btc=sum(1 for m in cal3 if moB.get(m,0.0)!=0)
active_mo_sol=sum(1 for m in cal3 if moS.get(m,0.0)!=0)
active_mo_tur=sum(1 for m in cal3 if turB.get(m,0.0)!=0)
n3=len(cal3)
print(f"  BTC active months: {active_mo_btc}/{n3} = {active_mo_btc/n3*100:.0f}%")
print(f"  SOL active months: {active_mo_sol}/{n3} = {active_mo_sol/n3*100:.0f}%")
print(f"  Turtle active months: {active_mo_tur}/{n3} = {active_mo_tur/n3*100:.0f}%")
print(f"  Any component active: {sum(1 for m in cal3 if moB.get(m,0.0)+moS.get(m,0.0)+turB.get(m,0.0)!=0)}/{n3}")
print()

# Expected monthly return distribution
book3=[( moB.get(m,0.0)+moS.get(m,0.0)+turB.get(m,0.0))/3 for m in cal3]
positive=[x for x in book3 if x>0]; negative=[x for x in book3 if x<0]; flat=[x for x in book3 if x==0]
print(f"  Monthly returns distribution:")
print(f"    Positive: {len(positive)} months avg{sum(positive)/len(positive)*100:+.1f}%")
print(f"    Negative: {len(negative)} months avg{sum(negative)/len(negative)*100:+.1f}%")
print(f"    Flat:     {len(flat)} months (no signal)")
print()

# Recent 6 months — current market state
recent=[m for m in cal3[-6:]]
print(f"  Recent 6 months (most current):")
for m in recent:
    b=moB.get(m,0.0); s=moS.get(m,0.0); t=turB.get(m,0.0); p=(b+s+t)/3
    n_t=cntB.get(m,0)+cntS.get(m,0)
    regs=regB.get(m,{})
    dom=max(regs,key=regs.get) if regs else "?"
    print(f"    {m}: BTC{b*100:>+5.1f}% SOL{s*100:>+5.1f}% TUR{t*100:>+5.1f}% → {p*100:>+5.1f}% [{dom}] {n_t}trades")

print()
print("  FORWARD-TEST EXPECTATIONS:")
print(f"  - In RANGE regime: expect ~{sum(moB.get(m,0.0) for m in range_months)/len(range_months)*100:+.0f}%/month BTC signal, ~{len(btc_trades_3y)/active_mo_btc:.1f} trades/active_month")
print(f"  - Signal cooldown: S13 every 1 bar, S14/S12 every 36 bars (~6 days)")
print(f"  - Max hold: 200×4h = 800h = ~33 days")
print(f"  - Min sample for significance: ~30 trades (expect ~{len(btc_trades_3y)//n3} trades/month avg)")

print("\n"+"="*100)
print("R46 CONCLUSIONS")
print(f"  BTC+SOL correlation (monthly): {corr_bs:+.3f} — {'HIGH corr, partial redundancy' if abs(corr_bs)>0.5 else 'MODERATE corr, meaningful diversification'}")
print(f"  SOL adds value in RANGE: {sol_adds/n_range*100:.0f}% of months — {'useful' if sol_adds/n_range>0.5 else 'marginal'}")
print(f"  BTC/SOL fire independently: {len(btc_only)+len(sol_only)} months only-one-fires vs {len(both_active)} both-fire")
print(f"  Forward-test ready: need {int(30//(len(btc_trades_3y)/n3))} months for 30-trade significance")
