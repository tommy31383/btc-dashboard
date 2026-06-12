#!/usr/bin/env python3
"""
BTC Predict — Historical Analog Distribution (NOT a forecast)
Tổng hợp OHLC trung bình từng cây nến tương lai của các kịch bản tương tự (context-only).
Output: btc_predict.html trong thư mục tạm hệ thống (tempfile.gettempdir()).
"""

import json, urllib.request, ssl, os, base64, subprocess, sys, tempfile
from datetime import datetime, timezone, timedelta
import statistics

# TLS verification ON (default verified context). Never CERT_NONE.
_SSL_CTX = ssl.create_default_context()

# Console may be cp1252 (Windows) → force UTF-8 so unicode in logs never crashes.
try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass

CACHE_PATH   = os.environ.get("BTC_5M_CACHE") or os.path.expanduser("~/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json")
BINANCE_BASE = "https://api.binance.com/api/v3"
_TMP         = tempfile.gettempdir()  # cross-platform temp dir (not hardcoded /tmp)
CHART_PATH   = os.path.join(_TMP, "btc_predict_chart.png")
HTML_PATH    = os.path.join(_TMP, "btc_predict.html")
RESULT_PATH  = os.path.join(_TMP, "btc_predict_result.json")

# Required disclaimer text (asserted by test_btc_predict.py). Do NOT weaken.
DISCLAIMER_LINES = [
    "NOT A FORECAST / NOT A TRADING SIGNAL",
    "Backtest OOS: median historical continuation does not beat base-rate (~coin-flip).",
    "Analog method did not beat climatology.",
]

def disclaimer_banner():
    """Red HTML disclaimer banner. Embeds the required DISCLAIMER_LINES verbatim.
    Pure + testable. Framing = historical analog distribution, NOT a forecast."""
    return f"""<div class="section" style="background:#2a0f12;border:1px solid #b03030">
  <h3 style="color:#ef5350">⚠️ {DISCLAIMER_LINES[0]}</h3>
  <p style="color:#e0b0b0;font-size:12px;line-height:1.6;margin:0">
    Đây là <strong>historical analog distribution</strong> — phân phối kết quả lịch sử của các cửa sổ 14D
    giống hiện tại về hình dạng. <strong>{DISCLAIMER_LINES[0]}.</strong>
    <br>• <strong>{DISCLAIMER_LINES[1]}</strong>
    <br>• {DISCLAIMER_LINES[2]}
    <br>• Band Q25–Q75 phản ánh các analog chồng lấn (không độc lập) → đọc như dải RỘNG, kém tin cậy.
    <br>• Các analog trộn nhiều regime (bull/bear) — không tách.
    <br><strong>Context-only — KHÔNG dùng cho entry / sizing / TP / SL.</strong>
  </p>
</div>"""

LOOK_BACK    = 14   # days of context for matching
LOOK_FWD     = 30   # days of prediction forward
CONTEXT_DAYS = 30   # days of current candles to show on left
MAX_MATCHES  = 15
DEDUP_DAYS   = 14


# ─── helpers ──────────────────────────────────────────────────────────────────

def fetch(url):
    with urllib.request.urlopen(url, timeout=10, context=_SSL_CTX) as r:
        return json.loads(r.read())

def fetch_binance(interval, limit):
    return fetch(f"{BINANCE_BASE}/klines?symbol=BTCUSDT&interval={interval}&limit={limit}")

def parse_kline(k):
    return [int(k[0]), float(k[1]), float(k[2]), float(k[3]), float(k[4]), float(k[5])]

def aggregate(bars_list, interval_hours):
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

def rsi_series(closes, period=14):
    """Return full RSI series (one value per bar after warmup)"""
    out = [None] * period
    if len(closes) <= period:
        return out
    gains = []
    losses = []
    for i in range(1, period + 1):
        d = closes[i] - closes[i-1]
        gains.append(max(d, 0))
        losses.append(max(-d, 0))
    ag = sum(gains) / period
    al = sum(losses) / period
    out.append(round(100 - 100 / (1 + ag / al), 1) if al != 0 else 100.0)
    for i in range(period + 1, len(closes)):
        d = closes[i] - closes[i-1]
        ag = (ag * (period-1) + max(d, 0)) / period
        al = (al * (period-1) + max(-d, 0)) / period
        out.append(round(100 - 100 / (1 + ag / al), 1) if al != 0 else 100.0)
    return out

def rsi_val(closes, period=14):
    s = rsi_series(closes, period)
    for v in reversed(s):
        if v is not None:
            return v
    return None

def pearson_corr(a, b):
    n = len(a)
    if n < 3: return 0
    ma, mb = sum(a)/n, sum(b)/n
    num = sum((a[i]-ma)*(b[i]-mb) for i in range(n))
    da  = sum((a[i]-ma)**2 for i in range(n)) ** 0.5
    db  = sum((b[i]-mb)**2 for i in range(n)) ** 0.5
    return num / (da * db) if da and db else 0

def stoch_rsi_val(closes, rsi_period=14, stoch_period=14, k_smooth=3, d_smooth=3):
    rs = []
    for i in range(rsi_period, len(closes) + 1):
        r = rsi_val(closes[max(0, i-rsi_period-5):i], rsi_period)
        if r is not None:
            rs.append(r)
    if len(rs) < stoch_period:
        return None, None

    raw_k = []
    for i in range(stoch_period - 1, len(rs)):
        win = rs[i - stoch_period + 1:i + 1]
        lo, hi = min(win), max(win)
        raw_k.append((rs[i] - lo) / (hi - lo) * 100 if hi != lo else 50)

    def smooth(arr, n):
        return [sum(arr[i-n+1:i+1])/n for i in range(n-1, len(arr))]

    k_line = smooth(raw_k, k_smooth)
    d_line = smooth(k_line, d_smooth)
    if not k_line or not d_line:
        return None, None
    return round(k_line[-1], 1), round(d_line[-1], 1)

def atr_val(bars, period=14):
    trs = []
    for i in range(1, len(bars)):
        h, l, pc = bars[i][2], bars[i][3], bars[i-1][4]
        trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    if len(trs) < period:
        return None
    return sum(trs[-period:]) / period

def bollinger_val(closes, period=20, std_mult=2.0):
    if len(closes) < period:
        return None
    window = closes[-period:]
    mid = sum(window) / period
    std = (sum((x - mid)**2 for x in window) / period) ** 0.5
    upper = mid + std_mult * std
    lower = mid - std_mult * std
    cur = closes[-1]
    return round((cur - lower) / (upper - lower), 3) if upper != lower else 0.5

def consec_streak(bars):
    if not bars: return 0, 'none'
    color = 'green' if bars[-1][4] >= bars[-1][1] else 'red'
    count = 0
    for b in reversed(bars):
        c = 'green' if b[4] >= b[1] else 'red'
        if c == color: count += 1
        else: break
    return count, color

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
    if yr == 2026: return "2026 bear"
    return ""


# ─── chart drawing ────────────────────────────────────────────────────────────

def draw_prediction_chart(live_bars, predicted, matches_summary, cur_close, cur_date):
    """
    live_bars:      list of [ts, o, h, l, c, v] — last CONTEXT_DAYS bars
    predicted:      list of dicts, index 0=day+1 ... 29=day+30
                    each: {median_o, median_h, median_l, median_c, q25_c, q75_c, n}
    matches_summary: list of {date, drop, rsi, stoch_k, event, outcomes}
    """
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    import matplotlib.patches as mpatches
    from matplotlib.patches import FancyArrowPatch

    BULL = '#26a69a'
    BEAR = '#ef5350'
    PRED_BULL = '#1a7a70'
    PRED_BEAR = '#b03030'
    BAND_COL  = '#ffa726'
    GRID_COL  = '#1e1e2e'
    BG        = '#0a0a14'
    FG        = '#cccccc'
    TITLE_COL = '#e0e0ff'

    n_live = len(live_bars)
    n_pred = len(predicted)
    total_bars = n_live + n_pred + 2  # gap + future

    # Build RSI + StochRSI for live bars
    live_closes = [b[4] for b in live_bars]
    # need some warmup — use all 60 from live, then trim
    rsi_all = rsi_series(live_closes, 14)
    rsi_live = rsi_all[-n_live:]

    # predicted RSI (extrapolated via simulated closes)
    sim_closes = live_closes[:]
    pred_rsi = []
    for p in predicted:
        sim_closes.append(p['median_c'])
        pred_rsi.append(rsi_series(sim_closes, 14)[-1])

    fig = plt.figure(figsize=(22, 12), facecolor=BG)
    gs = fig.add_gridspec(3, 1, height_ratios=[3, 1, 1], hspace=0.04)
    ax1 = fig.add_subplot(gs[0])  # candles
    ax2 = fig.add_subplot(gs[1], sharex=ax1)  # RSI
    ax3 = fig.add_subplot(gs[2], sharex=ax1)  # context label

    for ax in [ax1, ax2, ax3]:
        ax.set_facecolor(BG)
        ax.tick_params(colors=FG, labelsize=8)
        ax.spines['bottom'].set_color('#333')
        ax.spines['top'].set_visible(False)
        ax.spines['right'].set_visible(False)
        ax.spines['left'].set_color('#333')
        ax.grid(True, color=GRID_COL, linewidth=0.5, alpha=0.7)

    # ── 1. Draw live candles ──────────────────────────────────────────────────
    width = 0.6
    for xi, bar in enumerate(live_bars):
        ts, o, h, l, c, v = bar
        col = BULL if c >= o else BEAR
        ax1.plot([xi, xi], [l, h], color=col, linewidth=0.8)
        body_lo, body_hi = min(o, c), max(o, c)
        rect = mpatches.FancyBboxPatch(
            (xi - width/2, body_lo), width, max(body_hi - body_lo, 1),
            boxstyle="square,pad=0", linewidth=0, facecolor=col, alpha=0.9
        )
        ax1.add_patch(rect)

    # ── 2. Divider line "TODAY" ───────────────────────────────────────────────
    div_x = n_live - 0.5
    ax1.axvline(div_x, color='#888', linewidth=1, linestyle='--', alpha=0.8)
    ax2.axvline(div_x, color='#888', linewidth=1, linestyle='--', alpha=0.8)
    ax1.text(div_x + 0.3, ax1.get_ylim()[1] if ax1.get_ylim()[1] != 1 else cur_close * 1.02,
             'TODAY', color='#888', fontsize=8, va='top', ha='left')

    # ── 3. Draw predicted candles ─────────────────────────────────────────────
    pred_x_start = n_live + 1
    pred_highs = []
    pred_lows  = []
    for i, p in enumerate(predicted):
        xi = pred_x_start + i
        o, h, l, c = p['median_o'], p['median_h'], p['median_l'], p['median_c']
        q25, q75 = p['q25_c'], p['q75_c']
        pred_highs.append(h)
        pred_lows.append(l)

        col = PRED_BULL if c >= o else PRED_BEAR

        # Q25-Q75 band as thin rect
        band_lo, band_hi = min(q25, q75), max(q25, q75)
        ax1.add_patch(mpatches.FancyBboxPatch(
            (xi - width/2, band_lo), width, max(band_hi - band_lo, 1),
            boxstyle="square,pad=0", linewidth=0, facecolor=BAND_COL, alpha=0.15
        ))

        # Wick
        ax1.plot([xi, xi], [l, h], color=col, linewidth=0.8, alpha=0.8)

        # Body
        body_lo, body_hi = min(o, c), max(o, c)
        ax1.add_patch(mpatches.FancyBboxPatch(
            (xi - width/2, body_lo), width, max(body_hi - body_lo, 1),
            boxstyle="square,pad=0", linewidth=1, edgecolor=col,
            facecolor=col, alpha=0.5
        ))

        # Day label
        if (i+1) in [1, 7, 14, 21, 30]:
            ax1.text(xi, l - (l * 0.003), f'+{i+1}D',
                     color='#aaa', fontsize=7, ha='center', va='top')

    # Median close line (dotted)
    pred_closes = [p['median_c'] for p in predicted]
    pred_xs = [pred_x_start + i for i in range(len(predicted))]
    ax1.plot([n_live - 1] + pred_xs, [cur_close] + pred_closes,
             color=BAND_COL, linewidth=1.5, linestyle=':', alpha=0.8, label='Median close')

    # Q25/Q75 envelope
    q25_closes = [p['q25_c'] for p in predicted]
    q75_closes = [p['q75_c'] for p in predicted]
    ax1.fill_between(pred_xs, q25_closes, q75_closes,
                     color=BAND_COL, alpha=0.08, label='Q25-Q75 range')

    # ── 4. RSI panel ─────────────────────────────────────────────────────────
    live_x = list(range(n_live))
    ax2.plot(live_x, rsi_live, color='#9c27b0', linewidth=1.2)
    ax2.plot(pred_xs, pred_rsi, color='#9c27b0', linewidth=1, linestyle=':', alpha=0.6)
    ax2.axhline(70, color='#ef5350', linewidth=0.5, linestyle='--', alpha=0.5)
    ax2.axhline(30, color='#26a69a', linewidth=0.5, linestyle='--', alpha=0.5)
    ax2.set_ylim(0, 100)
    ax2.set_ylabel('RSI', color=FG, fontsize=8)
    ax2.set_yticks([30, 70])

    # ── 5. Bottom label ───────────────────────────────────────────────────────
    ax3.set_visible(False)

    # ── axis formatting ───────────────────────────────────────────────────────
    # X ticks
    tick_xs = []
    tick_labels = []
    for xi, bar in enumerate(live_bars):
        ts = bar[0]
        dt = datetime.fromtimestamp(ts/1000, tz=timezone.utc)
        if dt.day in [1, 8, 15, 22] or xi == 0:
            tick_xs.append(xi)
            tick_labels.append(dt.strftime('%m/%d'))
    # future ticks
    cur_dt = datetime.fromtimestamp(live_bars[-1][0]/1000, tz=timezone.utc)
    for d in [7, 14, 21, 30]:
        future_dt = cur_dt + timedelta(days=d)
        tick_xs.append(pred_x_start + d - 1)
        tick_labels.append(future_dt.strftime('%m/%d*'))
    ax1.set_xticks(tick_xs)
    ax1.set_xticklabels(tick_labels, fontsize=7, rotation=30)
    plt.setp(ax2.get_xticklabels(), visible=False)

    # Auto Y range
    all_highs = [b[2] for b in live_bars] + (pred_highs if pred_highs else [])
    all_lows  = [b[3] for b in live_bars] + (pred_lows  if pred_lows  else [])
    ymin = min(all_lows)  * 0.995
    ymax = max(all_highs) * 1.005
    ax1.set_ylim(ymin, ymax)
    ax1.set_xlim(-0.5, total_bars)

    ax1.yaxis.set_major_formatter(plt.FuncFormatter(lambda x, _: f'${x:,.0f}'))
    ax1.set_ylabel('Price (USDT)', color=FG, fontsize=9)

    # Legend
    from matplotlib.lines import Line2D
    legend_elements = [
        mpatches.Patch(facecolor=BULL, label='Nến thực (tăng)'),
        mpatches.Patch(facecolor=BEAR, label='Nến thực (giảm)'),
        mpatches.Patch(facecolor=PRED_BULL, alpha=0.5, label='Predicted (tăng)'),
        mpatches.Patch(facecolor=PRED_BEAR, alpha=0.5, label='Predicted (giảm)'),
        Line2D([0], [0], color=BAND_COL, linestyle=':', label='Median close'),
        mpatches.Patch(facecolor=BAND_COL, alpha=0.2, label='Q25-Q75 band'),
    ]
    ax1.legend(handles=legend_elements, loc='upper left', fontsize=8,
               framealpha=0.2, facecolor='#111', edgecolor='#333',
               labelcolor=FG)

    # Title
    n_match = len(matches_summary)
    win30 = sum(1 for m in matches_summary if m.get('d30', 0) and m['d30'] > 0)
    med30 = statistics.median([m['d30'] for m in matches_summary if m.get('d30') is not None]) if matches_summary else 0
    col30 = '#26a69a' if med30 >= 0 else '#ef5350'

    fig.suptitle(
        f'BTC Historical Analog Distribution (NOT a forecast) — {cur_date} · '
        f'{n_match} kịch bản giống hình dạng · '
        f'+30D analog median: {med30:+.1f}% · '
        f'Up30D: {win30}/{n_match}',
        color=TITLE_COL, fontsize=13, fontweight='bold', y=0.98
    )

    ax1.text(div_x + 0.5, ymax * 0.9995,
             f'  ▶ Analog median path — NO proven edge\n  ({n_match} analogs)',
             color='#ffa726', fontsize=9, va='top')

    plt.savefig(CHART_PATH, dpi=150, bbox_inches='tight',
                facecolor=BG, edgecolor='none')
    plt.close()
    print(f"Chart saved → {CHART_PATH}")


# ─── main ────────────────────────────────────────────────────────────────────

def collect_future_bars(bars_hist, i, close, look_fwd):
    """Normalized future OHLC (% vs `close`) cho analog có window kết thúc ở index i.

    INVARIANT chống Look-Ahead Bias: CHỈ đọc các nến STRICTLY AFTER i (fi = i + d, d >= 1).
    Mỗi entry mang theo 'fi' để caller / unit-test assert fi > i. `close` = nến đóng cuối
    cùng TRONG window (bars_hist[i][4]) — phần "tương lai" của analog là dữ liệu SAU window đó
    trong quá khứ (hợp lệ), KHÔNG phải tương lai của cửa sổ hiện tại.
    Lệch 1 index ở đây = forecast thành lừa đảo toán học ngầm → test_lookahead.py canh.
    """
    out = []
    for d in range(1, look_fwd + 1):
        fi = i + d
        if fi < len(bars_hist):
            fb = bars_hist[fi]
            out.append({
                'day': d, 'fi': fi,
                'o': (fb[1] - close) / close * 100,
                'h': (fb[2] - close) / close * 100,
                'l': (fb[3] - close) / close * 100,
                'c': (fb[4] - close) / close * 100,
            })
    return out


def main():
    print("Loading 7y cache...")
    with open(CACHE_PATH) as f:
        raw = json.load(f)

    bars_1d_hist = aggregate(raw, 24)

    print("Fetching live 1D from Binance...")
    live_raw = fetch_binance('1d', 90)  # extra warmup for RSI
    live_1d  = [parse_kline(k) for k in live_raw]

    # Current structure (last LOOK_BACK bars)
    bars14    = live_1d[-LOOK_BACK:]
    highs14   = [b[2] for b in bars14]
    lows14    = [b[3] for b in bars14]
    closes14  = [b[4] for b in bars14]
    peak14    = max(highs14)
    trough14  = min(lows14)
    cur_close = closes14[-1]
    cur_date  = datetime.fromtimestamp(bars14[-1][0]/1000, tz=timezone.utc).strftime('%Y-%m-%d')

    drop_from_peak = (cur_close - peak14) / peak14 * 100
    pos_in_range   = (cur_close - trough14) / (peak14 - trough14) * 100 if peak14 != trough14 else 50

    print(f"Current: {cur_date} close={cur_close:.0f} drop={drop_from_peak:.1f}% pos={pos_in_range:.1f}%")

    # Current regime for soft scoring
    live_closes_all = [b[4] for b in live_1d]
    cur_rsi         = rsi_val(live_closes_all, 14)
    ema200_cur      = ema(live_closes_all, min(200, len(live_closes_all)))[-1]
    ema50_cur       = ema(live_closes_all, min(50,  len(live_closes_all)))[-1]
    cur_below_ema200 = cur_close < ema200_cur if ema200_cur else None
    cur_below_ema50  = cur_close < ema50_cur  if ema50_cur  else None

    # Shape + ATR ratio inputs for current window
    cur_returns14 = [(bars14[i][4] - bars14[i-1][4]) / bars14[i-1][4]
                     for i in range(1, len(bars14))]
    atr14_cur = atr_val(bars14, 14) or 1
    cur_drop_atr_ratio = drop_from_peak / (atr14_cur / cur_close * 100)

    # Precompute indicator series on hist (O(n), fast)
    print("Precomputing indicator series...")

    def _build_rsi_series(bars, period=14):
        closes = [b[4] for b in bars]
        out = [None] * period
        if len(closes) <= period:
            return out
        deltas = [closes[i] - closes[i-1] for i in range(1, len(closes))]
        ag = sum(max(d, 0) for d in deltas[:period]) / period
        al = sum(max(-d, 0) for d in deltas[:period]) / period
        out.append(round(100 - 100/(1+ag/al), 1) if al else 100.0)
        for d in deltas[period:]:
            ag = (ag*(period-1) + max(d, 0)) / period
            al = (al*(period-1) + max(-d, 0)) / period
            out.append(round(100 - 100/(1+ag/al), 1) if al else 100.0)
        return out

    rsi_hist_series = _build_rsi_series(bars_1d_hist, 14)
    ema200_hist_all = ema([b[4] for b in bars_1d_hist], 200)
    ema50_hist_all  = ema([b[4] for b in bars_1d_hist], 50)

    # ── Scan 7y ───────────────────────────────────────────────────────────────
    print("Scanning 7y for similar scenarios...")
    WINDOW = LOOK_BACK
    matches = []

    for i in range(WINDOW, len(bars_1d_hist) - LOOK_FWD - 1):
        window = bars_1d_hist[i-WINDOW:i+1]
        h14 = [b[2] for b in window]
        l14 = [b[3] for b in window]
        c14 = [b[4] for b in window]

        peak   = max(h14)
        trough = min(l14)
        close  = c14[-1]
        drop   = (close - peak) / peak * 100
        pos    = (close - trough) / (peak - trough) * 100 if peak != trough else 50

        # Hard gate: drop + position (same as btc1d)
        score = 0
        if abs(drop - drop_from_peak) <= 6:
            score += 1 + max(0, 1 - abs(drop - drop_from_peak) / 6)
        if abs(pos - pos_in_range) <= 15:
            score += 1

        if score < 1.5:
            continue

        # Soft bonus — rerank không loại
        rsi_h_pre = rsi_hist_series[i] if i < len(rsi_hist_series) else None
        if rsi_h_pre is not None and cur_rsi is not None:
            if abs(rsi_h_pre - cur_rsi) <= 20:
                score += 0.5

        ema200_i = ema200_hist_all[i] if i < len(ema200_hist_all) else None
        if ema200_i is not None and cur_below_ema200 is not None:
            if (close < ema200_i) == cur_below_ema200:
                score += 0.5

        ema50_i = ema50_hist_all[i] if i < len(ema50_hist_all) else None
        if ema50_i is not None and cur_below_ema50 is not None:
            if (close < ema50_i) == cur_below_ema50:
                score += 0.3

        # +1.0: Candle shape correlation (14D daily % returns)
        hist_returns = [(window[j][4] - window[j-1][4]) / window[j-1][4]
                        for j in range(1, len(window))]
        corr = pearson_corr(cur_returns14, hist_returns)
        if corr > 0.5:
            score += 1.0
        elif corr > 0.25:
            score += 0.5

        # +0.5: ATR-normalized drop ratio tương đồng
        atr14_h = atr_val(window, 14) or 1
        hist_drop_atr_ratio = drop / (atr14_h / close * 100)
        if abs(hist_drop_atr_ratio - cur_drop_atr_ratio) <= 1.5:
            score += 0.5

        ts = bars_1d_hist[i][0]
        dt = datetime.fromtimestamp(ts/1000, tz=timezone.utc)

        # Collect future OHLC normalized to match close (extracted → anti look-ahead helper)
        future_bars = collect_future_bars(bars_1d_hist, i, close, LOOK_FWD)

        def pct_after(days):
            fi = i + days
            return round((bars_1d_hist[fi][4] - close) / close * 100, 1) if fi < len(bars_1d_hist) else None

        rsi_h = rsi_val([b[4] for b in bars_1d_hist[max(0,i-30):i+1]], 14)
        stk_k_h, _ = stoch_rsi_val([b[4] for b in bars_1d_hist[max(0,i-60):i+1]])
        bb_h = bollinger_val([b[4] for b in bars_1d_hist[max(0,i-25):i+1]])

        matches.append({
            'date': dt.strftime('%Y-%m-%d'),
            'hist_index': i,
            'event': event_label(dt.year, dt.month),
            'drop': round(drop, 1),
            'pos': round(pos, 1),
            'score': round(score, 2),
            'rsi': rsi_h,
            'stoch_k': stk_k_h,
            'bb_pb': bb_h,
            'd1':  pct_after(1),
            'd7':  pct_after(7),
            'd14': pct_after(14),
            'd30': pct_after(30),
            'future_bars': future_bars,
        })

    # Dedup + take top MAX_MATCHES
    matches.sort(key=lambda x: -x['score'])
    deduped = []
    for m in matches:
        if not any(abs(m['hist_index'] - p['hist_index']) < DEDUP_DAYS for p in deduped):
            deduped.append(m)
        if len(deduped) >= MAX_MATCHES:
            break

    top = sorted(deduped, key=lambda x: x['hist_index'])
    print(f"Found {len(matches)} matches → top {len(top)} after dedup")

    # ── Aggregate future OHLC — weighted by similarity score ────────────────
    def weighted_median(vals_weights):
        """Weighted median: sort by val, find weight midpoint"""
        if not vals_weights:
            return 0
        vw = sorted(vals_weights, key=lambda x: x[0])
        total_w = sum(w for _, w in vw)
        cum = 0
        for v, w in vw:
            cum += w
            if cum >= total_w / 2:
                return v
        return vw[-1][0]

    def wq(vals_weights, q):
        """Weighted quantile"""
        if not vals_weights:
            return 0
        vw = sorted(vals_weights, key=lambda x: x[0])
        total_w = sum(w for _, w in vw)
        cum = 0
        for v, w in vw:
            cum += w
            if cum >= total_w * q:
                return v
        return vw[-1][0]

    predicted = []
    for day in range(1, LOOK_FWD + 1):
        entries = [(m, m['future_bars'][day-1]) for m in top
                   if day <= len(m['future_bars'])]
        if not entries:
            break

        def to_price(pct):
            return cur_close * (1 + pct / 100)

        def wmed(key):
            vw = [(e[key], m['score']) for m, e in entries if e[key] is not None]
            return weighted_median(vw)

        def wq25(key):
            vw = [(e[key], m['score']) for m, e in entries if e[key] is not None]
            return wq(vw, 0.25)

        def wq75(key):
            vw = [(e[key], m['score']) for m, e in entries if e[key] is not None]
            return wq(vw, 0.75)

        predicted.append({
            'day': day,
            'n': len(entries),
            'median_o': to_price(wmed('o')),
            'median_h': to_price(wmed('h')),
            'median_l': to_price(wmed('l')),
            'median_c': to_price(wmed('c')),
            'q25_c':    to_price(wq25('c')),
            'q75_c':    to_price(wq75('c')),
            'med_o_pct': round(wmed('o'), 2),
            'med_c_pct': round(wmed('c'), 2),
            'q25_c_pct': round(wq25('c'), 2),
            'q75_c_pct': round(wq75('c'), 2),
        })

    # Save result JSON
    result = {
        'generated_at': datetime.now(tz=timezone.utc).strftime('%Y-%m-%d %H:%M UTC'),
        'cur_date': cur_date,
        'cur_close': cur_close,
        'drop_from_peak': round(drop_from_peak, 1),
        'pos_in_range': round(pos_in_range, 1),
        'n_matches': len(top),
        'matches': [{k: v for k, v in m.items() if k != 'future_bars'} for m in top],
        'predicted': predicted,
    }
    with open(RESULT_PATH, 'w') as f:
        json.dump(result, f, indent=2)
    print(f"Result saved → {RESULT_PATH}")

    # ── Draw chart ───────────────────────────────────────────────────────────
    live_bars_display = live_1d[-CONTEXT_DAYS:]
    draw_prediction_chart(live_bars_display, predicted, result['matches'], cur_close, cur_date)

    # ── Build HTML ───────────────────────────────────────────────────────────
    print("Building HTML report...")
    with open(CHART_PATH, 'rb') as f:
        chart_b64 = base64.b64encode(f.read()).decode()

    # Stats
    d30s = [m['d30'] for m in result['matches'] if m.get('d30') is not None]
    win30 = sum(1 for v in d30s if v > 0)
    med30 = statistics.median(d30s) if d30s else 0

    # Table rows for matches
    match_rows = ""
    for i, m in enumerate(result['matches']):
        ev = m['event'] or '—'
        d30_val = m.get('d30')
        d30_col = '#26a69a' if (d30_val or 0) >= 0 else '#ef5350'
        d30_str = f'{d30_val:+.1f}%' if d30_val is not None else '—'
        rsi_v = m.get('rsi')
        rsi_str = f'{rsi_v}' if rsi_v else '—'
        rsi_col = '#ef5350' if (rsi_v or 99) < 30 else '#26a69a' if (rsi_v or 0) > 70 else '#ffa726'
        match_rows += f"""
        <tr>
          <td style="color:#888">#{i+1}</td>
          <td style="color:#e0e0ff"><strong>{m['date']}</strong></td>
          <td style="color:#888;font-size:11px">{ev}</td>
          <td style="color:#aaa">{m['drop']:+.1f}%</td>
          <td style="color:{rsi_col}">{rsi_str}</td>
          <td style="color:#aaa">{m.get('stoch_k') or '—'}</td>
          <td style="color:#aaa">{m.get('d1') or '—'}</td>
          <td style="color:#aaa">{m.get('d7') or '—'}</td>
          <td style="color:#aaa">{m.get('d14') or '—'}</td>
          <td style="color:{d30_col};font-weight:bold">{d30_str}</td>
        </tr>"""

    # Prediction table rows
    pred_rows = ""
    for p in predicted:
        c_pct = p['med_c_pct']
        c_col = '#26a69a' if c_pct >= 0 else '#ef5350'
        q_str = f"{p['q25_c_pct']:+.1f}% ~ {p['q75_c_pct']:+.1f}%"
        pred_rows += f"""
        <tr>
          <td style="color:#aaa">+{p['day']}D</td>
          <td style="color:{c_col};font-weight:bold">{c_pct:+.2f}%</td>
          <td style="color:#888">${p['median_c']:,.0f}</td>
          <td style="color:#777">{q_str}</td>
          <td style="color:#666">{p['n']} scenarios</td>
        </tr>"""

    med30_col = '#26a69a' if med30 >= 0 else '#ef5350'
    html = f"""<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<title>BTC Predict — {cur_date}</title>
<style>
  * {{ box-sizing:border-box; margin:0; padding:0; }}
  body {{ background:#0a0a14; color:#ddd; font-family:'Segoe UI',system-ui,sans-serif; font-size:13px; }}
  .container {{ max-width:1400px; margin:0 auto; padding:20px; }}
  h1 {{ font-size:20px; color:#fff; margin-bottom:4px; }}
  h2 {{ font-size:13px; color:#888; font-weight:normal; margin-bottom:18px; }}
  h3 {{ font-size:12px; color:#aaa; text-transform:uppercase; letter-spacing:1px; margin-bottom:12px; }}
  .section {{ background:#12121f; border:1px solid #1e1e3a; border-radius:8px; padding:20px; margin-bottom:20px; }}
  .badges {{ display:flex; flex-wrap:wrap; gap:10px; margin-bottom:16px; }}
  .badge {{ background:#0f0f1e; border:1px solid #1e1e3a; border-radius:6px; padding:10px 16px; }}
  .badge-label {{ color:#555; font-size:10px; text-transform:uppercase; letter-spacing:1px; }}
  .badge-value {{ font-size:18px; font-weight:bold; color:#e0e0ff; margin-top:4px; }}
  table {{ width:100%; border-collapse:collapse; }}
  th {{ color:#555; font-size:10px; text-transform:uppercase; letter-spacing:1px; padding:8px 10px; text-align:right; border-bottom:1px solid #1e1e3a; }}
  th:nth-child(-n+3) {{ text-align:left; }}
  td {{ padding:8px 10px; border-bottom:1px solid #111125; font-size:12px; text-align:right; }}
  td:nth-child(-n+3) {{ text-align:left; }}
  .chart-img {{ width:100%; border-radius:6px; display:block; }}
  .footer {{ color:#333; font-size:11px; text-align:center; padding:12px; }}
</style>
</head>
<body>
<div class="container">

<h1>📊 BTC Historical Analog Distribution</h1>
<h2>Generated {result['generated_at']} · {len(result['matches'])} analog scenarios · {LOOK_FWD}D — context only, NOT a forecast</h2>

{disclaimer_banner()}

<div class="section">
  <h3>Summary</h3>
  <div class="badges">
    <div class="badge"><div class="badge-label">Current Price</div><div class="badge-value">${cur_close:,.0f}</div></div>
    <div class="badge"><div class="badge-label">14D Drop</div><div class="badge-value">{drop_from_peak:+.1f}%</div></div>
    <div class="badge"><div class="badge-label">Analogs Found</div><div class="badge-value">{len(result['matches'])}</div></div>
    <div class="badge"><div class="badge-label">+30D median continuation</div><div class="badge-value" style="color:{med30_col}">{med30:+.1f}%</div></div>
    <div class="badge"><div class="badge-label">Up rate +30D (hist)</div><div class="badge-value">{win30}/{len(d30s)}</div></div>
    <div class="badge"><div class="badge-label">+30D illustrative endpoint (NOT a target)</div><div class="badge-value" style="color:#888">${cur_close*(1+med30/100):,.0f}</div></div>
  </div>
</div>

<div class="section" style="padding:12px">
  <h3 style="margin-bottom:10px">Historical analog distribution ({len(result['matches'])} analogs)</h3>
  <img src="data:image/png;base64,{chart_b64}" class="chart-img" alt="Prediction Chart">
</div>

<div class="section">
  <h3>Median historical continuation by day</h3>
  <div style="overflow-x:auto">
  <table>
    <thead>
      <tr>
        <th style="text-align:left">Day</th>
        <th>Median Close</th>
        <th>Price</th>
        <th>Q25~Q75</th>
        <th>N</th>
      </tr>
    </thead>
    <tbody>{pred_rows}</tbody>
  </table>
  </div>
</div>

<div class="section">
  <h3>Top {len(result['matches'])} Analog Scenarios</h3>
  <div style="overflow-x:auto">
  <table>
    <thead>
      <tr>
        <th>#</th>
        <th style="text-align:left">Date</th>
        <th style="text-align:left">Event</th>
        <th>Drop 14D</th>
        <th>RSI</th>
        <th>StochK</th>
        <th>+1D</th>
        <th>+7D</th>
        <th>+14D</th>
        <th>+30D</th>
      </tr>
    </thead>
    <tbody>{match_rows}</tbody>
  </table>
  </div>
</div>

<div class="footer">BTC Predict Skill · {result['generated_at']}</div>
</div>
</body>
</html>"""

    with open(HTML_PATH, 'w', encoding='utf-8') as f:
        f.write(html)
    print(f"HTML saved → {HTML_PATH}")
    # Cross-platform open (macOS `open`, Windows `os.startfile`, Linux `xdg-open`).
    try:
        if sys.platform == 'darwin':
            subprocess.Popen(['open', HTML_PATH])
        elif sys.platform.startswith('win'):
            os.startfile(HTML_PATH)  # type: ignore[attr-defined]
        else:
            subprocess.Popen(['xdg-open', HTML_PATH])
    except Exception as e:
        print(f"(could not auto-open browser: {e})")


if __name__ == '__main__':
    main()
