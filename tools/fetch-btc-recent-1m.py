#!/usr/bin/env python3
"""
fetch-btc-recent-1m.py — Fetch BTC 5m data 35 ngày gần nhất từ Binance
và merge vào cache hiện tại (binance-5m-7y.json).
"""
import json, urllib.request, time, datetime, os, ssl

SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE

CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
SYMBOL = "BTCUSDT"
INTERVAL = "5m"
LIMIT = 1000

def fetch_klines(symbol, interval, start_ms, end_ms):
    all_bars = []
    cur = start_ms
    while cur < end_ms:
        url = (f"https://fapi.binance.com/fapi/v1/klines"
               f"?symbol={symbol}&interval={interval}&startTime={cur}&endTime={end_ms}&limit={LIMIT}")
        try:
            with urllib.request.urlopen(url, timeout=15, context=SSL_CTX) as r:
                data = json.loads(r.read())
        except Exception as e:
            print(f"  Error: {e}, retry 3s...")
            time.sleep(3)
            continue
        if not data: break
        for d in data:
            all_bars.append({
                "time": d[0],
                "open": float(d[1]),
                "high": float(d[2]),
                "low":  float(d[3]),
                "close": float(d[4]),
                "volume": float(d[5])
            })
        last_ts = data[-1][0]
        if last_ts <= cur: break
        cur = last_ts + 5*60*1000
        time.sleep(0.1)
    return all_bars

print("Loading existing cache...")
existing = json.load(open(CACHE))
existing_times = {b["time"] for b in existing}
last_ts = max(b["time"] for b in existing)
print(f"Cache: {len(existing)} bars, last: {datetime.datetime.utcfromtimestamp(last_ts/1000):%Y-%m-%d %H:%M}")

# Fetch from last cached bar to now
now_ms = int(time.time() * 1000)
start_ms = last_ts + 5*60*1000  # next bar after last cached
print(f"Fetching from {datetime.datetime.utcfromtimestamp(start_ms/1000):%Y-%m-%d %H:%M} → now...")

new_bars = fetch_klines(SYMBOL, INTERVAL, start_ms, now_ms)
new_bars = [b for b in new_bars if b["time"] not in existing_times]
print(f"Fetched {len(new_bars)} new bars")

if new_bars:
    merged = existing + new_bars
    merged.sort(key=lambda x: x["time"])
    # Save
    with open(CACHE, "w") as f:
        json.dump(merged, f, separators=(",", ":"))
    last_new = max(b["time"] for b in new_bars)
    print(f"✅ Cache updated: {len(merged)} total bars, last: {datetime.datetime.utcfromtimestamp(last_new/1000):%Y-%m-%d %H:%M}")
else:
    print("No new bars to add.")

# Show last 30 days stats
cut_30d = now_ms - 30*24*3600*1000
all_bars = json.load(open(CACHE))
bars_30d = [b for b in all_bars if b["time"] >= cut_30d]
print(f"\nLast 30d: {len(bars_30d)} bars | {datetime.datetime.utcfromtimestamp(bars_30d[0]['time']/1000):%Y-%m-%d} → {datetime.datetime.utcfromtimestamp(bars_30d[-1]['time']/1000):%Y-%m-%d}")
print(f"Price range: ${min(b['low'] for b in bars_30d):,.0f} - ${max(b['high'] for b in bars_30d):,.0f}")
