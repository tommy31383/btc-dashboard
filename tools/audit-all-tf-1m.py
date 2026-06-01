#!/usr/bin/env python3
"""
audit-all-tf-1m.py — Tìm hết signal có edge trong 30 ngày gần nhất (May 2026)

TF: 5m / 15m / 1h / 4h
Signal types mỗi TF: RSI, EMA cross, ATR breakout, Donchian, BB, Hammer, Volume, Momentum
Direction: LONG + SHORT (tìm hết)
Exit: fixed TP/SL grid (ATR multiples), không trailing

Accept: RA > 0.20 AND n >= 8
"""
import json, datetime, math
from collections import defaultdict

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FEE  = 0.05 / 100

# === DATA LOAD ===
print("Loading data...")
raw = json.load(open(CACHE))
raw.sort(key=lambda x: x["time"])

# Last 30 days
now_ms  = raw[-1]["time"]
cut_ms  = now_ms - 30 * 24 * 3600 * 1000
bars5m  = [b for b in raw if b["time"] >= cut_ms]
print(f"30d window: {datetime.datetime.utcfromtimestamp(bars5m[0]['time']/1000):%Y-%m-%d} → "
      f"{datetime.datetime.utcfromtimestamp(bars5m[-1]['time']/1000):%Y-%m-%d}  "
      f"({len(bars5m)} 5m bars)")

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

bars15m = agg_tf(bars5m, 15*60*1000)
bars1h  = agg_tf(bars5m,  1*3600*1000)
bars4h  = agg_tf(bars5m,  4*3600*1000)

# Also load 1h EMA200 from full 7y for gate
all1h = agg_tf([b for b in raw if b["time"] >= raw[0]["time"]], 3600*1000)

print(f"5m:{len(bars5m)} 15m:{len(bars15m)} 1h:{len(bars1h)} 4h:{len(bars4h)}")

# === INDICATORS ===
def ema(closes, n):
    k = 2/(n+1); out = [None]*len(closes); e = None
    for i,x in enumerate(closes):
        e = x if e is None else x*k+e*(1-k); out[i] = e
    return out

def rsi(closes, n=14):
    out = [None]*len(closes)
    gains = losses = 0.0
    for i in range(1, n+1):
        d = closes[i] - closes[i-1]
        if d > 0: gains += d
        else: losses -= d
    ag = gains/n; al = losses/n
    out[n] = 100 - 100/(1 + ag/al) if al > 0 else 100
    for i in range(n+1, len(closes)):
        d = closes[i] - closes[i-1]
        g = max(d, 0); l = max(-d, 0)
        ag = (ag*(n-1)+g)/n; al = (al*(n-1)+l)/n
        out[i] = 100 - 100/(1 + ag/al) if al > 0 else 100
    return out

def atr_s(bars, n=14):
    out = [None]*len(bars)
    tr_sum = 0.0
    for i in range(1, n+1):
        tr_sum += max(bars[i]["high"]-bars[i]["low"],
                      abs(bars[i]["high"]-bars[i-1]["close"]),
                      abs(bars[i]["low"] -bars[i-1]["close"]))
    out[n] = tr_sum/n
    for i in range(n+1, len(bars)):
        tr = max(bars[i]["high"]-bars[i]["low"],
                 abs(bars[i]["high"]-bars[i-1]["close"]),
                 abs(bars[i]["low"] -bars[i-1]["close"]))
        out[i] = (out[i-1]*(n-1)+tr)/n
    return out

def bb(closes, n=20, k=2.0):
    upper=[None]*len(closes); lower=[None]*len(closes); mid=[None]*len(closes)
    for i in range(n-1, len(closes)):
        w=closes[i-n+1:i+1]; m=sum(w)/n; s=(sum((x-m)**2 for x in w)/n)**0.5
        mid[i]=m; upper[i]=m+k*s; lower[i]=m-k*s
    return upper, mid, lower

def stoch(bars, n=14, sk=3):
    k_raw=[None]*len(bars)
    for i in range(n-1,len(bars)):
        hi=max(b["high"] for b in bars[i-n+1:i+1])
        lo=min(b["low"]  for b in bars[i-n+1:i+1])
        k_raw[i]=100*(bars[i]["close"]-lo)/(hi-lo) if hi>lo else 50
    k_smooth=ema(k_raw,sk); return k_smooth

def donchian_high(bars, n):
    out=[None]*len(bars)
    for i in range(n,len(bars)):
        out[i]=max(bars[j]["high"] for j in range(i-n,i))
    return out

def donchian_low(bars, n):
    out=[None]*len(bars)
    for i in range(n,len(bars)):
        out[i]=min(bars[j]["low"] for j in range(i-n,i))
    return out

def vol_ma(bars, n):
    out=[None]*len(bars)
    for i in range(n-1,len(bars)):
        out[i]=sum(bars[j]["volume"] for j in range(i-n+1,i+1))/n
    return out

# EMA200 1h gate (from full history)
closes_all1h = [b["close"] for b in all1h]
ema200_1h_all = ema(closes_all1h, 200)
ts_1h_all = [b["time"] for b in all1h]

def get_ema200_1h(ts):
    lo,hi,idx=0,len(ts_1h_all)-1,0
    while lo<=hi:
        m=(lo+hi)//2
        if ts_1h_all[m]<=ts: idx=m;lo=m+1
        else: hi=m-1
    return ema200_1h_all[idx]

# === BACKTEST ENGINE ===
def backtest(bars, signals, sl_atr, tp_atr, max_hold, label, cooldown=1):
    """
    signals: list of (bar_idx, direction) where direction in ('LONG','SHORT')
    sl_atr, tp_atr: ATR multiples
    Returns trades list
    """
    atr = atr_s(bars)
    trades = []
    last_exit = -cooldown
    for idx, side in signals:
        if idx <= last_exit: continue
        ae = atr[idx]
        if ae is None or ae <= 0: continue
        ep = bars[idx]["close"]
        if side == "LONG":
            sl = ep - ae*sl_atr
            tp = ep + ae*tp_atr
        else:
            sl = ep + ae*sl_atr
            tp = ep - ae*tp_atr
        ret = None; hold = 0
        for h in range(1, max_hold+1):
            j = idx+h
            if j >= len(bars): break
            hi = bars[j]["high"]; lo = bars[j]["low"]
            if side == "LONG":
                if lo <= sl: ret=(sl-ep)/ep - 2*FEE; hold=h; break
                if hi >= tp: ret=(tp-ep)/ep - 2*FEE; hold=h; break
            else:
                if hi >= sl: ret=(ep-sl)/ep - 2*FEE; hold=h; break
                if lo <= tp: ret=(ep-tp)/ep - 2*FEE; hold=h; break
        if ret is None:
            j2=min(idx+max_hold, len(bars)-1)
            ret=(bars[j2]["close"]-ep)/ep if side=="LONG" else (ep-bars[j2]["close"])/ep
            ret -= 2*FEE; hold=max_hold
        trades.append({"ret":ret,"hold":hold,"side":side})
        last_exit = idx+hold
    return trades

def report(trades, label, verbose=True):
    if len(trades) < 3: return None
    rets=[t["ret"] for t in trades]; n=len(rets)
    mean=sum(rets)/n; sd=(sum((r-mean)**2 for r in rets)/n)**0.5 or 1e-9
    ra=mean/sd; wr=sum(1 for r in rets if r>0)/n*100
    wins=[r for r in rets if r>0]; losses=[r for r in rets if r<=0]
    rr=(sum(wins)/len(wins) if wins else 0)/abs(sum(losses)/len(losses) if losses else 1e-9)
    roi=sum(rets)*100
    flag="✅" if ra>0.2 and n>=8 else ("⚠️" if ra>0 else "✗")
    if verbose:
        print(f"  {label:55s} n={n:4d} RA={ra:+.3f} WR={wr:.0f}% R:R={rr:.2f} ROI={roi:+.1f}% {flag}")
    return {"ra":ra,"n":n,"wr":wr,"rr":rr,"roi":roi,"label":label}

# === SIGNAL GENERATORS ===
def gen_signals_tf(bars, tf_name):
    """Generate all signals for a given TF bars. Returns dict: signal_name → [(idx,side)]"""
    n = len(bars)
    closes = [b["close"] for b in bars]
    opens  = [b["open"]  for b in bars]

    rsi14  = rsi(closes, 14)
    rsi7   = rsi(closes, 7)
    atr14  = atr_s(bars, 14)
    e9     = ema(closes, 9)
    e21    = ema(closes, 21)
    e50    = ema(closes, 50)
    e200   = ema(closes, 200)
    e5     = ema(closes, 5)
    stk    = stoch(bars, 14, 3)
    bbu, bbm, bbl = bb(closes, 20, 2.0)
    don_hi_10 = donchian_high(bars, 10)
    don_lo_10 = donchian_low(bars,  10)
    don_hi_20 = donchian_high(bars, 20)
    don_lo_20 = donchian_low(bars,  20)
    vma20  = vol_ma(bars, 20)

    sigs = defaultdict(list)

    for i in range(50, n-1):
        c = closes[i]; o = opens[i]
        hi= bars[i]["high"]; lo=bars[i]["low"]
        vol= bars[i]["volume"]
        bar_range = hi - lo

        # EMA200 1h gate
        e1h_val = get_ema200_1h(bars[i]["time"])
        long_ok  = e1h_val is None or c > e1h_val
        short_ok = e1h_val is None or c < e1h_val

        ae = atr14[i]
        if ae is None: continue

        # ----- RSI signals -----
        if rsi14[i] and rsi14[i-1]:
            # Long: RSI cross above 30
            if rsi14[i-1] < 30 <= rsi14[i] and long_ok:
                sigs[f"{tf_name}_RSI14_cross30_L"].append((i,"LONG"))
            # Short: RSI cross below 70
            if rsi14[i-1] > 70 >= rsi14[i] and short_ok:
                sigs[f"{tf_name}_RSI14_cross70_S"].append((i,"SHORT"))
            # Long: RSI oversold <25
            if rsi14[i] < 25 and long_ok:
                sigs[f"{tf_name}_RSI14_os25_L"].append((i,"LONG"))
            # Short: RSI overbought >75
            if rsi14[i] > 75 and short_ok:
                sigs[f"{tf_name}_RSI14_ob75_S"].append((i,"SHORT"))

        # Fast RSI7
        if rsi7[i] and rsi7[i-1]:
            if rsi7[i-1] < 25 <= rsi7[i] and long_ok:
                sigs[f"{tf_name}_RSI7_cross25_L"].append((i,"LONG"))
            if rsi7[i-1] > 75 >= rsi7[i] and short_ok:
                sigs[f"{tf_name}_RSI7_cross75_S"].append((i,"SHORT"))

        # ----- EMA cross -----
        if e9[i] and e21[i] and e9[i-1] and e21[i-1]:
            if e9[i-1] < e21[i-1] and e9[i] >= e21[i] and long_ok:
                sigs[f"{tf_name}_EMA9x21_L"].append((i,"LONG"))
            if e9[i-1] > e21[i-1] and e9[i] <= e21[i] and short_ok:
                sigs[f"{tf_name}_EMA9x21_S"].append((i,"SHORT"))
        if e50[i] and e200[i] and e50[i-1] and e200[i-1]:
            if e50[i-1] < e200[i-1] and e50[i] >= e200[i]:
                sigs[f"{tf_name}_EMA50x200_L"].append((i,"LONG"))
            if e50[i-1] > e200[i-1] and e50[i] <= e200[i]:
                sigs[f"{tf_name}_EMA50x200_S"].append((i,"SHORT"))

        # ----- ATR breakout -----
        if i > 0 and ae:
            if c > bars[i-1]["close"] + ae * 1.0 and long_ok:
                sigs[f"{tf_name}_ATRbrk1.0_L"].append((i,"LONG"))
            if c < bars[i-1]["close"] - ae * 1.0 and short_ok:
                sigs[f"{tf_name}_ATRbrk1.0_S"].append((i,"SHORT"))
            if c > bars[i-1]["close"] + ae * 1.5 and long_ok:
                sigs[f"{tf_name}_ATRbrk1.5_L"].append((i,"LONG"))
            if c < bars[i-1]["close"] - ae * 1.5 and short_ok:
                sigs[f"{tf_name}_ATRbrk1.5_S"].append((i,"SHORT"))

        # ----- Donchian breakout -----
        if don_hi_10[i] and c > don_hi_10[i] and long_ok:
            sigs[f"{tf_name}_Don10_L"].append((i,"LONG"))
        if don_lo_10[i] and c < don_lo_10[i] and short_ok:
            sigs[f"{tf_name}_Don10_S"].append((i,"SHORT"))
        if don_hi_20[i] and c > don_hi_20[i] and long_ok:
            sigs[f"{tf_name}_Don20_L"].append((i,"LONG"))
        if don_lo_20[i] and c < don_lo_20[i] and short_ok:
            sigs[f"{tf_name}_Don20_S"].append((i,"SHORT"))

        # ----- Bollinger Band -----
        if bbl[i] and bbu[i]:
            if lo <= bbl[i] and c > o and long_ok:
                sigs[f"{tf_name}_BB_low_bull_L"].append((i,"LONG"))
            if hi >= bbu[i] and c < o and short_ok:
                sigs[f"{tf_name}_BB_high_bear_S"].append((i,"SHORT"))
            if c < bbl[i] and long_ok:
                sigs[f"{tf_name}_BB_close_below_L"].append((i,"LONG"))
            if c > bbu[i] and short_ok:
                sigs[f"{tf_name}_BB_close_above_S"].append((i,"SHORT"))

        # ----- Stochastic -----
        if stk[i] and stk[i-1]:
            if stk[i-1] < 20 <= stk[i] and long_ok:
                sigs[f"{tf_name}_Stoch_cross20_L"].append((i,"LONG"))
            if stk[i-1] > 80 >= stk[i] and short_ok:
                sigs[f"{tf_name}_Stoch_cross80_S"].append((i,"SHORT"))

        # ----- Hammer / Shooting star -----
        body = abs(c - o)
        lower_wick = min(c,o) - lo
        upper_wick = hi - max(c,o)
        if bar_range > 0:
            # Hammer: long lower wick, small body, close near top
            if lower_wick >= 2*body and lower_wick >= 0.6*bar_range and long_ok:
                sigs[f"{tf_name}_Hammer_L"].append((i,"LONG"))
            # Shooting star: long upper wick, close near bottom
            if upper_wick >= 2*body and upper_wick >= 0.6*bar_range and short_ok:
                sigs[f"{tf_name}_ShootStar_S"].append((i,"SHORT"))
            # Engulfing
            if i>0:
                prev_body = abs(bars[i-1]["close"]-bars[i-1]["open"])
                prev_bull = bars[i-1]["close"] > bars[i-1]["open"]
                # Bull engulf: green candle body > red prev body
                if c>o and not prev_bull and body>prev_body and long_ok:
                    sigs[f"{tf_name}_BullEngulf_L"].append((i,"LONG"))
                if c<o and prev_bull and body>prev_body and short_ok:
                    sigs[f"{tf_name}_BearEngulf_S"].append((i,"SHORT"))

        # ----- Volume spike + direction -----
        if vma20[i] and vol > vma20[i]*2.5:
            if c > o and long_ok:
                sigs[f"{tf_name}_VolSpike_bull_L"].append((i,"LONG"))
            if c < o and short_ok:
                sigs[f"{tf_name}_VolSpike_bear_S"].append((i,"SHORT"))

        # ----- Momentum burst -----
        if i >= 3 and e5[i] and e5[i-1]:
            # Price acceleration (close strong vs recent)
            avg3 = sum(bars[j]["close"] for j in range(i-3,i))/3
            if c > avg3 * 1.004 and long_ok:
                sigs[f"{tf_name}_Mom_burst_L"].append((i,"LONG"))
            if c < avg3 * 0.996 and short_ok:
                sigs[f"{tf_name}_Mom_burst_S"].append((i,"SHORT"))

    return sigs

# === RUN ALL TFs ===
all_results = []
TF_CONFIG = [
    ("5m",  bars5m,  {"sl":1.5,"tp":2.0,"max_hold":48,  "cd":8}),   # max 4h hold
    ("15m", bars15m, {"sl":1.5,"tp":2.0,"max_hold":32,  "cd":4}),   # max 8h hold
    ("1h",  bars1h,  {"sl":2.0,"tp":3.0,"max_hold":24,  "cd":2}),   # max 1d hold
    ("4h",  bars4h,  {"sl":3.0,"tp":4.0,"max_hold":14,  "cd":1}),   # max ~2.3d hold
]

print()
for tf_name, bars, cfg in TF_CONFIG:
    print(f"\n{'='*75}")
    print(f"  TF={tf_name}  bars={len(bars)}  SL={cfg['sl']}×ATR  TP={cfg['tp']}×ATR  max_hold={cfg['max_hold']}bars")
    print(f"{'='*75}")

    sigs_dict = gen_signals_tf(bars, tf_name)

    tf_results = []
    for sig_name, sig_list in sorted(sigs_dict.items()):
        if len(sig_list) < 3: continue
        trades = backtest(bars, sig_list, cfg["sl"], cfg["tp"], cfg["max_hold"], sig_name, cfg["cd"])
        r = report(trades, sig_name)
        if r: tf_results.append(r); all_results.append(r)

    # TP/SL grid for top signals on this TF
    good = [r for r in tf_results if r["ra"] > 0.20 and r["n"] >= 8]
    if good:
        best = max(good, key=lambda x: x["ra"])
        print(f"\n  ⭐ Best: {best['label']} RA={best['ra']:+.3f} n={best['n']}")
        # Sweep TP/SL for best signal
        sig_name = best["label"]
        if sig_name in sigs_dict:
            print(f"  TP/SL sweep for {sig_name}:")
            for sl_m in [1.0, 1.5, 2.0]:
                for tp_m in [1.5, 2.0, 3.0, 4.0]:
                    t = backtest(bars, sigs_dict[sig_name], sl_m, tp_m, cfg["max_hold"], "", cfg["cd"])
                    r2 = report(t, f"  SL={sl_m}×  TP={tp_m}×")

# === FINAL SUMMARY ===
print(f"\n{'='*75}")
print("FINAL RANKING — all TF, sorted by RA (accept: RA>0.20, n>=8)")
print(f"{'='*75}")
accepted = [r for r in all_results if r["ra"] > 0.20 and r["n"] >= 8]
accepted.sort(key=lambda x: x["ra"], reverse=True)
if accepted:
    print(f"\n  {'Signal':55s}  {'n':>5}  {'RA':>7}  {'WR':>5}  {'R:R':>5}  {'ROI%':>7}")
    for r in accepted[:20]:
        print(f"  {r['label']:55s}  {r['n']:>5}  {r['ra']:>+7.3f}  {r['wr']:>4.0f}%  {r['rr']:>5.2f}  {r['roi']:>+6.1f}%")
else:
    print("  ⚠️  Không có signal nào pass accept criteria (RA>0.20, n>=8)")
    # Show best anyway
    if all_results:
        best5 = sorted(all_results, key=lambda x: x["ra"], reverse=True)[:5]
        print("  Top 5 tốt nhất:")
        for r in best5:
            print(f"    {r['label']:55s} RA={r['ra']:+.3f} n={r['n']}")

print(f"\n  Total signals tested: {len(all_results)}")
print(f"  Passed (RA>0.20, n>=8): {len(accepted)}")
