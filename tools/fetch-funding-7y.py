#!/usr/bin/env python3
"""
fetch-funding-7y.py — Fetch FULL BTCUSDT perp funding-rate history from Binance.

Binance fapi fundingRate endpoint serves history back to contract inception
(~2019-09-08 for BTCUSDT perp). The existing binance-funding-3y.json is just a
partial fetch (2023-05 onward). This paginates from 2019-09-01 to now, 1000
records/call (~333 days at 8h intervals), sleeping 0.3s between calls.

Output: .cache/binance-funding-7y.json  [{symbol,time,rate,mark}, ...]
  (time = fundingTime ms, rate = float fundingRate)
Report: total records, span, count of funding>0.05% extremes per year.
"""
import json, time, datetime, urllib.request, urllib.error, ssl
from collections import defaultdict

SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE

OUT = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-funding-7y.json"
SYMBOL = "BTCUSDT"
URL = "https://fapi.binance.com/fapi/v1/fundingRate"
START_MS = int(datetime.datetime(2019, 9, 1, tzinfo=datetime.timezone.utc).timestamp() * 1000)
NOW_MS = int(time.time() * 1000)
LIMIT = 1000


def fetch(start_ms, end_ms):
    q = f"?symbol={SYMBOL}&startTime={start_ms}&endTime={end_ms}&limit={LIMIT}"
    req = urllib.request.Request(URL + q, headers={"User-Agent": "Mozilla/5.0"})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=30, context=SSL_CTX) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            print(f"  HTTP {e.code} attempt {attempt+1}; sleep 2s")
            time.sleep(2)
        except Exception as e:
            print(f"  err {e} attempt {attempt+1}; sleep 2s")
            time.sleep(2)
    raise RuntimeError("fetch failed after retries")


def main():
    all_recs = []
    seen = set()
    cur = START_MS
    # 8h interval -> 1000 recs ~= 333 days. Window 320 days to be safe.
    WIN = 320 * 24 * 3600 * 1000
    calls = 0
    while cur < NOW_MS:
        end = min(cur + WIN, NOW_MS)
        batch = fetch(cur, end)
        calls += 1
        if not batch:
            cur = end + 1
            continue
        for b in batch:
            t = int(b["fundingTime"])
            if t in seen:
                continue
            seen.add(t)
            all_recs.append({
                "symbol": b.get("symbol", SYMBOL),
                "time": t,
                "rate": float(b["fundingRate"]),
                "mark": float(b["markPrice"]) if b.get("markPrice") not in (None, "", "0") else None,
            })
        last_t = max(int(b["fundingTime"]) for b in batch)
        # advance just past last record
        nxt = last_t + 1
        if nxt <= cur:
            nxt = end + 1
        cur = nxt
        if calls % 5 == 0:
            print(f"  ...{calls} calls, {len(all_recs)} recs, at {datetime.datetime.utcfromtimestamp(last_t/1000):%Y-%m-%d}")
        time.sleep(0.3)

    all_recs.sort(key=lambda x: x["time"])
    json.dump(all_recs, open(OUT, "w"))

    n = len(all_recs)
    if n == 0:
        print("NO RECORDS")
        return
    s = datetime.datetime.utcfromtimestamp(all_recs[0]["time"] / 1000)
    e = datetime.datetime.utcfromtimestamp(all_recs[-1]["time"] / 1000)
    print(f"\nSaved {n} records to {OUT}")
    print(f"Span: {s:%Y-%m-%d} -> {e:%Y-%m-%d}  ({calls} API calls)")

    # extremes per year: funding > 0.05% (0.0005)
    by_yr = defaultdict(lambda: {"n": 0, "hot": 0, "max": -9, "min": 9})
    for r in all_recs:
        y = datetime.datetime.utcfromtimestamp(r["time"] / 1000).year
        d = by_yr[y]
        d["n"] += 1
        if r["rate"] > 0.0005:
            d["hot"] += 1
        d["max"] = max(d["max"], r["rate"])
        d["min"] = min(d["min"], r["rate"])
    print(f"\n{'year':>6} {'recs':>6} {'>0.05%':>7} {'%hot':>6} {'maxRate':>9} {'minRate':>9}")
    for y in sorted(by_yr):
        d = by_yr[y]
        print(f"{y:>6} {d['n']:>6} {d['hot']:>7} {d['hot']/d['n']*100:>5.1f}% {d['max']*100:>8.3f}% {d['min']*100:>8.3f}%")


if __name__ == "__main__":
    main()
