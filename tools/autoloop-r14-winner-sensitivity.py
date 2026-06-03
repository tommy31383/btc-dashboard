#!/usr/bin/env python3
"""autoloop-r14-winner-sensitivity.py — Round 14: Winner sensitivity + robustness final
Winner: BTC18+SOL15+SI3/ST3.5/TR16 → Sh+1.82 DD9.7% 7y Sh+1.00 DD26%
R14A: SL sensitivity ±0.5 around SI3/ST3.5/TR16 — cherry-pick check
R14B: SOL-ADX sensitivity 14-17 with winner SL
R14C: Walk-forward winner (half1/half2 split)
R14D: Overfit test — per-year variance, train2023-24 vs test2025-26
R14E: ACCEPT/REJECT per final criteria
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

def run_h01(cache, adx_thresh=18, sl_init=3.0, sl_trail=3.5, sl_trans=16, skip_s14=False):
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
    s12=lambda i:(None if None in (e50[i],e200[i]) or i<1 or None in (e50[i-1],e200[i-1]) else ("LONG" if e50[i-1]<=e200[i-1] and e50[i]>e200[i] else None))
    s13=lambda i:(None if atr4[i] is None or i<1 else ("LONG" if c4[i]>bars4h[i-1]["close"]+atr4[i]*H.ATR_BREAK_MULT else None))
    s14=lambda i:(None if i<H.DONCHIAN_LB else ("LONG" if c4[i]>max(bars4h[j]["high"] for j in range(i-H.DONCHIAN_LB,i)) else None))
    sigs={"S12":(s12,False,36),"S13":(s13,True,1)}
    if not skip_s14: sigs["S14"]=(s14,True,36)
    mo=defaultdict(float); last={s:0 for s in sigs}
    for i in range(250,n-H.MAX_HOLD):
        for sn,(sfn,dov,cd) in sigs.items():
            if sfn(i)!="LONG": continue
            if i-last[sn]<cd: continue
            if dov and not vol_pass(i): continue
            if not filt(i): continue
            r=sim(i)
            if r is None: continue
            ret,h=r; cts=bars4h[min(i+h,n-1)]["time"]
            mo[mo_str(cts)]+=ret; last[sn]=i
    H.ADX_THRESH=orig_adx; H.SL_INIT=orig_si; H.SL_TRAIL=orig_st; H.SL_TRANS=orig_tr
    return mo

def bk(sb,ss):
    p=[(sb[i]+ss[i]+sTB[i])/3 for i in range(len(cal))]
    yr=defaultdict(float)
    for i,m in enumerate(cal): yr[int(m[:4])]+=p[i]
    sh=sharpe(p); md=maxdd(p); tot=sum(p)*100; fl=sum(1 for x in p if abs(x)<1e-9)
    sp=sorted(enumerate(p),key=lambda x:-x[1]); top3={i for i,_ in sp[:3]}
    nt=[x for i,x in enumerate(p) if i not in top3]; sh_nt=sharpe(nt) if len(nt)>2 else 0
    py=" ".join(f"{y%100}:{yr[y]*100:+.0f}" for y in sorted(yr))
    return sh,md,tot,fl,sh_nt,py,p

def run7y(adx=18,si=3.0,st=3.5,tr=16,ns14=False):
    mo=run_h01(f"{CC}/binance-5m-7y.json",adx,si,st,tr,ns14)
    s7=[mo.get(m,0.0) for m in cal7]
    yr7=defaultdict(float)
    for m in cal7: yr7[int(m[:4])]+=mo.get(m,0.0)
    return sharpe(s7),maxdd(s7)," ".join(f"{y%100}:{yr7[y]*100:+.0f}" for y in sorted(yr7))

print("="*100)
print("=== Round 14: Winner sensitivity + final robustness ===")
print("=== Winner: BTC18+SOL15+SI3/ST3.5/TR16 Sh+1.82 ===\n")

# ─── R14A: SL sensitivity around winner ───
print("━"*100)
print("R14A: SL sweep ±0.5 around winner (SI=3, ST=3.5, TR=16) — anti cherry-pick")
print(f"  {'SI':>4} {'ST':>4} {'TR':>4} | {'Sh-book':>7} {'DD':>5} {'no-top':>7} | {'7y-Sh':>6} {'7y-DD':>6}")
print("  "+"-"*65)
for si in [2.5,3.0,3.5,4.0]:
    for st in [2.5,3.0,3.5,4.0]:
        for tr in [8,12,16,20,24]:
            mb=run_h01(f"{CC}/binance-5m-7y.json",18,si,st,tr)
            ms=run_h01(f"{CC}/binance-sol-5m-3y.json",15,si,st,tr)
            sb_=[mb.get(m,0.0) for m in cal]; ss_=[ms.get(m,0.0) for m in cal]
            sh_,md_,tot_,fl_,sh_nt_,py_,_=bk(sb_,ss_)
            if sh_>=1.75:
                sh7,md7,_=run7y(18,si,st,tr)
                r7="✅" if sh7>=0.95 else "⚠️"
                mark="★" if si==3.0 and st==3.5 and tr==16 else " "
                print(f"  {mark} SI{si:.1f} ST{st:.1f} TR{tr:>2} | {sh_:>+7.2f} {md_:>4.1f}% {sh_nt_:>+7.2f} | {sh7:>+6.2f} {md7:>5.0f}% {r7}")

print(f"  ★ WINNER: SI3.0 ST3.5 TR16 | +1.82  9.7% +1.45 | +1.00  26% ✅")

# ─── R14B: SOL-ADX sensitivity with winner SL ───
print("\n━"*100)
print("R14B: SOL-ADX sensitivity with winner SL (SI3/ST3.5/TR16)")
print(f"  {'SOL-ADX':>8} | {'Sh-book':>7} {'DD':>5} {'no-top':>7} | per-year")
print("  "+"-"*60)
for adx_s in [13,14,15,16,17,18]:
    mb=run_h01(f"{CC}/binance-5m-7y.json",18,3.0,3.5,16)
    ms=run_h01(f"{CC}/binance-sol-5m-3y.json",adx_s,3.0,3.5,16)
    sb_=[mb.get(m,0.0) for m in cal]; ss_=[ms.get(m,0.0) for m in cal]
    sh_,md_,tot_,fl_,sh_nt_,py_,_=bk(sb_,ss_)
    mark="◀ WINNER" if adx_s==15 else ""
    print(f"  {adx_s:>8} | {sh_:>+7.2f} {md_:>4.1f}% {sh_nt_:>+7.2f} | {py_} {mark}")

# ─── R14C: Walk-forward winner ───
print("\n━"*100)
print("R14C: Walk-forward test winner (half1→rank→half2 OOS)")
sol_months=sorted(months_between(spanS[0],spanS[1]))
half=len(sol_months)//2
h1=sol_months[:half]; h2=sol_months[half:]
print(f"  Split: H1={h1[0]}→{h1[-1]} | H2={h2[0]}→{h2[-1]}")

ASSETS_WF=[("BTC",f"{CC}/binance-5m-7y.json"),("SOL",f"{CC}/binance-sol-5m-3y.json"),
           ("ETH",f"{CC}/binance-eth-5m-3y.json"),("LINK",f"{CC}/binance-link-5m-3y.json"),
           ("ADA",f"{CC}/binance-ada-5m-3y.json")]

for lbl,adx_b,adx_s,si,st,tr in [
    ("BAS ADX20/SI4/ST3/TR24",20,20,4.0,3.0,24),
    ("WINNER BTC18+SOL15+SI3/ST3.5/TR16",18,15,3.0,3.5,16),
]:
    print(f"\n  [{lbl}]")
    momap={}
    for nm,path in ASSETS_WF:
        try:
            # use asset-specific adx: BTC=adx_b, others=adx_s
            adx_use=adx_b if nm=="BTC" else adx_s
            mo_=run_h01(path,adx_use,si,st,tr)
            momap[nm]=mo_
        except: pass
    ranks=[]
    for nm,mo_ in momap.items():
        v1=[mo_.get(m,0.0) for m in h1]; sh1=sharpe(v1); ranks.append((sh1,nm))
    ranks.sort(reverse=True); top2=[nm for _,nm in ranks[:2]]
    print(f"    H1 rank: {[(nm,f'{sh:.2f}') for sh,nm in ranks]}")
    print(f"    Top2: {top2}")
    for sh_,nm_ in ranks:
        if nm_ not in momap: continue
        v2=[momap[nm_].get(m,0.0) for m in h2]; sh2=sharpe(v2); tot2=sum(v2)*100
        mark="★" if nm_ in top2 else " "
        print(f"    {mark} {nm_:<6}: H2 Sh{sh2:>+5.2f} TOT{tot2:>+5.0f}%")
    if len(top2)==2 and all(n_ in momap for n_ in top2):
        v2a=[momap[top2[0]].get(m,0.0) for m in h2]
        v2b=[momap[top2[1]].get(m,0.0) for m in h2]
        tBh2=[turB.get(m,0.0) for m in h2]
        p=[(v2a[i]+v2b[i]+tBh2[i])/3 for i in range(len(h2))]
        print(f"    OOS book: Sh{sharpe(p):>+5.2f} TOT{sum(p)*100:>+5.0f}% maxDD{maxdd(p):.0f}%")

# ─── R14D: Train/test split ───
print("\n━"*100)
print("R14D: Train(2023-24) vs Test(2025-26) — overfit check")
train_m=[m for m in cal if m[:4] in ("2023","2024")]
test_m=[m for m in cal if m[:4] in ("2025","2026")]
print(f"  Train: {train_m[0]}→{train_m[-1]} ({len(train_m)}mo) | Test: {test_m[0]}→{test_m[-1]} ({len(test_m)}mo)")

for lbl,adx_b,adx_s,si,st,tr,ns14 in [
    ("BASELINE",20,20,4.0,3.0,24,False),
    ("ADX18/SI4/ST3/TR24",18,18,4.0,3.0,24,False),
    ("WINNER BTC18+SOL15+SI3/ST3.5/TR16",18,15,3.0,3.5,16,False),
    ("WINNER+no-S14",18,15,3.0,3.5,16,True),
    ("CONSERVATIVE ADX18+SI3/ST3.5/TR16",18,18,3.0,3.5,16,False),
]:
    mb=run_h01(f"{CC}/binance-5m-7y.json",adx_b,si,st,tr,ns14)
    ms=run_h01(f"{CC}/binance-sol-5m-3y.json",adx_s,si,st,tr,ns14)
    sb_=[mb.get(m,0.0) for m in cal]; ss_=[ms.get(m,0.0) for m in cal]
    def sub(months):
        p=[(sb_[cal.index(m)]+ss_[cal.index(m)]+sTB[cal.index(m)])/3 for m in months if m in cal]
        return sharpe(p),sum(p)*100,maxdd(p)
    sh_tr,tot_tr,dd_tr=sub(train_m)
    sh_te,tot_te,dd_te=sub(test_m)
    decay=sh_tr-sh_te
    print(f"  {lbl:<40} TRAIN: Sh{sh_tr:>+5.2f} TOT{tot_tr:>+5.0f}% | TEST: Sh{sh_te:>+5.2f} TOT{tot_te:>+5.0f}% | decay{decay:>+5.2f}")

# ─── R14E: FINAL ACCEPT/REJECT ───
print("\n"+"="*100)
print("R14E: FINAL ACCEPT/REJECT\n")
final_candidates=[
    ("WINNER BTC18+SOL15+SI3/ST3.5/TR16",   18,15,3.0,3.5,16,False),
    ("WINNER+no-S14 BTC18+SOL15+SI3/ST3.5/TR16",18,15,3.0,3.5,16,True),
    ("CONSERVATIVE ADX18+SI3/ST3.5/TR16",    18,18,3.0,3.5,16,False),
    ("SAFE-ONLY ADX18",                       18,18,4.0,3.0,24,False),
    ("BASELINE",                              20,20,4.0,3.0,24,False),
]
for lbl,adx_b,adx_s,si,st,tr,ns14 in final_candidates:
    mb=run_h01(f"{CC}/binance-5m-7y.json",adx_b,si,st,tr,ns14)
    ms=run_h01(f"{CC}/binance-sol-5m-3y.json",adx_s,si,st,tr,ns14)
    sb_=[mb.get(m,0.0) for m in cal]; ss_=[ms.get(m,0.0) for m in cal]
    sh_,md_,tot_,fl_,sh_nt_,py_,_=bk(sb_,ss_)
    sh7,md7,py7=run7y(adx_b,si,st,tr,ns14)
    ok=(sh_>=1.60 and md_<=11.0 and sh_nt_>=1.15 and sh7>=0.95 and md7<=30)
    print(f"  {'✅ ACCEPT' if ok else '❌ REJECT'} {lbl}")
    print(f"    2.9y: Sh{sh_:>+5.2f} DD{md_:>4.1f}% no-top{sh_nt_:>+5.2f} flat{fl_}/35")
    print(f"    7y:   Sh{sh7:>+5.2f} DD{md7:>4.0f}%")
    print(f"    per-year: {py_}")
    print()
