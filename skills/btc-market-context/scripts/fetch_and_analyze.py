#!/usr/bin/env python3
"""
BTC Market Context Analyzer
Fetch live 14D structure + scan 7y history for similar scenarios
Output: /tmp/btc_context_result.json
"""

import json, urllib.request, ssl, os
from datetime import datetime, timezone

_SSL_CTX = ssl.create_default_context()
_SSL_CTX.check_hostname = False
_SSL_CTX.verify_mode = ssl.CERT_NONE

import sys, argparse

# ── Timeframe config ──────────────────────────────────────────────────────────
TF_CONFIG = {
    "1d": {
        "interval":     "1d",
        "hist_hours":   24,
        "live_limit":   60,    # bars for warmup
        "context_bars": 45,    # bars shown in current panel
        "look_back":    14,    # bars before match day
        "look_fwd":     30,    # bars after match day
        "label":        "1D",
        "bar_label":    "ngày",
    },
    "4h": {
        "interval":     "4h",
        "hist_hours":   4,
        "live_limit":   210,   # ~35 days warmup
        "context_bars": 120,   # ~20 days context
        "look_back":    42,    # ~7 days before
        "look_fwd":     90,    # ~15 days after
        "label":        "4H",
        "bar_label":    "4h bar",
    },
    "1h": {
        "interval":     "1h",
        "hist_hours":   1,
        "live_limit":   500,   # ~21 days warmup
        "context_bars": 240,   # ~10 days context
        "look_back":    96,    # ~4 days before
        "look_fwd":     168,   # ~7 days after
        "label":        "1H",
        "bar_label":    "1h bar",
    },
}

def parse_tf():
    p = argparse.ArgumentParser()
    p.add_argument("--tf", default="1d", choices=["1d","4h","1h"])
    p.add_argument("--no-chart", action="store_true")
    args, _ = p.parse_known_args()
    return args.tf, args.no_chart

TF, NO_CHART = parse_tf()
CFG         = TF_CONFIG[TF]

# Portable: env BTC_5M_CACHE override, else ~/BTC_PC/btc-dashboard/.cache (mọi PC giữ layout này)
CACHE_PATH   = os.environ.get("BTC_5M_CACHE") or os.path.expanduser("~/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json")
ALTDATA_PATH = "/var/lib/btc-trader/altdata-BTCUSDT.jsonl"
OUTPUT_PATH  = f"/tmp/btc_context_result_{TF}.json"
CHART_PATH_TF= f"/tmp/btc_context_chart_{TF}.png"
BINANCE_BASE = "https://api.binance.com/api/v3"


# ── helpers ───────────────────────────────────────────────────────────────────

def fetch(url):
    with urllib.request.urlopen(url, timeout=10, context=_SSL_CTX) as r:
        return json.loads(r.read())

def fetch_binance(interval, limit):
    return fetch(f"{BINANCE_BASE}/klines?symbol=BTCUSDT&interval={interval}&limit={limit}")

def ema(values, period):
    if len(values) < period:
        return [None] * len(values)
    k = 2 / (period + 1)
    result = [None] * (period - 1)
    e = sum(values[:period]) / period
    result.append(e)
    for v in values[period:]:
        e = v * k + e * (1 - k)
        result.append(e)
    return result

def rsi(closes, period=14):
    gains, losses = [], []
    for i in range(1, len(closes)):
        d = closes[i] - closes[i-1]
        gains.append(max(d, 0))
        losses.append(max(-d, 0))
    if len(gains) < period:
        return None
    avg_g = sum(gains[:period]) / period
    avg_l = sum(losses[:period]) / period
    for i in range(period, len(gains)):
        avg_g = (avg_g * (period-1) + gains[i]) / period
        avg_l = (avg_l * (period-1) + losses[i]) / period
    if avg_l == 0:
        return 100.0
    return round(100 - 100 / (1 + avg_g / avg_l), 1)

def stoch_rsi(closes, rsi_period=14, stoch_period=14, k_smooth=3, d_smooth=3):
    """StochRSI: K and D lines"""
    # Build RSI series
    rsi_series = []
    for i in range(rsi_period, len(closes) + 1):
        r = rsi(closes[max(0, i-rsi_period-5):i], rsi_period)
        if r is not None:
            rsi_series.append(r)

    if len(rsi_series) < stoch_period:
        return None, None

    # Stoch on RSI
    raw_k = []
    for i in range(stoch_period - 1, len(rsi_series)):
        window = rsi_series[i - stoch_period + 1:i + 1]
        lo, hi = min(window), max(window)
        k = (rsi_series[i] - lo) / (hi - lo) * 100 if hi != lo else 50
        raw_k.append(k)

    # Smooth K
    def smooth(arr, n):
        result = []
        for i in range(n - 1, len(arr)):
            result.append(sum(arr[i-n+1:i+1]) / n)
        return result

    k_line = smooth(raw_k, k_smooth)
    d_line = smooth(k_line, d_smooth)

    if not k_line or not d_line:
        return None, None
    return round(k_line[-1], 1), round(d_line[-1], 1)

def bollinger(closes, period=20, std_mult=2.0):
    """BB %B: position within band. >1=above upper, <0=below lower"""
    if len(closes) < period:
        return None, None
    window = closes[-period:]
    mid = sum(window) / period
    variance = sum((x - mid)**2 for x in window) / period
    std = variance ** 0.5
    upper = mid + std_mult * std
    lower = mid - std_mult * std
    cur = closes[-1]
    pct_b = (cur - lower) / (upper - lower) if upper != lower else 0.5
    return round(pct_b, 3), round(std / mid * 100, 2)  # %B, bandwidth%

def atr(bars, period=14):
    trs = []
    for i in range(1, len(bars)):
        h, l, pc = bars[i][2], bars[i][3], bars[i-1][4]
        trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    if len(trs) < period:
        return None
    return sum(trs[-period:]) / period

def swing_structure(bars):
    swings = []
    for i in range(1, len(bars) - 1):
        h_p, h_c, h_n = bars[i-1][2], bars[i][2], bars[i+1][2]
        l_p, l_c, l_n = bars[i-1][3], bars[i][3], bars[i+1][3]
        dt = datetime.fromtimestamp(bars[i][0]/1000, tz=timezone.utc).strftime('%m-%d')
        if h_c > h_p and h_c > h_n:
            swings.append((dt, 'SWING_HIGH', h_c))
        if l_c < l_p and l_c < l_n:
            swings.append((dt, 'SWING_LOW', l_c))
    return swings

def classify_trend(swings):
    highs = [(d, p) for d, t, p in swings if t == 'SWING_HIGH']
    lows  = [(d, p) for d, t, p in swings if t == 'SWING_LOW']
    hh = len(highs) >= 2 and highs[-1][1] > highs[-2][1]
    lh = len(highs) >= 2 and highs[-1][1] < highs[-2][1]
    hl = len(lows) >= 2 and lows[-1][1] > lows[-2][1]
    ll = len(lows) >= 2 and lows[-1][1] < lows[-2][1]
    if hh and hl: return "UPTREND (HH+HL)"
    elif lh and ll: return "DOWNTREND (LH+LL)"
    elif lh and hl: return "MIXED (LH+HL — ranging)"
    elif hh and ll: return "MIXED (HH+LL — volatile)"
    return "MIXED"

def pearson_corr(a, b):
    """Pearson correlation — căn theo đuôi (recent) nếu lệch độ dài"""
    n = min(len(a), len(b))
    if n < 3:
        return 0
    a = a[-n:]; b = b[-n:]
    ma = sum(a) / n
    mb = sum(b) / n
    num = sum((a[i]-ma)*(b[i]-mb) for i in range(n))
    da  = sum((a[i]-ma)**2 for i in range(n)) ** 0.5
    db  = sum((b[i]-mb)**2 for i in range(n)) ** 0.5
    if da == 0 or db == 0:
        return 0
    return num / (da * db)

def consec_streak(bars):
    if not bars: return 0, 'none'
    color = 'green' if bars[-1][4] >= bars[-1][1] else 'red'
    count = 0
    for b in reversed(bars):
        c = 'green' if b[4] >= b[1] else 'red'
        if c == color: count += 1
        else: break
    return count, color

def aggregate(bars_list, interval_hours):
    """bars_list: list of dicts with keys time/open/high/low/close/volume"""
    ms = interval_hours * 3600 * 1000
    bucket = {}
    for b in bars_list:
        ts = b['time']
        key = (ts // ms) * ms
        if key not in bucket:
            bucket[key] = [ts, b['open'], b['high'], b['low'], b['close'], b['volume']]
        else:
            bucket[key][2] = max(bucket[key][2], b['high'])
            bucket[key][3] = min(bucket[key][3], b['low'])
            bucket[key][4] = b['close']
            bucket[key][5] += b['volume']
    return [bucket[k] for k in sorted(bucket)]

def event_label(yr, mo):
    if yr == 2020 and mo == 3: return "COVID crash"
    if yr == 2021 and mo in [4,5]: return "China ban wave1"
    if yr == 2021 and mo in [6,7]: return "China ban wave2"
    if yr == 2021 and mo == 12: return "Post-ATH correction"
    if yr == 2022 and mo in [1,2]: return "2022 top breakdown"
    if yr == 2022 and mo == 5: return "LUNA collapse"
    if yr == 2022 and mo == 6: return "LUNA bottom/pre-FTX"
    if yr == 2022 and mo == 11: return "FTX collapse"
    if yr == 2022 and mo == 12: return "FTX aftermath"
    if yr == 2023: return "2023 bear recovery"
    if yr == 2024 and mo == 4: return "2024 halving correction"
    if yr == 2024 and mo == 8: return "Japan crash"
    if yr == 2025 and mo in [1,2,3]: return "2025 correction"
    if yr == 2025 and mo in [11,12]: return "Late 2025 correction"
    if yr == 2026: return "2026 bear"
    return ""

def parse_kline(k):
    return [int(k[0]), float(k[1]), float(k[2]), float(k[3]), float(k[4]), float(k[5])]


# ── main ──────────────────────────────────────────────────────────────────────

def main():
    print("Loading 7y cache...")
    with open(CACHE_PATH) as f:
        raw = json.load(f)

    bars_tf_hist = aggregate(raw, CFG["hist_hours"])
    bars_7d_hist = aggregate(raw, 168)

    print(f"Fetching live {CFG['label']} data from Binance...")
    live_tf = [parse_kline(k) for k in fetch_binance(CFG["interval"], CFG["live_limit"])]
    live_4h = [parse_kline(k) for k in fetch_binance('4h', 210)]  # EMA200_4H cho champion
    live_3d = [parse_kline(k) for k in fetch_binance('3d', 20)]
    live_1w = [parse_kline(k) for k in fetch_binance('1w', 20)]
    live_1M = [parse_kline(k) for k in fetch_binance('1M', 6)]

    # alias cho backward compat
    live_1d      = live_tf
    bars_1d_hist = bars_tf_hist

    # ── Current structure (LOOK_BACK bars) ────────────────────────────────────
    bars14 = live_tf[-LOOK_BACK:]
    highs14  = [b[2] for b in bars14]
    lows14   = [b[3] for b in bars14]
    closes14 = [b[4] for b in bars14]

    peak14    = max(highs14)
    trough14  = min(lows14)
    cur_close = closes14[-1]

    drop_from_peak = (cur_close - peak14) / peak14 * 100
    close_vs_low   = (cur_close - trough14) / trough14 * 100
    pos_in_range   = (cur_close - trough14) / (peak14 - trough14) * 100 if peak14 != trough14 else 50

    streak_count, streak_color = consec_streak(bars14)
    swings14  = swing_structure(bars14)
    trend14   = classify_trend(swings14)

    # Indicators — 1D
    closes_1d = [b[4] for b in live_1d]
    ema200_1d_series = ema(closes_1d, min(200, len(closes_1d)))
    ema200_1d = ema200_1d_series[-1]
    ema200_1d_gap = (cur_close - ema200_1d) / ema200_1d * 100 if ema200_1d else None

    rsi_1d = rsi(closes_1d, 14)
    stk_k, stk_d = stoch_rsi(closes_1d)
    pct_b, bw_pct = bollinger(closes_1d, 20, 2.0)
    atr_1d = atr(live_1d[-30:], 14)
    atr_pct = atr_1d / cur_close * 100 if atr_1d else None

    # Shape correlation inputs — % returns trên LOOK_BACK+1 nến (khớp độ dài hist WINDOW)
    ret_bars = live_tf[-(LOOK_BACK + 1):]
    cur_returns14 = [(ret_bars[i][4] - ret_bars[i-1][4]) / ret_bars[i-1][4]
                     for i in range(1, len(ret_bars))]
    # ATR ratio = drop / ATR (volatility-normalized magnitude)
    # Dùng ATR% ngày đúng (atr_pct tính từ live_1d[-30:]), KHÔNG dùng atr(bars14,14)
    # vì 14 bar thiếu 1 → None → fallback sai. atr_pct gán ở dưới nên defer tính ratio.
    atr14_cur = atr(bars14, 14) or 1
    cur_drop_atr_ratio = drop_from_peak / atr_pct if atr_pct else 0

    vols = [b[5] for b in live_1d[-20:]]
    vol_avg20 = sum(vols[:-1]) / (len(vols) - 1)
    vol_ratio = vols[-1] / vol_avg20

    # EMA200_4H
    closes_4h = [b[4] for b in live_4h]
    ema200_4h_series = ema(closes_4h, min(200, len(closes_4h)))
    ema200_4h = ema200_4h_series[-1]
    ema200_4h_gap = (cur_close - ema200_4h) / ema200_4h * 100 if ema200_4h else None

    # Timeframes
    w = live_1w[-1]
    d3 = live_3d[-1]
    mo = live_1M[-1]

    # Funding rate from altdata (last 3 readings)
    funding_recent = []
    try:
        with open(ALTDATA_PATH) as f:
            lines = f.readlines()[-20:]
        for line in reversed(lines):
            entry = json.loads(line.strip())
            if 'fundingRate' in entry:
                funding_recent.append(entry['fundingRate'])
            if len(funding_recent) >= 3:
                break
    except Exception:
        pass

    current = {
        "date": datetime.fromtimestamp(bars14[-1][0]/1000, tz=timezone.utc).strftime('%Y-%m-%d'),
        "close": cur_close,
        "14d_high": peak14,
        "14d_low": trough14,
        "drop_from_peak_pct": round(drop_from_peak, 1),
        "close_vs_low_pct": round(close_vs_low, 1),
        "position_in_range_pct": round(pos_in_range, 1),
        "streak": {"count": streak_count, "color": streak_color},
        "trend_14d": trend14,
        "swings": swings14,
        "indicators": {
            "ema200_1d": round(ema200_1d, 0) if ema200_1d else None,
            "ema200_1d_gap_pct": round(ema200_1d_gap, 1) if ema200_1d_gap else None,
            "ema200_4h": round(ema200_4h, 0) if ema200_4h else None,
            "ema200_4h_gap_pct": round(ema200_4h_gap, 1) if ema200_4h_gap else None,
            "rsi_1d": rsi_1d,
            "stoch_rsi_k": stk_k,
            "stoch_rsi_d": stk_d,
            "bb_pct_b": pct_b,
            "bb_bandwidth_pct": bw_pct,
            "atr_1d_pct": round(atr_pct, 2) if atr_pct else None,
            "volume_ratio_20d": round(vol_ratio, 2),
            "funding_recent": funding_recent[:3],
        },
        "timeframes": {
            "weekly": {"pct": round((w[4]-w[1])/w[1]*100, 2),
                       "color": "🟢" if w[4]>=w[1] else "🔴",
                       "open": w[1], "high": w[2], "low": w[3], "close": w[4]},
            "3d":     {"pct": round((d3[4]-d3[1])/d3[1]*100, 2),
                       "color": "🟢" if d3[4]>=d3[1] else "🔴",
                       "open": d3[1], "high": d3[2], "low": d3[3], "close": d3[4]},
            "monthly":{"pct": round((mo[4]-mo[1])/mo[1]*100, 2),
                       "color": "🟢" if mo[4]>=mo[1] else "🔴",
                       "open": mo[1], "high": mo[2], "low": mo[3], "close": mo[4]},
        }
    }

    # EMA50 current (for trend direction scoring)
    ema50_1d_series = ema(closes_1d, min(50, len(closes_1d)))
    ema50_1d_cur    = ema50_1d_series[-1]
    cur_below_ema200 = cur_close < ema200_1d if ema200_1d else None
    cur_below_ema50  = cur_close < ema50_1d_cur if ema50_1d_cur else None

    # ── Scan 7y history ────────────────────────────────────────────────────────
    print("Scanning 7y history — precomputing indicator series...")

    # Precompute full RSI series for fast lookup (streaming, O(n))
    def _build_rsi_series(bars, period=14):
        closes = [b[4] for b in bars]
        out = [None] * period
        if len(closes) <= period:
            return out
        deltas = [closes[i] - closes[i-1] for i in range(1, len(closes))]
        ag = sum(max(d,0) for d in deltas[:period]) / period
        al = sum(max(-d,0) for d in deltas[:period]) / period
        out.append(round(100 - 100/(1+ag/al), 1) if al else 100.0)
        for d in deltas[period:]:
            ag = (ag*(period-1) + max(d,0)) / period
            al = (al*(period-1) + max(-d,0)) / period
            out.append(round(100 - 100/(1+ag/al), 1) if al else 100.0)
        return out

    rsi_hist_series  = _build_rsi_series(bars_1d_hist, 14)
    ema200_hist_all  = ema([b[4] for b in bars_1d_hist], 200)
    ema50_hist_all   = ema([b[4] for b in bars_1d_hist], 50)

    def rsi_at(idx, period=14):
        c = [b[4] for b in bars_1d_hist[max(0, idx-period-10):idx+1]]
        return rsi(c, period)

    def stk_at(idx):
        c = [b[4] for b in bars_1d_hist[max(0, idx-60):idx+1]]
        k, d = stoch_rsi(c)
        return k, d

    def atr_at(idx, period=14):
        return atr(bars_1d_hist[max(0, idx-period-2):idx+1], period)

    def bb_at(idx):
        c = [b[4] for b in bars_1d_hist[max(0, idx-25):idx+1]]
        return bollinger(c)

    # WINDOW phải khớp LOOK_BACK (số nến cửa sổ hiện tại) — nếu để cứng 14 thì 4h/1h
    # (LOOK_BACK 42/96) lệch độ dài vector returns → Pearson crash. Window có WINDOW+1
    # nến để ATR14 đủ dữ liệu; hist_returns dài WINDOW = khớp cur_returns14.
    WINDOW = LOOK_BACK
    matches = []

    for i in range(WINDOW, len(bars_1d_hist) - 32):
        window = bars_1d_hist[i-WINDOW:i+1]  # WINDOW+1 nến (đủ cho ATR14)
        h14 = [b[2] for b in window]
        l14 = [b[3] for b in window]
        c14 = [b[4] for b in window]

        peak   = max(h14)
        trough = min(l14)
        close  = c14[-1]

        drop   = (close - peak) / peak * 100
        vs_low = (close - trough) / trough * 100
        pos    = (close - trough) / (peak - trough) * 100 if peak != trough else 50

        st_cnt, st_col = consec_streak(window)

        # ── Similarity scoring — MAGNITUDE-ANCHORED + SHAPE ────────────────
        # (2026-06-10 rev2: shape_only thuần Pearson SAI cho context — vô tỷ-lệ
        #  nên kéo nến drop −1% so với crash −18%, biên độ lệch hẳn. Phải neo
        #  ĐỘ SÂU DROP + ATR-volatility để analog GIỐNG THẬT về biên độ, shape
        #  chỉ rank tinh. Accuracy DỰ BÁO vẫn null base-rate → disclaimer giữ.)
        atr14_h     = atr(window, 14) or 1
        atr_pct_h_v = atr14_h / close * 100  # volatility của window lịch sử
        cur_atr_pct = atr_pct or 0           # ATR% ngày hiện tại (đã tính đúng ở trên)

        # GATE độ sâu drop — bắt buộc biên độ giảm tương đương (±8%)
        if abs(drop - drop_from_peak) > 8:
            continue
        # GATE biên độ volatility ATR% tương đương (±50% tỷ lệ) — "độ biến thiên" khớp
        if cur_atr_pct > 0 and not (0.5 <= atr_pct_h_v / cur_atr_pct <= 2.0):
            continue

        score = 0.0
        # Drop magnitude khớp (càng sát càng cao, max ~2pt)
        score += 2.0 * max(0.0, 1 - abs(drop - drop_from_peak) / 8)
        # Position-in-range khớp (±20%)
        if abs(pos - pos_in_range) <= 20:
            score += 1.0 * max(0.0, 1 - abs(pos - pos_in_range) / 20)
        # ATR-volatility khớp (tỷ lệ gần 1)
        score += 1.0 * max(0.0, 1 - abs(atr_pct_h_v / cur_atr_pct - 1)) if cur_atr_pct > 0 else 0

        # Shape correlation (Pearson 14D % returns) — rank tinh giữa các analog cùng biên độ
        hist_returns = [(window[j][4] - window[j-1][4]) / window[j-1][4]
                        for j in range(1, len(window))]
        corr = pearson_corr(cur_returns14, hist_returns)
        if corr > 0.5:
            score += 1.5
        elif corr > 0.25:
            score += 0.75
        elif corr > 0:
            score += 0.3

        # ATR-normalized drop ratio (shape của cú giảm so với vol)
        hist_drop_atr_ratio = drop / atr_pct_h_v if atr_pct_h_v else 0
        if abs(hist_drop_atr_ratio - cur_drop_atr_ratio) <= 1.5:
            score += 0.5

        # ── Tương đồng tín hiệu oscillator (rank tinh sau khi biên độ đã khớp) ──
        # RSI gần nhau (tối đa +1.0 khi |Δ|≤25) — cùng vùng quá-mua/quá-bán
        rsi_h_pre = rsi_hist_series[i] if i < len(rsi_hist_series) else None
        if rsi_h_pre is not None and rsi_1d is not None:
            score += 1.0 * max(0.0, 1 - abs(rsi_h_pre - rsi_1d) / 25)
        # StochRSI K gần nhau (tối đa +0.75 khi |Δ|≤30) — tính 1 lần, tái dùng ở dưới
        stk_k_h, stk_d_h = stk_at(i)
        if stk_k_h is not None and stk_k is not None:
            score += 0.75 * max(0.0, 1 - abs(stk_k_h - stk_k) / 30)

        def pct_after(days):
            t = i + days
            if t < len(bars_1d_hist):
                return round((bars_1d_hist[t][4] - close) / close * 100, 1)
            return None

        ema200_h = ema([b[4] for b in bars_1d_hist[max(0,i-200):i+1]], min(200, i+1))[-1]
        above_ema200 = close > ema200_h if ema200_h else None

        rsi_h   = rsi_at(i)
        # stk_k_h, stk_d_h đã tính ở phần scoring (tránh tính lại)
        bb_pb_h, bb_bw_h = bb_at(i)
        atr_h   = atr_at(i)
        atr_pct_h = round(atr_h / close * 100, 2) if atr_h else None

        next_bar = bars_1d_hist[i+1]
        bounce = next_bar[4] > next_bar[1]

        ts = bars_1d_hist[i][0]
        dt = datetime.fromtimestamp(ts/1000, tz=timezone.utc)

        # Weekly pct from hist
        w7 = [b for b in bars_7d_hist if b[0] <= ts]
        w7_pct = round((w7[-1][4]-w7[-1][1])/w7[-1][1]*100, 1) if w7 else None

        matches.append({
            "date": dt.strftime('%Y-%m-%d'),
            "year": dt.year,
            "hist_index": i,
            "event": event_label(dt.year, dt.month),
            "drop_from_peak_pct": round(drop, 1),
            "close_vs_low_pct": round(vs_low, 1),
            "position_in_range_pct": round(pos, 1),
            "streak": {"count": st_cnt, "color": st_col},
            "trend_14d": classify_trend(swing_structure(window)),
            "similarity_score": round(score, 2),
            "above_ema200": above_ema200,
            "rsi": rsi_h,
            "stoch_rsi_k": stk_k_h,
            "stoch_rsi_d": stk_d_h,
            "bb_pct_b": bb_pb_h,
            "atr_pct": atr_pct_h,
            "weekly_pct": w7_pct,
            "next_bar_bounce": bounce,
            "outcomes": {
                "d1":  pct_after(1),
                "d3":  pct_after(3),
                "d7":  pct_after(7),
                "d14": pct_after(14),
                "d30": pct_after(30),
            }
        })

    matches.sort(key=lambda x: -x['similarity_score'])

    # Deduplicate: giữ 1 match per episode (cách nhau >= 14 ngày)
    deduped = []
    for m in matches:
        too_close = any(
            abs(m['hist_index'] - prev['hist_index']) < 14
            for prev in deduped
        )
        if not too_close:
            deduped.append(m)
        if len(deduped) >= 15:
            break

    # Sắp xếp theo độ giống nhất (similarity cao → thấp) lên đầu
    top = sorted(deduped, key=lambda x: -x['similarity_score'])

    def stats(lst):
        lst = [x for x in lst if x is not None]
        if not lst: return {}
        lst.sort()
        n = len(lst)
        return {
            "median": round(lst[n//2], 1),
            "q25": round(lst[n//4], 1),
            "q75": round(lst[(3*n)//4 if n > 1 else 0], 1),
            "min": round(min(lst), 1),
            "max": round(max(lst), 1),
            "win_rate": f"{sum(1 for x in lst if x>0)}/{n}",
            "n": n,
        }

    # ── ② Regime-conditioned: tách analog cùng/khác regime EMA200 với hiện tại ──
    def regime_outcomes(group):
        return {k: stats([m['outcomes'][k] for m in group]) for k in ['d1','d3','d7','d14','d30']}

    if cur_below_ema200 is None:
        same_regime, diff_regime = top, []
        cur_reg_label = "N/A"
    else:
        cur_reg_label = "DƯỚI EMA200 (bear-ish)" if cur_below_ema200 else "TRÊN EMA200 (bull-ish)"
        # same regime: analog cùng phía EMA200 với hiện tại (above_ema200 == cur_above)
        same_regime = [m for m in top if m['above_ema200'] is not None
                       and m['above_ema200'] == (not cur_below_ema200)]
        diff_regime = [m for m in top if m['above_ema200'] is not None
                       and m['above_ema200'] == cur_below_ema200]

    # ── ③ Conviction từ dispersion + đồng thuận hướng (đo độ BẤT ĐỊNH) ──
    def conviction_for(group):
        vals = sorted([m['outcomes']['d30'] for m in group if m['outcomes']['d30'] is not None])
        n = len(vals)
        if n < 4:
            return {"level": "N/A", "note": "ít mẫu cùng regime"}
        q25 = vals[n//4]; q75 = vals[(3*n)//4]; iqr = q75 - q25
        wins = sum(1 for x in vals if x > 0); wr = wins / n
        dir_agree = abs(wr - 0.5) * 2  # 0=coin-flip, 1=đồng thuận hoàn toàn
        if iqr < 12 and dir_agree > 0.4:
            level = "CAO"
        elif iqr > 28 or dir_agree < 0.2:
            level = "THẤP"
        else:
            level = "TRUNG BÌNH"
        bias = "tăng" if wr > 0.5 else "giảm"
        band_desc = "hẹp" if iqr < 12 else "rộng" if iqr > 28 else "vừa"
        dir_desc = ("đồng thuận mạnh" if dir_agree > 0.4
                    else "chia rẽ 50/50" if dir_agree < 0.2 else "hơi nghiêng")
        return {
            "level": level, "iqr_d30": round(iqr, 1),
            "band_d30": f"[{round(q25,1):+} … {round(q75,1):+}]%",
            "win_rate": f"{wins}/{n}", "dir_bias": bias,
            "note": (f"Band d30 {band_desc} ({round(iqr,1)}%), hướng {dir_desc} "
                     f"(win {wins}/{n}) → bất định {level}. " +
                     ("Analog đồng thuận → context đáng tin hơn." if level=="CAO"
                      else "Hướng coin-flip → size nhỏ/chờ tín hiệu rõ." if level=="THẤP"
                      else "Tín hiệu hỗn hợp.")),
        }
    primary = same_regime if len(same_regime) >= 6 else top

    result = {
        "generated_at": datetime.now(tz=timezone.utc).strftime('%Y-%m-%d %H:%M UTC'),
        "current": current,
        "matches": top,
        "stats": {
            "total_matches": len(matches),
            "bounce_next_bar": f"{sum(1 for m in top if m['next_bar_bounce'])}/{len(top)}",
            "outcomes": {k: stats([m['outcomes'][k] for m in top]) for k in ['d1','d3','d7','d14','d30']},
            "current_regime": cur_reg_label,
            "regime_same": {"n": len(same_regime), "outcomes": regime_outcomes(same_regime)} if same_regime else {"n": 0},
            "regime_diff": {"n": len(diff_regime), "outcomes": regime_outcomes(diff_regime)} if diff_regime else {"n": 0},
            "conviction": conviction_for(primary),
            "disclaimer": ("⚠️ Median outcome d1..d30 của analog KHÔNG beat base-rate "
                           "(backtest OOS: hit ~50% ≈ tung đồng xu, MAE cao hơn 'đoán theo trend "
                           "lịch sử'). Đây là CONTEXT lịch sử qualitative — KHÔNG phải tín hiệu vào "
                           "lệnh. Crypto không có alpha định-thời từ structural-match."),
        }
    }

    # Attach hist bars ref to result for charting
    result['_bars_1d_hist'] = bars_1d_hist
    result['_live_1d'] = live_1d

    with open(OUTPUT_PATH, 'w') as f:
        # Don't serialize internal bars (too large), save separately
        export = {k: v for k, v in result.items() if not k.startswith('_')}
        json.dump(export, f, indent=2)

    print(f"Done → {OUTPUT_PATH}")
    return result


CHART_PATH   = CHART_PATH_TF
LOOK_BACK    = CFG["look_back"]
LOOK_FWD     = CFG["look_fwd"]
CUR_CONTEXT  = CFG["context_bars"]

BG   = '#0f0f1a'
PANEL= '#1a1a2e'
GREEN= '#26a69a'
RED  = '#ef5350'
GRAY = '#555577'
GOLD = '#FFD700'

def draw_candles(ax, bars, x_offset=0, alpha=1.0, col_up=GREEN, col_dn=RED, width=0.6):
    """Draw candlestick bars on ax. bars = list of [ts,o,h,l,c,v]"""
    import matplotlib.patches as mpatches
    for i, b in enumerate(bars):
        o, h, l, c = b[1], b[2], b[3], b[4]
        x = x_offset + i
        color = col_up if c >= o else col_dn
        # Wick
        ax.plot([x, x], [l, h], color=color, linewidth=0.8, alpha=alpha, zorder=2)
        # Body
        body_lo = min(o, c)
        body_hi = max(o, c)
        rect = mpatches.FancyBboxPatch(
            (x - width/2, body_lo), width, max(body_hi - body_lo, (h-l)*0.01),
            boxstyle="square,pad=0", linewidth=0,
            facecolor=color, alpha=alpha, zorder=3
        )
        ax.add_patch(rect)

def style_ax(ax):
    ax.set_facecolor(PANEL)
    ax.tick_params(colors='#888899', labelsize=7)
    for sp in ['top','right']: ax.spines[sp].set_visible(False)
    for sp in ['bottom','left']: ax.spines[sp].set_color(GRAY)
    ax.grid(axis='y', alpha=0.12, color=GRAY)


def calc_rsi_series(bars, period=14):
    closes = [b[4] for b in bars]
    result = [None] * period
    if len(closes) <= period:
        return result
    gains = [max(closes[i]-closes[i-1], 0) for i in range(1, len(closes))]
    losses = [max(closes[i-1]-closes[i], 0) for i in range(1, len(closes))]
    avg_g = sum(gains[:period]) / period
    avg_l = sum(losses[:period]) / period
    rs = avg_g / avg_l if avg_l else 100
    result.append(100 - 100/(1+rs))
    for i in range(period, len(gains)):
        avg_g = (avg_g*(period-1) + gains[i]) / period
        avg_l = (avg_l*(period-1) + losses[i]) / period
        rs = avg_g / avg_l if avg_l else 100
        result.append(100 - 100/(1+rs))
    return result

def calc_stochrsi_series(bars, rsi_p=14, stoch_p=14, k_s=3, d_s=3):
    rsi_vals = calc_rsi_series(bars, rsi_p)
    valid = [v for v in rsi_vals if v is not None]
    if len(valid) < stoch_p:
        return [None]*len(bars), [None]*len(bars)
    raw_k = []
    for i in range(stoch_p-1, len(valid)):
        w = valid[i-stoch_p+1:i+1]
        lo, hi = min(w), max(w)
        raw_k.append((valid[i]-lo)/(hi-lo)*100 if hi!=lo else 50)
    def smooth(arr, n):
        out = []
        for i in range(n-1, len(arr)):
            out.append(sum(arr[i-n+1:i+1])/n)
        return out
    k_line = smooth(raw_k, k_s)
    d_line = smooth(k_line, d_s)
    pad_k = [None]*(len(bars)-len(k_line))
    pad_d = [None]*(len(bars)-len(d_line))
    return pad_k + k_line, pad_d + d_line

def draw_panel(fig, gs_spec, bars, match_day, title, title_color,
               outcome_str=None, rsi_vals=None, stk_k=None, stk_d=None, show_dates=False):
    """Draw candles+RSI+StochRSI+Volume in a 4-row stacked panel."""
    inner = __import__('matplotlib.gridspec', fromlist=['GridSpecFromSubplotSpec']).GridSpecFromSubplotSpec(
        4, 1, subplot_spec=gs_spec,
        height_ratios=[4, 2, 2, 1], hspace=0.06
    )
    import matplotlib.pyplot as plt

    ax_c  = fig.add_subplot(inner[0])   # candles
    ax_r  = fig.add_subplot(inner[1], sharex=ax_c)  # RSI
    ax_s  = fig.add_subplot(inner[2], sharex=ax_c)  # StochRSI
    ax_v  = fig.add_subplot(inner[3], sharex=ax_c)  # volume

    n = len(bars)
    xs = list(range(n))

    # Candles
    past   = bars[:match_day+1]
    future = bars[match_day+1:]
    draw_candles(ax_c, past,   x_offset=0,           alpha=0.6)
    draw_candles(ax_c, future, x_offset=match_day+1, alpha=0.95)
    ax_c.axvline(match_day, color=GOLD, linewidth=1.0, linestyle=':', alpha=0.7)
    if outcome_str:
        col_txt = GREEN if outcome_str.startswith('+') else RED
        ax_c.annotate(outcome_str, xy=(0.98, 0.05), xycoords='axes fraction',
                      ha='right', va='bottom', color=col_txt,
                      fontsize=7, fontweight='bold')
    ax_c.set_title(title, color=title_color, fontsize=7.5, pad=3, loc='left')
    style_ax(ax_c)
    ax_c.yaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f'${v/1e3:.1f}k'))
    ax_c.yaxis.set_tick_params(labelsize=6)
    plt.setp(ax_c.get_xticklabels(), visible=False)

    # RSI
    if rsi_vals:
        ax_r.plot(xs, rsi_vals, color='#ce93d8', linewidth=0.9)
        ax_r.axhline(30, color=RED,  linewidth=0.5, linestyle='--', alpha=0.6)
        ax_r.axhline(70, color=GREEN,linewidth=0.5, linestyle='--', alpha=0.6)
        ax_r.axvline(match_day, color=GOLD, linewidth=0.8, linestyle=':', alpha=0.5)
        # fill oversold
        rsi_clean = [v if v is not None else float('nan') for v in rsi_vals]
        ax_r.fill_between(xs, rsi_clean, 30, where=[v is not None and v<30 for v in rsi_vals],
                          color=RED, alpha=0.2)
    ax_r.set_ylim(0, 100)
    ax_r.set_yticks([30, 70])
    ax_r.yaxis.set_tick_params(labelsize=5)
    ax_r.text(0.01, 0.75, 'RSI', transform=ax_r.transAxes,
              color='#ce93d8', fontsize=5.5)
    style_ax(ax_r)
    plt.setp(ax_r.get_xticklabels(), visible=False)

    # StochRSI
    if stk_k:
        k_clean = [v if v is not None else float('nan') for v in stk_k]
        d_clean = [v if v is not None else float('nan') for v in stk_d]
        ax_s.plot(xs, k_clean, color='#64b5f6', linewidth=0.9, label='K')
        ax_s.plot(xs, d_clean, color='#ff8a65', linewidth=0.9, label='D')
        ax_s.axhline(20, color=RED,  linewidth=0.5, linestyle='--', alpha=0.5)
        ax_s.axhline(80, color=GREEN,linewidth=0.5, linestyle='--', alpha=0.5)
        ax_s.axvline(match_day, color=GOLD, linewidth=0.8, linestyle=':', alpha=0.5)
        ax_s.fill_between(xs, k_clean, 20, where=[v is not None and v<20 for v in stk_k],
                          color='#64b5f6', alpha=0.15)
    ax_s.set_ylim(0, 100)
    ax_s.set_yticks([20, 80])
    ax_s.yaxis.set_tick_params(labelsize=5)
    ax_s.text(0.01, 0.6, 'StochRSI', transform=ax_s.transAxes,
              color='#64b5f6', fontsize=5.5)
    style_ax(ax_s)
    plt.setp(ax_s.get_xticklabels(), visible=False)

    # Volume
    vcols = [GREEN if b[4] >= b[1] else RED for b in bars]
    vols  = [b[5] for b in bars]
    avg_v = sum(vols) / len(vols)
    ax_v.bar(xs, vols, color=vcols, alpha=0.6, width=0.8)
    ax_v.axhline(avg_v, color=GOLD, linewidth=0.5, linestyle='--', alpha=0.4)
    ax_v.axvline(match_day, color=GOLD, linewidth=0.8, linestyle=':', alpha=0.5)
    style_ax(ax_v)
    ax_v.set_yticks([])
    if show_dates:
        step = max(1, n // 6)
        ticks = list(range(0, n, step))
        labels = [
            __import__('datetime').datetime.fromtimestamp(
                bars[t][0]/1000, tz=__import__('datetime').timezone.utc
            ).strftime('%m-%d') for t in ticks
        ]
        ax_v.set_xticks(ticks)
        ax_v.set_xticklabels(labels, color='#777788', fontsize=5.5, rotation=30)
    else:
        plt.setp(ax_v.get_xticklabels(), visible=False)

    return ax_c, ax_r, ax_s, ax_v


def draw_chart(result):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    import matplotlib.gridspec as gridspec

    bars_hist = result['_bars_1d_hist']
    live_1d   = result['_live_1d']
    top       = result['matches']
    cur       = result['current']
    ind       = cur['indicators']

    valid = []
    for m in top:
        i = m['hist_index']
        if i - LOOK_BACK >= 0 and i + LOOK_FWD + 1 <= len(bars_hist):
            valid.append((m, bars_hist[i-LOOK_BACK : i+LOOK_FWD+1], i))

    n_hist = len(valid)
    n_cols = 3
    n_grid_rows = (n_hist + n_cols - 1) // n_cols

    # Figure: taller per row to fit 4 sub-panels
    cur_h    = 8.5        # height (inches) của panel hiện tại
    grid_h   = n_grid_rows * 5.5
    fig_h    = cur_h + grid_h + 0.6   # 0.6 cho suptitle
    fig = plt.figure(figsize=(n_cols * 6, fig_h), facecolor=BG, layout='constrained')
    fig.suptitle(
        f"BTC  Kịch bản tương tự ({cur['date']})   "
        f"Drop {cur['drop_from_peak_pct']:+.1f}%   RSI={ind['rsi_1d']}   "
        f"StochK={ind['stoch_rsi_k']}   BB%B={ind['bb_pct_b']}   "
        f"Streak={cur['streak']['count']}🔴   EMA200_4H gap {ind['ema200_4h_gap_pct']:+.1f}%",
        color='white', fontsize=11, y=1.0
    )

    outer = gridspec.GridSpec(2, 1, figure=fig,
                              height_ratios=[cur_h, grid_h],
                              hspace=0.06)

    # ── TOP: Current ──────────────────────────────────────────────────────
    # Dùng full live_1d (60 bars) để warmup RSI/StochRSI, chỉ hiển thị CUR_CONTEXT ngày cuối
    rsi_full_cur      = calc_rsi_series(live_1d)
    stk_k_full_cur, stk_d_full_cur = calc_stochrsi_series(live_1d)

    # Trim về CUR_CONTEXT ngày cuối để hiển thị
    cur_bars      = live_1d[-CUR_CONTEXT:]
    rsi_cur       = rsi_full_cur[-CUR_CONTEXT:]
    stk_k_cur     = stk_k_full_cur[-CUR_CONTEXT:]
    stk_d_cur     = stk_d_full_cur[-CUR_CONTEXT:]
    # match_day = ngày cuối cùng trong display (= "hôm nay")
    cur_match_day = CUR_CONTEXT - 1

    draw_panel(
        fig, outer[0],
        bars=cur_bars,
        match_day=cur_match_day,
        title=f"HIỆN TẠI — {cur['date']}  BTC ${cur['close']:,.0f}  "
              f"EMA200_4H ${ind['ema200_4h']:,.0f} (gap {ind['ema200_4h_gap_pct']:+.1f}%)",
        title_color=GOLD,
        rsi_vals=rsi_cur,
        stk_k=stk_k_cur,
        stk_d=stk_d_cur,
        show_dates=True,
    )

    # ── GRID: Historical matches ──────────────────────────────────────────
    bot_gs = gridspec.GridSpecFromSubplotSpec(
        n_grid_rows, n_cols,
        subplot_spec=outer[1],
        hspace=0.55, wspace=0.28
    )

    for idx, (m, segment, hist_i) in enumerate(valid):
        row, col = divmod(idx, n_cols)

        # Compute RSI + StochRSI for this segment
        # Need extra lookback from hist for warm-up
        warmup_start = max(0, hist_i - LOOK_BACK - 30)
        full_seg = bars_hist[warmup_start : hist_i + LOOK_FWD + 1]
        rsi_full  = calc_rsi_series(full_seg)
        stk_k_full, stk_d_full = calc_stochrsi_series(full_seg)

        # Trim to display window
        trim = (hist_i - LOOK_BACK) - warmup_start
        rsi_seg  = rsi_full[trim:]
        stk_k_seg = stk_k_full[trim:]
        stk_d_seg = stk_d_full[trim:]

        o30 = m['outcomes']['d30']
        out_str = f"+30d {o30:+.1f}%" if o30 is not None else ""

        event_str = m['event'] or '—'
        title = (f"#{idx+1}  {m['date']}  {event_str}  (sim {m['similarity_score']:.2f})\n"
                 f"Drop {m['drop_from_peak_pct']:+.1f}%  RSI={m['rsi']} StochK={m['stoch_rsi_k']} BB%B={m['bb_pct_b']}")

        draw_panel(
            fig, bot_gs[row, col],
            bars=segment,
            match_day=LOOK_BACK,
            title=title,
            title_color='#ccccee',
            outcome_str=out_str,
            rsi_vals=rsi_seg,
            stk_k=stk_k_seg,
            stk_d=stk_d_seg,
            show_dates=(row == n_grid_rows - 1),
        )

    plt.savefig(CHART_PATH, dpi=130, bbox_inches='tight', facecolor=BG)
    plt.close()
    print(f"Chart saved → {CHART_PATH}")


if __name__ == '__main__':
    r = main()
    cur = r['current']
    ind = cur['indicators']

    print(f"\n{'='*62}")
    print(f"CURRENT ({cur['date']})  BTC ${cur['close']:,.0f}")
    print(f"{'='*62}")
    print(f"  14D High ${cur['14d_high']:,.0f}  Drop {cur['drop_from_peak_pct']:+.1f}%")
    print(f"  14D Low  ${cur['14d_low']:,.0f}   vs Low +{cur['close_vs_low_pct']:.1f}%")
    print(f"  Trend:   {cur['trend_14d']}")
    print(f"  Streak:  {cur['streak']['count']} nến {cur['streak']['color']}")
    print(f"")
    print(f"  EMA200_1D ${ind['ema200_1d']:,.0f}  gap {ind['ema200_1d_gap_pct']:+.1f}%")
    print(f"  EMA200_4H ${ind['ema200_4h']:,.0f}  gap {ind['ema200_4h_gap_pct']:+.1f}%  ← champion unlock")
    print(f"  RSI_1D:   {ind['rsi_1d']}   StochRSI K={ind['stoch_rsi_k']} D={ind['stoch_rsi_d']}")
    print(f"  BB %B:    {ind['bb_pct_b']}  BW={ind['bb_bandwidth_pct']}%")
    print(f"  ATR%:     {ind['atr_1d_pct']}%   Volume {ind['volume_ratio_20d']}x vs 20D avg")
    if ind['funding_recent']:
        print(f"  Funding:  {ind['funding_recent']} (recent 3)")
    print(f"")
    print(f"  Weekly {cur['timeframes']['weekly']['color']} {cur['timeframes']['weekly']['pct']:+.1f}%")
    print(f"  3D     {cur['timeframes']['3d']['color']} {cur['timeframes']['3d']['pct']:+.1f}%")
    print(f"  Monthly{cur['timeframes']['monthly']['color']} {cur['timeframes']['monthly']['pct']:+.1f}%")

    print(f"\nTOP MATCHES  (total={r['stats']['total_matches']})")
    print(f"{'─'*62}")
    print(f"{'#':>2} {'Date':<12} {'Event':<18} {'Sim':>5} {'Drop':>6} {'RSI':>5} {'StkK':>5} {'BB%B':>5} {'Bnc':>3}  +1d   +3d   +7d  +14d  +30d")
    print(f"{'─'*62}")
    for _rank, m in enumerate(r['matches'], 1):
        o = m['outcomes']
        bb = f"{m['bb_pct_b']:.2f}" if m['bb_pct_b'] is not None else "  — "
        sk = f"{m['stoch_rsi_k']:.0f}" if m['stoch_rsi_k'] is not None else "  —"
        bnc = "✓" if m['next_bar_bounce'] else "✗"
        d1  = f"{o['d1']:+.1f}%" if o['d1'] is not None else "  — "
        d3  = f"{o['d3']:+.1f}%" if o['d3'] is not None else "  — "
        d7  = f"{o['d7']:+.1f}%" if o['d7'] is not None else "  — "
        d14 = f"{o['d14']:+.1f}%" if o['d14'] is not None else "  — "
        d30 = f"{o['d30']:+.1f}%" if o['d30'] is not None else "  — "
        print(f"{_rank:>2} {m['date']:<12} {m['event'][:18]:<18} {m['similarity_score']:>5.2f} {m['drop_from_peak_pct']:>+5.1f}% {m['rsi']:>5} {sk:>5} {bb:>5} {bnc:>3}  {d1:>6} {d3:>6} {d7:>6} {d14:>6} {d30:>6}")

    st = r['stats']['outcomes']
    print(f"\nSTATS  bounce={r['stats']['bounce_next_bar']}")
    for k in ['d1','d3','d7','d14','d30']:
        s = st[k]
        if s:
            print(f"  {k:>3}: median {s['median']:+.1f}%  [{s['min']:+.1f} … {s['max']:+.1f}]  win {s['win_rate']}")

    # ② Regime split
    rs = r['stats']
    print(f"\n② REGIME — hiện tại: {rs['current_regime']}")
    for label, key in [("CÙNG regime (giống NOW)", "regime_same"), ("KHÁC regime", "regime_diff")]:
        g = rs.get(key, {})
        if g.get('n', 0) >= 1:
            o = g['outcomes']
            line = "  ".join(
                f"{k} {o[k]['median']:+.1f}% (win {o[k]['win_rate']})"
                for k in ['d7','d14','d30'] if o.get(k))
            print(f"  {label:<26} n={g['n']:>2}:  {line}")
        else:
            print(f"  {label:<26} n= 0")

    # ③ Conviction
    cv = rs['conviction']
    print(f"\n③ CONVICTION (độ bất định): {cv['level']}")
    if cv.get('band_d30'):
        print(f"  Band d30 cùng-regime: {cv['band_d30']}  IQR {cv['iqr_d30']}%  win {cv['win_rate']}  bias {cv['dir_bias']}")
    print(f"  → {cv['note']}")

    print(f"\n{r['stats']['disclaimer']}")

    # Draw chart (bỏ qua khi --no-chart, vd lúc chạy multi-TF aggregate)
    if not NO_CHART:
        print("\nDrawing chart...")
        draw_chart(r)
        import subprocess
        subprocess.Popen(['open', CHART_PATH])
