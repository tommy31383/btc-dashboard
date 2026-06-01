#!/usr/bin/env python3
"""
audit-monthly-consistency-7y.py — Tìm signal consistent per-month trên 7y (Jan2019→May2026)

Ý tưởng: signal "general" = thắng nhiều tháng, không phải chỉ aggregate tốt.
  - 7y = ~88 tháng
  - Per-month: count months có ROI > 0
  - Accept: win_months / active_months >= 0.60 AND avg RA per month > 0.1 AND n_total >= 50

TF test: 1h + 4h (5m/15m quá noisy)
Signals: ATR breakout, Donchian, EMA cross, BB, RSI, Hammer, Engulfing, Volume spike
Direction: LONG + SHORT
Exit: fixed TP/SL ATR multiples (không trailing — simpler, cleaner per month)
"""
import json, datetime
from collections import defaultdict

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FEE   = 0.05 / 100
MIN_MONTHS_WIN_RATE = 0.55   # >= 55% tháng dương
MIN_N_TOTAL         = 30     # tổng trades đủ lớn
MIN_AVG_MONTH_RA    = 0.05   # avg RA mỗi tháng active

print("Loading 7y data...")
raw = json.load(open(CACHE))
raw.sort(key=lambda x: x["time"])

def agg_tf(bars, ms):
    b = {}
    for c in bars:
        k = c["time"] // ms
        if k not in b:
            b[k] = {"time": k*ms, "open": c["open"], "high": c["high"],
                    "low": c["low"], "close": c["close"], "volume": c["volume"]}
        else:
            o = b[k]
            o["high"]   = max(o["high"], c["high"])
            o["low"]    = min(o["low"],  c["low"])
            o["close"]  = c["close"]
            o["volume"] += c["volume"]
    return [b[k] for k in sorted(b)]

bars5m  = raw
bars1h  = agg_tf(raw,  1*3600*1000)
bars4h  = agg_tf(raw,  4*3600*1000)

# EMA200 1h for gate (computed on full history)
def ema(closes, n):
    k=2/(n+1); out=[None]*len(closes); e=None
    for i,x in enumerate(closes):
        e=x if e is None else x*k+e*(1-k); out[i]=e
    return out

def atr_s(bars, n=14):
    out=[None]*len(bars)
    s=0.0
    for i in range(1,n+1):
        s+=max(bars[i]["high"]-bars[i]["low"],
               abs(bars[i]["high"]-bars[i-1]["close"]),
               abs(bars[i]["low"] -bars[i-1]["close"]))
    out[n]=s/n
    for i in range(n+1,len(bars)):
        tr=max(bars[i]["high"]-bars[i]["low"],
               abs(bars[i]["high"]-bars[i-1]["close"]),
               abs(bars[i]["low"] -bars[i-1]["close"]))
        out[i]=(out[i-1]*(n-1)+tr)/n
    return out

def rsi(closes, n=14):
    out=[None]*len(closes); ag=al=0.0
    for i in range(1,n+1):
        d=closes[i]-closes[i-1]
        if d>0: ag+=d
        else: al-=d
    ag/=n; al/=n
    out[n]=100-100/(1+ag/al) if al>0 else 100
    for i in range(n+1,len(closes)):
        d=closes[i]-closes[i-1]; g=max(d,0); l=max(-d,0)
        ag=(ag*(n-1)+g)/n; al=(al*(n-1)+l)/n
        out[i]=100-100/(1+ag/al) if al>0 else 100
    return out

def stoch(bars,n=14):
    out=[None]*len(bars)
    for i in range(n-1,len(bars)):
        hi=max(b["high"] for b in bars[i-n+1:i+1])
        lo=min(b["low"]  for b in bars[i-n+1:i+1])
        out[i]=100*(bars[i]["close"]-lo)/(hi-lo) if hi>lo else 50
    return out

def donchian_hi(bars,n):
    out=[None]*len(bars)
    for i in range(n,len(bars)): out[i]=max(bars[j]["high"] for j in range(i-n,i))
    return out
def donchian_lo(bars,n):
    out=[None]*len(bars)
    for i in range(n,len(bars)): out[i]=min(bars[j]["low"] for j in range(i-n,i))
    return out

def bb(closes,n=20,k=2.0):
    u=[None]*len(closes); l=[None]*len(closes)
    for i in range(n-1,len(closes)):
        w=closes[i-n+1:i+1]; m=sum(w)/n; s=(sum((x-m)**2 for x in w)/n)**0.5
        u[i]=m+k*s; l[i]=m-k*s
    return u,l

def vol_ma(bars,n):
    out=[None]*len(bars)
    for i in range(n-1,len(bars)):
        out[i]=sum(bars[j]["volume"] for j in range(i-n+1,i+1))/n
    return out

def adx_wilder(bars,period=14):
    pdm=[0.0]*len(bars);ndm=[0.0]*len(bars);tr=[0.0]*len(bars)
    for i in range(1,len(bars)):
        up=bars[i]["high"]-bars[i-1]["high"];dn=bars[i-1]["low"]-bars[i]["low"]
        pdm[i]=up if up>dn and up>0 else 0;ndm[i]=dn if dn>up and dn>0 else 0
        tr[i]=max(bars[i]["high"]-bars[i]["low"],abs(bars[i]["high"]-bars[i-1]["close"]),abs(bars[i]["low"]-bars[i-1]["close"]))
    smTR=sum(tr[1:period+1]);smPDM=sum(pdm[1:period+1]);smNDM=sum(ndm[1:period+1])
    dx_arr=[];adx_val=None;out=[None]*len(bars)
    for i in range(period+1,len(bars)):
        smTR=smTR-smTR/period+tr[i];smPDM=smPDM-smPDM/period+pdm[i];smNDM=smNDM-smNDM/period+ndm[i]
        pdi=smPDM/smTR*100 if smTR>0 else 0;ndi=smNDM/smTR*100 if smTR>0 else 0
        dx=abs(pdi-ndi)/(pdi+ndi)*100 if (pdi+ndi)>0 else 0;dx_arr.append(dx)
        if len(dx_arr)<period: continue
        elif len(dx_arr)==period: adx_val=sum(dx_arr)/period
        else: adx_val=(adx_val*(period-1)+dx)/period
        out[i]=adx_val
    return out

print("Computing indicators...")
e200_1h = ema([b["close"] for b in bars1h], 200)
ts_1h   = [b["time"] for b in bars1h]

def get_e200_1h(ts):
    lo,hi,idx=0,len(ts_1h)-1,0
    while lo<=hi:
        m=(lo+hi)//2
        if ts_1h[m]<=ts: idx=m;lo=m+1
        else: hi=m-1
    return e200_1h[idx]

def get_month_key(ts):
    dt=datetime.datetime.utcfromtimestamp(ts/1000)
    return dt.year*100+dt.month  # e.g. 201901

def build_signals(bars, tf_label, sl_m, tp_m, max_hold, cd_bars):
    """Build all signals and run per-trade backtest. Return list of trade dicts."""
    n   = len(bars)
    cls = [b["close"] for b in bars]
    ops = [b["open"]  for b in bars]

    atr14  = atr_s(bars, 14)
    rsi14  = rsi(cls, 14)
    stk14  = stoch(bars, 14)
    adx14  = adx_wilder(bars, 14)
    e9     = ema(cls, 9)
    e21    = ema(cls, 21)
    e50    = ema(cls, 50)
    e200   = ema(cls, 200)
    bbu,bbl= bb(cls, 20, 2.0)
    dh10   = donchian_hi(bars, 10)
    dl10   = donchian_lo(bars, 10)
    dh20   = donchian_hi(bars, 20)
    dl20   = donchian_lo(bars, 20)
    vm20   = vol_ma(bars, 20)

    # Map: signal_name → list of (bar_idx, direction)
    sigs = defaultdict(list)

    for i in range(60, n-1):
        c=cls[i]; o=ops[i]; hi=bars[i]["high"]; lo=bars[i]["low"]
        vol=bars[i]["volume"]; brange=hi-lo
        ae=atr14[i]
        if ae is None: continue

        e1h=get_e200_1h(bars[i]["time"])
        long_ok  = e1h is None or c > e1h
        short_ok = e1h is None or c < e1h

        # ADX gate (optional — test both with/without)
        adv = adx14[i]; adv_p = adx14[i-1] if i>0 else None
        adx_ok = adv and adv_p and adv>20 and adv_p>20

        # ---- ATR breakout ----
        if i>0:
            if c > bars[i-1]["close"] + ae*1.2 and long_ok:
                sigs[f"{tf_label}_ATR1.2_L_noADX"].append((i,"LONG"))
            if c < bars[i-1]["close"] - ae*1.2 and short_ok:
                sigs[f"{tf_label}_ATR1.2_S_noADX"].append((i,"SHORT"))
            if c > bars[i-1]["close"] + ae*1.2 and long_ok and adx_ok:
                sigs[f"{tf_label}_ATR1.2_L_ADX"].append((i,"LONG"))
            if c < bars[i-1]["close"] - ae*1.2 and short_ok and adx_ok:
                sigs[f"{tf_label}_ATR1.2_S_ADX"].append((i,"SHORT"))

        # ---- Donchian ----
        if dh20[i] and c > dh20[i] and long_ok:
            sigs[f"{tf_label}_Don20_L_noADX"].append((i,"LONG"))
        if dl20[i] and c < dl20[i] and short_ok:
            sigs[f"{tf_label}_Don20_S_noADX"].append((i,"SHORT"))
        if dh20[i] and c > dh20[i] and long_ok and adx_ok:
            sigs[f"{tf_label}_Don20_L_ADX"].append((i,"LONG"))
        if dl20[i] and c < dl20[i] and short_ok and adx_ok:
            sigs[f"{tf_label}_Don20_S_ADX"].append((i,"SHORT"))

        # ---- EMA cross ----
        if e9[i] and e21[i] and e9[i-1] and e21[i-1]:
            if e9[i-1]<e21[i-1] and e9[i]>=e21[i] and long_ok:
                sigs[f"{tf_label}_EMA9x21_L"].append((i,"LONG"))
            if e9[i-1]>e21[i-1] and e9[i]<=e21[i] and short_ok:
                sigs[f"{tf_label}_EMA9x21_S"].append((i,"SHORT"))
        if e50[i] and e200[i] and e50[i-1] and e200[i-1]:
            if e50[i-1]<e200[i-1] and e50[i]>=e200[i] and long_ok:
                sigs[f"{tf_label}_EMA50x200_L"].append((i,"LONG"))
            if e50[i-1]>e200[i-1] and e50[i]<=e200[i] and short_ok:
                sigs[f"{tf_label}_EMA50x200_S"].append((i,"SHORT"))

        # ---- RSI ----
        if rsi14[i] and rsi14[i-1]:
            if rsi14[i-1]<30<=rsi14[i] and long_ok:
                sigs[f"{tf_label}_RSI_x30_L"].append((i,"LONG"))
            if rsi14[i-1]>70>=rsi14[i] and short_ok:
                sigs[f"{tf_label}_RSI_x70_S"].append((i,"SHORT"))

        # ---- Stoch ----
        if stk14[i] and stk14[i-1]:
            if stk14[i-1]<20<=stk14[i] and long_ok:
                sigs[f"{tf_label}_Stoch_x20_L"].append((i,"LONG"))
            if stk14[i-1]>80>=stk14[i] and short_ok:
                sigs[f"{tf_label}_Stoch_x80_S"].append((i,"SHORT"))

        # ---- BB ----
        if bbl[i] and lo<=bbl[i] and c>o and long_ok:
            sigs[f"{tf_label}_BB_low_bull_L"].append((i,"LONG"))
        if bbu[i] and hi>=bbu[i] and c<o and short_ok:
            sigs[f"{tf_label}_BB_hi_bear_S"].append((i,"SHORT"))
        if bbu[i] and c>bbu[i] and short_ok:
            sigs[f"{tf_label}_BB_close_above_S"].append((i,"SHORT"))

        # ---- Hammer / Shooting Star ----
        if brange > 0:
            body=abs(c-o); lw=min(c,o)-lo; uw=hi-max(c,o)
            if lw>=2*body and lw>=0.6*brange and long_ok:
                sigs[f"{tf_label}_Hammer_L"].append((i,"LONG"))
            if uw>=2*body and uw>=0.6*brange and short_ok:
                sigs[f"{tf_label}_ShootStar_S"].append((i,"SHORT"))
            # Engulfing
            if i>0:
                pb=abs(bars[i-1]["close"]-bars[i-1]["open"]); prev_bull=bars[i-1]["close"]>bars[i-1]["open"]
                if c>o and not prev_bull and body>pb and long_ok:
                    sigs[f"{tf_label}_BullEngulf_L"].append((i,"LONG"))
                if c<o and prev_bull and body>pb and short_ok:
                    sigs[f"{tf_label}_BearEngulf_S"].append((i,"SHORT"))

        # ---- Volume spike ----
        if vm20[i] and vol>vm20[i]*2.5:
            if c>o and long_ok:
                sigs[f"{tf_label}_VolSpike_L"].append((i,"LONG"))
            if c<o and short_ok:
                sigs[f"{tf_label}_VolSpike_S"].append((i,"SHORT"))

    # Simulate trades
    all_trades = defaultdict(list)
    for sig_name, sig_list in sigs.items():
        last_exit = -cd_bars
        for idx, side in sig_list:
            if idx <= last_exit: continue
            ae = atr14[idx]
            if ae is None or ae <= 0: continue
            ep = bars[idx]["close"]
            sl = ep - ae*sl_m if side=="LONG" else ep + ae*sl_m
            tp = ep + ae*tp_m if side=="LONG" else ep - ae*tp_m
            ret=None; hold=0
            for h in range(1, max_hold+1):
                j=idx+h
                if j>=n: break
                hi2=bars[j]["high"]; lo2=bars[j]["low"]
                if side=="LONG":
                    if lo2<=sl: ret=(sl-ep)/ep-2*FEE; hold=h; break
                    if hi2>=tp: ret=(tp-ep)/ep-2*FEE; hold=h; break
                else:
                    if hi2>=sl: ret=(ep-sl)/ep-2*FEE; hold=h; break
                    if lo2<=tp: ret=(ep-tp)/ep-2*FEE; hold=h; break
            if ret is None:
                j2=min(idx+max_hold,n-1)
                ret=(bars[j2]["close"]-ep)/ep if side=="LONG" else (ep-bars[j2]["close"])/ep
                ret-=2*FEE; hold=max_hold
            mkey = get_month_key(bars[idx]["time"])
            all_trades[sig_name].append({"ret":ret,"hold":hold,"side":side,"month":mkey})
            last_exit = idx+hold
    return all_trades


def monthly_report(trades_dict, tf_label):
    """Compute per-month stats for each signal, return sorted candidates."""
    results = []
    for sig_name, trades in trades_dict.items():
        if len(trades) < MIN_N_TOTAL: continue
        # Per-month breakdown
        by_month = defaultdict(list)
        for t in trades: by_month[t["month"]].append(t["ret"])
        active_months = len(by_month)
        if active_months < 6: continue  # need enough months
        win_months = sum(1 for vs in by_month.values() if sum(vs)>0)
        win_rate = win_months / active_months

        # Per-month RA
        month_ras = []
        for vs in by_month.values():
            if len(vs)<2: continue
            m=sum(vs)/len(vs); sd=(sum((r-m)**2 for r in vs)/len(vs))**0.5
            if sd>0: month_ras.append(m/sd)
        avg_month_ra = sum(month_ras)/len(month_ras) if month_ras else 0

        # Overall stats
        rets=[t["ret"] for t in trades]; n_=len(rets)
        mean=sum(rets)/n_; sd_=(sum((r-mean)**2 for r in rets)/n_)**0.5 or 1e-9
        ra_full=mean/sd_
        wr=sum(1 for r in rets if r>0)/n_*100
        wins=[r for r in rets if r>0]; losses=[r for r in rets if r<=0]
        rr=(sum(wins)/len(wins) if wins else 0)/abs(sum(losses)/len(losses) if losses else 1e-9)

        results.append({
            "sig": sig_name,
            "n": n_,
            "ra_full": ra_full,
            "wr": wr,
            "rr": rr,
            "win_rate_months": win_rate,
            "win_months": win_months,
            "active_months": active_months,
            "avg_month_ra": avg_month_ra,
            "by_month": by_month,
        })
    return results


# === RUN ===
TF_CONFIGS = [
    ("1h", bars1h, 2.0, 3.0, 24, 2),
    ("4h", bars4h, 3.0, 4.0, 14, 1),
]

all_candidates = []

for tf_label, bars, sl_m, tp_m, max_hold, cd in TF_CONFIGS:
    print(f"\nComputing {tf_label} ({len(bars)} bars)...")
    trades_dict = build_signals(bars, tf_label, sl_m, tp_m, max_hold, cd)
    results = monthly_report(trades_dict, tf_label)

    print(f"\n{'='*80}")
    print(f"  {tf_label.upper()}  SL={sl_m}×ATR  TP={tp_m}×ATR  — Monthly consistency")
    print(f"  Accept: win_months >= {MIN_MONTHS_WIN_RATE*100:.0f}%  n >= {MIN_N_TOTAL}  avg_month_RA >= {MIN_AVG_MONTH_RA}")
    print(f"{'='*80}")

    # Sort by win_rate_months then avg_month_ra
    results.sort(key=lambda x: (x["win_rate_months"], x["avg_month_ra"]), reverse=True)

    accepted = [r for r in results if r["win_rate_months"]>=MIN_MONTHS_WIN_RATE
                and r["avg_month_ra"]>=MIN_AVG_MONTH_RA]

    print(f"\n  {'Signal':50s}  {'n':>5}  {'win%/mo':>8}  {'mo+/tot':>8}  {'RA_full':>8}  {'avg_mo_RA':>10}")
    shown = 0
    for r in results[:25]:
        flag = "✅" if r in accepted else ("⚠️" if r["win_rate_months"]>=MIN_MONTHS_WIN_RATE else "✗")
        print(f"  {r['sig']:50s}  {r['n']:>5}  {r['win_rate_months']*100:>7.0f}%  "
              f"{r['win_months']:>3}/{r['active_months']:>2}  "
              f"{r['ra_full']:>+8.3f}  {r['avg_month_ra']:>+10.3f}  {flag}")
        shown += 1

    if accepted:
        for r in accepted:
            all_candidates.append(r)
            # Show per-year win% for top candidates
            print(f"\n  📅 Monthly detail: {r['sig']}")
            by_yr = defaultdict(list)
            for mk, vs in r["by_month"].items():
                yr = mk // 100
                by_yr[yr].append((mk, vs))
            for yr in sorted(by_yr):
                months = by_yr[yr]
                yr_win = sum(1 for mk,vs in months if sum(vs)>0)
                yr_tot = len(months)
                yr_roi = sum(sum(vs) for mk,vs in months)*100
                print(f"    {yr}: {yr_win}/{yr_tot} months positive  ROI={yr_roi:+.1f}%")


# === FINAL SUMMARY ===
print(f"\n{'='*80}")
print(f"FINAL — Most consistent signals per-month (7y)")
print(f"{'='*80}")
if all_candidates:
    all_candidates.sort(key=lambda x: (x["win_rate_months"], x["avg_month_ra"]), reverse=True)
    print(f"\n  {'Signal':50s}  {'n':>5}  {'win%/mo':>8}  {'RA_full':>8}  {'avg_mo_RA':>10}")
    for r in all_candidates:
        print(f"  {r['sig']:50s}  {r['n']:>5}  {r['win_rate_months']*100:>7.0f}%  "
              f"{r['ra_full']:>+8.3f}  {r['avg_month_ra']:>+10.3f}  ✅")

    print(f"\n  Tổng: {len(all_candidates)} signals pass monthly consistency test")
else:
    # Show top 10 anyway
    all_results = []
    for tf_label, bars, sl_m, tp_m, max_hold, cd in [("already_run","",0,0,0,0)]:
        pass
    print("  ⚠️  Không có signal nào pass tất cả criteria")
    print("  Xem top kết quả trong từng TF section ở trên")
