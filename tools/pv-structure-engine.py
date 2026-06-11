#!/usr/bin/env python3
"""
pv-structure-engine.py — Price-Action + Volume ONLY analysis (NO RSI/EMA/MACD/Bollinger…).

Mọi thứ tính từ OHLCV thuần. "Trung bình" duy nhất dùng là để CHUẨN HOÁ range & volume
(avg range, avg volume) — không phải indicator dự báo.

Output:
  pv-annotated.json  — { tf, bars:[{t,o,h,l,c,v, pivot, struct, vol}], levels:[...], events:[...] }
Dùng cho doc price-volume-framework.md + chart HTML pv-chart.

Khái niệm:
  - Swing pivot (fractal L=2): high[i] là pivot-high nếu cao hơn L nến mỗi bên; pivot-low đối xứng.
  - Market structure: chuỗi pivot xen kẽ → HH/HL/LH/LL. Trend = HH+HL (up) / LH+LL (down) / else range.
  - BOS (break of structure): close vượt swing-high gần nhất (bull) / swing-low (bear).
  - CHoCH (change of character): BOS đầu tiên NGƯỢC hướng structure đang chạy.
  - S/R: cụm pivot trong tolerance% → level + số lần chạm (strength).
  - Volume: spike (>1.8× avg), climax (>2.5× avg + range lớn), dry-up (<0.6× avg); BOS có volume xác nhận.
  - Candle: body/wick, rejection (wick>2×body), inside/outside bar, large-range (>1.8× avg range).
"""
import json, datetime, os, sys

CACHE = os.path.join(os.path.dirname(__file__), "..", ".cache", "binance-1h-7y.json")
TF_MS = {"1h": 3600_000, "4h": 4*3600_000, "1d": 86400_000}

# ── params (price/volume only) ──
PIVOT_L      = 2       # fractal half-width
VOL_LB       = 20      # volume average lookback
RANGE_LB     = 20      # range average lookback
SPIKE_MULT   = 1.8
CLIMAX_MULT  = 2.5
DRYUP_MULT   = 0.6
LARGE_RANGE  = 1.8
WICK_REJECT  = 2.0     # wick > 2× body = rejection
SR_TOL_PCT   = 0.6     # cụm pivot trong 0.6% = cùng level

def load_agg(tf, last_n):
    raw = json.load(open(CACHE)); raw.sort(key=lambda x: x["time"])
    ms = TF_MS[tf]; b = {}
    for c in raw:
        k = c["time"] // ms
        if k not in b:
            b[k] = {"t": k*ms, "o": c["open"], "h": c["high"], "l": c["low"], "c": c["close"], "v": c["volume"]}
        else:
            o = b[k]; o["h"] = max(o["h"], c["high"]); o["l"] = min(o["l"], c["low"]); o["c"] = c["close"]; o["v"] += c["volume"]
    bars = [b[k] for k in sorted(b)]
    return bars[-last_n:] if last_n else bars

def sma(vals, i, lb):
    lo = max(0, i-lb+1); s = vals[lo:i+1]
    return sum(s)/len(s) if s else 0.0

def compute(bars):
    n = len(bars)
    vols = [x["v"] for x in bars]
    ranges = [x["h"]-x["l"] for x in bars]
    # ── pivots (fractal) ──
    for i, x in enumerate(bars):
        x["pivot"] = None
        if PIVOT_L <= i < n-PIVOT_L:
            win = range(i-PIVOT_L, i+PIVOT_L+1)
            if all(bars[i]["h"] >= bars[j]["h"] for j in win) and any(bars[i]["h"] > bars[j]["h"] for j in win if j != i):
                x["pivot"] = "H"
            elif all(bars[i]["l"] <= bars[j]["l"] for j in win) and any(bars[i]["l"] < bars[j]["l"] for j in win if j != i):
                x["pivot"] = "L"
    # ── structure: label HH/HL/LH/LL trên chuỗi pivot xen kẽ ──
    piv = [(i, bars[i]["pivot"], bars[i]["h"] if bars[i]["pivot"]=="H" else bars[i]["l"]) for i in range(n) if bars[i]["pivot"]]
    lastH = lastL = None
    for (i, typ, val) in piv:
        lab = None
        if typ == "H":
            lab = "HH" if (lastH is not None and val > lastH) else ("LH" if lastH is not None else "H")
            lastH = val
        else:
            lab = "HL" if (lastL is not None and val > lastL) else ("LL" if lastL is not None else "L")
            lastL = val
        bars[i]["struct"] = lab
    # ── trend state + BOS/CHoCH (close vượt swing gần nhất) ──
    events = []; trend = "RANGE"
    recentSwingH = recentSwingL = None
    for i in range(n):
        # cập nhật swing gần nhất khi xác nhận pivot (trễ PIVOT_L nến)
        j = i - PIVOT_L
        if j >= 0 and bars[j].get("pivot") == "H": recentSwingH = bars[j]["h"]
        if j >= 0 and bars[j].get("pivot") == "L": recentSwingL = bars[j]["l"]
        c = bars[i]["c"]
        if recentSwingH and c > recentSwingH:
            ev = "CHoCH↑" if trend == "DOWN" else "BOS↑"
            if trend != "UP": events.append({"i": i, "t": bars[i]["t"], "type": ev, "px": recentSwingH})
            trend = "UP"; recentSwingH = None
        elif recentSwingL and c < recentSwingL:
            ev = "CHoCH↓" if trend == "UP" else "BOS↓"
            if trend != "DOWN": events.append({"i": i, "t": bars[i]["t"], "type": ev, "px": recentSwingL})
            trend = "DOWN"; recentSwingL = None
        bars[i]["trend"] = trend
    # ── volume + candle flags ──
    for i, x in enumerate(bars):
        va = sma(vols, i, VOL_LB); ra = sma(ranges, i, RANGE_LB)
        rng = x["h"]-x["l"] or 1e-9; body = abs(x["c"]-x["o"])
        upW = x["h"]-max(x["c"],x["o"]); dnW = min(x["c"],x["o"])-x["l"]
        x["vol"] = {
            "avg": round(va,1),
            "spike": x["v"] >= va*SPIKE_MULT,
            "climax": x["v"] >= va*CLIMAX_MULT and rng >= ra*LARGE_RANGE,
            "dryup": x["v"] <= va*DRYUP_MULT,
        }
        x["cdl"] = {
            "largeRange": rng >= ra*LARGE_RANGE,
            "rejUp": upW > body*WICK_REJECT and body > 0,
            "rejDn": dnW > body*WICK_REJECT and body > 0,
            "inside": i > 0 and x["h"] <= bars[i-1]["h"] and x["l"] >= bars[i-1]["l"],
            "outside": i > 0 and x["h"] > bars[i-1]["h"] and x["l"] < bars[i-1]["l"],
        }
    # BOS volume confirm
    for ev in events:
        ev["volConfirm"] = bars[ev["i"]]["vol"]["spike"] or bars[ev["i"]]["v"] > bars[ev["i"]]["vol"]["avg"]
    # ── S/R: cụm pivot ──
    levels = []
    for (i, typ, val) in piv:
        placed = False
        for L in levels:
            if abs(val - L["px"]) / L["px"] * 100 <= SR_TOL_PCT:
                L["px"] = (L["px"]*L["touches"] + val) / (L["touches"]+1); L["touches"] += 1; placed = True; break
        if not placed:
            levels.append({"px": val, "touches": 1, "kind": typ})
    levels = [L for L in levels if L["touches"] >= 2]
    for L in levels: L["px"] = round(L["px"], 1)
    return bars, events, sorted(levels, key=lambda L: -L["touches"])

if __name__ == "__main__":
    tf = sys.argv[1] if len(sys.argv) > 1 else "4h"
    last_n = int(sys.argv[2]) if len(sys.argv) > 2 else 180
    bars = load_agg(tf, last_n)
    bars, events, levels = compute(bars)
    out = {"tf": tf, "n": len(bars), "bars": bars, "events": events, "levels": levels}
    p = os.path.join(os.path.dirname(__file__), "pv-annotated.json")
    json.dump(out, open(p, "w"))
    d0 = datetime.datetime.utcfromtimestamp(bars[0]["t"]/1000); d1 = datetime.datetime.utcfromtimestamp(bars[-1]["t"]/1000)
    print(f"{tf} {len(bars)} bars {d0:%Y-%m-%d}..{d1:%Y-%m-%d} -> {p}")
    print(f"trend cuối: {bars[-1]['trend']}  | events: {len(events)}  | S/R levels(≥2 touch): {len(levels)}")
    print("Structure events gần nhất:")
    for ev in events[-6:]:
        dt = datetime.datetime.utcfromtimestamp(ev["t"]/1000)
        print(f"  {dt:%Y-%m-%d %H:%M}  {ev['type']:7} @ {ev['px']:.0f}  vol-confirm={ev['volConfirm']}")
    print("Top S/R:")
    for L in levels[:6]:
        print(f"  {L['px']:.0f}  ({L['kind']}, {L['touches']} touches)")
