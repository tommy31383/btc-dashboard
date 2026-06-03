#!/usr/bin/env python3
"""In bảng lưới năm×tháng (return-%) cho hedge01 + hedge05(forced-daily+flip) + hedge05(turtle).
   Đọc 3 dòng JSON từ /tmp/m.txt (FD_MONTHLY / H01_MONTHLY / TUR_MONTHLY).
"""
import json
d = {}
for line in open("/tmp/m.txt"):
    line = line.strip()
    if not line: continue
    k, j = line.split(" ", 1)
    d[k] = json.loads(j)

def grid(name, mo):
    print(f"\n=== {name}  (return-%, . = không lệnh) ===")
    hdr = "year |" + "".join(f"{('M'+str(m)):>6}" for m in range(1, 13)) + " |   TOTAL"
    print(hdr)
    gtot = 0.0
    for y in range(2019, 2027):
        cells = []; tot = 0.0
        for m in range(1, 13):
            key = f"{y}-{m:02d}"
            if key in mo:
                v = mo[key] * 100; tot += v; cells.append(f"{v:>+6.0f}")
            else:
                cells.append(f"{'.':>6}")
        gtot += tot
        print(f"{y} |" + "".join(cells) + f" | {tot:>+8.0f}")
    print(f"7y TOTAL return-%: {gtot:+.0f}")

grid("hedge01 (LIVE: RANGE-breakout 4h LONG)", d["H01_MONTHLY"])
grid("hedge05 forced-daily + FLIP (champion cut2.2 — 'moi ngay 1 entry')", d["FD_MONTHLY"])
grid("hedge05 turtle (daily Donchian 20/10 + cut2)", d["TUR_MONTHLY"])
print("\nGhi chu: return-% = tong return moi lenh dong trong thang (R-multiple tren notional), KHONG phai %von. Ca 3 cung don vi -> so truc tiep.")
