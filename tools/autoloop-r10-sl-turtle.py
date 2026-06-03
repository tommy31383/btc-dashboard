#!/usr/bin/env python3
"""autoloop-r10-sl-turtle.py — Round 10: SL sweep + turtle-BTC tuning
Base: ADX18 (winner R9). Goal: có thể cải thiện thêm không?
R10A: SL params sweep (SL_INIT 3-5, SL_TRAIL 2-4, SL_TRANS 16-32)
R10B: Turtle-BTC param sweep (FAST 10-25, ATR_CUT 1.0-2.5)
R10C: Per-asset ADX (BTC ADX18, SOL ADX khác)
R10D: Regime AR threshold (0.03-0.05)
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

moB,_,_,spanB=Hh.run_hedge01(f"{CC}/binance-5m-7y.json",skip_cal=False)
moS,_,_,spanS=Hh.run_hedge01(f"{CC}/binance-sol-5m-3y.json",skip_cal=False)
turB=dict(C.tur_mo)
cal=months_between(spanS[0],spanS[1])
sB=[moB.get(m,0.0) for m in cal]; sS=[moS.get(m,0.0) for m in cal]; sTB=[turB.get(m,0.0) for m in cal]

# baseline ADX18
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

def run_turtle_btc_params(fast=20, slow=10, atr_cut=1.5):
    raw=json.load(open(f"{CC}/binance-5m-7y.json"))
    H4=4*3600*1000; D=86400*1000
    bk={}
    for c in raw:
        k=c["time"]//H4
        if k not in bk: bk[k]={"time":k*H4,"high":c["high"],"low":c["low"],"close":c["close"],"volume":c["volume"]}
        else: o=bk[k]; o["high"]=max(o["high"],c["high"]); o["low"]=min(o["low"],c["low"]); o["close"]=c["close"]; o["volume"]+=c["volume"]
    bars4h=[bk[k] for k in sorted(bk)]
    dk={}
    for c in raw:
        k=c["time"]//D
        if k not in dk: dk[k]={"time":k*D,"high":c["high"],"low":c["low"],"close":c["close"],"volume":c["volume"]}
        else: o=dk[k]; o["high"]=max(o["high"],c["high"]); o["low"]=min(o["low"],c["low"]); o["close"]=c["close"]; o["volume"]+=c["volume"]
    bars1d=[dk[k] for k in sorted(dk)]
    n=len(bars4h); c4=[b["close"] for b in bars4h]
    def atr_s(bars,p=14):
        tr=[0.0]*len(bars)
        for i in range(1,len(bars)): tr[i]=max(bars[i]["high"]-bars[i]["low"],abs(bars[i]["high"]-bars[i-1]["close"]),abs(bars[i]["low"]-bars[i-1]["close"]))
        atr=[None]*len(bars); s=sum(tr[1:p+1]); atr[p]=s/p
        for i in range(p+1,len(bars)): atr[i]=(atr[i-1]*(p-1)+tr[i])/p
        return atr
    atr4=atr_s(bars4h)
    regime_1d=H.regime_with_persistence(bars1d)
    reg_map={b["time"]//86400000:regime_1d[i] for i,b in enumerate(bars1d)}
    def get_reg(ts): return reg_map.get(ts//86400000,"RANGE")
    FEE=0.05/100
    mo=defaultdict(float); in_trade=False; ep=ae=sl=hwm=None
    for i in range(fast,n):
        reg=get_reg(bars4h[i]["time"])
        if reg=="BEAR":
            if in_trade: mo[mo_str(bars4h[i]["time"])]+=(bars4h[i]["low"]-ep)/ep-2*FEE; in_trade=False
            continue
        if in_trade:
            if c4[i]>hwm: hwm=c4[i]; sl=hwm-ae*1.0
            t=hwm-ae*atr_cut
            if t>sl: sl=t
            if bars4h[i]["low"]<=sl:
                mo[mo_str(bars4h[i]["time"])]+=(sl-ep)/ep-2*FEE; in_trade=False
        if not in_trade:
            hi_fast=max(bars4h[j]["high"] for j in range(i-fast,i))
            if c4[i]>hi_fast and atr4[i] is not None:
                in_trade=True; ep=c4[i]; ae=atr4[i]; sl=ep-ae*atr_cut; hwm=ep
    return mo

def book(sb,ss,st,wts=None):
    k=3; w=wts or [1,1,1]; sw=sum(w)
    p=[sum(w[j]*[sb,ss,st][j][i] for j in range(3))/sw for i in range(len(cal))]
    yr=defaultdict(float)
    for i,m in enumerate(cal): yr[int(m[:4])]+=p[i]
    sh=sharpe(p); md=maxdd(p); tot=sum(p)*100
    flat=sum(1 for x in p if abs(x)<1e-9)
    py=" ".join(f"{y%100}:{yr[y]*100:+.0f}" for y in sorted(yr))
    return sh,md,tot,flat,py

def pr(label,sb,ss,st,wts=None):
    sh,md,tot,fl,py=book(sb,ss,st,wts)
    m="✅" if sh>=1.52 and md<=11.5 else ("⚠️" if sh>=1.49 else "❌")
    print(f"  {m} {label:<42} Sh{sh:>+5.2f} DD{md:>5.1f}% TOT{tot:>+5.0f}% flat{fl:>3}/35 | {py}")
    return sh,md,tot,fl

# pre-compute ADX18 baseline
moB18=run_h01(f"{CC}/binance-5m-7y.json",adx_thresh=18); sB18=[moB18.get(m,0.0) for m in cal]
moS18=run_h01(f"{CC}/binance-sol-5m-3y.json",adx_thresh=18); sS18=[moS18.get(m,0.0) for m in cal]

print("="*90)
print("=== Round 10: SL sweep + Turtle-BTC tuning (base: ADX18) ===")
print(f"=== Baseline ADX20: Sh+1.49 flat11 | ADX18: Sh+1.50 flat10 ===\n")

# ─── R10A: SL param sweep ───
print("━"*90)
print("R10A: SL param sweep (SL_INIT × SL_TRAIL × SL_TRANS) — base ADX18")
print(f"  {'SL_INIT':>7} {'SL_TRAIL':>8} {'SL_TRANS':>8} | {'Sh':>6} {'DD':>6} {'TOT':>6} {'flat':>6}")
print("  "+"-"*60)
best_sl_sh=1.50; best_sl=None
for si in [3.0,3.5,4.0,4.5,5.0]:
    for st in [2.0,2.5,3.0,3.5,4.0]:
        for tr in [16,24,32]:
            if si==4.0 and st==3.0 and tr==24: continue  # baseline ADX18 already known
            mb=run_h01(f"{CC}/binance-5m-7y.json",adx_thresh=18,sl_init=si,sl_trail=st,sl_trans=tr)
            ms=run_h01(f"{CC}/binance-sol-5m-3y.json",adx_thresh=18,sl_init=si,sl_trail=st,sl_trans=tr)
            sb_=[mb.get(m,0.0) for m in cal]; ss_=[ms.get(m,0.0) for m in cal]
            sh_,md_,tot_,fl_,py_=book(sb_,ss_,sTB)
            if sh_>best_sl_sh and md_<=11.5:
                best_sl_sh=sh_; best_sl=(si,st,tr,sb_,ss_)
            if sh_>=1.52 or (sh_>=1.48 and md_<=10.9):
                print(f"  {'':>7} SI{si:.1f}  ST{st:.1f}  TR{tr:>2} | {sh_:>+6.2f} {md_:>5.1f}% {tot_:>+5.0f}% {fl_:>4}/35 | {py_}")

print(f"  [ADX18 baseline]              SI4.0  ST3.0  TR24 | +1.50  10.9%  +159%   10/35")
if best_sl and best_sl_sh>1.52:
    si,st,tr,sb_,ss_=best_sl
    print(f"  ★ BEST SL: SI{si} ST{st} TR{tr} → Sh{best_sl_sh:+.2f}")
else:
    print(f"  → No SL combo beats ADX18 Sh+1.50 significantly")

# ─── R10B: Turtle-BTC param sweep ───
print("\n━"*90)
print("R10B: Turtle-BTC param sweep — base hedge01 ADX18")
print(f"  {'FAST':>6} {'ATR_CUT':>7} | {'Sh-book':>7} {'DD':>6} {'TOT':>6} {'flat':>6}")
print("  "+"-"*50)
best_tur_sh=1.50; best_tur=None
for fast in [10,15,20,25,30]:
    for cut in [1.0,1.25,1.5,1.75,2.0,2.5]:
        mt=run_turtle_btc_params(fast=fast,slow=fast//2,atr_cut=cut)
        st_=[mt.get(m,0.0) for m in cal]
        sh_,md_,tot_,fl_,py_=book(sB18,sS18,st_)
        if sh_>best_tur_sh and md_<=12.0:
            best_tur_sh=sh_; best_tur=(fast,cut,st_)
        if sh_>=1.52:
            print(f"  F{fast:>3}   CUT{cut:.2f} | {sh_:>+7.2f} {md_:>5.1f}% {tot_:>+5.0f}% {fl_:>4}/35 | {py_}")
print(f"  [turtle baseline F20/CUT1.5]  | +1.50  10.9%  +159%   10/35")
if best_tur and best_tur_sh>1.52:
    fast,cut,st_=best_tur
    print(f"  ★ BEST turtle: F{fast}/CUT{cut} → Sh{best_tur_sh:+.2f}")
else:
    print(f"  → No turtle params beat ADX18 book Sh+1.50")

# ─── R10C: Per-asset ADX ───
print("\n━"*90)
print("R10C: Per-asset ADX (BTC uses different ADX than SOL)")
print(f"  {'BTC-ADX':>8} {'SOL-ADX':>8} | {'Sh':>6} {'DD':>6} {'TOT':>6} {'flat':>6} | {'per-year'}")
print("  "+"-"*70)
best_pa_sh=1.50; best_pa=None
for adx_b in [16,17,18,19,20]:
    mb=run_h01(f"{CC}/binance-5m-7y.json",adx_thresh=adx_b)
    sb_=[mb.get(m,0.0) for m in cal]
    for adx_s in [14,15,16,17,18,19,20]:
        if adx_b==18 and adx_s==18: continue
        ms=run_h01(f"{CC}/binance-sol-5m-3y.json",adx_thresh=adx_s)
        ss_=[ms.get(m,0.0) for m in cal]
        sh_,md_,tot_,fl_,py_=book(sb_,ss_,sTB)
        if sh_>best_pa_sh and md_<=11.5:
            best_pa_sh=sh_; best_pa=(adx_b,adx_s,sb_,ss_)
        if sh_>=1.54:
            print(f"  {adx_b:>8} {adx_s:>8} | {sh_:>+6.2f} {md_:>5.1f}% {tot_:>+5.0f}% {fl_:>4}/35 | {py_}")
print(f"  {'18':>8} {'18':>8} | +1.50  10.9%  +159%   10/35 [ADX18 baseline]")
if best_pa and best_pa_sh>1.52:
    ab,as_,sb_,ss_=best_pa
    print(f"  ★ BEST per-asset: BTC-ADX{ab} SOL-ADX{as_} → Sh{best_pa_sh:+.2f}")
    # 7y verify
    cal7=months_between(spanB[0],spanB[1])
    mb7=run_h01(f"{CC}/binance-5m-7y.json",adx_thresh=ab)
    s7=[mb7.get(m,0.0) for m in cal7]; sh7=sharpe(s7); md7=maxdd(s7)
    print(f"    7y BTC ADX{ab}: Sh{sh7:+.2f} DD{md7:.0f}%")
else:
    print(f"  → Per-asset ADX không cải thiện vs uniform ADX18")

# ─── R10D: Regime AR threshold ───
print("\n━"*90)
print("R10D: Regime AR threshold (định nghĩa RANGE: AR>threshold)")
print("  (regime_with_persistence dùng ar>0.04 để classify BULL)")
print(f"  {'AR_thresh':>10} | {'Sh':>6} {'DD':>6} {'TOT':>6} {'flat':>6} | {'per-year'}")
print("  "+"-"*65)

orig_func=H.regime_with_persistence
def make_regime(ar_thresh):
    def _regime(bars1d, persist_n=3):
        cs=[b["close"] for b in bars1d]; n=len(bars1d)
        raw=["RANGE"]*n
        for i in range(200,n):
            ma200=sum(cs[i-199:i+1])/200; ma50=sum(cs[i-50:i+1])/50
            r20=bars1d[i-19:i+1]
            ar=sum((b["high"]-b["low"])/b["close"] for b in r20)/20
            if cs[i]<ma200: raw[i]="BEAR"
            elif cs[i]>ma50 and ma50>ma200 and ar>ar_thresh: raw[i]="BULL"
        out=["RANGE"]*n; cur="RANGE"; cnt=0; last_raw="RANGE"
        for i in range(n):
            r=raw[i]
            if r==last_raw: cnt+=1
            else: cnt=1; last_raw=r
            if cnt>=persist_n: cur=r
            out[i]=cur
        return out
    return _regime

best_ar_sh=1.50; best_ar=None
for ar_t in [0.02,0.03,0.035,0.04,0.045,0.05,0.06]:
    H.regime_with_persistence=make_regime(ar_t)
    mb=run_h01(f"{CC}/binance-5m-7y.json",adx_thresh=18)
    ms=run_h01(f"{CC}/binance-sol-5m-3y.json",adx_thresh=18)
    sb_=[mb.get(m,0.0) for m in cal]; ss_=[ms.get(m,0.0) for m in cal]
    sh_,md_,tot_,fl_,py_=book(sb_,ss_,sTB)
    if sh_>best_ar_sh and md_<=11.5: best_ar_sh=sh_; best_ar=(ar_t,sb_,ss_)
    mark="◀ baseline" if ar_t==0.04 else ""
    print(f"  {ar_t:>10.3f} | {sh_:>+6.2f} {md_:>5.1f}% {tot_:>+5.0f}% {fl_:>4}/35 | {py_} {mark}")
H.regime_with_persistence=orig_func

if best_ar and best_ar_sh>1.52:
    print(f"  ★ BEST AR: {best_ar[0]:.3f} → Sh{best_ar_sh:+.2f}")
else:
    print(f"  → AR threshold không cải thiện vs baseline 0.04")

# ─── SUMMARY ───
print("\n"+"="*90)
print("ROUND 10 SUMMARY")
improvements=[]
if best_sl and best_sl_sh>1.52: improvements.append(f"SL: SI{best_sl[0]}/ST{best_sl[1]}/TR{best_sl[2]} Sh{best_sl_sh:+.2f}")
if best_tur and best_tur_sh>1.52: improvements.append(f"Turtle: F{best_tur[0]}/CUT{best_tur[1]} Sh{best_tur_sh:+.2f}")
if best_pa and best_pa_sh>1.52: improvements.append(f"Per-asset ADX BTC{best_pa[0]}/SOL{best_pa[1]} Sh{best_pa_sh:+.2f}")
if best_ar and best_ar_sh>1.52: improvements.append(f"AR_thresh {best_ar[0]:.3f} Sh{best_ar_sh:+.2f}")
if improvements:
    print(f"  IMPROVEMENTS FOUND: {len(improvements)}")
    for imp_ in improvements: print(f"  ★ {imp_}")
else:
    print(f"  NO NEW IMPROVEMENTS — ADX18 là ceiling với current method structure")
    print(f"  All param sweeps (SL/turtle/per-asset-ADX/AR-thresh) không vượt Sh+1.52")
