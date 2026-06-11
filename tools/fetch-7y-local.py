#!/usr/bin/env python3
"""
fetch-7y-local.py — Fetch 7y BTCUSDT futures 1h klines + full funding history
to local .cache (Windows). 1h klines aggregate cleanly to 4h/1d for the regime
backtest (5m granularity is unnecessary for daily-regime + 4h-signal engines).

Outputs:
  .cache/binance-1h-7y.json       [{time,open,high,low,close,volume}, ...]
  .cache/binance-funding-7y.json  [{symbol,time,rate,mark}, ...]
"""
import json, time, datetime, urllib.request, urllib.parse, ssl, os

CTX = ssl.create_default_context(); CTX.check_hostname = False; CTX.verify_mode = ssl.CERT_NONE
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", ".cache")
UA = {"User-Agent": "Mozilla/5.0"}
NOW = int(time.time() * 1000)
START = NOW - 7 * 365 * 24 * 3600 * 1000

def get(url):
    for a in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30, context=CTX) as r:
                return json.loads(r.read().decode())
        except Exception as e:
            print(f"  retry {a+1}: {e}"); time.sleep(2)
    raise RuntimeError("failed")

def fetch_klines():
    base = "https://fapi.binance.com/fapi/v1/klines"
    out = []; cur = START; calls = 0
    while cur < NOW:
        q = urllib.parse.urlencode({"symbol": "BTCUSDT", "interval": "1h", "limit": 1500, "startTime": cur})
        batch = get(f"{base}?{q}"); calls += 1
        if not batch: break
        for k in batch:
            out.append({"time": int(k[0]), "open": float(k[1]), "high": float(k[2]),
                        "low": float(k[3]), "close": float(k[4]), "volume": float(k[5])})
        last = int(batch[-1][0])
        if last <= cur: break
        cur = last + 3600_000
        if len(batch) < 1500 and cur < NOW: cur = last + 3600_000
        if calls % 10 == 0:
            print(f"  klines ...{calls} calls, {len(out)} bars, at {datetime.datetime.utcfromtimestamp(last/1000):%Y-%m-%d}")
        time.sleep(0.15)
    seen = set(); uniq = [b for b in out if not (b["time"] in seen or seen.add(b["time"]))]
    uniq.sort(key=lambda x: x["time"])
    p = os.path.join(OUT_DIR, "binance-1h-7y.json"); json.dump(uniq, open(p, "w"))
    s = datetime.datetime.utcfromtimestamp(uniq[0]["time"]/1000); e = datetime.datetime.utcfromtimestamp(uniq[-1]["time"]/1000)
    print(f"  -> {len(uniq)} 1h bars  {s:%Y-%m-%d} .. {e:%Y-%m-%d}  ({calls} calls)")

def fetch_funding():
    base = "https://fapi.binance.com/fapi/v1/fundingRate"
    out = []; seen = set(); cur = START; WIN = 320*24*3600*1000; calls = 0
    while cur < NOW:
        end = min(cur + WIN, NOW)
        q = urllib.parse.urlencode({"symbol": "BTCUSDT", "startTime": cur, "endTime": end, "limit": 1000})
        batch = get(f"{base}?{q}"); calls += 1
        if not batch: cur = end + 1; continue
        for b in batch:
            t = int(b["fundingTime"])
            if t in seen: continue
            seen.add(t); out.append({"symbol": "BTCUSDT", "time": t, "rate": float(b["fundingRate"])})
        last = max(int(b["fundingTime"]) for b in batch)
        cur = last + 1 if last + 1 > cur else end + 1
        time.sleep(0.2)
    out.sort(key=lambda x: x["time"])
    p = os.path.join(OUT_DIR, "binance-funding-7y.json"); json.dump(out, open(p, "w"))
    s = datetime.datetime.utcfromtimestamp(out[0]["time"]/1000); e = datetime.datetime.utcfromtimestamp(out[-1]["time"]/1000)
    print(f"  -> {len(out)} funding recs  {s:%Y-%m-%d} .. {e:%Y-%m-%d}  ({calls} calls)")

print("Fetching 1h klines 7y..."); fetch_klines()
print("Fetching funding 7y...");   fetch_funding()
print("DONE")
