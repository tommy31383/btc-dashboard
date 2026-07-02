#!/usr/bin/env python3
"""
conditional-confidence-eval.py
==============================
SLICE 2 — CONDITIONAL-CONFIDENCE audit of btc-predict / btc-market-context.

Hypothesis: the forecast is null UNCONDITIONALLY, but maybe a *subset* of
queries where the analogs are "high quality" (tight, well-matched, regime-
aligned, directionally dominant) beats base-rate.

Honest protocol (anti p-hack):
  1. Replicate the LIVE matching: magnitude gate (|drop diff| <=6pp) + ATR-vol
     ratio gate (0.5-2.0x) -> rank by close-% PATH RMSE (window-start anchor),
     exactly like btc_predict.py matching v2. Tie-break EMA200-side + RSI.
  2. Walk-forward, no-lookahead: an analog at index i is admissible for query q
     only if i + max_horizon < q (its full outcome window realised before q).
  3. For each query compute analog-quality features:
        - iqr        : IQR of top-K fwd-h returns (dispersion; tight = low)
        - avg_match_q: mean RMSE-similarity (100*exp(-rmse/8)) of chosen analogs
        - same_regime_n: how many chosen analogs share EMA200 side with query
        - dom_share  : directional dominance among chosen (max(up,down)/dir)
  4. PRE-REGISTER thresholds ON THE EARLY (training) SPLIT ONLY:
        - iqr <= 20th-percentile(EARLY)         (tight analogs)
        - avg_match_q >= 80th-percentile(EARLY) (high match quality)
        - same_regime_n >= 10
        - dom_share >= 0.70                      (directional dominance)
     plus the COMBINED filter (all four).
  5. TEST OOS on the LATE split. For each filter:
        - n (must be >=100 else REJECT as p-hacked / too rare)
        - hit% of filtered subset  vs  base-rate hit% ON THE SAME SUBSET
        - MAE of filtered subset   vs  base-rate MAE ON THE SAME SUBSET
     found_value only if OOS subset (n>=100) beats base-rate DIRECTION *and*
     reduces MAE, robustly.

Default = NULL.  Rare-filter (n<100) = REJECT.
"""

import json, sys, math
from datetime import datetime, timezone

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
WINDOW = 14          # LOOK_BACK, matches live skill
HORIZONS = [7, 14, 30]
K = 15               # MAX_MATCHES, matches live skill
DEDUP = 14
MIN_OOS_N = 100      # hard gate: smaller subset = REJECT (p-hack risk)


# ---------- data / indicators ----------
def aggregate_1d(raw):
    ms = 24 * 3600 * 1000
    bucket = {}
    for b in raw:
        ts = b['time']; key = (ts // ms) * ms
        if key not in bucket:
            bucket[key] = [ts, b['open'], b['high'], b['low'], b['close'], b['volume']]
        else:
            r = bucket[key]
            r[2] = max(r[2], b['high']); r[3] = min(r[3], b['low'])
            r[4] = b['close']; r[5] += b['volume']
    return [bucket[k] for k in sorted(bucket)]


def ema_series(vals, period):
    if len(vals) < period:
        return [None] * len(vals)
    k = 2 / (period + 1)
    out = [None] * (period - 1)
    e = sum(vals[:period]) / period
    out.append(e)
    for v in vals[period:]:
        e = v * k + e * (1 - k)
        out.append(e)
    return out


def rsi_series(bars, period=14):
    closes = [b[4] for b in bars]
    out = [None] * period
    if len(closes) <= period:
        return out
    d = [closes[i] - closes[i-1] for i in range(1, len(closes))]
    ag = sum(max(x, 0) for x in d[:period]) / period
    al = sum(max(-x, 0) for x in d[:period]) / period
    out.append(100 - 100/(1+ag/al) if al else 100.0)
    for x in d[period:]:
        ag = (ag*(period-1) + max(x, 0)) / period
        al = (al*(period-1) + max(-x, 0)) / period
        out.append(100 - 100/(1+ag/al) if al else 100.0)
    return out


def atr_window(window, period=14):
    trs = []
    for i in range(1, len(window)):
        h, l, pc = window[i][2], window[i][3], window[i-1][4]
        trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    if len(trs) < period:
        return None
    return sum(trs[-period:]) / period


def median(lst):
    lst = sorted(x for x in lst if x is not None)
    if not lst:
        return None
    n = len(lst)
    return lst[n//2] if n % 2 else (lst[n//2-1] + lst[n//2]) / 2


def pct(sorted_vals, q):
    if not sorted_vals:
        return None
    i = min(len(sorted_vals)-1, int(q * len(sorted_vals)))
    return sorted_vals[i]


# ---------- precompute features per daily index ----------
class Feat:
    def __init__(self, bars):
        self.bars = bars
        closes = [b[4] for b in bars]
        self.closes = closes
        self.ema200 = ema_series(closes, 200)
        self.rsi = rsi_series(bars, 14)
        n = len(bars)
        self.drop = [None]*n          # drop from 14d peak
        self.path = [None]*n          # close-% path vs window-start (15 pts)
        self.atrpct = [None]*n        # ATR% vs close
        self.below200 = [None]*n
        for i in range(WINDOW, n):
            w = bars[i-WINDOW:i+1]
            h14 = [b[2] for b in w]; close = w[-1][4]
            peak = max(h14)
            self.drop[i] = (close-peak)/peak*100
            c = [b[4] for b in w]
            self.path[i] = [(x/c[0]-1)*100 for x in c]
            a = atr_window(w, 14) or 1
            self.atrpct[i] = a/close*100
            e2 = self.ema200[i]
            self.below200[i] = (close < e2) if e2 else None


def match_analogs(F, q, max_h):
    """Replicate live matching v2. Return list of (score, i, match_q) for chosen
    top-K analogs whose full outcome window ended before q (walk-forward)."""
    drop_q = F.drop[q]; path_q = F.path[q]; atr_q = F.atrpct[q]
    if drop_q is None or atr_q is None or atr_q <= 0:
        return None
    rsi_q = F.rsi[q]; b200_q = F.below200[q]
    cands = []
    for i in range(WINDOW, q):
        if i + max_h >= q:                       # outcome window must finish before q
            continue
        drop_i = F.drop[i]; atr_i = F.atrpct[i]
        if drop_i is None or atr_i is None:
            continue
        if abs(drop_i - drop_q) > 6:             # magnitude gate
            continue
        if not (0.5 <= atr_i/atr_q <= 2.0):      # ATR-vol gate
            continue
        path_i = F.path[i]
        rmse = math.sqrt(sum((a-b)**2 for a, b in zip(path_q, path_i)) / len(path_i))
        match_q = 100 * math.exp(-rmse/8.0)
        score = match_q
        b200_i = F.below200[i]
        if b200_i is not None and b200_q is not None and b200_i == b200_q:
            score += 3
        rsi_i = F.rsi[i]
        if rsi_i is not None and rsi_q is not None and abs(rsi_i-rsi_q) <= 15:
            score += 2
        cands.append((score, i, match_q))
    if len(cands) < 5:
        return None
    cands.sort(key=lambda x: -x[0])
    chosen = []
    for s, i, mq in cands:
        if all(abs(i-j) >= DEDUP for _, j, _ in chosen):
            chosen.append((s, i, mq))
        if len(chosen) >= K:
            break
    if len(chosen) < 5:
        return None
    return chosen


def query_record(F, q):
    """Build a per-query record with forecast + analog-quality features for all
    horizons. None if not enough analogs."""
    max_h = max(HORIZONS)
    chosen = match_analogs(F, q, max_h)
    if chosen is None:
        return None
    b200_q = F.below200[q]
    same_regime_n = sum(1 for _, i, _ in chosen
                        if F.below200[i] is not None and b200_q is not None
                        and F.below200[i] == b200_q)
    avg_match_q = sum(mq for _, _, mq in chosen) / len(chosen)

    rec = {"q": q, "avg_match_q": avg_match_q, "same_regime_n": same_regime_n,
           "h": {}}
    cl = lambda idx: F.bars[idx][4]
    for h in HORIZONS:
        fwd = [(cl(i+h)-cl(i))/cl(i)*100 for _, i, _ in chosen]
        fwd_s = sorted(fwd)
        m = len(fwd_s)
        iqr = pct(fwd_s, 0.75) - pct(fwd_s, 0.25)
        fc = median(fwd)
        up = sum(1 for x in fwd if x > 0)
        down = sum(1 for x in fwd if x < 0)
        directional = up + down
        dom_share = max(up, down)/directional if directional else 0.0
        actual = (cl(q+h)-cl(q))/cl(q)*100
        rec["h"][h] = {"fc": fc, "actual": actual, "iqr": iqr,
                       "dom_share": dom_share}
    return rec


def base_rate_before(F, q, h):
    vals = []
    for i in range(WINDOW, q):
        if i + h >= q:
            continue
        vals.append((F.bars[i+h][4]-F.bars[i][4])/F.bars[i][4]*100)
    return median(vals) if vals else None


def main():
    print("Loading + aggregating 1d...", file=sys.stderr)
    raw = json.load(open(CACHE))
    bars = aggregate_1d(raw)
    F = Feat(bars)
    n = len(bars)
    d0 = datetime.fromtimestamp(bars[0][0]/1000, tz=timezone.utc).date()
    dN = datetime.fromtimestamp(bars[-1][0]/1000, tz=timezone.utc).date()
    print(f"{n} daily bars  {d0} .. {dN}", file=sys.stderr)

    first_q = 400
    last_q = n - max(HORIZONS) - 1
    mid = (first_q + last_q)//2

    print("Building per-query records (this scans 7y for every query)...",
          file=sys.stderr)
    recs = {}
    for q in range(first_q, last_q):
        if q + max(HORIZONS) >= n:
            continue
        r = query_record(F, q)
        if r is not None:
            # attach base rate per horizon
            r["base"] = {h: base_rate_before(F, q, h) for h in HORIZONS}
            recs[q] = r
        if (q - first_q) % 300 == 0:
            print(f"  q={q}/{last_q}", file=sys.stderr)

    early = [r for q, r in recs.items() if q < mid]
    late  = [r for q, r in recs.items() if q >= mid]
    print(f"\nrecords: EARLY={len(early)}  LATE={len(late)}", file=sys.stderr)

    qsd = lambda idx: datetime.fromtimestamp(bars[idx][0]/1000, tz=timezone.utc).date()
    print(f"\n{'='*100}")
    print("SLICE 2 — CONDITIONAL CONFIDENCE  (pre-register thresholds on EARLY, test OOS on LATE)")
    print(f"EARLY queries [{first_q}..{mid}] {qsd(first_q)}..{qsd(mid)}   "
          f"LATE [{mid}..{last_q}] {qsd(mid)}..{qsd(last_q)}")
    print(f"{'='*100}")

    # ---- pre-register thresholds from EARLY for each horizon ----
    thr = {}
    for h in HORIZONS:
        iqrs = sorted(r["h"][h]["iqr"] for r in early)
        mqs  = sorted(r["avg_match_q"] for r in early)
        thr[h] = {
            "iqr_lo20": pct(iqrs, 0.20),       # tight-analog cutoff
            "mq_hi80":  pct(mqs, 0.80),        # high match-quality cutoff
        }
    print("\nPre-registered thresholds (EARLY-derived):")
    for h in HORIZONS:
        print(f"  h={h}: iqr<= {thr[h]['iqr_lo20']:.2f}(20pct)  "
              f"avg_match_q>= {thr[h]['mq_hi80']:.2f}(80pct)  "
              f"same_regime_n>=10  dom_share>=0.70")

    # filter definitions (evaluated per horizon)
    def filt_tight(r, h):  return r["h"][h]["iqr"] <= thr[h]["iqr_lo20"]
    def filt_mq(r, h):     return r["avg_match_q"] >= thr[h]["mq_hi80"]
    def filt_regime(r, h): return r["same_regime_n"] >= 10
    def filt_dom(r, h):    return r["h"][h]["dom_share"] >= 0.70
    def filt_combo(r, h):
        return (filt_tight(r, h) and filt_mq(r, h)
                and filt_regime(r, h) and filt_dom(r, h))

    filters = [
        ("tight20",   filt_tight),
        ("matchQ80",  filt_mq),
        ("sameReg>=10", filt_regime),
        ("dom>=70%",  filt_dom),
        ("COMBO(all)", filt_combo),
        ("ALL(=baseline)", lambda r, h: True),
    ]

    def eval_subset(group, h, keep):
        hit = base_hit = 0; mae = base_mae = 0.0; nn = 0
        for r in group:
            if not keep(r, h):
                continue
            d = r["h"][h]; fc = d["fc"]; a = d["actual"]
            br = r["base"][h]
            if br is None:
                continue
            nn += 1
            if (fc > 0) == (a > 0): hit += 1
            mae += abs(fc - a)
            if (br > 0) == (a > 0): base_hit += 1
            base_mae += abs(br - a)
        if nn == 0:
            return None
        return {"n": nn, "hit": hit/nn*100, "base_hit": base_hit/nn*100,
                "mae": mae/nn, "base_mae": base_mae/nn}

    for split_name, group in [("EARLY(in-sample)", early), ("LATE(OOS)", late)]:
        print(f"\n### {split_name}  (n_records={len(group)})")
        hdr = (f"{'filter':<16}{'h':>4}{'n':>6}{'hit%':>8}{'base%':>8}{'edge':>7}"
               f"{'MAE':>8}{'baseMAE':>9}{'MAEgain':>9}{'verdict':>10}")
        print(hdr); print("-"*len(hdr))
        for fname, keep in filters:
            for h in HORIZONS:
                res = eval_subset(group, h, keep)
                if res is None:
                    print(f"{fname:<16}{h:>4}{'  --- empty ---':>20}")
                    continue
                edge = res["hit"] - res["base_hit"]
                maeg = res["base_mae"] - res["mae"]
                verdict = ""
                if fname not in ("ALL(=baseline)",):
                    if res["n"] < MIN_OOS_N and split_name.startswith("LATE"):
                        verdict = "REJECT-n"
                    elif edge > 0 and maeg > 0:
                        verdict = "candidate"
                    else:
                        verdict = "null"
                print(f"{fname:<16}{h:>4}{res['n']:>6}{res['hit']:>8.1f}"
                      f"{res['base_hit']:>8.1f}{edge:>+7.1f}{res['mae']:>8.2f}"
                      f"{res['base_mae']:>9.2f}{maeg:>+9.2f}{verdict:>10}")

    print(f"\n{'='*100}")
    print("RULE: found_value requires LATE(OOS) subset with n>=%d AND edge>0 AND MAEgain>0." % MIN_OOS_N)
    print(f"{'='*100}")


if __name__ == "__main__":
    main()
