#!/usr/bin/env python3
"""
hedge06-evolver.py — Continuous improvement loop for hedge06 StochRSI
Loop: analyze losers → mutate params → backtest → audit → keep champion → repeat

Goals:
  - Maximize: pos_months (dương mỗi tháng), min_yr_roi (worst year), n_per_month
  - Constraints: n_trades >= 150, pos_years >= 7/8, max_dd <= 30%
  - Score = pos_months * 10 + min_yr_roi * 0.5 + avg_monthly_roi

Stop: touch tools/hedge06-evolver-STOP
Champion saved: tools/hedge06-champion.json
Log: tools/hedge06-evolver.log
"""
import json, random, math, os, datetime, sys, time
from collections import defaultdict

CACHE      = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
STOP_FILE  = "/Users/lap16116/BTC_PC/btc-dashboard/tools/hedge06-evolver-STOP"
CHAMP_FILE = "/Users/lap16116/BTC_PC/btc-dashboard/tools/hedge06-champion.json"
LOG_FILE   = "/Users/lap16116/BTC_PC/btc-dashboard/tools/hedge06-evolver.log"
FEE        = 0.05 / 100
INITIAL    = 100_000

TF_MS = {
    "15m": 15 * 60 * 1000,
    "1h":  1  * 3600 * 1000,
    "4h":  4  * 3600 * 1000,
    "1d":  86400 * 1000,
}

def log(msg):
    ts = datetime.datetime.now().strftime("%H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    with open(LOG_FILE, "a") as f:
        f.write(line + "\n")

# ── Load & build bars ─────────────────────────────────────────────────────────
log("Loading 5m data...")
raw = json.load(open(CACHE))
raw.sort(key=lambda x: x['time'])

def build_tf(ms):
    b = {}
    for c in raw:
        k = c["time"] // ms
        if k not in b:
            b[k] = {"time": k*ms, "open": c["open"], "high": c["high"],
                    "low": c["low"], "close": c["close"]}
        else:
            b[k]["high"]  = max(b[k]["high"], c["high"])
            b[k]["low"]   = min(b[k]["low"],  c["low"])
            b[k]["close"] = c["close"]
    return [b[k] for k in sorted(b)]

bars15m = build_tf(TF_MS["15m"])
bars1h  = build_tf(TF_MS["1h"])
bars4h  = build_tf(TF_MS["4h"])
bars1d  = build_tf(TF_MS["1d"])

ALL_BARS = {
    "15m": bars15m,
    "1h":  bars1h,
    "4h":  bars4h,
    "1d":  bars1d,
}
log(f"15m:{len(bars15m)} 1h:{len(bars1h)} 4h:{len(bars4h)} 1d:{len(bars1d)}")

# ── Precompute ATR 4h ─────────────────────────────────────────────────────────
def build_atr(bars, p=14):
    out = [None]*len(bars)
    trs = [bars[0]['high']-bars[0]['low']]
    for i in range(1, len(bars)):
        tr = max(bars[i]['high']-bars[i]['low'],
                 abs(bars[i]['high']-bars[i-1]['close']),
                 abs(bars[i]['low'] -bars[i-1]['close']))
        trs.append(tr)
    avg = sum(trs[:p])/p; out[p-1] = avg
    for i in range(p, len(bars)):
        avg = (avg*(p-1)+trs[i])/p; out[i] = avg
    return out

atr_cache = {tf: build_atr(ALL_BARS[tf], 14) for tf in ALL_BARS}

# ── Precompute StochRSI components ────────────────────────────────────────────
def build_rsi(closes, p=14):
    out = [None]*len(closes)
    g = l = 0.0
    for i in range(1, p+1):
        d = closes[i]-closes[i-1]
        if d>0: g+=d
        else:   l-=d
    ag = g/p; al = l/p
    out[p] = 100 - 100/(1+ag/al) if al else 100
    for i in range(p+1, len(closes)):
        d = closes[i]-closes[i-1]
        ag = (ag*(p-1)+max(d,0))/p
        al = (al*(p-1)+max(-d,0))/p
        out[i] = 100 - 100/(1+ag/al) if al else 100
    return out

def build_stoch(vals, p):
    out = [None]*len(vals)
    for i in range(p-1, len(vals)):
        w = [x for x in vals[i-p+1:i+1] if x is not None]
        if len(w) < p or vals[i] is None: continue
        lo, hi = min(w), max(w)
        out[i] = (vals[i]-lo)/(hi-lo)*100 if hi!=lo else 50.0
    return out

def build_sma(vals, p):
    out = [None]*len(vals)
    for i in range(len(vals)):
        w = [v for v in vals[max(0,i-p+1):i+1] if v is not None]
        if len(w)==p: out[i] = sum(w)/p
    return out

closes4h = [b['close'] for b in bars4h]  # kept for regime/ema refs
rsi14    = build_rsi(closes4h, 14)       # kept for regime refs

# ── Precompute 1d regime ──────────────────────────────────────────────────────
def build_regime(bars):
    cs = [b['close'] for b in bars]
    n  = len(bars)
    rr = ['RANGE']*n
    for i in range(200, n):
        ma200 = sum(cs[i-199:i+1])/200
        ma50  = sum(cs[i-49:i+1])/50
        if cs[i] < ma200: rr[i] = 'BEAR'
        elif cs[i] > ma50 and ma50 > ma200: rr[i] = 'BULL'
    out = ['RANGE']*n; cur = 'RANGE'; cnt = 0; lr = 'RANGE'
    for i in range(n):
        r = rr[i]
        if r==lr: cnt+=1
        else: cnt=1; lr=r
        if cnt>=3: cur=r
        out[i] = cur
    return out

regime1d = build_regime(bars1d)
d1_times = [b['time'] for b in bars1d]

def get_regime(ts):
    lo, hi, idx = 0, len(d1_times)-1, 0
    while lo<=hi:
        m=(lo+hi)//2
        if d1_times[m]<=ts: idx=m; lo=m+1
        else: hi=m-1
    return regime1d[idx]

# ── EMA 200 on 1h ─────────────────────────────────────────────────────────────
c1h    = [b['close'] for b in bars1h]
ema200_1h = [None]*len(c1h)
k200 = 2/201; e = None
for i, x in enumerate(c1h):
    e = x if e is None else x*k200+e*(1-k200)
    ema200_1h[i] = e
h1_times = [b['time'] for b in bars1h]

def get_ema200_1h(ts):
    lo, hi, idx = 0, len(h1_times)-1, 0
    while lo<=hi:
        m=(lo+hi)//2
        if h1_times[m]<=ts: idx=m; lo=m+1
        else: hi=m-1
    return ema200_1h[idx]

# ── Precompute ADX on each TF ─────────────────────────────────────────────────
def build_adx(bars, p=14):
    """Returns (adx, plus_di, minus_di) arrays"""
    n = len(bars)
    adx_out = [None]*n; pdi_out = [None]*n; mdi_out = [None]*n
    trs=[]; pdm=[]; mdm=[]
    for i in range(n):
        if i==0:
            trs.append(bars[i]['high']-bars[i]['low'])
            pdm.append(0); mdm.append(0)
        else:
            h,l,ph,pl = bars[i]['high'],bars[i]['low'],bars[i-1]['high'],bars[i-1]['low']
            trs.append(max(h-l, abs(h-bars[i-1]['close']), abs(l-bars[i-1]['close'])))
            up = h-ph; dn = pl-l
            pdm.append(up if up>dn and up>0 else 0)
            mdm.append(dn if dn>up and dn>0 else 0)
    # Wilder smooth
    atr_w = sum(trs[:p]); pdm_w = sum(pdm[:p]); mdm_w = sum(mdm[:p])
    for i in range(p, n):
        atr_w = atr_w - atr_w/p + trs[i]
        pdm_w = pdm_w - pdm_w/p + pdm[i]
        mdm_w = mdm_w - mdm_w/p + mdm[i]
        pdi = 100*pdm_w/atr_w if atr_w else 0
        mdi = 100*mdm_w/atr_w if atr_w else 0
        dx  = 100*abs(pdi-mdi)/(pdi+mdi) if (pdi+mdi) else 0
        pdi_out[i]=pdi; mdi_out[i]=mdi
        if i == p*2-1:
            adx_w = dx
        elif i > p*2-1:
            adx_w = (adx_w*(p-1)+dx)/p
        if i >= p*2-1:
            adx_out[i] = adx_w
    return adx_out, pdi_out, mdi_out

adx_cache = {}
for _tf in ALL_BARS:
    _a, _p, _m = build_adx(ALL_BARS[_tf], 14)
    adx_cache[_tf] = (_a, _p, _m)

log("Indicators ready. (StochRSI + ATR + ADX on all TFs)")

# ── Default params ────────────────────────────────────────────────────────────
DEFAULT = {
    # Timeframe
    "tf":       "4h",  # 15m | 1h | 4h | 1d
    # StochRSI config
    "rsi_p":    14,    # RSI period
    "stoch_p":  14,    # Stoch period
    "k_smooth":  3,    # K smoothing
    "d_smooth":  3,    # D smoothing
    # Entry / exit thresholds
    "entry_k":   5,    # LONG: K cross up from < entry_k
    "exit_k":   95,    # LONG exit when K >= exit_k
    "use_short": False, # enable SHORT side
    "entry_k_s": 95,   # SHORT: K cross down from > entry_k_s
    "exit_k_s":   5,   # SHORT exit when K <= exit_k_s
    # Risk
    "sl_atr":   2.0,   # SL = ATR × sl_atr
    "tp_atr":   0.0,   # TP = ATR × tp_atr (0 = no fixed TP)
    "max_hold": 30,    # bars
    "pos_pct":  0.10,  # position size % equity
    # Filters
    "skip_bear":  False,
    "ema200_gate": False,
    "skip_bull":  False,
    "require_d_cross": False,
    "min_atr_pct": 0.0,
    "cooldown_bars": 0,
    # Side control
    "long_only":  False,
    "short_only": False,
    # ADX filter
    "adx_filter": False,
    "adx_min":    20,
    "adx_trend":  False,
    # Entry delay — chờ N bars sau signal rồi mới vào
    "entry_delay": 0,   # 0 = vào ngay, 1-5 = chờ N bars
    # Confirm: giá phải thấp hơn entry_px ban đầu (confirm bounce)
    "confirm_bounce": False,
}

PARAM_SPACE = {
    "tf":          ["15m", "1h", "4h", "1d"],
    "entry_k":     [3, 5, 8, 10, 15, 20],
    "exit_k":      [80, 85, 90, 95, 97, 100],
    "use_short":   [False, True],
    "entry_k_s":   [80, 85, 90, 95, 97],
    "exit_k_s":    [3, 5, 8, 10, 15, 20],
    "long_only":   [False, True],
    "short_only":  [False, True],
    "rsi_p":       [5, 7, 10, 14, 20],
    "adx_filter":  [False, True],
    "adx_min":     [15, 20, 25, 30],
    "adx_trend":   [False, True],
    "entry_delay": [0, 1, 2, 3, 5, 8, 12],
    "confirm_bounce": [False, True],
    "sl_atr":      [1.0, 1.5, 2.0, 2.5, 3.0],
    "tp_atr":      [0.0, 2.0, 3.0, 4.0, 5.0, 6.0, 8.0],
    "max_hold":    [10, 15, 20, 30, 40, 60],
    "pos_pct":     [0.05, 0.08, 0.10, 0.12, 0.15],
    "skip_bear":   [False, True],
    "ema200_gate": [False, True],
    "skip_bull":   [False, True],
    "require_d_cross": [False, True],
    "min_atr_pct": [0.0, 0.005, 0.008, 0.01, 0.015],
    "cooldown_bars": [0, 2, 4, 6],
    "k_smooth":    [1, 2, 3, 5],
    "stoch_p":     [10, 14, 20],
}

# ── Backtest engine ───────────────────────────────────────────────────────────
def backtest(p):
    tf   = p.get('tf', '4h')
    bars = ALL_BARS[tf]
    atrv = atr_cache[tf]
    adxv, pdiv, mdiv = adx_cache[tf]

    # build stochrsi with these params
    closes   = [b['close'] for b in bars]
    rsi_vals  = build_rsi(closes, p.get('rsi_p', 14))
    stoch_raw = build_stoch(rsi_vals, p['stoch_p'])
    k_line    = build_sma(stoch_raw, p['k_smooth'])
    d_line    = build_sma(k_line,    p['d_smooth'])

    equity        = INITIAL
    position      = None
    cd_end        = 0
    pending       = None   # {"side", "signal_bar", "signal_px", "entry_bar"}

    yr_pnl  = defaultdict(float)
    yr_n    = defaultdict(int)
    mo_pnl  = defaultdict(float)
    trades  = []

    entry_delay    = p.get('entry_delay', 0)
    confirm_bounce = p.get('confirm_bounce', False)

    for i in range(40, len(bars)):
        bar  = bars[i]
        ts   = bar['time']
        dt   = datetime.datetime.utcfromtimestamp(ts/1000)
        if dt.year < 2019: continue

        k_cur  = k_line[i]
        k_prev = k_line[i-1]
        d_cur  = d_line[i]
        d_prev = d_line[i-1]
        atr_v  = atrv[i]

        if k_cur is None or k_prev is None or atr_v is None: continue

        price = bar['close']

        # ── Manage position ───────────────────────────────────────────────────
        if position is not None:
            side = position['side']
            if side == 'LONG':
                hit_sl   = price <= position['sl']
                hit_tp   = (p['tp_atr'] > 0 and price >= position['tp'])
                hit_exit = k_cur >= p['exit_k']
            else:  # SHORT
                hit_sl   = price >= position['sl']
                hit_tp   = (p['tp_atr'] > 0 and price <= position['tp'])
                hit_exit = k_cur <= p.get('exit_k_s', 5)
            max_hold = (i - position['bar']) >= p['max_hold']

            if hit_sl or hit_tp or hit_exit or max_hold:
                exit_px = position['sl'] if hit_sl else price
                reason  = "SL" if hit_sl else ("TP" if hit_tp else ("EXIT_K" if hit_exit else "MAXHOLD"))

                if side == 'LONG':
                    pnl = (exit_px/position['entry_px']-1)*position['notional']
                else:
                    pnl = (1 - exit_px/position['entry_px'])*position['notional']

                fee = position['notional']*FEE*2
                net = pnl - fee
                equity = max(equity + net, 1)

                yr = position['dt'].year
                mo = f"{yr}-{position['dt'].month:02d}"
                yr_pnl[yr] += net; yr_n[yr] += 1; mo_pnl[mo] += net
                trades.append({"pnl": net, "reason": reason, "side": side,
                                "yr": yr, "mo": mo})
                position = None
                cd_end = i + p['cooldown_bars']

        # ── Entry ─────────────────────────────────────────────────────────────
        if position is None and i >= cd_end:
            # regime filter
            if p['skip_bear'] and get_regime(ts) == 'BEAR': continue
            if p['skip_bull'] and get_regime(ts) == 'BULL': continue
            # EMA200 gate
            if p['ema200_gate']:
                e200 = get_ema200_1h(ts)
                if e200 and price < e200: continue
            # ATR% filter
            if p['min_atr_pct'] > 0 and atr_v/price < p['min_atr_pct']: continue

            # ADX filter
            if p.get('adx_filter'):
                adx_v = adxv[i]
                if adx_v is None or adx_v < p.get('adx_min', 20): continue

            cross_up   = (k_prev < p['entry_k']   and k_cur >= p['entry_k'])
            cross_down = (p.get('use_short') and
                          k_prev > p.get('entry_k_s', 95) and k_cur <= p.get('entry_k_s', 95))

            # side control
            if p.get('long_only'):  cross_down = False
            if p.get('short_only'): cross_up   = False

            # ADX trend direction gate
            if p.get('adx_trend') and pdiv[i] is not None:
                if cross_up   and pdiv[i] <= mdiv[i]: cross_up   = False
                if cross_down and mdiv[i] <= pdiv[i]: cross_down = False

            # D cross filter (long only)
            if cross_up and p['require_d_cross']:
                if not (d_prev is not None and d_cur is not None and k_prev <= d_prev and k_cur > d_cur):
                    cross_up = False

            if not cross_up and not cross_down: continue

            # Lưu pending signal, chờ entry_delay bars
            side = "LONG" if cross_up else "SHORT"
            pending = {"side": side, "signal_bar": i,
                       "signal_px": price, "entry_bar": i + entry_delay}

        # ── Execute pending entry sau delay ───────────────────────────────────
        if position is None and pending is not None and i >= pending['entry_bar']:
            side  = pending['side']
            atr_v = atrv[i]
            if atr_v is None:
                pending = None
            else:
                ok = True
                # confirm_bounce: với LONG giá phải <= signal_px (chưa pump mạnh)
                if confirm_bounce:
                    if side == 'LONG'  and price > pending['signal_px']: ok = False
                    if side == 'SHORT' and price < pending['signal_px']: ok = False
                if ok:
                    notional = equity * p['pos_pct']
                    if side == 'LONG':
                        position = {
                            "side": "LONG",
                            "entry_px": price,
                            "sl": price - atr_v * p['sl_atr'],
                            "tp": price + atr_v * p['tp_atr'] if p['tp_atr'] > 0 else 1e18,
                            "notional": notional, "bar": i, "dt": dt,
                        }
                    else:
                        position = {
                            "side": "SHORT",
                            "entry_px": price,
                            "sl": price + atr_v * p['sl_atr'],
                            "tp": price - atr_v * p['tp_atr'] if p['tp_atr'] > 0 else 0,
                            "notional": notional, "bar": i, "dt": dt,
                        }
                pending = None

    # close at end
    if position is not None:
        last = bars[-1]
        ep = last['close']
        if position['side'] == 'LONG':
            pnl = (ep/position['entry_px']-1)*position['notional']
        else:
            pnl = (1-ep/position['entry_px'])*position['notional']
        net = pnl - position['notional']*FEE*2
        equity = max(equity+net, 1)
        yr = position['dt'].year; mo = f"{yr}-{position['dt'].month:02d}"
        yr_pnl[yr]+=net; yr_n[yr]+=1; mo_pnl[mo]+=net
        trades.append({"pnl": net, "reason": "END", "side": position['side'], "yr": yr, "mo": mo})

    return equity, yr_pnl, yr_n, mo_pnl, trades

# ── Score function ─────────────────────────────────────────────────────────────
def score(equity, yr_pnl, yr_n, mo_pnl, trades):
    if len(trades) < 100: return -9999
    n_trades = len(trades)

    # per-year check
    years = list(range(2019, 2027))
    yr_rois = {}
    eq = INITIAL
    for yr in years:
        pl = yr_pnl.get(yr, 0)
        roi = pl / eq * 100 if eq > 0 else -100
        yr_rois[yr] = roi
        eq += pl

    pos_years  = sum(1 for v in yr_rois.values() if v > 0)
    min_yr_roi = min(yr_rois.values()) if yr_rois else -100

    # per-month
    mo_rois = list(mo_pnl.values())
    pos_months = sum(1 for v in mo_rois if v > 0)
    total_months = len(mo_rois)
    pos_mo_pct = pos_months / total_months * 100 if total_months else 0

    # avg trades/month
    avg_n_mo = n_trades / total_months if total_months else 0

    # CAGR
    cagr = (equity/INITIAL)**(1/7) - 1

    # max DD
    eq_curve = [INITIAL]
    run = INITIAL
    for t in trades:
        run += t['pnl']; eq_curve.append(max(run, 1))
    peak = INITIAL; max_dd = 0
    for e in eq_curve:
        if e > peak: peak = e
        dd = (peak-e)/peak*100
        if dd > max_dd: max_dd = dd

    if max_dd > 35: return -9999
    if pos_years < 6: return -9999

    # composite score: weight pos_months heavily
    s = (pos_mo_pct * 2.0          # % tháng dương (max 200)
       + min_yr_roi * 0.3           # worst year (penalty if negative)
       + cagr * 100 * 0.5           # CAGR
       + avg_n_mo * 1.5             # avg trades/month
       + pos_years * 5.0)           # pos years bonus

    return s, {
        "cagr": round(cagr*100, 2),
        "max_dd": round(max_dd, 2),
        "n_trades": n_trades,
        "pos_years": pos_years,
        "pos_months": pos_months,
        "total_months": total_months,
        "pos_mo_pct": round(pos_mo_pct, 1),
        "avg_n_mo": round(avg_n_mo, 1),
        "min_yr_roi": round(min_yr_roi, 2),
        "yr_pnl": {str(k): round(v,2) for k,v in yr_pnl.items()},
        "yr_n":   {str(k): v for k,v in yr_n.items()},
        "yr_roi": {str(k): round(v,2) for k,v in yr_rois.items()},
        "equity": round(equity, 2),
    }

# ── Mutate ────────────────────────────────────────────────────────────────────
def mutate(p, strength=1):
    child = dict(p)
    keys = random.sample(list(PARAM_SPACE.keys()), min(strength, len(PARAM_SPACE)))
    for k in keys:
        child[k] = random.choice(PARAM_SPACE[k])
    return child

def crossover(p1, p2):
    child = {}
    for k in DEFAULT:
        v1 = p1.get(k, DEFAULT[k])
        v2 = p2.get(k, DEFAULT[k])
        child[k] = v1 if random.random() < 0.5 else v2
    return child

# ── Main loop ─────────────────────────────────────────────────────────────────
gen = 0
champion = None
champ_score = -9999
champ_params = dict(DEFAULT)
hof = []  # hall of fame top 5

# load existing champion
if os.path.exists(CHAMP_FILE):
    try:
        saved = json.load(open(CHAMP_FILE))
        champ_params = saved.get("params", DEFAULT)
        champ_score  = saved.get("score", -9999)
        champion     = saved.get("metrics")
        log(f"Loaded champion: score={champ_score:.1f}")
    except:
        pass

log("=" * 60)
log("  HEDGE06 EVOLVER — continuous loop started")
log(f"  Stop: touch {STOP_FILE}")
log("=" * 60)

# initial backtest of default
try:
    eq, yp, yn, mp, tr = backtest(champ_params)
    result = score(eq, yp, yn, mp, tr)
    if isinstance(result, tuple):
        champ_score, champion = result
        log(f"Init champion: score={champ_score:.1f} CAGR={champion['cagr']}% pos_mo={champion['pos_months']}/{champion['total_months']} n={champion['n_trades']}")
except Exception as e:
    log(f"Init error: {e}")

population = [dict(champ_params)]
for _ in range(9):
    population.append(mutate(champ_params, strength=random.randint(1, 4)))

while True:
    gen += 1
    if os.path.exists(STOP_FILE):
        log("STOP file detected. Exiting.")
        break

    # pick candidate: 70% mutate champion, 20% mutate HOF, 10% crossover
    r = random.random()
    if r < 0.70 or not hof:
        candidate = mutate(champ_params, strength=random.randint(1, 3))
    elif r < 0.90 and len(hof) >= 2:
        p1 = random.choice(hof)['params']
        p2 = random.choice(hof)['params']
        candidate = crossover(p1, p2)
        candidate = mutate(candidate, strength=1)
    else:
        candidate = mutate(random.choice(hof)['params'] if hof else champ_params,
                           strength=random.randint(2, 5))

    try:
        eq, yp, yn, mp, tr = backtest(candidate)
        result = score(eq, yp, yn, mp, tr)
    except Exception as e:
        log(f"Gen {gen} error: {e}")
        continue

    if not isinstance(result, tuple):
        continue

    s, metrics = result

    # update champion
    improved = s > champ_score
    if improved:
        champ_score  = s
        champ_params = candidate
        champion     = metrics
        sides = ("L+S" if candidate.get('use_short') and not candidate.get('long_only') and not candidate.get('short_only')
                 else ("SHORT" if candidate.get('short_only') else "LONG"))
        log(f"★ Gen {gen:4d} NEW CHAMPION  score={s:.1f}  tf={candidate.get('tf','4h')} {sides}  "
            f"CAGR={metrics['cagr']}%  DD={metrics['max_dd']}%  "
            f"n={metrics['n_trades']}  pos_yr={metrics['pos_years']}/8  "
            f"pos_mo={metrics['pos_months']}/{metrics['total_months']}({metrics['pos_mo_pct']}%)  "
            f"n/mo={metrics['avg_n_mo']}  min_yr={metrics['min_yr_roi']}%")

        # save champion
        save = {
            "gen": gen,
            "score": champ_score,
            "params": champ_params,
            "metrics": champion,
            "ts": datetime.datetime.now().isoformat(),
        }
        with open(CHAMP_FILE, "w") as f:
            json.dump(save, f, indent=2)

        # update HOF
        hof.append({"score": s, "params": dict(candidate), "metrics": metrics})
        hof.sort(key=lambda x: x['score'], reverse=True)
        hof = hof[:5]
    else:
        if gen % 50 == 0:
            log(f"  Gen {gen:4d}  score={s:.1f}  "
                f"CAGR={metrics['cagr']}%  pos_mo={metrics['pos_months']}/{metrics['total_months']}  "
                f"best={champ_score:.1f}")

log("Evolver done.")
