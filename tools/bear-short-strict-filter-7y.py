#!/usr/bin/env python3
"""
bear-short-strict-filter-7y.py — Follow-up to bear-short-retest-7y.py.

HYPOTHESIS: M2 (rally-short to falling 4h EMA50, BEAR-gated) nets ~$0 over 7y because the
MA200 BEAR label fires during bull-market dips (false bears 2021/2023/2024/2025 that V-recover
and squeeze shorts). Require N CONSECUTIVE DAYS in BEAR before allowing shorts -> brief bull dips
(which recover before N days) get skipped, sustained real bears (2022, 2026) keep firing.

TASKS:
  1. Measure BEAR-run lengths -> distribution of real vs false bears, find separating threshold.
  2. M2 + consecutive-BEAR filter sweep N in {0,15,30,45,60,75,90,120}.
  3. Robustness: era-split, entry-timing (how much move is left after waiting N days), 2026 check.
  4. Funding/cost realism + correlation of the sleeve with long sleeves (proxy = BTC B&H ret).

Reuses M2 + regime EXACTLY from bear-short-retest-7y.py. Cost = 0.1% RT + realized funding
(Binance: rate>0 => short earns). Judge Sharpe + DOLLARS + per-year. Era-robust = BOTH 2022 and
2026 positive AND net 7y positive. n<10/yr is an overfit red flag.
"""
import json, datetime
from collections import defaultdict

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
FUNDING = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-funding-7y.json"
FEE = 0.05 / 100
H4 = 4 * 3600 * 1000
H1 = 3600 * 1000
D1 = 86400 * 1000
ATR_P = 14
MAX_HOLD_4H = 200


def load_tf(ms):
    raw = json.load(open(CACHE)); b = {}
    for c in raw:
        k = c["time"] // ms
        if k not in b:
            b[k] = {"time": k * ms, "open": c["open"], "high": c["high"],
                    "low": c["low"], "close": c["close"], "volume": c["volume"]}
        else:
            o = b[k]; o["high"] = max(o["high"], c["high"]); o["low"] = min(o["low"], c["low"])
            o["close"] = c["close"]; o["volume"] += c["volume"]
    return [b[k] for k in sorted(b)]


def ema_s(xs, n):
    k = 2 / (n + 1); out = [None] * len(xs); e = None
    for i, x in enumerate(xs):
        e = x if e is None else x * k + e * (1 - k); out[i] = e
    return out


def _dm_tr(bars):
    n = len(bars); tr = [0.0] * n
    for i in range(1, n):
        tr[i] = max(bars[i]["high"] - bars[i]["low"],
                    abs(bars[i]["high"] - bars[i - 1]["close"]),
                    abs(bars[i]["low"] - bars[i - 1]["close"]))
    return tr


def atr_series(bars, period=ATR_P):
    tr = _dm_tr(bars); n = len(bars); atr = [None] * n
    if n <= period: return atr
    s = sum(tr[1:period + 1]); atr[period] = s / period
    for i in range(period + 1, n):
        atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period
    return atr


def regime_persist(bars1d, persist_n=3):
    cs = [b["close"] for b in bars1d]; n = len(bars1d); raw = ["RANGE"] * n
    for i in range(200, n):
        ma200 = sum(cs[i - 199:i + 1]) / 200
        ma50 = sum(cs[i - 50:i + 1]) / 50
        r20 = bars1d[i - 19:i + 1]
        ar = sum((b["high"] - b["low"]) / b["close"] for b in r20) / 20
        if cs[i] < ma200: raw[i] = "BEAR"
        elif cs[i] > ma50 and ma50 > ma200 and ar > 0.04: raw[i] = "BULL"
    out = ["RANGE"] * n; cur = "RANGE"; cnt = 0; last = "RANGE"
    for i in range(n):
        r = raw[i]
        if r == last: cnt += 1
        else: cnt = 1; last = r
        if cnt >= persist_n: cur = r
        out[i] = cur
    return out


def load_funding():
    f = json.load(open(FUNDING))
    return [(x["time"], x["rate"]) for x in f if x["rate"] is not None]


def funding_pnl(fund, t0, t1, sign_short_earns=True):
    tot = 0.0
    for ts, rate in fund:
        if ts < t0: continue
        if ts > t1: break
        tot += rate if sign_short_earns else -rate
    return tot


def yr_of(ts): return datetime.datetime.utcfromtimestamp(ts / 1000).year


def metrics(trades):
    if not trades: return None
    rets = [t["ret"] for t in trades]; n = len(rets)
    mean = sum(rets) / n
    sd = (sum((r - mean) ** 2 for r in rets) / n) ** 0.5 or 1e-9
    sharpe = mean / sd
    wr = sum(1 for r in rets if r > 0) / n * 100
    eq = 100000.0; peak = eq; mdd = 0.0
    for t in sorted(trades, key=lambda x: x["entry_ts"]):
        eq *= (1 + t["ret"]); peak = max(peak, eq); mdd = max(mdd, (peak - eq) / peak)
    total_roi = (eq / 100000.0 - 1) * 100
    by_yr = defaultdict(float)
    for t in trades: by_yr[t["yr"]] += t["ret"]
    pos_yrs = sum(1 for v in by_yr.values() if v > 0)
    n_stop = sum(1 for t in trades if t["reason"] == "STOP")
    return {"n": n, "sharpe": sharpe, "wr": wr, "total_roi": total_roi, "mdd": mdd * 100,
            "pos_yrs": pos_yrs, "n_yrs": len(by_yr), "by_yr": dict(by_yr), "final_eq": eq,
            "n_stop": n_stop, "sum_ret": sum(rets)}


def main():
    print("Loading data...")
    b4 = load_tf(H4); b1h = load_tf(H1); b1d = load_tf(D1); fund = load_funding()
    c4 = [b["close"] for b in b4]; n4 = len(b4)
    c1d = [b["close"] for b in b1d]; n1d = len(b1d)
    e50_4 = ema_s(c4, 50); atr4 = atr_series(b4)
    reg1d = regime_persist(b1d)
    reg_map = {b["time"] // D1: reg1d[i] for i, b in enumerate(b1d)}
    def get_reg(ts): return reg_map.get(ts // D1, "RANGE")

    # ---- consecutive BEAR-day counter per timestamp ----
    # For each day index, how many consecutive days (incl today) regime has been BEAR.
    bear_streak = [0] * n1d
    s = 0
    for i in range(n1d):
        if reg1d[i] == "BEAR": s += 1
        else: s = 0
        bear_streak[i] = s
    streak_map = {b1d[i]["time"] // D1: bear_streak[i] for i in range(n1d)}
    def streak_at(ts): return streak_map.get(ts // D1, 0)

    print(f"4h bars: {n4}  1d bars: {n1d}  funding: {len(fund)}")

    # ================= TASK 1: BEAR-run length distribution =================
    print("\n" + "#" * 78)
    print("# TASK 1 — Contiguous BEAR windows: duration + price move + real/false label")
    print("#" * 78)
    runs = []  # (start_idx, end_idx)
    i = 0
    while i < n1d:
        if reg1d[i] == "BEAR":
            j = i
            while j < n1d and reg1d[j] == "BEAR": j += 1
            runs.append((i, j - 1)); i = j
        else: i += 1
    print(f"{'start':<12}{'end':<12}{'days':>6}{'price move':>12}{'trough':>10}   label")
    real_lens = []; false_lens = []
    for (a, b) in runs:
        days = b - a + 1
        p0 = c1d[a]; p1 = c1d[b]
        move = (p1 - p0) / p0 * 100
        trough = (min(c1d[a:b + 1]) - p0) / p0 * 100
        # real bear = sustained down: end price well below start (close < -10%)
        label = "REAL" if move < -10 else "false"
        if label == "REAL": real_lens.append(days)
        else: false_lens.append(days)
        d0 = datetime.datetime.utcfromtimestamp(b1d[a]["time"] / 1000).strftime("%Y-%m-%d")
        d1 = datetime.datetime.utcfromtimestamp(b1d[b]["time"] / 1000).strftime("%Y-%m-%d")
        print(f"{d0:<12}{d1:<12}{days:>6}{move:>11.0f}%{trough:>9.0f}%   {label}")
    print(f"\n  REAL-bear run lengths (days): {sorted(real_lens, reverse=True)}")
    print(f"  FALSE-bear run lengths (days): {sorted(false_lens, reverse=True)}")
    if false_lens:
        print(f"  Longest FALSE bear = {max(false_lens)}d ; Shortest REAL bear = {min(real_lens) if real_lens else 'n/a'}d")
        print(f"  => Separating threshold sits between {max(false_lens)}d (false max) and "
              f"{min(real_lens) if real_lens else 'n/a'}d (real min).")

    # ----- M2 simulator (identical structure to bear-short-retest) -----
    def sim_short_4h(ei, atr_mult_init, atr_mult_trail, trans_bars,
                     use_funding=True, fund_short_earns=True):
        ep = c4[ei]; ae = atr4[ei]
        if ae is None or ae <= 0: return None
        sl = ep + ae * atr_mult_init; hwm = ep
        for h in range(1, MAX_HOLD_4H + 1):
            j = ei + h
            if j >= n4: break
            mult = atr_mult_init if h < trans_bars else atr_mult_trail
            if c4[j] < hwm:
                hwm = c4[j]; sl = hwm + ae * mult
            elif h >= trans_bars:
                t = hwm + ae * atr_mult_trail
                if t < sl: sl = t
            if b4[j]["high"] >= sl:
                raw = (ep - sl) / ep
                return _mk(ei, j, ep, raw, "STOP", use_funding, fund_short_earns)
        j = min(ei + MAX_HOLD_4H, n4 - 1)
        raw = (ep - c4[j]) / ep
        return _mk(ei, j, ep, raw, "TIMEOUT", use_funding, fund_short_earns)

    def _mk(ei, j, ep, raw, reason, use_funding, fund_short_earns):
        t0 = b4[ei]["time"]; t1 = b4[j]["time"]
        f = funding_pnl(fund, t0, t1, fund_short_earns) if use_funding else 0.0
        return {"ret": raw - 2 * FEE + f, "raw": raw, "fund": f, "reason": reason,
                "yr": yr_of(t0), "entry_ts": t0, "exit_ts": t1, "h": j - ei,
                "streak": streak_at(t0)}

    def run_m2(min_streak=0, use_funding=True, fund_short_earns=True):
        trades = []; last = -999; CD = 18
        for i in range(260, n4 - MAX_HOLD_4H):
            ts = b4[i]["time"]
            if get_reg(ts) != "BEAR": continue
            if streak_at(ts) < min_streak: continue          # <-- strict consecutive-BEAR filter
            if e50_4[i] is None or e50_4[i - 5] is None: continue
            if e50_4[i] >= e50_4[i - 5]: continue
            if c4[i - 1] >= e50_4[i - 1] and c4[i] < e50_4[i]:
                if i - last < CD: continue
                tr = sim_short_4h(i, 1.5, 3.0, 12, use_funding, fund_short_earns)
                if tr: trades.append(tr); last = i
        return trades

    # ================= TASK 2: sweep =================
    print("\n" + "#" * 78)
    print("# TASK 2 — M2 + consecutive-BEAR filter sweep (funding modeled, short earns)")
    print("#" * 78)
    Ns = [0, 15, 30, 45, 60, 75, 90, 120]
    base = run_m2(0)
    base_false = [t for t in base if t["yr"] in (2019, 2020, 2021, 2023, 2024, 2025)]
    base_false_n = len(base_false)
    print(f"{'N':>5}{'n':>5}{'ROI%':>9}{'Sharpe':>8}{'MaxDD':>7}{'stab':>6}"
          f"{'2022':>8}{'2026':>8}{'falseElim%':>11}")
    sweep = {}
    for N in Ns:
        tr = run_m2(N); m = metrics(tr); sweep[N] = (tr, m)
        if m is None:
            print(f"{N:>5}    NO TRADES"); continue
        false_tr = [t for t in tr if t["yr"] in (2019, 2020, 2021, 2023, 2024, 2025)]
        elim = (1 - len(false_tr) / base_false_n) * 100 if base_false_n else 0
        b22 = m["by_yr"].get(2022, 0) * 100; b26 = m["by_yr"].get(2026, 0) * 100
        print(f"{N:>5}{m['n']:>5}{m['total_roi']:>8.1f}{m['sharpe']:>8.3f}{m['mdd']:>6.0f}%"
              f"{m['pos_yrs']:>3}/{m['n_yrs']}{b22:>7.0f}%{b26:>7.0f}%{elim:>10.0f}%")

    # detailed per-year for each N
    print("\n  --- Per-year P&L ($100k/trade additive %) by N ---")
    for N in Ns:
        tr, m = sweep[N]
        if m is None: continue
        ys = "  ".join(f"{y}:{m['by_yr'][y]*100:+.0f}%(n{sum(1 for t in tr if t['yr']==y)})"
                       for y in sorted(m['by_yr']))
        print(f"  N={N:>3}: {ys}")

    # ================= TASK 3: robustness =================
    print("\n" + "#" * 78)
    print("# TASK 3 — Robustness: era-split, entry timing, 2026")
    print("#" * 78)

    # pick best N = net positive, both 2022&2026 positive, max Sharpe, n reasonable
    cand = []
    for N in Ns:
        tr, m = sweep[N]
        if m is None: continue
        b22 = m["by_yr"].get(2022, -1); b26 = m["by_yr"].get(2026, -1)
        if m["total_roi"] > 0 and b22 > 0 and b26 > 0:
            cand.append((m["sharpe"], N, m))
    cand.sort(reverse=True)
    if cand:
        best_N = cand[0][1]
        print(f"  Candidate Ns meeting (net+ AND 2022+ AND 2026+): "
              f"{[c[1] for c in cand]}  -> best by Sharpe: N={best_N}")
    else:
        best_N = None
        print("  NO N satisfies (net positive AND both 2022 & 2026 positive).")

    # entry timing: for each real bear, how many days into bear does first short fire at chosen N,
    # and how much of the bear's down-move is left after that.
    def entry_timing(N):
        print(f"\n  Entry timing at N={N} (real bears 2022, 2026):")
        for (a, b) in runs:
            days = b - a + 1
            move = (c1d[b] - c1d[a]) / c1d[a] * 100
            if move >= -10: continue  # real bears only
            tr = run_m2(N)
            yr_first = None
            run_t0 = b1d[a]["time"]; run_t1 = b1d[b]["time"] + D1
            fires = [t for t in tr if run_t0 <= t["entry_ts"] <= run_t1]
            d0 = datetime.datetime.utcfromtimestamp(b1d[a]["time"]/1000).strftime("%Y-%m-%d")
            if not fires:
                print(f"    bear {d0} ({days}d, {move:+.0f}%): NO short fired at N={N}")
                continue
            first = min(fires, key=lambda t: t["entry_ts"])
            days_in = (first["entry_ts"] - b1d[a]["time"]) / D1
            entry_px = c4[[k for k in range(n4) if b4[k]["time"] == first["entry_ts"]][0]]
            trough = min(c1d[a:b + 1])
            move_left = (trough - entry_px) / entry_px * 100
            captured = (c1d[a] - entry_px) / c1d[a] * 100
            print(f"    bear {d0} ({days}d, {move:+.0f}%): first short {days_in:.0f}d in, "
                  f"{len(fires)} shorts, move already gone={captured:+.0f}%, "
                  f"move left to trough={move_left:+.0f}%")
    if best_N is not None:
        entry_timing(best_N)
        # also show timing at 0 for contrast
        entry_timing(0)

    # 2026 specific at best N
    if best_N is not None:
        tr, m = sweep[best_N]
        tr26 = [t for t in tr if t["yr"] == 2026]
        print(f"\n  2026 at N={best_N}: n={len(tr26)} shorts, "
              f"P&L={sum(t['ret'] for t in tr26)*100:+.1f}% (${sum(t['ret'] for t in tr26)*100000:+,.0f})")
        for t in tr26:
            d = datetime.datetime.utcfromtimestamp(t["entry_ts"]/1000).strftime("%Y-%m-%d")
            print(f"    {d} streak={t['streak']}d ret={t['ret']*100:+.1f}% ({t['reason']})")

    # era-split: split sweep best N into halves chronologically
    if best_N is not None:
        tr, _ = sweep[best_N]
        tr_sorted = sorted(tr, key=lambda t: t["entry_ts"])
        mid_ts = b4[n4 // 2]["time"]
        h1 = [t for t in tr_sorted if t["entry_ts"] < mid_ts]
        h2 = [t for t in tr_sorted if t["entry_ts"] >= mid_ts]
        def half(name, ts):
            if not ts: print(f"  {name}: no trades"); return
            r = sum(t["ret"] for t in ts)
            print(f"  {name}: n={len(ts)} sumRet={r*100:+.1f}% years={sorted(set(t['yr'] for t in ts))}")
        print(f"\n  Era-split at N={best_N} (concern: is it just 2022, or robust?):")
        half("first half", h1); half("second half", h2)

    # ================= TASK 4: funding + correlation + book =================
    print("\n" + "#" * 78)
    print("# TASK 4 — Funding realism + correlation + book impact")
    print("#" * 78)
    N_for_book = best_N if best_N is not None else 60
    tr, m = sweep[N_for_book]
    if m:
        tot_fund = sum(t["fund"] for t in tr)
        avg_fund = tot_fund / len(tr) * 100
        print(f"  Funding at N={N_for_book}: total funding pnl={tot_fund*100:+.1f}% "
              f"({tot_fund*100000:+,.0f}$), avg per trade={avg_fund:+.3f}%  "
              f"(short EARNS when rate>0)")
        # funding-flipped
        trf = run_m2(N_for_book, fund_short_earns=False); mf = metrics(trf)
        print(f"  Funding-FLIPPED (short pays): ROI={mf['total_roi']:+.1f}% vs {m['total_roi']:+.1f}% "
              f"-> funding swing ~{(m['total_roi']-mf['total_roi']):.1f}pp over 7y")

    # correlation with long sleeves: proxy each long sleeve trades in BULL/RANGE; bear-short trades
    # in BEAR. Build a monthly return series for bear-short vs BTC B&H. Negative corr expected.
    def monthly_series(trades):
        mo = defaultdict(float)
        for t in trades:
            dt = datetime.datetime.utcfromtimestamp(t["entry_ts"]/1000)
            mo[(dt.year, dt.month)] += t["ret"]
        return mo
    bs = monthly_series(tr)
    # BTC B&H monthly (proxy for long-sleeve directional exposure)
    bh = defaultdict(float); prev = None
    for b in b1d:
        dt = datetime.datetime.utcfromtimestamp(b["time"]/1000)
        if prev is not None:
            bh[(dt.year, dt.month)] += (b["close"] - prev) / prev
        prev = b["close"]
    keys = sorted(set(bs) | set(bh))
    xs = [bs.get(k, 0) for k in keys]; ys = [bh.get(k, 0) for k in keys]
    def corr(a, c):
        nn = len(a); ma = sum(a)/nn; mc = sum(c)/nn
        cov = sum((a[i]-ma)*(c[i]-mc) for i in range(nn))/nn
        sa = (sum((x-ma)**2 for x in a)/nn)**0.5; sc = (sum((x-mc)**2 for x in c)/nn)**0.5
        return cov/(sa*sc) if sa>0 and sc>0 else 0
    r = corr(xs, ys)
    print(f"\n  Monthly corr(bear-short sleeve, BTC B&H proxy for long sleeves) = {r:+.2f}")
    print(f"  (Negative => makes money when long sleeves suffer = good diversifier.)")
    # months where bear-short active AND B&H negative
    both = [(k, bs[k], bh.get(k,0)) for k in bs if bs[k] != 0]
    on_red = sum(1 for k,v,bv in both if bv < 0)
    print(f"  Active months: {len(both)}; of those B&H was DOWN in {on_red} "
          f"({on_red/max(1,len(both))*100:.0f}%) -> sleeve fires mostly when market falls.")

    # ================= VERDICT =================
    print("\n" + "#" * 78)
    print("# VERDICT")
    print("#" * 78)
    if best_N is None:
        print("  NO chosen N is net-positive AND profitable in BOTH 2022 and 2026.")
        print("  => Strict consecutive-BEAR filter does NOT fix M2. Honest NO.")
    else:
        tr, m = sweep[best_N]
        b22 = m["by_yr"].get(2022,0)*100; b26 = m["by_yr"].get(2026,0)*100
        n22 = sum(1 for t in tr if t["yr"]==2022); n26 = sum(1 for t in tr if t["yr"]==2026)
        print(f"  Chosen N={best_N}: net7y={m['total_roi']:+.1f}% Sharpe={m['sharpe']:+.3f} "
              f"MaxDD={m['mdd']:.0f}% stab={m['pos_yrs']}/{m['n_yrs']} n={m['n']}")
        print(f"  2022={b22:+.0f}%(n{n22})  2026={b26:+.0f}%(n{n26})")
        red = "RED FLAG n<10/yr" if (n22<10 or n26<10) else "n ok"
        print(f"  Overfit check: trades/yr in real bears -> {red}")


if __name__ == "__main__":
    main()
