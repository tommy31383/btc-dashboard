#!/usr/bin/env python3
"""
chart-compare-3configs.py — Equity curve + bảng so sánh BASELINE vs OPT_A vs OPT_B.
Output: compare_3configs.png
"""
import json, datetime
import matplotlib.pyplot as plt
import matplotlib.gridspec as gridspec
import matplotlib.patches as mpatches
import numpy as np
from collections import defaultdict

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FEE=0.05/100; H4=4*3600*1000
SL_INIT=4.0; SL_TRAIL=3.0; SL_TRANS=24
ADX_T=20; VOL_MA=10; VOL_MULT=1.2
ATR_PCT_LB=90; ATR_PCT_PCTL=0.50
DON_LB=20; ATR_BREAK=1.2; EMA_FAST=50; EMA_SLOW=200
MAX_HOLD=200; CD={"S12":36,"S13":1,"S14":36}

print("Loading..."); raw=json.load(open(CACHE))
def load_tf(ms):
    b={}
    for c in raw:
        k=c["time"]//ms; ts=k*ms
        if k not in b: b[k]={"time":ts,"high":c["high"],"low":c["low"],"close":c["close"],"volume":c["volume"]}
        else:
            o=b[k]; o["high"]=max(o["high"],c["high"]); o["low"]=min(o["low"],c["low"]); o["close"]=c["close"]; o["volume"]+=c["volume"]
    return [b[k] for k in sorted(b)]

bars4h=load_tf(H4); bars1d=load_tf(86400*1000); bars1h=load_tf(3600*1000)
n=len(bars4h); c4=[b["close"] for b in bars4h]

def ema_s(xs,p):
    k=2/(p+1); out=[None]*len(xs); e=None
    for i,x in enumerate(xs): e=x if e is None else x*k+e*(1-k); out[i]=e
    return out
def _dm_tr(bars):
    nn=len(bars); pdm=[0.0]*nn; ndm=[0.0]*nn; tr=[0.0]*nn
    for i in range(1,nn):
        up=bars[i]["high"]-bars[i-1]["high"]; dn=bars[i-1]["low"]-bars[i]["low"]
        pdm[i]=up if up>dn and up>0 else 0; ndm[i]=dn if dn>up and dn>0 else 0
        tr[i]=max(bars[i]["high"]-bars[i]["low"],abs(bars[i]["high"]-bars[i-1]["close"]),abs(bars[i]["low"]-bars[i-1]["close"]))
    return pdm,ndm,tr
def adx_w(bars,period=14):
    pdm,ndm,tr=_dm_tr(bars); nn=len(bars)
    if nn<=period+1: return [None]*nn
    smTR=sum(tr[1:period+1]); smP=sum(pdm[1:period+1]); smN=sum(ndm[1:period+1])
    dx_arr=[]; av=None; out=[None]*nn
    for i in range(period+1,nn):
        smTR=smTR-smTR/period+tr[i]; smP=smP-smP/period+pdm[i]; smN=smN-smN/period+ndm[i]
        pdi=smP/smTR*100 if smTR>0 else 0; ndi=smN/smTR*100 if smTR>0 else 0
        dx=abs(pdi-ndi)/(pdi+ndi)*100 if (pdi+ndi)>0 else 0
        dx_arr.append(dx)
        if len(dx_arr)<period: continue
        elif len(dx_arr)==period: av=sum(dx_arr)/period
        else: av=(av*(period-1)+dx)/period
        out[i]=av
    return out
def atr_s(bars,period=14):
    _,_,tr=_dm_tr(bars); nn=len(bars); atr=[None]*nn
    s=sum(tr[1:period+1]); atr[period]=s/period
    for i in range(period+1,nn): atr[i]=(atr[i-1]*(period-1)+tr[i])/period
    return atr

e50=ema_s(c4,EMA_FAST); e200=ema_s(c4,EMA_SLOW)
atr4=atr_s(bars4h); adx4=adx_w(bars4h)
e200_1h=ema_s([b["close"] for b in bars1h],200); h1t=[b["time"] for b in bars1h]

def regime_build():
    cs=[b["close"] for b in bars1d]; nd=len(bars1d); rr=["RANGE"]*nd
    for i in range(200,nd):
        ma200=sum(cs[i-199:i+1])/200; ma50=sum(cs[i-50:i+1])/50
        ar=sum((b["high"]-b["low"])/b["close"] for b in bars1d[i-19:i+1])/20
        if cs[i]<ma200: rr[i]="BEAR"
        elif cs[i]>ma50 and ma50>ma200 and ar>0.04: rr[i]="BULL"
    out=["RANGE"]*nd; cur="RANGE"; cnt=0; lr="RANGE"
    for i in range(nd):
        r=rr[i]
        if r==lr: cnt+=1
        else: cnt=1; lr=r
        if cnt>=3: cur=r
        out[i]=cur
    return {bars1d[i]["time"]//86400000: out[i] for i in range(nd)}

reg_map=regime_build()
def get_reg(ts): return reg_map.get(ts//86400000,"RANGE")
def atp(i): return atr4[i]/c4[i] if atr4[i] and c4[i] else None
def atp_pass(i):
    if i<ATR_PCT_LB+14: return False
    vs=[atp(j) for j in range(i-ATR_PCT_LB,i) if atp(j)]
    if len(vs)<ATR_PCT_LB: return False
    cur=atp(i); return cur is not None and cur>=sorted(vs)[int(len(vs)*ATR_PCT_PCTL)]
def vol_pass(i):
    if i<VOL_MA: return False
    ma=sum(bars4h[j]["volume"] for j in range(i-VOL_MA,i))/VOL_MA
    return bars4h[i]["volume"]>=ma*VOL_MULT
def e200_1h_at(ts):
    lo,hi,idx=0,len(h1t)-1,0
    while lo<=hi:
        m=(lo+hi)//2
        if h1t[m]<=ts: idx=m; lo=m+1
        else: hi=m-1
    return e200_1h[idx]
def utc_h(ts): return datetime.datetime.utcfromtimestamp(ts/1000).hour
def utc_dw(ts): return datetime.datetime.utcfromtimestamp(ts/1000).weekday()
def base_filt(i):
    adv=adx4[i]; adv_p=adx4[i-1] if i>=1 else None
    if adv is None or adv<=ADX_T or adv_p is None or adv_p<=ADX_T: return False
    e1h=e200_1h_at(bars4h[i]["time"])
    if e1h is None or c4[i]<e1h: return False
    if not atp_pass(i): return False
    if utc_h(bars4h[i]["time"])==16 or utc_dw(bars4h[i]["time"]) in (3,6): return False
    return get_reg(bars4h[i]["time"])=="RANGE"
def sig_s12(i):
    if i<1 or None in (e50[i],e200[i],e50[i-1],e200[i-1]): return False
    return e50[i-1]<=e200[i-1] and e50[i]>e200[i]
def sig_s13(i): return bool(atr4[i] and i>=1 and c4[i]>bars4h[i-1]["close"]+atr4[i]*ATR_BREAK)
def sig_s14(i):
    if i<DON_LB: return False
    return c4[i]>max(bars4h[j]["high"] for j in range(i-DON_LB,i))
sigs={"S12":sig_s12,"S13":sig_s13,"S14":sig_s14}
do_vol={"S12":False,"S13":True,"S14":True}

def sim(ei, tps):
    ep=c4[ei]; ae=atr4[ei]
    if ae is None or ae<=0: return None
    sl=ep-ae*SL_INIT; hwm=ep; remaining=1.0; locked=0.0; tp_idx=0
    for h in range(1,MAX_HOLD+1):
        j=ei+h
        if j>=n: break
        while tp_idx<len(tps):
            tm,tf=tps[tp_idx]
            if bars4h[j]["high"]>=ep+ae*tm:
                locked+=tf*(ae*tm)/ep; remaining-=tf; tp_idx+=1
            else: break
        mult=SL_INIT if h<SL_TRANS else SL_TRAIL
        if c4[j]>hwm: hwm=c4[j]; sl=hwm-ae*mult
        elif h>=SL_TRANS:
            t=hwm-ae*SL_TRAIL
            if t>sl: sl=t
        if bars4h[j]["low"]<=sl:
            return locked+remaining*(sl-ep)/ep-2*FEE, h, bars4h[ei]["time"]
    j=min(ei+MAX_HOLD,n-1)
    return locked+remaining*(c4[j]-ep)/ep-2*FEE, MAX_HOLD, bars4h[ei]["time"]

def run(tps):
    trades=[]; last={s:0 for s in ["S12","S13","S14"]}
    for i in range(250,n-MAX_HOLD-1):
        if not base_filt(i): continue
        for sn in ["S12","S13","S14"]:
            if i-last[sn]<CD[sn]: continue
            if not sigs[sn](i): continue
            if do_vol[sn] and not vol_pass(i): continue
            r=sim(i,tps)
            if r is None: continue
            ret,h,ts=r
            yr=datetime.datetime.utcfromtimestamp(ts/1000).year
            dt=datetime.datetime.utcfromtimestamp(ts/1000)
            trades.append({"ret":ret,"h":h,"yr":yr,"sn":sn,"ts":ts,"dt":dt})
            last[sn]=i
    return trades

TPS_BASE=[]; TPS_A=[(2.0,0.50),(4.0,0.25)]; TPS_B=[(2.0,0.33),(5.0,0.33)]
CONFIGS=[
    ("BASELINE",  TPS_BASE, "#888888"),
    ("OPT_A ×2/×4 50/25", TPS_A, "#2196F3"),
    ("OPT_B ×2/×5 33/33", TPS_B, "#FF9800"),
]

print("Running backtests..."); all_trades={}
for label,tps,col in CONFIGS:
    all_trades[label]=run(tps); print(f"  {label}: {len(all_trades[label])} trades")

# ── Compute equity curves ─────────────────────────────────────────────────────
def equity_curve(trades):
    if not trades: return [],[]
    sorted_t=sorted(trades,key=lambda x:x["ts"])
    dts=[]; curve=[0.0]; equity=0.0
    for t in sorted_t:
        equity+=t["ret"]; curve.append(equity*100); dts.append(t["dt"])
    dts_full=[sorted_t[0]["dt"]]+dts
    return dts_full, curve

def stats(trades):
    if not trades: return {}
    rets=[t["ret"] for t in trades]; nn=len(rets)
    mean=sum(rets)/nn; sd=(sum((r-mean)**2 for r in rets)/nn)**0.5 or 1e-9
    ra=mean/sd; wr=sum(1 for r in rets if r>0)/nn*100
    wins=[r for r in rets if r>0]; losses=[r for r in rets if r<=0]
    rr=(sum(wins)/len(wins) if wins else 0)/abs(sum(losses)/len(losses) if losses else 1e-9)
    by_yr=defaultdict(float)
    for t in trades: by_yr[t["yr"]]+=t["ret"]
    pos=sum(1 for v in by_yr.values() if v>0)
    equity=0; peak=0; max_dd=0
    for t in sorted(trades,key=lambda x:x["yr"]):
        equity+=t["ret"]; peak=max(peak,equity); max_dd=max(max_dd,peak-equity)
    avg_win=sum(wins)/len(wins)*100 if wins else 0
    avg_loss=sum(losses)/len(losses)*100 if losses else 0
    return dict(n=nn,ra=ra,wr=wr,rr=rr,roi=sum(rets)*100,dd=max_dd*100,
                stab=f"{pos}/{len(by_yr)}",avg_win=avg_win,avg_loss=avg_loss)

# ── Plot ──────────────────────────────────────────────────────────────────────
fig = plt.figure(figsize=(18, 14), facecolor='#0d1117')
fig.suptitle('Hedge01 — Partial TP Comparison: BASELINE vs OPT_A vs OPT_B (7y BTC)',
             fontsize=15, color='white', fontweight='bold', y=0.98)

gs = gridspec.GridSpec(3, 3, figure=fig, hspace=0.45, wspace=0.35,
                       left=0.06, right=0.97, top=0.93, bottom=0.06)

ax_eq  = fig.add_subplot(gs[0, :])   # equity curve (full width)
ax_dd  = fig.add_subplot(gs[1, :])   # drawdown (full width)
ax_yr  = fig.add_subplot(gs[2, 0])   # per-year bar
ax_tbl = fig.add_subplot(gs[2, 1:])  # metrics table

BG = '#0d1117'; GRID_C = '#21262d'; TEXT = '#e6edf3'; DIM = '#8b949e'
for ax in [ax_eq, ax_dd, ax_yr, ax_tbl]:
    ax.set_facecolor(BG); ax.tick_params(colors=DIM); ax.spines[:].set_color(GRID_C)
    for label in ax.get_xticklabels()+ax.get_yticklabels(): label.set_color(DIM)

# ── Equity curve ──────────────────────────────────────────────────────────────
ax_eq.set_title('Equity Curve — Cumulative ROI %', color=TEXT, fontsize=11, pad=8)
ax_eq.axhline(0, color=GRID_C, linewidth=0.8)
ax_eq.set_ylabel('Cumulative ROI %', color=DIM, fontsize=9)
ax_eq.yaxis.grid(True, color=GRID_C, linewidth=0.5); ax_eq.set_axisbelow(True)

for label,tps,col in CONFIGS:
    dts,curve=equity_curve(all_trades[label])
    if dts:
        ax_eq.plot(dts, curve, color=col, linewidth=1.8 if label!="BASELINE" else 1.2,
                   alpha=0.9 if label!="BASELINE" else 0.6,
                   linestyle='--' if label=="BASELINE" else '-', label=label)
        ax_eq.annotate(f'{curve[-1]:+.0f}%', xy=(dts[-1],curve[-1]),
                       xytext=(5,0), textcoords='offset points',
                       color=col, fontsize=9, fontweight='bold')

# Year separators
for yr in range(2019,2027):
    ax_eq.axvline(datetime.datetime(yr,1,1), color=GRID_C, linewidth=0.6, alpha=0.7)
    ax_eq.text(datetime.datetime(yr,1,1), ax_eq.get_ylim()[0] if ax_eq.get_ylim()[0]!=0 else -10,
               str(yr), color='#444c56', fontsize=7, ha='left', va='bottom')

ax_eq.legend(loc='upper left', facecolor='#161b22', edgecolor=GRID_C,
             labelcolor=TEXT, fontsize=9)

# ── Drawdown ──────────────────────────────────────────────────────────────────
ax_dd.set_title('Drawdown from Peak %', color=TEXT, fontsize=11, pad=8)
ax_dd.set_ylabel('DD %', color=DIM, fontsize=9)
ax_dd.yaxis.grid(True, color=GRID_C, linewidth=0.5); ax_dd.set_axisbelow(True)

for label,tps,col in CONFIGS:
    trades_sorted=sorted(all_trades[label],key=lambda x:x["ts"])
    if not trades_sorted: continue
    dts_dd=[]; dd_curve=[]; equity=0; peak=0
    for t in trades_sorted:
        equity+=t["ret"]; peak=max(peak,equity)
        dd=(equity-peak)*100; dts_dd.append(t["dt"]); dd_curve.append(dd)
    if dts_dd:
        ax_dd.fill_between(dts_dd, dd_curve, 0, alpha=0.15, color=col)
        ax_dd.plot(dts_dd, dd_curve, color=col, linewidth=1.2,
                   linestyle='--' if label=="BASELINE" else '-', label=label,
                   alpha=0.8 if label!="BASELINE" else 0.5)

for yr in range(2019,2027):
    ax_dd.axvline(datetime.datetime(yr,1,1), color=GRID_C, linewidth=0.6, alpha=0.7)

ax_dd.legend(loc='lower left', facecolor='#161b22', edgecolor=GRID_C,
             labelcolor=TEXT, fontsize=9)
ax_dd.axhline(0, color=GRID_C, linewidth=0.8)

# ── Per-year bar chart ─────────────────────────────────────────────────────────
ax_yr.set_title('ROI% Per Year', color=TEXT, fontsize=11, pad=8)
all_yrs=sorted({t["yr"] for trades in all_trades.values() for t in trades})
x=np.arange(len(all_yrs)); w=0.25
for idx,(label,tps,col) in enumerate(CONFIGS):
    by_yr=defaultdict(float)
    for t in all_trades[label]: by_yr[t["yr"]]+=t["ret"]
    vals=[by_yr.get(yr,0)*100 for yr in all_yrs]
    bars=ax_yr.bar(x+(idx-1)*w, vals, w, label=label, color=col,
                   alpha=0.85, edgecolor='none')
    for bar,val in zip(bars,vals):
        if abs(val)>5:
            ax_yr.text(bar.get_x()+bar.get_width()/2, bar.get_height()+(2 if val>=0 else -8),
                       f'{val:+.0f}', ha='center', va='bottom' if val>=0 else 'top',
                       fontsize=6, color=col)

ax_yr.set_xticks(x); ax_yr.set_xticklabels(all_yrs, fontsize=8)
ax_yr.axhline(0, color=GRID_C, linewidth=0.8)
ax_yr.yaxis.grid(True, color=GRID_C, linewidth=0.5); ax_yr.set_axisbelow(True)
ax_yr.legend(facecolor='#161b22', edgecolor=GRID_C, labelcolor=TEXT, fontsize=7)
ax_yr.set_ylabel('ROI %', color=DIM, fontsize=8)

# ── Metrics table ──────────────────────────────────────────────────────────────
ax_tbl.axis('off')
ax_tbl.set_title('Metrics Comparison', color=TEXT, fontsize=11, pad=8)

metrics_data = []
row_labels = ['Config','RA 7y','WR','R:R','ROI 7y','Max DD','Stab','avg Win','avg Loss',
              'WF mean RA','WF pos/folds','Verdict']
wf_data = {
    "BASELINE":             ("+0.287", "4/5", "⚠️ MARGINAL"),
    "OPT_A ×2/×4 50/25":   ("+0.950", "5/5", "✅ ACCEPT"),
    "OPT_B ×2/×5 33/33":   ("+0.762", "5/5", "✅ ACCEPT"),
}

for label,tps,col in CONFIGS:
    s=stats(all_trades[label])
    wf=wf_data.get(label,("—","—","—"))
    col_data=[
        label.replace(" ×"," ×").replace("BASELINE","Trail SL only"),
        f"{s.get('ra',0):+.3f}",
        f"{s.get('wr',0):.0f}%",
        f"{s.get('rr',0):.2f}",
        f"{s.get('roi',0):+.1f}%",
        f"{s.get('dd',0):.1f}%",
        s.get('stab','—'),
        f"{s.get('avg_win',0):+.2f}%",
        f"{s.get('avg_loss',0):+.2f}%",
        wf[0], wf[1], wf[2],
    ]
    metrics_data.append(col_data)

# highlight best value per row
col_colors=[]
col_names=["BASELINE","OPT_A","OPT_B"]
COLS=["#333a44","#1a2a3a","#2a1f0f"]

table_vals=[[row_labels[r]]+[metrics_data[c][r] for c in range(3)] for r in range(len(row_labels))]
col_widths=[0.28,0.24,0.24,0.24]
tbl=ax_tbl.table(
    cellText=table_vals,
    colLabels=["Metric","BASELINE","OPT_A ×2/×4","OPT_B ×2/×5"],
    cellLoc='center', loc='center',
    colWidths=col_widths
)
tbl.auto_set_font_size(False); tbl.set_fontsize(8.5)
tbl.scale(1, 1.55)

# Style cells
highlight_rows_best_a = {1,2,4,8,9,10,11}   # rows where A is clearly best
highlight_rows_best_b = {3,5}                # rows where B is best (R:R, DD tradeoff)
for (r,c),cell in tbl.get_celld().items():
    cell.set_edgecolor(GRID_C)
    if r==0:  # header
        cell.set_facecolor('#161b22'); cell.set_text_props(color=TEXT, fontweight='bold', fontsize=9)
    elif c==0:  # row label
        cell.set_facecolor('#13181f'); cell.set_text_props(color=DIM, fontsize=8)
    elif c==1:  # baseline
        cell.set_facecolor('#1a1f27'); cell.set_text_props(color='#888888')
    elif c==2:  # OPT_A
        bg='#0d2137' if r in highlight_rows_best_a else '#13181f'
        cell.set_facecolor(bg); cell.set_text_props(color='#2196F3', fontweight='bold' if r in highlight_rows_best_a else 'normal')
    elif c==3:  # OPT_B
        bg='#1f1408' if r in highlight_rows_best_b else '#13181f'
        cell.set_facecolor(bg); cell.set_text_props(color='#FF9800', fontweight='bold' if r in highlight_rows_best_b else 'normal')

out_path="/Users/lap16116/BTC_PC/btc-dashboard/assets/compare_3configs.png"
plt.savefig(out_path, dpi=150, bbox_inches='tight', facecolor=BG)
print(f"\nSaved: {out_path}")
plt.close()
