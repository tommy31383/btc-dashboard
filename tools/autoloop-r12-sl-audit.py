#!/usr/bin/env python3
"""autoloop-r12-sl-audit.py — Round 12: Adversarial audit SL winner + SOL-ADX sensitivity
SL winner R10: SI3.0/ST3.5/TR16 → Sh+1.71 (2.9y)
Cần kiểm tra:
  R12A: 7y BTC verify SL3.0/3.5/16 vs baseline
  R12B: SL sensitivity — SI3.0 fixed, sweep ST 3.0-4.0 × TR 8-24
  R12C: SOL ADX sensitivity — ADX13/14/15/16/17 trên SOL standalone + 7y check không có
  R12D: Combo best: ADX18(BTC)+SOL-ADX15 + SL3.0/3.5/16
  R12E: Sh-no-top3 test cho winner
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
sTB=[turB.get(m,0.0) for m in cal]
cal7=months_between(spanB[0],spanB[1])

def run_h01(cache, adx_thresh=18, sl_init=4.0, sl_trail=3.0, sl_trans=24, cd_s12=36, cd_s14=36):
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
    sigs={"S12":sig_s12,"S13":sig_s13,"S14":sig_s14}
    do_vol={"S12":False,"S13":True,"S14":True}
    CD={"S12":cd_s12,"S13":1,"S14":cd_s14}
    mo=defaultdict(float); last={s:0 for s in sigs}
    for i in range(250,n-H.MAX_HOLD):
        for sn,sfn in sigs.items():
            if sfn(i)!="LONG": continue
            if i-last[sn]<CD[sn]: continue
            if do_vol[sn] and not vol_pass(i): continue
            if not filt(i): continue
            r=sim(i)
            if r is None: continue
            ret,h=r; cts=bars4h[min(i+h,n-1)]["time"]
            mo[mo_str(cts)]+=ret; last[sn]=i
    H.ADX_THRESH=orig_adx; H.SL_INIT=orig_si; H.SL_TRAIL=orig_st; H.SL_TRANS=orig_tr
    return mo

def book(sb,ss,st):
    p=[(sb[i]+ss[i]+st[i])/3 for i in range(len(cal))]
    yr=defaultdict(float)
    for i,m in enumerate(cal): yr[int(m[:4])]+=p[i]
    sh=sharpe(p); md=maxdd(p); tot=sum(p)*100; fl=sum(1 for x in p if abs(x)<1e-9)
    # sh-no-top3
    sp=sorted(enumerate(p),key=lambda x:-x[1]); top3={i for i,_ in sp[:3]}
    nt=[x for i,x in enumerate(p) if i not in top3]; sh_nt=sharpe(nt) if len(nt)>2 else 0
    py=" ".join(f"{y%100}:{yr[y]*100:+.0f}" for y in sorted(yr))
    return sh,md,tot,fl,sh_nt,py

def pr(label,sb,ss,st):
    sh,md,tot,fl,sh_nt,py=book(sb,ss,st)
    m="✅" if sh>=1.60 and md<=11.0 else ("⚠️" if sh>=1.52 else "❌")
    print(f"  {m} {label:<44} Sh{sh:>+5.2f} DD{md:>5.1f}% TOT{tot:>+5.0f}% flat{fl:>3}/35 no-top{sh_nt:>+5.2f} | {py}")
    return sh,md,fl,sh_nt

print("="*95)
print("=== Round 12: Adversarial audit SL winner + SOL-ADX + Combos ===")
print("=== SL winner R10: SI3.0/ST3.5/TR16 → Sh+1.71 (need 7y verify) ===\n")

# ─── BASELINE ───
moB20=run_h01(f"{CC}/binance-5m-7y.json",adx_thresh=20,sl_init=4.0,sl_trail=3.0,sl_trans=24)
moS20=run_h01(f"{CC}/binance-sol-5m-3y.json",adx_thresh=20,sl_init=4.0,sl_trail=3.0,sl_trans=24)
sB20=[moB20.get(m,0.0) for m in cal]; sS20=[moS20.get(m,0.0) for m in cal]
moB18=run_h01(f"{CC}/binance-5m-7y.json",adx_thresh=18); sB18=[moB18.get(m,0.0) for m in cal]
moS18=run_h01(f"{CC}/binance-sol-5m-3y.json",adx_thresh=18); sS18=[moS18.get(m,0.0) for m in cal]

print("  Refs:")
pr("BASELINE ADX20/SI4/ST3/TR24",sB20,sS20,sTB)
pr("ADX18/SI4/ST3/TR24",sB18,sS18,sTB)

# ─── R12A: 7y BTC verify SL winner ───
print("\n━"*95)
print("R12A: 7y BTC verify — SL winner SI3.0/ST3.5/TR16 vs baseline")
print(f"  {'Config':<30} | {'Sh-7y':>6} | {'DD-7y':>6} | {'TOT-7y':>7} | per-year 7y")
print("  "+"-"*75)
for label,si,st,tr,adx_t in [
    ("BAS ADX20/SI4.0/ST3.0/TR24",4.0,3.0,24,20),
    ("ADX18/SI4.0/ST3.0/TR24",4.0,3.0,24,18),
    ("ADX18/SI3.0/ST3.5/TR16 ★",3.0,3.5,16,18),
    ("ADX18/SI3.0/ST3.5/TR24",3.0,3.5,24,18),
    ("ADX18/SI3.0/ST3.0/TR16",3.0,3.0,16,18),
    ("ADX18/SI3.0/ST3.0/TR24",3.0,3.0,24,18),
]:
    mo7=run_h01(f"{CC}/binance-5m-7y.json",adx_thresh=adx_t,sl_init=si,sl_trail=st,sl_trans=tr)
    s7=[mo7.get(m,0.0) for m in cal7]
    yr7=defaultdict(float)
    for m in cal7: yr7[int(m[:4])]+=mo7.get(m,0.0)
    sh7=sharpe(s7); md7=maxdd(s7); tot7=sum(s7)*100
    py7=" ".join(f"{y%100}:{yr7[y]*100:+.0f}" for y in sorted(yr7))
    mark="◀ WINNER" if "★" in label else ""
    print(f"  {label:<30} | {sh7:>+6.2f} | {md7:>5.1f}% | {tot7:>+6.0f}% | {py7} {mark}")

# ─── R12B: SL sensitivity với SI=3.0 ───
print("\n━"*95)
print("R12B: SL sensitivity (SI=3.0 fixed, sweep ST × TR) — 2.9y book")
print(f"  {'ST':>5} {'TR':>5} | {'Sh':>6} {'DD':>5} {'flat':>5} {'no-top':>7}")
print("  "+"-"*45)
for st in [2.5,3.0,3.5,4.0]:
    for tr in [8,12,16,20,24,32]:
        mb=run_h01(f"{CC}/binance-5m-7y.json",adx_thresh=18,sl_init=3.0,sl_trail=st,sl_trans=tr)
        ms=run_h01(f"{CC}/binance-sol-5m-3y.json",adx_thresh=18,sl_init=3.0,sl_trail=st,sl_trans=tr)
        sb_=[mb.get(m,0.0) for m in cal]; ss_=[ms.get(m,0.0) for m in cal]
        sh_,md_,tot_,fl_,sh_nt_,_=book(sb_,ss_,sTB)
        m="★" if sh_>=1.65 else (" " if sh_>=1.60 else ".")
        print(f"  {m} ST{st:.1f} TR{tr:>2} | {sh_:>+6.2f} {md_:>4.1f}% {fl_:>3}/35 {sh_nt_:>+6.2f}")

# ─── R12C: SOL ADX sensitivity ───
print("\n━"*95)
print("R12C: SOL ADX sensitivity (BTC=ADX18 fixed, vary SOL ADX 12-20)")
print(f"  {'SOL-ADX':>8} | {'Sh-book':>7} {'DD':>5} {'TOT':>6} | Sh-SOL-standalone")
print("  "+"-"*55)
for adx_s in [12,13,14,15,16,17,18,19,20]:
    ms=run_h01(f"{CC}/binance-sol-5m-3y.json",adx_thresh=adx_s)
    ss_=[ms.get(m,0.0) for m in cal]
    sh_,md_,tot_,fl_,sh_nt_,py_=book(sB18,ss_,sTB)
    sh_sol=sharpe(ss_); tot_sol=sum(ss_)*100
    mark="◀ BASELINE" if adx_s==18 else ("◀ WINNER" if adx_s==15 else "")
    print(f"  {adx_s:>8} | {sh_:>+7.2f} {md_:>4.1f}% {tot_:>+5.0f}% | SOL-alone: Sh{sh_sol:>+5.2f} TOT{tot_sol:>+5.0f}% {mark}")

# ─── R12D: Combos ───
print("\n━"*95)
print("R12D: Combo candidates + adversarial check\n")

combos=[
    ("BAS ADX20/SI4/ST3/TR24",           20,4.0,3.0,24, 20,4.0,3.0,24),
    ("ADX18/SI4/ST3/TR24",               18,4.0,3.0,24, 18,4.0,3.0,24),
    ("ADX18/SI3/ST3.5/TR16 (SL-win)",    18,3.0,3.5,16, 18,3.0,3.5,16),
    ("BTC-ADX18+SOL-ADX15",              18,4.0,3.0,24, 15,4.0,3.0,24),
    ("FULL: BTC18+SOL15+SI3/ST3.5/TR16", 18,3.0,3.5,16, 15,3.0,3.5,16),
    ("BTC18+SOL15+SI3/ST3/TR16",         18,3.0,3.0,16, 15,3.0,3.0,16),
    ("BTC18+SOL15+SI3/ST3.5/TR24",       18,3.0,3.5,24, 15,3.0,3.5,24),
    ("BTC18+SOL15+SI3/ST3/TR24",         18,3.0,3.0,24, 15,3.0,3.0,24),
]
best_sh=1.50; best_label=""
for lbl,adx_b,si_b,st_b,tr_b,adx_s,si_s,st_s,tr_s in combos:
    mb=run_h01(f"{CC}/binance-5m-7y.json",adx_thresh=adx_b,sl_init=si_b,sl_trail=st_b,sl_trans=tr_b)
    ms=run_h01(f"{CC}/binance-sol-5m-3y.json",adx_thresh=adx_s,sl_init=si_s,sl_trail=st_s,sl_trans=tr_s)
    sb_=[mb.get(m,0.0) for m in cal]; ss_=[ms.get(m,0.0) for m in cal]
    sh_,md_,fl_,sh_nt_=pr(lbl,sb_,ss_,sTB)
    if sh_>best_sh: best_sh=sh_; best_label=lbl

# 7y verify best combo
print(f"\n  ★ Best combo: {best_label} Sh{best_sh:+.2f}")
print(f"\n  7y BTC verify for candidates:")
for lbl,adx_b,si_b,st_b,tr_b,_,_,_,_ in combos[2:]:  # skip baselines
    mo7=run_h01(f"{CC}/binance-5m-7y.json",adx_thresh=adx_b,sl_init=si_b,sl_trail=st_b,sl_trans=tr_b)
    s7=[mo7.get(m,0.0) for m in cal7]
    yr7=defaultdict(float)
    for m in cal7: yr7[int(m[:4])]+=mo7.get(m,0.0)
    sh7=sharpe(s7); md7=maxdd(s7)
    py7=" ".join(f"{y%100}:{yr7[y]*100:+.0f}" for y in sorted(yr7))
    robust="✅ ROBUST" if sh7>=1.00 and md7<=32 else "⚠️ CHECK"
    print(f"  {lbl:<40} 7y: Sh{sh7:>+5.2f} DD{md7:>4.0f}% | {py7} [{robust}]")

print("\n"+"="*95)
print("ROUND 12 COMPLETE — See above for winner confirmation")
