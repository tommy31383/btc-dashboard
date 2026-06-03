#!/usr/bin/env python3
"""Thống kê GIỜ UTC mà ĐÁY (low) / ĐỈNH (high) mỗi ngày hình thành — tìm pattern timing → rule.
   Nếu đáy hay ở giờ X + đỉnh ở giờ Y (ổn định per-year) → rule buy-quanh-X / sell-quanh-Y.
"""
import json, datetime
from collections import defaultdict
CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
raw = json.load(open(CACHE)); raw.sort(key=lambda x: x["time"])

# group 5m theo ngày UTC → tìm giờ của min-low & max-high
days = defaultdict(list)
for c in raw:
    d = datetime.datetime.utcfromtimestamp(c["time"] / 1000)
    days[(d.year, d.month, d.day)].append((d.hour, c["high"], c["low"], c["close"], c["time"]))

low_hr = defaultdict(int); high_hr = defaultdict(int)
low_hr_yr = defaultdict(lambda: defaultdict(int)); high_hr_yr = defaultdict(lambda: defaultdict(int))
updays = 0; ndays = 0
# rule test: buy 1 giờ, sell 1 giờ — avg return
for k in sorted(days):
    bars = days[k]
    if len(bars) < 200: continue  # ngày đủ data
    lo_bar = min(bars, key=lambda x: x[2]); hi_bar = max(bars, key=lambda x: x[1])
    lh, hh = lo_bar[0], hi_bar[0]
    low_hr[lh] += 1; high_hr[hh] += 1
    low_hr_yr[k[0]][lh] += 1; high_hr_yr[k[0]][hh] += 1
    ndays += 1
    if hi_bar[4] > lo_bar[4]: updays += 1   # đỉnh SAU đáy = ngày tăng (low trước high)

print(f"=== THỐNG KÊ GIỜ ĐÁY/ĐỈNH ({ndays} ngày, 7y) ===")
print(f"  Ngày 'đáy TRƯỚC đỉnh' (low→high, xu hướng tăng trong ngày): {updays/ndays*100:.0f}%")
print(f"\n  Phân bố GIỜ UTC hình thành ĐÁY (low) — bar = % số ngày:")
for h in range(24):
    p = low_hr[h] / ndays * 100
    print(f"    {h:02d}h {'█'*int(p*2):<24} {p:4.1f}%")
print(f"\n  Phân bố GIỜ UTC hình thành ĐỈNH (high):")
for h in range(24):
    p = high_hr[h] / ndays * 100
    print(f"    {h:02d}h {'█'*int(p*2):<24} {p:4.1f}%")
# peaks
lo_peak = sorted(low_hr, key=lambda h: -low_hr[h])[:4]
hi_peak = sorted(high_hr, key=lambda h: -high_hr[h])[:4]
print(f"\n  ĐÁY hay ở giờ: {', '.join(f'{h:02d}h({low_hr[h]/ndays*100:.0f}%)' for h in lo_peak)}")
print(f"  ĐỈNH hay ở giờ: {', '.join(f'{h:02d}h({high_hr[h]/ndays*100:.0f}%)' for h in hi_peak)}")
# per-year stability của top low-hour & high-hour
print(f"\n  Ổn định per-year (% ngày có đáy ở {lo_peak[0]:02d}h / đỉnh ở {hi_peak[0]:02d}h):")
for y in sorted(low_hr_yr):
    ny = sum(low_hr_yr[y].values())
    print(f"    {y}: đáy@{lo_peak[0]:02d}h {low_hr_yr[y][lo_peak[0]]/ny*100:4.1f}%  |  đỉnh@{hi_peak[0]:02d}h {high_hr_yr[y][hi_peak[0]]/ny*100:4.1f}%  (uniform={100/24:.1f}%)")
print(f"\n  → Uniform (ngẫu nhiên) = {100/24:.1f}%/giờ. Giờ nào VƯỢT HẲN = pattern thật. Gần uniform = không edge timing.")
