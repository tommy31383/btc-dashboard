#!/usr/bin/env python3
"""autoloop-r13-nos14-combo.py — Round 13: No-S14 + All combos + Final adversarial
Finding R11: Skip S14 → Sh+1.60 (+0.10 vs ADX18+1.50)
Finding R12: FULL BTC18+SOL15+SI3/ST3.5/TR16 → Sh+1.82
Goal: Test no-S14 × all improvements × 7y verify
R13A: No-S14 standalone variants
R13B: No-S14 + combo (BTC18+SOL15, SL3/3.5/16)
R13C: Stability: per-year stab, Sh-no-top3
R13D: Final ranking all discovered improvements
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

_,_,_,spanB=Hh.run_hedge01(f"{CC}/binance-5m-7y.json",skip_cal=False)
_,_,_,spanS=Hh.run_hedge01(f"{CC}/binance-sol-5m-3y.json",skip_cal=False)
turB=dict(C.tur_mo)
cal=months_between(spanS[0],spanS[1])
cal7=months_between(spanB[0],spanB[1])
sTB=[turB.get(m,0.0) for m in cal]

def run_h01(cache, adx_thresh=18, sl_init=4.0, sl_trail=3.0, sl_trans=24,
            cd_s12=36, cd_s14=36, skip_s14=False, skip_s12=False):
    H.CACHE=cache
    orig_adx=H.ADX_THRESH; orig_si=H.SL_INIT; orig_st=H.SL_TRAIL; orig_tr=H.SL_TRANS
    H.ADX_THRESH=adx_thresh; H.SL_INIT=sl_init; H.SL_TRAIL=sl_trail; H.SL_TRANS=sl_trans
    bars4h=H.load_tf(H.H4); bars1h=H.load_tf(3600*1000); bars1d=H.load_tf(86400*1000)
    n=len(bars4h); c4=[b["close"] for b in bars4h]
    e50=H.ema_s(c4,H.EMA_FAST); e200=H.ema_s(c4,H.EMA_SLOW)
    atr4=H.atr_series(bars4h); adx4=H.adx_wilder(bars4h)
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
    def sig_s12(i):
        if None in (e50[i],e200[i]) or i<1 or None in (e50[i-1],e200[i-1]): return None
        return "LONG" if e50[i-1]<=e200[i-1] and e50[i]>e200[i] else None
    def sig_s13(i):
        if atr4[i] is None or i<1: return None
        return "LONG" if c4[i]>bars4h[i-1]["close"]+atr4[i]*H.ATR_BREAK_MULT else None
    def sig_s14(i):
        if i<H.DONCHIAN_LB: return None
        hi=max(bars4h[j]["high"] for j in range(i-H.DONCHIAN_LB,i))
        return "LONG" if c4[i]>hi else None
    sigs={"S13":sig_s13}
    do_vol={"S13":True}
    CD_={"S13":1}
    if not skip_s12:
        sigs["S12"]=sig_s12; do_vol["S12"]=False; CD_["S12"]=cd_s12
    if not skip_s14:
        sigs["S14"]=sig_s14; do_vol["S14"]=True; CD_["S14"]=cd_s14
    mo=defaultdict(float); last={s:0 for s in sigs}
    for i in range(250,n-H.MAX_HOLD):
        for sn,sfn in sigs.items():
            if sfn(i)!="LONG": continue
            if i-last[sn]<CD_.get(sn,1): continue
            if do_vol[sn] and not vol_pass(i): continue
            if not filt(i): continue
            r=sim(i)
            if r is None: continue
            ret,h=r; cts=bars4h[min(i+h,n-1)]["time"]
            mo[mo_str(cts)]+=ret; last[sn]=i
    H.ADX_THRESH=orig_adx; H.SL_INIT=orig_si; H.SL_TRAIL=orig_st; H.SL_TRANS=orig_tr
    return mo

def book_stats(sb,ss,st):
    p=[(sb[i]+ss[i]+st[i])/3 for i in range(len(cal))]
    yr=defaultdict(float)
    for i,m in enumerate(cal): yr[int(m[:4])]+=p[i]
    sh=sharpe(p); md=maxdd(p); tot=sum(p)*100; fl=sum(1 for x in p if abs(x)<1e-9)
    sp=sorted(enumerate(p),key=lambda x:-x[1]); top3={i for i,_ in sp[:3]}
    nt=[x for i,x in enumerate(p) if i not in top3]; sh_nt=sharpe(nt) if len(nt)>2 else 0
    py=" ".join(f"{y%100}:{yr[y]*100:+.0f}" for y in sorted(yr))
    yr_stab=sum(1 for v in yr.values() if v>0)
    return sh,md,tot,fl,sh_nt,py,yr_stab,p

def pr(label,sb,ss,st,flag=""):
    sh,md,tot,fl,sh_nt,py,stab,_=book_stats(sb,ss,st)
    ok=sh>=1.65 and md<=11.0 and stab>=3 and sh_nt>=1.15
    m="✅" if ok else ("⚠️" if sh>=1.55 else "❌")
    print(f"  {m} {label:<46} Sh{sh:>+5.2f} DD{md:>4.1f}% flat{fl:>3}/35 no-top{sh_nt:>+5.2f} stab{stab}/4yr | {py} {flag}")
    return sh,md,fl,sh_nt,stab

def run7y(adx_t=18,si=4.0,st=3.0,tr=24,skip_s14=False):
    mo7=run_h01(f"{CC}/binance-5m-7y.json",adx_thresh=adx_t,sl_init=si,sl_trail=st,sl_trans=tr,skip_s14=skip_s14)
    s7=[mo7.get(m,0.0) for m in cal7]
    yr7=defaultdict(float)
    for m in cal7: yr7[int(m[:4])]+=mo7.get(m,0.0)
    sh7=sharpe(s7); md7=maxdd(s7)
    py7=" ".join(f"{y%100}:{yr7[y]*100:+.0f}" for y in sorted(yr7))
    return sh7,md7,py7

print("="*100)
print("=== Round 13: No-S14 + All combos + Final adversarial ===")
print("=== Key findings: Skip-S14 +0.10Sh | FULL-combo Sh+1.82 ===\n")

# ─── R13A: No-S14 variants ───
print("━"*100)
print("R13A: No-S14 variants (just S12+S13)")
mb_nos14=run_h01(f"{CC}/binance-5m-7y.json",adx_thresh=18,skip_s14=True)
ms_nos14=run_h01(f"{CC}/binance-sol-5m-3y.json",adx_thresh=18,skip_s14=True)
sB_nos14=[mb_nos14.get(m,0.0) for m in cal]; sS_nos14=[ms_nos14.get(m,0.0) for m in cal]
pr("BASELINE ADX20/full-signals",
   [run_h01(f"{CC}/binance-5m-7y.json",adx_thresh=20).get(m,0.0) for m in cal],
   [run_h01(f"{CC}/binance-sol-5m-3y.json",adx_thresh=20).get(m,0.0) for m in cal],sTB)
pr("ADX18/full-signals",
   [run_h01(f"{CC}/binance-5m-7y.json",adx_thresh=18).get(m,0.0) for m in cal],
   [run_h01(f"{CC}/binance-sol-5m-3y.json",adx_thresh=18).get(m,0.0) for m in cal],sTB)
pr("ADX18/no-S14 (S12+S13 only)",sB_nos14,sS_nos14,sTB)

# 7y verify no-S14
sh7,md7,py7=run7y(18,skip_s14=True)
print(f"    → 7y BTC no-S14: Sh{sh7:+.2f} DD{md7:.0f}% | {py7}")
sh7b,md7b,py7b=run7y(18)
print(f"    → 7y BTC ADX18 full: Sh{sh7b:+.2f} DD{md7b:.0f}% | {py7b}")

# SOL-ADX15 no-S14
ms_sol15_nos14=run_h01(f"{CC}/binance-sol-5m-3y.json",adx_thresh=15,skip_s14=True)
sS_sol15_nos14=[ms_sol15_nos14.get(m,0.0) for m in cal]
pr("ADX18/BTC + SOL-ADX15 + no-S14",sB_nos14,sS_sol15_nos14,sTB)

# ─── R13B: Full combo matrix ───
print("\n━"*100)
print("R13B: Full combo matrix (no-S14 × SL × ADX)")
combos=[
    # (label, adx_b, adx_s, si, st, tr, skip_s14)
    ("BAS ADX20/SI4/ST3/TR24",              20,20,4.0,3.0,24,False),
    ("ADX18/SI4/ST3/TR24",                  18,18,4.0,3.0,24,False),
    ("ADX18/no-S14",                        18,18,4.0,3.0,24,True),
    ("ADX18/SI3/ST3.5/TR16 (SL-win)",       18,18,3.0,3.5,16,False),
    ("BTC18+SOL15",                         18,15,4.0,3.0,24,False),
    ("BTC18+SOL15+no-S14",                  18,15,4.0,3.0,24,True),
    ("BTC18+SOL15+SI3/ST3.5/TR16",          18,15,3.0,3.5,16,False),
    ("BTC18+SOL15+SI3/ST3.5/TR16+no-S14",   18,15,3.0,3.5,16,True),
    ("BTC18+SOL15+SI3/ST3/TR16+no-S14",     18,15,3.0,3.0,16,True),
    ("ADX18+SI3/ST3.5/TR16+no-S14",         18,18,3.0,3.5,16,True),
]
results=[]
for lbl,adx_b,adx_s,si,st,tr,ns14 in combos:
    mb=run_h01(f"{CC}/binance-5m-7y.json",adx_thresh=adx_b,sl_init=si,sl_trail=st,sl_trans=tr,skip_s14=ns14)
    ms=run_h01(f"{CC}/binance-sol-5m-3y.json",adx_thresh=adx_s,sl_init=si,sl_trail=st,sl_trans=tr,skip_s14=ns14)
    sb_=[mb.get(m,0.0) for m in cal]; ss_=[ms.get(m,0.0) for m in cal]
    sh_,md_,fl_,sh_nt_,stab_=pr(lbl,sb_,ss_,sTB)
    results.append((sh_,md_,fl_,sh_nt_,stab_,lbl,adx_b,si,st,tr,ns14))

# ─── R13C: 7y verify top candidates ───
print("\n━"*100)
print("R13C: 7y BTC verify top candidates")
top_cands=sorted(results,reverse=True)[:5]
print(f"  {'Config':<44} 7y-Sh  7y-DD | 7y per-year")
print("  "+"-"*80)
for sh_,md_,fl_,sh_nt_,stab_,lbl,adx_b,si,st,tr,ns14 in top_cands:
    sh7,md7,py7=run7y(adx_b,si,st,tr,ns14)
    robust="✅" if sh7>=0.95 and md7<=33 else "⚠️"
    print(f"  {lbl:<44} {sh7:>+5.2f} {md7:>4.0f}% {robust} | {py7}")

# ─── R13D: Final ranking ───
print("\n"+"="*100)
print("FINAL RANKING — All discoveries (R1-R13)")
print("  Criteria accept: Sh≥1.60, DD≤11%, stab≥3/4yr, no-top≥1.15, 7y-Sh≥0.95\n")

all_cands=[
    ("BASELINE",                           20,20,4.0,3.0,24,False),
    ("ADX18",                              18,18,4.0,3.0,24,False),
    ("ADX18+no-S14",                       18,18,4.0,3.0,24,True),
    ("ADX18+SI3/ST3.5/TR16",               18,18,3.0,3.5,16,False),
    ("BTC18+SOL15",                        18,15,4.0,3.0,24,False),
    ("BTC18+SOL15+no-S14",                 18,15,4.0,3.0,24,True),
    ("BTC18+SOL15+SI3/ST3.5/TR16",         18,15,3.0,3.5,16,False),
    ("BTC18+SOL15+SI3/ST3.5/TR16+no-S14",  18,15,3.0,3.5,16,True),
    ("ADX18+SI3/ST3.5/TR16+no-S14",        18,18,3.0,3.5,16,True),
]
final=[]
for lbl,adx_b,adx_s,si,st,tr,ns14 in all_cands:
    mb=run_h01(f"{CC}/binance-5m-7y.json",adx_thresh=adx_b,sl_init=si,sl_trail=st,sl_trans=tr,skip_s14=ns14)
    ms=run_h01(f"{CC}/binance-sol-5m-3y.json",adx_thresh=adx_s,sl_init=si,sl_trail=st,sl_trans=tr,skip_s14=ns14)
    sb_=[mb.get(m,0.0) for m in cal]; ss_=[ms.get(m,0.0) for m in cal]
    sh_,md_,tot_,fl_,sh_nt_,py_,stab_,_=book_stats(sb_,ss_,sTB)
    sh7,md7,py7=run7y(adx_b,si,st,tr,ns14)
    accept=(sh_>=1.60 and md_<=11.0 and stab_>=3 and sh_nt_>=1.15 and sh7>=0.95)
    final.append((accept,sh_,md_,fl_,sh_nt_,sh7,md7,stab_,lbl,py_))

final.sort(key=lambda x:(-x[0],-x[1]))
print(f"  {'Label':<44} {'Sh':>5} {'DD':>5} {'flat':>5} {'no-top':>7} {'7y-Sh':>6} {'7y-DD':>6} {'stab':>5}")
print("  "+"-"*100)
for accept,sh_,md_,fl_,sh_nt_,sh7,md7,stab_,lbl,py_ in final:
    ok="✅" if accept else ("⚠️" if sh_>=1.55 else "❌")
    print(f"  {ok} {lbl:<44} {sh_:>+5.2f} {md_:>4.1f}% {fl_:>3}/35 {sh_nt_:>+7.2f} {sh7:>+6.2f} {md7:>5.0f}% {stab_:>3}/4 | {py_}")

winner=[x for x in final if x[0]]
print(f"\n  CONFIRMED WINNERS: {len(winner)}")
for _,sh_,md_,fl_,sh_nt_,sh7,md7,stab_,lbl,py_ in winner:
    print(f"  ★ {lbl}: 2.9y Sh{sh_:+.2f} DD{md_:.1f}% flat{fl_}/35 | 7y Sh{sh7:+.2f} DD{md7:.0f}%")
    delta_sh=sh_-1.49; delta_fl=11-fl_
    print(f"    vs BASELINE: ΔSh{delta_sh:+.2f} Δflat{delta_fl:+d}")
