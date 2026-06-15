#!/usr/bin/env python3
"""
match-accuracy-eval.py
=======================
Measure OUT-OF-SAMPLE accuracy of the btc-market-context analog-match skill.

For each query day Q in history:
  - Build the 14D structure ending at Q.
  - Scan ONLY history strictly BEFORE Q (walk-forward; no lookahead).
    An analog at index i is admissible only if i + horizon < Q (its forward
    outcome was fully realized before Q) -> i.e. the analog + its outcome window
    are entirely in Q's past. This is the honest live condition.
  - Score analogs with a chosen scoring variant, take top-K (dedup >=14d apart).
  - Forecast(h) = median forward-return of the top-K analogs at horizon h.
  - Actual(h) = real forward-return at Q.
  - Compare: directional hit, MAE.

Baselines:
  - base-rate direction: always predict the SIGN of the unconditional median
    forward return computed from data BEFORE Q (walk-forward base rate).
  - MAE baseline: predict the unconditional median forward return (before Q).

A variant is only "real" if it BEATS base-rate direction AND reduces MAE vs the
unconditional baseline, robustly across walk-forward time splits.
"""

import json, sys, math, argparse
from datetime import datetime, timezone

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
WINDOW = 14
HORIZONS = [7, 14, 30]
K_DEFAULT = 15


# ---------- data ----------
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


def pearson(a, b):
    n = len(a)
    if n < 3: return 0.0
    ma = sum(a)/n; mb = sum(b)/n
    num = sum((a[i]-ma)*(b[i]-mb) for i in range(n))
    da = sum((a[i]-ma)**2 for i in range(n))**0.5
    db = sum((b[i]-mb)**2 for i in range(n))**0.5
    if da == 0 or db == 0: return 0.0
    return num/(da*db)


def median(lst):
    lst = sorted(x for x in lst if x is not None)
    if not lst: return None
    n = len(lst)
    if n % 2: return lst[n//2]
    return (lst[n//2-1] + lst[n//2]) / 2


# ---------- precompute per-index features ----------
class Feat:
    """Precomputed features at each daily index (the 'close' day of a 14D window)."""
    def __init__(self, bars):
        self.bars = bars
        closes = [b[4] for b in bars]
        self.closes = closes
        self.ema200 = ema_series(closes, 200)
        self.ema50  = ema_series(closes, 50)
        self.rsi    = rsi_series(bars, 14)
        n = len(bars)
        self.drop = [None]*n; self.pos = [None]*n
        self.returns = [None]*n   # list of 14 daily % returns of the window
        self.atr_drop_ratio = [None]*n
        self.below200 = [None]*n; self.below50 = [None]*n
        for i in range(WINDOW, n):
            w = bars[i-WINDOW:i+1]
            h14 = [b[2] for b in w]; l14 = [b[3] for b in w]
            peak = max(h14); trough = min(l14); close = w[-1][4]
            self.drop[i] = (close-peak)/peak*100
            self.pos[i]  = (close-trough)/(peak-trough)*100 if peak != trough else 50.0
            self.returns[i] = [(w[j][4]-w[j-1][4])/w[j-1][4] for j in range(1, len(w))]
            a = atr_window(w, 14) or 1
            self.atr_drop_ratio[i] = self.drop[i] / (a/close*100)
            e2 = self.ema200[i]; e5 = self.ema50[i]
            self.below200[i] = (close < e2) if e2 else None
            self.below50[i]  = (close < e5) if e5 else None


# ---------- scoring variants ----------
def score_pair(F, q, i, variant):
    """Score history index i as analog of query index q, under `variant`.
    Returns score or None if hard-gate rejects."""
    drop_q = F.drop[q]; pos_q = F.pos[q]
    drop_i = F.drop[i]; pos_i = F.pos[i]
    if None in (drop_q, pos_q, drop_i, pos_i):
        return None

    score = 0.0
    # HARD GATE (shared across variants except 'shape_only')
    if variant != "shape_only":
        if abs(drop_i - drop_q) <= 6:
            score += 1 + max(0, 1 - abs(drop_i - drop_q)/6)
        if abs(pos_i - pos_q) <= 15:
            score += 1
        if score < 1.5:
            return None

    rsi_q = F.rsi[q]; rsi_i = F.rsi[i]
    corr = pearson(F.returns[q], F.returns[i])
    same200 = (F.below200[i] == F.below200[q]) and F.below200[q] is not None
    same50  = (F.below50[i]  == F.below50[q])  and F.below50[q]  is not None
    adr_q = F.atr_drop_ratio[q]; adr_i = F.atr_drop_ratio[i]
    adr_close = adr_q is not None and adr_i is not None and abs(adr_i-adr_q) <= 1.5

    if variant == "current":
        # exact replica of the live skill soft-bonus
        if rsi_q is not None and rsi_i is not None and abs(rsi_i-rsi_q) <= 20: score += 0.5
        if same200: score += 0.5
        if same50:  score += 0.3
        if corr > 0.5: score += 1.0
        elif corr > 0.25: score += 0.5
        if adr_close: score += 0.5

    elif variant == "no_ema50":
        if rsi_q is not None and rsi_i is not None and abs(rsi_i-rsi_q) <= 20: score += 0.5
        if same200: score += 0.5
        if corr > 0.5: score += 1.0
        elif corr > 0.25: score += 0.5
        if adr_close: score += 0.5

    elif variant == "shape_heavy":
        # shape correlation dominates
        if same200: score += 0.5
        score += max(0.0, corr) * 2.0
        if adr_close: score += 0.5

    elif variant == "shape_only":
        # NO hard gate; pure continuous shape distance (Pearson) + magnitude
        score = max(0.0, corr) * 2.0
        if adr_close: score += 0.5

    elif variant == "regime_filtered":
        # current scoring but REJECT analogs on the opposite side of EMA200
        if F.below200[q] is not None and F.below200[i] is not None and F.below200[i] != F.below200[q]:
            return None
        if rsi_q is not None and rsi_i is not None and abs(rsi_i-rsi_q) <= 20: score += 0.5
        if corr > 0.5: score += 1.0
        elif corr > 0.25: score += 0.5
        if adr_close: score += 0.5

    elif variant == "euclid_returns":
        # gate then rank by negative euclidean distance of normalized return vectors
        rq = F.returns[q]; ri = F.returns[i]
        dist = sum((rq[j]-ri[j])**2 for j in range(len(rq)))**0.5
        score += 2.0 / (1 + dist*50)  # closer => higher
        if same200: score += 0.5
    else:
        raise ValueError(variant)

    return score


def forecast_for_query(F, q, variant, K, weighted, horizons):
    """Walk-forward: only analogs whose full outcome window is before q.
    Returns dict horizon -> (forecast, actual) or None."""
    cands = []
    max_h = max(horizons)
    for i in range(WINDOW, q):
        if i + max_h >= q:          # outcome window must end strictly before q
            continue
        s = score_pair(F, q, i, variant)
        if s is None:
            continue
        cands.append((s, i))
    if len(cands) < 5:
        return None
    cands.sort(key=lambda x: -x[0])
    # dedup >=14d apart
    chosen = []
    for s, i in cands:
        if all(abs(i-j) >= 14 for _, j in chosen):
            chosen.append((s, i))
        if len(chosen) >= K:
            break
    if len(chosen) < 5:
        return None

    out = {}
    close_at = lambda idx: F.bars[idx][4]
    for h in horizons:
        fwd = []
        wts = []
        for s, i in chosen:
            c0 = close_at(i); c1 = close_at(i+h)
            fwd.append((c1-c0)/c0*100)
            wts.append(max(s, 0.01))
        if weighted:
            tot = sum(wts)
            # weighted median
            order = sorted(range(len(fwd)), key=lambda k: fwd[k])
            cum = 0; fc = fwd[order[-1]]
            for k in order:
                cum += wts[k]
                if cum >= tot/2:
                    fc = fwd[k]; break
        else:
            fc = median(fwd)
        c0 = close_at(q); c1 = close_at(q+h)
        actual = (c1-c0)/c0*100
        out[h] = (fc, actual)
    return out


def base_rate_before(F, q, h):
    """Unconditional median forward return over all windows strictly before q."""
    vals = []
    for i in range(WINDOW, q):
        if i + h >= q: continue
        c0 = F.bars[i][4]; c1 = F.bars[i+h][4]
        vals.append((c1-c0)/c0*100)
    return median(vals) if vals else None


# ---------- evaluation ----------
def evaluate(F, variant, K, weighted, q_start, q_end, horizons):
    res = {h: {"hit": 0, "n": 0, "abs": 0.0,
               "base_hit": 0, "base_abs": 0.0} for h in horizons}
    queries = list(range(q_start, q_end))
    for q in queries:
        if q + max(horizons) >= len(F.bars):
            continue
        fc = forecast_for_query(F, q, variant, K, weighted, horizons)
        if fc is None:
            continue
        for h in horizons:
            if h not in fc: continue
            f, a = fc[h]
            br = base_rate_before(F, q, h)
            if br is None: continue
            r = res[h]
            r["n"] += 1
            if (f > 0) == (a > 0): r["hit"] += 1
            r["abs"] += abs(f - a)
            if (br > 0) == (a > 0): r["base_hit"] += 1
            r["base_abs"] += abs(br - a)
    return res


def fmt(res, horizons):
    rows = {}
    for h in horizons:
        r = res[h]
        if r["n"] == 0:
            rows[h] = None; continue
        rows[h] = {
            "n": r["n"],
            "hit": r["hit"]/r["n"]*100,
            "base_hit": r["base_hit"]/r["n"]*100,
            "mae": r["abs"]/r["n"],
            "base_mae": r["base_abs"]/r["n"],
        }
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--variants", default="current,no_ema50,shape_heavy,shape_only,regime_filtered,euclid_returns")
    ap.add_argument("--K", type=int, default=K_DEFAULT)
    args = ap.parse_args()

    print("Loading + aggregating 1d...", file=sys.stderr)
    raw = json.load(open(CACHE))
    bars = aggregate_1d(raw)
    print(f"{len(bars)} daily bars  "
          f"{datetime.fromtimestamp(bars[0][0]/1000,tz=timezone.utc).date()} .. "
          f"{datetime.fromtimestamp(bars[-1][0]/1000,tz=timezone.utc).date()}", file=sys.stderr)
    F = Feat(bars)
    n = len(bars)

    # Need enough history before first query. Start queries at index 400
    # (so base-rate + analogs have material). Two walk-forward test windows.
    first_q = 400
    last_q = n - max(HORIZONS) - 1
    mid = (first_q + last_q)//2
    splits = {
        "FULL":  (first_q, last_q),
        "EARLY": (first_q, mid),
        "LATE":  (mid, last_q),
    }

    variants = args.variants.split(",")

    print(f"\n{'='*92}")
    print(f"OOS accuracy  (K={args.K}, walk-forward: analog outcome window ends strictly before query)")
    print(f"{'='*92}")

    for split, (qs, qe) in splits.items():
        print(f"\n### SPLIT {split}  queries [{qs}..{qe}]  "
              f"({datetime.fromtimestamp(bars[qs][0]/1000,tz=timezone.utc).date()} .. "
              f"{datetime.fromtimestamp(bars[qe][0]/1000,tz=timezone.utc).date()})")
        hdr = f"{'variant':<16}{'h':>4}{'n':>6}{'hit%':>8}{'base%':>8}{'edge':>7}{'MAE':>8}{'baseMAE':>9}{'MAEgain':>9}"
        print(hdr)
        print("-"*len(hdr))
        for v in variants:
            for w_label, weighted in [("", False)]:
                res = evaluate(F, v, args.K, weighted, qs, qe, HORIZONS)
                rows = fmt(res, HORIZONS)
                for h in HORIZONS:
                    r = rows[h]
                    if r is None:
                        print(f"{v:<16}{h:>4}{'  no data':>20}")
                        continue
                    edge = r["hit"] - r["base_hit"]
                    maeg = r["base_mae"] - r["mae"]
                    print(f"{v:<16}{h:>4}{r['n']:>6}{r['hit']:>8.1f}{r['base_hit']:>8.1f}"
                          f"{edge:>+7.1f}{r['mae']:>8.2f}{r['base_mae']:>9.2f}{maeg:>+9.2f}")

    # Calibration: does low dispersion among analogs => more accurate? (current variant, FULL)
    print(f"\n{'='*92}")
    print("CALIBRATION (current variant, d14): forecast accuracy vs analog dispersion (IQR of fwd returns)")
    print(f"{'='*92}")
    calib = []
    for q in range(first_q, last_q):
        if q + 14 >= n: continue
        cands = []
        for i in range(WINDOW, q):
            if i + 30 >= q: continue
            s = score_pair(F, q, i, "current")
            if s is None: continue
            cands.append((s, i))
        if len(cands) < 5: continue
        cands.sort(key=lambda x: -x[0])
        chosen = []
        for s, i in cands:
            if all(abs(i-j) >= 14 for _, j in chosen): chosen.append((s, i))
            if len(chosen) >= args.K: break
        if len(chosen) < 5: continue
        fwd = sorted(((F.bars[i+14][4]-F.bars[i][4])/F.bars[i][4]*100) for _, i in chosen)
        m = len(fwd)
        iqr = fwd[int(m*0.75)] - fwd[int(m*0.25)]
        f = median(fwd)
        a = (F.bars[q+14][4]-F.bars[q][4])/F.bars[q][4]*100
        calib.append((iqr, abs(f-a), (f > 0) == (a > 0)))
    calib.sort()
    half = len(calib)//2
    lo = calib[:half]; hi = calib[half:]
    def agg(g):
        return (sum(x[1] for x in g)/len(g), sum(1 for x in g if x[2])/len(g)*100)
    lo_mae, lo_hit = agg(lo); hi_mae, hi_hit = agg(hi)
    print(f"n={len(calib)}")
    print(f"  LOW dispersion  (tight analogs): MAE {lo_mae:.2f}  hit {lo_hit:.1f}%")
    print(f"  HIGH dispersion (spread analogs): MAE {hi_mae:.2f}  hit {hi_hit:.1f}%")

    # Volatility / path accuracy: does analog dispersion predict realized vol?
    print(f"\n{'='*92}")
    print("VOLATILITY forecast: corr( analog fwd-return dispersion , realized 14d abs-move )")
    print(f"{'='*92}")
    disp = []; realvol = []
    for q in range(first_q, last_q):
        if q + 14 >= n: continue
        cands = []
        for i in range(WINDOW, q):
            if i + 30 >= q: continue
            s = score_pair(F, q, i, "current")
            if s is None: continue
            cands.append((s, i))
        if len(cands) < 5: continue
        cands.sort(key=lambda x: -x[0])
        chosen = []
        for s, i in cands:
            if all(abs(i-j) >= 14 for _, j in chosen): chosen.append((s, i))
            if len(chosen) >= args.K: break
        if len(chosen) < 5: continue
        fwd = [abs((F.bars[i+14][4]-F.bars[i][4])/F.bars[i][4]*100) for _, i in chosen]
        disp.append(median(fwd))
        realvol.append(abs((F.bars[q+14][4]-F.bars[q][4])/F.bars[q][4]*100))
    c = pearson(disp, realvol)
    print(f"n={len(disp)}  Pearson(predicted |move| , realized |move|) = {c:.3f}")
    # baseline: unconditional median |move| correlation is ~0 by construction; report mean
    print(f"  mean predicted |move|={sum(disp)/len(disp):.2f}  mean realized |move|={sum(realvol)/len(realvol):.2f}")


if __name__ == "__main__":
    main()
