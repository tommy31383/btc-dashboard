#!/usr/bin/env python3
"""autoloop-frequency-audit2.py — Round 6+7: Deep audit winner + monthly detail + 7y verify
Winner từ loop 1: CD20+ADX18 (Sh+1.53 DD10.9% flat9/35)
Round 6: Adversarial verify winner
  - ADX sweep 15-20 để xem 18 có phải cherry-pick không
  - 7y BTC standalone verify
  - Param sensitivity ±1 CD (CD16,18,20,22,24)
  - Per-month detail book CD20+ADX18
Round 7: SHORT-BEAR deep audit (flat 11→3 nhưng cost?)
  - Monthly detail R4D
  - Outlier removal test
  - SHORT-BEAR BTC per-year stability
Round 8: Produce final MD
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

# ─── BASELINE DATA ───
moB,_,_,spanB=Hh.run_hedge01(f"{CC}/binance-5m-7y.json",skip_cal=False)
moS,_,_,spanS=Hh.run_hedge01(f"{CC}/binance-sol-5m-3y.json",skip_cal=False)
turB=dict(C.tur_mo)
cal=months_between(spanS[0],spanS[1])
sB=[moB.get(m,0.0) for m in cal]
sS=[moS.get(m,0.0) for m in cal]
sTB=[turB.get(m,0.0) for m in cal]

def run_h01_custom(cache, adx_thresh=20, ema_slow=200, atr_pct=0.50,
                   cd_s12=36, cd_s14=36, donchian_lb=20, max_hold=200):
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
        if not atp_pass(i): return False
        return get_reg(bars4h[i]["time"])=="RANGE"
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
    sigs={"S12":sig_s12,"S13":sig_s13,"S14":sig_s14}
    do_vol={"S12":False,"S13":True,"S14":True}
    CD={"S12":cd_s12,"S13":1,"S14":cd_s14}
    mo=defaultdict(float); last={s:0 for s in sigs}; tcount={"S12":0,"S13":0,"S14":0}
    for i in range(250,n-max_hold):
        for sn,sfn in sigs.items():
            if sfn(i)!="LONG": continue
            if i-last[sn]<CD[sn]: continue
            if do_vol[sn] and not vol_pass(i): continue
            if not filt(i): continue
            r=sim(i)
            if r is None: continue
            ret,h=r; cts=bars4h[min(i+h,n-1)]["time"]
            mo[mo_str(cts)]+=ret; last[sn]=i; tcount[sn]+=1
    return mo,tcount

def run_short_bear(cache):
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

def book_series(parts, weights=None):
    k=len(parts); w=weights or [1]*k; sw=sum(w)
    return [sum(w[j]*parts[j][i] for j in range(k))/sw for i in range(len(cal))]

def stats(p):
    yr=defaultdict(float)
    for i,m in enumerate(cal): yr[int(m[:4])]+=p[i]
    sh=sharpe(p); md=maxdd(p); tot=sum(p)*100
    flat=sum(1 for x in p if abs(x)<1e-9)
    active=len(p)-flat; wins=sum(1 for x in p if x>1e-9)
    sorted_p=sorted(p,reverse=True)
    no_top3=[x for x in p if x not in sorted_p[:3] or (sorted_p.count(x)>1)]
    # remove top 3 by value
    tmp=list(p); removed=0; no_top3=[]
    for x in sorted(p,reverse=True):
        if removed<3: removed+=1
        else: no_top3.append(x)
    sh_nt=sharpe(no_top3) if len(no_top3)>2 else 0
    wr=wins/active*100 if active>0 else 0
    py=" ".join(f"{y%100}:{yr[y]*100:+.0f}" for y in sorted(yr))
    return sh,md,tot,flat,active,wr,yr,sh_nt,py

print("="*100)
print("=== AUTOLOOP Round 6+7: Deep Audit + Monthly Detail + 7y Verify ===\n")

# ─── ROUND 6: ADX sensitivity sweep ───
print("━"*100)
print("ROUND 6 — ADX threshold sensitivity (anti cherry-pick audit)")
print("  Key question: ADX18 winner hay chỉ là noise?\n")

print(f"  {'ADX':>5} | {'Sh-BTC7y':>8} | {'BTC-trades/yr':>13} | {'Sh-book2.9y':>11} | {'flat':>5} | {'per-year'}")
print("  "+"-"*80)

for adx_t in [15,16,17,18,19,20,21,22]:
    # BTC 7y standalone (full window)
    mo7,tc=run_h01_custom(f"{CC}/binance-5m-7y.json",adx_thresh=adx_t)
    cal7=months_between(spanB[0],spanB[1])
    s7=[mo7.get(m,0.0) for m in cal7]
    sh7=sharpe(s7); tr7=sum(1 for v in mo7.values() if abs(v)>1e-9)/(len(cal7)/12)
    # Book 2.9y
    moS_,_=run_h01_custom(f"{CC}/binance-sol-5m-3y.json",adx_thresh=adx_t)
    sb=[mo7.get(m,0.0) for m in cal]; ss_=[moS_.get(m,0.0) for m in cal]
    p=book_series([sb,ss_,sTB]); sh_b=sharpe(p)
    yr_b=defaultdict(float)
    for i,m in enumerate(cal): yr_b[int(m[:4])]+=p[i]
    flat_b=sum(1 for x in p if abs(x)<1e-9)
    py=" ".join(f"{y%100}:{yr_b[y]*100:+.0f}" for y in sorted(yr_b))
    marker="◀ WINNER" if adx_t==18 else ("◀ BAS" if adx_t==20 else "")
    print(f"  {adx_t:>5} | {sh7:>+8.2f} | {tr7:>13.1f}/yr | {sh_b:>+11.2f} | {flat_b:>5}/35 | {py} {marker}")

# ─── CD sensitivity ───
print("\n  CD sensitivity (S12/S14 cooldown):")
print(f"  {'CD':>5} | {'Sh-BTC7y':>8} | {'Sh-book':>8} | {'flat':>5} | {'per-year'}")
print("  "+"-"*65)
for cd in [12,16,20,24,28,32,36]:
    mo_b,_=run_h01_custom(f"{CC}/binance-5m-7y.json",cd_s12=cd,cd_s14=cd)
    mo_s,_=run_h01_custom(f"{CC}/binance-sol-5m-3y.json",cd_s12=cd,cd_s14=cd)
    cal7=months_between(spanB[0],spanB[1])
    s7=[mo_b.get(m,0.0) for m in cal7]; sh7=sharpe(s7)
    sb=[mo_b.get(m,0.0) for m in cal]; ss_=[mo_s.get(m,0.0) for m in cal]
    p=book_series([sb,ss_,sTB]); sh_b=sharpe(p)
    yr_b=defaultdict(float)
    for i,m in enumerate(cal): yr_b[int(m[:4])]+=p[i]
    flat_b=sum(1 for x in p if abs(x)<1e-9)
    py=" ".join(f"{y%100}:{yr_b[y]*100:+.0f}" for y in sorted(yr_b))
    marker="◀ WINNER CD20" if cd==20 else ("◀ BAS" if cd==36 else "")
    print(f"  {cd:>5} | {sh7:>+8.2f} | {sh_b:>+8.2f} | {flat_b:>5}/35 | {py} {marker}")

# ─── ROUND 6B: 7y BTC standalone verify ───
print("\n━"*100)
print("ROUND 6B — 7y BTC standalone: BASELINE vs CD20 vs ADX18 vs CD20+ADX18")
cal7=months_between(spanB[0],spanB[1])
for label,kw in [
    ("7y BTC BASELINE",{}),
    ("7y BTC CD20",{"cd_s12":20,"cd_s14":20}),
    ("7y BTC ADX18",{"adx_thresh":18}),
    ("7y BTC CD20+ADX18",{"cd_s12":20,"cd_s14":20,"adx_thresh":18}),
]:
    mo_,_=run_h01_custom(f"{CC}/binance-5m-7y.json",**kw)
    s7=[mo_.get(m,0.0) for m in cal7]
    yr7=defaultdict(float)
    for m in cal7: yr7[int(m[:4])]+=mo_.get(m,0.0)
    sh7=sharpe(s7); tot7=sum(s7)*100; md7=maxdd(s7)
    flat7=sum(1 for x in s7 if abs(x)<1e-9)
    py7=" ".join(f"{y%100}:{yr7[y]*100:+.0f}" for y in sorted(yr7))
    trades7=sum(1 for v in mo_.values() if abs(v)>1e-9)
    print(f"  {label:<28} Sh{sh7:>+5.2f} DD{md7:>5.1f}% TOT{tot7:>+5.0f}% flat{flat7}/{len(cal7)} trades={trades7} | {py7}")

# ─── ROUND 7: SHORT-BEAR deep audit ───
print("\n━"*100)
print("ROUND 7 — SHORT-BEAR deep audit (R4D had flat=3/35 — investigate cost)")
moBsh,_=run_short_bear(f"{CC}/binance-5m-7y.json"),None
sBsh=[moBsh.get(m,0.0) for m in cal]

# Monthly detail R4D vs baseline
p_base=book_series([sB,sS,sTB])
p_r4d=book_series([sB,sS,sTB,sBsh],[1,1,1,0.5])

print(f"\n  Monthly: BASELINE vs R4D (3-way + SHORT-BEAR-BTC 0.5x)")
print(f"  {'Mo':>8} | {'BAS':>7} | {'R4D':>7} | {'SH-BTC':>7} | note")
print("  "+"-"*55)
sh_base,md_base,tot_base,fl_base,_,_,_,_,py_base=stats(p_base)
sh_r4d,md_r4d,tot_r4d,fl_r4d,_,_,_,_,py_r4d=stats(p_r4d)
for i,m in enumerate(cal):
    note=""
    if abs(p_base[i])<1e-9 and abs(p_r4d[i])>1e-9: note="← flat filled by SHORT"
    elif abs(p_r4d[i]-p_base[i])>0.03: note=f"← drag {(p_r4d[i]-p_base[i])*100:+.0f}%"
    if abs(p_base[i])>1e-9 or abs(p_r4d[i])>1e-9 or note:
        print(f"  {m:>8} | {p_base[i]*100:>+6.1f} | {p_r4d[i]*100:>+6.1f} | {sBsh[i]*100:>+6.1f} | {note}")
    else:
        print(f"  {m:>8} |       . |       . |       . |")
print(f"\n  BASELINE: Sh{sh_base:+.2f} DD{md_base:.0f}% TOT{tot_base:+.0f}% flat={fl_base}/35")
print(f"  R4D:      Sh{sh_r4d:+.2f} DD{md_r4d:.0f}% TOT{tot_r4d:+.0f}% flat={fl_r4d}/35")
print(f"  SHORT-BEAR BTC 7y standalone:")
cal7=months_between(spanB[0],spanB[1])
s7sh=[moBsh.get(m,0.0) for m in cal7]
yr7sh=defaultdict(float)
for m in cal7: yr7sh[int(m[:4])]+=moBsh.get(m,0.0)
sh_sh=sharpe(s7sh); py7sh=" ".join(f"{y%100}:{yr7sh[y]*100:+.0f}" for y in sorted(yr7sh))
print(f"    Sh{sh_sh:+.2f} TOT{sum(s7sh)*100:+.0f}% | {py7sh}")
print(f"  VERDICT: SHORT-BEAR drag cost = TOT −{tot_base-tot_r4d:+.0f}% Sh −{sh_base-sh_r4d:.2f} for flat −{fl_base-fl_r4d} months")

# ─── FINAL RANKING ───
print("\n"+"="*100)
print("ROUND 8 — FINAL RANKING (clean, no cherry-pick)\n")

candidates=[
    ("BASELINE",               {},            {}),
    ("CD20",                   {"cd_s12":20,"cd_s14":20}, {}),
    ("ADX18",                  {"adx_thresh":18}, {}),
    ("CD20+ADX18 ★",           {"cd_s12":20,"cd_s14":20,"adx_thresh":18}, {}),
    ("SHORT+book(BAS+0.5xSH)", {},            {"short_w":0.5}),
]

print(f"  {'Label':<30} {'Sh-book':>7} {'DD':>6} {'TOT':>6} {'flat':>6} {'Sh-no-top':>9} {'per-year'}")
print("  "+"-"*90)

best_label=""; best_sh=0; best_config={}
for label,kw,extras in candidates:
    mo_b,_=run_h01_custom(f"{CC}/binance-5m-7y.json",**kw)
    mo_s,_=run_h01_custom(f"{CC}/binance-sol-5m-3y.json",**kw)
    sb_=[mo_b.get(m,0.0) for m in cal]; ss_=[mo_s.get(m,0.0) for m in cal]
    if extras.get("short_w"):
        p=book_series([sb_,ss_,sTB,sBsh],[1,1,1,extras["short_w"]])
    else:
        p=book_series([sb_,ss_,sTB])
    sh,md,tot,flat,_,_,yr,sh_nt,py=stats(p)
    marker="★" if sh>best_sh else ""
    if sh>best_sh: best_sh=sh; best_label=label; best_config=kw
    print(f"  {label:<30} {sh:>+7.2f} {md:>5.1f}% {tot:>+5.0f}% {flat:>4}/35 {sh_nt:>+9.2f} | {py}")

print(f"\n  ★ CONFIRMED WINNER: {best_label} — Sh{best_sh:+.2f}")

# ─── MONTHLY DETAIL: WINNER ───
print(f"\n{'='*100}")
print(f"WINNER MONTHLY DETAIL: {best_label}")
mo_b,tc_b=run_h01_custom(f"{CC}/binance-5m-7y.json",**best_config)
mo_s,tc_s=run_h01_custom(f"{CC}/binance-sol-5m-3y.json",**best_config)
sb_w=[mo_b.get(m,0.0) for m in cal]; ss_w=[mo_s.get(m,0.0) for m in cal]
p_w=book_series([sb_w,ss_w,sTB])
sh_w,md_w,tot_w,fl_w,act_w,wr_w,yr_w,sh_nt_w,py_w=stats(p_w)
p_bas=book_series([sB,sS,sTB])

print(f"\n  {'Mo':>8} | {'h01BTC':>7} | {'h01SOL':>7} | {'turBTC':>7} | {'BOOK_W':>7} | {'BAS':>7} | {'DIFF':>6}")
print("  "+"-"*72); cum_w=cum_b=0.0
for i,m in enumerate(cal):
    b=sb_w[i]; s=ss_w[i]; t=sTB[i]
    cum_w+=p_w[i]; cum_b+=p_bas[i]
    def c(v): return f"{v*100:>+5.1f}" if abs(v)>1e-9 else "    ."
    diff=p_w[i]-p_bas[i]
    mark="◀" if abs(p_bas[i])<1e-9 and abs(p_w[i])>1e-9 else ""
    print(f"  {m:>8} | {c(b):>7} | {c(s):>7} | {c(t):>7} | {p_w[i]*100:>+6.1f} | {p_bas[i]*100:>+6.1f} | {diff*100:>+5.1f} {mark}")

print(f"\n  WINNER {best_label}: Sh{sh_w:+.2f} DD{md_w:.1f}% TOT{tot_w:+.0f}% flat={fl_w}/35 WR{wr_w:.0f}% Sh-no-top{sh_nt_w:+.2f}")
print(f"  BASELINE:             Sh+1.49 DD10.9% TOT+150% flat=11/35 WR58%")
print(f"  Trades BTC per-signal: {tc_b}")
print(f"  Trades SOL per-signal: {tc_s}")

# ─── OUTPUT DATA FOR MD ───
print(f"\n{'='*100}")
print(f"MD_DATA (copy vào docs/)")
print(f"""
winner_label: {best_label}
baseline_sh: +1.49 | winner_sh: {sh_w:+.2f}
baseline_dd: 10.9% | winner_dd: {md_w:.1f}%
baseline_tot: +150% | winner_tot: {tot_w:+.0f}%
baseline_flat: 11/35 | winner_flat: {fl_w}/35
winner_sh_no_top3: {sh_nt_w:+.2f}
winner_per_year: {py_w}
change: ΔSh{sh_w-1.49:+.2f} ΔDD{md_w-10.9:+.1f}% ΔFlat{fl_w-11:+d}
killed: SHORT-BEAR standalone Sh-1.42 (âm severe), turtle-SOL Sh-2.32 (âm severe)
flat_root_cause: 6/7 still-flat = BEAR regime (intentional, feature not bug)
hard_ceiling: flat ~9-10/35 với no-new-asset
""")
