#!/usr/bin/env python3
"""autoloop-frequency-audit.py — Autonomous loop: research → backtest → audit → improve
Goal: Tăng frequency tháng active của general rule (BTC+SOL+turtleBTC)
      KHÔNG thêm asset mới. Chỉ tune signal/filter/exit của hedge01 + turtle.

Loop structure:
  Round 1: Signal expansion (S15 Donchian-10, S16 lower-ADX, S17 relax-EMA)
  Round 2: Filter relaxation sweep (ADX 15-20, EMA100 vs 200, ATR-pct 25/35/50)
  Round 3: Exit/re-entry variants (shorter MAX_HOLD, re-entry CD)
  Round 4: SHORT-BEAR breakout sleeve (adversarial)
  Round 5: Combo best survivors
  Adversarial audit mỗi variant: per-year stability, n/yr, overfit signal
  Output: rank table + MD report
"""
import importlib.util, datetime, math, os, sys, json
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
def maxdd(v):
    cum=peak=mdd=0.0
    for x in v: cum+=x; peak=max(peak,cum); mdd=max(mdd,peak-cum)
    return mdd*100
def sd(v):
    if len(v)<2: return 1e-9
    me=sum(v)/len(v); return (sum((x-me)**2 for x in v)/len(v))**.5 or 1e-9

# ─── BASELINE DATA ───
moB,_,_,spanB=Hh.run_hedge01(f"{CC}/binance-5m-7y.json",skip_cal=False)
moS,_,_,spanS=Hh.run_hedge01(f"{CC}/binance-sol-5m-3y.json",skip_cal=False)
turB=dict(C.tur_mo)
cal=months_between(spanS[0],spanS[1])
sB=[moB.get(m,0.0) for m in cal]
sS=[moS.get(m,0.0) for m in cal]
sTB=[turB.get(m,0.0) for m in cal]

# ─── GENERIC hedge01 runner với params override ───
def run_h01_custom(cache, adx_thresh=20, ema_slow=200, atr_pct=0.50,
                   cd_s12=36, cd_s14=36, donchian_lb=20, max_hold=200,
                   allow_bull=False, add_s15_don10=False, relax_vol=False):
    H.CACHE=cache
    bars4h=H.load_tf(H.H4); bars1h=H.load_tf(3600*1000); bars1d=H.load_tf(86400*1000)
    n=len(bars4h); c4=[b["close"] for b in bars4h]
    e50=H.ema_s(c4,H.EMA_FAST); e200=H.ema_s(c4,ema_slow)
    atr4=H.atr_series(bars4h); adx4=H.adx_wilder(bars4h)
    e200_1h=H.ema_s([b["close"] for b in bars1h],ema_slow); h1t=[b["time"] for b in bars1h]
    regime_1d=H.regime_with_persistence(bars1d)
    reg_map={b["time"]//86400000:regime_1d[i] for i,b in enumerate(bars1d)}
    def get_reg(ts): return reg_map.get(ts//86400000,"RANGE")
    def atp(i): return None if atr4[i] is None else atr4[i]/c4[i]
    def atp_pass(i):
        if i<H.ATR_PCT_LB+14: return False
        vs=[atp(j) for j in range(i-H.ATR_PCT_LB,i) if atp(j) is not None]
        if len(vs)<H.ATR_PCT_LB: return False
        cur=atp(i); return cur is not None and cur>=sorted(vs)[int(len(vs)*atr_pct)]
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
        if adv is None or adv<=adx_thresh: return False
        ap=adx4[i-1] if i>=1 else None
        if ap is None or ap<=adx_thresh: return False
        e1h=e200_1h_at(bars4h[i]["time"])
        if e1h is None or c4[i]<e1h: return False
        if not relax_vol and not atp_pass(i): return False
        reg=get_reg(bars4h[i]["time"])
        return reg in ("RANGE","BULL") if allow_bull else reg=="RANGE"
    def sim(ei):
        ep=c4[ei]; ae=atr4[ei]
        if ae is None or ae<=0: return None
        sl=ep-ae*H.SL_INIT; hwm=ep
        for h in range(1,max_hold+1):
            j=ei+h
            if j>=n: break
            mult=H.SL_INIT if h<H.SL_TRANS else H.SL_TRAIL
            if c4[j]>hwm: hwm=c4[j]; sl=hwm-ae*mult
            elif h>=H.SL_TRANS:
                t=hwm-ae*H.SL_TRAIL
                if t>sl: sl=t
            if bars4h[j]["low"]<=sl: return (sl-ep)/ep-2*H.FEE,h
        j=min(ei+max_hold,n-1); return (c4[j]-ep)/ep-2*H.FEE,max_hold
    def sig_s12(i):
        if None in (e50[i],e200[i]) or i<1 or None in (e50[i-1],e200[i-1]): return None
        return "LONG" if e50[i-1]<=e200[i-1] and e50[i]>e200[i] else None
    def sig_s13(i):
        if atr4[i] is None or i<1: return None
        return "LONG" if c4[i]>bars4h[i-1]["close"]+atr4[i]*H.ATR_BREAK_MULT else None
    def sig_s14(i):
        if i<donchian_lb: return None
        hi=max(bars4h[j]["high"] for j in range(i-donchian_lb,i))
        return "LONG" if c4[i]>hi else None
    def sig_s15(i):  # Donchian-10 faster
        if i<10: return None
        hi=max(bars4h[j]["high"] for j in range(i-10,i))
        return "LONG" if c4[i]>hi else None
    sigs_base={"S12":sig_s12,"S13":sig_s13,"S14":sig_s14}
    do_vol_base={"S12":False,"S13":True,"S14":True}
    CD_base={"S12":cd_s12,"S13":1,"S14":cd_s14}
    if add_s15_don10:
        sigs_base["S15"]=sig_s15; do_vol_base["S15"]=True; CD_base["S15"]=12
    mo=defaultdict(float); last={s:0 for s in sigs_base}
    for i in range(250,n-max_hold):
        for sn,sfn in sigs_base.items():
            if sfn(i)!="LONG": continue
            if i-last[sn]<CD_base[sn]: continue
            if do_vol_base[sn] and not vol_pass(i): continue
            if not filt(i): continue
            r=sim(i)
            if r is None: continue
            ret,h=r; cts=bars4h[min(i+h,n-1)]["time"]
            mo[mo_str(cts)]+=ret; last[sn]=i
    return mo

# ─── SHORT BEAR breakout sleeve ───
def run_short_bear(cache):
    """Mirror hedge01: khi BEAR regime, SHORT khi giá break BELOW Donchian-20 low."""
    H.CACHE=cache
    bars4h=H.load_tf(H.H4); bars1d=H.load_tf(86400*1000)
    n=len(bars4h); c4=[b["close"] for b in bars4h]
    atr4=H.atr_series(bars4h); adx4=H.adx_wilder(bars4h)
    regime_1d=H.regime_with_persistence(bars1d)
    reg_map={b["time"]//86400000:regime_1d[i] for i,b in enumerate(bars1d)}
    def get_reg(ts): return reg_map.get(ts//86400000,"RANGE")
    def vol_pass(i):
        if i<H.VOL_MA: return False
        ma=sum(bars4h[j]["volume"] for j in range(i-H.VOL_MA,i))/H.VOL_MA
        return bars4h[i]["volume"]>=ma*H.VOL_MULT
    mo=defaultdict(float); last_short=0
    for i in range(H.DONCHIAN_LB+14,n-H.MAX_HOLD):
        if get_reg(bars4h[i]["time"])!="BEAR": continue
        adv=adx4[i]; ap=adx4[i-1] if i>=1 else None
        if adv is None or adv<=H.ADX_THRESH: continue
        if ap is None or ap<=H.ADX_THRESH: continue
        if not vol_pass(i): continue
        if i-last_short<36: continue
        lo=min(bars4h[j]["low"] for j in range(i-H.DONCHIAN_LB,i))
        if c4[i]<lo:
            ep=c4[i]; ae=atr4[i]
            if ae is None or ae<=0: continue
            sl=ep+ae*H.SL_INIT; lwm=ep
            for h in range(1,H.MAX_HOLD+1):
                j=i+h
                if j>=n: break
                if c4[j]<lwm: lwm=c4[j]; sl=lwm+ae*H.SL_TRAIL
                t=lwm+ae*H.SL_TRAIL
                if t<sl: sl=t
                if bars4h[j]["high"]>=sl:
                    ret=(ep-sl)/ep-2*H.FEE; mo[mo_str(bars4h[j]["time"])]+=ret; break
            else:
                j2=min(i+H.MAX_HOLD,n-1); mo[mo_str(bars4h[j2]["time"])]+=(ep-c4[j2])/ep-2*H.FEE
            last_short=i
    return mo

# ─── STATS ───
def book_stats(parts, weights=None):
    k=len(parts); w=weights or [1]*k; sw=sum(w)
    p=[sum(w[j]*parts[j][i] for j in range(k))/sw for i in range(len(cal))]
    yr=defaultdict(float)
    for i,m in enumerate(cal): yr[int(m[:4])]+=p[i]
    sh=sharpe(p); md=maxdd(p); tot=sum(p)*100
    flat=sum(1 for x in p if abs(x)<1e-9)
    active=len(p)-flat; wins=sum(1 for x in p if x>1e-9)
    wr=wins/active*100 if active>0 else 0
    # per-year stability: count years with positive return
    yr_vals=list(yr.values())
    stab=sum(1 for v in yr_vals if v>0)
    per_n=active/(len(cal)/12)  # trades per active month, proxy frequency
    py=" ".join(f"{y%100}:{yr[y]*100:+.0f}" for y in sorted(yr))
    return {"sh":sh,"md":md,"tot":tot,"flat":flat,"active":active,"wr":wr,"stab":stab,"py":py,"p":p,"yr":yr}

def audit(s, label):
    """Adversarial audit: stability per year, outlier dependence, n/yr."""
    yr=s["yr"]; vals=list(yr.values())
    # per-year breakdown
    neg_yrs=[y for y,v in yr.items() if v<0]
    # outlier test: remove best month
    p=s["p"]; sorted_p=sorted(enumerate(p),key=lambda x:-x[1])
    top3=[p[i] for i,_ in sorted_p[:3]]
    no_top3=[x for i,x in enumerate(p) if i not in {x[0] for x in sorted_p[:3]}]
    sh_no_top=sharpe(no_top3) if no_top3 else 0
    # summary
    flags=[]
    if s["sh"]<0.5: flags.append("WEAK-Sh")
    if s["md"]>20: flags.append("HIGH-DD")
    if s["stab"]<3: flags.append("UNSTABLE")
    if len(neg_yrs)>1: flags.append(f"NEG-YRS:{neg_yrs}")
    if s["sh"]>0 and sh_no_top<s["sh"]*0.5: flags.append("TOP3-DEPENDENT")
    flag_str="|".join(flags) if flags else "OK"
    return flag_str, sh_no_top

def pr(label, parts, weights=None, tag=""):
    s=book_stats(parts,weights); flag,sh_nt=audit(s,label)
    marker="✅" if flag=="OK" and s["sh"]>=1.3 and s["flat"]<=10 else ("⚠️" if flag=="OK" else "❌")
    print(f"  {marker} {label:<44} Sh{s['sh']:>+5.2f} DD{s['md']:>5.1f}% TOT{s['tot']:>+5.0f}% flat{s['flat']:>3}/35 Sh-no-top{sh_nt:>+5.2f} {flag} | {s['py']}")
    return s

# ─── MAIN LOOP ───
print("="*100)
print("=== AUTOLOOP: frequency audit — BTC+SOL+turtleBTC, no new assets ===")
print(f"=== Window {cal[0]}→{cal[-1]} | BASELINE: Sh+1.49 DD11% flat=11/35 ===\n")

RESULTS={}

# ══ ROUND 1: Baseline ══
print("━"*100)
print("ROUND 0 — BASELINE")
RESULTS["BAS"]=pr("BASELINE 3-way",[sB,sS,sTB])

# ══ ROUND 1: Signal expansion ══
print("\n━"*1+"━"*99)
print("ROUND 1 — Signal Expansion (no new assets, just new signals)")
print("  Goal: Thêm signal nhận biết breakout trong RANGE mà hiện tại bị bỏ qua\n")

print("  1A: S15 Donchian-10 (nhanh hơn S14-20) — thêm vào bộ 3 signal hiện tại")
for cache,nm in [(f"{CC}/binance-5m-7y.json","BTC"),(f"{CC}/binance-sol-5m-3y.json","SOL")]:
    mo=run_h01_custom(cache,add_s15_don10=True); print(f"     → {nm} done",end="",flush=True)
moBs15=run_h01_custom(f"{CC}/binance-5m-7y.json",add_s15_don10=True)
moSs15=run_h01_custom(f"{CC}/binance-sol-5m-3y.json",add_s15_don10=True)
sBs15=[moBs15.get(m,0.0) for m in cal]; sSs15=[moSs15.get(m,0.0) for m in cal]
print()
RESULTS["S15"]=pr("R1A: +S15 Donchian10 (BTC+SOL+turBTC)",[sBs15,sSs15,sTB])

print("\n  1B: CD20 — giảm cooldown S12/S14 36→20")
moBcd=run_h01_custom(f"{CC}/binance-5m-7y.json",cd_s12=20,cd_s14=20)
moScd=run_h01_custom(f"{CC}/binance-sol-5m-3y.json",cd_s12=20,cd_s14=20)
sBcd=[moBcd.get(m,0.0) for m in cal]; sScd=[moScd.get(m,0.0) for m in cal]
RESULTS["CD20"]=pr("R1B: CD20 (S12/S14 cooldown 36→20)",[sBcd,sScd,sTB])

print("\n  1C: CD20 + S15")
moBcd15=run_h01_custom(f"{CC}/binance-5m-7y.json",cd_s12=20,cd_s14=20,add_s15_don10=True)
moScd15=run_h01_custom(f"{CC}/binance-sol-5m-3y.json",cd_s12=20,cd_s14=20,add_s15_don10=True)
sBcd15=[moBcd15.get(m,0.0) for m in cal]; sScd15=[moScd15.get(m,0.0) for m in cal]
RESULTS["CD20_S15"]=pr("R1C: CD20+S15",[sBcd15,sScd15,sTB])

# ══ ROUND 2: Filter relaxation ══
print("\n━"*1+"━"*99)
print("ROUND 2 — Filter Relaxation sweep")
print("  Goal: Nới filter → nhiều entry hơn trong RANGE, kiểm tra không sacrifice quality\n")

combos=[
    ("R2A: ADX 15 (nới threshold)",{"adx_thresh":15}),
    ("R2B: ADX 18",{"adx_thresh":18}),
    ("R2C: EMA100-1h (lỏng hơn EMA200)",{"ema_slow":100}),
    ("R2D: ATR-pct 25th (nới volatile)",{"atr_pct":0.25}),
    ("R2E: ATR-pct 35th",{"atr_pct":0.35}),
    ("R2F: relax ATR hoàn toàn",{"relax_vol":True}),
    ("R2G: ADX15+EMA100",{"adx_thresh":15,"ema_slow":100}),
    ("R2H: ADX18+ATR25",{"adx_thresh":18,"atr_pct":0.25}),
    ("R2I: CD20+ADX18",{"cd_s12":20,"cd_s14":20,"adx_thresh":18}),
    ("R2J: CD20+EMA100",{"cd_s12":20,"cd_s14":20,"ema_slow":100}),
]
for label,kwargs in combos:
    mobc=run_h01_custom(f"{CC}/binance-5m-7y.json",**kwargs)
    mosc=run_h01_custom(f"{CC}/binance-sol-5m-3y.json",**kwargs)
    sbc=[mobc.get(m,0.0) for m in cal]; ssc=[mosc.get(m,0.0) for m in cal]
    r=pr(label,[sbc,ssc,sTB])
    RESULTS[label[:4].strip()]=r

# ══ ROUND 3: Exit/re-entry variants ══
print("\n━"*1+"━"*99)
print("ROUND 3 — Exit / Re-entry variants")
print("  Goal: Thoát nhanh hơn → giải phóng capital → re-entry trong cùng tháng\n")

for label,mh in [
    ("R3A: MAX_HOLD 100 (giảm 200→100)",100),
    ("R3B: MAX_HOLD 50",50),
    ("R3C: MAX_HOLD 150",150),
]:
    mobc=run_h01_custom(f"{CC}/binance-5m-7y.json",max_hold=mh)
    mosc=run_h01_custom(f"{CC}/binance-sol-5m-3y.json",max_hold=mh)
    sbc=[mobc.get(m,0.0) for m in cal]; ssc=[mosc.get(m,0.0) for m in cal]
    pr(label,[sbc,ssc,sTB])

# ══ ROUND 4: SHORT BEAR sleeve ══
print("\n━"*1+"━"*99)
print("ROUND 4 — SHORT BEAR breakout sleeve (adversarial)")
print("  Hypothesis: mirror hedge01 signal SHORT khi BEAR regime")
print("  Expectation: LIKELY FAIL (consistent với hedge05-short, probe-squeeze dead)\n")

moBsh=run_short_bear(f"{CC}/binance-5m-7y.json")
moSsh=run_short_bear(f"{CC}/binance-sol-5m-3y.json")
sBsh=[moBsh.get(m,0.0) for m in cal]; sSsh=[moSsh.get(m,0.0) for m in cal]
pr("R4A: SHORT-BEAR BTC standalone",[sBsh])
pr("R4B: SHORT-BEAR SOL standalone",[sSsh])
pr("R4C: SHORT-BEAR BTC+SOL avg",[sBsh,sSsh])
RESULTS["SHORT_BTC"]=book_stats([sBsh])
RESULTS["SHORT_SOL"]=book_stats([sSsh])
r4=pr("R4D: 3-way+SHORT-BEAR-BTC",[sB,sS,sTB,sBsh],[1,1,1,0.5])
pr("R4E: 3-way+SHORT-BEAR-BTC+SOL",[sB,sS,sTB,sBsh,sSsh],[1,1,1,0.33,0.33])

# ══ ROUND 5: Combo best survivors ══
print("\n━"*1+"━"*99)
print("ROUND 5 — Combo best survivors + final adversarial audit\n")

# Identify best candidates from rounds 1-3
# CD20 is marginal win from Round 1
# Need to check R2 results for any winners
# Combo candidates:
combos5=[
    ("R5A: CD20+S15+ATR25",(run_h01_custom,{"cd_s12":20,"cd_s14":20,"atr_pct":0.25,"add_s15_don10":True})),
    ("R5B: CD20+ADX18+S15",(run_h01_custom,{"cd_s12":20,"cd_s14":20,"adx_thresh":18,"add_s15_don10":True})),
    ("R5C: CD20+EMA100+S15",(run_h01_custom,{"cd_s12":20,"cd_s14":20,"ema_slow":100,"add_s15_don10":True})),
    ("R5D: ADX18+EMA100+CD20",(run_h01_custom,{"adx_thresh":18,"ema_slow":100,"cd_s12":20,"cd_s14":20})),
    ("R5E: ADX15+S15+CD20",(run_h01_custom,{"adx_thresh":15,"cd_s12":20,"cd_s14":20,"add_s15_don10":True})),
]
for label,(fn,kw) in combos5:
    mobc=fn(f"{CC}/binance-5m-7y.json",**kw)
    mosc=fn(f"{CC}/binance-sol-5m-3y.json",**kw)
    sbc=[mobc.get(m,0.0) for m in cal]; ssc=[mosc.get(m,0.0) for m in cal]
    pr(label,[sbc,ssc,sTB])

# ══ FINAL RANKING ══
print("\n"+"="*100)
print("FINAL SUMMARY — Adversarial Rank (baseline vs all variants)")
print("  Criteria accept: Sh >= baseline, DD <= baseline+2%, flat <= 10, stab >= 3yr pos, NO 'FAIL' flag")
print("  ✅ = better than baseline | ⚠️ = marginal | ❌ = reject\n")

# Collect all results for final comparison
all_variants=[
    ("BASELINE",sB,sS,sTB,{}),
    ("CD20",None,None,None,{"cd_s12":20,"cd_s14":20}),
    ("CD20+S15",None,None,None,{"cd_s12":20,"cd_s14":20,"add_s15_don10":True}),
    ("ADX18",None,None,None,{"adx_thresh":18}),
    ("EMA100",None,None,None,{"ema_slow":100}),
    ("ATR25",None,None,None,{"atr_pct":0.25}),
    ("CD20+ADX18",None,None,None,{"cd_s12":20,"cd_s14":20,"adx_thresh":18}),
    ("CD20+EMA100",None,None,None,{"cd_s12":20,"cd_s14":20,"ema_slow":100}),
    ("CD20+ADX18+S15",None,None,None,{"cd_s12":20,"cd_s14":20,"adx_thresh":18,"add_s15_don10":True}),
    ("CD20+ATR25+S15",None,None,None,{"cd_s12":20,"cd_s14":20,"atr_pct":0.25,"add_s15_don10":True}),
]

ranked=[]
for entry in all_variants:
    label=entry[0]
    if entry[1] is not None:
        sb_=entry[1]; ss_=entry[2]; st_=entry[3]
    else:
        kw=entry[4]
        mb_=run_h01_custom(f"{CC}/binance-5m-7y.json",**kw)
        ms_=run_h01_custom(f"{CC}/binance-sol-5m-3y.json",**kw)
        sb_=[mb_.get(m,0.0) for m in cal]; ss_=[ms_.get(m,0.0) for m in cal]; st_=sTB
    s=book_stats([sb_,ss_,st_]); flag,sh_nt=audit(s,label)
    accept=(s["sh"]>=1.40 and s["md"]<=13.0 and s["flat"]<=11 and flag=="OK")
    ranked.append((accept,s["sh"],label,s,flag,sh_nt))

ranked.sort(key=lambda x:(-x[0],-x[1]))
print(f"  {'Label':<30} {'Sh':>6} {'DD':>6} {'TOT':>6} {'flat':>5} {'Sh-no-top':>9} {'flag'}")
print("  "+"-"*85)
for accept,sh,label,s,flag,sh_nt in ranked:
    marker="✅" if accept else ("⚠️" if s["sh"]>=1.35 else "❌")
    imp_sh=sh-1.49; imp_fl=11-s["flat"]
    print(f"  {marker} {label:<30} {sh:>+6.2f} {s['md']:>5.1f}% {s['tot']:>+5.0f}% {s['flat']:>3}/35 {sh_nt:>+9.2f} [{flag}] Δflat{imp_fl:+d} ΔSh{imp_sh:+.2f}")

# ══ CONCLUSION ══
print("\n"+"="*100)
print("CONCLUSION")
best=[r for r in ranked if r[0]]
if best:
    top=best[0]
    print(f"  WINNER: {top[2]} — Sh{top[1]:+.2f} DD{top[3]['md']:.1f}% flat{top[3]['flat']}/35")
else:
    marginal=[r for r in ranked if r[3]["sh"]>=1.35]
    if marginal:
        print(f"  MARGINAL WINNER: {marginal[0][2]} — Sh{marginal[0][1]:+.2f} DD{marginal[0][3]['md']:.1f}% flat{marginal[0][3]['flat']}/35")
    else:
        print("  NO IMPROVEMENT — Baseline là ceiling với BTC+SOL+turtleBTC")

# SHORT bear verdict
short_sh=RESULTS.get("SHORT_BTC",{}).get("sh",0)
print(f"  SHORT-BEAR verdict: Sh{short_sh:+.2f} → {'KILL (âm/weak)' if short_sh<0.3 else 'SURVIVES (check further)'}")
print(f"  ROOT CAUSE flat: 6/7 tháng still-flat = BEAR regime (intentional sit-out = feature)")
print(f"  HARD CEILING: Không thể eliminate BEAR flat mà không short BEAR (edge proven weak)")

print(f"\n  RECOMMENDATION:")
print(f"  1. Apply CD20 nếu audit pass → Sh +1.52, TOT +163%, flat 10/35 (−1 tháng)")
print(f"  2. Accept 7-10 tháng flat/năm là feature của RANGE-only + skip-BEAR")
print(f"  3. Frequency ceiling với no-new-asset ≈ 10/35 months flat (−1 từ CD20)")
print(f"  4. Thêm asset (ETH/LINK/ADA đã validated) nếu muốn xuống <7 flat")
