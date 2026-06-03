#!/usr/bin/env python3
"""CHECK lại: phương pháp general có 'mua đỉnh bán đáy' không? + zoom rõ 1 giai đoạn.
   Đo: entry nằm đâu trong range gần đây (LONG cao=mua đỉnh), %adverse-first, win% per side.
"""
import json, datetime
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt, matplotlib.dates as mdates
CACHE = "/Users/lap16116/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json"
raw = json.load(open(CACHE)); raw.sort(key=lambda x: x["time"]); b = {}
for c in raw:
    k = c["time"] // (4 * 3600_000)
    if k not in b: b[k] = {"t": k * 4 * 3600_000, "h": c["high"], "l": c["low"], "c": c["close"]}
    else:
        o = b[k]; o["h"] = max(o["h"], c["high"]); o["l"] = min(o["l"], c["low"]); o["c"] = c["close"]
H = [b[k] for k in sorted(b)]; HT = [x["t"] for x in H]
trades = json.load(open("/tmp/general_trades.json"))
import bisect
def idx_at(ms): return min(bisect.bisect_right(HT, ms) - 1, len(H) - 1)

# === Đo entry-position trong range 20 bar (4h) gần nhất ===
posL, posS, winL, winS, advL, advS = [], [], 0, 0, 0, 0
nL = nS = 0
for tr in trades:
    i = idx_at(tr["ets"])
    if i < 20: continue
    rng = H[i - 20:i]; lo = min(x["l"] for x in rng); hi = max(x["h"] for x in rng)
    pos = (tr["epx"] - lo) / (hi - lo) if hi > lo else 0.5   # 0=đáy range, 1=đỉnh range
    win = tr["ret"] > 0
    if tr["side"] == "LONG":
        nL += 1; posL.append(pos); winL += win
        # adverse-first: 12h sau entry giá có ngược không
        j = idx_at(tr["ets"]) + 3
        if j < len(H) and H[j]["l"] < tr["epx"]: advL += 1
    else:
        nS += 1; posS.append(pos); winS += win
        j = idx_at(tr["ets"]) + 3
        if j < len(H) and H[j]["h"] > tr["epx"]: advS += 1
am = lambda a: sum(a) / len(a) if a else 0
print("=== ENTRY-QUALITY CHECK ===")
print(f"  LONG  n={nL}: entry-pos TB {am(posL):.2f} (0=đáy,1=ĐỈNH range20)  | win {winL/nL*100:.0f}%  | đi-ngược-12h sau vào {advL/nL*100:.0f}%")
print(f"  SHORT n={nS}: entry-pos TB {am(posS):.2f} (0=ĐÁY,1=đỉnh range20)  | win {winS/nS*100:.0f}%  | đi-ngược-12h sau vào {advS/nS*100:.0f}%")
print(f"  → LONG pos>0.6 = mua vùng CAO; SHORT pos<0.4 = bán vùng THẤP. Trend-follow ĐÚNG ra phải vậy (mua breakout=cao). Vấn đề là CÓ TIẾP DIỄN không (win%).")

# === ZOOM 1 giai đoạn rõ ===
S, E = "2024-02-20", "2024-04-05"
sd = datetime.datetime.strptime(S, "%Y-%m-%d"); ed = datetime.datetime.strptime(E, "%Y-%m-%d")
T = [datetime.datetime.utcfromtimestamp(x["t"] / 1000) for x in H]; P = [x["c"] for x in H]
idx = [i for i in range(len(T)) if sd <= T[i] <= ed]
fig, ax = plt.subplots(figsize=(16, 7))
ax.plot([T[i] for i in idx], [P[i] for i in idx], color="#475569", lw=1.3, zorder=1)
for tr in trades:
    et = datetime.datetime.utcfromtimestamp(tr["ets"] / 1000); xt = datetime.datetime.utcfromtimestamp(tr["xts"] / 1000)
    if not (sd <= et <= ed): continue
    win = tr["ret"] > 0; lc = "#16a34a" if win else "#dc2626"
    ax.plot([et, xt], [tr["epx"], tr["xpx"]], color=lc, lw=1.4, alpha=0.6, zorder=2)
    mk = "^" if tr["side"] == "LONG" else "v"; mc = "#16a34a" if tr["side"] == "LONG" else "#ea580c"
    ax.scatter(et, tr["epx"], marker=mk, s=130, color=mc, edgecolors="k", linewidths=0.7, zorder=4)
    ax.scatter(xt, tr["xpx"], marker="o", s=55, color=lc, edgecolors="k", linewidths=0.5, zorder=3)
    ax.annotate(("L" if tr["side"] == "LONG" else "S"), (et, tr["epx"]), fontsize=7, ha="center", va="center", color="white", zorder=5)
ax.set_title(f"ZOOM {S} → {E} — ▲L=vào LONG ▼S=vào SHORT · ●=đóng (xanh lãi/đỏ lỗ) · đường=trade", fontsize=12)
ax.set_ylabel("BTC $"); ax.grid(alpha=0.3); ax.xaxis.set_major_formatter(mdates.DateFormatter("%b-%d"))
OUT = "/Users/lap16116/BTC_PC/btc-dashboard/assets/general_zoom_check.png"
fig.tight_layout(); fig.savefig(OUT, dpi=120)
print(f"\nSAVED zoom -> {OUT}")
