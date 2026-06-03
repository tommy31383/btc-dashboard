#!/usr/bin/env python3
"""Loop cycle 17 (fetch): thêm 4 alt liquid (LINK/ADA/DOT/LTC) 5m-3y từ Binance fapi
→ .cache/binance-<coin>-5m-3y.json (khớp naming alt cũ). Mở rộng universe test hedge01 generality.
Chạy background. Paginated 1500/req, resilient retry.
"""
import json, urllib.request, time, datetime, os, ssl
SSL=ssl.create_default_context(); SSL.check_hostname=False; SSL.verify_mode=ssl.CERT_NONE
CACHE="/Users/lap16116/BTC_PC/btc-dashboard/.cache"
COINS=[("LINK","LINKUSDT"),("ADA","ADAUSDT"),("DOT","DOTUSDT"),("LTC","LTCUSDT")]
INTERVAL="5m"; LIMIT=1500
START=int(datetime.datetime(2023,5,1).timestamp()*1000)
END=int(time.time()*1000)

def fetch(symbol):
    bars=[]; cur=START
    while cur<END:
        url=(f"https://fapi.binance.com/fapi/v1/klines?symbol={symbol}&interval={INTERVAL}"
             f"&startTime={cur}&endTime={END}&limit={LIMIT}")
        for attempt in range(5):
            try:
                with urllib.request.urlopen(url,timeout=20,context=SSL) as r:
                    data=json.loads(r.read()); break
            except Exception as e:
                print(f"    {symbol} retry {attempt}: {e}",flush=True); time.sleep(2)
        else:
            print(f"    {symbol} FAIL at {cur}",flush=True); break
        if not data: break
        for k in data:
            bars.append({"time":k[0],"open":float(k[1]),"high":float(k[2]),"low":float(k[3]),
                         "close":float(k[4]),"volume":float(k[5])})
        cur=data[-1][0]+1
        if len(data)<LIMIT: break
    return bars

for name,sym in COINS:
    out=f"{CACHE}/binance-{name.lower()}-5m-3y.json"
    if os.path.exists(out):
        print(f"  {name} exists, skip",flush=True); continue
    t0=time.time(); b=fetch(sym)
    json.dump(b,open(out,"w"))
    print(f"  {name}: {len(b)} bars → {out} ({time.time()-t0:.0f}s)",flush=True)
print("DONE_FETCH_EXTRA_ALTS",flush=True)
