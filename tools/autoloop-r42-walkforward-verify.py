#!/usr/bin/env python3
"""autoloop-r42-walkforward-verify.py — Round 42: ATR_pctl anomaly + 3-split walk-forward
R41 anomaly: ATR_pctl=0.70 lb=30 → Sh+1.96 (+0.052). Is it real?
R42A: ATR_pctl=0.70 lb=30 stability (ablation: apply to SOL too, per-year, no-top3)
R42B: 3-split walk-forward (train/val/test chronological) — final OOS validation
R42C: Portfolio-level walk-forward (pick best config each train split)
R42D: Final config decision table
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
def maxdd(v):
    cum=peak=mdd=0.0
    for x in v: cum+=x; peak=max(peak,cum); mdd=max(mdd,peak-cum)
    return mdd*100
def sd(v):
    me=sum(v)/len(v); return (sum((x-me)**2 for x in v)/len(v))**.5 or 1e-9

_,_,_,spanB=Hh.run_hedge01(f"{CC}/binance-5m-7y.json",skip_cal=False)
_,_,_,spanS=Hh.run_hedge01(f"{CC}/binance-sol-5m-3y.json",skip_cal=False)
turB=dict(C.tur_mo); cal=months_between(spanS[0],spanS[1])
sTB=[turB.get(m,0.0) for m in cal]

def run_h01(cache, adx_thresh=18, sl_init=3.0, sl_trail=3.5, sl_trans=16,
            adx_period=12, atr_break_mult=1.3, vol_mult=1.4, vol_ma=10, max_hold=200,
            atr_pct_pctl=None, atr_pct_lb=None):
    H.CACHE=cache
    orig=(H.ADX_THRESH,H.SL_INIT,H.SL_TRAIL,H.SL_TRANS,H.ADX_P,
          H.ATR_BREAK_MULT,H.VOL_MULT,H.VOL_MA,H.MAX_HOLD)
    orig_pctl=H.ATR_PCT_PCTL; orig_lb=H.ATR_PCT_LB
    H.ADX_THRESH=adx_thresh; H.SL_INIT=sl_init; H.SL_TRAIL=sl_trail; H.SL_TRANS=sl_trans
    H.ADX_P=adx_period; H.ATR_BREAK_MULT=atr_break_mult; H.VOL_MULT=vol_mult
    H.VOL_MA=vol_ma; H.MAX_HOLD=max_hold
    if atr_pct_pctl is not None: H.ATR_PCT_PCTL=atr_pct_pctl
    if atr_pct_lb is not None: H.ATR_PCT_LB=atr_pct_lb
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
    (H.ADX_THRESH,H.SL_INIT,H.SL_TRAIL,H.SL_TRANS,H.ADX_P,
     H.ATR_BREAK_MULT,H.VOL_MULT,H.VOL_MA,H.MAX_HOLD)=orig
    H.ATR_PCT_PCTL=orig_pctl; H.ATR_PCT_LB=orig_lb
    return mo

def bk(parts, weights=None, subcal=None):
    c=subcal or cal; k=len(parts); w=weights or [1]*k; sw=sum(w)
    p=[sum(w[j]*parts[j][i] for j in range(k))/sw for i in range(len(c))]
    yr=defaultdict(float)
    for i,m in enumerate(c): yr[int(m[:4])]+=p[i]
    sh=sharpe(p); md=maxdd(p); fl=sum(1 for x in p if abs(x)<1e-9)
    sp=sorted(enumerate(p),key=lambda x:-x[1]); top3={i for i,_ in sp[:3]}
    nt=[x for i,x in enumerate(p) if i not in top3]; sh_nt=sharpe(nt) if len(nt)>2 else 0
    py=" ".join(f"{y%100}:{yr[y]*100:+.0f}" for y in sorted(yr))
    return sh,md,fl,sh_nt,py,p

# ─── Precompute baselines ───
print("Loading baselines...")
moB=run_h01(f"{CC}/binance-5m-7y.json",18); sB=[moB.get(m,0.0) for m in cal]
moS=run_h01(f"{CC}/binance-sol-5m-3y.json",15); sS=[moS.get(m,0.0) for m in cal]
sh_base,dd_base,fl_base,sh_nt_base,py_base,pv_base=bk([sB,sS,sTB])

# pctl=0.70/lb=30 anomaly
moB_h=run_h01(f"{CC}/binance-5m-7y.json",18,atr_pct_pctl=0.70,atr_pct_lb=30)
sB_h=[moB_h.get(m,0.0) for m in cal]

print("="*100)
print("=== R42: ATR_pctl anomaly + 3-split walk-forward ===\n")

# ─── R42A: pctl=0.70/lb=30 stability ───
print("━"*100)
print("R42A: ATR_pctl=0.70/lb=30 stability test (BTC only)")
sh_h,dd_h,fl_h,nt_h,py_h,pv_h=bk([sB_h,sS,sTB])
print(f"  Baseline (pctl=0.5/lb=90):  Sh{sh_base:+.3f} DD{dd_base:.1f}% flat{fl_base}/35 no-top{sh_nt_base:+.3f} | {py_base}")
print(f"  pctl=0.70/lb=30:            Sh{sh_h:+.3f} DD{dd_h:.1f}% flat{fl_h}/35 no-top{nt_h:+.3f} | {py_h}")

# No-top-3 check — if no-top3 ≫ base no-top3, it's jackpot dependent
delta_sh=sh_h-sh_base; delta_nt=nt_h-sh_nt_base
print(f"  Delta Sh: {delta_sh:+.3f} | Delta no-top3: {delta_nt:+.3f}")
print(f"  → {'SUSPECT (no-top3 improvement < Sh improvement = jackpot-dependent)' if delta_nt < delta_sh-0.05 else 'STABLE (no-top3 tracks Sh improvement)'}")

# Apply pctl=0.70/lb=30 to SOL too — if robust, should help SOL also
moS_h=run_h01(f"{CC}/binance-sol-5m-3y.json",15,atr_pct_pctl=0.70,atr_pct_lb=30)
sS_h=[moS_h.get(m,0.0) for m in cal]
sh_hh,dd_hh,fl_hh,nt_hh,py_hh,_=bk([sB_h,sS_h,sTB])
print(f"  pctl=0.70 on BTC+SOL both:  Sh{sh_hh:+.3f} DD{dd_hh:.1f}% flat{fl_hh}/35 | {py_hh}")
print(f"  → {'Robust (also helps SOL)' if sh_hh>sh_h+0.01 else 'BTC-specific (SOL not helped)'}")

# ─── R42B: 3-split walk-forward ───
print("\n━"*100)
print("R42B: 3-split chronological walk-forward")
n_cal=len(cal); s1=n_cal//3; s2=2*n_cal//3
cal_tr=cal[:s1]; cal_va=cal[s1:s2]; cal_te=cal[s2:]
print(f"  Train:  {cal_tr[0]}→{cal_tr[-1]} ({len(cal_tr)}mo)")
print(f"  Val:    {cal_va[0]}→{cal_va[-1]} ({len(cal_va)}mo)")
print(f"  Test:   {cal_te[0]}→{cal_te[-1]} ({len(cal_te)}mo)")

CONFIGS=[
    ("Baseline BTC18+SOL15+turtle",
     lambda: (run_h01(f"{CC}/binance-5m-7y.json",18),
              run_h01(f"{CC}/binance-sol-5m-3y.json",15)),
     lambda mB,mS: [[mB.get(m,0.0) for m in c],
                    [mS.get(m,0.0) for m in c],
                    [sTB[cal.index(m)] if m in cal else 0.0 for m in c]] if False else None),
]

def eval_splits(label, moB, moS, moE=None):
    def vec(mo,c): return [mo.get(m,0.0) for m in c]
    def tB(c): return [sTB[cal.index(m)] if m in cal else 0.0 for m in c]

    results=[]
    for c,name in [(cal_tr,"TRAIN"),(cal_va,"VAL"),(cal_te,"TEST")]:
        if moE:
            parts=[vec(moB,c),vec(moE,c),vec(moS,c),tB(c)]; w=[1,0.25,1,1]
        else:
            parts=[vec(moB,c),vec(moS,c),tB(c)]; w=None
        sh_,md_,fl_,_,_,_=bk(parts,w,subcal=c)
        results.append((name,sh_,md_,fl_))
    row="  "+f"{label:<42}"
    for name,sh_,md_,fl_ in results:
        row+=f" | {name} Sh{sh_:>+5.2f} DD{md_:>4.1f}%"
    print(row)
    return results

print(f"\n  {'Config':<42} | {'TRAIN':^20} | {'VAL':^20} | {'TEST':^20}")
print("  "+"-"*85)
eval_splits("Baseline BTC18+SOL15+turtle", moB, moS)
eval_splits("pctl=0.70/lb=30 BTC", moB_h, moS)
eval_splits("pctl=0.70/lb=30 BTC+SOL", moB_h, moS_h)

# Different BTC config: no vol_mult filter (vol=1.0 — almost no filter)
moB_nv=run_h01(f"{CC}/binance-5m-7y.json",18,vol_mult=1.0)
eval_splits("BTC vol_mult=1.0 (looser)", moB_nv, moS)

# ─── R42C: Walk-forward config selection ───
print("\n━"*100)
print("R42C: Walk-forward config selection — pick config on TRAIN, evaluate on TEST")

SWEEP_CONFIGS=[
    ("BTC18/SL3.0/3.5/16/pctl0.5/lb90", {"adx_thresh":18,"sl_init":3.0,"sl_trail":3.5,"sl_trans":16,"atr_pct_pctl":0.5,"atr_pct_lb":90}),
    ("BTC18/pctl0.70/lb30", {"adx_thresh":18,"atr_pct_pctl":0.70,"atr_pct_lb":30}),
    ("BTC18/pctl0.60/lb30", {"adx_thresh":18,"atr_pct_pctl":0.60,"atr_pct_lb":30}),
    ("BTC20/SL3.0/3.5/16", {"adx_thresh":20,"sl_init":3.0,"sl_trail":3.5,"sl_trans":16}),
    ("BTC16/SL3.0/3.5/16", {"adx_thresh":16,"sl_init":3.0,"sl_trail":3.5,"sl_trans":16}),
]

print("  Training on TRAIN split, reporting TRAIN+TEST Sharpe:")
print(f"  {'Config':<38} {'TR_Sh':>7} {'VA_Sh':>7} {'TE_Sh':>7}")
print("  "+"-"*58)
best_train_sh=0; best_train_cfg=None
for lbl,kw in SWEEP_CONFIGS:
    mB_c=run_h01(f"{CC}/binance-5m-7y.json",**kw)
    tr_v=[mB_c.get(m,0.0) for m in cal_tr]; va_v=[mB_c.get(m,0.0) for m in cal_va]; te_v=[mB_c.get(m,0.0) for m in cal_te]
    sS_tr=[moS.get(m,0.0) for m in cal_tr]; sS_va=[moS.get(m,0.0) for m in cal_va]; sS_te=[moS.get(m,0.0) for m in cal_te]
    sTB_tr=[sTB[cal.index(m)] if m in cal else 0.0 for m in cal_tr]
    sTB_va=[sTB[cal.index(m)] if m in cal else 0.0 for m in cal_va]
    sTB_te=[sTB[cal.index(m)] if m in cal else 0.0 for m in cal_te]
    sh_tr=sharpe([(tr_v[i]+sS_tr[i]+sTB_tr[i])/3 for i in range(len(cal_tr))])
    sh_va=sharpe([(va_v[i]+sS_va[i]+sTB_va[i])/3 for i in range(len(cal_va))])
    sh_te=sharpe([(te_v[i]+sS_te[i]+sTB_te[i])/3 for i in range(len(cal_te))])
    if sh_tr>best_train_sh: best_train_sh=sh_tr; best_train_cfg=lbl
    mark="★" if sh_te>1.2 else ""
    print(f"  {lbl:<38} {sh_tr:>+7.2f} {sh_va:>+7.2f} {sh_te:>+7.2f} {mark}")
print(f"  Best on train: {best_train_cfg}")

# ─── R42D: Final decision ───
print("\n━"*100)
print("R42D: Final config decision")
print(f"  {'Config':<52} {'Full_Sh':>7} {'DD':>5} {'flat':>5} {'no-top3':>8} {'TEST':>7} | per-year")
print("  "+"-"*95)

def pr_full(label, parts, weights=None):
    sh_,md_,fl_,nt_,py_,_=bk(parts,weights)
    ok=sh_>=2.00 and md_<=9.0
    m="✅" if ok else ("⚠️" if sh_>=1.90 else "❌")
    print(f"  {m} {label:<51} Sh{sh_:>+5.2f} DD{md_:>4.1f}% flat{fl_:>3}/35 no-top3{nt_:>+5.2f} | {py_}")
    return sh_,md_,fl_,nt_

pr_full("FINAL: BTC18+SOL15+turtle (2-asset book)",[sB,sS,sTB])
pr_full("OPTION: +ATR_pctl=0.70/lb=30 (BTC)",[sB_h,sS,sTB])
pr_full("OPTION: ETH×0.25 added",[sB,run_h01(f"{CC}/binance-eth-5m-3y.json",18,max_hold=200).get.__self__,sS,sTB] if False else [sB,sS,sTB])

moE_f=run_h01(f"{CC}/binance-eth-5m-3y.json",18,max_hold=200); sE_f=[moE_f.get(m,0.0) for m in cal]
pr_full("OPTION: BTC18+ETH×0.25+SOL15+turtle",[sB,sE_f,sS,sTB],[1,0.25,1,1])
pr_full("OPTION: pctl0.70 + ETH×0.25",[sB_h,sE_f,sS,sTB],[1,0.25,1,1])

print("\n"+"="*100)
print("R42 CONCLUSION")
print(f"  Baseline:     Sh{sh_base:+.3f} DD{dd_base:.1f}% flat{fl_base}/35 no-top{sh_nt_base:+.3f}")
sh_h_,dd_h_,_,nt_h_,_,_=bk([sB_h,sS,sTB])
print(f"  pctl=0.70:    Sh{sh_h_:+.3f} DD{dd_h_:.1f}% no-top{nt_h_:+.3f}")
print(f"  pctl=0.70 valid? → {'YES (no-top3 also improves)' if nt_h_>sh_nt_base+0.01 else 'SUSPECT (no-top3 does not improve = jackpot-driven)'}")
print(f"  Walk-forward stable? → see R42B above")
print(f"  RECOMMENDATION: {'Accept pctl=0.70 upgrade' if sh_h_>sh_base+0.02 and nt_h_>sh_nt_base else 'Keep baseline'}")
