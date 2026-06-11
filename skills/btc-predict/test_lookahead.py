#!/usr/bin/env python3
"""
test_lookahead.py — Unit test chống Look-Ahead Bias cho btc_predict.collect_future_bars().
Directive reviewer v1-SHADOW (2026-06-12): ném synthetic data tuyến tính (1,2,3…n) vào hàm
forecast. Nếu phần "tương lai" đọc trúng index TRONG/TRƯỚC cửa-sổ-hiện-tại → ném LOOK_AHEAD_DETECTED.
Lệch 1 index = lừa đảo toán học ngầm. Chạy: python3 test_lookahead.py  (exit 0 = pass, 1 = fail).
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from btc_predict import collect_future_bars

FAILS = []
def check(cond, msg):
    if not cond: FAILS.append(msg)

# Synthetic bars: [ts, open, high, low, close, vol] với close tăng tuyến tính 100,101,…
N = 120
bars = [[d * 86400000, 100 + d, 100 + d + 0.5, 100 + d - 0.5, 100 + d, 1.0] for d in range(N)]
LOOK_FWD = 30

for i in range(20, N - LOOK_FWD - 1):
    close_i = bars[i][4]
    fut = collect_future_bars(bars, i, close_i, LOOK_FWD)

    # 1) INVARIANT cốt lõi: mọi fi PHẢI > i (strictly after window-end). Lệch = look-ahead.
    for e in fut:
        if e['fi'] <= i:
            raise SystemExit(f"LOOK_AHEAD_DETECTED: fi={e['fi']} <= window-end i={i} (day={e['day']})")
        check(e['fi'] == i + e['day'], f"fi lệch: i={i} day={e['day']} fi={e['fi']} (≠{i+e['day']})")

    # 2) Monotonic check: close tăng tuyến tính → mọi 'c' tương lai PHẢI dương + tăng dần theo day
    cs = [e['c'] for e in fut]
    check(all(c > 0 for c in cs), f"i={i}: future 'c' phải dương (data tăng) — có giá trị ≤0 = đọc nhầm quá khứ")
    check(cs == sorted(cs), f"i={i}: future 'c' phải tăng đơn điệu theo data tuyến tính")

    # 3) KHÔNG phần tử nào trùng giá trị nến trong window (close window = 100+i…; future = 100+(i+d))
    window_closes = {bars[j][4] for j in range(i - 14, i + 1)}
    for e in fut:
        fut_close_price = close_i * (1 + e['c'] / 100)
        if round(fut_close_price, 6) in window_closes:
            raise SystemExit(f"LOOK_AHEAD_DETECTED: future close {fut_close_price} trùng giá trị trong window @ i={i}")

# 4) Boundary: cuối mảng → future bị cắt, KHÔNG vượt biên (không IndexError, fi < len)
edge = collect_future_bars(bars, N - 5, bars[N-5][4], LOOK_FWD)
check(all(e['fi'] < N for e in edge), "boundary: fi vượt len(bars)")
check(len(edge) == 4, f"boundary: kỳ vọng 4 future bars (N-4..N-1), được {len(edge)}")

if FAILS:
    print("❌ FAIL:")
    for m in FAILS: print("  -", m)
    sys.exit(1)
print(f"✅ PASS — collect_future_bars sạch look-ahead qua {N - LOOK_FWD - 22} window + boundary. "
      f"Mọi fi > window-end, future monotonic, không trùng quá khứ.")
